// SSRF guard for everything the link reader fetches.
//
// The bot runs on a VPS next to other containers (a code sandbox, databases, …) and the URLs it opens
// come from chat messages and from the model's own tool calls — i.e. from anyone who can post in the
// server, or anything that can prompt-inject the model. So every URL, and every redirect hop, has to
// prove it points at the public internet before a single byte is sent:
//
//   - http/https only, no userinfo, only the ports public sites actually use (80/443/8080/8443)
//   - names that can only resolve on a private network (single-label names like `sandbox`, `localhost`,
//     `*.internal`, `*.local`, …) are refused before DNS is even asked
//   - the name is resolved and EVERY address must be public; one private answer refuses the host
//     (a public+private answer is a classic rebinding setup)
//   - the connection is then pinned to exactly the addresses that were checked (see safeFetch.ts), so a
//     second, different DNS answer at connect time can't slip through
//
// Address checks are pure functions over parsed bytes, so every range is unit-tested without DNS.
import * as dns from 'node:dns';
import * as net from 'node:net';

export type ResolvedAddress = { address: string; family: 4 | 6 };

/** Resolves a hostname to every address it has (A and AAAA). Injected in tests. */
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

export const systemResolver: Resolver = async (hostname) => {
  const results = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  return results.map((r) => ({ address: r.address, family: r.family === 6 ? 6 : 4 }));
};

/** Why a URL was refused; the message is safe to show the model (it names the rule, not internals). */
export class BlockedUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlockedUrlError';
  }
}

// Ports public websites actually serve on. Anything else (6379, 5432, 2375, 8000, …) is far more likely
// to be an internal service than a page someone shared.
const ALLOWED_PORTS = new Set(['', '80', '443', '8080', '8443']);

// Suffixes that only ever resolve inside a private network (RFC 6761/6762/8375 and common conventions).
const PRIVATE_NAME_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home.arpa', '.localdomain', '.intranet'];

// ---- Address parsing ----

function parseIPv4(text: string): number[] | undefined {
  if (!net.isIPv4(text)) return undefined;
  const octets = text.split('.').map((part) => Number(part));
  return octets.length === 4 && octets.every((o) => Number.isInteger(o) && o >= 0 && o <= 255) ? octets : undefined;
}

/** 16 bytes for a textual IPv6 address (handles `::`, embedded dotted quads and zone ids). */
function parseIPv6(input: string): number[] | undefined {
  let text = input;
  const zone = text.indexOf('%');
  if (zone >= 0) text = text.slice(0, zone);
  if (!net.isIPv6(text)) return undefined;

  let embeddedV4: number[] | undefined;
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    embeddedV4 = parseIPv4(tail);
    if (!embeddedV4) return undefined;
    text = `${text.slice(0, lastColon + 1)}0:0`;
  }

  const halves = text.split('::');
  if (halves.length > 2) return undefined;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = 8 - head.length - rest.length;
  if (halves.length === 2 ? fill < 0 : fill !== 0) return undefined;
  const groups = [...head, ...new Array<string>(halves.length === 2 ? fill : 0).fill('0'), ...rest];

  const bytes: number[] = [];
  for (const group of groups) {
    const value = Number.parseInt(group, 16);
    if (!/^[0-9a-f]{1,4}$/i.test(group) || Number.isNaN(value)) return undefined;
    bytes.push(value >> 8, value & 0xff);
  }
  if (embeddedV4) bytes.splice(12, 4, ...embeddedV4);
  return bytes.length === 16 ? bytes : undefined;
}

// ---- Classification ----

type V4Range = { base: number[]; prefix: number; reason: string };

const IPV4_BLOCKED: V4Range[] = [
  { base: [0, 0, 0, 0], prefix: 8, reason: 'unspecified' },
  { base: [10, 0, 0, 0], prefix: 8, reason: 'private' },
  { base: [100, 64, 0, 0], prefix: 10, reason: 'carrier-grade NAT' }, // also Alibaba's metadata 100.100.100.200
  { base: [127, 0, 0, 0], prefix: 8, reason: 'loopback' },
  { base: [169, 254, 0, 0], prefix: 16, reason: 'link-local' }, // AWS/GCP/Azure/DO metadata 169.254.169.254
  { base: [172, 16, 0, 0], prefix: 12, reason: 'private' }, // Docker's default bridge networks live here
  { base: [192, 0, 0, 0], prefix: 24, reason: 'IETF protocol assignments' }, // incl. Oracle metadata 192.0.0.192
  { base: [192, 0, 2, 0], prefix: 24, reason: 'documentation' },
  { base: [192, 88, 99, 0], prefix: 24, reason: '6to4 relay' },
  { base: [192, 168, 0, 0], prefix: 16, reason: 'private' },
  { base: [198, 18, 0, 0], prefix: 15, reason: 'benchmarking' },
  { base: [198, 51, 100, 0], prefix: 24, reason: 'documentation' },
  { base: [203, 0, 113, 0], prefix: 24, reason: 'documentation' },
  { base: [224, 0, 0, 0], prefix: 4, reason: 'multicast' },
  { base: [240, 0, 0, 0], prefix: 4, reason: 'reserved' }, // incl. broadcast 255.255.255.255
  // Azure's WireServer/metadata endpoint sits in otherwise-public space, so it needs its own entry.
  { base: [168, 63, 129, 16], prefix: 32, reason: 'cloud metadata' },
];

function toUint32(octets: number[]): number {
  return ((octets[0] << 24) >>> 0) + (octets[1] << 16) + (octets[2] << 8) + octets[3];
}

function inV4Range(octets: number[], range: V4Range): boolean {
  if (range.prefix === 0) return true;
  const shift = 32 - range.prefix;
  return Math.floor(toUint32(octets) / 2 ** shift) === Math.floor(toUint32(range.base) / 2 ** shift);
}

function classifyV4(octets: number[]): string | undefined {
  return IPV4_BLOCKED.find((range) => inV4Range(octets, range))?.reason;
}

function bytesStartWith(bytes: number[], prefix: number[], bits: number): boolean {
  const fullBytes = Math.floor(bits / 8);
  for (let i = 0; i < fullBytes; i++) if (bytes[i] !== prefix[i]) return false;
  const remaining = bits % 8;
  if (remaining === 0) return true;
  const mask = (0xff << (8 - remaining)) & 0xff;
  return (bytes[fullBytes] & mask) === (prefix[fullBytes] & mask);
}

function classifyV6(bytes: number[]): string | undefined {
  const zeroPrefix = (n: number) => bytes.slice(0, n).every((b) => b === 0);

  // IPv4-mapped (::ffff:a.b.c.d) — the kernel connects these over IPv4, so judge the embedded address.
  if (zeroPrefix(10) && bytes[10] === 0xff && bytes[11] === 0xff) {
    const reason = classifyV4(bytes.slice(12));
    return reason ? `IPv4-mapped ${reason}` : undefined;
  }
  if (zeroPrefix(15) && bytes[15] === 0) return 'unspecified';
  if (zeroPrefix(15) && bytes[15] === 1) return 'loopback';
  // Deprecated IPv4-compatible (::a.b.c.d) and IPv4-translated (::ffff:0:a.b.c.d) forms: nothing public uses them.
  if (zeroPrefix(12)) return 'IPv4-compatible';
  if (zeroPrefix(8) && bytes[8] === 0xff && bytes[9] === 0xff && bytes[10] === 0 && bytes[11] === 0) {
    return 'IPv4-translated';
  }
  // NAT64 well-known prefix (64:ff9b::/96): reaches whatever IPv4 address is embedded.
  if (bytesStartWith(bytes, [0x00, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0], 96)) {
    const reason = classifyV4(bytes.slice(12));
    return reason ? `NAT64 ${reason}` : undefined;
  }

  // Everything public is in global unicast 2000::/3; that alone rules out ::/8 leftovers, 64:ff9b:1::/48
  // (local NAT64), 100::/64 (discard), 5f00::/16 (SRv6), fc00::/7 (unique local), fe80::/10 (link-local,
  // incl. AWS's fd00:ec2::254 metadata), fec0::/10 (site-local) and ff00::/8 (multicast).
  if ((bytes[0] & 0xe0) !== 0x20) return 'not global unicast';
  if (bytesStartWith(bytes, [0x20, 0x01, 0x0d, 0xb8], 32)) return 'documentation';
  if (bytesStartWith(bytes, [0x20, 0x01, 0x00], 23)) return 'IETF special-purpose'; // Teredo, benchmarking, ORCHID…
  if (bytesStartWith(bytes, [0x20, 0x02], 16)) return '6to4';
  if (bytesStartWith(bytes, [0x3f, 0xff, 0x00], 20)) return 'documentation';
  return undefined;
}

/**
 * Why an IP address must not be contacted, or undefined when it is a public address. Anything that
 * doesn't parse as an IP address is refused too.
 */
export function blockedAddressReason(address: string): string | undefined {
  const text = address.startsWith('[') && address.endsWith(']') ? address.slice(1, -1) : address;
  const v4 = parseIPv4(text);
  if (v4) return classifyV4(v4);
  if (text.includes('%')) return 'scoped (zone id) address';
  const v6 = parseIPv6(text);
  if (v6) return classifyV6(v6);
  return 'not an IP address';
}

export function isPublicAddress(address: string): boolean {
  return blockedAddressReason(address) === undefined;
}

// ---- URLs ----

/** The hostname without IPv6 brackets or a trailing root dot, lowercased. */
function bareHostname(url: URL): string {
  let host = url.hostname.toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  while (host.endsWith('.')) host = host.slice(0, -1);
  return host;
}

/**
 * Parses and checks everything about a URL that doesn't need DNS: scheme, credentials, port, and
 * names/literals that can only mean a private destination. Throws BlockedUrlError.
 */
export function checkUrlShape(input: string | URL): URL {
  let url: URL;
  try {
    url = typeof input === 'string' ? new URL(input) : new URL(input.toString());
  } catch {
    throw new BlockedUrlError('not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BlockedUrlError(`unsupported scheme ${url.protocol}`);
  }
  if (url.username || url.password) throw new BlockedUrlError('URLs with credentials are not allowed');
  if (!ALLOWED_PORTS.has(url.port)) throw new BlockedUrlError(`port ${url.port} is not allowed`);

  const host = bareHostname(url);
  if (!host) throw new BlockedUrlError('missing hostname');
  // The WHATWG parser has already normalized decimal/octal/hex IPv4 forms (http://2130706433/ ⇒
  // 127.0.0.1), so a literal here is always in canonical dotted or bracketed form.
  if (net.isIP(host)) {
    const reason = blockedAddressReason(host);
    if (reason) throw new BlockedUrlError(`address ${host} is ${reason}`);
    return url;
  }
  if (host === 'localhost' || PRIVATE_NAME_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    throw new BlockedUrlError(`${host} is a private hostname`);
  }
  // Single-label names (`sandbox`, `redis`, `metadata`) resolve through Docker's embedded DNS or the
  // host's search domains — never to a public website.
  if (!host.includes('.')) throw new BlockedUrlError(`${host} is not a public hostname`);
  return url;
}

/**
 * The addresses a URL may be fetched from: every address its hostname resolves to, all of them public.
 * Throws BlockedUrlError when any address is not public, or when the name doesn't resolve.
 */
export async function resolvePublicAddresses(url: URL, resolver: Resolver): Promise<ResolvedAddress[]> {
  const host = bareHostname(url);
  if (net.isIP(host)) {
    const reason = blockedAddressReason(host);
    if (reason) throw new BlockedUrlError(`address ${host} is ${reason}`);
    return [{ address: host, family: net.isIPv6(host) ? 6 : 4 }];
  }

  let addresses: ResolvedAddress[];
  try {
    addresses = await resolver(host);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    throw new BlockedUrlError(`could not resolve ${host}${code ? ` (${code})` : ''}`);
  }
  if (addresses.length === 0) throw new BlockedUrlError(`could not resolve ${host}`);
  for (const { address } of addresses) {
    const reason = blockedAddressReason(address);
    if (reason) throw new BlockedUrlError(`${host} resolves to a ${reason} address`);
  }
  return addresses;
}

/** Shape check + DNS check in one: resolves only when the URL is safe to contact right now. */
export async function assertPublicUrl(input: string | URL, resolver: Resolver = systemResolver): Promise<URL> {
  const url = checkUrlShape(input);
  await resolvePublicAddresses(url, resolver);
  return url;
}

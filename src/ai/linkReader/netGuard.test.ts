import { describe, expect, it } from 'vitest';
import {
  BlockedUrlError,
  type Resolver,
  assertPublicUrl,
  blockedAddressReason,
  checkUrlShape,
  isPublicAddress,
  resolvePublicAddresses,
} from './netGuard';

const resolverFrom =
  (table: Record<string, string[]>): Resolver =>
  async (hostname) => {
    const addresses = table[hostname];
    if (!addresses) {
      const error: NodeJS.ErrnoException = new Error(`getaddrinfo ENOTFOUND ${hostname}`);
      error.code = 'ENOTFOUND';
      throw error;
    }
    return addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  };

describe('blockedAddressReason: IPv4', () => {
  const blocked: Array<[string, string]> = [
    ['0.0.0.0', 'unspecified'],
    ['0.1.2.3', 'unspecified'],
    ['10.0.0.1', 'private'],
    ['10.255.255.255', 'private'],
    ['100.64.0.1', 'carrier-grade NAT'],
    ['100.100.100.200', 'carrier-grade NAT'], // Alibaba Cloud metadata
    ['100.127.255.254', 'carrier-grade NAT'],
    ['127.0.0.1', 'loopback'],
    ['127.53.0.9', 'loopback'],
    ['169.254.169.254', 'link-local'], // AWS/GCP/Azure/DigitalOcean metadata
    ['169.254.0.1', 'link-local'],
    ['172.16.0.1', 'private'],
    ['172.17.0.2', 'private'], // Docker's default bridge
    ['172.31.255.255', 'private'],
    ['192.0.0.192', 'IETF protocol assignments'], // Oracle Cloud metadata
    ['192.0.2.10', 'documentation'],
    ['192.88.99.1', '6to4 relay'],
    ['192.168.1.1', 'private'],
    ['198.18.0.1', 'benchmarking'],
    ['198.19.255.255', 'benchmarking'],
    ['198.51.100.7', 'documentation'],
    ['203.0.113.9', 'documentation'],
    ['224.0.0.1', 'multicast'],
    ['239.255.255.250', 'multicast'],
    ['240.0.0.1', 'reserved'],
    ['255.255.255.255', 'reserved'],
    ['168.63.129.16', 'cloud metadata'], // Azure WireServer
  ];
  it.each(blocked)('refuses %s (%s)', (address, reason) => {
    expect(blockedAddressReason(address)).toBe(reason);
  });

  const allowed = ['1.1.1.1', '8.8.8.8', '93.184.215.14', '172.15.255.255', '172.32.0.1', '100.63.255.255', '100.128.0.1', '169.253.1.1', '168.63.129.17', '223.255.255.255'];
  it.each(allowed)('allows public %s', (address) => {
    expect(blockedAddressReason(address)).toBeUndefined();
    expect(isPublicAddress(address)).toBe(true);
  });
});

describe('blockedAddressReason: IPv6', () => {
  const blocked: Array<[string, string]> = [
    ['::', 'unspecified'],
    ['::1', 'loopback'],
    ['[::1]', 'loopback'],
    ['::ffff:127.0.0.1', 'IPv4-mapped loopback'],
    ['::ffff:7f00:1', 'IPv4-mapped loopback'],
    ['::ffff:169.254.169.254', 'IPv4-mapped link-local'],
    ['::ffff:10.1.2.3', 'IPv4-mapped private'],
    ['::127.0.0.1', 'IPv4-compatible'],
    ['::ffff:0:10.0.0.1', 'IPv4-translated'],
    ['64:ff9b::127.0.0.1', 'NAT64 loopback'],
    ['64:ff9b::a9fe:a9fe', 'NAT64 link-local'],
    ['64:ff9b:1::1', 'not global unicast'],
    ['fc00::1', 'not global unicast'],
    ['fd00:ec2::254', 'not global unicast'], // AWS IMDS over IPv6
    ['fe80::1', 'not global unicast'],
    ['fec0::1', 'not global unicast'],
    ['ff02::1', 'not global unicast'],
    ['100::1', 'not global unicast'],
    ['2001:db8::1', 'documentation'],
    ['2001::1', 'IETF special-purpose'], // Teredo
    ['2001:2::1', 'IETF special-purpose'], // benchmarking
    ['2002:7f00:1::1', '6to4'],
    ['3fff::1', 'documentation'],
  ];
  it.each(blocked)('refuses %s (%s)', (address, reason) => {
    expect(blockedAddressReason(address)).toBe(reason);
  });

  it('refuses scoped addresses (zone ids)', () => {
    expect(blockedAddressReason('fe80::1%eth0')).toBe('scoped (zone id) address');
  });

  const allowed = ['2606:4700:4700::1111', '2001:4860:4860::8888', '2a00:1450:4001:80b::200e', '::ffff:8.8.8.8', '64:ff9b::808:808'];
  it.each(allowed)('allows public %s', (address) => {
    expect(blockedAddressReason(address)).toBeUndefined();
  });

  it('refuses anything that is not an IP address', () => {
    expect(blockedAddressReason('example.com')).toBe('not an IP address');
    expect(blockedAddressReason('1.2.3')).toBe('not an IP address');
    expect(blockedAddressReason('')).toBe('not an IP address');
  });
});

describe('checkUrlShape', () => {
  const refused: Array<[string, RegExp]> = [
    ['not a url', /not a valid URL/],
    ['ftp://example.com/file', /unsupported scheme ftp:/],
    ['file:///etc/passwd', /unsupported scheme file:/],
    ['javascript:alert(1)', /unsupported scheme/],
    ['gopher://example.com:70/', /unsupported scheme/],
    ['https://user:pass@example.com/', /credentials/],
    ['https://user@example.com/', /credentials/],
    ['http://example.com:6379/', /port 6379/],
    ['http://example.com:2375/', /port 2375/],
    ['http://example.com:8000/', /port 8000/],
    ['http://localhost/', /private hostname/],
    ['http://LOCALHOST./', /private hostname/],
    ['http://api.localhost/', /private hostname/],
    ['http://printer.local/', /private hostname/],
    ['http://metadata.google.internal/computeMetadata/v1/', /private hostname/],
    ['http://nas.lan/', /private hostname/],
    ['http://router.home.arpa/', /private hostname/],
    ['http://sandbox:8080/run', /not a public hostname/],
    ['http://redis/', /not a public hostname/],
    ['http://127.0.0.1/', /loopback/],
    ['http://2130706433/', /loopback/], // decimal 127.0.0.1, normalized by the URL parser
    ['http://0x7f.1/', /loopback/],
    ['http://017700000001/', /loopback/], // octal
    ['http://[::1]/', /loopback/],
    ['http://[::ffff:127.0.0.1]/', /IPv4-mapped loopback/],
    ['http://169.254.169.254/latest/meta-data/', /link-local/],
    ['http://[fd00:ec2::254]/', /not global unicast/],
    ['http://0.0.0.0:8080/', /unspecified/],
    ['http://10.0.0.5:8443/', /private/],
  ];
  it.each(refused)('refuses %s', (url, message) => {
    expect(() => checkUrlShape(url)).toThrow(BlockedUrlError);
    expect(() => checkUrlShape(url)).toThrow(message);
  });

  const accepted = [
    'https://example.com/',
    'http://example.com/page',
    'https://example.com:443/',
    'http://example.com:80/',
    'https://example.com:8443/x',
    'http://example.com:8080/x',
    'https://sub.example.co.uk/a?b=c#d',
    'https://1.1.1.1/',
    'https://[2606:4700:4700::1111]/',
    'https://example.com./',
  ];
  it.each(accepted)('accepts %s', (url) => {
    expect(checkUrlShape(url)).toBeInstanceOf(URL);
  });
});

describe('resolvePublicAddresses / assertPublicUrl', () => {
  const resolver = resolverFrom({
    'public.example': ['93.184.215.14', '2606:2800:21f:cb07:6820:80da:af6b:8b2c'],
    'rebind.example': ['93.184.215.14', '10.0.0.5'],
    'internal.example': ['172.18.0.3'],
    'mapped.example': ['::ffff:169.254.169.254'],
    'v6.example': ['fd12:3456::1'],
    'empty.example': [],
  });

  it('returns every address when all are public', async () => {
    const addresses = await resolvePublicAddresses(new URL('https://public.example/'), resolver);
    expect(addresses.map((a) => a.address)).toEqual(['93.184.215.14', '2606:2800:21f:cb07:6820:80da:af6b:8b2c']);
  });

  it('refuses a host when ANY address is private (rebinding setups mix answers)', async () => {
    await expect(resolvePublicAddresses(new URL('https://rebind.example/'), resolver)).rejects.toThrow(/private address/);
  });

  it.each([
    ['https://internal.example/', /private address/],
    ['https://mapped.example/', /IPv4-mapped link-local/],
    ['https://v6.example/', /not global unicast/],
    ['https://empty.example/', /could not resolve/],
    ['https://nxdomain.example/', /could not resolve nxdomain.example \(ENOTFOUND\)/],
  ])('refuses %s', async (url, message) => {
    await expect(resolvePublicAddresses(new URL(url), resolver)).rejects.toThrow(message);
  });

  it('judges IP literals without asking DNS', async () => {
    const neverCalled: Resolver = async () => {
      throw new Error('should not resolve');
    };
    await expect(resolvePublicAddresses(new URL('https://1.1.1.1/'), neverCalled)).resolves.toEqual([
      { address: '1.1.1.1', family: 4 },
    ]);
    await expect(resolvePublicAddresses(new URL('http://[::1]/'), neverCalled)).rejects.toThrow(BlockedUrlError);
  });

  it('assertPublicUrl combines the shape and DNS checks', async () => {
    await expect(assertPublicUrl('https://public.example/a', resolver)).resolves.toBeInstanceOf(URL);
    await expect(assertPublicUrl('https://internal.example/a', resolver)).rejects.toThrow(BlockedUrlError);
    await expect(assertPublicUrl('http://sandbox:8080/', resolver)).rejects.toThrow(/not a public hostname/);
  });
});

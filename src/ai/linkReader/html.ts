// Just enough HTML understanding to read a shared page, without a parser dependency: metadata
// (OpenGraph/Twitter/standard meta, <title>, canonical, JSON-LD) and the page's readable text.
//
// Pages are hostile input up to 2 MB, so everything here is linear: tags are found with indexOf or
// simple non-nested patterns, never with backtracking-prone regexes over the whole document, and
// attribute values are read with a quote-aware scanner (Instagram captions put raw newlines and `>`
// inside content="…", which naive `<meta[^>]*>` matching gets wrong).

// ---- Entities ----

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ensp: ' ',
  emsp: ' ',
  thinsp: ' ',
  zwnj: '‌',
  zwj: '‍',
  shy: '­',
  ndash: '–',
  mdash: '—',
  minus: '−',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  sbquo: '‚',
  ldquo: '“',
  rdquo: '”',
  bdquo: '„',
  laquo: '«',
  raquo: '»',
  lsaquo: '‹',
  rsaquo: '›',
  bull: '•',
  middot: '·',
  prime: '′',
  Prime: '″',
  dagger: '†',
  Dagger: '‡',
  permil: '‰',
  copy: '©',
  reg: '®',
  trade: '™',
  deg: '°',
  plusmn: '±',
  times: '×',
  divide: '÷',
  frac12: '½',
  frac14: '¼',
  frac34: '¾',
  sup1: '¹',
  sup2: '²',
  sup3: '³',
  micro: 'µ',
  para: '¶',
  sect: '§',
  cent: '¢',
  pound: '£',
  euro: '€',
  yen: '¥',
  curren: '¤',
  iexcl: '¡',
  iquest: '¿',
  larr: '←',
  rarr: '→',
  uarr: '↑',
  darr: '↓',
  harr: '↔',
  hearts: '♥',
  star: '☆',
  check: '✓',
  Agrave: 'À',
  Aacute: 'Á',
  Acirc: 'Â',
  Atilde: 'Ã',
  Auml: 'Ä',
  Aring: 'Å',
  AElig: 'Æ',
  Ccedil: 'Ç',
  Egrave: 'È',
  Eacute: 'É',
  Ecirc: 'Ê',
  Euml: 'Ë',
  Igrave: 'Ì',
  Iacute: 'Í',
  Icirc: 'Î',
  Iuml: 'Ï',
  Ntilde: 'Ñ',
  Ograve: 'Ò',
  Oacute: 'Ó',
  Ocirc: 'Ô',
  Otilde: 'Õ',
  Ouml: 'Ö',
  Oslash: 'Ø',
  Ugrave: 'Ù',
  Uacute: 'Ú',
  Ucirc: 'Û',
  Uuml: 'Ü',
  Yacute: 'Ý',
  szlig: 'ß',
  agrave: 'à',
  aacute: 'á',
  acirc: 'â',
  atilde: 'ã',
  auml: 'ä',
  aring: 'å',
  aelig: 'æ',
  ccedil: 'ç',
  egrave: 'è',
  eacute: 'é',
  ecirc: 'ê',
  euml: 'ë',
  igrave: 'ì',
  iacute: 'í',
  icirc: 'î',
  iuml: 'ï',
  ntilde: 'ñ',
  ograve: 'ò',
  oacute: 'ó',
  ocirc: 'ô',
  otilde: 'õ',
  ouml: 'ö',
  oslash: 'ø',
  ugrave: 'ù',
  uacute: 'ú',
  ucirc: 'û',
  uuml: 'ü',
  yacute: 'ý',
  yuml: 'ÿ',
  OElig: 'Œ',
  oelig: 'œ',
  Scaron: 'Š',
  scaron: 'š',
  Yuml: 'Ÿ',
};

function codePointToString(codePoint: number): string {
  if (!Number.isInteger(codePoint) || codePoint <= 0 || codePoint > 0x10ffff) return '�';
  if (codePoint >= 0xd800 && codePoint <= 0xdfff) return '�';
  return String.fromCodePoint(codePoint);
}

/** Decodes numeric and common named character references; unknown names are left as written. */
export function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(/&(#[xX][0-9a-fA-F]{1,6}|#\d{1,7}|[a-zA-Z][a-zA-Z0-9]{1,31});?/g, (match, body: string) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      return codePointToString(Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10));
    }
    const named = NAMED_ENTITIES[body];
    return named ?? match;
  });
}

// ---- Tags and attributes ----

export type Tag = { name: string; attrs: Record<string, string>; start: number; end: number };

const WHITESPACE = new Set([' ', '\n', '\r', '\t', '\f']);

/** Parses the attributes of a tag whose name ends at `pos`; `end` is just past the closing `>`. */
function parseAttributesAt(html: string, pos: number): { attrs: Record<string, string>; end: number } {
  const attrs: Record<string, string> = {};
  const n = html.length;
  let i = pos;
  while (i < n) {
    const before = i;
    while (i < n && (WHITESPACE.has(html[i]) || html[i] === '/')) i++;
    if (i >= n) break;
    if (html[i] === '>') return { attrs, end: i + 1 };

    const nameStart = i;
    while (i < n && !WHITESPACE.has(html[i]) && html[i] !== '=' && html[i] !== '>' && html[i] !== '/') i++;
    const name = html.slice(nameStart, i).toLowerCase();
    while (i < n && WHITESPACE.has(html[i])) i++;

    let value = '';
    if (html[i] === '=') {
      i++;
      while (i < n && WHITESPACE.has(html[i])) i++;
      const quote = html[i];
      if (quote === '"' || quote === "'") {
        const close = html.indexOf(quote, i + 1);
        const stop = close === -1 ? n : close;
        value = html.slice(i + 1, stop);
        i = stop + 1;
      } else {
        const valueStart = i;
        while (i < n && !WHITESPACE.has(html[i]) && html[i] !== '>') i++;
        value = html.slice(valueStart, i);
      }
    }
    if (name && !(name in attrs)) attrs[name] = decodeEntities(value);
    if (i === before) i++; // never stall on a stray character
  }
  return { attrs, end: n };
}

/** Every opening tag with one of these names, in document order. */
export function findTags(html: string, names: string[]): Tag[] {
  const pattern = new RegExp(`<(${names.join('|')})(?=[\\s/>])`, 'gi');
  const tags: Tag[] = [];
  for (let match = pattern.exec(html); match; match = pattern.exec(html)) {
    const { attrs, end } = parseAttributesAt(html, match.index + match[0].length);
    tags.push({ name: match[1].toLowerCase(), attrs, start: match.index, end });
    pattern.lastIndex = Math.max(end, match.index + 1);
  }
  return tags;
}

/** The raw text between an opening tag and its closing tag (no nesting: for title/script-like elements). */
function rawTextAfter(html: string, lower: string, tag: Tag): string {
  const close = lower.indexOf(`</${tag.name}`, tag.end);
  return html.slice(tag.end, close === -1 ? html.length : close);
}

// Zero-width space/non-joiner/joiner and the BOM: invisible, but they split words for the model.
const ZERO_WIDTH = /\u200B|\u200C|\u200D|\uFEFF/g;

export function collapseWhitespace(text: string): string {
  return text.replace(ZERO_WIDTH, '').replace(/\s+/g, ' ').trim();
}

// ---- Charset ----

/** The charset a document declares in its first bytes (<meta charset> or http-equiv), if any. */
export function sniffCharset(body: Buffer): string | undefined {
  const head = body.subarray(0, 4096).toString('latin1');
  const match = head.match(/<meta[^>]+charset\s*=\s*["']?\s*([a-zA-Z0-9_:.-]+)/i);
  return match?.[1]?.toLowerCase();
}

// ---- Metadata ----

export type PageVideo = { url: string; type?: string; width?: number; height?: number };

export type PageMetadata = {
  title?: string;
  documentTitle?: string;
  description?: string;
  siteName?: string;
  author?: string;
  publishedAt?: string;
  type?: string;
  canonicalUrl?: string;
  lang?: string;
  images: string[];
  videos: PageVideo[];
  /** Raw meta key → first content, lowercased keys (og:*, twitter:*, name=…). */
  meta: Record<string, string>;
};

// A page controls its title, names and URLs, and they ride into every model call that shows the link:
// a real title is a line and a real URL a few hundred characters, not the 2 MB a page can hold.
const MAX_LABEL_CHARS = 500;
const MAX_URL_CHARS = 2048;

/** A page-supplied title, name or date, cut to MAX_LABEL_CHARS. */
function label(value: string | undefined): string | undefined {
  return value !== undefined && value.length > MAX_LABEL_CHARS ? `${value.slice(0, MAX_LABEL_CHARS - 1)}…` : value;
}

function resolveUrl(value: string | undefined, baseUrl: string): string | undefined {
  if (!value || value.length > MAX_URL_CHARS) return undefined;
  try {
    const url = new URL(value.trim(), baseUrl);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function firstOf(meta: Record<string, string[]>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = meta[key]?.find((v) => v.trim().length > 0);
    if (value) return value.trim();
  }
  return undefined;
}

function positiveInt(value: string | undefined): number | undefined {
  const parsed = value ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function extractMetadata(html: string, baseUrl: string): PageMetadata {
  const lower = html.toLowerCase();
  const meta: Record<string, string[]> = {};
  const tags = findTags(html, ['meta', 'link', 'title', 'html']);

  let documentTitle: string | undefined;
  let canonical: string | undefined;
  let lang: string | undefined;
  for (const tag of tags) {
    if (tag.name === 'meta') {
      const key = (tag.attrs.property ?? tag.attrs.name ?? tag.attrs.itemprop)?.trim().toLowerCase();
      const content = tag.attrs.content;
      if (key && content !== undefined) {
        meta[key] ??= [];
        meta[key].push(content);
      }
    } else if (tag.name === 'title' && documentTitle === undefined) {
      documentTitle = label(collapseWhitespace(decodeEntities(rawTextAfter(html, lower, tag))) || undefined);
    } else if (tag.name === 'link' && !canonical && tag.attrs.rel?.toLowerCase().split(/\s+/).includes('canonical')) {
      canonical = resolveUrl(tag.attrs.href, baseUrl);
    } else if (tag.name === 'html' && !lang && tag.attrs.lang) {
      // A language tag ("en", "fr-CA"): anything longer isn't one.
      const tagValue = tag.attrs.lang.trim();
      if (tagValue.length <= 35) lang = tagValue;
    }
  }

  const images: string[] = [];
  for (const key of ['og:image', 'og:image:url', 'og:image:secure_url', 'twitter:image', 'twitter:image:src']) {
    for (const value of meta[key] ?? []) {
      const url = resolveUrl(value, baseUrl);
      if (url && !images.includes(url)) images.push(url);
    }
  }

  const videos: PageVideo[] = [];
  const videoType = firstOf(meta, ['og:video:type', 'twitter:player:stream:content_type']);
  for (const key of ['og:video:secure_url', 'og:video:url', 'og:video', 'twitter:player:stream']) {
    for (const value of meta[key] ?? []) {
      const url = resolveUrl(value, baseUrl);
      if (url && !videos.some((v) => v.url === url)) {
        videos.push({
          url,
          type: videoType,
          width: positiveInt(firstOf(meta, ['og:video:width'])),
          height: positiveInt(firstOf(meta, ['og:video:height'])),
        });
      }
    }
  }

  const flatMeta: Record<string, string> = {};
  for (const [key, values] of Object.entries(meta)) flatMeta[key] = values[0];

  return {
    title: label(firstOf(meta, ['og:title', 'twitter:title'])) ?? documentTitle,
    documentTitle,
    description: firstOf(meta, ['og:description', 'twitter:description', 'description']),
    siteName: label(firstOf(meta, ['og:site_name', 'application-name'])),
    author: label(
      firstOf(meta, ['author', 'article:author', 'parsely-author', 'sailthru.author', 'dc.creator', 'byl']),
    ),
    publishedAt: label(
      firstOf(meta, [
        'article:published_time',
        'datepublished',
        'publish-date',
        'pubdate',
        'parsely-pub-date',
        'dc.date',
        'date',
      ]),
    ),
    type: label(firstOf(meta, ['og:type'])),
    canonicalUrl: canonical ?? resolveUrl(firstOf(meta, ['og:url']), baseUrl),
    lang,
    images,
    videos,
    meta: flatMeta,
  };
}

// ---- JSON-LD ----

export type JsonLdArticle = {
  type?: string;
  headline?: string;
  description?: string;
  body?: string;
  author?: string;
  datePublished?: string;
};

const ARTICLE_TYPES = new Set([
  'article',
  'newsarticle',
  'blogposting',
  'report',
  'techarticle',
  'scholarlyarticle',
  'socialmediaposting',
  'discussionforumposting',
  'liveblogposting',
  'analysisnewsarticle',
  'opinionnewsarticle',
  'reviewnewsarticle',
  'reportagenewsarticle',
  'backgroundnewsarticle',
  'review',
  'recipe',
  'howto',
  'videoobject',
]);

export function extractJsonLd(html: string): unknown[] {
  const lower = html.toLowerCase();
  const blocks: unknown[] = [];
  // A "<script" inside an earlier script's text is text, not a tag. Skipping those also keeps this
  // linear: an unclosed script's text runs to the end of the page, and 50k of them each scanned it.
  let textEnd = 0;
  for (const tag of findTags(html, ['script'])) {
    if (tag.start < textEnd) continue;
    const close = lower.indexOf('</script', tag.end);
    textEnd = close === -1 ? html.length : close;
    if (!tag.attrs.type?.toLowerCase().includes('ld+json')) continue;
    const raw = html.slice(tag.end, textEnd).trim();
    if (!raw || raw.length > 1_000_000) continue;
    try {
      blocks.push(JSON.parse(raw));
    } catch {
      // Broken JSON-LD is common (trailing commas, unescaped newlines); the page's other signals remain.
    }
  }
  return blocks;
}

function typesOf(node: Record<string, unknown>): string[] {
  const raw = node['@type'];
  const list = Array.isArray(raw) ? raw : [raw];
  return list.filter((t): t is string => typeof t === 'string').map((t) => t.toLowerCase());
}

function nameOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (Array.isArray(value)) {
    const names = value.map(nameOf).filter((n): n is string => Boolean(n));
    return names.length > 0 ? [...new Set(names)].join(', ') : undefined;
  }
  if (value && typeof value === 'object' && 'name' in value) return nameOf((value as { name: unknown }).name);
  return undefined;
}

function stringField(node: Record<string, unknown>, key: string): string | undefined {
  const value = node[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** The most article-like JSON-LD node: one with an articleBody wins, else the first article-typed node. */
export function findJsonLdArticle(blocks: unknown[]): JsonLdArticle | undefined {
  const candidates: Record<string, unknown>[] = [];
  let visited = 0;
  const walk = (value: unknown, depth: number) => {
    if (depth > 6 || visited > 2000 || !value || typeof value !== 'object') return;
    visited++;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    const node = value as Record<string, unknown>;
    if (typesOf(node).some((t) => ARTICLE_TYPES.has(t))) candidates.push(node);
    for (const key of ['@graph', 'mainEntity', 'mainEntityOfPage', 'itemListElement']) {
      if (key in node) walk(node[key], depth + 1);
    }
  };
  for (const block of blocks) walk(block, 0);

  const best = candidates.find((c) => stringField(c, 'articleBody')) ?? candidates[0];
  if (!best) return undefined;
  const body = stringField(best, 'articleBody') ?? stringField(best, 'text');
  return {
    type: label(typesOf(best)[0]),
    headline: label(stringField(best, 'headline') ?? stringField(best, 'name')),
    description: stringField(best, 'description'),
    body: body ? decodeEntities(body) : undefined,
    author: label(nameOf(best.author) ?? nameOf(best.creator)),
    datePublished: label(stringField(best, 'datePublished') ?? stringField(best, 'uploadDate')),
  };
}

// ---- Readable text ----

// Raw-text elements: their content is never prose, and an unclosed one swallows the rest of the page.
const RAW_ELEMENTS = new Set(['script', 'style', 'noscript', 'template', 'textarea', 'title', 'xmp']);
// Page chrome: navigation, banners, sidebars, embedded widgets. (Not <form>: ASP.NET wraps whole pages in one.)
const CHROME_ELEMENTS = [
  'head',
  'nav',
  'header',
  'footer',
  'aside',
  'svg',
  'iframe',
  'object',
  'canvas',
  'button',
  'select',
  'dialog',
  'menu',
];

function stripComments(html: string): string {
  if (!html.includes('<!--')) return html;
  let out = '';
  let cursor = 0;
  for (let open = html.indexOf('<!--'); open !== -1; open = html.indexOf('<!--', cursor)) {
    out += html.slice(cursor, open);
    const close = html.indexOf('-->', open + 4);
    cursor = close === -1 ? html.length : close + 3;
  }
  return out + html.slice(cursor);
}

/** Removes whole elements (tag, content, closing tag) by name. */
function stripElements(html: string, names: string[]): string {
  const lower = html.toLowerCase();
  const opener = new RegExp(`<(${names.join('|')})(?=[\\s/>])`, 'g');
  let out = '';
  let cursor = 0;
  // Names with no closing tag left in the rest of the document: a later opener needn't look again
  // (each look scans to the end, which a page of 100k unclosed <nav> would do 100k times).
  const unclosed = new Set<string>();
  for (let match = opener.exec(lower); match; match = opener.exec(lower)) {
    out += html.slice(cursor, match.index);
    const name = match[1];
    const tagEnd = lower.indexOf('>', match.index);
    if (tagEnd === -1) {
      cursor = html.length;
      break;
    }
    if (lower[tagEnd - 1] === '/') {
      cursor = tagEnd + 1;
    } else {
      const close = unclosed.has(name) ? -1 : lower.indexOf(`</${name}`, tagEnd);
      if (close === -1) {
        unclosed.add(name);
        cursor = RAW_ELEMENTS.has(name) ? html.length : tagEnd + 1;
      } else {
        const closeEnd = lower.indexOf('>', close);
        cursor = closeEnd === -1 ? html.length : closeEnd + 1;
      }
    }
    opener.lastIndex = cursor;
  }
  return out + html.slice(cursor);
}

/** Inner HTML of every top-level element with this name (nesting-aware). */
function elementContents(html: string, name: string): string[] {
  const lower = html.toLowerCase();
  const results: string[] = [];
  const tokens = new RegExp(`<(/?)${name}(?=[\\s/>])`, 'g');
  let depth = 0;
  let contentStart = -1;
  for (let match = tokens.exec(lower); match; match = tokens.exec(lower)) {
    const closing = match[1] === '/';
    if (!closing) {
      if (depth === 0) {
        const tagEnd = lower.indexOf('>', match.index);
        if (tagEnd === -1) break;
        contentStart = tagEnd + 1;
      }
      depth++;
    } else if (depth > 0) {
      depth--;
      if (depth === 0 && contentStart !== -1) {
        results.push(html.slice(contentStart, match.index));
        contentStart = -1;
      }
    }
  }
  if (depth > 0 && contentStart !== -1) results.push(html.slice(contentStart));
  return results;
}

const BLOCK_TAGS = new Set([
  'p',
  'div',
  'br',
  'ul',
  'ol',
  'dl',
  'dd',
  'dt',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'tr',
  'table',
  'thead',
  'tbody',
  'section',
  'article',
  'main',
  'blockquote',
  'pre',
  'hr',
  'figure',
  'figcaption',
  'summary',
  'details',
  'caption',
  'address',
]);

/** What a tag becomes in the text: list items a dash, cells a space, block elements a line break. */
function tagReplacement(tag: string): string {
  const match = /^<(\/?)([a-z][a-z0-9]*)(?=[\s/>])/i.exec(tag);
  if (!match) return '';
  const closing = match[1] === '/';
  const name = match[2].toLowerCase();
  if (name === 'li') return closing ? '' : '\n- ';
  if (name === 'td' || name === 'th') return closing ? '' : ' ';
  return BLOCK_TAGS.has(name) ? '\n' : '';
}

/**
 * Every tag (a `<` up to the next `>`) replaced, in one pass. Not a regex like /<[^>]*>/g: from every
 * `<` with no `>` after it, that pattern scans to the end of the page before giving up, so a page of
 * 100k stray `<` took seconds (and 2 MB of them, most of an hour) of blocked event loop.
 */
function replaceTags(fragment: string): string {
  let out = '';
  let cursor = 0;
  for (let open = fragment.indexOf('<'); open !== -1; open = fragment.indexOf('<', cursor)) {
    const close = fragment.indexOf('>', open + 1);
    // No `>` left: no later `<` can close either, and the rest is text.
    if (close === -1) break;
    out += fragment.slice(cursor, open) + tagReplacement(fragment.slice(open, close + 1));
    cursor = close + 1;
  }
  return out + fragment.slice(cursor);
}

function htmlFragmentToText(fragment: string): string {
  const text = decodeEntities(replaceTags(fragment));
  return text
    .replace(ZERO_WIDTH, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line === '' || /[\p{L}\p{N}]/u.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * The page's readable text: scripts, styles and page chrome dropped, the longest <article> preferred
 * (then <main>, then <body>), block elements turned into line breaks, entities decoded, whitespace
 * collapsed.
 */
export function extractReadableText(html: string): string {
  const cleaned = stripElements(stripElements(stripComments(html), [...RAW_ELEMENTS]), CHROME_ELEMENTS);

  const articles = elementContents(cleaned, 'article')
    .map(htmlFragmentToText)
    .sort((a, b) => b.length - a.length);
  if (articles[0] && articles[0].length >= 200) return articles[0];

  const main = elementContents(cleaned, 'main').map(htmlFragmentToText)[0];
  if (main && main.length >= 200) return main;

  const body = elementContents(cleaned, 'body')[0];
  return htmlFragmentToText(body ?? cleaned);
}

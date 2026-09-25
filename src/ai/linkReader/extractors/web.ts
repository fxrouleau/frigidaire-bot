// Any other link: fetch it (through the SSRF-guarded fetch: ≤5 redirects, every hop re-checked, 2 MB
// cap) and make sense of whatever comes back.
//
//   - HTML: title, author, date and description from OpenGraph/meta/JSON-LD; the main text from the
//     JSON-LD articleBody when the page publishes one (news sites do, and it is clean), else the page's
//     readable text (scripts, styles and chrome dropped, <article>/<main> preferred)
//   - text/plain: the text itself
//   - images, videos and PDFs: never downloaded here — the headers are enough to say what the link is,
//     and images/videos are handed on as media (the chat model sees images; read_link sends videos to
//     video understanding)
//   - a redirect that lands on a platform with its own extractor (t.co → x.com, a link shortener →
//     YouTube) is reported back so the reader can use the right extractor instead of a JS-only shell page
import { extractJsonLd, extractMetadata, extractReadableText, findJsonLdArticle, sniffCharset } from '../html';
import { decodeText } from '../safeFetch';
import type { LinkContent, LinkKind } from '../types';
import { type ExtractorContext, ExtractError, capText, num, parseDate } from './common';

const PAGE_TYPES = ['text/html', 'application/xhtml+xml'];
const TEXT_TYPES = ['text/plain', 'text/markdown'];
// Below this, extracted "readable text" is usually a cookie banner or an app shell, not the content.
const MIN_USEFUL_TEXT = 200;

export type WebReadOutcome = { content: LinkContent } | { redirectedTo: string };

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** The last path segment, for naming a file link ("report.pdf"); undefined when there is none. */
function fileNameOf(url: string): string | undefined {
  try {
    const last = new URL(url).pathname.split('/').pop() ?? '';
    return decodeURIComponent(last) || undefined;
  } catch {
    return undefined;
  }
}

function httpFailure(status: number): Error {
  if (status === 404 || status === 410) return new ExtractError(`that page does not exist (HTTP ${status})`);
  if (status === 401 || status === 403) {
    return new ExtractError(`the site refused to show that page to a bot (HTTP ${status}: login wall or bot protection)`);
  }
  if (status === 451) return new ExtractError('that page is blocked for legal reasons (HTTP 451)');
  return new Error(`the site answered HTTP ${status}`);
}

function fileContent(url: string, mime: string, headers: Record<string, string>): LinkContent | undefined {
  const size = num(headers['content-length']);
  const name = fileNameOf(url);
  if (mime.startsWith('image/')) {
    return { url, source: 'web', kind: 'image', title: name, site: hostOf(url), media: [{ type: 'image', url }] };
  }
  if (mime.startsWith('video/')) {
    return {
      url,
      source: 'web',
      kind: 'video file',
      title: name,
      site: hostOf(url),
      media: [{ type: 'video', url, contentType: mime, sizeBytes: size }],
    };
  }
  if (mime === 'application/pdf') {
    return {
      url,
      source: 'web',
      kind: 'document',
      title: name,
      site: hostOf(url),
      media: [],
      notes: [`PDF${size ? ` (${Math.round(size / 1024)} KB)` : ''}: its text can't be read here`],
    };
  }
  return undefined;
}

/** Maps a fetched HTML page to LinkContent. Exported for tests. */
export function parseHtmlPage(html: string, url: string, truncatedBody: boolean): LinkContent {
  const meta = extractMetadata(html, url);
  const article = findJsonLdArticle(extractJsonLd(html));

  const articleBody = article?.body && article.body.length >= MIN_USEFUL_TEXT ? article.body : undefined;
  const readable = articleBody ? undefined : extractReadableText(html);
  const description = meta.description ?? article?.description;
  const mainText =
    articleBody ?? (readable && readable.length >= MIN_USEFUL_TEXT ? readable : [description, readable].filter(Boolean).join('\n\n'));
  const { text, truncated } = capText(mainText);

  const isArticle = Boolean(articleBody) || meta.type === 'article' || (article?.type ?? '').includes('article');
  const kind: LinkKind = isArticle ? 'article' : 'web page';
  const notes: string[] = [];
  if (truncatedBody) notes.push('page was too large to read in full');
  if (!text) notes.push('no readable text (the page probably needs JavaScript)');

  const images = meta.images.slice(0, 2);
  const videos = meta.videos.filter((v) => v.type?.startsWith('video/') || /\.(?:mp4|webm|mov)(?:[?#]|$)/i.test(v.url));

  return {
    url: meta.canonicalUrl ?? url,
    source: 'web',
    kind,
    title: meta.title ?? article?.headline,
    author: article?.author ?? meta.author,
    site: meta.siteName ?? hostOf(url),
    publishedAt: parseDate(article?.datePublished ?? meta.publishedAt),
    text,
    textTruncated: truncated,
    language: meta.lang,
    media: [
      ...images.map((image) => ({ type: 'image' as const, url: image })),
      ...videos.slice(0, 1).map((video) => ({ type: 'video' as const, url: video.url, contentType: video.type })),
    ],
    notes: notes.length > 0 ? notes : undefined,
  };
}

export async function readWebPage(
  url: string,
  ctx: ExtractorContext,
  isPlatformUrl: (url: string) => boolean,
): Promise<WebReadOutcome> {
  const result = await ctx.fetch(url, { accept: [...PAGE_TYPES, ...TEXT_TYPES] });
  if (isPlatformUrl(result.url)) return { redirectedTo: result.url };
  if (!result.ok) throw httpFailure(result.status);

  const mime = result.contentType;
  if (!result.body) {
    const file = fileContent(result.url, mime, result.headers);
    if (file) return { content: file };
    throw new ExtractError(`that link is a ${mime || 'binary'} file, not a page`);
  }

  const body = decodeText(result.body, result.charset ?? (TEXT_TYPES.includes(mime) ? undefined : sniffCharset(result.body)));
  if (TEXT_TYPES.includes(mime)) {
    const { text, truncated } = capText(body);
    return {
      content: {
        url: result.url,
        source: 'web',
        kind: 'document',
        title: fileNameOf(result.url),
        site: hostOf(result.url),
        text,
        textTruncated: truncated || result.truncated,
        media: [],
      },
    };
  }
  return { content: parseHtmlPage(body, result.url, result.truncated) };
}

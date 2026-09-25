import { describe, expect, it } from 'vitest';
import {
  collapseWhitespace,
  decodeEntities,
  extractJsonLd,
  extractMetadata,
  extractReadableText,
  findJsonLdArticle,
  findTags,
  sniffCharset,
} from './html';

describe('decodeEntities', () => {
  it('decodes named, decimal and hex references', () => {
    expect(decodeEntities('Tom &amp; Jerry &mdash; &#8220;hi&#x201D; &eacute;t&eacute;')).toBe('Tom & Jerry — “hi” été');
  });
  it('leaves unknown names and invalid code points safe', () => {
    expect(decodeEntities('&notanentity; &#0; &#xD800;')).toBe('&notanentity; � �');
  });
});

describe('findTags', () => {
  it('reads quoted attribute values containing > and newlines', () => {
    const html = `<meta property="og:description" content="line one
line > two">
<meta name='twitter:title' content='A "quoted" title'><meta content=bare name=x>`;
    const tags = findTags(html, ['meta']);
    expect(tags.map((t) => t.attrs)).toEqual([
      { property: 'og:description', content: 'line one\nline > two' },
      { name: 'twitter:title', content: 'A "quoted" title' },
      { content: 'bare', name: 'x' },
    ]);
  });

  it('does not match longer tag names', () => {
    expect(findTags('<metadata><meta name="a" content="b">', ['meta'])).toHaveLength(1);
  });
});

describe('extractMetadata', () => {
  const page = `<!doctype html><html lang="fr-CA"><head>
    <title> Fallback  Title </title>
    <meta property="og:title" content="OG &amp; Title">
    <meta property="og:description" content="The description">
    <meta name="description" content="plain description">
    <meta property="og:site_name" content="Example News">
    <meta property="og:type" content="article">
    <meta name="author" content="Jane Doe">
    <meta property="article:published_time" content="2026-09-01T12:00:00Z">
    <meta property="og:image" content="/img/cover.jpg">
    <meta name="twitter:image" content="https://cdn.example/cover2.jpg">
    <meta property="og:image" content="javascript:alert(1)">
    <meta property="og:video" content="https://cdn.example/clip.mp4">
    <meta property="og:video:type" content="video/mp4">
    <link rel="canonical" href="https://example.com/story">
  </head><body></body></html>`;

  it('reads OpenGraph, standard meta, title, canonical and lang', () => {
    const meta = extractMetadata(page, 'https://example.com/story?utm=1');
    expect(meta).toMatchObject({
      title: 'OG & Title',
      documentTitle: 'Fallback Title',
      description: 'The description',
      siteName: 'Example News',
      author: 'Jane Doe',
      publishedAt: '2026-09-01T12:00:00Z',
      type: 'article',
      canonicalUrl: 'https://example.com/story',
      lang: 'fr-CA',
    });
    // Relative URLs resolved; non-http(s) schemes dropped.
    expect(meta.images).toEqual(['https://example.com/img/cover.jpg', 'https://cdn.example/cover2.jpg']);
    expect(meta.videos).toEqual([{ url: 'https://cdn.example/clip.mp4', type: 'video/mp4', width: undefined, height: undefined }]);
    expect(meta.meta.description).toBe('plain description');
  });

  it('falls back to <title> when there is no og:title', () => {
    expect(extractMetadata('<title>Only &lt;title&gt;</title>', 'https://x.example/').title).toBe('Only <title>');
  });
});

describe('JSON-LD', () => {
  it('finds the article node inside @graph and prefers one with a body', () => {
    const html = `<script type="application/ld+json">{"@context":"https://schema.org","@graph":[
      {"@type":"WebSite","name":"Site"},
      {"@type":["NewsArticle"],"headline":"Big News","author":[{"@type":"Person","name":"A. Writer"},{"name":"B. Writer"}],
       "datePublished":"2026-09-02T08:00:00-04:00","articleBody":"Body with &amp; entity.","description":"desc"}]}</script>
      <script type="application/ld+json">{ broken json </script>`;
    const blocks = extractJsonLd(html);
    expect(blocks).toHaveLength(1);
    expect(findJsonLdArticle(blocks)).toEqual({
      type: 'newsarticle',
      headline: 'Big News',
      description: 'desc',
      body: 'Body with & entity.',
      author: 'A. Writer, B. Writer',
      datePublished: '2026-09-02T08:00:00-04:00',
    });
  });

  it('returns undefined without an article-like node', () => {
    expect(findJsonLdArticle([{ '@type': 'Organization', name: 'X' }])).toBeUndefined();
  });
});

describe('extractReadableText', () => {
  it('drops scripts, styles and chrome, and prefers the article', () => {
    const paragraph = 'This is the actual story text that someone wanted to share with the group. '.repeat(4);
    const html = `<html><head><style>.a{}</style></head><body>
      <nav>Home | News | Sports</nav>
      <header>Site banner</header>
      <script>var tracking = "do not read";</script>
      <!-- a comment -->
      <article><h1>Headline</h1><p>${paragraph}</p><ul><li>point one</li><li>point two</li></ul>
        <aside>Related: other stories</aside></article>
      <footer>Copyright</footer></body></html>`;
    const text = extractReadableText(html);
    expect(text).toContain('Headline');
    expect(text).toContain('actual story text');
    expect(text).toContain('- point one');
    for (const junk of ['Home | News', 'Site banner', 'tracking', 'a comment', 'Related:', 'Copyright']) {
      expect(text).not.toContain(junk);
    }
  });

  it('falls back to the body when there is no article or main', () => {
    expect(extractReadableText('<body><div>Short page</div><p>second line</p></body>')).toBe('Short page\n\nsecond line');
  });

  it('survives an unclosed script without swallowing everything before it', () => {
    expect(extractReadableText('<body><p>visible</p><script>never closed')).toBe('visible');
  });
});

describe('small helpers', () => {
  it('collapseWhitespace removes zero-width characters and folds runs', () => {
    expect(collapseWhitespace('  a​ \n\t b  ')).toBe('a b');
  });

  it('sniffCharset reads meta charset declarations', () => {
    expect(sniffCharset(Buffer.from('<meta charset="Shift_JIS">'))).toBe('shift_jis');
    expect(sniffCharset(Buffer.from('<meta http-equiv="Content-Type" content="text/html; charset=windows-1252">'))).toBe(
      'windows-1252',
    );
    expect(sniffCharset(Buffer.from('<p>none</p>'))).toBeUndefined();
  });
});

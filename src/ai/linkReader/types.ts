// What the link reader knows about a shared link, independent of where it came from. Extractors fill
// this in; format.ts renders it for the read_link tool (full) and the enricher (a one-line preview).

export type LinkSource = 'twitter' | 'youtube' | 'tiktok' | 'instagram' | 'reddit' | 'bluesky' | 'web';

/** Human-readable kind, shown to the model as-is ("tweet", "youtube short", "article", …). */
export type LinkKind =
  | 'tweet'
  | 'youtube video'
  | 'youtube short'
  | 'tiktok'
  | 'instagram post'
  | 'instagram reel'
  | 'reddit post'
  | 'bluesky post'
  | 'article'
  | 'web page'
  | 'image'
  | 'video file'
  | 'document';

export type LinkImage = { type: 'image'; url: string; alt?: string };

export type LinkVideo = {
  type: 'video';
  /** A direct media file (mp4/webm/mov) — the only thing video understanding can use. */
  url?: string;
  /** Where the video plays when there is no direct file (an HLS playlist, an embed page). */
  pageUrl?: string;
  thumbnailUrl?: string;
  durationSecs?: number;
  sizeBytes?: number;
  contentType?: string;
  /** Filled in by read_link through describeVideo(); cached with the rest of the content. */
  description?: string;
  /** Why the video wasn't / can't be described (shown to the model instead of a description). */
  note?: string;
};

export type LinkMedia = LinkImage | LinkVideo;

export type LinkStats = Partial<
  Record<'likes' | 'reposts' | 'replies' | 'quotes' | 'views' | 'comments' | 'score' | 'bookmarks', number>
>;

export type LinkQuote = { author?: string; handle?: string; text?: string; url?: string; media?: string };

export type LinkComment = { author: string; text: string; score?: number };

export type LinkContent = {
  /** The canonical URL for this content (e.g. the x.com status for any FxTwitter mirror). */
  url: string;
  source: LinkSource;
  kind: LinkKind;
  title?: string;
  /** Display name (person, channel, subreddit poster). */
  author?: string;
  /** Platform handle without decoration: "jack", "nasa.gov", "u/someone", "@channel". */
  handle?: string;
  /** Where it was posted, when that's not obvious from the kind (subreddit, site name). */
  site?: string;
  /** Epoch ms. */
  publishedAt?: number;
  /** The main text, already capped. */
  text?: string;
  textTruncated?: boolean;
  language?: string;
  translation?: { from: string; text: string };
  quote?: LinkQuote;
  replyingTo?: string;
  comments?: LinkComment[];
  stats?: LinkStats;
  media: LinkMedia[];
  /** Short caveats for the model ("age-restricted", "captions unavailable", …). */
  notes?: string[];
};

export type LinkReadResult = { ok: true; content: LinkContent } | { ok: false; url: string; error: string };

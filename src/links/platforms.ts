// The platforms link fixing knows about, shared by the fixer engine, the health tracker and the alerts.
export type Platform = 'twitter' | 'instagram' | 'tiktok' | 'reddit' | 'bluesky';

export const PLATFORMS: readonly Platform[] = ['twitter', 'instagram', 'tiktok', 'reddit', 'bluesky'];

/** Human-facing platform names (report-channel alerts, logs). */
export const PLATFORM_LABELS: Record<Platform, string> = {
  twitter: 'Twitter/X',
  instagram: 'Instagram',
  tiktok: 'TikTok',
  reddit: 'Reddit',
  bluesky: 'Bluesky',
};

/** The env var that overrides each platform's fixer list (named in alerts so the owner knows what to change). */
export const FIXER_ENV_VARS: Record<Platform, string> = {
  twitter: 'TWITTER_FIXERS',
  instagram: 'INSTAGRAM_FIXERS',
  tiktok: 'TIKTOK_FIXERS',
  reddit: 'REDDIT_FIXERS',
  bluesky: 'BLUESKY_FIXERS',
};

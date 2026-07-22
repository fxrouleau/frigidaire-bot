import { ChannelType, Events, type Message } from 'discord.js';
import { logger } from '../logger';
import { repostMessage } from '../utils';

// One handler for every embed-fix platform. A single pass over the message means a message
// containing links from several platforms is reposted exactly once — separate handlers used to
// race each other deleting the same original message.
// URL character class excludes < > | so markup wrapping a link (spoilers ||...||, suppressed
// embeds <...>) is never swallowed into the URL and then mangled by the query strip.
const URL_CHARS = '[^\\s<>|]+';

export type LinkPlatform = {
  name: string;
  re: RegExp;
  fixDomain: (url: string) => string;
};

export const platforms: LinkPlatform[] = [
  {
    name: 'twitter',
    re: new RegExp(`https?://(?:[a-z0-9-]+\\.)?(?:twitter|x)\\.com/\\w+/status/${URL_CHARS}`, 'gi'),
    fixDomain: (url) => url.replace(/(twitter|x)\.com/i, 'fixvx.com'),
  },
  {
    name: 'instagram',
    re: new RegExp(`https?://(?:[a-z0-9-]+\\.)?instagram\\.com/(?:p|reels?|tv)/${URL_CHARS}`, 'gi'),
    fixDomain: (url) => url.replace(/instagram\.com/i, 'zzinstagram.com'),
  },
  {
    name: 'tiktok',
    re: new RegExp(`https?://(?:[a-z0-9-]+\\.)*tiktok\\.com/${URL_CHARS}`, 'gi'),
    fixDomain: (url) => url.replace(/tiktok\.com/i, 'tnktok.com'),
  },
];

// ``` fenced blocks and `inline code` — links inside these are never rewritten.
const CODE_SEGMENT = /```[\s\S]*?```|`[^`\n]*`/g;

const fixUrl = (platform: LinkPlatform, url: string) => platform.fixDomain(url).replace(/\?.*/, '');

function replaceInSegment(segment: string): { text: string; changed: boolean } {
  let changed = false;
  let text = segment;
  for (const platform of platforms) {
    text = text.replace(platform.re, (match, offset: number, source: string) => {
      // <...>-wrapped links were embed-suppressed on purpose — leave them alone.
      if (offset > 0 && source[offset - 1] === '<') return match;
      changed = true;
      return fixUrl(platform, match);
    });
  }
  return { text, changed };
}

/** Rewrites all fixable links outside code blocks/inline code. */
export function replaceLinks(content: string): { content: string; changed: boolean } {
  let out = '';
  let changed = false;
  let last = 0;
  for (const match of content.matchAll(CODE_SEGMENT)) {
    const segment = replaceInSegment(content.slice(last, match.index));
    out += segment.text + match[0];
    changed = changed || segment.changed;
    last = match.index + match[0].length;
  }
  const tail = replaceInSegment(content.slice(last));
  out += tail.text;
  changed = changed || tail.changed;
  return { content: out, changed };
}

module.exports = {
  name: Events.MessageCreate,
  async execute(message: Message) {
    if (message.author.bot) return;
    if (message.channel.type !== ChannelType.GuildText) return;

    const { content, changed } = replaceLinks(message.content);
    if (!changed) return;

    logger.info(`Found fixable link(s) in message ${message.id}. Replacing...`);
    try {
      await repostMessage(message, content);
    } catch (error) {
      // Never let a repost failure escape: an under-permissioned channel must not become a
      // crash loop, and the user's original message stays put when we can't repost it.
      logger.error(`Failed to repost message ${message.id} with fixed links:`, error);
    }
  },
};

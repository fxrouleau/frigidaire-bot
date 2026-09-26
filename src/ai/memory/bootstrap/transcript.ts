// Compact transcripts of the message archive for the memory bootstrap (docs/memory.md "Bootstrap"): the
// monthly files and token-sized chunks of the export, and the segments the built-in bootstrap reads. The
// reader pays per token and most messages are only 10–15 tokens of text, so the framing is kept small:
//
//   ## 2024-03-01 (Friday)
//   ### #general
//   21:40 Remi: anyone up / (↩ Dale) the mtg thing again [file: deck.png]
//   Dale: [voice: ok so hear me out] [link: Some video title]
//   Remi: lol
//   23:05 Nova: morning??
//
// A `## day` header per Eastern day, a `### #channel` header per channel run, then `Name: text` lines. A
// line starts with its Eastern `HH:MM` when a conversation (re)starts: after a header, or after 10 quiet
// minutes; lines without one follow the previous line within minutes. Consecutive messages by one author
// in one channel a few minutes apart share a line, joined by ` / `. Names are the export's (people.ts:
// current display names, unique); ids never appear per line.
// Mentions become `@Name`, custom emojis `:name:`, links their host, voice transcripts `[voice: …]`,
// attachments `[file: name]`, link previews `[link: title]`, replies `(↩ Name)`; relays read as their
// author (the archive already attributes them); the bot's own lines read `bot:` and are truncated.
import type { ArchivedMessage } from '../../../archive/archiveStore';
import { dayLabel, easternDay, easternTime } from './dates';
import { BOT_LABEL, type ExportPeople } from './people';
import { estimateTokens } from './tokens';

/** One transcript line: one message, or a run of one author's messages merged. */
export type TranscriptLine = {
  /** First and last message time (epoch ms). */
  startMs: number;
  endMs: number;
  /** Eastern date, YYYY-MM-DD. */
  day: string;
  /** '#general', '#general › Thread name'. */
  channel: string;
  /** The author's label (an export name, or 'bot'). */
  author: string;
  /** Eastern `HH:MM` of the first message. */
  time: string;
  /** The line without its time: `Name: text / text`. */
  body: string;
  /** A conversation (re)starts here (a quiet spell or another channel before it): the line shows its time. */
  timed: boolean;
  /** Characters of the messages' own text in the line (the rest is framing). */
  payloadChars: number;
  /** Estimated tokens of the messages' own text in the line (tokens.ts). */
  payloadTokens: number;
  /** The archive ids of the messages on the line, oldest first. */
  messageIds: string[];
};

export type TranscriptOptions = {
  /** Merge an author's next message onto their line when it follows within this long (default 5 min). */
  mergeGapMs?: number;
  /** A line after this much silence shows its time (default 10 min). */
  quietGapMs?: number;
  /** Start a new line once a merged line holds this many characters of text (default 700)… */
  maxMergedChars?: number;
  /** …or this many messages (default 12). */
  maxMergedMessages?: number;
  /** The bot's own messages are cut to this many characters (default 200). */
  botMaxChars?: number;
};

export const TRANSCRIPT_DEFAULTS = {
  mergeGapMs: 5 * 60_000,
  quietGapMs: 10 * 60_000,
  maxMergedChars: 700,
  maxMergedMessages: 12,
  botMaxChars: 200,
} as const;

/** What the renderer needs to know besides the messages: names and channel labels. */
export type TranscriptContext = {
  people: Pick<ExportPeople, 'authorOf' | 'byAccount' | 'botIds'>;
  /** A channel's label: '#name' ('#parent › thread' for a thread). */
  channelLabel(channelId: string): string;
};

const MENTION = /<@!?(\d{15,21})>/g;
const ROLE_MENTION = /<@&\d{15,21}>/g;
const CHANNEL_MENTION = /<#(\d{15,21})>/g;
const CUSTOM_EMOJI = /<a?:(\w{1,64}):\d{15,21}>/g;
const TIMESTAMP = /<t:(-?\d{1,13})(?::[tTdDfFR])?>/g;
const SLASH_MENTION = /<\/([\w -]{1,64}):\d{15,21}>/g;
const URL_PATTERN = /<?\b(https?:\/\/[^\s<>]+)>?/g;
const TRAILING_PUNCTUATION = /[.,;:!?)\]'"]+$/;

/** A link as its host (`youtube.com/…`): the path is mostly ids, and the preview title says what it was. */
export function shortUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, '');
    const more = (parsed.pathname && parsed.pathname !== '/') || parsed.search ? '/…' : '';
    return `${host}${more}`;
  } catch {
    return url.length > 40 ? `${url.slice(0, 39)}…` : url;
  }
}

/** One line of text: every line break becomes ` ⏎ `, runs of spaces one space. */
export function oneLine(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\s*\n\s*/g, ' ⏎ ')
    .replace(/[ \t ]+/g, ' ')
    .trim();
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** A message body in transcript form: Discord markup resolved to names, links shortened, one line. */
export function compactText(raw: string, ctx: TranscriptContext): string {
  const text = raw
    .replace(MENTION, (_, id: string) => {
      if (ctx.people.botIds.has(id)) return `@${BOT_LABEL}`;
      return `@${ctx.people.byAccount(id)?.name ?? 'someone'}`;
    })
    .replace(ROLE_MENTION, '@role')
    .replace(CHANNEL_MENTION, (_, id: string) => ctx.channelLabel(id))
    .replace(CUSTOM_EMOJI, (_, name: string) => `:${name}:`)
    .replace(TIMESTAMP, (whole: string, seconds: string) => {
      const ms = Number(seconds) * 1000;
      return Number.isFinite(ms) ? `${easternDay(ms)} ${easternTime(ms)}` : whole;
    })
    .replace(SLASH_MENTION, (_, name: string) => `/${name}`)
    .replace(URL_PATTERN, (_, url: string) => {
      const trailing = url.match(TRAILING_PUNCTUATION)?.[0] ?? '';
      return `${shortUrl(url.slice(0, url.length - trailing.length))}${trailing}`;
    });
  return oneLine(text);
}

// The extra_text lines ingest writes that the structured columns don't already carry.
const EXTRA_KINDS: ReadonlyArray<{ prefix: string; label: string }> = [
  { prefix: 'sticker ', label: 'sticker' },
  { prefix: 'forwarded: ', label: 'fwd' },
  { prefix: 'poll: ', label: 'poll' },
];

const MAX_LINK_TITLE_CHARS = 80;
const MAX_EXTRA_CHARS = 300;
const MAX_LINKS_PER_MESSAGE = 2;

/**
 * One message's text in transcript form: `(↩ Name)` for a reply, the body, then `[voice: …]`,
 * `[file: …]`, `[link: …]`, `[sticker: …]`, `[fwd: …]` and `[poll: …]`. Empty when it carried nothing.
 */
export function messagePayload(message: ArchivedMessage, ctx: TranscriptContext, replyTo?: string | null): string {
  const parts: string[] = [];
  if (message.replyToId) parts.push(replyTo ? `(↩ ${replyTo})` : '(↩)');
  const body = compactText(message.content, ctx);
  if (body) parts.push(body);
  const transcript = message.transcript ? oneLine(message.transcript) : '';
  if (transcript) parts.push(`[voice: ${transcript}]`);
  else if (message.hasAudio && message.attachments.every((a) => /^voice-message\.\w+$/.test(a.name))) {
    parts.push('[voice message]');
  }
  for (const file of message.attachments) {
    if (/^voice-message\.\w+$/.test(file.name) && message.hasAudio) continue;
    parts.push(`[file: ${oneLine(file.name)}]`);
  }
  const links = new Set<string>();
  for (const embed of message.embeds) {
    const label = embed.title ? clip(oneLine(embed.title), MAX_LINK_TITLE_CHARS) : embed.url ? shortUrl(embed.url) : '';
    if (label) links.add(label);
  }
  for (const label of [...links].slice(0, MAX_LINKS_PER_MESSAGE)) parts.push(`[link: ${label}]`);
  for (const line of message.extraText.split('\n')) {
    const kind = EXTRA_KINDS.find((k) => line.startsWith(k.prefix));
    if (kind) parts.push(`[${kind.label}: ${clip(oneLine(line.slice(kind.prefix.length)), MAX_EXTRA_CHARS)}]`);
  }
  return parts.join(' ');
}

/**
 * Turns archived messages (oldest first) into transcript lines, merging runs. Streaming: add() one
 * message at a time, lines() at the end.
 */
export class TranscriptBuilder {
  private readonly out: TranscriptLine[] = [];
  private current: (TranscriptLine & { channelId: string; count: number }) | undefined;
  // The line before the current one ended here, in this channel (whether the next line opens a conversation).
  private previous: { endMs: number; channelId: string; day: string } | undefined;
  // Who wrote each message seen so far, for `(↩ Name)`.
  private readonly authors = new Map<string, string>();
  private readonly opts: Required<TranscriptOptions>;

  constructor(
    private readonly ctx: TranscriptContext,
    opts: TranscriptOptions = {},
  ) {
    this.opts = { ...TRANSCRIPT_DEFAULTS, ...opts };
  }

  add(message: ArchivedMessage): void {
    const author = this.ctx.people.authorOf(message);
    this.authors.set(message.id, author);
    const replyTo = message.replyToId ? this.authors.get(message.replyToId) : undefined;
    let payload = messagePayload(message, this.ctx, replyTo);
    if (!payload) return;
    if (author === BOT_LABEL) payload = clip(payload, this.opts.botMaxChars);

    const day = easternDay(message.createdAt);
    const current = this.current;
    if (
      current &&
      current.author === author &&
      current.channelId === message.channelId &&
      current.day === day &&
      message.createdAt - current.endMs <= this.opts.mergeGapMs &&
      current.count < this.opts.maxMergedMessages &&
      current.payloadChars + payload.length <= this.opts.maxMergedChars
    ) {
      current.body += ` / ${payload}`;
      current.payloadChars += payload.length;
      current.payloadTokens += estimateTokens(payload);
      current.endMs = message.createdAt;
      current.messageIds.push(message.id);
      current.count++;
      return;
    }
    this.flush();
    const previous = this.previous;
    this.current = {
      startMs: message.createdAt,
      endMs: message.createdAt,
      day,
      channel: this.ctx.channelLabel(message.channelId),
      channelId: message.channelId,
      author,
      time: easternTime(message.createdAt),
      body: `${author}: ${payload}`,
      timed:
        !previous ||
        previous.channelId !== message.channelId ||
        previous.day !== day ||
        message.createdAt - previous.endMs >= this.opts.quietGapMs,
      payloadChars: payload.length,
      payloadTokens: estimateTokens(payload),
      messageIds: [message.id],
      count: 1,
    };
  }

  /** Every line so far, oldest first. */
  lines(): TranscriptLine[] {
    this.flush();
    return this.out;
  }

  private flush(): void {
    if (!this.current) return;
    const { channelId, count: _count, ...line } = this.current;
    this.out.push(line);
    this.previous = { endMs: line.endMs, channelId, day: line.day };
    this.current = undefined;
  }
}

/** Transcript lines for messages (oldest first), with the default options. */
export function buildTranscript(
  messages: Iterable<ArchivedMessage>,
  ctx: TranscriptContext,
  opts?: TranscriptOptions,
): TranscriptLine[] {
  const builder = new TranscriptBuilder(ctx, opts);
  for (const message of messages) builder.add(message);
  return builder.lines();
}

/** A line as written: with its time when it opens a conversation or follows a header. */
export function lineText(line: TranscriptLine, afterHeader = false): string {
  return line.timed || afterHeader ? `${line.time} ${line.body}` : line.body;
}

/** Rendered text plus, for each transcript line, the (1-based) file line it landed on. */
export type RenderedTranscript = { lines: string[]; lineNumbers: number[] };

/**
 * Transcript lines with their `## day` and `### #channel` headers, one file line each. A blank line
 * precedes every day header but the first. `firstLineNumber` is the file line the first output line will
 * be on (for citing lines by number).
 */
export function renderTranscript(lines: TranscriptLine[], firstLineNumber = 1): RenderedTranscript {
  const out: string[] = [];
  const lineNumbers: number[] = [];
  let day: string | undefined;
  let channel: string | undefined;
  for (const line of lines) {
    let header = false;
    if (line.day !== day) {
      if (out.length > 0) out.push('');
      out.push(`## ${dayLabel(line.day)}`);
      day = line.day;
      channel = undefined;
    }
    if (line.channel !== channel) {
      out.push(`### ${line.channel}`);
      channel = line.channel;
      header = true;
    }
    out.push(lineText(line, header));
    lineNumbers.push(firstLineNumber + out.length - 1);
  }
  return { lines: out, lineNumbers };
}

/** The heading a chunk's lead-in sits under: context the reader must not extract from again. */
export const ALREADY_COVERED_HEADING = '## ALREADY COVERED — context only, do not extract';
/** The heading the chunk's own conversation starts under. */
export const NEW_PART_HEADING = '## NEW — extract from here';

/**
 * A lead-in (the conversation just before a chunk) as quoted lines: `> YYYY-MM-DD (Weekday) · #channel`
 * whenever the day or channel changes, then `> Name: text` lines (timed like the transcript's).
 */
export function renderLeadIn(lines: TranscriptLine[]): string[] {
  const out: string[] = [];
  let place: string | undefined;
  for (const line of lines) {
    const here = `${dayLabel(line.day)} · ${line.channel}`;
    const header = here !== place;
    if (header) {
      out.push(`> ${here}`);
      place = here;
    }
    out.push(`> ${lineText(line, header)}`);
  }
  return out;
}

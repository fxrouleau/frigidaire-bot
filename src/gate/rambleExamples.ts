// Few-shot material for the ramble judge, pulled from the message archive.
//
// The ramble channel (RAMBLE_CHANNEL_ID) is literally a labelled set of one member's rambles: the group
// made it for them. So the judge is shown a few real rambles from there, next to a few of the same
// person's ordinary messages in the main chat, and compares the run in front of it against both. That is
// what makes the redirect about *content* (monologue-ish, stream-of-consciousness weirdness) rather than
// how much someone types.
//
// Reading the archive is a local SQLite query, but a year of a channel is still worth caching: examples
// are picked once a day per person (fewer when the archive has nothing yet, so a fresh backfill is
// picked up within the hour). No examples at all ⇒ the judge runs zero-shot on its description.
import { getMemoryStore } from '../ai/memory';
import { type ArchivedMessage, getArchivedMessages } from '../archive';
import { canonicalUserId, isSamePerson } from '../linkedAccounts';
import { readableMarkup, stripMarkup, truncate } from './text';

const DAY_MS = 24 * 60 * 60 * 1000;
const CACHE_TTL_MS = DAY_MS;
const EMPTY_CACHE_TTL_MS = 60 * 60 * 1000;
const RAMBLE_LOOKBACK_MS = 365 * DAY_MS;
// Normal messages: two weeks of the main channel is plenty for an active member; a quiet one gets two months.
const NORMAL_LOOKBACKS_MS = [14 * DAY_MS, 60 * DAY_MS];
// Consecutive messages by the person, less than this apart, form one ramble.
const RUN_GAP_MS = 10 * 60 * 1000;
const MIN_RAMBLE_PROSE_CHARS = 120;
const MAX_RAMBLES = 4;
const MAX_RAMBLE_CHARS = 700;
const MIN_NORMAL_PROSE_CHARS = 15;
const MAX_NORMAL_SOURCE_CHARS = 400;
const MIN_NORMAL_EXAMPLES = 4;
const MAX_NORMALS = 8;
const MAX_NORMAL_CHARS = 200;

export type RambleExamples = {
  /** Real rambles (one string per run of messages, lines joined by newlines), labelled by the channel. */
  rambles: string[];
  /** Whether `rambles` are this person's own (true) or other members' from the same channel (false). */
  ramblesAreTheirs: boolean;
  /** Some of the person's ordinary messages in the main chat, for contrast. */
  normal: string[];
};

export type RambleExampleRequest = {
  /** Any of the person's account ids (linked accounts are matched through isSamePerson). */
  userId: string;
  rambleChannelId: string;
  /** Where the person's normal messages come from (the main channel). */
  normalChannelId: string;
};

export type RambleExampleSource = (request: RambleExampleRequest) => RambleExamples;

/** getArchivedMessages' shape: a channel's messages in [startMs, endMs), oldest first. */
export type ArchiveReader = (channelId: string, startMs: number, endMs: number) => ArchivedMessage[];

export type ArchiveRambleExamplesOptions = {
  read?: ArchiveReader;
  now?: () => number;
  /** Picks the sample; injectable so tests are deterministic. */
  random?: () => number;
  /** Names for `<@id>` mentions inside examples (default: the memory store's identities). */
  resolveName?: (userId: string) => string | undefined;
};

function defaultResolveName(userId: string): string | undefined {
  try {
    return getMemoryStore().getIdentityById(userId)?.display_name;
  } catch {
    return undefined;
  }
}

/** Members' messages only: the bot's own posts are never examples; relays count as the member. */
function isMemberMessage(message: ArchivedMessage): boolean {
  return message.source !== 'bot' && message.authorId !== null;
}

/**
 * Runs of consecutive messages by one author (less than RUN_GAP_MS apart, nobody else in between),
 * as the text the judge reads. `keep` decides whose runs are returned.
 */
export function groupRuns(
  messages: ArchivedMessage[],
  keep: (authorId: string) => boolean,
  render: (content: string) => string,
): string[] {
  const runs: string[] = [];
  let current: { authorId: string; lines: string[]; prose: number; lastAt: number } | undefined;
  const flush = () => {
    if (current && keep(current.authorId) && current.prose >= MIN_RAMBLE_PROSE_CHARS) {
      runs.push(current.lines.join('\n'));
    }
    current = undefined;
  };
  for (const message of messages) {
    if (!isMemberMessage(message) || !message.authorId) continue;
    const text = render(message.content);
    const sameRun =
      current !== undefined &&
      isSamePerson(current.authorId, message.authorId) &&
      message.createdAt - current.lastAt < RUN_GAP_MS;
    if (!sameRun) {
      flush();
      current = { authorId: message.authorId, lines: [], prose: 0, lastAt: message.createdAt };
    }
    if (!current) continue;
    current.lastAt = message.createdAt;
    if (text) current.lines.push(text);
    current.prose += stripMarkup(message.content).length;
  }
  flush();
  return runs;
}

/** Up to `count` items drawn without replacement, in their original order. */
function sample<T>(items: T[], count: number, random: () => number): T[] {
  if (items.length <= count) return items;
  const indexes = items.map((_, i) => i);
  for (let i = indexes.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [indexes[i], indexes[j]] = [indexes[j], indexes[i]];
  }
  return indexes
    .slice(0, count)
    .sort((a, b) => a - b)
    .map((i) => items[i]);
}

export function createArchiveRambleExamples(opts: ArchiveRambleExamplesOptions = {}): RambleExampleSource {
  const read: ArchiveReader =
    opts.read ?? ((channelId, startMs, endMs) => getArchivedMessages(channelId, startMs, endMs));
  const now = opts.now ?? Date.now;
  const random = opts.random ?? Math.random;
  const resolveName = opts.resolveName ?? defaultResolveName;
  const cache = new Map<string, { examples: RambleExamples; expiresAt: number }>();

  const render = (content: string) => readableMarkup(content, resolveName);

  const load = (request: RambleExampleRequest, at: number): RambleExamples => {
    const isTheirs = (authorId: string) => isSamePerson(authorId, request.userId);

    const rambleChannel = read(request.rambleChannelId, at - RAMBLE_LOOKBACK_MS, at);
    let rambles = groupRuns(rambleChannel, isTheirs, render);
    let ramblesAreTheirs = true;
    if (rambles.length === 0) {
      // Nothing of theirs archived there yet: the channel's other rambles still show what a ramble is.
      rambles = groupRuns(rambleChannel, () => true, render);
      ramblesAreTheirs = false;
    }

    let normalSource: ArchivedMessage[] = [];
    for (const lookback of NORMAL_LOOKBACKS_MS) {
      normalSource = read(request.normalChannelId, at - lookback, at).filter((m) => {
        if (!isMemberMessage(m) || !m.authorId || !isTheirs(m.authorId)) return false;
        const prose = stripMarkup(m.content).length;
        return prose >= MIN_NORMAL_PROSE_CHARS && prose <= MAX_NORMAL_SOURCE_CHARS;
      });
      if (normalSource.length >= MIN_NORMAL_EXAMPLES) break;
    }

    return {
      rambles: sample(rambles, MAX_RAMBLES, random).map((run) => truncate(run, MAX_RAMBLE_CHARS)),
      ramblesAreTheirs,
      normal: sample(normalSource, MAX_NORMALS, random).map((m) => truncate(render(m.content), MAX_NORMAL_CHARS)),
    };
  };

  return (request) => {
    const key = `${canonicalUserId(request.userId)}:${request.rambleChannelId}:${request.normalChannelId}`;
    const at = now();
    const cached = cache.get(key);
    if (cached && at < cached.expiresAt) return cached.examples;
    const examples = load(request, at);
    const ttl = examples.rambles.length > 0 ? CACHE_TTL_MS : EMPTY_CACHE_TTL_MS;
    cache.set(key, { examples, expiresAt: at + ttl });
    return examples;
  };
}

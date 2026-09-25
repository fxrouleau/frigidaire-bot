// The local message archive: every member message the bot can see, kept in ./data/archive.db (its own
// file because it grows to hundreds of MB once years of history are imported) with an FTS5 index for
// keyword search. Feeds the search tools, Wrapped, and anything else that needs "what was said when".
//
// FTS integrity is by construction: the index is an external-content FTS5 table kept in sync ONLY by
// the three triggers below, which always hand FTS5 exactly the values it indexed (old.* on delete and
// update). That is what the memory store learned the hard way: a hand-issued 'delete' with values that
// don't match what was indexed, or a repeated one, corrupts the index ("database disk image is
// malformed" on the next MATCH). Two rules keep it that way:
//   - never write `INSERT OR REPLACE` into messages: REPLACE's implicit delete does not fire DELETE
//     triggers (recursive_triggers is off), which would orphan index entries; upserts use ON CONFLICT.
//   - every row is indexed, deleted ones included (their text is scrubbed, so they index as empty);
//     "not deleted" is a query filter, not an index condition, so 'rebuild' stays exact.
//
// Snowflake ids are TEXT: they exceed 2^53, and a JS number would silently corrupt them. The table
// keeps an explicit INTEGER PRIMARY KEY (`seq`) as the stable rowid the FTS index points at; an
// implicit rowid may be renumbered by VACUUM.
import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { STOP_WORDS } from '../ai/memory/wordOverlap';
import { config } from '../config';
import { logger } from '../logger';

export type ArchiveSource = 'human' | 'relay' | 'bot';

export type ArchivedAttachment = { name: string; type: string | null; size: number; url: string };
export type ArchivedEmbed = { title?: string; url?: string; description?: string };

/** One reaction on a message, as Discord counts it. */
export type ArchivedReaction = {
  /** Custom emoji id; null for a unicode emoji. */
  id: string | null;
  /** The custom emoji's name, or the unicode emoji itself. */
  name: string;
  /** Animated custom emoji (absent for static and unicode ones). */
  animated?: boolean;
  /** Everyone who reacted with it, the bot included. */
  count: number;
  /** The bot itself is one of the `count` reactors. */
  me?: boolean;
};

/** The key Discord's reaction cache uses: the custom emoji id, or the unicode emoji itself. */
export function reactionKey(reaction: Pick<ArchivedReaction, 'id' | 'name'>): string {
  return reaction.id ?? reaction.name;
}

/** Canonical order (by key), so an unchanged reaction set serializes to the same JSON and upserts are no-ops. */
export function normalizeReactions(reactions: ArchivedReaction[]): ArchivedReaction[] {
  return reactions
    .filter((r) => r.count > 0)
    .sort((a, b) => (reactionKey(a) < reactionKey(b) ? -1 : reactionKey(a) > reactionKey(b) ? 1 : 0));
}

/** One message as ingest hands it to the store. */
export type ArchiveMessageInput = {
  id: string;
  guildId: string | null;
  channelId: string;
  /** The parent channel when the message is in a thread. */
  parentChannelId: string | null;
  /** Real author (relays resolve to the member they were posted for); null when only a name is known. */
  authorId: string | null;
  authorName: string;
  source: ArchiveSource;
  /** RelayKind for source 'relay' ('link_fix' | 'regret'), when known. */
  relayKind: string | null;
  content: string;
  /** Searchable text that is not the message body: embed titles/descriptions, file names, polls, forwards. */
  extraText: string;
  transcript: string | null;
  createdAt: number;
  editedAt: number | null;
  replyToId: string | null;
  flags: number;
  hasAudio: boolean;
  attachments: ArchivedAttachment[];
  embeds: ArchivedEmbed[];
  reactions: ArchivedReaction[];
};

export type ArchivedMessage = Omit<ArchiveMessageInput, 'hasAudio'> & {
  hasAudio: boolean;
  editCount: number;
  deletedAt: number | null;
};

export type ArchiveChannelInput = {
  id: string;
  guildId: string | null;
  name: string;
  parentId: string | null;
  type: number;
};

export type ArchivedChannel = ArchiveChannelInput & { updatedAt: number };

export type BackfillState = {
  channelId: string;
  /** The oldest message fetched so far: the next page is requested `before` it. */
  cursorId: string | null;
  cursorAt: number | null;
  done: boolean;
  pages: number;
  fetched: number;
  lastError: string | null;
  errorAt: number | null;
  updatedAt: number;
};

/** Filters shared by keyword search and plain listing. Every id list is an exact-match set. */
export type ArchiveFilters = {
  /** Author ids; a message matches when its author_id is in the list… */
  authorIds?: string[];
  /** …or, for rows without an author id, when its author name matches one of these (case-insensitive). */
  authorNames?: string[];
  /** Only the bot's own messages. */
  botOnly?: boolean;
  /** A message matches when its channel OR its thread's parent is in the list. */
  channelIds?: string[];
  /** Visibility boundary: the message's own channel must be in this list. Undefined ⇒ no restriction. */
  allowedChannelIds?: string[];
  afterMs?: number;
  beforeMs?: number;
};

export type SearchHit = ArchivedMessage & { tier: 'all' | 'any' };

export type SearchResult = {
  hits: SearchHit[];
  /** True when the candidate pool was full, i.e. there are probably more matches than were ranked. */
  truncated: boolean;
};

export type ReactionProfileOptions = {
  /** Only this channel and its threads. Undefined ⇒ every archived channel. */
  channelId?: string;
  /** Only messages posted at or after this instant. */
  sinceMs?: number;
  /** Emojis returned, most used first (default 25). */
  limit?: number;
  /** Example messages per emoji (default 3). */
  samplesPerEmoji?: number;
};

export type ReactionSample = {
  messageId: string;
  channelId: string;
  guildId: string | null;
  authorId: string | null;
  authorName: string;
  createdAt: number;
  /** Members who reacted with this emoji on this message (the bot excluded). */
  count: number;
  /** One-line preview of the message (≤140 chars). */
  snippet: string;
};

export type ReactionProfileEntry = {
  /** The custom emoji id, or the unicode emoji itself. */
  key: string;
  /** Custom emoji id; null for a unicode emoji. */
  id: string | null;
  name: string;
  animated: boolean;
  /** Total reactions with it by members (the bot's own excluded). */
  uses: number;
  /** Messages it was used on. */
  messages: number;
  lastUsedAt: number;
  samples: ReactionSample[];
};

export type ReactionProfile = {
  /** Member messages in scope. */
  messages: number;
  /** Of those, messages with at least one member reaction. */
  reactedMessages: number;
  /** reactedMessages / messages (0 when there are no messages): how often anything gets a reaction. */
  baseRate: number;
  emojis: ReactionProfileEntry[];
};

type MessageRow = {
  seq: number;
  id: string;
  guild_id: string | null;
  channel_id: string;
  parent_channel_id: string | null;
  author_id: string | null;
  author_name: string;
  source: ArchiveSource;
  relay_kind: string | null;
  content: string;
  extra_text: string;
  transcript: string | null;
  created_at: number;
  edited_at: number | null;
  edit_count: number;
  deleted_at: number | null;
  reply_to_id: string | null;
  flags: number;
  has_audio: number;
  attachments_json: string | null;
  embeds_json: string | null;
  reactions_json: string | null;
};

type BackfillRow = {
  channel_id: string;
  cursor_id: string | null;
  cursor_at: number | null;
  done: number;
  pages: number;
  fetched: number;
  last_error: string | null;
  error_at: number | null;
  updated_at: number;
};

/** Discord's IS_VOICE_MESSAGE message flag (1 << 13). */
export const VOICE_MESSAGE_FLAG = 8192;

// Candidates ranked per search tier before the recency blend; the blend only reorders within this pool.
const SEARCH_POOL = 200;
// Recency blend: score = relevance × (1 + RECENCY_BOOST × e^(−age/RECENCY_DAYS)), so a message from
// today weighs up to 2× an equally relevant one from years ago. Relevance still dominates.
const RECENCY_BOOST = 1;
const RECENCY_DAYS = 90;
const DAY_MS = 86_400_000;

// Column weights for bm25(): content, author_name, transcript, extra_text. The author column is weighted
// down so "felix pizza" prefers Felix's messages about pizza over any message that merely says "felix".
const BM25_WEIGHTS = '1.0, 0.4, 1.0, 0.6';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS messages (
    seq               INTEGER PRIMARY KEY,
    id                TEXT    NOT NULL UNIQUE,
    guild_id          TEXT,
    channel_id        TEXT    NOT NULL,
    parent_channel_id TEXT,
    author_id         TEXT,
    author_name       TEXT    NOT NULL,
    source            TEXT    NOT NULL CHECK (source IN ('human', 'relay', 'bot')),
    relay_kind        TEXT,
    content           TEXT    NOT NULL DEFAULT '',
    extra_text        TEXT    NOT NULL DEFAULT '',
    transcript        TEXT,
    created_at        INTEGER NOT NULL,
    edited_at         INTEGER,
    edit_count        INTEGER NOT NULL DEFAULT 0,
    deleted_at        INTEGER,
    reply_to_id       TEXT,
    flags             INTEGER NOT NULL DEFAULT 0,
    has_audio         INTEGER NOT NULL DEFAULT 0,
    attachments_json  TEXT,
    embeds_json       TEXT,
    reactions_json    TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_messages_channel_created ON messages(channel_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_messages_author_created ON messages(author_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
  CREATE INDEX IF NOT EXISTS idx_messages_parent_created
    ON messages(parent_channel_id, created_at) WHERE parent_channel_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_messages_pending_audio
    ON messages(created_at) WHERE has_audio = 1 AND transcript IS NULL AND deleted_at IS NULL;
  -- The reaction profile only reads reacted messages (a minority), so it scans this instead of the table.
  CREATE INDEX IF NOT EXISTS idx_messages_reacted
    ON messages(created_at) WHERE reactions_json IS NOT NULL AND deleted_at IS NULL;

  -- porter: "running" finds "ran"/"runs"; remove_diacritics 2: "deja" finds "déjà" (the group writes both).
  CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    content, author_name, transcript, extra_text,
    content='messages', content_rowid='seq',
    tokenize='porter unicode61 remove_diacritics 2'
  );

  CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, content, author_name, transcript, extra_text)
    VALUES (new.seq, new.content, new.author_name, new.transcript, new.extra_text);
  END;

  CREATE TRIGGER IF NOT EXISTS messages_fts_delete AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content, author_name, transcript, extra_text)
    VALUES ('delete', old.seq, old.content, old.author_name, old.transcript, old.extra_text);
  END;

  -- WHEN: an upsert that only refreshes reactions or flags rewrites the text columns with equal values;
  -- the index already holds exactly those, so there is nothing to re-index.
  CREATE TRIGGER IF NOT EXISTS messages_fts_update
  AFTER UPDATE OF content, author_name, transcript, extra_text ON messages
  WHEN old.content IS NOT new.content OR old.author_name IS NOT new.author_name
    OR old.transcript IS NOT new.transcript OR old.extra_text IS NOT new.extra_text
  BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content, author_name, transcript, extra_text)
    VALUES ('delete', old.seq, old.content, old.author_name, old.transcript, old.extra_text);
    INSERT INTO messages_fts(rowid, content, author_name, transcript, extra_text)
    VALUES (new.seq, new.content, new.author_name, new.transcript, new.extra_text);
  END;

  CREATE TABLE IF NOT EXISTS channels (
    id         TEXT    PRIMARY KEY,
    guild_id   TEXT,
    name       TEXT    NOT NULL,
    parent_id  TEXT,
    type       INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS backfill_state (
    channel_id TEXT    PRIMARY KEY,
    cursor_id  TEXT,
    cursor_at  INTEGER,
    done       INTEGER NOT NULL DEFAULT 0,
    pages      INTEGER NOT NULL DEFAULT 0,
    fetched    INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    error_at   INTEGER,
    updated_at INTEGER NOT NULL
  );
`;

// Upsert. On conflict only the mutable parts change, and only when something actually differs: an
// unchanged re-ingest (gap-fill overlap, embed-less update) touches nothing, so the FTS trigger doesn't
// churn. A newer edited_at counts one edit. Deleted rows are never resurrected. Reactions are replaced
// wholesale: every source of a full message (API fetch, the discord.js cache) carries Discord's counts.
const UPSERT_SQL = `
  INSERT INTO messages (
    id, guild_id, channel_id, parent_channel_id, author_id, author_name, source, relay_kind,
    content, extra_text, transcript, created_at, edited_at, edit_count, reply_to_id, flags, has_audio,
    attachments_json, embeds_json, reactions_json
  ) VALUES (
    @id, @guildId, @channelId, @parentChannelId, @authorId, @authorName, @source, @relayKind,
    @content, @extraText, @transcript, @createdAt, @editedAt, @editCount, @replyToId, @flags, @hasAudio,
    @attachmentsJson, @embedsJson, @reactionsJson
  )
  ON CONFLICT(id) DO UPDATE SET
    content = excluded.content,
    extra_text = excluded.extra_text,
    transcript = COALESCE(excluded.transcript, messages.transcript),
    edit_count = messages.edit_count + (
      CASE WHEN excluded.edited_at IS NOT NULL
             AND (messages.edited_at IS NULL OR excluded.edited_at > messages.edited_at)
           THEN 1 ELSE 0 END),
    edited_at = CASE WHEN excluded.edited_at IS NOT NULL
                       AND (messages.edited_at IS NULL OR excluded.edited_at > messages.edited_at)
                     THEN excluded.edited_at ELSE messages.edited_at END,
    author_id = COALESCE(excluded.author_id, messages.author_id),
    relay_kind = COALESCE(excluded.relay_kind, messages.relay_kind),
    flags = excluded.flags,
    has_audio = excluded.has_audio,
    attachments_json = excluded.attachments_json,
    embeds_json = excluded.embeds_json,
    reactions_json = excluded.reactions_json
  WHERE messages.deleted_at IS NULL AND (
    messages.content IS NOT excluded.content
    OR messages.extra_text IS NOT excluded.extra_text
    OR (excluded.transcript IS NOT NULL AND messages.transcript IS NOT excluded.transcript)
    OR (excluded.edited_at IS NOT NULL AND messages.edited_at IS NOT excluded.edited_at)
    OR (excluded.author_id IS NOT NULL AND messages.author_id IS NOT excluded.author_id)
    OR (excluded.relay_kind IS NOT NULL AND messages.relay_kind IS NOT excluded.relay_kind)
    OR messages.flags IS NOT excluded.flags
    OR messages.attachments_json IS NOT excluded.attachments_json
    OR messages.embeds_json IS NOT excluded.embeds_json
    OR messages.reactions_json IS NOT excluded.reactions_json
  )
`;

function parseJsonArray<T>(raw: string | null): T[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

const SAMPLE_SNIPPET_CHARS = 140;

/** A short one-line preview of a sample message: its text, else what it carried (file, link preview). */
function sampleSnippet(content: string, attachmentsJson: string | null, embedsJson: string | null): string {
  const flat = content.replace(/\s+/g, ' ').trim();
  if (flat) return flat.length > SAMPLE_SNIPPET_CHARS ? `${flat.slice(0, SAMPLE_SNIPPET_CHARS - 1)}…` : flat;
  const attachment = parseJsonArray<ArchivedAttachment>(attachmentsJson)[0];
  if (attachment) return `[attached: ${attachment.name}]`;
  const embed = parseJsonArray<ArchivedEmbed>(embedsJson).find((e) => e.title || e.url);
  if (embed) return `[link: ${embed.title ?? embed.url}]`;
  return '(no text)';
}

function reactionsJson(reactions: ArchivedReaction[]): string | null {
  const normalized = normalizeReactions(reactions);
  return normalized.length > 0 ? JSON.stringify(normalized) : null;
}

function toMessage(row: MessageRow): ArchivedMessage {
  return {
    id: row.id,
    guildId: row.guild_id,
    channelId: row.channel_id,
    parentChannelId: row.parent_channel_id,
    authorId: row.author_id,
    authorName: row.author_name,
    source: row.source,
    relayKind: row.relay_kind,
    content: row.content,
    extraText: row.extra_text,
    transcript: row.transcript,
    createdAt: row.created_at,
    editedAt: row.edited_at,
    editCount: row.edit_count,
    deletedAt: row.deleted_at,
    replyToId: row.reply_to_id,
    flags: row.flags,
    hasAudio: row.has_audio === 1,
    attachments: parseJsonArray<ArchivedAttachment>(row.attachments_json),
    embeds: parseJsonArray<ArchivedEmbed>(row.embeds_json),
    reactions: parseJsonArray<ArchivedReaction>(row.reactions_json),
  };
}

function toBackfillState(row: BackfillRow): BackfillState {
  return {
    channelId: row.channel_id,
    cursorId: row.cursor_id,
    cursorAt: row.cursor_at,
    done: row.done === 1,
    pages: row.pages,
    fetched: row.fetched,
    lastError: row.last_error,
    errorAt: row.error_at,
    updatedAt: row.updated_at,
  };
}

/** Orders two snowflakes numerically (they outgrow 2^53, so compare as BigInt). */
export function compareSnowflakes(a: string, b: string): number {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * The distinct searchable terms of a query: FTS5 operators and punctuation stripped (the same set the
 * memory store strips), single characters and pure-punctuation leftovers dropped.
 */
export function ftsTerms(query: string): string[] {
  const stripped = query.replace(/["',()\{\}\*:^~@!#$%&+\-]/g, ' ');
  const terms = stripped.split(/\s+/).filter((t) => t.length > 1 && /[\p{L}\p{N}]/u.test(t));
  return [...new Set(terms.map((t) => t.toLowerCase()))];
}

/**
 * FTS5 MATCH expressions for the two search tiers: 'all' = every term (implicit AND), 'any' = any
 * non-stop-word term (OR). Terms are quoted, so FTS5 keywords (AND, NEAR, …) are plain words.
 */
function matchExpression(terms: string[], mode: 'all' | 'any'): string {
  const quoted = (term: string) => `"${term}"`;
  if (mode === 'all') return terms.map(quoted).join(' ');
  return terms
    .filter((t) => !STOP_WORDS.has(t))
    .map(quoted)
    .join(' OR ');
}

export class ArchiveStore {
  readonly db: Database.Database;
  private readonly statements = new Map<string, Database.Statement>();
  // Channel rows are rewritten only when something changed; ingest calls upsertChannel per message.
  private readonly channelCache = new Map<string, string>();

  constructor(dbPath = './data/archive.db') {
    if (dbPath !== ':memory:') {
      const dir = path.dirname(dbPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    // NORMAL is durable across process crashes in WAL mode (only an OS crash can lose the last commits)
    // and makes the backfill's per-page transactions much cheaper.
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(SCHEMA);
  }

  private stmt(sql: string): Database.Statement {
    let prepared = this.statements.get(sql);
    if (!prepared) {
      prepared = this.db.prepare(sql);
      this.statements.set(sql, prepared);
    }
    return prepared;
  }

  close(): void {
    this.db.close();
  }

  // ---------------------------------------------------------------- writes

  /** Inserts or refreshes one message. Returns true when something was written. */
  upsertMessage(input: ArchiveMessageInput): boolean {
    return this.stmt(UPSERT_SQL).run(this.params(input)).changes > 0;
  }

  /** Upserts a batch in one transaction. Returns how many of the ids were not archived before. */
  upsertMessages(inputs: ArchiveMessageInput[]): number {
    if (inputs.length === 0) return 0;
    return this.db.transaction(() => {
      const existing = this.existingIds(inputs.map((i) => i.id));
      for (const input of inputs) this.stmt(UPSERT_SQL).run(this.params(input));
      return inputs.filter((i) => !existing.has(i.id)).length;
    })();
  }

  private params(input: ArchiveMessageInput): Record<string, string | number | null> {
    return {
      id: input.id,
      guildId: input.guildId,
      channelId: input.channelId,
      parentChannelId: input.parentChannelId,
      authorId: input.authorId,
      authorName: input.authorName,
      source: input.source,
      relayKind: input.relayKind,
      content: input.content,
      extraText: input.extraText,
      transcript: input.transcript,
      createdAt: input.createdAt,
      editedAt: input.editedAt,
      // A message first seen already edited (backfill) was edited at least once.
      editCount: input.editedAt !== null ? 1 : 0,
      replyToId: input.replyToId,
      flags: input.flags,
      hasAudio: input.hasAudio ? 1 : 0,
      attachmentsJson: input.attachments.length > 0 ? JSON.stringify(input.attachments) : null,
      embedsJson: input.embeds.length > 0 ? JSON.stringify(input.embeds) : null,
      reactionsJson: reactionsJson(input.reactions),
    };
  }

  private existingIds(ids: string[]): Set<string> {
    const rows = this.stmt('SELECT id FROM messages WHERE id IN (SELECT value FROM json_each(?))').all(
      JSON.stringify(ids),
    ) as { id: string }[];
    return new Set(rows.map((r) => r.id));
  }

  /**
   * Marks messages deleted and scrubs their text (content, transcript, file names, embeds): a message
   * someone deleted is not kept around to be quoted back. The row itself stays, with author and times,
   * for the edits/deletions stats. Idempotent; unknown ids are ignored. Returns rows newly marked.
   */
  markDeleted(ids: string[], at: number): number {
    if (ids.length === 0) return 0;
    return this.stmt(
      `UPDATE messages
       SET deleted_at = ?, content = '', extra_text = '', transcript = NULL, attachments_json = NULL, embeds_json = NULL,
         reactions_json = NULL
       WHERE id IN (SELECT value FROM json_each(?)) AND deleted_at IS NULL`,
    ).run(at, JSON.stringify(ids)).changes;
  }

  /** markDeleted() for every message of a deleted channel or thread (and, for a channel, its threads). */
  markChannelDeleted(channelId: string, at: number): number {
    return this.stmt(
      `UPDATE messages
       SET deleted_at = ?, content = '', extra_text = '', transcript = NULL, attachments_json = NULL, embeds_json = NULL,
         reactions_json = NULL
       WHERE (channel_id = ? OR parent_channel_id = ?) AND deleted_at IS NULL`,
    ).run(at, channelId, channelId).changes;
  }

  setTranscript(id: string, transcript: string): boolean {
    return (
      this.stmt('UPDATE messages SET transcript = ? WHERE id = ? AND deleted_at IS NULL AND transcript IS NOT ?').run(
        transcript,
        id,
        transcript,
      ).changes > 0
    );
  }

  /** Voice/audio messages from `sinceMs` on that still lack a transcript, newest first. */
  pendingTranscriptIds(sinceMs: number, limit: number): string[] {
    const rows = this.stmt(
      `SELECT id FROM messages
       WHERE has_audio = 1 AND transcript IS NULL AND deleted_at IS NULL AND created_at >= ?
       ORDER BY created_at DESC LIMIT ?`,
    ).all(sinceMs, limit) as { id: string }[];
    return rows.map((r) => r.id);
  }

  /** Relay rows from `sinceMs` on whose kind or real author is still unknown. */
  unresolvedRelayIds(sinceMs: number, limit: number): string[] {
    const rows = this.stmt(
      `SELECT id FROM messages
       WHERE source = 'relay' AND (relay_kind IS NULL OR author_id IS NULL) AND created_at >= ?
       ORDER BY created_at DESC LIMIT ?`,
    ).all(sinceMs, limit) as { id: string }[];
    return rows.map((r) => r.id);
  }

  setRelayInfo(id: string, info: { authorId: string; authorName: string; relayKind: string }): boolean {
    return (
      this.stmt(
        `UPDATE messages SET author_id = ?, author_name = ?, relay_kind = ?
         WHERE id = ? AND source = 'relay'
           AND (author_id IS NOT ? OR author_name IS NOT ? OR relay_kind IS NOT ?)`,
      ).run(info.authorId, info.authorName, info.relayKind, id, info.authorId, info.authorName, info.relayKind)
        .changes > 0
    );
  }

  /** A live archived message's reactions; undefined when the message is not archived or was deleted. */
  getReactions(id: string): ArchivedReaction[] | undefined {
    const row = this.stmt('SELECT reactions_json FROM messages WHERE id = ? AND deleted_at IS NULL').get(id) as
      | { reactions_json: string | null }
      | undefined;
    return row ? parseJsonArray<ArchivedReaction>(row.reactions_json) : undefined;
  }

  /**
   * Replaces a message's reactions (read-modify-write when `next` is a function, in one transaction).
   * Only live archived messages change; the FTS index is untouched. Returns true when something changed.
   */
  updateReactions(
    id: string,
    next: ArchivedReaction[] | ((current: ArchivedReaction[]) => ArchivedReaction[]),
  ): boolean {
    return this.db.transaction(() => {
      const current = this.getReactions(id);
      if (current === undefined) return false;
      const json = reactionsJson(typeof next === 'function' ? next(current) : next);
      return (
        this.stmt('UPDATE messages SET reactions_json = ? WHERE id = ? AND reactions_json IS NOT ?').run(json, id, json)
          .changes > 0
      );
    })();
  }

  /**
   * How members react (see ReactionProfile): member messages (human + relay, not deleted) in scope, each
   * emoji's uses without the bot's own reaction, and the most-reacted examples per emoji.
   */
  reactionProfile(opts: ReactionProfileOptions = {}): ReactionProfile {
    const params: Record<string, string | number> = {};
    const scope = ["m.source IN ('human', 'relay')", 'm.deleted_at IS NULL'];
    if (opts.channelId) {
      params.channelId = opts.channelId;
      scope.push('(m.channel_id = @channelId OR m.parent_channel_id = @channelId)');
    }
    if (opts.sinceMs !== undefined) {
      params.sinceMs = opts.sinceMs;
      scope.push('m.created_at >= @sinceMs');
    }
    const where = scope.join(' AND ');
    // One row per (message, emoji) with the members' count: the bot's own reaction is taken out, so a
    // message only the bot reacted to does not count as reacted.
    const reacted = `
      WITH r AS (
        SELECT m.id, m.channel_id, m.guild_id, m.author_id, m.author_name, m.content, m.created_at,
               m.attachments_json, m.embeds_json,
               COALESCE(j.value ->> '$.id', j.value ->> '$.name') AS emoji_key,
               j.value ->> '$.id' AS emoji_id,
               j.value ->> '$.name' AS emoji_name,
               COALESCE(j.value ->> '$.animated', 0) AS animated,
               (j.value ->> '$.count') - COALESCE(j.value ->> '$.me', 0) AS n
        FROM messages m, json_each(m.reactions_json) j
        WHERE m.reactions_json IS NOT NULL AND ${where}
      )`;

    const base = this.stmt(`SELECT COUNT(*) AS n FROM messages m WHERE ${where}`).get(params) as { n: number };
    const reactedCount = this.stmt(`${reacted} SELECT COUNT(DISTINCT id) AS n FROM r WHERE n > 0`).get(params) as {
      n: number;
    };

    // Bare columns next to a single MAX() come from the row holding the max (documented SQLite
    // behavior), so a renamed custom emoji is reported under its latest name.
    const emojiRows = this.stmt(
      `${reacted}
       SELECT emoji_key, emoji_id, emoji_name, animated, MAX(created_at) AS last_at, SUM(n) AS uses,
              COUNT(*) AS messages
       FROM r WHERE n > 0
       GROUP BY emoji_key
       ORDER BY uses DESC, messages DESC, emoji_key ASC
       LIMIT @limit`,
    ).all({ ...params, limit: opts.limit ?? 25 }) as {
      emoji_key: string;
      emoji_id: string | null;
      emoji_name: string;
      animated: number;
      last_at: number;
      uses: number;
      messages: number;
    }[];

    const samplesPerEmoji = opts.samplesPerEmoji ?? 3;
    const samples = new Map<string, ReactionSample[]>();
    if (emojiRows.length > 0 && samplesPerEmoji > 0) {
      // Examples with text first (they say what the emoji is used FOR), then the most-reacted, then the newest.
      const rows = this.stmt(
        `${reacted}
         SELECT * FROM (
           SELECT r.*, ROW_NUMBER() OVER (
             PARTITION BY emoji_key ORDER BY (content != '') DESC, n DESC, created_at DESC
           ) AS rank
           FROM r WHERE n > 0 AND emoji_key IN (SELECT value FROM json_each(@keys))
         ) WHERE rank <= @samples
         ORDER BY emoji_key, rank`,
      ).all({ ...params, keys: JSON.stringify(emojiRows.map((e) => e.emoji_key)), samples: samplesPerEmoji }) as {
        emoji_key: string;
        id: string;
        channel_id: string;
        guild_id: string | null;
        author_id: string | null;
        author_name: string;
        content: string;
        created_at: number;
        attachments_json: string | null;
        embeds_json: string | null;
        n: number;
      }[];
      for (const row of rows) {
        const list = samples.get(row.emoji_key) ?? [];
        list.push({
          messageId: row.id,
          channelId: row.channel_id,
          guildId: row.guild_id,
          authorId: row.author_id,
          authorName: row.author_name,
          createdAt: row.created_at,
          count: row.n,
          snippet: sampleSnippet(row.content, row.attachments_json, row.embeds_json),
        });
        samples.set(row.emoji_key, list);
      }
    }

    return {
      messages: base.n,
      reactedMessages: reactedCount.n,
      baseRate: base.n > 0 ? reactedCount.n / base.n : 0,
      emojis: emojiRows.map((row) => ({
        key: row.emoji_key,
        id: row.emoji_id,
        name: row.emoji_name,
        animated: row.animated === 1,
        uses: row.uses,
        messages: row.messages,
        lastUsedAt: row.last_at,
        samples: samples.get(row.emoji_key) ?? [],
      })),
    };
  }

  upsertChannel(channel: ArchiveChannelInput, now = Date.now()): void {
    const fingerprint = `${channel.name}|${channel.parentId ?? ''}|${channel.type}|${channel.guildId ?? ''}`;
    if (this.channelCache.get(channel.id) === fingerprint) return;
    this.stmt(
      `INSERT INTO channels (id, guild_id, name, parent_id, type, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET guild_id = excluded.guild_id, name = excluded.name,
         parent_id = excluded.parent_id, type = excluded.type, updated_at = excluded.updated_at`,
    ).run(channel.id, channel.guildId, channel.name, channel.parentId, channel.type, now);
    this.channelCache.set(channel.id, fingerprint);
  }

  // ---------------------------------------------------------------- reads

  getMessage(id: string): ArchivedMessage | undefined {
    const row = this.stmt('SELECT * FROM messages WHERE id = ?').get(id) as MessageRow | undefined;
    return row ? toMessage(row) : undefined;
  }

  getMessages(ids: string[]): Map<string, ArchivedMessage> {
    const result = new Map<string, ArchivedMessage>();
    if (ids.length === 0) return result;
    const rows = this.stmt('SELECT * FROM messages WHERE id IN (SELECT value FROM json_each(?))').all(
      JSON.stringify(ids),
    ) as MessageRow[];
    for (const row of rows) result.set(row.id, toMessage(row));
    return result;
  }

  /**
   * A channel's messages in [startMs, endMs), oldest first, deleted ones excluded. With
   * includeThreads, messages of threads under the channel are included too.
   */
  getChannelMessages(
    channelId: string,
    startMs: number,
    endMs: number,
    opts: { includeThreads?: boolean; limit?: number } = {},
  ): ArchivedMessage[] {
    const channelClause = opts.includeThreads
      ? '(channel_id = @channelId OR parent_channel_id = @channelId)'
      : 'channel_id = @channelId';
    const rows = this.stmt(
      `SELECT * FROM messages
       WHERE ${channelClause} AND created_at >= @startMs AND created_at < @endMs AND deleted_at IS NULL
       ORDER BY created_at ASC, length(id) ASC, id ASC
       LIMIT @limit`,
    ).all({ channelId, startMs, endMs, limit: opts.limit ?? -1 }) as MessageRow[];
    return rows.map(toMessage);
  }

  /** Up to `before` messages before and `after` messages after `target` in its channel (deleted excluded). */
  getContext(
    target: ArchivedMessage,
    before: number,
    after: number,
  ): { before: ArchivedMessage[]; after: ArchivedMessage[] } {
    const earlier = this.stmt(
      `SELECT * FROM messages
       WHERE channel_id = ? AND deleted_at IS NULL AND created_at <= ? AND id != ?
       ORDER BY created_at DESC, length(id) DESC, id DESC LIMIT ?`,
    ).all(target.channelId, target.createdAt, target.id, before) as MessageRow[];
    const later = this.stmt(
      `SELECT * FROM messages
       WHERE channel_id = ? AND deleted_at IS NULL AND created_at >= ? AND id != ?
       ORDER BY created_at ASC, length(id) ASC, id ASC LIMIT ?`,
    ).all(target.channelId, target.createdAt, target.id, after) as MessageRow[];
    const earlierIds = new Set(earlier.map((r) => r.id));
    return {
      before: earlier.reverse().map(toMessage),
      after: later.filter((r) => !earlierIds.has(r.id)).map(toMessage),
    };
  }

  /**
   * Keyword search in two tiers, like the memory store: messages matching EVERY term first, then (only
   * when the first tier is short) messages matching ANY non-stop-word term. Within a tier, BM25 blended
   * with recency. Deleted messages never match.
   */
  search(query: string, filters: ArchiveFilters, limit: number, now = Date.now()): SearchResult {
    const terms = ftsTerms(query);
    if (terms.length === 0) return { hits: [], truncated: false };

    const all = this.matchTier(matchExpression(terms, 'all'), filters, now);
    const hits: SearchHit[] = all.rows.slice(0, limit).map((m) => ({ ...m, tier: 'all' }));
    let truncated = all.truncated;

    if (hits.length < limit && terms.length > 1) {
      const anyExpression = matchExpression(terms, 'any');
      if (anyExpression) {
        const seen = new Set(hits.map((h) => h.id));
        const any = this.matchTier(anyExpression, filters, now);
        truncated ||= any.truncated;
        for (const row of any.rows) {
          if (hits.length >= limit) break;
          if (seen.has(row.id)) continue;
          hits.push({ ...row, tier: 'any' });
        }
      }
    }
    return { hits, truncated };
  }

  private matchTier(
    expression: string,
    filters: ArchiveFilters,
    now: number,
  ): { rows: ArchivedMessage[]; truncated: boolean } {
    const { clauses, params } = this.filterClauses(filters);
    const rows = this.stmt(
      `SELECT m.*, bm25(messages_fts, ${BM25_WEIGHTS}) AS bm25
       FROM messages_fts JOIN messages m ON m.seq = messages_fts.rowid
       WHERE messages_fts MATCH @match AND ${clauses.join(' AND ')}
       ORDER BY bm25 LIMIT @pool`,
    ).all({ ...params, match: expression, pool: SEARCH_POOL }) as (MessageRow & { bm25: number })[];

    const scored = rows.map((row) => {
      const ageDays = Math.max(0, now - row.created_at) / DAY_MS;
      const relevance = -row.bm25; // bm25() is negative; more negative = better
      return { row, score: relevance * (1 + RECENCY_BOOST * Math.exp(-ageDays / RECENCY_DAYS)) };
    });
    scored.sort((a, b) => b.score - a.score || b.row.created_at - a.row.created_at);
    return { rows: scored.map((s) => toMessage(s.row)), truncated: rows.length >= SEARCH_POOL };
  }

  /** The most recent `limit` messages matching the filters (returned oldest first) plus the total count. */
  listRecent(filters: ArchiveFilters, limit: number): { messages: ArchivedMessage[]; total: number } {
    const { clauses, params } = this.filterClauses(filters);
    const where = clauses.join(' AND ');
    const rows = this.stmt(
      `SELECT m.* FROM messages m WHERE ${where} ORDER BY m.created_at DESC, length(m.id) DESC, m.id DESC LIMIT @limit`,
    ).all({ ...params, limit }) as MessageRow[];
    const total = (this.stmt(`SELECT COUNT(*) AS n FROM messages m WHERE ${where}`).get(params) as { n: number }).n;
    return { messages: rows.reverse().map(toMessage), total };
  }

  private filterClauses(filters: ArchiveFilters): { clauses: string[]; params: Record<string, string | number> } {
    const clauses = ['m.deleted_at IS NULL'];
    const params: Record<string, string | number> = {};
    if (filters.botOnly) {
      clauses.push("m.source = 'bot'");
    } else if (filters.authorIds || filters.authorNames) {
      params.authorIds = JSON.stringify(filters.authorIds ?? []);
      params.authorNames = JSON.stringify((filters.authorNames ?? []).map((n) => n.toLowerCase()));
      clauses.push(
        `(m.author_id IN (SELECT value FROM json_each(@authorIds))
          OR (m.author_id IS NULL AND lower(m.author_name) IN (SELECT value FROM json_each(@authorNames))))`,
      );
    }
    if (filters.channelIds) {
      params.channelIds = JSON.stringify(filters.channelIds);
      clauses.push(
        `(m.channel_id IN (SELECT value FROM json_each(@channelIds))
          OR m.parent_channel_id IN (SELECT value FROM json_each(@channelIds)))`,
      );
    }
    if (filters.allowedChannelIds) {
      params.allowedChannelIds = JSON.stringify(filters.allowedChannelIds);
      clauses.push('m.channel_id IN (SELECT value FROM json_each(@allowedChannelIds))');
    }
    if (filters.afterMs !== undefined) {
      params.afterMs = filters.afterMs;
      clauses.push('m.created_at >= @afterMs');
    }
    if (filters.beforeMs !== undefined) {
      params.beforeMs = filters.beforeMs;
      clauses.push('m.created_at < @beforeMs');
    }
    return { clauses, params };
  }

  getChannel(id: string): ArchivedChannel | undefined {
    const row = this.stmt('SELECT * FROM channels WHERE id = ?').get(id) as
      | {
          id: string;
          guild_id: string | null;
          name: string;
          parent_id: string | null;
          type: number;
          updated_at: number;
        }
      | undefined;
    return row
      ? {
          id: row.id,
          guildId: row.guild_id,
          name: row.name,
          parentId: row.parent_id,
          type: row.type,
          updatedAt: row.updated_at,
        }
      : undefined;
  }

  listChannels(): ArchivedChannel[] {
    const rows = this.stmt('SELECT * FROM channels ORDER BY name').all() as {
      id: string;
      guild_id: string | null;
      name: string;
      parent_id: string | null;
      type: number;
      updated_at: number;
    }[];
    return rows.map((row) => ({
      id: row.id,
      guildId: row.guild_id,
      name: row.name,
      parentId: row.parent_id,
      type: row.type,
      updatedAt: row.updated_at,
    }));
  }

  /** Distinct (author_id, author_name) pairs whose name matches, for resolving people the identity table lacks. */
  findAuthorsByName(name: string, mode: 'exact' | 'substring'): { authorId: string | null; authorName: string }[] {
    const needle = name.toLowerCase();
    const sql =
      mode === 'exact'
        ? `SELECT DISTINCT author_id, author_name FROM messages
           WHERE source != 'bot' AND lower(author_name) = ? LIMIT 20`
        : `SELECT DISTINCT author_id, author_name FROM messages
           WHERE source != 'bot' AND instr(lower(author_name), ?) > 0 LIMIT 20`;
    const rows = this.stmt(sql).all(needle) as { author_id: string | null; author_name: string }[];
    return rows.map((r) => ({ authorId: r.author_id, authorName: r.author_name }));
  }

  /** Oldest archived message of a channel (deleted included: it still marks how far the archive reaches). */
  oldestMessage(channelId: string): { id: string; createdAt: number } | undefined {
    const row = this.stmt(
      `SELECT id, created_at FROM messages WHERE channel_id = ?
       ORDER BY created_at ASC, length(id) ASC, id ASC LIMIT 1`,
    ).get(channelId) as { id: string; created_at: number } | undefined;
    return row ? { id: row.id, createdAt: row.created_at } : undefined;
  }

  newestMessage(channelId: string): { id: string; createdAt: number } | undefined {
    const row = this.stmt(
      `SELECT id, created_at FROM messages WHERE channel_id = ?
       ORDER BY created_at DESC, length(id) DESC, id DESC LIMIT 1`,
    ).get(channelId) as { id: string; created_at: number } | undefined;
    return row ? { id: row.id, createdAt: row.created_at } : undefined;
  }

  /** Every channel with at least one archived message, with its newest message id. */
  channelsWithHistory(): { channelId: string; newestId: string; newestAt: number }[] {
    const channels = this.stmt(
      'SELECT channel_id, MAX(created_at) AS newest_at FROM messages GROUP BY channel_id',
    ).all() as {
      channel_id: string;
      newest_at: number;
    }[];
    const result: { channelId: string; newestId: string; newestAt: number }[] = [];
    for (const c of channels) {
      const newest = this.newestMessage(c.channel_id);
      if (newest) result.push({ channelId: c.channel_id, newestId: newest.id, newestAt: newest.createdAt });
    }
    return result;
  }

  /** True when nothing has been archived yet (cheaper than counting a large archive). */
  isEmpty(): boolean {
    return this.stmt('SELECT 1 FROM messages LIMIT 1').get() === undefined;
  }

  countMessages(channelId?: string): number {
    const row = channelId
      ? (this.stmt('SELECT COUNT(*) AS n FROM messages WHERE channel_id = ?').get(channelId) as { n: number })
      : (this.stmt('SELECT COUNT(*) AS n FROM messages').get() as { n: number });
    return row.n;
  }

  /** Timestamp of the oldest archived message anywhere, for "the archive reaches back to …". */
  oldestTimestamp(): number | undefined {
    const row = this.stmt('SELECT MIN(created_at) AS t FROM messages').get() as { t: number | null };
    return row.t ?? undefined;
  }

  /** Database size in bytes (page_count × page_size; excludes the WAL). */
  sizeBytes(): number {
    const pages = this.db.pragma('page_count', { simple: true }) as number;
    const pageSize = this.db.pragma('page_size', { simple: true }) as number;
    return pages * pageSize;
  }

  // ---------------------------------------------------------------- backfill state

  getBackfillState(channelId: string): BackfillState | undefined {
    const row = this.stmt('SELECT * FROM backfill_state WHERE channel_id = ?').get(channelId) as
      | BackfillRow
      | undefined;
    return row ? toBackfillState(row) : undefined;
  }

  listBackfillStates(): BackfillState[] {
    return (this.stmt('SELECT * FROM backfill_state').all() as BackfillRow[]).map(toBackfillState);
  }

  /**
   * Stores one backfilled page and advances the channel's cursor in the same transaction, so a crash
   * between the two can never skip a page (at worst a page is fetched again and upserted as a no-op).
   * Returns how many of the page's messages were new to the archive.
   */
  saveBackfillPage(
    channelId: string,
    inputs: ArchiveMessageInput[],
    page: { cursorId: string | null; cursorAt: number | null; fetched: number; done: boolean },
    now = Date.now(),
  ): number {
    return this.db.transaction(() => {
      const added = this.upsertMessages(inputs);
      this.stmt(
        `INSERT INTO backfill_state (channel_id, cursor_id, cursor_at, done, pages, fetched, updated_at)
         VALUES (@channelId, @cursorId, @cursorAt, @done, 1, @fetched, @now)
         ON CONFLICT(channel_id) DO UPDATE SET
           cursor_id = COALESCE(excluded.cursor_id, backfill_state.cursor_id),
           cursor_at = COALESCE(excluded.cursor_at, backfill_state.cursor_at),
           done = excluded.done,
           pages = backfill_state.pages + 1,
           fetched = backfill_state.fetched + excluded.fetched,
           last_error = NULL,
           error_at = NULL,
           updated_at = excluded.updated_at`,
      ).run({
        channelId,
        cursorId: page.cursorId,
        cursorAt: page.cursorAt,
        done: page.done ? 1 : 0,
        fetched: page.fetched,
        now,
      });
      return added;
    })();
  }

  recordBackfillError(channelId: string, error: string, now = Date.now()): void {
    this.stmt(
      `INSERT INTO backfill_state (channel_id, done, last_error, error_at, updated_at) VALUES (?, 0, ?, ?, ?)
       ON CONFLICT(channel_id) DO UPDATE SET last_error = excluded.last_error, error_at = excluded.error_at,
         updated_at = excluded.updated_at`,
    ).run(channelId, error.slice(0, 500), now, now);
  }

  /** Runs FTS5's own consistency check against the content table; throws when the index is corrupt. */
  checkFtsIntegrity(): void {
    this.db.prepare("INSERT INTO messages_fts(messages_fts, rank) VALUES('integrity-check', 1)").run();
  }

  /** Rebuilds the whole FTS index from the messages table (exact because every row is indexed). */
  rebuildFtsIndex(): void {
    this.db.prepare("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')").run();
  }

  optimize(): void {
    try {
      this.db.pragma('optimize');
    } catch (error) {
      logger.warn('archive: PRAGMA optimize failed:', error);
    }
  }
}

let archiveStore: ArchiveStore | undefined;

export function getArchiveStore(): ArchiveStore {
  if (!archiveStore) {
    // Structural test hermeticity, like memory.db and bot.db: Vitest never opens the real file.
    archiveStore = config.isTest ? new ArchiveStore(':memory:') : new ArchiveStore();
  }
  return archiveStore;
}

/** Test-only: points the shared archive at an isolated instance (e.g. `new ArchiveStore(':memory:')`). */
export function setArchiveStoreForTesting(store: ArchiveStore | undefined): void {
  archiveStore = store;
}

/** Closes the shared archive (shutdown). Safe to call when it was never opened. */
export function closeArchiveStore(): void {
  if (!archiveStore) return;
  try {
    archiveStore.close();
  } finally {
    archiveStore = undefined;
  }
}

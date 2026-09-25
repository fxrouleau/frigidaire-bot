// Persistent media results in bot.db: voice transcripts keyed by Discord message id, and video
// descriptions keyed by a normalized URL. A transcript produced once — by the auto-transcript reply,
// or by the chat agent hearing a voice message — is reused for free by every later reader (history
// rendering, the learner, summaries). Best-effort like the relay registry: a database failure is
// logged and treated as a cache miss, never as a failed transcription.
import { logger } from '../../logger';
import { getBotDb } from '../../storage/botDb';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS transcripts (
    message_id TEXT    PRIMARY KEY,
    text       TEXT    NOT NULL,
    model      TEXT    NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS video_descriptions (
    url_key     TEXT    PRIMARY KEY,
    description TEXT    NOT NULL,
    model       TEXT    NOT NULL,
    created_at  INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS video_answers (
    url_key      TEXT    NOT NULL,
    question_key TEXT    NOT NULL,
    question     TEXT    NOT NULL,
    answer       TEXT    NOT NULL,
    model        TEXT    NOT NULL,
    created_at   INTEGER NOT NULL,
    PRIMARY KEY (url_key, question_key)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS transcript_replies (
    reply_id   TEXT    PRIMARY KEY,
    message_id TEXT    NOT NULL,
    created_at INTEGER NOT NULL
  );
`;

function db() {
  const botDb = getBotDb();
  botDb.ensureSchema('media', SCHEMA);
  return botDb;
}

/** A stored transcript: '' means the recording was heard and held no speech. */
export function getStoredTranscript(key: string): string | undefined {
  try {
    const row = db().stmt('SELECT text FROM transcripts WHERE message_id = ?').get(key) as { text: string } | undefined;
    return row?.text;
  } catch (error) {
    logger.warn('media: transcript lookup failed:', error);
    return undefined;
  }
}

export function storeTranscript(key: string, text: string, model: string, now = Date.now()): void {
  try {
    db()
      .stmt(
        `INSERT INTO transcripts (message_id, text, model, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(message_id) DO UPDATE SET text = excluded.text, model = excluded.model, created_at = excluded.created_at`,
      )
      .run(key, text, model, now);
  } catch (error) {
    logger.warn(`media: failed to store the transcript for ${key}:`, error);
  }
}

export function getStoredVideoDescription(key: string): string | undefined {
  try {
    const row = db().stmt('SELECT description FROM video_descriptions WHERE url_key = ?').get(key) as
      | { description: string }
      | undefined;
    return row?.description;
  } catch (error) {
    logger.warn('media: video description lookup failed:', error);
    return undefined;
  }
}

export function storeVideoDescription(key: string, description: string, model: string, now = Date.now()): void {
  try {
    db()
      .stmt(
        `INSERT INTO video_descriptions (url_key, description, model, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(url_key) DO UPDATE SET description = excluded.description, model = excluded.model,
           created_at = excluded.created_at`,
      )
      .run(key, description, model, now);
  } catch (error) {
    logger.warn('media: failed to store a video description:', error);
  }
}

// Answers to specific questions about a clip ("what does he say at the end?"), so asking the same thing
// twice — or the chat model re-asking on the next turn — is free. The key is the normalized question:
// case, spacing and trailing punctuation don't make a new question.
export function questionKey(question: string): string {
  return question
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[\s?!.…]+$/u, '')
    .trim()
    .slice(0, 500);
}

export function getStoredVideoAnswer(urlKey: string, question: string): string | undefined {
  try {
    const row = db()
      .stmt('SELECT answer FROM video_answers WHERE url_key = ? AND question_key = ?')
      .get(urlKey, questionKey(question)) as { answer: string } | undefined;
    return row?.answer;
  } catch (error) {
    logger.warn('media: video answer lookup failed:', error);
    return undefined;
  }
}

export function storeVideoAnswer(
  urlKey: string,
  question: string,
  answer: string,
  model: string,
  now = Date.now(),
): void {
  try {
    db()
      .stmt(
        `INSERT INTO video_answers (url_key, question_key, question, answer, model, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(url_key, question_key) DO UPDATE SET question = excluded.question, answer = excluded.answer,
           model = excluded.model, created_at = excluded.created_at`,
      )
      .run(urlKey, questionKey(question), question.slice(0, 1000), answer, model, now);
  } catch (error) {
    logger.warn('media: failed to store a video answer:', error);
  }
}

// The bot's own transcript replies, by Discord message id, so a member's reply to one can be told apart
// from a reply to the bot without fetching the replied-to message. Rows older than this are pruned:
// by then nobody replies to a transcript (and a fetched one is still recognized by its header).
const TRANSCRIPT_REPLY_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export function rememberTranscriptReply(replyId: string, messageId: string, now = Date.now()): void {
  try {
    const botDb = db();
    botDb
      .stmt('INSERT OR REPLACE INTO transcript_replies (reply_id, message_id, created_at) VALUES (?, ?, ?)')
      .run(replyId, messageId, now);
    botDb.stmt('DELETE FROM transcript_replies WHERE created_at < ?').run(now - TRANSCRIPT_REPLY_RETENTION_MS);
  } catch (error) {
    logger.warn(`media: failed to record transcript reply ${replyId}:`, error);
  }
}

export function isStoredTranscriptReply(replyId: string): boolean {
  try {
    return db().stmt('SELECT 1 FROM transcript_replies WHERE reply_id = ?').get(replyId) !== undefined;
  } catch (error) {
    logger.warn('media: transcript reply lookup failed:', error);
    return false;
  }
}

// Discord CDN attachment URLs carry expiring signature parameters (ex/is/hm) and the same file is
// served from two hosts; the path alone identifies it. Any other URL keeps its query, which is often
// part of the file's identity.
const DISCORD_CDN_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net']);

export function mediaCacheKey(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    if (DISCORD_CDN_HOSTS.has(parsed.hostname)) {
      parsed.hostname = 'cdn.discordapp.com';
      parsed.search = '';
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

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

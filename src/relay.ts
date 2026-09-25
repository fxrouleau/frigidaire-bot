// Messages the bot posted through a webhook on a member's behalf: link-fix reposts and deleted-message
// reposts. Discord marks every webhook message as bot-authored, and the bot deletes each webhook right
// after posting, so without this registry nothing downstream (learner, summaries, archive, search) can
// tell a relayed human message from another integration's bot post, or know who actually wrote it.
import type { Message } from 'discord.js';
import { getMemoryStore } from './ai/memory';
import { nameKey } from './ai/memory/memoryStore';
import { canonicalUserId } from './linkedAccounts';
import { logger } from './logger';
import { getBotDb } from './storage/botDb';

export type RelayKind = 'link_fix' | 'regret';

export type RelayRecord = {
  messageId: string;
  channelId: string;
  authorId: string;
  authorName: string;
  kind: RelayKind;
  createdAt: number;
};

type RelayRow = {
  message_id: string;
  channel_id: string;
  author_id: string;
  author_name: string;
  kind: RelayKind;
  created_at: number;
};

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS relayed_messages (
    message_id  TEXT    PRIMARY KEY,
    channel_id  TEXT    NOT NULL,
    author_id   TEXT    NOT NULL,
    author_name TEXT    NOT NULL,
    kind        TEXT    NOT NULL,
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_relayed_messages_author ON relayed_messages(author_id);
`;

function db() {
  const botDb = getBotDb();
  botDb.ensureSchema('relayed_messages', SCHEMA);
  return botDb;
}

function toRecord(row: RelayRow): RelayRecord {
  return {
    messageId: row.message_id,
    channelId: row.channel_id,
    authorId: row.author_id,
    authorName: row.author_name,
    kind: row.kind,
    createdAt: row.created_at,
  };
}

/** Records a relayed message. Best-effort: a failure is logged and never breaks the repost itself. */
export function recordRelay(record: Omit<RelayRecord, 'createdAt'> & { createdAt?: number }): void {
  try {
    db()
      .stmt(
        `INSERT INTO relayed_messages (message_id, channel_id, author_id, author_name, kind, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(message_id) DO NOTHING`,
      )
      .run(
        record.messageId,
        record.channelId,
        record.authorId,
        record.authorName,
        record.kind,
        record.createdAt ?? Date.now(),
      );
  } catch (error) {
    logger.warn(`relay: failed to record relayed message ${record.messageId}:`, error);
  }
}

export function getRelay(messageId: string): RelayRecord | undefined {
  try {
    const row = db().stmt('SELECT * FROM relayed_messages WHERE message_id = ?').get(messageId) as RelayRow | undefined;
    return row ? toRecord(row) : undefined;
  } catch (error) {
    logger.warn('relay: lookup failed:', error);
    return undefined;
  }
}

/** Bulk lookup; ids without a record are simply absent from the map. */
export function getRelays(messageIds: string[]): Map<string, RelayRecord> {
  const result = new Map<string, RelayRecord>();
  if (messageIds.length === 0) return result;
  try {
    const rows = db()
      .stmt('SELECT * FROM relayed_messages WHERE message_id IN (SELECT value FROM json_each(?))')
      .all(JSON.stringify(messageIds)) as RelayRow[];
    for (const row of rows) result.set(row.message_id, toRecord(row));
  } catch (error) {
    logger.warn('relay: bulk lookup failed:', error);
  }
  return result;
}

/** Who a message should be attributed to when it is shown to a model or indexed. */
export type MessageAttribution = {
  /** Discord user id of the real author; undefined when only a name is known. */
  authorId?: string;
  authorName: string;
  /** 'relay' = the bot's own webhook post on a member's behalf; 'human' = a regular member message. */
  source: 'human' | 'relay';
};

/**
 * Attributes a message to a person, or returns undefined for messages that should be treated as
 * non-human (other bots, other integrations' webhooks, the bot's own replies).
 *
 * The person is always their MAIN account (LINKED_ACCOUNTS): a message from a side account is
 * attributed to the main account's id, under the main account's current display name when the bot
 * knows it, so memories, the learner, summaries and the archive see one person.
 *
 * Relayed messages resolve through the registry first. Older relays (posted before the registry
 * existed) fall back to a heuristic: a webhook message owned by this bot's application whose webhook
 * name matches exactly one known member's display or canonical name. Discord stamps `applicationId` on
 * messages from application-owned webhooks, which is what tells the bot's relays apart from other webhooks.
 */
export function attributeMessage(message: Message): MessageAttribution | undefined {
  if (!message.webhookId) {
    if (message.author.bot) return undefined;
    const liveName = message.member?.displayName || message.author.displayName || message.author.username;
    const authorId = canonicalUserId(message.author.id);
    const authorName = authorId === message.author.id ? liveName : (currentName(authorId) ?? liveName);
    return { authorId, authorName, source: 'human' };
  }

  const relay = getRelay(message.id);
  if (relay) {
    // The registry keeps the account the original was posted from; the person is its main account.
    const authorId = canonicalUserId(relay.authorId);
    return { authorId, authorName: currentName(authorId) ?? relay.authorName, source: 'relay' };
  }

  const ownApplicationId = message.client?.application?.id ?? message.client?.user?.id;
  const ownWebhook = Boolean(ownApplicationId) && message.applicationId === ownApplicationId;
  if (!ownWebhook) return undefined;

  const webhookName = message.author.username;
  const authorId = findMemberByWebhookName(webhookName);
  return {
    authorId,
    authorName: (authorId ? currentName(authorId) : undefined) ?? webhookName,
    source: 'relay',
  };
}

function currentName(userId: string): string | undefined {
  try {
    return getMemoryStore().getIdentityById(userId)?.display_name;
  } catch {
    return undefined;
  }
}

/** The main account id of the one member whose display or first-seen name is `name` (any of their accounts). */
function findMemberByWebhookName(name: string): string | undefined {
  try {
    const needle = nameKey(name);
    const owners = new Set(
      getMemoryStore()
        .getAllIdentities()
        .filter((i) => nameKey(i.display_name) === needle || nameKey(i.canonical_name) === needle)
        .map((i) => canonicalUserId(i.discord_user_id)),
    );
    return owners.size === 1 ? [...owners][0] : undefined;
  } catch {
    return undefined;
  }
}

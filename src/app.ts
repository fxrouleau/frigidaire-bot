import * as fs from 'node:fs';
import * as path from 'node:path';
import process from 'node:process';
import { Client, GatewayIntentBits } from 'discord.js';
import * as dotenv from 'dotenv';
import { getConversationPersistence } from './ai/conversationPersistence';
import { personalityLearner } from './ai/learnerInstance';
import { getMemoryStore } from './ai/tools';
import { logger } from './logger';

dotenv.config();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildEmojisAndStickers,
    GatewayIntentBits.GuildMessageReactions,
  ],
});

const eventsPath = path.join(__dirname, 'events');
const eventFiles = fs
  .readdirSync(eventsPath)
  .filter((file) => (file.endsWith('.ts') || file.endsWith('.js')) && !file.includes('.test.'));

for (const file of eventFiles) {
  const filePath = path.join(eventsPath, file);
  const event = require(filePath);
  if (event.once) {
    client.once(event.name, (...args) => event.execute(...args));
  } else {
    client.on(event.name, (...args) => event.execute(...args));
  }
}

// Run memory compaction on startup
try {
  const store = getMemoryStore();
  const result = store.compact();
  if (result.removed > 0) {
    logger.info(`Memory compaction on startup: removed ${result.removed} duplicate memories.`);
  }
} catch (error) {
  logger.warn('Memory compaction on startup failed:', error);
}

// Embedding backfill: once at startup, then periodically. The periodic re-run is the self-heal for
// memories saved while the embeddings API was down (they stay vector-less and invisible to gated
// semantic search until a backfill picks them up) and for EMBEDDING_MODEL switches.
try {
  const store = getMemoryStore();
  const backfillIntervalMs = Number(process.env.BACKFILL_INTERVAL_MS) || 30 * 60 * 1000;

  const runBackfill = () =>
    void store
      .backfillEmbeddings()
      .then((bf) => {
        if (bf.embedded + bf.reembedded > 0 || bf.failed > 0) {
          logger.info(`Backfilled embeddings: ${bf.embedded} new, ${bf.reembedded} re-embedded, ${bf.failed} failed.`);
        }
      })
      .catch((error) => logger.warn('Embedding backfill failed:', error));

  runBackfill();
  // unref(): the interval must never keep the process alive on its own.
  setInterval(() => {
    // Ephemeral TTL sweep before backfill: expired memories never waste embed calls.
    // (Startup expiry already happens via compact() above; the sweep logs its own counts.)
    try {
      store.sweepExpiredMemories();
    } catch (error) {
      logger.warn('Ephemeral memory sweep failed:', error);
    }
    runBackfill();
  }, backfillIntervalMs).unref();
} catch (error) {
  logger.warn('Embedding backfill setup failed:', error);
}

// Start personality learner after Discord client is ready
client.once('ready', () => {
  personalityLearner.start(client);
});

client.login(process.env.CLIENT_SECRET);

// Graceful shutdown: the bot redeploys on every master merge (SIGTERM from Docker). Flush/close both
// SQLite handles and the Discord connection so the next boot reads a clean WAL. Idempotent — a second
// signal during shutdown is ignored.
let shuttingDown = false;
const shutdown = (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`Received ${signal}, shutting down.`);
  try {
    getMemoryStore().close();
  } catch (error) {
    logger.warn('Closing memory store on shutdown failed:', error);
  }
  try {
    getConversationPersistence().close();
  } catch (error) {
    logger.warn('Closing conversation persistence on shutdown failed:', error);
  }
  void client.destroy();
  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

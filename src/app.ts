import * as fs from 'node:fs';
import * as path from 'node:path';
import * as process from 'node:process';
import { Client, GatewayIntentBits } from 'discord.js';
import * as dotenv from 'dotenv';
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
  setInterval(runBackfill, backfillIntervalMs).unref();
} catch (error) {
  logger.warn('Embedding backfill setup failed:', error);
}

// Start personality learner after Discord client is ready
client.once('ready', () => {
  personalityLearner.start(client);
});

client.login(process.env.CLIENT_SECRET);

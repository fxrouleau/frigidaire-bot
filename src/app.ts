import * as fs from 'node:fs';
import * as path from 'node:path';
import process from 'node:process';
import { type ClientEvents, Events } from 'discord.js';
import * as dotenv from 'dotenv';
import { getConversationPersistence } from './ai/conversationPersistence';
import { personalityLearner } from './ai/learnerInstance';
import { getMemoryStore } from './ai/memory';
import { closeArchiveStore } from './archive/archiveStore';
import { config, describeEffectiveConfig } from './config';
import { createDiscordClient } from './discordClient';
import { resolveEventModule } from './eventModule';
import { logger } from './logger';
import { getBotDb } from './storage/botDb';

dotenv.config({ quiet: true });

logger.info(`Effective config: ${describeEffectiveConfig()}`);

// A rejected promise nobody awaited must never take the process down (Node turns it into an
// uncaught exception by default). Event handlers are already dispatched behind a catch below; this
// covers everything else (timers, fire-and-forget maintenance).
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection:', reason);
});

// Intents + partials live in discordClient.ts (partials: events for messages sent before the last restart).
const client = createDiscordClient();

// Every file in src/events/ is an event handler (see src/eventModule.ts). Each one runs behind a
// dispatcher that logs a throwing/rejecting handler instead of letting it crash the bot — a missing
// permission in one channel used to be enough to take the whole process down.
const eventsPath = path.join(__dirname, 'events');
const eventFiles = fs
  .readdirSync(eventsPath)
  .filter((file) => (file.endsWith('.ts') || file.endsWith('.js')) && !file.includes('.test.'));

for (const file of eventFiles) {
  const event = resolveEventModule(require(path.join(eventsPath, file)));
  if (!event) {
    throw new Error(`src/events/${file} does not export an event module (use defineEvent()).`);
  }

  const dispatch = (...args: ClientEvents[keyof ClientEvents]) => {
    Promise.resolve()
      .then(() => (event.execute as (...a: unknown[]) => unknown)(...args))
      .catch((error) => logger.error(`Event handler ${file} (${event.name}) failed:`, error));
  };

  if (event.once) {
    client.once(event.name, dispatch);
  } else {
    client.on(event.name, dispatch);
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

// Link name-only memories to member ids (idempotent; logs its own counts).
try {
  getMemoryStore().stampSubjectUserIds();
} catch (error) {
  logger.warn('Memory subject-id stamp on startup failed:', error);
}

// Embedding backfill: once at startup, then periodically. The periodic re-run is the self-heal for
// memories saved while the embeddings API was down (they stay vector-less and invisible to gated
// semantic search until a backfill picks them up) and for EMBEDDING_MODEL switches.
try {
  const store = getMemoryStore();

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
  }, config.memory.backfillIntervalMs).unref();
} catch (error) {
  logger.warn('Embedding backfill setup failed:', error);
}

// Start personality learner after Discord client is ready
client.once(Events.ClientReady, () => {
  personalityLearner.start(client);
});

// A missing or rejected token is a configuration error: fail fast and loudly (the unhandledRejection
// handler above would otherwise turn it into a log line and a process that quietly sits there).
if (!config.discord.token) {
  logger.error('CLIENT_SECRET is not set; the bot cannot log in.');
  process.exit(1);
}
client.login(config.discord.token).catch((error) => {
  logger.error('Discord login failed:', error);
  process.exit(1);
});

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
  try {
    getBotDb().close();
  } catch (error) {
    logger.warn('Closing bot database on shutdown failed:', error);
  }
  try {
    closeArchiveStore();
  } catch (error) {
    logger.warn('Closing the message archive on shutdown failed:', error);
  }
  void client.destroy();
  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

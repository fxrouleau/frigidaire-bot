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
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

const eventsPath = path.join(__dirname, 'events');
const eventFiles = fs.readdirSync(eventsPath).filter((file) => file.endsWith('.ts') || file.endsWith('.js'));

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

// Start personality learner after Discord client is ready
client.once('ready', () => {
  personalityLearner.start(client);
});

client.login(process.env.CLIENT_SECRET);

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as process from 'node:process';
import { Client, GatewayIntentBits } from 'discord.js';
import * as dotenv from 'dotenv';
import { logger } from './logger';

dotenv.config();

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

const eventsPath = path.join(__dirname, 'events');
const eventFiles = fs.readdirSync(eventsPath).filter((file) => file.endsWith('.ts') || file.endsWith('.js'));

for (const file of eventFiles) {
  // Conditionally skip loading the OpenAI event if the API key is not set
  if (file.startsWith('openai.') && !process.env.OPENAI_API_KEY) {
    logger.info('OpenAI functionality is disabled. Skipping event handler.');
    continue;
  }

  const filePath = path.join(eventsPath, file);
  const event = require(filePath);
  if (event.once) {
    client.once(event.name, (...args) => event.execute(...args));
  } else {
    client.on(event.name, (...args) => event.execute(...args));
  }
}
client.login(process.env.CLIENT_SECRET);

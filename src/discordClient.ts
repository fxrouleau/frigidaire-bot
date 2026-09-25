// The Discord client's construction options, kept out of app.ts (which logs in on import) so the
// partials contract can be tested.
import { Client, type ClientOptions, GatewayIntentBits, Partials } from 'discord.js';

export const DISCORD_INTENTS: readonly GatewayIntentBits[] = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.MessageContent,
  GatewayIntentBits.GuildEmojisAndStickers,
  GatewayIntentBits.GuildMessageReactions,
];

// Every deploy restarts the bot with an empty message cache. Without partials, discord.js silently drops
// reaction, delete and update events for any message it has not cached, i.e. everything sent before the
// last restart. With them, those events fire with a partial structure (ids always present; content,
// author and counts possibly missing), so handlers of MessageReactionAdd/Remove, MessageDelete and
// MessageUpdate must check `.partial` (or `fetch()`) before reading anything but ids.
//   - Message: reactions/deletes/updates on uncached messages
//   - Reaction: reactions on uncached messages (the reaction itself is then partial: count is null)
//   - User: reactors not in the user cache (guild reaction adds carry the member, removes do not)
//   - Channel: events in channels discord.js has not cached (DM channels; guild channels are cached)
export const DISCORD_PARTIALS: readonly Partials[] = [
  Partials.Message,
  Partials.Channel,
  Partials.Reaction,
  Partials.User,
];

export function discordClientOptions(): ClientOptions {
  return { intents: [...DISCORD_INTENTS], partials: [...DISCORD_PARTIALS] };
}

export function createDiscordClient(): Client {
  return new Client(discordClientOptions());
}

import { GatewayIntentBits, Partials } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { discordClientOptions } from './discordClient';

describe('discordClientOptions', () => {
  it('enables the partials that let reaction/delete/update events fire for messages sent before a restart', () => {
    const { partials } = discordClientOptions();
    expect(partials).toEqual(
      expect.arrayContaining([Partials.Message, Partials.Channel, Partials.Reaction, Partials.User]),
    );
  });

  it('keeps the intents every feature relies on', () => {
    expect(discordClientOptions().intents).toEqual([
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildEmojisAndStickers,
      GatewayIntentBits.GuildMessageReactions,
    ]);
  });

  it('returns fresh arrays so a caller cannot mutate the shared lists', () => {
    const first = discordClientOptions();
    (first.partials as Partials[]).push(Partials.GuildMember);
    expect(discordClientOptions().partials).not.toContain(Partials.GuildMember);
  });
});

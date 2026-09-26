import { Client, GatewayIntentBits, MessagePayload, Partials } from 'discord.js';
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

describe('default allowed mentions', () => {
  // resolveBody reads only `client` from a plain (non-webhook, non-interaction) target.
  function resolvedAllowedMentions(options: ConstructorParameters<typeof MessagePayload>[1]): unknown {
    const client = new Client(discordClientOptions());
    try {
      const target = { client } as unknown as ConstructorParameters<typeof MessagePayload>[0];
      const payload = new MessagePayload(target, options).resolveBody();
      return (payload.body as { allowed_mentions?: unknown }).allowed_mentions;
    } finally {
      void client.destroy();
    }
  }

  it('lets bot posts ping users and the replied-to author, never @everyone/@here or roles', () => {
    expect(discordClientOptions().allowedMentions).toEqual({ parse: ['users'], repliedUser: true });
  });

  it('is what a send without its own allowedMentions resolves to (a plain-string chat reply)', () => {
    expect(resolvedAllowedMentions({ content: '@everyone look <@&123456789012345678>' })).toEqual({
      parse: ['users'],
      replied_user: true,
    });
  });

  it('still yields to a send that passes its own allowedMentions', () => {
    expect(resolvedAllowedMentions({ content: 'hi', allowedMentions: { parse: [] } })).toEqual({ parse: [] });
  });
});

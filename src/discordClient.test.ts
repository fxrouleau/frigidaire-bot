import { Client, GatewayIntentBits, MessagePayload, Partials, type TextChannel } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { discordClientOptions } from './discordClient';

/** The allowed_mentions discord.js would put on the wire for `options` sent by a client built with our options. */
async function wireAllowedMentions(options: Parameters<typeof MessagePayload.create>[1]): Promise<unknown> {
  const client = new Client(discordClientOptions());
  try {
    // Any send target works: discord.js reads the default off `target.client.options`.
    const target = { client } as unknown as TextChannel;
    const body = MessagePayload.create(target, options).resolveBody().body as { allowed_mentions?: unknown } | null;
    return body?.allowed_mentions;
  } finally {
    await client.destroy();
  }
}

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

  it('never lets a send that sets no allowedMentions ping @everyone, @here or roles', async () => {
    // The chat agent replies with the model's text as a bare string: this default is all that stands
    // between "@everyone lol" in a reply and a server-wide ping.
    expect(discordClientOptions().allowedMentions).toEqual({ parse: ['users'], repliedUser: true });
    expect(await wireAllowedMentions('@everyone @here <@&123> lol')).toEqual({ parse: ['users'], replied_user: true });
    expect(await wireAllowedMentions({ content: '@everyone', files: [] })).toEqual({
      parse: ['users'],
      replied_user: true,
    });
  });

  it("keeps a send's own allowedMentions", async () => {
    expect(await wireAllowedMentions({ content: 'hi <@1>', allowedMentions: { parse: [] } })).toEqual({ parse: [] });
  });
});

import { RESTJSONErrorCodes } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../../logger';
import { createFakeMessage } from '../../test-support/fakeDiscord';
import { FakeProvider } from '../../test-support/fakeProvider';
import { setMemoryStoreForTesting } from '../memory';
import { MemoryStore } from '../memory/memoryStore';
import type { ToolHandlerContext, TurnEffects } from '../types';
import { createTurnEffects } from '../types';
import { MAX_REACTIONS_PER_TURN, reactTools, resolveReactionEmoji } from './react';

const reactTool = reactTools[0];

function context(fake = createFakeMessage({ content: 'thanks fridge' }), turn: TurnEffects = createTurnEffects()) {
  const ctx: ToolHandlerContext = {
    message: fake.message,
    provider: new FakeProvider([]),
    channelId: fake.message.channel.id,
    turn,
  };
  return { ctx, fake, turn };
}

function discordError(code: number): Error {
  return Object.assign(new Error(`Discord error ${code}`), { code });
}

let store: MemoryStore;

beforeEach(() => {
  store = new MemoryStore(':memory:');
  store.upsertEmoji({ id: '111', name: 'KEKW', animated: false });
  store.upsertEmoji({ id: '222', name: 'catJam', animated: true });
  store.setEmojiCaption('111', 'laughing hard');
  setMemoryStoreForTesting(store);
  vi.spyOn(logger, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  setMemoryStoreForTesting(undefined);
  vi.restoreAllMocks();
});

describe('resolveReactionEmoji', () => {
  it('accepts a single unicode emoji, including skin tones, flags and ZWJ sequences', () => {
    for (const emoji of ['😂', '👍🏽', '🇨🇦', '👨‍👩‍👧', '❤️', '1️⃣']) {
      expect(resolveReactionEmoji(emoji, store.getUsableEmojis())).toEqual({ kind: 'unicode', emoji, label: emoji });
    }
  });

  it('adds the emoji variation selector to a bare text-presentation symbol', () => {
    expect(resolveReactionEmoji('❤', [])).toMatchObject({ kind: 'unicode', emoji: '❤️' });
  });

  it('resolves a server emoji by name, case-insensitively and with optional colons', () => {
    const emojis = store.getUsableEmojis();
    expect(resolveReactionEmoji('kekw', emojis)).toMatchObject({ kind: 'custom', emoji: 'KEKW:111', label: '<:KEKW:111>' });
    expect(resolveReactionEmoji(':catjam:', emojis)).toMatchObject({ emoji: 'a:catJam:222', label: '<a:catJam:222>' });
  });

  it('accepts <:name:id> syntax, falling back to the name when the id is misremembered', () => {
    const emojis = store.getUsableEmojis();
    expect(resolveReactionEmoji('<:KEKW:111>', emojis)).toMatchObject({ emoji: 'KEKW:111' });
    expect(resolveReactionEmoji('<:kekw:999>', emojis)).toMatchObject({ emoji: 'KEKW:111' });
    expect(resolveReactionEmoji('<:ghost:999>', emojis)).toBeUndefined();
  });

  it('rejects text, several emojis at once, and names the server does not have', () => {
    const emojis = store.getUsableEmojis();
    for (const input of ['', 'lol', '😂😂', 'thumbsup', '5']) {
      expect(resolveReactionEmoji(input, emojis)).toBeUndefined();
    }
  });
});

describe('react tool', () => {
  it('reacts to the triggering message and records the reaction on the turn', async () => {
    const { ctx, fake, turn } = context();

    const output = await reactTool.handler(ctx, { emoji: 'kekw' });

    expect(fake.recorders.react.calls).toEqual([['KEKW:111']]);
    expect(turn.reactions).toEqual(['<:KEKW:111>']);
    expect(output).toContain('Reacted with <:KEKW:111>');
    expect(output).toContain('end your turn without any text');
  });

  it('reacts with a unicode emoji', async () => {
    const { ctx, fake, turn } = context();
    await reactTool.handler(ctx, { emoji: '😂' });
    expect(fake.recorders.react.calls).toEqual([['😂']]);
    expect(turn.reactions).toEqual(['😂']);
  });

  it('returns a clear error with suggestions for an unknown emoji, without calling Discord', async () => {
    const { ctx, fake, turn } = context();

    const output = await reactTool.handler(ctx, { emoji: 'kek' });

    expect(output).toContain('Unknown emoji "kek"');
    expect(output).toContain('KEKW');
    expect(fake.recorders.react.calls).toHaveLength(0);
    expect(turn.reactions).toHaveLength(0);
  });

  it(`allows at most ${MAX_REACTIONS_PER_TURN} reactions per turn and skips duplicates`, async () => {
    const { ctx, fake, turn } = context();

    await reactTool.handler(ctx, { emoji: '😂' });
    expect(await reactTool.handler(ctx, { emoji: '😂' })).toContain('Already reacted');
    await reactTool.handler(ctx, { emoji: 'kekw' });
    await reactTool.handler(ctx, { emoji: 'catjam' });
    const fourth = await reactTool.handler(ctx, { emoji: '🔥' });

    expect(fourth).toContain('limit');
    expect(turn.reactions).toHaveLength(MAX_REACTIONS_PER_TURN);
    expect(fake.recorders.react.calls).toHaveLength(MAX_REACTIONS_PER_TURN);
  });

  it.each([
    [RESTJSONErrorCodes.MissingPermissions, 'Add Reactions permission'],
    [RESTJSONErrorCodes.ReactionWasBlocked, 'blocked'],
    [RESTJSONErrorCodes.MaximumNumberOfReactionsReached, 'maximum number of reactions'],
    [RESTJSONErrorCodes.UnknownEmoji, 'Unknown emoji'],
    [RESTJSONErrorCodes.UnknownMessage, 'deleted'],
  ])('turns Discord error %i into a clear message and records nothing', async (code, expected) => {
    const fake = createFakeMessage({
      content: 'thanks',
      reactImpl: async () => {
        throw discordError(code);
      },
    });
    const { ctx, turn } = context(fake);

    const output = await reactTool.handler(ctx, { emoji: '👍' });

    expect(output).toContain(expected);
    expect(turn.reactions).toHaveLength(0);
  });

  it('survives an unexpected failure with a generic message', async () => {
    const fake = createFakeMessage({
      content: 'thanks',
      reactImpl: async () => {
        throw new Error('socket hang up');
      },
    });
    const { ctx } = context(fake);
    expect(await reactTool.handler(ctx, { emoji: '👍' })).toContain("Couldn't react");
  });

  it('tells the model when to react and that questions still need text', () => {
    expect(reactTool.description).toContain('thanks');
    expect(reactTool.description).toContain('no text');
    expect(reactTool.description).toContain('Questions and requests always still get a text answer');
  });
});

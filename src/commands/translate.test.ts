import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setMemoryStoreForTesting } from '../ai/memory';
import { MemoryStore } from '../ai/memory/memoryStore';
import { BotDb, setBotDbForTesting } from '../storage/botDb';
import {
  createFakeCommandDeps,
  createFakeGuild,
  createFakeMessageCommandInteraction,
  createFakeTargetMessage,
} from '../test-support/fakeInteraction';
import { handleContextMenuCommand } from './index';
import { LINES } from './respond';
import { TRANSLATE_LINES, TRANSLATE_SYSTEM_PROMPT } from './translate';

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  setMemoryStoreForTesting(new MemoryStore(':memory:'));
  setBotDbForTesting(new BotDb(':memory:'));
});

afterEach(() => {
  setMemoryStoreForTesting(undefined);
  setBotDbForTesting(undefined);
  vi.restoreAllMocks();
});

function frenchMessage(extra: Parameters<typeof createFakeTargetMessage>[0] = {}) {
  const { guild } = createFakeGuild({ members: { 'user-7': 'Jason' } });
  return createFakeTargetMessage({
    authorId: 'user-7',
    guild,
    content: "<@9> c'est tiguidou, on se voit à soir",
    cleanContent: "@Simon c'est tiguidou, on se voit à soir",
    ...extra,
  });
}

describe('Translate', () => {
  it('translates the mention-resolved text with one model call and answers privately', async () => {
    const target = frenchMessage();
    const { interaction, responses } = createFakeMessageCommandInteraction(target.message, { commandName: 'Translate' });
    const { deps, recorders } = createFakeCommandDeps({
      complete: async () => "@Simon it's all good, see you tonight",
    });

    await handleContextMenuCommand(interaction, deps);

    expect(recorders.complete.calls).toHaveLength(1);
    const request = recorders.complete.calls[0][0];
    expect(request.system).toBe(TRANSLATE_SYSTEM_PROMPT);
    expect(request.user).toBe("<<<\n@Simon c'est tiguidou, on se voit à soir\n>>>");

    expect(responses.map((r) => [r.method, r.ephemeral])).toEqual([
      ['deferReply', true],
      ['editReply', true],
    ]);
    expect(responses[1].content).toBe("**Jason**, translated:\n> @Simon it's all good, see you tonight");
    // Nothing public.
    expect(target.recorders.reply.calls).toHaveLength(0);
    expect(target.recorders.send.calls).toHaveLength(0);
  });

  it('includes the voice message transcript and embedded post text', async () => {
    const target = frenchMessage({
      content: '',
      cleanContent: '',
      voiceMessage: true,
      mediaAttachments: [{ url: 'https://cdn/v.ogg', contentType: 'audio/ogg', duration: 4 }],
      embeds: [{ title: 'Tweet de Radio-Canada', description: 'Il neige à Montréal' }],
    });
    const { interaction } = createFakeMessageCommandInteraction(target.message, { commandName: 'Translate' });
    const { deps, recorders } = createFakeCommandDeps({
      getCachedTranscript: () => 'salut la gang',
      complete: async () => 'hi gang',
    });

    await handleContextMenuCommand(interaction, deps);

    expect(recorders.complete.calls[0][0].user).toBe(
      '<<<\n[voice message]\nsalut la gang\n\n[embedded post]\nTweet de Radio-Canada\nIl neige à Montréal\n>>>',
    );
  });

  it('says when the message is already English', async () => {
    const target = frenchMessage({ content: 'hello there', cleanContent: 'hello there' });
    const { interaction, responses } = createFakeMessageCommandInteraction(target.message, { commandName: 'Translate' });
    const { deps } = createFakeCommandDeps({ complete: async () => 'ALREADY_ENGLISH.' });

    await handleContextMenuCommand(interaction, deps);

    expect(responses.at(-1)).toMatchObject({ method: 'editReply', content: TRANSLATE_LINES.alreadyEnglish });
  });

  it('has nothing to translate on an image-only message, without calling the model', async () => {
    const target = frenchMessage({
      content: '',
      cleanContent: '',
      attachments: [{ url: 'https://cdn/pic.png', contentType: 'image/png' }],
    });
    const { interaction, responses } = createFakeMessageCommandInteraction(target.message, { commandName: 'Translate' });
    const { deps, recorders } = createFakeCommandDeps();

    await handleContextMenuCommand(interaction, deps);

    expect(recorders.complete.calls).toHaveLength(0);
    expect(responses.at(-1)).toMatchObject({ content: TRANSLATE_LINES.nothing, ephemeral: true });
  });

  it('explains a voice message it could not transcribe', async () => {
    const target = frenchMessage({
      content: '',
      cleanContent: '',
      voiceMessage: true,
      mediaAttachments: [{ url: 'https://cdn/v.ogg', contentType: 'audio/ogg' }],
    });
    const { interaction, responses } = createFakeMessageCommandInteraction(target.message, { commandName: 'Translate' });
    const { deps } = createFakeCommandDeps();

    await handleContextMenuCommand(interaction, deps);

    expect(responses.at(-1)).toMatchObject({ content: TRANSLATE_LINES.noTranscript });
  });

  it('clips huge input before sending it', async () => {
    const huge = 'mot '.repeat(5000);
    const target = frenchMessage({ content: huge, cleanContent: huge });
    const { interaction } = createFakeMessageCommandInteraction(target.message, { commandName: 'Translate' });
    const { deps, recorders } = createFakeCommandDeps({ complete: async () => 'word' });

    await handleContextMenuCommand(interaction, deps);

    expect(recorders.complete.calls[0][0].user.length).toBeLessThan(8100);
  });

  it('turns a model failure into the in-character failure line', async () => {
    const target = frenchMessage();
    const { interaction, responses } = createFakeMessageCommandInteraction(target.message, { commandName: 'Translate' });
    const { deps } = createFakeCommandDeps({
      complete: async () => {
        throw new Error('429 rate limited');
      },
    });

    await handleContextMenuCommand(interaction, deps);

    expect(responses.at(-1)).toMatchObject({ method: 'editReply', content: LINES.failed, ephemeral: true });
  });

  it('reports an empty model answer', async () => {
    const target = frenchMessage();
    const { interaction, responses } = createFakeMessageCommandInteraction(target.message, { commandName: 'Translate' });
    const { deps } = createFakeCommandDeps({ complete: async () => undefined });

    await handleContextMenuCommand(interaction, deps);

    expect(responses.at(-1)).toMatchObject({ content: TRANSLATE_LINES.emptyAnswer });
  });
});

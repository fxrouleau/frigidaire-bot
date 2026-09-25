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
import { TRANSCRIBE_LINES } from './transcribe';

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

function voiceMessage() {
  const { guild } = createFakeGuild({ members: { 'user-7': 'Jason' } });
  return createFakeTargetMessage({
    messageId: 'voice-1',
    authorId: 'user-7',
    guild,
    voiceMessage: true,
    mediaAttachments: [{ url: 'https://cdn/voice-message.ogg', contentType: 'audio/ogg', duration: 12 }],
  });
}

function postedContent(target: ReturnType<typeof createFakeTargetMessage>): string {
  return (target.recorders.reply.calls[0][0] as { content: string }).content;
}

describe('Transcribe', () => {
  it('posts the voice message transcript publicly, quoted, without pings', async () => {
    const target = voiceMessage();
    const { interaction, responses } = createFakeMessageCommandInteraction(target.message, {
      commandName: 'Transcribe',
      invokerDisplayName: 'Felix',
    });
    const { deps, recorders } = createFakeCommandDeps({ transcribeAudio: async () => 'yo @everyone come play\nnow' });

    await handleContextMenuCommand(interaction, deps);

    expect(recorders.transcribeAudio.calls[0][0]).toMatchObject({ url: 'https://cdn/voice-message.ogg', messageId: 'voice-1' });
    expect(postedContent(target)).toBe('-# transcript · asked by Felix\n> yo @everyone come play\n> now');
    expect(target.recorders.reply.calls[0][0]).toMatchObject({ allowedMentions: { parse: [], repliedUser: false } });
    expect(responses.map((r) => r.method)).toEqual(['deferReply', 'editReply']);
    expect(responses.every((r) => r.ephemeral)).toBe(true);
  });

  it('reuses a cached transcript', async () => {
    const target = voiceMessage();
    const { interaction } = createFakeMessageCommandInteraction(target.message, { commandName: 'Transcribe' });
    const { deps, recorders } = createFakeCommandDeps({ getCachedTranscript: () => 'from the cache' });

    await handleContextMenuCommand(interaction, deps);

    expect(recorders.transcribeAudio.calls).toHaveLength(0);
    expect(postedContent(target)).toContain('> from the cache');
  });

  it('describes video attachments with context, labelling each item', async () => {
    const { guild } = createFakeGuild({ members: { 'user-7': 'Jason' } });
    const target = createFakeTargetMessage({
      authorId: 'user-7',
      guild,
      content: 'look at this <@9>',
      cleanContent: 'look at this @Simon',
      mediaAttachments: [{ url: 'https://cdn/clip.mp4', contentType: 'video/mp4', name: 'clip.mp4', duration: 75 }],
    });
    const { interaction } = createFakeMessageCommandInteraction(target.message, { commandName: 'Transcribe' });
    const { deps, recorders } = createFakeCommandDeps({
      watchVideo: async () => ({ status: 'ok', text: 'A cat knocks a glass off a table.', cached: false }),
    });

    await handleContextMenuCommand(interaction, deps);

    expect(recorders.watchVideo.calls[0][0]).toEqual({
      url: 'https://cdn/clip.mp4',
      contentType: 'video/mp4',
      context: 'Shared in a Discord chat by Jason with the message: look at this @Simon',
      durationSecs: 75,
    });
    expect(postedContent(target)).toBe(
      "-# what's in it · asked by Invoker\n**clip.mp4 (1:15)**\n> A cat knocks a glass off a table.",
    );
  });

  it('skips attachments that fail and posts the rest', async () => {
    const target = createFakeTargetMessage({
      mediaAttachments: [
        { url: 'https://cdn/a.mp3', contentType: 'audio/mpeg', name: 'a.mp3' },
        { url: 'https://cdn/b.mp3', contentType: 'audio/mpeg', name: 'b.mp3' },
      ],
    });
    const { interaction } = createFakeMessageCommandInteraction(target.message, { commandName: 'Transcribe' });
    const { deps } = createFakeCommandDeps({
      transcribeAudio: async (input) => {
        if (input.url.endsWith('a.mp3')) throw new Error('decode failed');
        return 'second file words';
      },
    });

    await handleContextMenuCommand(interaction, deps);

    expect(postedContent(target)).toBe('-# transcript · asked by Invoker\n> second file words');
  });

  it('answers privately right away when there is nothing to transcribe', async () => {
    const target = createFakeTargetMessage({ content: 'just text' });
    const { interaction, responses } = createFakeMessageCommandInteraction(target.message, { commandName: 'Transcribe' });
    const { deps } = createFakeCommandDeps();

    await handleContextMenuCommand(interaction, deps);

    expect(responses).toEqual([
      expect.objectContaining({ method: 'reply', content: TRANSCRIBE_LINES.nothingThere, ephemeral: true }),
    ]);
  });

  it("shows the friendly can't-transcribe line when media understanding returns nothing", async () => {
    const target = voiceMessage();
    const { interaction, responses } = createFakeMessageCommandInteraction(target.message, { commandName: 'Transcribe' });
    const { deps } = createFakeCommandDeps();

    await handleContextMenuCommand(interaction, deps);

    expect(target.recorders.reply.calls).toHaveLength(0);
    expect(responses.at(-1)).toMatchObject({ method: 'editReply', content: TRANSCRIBE_LINES.couldNot, ephemeral: true });
  });

  it("shows the in-character note, privately, when today's video budget is spent", async () => {
    const target = createFakeTargetMessage({
      mediaAttachments: [{ url: 'https://cdn/clip.mp4', contentType: 'video/mp4', name: 'clip.mp4', duration: 75 }],
    });
    const { interaction, responses } = createFakeMessageCommandInteraction(target.message, { commandName: 'Transcribe' });
    const { deps } = createFakeCommandDeps({ watchVideo: async () => ({ status: 'over_budget' }) });

    await handleContextMenuCommand(interaction, deps);

    expect(target.recorders.reply.calls).toHaveLength(0);
    expect(responses.at(-1)).toMatchObject({
      method: 'editReply',
      content: 'not watched: out of popcorn money for today, the daily video budget is spent',
      ephemeral: true,
    });
  });

  it('says a voice message is too long without trying to transcribe it', async () => {
    const target = createFakeTargetMessage({
      voiceMessage: true,
      mediaAttachments: [{ url: 'https://cdn/voice-message.ogg', contentType: 'audio/ogg', duration: 725 }],
    });
    const { interaction, responses } = createFakeMessageCommandInteraction(target.message, { commandName: 'Transcribe' });
    const { deps, recorders } = createFakeCommandDeps({ transcribeAudio: async () => 'never asked' });

    await handleContextMenuCommand(interaction, deps);

    expect(recorders.transcribeAudio.calls).toHaveLength(0);
    expect(responses.at(-1)).toMatchObject({ method: 'editReply', content: 'too long to transcribe (12:05)', ephemeral: true });
  });

  it('posts what it could read and tells the invoker, labelled, why the rest is missing', async () => {
    const target = createFakeTargetMessage({
      mediaAttachments: [
        { url: 'https://cdn/memo.mp3', contentType: 'audio/mpeg', name: 'memo.mp3', duration: 30 },
        { url: 'https://cdn/huge.mp4', contentType: 'video/mp4', name: 'huge.mp4', duration: 90 },
      ],
    });
    const { interaction, responses } = createFakeMessageCommandInteraction(target.message, { commandName: 'Transcribe' });
    const { deps } = createFakeCommandDeps({
      transcribeAudio: async () => 'memo words',
      watchVideo: async () => ({ status: 'too_large' }),
    });

    await handleContextMenuCommand(interaction, deps);

    expect(postedContent(target)).toBe('-# transcript · asked by Invoker\n> memo words');
    expect(String(responses.at(-1)?.content)).toMatch(/^posted it: .+\nhuge\.mp4 \(1:30\): too large to watch$/);
  });

  it('shows the generic line when watching simply failed', async () => {
    const target = createFakeTargetMessage({
      mediaAttachments: [{ url: 'https://cdn/clip.mp4', contentType: 'video/mp4', name: 'clip.mp4' }],
    });
    const { interaction, responses } = createFakeMessageCommandInteraction(target.message, { commandName: 'Transcribe' });
    const { deps } = createFakeCommandDeps({ watchVideo: async () => ({ status: 'failed' }) });

    await handleContextMenuCommand(interaction, deps);

    expect(responses.at(-1)).toMatchObject({ method: 'editReply', content: TRANSCRIBE_LINES.couldNot });
  });

  it('splits a very long transcript across messages, each within the limit', async () => {
    const target = voiceMessage();
    const { interaction } = createFakeMessageCommandInteraction(target.message, { commandName: 'Transcribe' });
    const words = Array.from({ length: 800 }, (_, i) => `word${i}`).join(' ');
    const { deps } = createFakeCommandDeps({ transcribeAudio: async () => words });

    await handleContextMenuCommand(interaction, deps);

    const posts = [
      ...target.recorders.reply.calls.map((c) => (c[0] as { content: string }).content),
      ...target.recorders.send.calls.map((c) => (c[0] as { content: string }).content),
    ];
    expect(posts.length).toBeGreaterThan(1);
    for (const post of posts) expect(post.length).toBeLessThanOrEqual(2000);
    for (const post of posts.slice(1)) expect(post.startsWith('> ')).toBe(true);
  });
});

import { ChannelType, Collection, type Message, MessageType } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setMemoryStoreForTesting } from '../ai/memory';
import { MemoryStore } from '../ai/memory/memoryStore';
import bulkDeleteEvent from '../events/archiveBulkDelete';
import channelDeleteEvent from '../events/archiveChannelDelete';
import deleteEvent from '../events/archiveDelete';
import editEvent from '../events/archiveEdit';
import ingestEvent from '../events/archiveIngest';
import threadDeleteEvent from '../events/archiveThreadDelete';
import { recordRelay } from '../relay';
import { BotDb, setBotDbForTesting } from '../storage/botDb';
import { BOT_USER_ID, GUILD_ID, archivableMessage, archiveInput, snowflake } from '../test-support/fakeArchive';
import { ArchiveStore, VOICE_MESSAGE_FLAG, setArchiveStoreForTesting } from './archiveStore';
import {
  RelayReconciler,
  archiveChannelDelete,
  archiveMessageDeletes,
  archiveMessageUpdate,
  archiveNewMessage,
  isArchivableChannel,
  reconcileRelays,
  refreshTranscripts,
  toArchiveInput,
} from './ingest';

// The media feature's transcript cache, controllable per test.
const transcripts = vi.hoisted(() => new Map<string, string>());
vi.mock('../ai/media', () => ({
  getCachedTranscript: (id: string) => transcripts.get(id),
}));

const CHANNEL = '100000000000000001';
const THREAD = '100000000000000003';
const REMI = '200000000000000001';
const JASPER = '200000000000000002';
const T0 = Date.UTC(2026, 0, 15, 17, 0);

let store: ArchiveStore;
let memory: MemoryStore;

beforeEach(() => {
  store = new ArchiveStore(':memory:');
  setArchiveStoreForTesting(store);
  setBotDbForTesting(new BotDb(':memory:'));
  memory = new MemoryStore(':memory:');
  setMemoryStoreForTesting(memory);
  transcripts.clear();
});

afterEach(() => {
  setArchiveStoreForTesting(undefined);
  setBotDbForTesting(undefined);
  setMemoryStoreForTesting(undefined);
  store.close();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('toArchiveInput — what is archived and as whom', () => {
  it('archives a member message with its channel, reply and attribution', () => {
    const replyTo = snowflake(T0 - 1000);
    const input = toArchiveInput(
      archivableMessage({ content: 'hello', authorId: REMI, authorName: 'Remi', replyToId: replyTo }),
    );
    expect(input).toMatchObject({
      guildId: GUILD_ID,
      channelId: CHANNEL,
      parentChannelId: null,
      authorId: REMI,
      authorName: 'Remi',
      source: 'human',
      relayKind: null,
      content: 'hello',
      createdAt: T0,
      replyToId: replyTo,
      hasAudio: false,
      transcript: null,
    });
  });

  it("keeps the bot's own messages (replies and slash-command responses) as source 'bot'", () => {
    const reply = toArchiveInput(archivableMessage({ authorId: BOT_USER_ID, authorName: 'Frigidaire', authorBot: true }));
    expect(reply).toMatchObject({ source: 'bot', authorId: BOT_USER_ID });
    const interaction = toArchiveInput(
      archivableMessage({
        authorId: BOT_USER_ID,
        authorBot: true,
        webhookId: BOT_USER_ID,
        applicationId: BOT_USER_ID,
        type: MessageType.ChatInputCommand,
      }),
    );
    expect(interaction?.source).toBe('bot');
  });

  it('skips other bots, other integrations’ webhooks, system messages, DMs, partials and unsupported channels', () => {
    expect(toArchiveInput(archivableMessage({ authorId: '999', authorBot: true }))).toBeUndefined();
    expect(
      toArchiveInput(archivableMessage({ webhookId: '555', applicationId: '777', authorName: 'GitHub' })),
    ).toBeUndefined();
    expect(toArchiveInput(archivableMessage({ type: MessageType.UserJoin }))).toBeUndefined();
    expect(toArchiveInput(archivableMessage({ type: MessageType.ChannelPinnedMessage }))).toBeUndefined();
    expect(toArchiveInput(archivableMessage({ guildId: null }))).toBeUndefined();
    expect(toArchiveInput(archivableMessage({ partial: true }))).toBeUndefined();
    expect(toArchiveInput(archivableMessage({ channelType: ChannelType.GuildVoice }))).toBeUndefined();
  });

  it('attributes a registered relay to the member it was posted for, with its kind', () => {
    const id = snowflake(T0, 3);
    recordRelay({ messageId: id, channelId: CHANNEL, authorId: JASPER, authorName: 'Jasper', kind: 'regret' });
    const input = toArchiveInput(
      archivableMessage({ id, webhookId: '555', applicationId: BOT_USER_ID, authorName: 'Jasper', content: 'oops' }),
    );
    expect(input).toMatchObject({ source: 'relay', authorId: JASPER, relayKind: 'regret', content: 'oops' });
  });

  it('attributes an unregistered own-webhook relay by its webhook name, kind unknown for now', () => {
    memory.upsertIdentity(JASPER, 'Jasper');
    const input = toArchiveInput(archivableMessage({ webhookId: '555', applicationId: BOT_USER_ID, authorName: 'Jasper' }));
    expect(input).toMatchObject({ source: 'relay', authorId: JASPER, relayKind: null });
  });

  it("stores a linked side account's messages and relays under the main account id (LINKED_ACCOUNTS)", () => {
    const SIDE = '200000000000000009';
    vi.stubEnv('LINKED_ACCOUNTS', `${SIDE}:${JASPER}`);
    memory.upsertIdentity(JASPER, 'Jasper');
    const direct = toArchiveInput(archivableMessage({ authorId: SIDE, authorName: 'JayAlt', content: 'from my alt' }));
    expect(direct).toMatchObject({ source: 'human', authorId: JASPER, authorName: 'Jasper' });

    const id = snowflake(T0, 4);
    recordRelay({ messageId: id, channelId: CHANNEL, authorId: SIDE, authorName: 'JayAlt', kind: 'link_fix' });
    const relayed = toArchiveInput(
      archivableMessage({ id, webhookId: '555', applicationId: BOT_USER_ID, authorName: 'JayAlt', content: 'a link' }),
    );
    expect(relayed).toMatchObject({ source: 'relay', authorId: JASPER });
  });

  it('records the parent of a thread message and honors ARCHIVE_IGNORE_CHANNELS for channels and their threads', () => {
    const inThread = archivableMessage({ channelId: THREAD, channelType: ChannelType.PublicThread, parentId: CHANNEL });
    expect(toArchiveInput(inThread)).toMatchObject({ channelId: THREAD, parentChannelId: CHANNEL });

    vi.stubEnv('ARCHIVE_IGNORE_CHANNELS', `123, ${CHANNEL}`);
    expect(toArchiveInput(inThread)).toBeUndefined();
    expect(toArchiveInput(archivableMessage())).toBeUndefined();
    expect(isArchivableChannel({ id: '42', type: ChannelType.GuildAnnouncement })).toBe(true);
  });

  it('indexes link previews, file and sticker names as extra text; not a voice message’s file name', () => {
    const input = toArchiveInput(
      archivableMessage({
        content: 'look',
        attachments: [{ name: 'clip.mp4', contentType: 'video/mp4' }],
        embeds: [{ title: 'Faker does it again', description: 'x'.repeat(500), url: 'https://youtu.be/abc' }],
        stickers: ['cat jam'],
      }),
    );
    expect(input?.extraText).toContain('Faker does it again');
    expect(input?.extraText).toContain('clip.mp4');
    expect(input?.extraText).toContain('sticker cat jam');
    expect(input?.embeds[0].description).toHaveLength(300);
    expect(input?.attachments[0]).toMatchObject({ name: 'clip.mp4', type: 'video/mp4' });

    const voice = toArchiveInput(
      archivableMessage({
        flags: VOICE_MESSAGE_FLAG,
        attachments: [{ name: 'voice-message.ogg', contentType: 'audio/ogg' }],
      }),
    );
    expect(voice).toMatchObject({ hasAudio: true, extraText: '', flags: VOICE_MESSAGE_FLAG });
  });

  it('stores a cached voice transcript when the media feature already has one', () => {
    const id = snowflake(T0, 4);
    transcripts.set(id, 'meet at eight');
    const input = toArchiveInput(
      archivableMessage({ id, attachments: [{ name: 'memo.mp3', contentType: 'audio/mpeg' }] }),
    );
    expect(input).toMatchObject({ hasAudio: true, transcript: 'meet at eight' });
  });
});

describe('live ingest', () => {
  it('archives a new message and its channel; returns false for skipped ones', () => {
    expect(archiveNewMessage(archivableMessage({ content: 'first!' }))).toBe(true);
    expect(store.countMessages()).toBe(1);
    expect(store.getChannel(CHANNEL)?.name).toBe('bagel-bar');
    expect(archiveNewMessage(archivableMessage({ authorBot: true, authorId: '999' }))).toBe(false);
  });

  it('never throws when the archive fails', () => {
    store.close();
    expect(archiveNewMessage(archivableMessage())).toBe(false);
    expect(archiveMessageDeletes(['1'])).toBe(0);
    expect(archiveChannelDelete(CHANNEL)).toBe(0);
    store = new ArchiveStore(':memory:');
  });

  it('applies edits to archived messages only (the backfill brings older ones)', async () => {
    const original = archivableMessage({ content: 'teh typo' });
    archiveNewMessage(original);
    const edited = archivableMessage({ id: original.id, content: 'the typo', editedAt: T0 + 5000 });
    expect(await archiveMessageUpdate(edited)).toBe(true);
    expect(store.getMessage(original.id)).toMatchObject({ content: 'the typo', editCount: 1 });
    expect(store.search('typo', {}, 5).hits).toHaveLength(1);

    const stranger = archivableMessage({ id: snowflake(T0 - 99_000), content: 'old' });
    expect(await archiveMessageUpdate(stranger)).toBe(false);
    expect(store.getMessage(stranger.id)).toBeUndefined();
  });

  it("keeps the archived reactions on a gateway edit (discord.js rebuilds an uncached message without them)", async () => {
    const original = archivableMessage({
      content: 'old news',
      reactions: [
        { name: '😂', count: 7 },
        { id: '300000000000000001', name: 'kekw', count: 3 },
      ],
    });
    archiveNewMessage(original);
    // An edit (or a pin) after a restart: a full message, content and author present, reaction cache empty.
    const edited = archivableMessage({ id: original.id, content: 'old news (edited)', editedAt: T0 + 5000 });
    expect(edited.partial).toBe(false);
    expect(await archiveMessageUpdate(edited)).toBe(true);
    expect(store.getMessage(original.id)).toMatchObject({
      content: 'old news (edited)',
      reactions: [
        { id: '300000000000000001', name: 'kekw', count: 3 },
        { id: null, name: '😂', count: 7 },
      ],
    });
    // A pin changes nothing else: nothing is written.
    const pinned = archivableMessage({ id: original.id, content: 'old news (edited)', editedAt: T0 + 5000 });
    expect(await archiveMessageUpdate(pinned)).toBe(false);
    expect(store.getMessage(original.id)?.reactions).toHaveLength(2);
  });

  it('fetches a partial message to apply its edit (and its current reactions), and gives up quietly when that fails', async () => {
    const original = archivableMessage({ content: 'before' });
    archiveNewMessage(original);
    const full = archivableMessage({
      id: original.id,
      content: 'after',
      editedAt: T0 + 1000,
      reactions: [{ name: '👀', count: 2 }],
    });
    expect(await archiveMessageUpdate(archivableMessage({ id: original.id, partial: true, fetched: () => full }))).toBe(
      true,
    );
    expect(store.getMessage(original.id)).toMatchObject({
      content: 'after',
      reactions: [{ id: null, name: '👀', count: 2 }],
    });

    expect(await archiveMessageUpdate(archivableMessage({ id: original.id, partial: true }))).toBe(false);
    expect(store.getMessage(original.id)?.content).toBe('after');
  });

  it('marks single, bulk and channel deletions', () => {
    const a = archiveInput({ id: snowflake(T0, 1), content: 'a' });
    const b = archiveInput({ id: snowflake(T0, 2), content: 'b' });
    const t = archiveInput({ id: snowflake(T0, 3), channelId: THREAD, parentChannelId: CHANNEL, content: 't' });
    const other = archiveInput({ id: snowflake(T0, 4), channelId: '100000000000000002', content: 'o' });
    store.upsertMessages([a, b, t, other]);
    expect(archiveMessageDeletes([a.id], store, T0 + 1)).toBe(1);
    expect(archiveMessageDeletes([a.id, b.id], store, T0 + 2)).toBe(1);
    expect(archiveChannelDelete(CHANNEL, store, T0 + 3)).toBe(1); // the thread's message
    expect(store.getMessage(other.id)?.deletedAt).toBeNull();
    store.checkFtsIntegrity();
  });
});

describe('relay reconciliation and transcripts', () => {
  it('fills in the kind and real author once the relay registry has them', () => {
    const relay = archiveInput({ source: 'relay', authorId: null, authorName: 'Jasper', relayKind: null });
    store.upsertMessage(relay);
    expect(reconcileRelays(store, { sinceMs: T0 - 1 })).toBe(0);
    recordRelay({ messageId: relay.id, channelId: CHANNEL, authorId: JASPER, authorName: 'Jasper', kind: 'link_fix' });
    expect(reconcileRelays(store, { sinceMs: T0 - 1 })).toBe(1);
    expect(store.getMessage(relay.id)).toMatchObject({ authorId: JASPER, relayKind: 'link_fix' });
    expect(reconcileRelays(store, { sinceMs: T0 - 1 })).toBe(0);
  });

  it("reconciles a side account's relay to the main account id (LINKED_ACCOUNTS)", () => {
    const SIDE = '200000000000000009';
    vi.stubEnv('LINKED_ACCOUNTS', `${SIDE}:${JASPER}`);
    const relay = archiveInput({ source: 'relay', authorId: null, authorName: 'JayAlt', relayKind: null });
    store.upsertMessage(relay);
    recordRelay({ messageId: relay.id, channelId: CHANNEL, authorId: SIDE, authorName: 'JayAlt', kind: 'link_fix' });
    expect(reconcileRelays(store, { sinceMs: T0 - 1 })).toBe(1);
    expect(store.getMessage(relay.id)).toMatchObject({ authorId: JASPER, relayKind: 'link_fix' });
  });

  it('re-checks a relay archived before its registry row a few seconds later', () => {
    vi.useFakeTimers();
    const reconciler = new RelayReconciler(5000, () => store);
    const id = snowflake(T0, 7);
    store.upsertMessage(archiveInput({ id, source: 'relay', authorId: null, authorName: 'Jasper' }));
    reconciler.schedule(id);
    reconciler.schedule(id);
    recordRelay({ messageId: id, channelId: CHANNEL, authorId: JASPER, authorName: 'Jasper', kind: 'regret' });
    vi.advanceTimersByTime(5000);
    expect(store.getMessage(id)).toMatchObject({ authorId: JASPER, relayKind: 'regret' });
    expect(reconciler.flush()).toBe(0);
  });

  it('schedules reconciliation for relays ingested before the registry row exists', () => {
    const message = archivableMessage({ webhookId: '555', applicationId: BOT_USER_ID, authorName: 'Unknown Person' });
    expect(archiveNewMessage(message)).toBe(true);
    expect(store.getMessage(message.id)).toMatchObject({ source: 'relay', authorId: null, relayKind: null });
  });

  it('copies transcripts produced after ingest', () => {
    const voice = archiveInput({ id: snowflake(Date.now()), createdAt: Date.now(), hasAudio: true });
    store.upsertMessage(voice);
    expect(refreshTranscripts(store)).toBe(0);
    transcripts.set(voice.id, 'sorry running late');
    expect(refreshTranscripts(store)).toBe(1);
    expect(store.search('late', {}, 5).hits.map((h) => h.id)).toEqual([voice.id]);
  });
});

describe('archive events', () => {
  it('wire create, edit, delete, bulk delete, channel and thread deletion', async () => {
    const message = archivableMessage({ content: 'event path' });
    ingestEvent.execute(message as Parameters<typeof ingestEvent.execute>[0]);
    expect(store.getMessage(message.id)?.content).toBe('event path');

    const edited = archivableMessage({ id: message.id, content: 'edited path', editedAt: T0 + 1 });
    await editEvent.execute(
      message as Parameters<typeof editEvent.execute>[0],
      edited as Parameters<typeof editEvent.execute>[1],
    );
    expect(store.getMessage(message.id)?.content).toBe('edited path');

    deleteEvent.execute(message as Parameters<typeof deleteEvent.execute>[0]);
    expect(store.getMessage(message.id)?.deletedAt).not.toBeNull();

    const second = archivableMessage({ id: snowflake(T0, 5), content: 'bulk' });
    ingestEvent.execute(second as Parameters<typeof ingestEvent.execute>[0]);
    bulkDeleteEvent.execute(
      new Collection([[second.id, second]]) as unknown as Parameters<typeof bulkDeleteEvent.execute>[0],
      {} as Parameters<typeof bulkDeleteEvent.execute>[1],
    );
    expect(store.getMessage(second.id)?.deletedAt).not.toBeNull();

    const inThread = archivableMessage({
      id: snowflake(T0, 6),
      channelId: THREAD,
      channelType: ChannelType.PublicThread,
      parentId: CHANNEL,
    });
    ingestEvent.execute(inThread as Parameters<typeof ingestEvent.execute>[0]);
    threadDeleteEvent.execute({ id: THREAD } as unknown as Parameters<typeof threadDeleteEvent.execute>[0]);
    expect(store.getMessage(inThread.id)?.deletedAt).not.toBeNull();

    const third = archivableMessage({ id: snowflake(T0, 8) });
    ingestEvent.execute(third as Parameters<typeof ingestEvent.execute>[0]);
    channelDeleteEvent.execute({ id: CHANNEL } as unknown as Parameters<typeof channelDeleteEvent.execute>[0]);
    expect(store.getMessage(third.id)?.deletedAt).not.toBeNull();
  });

  it('do nothing when ARCHIVE_ENABLED=false', async () => {
    vi.stubEnv('ARCHIVE_ENABLED', 'off');
    const message: Message = archivableMessage({ content: 'not archived' });
    ingestEvent.execute(message as Parameters<typeof ingestEvent.execute>[0]);
    expect(store.countMessages()).toBe(0);
    vi.unstubAllEnvs();

    archiveNewMessage(message);
    vi.stubEnv('ARCHIVE_ENABLED', '0');
    deleteEvent.execute(message as Parameters<typeof deleteEvent.execute>[0]);
    await editEvent.execute(
      message as Parameters<typeof editEvent.execute>[0],
      archivableMessage({ id: message.id, content: 'x', editedAt: T0 + 1 }) as Parameters<typeof editEvent.execute>[1],
    );
    expect(store.getMessage(message.id)).toMatchObject({ content: 'not archived', deletedAt: null });
  });
});

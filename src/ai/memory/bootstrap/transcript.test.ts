import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArchiveStore, type ArchivedMessage } from '../../../archive/archiveStore';
import { archiveInput, BOT_USER_ID, snowflake } from '../../../test-support/fakeArchive';
import { MemoryStore } from '../memoryStore';
import { easternDay } from './dates';
import { transcriptContext } from './export';
import { buildExportPeople } from './people';
import {
  buildTranscript,
  compactText,
  lineText,
  renderLeadIn,
  renderTranscript,
  shortUrl,
  type TranscriptContext,
  type TranscriptLine,
} from './transcript';

// Fictional cast, placeholder snowflakes.
const REMI = '100000000000000001';
const REMI_ALT = '100000000000000011';
const DALE = '100000000000000002';
const NOVA = '100000000000000003';
const GENERAL = '300000000000000001';
const GAMING = '300000000000000002';
const THREAD = '300000000000000003';

let memory: MemoryStore;
let archive: ArchiveStore;

beforeEach(() => {
  vi.stubEnv('LINKED_ACCOUNTS', `${REMI_ALT}:${REMI}`);
  vi.stubEnv('ARCHIVE_IGNORE_CHANNELS', '');
  memory = new MemoryStore(':memory:');
  archive = new ArchiveStore(':memory:');
  memory.upsertIdentity(REMI, 'Remi', 'remi_b');
  memory.upsertIdentity(DALE, 'Dale', 'dale_d');
  memory.upsertIdentity(NOVA, 'Nova', 'nova_n');
  archive.upsertChannel({ id: GENERAL, guildId: null, name: 'general', parentId: null, type: 0 });
  archive.upsertChannel({ id: GAMING, guildId: null, name: 'gaming', parentId: null, type: 0 });
  archive.upsertChannel({ id: THREAD, guildId: null, name: 'Friday draft', parentId: GENERAL, type: 11 });
});

afterEach(() => {
  memory.close();
  archive.close();
  vi.unstubAllEnvs();
});

// 2024-03-01 21:40 Eastern (EST, UTC−5).
const T0 = Date.UTC(2024, 2, 2, 2, 40);
const MIN = 60_000;

let seq = 0;
function msg(overrides: Partial<ArchivedMessage> & { at: number }): ArchivedMessage {
  const { at, ...rest } = overrides;
  const input = archiveInput({ id: snowflake(at, seq++ % 4000), channelId: GENERAL, authorId: REMI, ...rest, createdAt: at });
  return { ...input, editCount: 0, deletedAt: null };
}

function context(): TranscriptContext {
  return transcriptContext(archive, buildExportPeople(memory, archive));
}

function texts(lines: TranscriptLine[]): string[] {
  return lines.map((l) => lineText(l));
}

describe('compactText', () => {
  it('resolves Discord markup to names and shortens links, on one line', () => {
    const ctx = context();
    const text = compactText(
      `hey <@${DALE}> and <@!${REMI_ALT}> <:pog:${'900000000000000123'}> see <#${GAMING}>\nhttps://www.youtube.com/watch?v=abc123. <https://example.org/> <@&900000000000000555> </draft:900000000000000777> <t:1709347200:R>`,
      ctx,
    );
    expect(text).toBe(
      'hey @Dale and @Remi :pog: see #gaming ⏎ youtube.com/…. example.org @role /draft 2024-03-01 21:40',
    );
    expect(text).not.toMatch(/\d{15,21}/);
  });

  it('names the bot and unknown accounts without their ids', () => {
    archive.upsertMessage(archiveInput({ authorId: BOT_USER_ID, source: 'bot', authorName: 'Frigidaire', content: 'hi' }));
    const ctx = context();
    expect(compactText(`<@${BOT_USER_ID}> <@100000000000000999>`, ctx)).toBe('@bot @someone');
  });

  it('keeps short links whole and never throws on a malformed one', () => {
    expect(shortUrl('https://example.org')).toBe('example.org');
    expect(shortUrl('https://x.com/remi/status/1?s=20')).toBe('x.com/…');
    expect(shortUrl('http://[broken')).toBe('http://[broken');
  });
});

describe('buildTranscript', () => {
  it("merges one author's consecutive messages a few minutes apart onto one line", () => {
    const lines = buildTranscript(
      [
        msg({ at: T0, content: 'anyone up' }),
        msg({ at: T0 + 1 * MIN, content: 'the mtg thing again' }),
        msg({ at: T0 + 2 * MIN, authorId: DALE, authorName: 'Dale', content: 'yeah' }),
        msg({ at: T0 + 3 * MIN, authorId: DALE, authorName: 'Dale', content: 'friday?' }),
        // Past the merge gap: a new line.
        msg({ at: T0 + 10 * MIN, authorId: DALE, authorName: 'Dale', content: 'hello??' }),
        // Another channel breaks the run.
        msg({ at: T0 + 11 * MIN, authorId: DALE, authorName: 'Dale', channelId: GAMING, content: 'gg' }),
      ],
      context(),
    );
    expect(texts(lines)).toEqual([
      '21:40 Remi: anyone up / the mtg thing again',
      // Minutes after the previous line: no time.
      'Dale: yeah / friday?',
      'Dale: hello??',
      // Another channel: a conversation starts, with its time.
      '21:51 Dale: gg',
    ]);
    expect(lines[0].messageIds).toHaveLength(2);
    expect(lines[3].channel).toBe('#gaming');
  });

  it('never merges across an Eastern day', () => {
    const lastMinute = Date.UTC(2024, 2, 2, 4, 59); // 23:59 Eastern on March 1
    const lines = buildTranscript(
      [msg({ at: lastMinute, content: 'good night' }), msg({ at: lastMinute + MIN, content: 'jk' })],
      context(),
    );
    expect(lines.map((l) => l.day)).toEqual(['2024-03-01', '2024-03-02']);
    expect(easternDay(lastMinute + MIN)).toBe('2024-03-02');
  });

  it('caps a merged line by length and count', () => {
    const long = 'x'.repeat(400);
    const lines = buildTranscript(
      [msg({ at: T0, content: long }), msg({ at: T0 + MIN, content: long })],
      context(),
    );
    expect(lines).toHaveLength(2);
    const many = Array.from({ length: 14 }, (_, i) => msg({ at: T0 + i * 1000, content: `m${i}` }));
    expect(buildTranscript(many, context(), { maxMergedMessages: 12 }).map((l) => l.messageIds.length)).toEqual([
      12, 2,
    ]);
  });

  it('marks replies, voice messages, files, link previews, stickers, forwards and polls', () => {
    const question = msg({ at: T0, authorId: DALE, authorName: 'Dale', content: 'who is in' });
    const lines = buildTranscript(
      [
        question,
        msg({
          at: T0 + 5 * MIN,
          content: 'me',
          replyToId: question.id,
          attachments: [{ name: 'deck.png', type: 'image/png', size: 10, url: 'https://cdn.example/deck.png' }],
          embeds: [{ title: 'Friday Night Magic', url: 'https://example.org/fnm' }, { url: 'https://example.org/x' }],
          extraText: 'Friday Night Magic\ndeck.png\nsticker Party Parrot\nforwarded: bring snacks\npoll: which set? / A / B',
        }),
        msg({
          at: T0 + 20 * MIN,
          authorId: NOVA,
          authorName: 'Nova',
          content: '',
          hasAudio: true,
          flags: 8192,
          transcript: 'ok so hear me out\nwe do sealed',
          attachments: [{ name: 'voice-message.ogg', type: 'audio/ogg', size: 10, url: 'https://cdn.example/v.ogg' }],
        }),
        msg({
          at: T0 + 30 * MIN,
          authorId: NOVA,
          authorName: 'Nova',
          content: '',
          hasAudio: true,
          flags: 8192,
          attachments: [{ name: 'voice-message.ogg', type: 'audio/ogg', size: 10, url: 'https://cdn.example/v.ogg' }],
        }),
        msg({ at: T0 + 40 * MIN, replyToId: '100000000000000777', content: 'old thing' }),
      ],
      context(),
    );
    expect(texts(lines)).toEqual([
      '21:40 Dale: who is in',
      'Remi: (↩ Dale) me [file: deck.png] [link: Friday Night Magic] [link: example.org/…] [sticker: Party Parrot] [fwd: bring snacks] [poll: which set? / A / B]',
      '22:00 Nova: [voice: ok so hear me out ⏎ we do sealed]',
      '22:10 Nova: [voice message]',
      '22:20 Remi: (↩) old thing',
    ]);
  });

  it("reads relays as their author, a side account as its member, and the bot's lines as `bot:`", () => {
    const lines = buildTranscript(
      [
        msg({ at: T0, source: 'relay', relayKind: 'link_fix', authorId: DALE, authorName: 'Dale', content: 'fixed link' }),
        msg({ at: T0 + 5 * MIN, authorId: REMI_ALT, authorName: 'Remi alt', content: 'from my phone' }),
        msg({ at: T0 + 10 * MIN, source: 'bot', authorId: BOT_USER_ID, authorName: 'Frigidaire', content: 'y'.repeat(500) }),
      ],
      context(),
    );
    expect(texts(lines).slice(0, 2)).toEqual(['21:40 Dale: fixed link', 'Remi: from my phone']);
    expect(lines[2].body.startsWith('bot: yyy')).toBe(true);
    expect(lines[2].body.length).toBeLessThanOrEqual('bot: '.length + 200);
    expect(lines[2].body.endsWith('…')).toBe(true);
  });

  it('labels a thread under its parent channel', () => {
    const lines = buildTranscript([msg({ at: T0, channelId: THREAD, parentChannelId: GENERAL, content: 'draft' })], context());
    expect(lines[0].channel).toBe('#general › Friday draft');
  });

  it('skips messages that carry nothing', () => {
    expect(buildTranscript([msg({ at: T0, content: '   ' })], context())).toEqual([]);
  });
});

describe('renderTranscript', () => {
  it('shows the time after every header, even for a line in the middle of a conversation', () => {
    const lines = buildTranscript([msg({ at: T0, content: 'a' }), msg({ at: T0 + MIN, authorId: DALE, content: 'b' })], context());
    expect(texts(lines)).toEqual(['21:40 Remi: a', 'Dale: b']);
    expect(renderTranscript(lines.slice(1)).lines).toEqual(['## 2024-03-01 (Friday)', '### #general', '21:41 Dale: b']);
  });

  it('opens a day header per Eastern day and a channel header per channel run, and maps line numbers', () => {
    const lines = buildTranscript(
      [
        msg({ at: T0, content: 'a' }),
        msg({ at: T0 + 10 * MIN, channelId: GAMING, content: 'b' }),
        msg({ at: T0 + 20 * MIN, content: 'c' }),
        msg({ at: T0 + 24 * 60 * MIN, content: 'd' }),
      ],
      context(),
    );
    const rendered = renderTranscript(lines, 3);
    expect(rendered.lines).toEqual([
      '## 2024-03-01 (Friday)',
      '### #general',
      '21:40 Remi: a',
      '### #gaming',
      '21:50 Remi: b',
      '### #general',
      '22:00 Remi: c',
      '',
      '## 2024-03-02 (Saturday)',
      '### #general',
      '21:40 Remi: d',
    ]);
    expect(rendered.lineNumbers).toEqual([5, 7, 9, 13]);
  });

  it('quotes a lead-in with its day and channel inline', () => {
    const lines = buildTranscript([msg({ at: T0, content: 'a' }), msg({ at: T0 + 10 * MIN, content: 'b' })], context());
    expect(renderLeadIn(lines)).toEqual([
      '> 2024-03-01 (Friday) · #general',
      '> 21:40 Remi: a',
      '> 21:50 Remi: b',
    ]);
  });
});

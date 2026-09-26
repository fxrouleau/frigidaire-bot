import { ChannelType } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArchiveStore, setArchiveStoreForTesting } from '../../../archive/archiveStore';
import { archiveInput, GUILD_ID, snowflake } from '../../../test-support/fakeArchive';
import { formatEvidencePassage, loadEvidencePassages } from './passages';

const CHANNEL = '100000000000000001';
const REMI = '200000000000000001';
const DALE = '200000000000000002';
const T0 = Date.UTC(2026, 7, 3, 1, 0); // 2026-08-02 21:00 ET
const MINUTE = 60_000;

let archive: ArchiveStore;

function at(minutes: number, content: string, authorId = REMI, authorName = 'Remi') {
  const createdAt = T0 + minutes * MINUTE;
  return archiveInput({ id: snowflake(createdAt), createdAt, channelId: CHANNEL, authorId, authorName, content });
}

beforeEach(() => {
  archive = new ArchiveStore(':memory:');
  setArchiveStoreForTesting(archive);
  archive.upsertChannel({ id: CHANNEL, guildId: GUILD_ID, name: 'bagel-bar', parentId: null, type: ChannelType.GuildText });
  archive.upsertMessages([
    at(0, 'anyone up for drafts friday'),
    at(1, 'always', DALE, 'Dale'),
    at(2, 'i quit valorant btw'),
    at(3, 'finally', DALE, 'Dale'),
    at(4, 'good riddance'),
    at(30, 'unrelated later message'),
  ]);
  vi.stubEnv('ARCHIVE_ENABLED', 'true');
});

afterEach(() => {
  setArchiveStoreForTesting(undefined);
  archive.close();
  vi.unstubAllEnvs();
});

describe('loadEvidencePassages', () => {
  it('reads the cited message with the ones around it, and skips ids already shown', () => {
    const cited = snowflake(T0 + 2 * MINUTE);
    const neighbour = snowflake(T0 + 3 * MINUTE);
    const passages = loadEvidencePassages([cited, neighbour, '999999999999999999'], { before: 1, after: 1 });
    expect(passages).toHaveLength(1);
    expect(passages[0].channelName).toBe('bagel-bar');
    expect(passages[0].messages.map((m) => m.content)).toEqual(['always', 'i quit valorant btw', 'finally']);

    const text = formatEvidencePassage(passages[0], (id) => (id === DALE ? 'Dale (now Wheels)' : undefined));
    expect(text).toBe(
      [
        '#bagel-bar',
        '   2026-08-02 21:01 Dale (now Wheels): always',
        '>> 2026-08-02 21:02 Remi: i quit valorant btw',
        '   2026-08-02 21:03 Dale (now Wheels): finally',
      ].join('\n'),
    );
  });

  it('caps the passages and gives none when the archive is off', () => {
    const ids = [snowflake(T0), snowflake(T0 + 30 * MINUTE)];
    expect(loadEvidencePassages(ids, { before: 0, after: 0, maxPassages: 1 })).toHaveLength(1);
    vi.stubEnv('ARCHIVE_ENABLED', 'false');
    expect(loadEvidencePassages(ids)).toEqual([]);
  });
});

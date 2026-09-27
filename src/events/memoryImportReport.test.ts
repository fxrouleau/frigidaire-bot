import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { importNotesAtStartup, takeImportReport } from '../ai/memory/bootstrap/importer';
import { MemoryStore } from '../ai/memory/memoryStore';
import { NotesStore } from '../ai/memory/notes/notesStore';
import { ArchiveStore } from '../archive/archiveStore';
import { logger } from '../logger';
import { createFakeChannel, createFakeClient, sentContent } from '../test-support/fakeDiscord';
import memoryImportReport from './memoryImportReport';

const CHANNEL_ID = 'report-1';
const REMI = '100000000000000001';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-import-report-'));
  vi.stubEnv('REPORT_CHANNEL_ID', CHANNEL_ID);
  vi.spyOn(logger, 'info').mockImplementation(() => {});
  takeImportReport();
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('memoryImportReport', () => {
  it('is a once-only ClientReady handler', () => {
    expect(memoryImportReport.name).toBe('clientReady');
    expect(memoryImportReport.once).toBe(true);
  });

  it("posts this start's import line once, without pinging anyone, and nothing without an import", async () => {
    const channel = createFakeChannel({ id: CHANNEL_ID });
    const { client } = createFakeClient({ channelsById: { [CHANNEL_ID]: channel.channel } });

    await memoryImportReport.execute(client);
    expect(channel.recorders.send.calls).toHaveLength(0);

    const memory = new MemoryStore(':memory:');
    const archive = new ArchiveStore(':memory:');
    memory.upsertIdentity(REMI, 'Remi');
    const dir = path.join(tmp, 'memory-import');
    fs.mkdirSync(path.join(dir, 'people', REMI), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'manifest.json'),
      JSON.stringify({ format: 'frigidaire-notes', version: 1, journal_high_water: 0 }),
    );
    fs.writeFileSync(path.join(dir, 'people', REMI, 'profile.md'), '---\ntitle: Remi\n---\nBakes bread.');
    importNotesAtStartup({ dir, memory, notes: new NotesStore(memory), archive });

    await memoryImportReport.execute(client);
    await memoryImportReport.execute(client);
    expect(channel.recorders.send.calls).toHaveLength(1);
    const payload = channel.recorders.send.calls[0][0] as { allowedMentions?: unknown };
    expect(sentContent(payload)).toBe('🧠 memory import · notes loaded for 1 person · dreams pick up from journal #0');
    expect(payload.allowedMentions).toEqual({ parse: [] });
    memory.close();
    archive.close();
  });
});

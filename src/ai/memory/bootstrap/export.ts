// The memory bootstrap export (docs/memory.md "Bootstrap" §1): the message archive as compact transcripts
// for readers that build the first notes (a Claude Code agent following .claude/skills/memory-bootstrap,
// or anyone else), written to data/memory-bootstrap/export/:
//
//   manifest.json     sizes per month and chunk (messages, characters, estimated tokens) and in total, so
//                     the owner sees what a run would read before running anything; the export time and
//                     the journal's high-water mark (the dream watermark an import of notes built from
//                     this export sets)
//   people.json       every transcript name → main id, linked accounts, every other name (people.ts)
//   months/YYYY-MM.md one transcript per month (transcript.ts)
//   chunks/NNNN.md    the same transcript cut into token-sized chunks at quiet gaps (chunks.ts), each
//                     opening with the conversation just before it under ALREADY COVERED
//
// The export is written to a temporary folder next to the target and swapped in at the end, so a failed
// run never leaves a half-written export behind, and a new export never mixes with an old one's files.
// Everything in it is private chat: it lives in the data volume like the databases.
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ArchiveStore } from '../../../archive/archiveStore';
import type { MemoryStore } from '../memoryStore';
import type { NotesStore } from '../notes/notesStore';
import { CHUNK_DEFAULTS, type ChunkRange, lineCosts, planChunks } from './chunks';
import { easternStamp } from './dates';
import { buildExportPeople, type ExportPeople, peopleJson } from './people';
import { estimateTokens } from './tokens';
import {
  ALREADY_COVERED_HEADING,
  buildTranscript,
  NEW_PART_HEADING,
  renderLeadIn,
  renderTranscript,
  type TranscriptContext,
  type TranscriptLine,
  type TranscriptOptions,
} from './transcript';

/** Where the export goes by default (inside the bot's data volume). */
export const DEFAULT_EXPORT_DIR = './data/memory-bootstrap/export';

export const EXPORT_FORMAT = 'frigidaire-export';
export const EXPORT_VERSION = 1;

export type ExportOptions = {
  archive: ArchiveStore;
  memory: MemoryStore;
  notes: NotesStore;
  outDir?: string;
  /** Chunk target size (default 80k tokens). */
  chunkTokens?: number;
  /** The lead-in before each chunk (default ~2k tokens). */
  leadInTokens?: number;
  transcript?: TranscriptOptions;
  now?: () => Date;
};

export type MonthEntry = {
  month: string;
  file: string;
  messages: number;
  lines: number;
  chars: number;
  tokens: number;
};

export type ChunkEntry = {
  id: string;
  file: string;
  /** First and last message time (Eastern, 'YYYY-MM-DD HH:MM'). */
  from: string;
  to: string;
  messages: number;
  lines: number;
  /** The whole file, lead-in included. */
  tokens: number;
  lead_in_tokens: number;
};

export type ExportManifest = {
  format: typeof EXPORT_FORMAT;
  version: typeof EXPORT_VERSION;
  about: string;
  exported_at: string;
  timezone: 'America/New_York';
  /** The journal's highest journal_seq at export: an import of notes built from this export sets the dreams' watermarks here. */
  journal_high_water: number;
  range: { first: string | null; last: string | null };
  totals: {
    messages: number;
    lines: number;
    chars: number;
    /** Estimated tokens of every month file together. */
    tokens: number;
    /** Estimated tokens of the messages' own text. */
    text_tokens: number;
    /** (tokens − text_tokens) / text_tokens: what the headers, times and names add. */
    framing_ratio: number;
    /** Estimated tokens of every chunk file together (lead-ins included). */
    chunk_tokens: number;
  };
  months: MonthEntry[];
  chunking: { target_tokens: number; lead_in_tokens: number };
  chunks: ChunkEntry[];
  people: { file: 'people.json'; count: number; unresolved_names: number };
  channels: { name: string; messages: number }[];
};

/** Channel labels from the archive's channel table: '#name', or '#parent › thread' for a thread. */
export function channelLabels(archive: ArchiveStore): (channelId: string) => string {
  const channels = new Map(archive.listChannels().map((c) => [c.id, c]));
  const clean = (name: string) => name.replace(/[\r\n]+/g, ' ').trim() || 'unnamed';
  return (channelId) => {
    const channel = channels.get(channelId);
    if (!channel) return '#unknown-channel';
    const parent = channel.parentId ? channels.get(channel.parentId) : undefined;
    return parent ? `#${clean(parent.name)} › ${clean(channel.name)}` : `#${clean(channel.name)}`;
  };
}

/** The transcript context over the archive and the export's people. */
export function transcriptContext(archive: ArchiveStore, people: ExportPeople): TranscriptContext {
  return { people, channelLabel: channelLabels(archive) };
}

function messageCount(lines: TranscriptLine[]): number {
  return lines.reduce((n, line) => n + line.messageIds.length, 0);
}

/** A month's file: a title line, then the transcript. */
export function renderMonth(month: string, lines: TranscriptLine[]): string {
  const body = renderTranscript(lines, 3).lines;
  return `# ${month} · ${messageCount(lines).toLocaleString('en-US')} messages\n\n${body.join('\n')}\n`;
}

/**
 * A chunk's file: a title line, the lead-in (quoted, under ALREADY COVERED), then the chunk's own lines
 * under NEW. Line numbers in the file are stable (evidence cites them).
 */
export function renderChunk(lines: TranscriptLine[], range: ChunkRange, index: number, count: number): string {
  const own = lines.slice(range.start, range.end);
  const leadIn = lines.slice(range.leadInStart, range.start);
  const first = own[0];
  const last = own[own.length - 1];
  const title = `# Chunk ${chunkId(index)} of ${chunkId(count - 1)} · ${easternStamp(first.startMs)} → ${easternStamp(last.endMs)} · ${messageCount(own).toLocaleString('en-US')} messages`;
  const out = [title, ''];
  if (leadIn.length > 0) out.push(ALREADY_COVERED_HEADING, ...renderLeadIn(leadIn), '', NEW_PART_HEADING, '');
  out.push(...renderTranscript(own, out.length + 1).lines);
  return `${out.join('\n')}\n`;
}

/** '0001' for the first chunk. */
export function chunkId(index: number): string {
  return String(index + 1).padStart(4, '0');
}

function writeJson(file: string, value: unknown): void {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Writes the export (see the file comment) and returns its manifest. Throws on a filesystem error; the
 * previous export, if any, is only replaced once the new one is complete.
 */
export function runExport(opts: ExportOptions): ExportManifest {
  const outDir = path.resolve(opts.outDir ?? DEFAULT_EXPORT_DIR);
  const chunkTokens = Math.max(1_000, Math.floor(opts.chunkTokens ?? CHUNK_DEFAULTS.targetTokens));
  const leadInTokens = Math.max(0, Math.floor(opts.leadInTokens ?? CHUNK_DEFAULTS.leadInTokens));
  const now = (opts.now ?? (() => new Date()))();

  const people = buildExportPeople(opts.memory, opts.archive);
  const ctx = transcriptContext(opts.archive, people);
  const lines = buildTranscript(opts.archive.iterateMessages(), ctx, opts.transcript);
  const channelMessages = new Map<string, number>();
  for (const line of lines)
    channelMessages.set(line.channel, (channelMessages.get(line.channel) ?? 0) + line.messageIds.length);

  const tmpDir = `${outDir}.partial`;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(tmpDir, 'months'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'chunks'), { recursive: true });

  const months: MonthEntry[] = [];
  const byMonth = new Map<string, TranscriptLine[]>();
  for (const line of lines) {
    const month = line.day.slice(0, 7);
    const list = byMonth.get(month) ?? [];
    list.push(line);
    byMonth.set(month, list);
  }
  let totalChars = 0;
  let totalTokens = 0;
  for (const [month, monthLines] of byMonth) {
    const text = renderMonth(month, monthLines);
    const file = `months/${month}.md`;
    fs.writeFileSync(path.join(tmpDir, file), text);
    const tokens = estimateTokens(text);
    totalChars += text.length;
    totalTokens += tokens;
    months.push({
      month,
      file,
      messages: messageCount(monthLines),
      lines: monthLines.length,
      chars: text.length,
      tokens,
    });
  }

  const ranges = planChunks(lines, { targetTokens: chunkTokens, leadInTokens });
  const costs = lineCosts(lines);
  const chunks: ChunkEntry[] = ranges.map((range, index) => {
    const text = renderChunk(lines, range, index, ranges.length);
    const file = `chunks/${chunkId(index)}.md`;
    fs.writeFileSync(path.join(tmpDir, file), text);
    const own = lines.slice(range.start, range.end);
    return {
      id: chunkId(index),
      file,
      from: easternStamp(own[0].startMs),
      to: easternStamp(own[own.length - 1].endMs),
      messages: messageCount(own),
      lines: own.length,
      tokens: estimateTokens(text),
      lead_in_tokens: costs.slice(range.leadInStart, range.start).reduce((a, b) => a + b, 0),
    };
  });

  writeJson(path.join(tmpDir, 'people.json'), peopleJson(people));

  const textTokens = lines.reduce((n, line) => n + line.payloadTokens, 0);
  const manifest: ExportManifest = {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    about:
      'Compact transcripts of the message archive for building memory notes (docs/memory.md, .claude/skills/memory-bootstrap). Times are Eastern. Names are people.json keys.',
    exported_at: now.toISOString(),
    timezone: 'America/New_York',
    journal_high_water: opts.notes.journalHighWater(),
    range: {
      first: lines.length > 0 ? easternStamp(lines[0].startMs) : null,
      last: lines.length > 0 ? easternStamp(lines[lines.length - 1].endMs) : null,
    },
    totals: {
      messages: messageCount(lines),
      lines: lines.length,
      chars: totalChars,
      tokens: totalTokens,
      text_tokens: textTokens,
      framing_ratio: textTokens > 0 ? Math.round(((totalTokens - textTokens) / textTokens) * 1000) / 1000 : 0,
      chunk_tokens: chunks.reduce((n, c) => n + c.tokens, 0),
    },
    months,
    chunking: { target_tokens: chunkTokens, lead_in_tokens: leadInTokens },
    chunks,
    people: { file: 'people.json', count: people.people.length, unresolved_names: people.unresolved.length },
    channels: [...channelMessages.entries()]
      .map(([name, messages]) => ({ name, messages }))
      .sort((a, b) => b.messages - a.messages),
  };
  writeJson(path.join(tmpDir, 'manifest.json'), manifest);

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(outDir), { recursive: true });
  fs.renameSync(tmpDir, outDir);
  return manifest;
}

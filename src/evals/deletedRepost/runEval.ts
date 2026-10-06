// `yarn eval:deleted-repost [--repeats N] [--show] [cases.json ...]`: live evaluation of the deleted-message
// repost's edgy judge on real messages, through the real pipeline (src/deletedMessages.ts):
//   1. a case's uploads are saved the way the reposter saves them (signed when they are Discord links,
//      downloaded, refused past 10 MB, or 100 MB for a video);
//   2. describeForJudge opens what the message showed: Discord attachment links signed through
//      refresh-urls (src/discordCdn.ts), GIFs and pictures sampled into frames, GIF pages read;
//   3. the judge decides, exactly as configured: DELETE_REPOST_MODEL (the decision model) on words alone,
//      each EVAL_MODELS model (default DELETE_REPOST_VISION_MODEL) as the vision judge for what it showed.
//
// Cases: data/deleted-repost-cases.json (gitignored: real messages never go into this public repo) plus any
// files given as arguments; the format is in cases.ts. A case with media where nothing could be opened is a
// PIPELINE failure, reported apart from the judge's misses. Prints a table per model, recall, the
// false-positive rate, the cost and a PASS/FAIL line, and writes a JSON result to EVAL_OUTPUT_DIR with case
// ids and file names only, never links. --show also prints what the judge saw and said (private content).
// The exit code is 0 whatever the verdicts (1 only for bad arguments or case files).
//
// Paid (a fraction of a cent per case and model) and opt-in: RUN_LIVE=1 and OPENROUTER_API_KEY. CLIENT_SECRET
// (the bot token, from .env or -e) signs Discord links over REST, with no gateway login; without it they are
// fetched unsigned, which the CDN answers with 404: the bug this eval guards against. The bot's state is never
// touched: bot.db (usage ledger, media caches) is in memory, no error captures, no log file.
//   docker compose run --rm -e RUN_LIVE=1 -e OPENROUTER_API_KEY=sk-... -e CLIENT_SECRET=... test yarn eval:deleted-repost
// Videos are sampled with ffmpeg, which the test image doesn't have (GIFs and pictures don't need it).

// Must stay the first import: it applies .env before any module below reads config while loading.
import '../../loadEnv';
import * as fs from 'node:fs';
import * as path from 'node:path';
import process from 'node:process';
import { REST } from 'discord.js';
import { findLinks } from '../../ai/linkReader/targets';
import { downloadMedia, MEDIA_ACCEPT } from '../../ai/media/download';
import {
  createDetailedEdgyJudge,
  type DetailedMessageJudge,
  isDecisionModel,
  type JudgeInput,
  type JudgeVerdict,
} from '../../ai/messageJudge';
import { getUsageSummary } from '../../ai/usage';
import { flushPendingUsage } from '../../ai/usageFetch';
import { config } from '../../config';
import {
  attachmentKind,
  defaultJudgeMediaDeps,
  describeForJudge,
  type JudgeMedia,
  type JudgeMediaDeps,
  type SnapshotAttachment,
} from '../../deletedMessageMedia';
import { isBlind } from '../../deletedMessages';
import { createAttachmentUrlSigner, needsSigning, type UrlSigner } from '../../discordCdn';
import { logger } from '../../logger';
import { BotDb, setBotDbForTesting } from '../../storage/botDb';
import {
  type CaseRun,
  DEFAULT_AUTHOR,
  type EvalUpload,
  type Judgment,
  judgmentMark,
  loadCaseSources,
  type ModelScore,
  parseEvalArgs,
  redactJudgeLine,
  type SourcedCase,
  scoreRuns,
  USAGE,
} from './cases';

const LOCAL_CASES = path.resolve('data', 'deleted-repost-cases.json');
// What the reposter saves (deletedMessages.ts): a file a webhook can upload, a video it can shrink to fit.
const MAX_SAVED_BYTES = 10 * 1024 * 1024;
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 15_000;
const VIDEO_DOWNLOAD_TIMEOUT_MS = 60_000;
// In prod an upload always comes from Discord's CDN (fetched without a type allowlist); one hosted elsewhere
// goes through the guarded fetch, which has to be told images are welcome.
const UPLOAD_ACCEPT = [...MEDIA_ACCEPT, 'image/*'];
const DAY_MS = 24 * 60 * 60 * 1000;

const HOW_TO = `No cases. Create data/deleted-repost-cases.json (gitignored; never commit real messages or links):
{
  "version": 1,
  "cases": [
    { "id": "gif-1", "label": true, "text": "https://cdn.discordapp.com/attachments/<channel>/<attachment>/<name>.gif" },
    { "id": "upload-1", "label": true, "text": "", "files": [{ "url": "https://...", "name": "clip.mp4" }] },
    { "id": "plain-1", "label": false, "text": "omw, 10 min" }
  ]
}
"text" is the message exactly as posted; label true = edgy (should be reposted). Format: src/evals/deletedRepost/cases.ts.
Or pass case files as arguments. ${USAGE}`;

type PipelineStats = {
  /** Links in the text (as the media reader finds them, Discord media links included). */
  links: number;
  /** Discord attachment links that needed signing, and how many came back signed. */
  signAsked: number;
  signed: number;
  /** Image downloads (linked pictures and GIFs, GIF pages' stills) tried and opened. */
  downloadsTried: number;
  downloadsOpened: number;
  /** GIF pages (Tenor, Klipy) tried and read. */
  pagesTried: number;
  pagesRead: number;
};

type Prepared = {
  sourced: SourcedCase;
  attachments: SnapshotAttachment[];
  /** Uploads that could not be saved, by file name. */
  saveProblems: string[];
  media: JudgeMedia;
  stats: PipelineStats;
  /** The reposter would not ask the judge: nothing left to repost, or only links it couldn't open. */
  skip?: 'empty' | 'blind';
  /** It uploaded files, or linked a GIF page or an image the pipeline tried to open. */
  hadMedia: boolean;
  /** It had media and none of it could be opened. */
  pipelineFailed: boolean;
};

type Judged = { judgment: Judgment; verdict?: JudgeVerdict };

/** Keeps what the judge says it saw (private content) out of the console unless --show. */
function hideWhatTheJudgeSaw(): void {
  const { info, warn } = logger;
  logger.info = (message, ...rest) => info(redactJudgeLine(message), ...rest);
  logger.warn = (message, ...rest) => warn(redactJudgeLine(message), ...rest);
}

/**
 * The vision judges to compare: EVAL_MODELS (default: DELETE_REPOST_VISION_MODEL), unless DELETE_REPOST_MODEL
 * is a chat model that judges alone.
 */
function judgeModels(decisionModel: string): { models: string[]; notes: string[] } {
  if (!isDecisionModel(decisionModel)) {
    return {
      models: [decisionModel],
      notes: [
        `DELETE_REPOST_MODEL=${decisionModel} is a chat model: it judges every case alone, EVAL_MODELS is unused.`,
      ],
    };
  }
  const models: string[] = [];
  const notes: string[] = [];
  const candidates =
    config.evals.explicitModels.length > 0 ? config.evals.explicitModels : [config.models.messageJudgeVision];
  for (const model of candidates) {
    if (isDecisionModel(model)) notes.push(`Skipping ${model} from EVAL_MODELS: a decision model can't see images.`);
    else models.push(model);
  }
  return { models: [...new Set(models)], notes };
}

/** A case's uploads, saved as the reposter saves them at post time. */
async function saveUploads(
  uploads: EvalUpload[],
  sign: UrlSigner,
): Promise<{ attachments: SnapshotAttachment[]; problems: string[] }> {
  if (uploads.length === 0) return { attachments: [], problems: [] };
  const unsigned = uploads.map((u) => u.url).filter((url) => needsSigning(url));
  const signed = unsigned.length > 0 ? await sign(unsigned) : new Map<string, string>();
  const attachments: SnapshotAttachment[] = [];
  const problems: string[] = [];
  for (const upload of uploads) {
    const video = attachmentKind({ name: upload.name, contentType: upload.contentType ?? null }) === 'video';
    const result = await downloadMedia(signed.get(upload.url) ?? upload.url, {
      maxBytes: video ? MAX_VIDEO_BYTES : MAX_SAVED_BYTES,
      timeoutMs: video ? VIDEO_DOWNLOAD_TIMEOUT_MS : DOWNLOAD_TIMEOUT_MS,
      accept: UPLOAD_ACCEPT,
    });
    if (!result.ok) {
      const why =
        result.reason === 'too_large'
          ? `too big to save (over ${video ? MAX_VIDEO_BYTES / 1024 / 1024 : MAX_SAVED_BYTES / 1024 / 1024} MB)`
          : `not downloaded (${result.reason})`;
      problems.push(`${upload.name}: ${why}`);
      continue;
    }
    attachments.push({
      name: upload.name,
      contentType: upload.contentType ?? result.contentType ?? null,
      data: result.data,
    });
  }
  return { attachments, problems };
}

/** Runs a case through the media half of the pipeline once (every model judges the same input). */
async function prepareCase(sourced: SourcedCase, signer: UrlSigner | undefined): Promise<Prepared> {
  const c = sourced.case;
  const stats: PipelineStats = {
    links: findLinks(c.text, { discordMedia: true }).length,
    signAsked: 0,
    signed: 0,
    downloadsTried: 0,
    downloadsOpened: 0,
    pagesTried: 0,
    pagesRead: 0,
  };
  // Always passed, so links that needed signing are counted even when there is no token to sign them.
  const sign: UrlSigner = async (urls) => {
    stats.signAsked += urls.length;
    const signed = signer ? await signer(urls) : new Map<string, string>();
    stats.signed += signed.size;
    return signed;
  };
  const { attachments, problems } = await saveUploads(c.files ?? [], sign);

  const base = defaultJudgeMediaDeps();
  const deps: JudgeMediaDeps = {
    ...base,
    readLink: async (url) => {
      stats.pagesTried += 1;
      const result = await base.readLink(url);
      if (result.ok) stats.pagesRead += 1;
      return result;
    },
    downloadImage: async (url) => {
      stats.downloadsTried += 1;
      const data = await base.downloadImage(url);
      if (data) stats.downloadsOpened += 1;
      return data;
    },
    signUrls: sign,
  };
  const media = await describeForJudge(c.text, attachments, deps);

  const hadMedia = (c.files?.length ?? 0) > 0 || stats.downloadsTried > 0 || stats.pagesTried > 0;
  const skip =
    c.text.length === 0 && attachments.length === 0
      ? 'empty'
      : isBlind(c.text, attachments, media)
        ? 'blind'
        : undefined;
  return {
    sourced,
    attachments,
    saveProblems: problems,
    media,
    stats,
    ...(skip ? { skip } : {}),
    hadMedia,
    pipelineFailed: hadMedia && media.visuals.length === 0,
  };
}

async function judgeCase(p: Prepared, judge: DetailedMessageJudge, repeats: number): Promise<Judged[]> {
  if (p.skip) return Array.from({ length: repeats }, (): Judged => ({ judgment: 'not_judged' }));
  const c = p.sourced.case;
  const input: JudgeInput = {
    author: c.author ?? DEFAULT_AUTHOR,
    text: c.text,
    visuals: p.media.visuals,
    attachmentNames: (c.files ?? []).map((f) => f.name),
    mediaNotes: p.media.notes,
  };
  const judged: Judged[] = [];
  for (let i = 0; i < repeats; i += 1) {
    const verdict = await judge(input);
    judged.push(verdict ? { judgment: verdict.edgy ? 'edgy' : 'not_edgy', verdict } : { judgment: 'no_verdict' });
  }
  return judged;
}

// ---- Output ----

function percent(value: number | undefined): string {
  return value === undefined ? 'n/a' : `${(value * 100).toFixed(0)}%`;
}

function shortModel(model: string): string {
  return model.split('/').pop() ?? model;
}

function frameCount(media: JudgeMedia): number {
  return media.visuals.reduce((sum, v) => sum + v.frames.length, 0);
}

function fraction(part: number, whole: number): string {
  return whole > 0 ? `${part}/${whole}` : '-';
}

/** Which backend answered: the model, and the decision model's probability. */
function answeredBy(judged: Judged[]): string {
  const seen = new Set<string>();
  for (const { verdict } of judged) {
    if (!verdict) continue;
    const p = verdict.probability !== undefined ? ` p=${verdict.probability.toFixed(2)}` : '';
    seen.add(`${shortModel(verdict.model)}${p}`);
  }
  return [...seen].join(', ') || '-';
}

function outcome(p: Prepared, judged: Judged[]): string {
  const edgy = judged.filter((j) => j.judgment === 'edgy').length;
  if (!p.sourced.case.label) return edgy > 0 ? 'FALSE POSITIVE' : 'ok';
  if (edgy === judged.length) return 'ok';
  if (p.pipelineFailed) return 'PIPELINE';
  if (judged.some((j) => j.judgment === 'not_edgy')) return 'MISS';
  return 'NO VERDICT';
}

function renderModelTable(model: string, prepared: Prepared[], judged: Judged[][], show: boolean): string {
  const headers = [
    'case',
    'label',
    'links',
    'signed',
    'opened',
    'pages',
    'files',
    'visuals',
    'notes',
    'verdicts',
    'via',
    'result',
  ];
  const rows = prepared.map((p, i) => {
    const c = p.sourced.case;
    const s = p.stats;
    const skipped = p.skip ? ` (${p.skip})` : '';
    return [
      c.id,
      c.label ? 'edgy' : 'not',
      String(s.links),
      fraction(s.signed, s.signAsked),
      fraction(s.downloadsOpened, s.downloadsTried),
      fraction(s.pagesRead, s.pagesTried),
      fraction(p.attachments.length, c.files?.length ?? 0),
      `${p.media.visuals.length} (${frameCount(p.media)}f)`,
      String(p.media.notes.length),
      `${judged[i].map((j) => judgmentMark(j.judgment)).join('')}${skipped}`,
      answeredBy(judged[i]),
      outcome(p, judged[i]),
    ];
  });
  const widths = headers.map((h, col) => Math.max(h.length, ...rows.map((row) => row[col].length)));
  const line = (cells: string[]) =>
    cells
      .map((cell, col) => cell.padEnd(widths[col]))
      .join('  ')
      .trimEnd();
  const lines = [`Vision judge ${model}:`, line(headers), line(widths.map((w) => '-'.repeat(w)))];
  rows.forEach((row, i) => {
    lines.push(line(row));
    const p = prepared[i];
    // File names only: safe to print, and the first thing to check when an upload went missing.
    for (const problem of p.saveProblems) lines.push(`    upload: ${problem}`);
    if (!show) return;
    if (p.sourced.case.note) lines.push(`    note: ${p.sourced.case.note}`);
    p.media.visuals.forEach((visual, n) => {
      lines.push(`    saw ${n + 1}: ${visual.label}`);
    });
    for (const note of p.media.notes) lines.push(`    media: ${note}`);
    for (const shows of new Set(judged[i].flatMap((j) => (j.verdict?.shows ? [j.verdict.shows] : [])))) {
      lines.push(`    shows: ${shows}`);
    }
  });
  return lines.join('\n');
}

function renderScore(score: ModelScore, repeats: number): string {
  const calls = repeats > 1 ? ` (judge calls: cases × ${repeats})` : '';
  return [
    `${score.model}${calls}:`,
    `  recall ${score.caught}/${score.positives} (${percent(score.recall)})`,
    `judge recall on opened cases ${percent(score.judgeRecall)}`,
    `judge misses ${score.judgeMisses}`,
    `pipeline misses ${score.pipelineMisses}`,
    `no verdict ${score.noVerdict}`,
    `false positives ${score.falsePositives}/${score.negatives} (${percent(score.falsePositiveRate)})`,
    score.pass ? 'PASS' : 'FAIL',
  ].join(' · ');
}

function resultLine(scores: ModelScore[], prepared: Prepared[]): string {
  const failedCases = prepared.filter((p) => p.pipelineFailed).map((p) => p.sourced.case.id);
  if (scores.every((s) => s.pass)) {
    return 'RESULT: PASS: every edgy case judged edgy on every call by every model, nothing harmless judged edgy, every case opened.';
  }
  const problems = scores
    .filter((s) => !s.pass)
    .map((s) => {
      const parts = [
        s.judgeMisses > 0 ? `${s.judgeMisses} judge miss(es)` : '',
        s.pipelineMisses > 0 ? `${s.pipelineMisses} pipeline miss(es)` : '',
        s.noVerdict > 0 ? `${s.noVerdict} without a verdict` : '',
        s.falsePositives > 0 ? `${s.falsePositives} false positive(s)` : '',
      ].filter(Boolean);
      return `${shortModel(s.model)}: ${parts.join(', ') || 'see the table'}`;
    });
  if (failedCases.length > 0) problems.push(`pipeline failed on ${failedCases.join(', ')}`);
  return `RESULT: FAIL: ${problems.join('; ')}.`;
}

async function costLine(): Promise<string> {
  await flushPendingUsage();
  const summary = getUsageSummary(0, Date.now() + DAY_MS);
  if (summary.total.requests === 0) return 'Cost: nothing recorded.';
  const byModel = summary.byModel
    .map((m) => `${shortModel(m.model)} $${m.costUsd.toFixed(5)} over ${m.requests} call(s)`)
    .join('; ');
  const unpriced = summary.total.unpricedRequests > 0 ? `, ${summary.total.unpricedRequests} unpriced` : '';
  return `Cost: $${summary.total.costUsd.toFixed(5)}${unpriced} (${byModel})`;
}

function writeResult(result: unknown, startedAt: string): string {
  const dir = config.evals.outputDir;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `deleted-repost-${startedAt.replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
  return file;
}

async function main(argv: string[]): Promise<number> {
  // Keep the bot's real data out of it before anything logs or records: no error captures, no lines in the
  // bot's log file, and bot.db in memory (the usage ledger that prices the run, the media caches).
  process.env.DEBUG_CAPTURE = '0';
  process.env.LOG_FILE = 'off';
  setBotDbForTesting(new BotDb(':memory:'));

  const args = parseEvalArgs(argv);
  if ('error' in args) {
    console.error(`${args.error}\n${USAGE}`);
    return 1;
  }
  if (!config.evals.runLive || !config.openRouter.apiKey) {
    console.log(
      'eval:deleted-repost makes paid OpenRouter calls: set RUN_LIVE=1 and OPENROUTER_API_KEY. Nothing was run.',
    );
    return 0;
  }
  const files = [...(fs.existsSync(LOCAL_CASES) ? [LOCAL_CASES] : []), ...args.files.map((f) => path.resolve(f))];
  if (files.length === 0) {
    console.log(HOW_TO);
    return 0;
  }
  const cases = loadCaseSources(files);
  if (cases.length === 0) {
    console.log(`The case file(s) hold no cases.\n\n${HOW_TO}`);
    return 0;
  }
  if (!args.show) hideWhatTheJudgeSaw();

  const decisionModel = config.models.messageJudge;
  const { models, notes } = judgeModels(decisionModel);
  for (const note of notes) console.log(note);
  if (models.length === 0) {
    console.log('No vision judge left to run: set EVAL_MODELS to chat models that read images.');
    return 0;
  }

  const token = config.discord.token;
  const signer = token ? createAttachmentUrlSigner(new REST({ version: '10' }).setToken(token)) : undefined;
  const startedAt = new Date().toISOString();
  const positives = cases.filter((c) => c.case.label).length;
  console.log(
    `Deleted-repost eval: ${cases.length} case(s) (${positives} edgy, ${cases.length - positives} not) from ${files.map((f) => path.basename(f)).join(', ')}`,
  );
  console.log(
    `decision model=${decisionModel} · vision judge(s)=${models.join(', ')} · repeats=${args.repeats} · signing=${signer ? 'on' : 'OFF'}`,
  );
  if (!signer) {
    console.log(
      [
        '',
        '!!! CLIENT_SECRET is not set: Discord attachment links are fetched UNSIGNED, and the CDN answers those with 404.',
        '!!! That reproduces the old bug (every favorited GIF unseen). Set CLIENT_SECRET (.env or -e) to sign them.',
        '',
      ].join('\n'),
    );
  }
  if (
    cases.some((c) =>
      (c.case.files ?? []).some(
        (f) => attachmentKind({ name: f.name, contentType: f.contentType ?? null }) === 'video',
      ),
    )
  ) {
    console.log('Note: videos are sampled with ffmpeg; without it (the test image has none) a video shows nothing.');
  }

  console.log('\nOpening what each message showed:');
  const prepared: Prepared[] = [];
  for (const [index, sourced] of cases.entries()) {
    const p = await prepareCase(sourced, signer);
    prepared.push(p);
    const state = p.pipelineFailed ? ' PIPELINE FAILURE' : p.skip ? ` (${p.skip}: not judged)` : '';
    console.log(
      `  [${index + 1}/${cases.length}] ${sourced.case.id}: ${p.media.visuals.length} visual(s), ${frameCount(p.media)} frame(s), ${p.media.notes.length} note(s)${state}`,
    );
  }

  const judgedByModel = new Map<string, Judged[][]>();
  for (const model of models) {
    console.log(`\nJudging with ${model}:`);
    const judge = createDetailedEdgyJudge({ model: decisionModel, fallbackModel: model, feature: 'eval' });
    const judged: Judged[][] = [];
    for (const p of prepared) judged.push(await judgeCase(p, judge, args.repeats));
    judgedByModel.set(model, judged);
  }

  const scores: ModelScore[] = models.map((model) => {
    const judged = judgedByModel.get(model) ?? [];
    const runs: CaseRun[] = prepared.map((p, i) => ({
      id: p.sourced.case.id,
      label: p.sourced.case.label,
      pipelineFailed: p.pipelineFailed,
      judgments: (judged[i] ?? []).map((j) => j.judgment),
    }));
    return scoreRuns(model, runs);
  });

  console.log('');
  for (const model of models) {
    console.log(`${renderModelTable(model, prepared, judgedByModel.get(model) ?? [], args.show)}\n`);
  }
  console.log(
    'Verdicts: Y edgy (reposted), n not edgy, ? no verdict, - not asked (blind: only links that would not open).',
  );
  const withMedia = prepared.filter((p) => p.hadMedia);
  const failed = prepared.filter((p) => p.pipelineFailed).map((p) => p.sourced.case.id);
  console.log(
    `Pipeline: opened ${withMedia.length - failed.length} of ${withMedia.length} case(s) with media${failed.length > 0 ? `; FAILED: ${failed.join(', ')}` : ''}`,
  );
  for (const score of scores) console.log(renderScore(score, args.repeats));
  console.log(await costLine());

  const summary = getUsageSummary(0, Date.now() + DAY_MS);
  const result = {
    startedAt,
    finishedAt: new Date().toISOString(),
    decisionModel,
    models,
    repeats: args.repeats,
    signing: signer !== undefined,
    sources: files.map((f) => path.basename(f)),
    // Ids, counts and file names only: never a link, a note or what the judge said it saw.
    cases: prepared.map((p, i) => ({
      id: p.sourced.case.id,
      source: p.sourced.source,
      label: p.sourced.case.label,
      files: (p.sourced.case.files ?? []).map((f) => f.name),
      filesSaved: p.attachments.map((a) => a.name),
      ...p.stats,
      visuals: p.media.visuals.length,
      frames: frameCount(p.media),
      notes: p.media.notes.length,
      unreadableLinks: p.media.unreadableLinks.length,
      hadMedia: p.hadMedia,
      pipelineFailed: p.pipelineFailed,
      ...(p.skip ? { notJudged: p.skip } : {}),
      verdicts: Object.fromEntries(
        models.map((model) => [
          model,
          (judgedByModel.get(model)?.[i] ?? []).map((j) => ({
            judgment: j.judgment,
            ...(j.verdict ? { answeredBy: j.verdict.model } : {}),
            ...(j.verdict?.probability !== undefined ? { probability: j.verdict.probability } : {}),
          })),
        ]),
      ),
    })),
    scores,
    costUsd: summary.total.costUsd,
  };
  console.log(`\n${resultLine(scores, prepared)}`);
  console.log(`Full results (ids and file names only): ${writeResult(result, startedAt)}`);
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  },
);

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type CaseRun,
  judgmentMark,
  loadCaseFile,
  loadCaseSources,
  parseEvalArgs,
  redactJudgeLine,
  scoreRuns,
  validateCaseFile,
} from './cases';

// Placeholders only: the real cases live in the gitignored data/deleted-repost-cases.json.
const GIF_LINK = 'https://cdn.discordapp.com/attachments/1/2/dance.gif';
const CLIP_LINK = 'https://cdn.discordapp.com/attachments/1/3/clip.mp4';

const GIF_CASE = { id: 'gif-1', label: true, text: GIF_LINK };
const UPLOAD_CASE = {
  id: 'upload-1',
  label: true,
  text: '',
  files: [{ url: CLIP_LINK, name: 'clip.mp4', contentType: 'video/mp4' }],
  author: 'Nova',
  note: 'placeholder',
};
const PLAIN_CASE = { id: 'plain-1', label: false, text: 'omw, 10 min' };

function file(...cases: unknown[]) {
  return { version: 1, cases };
}

const tmpDirs: string[] = [];

function writeTemp(name: string, content: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deleted-repost-cases-'));
  tmpDirs.push(dir);
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, typeof content === 'string' ? content : JSON.stringify(content));
  return filePath;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('validateCaseFile', () => {
  it('accepts linked GIFs, uploads and plain text', () => {
    const { cases, errors } = validateCaseFile(file(GIF_CASE, UPLOAD_CASE, PLAIN_CASE), 'x.json');
    expect(errors).toEqual([]);
    expect(cases.map((c) => c.id)).toEqual(['gif-1', 'upload-1', 'plain-1']);
  });

  it('rejects the wrong shape at the top level', () => {
    expect(validateCaseFile([], 'x.json').errors).toEqual(['x.json: the file must be a JSON object']);
    expect(validateCaseFile({ version: 2, cases: [] }, 'x.json').errors).toEqual(['x.json: "version" must be 1']);
    expect(validateCaseFile({ version: 1 }, 'x.json').errors).toEqual(['x.json: "cases" must be an array']);
    expect(validateCaseFile({ version: 1, cases: [], comment: 'hi' }, 'x.json').errors).toEqual([
      'x.json: unknown field(s) comment',
    ]);
  });

  it('lists every problem in a case, so a typo cannot silently change it', () => {
    const { cases, errors } = validateCaseFile(
      file(
        GIF_CASE,
        { ...GIF_CASE, labl: true },
        { id: 'bad 2', label: 'yes', text: 5, author: '', note: 3 },
        { id: 'bad-3', label: false, text: '   ' },
        { id: 'bad-4', label: true, text: 'x'.repeat(4001) },
        'not a case',
      ),
      'x.json',
    );
    expect(cases).toEqual([]);
    expect(errors).toEqual([
      'x.json cases[1]: unknown field(s) labl',
      'x.json cases[1].id: duplicate id "gif-1"',
      "x.json cases[2].id: must be 1–64 letters, digits, '.', '_' or '-' (it goes into the result file)",
      'x.json cases[2].label: must be true (edgy) or false',
      'x.json cases[2].text: must be a string (the message text exactly as posted, "" for uploads only)',
      'x.json cases[2].author: must be a name of at most 80 characters',
      'x.json cases[2].note: must be a string',
      'x.json cases[3]: no text and no files, nothing to judge',
      'x.json cases[4].text: longer than a Discord message (4000 characters)',
      'x.json cases[5]: must be an object',
    ]);
  });

  it('keeps links out of ids, which go into the result file', () => {
    const { errors } = validateCaseFile(file({ ...GIF_CASE, id: GIF_LINK }), 'x.json');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/cases\[0\]\.id: must be 1–64 letters/);
  });

  it('checks every upload', () => {
    const { errors } = validateCaseFile(
      file(
        { ...UPLOAD_CASE, id: 'up-1', files: [] },
        { ...UPLOAD_CASE, id: 'up-2', files: Array.from({ length: 11 }, () => UPLOAD_CASE.files[0]) },
        {
          ...UPLOAD_CASE,
          id: 'up-3',
          files: [
            { url: 'ftp://example.com/a.gif', name: 'a.gif', size: 3 },
            { url: CLIP_LINK, name: 'attachments/1/3/clip.mp4' },
            { url: 'not a link', name: '', contentType: 'video' },
            'clip.mp4',
          ],
        },
      ),
      'x.json',
    );
    expect(errors).toEqual([
      'x.json cases[0].files: must be a list of 1–10 uploads (leave it out for none)',
      'x.json cases[0]: no text and no files, nothing to judge',
      'x.json cases[1].files: must be a list of 1–10 uploads (leave it out for none)',
      'x.json cases[2].files[0]: unknown field(s) size',
      'x.json cases[2].files[0].url: must be an http(s) link',
      'x.json cases[2].files[1].name: must be a file name (no slashes, at most 200 characters)',
      'x.json cases[2].files[2].url: must be an http(s) link',
      'x.json cases[2].files[2].name: must be a file name (no slashes, at most 200 characters)',
      'x.json cases[2].files[2].contentType: must be a media type like "image/gif"',
      'x.json cases[2].files[3]: must be an object',
    ]);
  });

  it('allows an upload with no text, and a content type with parameters', () => {
    const upload = { ...UPLOAD_CASE, files: [{ url: GIF_LINK, name: 'dance.gif', contentType: 'image/gif; x=1' }] };
    expect(validateCaseFile(file(upload), 'x.json').errors).toEqual([]);
  });
});

describe('loadCaseFile / loadCaseSources', () => {
  it('reads files in order and tags each case with its source', () => {
    const a = writeTemp('deleted-repost-cases.json', file(GIF_CASE));
    const b = writeTemp('more.json', file(PLAIN_CASE));
    expect(loadCaseSources([a, b]).map((c) => [c.source, c.case.id])).toEqual([
      ['deleted-repost-cases.json', 'gif-1'],
      ['more.json', 'plain-1'],
    ]);
  });

  it('rejects an id used in two files', () => {
    const a = writeTemp('a.json', file(GIF_CASE));
    const b = writeTemp('b.json', file(GIF_CASE));
    expect(() => loadCaseSources([a, b])).toThrow('Duplicate case id "gif-1" in b.json (also in a.json)');
  });

  it('explains unreadable or invalid files', () => {
    expect(() => loadCaseFile(writeTemp('broken.json', '{ nope'))).toThrow(/not readable JSON/);
    expect(() => loadCaseFile(writeTemp('invalid.json', file({ ...GIF_CASE, label: 1 })))).toThrow(
      /invalid:\n {2}invalid\.json cases\[0\]\.label: must be true \(edgy\) or false/,
    );
  });
});

describe('parseEvalArgs', () => {
  it('defaults to one call per case, nothing shown, no extra files', () => {
    expect(parseEvalArgs([])).toEqual({ repeats: 1, show: false, files: [] });
  });

  it('reads --repeats, --show and case files in any order', () => {
    expect(parseEvalArgs(['a.json', '--repeats', '3', '--show', 'b.json'])).toEqual({
      repeats: 3,
      show: true,
      files: ['a.json', 'b.json'],
    });
    expect(parseEvalArgs(['--repeats=5'])).toEqual({ repeats: 5, show: false, files: [] });
  });

  it('refuses a bad repeat count or an unknown option', () => {
    for (const bad of [['--repeats'], ['--repeats', '0'], ['--repeats=21'], ['--repeats', '2.5'], ['--repeats=x']]) {
      expect(parseEvalArgs(bad), bad.join(' ')).toEqual({ error: '--repeats takes a whole number from 1 to 20' });
    }
    expect(parseEvalArgs(['--verbose'])).toEqual({ error: 'unknown option --verbose' });
  });
});

describe('scoreRuns', () => {
  const run = (id: string, label: boolean, judgments: CaseRun['judgments'], pipelineFailed = false): CaseRun => ({
    id,
    label,
    pipelineFailed,
    judgments,
  });

  it('passes when every edgy case is caught on every call and nothing harmless is', () => {
    const score = scoreRuns('vision/model', [
      run('gif-1', true, ['edgy', 'edgy']),
      run('gif-2', true, ['edgy', 'edgy']),
      run('plain-1', false, ['not_edgy', 'no_verdict']),
    ]);
    expect(score).toMatchObject({
      positives: 4,
      caught: 4,
      negatives: 2,
      falsePositives: 0,
      recall: 1,
      judgeRecall: 1,
      falsePositiveRate: 0,
      pass: true,
    });
  });

  it('tells judge misses from pipeline failures and missing verdicts', () => {
    const score = scoreRuns('vision/model', [
      run('gif-1', true, ['edgy', 'not_edgy']),
      run('gif-2', true, ['not_judged', 'not_judged'], true),
      run('gif-3', true, ['no_verdict', 'edgy']),
      run('plain-1', false, ['edgy', 'not_edgy']),
    ]);
    expect(score).toMatchObject({
      positives: 6,
      caught: 2,
      judgeMisses: 1,
      pipelineMisses: 2,
      noVerdict: 1,
      negatives: 2,
      falsePositives: 1,
      pipelineFailures: 1,
      pass: false,
    });
    expect(score.recall).toBeCloseTo(2 / 6);
    // The judge's own share: only the cases whose media opened.
    expect(score.judgeRecall).toBeCloseTo(2 / 4);
    expect(score.falsePositiveRate).toBe(0.5);
  });

  it('fails on a pipeline failure even when the judge got it right from the words', () => {
    const score = scoreRuns('vision/model', [run('gif-1', true, ['edgy'], true)]);
    expect(score).toMatchObject({ caught: 1, pipelineFailures: 1, pass: false });
  });

  it('leaves a rate undefined without cases to compute it from', () => {
    const score = scoreRuns('vision/model', [run('gif-1', true, ['edgy'])]);
    expect(score.falsePositiveRate).toBeUndefined();
    expect(scoreRuns('vision/model', [run('plain-1', false, ['not_edgy'])]).recall).toBeUndefined();
  });

  it('marks each call with one character', () => {
    expect((['edgy', 'not_edgy', 'no_verdict', 'not_judged'] as const).map(judgmentMark).join('')).toBe('Yn?-');
  });
});

describe('redactJudgeLine', () => {
  it("takes the judge's description of what it saw out of its log lines", () => {
    expect(redactJudgeLine('messageJudge: vision/model says edgy=true (shows: a dancing cat (twice), captioned "hi")')).toBe(
      'messageJudge: vision/model says edgy=true (shows: hidden, pass --show)',
    );
    expect(
      redactJudgeLine('messageJudge: vision/model returned no verdict (finish=length): {"shows": "a dancing cat'),
    ).toBe('messageJudge: vision/model returned no verdict (finish=length): (answer hidden, pass --show)');
  });

  it('leaves every other line alone', () => {
    for (const line of [
      'messageJudge: typesafe/jev-1.13 says edgy=0.81',
      'messageJudge: vision/model says edgy=false',
      'deletedMessages: something (shows: kept)',
    ]) {
      expect(redactJudgeLine(line)).toBe(line);
    }
  });
});

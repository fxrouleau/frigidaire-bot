// Runs the gate eval over a set of cases with any classifier, and turns the probabilities into
// precision/recall/F1 per threshold. The live CLI (runEval.ts) wires in the real decision model; tests
// wire in a fake, so the arithmetic here is covered without an API key.
import type { AddressedClassifier } from '../addressed';
import { type GateEvalCase, caseToInput, passesPrefilter } from './cases';

export const EVAL_THRESHOLDS = [0.5, 0.6, 0.7, 0.8, 0.9];

export type EvalResult = {
  id: string;
  source: string;
  label: boolean;
  text: string;
  note?: string;
  /** undefined when the model gave no answer (counted as a "no", and listed). */
  probability?: number;
  prefilter: boolean;
};

export type Confusion = {
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  precision?: number;
  recall?: number;
  f1?: number;
};

export type EvalSettings = { names: string[]; followupSeconds: number; concurrency?: number };

export async function runCases(
  cases: Array<{ source: string; case: GateEvalCase }>,
  classify: AddressedClassifier,
  settings: EvalSettings,
  onProgress?: (done: number, total: number) => void,
): Promise<EvalResult[]> {
  const results: EvalResult[] = new Array(cases.length);
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < cases.length) {
      const index = next++;
      const { source, case: c } = cases[index];
      let probability: number | undefined;
      try {
        probability = await classify(caseToInput(c, settings.names));
      } catch {
        probability = undefined;
      }
      results[index] = {
        id: c.id,
        source,
        label: c.label,
        text: c.message.text,
        note: c.note,
        probability,
        prefilter: passesPrefilter(c, settings.names, settings.followupSeconds),
      };
      onProgress?.(++done, cases.length);
    }
  };
  const workers = Math.max(1, Math.min(settings.concurrency ?? 4, cases.length));
  await Promise.all(Array.from({ length: workers }, worker));
  return results;
}

/** Whether the bot would answer: the model says yes, and (end to end) the prefilter let it through. */
export function predicted(result: EvalResult, threshold: number, withPrefilter: boolean): boolean {
  if (withPrefilter && !result.prefilter) return false;
  return result.probability !== undefined && result.probability >= threshold;
}

export function confusionAt(results: EvalResult[], threshold: number, withPrefilter: boolean): Confusion {
  const counts = { tp: 0, fp: 0, fn: 0, tn: 0 };
  for (const result of results) {
    const yes = predicted(result, threshold, withPrefilter);
    if (yes && result.label) counts.tp++;
    else if (yes) counts.fp++;
    else if (result.label) counts.fn++;
    else counts.tn++;
  }
  const precision = counts.tp + counts.fp > 0 ? counts.tp / (counts.tp + counts.fp) : undefined;
  const recall = counts.tp + counts.fn > 0 ? counts.tp / (counts.tp + counts.fn) : undefined;
  const f1 =
    precision !== undefined && recall !== undefined && precision + recall > 0
      ? (2 * precision * recall) / (precision + recall)
      : undefined;
  return { ...counts, precision, recall, f1 };
}

function pct(value: number | undefined): string {
  return value === undefined ? '  n/a' : `${(value * 100).toFixed(1).padStart(5)}%`;
}

export function formatTable(results: EvalResult[], withPrefilter: boolean, thresholds = EVAL_THRESHOLDS): string {
  const rows = ['threshold  precision  recall     f1       tp  fp  fn  tn'];
  for (const threshold of thresholds) {
    const c = confusionAt(results, threshold, withPrefilter);
    rows.push(
      `${threshold.toFixed(2).padEnd(9)}  ${pct(c.precision).padEnd(9)}  ${pct(c.recall).padEnd(9)}  ${pct(c.f1).padEnd(7)}  ${String(c.tp).padStart(3)} ${String(c.fp).padStart(3)} ${String(c.fn).padStart(3)} ${String(c.tn).padStart(3)}`,
    );
  }
  return rows.join('\n');
}

/** Cases the gate gets wrong at `threshold`, most confidently wrong first. */
export function misclassified(results: EvalResult[], threshold: number, withPrefilter: boolean): EvalResult[] {
  const wrongness = (r: EvalResult) => (r.probability === undefined ? 1 : Math.abs(r.probability - threshold));
  return results
    .filter((r) => predicted(r, threshold, withPrefilter) !== r.label)
    .sort((a, b) => wrongness(b) - wrongness(a));
}

export function formatMisclassified(results: EvalResult[], threshold: number, withPrefilter: boolean): string {
  const wrong = misclassified(results, threshold, withPrefilter);
  if (wrong.length === 0) return '(none)';
  return wrong
    .map((r) => {
      const p = r.probability === undefined ? 'no answer' : `p=${r.probability.toFixed(2)}`;
      const kind = r.label ? 'MISSED  ' : 'FALSE+  ';
      const filtered = withPrefilter && !r.prefilter ? ' [prefilter drops it]' : '';
      return `${kind}${p.padEnd(9)} ${r.id} (${r.source})${filtered}: ${JSON.stringify(r.text)}${r.note ? ` — ${r.note}` : ''}`;
    })
    .join('\n');
}

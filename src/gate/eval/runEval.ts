// `yarn eval:gate [extra-cases.json ...]`: live evaluation of the addressed-to-bot gate.
//
// Runs every case in src/gate/eval/cases.json, plus data/gate-cases.json when it exists (the owner's
// gitignored cases from real chat) and any files given as arguments, through the real decision model
// (GATE_MODEL), then prints precision/recall/F1 at thresholds 0.5–0.9 (classifier alone, and end to end
// with the free prefilter in front) and every case misclassified at GATE_THRESHOLD. Paid: ~$0.00001 per
// case. Needs RUN_LIVE=1 and OPENROUTER_API_KEY (a .env file works too):
//   docker compose run --rm -e RUN_LIVE=1 -e OPENROUTER_API_KEY=sk-... test yarn eval:gate

// Must stay the first import: it applies .env before any module below reads config while loading.
import '../../loadEnv';
import * as fs from 'node:fs';
import * as path from 'node:path';
import process from 'node:process';
import { config } from '../../config';
import { createAddressedClassifier } from '../addressed';
import { gateSettingsFromConfig } from '../addressedGate';
import { loadCaseSources } from './cases';
import { EVAL_THRESHOLDS, formatMisclassified, formatTable, runCases } from './runner';

const BUNDLED_CASES = path.join(__dirname, 'cases.json');
const LOCAL_CASES = path.resolve('data', 'gate-cases.json');

async function main(args: string[]): Promise<number> {
  if (!process.env.RUN_LIVE || !config.openRouter.apiKey) {
    console.error('eval:gate calls the live decision model: set RUN_LIVE=1 and OPENROUTER_API_KEY.');
    return 2;
  }

  const files = [
    BUNDLED_CASES,
    ...(fs.existsSync(LOCAL_CASES) ? [LOCAL_CASES] : []),
    ...args.map((a) => path.resolve(a)),
  ];
  const cases = loadCaseSources(files);

  const settings = gateSettingsFromConfig();
  const model = config.gate.model;
  let cost = 0;
  const classify = createAddressedClassifier({
    model,
    feature: 'eval',
    onUsage: (usage) => {
      cost += usage.cost ?? 0;
    },
  });

  const positives = cases.filter((c) => c.case.label).length;
  console.log(
    `Gate eval: ${cases.length} cases (${positives} addressed, ${cases.length - positives} not) from ${files.map((f) => path.basename(f)).join(', ')}`,
  );
  console.log(
    `model=${model} threshold=${settings.threshold} followup=${settings.followupSeconds}s names=${settings.names.join(',')}\n`,
  );

  const results = await runCases(
    cases,
    classify,
    { names: settings.names, followupSeconds: settings.followupSeconds },
    (done, total) => {
      if (done % 10 === 0 || done === total) process.stdout.write(`  ${done}/${total}\r`);
    },
  );

  const unanswered = results.filter((r) => r.probability === undefined);
  const thresholds = [...new Set([...EVAL_THRESHOLDS, settings.threshold])].sort((a, b) => a - b);
  console.log('\nDecision model alone (every case):');
  console.log(formatTable(results, false, thresholds));
  console.log('\nEnd to end (prefilter, then the decision model):');
  console.log(formatTable(results, true, thresholds));
  console.log(`\nMisclassified end to end at threshold ${settings.threshold}:`);
  console.log(formatMisclassified(results, settings.threshold, true));
  if (unanswered.length > 0)
    console.log(`\n${unanswered.length} case(s) got no answer from the model (counted as "no").`);
  console.log(`\nCost: $${cost.toFixed(6)} (${results.length} calls)`);
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

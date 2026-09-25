// `yarn eval:persona` — runs every persona scenario against each model in EVAL_MODELS (default:
// CHAT_MODEL), has EVAL_JUDGE_MODEL grade the replies, prints a comparison table and writes the full
// results to EVAL_OUTPUT_DIR (default ./data/evals/, gitignored).
//
// Paid and opt-in like the live tests: needs RUN_LIVE=1 and OPENROUTER_API_KEY. Every call goes through
// the shared client (ZDR routing on every request). The bot's own state is never touched: memory and
// bot.db are in-memory for the run, and error captures and the log file are off.
//
//   docker compose run --rm -e RUN_LIVE=1 -e OPENROUTER_API_KEY=sk-... \
//     -e EVAL_MODELS=z-ai/glm-5.3-flash,moonshotai/kimi-k3 test yarn eval:persona
import * as fs from 'node:fs';
import * as path from 'node:path';
import process from 'node:process';
import * as dotenv from 'dotenv';
import { OpenRouterEmbeddingProvider } from '../../ai/memory/embeddingProvider';
import { requireOpenRouterClient } from '../../ai/openRouterClient';
import { OpenRouterProvider } from '../../ai/providers/openRouterProvider';
import { getUsageSummary } from '../../ai/usage';
import { flushPendingUsage } from '../../ai/usageFetch';
import { config } from '../../config';
import { BotDb, setBotDbForTesting } from '../../storage/botDb';
import { createLlmJudge } from './judge';
import { type EvalReport, renderComparisonTable, renderScenarioTable } from './report';
import { runPersonaEval } from './runner';
import { DEFAULT_SCENARIOS_PATH, loadScenarioFile, selectScenarios } from './scenarioFile';

dotenv.config({ quiet: true });

function writeReport(report: EvalReport, dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `persona-${report.startedAt.replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  return file;
}

async function main(): Promise<number> {
  if (!config.evals.runLive || !config.openRouter.apiKey) {
    console.error('yarn eval:persona makes paid OpenRouter calls: set RUN_LIVE=1 and OPENROUTER_API_KEY.');
    return 2;
  }

  // Keep the bot's real data out of it: no error captures, no lines in the bot's log file, and bot.db
  // in memory (it holds the usage ledger, which prices each run below).
  process.env.DEBUG_CAPTURE = '0';
  process.env.LOG_FILE = 'off';
  setBotDbForTesting(new BotDb(':memory:'));

  const file = loadScenarioFile(DEFAULT_SCENARIOS_PATH);
  const scenarios = selectScenarios(file, config.evals.scenarioIds);
  const models = config.evals.models;
  const judgeModel = config.evals.judgeModel;
  console.log(
    `Persona eval: ${scenarios.length} scenario(s) × ${models.length} model(s) [${models.join(', ')}], judge ${judgeModel}`,
  );

  const report = await runPersonaEval({
    file,
    scenarios,
    models,
    judgeModel,
    deps: {
      makeProvider: (model) => new OpenRouterProvider({ model }),
      judge: createLlmJudge({ client: requireOpenRouterClient('the persona eval judge'), model: judgeModel }),
      makeEmbeddings: () => (config.memory.semanticEnabled ? new OpenRouterEmbeddingProvider() : undefined),
      spendSoFar: async () => {
        await flushPendingUsage();
        return getUsageSummary(0, Date.now() + 24 * 60 * 60 * 1000).total.costUsd;
      },
      log: (line) => console.log(line),
    },
  });

  console.log(`\n${renderScenarioTable(report.runs, report.models, report.scenarioIds)}`);
  console.log(`\n${renderComparisonTable(report.summary)}`);
  console.log(`\nFull results: ${writeReport(report, config.evals.outputDir)}`);
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error('Persona eval failed:', error);
    process.exitCode = 1;
  });

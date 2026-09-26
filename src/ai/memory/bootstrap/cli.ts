// `yarn memory <command>` locally, `node dist/ai/memory/bootstrap/cli.js <command>` in the prod container
// (run it as the node user: `docker exec -u node frigidaire-bot node dist/ai/memory/bootstrap/cli.js …`,
// so the files it writes in the data volume stay the bot's). The commands: commands.ts.

// Must stay the first import: it applies .env before any module below reads config while loading.
import '../../../loadEnv';
import process from 'node:process';
import { getModelCatalog } from '../../modelCatalog';
import { getOpenRouterClient } from '../../openRouterClient';
import { flushPendingUsage } from '../../usageFetch';
import { runNightlyDream } from '../notes/dreamer';
import { DEFAULT_DATA_DIR, openDataStores, runCli } from './commands';

async function main(): Promise<number> {
  // The CLI prints its own output: the bot's rotated log file and error captures stay the bot's.
  process.env.LOG_FILE = 'off';
  process.env.DEBUG_CAPTURE = '0';
  let stores: ReturnType<typeof openDataStores> | undefined;
  try {
    return await runCli(process.argv.slice(2), {
      io: { out: (line) => console.log(line), err: (line) => console.error(line) },
      openStores: () => {
        stores ??= openDataStores(DEFAULT_DATA_DIR);
        return stores;
      },
      client: () => getOpenRouterClient(),
      priceOf: (model) => getModelCatalog().pricing(model),
      dream: ({ memory, notes }, client, maxPeople) => runNightlyDream({ memory, notes, client, maxPeople }),
    });
  } finally {
    // The usage ledger records each call's cost in the background: let it land before exiting.
    await flushPendingUsage();
    stores?.memory.close();
    stores?.archive.close();
  }
}

void main().then((code) => process.exit(code));

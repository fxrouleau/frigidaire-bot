// Loads a local .env into process.env. Every entry point (app.ts, the eval CLIs) imports this FIRST:
// CommonJS runs a file's imports, in order, before its own body, and some modules read config while
// they load (the learner singleton snapshots LEARNING_INTERVAL_MS and LEARNER_IGNORE_CHANNELS, the memory
// store picks its embedder from OPENROUTER_API_KEY), so a dotenv.config() in the entry point's body
// would run too late for them. Prod passes real env vars (Portainer, compose env_file); this only
// matters for `.env`-based runs.
import * as dotenv from 'dotenv';

dotenv.config({ quiet: true });

# Frigidaire Bot

## Overview

A Discord bot built in **TypeScript** that hangs out in a private server as "one of the group". Core features:

1. **AI Chat** — Mention the bot to converse. A single AI backend (OpenRouter) with multi-round tool-calling, vision (images/emojis/stickers), and native web search.
2. **Long-Term Memory** — Persists facts, server-member identities, and emoji captions in SQLite. Retrieval is **semantic**: memories are embedded (OpenRouter embeddings API) and searched by cosine similarity, hybridized with FTS5 keyword search. Relevant memories are injected into the system prompt. A background "personality learner" observes channels off-mention to learn the server's vibe.
3. **Message Summarization** — Ask the bot to summarize recent channel history (via the `summarize_messages` tool).
4. **Link Replacement** — Rewrites Twitter/X (`fixvx.com`), Instagram (`zzinstagram.com`), and TikTok (`tnktok.com`) links for proper Discord embedding, reposting via webhooks to preserve the original author's appearance.

## Tech Stack

- **Runtime**: Node.js v26 (`node:26-alpine`)
- **Language**: TypeScript 5.9 (strict mode, target `es2024`, `commonjs` modules)
- **Package Manager**: Yarn v4.7 (via Corepack, node-modules linker)
- **AI**: OpenRouter via the `openai` SDK (`baseURL: https://openrouter.ai/api/v1`)
- **Storage**: `better-sqlite3` at `./data/memory.db` (memories + FTS5 + embedding vectors, identities, emojis, learner state)
- **Images**: `sharp` for resizing/encoding
- **Linter/Formatter**: Biome — 120-char line width, 2-space indent, single quotes, trailing commas
- **Tests**: Vitest 4
- **Deployment**: Docker (single container). **Dev/test toolchain is fully containerized** — the host needs only Docker.

## Project Structure

```
src/
├── app.ts                          # Entry point — Discord client, dynamic event loading, startup tasks
├── logger.ts  utils.ts             # Console logger; splitMessage()/repostMessage() helpers
├── ai/
│   ├── agent.ts                    # AgentOrchestrator — main conversation/tool loop (DI-friendly)
│   ├── agentInstance.ts            # Shared AgentOrchestrator singleton
│   ├── conversationStore.ts        # In-memory per-channel state with timeout
│   ├── providerRegistry.ts         # Resolves the AI provider for a channel
│   ├── tools.ts                    # Host tool definitions (summarize, image, memory, self-diagnosis)
│   ├── types.ts  utils.ts          # Core types; formatTimestampET() + misc helpers
│   ├── debugCapture.ts             # Writes failed exchanges to data/debug/*.json for replay
│   ├── failureLogger.ts            # Structured failure logging (capability gaps, parse failures)
│   ├── personalityLearner.ts       # Off-mention background observer (vibe + self-improvement)
│   ├── learnerInstance.ts          # Shared PersonalityLearner singleton
│   ├── emojiSync.ts emojiCaptioner.ts  # Reconcile guild emojis to DB; caption via a vision model
│   ├── memory/
│   │   ├── memoryStore.ts          #   SQLite store: memories + FTS5 + memory_embeddings, identities, emojis
│   │   ├── embeddingProvider.ts    #   EmbeddingProvider iface + OpenRouterEmbeddingProvider (ZDR routing)
│   │   ├── vectorMath.ts           #   dot/cosine/normalize + Float32Array ↔ SQLite BLOB conversion
│   │   └── wordOverlap.ts          #   Jaccard word-overlap (lexical dedup fallback)
│   ├── providers/openRouterProvider.ts # The single AiProvider implementation
│   └── tools/                      # summary.ts (summarization prompt) + localImageGenerator.ts (image gen)
├── events/                         # Dynamically loaded Discord event handlers:
│   ├── aiChat.ts                   #   bot-mention → AgentOrchestrator
│   ├── {twitter,instagram,tiktok}Repost.ts  # link replacement via webhooks
│   ├── emoji{Create,Delete,Update,Ready}.ts # sync emoji DB w/ guild; startup reconcile+caption
│   ├── emojiUsageTracker.ts identityTracker.ts reactionTracker.ts  # usage/identity/reaction tracking
│   ├── learnerActivityTracker.ts   #   feeds channel activity to the personality learner
│   └── ready.ts                    #   client-ready logger
└── test-support/                   # Shared TEST helpers (excluded from prod build; type-checked separately)
    ├── fakeProvider.ts             #   FakeProvider — scripted AiProvider for orchestration tests
    ├── fakeDiscord.ts              #   createFakeMessage()/createFakeBotMessage() — typed discord.js fakes
    ├── fakeEmbeddings.ts           #   FakeEmbeddingProvider — deterministic offline embeddings for tests
    ├── openRouterFetch.ts          #   replay/record OpenAI-SDK clients backed by JSON fixtures
    ├── recorder.ts  replayCli.ts   #   call-recorder util; the `yarn replay` command
    └── fixtures/openrouter/*.json  #   committed, hand-authored OpenRouter response shapes (chat + embeddings)

# Tests are colocated as src/**/*.test.ts (~360). Live tests (opt-in, paid): src/**/*.live.test.ts
```

## Architecture

### Event-Driven Design
- `app.ts` dynamically loads every non-`.test` `.ts`/`.js` file from `src/events/` as a Discord event handler.
- Each event file exports `{ name, once?, execute(...args) }`.
- Adding a handler = creating a file in `src/events/`; no changes to `app.ts` needed.
- On startup `app.ts` also runs memory compaction (which includes the ephemeral TTL sweep), kicks off the embedding backfill, re-runs the sweep + backfill every `BACKFILL_INTERVAL_MS` as a self-heal, and starts the personality learner once the client is ready.

### Single-Provider AI System
- **`AiProvider` interface** (`src/ai/types.ts`): `id`, `displayName`, `personality`, `defaultModel`, `supportedTools`, `chat()`, plus optional `summarizeMessages()` / `generateImage()` / `generateImageLocal()`.
- **`OpenRouterProvider`** is the only implementation. It builds OpenAI-style chat requests, attaches function tools + OpenRouter's native `web_search`, sends an OpenRouter `provider` routing object (default `{ zdr: true, sort: 'throughput' }`), and parses the response back into normalized entries. Constructor takes DI options (`client`, `model`, `routing`) so tests can inject a fixture-backed client.
- **Tools** are defined once in `src/ai/tools.ts` and exposed to the model as function tools. Host tools (executed by this bot): `summarize_messages`, `generate_image`, `remember_fact`, `recall_memories`, `forget_memory`, `query_long_term_memory`, `query_self_diagnosis`. `web_search` is provider-handled (not host).

### Conversation Flow (`AgentOrchestrator.handleMention`)
1. Resolve the provider; start the typing loop.
2. Fetch/create per-channel state (on first mention, seed history from the last ~25 messages).
3. Build the developer/system prompt (persona + injected memories/identities/usable emojis + current ET time) and the new user entry. The emoji section is framed for restraint ("use sparingly" — most messages should have no emoji at all), not as a capability list.
4. Call `chat()` with `tool_choice: auto`. Execute any **host-handled** tool calls, append results, and loop (`chat()` → execute) for up to `MAX_TOOL_ROUNDS` rounds / `MAX_TOOL_INVOCATIONS` total tool calls. On the last allowed round, or once the invocation cap is exceeded, force a text-only response (`tool_choice: none`).
5. Send the reply (split into Discord-sized chunks), persist updated state.
- Constructor accepts DI options `{ resolveProvider, tools, timeoutMs, maxToolRounds, maxToolInvocations }` purely to make the loop testable.

### Long-Term Memory & Learning

- `MemoryStore` (`./data/memory.db`): memories (+ FTS5 index + embedding vectors), server-member identities, emoji rows (name/caption/use-count), and learner state. The prompt builder injects capped, relevance-ranked memories each turn.
- `PersonalityLearner` runs on an interval (off-mention) to record server "vibe" memories and, optionally, bot self-improvement signals. Emojis are reconciled to the DB on startup and captioned by a vision model.

**Learner prompt rules (what gets saved).** The learner's prompts enforce durable-knowledge-over-transcription — these rules exist because the original prompts filled the prod DB with per-message logging (see the memory curation report):
- **The 30-day test**: only knowledge still true and useful in 30 days gets saved (jobs, preferences, relationships, habits, goals, server culture). "Someone asked/confirmed/declined/arrived/shared X" is transcription, never a memory.
- **Ephemeral categories**: time-bound observations MUST use `event` (TTL ~14 days); image/GIF-share observations MUST use `image` (TTL ~24h). The TTL sweep expires both automatically — but only if the category is right, which is why the prompts are strict about it. An image that reveals a durable fact gets saved as `fact` instead.
- **No re-saves**: traits/issues already in the injected existing-memories context are never saved again (save-time semantic dedup is the backstop, not the primary defense).
- **Subject normalization**: subjects use the person's **current display name** from the identities list (+ `subject_user_id` as the stable identity anchor), never nicknames, in-game names, or stale usernames — keeping new memories consistent with every `getBySubject()` lookup and all existing subject-keyed memories.
- Observations stay authentic/verbatim — there is deliberately **no censoring or paraphrasing rule** for offensive content (Felix's explicit call; do not add one).

**Embeddings (`src/ai/memory/embeddingProvider.ts`).** `OpenRouterEmbeddingProvider` calls OpenRouter's `/embeddings` endpoint (default model `qwen/qwen3-embedding-8b`, env `EMBEDDING_MODEL`) with the same DI pattern as the chat provider (`{ client?, model?, routing? }`). Two non-negotiables:
- **ZDR routing**: every embeddings request sends `provider: { zdr: true }` — memory text is the same private content the chat path protects. Never ship an embedding path without it.
- **Asymmetric retrieval**: search queries are embedded with the qwen3 instruct prefix (`Instruct: {task}\nQuery: {text}`); stored memories ("documents") are embedded bare. Vectors are L2-normalized before storage, so cosine similarity is a plain dot product.
- `makeDefaultEmbeddingProvider()` wires the embedder into the `MemoryStore` singleton (`tools.ts`). It returns `undefined` (→ FTS5-only legacy mode, never throws) when `OPENROUTER_API_KEY` is missing, when the `SEMANTIC_MEMORY_ENABLED` kill switch is off, or inside Vitest (test hermeticity guard).

**Hybrid search (`MemoryStore.search()`, async).** Vector-primary with FTS5 as a keyword booster:
1. Embed the query; score every active memory's stored vector by cosine (in-memory vector cache, write-through).
2. Run the FTS5 keyword leg (BM25-ranked).
3. Fuse both legs with Reciprocal Rank Fusion (k=60; vector weight 1.0, keyword weight 0.5).
4. **Semantic gate**: every returned memory must score cosine ≥ `MEMORY_RELEVANCE_THRESHOLD` (default 0.35). Keyword-only hits on un-embedded memories are dropped — FTS can boost rank but never introduce a semantically irrelevant result.
5. **Ungated FTS fallback** (legacy behavior): no embedder configured (silent — that's normal FTS5-only mode), the query embed failed, or fewer than 80% of searchable memories have current-model vectors (fresh DB, mid-backfill, model switch). The latter two log at WARN so degraded retrieval is visible in prod logs.
- Self-diagnosis categories (`capability_gap`, `tool_error`, …; see `SELF_DIAGNOSIS_CATEGORIES`) are excluded from search entirely — they're reachable only via `query_self_diagnosis`, whose output carries `[id:N]` prefixes so `forget_memory` works on them.

**Save (`MemoryStore.save()`, async).** Two phases:
1. *Synchronous* (before any `await`): lexical word-overlap dedup + INSERT/UPDATE + FTS sync in one transaction. The row is durable when this returns — fire-and-forget callers (`failureLogger`) and tests that read back immediately stay correct.
2. *Async, best-effort*: embed the memory, run semantic dedup (cosine ≥ `MEMORY_DEDUP_THRESHOLD`, default 0.88, within the same category+subject group), store the vector. A semantic duplicate **merges into the existing memory id** (ids are user-visible via `recall_memories`/`forget_memory`). Failures here never lose the memory — the backfill heals missing vectors later.

**Backfill (`MemoryStore.backfillEmbeddings()`).** Idempotent, batched (32/request): embeds every active memory lacking a current-model vector. Runs at startup and every `BACKFILL_INTERVAL_MS` (app.ts), healing memories saved during API outages and re-embedding everything after an `EMBEDDING_MODEL` switch (expand-contract: old-model vectors are pruned per-memory only once the new-model vector exists).

**Compaction (`MemoryStore.compact()`, sync, startup).** Expires ephemeral memories (see below), sweeps orphaned vectors, dedups within (subject, category) groups — by cosine when both sides have stored vectors, word-overlap otherwise — and refreshes query-planner stats. Operational notes (measured at real prod scale, ~2k memories): the cosine pass costs ~1s of synchronous startup time; the DB file grows from ~1MB to ~32MB once vectors are backfilled; and cosine dedup only kicks in from the **second** startup after first deploy (the first compact() runs before any vectors exist).

**Ephemeral memory TTL (`MemoryStore.sweepExpiredMemories()`).** Image and event memories are moments, not durable facts — they expire (soft-delete via `deactivate()`: FTS index, vectors, and the in-memory cache are all cleaned; reversible) once their `updated_at` is older than the per-category TTL (image: 24h, event: 14 days; env-configurable, 0 disables). The clock is `updated_at`, so a dedup-merge re-observation restarts the TTL window; the boundary is strict (`<`). Runs as step 0 of `compact()` (startup) and in the periodic maintenance interval in app.ts (before each backfill, so expiring memories never waste embed calls). First-deploy note: every pre-existing image/event memory already past its TTL expires on the first sweep (~250 rows in today's prod DB — the same rows the curation pass deactivates); set the TTL env vars to 0 before first boot to opt out.

### Memory schema & model-switch runbook

Tables in `./data/memory.db` (all DDL is idempotent `CREATE ... IF NOT EXISTS`, applied in `MemoryStore.init()`):

| Table | Contents |
|---|---|
| `memories` | id, category, subject, content, source, timestamps, active flag, subject_user_id |
| `memories_fts` | FTS5 external-content index over memories (content/subject/category) |
| `memory_embeddings` | id, memory_id (FK → memories, ON DELETE CASCADE), model, dims, input_text, vector BLOB, created_at; `UNIQUE(memory_id, model)` |
| `identities` / `emojis` / `learner_state` | unchanged by the semantic-memory feature |

- **Vectors** are L2-normalized little-endian Float32 BLOBs; `CHECK (length(vector) = dims * 4)` makes truncated blobs impossible to commit. Read/write via `vectorMath.blobToVector()`/`vectorToBlob()` (alignment-safe — never construct a Float32Array directly over a better-sqlite3 Buffer).
- **`input_text`** records the exact string that was sent to the embeddings API (`"subject: content"`, see `buildEmbeddingInput()`) — an audit trail for debugging vector quality. Re-embedding (backfill, model switch) always builds its input from the memory's **current** content, never from this stored copy, so a vector can never be regenerated from stale text.
- **Referential integrity**: the FK cascades on hard `remove()`; `deactivate()` deletes vector rows explicitly in the same transaction; `compact()`'s orphan sweep is the backstop.
- **1 row per (memory, model)**: during a model transition a memory can hold vectors for both models; search only ever reads current-model vectors.

**Model-switch runbook** (changing `EMBEDDING_MODEL`):
1. Verify the new model has ZDR endpoints and sane thresholds: `RUN_LIVE=1 EMBEDDING_MODEL=<new> ... yarn test:live` (the calibration test prints cosine values for related/duplicate/unrelated pairs — grep `CALIBRATION`).
2. Set `EMBEDDING_MODEL` and restart. Search falls back to ungated FTS (WARN logs) while new-model vector coverage is below 80%.
3. The startup backfill re-embeds every active memory (from its current content, via `buildEmbeddingInput()`); old-model vectors are pruned per-memory as new ones land. At ~2k memories this is ~60 batched API calls (<$0.01).
4. Adjust `MEMORY_RELEVANCE_THRESHOLD` / `MEMORY_DEDUP_THRESHOLD` if the calibration output says the new model's cosine distribution differs.
5. Rollback = revert `EMBEDDING_MODEL`: memories still holding old-model vectors work instantly; the rest backfill again.

**Kill switch**: `SEMANTIC_MEMORY_ENABLED=0` reverts to FTS5-only keyword retrieval instantly (no code rollback, no data loss — vectors stay in place for when it's re-enabled). One deliberate difference from true pre-semantic behavior remains: self-diagnosis categories stay excluded from `search()` even in FTS-only mode.

### Error Capture & Replay
- When the agent loop throws in production, `debugCapture.ts` writes the full conversation + raw error/response payload to `data/debug/error-<timestamp>-<rand>.json` (keeps the newest 50). On by default; set `DEBUG_CAPTURE=0` to disable, `DEBUG_CAPTURE_DIR` to relocate.
- These captures (and the committed fixtures) replay locally with `yarn replay <file>` to reproduce the exact failure offline and for free.

### Key Types (`src/ai/types.ts`)
- `NormalizedContentPart`: `{ type: 'text', text } | { type: 'image', url }` (plus optional `thoughtSignature`).
- `ConversationEntry`: `message | tool_call | tool_result`.
- `ProviderToolDefinition` / `ProviderToolCall` / `ProviderChatResponse` / `ToolDefinition` / `ToolHandlerContext`.

## Commands

The dev/test toolchain runs entirely in Docker — the host does **not** need Node, Yarn, or `node_modules`. Use either passwordless `sudo`, or add yourself to the docker group once (`sudo usermod -aG docker $USER`, then re-login) and drop the `sudo`.

```bash
sudo docker compose build test                       # build/rebuild the test image (once, and after package.json/yarn.lock changes)
sudo docker compose run --rm test                    # run the full test suite (default CMD = yarn test)
sudo docker compose run --rm test yarn test          # same, explicit
sudo docker compose run --rm test yarn typecheck     # strict TS over ALL of src/ incl. tests (tsconfig.test.json)
sudo docker compose run --rm test yarn check         # Biome lint+format with --fix (writes back to host via the mount)
sudo docker compose run --rm test yarn check:ci      # Biome check WITHOUT fixing (what CI runs)
sudo docker compose run --rm test yarn build         # tsc build
sudo docker compose run --rm test yarn replay data/debug/error-X.json   # replay a prod error capture / fixture

# Full CI gate locally (lint + typecheck + build + tests, exactly as CI runs it):
sudo docker build --target ci .

# Opt-in LIVE API tests (paid, ~cents — hits real OpenRouter): chat smoke tests + the embeddings
# ZDR canary / threshold-calibration test (grep output for CALIBRATION):
sudo docker compose run --rm -e RUN_LIVE=1 -e OPENROUTER_API_KEY=sk-... test yarn test:live

# Update yarn.lock after editing package.json (no host Yarn needed):
sudo docker run --rm -v "$PWD":/app -w /app -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 -e LEFTHOOK=0 \
  node:26-alpine sh -c "npm install -g corepack >/dev/null 2>&1 && corepack enable && yarn install --mode=update-lockfile"
```

Running prod via Compose: `sudo docker compose up -d frigidaire-bot` (builds the `prod` target; `./data` is volume-mounted).

Local Yarn (`corepack enable && yarn install && yarn test` / `yarn dev`, etc.) still works **if** the host happens to have Node 26 — optional, mainly for IDE intellisense.

**After any change, run tests + typecheck + check via `docker compose` before handoff** to ensure test, type, lint, and build health.

## Environment Variables

**Required (prod):**
```
CLIENT_SECRET=<discord_bot_token>
OPENROUTER_API_KEY=<openrouter_api_key>
```

**Optional:**
```
CHAT_MODEL=<model>                   # Default chat model (default: deepseek/deepseek-v3.2:nitro)
IMAGE_MODEL=<model>                  # Image generation model (default: google/gemini-2.5-flash-image)
EMOJI_CAPTION_MODEL=<model>          # Vision model for emoji captions (default: anthropic/claude-opus-4.7)
EMOJI_FORCE_RECAPTION=<bool>         # Force re-captioning all emojis on startup
CONVERSATION_TIMEOUT_MS=<ms>         # Per-channel conversation timeout (default: 900000 / 15 min)
MAX_TOOL_ROUNDS=<n>                  # Max tool-call rounds per turn (default: 10)
MAX_TOOL_INVOCATIONS=<n>             # Max total tool calls per turn (default: 50)
DEBUG_CAPTURE=<0|...>                # Error capture; ON by default, '0' disables
DEBUG_CAPTURE_DIR=<path>             # Error capture output dir (default: ./data/debug)
LEARNING_INTERVAL_MS=<ms>            # Personality learner interval (default: 1800000 / 30 min)
MIN_MESSAGES_FOR_OBSERVATION=<n>     # Min new messages before the learner observes (default: 5)
LEARNER_IGNORE_CHANNELS=<csv ids>    # Channels the learner skips
LEARNER_MODEL=<model>                # Model used by the personality learner
SELF_IMPROVEMENT_ENABLED=<bool>      # Learn bot self-improvement signals (default: true)
SELF_IMPROVEMENT_MODEL=<model>       # Model for self-improvement analysis

# Semantic memory (embedding-based retrieval):
SEMANTIC_MEMORY_ENABLED=<bool>       # Kill switch (default: true). false/0 => FTS5-only keyword retrieval
EMBEDDING_MODEL=<model>              # Embedding model (default: qwen/qwen3-embedding-8b; must have ZDR endpoints)
MEMORY_RELEVANCE_THRESHOLD=<0..1>    # Search semantic gate: min cosine to return a memory (default: 0.35)
MEMORY_DEDUP_THRESHOLD=<0..1>        # Save/compact dedup: cosine at/above which memories merge (default: 0.88)
EMBEDDING_QUERY_INSTRUCTION=<text>   # Override the qwen3 query instruct task description
BACKFILL_INTERVAL_MS=<ms>            # Periodic embedding backfill/self-heal interval (default: 1800000 / 30 min)
MEMORY_TTL_IMAGE_HOURS=<n>           # Ephemeral TTL: image memories expire n hours after last update (default: 24; 0 disables)
MEMORY_TTL_EVENT_DAYS=<n>            # Ephemeral TTL: event memories expire n days after last update (default: 14; 0 disables)
LOG_DEBUG=<1>                        # Enable debug logging (per-search cosine score distributions for threshold calibration)
```

For tests: `RUN_LIVE=1` enables the live smoke tests (also needs `OPENROUTER_API_KEY`).

## Testing

- **Vitest 4**, tests colocated as `src/**/*.test.ts` (~360 tests). Convention: new code at the **OpenRouter or Discord boundary should ship with fixture/fake-based tests**.
- **Test hermeticity**: tests can never touch `./data/memory.db` or the network. `getMemoryStore()` auto-constructs an in-memory store under Vitest when nothing is injected, and `makeDefaultEmbeddingProvider()` returns `undefined` inside Vitest. Tests that need memory inject `new MemoryStore(':memory:', { embeddings: new FakeEmbeddingProvider() })` via `setMemoryStoreForTesting()`.
- `src/test-support/` holds shared helpers — **excluded from the prod build** (`tsconfig.json`) but **type-checked strictly** via `tsconfig.test.json`:
  - **`fakeProvider.ts`** — `FakeProvider`, a scripted `AiProvider` for deterministic orchestration tests (multi-round tool calls, forced text, errors); records every `chat()` input. Builders: `textResponse()`, `toolCallResponse()`, `errorStep()`.
  - **`fakeDiscord.ts`** — `createFakeMessage()` / `createFakeBotMessage()`: typed discord.js `Message` fakes with recorders for `reply` / `send` / `sendTyping` / `messages.fetch` / `createWebhook` / `delete` (+ per-webhook `send`/`delete`). Uses real `Collection`s so `.size`/`.values()`/`.has()` behave like prod.
  - **`fakeEmbeddings.ts`** — `FakeEmbeddingProvider`: deterministic offline embeddings (bag-of-words hash vectors, 128 dims, normalized) — texts sharing words get high cosine, so gate/dedup/fusion tests are meaningful without API access. Records every `embed()` call; `failWith` injects API-outage errors.
  - **`openRouterFetch.ts`** — `createReplayClient()` / `createSequenceReplayClient()` / `loadFixture()`: OpenAI-SDK clients whose HTTP layer serves recorded JSON, so the provider's **real** request-building + response-parsing run offline and free. `createRecordingClient()` refreshes fixtures against the live API. Endpoint-agnostic — serves chat and embeddings fixtures alike.
  - **`fixtures/openrouter/*.json`** — committed response shapes: text, single/multi tool calls, text-with-tool-call, malformed args, empty tool-call id, Bedrock-style no-choices error, HTTP 500, embeddings success (un-normalized vectors), embeddings HTTP 500.
  - **`replayCli.ts`** backs `yarn replay`; **`recorder.ts`** is the recorder util (no test-runner imports, so usable from both Vitest and the ts-node CLI).
- **Live tests** (`src/**/*.live.test.ts`, run via `yarn test:live`) are `describe.skipIf`-gated, running only with `RUN_LIVE=1` + `OPENROUTER_API_KEY`. Shape-only assertions tolerate non-determinism; routing can pin a backend (e.g. `only: ['amazon-bedrock']`) to reproduce backend-specific bugs.
  - `openRouterProvider.live.test.ts` — chat-path smoke tests.
  - `embeddingProvider.live.test.ts` — **ZDR canary** (fails loudly if the default embedding model has no Zero-Data-Retention endpoints — in prod that would mean permanent FTS fallback) + **threshold calibration**: prints real cosine values for related/near-duplicate/unrelated memory pairs (grep `CALIBRATION`) to tune `MEMORY_RELEVANCE_THRESHOLD` / `MEMORY_DEDUP_THRESHOLD`, at full and MRL-truncated dimensions.

### Prod-error → regression-test workflow
1. Bot errors in prod → `data/debug/error-<timestamp>.json` is written automatically.
2. Copy that file off the server to your machine.
3. `sudo docker compose run --rm test yarn replay <file>` reproduces the bug locally (exit code 1 = still reproduces).
4. Fix the code.
5. Sanitize the payload, move it into `src/test-support/fixtures/openrouter/`, and add a small regression test that loads it via `loadFixture()` / a replay client.

## Continuous Integration

Both workflows are **containerized** — they build the `ci` Docker stage with GitHub Actions layer caching (`cache-from/to: type=gha`) instead of running Yarn on the runner. The `ci` stage runs `check:ci`, `typecheck`, `build`, and `test` at image-build time, so a green build is the full gate.

- **`.github/workflows/docker-build.yml`** — PR checks: builds the `ci` stage, then runs Gitleaks + Semgrep on the runner, then a prod-image build.
- **`.github/workflows/docker-push.yml`** — on push to `master`: builds the `ci` stage, then builds and pushes the `prod` image to DockerHub (tagged `latest`, date, and `sha-<short>`).

## Conventions

- **Tests exist (~360)** — run them (plus `typecheck` and `check`) via `docker compose` before handoff. There is no separate `yarn dev` test step.
- **Biome** handles all formatting and linting (no ESLint/Prettier). It **ignores `src/**/*.test.ts`** and `src/test-support/fixtures` — tests are not formatted/linted, but `tsconfig.test.json` type-checks them strictly.
- camelCase for functions/variables, PascalCase for classes/interfaces.
- Strict TypeScript — no `any`.
- Async/await throughout; `Promise.all()` for parallel work.
- Error handling generally returns user-facing strings rather than throwing.

## Tooling Notes

- `CLAUDE.md` is a symlink to `AGENTS.md` — they are the same file. Git tracks it as `AGENTS.md`.
- **Persisted data lives in `./data`** (SQLite DB + error captures). Prod **must** volume-mount it (`./data:/app/data`, as `docker-compose.yaml` does) or memories and captures are lost whenever the container is recreated. When first adding the mount to an already-running server, `docker cp` the in-container `/app/data/memory.db` out to the host `./data` first, or you'll start from an empty DB. Expect the DB file to sit at ~32MB once embedding vectors are backfilled (~2k memories × 16KB/vector) — that's normal, not bloat.
- The Docker image installs Corepack from npm (`npm install -g corepack`) — it is no longer bundled with Node 25+.
- Discord typing indicator loops every 8 seconds during AI processing.
- **Cloud / Claude Code on the web (no-Docker fallback)**: Corepack can't download Yarn v4 directly (the proxy blocks `repo.yarnpkg.com`), but Yarn v4 is reachable via npm. Use npm to install deps and run scripts, and run tests with `npx vitest run`:
  ```bash
  npm install && npx vitest run && npx tsc -p tsconfig.test.json && npx biome check --fix src/
  ```
  Set `LEFTHOOK=0` when committing (the pre-commit hook depends on Yarn). **Do NOT commit `package-lock.json`** — it's an npm side effect; leave it unstaged.
  **When adding/removing packages**, also commit an updated `yarn.lock`. Generate a proper Yarn v4 lockfile via npm:
  ```bash
  npm pack @yarnpkg/cli-dist@4.7.0 && mkdir -p /tmp/yarn-setup && tar -xzf yarnpkg-cli-dist-4.7.0.tgz -C /tmp/yarn-setup
  git checkout -- yarn.lock   # restore original before updating
  node /tmp/yarn-setup/package/bin/yarn.js install
  rm -f yarnpkg-cli-dist-4.7.0.tgz
  ```
  This passes CI's `--immutable` check. Always commit `yarn.lock` alongside `package.json` when dependencies change.

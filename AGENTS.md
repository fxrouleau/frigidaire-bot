# Frigidaire Bot

## Overview

A Discord bot built in **TypeScript** that hangs out in a private server as "one of the group". Core features:

1. **AI Chat** — Mention the bot to converse. A single AI backend (OpenRouter) with multi-round tool-calling, vision (images/emojis/stickers), and native web search.
2. **Long-Term Memory** — Persists facts, server-member identities, and emoji captions in SQLite. Injects relevant memories into the system prompt. A background "personality learner" observes channels off-mention to learn the server's vibe.
3. **Message Summarization** — Ask the bot to summarize recent channel history (via the `summarize_messages` tool).
4. **Link Replacement** — Rewrites Twitter/X (`fixvx.com`), Instagram (`zzinstagram.com`), and TikTok (`tnktok.com`) links for proper Discord embedding, reposting via webhooks to preserve the original author's appearance.

## Tech Stack

- **Runtime**: Node.js v26 (`node:26-alpine`)
- **Language**: TypeScript 5.9 (strict mode, target `es2024`, `commonjs` modules)
- **Package Manager**: Yarn v4.7 (via Corepack, node-modules linker)
- **AI**: OpenRouter via the `openai` SDK (`baseURL: https://openrouter.ai/api/v1`)
- **Storage**: `better-sqlite3` at `./data/memory.db` (memories + FTS5, identities, emojis, learner state)
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
│   ├── memory/                     # memoryStore.ts (SQLite: memories+FTS5, identities, emojis) + wordOverlap.ts
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
    ├── openRouterFetch.ts          #   replay/record OpenAI-SDK clients backed by JSON fixtures
    ├── recorder.ts  replayCli.ts   #   call-recorder util; the `yarn replay` command
    └── fixtures/openrouter/*.json  #   committed, hand-authored OpenRouter response shapes

# Tests are colocated as src/**/*.test.ts (~265). Live tests: src/ai/providers/openRouterProvider.live.test.ts
```

## Architecture

### Event-Driven Design
- `app.ts` dynamically loads every non-`.test` `.ts`/`.js` file from `src/events/` as a Discord event handler.
- Each event file exports `{ name, once?, execute(...args) }`.
- Adding a handler = creating a file in `src/events/`; no changes to `app.ts` needed.
- On startup `app.ts` also runs memory compaction and starts the personality learner once the client is ready.

### Single-Provider AI System
- **`AiProvider` interface** (`src/ai/types.ts`): `id`, `displayName`, `personality`, `defaultModel`, `supportedTools`, `chat()`, plus optional `summarizeMessages()` / `generateImage()` / `generateImageLocal()`.
- **`OpenRouterProvider`** is the only implementation. It builds OpenAI-style chat requests, attaches function tools + OpenRouter's native `web_search`, sends an OpenRouter `provider` routing object (default `{ zdr: true, sort: 'throughput' }`), and parses the response back into normalized entries. Constructor takes DI options (`client`, `model`, `routing`) so tests can inject a fixture-backed client.
- **Tools** are defined once in `src/ai/tools.ts` and exposed to the model as function tools. Host tools (executed by this bot): `summarize_messages`, `generate_image`, `remember_fact`, `recall_memories`, `forget_memory`, `query_long_term_memory`, `query_self_diagnosis`. `web_search` is provider-handled (not host).

### Conversation Flow (`AgentOrchestrator.handleMention`)
1. Resolve the provider; start the typing loop.
2. Fetch/create per-channel state (on first mention, seed history from the last ~25 messages).
3. Build the developer/system prompt (persona + injected memories/identities/usable emojis + current ET time) and the new user entry.
4. Call `chat()` with `tool_choice: auto`. Execute any **host-handled** tool calls, append results, and loop (`chat()` → execute) for up to `MAX_TOOL_ROUNDS` rounds / `MAX_TOOL_INVOCATIONS` total tool calls. On the last allowed round, or once the invocation cap is exceeded, force a text-only response (`tool_choice: none`).
5. Send the reply (split into Discord-sized chunks), persist updated state.
- Constructor accepts DI options `{ resolveProvider, tools, timeoutMs, maxToolRounds, maxToolInvocations }` purely to make the loop testable.

### Long-Term Memory & Learning
- `MemoryStore` (`./data/memory.db`): memories (+ FTS5 search), server-member identities, emoji rows (name/caption/use-count), and learner state. The prompt builder injects capped, relevance-ranked memories each turn.
- `PersonalityLearner` runs on an interval (off-mention) to record server "vibe" memories and, optionally, bot self-improvement signals. Emojis are reconciled to the DB on startup and captioned by a vision model.

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

# Opt-in LIVE API smoke tests (paid, ~cents — hits real OpenRouter):
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
```

For tests: `RUN_LIVE=1` enables the live smoke tests (also needs `OPENROUTER_API_KEY`).

## Testing

- **Vitest 4**, tests colocated as `src/**/*.test.ts` (~225 tests). Convention: new code at the **OpenRouter or Discord boundary should ship with fixture/fake-based tests**.
- `src/test-support/` holds shared helpers — **excluded from the prod build** (`tsconfig.json`) but **type-checked strictly** via `tsconfig.test.json`:
  - **`fakeProvider.ts`** — `FakeProvider`, a scripted `AiProvider` for deterministic orchestration tests (multi-round tool calls, forced text, errors); records every `chat()` input. Builders: `textResponse()`, `toolCallResponse()`, `errorStep()`.
  - **`fakeDiscord.ts`** — `createFakeMessage()` / `createFakeBotMessage()`: typed discord.js `Message` fakes with recorders for `reply` / `send` / `sendTyping` / `messages.fetch` / `createWebhook` / `delete` (+ per-webhook `send`/`delete`). Uses real `Collection`s so `.size`/`.values()`/`.has()` behave like prod.
  - **`openRouterFetch.ts`** — `createReplayClient()` / `createSequenceReplayClient()` / `loadFixture()`: OpenAI-SDK clients whose HTTP layer serves recorded JSON, so the provider's **real** request-building + response-parsing run offline and free. `createRecordingClient()` refreshes fixtures against the live API.
  - **`fixtures/openrouter/*.json`** — committed response shapes: text, single/multi tool calls, text-with-tool-call, malformed args, empty tool-call id, Bedrock-style no-choices error, HTTP 500.
  - **`replayCli.ts`** backs `yarn replay`; **`recorder.ts`** is the recorder util (no test-runner imports, so usable from both Vitest and the ts-node CLI).
- **Live tests** (`openRouterProvider.live.test.ts`) are `describe.skipIf`-gated, running only with `RUN_LIVE=1` + `OPENROUTER_API_KEY`. Shape-only assertions tolerate non-determinism; routing can pin a backend (e.g. `only: ['amazon-bedrock']`) to reproduce backend-specific bugs.

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

- **Tests exist (~225)** — run them (plus `typecheck` and `check`) via `docker compose` before handoff. There is no separate `yarn dev` test step.
- **Biome** handles all formatting and linting (no ESLint/Prettier). It **ignores `src/**/*.test.ts`** and `src/test-support/fixtures` — tests are not formatted/linted, but `tsconfig.test.json` type-checks them strictly.
- camelCase for functions/variables, PascalCase for classes/interfaces.
- Strict TypeScript — no `any`.
- Async/await throughout; `Promise.all()` for parallel work.
- Error handling generally returns user-facing strings rather than throwing.

## Tooling Notes

- `CLAUDE.md` is a symlink to `AGENTS.md` — they are the same file. Git tracks it as `AGENTS.md`.
- **Persisted data lives in `./data`** (SQLite DB + error captures). Prod **must** volume-mount it (`./data:/app/data`, as `docker-compose.yaml` does) or memories and captures are lost whenever the container is recreated. When first adding the mount to an already-running server, `docker cp` the in-container `/app/data/memory.db` out to the host `./data` first, or you'll start from an empty DB.
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

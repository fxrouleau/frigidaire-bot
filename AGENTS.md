# Frigidaire Bot

## Overview

A Discord bot built in **TypeScript** that lives in one private friend server as "one of the group". Features:

1. **AI chat** — mention or reply to the bot to talk to it. One provider (OpenRouter), multi-round tool calling, vision (images, custom emojis, stickers), native web search. Every AI request is routed with zero-data-retention (`zdr: true`) provider preferences; that is a hard rule for anything touching chat text.
2. **Long-term memory** — facts, member identities and emoji captions in SQLite. Retrieval is hybrid: embeddings (cosine) fused with FTS5 keyword search. A background "personality learner" observes channels off-mention. See [Long-term memory](#long-term-memory--learning).
3. **Link fixing** — Twitter/X, Instagram and TikTok links are rewritten to embed-fixer domains (ordered fallback lists, each candidate probed with Discord's crawler user agent) and reposted through a webhook as the original author. See [Link fixing](#link-fixing).
4. **Deleted-message repost** — for configured members, a message deleted shortly after posting is judged ("was that edgy?") and reposted as them, attachments included. Off unless `DELETE_REPOST_USER_IDS` is set. See [Deleted-message repost](#deleted-message-repost).
5. **Report channel** — when `REPORT_CHANNEL_ID` is set: a weekly self-diagnosis digest and a "🚀 Deployed `<sha>`" line on each new build.

## Tech stack

- **Runtime**: Node.js 26 (`node:26-alpine`), TypeScript 7 (the native Go `tsc`; strict, `es2024`, CommonJS output). TS 7 has no JavaScript API yet, so `@typescript/typescript6` supplies the parser `openRouterCallSites.test.ts` uses, and the dev scripts (`replay`, `eval:*`, nodemon) run through `tsx`
- **Package manager**: Yarn 4.18 via Corepack, node-modules linker
- **Discord**: discord.js 14
- **AI**: OpenRouter through the `openai` SDK (chat completions + embeddings) and its `/api/alpha/decisions` endpoint (TypeSafe "System One" decision models, used by the message judge)
- **Storage**: `better-sqlite3` — `./data/memory.db` (memories, FTS5, vectors, identities, emojis, learner/bot state) and `./data/conversations.db` (per-channel conversation cache)
- **Images**: `sharp`
- **Lint/format**: Biome 2 (120 cols, 2 spaces, single quotes, trailing commas; `noUnusedImports`/`noUnusedVariables` are errors; `check` also sorts imports through the organizeImports assist)
- **Tests**: Vitest 5 (with `vite` as an explicit dev dependency: Yarn does not install peers), ~590 tests colocated as `src/**/*.test.ts`
- **Deployment**: one Docker image; dev/test toolchain fully containerized (host needs only Docker)

## Project structure

```
src/
├── app.ts                     # Entry: config summary, Discord client, event loader + safe dispatcher, startup maintenance, shutdown
├── config.ts                  # EVERY env var, parsed once per access with one set of rules (see Environment variables)
├── eventModule.ts             # defineEvent()/EventModule — the contract each file in src/events/ fulfils
├── logger.ts  utils.ts        # Console logger; splitMessage(), sendViaWebhook(), repostMessage()
├── deletedMessages.ts         # DeletedMessageReposter — snapshot cache + judge + webhook repost for watched users
├── links/embedFixers.ts       # Link patterns, canonical paths, fixer probing/health, fixLinksInContent()
├── ai/
│   ├── agent.ts               # AgentOrchestrator — per-channel serialized conversation/tool loop, prompt building, emoji guardrail
│   ├── agentInstance.ts       # Shared orchestrator singleton (with disk-backed conversation persistence)
│   ├── conversationStore.ts   # In-memory per-channel state with timeout (+ write-through to persistence)
│   ├── conversationPersistence.ts  # SQLite mirror of conversation state (survives redeploys within the timeout)
│   ├── providerRegistry.ts    # getProvider() — the OpenRouterProvider singleton
│   ├── openRouterClient.ts    # The one place an OpenAI-SDK client for OpenRouter is built
│   ├── tools.ts               # Host tools: summarize_messages, generate_image, remember_fact, recall_memories, forget_memory, query_self_diagnosis, get_emoji
│   ├── emojiPolicy.ts         # applyEmojiPolicy() — deterministic guardrail on custom-emoji use in replies
│   ├── messageJudge.ts        # createEdgyJudge() — decision-model (jev) judge with chat-model fallback
│   ├── promptSections.ts      # Shared identity/emoji prompt lines, custom-emoji parsing, CDN URLs
│   ├── types.ts  utils.ts     # Core types; ET time formatting, relative ages
│   ├── debugCapture.ts        # Writes failed exchanges to data/debug/*.json for replay
│   ├── failureLogger.ts       # Structured failure logging into self-diagnosis memories
│   ├── personalityLearner.ts  # Off-mention background observer (vibe + self-improvement), learnerInstance.ts singleton
│   ├── emojiSync.ts emojiCaptioner.ts  # Reconcile guild emojis to DB; caption via a vision model
│   ├── digest.ts reportChannel.ts      # Weekly digest rendering; report-channel sending
│   ├── memory/
│   │   ├── index.ts           #   getMemoryStore() / setMemoryStoreForTesting()
│   │   ├── memoryStore.ts     #   SQLite store: memories + FTS5 + vectors, identities, emojis, state
│   │   ├── embeddingProvider.ts  # EmbeddingProvider + OpenRouterEmbeddingProvider (ZDR)
│   │   ├── vectorMath.ts wordOverlap.ts  # dot/cosine/normalize, blob codecs; Jaccard overlap + STOP_WORDS
│   ├── providers/openRouterProvider.ts  # The single AiProvider (chat, summaries, images, image cache)
│   └── tools/                 # summary.ts (summarization prompt) + localImageGenerator.ts (image gen)
├── events/                    # One handler per file, each `export default defineEvent(Events.X, { execute })`:
│   ├── aiChat.ts              #   mention/reply → agent
│   ├── linkRepost.ts          #   link fixing (all platforms, one repost per message)
│   ├── deletedMessageCache.ts deletedMessageRepost.ts  # deleted-message repost feature
│   ├── emoji{Create,Delete,Update,Ready}.ts            # emoji DB sync; startup reconcile + caption
│   ├── emojiUsageTracker.ts reactionTracker.ts identityTracker.ts learnerActivityTracker.ts
│   ├── deployAnnounce.ts reportDigest.ts ready.ts
└── test-support/              # Shared test helpers (excluded from the prod build, type-checked by tsconfig.test.json)
    ├── fakeProvider.ts fakeDiscord.ts fakeEmbeddings.ts openRouterFetch.ts recorder.ts replayCli.ts
    └── fixtures/openrouter/*.json   # committed OpenRouter response shapes (chat + embeddings)
docker/entrypoint.sh           # prod entrypoint: chown the data volume, drop to the `node` user
```

## Architecture

### Configuration (`src/config.ts`)

Every `process.env` read lives here. Values are parsed on access (getters) so tests can set env per case; prod never mutates env. Rules: booleans accept `1/0`, `true/false`, `yes/no`, `on/off` (whitespace/quotes ignored, anything else ⇒ default); numbers must be finite and within bounds or the default applies; csv lists are trimmed. `describeEffectiveConfig()` is logged once at startup (never secrets). Add a new variable here first, then document it below.

### Events (`src/eventModule.ts`, `src/app.ts`)

- Every non-test file in `src/events/` is loaded at startup and must `export default defineEvent(Events.X, { once?, execute })`; `execute`'s arguments are typed from the event name. A file that isn't a valid module fails startup with a clear error (`eventModule.test.ts` also checks every file).
- Handlers run behind a dispatcher that catches a throwing or rejecting handler and logs it. A `process.on('unhandledRejection')` logger covers everything else. A missing permission in one channel can no longer take the process down.
- A missing or rejected Discord token exits with code 1 (fail fast; the container's restart policy takes it from there).

### Conversation flow (`AgentOrchestrator`)

1. `handleMention` queues the turn **per channel**: two mentions in one channel run back to back, so the second sees the first's reply (no lost-update race).
2. Fetch/create per-channel state (first mention seeds history from the last ~25 messages; state persists across restarts within `CONVERSATION_TIMEOUT_MS`).
3. Build the frozen static developer prompt (persona + SERVER PEOPLE + emoji glossary + vibe/personality bucket + current ET time) once per window, plus a per-turn dynamic developer entry (speaker memories, hybrid-search hits for the message, @-mentioned subjects; deduped against everything already injected this window).
4. `chat()` with `tool_choice: auto`; execute host-handled tool calls; loop up to `MAX_TOOL_ROUNDS` / `MAX_TOOL_INVOCATIONS`, then force a text-only answer.
5. Run the **emoji guardrail** (below), send the reply in Discord-sized chunks, persist the state. Everything from step 2 on is inside one try/catch: any failure yields the error reply plus an error capture.
- Embed images are read through Discord's media proxy (`proxyURL`) rather than the third-party origin; every user message's custom emojis/attachments/stickers are attached as image parts. The provider memoizes image downloads per URL (100 entries, 15 min).

### Emoji policy (`src/ai/emojiPolicy.ts`)

Felix's complaint: the bot put a custom emoji in nearly every reply, often the wrong one. Three layers now:
- **Prompt**: the persona's behavior list says emojis are basically not used; the static prompt carries an *emoji glossary* (name + caption, for reading what people post) that deliberately withholds the `<:name:id>` syntax. Deliberate use goes through the `get_emoji` tool, whose description tells the model to hold back.
- **Guardrail** (`applyEmojiPolicy`): at most one custom emoji per reply; only when the reply is emoji-only, the triggering message contained a custom emoji, or none of the bot's last 4 replies in the window had one; unknown emoji ids are always stripped. When the guardrail edits a reply, the stored assistant entry is rewritten to the posted text so the model never re-learns the stripped version from its own history.
- **Metric**: one `reply_stats channel=… emoji_kept=… emoji_stripped=… names=…` log line per reply. `emoji_stripped` staying high means the prompt still wants one; the rate itself is the guardrail's.
- Later (not done): richer captions grounded in real usage examples, an "emoji usage audit" job. Rework of *what emoji means what* is a separate task.

### Link fixing (`src/links/embedFixers.ts`, `src/events/linkRepost.ts`)

Instagram embed fixers are hobby scrapers that die regularly (zzinstagram.com was dead for months while the bot kept rewriting to it). Design:
- Per-platform **ordered fixer lists** (`TWITTER_FIXERS`, `INSTAGRAM_FIXERS`, `TIKTOK_FIXERS`; defaults in `config.ts`).
- **Canonicalization** first: `/share/<id>` Instagram links and `vm.`/`vt.` TikTok short links are resolved through the platform's own 302 (no login), profile-prefixed Instagram paths (`/<user>/reel/<id>/`) reduced to the bare post path, queries stripped. Only post-shaped URLs match: profiles, stories, `/discover`, `/tag` are ignored. Links wrapped in `<…>` are skipped.
- **Verification**: each candidate `https://<fixer><path>` is fetched with Discord's crawler user agent and classified `ok` (OpenGraph media tags, or a redirect straight to a media file), `unavailable` (404 / "post not found" — the fixer is fine, skip it for this link) or `down` (network error, 5xx, timeout, bounce to the platform's login wall). Two consecutive `down`s put a domain in a 10-minute cooldown. `LINK_FIX_VERIFY=false` rewrites blindly to the first domain.
- A message is reposted **once** with every fixable link rewritten. If no fixer works, the message is left alone (a raw link beats a guaranteed-broken one) and a WARN is logged.
- `repostMessage` sends the webhook post **before** deleting the original; the webhook is always deleted afterwards (also on failure), so the 15-webhooks-per-channel cap can't be leaked into. Only text and announcement channels are handled (threads can't own webhooks).

### Deleted-message repost (`src/deletedMessages.ts`, `src/ai/messageJudge.ts`)

For users in `DELETE_REPOST_USER_IDS`, every new message in a webhook-capable channel is snapshotted (content, identity, and attachment bytes ≤10 MB downloaded immediately — Discord drops attachments on delete). When such a message is deleted within `DELETE_REPOST_WINDOW_MS`:
- `DELETE_REPOST_MODE=edgy` (default): the judge decides. `DELETE_REPOST_MODEL` defaults to `typesafe/jev-1.13`, a text-only *decision model* called through OpenRouter's `/api/alpha/decisions` endpoint (returns a calibrated probability, ~$0.00001 per call, on OpenRouter's ZDR list). Image-only messages, or any decision-model failure (the endpoint is alpha; calls have a 6 s timeout and one retry), fall back to the chat model with a JSON yes/no prompt. Any chat model id in `DELETE_REPOST_MODEL` skips the decision model entirely. No verdict ⇒ no repost (fail closed).
- `DELETE_REPOST_MODE=always`: every qualifying deletion is reposted.
- The repost goes through `sendViaWebhook` with the author's nickname/avatar. Deletions the bot performs itself (link fixing) are excluded via `forget()`.

### Memory tools

`recall_memories` (subject + keyword + category search, every line prefixed `[id:N]`), `remember_fact` (category whitelist enforced — the model cannot write self-diagnosis or ephemeral categories), `forget_memory` (reports "no active memory" for unknown or already-forgotten ids), `query_self_diagnosis` (limit clamped 1..50). The former `query_long_term_memory` was merged into `recall_memories`.

## Long-term memory & learning

- `MemoryStore` (`./data/memory.db`): memories (+ FTS5 index + embedding vectors), member identities, emoji rows (name/caption/use-count), learner state, generic `bot_state` key/values. The prompt builder injects capped, relevance-ranked memories each turn.
- `PersonalityLearner` runs every `LEARNING_INTERVAL_MS` over channels with ≥ `MIN_MESSAGES_FOR_OBSERVATION` new human messages, extracting observations (and identity updates) with `LEARNER_MODEL`, plus an optional self-improvement pass. Emojis are reconciled at startup and captioned by `EMOJI_CAPTION_MODEL`.

**Learner prompt rules** (why the prompts are rule-heavy — the originals filled prod with per-message transcription):
- **30-day test**: only knowledge still true and useful in 30 days is saved; "someone asked/confirmed/shared X" is transcription, never a memory.
- **Ephemeral categories**: time-bound observations MUST be `event` (TTL ~14 days), image/GIF shares MUST be `image` (TTL ~24 h). A durable fact revealed by an image is saved as `fact`.
- **No re-saves** of traits already in the injected existing-memories context; save-time dedup is the backstop.
- **Subject normalization**: subjects are the person's **current display name** (+ `subject_user_id` as the stable anchor), never nicknames or stale usernames. Emoji style is described in words — emoji syntax never goes into a memory.
- Observations stay verbatim: there is deliberately **no censoring or paraphrasing rule** (Felix's explicit call; do not add one).

**Embeddings** (`embeddingProvider.ts`): `OpenRouterEmbeddingProvider` calls `/embeddings` (`EMBEDDING_MODEL`, default `qwen/qwen3-embedding-8b`) with `provider: { zdr: true }` — non-negotiable. Asymmetric retrieval: queries get the qwen3 instruct prefix, documents are embedded bare; vectors are L2-normalized so cosine is a dot product. `makeDefaultEmbeddingProvider()` returns `undefined` (FTS5-only mode) without a key, with `SEMANTIC_MEMORY_ENABLED=false`, or inside Vitest.

**Hybrid search** (`MemoryStore.search()`):
1. Keyword leg in two tiers: rows matching **every** query term (implicit AND), then rows matching **any** non-stop-word term (OR, BM25-ranked). The second tier is what keeps keyword search useful for message-length queries; before it existed the keyword leg matched nothing for real messages.
2. Vector leg: cosine over the in-memory vector cache.
3. Reciprocal-rank fusion (k=60; vector 1.0, exact keyword 0.5, partial keyword 0.25).
4. **Semantic gate**: every result needs cosine ≥ `MEMORY_RELEVANCE_THRESHOLD` (default 0.5); keyword hits on un-embedded memories are dropped.
5. Ungated keyword fallback (both tiers) when there is no embedder, the query embed fails, or fewer than 80% of searchable memories have current-model vectors (logged at WARN).
- Self-diagnosis categories (`SELF_DIAGNOSIS_CATEGORIES`) are excluded from search; `query_self_diagnosis` is their only path.

**Save** (`save()`): phase 1 synchronous — word-overlap dedup + INSERT/UPDATE + FTS sync in one transaction (durable before the first `await`); phase 2 best-effort — embed, cosine dedup (≥ `MEMORY_DEDUP_THRESHOLD`, same category+subject; a duplicate merges into the **existing** id), store the vector. Failures never lose the row; backfill heals it.

**Deactivate / FTS integrity**: `deactivate(id)` returns `false` and does nothing for unknown or already-inactive rows. This guard matters: the external-content FTS5 index only holds active rows, and a repeated `'delete'` command corrupts it ("database disk image is malformed" on the next MATCH). `compact()` also rebuilds the FTS index from the active rows at every startup (`rebuildFtsIndex()`, milliseconds at prod scale), so the index is correct by construction.

**Backfill** (`backfillEmbeddings()`): idempotent, batched (32/request), embeds every active memory lacking a current-model vector; runs at startup and every `BACKFILL_INTERVAL_MS`; expand-contract on `EMBEDDING_MODEL` switches.

**Compaction** (`compact()`, startup): rebuild FTS index → TTL sweep → orphan-vector sweep → dedup within (subject, category) groups (cosine when both sides have vectors, word overlap otherwise; a row deactivated in a pass is never compared again) → `PRAGMA optimize`.

**Ephemeral TTL** (`sweepExpiredMemories()`): `image` after `MEMORY_TTL_IMAGE_HOURS`, `event` after `MEMORY_TTL_EVENT_DAYS`, measured on `updated_at`, strict `<`; also runs before each periodic backfill. `0` disables a category's expiry.

### Memory schema

| Table | Contents |
|---|---|
| `memories` | id, category, subject, content, source, timestamps, active flag, subject_user_id |
| `memories_fts` | FTS5 external-content index over memories (content/subject/category); active rows only |
| `memory_embeddings` | memory_id (FK, cascade), model, dims, input_text, vector BLOB (L2-normalized LE Float32, `CHECK(length = dims*4)`), `UNIQUE(memory_id, model)` |
| `identities` / `emojis` / `learner_state` / `bot_state` | members (display/canonical/IRL names, aliases), emoji captions + use counts, learner watermarks, key/values (digest watermark, last announced sha) |

`conversations.db`: `conversation_state(channel_id, schema_version, state_json, updated_at)`. Rows with an old `CONVERSATION_STATE_SCHEMA_VERSION` are discarded on load; a v1 table (which still had a `provider_id` column) is dropped and recreated.

**Model-switch runbook** (`EMBEDDING_MODEL`): run the live calibration test (`RUN_LIVE=1 EMBEDDING_MODEL=<new> … yarn test:live`, grep `CALIBRATION`) to confirm ZDR endpoints and sane thresholds → set the variable and restart (search falls back to keyword mode while coverage < 80%) → the startup backfill re-embeds everything (~60 calls at 2k memories) → adjust thresholds if the cosine distribution moved → rollback is reverting the variable.

**Kill switch**: `SEMANTIC_MEMORY_ENABLED=false` ⇒ keyword-only retrieval instantly, vectors kept.

### Error capture & replay

When the agent loop throws in prod, `debugCapture.ts` writes the conversation + raw error to `data/debug/error-<timestamp>-<rand>.json` (newest 50 kept; `DEBUG_CAPTURE=false` disables, `DEBUG_CAPTURE_DIR` relocates). `yarn replay <file>` reproduces the exchange offline. Captures hold full private chats — the digest reads only their timestamp/status/message.

## Commands

The dev/test toolchain runs entirely in Docker — the host does **not** need Node or Yarn.

```bash
docker compose build test                            # build the test image (once, and after package.json/yarn.lock changes)
docker compose run --rm test                         # full test suite (default CMD = yarn test)
docker compose run --rm test yarn typecheck          # strict TS over ALL of src/ incl. tests (tsconfig.test.json)
docker compose run --rm test yarn check              # Biome lint+format with --fix (writes back via the mount)
docker compose run --rm test yarn check:ci           # Biome check WITHOUT fixing (what CI runs)
docker compose run --rm test yarn build              # tsc build
docker compose run --rm test yarn replay data/debug/error-X.json   # replay a prod error capture / fixture

docker build --target ci .                           # the full CI gate locally (lint + typecheck + build + tests)
docker build --target prod -t frigidaire-bot:local . # the prod image

# Live API tests (paid, cents): chat smoke tests + the embeddings ZDR canary / threshold calibration
docker compose run --rm -e RUN_LIVE=1 -e OPENROUTER_API_KEY=sk-... test yarn test:live

# Update yarn.lock after editing package.json
docker compose run --rm test yarn install --mode=update-lockfile   # then rebuild the test image
```

Running the bot via Compose: `docker compose up -d frigidaire-bot` reads `.env` (optional) and mounts `./data`. Production is a Portainer stack pulling the DockerHub image with the same variables.

**After any change, run `yarn check`, `yarn typecheck` and `yarn test` via `docker compose` before handoff.**

## Environment variables

Parsed in `src/config.ts`; booleans accept `1/0`, `true/false`, `yes/no`, `on/off`.

**Required (prod):**
```
CLIENT_SECRET=<discord bot token>
OPENROUTER_API_KEY=<openrouter api key>
```

**Models:**
```
CHAT_MODEL                    default deepseek/deepseek-v3.2:nitro     # chat + summaries; must accept image parts if members post images/emojis
IMAGE_MODEL                   default google/gemini-2.5-flash-image
EMOJI_CAPTION_MODEL           default anthropic/claude-opus-4.7        # vision captions, one-shot per emoji
LEARNER_MODEL                 default qwen/qwen3-vl-235b-a22b-instruct
SELF_IMPROVEMENT_MODEL        default = LEARNER_MODEL
EMBEDDING_MODEL               default qwen/qwen3-embedding-8b          # must have ZDR endpoints
DELETE_REPOST_MODEL           default typesafe/jev-1.13                # decision model, or any chat model id
```

**Chat / agent:**
```
CONVERSATION_TIMEOUT_MS       default 900000 (15 min)
MAX_TOOL_ROUNDS               default 10
MAX_TOOL_INVOCATIONS          default 50
```

**Learner:**
```
LEARNING_INTERVAL_MS          default 1800000 (30 min)
MIN_MESSAGES_FOR_OBSERVATION  default 5
LEARNER_IGNORE_CHANNELS       csv of channel ids the learner skips
SELF_IMPROVEMENT_ENABLED      default true
EMOJI_FORCE_RECAPTION         default false  # ONE-SHOT: clears every caption at startup; unset it again or every redeploy re-captions
```

**Memory:**
```
SEMANTIC_MEMORY_ENABLED       default true   # false ⇒ keyword-only retrieval, no embeddings calls
MEMORY_RELEVANCE_THRESHOLD    default 0.5    # search gate (cosine)
MEMORY_DEDUP_THRESHOLD        default 0.9    # save/compact merge (cosine)
EMBEDDING_QUERY_INSTRUCTION   override the qwen3 query instruction
BACKFILL_INTERVAL_MS          default 1800000 (30 min)
MEMORY_TTL_IMAGE_HOURS        default 24 (0 disables)
MEMORY_TTL_EVENT_DAYS         default 14 (0 disables)
```

**Link fixing:**
```
TWITTER_FIXERS                default fixvx.com,fxtwitter.com,vxtwitter.com
INSTAGRAM_FIXERS              default instagram7.com,uuinstagram.com,kkinstagram.com
TIKTOK_FIXERS                 default tnktok.com,fixtiktok.com,tfxktok.com
LINK_FIX_VERIFY               default true   # false ⇒ rewrite to the first domain without probing
LINK_FIX_TIMEOUT_MS           default 4000
```

**Deleted-message repost:**
```
DELETE_REPOST_USER_IDS        csv of Discord user ids; empty ⇒ feature off
DELETE_REPOST_WINDOW_MS       default 120000 (2 min)
DELETE_REPOST_MODE            edgy (default) | always
```

**Report channel / ops:**
```
REPORT_CHANNEL_ID             master switch: unset ⇒ digest and deploy pings both off
DIGEST_ENABLED                default true
DIGEST_PERIOD_MS              default 604800000 (7 days)
DIGEST_CHECK_INTERVAL_MS      default 3600000 (1 hour)
DEPLOY_ANNOUNCE_ENABLED       default true
GIT_SHA                       baked into the prod image by CI (unset ⇒ no deploy ping)
DEBUG_CAPTURE                 default true
DEBUG_CAPTURE_DIR             default ./data/debug
LOG_DEBUG                     default false  # per-search cosine distributions etc.
```

For tests: `RUN_LIVE=1` enables the live tests (also needs `OPENROUTER_API_KEY`).

## Testing

- Vitest 5; tests colocated as `src/**/*.test.ts`. Convention: code at the **OpenRouter or Discord boundary ships with fixture/fake-based tests**.
- **Hermeticity**: tests never touch `./data` or the network. `getMemoryStore()` and `getConversationPersistence()` auto-construct in-memory instances under Vitest; `makeDefaultEmbeddingProvider()` returns `undefined` there. Tests needing memory inject `new MemoryStore(':memory:', { embeddings: new FakeEmbeddingProvider() })` via `setMemoryStoreForTesting()`. Anything that can write an error capture stubs `DEBUG_CAPTURE_DIR` (or sets `DEBUG_CAPTURE=0`).
- `src/test-support/`:
  - `fakeProvider.ts` — scripted `AiProvider` (`textResponse()`, `toolCallResponse()`, `errorStep()`), records every `chat()` input.
  - `fakeDiscord.ts` — `createFakeMessage()` (typed as the exact `MessageCreate` argument; options for channel type, attachments, embeds incl. `proxyURL`, mentions, replied-to user, webhook send failures), `createFakeChannel()`, `createFakeClient()` (a ready `Client<true>`), `createFakeBotMessage()`.
  - `fakeEmbeddings.ts` — deterministic bag-of-words embeddings; `failWith` simulates outages.
  - `openRouterFetch.ts` — replay/record OpenAI-SDK clients backed by JSON fixtures (chat and embeddings).
  - `replayCli.ts` backs `yarn replay`; `recorder.ts` is the call-recorder util.
- Link fixers are tested with an injected `FixerDeps` (fake fetch + clock); the event handler test stubs global `fetch`. The message judge is tested with a fake decisions fetch and a replay chat client. The deleted-message reposter takes every dependency (judge, attachment download, webhook send, clock, config) through its constructor.
- **Live tests** (`*.live.test.ts`, `yarn test:live`) are `describe.skipIf`-gated on `RUN_LIVE=1` + `OPENROUTER_API_KEY`: chat smoke tests, the embeddings ZDR canary and threshold calibration (grep `CALIBRATION`).

### Prod-error → regression-test workflow

1. Bot errors in prod → `data/debug/error-<timestamp>.json` is written automatically.
2. Copy the file off the server; `docker compose run --rm test yarn replay <file>` reproduces it (exit 1 = still reproduces).
3. Fix the code; sanitize the payload into `src/test-support/fixtures/openrouter/` and add a regression test that loads it via `loadFixture()` / a replay client.

## Continuous integration

Both workflows build the `ci` Docker stage (GHA layer cache), which runs `check:ci`, `typecheck`, `build` and `test` at image-build time — a green build is the full gate. `docker-build.yml` (pull requests): the gate, then Gitleaks + Semgrep (`.semgrep/`), then a prod image build. `docker-push.yml` (push to `master`): the gate, then builds and pushes the `prod` image to DockerHub tagged `latest`, the date, and `sha-<short>`, with `GIT_SHA` baked in.

## Docker image

Stages: `base` (deps) → `test` (full source) → `ci` (runs the gate) / `build` (tsc) / `prod-deps` (`yarn workspaces focus --all --production`: runtime deps only). `prod` copies `dist/` + production `node_modules`, starts through `docker/entrypoint.sh`, which chowns `/app/data` and drops to the `node` user with `su-exec`. `.dockerignore` keeps the build context to the sources (no `.git`, `dist/`, `data/`, Yarn cache).

## Conventions

- Strict TypeScript, no `any`; camelCase functions/variables, PascalCase types/classes.
- Async/await throughout; `Promise.all()` for parallel work.
- Errors at the user boundary become user-facing strings; infrastructure errors are logged, never swallowed silently.
- Biome handles formatting and linting. It ignores `src/**/*.test.ts` and the fixtures; tests are still type-checked strictly by `tsconfig.test.json`.
- New env vars go through `config.ts`; new events go through `defineEvent()`; new OpenRouter calls go through `openRouterClient.ts` and carry `provider: { zdr: true }`.
- Persisted data lives in `./data`; prod must volume-mount it. Expect `memory.db` around 32 MB once vectors are backfilled (~2k memories × 16 KB) — normal, not bloat.

## Notes for agents

- There is no `CLAUDE.md`; this file is the project instruction file (the harness reads `AGENTS.md`).
- The memory *architecture* (atomic facts + retrieval injection) is due for a rework toward per-member profile documents + a consolidation job; that is a deliberate future task, not something to do incrementally.
- Emoji caption quality ("what emoji means what") is a separate future task; the guardrail and glossary above only fix the *rate*.
- Cloud / no-Docker fallback: `npm install && npx vitest run && npx tsc -p tsconfig.test.json && npx biome check --fix src/`; set `LEFTHOOK=0` when committing; never commit `package-lock.json`; regenerate `yarn.lock` with a Yarn 4 binary from npm (`npm pack @yarnpkg/cli-dist@4.18.1`) when dependencies change.

# Frigidaire Bot

## Overview

A Discord bot built in **TypeScript** that lives in one private friend server as "one of the group". Features (each has a section under [Architecture](#architecture)):

1. **AI chat** — mention or reply to the bot, or just talk to it: a cheap *gate* decides when a message without a mention is still meant for it. One provider (OpenRouter), multi-round tool calling, vision, native web search. Each turn sees what was said since the last one, the reply chain it answers, link previews, voice transcripts and video descriptions.
2. **Long-term memory** — facts, member identities (every name a person goes by, side accounts folded in) and emoji captions in SQLite. Hybrid retrieval (embeddings fused with FTS5) and a background personality learner. See [Long-term memory](#long-term-memory--learning).
3. **Media** — voice messages are transcribed (Whisper, plus a quiet transcript reply) and videos are watched by Gemini (a description, and answers to follow-up questions), within a daily video budget.
4. **Link reader** — tweets, TikToks/Reels, YouTube, Reddit, Bluesky, GIFs and articles are read through an SSRF-guarded fetch. The model gets a preview automatically and can open the full content with `read_link`.
5. **Link fixing** — Twitter/X, Instagram, TikTok, Reddit and Bluesky links are rewritten to probed embed fixers and reposted faithfully as the author (attachments, spoilers, threads, reply line, tweet translation). Fixer outages are reported.
6. **Message archive** — every member message goes into `archive.db`, with years of history backfilled. It feeds the `search_messages` / `get_message_context` tools, the reaction profile and the yearly **Wrapped** post.
7. **Scheduling** — reminders, native polls and birthdays (announced in character), all in Eastern time.
8. **Spontaneous reactions** — auto-react learns how the group reacts and, rarely, adds one emoji to a standout post. It ships in **shadow** mode: it only reports what it would do. Emoji captions are re-grounded in real usage.
9. **Ramble redirect** — a configured member's rambles get an in-character nudge toward their own channel.
10. **Code sandbox** — `run_code` runs Python/bash/node in a secret-free sidecar container (math, charts, data): up to 15 minutes, 2 GB, a 20 GB workspace.
11. **Right-click commands** — Ask Fridge, Summarize from here, Transcribe, Translate, Remember this, What does Fridge know?
12. **Feature requests → GitHub** — members' requests become public issues (or +1s on existing ones). The owner's `claude-implement` label has Claude implement them in a PR.
13. **Deleted-message repost** — a configured member's message deleted right after posting is judged ("was that edgy?") and reposted as them. Off unless `DELETE_REPOST_USER_IDS` is set.
14. **Report channel & ops** — the weekly self-diagnosis digest with OpenRouter spend, a "🚀 Deployed `<sha>`" line with the channel configuration, fixer alerts, auto-react shadow lines, `!wrapped` previews. Also a per-feature usage ledger and a rotated log file.

## Hard rules

- **Zero data retention.** Every OpenRouter request that carries member content is routed with `provider: { zdr: true }`: chat, summaries, images, embeddings, learner, captions, judges, media, commands, evals. OpenRouter's `/audio/transcriptions` endpoint ignores provider routing, so it is used only while the model catalog shows **every** host serving `TRANSCRIPTION_MODEL` on OpenRouter's ZDR list. That is checked at startup, daily and before each request; otherwise transcription falls back to a chat model with `zdr: true`. `src/ai/openRouterCallSites.test.ts` enforces tagging and ZDR on every call site: fix the call site, never loosen the test.
- **The repo is public.** No real member names (the owner, Felix, is the only exception), Discord ids, server channel names or private chat content in code, tests, fixtures, comments, commit messages or docs. Ids live in env only. Tests use a fictional cast and placeholder snowflakes; `scenarioFile.test.ts` and `cases.test.ts` enforce parts of this. The learner prompt's GOOD/BAD examples are the one grandfathered exception (see [Notes for agents](#notes-for-agents)): don't add to it.
- **No censoring in the learner.** Observations stay verbatim: there is deliberately **no censoring or paraphrasing rule** (Felix's explicit call; do not add one).
- **Bot posts never ping @everyone, @here or roles.** The client-wide default `allowedMentions: { parse: ['users'], repliedUser: true }` (`src/discordClient.ts`) covers every plain send, because chat replies carry model-written text. Relays, reminders, commands, transcripts, polls, Wrapped and report lines pass stricter values (`parse: []`).
- **Paid judges fail closed.** No verdict means no action (gate, deleted-message judge, ramble, auto-react), and every cap or cooldown is checked before the paid call and again right after it.
- **Failures are in character, and silent when nobody asked.** User-facing errors are in-character lines. An unprompted (gate-routed) turn that fails or has nothing to say posts nothing.
- **Nothing secret reaches the sandbox, and the bot never runs shell commands itself.** Model-written code runs only in the sidecar, which gets no `env_file`.
- **Only the owner approves GitHub work.** The bot's token is the owner's: it never applies `claude-implement`, never edits issues, and every `@` in its comments is defused.

## Tech stack

- **Runtime**: Node.js 26 (`node:26-alpine`), TypeScript 7 (the native Go `tsc`; strict, `es2024`, CommonJS output). TS 7 has no JavaScript API yet, so `@typescript/typescript6` supplies the parser `openRouterCallSites.test.ts` uses, and the dev scripts (`replay`, `eval:*`, nodemon) run through `tsx`
- **Package manager**: Yarn 4.18 via Corepack, node-modules linker (`.yarnrc.yml` keeps install scripts on: better-sqlite3 needs them)
- **Discord**: discord.js 14 (intents Guilds, GuildMessages, MessageContent, GuildEmojisAndStickers, GuildMessageReactions; partials Message, Channel, Reaction, User)
- **AI**: OpenRouter through the `openai` 7 SDK (chat completions, embeddings, `/audio/transcriptions`) and its `/api/alpha/decisions` endpoint (TypeSafe "System One" decision models: the gate and the deleted-message judge)
- **Storage**: `better-sqlite3` 13, four files in `./data`: `memory.db`, `conversations.db`, `bot.db`, `archive.db` (see [Storage](#storage))
- **Media**: `sharp` (images); `ffmpeg`/`ffprobe` in the prod image (keyframes, MP3 transcodes)
- **Sandbox sidecar**: its own image (`sandbox/`): Python 3.14 + Node 26 behind a stdlib-only HTTP server; the compose service is capped at 2 GB / 1 CPU, runs at 15 minutes, the workspace at 20 GB
- **Lint/format**: Biome 2 (120 cols, 2 spaces, single quotes, trailing commas; `noUnusedImports`/`noUnusedVariables` are errors; `check` also sorts imports through the organizeImports assist)
- **Tests**: Vitest 5 (with `vite` as an explicit dev dependency: Yarn does not install peers), ~2,800 tests in ~170 files colocated as `src/**/*.test.ts`
- **Deployment**: two Docker images (the bot, the sandbox sidecar) built and pushed by CI; dev/test toolchain fully containerized (host needs only Docker)

## Project structure

```
src/
├── app.ts                     # Entry: loadEnv, config summary + warnings, client, event loader + safe dispatcher, startup memory maintenance, embedding backfill, shutdown
├── loadEnv.ts                 # dotenv; the FIRST import of every entry point (some modules read config while loading)
├── config.ts                  # EVERY env var, one set of parsing rules; describeEffectiveConfig(), configWarnings()
├── discordClient.ts           # Intents, partials, the client-wide allowedMentions default
├── eventModule.ts             # defineEvent()/EventModule — the contract each file in src/events/ fulfils; registerEventModules()
├── logger.ts  logFile.ts      # Console logger, mirrored into the size-rotated ./data/logs/bot.log
├── channelEnv.ts              # Every channel variable resolved to #names (startup log + deploy ping)
├── linkedAccounts.ts          # LINKED_ACCOUNTS: canonicalUserId(), accountIdsFor(), isSamePerson()
├── relay.ts                   # Registry of the bot's webhook relays + attributeMessage(): who really wrote a message
├── utils.ts                   # splitMessage(), sendViaWebhook(), repostMessage()/repostBlocker(), mentionsInText()
├── deletedMessages.ts         # DeletedMessageReposter — snapshot cache + judge + webhook repost for watched users
├── storage/botDb.ts           # ./data/bot.db: the shared handle for small feature tables (ensureSchema/ensureColumn)
├── ai/
│   ├── agent.ts               # AgentOrchestrator — per-channel turn queue, prompt/context building, tool loop, reply, emoji guardrail
│   ├── agentInstance.ts       # Shared orchestrator (with disk-backed conversation persistence)
│   ├── conversationStore.ts conversationPersistence.ts  # Per-channel window state + its SQLite mirror (conversations.db)
│   ├── historyBudget.ts       # Token estimates and trimming of a window to its budget
│   ├── enrichers.ts           # Content enrichers (media, link previews) by role: current / reference / history
│   ├── people.ts              # THE people resolver: names/mentions/ids → members, chat-text matching, memoryKeyFor()
│   ├── providerRegistry.ts providers/openRouterProvider.ts  # The single AiProvider (chat, fallbacks, web search, images, image cache)
│   ├── openRouterClient.ts    # The one place an OpenAI-SDK client for OpenRouter is built (timeout, retries, usage fetch)
│   ├── usage.ts usageFetch.ts usageFormat.ts  # Per-feature usage/cost ledger (bot.db) and its formatting
│   ├── modelCatalog.ts        # OpenRouter public metadata: context lengths, modalities, reasoning efforts, ZDR endpoint coverage
│   ├── decisions.ts           # The one caller of /api/alpha/decisions (ZDR, 6 s timeout, one retry, usage recorded)
│   ├── messageJudge.ts        # "Was this deleted message edgy?": decision model, chat-model fallback
│   ├── tools.ts               # Tool registry + the memory, summary, image and emoji tools
│   ├── tools/                 # One file per feature's tools: birthdays, costs, featureRequest, linkReader, messageSearch, react,
│   │                          #   reminders, sandbox, video; summary.ts (THE summary pipeline); localImageGenerator.ts
│   ├── emojiPolicy.ts         # applyEmojiPolicy() — deterministic guardrail on custom-emoji use in replies
│   ├── emojiSync.ts emojiCaptioner.ts  # Reconcile guild emojis to the DB; caption them (visual + usage halves) with a vision model
│   ├── promptSections.ts      # Shared SERVER PEOPLE / emoji glossary lines, custom-emoji parsing, CDN URLs
│   ├── personalityLearner.ts learnerInstance.ts  # Off-mention observer: observations, identity updates, self-improvement
│   ├── digest.ts reportChannel.ts  # Weekly digest rendering; report-channel sending (returns whether it posted)
│   ├── debugCapture.ts failureLogger.ts  # Error captures for replay; self-diagnosis memories
│   ├── types.ts utils.ts      # Core types (CONVERSATION_STATE_SCHEMA_VERSION); Eastern-time helpers
│   ├── memory/                # memoryStore.ts (memories + FTS5 + vectors, identities, emojis, state), embeddingProvider.ts,
│   │                          #   startupMaintenance.ts (stamp, then compact), vectorMath.ts, wordOverlap.ts, index.ts
│   ├── media/                 # Voice and video: index.ts (entry points + routing), transcriber.ts + speechToText.ts (Whisper / chat
│   │                          #   fallback), video.ts + videoBudget.ts + clipCache.ts, enricher.ts, autoTranscribe.ts, download.ts,
│   │                          #   transcoder.ts (ffmpeg), formats.ts, voice.ts, store.ts (bot.db), modelCall.ts
│   └── linkReader/            # reader.ts (cache, dedup, media checks), enricher.ts, format.ts, targets.ts, cache.ts, html.ts,
│                              #   netGuard.ts + safeFetch.ts (SSRF-guarded fetch), extractors/{twitter,youtube,shortVideo,reddit,bluesky,gif,web}.ts
├── gate/                      # Replying without a mention: addressedGate.ts (exchanges, caps), addressed.ts (decision state), text.ts
│   │                          #   (prefilter); ramble.ts + rambleJudge.ts + rambleExamples.ts; index.ts (shared instances)
│   └── eval/                  # cases.json (108 synthetic cases), cases.ts, runner.ts, runEval.ts (`yarn eval:gate`)
├── reactions/                 # Auto-react: autoReactor.ts, candidate.ts, judge.ts, guide.ts, ledger.ts, images.ts, index.ts;
│                              #   usage-grounded emoji captions: emojiUsage.ts, usageCaptions.ts
├── archive/                   # archiveStore.ts (archive.db + FTS5), ingest.ts, backfill.ts, reactions.ts, search.ts, stats.ts,
│                              #   wrapped.ts, index.ts (the public surface other features use)
├── scheduling/                # scheduler.ts (one 30 s tick), reminderStore.ts + reminderDelivery.ts, birthdayStore.ts +
│                              #   birthdayAnnouncer.ts, polls.ts, time.ts (Eastern rendering), discord.ts
├── commands/                  # Context menus: index.ts (registry, dispatch, repeat guard), one file per command, respond.ts,
│                              #   targets.ts, completion.ts (one-shot ZDR call), summary.ts, types.ts
├── github/                    # client.ts (REST), featureRequests.ts (caps, matching, filing, +1s), issueMatching.ts, issueText.ts
├── links/                     # embedFixers.ts (patterns, canonical paths, probing, fixLinksInContent()), platforms.ts, markdown.ts,
│                              #   tweetTranslation.ts, attachments.ts, replyContext.ts, fixerHealth.ts, fixerAlerts.ts
├── evals/persona/             # `yarn eval:persona`: scenarios.json (fictional cast), runner, judge, metrics, report (not in dist/)
├── events/                    # One handler per file (see Events below)
└── test-support/              # Fakes and fixtures (excluded from the prod build, type-checked by tsconfig.test.json)
sandbox/                       # The run_code sidecar image: Dockerfile, server.py (stdlib HTTP server), requirements.txt,
                               #   smoke_test.py + ci-smoke.sh (hardened end-to-end check of a built image)
docker/entrypoint.sh           # prod entrypoint: chown the data volume, drop to the `node` user
.github/workflows/             # docker-build.yml (PRs), docker-push.yml (master), claude-feature-request.yml (owner-gated Claude)
.semgrep/                      # the repo's own exfiltration rules (CI)
```

## Architecture

### Configuration (`src/config.ts`)

Every env var the bot reads is parsed here, in its feature's section. Values are parsed on access (getters) so tests can set env per case; prod never mutates env. Rules: booleans accept `1/0`, `true/false`, `yes/no`, `on/off` (whitespace/quotes ignored, anything else ⇒ default); numbers must be finite and within bounds or the default applies; csv lists are trimmed. Add a new variable here first, then document it [below](#environment-variables). `config.test.ts` fails on a `process.env` read anywhere else in `src/` outside the test files (writes are fine: the persona eval switches captures and the log file off for its run).
- **`describeEffectiveConfig()`** logs one `Effective config: …` line at startup, one `key=value` token per config section: `gate=on(channels:1,max:30/10m,cold:3/10m)`, `featureRequests=off(no-repo)`, `reportChannel=set(digest:on@7d,deploy:no-sha)`. Secrets, URLs and repo names only appear as `set`/`MISSING`; Discord ids only as counts or `set`. `config.test.ts` fails when a section has no token: a new section needs a token and a `SECTION_TOKENS` entry. `configWarnings()` adds one WARN per unusable value (malformed or unresolvable `LINKED_ACCOUNTS` pairs).
- **Channel variables are found by name** (`…_CHANNEL_ID`, `…_CHANNEL_IDS`, `…_CHANNELS`, `CHANNEL_NOTES`). `src/channelEnv.ts` resolves each to `#names` on ClientReady (`Channel config · LEARNER_IGNORE_CHANNELS: #a, #b (1 unknown: …)`), and the deploy ping repeats the lines. Name a new channel variable that way and it shows up automatically.
- **Server layout defaults**: `MAIN_CHANNEL_ID` is the default for the gate, ramble watching, auto-react, birthday announcements, the archive backfill and the reminder fallback. Wrapped defaults to `REPORT_CHANNEL_ID`, never to the main channel on its own.

### Startup, events, shutdown (`src/app.ts`, `src/eventModule.ts`)

- Order: `loadEnv` → the Effective config line and warnings → the client → load every event file → startup memory maintenance (subject-id stamp, then `compact()`) → embedding backfill (and its periodic re-run) → login. A missing or rejected token exits with code 1 (fail fast; the restart policy takes it from there). SIGTERM/SIGINT close all four SQLite handles, then the client.
- Every non-test file in `src/events/` must `export default defineEvent(Events.X, { once?, execute })`; `execute`'s arguments are typed from the event name. An invalid file fails startup with a clear error (`eventModule.test.ts` checks every file). `registerEventModules()` puts ONE client listener on each (event, once) that hands the event to every module for it, in load order; each handler runs behind a dispatcher that logs a throwing or rejecting handler, on its own promise chain, so they stay concurrent and one that fails or hangs never stops or delays the others. A listener per file used to trip Node's MaxListenersExceededWarning (11 each on messageCreate and clientReady): don't raise `setMaxListeners` instead, the warning should mean a real leak. A `process.on('unhandledRejection')` logger covers everything else, so one missing permission can't take the process down.
- **Partials** (Message, Channel, Reaction, User) make reaction, delete and update events fire for messages sent before the last restart, which means before every deploy. Handlers of MessageReactionAdd/Remove, MessageDelete and MessageUpdate must check `.partial` (or `fetch()`) before reading anything but ids. MessageCreate is never partial.

| Event | Handlers |
|---|---|
| MessageCreate | `aiChat` (mention / reply / gate → agent), `archiveIngest`, `autoReact`, `deletedMessageCache`, `emojiUsageTracker`, `identityTracker`, `learnerActivityTracker`, `linkRepost`, `rambleRedirect`, `voiceTranscribe`, `wrappedPreview` |
| MessageUpdate | `archiveEdit` |
| MessageDelete | `archiveDelete`, `autoReactDelete`, `deletedMessageRepost`, `voiceTranscriptDelete` |
| MessageBulkDelete | `archiveBulkDelete`, `autoReactBulkDelete`, `voiceTranscriptBulkDelete` |
| Reactions | `reactionTracker` (emoji use counts), `archiveReactionAdd` / `Remove` / `RemoveAll` / `RemoveEmoji` |
| ChannelDelete, ThreadDelete | `archiveChannelDelete`, `archiveThreadDelete` |
| Guild emoji create/update/delete | `emojiCreate`, `emojiUpdate`, `emojiDelete` |
| InteractionCreate | `interactionCreate` (context-menu commands) |
| ClientReady (once) | `ready`, `emojiReady` (reconcile + caption; schedules usage captions), `archiveBackfill`, `archiveWrapped`, `channelEnvLog`, `commandsRegister`, `deployAnnounce`, `linkFixAlerts`, `reportDigest`, `schedulerStart`, `transcriptionRouteCheck`; app.ts also starts the learner |

### Storage

| File | Owner | Holds |
|---|---|---|
| `memory.db` | `MemoryStore` | memories + FTS5 + vectors, identities, emojis, learner watermarks, `bot_state` key/values |
| `conversations.db` | `ConversationPersistence` | the per-channel conversation cache (disposable) |
| `bot.db` | `src/storage/botDb.ts` | small feature tables, each created lazily by its feature (`ensureSchema`, additive `ensureColumn`) |
| `archive.db` | `ArchiveStore` | the message archive; its own file because it grows to hundreds of MB once history is imported |

Under Vitest every default handle is `:memory:`; tests inject their own through `setMemoryStoreForTesting()`, `setBotDbForTesting()`, `setArchiveStoreForTesting()` and friends. Tables and columns: [Storage schema](#storage-schema).

### OpenRouter plumbing

- **One client** (`openRouterClient.ts`): `new OpenAI(` appears nowhere else. `OPENROUTER_TIMEOUT_MS` (2 min per attempt) and `OPENROUTER_MAX_RETRIES` (2) matter because chat turns are serialized per channel: one hung call used to stall the channel (the SDK default is 10 minutes).
- **Feature tags and the usage ledger** (`usage.ts`, `usageFetch.ts`): every SDK call passes `featureRequestOptions('<feature>')`, the `X-Frigidaire-Feature` header, which the client's fetch strips before the request leaves. After a 2xx JSON response the fetch reads `model` and `usage` (tokens, `cost`) from a clone in the background; it never delays or breaks a request. Raw requests (the decisions endpoint) call `recordUsage()` themselves. Rows go into bot.db `usage_ledger`, keyed (Eastern day, feature, model), never pruned. Untagged calls land under `other`; streamed responses aren't recorded. `USAGE_LEDGER_ENABLED=false` is the kill switch. The data feeds `query_costs` and the digest's Spend section.
- **Call-site guard** (`openRouterCallSites.test.ts`): parses every production file with TypeScript's parser and fails on:
  - an SDK call without `featureRequestOptions()`;
  - a chat/embeddings/responses call that isn't visibly ZDR-routed;
  - `new OpenAI(` outside `openRouterClient.ts`;
  - a file that talks to OpenRouter but never records usage (the exemption is `modelCatalog.ts`: free public metadata);
  - a call that caps `max_tokens` below 4000 without a `reasoning` field (see Reasoning budgets below; the exemption is `emojiCaptioner.ts`: Claude only reasons when asked);
  - a `UsageFeature` member that no production code mentions (a tag nothing sends).

  Pass options inline: `create(body, { ...featureRequestOptions('x'), timeout })`.
- **Model catalog** (`modelCatalog.ts`): OpenRouter's public metadata, fetched with plain `fetch` (no key, no member content) and refreshed daily:
  - `GET /models`: context lengths for the history budget; input modalities and the lowest accepted `reasoning.effort` for the media calls.
  - `GET /endpoints/zdr` and `/models/<id>/endpoints`: ZDR coverage for the speech-to-text route.

  A failed fetch keeps the previous copy and retries after 10 minutes. A ZDR verdict older than 3 days doesn't count. It never fetches under Vitest.
- **Decisions endpoint** (`decisions.ts`): TypeSafe decision models answer typed questions about a small JSON state with a calibrated probability: text-only, ~$0.04 per million input tokens, free output, on the ZDR list. `typesafe/jev-1.13` is pinned (`DEFAULT_DECISION_MODEL`) because thresholds are tuned against one version. Every call is ZDR with a 6 s timeout and one retry (network, timeout, 408, 429, 5xx), and records usage. It resolves to `undefined` on no answer, and callers fail closed. Following TypeSafe's guidance, arithmetic stays in code and the state stays small.
- **Reasoning budgets**: the default chat/learner model (`z-ai/glm-5.3-flash`) reasons mandatorily, at `max` effort by default, and reasoning is billed as output and counts toward `max_tokens`. A small `max_tokens` without an effort override can come back empty (`finish_reason: length`), so:
  - One-shot calls send `reasoning: { effort: 'low' }` with `max_tokens` ≥ 1500: the ramble judge, the auto-react judge, the message-judge fallback, the Wrapped intro, the birthday writer and the command completions (Translate, Remember this). The learner and self-improvement passes do too, with 4096.
  - Media calls send the catalog's lowest effort.
  - The emoji captioner sends none: its default model (Claude Opus) only reasons when asked, and an effort would switch paid thinking on. A reasoning model in `EMOJI_CAPTION_MODEL` needs an override there.
  - Summaries (`max_tokens` 4000) and the chat turn (no cap) run at the model's default effort.

### Chat turn (`src/events/aiChat.ts`, `AgentOrchestrator`)

1. **Routing**:
   - A mention *written in the text* (`mentionsInText`) or a reply to the bot goes to the agent. `mentions.users` is not enough: a pinging reply also lists the replied-to author (the bot) there.
   - A reply to the bot's voice-transcript reply is not a reply to the bot.
   - Anything else in a gate channel goes to the [gate](#replying-without-a-mention-srcgate). A positive verdict calls `handleMention(message, { unprompted: true })`.
   - aiChat tells the gate about every routed turn and its end (`noteRouted` / `noteTurnDone`).
2. **Per-channel queue**: two turns in one channel run back to back, so the second sees the first's reply (no lost-update race).
3. **The window**:
   - A new window is seeded from the 25 messages before the ping. It lives for `CONVERSATION_TIMEOUT_MS` (15 min) and is persisted across restarts (schema v3).
   - A live window **catches up** on everything posted since its last turn: the newest 100 messages, rendered as history even though nobody pinged. Up to 4 more pages are only counted, into one "N earlier messages were skipped" line.
   - Messages already in the window are skipped by Discord id (entries carry `messageIds`). So is a relay whose original is already there (`relayed_messages.original_id`: a link-fixed ping must not reappear as a second copy).
   - Transcript replies never enter history.
4. **Prompt**:
   - `entries[0]` is the static prompt: persona, SERVER PEOPLE, emoji glossary and the vibe/personality bucket. It is byte-identical for the whole window, so the provider's prefix cache survives, and it has no timestamp.
   - Every turn adds a **dynamic context** developer entry: the current Eastern time, `Channel: #name — topic` plus its `CHANNEL_NOTES` note (a thread inherits its parent's), `UNPROMPTED_NOTE` or `LATE_MESSAGE_NOTE` when they apply, then memories.
   - Memories come from the speaker (`getForPerson(memoryKeyFor(…))`), a hybrid search of the message, @-mentioned people (≤3) and people **named in plain text** (≤3, `findPeopleInText`). Everything is deduped against what this window already injected.
   - The persona tells the model to call `recall_memories` when someone is discussed and nothing about them is in context.
5. **Reply context**: when the ping replies to a message outside the window, a REPLY CONTEXT entry shows:
   - the chain, root first, up to 5 levels;
   - 3 messages before and 2 after the replied-to one, with jump links;
   - its images and its `reference` enrichments.

   It is capped at 4000 chars, and the ping's header says `(replying to <Author> — <link>)`. A reply to a transcript reply re-targets the voice message itself. When the replied-to message is already in the window, only enrichments that add something new are shown.
6. **Attribution**: every rendered message goes through `attributeMessage()`:
   - relays read as their real author `(id:<main id>)`;
   - other bots and integrations are skipped;
   - the bot's own messages are assistant turns.
7. **Enrichers** (`enrichers.ts`): media and link previews run on every rendered message, by role:
   - `current` and `reference` may do paid work (transcribe, watch, fetch);
   - `history` reads caches only, so seeding or catching up never becomes paid calls;
   - 60 s cap per enricher.
8. **History budget** (`historyBudget.ts`): min(500k, half the smallest context window among `CHAT_MODEL` and its fallbacks), from the model catalog. The lookup waits at most 3 s; `CHAT_CONTEXT_TOKENS` is the fallback and `HISTORY_TOKEN_BUDGET` overrides.
   - Estimate: chars/3.5, plus 1500 per image.
   - Trimming happens when the turn is saved: images in the older half become `[image]`, then the oldest entries go (at tool-call-safe points) down to 75% of the budget. A pre-call trim fires only past 90% of the context.
   - Logged as `history_trim channel=… phase=persist|preflight …`. Persistence caps a saved state at 4 MB.
9. **Tool loop**: `MAX_TOOL_ROUNDS` (25) and `MAX_TOOL_INVOCATIONS` (200) are runaway backstops, then a text-only answer is forced.
   - No request ever carries an unanswered tool call: over-limit calls are answered `not executed: tool call limit reached…`.
   - A call to a tool not offered this turn (gated off, or invented) is never executed, even if a handler exists. It is answered `not executed: that tool is not available` and logged as a `capability_gap`, and the model gets another round.
10. **Reply**:
    - The emoji guardrail runs first, then the text goes out in 2000-char chunks.
    - Files from tools (a generated image, `run_code` output) ride on the first chunk, ≤10 per message; if Discord rejects the upload as too large, the text still goes out.
    - The `react` tool (≤3 per turn) can end a turn with only a reaction.
    - An empty answer posts an `EMPTY_REPLIES` line; an exception posts an `ERROR_REPLIES` line and writes an error capture. Both are in character, and neither is posted on an unprompted turn.
    - Out-of-order turns: an unprompted turn whose message a later turn already showed the model is dropped. A late explicit turn is answered with `LATE_MESSAGE_NOTE`.
11. **Images and files** (`openRouterProvider.ts`, `describeAttachment` in `agent.ts`):
    - Every attachment is named in its message's line with its signed CDN link: `[attachment: data.csv (12 KB) <url>]`, `[image: photo.png <url>]`. That holds wherever the agent renders a message (the current one, seeded history, the catch-up, reply-context lines, its own earlier replies), so `run_code` can download an uploaded file with curl/requests. The links expire after about a day; `read_link` still declines them. In reply-context lines only the text is cut to fit, never a link.
    - A user message's custom emojis, image attachments, stickers and embed images (through Discord's `proxyURL`) also become image parts.
    - A request sends only the newest 40 image parts; older ones go as `[image]`. The cut moves in steps of 10 so the cached prefix rarely changes.
    - Downloads: an LRU cache (150 entries / 256 MB, 15 min TTL that restarts on use), 4 at a time. Non-Discord hosts go through the link reader's SSRF-guarded fetch.
12. **Fallback models**: with `CHAT_FALLBACK_MODELS` set, requests send `models: [CHAT_MODEL, …fallbacks]` with the same `provider: { zdr: true, sort: 'throughput' }`; the response's `model` names whichever answered.
13. **Metric**: one `reply_stats channel=… model=… served_by=… chars=… emoji_kept=… emoji_stripped=… reactions=… names=…` line per reply.

### Emoji policy (`src/ai/emojiPolicy.ts`)

Felix's complaint: the bot put a custom emoji in nearly every reply, often the wrong one. Three layers now:
- **Prompt**: the persona says emojis are basically not used in text, and that a reaction (the `react` tool) is the natural outlet. The static prompt carries an *emoji glossary* (name + caption, for reading what people post) that deliberately withholds the `<:name:id>` syntax. Deliberate in-text use goes through the `get_emoji` tool, whose description tells the model to hold back.
- **Guardrail** (`applyEmojiPolicy`): at most one custom emoji per reply, and only when the reply is emoji-only, the triggering message contained a custom emoji, or none of the bot's last 4 replies in the window had one. Unknown emoji ids are always stripped. When the guardrail edits a reply, the stored assistant entry is rewritten to the posted text, so the model never re-learns the stripped version from its own history.
- **Metric**: `emoji_kept` / `emoji_stripped` in `reply_stats`. `emoji_stripped` staying high means the prompt still wants one; the rate itself is the guardrail's.
- Captions: see [usage-grounded captions](#usage-grounded-emoji-captions-srcreactionsemojiusagets-usagecaptionsts): what each emoji *means to this group* now comes from the archive.

### People and linked accounts (`src/ai/people.ts`, `src/linkedAccounts.ts`)

One module turns names, mentions and ids into members: the agent, memory tools, summaries, the learner, reminders, birthdays, commands and archive search all use it. Don't add another matcher.
- **Names a member goes by**: user id, handle (`username`), current display name, first-seen display name (`canonical_name`), IRL name, aliases. They are compared with `nameKey()` (case, accents and extra spaces ignored).
- **Tiers** (`findMembersByName`): display name → handle → first-seen → IRL name → nickname → the first word of a multi-word IRL name (only when unique and nobody has it as a stronger name). The first tier with a match wins. Two members in that tier is ambiguous and is never guessed, so a nickname can never steal someone's own name.
- **`lookupPerson()`**, in order:
  1. an explicit id (`<@id>`, `(id:…)`, a bare snowflake);
  2. "me"/"I" → the requester (relays count as their real author);
  3. crowds (`everyone`, `server`, …) and the bot's own names → not a person;
  4. a member @-mentioned in the message;
  5. the tiers above;
  6. with `fuzzy` (reminders and birthdays only): a word inside a name, then a unique 3+ character prefix.

  The directory holds the identities table plus live Discord data: the author, @-mentioned users and cached guild members. `resolvePerson()` (memory tools) returns `undefined` on any doubt, because a memory must never be filed under a guess. `resolvePersonRef()` returns an explanation the model can act on.
- **Text matching** (`createPeopleMatcher` / `findPeopleInText`): `<@id>` tokens, plus whole-word, case- and accent-insensitive names. It never matches:
  - inside URLs, custom emojis, mention/role/channel tokens or timestamps;
  - stop words, or the bot's own names;
  - names under 3 chars (IRL names are allowed down to 2);
  - names two members share.
- **`memoryKeyFor()`** is the `getForPerson()` key: the main id plus every name of every account. Use it instead of hand-built name lists. `getForPerson()` matches id-stamped rows by id, and a name only matches rows with no id: a shared name must never pull another member's memories in.
- **Linked side accounts** (`LINKED_ACCOUNTS`, csv of `sideId:mainId`; `;` and line breaks also separate pairs):
  - Chains resolve to their final main. A side linked to two mains, loops, malformed pairs and self-links are dropped with a startup WARN (a wrong link would merge two people's memories).
  - `attributeMessage()` returns the main id, under the main account's current display name.
  - The main id is what memories, learner subjects, remember_fact, reminders (targets and requester), birthdays, archive `author_id`, gate partners, ramble cooldowns, feature-request caps and the deleted-message watch list key on. Reminders ping every linked account of a target.
  - The side account keeps its own identities row and appears only on its member's SERVER PEOPLE line ("also posts as …").
- **SERVER PEOPLE line** (`formatIdentityLines`, shared by chat and learner): `- Wheelie @wheelie_d (id:…) — real name Dorian; also called D, Wheels; formerly OldNick; also posts as …`. The line starts with the current display name, which is the subject new memories are filed under.

### Replying without a mention (`src/gate/`)

The bot answers when someone is clearly talking to it without an @-mention or a Discord reply ("fridge who wins worlds", or "nah that's wrong" in the middle of a conversation with it). Cheap checks first, then one decision-model call.
- **Exchanges, not single replies.** Conversations come in bursts. A channel has an *active exchange* while the bot answered someone there within `GATE_FOLLOWUP_SECONDS` (120 s). The window slides: every answer extends it, and a turn still being answered keeps it open.
  - Everyone answered since the exchange began is a **partner** (compared with `isSamePerson`, so side accounts count).
  - Exchanges come only from routed turns, never from the bot's own posts: a ramble nudge, a transcript or a reminder is not a conversation. `noteBotMessage` only records *when* the bot last spoke.
  - State is in memory. After a restart, follow-ups without a name work again once the bot has answered someone.
- **Free prefilter** (every message in `GATE_CHANNELS`, default `MAIN_CHANNEL_ID`; threads aren't watched): human authors only. A message is a candidate when it names the bot (`GATE_NAMES`: whole word, case-insensitive, ignoring links, emoji markup and mentions; the bot's own names always count) or its author is a partner.
- **Caps** (per channel, rolling 10 min; explicit mentions and replies are never capped):
  - cold interjections (a name-drop with no active exchange): `GATE_MAX_COLD_PER_10MIN` (3);
  - inside an exchange, only the runaway guard: `GATE_MAX_PER_10MIN` (30).

  Both are checked before the model call and again after it.
- **Decision** (`addressed.ts`): one question to `GATE_MODEL`, recorded as usage `gate`. The state holds:
  - the message and the 6 before it (fetched; relays credited to their authors; bots marked; transcripts dropped; a reply to a transcript reads as a reply to "a voice message");
  - when the bot last spoke, in words;
  - whether the author is a partner.

  `p < GATE_THRESHOLD` (0.7) or no answer means no reply.
- **Logs**: `gate: REPLY|skip p=… threshold=… trigger=name|followup|name+followup mode=cold|exchange channel=… msg=… author=… text="<80 chars>"`. This is what you grep when tuning.
- `wasRouted(id)` (the last 200 routed messages) and `isInExchange(channel, user)` let other features (ramble, auto-react) stay off a message the bot is already answering.
- **Eval** (`src/gate/eval/`): `cases.json` holds 108 synthetic cases (id prefixes: `name-`, `followup-`, `group-`, `about-`, `fridge-`, `gaming-`, `reaction-`, `clanker-`, `otherbot-`, `nudge-`), strictly validated offline.
  - `yarn eval:gate [extra.json …]` runs them live, plus the gitignored `data/gate-cases.json`, for about $0.00001 per case.
  - It prints precision/recall/F1 at thresholds 0.5–0.9 and at `GATE_THRESHOLD`, for the model alone and end to end behind the prefilter, and lists the misses.
  - Case format: see `cases.ts`. Build `data/gate-cases.json` from real misfires in the logs.

### Ramble redirect (`src/gate/ramble.ts`, `rambleJudge.ts`, `rambleExamples.ts`)

It fires on **content** (monologue-ish, stream-of-consciousness rambling, the thing the group made a whole channel for), not on volume. Off unless both `RAMBLE_USER_IDS` and `RAMBLE_CHANNEL_ID` are set.
- **Prefilter**: a watched member (side accounts included) in `RAMBLE_WATCH_CHANNELS` (never the ramble channel) posts either:
  - `RAMBLE_MIN_MESSAGES` (3) messages in a row within `RAMBLE_WINDOW_SECONDS` with nobody in between, and ≥60 characters of prose in total. The bot's posts break a run; relays neither count nor break it.
  - or one message of `RAMBLE_LONG_MESSAGE_CHARS` (600) characters of prose.

  Messages that mention, reply to or were routed to the bot are skipped.
- **Judge**: `CHAT_MODEL`, ZDR, low effort, tagged `ramble`. It sees up to 4 real rambles read from the archive's copy of `RAMBLE_CHANNEL_ID` (a labelled set), up to 8 of the member's normal messages, the messages just before the run, and the run. Examples are cached per person for a day (re-checked hourly while none exist); with none it runs zero-shot. The answer is `{ramble, confidence}`, and only `ramble && confidence ≥ RAMBLE_THRESHOLD` (0.75) nudges. After a "no" it waits for 2 more messages.
- **Nudge**: one reply without a ping from a pool of 13 in-character lines, never the same line twice in a row. It is skipped if the bot posted or answered meanwhile.
  - Per-member cooldown `RAMBLE_COOLDOWN_MINUTES`, in bot.db (`ramble_nudges`, keyed by main id), recorded before sending and kept if the send fails.
  - A nudge never makes the member a gate partner.
- Logs: `ramble: NUDGE|not a ramble … examples=<rambles>/<normal>`.

### Spontaneous reactions (`src/reactions/`, events `autoReact`, `autoReactDelete`, `autoReactBulkDelete`)

Owner's brief: now and then add ONE emoji to a post that genuinely stands out, the way the group reacts, "only when it's a real good one", and learn how the group reacts first. **`AUTO_REACT_MODE=shadow` is the default**: it decides exactly as live mode would but only posts `-# auto-react (shadow) · would react <emoji> to <author>'s post <link>` plus the reason to the report channel. Shadow rows count against the budget, so the report mirrors live behavior. The owner reviews it, then sets `on`.
- **Intake** (free): member posts in `AUTO_REACT_CHANNELS` (threads through their parent). The bot's own relays count as the member's post; other bots and integrations don't. Skipped:
  - posts that mention or reply to the bot, or contain a `GATE_NAMES` word (those get answers instead);
  - text-only posts under 4 characters.
- **After `AUTO_REACT_DELAY_SECONDS`** (previews resolve; a deleted or purged post is cancelled), in order:
  1. attribution;
  2. not already replied to or reacted to (for a relay, the original's id is checked too);
  3. the author isn't mid-exchange with the bot (`isInExchange`) and the post wasn't routed to the agent (`wasRouted`);
  4. the budget has room;
  5. the reaction profile has ≥ `AUTO_REACT_MIN_PROFILE_MESSAGES` (200) reacted member posts.

  Only then is the model called.
- **Guide** (`guide.ts`): built from the archive's reaction profile. It has the base rate and the top 25 emojis the bot can actually use, each with its use count, caption and 2–3 example posts. Cached for 24 h, and rebuilt hourly while still learning.
- **Judge**: `CHAT_MODEL`, ZDR, low effort, `json_object`, tagged `auto_react`. It sees the post, up to 2 Discord-hosted images (downscaled to 768 px), link previews or embed text, the reactions so far and ~6 context messages. The answer `{react, emoji, why}` must resolve through `resolveReactionEmoji` or nothing happens.
- **Budget** (bot.db `auto_reactions`): `AUTO_REACT_MAX_PER_DAY` (3, rolling 24 h), `AUTO_REACT_MIN_GAP_MINUTES` (45), never twice on a message. It survives restarts. The slot is claimed synchronously before reacting and released if the reaction fails.
- Cost is ~$0.0001–0.0002 per judged post; nothing is judged during the gap or once the day's budget is spent.

#### Usage-grounded emoji captions (`src/reactions/emojiUsage.ts`, `usageCaptions.ts`)

First-pass captions (`emojiCaptioner.ts`, `EMOJI_CAPTION_MODEL`) can only guess an emoji's meaning from its name and image, which gives the generic internet meaning. Prod showed the group's usage often differs (an emoji captioned "sadness" used as a resigned "bruh"). A caption reads `<visual>; for <meaning>`, and this job rewrites the meaning half from real usage:
- **Samples** (up to 20): member reactions from the reaction profile, plus messages the emoji was typed in. Typed uses are found through the archive FTS by id and confirmed against the exact `<:name:id>` token; a bare emoji comes with the message it answered.
- **Job**: covers emojis with ≥5 uses. An emoji is re-grounded only when it never was, when its caption changed (rename, `EMOJI_FORCE_RECAPTION`), or when its uses grew by half and by ≥10.
  - At most 40 per run; a run stops after 3 failures in a row.
  - State lives in bot.db (`emoji_usage_captions`, `reaction_jobs`).
  - First check 10 min after startup, then every 6 h against a 7-day watermark. `EMOJI_RECAPTION_FROM_USAGE=1` forces a full pass (one-shot).
  - **Not during a history import**: while the archive sync runs or a backfill channel is unfinished (`isArchiveImportInProgress()`), checks skip without touching the watermark, so a fresh archive's first pages don't set the counts for a week. A forced pass still runs but leaves the watermark alone.
- `EMOJI_FORCE_RECAPTION` wipes the meaning halves too: they come back on the next weekly run, or immediately with `EMOJI_RECAPTION_FROM_USAGE` set on the same restart.

### Media: voice and video (`src/ai/media/`)

The chat model never receives audio or video. It reads the text this layer produces, and can ask for more.

| Input | Route |
|---|---|
| Voice message / audio file | Whisper (`TRANSCRIPTION_MODEL`, `openai/whisper-large-v3`) on the speech-to-text endpoint, while every host serving it is ZDR; otherwise `TRANSCRIPTION_FALLBACK_MODEL` (Gemini chat completions with `zdr: true`) and a WARN |
| Uploaded clip / linked video file | `VIDEO_MODEL` (Gemini 3.5 Flash-Lite) watches picture and soundtrack in one call (base64 `video_url`: ZDR endpoints fetch no URLs) |
| Over `VIDEO_MAX_BYTES` / `VIDEO_MAX_SECONDS`, a container Gemini refuses, a failed native call | ffmpeg samples ≤8 keyframes (≤768 px), the soundtrack goes to Whisper (cut at `VOICE_MAX_SECONDS`), a vision call sees both |
| A model that watches but can't hear | the whole clip plus the soundtrack transcript |
| YouTube | metadata only (link reader): no file to upload, and only AI Studio (not ZDR) takes YouTube URLs |
| A follow-up question about a video | `watch_video`, or `read_link` with `question`: the video model watches again |

- **Entry points** (`index.ts`): `transcribeAudio`, `getCachedTranscript`, `watchVideo` (returns the full `VideoOutcome`, or with `input.question` the answer), `videoOutcomeNote`, `startTranscriptionRouteChecks`. They are used by the agent (through the enricher), the learner, summaries, the link reader and the commands. Results are cached in bot.db, so whoever pays first, every later reader gets them free.
- **Transcription** (`transcriber.ts`, `speechToText.ts`):
  - The route is `stt`, `chat` or `off`. It is checked at startup (`transcriptionRouteCheck`), daily, and before each request; a verdict change is logged.
  - STT request: `verbose_json` + segment timestamps, no `language` (the group code-switches, and Whisper auto-detects).
  - Ogg/Opus and the other common formats go as-is. aac/aiff and anything over 14 MB are converted to MP3 first, and a refused format is retried as MP3.
  - Hallucination filter: Whisper's own no-speech rule on segments, subtitle-credit and outro phrases anywhere, and fillers only when no-speech is likely.
  - Clips under 1 s are stored as no speech without a call. Limits: 25 MB download cap, 5-minute failure cooldown, one run per message at a time (the auto-transcript and the agent share it). The fallback prompt adds no translation line.
- **Video** (`video.ts`):
  - Downloads are capped at max(`VIDEO_MAX_BYTES`, 50 MB). Output is 1–3 sentences plus `On-screen text:` / `Said:` lines.
  - Answers are cached per (URL, normalized question) in `video_answers`. Clips stay in a small memory cache (`clipCache.ts`: 3 clips / 64 MB / 10 min) so a follow-up doesn't download again.
  - **Budget** (`videoBudget.ts`): before downloading and before every video call, today's (Eastern) `video` spend is read from the usage ledger. At or over `VIDEO_DAILY_BUDGET_USD` ($0.50/day; 0 = unlimited) the outcome is `over_budget`, rendered in character as "out of popcorn money". Cached results are still served; transcription isn't counted; concurrent calls can overshoot by one. It needs the ledger on.
- **Enricher** (`enricher.ts`): renders `[voice message from <Name>, m:ss: …]`, `[audio file "x.mp3" from <Name>: …]` and `[video msg:<id>: …]`. `msg:<id>#2` addresses a message's second clip, and is the handle `watch_video` takes. Up to 3 audio and 2 video attachments per message; a result that isn't available leaves a marker (`(not watched)`, `(too large to watch)`, …). History only reads the cache, or joins a transcription already in flight.
- **Auto-transcripts** (`autoTranscribe.ts`, `voiceTranscribe` event):
  - Only for real voice messages (the IsVoiceMessage flag), in `VOICE_TRANSCRIBE_CHANNELS` (empty = all). Past `VOICE_MAX_SECONDS` the reply is a silent `-# 🎙️ too long to transcribe (m:ss)`.
  - The reply: `-# 🎙️ transcript` (`(i/n)` on every chunk of a long one) plus quoted, escaped lines, with `SuppressNotifications` and `allowedMentions: { parse: [], repliedUser: false }`. Its ids go into `transcript_replies` (90 days).
  - `isTranscriptReply()` (header or stored id) and `repliesToTranscript()` keep transcripts out of history, the gate, auto-react, the archive and summaries. A reply to one is not a reply to the bot.
  - Deleting (or purging) the voice message deletes the transcript and forgets the cached text.
- **Downloads** (`download.ts`): only Discord's media hosts are fetched directly. Everything else, including a Discord URL that redirects elsewhere, goes through the link reader's `createSafeFetch()` with a content-type allowlist; a declared oversized body is refused before download. `generate_image` downloads a URL-only result the same way (image types, 20 MB, 30 s).
- **Transcoder** (`transcoder.ts`): the only place the bot shells out. Arguments only (no shell), extension-less temp input, 90 s SIGKILL, 2 concurrent jobs. Without ffmpeg the features degrade instead of failing.

### Link reader (`src/ai/linkReader/`, `src/ai/tools/linkReader.ts`)

Fetching makes no model calls and is free; the only paid step is watching a linked video.
- **`LinkReader`** (`reader.ts`, shared by the tool and the enricher): identifies the link (`targets.ts`), runs its extractor, and caches the result per canonical link. So `x.com/…/status/1`, `fixvx.com/…/status/1` and the link-fix repost share one entry. LRU of 200 entries: successes 1 h, deleted/private 15 min, transient failures 2 min. Concurrent reads are merged.
- **Extractors**:
  - Twitter/X: FxTwitter's API (text, translation, quote, poll, community note, media), with the fixer pages as fallback.
  - YouTube: oEmbed + the watch page's player response (no transcripts, no file).
  - TikTok/Instagram: official oEmbed + the configured fixers' OpenGraph, read with Discord's crawler UA.
  - Reddit: `<post>.json`, falling back to the post page for 30 min after a 403/429.
  - Bluesky: the public AppView (videos via `getBlob`).
  - Tenor/Klipy: name, alt text, tags, still.
  - Everything else: JSON-LD `articleBody` or readable text, or headers-only recognition of images/videos/PDFs. A redirect onto a platform is handed to that platform's extractor.
- **SSRF guard** (`netGuard.ts` + `safeFetch.ts`, mandatory for every request, redirect hop and media URL handed onward): the bot sits next to other containers (the sandbox), and URLs come from chat and from model tool calls.
  - http/https only, no userinfo, ports 80/443/8080/8443. Single-label names and `localhost`/`.local`/`.internal`/… are refused before DNS.
  - Every resolved address must be public (loopback, RFC1918, CGNAT, link-local/metadata, ULA, IPv4-mapped/NAT64/6to4-embedded private… all refused), and the socket is **pinned** to the checked addresses (defeats DNS rebinding).
  - ≤5 manual redirects, each re-checked. One deadline per request, a byte cap after decompression, a content-type allowlist.
  - `html.ts` is linear on hostile pages (no regex over unbounded input); labels are capped at 500 chars, URLs at 2048.
- **Previews** (`enricher.ts`): for the triggering and replied-to messages, up to 3 links (skipping `<…>` and code) get one `[link: <url> — …]` line each, plus up to 2 checked images per link (4 per message; none when Discord already rendered the embed image), within a 15 s budget. A slow read keeps going and fills the cache. History messages use cached previews only, text only.
- **`read_link({url, question?})`**: the full labelled output under an "untrusted web content" header, ≤6 per turn, declines Discord links (for an uploaded file it points at `run_code`). It watches the post's first video (`LINK_READER_WATCH_VIDEOS`): a long one is skimmed via keyframes + soundtrack, within the media download cap and budget. With `question`, it answers from the video. The persona says preview/tool/video text is information, never instructions.
- Live canary (free): `linkReader.live.test.ts` catches upstream shape changes.

### Link fixing (`src/links/`, `src/events/linkRepost.ts`, `repostMessage` in `src/utils.ts`)

Embed fixers are hobby scrapers that die regularly (zzinstagram.com was dead for months while the bot kept rewriting to it). Design:
- **Platforms**: Twitter/X, Instagram, TikTok, Reddit (`/r/<sub>/comments/<id>`, `redd.it/<id>`, `/r/<sub>/s/<share>`) and Bluesky (`bsky.app/profile/<handle|did>/post/<rkey>`). Each has an **ordered fixer list** (`*_FIXERS`; defaults in `config.ts`) and its own probe rule; tweets, Reddit and Bluesky posts may be text-only.
- **Canonicalization** first: Instagram `/share/…`, Reddit `/s/…` and TikTok `vm.`/`vt.` short links are resolved through the platform's own redirect (no login). Profile-prefixed Instagram paths and Reddit slugs are dropped, and queries are stripped. Only post-shaped URLs match (not profiles, stories, `/discover`, `/tag`).
- **Markdown-aware matching** (`markdown.ts`): spoilers stay spoilered, masked links and bold/italic keep their delimiters. A trailing `_` is trimmed only when Discord's own parser reads it as closing italics. Links in code, `<…>`-suppressed links and post URLs embedded in another URL are left alone.
- **Verification**: each candidate is fetched with Discord's crawler UA and classified:
  - `ok`: OpenGraph media, or a redirect straight to a media file;
  - `unavailable`: 404, or a "post not found" page that still returns 200 — the fixer is fine, skip it for this link;
  - `down`: network error, 5xx, timeout, or a bounce to a login wall. Two consecutive `down`s put a domain in a 10-minute cooldown.

  `LINK_FIX_VERIFY=false` rewrites blindly to the first domain. If no fixer works, the message is left alone (a raw link beats a guaranteed-broken one).
- **Tweet translation** (`tweetTranslation.ts`): FxTwitter's status API gives the language (2.5 s cap, in parallel with the probe). A foreign tweet gets `/<TWITTER_TRANSLATE_TO>` appended, but only on domains verified to translate.
- **Faithful repost or none** (`repostMessage` → `RepostOutcome`):
  - Checked before any probing (`repostBlocker`): a webhook-capable target; not a forum post's starter; no stickers or poll; ≤2000 chars; attachments ≤ `LINK_REPOST_MAX_ATTACHMENT_BYTES`; the bot has Manage Webhooks + Manage Messages.
  - Attachments are re-uploaded, all or nothing, with their names (`SPOILER_` kept) and alt text.
  - A reply gets a `-# ↪ replying to <Name> · <jump link>` line. `@silent` is kept. `allowedMentions: { parse: [] }`. Webhook names are sanitized (Discord rejects "discord"/"clyde").
  - A message edited while it was being prepared is left alone (`stillCurrent`).
  - The repost is sent **before** the original is deleted; if the delete fails, the repost is taken back. The temporary webhook is always deleted (the 15-per-channel cap can't leak).
- **Channels**: text, announcement and voice-channel chat own the webhook. Threads and forum posts post through the parent's webhook with `threadId`. Archived/locked threads and DMs are skipped.
- **Fixer-health alerts** (`fixerHealth.ts`, `fixerAlerts.ts`, `linkFixAlerts` event): a platform is **down** once every fixer is in cooldown, so a one-off blip on the bot's host never alerts, and **up** on the next success.
  - One report-channel post per change. Down alerts are limited per platform to one per `LINK_FIX_ALERT_MIN_INTERVAL_MS`, deferred to the window's end and posted only if still down. Recoveries only close an announced outage.
  - State lives in bot.db (`link_fix_alerts`), so a redeploy mid-outage neither repeats the alert nor forgets the recovery. A failed post is retried with backoff (10 min doubling to 6 h).

### Deleted-message repost (`src/deletedMessages.ts`, `src/ai/messageJudge.ts`)

For users in `DELETE_REPOST_USER_IDS` (either account of a linked pair watches both), every new message in a text or announcement channel is snapshotted: content, identity, and attachment bytes ≤10 MB downloaded immediately, because Discord drops attachments on delete. When such a message is deleted within `DELETE_REPOST_WINDOW_MS`:
- Nothing is judged when there is nothing left to repost.
- `DELETE_REPOST_MODE=edgy` (default): the judge decides. `DELETE_REPOST_MODEL` defaults to `typesafe/jev-1.13` (the decisions endpoint, ~$0.00001 per call). Image-only messages, or a decision-model failure, fall back to the chat model: a JSON yes/no, low effort, 1500 tokens, judged from the **saved** image bytes (the CDN URLs die with the message). Any chat model id in `DELETE_REPOST_MODEL` skips the decision model. No verdict ⇒ no repost.
- `DELETE_REPOST_MODE=always`: every qualifying deletion is reposted.
- The repost goes through `sendViaWebhook` as the author with `parse: []`, chunked when the text exceeds 2000 characters (Nitro), and is recorded as a `regret` relay. Deletions the bot performs itself (link fixing) are excluded via `forget()`.

### Message archive, search and Wrapped (`src/archive/`, `src/ai/tools/messageSearch.ts`)

Every member message the bot can see (guild text and announcement channels and their threads, minus `ARCHIVE_IGNORE_CHANNELS`) is kept in `archive.db`.
- **FTS integrity by construction**:
  - The external-content FTS5 index (porter + remove_diacritics) is kept in sync **only by triggers**.
  - Never `INSERT OR REPLACE` into `messages`: REPLACE's implicit delete doesn't fire the delete trigger. Upserts use `ON CONFLICT` and write only on change.
  - Deleted rows stay indexed with their text scrubbed; "not deleted" is a query filter. Tests run FTS5's `integrity-check` after every kind of write.
  - Snowflakes are TEXT, with an explicit `seq` INTEGER key the index points at.
- **Attribution**: everything goes through `attributeMessage()` (relays → the real author, main id). Other bots and integrations are skipped. The bot's own messages are kept as source `bot`: searchable, never a member's message in stats. A relay archived before its registry row exists is fixed ~5 s later (`RelayReconciler`), and a 5-minute maintenance pass also copies in new transcripts.
- **Live ingest**:
  - Edits count one per newer `edited_at` and keep the stored reactions: a gateway payload carries none.
  - Deletions scrub the text and keep the row. `deleted_kind` is `message`, `bulk` (purge) or `channel` (a deleted channel or thread), and only single deletions count in Wrapped.
- **Reactions** (`reactions.ts`): counts come with every fetched message (ingest, backfill). Reaction events apply a **±1 delta** to the stored counts and never copy discord.js's cache, which is empty for messages rebuilt from gateway payloads. `getReactionProfile()` gives per-emoji member uses (the bot's own excluded), examples and the base rate, and respects `ARCHIVE_IGNORE_CHANNELS`.
- **Backfill and gap fill** (`backfill.ts`, `archiveBackfill` on ClientReady):
  - Gap fill pages every channel with history forward from its newest archived message. The cursor is persisted in `gap_fill_state`, so a stopped run resumes without leaving a hole.
  - Once per process, each channel active in the last 7 days re-reads its newest page, which heals reactions and edits made while offline and marks messages deleted while offline.
  - Each `ARCHIVE_BACKFILL_CHANNELS` channel is then imported backwards, 100 per request every `ARCHIVE_BACKFILL_DELAY_MS` (~90 msg/s), with the cursor committed in the same transaction as each page (resumes exactly). Missing access is recorded and retried hourly, and progress with a storage projection is logged every 25 pages. Threads' older history is not imported.
  - `importInProgress()` / `isArchiveImportInProgress()`: a run is under way, or a backfill channel is unfinished and not waiting out an error. The usage-caption job waits on it; Wrapped only waits for the gap fill (`status().phase`).
- **Tools**: `search_messages({query?, author?, channel?, after?, before?, limit≤20})` and `get_message_context({message, before?, after?})`.
  - Search is FTS in two tiers (all terms, then any non-stop-word term), BM25 blended with recency. `author` resolves through the people resolver across every account; times are Eastern wall-clock. Result lines: `[YYYY-MM-DD HH:MM ET] #channel Author: content (jump link)` plus the top reactions.
  - **Visibility** (`replyAccessFor`): a channel is searchable only if the asker can read it AND it is at least as visible as the channel the answer is posted in, so a mod's question in the main channel never quotes a private channel. This also closes Ask Fridge, where the "asker" is the target's author. `watch_video` jump links follow the same rule.
- **Wrapped** (`wrapped.ts`, `archiveWrapped` + `wrappedPreview` events): a **yearly** post for the previous year, from Jan 1 15:00 ET within a 3-day late window, in `WRAPPED_CHANNEL_ID` (default: the report channel, so the owner sees it before the group).
  - Contents: top yappers, busiest ET day and hour, top channel, top custom emojis, most reacted message, links per platform, voice messages, most regretted, edits and deletions, ramble of the year, bot pings.
  - The text is deterministic and pings nobody. An optional roast-y intro line comes from `CHAT_MODEL` at low reasoning effort (`WRAPPED_LLM_INTRO`); a failure drops the line.
  - Only channels at least as public as the Wrapped channel count.
  - Watermark in bot.db `wrapped_posts` (`year:YYYY`): `posting` (taken over after 15 min), `sending` (never retried), `posted`, `skipped` (final, WARN), `retry` (backoff 5 min → 6 h until the window ends), `failed`.
  - **`!wrapped` / `!wrapped 2025` in the report channel** posts a preview through the same pipeline without touching the watermark. It works even with `WRAPPED_ENABLED=false`, and its footnote lists the channels it counted.

### Summaries (`src/ai/tools/summary.ts`)

The bot's only summary pipeline. `summarizeChannelResult()` does the history fetch (≤50 pages, ranges ≤7 days), renders a transcript and makes one ZDR call tagged `summary`. It returns data (`ok`, `summary`, `header`, `caveats`, `peopleFooter`, or a failure `reason`); `summarizeChannel()` formats that for the `summarize_messages` tool.
- **Tool arguments**: `start_time`/`end_time` are Eastern wall-clock `YYYY-MM-DD HH:MM`, or `since_my_last_message` (the requester's previous visit; their messages from the current visit, 15-minute gaps, are skipped).
- **Transcript**: relays are attributed, other bots excluded, the bot's lines short and marked, transcript replies skipped. It carries embeds, attachments, stickers, cached voice transcripts and "(replying to X)". Over ~200k chars the oldest messages are dropped, with a note.
- **WHO'S WHO**: up to 25 people (everyone who talked, then everyone referenced). The 8 most prominent get ≤4 durable memories each (fact/preference/personality), fenced as background never to be stated unless the chat says it. The result ends with `People in this stretch: …; mentioned without talking: …`.
- "Summarize from here" passes `messageRole: 'target'` (the target message is included) and `audience: 'group'` (the text is posted as-is: casual, short, no headings or @-mentions).

### Scheduling: reminders, polls, birthdays (`src/scheduling/`, `src/ai/tools/reminders.ts`, `birthdays.ts`)

Everyone lives in America/New_York, so every time a tool takes or shows is Eastern wall-clock. One unref'd 30 s scheduler tick (started by `schedulerStart`) drives reminder delivery and the birthday announcement, each with its own in-flight guard.
- **`set_reminder({text, at?, in_minutes?, for?})`**:
  - `at` is `YYYY-MM-DD HH:MM` ET, or a bare `HH:MM` meaning the next time the clock shows it; a date without a time is refused (it would ping at midnight). Exactly one of `at`/`in_minutes` (rounded up to whole seconds); 1 min to 366 days out.
  - `for`: up to 10 people through the resolver (fuzzy), "me" by default.
  - Every error states the current ET time, so the model can correct itself. Cap: `REMINDERS_MAX_PER_USER` pending per requester (main id).
  - `list_reminders` shows the channel's pending ones; `cancel_reminder` is allowed for the requester or a target.
- **Delivery**:
  - Post format: `⏰ <@targets> text` + `-# set by <name> · <jump link>`, with `allowedMentions: { parse: [], users: <every linked account of the targets> }`.
  - **No double posts**: a due row is claimed (pending → sending) with a conditional UPDATE before posting, and each send carries `nonce: reminder-<id>` + `enforceNonce`. A claim stale for 5 min is released and re-sent under the same nonce.
  - Late notes: `(late — I was offline)` for reminders missed while down, `(late)` after retries. Retries at 1/5/15/60 min, then `failed`.
  - If the channel is gone or unpostable, the reminder goes to `MAIN_CHANNEL_ID` with a note. A reminder set somewhere private (not visible to @everyone, `source_private`) keeps its pings and link there but withholds its text.
- **`create_poll({question, answers, duration_hours?, allow_multiselect?})`**: a native poll, validated against Discord's limits first (question ≤300, 1–10 unique answers ≤55, 1–768 h, default 24). It needs the Create Polls permission.
- **Birthdays** (bot.db `birthdays`): `set_birthday` (`MM-DD` or `YYYY-MM-DD`), `list_birthdays` (by next occurrence, with the age they'll turn) and `forget_birthday`.
  - The announcement starts once ET reaches `BIRTHDAY_ANNOUNCE_HOUR`, for birthdays that are **today** (Feb 29 → Feb 28 in common years), so a bot down all afternoon announces late the same day, never the next. It goes to `BIRTHDAY_CHANNEL_ID` (default main).
  - The text is written by `CHAT_MODEL` (ZDR, low reasoning effort, tagged `birthday`), then cleaned and 🎂-prefixed; a template is used on failure. The writer gets today's Eastern date and what the bot knows about the person nearly whole: up to 40 memories (past that, the 20 oldest and the 20 newest; no `image` or self-diagnosis rows), oldest first, each tagged with when it was first noted (`created_at`, so re-confirmed lore stays old). It picks for itself: long-running things (a trait, a running joke, old lore) first, and anything from the last couple of weeks only as recent news. Undated and limited to the newest 5, it once told yesterday's story as old lore.
  - The year is claimed before posting and released if the send fails. A birthday set in chat on the day is marked announced (the reply was the wish). Members who left are skipped.
  - **`BIRTHDAYS_SEED`** (`userId:MM-DD` / `userId:YYYY-MM-DD`) is applied **once per user** (`birthday_seed_applied`): chat corrections and `forget_birthday` stick. A seed entry that differs from a saved birthday is logged as a WARN (use `set_birthday` to change it).

### Code sandbox (`sandbox/`, `src/ai/tools/sandbox.ts`)

`run_code({language: python|bash|node, code, timeout_seconds?, reset_workspace?})` gives the bot a computer for math, bill splits, conversions, dates, data and charts. It runs on the owner's own machine, so the limits are generous and only there to stop a runaway: 15 minutes per run, 2 GB of memory, 20 GB of workspace, no per-file cap.
- **Why a sidecar**: the bot container holds the Discord token and the OpenRouter key, and the model reads arbitrary chat and web pages, so one prompt-injected command next to those secrets could exfiltrate them. The sidecar holds no secrets (no `env_file`; only its optional `SANDBOX_TOKEN`, which runs never see). **Never give the sandbox service the bot's `.env`, and never let the bot run commands itself.**
- **Server** (`server.py`, Python stdlib only; `POST /run`, `GET /health`):
  - **Isolation**: each run executes as uid 10001 in `/workspace`, in its own process group, with rlimits (CPU = the run's timeout, data 1792 MB, file size only when `SANDBOX_FILE_SIZE_MB` sets one, nproc, nofile, no core) applied by an exec launcher, and the maximum OOM score so the kernel kills the run, not the server. A run lasts at most `SANDBOX_MAX_TIMEOUT_SECONDS` (900). Timeout or exit SIGKILLs the group, and the server, a child subreaper, sweeps escaped descendants. Output is capped at 12 KB head + 4 KB tail per stream; `out/` files come back base64: ≤10 files, each ≤10 MB, ≤25 MB in all (Discord's per-message count and default upload size); the rest are listed as omitted with the reason.
  - **Self-protection**: the server is **PID 1** (no tini: the kernel won't deliver SIGSTOP/SIGKILL to a namespace's init from inside it) and non-dumpable, so `/proc/1/environ` is unreadable from runs. It refuses `/run` from its own addresses (a run can't queue follow-up runs), and drops a queued request whose client hung up. Runs are serialized behind a lock with a short queue (3 waiting, 30 s, then 429/503 carrying `busy_for_seconds`/`busy_limit_seconds` of the run holding it, so the model can say when to try again instead of retrying in a loop).
  - **Persistence without tampering**: `/workspace` persists on purpose (files, `pip install --user`, `npm install`) within `SANDBOX_WORKSPACE_MAX_MB` / `_MAX_FILES`; a run that goes over is killed and the workspace wiped. Python runs with `-P` + `PYTHONSAFEPATH=1` (a planted `json.py` can't shadow the stdlib; import your own module with `sys.path.append('/workspace')`). System dirs come first on PATH. Node package lookups are pinned per run directory. Installed packages are trusted until `reset_workspace: true` wipes everything first; the tool suggests it after a server error.
- **Tool**: offered only when `SANDBOX_URL` is set. The run limit is `SANDBOX_TIMEOUT_SECONDS` (default and maximum 900 s); the model's `timeout_seconds` can only cut a run shorter. The HTTP timeout is the run limit + 60 s (queue wait, the sidecar's wipe/disk walk/file encoding, the round trip).
  - **Transport**: `node:http`/`node:https` (`createNodeHttpFetch`), never the global fetch: undici's 300 s headers/body timeouts would fail any run over 5 minutes on the bot's side while the sidecar was still working (the sidecar answers only when the run ends). One connection per run, TCP keep-alive on, the caller's signal as the only deadline, answers capped at 64 MB.
  - Uploaded files: the tool description tells the model that `[attachment: …]`/`[image: …]` lines carry a download link (see Chat turn, Images and files) and that it expires after about a day.
  - Typed failures: unreachable/timeout/unauthorized also write a `tool_error` self-diagnosis entry. The model sees clipped output (4 KB/2 KB) and is told never to present a guess as computed. Files ride on the reply (≤10 per turn, each ≤10 MB, ≤25 MB in all).
  - A long run keeps its turn (and the channel's queue) busy; the typing indicator keeps going, and the gate counts a routed turn as open for 20 minutes.
- **Compose hardening**: read-only root, `/tmp` tmpfs, the named volume `sandbox-workspace`, `cap_drop: [ALL]`, `no-new-privileges`, 2 GB (`mem_limit` = `memswap_limit`: no swap) / 1 CPU / 256 pids, no published ports. Only the bot reaches it at `http://sandbox:8080`. **Egress is open** by design (pip, curl); on a bridge network that also reaches the Docker host and cloud metadata. The compose comment gives the two options (an internal network, or a host firewall). The link reader's SSRF guard keeps the *bot's* fetches away from the sandbox.
- **Tests**: `sandbox.test.ts` (fake fetch, plus the `node:http` transport against a local server); `sandboxServer.test.ts` drives the real `server.py` with python3 and bash (skipped where missing); `sandbox/ci-smoke.sh <image>` runs a built image with the compose hardening. Runs over 5 minutes aren't in the suite: the transport was proven once with a 330 s run against the real sidecar.

### Context-menu commands (`src/commands/`, events `commandsRegister`, `interactionCreate`)

Right-click (long-press on mobile) → **Apps**:

| Command | Target | Output |
|---|---|---|
| Ask Fridge | message | private "on it"; the agent answers the target in-channel as if pinged on it (in the background) |
| Summarize from here | message | public reply: summary from that message to now (≤7 days; says so when capped), written for the group |
| Transcribe | message | public reply: voice/audio transcript (cache first) + video descriptions; over-budget/too-long/too-large get the media note |
| Translate | message | private English translation of text + transcript + embed text (one ZDR call, `ALREADY_ENGLISH` short-circuit) |
| Remember this | message | one ≤80-char `fact` under the learner's 30-day rule (subject = current display name, `subject_user_id`, source `command`) |
| What does Fridge know? | user | private list of the newest 25 memories (id, category, age), matched through `memoryKeyFor` |

- **Registration**: on ClientReady, `guild.commands.set([...])` per guild, a bulk overwrite: idempotent, instant, and it replaces ALL of the app's commands in the guild, so every command must be listed in `COMMANDS`. `COMMANDS_ENABLED=false` registers an empty set. A Missing Access error logs the `applications.commands` authorization link.
- **Responses**: every interaction response is **ephemeral**. Public output is posted as a normal reply to the target (with `parse: []`): Discord locks visibility at `deferReply()`, so a public deferral could never end in a private error. Posting needs Send Messages + Read Message History there; a refusal becomes a private "not allowed to post in here".
- **Errors**: one boundary in `handleContextMenuCommand()`. A `CommandError` becomes a private in-character line and an INFO log; anything else a private "that broke" and a WARN. It never rejects.
- **Repeat clicks**: turned away privately, per target for public-output commands and per invoker+target for private ones. Ask Fridge holds its target until the answer is done.
- Handlers take their collaborators through `CommandDeps`. Tests use `fakeInteraction.ts`, which enforces discord.js's reply state machine.

### Feature requests → GitHub (`src/ai/tools/featureRequest.ts`, `src/github/`, `.github/workflows/claude-feature-request.yml`)

Flow: a member asks → `request_feature` files an issue, or backs or links an existing one → the owner approves with the `claude-implement` label (or an `@claude` comment) → the workflow has Claude implement it and open a PR → the owner merges → `docker-push.yml` deploys → "🚀 Deployed" appears.
- **Tool** `request_feature({title, description, why?, acceptance_criteria?, decision?, issue_number?, extra_details?})`: offered only with `GITHUB_TOKEN` + a well-formed `GITHUB_REPO`, and only for explicit requests. The issue is **public** whatever the repo's visibility: the request rewritten as a spec, opening with `🤖 Filed by Frigidaire for **<Name>** · [the request on Discord](<jump link>)`, never transcripts or other members.
- **Matching** (`issueMatching.ts`): GitHub issue search (`search_type=hybrid`) and the open-issue list are merged.
  - **Candidates**: only issues labelled `feature-request`, or authored by an OWNER/MEMBER/COLLABORATOR (on a public repo anything else is a stranger's text), that are open or closed within `FEATURE_REQUEST_CLOSED_LOOKBACK_DAYS`, excluding ones closed as duplicate.
  - A near-identical title (Jaccard ≥0.75) is decided automatically.
  - Otherwise up to 3 plausible candidates go back to the model, which calls again with `decision`: `duplicate_of` (adds a +1), `related_to` (files with `Related: #N`) or `new`. A decision is only trusted after this member was shown the candidates for this request (30 min, keyed by main id + repo + title).
  - Closed as completed → "that was added in #N"; not planned → "the owner passed on that in #N". It files only if the member insists. Owner tip: pick close reasons on purpose.
- **+1 comments**: the member's details under the "Filed by" line, one per member per issue (never their own, never a locked issue), capped by `FEATURE_REQUEST_MAX_COMMENTS_PER_DAY`. A comment that timed out stays counted.
  - **Every `@` becomes `＠`**, even in code spans, URLs and HTML entities. The bot's comments *are* owner comments to the workflow, whose trigger is a case-insensitive `contains(body, '@claude')`. `claudeWorkflow.test.ts` pins this.
- **Service** (`featureRequests.ts`): optional allowlist `FEATURE_REQUEST_USER_IDS` (side accounts count); filing capped per main id per rolling 24 h (`FEATURE_REQUEST_MAX_PER_DAY`), with the slot reserved synchronously before the create. Labels `feature-request`, `from-discord` and `claude-implement` are created best-effort (the last only so it's in the picker); issues carry the first two, never `claude-implement`. One retry without labels on a 422.
- **Client** (`client.ts`): plain `fetch`, API version `2026-03-10`, 10 s timeout, errors sorted into kinds. Failures the owner must fix (auth, forbidden, not found, disabled, validation) become self-diagnosis entries; transient ones ask the member to retry.
- **Workflow**: `anthropics/claude-code-action@v1` in tag mode (`track_progress`).
  - Job guard: `github.actor == github.repository_owner` AND (the label, or an `@claude` comment).
  - Only the owner's and `claude[bot]`'s comments reach Claude; the bot's "Filed by" comments are marked untrusted in the prompt.
  - `permissions: {}` by default; per-issue concurrency; 60 min timeout.
  - Beyond its git/file tools Claude may only run `docker build --target ci .`, `gh pr create`, WebSearch and WebFetch. The prompt has it write its own PR title and pass the body through a quoted heredoc.
  - Auth: `CLAUDE_CODE_OAUTH_TOKEN` (owner's subscription); `ANTHROPIC_API_KEY` is the commented-out alternative. Wire only one: Claude Code prefers the API key.
  - `.dockerignore` keeps this one workflow in the build context so its guard test runs in the CI gate.

### Report channel and ops

Everything here is off unless `REPORT_CHANNEL_ID` is set. `sendToReportChannel()` posts with `parse: []` and returns whether it posted, and callers only record success when it did.
- **Digest** (`reportDigest`, `digest.ts`): self-diagnosis signals and failures plus a **Spend** section (total, by feature, top models; complete Eastern days since the last digest, so no day counts twice). It is "weekly … this week" only for a 6–8 day period; otherwise "since the last digest" with the real span. The watermark only advances when the post landed.
- **Deploy ping** (`deployAnnounce`): `🚀 Deployed <sha> · <ET time>` the first time the bot boots on a new `GIT_SHA`, followed by the channel configuration in a code block. An undelivered ping is retried on the next boot.
- Fixer alerts, auto-react shadow lines and `!wrapped` previews also land here.
- **`query_costs({period: today|week|month})`**: rolling whole Eastern days from the ledger.
- **Log file** (`logFile.ts`): every logger line is also appended to `LOG_FILE` (`./data/logs/bot.log`, 5 MB × 3), because watchtower recreates the container on each update and that wipes `docker logs`. Writes are synchronous, each start writes a marker line, it's off under Vitest, and a filesystem error pauses it for 60 s instead of throwing. It holds the same text as the console (memory contents included): treat it like the rest of `./data`.
- **Error capture & replay**: when a turn throws, `debugCapture.ts` writes the conversation + raw error to `data/debug/error-<timestamp>-<rand>.json` (newest 50 kept; `DEBUG_CAPTURE=false` disables, `DEBUG_CAPTURE_DIR` relocates). `yarn replay <file>` reproduces it offline. Captures hold full private chats; the digest reads only their timestamp/status/message.

## Long-term memory & learning

- `MemoryStore` (`./data/memory.db`): memories (+ FTS5 index + embedding vectors), member identities, emoji rows (name/caption/use count), learner state, generic `bot_state` key/values. The prompt builder injects capped, relevance-ranked memories each turn.
- **Memory tools**:
  - `recall_memories`: resolves a subject (or a query that is a person's name) through `getForPerson`, plus keyword and category search; every line prefixed `[id:N]`.
  - `remember_fact`: files person memories under the member's current display name with `subject_user_id`. The category whitelist is `fact`/`preference`/`personality`/`event`/`vibe`, so the model can't write `image` or self-diagnosis rows.
  - `forget_memory`: "no active memory" for unknown or already-forgotten ids.
  - `query_self_diagnosis`: limit clamped 1..50.
  - `set_member_info({person, real_name?, add_nickname?})`: refuses markup, links, over-48-char names, and a nickname that is another member's display name, handle or first-seen name; notes (allows) one shared with someone's IRL name or nickname. It logs an audit line on every change.
- `PersonalityLearner` runs every `LEARNING_INTERVAL_MS` over channels with ≥ `MIN_MESSAGES_FOR_OBSERVATION` new messages, with `LEARNER_MODEL`, plus an optional self-improvement pass.
  - Messages go through `attributeMessage()`: relays count as their author; other bots and the bot's own replies are dropped. Cached voice transcripts ride along (the learner never pays for transcription). At most 8 images per request; a re-entrancy guard skips a tick while a cycle runs.
  - Model output is untrusted: fields are type-checked, and a malformed entry is skipped, never allowed to stall the watermark.
  - `identity_updates` only *fill* a missing IRL name, and a real name or alias another member already uses is dropped (no human confirmed it). Changing a real name stays with `set_member_info`.
  - A `subject_user_id` is used only when it belongs to a member.
- Emojis are reconciled at startup and captioned by `EMOJI_CAPTION_MODEL`; meanings are then re-grounded from usage (see above).

**Learner prompt rules** (why the prompts are rule-heavy: the originals filled prod with per-message transcription):
- **30-day test**: only knowledge still true and useful in 30 days is saved; "someone asked/confirmed/shared X" is transcription, never a memory.
- **Ephemeral categories**: time-bound observations MUST be `event` (TTL ~14 days), image/GIF shares MUST be `image` (TTL ~24 h). A durable fact revealed by an image is saved as `fact`.
- **No re-saves** of traits already in the injected existing-memories context; save-time dedup is the backstop.
- **Subject normalization**: subjects are the person's **current display name** (+ `subject_user_id` as the stable anchor), never nicknames, handles or stale names. Emoji style is described in words; emoji syntax never goes into a memory.
- **Self-improvement "asked" rule**: a `capability_gap` needs someone to have addressed the bot (mention, reply, its name) AND a failure or a "can't". Posts nobody pointed the bot at are never gaps. The bot's own replies aren't in the transcript, so a ping with no visible answer proves nothing.
- Observations stay verbatim: **no censoring or paraphrasing rule** (see Hard rules).

**Embeddings** (`embeddingProvider.ts`): `OpenRouterEmbeddingProvider` calls `/embeddings` (`EMBEDDING_MODEL`, default `qwen/qwen3-embedding-8b`) with `provider: { zdr: true }`, which is non-negotiable. Retrieval is asymmetric: queries get the qwen3 instruct prefix, documents are embedded bare. Vectors are L2-normalized, so cosine is a dot product. `makeDefaultEmbeddingProvider()` returns `undefined` (FTS5-only mode) without a key, with `SEMANTIC_MEMORY_ENABLED=false`, or inside Vitest.

**Hybrid search** (`MemoryStore.search()`):
1. Keyword leg in two tiers: rows matching **every** query term (implicit AND), then rows matching **any** non-stop-word term (OR, BM25-ranked). The second tier is what keeps keyword search useful for message-length queries; before it existed the keyword leg matched nothing for real messages.
2. Vector leg: cosine over the in-memory vector cache.
3. Reciprocal-rank fusion (k=60; vector 1.0, exact keyword 0.5, partial keyword 0.25).
4. **Semantic gate**: every result needs cosine ≥ `MEMORY_RELEVANCE_THRESHOLD` (default 0.5); keyword hits on un-embedded memories are dropped.
5. Ungated keyword fallback (both tiers) when there is no embedder, the query embed fails, or fewer than 80% of searchable memories have current-model vectors (logged at WARN).
- Self-diagnosis categories (`SELF_DIAGNOSIS_CATEGORIES`) are excluded from search; `query_self_diagnosis` is their only path.

**Save** (`save()`): phase 1 is synchronous: word-overlap dedup + INSERT/UPDATE + FTS sync in one transaction (durable before the first `await`). Phase 2 is best-effort: embed, cosine dedup (≥ `MEMORY_DEDUP_THRESHOLD`, same category + person; a duplicate merges into the **existing** id), store the vector. Rows with different member ids never merge. Failures never lose the row; backfill heals it.

**Deactivate / FTS integrity**: `deactivate(id)` returns `false` and does nothing for unknown or already-inactive rows. This guard matters: the external-content FTS5 index only holds active rows, and a repeated `'delete'` command corrupts it ("database disk image is malformed" on the next MATCH). `compact()` also rebuilds the FTS index from the active rows at every startup (`rebuildFtsIndex()`, milliseconds at prod scale), so the index is correct by construction.

**Startup maintenance** (`startupMaintenance.ts`): the subject-id stamp, **then** `compact()`, so rows the stamp links dedup on the same start; each step survives the other's failure.
- The stamp first moves rows keyed on a side account's id to the main id.
- Then name-only rows get the main id when exactly one person goes by that name in any form, on any account. That is stricter than interactive lookups, because an old row may carry a name that belongs to someone else today.
- An id no identity or link knows is treated as missing only when it isn't snowflake-shaped or sits on a learner-written row. Ids stored by `remember_fact` or "Remember this" are never taken away.
- It never touches `updated_at` (the TTL clock). Logged as `Subject-id stamp: linked N memories …`.

**Compaction** (`compact()`): rebuild FTS index → TTL sweep → orphan-vector sweep → dedup within (`subject_user_id ?? subject`, category) groups (cosine when both sides have vectors, word overlap otherwise; a row deactivated in a pass is never compared again) → `PRAGMA optimize`.

**Backfill** (`backfillEmbeddings()`): idempotent, batched (32/request); embeds every active memory lacking a current-model vector. Runs at startup and every `BACKFILL_INTERVAL_MS`; expand-contract on `EMBEDDING_MODEL` switches.

**Ephemeral TTL** (`sweepExpiredMemories()`): `image` after `MEMORY_TTL_IMAGE_HOURS`, `event` after `MEMORY_TTL_EVENT_DAYS`, measured on `updated_at` with a strict `<`. It also runs before each periodic backfill. `0` disables a category's expiry.

**Model-switch runbook** (`EMBEDDING_MODEL`):
1. Run the live calibration test (`RUN_LIVE=1 EMBEDDING_MODEL=<new> … yarn test:live`, grep `CALIBRATION`) to confirm ZDR endpoints and sane thresholds.
2. Set the variable and restart. Search falls back to keyword mode while coverage is under 80%.
3. The startup backfill re-embeds everything (~60 calls at 2k memories).
4. Adjust thresholds if the cosine distribution moved.

Rollback is reverting the variable.

**Kill switch**: `SEMANTIC_MEMORY_ENABLED=false` ⇒ keyword-only retrieval instantly, vectors kept.

### Storage schema

**memory.db**

| Table | Contents |
|---|---|
| `memories` | id, category, subject, content, source, timestamps, active flag, subject_user_id (main account id) |
| `memories_fts` | FTS5 external-content index over memories (content/subject/category); active rows only |
| `memory_embeddings` | memory_id (FK, cascade), model, dims, input_text, vector BLOB (L2-normalized LE Float32, `CHECK(length = dims*4)`), `UNIQUE(memory_id, model)` |
| `identities` | discord_user_id, display_name, canonical_name (first seen), username (handle), irl_name, aliases JSON, active |
| `emojis` / `learner_state` / `bot_state` | emoji name/caption/use count, learner watermarks, key/values (digest watermark, last announced sha) |

**conversations.db**: `conversation_state(channel_id, schema_version, state_json, updated_at)`. Rows with an old `CONVERSATION_STATE_SCHEMA_VERSION` (now 3) are discarded on load; a v1 table is dropped and recreated.

**bot.db** (each table created by its feature on first use; columns added later go through `ensureColumn`)

| Table | Feature |
|---|---|
| `relayed_messages` | the relay registry: message_id, channel, real author id/name, kind (`link_fix`/`regret`), original_id |
| `usage_ledger` | (Eastern day, feature, model) → requests, tokens, cost_usd, unpriced_requests |
| `reminders` | reminders with status/attempts/claim columns, `source_private` |
| `birthdays`, `birthday_seed_applied` | birthdays with `last_announced_year`; users the seed was applied to |
| `transcripts`, `video_descriptions`, `video_answers`, `transcript_replies` | media caches; the bot's transcript reply ids (90 days) |
| `ramble_nudges` | per-member nudge cooldown (main id) |
| `auto_reactions` | auto-react budget/ledger (shadow rows included) |
| `emoji_usage_captions`, `reaction_jobs` | usage-grounded caption state; job watermarks |
| `link_fix_alerts` | announced fixer outage state per platform |
| `feature_requests`, `feature_request_comments` | filing and +1 caps and outcomes |
| `wrapped_posts` | the Wrapped watermark (`year:YYYY`) |

**archive.db**: `messages` (TEXT snowflake ids + `seq` key, channel/parent, main-id author, source `human|relay|bot`, relay_kind, content, extra_text, transcript, created/edited/deleted times, `deleted_kind`, edit_count, reply_to_id, flags, attachments/embeds/reactions JSON), `messages_fts` (+ three triggers), `channels` (names, thread parents), `backfill_state` (per-channel import cursor), `gap_fill_state` (in-progress gap fills). Expect a few hundred bytes per message.

## Commands

The dev/test toolchain runs entirely in Docker; the host does **not** need Node or Yarn.

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
docker build -t frigidaire-sandbox:ci sandbox && sh sandbox/ci-smoke.sh frigidaire-sandbox:ci   # sidecar image + hardened smoke test

# Live tests (paid, cents; each file is skipped without RUN_LIVE=1 + its key). Grep the output for:
#   CALIBRATION (embeddings ZDR canary, ramble judge), FALLBACK (fallback chain), MEDIA_LIVE (stt-zdr allZdr=true is
#   the Whisper privacy canary), WRAPPED_INTRO, LIVE-AUTOREACT, LIVE (link reader, free), GITHUB_* (read-only)
docker compose run --rm -e RUN_LIVE=1 -e OPENROUTER_API_KEY=sk-... test yarn test:live
docker compose run --rm -e RUN_LIVE=1 -e GITHUB_TOKEN=github_pat_... -e GITHUB_REPO=owner/name test yarn test:live

# Evals (paid; RUN_LIVE=1 + key)
docker compose run --rm -e RUN_LIVE=1 -e OPENROUTER_API_KEY=sk-... test yarn eval:gate [extra-cases.json …]
docker compose run --rm -e RUN_LIVE=1 -e OPENROUTER_API_KEY=sk-... -e EVAL_MODELS=a,b test yarn eval:persona

# Update yarn.lock after editing package.json
docker compose run --rm test yarn install --mode=update-lockfile   # then rebuild the test image
```

- `yarn eval:persona` runs 18 fictional scenarios through the real `AgentOrchestrator` (in-memory stores, fake Discord, no `request_feature`/`run_code`), has `EVAL_JUDGE_MODEL` score six rubric dimensions, adds deterministic metrics and hard checks, and writes JSON under `EVAL_OUTPUT_DIR`. Scenario ids and cast are placeholders; never use a real member's name, even with made-up facts.
- Running the bot via Compose: `docker compose up -d frigidaire-bot` reads `.env` (optional), mounts `./data` and starts the `sandbox` sidecar too (`depends_on`; `SANDBOX_URL` defaults to `http://sandbox:8080`, and setting it empty turns `run_code` off). Production is a Portainer stack pulling both DockerHub images with the same variables.

**After any change, run `yarn check`, `yarn typecheck` and `yarn test` via `docker compose` before handoff.**

## Environment variables

Parsed in `src/config.ts` (booleans accept `1/0`, `true/false`, `yes/no`, `on/off`; an out-of-range number falls back to the default). Durations are in the unit the name says. "main" = `MAIN_CHANNEL_ID`.

**Required (prod)**

| Variable | Meaning |
|---|---|
| `CLIENT_SECRET` | Discord bot token (missing ⇒ exit 1) |
| `OPENROUTER_API_KEY` | every AI feature; also enables embeddings |

**Server layout**

| Variable | Default | Meaning |
|---|---|---|
| `MAIN_CHANNEL_ID` | unset | the channel the group talks in: default for the gate, ramble watch, auto-react, birthdays, archive backfill, reminder fallback |
| `LINKED_ACCOUNTS` | empty | csv of `sideId:mainId` (`;`/newlines also separate); a side account counts as its main everywhere |

**OpenRouter and models**

| Variable | Default | Meaning |
|---|---|---|
| `OPENROUTER_TIMEOUT_MS` | 120000 | per-attempt timeout of every SDK call (1000..1800000) |
| `OPENROUTER_MAX_RETRIES` | 2 | SDK retries on connection errors, timeouts, 408/409/429, 5xx (0..10) |
| `CHAT_MODEL` | `z-ai/glm-5.3-flash` | chat, summaries, commands, the ramble and auto-react judges, the message-judge fallback, birthday/Wrapped text; must read images |
| `CHAT_FALLBACK_MODELS` | empty | csv of chat models OpenRouter falls back to, in order |
| `IMAGE_MODEL` | `google/gemini-3.1-flash-image` | `generate_image` (only ZDR host: Vertex) |
| `EMOJI_CAPTION_MODEL` | `anthropic/claude-opus-4.7` | emoji captions (one-shot per emoji) and usage re-grounding |
| `LEARNER_MODEL` | `z-ai/glm-5.3-flash` | personality learner |
| `SELF_IMPROVEMENT_MODEL` | = `LEARNER_MODEL` | self-improvement pass |
| `EMBEDDING_MODEL` | `qwen/qwen3-embedding-8b` | memory vectors; must have ZDR endpoints |
| `DELETE_REPOST_MODEL` | `typesafe/jev-1.13` | deleted-message judge: a decision model, or any chat model id |

**Chat / agent**

| Variable | Default | Meaning |
|---|---|---|
| `CONVERSATION_TIMEOUT_MS` | 900000 (15 min) | a channel's window lifetime |
| `MAX_TOOL_ROUNDS` | 25 | runaway backstop, then a text-only answer is forced |
| `MAX_TOOL_INVOCATIONS` | 200 | host tool calls per turn, same backstop |
| `CHAT_CONTEXT_TOKENS` | 131072 | context window when the model catalog can't tell |
| `HISTORY_TOKEN_BUDGET` | unset | override the window budget (≥1000); unset ⇒ min(500k, ½ context) |
| `CHANNEL_NOTES` | unset | JSON `{"<channel id>": "short description"}` shown each turn; invalid ⇒ off + one WARN |

**Gate (replying without a mention)**

| Variable | Default | Meaning |
|---|---|---|
| `GATE_ENABLED` | true | kill switch |
| `GATE_CHANNELS` | main | csv; empty (and no main) ⇒ gate off |
| `GATE_NAMES` | `fridge,frigidaire,frigi,bot,clanker` | whole-word names that make a candidate (+ the bot's own names) |
| `GATE_FOLLOWUP_SECONDS` | 120 | active-exchange window after an answer (sliding); 0 ⇒ every name-drop is cold |
| `GATE_MAX_PER_10MIN` | 30 | runaway guard, unprompted replies per channel (0 ⇒ never) |
| `GATE_MAX_COLD_PER_10MIN` | 3 | name-drops outside an exchange, per channel |
| `GATE_THRESHOLD` | 0.7 | decision probability needed; tune with `yarn eval:gate` |
| `GATE_MODEL` | `typesafe/jev-1.13` | decision models only (`~?typesafe/…`); anything else ⇒ default |

**Ramble redirect**

| Variable | Default | Meaning |
|---|---|---|
| `RAMBLE_USER_IDS` | empty | csv of members whose rambles get nudged; empty ⇒ off |
| `RAMBLE_CHANNEL_ID` | unset | where rambles belong, and the archive's labelled examples; unset ⇒ off |
| `RAMBLE_WATCH_CHANNELS` | main | csv; the ramble channel is never watched |
| `RAMBLE_MIN_MESSAGES` | 3 | messages in a row (nobody in between) that trigger a judgement |
| `RAMBLE_LONG_MESSAGE_CHARS` | 600 | one message with this much prose is judged alone |
| `RAMBLE_WINDOW_SECONDS` | 300 | window for the run |
| `RAMBLE_COOLDOWN_MINUTES` | 120 | per member, persisted |
| `RAMBLE_THRESHOLD` | 0.75 | judge confidence needed to nudge |

**Auto-react**

| Variable | Default | Meaning |
|---|---|---|
| `AUTO_REACT_MODE` | `shadow` | `off` \| `shadow` (report-channel lines only) \| `on` |
| `AUTO_REACT_CHANNELS` | main | csv; threads match through their parent |
| `AUTO_REACT_MAX_PER_DAY` | 3 | rolling 24 h, shadow ones included (0..100) |
| `AUTO_REACT_MIN_GAP_MINUTES` | 45 | minimum time between two reactions |
| `AUTO_REACT_MIN_PROFILE_MESSAGES` | 200 | learn first: reacted member posts the archive must hold |
| `AUTO_REACT_DELAY_SECONDS` | 10 | wait before judging (1..300) |

**Learner and emojis**

| Variable | Default | Meaning |
|---|---|---|
| `LEARNING_INTERVAL_MS` | 1800000 (30 min) | learner cycle |
| `MIN_MESSAGES_FOR_OBSERVATION` | 5 | new messages a channel needs per cycle |
| `LEARNER_IGNORE_CHANNELS` | empty | csv of channels the learner skips |
| `SELF_IMPROVEMENT_ENABLED` | true | the self-improvement pass |
| `EMOJI_FORCE_RECAPTION` | false | ONE-SHOT: clears every caption at startup; unset it again |
| `EMOJI_USAGE_CAPTIONS_ENABLED` | true | the usage-grounded caption job |
| `EMOJI_RECAPTION_FROM_USAGE` | false | ONE-SHOT: re-ground every eligible caption at startup; unset it again |

**Memory**

| Variable | Default | Meaning |
|---|---|---|
| `SEMANTIC_MEMORY_ENABLED` | true | false ⇒ keyword-only retrieval, no embeddings calls |
| `MEMORY_RELEVANCE_THRESHOLD` | 0.5 | search gate (cosine) |
| `MEMORY_DEDUP_THRESHOLD` | 0.9 | save/compact merge (cosine) |
| `EMBEDDING_QUERY_INSTRUCTION` | qwen3 instruction | override the query prefix |
| `BACKFILL_INTERVAL_MS` | 1800000 (30 min) | embedding backfill + TTL sweep |
| `MEMORY_TTL_IMAGE_HOURS` | 24 | 0 disables |
| `MEMORY_TTL_EVENT_DAYS` | 14 | 0 disables |

**Media**

| Variable | Default | Meaning |
|---|---|---|
| `TRANSCRIPTION_MODEL` | `openai/whisper-large-v3` | STT model (used only while every host is ZDR) or an audio-input chat model |
| `TRANSCRIPTION_FALLBACK_MODEL` | `google/gemini-3.5-flash-lite` | chat model used when the STT route can't be verified ZDR |
| `VIDEO_MODEL` | `google/gemini-3.5-flash-lite` | watches videos (video-input models get the whole clip) |
| `VIDEO_DAILY_BUDGET_USD` | 0.5 | per Eastern day, from the ledger's `video` rows; 0 = unlimited |
| `VOICE_AUTO_TRANSCRIBE` | true | transcript replies to voice messages |
| `VOICE_TRANSCRIBE_CHANNELS` | empty = all | csv; threads match through their parent |
| `VOICE_MAX_SECONDS` | 600 | longer recordings aren't transcribed; also where a soundtrack is cut |
| `VIDEO_MAX_BYTES` | 14680064 (14 MB) | biggest clip sent whole (Gemini's 20 MB inline cap − base64) |
| `VIDEO_MAX_SECONDS` | 300 | longest clip sent whole; longer ⇒ keyframes |
| `VIDEO_INPUT_MODE` | `auto` | `auto` \| `native` \| `frames` |

**Link reader**

| Variable | Default | Meaning |
|---|---|---|
| `LINK_READER_ENABLED` | true | false ⇒ no `read_link`, no previews |
| `LINK_PREVIEWS_ENABLED` | true | automatic `[link: …]` previews |
| `LINK_READER_TIMEOUT_MS` | 8000 | per request, DNS + redirects + body (500..60000) |
| `LINK_READER_MAX_BYTES` | 2097152 | page body cap after decompression (64 KB..16 MB) |
| `LINK_READER_WATCH_VIDEOS` | true | `read_link` watches a post's video (long ones skimmed) |

**Link fixing**

| Variable | Default | Meaning |
|---|---|---|
| `TWITTER_FIXERS` | `fixvx.com,fxtwitter.com,vxtwitter.com` | ordered fixer domains |
| `INSTAGRAM_FIXERS` | `instagram7.com,uuinstagram.com,kkinstagram.com` | ordered fixer domains |
| `TIKTOK_FIXERS` | `tnktok.com,fixtiktok.com,tfxktok.com` | ordered fixer domains |
| `REDDIT_FIXERS` | `vxreddit.com,rxddit.com` | ordered fixer domains |
| `BLUESKY_FIXERS` | `fxbsky.app,bskx.app,xbsky.app` | ordered fixer domains |
| `LINK_FIX_VERIFY` | true | false ⇒ rewrite to the first domain without probing |
| `LINK_FIX_TIMEOUT_MS` | 4000 | per probe |
| `LINK_REPOST_MAX_ATTACHMENT_BYTES` | 10485760 | attachments a repost may carry over; 0 ⇒ attachment-free messages only |
| `TWITTER_TRANSLATE_TO` | `en` | foreign-tweet translation target; blank/`off` ⇒ no translation |
| `LINK_FIX_ALERTS` | true | report-channel outage/recovery posts |
| `LINK_FIX_ALERT_MIN_INTERVAL_MS` | 21600000 (6 h) | per-platform minimum between down alerts |

**Deleted-message repost**

| Variable | Default | Meaning |
|---|---|---|
| `DELETE_REPOST_USER_IDS` | empty | csv of watched members (a linked account counts); empty ⇒ off |
| `DELETE_REPOST_WINDOW_MS` | 120000 (2 min) | a deletion qualifies within this long after posting |
| `DELETE_REPOST_MODE` | `edgy` | `edgy` (judge) \| `always` |

**Archive and Wrapped**

| Variable | Default | Meaning |
|---|---|---|
| `ARCHIVE_ENABLED` | true | master switch: ingest, backfill, search tools, Wrapped |
| `ARCHIVE_IGNORE_CHANNELS` | empty | csv never archived, searched or counted (a parent covers its threads) |
| `ARCHIVE_BACKFILL_ENABLED` | true | false ⇒ no history import, no gap fill (live ingest continues) |
| `ARCHIVE_BACKFILL_CHANNELS` | main | csv of channels whose full history is imported |
| `ARCHIVE_BACKFILL_DELAY_MS` | 1100 | pause between history requests (0..60000) |
| `WRAPPED_ENABLED` | true | the yearly post (the `!wrapped` preview works regardless) |
| `WRAPPED_CHANNEL_ID` | `REPORT_CHANNEL_ID` | where Wrapped goes; both unset ⇒ off |
| `WRAPPED_LLM_INTRO` | true | one roast-y intro line from `CHAT_MODEL` |

**Reminders and birthdays**

| Variable | Default | Meaning |
|---|---|---|
| `REMINDERS_MAX_PER_USER` | 25 | pending reminders per requester (1..1000) |
| `BIRTHDAY_CHANNEL_ID` | main | announcements; both unset ⇒ off (tools still work) |
| `BIRTHDAY_ANNOUNCE_ENABLED` | true | kill switch for the announcement only |
| `BIRTHDAY_ANNOUNCE_HOUR` | 15 | Eastern hour (0..23) from which today's birthdays are announced |
| `BIRTHDAYS_SEED` | empty | csv `userId:MM-DD` / `userId:YYYY-MM-DD`, applied once per user |

**Code sandbox** (bot side)

| Variable | Default | Meaning |
|---|---|---|
| `SANDBOX_URL` | unset (compose: `http://sandbox:8080`) | sidecar base URL; unset/empty ⇒ `run_code` not offered |
| `SANDBOX_TOKEN` | unset | optional bearer token; the SAME value on the bot and the sidecar |
| `SANDBOX_TIMEOUT_SECONDS` | 900 | run limit (1..900); the model's `timeout_seconds` can only shorten it |

Sidecar-only (the `sandbox` service's own environment, read by `server.py`): `SANDBOX_TOKEN`, `SANDBOX_HOST`/`SANDBOX_PORT` (0.0.0.0:8080), `SANDBOX_WORKSPACE` (/workspace), `SANDBOX_MAX_TIMEOUT_SECONDS` (900), `SANDBOX_MEMORY_MB` (1792, RLIMIT_DATA), `SANDBOX_FILE_SIZE_MB` (0 = no per-file cap), `SANDBOX_WORKSPACE_MAX_MB` (20480; keep that much free on the host), `SANDBOX_WORKSPACE_MAX_FILES` (200000), `SANDBOX_MAX_PROCESSES` (128), `SANDBOX_QUEUE_SIZE` (3), `SANDBOX_QUEUE_WAIT_SECONDS` (30).

**Feature requests**

| Variable | Default | Meaning |
|---|---|---|
| `GITHUB_TOKEN` | unset | fine-grained PAT, this repo only, Issues: read/write; never logged |
| `GITHUB_REPO` | unset | `owner/name`; anything else counts as unset. Both needed for `request_feature` |
| `FEATURE_REQUEST_MAX_PER_DAY` | 3 | new issues per member, rolling 24 h |
| `FEATURE_REQUEST_MAX_COMMENTS_PER_DAY` | 10 | +1 comments per member, rolling 24 h (separate cap) |
| `FEATURE_REQUEST_CLOSED_LOOKBACK_DAYS` | 90 | closed issues this recent count as done/declined; 0 ⇒ open only |
| `FEATURE_REQUEST_USER_IDS` | empty = everyone | csv allowlist |

**Commands**

| Variable | Default | Meaning |
|---|---|---|
| `COMMANDS_ENABLED` | true | false ⇒ an empty command set is registered (entries disappear), interactions refused |

**Report channel, costs, logs**

| Variable | Default | Meaning |
|---|---|---|
| `REPORT_CHANNEL_ID` | unset | master switch: digest, deploy ping, fixer alerts, shadow lines, `!wrapped`, default Wrapped channel |
| `DIGEST_ENABLED` | true | the self-diagnosis digest |
| `DIGEST_PERIOD_MS` | 604800000 (7 days) | digest period |
| `DIGEST_CHECK_INTERVAL_MS` | 3600000 (1 h) | how often the digest watermark is checked |
| `DEPLOY_ANNOUNCE_ENABLED` | true | the deploy ping |
| `GIT_SHA` | baked in by CI | unset ⇒ no deploy ping |
| `USAGE_LEDGER_ENABLED` | true | per-feature cost tracking (the video budget needs it) |
| `DEBUG_CAPTURE` | true | error captures |
| `DEBUG_CAPTURE_DIR` | `./data/debug` | where they go |
| `LOG_DEBUG` | false | noisy diagnostics (per-search cosine distributions etc.) |
| `LOG_FILE` | `./data/logs/bot.log` | rotated file log; `off` ⇒ console only |
| `LOG_FILE_MAX_BYTES` | 5242880 | rotate size (64 KB..1 GB) |
| `LOG_FILE_MAX_FILES` | 3 | files kept, current included (1..20) |

**Tests and evals** (never read by the running bot)

| Variable | Default | Meaning |
|---|---|---|
| `RUN_LIVE` | unset | `1` enables `*.live.test.ts` and the evals (with their keys) |
| `EVAL_MODELS` | `CHAT_MODEL` | persona eval: csv of candidate models |
| `EVAL_JUDGE_MODEL` | `google/gemini-3.1-pro-preview` | persona eval judge (ZDR, unmoderated endpoints) |
| `EVAL_SCENARIOS` | all | csv of scenario ids |
| `EVAL_OUTPUT_DIR` | `./data/evals` | JSON results (gitignored) |
| `LIVE_VIDEO_MODELS` | `google/gemini-3.5-flash-lite,z-ai/glm-5.3-flash` | media live test: which models to probe for ZDR video input |

## Testing

- Vitest 5; tests colocated as `src/**/*.test.ts`. Convention: code at the **OpenRouter, Discord or GitHub boundary ships with fixture/fake-based tests**.
- **Hermeticity**: tests never touch `./data` or the network.
  - Every default store (memory, conversations, bot.db, archive) is `:memory:` under Vitest; `makeDefaultEmbeddingProvider()` returns `undefined`; the media and link-reader singletons can't reach the network; the log file is off.
  - Tests needing memory inject `new MemoryStore(':memory:', { embeddings: new FakeEmbeddingProvider() })` via `setMemoryStoreForTesting()`.
  - Anything that can write an error capture stubs `DEBUG_CAPTURE_DIR` (or sets `DEBUG_CAPTURE=0`).
  - Clocks are injected, or faked with `vi.useFakeTimers({ toFake: ['Date'] })`.
- **Guard tests** worth knowing: `openRouterCallSites.test.ts` (tags, ZDR, reasoning under a small cap, no unused `UsageFeature`), `config.test.ts` (a startup-summary token per config section, no secrets in it, no `process.env` read outside `config.ts`), `eventModule.test.ts` (every event file), `claudeWorkflow.test.ts` (the owner-only guard, the auth default, no `@` in bot comments), `dockerPushPaths.test.ts` (push triggers cover every build input), `scenarioFile.test.ts` / `cases.test.ts` (placeholder ids, no links), `loadEnv.test.ts` (dotenv first).
- `src/test-support/`:
  - `fakeProvider.ts`: scripted `AiProvider` (`textResponse()`, `toolCallResponse()`, `errorStep()`), records every `chat()` input.
  - `fakeDiscord.ts`: `createFakeMessage()` (typed as the exact `MessageCreate` argument). Its options cover channel types incl. threads and parents, attachments with size/duration, embeds incl. `proxyURL`, mentions, `replyPinged`, `cachedMessages`, a channel message log with Discord's before/after/around fetch rules, reference details, flags, polls, webhook recorders and send failures. Also `createFakeChannel()`, `createFakeClient()` (a ready `Client<true>`), `createFakeBotMessage()`, `sentContent()`.
  - `fakeEmbeddings.ts`: deterministic bag-of-words embeddings; `failWith` simulates outages.
  - `openRouterFetch.ts`: replay/record OpenAI-SDK clients backed by JSON fixtures (`loadFixture()`). `capturingClient.ts` is the capturing client: scripted replies (or fixtures through `fixtureReply()`), every request's body and headers (the feature tag) recorded.
  - `fakeMedia.ts`: scripted/missing ffmpeg, file fetches, `createFileSafeFetch()` (the real guarded fetch over an in-memory transport), `createFakeCatalog()` with ZDR endpoint coverage. Synthetic samples live in `fixtures/media/`.
  - `fakeSafeFetch.ts` (link-reader routes, `htmlPage()`), `fakeArchive.ts` (archive rows, archivable messages, snowflakes), `fakeScheduling.ts` (postable channels, Discord error codes), `fakeInteraction.ts` (context-menu interactions that enforce the reply state machine; `createFakeCommandDeps()`), `fakeGitHub.ts` (in-memory GitHub endpoints with scripted failures).
  - `replayCli.ts` backs `yarn replay`; `recorder.ts` is the call-recorder util.
- Link fixers are tested with an injected `FixerDeps` (fake fetch + clock). The message judge takes a fake decisions fetch and a replay chat client. The deleted-message reposter, the auto-reactor, the gate, the scheduler and the command handlers take every dependency through their constructors or options.
- **Live tests** (`*.live.test.ts`, `yarn test:live`) are `describe.skipIf`-gated on `RUN_LIVE=1` plus their key; see [Commands](#commands) for the grep tags.

### Prod-error → regression-test workflow

1. Bot errors in prod → `data/debug/error-<timestamp>.json` is written automatically.
2. Copy the file off the server; `docker compose run --rm test yarn replay <file>` reproduces it (exit 1 = still reproduces).
3. Fix the code; sanitize the payload (fictional names, placeholder ids) into `src/test-support/fixtures/openrouter/` and add a regression test that loads it via `loadFixture()` / a replay client.

## Continuous integration

Both image workflows build the `ci` Docker stage (GHA layer cache), which runs `check:ci`, `typecheck`, `build` and `test` at image-build time, so a green build is the full gate. The test image has python3 and bash so `sandboxServer.test.ts` runs there.
- **`docker-build.yml`** (pull requests):
  - the gate, then Gitleaks and Semgrep (`.semgrep/`, run as `docker run semgrep/semgrep semgrep scan --error`), then a prod image build;
  - a parallel `sandbox` job builds the sidecar and runs `sandbox/ci-smoke.sh` against it.
- **`docker-push.yml`** (push to `master` touching a build input; `dockerPushPaths.test.ts` keeps the path list complete):
  - the gate, then the `prod` image pushed to `${DOCKER_USERNAME}/frigidaire-bot` as `latest`, the date and `sha-<short>`, with `GIT_SHA` baked in;
  - the `sandbox` job pushes `${DOCKER_USERNAME}/frigidaire-sandbox` (`latest`, date, `sha-<short>`, `tree-<sandbox tree hash>`) only when that tree tag isn't published yet, or on a manual run. An unchanged sidecar is never re-pushed (a new digest would make watchtower restart it), and a cancelled or failed run can't skip a sandbox change for good.
- **`claude-feature-request.yml`**: see [Feature requests](#feature-requests--github-srcaitoolsfeaturerequestts-srcgithub-githubworkflowsclaude-feature-requestyml). It needs the `CLAUDE_CODE_OAUTH_TOKEN` secret and the Claude GitHub App.
- Actions: `checkout@v7`, `setup-buildx@v4`, `build-push@v7`, `login@v4`, `metadata@v6`, `gitleaks@v3`, `claude-code-action@v1`.

## Docker image

- **Bot**: stages `base` (deps; python3/make/g++ for node-gyp, bash for the sandbox tests) → `test` (full source) → `ci` (runs the gate) / `build` (tsc) / `prod-deps` (`yarn workspaces focus --all --production`: runtime deps only).
  - `prod` starts from a fresh `node:26-alpine` with `su-exec` and **ffmpeg** (~130 MB installed; without it the media features degrade instead of failing), copies `dist/` + production `node_modules`, and starts through `docker/entrypoint.sh`, which chowns `/app/data` and drops to the `node` user.
  - `.dockerignore` keeps the build context to the sources (no `.git`, `dist/`, `data/`, Yarn cache; `.github` except the Claude workflow).
- **Sandbox** (`sandbox/Dockerfile`): `python:3.14-slim-trixie` + Node 26 copied from the official image, pinned numpy/pandas/matplotlib/sympy/requests, bash/curl/jq/bc. uid 10001, `TZ=America/New_York`, one BLAS thread, a HEALTHCHECK, and `server.py` as the ENTRYPOINT (PID 1). Don't set `init: true` on the service: Docker's init would take PID 1 back. The service gets `mem_limit: 2g` with `memswap_limit: 2g` (a process's own RLIMIT_DATA is 1792 MB, so a hungry program gets a MemoryError before the container limit), and the `sandbox-workspace` volume needs up to 20 GB on the host.

## Conventions

- Strict TypeScript, no `any`; camelCase functions/variables, PascalCase types/classes.
- Async/await throughout; `Promise.all()` for parallel work.
- Errors at the user boundary become in-character strings; infrastructure errors are logged, never swallowed silently.
- Biome handles formatting and linting over `src` and the root configs. It ignores `src/**/*.test.ts` and the fixtures; tests are still type-checked strictly by `tsconfig.test.json`.
- **New env vars** go through `config.ts`, in their feature's section, with a startup-summary token; channel variables follow the `…_CHANNEL_ID(S)`/`…_CHANNELS` naming. **New events** go through `defineEvent()`, in their own file.
- **New OpenRouter calls** go through `openRouterClient.ts`, carry `provider: { zdr: true }` and `featureRequestOptions('<feature>')` (add the feature to `UsageFeature`); raw requests call `recordUsage()`. Low-thought one-shot calls on a reasoning model send `reasoning: { effort: 'low' }` with enough `max_tokens`.
- **"Who wrote this?"** always goes through `attributeMessage()` (relays count as their author); **"who is this?"** through `src/ai/people.ts`; **"same person?"** through `isSamePerson()`/`canonicalUserId()` (linked accounts). Anything the bot posts through a webhook on a member's behalf is recorded with `recordRelay()`, with its original's id.
- **Fetching a URL someone else chose** goes through `createSafeFetch()`; only Discord's own media hosts are fetched directly.
- Every send the bot makes relies on the client-wide allowedMentions default or passes a stricter one. Text posted into Discord that came from a model or a member never pings beyond the intended users.
- Model output is untrusted input: type-check it, clamp it, and fail closed.
- Tool results that carry third-party text are fenced as untrusted (`read_link`, `watch_video`).
- Persisted data lives in `./data`; prod must volume-mount it. Expect `memory.db` around 32 MB once vectors are backfilled (~2k memories × 16 KB), and `archive.db` a few hundred bytes per message. Normal, not bloat.

## Notes for agents

- There is no `CLAUDE.md`; this file is the project instruction file (the harness and the Claude feature-request workflow read `AGENTS.md`).
- **Done in this batch** (don't redo): usage-grounded emoji captions (what emoji means what), the people resolver + linked accounts, replying without a mention, the message archive, reminders/polls/birthdays, media, the link reader, the sandbox, context-menu commands, feature requests → GitHub, the usage ledger, the file log, the persona and gate evals.
- **Deliberately deferred** (future tasks, not incremental work):
  - The memory *architecture* rework toward per-member profile documents + a consolidation job (today: atomic facts + retrieval injection).
  - A backlog of scheduled events: recurring reminders, DM reminders, scheduled events beyond reminders and birthdays.
  - Thread history backfill in the archive.
  - An offline eval set for the ramble judge (hold out real rambles as positives).
  - Unifying the helpers that remain duplicated per module (small truncate/one-line helpers; a few test files still build a local capturing client instead of using `capturingClient.ts`).
- **Tuning is owner-driven from the logs**: `GATE_THRESHOLD` (`gate: REPLY|skip` lines + `yarn eval:gate`), `RAMBLE_THRESHOLD` (`ramble:` lines), auto-react (shadow lines, then `AUTO_REACT_MODE=on`), fixer order (`*_FIXERS`, alerts).
- **Grandfathered public-repo exception**: the learner prompt's GOOD/BAD examples in `personalityLearner.ts` still use a few real first names; the owner kept them as-is for now. Don't copy them anywhere, and don't add more.
- Cloud / no-Docker fallback: `npm install && npx vitest run && npx tsc -p tsconfig.test.json && npx biome check --fix src/`; set `LEFTHOOK=0` when committing; never commit `package-lock.json`; regenerate `yarn.lock` with a Yarn 4 binary from npm (`npm pack @yarnpkg/cli-dist@4.18.1`) when dependencies change. The sandbox server tests need `python3` and `bash`.

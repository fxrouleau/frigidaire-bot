# Frigidaire Bot

## Overview

A Discord bot built in **TypeScript** with three main features:

1. **AI Chat** — Mention the bot to converse. Supports multiple AI providers (OpenAI, Google Gemini, xAI Grok) with tool-calling and provider switching mid-conversation.
2. **Message Summarization** — Ask the bot to summarize channel history within a timeframe (up to one week). Uses natural language time parsing.
3. **Link Replacement** — Automatically replaces Twitter/X links with `fixvx.com` and Instagram links with `ddinstagram.com` for proper Discord embedding, using webhooks to preserve the original author's appearance.

## Tech Stack

- **Runtime**: Node.js v22 LTS
- **Language**: TypeScript 5.8 (strict mode, target `es2024`, `commonjs` modules)
- **Package Manager**: Yarn v4 (via Corepack, node-modules linker)
- **Linter/Formatter**: Biome — 120 char line width, 2-space indent, single quotes, trailing commas
- **Deployment**: Docker (single container)

## Project Structure

```
src/
├── app.ts                          # Entry point — Discord client init, dynamic event loading
├── logger.ts                       # Timestamp-based console logger (info/warn/error)
├── utils.ts                        # splitMessage(), repostMessage() helpers
├── ai/
│   ├── agent.ts                    # AgentOrchestrator — main conversation handler
│   ├── conversationStore.ts        # In-memory per-channel state with 5-min timeout
│   ├── providerRegistry.ts         # AI provider factory & per-channel tracking
│   ├── tools.ts                    # Tool definitions (summarize, image, switch_provider)
│   ├── types.ts                    # Core type definitions
│   ├── providers/
│   │   ├── openaiProvider.ts       # OpenAI (gpt-5.1)
│   │   ├── geminiProvider.ts       # Google Gemini (gemini-3.0-pro-preview)
│   │   └── grokProvider.ts         # xAI Grok (grok-4-1-fast-reasoning)
│   └── tools/
│       ├── summary.ts              # Message fetching & summarization prompt builder
│       └── localImageGenerator.ts  # Gemini-based image generation with per-channel cache
└── events/
    ├── aiChat.ts                   # Bot mention handler → AgentOrchestrator
    ├── twitterRepost.ts            # Twitter/X link replacement
    ├── instagramRepost.ts          # Instagram link replacement
    └── ready.ts                    # Client ready event logger
```

## Architecture

### Event-Driven Design
- `app.ts` dynamically loads all `.ts`/`.js` files from `src/events/` as Discord event handlers
- Each event file exports `{ name, once?, execute(...args) }`
- Adding a new handler = creating a new file in `src/events/`, no changes to `app.ts` needed

### Multi-Provider AI System
- **`AiProvider` interface**: `id`, `displayName`, `personality`, `defaultModel`, `chat()`, optional `summarizeMessages()`, `generateImage()`, `generateImageLocal()`
- **Provider Registry**: Central store with per-channel provider tracking
- **Tool architecture**: Providers expose tool definitions; the orchestrator handles "host" tools (summarize, switch_provider) and delegates provider-specific tools
- **Conversation flow**: Mention → fetch/create state → build history with system prompt → LLM call with tools → execute host tools → follow-up LLM call without tools → store state

### Conversation Management
- `ConversationStore`: In-memory, per-channel, auto-expires after 15 minutes of inactivity
- Fetches last 10 messages on initial mention for context
- State preserved across provider switches

### Key Types
- `NormalizedContentPart`: `{ type: 'text', text } | { type: 'image', url }`
- `ConversationEntry`: `message | tool_call | tool_result`
- `ProviderToolDefinition` / `ProviderToolCall` / `ToolDefinition` / `ToolHandlerContext`

## Commands

```bash
corepack enable          # Enable Yarn via Corepack (first time only)
yarn install             # Install dependencies
yarn dev                 # Development with hot-reload (nodemon + ts-node)
yarn build               # Compile TypeScript to ./dist
yarn prod                # Run production build from dist/app.js
yarn check               # Run Biome formatter + linter with auto-fix
```

**After any change, run both `yarn build` and `yarn check` before handoff** to ensure build, type, and lint health.

## Environment Variables

**Required:**
```
CLIENT_SECRET=<discord_bot_token>
OPENAI_API_KEY=<openai_api_key>
```

**Optional:**
```
AI_PROVIDER=openai|gemini|grok     # Default provider (default: openai)
XAI_API_KEY=<grok_api_key>
GOOGLE_GENAI_API_KEY=<gemini_key>
GOOGLE_API_KEY=<alt_gemini_key>
GEMINI_MODEL=<custom_gemini_model>
GOOGLE_IMAGE_MODEL=<custom_image_model>
CONVERSATION_TIMEOUT_MS=<ms>       # Conversation context timeout (default: 900000 / 15 min)
```

## Conventions

- **No automated tests** — verify changes via `yarn build` and `yarn check`
- **Biome** handles all formatting and linting; no ESLint/Prettier
- camelCase for functions/variables, PascalCase for classes/interfaces
- Strict TypeScript — no `any` types
- Async/await throughout; `Promise.all()` for parallel operations
- Error handling returns user-facing error strings rather than throwing

## Tooling Notes

- `CLAUDE.md` is a symlink to `AGENTS.md` — they are the same file. Git tracks it as `AGENTS.md`.
- If `yarn install` fails with EPERM/cache errors, use a project-local cache:
  ```bash
  set YARN_CACHE_FOLDER=.yarn\cache && yarn config set enableGlobalCache false && yarn install
  ```
- **Cloud / Claude Code on the web**: Corepack cannot download Yarn v4 directly (the proxy blocks `repo.yarnpkg.com`), but **Yarn v4 is still accessible** via npm. Use npm as a fallback for installing dependencies and running scripts:
  ```bash
  npm install && npx tsc && npx biome check --fix src/
  ```
  Also set `LEFTHOOK=0` when committing, since the pre-commit hook depends on Yarn.
  **Do NOT commit `package-lock.json`** — it is a side effect of using npm and should be left unstaged.
  **When adding/removing packages** (changes to `package.json`), you must also commit an updated `yarn.lock`. Get Yarn v4 via npm to generate it properly:
  ```bash
  npm pack @yarnpkg/cli-dist@4.7.0 && mkdir -p /tmp/yarn-setup && tar -xzf yarnpkg-cli-dist-4.7.0.tgz -C /tmp/yarn-setup
  git checkout -- yarn.lock   # restore original before updating
  node /tmp/yarn-setup/package/bin/yarn.js install
  rm -f yarnpkg-cli-dist-4.7.0.tgz
  ```
  This produces a proper Yarn v4 lockfile that passes CI `--immutable` checks. Always commit `yarn.lock` alongside `package.json` when dependencies change.
- Discord typing indicator loops every 8 seconds during AI processing
- Each provider maps roles differently (assistant/model, developer/system) — see individual provider files for details

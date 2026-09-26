# Frigidaire Bot

A Discord bot for one private server, written in TypeScript. It hangs out in the chat as one of the group. Talk to it by mentioning it, replying to it, or just saying its name mid-conversation, and it answers in character. It remembers things about people over time, and does the chores nobody wants to do by hand.

## What it does

- **Chat**: mention `@Frigidaire`, reply to it, or talk to it ("fridge, who wins tonight?"). A cheap classifier decides when an unmentioned message is meant for it. It sees what was said since it last spoke, the thread it's answering, link previews, voice-message transcripts and video descriptions. Its tools cover web search, summaries, image generation, memory, message search, reminders and polls, birthdays, reading links, watching videos and running code. Any chat model on [OpenRouter](https://openrouter.ai) works; every request is routed to zero-data-retention providers.
- **Long-term memory**: facts, preferences and the server's in-jokes live in SQLite with semantic + keyword search. A background learner picks up durable knowledge from regular chat. It knows everyone by every name they go by, side accounts included.
- **Voice and video**: voice messages get a quiet transcript reply (Whisper), and posted clips are watched by Gemini, within a daily budget.
- **Link fixing**: Twitter/X, Instagram, TikTok, Reddit and Bluesky links are rewritten to embed-fixer domains and reposted under the author's name and avatar, attachments and formatting intact. Dead fixers are skipped automatically, and outages are reported.
- **Message archive and Wrapped**: every message is archived locally (history included) for search, and a yearly "Wrapped" stats post comes out on Jan 1.
- **Right-click commands**: Ask Fridge, Summarize from here, Transcribe, Translate, Remember this, What does Fridge know?
- **Optional extras**:
  - reposting a chosen member's quickly deleted edgy messages;
  - nudging a chosen member's rambles to their own channel;
  - spontaneous emoji reactions (shadow mode until you switch them on);
  - filing members' feature requests as GitHub issues that Claude can implement once the owner approves;
  - an ops channel with a weekly digest, spend, and deploy pings.

## Running it

CI builds two images and pushes them to DockerHub on every merge to `master`: the bot, and the code sandbox sidecar that the `run_code` tool talks to. A Compose setup:

```yaml
services:
  frigidaire-bot:
    image: <your-dockerhub-user>/frigidaire-bot:latest
    restart: unless-stopped
    environment:
      CLIENT_SECRET: <discord bot token>
      OPENROUTER_API_KEY: <openrouter api key>
      SANDBOX_URL: http://sandbox:8080   # leave out to run without the sandbox
    volumes:
      - ./data:/app/data   # SQLite databases, logs, error captures: keep this or everything is lost on recreate

  # Runs model-written code. Never give it the bot's environment (no env_file), and publish no ports.
  sandbox:
    image: <your-dockerhub-user>/frigidaire-sandbox:latest
    restart: unless-stopped
    read_only: true
    tmpfs:
      - /tmp:size=256m,mode=1777,exec
    volumes:
      - sandbox-workspace:/workspace
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
    mem_limit: 2g
    memswap_limit: 2g
    cpus: 1
    pids_limit: 256

volumes:
  sandbox-workspace:
```

Only `CLIENT_SECRET` and `OPENROUTER_API_KEY` are required; everything else has a default. You will probably want `MAIN_CHANNEL_ID` (the channel the group talks in) and `REPORT_CHANNEL_ID` (an ops channel for the owner). The full list is in [AGENTS.md](AGENTS.md#environment-variables). The sandbox's egress is open by default; [docker-compose.yaml](docker-compose.yaml) shows how to cut it or firewall it. The bot container drops to the unprivileged `node` user after making `/app/data` writable, so a root-owned host directory is fine.

To build and run from source instead: `docker compose up -d frigidaire-bot` (reads an optional `.env` and starts the sandbox too).

### Discord setup

1. Create an application and a bot in the [Discord developer portal](https://discord.com/developers/applications). Enable the **Message Content** privileged intent; no other privileged intent is needed. Leave "Interactions Endpoint URL" empty.
2. Invite it with the `bot` and `applications.commands` scopes and these permissions: View Channels, Send Messages, Send Messages in Threads, Read Message History, Attach Files, Add Reactions, Create Polls, **Manage Webhooks** and **Manage Messages**. The last two are what link fixing and message reposting need. The bot never needs Mention Everyone.
3. Put the bot token in `CLIENT_SECRET`.

### Costs

Everything bills through the single OpenRouter key. With the default models, day-to-day use on a small server is cents per day. Video watching is capped by `VIDEO_DAILY_BUDGET_USD` ($0.50/day by default). The one-off emoji captioning on first boot uses a Claude model and costs a few cents per emoji. `query_costs` and the weekly digest report spend per feature.

## Development

The toolchain runs in Docker; the host only needs Docker (Node is optional, for IDE intellisense).

```bash
docker compose build test                          # once, and after dependency changes
docker compose run --rm test                       # full test suite
docker compose run --rm test yarn typecheck        # strict TypeScript over src/ including tests
docker compose run --rm test yarn check            # Biome lint + format (writes fixes back)
docker build --target ci .                         # the exact gate CI runs
```

Everything about the code is in [AGENTS.md](AGENTS.md): architecture, hard rules, the memory system, every feature, environment variables, testing and the prod-error replay workflow.

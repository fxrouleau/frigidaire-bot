# Frigidaire Bot

A Discord bot for one private server, written in TypeScript. It hangs out in the chat as one of the group: talk to it by mentioning it or replying to it, and it answers in character, remembers things about people over time, and does a few chores nobody wants to do by hand.

## What it does

- **Chat** — mention `@Frigidaire` (or reply to one of its messages) and it answers, with tools for summarizing channel history, generating images, looking things up on the web, and reading/writing its own memory. Any model on [OpenRouter](https://openrouter.ai) works; every request is routed to zero-data-retention providers.
- **Long-term memory** — facts, preferences, events and the server's in-jokes live in SQLite with semantic (embedding) + keyword search. A background learner picks up durable knowledge from regular chat, not just from conversations with the bot.
- **Link fixing** — Twitter/X, Instagram and TikTok links are rewritten to embed-fixer domains and reposted under the author's name and avatar, so they actually show a preview. Each fixer is probed before use and dead ones are skipped automatically.
- **Regret reposting** (optional) — for chosen members, a message deleted within a couple of minutes of being posted gets judged by a cheap classifier and, if it was one of their edgy bouts, reposted as them. Attachments included.
- **Ops channel** (optional) — a weekly self-diagnosis digest and a one-line "🚀 Deployed" note on every new build.

## Running it

The bot ships as a Docker image built by CI and pushed to DockerHub on every merge to `master`. A minimal Compose service:

```yaml
services:
  frigidaire-bot:
    image: <your-dockerhub-user>/frigidaire-bot:latest
    restart: unless-stopped
    environment:
      - CLIENT_SECRET=<discord bot token>
      - OPENROUTER_API_KEY=<openrouter api key>
    volumes:
      - ./data:/app/data   # SQLite databases + error captures; keep this or memories are lost on recreate
```

Only those two variables are required. Everything else has a sane default; the full list, with defaults, is in [AGENTS.md](AGENTS.md#environment-variables). The container drops to the unprivileged `node` user at startup after making `/app/data` writable, so a root-owned host directory is fine.

### Discord setup

1. Create an application and bot in the [Discord developer portal](https://discord.com/developers/applications). Enable the **Message Content** privileged intent.
2. Invite it with these permissions: View Channels, Send Messages, Read Message History, Attach Files, Add Reactions, **Manage Webhooks** and **Manage Messages** (the last two are what link fixing and regret reposting need).
3. Put the bot token in `CLIENT_SECRET`.

### Costs

Chat, embeddings, image generation, emoji captions, the learner and the deleted-message judge all bill through the single OpenRouter key. With the defaults, day-to-day usage on a small server is cents per day; the one-off emoji captioning on first boot uses a Claude model and costs a few cents per emoji.

## Development

The toolchain runs in Docker; the host only needs Docker (Node is optional, for IDE intellisense).

```bash
docker compose build test                          # once, and after dependency changes
docker compose run --rm test                       # full test suite
docker compose run --rm test yarn typecheck        # strict TypeScript over src/ including tests
docker compose run --rm test yarn check            # Biome lint + format (writes fixes back)
docker build --target ci .                         # the exact gate CI runs
```

Everything about the code — architecture, memory system, conventions, environment variables, the prod-error replay workflow — is in [AGENTS.md](AGENTS.md).

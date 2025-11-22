# Frigidaire Bot
This is a bot that I've created for personal use on a discord server with friends. It has two main features:

1.  **Twitter/X Link Replacement**: The bot automatically replaces Twitter/X links with `fixvx.com` links to ensure proper embedding in Discord. This is because, at the time of writing, Twitter embeds do not work correctly. The bot uses a webhook to make it look like the user sent the corrected message, as Discord does not allow bots to edit other users' messages directly.
2.  **OpenAI Integration**: You can mention the bot (`@Frigidaire Bot`) to interact with it. The bot uses OpenAI's `gpt-5-mini` model to understand your request and can perform two main tasks:
    *   **Chat**: Engage in a natural conversation. The bot remembers the last 10 messages to understand the context.
    *   **Summarize**: Ask the bot to summarize the chat history within a specific timeframe (up to a maximum of one week). The bot understands natural language for timeframes.
        - **Examples**:
            - `@Frigidaire Bot summarize what happened this morning.`
            - `@Frigidaire Bot can you summarize the conversation from 3am to 6am today?`
            - `@Frigidaire Bot give me a summary of yesterday's chat.`

    The conversation history for the chat feature is shared among all users in the channel and will be maintained for up to 5 minutes of inactivity before being reset.

## Docker Compose
If you want to just use the bot easily without downloading this repository, you can use the following docker-compose template:
```yaml
version: '3'
services:
  discord-bot:
    image: zergyhan/frigidaire-bot
    environment:
      - CLIENT_SECRET=YOUR_SECRET_HERE
      - OPENAI_API_KEY=YOUR_OPENAI_KEY_HERE
```
- `CLIENT_SECRET` can be gotten from the [discord developer portal](https://discord.com/developers/applications) under the bot section. You will have to give the bot permissions to manage webhooks, read and send messages.
- `OPENAI_API_KEY` can be obtained from the [OpenAI API keys page](https://platform.openai.com/api-keys).

## Development
### Setup
- Node 22 LTS
- Typescript
- Modern yarn
- [discord.js](https://discord.js.org/docs/packages/discord.js/14.18.0)

### Recommended plugins
- BiomeJS ([VSCode](https://marketplace.visualstudio.com/items?itemName=biomejs.biome), [Jetbrains](https://plugins.jetbrains.com/plugin/22761-biome))
- EditorConfig ([VSCode](https://marketplace.visualstudio.com/items?itemName=EditorConfig.EditorConfig))

### Running
For both versions, you'll need an env file with the following content:
```env
CLIENT_SECRET=YOUR_SECRET_HERE
OPENAI_API_KEY=YOUR_OPENAI_KEY_HERE
```

To run the development version, run `yarn dev` to start the bot.

To test the production version, run `yarn build` followed by `yarn prod` to start the bot.

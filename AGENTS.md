## Repository Analysis for Frigidaire Bot

This document provides an analysis of the Frigidaire Bot repository to guide future development and maintenance.

### Project Overview

The project is a Discord bot developed in **TypeScript**. It offers two primary functionalities:
1.  **Twitter/X Link Replacement**: Automatically replaces `twitter.com` or `x.com` links in messages with `fixvx.com` to ensure proper video/image embedding in Discord.
2.  **OpenAI Chatbot**: The bot can be mentioned (`@Frigidaire Bot`) to engage in a conversation. It uses an OpenAI model to generate responses. When a new conversation is initiated, the bot reads the last 10 messages from the channel to build a contextual understanding. The conversation context is maintained per-channel and resets after 5 minutes of inactivity. Each message in the context includes the user's display name to identify the speaker.

### File Structure

The repository is structured as follows:

-   `src/`: Contains the main source code.
    -   `app.ts`: The application's entry point. It initializes the Discord client and dynamically loads all event handlers from the `src/events/` directory.
    -   `events/`: This directory holds individual files for each Discord event the bot listens to. For example, `twitterRepost.ts` handles the link replacement, and `openai.ts` handles the chatbot functionality.
-   `package.json`: Defines project metadata, dependencies, and scripts.
-   `yarn.lock`: The Yarn lockfile.
-   `tsconfig.json`: Configuration file for the TypeScript compiler.
-   `README.md`: Contains user-facing documentation, setup instructions, and environment variable requirements.
-   `docker-compose.yaml` & `Dockerfile`: For containerized deployment.

### Dependencies

-   **Main Dependencies**:
    -   `discord.js`: The primary library for interacting with the Discord API.
    -   `dotenv`: Used to load environment variables from a `.env` file.
    -   `openai`: The official OpenAI Node.js library for API interactions.
-   **Development Dependencies**:
    -   `typescript`: For compiling TypeScript to JavaScript.
    -   `ts-node`: To run TypeScript files directly without pre-compilation.
    -   `nodemon`: Monitors for file changes and automatically restarts the application during development.
    -   `@biomejs/biome`: A fast formatter and linter for web projects.

### Development Workflow

1.  **Environment Setup**:
    -   The project requires **Node.js v22 LTS** and **Yarn v4**.
    -   Yarn version is managed by **Corepack**. Before first use, enable it by running:
        ```bash
        corepack enable
        ```
    -   Install dependencies with:
        ```bash
        yarn install
        ```
    -   Create a `.env` file in the root directory with the following variables:
        ```
        CLIENT_SECRET=your_discord_bot_token
        OPENAI_API_KEY=your_openai_api_key
        ```

2.  **Running the Bot**:
    -   For development (with hot-reloading):
        ```bash
        yarn dev
        ```
    -   To build for production:
        ```bash
        yarn build
        ```
    -   To run the production build:
        ```bash
        yarn prod
        ```

3.  **Code Quality**:
    -   The project uses **Biome** for code formatting and linting. To check and fix files, run:
        ```bash
        yarn check
        ```

### Key Architectural Patterns

-   **Event-Driven**: The bot's logic is organized around Discord gateway events (e.g., `MessageCreate`). Each event is handled in its own dedicated file within the `src/events/` directory, which promotes modularity and separation of concerns.
-   **Dynamic Event Loading**: The main `app.ts` file dynamically reads all `.ts` or `.js` files in the `src/events/` directory and registers them as event listeners. This makes adding new event handlers as simple as creating a new file in the directory, without needing to modify the main application file.
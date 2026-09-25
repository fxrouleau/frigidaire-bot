// Discord context-menu commands: right-click (or long-press on mobile) a message or a member → Apps.
//
// Registration: every guild the bot is in gets the full command set on ClientReady through one bulk
// overwrite (guild.commands.set), which is idempotent — unchanged commands don't count against Discord's
// 200-creates-per-day limit, and guild commands update instantly where global ones take up to an hour.
// The overwrite replaces ALL of this application's commands in the guild, so every guild command the bot
// has must be listed in COMMANDS.
//
// Dispatch: interactionCreate hands every context-menu interaction to handleContextMenuCommand(), which
// finds the command and runs it behind one error boundary: an expected outcome (CommandError) becomes a
// private in-character line, anything else a private "that broke" plus a WARN. Nothing escapes as an
// unhandled rejection, and every response to the invoker is ephemeral.
import {
  type ApplicationCommandDataResolvable,
  ApplicationCommandType,
  type Client,
  type ContextMenuCommandInteraction,
} from 'discord.js';
import { agent } from '../ai/agentInstance';
import { describeVideo, getCachedTranscript, transcribeAudio } from '../ai/media';
import { getMemoryStore } from '../ai/memory';
import { config } from '../config';
import { logger } from '../logger';
import { askFridge } from './askFridge';
import { createCompletion } from './completion';
import { rememberThis } from './rememberThis';
import { LINES, discordErrorCode, failPrivately } from './respond';
import { summarizeFromHere } from './summarizeFromHere';
import { summarizeFromMessage } from './summary';
import { transcribe } from './transcribe';
import { translate } from './translate';
import { type CommandDeps, CommandError, type ContextMenuCommand } from './types';
import { whatDoesFridgeKnow } from './whatDoesFridgeKnow';

/** Menu order under Apps follows registration order. */
export const COMMANDS: readonly ContextMenuCommand[] = [
  askFridge,
  summarizeFromHere,
  transcribe,
  translate,
  rememberThis,
  whatDoesFridgeKnow,
];

const MISSING_ACCESS = 50001;

/** The registration payload: name + type only. Guild commands are usable by every member by default. */
export function commandPayloads(
  commands: readonly ContextMenuCommand[] = COMMANDS,
): ApplicationCommandDataResolvable[] {
  return commands.map((command) => ({ name: command.name, type: command.type }));
}

export function findCommand(
  name: string,
  type: ApplicationCommandType,
  commands: readonly ContextMenuCommand[] = COMMANDS,
): ContextMenuCommand | undefined {
  return commands.find((command) => command.name === name && command.type === type);
}

/**
 * Registers the command set in every guild the bot is in (COMMANDS_ENABLED=false registers an empty set,
 * which removes the entries instead of leaving dead buttons). Per-guild failures are logged, never thrown.
 */
export async function registerGuildCommands(
  client: Client<true>,
  commands: readonly ContextMenuCommand[] = COMMANDS,
): Promise<void> {
  const enabled = config.commands.enabled;
  const payload = enabled ? commandPayloads(commands) : [];
  const guilds = [...client.guilds.cache.values()];
  if (guilds.length === 0) {
    logger.warn('commands: the bot is in no guild, nothing to register');
    return;
  }

  await Promise.all(
    guilds.map(async (guild) => {
      try {
        const registered = await guild.commands.set(payload);
        logger.info(
          enabled
            ? `commands: registered ${registered.size} context-menu command(s) in ${guild.name}`
            : `commands: COMMANDS_ENABLED is off, cleared context-menu commands in ${guild.name}`,
        );
      } catch (error) {
        if (discordErrorCode(error) === MISSING_ACCESS) {
          // The bot scope includes applications.commands for current invites; an old or hand-built invite
          // may lack it. Authorizing just that scope adds it without touching the bot's role.
          const clientId = client.application?.id ?? client.user.id;
          logger.warn(
            `commands: Discord refused to register commands in ${guild.name} (Missing Access). The bot probably lacks the applications.commands scope there; authorize it with https://discord.com/oauth2/authorize?client_id=${clientId}&scope=applications.commands`,
          );
          return;
        }
        logger.warn(`commands: registering context-menu commands in ${guild.name} failed:`, error);
      }
    }),
  );
}

let defaultDeps: CommandDeps | undefined;

/** The production collaborators (shared agent, summary pipeline, media, OpenRouter, memory store). */
export function defaultCommandDeps(): CommandDeps {
  defaultDeps ??= {
    askAgent: (message) => agent.handleMention(message),
    summarize: (request) => summarizeFromMessage(request),
    transcribeAudio,
    getCachedTranscript,
    describeVideo,
    complete: createCompletion(),
    memoryStore: getMemoryStore,
    now: () => new Date(),
  };
  return defaultDeps;
}

/** Runs the context-menu command an interaction is for. Never throws. */
export async function handleContextMenuCommand(
  interaction: ContextMenuCommandInteraction,
  deps: CommandDeps = defaultCommandDeps(),
  commands: readonly ContextMenuCommand[] = COMMANDS,
): Promise<void> {
  const label = `"${interaction.commandName}"`;

  if (!config.commands.enabled) {
    await failPrivately(interaction, LINES.disabled);
    return;
  }
  if (!interaction.inGuild()) {
    await failPrivately(interaction, LINES.guildOnly);
    return;
  }

  const command = findCommand(interaction.commandName, interaction.commandType, commands);
  if (!command) {
    logger.warn(`commands: no handler for ${label} (a stale registration?)`);
    await failPrivately(interaction, LINES.unknownCommand);
    return;
  }

  logger.info(`commands: ${interaction.user.username} used ${label} in channel ${interaction.channelId}`);
  try {
    if (command.type === ApplicationCommandType.Message && interaction.isMessageContextMenuCommand()) {
      await command.run(interaction, deps);
    } else if (command.type === ApplicationCommandType.User && interaction.isUserContextMenuCommand()) {
      await command.run(interaction, deps);
    }
  } catch (error) {
    if (error instanceof CommandError) {
      logger.info(`commands: ${label} stopped: ${error.userMessage}`);
      await failPrivately(interaction, error.userMessage);
      return;
    }
    logger.warn(`commands: ${label} failed:`, error);
    await failPrivately(interaction, LINES.failed);
  }
}

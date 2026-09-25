import { ApplicationCommandType } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createFakeCommandDeps,
  createFakeGuild,
  createFakeMessageCommandInteraction,
  createFakeReadyClient,
  createFakeTargetMessage,
  createFakeUserCommandInteraction,
} from '../test-support/fakeInteraction';
import {
  COMMANDS,
  commandPayloads,
  defaultCommandDeps,
  findCommand,
  handleContextMenuCommand,
  registerGuildCommands,
} from './index';
import { LINES } from './respond';
import { CommandError, type MessageCommand } from './types';

let log: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const logged = (level: 'INFO' | 'WARN'): string[] =>
  log.mock.calls.filter((c: unknown[]) => String(c[0]).includes(`[${level}]`)).map((c: unknown[]) => String(c[0]));

describe('the command set', () => {
  it('registers the six commands by name and type', () => {
    expect(commandPayloads()).toEqual([
      { name: 'Ask Fridge', type: ApplicationCommandType.Message },
      { name: 'Summarize from here', type: ApplicationCommandType.Message },
      { name: 'Transcribe', type: ApplicationCommandType.Message },
      { name: 'Translate', type: ApplicationCommandType.Message },
      { name: 'Remember this', type: ApplicationCommandType.Message },
      { name: 'What does Fridge know?', type: ApplicationCommandType.User },
    ]);
  });

  it("fits Discord's limits: 1–32 character names, unique per type, at most 15 per type", () => {
    for (const command of COMMANDS) {
      expect(command.name.length).toBeGreaterThanOrEqual(1);
      expect(command.name.length).toBeLessThanOrEqual(32);
      expect(command.name.trim()).toBe(command.name);
    }
    for (const type of [ApplicationCommandType.Message, ApplicationCommandType.User]) {
      const names = COMMANDS.filter((c) => c.type === type).map((c) => c.name);
      expect(new Set(names).size).toBe(names.length);
      expect(names.length).toBeLessThanOrEqual(15);
    }
  });

  it('finds commands by name AND type', () => {
    expect(findCommand('Translate', ApplicationCommandType.Message)?.name).toBe('Translate');
    expect(findCommand('Translate', ApplicationCommandType.User)).toBeUndefined();
    expect(findCommand('Nope', ApplicationCommandType.Message)).toBeUndefined();
  });

  it('wires production dependencies', () => {
    const deps = defaultCommandDeps();
    expect(defaultCommandDeps()).toBe(deps);
    expect(typeof deps.askAgent).toBe('function');
    expect(deps.now()).toBeInstanceOf(Date);
  });
});

describe('registerGuildCommands', () => {
  it('bulk-overwrites the command set in every guild', async () => {
    const a = createFakeGuild({ id: 'g1', name: 'Main' });
    const b = createFakeGuild({ id: 'g2', name: 'Other' });
    await registerGuildCommands(createFakeReadyClient([a.guild, b.guild]));
    expect(a.recorders.commandsSet.calls).toEqual([[commandPayloads()]]);
    expect(b.recorders.commandsSet.calls).toEqual([[commandPayloads()]]);
    expect(logged('INFO').some((l) => l.includes('registered 6 context-menu command(s) in Main'))).toBe(true);
  });

  it('registers an empty set when COMMANDS_ENABLED is off, so the entries disappear', async () => {
    vi.stubEnv('COMMANDS_ENABLED', 'false');
    const g = createFakeGuild();
    await registerGuildCommands(createFakeReadyClient([g.guild]));
    expect(g.recorders.commandsSet.calls).toEqual([[[]]]);
  });

  it('explains a Missing Access failure with the authorization link, without throwing', async () => {
    const g = createFakeGuild({ commandsSetError: Object.assign(new Error('Missing Access'), { code: 50001 }) });
    await expect(registerGuildCommands(createFakeReadyClient([g.guild], { botUserId: 'app-42' }))).resolves.toBeUndefined();
    const warning = logged('WARN').join('\n');
    expect(warning).toContain('applications.commands');
    expect(warning).toContain('https://discord.com/oauth2/authorize?client_id=app-42&scope=applications.commands');
  });

  it('logs other failures per guild and keeps going', async () => {
    const broken = createFakeGuild({ id: 'g1', commandsSetError: new Error('503') });
    const fine = createFakeGuild({ id: 'g2' });
    await registerGuildCommands(createFakeReadyClient([broken.guild, fine.guild]));
    expect(fine.recorders.commandsSet.calls).toHaveLength(1);
    expect(logged('WARN').some((l) => l.includes('registering context-menu commands'))).toBe(true);
  });

  it('warns when the bot is in no guild', async () => {
    await registerGuildCommands(createFakeReadyClient([]));
    expect(logged('WARN').some((l) => l.includes('no guild'))).toBe(true);
  });
});

describe('handleContextMenuCommand', () => {
  const target = () => createFakeTargetMessage({ content: 'hello' }).message;

  function commandThatThrows(error: unknown): MessageCommand {
    return {
      type: ApplicationCommandType.Message,
      name: 'Boom',
      run: async (interaction) => {
        await interaction.deferReply({ flags: 64 });
        throw error;
      },
    };
  }

  it('refuses every command while COMMANDS_ENABLED is off', async () => {
    vi.stubEnv('COMMANDS_ENABLED', '0');
    const { interaction, responses } = createFakeMessageCommandInteraction(target(), { commandName: 'Translate' });
    const { deps, recorders } = createFakeCommandDeps();
    await handleContextMenuCommand(interaction, deps);
    expect(responses).toEqual([expect.objectContaining({ method: 'reply', content: LINES.disabled, ephemeral: true })]);
    expect(recorders.complete.calls).toHaveLength(0);
  });

  it('refuses outside a guild', async () => {
    const { interaction, responses } = createFakeMessageCommandInteraction(target(), {
      commandName: 'Translate',
      inGuild: false,
    });
    await handleContextMenuCommand(interaction, createFakeCommandDeps().deps);
    expect(responses[0]).toMatchObject({ content: LINES.guildOnly, ephemeral: true });
  });

  it('answers a stale/unknown command privately and warns', async () => {
    const { interaction, responses } = createFakeMessageCommandInteraction(target(), { commandName: 'Old Command' });
    await handleContextMenuCommand(interaction, createFakeCommandDeps().deps);
    expect(responses[0]).toMatchObject({ content: LINES.unknownCommand, ephemeral: true });
    expect(logged('WARN').some((l) => l.includes('Old Command'))).toBe(true);
  });

  it('does not run a message command for a user interaction with the same name', async () => {
    const { interaction, responses } = createFakeUserCommandInteraction({ id: 'u1' }, { commandName: 'Translate' });
    await handleContextMenuCommand(interaction, createFakeCommandDeps().deps);
    expect(responses[0]).toMatchObject({ content: LINES.unknownCommand });
  });

  it('shows a CommandError to the invoker privately, logged at INFO only', async () => {
    const { interaction, responses } = createFakeMessageCommandInteraction(target(), { commandName: 'Boom' });
    await handleContextMenuCommand(interaction, createFakeCommandDeps().deps, [
      commandThatThrows(new CommandError('nothing there')),
    ]);
    expect(responses.map((r) => [r.method, r.content, r.ephemeral])).toEqual([
      ['deferReply', undefined, true],
      ['editReply', 'nothing there', true],
    ]);
    expect(logged('WARN')).toEqual([]);
  });

  it('turns an unexpected error into the in-character failure line plus a WARN', async () => {
    const { interaction, responses } = createFakeMessageCommandInteraction(target(), { commandName: 'Boom' });
    await handleContextMenuCommand(interaction, createFakeCommandDeps().deps, [commandThatThrows(new Error('kaboom'))]);
    expect(responses.at(-1)).toMatchObject({ method: 'editReply', content: LINES.failed, ephemeral: true });
    expect(logged('WARN').some((l) => l.includes('"Boom" failed'))).toBe(true);
  });

  it('never rejects, even when the failure message itself cannot be delivered', async () => {
    const { interaction } = createFakeMessageCommandInteraction(target(), {
      commandName: 'Boom',
      failOn: { editReply: new Error('Unknown interaction') },
    });
    await expect(
      handleContextMenuCommand(interaction, createFakeCommandDeps().deps, [commandThatThrows(new Error('kaboom'))]),
    ).resolves.toBeUndefined();
  });

  describe('repeat clicks while a run is in progress', () => {
    function slowCommand(exclusive?: 'target' | 'invoker') {
      let finish = () => {};
      const gate = new Promise<void>((resolve) => {
        finish = resolve;
      });
      let runs = 0;
      const command: MessageCommand = {
        type: ApplicationCommandType.Message,
        name: 'Slow',
        exclusive,
        run: async (interaction) => {
          runs += 1;
          await interaction.deferReply({ flags: 64 });
          await gate;
          await interaction.editReply('done');
        },
      };
      return { command, finish: () => finish(), runs: () => runs };
    }

    it("turns away a repeat on the same target privately, whoever clicks, for 'target' commands", async () => {
      const slow = slowCommand('target');
      const message = target();
      const first = createFakeMessageCommandInteraction(message, { commandName: 'Slow', invokerId: 'a' });
      const second = createFakeMessageCommandInteraction(message, { commandName: 'Slow', invokerId: 'b' });
      const deps = createFakeCommandDeps().deps;

      const running = handleContextMenuCommand(first.interaction, deps, [slow.command]);
      await handleContextMenuCommand(second.interaction, deps, [slow.command]);
      expect(second.responses).toEqual([expect.objectContaining({ method: 'reply', content: LINES.busy, ephemeral: true })]);

      slow.finish();
      await running;
      expect(slow.runs()).toBe(1);
      expect(first.texts()).toEqual(['done']);

      // Once the first run is over, the command is available again.
      const third = createFakeMessageCommandInteraction(message, { commandName: 'Slow', invokerId: 'b' });
      await handleContextMenuCommand(third.interaction, deps, [slow.command]);
      expect(slow.runs()).toBe(2);
    });

    it('lets different invokers run private commands on the same target at once', async () => {
      const slow = slowCommand();
      const message = target();
      const deps = createFakeCommandDeps().deps;
      const a = createFakeMessageCommandInteraction(message, { commandName: 'Slow', invokerId: 'a' });
      const b = createFakeMessageCommandInteraction(message, { commandName: 'Slow', invokerId: 'b' });
      const again = createFakeMessageCommandInteraction(message, { commandName: 'Slow', invokerId: 'a' });

      const runs = [
        handleContextMenuCommand(a.interaction, deps, [slow.command]),
        handleContextMenuCommand(b.interaction, deps, [slow.command]),
      ];
      await handleContextMenuCommand(again.interaction, deps, [slow.command]);
      expect(again.texts()).toEqual([LINES.busy]);

      slow.finish();
      await Promise.all(runs);
      expect(slow.runs()).toBe(2);
    });

    it('releases the target when a run fails', async () => {
      const message = target();
      const deps = createFakeCommandDeps().deps;
      const boom = { ...commandThatThrows(new Error('kaboom')), exclusive: 'target' as const };
      await handleContextMenuCommand(createFakeMessageCommandInteraction(message, { commandName: 'Boom' }).interaction, deps, [boom]);
      const retry = createFakeMessageCommandInteraction(message, { commandName: 'Boom' });
      await handleContextMenuCommand(retry.interaction, deps, [boom]);
      expect(retry.texts()).toEqual([LINES.failed]);
    });
  });

  it('never rejects when the acknowledgement itself fails (token already expired)', async () => {
    const guild = createFakeGuild();
    const message = createFakeTargetMessage({ content: 'bonjour', guild: guild.guild }).message;
    const { interaction } = createFakeMessageCommandInteraction(message, {
      commandName: 'Translate',
      failOn: { deferReply: new Error('Unknown interaction'), reply: new Error('Unknown interaction') },
    });
    await expect(handleContextMenuCommand(interaction, createFakeCommandDeps().deps)).resolves.toBeUndefined();
  });
});

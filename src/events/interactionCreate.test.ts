import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as commands from '../commands';
import interactionCreateEvent from './interactionCreate';

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

type Interaction = Parameters<typeof interactionCreateEvent.execute>[0];

describe('interactionCreate', () => {
  it('is a regular InteractionCreate handler', () => {
    expect(interactionCreateEvent.name).toBe('interactionCreate');
    expect(interactionCreateEvent.once).toBe(false);
  });

  it('routes context-menu commands to the command dispatcher', async () => {
    const handle = vi.spyOn(commands, 'handleContextMenuCommand').mockResolvedValue();
    const interaction = { isContextMenuCommand: () => true } as unknown as Interaction;
    await interactionCreateEvent.execute(interaction);
    expect(handle).toHaveBeenCalledWith(interaction);
  });

  it('leaves every other interaction alone (no response, no dispatch)', async () => {
    const handle = vi.spyOn(commands, 'handleContextMenuCommand').mockResolvedValue();
    const reply = vi.fn();
    const interaction = { isContextMenuCommand: () => false, reply } as unknown as Interaction;
    await interactionCreateEvent.execute(interaction);
    expect(handle).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
  });
});

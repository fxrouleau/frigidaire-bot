import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { commandPayloads } from '../commands';
import { createFakeGuild, createFakeReadyClient } from '../test-support/fakeInteraction';
import commandsRegisterEvent from './commandsRegister';

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('commandsRegister', () => {
  it('is a once-only ClientReady handler', () => {
    expect(commandsRegisterEvent.name).toBe('clientReady');
    expect(commandsRegisterEvent.once).toBe(true);
  });

  it('registers the context-menu commands in the guilds the client is in', async () => {
    const { guild, recorders } = createFakeGuild();
    await commandsRegisterEvent.execute(createFakeReadyClient([guild]));
    expect(recorders.commandsSet.calls).toEqual([[commandPayloads()]]);
  });

  it('never rejects when Discord refuses', async () => {
    const { guild } = createFakeGuild({ commandsSetError: new Error('Discord is down') });
    await expect(commandsRegisterEvent.execute(createFakeReadyClient([guild]))).resolves.toBeUndefined();
  });
});

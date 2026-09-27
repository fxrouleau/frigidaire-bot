import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as actions from '../commands/notesViewerActions';
import notesViewerEvent from './notesViewerInteraction';

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

type Interaction = Parameters<typeof notesViewerEvent.execute>[0];

function interaction(kind: 'button' | 'select' | 'modal' | 'command', customId = 'nv:s:g:abc'): Interaction {
  return {
    customId,
    isButton: () => kind === 'button',
    isStringSelectMenu: () => kind === 'select',
    isModalSubmit: () => kind === 'modal',
    reply: vi.fn(),
  } as unknown as Interaction;
}

describe('notesViewerInteraction', () => {
  it('is a regular InteractionCreate handler', () => {
    expect(notesViewerEvent.name).toBe('interactionCreate');
    expect(notesViewerEvent.once).toBe(false);
  });

  it("routes the viewer's buttons, select menus and modals to the viewer", async () => {
    const handle = vi.spyOn(actions, 'handleViewerInteraction').mockResolvedValue();
    for (const kind of ['button', 'select', 'modal'] as const) {
      const event = interaction(kind);
      await notesViewerEvent.execute(event);
      expect(handle).toHaveBeenLastCalledWith(event);
    }
    expect(handle).toHaveBeenCalledTimes(3);
  });

  it("leaves other components and every command alone (another handler's, or the command dispatcher's)", async () => {
    const handle = vi.spyOn(actions, 'handleViewerInteraction').mockResolvedValue();
    await notesViewerEvent.execute(interaction('button', 'poll:vote:1'));
    await notesViewerEvent.execute(interaction('command'));
    expect(handle).not.toHaveBeenCalled();
  });
});

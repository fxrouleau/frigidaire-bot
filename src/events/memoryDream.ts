// Starts memory v2's nightly dream (src/ai/memory/notes/dreamSchedule.ts) once the client is ready: once
// per Eastern day from MEMORY_DREAM_HOUR, the people with new journal rows get their notes rewritten by the
// dream model, then the group; a line goes to the report channel after a night with changes. Off with
// MEMORY_DREAM_ENABLED=false.
import { Events } from 'discord.js';
import { type DreamScheduler, startDreamScheduler } from '../ai/memory/notes/dreamSchedule';
import { config } from '../config';
import { defineEvent } from '../eventModule';

let scheduler: DreamScheduler | undefined;

export default defineEvent(Events.ClientReady, {
  once: true,
  execute(client) {
    if (scheduler || !config.dream.enabled) return;
    scheduler = startDreamScheduler(client);
  },
});

/** Test-only: stops and forgets the running scheduler. */
export function resetMemoryDreamForTesting(): void {
  scheduler?.stop();
  scheduler = undefined;
}

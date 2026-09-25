// Starts the scheduler (reminders + birthday announcements) once the Discord client is ready: posting
// needs a logged-in client, and the first tick delivers whatever came due while the bot was offline.
import { Events } from 'discord.js';
import { defineEvent } from '../eventModule';
import { Scheduler } from '../scheduling/scheduler';

let scheduler: Scheduler | undefined;

export default defineEvent(Events.ClientReady, {
  once: true,
  execute(client) {
    if (scheduler) return;
    scheduler = new Scheduler({ client });
    scheduler.start();
  },
});

/** Test-only: stops and forgets the running scheduler. */
export function resetSchedulerForTesting(): void {
  scheduler?.stop();
  scheduler = undefined;
}

// The yearly "Wrapped" stats post (src/archive/wrapped.ts), on Jan 1 from 15:00 ET. Off unless the
// archive is on and WRAPPED_CHANNEL_ID (or REPORT_CHANNEL_ID) is set; WRAPPED_ENABLED=false also
// disables it. The check is cheap and idempotent (a bot.db watermark), so it simply runs every few minutes.
import { Events } from 'discord.js';
import { discordWrappedDeps, runWrappedCheck } from '../archive/wrapped';
import { config } from '../config';
import { defineEvent } from '../eventModule';

const CHECK_INTERVAL_MS = 10 * 60 * 1000;
// Gives the startup gap fill a head start: a Wrapped computed mid-gap-fill would miss the downtime.
const FIRST_CHECK_DELAY_MS = 60 * 1000;

export default defineEvent(Events.ClientReady, {
  once: true,
  execute(client) {
    if (!config.archive.enabled || !config.archive.wrappedEnabled || !config.archive.wrappedChannelId) return;
    const deps = discordWrappedDeps(client);
    setTimeout(() => void runWrappedCheck(deps), FIRST_CHECK_DELAY_MS).unref();
    setInterval(() => void runWrappedCheck(deps), CHECK_INTERVAL_MS).unref();
  },
});

// Posts link-fixing outages and recoveries to the report channel (see src/links/fixerAlerts.ts). Off
// unless REPORT_CHANNEL_ID is set; LINK_FIX_ALERTS=false also disables it.
import { Events } from 'discord.js';
import { getReportChannelId, sendToReportChannel } from '../ai/reportChannel';
import { config } from '../config';
import { defineEvent } from '../eventModule';
import { FixerAlerter, botDbAlertStore } from '../links/fixerAlerts';
import { onPlatformHealthChange, platformHealth } from '../links/fixerHealth';

export default defineEvent(Events.ClientReady, {
  once: true,
  execute(client) {
    if (!getReportChannelId() || !config.links.alertsEnabled) return;

    const alerter = new FixerAlerter({
      send: (text) => sendToReportChannel(client, text),
      currentState: platformHealth,
      minIntervalMs: config.links.alertMinIntervalMs,
      store: botDbAlertStore(),
    });
    onPlatformHealthChange((change) => void alerter.handle(change));
  },
});

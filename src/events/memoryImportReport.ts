// The report-channel line of this start's memory notes import (src/ai/memory/bootstrap/importer.ts). The
// import itself runs in app.ts before login, so nothing can dream on the old state meanwhile; the line
// can only go out once the client is ready. The log has the full story either way.
import { Events } from 'discord.js';
import { takeImportReport } from '../ai/memory/bootstrap/importer';
import { sendToReportChannel } from '../ai/reportChannel';
import { defineEvent } from '../eventModule';

export default defineEvent(Events.ClientReady, {
  once: true,
  async execute(client) {
    const report = takeImportReport();
    if (report) await sendToReportChannel(client, report);
  },
});

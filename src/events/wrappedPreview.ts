// `!wrapped` / `!wrapped 2025` in the report channel: posts a preview of the yearly Wrapped post right
// there (src/archive/wrapped.ts), so the owner can check it without waiting for January. Only the report
// channel listens (it is the owner's channel; nobody else sees the command work), and only while the
// archive is on. WRAPPED_ENABLED=false does not block a preview: previewing before enabling is the point.
import { Events } from 'discord.js';
import { discordWrappedDeps, parseWrappedPreviewCommand, runWrappedPreview } from '../archive/wrapped';
import { config } from '../config';
import { defineEvent } from '../eventModule';
import { logger } from '../logger';

export default defineEvent(Events.MessageCreate, {
  async execute(message) {
    if (message.author.bot || message.webhookId) return;
    const reportChannelId = config.report.channelId;
    if (!reportChannelId || message.channel.id !== reportChannelId || !config.archive.enabled) return;
    const request = parseWrappedPreviewCommand(message.content);
    if (!request) return;
    logger.info(
      `wrapped: preview${request.year ? ` of ${request.year}` : ''} requested by ${message.author.username}.`,
    );
    await runWrappedPreview({ channelId: message.channel.id, ...request }, discordWrappedDeps(message.client));
  },
});

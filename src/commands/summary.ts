// The one place "Summarize from here" reaches the summary pipeline.
//
// Today that is the chat provider's summarizeMessages(), which reports failures as ordinary text. The
// summary pipeline is being replaced by summarizeChannel({ message, start, end, requesterId }) in
// src/ai/tools/summary.ts; when it lands, swap the body of summarizeFromMessage() for a call to it and
// delete LEGACY_FAILURE_REASONS. Nothing else in src/commands/ needs to change.
import { getProvider } from '../ai/providerRegistry';
import type { AiProvider } from '../ai/types';
import { LINES } from './respond';
import type { ChannelSummary, SummarizeRequest } from './types';

const NOTHING_TO_SUMMARIZE = 'nothing to summarize from there';

// summarizeMessages() returns these strings instead of throwing; they must not be posted as a summary.
const LEGACY_FAILURE_REASONS: ReadonlyMap<string, string> = new Map([
  ['I found no messages in that time range to summarize.', NOTHING_TO_SUMMARIZE],
  ['Invalid date format. Please use ISO 8601 format (e.g., "2025-10-03T18:00:00Z").', LINES.failed],
  ['The maximum timeframe for a summary is one week.', LINES.failed],
  ['The start time must be before the end time.', LINES.failed],
  ['I was unable to generate a summary.', LINES.failed],
  ['An error occurred while trying to summarize the messages.', LINES.failed],
]);

export async function summarizeFromMessage(
  request: SummarizeRequest,
  provider: AiProvider = getProvider(),
): Promise<ChannelSummary> {
  if (!provider.summarizeMessages) return { ok: false, reason: LINES.failed };
  const text = (
    await provider.summarizeMessages(request.message, request.start.toISOString(), request.end.toISOString())
  ).trim();
  if (text.length === 0) return { ok: false, reason: LINES.failed };
  const failure = LEGACY_FAILURE_REASONS.get(text);
  return failure ? { ok: false, reason: failure } : { ok: true, text };
}

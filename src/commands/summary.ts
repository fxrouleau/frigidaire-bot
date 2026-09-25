// The one place "Summarize from here" reaches the summary pipeline: the same summarizeChannel pipeline
// the chat's summarize_messages tool uses (src/ai/tools/summary.ts: history fetch, transcript, WHO'S
// WHO background, one ZDR model call tagged 'summary'), taken as data so the command decides what is
// posted publicly and what stays private. No chat model relays this summary, so the summarizer is told
// it writes for the group directly (audience 'group').
import {
  type ChannelSummaryResult,
  type SummarizeChannelOptions,
  type SummaryFailure,
  summarizeChannelResult,
} from '../ai/tools/summary';
import { LINES, subtext } from './respond';
import type { ChannelSummary, SummarizeRequest } from './types';

/** What the invoker sees (privately) when there is no summary. */
const FAILURE_LINES: Record<SummaryFailure, string> = {
  no_messages: 'nothing to summarize from there',
  history_unreadable: "can't read the history in there",
  model_failed: LINES.failed,
  model_empty: LINES.failed,
};

export async function summarizeFromMessage(
  request: SummarizeRequest,
  summarize: (opts: SummarizeChannelOptions) => Promise<ChannelSummaryResult> = summarizeChannelResult,
): Promise<ChannelSummary> {
  const result = await summarize({
    message: request.message,
    // The target message is where the range starts: it is part of the summary, not a request.
    messageRole: 'target',
    start: request.start,
    end: request.end,
    requesterId: request.requesterId,
    audience: 'group',
  });
  if (!result.ok) return { ok: false, reason: FAILURE_LINES[result.reason] };
  // The range header and the people footer are written for the chat model; the command states its own
  // range. Caveats (skipped messages, history limits) stay, as small print under the summary.
  return { ok: true, text: [result.summary, ...result.caveats.map(subtext)].join('\n') };
}

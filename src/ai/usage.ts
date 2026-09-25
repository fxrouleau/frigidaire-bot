// Per-feature attribution for OpenRouter spend.
//
// Every OpenRouter call passes `featureRequestOptions(feature)` as the OpenAI SDK's per-request options
// (the second argument of `create()`); the shared client reads the header back off the request to
// attribute that call's usage and cost to the feature. OpenRouter ignores the extra header. Calls that
// bypass the SDK (the decisions endpoint) report through recordUsage() directly.
//
// Placeholder: recordUsage() is a no-op until the usage ledger is implemented.

export const FEATURE_HEADER = 'X-Frigidaire-Feature';

export type UsageFeature =
  | 'chat'
  | 'summary'
  | 'image'
  | 'learner'
  | 'self_improvement'
  | 'emoji_caption'
  | 'embedding'
  | 'judge'
  | 'gate'
  | 'transcription'
  | 'video'
  | 'link_reader'
  | 'command'
  | 'wrapped'
  | 'birthday'
  | 'ramble'
  | 'eval'
  | 'other';

/** Per-request SDK options that tag a call with its feature. */
export function featureRequestOptions(feature: UsageFeature): { headers: Record<string, string> } {
  return { headers: { [FEATURE_HEADER]: feature } };
}

export type UsageEntry = {
  feature: UsageFeature;
  model: string;
  promptTokens?: number;
  completionTokens?: number;
  /** USD, as reported by OpenRouter. */
  cost?: number;
};

/** Records one call's usage in the ledger. */
export function recordUsage(_entry: UsageEntry): void {}

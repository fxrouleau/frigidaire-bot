// The shared auto-react instance: pending posts, the bot's recent replies and the cached reaction guide
// must be the same objects across every event handler. Built on first use with the Discord client, which
// the shadow-mode report needs.
import type { Client } from 'discord.js';
import { getMemoryStore } from '../ai/memory';
import type { EmojiRow } from '../ai/memory/memoryStore';
import { sendToReportChannel } from '../ai/reportChannel';
import { config } from '../config';
import { logger } from '../logger';
import { type AutoReactSettings, AutoReactor } from './autoReactor';
import { ReactionGuideCache, buildGuideFromArchive } from './guide';
import { loadImages } from './images';
import { createAutoReactJudge } from './judge';
import { AutoReactLedger } from './ledger';

export { AutoReactor } from './autoReactor';
export type { AutoReactSettings, Candidate, CandidateSnapshot, EvaluationOutcome } from './autoReactor';

function usableEmojis(): EmojiRow[] {
  try {
    return getMemoryStore().getUsableEmojis();
  } catch (error) {
    logger.warn('autoReact: could not read the server emoji table:', error);
    return [];
  }
}

export function autoReactSettings(): AutoReactSettings {
  const settings = config.autoReact;
  return {
    mode: settings.mode,
    maxPerDay: settings.maxPerDay,
    minGapMs: settings.minGapMinutes * 60_000,
    minProfileMessages: settings.minProfileMessages,
    delayMs: settings.delaySeconds * 1000,
    // The gate answers a member's follow-ups for this long after the bot replied to them.
    exchangeWindowMs: config.gate.enabled ? config.gate.followupSeconds * 1000 : 0,
  };
}

let shared: AutoReactor | undefined;

export function getAutoReactor(client: Client): AutoReactor {
  if (!shared) {
    const guideCache = new ReactionGuideCache({
      build: () => buildGuideFromArchive(config.autoReact.channelIds, usableEmojis(), Date.now()),
    });
    shared = new AutoReactor({
      settings: autoReactSettings,
      judge: createAutoReactJudge(),
      guide: (minReacted) => guideCache.get(minReacted),
      ledger: new AutoReactLedger(),
      emojis: usableEmojis,
      loadImages: (urls, max) => loadImages(urls, max),
      report: (text) => sendToReportChannel(client, text),
    });
  }
  return shared;
}

/** Test-only: replaces (or clears) the shared instance. */
export function setAutoReactorForTesting(reactor: AutoReactor | undefined): void {
  shared = reactor;
}

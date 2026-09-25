// The shared auto-react instance: pending posts, the bot's recent replies and the cached reaction guide
// must be the same objects across every event handler. Built on first use with the Discord client, which
// the shadow-mode report needs.
import type { Client } from 'discord.js';
import { getMemoryStore } from '../ai/memory';
import type { EmojiRow } from '../ai/memory/memoryStore';
import { sendToReportChannel } from '../ai/reportChannel';
import { config } from '../config';
import { addressedGate } from '../gate';
import { logger } from '../logger';
import { AutoReactor, type AutoReactSettings } from './autoReactor';
import { buildGuideFromArchive, ReactionGuideCache } from './guide';
import { loadImages } from './images';
import { createAutoReactJudge } from './judge';
import { AutoReactLedger } from './ledger';

export type { AutoReactSettings, Candidate, CandidateSnapshot, EvaluationOutcome } from './autoReactor';
export { AutoReactor } from './autoReactor';

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
      // Shadow-mode lines are best-effort: nothing is recorded as "reported", so there is nothing to retry.
      report: async (text) => {
        await sendToReportChannel(client, text);
      },
      // A post the agent is answering (a gate-routed follow-up included) never also gets a reaction.
      wasRouted: (messageId) => addressedGate.wasRouted(messageId),
      // Nor does one by a partner in the gate's active exchange: its follow-ups are the gate's to answer.
      inExchange: (channelId, userId) => addressedGate.isInExchange(channelId, userId),
    });
  }
  return shared;
}

/** Test-only: replaces (or clears) the shared instance. */
export function setAutoReactorForTesting(reactor: AutoReactor | undefined): void {
  shared = reactor;
}

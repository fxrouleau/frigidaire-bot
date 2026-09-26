// Runs persona scenarios through the real AgentOrchestrator: a fresh in-memory MemoryStore seeded with
// the scenario's people, emojis and memories, fake Discord messages for the channel history and the
// triggering ping, and the candidate model as the provider. The reply the bot posts is captured, measured
// and handed to the judge.
//
// Everything the bot would normally persist stays in memory: the memory store is injected per scenario,
// the agent gets no conversation persistence, and callers point bot.db and the message archive at
// ':memory:' (the CLI does). Tools whose effects leave the process are never offered (EVAL_EXCLUDED_TOOLS).
// Scenarios run one at a time because the memory store is a process-wide singleton.
import type { Message } from 'discord.js';
import { AgentOrchestrator } from '../../ai/agent';
import { setMemoryStoreForTesting } from '../../ai/memory';
import type { EmbeddingProvider } from '../../ai/memory/embeddingProvider';
import { MemoryStore, SELF_DIAGNOSIS_CATEGORIES } from '../../ai/memory/memoryStore';
import { toolDefinitions } from '../../ai/tools';
import type { AiProvider } from '../../ai/types';
import { createFakeBotMessage, createFakeMessage } from '../../test-support/fakeDiscord';
import type { Judge, JudgeVerdict } from './judge';
import { checkExpectations, measureReply } from './metrics';
import type { EvalReport, ScenarioRun } from './report';
import { summarizeRuns } from './report';
import {
  BOT_AUTHOR,
  castMember,
  type Scenario,
  type ScenarioFile,
  type ScenarioMessage,
  type SeedEmbed,
} from './scenarioFile';

/**
 * Tools the eval never offers, whatever the local .env configures: request_feature would file a real
 * GitHub issue with the owner's token, run_code would run on the local sandbox sidecar. Every other
 * tool writes only to the per-scenario memory store or the in-memory bot.db, or reads like it does in prod.
 */
export const EVAL_EXCLUDED_TOOLS: ReadonlySet<string> = new Set(['request_feature', 'run_code']);

// What the agent posts when a turn fails (src/ai/agent.ts); a reply equal to it is a failed turn.
const AGENT_ERROR_REPLY = 'Sorry, I encountered an error while processing your request.';
const MINUTE_MS = 60 * 1000;

export type RunnerDeps = {
  /** The candidate chat model as a provider (the CLI builds an OpenRouterProvider). */
  makeProvider: (model: string) => AiProvider;
  judge: Judge;
  /** Embeddings for the scenario's memory store; undefined ⇒ keyword-only retrieval. */
  makeEmbeddings?: () => EmbeddingProvider | undefined;
  /** Cumulative spend so far (USD); diffed around each turn to price it. Omit ⇒ runs are unpriced. */
  spendSoFar?: () => Promise<number>;
  log?: (line: string) => void;
  now?: () => number;
};

type Mention = { id: string; displayName: string; username: string };

/** Rewrites `<@Name>` / `<@bot>` into mention tokens and lists the people mentioned. */
function resolveMentions(file: ScenarioFile, content: string): { content: string; mentioned: Mention[] } {
  const mentioned: Mention[] = [];
  const rewritten = content.replace(/<@!?([^>\d][^>]*)>/g, (token, name: string) => {
    if (name === BOT_AUTHOR) return `<@${file.bot.id}>`;
    const member = castMember(file, name);
    if (!member) return token;
    if (!mentioned.some((m) => m.id === member.id)) {
      mentioned.push({ id: member.id, displayName: member.name, username: member.username });
    }
    return `<@${member.id}>`;
  });
  return { content: rewritten, mentioned };
}

function fakeEmbeds(embeds: SeedEmbed[]) {
  return embeds.map((e) => ({ title: e.title, description: e.description, url: e.url, imageUrl: e.imageUrl }));
}

function buildMessage(
  file: ScenarioFile,
  scenario: Scenario,
  entry: ScenarioMessage,
  messageId: string,
  createdAt: Date,
  historyNewestFirst: Message[],
) {
  const { content, mentioned } = resolveMentions(file, entry.content);
  const common = {
    content,
    messageId,
    createdAt,
    channelId: `eval-${scenario.id}`,
    botUserId: file.bot.id,
    botDisplayName: file.bot.name,
    embeds: fakeEmbeds(entry.embeds),
    mentionedUsers: mentioned,
    historyMessages: historyNewestFirst,
  };
  if (entry.author === BOT_AUTHOR) return createFakeBotMessage(common);
  const author = castMember(file, entry.author);
  return createFakeMessage({
    ...common,
    authorId: author?.id,
    authorUsername: author?.username,
    authorDisplayName: author?.name ?? entry.author,
  });
}

/** The channel as a judge reads it: relative times, mentions as @names, embeds summarized. */
export function renderTranscript(scenario: Scenario): string {
  const line = (label: string, m: Omit<ScenarioMessage, 'minutesAgo'>) => {
    const text = m.content.replace(/<@!?([^>]+)>/g, (_t, name: string) => `@${name}`).trim();
    const embeds = m.embeds.map((e) => ` [embed: ${[e.title, e.description].filter(Boolean).join(' — ')}]`).join('');
    return `[${label}] ${m.author}: ${text}${embeds}`;
  };
  const history = [...scenario.history]
    .sort((a, b) => b.minutesAgo - a.minutesAgo)
    .map((m) => line(`${m.minutesAgo} min ago`, m));
  return [...history, line('now', scenario.message)].join('\n');
}

function seedMemoriesFor(file: ScenarioFile, scenario: Scenario) {
  return [...file.sharedMemories, ...scenario.memories];
}

async function seedStore(store: MemoryStore, file: ScenarioFile, scenario: Scenario): Promise<void> {
  for (const member of file.cast) {
    store.upsertIdentity(member.id, member.name);
    store.updateIdentityMeta(member.id, { irl_name: member.irlName, aliases_add: member.aliases });
  }
  for (const emoji of file.emojis) {
    store.upsertEmoji({ id: emoji.id, name: emoji.name, animated: emoji.animated });
    if (emoji.caption) store.setEmojiCaption(emoji.id, emoji.caption);
  }
  for (const memory of seedMemoriesFor(file, scenario)) {
    await store.save({
      category: memory.category,
      subject: memory.subject,
      content: memory.content,
      source: 'persona-eval',
      subject_user_id: castMember(file, memory.subject)?.id,
    });
  }
}

/** Collects the text of everything the bot posted (reply chunks and channel.send fallbacks). */
function postedText(calls: Array<[unknown]>): string {
  return calls
    .map(([payload]) => {
      if (typeof payload === 'string') return payload;
      if (payload && typeof payload === 'object' && 'content' in payload) {
        const content = (payload as { content?: unknown }).content;
        return typeof content === 'string' ? content : '';
      }
      return '';
    })
    .filter((text) => text.length > 0)
    .join('\n');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Runs one scenario against one model: seed, ping the real orchestrator, capture, measure, judge. */
export async function runScenario(
  file: ScenarioFile,
  scenario: Scenario,
  model: string,
  deps: RunnerDeps,
): Promise<ScenarioRun> {
  const now = deps.now?.() ?? Date.now();
  const store = new MemoryStore(':memory:', { embeddings: deps.makeEmbeddings?.() });
  setMemoryStoreForTesting(store);

  try {
    await seedStore(store, file, scenario);
    const storedMemories = seedMemoriesFor(file, scenario).map((m) => `${m.subject}: ${m.content}`);

    // Discord hands history back newest first; the agent reverses it.
    const historyNewestFirst: Message[] = [];
    const chronological = [...scenario.history].sort((a, b) => b.minutesAgo - a.minutesAgo);
    chronological.forEach((entry, i) => {
      const createdAt = new Date(now - entry.minutesAgo * MINUTE_MS);
      historyNewestFirst.unshift(buildMessage(file, scenario, entry, `history-${i}`, createdAt, []).message);
    });
    const trigger = buildMessage(
      file,
      scenario,
      { ...scenario.message, minutesAgo: 0 },
      'trigger',
      new Date(now),
      historyNewestFirst,
    );

    // Delegating wrapper: records the host tools the model calls and any provider failure.
    const inner = deps.makeProvider(model);
    const toolCalls: string[] = [];
    let providerError: unknown;
    const provider: AiProvider = {
      id: inner.id,
      defaultModel: inner.defaultModel,
      // Hidden from the model (the provider's list is what it sees) AND unhandled by the agent below.
      supportedTools: inner.supportedTools.filter((tool) => !EVAL_EXCLUDED_TOOLS.has(tool.name)),
      chat: async (input) => {
        try {
          const response = await inner.chat(input);
          toolCalls.push(...response.toolCalls.map((call) => call.name));
          return response;
        } catch (error) {
          providerError = error;
          throw error;
        }
      },
      generateImage: inner.generateImage?.bind(inner),
    };
    const agent = new AgentOrchestrator({
      resolveProvider: () => provider,
      tools: toolDefinitions.filter((tool) => !EVAL_EXCLUDED_TOOLS.has(tool.name)),
    });

    const spendBefore = await deps.spendSoFar?.();
    const started = Date.now();
    await agent.handleMention(trigger.message);
    const durationMs = Date.now() - started;
    const spendAfter = await deps.spendSoFar?.();

    const reply = postedText([...trigger.recorders.reply.calls, ...trigger.recorders.send.calls]);
    const error =
      providerError !== undefined
        ? errorMessage(providerError)
        : reply.trim() === AGENT_ERROR_REPLY
          ? 'the bot posted its error reply'
          : undefined;

    const activeMemories = store
      .getAllActive()
      .filter((m) => !(SELF_DIAGNOSIS_CATEGORIES as readonly string[]).includes(m.category))
      .map((m) => `${m.subject}: ${m.content}`);
    const metrics = measureReply(reply, [scenario.message.author]);
    const checks = checkExpectations(reply, metrics, scenario.expectations, activeMemories);

    let judge: JudgeVerdict | undefined;
    let judgeError: string | undefined;
    if (error === undefined && reply.trim().length > 0) {
      try {
        judge = await deps.judge({
          botName: file.bot.name,
          scenarioTitle: scenario.title,
          intent: scenario.expectations.notes,
          transcript: renderTranscript(scenario),
          storedMemories,
          reply,
        });
      } catch (judgeFailure) {
        judgeError = errorMessage(judgeFailure);
      }
    }

    return {
      model,
      scenarioId: scenario.id,
      title: scenario.title,
      reply,
      error,
      durationMs,
      costUsd: spendBefore !== undefined && spendAfter !== undefined ? spendAfter - spendBefore : undefined,
      toolCalls,
      metrics,
      checks,
      judge,
      judgeError,
    };
  } finally {
    setMemoryStoreForTesting(undefined);
    store.close();
  }
}

export type PersonaEvalOptions = {
  file: ScenarioFile;
  scenarios: Scenario[];
  models: string[];
  judgeModel: string;
  deps: RunnerDeps;
};

/** Every scenario against every model, sequentially, plus the per-model summary. */
export async function runPersonaEval(opts: PersonaEvalOptions): Promise<EvalReport> {
  const startedAt = new Date().toISOString();
  const runs: ScenarioRun[] = [];
  const log = opts.deps.log ?? (() => {});

  for (const model of opts.models) {
    for (const [index, scenario] of opts.scenarios.entries()) {
      log(`[${model}] ${index + 1}/${opts.scenarios.length} ${scenario.id}`);
      const run = await runScenario(opts.file, scenario, model, opts.deps);
      const failed = run.checks.filter((c) => !c.passed).map((c) => c.name);
      log(
        `  → ${run.error ? `ERROR: ${run.error}` : JSON.stringify(run.reply.slice(0, 160))}${
          failed.length > 0 ? ` | failed: ${failed.join(', ')}` : ''
        }${run.judgeError ? ` | judge error: ${run.judgeError}` : ''}`,
      );
      runs.push(run);
    }
  }

  return {
    version: 1,
    startedAt,
    finishedAt: new Date().toISOString(),
    judgeModel: opts.judgeModel,
    models: opts.models,
    scenarioIds: opts.scenarios.map((s) => s.id),
    runs,
    summary: summarizeRuns(runs, opts.models),
  };
}

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeMessage } from '../test-support/fakeDiscord';
import { FakeProvider, errorStep, textResponse, toolCallResponse } from '../test-support/fakeProvider';
import { AgentOrchestrator } from './agent';
import { loadErrorCapture } from './debugCapture';
import { MemoryStore } from './memory/memoryStore';
import { getMemoryStore, setMemoryStoreForTesting } from './tools';
import type { ConversationEntry, ToolDefinition } from './types';

const echoTool: ToolDefinition = {
  name: 'echo_tool',
  description: 'Echo tool for tests',
  parameters: { type: 'object', properties: { text: { type: 'string' } } },
  handler: async () => 'echo result',
};

const throwingTool: ToolDefinition = {
  name: 'echo_tool',
  description: 'Echo tool that throws',
  parameters: { type: 'object', properties: {} },
  handler: async () => {
    throw new Error('tool blew up');
  },
};

function makeOrchestrator(
  provider: FakeProvider,
  opts: { tools?: ToolDefinition[]; timeoutMs?: number; maxToolRounds?: number; maxToolInvocations?: number } = {},
): AgentOrchestrator {
  return new AgentOrchestrator({
    resolveProvider: () => provider,
    tools: opts.tools ?? [echoTool],
    timeoutMs: opts.timeoutMs ?? 60_000,
    maxToolRounds: opts.maxToolRounds,
    maxToolInvocations: opts.maxToolInvocations,
  });
}

function toolResultEntries(messages: ConversationEntry[]): Array<Extract<ConversationEntry, { kind: 'tool_result' }>> {
  return messages.filter((e): e is Extract<ConversationEntry, { kind: 'tool_result' }> => e.kind === 'tool_result');
}

beforeEach(() => {
  setMemoryStoreForTesting(new MemoryStore(':memory:'));
});

afterEach(() => {
  setMemoryStoreForTesting(undefined);
  vi.unstubAllEnvs();
});

describe('AgentOrchestrator.handleMention', () => {
  it('handles a text-only response', async () => {
    const provider = new FakeProvider([textResponse('Hi')]);
    const orchestrator = makeOrchestrator(provider);
    const fake = createFakeMessage({ content: 'hello' });

    await orchestrator.handleMention(fake.message);

    expect(provider.calls).toHaveLength(1);
    expect(fake.recorders.reply.calls).toContainEqual(['Hi']);
    expect(fake.recorders.sendTyping.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('executes a single tool round then replies', async () => {
    const provider = new FakeProvider([
      toolCallResponse([{ id: 't1', name: 'echo_tool', arguments: {} }]),
      textResponse('Done'),
    ]);
    const orchestrator = makeOrchestrator(provider);
    const fake = createFakeMessage({ content: 'do the thing' });

    await orchestrator.handleMention(fake.message);

    expect(provider.calls).toHaveLength(2);
    const results = toolResultEntries(provider.calls[1].messages);
    expect(results).toContainEqual({ kind: 'tool_result', id: 't1', name: 'echo_tool', content: 'echo result' });
    expect(fake.recorders.reply.calls).toContainEqual(['Done']);
  });

  it('executes two tool rounds then replies with the final text', async () => {
    const provider = new FakeProvider([
      toolCallResponse([{ id: 't1', name: 'echo_tool', arguments: {} }]),
      toolCallResponse([{ id: 't2', name: 'echo_tool', arguments: {} }]),
      textResponse('All done'),
    ]);
    const orchestrator = makeOrchestrator(provider);
    const fake = createFakeMessage({ content: 'two rounds' });

    await orchestrator.handleMention(fake.message);

    expect(provider.calls).toHaveLength(3);
    expect(fake.recorders.reply.calls).toContainEqual(['All done']);
  });

  it('forces a text-only response when maxToolRounds is reached', async () => {
    const provider = new FakeProvider([
      toolCallResponse([{ id: 't1', name: 'echo_tool', arguments: {} }]),
      toolCallResponse([{ id: 't2', name: 'echo_tool', arguments: {} }]),
      toolCallResponse([{ id: 't3', name: 'echo_tool', arguments: {} }]),
      textResponse('forced'),
    ]);
    const orchestrator = makeOrchestrator(provider, { maxToolRounds: 2 });
    const fake = createFakeMessage({ content: 'spam tools' });

    await orchestrator.handleMention(fake.message);

    expect(provider.calls).toHaveLength(4);
    expect(provider.calls[3].toolChoice).toBe('none');
    expect(fake.recorders.reply.calls).toContainEqual(['forced']);
  });

  it('forces a text-only response when maxToolInvocations is exceeded', async () => {
    const provider = new FakeProvider([
      toolCallResponse([
        { id: 't1', name: 'echo_tool', arguments: {} },
        { id: 't2', name: 'echo_tool', arguments: {} },
      ]),
      toolCallResponse([{ id: 't3', name: 'echo_tool', arguments: {} }]),
      textResponse('forced'),
    ]);
    const orchestrator = makeOrchestrator(provider, { maxToolInvocations: 2 });
    const fake = createFakeMessage({ content: 'too many tools' });

    await orchestrator.handleMention(fake.message);

    // First response: 2 invocations (== limit, not exceeded). Round response: 1 more -> 3 > 2, forces text.
    const forcedCall = provider.calls[provider.calls.length - 1];
    expect(forcedCall.toolChoice).toBe('none');
    expect(fake.recorders.reply.calls).toContainEqual(['forced']);
  });

  it('returns a "not supported" tool result and logs a capability gap for an unknown tool', async () => {
    // The provider advertises unknown_tool as host-handled, but the orchestrator has no handler for
    // it — that's the gap the orchestrator must report.
    const provider = new FakeProvider(
      [toolCallResponse([{ id: 't1', name: 'unknown_tool', arguments: {} }]), textResponse('ok')],
      {
        supportedTools: [
          { name: 'unknown_tool', type: 'function', description: 'no handler', hostHandled: true },
        ],
      },
    );
    const orchestrator = makeOrchestrator(provider);
    const fake = createFakeMessage({ content: 'use a missing tool' });

    await orchestrator.handleMention(fake.message);

    const results = toolResultEntries(provider.calls[1].messages);
    expect(results.some((r) => r.content.includes('not supported'))).toBe(true);
    expect(getMemoryStore().getByCategory('capability_gap').length).toBeGreaterThan(0);
  });

  it('returns a "failed to run" tool result and logs a tool error when the handler throws', async () => {
    const provider = new FakeProvider([
      toolCallResponse([{ id: 't1', name: 'echo_tool', arguments: {} }]),
      textResponse('ok'),
    ]);
    const orchestrator = makeOrchestrator(provider, { tools: [throwingTool] });
    const fake = createFakeMessage({ content: 'break the tool' });

    await orchestrator.handleMention(fake.message);

    const results = toolResultEntries(provider.calls[1].messages);
    expect(results.some((r) => r.content.includes('failed to run'))).toBe(true);
    expect(getMemoryStore().getByCategory('tool_error').length).toBeGreaterThan(0);
  });

  it('writes an error capture when the provider throws', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-'));
    vi.stubEnv('DEBUG_CAPTURE_DIR', dir);

    const provider = new FakeProvider([errorStep('boom')]);
    const orchestrator = makeOrchestrator(provider);
    const fake = createFakeMessage({ content: 'trigger error' });

    await orchestrator.handleMention(fake.message);

    expect(fake.recorders.reply.calls.some(([arg]) => typeof arg === 'string' && /encountered an error/.test(arg))).toBe(
      true,
    );

    const captureFiles = fs.readdirSync(dir).filter((f) => f.startsWith('error-') && f.endsWith('.json'));
    expect(captureFiles).toHaveLength(1);

    const capture = loadErrorCapture(path.join(dir, captureFiles[0]));
    expect(capture.error.message).toBe('boom');
    expect(capture.conversationEntries.length).toBeGreaterThan(0);
  });

  it('handles an empty final text and logs a parse failure', async () => {
    const provider = new FakeProvider([{ text: undefined, toolCalls: [], outputEntries: [] }]);
    const orchestrator = makeOrchestrator(provider);
    const fake = createFakeMessage({ content: 'say nothing' });

    await orchestrator.handleMention(fake.message);

    expect(
      fake.recorders.reply.calls.some(([arg]) => typeof arg === 'string' && /further to add/.test(arg)),
    ).toBe(true);
    expect(getMemoryStore().getByCategory('parse_failure').length).toBeGreaterThan(0);
  });

  it('splits a long response into multiple replies', async () => {
    const provider = new FakeProvider([textResponse('a'.repeat(2500))]);
    const orchestrator = makeOrchestrator(provider);
    const fake = createFakeMessage({ content: 'long please' });

    await orchestrator.handleMention(fake.message);

    expect(fake.recorders.reply.calls).toHaveLength(2);
  });

  it('falls back to channel.send when reply throws a 50035 error', async () => {
    const provider = new FakeProvider([textResponse('via send')]);
    const orchestrator = makeOrchestrator(provider);
    const fake = createFakeMessage({
      content: 'reply will fail',
      replyImpl: async () => {
        throw Object.assign(new Error('no reply'), { code: 50035 });
      },
    });

    await orchestrator.handleMention(fake.message);

    expect(fake.recorders.send.calls).toContainEqual(['via send']);
  });

  it('reuses conversation state across mentions in the same channel', async () => {
    const provider = new FakeProvider([textResponse('first'), textResponse('second')]);
    const orchestrator = makeOrchestrator(provider);
    const fake1 = createFakeMessage({ content: 'first message', channelId: 'shared', messageId: 'm1' });
    const fake2 = createFakeMessage({ content: 'second message', channelId: 'shared', messageId: 'm2' });

    await orchestrator.handleMention(fake1.message);
    await orchestrator.handleMention(fake2.message);

    // History is only fetched on the first mention.
    expect(fake1.recorders.messagesFetch.calls).toHaveLength(1);
    expect(fake2.recorders.messagesFetch.calls).toHaveLength(0);
    // The second call carries more history than the first.
    expect(provider.calls[1].messages.length).toBeGreaterThan(provider.calls[0].messages.length);
  });

  it('refetches history after the conversation expires', async () => {
    const provider = new FakeProvider([textResponse('first'), textResponse('second')]);
    const orchestrator = makeOrchestrator(provider, { timeoutMs: 1 });
    const fake1 = createFakeMessage({ content: 'first message', channelId: 'expiring', messageId: 'm1' });
    const fake2 = createFakeMessage({ content: 'second message', channelId: 'expiring', messageId: 'm2' });

    await orchestrator.handleMention(fake1.message);
    await new Promise((r) => setTimeout(r, 10));
    await orchestrator.handleMention(fake2.message);

    expect(fake1.recorders.messagesFetch.calls).toHaveLength(1);
    expect(fake2.recorders.messagesFetch.calls).toHaveLength(1);
  });
});

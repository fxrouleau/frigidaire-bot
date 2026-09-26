import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConversationEndTrigger, IntervalCaptureTrigger } from './captureTrigger';

const MIN = 60_000;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('IntervalCaptureTrigger', () => {
  it('makes every channel with activity due at the next tick, once', () => {
    const trigger = new IntervalCaptureTrigger(30 * MIN);
    expect(trigger.tickMs).toBe(1_800_000);
    expect(trigger.describe()).toBe('every 30m');
    trigger.noteActivity({ channelId: 'a', at: 1 });
    trigger.noteActivity({ channelId: 'b', at: 2 });
    trigger.noteActivity({ channelId: 'a', at: 3 });
    expect(trigger.takeDue(10)).toEqual(['a', 'b']);
    expect(trigger.takeDue(20)).toEqual([]);
    trigger.noteActivity({ channelId: 'b', at: 30 });
    expect(trigger.takeDue(40)).toEqual(['b']);
  });

  it('reads a backlog channel at the next tick', () => {
    const trigger = new IntervalCaptureTrigger(30 * MIN);
    trigger.noteBacklog('a', 5);
    expect(trigger.takeDue(10)).toEqual(['a']);
  });
});

describe('ConversationEndTrigger', () => {
  const trigger = (opts: { minMessages?: number } = {}) =>
    new ConversationEndTrigger({ idleMs: 20 * MIN, maxSpanMs: 120 * MIN, minMessages: opts.minMessages ?? 3 });

  /** `count` messages in `channelId`, one a minute from `start`. */
  function talk(t: ConversationEndTrigger, channelId: string, start: number, count: number): number {
    for (let i = 0; i < count; i++) t.noteActivity({ channelId, at: start + i * MIN });
    return start + (count - 1) * MIN;
  }

  it('reads its settings from config and ticks every minute', () => {
    vi.stubEnv('CAPTURE_IDLE_MINUTES', '15');
    vi.stubEnv('CAPTURE_MAX_SPAN_MINUTES', '90');
    vi.stubEnv('MIN_MESSAGES_FOR_OBSERVATION', '4');
    const t = new ConversationEndTrigger();
    expect([t.idleMs, t.maxSpanMs, t.minMessages, t.tickMs]).toEqual([15 * MIN, 90 * MIN, 4, MIN]);
    expect(t.describe()).toBe('conversation end (idle 15m, span 90m, min 4 messages, tick 1m)');
    expect(new ConversationEndTrigger({ maxSpanMs: 120 * MIN }).describe()).toContain('span 2h');
  });

  it('waits for the conversation to go quiet', () => {
    const t = trigger();
    const last = talk(t, 'general', 0, 5);
    expect(t.takeDue(last + 19 * MIN)).toEqual([]);
    expect(t.takeDue(last + 20 * MIN)).toEqual(['general']);
    // Taken: forgotten until new activity.
    expect(t.takeDue(last + 60 * MIN)).toEqual([]);
  });

  it('keeps a quiet channel below the minimum pending until enough messages arrive', () => {
    const t = trigger({ minMessages: 5 });
    const last = talk(t, 'general', 0, 4);
    expect(t.takeDue(last + 6 * 60 * MIN)).toEqual([]);
    t.noteActivity({ channelId: 'general', at: last + 7 * 60 * MIN });
    expect(t.takeDue(last + 7 * 60 * MIN + 20 * MIN)).toEqual(['general']);
  });

  it('reads a conversation that never pauses once its oldest message is the max span old', () => {
    const t = trigger();
    // A message every 5 minutes for over four hours: never 20 minutes of quiet.
    const takes: number[] = [];
    for (let at = 0; at <= 250 * MIN; at += 5 * MIN) {
      if (t.takeDue(at).length > 0) takes.push(at / MIN);
      t.noteActivity({ channelId: 'general', at });
    }
    // The span restarts from the first message after each take.
    expect(takes).toEqual([120, 240]);
  });

  it('counts activity after a take toward the next capture', () => {
    const t = trigger();
    const last = talk(t, 'general', 0, 3);
    expect(t.takeDue(last + 20 * MIN)).toEqual(['general']);
    talk(t, 'general', last + 21 * MIN, 2);
    expect(t.takeDue(last + 60 * MIN)).toEqual([]);
    t.noteActivity({ channelId: 'general', at: last + 61 * MIN });
    expect(t.takeDue(last + 81 * MIN)).toEqual(['general']);
  });

  it('hands out several due channels oldest conversation first', () => {
    const t = trigger();
    talk(t, 'late', 10 * MIN, 3);
    talk(t, 'early', 0, 3);
    talk(t, 'busy', 30 * MIN, 3);
    t.noteActivity({ channelId: 'busy', at: 60 * MIN });
    expect(t.takeDue(45 * MIN)).toEqual(['early', 'late']);
    expect(t.takeDue(80 * MIN)).toEqual(['busy']);
  });

  it('tracks out-of-order activity by when it was posted', () => {
    const t = trigger();
    t.noteActivity({ channelId: 'general', at: 10 * MIN });
    t.noteActivity({ channelId: 'general', at: 2 * MIN });
    t.noteActivity({ channelId: 'general', at: 5 * MIN });
    // Quiet since 10 min, the oldest at 2 min: not due at 29 min, due at 30.
    expect(t.takeDue(29 * MIN)).toEqual([]);
    expect(t.takeDue(30 * MIN)).toEqual(['general']);
  });

  it('reads a backlog without a message count once the channel has been quiet', () => {
    const t = trigger({ minMessages: 5 });
    t.noteBacklog('general', 0);
    expect(t.takeDue(19 * MIN)).toEqual([]);
    expect(t.takeDue(20 * MIN)).toEqual(['general']);
  });

  it('lets a backlog wait for a running conversation to end, whatever its size', () => {
    const t = trigger({ minMessages: 5 });
    t.noteBacklog('general', 0);
    t.noteActivity({ channelId: 'general', at: 15 * MIN });
    expect(t.takeDue(30 * MIN)).toEqual([]);
    expect(t.takeDue(35 * MIN)).toEqual(['general']);
  });
});

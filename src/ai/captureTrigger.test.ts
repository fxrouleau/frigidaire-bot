import { describe, expect, it } from 'vitest';
import { IntervalCaptureTrigger } from './captureTrigger';

describe('IntervalCaptureTrigger', () => {
  it('makes every channel with activity due at the next tick, once', () => {
    const trigger = new IntervalCaptureTrigger(30 * 60_000);
    expect(trigger.tickMs).toBe(1_800_000);
    expect(trigger.describe()).toBe('every 1800s');
    trigger.noteActivity({ channelId: 'a', at: 1 });
    trigger.noteActivity({ channelId: 'b', at: 2 });
    trigger.noteActivity({ channelId: 'a', at: 3 });
    expect(trigger.takeDue(10)).toEqual(['a', 'b']);
    expect(trigger.takeDue(20)).toEqual([]);
    trigger.noteActivity({ channelId: 'b', at: 30 });
    expect(trigger.takeDue(40)).toEqual(['b']);
  });
});

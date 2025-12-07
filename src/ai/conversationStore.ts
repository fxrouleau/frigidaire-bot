import type { ConversationEntry } from './types';

export type ConversationState = {
  providerId: string;
  entries: ConversationEntry[];
  timestamp: number;
  thoughts?: unknown;
};

export class ConversationStore {
  private readonly store = new Map<string, ConversationState>();

  constructor(private readonly timeoutMs: number) {}

  get(channelId: string): ConversationState | undefined {
    const state = this.store.get(channelId);
    if (!state) return undefined;

    if (Date.now() - state.timestamp > this.timeoutMs) {
      this.store.delete(channelId);
      return undefined;
    }

    return state;
  }

  set(channelId: string, state: ConversationState) {
    this.store.set(channelId, state);
  }

  update(channelId: string, entries: ConversationEntry[]) {
    const existing = this.get(channelId);
    if (!existing) return;
    this.store.set(channelId, { ...existing, entries, timestamp: Date.now() });
  }

  touch(channelId: string) {
    const existing = this.get(channelId);
    if (!existing) return;
    this.store.set(channelId, { ...existing, timestamp: Date.now() });
  }

  switchProvider(channelId: string, providerId: string) {
    const existing = this.get(channelId);
    if (!existing) return;
    this.store.set(channelId, { ...existing, providerId, timestamp: Date.now() });
  }

  pruneExpired() {
    for (const [channelId, state] of this.store.entries()) {
      if (Date.now() - state.timestamp > this.timeoutMs) {
        this.store.delete(channelId);
      }
    }
  }
}

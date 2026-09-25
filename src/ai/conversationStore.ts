import type { ConversationPersistence } from './conversationPersistence';
import type { ConversationEntry } from './types';

export type ConversationState = {
  entries: ConversationEntry[];
  timestamp: number;
  // Ids of memories already injected into this window's prompt (static seed + every dynamic turn),
  // so a memory rendered once isn't repeated on later turns. Plain number[] — kept JSON-serializable
  // on purpose (conversation state is persisted across restarts).
  injectedMemoryIds?: number[];
  // Discord id of the newest message this window has accounted for (the last triggering message). The
  // next turn fetches what was said after it, so the bot isn't blind to the chat between two pings.
  lastSeenMessageId?: string;
};

export class ConversationStore {
  private readonly store = new Map<string, ConversationState>();

  // Optional disk-backed mirror so conversations survive a restart within the timeout window. The Map
  // above stays the source of truth; every persistence call is best-effort and degrades silently to
  // pure in-memory behavior on failure.
  constructor(
    private readonly timeoutMs: number,
    private readonly persistence?: ConversationPersistence,
  ) {
    this.restore();
  }

  /** Seeds the Map from persisted state (after pruning expired rows). Best-effort; never throws. */
  private restore() {
    if (!this.persistence) return;
    try {
      this.persistence.pruneExpired(this.timeoutMs);
      for (const [channelId, state] of this.persistence.loadAll(this.timeoutMs)) {
        this.store.set(channelId, state);
      }
    } catch {
      // A corrupt/unavailable cache DB must never stop the bot from chatting.
    }
  }

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
    this.persist(channelId, state);
  }

  pruneExpired() {
    for (const [channelId, state] of this.store.entries()) {
      if (Date.now() - state.timestamp > this.timeoutMs) {
        this.store.delete(channelId);
      }
    }
    try {
      this.persistence?.pruneExpired(this.timeoutMs);
    } catch {
      // Best-effort: the Map prune above already happened.
    }
  }

  close() {
    this.persistence?.close();
  }

  /** Write-through to the disk mirror, swallowing any failure (Map is the source of truth). */
  private persist(channelId: string, state: ConversationState) {
    try {
      this.persistence?.save(channelId, state);
    } catch {
      // Best-effort: a persistence failure degrades to pure in-memory behavior.
    }
  }
}

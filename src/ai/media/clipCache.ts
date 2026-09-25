// A small, short-lived in-memory cache of downloaded video clips, so a follow-up question about a video
// ("what does he say at the end?") right after it was described doesn't download it again. Bounded by
// entry count, total bytes and age: a clip is up to 50 MB, and this runs on a small VPS.
export type CachedClip = { data: Buffer; contentType?: string };

export type ClipCacheOptions = {
  maxEntries?: number;
  maxBytes?: number;
  ttlMs?: number;
  now?: () => number;
};

export class ClipCache {
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  // Insertion-ordered: the first entry is the least recently used.
  private readonly entries = new Map<string, CachedClip & { at: number }>();

  constructor(opts: ClipCacheOptions = {}) {
    this.maxEntries = opts.maxEntries ?? 3;
    this.maxBytes = opts.maxBytes ?? 64 * 1024 * 1024;
    this.ttlMs = opts.ttlMs ?? 10 * 60 * 1000;
    this.now = opts.now ?? Date.now;
  }

  get(key: string): CachedClip | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (this.now() - entry.at > this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    // Refresh recency (not age: a clip still expires ttlMs after it was downloaded).
    this.entries.delete(key);
    this.entries.set(key, entry);
    return { data: entry.data, contentType: entry.contentType };
  }

  set(key: string, clip: CachedClip): void {
    if (clip.data.byteLength > this.maxBytes) return;
    this.entries.delete(key);
    this.entries.set(key, { ...clip, at: this.now() });
    this.evict();
  }

  get size(): number {
    return this.entries.size;
  }

  private evict(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) if (now - entry.at > this.ttlMs) this.entries.delete(key);
    let total = 0;
    for (const entry of this.entries.values()) total += entry.data.byteLength;
    for (const [key, entry] of this.entries) {
      if (this.entries.size <= this.maxEntries && total <= this.maxBytes) break;
      this.entries.delete(key);
      total -= entry.data.byteLength;
    }
  }
}

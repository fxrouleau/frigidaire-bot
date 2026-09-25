// Carrying a message's attachments over to its webhook repost. The original is deleted after the
// repost, and Discord drops the files with it, so every attachment is downloaded and re-uploaded —
// or the repost doesn't happen at all: losing someone's image to fix an embed is worse than a broken embed.
import { logger } from '../logger';

/** What the repost needs from a discord.js Attachment. */
export type AttachmentSource = { url: string; name: string; size: number; description?: string | null };

/** A downloaded attachment, in the shape webhook.send({ files }) takes. `SPOILER_` names stay spoilered. */
export type CarriedAttachment = { attachment: Buffer; name: string; description?: string };

export type CarryResult = { ok: true; files: CarriedAttachment[] } | { ok: false; reason: string };

export type CarryOptions = {
  fetch: typeof globalThis.fetch;
  maxTotalBytes: number;
  timeoutMs?: number;
};

const DOWNLOAD_TIMEOUT_MS = 15_000;

export function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The body is being discarded anyway.
  }
}

/** Reads the body, giving up (undefined) as soon as it grows past `limit` instead of buffering it all. */
async function readCapped(response: Response, limit: number): Promise<Buffer | undefined> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    await cancelBody(response);
    return undefined;
  }
  if (!response.body) return Buffer.alloc(0);

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

async function downloadOne(
  source: AttachmentSource,
  limit: number,
  fetchFn: typeof globalThis.fetch,
  timeoutMs: number,
): Promise<CarriedAttachment | string> {
  try {
    const response = await fetchFn(source.url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) {
      await cancelBody(response);
      return `${source.name} answered HTTP ${response.status}`;
    }
    const data = await readCapped(response, limit);
    if (!data) return `${source.name} is larger than ${formatMegabytes(limit)}`;
    return source.description
      ? { attachment: data, name: source.name, description: source.description }
      : { attachment: data, name: source.name };
  } catch (error) {
    return `${source.name} failed to download (${error instanceof Error ? error.message : String(error)})`;
  }
}

/**
 * Downloads every attachment, or explains why the set can't be carried over: over the total size cap
 * (checked on Discord's declared sizes before any download, then on the real bytes), a failed or
 * timed-out download. All or nothing — a partial repost would silently lose files.
 */
export async function downloadAttachments(sources: AttachmentSource[], options: CarryOptions): Promise<CarryResult> {
  if (sources.length === 0) return { ok: true, files: [] };

  const declared = sources.reduce((sum, source) => sum + source.size, 0);
  if (declared > options.maxTotalBytes) {
    return {
      ok: false,
      reason: `attachments total ${formatMegabytes(declared)}, over the ${formatMegabytes(options.maxTotalBytes)} repost cap`,
    };
  }

  const timeoutMs = options.timeoutMs ?? DOWNLOAD_TIMEOUT_MS;
  const results = await Promise.all(
    sources.map((source) => downloadOne(source, options.maxTotalBytes, options.fetch, timeoutMs)),
  );
  const failure = results.find((result): result is string => typeof result === 'string');
  if (failure !== undefined) return { ok: false, reason: failure };

  const files = results as CarriedAttachment[];
  const total = files.reduce((sum, file) => sum + file.attachment.byteLength, 0);
  if (total > options.maxTotalBytes) {
    logger.warn(`linkfix: attachments declared ${declared} bytes but downloaded ${total}`);
    return {
      ok: false,
      reason: `attachments total ${formatMegabytes(total)}, over the ${formatMegabytes(options.maxTotalBytes)} repost cap`,
    };
  }
  return { ok: true, files };
}

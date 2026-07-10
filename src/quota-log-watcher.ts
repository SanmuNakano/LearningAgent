import { promises as fs } from "node:fs";
import type { QuotaLogCursor, QuotaLogSource } from "./quota.js";

export const DEFAULT_QUOTA_LOG_READ_BYTES = 256 * 1024;

export type QuotaLogPollResult = {
  sourceId: string;
  lines: string[];
  cursor: QuotaLogCursor;
  rotated: boolean;
  skippedBytes: number;
};

export function isQuotaSignalCandidate(line: string): boolean {
  return /codex|usage|quota|rate.?limit|credit|额度|配额|限额|使用限制|速率限制/i.test(line);
}

export async function pollQuotaLogSource(
  source: QuotaLogSource,
  previous?: QuotaLogCursor,
  maxBytes = DEFAULT_QUOTA_LOG_READ_BYTES
): Promise<QuotaLogPollResult> {
  const now = new Date().toISOString();
  const priorOffset = Math.max(0, previous?.offset ?? 0);
  try {
    const stat = await fs.stat(source.file);
    const fileId = `${stat.dev}:${stat.ino}`;
    const rotated = stat.size < priorOffset || Boolean(previous?.fileId && previous.fileId !== fileId);
    const logicalOffset = rotated ? 0 : priorOffset;
    const start = Math.max(logicalOffset, stat.size - maxBytes);
    const skippedBytes = Math.max(0, start - logicalOffset);
    if (stat.size <= start) {
      return {
        sourceId: source.id,
        lines: [],
        rotated,
        skippedBytes,
        cursor: { sourceId: source.id, fileId, offset: start, size: stat.size, updatedAt: now }
      };
    }

    const length = Math.min(maxBytes, stat.size - start);
    const handle = await fs.open(source.file, "r");
    let buffer: Buffer;
    try {
      buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, start);
      buffer = buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }

    let contentStart = 0;
    if (skippedBytes > 0) {
      const firstNewline = buffer.indexOf(10);
      if (firstNewline < 0) {
        return {
          sourceId: source.id,
          lines: [],
          rotated,
          skippedBytes: skippedBytes + buffer.length,
          cursor: { sourceId: source.id, fileId, offset: start + buffer.length, size: stat.size, updatedAt: now, lastError: "Skipped an overlong log line.", lastErrorAt: now }
        };
      }
      contentStart = firstNewline + 1;
    }

    const lastNewline = buffer.lastIndexOf(10);
    if (lastNewline < contentStart) {
      return {
        sourceId: source.id,
        lines: [],
        rotated,
        skippedBytes,
        cursor: { sourceId: source.id, fileId, offset: start, size: stat.size, updatedAt: now }
      };
    }

    const lines = buffer.subarray(contentStart, lastNewline)
      .toString("utf-8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    return {
      sourceId: source.id,
      lines,
      rotated,
      skippedBytes,
      cursor: { sourceId: source.id, fileId, offset: start + lastNewline + 1, size: stat.size, updatedAt: now }
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      sourceId: source.id,
      lines: [],
      rotated: false,
      skippedBytes: 0,
      cursor: {
        sourceId: source.id,
        fileId: previous?.fileId,
        offset: priorOffset,
        size: previous?.size ?? 0,
        updatedAt: now,
        lastError: message.slice(0, 500),
        lastErrorAt: now
      }
    };
  }
}

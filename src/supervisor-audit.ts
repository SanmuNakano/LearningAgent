import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { AuditLogEntry, AuditLogQuery, AuditRetentionResult } from "./supervisor-types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseEntry(line: string): AuditLogEntry | undefined {
  try {
    const value: unknown = JSON.parse(line);
    if (!isRecord(value) || typeof value.event !== "string" || typeof value.at !== "string") return undefined;
    if (!Number.isFinite(Date.parse(value.at))) return undefined;
    return { event: value.event, at: value.at, payload: value.payload };
  } catch {
    return undefined;
  }
}

function parseBoundary(value: string | undefined, name: string): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`Audit ${name} must be a valid date or timestamp.`);
  return parsed;
}

export class AuditLogService {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly retentionDays: number,
    private readonly maxEntries: number
  ) {}

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.queue;
    let release: () => void = () => {};
    this.queue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async append(event: string, payload: unknown): Promise<void> {
    await this.exclusive(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await fs.appendFile(this.file, `${JSON.stringify({ event, at: new Date().toISOString(), payload })}\n`, "utf-8");
    });
  }

  async query(query: AuditLogQuery = {}): Promise<AuditLogEntry[]> {
    const from = parseBoundary(query.from, "from");
    const to = parseBoundary(query.to, "to");
    if (from !== undefined && to !== undefined && from > to) throw new Error("Audit from must not be after to.");
    const limit = Math.min(Math.max(Math.floor(query.limit ?? 50), 1), 200);
    return await this.exclusive(async () => {
      let raw: string;
      try {
        raw = await fs.readFile(this.file, "utf-8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
      const entries = raw.split(/\r?\n/).filter(Boolean).flatMap((line) => {
        const entry = parseEntry(line);
        return entry ? [entry] : [];
      });
      return entries.reverse().filter((entry) => {
        const timestamp = Date.parse(entry.at);
        return (!query.event || entry.event === query.event)
          && (from === undefined || timestamp >= from)
          && (to === undefined || timestamp <= to);
      }).slice(0, limit);
    });
  }

  async prune(now = new Date()): Promise<AuditRetentionResult> {
    return await this.exclusive(async () => {
      let raw: string;
      try {
        raw = await fs.readFile(this.file, "utf-8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return { file: this.file, before: 0, after: 0, removed: 0, cutoffAt: new Date(now.getTime() - this.retentionDays * 86_400_000).toISOString() };
        }
        throw error;
      }
      const cutoff = now.getTime() - this.retentionDays * 86_400_000;
      const lines = raw.split(/\r?\n/).filter(Boolean);
      const recent = lines.filter((line) => {
        const entry = parseEntry(line);
        return !entry || Date.parse(entry.at) >= cutoff;
      }).slice(-this.maxEntries);
      if (recent.length !== lines.length) {
        await fs.mkdir(path.dirname(this.file), { recursive: true });
        const tempFile = `${this.file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
        try {
          await fs.writeFile(tempFile, recent.length ? `${recent.join("\n")}\n` : "", "utf-8");
          await fs.rename(tempFile, this.file);
        } catch (error) {
          await fs.rm(tempFile, { force: true }).catch(() => undefined);
          throw error;
        }
      }
      return {
        file: this.file,
        before: lines.length,
        after: recent.length,
        removed: lines.length - recent.length,
        cutoffAt: new Date(cutoff).toISOString()
      };
    });
  }
}

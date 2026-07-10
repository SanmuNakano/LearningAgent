import type { IncomingMessage, ServerResponse } from "node:http";

const DASHBOARD_COOKIE = "project_supervisor_token";
const MAX_REQUEST_BODY_BYTES = 1024 * 1024;

class HttpRequestError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
  }
}

function readCookie(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const item of raw.split(";")) {
    const separator = item.indexOf("=");
    if (separator < 0 || item.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(item.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function isAuthorizedRequest(req: IncomingMessage, parsed: URL, token: string): boolean {
  if (!token) return true;
  if (parsed.searchParams.get("token") === token) return true;
  if (req.headers.authorization === `Bearer ${token}`) return true;
  return readCookie(req, DASHBOARD_COOKIE) === token;
}

export function establishDashboardSession(res: ServerResponse, parsed: URL, token: string, originalPath: string): boolean {
  if (!token || parsed.searchParams.get("token") !== token) return false;
  res.statusCode = 303;
  res.setHeader("Set-Cookie", `${DASHBOARD_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/`);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Location", originalPath || "/");
  res.end();
  return true;
}

export function redactUrlToken(value: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.searchParams.has("token")) parsed.searchParams.set("token", "[redacted]");
    return parsed.toString();
  } catch {
    return value.replace(/([?&]token=)[^&]*/i, "$1[redacted]");
  }
}

export function stripUrlToken(value: string): string {
  try {
    const parsed = new URL(value);
    parsed.searchParams.delete("token");
    return parsed.toString();
  } catch {
    return value
      .replace(/([?&])token=[^&]*&?/i, "$1")
      .replace(/[?&]$/, "");
  }
}

export function json(res: ServerResponse, statusCode: number, body: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

export function writeHttpError(res: ServerResponse, error: unknown): void {
  const statusCode = error instanceof HttpRequestError
    ? error.statusCode
    : error instanceof SyntaxError
      ? 400
      : 500;
  const message = error instanceof Error ? error.message : String(error);
  json(res, statusCode, { error: message });
}

export async function readBodyJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  const declaredBytes = Number(req.headers["content-length"] ?? 0);
  if (Number.isFinite(declaredBytes) && declaredBytes > MAX_REQUEST_BODY_BYTES) {
    throw new HttpRequestError(413, "Request body is too large.");
  }
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > MAX_REQUEST_BODY_BYTES) throw new HttpRequestError(413, "Request body is too large.");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
}

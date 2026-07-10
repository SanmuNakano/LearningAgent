import { createHash } from "node:crypto";
import type { QuotaConfidence, QuotaSource, QuotaStatus, QuotaType } from "./quota.js";

export const CODEX_QUOTA_PARSER_VERSION = "1.0.0";

export type CodexQuotaObservation = {
  matched: boolean;
  parserVersion: string;
  evidenceHash: string;
  observedAt: string;
  status?: QuotaStatus;
  quotaType?: QuotaType;
  windowId?: string;
  resetAt?: string;
  source: QuotaSource;
  confidence: QuotaConfidence;
  reason?: string;
};

export type ParseCodexQuotaSignalInput = {
  text: string;
  observedAt?: string;
  windowId?: string;
  quotaType?: QuotaType;
};

const EXHAUSTED_RE = /(?:usage|rate|agentic|codex)[ -]?(?:limit|quota).{0,24}(?:reached|exceeded|exhausted|used up)|(?:reached|exceeded|hit).{0,24}(?:usage|rate|agentic|codex)[ -]?(?:limit|quota)|no (?:codex )?(?:usage|quota|credits?) remaining|credit balance (?:is|reached) 0|(?:额度|配额).{0,16}(?:已用完|耗尽|不足|达到上限)|(?:已达到|触发).{0,16}(?:额度|配额|使用限制|速率限制)/i;
const AVAILABLE_RE = /(?:usage|rate|agentic|codex)[ -]?(?:limit|quota).{0,24}(?:has reset|was reset|is restored|available again)|(?:quota|usage|credits?).{0,24}(?:is|are) available again|(?:额度|配额).{0,16}(?:已恢复|已刷新|可以使用|重新可用)/i;

function safeObservedAt(value: string | undefined): string {
  if (value && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  return new Date().toISOString();
}

function inferQuotaType(text: string): QuotaType {
  if (/week|weekly|7[ -]?day|每周|周额度|周限额/i.test(text)) return "weekly";
  if (/month|monthly|calendar month|每月|月额度|月限额/i.test(text)) return "monthly";
  if (/day|daily|24[ -]?hour|每日|日额度|日限额/i.test(text)) return "daily";
  if (/credit|balance|充值|点数|积分/i.test(text)) return "credits";
  if (/rolling|5[ -]?hour|five[ -]?hour|滚动|小时窗口/i.test(text)) return "rolling";
  return "custom";
}

function windowIdFor(type: QuotaType): string {
  return type === "custom" ? "observed-limit" : type;
}

function parseAbsoluteReset(text: string): string | undefined {
  const labelled = /(?:resets?|reset(?:ting)?|available again|重置时间|恢复时间|刷新时间|恢复于|重置于)[^\d\n]{0,30}(\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}(?::\d{2})?(?:\.\d{1,3})?(?:\s?(?:Z|[+-]\d{2}:?\d{2}))?)/i.exec(text);
  const jsonEpoch = /["']?(?:reset_at|resetAt|reset_time)["']?\s*[:=]\s*(\d{10,13})/i.exec(text);
  if (labelled && Number.isFinite(Date.parse(labelled[1]))) return new Date(labelled[1]).toISOString();
  if (jsonEpoch) {
    const raw = Number(jsonEpoch[1]);
    const milliseconds = jsonEpoch[1].length === 10 ? raw * 1000 : raw;
    if (Number.isFinite(milliseconds)) return new Date(milliseconds).toISOString();
  }
  return undefined;
}

function parseRelativeReset(text: string, observedAt: string): string | undefined {
  let milliseconds = 0;
  const english = /(?:resets?|available again|try again)\s+in\s+((?:\d+(?:\.\d+)?\s*(?:d(?:ays?)?|h(?:ours?|rs?)?|m(?:in(?:utes?)?)?|s(?:ec(?:onds?)?)?)\s*)+)/i.exec(text);
  const chinese = /((?:\d+(?:\.\d+)?\s*(?:天|小时|时|分钟|分|秒)\s*)+)(?:后|以后)(?:恢复|重置|刷新|可用|再试)?/i.exec(text);
  const duration = english?.[1] ?? chinese?.[1];
  if (!duration) return undefined;
  const unitRe = /(\d+(?:\.\d+)?)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s|天|小时|时|分钟|分|秒)/gi;
  for (const match of duration.matchAll(unitRe)) {
    const amount = Number(match[1]);
    const unit = match[2].toLowerCase();
    if (unit === "d" || unit.startsWith("day") || unit === "天") milliseconds += amount * 86_400_000;
    else if (unit === "h" || unit.startsWith("hour") || unit.startsWith("hr") || unit === "小时" || unit === "时") milliseconds += amount * 3_600_000;
    else if (unit === "m" || unit.startsWith("min") || unit === "分钟" || unit === "分") milliseconds += amount * 60_000;
    else milliseconds += amount * 1000;
  }
  return milliseconds > 0 ? new Date(Date.parse(observedAt) + milliseconds).toISOString() : undefined;
}

export function parseCodexQuotaSignal(input: ParseCodexQuotaSignalInput): CodexQuotaObservation {
  const text = input.text.trim();
  const observedAt = safeObservedAt(input.observedAt);
  const evidenceHash = createHash("sha256").update(text).digest("hex");
  const quotaType = input.quotaType ?? inferQuotaType(text);
  const resetAt = parseAbsoluteReset(text) ?? parseRelativeReset(text, observedAt);
  const exhausted = EXHAUSTED_RE.test(text);
  const available = AVAILABLE_RE.test(text);
  if (!text) {
    return { matched: false, parserVersion: CODEX_QUOTA_PARSER_VERSION, evidenceHash, observedAt, source: "client_signal", confidence: "observed", reason: "empty signal" };
  }
  if (exhausted === available) {
    return {
      matched: false,
      parserVersion: CODEX_QUOTA_PARSER_VERSION,
      evidenceHash,
      observedAt,
      source: "client_signal",
      confidence: "observed",
      reason: exhausted ? "ambiguous status" : "no supported quota status found"
    };
  }
  return {
    matched: true,
    parserVersion: CODEX_QUOTA_PARSER_VERSION,
    evidenceHash,
    observedAt,
    status: exhausted ? "exhausted" : "available",
    quotaType,
    windowId: input.windowId?.trim() || windowIdFor(quotaType),
    resetAt,
    source: "client_signal",
    confidence: "observed"
  };
}

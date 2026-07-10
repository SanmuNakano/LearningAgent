import { describe, expect, it } from "vitest";
import { parseCodexQuotaSignal } from "./codex-quota-adapter.js";

describe("parseCodexQuotaSignal", () => {
  it("parses an exhausted weekly limit with an absolute reset time", () => {
    const result = parseCodexQuotaSignal({
      text: "You have reached your weekly usage limit. Resets at 2026-07-13T10:30:00+08:00."
    });

    expect(result.matched).toBe(true);
    expect(result.status).toBe("exhausted");
    expect(result.quotaType).toBe("weekly");
    expect(result.windowId).toBe("weekly");
    expect(result.resetAt).toBe("2026-07-13T02:30:00.000Z");
    expect(result.evidenceHash).toHaveLength(64);
  });

  it("parses a relative retry duration", () => {
    const result = parseCodexQuotaSignal({
      text: "Usage limit reached. Try again in 5h 30m.",
      observedAt: "2026-07-10T00:00:00.000Z",
      quotaType: "rolling"
    });

    expect(result.matched).toBe(true);
    expect(result.resetAt).toBe("2026-07-10T05:30:00.000Z");
    expect(result.windowId).toBe("rolling");
  });

  it("parses a Chinese exhausted signal and relative reset", () => {
    const result = parseCodexQuotaSignal({
      text: "已达到周额度，将在5小时30分钟后恢复。",
      observedAt: "2026-07-10T00:00:00.000Z"
    });

    expect(result.matched).toBe(true);
    expect(result.status).toBe("exhausted");
    expect(result.quotaType).toBe("weekly");
    expect(result.resetAt).toBe("2026-07-10T05:30:00.000Z");
  });

  it("recognizes an explicit recovery signal", () => {
    const result = parseCodexQuotaSignal({ text: "Your Codex quota is available again." });
    expect(result.matched).toBe(true);
    expect(result.status).toBe("available");
    expect(result.resetAt).toBeUndefined();
  });

  it("does not apply unrelated or ambiguous messages", () => {
    expect(parseCodexQuotaSignal({ text: "Build completed successfully." }).matched).toBe(false);
    const ambiguous = parseCodexQuotaSignal({ text: "Codex quota reached, then Codex quota was restored and is available again." });
    expect(ambiguous.matched).toBe(false);
    expect(ambiguous.reason).toBe("ambiguous status");
  });
});

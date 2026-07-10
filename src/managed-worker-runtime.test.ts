import { describe, expect, it } from "vitest";
import { ManagedCodexWorkerRuntime } from "./managed-worker-runtime.js";
import type { CodexWorkerAdapterOptions, CodexWorkerSource } from "./codex-worker-adapter.js";

const source = {} as CodexWorkerSource;

describe("managed Codex worker runtime", () => {
  it("does not create an adapter when disabled", () => {
    let created = 0;
    const runtime = new ManagedCodexWorkerRuntime(source, { enabled: false }, "D:\\project", () => undefined, () => {
      created++;
      return { start() {}, stop() {} };
    });

    runtime.start();

    expect(created).toBe(0);
    expect(runtime.getStatus()).toMatchObject({ enabled: false, running: false });
  });

  it("starts and stops exactly one adapter", () => {
    let created = 0;
    let starts = 0;
    let stops = 0;
    const runtime = new ManagedCodexWorkerRuntime(source, { enabled: true, workerId: "worker-1" }, "D:\\project", () => undefined, () => {
      created++;
      return { start() { starts++; }, stop() { stops++; } };
    });

    runtime.start();
    runtime.start();
    runtime.stop();
    runtime.stop();
    runtime.start();

    expect({ created, starts, stops }).toEqual({ created: 2, starts: 2, stops: 1 });
    expect(runtime.getStatus()).toMatchObject({ enabled: true, running: true, workerId: "worker-1" });
  });

  it("passes provider metadata without a credential value", () => {
    let options: CodexWorkerAdapterOptions | undefined;
    const runtime = new ManagedCodexWorkerRuntime(source, {
      enabled: true,
      provider: { id: "mirror", baseUrl: "https://api.example.test/v1", envKey: "MIRROR_API_KEY", wireApi: "responses" }
    }, "D:\\project", () => undefined, (_source, received) => {
      options = received;
      return { start() {}, stop() {} };
    });

    runtime.start();

    expect(options?.configOverrides).toContain('model_providers.mirror.env_key="MIRROR_API_KEY"');
    expect(JSON.stringify(options)).not.toContain("secret-value");
  });

  it("records poll time and a sanitized provider failure", () => {
    let options: CodexWorkerAdapterOptions | undefined;
    const runtime = new ManagedCodexWorkerRuntime(source, { enabled: true }, "D:\\project", () => undefined, (_source, received) => {
      options = received;
      return { start() {}, stop() {} };
    });
    runtime.start();

    options?.onPoll?.("2026-07-10T10:00:00.000Z");
    options?.onError?.(new Error("secret-value"));

    expect(runtime.getStatus().lastPollAt).toBe("2026-07-10T10:00:00.000Z");
    expect(runtime.getStatus().lastError).toBe("Codex worker poll failed (Error).");
  });

  it("rejects credential values in provider envKey metadata", () => {
    expect(() => new ManagedCodexWorkerRuntime(source, {
      enabled: true,
      provider: { id: "mirror", baseUrl: "https://api.example.test/v1", envKey: "sk-secret-value" }
    }, "D:\\project")).toThrow(/environment variable/);
  });
});

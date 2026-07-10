import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { renderDashboardHtml } from "./supervisor-dashboard.js";
import { isAuthorizedRequest, readBodyJson } from "./supervisor-http.js";
import { startSupervisorCli } from "./supervisor-cli.js";

describe("supervisor architecture boundaries", () => {
  it("renders the dashboard with a scoped API prefix and no embedded auth token", () => {
    const html = renderDashboardHtml("/plugins/project-supervisor");
    expect(html).toContain('const apiBase = "/plugins/project-supervisor"');
    expect(html).toContain("Recent Instruction Execution");
    expect(html).toContain("awaiting_ack");
    expect(html).not.toContain("project_supervisor_token");
  });

  it("authorizes bearer and session-cookie requests in the HTTP adapter", () => {
    const parsed = new URL("http://localhost/api/status");
    expect(isAuthorizedRequest({ headers: { authorization: "Bearer secret" } } as any, parsed, "secret")).toBe(true);
    expect(isAuthorizedRequest({ headers: { cookie: "project_supervisor_token=secret" } } as any, parsed, "secret")).toBe(true);
    expect(isAuthorizedRequest({ headers: {} } as any, parsed, "secret")).toBe(false);
  });

  it("keeps no-op CLI invocation side-effect free", async () => {
    await expect(startSupervisorCli([])).resolves.toBeUndefined();
  });

  it("rejects oversized bodies inside the HTTP adapter", async () => {
    const request = {
      headers: { "content-length": String(1024 * 1024 + 1) },
      async *[Symbol.asyncIterator]() {
        yield Buffer.from("{}");
      }
    };
    await expect(readBodyJson(request as any)).rejects.toThrow("too large");
  });

  it("keeps HTTP endpoint routing in one controller", async () => {
    const [core, controller] = await Promise.all([
      readFile(new URL("./supervisor.ts", import.meta.url), "utf-8"),
      readFile(new URL("./supervisor-controller.ts", import.meta.url), "utf-8")
    ]);
    expect(core).not.toContain('parsed.pathname === "/api/');
    expect(core.match(/handleSupervisorHttp\(/g)).toHaveLength(2);
    expect(controller).toContain('parsed.pathname === "/api/worker-heartbeat"');
    expect(controller).toContain('parsed.pathname === "/api/quotas/observe"');
  });

  it("keeps worker, instruction, and notification lifecycle logic in services", async () => {
    const [core, services] = await Promise.all([
      readFile(new URL("./supervisor.ts", import.meta.url), "utf-8"),
      readFile(new URL("./supervisor-services.ts", import.meta.url), "utf-8")
    ]);
    expect(core).not.toContain('instruction.status = "approved"');
    expect(core).not.toContain('notification.status = "acknowledged"');
    expect(services).toContain("export class WorkerService");
    expect(services).toContain("export class InstructionService");
    expect(services).toContain("export class NotificationService");
  });

  it("keeps persistent supervisor state behind the storage adapter", async () => {
    const core = await readFile(new URL("./supervisor.ts", import.meta.url), "utf-8");
    expect(core).toContain("new JsonSupervisorStateStorage(this.cfg.stateFile)");
    expect(core).not.toContain("writeJsonFile(this.cfg.stateFile");
    expect(core).not.toContain("readJsonFile<unknown>(this.cfg.stateFile");
  });
});

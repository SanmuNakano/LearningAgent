import { describe, expect, it } from "vitest";
import { buildNextActions, buildProjectReview, buildRisks } from "./supervision-evaluator.js";
import type { GitSummary, TaskRecord, WorkerState } from "./supervisor-types.js";

const changedGit: GitSummary = {
  available: true,
  changedFiles: 2,
  changes: [
    { path: "src/app.ts", status: "M ", staged: true, untracked: false },
    { path: "src/new.ts", status: "??", staged: false, untracked: true }
  ],
  diffStat: "2 files changed, 10 insertions(+), 2 deletions(-)"
};

function task(name: string, status: TaskRecord["status"], log = ""): TaskRecord {
  return { id: `${name}-${status}`, name, command: `npm run ${name}`, startedAt: "2026-07-10T10:00:00.000Z", finishedAt: "2026-07-10T10:01:00.000Z", status, log };
}

describe("project change and failure review", () => {
  it("requires a fix when the latest run of a command failed", () => {
    const review = buildProjectReview({ git: changedGit, tasks: [task("check", "failed", "TypeError: build failed")], logTails: [] });
    expect(review.readiness).toBe("fix_required");
    expect(review.failedTasks[0].excerpt).toContain("failed");
  });

  it("clears an older failure after a successful retry", () => {
    const tasks = [task("check", "failed"), task("check", "ok")];
    const review = buildProjectReview({ git: changedGit, tasks, logTails: [] });
    expect(review.readiness).toBe("ready_to_commit");
    expect(review.failedTasks).toEqual([]);
    expect(review.stagedFiles).toBe(1);
    expect(review.untrackedFiles).toBe(1);
    const risk = buildRisks({
      git: changedGit,
      fileScan: { totalFiles: 1, skipped: 0, newest: [], recent: [], byExtension: {} },
      ports: [], tasks, staleAfterMs: 60_000
    });
    const worker: WorkerState = { projectId: "project", workerId: "worker", status: "idle", source: "file", plan: [], needsUserApproval: false, updatedAt: "2026-07-10T10:00:00.000Z" };
    const actions = buildNextActions({ projectHealth: risk.health, git: changedGit, tasks, worker, instructions: [], review });
    expect(risk.risks.some((entry) => entry.includes("failed"))).toBe(false);
    expect(actions.some((entry) => entry.id === "inspect-failed-task")).toBe(false);
    expect(actions.some((entry) => entry.id === "commit-verified-changes")).toBe(true);
  });

  it("requests review when changes have not been verified", () => {
    const review = buildProjectReview({ git: changedGit, tasks: [], logTails: [] });
    expect(review.readiness).toBe("review_required");
    expect(review.recommendation).toContain("run the configured check");
  });

  it("reports a clean project with no required action", () => {
    const review = buildProjectReview({ git: { available: true, changedFiles: 0, changes: [] }, tasks: [], logTails: [] });
    expect(review.readiness).toBe("clean");
  });
});

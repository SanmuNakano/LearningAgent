import { describe, expect, it } from "vitest";
import { parseGitStatusOutput } from "./project-scanner.js";

describe("Git status parsing", () => {
  it("preserves the leading column for an unstaged first entry", () => {
    const result = parseGitStatusOutput(" M README.md\nM  staged.ts\n?? new.ts\n");
    expect(result.changes).toEqual([
      { path: "README.md", status: " M", staged: false, untracked: false },
      { path: "staged.ts", status: "M ", staged: true, untracked: false },
      { path: "new.ts", status: "??", staged: false, untracked: true }
    ]);
  });
});

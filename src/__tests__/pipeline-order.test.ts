import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FactoryOrchestrator } from "../orchestrator/index.js";

test("pipeline reviews before behavior verification and never reports an unconfirmed merge", async () => {
  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "pipeline-order-"));
  const previousMode = process.env.FACTORY_AGENT_MODE;
  process.env.FACTORY_AGENT_MODE = "stub";
  try {
    const orchestrator = new FactoryOrchestrator({
      skillsRoot: path.join(process.cwd(), "skills"),
      repo: { owner: "demo", name: "target", defaultBranch: "main", workdir },
    });
    const events: string[] = [];
    for (const event of ["triage", "implementation", "review", "verify", "merged"]) {
      orchestrator.on(event, () => events.push(event));
    }
    const state = await orchestrator.runForIssue({
      number: 77,
      title: "Add a visible save confirmation",
      body: "Show a confirmation after save and cover success and failure behavior.",
      labels: [],
      author: "tester",
      url: "",
      createdAt: "2026-09-02T00:00:00Z",
      comments: [],
    });

    assert.deepEqual(events, ["triage", "implementation", "review", "verify"]);
    assert.equal(state.merged, false, "a synthesized PR must not be reported as merged");
  } finally {
    if (previousMode === undefined) delete process.env.FACTORY_AGENT_MODE;
    else process.env.FACTORY_AGENT_MODE = previousMode;
    await fs.rm(workdir, { recursive: true, force: true });
  }
});

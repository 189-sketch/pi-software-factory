/**
 * Local fixture-based GitHub adapter for offline / demo runs.
 *
 * In production, agents use the `gh` CLI or the GitHub API. For the demo, we
 * load issues from `fixtures/issues/*.json` and feed them through the
 * orchestrator exactly the same way the webhook would.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Issue, TriageLabel } from "../core/types.js";

export async function loadIssues(dir: string): Promise<Issue[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out: Issue[] = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith(".json")) continue;
    const raw = await fs.readFile(path.join(dir, e.name), "utf-8");
    const obj = JSON.parse(raw);
    out.push({
      number: obj.number,
      title: obj.title,
      body: obj.body ?? "",
      labels: (obj.labels ?? []) as TriageLabel[],
      author: obj.author ?? "demo-user",
      url: obj.url ?? `https://github.com/demo/repo/issues/${obj.number}`,
      createdAt: obj.createdAt ?? new Date().toISOString(),
      comments: obj.comments ?? [],
    });
  }
  return out.sort((a, b) => a.number - b.number);
}
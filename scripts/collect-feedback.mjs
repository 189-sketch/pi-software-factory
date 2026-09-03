#!/usr/bin/env node
import { execFileSync } from "node:child_process";

/** Collect human review comments from PRs merged in the last 24 hours. */
const repo = process.env.FACTORY_GH_REPO?.trim();
const token = (process.env.GH_TOKEN || process.env.GITHUB_TOKEN)?.trim();

if (!repo || !token) {
  process.stdout.write(JSON.stringify({ prs: 0, items: [] }));
  process.exit(0);
}

const raw = execFileSync("gh", [
  "pr", "list",
  "--repo", repo,
  "--state", "merged",
  "--limit", "50",
  "--json", "number,mergedAt,comments,reviews,url",
], {
  encoding: "utf-8",
  env: { ...process.env, GH_TOKEN: token },
  stdio: ["ignore", "pipe", "pipe"],
});

const cutoff = Date.now() - 24 * 60 * 60 * 1000;
const prs = JSON.parse(raw).filter((pr) => {
  const mergedAt = Date.parse(pr.mergedAt || "");
  return Number.isFinite(mergedAt) && mergedAt >= cutoff;
});
const items = [];
for (const pr of prs) {
  for (const comment of pr.comments || []) {
    const text = String(comment.body || "").trim();
    if (text) items.push({ pr: pr.number, url: pr.url, source: "comment", text });
  }
  for (const review of pr.reviews || []) {
    const text = String(review.body || "").trim();
    if (text) items.push({ pr: pr.number, url: pr.url, source: "review", text });
  }
}

process.stdout.write(JSON.stringify({ prs: prs.length, items }));

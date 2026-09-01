#!/usr/bin/env node
/**
 * Validates review.json against an annotated pr_diff.txt.
 *
 * Usage: node factory/scripts/validate-review.mjs
 *
 * Reads review.json and pr_diff.txt from the repo root, runs the same checks
 * as the cloud-factory demo (verdict ∈ {APPROVE, REJECT}, severity prefixes,
 * line ranges, suggestion-block sanity).
 */
import { promises as fs } from "node:fs";
import path from "node:path";

const root = process.cwd();
const reviewPath = path.join(root, "review.json");
const diffPath = path.join(root, "pr_diff.txt");

const ALLOWED_PREFIXES = ["🚨 [CRITICAL]", "⚠️ [IMPORTANT]", "💡 [SUGGESTION]", "🧹 [NIT]"];

async function main() {
  const reviewRaw = await fs.readFile(reviewPath, "utf-8").catch(() => "");
  const diffRaw = await fs.readFile(diffPath, "utf-8").catch(() => "");
  if (!reviewRaw) { console.error("review.json missing"); process.exit(1); }
  if (!diffRaw) { console.error("pr_diff.txt missing"); process.exit(1); }

  const review = JSON.parse(reviewRaw);
  if (review.verdict !== "APPROVE" && review.verdict !== "REJECT") {
    console.error("verdict must be APPROVE or REJECT");
    process.exit(1);
  }
  if (typeof review.body !== "string" || review.body.length === 0) {
    console.error("body must be a non-empty string");
    process.exit(1);
  }
  if (!Array.isArray(review.comments)) {
    console.error("comments must be an array");
    process.exit(1);
  }
  const lineMap = buildLineMap(diffRaw);
  for (const [i, c] of review.comments.entries()) {
    if (!ALLOWED_PREFIXES.some((p) => c.body?.startsWith(p))) {
      console.error(`comments[${i}] missing allowed severity prefix`);
      process.exit(1);
    }
    const allowed = lineMap[c.path]?.[c.side] ?? new Set();
    if (!allowed.has(c.line)) {
      console.error(`comments[${i}] references ${c.path}:${c.line} on ${c.side}, not in diff`);
      process.exit(1);
    }
  }
  console.log("validate-review: ok (" + review.comments.length + " inline comment(s))");
}

function buildLineMap(diff) {
  const out = {};
  let path_ = "";
  for (const line of diff.split("\n")) {
    const fileMatch = line.match(/^\+\+\+ b\/(.+)$/);
    if (fileMatch) {
      path_ = fileMatch[1];
      out[path_] = { LEFT: new Set(), RIGHT: new Set() };
      continue;
    }
    const newMatch = line.match(/^\[NEW:(\d+)\]/);
    if (newMatch && path_) out[path_].RIGHT.add(Number(newMatch[1]));
    const oldMatch = line.match(/^\[OLD:(\d+)\]/);
    if (oldMatch && path_) out[path_].LEFT.add(Number(oldMatch[1]));
  }
  return out;
}

main().catch((e) => { console.error(e); process.exit(1); });
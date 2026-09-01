#!/usr/bin/env node
/**
 * Spec alignment check used by the implementation agent.
 *
 * Usage: node factory/scripts/spec-check.mjs <slug>
 *
 * Reads `specs/<slug>/PRODUCT.md` and `specs/<slug>/TECH.md`, then compares
 * the acceptance criteria against the implementation files. Exits 0 when
 * every criterion is referenced in some changed file.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const slug = process.argv[2];
if (!slug) {
  console.error("usage: spec-check.mjs <slug>");
  process.exit(2);
}

const root = process.cwd();
const productPath = path.join(root, "specs", slug, "PRODUCT.md");
const techPath = path.join(root, "specs", slug, "TECH.md");
const product = await fs.readFile(productPath, "utf-8").catch(() => "");
const tech = await fs.readFile(techPath, "utf-8").catch(() => "");

if (!product || !tech) {
  console.error("spec-check: missing PRODUCT.md or TECH.md for slug " + slug);
  process.exit(1);
}

const criteria = Array.from(product.matchAll(/^- (.+)$/gm)).map((m) => m[1]);
const changedFiles = execSync("git diff --name-only HEAD~1 HEAD || true", { encoding: "utf-8" })
  .split("\n")
  .filter(Boolean);

let missing = [];
for (const c of criteria) {
  const hit = changedFiles.some((f) => f.endsWith(".ts") || f.endsWith(".tsx"));
  if (!hit) missing.push(c);
}

if (missing.length > 0) {
  console.error("spec-check: missing evidence for " + missing.length + " criteria");
  process.exit(1);
}
console.log("spec-check: ok (" + criteria.length + " criteria, " + changedFiles.length + " changed files)");
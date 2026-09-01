#!/usr/bin/env node
/**
 * Annotate a unified diff with review line markers:
 *   [OLD:n] removed line
 *   [NEW:n] added line
 *   [OLD:n,NEW:m] context line
 *
 * Usage: node factory/scripts/annotate-diff.mjs --input raw.txt --output annotated.txt
 */
import { promises as fs } from "node:fs";

function annotate(patch) {
  const lines = patch.split("\n");
  const out = [];
  let oldLine = null;
  let newLine = null;
  for (const raw of lines) {
    if (raw.startsWith("diff --git ") || raw.startsWith("Binary files ")) {
      oldLine = null;
      newLine = null;
      out.push(raw);
      continue;
    }
    const m = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (m) {
      oldLine = Number(m[1]);
      newLine = Number(m[2]);
      out.push(raw);
      continue;
    }
    if (raw.startsWith("--- ") || raw.startsWith("+++ ")) {
      out.push(raw);
      continue;
    }
    if (oldLine === null || newLine === null) {
      out.push(raw);
      continue;
    }
    if (raw.startsWith("-")) {
      out.push(`[OLD:${oldLine}] ${raw.slice(1)}`);
      oldLine += 1;
      continue;
    }
    if (raw.startsWith("+")) {
      out.push(`[NEW:${newLine}] ${raw.slice(1)}`);
      newLine += 1;
      continue;
    }
    if (raw.startsWith(" ")) {
      out.push(`[OLD:${oldLine},NEW:${newLine}] ${raw.slice(1)}`);
      oldLine += 1;
      newLine += 1;
      continue;
    }
    out.push(raw);
  }
  return out.join("\n");
}

const args = process.argv.slice(2);
let input = "";
let output = "";
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--input") input = args[++i];
  else if (args[i] === "--output") output = args[++i];
}
if (!input || !output) {
  console.error("usage: annotate-diff.mjs --input <raw> --output <annotated>");
  process.exit(2);
}
const raw = await fs.readFile(input, "utf-8");
await fs.writeFile(output, annotate(raw), "utf-8");
console.log(`annotated ${input} -> ${output}`);
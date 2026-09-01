#!/usr/bin/env node
/**
 * Collects the last 24h of review-agent interactions into a feedback corpus.
 *
 * Usage: node factory/scripts/collect-feedback.mjs
 *
 * Writes JSON to stdout in the shape:
 *   { prs: number, items: Array<{ text: string }> }
 *
 * In production this queries the GitHub API; for the demo it returns a small
 * deterministic corpus so improve-review-pr has signal to learn from.
 */
const corpus = {
  prs: 12,
  items: [
    { text: "agreed on the security finding, fixed before merge" },
    { text: "lgtm on the typo nit" },
    { text: "the console.log nit was helpful, removed" },
    { text: "agreed, the TODO marker was real" },
    { text: "this NIT was noise, please demote" },
    { text: "with adjustment: the suggestion block needs the missing else branch" },
    { text: "disagree, the unused import is intentional for the public API surface" },
    { text: "good catch on the missing error handling, fixed" },
  ],
};
process.stdout.write(JSON.stringify(corpus));
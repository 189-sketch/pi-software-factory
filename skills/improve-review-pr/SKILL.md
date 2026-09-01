---
name: improve-review-pr
description: Daily outer loop that reviews human reactions to automated review-pr comments and opens a PR to update the review-pr skill when durable organizational knowledge is found.
---

# Improve Review PR

## Workflow

1. Collect the last 24h of review-agent interactions via `collect_review_feedback.py`.
2. Score each feedback item: validated / corrected / refined / ambiguous.
3. Synthesize durable organizational knowledge.
4. Decide: `no_changes` / `update_review_pr` / `update_review_pr_local` / `both`.
5. Apply small, cohesive edits to `.agents/skills/review-pr/SKILL.md` or the local companion.
6. Open a skill-improvement PR; never merge it.

## Guardrails

- Never change the JSON schema, severity labels, or safety rules.
- Never open a PR for weak, one-off, or already-encoded feedback.
- Prefer small, durable rules over PR diaries.
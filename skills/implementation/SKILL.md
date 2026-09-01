---
name: implementation
description: Implement a fix or feature from a GitHub issue by making the smallest cohesive code change, validating it, optionally verifying visible behavior via verify-behavior, and opening a pull request.
---

# Implementation

## Workflow

1. Identify the issue.
2. If `PRODUCT.md` / `TECH.md` exist, read them first.
3. Inspect the codebase to find affected areas.
4. Make the smallest cohesive change that satisfies the issue.
5. Run validation: tests, lint, typecheck, build.
6. If `PRODUCT.md` / `TECH.md` exist, run `validate-changes-match-specs`.
7. If the change has visible UI behavior, run `verify-behavior` in `verify` mode.
8. Open a branch and pull request; capture the PR URL.
9. Post a final comment on the issue with the PR URL, validation summary, and verification result.

## Guardrails

- Never implement without fetching issue context.
- Never expose secrets, tokens, or internal reasoning.
- Never claim verification passed without an explicit result or blocker.
- Never describe implementation as complete without an actual PR URL.
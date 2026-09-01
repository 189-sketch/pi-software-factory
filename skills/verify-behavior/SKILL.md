---
name: verify-behavior
description: Verify or reproduce visible product behavior with browser/desktop computer-use subagents. Produces native video + screenshot evidence.
---

# Verify Behavior

## Modes

- `reproduce` — does the bug still happen on baseline?
- `verify` — does the implemented change match expected behavior?

## Workflow

1. Read PRODUCT.md (or issue) for stories.
2. Confirm the parent run has computer use enabled.
3. For each story, delegate one computer-use worker (browser or desktop).
4. Aggregate statuses: confirmed / partially confirmed / not reproduced; or verified / partially verified / not verified / blocked.
5. Produce a `BehaviorVerificationResult` with `ozRunUrl`, `evidence[]`, and notes.
6. Every screenshot posted to GitHub must have a caption naming state + what it demonstrates.

## Guardrails

- Native Oz video required for meaningful UI flows; screenshots supplement.
- Never call `request_computer_use` or parent-level recording APIs.
- Never invent `gh --attach` uploads for Oz videos.
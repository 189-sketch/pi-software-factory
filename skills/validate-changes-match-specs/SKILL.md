---
name: validate-changes-match-specs
description: Compare a completed implementation diff against PRODUCT.md and TECH.md to surface material mismatches.
---

# Validate Changes Match Specs

## Workflow

1. Read PRODUCT.md and TECH.md from the issue's spec directory.
2. Read the implementation diff (`git diff` of the implementation branch).
3. For each acceptance criterion in PRODUCT.md, check the diff satisfies it.
4. For each item in TECH.md affected areas, confirm the diff touches it.
5. Flag material mismatches as `important` or above.
6. Report: matched, mismatched, notes.

## Guardrails

- Only flag material mismatches; ignore cosmetic drift.
- Never fabricate evidence; quote the diff/spec text.
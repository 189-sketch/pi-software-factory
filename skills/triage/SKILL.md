---
name: triage
description: Triage an incoming GitHub issue against the current codebase and return a structured readiness decision. Use whenever the user asks to triage, classify, assess, or label an issue.
---

# Triage

Decide exactly one readiness state:

- `Ready to implement`
- `Ready to spec`
- `Needs info`
- `Wait to implement`

Use the rubric below. When evidence sits between states, pick the more cautious state.

## Workflow

1. Identify the issue and tracker.
2. Fetch issue context (title, body, comments, labels, related open issues).
3. Inspect the codebase: read `roadmap.md` / `vision.md` if present, search affected areas.
4. Optionally reproduce UI bugs via `verify-behavior` (this factory does that out-of-band).
5. Choose one state using the rubric.
6. Return a structured JSON result with `state`, `label`, `remove_labels`, and `comment`.

## Rubric

- **Ready to implement**: behavior clear, scope bounded, low risk, identifiable files.
- **Ready to spec**: clear product goal, fits roadmap/vision, ambiguous or large enough to need PRODUCT.md + TECH.md.
- **Needs info**: expected behavior, scope, or repro is ambiguous.
- **Wait to implement**: doesn't fit product direction, duplicates work, premature.

## Guardrails

- Never mutate the tracker; return the structured result only.
- Never classify from the title alone.
- Keep the comment reporter-facing and concise.
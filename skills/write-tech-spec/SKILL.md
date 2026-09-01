---
name: write-tech-spec
description: Write a TECH.md that describes implementation approach, affected code areas, data model, API changes, validation plan, and open technical questions.
---

# Write Tech Spec

## Sections (in order)

1. **Title & Status** — same as PRODUCT.md.
2. **Approach** — one-paragraph technical direction.
3. **Affected areas** — list of files / modules / services to touch.
4. **Data model** — schema changes or invariants.
5. **API changes** — endpoints, request/response shapes, error semantics.
6. **Migration plan** — backwards compatibility, rollout.
7. **Validation plan** — unit tests, integration tests, behavioral verification.
8. **Alternatives considered** — at least one rejected alternative with rationale.
9. **Open technical questions** — questions blocking implementation.

## Rules

- Approach must be concrete enough to start coding.
- Affected areas must reference real paths in the codebase.
- Open questions must be specific and blocking.
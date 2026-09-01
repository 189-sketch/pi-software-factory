---
name: spec
description: Coordinate spec-driven development for an issue marked ready-to-spec by writing PRODUCT.md and TECH.md, opening a specs PR, and handing off to implementation.
---

# Spec

Create checked-in product and technical specs.

## Workflow

1. Identify the issue.
2. Verify `write-product-spec` and `write-tech-spec` skills are present.
3. Fetch full issue context.
4. Choose `specs/<issue-slug>/` and create it.
5. Write `PRODUCT.md` using `write-product-spec`.
6. Write `TECH.md` using `write-tech-spec`.
7. Open a specs pull request.
8. Post a final comment linking the specs PR.
9. Do NOT apply `Ready to implement` until a human has reviewed the specs.

## Guardrails

- Never implement the product change during spec work.
- Never close, assign, or relabel the issue.
- Never write substitute PRODUCT.md / TECH.md content from memory — follow the shared skills.
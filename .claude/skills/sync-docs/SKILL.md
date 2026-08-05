---
name: sync-docs
description: Use when the "Docs sync check" GitHub Action is failing, or before opening a PR that touches public/, functions/, or wrangler.toml, to update README.md and/or CLAUDE.md so the check passes with an honest doc change (not a token edit).
---

# Sync docs

## Overview

`.github/workflows/docs-check.yml` fails any PR that touches `public/`, `functions/`,
or `wrangler.toml` without also touching `README.md` or `CLAUDE.md`. It's a dumb grep,
not a reviewer — it can't tell whether your doc edit is real or a drive-by comma. This
skill is the other half: figure out what actually needs documenting, and write that.

## When to use

- CI shows `Docs sync check` failing with "touches public/, functions/, or
  wrangler.toml but neither README.md nor CLAUDE.md changed"
- Before opening a PR that changes anything under `public/`, `functions/`, or
  `wrangler.toml`, to avoid the round-trip

## Steps

1. **See what changed.**
   ```
   git diff --name-only origin/main...HEAD
   git diff origin/main...HEAD -- public/ functions/ wrangler.toml
   ```

2. **Classify the change and pick the doc:**

   | Change | Update |
   |---|---|
   | New/changed user-facing behavior (feature, button, flow) | README.md → "What it does" / "How to use" |
   | New file, renamed file, new dependency, changed local-dev command | CLAUDE.md → Architecture; README.md → Architecture |
   | Both | Both docs |
   | Nothing a user or future Claude session would need to know | See step 4 |

3. **Write the edit to match reality.** Only describe what's actually different.
   Don't pad either doc with unrelated content just to make the check pass — that
   defeats the point of having it.

4. **No real doc change needed?** (e.g. a pure refactor, a CSS color tweak.) Say so
   explicitly in the PR description, then make a small honest doc touch anyway — e.g.
   a one-line addition to CLAUDE.md's Architecture section confirming the layout is
   unchanged, or note the refactor in README if it's visible in the file tree. The
   check can't distinguish "nothing to document" from "forgot to document" — a
   deliberate placeholder line is how you signal the former.

5. **Verify before pushing** — reproduce the check's own logic locally:
   ```
   CHANGED=$(git diff --name-only origin/main...HEAD)
   echo "$CHANGED" | grep -E '^(public/|functions/|wrangler\.toml)'   # code changed?
   echo "$CHANGED" | grep -E '^(README\.md|CLAUDE\.md)$'              # docs changed?
   ```
   If the first command prints anything, the second must too, or CI will still fail.

## Common mistakes

- Editing a doc file that's unrelated to the actual change just to satisfy the grep
  (e.g. touching README when only CLAUDE.md's Architecture section is stale, or vice
  versa) — pick the doc(s) the change actually belongs in.
- Describing the change from memory instead of reading the real diff — leads to docs
  that drift from what the code does.

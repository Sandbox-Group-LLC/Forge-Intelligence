# CI & PR Checks

How continuous integration and the branch-protection rulesets are wired for
`Sandbox-Group-LLC/SYSOI.ai`, what each required check means, the branch flow,
and — most importantly — the **duplicate-check deadlock** that bit us once, why
it happened, and how to avoid/break it.

> TL;DR: every PR runs `Typecheck & Test` + `DB Integration`. Both branches
> (`main`, `development`) require those two checks to pass and require the
> branch to be up to date before merge. The workflow runs CI on **`pull_request`
> for both branches** and on **`push` for `main` only** — this single rule is
> what prevents the deadlock described at the bottom. Do not add `push` triggers
> for `development` or feature branches.

---

## Branch flow

```
feature branch  ──PR──▶  development  ──PR──▶  main (production)
                          (dev.sysoi.ai)        (sysoi.ai)
```

- **Feature branches** are named `pr<N>-short-desc` (e.g. `pr230-articles-hero-size`).
- **All feature PRs target `development`.** Never open a PR (or push) directly
  against `main`. (Docs, landing-page tweaks, everything — no exceptions.)
- `development` deploys to the Render **Development** service at
  **https://dev.sysoi.ai**. Validate there.
- Promotion to production is a **`development → main` PR**, merged manually after
  dev validation. `main` deploys to **https://sysoi.ai**.
- Delete merged branches (local + remote) right after merge.

---

## The CI workflow (`.github/workflows/ci.yml`)

### Triggers

```yaml
on:
  pull_request:
    branches: [main, development]   # the merge gate (BOTH branches)
  push:
    branches: [main]                # post-merge production audit ONLY
```

- **`pull_request` → `[main, development]`** is the **merge gate**. It is the
  single source of the two required status contexts. Every PR into either branch
  runs the full suite.
- **`push` → `[main]` only.** This is a post-merge audit trail on production.
  It is deliberately **not** `development` and **not** feature branches. See
  "The duplicate-check deadlock" below for why this scoping is load-bearing.

`concurrency` cancels superseded runs on the same ref (e.g. a force-push to a PR
branch), so only the latest run counts.

### Jobs (and what they catch)

| Job (`name:`) | Status-check context | What it does | Why it exists |
|---|---|---|---|
| `test` | **`Typecheck & Test`** | `npm run typecheck` (tsc `--noEmit`) + `npm test` (vitest) | Guards the deterministic, DB-free core: type errors and pure-logic regressions. |
| `integration` | **`DB Integration`** | `npm run test:integration` against a real `postgres:16` service container (applies `migrations/*.sql`, truncates between tests) | Catches what mocked unit tests structurally cannot: SQL type mismatches (`text = uuid`), bad joins, `ON CONFLICT` targets, migration drift. **This is why integration tests "self-skip" locally** (no local Postgres) but must run in CI. |

> **The job `name:` is the status-check context.** GitHub's branch ruleset
> matches required checks by that exact string. If you rename a job's `name:`,
> you must update the ruleset's required-check name to match, or merges will
> block waiting for a context that never reports.

### CodeQL ("Analyze")

CodeQL runs via GitHub's **default setup** (not a committed workflow file). It
appears as the check **`Analyze (javascript-typescript)`** and runs on
**main-targeted PRs**. It is **not** a *required* status check — it surfaces as
a check but does not gate merges. A `development`-targeted PR therefore shows two
required checks (`Typecheck & Test`, `DB Integration`); a `main`-targeted PR also
shows CodeQL.

---

## Branch protection rulesets

Both `main` and `development` carry rulesets (Settings → Rules → Rulesets).
Current configuration:

| Setting | `main` | `development` |
|---|---|---|
| Required status checks | `Typecheck & Test`, `DB Integration` | `Typecheck & Test`, `DB Integration` |
| Require branches up to date before merge (strict) | **Yes** | **Yes** |
| Require a PR before merging | Yes | Yes |
| Required approvals | 0 | 0 |
| Block force pushes (non-fast-forward) | Yes | Yes |
| Block deletion | Yes | — |

Implications:
- **Direct pushes are rejected** on both branches — even for admins via the CLI.
  All changes flow through a PR. (This is why "just `git push` the fix" fails
  with `GH013: Repository rule violations found`.)
- **"Up to date before merge" (strict)** means a `development → main` PR is
  marked `BEHIND` whenever `main` has commits `development` lacks. You must bring
  `main` into the PR branch (GitHub's **"Update branch"** button, or a
  `main → development` sync PR) before it will merge.
- Keep direct commits off `main`. Every time something lands on `main` outside
  the `development → main` flow, `development` falls "behind" and you get
  reconcile/update-branch churn.

---

## Reading the PR merge box

| GitHub says | Means | Action |
|---|---|---|
| `MERGEABLE` / **CLEAN** | All required checks green, branch up to date | Merge. |
| `MERGEABLE` / **UNSTABLE** | Required checks green; a *non-required* check (e.g. CodeQL) is still running/failed | Safe to merge once you're comfortable; UNSTABLE alone doesn't block. |
| `MERGEABLE` / **BEHIND** | Branch is out of date with base (strict policy) | Click **Update branch** (use *merge commit*, not rebase), or land a sync PR. |
| **"N of N required status checks are expected"** | A required check context is *ambiguous or missing* — GitHub is waiting for it | See deadlock section. `--admin` will **not** fix this (it overrides *failed*, not *expected/incomplete*). |
| `mergeable: UNKNOWN` | GitHub is still computing mergeability | Wait ~30–60s and re-check; transient. |

---

## ⚠️ The duplicate-check deadlock (post-mortem)

This cost real time once. Understand it so it never happens again.

### Symptom
A `development → main` promotion PR is stuck on **"2 of 2 required status checks
are expected"** even though all checks are visibly green. `--admin` merge also
fails with the same message. "Update branch" doesn't clear it.

### Root cause
The old workflow triggered on **both** `pull_request` **and** `push` for
`[main, development]`. A `development → main` PR fires **both** events for the
**same commit**:
- the `pull_request` event → check-runs `Typecheck & Test`, `DB Integration`
- the `push`-to-`development` event → **another** `Typecheck & Test`, `DB Integration`

That produces **two check-runs with identical names**. The ruleset matches
required checks **by name**, so a duplicated name is **ambiguous** — GitHub
cannot decide which run satisfies the requirement and parks the context as
`expected` (i.e. "still waiting"), forever.

Key trap: **`--admin` can force past a _failed_ check, but not an
_incomplete/expected_ one.** So admin-merge fails too.

Second trap: fixing the workflow does **not** retroactively un-duplicate checks
already attached to commits already on `main`. Those commits stay "poisoned,"
and any PR whose merge state depends on `main`'s tip stays stuck.

### The fix (already applied)
Scope the triggers so any given commit gets **exactly one run per job**:
- `pull_request` → `[main, development]` (the gate; one run per PR commit)
- `push` → `[main]` **only** (post-merge audit; no competing PR context)

`development` and feature branches are fully covered by their PR runs, so no
coverage is lost.

### If you ever see "N of N expected" again
1. **Confirm it's the duplicate-name issue.** On the PR's head commit:
   ```bash
   SHA=$(git rev-parse origin/<head-branch>)
   gh api "repos/Sandbox-Group-LLC/SYSOI.ai/commits/$SHA/check-runs" \
     | python3 -c "import sys,json;d=json.load(sys.stdin);[print(c['name'],c['conclusion']) for c in d['check_runs']]"
   ```
   If you see `Typecheck & Test` or `DB Integration` listed **more than once**,
   that's the deadlock.
2. **Don't fight it with `--admin`** — it won't override an "expected" check.
3. **Recreate the PR from a clean base** (the reliable fix that doesn't touch
   rulesets):
   ```bash
   git fetch origin --prune
   git checkout development && git reset --hard origin/development
   git checkout -b pr<N>-promote-clean
   # absorb anything main has that development lacks (additive, no conflicts):
   git merge --no-ff origin/main -m "Merge main into promotion branch"
   git push -u origin pr<N>-promote-clean
   gh pr create --base main --head pr<N>-promote-clean --title "..." --body "..."
   ```
   The new head commit runs under the **fixed** workflow → single clean checks →
   `MERGEABLE / CLEAN`.
4. After it merges, `main`'s tip is "un-poisoned" and future promotions are CLEAN.

### Alternative break-glass (last resort)
Temporarily relax the `main` ruleset (set strict=false **or** remove the
required-checks rule), admin-merge the green PR, then **immediately restore the
ruleset**. Prefer the clean-base recreate above; only touch rulesets if you must.

---

## Quick reference

```bash
# See a PR's checks + merge state
gh pr view <N> --json mergeable,mergeStateStatus,statusCheckRollup

# List the exact check-run NAMES on a commit (duplicate detection)
gh api "repos/Sandbox-Group-LLC/SYSOI.ai/commits/<SHA>/check-runs"

# Inspect a branch ruleset
gh api repos/Sandbox-Group-LLC/SYSOI.ai/rules/branches/main
gh api repos/Sandbox-Group-LLC/SYSOI.ai/rules/branches/development

# Update a stuck (BEHIND) promotion branch — prefer merge commit, NOT rebase
#   (do this via the GitHub "Update branch" button; direct pushes are blocked)
```

### Golden rules
1. **All PRs target `development`.** Promote to `main` only via a `development → main` PR.
2. **Never add a `push` trigger for `development` or feature branches** — that
   re-introduces the duplicate-check deadlock.
3. A job's `name:` **is** its required-check context — keep workflow `name:`
   fields and ruleset required-check names in lockstep.
4. "N of N expected" = ambiguous/missing context, not a failing test. Don't reach
   for `--admin`; recreate from a clean base.

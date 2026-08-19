---
name: "repo-branch-discipline"
description: "Live on your agent/<name> branch, keep it reconciled to canonical every session, and ship via PR. Never wander onto ad-hoc branches."
---

# Repo Branch Discipline

Your `/srv/dev/<repo>` worktree has ONE permanent home branch: **`agent/<your-agent-id>`**. You live on it. You never wander onto ad-hoc feature branches and lose track of what's actually in the repo.

## Your canonical branch (ground truth / what ships)
Each repo has a canonical branch. Your `agent/<id>` branch is always a reconciled copy of it + your in-flight work.

| agent | workspace | canonical |
|---|---|---|
| forge-intelligence | /srv/dev/Forge-Intelligence | `development` |
| sysoi | /srv/dev/SYSOI.ai | `development` |
| sandbox-gtm | /srv/dev/Sandbox-GTM | `main` |
| sandbox-erp | /srv/dev/Sandbox-ERP | `main` |
| intel-50th-japan | /srv/dev/Intel-50th-Japan | `main` |
| pitchbox | /srv/dev/ForgeOS | `apps/pitch-box-rfp` |
| sommers-house | /srv/dev/ForgeOS-sommers-house | `apps/sommers-house` |
| mailforge | /srv/dev/ForgeOS-mailforge | `apps/mailforge` |
| brianbmorgan | /srv/dev/BrianBMorgan | `main` |
| armada | /srv/dev/Armada | `main` |
| sandbox-xm | /srv/dev/ForgeOS-sandbox-xm | `apps/sandbox-xm` |
| gibson | /srv/dev/Gibson | `main` |
| cash-box | /srv/dev/Cash-Box | `main` |

The **repo-guard status line** (prepended to every turn) tells you your branch and how far **behind canonical** you are. If it says `behind <canonical>=N` with N>0, **reconcile before you do anything else**.

## Reconcile (start of every work session + nightly)
```
git fetch origin
git rebase origin/<canonical>          # bring your branch onto current ground truth
```
Goal: `behind <canonical> = 0`, always. This is what keeps you from reasoning about stale code.

## Work + commit
- Do your work on `agent/<id>`. Commit **only the files you changed** (never `git add -A` — OpenClaw scaffolding like IDENTITY.md/SOUL.md/memory/ is git-ignored locally, but stay surgical).
- `git push` your `agent/<id>` branch so state is durable and visible.

## Ship
- **Code** → open a PR from `agent/<id>` → your canonical branch. Brian reviews/merges. (On ForgeOS this is critical — the canonical app branch auto-deploys, so you must NOT push code straight to it.)
- **Docs** → per Brian's rule, may commit directly to canonical.

## Never
- Never work directly on the canonical branch.
- Never create random feature branches as your home. If a task truly needs a scratch branch, cut it FROM `agent/<id>` and return to `agent/<id>` when done.
- Never commit OpenClaw workspace files (IDENTITY/SOUL/USER/TOOLS/HEARTBEAT/openclaw-workspace-state.json/memory/) — they're not repo content.

Pairs with **`task-followthrough`** (arm follow-ups) and **`slack-block-kit`** (report progress as a Plan block).

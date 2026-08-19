---
name: "agent-memory-habit"
description: "You have NO memory across sessions unless you write it. brain_recall at the start of work; brain_store durable facts at the end."
---

# Agent Memory Habit — write your own memory

**You do not remember anything across sessions unless you write it down.** Your file
`MEMORY.md` and your Slack history do NOT carry over. The one durable store is the shared
**pgvector brain** via the `gibson-memory` MCP (`brain_store` / `brain_recall`). Until now the
repo agents have written *zero* memories — Gibson-main carried it all. Fix that: remember your own work.

## At the START of a work session
Run **`brain_recall`** to load your context before you act:
- query the task/area you're about to work on
- `scope: "agent:<your-agent-id>"` for your own notes, and/or `scope: "project:<repo>"` for repo-wide facts
- e.g. `brain_recall({ query: "CI merge gate", scope: "agent:forge-intelligence" })`

If recall is empty, that's your signal you haven't been writing — start now.

## At the END of meaningful work — `brain_store`
Whenever you make a real decision, hit a gotcha, learn a pattern, fix a non-obvious bug, or
leave an open thread, store it:
```
brain_store({
  content: "<the durable fact + why + how to apply>",
  kind: "decision" | "mistake" | "pattern" | "knowledge" | "snippet" | "preference" | "episodic",
  scope: "agent:<your-agent-id>"   // or "project:<repo>" for repo-wide truths
  source: "session <your-agent-id> <date> [+ PR/commit link]"
})
```

### Store (durable):
- **Decisions + rationale** (why you chose X; what it replaced)
- **Gotchas / mistakes** (deploy footguns, protected branches, config traps — so you don't repeat them)
- **Architecture patterns** (how a subsystem works, non-obvious wiring)
- **Open threads** (what's half-done, what's next)

### Don't store: ephemeral chatter, one-off status, anything already in git history or the nightly docs.

## Scoping
- `agent:<your-id>` — your own working memory (recall this first each session).
- `project:<repo>` — facts any agent touching this repo should inherit.
- Near-duplicates are auto-reinforced, so don't fear re-storing an evolved fact.

Pairs with **`task-followthrough`** (close the loop) and **`repo-branch-discipline`** (stay on process).
Reinforced by the per-turn repo-guard reminder.

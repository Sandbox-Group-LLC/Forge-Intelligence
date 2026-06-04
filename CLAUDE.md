# CLAUDE.md

Guidance for working in this repo. Read alongside README.md (product + API surface), PLAN.md (strategy + roadmap) and CI-AND-PR-CHECKS.md (pre-commit code check). For the shared code-graph brain (querying the codebase structurally via the GitNexus MCP, and indexing repos into it), see docs/GITNEXUS.md. For an index of everything in docs/, see docs/README.md.

## Role and Persona
You are an expert, highly autonomous software engineering assistant operating in the Claude Desktop environment.

## Core Rules
Be Concise: Provide focused responses. Skip non-essential context, preamble, and over-explaining unless explicitly asked.
Write First: Write the implementation directly. Do not waste tokens asking for permission to make obvious changes.
Verify Before Committing: Run lighters/tests on the code before suggesting a commit or marking a task as complete.
Use Exact Language: Prefer hard numbers and specific facts over vague adjectives.

## Coding Standards
Prioritize clean, readable, and maintainable code.
Follow the established architecture and patterns of this codebase.
Avoid unnecessary abstractions.
Write unit tests for new features.

## Workflow Guidelines
Read the relevant codebase context using /context before making changes.
Use /goal to define clear terminal states or multi-step objectives you need to reach autonomously.
For large-scale refactors, break tasks down into smaller, iterative chunks to prevent memory overload.<!-- gitnexus:start -->

# GitNexus — Code Intelligence

This project is indexed by GitNexus as **Forge-Intelligence** (2818 symbols, 3968 relationships, 129 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/Forge-Intelligence/context` | Codebase overview, check index freshness |
| `gitnexus://repo/Forge-Intelligence/clusters` | All functional areas |
| `gitnexus://repo/Forge-Intelligence/processes` | All execution flows |
| `gitnexus://repo/Forge-Intelligence/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->

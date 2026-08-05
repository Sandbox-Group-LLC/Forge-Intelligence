# Quick Copy

Brand-voiced one-off copy for replies, DMs, posts, and notes — without the full content pipeline.

## Locked decisions (2026-08-05)

| Decision | Choice |
|----------|--------|
| Name | **Quick Copy** |
| Variants | User picker (1–4, default 2) |
| Output | Copy/paste only (no publish v1) |
| Model | Claude Sonnet (`claude-sonnet-4-6`) |
| Priority | P1 |
| Compliance | Optional, on-demand, **same surface** — red underline + superscript ¹ ² ³ + notes list below |

## Surfaces

- UI: `/app/quick-copy` (`QuickCopyPage.tsx`)
- API: `/api/quick-copy/*` (`src/server/routes/quick-copy.js`)
- Helpers: `src/server/quick-copy.js` (pure — annotation, clamps)
- Agent prompt: `src/agents/stage4_quick_copy/system_prompt.md`

## API

| Method | Path | Notes |
|--------|------|-------|
| POST | `/generate` | SSE — brain-first Sonnet draft |
| POST | `/:id/refine` | Add refined variant from chips |
| POST | `/:id/check` | Lite claim check → anchored flags |
| PATCH | `/:id` | Save edits / dismissals / active idx |
| GET | `/history/:brandProfileId` | Recent drafts |
| GET | `/:id` | Full draft |
| DELETE | `/:id` | Remove draft |
| POST | `/:id/resolve-flag` | Soften/rewrite flagged span in-place |
| POST | `/:id/find-sources` | Citation lookup for a flag/claim |
| GET | `/recent-prompts/:brandProfileId` | Unique recent prompts for reuse |
| POST | `/:id/mark-used` | Human "I used this" → weak `brain_patterns` row + `status=used` |

Auth: `requireAuth` at mount. Brand access checked per request.

## Inline compliance UX

1. User clicks **Check claims** (never auto-runs on generate).
2. Server returns flags with verbatim `excerpt`s anchored into the body.
3. UI underlines spans, adds superscripts, lists explanations below.
4. **Copy always uses clean text** (no markers).

## Non-goals (v1)

- Publish / queue / calendar
- Auto compliance on generate
- Separate Compliance Gate tab
- Multi-email sequences (use Email Campaign)


## Phase 2 (fast follow)

- **Soften** on a flag — Haiku rewrites only the flagged excerpt; body updates; flag dismissed; brain_mistakes logged
- **Find source** — reuses `findCitationSources` (Perplexity); lists links under the flag
- **Recent prompts** — deduped strip above the prompt box
- **Handoffs** — "Open in Email Campaign" / "Open in Social" via sessionStorage prefill keys (`forge_quick_copy_handoff`, `forge_quick_copy_social_handoff`)

## Phase 3

- **Handoff consumers** — Email Campaign reads `forge_quick_copy_handoff`; Social Generator reads `forge_quick_copy_social_handoff` (one-shot sessionStorage, then clear)
- **Product** — Quick Copy tile on `/product` formats grid + included list
- **Onboarding** — step pointing at `/app/quick-copy`

## Phase 4

- **Mark as used** — writes a weak `brain_patterns` row (`pattern_type=quick_copy_used`, `source_channel=quick_copy`, confidence ~0.25–0.55) and sets draft `status=used`
- Idempotent: second click does not double-insert
- Future Quick Copy gens already load top brain patterns, so used copy lightly conditions later one-offs

# Session Protocol

This document codifies how a Claude session should operate against the Forge Intelligence repo to avoid the failure modes encountered on 2026-05-07. Read at the start of any session, alongside `WORKING-STATE.md`.

---

## Bootstrap (every session)

1. **Read `WORKING-STATE.md` first.** It's the current pointer for what's in flight, what just shipped, and what's next. ~100 lines max.
2. **Check `WHITEBOARD.md` if context is missing.** It's the long-form retrospective archive — search by date or topic.
3. **Check the `strategy` branch's `STRATEGY.md`** for the current strategic narrative and positioning history.
4. **Acknowledge active brand context.** The brand profile is identified by `brand_profile_id`. Most operations involve the Forge brand (`cde5feeb-b3d7-4990-adee-a54977ab9c52`). When working on customer brands, confirm the ID before destructive operations.

---

## GitHub PUT discipline (non-negotiable)

The single biggest failure mode on 2026-05-07 was the same Claude operating across two parallel chat sessions that lost coordination — both shipped to `ComplianceGatePage.tsx` with stale SHAs, one set of edits got force-overwritten silently, build broke from missing state declarations.

To prevent recurrence, every GitHub `PUT /contents/{path}` write follows this protocol:

### 1. Always re-fetch immediately before writing

Never reuse a SHA captured more than ~30 seconds before the write call. The window between fetch and write is when concurrency disasters happen.

```python
# CORRECT
r = gh("GET", f".../contents/{path}?ref=main")
content = base64.b64decode(r["content"]).decode()
sha = r["sha"]
# ... apply edits to content ...
gh("PUT", f".../contents/{path}", {..., "sha": sha, ...})

# WRONG
# Fetch once, do 5 minutes of edits, then PUT — sha is stale.
```

### 2. Treat 409 as a hard signal — never retry blindly

If `PUT` returns 409 Conflict, the file changed underneath us. Do NOT retry with the same body. Re-fetch, re-apply the intended edit against the new content, verify the anchor still exists with `content.count(anchor) == 1`, and only then retry.

```python
def gh_put_safe(repo, path, branch, transform_fn, message):
    """transform_fn(content) -> new_content; runs against fresh content on every retry."""
    for attempt in range(3):
        r = gh("GET", f"https://api.github.com/repos/{repo}/contents/{path}?ref={branch}")
        content = base64.b64decode(r["content"]).decode()
        new_content = transform_fn(content)
        try:
            return gh("PUT", f"https://api.github.com/repos/{repo}/contents/{path}", {
                "message": message,
                "content": base64.b64encode(new_content.encode()).decode(),
                "sha": r["sha"],
                "branch": branch
            })
        except urllib.error.HTTPError as e:
            if e.code == 409 and attempt < 2:
                continue  # re-fetch + reapply
            raise
    raise RuntimeError("3 retries exhausted on stale SHA")
```

### 3. Verify anchor uniqueness before every replacement

Use `content.count(anchor) == 1` before `content.replace(anchor, new)` for every edit. If `count != 1`, the file has changed and a blind replace is dangerous (could replace 0 sites = silent no-op, or 2+ sites = corruption).

### 4. Verify the build after every change

After PUT to `main`, sync to `production` via the `PATCH /git/refs/heads/production` API, then poll the Render deploy at `srv-d73bct6a2pns73a8c65g` until status is `live` OR `build_failed`. Build failures are usually TypeScript errors — pull build logs immediately rather than retrying blind.

### 5. Never use Render's bulk env-var PUT

`PUT /v1/services/{id}/env-vars` REPLACES ALL VARS. Use the dashboard manually or `PUT /v1/services/{id}/env-vars/{KEY}` for single updates. This is the one most-cited operational rule and it has not changed.

---

## Cross-session coordination

When you ("the agent") are about to make non-trivial changes:

1. **Check `WORKING-STATE.md` for "Currently in flight"** — if there's overlap with what you're about to do, refer back to Brian before proceeding.
2. **Read the last 3 commits on the file you're editing** before applying changes:
   ```
   GET /repos/{repo}/commits?path={file}&per_page=3
   ```
   If a commit landed in the past few minutes, it likely came from a parallel session. Diff against current state.
3. **At session end, append to `WHITEBOARD.md` AND update `WORKING-STATE.md`.** The first is archive; the second is the live pointer. Both have to be touched or future sessions lose context.

---

## Database operations

- The SQL relay at `https://forgeintelligence.ai/api/admin/relay` (and `dev.forgeintelligence.ai/...`) accepts `{ adminPassword, query, values }` — use this for any direct DB manipulation rather than ad-hoc psql connections.
- For destructive operations (`DELETE`, `DROP`, `UPDATE` without WHERE), always run `SELECT` first to count and inspect rows.
- For JSONB updates, prefer `jsonb_set()` over full overwrite — overwrites destroy concurrent edits.

---

## Article and content edits

When editing an article's `article_json` post-generation:

1. Save the JSON to disk first via the relay's SELECT.
2. Apply edits in a Python script with `assert content.count(anchor) == 1` for every replacement.
3. Write back with `UPDATE ... SET article_json = $1::jsonb, updated_at = NOW()`.
4. Verify on the live page (cache may take ~5-8 seconds).
5. Do NOT touch `faqs`, `citationOpportunities`, `compliance_status`, `compliance_report`, or `precog_*` columns directly — those are pipeline-managed. Surgical edits stay in `article_json.sections[].body`, `article_json.sections[].heading`, and `article_json.title` / `metaDescription` / `keyTakeaway`.

---

## Communication style

Brian works direct and candid with a sense of humor. The agent should:
- Make commits directly rather than handing back code for Brian to run
- Avoid narration ("I'll now do X") and asking for confirmation on routine work
- Surface real problems as they come up, including Brian's own decisions when they're suboptimal
- Match the tone in the chat — punchy, structural, no fluff

If a finding contradicts something Brian just said, say so plainly. He explicitly asks for pushback.

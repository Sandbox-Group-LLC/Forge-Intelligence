# My Website Integration

Publish Forge-generated articles directly to your own self-hosted site via an authenticated webhook. Forge POSTs each article payload to an endpoint you control; your site decides how to store and render it.

## Setup (Forge side)

1. **Brand Settings → Integrations → My Website**
2. Paste your receiver URL (e.g. `https://yoursite.com/api/forge/publish`)
3. Choose payload format: `html`, `markdown`, or `both`
4. Click **Generate token** — copy it immediately, you won't see it again
5. Click **Send test payload** to verify your receiver is wired up

## Payload schema

Every successful publish sends:

```json
{
  "slug": "event-pipeline-attribution-...",
  "title": "Event Pipeline Attribution: ...",
  "excerpt": "First 200 chars of the article body, plaintext.",
  "heroImageUrl": "https://cdn.example.com/image.png",
  "canonical": "https://forgeintelligence.ai/articles/<brand>/<slug>",
  "publishedAt": "2026-05-22T00:11:23.450Z",
  "meta": {
    "description": "...",
    "ogImage": "https://cdn.example.com/image.png",
    "utm": { "utm_source": "website", "utm_medium": "blog", ... }
  },
  "html": "<article>...</article>",
  "markdown": "# ...\n\n## ..."
}
```

The `html` and `markdown` fields are present based on your format setting. `test: true` is added on test payloads only.

## Authentication

Every request includes:

```
Authorization: Bearer forge_pub_<your-token>
Content-Type: application/json
User-Agent: Forge-Intelligence/1.0
```

Validate the token by comparing the `Authorization` header to a value stored in your server environment (NEVER hard-code it in source).

## Expected response

Return **HTTP 200** on success. Optionally return JSON with a `url` field — Forge will use it as the `published_url` in the Publishing Queue so the "View on site" link works:

```json
{ "ok": true, "url": "https://yoursite.com/articles/your-slug" }
```

Return any non-2xx status on failure. The response body (first 300 chars) appears in Forge's publish log error message.

---

## Sample receiver: Node + Express + Postgres

This is what we built for **Sandbox-GTM** (Render + Neon stack). Adapt to your DB schema.

```js
// app.js (or routes/forge.js)
import express from 'express';
import pkg from 'pg';
const { Pool } = pkg;

const router = express.Router();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Required env: FORGE_BEARER_TOKEN — the exact value Forge displayed once
// when you clicked "Generate token" in the Forge Integrations UI.
const FORGE_TOKEN = process.env.FORGE_BEARER_TOKEN;

router.post('/api/forge/publish', express.json({ limit: '2mb' }), async (req, res) => {
  // 1. Auth check — constant-time compare to defeat timing attacks
  const auth = req.headers.authorization || '';
  const provided = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!FORGE_TOKEN || provided.length !== FORGE_TOKEN.length) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  // Buffer.from + timingSafeEqual avoids early-exit string comparison
  const { timingSafeEqual } = await import('crypto');
  const a = Buffer.from(provided);
  const b = Buffer.from(FORGE_TOKEN);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  // 2. Parse the payload
  const { slug, title, excerpt, heroImageUrl, canonical, publishedAt, meta, html, markdown, test } = req.body || {};
  if (!slug || !title) return res.status(400).json({ error: 'slug and title required' });

  // 3. (Optional) Drop test payloads — don't pollute the live articles table
  if (test) return res.json({ ok: true, test: true, message: 'test received' });

  // 4. Upsert into your articles table
  // Schema assumed:
  //   CREATE TABLE articles (
  //     slug          TEXT PRIMARY KEY,
  //     title         TEXT NOT NULL,
  //     excerpt       TEXT,
  //     hero_image    TEXT,
  //     canonical_url TEXT,
  //     meta          JSONB,
  //     html          TEXT,
  //     markdown      TEXT,
  //     published_at  TIMESTAMPTZ,
  //     created_at    TIMESTAMPTZ DEFAULT NOW(),
  //     updated_at    TIMESTAMPTZ DEFAULT NOW()
  //   );
  await pool.query(
    `INSERT INTO articles (slug, title, excerpt, hero_image, canonical_url, meta, html, markdown, published_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
     ON CONFLICT (slug) DO UPDATE SET
       title = EXCLUDED.title,
       excerpt = EXCLUDED.excerpt,
       hero_image = EXCLUDED.hero_image,
       canonical_url = EXCLUDED.canonical_url,
       meta = EXCLUDED.meta,
       html = EXCLUDED.html,
       markdown = EXCLUDED.markdown,
       published_at = EXCLUDED.published_at,
       updated_at = NOW()`,
    [slug, title, excerpt || null, heroImageUrl || null, canonical || null,
     JSON.stringify(meta || {}), html || null, markdown || null, publishedAt || null]
  );

  // 5. Return the public URL — Forge displays this in the Publishing Queue
  const publicUrl = `https://yoursite.com/articles/${slug}`;
  res.json({ ok: true, url: publicUrl });
});

export default router;
```

### Env var

```bash
# Render dashboard → Environment → Add Environment Variable
FORGE_BEARER_TOKEN=YOUR_BEARER_TOKEN_HERE   # the forge_pub_... value from Forge's UI
```

### DB schema (Neon / Postgres)

```sql
CREATE TABLE IF NOT EXISTS articles (
  slug          TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  excerpt       TEXT,
  hero_image    TEXT,
  canonical_url TEXT,
  meta          JSONB,
  html          TEXT,
  markdown      TEXT,
  published_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS articles_published_at_idx ON articles(published_at DESC);
```

---

## Sample receiver: Next.js App Router

```ts
// app/api/forge/publish/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';
import { sql } from '@vercel/postgres'; // or your DB client

const FORGE_TOKEN = process.env.FORGE_BEARER_TOKEN!;

export async function POST(req: NextRequest) {
  // Auth check
  const auth = req.headers.get('authorization') || '';
  const provided = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!FORGE_TOKEN || provided.length !== FORGE_TOKEN.length) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (!timingSafeEqual(Buffer.from(provided), Buffer.from(FORGE_TOKEN))) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const body = await req.json();
  const { slug, title, excerpt, heroImageUrl, canonical, publishedAt, meta, html, markdown, test } = body;
  if (!slug || !title) return NextResponse.json({ error: 'slug and title required' }, { status: 400 });
  if (test) return NextResponse.json({ ok: true, test: true });

  await sql`
    INSERT INTO articles (slug, title, excerpt, hero_image, canonical_url, meta, html, markdown, published_at, updated_at)
    VALUES (${slug}, ${title}, ${excerpt || null}, ${heroImageUrl || null}, ${canonical || null},
            ${JSON.stringify(meta || {})}, ${html || null}, ${markdown || null}, ${publishedAt || null}, NOW())
    ON CONFLICT (slug) DO UPDATE SET
      title = EXCLUDED.title, excerpt = EXCLUDED.excerpt, hero_image = EXCLUDED.hero_image,
      canonical_url = EXCLUDED.canonical_url, meta = EXCLUDED.meta,
      html = EXCLUDED.html, markdown = EXCLUDED.markdown,
      published_at = EXCLUDED.published_at, updated_at = NOW()
  `;

  return NextResponse.json({ ok: true, url: `https://yoursite.com/articles/${slug}` });
}
```

---

## Sample receiver: filesystem (static-site rebuilds)

For sites that read articles from disk and rebuild on file change (Astro, Eleventy, Next.js static export, etc.):

```js
// app.js
import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import { timingSafeEqual } from 'crypto';

const FORGE_TOKEN = process.env.FORGE_BEARER_TOKEN;
const CONTENT_DIR = path.join(process.cwd(), 'content', 'articles');

const router = express.Router();

router.post('/api/forge/publish', express.json({ limit: '2mb' }), async (req, res) => {
  const auth = req.headers.authorization || '';
  const provided = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!FORGE_TOKEN ||
      provided.length !== FORGE_TOKEN.length ||
      !timingSafeEqual(Buffer.from(provided), Buffer.from(FORGE_TOKEN))) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const { slug, title, markdown, meta, publishedAt, heroImageUrl, test } = req.body;
  if (!slug || !markdown) return res.status(400).json({ error: 'slug and markdown required' });
  if (test) return res.json({ ok: true, test: true });

  // Write as a frontmatter-prefixed markdown file. Adjust frontmatter
  // shape to whatever your static-site generator expects.
  const frontmatter = [
    '---',
    `title: ${JSON.stringify(title)}`,
    `slug: ${slug}`,
    `publishedAt: ${publishedAt}`,
    `heroImage: ${heroImageUrl || ''}`,
    `description: ${JSON.stringify(meta?.description || '')}`,
    '---',
    '',
  ].join('\n');

  await fs.mkdir(CONTENT_DIR, { recursive: true });
  await fs.writeFile(path.join(CONTENT_DIR, `${slug}.md`), frontmatter + markdown, 'utf8');

  // OPTIONAL: trigger a rebuild here (Netlify build hook, Vercel
  // deployment webhook, GitHub commit, etc.) so the new file goes live.

  res.json({ ok: true, url: `https://yoursite.com/articles/${slug}` });
});

export default router;
```

⚠️ **Doesn't work on serverless runtimes** (Vercel, Netlify Functions) — those filesystems are read-only at runtime. Use the database receiver instead, or trigger a git commit + redeploy from your receiver.

---

## Rotating the token

If you suspect compromise, hit **Rotate token** in the Forge UI. The old token is invalidated immediately and a new one is displayed once. Your site will reject Forge publishes until you update `FORGE_BEARER_TOKEN` in your environment to match.

## Disconnecting

Hit **Disconnect** in the Forge UI. Forge stops sending publishes to your endpoint but retains the configuration in case you reconnect — no need to regenerate the token unless you also rotate it.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Test publish returns 401 | Bearer token in your env doesn't match what Forge stored. Rotate + update both sides. |
| Test publish returns 404 | Endpoint URL is wrong or your route handler isn't registered. |
| Test publish returns 5xx | Your DB insert / file write failed. Check your server logs. |
| Forge publishes succeed but the article doesn't appear on your site | Receiver isn't actually persisting (check DB) or your site's article route doesn't read from the right source. |
| Publish log shows "Receiver returned HTTP N" | Your endpoint returned a non-2xx status. The response body (first 300 chars) is in the error message. |

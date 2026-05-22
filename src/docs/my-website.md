# My Website

Publish Forge-generated articles directly to your own self-hosted site via an authenticated webhook. Forge sends each article to an endpoint you control; your site decides how to store and render it.

This integration is built for teams who own their stack — custom sites on React, Next.js, Astro, Vite, Nuxt, SvelteKit, or any traditional Node/Express setup. If you're on WordPress, Webflow, Ghost, or HubSpot, use the dedicated integration for that platform instead.

## How it works

1. You configure a receiver URL on your site (e.g. `https://yoursite.com/api/forge/publish`).
2. You generate a Forge-issued bearer token and add it to your server environment.
3. When you publish an article in Forge, Forge POSTs the article payload to your endpoint with the bearer token in the `Authorization` header.
4. Your endpoint validates the token, stores the article (database, filesystem, whatever fits), and returns `200 OK`.

Forge captures the response and surfaces a "View on site" link in the Publishing Queue.

## Setup in Forge

1. **Brand Settings → Integrations → My Website**
2. Paste your receiver URL into the **Receiver endpoint URL** field
3. Choose payload format: `html`, `markdown`, or `both`
4. Click **Save config**
5. Click **Generate token** — your token will be shown **once**. Copy it immediately.
6. Click **Send test payload** to verify your receiver is wired up correctly before going live

The token follows the format `forge_pub_<64 hex chars>`. Treat it like any other API secret — never commit it to source control.

## Payload schema

On a successful publish, Forge sends:

```json
{
  "slug": "your-article-slug",
  "title": "Your Article Title",
  "excerpt": "Short description — the article's meta description.",
  "heroImageUrl": "https://cdn.example.com/image.png",
  "canonical": "https://forgeintelligence.ai/articles/your-brand/your-article-slug",
  "publishedAt": "2026-05-22T00:11:23.450Z",
  "meta": {
    "description": "SEO meta description",
    "ogImage": "https://cdn.example.com/image.png",
    "utm": { "utm_source": "website", "utm_medium": "blog", "utm_campaign": "..." }
  },
  "html": "<article>...</article>",
  "markdown": "# ...\n\n## ..."
}
```

`html` and `markdown` are included based on your format setting. Test payloads include `"test": true` so your receiver can drop them without polluting your live articles table.

## Authentication

Every request includes:

```
Authorization: Bearer forge_pub_<your-token>
Content-Type: application/json
User-Agent: Forge-Intelligence/1.0
```

Validate the token by comparing the `Authorization` header to a value stored in your server environment. **Never hardcode it in source.** Use a constant-time comparison (`crypto.timingSafeEqual`) to defeat timing attacks.

## Expected response

Return **HTTP 200** on success. Optionally return JSON with a `url` field — Forge will use it as the published URL in the Publishing Queue so the "View on site" link works:

```json
{ "ok": true, "url": "https://yoursite.com/articles/your-slug" }
```

Return any non-2xx status on failure. Forge captures the first 300 chars of the response body and surfaces it in the publish log error message.

---

## Sample receiver: Node + Express + Postgres

A complete reference implementation. Drop this into your Express app and adapt the schema to your database.

```js
import express from 'express';
import { timingSafeEqual } from 'crypto';
import pkg from 'pg';
const { Pool } = pkg;

const router = express.Router();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Set this env var to the exact token Forge displayed in the
// "Generate token" modal. Never commit it to source.
const FORGE_TOKEN = process.env.FORGE_BEARER_TOKEN;

router.post('/api/forge/publish', express.json({ limit: '2mb' }), async (req, res) => {
  // 1. Auth — constant-time compare
  const auth = req.headers.authorization || '';
  const provided = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!FORGE_TOKEN || provided.length !== FORGE_TOKEN.length) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const a = Buffer.from(provided);
  const b = Buffer.from(FORGE_TOKEN);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  // 2. Parse the payload
  const { slug, title, excerpt, heroImageUrl, canonical, publishedAt, meta, html, markdown, test } = req.body || {};
  if (!slug || !title) return res.status(400).json({ error: 'slug and title required' });

  // 3. Test payloads: acknowledge but do not persist
  if (test) return res.json({ ok: true, test: true, message: 'test received' });

  // 4. Upsert into your articles table
  await pool.query(
    `INSERT INTO articles
       (slug, title, excerpt, hero_image, canonical_url, meta, html, markdown, published_at, updated_at)
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

  // 5. Tell Forge where it landed
  const publicUrl = `https://yoursite.com/articles/${slug}`;
  res.json({ ok: true, url: publicUrl });
});

export default router;
```

### Environment variable

```bash
FORGE_BEARER_TOKEN=YOUR_BEARER_TOKEN_HERE
```

Replace `YOUR_BEARER_TOKEN_HERE` with the exact value Forge displayed in the **Generate token** modal.

### Database schema

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
import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';
import { sql } from '@vercel/postgres';

const FORGE_TOKEN = process.env.FORGE_BEARER_TOKEN!;

export async function POST(req: NextRequest) {
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
    INSERT INTO articles
      (slug, title, excerpt, hero_image, canonical_url, meta, html, markdown, published_at, updated_at)
    VALUES
      (${slug}, ${title}, ${excerpt || null}, ${heroImageUrl || null}, ${canonical || null},
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

Place this at `app/api/forge/publish/route.ts` in your Next.js project.

---

## Sample receiver: filesystem (static-site rebuilds)

For sites that read articles from disk and rebuild on file change (Astro, Eleventy, Next.js static export, etc.):

```js
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

  // Optional: trigger a rebuild here (Netlify build hook, Vercel
  // deployment webhook, GitHub commit, etc.) so the new file goes live.

  res.json({ ok: true, url: `https://yoursite.com/articles/${slug}` });
});

export default router;
```

> Doesn't work on serverless runtimes. Vercel Functions and Netlify Functions have read-only filesystems at runtime. If you're on serverless, use the database receiver instead, or have your receiver commit to git and trigger a redeploy.

---

## Rotating the token

If your token is compromised or you want to rotate on a schedule, click **Rotate token** in the Forge UI. The old token is invalidated immediately and a new one is displayed once. Your site will reject Forge publishes until you update `FORGE_BEARER_TOKEN` in your environment to match.

## Disconnecting

Click **Disconnect** in the Forge UI. Forge stops sending publishes to your endpoint but retains the configuration in case you reconnect — you don't need to regenerate the token unless you also rotate it.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Test publish returns 401 | Bearer token in your env doesn't match what Forge stored. Rotate + update both sides. |
| Test publish returns 404 | Endpoint URL is wrong or your route handler isn't registered. |
| Test publish returns 5xx | Your DB insert / file write failed. Check your server logs. |
| Publish log shows "Receiver returned HTTP N" | Your endpoint returned a non-2xx status. The response body (first 300 chars) is in the error message. |
| Forge publishes succeed but the article doesn't appear on your site | Receiver isn't actually persisting (check DB), or your site's article route isn't reading from the right source. |
| Article renders but the lead paragraph appears twice | Your template is rendering both `excerpt` and the first body paragraph. Either drop one in the template, or skip the body's first paragraph when `excerpt` is present. |

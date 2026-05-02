# Enterprise Isolation Deployment Playbook

> Repeatable process for deploying a fully isolated Forge Intelligence instance for enterprise clients.
> Each deployment gets its own database, auth, subdomain, and branch. Same codebase, zero shared data.
>
> **Pricing:** $2,400/year add-on
> **Setup time:** Under 1 hour
> **First deployment:** Intel Corporation (April 18, 2026)

---

## Prerequisites

- Render account with access to Forge Intelligence repo
- Namecheap DNS access for forgeintelligence.ai
- Clerk account access
- Neon account access
- GitHub repo access (Sandbox-Group-LLC/Forge-Intelligence)

---

## Step 1: Neon — Create Isolated Database (2 min)

1. Go to [Neon Console](https://console.neon.tech)
2. **Create Project** — name it after the client (e.g., `intel_corporation`)
3. Copy the `NEON_DATABASE_URL` connection string
4. Save it — you'll need it for Render

---

## Step 2: GitHub — Create Client Branch (2 min)

1. Create a new branch from `production`:
   - Branch name: client name, capitalized (e.g., `Intel`)
   - This branch receives client-specific customizations (super admin IDs, removed payment gate, Clerk config)
2. The branch inherits ALL production code including `init-schema.sql`

---

## Step 3: Render — Create Service (5 min)

1. Go to [Render Dashboard](https://dashboard.render.com)
2. **New Web Service** → connect to `Sandbox-Group-LLC/Forge-Intelligence`
3. Configure:
   - **Name:** Client name (e.g., `Intel`)
   - **Branch:** The client branch from Step 2
   - **Build Command:** `npm install; npm run build`
   - **Start Command:** `npm run start`
   - **Region:** Oregon (or closest to client)
   - **Plan:** Starter
4. **Link the shared env group** (`evg-d78c5o2a214c73a4gfu0`) — this provides `ANTHROPIC_API_KEY`, `PERPLEXITY_API_KEY`, and other shared secrets
5. **Add service-level env vars** (these override the env group):
   - `NEON_DATABASE_URL` = connection string from Step 1
   - `ADMIN_PASSWORD` = `zp3wlGP0uft-KRjZDtf6Er6Fn6U3RaSPgBzWK_L3Vtg`
   - `VITE_CLERK_PUBLISHABLE_KEY` = (from Step 4 below)
   - `CLERK_SECRET_KEY` = (from Step 4 below — the `sk_live_...` key, NOT the PEM public key)
   - `CLERK_JWKS_URL` = (from Step 4 below)
6. Note the Render subdomain URL (e.g., `intel-7owm.onrender.com`) — needed for DNS

---

## Step 4: Clerk — Create Auth Instance (10 min)

1. Go to [Clerk Dashboard](https://dashboard.clerk.com)
2. **Create Application** — name it after the client
3. Configure the application:
   - **Domain:** `{client}.forgeintelligence.ai` (custom domain)
   - Sign-in URL will be: `accounts.{client}.forgeintelligence.ai/sign-in`
4. **JWT Templates** → Create a template called `jwt-template-600`:
   - Use default claims (the server only reads `sub` for user ID)
   - Set lifetime to 600 seconds
5. Copy these values for Render env vars:
   - **Publishable Key** (`pk_live_...`) → `VITE_CLERK_PUBLISHABLE_KEY`
   - **Secret Key** (`sk_live_...`) → `CLERK_SECRET_KEY` (dig for this — it's not the PEM key shown on the first page)
   - **JWKS URL** → `https://clerk.{client}.forgeintelligence.ai/.well-known/jwks.json` → `CLERK_JWKS_URL`

---

## Step 5: Namecheap — Configure Subdomain (5 min)

1. Go to Namecheap → forgeintelligence.ai → **Advanced DNS**
2. Add a **CNAME record**:
   - **Host:** `{client}` (e.g., `intel`)
   - **Value:** Render service's `.onrender.com` domain
   - **TTL:** Automatic
3. In Render → client service → **Settings** → **Custom Domains** → add `{client}.forgeintelligence.ai`
4. Wait for SSL certificate provisioning (1-2 min)

---

## Step 6: Initialize Database (2 min)

Once the service deploys and the relay is accessible:

```bash
# Test the relay
curl -X POST -H "Content-Type: application/json" \
  "https://{client}.forgeintelligence.ai/api/admin/relay" \
  -d '{"adminPassword": "...", "query": "SELECT 1"}'

# Run init-schema.sql — execute each CREATE TABLE statement
# (Use the Python script from the Intel deployment session,
#  or run statements manually via relay)
```

The `init-schema.sql` file in the repo contains all 30 CREATE TABLE statements. Run them sequentially via the relay endpoint.

**Verify:** `SELECT count(*) FROM pg_tables WHERE schemaname = 'public'` should return 30+.

---

## Step 7: Client Branch Customizations (5 min)

On the client branch, make these changes:

### a) Remove payment gate
In `src/components/Sidebar.tsx`, empty the `LOCKED_ROUTES` array:
```typescript
const LOCKED_ROUTES: string[] = []; // Enterprise: no payment gate
```

### b) Add client super admin
In `server.js`, add the client's Clerk user ID to `SUPER_ADMIN_IDS`:
```javascript
SUPER_ADMIN_IDS = [
  'user_3BtC7nusm7CShN7EdUYaaLZcDwp', // sandbox-xm
  'user_3CJmE0WkOj1RJC5yF99scEuwUpO', // therosethyme
  'user_XXXXXXXXXXXXXXXXXXXXXXXXXXXX', // client admin
];
```

### c) Fix landing page sign-in links
In `src/Landing.tsx`, update the Clerk URLs:
```
accounts.forgeintelligence.ai → accounts.{client}.forgeintelligence.ai
forgeintelligence.ai/app/context-hub → {client}.forgeintelligence.ai/app/context-hub
```

### d) ClerkProvider redirect
In `src/main.tsx`, add origin-aware redirect:
```typescript
<ClerkProvider
  publishableKey={...}
  afterSignInUrl={window.location.origin + "/app/context-hub"}
  afterSignUpUrl={window.location.origin + "/app/context-hub"}
>
```

---

## Step 8: Port Brand Profile (2 min)

If the client already has a brand profile on production:

```sql
-- On production: export the brand profile
SELECT id, brand_url, brand_name, version, profile_data, settings
FROM brand_profiles WHERE id = '{brand_id}';

-- On client relay: insert with client's Clerk user ID
INSERT INTO brand_profiles (id, brand_url, brand_name, version, is_active,
  cache_status, profile_data, settings, clerk_user_id, is_paid)
VALUES ($1, $2, $3, $4, true, 'fresh', $5, $6, '{clerk_user_id}', true);
```

---

## Architecture Notes

- **Same codebase** — client branch only diverges for auth config and gate removal
- **Shared env group** provides API keys; service-level `NEON_DATABASE_URL` overrides the shared DB
- **No cross-contamination** — each deployment hits its own Neon project
- **Auto-deploys** — commits to the client branch trigger Render builds
- **Syncing** — to port production features to a client branch, use surgical file-level commits (not git merge, which conflicts on customized files)

---

## Active Deployments

| Client | Branch | Subdomain | Neon Project | Render Service |
|--------|--------|-----------|--------------|----------------|
| (Production) | production | forgeintelligence.ai | forge_intelligence | srv-d73bct6a2pns73a8c65g |
| (Dev) | main | dev.forgeintelligence.ai | forge_intelligence | srv-d726u7ea2pns739kopmg |
| Intel | Intel | intel.forgeintelligence.ai | intel_corporation | srv-d7hs84lckfvc73eptcqg |

---

## Gotchas

1. **CLERK_SECRET_KEY** — Clerk buries the `sk_live_...` key. The first key shown is often the PEM public key. Dig into API Keys section.
2. **ADMIN_PASSWORD hyphen** — when pasting, the `-` character can get dropped. Verify via Render API: `GET /v1/services/{id}/env-vars`.
3. **VITE_ env vars are build-time** — changing them requires a full rebuild, not just a restart.
4. **JWT template name** — must be `jwt-template-600` exactly. The frontend hardcodes this name.
5. **Never use Render PUT /env-vars API** — it replaces ALL vars. Always use the dashboard or linked env group.
6. **Syncing branches** — use file-level commits from production, not `git merge`. Client branches have customizations that will conflict.
7. **TRIAL_LAUNCH_MARKER** — if the client deployment should NOT offer the 7-day trial (e.g., enterprise paid contract), set this env var to a far-future date (e.g., `2099-01-01T00:00:00Z`) so no users qualify. If it's an isolated SaaS deployment that should offer the trial, leave at default `2026-05-02T00:00:00Z` or set to deployment go-live date.
8. **Resend User-Agent header** — Resend's Cloudflare layer rejects requests without a `User-Agent` header (returns 403 / error 1010). All 6 Resend call sites in server.js now include `'User-Agent': 'Forge-Intelligence-Server/1.0'`. If you fork the email helpers, keep the UA header.
9. **Facebook Pipedream integration env vars** — if the client wants Facebook publishing, three env vars work together:
   - `PIPEDREAM_PROJECT_ID` — the Pipedream project where the customer's OAuth tokens are stored
   - `PIPEDREAM_PROJECT_ENVIRONMENT` — `production` (paid Pipedream Connect tier) or `development`
   - `FACEBOOK_PIPEDREAM_WORKFLOW_URL` — the Pipedream HTTP trigger URL for the Facebook publish workflow (Priority 0 path in server.js). Without this set, server falls back to legacy `pipedreamProxy()` direct Graph calls.
   - `PIPEDREAM_OAUTH_APP_ID_FACEBOOK` — custom OAuth client ID required for production end-user runs (Pipedream rejects official OAuth apps in production multi-tenant). Requires Meta Developer App + App Review. Until set, FB publishing stays in the empty/fallback state.

---

*Last updated: May 2, 2026*
*First deployment: Intel Corporation (April 18, 2026)*

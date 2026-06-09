# Forge video templates (Remotion)

Data-driven video compositions rendered on **Remotion Lambda + S3**. The backend
(`src/server/video.js`) invokes the deployed site via `renderMediaOnLambda`; it
does **not** bundle this code. This directory is the source of truth for what
gets deployed to the Lambda site.

## Architecture

- **`src/DataReel.tsx`** — the single productized composition. Fully data-driven:
  takes `inputProps = { brand, scenes[] }` (see `src/types.ts` for the contract).
  Seven scene archetypes: `hook | tags | orbit | pipeline | bars | curve | cta`.
  Per-scene voiceover is referenced by URL (S3) or bare filename (local).
- **`src/Root.tsx`** — registers `DataReel`; `calculateMetadata` derives the total
  frame count from `scenes`, so the backend only passes `{ brand, scenes }`.

## The five env vars (Forge env group)

| Var | Meaning |
|-----|---------|
| `REMOTION_AWS_ACCESS_KEY_ID` / `REMOTION_AWS_SECRET_ACCESS_KEY` | IAM user `remotion` creds |
| `REMOTION_AWS_REGION` | `us-east-1` |
| `REMOTION_LAMBDA_FUNCTION_NAME` | `remotion-render-4-0-474-mem3008mb-disk2048mb-240sec` |
| `REMOTION_LAMBDA_SERVE_URL` | the `forge-reels` site URL |

## Deploying / redeploying the site

Run after any change to the template (the backend picks up the new site with no
code change, since it reads `REMOTION_LAMBDA_SERVE_URL`):

```bash
cd remotion
npm install
# AWS creds must be in the shell (REMOTION_AWS_* / AWS_*)
npm run deploy-site   # remotion lambda sites create src/index.ts --site-name=forge-reels
```

The render **function** is deployed once per Remotion version:

```bash
npx remotion lambda functions deploy --memory=3008 --disk=2048 --timeout=240
```

## Concurrency note

The AWS account's Lambda concurrency limit caps render parallelism. Until the
increase (requested: 5000) lands, the backend pins `framesPerLambda: 400` to keep
the chunk count under the limit. Once raised, drop or lower that to speed renders.

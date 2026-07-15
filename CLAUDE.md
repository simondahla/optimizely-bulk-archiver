# Optimizely Bulk Archiver

## Commit rules

Do NOT add Claude as a co-author. No `Co-Authored-By` lines in any commit.

## Architecture

- `public/index.html` — single-page app; no build step, no framework
- `functions/api/[[path]].js` — Cloudflare Pages Function that proxies all `/api/*`
  requests to `https://api.optimizely.com`, forwarding the Authorization header
- `.github/workflows/deploy.yml` — deploys to Cloudflare Pages on push to `main`;
  preview deployments fire on pull requests
- `server.js` — local development only; not deployed

## Local development

```
node server.js
# Open http://localhost:3000
```

## Deployment

Merging to `main` triggers an automatic Cloudflare Pages deployment via GitHub Actions.
Required repository secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.

## Adding features

- Keep everything in `public/index.html` unless server-side logic is genuinely needed.
- The Pages Function in `functions/api/[[path]].js` should remain a thin proxy; avoid
  adding business logic there.

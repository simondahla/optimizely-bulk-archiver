# Optimizely Bulk Archiver

## Commit rules

Do NOT add Claude as a co-author. No `Co-Authored-By` lines in any commit.

## Architecture

- `public/index.html` — markup only; no build step
- `public/style.css` — all custom CSS; a thin brand/component layer on top of Pico
- `public/pico.min.css` — [Pico CSS](https://picocss.com) v2, vendored locally (not a CDN
  link) so the app has no runtime dependency on a third party at load time
- `public/app.js` — all client-side JS
- `functions/api/[[path]].js` — Cloudflare Pages Function that proxies all `/api/*`
  requests to `https://api.optimizely.com`, forwarding the Authorization header
- `.github/workflows/deploy.yml` — deploys to Cloudflare Pages on push to `main`;
  preview deployments fire on pull requests
- `wrangler.toml` — Cloudflare project config; used by local dev and dashboard deploy
- `LICENSE` — MIT

## Local development

```
npx wrangler pages dev
# Open http://localhost:3000
```

Wrangler serves `public/` and runs the `functions/` proxy locally — identical to production.

## Deployment

Merging to `main` triggers an automatic Cloudflare Pages deployment via GitHub Actions.
Required repository secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.

## Adding features

- No build step, no bundler, no transpiler — don't introduce one for a feature.
- Markup goes in `index.html`, behavior in `app.js`, styling in `style.css`.
- `pico.min.css` is vendored as-is; don't hand-edit it. Style with Pico's semantic
  elements (`article`, `.container`, `.grid`, `button.secondary`/`.outline`) and its
  CSS custom properties (`--pico-*`) first — only reach for bespoke CSS in `style.css`
  for things Pico has no opinion on (badges, the request log, the item list).
- The Pages Function in `functions/api/[[path]].js` should remain a thin proxy; avoid
  adding business logic there.
- Keep `README.md`'s "What it does" / "How to use" sections and this file's
  Architecture section in sync with any structural or user-facing change.

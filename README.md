# Optimizely Bulk Archiver

A single-page tool for bulk-archiving unused Optimizely Web Experimentation A/B experiments, pages and events. Hosted on Cloudflare Pages.

Unofficial, provided as-is. Not affiliated with or endorsed by Optimizely. Use at your own risk — see [License](#license).

## What it does

Three tabs, one for each kind of clutter a project accumulates:

- **Experiments** — lists all non-running, non-archived A/B tests. Archiving uses
  `DELETE /v2/experiments/{id}`; unarchiving restores them to `paused`.
- **Pages** — lists the pages the snippet activates on. Archiving flips `archived` via
  `PATCH /v2/pages/{id}`, so it is reversible from the Archived view.
- **Events** — lists click and custom events. The archive request depends on the event:
  click events go to `/v2/pages/{page_id}/events/{id}`, custom events to
  `/v2/projects/{project_id}/custom_events/{id}`. Pageview events are omitted because
  Optimizely stores them as pages — archive those from the Pages tab.

Across all three:

- Select and archive in bulk, then switch to the **Archived** view to select and unarchive
  in bulk
- **Pages and events still referenced by a non-archived experiment are locked.** The tool
  fetches the experiment list alongside them, indexes every `page_ids` entry and every
  `metrics[].event_id`, and disables those rows so you can't silently break a live test.
  The lock tooltip names the experiments using it.
- Experiments whose parent campaign is paused stay locked, as before (the campaign can be
  resumed at any time)
- Anything created in the last 14 days is flagged "NEW" and excluded from **Select page** /
  **Select all**; you can still tick it individually
- Filter by name, filter by status (experiments) or type (pages and events), and sort by
  name, created or modified date
- Choose how many results are shown per page (10/25/50/100, default 25)
- **Dry run** previews a whole selection: tick it and the bulk button walks every
  selected item, logs the exact method, URL and body it would send, and sends nothing.
  The button turns into **Preview archive** / **Preview unarchive** so a run that
  mutates nothing never wears the red button, and your selection survives the preview.
- Bulk runs send 4 requests at a time and back off on `429`/`5xx` using the API's
  `Retry-After` and `X-RateLimit-Reset` headers, so a run of hundreds doesn't die partway.
  Anything that still errors is listed and can be re-run with **Retry failed**.
- Switching tabs reuses what was already fetched; **Fetch** reloads the current tab

---

## How to use

1. **Get your Personal API token**
   Go to [Account settings → API Access](https://app.optimizely.com/v2/profile/api) and generate a token.
   Save it in your password manager — the tool will prompt your PM to save it on first use.

2. **Get your Project ID**
   Open your Optimizely project. The ID is in the URL:
   `app.optimizely.com/v2/projects/**12345678901**/...`

3. Pick a tab — **Experiments**, **Pages** or **Events** — then enter both values and click
   **Fetch** (or press Enter). On the Pages and Events tabs the tool also fetches your
   experiments so it knows what is still in use.

4. Select the items you want to archive. Locked rows can't be selected; hover one to see
   which experiments still reference it.

5. Tick **Dry run** and click **Preview archive** first. Nothing is sent — the request log
   fills with the exact request each item would get, so you can check the endpoints before
   committing. Untick it and click **Archive selected** to run for real.

6. To undo, switch to the **Archived** view, select the ones you want back, and click
   **Unarchive selected**.

7. If a run reports failures, click **Retry failed** to re-run just those IDs. Every request
   and response is in the **Request log** at the bottom of the page.

---

## Self-hosting

### Prerequisites

- A [Cloudflare account](https://dash.cloudflare.com/sign-up) (free tier is fine)
- This repository forked or cloned to your own GitHub account

### 1. Create a Cloudflare Pages project

In the Cloudflare dashboard:
1. Go to **Workers & Pages** → **Create** → **Pages** → **Connect to Git**
2. Select this repository
3. Set **Project name** to `optimizely-bulk-archiver`
4. Set **Build output directory** to `public`
5. Leave the build command empty — there is no build step
6. Click **Save and Deploy**

> Alternatively, create the project via the API or Wrangler — the project name must match
> the `projectName` in `.github/workflows/deploy.yml`.

### 2. Generate a Cloudflare API token

Go to **My Profile** → **API Tokens** → **Create Token**.
Use the **Edit Cloudflare Workers** template, or create a custom token with:
- **Cloudflare Pages: Edit** permission scoped to your account

Copy the token — you'll only see it once.

### 3. Find your Account ID

Your Account ID is in the Cloudflare dashboard URL:
`dash.cloudflare.com/**<ACCOUNT_ID>**/...`

Or go to **Workers & Pages** → the right sidebar shows your Account ID.

### 4. Add GitHub repository secrets

In your GitHub repo → **Settings** → **Secrets and variables** → **Actions**, add:

| Secret name | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | The API token from step 2 |
| `CLOUDFLARE_ACCOUNT_ID` | Your account ID from step 3 |

### 5. Protect the main branch

In your GitHub repo → **Settings** → **Branches** → **Add branch protection rule**:

- **Branch name pattern:** `main`
- Enable **Require a pull request before merging**
- Enable **Require status checks to pass before merging**
  - Add the `deploy` status check (appears after the first CI run)
- Enable **Require branches to be up to date before merging**
- Enable **Do not allow bypassing the above settings**

### 6. Push to main

The GitHub Actions workflow (`.github/workflows/deploy.yml`) deploys automatically:
- **Push to `main`** → production deployment
- **Pull request** → preview deployment with a unique URL posted as a PR status

---

## Local development

```sh
npx wrangler pages dev
# Open http://localhost:3000
```

Wrangler serves `public/` and runs the `functions/` proxy locally — identical to the production environment.

---

## Architecture

```
public/
  index.html              Markup only
  style.css               Custom styles, layered on top of Pico
  pico.min.css            Pico CSS v2, vendored locally (no CDN dependency)
  app.js                  All client-side behavior
functions/
  api/
    [[path]].js           Cloudflare Pages Function: proxies /api/* → api.optimizely.com
.github/
  workflows/
    deploy.yml            CI/CD: deploys to Cloudflare Pages on merge to main
wrangler.toml             Cloudflare project config; used by local dev and dashboard deploy
```

No build step or bundler — `public/` is served as-is. Styling uses [Pico CSS](https://picocss.com)
for base typography/forms/buttons, with brand colors applied via Pico's CSS custom properties and a
small custom layer in `style.css` for the pieces Pico doesn't cover (badges, the request log, the item list).

Everything that differs between experiments, pages and events lives in the `ENTITIES` registry at
the top of `app.js`: the list endpoint, the archive/unarchive method, URL and body, the status
vocabulary, the row metadata and the user-facing nouns. The list, filter, sort, pager, selection
and bulk-request machinery is entity-agnostic and reads from it, so adding a fourth entity type
(audiences, say) is a matter of adding one entry. The Pages Function needs no changes for new
entity types — it forwards any path.

---

## License

[MIT](LICENSE) — provided "as is", with no warranty and no liability accepted for its use.

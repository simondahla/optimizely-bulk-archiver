# Optimizely Bulk Archiver

A single-page tool for bulk-archiving paused or not-started Optimizely A/B experiments. Hosted on Cloudflare Pages.

## What it does

- Lists all non-running, non-archived A/B tests in a project
- Lets you select and archive them in bulk
- Flags experiments created in the last 14 days as "NEW" and protects them from accidental bulk selection
- Locks experiments whose parent campaign is paused (they can be resumed at any time)

---

## How to use

1. **Get your Personal API token**
   Go to [Account settings → API Access](https://app.optimizely.com/v2/profile/api) and generate a token.
   Save it in your password manager — the tool will prompt your PM to save it on first use.

2. **Get your Project ID**
   Open your Optimizely project. The ID is in the URL:
   `app.optimizely.com/v2/projects/**12345678901**/...`

3. Enter both values and click **Fetch** (or press Enter).

4. Select the experiments you want to archive and click **Archive selected**.

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
  index.html              Single-page app — no framework, no build step
functions/
  api/
    [[path]].js           Cloudflare Pages Function: proxies /api/* → api.optimizely.com
.github/
  workflows/
    deploy.yml            CI/CD: deploys to Cloudflare Pages on merge to main
wrangler.toml             Cloudflare project config; used by local dev and dashboard deploy
```

# Deploying from GitHub with the Cloudflare dashboard

This guide connects the GitHub repo to Cloudflare so that every push to `main` deploys the site. Most steps happen in Chrome, in the Cloudflare dashboard and on GitHub. A few one-time steps need a terminal.

Dashboard labels change from time to time. If a label here doesn't match what you see, look for the closest one.

For the command-line route, and for creating the D1 database and Backblaze buckets from scratch, see [Forking into your own Cloudflare account](../README.md#forking-into-your-own-cloudflare-account) in the README.

## 1. What gets deployed

The site is a server-rendered Astro app running as a **Cloudflare Worker** (`output: 'server'` in `astro.config.mjs`). It is not a static site.

- Pages (home, lessons, search, `/admin`) run Worker code that reads D1.
- CSS, JS and fonts from `dist/client` are served as static assets, without running the Worker.
- PDFs and the tutor photo are streamed from Backblaze B2 through the Worker, after a D1 check that the file is public.

Use **Workers** in the dashboard. Don't create a Cloudflare **Pages** project with `dist` as the output folder. That would serve a broken static copy with no admin, no search and no PDFs.

## 2. Before you start

- A Cloudflare account (the free plan is enough to start, see [Free plan limits](#11-free-plan-limits)).
- The repo pushed to GitHub, with your latest commits on `main`.
- The D1 database created, and its id in `wrangler.jsonc` (README step 2–3).
- Backblaze B2 buckets and application keys created, with `B2_ENDPOINT`, `B2_REGION` and `B2_BUCKET` set in `wrangler.jsonc` (README step 4).
- On your computer: Node 22.23.4 or newer, and pnpm.

## 3. One-time terminal steps

Workers Builds deploys code but doesn't apply database migrations. Run these once from the project folder:

```sh
pnpm install
pnpm wrangler login
pnpm wrangler d1 list                                   # tutor-db is listed, with the same id as in wrangler.jsonc
pnpm wrangler d1 migrations apply tutor-db --remote
pnpm wrangler d1 execute tutor-db --remote --command "SELECT slug, label FROM tracks ORDER BY position"
```

The last command must list five rows (class-10 through pro). `no such table: tracks` means the migrations ran against a different database. Check `database_id` in `wrangler.jsonc`.

## 4. Connect GitHub in the Cloudflare dashboard

1. Open [dash.cloudflare.com](https://dash.cloudflare.com) and choose your account.
2. In the sidebar, open **Workers & Pages**, then **Create application**.
3. Choose **Import a repository** (sometimes shown as **Continue with GitHub**).
4. Connect GitHub. GitHub asks you to install the Cloudflare app. Give it access to the `tutor-website` repo only.
5. Pick the `tutor-website` repo.
6. Fill in the build settings:

   | Field | Value |
   | :-- | :-- |
   | Project name | `tutor-website` |
   | Build command | `pnpm run build` |
   | Deploy command | `pnpm wrangler deploy` |
   | Non-production branch deploy command | `pnpm wrangler versions upload` |
   | Root directory / path | `/` |

   Cloudflare may pre-fill the deploy commands with `npx`. Both work, since each runs the wrangler installed from `pnpm-lock.yaml`. Use the `pnpm` versions above to match the rest of the project.

7. Open **Advanced settings** (or **Build variables**) and add:

   | Variable | Value |
   | :-- | :-- |
   | `NODE_VERSION` | `22.23.4` |

   `package.json` requires Node 22.23.4 or newer. Any newer version you use locally is fine too.
8. Click **Create and deploy** (or **Deploy**).

The project name must be exactly `tutor-website`, the `name` in `wrangler.jsonc`. If they differ, the build fails or deploys to a second Worker.

The first build takes a minute or two. The site will load, but sign-in and PDFs fail until the secrets in the next step are set.

## 5. Add the secrets

1. In **Workers & Pages**, open the `tutor-website` Worker.
2. Go to **Settings**, then **Variables and Secrets**.
3. Click **Add**. For each row below, set the type to **Secret**, enter the name and value, then save:

   | Name | Value |
   | :-- | :-- |
   | `ADMIN_PASSWORD` | The password the tutor uses at `/admin` |
   | `SESSION_SECRET` | A random string. Generate one with `openssl rand -hex 32` |
   | `B2_KEY_ID` | Key ID of the Backblaze **Worker** key (restricted to the production bucket) |
   | `B2_APP_KEY` | Application key of that same Backblaze key |

4. Click **Deploy** if the dashboard asks. Secrets apply to a new version of the Worker.

Don't add `B2_ENDPOINT`, `B2_REGION` or `B2_BUCKET` here. They come from `wrangler.jsonc`, and every deploy overwrites dashboard copies of them. Change them in the file and push instead.

Changing `SESSION_SECRET` later signs the tutor out everywhere.

## 6. Check that it works

1. In the Worker's overview, copy the URL. It looks like `https://tutor-website.<your-subdomain>.workers.dev`.
2. Open it in Chrome. The home page should load.
3. From a terminal, optionally confirm the status:
   ```sh
   curl -sI https://tutor-website.<your-subdomain>.workers.dev/ | head -1   # HTTP/2 200
   ```
4. Open `/admin` and sign in with `ADMIN_PASSWORD`.
5. Create a subject, a chapter and a lesson. Attach a **small** PDF (under 2 MB) and publish.
6. Open the lesson in a private window, as a student would, and open the PDF.

### Test a large PDF upload

On the free plan a Worker gets 10 ms of CPU time per request. Saving a lesson hashes every attached PDF, so large files may hit that limit. Test before the tutor relies on it:

```sh
pnpm wrangler tail tutor-website
```

Keep that running, then upload a PDF of about 20 MB in `/admin`. If the save fails and the log shows `exceededCpu` or error 1102 ("Worker exceeded resource limits"), choose one:

- Upgrade to **Workers Paid** ($5/month, 30 seconds of CPU per request). No code change.
- Stay on free, and ask the tutor to keep PDFs small (compress them before uploading).

## 7. Custom domain (recommended)

Published PDFs are kept in the Cloudflare edge cache, but that cache is only dependable on a custom domain. On `workers.dev`, every PDF open reads from B2. Backblaze accounts without a card may be capped at about 2,500 reads and 1 GB of downloads per day, after which students see "try again later".

1. Add your domain to Cloudflare: **Account home**, then **Add a domain**, on the free plan. Follow the steps to change the nameservers at your registrar. Or buy one through **Domain Registration**.
2. Wait until the domain shows as **Active**.
3. Open the `tutor-website` Worker, then **Settings**, then **Domains & Routes**.
4. Click **Add**, choose **Custom domain**, and enter the domain, for example `patilclasses.in` or `www.patilclasses.in`.
5. Open the new address in Chrome once the certificate is ready (usually a few minutes).

Adding a card to the Backblaze account also lifts the daily caps. At this site's size the bill stays close to zero.

## 8. Weekly backup (GitHub Actions)

The workflow in [`.github/workflows/d1-backup.yml`](../.github/workflows/d1-backup.yml) exports D1 to the B2 bucket every Sunday.

1. On GitHub, open the repo, then **Settings**, then **Secrets and variables**, then **Actions**.
2. Under **Repository secrets**, add each secret listed in [README step 7](../README.md#forking-into-your-own-cloudflare-account): `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `B2_BACKUP_KEY_ID`, `B2_BACKUP_APP_KEY`, `B2_ENDPOINT`, `B2_REGION`, `B2_BUCKET`.
3. Open the **Actions** tab. If GitHub says workflows are disabled (common on forks), enable them.
4. Choose **D1 backup**, then **Run workflow**.
5. When it finishes green, check the Backblaze console: a `d1-YYYY-MM-DD.sql` file should be under `backups/`.

## 9. Everyday use

- **Deploy:** push to `main`. Cloudflare builds and deploys automatically. Follow progress in the Worker under **Deployments** (build logs are linked there).
- **Preview:** pushes to other branches upload a preview version without changing the live site. The build log shows the preview URL.
- **Roll back:** open the Worker, go to **Deployments**, pick an earlier version, and deploy it.
- **Database changes:** after editing `src/db/schema.ts`, apply the migration before pushing the code that needs it:
  ```sh
  pnpm drizzle-kit generate
  pnpm wrangler d1 migrations apply tutor-db --remote
  git push
  ```
- **Manual deploy from your computer** (rarely needed): `pnpm run deploy`. Note that `pnpm deploy` without `run` is a different, built-in pnpm command.

## 10. Troubleshooting

| What you see | Likely cause | Fix |
| :-- | :-- | :-- |
| Build fails mentioning the Worker name | Project name in the dashboard differs from `name` in `wrangler.jsonc` | Use `tutor-website` in both |
| Build fails with an engine or Node version error | Build image uses an older Node | Set `NODE_VERSION` to `22.23.4` or newer in build variables |
| Build fails with `ERR_PNPM_IGNORED_BUILDS` | A new dependency needs a build script | Add it under `allowBuilds` in `pnpm-workspace.yaml` |
| Pages show an error mentioning `no such table` | Migrations not applied to the remote database | Run `pnpm wrangler d1 migrations apply tutor-db --remote` |
| `/admin` sign-in fails or errors | `ADMIN_PASSWORD` or `SESSION_SECRET` missing | Add them in **Variables and Secrets** (step 5) |
| PDFs show "can't be opened right now" | B2 key wrong or missing, or a Backblaze daily cap was hit | Check `B2_KEY_ID` / `B2_APP_KEY`, then **Caps & Alerts** in Backblaze |
| Saving a lesson with big PDFs fails, log shows error 1102 | Free plan CPU limit | See [Test a large PDF upload](#test-a-large-pdf-upload) |
| Weekly backup fails | GitHub secret missing or API token lacks **D1: Edit** | Check step 8 and the failed run's log |

For live logs from the deployed Worker, run `pnpm wrangler tail tutor-website`, or open the Worker's **Observability** tab.

## 11. Free plan limits

Limits as of November 2026. Check Cloudflare's [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) and [Workers Builds limits](https://developers.cloudflare.com/workers/ci-cd/builds/limits-and-pricing/) for current numbers.

| Limit (free plan) | Value | This site |
| :-- | :-- | :-- |
| Worker requests | 100,000 per day | Far above a tutor site's traffic. Static assets don't count |
| CPU time | 10 ms per request | Fine for pages. Large PDF uploads may exceed it |
| Memory | 128 MB per request | Same on paid. Lesson saves are capped at 90 MB of PDFs |
| Request body | 100 MB | Lesson saves are capped at 95 MB |
| Worker size | 3 MB compressed | About 280 KB |
| D1 storage | 5 GB | Lessons are small text rows |
| D1 reads / writes | 5 million / 100,000 rows per day | Plenty |
| Build minutes | 3,000 per month | A build takes 1–2 minutes |

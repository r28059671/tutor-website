# Patil Classes

A fast, mobile-first lesson library for a tutor. Students browse ordered courses, search, watch YouTube lectures, and download PDF notes without an account. The tutor manages everything from a password-protected `/admin`.

Astro 7 (server output) on Cloudflare Workers · D1 (lessons, FTS5 search) · Backblaze B2 (PDFs) · Tailwind 4.

Design and platform decisions: [`docs/design-brief.md`](docs/design-brief.md). Product context: [`PRODUCT.md`](PRODUCT.md).

## Forking into your own Cloudflare account

The repo is wired to the original owner's Cloudflare resources. A fork must create its own D1 database and Backblaze B2 buckets, otherwise deploys and backups point at someone else's data.

1. **Cloudflare account**
   - Sign in at dash.cloudflare.com, then run `npx wrangler login` in the fork's folder.
2. **Create the database**
   ```sh
   npx wrangler d1 create tutor-db
   ```
   `d1 create` prints a `database_id`. Keep it.

   **Verify (remote):**
   ```sh
   npx wrangler d1 list                  # tutor-db appears, with the id printed in step 2
   ```
   If `d1 create` says the name is taken, pick another name (for example `tutor-db-yourname`), then update `database_name` in `wrangler.jsonc` and in the backup workflow (`d1-backup.yml`, which has `tutor-db` hardcoded).
3. **Point the repo at your database.** In `wrangler.jsonc`, replace the `database_id` under `d1_databases` with the one from step 2. The current value belongs to the original owner. Leave `database_name` (`tutor-db`) as it is, unless you chose a different name in step 2.
4. **Backblaze B2** (backblaze.com, in the console)
   - Sign up and choose **EU Central**, the closest region to India. A region can't be changed later without re-uploading everything.
   - Create two **private** buckets, one for production and one for local development. Bucket names are global across Backblaze, so `patil-classes-pdfs` and `patil-classes-dev` may need a suffix.
   - On the production bucket, add custom lifecycle rules. A delete only hides a file in B2, so without these rules hidden files keep counting as storage:
     - `files/`: delete 1 day after hiding
     - `media/`: delete 1 day after hiding
     - `backups/`: hide 85 days after upload, delete 1 day after hiding
   - Create three application keys, all Read and Write. The master key doesn't work with the S3 API.
     - Worker: restricted to the production bucket
     - Dev: restricted to the dev bucket
     - Backup: restricted to the production bucket, with file name prefix `backups/`
   - In `wrangler.jsonc`, set `B2_ENDPOINT` (the S3 endpoint on the bucket page, without `https://`), `B2_REGION` (the part after `s3.`, for example `eu-central-003`) and `B2_BUCKET`.
   - Read **Caps & Alerts**. Accounts without a card may be limited to about 1 GB of downloads and 2,500 Class B and Class C calls per day. When a cap is hit, PDFs show "try again later" until it resets. Published files are served from the Cloudflare edge cache where available, which needs a custom domain to be dependable.
5. **Secrets for the deployed Worker**
   ```sh
   npx wrangler secret put ADMIN_PASSWORD
   npx wrangler secret put SESSION_SECRET            # openssl rand -hex 32
   npx wrangler secret put B2_KEY_ID                 # Worker key
   npx wrangler secret put B2_APP_KEY
   ```

   Use `wrangler secret put` as shown. Cloudflare's Secrets Store isn't needed, and `.dev.vars` is only for local development (`cp .dev.vars.example .dev.vars`).
6. **Schema and first deploy**
   ```sh
   npx wrangler d1 migrations apply tutor-db --remote
   npx wrangler d1 execute tutor-db --remote --command "SELECT slug, label FROM tracks ORDER BY position"
   pnpm install
   pnpm deploy
   ```

   The `execute` line must list five rows (class-10 through pro). An error like `no such table: tracks` means the migration didn't run against the remote database. Check the `database_id` in `wrangler.jsonc`.

   After deploy, confirm the site responds:
   ```sh
   curl -sI https://tutor-website.<your-subdomain>.workers.dev/ | head -1   # HTTP/2 200
   ```
   Your workers.dev subdomain is shown on the Workers & Pages page of the dashboard. The deploy output also prints the URL.
   Then open `/admin`, sign in, and add your standards, subjects, and lessons. The standards table starts with the five seeded ones (Class 10, 11, 12, Engineering, Professionals).
7. **GitHub (the fork)**
   - Forks have GitHub Actions turned off. Open the fork's Actions tab and enable them, otherwise the weekly backup never runs.
   - Settings > Secrets and variables > Actions, add:
     - `CLOUDFLARE_ACCOUNT_ID`: your account ID (dashboard sidebar).
     - `CLOUDFLARE_API_TOKEN`: create at dash.cloudflare.com > My Profile > API Tokens, with **D1: Edit** for your account.
     - `B2_BACKUP_KEY_ID`, `B2_BACKUP_APP_KEY`: the Backup key from step 4.
     - `B2_ENDPOINT`, `B2_REGION`, `B2_BUCKET`: the production values from `wrangler.jsonc`.
   - Run the "D1 backup" workflow once from the Actions tab (`workflow_dispatch`) to confirm it uploads to `backups/` in the production bucket.
8. **Optional**: set `CF_BEACON_TOKEN` as a var if you use Cloudflare Web Analytics.

Local development uses its own empty database and the dev bucket (see below), so none of this touches production. The local database lives in `.wrangler/state/` and is git-ignored.

## Local development

```sh
pnpm install
cp .dev.vars.example .dev.vars        # set ADMIN_PASSWORD, SESSION_SECRET (openssl rand -hex 32) and the B2 dev key
npx wrangler d1 migrations apply tutor-db --local
astro dev --background                # http://localhost:4321, admin at /admin
```

Local dev needs internet and a Backblaze dev key to upload or open PDFs, because B2 has no local emulator. Only D1 is local.

To wipe local D1 data and start clean (stop the dev server first). Files in the dev bucket stay until you delete them in the Backblaze console:

```sh
rm -rf .wrangler/state
npx wrangler d1 migrations apply tutor-db --local
```

## First deploy

```sh
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put SESSION_SECRET            # rotating this signs the tutor out everywhere
npx wrangler secret put B2_KEY_ID
npx wrangler secret put B2_APP_KEY
npx wrangler d1 migrations apply tutor-db --remote
pnpm deploy
```

Optional:

- Cloudflare Web Analytics: add a `CF_BEACON_TOKEN` var to load the cookieless beacon.
- Backups: add the repo secrets listed at the top of `.github/workflows/d1-backup.yml`. Retention comes from the `backups/` lifecycle rule on the bucket.
- Login rate limiting runs in D1 (5 failures per 15 minutes per IP). A Cloudflare WAF rule can sit in front later if the site moves to a custom domain.

## Commands

| Command | Action |
| :-- | :-- |
| `pnpm dev` | Dev server |
| `pnpm build` | Production build |
| `npx astro check` | Type-check |
| `pnpm lint` | oxlint |
| `node scripts/og-images.mjs` | Regenerate per-track Open Graph images |
| `npx drizzle-kit generate` | New migration after editing `src/db/schema.ts` |

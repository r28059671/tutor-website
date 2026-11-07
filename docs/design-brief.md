# Design Brief: Tutor Lesson Library (v2, amended, approved)

> Status: confirmed 2026-10-26. Strategic context lives in `PRODUCT.md`. `DESIGN.md` does not exist yet; generate it post-ship with `$impeccable document` to capture the real tokens. If any decision here changes during build, update this file in the same change. A stale brief is worse than none.

## 1. Summary
Neutral, fast lesson library for Class 10–12 Maths/CS, Engineering (C, C++, Java, Python), and working pros (AI, cloud, backend). Students browse ordered courses, search, watch lectures, download notes without login. Tutor manages structure, lessons, PDFs from password-protected `/admin`. Must fly on mid-range Android over patchy data, comfortable at 11pm.

## 2. Primary action
Reach the right lesson's video or notes in two taps. Returning: resume the next lesson.

## 3. Design direction
- **Color: Restrained + one warm accent. Pencil and highlighter.** Graphite neutrals (chroma ~0.006). Single accent: highlighter amber.
  - Token rule 1: amber is never text on light surfaces. Light mode: amber fill + dark text, or stroke (focus rings) only.
  - Token rule 2: amber reserved for primary action, current/next lesson, done marks, focus. Never hover, never decoration. Hover uses neutral layer shifts.
  - Token rule 3: "done" never color-alone (WCAG 1.4.1). Check glyph carries meaning; amber reinforces.
- **Scene:** Class 11 student, mid-range Android, bed at 11pm, low brightness, revising before a test. Dark first-class. Default follows `prefers-color-scheme`; manual toggle persisted on device.
- **Anchors:** Khan Academy article pages, Readwise Reader, Brilliant course map (minus gamification).
- **Type:** Atkinson Hyperlegible Next, self-hosted Latin-only woff2 subset (~30–45 KB), `font-display: swap`, `<link rel="preload">`, system-ui fallback, family exposed as one token (`--font-sans`) so a swap to system-ui is one line. No unicode-range slicing. Fixed rem scale, 1.2 ratio, tabular numerals for lesson numbers.

## 4. Scope
Production-ready, full surface (public + admin), wired to D1 and Backblaze B2, polish until ships.

## 5. Layout and IA

### Public (mobile-first, no client framework, minimal JS)
- **`/` Home:** search first. "Continue" row when device has history. Index of tracks (Class 10, 11, 12, Engineering, Professionals) listing subjects with published lesson counts. Typographic list, not card grid.
- **`/[track]/[subject]` Course:** chapters as `<details>` sections, numbered lesson rows (number, title, video/notes markers, done check), "4 of 12 done" per chapter (device-only). Next lesson highlighted. **Default open: chapter containing next lesson (or last opened); others collapsed.** Without device history: first chapter open. Default state set server-side for first chapter, adjusted by tiny inline script before paint for returning students.
- **`/[track]/[subject]/[lesson]` Lesson:** breadcrumb, title, artifacts in fixed order: video, then primary notes, then supplementary PDFs. Description, "Mark as done", prev/next (sticky bottom bar on mobile).
  - Video-only: no files section rendered.
  - Notes-only: notes download becomes hero block in player's slot.
  - Multi-PDF: labeled Notes / Practice / Solutions with size, **Download** + **Open**.
- **`/search?q=`:** SSR, works without JS; progressive live query. D1 **FTS5** over title (highest weight) + description + subject + chapter, `bm25()` ranking. Result rows carry track · subject · chapter. Track filter chips. 20 per page.
- **`/files/[hash]/[filename]`:** Worker route streams from B2 (private bucket, signed S3 requests). Key includes content hash, so `Cache-Control: public, max-age=31536000, immutable` is safe. `Content-Disposition` uses original filename.
- **404:** friendly not-found. Unknown lesson under a known subject: "Lesson not found" + that subject's chapter list. Unknown subject: track index. Archived content resolves to the same friendly 404.

### Admin
- **`/admin/login`:** one password field, inline error.
- **`/admin`:** lessons table (desktop) / stacked rows (mobile). Filter track/subject/status, search, primary **New lesson**.
- **`/admin/lessons/new`, `/admin/lessons/[id]`:**
  - Track > subject > chapter dependent selects, inline "+ New chapter".
  - Title, slug (auto from title, editable while draft).
  - YouTube URL: paste, extract ID, thumbnail preview; server oEmbed check on save sets `video_status`.
  - PDFs: three pickers, one per kind (Notes / Practice / Solutions), so kind is set at upload and the no-JS form still works. Existing files: kind select, up/down reorder (JS), Remove checkbox. Names and sizes shown before upload; upload progress via XHR. 25 MB per file, 90 MB per save, enforced client-side (fast fail) and in the Worker (`security.actionBodySizeLimit` raised to 95 MB; Astro's default is 1 MB). Server also checks the `%PDF-` magic bytes.
  - Status Draft / Published. Publish requires ≥1 artifact (video or PDF).
- **`/admin/lessons/[id]/preview`:** renders lesson exactly as public page, with a "Draft preview" bar. Admin-only via middleware.
- **`/admin/structure`:** per track, create/rename/reorder subjects and chapters; reorder lessons within chapter. Up/down buttons (keyboard-first), drag optional.
- **Deletion rules:**
  - Lessons: inline confirm, no modal ("Delete 'Pointers in C' and its 2 PDFs? [Delete] [Cancel]").
  - Subjects/chapters containing lessons: **Archive** only (hidden from public, visible in admin, restorable). Hard delete offered only when empty.

## 6. Data model and platform rules

### Migration
Pre-launch: local D1 has 0 lessons, remote D1 has no tables. Delete `drizzle/0000_*`, generate a fresh initial migration from the new schema. No data mapping needed.

### Schema
- `tracks` (admin-managed standards, added 2026-10-26): slug (PK, URL segment, frozen once a lesson under it is published), label, blurb, position, archived_at. Seeded with `class-10 | class-11 | class-12 | engineering | pro`. Admin can add, rename, reorder, archive, and delete (empty only) standards at `/admin/structure`. Reserved slugs (`admin`, `search`, `about`, `files`, `media`, `og`, `api`, ...) are rejected.
- `subjects`: id, track (slug of a `tracks` row, checked in actions, not a DB foreign key), name, slug, order, archived_at.
- `chapters`: id, subject_id, name, position, archived_at. (No slug: chapters never appear in URLs.)
- `lessons`: id, subject_id (denormalized so slugs are unique per subject, the URL scope), chapter_id, title, slug, position, youtube_id (nullable), video_status (`ok | unavailable | unchecked`), description, status (`draft | published`), published_at, created_at, updated_at.
- `lesson_files`: id, lesson_id, r2_key, kind (`notes | worksheet | solutions`), order, size_bytes, original_name, sha256.
- `login_attempts`: ip_hash (PK part), window_start (PK part), count. Index on window_start for sweep.
- `lessons_fts`: FTS5 virtual table (title, description, subject, chapter), maintained by triggers or by the save action.

### Visibility
Drafts and archived subjects/chapters excluded from: public pages, search, home counts, "x of y done", sitemap.

### Slugs
Slugs freeze on first publish. Names can change freely; URLs never do. Admin copy beside slug field: "This becomes the link students share. It can't change after publishing."

### Storage (Backblaze B2, changed from R2 on 2026-11-07)
R2 requires a card on file, so objects moved to B2. Workers and D1 stay on Cloudflare. All access goes through `src/lib/storage.ts` (`aws4fetch`, S3-compatible API, no Worker binding). The `lesson_files.r2_key` column keeps its name; it holds the object key and a rename would need a migration for no gain.
- **Caps:** accounts without a card may be limited to about 1 GB of downloads and 2,500 Class B and Class C calls per day (one developer's report, confirm in Caps & Alerts). When B2 refuses a read, `/files` answers 503 with a friendly message.
- **Edge cache:** public objects are kept in `caches.default`, keyed by object key, after the D1 visibility check. Drafts never enter it. The Cache API is documented for custom domains only, so treat it as best effort on `workers.dev`.
- **Region:** EU Central, as B2 has no Asia region. Uncached PDFs cost more latency in India than a nearby bucket would.
- **Local dev:** a dedicated dev bucket, set in `.dev.vars`. No emulator, so same code path as production.

### Storage lifecycle
- Keys: `files/<sha256-16>/<safe-name>.pdf`. Content-addressed, so the same PDF attached to two lessons shares one object; a file stays public while any published lesson references it.
- **Cleanup: on-delete hook in admin actions.** Deleting a lesson or a file (or replacing one) deletes the DB rows first, then the objects no other row references; delete failures logged, not fatal. No cron.
- A B2 delete only hides the object. Bucket lifecycle rules on `files/` and `media/` remove hidden files after 1 day. Prefixes don't overlap.

### YouTube availability
Cross-origin iframe cannot report removed/private videos, so the trigger is server-side: admin save calls YouTube oEmbed; 401/404 sets `video_status = unavailable`. Admin list flags unavailable videos; "Recheck" button. Public lesson with `unavailable` shows notes-first layout plus "Video unavailable. Try on YouTube" link instead of the facade.

### Auth
- HMAC-signed session token (`SESSION_SECRET`), payload with 7-day expiry. Never the password.
- Constant-time compare for password and signature.
- Cookie: httpOnly, secure, `sameSite=Lax`, path `/`.
- Secret rotation: rotating `SESSION_SECRET` invalidates every session (tutor must log in again). Expected, not a bug.
- Rate limit (default, shipped now): D1 table `login_attempts(ip_hash, window_start, count)`, 5 failed attempts per 15-minute window per IP, checked on login only via indexed lookup. `ip_hash` = HMAC-SHA256(IP, `SESSION_SECRET`), never the raw IP (plain hashes of IPv4 are brute-forceable). Rows older than 1 day are swept opportunistically on each login attempt; no cron. Implemented behind a small `checkLoginRateLimit(ip)` / `recordFailedLogin(ip)` interface so a Cloudflare WAF rule can be layered in front later (custom domain + plan permitting) with the D1 counter kept as defense-in-depth.

### SEO / sharing
Output is `server`, so no build-time D1 access. `/sitemap.xml` and `/robots.txt` are SSR endpoints querying D1, with `Cache-Control` (e.g. 1h, stale-while-revalidate). Robots disallows `/admin`. OG: video lessons use the YouTube `maxresdefault`/`hqdefault` thumbnail; notes-only lessons use a static per-track OG image. Per-page title/description/canonical.

### Backup
D1 Time Travel covers point-in-time restore (built-in). Plus weekly GitHub Actions cron (`.github/workflows/d1-backup.yml`): `wrangler d1 export` of the base tables, then upload to B2 `backups/` with a key restricted to that prefix. Retention via a B2 lifecycle rule (hide after 85 days, delete 1 day later, about 12 backups). `d1 export` cannot include the FTS5 virtual table, so after a restore use "Rebuild search index" in `/admin/structure`.

## 7. Key states
| Surface | States |
|---|---|
| Home | First visit · returning (Continue) · empty library ("Lessons are on their way") · track with no published content hidden |
| Course | Fresh · partial · chapter complete (quiet check, no confetti) · empty/archived chapters hidden |
| Lesson | Video + notes · video-only · notes-only · multi-PDF · facade pre-play · video unavailable · PDF missing in storage (inline message, not 500) · storage unavailable or capped (503 with a try-later message) |
| Search | Empty query (tracks) · no results (spelling hint + tracks) · paginated |
| 404 | Unknown lesson (subject's chapters) · unknown subject (track index) · archived |
| Admin | Login error · rate limited · session expired mid-form (values preserved, re-login) · field validation · file too large (pre-upload) · per-file upload fail · publish blocked (no artifact) · saved ("Lesson published · View it") · draft preview · delete confirm · archive/restore · unavailable video flag · empty library |

## 8. Interaction model
- **Continue row:** for the most recently opened course, the next not-done lesson in sequence; if the whole course is done, the last opened lesson. Shows course context ("Class 11 · Maths").
- **Facade:** `<button>` with accessible name "Play: {lesson title}", native keyboard activation, visible focus. Swap to `youtube-nocookie.com` iframe with `title="{lesson title} (video)"` and autoplay; move focus to iframe. No YouTube JS before tap.
- **Navigation:** full MPA page loads (no client router), so focus resets naturally on lesson change; skip link to main content; sticky bar sits after main content in DOM order, no focus trap, respects safe-area insets.
- **Device memory:** localStorage (try/catch) for last opened lesson per course, done-set, theme. Page fully works if storage blocked.
- **Motion:** 150–200ms ease-out-quart, state only. "Mark as done" highlighter swipe via `transform: scaleX`. Reduced motion: instant.
- **Forms:** Astro Actions, work without JS; JS adds upload progress, live validation, size checks.

## 9. Content
- Track labels come from the `tracks` table and are editable in admin. Seeded: Class 10, Class 11, Class 12, Engineering, Professionals. File kinds: Notes, Practice, Solutions.
- Voice: encouraging, plain. "Up next", "Pick up where you left off", "Marked done". No urgency, no em dashes.
- Microcopy centralized in `src/i18n/en.json` (English only; Hindi later is a swap).
- Ranges: 5 tracks; 2–8 subjects/track; 5–20 chapters/subject; 3–15 lessons/chapter; hundreds total; titles ≤ ~80 chars; PDFs 0.2–25 MB.

## 10. Extras (adopted, cheap)
- `@media print`: drop player, sticky bar, nav; print lesson title, description, file list.
- Cloudflare Web Analytics (cookieless). No GA.

## 11. References for build
interaction-design.md, spatial-design.md, responsive-design.md, color-and-contrast.md, typography.md, ux-writing.md, motion-design.md, optimize.md.

## 12. Build notes (decisions made during craft)
- Site name lives in `src/i18n/en.json` (`site.name`, currently "Patil Classes"); OG images regenerate with `node scripts/og-images.mjs`.
- Search: FTS5 with porter stemming. Terms of 6+ characters also match a 2-character-shorter prefix, so "matrix" finds "matrices". Malformed queries return no results, never a 500.
- Continue logic: the next not-done lesson at or after the last one opened, wrapping to the start; when the course is all done, the last opened lesson. Only lesson visits (not outline browsing) make a course "most recent".
- Done marks: an empty outline circle on every lesson row, filled amber with a check when done. Completed chapters get the same check in their header.
- Expired session on save: the page shows a password field with all submitted values held as hidden fields; signing in saves in one step. Chosen PDFs can't be carried over (browser security), and the panel says so.
- Admin structure page uses `<details>` popovers for rename/delete confirm; every control is a plain POST form (works without JS), with post/redirect/get and the #fragment preserved.
- `imageService: 'passthrough'` (no raster processing), `session: false` (no KV namespace).
- Drag-to-reorder was not built; up/down buttons cover it and are keyboard-first.

## 13. v3: richer student side (2026-10-26)
Requested from reference screenshots; amber identity kept, structure adopted.
- **Canvas + panels:** page is a soft tinted canvas (`--canvas`); content sits on raised `.panel`s (`--bg`, 1px line, faint shadow). Never nested.
- **Header:** track navigation + About (scrolls horizontally on phones). **Footer:** tracks, library links, tutor sign in.
- **Home:** hero panel (badge, search, Level and Subject filter chips via `?track=&subject=`, Continue card), "Latest lessons" grid of 9 (6 on phones) using `LessonCard` (YouTube thumbnail or ruled-paper tile for notes-only, one-tap PDF), "Browse by track" panels, tutor card + "How this library works".
- **Course:** segmented control for the same subject in other tracks, subject chips for the track, numbered chapter panels (collapsed ones preview lesson titles), PDF + Watch per lesson row, up-next row in amber wash; sidebar with progress + Continue (the one amber action), course-scoped search (`/search?subject=<id>`), tutor. Phones get a progress/Continue strip above the chapters.
- **Lesson:** meta chips, video, `DownloadPanel` (under the video on phones, sidebar on desktop; a single PDF collapses to one strong button), action bar (Mark as done, Share, YouTube), About panel, chapter panel with now-playing state and Previous/Next, tutor card.
- **Tutor profile:** single-row `tutor_profile` table (migration 0002), edited at `/admin/profile`; photo cropped to a 480px WebP in the browser, type-sniffed on the server, served from `/media/<key>` only while current. Hidden everywhere while the name is empty.
- `.btn-ink` (dark neutral) carries strong secondary actions so amber stays rare.

## 14. Open (resolve during build)
- None blocking. Later: add WAF rate-limit rule in front of the D1 counter if the site moves to a custom domain zone on a plan that offers the window.

## 15. Standards are data (2026-10-26)
- Tracks moved from the fixed code list (`src/lib/tracks.ts`) to the `tracks` table so admins can add standards such as Class 9 without a deploy. Public nav, footer, home, search chips, course/lesson labels, and sitemap read from the table. Archived standards disappear everywhere public (queries join `tracks` where `archived_at` is null) and resolve to the friendly 404.
- `/admin/structure` leads with an "Add a standard" panel and shows an always-visible "Add a subject" form under each standard, so creation no longer hides in collapsed disclosures.

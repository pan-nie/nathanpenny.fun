# Worker Backend: comments + admin (uploader/写作台/stats) + AI proxy

Cloudflare Worker behind `https://workers.nathanpenny.fun` (custom domain;
the `*.workers.dev` URL also exists but admin routes reject it — see Access
below). Feature groups: comments (+ moderation), 写作台 drafts with scheduled
publishing, content data editors (gallery/creations JSON), first-party
analytics, the Access-protected
`/admin` page (image uploader + markdown editor + content editors + music
library + AI playground + stats + comments tabs), the site avatar chat, and
the AI proxy.

## Endpoints

| Method | Path                           | Protection              | Purpose                                        |
|--------|--------------------------------|-------------------------|------------------------------------------------|
| GET    | `/comments`                    | public                  | List comments threaded one level (`replies[]` under each top-level comment; `email` deliberately excluded) |
| POST   | `/comments`                    | public                  | Create a comment or reply (optional `parent` id — must reference a top-level comment; rate limit + Turnstile) |
| POST   | `/api/site-chat`               | public                  | Site avatar chat (per-IP rate limit, internal key) |
| POST   | `/api/analytics/hit`           | public                  | First-party analytics beacon (see below; always 204) |
| GET    | `/admin`                       | Cloudflare Access       | Admin page: 图床 + 写作台 + Content + Music + AI playground + Stats + Comments tabs |
| POST   | `/upload`                      | Cloudflare Access       | Multipart images → R2 `img/` prefix (optional `dir` field targets a folder) |
| GET    | `/upload?list=1[&cursor=…]`    | Cloudflare Access       | Recent uploads (newest first, flat)            |
| GET    | `/upload?list=1&prefix=img/…/&delimiter=1` | Cloudflare Access | One level of a folder: `{folders[], objects[]}` |
| DELETE | `/upload?key=img/…`            | Cloudflare Access       | Delete one object (`img/` prefix only)         |
| POST   | `/upload/folder`               | Cloudflare Access       | Create a folder `{path}` (writes a `.keep` marker object) |
| DELETE | `/upload/folder?key=img/…/`    | Cloudflare Access       | Delete a folder and everything under it (batched) |
| POST   | `/upload/move`                 | Cloudflare Access       | Move/rename a file or folder `{from, to}` (get+put+delete per object) |
| GET    | `/admin/api/posts`             | Cloudflare Access       | List `posts/*.md` from GitHub (editor.js)      |
| GET    | `/admin/api/post?slug=…`       | Cloudflare Access       | Read one post (decoded UTF-8 + blob sha)       |
| POST   | `/admin/api/post`              | Cloudflare Access       | Publish (create/update) via GitHub Contents API |
| DELETE | `/admin/api/post?slug=…&sha=…` | Cloudflare Access       | Delete a post (CI prunes its generated page)   |
| GET    | `/admin/api/stats?days=N&self=1` | Cloudflare Access     | Analytics dashboard data for the Stats tab (7/30/90d; `self=1` includes the owner's flagged visits) |
| GET    | `/admin/api/visitor?id=…`      | Cloudflare Access       | One visitor's profile + sessions + page timeline |
| GET    | `/admin/api/comments?offset=0` | Cloudflare Access       | Moderation list: every comment incl. `email` + `ip_hash` (50/page; moderation.js) |
| DELETE | `/admin/api/comment`           | Cloudflare Access       | Delete one comment (`?id=`, replies go with it) or all comments of one sender (`?ip_hash=`) |
| GET    | `/admin/api/bans`              | Cloudflare Access       | List the `banned_ips` blocklist `POST /comments` checks first (moderation.js) |
| POST   | `/admin/api/ban`               | Cloudflare Access       | Ban a sender `{ip_hash, note}`                |
| DELETE | `/admin/api/ban?ip_hash=…`     | Cloudflare Access       | Unban a sender                                |
| GET    | `/admin/api/drafts`            | Cloudflare Access       | List 写作台 drafts (drafts.js)                 |
| GET/POST/DELETE | `/admin/api/draft`    | Cloudflare Access       | Read `?slug=` / save `{slug, meta, body, publish_at}` / delete `?slug=` one draft |
| GET/POST | `/admin/api/data?file=…`      | Cloudflare Access       | Whitelisted repo JSON files (`gallery`, `creations`, `achievements`): read `{sha, content}` / validated commit via the Contents API |
| GET    | `/admin/api/music/tree`        | Cloudflare Access       | Music tab: R2 `music/` listing annotated with published flags from the committed JSON (music.js) |
| POST   | `/admin/api/music/upload`      | Cloudflare Access       | Multipart audio (`files[]` + parallel `artist[]`/`album[]`; ext allowlist, 64MB cap, magic-byte sniff) → R2 `music/<Artist>/<Album>/` |
| DELETE | `/admin/api/music?file=…`      | Cloudflare Access       | Delete one audio object (`music/` prefix only; the public JSON drops it on the next sync) |
| POST   | `/admin/api/music/plan`        | Cloudflare Access       | Dry-run of the library sync — added/removed report, no writes |
| POST   | `/admin/api/music/cover`       | Cloudflare Access       | iTunes cover lookup for ONE song → commit the jpg + cache in R2 `music/.covers.json`; a lookup that cannot run from the Worker answers `{search:[urls]}` for the tab to run instead (see Music library) |
| POST   | `/admin/api/music/commit`      | Cloudflare Access       | Rebuild `data/music-library.json` from R2 + cached covers, commit via the Contents API |
| POST   | `/api/ai/v1/chat/completions`  | Bearer API key          | OpenAI-compatible proxy (see AI proxy below)   |
| GET    | `/api/ai/v1/models`            | Bearer API key          | Model catalog (the free Workers AI `cf-*` models) |
| *      | anything else                  | —                       | 404                                            |

## POST /comments guards (unchanged)

1. **Per-IP rate limit** — 5 attempts per 60s window, counted in the
   `comment_rate` D1 table (`checkRateLimit()`). Exceeding it returns 429.
   (A Workers rate-limit binding was tried first but is silently a no-op on
   this account, so the cap lives in D1.)
2. **Cloudflare Turnstile** — token verified server-side; failure → 403.
   See the Turnstile section below for keys/hostnames.

## Comment moderation (评论审核)

The `/admin` **Comments** tab (comments_tab.js) is the management entrance
the public site deliberately lacks. Backed by moderation.js:

- `GET /admin/api/comments?offset=N` — every comment **including** `email`
  and `ip_hash` (the public `GET /comments` withholds them), 50 per page,
  newest first, with a total count.
- `DELETE /admin/api/comment?id=…` — delete one comment (permanent); a
  top-level comment takes its replies with it so no orphans survive.
- `DELETE /admin/api/comment?ip_hash=…` — bulk-delete every comment of one
  sender.
- `GET/POST/DELETE /admin/api/ban[s]` — the `banned_ips` blocklist
  (`{ip_hash, note}`). `POST /comments` checks it **before** rate limiting
  and Turnstile; banned senders get a 403 "Your comment cannot be posted."
  The check fails open on D1 trouble, like the rate limiter.

Privacy: `ip_hash` is a 16-hex salted one-way hash of the sender's IP —
`sha256(ANALYTICS_SALT + "\n" + ip)`, the same salt secret the analytics
visitor hash uses. The raw address is never stored anywhere, so the
`/privacy` promise ("no IP in our database") stays true; the hash still lets
the owner recognize and blocklist an abusive sender. `POST /comments` stores
the hash on every new row; comments posted before this feature carry `''`.
(The salt is rotated → old hashes stop matching; re-ban from fresh comments.)

## Drafts & scheduled publishing (草稿与定时发布)

Drafts live in the D1 `drafts` table (slug PK, `meta` JSON, `body`,
`publish_at`, `updated_at`) — deliberately **not** in the public repo and
**not** in R2 (the bucket is publicly readable via storage.nathanpenny.fun).

- The editor tab sidebar gains a **Drafts** list: Save draft (Save draft)
  upserts the current form + body; clicking a draft loads it back into the
  form; 🗑 deletes it. Publishing a loaded draft goes through the normal
  Publish and deletes the draft on success.
- Scheduling: a `datetime-local` input + Schedule button saves the draft
  with `publish_at` (epoch seconds). Every draft row shows its schedule.
- A **15-minute Cron** (`*/15 * * * *`, wrangler.jsonc; the Worker now has
  two triggers) runs `publishDueDrafts()` in drafts.js: for each due draft
  it composes + validates exactly like the interactive editor
  (`composePost` → `validatePost` → `commitPost` in editor.js), reads the
  existing blob sha first so an existing post is updated rather than 422'd,
  commits with the message `publish/update: <slug> (scheduled draft)`, and
  deletes the draft row on success. A deterministic validation failure
  clears the draft's schedule (kept as a plain draft, logged); transient
  GitHub failures abort/retry on the next tick. Max 5 drafts per tick.
- Requires the same `GITHUB_TOKEN` secret as the editor; without it the
  cron simply publishes nothing.

## Content data files (gallery / creations)

The admin **Content** tab (content_page.js) gives the Gallery and Creations
pages the same editing experience as the blog, minus the CI step. The files
`data/gallery.json` and `data/creations.json` stay the source of truth in
the repo; a save commits the whole file to `main` and the static host serves
JSON as-is, so changes are live in a minute or two (every change also lands
in git history).

- `GET /admin/api/data?file=gallery|creations` → `{file, sha, content}` —
  the raw file text + blob sha.
- `POST /admin/api/data` `{file, content, sha?}` — the content string is
  parsed and every item validated server-side (`validateItems()` in
  editor.js: required keys, `type`/`origin`/`platform` enums, date format,
  length caps, 500 entries / 256KB). Valid → committed with the message
  `<label>: update via admin`; stale sha → 409 (reload and re-apply).
- File names are a whitelist (`DATA_FILES` in editor.js) — no arbitrary
  repo paths: `gallery`, `creations`, `achievements`.
- **Achievements** (`data/achievements.json`) is a two-level structure — an
  array of ordered sections, each with ordered items (`id`, `title`, `badge`,
  `date` as YYYY-MM or YYYY-MM-DD, `description`, `links[]` of absolute
  http(s) URLs). Validated by `validateAchv()` in editor.js; rendered by
  `initAchievements()` in main.js (GitHub links get the GitHub icon, section
  icons default by section id); `[]` shows the page's built-in empty state.
- Creations video entries: `platform` omitted or `file` renders the native
  `<video>` player; `bilibili` / `youtube` make `main.js videoEmbedUrl()`
  convert the watch-page URL into `player.bilibili.com` / (no-cookie)
  `youtube-nocookie.com` embeds inside a `.creation-embed` 16:9 iframe.
  The UI extracts and previews the ID as you type. Cross-origin players
  cannot pause the site's audio mini-player (accepted limitation).

## Music library (音乐库)

The Creations-page music library is fully browser-managed through the admin
**Music** tab (music_page.js) + music.js — the local pipeline
(`tools/gen_music_library.py` + `tools/upload_music_r2.sh`) it replaced was
deleted in 2026-09. The Python tool's string rules survive as byte-parity
ports inside music.js (`r2Key`, `slugify`, `titleOf`, `encodeRelPath`,
2-space JSON layout), verified against the original on a corpus with the
`...Baby One More Time` dot-fold case, Chinese names and `quote()` edge
characters.

- **Storage**: audio lives only in the R2 bucket under
  `music/<Artist>/<Album>/` (mp3/flac/m4a, 64MB cap, magic-byte sniff) and
  is served by storage.nathanpenny.fun; the repo never carries audio.
  Object keys fold any run of 2+ dots into `…` (`r2Key`) — the storage
  domain serves keys as URL paths and the WAF 403s `...`. The SAME mapping
  builds the JSON `src` URLs, so key and URL can never drift apart (the
  failure mode the two-file pipeline risked).
- **Upload**: drag an artist/album folder (entries API keeps the relative
  layout; leading root segment stripped) or loose files; per-row editable
  Artist/Album inputs; one file per request via XHR with progress.
  **These two fields are what make covers work.** A loose file dropped on its
  own falls back to the literal `Unknown Artist` / `Unknown Album`, and no
  lookup can ever match an artist by that name — it fails by design rather than
  attaching a stranger's art. Either drop an `Artist/Album/` folder with
  `<Title>-<Artist>.ext` (or `<Title>-<Album>-<Artist>.ext`) filenames, or fill
  the inputs in the "Ready to upload" list before uploading. Separators other
  than `-` (a `:` was seen) leave the derived title polluted, so the query is
  gibberish even when artist and album are right.
- **Sync & publish** (`plan` → `cover` loop → `commit`, all client-driven so
  subrequest counts stay tiny and an interrupted sync resumes):
  1. `POST /admin/api/music/plan` — full R2 listing vs the committed JSON;
     existing entries (matched by `src`) are reused verbatim so ids and
     covers never churn; new songs get title/id from the
     `Artist/Album/<Title>-<Album>-<Artist>.ext` layout. Also returns
     `needsCover`: already-published songs whose `cover` is null, because those
     must be retried too (see step 2).
  2. `POST /admin/api/music/cover` for every song in `added` + `needsCover` —
     an iTunes lookup that stays conservative (a wrong cover is worse than no
     cover). Queries run most specific first: `entity=album`, requiring artist
     AND album to match, then `entity=song`, requiring the track name — the
     song query is the only path that can work for rows whose album is a
     placeholder such as `Unknown Album`. The US storefront is the default; a
     CJK query tries TW first (the CN storefront stopped answering those in
     2026-09), and CJK names compare with a shared-character tolerance because
     the catalog is simplified while the storefronts answer in traditional
     script (`周杰伦` vs `周杰倫`, `搁浅` vs `擱淺` — no shared characters at
     all).

     **The search deliberately runs in the admin's browser.** Apple serves this
     Worker's shared egress IP with `HTTP 429` while the admin's own IP is
     served normally, so a server-side-only lookup fails permanently — no
     User-Agent or retry count fixes it. Both Apple endpoints send
     `Access-Control-Allow-Origin: *`, so when the server-side attempt misses
     this route answers `{miss, stage:"lookup", detail, search:[urls]}` and the
     tab runs those exact URLs and posts the raw results back. Only the fetching
     moves: the matching stays in `lookupCoverArt`, so there is exactly one
     implementation of it. Do not fold this back into the Worker.

     Every failure reports the stage it died at, and the tab prints it beside
     the filename — all of these used to return a bare `{miss:true}`, which made
     a throttled API, a blocked CDN and a GitHub error indistinguishable:

     | `stage` | meaning |
     |---|---|
     | `lookup` | no confident match (or Apple throttled even the browser) |
     | `artwork` | the CDN fetch failed — HTTP status in `detail` |
     | `artwork-type` / `artwork-size` | not an image, empty, or over 2MB |
     | `commit` | the GitHub Contents API refused it — message in `detail` |

     A miss is never cached, so the next Sync retries it. On success the jpg is
     committed to `images/music-covers/<slug>-<sha8>.jpg` and the hit cached in
     R2 `music/.covers.json` (hidden from listings).
  3. `POST /admin/api/music/commit` — rebuild the whole catalog, skip the
     commit when byte-identical, else PUT `data/music-library.json` through
     the Contents API (sha conflict → 409, press Sync again). Live in a
     minute or two; CI never regenerates this JSON.
- **A retried cover has to reach the JSON.** `buildCatalog` reuses
  `prior.cover` for an already-published song, but when that is null it falls
  back to the meta file — otherwise a cover could be looked up, downloaded,
  committed to the repo and written to R2 meta while the catalog kept saying
  `null` forever (exactly what happened on 2026-09-30, and the reason a "stuck"
  song needs no delete-and-re-upload).
- Deleting audio from the tab only deletes the R2 object — the public JSON
  drops the entry on the next Sync (`removedCount` in the plan report).

## Image uploader (图床)

- Storage: the shared R2 bucket `nathanpenny-fun` (bound as `env.R2`),
  prefix `img/YYYY/MM/<slug>-<6hex>.<ext>`. Keys are ASCII-slugged + random,
  so content never changes per key → objects carry
  `Cache-Control: public, max-age=31536000, immutable` via R2 httpMetadata.
  Uploads from the admin file explorer into a chosen folder land there
  (`dir` form field); root uploads keep the date-based layout.
- Reading is served by the bucket's public custom domain
  `storage.nathanpenny.fun` — no Worker involvement on reads.
- Slugification removes all dots, which structurally avoids the WAF rule
  that 403s URL paths containing `...` (the music library's `r2Key()` in
  music.js instead folds such runs into `…`). The same rule is enforced on
  folder names (`normalizeFolderPath`: ASCII slug segments only, no dots,
  no `..`).
- "Folders" are R2 key prefixes. Creating one writes a zero-byte `.keep`
  marker object (listings hide it); deleting one cursor-lists every key
  under the prefix and batch-deletes 1000 per call. Moving/renaming has no
  R2-native support in the Workers binding, so `/upload/move` does
  get + put + delete per object (uploads are ≤25MB, fine).
- Upload validation: extension allowlist (png/jpg/jpeg/webp/gif/avif/svg),
  25MB cap per file, 10 files per request max, light magic-byte sniffing.
- The Images tab (admin_page.js) is a file explorer: breadcrumb navigation,
  folder cards + lazy thumbnails, sort (date/name/size), new folder,
  rename/move/delete with confirm, per-file detail dialog (copy URL /
  copy Markdown / rename / move / delete), and a flat "Recent" view. Drag &
  drop + clipboard paste upload into the folder being viewed. The 写作台
  editor tab (editor_page.js) reuses the same `/upload` endpoint to insert
  image markdown at the cursor.

## Markdown editor (写作台)

Publishing flow: fill in the metadata form (title / slug / date / category /
tags / description), write markdown in the body pane → 发布 → the Worker
composes the canonical frontmatter server-side and commits `posts/<slug>.md`
to `main` via the GitHub Contents API → the `gen-posts` workflow regenerates
the static pages. The repository stays the single source of truth; the site
itself never changes shape and no database is involved.

- The tab is a two-pane layout: post list (filter box, + New) pinned on the
  left, metadata form + markdown body + live preview on the right; below
  ~900px the list collapses into a drawer. The body textarea holds markdown
  ONLY — the form fields never mix into it, which also makes importing a
  local `.md` trivial (Import button or drop the file: frontmatter is parsed
  into the form, the rest goes to the body). The preview pane runs a JS port
  of the generator's renderer (kept byte-identical on the shared test
  corpus); the CI-generated page remains the truth.
- `POST /admin/api/post` accepts `{slug, meta, body}` (the editor form) or a
  legacy full `content` string. `composePost()` builds the frontmatter with
  canonical key order (title, date, description, category, tags), forces
  every value onto one line, omits empty description/tags (matching the
  generator's fallbacks), then validates with the same rules as
  `tools/gen_post_pages.py` (title/date required with a round-trip date
  check, category in the fixed list, no BOM, 256KB cap) — any miss would
  make the generator `sys.exit` and the CI run red. Slugs are
  `^[a-z0-9][a-z0-9-]{0,63}$` (the generator does no filename validation).
- Updates carry the blob `sha` from the last read; a 409 means the file
  changed remotely — reload the post. A successful publish returns the new
  sha so back-to-back edits never conflict.
- Deleting a post commits the deletion; CI then prunes the stale
  `blog/<slug>/` directory (the generator removes dirs without a matching
  post).
- Setup: create a GitHub fine-grained PAT scoped to `pan-nie/nathanpenny.fun`
  only, with **Contents: Read and write**, then
  `npx wrangler secret put GITHUB_TOKEN`. The token never reaches the page or
  logs — GitHub error messages (capped at 200 chars) are the only upstream
  text relayed to the client.
- Editor APIs live under `/admin/api/*` so the edge Access app (path-prefix)
  covers them and injects the JWT; the Worker re-verifies like everywhere.

### Cloudflare Access

The dashboard-managed Access application (Zero Trust, team
`square-surf-c2a6`) covers `workers.nathanpenny.fun/admin` and
`workers.nathanpenny.fun/upload` with an email-OTP allow policy. It is NOT
in this repo; changes happen in the Zero Trust dashboard.

Defense in depth: the Worker also verifies the `Cf-Access-Jwt-Assertion`
JWT (RS256 against the team JWKS, `exp` + `aud` checks, JWKS cached 24h) —
this closes the `*.workers.dev` bypass, which Access does not cover.
Fail-closed: if `ACCESS_TEAM_DOMAIN`/`ACCESS_AUD` vars are missing, admin
routes return 401/503, never open up.

Local development: copy `workers/.dev.vars.example` to `workers/.dev.vars`
(gitignored) and set `ADMIN_BYPASS=1` so `wrangler dev` can serve the page
without a real Access JWT. **Never deploy with that var present.**

## AI proxy (私有 AI 中转)

OpenAI-compatible endpoint — point any OpenAI SDK at
`base_url = https://workers.nathanpenny.fun/api/ai/v1` and use a generated
key. The single upstream is **Cloudflare Workers AI** (its OpenAI-compatible
REST route, auth = the `CF_AI_TOKEN` secret, a Cloudflare API token scoped to
Workers AI; account from the `CF_ACCOUNT_ID` var):

| Model string              | Upstream                                              |
|---------------------------|-------------------------------------------------------|
| `cf-{author}/{model}`     | Workers AI, sent upstream as `@cf/{author}/{model}`   |

The request body passes through untouched (apart from that one model-string
rewrite). The catalog array in ai_proxy.js only feeds `GET /api/ai/v1/models`
— it is not consulted for routing, but the `cf-` **prefix is**: any
`cf-{author}/{model}` string is forwarded as-is, while a model without that
prefix is rejected with 400, so third-party model names cannot be addressed.
Free-tier models only (`kimi-k2.6`, `glm-5.2` and a few
others require the paid Workers plan). **Free allocation: 10,000
Neurons/day** (resets 00:00 UTC) ≈ 600 small `llama-3.1-8b-fast` chats or
~110 `llama-3.3-70b` ones. A missing Workers AI secret returns 503.

History: the proxy originally fronted OpenAI/Anthropic/Google/xAI/DeepSeek
(BYOK), optionally through the account's AI Gateway. Removed 2026-09 after
the gateway live-test showed it does **not** bypass OpenAI's
`unsupported_country_region_territory` geo-block, and third-party upstreams
went unused.

- **Auth**: `Authorization: Bearer npai_…`; only the SHA-256 hash is stored
  in D1. Issue keys with `python3 tools/ai_key.py <name> [monthly_limit]`
  and run the printed SQL via `npx wrangler d1 execute nathanpenny --remote
  --command "<sql>"`.
- **Quota**: per-key monthly request cap (`api_keys.monthly_limit`, UTC
  months) enforced by an atomic conditional upsert into `ai_usage`
  (single roundtrip; no `RETURNING` row = over cap → 429). Fails open on
  D1 trouble, like the comments rate limiter.
- **Logging**: every chat call appends metadata (key, model, provider,
  status, stream, token counts, latency) to `ai_logs` via
  `ctx.waitUntil` — never prompt/response content. Streaming usage is
  scraped from the SSE tail when the upstream provides it (null otherwise),
  and latency is measured to full stream completion. Token totals also
  accumulate into `ai_usage.tokens_in/tokens_out` (per key+month).
- **Streaming**: SSE bodies are passed straight through by a TransformStream
  pump (`pumpStream`) that reads the upstream once; the usage log is awaited
  by that pump **before** the client stream closes, because a `ctx.waitUntil`
  D1 write issued after a streamed response silently never lands. 300s
  upstream timeout, 10MB body cap.
- **CORS**: `Access-Control-Allow-Origin: *` — safe because auth is a
  header key, never cookies.

### Usage

Non-streaming:

```sh
curl https://workers.nathanpenny.fun/api/ai/v1/chat/completions \
  -H "Authorization: Bearer npai_…" \
  -H "Content-Type: application/json" \
  -d '{"model":"cf-meta/llama-3.1-8b-instruct-fp8-fast","messages":[{"role":"user","content":"hi"}]}'
```

Streaming: add `"stream": true` — SSE chunks pass through verbatim.

OpenAI SDK (Python):

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://workers.nathanpenny.fun/api/ai/v1",
    api_key="npai_…",
)
resp = client.chat.completions.create(
    model="cf-meta/llama-3.1-8b-instruct-fp8-fast",
    messages=[{"role": "user", "content": "hi"}],
)
```

JavaScript: `new OpenAI({ baseURL: "https://workers.nathanpenny.fun/api/ai/v1", apiKey: "npai_…" })`.

`GET /api/ai/v1/models` lists the starter catalog. Routing only checks the
`cf-` prefix, so any `cf-{author}/{model}` from the
[Workers AI catalog](https://developers.cloudflare.com/workers-ai/models/) works.

## Site avatar chat (站内 AI 分身)

`POST /api/site-chat` powers the site's AI avatar chat (main.js
`initSiteChat`): clicking the About-page portrait, which carries an "AI" badge,
opens a chat `<dialog>`. That portrait is the only entry point — there is no
floating button on other pages. Body:
`{"message": "...", "history": [{"role":"user"|"assistant","content":"..."}]}`
→ `{"reply": "..."}`. Non-streaming by design (one JSON response, ≤300
tokens out).

Guards, in order:

1. Per-IP limiter in the `chat_rate` D1 table — 3 messages / 60s window
   (fail-open on D1 trouble), swept opportunistically + by the daily cron.
2. Message 1–500 chars, history capped at the last 8 turns / 500 chars each;
   every history turn is forced to `user`/`assistant` (a client cannot inject
   a system turn).
3. Fixed system prompt (Nathan's public site persona; never invents private
   details). The model is pinned to `@cf/meta/llama-3.1-8b-instruct-fp8-fast`.
4. Quota + logging ride the internal `api_keys` row **`site-avatar`**
   (monthly cap, e.g. 2000 req/month; usage visible in `ai_usage`/`ai_logs`).
   Disable that key and the widget's backend turns the feature off — no
   redeploy needed. No key ever reaches the browser.

## First-party analytics (自建访问统计)

The site measures its own traffic end-to-end with no third party. The
collection path: `initAnalytics()` in main.js (every page, incl. 404) fires a
`navigator.sendBeacon` pageview to `POST /api/analytics/hit` and a second
beacon with the time-on-page when the page becomes hidden. `analytics.js`
ingests into D1; the admin **Stats** tab (stats_page.js) reads it back through
`/admin/api/stats` and `/admin/api/visitor`.

Privacy design (mirrored in the site's `/privacy` policy page):

- **The IP is never stored.** `visitor_id` = `sha256(ANALYTICS_SALT + IP + UA)`
  truncated to 24 hex chars — pseudonymous and stable per browser+network, so
  the stats can follow *a* visitor without knowing who they are. No cookies,
  no cross-site identifiers; the session id (`visit_id`) lives in the
  visitor's own `sessionStorage`.
- **Bots are dropped at ingest** — a UA blocklist (search crawlers, uptime
  monitors, previewers, headless…) plus the client-reported
  `navigator.webdriver` flag never reach the tables at all.
- **Every failure answers 204**; junk payloads, foreign `Origin`s and
  rate-limited floods (60/min/IP via the `analytics_rate` table, counted by
  the shared `bumpRateWindow`) are silently dropped.
- Day buckets are **UTC+8** (`dateOf()`), matching the audience.
- The owner marks their own browser once with
  `localStorage.npSelf = '1'`; those hits carry `is_self = 1` and are
  excluded from the dashboard unless "Include my visits" is ticked.

Storage (all pruned after **13 months** by the nightly cron):

- `analytics_hits` — one row per pageview: path, referrer (host + path +
  kind: direct/search/social/other), `request.cf.country`, hand-rolled
  UA classification (device/browser/os), language/timezone, session depth,
  duration backfill, `is_self`.
- `analytics_visits` — one row per tab session (upserted per pageview:
  entry/exit path, hit count, referrer) so sessions/bounce/entry-exit need no
  raw scans.
- `analytics_visitors` — one row per visitor id: first/last seen, total hits,
  session count (incremented in the same ingest batch only when the
  `visit_id` is genuinely new), latest path/referrer/device/etc.
- `analytics_rate` — the ingest limiter window counters.

The Stats tab shows KPI tiles (PV / UV / sessions / bounce / avg time on page
/ new-visitor share), a hand-rolled SVG daily trend (crosshair + tooltip +
keyboard access + a table view), top pages, referrer tables and per-kind
breakdowns, device/browser/OS/language/country breakdowns, the per-visitor
list with a sessions + timeline drill-down dialog, and the recent-pageviews
feed. Series colors are the site teal + blue, validated for CVD safety in
both themes (`#1abc9c/#2a78d6` light, `#16a085/#3987e5` dark).

Setup: the `ANALYTICS_SALT` secret (`npx wrangler secret put ANALYTICS_SALT`,
any long random string). Missing salt degrades to an empty one — ingest keeps
working but with weaker visitor separation.

## D1 setup

Database `nathanpenny`, bound as `env.DB` (`wrangler.jsonc`). Tables:

- `comments` (+ the `ip_hash` column added by `ALTER TABLE`), `comment_rate`
  — comment feature (created manually 2026-07; the DDL now also lives in
  `workers/schema.sql`, dumped verbatim from prod)
- `banned_ips` — comment moderation blocklist (salted IP hashes)
- `drafts` — 写作台 drafts + `publish_at` schedules
- `chat_rate` — per-IP limiter for `/api/site-chat`
- `analytics_hits`, `analytics_visits`, `analytics_visitors`,
  `analytics_rate` — first-party analytics (see the section above)
- `api_keys`, `ai_usage`, `ai_logs` — AI proxy; (re)create idempotently:

```sh
npx wrangler d1 execute nathanpenny --remote --file workers/schema.sql
```

## Deploy

From this directory:

```sh
npx wrangler deploy
```

Deploying without the `DB` binding makes every endpoint fail with 500 —
never remove it from `wrangler.jsonc`. Validate config changes first with
`npx wrangler deploy --dry-run`.

Managed outside this repo: the `workers.nathanpenny.fun` custom domain, the
Access application + policy (Zero Trust dashboard), the secrets
(`TURNSTILE_SECRET`, `GITHUB_TOKEN`, `CF_AI_TOKEN`, `ANALYTICS_SALT` — check
with `npx wrangler secret list`), the D1 rows for API keys (including the
internal `site-avatar` one), and the verified email destination address
behind the `NOTIFY` send_email binding (`notify@nathanpenny.fun` — an Email
Routing rule relays it to the owner's real mailbox, kept out of this public
repo). Secrets are set
with `npx wrangler secret put <NAME>`; a missing `CF_AI_TOKEN` makes the AI
proxy and site chat return 503, and the editor fails closed with a 503 hint
until `GITHUB_TOKEN` exists.

## Cron: scheduled publishing + nightly pruning

`wrangler.jsonc` registers two crons → `scheduled()` in comments.js branches
on `controller.cron`:

- `*/15 * * * *` → `publishDueDrafts()` (see Drafts & scheduled publishing)
- `17 3 * * *` (03:17 UTC, off-peak for the APAC audience) → `pruneTables()`:

- `ai_logs` rows older than 90 days — batched id-subquery deletes (D1 has no
  `DELETE ... LIMIT`), capped rounds so a large backlog shrinks over days
  instead of blowing the invocation's CPU budget
- `ai_usage` months older than 13 months
- `comment_rate` windows older than a day (backstop for the opportunistic
  sweep already in `checkRateLimit()`)
- `analytics_hits` / `analytics_visits` / `analytics_visitors` older than
  13 months (the privacy policy's retention promise), and `analytics_rate`
  windows older than a day

D1's free tier enforces daily row-read limits (since 2026-09), so the
append-only tables must not grow unbounded. Prune failures are logged,
never thrown. Local test: `npx wrangler dev`, then
`curl "http://localhost:8787/cdn-cgi/handler/scheduled?format=json"`.

## New-comment email notification

After a comment is successfully inserted, the Worker sends the owner a
fire-and-forget email via the `NOTIFY` send_email binding
(`ctx.waitUntil` — a failed send never affects the comment response, and
rejected comments never reach the send line). The binding's
`destination_address` in `wrangler.jsonc` pins the single allowed recipient:
the account's **verified destination address**. Sends to verified
destination addresses are free on every plan and never count against quotas.

Content is deliberately minimal — commenter name + a 300-char excerpt; no
commenter email, no IP, no full text. From: `noreply@nathanpenny.fun`,
which requires the `nathanpenny.fun` sending domain onboarded (Email
Service in the dashboard; `npx wrangler email sending enable
nathanpenny.fun` does the same from the CLI but 403s under a default
`wrangler login` — it lacks the zone email-sending scope). Prerequisites:
a routing rule delivers `notify@nathanpenny.fun` to the owner's real
mailbox, and that address is verified under Email Routing → Destination
Addresses. Without the binding deployed the feature is simply off.

## Turnstile (comment spam protection)

`POST /comments` requires a valid Cloudflare Turnstile token from the comment
form on the Contact page. The widget's site key is public and lives in
`pages/contact.html`; the **secret key must never be committed to this repo** —
store it in the Worker's secret store:

```sh
wrangler secret put TURNSTILE_SECRET
# paste the secret when prompted, then deploy the worker
```

Verification rules in `verifyTurnstile()`:

- `success === true` from `https://challenges.cloudflare.com/turnstile/v0/siteverify`
- token `action` must equal `comment` (set via `data-action` on the widget)
- token `hostname` must be one of `nathanpenny.fun`, `blog.nathanpenny.fun`,
  `pan-nie.github.io` — localhost is deliberately NOT allowed, so local
  end-to-end testing of the comment post will get a 403. To test the full flow
  locally, temporarily swap in Cloudflare's official test keys
  (sitekey `1x00000000000000000000AA`, secret `1x0000000000000000000000000000000AA`),
  then swap back before deploying.

If `TURNSTILE_SECRET` is not set the endpoint fails closed with a 500, so
comments cannot be posted until the secret is configured.

## Notes

- CORS: `/comments` only echoes allowlisted origins (`nathanpenny.fun`,
  `blog.nathanpenny.fun`, `pan-nie.github.io`, `localhost:8080`);
  `/api/ai` allows `*` (bearer-key auth). The email field is stored but never
  returned by `GET /comments`.
- The rate limiter fails open on D1 trouble (comments keep working if the
  `comment_rate` table is missing); Turnstile still guards the write path.
- Local dev quirk: `wrangler d1 execute --local` storage follows the current
  directory — run it from `workers/` so it shares state with `wrangler dev`.

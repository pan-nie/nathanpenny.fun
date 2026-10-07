# CLAUDE.md

Guidance for AI agents (and humans) working in this repository. [AGENTS.md](AGENTS.md)
is a pointer to this file. The doc of record for the Worker backend is
[workers/README.md](workers/README.md) — this file deliberately does **not**
duplicate its per-endpoint detail, because duplicated docs drift (that is
exactly what happened to the old AGENTS.md).

## Overview

A hand-rolled static personal website + blog (`nathanpenny.fun`). There is no
build step, no bundler, no `package.json`, no framework, and no test suite:
pages are plain HTML, styling is one stylesheet, and `scripts/main.js` is a
single shared script loaded on every page. The only backend is one Cloudflare
Worker (`workers/comments.js`) with a D1 database and an R2 bucket.

Where content lives: page copy is authored directly in the HTML, list content
in the `data/*.json` files, and posts as Markdown in `posts/`.

## Commands

Nothing to install.

- **Preview locally**: `python -m http.server 8080` from the repo root. Port
  8080 is allowlisted in the Worker's CORS list, so comments and analytics work
  locally too.
- **Publish a post (写作台)**: `https://workers.nathanpenny.fun/admin`
  (Cloudflare Access) → Editor tab → **Publish** (Cmd/Ctrl+S). The Worker commits
  `posts/<slug>.md` through the GitHub Contents API and CI regenerates the
  pages (~1 min). The same tab opens/edits/deletes existing posts, saves D1
  drafts (optionally scheduled), and imports `.md` files.
- **Upload images**: admin → Images tab → drag/drop/paste, then copy the
  markdown snippet. Objects land in R2 and are served from
  `storage.nathanpenny.fun`. The Editor tab can upload + insert markdown
  directly.
- **Update the music library (音乐库)**: admin → Music tab → drag an
  `Artist/Album/` folder (or loose files) → Upload → Sync & publish. Audio goes
  to R2 `music/`, covers are looked up on iTunes and committed under
  `images/music-covers/`, and `data/music-library.json` is rebuilt and
  committed. No local tooling is involved.

  Two things decide whether a cover is found: **Artist and Album must be real**
  (a loose file dropped on its own defaults to the literal `Unknown Artist` /
  `Unknown Album`, which nothing can ever match — the most common way to "get no
  cover"), and the filename should be `<Title>-<Artist>.ext`, since another
  separator leaves the derived title polluted. Sync retries any published song
  that still lacks a cover, so a failed lookup is not permanent and never needs
  a delete-and-re-upload. The cover *search* runs in the admin's browser because
  Apple throttles the Worker's shared egress IP; the matching still runs
  server-side, so don't move it back. Details, plus the `stage` codes failures
  report: [workers/README.md](workers/README.md).
- **Regenerate the blog pages**: `python3 tools/gen_post_pages.py` — this is
  what CI runs.
- **Issue an AI API key**: `python3 tools/ai_key.py <name> [monthly_limit]`,
  then apply the SQL it prints with
  `npx wrangler d1 execute nathanpenny --remote --command "<sql>"`. The script
  prints the statement; it does not apply it.
- **Check the admin tabs' inline scripts**: `node tools/check_admin_scripts.mjs`
  — run this after touching any `workers/*_page.js` tab file (see the
  inline-script rule below).
- **Deploy the site**: `git push origin main` — static files are served as-is.
  There is no `CNAME` file, so domain/host wiring lives in a dashboard.
- **Deploy the Worker**: `cd workers && npx wrangler deploy` (config in
  `workers/wrangler.jsonc`). The Worker is **not** part of the git-deployed
  static site.

## Repo layout

```
index.html, 404.html         hand-maintained pages
pages/*.html                 the other 7 hand-maintained pages
blog/<slug>/index.html       GENERATED single-post pages (never edit)
posts/*.md                   post sources (the only blog input)
scripts/main.js              the one shared script
scripts/vendor/              highlight.min.js (vendored, lazily injected)
styles/style.css             the one site stylesheet
data/*.json                  gallery / creations / achievements / music library
images/ fonts/ audio/ pdfs/ docs/    assets
workers/                     the Cloudflare Worker (see workers/README.md)
tools/                       gen_post_pages.py, ai_key.py, check_admin_scripts.mjs
```

## Static pages

Eight hand-maintained pages carry the same `nav` markup, copied by hand (there
is no templating): `index.html`, and
`pages/{about,blog,gallery,creations,achievements,contact,privacy}.html`. The
copies are not byte-identical — only the `./` vs `../` prefixes and the
`aria-current="page"` link differ. `404.html` and the generator's post template
carry the same nav too.

**The footer is the exception.** Every page carries only an empty
`<footer></footer>` shell; `initFooter()` in `scripts/main.js` renders its
content (logo, sub-site links, "© 2026 … HTML + CSS + JavaScript · Privacy").
Sub-sites that live on their own hostnames (e.g. `tsinghua.nathanpenny.fun`) are
pills in the `.footer-subsites` row above the copyright line — add one `<a>`
there, not in the pages. Edit the footer there, never in the pages.

Page notes:

- `pages/blog.html` — single-column post list: heading, search bar
  (`#blogSearch`, with clear button + match-count line), then one summary card
  per post. No sidebar; the sticky TOC lives only on single-post pages.
- `pages/achievements.html` — rendered by `initAchievements()` from
  `data/achievements.json` (schema in [docs/achievements.md](docs/achievements.md));
  an empty data file shows the built-in empty state.
- `pages/contact.html` — social links, comment form, and the threaded
  discussion (one level of replies, with the reply target shown as a chip).
- `pages/privacy.html` — English-only privacy policy linked from every footer.
  Keep it truthful: it documents the first-party analytics, the comment data,
  GA4, and the deliberate no-cookie-banner stance.

Because `pages/*.html` live one level deep, their asset paths use `../`;
`index.html` uses `./`. When adding a page, copy the nav from an existing page,
fix the prefixes, and give it an empty `<footer></footer>` shell.

### URLs and root files

`_redirects` maps the friendly URLs (`/about`, `/blog`, …) onto `pages/*.html`
as **200 rewrites** — targets deliberately omit `.html` so Cloudflare Pages'
Prettify can't 308 them into `/pages/<name>`. It also carries a `/blog/`
trailing-slash twin and a legacy `/games → /achievements 301`.

`404.html` is UFO-themed and served with HTTP 404 for any URL matching no real
asset; it uses root-absolute asset paths because it renders at arbitrary depths.

`.well-known/security.txt` (RFC 9116; `Contact` is the `notify@` relay, never
the real mailbox) is served only because the empty `.nojekyll` marker sits
beside it at the repo root — GitHub Pages runs Jekyll without that marker, and
Jekyll silently drops dot-directories. Don't delete `.nojekyll`. Renew
`Expires` yearly (currently 2027-09-04). `robots.txt` allows everything and
points at the sitemap.

`.gitattributes` pins `* text=auto eol=lf` for all text and marks the binary
asset types, so line endings stay LF no matter the platform. Leave it in place
and write LF files — a CRLF file will be renormalized on commit and shows up as
a spurious whole-file diff.

## PWA

`manifest.json` + `sw.js` + the icons make the site installable and available
offline. The manifest's `icons` array lists **192 and 512 only** (each twice:
normal + `maskable`); `images/icon-180.png` is not a manifest icon — it is the
`apple-touch-icon` `<link>` in every page head.

`sw.js` precaches ~35 shell entries and routes requests as:

- **network-first** for navigations, `.html`, and code files
  (`.css`/`.js`/`.json`/`.xml`) — so deploys show up;
- **cache-first** for other static assets (images, audio, fonts);
- offline misses fall back to the cached `404.html`, served **with a 404
  status**; cross-origin and non-GET requests are skipped.

Bump `CACHE_VERSION` in `sw.js` (currently `v31`) when a deploy changes cached
assets in a way users must see immediately.

## Stylesheets

`styles/style.css` is the site's own stylesheet, organized top-to-bottom into
sections marked with banner comments. The real banners, in order:

```
GLOBAL BASICS & RESETS · LAYOUT · HEADER & NAVIGATION
MOBILE MENU (full-screen frosted overlay, built by initMobileMenu)
HOME PAGE · ABOUT PAGE · BLOG PAGE · GALLERY PAGE · CREATIONS PAGE · CONTACT PAGE
COMMENTS · FOOTER
WIDGETS: PROGRESS BAR, BACK TO TOP, TOAST
WIDGETS: AI AVATAR CHAT
404 PAGE · ACHIEVEMENTS PAGE · TOUCH INPUT FALLBACKS
```

Add new styles under the matching banner rather than at the end of the file.

All colors are CSS custom properties on `:root`. The dark palette lives in
**two blocks that must stay in sync** (42 properties each): the automatic
`@media (prefers-color-scheme: dark)` → `:root:not([data-theme="light"])`, and
the manual toggle `:root[data-theme="dark"]`. Change both.

`--hljs-*` properties (8 of them, declared in each palette) are the site's own
syntax-highlighting colors; there is no stock highlight.js theme.

The only other stylesheet is the vendored `fonts/fontawesome/css/all.min.css`
(self-hosted Font Awesome 6.5.2).

## Scripts

`scripts/` contains exactly two files: `main.js` and
`vendor/highlight.min.js` (highlight.js 11.9.0, BSD-3). `main.js` is loaded
with `defer` on every page and initializes everything from a single
`DOMContentLoaded` listener at the bottom — with one exception:
`registerServiceWorker()` is called just outside it.

Feature inventory (each a guarded `init*` function unless noted): analytics
beacon, GA4, blog search + category filtering, nav scroll padding, mobile menu,
gallery search + lightbox, creations filters / music search / audio player,
comments (one-level replies), WeChat QR modal, home latest-posts cards, theme
toggle, reading progress and reading time, back to top, About-page AI chat,
starfield (plus the UFO easter egg, meteors, and the 404-page saucer), cursor
spotlight, card glow, scroll reveal, code highlighting, achievements, footer.

Patterns to match:

- **Guard by element.** Most features start with a `document.getElementById(...)`
  null-check so the one shared script can run on every page. A few
  (`initCardGlow`, `initScrollReveal`, `initBackToTop`) create or query their own
  nodes instead and have no such guard.
- **Escape all user input.** Anything user-provided (names, emails, comment
  text) goes through the local `escapeHtml()` helper before it reaches
  `innerHTML`. Never render user input unescaped.

### Traps in `main.js`

- `initSiteChat()` is **About-page only**: it returns early unless
  `#aboutAvatar` exists, and it creates no floating button — clicking the About
  portrait (which gains an AI badge) opens a `<dialog>` that talks to
  `/api/site-chat`, with no key in the client.
- The theme toggle cycles **light ↔ dark only**. "System" is merely the default
  when no `theme` key is stored, not a third option in the UI.
- Each page's `<head>` has a tiny inline script that applies the saved theme
  before first paint to avoid a flash. It is hand-copied into the 8 pages plus
  `404.html`, and emitted by the generator for post pages — update all of them
  if the storage key changes.

## Data files

| File | Shape | Notes |
|---|---|---|
| `data/gallery.json` | `{id, src, title, description, category, date}` | Gallery page source of truth (fetched at runtime); filter categories are auto-derived from the data |
| `data/creations.json` | `{id, type: song\|video, origin, title, description, src, date}` | Songs carry `cover`, videos carry `poster`. Videos may add `platform: file\|bilibili\|youtube`: `file`/omitted = native `<video>`; otherwise `src` is the normal watch-page URL and `main.js` derives the embed (YouTube via the no-cookie domain). `origin` is recorded but not rendered |
| `data/achievements.json` | `[{id, icon, title, items: [{id, title, badge, description, links: [{label, url}], date}]}]` | Rendered by `initAchievements()`; schema and limits in [docs/achievements.md](docs/achievements.md) |
| `data/music-library.json` | `{id, type, title, artist, album, src, cover}` | **Generated** by the Worker's Music tab from a full R2 listing — never hand-edit. `cover` is null for a song whose lookup failed; the next Sync retries those (`plan.needsCover`) |

All four are precached by `sw.js`. The first three (gallery, creations,
achievements) are edited in the admin **Content** tab, which commits them
through the GitHub Contents API, or by hand.

## Blog content

Each post is `posts/<slug>.md`: a frontmatter block plus a Markdown body. The
slug is the filename stem — the generator does not validate it (the Worker's
写作台 enforces `^[a-z0-9][a-z0-9-]{0,63}$` when creating posts).

Frontmatter fields (unknown keys are **silently ignored**, so a `cateogry:` typo
silently becomes `misc`):

- `title` — required, non-empty.
- `date` — required; parsed with `datetime.date.fromisoformat`, so `YYYY-MM-DD`
  is the canonical form but Python also accepts forms like `20260101`.
- `description` — optional, used verbatim and untruncated. If empty, the
  generator falls back to the first `<p>…</p>` of the **rendered** body,
  truncated at 165 characters — so a post that opens with a heading or an image
  gets an empty description.
- `category` — optional, defaults to `misc`; must be one of the generator's
  fixed slugs.
- `tags` — optional, comma-separated, rendered as `#tag` chips. Currently
  unexercised: no live post uses it.

The nine category slugs, in chip order: `anime`, `life`, `tech`, `fun`,
`fiction`, `travel`, `ai`, `sports`, `misc`. Every chip is always rendered,
including zero counts.

**Authoring footguns.** The frontmatter block must begin at byte 0 — a BOM
aborts the run. Values are never de-quoted, so `date: "2026-01-01"` and
`category: "tech"` both fail. The renderer does not escape HTML, so authored
content is trusted — and raw HTML is the normal way to embed video/audio, or
images with explicit width/height.

### The renderer

Supported: headings `#`–`####` (rendered one level deeper, as `h2`–`h5`); bold
`**`; italic `*`; strikethrough `~~`; inline code; inline links `[text](url)`;
autolinks `<http(s)://…>`; images — every **markdown** image gets
`class="blog-img"` plus lazy/async attributes, while raw `<img>` does not;
fenced code with a language tag; blockquotes (consecutive `>` lines are joined
into a single `<p>`); `hr` (a line that is exactly `---`); ordered/unordered
lists with indentation-based nesting; task lists (`- [ ]`); pipe tables with
`:---` alignment; and raw HTML blocks.

Not supported: `_italic_`/`__bold__`, `#####`/`######`, setext headings, hard
line breaks (two trailing spaces are collapsed — use `<br>`), backslash
escapes, reference links and link titles, footnotes, math, loose
(blank-line-separated) lists, and multi-line list items.

Two renderer quirks worth knowing: a **nested list is emitted as a sibling of
the parent `</li>`**, not inside it, so `li > ul` selectors and true list
nesting do not apply; and a **raw HTML block ends at the first blank line**.
Pipe tables require the header *and* body rows to start with `|`, and delimiter
cells need at least three dashes.

### What the generator writes

`tools/gen_post_pages.py` is stdlib-only and idempotent (two runs produce
byte-identical output, except that `sitemap.xml` stamps static pages with
today's date). It regenerates, newest first:

- the category chips and post cards in `pages/blog.html`, **only** between the
  marker pairs `<!-- posts:filters:start -->`/`:end` and
  `<!-- posts:articles:start -->`/`:end` — never edit inside those markers
  (everything else in that file is hand-maintained);
- `blog/<slug>/index.html` — a full page (theme script, empty footer shell,
  canonical URL, article og tags, BlogPosting JSON-LD, a category badge linking
  to `blog.html?cat=<slug>`, the all-posts sidebar TOC, newer/older nav, and a
  "More in <Category>" block of up to 3 same-category posts when any exist);
- `feed.xml` and `sitemap.xml`.

It also **prunes any directory under `blog/` that isn't a current slug** — so
never put assets there. Card thumbnails come from the first relative image or
video poster in the body, falling back to `images/og-image.jpg`. Asset paths in
post bodies are authored relative to `pages/` (`../images/…`), and the
generator deepens `src`/`poster`/`href` by one level for the single-post pages
(`srcset`, `data-src`, and CSS `url()` are not touched).

Ordering is by `(date, slug)` descending everywhere — so posts sharing a date
break ties by slug **descending**, which authors cannot control.

Publishing = edit/create the `.md` and push. CI
(`.github/workflows/gen-posts.yml`) runs the generator on pushes touching
`posts/**`, `tools/gen_post_pages.py`, or `pages/blog.html` (plus manual
dispatch) and commits the results back to main. A separate weekly
`link-check.yml` (Mondays 03:00 UTC, lychee) fails on genuinely unreachable
links, excluding the social profiles and `storage.nathanpenny.fun` that block
bots.

## Backend (Cloudflare Worker)

`workers/comments.js` is a Worker module with a D1 binding `env.DB` and an R2
binding `env.R2` (bucket `nathanpenny-fun`). It directly imports `access.js`,
`admin_page.js`, `editor.js`, `analytics.js`, `moderation.js`, `drafts.js`,
`music.js`, and `ai_proxy.js`; `admin_page.js` pulls in the tab fragments
`editor_page.js`, `content_page.js`, `music_page.js`, `ai_page.js`,
`stats_page.js`, and `comments_tab.js`.

**Never `\"`-escape inside a tab fragment.** Tab fragments are one big template
literal, so a backslash-escaped quote is eaten at runtime, the rendered script
gets a SyntaxError, and the whole tab dies while the page still renders. Use
single quotes for inner quotes. After editing any tab file, run
`node tools/check_admin_scripts.mjs`, which reconstructs every inline script as
the browser sees it and `node --check`s it. Companion rule: `admin_page.js`
carries a global `[hidden] { display: none !important; }`, because tab CSS
display rules would otherwise defeat the `hidden` attribute.

### Route map

Detail, including every query parameter, is in
[workers/README.md](workers/README.md). Grouped index:

| Group | Paths | Protection |
|---|---|---|
| Comments | `GET`/`POST` `/comments` | public (5/min/IP + Turnstile + ban check on POST) |
| Analytics beacon | `POST /api/analytics/hit` | public, own origin allowlist, always 204 |
| Site avatar chat | `POST /api/site-chat` | public, 3 msgs/60s/IP |
| Admin page | `GET /admin` (GET only) | Cloudflare Access |
| Image library | `/upload`, `/upload/folder`, `/upload/move` | Access |
| Posts + content data (写作台) | `/admin/api/posts`, `/admin/api/post`, `/admin/api/data` | Access |
| Drafts | `/admin/api/draft`, `/admin/api/drafts` | Access |
| Comment moderation | `/admin/api/comments`, `/admin/api/comment`, `/admin/api/ban`, `/admin/api/bans` | Access |
| Stats | `/admin/api/stats`, `/admin/api/visitor` | Access |
| Music library | `/admin/api/music`, `/admin/api/music/*` | Access |
| AI proxy | `/api/ai/v1/models`, `/api/ai/v1/chat/completions` | Bearer `npai_…` key |
| anything else | — | 404 |

One method trap hides in that table: the **plural and singular paths differ**.
`GET` exists only on `/admin/api/bans` and `/admin/api/drafts`; `POST`/`DELETE`
exist only on the singular `/admin/api/ban` and `/admin/api/draft`. `GET` on the
singular returns 405.

Access is a Zero Trust dashboard app covering `/admin` and `/upload` (email
OTP, team `square-surf-c2a6`). The Worker **also** verifies the
`Cf-Access-Jwt-Assertion` JWT itself (`ACCESS_TEAM_DOMAIN`/`ACCESS_AUD` vars,
fail-closed), which closes the `*.workers.dev` bypass. Local dev escape hatch:
the gitignored `workers/.dev.vars` with `ADMIN_BYPASS=1` — never deploy with it.

### Cross-cutting conventions

- **CORS.** `/comments` and `/api/analytics/hit` each carry their own copy of
  the same four-origin allowlist, matched exactly (schemes included):
  `https://nathanpenny.fun`, `https://blog.nathanpenny.fun`,
  `https://pan-nie.github.io`, `http://localhost:8080`. Any other origin
  gets no `Access-Control-Allow-Origin` header at all. Only `/api/ai/*` uses
  `*` (bearer auth, no cookies).
- **CSRF line on admin JSON endpoints.** The JSON-body endpoints
  (`POST /admin/api/post`, `/admin/api/data`, `/admin/api/draft`,
  `/admin/api/music/cover`) require `Content-Type: application/json` and answer
  415 otherwise, and they emit no CORS headers on real responses. Two
  exceptions: `/admin/api/music/upload` is `multipart/form-data`, and
  `/admin/api/ban` reports a bad body as 400 rather than 415.
- **Schema.** `workers/schema.sql` is idempotent and creates **twelve** tables:
  `api_keys`, `ai_usage`, `ai_logs`, `comments`, `comment_rate`, `chat_rate`,
  `analytics_hits`, `analytics_visits`, `analytics_visitors`, `analytics_rate`,
  `banned_ips`, `drafts`. Apply with
  `npx wrangler d1 execute nathanpenny --remote --file workers/schema.sql`.
  `comments.ip_hash` and `comments.parent_id` are present as migration notes.
- **Privacy by construction.** The raw IP is never stored. Comments keep a
  16-hex salted hash (`ip_hash`, same `ANALYTICS_SALT` secret); analytics
  derives `visitor_id` as a 24-hex truncation of `sha256(salt + IP + UA)` and
  keeps the session id in the visitor's `sessionStorage` (no cookies). Bots are
  dropped at ingest. Day buckets are UTC+8. The owner flags their own browser
  with `localStorage.npSelf = '1'`, and the Stats tab hides those visits unless
  asked to include them. Keep all of this true, since `/privacy` states it.
- **Crons.** Two triggers: `*/15 * * * *` publishes due scheduled drafts through
  the same compose → validate → commit path the editor uses (an invalid draft
  drops its schedule instead of retrying forever); `17 3 * * *` prunes
  `ai_logs` (>90d), `ai_usage` (>13mo), the three analytics tables (~13 months),
  and the rate-limit tables (>1d).
- **New comments** fire a fire-and-forget owner email through the `NOTIFY`
  `send_email` binding (destination `notify@nathanpenny.fun`, a relay address —
  the real mailbox stays out of the repo). Removing the binding turns the
  feature off.
- **AI proxy** has a single upstream: Cloudflare Workers AI, addressed as
  `cf-{author}/{model}` and rewritten to `@cf/…`. Only a `cf-` prefix is
  accepted — anything else is a 400, so the catalog array is cosmetic but the
  prefix is not. Keys are `npai_…` and only their SHA-256 hash is stored; a
  monthly request-count breaker lives in `ai_usage` (429 when exhausted,
  fail-open on D1 trouble). For streamed calls the usage log is written by the
  `TransformStream` pump *before* the client stream closes, because a
  `waitUntil` D1 write issued after a streamed response silently never lands.

[workers/README.md](workers/README.md) is the detailed per-endpoint reference
and is kept in sync with the code. When you change the Worker's routes or its
behaviour, update that file — don't grow this section instead.

## Other notes

- `audio/` holds one tracked mp3 used by a single blog post; the local
  `audio/my-music/` library (~1GB) is gitignored, as is `learning-resource/`
  (personal study notes, not part of the site).
- `pdfs/NathanPenny-CV-for-fun.pdf` is the CV download linked from About;
  `docs/` holds its `.docx` source plus `docs/achievements.md`.
- GA4 is loaded in `main.js` with a hardcoded measurement ID (`G-5X78JT0JSQ`),
  deferred until after `window` load + idle so unreachable regions (mainland
  China) don't stall page load. Cloudflare Web Analytics is also active
  (dashboard-side, not in this repo).
- Third-party assets are self-hosted under `fonts/` for China accessibility:
  Open Sans (latin 400, the only weight in use) via a `@font-face` at the top of
  `style.css`, and Font Awesome 6.5.2 vendored woff2-only. highlight.js is
  vendored under `scripts/vendor/` and injected lazily. No page loads CSS or JS
  from an external CDN — keep it that way.
- The logo is `NP-logo.svg`; the avatar is **`images/NathanPenny.webp`** (used
  by About, Gallery, and the AI chat). `images/NP.png` exists but is referenced
  nowhere.

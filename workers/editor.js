// Markdown editor backend for the 写作台 tab on the /admin page.
// Publishes posts/<slug>.md to GitHub (pan-nie/nathanpenny.fun, branch
// main) via the Contents API; the gen-posts workflow then regenerates the
// static pages, so the site itself never changes shape. No database — the
// repository stays the single source of truth.
// Requires the GITHUB_TOKEN secret: a fine-grained PAT with Contents: Read
// and write on that one repository (`npx wrangler secret put GITHUB_TOKEN`).

import { verifyAccess, accessDenied } from "./access.js";

const GITHUB_OWNER = "pan-nie";
const GITHUB_REPO = "nathanpenny.fun";
const GITHUB_BRANCH = "main";
const CONTENTS_API = "https://api.github.com/repos/" + GITHUB_OWNER + "/" + GITHUB_REPO + "/contents";

// Keep in sync with tools/gen_post_pages.py CATEGORIES — an unknown slug
// makes the generator sys.exit and turns the CI run red.
const CATEGORIES = ["anime", "life", "tech", "fun", "fiction", "travel", "ai", "sports", "misc"];

// The generator uses the raw filename stem with no validation at all, so
// this regex is the only thing standing between a typo and a red CI run.
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_CONTENT_BYTES = 256 * 1024;
const MAX_BODY_CHARS = 400000; // JSON envelope guard, checked before parsing

const JSON_HEADERS = { "Content-Type": "application/json", "Cache-Control": "no-store" };

function editorJson(status, payload) {
  return new Response(JSON.stringify(payload), { status, headers: JSON_HEADERS });
}

// btoa() throws on non-latin1 text (all Chinese posts) and huge argument
// lists, so encode UTF-8 bytes in 0x8000-char chunks. Shared with music.js
// (the music-library JSON commit).
export function base64EncodeUtf8(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function base64DecodeUtf8(b64) {
  const bin = atob(String(b64).replace(/\s/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// All editor GitHub calls funnel through here so the token can never leak
// into logs or error responses — only status codes and GitHub's message do.
export async function ghFetch(env, path, init) {
  return fetch(CONTENTS_API + path, {
    method: (init && init.method) || "GET",
    body: init && init.body,
    headers: {
      "Authorization": "Bearer " + env.GITHUB_TOKEN,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "nathanpenny-fun-editor",
      "Content-Type": "application/json"
    }
  });
}

// GitHub error bodies never echo the token, but cap the relayed message anyway.
export async function ghMessage(res) {
  try {
    const data = await res.json();
    return data && data.message ? String(data.message).slice(0, 200) : "GitHub API " + res.status;
  } catch (error) {
    return "GitHub API " + res.status;
  }
}

// Mirror of the generator's hard rules — every failure here would otherwise
// make tools/gen_post_pages.py sys.exit and leave a red CI run behind.
export function validatePost(content) {
  if (typeof content !== "string" || content.length === 0) return "Content is empty";
  if (content.charCodeAt(0) === 0xfeff) return "Content starts with a BOM — the generator requires frontmatter at byte 0; remove it";
  if (!content.startsWith("---\n")) return "Must start with frontmatter (--- on the first line)";
  const end = content.indexOf("\n---\n", 4);
  if (end === -1) return "Unclosed frontmatter (missing closing ---)";
  const fm = content.slice(4, end);

  const title = fm.match(/^title:[ \t]*(.+)$/m);
  if (!title || !title[1].trim()) return "Frontmatter is missing a title";

  const date = fm.match(/^date:[ \t]*(\S+)[ \t]*$/m);
  if (!date) return "Frontmatter is missing a date (YYYY-MM-DD)";
  // Round-trip: 2026-02-30 passes any regex but datetime.date.fromisoformat
  // in CI does not, so validate by parsing back.
  const d = date[1];
  const parsed = new Date(d + "T00:00:00Z");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== d) {
    return "date is not a valid YYYY-MM-DD (e.g. 2026-02-30 would fail CI)";
  }

  const cat = fm.match(/^category:[ \t]*(\S+)[ \t]*$/m);
  if (cat && !CATEGORIES.includes(cat[1])) {
    return "Unknown category \"" + cat[1] + "\" — valid: " + CATEGORIES.join(" / ");
  }

  return null;
}

// Compose the post document from the editor's structured fields. The editor
// form carries title/date/description/category/tags as separate inputs, so
// the markdown body never mixes with frontmatter (local .md files get their
// frontmatter parsed out client-side before import). Values are forced onto
// one line each so a stray newline can never break the YAML block; empty
// description/tags lines are omitted, matching the generator's fallbacks.
// Key order is canonical: title, date, description, category, tags.
export function composePost(meta, body) {
  const oneLine = (v) => String(v == null ? "" : v).replace(/[\r\n]+/g, " ").trim();
  const lines = [
    "---",
    "title: " + oneLine(meta.title),
    "date: " + oneLine(meta.date)
  ];
  const description = oneLine(meta.description);
  if (description) lines.push("description: " + description);
  lines.push("category: " + (CATEGORIES.includes(meta.category) ? meta.category : "misc"));
  const tags = oneLine(meta.tags);
  if (tags) lines.push("tags: " + tags);
  const bodyText = String(body == null ? "" : body).replace(/^\n+/, "").replace(/\s+$/, "");
  return lines.join("\n") + "\n---\n\n" + bodyText + (bodyText ? "\n" : "");
}

function requireToken(env) {
  if (!env.GITHUB_TOKEN) {
    return editorJson(503, { error: "GITHUB_TOKEN not configured — run: npx wrangler secret put GITHUB_TOKEN" });
  }
  return null;
}

async function listPosts(env) {
  const noToken = requireToken(env);
  if (noToken) return noToken;

  const res = await ghFetch(env, "/posts?ref=" + GITHUB_BRANCH);
  if (res.status === 401 || res.status === 403) {
    return editorJson(503, { error: "GITHUB_TOKEN rejected (expired or insufficient permissions): " + (await ghMessage(res)) });
  }
  if (!res.ok) return editorJson(502, { error: await ghMessage(res) });

  const items = await res.json();
  const posts = (Array.isArray(items) ? items : [])
    .filter((it) => it.type === "file" && it.name.endsWith(".md"))
    .map((it) => ({ slug: it.name.slice(0, -3), size: it.size, sha: it.sha }))
    .sort((a, b) => (a.slug < b.slug ? -1 : 1));
  return editorJson(200, { posts });
}

async function readPost(env, url) {
  const slug = url.searchParams.get("slug") || "";
  if (!SLUG_RE.test(slug)) return editorJson(400, { error: "Invalid slug (lowercase letters, digits, hyphens only)" });

  const noToken = requireToken(env);
  if (noToken) return noToken;

  const res = await ghFetch(env, "/posts/" + encodeURIComponent(slug) + ".md?ref=" + GITHUB_BRANCH);
  if (res.status === 404) return editorJson(404, { error: "Post not found: " + slug });
  if (!res.ok) return editorJson(502, { error: await ghMessage(res) });

  const data = await res.json();
  return editorJson(200, {
    slug: slug,
    sha: data.sha,
    size: data.size,
    content: base64DecodeUtf8(data.content || "")
  });
}

async function publishPost(request, env) {
  // CSRF line: a cross-site form/fetch cannot send application/json without
  // triggering a preflight, and this API never answers preflights.
  const contentType = request.headers.get("Content-Type") || "";
  if (!contentType.includes("application/json")) {
    return editorJson(415, { error: "Content-Type must be application/json" });
  }

  const raw = await request.text();
  if (raw.length > MAX_BODY_CHARS) return editorJson(413, { error: "Request body too large" });

  let body;
  try {
    body = JSON.parse(raw);
  } catch (error) {
    return editorJson(400, { error: "Invalid JSON" });
  }

  const slug = typeof body.slug === "string" ? body.slug : "";
  if (!SLUG_RE.test(slug)) return editorJson(400, { error: "Invalid slug (lowercase letters, digits, hyphens only)" });

  // Two payload shapes: the admin editor sends structured {meta, body} which
  // gets a canonical frontmatter block composed here; a raw `content` string
  // (full document, frontmatter included) is still accepted as-is.
  let content;
  if (body.meta && typeof body.meta === "object") {
    content = composePost(body.meta, body.body);
  } else if (typeof body.content === "string") {
    content = body.content;
  } else {
    return editorJson(400, { error: "Provide {meta, body} or a full content string" });
  }

  const result = await commitPost(env, slug, content, { sha: body.sha || null });
  if (!result.ok) return editorJson(result.status, { error: result.error });
  return editorJson(result.created ? 201 : 200, {
    success: true,
    created: result.created,
    sha: result.sha,
    commit_url: result.commit_url
  });
}

// Commit a fully-composed post document to GitHub. Shared by the interactive
// editor API and the scheduled-draft publisher (drafts.js) so both paths
// validate, size-cap and commit identically. Returns a plain result object
// instead of a Response — the cron has no request/response context to reuse.
export async function commitPost(env, slug, content, opts) {
  const options = opts || {};
  const contentError = validatePost(content);
  if (contentError) return { ok: false, status: 400, error: contentError };

  if (new TextEncoder().encode(content).length > MAX_CONTENT_BYTES) {
    return { ok: false, status: 413, error: "Post exceeds 256KB" };
  }
  if (!env.GITHUB_TOKEN) {
    return { ok: false, status: 503, error: "GITHUB_TOKEN not configured — run: npx wrangler secret put GITHUB_TOKEN" };
  }

  const creating = !options.sha;
  const payload = {
    message: options.message || (creating ? "publish: " : "update: ") + slug + " (editor)",
    content: base64EncodeUtf8(content),
    branch: GITHUB_BRANCH
  };
  if (!creating) payload.sha = String(options.sha);

  const res = await ghFetch(env, "/posts/" + encodeURIComponent(slug) + ".md", {
    method: "PUT",
    body: JSON.stringify(payload)
  });
  if (res.status === 409 || res.status === 422) {
    return { ok: false, status: 409, error: "Changed on GitHub since you loaded it — reload the post and try again" };
  }
  if (!res.ok) return { ok: false, status: 502, error: await ghMessage(res) };

  const data = await res.json();
  return {
    ok: true,
    created: res.status === 201,
    sha: data.content && data.content.sha,
    commit_url: data.commit && data.commit.html_url
  };
}

async function deletePost(env, url) {
  const slug = url.searchParams.get("slug") || "";
  if (!SLUG_RE.test(slug)) return editorJson(400, { error: "Invalid slug (lowercase letters, digits, hyphens only)" });
  const sha = url.searchParams.get("sha") || "";
  if (!sha) return editorJson(400, { error: "Missing sha — open the post in the editor first" });

  const noToken = requireToken(env);
  if (noToken) return noToken;

  const res = await ghFetch(env, "/posts/" + encodeURIComponent(slug) + ".md", {
    method: "DELETE",
    body: JSON.stringify({ message: "delete: " + slug + " (editor)", sha: sha, branch: GITHUB_BRANCH })
  });
  if (res.status === 409 || res.status === 422) {
    return editorJson(409, { error: "Changed on GitHub — refresh the list and retry" });
  }
  if (res.status === 404) return editorJson(404, { error: "Post not found: " + slug });
  if (!res.ok) return editorJson(502, { error: await ghMessage(res) });

  return editorJson(200, { success: true });
}

// --- Content data files (the admin Content tab) ---------------------------------
// Whitelisted JSON files in the repo that drive static pages (gallery.json,
// creations.json). Same Contents-API commit path as posts — but no CI step:
// the static host serves data/*.json as-is, so a push is live in a minute.
// Achievements joins this map when its phase-2 editor lands.

const DATA_FILES = {
  gallery: { path: "data/gallery.json", label: "gallery" },
  creations: { path: "data/creations.json", label: "creations" },
  achievements: { path: "data/achievements.json", label: "achievements" }
};

// Per-file item validation: presence, types, and sane lengths. Unknown extra
// keys pass through untouched — the files stay hand-editable.
function validateItems(file, items) {
  if (!Array.isArray(items)) return file + " must be a JSON array";
  if (items.length > 500) return file + ": too many entries (500 max)";
  const str = (v, max) => typeof v === "string" && v.trim().length > 0 && v.length <= max;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it || typeof it !== "object" || Array.isArray(it)) return file + "[" + i + "]: not an object";
    if (!str(it.id, 80)) return file + "[" + i + "]: missing or overlong id";
    if (!str(it.title, 200)) return file + "[" + i + "]: missing or overlong title";
    if (!str(it.src, 600)) return file + "[" + i + "]: missing or overlong src";
    if (!str(it.date, 10) || !/^\d{4}-\d{2}-\d{2}$/.test(it.date)) return file + "[" + i + "]: date must be YYYY-MM-DD";
    if (typeof it.description !== "string" || it.description.length > 2000) return file + "[" + i + "]: description too long";
    if (file === "gallery") {
      if (!str(it.category, 40)) return file + "[" + i + "]: missing or overlong category";
    } else if (file === "creations") {
      if (it.type !== "song" && it.type !== "video") return file + "[" + i + "]: type must be song or video";
      if (it.origin !== "original" && it.origin !== "favorite") return file + "[" + i + "]: origin must be original or favorite";
      if (it.type === "video" && it.platform != null && !["file", "bilibili", "youtube"].includes(it.platform)) {
        return file + "[" + i + "]: platform must be file, bilibili or youtube";
      }
      for (const k of ["cover", "poster"]) {
        if (it[k] != null && (typeof it[k] !== "string" || it[k].length > 600)) return file + "[" + i + "]: " + k + " overlong";
      }
    }
  }
  return null;
}

// Achievements: an array of ordered sections, each holding ordered items
// (schema in docs/achievements.md). Dates are month- or day-precision;
// links must be absolute http(s) URLs.
function validateAchv(sections) {
  if (!Array.isArray(sections)) return "achievements must be a JSON array";
  if (sections.length > 20) return "achievements: too many sections (20 max)";
  const slug = (v) => typeof v === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(v);
  const opt = (v, max) => v == null || (typeof v === "string" && v.length <= max);
  for (let i = 0; i < sections.length; i++) {
    const s = sections[i];
    if (!s || typeof s !== "object" || Array.isArray(s)) return "achievements[" + i + "]: not an object";
    if (!slug(s.id)) return "achievements[" + i + "]: section id must be a lowercase slug";
    if (typeof s.title !== "string" || !s.title.trim() || s.title.length > 80) return "achievements[" + i + "]: missing or overlong title";
    if (s.icon != null && (typeof s.icon !== "string" || !/^[a-z0-9-]{1,40}$/.test(s.icon))) {
      return "achievements[" + i + "]: icon must be a Font Awesome name like fa-trophy";
    }
    if (!Array.isArray(s.items)) return "achievements[" + i + "]: items must be an array";
    if (s.items.length > 100) return "achievements[" + i + "]: too many items (100 max)";
    for (let j = 0; j < s.items.length; j++) {
      const it = s.items[j];
      const at = "achievements[" + i + "].items[" + j + "]";
      if (!it || typeof it !== "object" || Array.isArray(it)) return at + ": not an object";
      if (!slug(it.id)) return at + ": item id must be a lowercase slug";
      if (typeof it.title !== "string" || !it.title.trim() || it.title.length > 200) return at + ": missing or overlong title";
      if (!opt(it.badge, 120)) return at + ": badge overlong";
      if (it.date != null && (typeof it.date !== "string" || !/^\d{4}-\d{2}(-\d{2})?$/.test(it.date))) return at + ": date must be YYYY-MM or YYYY-MM-DD";
      if (!opt(it.description, 1000)) return at + ": description overlong";
      if (it.links != null) {
        if (!Array.isArray(it.links) || it.links.length > 6) return at + ": links must be an array (6 max)";
        for (let k = 0; k < it.links.length; k++) {
          const l = it.links[k];
          if (!l || typeof l !== "object") return at + ".links[" + k + "]: not an object";
          if (typeof l.label !== "string" || !l.label.trim() || l.label.length > 80) return at + ".links[" + k + "]: missing or overlong label";
          if (typeof l.url !== "string" || !/^https?:\/\//i.test(l.url) || l.url.length > 600) return at + ".links[" + k + "]: url must be absolute http(s)";
        }
      }
    }
  }
  return null;
}

async function readDataFile(env, url) {
  const file = url.searchParams.get("file") || "";
  const spec = DATA_FILES[file];
  if (!spec) return editorJson(400, { error: "Unknown data file (allowed: " + Object.keys(DATA_FILES).join(", ") + ")" });

  const noToken = requireToken(env);
  if (noToken) return noToken;

  const res = await ghFetch(env, "/" + spec.path + "?ref=" + GITHUB_BRANCH);
  if (res.status === 404) return editorJson(404, { error: spec.path + " does not exist on GitHub yet" });
  if (!res.ok) return editorJson(502, { error: await ghMessage(res) });

  const data = await res.json();
  return editorJson(200, { file, sha: data.sha, content: base64DecodeUtf8(data.content || "") });
}

async function saveDataFile(request, env) {
  // CSRF line, mirroring publishPost.
  const contentType = request.headers.get("Content-Type") || "";
  if (!contentType.includes("application/json")) {
    return editorJson(415, { error: "Content-Type must be application/json" });
  }
  const raw = await request.text();
  if (raw.length > MAX_CONTENT_BYTES) return editorJson(413, { error: "Request body too large" });

  let body;
  try {
    body = JSON.parse(raw);
  } catch (error) {
    return editorJson(400, { error: "Invalid JSON" });
  }

  const file = typeof body.file === "string" ? body.file : "";
  const spec = DATA_FILES[file];
  if (!spec) return editorJson(400, { error: "Unknown data file (allowed: " + Object.keys(DATA_FILES).join(", ") + ")" });
  if (typeof body.content !== "string" || !body.content.trim()) return editorJson(400, { error: "Missing content" });
  if (new TextEncoder().encode(body.content).length > MAX_CONTENT_BYTES) {
    return editorJson(413, { error: spec.path + " exceeds 256KB" });
  }

  let items;
  try {
    items = JSON.parse(body.content);
  } catch (error) {
    return editorJson(400, { error: "content is not valid JSON" });
  }
  const invalid = file === "achievements" ? validateAchv(items) : validateItems(file, items);
  if (invalid) return editorJson(400, { error: invalid });

  const noToken = requireToken(env);
  if (noToken) return noToken;

  const payload = {
    message: spec.label + ": update via admin",
    content: base64EncodeUtf8(body.content),
    branch: GITHUB_BRANCH
  };
  if (body.sha) payload.sha = String(body.sha);

  const res = await ghFetch(env, "/" + spec.path, {
    method: "PUT",
    body: JSON.stringify(payload)
  });
  if (res.status === 409 || res.status === 422) {
    return editorJson(409, { error: "Changed on GitHub since you loaded it — press ↻ to reload and re-apply" });
  }
  if (!res.ok) return editorJson(502, { error: await ghMessage(res) });

  const data = await res.json();
  return editorJson(200, { success: true, sha: data.content && data.content.sha });
}

export async function handleEditor(request, env, ctx, url) {
  try {
    if (!(await verifyAccess(request, env))) return accessDenied();

    if (url.pathname === "/admin/api/posts") {
      if (request.method !== "GET") return editorJson(405, { error: "Method not allowed" });
      return await listPosts(env);
    }

    if (url.pathname === "/admin/api/post") {
      if (request.method === "GET") return await readPost(env, url);
      if (request.method === "POST") return await publishPost(request, env);
      if (request.method === "DELETE") return await deletePost(env, url);
      return editorJson(405, { error: "Method not allowed" });
    }

    if (url.pathname === "/admin/api/data") {
      if (request.method === "GET") return await readDataFile(env, url);
      if (request.method === "POST") return await saveDataFile(request, env);
      return editorJson(405, { error: "Method not allowed" });
    }

    return editorJson(404, { error: "Not found" });
  } catch (error) {
    // Never echo err.message — fetch failures can embed response text/URLs.
    console.log("editor error:", error.status || "", error.message);
    return editorJson(500, { error: "Editor request failed" });
  }
}

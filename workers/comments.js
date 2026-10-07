// Cloudflare Worker backend: comments, private image uploader, AI proxy.
// Public:
//   GET  /comments  list comments (email deliberately excluded)
//   POST /comments  create a comment (per-IP rate limit + Turnstile)
//   POST /api/site-chat  site avatar chat (per-IP rate limit, internal key)
//   POST /api/analytics/hit  first-party pageview beacon (bot-filtered, limited)
//   POST /api/ai/v1/chat/completions  OpenAI-compatible proxy (bearer key)
//   GET  /api/ai/v1/models            model catalog (bearer key)
// Cloudflare Access-protected (see access.js):
//   GET    /admin               admin page: image explorer + markdown editor
//   POST   /upload              multipart images -> R2 (optional `dir` folder field)
//   GET    /upload?list=1       uploads; &prefix=img/x/&delimiter=1 = one level
//   DELETE /upload?key=…        remove one object (img/ prefix only)
//   POST   /upload/folder       create a folder ({path}); R2 needs a .keep marker
//   DELETE /upload/folder?key=img/…/  delete a folder and everything under it
//   POST   /upload/move         move/rename a file or folder ({from, to})
//   GET    /admin/api/posts     list posts/*.md from GitHub (editor.js)
//   GET    /admin/api/post?slug=…   read one post (editor.js)
//   POST   /admin/api/post      publish/create/update a post (GitHub Contents API)
//   DELETE /admin/api/post      delete a post (slug + sha query params)
//   GET    /admin/api/stats?days=…  analytics dashboard data (analytics.js)
//   GET    /admin/api/visitor?id=…  one visitor's sessions + timeline (analytics.js)
//   GET    /admin/api/music/tree      music library tab: R2 listing + published flags (music.js)
//   POST   /admin/api/music/upload    multipart audio -> R2 music/Artist/Album/ (music.js)
//   DELETE /admin/api/music?file=…    remove one audio object (music.js)
//   POST   /admin/api/music/plan      dry-run of the library sync (music.js)
//   POST   /admin/api/music/cover     iTunes cover lookup + commit for one song (music.js)
//   POST   /admin/api/music/commit    rebuild + commit data/music-library.json (music.js)
//   GET/DELETE /admin/api/comment[s]  moderation list + delete (moderation.js)
//   GET/POST/DELETE /admin/api/ban[s]  banned-sender blocklist (moderation.js)
//   GET/POST/DELETE /admin/api/draft[s]  写作台 drafts in D1 (drafts.js)

import { ADMIN_PAGE_HTML } from "./admin_page.js";
import { handleAi, consumeQuota, writeLog, extractUsage, upstreamUrl } from "./ai_proxy.js";
import { handleEditor } from "./editor.js";
import { handleHit, handleAnalyticsApi } from "./analytics.js";
import { handleModeration } from "./moderation.js";
import { handleDrafts, publishDueDrafts } from "./drafts.js";
import { handleMusic } from "./music.js";
import { verifyAccess, accessDenied } from "./access.js";

const JSON_HEADERS = { "Content-Type": "application/json" };

// Turnstile server-side verification for POST /comments.
const TURNSTILE_ACTION = "comment";
// Production frontends only — never include localhost here.
const TURNSTILE_HOSTNAMES = new Set([
  "nathanpenny.fun",
  "blog.nathanpenny.fun",
  "pan-nie.github.io"
]);

// Reject oversized payloads early so the database cannot be flooded.
const MAX_LENGTHS = { name: 50, email: 200, content: 2000 };

// POST /comments rate limit: per-IP counters in the comment_rate D1 table.
// (The Workers rate-limit binding is silently a no-op on this account, so
// the cap lives in D1 instead — one upsert per attempt, window-aligned.)
const RATE_WINDOW_SECONDS = 60;
const RATE_MAX_PER_WINDOW = 5;
// Old counter rows are swept opportunistically on every POST.
const RATE_WINDOW_KEEP = 10;  // keep the last N windows

function hasInvalidLength(fields) {
  return Object.entries(MAX_LENGTHS).some(
    ([field, max]) => fields[field] !== undefined && String(fields[field]).length > max
  );
}

// Returns true only when the token is present, single-use fresh, solved for
// the expected action, and produced on an approved frontend hostname.
// The secret lives in the Worker secret store: `wrangler secret put TURNSTILE_SECRET`.
async function verifyTurnstile(env, token) {
  if (!env.TURNSTILE_SECRET) return false;
  if (typeof token !== "string" || token.length === 0 || token.length > 2048) return false;

  try {
    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        secret: env.TURNSTILE_SECRET,
        response: token
      })
    });
    if (!response.ok) return false;

    const result = await response.json();
    return result.success === true
      && result.action === TURNSTILE_ACTION
      && TURNSTILE_HOSTNAMES.has(result.hostname);
  } catch (error) {
    return false;
  }
}

// Count this attempt against the caller's current window. Returns false when
// the window's budget is exhausted. Fail open on D1 trouble: a broken limiter
// must not take the feature down. Shared by POST /comments (comment_rate)
// and POST /api/site-chat (chat_rate); `table` is always a literal here.
async function bumpRateWindow(env, table, ip, nowMs, maxPerWindow, windowSeconds) {
  try {
    const nowSeconds = Math.floor(nowMs / 1000);
    const windowStart = nowSeconds - (nowSeconds % windowSeconds);

    const row = await env.DB.prepare(
      `INSERT INTO ${table} (ip, window_start, count) VALUES (?, ?, 1)
       ON CONFLICT (ip, window_start) DO UPDATE SET count = count + 1
       RETURNING count`
    ).bind(ip, windowStart).first();

    // Opportunistic sweep of long-expired windows (PK-indexed, cheap).
    if (row && row.count === 1) {
      await env.DB.prepare(
        `DELETE FROM ${table} WHERE window_start < ?`
      ).bind(windowStart - RATE_WINDOW_KEEP * windowSeconds).run();
    }

    return (row ? row.count : 1) <= maxPerWindow;
  } catch (error) {
    return true;
  }
}

function checkRateLimit(env, ip, nowMs) {
  return bumpRateWindow(env, "comment_rate", ip, nowMs, RATE_MAX_PER_WINDOW, RATE_WINDOW_SECONDS);
}

// Salted one-way hash of the commenter's IP (same ANALYTICS_SALT secret as
// the analytics visitor hash). Stored on every comment and checked against
// banned_ips before anything else — the raw address is never written
// anywhere, keeping the privacy policy's "no IP in our database" promise
// intact while still letting the owner blocklist an abusive sender.
async function sha256Hex(text) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function ipHashOf(env, ip) {
  return sha256Hex((env.ANALYTICS_SALT || "") + "\n" + ip).then((h) => h.slice(0, 16));
}

async function isBannedSender(env, ipHash) {
  try {
    const row = await env.DB.prepare("SELECT 1 FROM banned_ips WHERE ip_hash = ?1").bind(ipHash).first();
    return !!row;
  } catch (error) {
    return false; // fail open, like the rate limiter
  }
}

// ---------------------------------------------------------------------------
// Site avatar chat (POST /api/site-chat) — a small public endpoint so the
// website itself can offer an AI chat without exposing any key. It spends the
// same Workers AI free allocation through an internal api_keys row named
// 'site-avatar' (monthly cap + on/off switch: disable that key), is bounded
// per-IP by the chat_rate limiter, and logs every call like the proxy does.
// ---------------------------------------------------------------------------

const SITE_CHAT_MODEL = "@cf/meta/llama-3.1-8b-instruct-fp8-fast";
const SITE_CHAT_MAX_TOKENS = 300;
const SITE_CHAT_MAX_MESSAGE_CHARS = 500;
const SITE_CHAT_MAX_HISTORY = 8;
const CHAT_RATE_WINDOW_SECONDS = 60;
const CHAT_RATE_MAX_PER_WINDOW = 3;

const SITE_CHAT_SYSTEM_PROMPT = [
  "You are the friendly AI avatar of Nathan, owner of the personal site nathanpenny.fun.",
  "Nathan is a developer who enjoys tech, anime, music and geek culture; the site has his blog (categories: tech/anime/life/fun/fiction/travel/sports/ai/misc), his music in the Creations page, a gallery, and a contact page with a guestbook.",
  "Rules: reply in the visitor's language (default to Chinese); keep it short and warm (under ~100 characters unless asked for more); a little emoji is fine.",
  "You speak only for Nathan's public site persona — never invent private details (address, contacts, employer); deflect those politely.",
  "Small talk is fine; be kind; if you are unsure about something, say so honestly."
].join(" ");

// The internal api_keys row for site chat, cached briefly per isolate so the
// endpoint does not add a D1 read per message.
let siteChatKeyCache = { row: null, at: 0 };
async function getSiteChatKey(env) {
  if (Date.now() - siteChatKeyCache.at < 60_000) return siteChatKeyCache.row;
  try {
    const row = await env.DB.prepare(
      "SELECT id, monthly_limit, enabled FROM api_keys WHERE name = 'site-avatar' LIMIT 1"
    ).first();
    siteChatKeyCache = { row, at: Date.now() };
    return row;
  } catch (error) {
    return null;
  }
}

async function handleSiteChat(request, env, ctx, corsHeaders) {
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: corsHeaders });
  }
  if (!env.CF_AI_TOKEN || !env.CF_ACCOUNT_ID) {
    return new Response(JSON.stringify({ error: "AI is not configured on this Worker." }), { status: 503, headers: corsHeaders });
  }

  // Cheap per-IP guard first, like POST /comments.
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  if (!(await bumpRateWindow(env, "chat_rate", ip, Date.now(), CHAT_RATE_MAX_PER_WINDOW, CHAT_RATE_WINDOW_SECONDS))) {
    return new Response(
      JSON.stringify({ error: "Chatting a bit too fast — please wait a minute." }),
      { status: 429, headers: corsHeaders }
    );
  }

  let body;
  try {
    body = await request.json();
  } catch (error) {
    return new Response(JSON.stringify({ error: "Request body must be valid JSON." }), { status: 400, headers: corsHeaders });
  }
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message || message.length > SITE_CHAT_MAX_MESSAGE_CHARS) {
    return new Response(
      JSON.stringify({ error: `Message must be 1-${SITE_CHAT_MAX_MESSAGE_CHARS} characters.` }),
      { status: 400, headers: corsHeaders }
    );
  }
  const messages = [{ role: "system", content: SITE_CHAT_SYSTEM_PROMPT }];
  const history = Array.isArray(body.history) ? body.history.slice(-SITE_CHAT_MAX_HISTORY) : [];
  for (const turn of history) {
    if (!turn || typeof turn.content !== "string" || !turn.content.trim()) continue;
    messages.push({
      role: turn.role === "assistant" ? "assistant" : "user",
      content: turn.content.trim().slice(0, SITE_CHAT_MAX_MESSAGE_CHARS)
    });
  }
  messages.push({ role: "user", content: message });

  const key = await getSiteChatKey(env);
  if (!key || !key.enabled) {
    return new Response(JSON.stringify({ error: "Site chat is disabled." }), { status: 503, headers: corsHeaders });
  }
  const month = new Date().toISOString().slice(0, 7);
  if (!(await consumeQuota(env, key.id, key.monthly_limit, month))) {
    return new Response(
      JSON.stringify({ error: "This month's site AI quota is used up — see you next month!" }),
      { status: 429, headers: corsHeaders }
    );
  }

  const startedAt = Date.now();
  let upstream;
  try {
    upstream = await fetch(upstreamUrl(env), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.CF_AI_TOKEN}` },
      body: JSON.stringify({
        model: SITE_CHAT_MODEL,
        messages,
        max_tokens: SITE_CHAT_MAX_TOKENS,
        temperature: 0.6
      }),
      signal: AbortSignal.timeout(60_000)
    });
  } catch (error) {
    ctx.waitUntil(writeLog(env, {
      keyId: key.id, model: SITE_CHAT_MODEL, provider: "workers-ai", status: 502,
      stream: false, tokensIn: null, tokensOut: null, latencyMs: Date.now() - startedAt
    }));
    return new Response(JSON.stringify({ error: "AI upstream unreachable." }), { status: 502, headers: corsHeaders });
  }

  const responseText = await upstream.text();
  let reply = null;
  try {
    reply = JSON.parse(responseText).choices[0].message.content;
  } catch (error) { /* non-JSON or empty answer — handled below */ }
  const usage = extractUsage(responseText);
  ctx.waitUntil(writeLog(env, {
    keyId: key.id, model: SITE_CHAT_MODEL, provider: "workers-ai", status: upstream.status,
    stream: false, tokensIn: usage ? usage.in : null, tokensOut: usage ? usage.out : null,
    latencyMs: Date.now() - startedAt
  }));
  if (!upstream.ok || !reply) {
    return new Response(JSON.stringify({ error: "The AI did not answer — please try again." }), { status: 502, headers: corsHeaders });
  }
  return new Response(JSON.stringify({ reply }), { headers: corsHeaders });
}

// ---------------------------------------------------------------------------
// New-comment owner notification (Email Service). The NOTIFY send_email
// binding pins the single allowed recipient (destination_address in
// wrangler.jsonc) — sends to a verified destination address are free on
// every plan. Privacy: name + 300-char excerpt only, never the commenter's
// email, IP or the full text.
// ---------------------------------------------------------------------------

// Thread GET /comments rows into top-level comments (newest first) with
// their replies attached oldest-first. Replies whose parent is missing
// (deleted) or which point at another reply are dropped defensively.
function threadComments(rows) {
  const tops = [];
  const byId = new Map();
  for (const row of rows) {
    if (!row.parent_id) {
      row.replies = [];
      byId.set(row.id, row);
      tops.push(row);
    }
  }
  for (const row of [...rows].reverse()) {
    if (row.parent_id && byId.has(row.parent_id)) byId.get(row.parent_id).replies.push(row);
  }
  return tops;
}

// Escape user-provided text before embedding it in the HTML email body
// (name + excerpt come straight from the comment form).
function escapeEmailHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]
  ));
}

// Branded HTML body for the notification. Inline styles only (email clients
// strip <style> blocks), table layout for wide client support, no external
// images (they hurt spam scoring), site palette: teal #1abc9c / slate #2c3e50.
function notifyEmailHtml(nameHtml, excerptHtml, isReply) {
  return [
    '<div style="margin:0;padding:24px 12px;background:#f5f7fa;font-family:-apple-system,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif;">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">',
    '<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border:1px solid #e0e0e0;border-radius:12px;overflow:hidden;">',
    '<tr><td style="height:4px;background:#1abc9c;font-size:0;line-height:0;">&nbsp;</td></tr>',
    '<tr><td style="padding:24px 28px 8px 28px;">',
    '<p style="margin:0 0 4px 0;font-size:12px;letter-spacing:1px;text-transform:uppercase;color:#7f8c8d;">nathanpenny.fun</p>',
    '<h1 style="margin:0;font-size:20px;color:#2c3e50;">&#128172; New ' + (isReply ? "reply" : "comment") + '</h1>',
    '</td></tr>',
    '<tr><td style="padding:8px 28px 0 28px;">',
    '<p style="margin:0 0 12px 0;font-size:15px;color:#333333;"><strong style="color:#16a085;">' + nameHtml + '</strong> left a comment:</p>',
    '<blockquote style="margin:0;padding:12px 16px;background:#f8f9fa;border-left:3px solid #1abc9c;border-radius:0 8px 8px 0;font-size:14px;line-height:1.6;color:#34495e;">' + excerptHtml + '</blockquote>',
    '</td></tr>',
    '<tr><td style="padding:20px 28px 24px 28px;">',
    '<table role="presentation" cellpadding="0" cellspacing="0"><tr>',
    '<td style="background:#1abc9c;border-radius:8px;"><a href="https://workers.nathanpenny.fun/admin" style="display:inline-block;padding:10px 20px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;">Open the admin</a></td>',
    '</tr></table>',
    '</td></tr>',
    '<tr><td style="padding:12px 28px 20px 28px;border-top:1px solid #ecf0f1;">',
    '<p style="margin:0;font-size:12px;color:#95a5a6;">Comment notification from your Worker &middot; sent ' + new Date().toUTCString() + ' &middot; replies to this address are not monitored.</p>',
    '</td></tr>',
    '</table></td></tr></table></div>'
  ].join("");
}

function sendNotifyEmail(env, name, content, isReply) {
  if (!env.NOTIFY) return null; // binding not deployed — feature is off
  const safeContent = String(content).slice(0, 300);
  // The HTML part carries escaped copies of the user input; slice BEFORE
  // escaping so a cut can never split an HTML entity.
  const excerptHtml = escapeEmailHtml(safeContent).replace(/\n/g, "<br>");
  const nameHtml = escapeEmailHtml(String(name).slice(0, 50));
  return env.NOTIFY.send({
    // The runtime still wants the recipient spelled out in `to` — it does
    // not fall back to the binding's destination_address by itself.
    from: { email: "noreply@nathanpenny.fun", name: "nathanpenny.fun" },
    to: "notify@nathanpenny.fun",
    subject: `💬 New ${isReply ? "reply" : "comment"} from ${String(name).slice(0, 50)}`,
    text: `New ${isReply ? "reply" : "comment"} on nathanpenny.fun\n\nFrom: ${name}\n\n${safeContent}`,
    html: notifyEmailHtml(nameHtml, excerptHtml, isReply)
  }).catch((error) => {
    // A failed notification must never affect the comment response.
    console.error("notify email failed:", error && (error.code || error.message));
  });
}

// ---------------------------------------------------------------------------
// Image uploader (Cloudflare Access-protected)
// ---------------------------------------------------------------------------

// Allowed upload types: extension -> MIME. Keys land under img/YYYY/MM/ as an
// ASCII slug + 6 hex chars, which also makes the WAF `...` path trap (see
// r2Key in music.js) structurally impossible: slugify removes dots.
const IMAGE_TYPES = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
  svg: "image/svg+xml"
};
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const STORAGE_PUBLIC_ORIGIN = "https://storage.nathanpenny.fun/";

// --- Upload handling ---------------------------------------------------------

function slugifyFilename(name) {
  const base = String(name).replace(/\.[^.]+$/, "");
  const slug = base
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "image";
}

function imageKeyFor(filename, ext, dir) {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const rand = [...crypto.getRandomValues(new Uint8Array(3))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const base = `${slugifyFilename(filename)}-${rand}.${ext}`;
  // Uploading from the admin explorer into a chosen folder lands there; the
  // root keeps the historical img/YYYY/MM/ convention.
  if (dir && dir !== "img/") return dir + base;
  return `img/${yyyy}/${mm}/${base}`;
}

// "Folders" in R2 are key prefixes. Folder segments are strict ASCII slugs —
// dots are banned outright (the WAF `...` path trap, see r2Key in music.js)
// and slugs keep the public URLs clean and short.
const FOLDER_SEGMENT_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

// Normalize/validate a folder path ("img/foo" or "img/foo/" -> "img/foo/").
// Returns null when any segment breaks the slug rules or traversal is tried.
function normalizeFolderPath(raw) {
  let path = String(raw == null ? "" : raw);
  if (!path.endsWith("/")) path += "/";
  if (!path.startsWith("img/") || path.includes("..") || path.includes("\\")) return null;
  const inner = path.slice(4, -1);
  if (inner === "") return "img/"; // the bucket root for images
  const segments = inner.split("/");
  if (!segments.every((s) => FOLDER_SEGMENT_RE.test(s))) return null;
  return path;
}

// Validate a full object key ("img/foo/pic-abc123.webp"). The last segment is
// the filename; leading dots are reserved (.keep folder markers).
function validObjectKey(key) {
  key = String(key == null ? "" : key);
  if (!key.startsWith("img/") || key.endsWith("/") || key.includes("..") || key.includes("\\")) return false;
  const parts = key.slice(4).split("/");
  if (parts.some((p) => p === "")) return false;
  const name = parts.pop();
  return parts.every((d) => FOLDER_SEGMENT_RE.test(d)) && /^[a-z0-9][a-z0-9._-]{0,127}$/i.test(name) && !name.startsWith(".");
}

function uploadJson(status, payload) {
  return new Response(JSON.stringify(payload), { status, headers: JSON_HEADERS });
}

// Light magic-byte sniffing so a renamed payload cannot pose as an image
// (best effort: svg is checked as text, the rest by signature).
function magicBytesMatch(bytes, ext) {
  const b = new Uint8Array(bytes);
  if (ext === "svg") {
    const head = new TextDecoder().decode(b.subarray(0, 256)).trim().toLowerCase();
    return head.startsWith("<?xml") || head.startsWith("<svg");
  }
  if (ext === "png") return b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
  if (ext === "jpg" || ext === "jpeg") return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  if (ext === "gif") return b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46; // "GIF"
  if (ext === "webp") {
    return b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 // "RIFF"
      && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50; // "WEBP"
  }
  if (ext === "avif") return b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70; // "ftyp"
  return false;
}

async function handleUploadPost(request, env) {
  let form;
  try {
    form = await request.formData();
  } catch (error) {
    return new Response(JSON.stringify({ error: "Expected multipart/form-data" }), { status: 400, headers: JSON_HEADERS });
  }

  const files = [...form.getAll("files")].filter((f) => typeof f !== "string");
  if (!files.length) {
    return new Response(JSON.stringify({ error: "No files under the 'files' field" }), { status: 400, headers: JSON_HEADERS });
  }
  if (files.length > 10) {
    return new Response(JSON.stringify({ error: "Too many files (10 per request maximum)" }), { status: 400, headers: JSON_HEADERS });
  }

  // Optional target folder from the admin explorer; invalid values fail hard.
  let dir = null;
  const dirRaw = form.get("dir");
  if (typeof dirRaw === "string" && dirRaw) {
    dir = normalizeFolderPath(dirRaw);
    if (!dir) {
      return new Response(JSON.stringify({ error: "Invalid upload folder" }), { status: 400, headers: JSON_HEADERS });
    }
  }

  const uploaded = [];
  const failed = [];
  for (const file of files) {
    try {
      if (file.size > MAX_IMAGE_BYTES) throw new Error(`${file.name}: larger than 25MB`);
      const ext = (file.name.split(".").pop() || "").toLowerCase();
      const contentType = IMAGE_TYPES[ext];
      if (!contentType) throw new Error(`${file.name}: unsupported type`);
      const head = await file.slice(0, 256).arrayBuffer();
      if (!magicBytesMatch(head, ext)) throw new Error(`${file.name}: content does not look like ${ext}`);

      const key = imageKeyFor(file.name, ext, dir);
      await env.R2.put(key, file, {
        httpMetadata: {
          contentType,
          // Date + random names are never overwritten, so cache forever.
          cacheControl: "public, max-age=31536000, immutable"
        }
      });
      const url = STORAGE_PUBLIC_ORIGIN + key;
      uploaded.push({
        key,
        url,
        markdown: `![${file.name.replace(/\.[^.]+$/, "")}](${url})`,
        size: file.size,
        contentType
      });
    } catch (error) {
      failed.push(String(error.message || error));
    }
  }

  return new Response(
    JSON.stringify({ uploaded, failed }),
    { status: uploaded.length ? 200 : 400, headers: JSON_HEADERS }
  );
}

// Listing for the admin file explorer. With delimiter=1 this returns one
// level: folders (R2 delimitedPrefixes) + objects directly under `prefix`.
// Without it the historical flat "recent uploads" listing is served.
async function handleUploadList(env, url) {
  const prefix = normalizeFolderPath(url.searchParams.get("prefix") || "img/");
  if (!prefix) return uploadJson(400, { error: "Invalid prefix" });

  const options = { prefix, limit: 100 };
  const cursor = url.searchParams.get("cursor");
  if (cursor) options.cursor = cursor;
  if (url.searchParams.get("delimiter") === "1") options.delimiter = "/";
  const listing = await env.R2.list(options);

  // R2 lists lexicographically ascending; date-prefixed keys make the reverse
  // of that newest-first. Folder markers (.keep) are never shown.
  const objects = (listing.objects || [])
    .filter((o) => !o.key.endsWith("/.keep"))
    .map((o) => ({
      key: o.key,
      url: STORAGE_PUBLIC_ORIGIN + o.key,
      size: o.size,
      uploaded: o.uploaded ? o.uploaded.toISOString() : null
    }))
    .reverse();
  const folders = listing.delimitedPrefixes || [];
  return uploadJson(200, {
    prefix,
    folders,
    objects,
    truncated: !!listing.truncated,
    cursor: listing.truncated ? listing.cursor : null
  });
}

async function handleUploadDelete(env, url) {
  const key = url.searchParams.get("key") || "";
  if (url.searchParams.get("type") === "folder") {
    return handleFolderDelete(env, key);
  }
  if (!validObjectKey(key)) {
    return uploadJson(400, { error: "Only img/ objects can be deleted" });
  }
  await env.R2.delete(key);
  return uploadJson(200, { success: true });
}

// Create a folder: R2 has no empty directories, so drop a zero-byte .keep
// marker that the listing filters out.
async function handleFolderCreate(request, env) {
  let body = null;
  try {
    body = await request.json();
  } catch (error) { /* fall through to validation */ }
  const path = normalizeFolderPath(body && body.path);
  if (!path || path === "img/") {
    return uploadJson(400, { error: "Invalid folder path (segments: lowercase letters, digits, - or _)" });
  }
  await env.R2.put(path + ".keep", "", {
    httpMetadata: { contentType: "application/x-empty" }
  });
  return uploadJson(200, { success: true, path });
}

// Delete a folder: cursor through every key under the prefix and batch-delete
// (R2.delete takes up to 1000 keys per call).
async function handleFolderDelete(env, rawPath) {
  const path = normalizeFolderPath(rawPath);
  if (!path || path === "img/") {
    return uploadJson(400, { error: "Invalid folder path" });
  }
  let cursor;
  let deleted = 0;
  for (;;) {
    const options = { prefix: path, limit: 1000 };
    if (cursor) options.cursor = cursor;
    const listing = await env.R2.list(options);
    const keys = (listing.objects || []).map((o) => o.key);
    if (keys.length) {
      await env.R2.delete(keys);
      deleted += keys.length;
    }
    if (!listing.truncated) break;
    cursor = listing.cursor;
    if (deleted > 50000) return uploadJson(500, { error: "Folder too large to delete in one call" });
  }
  return uploadJson(200, { success: true, deleted });
}

// R2 has no server-side copy/move in the Workers binding, so a move is
// get + put + delete per object (uploads are capped at 25MB, fine here).
async function moveOneObject(env, fromKey, toKey) {
  const obj = await env.R2.get(fromKey);
  if (!obj) throw new Error("missing object " + fromKey);
  const bytes = await obj.arrayBuffer();
  await env.R2.put(toKey, bytes, { httpMetadata: obj.httpMetadata });
  await env.R2.delete(fromKey);
}

// Move/rename: {from, to}. A folder move (from ends with "/") re-keys every
// object under it; a single-object move takes a target folder (filename kept)
// or a full new key.
async function handleUploadMove(request, env) {
  let body = null;
  try {
    body = await request.json();
  } catch (error) { /* fall through to validation */ }
  const fromRaw = body && body.from;
  const toRaw = body && body.to;
  if (!fromRaw || !toRaw) return uploadJson(400, { error: "Missing from/to" });

  if (String(fromRaw).endsWith("/")) {
    const from = normalizeFolderPath(fromRaw);
    const to = normalizeFolderPath(toRaw);
    if (!from || from === "img/") return uploadJson(400, { error: "Invalid source folder" });
    if (!to || to === "img/") return uploadJson(400, { error: "Invalid destination folder" });
    if (to.startsWith(from)) return uploadJson(400, { error: "Cannot move a folder into itself" });

    let cursor;
    let moved = 0;
    for (;;) {
      const options = { prefix: from, limit: 1000 };
      if (cursor) options.cursor = cursor;
      const listing = await env.R2.list(options);
      for (const o of listing.objects || []) {
        await moveOneObject(env, o.key, to + o.key.slice(from.length));
        moved += 1;
      }
      if (!listing.truncated) break;
      cursor = listing.cursor;
      if (moved > 50000) return uploadJson(500, { error: "Folder too large to move in one call" });
    }
    return uploadJson(200, { success: true, moved, path: to });
  }

  const from = validObjectKey(fromRaw) ? String(fromRaw) : null;
  if (!from) return uploadJson(400, { error: "Invalid source key" });
  let to = null;
  if (String(toRaw).endsWith("/")) {
    const folder = normalizeFolderPath(toRaw);
    if (folder && folder !== "img/") to = folder + from.split("/").pop();
  } else if (validObjectKey(toRaw)) {
    to = String(toRaw);
  }
  if (!to) return uploadJson(400, { error: "Invalid destination (folder path or full key)" });
  if (to === from) return uploadJson(400, { error: "Source and destination are the same" });

  await moveOneObject(env, from, to);
  return uploadJson(200, { success: true, moved: 1, key: to, url: STORAGE_PUBLIC_ORIGIN + to });
}

// ---------------------------------------------------------------------------
// Cron: nightly pruning so the append-only tables cannot grow without bound
// (D1 free-tier daily limits are enforced since 2026-09). One daily run
// covers every table; the loop is capped so a large backlog shrinks over
// days instead of exhausting the invocation's CPU budget.
// ---------------------------------------------------------------------------

const PRUNE_BATCH = 400;
const PRUNE_MAX_ROUNDS = 25;

// D1 has no DELETE ... LIMIT — delete via an id subquery in batches until
// one comes back short (or the round cap is hit).
async function pruneInBatches(env, sql) {
  for (let round = 0; round < PRUNE_MAX_ROUNDS; round++) {
    const res = await env.DB.prepare(sql).run();
    if (!res.meta || res.meta.changes < PRUNE_BATCH) return;
  }
}

// Long-expired comment_rate windows are also swept opportunistically on every
// POST (see checkRateLimit); this is the backstop covering every rate-limiter
// and analytics table (see analytics.js for what expires and when).
async function pruneTables(env) {
  // Uses idx_ai_logs_created for the subquery; the outer delete hits the PK.
  await pruneInBatches(
    env,
    "DELETE FROM ai_logs WHERE id IN (SELECT id FROM ai_logs WHERE created_at < datetime('now', '-90 days') LIMIT 400)"
  );
  await env.DB.prepare(
    "DELETE FROM ai_usage WHERE month < strftime('%Y-%m', datetime('now', '-13 months'))"
  ).run();
  await env.DB.prepare(
    "DELETE FROM comment_rate WHERE window_start < ?"
  ).bind(Math.floor(Date.now() / 1000) - 86400).run();
  await env.DB.prepare(
    "DELETE FROM chat_rate WHERE window_start < ?"
  ).bind(Math.floor(Date.now() / 1000) - 86400).run();

  // First-party analytics: raw rows + session/visitor profiles expire after
  // 13 months (privacy policy), the rate limiter after a day. The hits table
  // is the only one big enough to need batched deletes.
  const analyticsCutoff = Math.floor(Date.now() / 1000) - 396 * 86400; // ~13 months
  await pruneInBatches(
    env,
    "DELETE FROM analytics_hits WHERE id IN (SELECT id FROM analytics_hits WHERE ts < "
    + analyticsCutoff + " LIMIT " + PRUNE_BATCH + ")"
  );
  await env.DB.prepare("DELETE FROM analytics_visits WHERE last_ts < ?").bind(analyticsCutoff).run();
  await env.DB.prepare("DELETE FROM analytics_visitors WHERE last_seen < ?").bind(analyticsCutoff).run();
  await env.DB.prepare(
    "DELETE FROM analytics_rate WHERE window_start < ?"
  ).bind(Math.floor(Date.now() / 1000) - 86400).run();
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // The AI proxy owns its (open) CORS — including preflights — so it is
    // dispatched before the generic OPTIONS short-circuit below.
    if (url.pathname.startsWith("/api/ai/")) {
      return handleAi(request, env, ctx, url);
    }

    const allowedOrigins = [
      "https://nathanpenny.fun",
      "https://blog.nathanpenny.fun",
      "https://pan-nie.github.io",
      "http://localhost:8080"
    ];

    // Only echo an origin back when it is allowlisted; omit the CORS header
    // otherwise so responses stay unreadable to foreign sites. curl and other
    // non-browser clients do not care about the header at all.
    const origin = request.headers.get("Origin");
    const corsHeaders = {
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS, DELETE",
      "Access-Control-Allow-Headers": "Content-Type",
      "Content-Type": "application/json"
    };
    if (origin && allowedOrigins.includes(origin)) {
      corsHeaders["Access-Control-Allow-Origin"] = origin;
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // --- Public site avatar chat (no key; per-IP limited; internal key). ---
      if (url.pathname === "/api/site-chat") {
        return handleSiteChat(request, env, ctx, corsHeaders);
      }

      // --- First-party analytics beacon (bots dropped inside; always 204). ---
      if (url.pathname === "/api/analytics/hit") {
        return handleHit(request, env, ctx, { bumpRateWindow });
      }

      // --- Analytics dashboard (Access-verified inside analytics.js). ---
      if (url.pathname === "/admin/api/stats" || url.pathname === "/admin/api/visitor") {
        return handleAnalyticsApi(request, env, url);
      }

      // --- Markdown editor + content data API (editor.js). Lives under
      // /admin/ so the edge Access app covers the subpath and injects the
      // JWT like on the page. ---
      if (
        url.pathname === "/admin/api/posts" || url.pathname === "/admin/api/post" ||
        url.pathname === "/admin/api/data"
      ) {
        return handleEditor(request, env, ctx, url);
      }

      // --- Music library tab (music.js): R2 uploads + JSON sync. Same
      // /admin/ subpath logic so Access covers it. ---
      if (
        url.pathname === "/admin/api/music" || url.pathname.startsWith("/admin/api/music/")
      ) {
        return handleMusic(request, env, url);
      }

      // --- Comment moderation + 写作台 drafts (Access-verified inside). ---
      if (
        url.pathname === "/admin/api/comments" || url.pathname === "/admin/api/comment" ||
        url.pathname === "/admin/api/ban" || url.pathname === "/admin/api/bans"
      ) {
        return handleModeration(request, env, url);
      }
      if (url.pathname === "/admin/api/draft" || url.pathname === "/admin/api/drafts") {
        return handleDrafts(request, env, url);
      }

      // --- Cloudflare Access-protected admin surface (image uploader + editor page) ---
      if (url.pathname === "/admin" && request.method === "GET") {
        if (!(await verifyAccess(request, env))) return accessDenied();
        return new Response(ADMIN_PAGE_HTML, {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
            "X-Robots-Tag": "noindex"
          }
        });
      }

      if (url.pathname === "/upload") {
        if (!(await verifyAccess(request, env))) return accessDenied();
        if (request.method === "POST") return handleUploadPost(request, env);
        if (request.method === "GET") return handleUploadList(env, url);
        if (request.method === "DELETE") return handleUploadDelete(env, url);
        return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: JSON_HEADERS });
      }

      if (url.pathname === "/upload/folder") {
        if (!(await verifyAccess(request, env))) return accessDenied();
        if (request.method === "POST") return handleFolderCreate(request, env);
        if (request.method === "DELETE") return handleFolderDelete(env, url.searchParams.get("key"));
        return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: JSON_HEADERS });
      }

      if (url.pathname === "/upload/move") {
        if (!(await verifyAccess(request, env))) return accessDenied();
        if (request.method === "POST") return handleUploadMove(request, env);
        return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: JSON_HEADERS });
      }

      if (url.pathname === "/comments") {
        if (request.method === "GET") {
          const { results } = await env.DB.prepare(
            "SELECT id, parent_id, name, content, created_at FROM comments ORDER BY created_at DESC LIMIT 100"
          ).all();
          return new Response(JSON.stringify(threadComments(results || [])), { headers: corsHeaders });
        }

        if (request.method === "POST") {
          const ip = request.headers.get("CF-Connecting-IP") || "unknown";
          const ipHash = await ipHashOf(env, ip);

          // Banned senders are rejected before any parsing, Turnstile work
          // or rate-limit write — one indexed D1 read, fail-open.
          if (await isBannedSender(env, ipHash)) {
            return new Response(
              JSON.stringify({ error: "Your comment cannot be posted." }),
              { status: 403, headers: corsHeaders }
            );
          }

          // Cheap guard next: cap attempts per client IP before doing any
          // parsing, so junk traffic never reaches siteverify or D1 writes.
          if (!(await checkRateLimit(env, ip, Date.now()))) {
            return new Response(
              JSON.stringify({ error: "Too many comments posted. Please wait a minute and try again." }),
              { status: 429, headers: corsHeaders }
            );
          }

          const body = await request.json();
          const { name, email, content } = body;

          if (!name || !email || !content) {
            return new Response(
              JSON.stringify({ error: "All fields are required" }),
              { status: 400, headers: corsHeaders }
            );
          }

          if (hasInvalidLength({ name, email, content })) {
            return new Response(
              JSON.stringify({ error: "One or more fields are too long" }),
              { status: 400, headers: corsHeaders }
            );
          }

          // Replies: an optional parent id, which must reference an existing
          // top-level comment — one level of threading, no reply-to-reply.
          let parent = null;
          if (body.parent !== undefined && body.parent !== null && body.parent !== "") {
            parent = Number(body.parent);
            if (!Number.isInteger(parent) || parent <= 0) {
              return new Response(
                JSON.stringify({ error: "Invalid parent comment" }),
                { status: 400, headers: corsHeaders }
              );
            }
            const checked = await env.DB.prepare(
              "SELECT id FROM comments WHERE id = ?1 AND parent_id IS NULL"
            ).bind(parent).first();
            if (!checked) {
              return new Response(
                JSON.stringify({ error: "The comment you replied to no longer exists" }),
                { status: 400, headers: corsHeaders }
              );
            }
          }

          if (!(await verifyTurnstile(env, body["cf-turnstile-response"]))) {
            const status = env.TURNSTILE_SECRET ? 403 : 500;
            const message = env.TURNSTILE_SECRET
              ? "Captcha verification failed. Please try again."
              : "Server captcha configuration missing";
            return new Response(
              JSON.stringify({ error: message }),
              { status: status, headers: corsHeaders }
            );
          }

          await env.DB.prepare(
            "INSERT INTO comments (name, email, content, ip_hash, parent_id) VALUES (?, ?, ?, ?, ?)"
          ).bind(name, email, content, ipHash, parent).run();

          // Fire-and-forget: never delays or fails the comment response, and
          // rejected comments (rate limit / Turnstile) never reach this line.
          ctx.waitUntil(sendNotifyEmail(env, name, content, parent !== null));

          return new Response(
            JSON.stringify({ success: true, message: "Comment posted!" }),
            { headers: corsHeaders }
          );
        }

        return new Response(
          JSON.stringify({ error: "Method not allowed" }),
          { status: 405, headers: corsHeaders }
        );
      }

      return new Response(
        JSON.stringify({ error: "Not found" }),
        { status: 404, headers: corsHeaders }
      );
    } catch (err) {
      // Internal details stay server-side (observability captures the log);
      // mirroring editor.js, which never echoes err.message either.
      console.error("Unhandled worker error:", err);
      return new Response(
        JSON.stringify({ error: "Internal server error" }),
        { status: 500, headers: corsHeaders }
      );
    }
  },

  async scheduled(controller, env, ctx) {
    // Two triggers: the 15-minute one publishes due scheduled drafts (see
    // drafts.js), the nightly one prunes the append-only tables.
    if (controller.cron === "*/15 * * * *") {
      try {
        const published = await publishDueDrafts(env);
        if (published) console.log("scheduled publish: " + published + " draft(s)");
      } catch (error) {
        console.error("scheduled publish failed:", error);
      }
      return;
    }
    try {
      await pruneTables(env);
      console.log("cron prune done");
    } catch (error) {
      // Never throw out of scheduled — a failed prune must not turn into a
      // daily cron error alert.
      console.error("cron prune failed:", error);
    }
  }
};

// First-party analytics for the static site, collected into the same D1
// database as the comments. The public collector is POST /api/analytics/hit —
// a tiny sendBeacon in scripts/main.js fires one pageview per page load and
// one duration update when the page is hidden. Everything here is
// privacy-first by construction:
//   - the raw IP is never stored; visitor_id is a salted SHA-256 of IP + UA,
//     stable within a browser/IP so the stats can follow *a* visitor without
//     identifying a person;
//   - no cookies and no tracking storage server-side (the session id lives in
//     the visitor's own sessionStorage);
//   - bots (UA patterns + client-reported navigator.webdriver) are dropped at
//     ingest, so the tables only ever hold real pageviews;
//   - every failure mode answers 204 — the endpoint must never leak or stall
//     a page over analytics.
// The admin reads it through GET /admin/api/stats and /admin/api/visitor
// (Cloudflare Access-protected, like the other /admin/api routes).

import { accessDenied, verifyAccess } from "./access.js";

const JSON_HEADERS = { "Content-Type": "application/json" };

// Ingest limiter: 60 beacons/min per IP (a person clicking through the site
// stays far below; floods bounce off the D1 window counter). Counted by the
// shared bumpRateWindow in comments.js via the helpers bag.
const HIT_RATE_WINDOW_SECONDS = 60;
const HIT_RATE_MAX_PER_WINDOW = 60;

// UA fragments that never belong to a human reading the site. Matched
// case-insensitively against the User-Agent header.
const BOT_UA_RE = new RegExp(
  [
    "bot", "crawl", "spider", "slurp", "curl", "wget", "python", "java/", "okhttp",
    "libwww", "httpclient", "go-http", "headless", "phantomjs", "slimerjs",
    "preview", "monitor", "uptime", "pingdom", "gtmetrix", "lighthouse",
    "pagespeed", "semrush", "ahrefs", "majestic", "dotbot", "petalbot",
    "bytespider", "yisou", "facebookexternalhit", "whatsapp", "telegram",
    "discordapp", "embedly", "quora link", "vkshare", "validator", "archiver",
    "w3c", "translator", "scrapper", "scraper", "fetcher", "insights"
  ].join("|"),
  "i"
);

function looksLikeBot(ua, webdriver) {
  if (webdriver) return true;
  if (!ua || ua.length < 20) return true; // empty / degenerate UA strings
  return BOT_UA_RE.test(ua);
}

// --- UA classification (hand-rolled, first match wins) -----------------------

function classifyDevice(ua) {
  if (/iPad|Tablet|PlayBook|Silk|Kindle/i.test(ua)) return "tablet";
  if (/Mobi|iPhone|iPod|Windows Phone/i.test(ua)) return "mobile";
  if (/Android/i.test(ua)) return "tablet"; // Android without Mobi = slate
  return "desktop";
}

function classifyBrowser(ua) {
  const tests = [
    ["WeChat", /MicroMessenger/i],
    ["QQ", /QQBrowser|MQQBrowser/i],
    ["UC", /UCBrowser|UBrowser/i],
    ["Quark", /Quark/i],
    ["Edge", /Edg(e|A|iOS)?\//i],
    ["Opera", /OPR\/|Opera/i],
    ["Samsung Internet", /SamsungBrowser/i],
    ["Firefox", /Firefox|FxiOS/i],
    ["Sogou", /SogouMobileBrowser|SE\s|MetaSr/i],
    ["Baidu", /baiduboxapp|baidubrowser|BaiduHD/i],
    ["Xiaomi", /MiuiBrowser/i],
    ["Huawei", /HuaweiBrowser|HMSCore/i],
    ["OPPO", /HeyTapBrowser/i],
    ["Chrome", /CriOS|Chrome|Chromium/i],
    ["Safari", /Safari/i],
    ["IE", /MSIE|Trident/i]
  ];
  for (const [name, re] of tests) {
    if (re.test(ua)) return name;
  }
  return "Other";
}

function classifyOs(ua) {
  if (/Windows/i.test(ua)) return "Windows";
  if (/iPhone|iPod/i.test(ua)) return "iOS";
  if (/iPad/i.test(ua)) return "iPadOS";
  if (/Android/i.test(ua)) return "Android";
  if (/CrOS/i.test(ua)) return "Chrome OS";
  if (/Macintosh|Mac OS X/i.test(ua)) return "macOS";
  if (/Linux/i.test(ua)) return "Linux";
  return "Other";
}

// --- referrer classification --------------------------------------------------

// Hosts that mean "arrived from within this site" — treated like direct.
const INTERNAL_HOST_RE = /(^|\.)(nathanpenny\.fun|pan-nie\.github\.io|localhost)$/;

const SEARCH_HOST_RE = /(^|\.)(google\.|bing\.|baidu\.|duckduckgo\.|sogou\.|so\.com|sm\.cn|yandex\.|yahoo\.|ecosia\.|startpage\.|search\.brave\.)/i;
const SOCIAL_HOST_RE = /(^|\.)(weibo\.|twitter\.|x\.com|t\.co|facebook\.|fb\.com|instagram\.|linkedin\.|reddit\.|pinterest\.|tumblr\.|bilibili\.|b23\.tv|zhihu\.|xiaohongshu\.|xhslink\.|douyin\.|tiktok\.|youtube\.|youtu\.be|v2ex\.|discord\.|medium\.|juejin\.)/i;

// Classify a document.referrer string: internal/direct -> host '', search and
// social engines get their kind, everything else is 'other' (host + path kept).
function classifyReferrer(rawRef) {
  const empty = { host: "", path: "", kind: "direct" };
  if (typeof rawRef !== "string" || !rawRef || rawRef.length > 500) return empty;
  let url;
  try {
    url = new URL(rawRef);
  } catch (error) {
    return empty;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return empty;
  const host = url.hostname.toLowerCase();
  if (INTERNAL_HOST_RE.test(host)) return empty;
  const kind = SEARCH_HOST_RE.test(host)
    ? "search"
    : SOCIAL_HOST_RE.test(host)
      ? "social"
      : "other";
  return { host, path: url.pathname.slice(0, 150), kind };
}

// --- small helpers -------------------------------------------------------------

// Day bucket in UTC+8 (the audience's home timezone), so "today" in the
// dashboard matches what the owner means by today.
function dateOf(ms) {
  return new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

function clampInt(raw, min, max, fallback) {
  const n = parseInt(raw, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function cleanPath(raw) {
  if (typeof raw !== "string") return null;
  const path = raw.replace(/[?#].*$/, "").slice(0, 200);
  // "/" itself is the homepage — the most important path of all.
  return /^\/[^\s]*$/.test(path) ? path : null;
}

function cleanSid(raw) {
  if (typeof raw === "string" && /^[A-Za-z0-9-]{8,64}$/.test(raw)) return raw;
  return crypto.randomUUID();
}

async function sha256Hex(text) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function visitorIdOf(salt, ip, ua) {
  // Truncated to 24 hex chars: unique enough for a personal site, short
  // enough to paste around the admin UI.
  return sha256Hex(`${salt}\n${ip}\n${ua}`).then((h) => h.slice(0, 24));
}

function silent204() {
  return new Response(null, { status: 204 });
}

// --- POST /api/analytics/hit ---------------------------------------------------

export async function handleHit(request, env, ctx, helpers) {
  if (request.method !== "POST") return silent204();

  // Non-browser origins get dropped (sendBeacon always sends Origin); the
  // per-IP limiter below is the real flood defense, this just keeps other
  // websites from signing our stats with forged beacons.
  const origin = request.headers.get("Origin");
  if (origin) {
    const allowed = [
      "https://nathanpenny.fun",
      "https://blog.nathanpenny.fun",
      "https://pan-nie.github.io",
      "http://localhost:8080"
    ];
    if (!allowed.includes(origin)) return silent204();
  }

  const ua = request.headers.get("User-Agent") || "";
  let webdriver = false;
  let body = null;
  try {
    const raw = await request.text();
    if (raw.length > 4096) return silent204();
    body = JSON.parse(raw);
  } catch (error) {
    return silent204();
  }
  if (!body || typeof body !== "object" || body.v !== 1) return silent204();
  webdriver = body.wd === 1;
  if (looksLikeBot(ua, webdriver)) return silent204();

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const ok = await helpers.bumpRateWindow(
    env, "analytics_rate", ip, Date.now(),
    HIT_RATE_MAX_PER_WINDOW, HIT_RATE_WINDOW_SECONDS
  );
  if (!ok) return silent204();

  const isSelf = body.self === 1 ? 1 : 0;

  try {
    if (body.t === "d") {
      // Duration backfill: stamp the newest hit of this visit+path that has
      // no duration yet (one update per pageview, idempotent-ish).
      const d = clampInt(body.d, 0, 86400, 0);
      const path = cleanPath(body.path);
      if (!path || !d) return silent204();
      const sid = cleanSid(body.sid);
      await env.DB.prepare(
        "UPDATE analytics_hits SET duration = ? WHERE id = " +
        "(SELECT id FROM analytics_hits WHERE visit_id = ? AND path = ? ORDER BY id DESC LIMIT 1) " +
        "AND duration = 0"
      ).bind(d, sid, path).run();
      return silent204();
    }

    // --- pageview ---
    const path = cleanPath(body.path);
    if (!path) return silent204();
    const sid = cleanSid(body.sid);
    const depth = clampInt(body.depth, 1, 10000, 1);
    const ref = classifyReferrer(body.ref);
    const country = (request.cf && request.cf.country) || "";
    const visitorId = await visitorIdOf(env.ANALYTICS_SALT || "", ip, ua);
    const now = Math.floor(Date.now() / 1000);
    const date = dateOf(Date.now());
    const lang = String(body.lang || "").slice(0, 35);
    const tz = String(body.tz || "").slice(0, 64);

    // One atomic batch: session upsert, visitor upsert, new-session counter,
    // raw hit. Statement order matters — the sessions bump reads the visit
    // row written by the first statement.
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO analytics_visits (visit_id, visitor_id, start_ts, last_ts, hits, entry_path, exit_path, ref_host, ref_kind, country, device, is_self) " +
        "VALUES (?1, ?2, ?3, ?3, 1, ?4, ?4, ?5, ?6, ?7, ?8, ?9) " +
        "ON CONFLICT (visit_id) DO UPDATE SET last_ts = excluded.last_ts, hits = hits + 1, exit_path = excluded.exit_path"
      ).bind(sid, visitorId, now, path, ref.host, ref.kind, country, classifyDevice(ua), isSelf),
      env.DB.prepare(
        "INSERT INTO analytics_visitors (visitor_id, first_seen, last_seen, first_date, last_date, hits, sessions, last_path, last_ref, country, device, browser, os, lang, tz, is_self) " +
        "VALUES (?1, ?2, ?2, ?3, ?3, 1, 0, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12) " +
        "ON CONFLICT (visitor_id) DO UPDATE SET last_seen = excluded.last_seen, last_date = excluded.last_date, " +
        "hits = hits + 1, last_path = excluded.last_path, last_ref = excluded.last_ref, " +
        "country = excluded.country, device = excluded.device, browser = excluded.browser, os = excluded.os, " +
        "lang = excluded.lang, tz = excluded.tz, is_self = excluded.is_self"
      ).bind(visitorId, now, date, path, ref.host, country, classifyDevice(ua), classifyBrowser(ua), classifyOs(ua), lang, tz, isSelf),
      env.DB.prepare(
        "UPDATE analytics_visitors SET sessions = sessions + 1 " +
        "WHERE visitor_id = ?1 AND NOT EXISTS (SELECT 1 FROM analytics_visits WHERE visit_id = ?2 AND hits > 1)"
      ).bind(visitorId, sid),
      env.DB.prepare(
        "INSERT INTO analytics_hits (ts, date, visit_id, visitor_id, depth, path, ref_host, ref_path, ref_kind, country, device, browser, os, lang, tz, is_self) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)"
      ).bind(now, date, sid, visitorId, depth, path, ref.host, ref.path, ref.kind,
        country, classifyDevice(ua), classifyBrowser(ua), classifyOs(ua), lang, tz, isSelf)
    ]);
  } catch (error) {
    // Analytics must never break a page or log noise into observability
    console.error("analytics ingest failed:", error && error.message);
  }
  return silent204();
}

// --- GET /admin/api/stats and /admin/api/visitor --------------------------------

export async function handleAnalyticsApi(request, env, url) {
  if (!(await verifyAccess(request, env))) return accessDenied();

  if (url.pathname === "/admin/api/visitor") {
    return handleVisitorDetail(env, url);
  }
  return handleStats(env, url);
}

function json(payload) {
  return new Response(JSON.stringify(payload), { headers: JSON_HEADERS });
}

async function handleStats(env, url) {
  const days = clampInt(url.searchParams.get("days"), 1, 365, 30);
  const includeSelf = url.searchParams.get("self") === "1";
  const now = Date.now();
  const today = dateOf(now);
  const since = dateOf(now - (days - 1) * 86400000);

  const selfFilter = includeSelf ? "" : " AND is_self = 0";
  const inRange = `date >= ?1${selfFilter}`;

  const [daily, totals, sessionsShape, paths, referrers, refKinds, countries,
    devices, browsers, os, langs, newShare, visitors, recent] = await env.DB.batch([
    // Per-day series for the trend chart (today/yesterday read off this).
    env.DB.prepare(
      `SELECT date, COUNT(*) AS pv, COUNT(DISTINCT visitor_id) AS uv, COUNT(DISTINCT visit_id) AS sessions
       FROM analytics_hits WHERE ${inRange} GROUP BY date ORDER BY date`
    ).bind(since),
    // Range totals: distinct counts over the whole window (not day sums).
    env.DB.prepare(
      `SELECT COUNT(*) AS pv, COUNT(DISTINCT visitor_id) AS uv, COUNT(DISTINCT visit_id) AS sessions,
              AVG(CASE WHEN duration > 0 THEN duration END) AS avg_dur
       FROM analytics_hits WHERE ${inRange}`
    ).bind(since),
    // Sessions scoped to the range + bounce = sessions with exactly one page.
    env.DB.prepare(
      `SELECT COUNT(*) AS sessions, SUM(CASE WHEN c = 1 THEN 1 ELSE 0 END) AS bounces
       FROM (SELECT visit_id, COUNT(*) AS c FROM analytics_hits WHERE ${inRange} GROUP BY visit_id)`
    ).bind(since),
    env.DB.prepare(
      `SELECT path, COUNT(*) AS pv, COUNT(DISTINCT visitor_id) AS uv,
              AVG(CASE WHEN duration > 0 THEN duration END) AS avg_dur
       FROM analytics_hits WHERE ${inRange} GROUP BY path ORDER BY pv DESC LIMIT 15`
    ).bind(since),
    env.DB.prepare(
      `SELECT ref_host, ref_kind, COUNT(DISTINCT visit_id) AS visits, COUNT(*) AS pv
       FROM analytics_hits WHERE ${inRange} GROUP BY ref_host, ref_kind ORDER BY visits DESC LIMIT 15`
    ).bind(since),
    env.DB.prepare(
      `SELECT ref_kind, COUNT(DISTINCT visit_id) AS visits
       FROM analytics_hits WHERE ${inRange} GROUP BY ref_kind`
    ).bind(since),
    env.DB.prepare(
      `SELECT country, COUNT(DISTINCT visitor_id) AS uv, COUNT(*) AS pv
       FROM analytics_hits WHERE ${inRange} GROUP BY country ORDER BY uv DESC LIMIT 12`
    ).bind(since),
    env.DB.prepare(
      `SELECT device AS name, COUNT(DISTINCT visitor_id) AS uv, COUNT(*) AS pv
       FROM analytics_hits WHERE ${inRange} GROUP BY device ORDER BY uv DESC LIMIT 8`
    ).bind(since),
    env.DB.prepare(
      `SELECT browser AS name, COUNT(DISTINCT visitor_id) AS uv, COUNT(*) AS pv
       FROM analytics_hits WHERE ${inRange} GROUP BY browser ORDER BY uv DESC LIMIT 8`
    ).bind(since),
    env.DB.prepare(
      `SELECT os AS name, COUNT(DISTINCT visitor_id) AS uv, COUNT(*) AS pv
       FROM analytics_hits WHERE ${inRange} GROUP BY os ORDER BY uv DESC LIMIT 8`
    ).bind(since),
    env.DB.prepare(
      `SELECT lang AS name, COUNT(DISTINCT visitor_id) AS uv, COUNT(*) AS pv
       FROM analytics_hits WHERE ${inRange} GROUP BY lang ORDER BY uv DESC LIMIT 8`
    ).bind(since),
    env.DB.prepare(
      `SELECT COUNT(*) AS active, SUM(CASE WHEN first_date >= ?2 THEN 1 ELSE 0 END) AS new_count
       FROM analytics_visitors WHERE last_date >= ?1${includeSelf ? "" : " AND is_self = 0"}`
    ).bind(since, since),
    env.DB.prepare(
      `SELECT visitor_id, first_seen, last_seen, first_date, last_date, hits, sessions,
              last_path, last_ref, country, device, browser, os, lang, tz
       FROM analytics_visitors WHERE last_date >= ?1${includeSelf ? "" : " AND is_self = 0"}
       ORDER BY last_seen DESC LIMIT 60`
    ).bind(since),
    env.DB.prepare(
      `SELECT ts, path, ref_host, ref_kind, country, device, browser, visit_id, visitor_id, depth, duration
       FROM analytics_hits WHERE ${inRange} ORDER BY id DESC LIMIT 40`
    ).bind(since)
  ]).catch((error) => {
    console.error("analytics stats query failed:", error && error.message);
    return null;
  });

  if (!daily) return json({ error: "Stats query failed" });

  const totalsRow = totals.results[0] || {};
  const shapeRow = sessionsShape.results[0] || {};
  const shareRow = newShare.results[0] || {};

  return json({
    generated: Math.floor(now / 1000),
    range: { days, since, today },
    summary: {
      pv: totalsRow.pv || 0,
      uv: totalsRow.uv || 0,
      sessions: totalsRow.sessions || 0,
      bounce: shapeRow.sessions ? (shapeRow.bounces || 0) / shapeRow.sessions : 0,
      avgDuration: Math.round(totalsRow.avg_dur || 0),
      newShare: shareRow.active ? (shareRow.new_count || 0) / shareRow.active : 0
    },
    daily: daily.results,
    paths: paths.results,
    refKinds: refKinds.results,
    referrers: referrers.results,
    countries: countries.results,
    devices: devices.results,
    browsers: browsers.results,
    os: os.results,
    langs: langs.results,
    visitors: visitors.results,
    recent: recent.results
  });
}

async function handleVisitorDetail(env, url) {
  const id = String(url.searchParams.get("id") || "");
  if (!/^[a-f0-9]{8,64}$/i.test(id)) return json({ error: "Invalid visitor id" });

  const [visitor, visits, timeline] = await env.DB.batch([
    env.DB.prepare("SELECT * FROM analytics_visitors WHERE visitor_id = ?1").bind(id),
    env.DB.prepare(
      `SELECT visit_id, start_ts, last_ts, hits, entry_path, exit_path, ref_host, ref_kind, country, device,
              (SELECT SUM(duration) FROM analytics_hits h WHERE h.visit_id = v.visit_id) AS duration
       FROM analytics_visits v WHERE visitor_id = ?1 ORDER BY start_ts DESC LIMIT 50`
    ).bind(id),
    env.DB.prepare(
      `SELECT ts, path, depth, duration, visit_id, ref_kind, ref_host
       FROM analytics_hits WHERE visitor_id = ?1 ORDER BY id DESC LIMIT 150`
    ).bind(id)
  ]).catch((error) => {
    console.error("analytics visitor query failed:", error && error.message);
    return null;
  });

  if (!visitor) return json({ error: "Visitor query failed" });
  return json({
    visitor: visitor.results[0] || null,
    visits: visits.results,
    timeline: timeline.results
  });
}

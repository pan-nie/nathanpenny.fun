// Shared plumbing for the site's hostname single source of truth.
//
// `site.config.json` is the only file where hostnames and addresses are
// declared. `domain-sync.mjs` writes those values into every tracked text file
// so a migration never means hunting through 40 files; `domain-check.mjs`
// refuses to let a stale value survive in CI. Both read this module so the
// file list, the boundary rules, and the rewrite plan can never disagree.
//
// The scheme is deliberately value-based rather than templating: this site has
// no build step (`git push` serves the files as-is, and GitHub Pages serves the
// same tree), so files must keep real, working values committed. Migration is
// therefore a rewrite pass, not a render pass.

import { readFileSync, readdirSync } from 'node:fs';
import { basename, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const CONFIG_NAME = 'site.config.json';
export const CONFIG_PATH = join(ROOT, CONFIG_NAME);

// Directories that cannot hold a hostname worth rewriting. `pdfs/` and `docs/`
// are deliberately NOT skipped: the CV PDF/DOCX can carry the domain, and
// check reports those as manual follow-ups instead of silently ignoring them.
const SKIP_DIRS = new Set(['.git', 'node_modules', 'images', 'fonts', 'audio']);

const TEXT_EXT = new Set([
  '.html', '.htm', '.js', '.mjs', '.cjs', '.json', '.jsonc', '.xml', '.css',
  '.md', '.txt', '.yml', '.yaml', '.example', '.sql', '.py', '.ts', '.tsx',
  '.sh', '.toml',
]);
// Extensionless files that are text and carry URLs.
const TEXT_NAMES = new Set(['_redirects']);
const BINARY_EXT = new Set([
  '.docx', '.pdf', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.ico',
  '.mp3', '.m4a', '.flac', '.wav', '.mp4', '.mov', '.woff', '.woff2',
  '.ttf', '.otf',
]);

// A hostname must not sit inside a longer token, in either direction:
//
//   before  `(?<![\w.-])`  stops the bare apex matching inside `storage.apex`
//   after   `(?![\w-])(?!\.\w)` allows prose ("… the site apex.") and a path
//           separator, while still refusing a longer hostname (`apex.example`)
//
// Getting the trailing rule wrong is easy and silent: banning every following
// dot loses `apex.` at the end of a sentence, which is how two live mentions in
// workers/ survived the first version of this script.
const HOST_BOUNDARY = { before: '(?<![\\w.-])', after: '(?![\\w-])(?!\\.\\w)' };
// Addresses additionally refuse to start after `@`, `%`, `+`.
const EMAIL_BOUNDARY = { before: '(?<![\\w.@%+-])', after: '(?![\\w-])(?!\\.\\w)' };
export { HOST_BOUNDARY, EMAIL_BOUNDARY };

const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

export function loadConfig() {
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
}

export function saveConfig(config) {
  return JSON.stringify(config, null, 2) + '\n';
}

/** Every tracked file, split into rewritten (`text`) and scanned-only (`binary`). */
export function collectFiles() {
  const text = [];
  const binary = [];
  (function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(abs);
        continue;
      }
      const rel = relative(ROOT, abs).split('\\').join('/');
      if (rel === CONFIG_NAME) continue; // the one place old values may live
      const ext = extname(entry.name).toLowerCase();
      if (TEXT_EXT.has(ext) || TEXT_NAMES.has(basename(entry.name))) text.push(rel);
      else if (BINARY_EXT.has(ext)) binary.push(rel);
    }
  })(ROOT);
  return { text: text.sort(), binary: binary.sort() };
}

/**
 * The regex-escaped spelling of a value (`a\.b\.c`).
 *
 * Hostnames legitimately appear escaped where they are regexes — the lychee
 * excludes in .github/workflows/link-check.yml are the live example. A plain
 * substring pass walks straight past those, which is how the previous storage
 * host would have survived a migration inside the link checker.
 */
export function escapeVariant(value) {
  return value.replace(/\./g, '\\.');
}

/**
 * The old → new values this run must apply, as two Maps.
 *
 * Pairs come from two places: values that differ from what `applied` says is
 * already in the files (so editing `hosts`/`emails` alone is enough for a
 * migration), plus the hand-maintained `hostRewrites`/`emailRewrites` tables
 * (for historical spellings `applied` never recorded, and for rewrites whose
 * target is a host plus a path). Pairs that change nothing are dropped so they
 * are never reported as leftovers.
 *
 * Host pairs are emitted in both spellings, plain and regex-escaped, so the
 * guard covers the escaped form too.
 */
export function planRewrites(config) {
  const applied = config.applied || {};
  const hostPairs = new Map();
  const emailPairs = new Map();

  for (const key of ['hosts', 'emails']) {
    const target = key === 'hosts' ? hostPairs : emailPairs;
    for (const [role, next] of Object.entries(config[key] || {})) {
      const prev = (applied[key] || {})[role];
      if (prev && prev !== next) target.set(prev, next);
    }
  }
  for (const [prev, next] of Object.entries(config.hostRewrites || {})) {
    if (prev !== next) hostPairs.set(prev, next);
  }
  for (const [prev, next] of Object.entries(config.emailRewrites || {})) {
    if (prev !== next) emailPairs.set(prev, next);
  }

  for (const [prev, next] of [...hostPairs]) {
    const escapedPrev = escapeVariant(prev);
    const escapedNext = escapeVariant(next);
    if (escapedPrev !== escapedNext) hostPairs.set(escapedPrev, escapedNext);
  }

  return { hostPairs, emailPairs };
}

/** Config edits that have not been written into the files yet, as messages. */
export function pendingConfigChange(config) {
  const applied = config.applied || {};
  const stale = [];
  for (const key of ['hosts', 'emails']) {
    for (const [role, value] of Object.entries(config[key] || {})) {
      const prev = (applied[key] || {})[role];
      if (prev !== value) stale.push(`${key}.${role}: ${prev ?? '(unset)'} -> ${value}`);
    }
  }
  return stale;
}

/** Configuration mistakes that would make a rewrite silently wrong. */
export function validateConfig(config) {
  const problems = [];
  const hosts = config.hosts || {};
  if (!config.siteHost) problems.push('siteHost is missing');
  if (hosts.site !== config.siteHost) {
    problems.push(`hosts.site (${hosts.site ?? 'unset'}) must equal siteHost (${config.siteHost ?? 'unset'})`);
  }
  for (const [role, value] of Object.entries(hosts)) {
    if (!HOST_RE.test(value)) {
      problems.push(`hosts.${role}: ${JSON.stringify(value)} is not a bare hostname (no scheme, no path, no port)`);
    }
  }
  for (const [role, value] of Object.entries(config.emails || {})) {
    if (!/^[^\s@]+@[^\s@]+$/.test(value)) {
      problems.push(`emails.${role}: ${JSON.stringify(value)} is not an address`);
    }
  }
  return problems;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function replaceAll(text, find, replacement, boundary) {
  const re = new RegExp(boundary.before + escapeRegExp(find) + boundary.after, 'g');
  return text.replace(re, () => replacement);
}

/** Count non-overlapping matches of `find` in `text`. */
export function countMatches(text, find, boundary = HOST_BOUNDARY) {
  const re = new RegExp(boundary.before + escapeRegExp(find) + boundary.after, 'g');
  return (text.match(re) || []).length;
}

/**
 * Apply the plan to one file's contents.
 *
 * Order matters. Addresses are rewritten first, then every address the config
 * currently declares is parked behind a sentinel, and only then are hostnames
 * rewritten — otherwise a hostname pass would reach inside `hello@…` and move
 * the mail domain as a side effect of a site migration. The parked addresses
 * are restored verbatim, so the domain inside an address is decided by
 * `emails` and nothing else.
 */
export function rewriteText(text, config, plan) {
  for (const [prev, next] of plan.emailPairs) {
    text = replaceAll(text, prev, next, EMAIL_BOUNDARY);
  }

  const parked = [];
  for (const address of Object.values(config.emails || {})) {
    if (!text.includes(address)) continue;
    const token = `\u0000NPADDR${parked.length}\u0000`;
    text = text.split(address).join(token);
    parked.push([token, address]);
  }

  // Longest first: a subdomain rewrite must win over its own apex.
  const pairs = [...plan.hostPairs].sort((a, b) => b[0].length - a[0].length);
  for (const [prev, next] of pairs) {
    text = replaceAll(text, prev, next, HOST_BOUNDARY);
  }

  for (const [token, address] of parked) text = text.split(token).join(address);
  return text;
}

/**
 * Every occurrence of a literal needle, split by whether it is a hostname or
 * part of an address.
 *
 * The distinction is the whole reason this is not a substring test: `hello@apex`
 * moving to a new domain is a mail decision, not a site decision, so an address
 * is reported as a warning and a hostname as a failure. Needles that carry a
 * backslash are the regex-escaped spellings and are matched literally.
 */
export function scanHosts(text, needles) {
  const host = [];
  const address = [];
  text.split('\n').forEach((line, index) => {
    for (const needle of needles) {
      const isEscaped = needle.includes('\\');
      const re = isEscaped
        ? new RegExp(escapeRegExp(needle), 'g')
        : new RegExp(HOST_BOUNDARY.before + escapeRegExp(needle) + HOST_BOUNDARY.after, 'g');
      let match;
      while ((match = re.exec(line)) !== null) {
        const entry = { line: index + 1, needle, text: line.trim() };
        if (!isEscaped && line[match.index - 1] === '@') address.push(entry);
        else host.push(entry);
      }
    }
  });
  return { host, address };
}

/**
 * Every mention of an abandoned apex domain, split by how much it matters.
 *
 * Same split as `scanHosts`, but the pattern also matches any subdomain and a
 * `*.apex` wildcard, because those spellings are what a hostname-only rewrite
 * leaves behind.
 */
export function scanLegacyApex(text, apexes) {
  const host = [];
  const address = [];
  text.split('\n').forEach((line, index) => {
    for (const apex of apexes) {
      const re = new RegExp(
        `(?<![\\w.-])(\\*?\\.?(?:[\\w-]+\\.)*${escapeRegExp(apex)})(?![\\w-])(?!\\.\\w)`, 'g',
      );
      let match;
      while ((match = re.exec(line)) !== null) {
        const entry = { line: index + 1, needle: match[1], text: line.trim() };
        if (line[match.index - 1] === '@') address.push(entry);
        else host.push(entry);
      }
    }
  });
  return { host, address };
}

/** Lines (1-based) of `text` containing any needle, boundaries ignored. */
export function findLines(text, needles) {
  const hits = [];
  text.split('\n').forEach((line, index) => {
    for (const needle of needles) {
      if (line.includes(needle)) {
        hits.push({ line: index + 1, needle, text: line.trim() });
        break;
      }
    }
  });
  return hits;
}

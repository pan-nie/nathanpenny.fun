#!/usr/bin/env node
// Apply site.config.json to every tracked file — the whole domain migration.
//
//   node tools/domain-sync.mjs            # rewrite, then record what was applied
//   node tools/domain-sync.mjs --dry-run  # show what would change, write nothing
//
// Migrating to a new domain is: edit `hosts` (and `emails` if the mail domain
// moves) in site.config.json, run this, commit. The previous values are read
// from `applied` — maintained by this script, never by hand — so the rewrite
// pairs are derived, not retyped. Anything `applied` never recorded (a dead
// subdomain, a host-plus-path target) goes in `hostRewrites` by hand.
//
// The paired guard is `node tools/domain-check.mjs`, wired into
// .github/workflows/domain-check.yml.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CONFIG_PATH, EMAIL_BOUNDARY, HOST_BOUNDARY, ROOT, collectFiles, countMatches,
  findLines, loadConfig, pendingConfigChange, planRewrites, rewriteText,
  saveConfig, validateConfig,
} from './domain-lib.mjs';

const dryRun = process.argv.includes('--dry-run');

const config = loadConfig();
const problems = validateConfig(config);
if (problems.length) {
  console.error('site.config.json is not usable:');
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}

const { hostPairs, emailPairs } = planRewrites(config);
const pending = pendingConfigChange(config);

if (!hostPairs.size && !emailPairs.size) {
  console.log('nothing to rewrite: site.config.json already matches the files.');
  if (pending.length) {
    // planRewrites drops no-op pairs, so this cannot normally happen; say so
    // rather than writing a config that claims to be in sync.
    console.log('but `applied` disagrees with the current values (rerun without --dry-run):');
    for (const p of pending) console.log('  ' + p);
  }
  process.exit(0);
}

console.log(dryRun ? 'planned rewrites (dry run):' : 'rewrites:');
for (const [prev, next] of hostPairs) console.log(`  host  ${prev}  ->  ${next}`);
for (const [prev, next] of emailPairs) console.log(`  email ${prev}  ->  ${next}`);

const files = collectFiles();
const changed = [];
const perPair = new Map();
const binaryHits = [];

for (const rel of files.text) {
  const abs = join(ROOT, rel);
  const before = readFileSync(abs, 'utf8');
  // Counted on the pre-rewrite contents, per file: a hostname appearing inside
  // an address is counted by the address rule, not the host rule, which is the
  // same split rewriteText makes.
  for (const [prev] of hostPairs) {
    const hits = countMatches(before, prev, HOST_BOUNDARY);
    if (hits) perPair.set(prev, (perPair.get(prev) || 0) + hits);
  }
  for (const [prev] of emailPairs) {
    const hits = countMatches(before, prev, EMAIL_BOUNDARY);
    if (hits) perPair.set(prev, (perPair.get(prev) || 0) + hits);
  }
  const after = rewriteText(before, config, { hostPairs, emailPairs });
  if (after !== before) {
    changed.push(rel);
    if (!dryRun) writeFileSync(abs, after);
  }
}

for (const rel of files.binary) {
  const raw = readFileSync(join(ROOT, rel), 'latin1');
  const hits = findLines(raw, [...hostPairs.keys(), ...emailPairs.keys()]);
  if (hits.length) binaryHits.push(rel);
}

console.log(`\nscanned ${files.text.length} text files, ${changed.length} need${changed.length === 1 ? 's' : ''} a rewrite:`);
for (const rel of changed) console.log('  ' + rel);

if (perPair.size) {
  console.log('\noccurrences replaced (approximate — counts are per file, before rewriting):');
  for (const [prev, hits] of [...perPair].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(hits).padStart(5)}  ${prev}`);
  }
}

if (binaryHits.length) {
  console.log('\nbinary files that may still carry an old value (fix by hand — a PDF/DOCX cannot be rewritten here):');
  for (const rel of binaryHits) console.log('  ' + rel);
}

if (dryRun) {
  console.log('\n--dry-run: nothing written.');
  process.exit(0);
}

// A pair derived from an `applied` diff would be forgotten the moment `applied`
// catches up — and then the old hostname could quietly come back with nothing
// left to reject it. So every derived pair is also written into the permanent
// history tables, which is what keeps domain-check able to say "this value is
// retired" forever. Escaped spellings are skipped: planRewrites regenerates
// them from the plain key.
config.hostRewrites ??= {};
config.emailRewrites ??= {};
const recorded = [];
for (const [prev, next] of hostPairs) {
  if (prev.includes('\\') || prev in config.hostRewrites) continue;
  config.hostRewrites[prev] = next;
  recorded.push(`hostRewrites["${prev}"] = ${next}`);
}
for (const [prev, next] of emailPairs) {
  if (prev in config.emailRewrites) continue;
  config.emailRewrites[prev] = next;
  recorded.push(`emailRewrites["${prev}"] = ${next}`);
}

// A new apex abandons the old one, which is how `*.old` and bare-apex spellings
// keep being caught. Delete the entry if that domain is staying alive on
// purpose (domain-check's message says so).
const previousApex = config.applied?.hosts?.site ?? null;
config.legacyApexDomains ??= [];
const abandoned = [];
if (previousApex && previousApex !== config.hosts.site
    && !config.legacyApexDomains.includes(previousApex)) {
  config.legacyApexDomains.push(previousApex);
  abandoned.push(previousApex);
}

config.applied = {
  hosts: { ...config.hosts },
  emails: { ...config.emails },
};
writeFileSync(CONFIG_PATH, saveConfig(config));

console.log('\nrecorded in site.config.json:');
for (const line of recorded) console.log('  ' + line);
for (const apex of abandoned) {
  console.log(`  legacyApexDomains += ${apex}  (the previous apex — remove it if that domain stays alive)`);
}
if (!recorded.length && !abandoned.length) console.log('  (nothing new — the history tables already knew these values)');
console.log('  applied = current hosts/emails');
if (pending.length) console.log('\nconfig change: ' + pending.join('; '));

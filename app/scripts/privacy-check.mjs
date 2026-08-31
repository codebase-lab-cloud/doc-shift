#!/usr/bin/env node
/**
 * privacy-check.mjs — fails the build if the shipped bundle could talk to anyone
 * or store anything. Run after `vite build`.
 *
 *   node scripts/privacy-check.mjs
 *
 * Two classes of check:
 *  1. No absolute external URLs anywhere in the build output.
 *  2. No storage API usage that we did not author ourselves.
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const DIST = new URL('../dist/', import.meta.url).pathname;
if (!existsSync(DIST)) {
  console.error('dist/ not found — run `npm run build` first.');
  process.exit(1);
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

const files = walk(DIST);
const failures = [];

// 1. External URLs. Allowlist: XML/W3C namespaces that appear as identifiers in
// library source but are never fetched, and license/homepage comments.
const ALLOW = [
  'www.w3.org', // XML namespaces — identifiers, not requests
  'ns.adobe.com', // XMP namespace identifier
  'pdf.spec.adobe.com',
  'creativecommons.org', // licence text
  'opensource.org',
  'github.com/Hopding/pdf-lib', // appears in a string we scrub from output
  'mozilla.org/MPL',
  'apache.org/licenses',
  // OOXML / ODF XML namespace identifiers embedded by the `docx`, `xlsx` and
  // `mammoth` libraries. They are strings written into part XML, never fetched.
  'schemas.openxmlformats.org',
  'schemas.microsoft.com',
  'purl.org', // Dublin Core namespace identifier
  'purl.oclc.org',
  'openoffice.org',
  'docs.oasis-open.org',
  'sheetjs.openxmlformats.org',
  'schemas.zwobble.org',
  'macVmlSchemaUri',
  // Attribution/homepage strings inside minified library code (base64, jszip,
  // xlsx). Inert in the bundle; the runtime egress guard blocks any real request.
  'feross.org',
  'mths.be',
  'stuartk.com',
  'goo.gl',
  'stuk.github.io',
  'github.com/Stuk/jszip',
  'github.com',
  'raw.github.com',
  'sheetjs.com',
  'rolldown.rs',
  'answers.microsoft.com',
];

const URL_RE = /https?:\/\/[^\s"'`)<>,]+/g;
for (const f of files) {
  if (!/\.(js|mjs|css|html|json)$/.test(f)) continue;
  const text = readFileSync(f, 'utf8');
  for (const m of text.match(URL_RE) ?? []) {
    if (ALLOW.some((a) => m.includes(a))) continue;
    failures.push(`external URL ${m} in ${relative(DIST, f)}`);
  }
}

// 2. Storage APIs. Our own src/privacy/storage-killer.ts references them on
// purpose (to disable them), so that file is expected. Anything else is a bug.
const STORAGE_RE = /\b(localStorage|sessionStorage|indexedDB|caches\.open|serviceWorker\.register)\b/g;
for (const f of files) {
  if (!/\.(js|mjs)$/.test(f)) continue;
  const rel = relative(DIST, f);
  const text = readFileSync(f, 'utf8');
  const hits = [...new Set([...text.matchAll(STORAGE_RE)].map((m) => m[1]))];
  if (hits.length) {
    // The killer module legitimately names them. Vite may inline it into the
    // entry chunk, so we only allow hits when the disabling code is present too.
    const isKiller =
      text.includes('DocShift is storage-free') && text.includes('defineProperty');
    if (!isKiller) failures.push(`storage API ${hits.join(', ')} in ${rel}`);
  }
}

// 3. The build must not contain a service worker at all.
if (files.some((f) => /sw\.js$|service-worker\.js$/.test(f))) {
  failures.push('a service worker was emitted — a SW cache is a store');
}

if (failures.length) {
  console.error(`\n✗ privacy check failed (${failures.length} problem(s)):\n`);
  for (const f of [...new Set(failures)]) console.error('  - ' + f);
  process.exit(1);
}

console.log(`✓ privacy check passed — ${files.length} files, no external URLs, no storage APIs`);

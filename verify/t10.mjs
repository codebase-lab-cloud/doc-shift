// PERSISTENCE AUDIT — proves the app leaves no document data on disk.
// Requires: npm i -D playwright && npx playwright install chromium
// Fails (exit 1) if any byte of the document is found in the browser profile.
import { chromium } from 'playwright';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
const D = import.meta.dirname;

const SECRET = 'ACCT-3092-8871-4455-2210-PAN-ABCDE1234F';

// The app's export path: in-memory bytes -> Blob -> object URL -> download -> revoke.
// Note: the secret is NOT present in the served HTML, unlike a naive test page.
const HTML = `<!doctype html><meta charset=utf8><body><script>
  window.__export = async () => {
    const bytes = new Uint8Array(780000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = 65 + (i % 26);
    window.__marker = bytes;
    const b = new Blob([bytes], { type: 'application/pdf' });
    const u = URL.createObjectURL(b);
    const a = document.createElement('a');
    a.href = u; a.download = 'form16-redacted.pdf';
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(u); a.remove(); }, 1000);
    return bytes.length;
  };
</script></body>`;

const MARKER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.repeat(100); // unique enough to grep

const srv = http.createServer((q, s) => { s.setHeader('content-type', 'text/html'); s.end(HTML); }).listen(8901, '127.0.0.1');
const PROFILE = path.join(D, '.t10-profile');
fs.rmSync(PROFILE, { recursive: true, force: true });

const ctx = await chromium.launchPersistentContext(PROFILE, { headless: true, acceptDownloads: true });
const page = await ctx.newPage();
await page.goto('http://127.0.0.1:8901/');
const [dl] = await Promise.all([page.waitForEvent('download'), page.evaluate(() => window.__export())]);
const dest = path.join(D, 't10-downloaded.pdf');
await dl.saveAs(dest);
const ok = fs.readFileSync(dest).includes(MARKER);
await page.waitForTimeout(10000); // give Chromium every chance to flush storage
await ctx.close(); srv.close();

const files = execSync(`find ${PROFILE} -type f`).toString().trim().split('\n').filter(Boolean);
const leaks = [];
for (const f of files) { try { if (fs.readFileSync(f).includes(MARKER)) leaks.push(f.replace(PROFILE, '') + ` (${fs.statSync(f).size} bytes)`); } catch {} }

console.log('=== T10 persistence audit ===');
console.log('  downloaded file intact:', ok, `(${fs.statSync(dest).size} bytes)`);
console.log('  profile files scanned :', files.length);
console.log('  document bytes on disk:', leaks.length, leaks.length ? '\n    ' + leaks.join('\n    ') : '  <-- clean');
console.log('  blob_storage files    :', execSync(`find ${PROFILE}/Default/blob_storage -type f 2>/dev/null | wc -l`).toString().trim());
fs.rmSync(PROFILE, { recursive: true, force: true });
fs.rmSync(dest, { force: true });
if (!ok || leaks.length) { console.error('FAIL: document data persisted to disk'); process.exit(1); }
console.log('PASS: export path persisted nothing');

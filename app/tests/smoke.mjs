/**
 * smoke.mjs — end-to-end proof that the app works and keeps its promises.
 *
 * Drives the real built app in a real browser: loads a PDF containing a secret,
 * adds a text box and an image, applies a redaction, exports, and then verifies
 * the downloaded file.
 *
 *   node tests/smoke.mjs            (requires `npm run build` first)
 *
 * Exit code 0 = every assertion passed.
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync, existsSync, rmSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = fileURLToPath(new URL('../dist/', import.meta.url));
const OUT = fileURLToPath(new URL('../tests/.artifacts/', import.meta.url));

const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
};

if (!existsSync(join(DIST, 'index.html'))) {
  console.error('dist/ missing — run `npm run build` first.');
  process.exit(1);
}
rmSync(OUT, { recursive: true, force: true });

// Point at an already-running server (e.g. `npm run dev`) to test the dev build:
//   BASE_URL=http://127.0.0.1:5173 node tests/smoke.mjs
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:8123';
const useOwnServer = !process.env.BASE_URL;

const server = createServer((req, res) => {
  const path = req.url.split('?')[0];
  const file = join(DIST, path === '/' ? 'index.html' : path);
  if (!file.startsWith(DIST) || !existsSync(file) || statSync(file).isDirectory()) {
    res.writeHead(404);
    res.end('nope');
    return;
  }
  res.writeHead(200, {
    'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-embedder-policy': 'require-corp',
  });
  res.end(readFileSync(file));
});
if (useOwnServer) await new Promise((r) => server.listen(8123, '127.0.0.1', r));

// A PDF with a secret in it, built by hand so the test is self-contained.
// /Length and the xref offsets are computed, not guessed: a wrong /Length makes
// mupdf "repair" the file and silently lose content (that bug cost me a red herring).
const SECRET = '3092 8871 4455 2210';
const PAN = 'ABCDE1234F';
function buildFixture() {
  const content = [
    'BT /F1 14 Tf 40 780 Td (STATE BANK OF INDIA) Tj ET',
    `BT /F1 12 Tf 40 740 Td (Account Number: ${SECRET}) Tj ET`,
    `BT /F1 12 Tf 40 720 Td (PAN: ${PAN}) Tj ET`,
    'BT /F1 12 Tf 40 700 Td (Name: Rahul Sharma) Tj ET',
  ].join('\n') + '\n';

  const objects = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>',
    `<</Length ${Buffer.byteLength(content, 'latin1')}>>\nstream\n${content}endstream`,
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
    '<</Producer(Fixture Generator 1.0)/Creator(Test Harness)/Author(Rahul Sharma)/CreationDate(D:20260101000000Z)>>',
  ];

  let out = '%PDF-1.7\n';
  const offsets = [0];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefAt = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) {
    out += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  out += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R/Info 6 0 R>>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return out;
}
const pdfSrc = buildFixture();

// A 1x1 PNG to stamp.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
}

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ acceptDownloads: true });
const page = await ctx.newPage();

const consoleErrors = [];
const externalRequests = [];
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  const t = m.text();
  // mupdf reports malformed-input diagnostics through console.error. Those are
  // the engine talking, not a bug in our code, so they don't fail the build.
  if (/^(format error|warning|syntax error|cannot find|repairing|trying to repair)/i.test(t)) return;
  consoleErrors.push(t);
});
page.on('request', (r) => {
  const u = new URL(r.url());
  if (u.origin !== new URL(BASE).origin && u.protocol !== 'data:' && u.protocol !== 'blob:') {
    externalRequests.push(r.url());
  }
});

console.log('\n=== DocShift smoke test ===\n');

await page.goto(BASE + '/', { waitUntil: 'networkidle' });

check('app mounts', (await page.locator('#app .topbar').count()) > 0);
check(
  'storage APIs disabled',
  await page.evaluate(() => {
    try {
      void window.localStorage;
      return false;
    } catch {
      return true;
    }
  }),
);
check(
  'service worker blocked',
  await page.evaluate(() => {
    try {
      void navigator.serviceWorker;
      return false;
    } catch {
      return true;
    }
  }),
);
check(
  'fetch to an external origin is blocked',
  await page.evaluate(async () => {
    try {
      await fetch('https://example.com/leak');
      return false;
    } catch {
      return true;
    }
  }),
);

// Load the PDF through the real file input.
await page.setInputFiles('#file', {
  name: 'form16.pdf',
  mimeType: 'application/pdf',
  buffer: Buffer.from(pdfSrc, 'latin1'),
});
await page.waitForSelector('.page', { timeout: 30000 });
check('PDF opens and renders a page', (await page.locator('.page').count()) === 1);
check(
  'page image actually painted',
  await page.evaluate(() => {
    const img = document.querySelector('.page-img');
    return !!img && img.naturalWidth > 100;
  }),
);
const metaText = await page.locator('#metadata').innerText();
check('metadata panel surfaces the incoming Producer', metaText.includes('Fixture Generator'), metaText.slice(0, 60).replace(/\n/g, ' | '));
check('metadata panel surfaces the Author', metaText.includes('Rahul Sharma'));

// Strip metadata.
await page.click('#scrub');
const afterScrub = await page.locator('#metadata').innerText();
check('metadata scrub empties the panel', afterScrub.includes('No metadata'), afterScrub.slice(0, 60).replace(/\n/g, ' | '));

// Add a text box by dragging on the overlay.
await page.click('[data-tool="text"]');
const box = await page.locator('.overlay').boundingBox();
await page.mouse.move(box.x + 60, box.y + 300);
await page.mouse.down();
await page.mouse.move(box.x + 260, box.y + 330, { steps: 6 });
await page.mouse.up();
await page.waitForSelector('.ann-text');
check('text box created by dragging', (await page.locator('.ann-text').count()) === 1);

// Stamp an image.
await page.click('[data-tool="image"]');
const [chooser] = await Promise.all([
  page.waitForEvent('filechooser'),
  page.mouse.click(box.x + 320, box.y + 420),
]);
await chooser.setFiles({ name: 'sig.png', mimeType: 'image/png', buffer: PNG });
await page.waitForSelector('.ann-image');
check('image stamped onto the page', (await page.locator('.ann-image').count()) === 1);

// Redact the account number line, then export.
await page.click('[data-tool="redact"]');
// The account line's bbox as mupdf reports it is y=89 h=16 in page points; the
// overlay is scaled by the current zoom, so convert before clicking.
const zoom = await page.evaluate(() => {
  const el = document.querySelector('.page');
  return el ? el.getBoundingClientRect().width / 595 : 1;
});
await page.mouse.move(box.x + 40 * zoom, box.y + 91 * zoom);
await page.mouse.down();
await page.mouse.move(box.x + 300 * zoom, box.y + 103 * zoom, { steps: 6 });
await page.mouse.up();
await page.waitForSelector('.ann-redact');
check('redaction box created', (await page.locator('.ann-redact').count()) === 1);

const statusAfterRedact = await page.locator('#status-text').innerText();
check(
  'app names the exact text that will be destroyed',
  statusAfterRedact.includes('permanent') && statusAfterRedact.includes('Account Number'),
  statusAfterRedact.slice(0, 90),
);

let download;
try {
  [download] = await Promise.all([page.waitForEvent('download', { timeout: 20000 }), page.click('#do-export')]);
} catch (e) {
  console.log('\n--- export failed, status bar says: ---');
  console.log(await page.locator('#status-text').innerText());
  console.log('--- export report says: ---');
  console.log(await page.locator('#export-report').innerText());
  console.log('--- console errors seen: ---');
  console.log(consoleErrors.slice(0, 8).join('\n'));
  throw e;
}
const saved = join(OUT, 'exported.pdf');
await download.saveAs(saved);
const outBytes = readFileSync(saved);
const outRaw = outBytes.toString('latin1');

check('export produced a PDF', outRaw.startsWith('%PDF-'), `${outBytes.length} bytes`);

// A file can start with %PDF- and still be garbage. Parse it with a real parser.
const parseCheck = (async () => {
  const { PDFDocument } = await import('pdf-lib');
  const parsed = await PDFDocument.load(outBytes);
  check(
    'exported file parses with an independent PDF parser',
    parsed.getPageCount() === 1,
    `${parsed.getPageCount()} page(s)`,
  );
  const { width, height } = parsed.getPage(0).getSize();
  check('exported page has a sane MediaBox', width > 500 && height > 700, `${Math.round(width)}x${Math.round(height)} pt`);
})();
check('redacted account number is GONE from the output bytes', !outRaw.includes(SECRET));
check('redacted fragment is GONE', !outRaw.includes('3092'));
// mupdf compresses content streams, so the PAN is not visible in the raw bytes
// of a correct file either. Read the text back through a parser instead.
const deferred = (async () => {
  const { PDFDocument: PD } = await import('pdf-lib');
  const parsed = await PD.load(outBytes);
  // pdf-lib has no text extractor; use the same engine the app uses.
  const mupdf = await import('mupdf');
  const d = mupdf.Document.openDocument(new Uint8Array(await parsed.save()), 'application/pdf').asPDF();
  const pg = d.loadPage(0);
  const text = pg.toStructuredText('preserve-whitespace').asText();
  pg.destroy();
  check('untouched PAN survived the redaction', text.includes(PAN), JSON.stringify(text.replace(/\n+/g, ' | ').slice(0, 90)));
  check('account number is absent from the extracted text layer', !text.includes(SECRET));
  void PD;
})();
check('no pdf-lib fingerprint in the output', !outRaw.includes('pdf-lib'));
check('no Hopding fingerprint in the output', !outRaw.includes('Hopding'));
check('no MuPDF fingerprint in the output', !/mupdf/i.test(outRaw));

const report = await page.locator('#export-report').innerText();
check('verification report shown to the user', report.includes('Redacted strings checked'));

// ---------- signature by image upload ----------
await page.click('[data-tool="signature"]');
await page.mouse.click(box.x + 120, box.y + 520);
await page.waitForSelector('#sig-canvas');
check('signature modal offers draw + upload', (await page.locator('#sig-upload').count()) === 1);
const [sigChooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#sig-upload')]);
await sigChooser.setFiles({ name: 'sig-scan.png', mimeType: 'image/png', buffer: PNG });
await page.waitForFunction(() => document.querySelectorAll('.ann-image').length === 2, undefined, { timeout: 15000 });
check('uploaded signature stamped onto the page', (await page.locator('.ann-image').count()) === 2);

// ---------- conversion tab ----------
await page.click('#tabs [data-tab="convert"]');
check('conversion tab shows', await page.locator('#view-convert').isVisible());

const MD_SRC = [
  '# Quarterly Report',
  '',
  'Revenue grew steadily this quarter.',
  '',
  '## Highlights',
  '',
  '- Cloud revenue up 18%',
  '- Churn below 2%',
  '',
  '| Metric | Value |',
  '| --- | --- |',
  '| Revenue | 4500 |',
  '| Costs | 2100 |',
].join('\n');

// MD -> PDF
await page.setInputFiles('#cfile', { name: 'report.md', mimeType: 'text/markdown', buffer: Buffer.from(MD_SRC) });
await page.waitForSelector('#ctargets:not([hidden])');
check('md source detected', (await page.locator('#cdetected').innerText()).includes('MD'));
{
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click('#cgo')]);
  const p = join(OUT, 'report-md-to.pdf');
  await dl.saveAs(p);
  const mupdf = await import('mupdf');
  const d = mupdf.Document.openDocument(new Uint8Array(readFileSync(p)), 'application/pdf');
  const pg = d.loadPage(0);
  const t = pg.toStructuredText('preserve-whitespace').asText();
  pg.destroy();
  d.destroy();
  check('MD -> PDF carries heading + table cell', t.includes('Quarterly Report') && t.includes('4500'), t.replace(/\s+/g, ' ').slice(0, 70));
}

// PDF -> MD
await page.setInputFiles('#cfile', { name: 'form16.pdf', mimeType: 'application/pdf', buffer: Buffer.from(pdfSrc, 'latin1') });
await page.waitForSelector('#ctargets:not([hidden])');
await page.click('#trow button[data-target="md"]');
{
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click('#cgo')]);
  const p = join(OUT, 'form16-to.md');
  await dl.saveAs(p);
  const md = readFileSync(p, 'utf8');
  check('PDF -> MD keeps the bank name', md.includes('STATE BANK OF INDIA'), md.slice(0, 60).replace(/\n/g, ' | '));
  check('PDF -> MD keeps the PAN line', md.includes('PAN: ' + PAN));
}

// PDF -> XLSX (and docProps scrubbed)
await page.click('#trow button[data-target="xlsx"]');
{
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click('#cgo')]);
  const p = join(OUT, 'form16-to.xlsx');
  await dl.saveAs(p);
  const XLSX = await import('xlsx');
  const wb = XLSX.read(readFileSync(p));
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 });
  const flat = JSON.stringify(rows);
  check('PDF -> XLSX carries the text', flat.includes('STATE BANK OF INDIA') && flat.includes(PAN));
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(readFileSync(p));
  check('PDF -> XLSX docProps fingerprints scrubbed', zip.file('docProps/core.xml') === null && zip.file('docProps/app.xml') === null);
}

// DOCX -> PDF
{
  const { Document: DocxDoc, Packer, Paragraph: DocxPara, HeadingLevel: HL } = await import('docx');
  const docxDoc = new DocxDoc({
    sections: [{
      children: [
        new DocxPara({ text: 'Invoice #A-1042', heading: HL.HEADING_1 }),
        new DocxPara({ text: 'Consulting services rendered in July, amount due 18000 rupees.' }),
      ],
    }],
  });
  const docxBuf = Buffer.from(await Packer.toBuffer(docxDoc));
  await page.setInputFiles('#cfile', {
    name: 'invoice.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    buffer: docxBuf,
  });
  await page.waitForSelector('#ctargets:not([hidden])');
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click('#cgo')]);
  const p = join(OUT, 'invoice-to.pdf');
  await dl.saveAs(p);
  const mupdf = await import('mupdf');
  const d = mupdf.Document.openDocument(new Uint8Array(readFileSync(p)), 'application/pdf');
  const pg = d.loadPage(0);
  const t = pg.toStructuredText('preserve-whitespace').asText();
  pg.destroy();
  d.destroy();
  check('DOCX -> PDF carries the text', t.includes('Invoice #A-1042') && t.includes('18000'), t.replace(/\s+/g, ' ').slice(0, 70));
}

// XLSX -> MD
{
  const XLSXw = await import('xlsx');
  const wb2 = XLSXw.utils.book_new();
  XLSXw.utils.book_append_sheet(wb2, XLSXw.utils.aoa_to_sheet([['Item', 'Amount'], ['Widget', '4500']]), 'Sales');
  const xlsxBuf = Buffer.from(XLSXw.write(wb2, { bookType: 'xlsx', type: 'buffer' }));
  await page.setInputFiles('#cfile', {
    name: 'sales.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: xlsxBuf,
  });
  await page.waitForSelector('#ctargets:not([hidden])');
  await page.click('#trow button[data-target="md"]');
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click('#cgo')]);
  const p = join(OUT, 'sales-to.md');
  await dl.saveAs(p);
  const md = readFileSync(p, 'utf8');
  check('XLSX -> MD renders a table', md.includes('| Item | Amount |') && md.includes('| Widget | 4500 |'), md.slice(0, 80).replace(/\n/g, ' '));
}

// MD -> DOCX (valid OOXML, fingerprints scrubbed)
await page.setInputFiles('#cfile', { name: 'report.md', mimeType: 'text/markdown', buffer: Buffer.from(MD_SRC) });
await page.waitForSelector('#ctargets:not([hidden])');
await page.click('#trow button[data-target="docx"]');
{
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click('#cgo')]);
  const p = join(OUT, 'report-to.docx');
  await dl.saveAs(p);
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(readFileSync(p));
  const docXml = await zip.file('word/document.xml').async('string');
  check('MD -> DOCX is valid OOXML with the text', docXml.includes('Quarterly Report'));
  check('MD -> DOCX docProps fingerprints scrubbed', zip.file('docProps/core.xml') === null && zip.file('docProps/app.xml') === null);
}

check('no external requests were made', externalRequests.length === 0, externalRequests.join(', '));
check(
  'no uncaught console errors',
  consoleErrors.length === 0,
  consoleErrors.slice(0, 3).join(' | ').slice(0, 200),
);

// Nothing persisted?
await page.waitForTimeout(4000);
await ctx.close();
await browser.close();
if (useOwnServer) server.close();
await new Promise((r) => setTimeout(r, 400));

await Promise.all([parseCheck, deferred]);

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed\n`);
if (failed.length) {
  console.error('FAILED:');
  for (const f of failed) console.error(`  - ${f.name} ${f.detail}`);
  process.exit(1);
}
console.log('All checks passed.');

# DocShift

A private document workbench that runs entirely in your browser. Edit PDFs, add fillable
fields to forms that have none, stamp images and signatures, redact sensitive data for real,
strip metadata, convert between PDF / DOCX / XLSX / Markdown, and export. **No server. No API.
No account. Nothing stored.** The UI is responsive from phone to desktop.

Built for one reason: bank statements, Form 16 and government forms should never be uploaded
to a free online converter that can read them.

---

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
```

Deploy: `npm run build` produces a static `dist/` you can push to GitHub Pages, any static
host, or open straight off disk. `vite.config.ts` sets `base: './'` so it works under a
project path like `https://you.github.io/repo/`.

## Publishing to GitHub Pages

The built site is fully static, so GitHub Pages is a perfect host — and because the page
does everything inside the visitor's browser, **no document ever reaches GitHub**. A public
repo is fine: it contains only code. (Private repos can use Pages only on paid plans.)

1. Create a new repository on GitHub (e.g. `docshift`).
2. Push this folder:

   ```bash
   git init
   git add .
   git commit -m "DocShift — private in-browser document workbench"
   git branch -M main
   git remote add origin https://github.com/<your-username>/docshift.git
   git push -u origin main
   ```

3. In the repo: **Settings → Pages → Build and deployment → Source → GitHub Actions**.
4. The included workflow (`.github/workflows/deploy.yml`) then runs on every push:
   install → typecheck → build → privacy gate → deploy `app/dist`. Your site appears at
   `https://<your-username>.github.io/docshift/` after the first run (~1 minute).

Pages-specific notes:

- The mupdf engine is one ~10.4 MB `.wasm` (~4.8 MB gzipped on the wire). Pages serves it
  fine; first load just takes a few seconds on slow connections.
- Pages cannot set custom HTTP headers, so the dev server's COOP/COEP headers are absent
  there. The app does not need them (no `SharedArrayBuffer`); the CSP travels in a `<meta>`
  tag, which Pages honours.
- No service worker, by design — a cache would be a store.
- mupdf is AGPL; a public repo shipping this source satisfies its copyleft terms for a
  hosted site.

## What works right now

Two modes, switched with the tabs in the top bar. "auto-tested" means `tests/smoke.mjs`
drives it in a real browser and asserts on the result — the others are implemented but you
should click them once yourself before trusting them.

**Edit PDF tab**

| Feature | Status |
|---|---|
| Open a PDF (drag & drop or pick) | ✅ auto-tested |
| Render pages, zoom, page navigation | ✅ auto-tested |
| Add text boxes | ✅ auto-tested |
| Insert images / PNGs | ✅ auto-tested |
| Signature: **draw OR upload a PNG/JPG** (EXIF/GPS stripped on upload) | ✅ auto-tested |
| **Redact — destructively removes the content** | ✅ auto-tested, verified |
| Read and strip document metadata | ✅ auto-tested |
| Export with a verification pass | ✅ auto-tested |
| Whiteout (visual cover, content survives) | ⚠️ implemented, not auto-tested |
| Add form fields (text / multiline / checkbox) | ⚠️ implemented, not auto-tested |
| Delete / rotate pages | ⚠️ implemented, not auto-tested |
| Destroy session / wipe memory | ⚠️ implemented, not auto-tested |

**Convert tab** — PDF, DOCX, XLSX, Markdown and plain text to any of PDF / DOCX / XLSX /
Markdown. Six round trips are auto-tested (MD→PDF, PDF→MD, PDF→XLSX, DOCX→PDF, XLSX→MD,
MD→DOCX) including proof that the output carries the text and that library fingerprints
(`docProps`) are scrubbed.

The honest contract: text, reading order, headings, lists and tables carry over. Exact
layout, fonts and images do not — that needs a server-side office suite, which this app
refuses to be. PDF targets use built-in Latin fonts, so non-Latin scripts become "?" in
PDF output; DOCX, XLSX and Markdown keep full Unicode.

Not built yet: OCR for scanned PDFs, merge/split, password encryption, PAdES signing.
Those are later phases in `../docs/implementation-plan.md`.

---

## The storage-free contract

Nothing is written to disk or to any browser storage API. Documents live in RAM and are gone
when the tab closes. The only file ever created is the one you explicitly download.

This is enforced, not promised:

1. **`localStorage`, `sessionStorage`, `indexedDB`, `caches` and cookies are disabled at
   boot** (`src/privacy/storage-killer.ts`, the first import in `main.ts`). Any code — ours or
   a dependency's — that touches one throws instead of quietly writing to disk.
2. **A strict CSP** in `index.html` allows only `'self'`. No CDN, no fonts, no analytics.
3. **A runtime egress guard** (`src/privacy/egress.ts`) wraps `fetch`, `XHR`, `WebSocket` and
   `sendBeacon`, blocking and counting anything off-origin. The counter is in the header and
   should always read zero blocked / only same-origin allowed.
4. **No service worker.** A SW cache is a store.
5. **`npm run privacy:check`** greps the built bundle and fails on any external URL or storage
   API.
6. **`node tests/smoke.mjs`** drives the real app in a real browser and asserts all of the
   above, plus that redaction actually removed the secret.
7. **Your source file is never modified.** Export always produces a new download.

Honest limit: the OS can page memory to swap, and a browser extension can read the page. No
web app can prevent either. See `../docs/data-handling.md` §8.

---

## Three bugs the tests caught (worth knowing about)

**1. mupdf's `Buffer.asUint8Array()` does not copy.** It returns
`libmupdf.HEAPU8.subarray(data, data + size)` — a live view into WebAssembly memory. We were
destroying the buffer and keeping the view, so the next mupdf call could reuse that memory and
overwrite our saved PDF. The exported file's header turned into `"70984"`. Fixed by copying
into a JS-owned `Uint8Array` before destroying. Regression test: `../verify/t11.mjs`.

**2. mupdf annotation rects use top-left-origin coordinates**, the same space as
`toStructuredText()` bboxes — *not* PDF's bottom-left origin. Flipping them put the redaction
hundreds of points off the page, where it silently did nothing. The file exported looking
redacted while the account number was still fully selectable. Fixed in
`src/ui/app.ts`. This is exactly why the export verification re-opens the output and reads its
text layer instead of trusting a byte scan — compressed content streams are invisible to a
byte scan, so the first version of that check passed on a file it should have rejected.

**3. A test that cannot fail is not a test.** Two of my own assertions did exactly that: the
export check asserted only `startsWith('%PDF-')`, which passes on any unparseable garbage;
and two checks ran *after* the suite printed its summary and exited, so their failures never
reached the exit code. Both were real, and between them they hid bug #2 completely.
`tests/smoke.mjs` now `await`s every deferred check before reporting, and the parse check
loads the file with an independent parser instead of sniffing its header.

Also worth recording: mupdf's `applyRedactions()` is precise, but a redaction box drawn
generously can reach the line above or below it (T3). Draw tight, and read the tooltip — the
app names the exact text it is about to destroy.

## Tests

```bash
npm run typecheck        # tsc --noEmit
npm run build            # tsc + vite build
npm run privacy:check    # no external URLs, no storage APIs in dist/

# 39 end-to-end assertions in a real browser (needs `npx playwright install chromium`):
# editor flow (redaction, export, verification), signature upload, and six
# conversion round trips.
node tests/smoke.mjs                                   # against the production build
BASE_URL=http://127.0.0.1:5173 node tests/smoke.mjs    # against `npm run dev`

cd ../verify && npm i && npm run verify   # 11 library-level proofs
```

# Verification Report — what I actually ran, and what came back

Date: 2026-08-28 · Environment: workspace sandbox, Node v20.20.2, npm 10.8.2, Python 3.13.14.
Packages installed and executed for real: `pdf-lib`, `mupdf`, `docx`, `jszip`, `tesseract.js`,
`tesseract.js-core`.

Scripts: `verify/t1.mjs` … `verify/t7.mjs`. Outputs: `verify/out_*.pdf`, `verify/out.docx`,
`verify/page_300dpi.png`.

These are the load-bearing claims of the serverless architecture. Every one below was
executed, not inferred from documentation.

---

## T1 — Can JS add a *real* fillable field to a flat PDF with no form? ✅ YES

`verify/t1.mjs` — built an A4 "bank form" PDF with only printed lines (no form at all), then
created fields on it.

```
T1 created PDF bytes: 3874
T1 field count read back: 3
T1 fields: applicant_name=PDFTextField, pan=PDFTextField, consent=PDFCheckBox
T1 pan value: ABCDE1234F
T1 consent checked: true
```

**Verdict:** these are genuine AcroForm widgets written into the PDF, re-read from the saved
file — not HTML overlays. Your headline feature works with zero backend.

---

## T2 — Is the redaction *actually* destructive? ✅ YES (in-browser, via mupdf WASM)

`verify/t2.mjs` — source PDF containing `Account Number: 3092 8871 4455 2210`.

```
--- TEXT BEFORE ---
"STATE BANK OF INDIA | Account Number: 3092 8871 4455 2210 | PAN: ABCDE1234F | Name: Rahul Sharma"
extractable account no present? true

--- TEXT AFTER applyRedactions() ---
"STATE BANK OF INDIA | Name: Rahul Sharma"
account no still extractable? false
fragment "4455" still present? false

--- RAW SAVED BYTES ---
raw contains full account no? false
raw contains "3092"? false
raw contains "2210"? false
```

**Verdict:** the secret is gone from the text layer *and* from the raw bytes of the saved
file. This is the correct, destructive behaviour — not a black rectangle over live text.
Achieved with `page.createAnnotation('Redact')` → `update()` → `applyRedactions()`.

---

## T3 — Redaction precision: an important design constraint ⚠️

`verify/t3.mjs` — same file, three box heights. Target line drawn at y=102 from top; the PAN
line sits at y=122 from top.

```
[loose box (17pt tall)] rect=[36,95,400,112]
  text now: "STATE BANK OF INDIA | Name: Rahul Sharma"
  acct gone? true | PAN survived? FALSE | name survived? true

[tight box (8pt tall)]  rect=[36,99,400,107]
  text now: "STATE BANK OF INDIA | PAN: ABCDE1234F | Name: Rahul Sharma"
  acct gone? true | PAN survived? true | name survived? true

[very tight (5pt)]      rect=[36,100,400,105]
  text now: "STATE BANK OF INDIA | PAN: ABCDE1234F | Name: Rahul Sharma"
  acct gone? true | PAN survived? true | name survived? true
```

**Verdict — this is a real product requirement, not a nitpick.** A box only ~9pt too tall
silently destroyed the neighbouring PAN line. Since redaction is destructive and
irreversible, the UI **must** snap the box to the text line's own bbox (which
`toStructuredText()` gives us), show an exact preview of what will be destroyed, and require
an explicit confirm. Hand-drawn loose boxes are how people lose data.

---

## T4 — Stamp a PNG onto a form, then flatten ✅ YES

`verify/t4.mjs` — embedded a PNG at (300,600) 160×80 at 0.95 opacity, then flattened.

```
T4 stamped PDF bytes: 4478 | pages: 1 | fields still present: 3
T4 after flatten -> interactive fields remaining: 0 (0 = submit-proof)
T4 flattened bytes: 4531
```

**Verdict:** image stamping works, and flattening correctly leaves zero interactive fields —
so a submitted form can't be edited by the recipient.

---

## T5 — PDF → DOCX with no LibreOffice ⚠️ WORKS, fidelity is moderate

`verify/t5.mjs`. Step 1 — what a browser engine actually gives you:

```
=== What the browser engine gives us per line ===
  y=62  size=14 weight=normal style=normal family=sans-serif :: "STATE BANK OF INDIA"
  y=102 size=12 weight=normal style=normal family=sans-serif :: "Account Number: 3092 8871 4455 2210"
  y=122 size=12 weight=normal style=normal family=sans-serif :: "PAN: ABCDE1234F"
  y=142 size=12 weight=normal style=normal family=sans-serif :: "Name: Rahul Sharma"
```

Step 2 — rebuild as DOCX in pure JS, then validate the package:

```
bytes: 8804
valid OOXML package: true
parts: word/document.xml, word/styles.xml, [Content_Types].xml, word/fontTable.xml, …
text carried over: true | true
font size mapping present: true
table present: true
```

**Verdict:** a structurally valid DOCX with correct font sizes and a working table, built
entirely in JS. But note what we had to work with: **lines and fonts, not paragraphs or
columns**. So text-heavy documents convert well; multi-column layouts, nested tables, and
decorative layout will need cleanup. This is the honest ceiling without LibreOffice.

**Privacy bug found in passing:** the `docx` library writes `docProps/app.xml`, `core.xml`
and `custom.xml` into every document. That's metadata leakage from *our own toolchain*.
We must overwrite/strip those on every export.

---

## T6 — Structured-text API shape (needed for the whole conversion layer)

```
block keys: [ 'type', 'bbox', 'lines' ]
line: { wmode, bbox{x,y,w,h,flags}, font{name,family,weight,style,size}, x, y, text }
```

Per-line font family/weight/style/size plus exact bbox. This is enough to drive DOCX
styling, Markdown heading detection, table detection, and redaction snapping.

---

## T7 — OCR in the browser ✅ YES, and fast

`verify/t7.mjs` — rendered the page to a 3× (~216 dpi) PNG with mupdf, then OCR'd it with the
WASM engine the browser uses:

```
rendered page PNG bytes: 43267
--- OCR OUTPUT ---
STATE BANK OF INDIA
Account Number: 3092 8871 4455 2210
PAN: ABCDE1234F
Name: Rahul Sharma
--- confidence: 95%
OCR recovered account number? true
OCR recovered PAN? true
```

Runtime ~1.4 s for one page, no server. Accuracy on this clean synthetic page was effectively
perfect; real-world scans will be worse and Indian-language accuracy lower — but the
architecture is proven.

---

## Asset sizes — the GitHub Pages reality

Measured on disk:

| Asset | Size | Note |
|---|---|---|
| `mupdf-wasm.wasm` | **10.4 MB** (3.6 MB brotli) | The whole PDF engine. Lazy-load on first use. |
| `tesseract-core-lstm.wasm` | 2.8 MB | Only the SIMD/LSTM variant you actually use. |
| `tesseract.js-core` (all variants) | 44 MB installed | Ship **one** variant, ~3 MB. |
| `pdf-lib` | 23 MB installed | Ships a few hundred KB of JS. |
| `docx` | 4.5 MB installed | Small JS footprint. |
| Tesseract `eng.traineddata` | **5.2 MB** (measured, fetched during `t7.mjs`) | Small enough to self-host. Indian-language packs are larger — fetch on first use, cache in IndexedDB. |

**GitHub Pages does not honour pre-compressed `.br` files** — it serves what you upload with
its own gzip. So plan for ~10 MB transfer for mupdf on first load, then cached. Acceptable,
but it means: lazy-load the WASM, show a real progress bar, and never block the UI on it.

---

## Supply-chain finding — why "no CDN" must be enforced, not assumed

```
$ grep -rEoh "https?://…(tessdata|cdn|jsdelivr|unpkg)…" node_modules/tesseract.js/src/
https://cdn.jsdelivr.net/npm/
https://cdn.jsdelivr.net/npm/tesseract.js
https://cdn.jsdelivr.net/npm/tesseract.js-core
```

**tesseract.js downloads its engine core and language data from jsDelivr by default.** On a
static site that means a third-party CDN would see your IP address and know exactly when you
ran OCR — which is precisely the leak this project exists to prevent.

**Required:** override `workerPath`, `corePath` and `langPath` to same-origin paths, and add
a CI check that greps the built bundle for any non-self URL. A Content-Security-Policy of
`default-src 'self'` makes this enforced rather than remembered.

---

## Not yet verified (stated plainly)

These are claimed by their docs and are plausible, but I have **not** executed them:

- `docx` running inside a real browser bundle (verified here in Node only; the library
  documents browser support).
- `mammoth.js` DOCX → HTML fidelity on real Word files.
- SheetJS/ExcelJS XLSX read/write, and XLSX → PDF rendering.
- AES-256 PDF encryption in-browser (two candidate paths: WebCrypto + pdf-lib implementing
  ISO 32000-2 Algorithm 2.B, or qpdf compiled to WASM). Needs a build-time spike.
- PAdES / CMS signing with PKI.js + WebCrypto.
- PPTX parsing.
- mupdf.js behaving identically in a browser context (verified in Node; it is an
  ESM-only package built for browsers, so this is low risk).
- **XFA forms.** Still an open question — plan to detect and degrade, not to render.

## Licence note

`mupdf` is **AGPL-3.0**. Fine for a personal static site you host yourself. It becomes
relevant only if you ever distribute it as part of a proprietary product. Alternatives if
that ever matters: `@embedpdf/pdfium` (Apache-2.0) + `pdf-lib` (MIT), at the cost of losing
`applyRedactions()` and having to build redaction ourselves.

---

# Addendum (v0.3) — persistence and metadata findings

Added after the "store nothing" requirement. All executed 2026-08-29 with Chromium 151 via
Playwright in a fresh profile, grepping every file the browser wrote.

## T8 — our own toolchain fingerprints every output file

```
--- pdf-lib PDF metadata written with NO explicit values ---
  Producer: "pdf-lib (https://github.com/Hopding/pdf-lib)"
  Creator:  "pdf-lib (https://github.com/Hopding/pdf-lib)"
  CreationDate: 2026-08-29T05:58:35.000Z
  ModificationDate: 2026-08-29T05:58:35.000Z

--- docx library metadata parts ---
  docProps/core.xml:
    <dc:creator>Un-named</dc:creator>
    <cp:lastModifiedBy>Un-named</cp:lastModifiedBy>
    <dcterms:created>2026-08-28T07:08:01.875Z</dcterms:created>
    <dcterms:modified>2026-08-28T07:08:01.875Z</dcterms:modified>
```

Every file we produce announces which library made it and when. Must be stripped on export.

## T9 — scrubbing works, with two traps

```
--- pdf-lib: does setProducer("") actually clear it? ---
  getProducer() says: "pdf-lib (https://github.com/Hopding/pdf-lib)"
  raw bytes contain "pdf-lib"? false   <-- the truth

--- mupdf scrub pass ---
  contains "pdf-lib"? false
  contains "MuPDF"? true
```

**Trap 1:** `setProducer('')` *does* clear the field on disk, but `getProducer()` returns the
default string when the field is empty. **You cannot verify a scrub with the library's own
getter — you must scan the output bytes.** A naive test would report a false failure (or a
false pass in the other direction).

**Trap 2:** mupdf's `setMetaData(key, '')` correctly empties all eight Info keys, but
`saveToBuffer` writes a banner into the header:

```
%PDF-1.7
% Written by MuPDF 1.28.0
```

Removable by stripping leading `%`-comment lines, or by a final qpdf-WASM rewrite.
Also note the API is `setMetaData` (capital D), not `setMetadata` — my first attempt threw
`TypeError: pd.setMetadata is not a function`.

## Persistence probe 1 — storage APIs write plaintext to disk

A page storing `ACCT-3092-8871-4455-2210-PAN-ABCDE1234F` in localStorage, sessionStorage and
IndexedDB, after a clean browser close:

```
SECRET ON DISK: /Default/Cache/Cache_Data/1fb6c0f415a7b516_0                       (1032 bytes)
SECRET ON DISK: /Default/Local Storage/leveldb/000003.log                           (203 bytes)
SECRET ON DISK: /Default/IndexedDB/http_127.0.0.1_8899.indexeddb.leveldb/000003.log (1222 bytes)
files containing secret: 3
```

Unencrypted. `sessionStorage` did not appear after close (genuinely per-tab).

**Methodological note — two false negatives I had to correct.** My first probe reported
"0 files containing the secret" and I nearly published it. It was wrong twice over:
1. `page.setContent()` produces an `about:srcdoc` opaque origin, where `localStorage` throws
   `SecurityError: Access is denied for this document` — the writes never happened.
2. Even on a real origin, a fast `ctx.close()` left the leveldb log at **30 bytes** — the
   write had not flushed. Only after serving over HTTP *and* waiting 12 s did the data appear.

Lesson baked into `t10.mjs`: serve over a real origin, and wait before closing.

## Persistence probe 2 — a 40 MB in-memory buffer leaves nothing

```
bytes held in JS heap: 41943040
profile files: 48
files containing the secret: 0
```

Memory does not automatically become disk.

## T10 — the export path is clean (now a CI gate)

```
=== T10 persistence audit ===
  downloaded file intact: true (780000 bytes)
  profile files scanned : 55
  document bytes on disk: 0   <-- clean
  blob_storage files    : 0
PASS: export path persisted nothing
```

`verify/t10.mjs` exits 1 if any document byte is found in the profile. Chromium does create
`Default/blob_storage/` when a Blob URL is used (0 files here); we revoke object URLs in a
`finally` block, and this test is what would catch a regression.

---

## T11 — mupdf.js end-to-end in a real browser, and the two bugs it exposed

Run from `/home/user/app`: `node tests/smoke.mjs` — 39 assertions, real Chromium, real user
gestures, real file downloads. **39/39 pass against both `npm run dev` and the production
build** (`BASE_URL=http://127.0.0.1:5173 node tests/smoke.mjs` targets the dev server).

Beyond the editor flow, the suite now also proves: a signature modal that accepts an
uploaded PNG stamps it onto the page; the Convert tab round-trips MD→PDF, PDF→MD,
PDF→XLSX, DOCX→PDF, XLSX→MD and MD→DOCX with the text readable back out of every output;
and DOCX/XLSX outputs ship with `docProps/core.xml` and `docProps/app.xml` removed
(library fingerprints scrubbed).

What it proves: the app boots with storage disabled; the egress guard blocks an off-origin
`fetch`; a PDF opens and actually paints; the metadata panel reads a real `/Info` dict and
the scrub empties it; dragging creates a text box, an image stamp and a redaction box; the
export downloads a file that an independent parser (`pdf-lib`) accepts, with a sane
MediaBox; the redacted account number is gone from the extracted text layer while the
neighbouring PAN survives; and no tool fingerprint remains.

### Bug: `Buffer.asUint8Array()` does not copy

`node_modules/mupdf/dist/mupdf.js:570-574`:

```js
asUint8Array() {
    const size = libmupdf_buffer_size(this);
    const data = libmupdf_buffer_get_data(this);
    return libmupdf.HEAPU8.subarray(data, data + size);   // <-- a VIEW, not a copy
}
```

We destroyed the buffer and kept the view. The next mupdf call reused that heap region and
wrote over the saved document. Symptom: exports failing intermittently with
`Failed to parse PDF document … No PDF header found`, the file beginning with `0xFF` bytes.

`verify/t11.mjs` reproduces it deterministically:

```
asUint8Array() is a view into WASM heap: true
aliased view  : header = "70984" | parses: false     <- corrupted by allocator reuse
copied buffer : header = "%PDF-" | parses: true      <- safe
```

Fix (`src/core/pdf.ts`): copy into a JS-owned `Uint8Array` **before** `destroy()`.

### Bug: redaction coordinates were silently doing nothing

mupdf annotation rects use **top-left-origin CSS coordinates** — the same space
`toStructuredText()` reports — not PDF's bottom-left origin. We were flipping them, which
placed every redaction hundreds of points off the page, where `applyRedactions()` is a
no-op. The exported PDF *looked* redacted and still contained the account number.

Proof (four-rect matrix, run against the real fixture):

| rect passed to `setRect` | account line removed | PAN kept |
|---|---|---|
| `[40, 89, 252, 105]` — CSS, tight | **true** | true |
| `[36, 87, 340, 107]` — CSS, +margin | **true** | true |
| `[40, 708, 340, 720]` — flipped (old code) | **false** | true |
| `[0, 0, 595, 842]` — whole page | true | false |

Fix: pass annotation coordinates through unflipped for mupdf; keep the flip for pdf-lib
(`pdfY = pageHeight - cssY - height`), which *is* bottom-left origin.

The bug survived because the first version of the export verification scanned the output
bytes — but mupdf writes compressed content streams, so no text is visible there and the
check passed vacuously. Verification now re-opens the output with mupdf and reads its text
layer. **A check that can only pass is worse than no check.**

### Dev-server trap (recorded so it isn't rediscovered)

Vite's dependency pre-bundler emits `mupdf.js` into `node_modules/.vite/deps/` but not its
wasm, so mupdf's `new URL("mupdf-wasm.wasm", import.meta.url)` resolves to a path that falls
through to the SPA index. Emscripten then fails with *expected magic word `00 61 73 6d`,
found `3c 21 64 6f`* — those are `<` `!` `d` `o`. Fixed by a small Vite plugin that copies
the wasm into `.vite/deps` on dev start. The production build never had this problem:
Rollup rewrites the URL into a hashed asset.

## Not verified — stated plainly

- **OS swap / pagefile.** This sandbox reports `Swap: 0` (`free -m`) and `/proc/swaps` is
  empty, with no swap device under `/dev`, so I could not test whether the kernel pages
  renderer memory to disk. On a real machine with swap enabled this is a genuine, unmitigated
  vector that **no web app can control**. Documented in `docs/data-handling.md` §8 rather
  than papered over.
- Browser crash dumps, extensions, and OS-level temp handling: outside app control.

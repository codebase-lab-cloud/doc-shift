# Decision Log — DocShift (v0.3, serverless + store-nothing)

Two constraints locked in by you:
1. **No server, no API (free or paid), no keys, no accounts** — static site on GitHub Pages.
2. **Store nothing** — no file, no details retained after the work is done.
A static web app pushed to GitHub and hosted on GitHub Pages. Anything below that needs a
backend or an API is marked ❌ and is out of scope.

Fill in the **DECISION** column.

| # | Decision | Recommendation | **DECISION** | Notes |
|---|---|---|---|---|
| D1 | Architecture | Static SPA on GitHub Pages, zero backend | **LOCKED by you** | |
| D2 | Frontend stack | React 18 + TypeScript + Vite | | |
| D3 | PDF engine | **mupdf.js** (AGPL) — has proven `applyRedactions()` | | Alternative: @embedpdf/pdfium (Apache), but we'd rebuild redaction |
| D4 | Form fields | pdf-lib (MIT) | **verified** | `verify/t1.mjs` |
| D5 | OCR | tesseract.js with self-hosted core + traineddata | **verified** | Must override jsDelivr defaults |
| D6 | DOCX write | `docx` npm | **verified in Node** | Browser bundle still to confirm |
| D7 | HTML/MD → PDF | Browser print pipeline primary; html2canvas+jsPDF as "quick & dirty" | | Print = real text; html2canvas = raster |
| D8 | ~~Encrypted vault~~ | **CUT by your store-nothing rule** | **RESOLVED** | Profiles/signatures become re-importable encrypted files |
| D8b | PWA service worker | **CUT** — a SW cache is a store | **RESOLVED** | Replaced by a downloadable offline bundle |
| D8c | OCR language cache | `cacheMethod: 'none'`, re-fetch from our origin | **RESOLVED** | Verified: default writes to IndexedDB |
| D9 | Repo public? | Public — lets others audit the zero-egress claim | | |
| D10 | WCAG accessibility workstream? | Yes, if that's what you meant | | |
| D11 | Optional Tauri desktop build | P2 — unlocks USB DSC tokens + watch folder | | Same codebase |
| D12 | Project name | DocShift | | |
| D13 | MVP cut | Phases 0–3 (viewer, editor, forms) | | ~5–8 weeks part-time |
| D14 | mupdf "% Written by MuPDF" banner | Strip leading `%`-comment lines on export | | Alt: qpdf-WASM rewrite |
| D15 | Metadata scrub verification | Scan output **bytes**, never trust `getProducer()` | **verified** | `verify/t9.mjs` |
| D16 | Persistence audit in CI | `verify/t10.mjs`, fails the build on any disk write | **verified** | |

## Cut because of the no-server / no-API rule

| Item | Reason |
|---|---|
| ❌ Aadhaar eSign | Requires a CCA-licensed ESP API. Inherently external. |
| ❌ USB DSC token signing | Browsers cannot reach PKCS#11 tokens. Needs the desktop build. |
| ❌ RFC 3161 timestamping | Needs a TSA network call. |
| ❌ LibreOffice-quality conversions | No LibreOffice in a browser. Fidelity is capped. |
| ❌ Watch folder / auto-convert | Needs a filesystem watcher = a backend. |
| ❌ Legacy .doc/.xls/.ppt | No browser library reads them. Reject with a clear message. |
| ❌ PDF/A conformance | Needs a full conformance engine. |
| ❌ Cloud sync / accounts | Contradicts the premise. |
| ❌ Local LLM via Ollama | Ollama is a local server. Replaced by optional transformers.js in-browser. |

## Still open / needs a build-time spike

- AES-256 PDF encryption in-browser (WebCrypto + ISO 32000-2 Alg 2.B, or qpdf-WASM).
  Fallback if it fails: an AES-GCM encrypted `.docshift` container instead of native PDF
  encryption — still useful, honestly labelled.
- PAdES / CMS signing with PKI.js + WebCrypto.
- XFA form handling — plan is detect + rasterise + overlay, never silent failure.
- `docx` inside a real browser bundle.

## Verified facts — persistence (executed 2026-08-29, Chromium 151 + Playwright)

- `localStorage` / IndexedDB write **plaintext** to the browser profile and it survives a
  clean close → the app must be structurally incapable of using them.
- A 40 MB in-memory buffer leaves **zero** bytes on disk.
- The in-memory → Blob → download → revoke export path leaves **zero** document bytes on
  disk (`verify/t10.mjs`, now a CI gate that exits 1 on any leak).
- `tesseract.js` caches `.traineddata` to IndexedDB unless `cacheMethod: 'none'`.
- pdf-lib stamps `Producer`/`Creator`/dates into every PDF; `setProducer('')` clears it on
  disk but `getProducer()` lies about it — verify against raw bytes.
- mupdf clears all eight Info keys but writes a `% Written by MuPDF 1.28.0` banner.
- `docx` writes `docProps/core.xml`, `app.xml`, `custom.xml` with creator + timestamps.
- **Could not test:** OS swap (sandbox has `Swap: 0`). Honest gap, documented.

## Verified facts (executed 2026-08-28, scripts in `verify/`)

- Adding a real AcroForm text field + checkbox to a form-less PDF: **works** (`t1.mjs`).
- mupdf `applyRedactions()` removes the secret from the text layer **and** the raw saved
  bytes: **works** (`t2.mjs`).
- A redaction box ~9pt too tall silently destroys the neighbouring line: **confirmed**
  (`t3.mjs`) → the UI must snap to line bboxes and preview what will be destroyed.
- PNG stamping + flatten to zero interactive fields: **works** (`t4.mjs`).
- PDF → valid DOCX with correct font sizes and a table, no LibreOffice: **works**, fidelity
  moderate (`t5.mjs`). Also found: `docx` injects `docProps/app.xml` metadata we must strip.
- In-browser OCR: 95% confidence, ~1.4 s/page, recovered account number and PAN (`t7.mjs`).
- `mupdf-wasm.wasm` = 10.4 MB (3.6 MB brotli); tesseract core ~2.8 MB.
- **tesseract.js fetches its core and language data from `cdn.jsdelivr.net` by default** —
  must be overridden, and CI must grep the bundle for external URLs.

## Environment (verified)

Node v20.20.2 · npm 10.8.2 · Python 3.13.14 · OpenJDK 11.
LibreOffice / Tesseract CLI / Pandoc / qpdf / Ghostscript / Docker: absent — and under this
architecture, none are required.

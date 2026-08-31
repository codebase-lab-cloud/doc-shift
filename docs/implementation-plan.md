# DocShift — Private Document Workbench
## Implementation Plan v0.3 — **fully client-side, no server, no API, free forever**

> **v0.3 adds the "store nothing" constraint** — see `docs/data-handling.md`. It cut the
> encrypted vault, the profile/signature storage, the PWA service worker, and IndexedDB OCR
> caching. All four were recommendations of mine that contradicted your requirement.
>
> **v0.2 superseded v0.1.** Your constraint changed the architecture completely: no backend,
> no Docker, no paid or free APIs, no keys, no accounts. Just a static web app you push to
> GitHub and host on GitHub Pages.
>
> **The good news:** I re-verified the load-bearing assumptions by actually running the
> libraries, and the plan survives. Everything you asked for — edit a PDF, add fillable text
> boxes, stamp a PNG, fill and sign forms — runs in the browser with zero backend. Evidence
> in `docs/verification-report.md`, scripts in `verify/`.
>
> **The honest news:** without a server you lose LibreOffice. That caps *conversion fidelity*
> for office formats, not the PDF features you care most about. Details in §4.

---

## 0. TL;DR

**Architecture:** a single static site. React + TypeScript + Vite, built to plain HTML/JS/WASM,
deployed to GitHub Pages. **Zero backend. Zero API calls. Zero CDN dependencies.** Every
byte of your document is processed inside the browser tab by WebAssembly, and never sent
anywhere.

**Verified working today** (executed, not assumed — see the verification report):

| Capability | Proof |
|---|---|
| Add a real fillable text field + checkbox to a flat PDF | `verify/t1.mjs` → 3 AcroForm widgets read back from the saved file |
| Destructive redaction (secret gone from text layer **and** raw bytes) | `verify/t2.mjs` → `raw contains "3092"? false` |
| Stamp a PNG onto a page, then flatten to submit-proof | `verify/t4.mjs` → 0 interactive fields after flatten |
| PDF → valid DOCX with correct fonts and tables, no LibreOffice | `verify/t5.mjs` → valid OOXML package, text + table present |
| In-browser OCR at 95% confidence, ~1.4 s/page | `verify/t7.mjs` → recovered account number and PAN |

**What costs you the most without a server:** PDF ↔ Office *fidelity*. You get "good, with
cleanup" instead of "near-original". Everything else — the editing, forms, images, signing,
redaction, OCR, encryption — is unaffected or nearly so.

**Effort to MVP** (Phases 0–3, §11): ~5–8 weeks part-time. Slightly *less* than v0.1, because
there's no server to build, secure, or containerise.

---

## 1. Feasibility check (re-run against the serverless constraint)

| # | Your requirement | Serverless? | Evidence / engine |
|---|---|---|---|
| 1 | Edit an opened PDF | ✅ | mupdf.js WASM + pdf-lib; overlay/replace modes |
| 2 | Fill an existing PDF form | ✅ | pdf-lib / mupdf form widgets |
| 3 | **Add a text box / new field where none exists** | ✅ **proven** | `t1.mjs`: `createTextField()` on a form-less PDF |
| 4 | **Stamp a PNG/JPG onto a form** | ✅ **proven** | `t4.mjs`: `embedPng` + `drawImage`, then `flatten()` |
| 5 | Sign (drawn / typed / image) | ✅ | Canvas → PNG → stamp |
| 6 | Redact PAN / account number *for real* | ✅ **proven** | `t2.mjs`: `applyRedactions()`, verified against raw bytes |
| 7 | OCR a scanned statement | ✅ **proven** | `t7.mjs`: tesseract.js WASM, 95%, 1.4 s |
| 8 | PDF → Word | ⚠️ works, moderate fidelity | `t5.mjs`: valid DOCX, but lines-not-paragraphs |
| 9 | PDF → Excel | ⚠️ works for tables | vector-line detection → ExcelJS; needs OCR for scans |
| 10 | Word/Excel → PDF | ⚠️ weakest link | mammoth→HTML then print-to-PDF, or html2canvas+jsPDF (raster) |
| 11 | PDF → Markdown | ✅ good | structured text + heading/table heuristics |
| 12 | Encrypt with a password | ⚠️ needs a spike | WebCrypto + ISO 32000-2 Alg 2.B, or qpdf-WASM. **Not yet verified.** |
| 13 | No third party ever sees your Form 16 | ✅ **best possible** | Nothing is sent anywhere — there is nowhere to send it |

### What genuinely gets worse with no server

1. **Office-format fidelity.** No LibreOffice means no real layout engine for DOCX/XLSX/PPTX.
   `mammoth.js` gives clean *semantic* HTML (headings, lists, tables, images) but discards
   visual layout. Converting that to PDF means either the browser's print pipeline (good
   quality, but a manual "Save as PDF" step) or html2canvas + jsPDF (automatic, but the text
   becomes an image — bad). **This is the single biggest quality loss. Accept it or plan for
   the print-to-PDF UX.**
2. **OCR speed.** WASM Tesseract is several times slower than native, and the browser has one
   thread for it. A 50-page scan is a coffee, not a blink.
3. **Memory.** A browser tab realistically handles ~100–300 MB of PDF. A 900-page document
   needs page-range chunking.
4. **No true PDF/A conformance**, no real reflow editing, no dynamic XFA. (These were already
   hard in v0.1.)

### What gets *better* with no server

- **The privacy claim becomes absolute.** There is no server that could log your file. Not
  "we promise we delete it after 1 hour" — there is nowhere for it to go.
- **No attack surface.** No exposed service, no auth to get wrong, no container escape.
- **Free forever.** GitHub Pages hosting costs nothing. No API metering.
- **Works offline** as a PWA once cached — including on a plane, or with Wi-Fi deliberately off.
- **You can fork and host it yourself**, or even open it from `file://`, and it still works.

---

## 2. The privacy contract (this is the product)

Since there's no server, the privacy promise is unusually strong — but only if we enforce it
rather than assume it. **The verification report already caught one leak:**

> `tesseract.js` downloads its WASM core and language data from `cdn.jsdelivr.net` by
> default. On a static site that means jsDelivr sees your IP and knows you just ran OCR.

So the rules are:

1. **Zero external requests. Ever.** Not for fonts, not for WASM, not for language data, not
   for analytics, not for error reporting. Everything is bundled in the repo and served from
   your GitHub Pages origin.
2. **`workerPath` / `corePath` / `langPath` overridden** to same-origin paths for
   tesseract.js (and audited for every other library that lazy-loads).
3. **CSP `default-src 'self'`** with no `connect-src` allowances, delivered via
   `<meta http-equiv>` (GitHub Pages can't set response headers without a `_headers`-style
   workaround) *and* enforced at build time.
4. **A service-worker egress guard** that intercepts every fetch and blocks anything not
   same-origin, surfacing it in the UI.
5. **A Network Monitor panel** showing a live counter. Target and expected value: **0**.
6. **A CI check** that greps the built bundle for `http://` / `https://` and fails the build
   on any non-self URL. This turns "remember not to add a CDN" into "you cannot add a CDN".
7. **A Privacy Receipt** per session: files processed, tools used, egress count (0), app
   version, dependency lockfile hashes. Downloadable, so the claim is auditable.
8. **No telemetry, no Sentry, no Google Fonts, no plausible/analytics.** Crash reports, if
   ever, are copy-paste-by-you only.

### Threat model (serverless edition)

| Threat | Answer |
|---|---|
| A SaaS provider sees your Form 16 | **Eliminated architecturally.** Nothing is transmitted. |
| A CDN sees your IP when you use the app | Eliminated by rules 1–6 above. **Note:** GitHub itself still sees that you loaded the page. See §9. |
| Malicious PDF executes code in your tab | Real risk. PDFs carry `/JavaScript`, `/OpenAction`, `/Launch`, embedded files. mupdf does not execute PDF JS; if we also use pdf.js we must set `isEvalSupported: false` (default-true was CVE-2024-34342). Strict CSP + pinned, patched engines. |
| A compromised npm dependency exfiltrates | Lockfiles, `npm audit`/`osv-scanner` in CI, SBOM, **and** the CSP + egress guard as the backstop. |
| Redaction that isn't real | Solved and *proven* (`t2.mjs`), plus the precision safeguard from `t3.mjs`. |
| Metadata leakage | Strip on export. **Including our own toolchain's** — `docx` writes `docProps/app.xml`/`core.xml` into every file (found during verification). |
| Browser extension reads the page | Cannot be prevented in a web app. Documented honestly; a Tauri desktop build (optional, later) removes it. |
| GitHub Pages itself | It sees page loads and asset requests, but **never your documents** — those never leave the tab. Still, if that bothers you, the same build runs from `file://` or a local static server. |

---

## 3. Format support matrix — serverless engines

Legend: 🟢 good · 🟡 usable, expect cleanup · 🔴 best-effort · ❌ not doing it

| From ↓ / To → | PDF | DOCX | XLSX | MD | HTML | TXT | PNG/JPG |
|---|---|---|---|---|---|---|---|
| **PDF** | — | 🟡 mupdf structured text → `docx` **(proven)** | 🟡 line-detection → ExcelJS; OCR for scans | 🟢 structured text + heading/table heuristics | 🟢 | 🟢 | 🟢 `toPixmap` |
| **DOCX** | 🟡 mammoth → HTML → print-to-PDF *(manual step)* or html2canvas+jsPDF *(raster)* | — | 🔴 | 🟢 mammoth/turndown | 🟢 mammoth | 🟢 | 🟡 |
| **XLSX** | 🟡 SheetJS → HTML table → PDF | 🟡 | — | 🟢 tables | 🟢 | 🟢 CSV | 🟡 |
| **PPTX** | 🔴 (outline → HTML → PDF only) | 🔴 | ❌ | 🟡 text+notes | 🟡 | 🟢 | 🟡 |
| **MD** | 🟢 marked → HTML → print-to-PDF | 🟢 | ❌ | — | 🟢 | 🟢 | 🟢 |
| **HTML** | 🟢 print-to-PDF | 🟡 turndown→docx | ❌ | 🟢 turndown | — | 🟢 | 🟢 |
| **TXT** | 🟢 | 🟢 | ❌ | 🟢 | 🟢 | — | 🟢 |
| **PNG/JPG** | 🟢 + optional OCR text layer **(proven)** | 🟡 via OCR | 🟡 via OCR tables | 🟡 via OCR | 🟡 via OCR | 🟡 via OCR | — |
| **Legacy .doc/.xls/.ppt** | ❌ **reject with a clear message** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |

**Legacy binary Office formats are out.** No browser library reads them, and pretending
otherwise would produce silent garbage. The app will detect the magic bytes and say plainly:
*"This is a legacy .doc file. No browser-only tool can read it reliably. Open it in Word or
LibreOffice and save as .docx, then come back."* That honesty is a feature.

### Engine choices

| Job | Library | Licence | Why |
|---|---|---|---|
| PDF render / text / **redact** / merge / split / metadata | **mupdf** (WASM) | AGPL-3.0 | `applyRedactions()` is the killer feature — proven destructive. Official Artifex build, air-gap friendly. |
| Form field **creation** + fill + flatten | **pdf-lib** | MIT | `createTextField()` on a form-less PDF — proven. |
| PDF viewing UX (optional) | pdf.js | Apache-2.0 | Only if we want its text layer/search UI. `isEvalSupported: false` mandatory. |
| OCR | **tesseract.js** + self-hosted core/traineddata | Apache-2.0 | Proven at 95%. Must override CDN paths. |
| DOCX write | **docx** | MIT | Proven valid OOXML output in pure JS. |
| DOCX read | mammoth.js | BSD | Semantic HTML from DOCX. |
| XLSX | SheetJS (xlsx) or ExcelJS | Apache/MIT | Read/write spreadsheets client-side. |
| MD ↔ HTML | marked + turndown | MIT | Tiny, reliable. |
| HTML → PDF | browser print pipeline (primary) / html2canvas+jsPDF (fallback) | — | Print gives real text; html2canvas gives raster. Offer both, label them. |
| Encryption | WebCrypto + ISO 32000-2 Alg 2.B **or** qpdf-WASM | — | **Spike required.** Not verified. |
| Local storage / vault | OPFS + IndexedDB, AES-GCM via WebCrypto | — | Key from Argon2id on a passphrase. |
| PII detection | regex + optional transformers.js (WASM/WebGPU) | Apache | Optional, opt-in, fully local. |

> **Licence flag:** mupdf is AGPL-3.0. Perfectly fine for a personal site you host. It only
> matters if you ever bundle it into a proprietary product. The fallback is
> `@embedpdf/pdfium` (Apache-2.0) + pdf-lib, but then we'd have to build redaction ourselves
> and lose the thing I proved works in `t2.mjs`.

---

## 4. Feature set, tiered

**P0 = MVP · P1 = v1.0 · P2 = later · P3 = probably never**

### 4.1 PDF editor (your core ask)
- **P0** Viewer: zoom, rotate, thumbnails, page nav, search, text selection/copy.
- **P0** Overlay text boxes — font, size, colour, alignment, multi-line, auto-fit.
- **P0** Shapes, highlight / underline / strike, freehand pen.
- **P0** **Whiteout** (doubles as manual redaction).
- **P0** **Insert image** — drag, resize, rotate, opacity, flip, crop, whiteout-underneath,
  **EXIF stripped by default** (phone photos carry GPS).
- **P0** Unlimited undo/redo via a serialisable **edit-stack**; original bytes never mutated
  until export.
- **P1** Replace existing text in place, with overflow warning.
- **P1** Page ops: delete, reorder, insert, crop, resize, N-up, split, merge, extract.
- **P1** Annotations that persist into the PDF (not HTML overlays).
- **P1** Watermarks, headers/footers, Bates numbering, page stamps.
- **P3** True reflow editing.

### 4.2 Forms (your other core ask)
- **P0** Auto-detect existing AcroForm fields → live inputs.
- **P0** **Drag to add a field**: text, multi-line, checkbox, radio, dropdown, date,
  signature, barcode. *(Proven in `t1.mjs`.)*
- **P0** Field properties: name, required, read-only, max length, font, colour, border,
  tooltip, validation (regex / numeric / date).
- **P0** **Fillable vs flattened export.** *(Proven: 0 fields after flatten.)*
- **P0** **Save data separately** as XFDF/JSON → keep one blank template, many datasets.
- **P0** **Profile autofill — session-only.** Import an encrypted `.dfprofile` file you keep
  yourself; it lives in memory for the session and is gone when the tab closes. **Nothing is
  stored between sessions.** See `docs/data-handling.md` §4.
- **P1** Duplicate/align/distribute, snap to grid, copy field style, tab order.
- **P1** XFA detection + honest fallback (rasterise + overlay, with a warning).
- **P2** Auto-field-detection from layout analysis (optional local model).

### 4.3 Signing
- **P0** Draw / type / upload signature; sign multiple pages; place by text search. Reuse via
  a user-kept `.dfsign` file re-imported per session — **no stored signature library**.
- **P1** **PAdES signing** with a local `.p12` via PKI.js + WebCrypto. Document never leaves
  the machine. *(Spike required — not verified.)*
- **P1** **Local signature verification with India's CCA roots bundled** — see §10.4. Pure
  static assets, no network.
- **P3** ~~Aadhaar eSign~~ — **dropped.** It requires a licensed ESP API, which violates your
  "no API" rule. Use a DSC token with a desktop signer for legally-strong signatures.
- **P3** RFC 3161 timestamping — needs network. Dropped.

### 4.4 Privacy & security tools
- **P0** Network Monitor + egress counter + Privacy Receipt (§2).
- **P0** Metadata inspector & scrubber, with before/after diff.
- **P0** **True redaction** with line-snapping, destructive preview, explicit confirm, and a
  **verification pass** that re-extracts text and refuses to export if the secret survives.
- **P0** **PII scan** with Indian presets: PAN, Aadhaar, account no., IFSC, UAN, GSTIN,
  email, phone, card number. One-click "redact all matches" → review → apply.
- **P0** **Sanitise PDF** — strip `/JavaScript`, `/OpenAction`, `/AA`, `/Launch`, embedded
  files, submit actions. Doubles as a malware-safety tool.
- **P1** AES-256 password protect / unprotect (own files).
- **P0** **Storage-free enforcement**: storage APIs disabled at boot, ESLint bans, CI grep,
  and the `verify/t10.mjs` persistence audit in CI. See `docs/data-handling.md` §6.
- **P0** Session panel: live inventory of what's in memory + **Destroy Session** button.
- ~~Encrypted vault~~ — **cut**; it is persistence by definition.
- **P2** Local audit log (no content, ever).

### 4.5 OCR & local intelligence (all optional, all offline)
- **P1** OCR with language picker (eng, hin, kan, tam, tel…), per-region re-OCR, confidence
  display. *(Proven.)* **`cacheMethod: 'none'`** — language data is re-fetched from our own
  origin each session and never written to IndexedDB.
- **P1** Searchable PDF — invisible OCR text layer under the scan.
- **P2** transformers.js (WASM/WebGPU) for PII NER and form-field suggestions. Opt-in,
  model cached locally.
- **P2** Form 16 / ITR-V / 26AS / GST parsers → CSV/XLSX/JSON (§10.1).

### 4.6 Quality of life
- **P0** Keyboard-first, drag-and-drop, no login, no telemetry, dark mode.
- **P1** **Offline bundle** (downloadable zip: HTML + JS + WASM + fonts + traineddata) instead
  of a PWA. **No service worker** — a SW cache is a store. No recent-files list either:
  a list of your files is a record of your files.
- **P1** Batch mode (drop 40 files → zip).
- **P2** Watch-folder is **impossible** without a backend — replaced by "drop a whole folder
  into the tab".

---

## 5. Architecture

```
┌────────────────────────── ONE BROWSER TAB ──────────────────────────┐
│                                                                     │
│  React + TypeScript + Vite  →  static files on GitHub Pages         │
│                                                                     │
│  ┌── Web Workers (keep the UI responsive) ────────────────────────┐ │
│  │  mupdf WASM worker    · render, text, redact, merge, metadata  │ │
│  │  pdf-lib worker       · create fields, fill, flatten, stamp    │ │
│  │  tesseract.js worker  · OCR (self-hosted core + traineddata)   │ │
│  │  convert worker       · docx / xlsx / md / html                │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                                                                     │
│  ┌── State ───────────────────────────────────────────────────────┐ │
│  │  edit-stack (JSON, serialisable)  · undo/redo · never mutates  │ │
│  │  the original bytes until Export                               │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                                                                     │
│  ┌── Privacy Guard ───────────────────────────────────────────────┐ │
│  │  CSP default-src 'self'  · SW egress interceptor  · counter UI │ │
│  │  build-time grep for external URLs  · Privacy Receipt          │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                                                                     │
│  ┌── Persistence: NONE ───────────────────────────────────────────┐ │
│  │  localStorage / sessionStorage / IndexedDB / OPFS / Cache API  │ │
│  │  and cookies are DISABLED AT BOOT and throw if touched.        │ │
│  │  No service worker. Memory only; gone when the tab closes.     │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                                                                     │
│  OUTBOUND NETWORK: none. Enforced by CSP + SW + CI.                 │
└─────────────────────────────────────────────────────────────────────┘
```

### Repo layout

```
docshift/
├── index.html
├── src/
│   ├── core/          # edit-stack, geometry, units, job runner
│   ├── pdf/           # mupdf worker bridge, pdf-lib ops, rendering
│   ├── tools/         # one module per tool: text, image, sign, redact, ocr, convert…
│   ├── forms/         # AcroForm model, field factory, XFDF codec, profiles
│   ├── privacy/       # egress guard, network monitor, receipt, metadata scrub,
│   │                  # storage-killer, persistence audit
│   ├── session/       # in-memory session state, teardown, Destroy Session
│   └── ui/
├── public/
│   ├── wasm/          # mupdf-wasm.wasm, tesseract core  ← self-hosted, NOT a CDN
│   ├── tessdata/      # eng.traineddata etc. (git-lfs or release assets, not in git)
│   └── fonts/         # Noto Sans/Devanagari subsets, self-hosted
├── tests/
│   ├── unit/
│   ├── golden/        # curated corpus incl. an adversarial redaction sample
│   ├── e2e/           # Playwright, run with the network namespace cut
│   └── privacy/       # asserts egress === 0; greps bundle for external URLs;
│                      # persistence audit (verify/t10.mjs) fails on ANY disk write
├── .github/workflows/ # lint, typecheck, test, audit, sbom, deploy to Pages
├── PRIVACY.md         # the auditable privacy contract
├── THREAT-MODEL.md
└── docs/
    ├── data-handling.md        # the "store nothing" contract
    ├── implementation-plan.md
    ├── verification-report.md  # evidence for every claim
    └── decisions.md
```

### GitHub Pages specifics (easy to get wrong)

- **Base path:** a project site lives at `https://<user>.github.io/<repo>/`, so every asset
  must be resolved from `import.meta.env.BASE_URL`. A leading `/wasm/...` will 404. This is
  the #1 cause of broken Pages deployments.
- **SPA routing:** Pages has no rewrites. Use hash routing, or add a `404.html` redirect shim.
- **No custom headers.** CSP must go in a `<meta http-equiv="Content-Security-Policy">` tag.
- **No pre-compressed assets honoured.** Plan for ~10 MB for mupdf on first load; lazy-load
  it behind a real progress bar.
- **Soft limits:** ~1 GB repo, ~100 GB/month bandwidth, 10 builds/hour. Fine for this.
- **`traineddata` files:** `eng.traineddata` measured at **5.2 MB** — small enough to
  self-host directly. Indian-language packs are larger, so fetch those on first use and cache
  them in IndexedDB; after that the app works fully offline.
- **WASM needs correct MIME.** Pages serves `.wasm` as `application/wasm`; fine, but verify
  with a real deploy early rather than at the end.
- **Public by default.** Anyone can read your source and use your instance. Your *documents*
  are still never transmitted. If you want it private, use a private repo with Pages (paid)
  or just clone and open it locally — which the build supports.

---

## 6. The three flows you described

### 6.1 Edit a PDF
```
Drop file → File API reads bytes into memory (no upload anywhere)
  → mupdf WASM worker renders pages + gives structured text with per-line font & bbox
  → pick a mode:
      OVERLAY  (default) new content on top; original untouched
      REPLACE  whiteout a text run, draw new text in its bbox; warn on overflow
      REFLOW   → export DOCX → edit in Word/LibreOffice → re-import
  → every action appended to the edit-stack (JSON, undoable)
  → Export: replay onto original bytes → optional flatten / scrub metadata / sanitise
  → Download. The file on your disk was never touched.
```

### 6.2 Fill a form, or add fields to one that has none
```
Drop file → detect:
   ├─ AcroForm  → render live inputs over each widget bbox
   ├─ XFA       → ⚠ "Dynamic XFA — we'll rasterise and let you overlay"
   └─ Flat      → "Add fields" mode: drag a box → choose type → name it → validate
                  → pdf-lib createTextField/createCheckBox/... (proven, t1.mjs)
                  → optional autofill from your Profile vault
Export:
   ├─ Fillable  → stays interactive for the next person
   └─ Flattened → baked in, 0 interactive fields (proven, t4.mjs)
Also: export data only as .xfdf / .json  → one blank template, many datasets
```

### 6.3 Stamp a PNG
```
Insert image → pick PNG/JPG (or paste from clipboard)
  → floating overlay: drag, corner-resize, rotate, opacity, flip, crop
  → "whiteout underneath" toggle  → "repeat on pages: all / range"
  → snap to existing field bboxes and page margins
  → EXIF/XMP stripped before embedding (GPS, device, timestamps)
Export → real image XObject in the page content stream (proven, t4.mjs)
```

---

## 7. Redaction: the safeguard that the testing forced on us

`verify/t3.mjs` produced a finding I did not expect and that changes the UI design:

```
[loose box (17pt tall)]  acct gone? true | PAN survived? FALSE
[tight box (8pt tall)]   acct gone? true | PAN survived? true
```

**A redaction box only ~9pt too tall silently destroyed the neighbouring line.** Since
redaction is irreversible, the design must be:

1. **Snap to the text line.** `toStructuredText()` gives the exact bbox of every line. The
   default action is "click a line to redact it", not "draw a rectangle".
2. **Freehand boxes are the fallback**, and they show a live list of every line they touch.
3. **Destructive preview**: "This will permanently delete: *Account Number: 3092…* — 1 line.
   Continue?" with the exact text shown.
4. **Post-export verification**: re-open the output, re-extract all text, assert none of the
   redacted strings survive, and **fail the export** if any do. Also scan the raw bytes.
5. **Kill the hidden OCR layer.** Scanned PDFs carry an invisible text layer under the image;
   a box over the image leaves it copy-pasteable. mupdf's `applyRedactions()` handles the
   content; we additionally strip the text layer and re-verify.
6. **Never incremental-save.** Always a full rewrite.
7. **Scrub metadata**: DocInfo, XMP, producer, author, paths, annotations, attachments,
   revision history — including the metadata *our own libraries* inject (`docx` writes
   `docProps/app.xml`).

---

## 8. India-specific layer (your differentiator)

### 8.1 Document parsers
Form 16 / ITR-V / 26AS / GST return → CSV, XLSX, JSON. Employer TAN, employee PAN, salary
heads, 80C/80D/80G/HRA deductions, tax paid, TDS rows, FY, acknowledgement number. Built on
mupdf structured text + per-layout rules, with an optional local model for odd layouts.
One-click "give me a copy with PAN and account number redacted" for sharing with a CA.

### 8.2 Redaction presets
| Field | Handling |
|---|---|
| PAN `ABCDE1234F` | full mask, or partial `XXXXX1234F` |
| Aadhaar | mask to last 4 — matches UIDAI's own display guidance; never store full |
| Bank account / IFSC | mask with configurable visible digits |
| Signature block | whiteout + destructive removal |
| UAN, EPF, GSTIN, voter ID, DL, address, phone, email | patterns + optional NER |

### 8.3 Signing, precisely
| Method | Valid in India? | Document leaves your machine? | In this app? |
|---|---|---|---|
| Electronic signature (drawn/typed image) | Yes, for most private contracts under the IT Act 2000; weaker evidentiary weight | **No** | ✅ P0 |
| DSC (Class 3) on a USB token | Yes, full digital signature | **No** — but a *browser* cannot reach a USB token (no WebCrypto PKCS#11) | ⚠️ **Not possible in a pure web app.** Needs the optional desktop build. |
| PAdES with a local `.p12` file | Yes | **No** | ✅ P1 (spike required) |
| Aadhaar eSign (via licensed ESP) | Yes, IT Act §3A | **Yes** — hash + identity go to the ESP | ❌ **Dropped.** Violates "no API". |

### 8.4 Local CCA signature verification — the missing feature everywhere
Acrobat, Chrome and macOS Preview don't ship India's CCA root certificates, so perfectly
valid signatures on e-Aadhaar, PAN, Form 16, ITR-V and GST returns display as **"Signature
Not Verified"**. We bundle the CCA root store as static assets and verify the chain locally —
signer name, issuer, validity, whether the document changed after signing, signing time.
**Fully offline, zero API.** Small feature, high perceived value, and I haven't seen it done
well anywhere.

---

## 9. Roadmap

| Phase | Scope | Est. | Exit criteria |
|---|---|---|---|
| **0. Foundations** | Vite + React + TS scaffold, WASM worker harness, **egress guard + CSP + Network Monitor + Privacy Receipt**, CI with the "no external URL" grep, deploy to Pages, PWA shell | 1 wk | Deployed site loads with the network tab showing zero non-self requests. Egress counter reads 0. |
| **1. Viewer + page ops** | Drop zone, magic-byte detection, mupdf render, search, thumbnails, merge/split/rotate/delete/reorder/extract, compress, image↔PDF, metadata inspector + scrubber, sanitise | 1.5 wks | 10 arbitrary PDFs, all page ops, zero egress. |
| **2. Editor MVP** ⭐ | Edit-stack + undo/redo, overlay text, shapes, highlight, pen, whiteout, **insert image** (resize/rotate/opacity/whiteout-under/EXIF strip), **signature draw/type/upload + library** | 2 wks | "Stamp a PNG on a form" works end to end and the output opens correctly in Acrobat. |
| **3. Forms MVP** ⭐ | AcroForm detect + fill, **drag to create fields**, properties + validation, profile vault, XFDF/JSON import-export, fillable vs flattened, XFA detect + fallback | 2 wks | Flat scanned bank form → add 8 fields → autofill from profile → flatten → verify in Acrobat. |
| **4. Redaction + privacy tools** | Line-snapped redaction with destructive preview, verification pass, PII scan + Indian presets, encryption spike | 1.5 wks | Redaction passes an adversarial test (hidden OCR layer + metadata + incremental save). |
| **5. Conversion** | PDF→DOCX (proven), PDF→XLSX, PDF→MD, MD/HTML→PDF, DOCX/XLSX→PDF via print pipeline, batch, **fidelity report** | 2 wks | Golden corpus converts with a published fidelity score per pair. |
| **6. OCR** | tesseract.js with self-hosted core + traineddata, language picker incl. Indian languages, searchable PDFs, per-region re-OCR | 1.5 wks | A scanned statement OCRs offline with zero egress; language data caches to IndexedDB. |
| **7. India pack** | Form 16 / ITR / 26AS / GST parsers, redaction presets, CCA signature verification, PAdES signing | 2 wks | Verify a real e-Aadhaar/Form 16 signature locally and show the full chain. |
| **8. Polish** | Golden regression suite, a11y pass, i18n (en/hi/kn), reproducible build, optional Tauri desktop | ongoing | — |

**MVP = Phases 0–3** (~5–8 weeks part-time) and it already delivers every feature you named.

---

## 10. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| A library silently fetches from a CDN | **High** — breaks the whole premise | Already caught one (tesseract.js → jsDelivr). CSP + SW guard + CI grep. Treat as a build failure. |
| Office-format fidelity disappoints | High | Fidelity report; label each converter with its tier; never claim parity with LibreOffice. |
| 10 MB WASM first load | Medium | Lazy-load, progress bar, cache-first SW, preload hint on hover. |
| Browser memory on huge PDFs | Medium | Page-range chunking, per-page processing, warn above a threshold. |
| OCR is slow in WASM | Medium | Set expectations in the UI; per-page progress; allow cancel. |
| Encryption spike fails | Medium | Fallback: an AES-GCM encrypted *container* (`.docshift` file) rather than native PDF encryption. Still useful, honestly labelled. |
| USB DSC tokens unreachable from a browser | Medium | Documented as a hard platform limit. Optional Tauri build solves it. |
| mupdf AGPL if you ever commercialise | Low | Swap to pdfium + pdf-lib; you'd rebuild redaction. |
| GitHub Pages availability/limits | Low | It's a static build — you can host it anywhere, or open it from disk. |
| Scope creep | High | The tier badge and the privacy contract are the filter. If a feature needs a server or an API, it's out. |

---

## 11. Open decisions

1. **Editor engine:** mupdf.js (AGPL, has proven `applyRedactions()`) vs
   @embedpdf/pdfium (Apache, we build redaction ourselves). **Rec: mupdf.js.**
2. **HTML/MD → PDF UX:** browser print pipeline (manual "Save as PDF", excellent quality,
   real text) vs html2canvas+jsPDF (one click, rasterised text). **Rec: print pipeline as
   primary, one-click as an explicit "quick & dirty" option.**
3. ~~Encrypted vault?~~ — **resolved by your "store nothing" requirement.** Nothing is
   persisted. Profiles/signatures become re-importable encrypted files (§4 of
   `docs/data-handling.md`).
4. **Is the repo public?** Public gives supply-chain credibility and lets others audit the
   "zero egress" claim. **Rec: public.**
5. **WCAG accessibility** — you said "accessibility check". Did you mean WCAG (screen
   readers, keyboard-only form filling, contrast, PDF/UA tagging on export)? If yes it
   becomes a real workstream, not a checkbox.
6. **Optional desktop build (Tauri)?** Same code, but it unlocks USB DSC tokens, watch
   folders, and removes the browser-extension threat surface. **Rec: P2, after the web app
   is solid.**
7. **Name.** DocShift / Kagad (कागद) / PaperlessLocal / OfflinePDF.

---

## 12. What I'd do next

1. You answer §11 (or say "go with your recommendations").
2. I write the **spec document** you mentioned submitting: per-feature specs, data models,
   the edit-stack schema, XFDF/profile formats, the fidelity-report definition, config,
   UI wireframes, acceptance criteria, test plan.
3. Then **Phase 0 gets built** — scaffold, WASM worker harness, egress guard, CSP, Network
   Monitor, Privacy Receipt, CI grep, first Pages deploy. The privacy contract becomes
   running code before a single feature exists.

I'd also suggest keeping `verify/` in the repo as a permanent regression suite. Those seven
scripts are the cheapest proof we have that the core claims hold; they should run in CI so a
dependency bump can't silently break redaction.

---

## Appendix A — what was verified vs assumed

**Executed and confirmed** (see `docs/verification-report.md` for full output):
adding AcroForm fields to a flat PDF · destructive redaction verified against raw bytes ·
redaction over-reach at 17pt box height · PNG stamping · flatten to zero fields ·
PDF→DOCX producing a valid OOXML package with correct fonts and a table · mupdf structured
text exposing per-line font family/weight/style/size · OCR at 95% confidence in ~1.4 s ·
mupdf WASM = 10.4 MB (3.6 MB brotli) · tesseract.js defaulting to `cdn.jsdelivr.net`.

**Assumed from documentation, NOT executed:** `docx` in a real browser bundle (verified in
Node) · mammoth.js fidelity · SheetJS/ExcelJS · AES-256 PDF encryption in-browser · PAdES
with PKI.js · PPTX parsing · mupdf.js in a browser context (Node only) · XFA handling.

**Environment facts (verified 2026-08-28):** Node v20.20.2, npm 10.8.2, Python 3.13.14,
OpenJDK 11 in the sandbox. LibreOffice, Tesseract CLI, Pandoc, qpdf, Ghostscript and Docker
are absent — and under this architecture, **none of them are needed**. That's the point.

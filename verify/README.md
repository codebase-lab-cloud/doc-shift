# DocShift verification suite

Executable proof for the claims the architecture rests on. Referenced throughout
`../docs/verification-report.md`. Nothing here is inferred from documentation — it was run.

    npm i
    npm run verify              # core capabilities (t1-t9)
    npm run verify:persistence  # the "stores nothing" audit (t10, needs Playwright)

| Script | Proves |
|---|---|
| `t1.mjs` | Adding a real AcroForm text field + checkbox to a PDF that has no form |
| `t2.mjs` | mupdf `applyRedactions()` removes the secret from the text layer *and* the raw bytes |
| `t3.mjs` | A redaction box ~9pt too tall destroys the neighbouring line → UI must snap to line bboxes |
| `t4.mjs` | PNG stamping, and flattening to zero interactive fields |
| `t5.mjs` | PDF → valid DOCX (fonts + table) with no LibreOffice |
| `t6.mjs` | The shape of mupdf's structured-text JSON, which the whole conversion layer depends on |
| `t7.mjs` | In-browser OCR: 95% confidence, ~1.4 s/page |
| `t8.mjs` | pdf-lib and docx inject tool identity + timestamps into every output file |
| `t9.mjs` | Metadata scrubbing works — and `getProducer()` lies, so you must verify raw bytes |
| `t10.mjs` | **The export path writes zero document bytes to disk.** Exits 1 on any leak. |

Run all of these in CI. If a dependency bump breaks redaction, `t2.mjs` fails. If a library
starts caching to IndexedDB, `t10.mjs` fails. You find out at build time, not after leaking
an account number.

`t10.mjs` needs a browser: `npm i -D playwright && npx playwright install chromium`.
`eng.traineddata` is gitignored — tesseract.js downloads it on first use.

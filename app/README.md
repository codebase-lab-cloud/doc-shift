# DocShift

A private document workbench that runs **entirely in your browser**. Edit PDFs, add form
fields, stamp images and signatures, redact for real, strip metadata, and convert between
PDF / DOCX / XLSX / Markdown. No server, no account, no uploads — close the tab and
everything is gone.

## Publish to GitHub Pages (no build needed)

The repo root **is** the finished website: `index.html` + `assets/` are already built.

1. Create a repo on GitHub (e.g. `docshift`) and push/upload **everything in this folder**.
2. In the repo: **Settings → Pages → Build and deployment → Source → "Deploy from a
   branch" → branch `main`, folder `/ (root)` → Save.**
3. Done. Your site is at `https://<your-username>.github.io/docshift/`.

That's all — no GitHub Actions, no commands on your machine.

## What's in the folder

```
index.html        ← the published page (this is what GitHub Pages serves)
assets/           ← the built app, including the PDF engine (mupdf wasm)
src/              ← the TypeScript source code (for future changes)
scripts/          ← privacy gate + the copy-to-root publish helper
tests/            ← the 39-check end-to-end suite
package.json      ← dev tools only; the hosted site never needs them
```

`src/`, `scripts/`, `tests/` and `package.json` ride along harmlessly — Pages only serves
`index.html` and `assets/` to visitors.

## Privacy contract

- No external requests, ever (enforced by CSP + a runtime egress guard).
- No localStorage / sessionStorage / IndexedDB / cookies / service worker (disabled at boot).
- Documents live in RAM only; the only file created is the one you download.
- Honest limit: the OS can page memory to swap — no web app can prevent that.

## Making changes (optional, for developers)

```bash
npm ci               # install dev tools
npm run dev          # live dev server at http://localhost:5173
npm test             # 39 end-to-end checks in a real browser
npm run build        # typecheck + build into dist/
npm run publish      # copy dist/ to the repo root (index.html + assets/)
npm run privacy:check
```

After changing code: `npm run build && npm run publish`, then push again — Pages updates.

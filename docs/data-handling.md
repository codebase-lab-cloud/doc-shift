# Data Handling Spec — "store nothing"

**Your requirement:** the app must not store any file or any details after the work is done.

This document defines exactly what that means, what is achievable, what is not, and how we
prove it. It **overrides** the following recommendations I made earlier, which contradicted
your requirement:

| Earlier recommendation | Now | Why |
|---|---|---|
| "Encrypted vault for profiles, signatures, templates" | ❌ **Cut** | It is persistence by definition |
| "Profile vault — save your details once, autofill everywhere" | ❌ **Cut** as stored state | Replaced by re-importable files (§4) |
| "Signature library, saved and reused" | ❌ **Cut** as stored state | Same replacement |
| "PWA + service worker for offline use" | ❌ **Cut** | A service worker cache *is* a store. Replaced by a downloadable offline bundle (§5) |
| "Cache OCR language data in IndexedDB" | ❌ **Cut** | Same. `cacheMethod: 'none'` (§3) |
| "Recent files / favourites" | ❌ **Cut** | Any list of your files is a record of your files |

---

## 1. The rule, stated precisely

> **The app performs zero writes to any persistent storage. Document bytes, filenames,
> extracted text, field values, and derived data exist only in JavaScript memory, and are
> gone when the tab closes.**

Two outputs are explicitly permitted, because they are *you* choosing to save something:

1. **The file you download** — lands in your Downloads folder, under your control.
2. **A profile file you explicitly export** — encrypted, saved by you, re-imported per
   session. Never read automatically. (§4)

Everything else: memory only.

---

## 2. What I verified about browser persistence (executed, not assumed)

I ran Chromium 151 via Playwright against a fresh profile and grepped every file the browser
wrote. Scripts: `verify/t10.mjs` (now in CI) and the probes described below.

### 2.1 The storage APIs **do** write your data to disk, in plaintext

A page that used `localStorage`, `sessionStorage` and IndexedDB to hold
`ACCT-3092-8871-4455-2210-PAN-ABCDE1234F` left it here, after the browser closed cleanly:

```
SECRET ON DISK: /Default/Cache/Cache_Data/1fb6c0f415a7b516_0                      (1032 bytes)
SECRET ON DISK: /Default/Local Storage/leveldb/000003.log                          (203 bytes)
SECRET ON DISK: /Default/IndexedDB/http_127.0.0.1_8899.indexeddb.leveldb/000003.log (1222 bytes)
```

**None of it was encrypted.** This is why "store nothing" cannot be a promise we merely try
to keep — the app must be *structurally incapable* of using these APIs (§6).

> Note: `sessionStorage` did **not** appear in the profile after close. It is genuinely
> per-tab. But we ban it anyway, for simplicity and because it still holds data mid-session.

### 2.2 A 40 MB in-memory buffer left **nothing** on disk

```
bytes held in JS heap: 41943040
profile files: 48
files containing the secret: 0
```

A `Uint8Array` filled with the marker, held for the whole session, produced zero matching
bytes anywhere in the browser profile. Memory does not automatically become disk.

### 2.3 The export path is clean — this is now a CI test

An app that keeps bytes in memory, makes a Blob, triggers a download, and revokes the URL:

```
=== T10 persistence audit ===
  downloaded file intact: true (780000 bytes)
  profile files scanned : 55
  document bytes on disk: 0   <-- clean
  blob_storage files    : 0
PASS: export path persisted nothing
```

`verify/t10.mjs` runs this exact scenario and **exits 1 if any document byte is found in the
profile.** That makes "stores nothing" a testable, enforced property rather than a slogan.
It must run in CI on every commit.

One artifact to note: Chromium created `Default/blob_storage/` (0 files) because we used a
Blob URL. We revoke object URLs in a `finally` block; if a future feature previews documents
via blob URLs, this audit is what catches a regression.

---

## 3. OCR language data — the sneaky one

`tesseract.js` caches `.traineddata` in **IndexedDB** by default. From its source:

```js
// src/worker-script/browser/cache.js
const { set, get, del } = require('idb-keyval');
module.exports = { readCache: get, writeCache: set, deleteCache: del, ... };

// src/worker-script/index.js
if (newData && ['write', 'refresh', undefined].includes(cacheMethod)) {
  await adapter.writeCache(`${cachePath || '.'}/${lang}.traineddata`, data);
}
```

So `cacheMethod` unset → **writes to IndexedDB** → language data persists on disk between
sessions.

**Required config:**
```js
createWorker(lang, 1, {
  workerPath: '/wasm/worker.min.js',      // NOT cdn.jsdelivr.net
  corePath:   '/wasm/',                    // NOT cdn.jsdelivr.net
  langPath:   '/tessdata/',                // same-origin
  cacheMethod: 'none',                     // <- no IndexedDB, no read, no write
});
```

**The tradeoff you're accepting:** with `cacheMethod: 'none'`, the ~5 MB English pack (and
~15-30 MB for Indian languages) is re-fetched from *your own GitHub Pages origin* on every
session. That's your server, not a third party, so privacy is intact — it just costs a few
seconds and some bandwidth. If that ever becomes annoying, the honest alternative is a
user-initiated "download language pack" button that saves a file *you* keep, re-imported per
session. Not automatic caching.

---

## 4. Replacing the features that needed storage

The genuinely useful features I'd recommended (autofill profiles, signature reuse,
templates) don't have to die — they just can't live in the browser.

**Pattern: export → you keep it → re-import per session.**

| Feature | Old (stored) | New (session-only) |
|---|---|---|
| "My details" autofill | IndexedDB vault | **Export** an encrypted `.dfprofile` file. **Import** it at the start of a session; it lives in memory; gone on close. |
| Signature library | IndexedDB | Same — a `.dfsign` file, or just paste/draw it each time. |
| Form templates | IndexedDB | You keep the blank PDF; nothing stored. |
| OCR language packs | IndexedDB cache | Re-fetch from your origin, or user-saved pack file. |

Encryption for those files: **AES-256-GCM**, key derived from your passphrase with
**Argon2id**, random 96-bit salt and IV per file, no key stored anywhere. The app can't read
the file without you typing the passphrase each session.

This is slightly less convenient than a vault. It is the price of a promise that actually
holds.

---

## 5. No service worker

A service worker exists to cache. Caching is storing. So: **no service worker, no cache
manifest, no `localStorage`-based settings.**

Offline use is replaced by something better for your threat model: a **self-contained
offline bundle** you can download once — a single `.zip` with `index.html` + JS + WASM +
fonts + `eng.traineddata`. Unzip, open `index.html`. No network, no server, no cache, and
GitHub never sees a page load. (Note: on `file://` the origin is opaque, so storage APIs are
blocked anyway — which happens to reinforce the rule.)

CI check: assert the build output contains no `serviceWorker.register` and no `sw.js`.

---

## 6. Enforcement — make it structurally impossible, not merely intended

Promises drift. Code that *cannot* do a thing doesn't.

1. **Kill the storage APIs at boot.** Before any other code runs:
   ```js
   for (const k of ['localStorage','sessionStorage','indexedDB','caches','openDatabase']) {
     try { Object.defineProperty(window, k, { configurable: false,
       get() { throw new Error('DocShift is storage-free: ' + k + ' is disabled'); } }); } catch {}
   }
   document.cookie = ''; Object.defineProperty(Document.prototype, 'cookie',
     { configurable: false, get: () => '', set: () => {} });
   ```
   Any library that tries to cache now throws loudly during development instead of silently
   writing to disk.

2. **ESLint `no-restricted-globals` / `no-restricted-syntax`** banning `localStorage`,
   `sessionStorage`, `indexedDB`, `caches`, `navigator.serviceWorker`, `showSaveFilePicker`.
   Fails the build.

3. **CI grep** over the built bundle for those identifiers and for any `http(s)://` URL that
   isn't same-origin. Fails the build.

4. **`verify/t10.mjs` persistence audit** in CI (§2.3). Fails the build if any document byte
   reaches the profile.

5. **No File System Access API write mode.** `showOpenFilePicker` returns read-only handles,
   but `showSaveFilePicker` / `createWritable` would let us overwrite your original file. We
   never call them. **The source file you open is never modified** — export always produces a
   new download.

6. **`beforeunload` / `pagehide` teardown:** zero out `Uint8Array`s (`.fill(0)`), drop
   references, revoke every outstanding object URL. Not a security guarantee (see §7), but it
   removes the obvious residue and keeps the tab's heap clean.

7. **No error reporting, no analytics, no crash dumps.** A stack trace containing a field
   value is a leak.

8. **Session panel in the UI:** a live inventory of what's currently in memory — filenames,
   page counts, number of fields — plus a **Destroy Session** button that wipes buffers and
   closes the tab. You can always see exactly what the app is holding.

---

## 7. Output hygiene — the leak I found in our own toolchain

"Store nothing" also means the *output file* shouldn't carry a fingerprint of you or of us.
Verified in `verify/t9.mjs`:

```
--- pdf-lib: does setProducer("") actually clear it? ---
  getProducer() says: "pdf-lib (https://github.com/Hopding/pdf-lib)"
  raw bytes contain "pdf-lib"? false   <-- the truth
```
pdf-lib sets a default `Producer`/`Creator` at creation (`this.setProducer(pdfLib)`), plus
`CreationDate`/`ModDate` = now. **Trap found:** `getProducer()` *lies* — it returns the
default string when the field is empty, so you cannot use it to verify the scrub. **Always
verify against the raw bytes.** Setting `setProducer('')` does clear it on disk.

```
--- mupdf scrub pass ---
  contains "pdf-lib"? false
  contains "MuPDF"? true
```
mupdf's `setMetaData(key, '')` (note the capital **D**) correctly empties
`/Title /Author /Subject /Keywords /Creator /Producer /CreationDate /ModDate` — but
`saveToBuffer` then writes a banner into the file header:

```
%PDF-1.7
% Written by MuPDF 1.28.0
```

So a mupdf-saved file announces which library produced it. Not your personal data, but it
*is* a fingerprint, and it's trivially removable by stripping leading `%`-comment lines
before output. Two options: (a) strip the comment lines, or (b) do a final structural
rewrite with qpdf-WASM. **Decision needed — I'd take (a), it's two lines.**

And from `verify/t8.mjs`, the `docx` library injects into every DOCX:
```xml
<dc:creator>Un-named</dc:creator>
<cp:lastModifiedBy>Un-named</cp:lastModifiedBy>
<dcterms:created>2026-08-28T07:08:01.875Z</dcterms:created>
<dcterms:modified>2026-08-28T07:08:01.875Z</dcterms:modified>
```
plus `docProps/app.xml` and `docProps/custom.xml`. Strip all three parts on export.

**Export rule:** every file this app produces gets a metadata-scrub pass — PDF Info dict, XMP
packet, mupdf banner, DOCX `docProps/*`, and EXIF/XMP on any embedded image (phone photos
carry GPS) — verified by scanning the output bytes, not by asking the library.

**Also strip on *input* display:** when we show you a PDF's metadata, that's a read. It never
gets logged or persisted.

---

## 8. What I cannot guarantee, stated honestly

A web page cannot control the operating system. These are real, and no browser app can fix
them:

| Vector | Status | Mitigation (yours, not the app's) |
|---|---|---|
| **OS swap / pagefile** | **Untested.** This sandbox has `Swap: 0`, so I could not verify it. In principle the kernel can page renderer memory to disk. | Linux: `swapfile` off or `vm.swappiness=0`; macOS: swap is always on but the file is protected; Windows: pagefile is on by default. Or use the offline bundle in a browser you trust. |
| **Browser crash dumps** | Outside app control | Disable crash reporting in browser settings |
| **Browser extensions** | Can read the page | Use a clean profile; or the offline bundle |
| **Your Downloads folder** | The file you asked for | Your responsibility |
| **RAM residue after close** | Freed but not zeroed by the OS | Reboot if genuinely paranoid |
| **Deleted-file recovery on SSD/disk** | N/A — we never write files | — |

I will not claim "provably zero bytes ever touch your disk", because that would be false and
you'd be relying on it. The honest claim is:

> **The application itself writes nothing to disk, and this is enforced in code and verified
> by an automated test on every build. What the operating system does with memory is outside
> any web app's control.**

---

## 9. Checklist for the spec document

Every feature spec must answer these before it's approved:

- [ ] Does it write to `localStorage` / `sessionStorage` / IndexedDB / OPFS / Cache API / cookies? → **must be no**
- [ ] Does it register a service worker? → **must be no**
- [ ] Does it create an object URL, and is it revoked in a `finally`? → **must be yes**
- [ ] Does it write metadata into the output, and is that stripped + byte-verified? → **must be yes**
- [ ] Does it log document content, filenames, or field values to console or anywhere? → **must be no**
- [ ] Does it send an error report containing data? → **must be no**
- [ ] Does it modify the user's source file? → **must be no**
- [ ] Does it survive `verify/t10.mjs`? → **must pass**

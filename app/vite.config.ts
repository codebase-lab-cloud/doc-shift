import { defineConfig, type Plugin } from 'vite';
import { copyFileSync, createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * mupdf's ESM entry locates its wasm with
 *     new URL("mupdf-wasm.wasm", import.meta.url)
 *
 * In a production build Rollup rewrites that into a hashed asset URL and all is
 * well. In DEV, Vite's dependency pre-bundler emits `mupdf.js` into
 * `node_modules/.vite/deps/` but does not copy the wasm there, so the URL
 * resolves to `.vite/deps/mupdf-wasm.wasm` — which 404s and falls through to the
 * SPA index, returning `text/html`. Emscripten then fails with
 * "expected magic word 00 61 73 6d, found 3c 21 64 6f" (that's `<!do`).
 *
 * A plain file copy into .vite/deps is not enough: after a fresh `npm ci` the
 * optimizer rebuilds that directory AFTER buildStart, deleting the copy. So we
 * also serve the wasm straight from node_modules through a middleware, which
 * wins over the SPA fallback regardless of what is on disk.
 */
function mupdfWasmForDev(): Plugin {
  return {
    name: 'docshift:mupdf-wasm-dev',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? '').split('?')[0];
        if (url.includes('.vite') && url.endsWith('/mupdf-wasm.wasm')) {
          const src = resolve(process.cwd(), 'node_modules/mupdf/dist/mupdf-wasm.wasm');
          if (existsSync(src)) {
            res.setHeader('Content-Type', 'application/wasm');
            res.setHeader('Cache-Control', 'no-store');
            createReadStream(src).pipe(res);
            return;
          }
        }
        next();
      });
    },
    buildStart() {
      const root = process.cwd();
      const src = resolve(root, 'node_modules/mupdf/dist/mupdf-wasm.wasm');
      const destDir = resolve(root, 'node_modules/.vite/deps');
      const dest = resolve(destDir, 'mupdf-wasm.wasm');
      if (!existsSync(src)) return;
      mkdirSync(destDir, { recursive: true });
      if (existsSync(dest) && statSync(dest).size === statSync(src).size) return;
      copyFileSync(src, dest);
      this.info?.('copied mupdf-wasm.wasm into .vite/deps for dev serving');
    },
  };
}

// base './' so the same build works at a GitHub Pages project path
// (https://user.github.io/repo/), at a custom domain, and from a local static server.
export default defineConfig({
  base: './',
  plugins: [mupdfWasmForDev()],
  // mupdf's ESM entry uses top-level await, so the dependency pre-bundler has to
  // target a browser that supports it. Without this `npm run dev` fails to start
  // even though the production build (target es2022) is fine.
  optimizeDeps: {
    esbuildOptions: { target: 'es2022' },
  },
  build: {
    target: 'es2022',
    assetsInlineLimit: 0, // never inline an asset as a data: URI we can't account for
    chunkSizeWarningLimit: 12000, // mupdf's wasm is ~10MB; that is expected, not a bug
  },
  server: {
    host: '0.0.0.0',
    strictPort: true,
    port: 5173,
    // The preview proxy serves this app under a generated host. We must accept it.
    allowedHosts: true,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      // Dev only: make sure neither the browser nor a preview proxy ever shows
      // a stale shell after a redesign.
      'Cache-Control': 'no-store',
    },
  },
});

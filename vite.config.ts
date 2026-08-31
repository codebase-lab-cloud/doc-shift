import { defineConfig, type Plugin } from 'vite';
import { createReadStream, existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The source tree lives in `src/` (so the repo root can stay the publishable
 * static site: index.html + assets/). Vite's root is therefore `src/`, and the
 * build lands in `../dist`, which `npm run publish` copies to the repo root.
 *
 * mupdf's ESM entry locates its wasm with
 *     new URL("mupdf-wasm.wasm", import.meta.url)
 * In a production build Rollup rewrites that into a hashed asset URL. In DEV,
 * the pre-bundled module looks for the wasm inside Vite's deps cache, which it
 * never copies — so we stream it straight from node_modules through a
 * middleware (which wins over any fallback, whatever is on disk).
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
  };
}

// base './' so the same build works at a GitHub Pages project path
// (https://user.github.io/repo/), at a custom domain, and from the repo root.
export default defineConfig({
  root: 'src',
  // keep Vite's dep cache with the other tooling, out of the source folder
  cacheDir: '../node_modules/.vite',
  base: './',
  plugins: [mupdfWasmForDev()],
  // mupdf's ESM entry uses top-level await, so the dependency pre-bundler has to
  // target a browser that supports it.
  optimizeDeps: {
    esbuildOptions: { target: 'es2022' },
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
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
      // Dev only: never let a browser or proxy show a stale shell.
      'Cache-Control': 'no-store',
    },
  },
});

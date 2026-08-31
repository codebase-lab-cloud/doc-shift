/**
 * pdf.ts — the mupdf WASM bridge. Rendering, text extraction, redaction,
 * metadata, page ops and saving all go through here.
 *
 * Everything runs inside this tab. There is no server to send anything to.
 */
import * as mupdf from 'mupdf';
import type { PageTextLine } from './state';

let doc: mupdf.PDFDocument | null = null;

export function isOpen(): boolean {
  return doc !== null;
}

export function open(bytes: Uint8Array): void {
  close();
  // Copy: mupdf takes ownership of the buffer, and we must keep the user's
  // original bytes untouched so export can start from them.
  doc = mupdf.Document.openDocument(bytes.slice(), 'application/pdf').asPDF();
}

export function close(): void {
  if (doc) {
    try {
      doc.destroy();
    } catch {
      /* already gone */
    }
    doc = null;
  }
}

function need(): mupdf.PDFDocument {
  if (!doc) throw new Error('No document is open.');
  return doc;
}

export function countPages(): number {
  return need().countPages();
}

export function pageSize(index: number): { width: number; height: number } {
  const page = need().loadPage(index);
  try {
    const [x0, y0, x1, y1] = page.getBounds();
    return { width: x1 - x0, height: y1 - y0 };
  } finally {
    page.destroy();
  }
}

const RENDER_CACHE = new Map<string, string>();

export function clearRenderCache(): void {
  RENDER_CACHE.clear();
}

/** Render a page to a data: URL (memory only) and cache it for the session. */
export function renderPage(index: number, scale: number): string {
  const key = `${index}@${scale}`;
  const hit = RENDER_CACHE.get(key);
  if (hit) return hit;
  const page = need().loadPage(index);
  try {
    const pixmap = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true);
    const png = pixmap.asPNG();
    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < png.length; i += CHUNK) {
      binary += String.fromCharCode(...png.subarray(i, i + CHUNK));
    }
    const url = `data:image/png;base64,${btoa(binary)}`;
    RENDER_CACHE.set(key, url);
    return url;
  } finally {
    page.destroy();
  }
}

type MuLine = {
  bbox: { x: number; y: number; w: number; h: number };
  text: string;
  font?: { size?: number };
};
type MuBlock = { type: string; lines?: MuLine[] };

/** Every text line with its box, in CSS coordinates (origin top-left, PDF points). */
export function textLines(index: number): PageTextLine[] {
  const page = need().loadPage(index);
  try {
    const parsed = JSON.parse(page.toStructuredText('preserve-whitespace').asJSON()) as {
      blocks: MuBlock[];
    };
    const out: PageTextLine[] = [];
    for (const block of parsed.blocks) {
      if (block.type !== 'text' || !block.lines) continue;
      for (const line of block.lines) {
        const text = line.text?.trim();
        if (!text) continue;
        const b = line.bbox;
        out.push({
          page: index,
          x: b.x,
          y: b.y,
          w: b.w,
          h: b.h,
          text,
          size: line.font?.size ?? 12,
        });
      }
    }
    return out;
  } finally {
    page.destroy();
  }
}

export function pageText(index: number): string {
  const page = need().loadPage(index);
  try {
    return page.toStructuredText('preserve-whitespace').asText();
  } finally {
    page.destroy();
  }
}

export function searchText(needle: string): { page: number; quads: unknown[] }[] {
  const hits: { page: number; quads: number[][][] }[] = [];
  const total = countPages();
  for (let i = 0; i < total; i++) {
    const page = need().loadPage(i);
    try {
      const found = page.search(needle);
      if (found && found.length) hits.push({ page: i, quads: found });
    } finally {
      page.destroy();
    }
  }
  return hits;
}

/**
 * Apply a destructive redaction. Verified in verify/t2.mjs: the text is removed
 * from the text layer AND from the raw bytes of the saved file — this is not a
 * black rectangle drawn over live text.
 */
export function applyRedaction(pageIndex: number, rect: [number, number, number, number]): void {
  const page = need().loadPage(pageIndex);
  try {
    const annot = page.createAnnotation('Redact');
    annot.setRect(rect);
    annot.update();
    page.applyRedactions();
  } finally {
    page.destroy();
  }
  // The rendered pixels no longer match the document.
  for (const key of [...RENDER_CACHE.keys()]) {
    if (key.startsWith(`${pageIndex}@`)) RENDER_CACHE.delete(key);
  }
}

export function deletePage(at: number): void {
  need().deletePage(at);
  clearRenderCache();
}

export function rotatePage(at: number, degrees: number): void {
  const page = need().loadPage(at);
  try {
    // mupdf exposes page rotation through the PDF page object
    page.setPageBox('CropBox', page.getBounds());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (page as any).setRotation?.(degrees);
  } finally {
    page.destroy();
  }
  clearRenderCache();
}

const META_KEYS = [
  'info:Title',
  'info:Author',
  'info:Subject',
  'info:Keywords',
  'info:Creator',
  'info:Producer',
  'info:CreationDate',
  'info:ModDate',
] as const;

export type MetadataMap = Record<string, string>;

export function getMetadata(): MetadataMap {
  const out: MetadataMap = {};
  const d = need();
  for (const key of META_KEYS) {
    const v = d.getMetaData(key);
    out[key.replace('info:', '')] = v ?? '';
  }
  return out;
}

export function scrubMetadata(): void {
  const d = need();
  for (const key of META_KEYS) {
    try {
      d.setMetaData(key, '');
    } catch {
      /* key not present */
    }
  }
}

export function save(): Uint8Array {
  const buf = need().saveToBuffer('garbage=2,compress=1,clean=1');
  // mupdf's Buffer.asUint8Array() does NOT copy — it returns
  // `libmupdf.HEAPU8.subarray(data, data + size)`, a live view into WebAssembly
  // memory. Freeing the Buffer (or letting any later mupdf call allocate over
  // that region) scribbles 0xFF over the bytes you think you are holding.
  // So copy into a JS-owned buffer BEFORE destroying anything.
  const view = buf.asUint8Array();
  const out = new Uint8Array(view);
  buf.destroy();
  return stripProducerBanner(out);
}

/**
 * mupdf writes "% Written by MuPDF <version>" into the file header. Verified in
 * verify/t9.mjs. It is not user data, but it is a fingerprint of our toolchain,
 * so we overwrite it in place with a same-length string — in place, because
 * shifting bytes would invalidate the cross-reference offsets.
 */
export function stripProducerBanner(bytes: Uint8Array): Uint8Array {
  const ASCII = new TextDecoder('latin1');
  const head = ASCII.decode(bytes.subarray(0, Math.min(bytes.length, 1024)));
  const match = /% Written by [^\r\n]*/.exec(head);
  if (!match || match.index === undefined) return bytes;

  // The replacement MUST be strictly shorter than what it replaces. Rewriting a
  // whole file to change the header is not an option: shifting bytes would
  // invalidate every cross-reference offset. But padding to the exact same
  // length is also wrong — it swallows the newline that terminates the comment,
  // gluing it to the next object and producing a file no reader can parse.
  // (That exact bug shipped once; tests/smoke.mjs now loads the output with a
  // real parser to prove it is well formed.)
  const budget = match[0].length - 1;
  if (budget < 1) return bytes;
  const label = '% Generated locally';
  const replacement = (label.length <= budget ? label : label.slice(0, budget)).padEnd(budget, ' ');

  const rep = new TextEncoder().encode(replacement);
  bytes.set(rep, match.index);
  return bytes;
}

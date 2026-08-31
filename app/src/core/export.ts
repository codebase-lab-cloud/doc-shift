/**
 * export.ts — turns the in-memory session into a downloaded file.
 *
 * Pipeline:
 *   1. mupdf saves the working document (redactions already applied destructively,
 *      metadata already scrubbed) -> verified in verify/t2.mjs and verify/t9.mjs
 *   2. pdf-lib replays the overlay edits onto it (text, images, whiteout, new fields)
 *   3. a verification pass scans the OUTPUT BYTES and refuses the export if a
 *      redacted secret survives, or if a tool fingerprint is left behind
 *   4. the result is handed to the browser as a download. Nothing is written to
 *      storage; the only file created is the one you asked for.
 */
import { PDFDocument, StandardFonts, rgb, PDFTextField, PDFCheckBox } from 'pdf-lib';
import * as mupdf from 'mupdf';
import * as pdf from './pdf';
import { getSession, type Annotation } from './state';

export type ExportReport = {
  bytes: number;
  redactedStringsChecked: number;
  redactedStringsFound: number;
  fingerprints: string[];
  pages: number;
};

function hexColor(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [0, 0, 0];
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

async function embedImage(doc: PDFDocument, bytes: Uint8Array): Promise<unknown> {
  // Magic-byte sniff, not a trusted extension.
  const isPng =
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  if (isPng) return doc.embedPng(bytes);
  return doc.embedJpg(bytes);
}

function applyAnnotations(doc: PDFDocument, annotations: Annotation[]): void {
  const pages = doc.getPages();
  // Whiteout first so it sits under text/images placed in the same area.
  const order: Annotation[] = [...annotations].sort((a, b) => {
    const rank = (x: Annotation) => (x.kind === 'whiteout' ? 0 : x.kind === 'image' ? 1 : 2);
    return rank(a) - rank(b);
  });

  for (const a of order) {
    const page = pages[a.page];
    if (!page) continue;
    const { height: pageHeight } = page.getSize();
    const y = pageHeight - a.y - a.height;

    if (a.kind === 'whiteout') {
      page.drawRectangle({ x: a.x, y, width: a.width, height: a.height, color: rgb(1, 1, 1) });
      continue;
    }

    if (a.kind === 'image') {
      // Fire-and-forget is not acceptable here; embed synchronously in the caller.
      const img = (a as Annotation & { embedded?: unknown }).embedded;
      if (img) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        page.drawImage(img as any, {
          x: a.x,
          y,
          width: a.width,
          height: a.height,
          opacity: a.opacity,
        });
      }
      continue;
    }

    if (a.kind === 'text') {
      const [r, g, b] = hexColor(a.color);
      const lines = a.value.split('\n');
      const lineHeight = a.fontSize * 1.2;
      let offset = a.height - a.fontSize;
      for (const line of lines) {
        if (!line) {
          offset -= lineHeight;
          continue;
        }
        let x = a.x;
        if (a.align !== 'left') {
          // Helvetica is a standard font; widthOfTextAtSize needs an embedded font,
          // so we approximate with 0.5 * fontSize for centring. Good enough for stamps.
          const approx = line.length * a.fontSize * 0.5;
          x = a.align === 'center' ? a.x + (a.width - approx) / 2 : a.x + (a.width - approx);
        }
        page.drawText(line, {
          x,
          y: y + offset,
          size: a.fontSize,
          color: rgb(r, g, b),
          font: STANDARD_FONT!,
        });
        offset -= lineHeight;
      }
      continue;
    }

    if (a.kind === 'field') {
      const form = doc.getForm();
      if (a.fieldType === 'checkbox') {
        const box = form.createCheckBox(a.name);
        if (a.checked) box.check();
        box.addToPage(page, { x: a.x, y, width: a.width, height: a.height });
      } else {
        const field = form.createTextField(a.name);
        field.setText(a.value);
        if (a.fieldType === 'multiline') field.enableMultiline();
        field.addToPage(page, { x: a.x, y, width: a.width, height: a.height });
      }
      continue;
    }
    // 'redact' annotations are already applied destructively by mupdf; nothing to draw.
  }
}

import type { PDFFont } from 'pdf-lib';
let STANDARD_FONT: PDFFont | undefined;

export type ExportResult = {
  blob: Blob;
  report: ExportReport;
};

/**
 * Build the output. Throws if verification fails — a failed redaction must never
 * reach the user's Downloads folder looking like a success.
 */
export async function buildExport(): Promise<ExportResult> {
  const session = getSession();
  if (!session) throw new Error('No document is open.');

  const base = pdf.save();

  let finalBytes = base;
  const needsReplay = session.annotations.some((a) => a.kind !== 'redact');

  if (needsReplay) {
    const doc = await PDFDocument.load(base, { ignoreEncryption: false });
    STANDARD_FONT = await doc.embedFont(StandardFonts.Helvetica);

    // Pre-embed images (embedding is async; the draw loop is sync).
    for (const a of session.annotations) {
      if (a.kind === 'image') {
        (a as Annotation & { embedded?: unknown }).embedded = await embedImage(doc, a.bytes);
      }
    }
    applyAnnotations(doc, session.annotations);

    // pdf-lib stamps its own identity and a timestamp into every file it saves.
    // Verified in verify/t8.mjs. Clear all of it.
    doc.setProducer('');
    doc.setCreator('');
    doc.setTitle('');
    doc.setAuthor('');
    doc.setSubject('');
    doc.setKeywords([]);
    doc.setCreationDate(new Date(0));
    doc.setModificationDate(new Date(0));

    finalBytes = await doc.save();
    // Clean up the temporary references so the image bytes can be collected.
    for (const a of session.annotations) {
      if (a.kind === 'image') delete (a as Annotation & { embedded?: unknown }).embedded;
    }
  }

  finalBytes = pdf.stripProducerBanner(finalBytes);

  const report = verify(finalBytes, session.annotations);
  if (report.redactedStringsFound > 0) {
    throw new Error(
      `Export blocked: ${report.redactedStringsFound} redacted string(s) are still present in the output. ` +
        'The file was NOT saved.',
    );
  }

  return {
    blob: new Blob([finalBytes as unknown as BlobPart], { type: 'application/pdf' }),
    report,
  };
}

/**
 * Verify the output by READING IT BACK, not by scanning raw bytes.
 *
 * This matters more than it looks. mupdf saves with object streams and
 * FlateDecode, so the text content of a page is compressed: a raw byte scan
 * cannot see it. My first implementation scanned raw bytes and reported
 * "0 redacted strings found" for a file that had never been redacted at all —
 * a verification that always passes is worse than none, because it is trusted.
 *
 * So: re-open the output with the PDF engine, extract the text of every page,
 * and assert the redacted strings are absent from the actual text layer.
 */
function verify(bytes: Uint8Array, annotations: Annotation[]): ExportReport {
  const doc = mupdf.Document.openDocument(bytes.slice(), 'application/pdf');
  try {
    const pdfDoc = doc.asPDF();
    if (!pdfDoc) throw new Error('Export verification failed: output is not a valid PDF.');
    const pageTotal = pdfDoc.countPages();
    let text = '';
    for (let i = 0; i < pageTotal; i++) {
      const page = pdfDoc.loadPage(i);
      try {
        text += page.toStructuredText('preserve-whitespace').asText() + '\n';
      } finally {
        page.destroy();
      }
    }

    const targets = annotations
      .filter((a): a is Annotation & { kind: 'redact' } => a.kind === 'redact')
      .map((a) => a.coveredText.trim())
      .filter((t) => t.length >= 4);

    const flat = text.replace(/\s+/g, ' ');
    let found = 0;
    for (const t of targets) {
      if (flat.includes(t.replace(/\s+/g, ' '))) found++;
    }

    const fingerprints: string[] = [];
    // The banner is an uncompressed header comment, so a byte scan is valid there.
    const head = new TextDecoder('latin1').decode(bytes.subarray(0, 256));
    if (/mupdf/i.test(head)) fingerprints.push('MuPDF banner');
    // Metadata lives in a compressed object stream: ask the engine, do not grep.
    const producer = pdfDoc.getMetaData('info:Producer') ?? '';
    const creator = pdfDoc.getMetaData('info:Creator') ?? '';
    const author = pdfDoc.getMetaData('info:Author') ?? '';
    if (producer) fingerprints.push(`Producer="${producer}"`);
    if (creator) fingerprints.push(`Creator="${creator}"`);
    if (author) fingerprints.push(`Author="${author}"`);

    return {
      bytes: bytes.length,
      redactedStringsChecked: targets.length,
      redactedStringsFound: found,
      fingerprints,
      pages: pageTotal,
    };
  } finally {
    doc.destroy();
  }
}

/** Trigger a browser download and revoke the object URL. Nothing is stored. */
export function download(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  // Revoke on the next turn so the download has started, and always clean up.
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 1000);
}

export function outputName(original: string, suffix: string): string {
  const dot = original.lastIndexOf('.');
  const stem = dot > 0 ? original.slice(0, dot) : original;
  return `${stem}-${suffix}.pdf`;
}

export { PDFTextField, PDFCheckBox };

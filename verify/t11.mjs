// T11 — mupdf Buffer.asUint8Array() aliases WASM memory. Regression test for the
// bug where we destroyed the Buffer and a later mupdf call overwrote our saved
// bytes with 0xFF, producing a file no reader could open.
import * as mupdf from 'mupdf';
import { PDFDocument, StandardFonts } from 'pdf-lib';

const doc = await PDFDocument.create();
const page = doc.addPage([595, 842]);
const font = await doc.embedFont(StandardFonts.Helvetica);
page.drawText('aliasing regression test', { x: 40, y: 700, size: 12, font });
const src = await doc.save();

const d = mupdf.Document.openDocument(new Uint8Array(src), 'application/pdf').asPDF();

const buf = d.saveToBuffer('garbage=2,compress=1');
const aliased = buf.asUint8Array();      // <-- a VIEW into WASM heap
const copied = new Uint8Array(aliased);  // <-- a real JS-owned copy
console.log('asUint8Array() is a view into WASM heap:', aliased.buffer.byteLength > aliased.length);
buf.destroy();

// Hammer the WASM allocator so the freed region is definitely reused.
for (let i = 0; i < 40; i++) {
  const p = d.loadPage(0);
  p.toStructuredText('preserve-whitespace').asText();
  const junk = d.saveToBuffer('garbage=2,compress=1');
  junk.asUint8Array();
  junk.destroy();
  p.destroy();
}

const head = (b) => String.fromCharCode(...b.subarray(0, 5));
const parses = async (b) => {
  try { return (await PDFDocument.load(b.slice())).getPageCount() === 1; } catch { return false; }
};

const aliasedOk = head(aliased) === '%PDF-';
const copiedOk = head(copied) === '%PDF-';
console.log('aliased view  : header =', JSON.stringify(head(aliased)), '| parses:', await parses(aliased));
console.log('copied buffer : header =', JSON.stringify(head(copied)), '| parses:', await parses(copied));

// The aliased view is EXPECTED to be destroyed — that is the bug being
// demonstrated. The copy must survive.
if (!aliasedOk) console.log('  ^ the aliasing hazard reproduced, as expected');
if (!copiedOk) { console.error('FAIL: copying did not protect the bytes'); process.exit(1); }
if (aliasedOk) console.log('note: allocator did not reuse the region this run (timing-dependent)');
console.log('PASS: copying before destroy survives allocator reuse');

import fs from 'fs';
import path from 'path';
import * as mupdf from 'mupdf';
import { createWorker } from 'tesseract.js';
const D = import.meta.dirname;

// Render a real page to an image with mupdf (this is what the browser would do)
const buf = fs.readFileSync(path.join(D, 'src.pdf'));
const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf');
const page = doc.loadPage(0);
const pix = page.toPixmap(mupdf.Matrix.scale(3, 3), mupdf.ColorSpace.DeviceRGB, false, true);
const pngBuf = pix.asPNG();
fs.writeFileSync(path.join(D, 'page_300dpi.png'), pngBuf);
console.log('rendered page PNG bytes:', pngBuf.length);

// Now OCR it with the WASM engine (same engine the browser uses)
const worker = await createWorker('eng');
const { data } = await worker.recognize(new Uint8Array(pngBuf));
console.log('--- OCR OUTPUT ---');
console.log(data.text.trim());
console.log('--- confidence:', Math.round(data.confidence) + '%');
console.log('OCR recovered account number?', data.text.includes('3092 8871 4455 2210'));
console.log('OCR recovered PAN?', data.text.includes('ABCDE1234F'));
await worker.terminate();

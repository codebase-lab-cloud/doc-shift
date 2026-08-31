import fs from 'fs';
import * as mupdf from 'mupdf';
const D = import.meta.dirname;
const buf = fs.readFileSync('/home/user/verify/src.pdf');
const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf');
const j = JSON.parse(doc.loadPage(0).toStructuredText('preserve-spans,preserve-whitespace').asJSON());
console.log('block keys:', Object.keys(j.blocks[1]));
console.log(JSON.stringify(j.blocks[1], null, 1).slice(0, 1200));

import fs from 'fs';
import path from 'path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import * as mupdf from 'mupdf';
const D = import.meta.dirname;

const doc = await PDFDocument.create();
const p = doc.addPage([595,842]);
const f = await doc.embedFont(StandardFonts.Helvetica);
p.drawText('x',{x:40,y:700,size:12,font:f});
doc.setProducer(''); doc.setCreator(''); doc.setTitle(''); doc.setAuthor('');
doc.setSubject(''); doc.setKeywords([]);
doc.setCreationDate(new Date(0)); doc.setModificationDate(new Date(0));
const cleaned = await doc.save();

console.log('--- pdf-lib: does setProducer("") actually clear it? ---');
const re = await PDFDocument.load(cleaned);
console.log('  getProducer() says:', JSON.stringify(re.getProducer()));
const rawClean = Buffer.from(cleaned).toString('latin1');
console.log('  raw bytes contain "pdf-lib"?', rawClean.includes('pdf-lib'), '<-- the truth');
console.log('  raw bytes contain "Hopding"?', rawClean.includes('Hopding'));

console.log('\n--- mupdf scrub pass (setMetaData, correct API) ---');
const d2 = mupdf.Document.openDocument(new Uint8Array(cleaned), 'application/pdf');
const pd = d2.asPDF();
for (const k of ['info:Title','info:Author','info:Subject','info:Keywords','info:Creator','info:Producer','info:CreationDate','info:ModDate']) {
  try { pd.setMetaData(k, ''); } catch (e) { console.log('  ', k, 'ERR', String(e).slice(0,60)); }
}
const out2 = pd.saveToBuffer('garbage=2,compress=1,clean=1').asUint8Array();
fs.writeFileSync(path.join(D,'out_scrubbed.pdf'), out2);
const raw = Buffer.from(out2).toString('latin1');
console.log('  contains "pdf-lib"?', raw.includes('pdf-lib'));
console.log('  contains "Hopding"?', raw.includes('Hopding'));
console.log('  contains "MuPDF"?', /mupdf/i.test(raw));
console.log('  size:', out2.length);

console.log('\n--- belt & braces: scrub the raw info dict directly via pdf-lib low-level ---');
const d3 = await PDFDocument.load(cleaned);
const info = d3.context.lookup(d3.context.trailerInfo.Info);
if (info) { for (const k of ['Producer','Creator','Title','Author','Subject','Keywords','CreationDate','ModDate']) {
  try { info.delete(require('pdf-lib').PDFName.of(k)); } catch {} } }
const out3 = await d3.save();
const raw3 = Buffer.from(out3).toString('latin1');
console.log('  contains "pdf-lib"?', raw3.includes('pdf-lib'), '<-- the truth');
console.log('  contains "Hopding"?', raw3.includes('Hopding'));
console.log('  size:', out3.length);

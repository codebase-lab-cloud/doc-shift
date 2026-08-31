import fs from 'fs';
import path from 'path';
import * as mupdf from 'mupdf';
const D = import.meta.dirname;

const pdf = `%PDF-1.7
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length 190>>stream
BT /F1 14 Tf 40 780 Td (STATE BANK OF INDIA) Tj ET
BT /F1 12 Tf 40 740 Td (Account Number: 3092 8871 4455 2210) Tj ET
BT /F1 12 Tf 40 720 Td (PAN: ABCDE1234F) Tj ET
BT /F1 12 Tf 40 700 Td (Name: Rahul Sharma) Tj ET
endstream
endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
trailer<</Root 1 1 R/Size 6>>
%%EOF`.replace('/Root 1 1 R', '/Root 1 0 R');
fs.writeFileSync(path.join(D, 'src.pdf'), pdf);

const buf = fs.readFileSync(path.join(D, 'src.pdf'));
const doc = mupdf.Document.openDocument(buf, 'application/pdf');
const pdfDoc = doc.asPDF();
const page = pdfDoc.loadPage(0);

const before = page.toStructuredText('preserve-whitespace').asText();
console.log('--- TEXT BEFORE ---');
console.log(JSON.stringify(before.trim()));
console.log('extractable account no present?', before.includes('3092 8871 4455 2210'));

const red = page.createAnnotation('Redact');
red.setRect([36, 95, 400, 112]);   // covers the "Account Number:" line
red.update();
page.applyRedactions();

const after = page.toStructuredText('preserve-whitespace').asText();
console.log('--- TEXT AFTER applyRedactions() ---');
console.log(JSON.stringify(after.trim()));
console.log('account no still extractable?', after.includes('3092 8871 4455 2210'));
console.log('fragment "4455" still present?', after.includes('4455'));

const out = pdfDoc.saveToBuffer('garbage=2,compress=1').asUint8Array();
fs.writeFileSync(path.join(D, 'out_redacted.pdf'), out);

const raw = Buffer.from(out).toString('latin1');
console.log('--- RAW SAVED BYTES ---');
console.log('raw contains full account no?', raw.includes('3092 8871 4455 2210'));
console.log('raw contains "3092"?', raw.includes('3092'));
console.log('raw contains "2210"?', raw.includes('2210'));
console.log('size in/out:', buf.length, '->', out.length);

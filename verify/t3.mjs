import fs from 'fs';
import path from 'path';
import * as mupdf from 'mupdf';
import { PDFDocument, rgb } from 'pdf-lib';
const D = import.meta.dirname;

const pdf = fs.readFileSync(path.join(D, 'src.pdf'));

function run(label, rect) {
  const doc = mupdf.Document.openDocument(new Uint8Array(pdf), 'application/pdf');
  const pd = doc.asPDF();
  const page = pd.loadPage(0);
  const r = page.createAnnotation('Redact');
  r.setRect(rect); r.update();
  page.applyRedactions();
  const t = page.toStructuredText('preserve-whitespace').asText();
  console.log(`\n[${label}] rect=${JSON.stringify(rect)}`);
  console.log('  text now:', JSON.stringify(t.trim().replace(/\n+/g, ' | ')));
  console.log('  acct gone?', !t.includes('3092'), '| PAN survived?', t.includes('ABCDE1234F'), '| name survived?', t.includes('Rahul'));
}

// A4 = 842 high. Account line drawn at y=740 (PDF bottom-up) => 102 from top. PAN at y=720 => 122 from top.
run('loose box (17pt tall)', [36, 95, 400, 112]);
run('tight box (8pt tall)',  [36, 99, 400, 107]);
run('very tight (5pt)',      [36, 100, 400, 105]);

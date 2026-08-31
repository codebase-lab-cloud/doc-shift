import fs from 'fs';
import path from 'path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import JSZip from 'jszip';
const D = import.meta.dirname;

// Does OUR OWN toolchain silently write identifying metadata into output files?
const doc = await PDFDocument.create();
const p = doc.addPage([595, 842]);
const f = await doc.embedFont(StandardFonts.Helvetica);
p.drawText('test', { x: 40, y: 700, size: 12, font: f });
const pdfBytes = await doc.save();
const re = await PDFDocument.load(pdfBytes);
console.log('--- pdf-lib PDF metadata written with NO explicit values ---');
console.log('  Title:', JSON.stringify(re.getTitle()));
console.log('  Author:', JSON.stringify(re.getAuthor()));
console.log('  Producer:', JSON.stringify(re.getProducer()));
console.log('  Creator:', JSON.stringify(re.getCreator()));
console.log('  CreationDate:', re.getCreationDate());
console.log('  ModificationDate:', re.getModificationDate());

const docxBytes = fs.readFileSync(path.join(D, 'out.docx'));
const zip = await JSZip.loadAsync(docxBytes);
console.log('\n--- docx library metadata parts (from t5.mjs output) ---');
for (const n of ['docProps/core.xml', 'docProps/app.xml', 'docProps/custom.xml']) {
  if (zip.file(n)) {
    const x = await zip.file(n).async('string');
    console.log(`  ${n}:`);
    console.log('    ' + x.replace(/></g, '>\n    <').split('\n').filter(l => /creator|Application|AppVersion|Company|Manager|TitlesOfParts|lastModifiedBy|created|modified/i.test(l)).join('\n    '));
  }
}

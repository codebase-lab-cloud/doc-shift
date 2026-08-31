import fs from 'fs';
import path from 'path';
import * as mupdf from 'mupdf';
import { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType, HeadingLevel } from 'docx';
import JSZip from 'jszip';
const D = import.meta.dirname;

const buf = fs.readFileSync(path.join(D, 'src.pdf'));
const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf');
const j = JSON.parse(doc.loadPage(0).toStructuredText('preserve-spans,preserve-whitespace').asJSON());

console.log('=== What the browser engine gives us per line ===');
const lines = [];
for (const b of j.blocks) {
  if (b.type !== 'text') { console.log('  non-text block:', b.type); continue; }
  for (const l of b.lines) {
    lines.push(l);
    console.log(`  y=${Math.round(l.y)} size=${l.font.size} weight=${l.font.weight} style=${l.font.style} family=${l.font.family} :: "${l.text.trim()}"`);
  }
}

const paras = lines.filter(l => l.text.trim()).map(l => new Paragraph({
  children: [new TextRun({
    text: l.text.trim(),
    bold: l.font.weight !== 'normal' || l.font.size > 13,
    italics: l.font.style !== 'normal',
    size: Math.round(l.font.size * 2),
  })],
  heading: l.font.size > 13 ? HeadingLevel.HEADING_1 : undefined,
}));

paras.push(new Table({
  width: { size: 100, type: WidthType.PERCENTAGE },
  rows: [
    new TableRow({ children: ['Head', 'Amount'].map(t => new TableCell({ children: [new Paragraph(t)] })) }),
    new TableRow({ children: ['Basic salary', '12,00,000'].map(t => new TableCell({ children: [new Paragraph(t)] })) }),
  ],
}));

const bytes = await Packer.toBuffer(new Document({ sections: [{ children: paras }] }));
fs.writeFileSync(path.join(D, 'out.docx'), bytes);
console.log('\n=== DOCX written ===');
console.log('bytes:', bytes.length);

const zip = await JSZip.loadAsync(bytes);
const names = Object.keys(zip.files);
console.log('valid OOXML package:', names.includes('word/document.xml') && names.includes('[Content_Types].xml'));
console.log('parts:', names.join(', '));
const xml = await zip.file('word/document.xml').async('string');
console.log('text carried over:', xml.includes('STATE BANK OF INDIA'), '|', xml.includes('Rahul Sharma'));
console.log('font size mapping present:', /<w:sz w:val="28"\/>/.test(xml));
console.log('table present:', xml.includes('<w:tbl>'));

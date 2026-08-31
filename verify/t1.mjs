import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import fs from 'fs';
import path from 'path';
const D = import.meta.dirname;

// 1) Create a PDF that has NO form, then ADD a real fillable text field + checkbox + signature placeholder
const doc = await PDFDocument.create();
const page = doc.addPage([595, 842]); // A4
const font = await doc.embedFont(StandardFonts.Helvetica);
page.drawText('BANK ACCOUNT UPDATE FORM (flat, no fields)', { x: 40, y: 790, size: 14, font });
page.drawText('Name: ____________________', { x: 40, y: 700, size: 11, font });
page.drawText('PAN:  ____________________', { x: 40, y: 670, size: 11, font });

const form = doc.getForm();
const nameField = form.createTextField('applicant_name');   // <-- NEW field on a flat PDF
nameField.setText('Rahul Sharma');
nameField.addToPage(page, { x: 90, y: 694, width: 220, height: 18 });

const panField = form.createTextField('pan');
panField.setMaxLength(10);
panField.setText('ABCDE1234F');
panField.addToPage(page, { x: 90, y: 664, width: 220, height: 18 });

const chk = form.createCheckBox('consent');
chk.check();
chk.addToPage(page, { x: 40, y: 600, width: 14, height: 14 });

const bytes = await doc.save();
fs.writeFileSync(path.join(D, 'out_form.pdf'), bytes);
console.log('T1 created PDF bytes:', bytes.length);

// 2) Read it back and prove the fields are REAL AcroForm widgets, not overlays
const re = await PDFDocument.load(fs.readFileSync(path.join(D, 'out_form.pdf')));
const f = re.getForm();
console.log('T1 field count read back:', f.getFields().length);
console.log('T1 fields:', f.getFields().map(x => `${x.getName()}=${x.constructor.name}`).join(', '));
console.log('T1 pan value:', f.getTextField('pan').getText());
console.log('T1 consent checked:', f.getCheckBox('consent').isChecked());

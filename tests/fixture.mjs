export const SECRET = '3092 8871 4455 2210';
export const PAN = 'ABCDE1234F';
export function buildFixture() {
  const content = [
    'BT /F1 14 Tf 40 780 Td (STATE BANK OF INDIA) Tj ET',
    `BT /F1 12 Tf 40 740 Td (Account Number: ${SECRET}) Tj ET`,
    `BT /F1 12 Tf 40 720 Td (PAN: ${PAN}) Tj ET`,
    'BT /F1 12 Tf 40 700 Td (Name: Rahul Sharma) Tj ET',
  ].join('\n') + '\n';

  const objects = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>',
    `<</Length ${Buffer.byteLength(content, 'latin1')}>>\nstream\n${content}endstream`,
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
    '<</Producer(Fixture Generator 1.0)/Creator(Test Harness)/Author(Rahul Sharma)/CreationDate(D:20260101000000Z)>>',
  ];

  let out = '%PDF-1.7\n';
  const offsets = [0];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefAt = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) {
    out += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  out += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R/Info 6 0 R>>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return out;
}

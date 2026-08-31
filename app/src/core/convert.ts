/**
 * convert.ts — document format conversion, entirely in this tab.
 *
 * Strategy (deliberately simple, deliberately honest):
 *   1. Parse the source into a neutral block model: headings, paragraphs,
 *      lists, tables, code.
 *   2. Rebuild the target format from those blocks.
 *
 * What this carries over: text, reading order, headings, lists, tables.
 * What it does NOT carry over: exact layout, fonts, images, colours. That is
 * the honest contract of a serverless converter — the alternative (pixel-faithful
 * DOCX<->PDF) requires LibreOffice-class engines that do not run in a browser.
 *
 * Privacy: every parser and writer below is local WASM/JS. Nothing is fetched.
 * Outputs are scrubbed of library fingerprints (docProps, Producer strings).
 */
import * as mupdf from 'mupdf';
import * as XLSX from 'xlsx';
import * as mammoth from 'mammoth';
import JSZip from 'jszip';
import {
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableRow,
  TableCell,
  TextRun,
  WidthType,
} from 'docx';
import { PDFDocument, StandardFonts, rgb, type PDFFont } from 'pdf-lib';

export type SourceKind = 'pdf' | 'docx' | 'xlsx' | 'md' | 'txt';
export type TargetKind = 'pdf' | 'docx' | 'xlsx' | 'md';

export type Block =
  | { kind: 'heading'; level: 1 | 2 | 3; text: string }
  | { kind: 'para'; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'code'; text: string }
  | { kind: 'table'; rows: string[][] };

export const TARGET_META: Record<TargetKind, { ext: string; mime: string; label: string }> = {
  pdf: { ext: 'pdf', mime: 'application/pdf', label: 'PDF' },
  docx: {
    ext: 'docx',
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    label: 'DOCX',
  },
  xlsx: {
    ext: 'xlsx',
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    label: 'XLSX',
  },
  md: { ext: 'md', mime: 'text/markdown', label: 'Markdown' },
};

/* ------------------------------------------------------------------ */
/* Detection                                                           */
/* ------------------------------------------------------------------ */

export async function detectKind(name: string, bytes: Uint8Array): Promise<SourceKind> {
  const head = String.fromCharCode(...bytes.subarray(0, 5));
  if (head === '%PDF-') return 'pdf';
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
    const zip = await JSZip.loadAsync(bytes.slice());
    if (zip.file('word/document.xml')) return 'docx';
    if (zip.file('xl/workbook.xml')) return 'xlsx';
    throw new Error('That zip is neither a DOCX nor an XLSX.');
  }
  const lower = name.toLowerCase();
  if (/\.(md|markdown)$/.test(lower)) return 'md';
  if (/\.txt$/.test(lower)) return 'txt';
  // Content sniff for extensionless text.
  const text = new TextDecoder().decode(bytes.subarray(0, 4096));
  if (/(^|\n)#{1,6} \S/.test(text) || /(^|\n)\s*\|.*\|.*\n/.test(text)) return 'md';
  return 'txt';
}

/* ------------------------------------------------------------------ */
/* Parsers -> Block[]                                                  */
/* ------------------------------------------------------------------ */

export async function parseBlocks(kind: SourceKind, bytes: Uint8Array): Promise<Block[]> {
  switch (kind) {
    case 'pdf':
      return parsePdf(bytes);
    case 'docx':
      return parseDocx(bytes);
    case 'xlsx':
      return parseXlsx(bytes);
    case 'md':
      return parseMd(new TextDecoder().decode(bytes));
    case 'txt':
      return parseTxt(new TextDecoder().decode(bytes));
  }
}

type MuLine = { bbox: { x: number; y: number; w: number; h: number }; text: string; font?: { size?: number } };
type MuBlock = { type: string; lines?: MuLine[] };

function parsePdf(bytes: Uint8Array): Block[] {
  const doc = mupdf.Document.openDocument(bytes.slice(), 'application/pdf');
  try {
    const pages = doc.countPages();
    const lines: (MuLine & { page: number })[] = [];
    for (let p = 0; p < pages; p++) {
      const page = doc.loadPage(p);
      try {
        const parsed = JSON.parse(page.toStructuredText('preserve-whitespace').asJSON()) as {
          blocks: MuBlock[];
        };
        for (const b of parsed.blocks) {
          if (b.type !== 'text' || !b.lines) continue;
          for (const l of b.lines) {
            const t = l.text?.trim();
            if (t) lines.push({ ...l, text: t, page: p });
          }
        }
      } finally {
        page.destroy();
      }
    }

    // Body size = the most common rounded font size.
    const freq = new Map<number, number>();
    for (const l of lines) {
      const s = Math.round(l.font?.size ?? 12);
      freq.set(s, (freq.get(s) ?? 0) + 1);
    }
    let body = 12;
    let best = 0;
    for (const [s, n] of freq) if (n > best) ((best = n), (body = s));

    const blocks: Block[] = [];
    let para: { text: string; page: number; y: number; size: number } | null = null;
    const flush = () => {
      if (para && para.text.trim()) blocks.push({ kind: 'para', text: para.text.trim() });
      para = null;
    };

    for (const l of lines) {
      const size = Math.round(l.font?.size ?? body);
      if (size >= body + 3) {
        flush();
        const level: 1 | 2 | 3 = size >= body + 8 ? 1 : size >= body + 5 ? 2 : 3;
        blocks.push({ kind: 'heading', level, text: l.text });
        continue;
      }
      const close =
        para &&
        para.page === l.page &&
        Math.abs(size - para.size) <= 1 &&
        l.bbox.y - para.y < para.size * 2.2;
      if (close && para) {
        para.text += ` ${l.text}`;
        para.y = l.bbox.y;
      } else {
        flush();
        para = { text: l.text, page: l.page, y: l.bbox.y, size };
      }
    }
    flush();
    return blocks;
  } finally {
    doc.destroy();
  }
}

async function parseDocx(bytes: Uint8Array): Promise<Block[]> {
  const result = await mammoth.convertToHtml({ arrayBuffer: bytes.slice().buffer as ArrayBuffer });
  const doc = new DOMParser().parseFromString(result.value, 'text/html');
  const blocks: Block[] = [];

  const walk = (el: Element): void => {
    for (const node of Array.from(el.children)) {
      const tag = node.tagName.toLowerCase();
      const m = /^h([1-6])$/.exec(tag);
      if (m) {
        const level = Math.min(3, Number(m[1])) as 1 | 2 | 3;
        const text = (node.textContent ?? '').trim();
        if (text) blocks.push({ kind: 'heading', level, text });
        continue;
      }
      if (tag === 'p') {
        const text = (node.textContent ?? '').trim();
        if (text) blocks.push({ kind: 'para', text });
        continue;
      }
      if (tag === 'ul' || tag === 'ol') {
        const items = Array.from(node.children)
          .filter((li) => li.tagName.toLowerCase() === 'li')
          .map((li) => (li.textContent ?? '').trim())
          .filter(Boolean);
        if (items.length) blocks.push({ kind: 'list', ordered: tag === 'ol', items });
        continue;
      }
      if (tag === 'table') {
        const rows = Array.from(node.querySelectorAll('tr')).map((tr) =>
          Array.from(tr.querySelectorAll('th,td')).map((c) => (c.textContent ?? '').trim()),
        );
        if (rows.length) blocks.push({ kind: 'table', rows });
        continue;
      }
      if (tag === 'pre') {
        const text = (node.textContent ?? '').replace(/\n$/, '');
        if (text.trim()) blocks.push({ kind: 'code', text });
        continue;
      }
      // Containers: recurse. Images are intentionally dropped (text-faithful contract).
      walk(node);
    }
  };
  walk(doc.body);
  return blocks;
}

function parseXlsx(bytes: Uint8Array): Block[] {
  const wb = XLSX.read(bytes.slice(), { type: 'array' });
  const blocks: Block[] = [];
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws) continue;
    blocks.push({ kind: 'heading', level: 2, text: name });
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' }) as unknown as unknown[][];
    const cleaned = rows
      .map((r) => r.map((c) => String(c ?? '')))
      .filter((r) => r.some((c) => c.trim() !== ''));
    if (cleaned.length) blocks.push({ kind: 'table', rows: cleaned });
  }
  return blocks;
}

function parseMd(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = text.split(/\r?\n/);
  let para: string[] = [];
  let code: string[] | null = null;
  let list: { ordered: boolean; items: string[] } | null = null;
  let table: string[][] | null = null;

  const flushPara = () => {
    const t = para.join(' ').trim();
    if (t) blocks.push({ kind: 'para', text: t });
    para = [];
  };
  const flushList = () => {
    if (list && list.items.length) blocks.push({ kind: 'list', ordered: list.ordered, items: list.items });
    list = null;
  };
  const flushTable = () => {
    if (table && table.length) blocks.push({ kind: 'table', rows: table });
    table = null;
  };

  for (const line of lines) {
    if (code !== null) {
      if (/^\s*```/.test(line)) {
        blocks.push({ kind: 'code', text: code.join('\n') });
        code = null;
      } else code.push(line);
      continue;
    }
    if (/^\s*```/.test(line)) {
      flushPara();
      flushList();
      flushTable();
      code = [];
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flushPara();
      flushList();
      flushTable();
      blocks.push({ kind: 'heading', level: Math.min(3, h[1].length) as 1 | 2 | 3, text: h[2].trim() });
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      flushPara();
      flushList();
      if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) continue; // separator row
      const cells = line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      (table ??= []).push(cells);
      continue;
    }
    flushTable();
    const li = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (li) {
      flushPara();
      const ordered = /^\s*\d/.test(line);
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { ordered, items: [] };
      }
      list.items.push(li[1].trim());
      continue;
    }
    flushList();
    if (!line.trim()) {
      flushPara();
      continue;
    }
    para.push(line.trim());
  }
  if (code !== null) blocks.push({ kind: 'code', text: code.join('\n') });
  flushPara();
  flushList();
  flushTable();
  return blocks;
}

function parseTxt(text: string): Block[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s*\n\s*/g, ' ').trim())
    .filter(Boolean)
    .map((p): Block => ({ kind: 'para', text: p }));
}

/* ------------------------------------------------------------------ */
/* Writers                                                             */
/* ------------------------------------------------------------------ */

export interface ConvertOutput {
  blob: Blob;
  ext: string;
  mime: string;
}

export async function writeBlocks(target: TargetKind, blocks: Block[]): Promise<ConvertOutput> {
  switch (target) {
    case 'md':
      return { blob: new Blob([toMarkdown(blocks)], { type: 'text/markdown' }), ext: 'md', mime: 'text/markdown' };
    case 'xlsx':
      return toXlsx(blocks);
    case 'docx':
      return toDocx(blocks);
    case 'pdf':
      return toPdf(blocks);
  }
}

function mdEscapeCell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function toMarkdown(blocks: Block[]): string {
  const out: string[] = [];
  for (const b of blocks) {
    if (b.kind === 'heading') out.push(`${'#'.repeat(b.level)} ${b.text}`, '');
    else if (b.kind === 'para') out.push(b.text, '');
    else if (b.kind === 'code') out.push('```', b.text, '```', '');
    else if (b.kind === 'list') {
      b.items.forEach((it, i) => out.push(b.ordered ? `${i + 1}. ${it}` : `- ${it}`));
      out.push('');
    } else if (b.kind === 'table') {
      const width = Math.max(...b.rows.map((r) => r.length));
      b.rows.forEach((r, ri) => {
        const cells = [...r];
        while (cells.length < width) cells.push('');
        out.push(`| ${cells.map(mdEscapeCell).join(' | ')} |`);
        if (ri === 0) out.push(`| ${cells.map(() => '---').join(' | ')} |`);
      });
      out.push('');
    }
  }
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

async function toXlsx(blocks: Block[]): Promise<ConvertOutput> {
  const aoa: string[][] = [];
  for (const b of blocks) {
    if (b.kind === 'heading') aoa.push([b.text], []);
    else if (b.kind === 'para') aoa.push([b.text]);
    else if (b.kind === 'list') b.items.forEach((it, i) => aoa.push([b.ordered ? `${i + 1}. ${it}` : `• ${it}`]));
    else if (b.kind === 'code') b.text.split('\n').forEach((l) => aoa.push([l]));
    else if (b.kind === 'table') {
      b.rows.forEach((r) => aoa.push(r));
      aoa.push([]);
    }
  }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Content');
  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
  const bytes = new Uint8Array(out);
  // SheetJS stamps docProps (producer/app fingerprints); scrub like DOCX.
  const blob = await scrubOoxml(new Blob([bytes as unknown as BlobPart], { type: TARGET_META.xlsx.mime }));
  return { blob, ext: 'xlsx', mime: TARGET_META.xlsx.mime };
}

async function toDocx(blocks: Block[]): Promise<ConvertOutput> {
  const children: (Paragraph | Table)[] = [];
  for (const b of blocks) {
    if (b.kind === 'heading') {
      children.push(
        new Paragraph({
          text: b.text,
          heading: b.level === 1 ? HeadingLevel.HEADING_1 : b.level === 2 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3,
        }),
      );
    } else if (b.kind === 'para') {
      children.push(new Paragraph({ text: b.text }));
    } else if (b.kind === 'code') {
      for (const line of b.text.split('\n')) {
        children.push(new Paragraph({ children: [new TextRun({ text: line, font: 'Courier New', size: 18 })] }));
      }
    } else if (b.kind === 'list') {
      b.items.forEach((it, i) => {
        children.push(
          b.ordered
            ? new Paragraph({ text: `${i + 1}. ${it}` })
            : new Paragraph({ text: it, bullet: { level: 0 } }),
        );
      });
    } else if (b.kind === 'table') {
      const width = Math.max(...b.rows.map((r) => r.length));
      children.push(
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: b.rows.map(
            (r) =>
              new TableRow({
                children: Array.from({ length: width }, (_, ci) =>
                  new TableCell({ children: [new Paragraph(r[ci] ?? '')] }),
                ),
              }),
          ),
        }),
      );
    }
  }
  const doc = new Document({
    creator: '',
    title: '',
    description: '',
    lastModifiedBy: '',
    revision: 1,
    sections: [{ children }],
  });
  const raw = await Packer.toBlob(doc);
  const blob = await scrubOoxml(raw);
  return { blob, ext: 'docx', mime: TARGET_META.docx.mime };
}

/** Remove docProps (creator/app fingerprints) from a DOCX or XLSX zip. */
async function scrubOoxml(blob: Blob): Promise<Blob> {
  const zip = await JSZip.loadAsync(blob);
  zip.remove('docProps/core.xml');
  zip.remove('docProps/app.xml');
  zip.remove('docProps/custom.xml');
  const ct = zip.file('[Content_Types].xml');
  if (ct) {
    const xml = (await ct.async('string')).replace(/<Override[^>]*PartName="\/docProps\/[^"]*"[^>]*\/>/g, '');
    zip.file('[Content_Types].xml', xml);
  }
  const rels = zip.file('_rels/.rels');
  if (rels) {
    const xml = (await rels.async('string')).replace(/<Relationship[^>]*Target="docProps\/[^"]*"[^>]*\/>/g, '');
    zip.file('_rels/.rels', xml);
  }
  return zip.generateAsync({ type: 'blob', mimeType: blob.type });
}

/* ------------------------- PDF writer ----------------------------- */

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 56;

const WINANSI_MAP: Record<string, string> = {
  '–': '-', '—': '-', '‘': "'", '’': "'", '“': '"', '”': '"',
  '•': '-', '…': '...', ' ': ' ', '→': '->', '×': 'x',
};

/** pdf-lib standard fonts speak WinAnsi only; everything else degrades to '?'. */
function latinize(s: string): string {
  const NBSP = String.fromCharCode(0xa0);
  const LAST = String.fromCharCode(0xff);
  const re = new RegExp('[' + NBSP + '-' + LAST + ']', 'g');
  return s.replace(re, (ch) => {
    const mapped = WINANSI_MAP[ch];
    if (mapped) return mapped;
    return ch;
  });
}

async function toPdf(blocks: Block[]): Promise<ConvertOutput> {
  const doc = await PDFDocument.create();
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const mono = await doc.embedFont(StandardFonts.Courier);

  let page = doc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - MARGIN;
  const usable = PAGE_W - MARGIN * 2;

  const newPage = (): void => {
    page = doc.addPage([PAGE_W, PAGE_H]);
    y = PAGE_H - MARGIN;
  };
  const ensure = (h: number): void => {
    if (y - h < MARGIN) newPage();
  };

  const wrap = (text: string, font: PDFFont, size: number, width: number): string[] => {
    const words = latinize(text).split(/\s+/).filter(Boolean);
    const lines: string[] = [];
    let cur = '';
    for (const w of words) {
      const trial = cur ? cur + ' ' + w : w;
      if (!cur || font.widthOfTextAtSize(trial, size) <= width) cur = trial;
      else {
        lines.push(cur);
        cur = w;
      }
    }
    if (cur) lines.push(cur);
    return lines.length ? lines : [''];
  };

  const INK = rgb(0.1, 0.1, 0.1);
  for (const b of blocks) {
    if (b.kind === 'heading') {
      const size = b.level === 1 ? 20 : b.level === 2 ? 16 : 13;
      y -= size * 0.7;
      for (const ln of wrap(b.text, bold, size, usable)) {
        ensure(size * 1.5);
        page.drawText(ln, { x: MARGIN, y: y - size, size, font: bold, color: rgb(0.07, 0.09, 0.12) });
        y -= size * 1.35;
      }
      y -= 4;
    } else if (b.kind === 'para') {
      for (const ln of wrap(b.text, regular, 11, usable)) {
        ensure(16);
        page.drawText(ln, { x: MARGIN, y: y - 11, size: 11, font: regular, color: INK });
        y -= 16;
      }
      y -= 6;
    } else if (b.kind === 'list') {
      b.items.forEach((it, i) => {
        const prefix = b.ordered ? i + 1 + '. ' : '- ';
        wrap(prefix + it, regular, 11, usable - 14).forEach((ln, li) => {
          ensure(16);
          page.drawText(ln, { x: MARGIN + (li === 0 ? 0 : 14), y: y - 11, size: 11, font: regular, color: INK });
          y -= 16;
        });
      });
      y -= 6;
    } else if (b.kind === 'code') {
      for (const raw of b.text.split('\n')) {
        for (const ln of wrap(raw || ' ', mono, 9, usable)) {
          ensure(12);
          page.drawText(ln, { x: MARGIN, y: y - 9, size: 9, font: mono, color: rgb(0.15, 0.15, 0.15) });
          y -= 12;
        }
      }
      y -= 6;
    } else if (b.kind === 'table') {
      const maxCols = Math.min(6, Math.max(1, ...b.rows.map((r) => r.length)));
      const colW = usable / maxCols;
      const size = 9;
      const lineH = 12;
      const pad = 5;
      const grid = rgb(0.62, 0.65, 0.68);
      for (const row of b.rows) {
        const wrapped = Array.from({ length: maxCols }, (_, ci) =>
          wrap(row[ci] ?? '', regular, size, colW - pad * 2),
        );
        const rowH = Math.max(...wrapped.map((w) => w.length)) * lineH + pad * 2;
        ensure(rowH);
        const top = y;
        page.drawLine({ start: { x: MARGIN, y: top }, end: { x: MARGIN + usable, y: top }, thickness: 0.6, color: grid });
        page.drawLine({ start: { x: MARGIN, y: top - rowH }, end: { x: MARGIN + usable, y: top - rowH }, thickness: 0.6, color: grid });
        for (let c = 0; c <= maxCols; c++) {
          const x = MARGIN + c * colW;
          page.drawLine({ start: { x, y: top }, end: { x, y: top - rowH }, thickness: 0.6, color: grid });
        }
        wrapped.forEach((lines, ci) => {
          let ly = top - pad - size;
          for (const ln of lines) {
            page.drawText(ln, { x: MARGIN + ci * colW + pad, y: ly, size, font: regular, color: INK });
            ly -= lineH;
          }
        });
        y = top - rowH;
      }
      y -= 8;
    }
  }

  doc.setProducer('');
  doc.setCreator('');
  doc.setTitle('');
  doc.setAuthor('');
  doc.setSubject('');
  doc.setKeywords([]);
  doc.setCreationDate(new Date(0));
  doc.setModificationDate(new Date(0));

  const bytes = await doc.save();
  return {
    blob: new Blob([bytes as unknown as BlobPart], { type: 'application/pdf' }),
    ext: 'pdf',
    mime: 'application/pdf',
  };
}

/* ------------------------------------------------------------------ */
/* Top-level entry                                                     */
/* ------------------------------------------------------------------ */

export interface ConvertReport {
  source: SourceKind;
  target: TargetKind;
  blocks: number;
  bytes: number;
}

export async function convertBytes(
  name: string,
  bytes: Uint8Array,
  target: TargetKind,
): Promise<{ output: ConvertOutput; report: ConvertReport }> {
  const source = await detectKind(name, bytes);
  const blocks = await parseBlocks(source, bytes);
  if (!blocks.length) {
    throw new Error(
      'No text could be extracted from that file. If it is a scanned (image-only) PDF, OCR is not built yet.',
    );
  }
  const output = await writeBlocks(target, blocks);
  return { output, report: { source, target, blocks: blocks.length, bytes: output.blob.size } };
}

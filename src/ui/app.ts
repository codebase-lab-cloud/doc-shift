/**
 * app.ts — the whole UI. Plain DOM, no framework: fewer dependencies, a smaller
 * bundle, and less to audit, which is the point of this project.
 */
import * as pdf from '../core/pdf';
import * as state from '../core/state';
import { newId } from '../core/state';
import { buildExport, download, outputName, type ExportReport } from '../core/export';
import {
  renderAnnotations,
  setSelected,
  setZoomRef,
  deleteSelected,
  type Tool,
} from '../core/annotations';
import { openSignaturePad, stripImageMetadata } from './signature-pad';
import { getState as egressState, subscribe as subscribeEgress } from '../privacy/egress';
import { storageLockdownComplete } from '../privacy/storage-killer';
import {
  convertBytes,
  detectKind,
  TARGET_META,
  type SourceKind,
  type TargetKind,
} from '../core/convert';

let tool: Tool = 'select';
let zoom = 1.3;
let currentPage = 0;
let lastReport: ExportReport | null = null;
/** Source file held for the converter (in memory only, wipeable). */
let convSrc: { name: string; bytes: Uint8Array; kind: SourceKind } | null = null;
let convTarget: TargetKind = 'pdf';
/** Rect we are dragging out on a page, in PDF points. */
let pending: { page: number; x0: number; y0: number; x1: number; y1: number } | null = null;

const $ = <T extends HTMLElement>(sel: string): T | null => document.querySelector<T>(sel);

/** 24px stroke icons, drawn inline so nothing is fetched. */
const SVG_OPEN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';
const ICONS: Record<string, string> = {
  select: `${SVG_OPEN}<path d="M5.5 3.5l6.2 15.4 2.1-6.1 6.1-2.1z"/></svg>`,
  text: `${SVG_OPEN}<path d="M6 5.5h12M12 5.5V19"/></svg>`,
  image: `${SVG_OPEN}<rect x="3.5" y="5" width="17" height="14" rx="2.5"/><circle cx="9" cy="10" r="1.6"/><path d="M6.5 16.5l4-4 3.2 3.2 2.3-2.3 1.8 1.8"/></svg>`,
  signature: `${SVG_OPEN}<path d="M4 20l1.2-4.3L15.6 5.3a2.15 2.15 0 0 1 3.1 3L8.3 18.7z"/><path d="M13.7 7.4l3 3"/></svg>`,
  whiteout: `${SVG_OPEN}<path d="M14.7 4.6l4.7 4.7-9.2 9.2H6l-2.4-2.4z"/><path d="M4 20h16"/></svg>`,
  redact: `${SVG_OPEN}<rect x="4.5" y="5.5" width="15" height="13" rx="2" fill="currentColor" stroke="none"/></svg>`,
  field: `${SVG_OPEN}<rect x="4" y="4.5" width="16" height="15" rx="2.5"/><path d="M8 10h8M8 14h5"/></svg>`,
  trash: `${SVG_OPEN}<path d="M4.5 7h15M9.5 7V4.8h5V7M6.5 7l1 12.5h9l1-12.5M10 11v5M14 11v5"/></svg>`,
};

export function mount(): void {
  const app = $('#app');
  if (!app) return;
  app.innerHTML = layout();
  wireChrome();
  wireDropzone();
  wireToolbar();
  wireTabs();
  wireConvert();
  subscribeEgress(renderPrivacyChips);
  state.subscribe(onStateChange);
  renderPrivacyChips();
  renderSession();
  renderMetadata();
  window.addEventListener('keydown', onKey);
}

function layout(): string {
  return `
  <header class="topbar">
    <div class="brand">
      <span class="logo">▣</span>
      <div>
        <h1>DocShift</h1>
        <p class="tagline">Everything happens in this tab. Nothing is uploaded. Nothing is stored.</p>
      </div>
    </div>
    <nav class="tabs" id="tabs" aria-label="Mode">
      <button class="tab active" data-tab="editor">Edit PDF</button>
      <button class="tab" data-tab="convert">Convert</button>
    </nav>
    <div class="chips" id="chips"></div>
  </header>

  <main class="shell" id="view-editor">
    <nav class="toolbar" id="toolbar" aria-label="Tools">
      ${toolButton('select', ICONS.select, 'Select / move', 'V')}
      ${toolButton('text', ICONS.text, 'Add text box', 'T')}
      ${toolButton('image', ICONS.image, 'Insert image', 'I')}
      ${toolButton('signature', ICONS.signature, 'Sign (draw or upload)', 'S')}
      ${toolButton('whiteout', ICONS.whiteout, 'Whiteout', 'W')}
      ${toolButton('redact', ICONS.redact, 'Redact (destroys content)', 'R')}
      ${toolButton('field', ICONS.field, 'Add form field', 'F')}
      <hr />
      <button id="page-del" title="Delete this page">${ICONS.trash}<span>Page</span></button>
      <div class="zoomer">
        <button id="zoom-out" aria-label="Zoom out">−</button>
        <span id="zoom-label">130%</span>
        <button id="zoom-in" aria-label="Zoom in">+</button>
      </div>
    </nav>

    <section class="viewer" id="viewer" aria-label="Document">
      <div class="dropzone" id="dropzone">
        <h2>Drop a PDF here</h2>
        <p>or</p>
        <label class="file-label"><input type="file" id="file" accept="application/pdf,.pdf" hidden />Choose a file</label>
        <p class="muted small">
          The file is read into this tab's memory by your browser. It is never sent anywhere —
          there is no server. Close the tab and it is gone.
        </p>
      </div>
      <div id="pages"></div>
    </section>

    <aside class="side">
      <section class="panel">
        <h3>Export</h3>
        <div id="export-area"><p class="muted">Open a document first.</p></div>
      </section>
      <section class="panel">
        <h3>Properties</h3>
        <div id="props"><p class="muted">Select an item to edit its properties.</p></div>
      </section>
      <section class="panel">
        <h3>Metadata</h3>
        <div id="metadata"><p class="muted">—</p></div>
      </section>
      <section class="panel">
        <h3>In memory right now</h3>
        <div id="session"></div>
        <button id="destroy" class="danger wide">Destroy session</button>
      </section>
    </aside>
  </main>

  <main class="shell" id="view-convert" hidden>
    <section class="convert-main" id="convert-main">
      <div class="dropzone" id="cdrop">
        <h2>Convert a document</h2>
        <p class="muted">PDF · Word (DOCX) · Excel (XLSX) · Markdown · plain text — to any of PDF, DOCX, XLSX, Markdown.</p>
        <label class="file-label">
          <input type="file" id="cfile" accept=".pdf,.docx,.xlsx,.md,.markdown,.txt,application/pdf" hidden />
          Choose a file
        </label>
        <p class="muted small">Parsed and rebuilt inside this tab by your browser. Nothing is uploaded, nothing is stored.</p>
        <p id="cdetected" class="small"></p>
      </div>
      <div id="ctargets" class="targets" hidden>
        <span class="muted small">Convert to:</span>
        <div class="trow" id="trow"></div>
        <button id="cgo" class="primary">Convert &amp; download</button>
        <p id="cstatus" class="small"></p>
      </div>
    </section>

    <aside class="side">
      <section class="panel">
        <h3>What carries over</h3>
        <p class="muted small">Text, reading order, headings, lists and tables. Exact layout, fonts and
        images do not — that would need a server-side office suite, which this app refuses to be.</p>
        <p class="warn small">PDF output uses built-in Latin fonts, so non-Latin scripts become “?” in PDF
        targets. DOCX, XLSX and Markdown keep full Unicode.</p>
      </section>
      <section class="panel">
        <h3>Loaded for conversion</h3>
        <div id="csession"><p class="muted">Nothing loaded. Memory is empty.</p></div>
      </section>
    </aside>
  </main>

  <div class="statusbar">
    <span id="status-text">Ready.</span>
    <span class="spacer"></span>
    <span class="mono" id="storage-state"></span>
  </div>`;
}

function toolButton(id: Tool, glyph: string, label: string, key: string): string {
  return `<button class="tool${id === 'select' ? ' active' : ''}" data-tool="${id}" title="${label} (${key})">
    <span class="glyph">${glyph}</span><span class="tlabel">${label.split(' ')[0]}</span></button>`;
}

function status(msg: string): void {
  const el = $('#status-text');
  if (el) el.textContent = msg;
}

function wireChrome(): void {
  $('#zoom-in')?.addEventListener('click', () => setZoom(zoom + 0.25));
  $('#zoom-out')?.addEventListener('click', () => setZoom(Math.max(0.4, zoom - 0.25)));
  $('#page-del')?.addEventListener('click', () => {
    const s = state.getSession();
    if (!s || s.pageCount < 2) return;
    pdf.deletePage(currentPage);
    state.destroySession();
    // Re-open from the mutated mupdf doc is not possible; simplest correct path:
    // rebuild the session from the saved bytes.
    const bytes = pdf.save();
    void loadBytes(bytes, s.fileName, /*keepAnnotations*/ false);
  });
  $('#destroy')?.addEventListener('click', () => {
    state.destroySession();
    pdf.close();
    pdf.clearRenderCache();
    forgetConvSrc();
    renderConvertState();
    renderPages();
    status('Session destroyed. Memory released.');
  });
  const ss = $('#storage-state');
  if (ss) {
    ss.textContent = storageLockdownComplete()
      ? 'storage APIs: disabled'
      : 'storage APIs: partially undefinable (see console)';
  }
}

function renderPrivacyChips(): void {
  const e = egressState();
  const chips = $('#chips');
  if (!chips) return;
  chips.innerHTML = `
    <span class="chip ok" title="Outbound requests that left this tab">egress blocked: ${e.blocked}</span>
    <span class="chip ${e.allowed === 0 ? 'ok' : 'warn'}"
          title="Same-origin asset loads (the app itself). Document data is never requested.">
      requests: ${e.allowed}</span>
    <span class="chip ok">server: none</span>
    <span class="chip ok">storage: none</span>`;
}

function wireDropzone(): void {
  const dz = $('#dropzone');
  const viewer = $('#viewer');
  const input = $('#file') as HTMLInputElement | null;
  if (!dz || !viewer || !input) return;

  input.addEventListener('change', () => {
    const f = input.files?.[0];
    if (f) void readFile(f);
  });
  ['dragenter', 'dragover'].forEach((ev) =>
    viewer.addEventListener(ev, (e) => {
      e.preventDefault();
      dz.classList.add('hot');
    }),
  );
  ['dragleave', 'drop'].forEach((ev) =>
    viewer.addEventListener(ev, (e) => {
      e.preventDefault();
      dz.classList.remove('hot');
    }),
  );
  viewer.addEventListener('drop', (e) => {
    e.preventDefault();
    const f = e.dataTransfer?.files?.[0];
    if (f) void readFile(f);
  });
}

async function readFile(file: File): Promise<void> {
  status('Reading…');
  const bytes = new Uint8Array(await file.arrayBuffer());
  // Validate by magic bytes, not by the extension the OS handed us.
  const head = String.fromCharCode(...bytes.subarray(0, 5));
  if (head !== '%PDF-') {
    status('That is not a PDF (magic bytes did not match). Nothing was loaded.');
    bytes.fill(0);
    return;
  }
  await loadBytes(bytes, file.name, true);
}

async function loadBytes(bytes: Uint8Array, name: string, fresh: boolean): Promise<void> {
  status('Opening…');
  try {
    pdf.open(bytes);
    pdf.clearRenderCache();
    const pageCount = pdf.countPages();
    const pageSizes = [];
    for (let i = 0; i < pageCount; i++) pageSizes.push(pdf.pageSize(i));
    if (fresh) {
      state.setSession({
        fileName: name,
        originalBytes: bytes,
        pageCount,
        pageSizes,
        annotations: [],
        redactionsApplied: false,
        metadataScrubbed: false,
        openedAt: Date.now(),
      });
    }
    currentPage = Math.min(currentPage, pageCount - 1);
    renderPages();
    renderMetadata();
    renderExportArea();
    // On a narrow screen the default 130% zoom clips the page; fit it instead.
    if (window.innerWidth <= 720 && pageSizes[0]) {
      const viewer = $('#viewer');
      const avail = (viewer?.clientWidth ?? window.innerWidth) - 44;
      const fit = Math.round(Math.max(0.4, Math.min(1.6, avail / pageSizes[0].width)) * 100) / 100;
      if (fit !== zoom) setZoom(fit);
    }
    status(`Opened ${name} — ${pageCount} page(s).`);
  } catch (err) {
    status(`Could not open that file: ${(err as Error).message}`);
  }
}

function setZoom(z: number): void {
  zoom = Math.round(z * 100) / 100;
  setZoomRef(zoom);
  const label = $('#zoom-label');
  if (label) label.textContent = `${Math.round(zoom * 100)}%`;
  renderPages();
}

function renderPages(): void {
  const host = $('#pages');
  const dz = $('#dropzone');
  const s = state.getSession();
  if (!host) return;
  if (!s) {
    host.innerHTML = '';
    if (dz) dz.style.display = '';
    return;
  }
  if (dz) dz.style.display = 'none';

  host.innerHTML = s.pageSizes
    .map(
      (size, i) => `
    <div class="page" data-page="${i}" style="width:${size.width * zoom}px;height:${size.height * zoom}px">
      <div class="page-label">Page ${i + 1} of ${s.pageCount} · ${Math.round(size.width)}×${Math.round(size.height)} pt</div>
      <img class="page-img" alt="Page ${i + 1}" src="${pdf.renderPage(i, zoom)}" />
      <div class="overlay" data-page="${i}"></div>
    </div>`,
    )
    .join('');

  host.querySelectorAll<HTMLElement>('.overlay').forEach((ov) => {
    const page = Number(ov.dataset.page);
    renderAnnotations(ov, page, zoom);
    wireOverlay(ov, page, s.pageSizes[page]);
  });
}

function wireOverlay(ov: HTMLElement, page: number, size: { width: number; height: number }): void {
  ov.addEventListener('pointerdown', (ev) => {
    if (ev.target !== ov) return;
    if (tool === 'select') {
      setSelected(null);
      return;
    }
    if (tool === 'image' || tool === 'signature') {
      void placeImageTool(page, ev);
      return;
    }
    // Drag out a rectangle for text / whiteout / redact / field.
    const rect = ov.getBoundingClientRect();
    const start = { x: (ev.clientX - rect.left) / zoom, y: (ev.clientY - rect.top) / zoom };
    pending = { page, x0: start.x, y0: start.y, x1: start.x, y1: start.y };

    const ghost = document.createElement('div');
    ghost.className = `ghost ghost-${tool}`;
    ov.appendChild(ghost);

    const move = (e: PointerEvent) => {
      const x = (e.clientX - rect.left) / zoom;
      const y = (e.clientY - rect.top) / zoom;
      if (!pending) return;
      pending.x1 = x;
      pending.y1 = y;
      const left = Math.min(pending.x0, x) * zoom;
      const top = Math.min(pending.y0, y) * zoom;
      const w = Math.abs(x - pending.x0) * zoom;
      const h = Math.abs(y - pending.y0) * zoom;
      ghost.style.left = `${left}px`;
      ghost.style.top = `${top}px`;
      ghost.style.width = `${w}px`;
      ghost.style.height = `${h}px`;
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      ghost.remove();
      if (!pending) return;
      const box = {
        x: Math.round(Math.min(pending.x0, pending.x1)),
        y: Math.round(Math.min(pending.y0, pending.y1)),
        width: Math.max(12, Math.round(Math.abs(pending.x1 - pending.x0))),
        height: Math.max(12, Math.round(Math.abs(pending.y1 - pending.y0))),
      };
      pending = null;
      commitBox(page, box, size);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
}

function commitBox(
  page: number,
  box: { x: number; y: number; width: number; height: number },
  size: { width: number; height: number },
): void {
  const s = state.getSession();
  if (!s) return;
  const id = newId();
  let message = '';

  if (tool === 'whiteout') {
    state.addAnnotation({ id, kind: 'whiteout', page, ...box });
  } else if (tool === 'redact') {
    // Capture exactly what this box covers so export can prove it is gone.
    const covered = pdf
      .textLines(page)
      .filter(
        (l) =>
          l.x < box.x + box.width &&
          l.x + l.w > box.x &&
          l.y < box.y + box.height &&
          l.y + l.h > box.y,
      )
      .map((l) => l.text)
      .join(' ');
    if (!covered.trim()) {
      status('That box covers no selectable text. Redaction needs text or an image to remove.');
      return;
    }
    state.addAnnotation({ id, kind: 'redact', page, ...box, coveredText: covered });
    message = `Marked for permanent deletion: "${covered.slice(0, 60)}" — applied when you export.`;
  } else if (tool === 'text') {
    state.addAnnotation({
      id,
      kind: 'text',
      page,
      ...box,
      value: 'Text',
      fontSize: 12,
      color: '#111111',
      align: 'left',
    });
  } else if (tool === 'field') {
    state.addAnnotation({
      id,
      kind: 'field',
      page,
      ...box,
      name: `field_${s.annotations.filter((a) => a.kind === 'field').length + 1}`,
      fieldType: box.height > 30 ? 'multiline' : 'text',
      value: '',
      checked: false,
    });
  }
  setSelected(id);
  setTool('select');
  renderPages();
  renderExportArea();
  // setTool() writes its own hint into the status bar, so say the important
  // thing AFTER it or the user never sees the warning.
  if (tool === 'select' && message) status(message);
  void size;
}

async function placeImageTool(page: number, ev: PointerEvent): Promise<void> {
  const overlay = ev.currentTarget as HTMLElement;
  const rect = overlay.getBoundingClientRect();
  const x = Math.round((ev.clientX - rect.left) / zoom);
  const y = Math.round((ev.clientY - rect.top) / zoom);

  let bytes: Uint8Array | null = null;
  if (tool === 'signature') {
    bytes = await openSignaturePad();
  } else {
    const picked = await pickImage();
    if (picked) bytes = await stripImageMetadata(picked);
  }
  if (!bytes) {
    status('Cancelled.');
    return;
  }
  const id = newId();
  state.addAnnotation({
    id,
    kind: 'image',
    page,
    x,
    y,
    width: Math.min(220, Math.round(bytes.length / 400) + 120),
    height: 90,
    bytes,
    opacity: 1,
  });
  setSelected(id);
  setTool('select');
  renderPages();
  renderExportArea();
}

function pickImage(): Promise<Uint8Array | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,.png,.jpg,.jpeg';
    input.addEventListener('change', () => {
      const f = input.files?.[0];
      if (!f) {
        resolve(null);
        return;
      }
      f.arrayBuffer()
        .then((b) => resolve(new Uint8Array(b)))
        .catch(() => resolve(null));
    });
    // If the dialog is dismissed we resolve null on window focus.
    window.addEventListener(
      'focus',
      () => setTimeout(() => resolve(null), 500),
      { once: true },
    );
    input.click();
  });
}

function wireToolbar(): void {
  document.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach((btn) => {
    btn.addEventListener('click', () => setTool(btn.dataset.tool as Tool));
  });
}

function setTool(t: Tool): void {
  tool = t;
  document
    .querySelectorAll<HTMLButtonElement>('[data-tool]')
    .forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
  const viewer = $('#viewer');
  if (viewer) viewer.dataset.tool = t;
  const hints: Record<Tool, string> = {
    select: 'Click an item to select. Drag to move, corner to resize, Delete to remove.',
    text: 'Drag a box where the text should go.',
    image: 'Click where the image should go.',
    signature: 'Click where the signature should go.',
    whiteout: 'Drag a box to cover content with white. Visual only — use Redact to truly remove.',
    redact: 'Drag a box. The content under it is PERMANENTLY DELETED on export.',
    field: 'Drag a box to add a fillable form field.',
  };
  status(hints[t]);
}

function onKey(e: KeyboardEvent): void {
  const tag = (e.target as HTMLElement | null)?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  const map: Record<string, Tool> = { v: 'select', t: 'text', i: 'image', s: 'signature', w: 'whiteout', r: 'redact', f: 'field' };
  const k = e.key.toLowerCase();
  if (map[k]) setTool(map[k]);
  if (e.key === 'Delete' || e.key === 'Backspace') deleteSelected();
}

function renderMetadata(): void {
  const host = $('#metadata');
  if (!host) return;
  const s = state.getSession();
  if (!s) {
    host.innerHTML = '<p class="muted">—</p>';
    return;
  }
  const md = pdf.getMetadata();
  const rows = Object.entries(md)
    .filter(([, v]) => v)
    .map(([k, v]) => `<div class="row"><label>${k}</label><code>${escapeHtml(v)}</code></div>`)
    .join('');
  host.innerHTML = `${rows || '<p class="muted">No metadata.</p>'}
    <button id="scrub" class="wide">Strip all metadata</button>`;
  host.querySelector('#scrub')?.addEventListener('click', () => {
    pdf.scrubMetadata();
    s.metadataScrubbed = true;
    renderMetadata();
    renderExportArea();
    status('Metadata cleared. It will be absent from the exported file.');
  });
}

function renderExportArea(): void {
  const host = $('#export-area');
  const s = state.getSession();
  if (!host) return;
  if (!s) {
    host.innerHTML = '<p class="muted">Open a document first.</p>';
    return;
  }
  const redactions = s.annotations.filter((a) => a.kind === 'redact');
  host.innerHTML = `
    <div class="row"><label>Edits</label><span>${s.annotations.length}</span></div>
    ${redactions.length ? `<p class="warn">${redactions.length} redaction(s) pending — these permanently delete content.</p>` : ''}
    <button id="do-export" class="primary wide">Download PDF</button>
    <div id="export-report"></div>`;
  host.querySelector('#do-export')?.addEventListener('click', () => void doExport());
  if (lastReport) paintReport($('#export-report'), lastReport);
}

async function doExport(): Promise<void> {
  const s = state.getSession();
  if (!s) return;
  const btn = $('#do-export') as HTMLButtonElement | null;
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Working…';
  }
  try {
    // Apply pending redactions destructively before saving.
    for (const a of s.annotations) {
      if (a.kind !== 'redact') continue;
      // mupdf's annotation rects use the SAME top-left-origin coordinate space as
      // the bboxes from toStructuredText — NOT PDF's bottom-left origin. Flipping
      // them puts the redaction hundreds of points off the page, where it silently
      // does nothing. Verified in dbg runs: [40,89,252,105] removes the line,
      // [40,708,340,720] does not.
      pdf.applyRedaction(a.page, [a.x, a.y, a.x + a.width, a.y + a.height]);
    }
    if (s.annotations.some((a) => a.kind === 'redact')) {
      s.redactionsApplied = true;
      pdf.clearRenderCache();
    }

    const { blob, report } = await buildExport();
    lastReport = report;
    download(blob, outputName(s.fileName, 'docshift'));
    paintReport($('#export-report'), report);
    status(
      report.fingerprints.length
        ? 'Downloaded — but a tool fingerprint survived the scrub. Tell me which.'
        : `Downloaded. ${(report.bytes / 1024).toFixed(0)} KB. Verification passed.`,
    );
    renderPages();
  } catch (err) {
    status(`Export blocked: ${(err as Error).message}`);
    const host = $('#export-report');
    if (host) host.innerHTML = `<p class="error">${escapeHtml((err as Error).message)}</p>`;
  } finally {
    const b = $('#do-export') as HTMLButtonElement | null;
    if (b) {
      b.disabled = false;
      b.textContent = 'Download PDF';
    }
  }
}

function paintReport(host: HTMLElement | null, r: ExportReport): void {
  if (!host) return;
  host.innerHTML = `
    <div class="report">
      <div class="row"><label>Output size</label><span>${(r.bytes / 1024).toFixed(1)} KB</span></div>
      <div class="row"><label>Redacted strings checked</label><span>${r.redactedStringsChecked}</span></div>
      <div class="row"><label>Still present</label><span class="${r.redactedStringsFound ? 'error' : 'ok'}">${r.redactedStringsFound}</span></div>
      <div class="row"><label>Tool fingerprints</label><span class="${r.fingerprints.length ? 'error' : 'ok'}">${r.fingerprints.length ? r.fingerprints.join(', ') : 'none'}</span></div>
    </div>`;
}

function renderSession(): void {
  const host = $('#session');
  if (!host) return;
  const inv = state.memoryInventory();
  if (!inv.fileName) {
    host.innerHTML = '<p class="muted">Nothing loaded. Memory is empty.</p>';
    return;
  }
  const kinds = Object.entries(inv.byKind)
    .map(([k, n]) => `${n} ${k}`)
    .join(', ');
  host.innerHTML = `
    <div class="row"><label>File</label><code>${escapeHtml(inv.fileName)}</code></div>
    <div class="row"><label>Pages</label><span>${inv.pages}</span></div>
    <div class="row"><label>In memory</label><span>${(inv.approxBytes / 1048576).toFixed(2)} MB</span></div>
    ${kinds ? `<div class="row"><label>Edits</label><span>${kinds}</span></div>` : ''}
    <p class="muted small">All of this is RAM. Nothing has been written to disk or to any storage API.</p>`;
}

function onStateChange(): void {
  renderSession();
  renderExportArea();
}

/* --------------------------- mode tabs ---------------------------- */

function wireTabs(): void {
  document.querySelectorAll<HTMLButtonElement>('#tabs .tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      const which = tab.dataset.tab as 'editor' | 'convert';
      document
        .querySelectorAll<HTMLButtonElement>('#tabs .tab')
        .forEach((t) => t.classList.toggle('active', t === tab));
      const editor = $('#view-editor');
      const convert = $('#view-convert');
      if (editor) editor.hidden = which !== 'editor';
      if (convert) convert.hidden = which !== 'convert';
      status(which === 'convert' ? 'Converter ready. Files never leave this tab.' : 'PDF editor.');
    });
  });
}

/* --------------------------- converter ---------------------------- */

function wireConvert(): void {
  const input = $('#cfile') as HTMLInputElement | null;
  const main = $('#convert-main');
  if (!input || !main) return;
  input.addEventListener('change', () => {
    const f = input.files?.[0];
    if (f) void readConvFile(f);
  });
  ['dragenter', 'dragover'].forEach((ev) => main.addEventListener(ev, (e) => e.preventDefault()));
  main.addEventListener('drop', (e) => {
    e.preventDefault();
    const f = e.dataTransfer?.files?.[0];
    if (f) void readConvFile(f);
  });
  $('#cgo')?.addEventListener('click', () => void doConvert());
}

async function readConvFile(file: File): Promise<void> {
  status('Reading…');
  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    const kind = await detectKind(file.name, bytes);
    forgetConvSrc();
    convSrc = { name: file.name, bytes, kind };
    convTarget = kind === 'pdf' ? 'docx' : 'pdf';
    renderConvertState();
    status(`Loaded ${file.name} (${kind.toUpperCase()}).`);
  } catch (err) {
    status(`Could not read that file: ${(err as Error).message}`);
    bytes.fill(0);
  }
}

function forgetConvSrc(): void {
  if (convSrc) {
    convSrc.bytes.fill(0);
    convSrc = null;
  }
}

function renderConvertState(): void {
  const det = $('#cdetected');
  const targets = $('#ctargets');
  const trow = $('#trow');
  const side = $('#csession');
  if (!convSrc) {
    if (det) det.textContent = '';
    if (targets) targets.hidden = true;
    if (side) side.innerHTML = '<p class="muted">Nothing loaded. Memory is empty.</p>';
    return;
  }
  const { name, kind, bytes } = convSrc;
  if (det) det.textContent = `Loaded: ${name} — detected ${kind.toUpperCase()} · ${(bytes.length / 1024).toFixed(0)} KB`;
  if (targets) targets.hidden = false;
  if (trow) {
    trow.innerHTML = (Object.keys(TARGET_META) as TargetKind[])
      .filter((t) => t !== kind)
      .map(
        (t) =>
          `<button data-target="${t}" class="${t === convTarget ? 'active' : ''}">${TARGET_META[t].label}</button>`,
      )
      .join('');
    trow.querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
      b.addEventListener('click', () => {
        convTarget = b.dataset.target as TargetKind;
        trow.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
      });
    });
  }
  if (side) {
    side.innerHTML = `
      <div class="row"><label>File</label><code>${escapeHtml(name)}</code></div>
      <div class="row"><label>Type</label><span>${kind.toUpperCase()}</span></div>
      <div class="row"><label>In memory</label><span>${(bytes.length / 1048576).toFixed(2)} MB</span></div>
      <button id="cforget" class="danger wide">Forget source file</button>`;
    side.querySelector('#cforget')?.addEventListener('click', () => {
      forgetConvSrc();
      renderConvertState();
      status('Conversion source wiped from memory.');
    });
  }
}

async function doConvert(): Promise<void> {
  if (!convSrc) return;
  const btn = $('#cgo') as HTMLButtonElement | null;
  const statusEl = $('#cstatus');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Working…';
  }
  if (statusEl) statusEl.textContent = 'Converting…';
  try {
    const { output, report } = await convertBytes(convSrc.name, convSrc.bytes, convTarget);
    const stem = convSrc.name.replace(/\.[^.]+$/, '');
    download(output.blob, `${stem}-docshift.${output.ext}`);
    const msg = `Converted ${report.blocks} block(s): ${report.source.toUpperCase()} → ${report.target.toUpperCase()} · ${(report.bytes / 1024).toFixed(0)} KB`;
    if (statusEl) statusEl.textContent = `${msg}. Download started.`;
    status(`${msg}.`);
  } catch (err) {
    const m = (err as Error).message;
    if (statusEl) statusEl.textContent = `Conversion failed: ${m}`;
    status(`Conversion failed: ${m}`);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Convert & download';
    }
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

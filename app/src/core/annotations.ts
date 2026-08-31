/**
 * annotations.ts — the overlay editor.
 *
 * Annotations are DOM elements positioned over the rendered page in PDF points,
 * scaled to the current zoom. They are non-destructive: the underlying document
 * is untouched until you export.
 */
import type { Annotation } from './state';
import { updateAnnotation, removeAnnotation, getSession } from './state';

export type Tool = 'select' | 'text' | 'image' | 'signature' | 'whiteout' | 'redact' | 'field';

let selectedId: string | null = null;

export function getSelected(): string | null {
  return selectedId;
}
export function setSelected(id: string | null): void {
  selectedId = id;
  document
    .querySelectorAll<HTMLElement>('.ann.selected')
    .forEach((el) => el.classList.remove('selected'));
  if (id) document.querySelector<HTMLElement>(`[data-id="${id}"]`)?.classList.add('selected');
  const props = document.getElementById('props');
  if (props) renderProps(props, id);
}

function ptToPx(v: number, zoom: number): number {
  return v * zoom;
}

export function renderAnnotations(container: HTMLElement, page: number, zoom: number): void {
  container.querySelectorAll('.ann').forEach((el) => el.remove());
  const session = getSession();
  if (!session) return;
  for (const a of session.annotations) {
    if (a.page !== page) continue;
    container.appendChild(makeElement(a, zoom));
  }
  if (selectedId) {
    document.querySelector<HTMLElement>(`[data-id="${selectedId}"]`)?.classList.add('selected');
  }
}

function makeElement(a: Annotation, zoom: number): HTMLElement {
  const el = document.createElement('div');
  el.className = `ann ann-${a.kind}`;
  el.dataset.id = a.id;
  el.style.left = `${ptToPx(a.x, zoom)}px`;
  el.style.top = `${ptToPx(a.y, zoom)}px`;
  el.style.width = `${ptToPx(a.width, zoom)}px`;
  el.style.height = `${ptToPx(a.height, zoom)}px`;

  if (a.kind === 'whiteout') {
    el.style.background = '#fff';
  } else if (a.kind === 'redact') {
    // Shown as a red dashed outline while editing so you can see exactly what
    // will be destroyed. On export it becomes nothing at all — the content is gone.
    el.title = `Will permanently delete: "${a.coveredText.slice(0, 120)}"`;
  } else if (a.kind === 'text') {
    el.style.color = a.color;
    el.style.fontSize = `${ptToPx(a.fontSize, zoom)}px`;
    el.style.textAlign = a.align;
    el.textContent = a.value;
  } else if (a.kind === 'image') {
    const img = document.createElement('img');
    // data: URL built from in-memory bytes. No network, no storage.
    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < a.bytes.length; i += CHUNK) {
      binary += String.fromCharCode(...a.bytes.subarray(i, i + CHUNK));
    }
    const isPng = a.bytes[0] === 0x89 && a.bytes[1] === 0x50;
    img.src = `data:image/${isPng ? 'png' : 'jpeg'};base64,${btoa(binary)}`;
    img.style.width = '100%';
    img.style.height = '100%';
    img.style.opacity = String(a.opacity);
    img.draggable = false;
    el.appendChild(img);
  } else if (a.kind === 'field') {
    el.title = `Field: ${a.name}`;
    const label = document.createElement('span');
    label.className = 'field-label';
    label.textContent = a.name;
    el.appendChild(label);
  }

  const handle = document.createElement('div');
  handle.className = 'resize';
  el.appendChild(handle);

  el.addEventListener('pointerdown', (ev) => {
    if (ev.target === handle) return;
    ev.stopPropagation();
    setSelected(a.id);
    startDrag(ev, el, a, zoom);
  });
  handle.addEventListener('pointerdown', (ev) => {
    ev.stopPropagation();
    setSelected(a.id);
    startResize(ev, el, a, zoom);
  });
  return el;
}

function startDrag(ev: PointerEvent, el: HTMLElement, a: Annotation, zoom: number): void {
  const startX = ev.clientX;
  const startY = ev.clientY;
  const origX = a.x;
  const origY = a.y;
  const move = (e: PointerEvent) => {
    const nx = origX + (e.clientX - startX) / zoom;
    const ny = origY + (e.clientY - startY) / zoom;
    el.style.left = `${nx * zoom}px`;
    el.style.top = `${ny * zoom}px`;
    updateAnnotation(a.id, { x: Math.round(nx), y: Math.round(ny) } as Partial<Annotation>);
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

function startResize(ev: PointerEvent, el: HTMLElement, a: Annotation, zoom: number): void {
  const startX = ev.clientX;
  const startY = ev.clientY;
  const origW = a.width;
  const origH = a.height;
  const move = (e: PointerEvent) => {
    const nw = Math.max(8, origW + (e.clientX - startX) / zoom);
    const nh = Math.max(8, origH + (e.clientY - startY) / zoom);
    el.style.width = `${nw * zoom}px`;
    el.style.height = `${nh * zoom}px`;
    updateAnnotation(a.id, { width: Math.round(nw), height: Math.round(nh) } as Partial<Annotation>);
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

/** Properties panel for the selected annotation. */
export function renderProps(host: HTMLElement, id: string | null): void {
  const session = getSession();
  const a = session?.annotations.find((x) => x.id === id);
  if (!a) {
    host.innerHTML = '<p class="muted">Select an item to edit its properties.</p>';
    return;
  }
  host.innerHTML = `
    <div class="row"><label>Kind</label><span>${a.kind}</span></div>
    ${
      a.kind === 'text'
        ? `<div class="row"><label>Text</label>
             <textarea data-prop="value" rows="3">${escapeHtml(a.value)}</textarea></div>
           <div class="row"><label>Size</label>
             <input type="number" data-prop="fontSize" min="4" max="200" value="${a.fontSize}"></div>
           <div class="row"><label>Colour</label>
             <input type="color" data-prop="color" value="${a.color}"></div>
           <div class="row"><label>Align</label>
             <select data-prop="align">
               <option value="left"${a.align === 'left' ? ' selected' : ''}>left</option>
               <option value="center"${a.align === 'center' ? ' selected' : ''}>centre</option>
               <option value="right"${a.align === 'right' ? ' selected' : ''}>right</option>
             </select></div>`
        : ''
    }
    ${
      a.kind === 'image'
        ? `<div class="row"><label>Opacity</label>
             <input type="range" data-prop="opacity" min="0.05" max="1" step="0.05" value="${a.opacity}"></div>`
        : ''
    }
    ${
      a.kind === 'field'
        ? `<div class="row"><label>Name</label><input type="text" data-prop="name" value="${escapeHtml(a.name)}"></div>
           <div class="row"><label>Value</label><input type="text" data-prop="value" value="${escapeHtml(a.value)}"></div>`
        : ''
    }
    ${a.kind === 'redact' ? `<p class="warn">Export will <b>permanently delete</b>:<br><code>${escapeHtml(a.coveredText.slice(0, 200))}</code></p>` : ''}
    <div class="row"><button id="del-ann" class="danger">Delete</button></div>
  `;
  host.querySelectorAll<HTMLElement>('[data-prop]').forEach((input) => {
    input.addEventListener('input', () => {
      const key = input.dataset.prop as string;
      const raw =
        input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement
          ? input.value
          : '';
      const value =
        key === 'fontSize' ? Number(raw) : key === 'opacity' ? Number(raw) : raw;
      updateAnnotation(a.id, { [key]: value } as Partial<Annotation>);
      const page = document.querySelector<HTMLElement>(`[data-page="${a.page}"] .overlay`);
      if (page) renderAnnotations(page, a.page, currentZoom());
    });
  });
  host.querySelector('#del-ann')?.addEventListener('click', () => {
    removeAnnotation(a.id);
    setSelected(null);
  });
}

let zoomRef = 1;
export function setZoomRef(z: number): void {
  zoomRef = z;
}
function currentZoom(): number {
  return zoomRef;
}

export function deleteSelected(): void {
  if (selectedId) {
    removeAnnotation(selectedId);
    setSelected(null);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

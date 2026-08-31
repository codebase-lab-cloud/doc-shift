/**
 * signature-pad.ts — get a signature as PNG bytes, two ways:
 *   1. draw it on a canvas, or
 *   2. upload a scanned image of it (PNG/JPG) — re-encoded in this tab so any
 *      EXIF/GPS/device metadata the phone baked into the photo is stripped.
 * The bytes live in memory and are stamped onto the page. Never stored.
 */
export function openSignaturePad(): Promise<Uint8Array | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-backdrop';
    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-label="Add your signature">
        <h2>Signature</h2>
        <p class="muted">Draw below, or upload a photo/scan of your signature.
        Uploaded images are re-encoded in this tab, which strips EXIF/GPS metadata.
        Nothing is saved anywhere.</p>
        <canvas id="sig-canvas" width="640" height="240"></canvas>
        <div class="sig-divider"><span>or</span></div>
        <button id="sig-upload" class="wide">Upload signature image (PNG / JPG)…</button>
        <input type="file" id="sig-file" accept="image/png,image/jpeg,.png,.jpg,.jpeg" hidden />
        <div class="modal-actions">
          <button id="sig-clear">Clear</button>
          <button id="sig-cancel">Cancel</button>
          <button id="sig-ok" class="primary">Use signature</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const upload = overlay.querySelector<HTMLButtonElement>('#sig-upload')!;
    const fileInput = overlay.querySelector<HTMLInputElement>('#sig-file')!;
    upload.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      const f = fileInput.files?.[0];
      if (!f) return;
      upload.disabled = true;
      upload.textContent = 'Reading…';
      f.arrayBuffer()
        .then((buf) => stripImageMetadata(new Uint8Array(buf)))
        .then((stripped) => close(stripped))
        .catch(() => close(null));
    });

    const canvas = overlay.querySelector<HTMLCanvasElement>('#sig-canvas')!;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#101418';

    let drawing = false;
    let empty = true;
    const pos = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      return { x: (e.clientX - r.left) * (canvas.width / r.width), y: (e.clientY - r.top) * (canvas.height / r.height) };
    };
    canvas.addEventListener('pointerdown', (e) => {
      drawing = true;
      empty = false;
      const p = pos(e);
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!drawing) return;
      const p = pos(e);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
    });
    const stop = () => {
      drawing = false;
    };
    canvas.addEventListener('pointerup', stop);
    canvas.addEventListener('pointercancel', stop);

    const close = (result: Uint8Array | null) => {
      overlay.remove();
      resolve(result);
    };
    overlay.querySelector('#sig-clear')!.addEventListener('click', () => {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      empty = true;
    });
    overlay.querySelector('#sig-cancel')!.addEventListener('click', () => close(null));
    overlay.querySelector('#sig-ok')!.addEventListener('click', () => {
      if (empty) {
        close(null);
        return;
      }
      canvas.toBlob((blob) => {
        if (!blob) {
          close(null);
          return;
        }
        blob
          .arrayBuffer()
          .then((buf) => close(new Uint8Array(buf)))
          .catch(() => close(null));
      }, 'image/png');
    });
    overlay.addEventListener('pointerdown', (e) => {
      if (e.target === overlay) close(null);
    });
  });
}

/** Strip EXIF/XMP from a JPEG/PNG by re-encoding through a canvas.
 *  Phone photos carry GPS coordinates and device details; this removes them. */
export async function stripImageMetadata(bytes: Uint8Array): Promise<Uint8Array> {
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
  const srcUrl = URL.createObjectURL(new Blob([bytes as unknown as BlobPart]));
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error('Could not decode image'));
      i.src = srcUrl;
    });
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    const blob = await new Promise<Blob | null>((res) =>
      canvas.toBlob(res, isPng ? 'image/png' : 'image/jpeg', 0.92),
    );
    if (!blob) return bytes;
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    URL.revokeObjectURL(srcUrl);
  }
}

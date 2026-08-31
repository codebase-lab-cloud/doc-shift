/**
 * state.ts — the entire application state. It lives in a module-scoped object,
 * in memory, and nowhere else. There is no database, no file, no cache.
 *
 * Two rules that follow from the storage-free contract:
 *  1. Nothing here is ever serialized to disk or to a storage API.
 *  2. The user's ORIGINAL bytes are never mutated. Edits are a replayable list.
 */

export type Annotation =
  | {
      id: string;
      kind: 'text';
      page: number;
      x: number;
      y: number;
      width: number;
      height: number;
      value: string;
      fontSize: number;
      color: string;
      align: 'left' | 'center' | 'right';
    }
  | {
      id: string;
      kind: 'image';
      page: number;
      x: number;
      y: number;
      width: number;
      height: number;
      /** PNG/JPEG bytes held in memory. Never written to disk. */
      bytes: Uint8Array;
      opacity: number;
    }
  | {
      id: string;
      kind: 'whiteout';
      page: number;
      x: number;
      y: number;
      width: number;
      height: number;
    }
  | {
      id: string;
      kind: 'redact';
      page: number;
      x: number;
      y: number;
      width: number;
      height: number;
      /** The text this box covered, captured at creation time so the export
       *  verification pass can prove it is gone. */
      coveredText: string;
    }
  | {
      id: string;
      kind: 'field';
      page: number;
      x: number;
      y: number;
      width: number;
      height: number;
      name: string;
      fieldType: 'text' | 'multiline' | 'checkbox';
      value: string;
      checked: boolean;
    };

export type PageTextLine = {
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  size: number;
};

export type Session = {
  fileName: string;
  /** The bytes exactly as the user gave them to us. Never modified. */
  originalBytes: Uint8Array;
  pageCount: number;
  /** PDF points (1/72 inch) per page. */
  pageSizes: { width: number; height: number }[];
  annotations: Annotation[];
  redactionsApplied: boolean;
  metadataScrubbed: boolean;
  openedAt: number;
};

let session: Session | null = null;
const listeners = new Set<() => void>();

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function notify(): void {
  for (const l of listeners) l();
}

export function getSession(): Session | null {
  return session;
}

export function setSession(s: Session | null): void {
  session = s;
  notify();
}

/**
 * Wipe the session. This is the "Destroy session" button and the pagehide handler.
 *
 * Zeroing the buffers is not a cryptographic guarantee — the OS owns the memory
 * once it is freed — but it removes the obvious residue and it means a later
 * allocation is less likely to hand our bytes to something else.
 */
export function destroySession(): void {
  if (session) {
    session.originalBytes.fill(0);
    for (const a of session.annotations) {
      if (a.kind === 'image') a.bytes.fill(0);
      if (a.kind === 'text') a.value = '';
      if (a.kind === 'field') a.value = '';
      if (a.kind === 'redact') a.coveredText = '';
    }
    session.annotations.length = 0;
  }
  session = null;
  notify();
}

let counter = 0;
export function newId(): string {
  counter += 1;
  return `a${counter.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function addAnnotation(a: Annotation): void {
  session?.annotations.push(a);
  notify();
}

export function updateAnnotation(id: string, patch: Partial<Annotation>): void {
  const a = session?.annotations.find((x) => x.id === id);
  if (!a) return;
  Object.assign(a, patch);
  notify();
}

export function removeAnnotation(id: string): void {
  if (!session) return;
  const i = session.annotations.findIndex((x) => x.id === id);
  if (i >= 0) {
    const [gone] = session.annotations.splice(i, 1);
    if (gone.kind === 'image') gone.bytes.fill(0);
  }
  notify();
}

export function clearPage(page: number): void {
  if (!session) return;
  for (const a of session.annotations) if (a.kind === 'image' && a.page === page) a.bytes.fill(0);
  session.annotations = session.annotations.filter((a) => a.page !== page);
  notify();
}

/** Everything currently held in memory, for the session panel. No content, only counts. */
export function memoryInventory(): {
  fileName: string | null;
  pages: number;
  annotations: number;
  byKind: Record<string, number>;
  approxBytes: number;
} {
  if (!session) {
    return { fileName: null, pages: 0, annotations: 0, byKind: {}, approxBytes: 0 };
  }
  const byKind: Record<string, number> = {};
  for (const a of session.annotations) byKind[a.kind] = (byKind[a.kind] ?? 0) + 1;
  let approxBytes = session.originalBytes.length;
  for (const a of session.annotations) if (a.kind === 'image') approxBytes += a.bytes.length;
  return {
    fileName: session.fileName,
    pages: session.pageCount,
    annotations: session.annotations.length,
    byKind,
    approxBytes,
  };
}

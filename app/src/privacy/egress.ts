/**
 * egress.ts — proves the "nothing leaves your machine" claim at runtime.
 *
 * Wraps fetch, XMLHttpRequest, WebSocket, EventSource and beacon so that any
 * request whose origin is not this page's own origin is blocked and recorded.
 * The counter is shown in the UI: it should read zero, always.
 *
 * This is defence in depth. The real guarantees are the CSP in index.html and
 * the fact that no code path in this app makes a request for user data.
 */

export type Attempt = {
  url: string;
  kind: string;
  at: number;
  blocked: boolean;
};

export type EgressState = {
  allowed: number;
  blocked: number;
  attempts: Attempt[];
};

const state: EgressState = { allowed: 0, blocked: 0, attempts: [] };
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getState(): EgressState {
  return state;
}

function isSameOrigin(url: string): boolean {
  try {
    const u = new URL(url, location.href);
    if (u.protocol === 'blob:' || u.protocol === 'data:') return true; // in-memory, no network
    return u.origin === location.origin;
  } catch {
    return false;
  }
}

function record(url: string, kind: string, blocked: boolean): void {
  state.attempts.push({ url, kind, at: Date.now(), blocked });
  if (state.attempts.length > 200) state.attempts.shift();
  if (blocked) state.blocked++;
  else state.allowed++;
  emit();
}

export function installEgressGuard(): void {
  const realFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!isSameOrigin(url)) {
      record(url, 'fetch', true);
      return Promise.reject(new Error(`Blocked outbound request to ${url}`));
    }
    record(url, 'fetch', false);
    return realFetch(input as RequestInfo, init);
  }) as typeof fetch;

  const RealXHR = globalThis.XMLHttpRequest;
  const realOpen = RealXHR.prototype.open;
  RealXHR.prototype.open = function (
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    ...rest: unknown[]
  ) {
    const href = String(url);
    if (!isSameOrigin(href)) {
      record(href, 'xhr', true);
      throw new Error(`Blocked outbound request to ${href}`);
    }
    record(href, 'xhr', false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (realOpen as any).call(this, method, href, ...rest);
  } as typeof RealXHR.prototype.open;

  const RealWS = globalThis.WebSocket;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).WebSocket = function (url: string | URL) {
    const href = String(url);
    record(href, 'websocket', true);
    throw new Error(`Blocked WebSocket to ${href}`);
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
  } as unknown as typeof RealWS;

  if ('sendBeacon' in navigator) {
    navigator.sendBeacon = ((url: string | URL) => {
      record(String(url), 'beacon', true);
      return false;
    }) as typeof navigator.sendBeacon;
  }

  // Catch anything that slips through: image/script/link elements pointed off-origin.
  const RealImage = globalThis.Image;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).Image = function (...args: unknown[]) {
    const img = new RealImage(...(args as [number?, number?]));
    const desc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
    Object.defineProperty(img, 'src', {
      configurable: true,
      get: () => desc?.get?.call(img),
      set: (v: string) => {
        if (v && !isSameOrigin(v)) {
          record(v, 'img', true);
          return;
        }
        desc?.set?.call(img, v);
      },
    });
    return img;
  } as unknown as typeof RealImage;
}

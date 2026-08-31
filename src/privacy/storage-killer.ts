/**
 * storage-killer.ts — MUST be the first import in main.ts.
 *
 * The promise "we store nothing" cannot rest on discipline. Any dependency could
 * decide to cache. So we make the storage APIs structurally unavailable: touching
 * one throws immediately, in development, where we will see it.
 *
 * Verified in docs/verification-report.md: localStorage and IndexedDB write
 * plaintext to the browser profile and it survives a clean browser close.
 */

const BANNED = [
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'caches',
  'openDatabase',
] as const;

export const violations: string[] = [];

function kill(target: object, key: string): void {
  try {
    Object.defineProperty(target, key, {
      configurable: false,
      enumerable: false,
      get() {
        const msg = `DocShift is storage-free: "${key}" is disabled by design.`;
        violations.push(key);
        // Surface it loudly rather than failing silently.
        console.warn('[privacy] blocked access to ' + key);
        throw new Error(msg);
      },
      set() {
        violations.push(key);
        throw new Error(`DocShift is storage-free: cannot assign "${key}".`);
      },
    });
  } catch {
    // Some engines refuse to redefine these. Record it; the CI audit still applies.
    violations.push(`${key}:undefinable`);
  }
}

export function enforceNoStorage(): void {
  for (const key of BANNED) kill(globalThis as unknown as object, key);

  // Cookies: no reading, no writing.
  try {
    Object.defineProperty(Document.prototype, 'cookie', {
      configurable: false,
      enumerable: false,
      get: () => '',
      set: () => {
        violations.push('cookie');
        throw new Error('DocShift is storage-free: cookies are disabled.');
      },
    });
  } catch {
    violations.push('cookie:undefinable');
  }

  // A service worker cache IS a store. Refuse to register one.
  try {
    if ('serviceWorker' in navigator) {
      Object.defineProperty(navigator, 'serviceWorker', {
        configurable: false,
        enumerable: false,
        get() {
          violations.push('serviceWorker');
          throw new Error('DocShift is storage-free: service workers are disabled.');
        },
      });
    }
  } catch {
    violations.push('serviceWorker:undefinable');
  }
}

/** True if every storage API was successfully disabled. Shown in the UI. */
export function storageLockdownComplete(): boolean {
  return violations.filter((v) => v.endsWith(':undefinable')).length === 0;
}

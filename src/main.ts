/**
 * main.ts — entry point.
 *
 * Import order matters: the storage killer must run before anything else, so that
 * no module — ours or a dependency's — can quietly open a storage API.
 */
import { enforceNoStorage } from './privacy/storage-killer';
enforceNoStorage();

import { installEgressGuard } from './privacy/egress';
import { destroySession } from './core/state';
import { close as closePdf } from './core/pdf';
import { mount } from './ui/app';

installEgressGuard();

mount();

/**
 * Teardown. Called on tab close, navigation away, and by the Destroy button.
 *
 * Zeroing buffers is not a cryptographic guarantee — once memory is freed the OS
 * owns it — but it removes the obvious residue. Combined with the fact that we
 * never call a storage API, this is the whole of our persistence story.
 */
function teardown(): void {
  destroySession();
  closePdf();
}

window.addEventListener('pagehide', teardown);
window.addEventListener('beforeunload', teardown);

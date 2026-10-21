// Build identity, served so the client can prove which build it is running.
//
// The reason this exists: reloads used to bust the cache with a `?r=<timestamp>`
// query, which made every load a *different URL* — and the headset browser opens
// a new window per distinct URL. After a few iterations there was a stack of
// identical-looking windows and no way to tell which was current.
//
// Instead the build gets a stable short id derived from its source, and the page
// shows it. Reloads now hit one URL, so there is one window.

import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

const SOURCES = ['index.html', 'app.js', 'layout.js'];

export async function buildId(root) {
  const h = createHash('sha1');
  for (const rel of SOURCES) {
    const path = join(root, rel);
    try {
      h.update(await readFile(path));
    } catch {
      h.update(`missing:${rel}`);
    }
    // Include mtime so an edit that does not change bytes (same content) still
    // invalidates a stale cached copy on the device.
    try {
      h.update(String((await stat(path)).mtimeMs));
    } catch { /* already handled */ }
  }
  return h.digest('hex').slice(0, 8);
}
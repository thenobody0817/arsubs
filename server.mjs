// Static file server for the Quest passthrough client.
// Served over http://localhost so that, behind `adb reverse`, the headset
// browser treats it as a secure context and WebXR is permitted (no TLS needed).
import { createServer } from 'node:http';
import { readFile, appendFile, mkdir } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildId } from './build.mjs';

const DIR = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(DIR, 'public');
const LOG = join(DIR, 'logs', 'client.log');
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';

// The Quest 3 refuses `adb exec-out screencap` (VR surfaces are FLAG_SECURE), so
// the headset client reports its own state here. That makes the device
// observable from the host without a mirror app or a screenshot.
let lastState = {};
const history = [];
let logChain = Promise.resolve();

async function record(entry) {
  const line = `${new Date().toISOString()} ${JSON.stringify(entry)}`;
  // Only the headset's own reports become current state; host curls and the like
  // must not overwrite what the device last said about itself.
  if (!entry.page || entry.page !== 'host') {
    lastState = { ...lastState, ...entry, at: new Date().toISOString() };
    history.push(entry.ev ?? 'entry');
  }
  console.log('client', line);
  // Serialise appends: the client posts bursts of events, and concurrent
  // appendFile calls on one path can interleave or stall behind each other.
  logChain = logChain
    .then(async () => {
      await mkdir(join(DIR, 'logs'), { recursive: true });
      await appendFile(LOG, `${line}\n`);
    })
    .catch(() => {});
  await logChain;
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

let build = 'unknown';

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  console.log(`${new Date().toISOString()} ${req.method} ${url.pathname}${url.search} ` +
    `ua="${(req.headers['user-agent'] || '').slice(0, 60)}"`);

  if (url.pathname === '/log') {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let entry = {};
    try { entry = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { /* ignore */ }
    await record({ ...entry, ua: req.headers['user-agent'], page: url.searchParams.get('page') || undefined });
    res.writeHead(204).end();
    return;
  }

  if (url.pathname === '/build') {
    // Recompute here rather than at startup: an edit must change the id
    // immediately, otherwise the client's autoreload sees no difference and the
    // headset happily keeps serving a stale build.
    build = await buildId(ROOT);
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ build, page: lastState.page ?? null }));
    return;
  }

  if (url.pathname === '/state') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ...lastState, events: history.slice(-12) }, null, 2));
    return;
  }

  const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
  const path = join(ROOT, rel === '/' ? 'index.html' : rel);

  if (!path.startsWith(ROOT)) {
    res.writeHead(403).end('forbidden');
    return;
  }

  try {
    const body = await readFile(path);
    res.writeHead(200, {
      'content-type': TYPES[extname(path)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  }
});

// Recompute on every request so an edit is reflected immediately, and hand the
// id to the client. Serving the same URL every time keeps one browser window.
build = await buildId(ROOT);

server.listen(PORT, HOST, async () => {
  console.log(`arsubs serving ${ROOT}`);
  console.log(`  build ${build}`);
  console.log(`  http://${HOST}:${PORT}/    (adb reverse tcp:${PORT} tcp:${PORT})`);
  console.log(`  one URL, one window — the build id above tells you which is loaded`);
});

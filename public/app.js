// M2 — WebXR passthrough with a draggable, rescalable, persistent text panel.
//
// Still no camera access: the Quest 3 compositor already shows the room in real
// light, and rendering the passthrough feed on top of that would double every
// face. The camera becomes an input in M3, once the panel placement is dialed in.
//
// All placement math lives in layout.js, which is deliberately free of XR and
// DOM so the Android client can share it.

import {
  PRESETS, BASE, LIMITS, defaultLayout, clampLayout, anchorFor, stickRate,
} from './layout.js';

// The headset has Roboto and Noto Sans CJK but nothing carrying Latvian
// diacritics, which is why the Latvian sample came out as tofu. These three
// subsets cover Latin, Latin Extended-A and Cyrillic for ~220 kB; Chinese rides
// on the headset's own Noto Sans CJK rather than a 20 MB bundle.
const FONT_FACES = [
  ['600 64px "Arsubs Sans"', 'noto-sans-latin-ext.woff2'],
  ['600 64px "Arsubs Sans"', 'noto-sans-cyrillic.woff2'],
  ['600 64px "Arsubs Sans"', 'noto-sans-latin.woff2'],
  ['400 30px "Arsubs Mono"', 'noto-sans-latin-ext.woff2'],
  ['400 30px "Arsubs Mono"', 'noto-sans-cyrillic.woff2'],
  ['400 30px "Arsubs Mono"', 'noto-sans-latin.woff2'],
];
const MONO = 'ui-monospace, "Arsubs Mono", monospace';

const canvas = document.getElementById('gl');
const hud = document.getElementById('hud');
const status = document.getElementById('status');
const go = document.getElementById('go');
const dump = document.getElementById('dump');

// --- state ---------------------------------------------------------------------
const STORE_KEY = 'arsubs.layout.v1';

let layout = load();
let showReadout = true;
let dragging = null;   // { inputSource, grabOffset }
let presetIndex = 0;

const SAMPLE = [
  'Do you think this will work?',
  'Я говорю по-русски.',
  '你说中文吗？',
  'Vai sapikt par latviešu valodu?',
  'Skaņš ir garš, žņaudzīgs mājs.',
];
let sampleIndex = 0;

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return defaultLayout();
    return clampLayout({ ...defaultLayout(), ...JSON.parse(raw) });
  } catch {
    return defaultLayout();
  }
}

function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(layout)); } catch { /* private mode */ }
  const el = document.getElementById('dump');
  if (el && !el.hidden) el.textContent = JSON.stringify(layout, null, 2);
}

function preset() {
  const names = Object.keys(PRESETS);
  return PRESETS[names[presetIndex]];
}

function dumpJson() {
  const payload = { layout, preset: Object.keys(PRESETS)[presetIndex], limits: LIMITS };
  dump.hidden = false;
  dump.textContent = JSON.stringify(payload, null, 2);
  report({ ev: 'dump', layout });
}

// --- telemetry -----------------------------------------------------------------
// The Quest 3 refuses `adb exec-out screencap` (VR surfaces are FLAG_SECURE), so
// the client reports its own state to the host.
function report(extra) {
  return fetch(`/log?page=m2`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...extra, secure: isSecureContext, now: Date.now() }),
    keepalive: true,
  }).catch(() => {});
}

window.addEventListener('error', (e) => report({ ev: 'window.error', msg: e.message, line: e.lineno }));
window.addEventListener('unhandledrejection', (e) => report({ ev: 'rejection', msg: String(e.reason) }));

// --- build identity ------------------------------------------------------------
// Every reload used to hit a fresh ?r=<timestamp> URL, and the headset browser
// opens a new window per distinct URL. That left a stack of identical windows
// with no way to tell which was current. Now there is one URL and one window,
// and the build id is printed here so you can always tell what is loaded.
async function showBuild() {
  const el = document.getElementById('build');
  try {
    const r = await fetch('/build', { cache: 'no-store' });
    const { build } = await r.json();
    el.innerHTML = `build <b>${build}</b> · one window, reload in place`;
    BUILD_ID = build;
    report({ ev: 'build', build });
  } catch {
    el.textContent = 'build — (cannot reach host)';
  }
}
let BUILD_ID = null;

if (new URLSearchParams(location.search).has('autoreload')) {
  // Poll the host and reload this same tab when the build changes. No new URL,
  // so no new window on the headset.
  setInterval(async () => {
    try {
      const { build } = await fetch('/build', { cache: 'no-store' }).then((r) => r.json());
      if (BUILD_ID && build !== BUILD_ID) location.reload();
    } catch { /* headset may be asleep; try again next tick */ }
  }, 2000);
}

showBuild();
report({ ev: 'load', xr: !!navigator.xr });

// --- gl ------------------------------------------------------------------------
const gl = canvas.getContext('webgl2', {
  xrCompatible: true, alpha: true, antialias: true, premultipliedAlpha: true, depth: true,
});

const VERT = `#version 300 es
in vec2 aPos;
in vec2 aUV;
uniform mat4 uViewProj;
uniform mat4 uModel;
out vec2 vUV;
void main() {
  vUV = aUV;
  gl_Position = uViewProj * uModel * vec4(aPos, 0.0, 1.0);
}`;

// The XR layer composites premultiplied alpha, so premultiply and blend with
// (ONE, ONE_MINUS_SRC_ALPHA).
const FRAG = `#version 300 es
precision mediump float;
in vec2 vUV;
uniform sampler2D uTex;
uniform sampler2D uCursor;
uniform float uIsCursor;
out vec4 outColor;
void main() {
  // Select the sampler with a branch rather than a ternary: opaque types
  // (samplers) cannot be operands of ?: in GLSL ES 3.0.
  vec4 c;
  if (uIsCursor > 0.5) c = texture(uCursor, vUV);
  else c = texture(uTex, vUV);
  outColor = vec4(c.rgb * c.a, c.a);
}`;

let prog, vao, uViewProj, uModel, uTex, uCursor, uIsCursor;

function compile(type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
  return sh;
}

function initGl() {
  prog = gl.createProgram();
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  gl.useProgram(prog);

  vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    -1, -1, 0, 1,
    1, -1, 1, 1,
    -1, 1, 0, 0,
    1, 1, 1, 0,
  ]), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(prog, 'aPos');
  const aUV = gl.getAttribLocation(prog, 'aUV');
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 16, 0);
  gl.enableVertexAttribArray(aUV);
  gl.vertexAttribPointer(aUV, 2, gl.FLOAT, false, 16, 8);
  gl.bindVertexArray(null);

  uViewProj = gl.getUniformLocation(prog, 'uViewProj');
  uModel = gl.getUniformLocation(prog, 'uModel');
  uTex = gl.getUniformLocation(prog, 'uTex');
  uCursor = gl.getUniformLocation(prog, 'uCursor');
  uIsCursor = gl.getUniformLocation(prog, 'uIsCursor');

  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.disable(gl.DEPTH_TEST);
}

function mul(a, b) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
  }
  return o;
}

function modelMatrix(l) {
  return new Float32Array([
    BASE.width * l.scale, 0, 0, 0,
    0, BASE.height * l.scale, 0, 0,
    0, 0, 1, 0,
    l.x, l.y, -l.z, 1,
  ]);
}

// --- text texture --------------------------------------------------------------
const TEXT_W = 1024;
const TEXT_H = 320;
const textCanvas = document.createElement('canvas');
textCanvas.width = TEXT_W;
textCanvas.height = TEXT_H;
const tctx = textCanvas.getContext('2d');
let dirty = true;

function readoutLine() {
  return `x ${layout.x.toFixed(2)}  y ${layout.y.toFixed(2)}  z ${layout.z.toFixed(2)} m`
    + `  scale ${layout.scale.toFixed(2)}`;
}

function drawText() {
  tctx.clearRect(0, 0, TEXT_W, TEXT_H);
  const text = SAMPLE[sampleIndex];
  const baseFont = '600 64px "Arsubs Sans", system-ui, sans-serif';

  tctx.font = baseFont;
  tctx.textAlign = 'center';
  tctx.textBaseline = 'middle';
  tctx.lineJoin = 'round';

  const w = Math.min(TEXT_W - 16, tctx.measureText(text).width + 96);
  const h = 120;
  const cy = showReadout ? 130 : (TEXT_H - h) / 2;
  const x = (TEXT_W - w) / 2;
  const y = cy - h / 2;

  // The panel floats over an arbitrary real room, so legibility cannot depend on
  // the background being dark. A translucent pill plus a dark stroke.
  tctx.beginPath();
  tctx.roundRect(x, y, w, h, 28);
  tctx.fillStyle = 'rgba(0,0,0,0.55)';
  tctx.fill();

  tctx.font = baseFont;
  tctx.lineWidth = 10;
  tctx.strokeStyle = 'rgba(0,0,0,0.9)';
  tctx.strokeText(text, TEXT_W / 2, cy);
  tctx.fillStyle = '#ffffff';
  tctx.fillText(text, TEXT_W / 2, cy);

  if (showReadout) {
    tctx.font = `400 30px ${MONO}`;
    tctx.lineWidth = 8;
    tctx.strokeStyle = 'rgba(0,0,0,0.9)';
    tctx.strokeText(readoutLine(), TEXT_W / 2, 252);
    tctx.fillStyle = '#7dd3a0';
    tctx.fillText(readoutLine(), TEXT_W / 2, 252);
  }
  dirty = true;
}

const tex = gl.createTexture();
const cursorTex = gl.createTexture();

function initTex() {
  for (const [t, filter] of [[tex, gl.LINEAR], [cursorTex, gl.LINEAR]]) {
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }
  gl.activeTexture(gl.TEXTURE0);
  gl.uniform1i(uTex, 0);
  gl.activeTexture(gl.TEXTURE1);
  gl.uniform1i(uCursor, 1);
  gl.activeTexture(gl.TEXTURE0);
}

// The cursor is the affordance that makes direct manipulation legible: solid
// when the pointer is on the text and a grab will take, hollow when it is not.
const CURSOR_SIZE = 128;
const cursorCanvas = document.createElement('canvas');
cursorCanvas.width = cursorCanvas.height = CURSOR_SIZE;
const cctx = cursorCanvas.getContext('2d');

function drawCursor() {
  cctx.clearRect(0, 0, CURSOR_SIZE, CURSOR_SIZE);
  const c = CURSOR_SIZE / 2;
  const grabbed = !!dragging;
  const onTarget = hover && !hover.miss;
  cctx.lineWidth = 9;
  cctx.strokeStyle = grabbed ? 'rgba(125,211,160,0.95)'
    : onTarget ? 'rgba(255,255,255,0.95)' : 'rgba(150,150,160,0.55)';
  if (onTarget || grabbed) {
    cctx.beginPath();
    cctx.arc(c, c, grabbed ? 26 : 40, 0, Math.PI * 2);
    cctx.stroke();
  }
  cctx.beginPath();
  cctx.arc(c, c, grabbed ? 9 : 5, 0, Math.PI * 2);
  cctx.fillStyle = grabbed ? 'rgba(125,211,160,0.95)' : 'rgba(255,255,255,0.9)';
  cctx.fill();
  gl.bindTexture(gl.TEXTURE_2D, cursorTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cursorCanvas);
}

function uploadText() {
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, textCanvas);
  dirty = false;
}

// --- fonts ---------------------------------------------------------------------
async function loadFonts() {
  const uniq = [...new Set(FONT_FACES.map(([, file]) => file))];
  let loaded = 0;
  await Promise.all(uniq.map((file) => document.fonts.load(`600 64px "Arsubs Sans"`, 'āČя?')));
  for (const [font, file] of FONT_FACES) {
    const face = new FontFace('Arsubs Sans', `url(fonts/${file})`, { weight: font.split(' ')[0] });
    try { await face.load(); document.fonts.add(face); loaded++; } catch { /* subset optional */ }
  }
  // Verify the glyphs that actually broke, rather than trusting the load events.
  const probe = (f) => {
    tctx.font = f;
    return {
      latvian: tctx.measureText('āČēģīķļņšūž').width,
      cjk: tctx.measureText('你说中文吗').width,
    };
  };
  const sans = probe('64px "Arsubs Sans"');
  const sys = probe('64px system-ui');
  report({
    ev: 'fonts',
    faces: loaded,
    sansWidth: sans.latvian,
    sysWidth: sys.latvian,
    // If the bundled face measures Latvian identically to the fallback, the
    // subsets did not take and the tofu will still be there.
    latinOk: Math.abs(sans.latvian - sys.latvian) > 1 || sans.latvian > 1,
    cjkOk: sans.cjk > 1,
  });
  drawText();
}

// --- input ---------------------------------------------------------------------
function readSticks(src) {
  const gp = src.gamepad;
  if (!gp || gp.axes.length < 4) return null;
  return { x: gp.axes[2], y: gp.axes[3], lx: gp.axes[0], ly: gp.axes[1] };
}

function pressed(gp, index) {
  return !!gp?.buttons?.[index]?.pressed;
}

// Ray from a controller into the world, for dragging.
function rayOf(frame, refSpace, src) {
  const pose = frame.getPose(src.targetRaySpace, refSpace);
  if (!pose) return null;
  const m = pose.transform.matrix;
  // -Z of the target ray space is the pointing direction.
  return {
    origin: [m[12], m[13], m[14]],
    dir: [-m[8], -m[9], -m[10]],
  };
}

function applySticks(dt) {
  if (!session) return;
  for (const src of session.inputSources) {
    const gp = src.gamepad;
    if (!gp) continue;

    // Right stick: vertical is distance, horizontal is text size. Kept separate
    // so that pushing the panel away does not silently shrink the type.
    const stick = readSticks(src);
    if (stick) {
      layout.z -= stickRate(stick.y, dt, { speed: 2.2 });
      layout.scale += stickRate(stick.x, dt, { speed: 1.1 });
      // Left stick: fine nudge, slower than the right.
      layout.x += stickRate(stick.lx, dt, { deadzone: 0.22, speed: 0.7 });
      layout.y += stickRate(stick.ly, dt, { deadzone: 0.22, speed: 0.7 });
    }

    if (pressed(gp, 7)) startDrag(frame, src);
    else if (dragging && dragging.inputSource === src) endDrag();

    if (pressed(gp, 4)) {  // X / A — cycle presets
      presetIndex = (presetIndex + 1) % Object.keys(PRESETS).length;
      layout = clampLayout({ ...layout, ...preset() });
      drawText(); save();
    }
    if (pressed(gp, 5)) {  // Y / B — next sample
      sampleIndex = (sampleIndex + 1) % SAMPLE.length;
      drawText();
    }
    if (pressed(gp, 11)) { // grip — readout
      showReadout = !showReadout;
      drawText();
    }
    if (pressed(gp, 8) && pressed(gp, 9)) { // menu + squeeze: reset
      layout = defaultLayout();
      presetIndex = 0;
      drawText(); save();
    }
  }
  layout = clampLayout(layout);
  dirty = true;
}

// --- direct manipulation -------------------------------------------------------
// The instinct people have is "put my hand on the thing and move it", not
// "nudge a stick and watch a plane translate". So the pointer picks the panel,
// the grab point is remembered so the text does not snap-centre to the cursor,
// and dragging follows the pointer through the grab offset.
//
// The drag surface is a plane through the panel facing the viewer. That keeps
// lateral motion 1:1 with the pointer, which a world-axis plane does not: lean
// sideways and a Z-plane makes the panel shoot away sideways.

// Where the pointer ray meets the panel's own plane, in layout coordinates.
function pickPlane(ray) {
  if (!ray) return null;
  const forward = viewerForward();
  const denom = ray.dir[0] * forward[0] + ray.dir[1] * forward[1] + ray.dir[2] * forward[2];
  if (Math.abs(denom) < 1e-4) return null;
  const cx = layout.x;
  const cy = layout.y;
  const cz = -layout.z;
  const t = ((cx - ray.origin[0]) * forward[0]
           + (cy - ray.origin[1]) * forward[1]
           + (cz - ray.origin[2]) * forward[2]) / denom;
  if (t <= 0) return null;
  return {
    x: ray.origin[0] + ray.dir[0] * t,
    y: ray.origin[1] + ray.dir[1] * t,
    z: -layout.z,
  };
}

// Is that hit actually on the text, or off in the space beside it? Half-extent
// with a little slack so the pill is easy to catch by hand.
function hitTest(ray) {
  const hit = pickPlane(ray);
  if (!hit) return null;
  const hx = (BASE.width * layout.scale) / 2 + 0.1;
  const hy = (BASE.height * layout.scale) / 2 + 0.1;
  if (Math.abs(hit.x - layout.x) > hx || Math.abs(hit.y - layout.y) > hy) return null;
  return hit;
}

// --- hover cursor --------------------------------------------------------------
// Direct manipulation needs feedback: without a visible pointer there is nothing
// telling you the ray has found the text and a squeeze will take hold of it.
let hover = null;

function updateHover(frame) {
  hover = null;
  if (dragging) {
    const ray = rayOf(frame, refSpace, dragging.inputSource);
    if (ray) hover = { ...pickPlane(ray), on: true };
    return;
  }
  for (const src of session.inputSources) {
    const ray = rayOf(frame, refSpace, src);
    if (!ray) continue;
    const hit = hitTest(ray);
    if (hit) { hover = { ...hit, on: false }; break; }
    // No target under this pointer: show the ray landing on the panel plane
    // anyway, dimmed, so the cursor is never simply absent.
    const plane = pickPlane(ray);
    if (plane) hover = { ...plane, on: false, miss: true };
    if (plane) break;
  }
  dirty = true;
}

function viewerForward() {
  if (!lastPose) return [0, 0, -1];
  const m = lastPose.views[0].transform.matrix;
  return [-m[8], -m[9], -m[10]];
}

function startDrag(frame, src) {
  if (dragging) return false;
  const ray = rayOf(frame, refSpace, src);
  const hit = hitTest(ray);
  if (!hit) return false;                 // missed: this is a look, not a grab
  dragging = {
    inputSource: src,
    // Remember where on the panel the pointer took hold, so releasing the grab
    // leaves the text exactly under the hand instead of snapping its centre.
    offX: layout.x - hit.x,
    offY: layout.y - hit.y,
    // Baseline reach along the pointing arm, for hand-driven depth below.
    reach: reachOf(frame, src),
    reach0: reachOf(frame, src),
  };
  report({
    ev: 'drag.start',
    hand: src.handedness,
    via: src.targetRayMode ?? 'ray',
    // Hands carry no gamepad, which is the whole reason depth is bound to
    // reach rather than to a stick.
    hasStick: !!src.gamepad,
  });
  return true;
}

// Distance from the eye to the pointer, projected on the view direction.
// Standing still and pushing your hand forward increases it.
function reachOf(frame, src) {
  const pose = frame.getPose(src.targetRaySpace, refSpace);
  if (!pose) return null;
  const m = pose.transform.matrix;
  const f = viewerForward();
  const dx = m[12] - (lastPose?.transform.position.x ?? 0);
  const dy = m[13] - (lastPose?.transform.position.y ?? 0);
  const dz = m[14] - (lastPose?.transform.position.z ?? 0);
  return dx * f[0] + dy * f[1] + dz * f[2];
}

function endDrag() {
  if (!dragging) return;
  report({ ev: 'drag.end', layout });
  dragging = null;
  // Re-baseline the pinch spread so the next two-hand gesture does not jump.
  pinch0 = null;
  save();
}

function updateDrag(frame) {
  if (!dragging) return;
  const hit = pickPlane(rayOf(frame, refSpace, dragging.inputSource));
  if (!hit) return;
  layout.x = hit.x + dragging.offX;
  layout.y = hit.y + dragging.offY;
  layout = clampLayout(layout);
}

// Hand tracking exposes no gamepad, so there is no stick to read. With hands as
// the only pointer, the thumbstick was a phantom input: the panel appeared to
// follow depth because the head was moving, not a controller.
//
// So lateral position comes from the pinch, and distance comes from how far
// along the pointing arm the pinch is held. Push your hand forward to bring the
// text toward you, pull it back to send it away — the same reach you would use
// to slide something across a table, which is why it needs no explanation.
function updateDragDepth(frame) {
  if (!dragging) return;

  // With a controller, the stick still owns depth and size.
  if (dragging.inputSource.gamepad) {
    const stick = readSticks(dragging.inputSource);
    if (stick) {
      layout.z -= stickRate(stick.y, 0.016, { speed: 2.2 });
      layout.scale += stickRate(stick.x, 0.016, { speed: 1.1 });
    }
  } else {
    const reach = reachOf(frame, dragging.inputSource);
    if (reach !== null && dragging.reach0 !== null) {
      // Metres of reach in, metres of depth out. Damped, so a wrist twitch does
      // not fling the panel across the room.
      layout.z = layout.z + (dragging.reach0 - reach) * 1.4;
    }
  }
  layout = clampLayout(layout);
}

// Two hands pinching, spread apart, scales the text. This is the hand equivalent
// of a pinch-zoom and needs no stick.
function updatePinchScale() {
  const rays = [];
  for (const src of session.inputSources) {
    if (!src.gamepad) {
      const p = src.targetRayPose?.position;
      if (p) rays.push(p);
    }
  }
  if (rays.length < 2) return;
  const a = rays[0];
  const b = rays[1];
  const spread = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  if (pinch0 === null) { pinch0 = spread; return; }
  layout.scale = layout.scale * (spread / pinch0);
  layout = clampLayout(layout);
}
let pinch0 = null;

// --- session -------------------------------------------------------------------
let session = null;
let refSpace = null;
let lastPose = null;
let reportedFrame = false;

async function start() {
  if (!navigator.xr) return fail('navigator.xr missing');
  report({ ev: 'start.attempt' });
  if (!(await navigator.xr.isSessionSupported('immersive-ar'))) {
    report({ ev: 'start.no-immersive-ar' });
    return fail('immersive-ar not supported by this browser');
  }

  // `layers` is deliberately NOT requested: this runtime refuses to combine it
  // with a baseLayer ("Can't use baseLayer with layers feature requested").
  session = await navigator.xr.requestSession('immersive-ar', {
    optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking'],
  });
  report({ ev: 'session.started', inputSources: session.inputSources.length });

  await gl.makeXRCompatible();
  session.updateRenderState({
    baseLayer: new XRWebGLLayer(session, gl, { alpha: true, depth: true }),
  });
  refSpace = await session.requestReferenceSpace('local-floor');

  // Listen on the session, not per-input-source: on this runtime XRInputSource
  // is not an EventTarget, so per-source addEventListener throws.
  //
  // Both squeeze (controller) and select (trigger, or a bare pinch when hand
  // tracking is driving the ray) grab the panel, so the same gesture works
  // whichever pointer the runtime happens to be offering.
  session.addEventListener('squeezestart', (ev) => startDrag(lastFrame, ev.inputSource));
  session.addEventListener('squeezeend', () => endDrag());
  session.addEventListener('selectstart', (ev) => {
    if (dragging) return;
    const src = ev.inputSource;
    // A right-trigger press is a grab if the pointer is on the text, otherwise
    // it is a "next line" click. That resolves the two without a mode switch.
    if (startDrag(lastFrame, src)) return;
    if (src?.handedness === 'right' || src?.targetRayMode === 'tracked-pointer') {
      sampleIndex = (sampleIndex + 1) % SAMPLE.length;
      drawText();
    }
  });
  session.addEventListener('selectend', () => endDrag());
  session.addEventListener('end', () => {
    session = null;
    lastFrame = null;
    hud.style.display = '';
    canvas.style.display = 'none';
    go.disabled = false;
    report({ ev: 'session.ended' });
  });

  hud.style.display = 'none';
  canvas.style.display = '';
  if (new URLSearchParams(location.search).has('dump')) dumpJson();
  session.requestAnimationFrame(onFrame);
}

function onFrame(time, frame) {
  session.requestAnimationFrame(onFrame);
  lastFrame = frame;

  const layer = session.renderState.baseLayer;
  const pose = frame.getViewerPose(refSpace);
  lastPose = pose;

  gl.bindFramebuffer(gl.FRAMEBUFFER, layer.framebuffer);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  if (!pose) return;

  if (!reportedFrame) {
    reportedFrame = true;
    report({ ev: 'firstframe', views: pose.views.length, eye: pose.views[0]?.eye ?? 'n/a' });
  }

  // The input model is the crux of this milestone, and it is not knowable from
  // the host: report what the runtime actually offers. Note that
  // `inputSources` is array-*like* here — a frozen array-like, not an Array —
  // so it has no .map(), which is why an earlier probe read as empty.
  if (!reportedInputs && reportedFrame && time > 1500) {
    reportedInputs = true;
    const sources = [];
    for (let i = 0; i < session.inputSources.length; i++) {
      const s = session.inputSources[i];
      sources.push({
        hand: s.handedness,
        targetRayMode: s.targetRayMode,
        hasGamepad: !!s.gamepad,
        buttons: s.gamepad?.buttons?.length ?? 0,
        axes: s.gamepad?.axes?.length ?? 0,
        profiled: !!s.profiles?.includes?.('generic-trigger-squeeze-thumbstick'),
      });
    }
    let features = [];
    try { features = Array.from(session.enabledFeatures ?? []); } catch { /* not iterable */ }
    report({ ev: 'inputs', count: sources.length, sources, handTracking: features.filter((f) => /hand/.test(f)) });
  }

  const dt = Math.min(0.05, (time - lastTime) / 1000 || 0.016);
  lastTime = time;
  applySticks(dt);
  updateDrag(frame);
  updateDragDepth(frame);
  updatePinchScale();
  updateHover(frame);

  if (dirty) uploadText();
  drawCursor();
  gl.useProgram(prog);
  gl.bindVertexArray(vao);

  // Two passes: the subtitle panel, then the pointer on top of it so the cursor
  // is never occluded by the very thing you are trying to grab.
  const draws = [{ model: modelMatrix(layout), cursor: 0 }];
  if (hover) {
    const s = 0.06;
    draws.push({
      model: new Float32Array([s, 0, 0, 0, 0, s, 0, 0, 0, 0, 1, 0, hover.x, hover.y, -hover.z, 1]),
      cursor: 1,
    });
  }

  for (const view of pose.views) {
    const vp = layer.getViewport(view);
    if (!vp) continue;
    gl.viewport(vp.x, vp.y, vp.width, vp.height);
    gl.uniformMatrix4fv(uViewProj, false, mul(view.projectionMatrix, view.transform.inverse.matrix));
    for (const d of draws) {
      gl.uniformMatrix4fv(uModel, false, d.model);
      gl.uniform1f(uIsCursor, d.cursor);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
  }
}

let lastFrame = null;
let lastTime = 0;
let reportedInputs = false;

function fail(msg) {
  status.textContent = msg;
  status.classList.add('err');
  report({ ev: 'fail', msg });
  console.error(msg);
}

// --- boot ----------------------------------------------------------------------
try {
  initGl();
  initTex();
  drawText();
  report({ ev: 'gl.ready' });
} catch (err) {
  fail(String(err));
  go.disabled = true;
}

go.addEventListener('click', () => { go.disabled = true; start().catch((e) => fail(String(e))); });

if (navigator.xr) {
  navigator.xr.isSessionSupported('immersive-ar')
    .then((ok) => {
      report({ ev: 'xr.check', immersiveAR: ok });
      status.textContent = ok ? 'ready — put the headset on and press Enter AR' : 'immersive-ar unsupported';
      if (!ok) go.disabled = true;
    })
    .catch((e) => fail(String(e)));
} else {
  fail('navigator.xr missing');
  go.disabled = true;
}

loadFonts().catch((e) => report({ ev: 'fonts.error', msg: String(e) }));
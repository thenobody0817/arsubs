// Layout config and the anchoring rule.
//
// This file is deliberately free of XR, DOM and WebGL. It is the shared core:
// the Quest client reads it directly, and the eventual Android client reads the
// same numbers. That is why `anchorFor()` takes a plain frame description
// instead of an XRRigidTransform — so both clients can call it.

export const PRESETS = {
  'below-chin': { x: 0.0, y: -0.30, z: 2.0, scale: 1.0 },
  'upper-chest': { x: 0.0, y: -0.55, z: 2.2, scale: 1.05 },
  'left-shoulder': { x: -0.42, y: -0.42, z: 2.1, scale: 0.95 },
  'close': { x: 0.0, y: -0.28, z: 1.0, scale: 0.8 },
};

export const LIMITS = {
  // Closer than this the vergence conflict makes text hard to hold on to; much
  // beyond it and the panel is a distant billboard rather than part of the
  // conversation.
  z: { min: 0.4, max: 8.0 },
  // Below the floor is inside the table; above the forehead it stops reading as
  // a caption for this person.
  y: { min: -0.9, max: 1.9 },
  x: { min: -2.5, max: 2.5 },
  scale: { min: 0.35, max: 2.5 },
};

export const BASE = { width: 1.6, height: 0.4 };

export function clampLayout(l) {
  const c = (v, { min, max }) => Math.min(max, Math.max(min, v));
  return {
    x: c(l.x, LIMITS.x),
    y: c(l.y, LIMITS.y),
    z: c(l.z, LIMITS.z),
    scale: c(l.scale, LIMITS.scale),
  };
}

export function defaultLayout() {
  return clampLayout({ ...PRESETS['below-chin'] });
}

// Continuous stick input. `deadzone` keeps a resting thumb from drifting the
// panel, and the result is scaled by dt so the panel moves at a constant rate
// regardless of frame rate.
export function stickRate(value, dt, { deadzone = 0.18, speed = 1 } = {}) {
  const mag = Math.abs(value);
  if (mag < deadzone) return 0;
  const norm = (mag - deadzone) / (1 - deadzone);
  return Math.sign(value) * norm * norm * speed * dt;
}

/**
 * Where the subtitle panel goes.
 *
 * @param frame  { viewDirX, viewDirY }  unit vector, the wearer's gaze in the
 *               same space as `layout`
 * @param face   { cx, cy, w, h }        face box in the same space, or null
 * @param layout { x, y, z, scale }
 * @returns      { x, y, z, scale, mode }
 *
 * With no face the panel simply sits where the user dragged it, which is what
 * M1 needs. Once a face is present the panel tracks it, falling back to the
 * user's y when the face is not centred on them.
 */
export function anchorFor(frame, face, layout) {
  const l = clampLayout(layout);
  if (!face) return { ...l, mode: 'manual' };
  // Below the face box by a fraction of its height, so the text tracks a person
  // who moves closer or further without the offset ballooning.
  const drop = -face.h * 0.75;
  return { ...clampLayout({ ...l, x: face.cx, y: face.cy + drop }), mode: 'tracked' };
}
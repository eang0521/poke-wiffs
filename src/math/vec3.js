// Minimal immutable 3D vector helpers. Vectors are plain {x, y, z} objects.
//
// World frame (used everywhere):
//   origin = point of home plate, on the ground
//   +y     = out toward the pitcher / center field
//   +x     = toward the 1st-base side (catcher's right)
//   +z     = up

export const v3 = (x = 0, y = 0, z = 0) => ({ x, y, z });
export const ZERO = Object.freeze(v3());
export const UP = Object.freeze(v3(0, 0, 1));

export const add = (a, b) => v3(a.x + b.x, a.y + b.y, a.z + b.z);
export const sub = (a, b) => v3(a.x - b.x, a.y - b.y, a.z - b.z);
export const scale = (a, s) => v3(a.x * s, a.y * s, a.z * s);
export const addScaled = (a, b, s) => v3(a.x + b.x * s, a.y + b.y * s, a.z + b.z * s);
export const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
export const cross = (a, b) =>
  v3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
export const len = (a) => Math.hypot(a.x, a.y, a.z);
export const lerp = (a, b, t) => v3(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);

export function norm(a) {
  const l = len(a);
  return l > 1e-12 ? scale(a, 1 / l) : v3();
}

// Rodrigues rotation of v about unit axis k by angle (radians).
export function rotateAbout(v, k, angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const kv = cross(k, v);
  const kd = dot(k, v) * (1 - c);
  return v3(
    v.x * c + kv.x * s + k.x * kd,
    v.y * c + kv.y * s + k.y * kd,
    v.z * c + kv.z * s + k.z * kd,
  );
}

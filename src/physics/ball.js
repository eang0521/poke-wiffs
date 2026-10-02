// Wiffle ball aerodynamic model.
//
// A Wiffle ball is a hollow plastic sphere with eight oblong slots on one
// hemisphere. Its movement comes from three sources:
//
// 1. HOLE (asymmetry) FORCE. Air flows differently over the slotted and solid
//    halves, and some air passes through the shell. That gives a sideways force
//    even with no spin. Rossmann & Rau (Am. J. Phys. 75, 2007) measured it in a
//    wind tunnel. With the slots facing sideways (90° to the flow) the force
//    points TOWARD the slots and grows with airspeed. With the slots facing
//    mostly upstream, the wake was symmetric (no force) or deflected so the
//    force pointed AWAY from the slots. The model below fits that shape:
//        F_hole = q·A·C_H·g(θ)  along the slot direction, perpendicular to v
//    where θ is the angle between the slot axis and the direction of travel.
//
// 2. MAGNUS LIFT from spin, F ∝ ω × v. A Wiffle ball is very light, so a
//    little spin goes a long way. The lift curve is the standard baseball fit
//    (Sawicki et al.), capped.
//
// 3. WAKE BUFFET. A ball with almost no spin has an unsteady wake, which is
//    what makes a knuckleball flutter. It is modeled as a smooth random
//    sideways force that fades out as the spin rate rises.
//
// Because the spin vector also rotates the slots, the hole force only stays
// steady when the ball spins about the slot axis. Any other spin makes the
// slots tumble and the hole force averages out or wobbles. Pitch shapes come
// out of these physics; they are not scripted.
//
// Ball mass, size and coefficients below are reasonable estimates, not exact
// measurements. Tune them here; everything else derives from these values.

import { G } from '../units.js';
import { v3, sub, scale, add, dot, cross, len, norm, addScaled } from '../math/vec3.js';

export const WIFFLE_BALL = Object.freeze({
  name: 'Official-size Wiffle ball',
  mass: 0.0198, // kg (~0.7 oz)
  radius: 0.0365, // m (2.87 in diameter)
  dragCoefficient: 0.30,
  dragOrientation: 0.04, // extra Cd when the slots face straight upstream
  holeForceCoefficient: 0.09, // peak C_H of the slot asymmetry force
  liftScale: 0.6, // slotted shell turns spin into lift less efficiently than a seamed baseball
  liftCap: 0.3,
  buffetCoefficient: 0.035,
  buffetSpinScale: 30, // rad/s; buffet fades once spin exceeds ~5 rev/s
  buffetTimeConstant: 0.06, // s; how fast the random wake force wanders
  spinDecayTime: 1.5, // s; e-folding time of spin due to air torque
});

export const DEFAULT_ENV = Object.freeze({
  airDensity: 1.225, // kg/m^3, sea level, 15 °C
  gravity: G,
  wind: v3(0, 0, 0), // m/s, world frame
});

export const crossSection = (ball) => Math.PI * ball.radius * ball.radius;

// Normalized shape of the slot force vs. angle θ (cosT = cos θ, holes·v̂).
// 0 at θ=0 (slots upstream) and θ=180° (slots downstream).
// Negative (away from the slots) for slots mostly upstream (θ < ~48°).
// Peaks with the slots sideways or slightly trailing.
export function holeForceShape(cosT) {
  const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
  return cosT >= 0 ? sinT * (1 - 1.5 * cosT) : sinT * (1 - 0.5 * cosT);
}

export function liftCoefficient(spinParameter, cap, scaleFactor = 1) {
  const s = Math.abs(spinParameter);
  const cl = s < 0.1 ? 1.5 * s : 0.09 + 0.6 * s;
  return Math.min(cl * scaleFactor, cap);
}

// Aerodynamic accelerations (m/s^2) broken down by source.
//   vel      ball velocity (world)
//   holeDir  unit vector from the ball's center through the slotted hemisphere
//   spin     angular velocity (rad/s, world)
//   buffet   random wake direction (any vector; only the part perpendicular
//            to the flow is used)
export function aeroAccelerations(vel, holeDir, spin, buffet, ball, env) {
  const vRel = sub(vel, env.wind);
  const speed = len(vRel);
  const zero = v3();
  if (speed < 1e-6) return { drag: zero, hole: zero, magnus: zero, buffet: zero };

  const vHat = scale(vRel, 1 / speed);
  const qAm = (0.5 * env.airDensity * speed * speed * crossSection(ball)) / ball.mass;

  // Drag (slightly higher when the slots face into the wind).
  const cosT = Math.max(-1, Math.min(1, dot(holeDir, vHat)));
  const cd = ball.dragCoefficient + ball.dragOrientation * Math.max(0, cosT);
  const drag = scale(vHat, -cd * qAm);

  // Slot asymmetry force, perpendicular to the flow, toward (or away from) the slots.
  let hole = zero;
  const perp = addScaled(holeDir, vHat, -cosT);
  if (len(perp) > 1e-6) {
    hole = scale(norm(perp), ball.holeForceCoefficient * holeForceShape(cosT) * qAm);
  }

  // Magnus lift from the spin component perpendicular to the flow.
  let magnus = zero;
  const wxv = cross(spin, vHat);
  const wPerp = len(wxv);
  if (wPerp > 1e-6) {
    const cl = liftCoefficient((ball.radius * wPerp) / speed, ball.liftCap, ball.liftScale ?? 1);
    magnus = scale(wxv, (cl * qAm) / wPerp);
  }

  // Low-spin wake buffet (knuckleball flutter).
  let buf = zero;
  if (buffet && ball.buffetCoefficient > 0) {
    const bPerp = addScaled(buffet, vHat, -dot(buffet, vHat));
    const lowSpin = Math.exp(-len(spin) / ball.buffetSpinScale);
    buf = scale(bPerp, ball.buffetCoefficient * lowSpin * qAm);
  }

  return { drag, hole, magnus, buffet: buf };
}

export function totalAcceleration(vel, holeDir, spin, buffet, ball, env) {
  const out = [0, 0, 0];
  accelerationInto(out, vel.x, vel.y, vel.z, holeDir, spin, buffet, ball, env);
  return v3(out[0], out[1], out[2]);
}

/**
 * Same physics as aeroAccelerations() + gravity, written with scalars and no
 * allocation, because the integrator calls it millions of times per game.
 * Writes the total acceleration into out[0..2].
 */
export function accelerationInto(out, vx, vy, vz, h, w, b, ball, env) {
  const rx = vx - env.wind.x, ry = vy - env.wind.y, rz = vz - env.wind.z;
  const speed = Math.sqrt(rx * rx + ry * ry + rz * rz);
  out[0] = 0; out[1] = 0; out[2] = -env.gravity;
  if (speed < 1e-6) return;
  const ux = rx / speed, uy = ry / speed, uz = rz / speed;
  const qAm = (0.5 * env.airDensity * speed * speed * Math.PI * ball.radius * ball.radius) / ball.mass;

  // drag
  let cosT = h.x * ux + h.y * uy + h.z * uz;
  cosT = cosT > 1 ? 1 : cosT < -1 ? -1 : cosT;
  const cd = ball.dragCoefficient + ball.dragOrientation * (cosT > 0 ? cosT : 0);
  out[0] -= ux * cd * qAm; out[1] -= uy * cd * qAm; out[2] -= uz * cd * qAm;

  // slot force
  if (ball.holeForceCoefficient) {
    const px = h.x - ux * cosT, py = h.y - uy * cosT, pz = h.z - uz * cosT;
    const pl = Math.sqrt(px * px + py * py + pz * pz);
    if (pl > 1e-6) {
      const k = (ball.holeForceCoefficient * holeForceShape(cosT) * qAm) / pl;
      out[0] += px * k; out[1] += py * k; out[2] += pz * k;
    }
  }

  // Magnus
  const cx = w.y * uz - w.z * uy, cy = w.z * ux - w.x * uz, cz = w.x * uy - w.y * ux;
  const wPerp = Math.sqrt(cx * cx + cy * cy + cz * cz);
  if (wPerp > 1e-6) {
    const cl = liftCoefficient((ball.radius * wPerp) / speed, ball.liftCap, ball.liftScale ?? 1);
    const k = (cl * qAm) / wPerp;
    out[0] += cx * k; out[1] += cy * k; out[2] += cz * k;
  }

  // wake buffet
  if (b && ball.buffetCoefficient > 0) {
    const bd = b.x * ux + b.y * uy + b.z * uz;
    const wl = Math.sqrt(w.x * w.x + w.y * w.y + w.z * w.z);
    const k = ball.buffetCoefficient * Math.exp(-wl / ball.buffetSpinScale) * qAm;
    out[0] += (b.x - ux * bd) * k; out[1] += (b.y - uy * bd) * k; out[2] += (b.z - uz * bd) * k;
  }
}

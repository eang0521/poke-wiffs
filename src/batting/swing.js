// Bat-ball contact.
//
// SWING KINEMATICS. The bat rotates about a vertical axis through the batter's
// body (the pivot). The hands ride on a circle of radius `handsRadius`. The
// bat points outward from the hands, drooped below horizontal so that the
// sweet spot reaches the aimed height. The whole bat also rises at the attack
// angle (uppercut). The player controls:
//   - timing: the moment the bat is square to the pitcher (perpendicular to
//     the pitch line, at `contactDepth` in front of the plate)
//   - aim: where the sweet spot is at that moment (x across the plate, z height)
//   - swing type: contact / normal / power
// Early swings meet the ball after the bat has rotated past square, so the
// ball is pulled. Late swings push it the other way. Misjudged height means
// undercutting (pop-ups) or topping (grounders). Misjudged x means hits off
// the end of the bat or in on the hands.
//
// CONTACT is found geometrically by sweeping the bat against the pitch's
// actual flight path.
//
// COLLISION is an impulse model in the contact frame:
//   normal:     restitution with a bat COR that depends on where the ball hits
//               and how hard, using the bat's effective mass at that point
//               (free-bat approximation)
//   tangential: friction impulse, up to sticking, that spins the hollow ball
//               (thin shell, I = 2/3·m·r²)

import { v3, add, sub, scale, dot, cross, len, norm } from '../math/vec3.js';
import { DEG, MPH, RPM, ftToM, mToFt, mToIn } from '../units.js';
import { WIFFLE_BALL } from '../physics/ball.js';
import { WIFFLE_BAT, DEFAULT_BATTER, SWING_TYPES, batRadiusAt, batEffectiveMass, batCor } from './bat.js';
import { simulateBattedBall } from './battedBall.js';

// ---------- pitch-path interpolation (cubic Hermite on pos/vel samples) ----------
export function ballStateAt(samples, t) {
  if (t <= samples[0].t) return samples[0];
  let lo = 0;
  let hi = samples.length - 1;
  if (t >= samples[hi].t) return null;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = samples[lo];
  const b = samples[hi];
  const h = b.t - a.t;
  const u = (t - a.t) / h;
  const h00 = 2 * u ** 3 - 3 * u ** 2 + 1, h10 = u ** 3 - 2 * u ** 2 + u;
  const h01 = -2 * u ** 3 + 3 * u ** 2, h11 = u ** 3 - u ** 2;
  const pos = add(add(scale(a.pos, h00), scale(a.vel, h10 * h)), add(scale(b.pos, h01), scale(b.vel, h11 * h)));
  const d00 = (6 * u ** 2 - 6 * u) / h, d10 = 3 * u ** 2 - 4 * u + 1;
  const d01 = (-6 * u ** 2 + 6 * u) / h, d11 = 3 * u ** 2 - 2 * u;
  const vel = add(add(scale(a.pos, d00), scale(a.vel, d10)), add(scale(b.pos, d01), scale(b.vel, d11)));
  return { t, pos, vel, spin: a.spin, holeDir: a.holeDir };
}

// ---------- swing setup ----------
/**
 * @param {object} o
 * @param {number} o.timing          pitch-clock time (s after release) when the bat is square
 * @param {{x,z}}  o.aimFt           sweet-spot position at square, in feet (x across plate, z height)
 * @param {string} [o.type='normal'] key of SWING_TYPES
 * @param {object} [o.batter]        overrides of DEFAULT_BATTER
 */
export function createSwing(o) {
  const batter = { ...DEFAULT_BATTER, ...o.batter };
  const bat = o.bat ?? WIFFLE_BAT;
  const type = SWING_TYPES[o.type ?? 'normal'];
  const hs = batter.hand === 'L' ? -1 : 1;
  const sSweet = bat.sweetSpotFromKnob * bat.length;
  const aim = { x: ftToM(o.aimFt.x), z: ftToM(o.aimFt.z) };

  // Droop the bat so the sweet spot reaches the aimed height (negative = bat tilted up).
  const sinDroop = Math.max(-0.6, Math.min(0.95, (batter.handsHeight - aim.z) / sSweet));
  const droop = Math.asin(sinDroop);
  const handsZ = aim.z + sSweet * sinDroop;
  const rSweet = batter.handsRadius + sSweet * Math.cos(droop);
  const speed = (batter.batSpeedMph * type.speedFactor) * MPH;
  const omega = speed / rSweet; // rad/s about the body axis
  const vUp = speed * Math.tan(type.attackAngleDeg * DEG);
  // Body axis sits on the batter's side of the aim point.
  const pivot = v3(aim.x - hs * rSweet, batter.contactDepth, 0);

  return {
    batter, bat, type, hs, droop, handsZ, rSweet, speed, omega, vUp, pivot, aim,
    timing: o.timing,
    arc: batter.arcDeg * DEG,
    start: o.timing - (batter.arcDeg * DEG) / omega,
    end: o.timing + (batter.arcDeg * DEG) / omega,
  };
}

// Bat pose at pitch-clock time t: knob position, unit axis (knob → tip), rotation angle.
export function batPose(sw, t) {
  const phi = sw.omega * (t - sw.timing);
  const d = v3(sw.hs * Math.cos(phi), Math.sin(phi), 0);
  const c = Math.cos(sw.droop);
  const axis = v3(d.x * c, d.y * c, -Math.sin(sw.droop));
  const knob = v3(
    sw.pivot.x + sw.batter.handsRadius * d.x,
    sw.pivot.y + sw.batter.handsRadius * d.y,
    sw.handsZ + sw.vUp * (t - sw.timing),
  );
  return { t, phi, knob, axis, tip: add(knob, scale(axis, sw.bat.length)), live: Math.abs(phi) <= sw.arc };
}

function closestOnBat(pose, p, L) {
  const s = Math.max(0, Math.min(L, dot(sub(p, pose.knob), pose.axis)));
  const q = add(pose.knob, scale(pose.axis, s));
  return { s, q, dist: len(sub(p, q)) };
}

// Velocity of a point on the bat (rotation about the body axis + uppercut rise).
function batPointVelocity(sw, point) {
  const w = v3(0, 0, sw.hs * sw.omega);
  return add(cross(w, sub(point, sw.pivot)), v3(0, 0, sw.vUp));
}

/** Find the first moment the swinging bat touches the pitched ball. */
export function findContact(sw, samples, ball = WIFFLE_BALL) {
  const t0 = Math.max(sw.start, samples[0].t);
  const t1 = Math.min(sw.end, samples[samples.length - 1].t);
  const gap = (t) => {
    const b = ballStateAt(samples, t);
    if (!b) return null;
    const pose = batPose(sw, t);
    const c = closestOnBat(pose, b.pos, sw.bat.length);
    return { b, pose, c, g: c.dist - (batRadiusAt(sw.bat, c.s) + ball.radius) };
  };
  const h = 0.0002;
  let prevT = t0;
  let closest = null;
  for (let t = t0; t <= t1; t += h) {
    const r = gap(t);
    if (!r) break;
    if (!closest || r.g < closest.g) closest = r;
    if (r.g <= 0) {
      let lo = prevT;
      let hi = t;
      for (let i = 0; i < 30; i++) {
        const mid = (lo + hi) / 2;
        if (gap(mid).g <= 0) hi = mid;
        else lo = mid;
      }
      return { hit: gap(hi), closest };
    }
    prevT = t;
  }
  return { hit: null, closest };
}

/** Resolve the ball-bat impulse. Returns the ball's post-contact state. */
export function resolveCollision(sw, contact, ball = WIFFLE_BALL) {
  const { b, c } = contact;
  const bat = sw.bat;
  const n = norm(sub(b.pos, c.q)); // from bat axis to ball center
  const r = ball.radius;
  const contactPt = sub(b.pos, scale(n, r));
  const vBat = batPointVelocity(sw, contactPt);
  const u = sub(b.vel, vBat);
  const un = dot(u, n);
  if (un >= 0) return null; // already separating: no real collision

  const m = ball.mass;
  const M = batEffectiveMass(bat, c.s);
  const mu = 1 / (1 / m + 1 / M);
  const e = batCor(bat, c.s, -un);
  const Jn = -(1 + e) * mu * un;

  // Tangential slip at the contact point (ball surface vs bat surface).
  const surf = add(b.vel, cross(b.spin, scale(n, -r)));
  const w = sub(surf, vBat);
  const wt = sub(w, scale(n, dot(w, n)));
  const I = (2 / 3) * m * r * r;
  let Jt = scale(wt, -1 / (1 / m + (r * r) / I + 1 / M));
  const JtMax = bat.friction * Jn;
  if (len(Jt) > JtMax) Jt = scale(norm(Jt), JtMax);

  const J = add(scale(n, Jn), Jt);
  const vel = add(b.vel, scale(J, 1 / m));
  const spin = add(b.spin, scale(cross(Jt, n), r / I));
  return { pos: b.pos, vel, spin, holeDir: b.holeDir, normal: n, e, effectiveMass: M, normalSpeed: -un, batSpeedAtContact: len(vBat) };
}

/** Time the pitch reaches the batter's square-contact plane, and where it is then. */
export function idealContact(pitch, batter = DEFAULT_BATTER) {
  const y = ({ ...DEFAULT_BATTER, ...batter }).contactDepth;
  const s = pitch.samples;
  for (let i = 1; i < s.length; i++) {
    if (s[i - 1].pos.y >= y && s[i].pos.y < y) {
      // refine with Hermite
      let lo = s[i - 1].t;
      let hi = s[i].t;
      for (let k = 0; k < 30; k++) {
        const mid = (lo + hi) / 2;
        if (ballStateAt(s, mid).pos.y >= y) lo = mid;
        else hi = mid;
      }
      const st = ballStateAt(s, hi);
      return { t: hi, pos: st.pos };
    }
  }
  return null;
}

/**
 * Swing at a pitch.
 * @param {object} o
 * @param {object} o.pitch      result of throwPitch()
 * @param {object} o.field
 * @param {number} o.timing     pitch-clock time when the bat is square
 * @param {{x,z}}  o.aimFt      sweet-spot aim at square (feet)
 * @param {string} [o.type]
 * @param {object} [o.batter]   DEFAULT_BATTER overrides, or a profile from batterFromStats()
 */
export function swingAtPitch(o) {
  const ball = o.ball ?? WIFFLE_BALL;
  const batter = { ...DEFAULT_BATTER, ...o.batter };
  const ideal = idealContact(o.pitch, batter);

  // Contact assist (from the batter's contact stat) shrinks the player's error
  // toward a perfect swing. It never moves a swing farther from the ball.
  let { timing, aimFt } = o;
  if (ideal && batter.assist) {
    const { aimErrorScale = 1, timingErrorScale = 1 } = batter.assist;
    timing = ideal.t + (o.timing - ideal.t) * timingErrorScale;
    const ix = mToFt(ideal.pos.x);
    const iz = mToFt(ideal.pos.z);
    aimFt = { x: ix + (o.aimFt.x - ix) * aimErrorScale, z: iz + (o.aimFt.z - iz) * aimErrorScale };
  }
  const sw = createSwing({ ...o, batter, timing, aimFt });
  const timingErrorMs = ideal ? (timing - ideal.t) * 1000 : null; // + = late, after assist
  const rawTimingErrorMs = ideal ? (o.timing - ideal.t) * 1000 : null;
  const found = findContact(sw, o.pitch.samples, ball);

  const base = { swing: sw, ideal, timingErrorMs, rawTimingErrorMs, batter: batter.name ?? null };
  if (!found.hit) {
    const cl = found.closest;
    const miss = cl
      ? { byIn: mToIn(Math.max(0, cl.g)), ballAbove: cl.b.pos.z > cl.c.q.z, t: cl.b.t }
      : { byIn: null };
    return { ...base, contact: false, miss };
  }
  const post = resolveCollision(sw, found.hit, ball);
  if (!post) return { ...base, contact: false, miss: { byIn: 0, glancing: true } };

  const v = post.vel;
  const speed = len(v);
  const s = found.hit.c.s;
  const dir = norm(v);
  const backAxis = norm(cross(dir, v3(0, 0, 1)));
  const contact = {
    t: found.hit.b.t,
    pos: post.pos,
    batAngleDeg: found.hit.pose.phi / DEG, // + = past square (early swing)
    inchesFromTip: mToIn(sw.bat.length - s),
    inchesFromSweetSpot: mToIn(s - sw.bat.sweetSpotFromKnob * sw.bat.length), // + = toward the tip
    cor: post.e,
    effectiveMassKg: post.effectiveMass,
    batSpeedMph: post.batSpeedAtContact / MPH,
    exitVeloMph: speed / MPH,
    launchAngleDeg: Math.asin(v.z / speed) / DEG,
    sprayAngleDeg: Math.atan2(v.x, v.y) / DEG,
    backspinRpm: dot(post.spin, backAxis) / RPM,
    sidespinRpm: -post.spin.z / RPM,
  };
  const batted = simulateBattedBall({
    field: o.field,
    ball,
    env: o.env,
    seed: o.seed ?? 1,
    state: { pos: post.pos, vel: post.vel, spin: post.spin, holeDir: post.holeDir },
  });
  return { ...base, contact: true, ...contact, batted };
}

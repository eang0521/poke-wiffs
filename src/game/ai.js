// CPU decisions: what to throw, and whether/how to swing.

import { mToFt, mToIn, inToM } from '../units.js';
import { idealContact } from '../batting/swing.js';
import { statRating } from '../stats/stats.js';

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const lerp = (a, b, t) => a + (b - a) * t;

/**
 * CPU pitcher: pick a pitch from the arsenal and a target (feet, zone coords).
 * Behind in the count → pound the zone; ahead → expand toward chase spots.
 */
export function cpuPitchChoice({ pitcher, count, field, rng, batterHand = 'R' }) {
  const arsenal = pitcher.arsenal;
  // Fastball more often when behind; breaking stuff when ahead.
  const behind = count.balls - count.strikes;
  const weights = arsenal.map((p, i) => {
    let w = i === 0 ? 1.6 + 0.4 * Math.max(0, behind) : 1;
    if (p === 'knuckleball') w *= 0.7;
    if (count.strikes === 2 && p !== 'fastball') w *= 1.3;
    return w;
  });
  let r = rng.next() * weights.reduce((a, b) => a + b, 0);
  let pitch = arsenal[0];
  for (let i = 0; i < arsenal.length; i++) {
    r -= weights[i];
    if (r <= 0) { pitch = arsenal[i]; break; }
  }

  const z = field.zone;
  const halfW = mToFt(z.halfWidth);
  const bot = mToFt(z.bottom);
  const top = mToFt(z.top);
  const mid = (bot + top) / 2;
  // Chase pitches only when ahead.
  const chase = count.strikes === 2 && count.balls < 3 ? 0.5 : count.strikes > count.balls ? 0.35 : count.balls === 3 ? 0.05 : 0.22;
  // "Away" from the batter = toward the side he isn't standing on.
  const away = batterHand === 'L' ? -1 : 1;
  if (rng.next() < chase) {
    const spots = [
      { x: away * (halfW + 0.35), z: mid - 0.4 },
      { x: 0, z: bot - 0.45 },
      { x: away * (halfW + 0.2), z: bot - 0.2 },
      { x: 0, z: top + 0.35 },
    ];
    return { pitch, target: spots[Math.floor(rng.next() * spots.length)] };
  }
  // Otherwise work the zone: paint the edges when ahead or even (about half of
  // those miss off the plate), stay toward the middle when behind.
  const edge = count.balls >= 3 ? 0.45 : behind > 0 ? 0.7 : 1.1;
  const sx = rng.next() < 0.5 ? -1 : 1;
  const x = sx * halfW * edge * Math.sqrt(rng.next());
  const zz = mid + (rng.next() < 0.5 ? -1 : 1) * ((top - bot) / 2) * edge * Math.sqrt(rng.next());
  return { pitch, target: { x, z: zz } };
}

/**
 * CPU batter. Eye (Sp. Def) sets how well the hitter reads where the pitch
 * will cross and when it arrives. Movement and velocity make that harder.
 * Errors are generated in "input space", the same way a human misses; the
 * contact stat (Sp. Atk) then shrinks them inside swingAtPitch().
 * Returns {swing:false} or {swing:true, timing, aimFt, type}.
 */
export function cpuSwingDecision({ pitch, batter, count, field, rng }) {
  const eye = clamp01(batter.eye);
  const crossing = pitch.crossing?.pos ?? pitch.grounded?.pos;
  if (!crossing) return { swing: false };
  const brkIn = Math.hypot(mToIn(pitch.break.x), mToIn(pitch.break.z)) * 0.5 + (pitch.pitch === 'Knuckleball' ? 10 : 0);
  const deception = 1 + brkIn / 40;
  const quickness = (pitch.flightTime < 0.6 ? 0.5 / pitch.flightTime : 0.83) * (batter.swingTime / 0.15);

  // Read the pitch location.
  const readSigma = inToM(lerp(7, 1.8, eye) * deception);
  const seenX = crossing.x + rng.gaussian() * readSigma;
  const seenZ = (pitch.grounded ? 0 : crossing.z) + rng.gaussian() * readSigma;
  const zone = field.zone;
  const r = 0.0365;
  const looksStrike = Math.abs(seenX) <= zone.halfWidth + r && seenZ >= zone.bottom - r && seenZ <= zone.top + r;

  let pSwing;
  if (count.balls === 3 && count.strikes === 0) pSwing = looksStrike ? 0.15 : 0.02;
  else if (count.strikes === 2) pSwing = looksStrike ? 0.97 : lerp(0.45, 0.15, eye);
  else pSwing = looksStrike ? (count.strikes === 0 && count.balls === 0 ? 0.68 : 0.82) : lerp(0.3, 0.06, eye);
  if (rng.next() >= pSwing) return { swing: false };

  const ideal = idealContact(pitch, batter);
  if (!ideal) return { swing: true, timing: pitch.flightTime, aimFt: { x: 0, z: 2 }, type: 'normal' };
  const timingSigma = lerp(34, 14, eye) * quickness * Math.sqrt(deception) / 1000;
  const aimSigma = inToM(lerp(2.8, 1.1, eye) * deception);
  const type = count.strikes === 2 ? 'contact' : count.balls - count.strikes >= 2 ? 'power' : 'normal';
  // Power hitters aim a touch under the ball to lift it; others try to square it up.
  const loft = inToM(statRating(batter.stats?.attack ?? 80) > 0.6 ? 0.3 : 0.1);
  return {
    swing: true,
    type,
    timing: ideal.t + rng.gaussian() * timingSigma,
    aimFt: {
      x: mToFt(ideal.pos.x + rng.gaussian() * aimSigma),
      z: mToFt(ideal.pos.z - loft + rng.gaussian() * aimSigma),
    },
  };
}

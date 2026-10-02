// Generic ball-flight integrator.
//
// Position and velocity use RK4. Within each step the slot direction, spin and
// wake buffet are held fixed; between steps the slots rotate with the spin
// vector, spin decays, and the buffet takes an Ornstein-Uhlenbeck random-walk
// step.

import { v3, add, scale, addScaled, len, norm, rotateAbout } from '../math/vec3.js';
import { WIFFLE_BALL, DEFAULT_ENV, accelerationInto } from './ball.js';

const snapshot = (s) => ({
  t: s.t,
  pos: { ...s.pos },
  vel: { ...s.vel },
  holeDir: { ...s.holeDir },
  spin: { ...s.spin },
});

/**
 * @param {object} o
 * @param {{x,y,z}} o.pos      initial position (m)
 * @param {{x,y,z}} o.vel      initial velocity (m/s)
 * @param {{x,y,z}} o.holeDir  slot direction (unit-ish)
 * @param {{x,y,z}} o.spin     angular velocity (rad/s)
 * @param {object} [o.rng]     seeded RNG; turns on wake buffet when provided
 * @param {function} [o.onStep] (prev, next) => undefined | {stop?, state?, record?}
 *        Lets callers detect plane crossings, bounce off the ground, etc.
 *        Returning `state` replaces the next state, e.g. after a bounce.
 */
export function simulateFlight(o) {
  const ball = o.ball ?? WIFFLE_BALL;
  const env = o.env ?? DEFAULT_ENV;
  const dt = o.dt ?? 0.0005;
  const maxTime = o.maxTime ?? 6;
  const recordEvery = o.recordEvery ?? 4;
  const rng = o.rng ?? null;
  const onStep = o.onStep ?? null;

  let s = {
    t: 0,
    pos: { ...o.pos },
    vel: { ...o.vel },
    holeDir: norm(o.holeDir),
    spin: { ...o.spin },
  };

  // Wake buffet state, started from the stationary distribution.
  let buffet = rng ? v3(rng.gaussian(), rng.gaussian(), rng.gaussian()) : null;
  const tauB = ball.buffetTimeConstant;
  const spinDecay = Math.exp(-dt / ball.spinDecayTime);

  const samples = [snapshot(s)];
  const k1 = [0, 0, 0], k2 = [0, 0, 0], k3 = [0, 0, 0], k4 = [0, 0, 0];
  let step = 0;

  while (s.t < maxTime) {
    if (buffet) {
      const k = Math.sqrt((2 * dt) / tauB);
      buffet = v3(
        buffet.x - (buffet.x * dt) / tauB + k * rng.gaussian(),
        buffet.y - (buffet.y * dt) / tauB + k * rng.gaussian(),
        buffet.z - (buffet.z * dt) / tauB + k * rng.gaussian(),
      );
    }

    // RK4 on (pos, vel) with the slots, spin and buffet frozen for the step.
    const vx = s.vel.x, vy = s.vel.y, vz = s.vel.z;
    accelerationInto(k1, vx, vy, vz, s.holeDir, s.spin, buffet, ball, env);
    const v2x = vx + k1[0] * dt / 2, v2y = vy + k1[1] * dt / 2, v2z = vz + k1[2] * dt / 2;
    accelerationInto(k2, v2x, v2y, v2z, s.holeDir, s.spin, buffet, ball, env);
    const v3x = vx + k2[0] * dt / 2, v3y = vy + k2[1] * dt / 2, v3z = vz + k2[2] * dt / 2;
    accelerationInto(k3, v3x, v3y, v3z, s.holeDir, s.spin, buffet, ball, env);
    const v4x = vx + k3[0] * dt, v4y = vy + k3[1] * dt, v4z = vz + k3[2] * dt;
    accelerationInto(k4, v4x, v4y, v4z, s.holeDir, s.spin, buffet, ball, env);
    const dv = v3(
      (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0]) * dt / 6,
      (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1]) * dt / 6,
      (k1[2] + 2 * k2[2] + 2 * k3[2] + k4[2]) * dt / 6,
    );
    const dx = v3(
      (vx + 2 * v2x + 2 * v3x + v4x) * dt / 6,
      (vy + 2 * v2y + 2 * v3y + v4y) * dt / 6,
      (vz + 2 * v2z + 2 * v3z + v4z) * dt / 6,
    );

    const w = len(s.spin);
    const holeDir = w > 1e-9 ? norm(rotateAbout(s.holeDir, scale(s.spin, 1 / w), w * dt)) : s.holeDir;

    const next = {
      t: s.t + dt,
      pos: add(s.pos, dx),
      vel: add(s.vel, dv),
      holeDir,
      spin: scale(s.spin, spinDecay),
    };

    step++;
    const ctl = onStep ? onStep(s, next) : undefined;
    s = ctl?.state ?? next;
    if (step % recordEvery === 0 || ctl?.stop || ctl?.record) samples.push(snapshot(s));
    if (ctl?.stop) break;
  }

  return { samples, final: s };
}

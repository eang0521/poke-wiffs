// Throwing pitches: release → aim solve → flight → strike-zone result.

import { v3, add, scale, cross, norm, lerp, len, dot, rotateAbout } from '../math/vec3.js';
import { createRng } from '../math/rng.js';
import { IN, MPH, RPM, ftToM, mphToMs } from '../units.js';
import { WIFFLE_BALL, DEFAULT_ENV } from '../physics/ball.js';
import { simulateFlight } from '../physics/flight.js';
import { PITCHES } from './pitches.js';
import { pitcherFatigue } from '../stats/stats.js';

const handSign = (hand) => (hand === 'L' ? -1 : 1);

function launchDirection(yaw, pitch) {
  // yaw > 0 aims toward +x; pitch > 0 aims up. Base direction is toward home (−y).
  return v3(Math.sin(yaw) * Math.cos(pitch), -Math.cos(yaw) * Math.cos(pitch), Math.sin(pitch));
}

// Release frame built from the throw direction. `glove` is the RHP glove side;
// lefties flip it through handSign when frame components are mapped.
export function releaseFrame(dir) {
  const forward = norm(dir);
  const up = norm(add(v3(0, 0, 1), scale(forward, -forward.z)));
  const glove = cross(up, forward);
  return { glove, up, forward };
}

// Holes and positions are polar vectors: mirroring flips the glove component.
function framePolar(frame, [g, u, f], hs) {
  return add(add(scale(frame.glove, g * hs), scale(frame.up, u)), scale(frame.forward, f));
}
// Spin is an axial vector: mirroring flips the other two components instead.
function frameAxial(frame, [g, u, f], hs) {
  return add(add(scale(frame.glove, g), scale(frame.up, u * hs)), scale(frame.forward, f * hs));
}

export function resolvePitch(pitch) {
  const def = typeof pitch === 'string' ? PITCHES[pitch] : pitch;
  if (!def) throw new Error(`Unknown pitch: ${pitch}`);
  return def;
}

export function releasePoint(def, hand, field) {
  const hs = handSign(hand);
  return v3(-hs * ftToM(def.release.side), field.mound.y - ftToM(def.release.extension), ftToM(def.release.height));
}

function initialConditions(def, hand, release, yaw, pitchAngle, speed, spinRpm, orient) {
  const hs = handSign(hand);
  const dir = launchDirection(yaw, pitchAngle);
  const frame = releaseFrame(dir);
  const holes = def.holes === 'random' ? orient.holes : framePolar(frame, def.holes, hs);
  const axis = def.spin.axis === 'random' ? orient.axis : norm(frameAxial(frame, def.spin.axis, hs));
  return { pos: release, vel: scale(dir, speed), holeDir: holes, spin: scale(axis, spinRpm * RPM) };
}

// Fly one pitch until it reaches the strike-zone plane or hits the ground.
export function flyPitch(init, field, { ball = WIFFLE_BALL, env = DEFAULT_ENV, rng = null, dt = 0.0005, recordEvery = 4 } = {}) {
  const zoneY = field.zone.y;
  let plate = null;
  let crossing = null;
  let grounded = null;
  const flight = simulateFlight({
    ...init,
    ball,
    env,
    rng,
    dt,
    recordEvery,
    maxTime: 4,
    onStep(prev, next) {
      if (!plate && prev.pos.y > 0 && next.pos.y <= 0) {
        const f = prev.pos.y / (prev.pos.y - next.pos.y);
        plate = { t: prev.t + f * dt, pos: lerp(prev.pos, next.pos, f), vel: lerp(prev.vel, next.vel, f) };
      }
      if (next.pos.y <= zoneY) {
        const f = (prev.pos.y - zoneY) / (prev.pos.y - next.pos.y);
        crossing = { t: prev.t + f * dt, pos: lerp(prev.pos, next.pos, f), vel: lerp(prev.vel, next.vel, f) };
        return { stop: true };
      }
      if (next.pos.z <= ball.radius) {
        const f = (prev.pos.z - ball.radius) / (prev.pos.z - next.pos.z);
        grounded = { t: prev.t + f * dt, pos: lerp(prev.pos, next.pos, f), vel: lerp(prev.vel, next.vel, f) };
        return { stop: true };
      }
      if (next.vel.y >= 0) return { stop: true }; // stalled (pathological inputs)
      return undefined;
    },
  });
  return { ...flight, plate, crossing, grounded };
}

// Where the pitch reaches the zone plane. If it bounced first, extrapolate
// so the aim solver still gets a smooth error signal.
function arrivalXZ(res, zoneY) {
  if (res.crossing) return { x: res.crossing.pos.x, z: res.crossing.pos.z };
  const end = res.grounded ?? res.final;
  const vy = Math.min(end.vel.y, -1e-3);
  const t = (zoneY - end.pos.y) / vy;
  return { x: end.pos.x + end.vel.x * t, z: end.pos.z + end.vel.z * t - 0.5 * 9.8 * t * t };
}

/**
 * Find the launch angles that put the pitch's EXPECTED path (no execution
 * error, no wake buffet) through the target point in the zone plane.
 * target: {x, z} in meters (x: + = 1st-base side, z = height above ground).
 */
export function solveAim(def, hand, field, target, { ball, env, speed, spinRpm, orient } = {}) {
  const release = releasePoint(def, hand, field);
  const aimAt = v3(target.x, field.zone.y, target.z);
  const d = norm(add(aimAt, scale(release, -1)));
  let yaw = Math.atan2(d.x, -d.y);
  let pitchAngle = Math.asin(d.z);
  const run = (yw, pa) =>
    arrivalXZ(flyPitch(initialConditions(def, hand, release, yw, pa, speed, spinRpm, orient), field, { ball, env, dt: 0.001, recordEvery: 1e9 }), field.zone.y);

  const h = 0.002;
  let err = Infinity;
  let J = null;
  for (let i = 0; i < 10; i++) {
    const a = run(yaw, pitchAngle);
    const ex = target.x - a.x;
    const ez = target.z - a.z;
    err = Math.hypot(ex, ez);
    if (err < 0.001) break;
    // Jacobian of arrival (x, z) w.r.t. (yaw, pitch). The map is nearly linear,
    // so it's computed once and reused (refreshed if progress stalls).
    if (!J || i === 5) {
      const ay = run(yaw + h, pitchAngle);
      const ap = run(yaw, pitchAngle + h);
      J = [(ay.x - a.x) / h, (ap.x - a.x) / h, (ay.z - a.z) / h, (ap.z - a.z) / h];
    }
    const [j11, j12, j21, j22] = J;
    const det = j11 * j22 - j12 * j21;
    if (Math.abs(det) < 1e-9) break;
    let dy = (j22 * ex - j12 * ez) / det;
    let dp = (-j21 * ex + j11 * ez) / det;
    const step = Math.hypot(dy, dp);
    if (step > 0.15) { dy *= 0.15 / step; dp *= 0.15 / step; }
    yaw += dy;
    pitchAngle += dp;
  }
  return { yaw, pitch: pitchAngle, release, residual: err };
}

/**
 * Throw a pitch.
 * @param {object} o
 * @param {string|object} o.pitch   key of PITCHES or a custom definition
 * @param {'R'|'L'} [o.hand='R']
 * @param {{x:number,z:number}} [o.target] in FEET relative to the zone: x from
 *        center (+ = 1st-base side), z = height above ground. Default = zone center.
 * @param {boolean} [o.execution=true]  apply command error, velocity/spin variance, wake buffet
 * @param {number} [o.seed]
 * @param {number} [o.speedMph] absolute speed override (ignores the pitcher's velocity stat)
 * @param {object} [o.pitcher]  profile from pitcherFromStats(); sets hand, velocity, spin,
 *        axis wobble, command and extension
 * @param {number} [o.pitchCount=0] pitches already thrown (fatigue past the stamina limit)
 */
export function throwPitch(o) {
  const { field, execution = true, seed = 1, pitcher = null } = o;
  const hand = o.hand ?? pitcher?.hand ?? 'R';
  const baseBall = o.ball ?? WIFFLE_BALL;
  // A pitcher's scuffed ball has a stronger slot asymmetry.
  const ball = pitcher?.holeForceScale
    ? { ...baseBall, holeForceCoefficient: baseBall.holeForceCoefficient * pitcher.holeForceScale }
    : baseBall;
  const env = o.env ?? DEFAULT_ENV;
  const base = resolvePitch(o.pitch);
  const fatigue = pitcherFatigue(pitcher, o.pitchCount ?? 0);
  const def = pitcher
    ? { ...base, release: { ...base.release, extension: base.release.extension + (pitcher.extensionFt - 3) } }
    : base;
  const rng = createRng(seed);
  const hs = handSign(hand);

  const target = o.target
    ? { x: ftToM(o.target.x), z: ftToM(o.target.z) }
    : { x: 0, z: field.zone.centerZ };

  const plannedSpeed = o.speedMph != null
    ? mphToMs(o.speedMph)
    : mphToMs(def.speedMph) * (pitcher?.velocityScale ?? 1) * fatigue.velocityScale;
  const plannedSpin = def.spin.rpm * (pitcher?.spinScale ?? 1);
  const command = def.command * (pitcher?.commandScale ?? 1) * fatigue.commandScale;
  // The knuckleball's starting orientation is random but known when aiming.
  // The flutter comes from how it evolves in flight.
  const orient = { holes: rng.unitVector(), axis: rng.unitVector() };

  const aim = solveAim(def, hand, field, target, { ball, env, speed: plannedSpeed, spinRpm: plannedSpin, orient });

  let { yaw, pitch: pitchAngle } = aim;
  let speed = plannedSpeed;
  let spinRpm = plannedSpin;
  if (execution) {
    const dist = Math.abs(aim.release.y - field.zone.y);
    const sigma = (command * IN) / dist;
    yaw += rng.gaussian() * sigma;
    pitchAngle += rng.gaussian() * sigma;
    speed *= 1 + rng.gaussian() * 0.015;
    spinRpm *= 1 + rng.gaussian() * 0.03;
  }

  const init = initialConditions(def, hand, aim.release, yaw, pitchAngle, speed, spinRpm, orient);
  if (execution && pitcher?.axisErrorDeg && len(init.spin) > 0) {
    // Wobble the spin axis off its intended direction.
    const w = len(init.spin);
    const axis = scale(init.spin, 1 / w);
    let k = rng.unitVector();
    k = norm(add(k, scale(axis, -dot(k, axis))));
    if (len(k) > 0) init.spin = scale(rotateAbout(axis, k, rng.gaussian() * pitcher.axisErrorDeg * Math.PI / 180), w);
  }
  const res = flyPitch(init, field, { ball, env, rng: execution ? rng : null });

  // Movement relative to a "dead" ball (gravity + drag only, same release
  // velocity), measured in the zone plane, like MLB pfx.
  const deadBall = { ...ball, holeForceCoefficient: 0, buffetCoefficient: 0 };
  const ref = flyPitch({ ...init, spin: v3() }, field, { ball: deadBall, env, dt: 0.001, recordEvery: 1e9 });
  const arrive = arrivalXZ(res, field.zone.y);
  const refArrive = arrivalXZ(ref, field.zone.y);
  const breakX = arrive.x - refArrive.x;
  const breakZ = arrive.z - refArrive.z;

  const end = res.crossing ?? res.grounded ?? res.final;
  const strike = !!res.crossing && field.isStrike(res.crossing.pos.x, res.crossing.pos.z, ball.radius);

  return {
    pitch: def.name,
    hand,
    seed,
    pitcher: pitcher?.name ?? null,
    fatigued: fatigue.tired,
    target,
    release: aim.release,
    releaseSpeedMph: speed / MPH,
    spinRpm,
    endSpeedMph: Math.hypot(end.vel.x, end.vel.y, end.vel.z) / MPH,
    flightTime: end.t,
    plate: res.plate, // crossing of the front of home plate (batter timing)
    crossing: res.crossing, // crossing of the strike-zone plane
    grounded: res.grounded, // ball hit the ground before the zone
    result: res.grounded ? 'ball_in_dirt' : strike ? 'strike' : 'ball',
    missFromTarget: res.crossing ? Math.hypot(res.crossing.pos.x - target.x, res.crossing.pos.z - target.z) : null,
    // movement (m): catcher's view x (+ = 1st-base side), induced vertical (+ = up)
    break: { x: breakX, z: breakZ, gloveSide: breakX * hs },
    totalDrop: aim.release.z - arrive.z,
    samples: res.samples,
  };
}

export { handSign };

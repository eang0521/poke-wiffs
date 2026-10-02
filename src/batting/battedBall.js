// Batted-ball flight and how it plays on the field: home run, off the wall,
// fair, or foul. Bat/ball contact itself comes later; this starts from the
// ball's launch state off the bat.

import { v3, scale, norm, cross, lerp, len } from '../math/vec3.js';
import { createRng } from '../math/rng.js';
import { DEG, MPH, RPM, G, ftToM, mphToMs } from '../units.js';
import { WIFFLE_BALL, DEFAULT_ENV, crossSection } from '../physics/ball.js';
import { simulateFlight } from '../physics/flight.js';

export const SURFACE = Object.freeze({
  restitution: 0.45, // vertical COR of a plastic ball on grass
  bounceFriction: 0.75, // fraction of horizontal speed kept per bounce
  rollThreshold: 0.6, // m/s; slower vertical rebound starts rolling instead of bouncing
  rollingResistance: 0.2, // effective rolling friction coefficient on grass
  wallRestitution: 0.35,
});

/**
 * @param {object} o
 * @param {number} o.exitVeloMph
 * @param {number} o.launchAngleDeg     + = up
 * @param {number} [o.sprayAngleDeg=0]  0 = straightaway center, + = toward 1st base / right field
 * @param {number} [o.backspinRpm=1200] negative = topspin
 * @param {number} [o.sidespinRpm=0]    + = curves toward the 1st-base side
 * @param {{x,y,z}} [o.contactFt]       contact point in feet (default: over the plate, 2.3 ft high)
 * @param {object} [o.state]            alternative to the launch numbers: exact
 *        {pos, vel, spin, holeDir?} in SI (m, m/s, rad/s), e.g. straight from bat contact
 */
export function simulateBattedBall(o) {
  const { field } = o;
  const ball = o.ball ?? WIFFLE_BALL;
  const env = o.env ?? DEFAULT_ENV;
  const surface = { ...SURFACE, ...o.surface };
  const rng = createRng(o.seed ?? 1);
  const dt = 0.002;

  let pos0, vel0, spin, holeDir;
  if (o.state) {
    ({ pos: pos0, vel: vel0, spin } = o.state);
    holeDir = o.state.holeDir ?? rng.unitVector();
  } else {
    const c = o.contactFt ?? { x: 0, y: 0.5, z: 2.3 };
    pos0 = v3(ftToM(c.x), ftToM(c.y), ftToM(c.z));
    const la = o.launchAngleDeg * DEG;
    const sa = (o.sprayAngleDeg ?? 0) * DEG;
    const dir = v3(Math.sin(sa) * Math.cos(la), Math.cos(sa) * Math.cos(la), Math.sin(la));
    vel0 = scale(dir, mphToMs(o.exitVeloMph));
    // Backspin axis = dir × up (gives upward Magnus); sidespin about −z hooks toward +x.
    const backAxis = norm(cross(dir, v3(0, 0, 1)));
    spin = v3(
      backAxis.x * (o.backspinRpm ?? 1200) * RPM,
      backAxis.y * (o.backspinRpm ?? 1200) * RPM,
      -(o.sidespinRpm ?? 0) * RPM,
    );
    holeDir = rng.unitVector();
  }

  const events = [];
  const out = {
    outcome: null,
    fair: null,
    homeRun: null,
    hitWall: false,
    reachedWall: false,
    firstLanding: null,
    apex: pos0.z,
    hangTime: null,
  };
  let passedFence = false; // after a homer we keep flying to measure projected distance
  let judged = false;

  const judge = (p, why) => {
    if (judged) return;
    judged = true;
    out.fair = field.isFair(p);
    events.push({ type: 'judged', fair: out.fair, why, pos: p });
  };

  let rollStart = null;
  const flight = simulateFlight({
    pos: pos0,
    vel: vel0,
    holeDir,
    spin,
    ball,
    env,
    rng,
    dt,
    maxTime: 12,
    recordEvery: 4,
    onStep(prev, next) {
      if (next.pos.z > out.apex) out.apex = next.pos.z;

      // Fence (only spans fair territory, pole to pole).
      if (!passedFence) {
        const hit = field.fenceCrossing(prev.pos, next.pos);
        if (hit) {
          const zAt = prev.pos.z + (next.pos.z - prev.pos.z) * hit.t;
          if (zAt - ball.radius > hit.segment.height) {
            passedFence = true;
            judged = true;
            out.fair = true;
            out.homeRun = { segment: hit.index, clearance: zAt - hit.segment.height, at: hit.point, t: prev.t + hit.t * dt };
            events.push({ type: 'home_run', ...out.homeRun });
            if (!out.outcome) out.outcome = 'home_run';
          } else {
            // Carom off the wall: reflect the horizontal velocity about the fence normal.
            const n = hit.segment.normal;
            const vn = next.vel.x * n.x + next.vel.y * n.y;
            const e = surface.wallRestitution;
            const state = {
              ...next,
              pos: v3(hit.point.x + n.x * ball.radius, hit.point.y + n.y * ball.radius, zAt),
              vel: v3(next.vel.x - (1 + e) * vn * n.x, next.vel.y - (1 + e) * vn * n.y, next.vel.z * 0.7),
              spin: scale(next.spin, 0.3),
            };
            out.hitWall = true;
            judge(hit.point, 'wall');
            events.push({ type: 'wall', segment: hit.index, height: zAt, t: next.t });
            return { state, record: true };
          }
        }
      }

      // Ground contact.
      if (next.pos.z <= ball.radius && next.vel.z < 0) {
        const f = (prev.pos.z - ball.radius) / (prev.pos.z - next.pos.z);
        const p = lerp(prev.pos, next.pos, f);
        const t = prev.t + f * dt;
        if (!out.firstLanding) {
          out.firstLanding = { pos: p, t, distance: Math.hypot(p.x, p.y) };
          out.hangTime = t;
          if (passedFence) return { stop: true, record: true }; // projected homer distance measured
          // Balls landing beyond 1st/3rd are judged where they land. Balls
          // landing short of the bases are judged where they pass the bases or stop.
          if (field.depth(p) >= field.baseDepth) judge(p, 'landed');
        }
        events.push({ type: 'bounce', pos: p, t });
        const vz = -next.vel.z * surface.restitution;
        const state = {
          ...next,
          pos: v3(p.x, p.y, ball.radius),
          vel: v3(next.vel.x * surface.bounceFriction, next.vel.y * surface.bounceFriction, vz),
          spin: scale(next.spin, 0.5),
        };
        if (vz < surface.rollThreshold) {
          rollStart = { ...state, vel: v3(state.vel.x, state.vel.y, 0) };
          return { stop: true, state, record: true };
        }
        return { state, record: true };
      }

      if (!judged && out.firstLanding && field.depth(next.pos) >= field.baseDepth) judge(next.pos, 'passed_base');
      return undefined;
    },
  });

  // Rolling phase (simple: rolling friction + drag, no aero lift).
  const path = flight.samples.map((s) => ({ t: s.t, pos: s.pos }));
  let rest = flight.final;
  if (rollStart) {
    let s = { t: rollStart.t, pos: { ...rollStart.pos }, vel: { ...rollStart.vel } };
    const k = (0.5 * env.airDensity * crossSection(ball) * ball.dragCoefficient) / ball.mass;
    let n = 0;
    while (Math.hypot(s.vel.x, s.vel.y) > 0.05 && s.t < 30) {
      const sp = Math.hypot(s.vel.x, s.vel.y);
      const decel = surface.rollingResistance * G + k * sp * sp;
      const nsp = Math.max(0, sp - decel * dt);
      const nv = v3((s.vel.x / sp) * nsp, (s.vel.y / sp) * nsp, 0);
      const np = v3(s.pos.x + nv.x * dt, s.pos.y + nv.y * dt, ball.radius);
      if (!passedFence && field.fenceCrossing(s.pos, np)) {
        out.reachedWall = true;
        judge(np, 'wall');
        s = { t: s.t + dt, pos: s.pos, vel: v3() };
        break;
      }
      s = { t: s.t + dt, pos: np, vel: nv };
      if (!judged && field.depth(s.pos) >= field.baseDepth) judge(s.pos, 'passed_base');
      if (++n % 20 === 0) path.push({ t: s.t, pos: s.pos });
    }
    path.push({ t: s.t, pos: s.pos });
    rest = s;
  }

  if (!judged) judge(rest.pos, 'stopped');
  if (!out.outcome) out.outcome = out.fair ? 'fair' : 'foul';

  return {
    ...out,
    launch: {
      exitVeloMph: len(vel0) / MPH,
      launchAngleDeg: Math.asin(vel0.z / len(vel0)) / DEG,
      sprayAngleDeg: Math.atan2(vel0.x, vel0.y) / DEG,
    },
    rest: rest.pos,
    restDistance: Math.hypot(rest.pos.x, rest.pos.y),
    events,
    path,
  };
}

// Fielding and baserunning: turns a batted-ball flight into a play.
//
// FIELDERS start at their alignment spots, wait out their reaction time, then
// run in a straight line at their foot speed.
//  - Air balls: a fielder can catch any point of the flight below catch height
//    (REACH) that they can reach in time. Their "slack" (spare time) sets how hard
//    the catch is; small negative slack means a diving try.
//  - Ground balls / dropped balls: the first fielder who can reach the ball
//    (rolling or bouncing below REACH) fields it, then needs a moment to set and throw.
// THROWS are wiffle throws: the light ball sheds speed quickly, so long throws
// are slow. Time follows from drag: t = (e^{kd} − 1) / (k·v0).
// RUNNERS run the base paths at their foot speed. Each runner keeps taking
// bases while they'd beat the throw by a safety cushion (with some misjudgment).
// Forced runners must advance. On a caught fly, runners tag up.
// THE DEFENSE throws to the lead runner it can retire, falling back to the
// batter-runner, and tries for a double play after a force out.

import { createRng } from '../math/rng.js';
import { ftToM } from '../units.js';
import { WIFFLE_BALL, DEFAULT_ENV, crossSection } from '../physics/ball.js';

export const REACH = 2.3; // m, highest a fielder can glove a ball (with a jump)
const DIVE = 0.18; // s, how far short a fielder can be and still dive
const PICKUP = 0.25; // s to field a ground ball cleanly
const TRANSFER = 0.35; // s from gloving the ball to releasing a throw
const TAG = 0.15; // s to apply a tag on a non-forced runner
const TURN = 0.12; // s lost per base rounded
const BATTER_START = 0.35; // s after contact before the batter is out of the box
const CUSHION = 0.15; // s margin a runner wants before trying for an extra base
const ACCEL = 0.6; // s for a fielder to reach top speed (uniform acceleration)
const READ = 0.3; // s extra to read a ball in the air before committing

// Default positions (feet), tuned for the 45/40/40/45 diamond.
export const DEFAULT_ALIGNMENT = Object.freeze({
  P: [0, 34],
  '1B': [21, 46],
  MI: [-4, 55],
  '3B': [-21, 46],
  LF: [-30, 80],
  RF: [30, 80],
});

const dist2 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/** Seconds to run d meters from a standstill: accelerate for ACCEL s, then cruise at v. */
export function runTime(d, v) {
  const dAccel = (v * ACCEL) / 2;
  return d < dAccel ? Math.sqrt((2 * d * ACCEL) / v) : ACCEL + (d - dAccel) / v;
}

/** Seconds for a thrown wiffle ball to cover d meters at release speed v0. */
export function throwTime(d, v0, ball = WIFFLE_BALL, env = DEFAULT_ENV) {
  const k = (0.5 * env.airDensity * crossSection(ball) * ball.dragCoefficient) / ball.mass;
  return (Math.exp(k * d) - 1) / (k * v0) + 0.05;
}

export function basePoints(field) {
  const b = field.bases;
  return [b.home, b.first, b.second, b.third, b.home];
}

/** Base-path distance from base a to base b (0 = home ... 4 = home again). */
function pathDist(bases, a, b) {
  let d = 0;
  for (let i = a; i < b; i++) d += dist2(bases[i], bases[i + 1]);
  return d;
}

/**
 * @param {object} ctx
 * @param {object} ctx.batted       result of simulateBattedBall()
 * @param {object} ctx.field
 * @param {object[]} ctx.defense    [{player, role, pos:{x,y}}] (pos in m)
 * @param {(object|null)[]} ctx.bases  runners on 1st, 2nd, 3rd ({player, speed})
 * @param {object} ctx.batter       {player, speed}
 * @param {number} ctx.outs
 * @param {number|object} [ctx.rng]
 */
export function resolvePlay(ctx) {
  const { batted, field } = ctx;
  const rng = typeof ctx.rng === 'object' && ctx.rng ? ctx.rng : createRng(ctx.rng ?? 1);
  const bases = basePoints(field);
  const defense = ctx.defense;
  const fielderAt = (f, t) => {
    // Where fielder f is at time t, moving toward its assigned target (if any).
    const tr = f.track;
    if (!tr || t <= tr.start) return f.pos;
    if (t >= tr.end) return tr.to;
    const u = (t - tr.start) / (tr.end - tr.start);
    return { x: f.pos.x + (tr.to.x - f.pos.x) * u, y: f.pos.y + (tr.to.y - f.pos.y) * u };
  };
  const timeTo = (f, p, air = false) => f.player.fielder.reaction + (air ? READ : 0) + runTime(dist2(f.pos, p), f.speed);

  const fielders = defense.map((d) => ({ ...d, speed: d.speed ?? d.player.fielder.runSpeed, track: null }));
  const credit = { putouts: [], assists: [], errors: [] };
  const events = [];
  const throws = [];

  // Runners: [{player, from, speed, start, target, out, scoredAt, forced}]
  const runners = [];
  for (let b = 3; b >= 1; b--) if (ctx.bases[b - 1]) runners.push({ ...ctx.bases[b - 1], from: b });
  runners.push({ ...ctx.batter, from: 0, isBatter: true });

  const path = batted.path;
  const landingT = batted.firstLanding?.t ?? Infinity;
  const result = { outsRecorded: 0, runs: [], batterResult: null, hit: false, error: false, fieldedBy: null, description: '' };

  // ---------- home run ----------
  if (batted.outcome === 'home_run') {
    let t = BATTER_START;
    for (const r of runners) {
      r.target = 4;
      r.start = r.isBatter ? BATTER_START : 0.1;
      r.speed *= 0.75; // trot
      r.arrive = (b) => r.start + pathDist(bases, r.from, b) / r.speed + TURN * Math.max(0, b - r.from - 1);
      result.runs.push(r.player);
      t = Math.max(t, r.arrive(4));
    }
    result.batterResult = 'HR';
    result.hit = true;
    result.description = 'home run';
    return finish(result, runners, [], fielders, path, throws, events, credit, bases, Math.max(t, path[path.length - 1].t), ctx.outs);
  }

  // ---------- 1. catch chance (balls in the air) ----------
  let best = null;
  for (const f of fielders) {
    for (const s of path) {
      if (s.t >= landingT || s.t < 0.05 || s.pos.z > REACH) continue;
      const slack = s.t - timeTo(f, s.pos, true);
      if (!best || slack > best.slack) best = { f, s, slack };
    }
  }
  let caught = null;
  let dropped = null;
  if (best && best.slack >= -DIVE) {
    const sure = 1 - best.f.player.fielder.errorRate;
    const p = sure * Math.max(0.12, Math.min(1, 0.62 + 1.6 * best.slack));
    best.f.track = { start: best.f.player.fielder.reaction + READ, end: best.s.t - Math.max(0, best.slack), to: best.s.pos };
    if (rng.next() < p) caught = best;
    else {
      dropped = best;
      if (best.slack > 0.15) {
        result.error = true;
        credit.errors.push(best.f.player);
        events.push({ t: best.s.t, type: 'error', fielder: best.f.player, what: 'dropped fly' });
      } else events.push({ t: best.s.t, type: 'dive_miss', fielder: best.f.player });
    }
  }

  if (caught) {
    const t = caught.s.t;
    result.outsRecorded = 1;
    result.fieldedBy = caught.f;
    credit.putouts.push(caught.f.player);
    const kind = batted.launch.launchAngleDeg > 45 ? 'pop' : batted.launch.launchAngleDeg < 18 ? 'line' : 'fly';
    result.batterResult = kind === 'pop' ? 'PO' : kind === 'line' ? 'LO' : 'FO';
    result.description = `${kind === 'line' ? 'lines' : kind === 'pop' ? 'pops' : 'flies'} out to ${caught.f.role}${caught.slack < 0 ? ' (diving catch!)' : caught.slack < 0.15 ? ' (running catch)' : ''}${batted.fair ? '' : ' in foul territory'}`;
    events.push({ t, type: 'catch', fielder: caught.f.player });
    const batter = runners.find((r) => r.isBatter);
    batter.out = true;
    batter.outAt = t;
    batter.target = 0;
    batter.start = BATTER_START;
    batter.arrive = (b) => batter.start + pathDist(bases, 0, b) / batter.speed;
    const onBase = runners.filter((r) => !r.isBatter);
    if (ctx.outs + 1 >= 3 || onBase.length === 0) {
      for (const r of onBase) { r.target = r.from; r.start = 0; r.arrive = () => 0; }
      return finish(result, runners, [], fielders, truncatePath(path, t), throws, events, credit, bases, t + 0.5, ctx.outs);
    }
    // Tag ups: runners leave at the catch.
    for (const r of onBase) r.start = t + 0.12;
    return runPlay({ holder: caught.f, holdT: t, holdPos: caught.s.pos, tagUp: true });
  }

  if (!batted.fair) {
    result.batterResult = 'FOUL';
    result.description = 'foul ball';
    return { ...result, foul: true, timeline: buildTimeline(path, [], fielders, [], 0, path[path.length - 1].t, bases) };
  }

  // ---------- 2. ground ball / ball that fell in ----------
  const tMin = dropped ? dropped.s.t + 0.6 : landingT;
  let pick = null;
  for (const s of path) {
    if (s.t < tMin || s.pos.z > REACH) continue;
    for (const f of fielders) {
      const ready = dropped && f === dropped.f ? tMin : timeTo(f, s.pos);
      if (ready <= s.t && (!pick || s.t < pick.t)) pick = { f, t: s.t, pos: s.pos };
    }
    if (pick) break;
  }
  if (!pick) {
    const rest = path[path.length - 1];
    for (const f of fielders) {
      const t = Math.max(rest.t, timeTo(f, rest.pos));
      if (!pick || t < pick.t) pick = { f, t, pos: rest.pos };
    }
  }
  if (!(dropped && pick.f === dropped.f)) pick.f.track = { start: pick.f.player.fielder.reaction, end: timeTo(pick.f, pick.pos), to: pick.pos };
  let holdT = pick.t + PICKUP;
  if (!result.error && rng.next() < pick.f.player.fielder.errorRate * 0.8) {
    holdT += 0.9;
    result.error = true;
    credit.errors.push(pick.f.player);
    events.push({ t: pick.t, type: 'error', fielder: pick.f.player, what: 'bobble' });
  }
  result.fieldedBy = pick.f;
  const groundBall = batted.launch.launchAngleDeg < 10 && landingT < 0.6;
  const runStart = (ctx.outs === 2 || groundBall || !Number.isFinite(landingT)) ? 0.1 : Math.max(0.1, Math.min(landingT - 0.5, 1.2));
  for (const r of runners) if (!r.isBatter) r.start = runStart;
  return runPlay({ holder: pick.f, holdT, holdPos: pick.pos, tagUp: false, groundBall });

  // ---------- 3. runners vs throws ----------
  function runPlay({ holder, holdT, holdPos, tagUp, groundBall = false }) {
    const others = fielders.filter((f) => f !== holder);
    // Bases are covered by the nearest free fielder (one per base).
    const coverers = [];
    const used = new Set();
    for (const b of [1, 2, 3, 4]) {
      let c = null;
      for (const f of others) {
        if (used.has(f)) continue;
        const t = timeTo(f, bases[b]);
        if (!c || t < c.t) c = { f, t };
      }
      if (c) {
        used.add(c.f);
        coverers[b] = c;
        if (!c.f.track) c.f.track = { start: c.f.player.fielder.reaction, end: c.t, to: bases[b] };
      }
    }
    const throwSpeed = (f) => f.player.fielder.throwSpeed;
    // When the ball can be at base b if the holder goes there (throw or run it himself).
    const ballAt = (b, from = holdPos, t0 = holdT, thrower = holder) => {
      const self = t0 + runTime(dist2(from, bases[b]), thrower.speed);
      const cov = coverers[b];
      const thrown = Math.max(t0 + TRANSFER + throwTime(dist2(from, bases[b]), throwSpeed(thrower)), cov ? cov.t : Infinity);
      return dist2(from, bases[b]) < ftToM(12) || !cov ? Math.min(self, thrown) : thrown;
    };

    const batterR = runners.find((r) => r.isBatter);
    if (!tagUp) batterR.start = BATTER_START;
    for (const r of runners) {
      r.arrive = (b) => r.start + pathDist(bases, r.from, b) / r.speed + TURN * Math.max(0, b - r.from - 1);
    }

    // Forced runners: everyone behind whom the bases are full.
    const occupied = new Set(runners.filter((r) => !r.isBatter && !r.out).map((r) => r.from));
    for (const r of runners) {
      if (r.out) continue;
      if (tagUp) r.forced = false;
      else if (r.isBatter) r.forced = true;
      else {
        let f = true;
        for (let b = 1; b < r.from; b++) if (!occupied.has(b)) f = false;
        r.forced = f;
      }
    }

    // Each runner decides how far to go, lead runner first.
    let limit = 4;
    const alive = runners.filter((r) => !r.out).sort((a, b) => b.from - a.from);
    for (const r of alive) {
      let target = r.forced ? r.from + 1 : r.from;
      const misjudge = rng.gaussian() * 0.25;
      while (target < 4 && target + 1 <= limit) {
        const next = target + 1;
        if (r.arrive(next) + CUSHION + misjudge < ballAt(next)) target = next;
        else break;
      }
      // Runners on ground balls with a force behind them must at least move up.
      r.target = Math.max(target, r.forced ? r.from + 1 : r.from);
      limit = r.target === 4 ? 4 : r.target - 1;
    }

    // Defense: retire the lead runner it can; otherwise the batter-runner.
    const outTime = (r) => ballAt(r.target) + (r.forced || (r.isBatter && r.target === 1) ? 0 : TAG);
    const canGet = (r) => r.target > r.from && !r.out && outTime(r) < r.arrive(r.target);
    // Tag-up runners who stay put can't be doubled off in this model.
    let candidates = alive.filter((r) => canGet(r));
    let outsSoFar = ctx.outs + result.outsRecorded;
    let lastOut = null;
    if (candidates.length && outsSoFar < 3) {
      candidates.sort((a, b) => b.target - a.target);
      const victim = candidates[0];
      const tOut = outTime(victim);
      const viaThrow = dist2(holdPos, bases[victim.target]) >= ftToM(12) && coverers[victim.target];
      if (viaThrow && rng.next() < holder.player.fielder.errorRate) {
        // Throwing error: everyone takes an extra base.
        result.error = true;
        credit.errors.push(holder.player);
        events.push({ t: tOut, type: 'error', fielder: holder.player, what: 'throwing error' });
        throws.push({ from: holdPos, to: bases[victim.target], t0: holdT + TRANSFER, t1: tOut, wild: true });
        for (const r of alive) r.target = Math.min(4, r.target + 1);
      } else {
        victim.out = true;
        victim.outAt = tOut;
        victim.forceOut = victim.forced;
        lastOut = victim;
        result.outsRecorded++;
        outsSoFar++;
        const receiver = viaThrow ? coverers[victim.target].f : holder;
        credit.putouts.push(receiver.player);
        if (viaThrow) {
          credit.assists.push(holder.player);
          throws.push({ from: holdPos, to: bases[victim.target], t0: holdT + TRANSFER, t1: tOut });
        }
        events.push({ t: tOut, type: 'out', runner: victim.player, base: victim.target, by: receiver.player });
        // Double play: relay from that base.
        if (outsSoFar < 3 && !tagUp) {
          const relayFrom = bases[victim.target];
          const cands2 = alive.filter((r) => !r.out && r.target > r.from && r !== victim);
          let dp = null;
          for (const r of cands2) {
            if (!coverers[r.target] || coverers[r.target].f === receiver) continue;
            const t2 = ballAt(r.target, relayFrom, tOut, receiver) + (r.forced ? 0 : TAG);
            if (t2 < r.arrive(r.target) && (!dp || r.target > dp.r.target)) dp = { r, t2 };
          }
          if (dp) {
            dp.r.out = true;
            dp.r.outAt = dp.t2;
            dp.r.forceOut = dp.r.forced;
            lastOut = dp.r;
            result.outsRecorded++;
            outsSoFar++;
            result.doublePlay = true;
            credit.assists.push(receiver.player);
            credit.putouts.push(coverers[dp.r.target].f.player);
            throws.push({ from: relayFrom, to: bases[dp.r.target], t0: tOut + TRANSFER, t1: dp.t2 });
            events.push({ t: dp.t2, type: 'out', runner: dp.r.player, base: dp.r.target, by: coverers[dp.r.target].f.player });
          }
        }
      }
    } else if (!tagUp) {
      // No play: the ball comes back in toward the lead runner's next base.
      const lead = alive.find((r) => !r.out && r.target < 4);
      const b = lead ? Math.min(4, lead.target + 1) : 2;
      throws.push({ from: holdPos, to: bases[b], t0: holdT + TRANSFER, t1: holdT + TRANSFER + throwTime(dist2(holdPos, bases[b]), throwSpeed(holder)) });
    }

    // Runs: count runners who reached home, unless the third out was a force
    // (or the batter before 1st), or they crossed after the third out.
    const third = outsSoFar >= 3 ? lastOut : null;
    for (const r of runners) {
      if (r.out || r.target !== 4) continue;
      if (third && (third.forceOut || third.isBatter)) continue;
      if (third && r.arrive(4) > third.outAt) continue;
      result.runs.push(r.player);
    }
    if (third) for (const r of runners) if (!r.out && r.target === 4 && !result.runs.includes(r.player)) r.target = r.from; // stranded

    // Batter result.
    const br = runners.find((r) => r.isBatter);
    const otherOut = runners.some((r) => !r.isBatter && r.out);
    if (tagUp) {
      const sac = result.runs.length > 0;
      if (sac) result.batterResult = 'SF';
    } else if (br.out) {
      result.batterResult = result.doublePlay ? 'GDP' : 'GO';
      result.description = `${groundBall ? 'grounds' : 'is'} out${result.doublePlay ? ' — double play' : ''} (${holder.role})`;
    } else if (result.error && credit.errors.length && !otherOut) {
      result.batterResult = 'ROE';
      result.description = `reaches on an error by ${credit.errors[0].name}`;
    } else if (otherOut) {
      result.batterResult = 'FC';
      result.description = `reaches on a fielder's choice (${holder.role})`;
    } else {
      result.hit = true;
      result.batterResult = ['', '1B', '2B', '3B', 'IPHR'][br.target];
      result.description = { 1: 'singles', 2: 'doubles', 3: 'triples', 4: 'inside-the-park home run!' }[br.target] + ` (${holder.role})`;
    }
    if (tagUp && result.batterResult === 'SF') result.description += ', sacrifice fly';

    const endT = Math.max(holdT + 0.5, ...throws.map((t) => t.t1), ...runners.map((r) => (r.out ? r.outAt : r.arrive(r.target))));
    return finish(result, runners, throws, fielders, truncatePath(path, holdT), throws, events, credit, bases, endT, ctx.outs);
  }
}

function truncatePath(path, t) {
  const out = path.filter((s) => s.t <= t);
  const next = path.find((s) => s.t > t);
  if (next && out.length) {
    const a = out[out.length - 1];
    const u = (t - a.t) / (next.t - a.t);
    out.push({ t, pos: { x: a.pos.x + (next.pos.x - a.pos.x) * u, y: a.pos.y + (next.pos.y - a.pos.y) * u, z: a.pos.z + (next.pos.z - a.pos.z) * u } });
  }
  return out;
}

// Runner keyframes along the base paths.
function runnerTrack(r, bases) {
  const keys = [{ t: 0, base: r.from, pos: bases[r.from] }];
  const stopAt = r.out ? r.outAt : Infinity;
  const goal = r.out ? Math.max(r.target, r.from + 1) : r.target;
  let t = r.start ?? 0;
  if (t > 0) keys.push({ t, pos: bases[r.from] });
  for (let b = r.from; b < goal; b++) {
    const seg = dist2(bases[b], bases[b + 1]) / r.speed;
    const t1 = t + seg + (b > r.from ? TURN : 0);
    if (t1 > stopAt) {
      const u = Math.max(0, Math.min(1, (stopAt - t) / (t1 - t)));
      keys.push({ t: stopAt, pos: { x: bases[b].x + (bases[b + 1].x - bases[b].x) * u, y: bases[b].y + (bases[b + 1].y - bases[b].y) * u } });
      break;
    }
    keys.push({ t: t1, pos: bases[b + 1] });
    t = t1;
  }
  return keys;
}

function buildTimeline(path, runners, fielders, throws, _unused, endT, bases) {
  // Ball: batted path, then each throw (with a gentle arc).
  const ball = path.map((s) => ({ t: s.t, x: s.pos.x, y: s.pos.y, z: s.pos.z }));
  for (const th of throws) {
    const steps = 8;
    for (let i = 0; i <= steps; i++) {
      const u = i / steps;
      ball.push({
        t: th.t0 + (th.t1 - th.t0) * u,
        x: th.from.x + (th.to.x - th.from.x) * u,
        y: th.from.y + (th.to.y - th.from.y) * u,
        z: 1.5 + Math.sin(Math.PI * u) * Math.min(3, dist2(th.from, th.to) * 0.08),
      });
    }
  }
  ball.sort((a, b) => a.t - b.t);
  return {
    end: endT,
    ball,
    fielders: fielders.map((f) => ({
      player: f.player,
      role: f.role,
      keys: f.track
        ? [{ t: 0, pos: f.pos }, { t: f.track.start, pos: f.pos }, { t: f.track.end, pos: f.track.to }]
        : [{ t: 0, pos: f.pos }],
    })),
    runners: runners.map((r) => ({ player: r.player, from: r.from, out: !!r.out, outAt: r.outAt ?? null, scored: r.target === 4 && !r.out, keys: runnerTrack(r, bases) })),
  };
}

function finish(result, runners, throwsArg, fielders, path, throws, events, credit, bases, endT, outsBefore) {
  const newBases = [null, null, null];
  for (const r of runners) {
    if (r.out || r.target === 4 || r.target === 0) continue;
    newBases[r.target - 1] = { player: r.player };
  }
  if (outsBefore + result.outsRecorded >= 3) newBases.fill(null);
  return {
    ...result,
    foul: false,
    bases: newBases,
    credit,
    events,
    runnersOut: runners.filter((r) => r.out).map((r) => ({ player: r.player, base: r.target, force: !!r.forceOut })),
    advances: runners.filter((r) => !r.out).map((r) => ({ player: r.player, from: r.from, to: r.target })),
    timeline: buildTimeline(path, runners, fielders, throws, 0, endT, bases),
  };
}

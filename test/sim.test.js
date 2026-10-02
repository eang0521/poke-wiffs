import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createField, throwPitch, simulateBattedBall, PITCH_TYPES, mToFt, mToIn, DEG } from '../src/index.js';

const field = createField();
const ft = (p, q) => mToFt(Math.hypot(p.x - q.x, p.y - q.y));
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);

test('basepaths are 45 / 40 / 40 / 45 ft', () => {
  const { home, first, second, third } = field.bases;
  near(ft(home, first), 45, 1e-6, 'home-1st');
  near(ft(first, second), 40, 1e-6, '1st-2nd');
  near(ft(second, third), 40, 1e-6, '2nd-3rd');
  near(ft(third, home), 45, 1e-6, '3rd-home');
});

test('foul lines open 75° from the base of the strike zone, through 1st and 3rd', () => {
  const a1 = field.sprayAngle(field.bases.first) / DEG;
  const a3 = field.sprayAngle(field.bases.third) / DEG;
  near(a1 - a3, 75, 1e-6, 'opening');
  near(mToFt(field.apex.y), -4, 1e-9, 'apex 4 ft behind home');
});

test('strike zone is 23 x 28 in, 17 in off the ground; mound at 38 ft', () => {
  near(mToIn(field.zone.halfWidth * 2), 23, 1e-9, 'width');
  near(mToIn(field.zone.top - field.zone.bottom), 28, 1e-9, 'height');
  near(mToIn(field.zone.bottom), 17, 1e-9, 'bottom');
  near(mToFt(field.mound.y), 38, 1e-9, 'mound');
});

test('fence: 5 straight segments, ~100 ft from home, poles on the foul lines', () => {
  assert.equal(field.fence.length, 5);
  for (const v of field.fenceVertices) near(mToFt(Math.hypot(v.x, v.y)), 100, 1e-6, 'vertex radius');
  near(Math.abs(field.sprayAngle(field.foulPoles.left)) / DEG, 37.5, 1e-6, 'left pole on line');
  near(Math.abs(field.sprayAngle(field.foulPoles.right)) / DEG, 37.5, 1e-6, 'right pole on line');
  const cf = mToFt(field.fenceDistance(0));
  assert.ok(cf > 98.5 && cf <= 100, `center field depth ${cf}`);
});

test('custom fence vertices are supported', () => {
  const f = createField({ fence: { vertices: [[-50, 62], [0, 95], [50, 62]], heightsFt: [6, 10] } });
  assert.equal(f.fence.length, 2);
  near(mToFt(f.fence[1].height), 10, 1e-9, 'segment height');
});

test('every pitch hits its target when thrown without execution error', () => {
  for (const key of PITCH_TYPES) {
    const r = throwPitch({ pitch: key, field, execution: false });
    assert.equal(r.result, 'strike', key);
    assert.ok(mToIn(r.missFromTarget) < 0.25, `${key} aim residual ${mToIn(r.missFromTarget)} in`);
    assert.ok(r.endSpeedMph < r.releaseSpeedMph, `${key} slows down`);
  }
});

test('aim works on the corners', () => {
  const r = throwPitch({ pitch: 'curveball', field, execution: false, target: { x: 0.8, z: 1.6 } });
  near(mToFt(r.crossing.pos.x), 0.8, 0.02, 'x');
  near(mToFt(r.crossing.pos.z), 1.6, 0.02, 'z');
});

const brk = (pitch, hand = 'R') => {
  const r = throwPitch({ pitch, hand, field, execution: false });
  return { glove: mToIn(r.break.gloveSide), x: mToIn(r.break.x), z: mToIn(r.break.z) };
};

test('pitch shapes follow wiffle physics', () => {
  assert.ok(brk('slider').glove > 15, 'slider breaks glove side');
  assert.ok(brk('curveball').glove > 15 && brk('curveball').z < -25, 'curve: glove side and down');
  assert.ok(brk('screwball').glove < -15, 'screwball breaks arm side');
  assert.ok(brk('sinker').glove < -5 && brk('sinker').z < -20, 'sinker: arm side and down');
  assert.ok(brk('slideDrop').glove > 5 && brk('slideDrop').z < -25, 'slide drop: diagonal');
  assert.ok(brk('riser').z > brk('fastball').z, 'riser carries more than fastball');
  assert.ok(brk('drop').z < -40, 'drop dives');
  const rise = throwPitch({ pitch: 'riser', field, execution: false, target: { x: 0, z: 3.5 } });
  assert.ok(rise.crossing.pos.z > rise.release.z, 'riser actually climbs from a submarine release');
});

test('left-handers mirror right-handers', () => {
  for (const p of ['slider', 'screwball', 'curveball', 'riser']) {
    const r = brk(p, 'R');
    const l = brk(p, 'L');
    near(l.x, -r.x, 0.3, `${p} x mirrored`);
    near(l.z, r.z, 0.3, `${p} z same`);
  }
});

test('knuckleball is unpredictable; same seed is reproducible', () => {
  const xs = [];
  for (let s = 1; s <= 12; s++) xs.push(mToIn(throwPitch({ pitch: 'knuckleball', field, seed: s }).break.x));
  const spread = Math.max(...xs) - Math.min(...xs);
  assert.ok(spread > 20, `knuckle spread ${spread} in`);
  const a = throwPitch({ pitch: 'knuckleball', field, seed: 5 });
  const b = throwPitch({ pitch: 'knuckleball', field, seed: 5 });
  assert.deepEqual(a.crossing.pos, b.crossing.pos);
});

test('batted balls: homers, wall balls, fouls', () => {
  const hr = simulateBattedBall({ field, exitVeloMph: 80, launchAngleDeg: 28 });
  assert.equal(hr.outcome, 'home_run');
  assert.ok(mToFt(hr.firstLanding.distance) > 100);

  const wallBall = simulateBattedBall({ field, exitVeloMph: 70, launchAngleDeg: 45 });
  assert.equal(wallBall.outcome, 'fair');
  assert.ok(wallBall.hitWall, 'high fly caroms off the wall');

  const foul = simulateBattedBall({ field, exitVeloMph: 75, launchAngleDeg: 25, sprayAngleDeg: 55 });
  assert.equal(foul.outcome, 'foul');

  const grounder = simulateBattedBall({ field, exitVeloMph: 40, launchAngleDeg: -10, sprayAngleDeg: 5 });
  assert.equal(grounder.outcome, 'fair');
  assert.ok(grounder.restDistance < field.fenceDistance(0));
});

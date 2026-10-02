import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createField, throwPitch, swingAtPitch, idealContact, ballStateAt, batEffectiveMass, WIFFLE_BAT, mToFt } from '../src/index.js';

const field = createField();
const fastball = throwPitch({ pitch: 'fastball', field, execution: false });

function swing({ hand = 'R', dtMs = 0, dzIn = 0, dxFt = 0, type, pitch = fastball } = {}) {
  const id = idealContact(pitch, { hand });
  return swingAtPitch({
    pitch, field, type, batter: { hand }, timing: id.t + dtMs / 1000,
    aimFt: { x: mToFt(id.pos.x) + dxFt, z: mToFt(id.pos.z) + dzIn / 12 },
  });
}

test('Hermite interpolation reproduces sample points', () => {
  const s = fastball.samples[40];
  const st = ballStateAt(fastball.samples, s.t);
  assert.ok(Math.hypot(st.pos.x - s.pos.x, st.pos.y - s.pos.y, st.pos.z - s.pos.z) < 1e-9);
});

test('squared-up contact is a hard line drive up the middle', () => {
  const r = swing();
  assert.ok(r.contact);
  assert.ok(r.exitVeloMph > 70, `EV ${r.exitVeloMph}`);
  assert.ok(Math.abs(r.launchAngleDeg) < 15, `LA ${r.launchAngleDeg}`);
  assert.ok(Math.abs(r.sprayAngleDeg) < 10, `spray ${r.sprayAngleDeg}`);
  assert.ok(Math.abs(r.inchesFromSweetSpot) < 1.5);
  assert.ok(r.exitVeloMph > r.batSpeedMph, 'light ball leaves faster than the bat');
});

test('early pulls, late goes the other way (and mirrors for lefties)', () => {
  assert.ok(swing({ dtMs: -12 }).sprayAngleDeg < -5, 'RHB early → left field');
  assert.ok(swing({ dtMs: 12 }).sprayAngleDeg > 5, 'RHB late → right field');
  assert.ok(swing({ hand: 'L', dtMs: -12 }).sprayAngleDeg > 5, 'LHB early → right field');
  assert.ok(swing({ hand: 'L', dtMs: 12 }).sprayAngleDeg < -5, 'LHB late → left field');
});

test('undercut lifts with backspin; topping drives it down with topspin', () => {
  const under = swing({ dzIn: -1 });
  const over = swing({ dzIn: 1 });
  assert.ok(under.launchAngleDeg > 25 && under.backspinRpm > 1000, `under LA ${under.launchAngleDeg} spin ${under.backspinRpm}`);
  assert.ok(over.launchAngleDeg < -10 && over.backspinRpm < -1000, `over LA ${over.launchAngleDeg} spin ${over.backspinRpm}`);
});

test('way off in height is a swing and miss', () => {
  const r = swing({ dzIn: 6 });
  assert.equal(r.contact, false);
  assert.equal(r.miss.ballAbove, false, 'swung over it');
});

test('off the handle is weak; sweet spot is best', () => {
  const sweet = swing({ dzIn: -0.5 });
  const handle = swing({ dzIn: -0.5, dxFt: 1.3 });
  assert.ok(handle.contact && handle.inchesFromTip > 18);
  assert.ok(handle.exitVeloMph < sweet.exitVeloMph - 20, `handle ${handle.exitVeloMph} vs ${sweet.exitVeloMph}`);
});

test('power swing hits harder and higher than contact swing', () => {
  const p = swing({ type: 'power', dzIn: -0.5 });
  const c = swing({ type: 'contact', dzIn: -0.5 });
  assert.ok(p.batSpeedMph > c.batSpeedMph);
  assert.ok(p.exitVeloMph > c.exitVeloMph);
});

test('effective bat mass peaks near the center of mass', () => {
  const L = WIFFLE_BAT.length;
  assert.ok(batEffectiveMass(WIFFLE_BAT, 0.52 * L) > batEffectiveMass(WIFFLE_BAT, 0.95 * L));
  assert.ok(Math.abs(batEffectiveMass(WIFFLE_BAT, 0.52 * L) - WIFFLE_BAT.mass) < 1e-9);
});

test('contact hands off to batted-ball flight', () => {
  const r = swing({ dzIn: -0.8, dtMs: 3 });
  assert.ok(r.contact && r.batted);
  assert.ok(['home_run', 'fair', 'foul'].includes(r.batted.outcome));
  assert.ok(Math.abs(r.batted.launch.exitVeloMph - r.exitVeloMph) < 1e-9);
});

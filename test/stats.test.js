import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createField, throwPitch, swingAtPitch, idealContact, batterFromStats, pitcherFromStats, pitcherFatigue,
  statRating, SAMPLE_POKEMON, BATTER_CONVERSION, PITCHER_CONVERSION, STAT_KEYS, mToIn, mToFt,
} from '../src/index.js';

const field = createField();
const mon = (name) => SAMPLE_POKEMON[name].stats;
const flat = (v) => Object.fromEntries(STAT_KEYS.map((k) => [k, v]));

test('every Pokémon stat feeds exactly one batting and one pitching attribute', () => {
  assert.deepEqual(Object.keys(BATTER_CONVERSION).sort(), [...STAT_KEYS].sort());
  assert.deepEqual(Object.keys(PITCHER_CONVERSION).sort(), [...STAT_KEYS].sort());
});

test('rating curve: linear in range, soft-capped outside', () => {
  assert.equal(statRating(30), 0);
  assert.equal(statRating(150), 1);
  assert.ok(Math.abs(statRating(90) - 0.5) < 1e-9);
  assert.ok(statRating(255) > 1 && statRating(255) <= 1.2);
  assert.ok(statRating(1) < 0 && statRating(1) >= -0.15);
});

test('missing stats are rejected', () => {
  assert.throws(() => batterFromStats({ attack: 50 }), /Missing/);
});

test('pitcher Attack → velocity, Speed → extension (less reaction time)', () => {
  const fast = throwPitch({ pitch: 'fastball', field, execution: false, pitcher: pitcherFromStats({ ...flat(80), attack: 140 }) });
  const slow = throwPitch({ pitch: 'fastball', field, execution: false, pitcher: pitcherFromStats({ ...flat(80), attack: 40 }) });
  assert.ok(fast.releaseSpeedMph > slow.releaseSpeedMph + 10);
  const longArm = throwPitch({ pitch: 'fastball', field, execution: false, pitcher: pitcherFromStats({ ...flat(80), speed: 150 }) });
  const shortArm = throwPitch({ pitch: 'fastball', field, execution: false, pitcher: pitcherFromStats({ ...flat(80), speed: 30 }) });
  assert.ok(mToFt(shortArm.release.y - longArm.release.y) > 2);
  assert.ok(longArm.flightTime < shortArm.flightTime);
});

test('pitcher Sp. Atk → more movement on spin pitches and slot pitches', () => {
  const hi = pitcherFromStats({ ...flat(80), spAttack: 150 });
  const lo = pitcherFromStats({ ...flat(80), spAttack: 30 });
  const brk = (p, pitcher) => {
    const b = throwPitch({ pitch: p, field, execution: false, pitcher }).break;
    return { z: mToIn(b.z), gloveSide: mToIn(b.gloveSide) };
  };
  assert.ok(brk('drop', hi).z < brk('drop', lo).z - 8, 'drop dives more');
  assert.ok(brk('slider', hi).gloveSide > brk('slider', lo).gloveSide + 6, 'slider sweeps more');
});

test('pitcher Sp. Def → command', () => {
  const avgMiss = (spDefense) => {
    const P = pitcherFromStats({ ...flat(80), spDefense });
    let m = 0;
    for (let s = 1; s <= 30; s++) m += throwPitch({ pitch: 'fastball', field, pitcher: P, seed: s }).missFromTarget;
    return mToIn(m / 30);
  };
  assert.ok(avgMiss(150) < avgMiss(30) * 0.7);
});

test('pitcher HP → stamina; fatigue past the limit costs velocity and command', () => {
  const P = pitcherFromStats(mon('snorlax'));
  assert.ok(P.staminaPitches > pitcherFromStats(mon('pikachu')).staminaPitches);
  assert.equal(pitcherFatigue(P, 10).tired, false);
  const f = pitcherFatigue(P, P.staminaPitches + 20);
  assert.ok(f.tired && f.velocityScale < 1 && f.commandScale > 1);
  const fresh = throwPitch({ pitch: 'fastball', field, execution: false, pitcher: P, pitchCount: 0 });
  const tired = throwPitch({ pitch: 'fastball', field, execution: false, pitcher: P, pitchCount: P.staminaPitches + 20 });
  assert.ok(tired.releaseSpeedMph < fresh.releaseSpeedMph);
});

test('batter Attack → bat speed → exit velo', () => {
  const pitch = throwPitch({ pitch: 'fastball', field, execution: false });
  const hit = (attack) => {
    const B = batterFromStats({ ...flat(80), attack });
    const id = idealContact(pitch, B);
    return swingAtPitch({ pitch, field, batter: B, timing: id.t, aimFt: { x: mToFt(id.pos.x), z: mToFt(id.pos.z) } });
  };
  assert.ok(hit(140).exitVeloMph > hit(40).exitVeloMph + 15);
});

test('batter Sp. Atk → contact assist shrinks aim and timing error', () => {
  const pitch = throwPitch({ pitch: 'fastball', field, execution: false });
  const go = (spAttack) => {
    const B = batterFromStats({ ...flat(80), spAttack });
    const id = idealContact(pitch, B);
    return swingAtPitch({ pitch, field, batter: B, timing: id.t + 0.012, aimFt: { x: mToFt(id.pos.x), z: mToFt(id.pos.z) + 0.1 } });
  };
  const good = go(150);
  const bad = go(30);
  assert.ok(Math.abs(good.timingErrorMs) < Math.abs(bad.timingErrorMs));
  assert.ok(Math.abs(good.rawTimingErrorMs - 12) < 1e-6, 'raw input is reported unchanged');
  assert.ok(good.launchAngleDeg > bad.launchAngleDeg, 'less topping with better contact');
});

test('batter Speed → quicker swing', () => {
  assert.ok(batterFromStats({ ...flat(80), speed: 150 }).swingTime < batterFromStats({ ...flat(80), speed: 30 }).swingTime);
});

test('profiles carry hand through to the sim', () => {
  const P = pitcherFromStats(mon('gengar'), { hand: 'L', name: 'Gengar' });
  const r = throwPitch({ pitch: 'slider', field, execution: false, pitcher: P });
  assert.equal(r.hand, 'L');
  assert.equal(r.pitcher, 'Gengar');
  assert.ok(r.break.x < 0, 'LHP slider breaks toward 3B side');
});

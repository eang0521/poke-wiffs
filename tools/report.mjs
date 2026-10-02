// Prints field geometry, pitch movement, and batted-ball outcomes.
// Usage: node tools/report.mjs [R|L]

import {
  createField, PITCH_TYPES, throwPitch, simulateBattedBall, swingAtPitch, idealContact, mToFt, mToIn,
  batterFromStats, pitcherFromStats, SAMPLE_POKEMON,
} from '../src/index.js';

const hand = process.argv[2] === 'L' ? 'L' : 'R';
const field = createField();
const f = (n, d = 1) => n.toFixed(d).padStart(7);
const pt = (p) => `(${mToFt(p.x).toFixed(1)}, ${mToFt(p.y).toFixed(1)}) ft  r=${mToFt(Math.hypot(p.x, p.y)).toFixed(1)}`;

console.log('FIELD');
for (const [k, p] of Object.entries(field.bases)) console.log(`  ${k.padEnd(7)} ${pt(p)}`);
console.log(`  mound   ${pt(field.mound)}`);
console.log(`  zone    y=${mToFt(field.zone.y).toFixed(1)} ft, ${mToIn(field.zone.bottom).toFixed(0)}-${mToIn(field.zone.top).toFixed(0)} in high, ±${mToIn(field.zone.halfWidth).toFixed(1)} in`);
field.fence.forEach((s, i) =>
  console.log(`  fence ${i}: ${pt(s.a)} -> ${pt(s.b)}  len ${mToFt(s.length).toFixed(1)} ft  h ${mToFt(s.height).toFixed(1)} ft`));

console.log(`\nPITCHES (${hand}HP, aimed at zone center, no execution error)`);
console.log('  pitch          rel mph  zone mph   time s   brk-x in  brk-z in  glove in  drop in   result');
for (const key of PITCH_TYPES) {
  const r = throwPitch({ pitch: key, hand, field, execution: false, seed: 7 });
  console.log(
    `  ${r.pitch.padEnd(13)}${f(r.releaseSpeedMph)}${f(r.endSpeedMph, 1).padStart(10)}${f(r.flightTime, 3).padStart(9)}` +
      `${f(mToIn(r.break.x)).padStart(11)}${f(mToIn(r.break.z)).padStart(10)}${f(mToIn(r.break.gloveSide)).padStart(10)}` +
      `${f(mToIn(r.totalDrop)).padStart(9)}   ${r.result}${r.missFromTarget != null ? ` (miss ${mToIn(r.missFromTarget).toFixed(2)} in)` : ''}`,
  );
}

console.log('\nKNUCKLEBALL spread (10 seeds, with execution)');
const ks = [];
for (let s = 1; s <= 10; s++) {
  const r = throwPitch({ pitch: 'knuckleball', hand, field, seed: s });
  ks.push(r);
  console.log(`  seed ${String(s).padStart(2)}  brk-x ${f(mToIn(r.break.x))} in  brk-z ${f(mToIn(r.break.z))} in  ${r.result}`);
}

console.log('\nBATTED BALLS (straightaway center unless noted)');
const cases = [
  [60, 10, 0], [70, 20, 0], [75, 25, 0], [80, 28, 0], [85, 30, 0], [90, 30, 0], [80, 28, 30], [80, 28, -36],
  [80, 28, 45], [70, 45, 0], [65, -5, 10], [50, 60, 0],
];
for (const [ev, laDeg, spray] of cases) {
  const b = simulateBattedBall({ field, exitVeloMph: ev, launchAngleDeg: laDeg, sprayAngleDeg: spray });
  const land = b.firstLanding ? `${mToFt(b.firstLanding.distance).toFixed(0)} ft` : '-';
  console.log(
    `  EV ${ev} LA ${String(laDeg).padStart(3)} spray ${String(spray).padStart(3)}: ${b.outcome.padEnd(9)} ` +
      `carry ${land.padStart(6)}  apex ${mToFt(b.apex).toFixed(1)} ft  hang ${b.hangTime?.toFixed(2)} s  ` +
      `rest ${mToFt(b.restDistance).toFixed(0)} ft${b.hitWall ? ' [off wall]' : ''}${b.reachedWall ? ' [rolled to wall]' : ''}`,
  );
}

console.log(`
CONTACT GRID vs ${hand}HP fastball, RH batter, normal swing  (EV mph / launch° / spray° → outcome)`);
const fb = throwPitch({ pitch: 'fastball', hand, field, execution: false });
const id = idealContact(fb);
const short = { home_run: 'HR', fair: 'fair', foul: 'foul' };
console.log('  bat vs ball ' + [-15, -8, 0, 8, 15].map((d) => `${d > 0 ? '+' : ''}${d} ms`.padStart(22)).join(''));
for (const dz of [1.5, 0.75, 0, -0.75, -1.5]) {
  let line = `  ${(dz > 0 ? `${dz}" under` : dz < 0 ? `${-dz}" over` : 'center').padEnd(12)}`;
  for (const dms of [-15, -8, 0, 8, 15]) {
    const r = swingAtPitch({ pitch: fb, field, timing: id.t + dms / 1000, aimFt: { x: mToFt(id.pos.x), z: mToFt(id.pos.z) - dz / 12 } });
    line += (r.contact
      ? `${r.exitVeloMph.toFixed(0)}/${r.launchAngleDeg.toFixed(0)}/${r.sprayAngleDeg.toFixed(0)} ${short[r.batted.outcome]}`
      : 'miss').padStart(22);
  }
  console.log(line);
}

console.log('\nPOKEMON (stats → wiffle). Pitcher: fastball speed release→zone, curveball break, avg slider miss (20 throws).');
console.log('Batter: perfectly timed swing (4 ms late, 0.6" under) on a neutral fastball.');
const neutralFb = throwPitch({ pitch: 'fastball', field, execution: false });
for (const p of Object.values(SAMPLE_POKEMON)) {
  const P = pitcherFromStats(p.stats, { name: p.name });
  const B = batterFromStats(p.stats, { name: p.name });
  const fbP = throwPitch({ pitch: 'fastball', field, pitcher: P, execution: false });
  const cv = throwPitch({ pitch: 'curveball', field, pitcher: P, execution: false });
  let miss = 0;
  for (let s = 1; s <= 20; s++) miss += mToIn(throwPitch({ pitch: 'slider', field, pitcher: P, seed: s }).missFromTarget ?? 30);
  const ic = idealContact(neutralFb, B);
  const sw = swingAtPitch({ pitch: neutralFb, field, batter: B, timing: ic.t + 0.004, aimFt: { x: mToFt(ic.pos.x), z: mToFt(ic.pos.z) - 0.05 } });
  console.log(
    `  ${p.name.padEnd(11)} FB ${fbP.releaseSpeedMph.toFixed(0)}→${fbP.endSpeedMph.toFixed(0)}  CB ${mToIn(cv.break.gloveSide).toFixed(0)}"/${mToIn(cv.break.z).toFixed(0)}"` +
      `  miss ${(miss / 20).toFixed(1)}"  stamina ${P.staminaPitches.toFixed(0)}  |  bat ${B.batSpeedMph.toFixed(0)} mph  contact ${B.contact.toFixed(2)}` +
      `  swing ${(B.swingTime * 1000).toFixed(0)} ms  →  ${sw.exitVeloMph.toFixed(0)} mph ${sw.launchAngleDeg.toFixed(0)}° ${sw.batted.outcome} ${mToFt(sw.batted.firstLanding?.distance ?? 0).toFixed(0)} ft`,
  );
}

// Sims many CPU-vs-CPU games between random teams and prints league-wide rates.
// Usage: node tools/season.mjs [games=100] [seed=1]
import { POKEDEX, createTeam, createGame, createRng } from '../src/index.js';

const N = Number(process.argv[2] ?? 100);
const rng = createRng(Number(process.argv[3] ?? 1));
// Draw from Pokémon with a reasonable stat total so teams aren't all babies.
const pool = POKEDEX.filter((p) => Object.values(p.stats).reduce((a, b) => a + b, 0) >= 420);
const pickTeam = (name) => {
  const set = new Set();
  while (set.size < 6) set.add(pool[Math.floor(rng.next() * pool.length)].slug);
  return createTeam(name, [...set]);
};

const t = { g: 0, r: 0, pa: 0, ab: 0, h: 0, d: 0, tr: 0, hr: 0, bb: 0, k: 0, e: 0, pitches: 0, innings: 0, sf: 0, dp: 0, ip: 0, iphr: 0, extra: 0, ms: 0 };
const kinds = {};
const t0 = Date.now();
for (let i = 0; i < N; i++) {
  const game = createGame({ away: pickTeam('Away'), home: pickTeam('Home'), seed: i + 1 });
  const g = game.playToEnd();
  t.g++;
  t.innings += g.innings;
  if (g.innings > game.rules.innings) t.extra++;
  t.r += g.score.away + g.score.home;
  t.e += g.errors.away + g.errors.home;
  for (const side of ['away', 'home']) for (const l of g.box[side]) {
    t.pa += l.pa; t.ab += l.ab; t.h += l.h; t.d += l.d; t.tr += l.t; t.hr += l.hr; t.bb += l.bb; t.k += l.k; t.pitches += l.pitches;
  }
  for (const e of g.log) {
    kinds[e.type] = (kinds[e.type] ?? 0) + 1;
    if (/double play/.test(e.text)) t.dp++;
    if (/inside-the-park/.test(e.text)) t.iphr++;
  }
}
const ms = Date.now() - t0;
const avg = t.h / t.ab;
const obp = (t.h + t.bb) / t.pa;
const slg = (t.h + t.d + 2 * t.tr + 3 * t.hr) / t.ab;
const per = (x) => (x / t.g).toFixed(2);
console.log(`${t.g} games in ${(ms / 1000).toFixed(1)} s (${(ms / t.g).toFixed(0)} ms/game)`);
console.log(`Runs/team/game ${(t.r / t.g / 2).toFixed(2)}   innings/game ${per(t.innings)} (extra-inning games ${t.extra})`);
console.log(`AVG ${avg.toFixed(3)}  OBP ${obp.toFixed(3)}  SLG ${slg.toFixed(3)}`);
console.log(`K% ${(100 * t.k / t.pa).toFixed(1)}  BB% ${(100 * t.bb / t.pa).toFixed(1)}  HR/game ${per(t.hr)} (inside-the-park ${t.iphr})  2B/game ${per(t.d)}  3B/game ${per(t.tr)}`);
console.log(`Errors/game ${per(t.e)}  DP/game ${per(t.dp)}  pitches/team/game ${(t.pitches / t.g / 2).toFixed(0)}  PA/team/game ${(t.pa / t.g / 2).toFixed(1)}`);
console.log('Pitch outcomes:', Object.entries(kinds).map(([k, v]) => `${k} ${v}`).join(', '));

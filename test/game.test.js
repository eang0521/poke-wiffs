import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createField, createTeam, createPlayer, createGame, resolvePlay, simulateBattedBall, throwTime, defaultArsenal,
  DEFAULT_ALIGNMENT, getPokemon, POKEDEX, ftToM, mToFt,
} from '../src/index.js';

const field = createField();
const A = ['machamp', 'alakazam', 'snorlax', 'gengar', 'pikachu', 'blastoise'];
const B = ['charizard', 'gyarados', 'jigglypuff', 'mewtwo', 'lapras', 'scizor'];

test('pokédex has every species with stats', () => {
  assert.equal(POKEDEX.length, 1025);
  assert.deepEqual(getPokemon('pikachu').stats, { hp: 35, attack: 55, defense: 40, spAttack: 50, spDefense: 50, speed: 90 });
});

test('players get a 4-pitch arsenal led by the fastball, flavored by type', () => {
  const ars = defaultArsenal(getPokemon('gengar'));
  assert.equal(ars.length, 4);
  assert.equal(ars[0], 'fastball');
  assert.ok(ars.includes('knuckleball'), `ghost type throws a knuckler: ${ars}`);
  assert.equal(new Set(ars).size, 4);
  const p = createPlayer('charizard');
  assert.ok(['R', 'L'].includes(p.throws) && ['R', 'L', 'S'].includes(p.bats));
});

test('teams assign every position and lineup slot exactly once', () => {
  const t = createTeam('A', A);
  assert.deepEqual(Object.values(t.positions).sort(), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual([...t.lineup].sort(), [0, 1, 2, 3, 4, 5]);
  assert.throws(() => createTeam('X', A.slice(0, 5)));
});

test('wiffle throws slow down: long throws take disproportionately longer', () => {
  const short = throwTime(10, 22);
  const long = throwTime(30, 22);
  assert.ok(long > 3 * short);
});

const defenseOf = (team) => Object.entries(team.positions).map(([role, idx]) => ({
  player: team.players[idx], role, pos: { x: ftToM(DEFAULT_ALIGNMENT[role][0]), y: ftToM(DEFAULT_ALIGNMENT[role][1]) },
}));

test('plays: routine fly is caught, homer clears everyone, grounder to short is an out', () => {
  const t = createTeam('D', A);
  const run = (ev, la, sp, bases = [null, null, null]) => resolvePlay({
    batted: simulateBattedBall({ field, exitVeloMph: ev, launchAngleDeg: la, sprayAngleDeg: sp }),
    field, defense: defenseOf(t), bases, batter: { player: t.players[0], speed: 7 }, outs: 0, rng: 3,
  });
  const fly = run(50, 45, -25);
  assert.equal(fly.outsRecorded, 1);
  assert.ok(['FO', 'PO'].includes(fly.batterResult));
  const hr = run(85, 28, 0, [{ player: t.players[1], speed: 7 }, null, null]);
  assert.equal(hr.batterResult, 'HR');
  assert.equal(hr.runs.length, 2);
  const gb = run(45, -10, -8);
  assert.equal(gb.batterResult, 'GO');
});

test('sac fly: runner on third tags and scores on a deep fly', () => {
  const t = createTeam('D', A);
  let scored = false;
  for (let seed = 1; seed < 10 && !scored; seed++) {
    const p = resolvePlay({
      batted: simulateBattedBall({ field, exitVeloMph: 66, launchAngleDeg: 32, sprayAngleDeg: -30, seed }),
      field, defense: defenseOf(t), bases: [null, null, { player: t.players[2], speed: 8 }],
      batter: { player: t.players[0], speed: 7 }, outs: 0, rng: seed,
    });
    if (p.outsRecorded === 1 && p.runs.length === 1) scored = p.batterResult === 'SF';
  }
  assert.ok(scored);
});

test('a full CPU game is internally consistent', () => {
  const g = createGame({ away: createTeam('Away', A), home: createTeam('Home', B), seed: 7 });
  const s = g.playToEnd();
  assert.ok(s.over);
  assert.ok(s.innings >= 6);
  for (const side of ['away', 'home']) {
    const line = s.linescore[side].reduce((a, b) => a + b, 0);
    const runs = s.box[side].reduce((a, l) => a + l.r, 0);
    assert.equal(line, s.score[side], `${side} linescore`);
    assert.equal(runs, s.score[side], `${side} box runs`);
  }
  // Every completed half-inning recorded exactly 3 outs (pitcher outs = 3 × full halves).
  const outsBy = { away: 0, home: 0 };
  for (const side of ['away', 'home']) outsBy[side] = s.box[side].reduce((a, l) => a + l.outs, 0);
  assert.equal(outsBy.home % 3, 0, 'home defense outs');
  if (s.winner) assert.notEqual(s.score.home, s.score.away);
  assert.ok(s.log.length > 50);
});

test('games are reproducible from a seed', () => {
  const run = () => createGame({ away: createTeam('Away', A), home: createTeam('Home', B), seed: 11 }).playToEnd().score;
  assert.deepEqual(run(), run());
});

test('human inputs: take every pitch → walks or strikeouts only', () => {
  const g = createGame({ away: createTeam('Away', A), home: createTeam('Home', B), seed: 3 });
  for (let i = 0; i < 40; i++) {
    g.preparePitch();
    const ev = g.resolvePitch('take');
    assert.ok(['ball', 'called_strike', 'walk', 'strikeout'].includes(ev.kind), ev.kind);
  }
});

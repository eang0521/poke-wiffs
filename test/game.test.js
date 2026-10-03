import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createField, createTeam, createPlayer, createGame, resolvePlay, simulateBattedBall, throwTime, defaultArsenal,
  DEFAULT_ALIGNMENT, getPokemon, POKEDEX, POSITIONS, ftToM, mToFt, matchup, effectiveness, statFactor,
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

test('teams field four (P, 1B, SS, OF); DH bats for the pitcher; the rest sit', () => {
  const t = createTeam('A', A); // DH on by default
  assert.deepEqual(Object.keys(t.positions).sort(), ['1B', 'DH', 'OF', 'P', 'SS']);
  assert.equal(new Set(Object.values(t.positions)).size, 5);
  assert.equal(t.lineup.length, 4);
  assert.ok(!t.lineup.includes(t.positions.P), 'pitcher does not bat with a DH');
  const noDh = createTeam('B', A, { dh: false });
  assert.deepEqual(Object.keys(noDh.positions).sort(), ['1B', 'OF', 'P', 'SS']);
  assert.equal(noDh.lineup.length, 4);
  assert.ok(noDh.lineup.includes(noDh.positions.P), 'pitcher bats without a DH');
  assert.throws(() => createTeam('X', A.slice(0, 5)));
});

test('wiffle throws slow down: long throws take disproportionately longer', () => {
  const short = throwTime(10, 22);
  const long = throwTime(30, 22);
  assert.ok(long > 3 * short);
});

const defenseOf = (team) => POSITIONS.map((role) => [role, team.positions[role]]).map(([role, idx]) => ({
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

test('type chart: classic matchups and dual types', () => {
  assert.equal(effectiveness('water', ['fire']), 2);
  assert.equal(effectiveness('electric', ['ground']), 0);
  assert.equal(effectiveness('ice', ['dragon', 'flying']), 4);
  assert.equal(effectiveness('fire', ['water', 'rock']), 0.25);
  assert.equal(effectiveness('normal', ['fighting']), 1);
  assert.ok(statFactor(2) > 1.25 && statFactor(0.5) < 0.85 && statFactor(0) < statFactor(0.25));
});

test("matchups use each side's best type", () => {
  const m = matchup(createPlayer('blastoise'), createPlayer('charizard')); // water pitcher vs fire/flying batter
  assert.equal(m.pitcher.type, 'water');
  assert.equal(m.pitcher.multiplier, 2);
  assert.equal(m.batter.type, 'flying'); // fire is resisted by water, so charizard uses flying
  assert.equal(m.batter.multiplier, 1);
  const g = matchup(createPlayer('gyarados'), createPlayer('jolteon')); // jolteon's electric vs water/flying
  assert.equal(g.batter.multiplier, 4);
  assert.ok(g.batter.factor > 1.4);
});

test('super effective pitchers throw harder and nastier; resisted batters swing slower', () => {
  const field2 = createField();
  const pitcherTeam = createTeam('P', ['blastoise', 'pikachu', 'machamp', 'alakazam', 'snorlax', 'gengar'], { pitcher: 0 });
  const fireLineup = createTeam('F', ['charizard', 'arcanine', 'rapidash', 'ninetales', 'flareon', 'magmar']);
  const grassLineup = createTeam('G', ['venusaur', 'vileplume', 'victreebel', 'exeggutor', 'tangela', 'bellossom']);
  const firstPitch = (batting) => {
    const g = createGame({ away: batting, home: pitcherTeam, field: field2, seed: 2 });
    g.preparePitch();
    return g.pending;
  };
  const vsFire = firstPitch(fireLineup);
  const vsGrass = firstPitch(grassLineup);
  assert.equal(vsFire.matchup.pitcher.multiplier, 2);
  assert.equal(vsGrass.matchup.pitcher.multiplier, 0.5);
  assert.ok(vsFire.pitch.releaseSpeedMph > vsGrass.pitch.releaseSpeedMph);
  assert.ok(vsFire.bProfile.batSpeedMph < fireLineup.players[0].batter.batSpeedMph * 1.001 || vsFire.matchup.batter.factor < 1);
});

test('role changes: a relieved pitcher can move to DH and keep batting; batting spots follow players', () => {
  const g = createGame({ away: createTeam('Away', A), home: createTeam('Home', B), seed: 4, rules: { dh: true } });
  const sit = g.situation();
  const pos = sit.positions.home;
  const oldP = pos.P;
  const oldDH = pos.DH;
  const dhSlot = sit.lineups.home.indexOf(oldDH);
  const reliever = sit.bench.home[0];
  // Reliever off the bench, old pitcher to DH, old DH to the bench.
  g.changeRoles('home', { ...pos, P: reliever, DH: oldP });
  const after = g.situation();
  assert.equal(after.positions.home.P, reliever);
  assert.equal(after.lineups.home[dhSlot], oldP, 'old pitcher takes the DH batting spot');
  assert.ok(after.bench.home.includes(oldDH));
  assert.ok(!after.lineups.home.includes(reliever));
  // The relieved pitcher can't go back to the mound.
  assert.throws(() => g.changeRoles('home', { ...after.positions.home, P: oldP, DH: reliever }), /relieved/);
  // Invalid role sets are rejected.
  assert.throws(() => g.changeRoles('home', { P: 0, '1B': 1, SS: 2, OF: 3 }), /Roles/);
});

test('CPU managers make substitutions over many games, and lineups stay valid', () => {
  let changes = 0;
  let pinch = 0;
  for (let seed = 1; seed <= 6; seed++) {
    const g = createGame({ away: createTeam('Away', A), home: createTeam('Home', B), seed });
    while (!g.state.over) {
      g.step();
      const sit = g.situation();
      for (const side of ['away', 'home']) {
        const pos = sit.positions[side];
        assert.equal(new Set(Object.values(pos)).size, Object.keys(pos).length);
        assert.equal(sit.lineups[side].length, 4);
        assert.equal(new Set(sit.lineups[side]).size, 4);
        assert.ok(!sit.lineups[side].includes(pos.P), 'DH game: pitcher never in the lineup');
      }
    }
    changes += g.state.log.filter((e) => e.type === 'change').length;
    pinch += g.state.log.filter((e) => /pinch-hits/.test(e.text)).length;
  }
  assert.ok(changes > 0, 'some substitutions happen');
});

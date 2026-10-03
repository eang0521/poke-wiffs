// Game engine.
//
// Each pitch is two steps, so a human can act on either side:
//   const pitch = game.preparePitch(choice?)   // CPU picks if no choice: {pitch, target}
//   const event = game.resolvePitch(decision?) // CPU decides if omitted;
//                                              // 'take' or {timing, aimFt, type} for humans
// game.step() does both for CPU vs CPU; game.playToEnd() sims a whole game.
//
// Teams field four (P, 1B, SS, OF); with the DH rule a fifth player bats for
// the pitcher, and the rest of the party of six waits on the bench.
// Substitutions are free-form: anyone who hasn't been relieved can pitch, and a
// relieved pitcher can stay in the game at another spot (and keep batting).
// game.changeRoles() applies any such change.
//
// Type matchups: each plate appearance, pitcher and batter each attack with
// their best type against the other; effectiveness scales their matchup stats.
// CPU managers use matchups for pitching changes and pinch hitters.

import { createRng } from '../math/rng.js';
import { ftToM } from '../units.js';
import { createField } from '../field/field.js';
import { throwPitch } from '../pitching/pitching.js';
import { swingAtPitch } from '../batting/swing.js';
import { batterFatigue, batterFromStats, pitcherFromStats } from '../stats/stats.js';
import { resolvePlay, DEFAULT_ALIGNMENT } from './fielding.js';
import { cpuPitchChoice, cpuSwingDecision } from './ai.js';
import { POSITIONS, battingRoles, defaultAlignment, pitchingValue, battingValue, fieldingValue } from './roster.js';
import { matchup, boostStats } from './types.js';

export const DEFAULT_RULES = Object.freeze({
  innings: 6,
  balls: 4,
  strikes: 3,
  maxInnings: 15, // then it's a tie
  reliefMargin: 12, // pitches past stamina before the CPU must make a pitching change
  dh: true, // a designated hitter bats instead of the pitcher
  pinchMargin: 0.35, // how much better (batting value vs this pitcher) a pinch hitter must be
});

const SIDES = ['away', 'home'];

function emptyLine() {
  return { pa: 0, ab: 0, r: 0, h: 0, d: 0, t: 0, hr: 0, rbi: 0, bb: 0, k: 0, po: 0, a: 0, e: 0,
    pitches: 0, outs: 0, hAllowed: 0, rAllowed: 0, bbAllowed: 0, kPitched: 0, hrAllowed: 0 };
}

export function createGame({ away, home, field = createField(), rules = {}, seed = 1 }) {
  const R = { ...DEFAULT_RULES, ...rules };
  const rng = createRng(seed);
  const teams = { away, home };
  const s = {
    inning: 1,
    half: 'top',
    outs: 0,
    balls: 0,
    strikes: 0,
    bases: [null, null, null], // player objects
    score: { away: 0, home: 0 },
    hits: { away: 0, home: 0 },
    errors: { away: 0, home: 0 },
    linescore: { away: [0], home: [] },
    lineupPos: { away: 0, home: 0 },
    positions: {},
    lineup: {},
    pitchCount: new Map(),
    exertion: new Map(),
    pitched: new Set(),
    box: new Map(),
    log: [],
    over: false,
    winner: null,
  };
  for (const side of SIDES) {
    const t = teams[side];
    // Use the team's alignment if it was built for this DH rule; otherwise redo it.
    const a = t.dh === R.dh && t.positions && t.lineup
      ? { positions: t.positions, lineup: t.lineup }
      : defaultAlignment(t.players, { dh: R.dh, pitcher: t.positions?.P });
    s.positions[side] = { ...a.positions };
    s.lineup[side] = [...a.lineup];
    for (const p of t.players) s.box.set(p.id, emptyLine());
    s.pitched.add(t.players[s.positions[side].P].id);
  }
  let pending = null;

  const batSide = () => (s.half === 'top' ? 'away' : 'home');
  const fieldSide = () => (s.half === 'top' ? 'home' : 'away');
  const box = (p) => s.box.get(p.id);
  const currentBatter = () => teams[batSide()].players[s.lineup[batSide()][s.lineupPos[batSide()]]];
  const currentPitcher = () => teams[fieldSide()].players[s.positions[fieldSide()].P];
  const fatigueScale = (p) => batterFatigue(p.batter, s.exertion.get(p.id) ?? 0).scale;
  const addExertion = (p, x) => s.exertion.set(p.id, (s.exertion.get(p.id) ?? 0) + x);
  const log = (text, extra = {}) => {
    const entry = { inning: s.inning, half: s.half, outs: s.outs, text, ...extra };
    s.log.push(entry);
    return entry;
  };

  // Matchup-adjusted profiles (cached per stat factor).
  const profileCache = new Map();
  function cached(key, make) {
    if (!profileCache.has(key)) profileCache.set(key, make());
    return profileCache.get(key);
  }
  function pitcherProfile(p, factor) {
    if (factor === 1) return p.pitcher;
    return cached(`p:${p.id}:${factor}`, () => pitcherFromStats(boostStats(p.stats, factor), { hand: p.throws, name: p.name }));
  }
  function batterProfile(p, pitcherHand, factor = 1) {
    const hand = p.bats === 'S' ? (pitcherHand === 'L' ? 'R' : 'L') : p.bats;
    const base = factor === 1 ? p.batter : cached(`b:${p.id}:${factor}`, () => batterFromStats(boostStats(p.stats, factor), { name: p.name }));
    const f = fatigueScale(p);
    return { ...base, hand, batSpeedMph: base.batSpeedMph * f, runSpeed: base.runSpeed * f };
  }

  // How good a batter is against a given pitcher, matchup included: his own
  // boosted batting value, minus how much the pitcher's type gains on him.
  function batterVsPitcher(b, p) {
    const m = matchup(p, b);
    const prof = batterProfile(b, p.throws, m.batter.factor);
    return battingValue({ batter: prof, stats: boostStats(b.stats, m.batter.factor) }) - 1.2 * (m.pitcher.factor - 1);
  }
  // How good a pitcher is against a set of batters (positive = pitcher's edge).
  function pitcherVsBatters(p, batters) {
    if (!batters.length) return 0;
    let edge = 0;
    for (const b of batters) {
      const m = matchup(p, b);
      edge += m.pitcher.factor - m.batter.factor;
    }
    return edge / batters.length;
  }

  function defense() {
    const side = fieldSide();
    const t = teams[side];
    return POSITIONS.map((role) => {
      const idx = s.positions[side][role];
      const [x, y] = DEFAULT_ALIGNMENT[role];
      return { player: t.players[idx], role, pos: { x: ftToM(x), y: ftToM(y) } };
    });
  }

  const roleOf = (side, idx) => Object.keys(s.positions[side]).find((r) => s.positions[side][r] === idx) ?? null;
  const benchOf = (side) => teams[side].players.map((_, i) => i).filter((i) => roleOf(side, i) === null);

  /**
   * Apply a new set of roles for one team ({P, 1B, SS, OF, DH?} -> player index).
   * Batting spots follow the players: anyone still batting keeps their spot, and
   * an open spot goes to whoever took over the departing player's role.
   */
  function changeRoles(side, roles, { reason = null } = {}) {
    const team = teams[side];
    const need = R.dh ? [...POSITIONS, 'DH'] : POSITIONS;
    if (Object.keys(roles).length !== need.length || !need.every((r) => roles[r] !== undefined)) {
      throw new Error(`Roles must be exactly ${need.join(', ')}`);
    }
    const idxs = need.map((r) => roles[r]);
    if (new Set(idxs).size !== idxs.length || idxs.some((i) => !team.players[i])) throw new Error('Each role needs a different player from the party');
    const oldP = s.positions[side].P;
    const newP = roles.P;
    if (newP !== oldP && s.pitched.has(team.players[newP].id)) {
      throw new Error(`${team.players[newP].name} has already been relieved and can't pitch again`);
    }

    const old = { ...s.positions[side] };
    const oldRole = (i) => Object.keys(old).find((r) => old[r] === i) ?? null;
    const batters = new Set(battingRoles(R.dh).map((r) => roles[r]));
    const lineup = s.lineup[side].map((i) => (batters.has(i) ? i : null));
    const unplaced = [...batters].filter((i) => !lineup.includes(i));
    lineup.forEach((i, slot) => {
      if (i !== null) return;
      const r = oldRole(s.lineup[side][slot]);
      const heir = r && unplaced.includes(roles[r]) ? roles[r] : unplaced[0];
      lineup[slot] = heir;
      unplaced.splice(unplaced.indexOf(heir), 1);
    });
    s.positions[side] = { ...roles };
    s.lineup[side] = lineup;
    if (newP !== oldP) s.pitched.add(team.players[newP].id);

    const moves = [];
    for (const [i, p] of team.players.entries()) {
      const a = oldRole(i);
      const b = Object.keys(roles).find((r) => roles[r] === i) ?? null;
      if (a === b) continue;
      if (b === 'P') moves.unshift(`${p.name} comes in to pitch`);
      else if (!a) moves.push(`${p.name} enters at ${b}`);
      else if (!b) moves.push(`${p.name} goes to the bench`);
      else moves.push(`${p.name} moves to ${b}`);
    }
    if (moves.length) log(`${team.name}: ${reason ? `${reason} ` : ''}${moves.join('; ')}.`, { type: 'change' });
  }

  function upcomingBatters(side, n) {
    const order = s.lineup[side];
    const out = [];
    for (let k = 0; k < Math.min(n, order.length); k++) out.push(teams[side].players[order[(s.lineupPos[side] + k) % order.length]]);
    return out;
  }

  // CPU manager, defense: change pitchers when the starter is spent, or earlier
  // when a fresh arm has a much better type matchup against the next hitters.
  // Relieved pitchers can't return, so matchup changes need a clear edge.
  function maybeRelievePitcher() {
    const side = fieldSide();
    const team = teams[side];
    const pos = s.positions[side];
    const p0 = pos.P;
    const cur = team.players[p0];
    const count = s.pitchCount.get(cur.id) ?? 0;
    const stamina = cur.pitcher.staminaPitches;
    const tired = count > stamina + R.reliefMargin;
    const eligible = team.players.map((_, i) => i).filter((i) => i !== p0 && !s.pitched.has(team.players[i].id));
    if (!eligible.length) return;
    const next = upcomingBatters(batSide(), 3);
    const score = (i) => pitchingValue(team.players[i]) + 2 * pitcherVsBatters(team.players[i], next);
    const reliever = [...eligible].sort((a, b) => score(b) - score(a))[0];
    const curScore = score(p0) - (count > stamina ? 0.02 * (count - stamina) : 0);
    const matchupChange = count > 0.5 * stamina && score(reliever) > curScore + 0.6;
    if (!tired && !matchupChange) return;

    const roles = { ...pos, P: reliever };
    const from = roleOf(side, reliever);
    if (from) {
      roles[from] = p0;
    } else {
      // Off the bench: the old pitcher stays in only if he beats someone active.
      const value = (i, r) => (r === 'DH' ? 0 : fieldingValue(team.players[i]) * 0.5) + (battingRoles(R.dh).includes(r) ? battingValue(team.players[i]) : 0);
      let swap = null;
      for (const r of Object.keys(roles)) {
        if (r === 'P') continue;
        const gain = value(p0, r) - value(roles[r], r);
        if (gain > 0 && (!swap || gain > swap.gain)) swap = { r, gain };
      }
      if (swap) roles[swap.r] = p0;
    }
    const why = tired ? 'pitching change' : `matchup change (${team.players[reliever].types.join('/')} vs the ${next.map((b) => b.types[0]).join('/')} hitters)`;
    changeRoles(side, roles, { reason: `${why}:` });
  }

  // CPU manager, offense: send up a pinch hitter from the bench when he matches
  // up clearly better against this pitcher. Never pinch-hits for the pitcher.
  function maybePinchHit() {
    const side = batSide();
    const team = teams[side];
    const pos = s.positions[side];
    const pitcher = currentPitcher();
    const dueIdx = s.lineup[side][s.lineupPos[side]];
    const role = roleOf(side, dueIdx);
    if (!role || role === 'P') return;
    const due = team.players[dueIdx];
    const fieldCost = (i) => (role === 'DH' ? 0 : Math.max(0, fieldingValue(due) - fieldingValue(team.players[i])) * 0.3);
    let best = null;
    for (const i of benchOf(side)) {
      const gain = batterVsPitcher(team.players[i], pitcher) - batterVsPitcher(due, pitcher) - fieldCost(i);
      if (gain > R.pinchMargin && (!best || gain > best.gain)) best = { i, gain };
    }
    if (!best) return;
    const ph = team.players[best.i];
    changeRoles(side, { ...pos, [role]: best.i }, { reason: `${ph.name} pinch-hits for ${due.name} —` });
  }

  function situation() {
    return {
      inning: s.inning, half: s.half, outs: s.outs, balls: s.balls, strikes: s.strikes,
      bases: [...s.bases], score: { ...s.score }, batter: currentBatter(), pitcher: currentPitcher(),
      battingSide: batSide(), fieldingSide: fieldSide(), over: s.over, winner: s.winner,
      positions: { away: { ...s.positions.away }, home: { ...s.positions.home } },
      lineups: { away: [...s.lineup.away], home: [...s.lineup.home] },
      bench: { away: benchOf('away'), home: benchOf('home') },
      matchup: matchup(currentPitcher(), currentBatter()),
      pitchCount: s.pitchCount.get(currentPitcher().id) ?? 0,
      batterFatigue: batterFatigue(currentBatter().batter, s.exertion.get(currentBatter().id) ?? 0),
    };
  }

  function preparePitch(choice) {
    if (s.over) throw new Error('Game over');
    if (pending) return pending.pitch;
    if (s.balls === 0 && s.strikes === 0) {
      maybeRelievePitcher();
      maybePinchHit();
    }
    const pitcher = currentPitcher();
    const batter = currentBatter();
    const m = matchup(pitcher, batter);
    const bProfile = batterProfile(batter, pitcher.throws, m.batter.factor);
    const c = choice ?? cpuPitchChoice({ pitcher, count: { balls: s.balls, strikes: s.strikes }, field, rng, batterHand: bProfile.hand });
    const count = s.pitchCount.get(pitcher.id) ?? 0;
    const pitch = throwPitch({
      pitch: c.pitch, target: c.target, field, pitcher: pitcherProfile(pitcher, m.pitcher.factor), pitchCount: count,
      seed: Math.floor(rng.next() * 2 ** 31),
    });
    s.pitchCount.set(pitcher.id, count + 1);
    box(pitcher).pitches++;
    pending = { pitch, choice: c, pitcher, batter, bProfile, matchup: m };
    return pitch;
  }

  function endHalf() {
    if (s.half === 'top') {
      // Home already ahead after the top of the last inning: no bottom half needed.
      if (s.inning >= R.innings && s.score.home > s.score.away) return endGame();
      s.half = 'bottom';
      s.linescore.home.push(0);
    } else {
      if (s.inning >= R.innings && s.score.home !== s.score.away) return endGame();
      if (s.inning >= R.maxInnings) return endGame();
      s.inning++;
      s.half = 'top';
      s.linescore.away.push(0);
    }
    s.outs = 0;
    s.bases = [null, null, null];
    log(`— ${s.half === 'top' ? 'Top' : 'Bottom'} of inning ${s.inning} —`, { type: 'half' });
  }

  function endGame() {
    s.over = true;
    s.winner = s.score.home > s.score.away ? 'home' : s.score.away > s.score.home ? 'away' : null;
    log(`Final: ${teams.away.name} ${s.score.away}, ${teams.home.name} ${s.score.home}`, { type: 'final' });
  }

  function scoreRuns(players, pitcher, rbiTo) {
    const side = batSide();
    for (const p of players) {
      s.score[side]++;
      s.linescore[side][s.linescore[side].length - 1]++;
      box(p).r++;
      box(pitcher).rAllowed++;
    }
    if (rbiTo) box(rbiTo).rbi += players.length;
  }

  function nextBatter() {
    s.balls = 0;
    s.strikes = 0;
    const side = batSide();
    s.lineupPos[side] = (s.lineupPos[side] + 1) % s.lineup[side].length;
  }

  function checkWalkOff() {
    if (s.half === 'bottom' && s.inning >= R.innings && s.score.home > s.score.away) {
      endGame();
      return true;
    }
    return false;
  }

  function recordOut(n) {
    s.outs += n;
    box(currentPitcher()).outs += n;
  }

  function resolvePitch(decision) {
    if (!pending) preparePitch();
    const { pitch, pitcher, batter, bProfile, matchup: m } = pending;
    pending = null;
    const count = { balls: s.balls, strikes: s.strikes };
    let d = decision;
    if (d === undefined) d = cpuSwingDecision({ pitch, batter: bProfile, count, field, rng });
    else if (d === 'take') d = { swing: false };
    else d = { swing: true, ...d };

    const ev = { pitch, pitcher, batter, count, matchup: m, swing: null, play: null, kind: null, text: '' };
    const pitchName = pitch.pitch.toLowerCase();

    if (!d.swing) {
      const strike = pitch.result === 'strike';
      ev.kind = strike ? 'called_strike' : 'ball';
      if (strike) s.strikes++;
      else s.balls++;
    } else {
      addExertion(batter, 1);
      const sw = swingAtPitch({ pitch, field, timing: d.timing, aimFt: d.aimFt, type: d.type ?? 'normal', batter: bProfile, seed: Math.floor(rng.next() * 2 ** 31) });
      ev.swing = sw;
      if (!sw.contact) {
        if (sw.miss?.glancing) {
          ev.kind = 'foul';
          if (s.strikes < R.strikes - 1) s.strikes++;
        } else {
          ev.kind = 'swinging_strike';
          s.strikes++;
        }
      } else {
        const fieldTeam = fieldSide();
        const play = resolvePlay({
          batted: sw.batted, field, defense: defense(), outs: s.outs, rng,
          batter: { player: batter, speed: bProfile.runSpeed },
          bases: s.bases.map((p) => (p ? { player: p, speed: p.batter.runSpeed * fatigueScale(p) } : null)),
        });
        ev.play = play;
        if (play.foul) {
          ev.kind = 'foul';
          if (s.strikes < R.strikes - 1) s.strikes++;
        } else {
          ev.kind = 'in_play';
          const bl = box(batter);
          bl.pa++;
          if (play.batterResult !== 'SF') bl.ab++;
          if (play.hit) {
            bl.h++;
            s.hits[batSide()]++;
            box(pitcher).hAllowed++;
            if (play.batterResult === '2B') bl.d++;
            if (play.batterResult === '3B') bl.t++;
            if (play.batterResult === 'HR' || play.batterResult === 'IPHR') { bl.hr++; box(pitcher).hrAllowed++; }
          }
          for (const p of play.credit.putouts) box(p).po++;
          for (const p of play.credit.assists) box(p).a++;
          for (const p of play.credit.errors) { box(p).e++; s.errors[fieldTeam]++; }
          for (const a of play.advances) addExertion(a.player, 0.5 * Math.max(0, a.to - a.from));
          recordOut(play.outsRecorded);
          scoreRuns(play.runs, pitcher, play.error || play.batterResult === 'GDP' ? null : batter);
          s.bases = play.bases.map((b) => (b ? b.player : null));
          const runsTxt = play.runs.length ? ` ${play.runs.map((p) => p.name).join(', ')} score${play.runs.length > 1 ? '' : 's'}.` : '';
          ev.text = `${batter.name} ${play.description} on a ${pitchName}.${runsTxt}`;
          nextBatter();
        }
      }
    }

    // Count-ending outcomes.
    if (ev.kind !== 'in_play') {
      if (s.balls >= R.balls) {
        ev.kind = 'walk';
        const bl = box(batter);
        bl.pa++;
        bl.bb++;
        box(pitcher).bbAllowed++;
        // Force runners along.
        const runs = [];
        const nb = [...s.bases];
        if (nb[0]) {
          if (nb[1]) {
            if (nb[2]) runs.push(nb[2]);
            nb[2] = nb[1];
          }
          nb[1] = nb[0];
        }
        nb[0] = batter;
        s.bases = nb;
        scoreRuns(runs, pitcher, batter);
        ev.text = `${batter.name} walks.${runs.length ? ` ${runs[0].name} scores.` : ''}`;
        nextBatter();
      } else if (s.strikes >= R.strikes) {
        ev.kind = 'strikeout';
        const bl = box(batter);
        bl.pa++;
        bl.ab++;
        bl.k++;
        box(pitcher).kPitched++;
        recordOut(1);
        ev.text = `${batter.name} strikes out ${ev.swing ? 'swinging' : 'looking'} on a ${pitchName}.`;
        nextBatter();
      } else {
        const label = { ball: 'Ball', called_strike: 'Called strike', swinging_strike: 'Swinging strike', foul: 'Foul' }[ev.kind];
        ev.text = `${label} (${pitchName}, ${pitch.releaseSpeedMph.toFixed(0)} mph). ${s.balls}-${s.strikes}`;
      }
    }

    ev.entry = log(ev.text, { type: ev.kind, batter: batter.name, pitcher: pitcher.name });
    if (!checkWalkOff() && s.outs >= 3) endHalf();
    ev.after = situation();
    return ev;
  }

  function step() {
    preparePitch();
    return resolvePitch();
  }

  function playToEnd(maxPitches = 2000) {
    let n = 0;
    while (!s.over && n++ < maxPitches) step();
    return summary();
  }

  function summary() {
    const lines = {};
    for (const side of SIDES) {
      lines[side] = teams[side].players.map((p) => ({ player: p, ...box(p) }));
    }
    return {
      teams,
      score: { ...s.score },
      hits: { ...s.hits },
      errors: { ...s.errors },
      linescore: { away: [...s.linescore.away], home: [...s.linescore.home] },
      innings: s.inning,
      winner: s.winner,
      over: s.over,
      box: lines,
      log: s.log,
    };
  }

  log(`${teams.away.name} at ${teams.home.name}. Play ball!`, { type: 'start' });
  log('— Top of inning 1 —', { type: 'half' });

  return {
    field, rules: R, teams,
    get state() { return s; },
    get pending() { return pending; },
    situation, preparePitch, resolvePitch, step, playToEnd, summary, defense,
    changeRoles: (side, roles) => {
      if (pending) throw new Error('Finish the current pitch first');
      changeRoles(side, roles);
    },
  };
}

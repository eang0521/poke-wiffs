// Game engine.
//
// Each pitch is two steps, so a human can act on either side:
//   const pitch = game.preparePitch(choice?)   // CPU picks if no choice: {pitch, target}
//   const event = game.resolvePitch(decision?) // CPU decides if omitted;
//                                              // 'take' or {timing, aimFt, type} for humans
// game.step() does both for CPU vs CPU; game.playToEnd() sims a whole game.

import { createRng } from '../math/rng.js';
import { ftToM } from '../units.js';
import { createField } from '../field/field.js';
import { throwPitch } from '../pitching/pitching.js';
import { swingAtPitch } from '../batting/swing.js';
import { batterFatigue } from '../stats/stats.js';
import { resolvePlay, DEFAULT_ALIGNMENT } from './fielding.js';
import { cpuPitchChoice, cpuSwingDecision } from './ai.js';

export const DEFAULT_RULES = Object.freeze({
  innings: 6,
  balls: 4,
  strikes: 3,
  maxInnings: 15, // then it's a tie
  reliefMargin: 12, // pitches past stamina before the CPU makes a pitching change
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
    positions: { away: { ...away.positions }, home: { ...home.positions } },
    pitchCount: new Map(),
    exertion: new Map(),
    pitched: new Set(),
    box: new Map(),
    log: [],
    over: false,
    winner: null,
  };
  for (const side of SIDES) {
    for (const p of teams[side].players) s.box.set(p.id, emptyLine());
    s.pitched.add(teams[side].players[s.positions[side].P].id);
  }
  let pending = null;

  const batSide = () => (s.half === 'top' ? 'away' : 'home');
  const fieldSide = () => (s.half === 'top' ? 'home' : 'away');
  const box = (p) => s.box.get(p.id);
  const currentBatter = () => {
    const t = teams[batSide()];
    return t.players[t.lineup[s.lineupPos[batSide()]]];
  };
  const currentPitcher = () => teams[fieldSide()].players[s.positions[fieldSide()].P];
  const fatigueScale = (p) => batterFatigue(p.batter, s.exertion.get(p.id) ?? 0).scale;
  const addExertion = (p, x) => s.exertion.set(p.id, (s.exertion.get(p.id) ?? 0) + x);
  const log = (text, extra = {}) => {
    const entry = { inning: s.inning, half: s.half, outs: s.outs, text, ...extra };
    s.log.push(entry);
    return entry;
  };

  function batterProfile(p, pitcherHand) {
    const hand = p.bats === 'S' ? (pitcherHand === 'L' ? 'R' : 'L') : p.bats;
    const f = fatigueScale(p);
    return { ...p.batter, hand, batSpeedMph: p.batter.batSpeedMph * f, runSpeed: p.batter.runSpeed * f };
  }

  function defense() {
    const side = fieldSide();
    const t = teams[side];
    return Object.entries(s.positions[side]).map(([role, idx]) => {
      const [x, y] = DEFAULT_ALIGNMENT[role];
      return { player: t.players[idx], role, pos: { x: ftToM(x), y: ftToM(y) } };
    });
  }

  function maybeRelievePitcher() {
    const side = fieldSide();
    const pos = s.positions[side];
    const p = currentPitcher();
    const count = s.pitchCount.get(p.id) ?? 0;
    if (count <= p.pitcher.staminaPitches + R.reliefMargin) return;
    const team = teams[side];
    let best = null;
    for (const [role, idx] of Object.entries(pos)) {
      const q = team.players[idx];
      if (role === 'P' || s.pitched.has(q.id)) continue;
      if (!best || q.pitcher.staminaPitches > best.q.pitcher.staminaPitches) best = { q, role, idx };
    }
    if (!best) return;
    const old = pos.P;
    pos.P = best.idx;
    pos[best.role] = old;
    s.pitched.add(best.q.id);
    log(`Pitching change: ${best.q.name} comes in to pitch; ${p.name} moves to ${best.role}.`, { type: 'change' });
  }

  function situation() {
    return {
      inning: s.inning, half: s.half, outs: s.outs, balls: s.balls, strikes: s.strikes,
      bases: [...s.bases], score: { ...s.score }, batter: currentBatter(), pitcher: currentPitcher(),
      battingSide: batSide(), fieldingSide: fieldSide(), over: s.over, winner: s.winner,
      pitchCount: s.pitchCount.get(currentPitcher().id) ?? 0,
      batterFatigue: batterFatigue(currentBatter().batter, s.exertion.get(currentBatter().id) ?? 0),
    };
  }

  function preparePitch(choice) {
    if (s.over) throw new Error('Game over');
    if (pending) return pending.pitch;
    if (s.balls === 0 && s.strikes === 0) maybeRelievePitcher();
    const pitcher = currentPitcher();
    const batter = currentBatter();
    const bProfile = batterProfile(batter, pitcher.throws);
    const c = choice ?? cpuPitchChoice({ pitcher, count: { balls: s.balls, strikes: s.strikes }, field, rng, batterHand: bProfile.hand });
    const count = s.pitchCount.get(pitcher.id) ?? 0;
    const pitch = throwPitch({
      pitch: c.pitch, target: c.target, field, pitcher: pitcher.pitcher, pitchCount: count,
      seed: Math.floor(rng.next() * 2 ** 31),
    });
    s.pitchCount.set(pitcher.id, count + 1);
    box(pitcher).pitches++;
    pending = { pitch, choice: c, pitcher, batter, bProfile };
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
    s.lineupPos[side] = (s.lineupPos[side] + 1) % 6;
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
    const { pitch, pitcher, batter, bProfile } = pending;
    pending = null;
    const count = { balls: s.balls, strikes: s.strikes };
    let d = decision;
    if (d === undefined) d = cpuSwingDecision({ pitch, batter: bProfile, count, field, rng });
    else if (d === 'take') d = { swing: false };
    else d = { swing: true, ...d };

    const ev = { pitch, pitcher, batter, count, swing: null, play: null, kind: null, text: '' };
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
  };
}

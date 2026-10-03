// Players and teams.
//
// A player is one Pokémon with batting, pitching and fielding profiles derived
// from its base stats, a 4-pitch "moveset" (arsenal), and handedness.
// A team is a party of six: one pitcher and five fielders, batting 1-6.

import { getPokemon, spriteUrl } from '../data/pokedex.js';
import { batterFromStats, pitcherFromStats, fielderFromStats, statRating } from '../stats/stats.js';
import { PITCH_TYPES } from '../pitching/pitches.js';

// Which pitches each type gravitates toward (moveset flavor).
const TYPE_PITCHES = {
  normal: ['changeup', 'curveball'],
  fire: ['fastball', 'riser'],
  water: ['sinker', 'changeup'],
  grass: ['changeup', 'screwball'],
  electric: ['slider', 'riser'],
  ice: ['slideDrop', 'drop'],
  fighting: ['fastball', 'sinker'],
  poison: ['slideDrop', 'screwball'],
  ground: ['sinker', 'drop'],
  flying: ['riser', 'slider'],
  psychic: ['knuckleball', 'screwball'],
  bug: ['knuckleball', 'slider'],
  rock: ['sinker', 'drop'],
  ghost: ['knuckleball', 'slideDrop'],
  dragon: ['curveball', 'riser'],
  dark: ['slider', 'slideDrop'],
  steel: ['fastball', 'sinker'],
  fairy: ['screwball', 'curveball'],
};

// Stat affinity per pitch: which stats make a pitch a good fit.
const STAT_PITCHES = {
  riser: (r) => r.attack * 0.5 + r.spAttack * 0.5,
  changeup: (r) => r.spDefense,
  drop: (r) => r.spAttack * 0.7 + r.attack * 0.3,
  curveball: (r) => r.spAttack,
  slider: (r) => r.attack * 0.5 + r.spAttack * 0.5,
  slideDrop: (r) => r.spAttack * 0.8 + r.spDefense * 0.2,
  sinker: (r) => r.attack * 0.6 + r.defense * 0.4,
  screwball: (r) => r.spAttack * 0.6 + r.speed * 0.4,
  knuckleball: (r) => r.spDefense * 0.5 + (1 - r.attack) * 0.5,
};

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Fastball plus the three best-fitting pitches by type and stats. */
export function defaultArsenal(mon) {
  const r = Object.fromEntries(Object.entries(mon.stats).map(([k, v]) => [k, statRating(v)]));
  const scores = PITCH_TYPES.filter((p) => p !== 'fastball').map((p) => {
    let s = STAT_PITCHES[p](r);
    for (const t of mon.types ?? []) {
      const pref = TYPE_PITCHES[t] ?? [];
      if (pref[0] === p) s += 0.6;
      else if (pref[1] === p) s += 0.35;
    }
    s += (hash(mon.slug + p) % 1000) / 1e5; // stable tie-break
    return [p, s];
  });
  scores.sort((a, b) => b[1] - a[1]);
  return ['fastball', ...scores.slice(0, 3).map(([p]) => p)];
}

/**
 * @param {string|object} mon  slug from the Pokédex, or {name, slug, types, stats}
 * @param {object} [opts]      {throws, bats, arsenal, nickname}
 */
export function createPlayer(mon, opts = {}) {
  const m = typeof mon === 'string' ? getPokemon(mon) : mon;
  if (!m) throw new Error(`Unknown Pokémon: ${mon}`);
  const h = hash(m.slug);
  const throws = opts.throws ?? (h % 10 < 3 ? 'L' : 'R');
  const bats = opts.bats ?? ((h >> 4) % 10 < 3 ? 'L' : (h >> 4) % 10 === 9 ? 'S' : throws === 'L' && (h >> 8) % 2 ? 'L' : 'R');
  const name = opts.nickname ?? m.name;
  return {
    id: `${m.slug}-${opts.uid ?? 0}`,
    name,
    slug: m.slug,
    num: m.num,
    types: m.types ?? [],
    stats: { ...m.stats },
    throws,
    bats, // 'S' = switch hitter (bats opposite the pitcher)
    arsenal: opts.arsenal ?? defaultArsenal(m),
    batter: batterFromStats(m.stats, { hand: bats === 'L' ? 'L' : 'R', name }),
    pitcher: pitcherFromStats(m.stats, { hand: throws, name }),
    fielder: fielderFromStats(m.stats),
    sprite: spriteUrl(m.slug),
  };
}

export const POSITIONS = ['P', '1B', 'SS', 'OF'];
export const POSITION_NAMES = { P: 'Pitcher', '1B': 'First base', SS: 'Shortstop', OF: 'Outfield', DH: 'Designated hitter' };

/** Roles that bat: with a DH, the DH hits instead of the pitcher. */
export const battingRoles = (dh) => (dh ? ['1B', 'SS', 'OF', 'DH'] : ['P', '1B', 'SS', 'OF']);

// Rough values used to fill positions and the batting order.
export const pitchingValue = (p) => p.pitcher.staminaPitches / 90 + statRating(p.stats.spAttack) * 0.5 + statRating(p.stats.attack) * 0.5 + statRating(p.stats.spDefense) * 0.4;
export const battingValue = (p) => (p.batter.batSpeedMph - 38) / 25 + p.batter.contact * 0.6 + p.batter.eye * 0.4 + statRating(p.stats.speed) * 0.2;
export const fieldingValue = (p) => p.fielder.rating + statRating(p.stats.speed) * 0.5;

/** Batting order: table-setter first, the two best power bats 2-3, then the rest. */
export function orderLineup(players, batters) {
  const power = (i) => players[i].batter.batSpeedMph;
  const onBase = (i) => players[i].batter.contact + players[i].batter.eye + statRating(players[i].stats.speed) * 0.5;
  const byPower = [...batters].sort((a, b) => power(b) - power(a));
  const leadoff = batters.filter((i) => i !== byPower[0] && i !== byPower[1]).sort((a, b) => onBase(b) - onBase(a))[0];
  const rest = batters.filter((i) => i !== leadoff && i !== byPower[0] && i !== byPower[1]);
  return [leadoff, byPower[1], byPower[0], ...rest].filter((i) => i !== undefined);
}

/**
 * Default alignment for a party of six with 4 on the field (P, 1B, SS, OF),
 * plus a DH if the rule is on. Everyone else starts on the bench.
 *   P:  best pitcher (or opts.pitcher)   OF: fastest
 *   SS: best glove                       1B: best remaining bat
 *   DH: best remaining bat
 */
export function defaultAlignment(players, { dh = true, pitcher } = {}) {
  const left = new Set(players.map((_, i) => i));
  const take = (score) => {
    const best = [...left].sort((a, b) => score(players[b]) - score(players[a]))[0];
    left.delete(best);
    return best;
  };
  const positions = {};
  positions.P = pitcher ?? take(pitchingValue);
  left.delete(positions.P);
  positions.OF = take((p) => p.fielder.runSpeed);
  positions.SS = take((p) => p.fielder.rating);
  positions['1B'] = take(battingValue);
  if (dh) positions.DH = take(battingValue);
  const lineup = orderLineup(players, battingRoles(dh).map((r) => positions[r]));
  return { positions, lineup, bench: [...left] };
}

/**
 * Build a team: a party of six Pokémon.
 * @param {string} name
 * @param {(string|object)[]} roster  6 Pokémon (slugs or player objects)
 * @param {object} [opts] {dh = true, pitcher: index, positions: {P, 1B, SS, OF, DH?}, lineup: [i...]}
 */
export function createTeam(name, roster, opts = {}) {
  if (roster.length !== 6) throw new Error('A team needs exactly 6 Pokémon');
  const players = roster.map((r, i) => (typeof r === 'string' ? createPlayer(r, { uid: i }) : r));
  const dh = opts.dh ?? true;
  const auto = defaultAlignment(players, { dh, pitcher: opts.pitcher });
  const positions = opts.positions ?? auto.positions;
  const lineup = opts.lineup ?? (opts.positions ? orderLineup(players, battingRoles(dh).map((r) => positions[r])) : auto.lineup);
  return { name, players, positions, lineup, dh };
}

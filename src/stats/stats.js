// Pokémon stats → wiffle ball stats.
//
// Each of the six Pokémon stats feeds exactly one batting attribute and one
// pitching attribute, so the conversion is direct and easy to reason about.
// The whole mapping is the data table below: change a row to rebalance.
//
// Stats are read as base stats (typical range ~20-160). A stat of `lo` maps to
// the `worst` end of the range and `hi` maps to `best`. Values outside lo..hi
// extend a little past the range (soft cap) so legendaries still stand out
// without breaking the physics.

export const STAT_KEYS = ['hp', 'attack', 'defense', 'spAttack', 'spDefense', 'speed'];
export const STAT_LABELS = { hp: 'HP', attack: 'Attack', defense: 'Defense', spAttack: 'Sp. Atk', spDefense: 'Sp. Def', speed: 'Speed' };

const LO = 30;
const HI = 150;

export const BATTER_CONVERSION = Object.freeze({
  attack: { key: 'batSpeedMph', label: 'Bat speed (power)', worst: 38, best: 63, unit: 'mph' },
  spAttack: { key: 'contact', label: 'Contact (bat control)', worst: 0, best: 1, unit: 'rating' },
  speed: { key: 'swingTime', label: 'Quickness (swing + feet)', worst: 0.19, best: 0.12, unit: 's to square' },
  spDefense: { key: 'eye', label: 'Eye (pitch recognition)', worst: 0, best: 1, unit: 'rating' },
  defense: { key: 'fielding', label: 'Fielding', worst: 0, best: 1, unit: 'rating' },
  hp: { key: 'stamina', label: 'Stamina', worst: 0, best: 1, unit: 'rating' },
});

export const PITCHER_CONVERSION = Object.freeze({
  attack: { key: 'velocityScale', label: 'Velocity', worst: 0.85, best: 1.12, unit: '× pitch speed' },
  spAttack: { key: 'spinScale', label: 'Movement (spin + scuff)', worst: 0.7, best: 1.25, unit: '× spin rate' },
  spDefense: { key: 'commandScale', label: 'Command', worst: 1.8, best: 0.6, unit: '× location error' },
  speed: { key: 'extensionFt', label: 'Extension (arm speed / stride)', worst: 2.0, best: 4.5, unit: 'ft' },
  hp: { key: 'staminaPitches', label: 'Stamina', worst: 25, best: 90, unit: 'pitches before fatigue' },
  defense: { key: 'fielding', label: 'Fielding', worst: 0, best: 1, unit: 'rating' },
});

/** 0 at LO, 1 at HI; soft-capped to about −0.15 … 1.2. */
export function statRating(value) {
  const t = (value - LO) / (HI - LO);
  if (t > 1) return 1 + 0.2 * Math.tanh((t - 1) / 0.2);
  if (t < 0) return -0.15 * Math.tanh(-t / 0.15);
  return t;
}

const lerp = (a, b, t) => a + (b - a) * t;

function convert(stats, table) {
  const out = {};
  for (const [stat, row] of Object.entries(table)) {
    const v = stats[stat];
    if (typeof v !== 'number') throw new Error(`Missing Pokémon stat: ${stat}`);
    out[row.key] = lerp(row.worst, row.best, statRating(v));
  }
  return out;
}

/**
 * Batter profile. Plug it straight into swingAtPitch({ batter }).
 * contact (0-1) shrinks the player's aim and timing errors:
 *   aim error × (1 − 0.6·contact), timing error × (1 − 0.4·contact)
 */
export function batterFromStats(stats, { hand = 'R', name } = {}) {
  const r = convert(stats, BATTER_CONVERSION);
  const c = Math.max(0, Math.min(1, r.contact));
  return {
    name,
    hand,
    stats: { ...stats },
    ...r,
    // Speed also sets foot speed (baserunning and fielding range), m/s: ~19 → 31 ft/s.
    runSpeed: lerp(5.8, 9.5, statRating(stats.speed)),
    assist: { aimErrorScale: 1 - 0.6 * c, timingErrorScale: 1 - 0.4 * c },
  };
}

/** Pitcher profile. Plug it straight into throwPitch({ pitcher }). */
export function pitcherFromStats(stats, { hand = 'R', name } = {}) {
  const r = convert(stats, PITCHER_CONVERSION);
  return {
    name,
    hand,
    stats: { ...stats },
    ...r,
    // Sp. Atk also drives the hole-force pitches:
    //  - scuffing: real wiffle pitchers scuff one side of the ball, strengthening
    //    the slot asymmetry, so better "finesse" means more slot force
    //  - spin-axis wobble: less skilled spinners misalign the axis from the slots,
    //    so the slots precess and the slot force weakens
    holeForceScale: lerp(0.8, 1.25, statRating(stats.spAttack)),
    axisErrorDeg: lerp(8, 1.5, Math.max(0, Math.min(1, statRating(stats.spAttack)))),
  };
}

/**
 * Fielding from Defense: reaction time, sure hands, and arm strength.
 * (Foot speed comes from Speed, same as batterFromStats().runSpeed.)
 */
export function fielderFromStats(stats) {
  const f = statRating(stats.defense);
  const c = Math.max(0, Math.min(1.2, f));
  return {
    rating: f,
    reaction: lerp(0.45, 0.2, c), // s before the first step
    errorRate: Math.max(0.004, lerp(0.045, 0.008, c)), // per fielding chance / throw
    throwSpeed: lerp(17, 26, c), // m/s release speed (a wiffle throw slows quickly)
    runSpeed: lerp(5.8, 9.5, statRating(stats.speed)),
  };
}

/**
 * Batter fatigue. Every swing costs 1 exertion and every base run 0.5. Past a
 * stamina-based limit (10 → 30 exertion), bat speed and foot speed fade 1% per
 * point, down to 85%.
 */
export function batterFatigue(batter, exertion = 0) {
  const limit = lerp(10, 30, Math.max(0, Math.min(1.2, batter?.stamina ?? 1)));
  const over = Math.max(0, exertion - limit);
  return { scale: Math.max(0.85, 1 - 0.01 * over), tired: over > 0, limit };
}

/**
 * Fatigue after `pitchCount` pitches. Past the stamina limit, each pitch costs
 * 0.4% velocity and 3% more location error (velocity loss capped at 15%).
 */
export function pitcherFatigue(pitcher, pitchCount = 0) {
  const over = Math.max(0, pitchCount - (pitcher?.staminaPitches ?? Infinity));
  return {
    velocityScale: Math.max(0.85, 1 - 0.004 * over),
    commandScale: 1 + 0.03 * over,
    tired: over > 0,
  };
}

// A few real base-stat lines for testing ([HP, Atk, Def, SpA, SpD, Spe]).
const line = (hp, attack, defense, spAttack, spDefense, speed) => ({ hp, attack, defense, spAttack, spDefense, speed });
export const SAMPLE_POKEMON = Object.freeze({
  pikachu: { name: 'Pikachu', stats: line(35, 55, 40, 50, 50, 90) },
  charizard: { name: 'Charizard', stats: line(78, 84, 78, 109, 85, 100) },
  blastoise: { name: 'Blastoise', stats: line(79, 83, 100, 85, 105, 78) },
  machamp: { name: 'Machamp', stats: line(90, 130, 80, 65, 85, 55) },
  alakazam: { name: 'Alakazam', stats: line(55, 50, 45, 135, 95, 120) },
  gengar: { name: 'Gengar', stats: line(60, 65, 60, 130, 75, 110) },
  snorlax: { name: 'Snorlax', stats: line(160, 110, 65, 65, 110, 30) },
  gyarados: { name: 'Gyarados', stats: line(95, 125, 79, 60, 100, 81) },
  jigglypuff: { name: 'Jigglypuff', stats: line(115, 45, 20, 45, 25, 20) },
  mewtwo: { name: 'Mewtwo', stats: line(106, 110, 90, 154, 90, 130) },
});

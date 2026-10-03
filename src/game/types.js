// Type matchups.
//
// In every plate appearance the pitcher attacks with whichever of its types is
// most effective against the batter, and the batter does the same against the
// pitcher (standard type chart, dual types multiply). Effectiveness scales the
// Pokémon's matchup stats (Attack, Sp. Atk, Sp. Def, Speed) for that plate
// appearance. HP (stamina) and Defense (fielding) are unaffected.

// Attacking type → defending types that take non-neutral damage.
const CHART = {
  normal: { rock: 0.5, ghost: 0, steel: 0.5 },
  fire: { fire: 0.5, water: 0.5, grass: 2, ice: 2, bug: 2, rock: 0.5, dragon: 0.5, steel: 2 },
  water: { fire: 2, water: 0.5, grass: 0.5, ground: 2, rock: 2, dragon: 0.5 },
  electric: { water: 2, electric: 0.5, grass: 0.5, ground: 0, flying: 2, dragon: 0.5 },
  grass: { fire: 0.5, water: 2, grass: 0.5, poison: 0.5, ground: 2, flying: 0.5, bug: 0.5, rock: 2, dragon: 0.5, steel: 0.5 },
  ice: { fire: 0.5, water: 0.5, grass: 2, ice: 0.5, ground: 2, flying: 2, dragon: 2, steel: 0.5 },
  fighting: { normal: 2, ice: 2, poison: 0.5, flying: 0.5, psychic: 0.5, bug: 0.5, rock: 2, ghost: 0, dark: 2, steel: 2, fairy: 0.5 },
  poison: { grass: 2, poison: 0.5, ground: 0.5, rock: 0.5, ghost: 0.5, steel: 0, fairy: 2 },
  ground: { fire: 2, electric: 2, grass: 0.5, poison: 2, flying: 0, bug: 0.5, rock: 2, steel: 2 },
  flying: { electric: 0.5, grass: 2, fighting: 2, bug: 2, rock: 0.5, steel: 0.5 },
  psychic: { fighting: 2, poison: 2, psychic: 0.5, dark: 0, steel: 0.5 },
  bug: { fire: 0.5, grass: 2, fighting: 0.5, poison: 0.5, flying: 0.5, psychic: 2, ghost: 0.5, dark: 2, steel: 0.5, fairy: 0.5 },
  rock: { fire: 2, ice: 2, fighting: 0.5, ground: 0.5, flying: 2, bug: 2, steel: 0.5 },
  ghost: { normal: 0, psychic: 2, ghost: 2, dark: 0.5 },
  dragon: { dragon: 2, steel: 0.5, fairy: 0 },
  dark: { fighting: 0.5, psychic: 2, ghost: 2, dark: 0.5, fairy: 0.5 },
  steel: { fire: 0.5, water: 0.5, electric: 0.5, ice: 2, rock: 2, steel: 0.5, fairy: 2 },
  fairy: { fire: 0.5, fighting: 2, poison: 0.5, dragon: 2, dark: 2, steel: 0.5 },
};
export const TYPES = Object.keys(CHART);

/** Damage multiplier of one attacking type against a (possibly dual) defender. */
export function effectiveness(attackType, defenderTypes) {
  return defenderTypes.reduce((m, d) => m * (CHART[attackType]?.[d] ?? 1), 1);
}

/** The attacker's best type against the defender: {type, multiplier}. */
export function bestAttack(attackerTypes, defenderTypes) {
  let best = { type: attackerTypes[0], multiplier: -1 };
  for (const t of attackerTypes) {
    const m = effectiveness(t, defenderTypes);
    if (m > best.multiplier) best = { type: t, multiplier: m };
  }
  return best;
}

// Effectiveness → stat multiplier. Super effective is a big boost; resisted or
// immune matchups cost a lot.
const STAT_FACTOR = new Map([[4, 1.45], [2, 1.3], [1, 1], [0.5, 0.8], [0.25, 0.7], [0, 0.65]]);
export function statFactor(multiplier) {
  return STAT_FACTOR.get(multiplier) ?? 1;
}

export const MATCHUP_STATS = ['attack', 'spAttack', 'spDefense', 'speed'];

export function boostStats(stats, factor) {
  const out = { ...stats };
  for (const k of MATCHUP_STATS) out[k] = Math.round(stats[k] * factor);
  return out;
}

export function effectivenessLabel(multiplier) {
  if (multiplier === 0) return 'no effect';
  if (multiplier >= 2) return 'super effective';
  if (multiplier < 1) return 'not very effective';
  return 'neutral';
}

/**
 * Both sides of a pitcher-batter matchup.
 * @returns {{pitcher:{type,multiplier,factor}, batter:{type,multiplier,factor}}}
 */
export function matchup(pitcher, batter) {
  const p = bestAttack(pitcher.types, batter.types);
  const b = bestAttack(batter.types, pitcher.types);
  return {
    pitcher: { ...p, factor: statFactor(p.multiplier) },
    batter: { ...b, factor: statFactor(b.multiplier) },
  };
}

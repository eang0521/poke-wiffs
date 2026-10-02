// Bat and batter definitions.
//
// Values are for the classic yellow plastic Wiffle bat: hollow, very light,
// skinny handle flaring to a slightly fatter barrel. Like the ball constants,
// they are reasonable estimates; tune them here.

import { IN } from '../units.js';

export const WIFFLE_BAT = Object.freeze({
  name: 'Yellow plastic bat',
  length: 32 * IN, // m
  mass: 0.17, // kg (~6 oz)
  cmFromKnob: 0.52, // fraction of length (barrel is a bit heavier)
  inertiaFactor: 0.95, // I_cm = f · M L² / 12 (≈ uniform rod)
  handleRadius: 0.45 * IN,
  barrelRadius: 0.65 * IN,
  taperStart: 0.35, // fraction of length where the handle starts flaring
  taperEnd: 0.6, // fraction of length where the barrel reaches full size
  sweetSpotFromKnob: 0.8, // fraction of length (~6.4 in from the tip)
  // Ball-bat coefficient of restitution. The hollow ball crushes more on harder hits,
  // and hits off the sweet spot lose energy to bat vibration.
  corSweet: 0.55, // at 20 m/s normal impact speed
  corSpeedLoss: 0.004, // fractional COR drop per m/s above 20 m/s
  corFalloff: 2.2, // COR · (1 − falloff · (Δs/L)²) away from the sweet spot
  corMin: 0.12,
  friction: 0.35, // plastic-on-plastic tangential friction (puts spin on the ball)
});

export function batRadiusAt(bat, s) {
  const f = s / bat.length;
  if (f <= bat.taperStart) return bat.handleRadius;
  if (f >= bat.taperEnd) return bat.barrelRadius;
  const k = (f - bat.taperStart) / (bat.taperEnd - bat.taperStart);
  return bat.handleRadius + k * (bat.barrelRadius - bat.handleRadius);
}

// Effective mass of a free bat struck at distance s from the knob.
export function batEffectiveMass(bat, s) {
  const icm = (bat.inertiaFactor * bat.mass * bat.length * bat.length) / 12;
  const b = s - bat.cmFromKnob * bat.length;
  return 1 / (1 / bat.mass + (b * b) / icm);
}

export function batCor(bat, s, normalSpeed) {
  const ds = (s - bat.sweetSpotFromKnob * bat.length) / bat.length;
  const speedLoss = 1 - bat.corSpeedLoss * Math.max(0, normalSpeed - 20);
  return Math.max(bat.corMin, bat.corSweet * speedLoss * (1 - bat.corFalloff * ds * ds));
}

// Swing types change bat speed and attack angle (uppercut).
export const SWING_TYPES = Object.freeze({
  contact: { name: 'Contact', speedFactor: 0.9, attackAngleDeg: 4 },
  normal: { name: 'Normal', speedFactor: 1.0, attackAngleDeg: 9 },
  power: { name: 'Power', speedFactor: 1.08, attackAngleDeg: 16 },
});

// A batter's physical swing. Later, Pokémon stats can map onto these numbers.
export const DEFAULT_BATTER = Object.freeze({
  hand: 'R', // 'R' stands on the 3rd-base side, 'L' on the 1st-base side
  batSpeedMph: 58, // sweet-spot speed at contact, normal swing
  handsRadius: 0.3, // m, hands' horizontal distance from the body's rotation axis
  handsHeight: 0.95, // m, hand height at contact for a middle-height pitch
  contactDepth: 0.25, // m in front of the plate point where the bat is square
  swingTime: 0.15, // s from starting the swing until the bat is square
  arcDeg: 110, // bat is live this far either side of square
});

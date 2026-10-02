// The simulation runs in SI units (meters, seconds, kilograms, radians).
// Game-facing configuration uses baseball units; convert at the boundary.

export const FT = 0.3048;
export const IN = 0.0254;
export const MPH = 0.44704;
export const RPM = (2 * Math.PI) / 60;
export const DEG = Math.PI / 180;
export const G = 9.80665;

export const ftToM = (ft) => ft * FT;
export const mToFt = (m) => m / FT;
export const inToM = (inches) => inches * IN;
export const mToIn = (m) => m / IN;
export const mphToMs = (mph) => mph * MPH;
export const msToMph = (ms) => ms / MPH;

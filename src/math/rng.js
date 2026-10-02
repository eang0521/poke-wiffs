// Seeded RNG so every pitch / batted ball is reproducible from a seed.

export function createRng(seed = 1) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let spare = null;
  const gaussian = () => {
    if (spare !== null) {
      const s = spare;
      spare = null;
      return s;
    }
    let u = 0;
    while (u === 0) u = next();
    const v = next();
    const r = Math.sqrt(-2 * Math.log(u));
    spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  };
  const unitVector = () => {
    const z = 2 * next() - 1;
    const phi = 2 * Math.PI * next();
    const r = Math.sqrt(1 - z * z);
    return { x: r * Math.cos(phi), y: r * Math.sin(phi), z };
  };
  return { next, gaussian, unitVector };
}

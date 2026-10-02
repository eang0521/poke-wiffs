// Field geometry. Configured in feet/inches; stored in meters.
//
// Layout (top-down, world frame):
//   - Home plate point at the origin.
//   - The strike-zone frame stands `zoneOffsetFt` BEHIND home (at y = -4 ft).
//   - Both foul lines start at the base of the strike zone and open at a TOTAL
//     angle of `foulLineAngleDeg` (37.5° each side of straightaway center).
//   - 1st and 3rd bases sit on the foul lines at the given distances from home.
//     2nd base is where the 1st→2nd and 3rd→2nd distances meet.
//   - The pitcher's mound is on the center line, `moundDistanceFt` from home.
//   - The home run fence is a polyline from foul pole to foul pole. Each
//     segment has its own height.

import { ftToM, inToM, DEG } from '../units.js';

export const DEFAULT_FIELD_CONFIG = Object.freeze({
  name: 'Backyard Classic',
  homeToFirstFt: 45,
  firstToSecondFt: 40,
  secondToThirdFt: 40,
  thirdToHomeFt: 45,
  zoneOffsetFt: 4,
  zoneWidthIn: 23,
  zoneHeightIn: 28,
  zoneBottomIn: 17,
  moundDistanceFt: 38,
  foulLineAngleDeg: 75,
  // Either {segments, distanceFt, heightFt} for an even polygon, or
  // {vertices: [[xFt, yFt], ...] (pole to pole, left→right), heightsFt: [...]}
  fence: { segments: 5, distanceFt: 100, heightFt: 4 },
});

const p2 = (x, y) => ({ x, y });
const sub2 = (a, b) => p2(a.x - b.x, a.y - b.y);
const dist2 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const cross2 = (a, b) => a.x * b.y - a.y * b.x;

// Point on the ray from `origin` along unit `dir` that is `r` from the home origin.
function pointOnRayAtRadius(origin, dir, r) {
  // |origin + d·dir|² = r²  →  d² + 2d(origin·dir) + |origin|² − r² = 0
  const b = origin.x * dir.x + origin.y * dir.y;
  const c = origin.x * origin.x + origin.y * origin.y - r * r;
  const d = -b + Math.sqrt(b * b - c);
  return p2(origin.x + dir.x * d, origin.y + dir.y * d);
}

function circleIntersectionFar(c1, r1, c2, r2) {
  const d = dist2(c1, c2);
  const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, r1 * r1 - a * a));
  const mx = c1.x + (a * (c2.x - c1.x)) / d;
  const my = c1.y + (a * (c2.y - c1.y)) / d;
  const ox = (-(c2.y - c1.y) * h) / d;
  const oy = ((c2.x - c1.x) * h) / d;
  const A = p2(mx + ox, my + oy);
  const B = p2(mx - ox, my - oy);
  return Math.hypot(A.x, A.y) > Math.hypot(B.x, B.y) ? A : B;
}

export function createField(config = {}) {
  const cfg = { ...DEFAULT_FIELD_CONFIG, ...config, fence: { ...DEFAULT_FIELD_CONFIG.fence, ...config.fence } };
  if (config.fence?.vertices) delete cfg.fence.segments;

  const halfAngle = (cfg.foulLineAngleDeg / 2) * DEG;
  const apex = p2(0, -ftToM(cfg.zoneOffsetFt)); // foul-line vertex = base of strike zone
  const rightDir = p2(Math.sin(halfAngle), Math.cos(halfAngle)); // 1st-base line
  const leftDir = p2(-Math.sin(halfAngle), Math.cos(halfAngle)); // 3rd-base line

  const home = p2(0, 0);
  const first = pointOnRayAtRadius(apex, rightDir, ftToM(cfg.homeToFirstFt));
  const third = pointOnRayAtRadius(apex, leftDir, ftToM(cfg.thirdToHomeFt));
  const second = circleIntersectionFar(first, ftToM(cfg.firstToSecondFt), third, ftToM(cfg.secondToThirdFt));
  const mound = p2(0, ftToM(cfg.moundDistanceFt));

  // Fence polyline, ordered from the left-field (3rd-base) pole to the right-field pole.
  let vertices;
  let heights;
  if (cfg.fence.vertices) {
    vertices = cfg.fence.vertices.map(([x, y]) => p2(ftToM(x), ftToM(y)));
    const hs = cfg.fence.heightsFt ?? [cfg.fence.heightFt];
    heights = vertices.slice(1).map((_, i) => ftToM(hs[i] ?? hs[hs.length - 1]));
  } else {
    const n = cfg.fence.segments;
    const r = ftToM(cfg.fence.distanceFt);
    const leftPole = pointOnRayAtRadius(apex, leftDir, r);
    const rightPole = pointOnRayAtRadius(apex, rightDir, r);
    const a0 = Math.atan2(leftPole.x, leftPole.y);
    const a1 = Math.atan2(rightPole.x, rightPole.y);
    vertices = [];
    for (let i = 0; i <= n; i++) {
      const a = a0 + ((a1 - a0) * i) / n;
      vertices.push(i === 0 ? leftPole : i === n ? rightPole : p2(r * Math.sin(a), r * Math.cos(a)));
    }
    heights = new Array(n).fill(ftToM(cfg.fence.heightFt));
  }
  const fence = vertices.slice(1).map((b, i) => {
    const a = vertices[i];
    const d = sub2(b, a);
    const L = Math.hypot(d.x, d.y);
    // Unit normal pointing back toward home plate.
    let n = p2(-d.y / L, d.x / L);
    if (n.x * (0 - a.x) + n.y * (0 - a.y) < 0) n = p2(-n.x, -n.y);
    return { a, b, height: heights[i], normal: n, length: L };
  });

  const zone = {
    y: apex.y,
    halfWidth: inToM(cfg.zoneWidthIn) / 2,
    bottom: inToM(cfg.zoneBottomIn),
    top: inToM(cfg.zoneBottomIn + cfg.zoneHeightIn),
  };
  zone.centerZ = (zone.bottom + zone.top) / 2;

  /** Spray angle (radians) of a ground point as seen from the foul-line vertex. 0 = straightaway center, + = 1st-base side. */
  const sprayAngle = (p) => Math.atan2(p.x - apex.x, p.y - apex.y);

  /** Fair territory: between the foul lines (the lines themselves are fair). */
  const isFair = (p) => p.y >= apex.y && Math.abs(sprayAngle(p)) <= halfAngle + 1e-9;

  /** Distance from the foul-line vertex, used to tell whether a ball has passed 1st/3rd. */
  const depth = (p) => dist2(p, apex);
  const baseDepth = Math.min(dist2(first, apex), dist2(third, apex));

  /** First fence segment crossed moving from a→b (2D), or null. */
  function fenceCrossing(a, b) {
    let best = null;
    const r = sub2(b, a);
    for (let i = 0; i < fence.length; i++) {
      const seg = fence[i];
      const s = sub2(seg.b, seg.a);
      const denom = cross2(r, s);
      if (Math.abs(denom) < 1e-12) continue;
      const qp = sub2(seg.a, a);
      const t = cross2(qp, s) / denom;
      const u = cross2(qp, r) / denom;
      if (t >= 0 && t <= 1 && u >= 0 && u <= 1 && (!best || t < best.t)) {
        best = { index: i, t, u, point: p2(a.x + r.x * t, a.y + r.y * t), segment: seg };
      }
    }
    return best;
  }

  /** Fence distance (m from home) along a spray direction from home, or null if foul. */
  function fenceDistance(sprayRad) {
    const far = p2(Math.sin(sprayRad) * 1000, Math.cos(sprayRad) * 1000);
    const hit = fenceCrossing(home, far);
    return hit ? Math.hypot(hit.point.x, hit.point.y) : null;
  }

  /** Strike = any part of the ball touches the frame opening. */
  function isStrike(x, z, ballRadius = 0) {
    return Math.abs(x) <= zone.halfWidth + ballRadius && z >= zone.bottom - ballRadius && z <= zone.top + ballRadius;
  }

  return {
    config: cfg,
    apex,
    halfAngle,
    home,
    bases: { home, first, second, third },
    mound,
    zone,
    fence,
    fenceVertices: vertices,
    foulPoles: { left: vertices[0], right: vertices[vertices.length - 1] },
    baseDepth,
    sprayAngle,
    isFair,
    depth,
    fenceCrossing,
    fenceDistance,
    isStrike,
  };
}

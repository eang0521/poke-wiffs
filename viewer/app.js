import {
  createField, PITCHES, PITCH_TYPES, throwPitch, simulateBattedBall, createRng,
  swingAtPitch, idealContact, batPose, DEFAULT_BATTER,
  batterFromStats, pitcherFromStats, SAMPLE_POKEMON, STAT_KEYS, STAT_LABELS,
  mToFt, mToIn, ftToM,
} from '../src/index.js';

const field = createField();
const $ = (id) => document.getElementById(id);
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const PALETTE = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#42d4f4', '#f032e6', '#9a6324', '#469990', '#808000'];
const BAT_COLOR = '#f2c94c';

// ---------- state ----------
let target = { x: 0, z: mToFt(field.zone.centerZ) }; // pitch target, feet
let batAim = { x: 0, z: mToFt(field.zone.centerZ) }; // bat aim at the contact plane, feet
// One scene drives every view. Times are on the pitch clock (s after release).
let scene = { pitchRuns: [], battedRuns: [], swing: null, battedOffset: 0, live: false };
let anim = null; // {t0, duration}
let seedCounter = 1;

// ---------- Pokémon pickers ----------
function setupMonPicker(prefix) {
  const sel = $(`${prefix}mon`);
  sel.add(new Option('Generic (no stats)', 'generic'));
  for (const [k, m] of Object.entries(SAMPLE_POKEMON)) sel.add(new Option(m.name, k));
  sel.add(new Option('Custom…', 'custom'));
  $(`${prefix}stats`).innerHTML = STAT_KEYS.map((k) =>
    `<div><label for="${prefix}-${k}">${STAT_LABELS[k]}</label><input id="${prefix}-${k}" type="number" min="1" max="255" value="80"></div>`).join('');
  const fill = () => {
    const m = SAMPLE_POKEMON[sel.value];
    for (const k of STAT_KEYS) {
      const inp = $(`${prefix}-${k}`);
      inp.disabled = sel.value === 'generic';
      if (m) inp.value = m.stats[k];
    }
    refreshDerived();
  };
  sel.addEventListener('change', fill);
  for (const k of STAT_KEYS) $(`${prefix}-${k}`).addEventListener('input', () => { sel.value = 'custom'; refreshDerived(); });
  return fill;
}
const readStats = (prefix) => Object.fromEntries(STAT_KEYS.map((k) => [k, Number($(`${prefix}-${k}`).value)]));
const monName = (prefix) => SAMPLE_POKEMON[$(`${prefix}mon`).value]?.name ?? 'Custom';

function pitcher() {
  if ($('pmon').value === 'generic') return null;
  return pitcherFromStats(readStats('p'), { hand: $('hand').value, name: monName('p') });
}
function batter() {
  const hand = $('bhand').value;
  if ($('bmon').value === 'generic') return { ...DEFAULT_BATTER, hand };
  return { ...DEFAULT_BATTER, ...batterFromStats(readStats('b'), { hand, name: monName('b') }) };
}

function refreshDerived() {
  const P = pitcher();
  const fb = PITCHES.fastball.speedMph;
  $('pderived').innerHTML = P
    ? `Fastball <b>${(fb * P.velocityScale).toFixed(0)} mph</b> · spin <b>×${P.spinScale.toFixed(2)}</b> · scuff <b>×${P.holeForceScale.toFixed(2)}</b><br>` +
      `command <b>×${P.commandScale.toFixed(2)}</b> error · extension <b>${P.extensionFt.toFixed(1)} ft</b> · stamina <b>${P.staminaPitches.toFixed(0)}</b> pitches`
    : 'Default physics: catalog speeds, spins and command.';
  const B = batter();
  $('bderived').innerHTML = $('bmon').value === 'generic'
    ? `Default batter: bat <b>${B.batSpeedMph} mph</b>, no contact assist.`
    : `Bat speed <b>${B.batSpeedMph.toFixed(0)} mph</b> · contact <b>${B.contact.toFixed(2)}</b> · swing <b>${(B.swingTime * 1000).toFixed(0)} ms</b><br>` +
      `eye <b>${B.eye.toFixed(2)}</b> · fielding <b>${B.fielding.toFixed(2)}</b> · stamina <b>${B.stamina.toFixed(2)}</b>`;
}

// ---------- controls ----------
for (const k of PITCH_TYPES) $('pitch').add(new Option(PITCHES[k].name, k));
const syncPitch = () => {
  const d = PITCHES[$('pitch').value];
  $('speed').value = '';
  $('blurb').textContent = d.blurb;
};
$('pitch').addEventListener('change', syncPitch);
syncPitch();
const fillP = setupMonPicker('p');
const fillB = setupMonPicker('b');
$('pmon').value = 'charizard';
$('bmon').value = 'machamp';
fillP();
fillB();
$('hand').addEventListener('change', refreshDerived);
$('bhand').addEventListener('change', refreshDerived);
const syncSlow = () => ($('slowmoVal').textContent = `${$('slowmo').value}×`);
$('slowmo').addEventListener('input', syncSlow);
syncSlow();

function newPitch(execution = $('execution').checked) {
  const override = $('speed').value === '' ? undefined : Number($('speed').value);
  const count = Number($('pcount').value) || 0;
  const res = throwPitch({
    pitch: $('pitch').value, hand: $('hand').value, field, target, pitcher: pitcher(), pitchCount: count,
    speedMph: override, execution, seed: seedCounter++,
  });
  $('pcount').value = count + 1;
  return { res, color: css('--accent'), label: res.pitch };
}

$('throw').addEventListener('click', () => {
  const run = newPitch();
  scene = { pitchRuns: [run], battedRuns: [], swing: null, battedOffset: 0, live: false };
  play(run.res.flightTime);
  showPitchStats(run.res);
});

$('live').addEventListener('click', () => {
  const run = newPitch();
  scene = { pitchRuns: [run], battedRuns: [], swing: null, battedOffset: 0, live: true };
  $('stats').innerHTML = row('At bat', `${run.res.pitch} coming… press Space`);
  play(run.res.flightTime + 0.25);
});

$('auto').addEventListener('click', () => {
  const pitchRes = scene.pitchRuns.length === 1 ? scene.pitchRuns[0].res : newPitch().res;
  const ideal = idealContact(pitchRes, batter());
  if (!ideal) return;
  scene = { pitchRuns: [{ res: pitchRes, color: css('--accent'), label: pitchRes.pitch }], battedRuns: [], swing: null, battedOffset: 0, live: false };
  doSwing(ideal.t + Number($('offt').value) / 1000, { x: mToFt(ideal.pos.x), z: mToFt(ideal.pos.z) - Number($('offz').value) / 12 });
  play(Math.max(pitchRes.flightTime, endOfScene()));
});

$('arsenal').addEventListener('click', () => {
  scene = {
    pitchRuns: PITCH_TYPES.map((k, i) => ({
      res: throwPitch({ pitch: k, hand: $('hand').value, field, target, pitcher: pitcher(), execution: false, seed: 1 }),
      color: PALETTE[i % PALETTE.length], label: PITCHES[k].name,
    })),
    battedRuns: [], swing: null, battedOffset: 0, live: false,
  };
  anim = null;
  $('stats').innerHTML = scene.pitchRuns.map((r) =>
    `<tr><td><span style="color:${r.color}">●</span> ${r.label}</td><td>${fmtIn(r.res.break.gloveSide)} glove / ${fmtIn(r.res.break.z)} vert</td></tr>`).join('');
  draw();
});

$('hit').addEventListener('click', () => {
  const res = simulateBattedBall({
    field, exitVeloMph: Number($('ev').value), launchAngleDeg: Number($('la').value),
    sprayAngleDeg: Number($('spray').value), seed: seedCounter++,
  });
  scene = { pitchRuns: [], battedRuns: [{ res }], swing: null, battedOffset: 0, live: false };
  play(res.path[res.path.length - 1].t);
  showBatStats(res);
});

$('spray20').addEventListener('click', () => {
  const rng = createRng(seedCounter++);
  scene = {
    pitchRuns: [], swing: null, battedOffset: 0, live: false,
    battedRuns: Array.from({ length: 40 }, (_, i) => ({
      res: simulateBattedBall({
        field, exitVeloMph: 45 + rng.next() * 45, launchAngleDeg: -10 + rng.next() * 55,
        sprayAngleDeg: -50 + rng.next() * 100, seed: 1000 + i,
      }),
    })),
  };
  anim = null;
  const count = (o) => scene.battedRuns.filter((r) => r.res.outcome === o).length;
  $('stats').innerHTML = row('Home runs', count('home_run')) + row('Fair in play', count('fair')) + row('Foul', count('foul'));
  draw();
});

// ---------- swinging ----------
function doSwing(timing, aimFt) {
  const pitchRes = scene.pitchRuns[0].res;
  const r = swingAtPitch({
    pitch: pitchRes, field, timing, aimFt, type: $('stype').value, batter: batter(), seed: seedCounter++,
  });
  scene.swing = r;
  if (r.contact) {
    scene.battedRuns = [{ res: r.batted }];
    scene.battedOffset = r.t;
  }
  showSwingStats(r, pitchRes);
  return r;
}

function endOfScene() {
  const s = scene.swing;
  if (s?.contact) return s.t + s.batted.path[s.batted.path.length - 1].t;
  return s ? s.swing.end : 0;
}

function trySwing() {
  if (!scene.live || scene.swing || !anim) return;
  const tPress = currentSimTime();
  doSwing(tPress + batter().swingTime, batAim);
  anim.duration = Math.max(anim.duration, endOfScene());
}

addEventListener('keydown', (e) => {
  if (e.code === 'Space' && scene.live) { e.preventDefault(); trySwing(); }
});

// ---------- stats ----------
const fmtIn = (m) => `${mToIn(m) >= 0 ? '+' : ''}${mToIn(m).toFixed(1)}"`;
const row = (k, v) => `<tr><td>${k}</td><td>${v}</td></tr>`;

function showPitchStats(r, prefix = '') {
  const c = r.crossing?.pos;
  $('stats').innerHTML = [
    row('Result', prefix + r.result.replace(/_/g, ' ')),
    row('Pitcher', `${r.pitcher ?? 'Generic'} (${r.hand}HP)${r.fatigued ? ' — tired' : ''}`),
    row('Release speed', `${r.releaseSpeedMph.toFixed(1)} mph`),
    row('Speed at zone', `${r.endSpeedMph.toFixed(1)} mph`),
    row('Flight time', `${r.flightTime.toFixed(3)} s`),
    row('Spin', `${Math.round(r.spinRpm)} rpm`),
    row('Glove-side break', fmtIn(r.break.gloveSide)),
    row('Vertical break (vs. no spin/holes)', fmtIn(r.break.z)),
    row('Crossed at', c ? `${mToIn(c.x).toFixed(1)}", ${mToIn(c.z).toFixed(1)}" high` : '—'),
    row('Miss from target', r.missFromTarget != null ? `${mToIn(r.missFromTarget).toFixed(1)}"` : '—'),
  ].join('');
}

function timingText(ms) {
  if (ms == null) return '—';
  const a = Math.abs(ms).toFixed(0);
  return Math.abs(ms) < 1 ? 'on time' : ms < 0 ? `${a} ms early` : `${a} ms late`;
}

function showSwingStats(r, pitchRes) {
  if (!r.contact) {
    const m = r.miss;
    const how = m.glancing ? 'foul tip (glanced off)' : m.byIn == null ? 'way off' : `swung ${m.ballAbove ? 'under' : 'over'} it by ${m.byIn.toFixed(1)}"`;
    $('stats').innerHTML = row('Swing', 'MISS — strike') + row('Timing', timingText(r.timingErrorMs)) + row('Miss', how) + row('Pitch', pitchRes.pitch);
    return;
  }
  const b = r.batted;
  $('stats').innerHTML = [
    row('Outcome', b.outcome.replace('_', ' ') + (b.hitWall ? ' (off wall)' : '') + (b.reachedWall ? ' (to wall)' : '')),
    row('Timing', r.rawTimingErrorMs != null && Math.abs(r.rawTimingErrorMs - r.timingErrorMs) > 0.5
      ? `${timingText(r.rawTimingErrorMs)} → ${timingText(r.timingErrorMs)} (contact assist)`
      : timingText(r.timingErrorMs)),
    row('Contact', `${Math.abs(r.inchesFromSweetSpot).toFixed(1)}" ${r.inchesFromSweetSpot >= 0 ? 'toward tip' : 'toward hands'} of sweet spot`),
    row('Bat speed at contact', `${r.batSpeedMph.toFixed(1)} mph`),
    row('Exit velo', `${r.exitVeloMph.toFixed(1)} mph`),
    row('Launch angle', `${r.launchAngleDeg.toFixed(1)}°`),
    row('Spray angle', `${r.sprayAngleDeg.toFixed(1)}°`),
    row('Spin', `${r.backspinRpm >= 0 ? 'back' : 'top'} ${Math.abs(r.backspinRpm).toFixed(0)} / side ${r.sidespinRpm.toFixed(0)} rpm`),
    row('Carry', b.firstLanding ? `${mToFt(b.firstLanding.distance).toFixed(0)} ft` : '—'),
    b.homeRun ? row('Cleared fence by', `${mToFt(b.homeRun.clearance).toFixed(1)} ft`) : '',
  ].join('');
}

function showBatStats(b) {
  $('stats').innerHTML = [
    row('Outcome', b.outcome.replace('_', ' ') + (b.hitWall ? ' (off wall)' : '') + (b.reachedWall ? ' (to wall)' : '')),
    row('Carry', b.firstLanding ? `${mToFt(b.firstLanding.distance).toFixed(0)} ft` : '—'),
    row('Apex', `${mToFt(b.apex).toFixed(1)} ft`),
    row('Hang time', b.hangTime ? `${b.hangTime.toFixed(2)} s` : '—'),
    row('Came to rest', `${mToFt(b.restDistance).toFixed(0)} ft`),
    b.homeRun ? row('Cleared fence by', `${mToFt(b.homeRun.clearance).toFixed(1)} ft`) : '',
  ].join('');
}

// ---------- animation ----------
function play(duration) {
  anim = { t0: performance.now(), duration };
  requestAnimationFrame(tick);
}
const currentSimTime = () => (anim ? ((performance.now() - anim.t0) / 1000) * Number($('slowmo').value) : null);
function tick() {
  if (!anim) return draw();
  const t = currentSimTime();
  draw(t);
  if (t < anim.duration) return requestAnimationFrame(tick);
  anim = null;
  if (scene.live && !scene.swing) showPitchStats(scene.pitchRuns[0].res, 'Taken — ');
  draw();
}

// ---------- drawing helpers ----------
function ctxOf(id) {
  const c = $(id);
  const g = c.getContext('2d');
  g.clearRect(0, 0, c.width, c.height);
  return [g, c.width, c.height];
}
const upTo = (samples, t) => (t == null ? samples : samples.filter((s) => s.t <= t));
function polyline(g, pts, color, width = 2) {
  if (pts.length < 2) return;
  g.strokeStyle = color; g.lineWidth = width; g.beginPath();
  pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
  g.stroke();
}
function dot(g, x, y, r, fill, stroke) {
  g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2);
  if (fill) { g.fillStyle = fill; g.fill(); }
  if (stroke) { g.strokeStyle = stroke; g.lineWidth = 1.5; g.stroke(); }
}

// Pitch clock cut-off: the pitch stops being drawn once the bat hits it.
const pitchCut = (t) => {
  const c = scene.swing?.contact ? scene.swing.t : Infinity;
  return t == null ? (Number.isFinite(c) ? c : undefined) : Math.min(t, c);
};
// Bat pose to show at time t (null before the swing starts).
function batAt(t) {
  const s = scene.swing;
  if (!s) return null;
  // Freeze at the contact pose (or the follow-through on a miss).
  const freeze = s.contact ? s.t : s.swing.end;
  if (t != null && t < s.swing.start) return null;
  return batPose(s.swing, t == null ? freeze : Math.min(t, freeze));
}

// ---------- catcher view ----------
const CAM = { y: field.zone.y - 2.2, z: field.zone.centerZ, f: 560 };
const contactDepth = () => batter().contactDepth;
function catcherProject(p, W, H) {
  const d = p.y - CAM.y;
  return [W / 2 + (CAM.f * p.x) / d, H / 2 - (CAM.f * (p.z - CAM.z)) / d, d];
}
function catcherUnproject(e, planeY) {
  const c = $('catcher');
  const r = c.getBoundingClientRect();
  const sx = ((e.clientX - r.left) / r.width) * c.width;
  const sy = ((e.clientY - r.top) / r.height) * c.height;
  const d = planeY - CAM.y;
  return { x: mToFt(((sx - c.width / 2) * d) / CAM.f), z: mToFt(CAM.z - ((sy - c.height / 2) * d) / CAM.f) };
}
$('catcher').addEventListener('mousemove', (e) => {
  batAim = catcherUnproject(e, contactDepth());
  if (!anim) draw();
});
$('catcher').addEventListener('click', (e) => {
  if (scene.live && anim) return trySwing();
  target = catcherUnproject(e, field.zone.y);
  draw();
});

function drawCatcher(t) {
  const [g, W, H] = ctxOf('catcher');
  const z = field.zone;
  const [, gy] = catcherProject({ x: 0, y: field.zone.y, z: 0 }, W, H);
  g.fillStyle = css('--grass'); g.fillRect(0, gy, W, H - gy);
  // zone frame
  const [x0, y0] = catcherProject({ x: -z.halfWidth, y: z.y, z: z.top }, W, H);
  const [x1, y1] = catcherProject({ x: z.halfWidth, y: z.y, z: z.bottom }, W, H);
  g.strokeStyle = css('--zone'); g.lineWidth = 3; g.strokeRect(x0, y0, x1 - x0, y1 - y0);
  g.lineWidth = 1; g.setLineDash([4, 4]);
  for (let i = 1; i < 3; i++) {
    g.beginPath(); g.moveTo(x0 + ((x1 - x0) * i) / 3, y0); g.lineTo(x0 + ((x1 - x0) * i) / 3, y1); g.stroke();
    g.beginPath(); g.moveTo(x0, y0 + ((y1 - y0) * i) / 3); g.lineTo(x1, y0 + ((y1 - y0) * i) / 3); g.stroke();
  }
  g.setLineDash([]);
  const [, legY] = catcherProject({ x: 0, y: z.y, z: 0 }, W, H);
  g.beginPath(); g.moveTo(x0, y1); g.lineTo(x0, legY); g.moveTo(x1, y1); g.lineTo(x1, legY); g.stroke();

  // pitch target (+)
  const [tx, ty] = catcherProject({ x: ftToM(target.x), y: z.y, z: ftToM(target.z) }, W, H);
  g.strokeStyle = css('--ink'); g.lineWidth = 1.5;
  g.beginPath(); g.moveTo(tx - 8, ty); g.lineTo(tx + 8, ty); g.moveTo(tx, ty - 8); g.lineTo(tx, ty + 8); g.stroke();

  // bat aim (yellow ring) during a live at-bat, or where the swing was aimed
  const aim = scene.swing ? { x: mToFt(scene.swing.swing.aim.x), z: mToFt(scene.swing.swing.aim.z) } : scene.live ? batAim : null;
  if (aim) {
    const [ax, ay] = catcherProject({ x: ftToM(aim.x), y: contactDepth(), z: ftToM(aim.z) }, W, H);
    dot(g, ax, ay, 9, null, BAT_COLOR);
  }

  const tp = pitchCut(t);
  for (const run of scene.pitchRuns) {
    const pts = upTo(run.res.samples, tp).map((s) => catcherProject(s.pos, W, H));
    polyline(g, pts, run.color, 1.5);
    const last = pts[pts.length - 1];
    if (last) {
      const rad = Math.max(2, (CAM.f * 0.0365) / last[2]);
      const multi = scene.pitchRuns.length > 1;
      dot(g, last[0], last[1], multi ? 3 : rad, multi ? run.color : css('--ball'), run.color);
    }
  }
  // where the ball was at the contact plane (feedback after a swing)
  if (scene.swing?.ideal && (t == null || t >= scene.swing.ideal.t)) {
    const [ix, iy, d] = catcherProject(scene.swing.ideal.pos, W, H);
    g.setLineDash([2, 3]); dot(g, ix, iy, (CAM.f * 0.0365) / d, null, css('--muted')); g.setLineDash([]);
  }
  // bat
  const pose = batAt(t);
  if (pose) {
    const [kx, ky, kd] = catcherProject(pose.knob, W, H);
    const [px, py] = catcherProject(pose.tip, W, H);
    g.lineCap = 'round';
    g.strokeStyle = BAT_COLOR; g.lineWidth = Math.max(3, (CAM.f * 0.033) / kd);
    g.beginPath(); g.moveTo(kx, ky); g.lineTo(px, py); g.stroke();
    g.lineCap = 'butt';
  }
  g.fillStyle = css('--muted'); g.font = '12px system-ui';
  g.fillText('1B side →', W - 70, H - 8);
  g.fillText('← 3B side', 8, H - 8);
}

// ---------- side view ----------
function drawSide(t) {
  const [g, W, H] = ctxOf('side');
  const yMin = field.zone.y - 0.6;
  const yMax = field.mound.y + 0.8;
  const pad = 20;
  const sx = (y) => pad + ((yMax - y) / (yMax - yMin)) * (W - 2 * pad);
  const zMax = 2.4;
  const sz = (z) => H - 30 - (z / zMax) * (H - 60);
  g.fillStyle = css('--grass'); g.fillRect(0, sz(0), W, H - sz(0));
  g.fillStyle = css('--dirt'); g.fillRect(sx(field.mound.y) - 6, sz(0), 12, 4);
  g.fillStyle = css('--ink'); g.fillRect(sx(0) - 3, sz(0), 6, 3);
  g.strokeStyle = css('--zone'); g.lineWidth = 3;
  g.beginPath(); g.moveTo(sx(field.zone.y), sz(field.zone.bottom)); g.lineTo(sx(field.zone.y), sz(field.zone.top)); g.stroke();
  g.fillStyle = css('--muted'); g.font = '11px system-ui';
  g.fillText('mound', sx(field.mound.y) - 16, sz(0) + 16);
  g.fillText('plate', sx(0) - 12, sz(0) + 16);
  g.fillText('zone', sx(field.zone.y) - 10, sz(0) + 16);
  g.fillText('vertical scale ×' + (((H - 60) / zMax) / ((W - 2 * pad) / (yMax - yMin))).toFixed(1), W - 120, 14);
  const tp = pitchCut(t);
  for (const run of scene.pitchRuns) {
    const pts = upTo(run.res.samples, tp).map((s) => [sx(s.pos.y), sz(s.pos.z)]);
    polyline(g, pts, run.color, 1.5);
    const last = pts[pts.length - 1];
    if (last) dot(g, last[0], last[1], 4, css('--ball'), run.color);
  }
  const pose = batAt(t);
  if (pose) {
    g.strokeStyle = BAT_COLOR; g.lineWidth = 4; g.lineCap = 'round';
    g.beginPath(); g.moveTo(sx(pose.knob.y), sz(pose.knob.z)); g.lineTo(sx(pose.tip.y), sz(pose.tip.z)); g.stroke();
    g.lineCap = 'butt';
  }
}

// ---------- field view ----------
function drawField(t) {
  const [g, W, H] = ctxOf('field');
  const s = 13.5; // px per meter
  const ox = W / 2;
  const oy = H - 40;
  const P = (p) => [ox + p.x * s, oy - p.y * s];
  const path = (pts) => { g.beginPath(); pts.forEach((p, i) => { const [x, y] = P(p); i ? g.lineTo(x, y) : g.moveTo(x, y); }); };

  g.fillStyle = css('--grass');
  path([field.apex, ...field.fenceVertices]); g.closePath(); g.fill();
  const b = field.bases;
  g.fillStyle = css('--dirt');
  path([b.home, b.first, b.second, b.third]); g.closePath(); g.fill();
  g.strokeStyle = css('--line'); g.lineWidth = 1; g.setLineDash([3, 5]);
  g.fillStyle = css('--muted'); g.font = '11px system-ui';
  for (const ftR of [40, 60, 100, 120]) {
    const r = ftToM(ftR) * s;
    g.beginPath(); g.arc(ox, oy, r, -Math.PI / 2 - 0.9, -Math.PI / 2 + 0.9); g.stroke();
    g.fillText(`${ftR}'`, ox + 3, oy - r - 3);
  }
  g.setLineDash([]);
  g.strokeStyle = css('--ink'); g.lineWidth = 1.5;
  for (const pole of [field.foulPoles.left, field.foulPoles.right]) {
    const d = { x: pole.x - field.apex.x, y: pole.y - field.apex.y };
    path([field.apex, { x: field.apex.x + d.x * 1.6, y: field.apex.y + d.y * 1.6 }]); g.stroke();
  }
  g.strokeStyle = css('--fence'); g.lineWidth = 5;
  path(field.fenceVertices); g.stroke();
  field.fence.forEach((seg) => {
    const [x, y] = P({ x: (seg.a.x + seg.b.x) / 2, y: (seg.a.y + seg.b.y) / 2 });
    g.fillStyle = css('--muted'); g.fillText(`${mToFt(Math.hypot(seg.a.x, seg.a.y)).toFixed(0)}' · ${mToFt(seg.height).toFixed(0)}' tall`, x - 30, y - 10);
  });
  for (const base of [b.first, b.second, b.third]) {
    const [x, y] = P(base); g.fillStyle = '#fff'; g.strokeStyle = css('--ink'); g.lineWidth = 1;
    g.save(); g.translate(x, y); g.rotate(Math.PI / 4); g.fillRect(-5, -5, 10, 10); g.strokeRect(-5, -5, 10, 10); g.restore();
  }
  { const [x, y] = P(b.home); g.fillStyle = '#fff'; g.fillRect(x - 5, y - 4, 10, 8); }
  { const [x, y] = P(field.mound); dot(g, x, y, 7, css('--dirt'), css('--ink')); }
  { const [x0, y0] = P({ x: -field.zone.halfWidth, y: field.zone.y }); const [x1] = P({ x: field.zone.halfWidth, y: 0 });
    g.strokeStyle = css('--zone'); g.lineWidth = 3; g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y0); g.stroke(); }

  const tp = pitchCut(t);
  for (const run of scene.pitchRuns) polyline(g, upTo(run.res.samples, tp).map((q) => P(q.pos)), run.color, 1.5);

  const pose = batAt(t);
  if (pose) polyline(g, [P(pose.knob), P(pose.tip)], BAT_COLOR, 4);

  // batted balls (their own clock starts at contact)
  const tb = t == null ? undefined : t - scene.battedOffset;
  const colorFor = (o) => (o === 'home_run' ? '#e6194b' : o === 'foul' ? css('--muted') : css('--accent'));
  if (tb == null || tb >= 0) {
    for (const run of scene.battedRuns) {
      const r = run.res;
      const pts = upTo(r.path, tb);
      polyline(g, pts.map((q) => P(q.pos)), colorFor(r.outcome), scene.battedRuns.length > 1 ? 1 : 2);
      const last = pts[pts.length - 1];
      if (!last) continue;
      const [x, y] = P(last.pos);
      if (tb != null) {
        dot(g, x, y, 3 + last.pos.z * 0.8, css('--ball'), css('--ink'));
        g.fillStyle = css('--ink'); g.fillText(`${mToFt(last.pos.z).toFixed(0)} ft up`, x + 10, y);
      } else {
        dot(g, x, y, 3.5, colorFor(r.outcome));
        if (r.firstLanding && scene.battedRuns.length === 1) { const [lx, ly] = P(r.firstLanding.pos); dot(g, lx, ly, 4, null, colorFor(r.outcome)); }
      }
    }
  }
  let lx = 12;
  for (const o of ['home_run', 'fair', 'foul']) {
    g.fillStyle = colorFor(o); g.fillText('●', lx, 18);
    g.fillStyle = css('--muted'); g.fillText(o.replace('_', ' '), lx + 12, 18);
    lx += 80;
  }
}

function draw(t) {
  drawCatcher(t);
  drawSide(t);
  drawField(t);
}

matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => draw());
draw();

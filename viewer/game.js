import {
  createField, createTeam, createPlayer, createGame, POKEDEX, getPokemon, spriteUrl, PITCHES,
  batPose, mToFt, ftToM, createRng,
} from '../src/index.js';

const $ = (id) => document.getElementById(id);
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const field = createField();
const SIDES = ['away', 'home'];

// ---------- sprites ----------
const spriteCache = new Map();
function sprite(slug) {
  let img = spriteCache.get(slug);
  if (!img) {
    img = new Image();
    img.src = spriteUrl(slug);
    img.onload = () => requestRedraw();
    spriteCache.set(slug, img);
  }
  return img;
}
let redrawQueued = false;
function requestRedraw() {
  if (redrawQueued) return;
  redrawQueued = true;
  requestAnimationFrame(() => { redrawQueued = false; if (game && !busy) drawIdle(); });
}

// ---------- team setup ----------
const byName = new Map(POKEDEX.map((p) => [p.name.toLowerCase(), p]));
const datalist = document.createElement('datalist');
datalist.id = 'mons';
datalist.innerHTML = POKEDEX.map((p) => `<option value="${p.name}">`).join('');
document.body.append(datalist);

const DEFAULTS = {
  away: { name: 'Pallet Town Pidgeys', roster: ['charizard', 'pikachu', 'machamp', 'alakazam', 'snorlax', 'gengar'] },
  home: { name: 'Cerulean Splash', roster: ['blastoise', 'gyarados', 'starmie', 'lapras', 'jolteon', 'scizor'] },
};
const setup = { away: { ...DEFAULTS.away, control: 'cpu' }, home: { ...DEFAULTS.home, control: 'cpu' } };
setup.away.control = 'human';

const strongPool = POKEDEX.filter((p) => Object.values(p.stats).reduce((a, b) => a + b, 0) >= 450);
const rng = createRng(Date.now() % 100000);

function renderSetup(side) {
  const t = setup[side];
  const el = $(`edit-${side}`);
  el.innerHTML = `
    <h2><span style="color:var(--${side})">●</span> ${side === 'away' ? 'Away' : 'Home'}</h2>
    <label class="small">Team name</label><input class="tname" value="${t.name}" style="width:100%">
    <label class="small">Controlled by</label>
    <select class="ctrl"><option value="cpu">CPU</option><option value="human">Human (bat + pitch)</option></select>
    <label class="small">Party (batting order is set automatically)</label>
    ${t.roster.map((slug, i) => {
      const m = getPokemon(slug);
      const pl = m ? createPlayer(m) : null;
      return `<div class="slot"><img src="${m ? spriteUrl(m.slug) : ''}" alt="">
        <div><input data-i="${i}" list="mons" value="${m ? m.name : ''}">
        <div class="meta">${pl ? `${m.types.join('/')} · throws ${pl.throws}, bats ${pl.bats} · ${pl.arsenal.map((p) => PITCHES[p].name).join(', ')}` : 'Unknown Pokémon'}</div></div></div>`;
    }).join('')}
    <div class="team-actions"><button class="secondary rand">Random team</button></div>`;
  el.querySelector('.tname').addEventListener('input', (e) => (t.name = e.target.value));
  const ctrl = el.querySelector('.ctrl');
  ctrl.value = t.control;
  ctrl.addEventListener('change', () => (t.control = ctrl.value));
  el.querySelectorAll('.slot input').forEach((inp) => inp.addEventListener('change', () => {
    const m = byName.get(inp.value.trim().toLowerCase());
    if (m) t.roster[Number(inp.dataset.i)] = m.slug;
    renderSetup(side);
  }));
  el.querySelector('.rand').addEventListener('click', () => {
    const set = new Set();
    while (set.size < 6) set.add(strongPool[Math.floor(rng.next() * strongPool.length)].slug);
    t.roster = [...set];
    renderSetup(side);
  });
}
SIDES.forEach(renderSetup);

// ---------- game state ----------
let game = null;
let control = { away: 'cpu', home: 'cpu' };
let busy = false;
let lastEvent = null; // for the plate view after a pitch
let humanPitch = { pitch: null, target: null };

$('start').addEventListener('click', () => {
  for (const side of SIDES) if (new Set(setup[side].roster).size !== 6) return alert(`${setup[side].name}: pick 6 different Pokémon`);
  const away = createTeam(setup.away.name, setup.away.roster.map((s, i) => createPlayer(s, { uid: `a${i}` })));
  const home = createTeam(setup.home.name, setup.home.roster.map((s, i) => createPlayer(s, { uid: `h${i}` })));
  control = { away: setup.away.control, home: setup.home.control };
  game = createGame({ away, home, field, rules: { innings: Number($('innings').value) }, seed: Math.floor(Math.random() * 1e9) });
  for (const t of [away, home]) t.players.forEach((p) => sprite(p.slug));
  $('setup').style.display = 'none';
  $('gameview').style.display = 'block';
  renderAll();
  prepareTurn();
});

// ---------- controls ----------
const syncLbl = () => {
  $('pitchSpeedLbl').textContent = `${$('pitchSpeed').value}×`;
  $('playSpeedLbl').textContent = `${$('playSpeed').value}×`;
};
$('pitchSpeed').addEventListener('input', syncLbl);
$('playSpeed').addEventListener('input', syncLbl);
syncLbl();

$('next').addEventListener('click', () => runPitch());
$('simHalf').addEventListener('click', () => simUntil((s0, s) => s.half !== s0.half || s.inning !== s0.inning));
$('simGame').addEventListener('click', () => simUntil(() => false));

function simUntil(stop) {
  if (busy || game.state.over) return;
  const s0 = { half: game.state.half, inning: game.state.inning };
  let n = 0;
  while (!game.state.over && n++ < 3000) {
    lastEvent = game.step();
    if (stop(s0, game.state)) break;
  }
  humanPitch = { pitch: null, target: null };
  renderAll();
  prepareTurn();
}

const humanBatting = () => control[game.situation().battingSide] === 'human';
const humanPitching = () => control[game.situation().fieldingSide] === 'human';

// The prompt shows the last pitch's result above the next instruction.
function setPrompt(instruction) {
  const last = lastEvent ? `<div>${lastEvent.text}${lastEvent.swing && humanBattingFor(lastEvent) ? ` <span style="color:var(--muted)">(${timingWord(lastEvent.swing.timingErrorMs)})</span>` : ''}</div>` : '';
  $('prompt').innerHTML = last + (instruction ? `<div style="color:var(--muted);font-weight:500">${instruction}</div>` : '');
}
const humanBattingFor = (ev) => !!ev.humanBat;

function prepareTurn() {
  if (game.state.over) {
    setPrompt(game.state.winner ? `<b>${game.teams[game.state.winner].name} win!</b>` : 'Tie game.');
    $('next').disabled = true;
    return;
  }
  $('next').disabled = false;
  $('humanBat').style.display = humanBatting() ? 'flex' : 'none';
  if (humanPitching()) {
    setPrompt(humanPitch.pitch ? 'Click the plate view to pick a target.' : 'Your pitch: choose one from your arsenal, then click a target.');
    $('next').disabled = true;
  } else if (humanBatting()) {
    setPrompt('Your at-bat: press <b>Next pitch</b>, aim with the mouse, <kbd>Space</kbd> to swing.');
  } else {
    setPrompt('');
    if ($('auto').checked) setTimeout(() => { if (!busy && !humanPitching() && !humanBatting()) runPitch(); }, 350);
  }
  renderCards();
  drawIdle();
}

// ---------- one pitch ----------
async function runPitch(choice) {
  if (busy || game.state.over) return;
  busy = true;
  $('next').disabled = true;
  const before = game.situation();
  const pitch = game.preparePitch(choice);
  let ev;
  const humanBat = humanBatting();
  if (humanBat) {
    ev = await animatePitchHuman(pitch);
  } else {
    ev = game.resolvePitch();
    await animatePitch(pitch, ev);
  }
  ev.humanBat = humanBat;
  lastEvent = ev;
  if (ev.play?.timeline && ev.play.timeline.end > 0) await animatePlay(ev, before);
  humanPitch = { pitch: null, target: null };
  busy = false;
  renderAll();
  prepareTurn();
}

// ---------- plate view ----------
const CAM = { y: field.zone.y - 2.4, z: field.zone.centerZ + 0.05, f: 480 };
const contactDepth = 0.25;
let mouseAim = null; // feet, at the contact plane
const project = (p, W, H) => {
  const d = p.y - CAM.y;
  return [W / 2 + (CAM.f * p.x) / d, H * 0.52 - (CAM.f * (p.z - CAM.z)) / d, d];
};
const unproject = (e, planeY) => {
  const c = $('plate');
  const r = c.getBoundingClientRect();
  const sx = ((e.clientX - r.left) / r.width) * c.width;
  const sy = ((e.clientY - r.top) / r.height) * c.height;
  const d = planeY - CAM.y;
  return { x: mToFt(((sx - c.width / 2) * d) / CAM.f), z: mToFt(CAM.z - ((sy - c.height * 0.52) * d) / CAM.f) };
};
$('plate').addEventListener('mousemove', (e) => { mouseAim = unproject(e, contactDepth); if (!busy) drawPlate(); });
$('plate').addEventListener('click', (e) => {
  if (busy && humanSwingHandler) return humanSwingHandler();
  if (!busy && game && humanPitching() && humanPitch.pitch) {
    humanPitch.target = unproject(e, field.zone.y);
    runPitch({ pitch: humanPitch.pitch, target: humanPitch.target });
  }
});
let humanSwingHandler = null;
addEventListener('keydown', (e) => {
  if (e.code === 'Space' && humanSwingHandler) { e.preventDefault(); humanSwingHandler(); }
});

function drawPlate(pitch = null, t = null, ev = null, aimFt = null) {
  const c = $('plate');
  const g = c.getContext('2d');
  const W = c.width, H = c.height;
  g.clearRect(0, 0, W, H);
  const z = field.zone;
  const [, gy] = project({ x: 0, y: z.y, z: 0 }, W, H);
  g.fillStyle = css('--grass'); g.fillRect(0, gy, W, H - gy);
  const [x0, y0] = project({ x: -z.halfWidth, y: z.y, z: z.top }, W, H);
  const [x1, y1] = project({ x: z.halfWidth, y: z.y, z: z.bottom }, W, H);
  g.strokeStyle = css('--zone'); g.lineWidth = 3; g.strokeRect(x0, y0, x1 - x0, y1 - y0);
  g.lineWidth = 1; g.setLineDash([4, 4]);
  for (let i = 1; i < 3; i++) {
    g.beginPath(); g.moveTo(x0 + ((x1 - x0) * i) / 3, y0); g.lineTo(x0 + ((x1 - x0) * i) / 3, y1); g.stroke();
    g.beginPath(); g.moveTo(x0, y0 + ((y1 - y0) * i) / 3); g.lineTo(x1, y0 + ((y1 - y0) * i) / 3); g.stroke();
  }
  g.setLineDash([]);
  g.beginPath(); g.moveTo(x0, y1); g.lineTo(x0, gy); g.moveTo(x1, y1); g.lineTo(x1, gy); g.stroke();

  // pitcher sprite in the distance
  if (game) {
    const p = game.situation().pitcher;
    const [px, py, pd] = project({ x: 0, y: field.mound.y, z: 0.9 }, W, H);
    const size = (CAM.f * 1.3) / pd;
    const img = sprite(p.slug);
    if (img.complete && img.naturalWidth) g.drawImage(img, px - size / 2, py - size / 2, size, size);
  }
  // human pitch target
  if (humanPitch.target && !pitch) {
    const [tx, ty] = project({ x: ftToM(humanPitch.target.x), y: z.y, z: ftToM(humanPitch.target.z) }, W, H);
    g.strokeStyle = css('--ink'); g.beginPath(); g.moveTo(tx - 7, ty); g.lineTo(tx + 7, ty); g.moveTo(tx, ty - 7); g.lineTo(tx, ty + 7); g.stroke();
  }
  // bat aim ring
  const aim = aimFt ?? (game && humanBatting() ? mouseAim : null);
  if (aim) {
    const [ax, ay] = project({ x: ftToM(aim.x), y: contactDepth, z: ftToM(aim.z) }, W, H);
    g.strokeStyle = '#f2c94c'; g.lineWidth = 2; g.beginPath(); g.arc(ax, ay, 9, 0, Math.PI * 2); g.stroke();
  }
  if (!pitch) return;
  const cut = ev?.swing?.contact ? ev.swing.t : Infinity;
  const tt = Math.min(t ?? Infinity, cut);
  const pts = pitch.samples.filter((s) => s.t <= tt);
  g.strokeStyle = css('--accent'); g.lineWidth = 1.5; g.beginPath();
  pts.forEach((s, i) => { const [x, y] = project(s.pos, W, H); i ? g.lineTo(x, y) : g.moveTo(x, y); });
  g.stroke();
  const last = pts[pts.length - 1];
  if (last) {
    const [bx, by, bd] = project(last.pos, W, H);
    g.fillStyle = css('--ball'); g.strokeStyle = css('--ink'); g.lineWidth = 1;
    g.beginPath(); g.arc(bx, by, Math.max(2.5, (CAM.f * 0.0365) / bd), 0, Math.PI * 2); g.fill(); g.stroke();
  }
  if (ev?.swing) {
    const s = ev.swing;
    const freeze = s.contact ? s.t : s.swing.end;
    if (t == null || t >= s.swing.start) {
      const pose = batPose(s.swing, Math.min(t ?? freeze, freeze));
      const [kx, ky, kd] = project(pose.knob, W, H);
      const [qx, qy] = project(pose.tip, W, H);
      g.strokeStyle = '#f2c94c'; g.lineCap = 'round'; g.lineWidth = Math.max(3, (CAM.f * 0.033) / kd);
      g.beginPath(); g.moveTo(kx, ky); g.lineTo(qx, qy); g.stroke(); g.lineCap = 'butt';
    }
  }
}

function animate(duration, speed, frame) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const tick = () => {
      const t = ((performance.now() - t0) / 1000) * speed;
      frame(Math.min(t, duration));
      if (t < duration) requestAnimationFrame(tick);
      else resolve();
    };
    requestAnimationFrame(tick);
  });
}

async function animatePitch(pitch, ev) {
  const end = ev.swing?.contact ? ev.swing.t + 0.05 : pitch.flightTime + 0.1;
  await animate(end, Number($('pitchSpeed').value), (t) => drawPlate(pitch, t, ev));
}

function animatePitchHuman(pitch) {
  return new Promise((resolve) => {
    let ev = null;
    let simT = 0;
    const speed = Number($('pitchSpeed').value);
    const batter = game.situation().batter;
    $('prompt').innerHTML = 'Swing! <kbd>Space</kbd>';
    humanSwingHandler = () => {
      if (ev) return;
      const aim = mouseAim ?? { x: 0, z: mToFt(field.zone.centerZ) };
      ev = game.resolvePitch({ timing: simT + batter.batter.swingTime, aimFt: aim, type: $('swingType').value });
    };
    const t0 = performance.now();
    const tick = () => {
      simT = ((performance.now() - t0) / 1000) * speed;
      drawPlate(pitch, simT, ev, ev?.swing ? null : mouseAim);
      const end = ev?.swing?.contact ? ev.swing.t + 0.1 : pitch.flightTime + 0.25;
      if (simT < end) return requestAnimationFrame(tick);
      humanSwingHandler = null;
      if (!ev) ev = game.resolvePitch('take');
      resolve(ev);
    };
    requestAnimationFrame(tick);
  });
}
const timingWord = (ms) => (ms == null ? '' : Math.abs(ms) < 4 ? 'on time' : ms < 0 ? `${Math.abs(ms).toFixed(0)} ms early` : `${ms.toFixed(0)} ms late`);

// ---------- field view ----------
const FS = 16.5; // px per meter
const FO = { x: 450, y: 595 };
const P = (p) => [FO.x + p.x * FS, FO.y - p.y * FS];

function drawFieldBase(g, W, H) {
  g.clearRect(0, 0, W, H);
  const path = (pts) => { g.beginPath(); pts.forEach((p, i) => { const [x, y] = P(p); i ? g.lineTo(x, y) : g.moveTo(x, y); }); };
  g.fillStyle = css('--grass');
  path([field.apex, ...field.fenceVertices]); g.closePath(); g.fill();
  // mowing stripes
  g.save(); path([field.apex, ...field.fenceVertices]); g.closePath(); g.clip();
  g.fillStyle = css('--grass2');
  for (let i = -20; i < 20; i += 2) { g.beginPath(); const a = P({ x: i * 2, y: 0 }); g.moveTo(a[0], a[1]); g.lineTo(a[0] + 30, a[1]); g.lineTo(a[0] + 30 + 600, a[1] - 600); g.lineTo(a[0] + 600, a[1] - 600); g.fill(); }
  g.restore();
  const b = field.bases;
  g.fillStyle = css('--dirt');
  path([b.home, b.first, b.second, b.third]); g.closePath(); g.fill();
  { const [x, y] = P(field.mound); g.beginPath(); g.arc(x, y, 14, 0, Math.PI * 2); g.fill(); }
  g.strokeStyle = '#fff'; g.lineWidth = 2;
  for (const pole of [field.foulPoles.left, field.foulPoles.right]) { path([field.apex, pole]); g.stroke(); }
  g.strokeStyle = css('--fence'); g.lineWidth = 6;
  path(field.fenceVertices); g.stroke();
  for (const base of [b.first, b.second, b.third]) {
    const [x, y] = P(base); g.fillStyle = '#fff';
    g.save(); g.translate(x, y); g.rotate(Math.PI / 4); g.fillRect(-6, -6, 12, 12); g.restore();
  }
  { const [x, y] = P(b.home); g.fillStyle = '#fff'; g.fillRect(x - 6, y - 5, 12, 10); }
  { const [x0, y0] = P({ x: -field.zone.halfWidth, y: field.zone.y }); const [x1] = P({ x: field.zone.halfWidth, y: 0 });
    g.strokeStyle = css('--zone'); g.lineWidth = 4; g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y0); g.stroke(); }
}

function drawMon(g, player, pos, side, { size = 44, alpha = 1, label = null } = {}) {
  const [x, y] = P(pos);
  g.globalAlpha = alpha;
  g.fillStyle = 'rgba(0,0,0,0.18)';
  g.beginPath(); g.ellipse(x, y + size * 0.36, size * 0.34, size * 0.12, 0, 0, Math.PI * 2); g.fill();
  g.strokeStyle = css(`--${side}`); g.lineWidth = 2.5;
  g.beginPath(); g.ellipse(x, y + size * 0.36, size * 0.38, size * 0.15, 0, 0, Math.PI * 2); g.stroke();
  const img = sprite(player.slug);
  if (img.complete && img.naturalWidth) g.drawImage(img, x - size / 2, y - size * 0.62, size, size);
  if (label) {
    g.font = '600 11px system-ui'; g.textAlign = 'center';
    g.fillStyle = css('--ink'); g.fillText(label, x, y + size * 0.62);
    g.textAlign = 'left';
  }
  g.globalAlpha = 1;
}

const lerpKeys = (keys, t) => {
  if (t <= keys[0].t) return keys[0].pos;
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i].t) {
      const a = keys[i - 1], b = keys[i];
      const u = b.t > a.t ? (t - a.t) / (b.t - a.t) : 1;
      return { x: a.pos.x + (b.pos.x - a.pos.x) * u, y: a.pos.y + (b.pos.y - a.pos.y) * u };
    }
  }
  return keys[keys.length - 1].pos;
};
const ballAt = (keys, t) => {
  if (!keys.length) return null;
  if (t <= keys[0].t) return keys[0];
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i].t) {
      const a = keys[i - 1], b = keys[i];
      const u = b.t > a.t ? (t - a.t) / (b.t - a.t) : 1;
      return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u, z: a.z + (b.z - a.z) * u };
    }
  }
  return keys[keys.length - 1];
};

function batterSpot(player, pitcherHand) {
  const bats = player.bats === 'S' ? (pitcherHand === 'L' ? 'R' : 'L') : player.bats;
  return { x: bats === 'L' ? 0.9 : -0.9, y: 0.1 };
}

function drawIdle() {
  if (!game) return;
  const c = $('field');
  const g = c.getContext('2d');
  drawFieldBase(g, c.width, c.height);
  const sit = game.situation();
  const def = game.defense();
  for (const d of def) {
    const pos = d.role === 'P' ? { x: 0, y: field.mound.y } : d.pos;
    drawMon(g, d.player, pos, sit.fieldingSide, { label: d.role });
  }
  const bases = [field.bases.first, field.bases.second, field.bases.third];
  sit.bases.forEach((p, i) => { if (p) drawMon(g, p, bases[i], sit.battingSide, { size: 40 }); });
  if (!sit.over) drawMon(g, sit.batter, batterSpot(sit.batter, sit.pitcher.throws), sit.battingSide, { size: 48 });
  drawPlate(null, null, null);
  drawDiamond();
}

async function animatePlay(ev, before) {
  const tl = ev.play.timeline;
  const c = $('field');
  const g = c.getContext('2d');
  const W = c.width, H = c.height;
  const bat = before.battingSide;
  const fld = before.fieldingSide;
  const speed = Number($('playSpeed').value);
  await animate(tl.end + 0.4, speed, (t) => {
    drawFieldBase(g, W, H);
    for (const f of tl.fielders) drawMon(g, f.player, lerpKeys(f.keys, t), fld, { label: f.role });
    for (const r of tl.runners) {
      const gone = (r.out && t > r.outAt + 0.4) || (r.scored && t > r.keys[r.keys.length - 1].t + 0.4);
      if (gone) continue;
      const pos = lerpKeys(r.keys, t);
      const out = r.out && t >= r.outAt;
      drawMon(g, r.player, pos, bat, { size: r.from === 0 ? 46 : 40, alpha: out ? 0.45 : 1, label: out ? 'OUT' : null });
    }
    const b = ballAt(tl.ball, t);
    if (b) {
      const [sx, sy] = P(b);
      g.fillStyle = 'rgba(0,0,0,0.3)'; g.beginPath(); g.ellipse(sx, sy, 4, 2, 0, 0, Math.PI * 2); g.fill();
      const lift = b.z * FS * 0.6;
      const r = 4 + Math.min(6, b.z * 0.35);
      g.fillStyle = css('--ball'); g.strokeStyle = '#333'; g.lineWidth = 1;
      g.beginPath(); g.arc(sx, sy - lift, r, 0, Math.PI * 2); g.fill(); g.stroke();
    }
    // Banner
    g.font = '700 22px system-ui'; g.fillStyle = css('--ink'); g.textAlign = 'center';
    if (t > tl.end * 0.6) g.fillText(bannerFor(ev), W / 2, 34);
    g.textAlign = 'left';
  });
}

function bannerFor(ev) {
  const r = ev.play?.batterResult;
  return { HR: 'HOME RUN!', IPHR: 'INSIDE-THE-PARK HOME RUN!', '1B': 'Single', '2B': 'Double!', '3B': 'Triple!', GDP: 'Double play!', SF: 'Sacrifice fly', ROE: 'Error!', FC: "Fielder's choice", FOUL: 'Foul ball' }[r]
    ?? (ev.play?.outsRecorded ? 'Out!' : '');
}

function drawDiamond() {
  const c = $('diamond');
  const g = c.getContext('2d');
  g.clearRect(0, 0, c.width, c.height);
  const pts = [[45, 60], [70, 35], [45, 10], [20, 35]];
  const bases = game.state.bases;
  g.strokeStyle = css('--muted'); g.lineWidth = 1.5;
  [1, 2, 3].forEach((b) => {
    const [x, y] = pts[b];
    g.save(); g.translate(x, y); g.rotate(Math.PI / 4);
    g.fillStyle = bases[b - 1] ? css('--gold') : 'transparent';
    g.fillRect(-8, -8, 16, 16); g.strokeRect(-8, -8, 16, 16); g.restore();
  });
}

// ---------- panels ----------
function renderAll() {
  renderLinescore();
  renderSituation();
  renderCards();
  renderLog();
  renderBox();
  drawIdle();
}

function renderLinescore() {
  const s = game.summary();
  const n = Math.max(game.rules.innings, s.linescore.away.length);
  const cell = (side, i) => (s.linescore[side][i] ?? (i < s.linescore[side].length ? 0 : ''));
  const isBottomSkipped = (side, i) => side === 'home' && s.over && i === s.linescore.home.length && i < s.linescore.away.length;
  $('linescore').innerHTML = `<tr><th></th>${Array.from({ length: n }, (_, i) => `<th>${i + 1}</th>`).join('')}<th>R</th><th>H</th><th>E</th></tr>` +
    SIDES.map((side) => `<tr><td><span style="color:var(--${side})">●</span> ${game.teams[side].name}</td>${Array.from({ length: n }, (_, i) => `<td>${isBottomSkipped(side, i) ? 'x' : cell(side, i)}</td>`).join('')}<td class="rhe">${s.score[side]}</td><td class="rhe">${s.hits[side]}</td><td class="rhe">${s.errors[side === 'away' ? 'away' : 'home']}</td></tr>`).join('');
}

function renderSituation() {
  const s = game.state;
  $('inningLbl').textContent = s.over ? 'Final' : `${s.half === 'top' ? '▲ Top' : '▼ Bottom'} ${s.inning}`;
  $('countLbl').textContent = s.over ? `${s.score.away}–${s.score.home}` : `${s.balls}-${s.strikes}`;
  $('outsLbl').innerHTML = [0, 1, 2].map((i) => `<span class="${i < s.outs ? 'on' : ''}"></span>`).join('');
}

const statLine = (p) => {
  const l = game.state.box.get(p.id);
  return `${l.h}-for-${l.ab}${l.hr ? `, ${l.hr} HR` : ''}${l.rbi ? `, ${l.rbi} RBI` : ''}${l.bb ? `, ${l.bb} BB` : ''}`;
};

function renderCards() {
  if (!game) return;
  const sit = game.situation();
  const b = sit.batter;
  const p = sit.pitcher;
  const fat = sit.batterFatigue.tired ? ' · <b>tired</b>' : '';
  $('batterCard').innerHTML = `<img src="${b.sprite}" alt=""><div>
    <div class="sub">AT BAT · <span style="color:var(--${sit.battingSide})">${game.teams[sit.battingSide].name}</span></div>
    <div class="name">${b.name}</div>
    <div class="sub">Bats ${b.bats} · ${b.types.join('/')} · today ${statLine(b)}${fat}</div>
    <div class="sub">Bat ${b.batter.batSpeedMph.toFixed(0)} mph · contact ${b.batter.contact.toFixed(2)} · eye ${b.batter.eye.toFixed(2)} · speed ${mToFt(b.batter.runSpeed).toFixed(0)} ft/s</div></div>`;
  const pc = sit.pitchCount;
  const tired = pc > p.pitcher.staminaPitches;
  const pl = game.state.box.get(p.id);
  $('pitcherCard').innerHTML = `<img src="${p.sprite}" alt=""><div>
    <div class="sub">PITCHING · <span style="color:var(--${sit.fieldingSide})">${game.teams[sit.fieldingSide].name}</span></div>
    <div class="name">${p.name}</div>
    <div class="sub">Throws ${p.throws} · ${pc} pitches${tired ? ' · <b>tiring</b>' : ''} · ${Math.floor(pl.outs / 3)}.${pl.outs % 3} IP, ${pl.kPitched} K</div>
    <div class="arsenal">${p.arsenal.map((k) => `<button data-p="${k}" class="${humanPitch.pitch === k ? 'sel' : ''}" ${humanPitching() && !busy ? '' : 'disabled'}>${PITCHES[k].name}</button>`).join('')}</div></div>`;
  $('pitcherCard').querySelectorAll('button').forEach((btn) => btn.addEventListener('click', () => {
    humanPitch.pitch = btn.dataset.p;
    renderCards();
    setPrompt(`${PITCHES[btn.dataset.p].name}: click the plate view to pick a target.`);
  }));
}

function renderLog() {
  const items = game.state.log.slice(-80).reverse();
  $('log').innerHTML = items.map((e) => {
    const cls = e.type === 'half' || e.type === 'final' ? 'half' : e.type === 'in_play' || e.type === 'walk' || e.type === 'strikeout' ? 'big' : '';
    return `<div class="${cls}">${e.text}</div>`;
  }).join('');
}

function renderBox() {
  const s = game.summary();
  $('box').innerHTML = SIDES.map((side) => {
    const team = game.teams[side];
    const posOf = (i) => Object.entries(game.state.positions[side]).find(([, idx]) => idx === i)?.[0] ?? '';
    const bat = team.lineup.map((i) => {
      const p = team.players[i];
      const l = game.state.box.get(p.id);
      return `<tr><td><img src="${p.sprite}" alt=""> ${p.name}</td><td>${posOf(i)}</td><td>${l.ab}</td><td>${l.r}</td><td>${l.h}</td><td>${l.hr}</td><td>${l.rbi}</td><td>${l.bb}</td><td>${l.k}</td><td>${l.e}</td></tr>`;
    }).join('');
    const pit = team.players.filter((p) => game.state.box.get(p.id).pitches > 0).map((p) => {
      const l = game.state.box.get(p.id);
      return `<tr><td><img src="${p.sprite}" alt=""> ${p.name}</td><td>${Math.floor(l.outs / 3)}.${l.outs % 3}</td><td>${l.hAllowed}</td><td>${l.rAllowed}</td><td>${l.bbAllowed}</td><td>${l.kPitched}</td><td>${l.hrAllowed}</td><td>${l.pitches}</td></tr>`;
    }).join('');
    return `<div class="panel"><b style="color:var(--${side})">${team.name}</b>
      <table><tr><th>Batting</th><th>Pos</th><th>AB</th><th>R</th><th>H</th><th>HR</th><th>RBI</th><th>BB</th><th>K</th><th>E</th></tr>${bat}</table>
      <table style="margin-top:8px"><tr><th>Pitching</th><th>IP</th><th>H</th><th>R</th><th>BB</th><th>K</th><th>HR</th><th>P</th></tr>${pit}</table></div>`;
  }).join('');
}

matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => game && renderAll());

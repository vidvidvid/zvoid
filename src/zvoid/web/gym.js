/* The gym: raise creatures (ACE-Step adapters) on your own audio and watch them grow. */
'use strict';

const Gym = { list: [], cur: null, key: '', open: false, mouse: null, raf: 0, timer: 0, fx: {} };
const hash = s => { let x = 2166136261; for (const c of String(s)) { x ^= c.charCodeAt(0); x = Math.imul(x, 16777619); } return (x >>> 0) / 4294967296; };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/* ---------- what the creature is made of ---------- */
function dna(c) {
  const F = c.food || [], n = F.length, w = F.map(f => f.secs || 1), W = w.reduce((a, b) => a + b, 0) || 1;
  const avg = (k, d) => n ? F.reduce((a, f, i) => a + (f[k] ?? d) * w[i], 0) / W : d;
  const H = c.history || [], first = H.length ? H[0][1] : null, last = H.length ? H[H.length - 1][1] : null;
  const tr = c.training && c.training.state === 'running';
  return { n, F, seed: hash(c.slug), minutes: c.minutes || 0, epochs: c.epochs || 0, growth: 1 - Math.exp(-(c.epochs || 0) / 180),
    low: avg('low', .3), mid: avg('mid', .3), high: avg('high', .1), bright: avg('bright', .3), dyn: avg('dyn', .3), noise: avg('noise', .2), bpm: avg('bpm', 70), loud: avg('loud', .3),
    learned: first && last ? clamp((first - last) / first * 3, 0, 1) : 0, training: tr, digesting: tr && c.training.stage !== 'train', step: tr ? c.training.step : 0 };
}
const hueOf = bright => 285 - clamp(bright, 0, 1) * 230;            // dark & bassy = violet, bright = acid yellow-green

/* ---------- the entity ----------
   A rotating 3D organism of light, drawn with additive blending:
   - nested membrane shells (more layers and rings as it trains; chaotic until it has learned)
   - one filament bundle per track it ate, placed on a sphere (colour = brightness, sway = tempo and dynamics)
   - strings vibrate as standing waves; bass, mids and treble orbit as circular waveforms; the core ripples on the beat
   - a tick halo that counts epochs
   - shockwaves when it eats or finishes an epoch, light pulses flowing inward while it trains */
const fxOf = slug => Gym.fx[slug] || (Gym.fx[slug] = { births: {}, waves: [], names: null, epochs: null });
const easeOut = x => 1 - Math.pow(1 - clamp(x, 0, 1), 3);

function stringDirs(c, seed) {
  const F = c.food || [], n = F.length, L = c.limbs && c.limbs.length > 1 ? c.limbs : null, out = new Array(n), lenK = new Array(n).fill(1);
  const fib = (i, m, s0) => { const yy = 1 - 2 * (i + .5) / m, rr = Math.sqrt(1 - yy * yy), ph = i * 2.39996 + s0; return [Math.cos(ph) * rr, yy, Math.sin(ph) * rr]; };
  if (!L) { for (let i = 0; i < n; i++) out[i] = fib(i, n, seed * 6.28); return { out, lenK }; }
  L.forEach((limb, li) => {
    const ax = fib(li, L.length, seed * 6.28); let u = [ax[2], 0, -ax[0]], ul = Math.hypot(u[0], u[2]); if (ul < 1e-3) { u = [1, 0, 0]; ul = 1; } u = u.map(x => x / ul);
    const v = [ax[1] * u[2] - ax[2] * u[1], ax[2] * u[0] - ax[0] * u[2], ax[0] * u[1] - ax[1] * u[0]];
    const mem = []; F.forEach((f, i) => { if ((f.limb || 0) === limb.id) mem.push(i); }); mem.sort((a, b) => (F[a].core || 0) - (F[b].core || 0));
    const m = mem.length, cap = clamp(Math.sqrt(m / n) * 1.5, .2, 1.25);
    mem.forEach((i, j) => { const ct = 1 - (j + .5) / m * (1 - Math.cos(cap)), st = Math.sqrt(1 - ct * ct), az = j * 2.39996, ca = Math.cos(az) * st, sa = Math.sin(az) * st;
      out[i] = [ax[0] * ct + u[0] * ca + v[0] * sa, ax[1] * ct + u[1] * ca + v[1] * sa, ax[2] * ct + u[2] * ca + v[2] * sa]; lenK[i] = 1.22 - .5 * j / m; });   // the most typical track is the spine of its limb
  });
  for (let i = 0; i < n; i++) if (!out[i]) out[i] = [0, 1, 0];
  return { out, lenK };
}

function drawCreature(g, W, H, c, t, mouse, mini) {
  const d = dna(c), fx = fxOf(c.slug), cx = W / 2, cy = H / 2 * (mini ? 1 : .94), S = Math.min(W, H);
  g.clearRect(0, 0, W, H);
  const hue = hueOf(d.bright), hue2 = (hue + 50 + d.seed * 140) % 360;
  const pulse = .5 + .5 * Math.sin(t * d.bpm / 60 * Math.PI * (d.training ? 1.5 : 1));
  const R = S * (d.n ? .08 + .03 * clamp(d.minutes / 30, 0, 1) + .045 * d.growth : .05) * (mini ? 1.7 : 1);
  const yaw = t * .17 * (d.training ? 2.4 : 1) + d.seed * 6 + (mouse && !mini ? (mouse.x - cx) / W * .9 : 0);
  const pitch = .42 + Math.sin(t * .11) * .18 + (mouse && !mini ? (mouse.y - cy) / H * .6 : 0);
  const cyw = Math.cos(yaw), syw = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch), F = S * 1.7;
  const proj = (x, y, z) => { const x1 = x * cyw + z * syw, z1 = -x * syw + z * cyw, y1 = y * cp - z1 * sp, z2 = y * sp + z1 * cp, k = F / (F - z2); return [cx + x1 * k, cy + y1 * k, z2, k]; };
  g.save(); g.globalCompositeOperation = 'lighter'; g.lineCap = 'round'; g.lineJoin = 'round';

  // aura
  const au = g.createRadialGradient(cx, cy, 0, cx, cy, R * (d.n ? 5 : 3));
  au.addColorStop(0, `hsla(${hue},95%,55%,${(.1 + pulse * .07) * (d.training ? 1.6 : 1)})`); au.addColorStop(.4, `hsla(${hue2},95%,45%,.035)`); au.addColorStop(1, 'hsla(0,0%,0%,0)');
  g.fillStyle = au; g.fillRect(0, 0, W, H);

  // dust: drifts around it, streams inward while training
  if (!mini) for (let i = 0; i < 70; i++) {
    const a = i * 2.39996 + t * (.05 + (i % 7) * .01), life = d.training ? ((t * (.16 + (i % 5) * .03) + i * .137) % 1) : .5 + .5 * Math.sin(t * .2 + i),
      rr = R * (d.training ? 6.5 - life * 5.6 : 3 + life * 3.5), yy = Math.sin(i * 12.9898) * R * 2.2 * (d.training ? 1 - life * .8 : 1);
    const p = proj(Math.cos(a) * rr, yy, Math.sin(a) * rr);
    g.fillStyle = `hsla(${(hue2 + i * 11) % 360},95%,75%,${(d.training ? life : .25 + .2 * life) * clamp(.6 + p[2] / (R * 6), .15, 1)})`;
    g.beginPath(); g.arc(p[0], p[1], (d.training ? .6 + life * 1.6 : .8) * p[3], 0, 7); g.fill();
  }

  // halo: one tick per epoch, in rings of 180
  if (!mini && (d.epochs || d.training)) {
    const rings = Math.min(3, Math.ceil(Math.max(1, d.epochs) / 180));
    for (let r = 0; r < rings; r++) {
      const Rh = R * (3.3 + r * .55) + (d.n > 80 ? R * 1.2 : 0), n = Math.min(180, d.epochs - r * 180), spin = t * (.05 + r * .02) * (r % 2 ? 1 : -1);
      for (let j = 0; j < n; j++) {
        const a = j / 180 * Math.PI * 2 + spin, big = j % 10 === 0, a0 = proj(Math.cos(a) * Rh, 0, Math.sin(a) * Rh), a1 = proj(Math.cos(a) * (Rh + R * (big ? .26 : .1)), 0, Math.sin(a) * (Rh + R * (big ? .26 : .1)));
        g.strokeStyle = `hsla(${(hue2 + j * .6) % 360},90%,${big ? 80 : 65}%,${clamp(.5 + a0[2] / (Rh * 2), .08, .9) * (big ? .9 : .5)})`; g.lineWidth = big ? 1.3 : .8;
        g.beginPath(); g.moveTo(a0[0], a0[1]); g.lineTo(a1[0], a1[1]); g.stroke();
      }
      if (d.training && r === rings - 1) { const a = t * 1.7, p = proj(Math.cos(a) * Rh, 0, Math.sin(a) * Rh); g.fillStyle = '#fff'; g.beginPath(); g.arc(p[0], p[1], 2.6 * p[3], 0, 7); g.fill(); }
    }
  }

  // filaments: one bundle per track, spread over a sphere
  const n = d.n, stride = Math.max(1, Math.ceil(n / 480)), strands = mini ? 1 : n > 140 ? 1 : n > 45 ? 2 : 3, segs = mini ? 9 : n > 220 ? 11 : n > 70 ? 15 : 22;
  const lenBase = R * (1.1 + (.45 + d.growth * 1.9)) * (n > 80 ? 1.25 : 1);
  const reach = Math.min(1, (S * (mini ? .46 : .43) - R) / (lenBase * 1.75));
  const dkey = n + '|' + (c.limbs || []).map(l => l.count).join(',');
  if (fx.dkey !== dkey) { fx.dkey = dkey; fx.dirs = stringDirs(c, d.seed); }
  for (let i = 0; i < n; i += stride) {
    const f = d.F[i], born = fx.births[f.name], grow = born == null ? 1 : easeOut((t - born) / 1.8); if (grow <= 0) continue;
    const [dx, dy, dz] = fx.dirs.out[i];
    let ux = dz, uy = 0, uz = -dx; const ul = Math.hypot(ux, uz) || 1; ux /= ul; uz /= ul; if (ul < 1e-3) { ux = 1; uz = 0; }
    const vx = dy * uz - dz * uy, vy = dz * ux - dx * uz, vz = dx * uy - dy * ux;
    const len = lenBase * clamp(.5 + Math.sqrt((f.secs || 30) / 150), .6, 1.5) * fx.dirs.lenK[i] * grow * reach, amp = R * (.05 + (f.dyn ?? .3) * .2) * (d.training ? 1.5 : 1), spd = (f.bpm ?? 100) / 60 * (d.training ? 2.8 : 1.1);
    const h1 = 1 + Math.round(clamp((f.bpm ?? 100) / 60, 1, 3)), vib = (f.bpm ?? 100) / 60 * (d.training ? 9 : 5);
    const th = hueOf(f.bright ?? .3), thick = .55 + (f.low ?? .3) * 1.3;
    const at = (u, s) => { const ph = s * 2.094 + i, e1 = Math.sin(u * Math.PI * (h1 + .5)) * amp * Math.sin(t * vib + ph), e2 = Math.sin(u * Math.PI * (h1 * 2 + 1.5)) * amp * .45 * Math.cos(t * vib * 1.31 + ph * 1.7),
      sway = Math.sin(t * .35 + i * 1.3) * R * .22 * u * u, a1 = e1 + sway, r0 = R * .92 + len * u;
      return proj(dx * r0 + ux * a1 + vx * e2, dy * r0 + uy * a1 + vy * e2, dz * r0 + uz * a1 + vz * e2); };
    let tip, front = .5;
    for (let s = 0; s < strands; s++) {
      g.beginPath();
      for (let k = 0; k <= segs; k++) { const p = at(k / segs, s); k ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]); if (k === segs) { if (!s) tip = p; front = clamp(.55 + p[2] / (2.2 * (R + len)), .12, 1); } }
      const alpha = front * (.3 + d.growth * .5) * (born != null && grow < 1 ? 1.6 : 1) * (s ? .7 : 1);
      const lw = (s ? .7 : 1.25) * thick * (mini ? .6 : 1) * (tip ? tip[3] : 1);
      if (!s && !mini && n <= 90) { g.strokeStyle = `hsla(${th},96%,60%,${clamp(alpha * .16, 0, 1)})`; g.lineWidth = lw * 5; g.stroke(); }
      g.strokeStyle = `hsla(${th + s * 22},96%,${60 + s * 7}%,${clamp(alpha, 0, 1)})`; g.lineWidth = lw; g.stroke();
    }
    if (tip) {
      g.fillStyle = `hsla(${th + 35},100%,82%,${clamp(front * (.5 + d.growth * .5) + (grow < 1 ? .5 : 0), 0, 1)})`; g.beginPath(); g.arc(tip[0], tip[1], (mini ? .8 : 1 + thick * 1.1 + (grow < 1 ? 3 * (1 - grow) : 0)) * tip[3], 0, 7); g.fill();
      if (!mini && (n <= 160 || i % 3 === 0)) {                    // a bead of light running along it: inward while training
        const u = d.training ? 1 - ((t * spd * .22 + i * .37) % 1) : ((t * .1 + i * .61) % 1), p = at(u * grow > 0 ? u : 0, 0);
        g.fillStyle = `hsla(${th + 20},100%,90%,${front * (d.training ? .95 : .45)})`; g.beginPath(); g.arc(p[0], p[1], (d.training ? 2 : 1.2) * p[3], 0, 7); g.fill();
      }
    }
  }

  // band rings: bass, mids and treble as three orbiting circular waveforms
  if (d.n && !mini) [[d.low, 4, .5, 305, 1.6], [d.mid, 13, 1.4, 182, 2.0], [d.high, 41, 3.2, 72, 2.35]].forEach(([e, k, spd, bh, rad], bi) => {
    const A = clamp(.025 + Math.sqrt(e) * .16, .025, .2) * (d.training ? 1.6 : 1), tilt = bi * 1.05 + d.seed * 3, ct = Math.cos(tilt), stl = Math.sin(tilt), Rb = R * rad * (n > 80 ? 1.5 : 1), dir = bi % 2 ? -1 : 1;
    g.beginPath();
    for (let q = 0; q <= 180; q++) { const a = q / 180 * Math.PI * 2, w = Math.sin(k * a + t * spd * dir) * (.6 + .4 * Math.sin(a * 2 - t * .5)) + .3 * Math.sin((k * 2 + 1) * a - t * spd * 1.7), r = Rb * (1 + A * w), x = Math.cos(a) * r, z = Math.sin(a) * r, p = proj(x, z * stl, z * ct); q ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]); }
    g.strokeStyle = `hsla(${bh},96%,68%,${(.22 + .55 * Math.sqrt(e)) * (.5 + .5 * d.growth + (d.training ? .3 : 0))})`; g.lineWidth = 1.1; g.stroke();
  });

  // membranes: nested shells that wobble with the bass and ripple with the treble
  const layers = mini ? 1 : 1 + Math.min(4, Math.floor(Math.log2(d.epochs + 1) / 1.6)), rings = mini ? 5 : 6 + Math.round(d.growth * 9), pts = mini ? 26 : 60;
  const lowA = .06 + d.low * .2, highA = clamp(d.high * 1.2 + d.noise * .05, .012, .2), kH = 5 + Math.round(d.seed * 5);
  const chaos = (d.n ? (1 - d.learned) * (d.epochs ? .07 : .11) : .03) + (d.digesting ? .06 : 0);
  if (d.n) for (let l = 0; l < layers; l++) {
    const Rl = R * (.5 + .2 * l) * (1 + (.03 + d.dyn * .05) * pulse * (l % 2 ? 1 : -1)), spin = t * (.22 + .13 * l) * (l % 2 ? 1 : -1) * (d.training ? 2 : 1);
    const def = (lat, lon, j) => 1 + lowA * Math.sin(2 * lon + spin + d.seed * 9) * Math.cos(lat) + lowA * .5 * Math.sin(lat * 6 + t * .4 + l)
      + highA * Math.sin(kH * lon - spin * 2 + j) * Math.cos(lat) + chaos * Math.sin(lon * 17 + t * 7 + j * 3 + l) * Math.sin(lat * 9 - t * 5);
    for (let j = 0; j < rings; j++) {
      const lat = -1.32 + 2.64 * (j + .5) / rings, cl = Math.cos(lat), sl = Math.sin(lat); let zs = 0;
      g.beginPath();
      for (let q = 0; q <= pts; q++) { const lon = q / pts * Math.PI * 2, r = Rl * def(lat, lon, j), p = proj(r * cl * Math.cos(lon + spin), r * sl, r * cl * Math.sin(lon + spin)); q ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]); zs += p[2]; }
      g.strokeStyle = `hsla(${(hue + l * 30 + j * 4) % 360},96%,${58 + l * 6}%,${(mini ? .5 : .2 + .1 * l) * (.55 + d.growth * .45)})`; g.lineWidth = mini ? .7 : .9; g.stroke();
    }
    if (!mini && l === layers - 1) for (let m = 0; m < 9; m++) {  // meridians on the outer shell
      const lon = m / 9 * Math.PI * 2; g.beginPath();
      for (let q = 0; q <= 28; q++) { const lat = -1.32 + 2.64 * q / 28, r = Rl * def(lat, lon, q), p = proj(r * Math.cos(lat) * Math.cos(lon + spin), r * Math.sin(lat), r * Math.cos(lat) * Math.sin(lon + spin)); q ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]); }
      g.strokeStyle = `hsla(${hue2},95%,70%,${.1 + d.growth * .16})`; g.lineWidth = .7; g.stroke();
    }
  }

  // nucleus
  const ng = g.createRadialGradient(cx, cy, 0, cx, cy, R * (d.n ? .95 : 1.6));
  ng.addColorStop(0, `hsla(${hue2},100%,88%,${.55 + .4 * pulse})`); ng.addColorStop(.22, `hsla(${hue},100%,62%,.4)`); ng.addColorStop(1, 'hsla(0,0%,0%,0)');
  g.fillStyle = ng; g.beginPath(); g.arc(cx, cy, R * (d.n ? .95 : 1.6), 0, 7); g.fill();
  if (!d.n) { g.strokeStyle = `hsla(${hue},80%,70%,${.25 + pulse * .3})`; g.lineWidth = 1; g.setLineDash([2, 6]); g.beginPath(); g.ellipse(cx, cy, R * 1.1, R * 1.1 * Math.abs(sp) + 2, 0, 0, 7); g.stroke(); g.setLineDash([]); }

  // resonant core: ripples leave the centre on the beat, sharper the more it has learned
  if (d.n && !mini) for (let k = 0; k < 4; k++) {
    const u = (t * d.bpm / 60 * .5 + k / 4) % 1;
    g.strokeStyle = `hsla(${hue2},100%,82%,${(1 - u) * (.14 + .6 * d.learned)})`; g.lineWidth = .8 + (1 - u) * 1.2;
    g.beginPath(); g.ellipse(cx, cy, R * .9 * u + 1, (R * .9 * u + 1) * (Math.abs(sp) * .8 + .2), 0, 0, 7); g.stroke();
  }

  // shockwaves: eating a track, finishing an epoch
  fx.waves = fx.waves.filter(w => t - w.t0 < (w.soft ? 1.6 : 2.6));
  if (!mini) for (const w of fx.waves) {
    const age = t - w.t0; if (age < 0) continue; const dur = w.soft ? 1.6 : 2.6, u = age / dur, rx = R * (1 + easeOut(u) * (w.soft ? 4.5 : 8));
    g.strokeStyle = `hsla(${w.hue},100%,75%,${(1 - u) * (w.soft ? .45 : .9)})`; g.lineWidth = (w.soft ? 1.2 : 2.4) * (1 - u) + .4;
    g.beginPath(); g.ellipse(cx, cy, rx, rx * (Math.abs(sp) * .9 + .12), 0, 0, 7); g.stroke();
    if (!w.soft && u < .25) { g.fillStyle = `hsla(${w.hue},100%,80%,${(.25 - u) * 1.6})`; g.beginPath(); g.arc(cx, cy, R * 1.6, 0, 7); g.fill(); }
  }
  g.restore();
}

/* notice what changed since the last look, so new tracks sprout and epochs ripple */
function gymFx(c) {
  const fx = fxOf(c.slug), now = performance.now() / 1000;
  if (fx.names) { let k = 0; for (const f of c.food) if (!fx.names.has(f.name)) { fx.births[f.name] = now + k * .16; fx.waves.push({ t0: now + k * .16, hue: hueOf(f.bright ?? .3) }); k++; } }
  fx.names = new Set(c.food.map(f => f.name));
  if (fx.epochs != null && c.epochs > fx.epochs) fx.waves.push({ t0: now, hue: hueOf(dna(c).bright), soft: true });
  fx.epochs = c.epochs;
}

/* ---------- screen ---------- */
const gymEl = () => $('#gym');
async function openGym(slug) {
  Gym.open = true; gymEl().hidden = false; openDrawer(null);
  await gymLoad(slug); clearInterval(Gym.timer); Gym.timer = setInterval(gymPoll, 1000);
  cancelAnimationFrame(Gym.raf); gymFrame();
}
function closeGym() {
  Gym.open = false; gymEl().hidden = true; clearInterval(Gym.timer); cancelAnimationFrame(Gym.raf);
  refreshEngines().then(() => Object.values(S.nodes).filter(n => n.type === 'ace_step' && !/running|waiting/.test((R[n.id] || {}).state || '')).forEach(renderNode));
}
async function gymLoad(slug) {
  Gym.list = await api('/api/gym');
  Gym.cur = Gym.list.find(c => c.slug === (slug || (Gym.cur && Gym.cur.slug))) || Gym.list[Gym.list.length - 1] || null;
  Gym.key = ''; gymRender();
}
async function gymPoll() {
  if (!Gym.open || !Gym.cur) return;
  try { const c = await api('/api/gym/' + Gym.cur.slug); if (Gym.cur && c.slug === Gym.cur.slug) { Gym.cur = c; const i = Gym.list.findIndex(x => x.slug === c.slug); if (i >= 0) Gym.list[i] = c; gymRender(); } } catch {}
}
function gymFrame() {
  if (!Gym.open) return;
  const t = performance.now() / 1000;
  const cv = $('#gym-canvas');
  if (cv) {
    const d = devicePixelRatio || 1, w = cv.clientWidth, hh = cv.clientHeight;
    if (cv.width !== Math.round(w * d)) { cv.width = Math.round(w * d); cv.height = Math.round(hh * d); }
    const g = cv.getContext('2d'); g.setTransform(d, 0, 0, d, 0, 0);
    if (Gym.cur) drawCreature(g, w, hh, Gym.cur, t, Gym.mouse); else g.clearRect(0, 0, w, hh);
    const bl = $('#gym-bloom'); if (bl) { if (bl.width !== Math.round(w / 2)) { bl.width = Math.round(w / 2); bl.height = Math.round(hh / 2); } const b = bl.getContext('2d'); b.clearRect(0, 0, bl.width, bl.height); b.drawImage(cv, 0, 0, bl.width, bl.height); }
  }
  document.querySelectorAll('canvas.mini-creature').forEach(m => {
    const c = Gym.list.find(x => x.slug === m.dataset.slug); if (!c) return;
    const g = m.getContext('2d'); if (m.width !== 112) { m.width = 112; m.height = 112; } g.setTransform(2, 0, 0, 2, 0, 0); drawCreature(g, 56, 56, c, t, null, true);
  });
  Gym.raf = requestAnimationFrame(gymFrame);
}
const dur = s => s < 90 ? Math.max(1, Math.round(s)) + 's' : s < 5400 ? Math.round(s / 60) + ' min' : (s / 3600).toFixed(1) + ' h';
const stageName = c => !c.food.length ? 'seed' : !c.epochs ? 'dormant' : c.epochs < 60 ? 'awakening' : c.epochs < 250 ? 'forming' : c.epochs < 800 ? 'ascendant' : 'ancient';

function gymRender() {
  Gym.list.forEach(gymFx); if (Gym.cur) gymFx(Gym.cur);
  const c = Gym.cur, tr = c && c.training, running = !!(tr && /running|stopping/.test(tr.state));
  const key = JSON.stringify([Gym.list.map(x => [x.slug, x.food.length, x.epochs, x.trained]), c && c.slug, c && c.food.map(f => f.name), running, c && c.trained]);
  if (key !== Gym.key) { Gym.key = key; gymBuild(); }
  if (!c) return;
  $('#gym-stats').textContent = `${stageName(c)} · ate ${c.food.length} track${c.food.length === 1 ? '' : 's'} (${c.minutes} min) · trained ${c.epochs} epoch${c.epochs === 1 ? '' : 's'}` + (c.history.length ? ` · loss ${c.history[c.history.length - 1][1].toFixed(3)}` : '');
  const st = $('#gym-status');
  st.textContent = tr ? (tr.state === 'error' ? '✖ ' + tr.error : tr.msg) : (c.trained ? 'usable now: pick it in an ace-step module as “creature”.' : c.food.length ? 'fed, not trained yet.' : 'hungry. drop audio on it.');
  st.className = tr && tr.state === 'error' ? 'err' : '';
  const bar = $('#gym-bar i'); if (bar) bar.style.width = running && tr.max_epochs ? clamp((tr.epoch - tr.from_epoch) / Math.max(1, tr.max_epochs - tr.from_epoch) * 100, 2, 100) + '%' : '0';
  if (running && tr.stage === 'train' && c.pace && tr.audio_secs) st.textContent += ` · about ${dur((tr.max_epochs - tr.epoch) * (c.pace * tr.audio_secs + tr.tracks * .1))} left`;
  const sp = $('#gym-spark'); if (sp) spark(sp, c.history.map(h => h[1]));
}
function spark(cv, vals) {
  const d = devicePixelRatio || 1, w = cv.clientWidth, hh = cv.clientHeight; cv.width = w * d; cv.height = hh * d;
  const g = cv.getContext('2d'); g.setTransform(d, 0, 0, d, 0, 0); g.clearRect(0, 0, w, hh);
  if (vals.length < 2) { g.fillStyle = '#4d4a66'; g.font = '10px ui-monospace, Menlo'; g.fillText('loss curve appears while it trains', 8, hh / 2 + 3); return; }
  const k = Math.max(1, Math.floor(vals.length / 12)), sm = vals.map((_, i) => { const a = vals.slice(Math.max(0, i - k), i + 1); return a.reduce((x, y) => x + y, 0) / a.length; });
  const mn = Math.min(...sm), mx = Math.max(...sm), X = i => 4 + i / (vals.length - 1) * (w - 8), Y = v => 4 + (1 - (v - mn) / (mx - mn || 1)) * (hh - 8);
  g.strokeStyle = '#3a3a5c'; g.lineWidth = 1; g.beginPath(); vals.forEach((v, i) => { const y = Y(clamp(v, mn, mx)); i ? g.lineTo(X(i), y) : g.moveTo(X(i), y); }); g.stroke();
  const gr = g.createLinearGradient(0, 0, w, 0); gr.addColorStop(0, '#ff2d9b'); gr.addColorStop(.5, '#a43cff'); gr.addColorStop(1, '#2ee6d6');
  g.strokeStyle = gr; g.lineWidth = 2; g.shadowColor = '#a43cff'; g.shadowBlur = 8; g.beginPath(); sm.forEach((v, i) => i ? g.lineTo(X(i), Y(v)) : g.moveTo(X(i), Y(v))); g.stroke();
}
async function gymDo(fn) { try { const r = await fn(); if (r && r.slug) { Gym.cur = r; } await gymLoad(Gym.cur && Gym.cur.slug); } catch (e) { toast(String(e.message || e), true); } }
async function gymFeedFiles(files) {
  if (!Gym.cur) return toast('hatch a creature first', true);
  for (const f of files) { $('#gym-status').textContent = 'eating ' + f.name + '…'; await gymDo(() => api(`/api/gym/${Gym.cur.slug}/feed?name=` + encodeURIComponent(f.name), { method: 'POST', body: f })); }
}

function gymBuild() {
  const c = Gym.cur, tr = c && c.training, running = !!(tr && /running|stopping/.test(tr.state)), el = gymEl();
  const nameIn = h('input', { placeholder: 'name a new creature', spellcheck: 'false', onkeydown: e => { if (e.key === 'Enter') hatchB.click(); e.stopPropagation(); } });
  const hatchB = h('button', { class: 'hot', onclick: () => { const v = nameIn.value.trim(); if (v) gymDo(() => api('/api/gym', { json: { name: v } })); } }, 'hatch');
  const left = h('div', { id: 'gym-left' },
    h('div', { class: 'drawer-head' }, h('span', {}, 'gym'), h('button', { onclick: closeGym, title: 'Back to the canvas (esc)' }, '← canvas')),
    h('p', { class: 'gym-note' }, 'A creature is a small adapter for ACE-Step that learns your sound. Feed it your tracks, train it, then pick it inside any ace-step module.'),
    h('div', { class: 'gym-list' }, Gym.list.map(x => h('button', { class: 'creature-row' + (c && x.slug === c.slug ? ' cur' : ''), onclick: () => { Gym.cur = x; Gym.key = ''; gymRender(); } },
      h('canvas', { class: 'mini-creature', data: { slug: x.slug } }), h('span', {}, h('b', {}, x.name), h('small', {}, `${stageName(x)} · ${x.food.length} tracks · ${x.epochs} ep`))))),
    h('div', { class: 'gym-new' }, nameIn, hatchB));

  const stage = h('div', { id: 'gym-stage' }, h('canvas', { id: 'gym-bloom' }), h('canvas', { id: 'gym-canvas' }),
    c ? h('div', { id: 'gym-caption' }, h('h1', {}, c.name), h('div', { id: 'gym-stats' })) : h('div', { id: 'gym-caption' }, h('h1', {}, 'no creatures yet'), h('div', {}, 'name one on the left and press hatch')));
  stage.addEventListener('mousemove', e => { const r = stage.getBoundingClientRect(); Gym.mouse = { x: e.clientX - r.left, y: e.clientY - r.top }; });
  stage.addEventListener('mouseleave', () => { Gym.mouse = null; });

  const right = h('div', { id: 'gym-right' });
  if (c) {
    const saveId = () => api('/api/gym/' + c.slug, { method: 'PUT', json: { style: style.value, tag: tag.value } }).then(r => { Gym.cur = r; });
    const style = h('textarea', { rows: 2, spellcheck: 'false', placeholder: 'describe its sound in tags: dub techno, 120 bpm, tape hiss, deep chords', onchange: saveId }); style.value = c.style || '';
    const tag = h('input', { spellcheck: 'false', onchange: saveId }); tag.value = c.tag || '';
    const ep = h('input', { type: 'number', min: 1, max: 5000, step: 10, value: 100 }), rank = h('select', {}, [8, 16, 32, 64, 128].map(v => h('option', { value: v }, 'rank ' + v))); rank.value = (c.settings && c.settings.rank) || 64;
    const lr = h('select', {}, [['5e-5', 'gentle'], ['1e-4', 'normal'], ['2e-4', 'fast'], ['5e-4', 'reckless']].map(([v, l]) => h('option', { value: v }, `${l} (${v})`))); lr.value = '1e-4';
    const maxd = h('input', { type: 'number', min: 10, max: 600, step: 10, value: 240 });
    const maxT = h('input', { type: 'number', min: 0, max: 5000, step: 5, value: c.food.length > 60 ? 40 : 0 });
    const estEl = h('div', { class: 'gym-est' });
    const est = () => {
      const budget = +maxT.value || 0, fs = budget && budget < c.food.length ? c.food.slice().sort((a, b) => (a.core || 0) - (b.core || 0)).slice(0, budget) : c.food;
      const audio = fs.reduce((a, f) => a + Math.min(f.secs || 0, +maxd.value || 240), 0), per = audio * (c.pace || .07) + fs.length * .1, eps = +ep.value || 0;
      estEl.replaceChildren(h('b', {}, `≈ ${dur(per)} per epoch · ≈ ${dur(per * eps)} for ${eps} epochs`), h('br'),
        `${fs.length} track${fs.length === 1 ? '' : 's'} · ${Math.round(audio / 60)} min of audio per epoch. ` + (c.pace ? 'Timed on this Mac.' : 'A rough guess until the first epoch has been timed.') + ' More tracks or longer tracks = slower epochs.');
    };
    [ep, maxd, maxT].forEach(i => i.addEventListener('input', est)); est();
    const go = fresh => { Gym.more = +ep.value || 100; gymDo(() => api(`/api/gym/${c.slug}/train`, { json: { epochs: Gym.more, rank: +rank.value, lr: +lr.value, max_duration: +maxd.value, max_tracks: +maxT.value || 0, fresh } })); };
    right.append(
      h('h3', {}, 'food'),
      h('div', { class: 'food' }, c.food.length ? c.food.map(f => {
        const cap = h('input', { spellcheck: 'false', placeholder: 'caption for this track (optional)', onchange: () => api('/api/gym/' + c.slug, { method: 'PUT', json: { captions: { [f.name]: cap.value } } }) }); cap.value = f.caption || '';
        return h('div', { class: 'food-row', style: `--c:hsl(${hueOf(f.bright ?? .3)},90%,60%)` }, h('i'), h('div', {}, h('b', { title: f.name }, f.name), h('small', {}, `${Math.round(f.secs)}s · ~${Math.round(f.bpm || 0)} bpm · bass ${Math.round((f.low || 0) * 100)}% · bright ${Math.round((f.bright || 0) * 100)}%`), cap),
          h('button', { title: 'Take this track away', disabled: running, onclick: () => gymDo(() => api(`/api/gym/${c.slug}/food/${encodeURIComponent(f.name)}`, { method: 'DELETE' })) }, '×'));
      }) : h('p', { class: 'gym-note' }, 'Nothing yet. Drop audio files anywhere on this screen.')),
      h('div', { class: 'acts' }, h('button', { disabled: running, onclick: () => { const i = $('#gym-pick'); i.value = ''; i.click(); } }, '+ feed files…'), h('button', { disabled: running, title: 'Pick a folder. Tracks are linked where they are, not copied.', onclick: gymPickFolder }, '+ feed a folder…')),
      ...((c.limbs || []).length > 1 ? [h('h3', {}, 'limbs'),
        h('p', { class: 'gym-note' }, 'Tracks that sound alike grow together as one limb. Each limb learns its own word: put it in a caption to call that side of the creature.'),
        h('div', { class: 'limbs' }, c.limbs.map(l => h('div', { class: 'limb-row', style: `--c:hsl(${hueOf(l.mean.bright)},90%,60%)` }, h('i'), h('span', {}, l.tags.join(' · ')), h('small', {}, l.count + ' tracks'), h('code', { title: 'The trigger word of this limb' }, l.trigger))))] : []),
      h('h3', {}, 'identity'),
      h('label', { title: 'Used as the caption for every track that has no caption of its own. Good tags make a much better creature.' }, h('span', {}, 'its sound, in tags'), style),
      h('label', { title: 'A made-up word the model learns to associate with this sound. Zvoid adds it to your caption automatically when the creature is active.' }, h('span', {}, 'trigger word'), tag),
      h('h3', {}, 'training'),
      h('div', { class: 'gym-grid' },
        h('label', { title: 'How many more passes over the food. 100–300 is a good first session for 10–30 tracks.' }, h('span', {}, 'epochs to add'), ep),
        h('label', { title: 'Capacity of the adapter. Higher learns more detail but can memorise.' }, h('span', {}, 'capacity'), rank),
        h('label', { title: 'How big each learning step is.' }, h('span', {}, 'learning rate'), lr),
        h('label', { title: 'Longer tracks are cut to this many seconds.' }, h('span', {}, 'max seconds / track'), maxd),
        h('label', { style: 'grid-column:1/-1', title: 'Keeps epochs fast on big collections: trains on the most typical tracks of every limb, in proportion. 0 = use every track.' }, h('span', {}, 'train on at most this many tracks (0 = all)'), maxT)),
      estEl,
      h('div', { id: 'gym-bar' }, h('i')),
      h('canvas', { id: 'gym-spark' }),
      h('div', { id: 'gym-status' }),
      h('div', { class: 'acts' },
        running ? h('button', { class: 'stop', onclick: () => api(`/api/gym/${c.slug}/stop`, { method: 'POST' }).then(gymPoll) }, '■ stop')
          : h('button', { class: 'hot', disabled: !c.food.length, onclick: () => go(false) }, c.epochs ? 'train more ▸' : 'train ▸'),
        !running && c.epochs ? h('button', { title: 'Forget everything it learned and train again from zero', onclick: () => { if (confirm(`Erase what “${c.name}” has learned and start over? Its food stays.`)) go(true); } }, 'start over') : null,
        !running ? h('button', { class: 'danger', onclick: () => { if (confirm(`Release “${c.name}” for good? This deletes its food copies and everything it learned.`)) gymDo(async () => { await api('/api/gym/' + c.slug, { method: 'DELETE' }); Gym.cur = null; }); } }, 'release') : null),
      h('p', { class: 'gym-note' }, 'Training uses the Apple GPU and pauses the ace-step module. Stopping keeps the last checkpoint (saved every 5 epochs).'));
  }
  const keepPicker = $('#gym-picker'); if (keepPicker) stage.append(keepPicker);
  el.replaceChildren(left, stage, right, h('input', { id: 'gym-pick', type: 'file', multiple: true, accept: 'audio/*,.wav,.mp3,.flac,.aiff,.aif,.ogg,.m4a', hidden: true, onchange: e => gymFeedFiles([...e.target.files]) }));
}

/* ---------- feed a whole folder: scan, choose, link (no copies) ---------- */
async function gymPickFolder() {
  if (!Gym.cur) return toast('hatch a creature first', true);
  let path; try { path = (await api('/api/pick_folder', { method: 'POST' })).path; } catch (e) { return toast(String(e.message || e), true); }
  if (!path) return;
  $('#gym-status').textContent = 'looking through the folder…';
  let res; try { res = await api('/api/gym_scan', { json: { path } }); } catch (e) { return toast(String(e.message || e), true); }
  if (!res.files.length) return toast('no audio found in that folder', true);
  gymFolderPicker(res);
}
function gymFolderPicker(res) {
  const fmt = s => s == null ? '?' : s >= 60 ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}` : Math.round(s) + 's';
  const minIn = h('input', { type: 'number', min: 0, step: 5, value: 30, style: 'width:70px' }), filt = h('input', { placeholder: 'filter by name…', spellcheck: 'false' });
  const list = h('div', { class: 'pick-list' }), sum = h('div', { class: 'pick-sum' }), feedB = h('button', { class: 'hot' }, 'feed');
  const chosen = new Set();
  const visible = () => res.files.filter(f => (f.secs == null || f.secs >= (+minIn.value || 0)) && f.rel.toLowerCase().includes(filt.value.toLowerCase()));
  const update = () => { const sel = res.files.filter(f => chosen.has(f.path)), mins = sel.reduce((a, f) => a + Math.min(f.secs || 0, 240), 0) / 60;
    sum.textContent = `${sel.length} of ${res.files.length} selected · ${Math.round(mins)} min of audio · ≈ ${dur(mins * 60 * ((Gym.cur && Gym.cur.pace) || .07) + sel.length * .1)} per training epoch if you train on all of them`;
    feedB.textContent = `feed ${sel.length} track${sel.length === 1 ? '' : 's'}`; feedB.disabled = !sel.length; };
  const draw = () => {
    const vis = visible(), groups = [...new Set(vis.map(f => f.group))];
    list.replaceChildren(...groups.map(gname => {
      const fs = vis.filter(f => f.group === gname), all = fs.every(f => chosen.has(f.path));
      const gcb = h('input', { type: 'checkbox' }); gcb.checked = all; gcb.onchange = () => { fs.forEach(f => gcb.checked ? chosen.add(f.path) : chosen.delete(f.path)); draw(); };
      return h('div', { class: 'pick-group' }, h('label', { class: 'pick-head' }, gcb, h('b', {}, gname || '(top level)'), h('small', {}, fs.length + ' files')),
        fs.map(f => { const cb = h('input', { type: 'checkbox' }); cb.checked = chosen.has(f.path); cb.onchange = () => { cb.checked ? chosen.add(f.path) : chosen.delete(f.path); update(); };
          return h('label', { class: 'pick-row', title: f.rel }, cb, h('span', {}, gname ? f.rel.slice(gname.length + 1) : f.rel), h('small', {}, `${fmt(f.secs)} · ${f.mb} MB`)); }));
    }));
    update();
  };
  minIn.oninput = filt.oninput = draw;
  const box = h('div', { id: 'gym-picker' },
    h('div', { class: 'drawer-head' }, h('span', {}, res.name), h('button', { onclick: () => box.remove() }, '×')),
    h('p', { class: 'gym-note' }, `Found ${res.files.length} audio files. Tick the finished tracks that sound like the creature you want. Loops, stems and one-shots teach it less. Files are linked where they are, not copied.`),
    h('div', { class: 'pick-tools' }, h('label', {}, h('span', {}, 'hide shorter than (s)'), minIn), filt,
      h('button', { onclick: () => { visible().forEach(f => chosen.add(f.path)); draw(); } }, 'all shown'), h('button', { onclick: () => { chosen.clear(); draw(); } }, 'none')),
    list, sum,
    h('div', { class: 'acts' }, feedB, h('button', { onclick: () => box.remove() }, 'cancel')));
  feedB.onclick = async () => {
    const paths = [...chosen]; feedB.disabled = true; let skipped = []; box.classList.add('eating');
    for (let i = 0; i < paths.length; i += 3) {
      sum.textContent = `absorbing ${Math.min(i + 3, paths.length)} / ${paths.length}…`;
      try { const r = await api(`/api/gym/${Gym.cur.slug}/feed_links`, { json: { paths: paths.slice(i, i + 3) } }); skipped = skipped.concat(r.skipped || []); Gym.cur = r; const li = Gym.list.findIndex(x => x.slug === r.slug); if (li >= 0) Gym.list[li] = r; gymRender(); }
      catch (e) { toast(String(e.message || e), true); break; }
    }
    box.remove(); await gymLoad(Gym.cur.slug);
    toast(skipped.length ? `fed, but ${skipped.length} file${skipped.length > 1 ? 's' : ''} could not be read` : `“${Gym.cur.name}” ate ${paths.length} track${paths.length === 1 ? '' : 's'}`, !!skipped.length);
  };
  $('#gym-picker')?.remove(); $('#gym-stage').append(box); draw();
}

/* feed a result from the canvas straight to a creature */
async function feedChooser(path, ev) {
  const list = await api('/api/gym'), p = $('#palette');
  if (!list.length) { toast('no creatures yet — open the gym and hatch one'); return; }
  p.replaceChildren(h('div', { style: 'font:10px var(--mono);color:var(--muted);padding:4px 8px;letter-spacing:.12em' }, 'FEED TO…'), ...list.map(c => h('button', { style: `--c:hsl(${hueOf(dna(c).bright)},90%,60%)`, onclick: async () => {
    closePalette(); try { await api(`/api/gym/${c.slug}/feed?path=` + encodeURIComponent(path), { method: 'POST' }); toast(`“${c.name}” ate it`); } catch (e) { toast(String(e.message || e), true); } } }, h('i'), c.name, h('small', {}, c.food.length + ' tracks'))));
  p.style.left = Math.min(ev.clientX, innerWidth - 270) + 'px'; p.style.top = Math.min(ev.clientY, innerHeight - 300) + 'px'; p.hidden = false;
}

$('#btn-gym').onclick = () => openGym();

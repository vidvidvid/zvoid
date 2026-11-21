/* The gym: raise creatures (ACE-Step adapters) on your own audio and watch them grow. */
'use strict';

const Gym = { list: [], cur: null, key: '', open: false, mouse: null, raf: 0, timer: 0, fx: {}, playing: null, poke: false, audio: null };
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
   Sound with a semi-physical form. A 3D body of light, drawn with additive blending:
   - strings: one per track, vibrating as standing waves, forking at the tips once trained
   - knots: nested torus-knot membranes instead of shells (more of them as it trains)
   - cymatic dust: particles that settle on the nodal lines of a standing wave over a sphere
   - band ribbons: bass, mids and treble as open, precessing orbits (they follow the real spectrum while audio plays)
   - glyphs: one mark of its own script per ten epochs, drifting on a spiral
   It has a little behaviour of its own: it wanders, breathes unevenly, gets curious about the pointer,
   flinches when startled or poked, and individual strings twitch. Live audio drives all of it. */
const fxOf = slug => Gym.fx[slug] || (Gym.fx[slug] = { births: {}, waves: [], names: null, epochs: null });
const easeOut = x => 1 - Math.pow(1 - clamp(x, 0, 1), 3);
const _nh = i => { const x = Math.sin(i * 127.1 + 311.7) * 43758.5453; return (x - Math.floor(x)) * 2 - 1; };
const noise = x => { const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f); return _nh(i) * (1 - u) + _nh(i + 1) * u; };   // smooth, -1..1
const KNOTS = [[2, 3], [3, 5], [3, 4], [5, 7], [4, 7], [5, 8]];

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

/* its inner life: none of this is on a fixed loop */
function live(fx, d, t, mouse, cx0, cy0, S, au) {
  const sd = d.seed * 100, L = fx.life || (fx.life = { t, yaw: d.seed * 6, startle: 0, mx: null, my: null, beat: 0, bassAvg: 0, phase: 0, look: [0, 0] });
  const dt = clamp(t - L.t, 0, .1); L.t = t;
  L.curious = mouse ? clamp(.45 + noise(t * .05 + sd) * .9, 0, 1) : 0;                       // sometimes it cares about you, sometimes not
  if (mouse) {
    if (L.mx != null && Math.hypot(mouse.x - L.mx, mouse.y - L.my) / Math.max(dt, .016) > 1700 && Math.hypot(mouse.x - cx0, mouse.y - cy0) < S * .25) L.startle = Math.max(L.startle, .8);
    L.mx = mouse.x; L.my = mouse.y;
  } else L.mx = null;
  if (Gym.poke) { Gym.poke = false; L.startle = 1; fx.waves.push({ t0: t, hue: 190 + noise(t) * 80, soft: true }); }
  L.startle *= Math.exp(-dt * 1.5);
  const drive = au ? au.level : 0;
  L.yaw += ((.1 + noise(t * .06 + sd + 5) * .5 + (d.training ? .55 : 0)) * (1 + L.startle * 5) + drive * 1.1 * (noise(t * .02 + sd) > -.2 ? 1 : -1)) * dt;
  L.pitch = .4 + noise(t * .045 + sd + 9) * .6; L.roll = noise(t * .035 + sd + 13) * .55;
  L.phase += dt * (1.1 + noise(t * .09 + sd + 2) * .75 + (d.training ? 1 : 0));
  L.breath = clamp((.5 + .5 * Math.sin(L.phase)) * (1 + Math.max(0, noise(t * .03 + sd + 30) - .55) * 2.6), 0, 2);   // with the odd deep sigh
  const lean = L.curious * (1 - L.startle * 3);
  L.dx = S * .05 * noise(t * .04 + sd + 3) + (mouse ? (mouse.x - cx0) * .08 * lean : 0);
  L.dy = S * .035 * noise(t * .05 + sd + 7) + (mouse ? (mouse.y - cy0) * .08 * lean : 0);
  const tx = mouse ? clamp((mouse.x - cx0) / S, -1, 1) * L.curious : noise(t * .07 + sd + 40) * .5, ty = mouse ? clamp((mouse.y - cy0) / S, -1, 1) * L.curious : noise(t * .06 + sd + 50) * .5;
  L.look[0] += (tx - L.look[0]) * Math.min(1, dt * 3); L.look[1] += (ty - L.look[1]) * Math.min(1, dt * 3);
  if (au) { L.bassAvg = L.bassAvg * .93 + au.bass * .07; if (au.bass > L.bassAvg * 1.3 + .07 && t - L.beat > .2) { L.beat = t; fx.waves.push({ t0: t, hue: 300 - au.high * 200, soft: true }); } }
  return L;
}

function drawCreature(g, W, H, c, t, mouse, mini) {
  const d = dna(c), fx = fxOf(c.slug), S = Math.min(W, H), cx0 = W / 2, cy0 = H / 2 * (mini ? 1 : .94), sd = d.seed * 100;
  g.clearRect(0, 0, W, H);
  const au = mini ? null : audioLevels(), lv = au ? au.level : 0;                       // live sound, if anything is playing
  const L = mini ? { yaw: t * .2 + d.seed * 6, pitch: .45, roll: 0, breath: .5 + .5 * Math.sin(t * 1.2), dx: 0, dy: 0, startle: 0, curious: 0, look: [0, 0], beat: -9 } : live(fx, d, t, mouse, cx0, cy0, S, au);
  const cx = cx0 + L.dx, cy = cy0 + L.dy, kick = Math.exp(-(t - L.beat) * 7);
  const hue = (hueOf(d.bright) + (au ? (au.high - au.bass) * 50 : 0) + noise(t * .02 + sd) * 16 + 360) % 360, hue2 = (hue + 50 + d.seed * 140) % 360;
  const R = S * (d.n ? .08 + .03 * clamp(d.minutes / 30, 0, 1) + .045 * d.growth : .05) * (mini ? 1.7 : 1)
    * (1 + (.03 + d.dyn * .05) * (L.breath - .5) * 2) * (1 - .22 * L.startle) * (1 + (au ? au.bass * .3 : 0));
  const cyw = Math.cos(L.yaw), syw = Math.sin(L.yaw), cp = Math.cos(L.pitch), sp = Math.sin(L.pitch), cr = Math.cos(L.roll), sr = Math.sin(L.roll), F = S * 1.7;
  const proj = (x, y, z) => { const x1 = x * cyw + z * syw, z1 = -x * syw + z * cyw, y1 = y * cp - z1 * sp, z2 = y * sp + z1 * cp, k = F / (F - z2); return [cx + (x1 * cr - y1 * sr) * k, cy + (x1 * sr + y1 * cr) * k, z2, k]; };
  g.save(); g.globalCompositeOperation = 'lighter'; g.lineCap = 'round'; g.lineJoin = 'round';
  const n = d.n, wide = n > 80 ? 1.5 : 1;

  // aura
  const aur = g.createRadialGradient(cx, cy, 0, cx, cy, R * (n ? 5 : 3));
  aur.addColorStop(0, `hsla(${hue},95%,55%,${(.1 + L.breath * .05 + lv * .25 + kick * .15) * (d.training ? 1.6 : 1)})`); aur.addColorStop(.4, `hsla(${hue2},95%,45%,.035)`); aur.addColorStop(1, 'hsla(0,0%,0%,0)');
  g.fillStyle = aur; g.fillRect(0, 0, W, H);

  // motes: drift around it, stream inward while training, scatter with sound
  if (!mini) for (let i = 0; i < 70; i++) {
    const a = i * 2.39996 + t * (.05 + (i % 7) * .01) + noise(t * .1 + i) * .6, life = d.training ? ((t * (.16 + (i % 5) * .03) + i * .137) % 1) : .5 + .5 * noise(t * .15 + i * 3),
      rr = R * (d.training ? 6.5 - life * 5.6 : 3 + life * 3.5 + lv * 2), yy = Math.sin(i * 12.9898) * R * 2.2 * (d.training ? 1 - life * .8 : 1), p = proj(Math.cos(a) * rr, yy, Math.sin(a) * rr);
    g.fillStyle = `hsla(${(hue2 + i * 11) % 360},95%,75%,${(d.training ? life : .25 + .2 * life) * clamp(.6 + p[2] / (R * 6), .15, 1)})`;
    g.beginPath(); g.arc(p[0], p[1], (d.training ? .6 + life * 1.6 : .8) * p[3], 0, 7); g.fill();
  }

  // glyphs: its own script, one mark per ten epochs, on a slow spiral
  if (!mini && (d.epochs || d.training)) {
    const count = Math.min(72, Math.ceil(d.epochs / 10) + (d.training ? 1 : 0));
    for (let j = 0; j < count; j++) {
      const a = j * .47 + t * .028 + noise(t * .05 + j) * .08, rad = R * (3.0 + j * .04) * wide, p = proj(Math.cos(a) * rad, Math.sin(j * 1.3 + t * .2) * R * .25, Math.sin(a) * rad);
      const sz = (5 + (j % 3)) * p[3], fresh = d.training && j === count - 1, al = clamp(.5 + p[2] / (rad * 2), .07, .9) * (fresh ? .4 + .6 * Math.abs(noise(t * 9)) : .75);
      g.strokeStyle = `hsla(${(hue2 + j * 7) % 360},90%,${fresh ? 90 : 72}%,${al})`; g.lineWidth = .9; g.beginPath();
      for (let k = 0; k < 4; k++) { const r1 = Math.abs(_nh(j * 13 + k * 7 + sd)), r2 = Math.abs(_nh(j * 17 + k * 11 + sd + 5)), pt = v => [p[0] + ((Math.floor(v * 9) % 3) - 1) * sz, p[1] + (Math.floor(v * 9 / 3) - 1) * sz];
        const A = pt(r1), B = pt(r2); if (k % 2 && r1 > .5) { g.moveTo(A[0] + sz * .5, A[1]); g.arc(A[0], A[1], sz * .5, 0, Math.PI * (1 + r2)); } else { g.moveTo(A[0], A[1]); g.lineTo(B[0], B[1]); } }
      g.stroke();
    }
  }

  // strings: one per track, standing waves, with a will of their own
  const stride = Math.max(1, Math.ceil(n / 480)), strands = mini ? 1 : n > 140 ? 1 : n > 45 ? 2 : 3, segs = mini ? 9 : n > 220 ? 11 : n > 70 ? 15 : 22;
  const lenBase = R * (1.1 + (.45 + d.growth * 1.9)) * (n > 80 ? 1.25 : 1), reach = Math.min(1, (S * (mini ? .46 : .43) - R) / (lenBase * 1.75)) * (1 - .3 * L.startle);
  const dkey = n + '|' + (c.limbs || []).map(l => l.count).join(',');
  if (fx.dkey !== dkey) { fx.dkey = dkey; fx.dirs = stringDirs(c, d.seed); }
  const pull = mouse && !mini ? L.curious * .2 - L.startle * .45 : 0, forks = !mini && n <= 120 && d.growth > .2;
  for (let i = 0; i < n; i += stride) {
    const f = d.F[i], born = fx.births[f.name], grow = born == null ? 1 : easeOut((t - born) / 1.8); if (grow <= 0) continue;
    const [dx, dy, dz] = fx.dirs.out[i];
    let ux = dz, uy = 0, uz = -dx; const ul = Math.hypot(ux, uz) || 1; ux /= ul; uz /= ul; if (ul < 1e-3) { ux = 1; uz = 0; }
    const vx = dy * uz - dz * uy, vy = dz * ux - dx * uz, vz = dx * uy - dy * ux;
    const playing = Gym.playing === f.name, twitch = Math.max(0, noise(t * .55 + i * 7.3) - .45) * 3.2;       // now and then one string flares on its own
    const len = lenBase * clamp(.5 + Math.sqrt((f.secs || 30) / 150), .6, 1.5) * fx.dirs.lenK[i] * grow * reach * (1 + noise(t * .12 + i * 2.1) * .08 + (playing ? .15 : 0));
    const amp = R * (.05 + (f.dyn ?? .3) * .2) * (d.training ? 1.5 : 1) * (1 + twitch + lv * 2.6 + L.startle * 2 + (playing ? 1.2 : 0)), spd = (f.bpm ?? 100) / 60 * (d.training ? 2.8 : 1.1);
    const h1 = 1 + Math.round(clamp((f.bpm ?? 100) / 60, 1, 3)), vib = (f.bpm ?? 100) / 60 * (d.training ? 9 : 5) * (1 + lv * 1.5);
    const th = hueOf(f.bright ?? .3), thick = (.55 + (f.low ?? .3) * 1.3) * (playing ? 2 : 1);
    const tip0 = proj(dx * (R + len), dy * (R + len), dz * (R + len)), pk = pull ? pull * Math.exp(-Math.pow(Math.hypot(mouse.x - tip0[0], mouse.y - tip0[1]) / (S * .3), 2)) : 0;
    const at = (u, s, fk) => { const ph = s * 2.094 + i, e1 = Math.sin(u * Math.PI * (h1 + .5)) * amp * Math.sin(t * vib + ph), e2 = Math.sin(u * Math.PI * (h1 * 2 + 1.5)) * amp * .45 * Math.cos(t * vib * 1.31 + ph * 1.7),
      sway = (Math.sin(t * .35 + i * 1.3) + noise(t * .2 + i * 5) * 1.4) * R * .2 * u * u, a1 = e1 + sway + (fk ? fk * Math.max(0, u - .66) * len * .5 : 0), a2 = e2 + (fk ? Math.max(0, u - .66) * len * .22 * Math.sin(i + fk) : 0), r0 = R * .92 + len * u;
      const p = proj(dx * r0 + ux * a1 + vx * a2, dy * r0 + uy * a1 + vy * a2, dz * r0 + uz * a1 + vz * a2);
      if (pk) { p[0] += (mouse.x - p[0]) * pk * u * u; p[1] += (mouse.y - p[1]) * pk * u * u; } return p; };
    let tip, front = .5;
    for (let s = 0; s < strands; s++) {
      g.beginPath();
      for (let k = 0; k <= segs; k++) { const p = at(k / segs, s); k ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]); if (k === segs) { if (!s) tip = p; front = clamp(.55 + p[2] / (2.2 * (R + len)), .12, 1); } }
      const alpha = front * (.3 + d.growth * .5 + lv * .4 + twitch * .15) * (born != null && grow < 1 ? 1.6 : 1) * (s ? .7 : 1) * (playing ? 2 : 1), lw = (s ? .7 : 1.25) * thick * (mini ? .6 : 1) * (tip ? tip[3] : 1);
      if (!s && !mini && n <= 90) { g.strokeStyle = `hsla(${th},96%,60%,${clamp(alpha * .16, 0, 1)})`; g.lineWidth = lw * 5; g.stroke(); }
      g.strokeStyle = playing ? `hsla(${th},60%,92%,${clamp(alpha, 0, 1)})` : `hsla(${th + s * 22},96%,${60 + s * 7}%,${clamp(alpha, 0, 1)})`; g.lineWidth = lw; g.stroke();
    }
    if (forks) for (const fk of [-1, 1]) {                           // forked tips, like something that grew
      g.beginPath(); for (let k = 0; k <= 7; k++) { const p = at(.66 + .34 * k / 7 * (.55 + d.growth * .45), 0, fk); k ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]); }
      g.strokeStyle = `hsla(${th + 30},96%,72%,${front * (.2 + d.growth * .35)})`; g.lineWidth = .7; g.stroke();
    }
    if (tip) {
      g.fillStyle = `hsla(${th + 35},100%,82%,${clamp(front * (.5 + d.growth * .5) + (grow < 1 ? .5 : 0) + twitch * .3, 0, 1)})`; g.beginPath(); g.arc(tip[0], tip[1], (mini ? .8 : 1 + thick * 1.1 + (grow < 1 ? 3 * (1 - grow) : 0) + twitch) * tip[3], 0, 7); g.fill();
      if (!mini && (n <= 160 || i % 3 === 0)) {                    // a bead of light on the string: runs inward while training
        const u = d.training || playing ? 1 - ((t * spd * .22 + i * .37) % 1) : ((t * .1 + i * .61 + noise(t * .1 + i) * .2 + 1) % 1), p = at(u, 0);
        g.fillStyle = `hsla(${th + 20},100%,90%,${front * (d.training || playing ? .95 : .45)})`; g.beginPath(); g.arc(p[0], p[1], (d.training || playing ? 2 : 1.2) * p[3], 0, 7); g.fill();
      }
    }
  }

  // band ribbons: bass, mids, treble as open, precessing orbits. They trace the real spectrum while audio plays.
  if (n && !mini) [[d.low, 4, .5, 305, 1.6, 2, 2, 14], [d.mid, 13, 1.4, 182, 2.0, 3, 14, 110], [d.high, 41, 3.2, 72, 2.35, 5, 110, 380]].forEach(([e, k, spd, bh, rad, lobes, b0, b1], bi) => {
    const liveE = au ? [au.bass, au.mid, au.high][bi] : 0, A = clamp(.025 + Math.sqrt(e) * .16, .025, .2) * (d.training ? 1.6 : 1) + liveE * .3 / (1 + bi * 1.5);
    const tilt = bi * 1.05 + d.seed * 3 + noise(t * .04 + bi * 9 + sd) * .7, ct = Math.cos(tilt), stl = Math.sin(tilt), Rb = R * rad * wide, dir = bi % 2 ? -1 : 1, a0 = t * (.12 + bi * .07) * dir + noise(t * .05 + bi * 4) * 1.5, arc = Math.PI * (1.35 + .4 * noise(t * .06 + bi * 3));
    let prev = null;
    for (let q = 0; q <= 150; q++) {
      const u = q / 150, a = a0 + u * arc, bi_ = Math.floor(b0 + u * (b1 - b0)), bin = au ? (au.freq[bi_] + au.freq[bi_ + 1] + au.freq[Math.max(0, bi_ - 1)] + (fx.sp ? fx.sp[bi * 151 + q] * 3 : 0)) / (255 * (fx.sp ? 6 : 3)) : 0; if (au) { (fx.sp || (fx.sp = new Float32Array(453)))[bi * 151 + q] = bin * 255; }
      const w = Math.sin(k * a + t * spd * dir) * (.6 + .4 * Math.sin(a * 2 - t * .5)) + .3 * Math.sin((k * 2 + 1) * a - t * spd * 1.7), r = Rb * (1 + A * w + bin * bin * .34);
      const x = Math.cos(a) * r + Math.cos(a * lobes + t * .3) * Rb * .13, z = Math.sin(a) * r + Math.sin(a * lobes + t * .3) * Rb * .13, p = proj(x, z * stl, z * ct);
      if (prev) { g.strokeStyle = `hsla(${bh + u * 30},96%,${66 + bin * 25}%,${Math.sin(u * Math.PI) * (.34 + .5 * Math.sqrt(e) + liveE * .6) * (.5 + .5 * d.growth + (d.training ? .3 : 0))})`; g.lineWidth = 1 + bin * 2.2; g.beginPath(); g.moveTo(prev[0], prev[1]); g.lineTo(p[0], p[1]); g.stroke(); }
      prev = p;
    }
  });

  // knots: nested torus-knot membranes. Unsettled until it has learned; they ring with live sound.
  const layers = !n ? 0 : mini ? 1 : 1 + Math.min(4, Math.floor(Math.log2(d.epochs + 1) / 1.6)), lowA = .2 + d.low * .3, highA = clamp(d.high * 1.2 + d.noise * .05, .012, .2), kH = 9 + Math.round(d.seed * 9);
  const chaos = (n ? (1 - d.learned) * (d.epochs ? .07 : .12) : .03) + (d.digesting ? .06 : 0) + L.startle * .12;
  for (let l = 0; l < layers; l++) {
    const [p_, q_] = KNOTS[(l + Math.floor(d.seed * 6)) % KNOTS.length], Rl = R * (.42 + .17 * l), spin = t * (.2 + .11 * l) * (l % 2 ? 1 : -1) * (d.training ? 2 : 1) + noise(t * .08 + l * 5 + sd) * 1.2;
    const tx = l * 1.1 + d.seed * 4 + noise(t * .05 + l * 7) * .5, ctx_ = Math.cos(tx), stx = Math.sin(tx), pts = mini ? 90 : 240;
    for (let pass = 0; pass < (mini ? 1 : 2); pass++) {
      g.beginPath();
      for (let j = 0; j <= pts; j++) {
        const a = j / pts * Math.PI * 2, wv = au ? au.wave[(j * 2) % au.wave.length] : 0, ph = spin + pass * .09;
        const mod = 1 + lowA * Math.cos(q_ * a + ph) + highA * Math.sin(kH * a - spin * 2) + chaos * Math.sin(a * 31 + t * 8 + l) * Math.sin(a * 7 - t * 5) + wv * .5 * lv + kick * .08;
        const r = Rl * mod, x = r * Math.cos(p_ * a), z0 = r * Math.sin(p_ * a), y0 = Rl * lowA * 1.5 * Math.sin(q_ * a + ph), p = proj(x, y0 * ctx_ - z0 * stx, y0 * stx + z0 * ctx_);
        j ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]);
      }
      g.strokeStyle = `hsla(${(hue + l * 34 + pass * 20) % 360},96%,${60 + l * 5}%,${(mini ? .55 : .26 + .08 * l) * (.55 + d.growth * .45) * (pass ? .5 : 1) + lv * .2})`; g.lineWidth = mini ? .7 : pass ? .6 : 1; g.stroke();
    }
  }

  // cymatic dust: specks gather on the nodal lines of a standing wave over a sphere, and the pattern keeps shifting
  if (n && !mini) {
    const N = 620, m1 = 2 + d.low * 4 + noise(t * .03 + sd) * 1.5 + (au ? au.bass * 3 : 0), m2 = 2 + d.bright * 5 + noise(t * .025 + sd + 8) * 1.5 + (au ? au.high * 4 : 0), Rd = R * (1.18 + .1 * (layers - 1)), sharp = 2 + d.learned * 6;
    for (let i = 0; i < N; i++) {
      const yy = 1 - 2 * (i + .5) / N, rr = Math.sqrt(1 - yy * yy), lon = i * 2.39996, lat = Math.asin(yy), Y = Math.sin(m1 * lon + t * .25) * Math.sin(m2 * lat + t * .17), node = Math.pow(1 - Math.abs(Y), sharp);
      if (node < .08) continue;
      const r = Rd * (1 + Y * .1 + lv * .25 * Y + kick * .06), p = proj(Math.cos(lon) * rr * r, yy * r, Math.sin(lon) * rr * r), al = node * clamp(.55 + p[2] / (Rd * 2), .1, 1) * (.45 + d.growth * .5 + lv * .5);
      g.fillStyle = `hsla(${(hue2 + Y * 60 + 360) % 360},100%,78%,${clamp(al, 0, 1)})`; const s = (.8 + node * 1.1) * p[3]; g.fillRect(p[0] - s / 2, p[1] - s / 2, s, s);
    }
  }

  // core: a restless spark that leans toward whatever has its attention
  const kx = cx + L.look[0] * R * .35, ky = cy + L.look[1] * R * .35;
  const ng = g.createRadialGradient(kx, ky, 0, cx, cy, R * (n ? .95 : 1.6));
  ng.addColorStop(0, `hsla(${hue2},100%,88%,${clamp(.5 + .25 * L.breath + lv * .5 + kick * .3, 0, 1)})`); ng.addColorStop(.22, `hsla(${hue},100%,62%,.4)`); ng.addColorStop(1, 'hsla(0,0%,0%,0)');
  g.fillStyle = ng; g.beginPath(); g.arc(cx, cy, R * (n ? .95 : 1.6), 0, 7); g.fill();
  if (!mini) {
    const rays = 7 + Math.round(d.seed * 6); g.beginPath();
    for (let j = 0; j <= rays * 2; j++) { const a = j / (rays * 2) * Math.PI * 2 + L.yaw * .7, long = j % 2 === 0, r = R * (long ? .16 + .34 * Math.abs(noise(t * 1.7 + j * 3.1 + sd)) * (.5 + d.learned + lv * 2 + kick) : .05); j ? g.lineTo(kx + Math.cos(a) * r, ky + Math.sin(a) * r) : g.moveTo(kx + Math.cos(a) * r, ky + Math.sin(a) * r); }
    g.fillStyle = `hsla(${hue2},100%,90%,${.5 + lv * .4})`; g.fill();
    if (n) for (let k = 0; k < 3; k++) {                             // ripples leave the core, never quite round
      const u = (t * d.bpm / 60 * .5 + k / 3) % 1, rr = R * .9 * u + 1; g.beginPath();
      for (let j = 0; j <= 48; j++) { const a = j / 48 * Math.PI * 2, r = rr * (1 + .12 * noise(a * 3 + t * 1.3 + k * 9) + (au ? au.wave[j * 4 % au.wave.length] * .4 : 0)), p = proj(Math.cos(a) * r, 0, Math.sin(a) * r); j ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]); }
      g.strokeStyle = `hsla(${hue2},100%,82%,${(1 - u) * (.14 + .6 * d.learned + lv * .4)})`; g.lineWidth = .8 + (1 - u) * 1.2; g.stroke();
    }
  }

  // shockwaves: eating a track, an epoch, a beat, a poke. A ragged crown, tilted with the body.
  fx.waves = fx.waves.filter(w => t - w.t0 < (w.soft ? 1.6 : 2.6));
  if (!mini) for (const w of fx.waves) {
    const age = t - w.t0; if (age < 0) continue; const durW = w.soft ? 1.6 : 2.6, u = age / durW, rx = R * (1 + easeOut(u) * (w.soft ? 4.5 : 8));
    g.beginPath(); for (let j = 0; j <= 90; j++) { const a = j / 90 * Math.PI * 2, r = rx * (1 + .07 * Math.sin(a * 9 + w.t0 * 7) + .06 * noise(a * 5 + w.t0 * 3 + t)), p = proj(Math.cos(a) * r, 0, Math.sin(a) * r); j ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]); }
    g.strokeStyle = `hsla(${w.hue},100%,75%,${(1 - u) * (w.soft ? .4 : .9)})`; g.lineWidth = (w.soft ? 1.2 : 2.4) * (1 - u) + .4; g.stroke();
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
  if (Gym.audio) { Gym.audio.pause(); Gym.playing = null; }
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
  const key = JSON.stringify([Gym.playing, Gym.list.map(x => [x.slug, x.food.length, x.epochs, x.trained]), c && c.slug, c && c.food.map(f => f.name), running, c && c.trained]);
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
      h('canvas', { class: 'mini-creature', data: { slug: x.slug } }), h('span', {}, h('b', {}, x.name), h('small', {}, `${stageName(x)} · ${x.food.length} tracks · ${x.epochs} ep`)),
      h('span', { class: 'row-del', data: { label: '×' }, title: 'Delete this creature', onclick: e => { e.stopPropagation(); gymDelete(e.currentTarget, x); } }, '×')))),
    h('div', { class: 'gym-new' }, nameIn, hatchB));

  const stage = h('div', { id: 'gym-stage' }, h('canvas', { id: 'gym-bloom' }), h('canvas', { id: 'gym-canvas' }),
    c ? h('div', { id: 'gym-caption' }, h('h1', {}, c.name), h('div', { id: 'gym-stats' })) : h('div', { id: 'gym-caption' }, h('h1', {}, 'no creatures yet'), h('div', {}, 'name one on the left and press hatch')));
  stage.addEventListener('mousemove', e => { const r = stage.getBoundingClientRect(); Gym.mouse = { x: e.clientX - r.left, y: e.clientY - r.top }; });
  stage.addEventListener('mouseleave', () => { Gym.mouse = null; });
  stage.addEventListener('mousedown', e => { if (e.target.tagName === 'CANVAS') Gym.poke = true; });

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
        return h('div', { class: 'food-row' + (Gym.playing === f.name ? ' playing' : ''), style: `--c:hsl(${hueOf(f.bright ?? .3)},90%,60%)` }, h('button', { class: 'food-play', title: 'Play this track to the entity', onclick: () => gymPlay(c.slug, f.name) }, Gym.playing === f.name ? '■' : '▶'), h('div', {}, h('b', { title: f.name }, f.name), h('small', {}, `${Math.round(f.secs)}s · ~${Math.round(f.bpm || 0)} bpm · bass ${Math.round((f.low || 0) * 100)}% · bright ${Math.round((f.bright || 0) * 100)}%`), cap),
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
        !running ? h('button', { class: 'danger', data: { label: 'delete creature' }, title: 'Deletes what it learned and its list of tracks. Your original audio files are not touched.', onclick: e => gymDelete(e.currentTarget, c) }, 'delete creature') : null),
      h('p', { class: 'gym-note' }, 'Training uses the Apple GPU and pauses the ace-step module. Stopping keeps the last checkpoint (saved every 5 epochs).'));
  }
  const keepPicker = $('#gym-picker'); if (keepPicker) stage.append(keepPicker);
  el.replaceChildren(left, stage, right, h('input', { id: 'gym-pick', type: 'file', multiple: true, accept: 'audio/*,.wav,.mp3,.flac,.aiff,.aif,.ogg,.m4a', hidden: true, onchange: e => gymFeedFiles([...e.target.files]) }));
}

/* delete with a second click instead of a system dialog */
function gymDelete(btn, c) {
  if (btn.dataset.armed) return gymDo(async () => { await api('/api/gym/' + c.slug, { method: 'DELETE' }); if (Gym.cur && Gym.cur.slug === c.slug) Gym.cur = null; delete Gym.fx[c.slug]; });
  btn.dataset.armed = '1'; btn.textContent = 'click again to delete'; btn.classList.add('armed');
  setTimeout(() => { if (btn.isConnected) { delete btn.dataset.armed; btn.textContent = btn.dataset.label; btn.classList.remove('armed'); } }, 3500);
}

/* play one of its tracks: the sound goes through the analyser, so the entity reacts, and that track's string lights up */
function gymPlay(slug, name) {
  if (!Gym.audio) { Gym.audio = new Audio(); Gym.audio.crossOrigin = 'anonymous'; try { ac().createMediaElementSource(Gym.audio).connect(bus()); } catch (e) {} Gym.audio.onended = () => { Gym.playing = null; Gym.key = ''; gymRender(); }; }
  if (Gym.playing === name) { Gym.audio.pause(); Gym.playing = null; }
  else { ac().resume(); Gym.audio.src = `/api/gym/${slug}/food/${encodeURIComponent(name)}`; Gym.audio.play().catch(e => toast('could not play that file: ' + e.message, true)); Gym.playing = name; }
  Gym.key = ''; gymRender();
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

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
   A void creature made of sound. It has no body and no centre: it is a flow.
   - voids: several dark lobes that wander, merge and part. Light bends around them; they are punched out of the image.
   - currents: every track is a family of strands streaming through the field the voids create (colour = brightness,
     weight = bass). Untrained, the field is turbulent smoke; as it learns, the strands settle into folded orbits.
   - dust: a thousand specks carried by the same flow, so the whole thing never holds still or repeats.
   - glyphs: one mark of its own script per ten epochs, drifting near the voids.
   Live audio stirs the field. It wanders, breathes unevenly, drifts toward the pointer when curious, and answers touch
   differently depending on what you touch: a strand, a void, the flow, or empty space. It answers in its own voice. */
const fxOf = slug => Gym.fx[slug] || (Gym.fx[slug] = { births: {}, waves: [], names: null, epochs: null, pluck: {}, temps: [], pings: [] });
const easeOut = x => 1 - Math.pow(1 - clamp(x, 0, 1), 3);
const _nh = i => { const x = Math.sin(i * 127.1 + 311.7) * 43758.5453; return (x - Math.floor(x)) * 2 - 1; };
const noise = x => { const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f); return _nh(i) * (1 - u) + _nh(i + 1) * u; };   // smooth, -1..1

function layout(fx, c, d) {                       // which void each track streams around, and where its strands start
  const limbs = (c.limbs || []).length, key = d.n + '|' + limbs + '|' + (c.limbs || []).map(l => l.count).join(',');
  if (fx.lkey === key) return; fx.lkey = key;
  const k = d.n ? Math.max(2, limbs) + (d.n > 12 ? 1 : 0) : 1;
  fx.base = [...Array(k)].map((_, j) => { const yy = k > 1 ? 1 - 2 * (j + .5) / k : 0, rr = Math.sqrt(1 - yy * yy), ph = j * 2.39996 + d.seed * 6.28; return [Math.cos(ph) * rr, yy * .7, Math.sin(ph) * rr]; });
  fx.pole = d.F.map((f, i) => limbs > 1 ? (f.limb || 0) % k : i % k);
  fx.per = d.n ? clamp(Math.round(90 / d.n), 1, 8) : 0;       // few tracks still make a full form: each spawns several strands
  fx.seedv = d.F.map(f => [...Array(8)].map((_, m) => { const yy = hash(f.name + 'a' + m) * 2 - 1, rr = Math.sqrt(1 - yy * yy), ph = hash(f.name + 'b' + m) * 6.283; return [Math.cos(ph) * rr, yy, Math.sin(ph) * rr, .35 + hash(f.name + 'c' + m) * 1.1]; }));
}

function live(fx, d, t, mouse, cx0, cy0, S, au) { // its inner life: none of this is on a fixed loop
  const sd = d.seed * 100, L = fx.life || (fx.life = { t, yaw: d.seed * 6, startle: 0, sx: cx0, sy: cy0, beat: -9, bassAvg: 0, phase: 0 });
  const dt = clamp(t - L.t, 0, .1); L.t = t; L.dt = dt;
  if (mouse) { L.sx += (mouse.x - L.sx) * Math.min(1, dt * 2.2); L.sy += (mouse.y - L.sy) * Math.min(1, dt * 2.2); }   // it follows a calm, delayed idea of where you are
  if (mouse && dt > 0) { const sp = L.mx == null ? 0 : Math.hypot(mouse.x - L.mx, mouse.y - L.my) / Math.max(dt, .004); L.mx = mouse.x; L.my = mouse.y; L.msp = (L.msp || 0) * .75 + sp * .25;   // a sudden fast movement near it makes it flinch
    if (L.msp > S * 6 && t - (L.flT || -9) > 4) { L.flT = t; L.startle = Math.max(L.startle, .3); } } else if (!mouse) { L.mx = null; L.msp = 0; }
  L.curious = mouse ? clamp(.4 + noise(t * .05 + sd) * .9, 0, 1) : 0;
  L.startle *= Math.exp(-dt * 1.4);
  const drive = au ? au.level : 0;
  L.yaw += ((.07 + noise(t * .06 + sd + 5) * .32 + (d.training ? .3 : 0)) * (1 + L.startle * .8) + drive * .35 * (noise(t * .02 + sd) > -.2 ? 1 : -1)) * dt;
  L.pitch = .35 + noise(t * .045 + sd + 9) * .65; L.roll = noise(t * .035 + sd + 13) * .7;
  L.phase += dt * (1.0 + noise(t * .09 + sd + 2) * .75 + (d.training ? .8 : 0));
  L.breath = clamp((.5 + .5 * Math.sin(L.phase)) * (1 + Math.max(0, noise(t * .03 + sd + 30) - .55) * 2.6), 0, 2);
  L.dx = S * .045 * noise(t * .04 + sd + 3); L.dy = S * .035 * noise(t * .05 + sd + 7);
  if (au) { L.bassAvg = L.bassAvg * .93 + au.bass * .07; if (au.bass > L.bassAvg * 1.3 + .07 && t - L.beat > .2) { L.beat = t; fx.waves.push({ t0: t, pole: Math.floor(Math.abs(noise(t * 3)) * 9), soft: true }); } }
  return L;
}

function drawCreature(g, W, H, c, t, mouse, mini) {
  const d = dna(c), fx = fxOf(c.slug), S = Math.min(W, H), cx0 = W / 2, cy0 = H / 2 * (mini ? 1 : .94), sd = d.seed * 100, n = d.n;
  g.clearRect(0, 0, W, H); layout(fx, c, d);
  const au = mini ? null : audioLevels(), lv = au ? au.level : 0;
  const L = mini ? { yaw: t * .15 + d.seed * 6, pitch: .45, roll: 0, breath: .5 + .5 * Math.sin(t * 1.2), dx: 0, dy: 0, startle: 0, curious: 0, beat: -9, dt: .016, sx: cx0, sy: cy0 } : live(fx, d, t, mouse, cx0, cy0, S, au);
  const cx = cx0 + L.dx, cy = cy0 + L.dy, kick = Math.exp(-(t - L.beat) * 7);
  const hue = (hueOf(d.bright) + (au ? (au.high - au.bass) * 50 : 0) + noise(t * .02 + sd) * 18 + 360) % 360, hue2 = (hue + 50 + d.seed * 140) % 360;
  const R = S * (n ? .1 + .025 * clamp(d.minutes / 30, 0, 1) + .035 * d.growth : .07) * (mini ? 1.35 : 1) * (1 + (.03 + d.dyn * .05) * (L.breath - .5) * 2);
  const cyw = Math.cos(L.yaw), syw = Math.sin(L.yaw), cp = Math.cos(L.pitch), sp = Math.sin(L.pitch), cr = Math.cos(L.roll), sr = Math.sin(L.roll), F = S * 1.7;
  const proj = (x, y, z) => { const x1 = x * cyw + z * syw, z1 = -x * syw + z * cyw, y1 = y * cp - z1 * sp, z2 = y * sp + z1 * cp, k = F / (F - z2); return [cx + (x1 * cr - y1 * sr) * k, cy + (x1 * sr + y1 * cr) * k, z2, k]; };
  const unproj = (px, py, z2) => { const k = F / (F - z2), xr = (px - cx) / k, yr = (py - cy) / k, x1 = xr * cr + yr * sr, y1 = -xr * sr + yr * cr, z1 = -y1 * sp + z2 * cp; return [x1 * cyw - z1 * syw, y1 * cp + z2 * sp, x1 * syw + z1 * cyw]; };

  // the voids: where they are right now
  const spread = R * (1.05 + .4 * d.growth) * (n > 80 ? 1.2 : 1), K = fx.base.length;
  const poles = fx.base.map((b, j) => {
    const w = 1 + .4 * noise(t * .05 + j * 7 + sd), ax = [noise(t * .04 + j * 3 + sd), .5 + noise(t * .05 + j * 5 + 9 + sd), noise(t * .045 + j * 8 + 17 + sd)], al = Math.hypot(ax[0], ax[1], ax[2]) || 1;
    return { c: [b[0] * spread * w + noise(t * .06 + j * 13 + sd) * R * .6, b[1] * spread * w + noise(t * .055 + j * 17 + sd) * R * .6, b[2] * spread * w + noise(t * .05 + j * 19 + sd) * R * .6],
      ax: [ax[0] / al, ax[1] / al, ax[2] / al], s: (j % 2 ? -1 : 1) * (.8 + .5 * noise(t * .07 + j * 2 + sd)), sig: R * (.95 + .3 * noise(t * .06 + j * 11 + sd)) * (1 + (au ? au.bass * .45 : 0) + kick * .12) * (1 - .3 * L.startle) };
  });
  if (!mini && mouse && L.curious > .05 && K) {       // the nearest void leans toward the (smoothed) pointer when it's curious
    let best = 0, bd = 1e9; poles.forEach((P, j) => { const p = proj(P.c[0], P.c[1], P.c[2]), dd = Math.hypot(p[0] - L.sx, p[1] - L.sy); P.z2 = p[2]; if (dd < bd) { bd = dd; best = j; } });
    const tg = unproj(L.sx, L.sy, poles[best].z2), k = .3 * L.curious; for (let a = 0; a < 3; a++) poles[best].c[a] += (tg[a] - poles[best].c[a]) * k;
  }
  fx.temps = fx.temps.filter(v => t - v.t0 < 5);
  const temps = mini ? [] : fx.temps.map(v => ({ c: v.c, ax: v.ax, s: v.s * Math.exp(-(t - v.t0) * .7) * 2.2, sig: R * .8 }));
  const all = poles.concat(temps), turb = (.22 + (1 - d.learned) * (d.epochs ? .7 : 1) + lv * 1.3 + L.startle * 1.2 + (d.digesting ? .5 : 0)) * (n ? 1 : .6), kf = 1 / (R * .95), bound = spread + R * 1.7;
  let vx = 0, vy = 0, vz = 0;
  const V = (x, y, z) => {                             // the flow: swirl around every void, pulled onto its shell, stirred by turbulence
    vx = turb * Math.sin(y * kf + t * .31 + z * kf * .7); vy = turb * Math.sin(z * kf + t * .27 + x * kf * .6); vz = turb * Math.sin(x * kf + t * .23 + y * kf * .8);
    for (let j = 0; j < all.length; j++) { const P = all[j], dx = x - P.c[0], dy = y - P.c[1], dz = z - P.c[2], d2 = dx * dx + dy * dy + dz * dz, dl = Math.sqrt(d2) + 1e-3, s2 = P.sig * P.sig, f = P.s * Math.exp(-d2 / (6 * s2)) * 2 / dl, pump = (P.sig * 1.3 - dl) / P.sig * .16 * Math.exp(-d2 / (12 * s2)) / dl, pol = (1 - d2 / (1.6 * s2)) * Math.exp(-d2 / (4 * s2)) * .85 * (P.s > 0 ? 1 : -1);
      vx += (P.ax[1] * dz - P.ax[2] * dy) * f + dx * pump + P.ax[0] * pol; vy += (P.ax[2] * dx - P.ax[0] * dz) * f + dy * pump + P.ax[1] * pol; vz += (P.ax[0] * dy - P.ax[1] * dx) * f + dz * pump + P.ax[2] * pol; }
    const rl = Math.hypot(x, y, z); if (rl > bound) { const q = Math.min(6, (rl - bound) / R * 3.2) / rl; vx -= x * q; vy -= y * q; vz -= z * q; }
  };
  fx.waves = fx.waves.filter(w => t - w.t0 < 2.4); const waves = mini ? [] : fx.waves.filter(w => t >= w.t0).slice(-4).map(w => ({ o: w.o || poles[w.pole % K].c, r: (t - w.t0) * R * 4.5, a: (1 - (t - w.t0) / 2.4) * R * (w.soft ? .22 : .5) }));
  g.save(); g.globalCompositeOperation = 'lighter'; g.lineCap = 'round'; g.lineJoin = 'round';

  // faint nebula around each void
  if (!mini) poles.forEach((P, j) => { const p = proj(P.c[0], P.c[1], P.c[2]), rr = P.sig * 3.2 * p[3], gr = g.createRadialGradient(p[0], p[1], 0, p[0], p[1], rr);
    gr.addColorStop(0, `hsla(${(hue + j * 40) % 360},95%,55%,${(.07 + L.breath * .03 + lv * .18 + kick * .1) * (d.training ? 1.5 : 1)})`); gr.addColorStop(1, 'hsla(0,0%,0%,0)'); g.fillStyle = gr; g.fillRect(p[0] - rr, p[1] - rr, rr * 2, rr * 2); });

  // dust: carried by the flow
  if (!mini) {
    const N = n ? 2400 : 700; if (!fx.dust || fx.dust.length !== N * 4) fx.dust = new Float32Array(N * 4);
    const D = fx.dust, sp = R * 1.25 * (d.training ? 1.6 : 1) * (1 + lv * 2), dA = .5 + d.growth * .4 + lv * .6;
    for (let i = 0; i < N; i++) {
      const o = i * 4; D[o + 3] -= L.dt * (.16 + (i % 7) * .03);
      if (D[o + 3] <= 0) { const P = poles[i % K], yy = Math.random() * 2 - 1, rr = Math.sqrt(1 - yy * yy), ph = Math.random() * 6.283, r0 = P.sig * (.3 + Math.random() * (d.training ? 3.6 : 2.1)); D[o] = P.c[0] + Math.cos(ph) * rr * r0; D[o + 1] = P.c[1] + yy * r0; D[o + 2] = P.c[2] + Math.sin(ph) * rr * r0; D[o + 3] = 1; }
      V(D[o], D[o + 1], D[o + 2]); D[o] += vx * sp * L.dt; D[o + 1] += vy * sp * L.dt; D[o + 2] += vz * sp * L.dt;
      const p = proj(D[o], D[o + 1], D[o + 2]), al = Math.sin(D[o + 3] * Math.PI) * clamp(.55 + p[2] / (bound * 2), .1, 1) * dA, s = (1.5 + (i % 5) * .35) * p[3];
      g.fillStyle = `hsla(${(hue2 + (i % 9) * 9 + Math.hypot(vx, vy, vz) * 30) % 360},100%,76%,${clamp(al, 0, 1)})`; g.fillRect(p[0] - s / 2, p[1] - s / 2, s, s);
    }
  }

  // currents: every track streams through the field
  const per = mini ? Math.min(fx.per, 2) : fx.per, total = n * per, stride = Math.max(1, Math.ceil(total / 640)), steps0 = mini ? 14 : total > 400 ? 26 : total > 160 ? 38 : 54, h = R * .1 * (total > 400 ? 1.35 : 1);
  const hits = mini ? null : (fx.hits = []);
  for (let i = 0, q = 0; i < n; i++) {
    const f = d.F[i], born = fx.births[f.name], grow = born == null ? 1 : easeOut((t - born) / 2.2); if (grow <= 0) { q += per; continue; }
    const P = poles[fx.pole[i] % K], th = hueOf(f.bright ?? .3), thick = .5 + (f.low ?? .3) * 1.3, playing = Gym.playing === f.name;
    const pl = fx.pluck[i], pk = pl ? pl.a * Math.exp(-(t - pl.t0) * 1.5) * (t >= pl.t0 ? 1 : 0) : 0; if (pl && t - pl.t0 > 4) delete fx.pluck[i];
    const twitch = Math.max(0, noise(t * .4 + i * 7.3) - .5) * 2.4, hm = 2 + Math.round(clamp((f.bpm ?? 100) / 50, 1, 5));
    for (let m = 0; m < per; m++, q++) {
      if (q % stride) continue;
      const sv = fx.seedv[i][m], r0 = P.sig * sv[3] * (1 + .25 * noise(t * .07 + i * 3.1 + m));
      let x = P.c[0] + (sv[0] + noise(t * .05 + i + m * 9) * .5) * r0, y = P.c[1] + (sv[1] + noise(t * .045 + i * 2 + m * 5) * .5) * r0, z = P.c[2] + (sv[2] + noise(t * .04 + i * 3 + m * 7) * .5) * r0;
      const Ks = Math.max(3, Math.round(steps0 * clamp(.55 + Math.sqrt((f.secs || 30) / 200), .6, 1.3) * (.6 + .4 * d.growth + (playing ? .2 : 0)) * grow)), ph = t * (2 + (f.bpm ?? 100) / 40) * (.6 + .4 * noise(t * .1 + i)) + i;
      let first = null, last = null, mid = null, front = .5;
      g.beginPath();
      for (let k = 0; k <= Ks; k++) {
        const u = k / Ks, wob = (pk * Math.sin(u * Math.PI * hm) * Math.sin(ph * 3) * R * .55 + twitch * Math.sin(u * 9 - ph) * R * .08 * u + (au ? au.wave[(k * 9 + i * 13) % 512] * lv * R * .5 : 0) + (playing ? Math.sin(u * 14 - ph * 2) * R * .08 : 0));
        let px = x + P.ax[0] * wob, py = y + P.ax[1] * wob, pz = z + P.ax[2] * wob;
        for (let wI = 0; wI < waves.length; wI++) { const w = waves[wI], ex = px - w.o[0], ey = py - w.o[1], ez = pz - w.o[2], el = Math.hypot(ex, ey, ez) + 1e-3, g2 = Math.exp(-Math.pow((el - w.r) / (R * .7), 2)) * w.a / el; px += ex * g2; py += ey * g2; pz += ez * g2; }
        const p = proj(px, py, pz); k ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]);
        if (!k) first = p; if (k === Ks >> 1) mid = p; if (k === Ks) { last = p; front = clamp(.55 + p[2] / (bound * 1.6), .12, 1); }
        V(x, y, z); const ml = Math.hypot(vx, vy, vz) + 1e-6; x += vx / ml * h; y += vy / ml * h; z += vz / ml * h;
      }
      const alpha = front * (.4 + d.growth * .45 + lv * .4 + twitch * .12 + pk * .8) * (born != null && grow < 1 ? 1.5 : 1) * (playing ? 2 : 1) * (per > 3 ? .8 : 1), lw = (m ? .7 : 1.15) * thick * (mini ? .6 : 1) * (last ? last[3] : 1) * (1 + pk);
      if (!m && !mini && total <= 260) { g.strokeStyle = `hsla(${th},96%,60%,${clamp(alpha * .15, 0, 1)})`; g.lineWidth = lw * 5; g.stroke(); }
      g.strokeStyle = playing || pk > .15 ? `hsla(${th},70%,${80 + pk * 12}%,${clamp(alpha, 0, 1)})` : `hsla(${(th + m * 9 + 360) % 360},96%,${60 + (m % 3) * 6}%,${clamp(alpha, 0, 1)})`; g.lineWidth = lw; g.stroke();
      if (last && !mini) {
        g.fillStyle = `hsla(${th + 35},100%,84%,${clamp(front * (.35 + d.growth * .5) + twitch * .3 + pk, 0, 1)})`; g.beginPath(); g.arc(last[0], last[1], (.8 + thick * .7 + twitch + pk * 2 + (grow < 1 ? 3 * (1 - grow) : 0)) * last[3], 0, 7); g.fill();
        if (hits) { hits.push(i, first[0], first[1], i, mid[0], mid[1], i, last[0], last[1]); }
      }
    }
  }

  // glyphs: its script, near the voids
  if (!mini && (d.epochs || d.training)) {
    const count = Math.min(72, Math.ceil(d.epochs / 10) + (d.training ? 1 : 0));
    for (let j = 0; j < count; j++) {
      const P = poles[j % K], a = j * 1.7 + t * .04 + noise(t * .05 + j) * .5, rad = P.sig * (1.9 + (j % 5) * .28 + noise(t * .03 + j * 3) * .3), b1 = [P.ax[1], -P.ax[0], 0], bl = Math.hypot(b1[0], b1[1]) || 1;
      const ux = b1[0] / bl, uy = b1[1] / bl, wx = P.ax[1] * 0 - P.ax[2] * uy, wy = P.ax[2] * ux - P.ax[0] * 0, wz = P.ax[0] * uy - P.ax[1] * ux, ca = Math.cos(a) * rad, sa = Math.sin(a) * rad;
      const p = proj(P.c[0] + ux * ca + wx * sa, P.c[1] + uy * ca + wy * sa, P.c[2] + wz * sa), sz = (4.5 + (j % 3)) * p[3], fresh = d.training && j === count - 1, al = clamp(.5 + p[2] / (bound * 1.6), .07, .9) * (fresh ? .4 + .6 * Math.abs(noise(t * 9)) : .7);
      g.strokeStyle = `hsla(${(hue2 + j * 7) % 360},90%,${fresh ? 90 : 72}%,${al})`; g.lineWidth = .9; g.beginPath();
      for (let k = 0; k < 4; k++) { const r1 = Math.abs(_nh(j * 13 + k * 7 + sd)), r2 = Math.abs(_nh(j * 17 + k * 11 + sd + 5)), pt = v => [p[0] + ((Math.floor(v * 9) % 3) - 1) * sz, p[1] + (Math.floor(v * 9 / 3) - 1) * sz];
        const A = pt(r1), B = pt(r2); if (k % 2 && r1 > .5) { g.moveTo(A[0] + sz * .5, A[1]); g.arc(A[0], A[1], sz * .5, 0, Math.PI * (1 + r2)); } else { g.moveTo(A[0], A[1]); g.lineTo(B[0], B[1]); } }
      g.stroke();
    }
  }

  // the voids themselves: punched out of the light, with a broken, flickering rim
  const geomPoles = [];
  if (!mini) poles.forEach((P, j) => {
    const p = proj(P.c[0], P.c[1], P.c[2]), rad = P.sig * (.3 + .06 * d.growth) * p[3] * (1 + .12 * noise(t * .5 + j * 4) + kick * .15), path = new Path2D();
    for (let q = 0; q <= 44; q++) { const a = q / 44 * Math.PI * 2, r = rad * (1 + .3 * noise(a * .9 + t * .3 + j * 9) + .05 * noise(a * 3 - t * .5 + j) + (au ? au.wave[(q * 11) % 512] * .5 * lv : 0)), X = p[0] + Math.cos(a) * r, Y = p[1] + Math.sin(a) * r; q ? path.lineTo(X, Y) : path.moveTo(X, Y); }
    path.closePath(); geomPoles.push({ x: p[0], y: p[1], rad, j, c: P.c, z2: p[2] });
    g.globalCompositeOperation = 'destination-out'; const vg = g.createRadialGradient(p[0], p[1], 0, p[0], p[1], rad * 1.25); vg.addColorStop(0, 'rgba(0,0,0,1)'); vg.addColorStop(.45, 'rgba(0,0,0,.9)'); vg.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = vg; g.fill(path);
    g.globalCompositeOperation = 'lighter'; g.setLineDash([rad * (.5 + .4 * Math.abs(noise(t * .2 + j))), rad * (.2 + .5 * Math.abs(noise(t * .3 + j * 5)))]); g.lineDashOffset = t * 14 * (j % 2 ? 1 : -1);
    g.strokeStyle = `hsla(${(hue2 + j * 40) % 360},100%,80%,${.1 + .3 * d.learned + lv * .4 + kick * .3})`; g.lineWidth = .7 + kick; g.stroke(path); g.setLineDash([]);
  });

  // pings: where you touched empty space
  fx.pings = fx.pings.filter(pg => t - pg.t0 < 1.4);
  if (!mini) for (const pg of fx.pings) { const u = (t - pg.t0) / 1.4; g.beginPath(); for (let q = 0; q <= 30; q++) { const a = q / 30 * Math.PI * 2, r = (6 + u * 46) * (1 + .2 * noise(a * 3 + pg.t0 * 5 + t * 2)); q ? g.lineTo(pg.x + Math.cos(a) * r, pg.y + Math.sin(a) * r) : g.moveTo(pg.x + Math.cos(a) * r, pg.y + Math.sin(a) * r); } g.strokeStyle = `hsla(${hue2},100%,80%,${(1 - u) * .6})`; g.lineWidth = 1; g.stroke(); }
  g.restore();
  if (!mini) fx.geom = { poles: geomPoles, unproj, R, growth: d.growth, learned: d.learned, K };
}

/* notice what changed since the last look, so new tracks stream in and epochs ripple through it */
function gymFx(c, at) {
  const fx = fxOf(c.slug), now = at ?? performance.now() / 1000;
  if (fx.names) { let k = 0; for (const f of c.food) if (!fx.names.has(f.name)) { fx.births[f.name] = now + k * .16; fx.waves.push({ t0: now + k * .16, pole: f.limb || k }); k++; } }
  fx.names = new Set(c.food.map(f => f.name));
  if (fx.epochs != null && c.epochs > fx.epochs) { fx.waves.push({ t0: now, pole: c.epochs }); if (fx.life) fx.life.beat = now; }      // an epoch lands: a full shock front
  fx.epochs = c.epochs;
  const st = c.training && c.training.state === 'running' ? c.training.step : null;
  if (st != null && fx.step != null && st > fx.step) { fx.waves.push({ t0: now, pole: st, soft: true }); if (fx.life) fx.life.beat = now; }   // every training step: a pulse you can see
  fx.step = st;
}

/* ---------- its voice ----------
   Synthesised on the spot and sent through the same analyser, so it also reacts to its own sound.
   Untrained it is noisy, detuned and short of breath. Training makes it purer, richer in overtones and longer. */
let ECHO = null;
/* The space it answers in is alive too. Two delay lines feed each other, their times drift like a worn tape, their tone and
   length wander, and every sound decides for itself how much of that space it enters: some stay dry and close, some trail off
   for a long time. So the same touch never comes back the same way twice. */
const ECHO_SENDS = [.05, .28, .62, 1];
function voiceOut(send) {
  if (!ECHO) { const a = ac(), mk = () => a.createGain(), dlA = a.createDelay(1.5), dlB = a.createDelay(1.5), fbA = mk(), fbB = mk(), xAB = mk(), xBA = mk(), lpA = a.createBiquadFilter(), lpB = a.createBiquadFilter(), wet = mk(), inB = mk();
    dlA.delayTime.value = .31; dlB.delayTime.value = .19; fbA.gain.value = .42; fbB.gain.value = .3; xAB.gain.value = .22; xBA.gain.value = .15; inB.gain.value = .5; wet.gain.value = 1;
    lpA.type = lpB.type = 'lowpass'; lpA.frequency.value = 2600; lpB.frequency.value = 1900;
    dlA.connect(lpA); lpA.connect(fbA); fbA.connect(dlA); lpA.connect(xAB); xAB.connect(dlB); lpA.connect(wet);
    inB.connect(dlB); dlB.connect(lpB); lpB.connect(fbB); fbB.connect(dlB); lpB.connect(xBA); xBA.connect(dlA); lpB.connect(wet); wet.connect(bus());
    for (const [par, hz, depth] of [[dlA.delayTime, .13, .0035], [dlA.delayTime, .31, .0012], [dlB.delayTime, .09, .005], [dlB.delayTime, .47, .0009]]) {   // slow, uneven wobbles of the delay times: a faint drift in pitch, never a loop you can count
      const o = a.createOscillator(), g = mk(); o.frequency.value = hz * (.8 + Math.random() * .4); g.gain.value = depth; o.connect(g); g.connect(par); o.start(); }
    const ins = ECHO_SENDS.map(lv => { const i = mk(), sg = mk(); sg.gain.value = lv; i.connect(bus()); i.connect(sg); sg.connect(dlA); sg.connect(inB); i.dl = dlA; i.fb = fbA; return i; });
    ECHO = { ins, dl: dlA, fb: fbA, base: .42, w: [0, 0, 0, 0] };
    setInterval(() => {                                                                               // its length, its tone and the second line's timing wander by themselves
      if (a.state !== 'running') return; const t = a.currentTime, W = ECHO.w, step = (i, k) => (W[i] = clamp(W[i] * .9 + (Math.random() - .5) * k, -1, 1));
      fbA.gain.setTargetAtTime(clamp(ECHO.base * (1 + .55 * step(0, .5)), .04, .72), t, .5); fbB.gain.setTargetAtTime(clamp(.3 + .3 * step(1, .5), .05, .6), t, .5);
      lpA.frequency.setTargetAtTime(2400 * Math.pow(2, step(2, .5)), t, .6); lpB.frequency.setTargetAtTime(1700 * Math.pow(2, step(3, .5)), t, .6);
      if (Math.random() < .06) dlB.delayTime.setTargetAtTime(clamp(dlA.delayTime.value * [.5, .62, .75, 1.33, 1.5, 2][Math.floor(Math.random() * 6)], .04, 1.2), t, .35);   // now and then the second line slides to a new place
    }, 450);
  }
  let k = 0;
  if (send == null) { const r = Math.random(); k = r < .3 ? 0 : r < .74 ? 1 : r < .93 ? 2 : 3; }     // left to itself: often close, usually some, sometimes a long tail
  else { let bd = 9; ECHO_SENDS.forEach((lv, i) => { if (Math.abs(lv - send) < bd) { bd = Math.abs(lv - send); k = i; } }); }
  return ECHO.ins[k];
}
/* ---------- its memory ----------
   Its real voice is made of what it ate: short excerpts of its own tracks, played back as overlapping grains.
   Untrained, it only manages short, scattered, detuned scraps. Training makes the grains longer and truer. */
const GRAIN = { bufs: new Map(), busy: new Set() };
function grainBuf(slug, name) {
  const k = slug + '/' + name, b = GRAIN.bufs.get(k); if (b) return b;
  if (!GRAIN.busy.has(k) && GRAIN.busy.size < 3) { GRAIN.busy.add(k);
    fetch(`/api/gym/${slug}/grain/${encodeURIComponent(name)}`).then(r => r.ok ? r.arrayBuffer() : Promise.reject(r.status)).then(a => new Promise((res, rej) => ac().decodeAudioData(a, res, rej)))
      .then(buf => { GRAIN.bufs.set(k, buf); if (GRAIN.bufs.size > 30) GRAIN.bufs.delete(GRAIN.bufs.keys().next().value); }).catch(() => {}).finally(() => GRAIN.busy.delete(k)); }
  return null;
}
function grainWarm(c) {                            // keep the most typical tracks of every limb in memory (up to five each); called now and then, it works through them a few at a time
  if (!c || !c.food || !c.food.length) return; const per = {};
  for (const f of [...c.food].sort((a, b) => (a.core || 0) - (b.core || 0))) { const lk = f.limb || 0; per[lk] = (per[lk] || 0) + 1; if (per[lk] <= 5) grainBuf(c.slug, f.name); }
}
/* one grain: a slice of a track, faded in and out. pos is 0..1 through the excerpt. */
function grainOne(buf, o = {}) {
  const a = ac(), t0 = a.currentTime + (o.when || 0), dur = Math.min(o.dur || .25, buf.duration * .9), src = a.createBufferSource(), g = a.createGain(), rate = o.rate || 1;
  src.buffer = buf; src.playbackRate.value = rate; const off = clamp((o.pos ?? Math.random()) * buf.duration, 0, Math.max(0, buf.duration - dur * rate - .01)), at = Math.min(dur * .4, o.attack || .03);
  g.gain.setValueAtTime(.0001, t0); g.gain.exponentialRampToValueAtTime(o.gain || .3, t0 + at); g.gain.setValueAtTime(o.gain || .3, t0 + dur * .55); g.gain.exponentialRampToValueAtTime(.0001, t0 + dur);
  src.connect(g); g.connect(voiceOut(o.echo)); src.start(t0, off, dur * rate + .05); src.stop(t0 + dur + .1);
}
/* a cloud of grains from one track. pure 0..1 = how well it remembers. Returns false if that track is not in memory yet. */
function grainCloud(slug, name, o = {}) {
  const buf = grainBuf(slug, name); if (!buf) return false;
  const pure = o.pure || 0, n = o.n || 7, pos = o.pos ?? Math.random(), rnd = Math.random;
  for (let i = 0; i < n; i++) grainOne(buf, { when: (o.when || 0) + i * (o.gap ?? .09) * (.6 + rnd() * .8), dur: (.09 + pure * .5) * (.7 + rnd() * .8) * (o.long || 1), pos: clamp(pos + (rnd() - .5) * (.3 - .24 * pure), 0, 1),
    rate: (o.rate || 1) * (rnd() < .2 * (1 - pure) ? (rnd() < .5 ? .5 : 2) : 1) * (1 + (rnd() - .5) * .06 * (1 - pure)), gain: (o.gain || .3) * (.6 + rnd() * .5) / Math.sqrt(n / 5), attack: .012 + pure * .05 });
  return true;
}
const ALIEN_SCALE = [1, 1.0802, 1.1905, 1.3333, 1.4815, 1.6071, 1.8];        // steps of an unfamiliar tuning
const noteOf = v => 98 * Math.pow(2, Math.floor(clamp(v, 0, .999) * 21 / 7)) * ALIEN_SCALE[Math.floor(clamp(v, 0, .999) * 21) % 7];
function tone(freq, o = {}) {
  const a = ac(), t0 = a.currentTime + (o.when || 0), dur = o.dur || 1, g = a.createGain(); g.gain.setValueAtTime(.0001, t0); g.gain.exponentialRampToValueAtTime(o.gain || .16, t0 + (o.attack || .006)); g.gain.exponentialRampToValueAtTime(.0001, t0 + dur); g.connect(voiceOut(o.echo));
  const ratios = o.ratios || [...Array(o.partials || 1)].map((_, k) => k + 1);
  ratios.forEach((r, k) => { const os = a.createOscillator(), pg = a.createGain(); os.type = o.type || 'sine'; const fq = freq * r * (1 + (Math.random() - .5) * (o.detune || 0)); os.frequency.setValueAtTime(fq, t0);
    if (o.bend) os.frequency.exponentialRampToValueAtTime(Math.max(20, fq * (1 + o.bend)), t0 + dur); pg.gain.value = 1 / (k * k * .8 + 1); os.connect(pg); pg.connect(g); os.start(t0); os.stop(t0 + dur + .05); });
  if (o.noise > 0) { const len = Math.floor(a.sampleRate * Math.min(dur, .7)), b = a.createBuffer(1, len, a.sampleRate), ch = b.getChannelData(0); for (let i = 0; i < len; i++) ch[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2);
    const s = a.createBufferSource(), ng = a.createGain(), fl = a.createBiquadFilter(); fl.type = 'bandpass'; fl.frequency.value = freq * (o.noiseAt || 2); fl.Q.value = 1.5; s.buffer = b; ng.gain.value = o.noise; s.connect(fl); fl.connect(ng); ng.connect(g); s.start(t0); }
}

/* touch: what happens depends on what you touched, where, and how far it has come */
function gymTouch(x, y) {
  const c = Gym.cur; if (!c) return; const fx = fxOf(c.slug), G = fx.geom, L = fx.life; if (!G || !L) return;
  ac().resume(); const t = performance.now() / 1000, gr = G.growth, pure = clamp(.25 * gr + .75 * G.learned, 0, 1), rnd = Math.random;
  const pole = G.poles.reduce((b, p) => { const dd = Math.hypot(p.x - x, p.y - y) / p.rad; return dd < b.d ? { d: dd, p } : b; }, { d: 1e9, p: null });
  if (pole.p && pole.d < .85) {                                      // a void: it swallows, flinches, and answers from deep down
    const lim = (c.limbs || []).find(l => l.id === pole.p.j), base = 41 * ALIEN_SCALE[pole.p.j % 7] * (1 + rnd() * .02);
    tone(base, { dur: 1.6 + gr * 3, attack: .12, gain: .22, partials: 1 + Math.round(gr * 5), detune: (1 - pure) * .05, bend: -.12 * (1 - pure), noise: (1 - pure) * .25, noiseAt: 1.5 });
    tone(base * (lim ? ALIEN_SCALE[(lim.count + 2) % 7] : 1.4815) * 2, { dur: 1 + gr * 2.5, attack: .3, gain: .07 * (.3 + pure), when: .08, detune: (1 - pure) * .03 });
    L.startle = 1; fx.waves.push({ t0: t, o: pole.p.c }); return;
  }
  let best = -1, bd = 24 * 24; const H_ = fx.hits || []; for (let k = 0; k < H_.length; k += 3) { const dd = (H_[k + 1] - x) ** 2 + (H_[k + 2] - y) ** 2; if (dd < bd) { bd = dd; best = H_[k]; } }
  if (best >= 0) {                                                   // a strand: it rings at that track's pitch, and its kin ring with it
    const f = c.food[best], fq = noteOf(f.bright ?? .3) * (1 + (rnd() - .5) * .01);
    tone(fq, { dur: .45 + gr * 2.6, gain: .2, type: pure > .5 ? 'sine' : 'triangle', partials: 1 + Math.round(gr * 4), detune: (1 - pure) * .045, bend: -(1 - pure) * .07, noise: (1 - pure) * .4 + .03, noiseAt: 3 });
    if (gr > .3) tone(fq * ALIEN_SCALE[4], { dur: .4 + gr * 2, gain: .06 * gr, when: .06 + rnd() * .05, detune: (1 - pure) * .03 });
    fx.pluck[best] = { t0: t, a: 1 }; let k2 = 0; c.food.forEach((o, j) => { if (j !== best && (o.limb || 0) === (f.limb || 0) && k2 < 14) { k2++; fx.pluck[j] = { t0: t + .05 + rnd() * .25, a: .12 + rnd() * .18 }; } });
    return;
  }
  const near = pole.p && pole.d < 4.5, z2 = pole.p ? pole.p.z2 : 0;
  if (near) {                                                        // the flow itself: a glassy chime, and a new eddy forms right there
    const fq = 320 + rnd() * 900; tone(fq, { dur: .9 + gr * 2.2, gain: .12, ratios: [1, 2.76, 5.4, 8.93].slice(0, 2 + Math.round(gr * 2)), detune: (1 - pure) * .03, noise: (1 - pure) * .18, noiseAt: 4 });
    const ax = [rnd() - .5, rnd() - .5, rnd() - .5], al = Math.hypot(...ax) || 1; fx.temps.push({ c: G.unproj(x, y, z2), ax: ax.map(v => v / al), s: rnd() > .5 ? 1 : -1, t0: t }); fx.waves.push({ t0: t, o: G.unproj(x, y, z2), soft: true }); return;
  }
  tone(700 + rnd() * 1400, { dur: .22 + gr * .3, gain: .07, bend: rnd() > .5 ? 1.2 : -.6, detune: 0 });   // empty space: a small sonar chirp, and it takes note of where
  fx.pings.push({ x, y, t0: t }); L.sx = x; L.sy = y;
}

/* ---------- screen ---------- */
const gymEl = () => $('#gym');
async function openGym(slug) {
  Gym.open = true; gymEl().hidden = false; openDrawer(null);
  if (Gym.list.length) { Gym.key = ''; gymRender(); cancelAnimationFrame(Gym.raf); gymFrame(); }               // show what we already know at once
  else if (!gymEl().children.length) gymEl().replaceChildren(h('div', { style: 'grid-column:1/-1;display:grid;place-items:center;font:11px var(--mono);letter-spacing:.3em;color:var(--muted)' }, 'ENTERING THE vivarium…'));
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
  const o = gymOther(Gym.cur);                           // the one that is training elsewhere: keep watching it, so this creature unlocks when it ends
  if (o) api('/api/gym/' + o.slug).then(r => { const i = Gym.list.findIndex(x => x.slug === r.slug); if (i >= 0) Gym.list[i] = r; if (!r.training || !/running|stopping/.test(r.training.state)) gymRender(); }).catch(() => {});
  try { const c = await api('/api/gym/' + Gym.cur.slug); if (Gym.cur && c.slug === Gym.cur.slug) { Gym.cur = c; Gym.polledAt = performance.now(); const i = Gym.list.findIndex(x => x.slug === c.slug); if (i >= 0) Gym.list[i] = c; gymRender(); } } catch {}
}
function gymFrame() {
  if (!Gym.open) return;
  const t = performance.now() / 1000; Gym.rafAt = t; gymRecTick(t);
  const cv = $('#gym-canvas');
  if (cv && NEB.ok) {                                    // GPU nebula
    if (Gym.cur && NEB.shot && NEB.shot.rec) nebFrame(Gym.cur, t, null);          // a time-lapse frame, off-screen
    const busyGpu = Gym.cur && Gym.cur.training && Gym.cur.training.state === 'running' && !Gym.cur.training.remote;   // while it trains the trainer needs the GPU: draw the live view at half the frame rate, steadily, instead of fighting for it
    NEB.qMax = 1; NEB.half = !!busyGpu; Gym.fno = (Gym.fno || 0) + 1;                       // resolution is never capped: only the frame rate is halved while the trainer needs the GPU
    if (Gym.cur && !(busyGpu && Gym.fno % 2)) nebFrame(Gym.cur, t, Gym.mouse, true);
  } else if (cv) {                                       // fallback: the older 2D renderer
    const d = devicePixelRatio || 1, w = cv.clientWidth, hh = cv.clientHeight;
    if (cv.width !== Math.round(w * d)) { cv.width = Math.round(w * d); cv.height = Math.round(hh * d); }
    const g = cv.getContext('2d'); g.setTransform(d, 0, 0, d, 0, 0);
    if (Gym.cur) drawCreature(g, w, hh, Gym.cur, t, Gym.mouse); else g.clearRect(0, 0, w, hh);
  }
  document.querySelectorAll('canvas.mini-creature').forEach(m => {
    const c = Gym.list.find(x => x.slug === m.dataset.slug); if (!c) return;
    const g = m.getContext('2d'); if (m.width !== 112) { m.width = 112; m.height = 112; } g.setTransform(2, 0, 0, 2, 0, 0); drawMini(g, 56, 56, c, t);
  });
  Gym.raf = requestAnimationFrame(gymFrame);
}
const dur = s => s < 90 ? Math.max(1, Math.round(s)) + 's' : s < 5400 ? Math.round(s / 60) + ' min' : (s / 3600).toFixed(1) + ' h';
const stageName = c => !c.food.length ? 'seed' : !c.epochs ? 'dormant' : c.epochs < 60 ? 'awakening' : c.epochs < 250 ? 'forming' : c.epochs < 800 ? 'ascendant' : 'ancient';

function gymOther(c) { return Gym.list.find(x => (!c || x.slug !== c.slug) && x.training && /running|stopping/.test(x.training.state)) || null; }   // another creature that is training right now: only one trains at a time
function gymRender() {
  Gym.list.forEach(gymFx); if (Gym.cur) gymFx(Gym.cur);
  const c = Gym.cur, tr = c && c.training, running = !!(tr && /running|stopping/.test(tr.state));
  const key = JSON.stringify([Gym.playing, Gym.list.map(x => [x.slug, x.food.length, x.epochs, x.trained]), c && c.slug, c && c.food.map(f => f.name), running, c && c.trained, (gymOther(c) || {}).slug]);
  if (key !== Gym.key) { Gym.key = key; gymBuild(); }
  if (!c) return;
  $('#gym-stats').textContent = `${stageName(c)} · ate ${c.food.length} track${c.food.length === 1 ? '' : 's'} (${c.minutes} min) · trained ${c.epochs} epoch${c.epochs === 1 ? '' : 's'}` + (c.history.length ? ` · loss ${c.history[c.history.length - 1][1].toFixed(3)}` : '');
  const st = $('#gym-status');
  st.textContent = tr ? (tr.state === 'error' ? '✖ ' + tr.error : tr.msg) : (c.trained ? 'usable now: pick it in an ace-step module as “creature”.' : c.food.length ? 'fed, not trained yet.' : 'hungry. drop audio on it.');
  st.className = tr && tr.state === 'error' ? 'err' : '';
  const bar = $('#gym-bar i'); if (bar) bar.style.width = running && tr.max_epochs ? clamp((tr.epoch - tr.from_epoch) / Math.max(1, tr.max_epochs - tr.from_epoch) * 100, 2, 100) + '%' : '0';
  const pace = tr && tr.remote ? c.pace_pc : c.pace;
  if (running && tr.stage === 'train' && pace && tr.audio_secs) st.textContent += ` · about ${dur((tr.max_epochs - tr.epoch) * (pace * tr.audio_secs + tr.tracks * .1))} left`;
  const sp = $('#gym-spark'); if (sp) spark(sp, c.history.map(h => h[1]));
  const box = $('#gym-train');
  if (box) {
    const on = !!(tr && tr.state === 'running'); box.hidden = !on;
    if (on) {
      const ph = tr.stage === 'train' ? 2 : tr.stage === 'load' ? 1 : 0, total = Math.max(1, tr.max_epochs - tr.from_epoch), done = tr.epoch - tr.from_epoch, el = Math.max(0, (tr.now || 0) - tr.started);
      const per = tr.epoch_time || (pace ? pace * tr.audio_secs + tr.tracks * .1 : 0), sessH = c.history.filter(x => x[0] > tr.from_epoch), drop = sessH.length >= 3 ? (sessH[0][1] - sessH[sessH.length - 1][1]) / sessH[0][1] * 100 : null;   // a trend only once there are a few epochs to compare
      const big = ph === 2 ? `epoch ${Math.min(tr.epoch + 1, tr.max_epochs)} / ${tr.max_epochs}` : ph === 1 ? 'waking the model' : 'digesting';
      const sub = ph === 2 ? [`step ${Math.max(0, tr.step - tr.step0)} / ${tr.steps_per_epoch}`, tr.loss != null ? `loss ${tr.loss.toFixed(3)}` + (drop != null && Math.abs(drop) >= .5 ? ` (${drop > 0 ? '↓' : '↑'} ${Math.abs(drop).toFixed(0)}% since this session began)` : '') : null, per ? `about ${dur((total - done) * per)} left` : 'timing the first epoch…'].filter(Boolean).join('  ·  ')
        : ph === 1 ? (tr.remote ? `loading ACE-Step on ${tr.remote}` : 'loading ACE-Step onto the GPU') : (tr.digested || 0) < tr.tracks ? `${tr.digested || 0} / ${tr.tracks} tracks turned into training data` : `all ${tr.tracks} tracks read · encoding them for the model`;
      box.replaceChildren(
        h('div', { class: 'tr-phases' }, ['digest', 'wake', 'train'].map((p, i) => h('span', { class: i < ph ? 'done' : i === ph ? 'now' : '' }, p))),
        h('div', { class: 'tr-big' }, big), h('div', { class: 'tr-sub' }, sub),
        h('div', { class: 'tr-bar' }, h('i', { style: `width:${clamp(ph === 2 ? done / total * 100 : 0, 0, 100)}%` })),
        h('div', { class: 'tr-foot' }, (ph === 2 ? `${Math.round(done / total * 100)}% of this session · ${dur(el)} in` : `${dur(el)} in`) + ((Gym.fx[c.slug] || {}).part ? `  ·  building its ${Gym.fx[c.slug].part} (${Gym.fx[c.slug].partPct}%)` : '')));
    }
  }
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
    h('div', { class: 'drawer-head' }, h('span', {}, 'vivarium'), h('button', { onclick: closeGym, title: 'Back to the canvas (esc)' }, '← canvas')),
    h('p', { class: 'gym-note' }, 'A creature is a small adapter for ACE-Step that learns your sound. Feed it your tracks, train it, then pick it inside any ace-step module.'),
    h('div', { class: 'gym-list' }, Gym.list.map(x => h('button', { class: 'creature-row' + (c && x.slug === c.slug ? ' cur' : ''), onclick: () => { Gym.cur = x; Gym.key = ''; gymRender(); } },
      h('canvas', { class: 'mini-creature', data: { slug: x.slug } }), h('span', {}, h('b', {}, x.name), h('small', {}, `${stageName(x)} · ${x.food.length} tracks · ${x.epochs} ep`)),
      h('span', { class: 'row-del', data: { label: '×', confirm: 'delete?' }, title: 'Delete this creature (click twice)', onclick: e => { e.stopPropagation(); gymDelete(e.currentTarget, x); } }, '×')))),
    h('div', { class: 'gym-new' }, nameIn, hatchB));

  const stage = h('div', { id: 'gym-stage' }, nebCanvas(), h('div', { id: 'gym-fps' }), h('div', { id: 'gym-tools' }, h('button', { id: 'gym-shot', title: 'Save a still of it, far sharper than the screen (up to 3840 px), to outputs/captures', onclick: () => nebCapture() }, '◉ still'), h('button', { id: 'gym-rec', title: 'Record a time-lapse: frames are taken at intervals and joined into a video in outputs/recordings. Start it, then start training, and it stops by itself when training ends. Keep the vivarium open.', onclick: () => gymRecToggle() }, Gym.rec ? '■ stop time-lapse' : '● time-lapse'), h('button', { id: 'gym-tape', title: 'Record the sound: everything you hear from it (touches, drags, strikes, songs, tracks you play) is saved as a WAV in outputs/recordings.', onclick: () => tapeToggle() }, TAPE.on ? '■ stop sound' : '● sound'), h('button', { id: 'gym-film', title: 'Film it: records the picture at normal speed together with the sound, as one video in outputs/recordings. Use it to record yourself playing the creature.', onclick: () => filmToggle() }, FILM.on ? '■ stop filming' : '● film')), h('div', { id: 'gym-train', hidden: true }),
    c ? h('div', { id: 'gym-caption' }, h('h1', {}, c.name), h('div', { id: 'gym-stats' })) : h('div', { id: 'gym-caption' }, h('h1', {}, 'no creatures yet'), h('div', {}, 'name one on the left and press hatch')));
  stage.addEventListener('mousemove', e => { const r = stage.getBoundingClientRect(); Gym.mouse = { x: e.clientX - r.left, y: e.clientY - r.top }; });
  stage.addEventListener('mouseleave', () => { Gym.mouse = null; });
  stage.addEventListener('mousedown', e => { if (!NEB.ok && e.target.tagName === 'CANVAS') { const r = stage.getBoundingClientRect(); gymTouch(e.clientX - r.left, e.clientY - r.top); } });   // the nebula canvas handles its own touch and drag

  const right = h('div', { id: 'gym-right' });
  if (c) {
    const saveId = () => api('/api/gym/' + c.slug, { method: 'PUT', json: { style: style.value, tag: tag.value } }).then(r => { Gym.cur = r; });
    const style = h('textarea', { rows: 2, spellcheck: 'false', placeholder: 'describe its sound in tags: dub techno, 120 bpm, tape hiss, deep chords', onchange: saveId }); style.value = c.style || '';
    const tag = h('input', { spellcheck: 'false', onchange: saveId }); tag.value = c.tag || '';
    const ep = h('input', { type: 'number', min: 1, max: 5000, step: 10, value: 100 }), rank = h('select', {}, [8, 16, 32, 64, 128].map(v => h('option', { value: v }, 'rank ' + v))); rank.value = (c.settings && c.settings.rank) || 64;
    const lr = h('select', {}, [['5e-5', 'gentle'], ['1e-4', 'normal'], ['2e-4', 'fast'], ['5e-4', 'reckless']].map(([v, l]) => h('option', { value: v }, `${l} (${v})`))); lr.value = '1e-4';
    const maxd = h('input', { type: 'number', min: 10, max: 600, step: 10, value: 240 });
    const maxT = h('input', { type: 'number', min: 0, max: 5000, step: 5, value: 0 });
    const far = Gym.remote && Gym.remote.configured ? Gym.remote : null;
    if (Gym.remote === undefined) { Gym.remote = null; api('/api/gym_remote').then(r => { Gym.remote = r; Gym.key = ''; gymPoll(); }).catch(() => {}); }
    const where = h('select', {}, [h('option', { value: 'mac' }, 'this Mac'), far ? h('option', { value: 'pc', disabled: !far.reachable }, far.name + (far.reachable ? '' : ' (not reachable)')) : null]);
    where.value = far && far.reachable && Gym.where !== 'mac' ? 'pc' : 'mac';       // the stronger machine by default; a choice made by hand holds until the app is closed
    where.addEventListener('change', () => { Gym.where = where.value; est(); });
    const estEl = h('div', { class: 'gym-est' });
    const est = () => {
      const budget = +maxT.value || 0, fs = budget && budget < c.food.length ? c.food.slice().sort((a, b) => (a.core || 0) - (b.core || 0)).slice(0, budget) : c.food;
      const audio = fs.reduce((a, f) => a + Math.min(f.secs || 0, +maxd.value || 240), 0), pc = where.value === 'pc', pace = pc ? c.pace_pc || .004 : c.pace || .07, per = audio * pace + fs.length * (pc ? .02 : .1), eps = +ep.value || 0;
      estEl.replaceChildren(h('b', {}, `≈ ${dur(per)} per epoch · ≈ ${dur(per * eps)} for ${eps} epochs`), h('br'),
        `${fs.length} track${fs.length === 1 ? '' : 's'} · ${Math.round(audio / 60)} min of audio per epoch. ` + (pc ? (c.pace_pc ? `Timed on ${far.name}.` : `A rough guess for ${far.name} until the first epoch has been timed.`) + ' This Mac stays free for the creature.' : c.pace ? 'Timed on this Mac.' : 'A rough guess until the first epoch has been timed.') + ' More tracks or longer tracks = slower epochs.');
    };
    [ep, maxd, maxT].forEach(i => i.addEventListener('input', est)); est();
    const other = running ? null : gymOther(c), wait = other ? `“${other.name}” is training right now. Only one creature trains at a time.` : '';
    const go = fresh => { Gym.more = +ep.value || 100; gymDo(() => api(`/api/gym/${c.slug}/train`, { json: { epochs: Gym.more, rank: +rank.value, lr: +lr.value, max_duration: +maxd.value, max_tracks: +maxT.value || 0, fresh, where: where.value } })); };
    right.append(
      h('h3', {}, 'food'),
      h('div', { class: 'food' }, c.food.length ? c.food.map(f => {
        const cap = h('input', { spellcheck: 'false', placeholder: 'caption for this track (optional)', onchange: () => api('/api/gym/' + c.slug, { method: 'PUT', json: { captions: { [f.name]: cap.value } } }) }); cap.value = f.caption || '';
        return h('div', { class: 'food-row' + (Gym.playing === f.name ? ' playing' : ''), style: `--c:hsl(${hueOf(f.bright ?? .3)},90%,60%)` }, h('button', { class: 'food-play', title: 'Play this track to the entity', onclick: () => gymPlay(c.slug, f.name) }, Gym.playing === f.name ? '■' : '▶'), h('div', {}, h('b', { title: f.name + '\nDrag it onto the creature, or double-click, to make it sing from this track', draggable: 'true', ondragstart: e => { e.dataTransfer.setData('text/x-zvoid-food', f.name); e.dataTransfer.effectAllowed = 'copy'; }, ondblclick: () => gymSing(c, null, f.name) }, f.name), h('small', {}, `${Math.round(f.secs)}s · ~${Math.round(f.bpm || 0)} bpm · bass ${Math.round((f.low || 0) * 100)}% · bright ${Math.round((f.bright || 0) * 100)}%`), cap),
          h('button', { title: 'Sing from this track: the creature makes a new clip out of a passage of it', disabled: running, onclick: () => gymSing(c, null, f.name) }, '♪'),
          h('button', { title: 'Take this track away', disabled: running, onclick: () => gymDo(() => api(`/api/gym/${c.slug}/food/${encodeURIComponent(f.name)}`, { method: 'DELETE' })) }, '×'));
      }) : h('p', { class: 'gym-note' }, 'Nothing yet. Drop audio files anywhere on this screen.')),
      h('div', { class: 'acts' }, h('button', { disabled: running, onclick: () => { const i = $('#gym-pick'); i.value = ''; i.click(); } }, '+ feed audio or video…'), h('button', { disabled: running, title: 'Pick a folder. Tracks are linked where they are, not copied.', onclick: gymPickFolder }, '+ feed a folder…')),
      ...((c.limbs || []).length > 1 ? [h('h3', {}, 'limbs'),
        h('p', { class: 'gym-note' }, 'Tracks that sound alike grow together as one limb. Each limb learns its own word: put it in a caption to call that side of the creature.'),
        h('div', { class: 'limbs' }, c.limbs.map(l => h('div', { class: 'limb-row', style: `--c:hsl(${hueOf(l.mean.bright)},90%,60%)` }, h('i'), h('span', {}, l.tags.join(' · ')), h('small', {}, l.count + ' tracks'), h('code', { title: 'The trigger word of this limb' }, l.trigger), h('button', { class: 'limb-sing', title: 'Ask this limb to sing: ACE-Step makes a short new clip in its style and the creature performs it. You can also double-click the limb itself.', disabled: running, onclick: () => gymSing(c, l.id) }, '♪'))))] : []),
      h('h3', {}, 'identity'),
      h('label', { title: 'Used as the caption for every track that has no caption of its own. Good tags make a much better creature.' }, h('span', {}, 'its sound, in tags'), style),
      h('label', { title: 'A made-up word the model learns to associate with this sound. Zvoid adds it to your caption automatically when the creature is active.' }, h('span', {}, 'trigger word'), tag),
      h('h3', {}, 'training'),
      h('div', { class: 'gym-grid' },
        h('label', { title: 'How many more passes over the food. 100–300 is a good first session for 10–30 tracks.' }, h('span', {}, 'epochs to add'), ep),
        h('label', { title: 'Capacity of the adapter. Higher learns more detail but can memorise.' }, h('span', {}, 'capacity'), rank),
        h('label', { title: 'How big each learning step is.' }, h('span', {}, 'learning rate'), lr),
        h('label', { title: 'Longer tracks are cut to this many seconds.' }, h('span', {}, 'max seconds / track'), maxd),
        h('label', { style: 'grid-column:1/-1', title: 'Keeps epochs fast on big collections: trains on the most typical tracks of every limb, in proportion. 0 = use every track.' }, h('span', {}, 'train on at most this many tracks (0 = all)'), maxT),
        far ? h('label', { style: 'grid-column:1/-1', title: 'Where the training runs. On the PC the tracks and what the creature has learned are sent over, it trains there, and the result comes back by itself.' }, h('span', {}, 'train on'), where) : null),
      estEl,
      h('div', { id: 'gym-bar' }, h('i')),
      h('canvas', { id: 'gym-spark' }),
      h('div', { id: 'gym-status' }),
      h('div', { class: 'acts' },
        running ? h('button', { class: 'stop', onclick: () => api(`/api/gym/${c.slug}/stop`, { method: 'POST' }).then(gymPoll) }, '■ stop')
          : h('button', { class: 'hot', disabled: !c.food.length || !!other, title: wait, onclick: () => go(false) }, c.epochs ? 'train more ▸' : 'train ▸'),
        !running && c.epochs ? h('button', { disabled: !!other, title: wait || 'Forget everything it learned and train again from zero', onclick: () => { if (confirm(`Erase what “${c.name}” has learned and start over? Its food stays.`)) go(true); } }, 'start over') : null,
        !running && c.trained && Gym.list.some(x => x.slug !== c.slug && x.trained) ? h('button', { title: 'Breed it with another trained creature. The child sounds like the average of both, inherits links to all their food, and can be trained further.', onclick: e => gymBreed(c, e) }, 'breed…') : null),
      other ? h('p', { class: 'gym-note gym-wait' }, h('b', {}, `“${other.name}” is training right now.`), ' Only one creature trains at a time. You can still feed this one; training unlocks when the other finishes or is stopped. ', h('a', { href: '#', onclick: e => { e.preventDefault(); Gym.cur = other; Gym.key = ''; gymRender(); } }, 'show it')) : null,
      h('p', { class: 'gym-note' }, 'On this Mac, training uses the Apple GPU and pauses the ace-step module. Stopping keeps the last saved checkpoint.'),
      ...(!running ? [h('div', { class: 'acts gym-end' }, h('button', { class: 'danger', data: { label: 'delete creature' }, title: 'Deletes what it learned and its list of tracks. Your original audio files are not touched.', onclick: e => gymDelete(e.currentTarget, c) }, 'delete creature'))] : []));
  }
  stage.addEventListener('dragover', e => { if ([...e.dataTransfer.types].includes('text/x-zvoid-food')) { e.preventDefault(); stage.classList.add('fed'); } });
  stage.addEventListener('dragleave', () => stage.classList.remove('fed'));
  stage.addEventListener('drop', e => { stage.classList.remove('fed'); const name = e.dataTransfer.getData('text/x-zvoid-food'); if (name && Gym.cur) { e.preventDefault(); e.stopPropagation(); gymSing(Gym.cur, null, name); } });   // a track thrown into the creature: it sings from that one
  const keepPicker = $('#gym-picker'); if (keepPicker) stage.append(keepPicker);
  el.replaceChildren(left, stage, right, h('input', { id: 'gym-pick', type: 'file', multiple: true, accept: 'audio/*,video/*,.wav,.mp3,.flac,.aiff,.aif,.ogg,.m4a,.mp4,.mov,.mkv,.webm', hidden: true, onchange: e => gymFeedFiles([...e.target.files]) }));
}

/* delete with a second click instead of a system dialog */
function gymDelete(btn, c) {
  if (btn.dataset.armed) return gymDo(async () => { await api('/api/gym/' + c.slug, { method: 'DELETE' }); if (Gym.cur && Gym.cur.slug === c.slug) Gym.cur = null; delete Gym.fx[c.slug]; });
  btn.dataset.armed = '1'; btn.textContent = btn.dataset.confirm || 'click again to delete'; btn.classList.add('armed');
  setTimeout(() => { if (btn.isConnected) { delete btn.dataset.armed; btn.textContent = btn.dataset.label; btn.classList.remove('armed'); } }, 3500);
}

/* play one of its tracks: the sound goes through the analyser, so the entity reacts, and that track's string lights up */
/* Breed two trained creatures into a third: pick the partner and a name right in the panel. */
function gymBreed(c, e) {
  const host = e.currentTarget.parentNode, old = host.querySelector('.breed-form'); if (old) return old.remove();
  const others = Gym.list.filter(x => x.slug !== c.slug && x.trained), sel = h('select', {}, others.map(o => h('option', { value: o.slug }, 'with ' + o.name)));
  const nm = h('input', { type: 'text', placeholder: 'name the child', value: `${c.name.split(' ')[0]}-${others[0].name.split(' ')[0]}` });
  const go = h('button', { class: 'hot', onclick: () => { const name = nm.value.trim(); if (!name) return nm.focus(); go.disabled = true; toast('breeding…');
    gymDo(() => api('/api/gym_breed', { json: { a: c.slug, b: sel.value, name } })).then(() => toast(`“${name}” is born`)); } }, 'breed');
  host.append(h('div', { class: 'breed-form', style: 'display:flex;gap:6px;margin-top:8px;flex-basis:100%' }, sel, nm, go));
}
/* ---------- film it ----------
   Picture and sound together, at normal speed: the canvas as a video stream plus the same audio point the sound recorder
   uses, encoded by the browser as you go and saved as one video when you stop. */
const FILM = { on: false };
function filmToggle() { FILM.on ? filmStop() : filmStart(); }
function filmLabel() { const b = $('#gym-film'); if (b) b.textContent = FILM.on ? '■ stop filming' : '● film'; }
function filmStart() {
  const cv = NEB.canvas; if (!NEB.ok || !cv || !cv.captureStream || typeof MediaRecorder === 'undefined') return toast('this window cannot record video', true);
  const a = ac(); a.resume(); const dest = a.createMediaStreamDestination(); bus().connect(dest);
  const stream = new MediaStream([...cv.captureStream(30).getVideoTracks(), ...dest.stream.getAudioTracks()]);
  const type = ['video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find(t => MediaRecorder.isTypeSupported(t));
  let mr; try { mr = new MediaRecorder(stream, Object.assign({ videoBitsPerSecond: 18e6, audioBitsPerSecond: 256e3 }, type ? { mimeType: type } : {})); } catch (e) { try { bus().disconnect(dest); } catch {} return toast('could not start filming: ' + e.message, true); }
  const chunks = [], slug = Gym.cur ? Gym.cur.slug : 'creature';
  mr.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
  mr.onstop = async () => { try { bus().disconnect(dest); } catch {} stream.getTracks().forEach(t => t.stop());
    const blob = new Blob(chunks, { type: mr.mimeType || type || 'video/mp4' }); if (blob.size < 2000) return toast('nothing was filmed', true);
    toast('saving the film…');
    try { const r = await fetch(`/api/gym/${slug}/film`, { method: 'POST', headers: { 'Content-Type': blob.type || 'video/mp4' }, body: blob }).then(x => x.json()); toast(r.name ? `saved ${r.name} (${r.seconds}s)` : 'could not save the film: ' + (r.detail || ''), !r.name); } catch (e) { toast('could not save the film: ' + e.message, true); } };
  mr.start(1000); FILM.on = true; FILM.mr = mr; FILM.stopAt = setTimeout(filmStop, 600000); filmLabel(); toast('filming with sound. Play it. Ten minutes at most.');
}
function filmStop() { if (!FILM.on) return; FILM.on = false; clearTimeout(FILM.stopAt); filmLabel(); try { FILM.mr.stop(); } catch {} }

/* ---------- record its sound ----------
   Everything that plays goes through one point (the analyser the creature listens with). While this is on, that signal is
   copied, and when you stop it is saved as a 16-bit stereo WAV. */
const TAPE = { on: false };
function tapeToggle() { TAPE.on ? tapeStop() : tapeStart(); }
function tapeLabel() { const b = $('#gym-tape'); if (b) b.textContent = TAPE.on ? '■ stop sound' : '● sound'; }
function tapeStart() {
  const a = ac(); a.resume(); const n = a.createScriptProcessor(4096, 2, 2), mute = a.createGain(); mute.gain.value = 0;
  TAPE.L = []; TAPE.R = []; TAPE.len = 0; TAPE.slug = Gym.cur ? Gym.cur.slug : 'creature';
  n.onaudioprocess = e => { const ib = e.inputBuffer, l = ib.getChannelData(0), r = ib.numberOfChannels > 1 ? ib.getChannelData(1) : l; TAPE.L.push(new Float32Array(l)); TAPE.R.push(new Float32Array(r)); TAPE.len += l.length;
    if (TAPE.len > a.sampleRate * 900) tapeStop(); };                                    // fifteen minutes at most
  bus().connect(n); n.connect(mute); mute.connect(a.destination); TAPE.node = n; TAPE.mute = mute; TAPE.on = true; tapeLabel(); toast('recording sound. Touch it, drag it, play something.');
}
async function tapeStop() {
  if (!TAPE.on) return; TAPE.on = false; tapeLabel();
  try { bus().disconnect(TAPE.node); } catch {} try { TAPE.node.disconnect(); TAPE.mute.disconnect(); } catch {} TAPE.node.onaudioprocess = null;
  const n = TAPE.len, sr = ac().sampleRate; if (n < sr * .2) return toast('nothing was recorded');
  const buf = new ArrayBuffer(44 + n * 4), v = new DataView(buf), w = (o, t) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 4, true); w(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true); v.setUint32(24, sr, true); v.setUint32(28, sr * 4, true); v.setUint16(32, 4, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 4, true);
  let o = 44; for (let k = 0; k < TAPE.L.length; k++) { const l = TAPE.L[k], r = TAPE.R[k]; for (let i = 0; i < l.length; i++) { v.setInt16(o, Math.max(-1, Math.min(1, l[i])) * 32767, true); v.setInt16(o + 2, Math.max(-1, Math.min(1, r[i])) * 32767, true); o += 4; } }
  TAPE.L = TAPE.R = null;
  try { const r = await fetch(`/api/gym/${TAPE.slug}/tape`, { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: buf }).then(x => x.json()); toast(r.name ? `saved ${r.name} (${r.seconds}s)` : 'could not save the sound', !r.name); } catch (e) { toast('could not save the sound: ' + e.message, true); }
}

/* ---------- time-lapse ----------
   While it is on, a frame is taken at intervals and the frames are joined into a video. Each frame is drawn from a separate
   copy of the creature on a clock that advances one video frame at a time, so in the video it moves at its natural pace
   while its growth is sped up. Recording through a training run gives about a minute of video. */
async function gymRecToggle() {
  if (Gym.rec) return gymRecStop();
  const c = Gym.cur; if (!c || !NEB.ok) return;
  try { const r = await api(`/api/gym/${c.slug}/rec/start`, { method: 'POST' });
    Gym.rec = { slug: c.slug, id: r.id, i: 0, sent: 0, every: 0, next: 0, vt: performance.now() / 1000, seen: false, tail: -1, busy: false };
    toast('recording. Start training whenever you like; it stops by itself when training ends.'); gymRecLabel(); } catch (e) { toast('could not start recording: ' + e.message, true); }
}
function gymRecLabel() { const b = $('#gym-rec'); if (b) b.textContent = Gym.rec ? '■ stop time-lapse' : '● time-lapse'; }
async function gymRecStop() {
  const r = Gym.rec; if (!r) return; Gym.rec = null; gymRecLabel();
  if (!r.i) { toast('nothing was recorded'); return; }
  toast(`joining ${r.i} frames into a video…`);
  for (let k = 0; k < 40 && r.sent < r.i; k++) await sleep(150);                        // let the last uploads land
  try { const res = await api(`/api/gym/${r.slug}/rec/${r.id}/finish`, { json: { e0: r.e0 || 0, e1: r.e1 == null ? null : r.e1 } }); toast(`saved ${res.name} (${res.seconds}s)` + (res.sound_job ? ' · now giving it sound…' : ''));
    if (res.sound_job) for (;;) { await sleep(1500); const j = await api('/api/jobs/' + res.sound_job); if (j.state === 'done') { toast('time-lapse with sound saved: ' + ((j.outputs[0] || {}).name || '')); break; } if (j.state !== 'running') { toast('could not add sound: ' + (j.error || j.msg), true); break; } }
  } catch (e) { toast('could not make the video: ' + e.message, true); }
}
function gymRecTick(now) {
  const r = Gym.rec; if (!r || r.busy || NEB.shot || now < r.next) return;
  const c = (Gym.cur && Gym.cur.slug === r.slug ? Gym.cur : Gym.list.find(x => x.slug === r.slug)); if (!c) return gymRecStop();
  const tr = c.training && c.training.state === 'running' ? c.training : null;
  { const ep = tr ? tr.epoch : c.epochs; if (r.e0 == null) r.e0 = ep; r.e1 = Math.max(r.e1 || 0, ep); }   // which epochs this time-lapse covers, for its soundtrack
  if (tr) { r.seen = true; const pace = tr.remote ? c.pace_pc || .004 : c.pace; if (tr.stage === 'train' && pace && tr.audio_secs && !r.fixed) { r.fixed = true; r.every = clamp((tr.max_epochs - tr.epoch) * (tr.epoch_time || pace * tr.audio_secs + tr.tracks * (tr.remote ? .02 : .1)) / 1600, 1, 30); } }   // spread about 1600 frames over what is left
  else if (r.seen) { if (r.tail < 0) { r.tail = 60; r.every = .04; } else if (--r.tail <= 0) return gymRecStop(); }   // training has ended: hold on the result for two seconds, then finish
  r.next = now + (r.every || (tr ? 3 : .5)); r.busy = true; r.vt += 1 / 30;
  const rc = Object.assign({}, c, { slug: r.slug + '#rec' }); gymFx(rc, r.vt);
  NEB.shot = { t: r.vt, n: 0, frames: 5, slug: r.slug, rec: true, step: 1 / 30, size: 1920, c: rc, done: b => { const i = r.i++; r.busy = false;
    if (b) fetch(`/api/gym/${r.slug}/rec/${r.id}/frame/${i}`, { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: b }).catch(() => {}).finally(() => { r.sent++; }); else r.sent++; } };
}
setInterval(() => {                                                                      // if the window is hidden the normal frame loop stops: keep the time-lapse going from a timer
  const now = performance.now() / 1000; if (!Gym.rec || !Gym.open || !NEB.ok || now - (Gym.rafAt || 0) < 1.2) return;
  gymRecTick(now); for (let k = 0; k < 8 && NEB.shot && NEB.shot.rec && Gym.cur; k++) nebFrame(Gym.cur, now, null);
}, 700);

/* Ask a limb to sing: ACE-Step makes a short new clip in that limb's style (through the creature's adapter if it has trained),
   and the creature performs it. Until it has trained, you hear what the plain model makes of that limb's description. */
async function gymSing(c, limbId, track) {              // track: sing from this one of its tracks, not a random one
  if (track && c) { const f = c.food.find(x => x.name === track); if (f) limbId = f.limb || 0; }
  if (!c || !c.food.length) return toast('feed it first');
  if (c.training && c.training.state === 'running') return toast('it cannot sing while it trains: training has the GPU');
  if (Gym.sing) return toast('it is already composing…');
  const limb = (c.limbs || []).find(l => l.id === limbId) || null, m = limb ? limb.mean : dna(c);
  const caption = [limb && c.trained ? limb.trigger : '', c.trained ? c.tag : '', c.style || '', ...(limb ? limb.tags : []), 'instrumental'].filter(Boolean).join(', ');
  const params = { task: 'text2music', caption, lyrics: '[Instrumental]', duration: 14, thinking: false, batch: 1, seed: -1, creature: c.trained ? c.slug : '', creature_strength: 1 };
  if (m && m.bpm) params.bpm = Math.round(clamp(m.bpm, 50, 200));
  let label = `${c.name} sings`;
  Gym.sing = { slug: c.slug, limb: limbId == null ? 0 : limbId, t0: performance.now(), msg: 'listening to its tracks…' };
  try {
    try {                                                // it sings from a fresh collage of its own tracks, played back through what it has learned: never the same twice
      const sd = await api(`/api/gym/${c.slug}/seed`, { json: { limb: limb ? limb.id : null, track: track || '' } }), r = Math.random;
      Object.assign(params, { task: 'cover', src_audio: sd.path, bpm: sd.bpm, caption: caption.replace(/, instrumental$/, ''), cover_strength: +(.5 + r() * .4).toFixed(2), cover_noise_strength: +(.2 + r() * .22).toFixed(2), creature_strength: c.trained ? +(1.1 + r() * r() * .9).toFixed(2) : 1 });   // measured: .2 keeps the passage's shape and colour but none of its waveform, .35 keeps most of it
      label = `${c.name} sings · from ${sd.tracks[0].replace(/\.[a-z0-9]+$/i, '')}`;
      toast(`it is composing from “${sd.tracks[0].replace(/\.[a-z0-9]+$/i, '')}”` + (c.trained ? '' : ' (it has not trained yet, so the plain model plays them back)'));
    } catch (e) { toast(c.trained ? 'its tracks could not be read, so it composes from words alone' : 'it has not trained yet: this is the plain model\'s guess at that limb'); }
    const { id } = await api('/api/run', { json: { engine: 'ace_step', params, label } });
    for (;;) { await sleep(500); const j = await api('/api/jobs/' + id); Gym.sing.id = id; Gym.sing.frac = j.frac || 0; Gym.sing.msg = (j.msg || 'composing…') + (j.frac != null ? ` · ${Math.round(j.frac * 100)}%` : '');
      if (j.state === 'done') { const out = (j.outputs || [])[0]; if (!out) throw new Error('nothing came back'); gymPlayPath(out.path); toast('it sings (saved to the library)'); break; }
      if (j.state === 'error' || j.state === 'cancelled') throw new Error((j.error || j.msg || 'failed').split('\n')[0]); }
  } catch (e) { toast('it could not sing: ' + (e.message || e), true); }
  Gym.sing = null;
}
function gymPlayPath(path) { gymPlay(null, 'song ' + Date.now(), '/api/file?path=' + encodeURIComponent(path)); }
function gymPlay(slug, name, url, label) {
  if (!Gym.audio) { Gym.audio = new Audio(); Gym.audio.crossOrigin = 'anonymous'; try { ac().createMediaElementSource(Gym.audio).connect(bus()); } catch (e) {} Gym.audio.onended = () => { Gym.playing = null; Gym.key = ''; gymRender(); }; }
  if (Gym.playing === name) { Gym.audio.pause(); Gym.playing = null; }
  else { ac().resume(); Gym.audio.src = url || `/api/gym/${slug}/food/${encodeURIComponent(name)}`; Gym.audio.play().catch(e => toast('could not play that file: ' + e.message, true)); Gym.playing = name; }
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
          return h('label', { class: 'pick-row', title: f.rel }, cb, h('span', {}, (f.video ? '▸ ' : '') + (gname ? f.rel.slice(gname.length + 1) : f.rel)), h('small', {}, `${fmt(f.secs)} · ${f.mb} MB`)); }));
    }));
    update();
  };
  minIn.oninput = filt.oninput = draw;
  const box = h('div', { id: 'gym-picker' },
    h('div', { class: 'drawer-head' }, h('span', {}, res.name), h('button', { onclick: () => box.remove() }, '×')),
    h('p', { class: 'gym-note' }, `Found ${res.files.length} audio and video files (▸ marks videos: only their sound is used). Tick the finished tracks that sound like the creature you want. Loops, stems and one-shots teach it less. Files are linked where they are, not copied.`),
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
  if (!list.length) { toast('no creatures yet — open the vivarium and hatch one'); return; }
  p.replaceChildren(h('div', { style: 'font:10px var(--mono);color:var(--muted);padding:4px 8px;letter-spacing:.12em' }, 'FEED TO…'), ...list.map(c => h('button', { style: `--c:hsl(${hueOf(dna(c).bright)},90%,60%)`, onclick: async () => {
    closePalette(); try { await api(`/api/gym/${c.slug}/feed?path=` + encodeURIComponent(path), { method: 'POST' }); toast(`“${c.name}” ate it`); } catch (e) { toast(String(e.message || e), true); } } }, h('i'), c.name, h('small', {}, c.food.length + ' tracks'))));
  p.style.left = Math.min(ev.clientX, innerWidth - 270) + 'px'; p.style.top = Math.min(ev.clientY, innerHeight - 300) + 'px'; p.hidden = false;
}

$('#btn-gym').onclick = () => openGym();

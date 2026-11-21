/* The entity as a nebula, rendered on the GPU.
   A fragment shader marches rays through a 3D volume of dust and glowing gas, so there are no lines or particles:
   - pillars: one per limb (group of tracks). Their size follows how much that limb ate; colour follows its brightness.
   - dust: opaque, eroded by noise, lit by one moving light with real self-shadowing (dark cores, bright rims).
     Untrained it is soft fog; training sharpens it into sculpted forms.
   - gas: faint emissive haze around and between the pillars. Voids are cavities carved out of both.
   - stars: one ignites inside the dust every 25 epochs, and lights the dust around it.
   - resonance: every pillar emits waves at its limb's tempo. They cross, reflect and interfere, so the dust shows standing
     patterns. Touches, beats and feeding send shock fronts that echo three times. After sound stops it rings on, like reverb.
   Live audio swells the pillars, stirs the dust and makes the rims sparkle. */
'use strict';

const NEB = { ok: null, canvas: null, gl: null, U: {}, q: .7, acc: 0, frames: 0, last: 0, drag: { on: false, s: 0, p: [0, 0, 0], v: null } };

const NEB_FRAG = `
precision highp float;
uniform vec2 uRes, uCenter;
uniform float uT, uTan, uDist, uSeed;
uniform mat3 uCam;
uniform sampler2D uNoise;
uniform vec4 uPole[6];   // xyz base, w radius
uniform vec4 uAxis[6];   // xyz direction, w length
uniform vec4 uCol[6];    // rgb tint, w weight (0 = off)
uniform vec4 uVoid[3];   // xyz, w radius
uniform vec4 uWave[8];   // xyz origin, w radius
uniform float uWaveAmp[8];
uniform vec4 uRip[6];    // per pillar: wavenumber, angular speed, phase, strength
uniform vec4 uReson;     // ripple depth, reverb tail, reflected share, unused
uniform vec4 uStar[8];   // xyz, w brightness
uniform vec4 uAud;       // bass, mid, high, level
uniform vec4 uLife;      // learned, growth, turbulence, kick
uniform vec3 uLight, uKey, uAmb;
uniform float uB, uFrame;
uniform vec4 uTouch;     // xyz where the pointer is dragging, w strength
const int STEPS = 80;

float n3(vec3 x) {
  vec3 p = floor(x), f = fract(x); f = f * f * (3. - 2. * f);
  vec2 uv = (p.xy + vec2(37., 17.) * p.z) + f.xy;
  vec2 rg = texture2D(uNoise, (uv + .5) / 256.).yx;
  return mix(rg.x, rg.y, f.z);
}
float fbm(vec3 p) {                         // four octaves; the third doubles as a ridged layer for filaments
  float a = n3(p); p = p * 2.03 + vec3(1.7, 9.2, 3.1); float b = n3(p); p = p * 2.03 + vec3(1.7, 9.2, 3.1); float c = n3(p); p = p * 2.03 + vec3(1.7, 9.2, 3.1); float d = n3(p);
  return (.5 * a + .25 * b + .125 * c + .07 * d) * .8 + (1. - abs(2. * c - 1.)) * .2;
}
float fbm2(vec3 p) { return .62 * n3(p) + .31 * n3(p * 2.03 + vec3(1.7, 9.2, 3.1)); }

float shapes(vec3 q, out vec3 tint, out float halo) {
  float d = 0.; tint = vec3(0.); halo = 0.;
  for (int i = 0; i < 6; i++) {
    float w = uCol[i].w;
    if (w > 0.) {
      vec3 ba = uAxis[i].xyz * uAxis[i].w, pa = q - uPole[i].xyz;
      float h = clamp(dot(pa, ba) / dot(ba, ba), 0., 1.), r0 = uPole[i].w;
      float sd = length(pa - ba * h) - r0 * (1. - .5 * h);
      float di = smoothstep(.9, -.6, sd / r0) * w, hl = smoothstep(2.6, -.4, sd / r0) * w;
      d += di; halo += hl * hl; tint += uCol[i].rgb * (di + hl * .25);
    }
  }
  tint /= max(d + halo * .25, 1e-3);
  return min(d, 1.5);
}
float nearest(vec3 p) {                      // distance to the outer edge of anything visible; lets rays leap over empty space
  float m = 1e3;
  for (int i = 0; i < 6; i++) {
    if (uCol[i].w > 0.) { vec3 ba = uAxis[i].xyz * uAxis[i].w, pa = p - uPole[i].xyz; float h = clamp(dot(pa, ba) / dot(ba, ba), 0., 1.); m = min(m, length(pa - ba * h) - uPole[i].w * 2.7 - .75); }
  }
  return m;
}
float ripples(vec3 q) {                      // every pillar emits sound; the waves cross, reflect and interfere
  float r = 0.;
  for (int i = 0; i < 6; i++) {
    float w = uCol[i].w;
    if (w > 0.) {
      vec3 ba = uAxis[i].xyz * uAxis[i].w, pa = q - uPole[i].xyz;
      float h = clamp(dot(pa, ba) / dot(ba, ba), 0., 1.), dl = length(pa - ba * h), ph = dl * uRip[i].x + uRip[i].z;
      r += (sin(ph - uT * uRip[i].y) + uReson.z * sin(ph * 1.07 + uT * uRip[i].y * .93)) * uRip[i].w * w / (1. + dl * .55);
    }
  }
  return r;
}
float carve(vec3 q) {
  float c = 1.;
  for (int k = 0; k < 3; k++) { float r = uVoid[k].w; if (r > 0.) c *= smoothstep(r * .5, r * 1.5, length(q - uVoid[k].xyz)); }
  return c;
}
float dustLo(vec3 q) {                       // cheap density, for shadows
  vec3 tt; float hl; float sh = shapes(q, tt, hl);
  if (sh < .02) return 0.;
  return smoothstep(-.3, .3, sh + (fbm2(q * 1.6 + vec3(0., -uT * .03, uT * .015) + uSeed) - .47) * 1.6 - .8) * carve(q);
}

void main() {
  vec2 uv = (gl_FragCoord.xy - uCenter) / (.5 * min(uRes.x, uRes.y));
  vec3 rd = normalize(uCam * vec3(uv * uTan, -1.)), ro = uCam * vec3(0., 0., uDist);

  // deep space behind it
  vec3 sd3 = rd * 3.;
  float cloud = n3(sd3 + uSeed) * n3(sd3 * 2.3 + 7.);
  vec3 bg = vec3(.006, .006, .016) + uAmb * .05 * cloud + uKey * .012 * n3(sd3 * 1.3 - 4.);
  vec3 gd = rd * 110., cell = floor(gd);
  float hs = fract(sin(dot(cell, vec3(127.1, 311.7, 74.7))) * 43758.5453);
  float tw = .7 + .3 * sin(uT * (1. + hs * 3.) + hs * 40.);
  bg += vec3(.9, .95, 1.) * step(.9972, hs) * smoothstep(.45, 0., length(fract(gd) - .5)) * tw * (.5 + fract(hs * 57.) * .9);

  vec3 C = vec3(0.); float T = 1.;
  float B = uB, b = dot(ro, rd), cc = dot(ro, ro) - B * B, h = b * b - cc;
  if (h > 0.) {
    h = sqrt(h);
    float t0 = max(-b - h, 0.), t1 = -b + h, dt = (t1 - t0) / float(STEPS);
    float t = t0 + dt * fract(texture2D(uNoise, gl_FragCoord.xy / 256.).b + uFrame * .618034);
    float turb = 1.1 + uLife.z * 1.4, tt = uT * .035;
    for (int i = 0; i < STEPS; i++) {
      vec3 p = ro + rd * t;
      float far = nearest(p);
      if (far > 0.) { t += max(dt, far * .85); if (t > t1) break; continue; }
      t += dt; if (t > t1 + dt) break;
      vec3 s = p * .45 + uSeed;
      vec3 w = (vec3(n3(s + vec3(0., tt, 0.)), n3(s + vec3(31.4, -tt, 7.7)), n3(s + vec3(5.2, 13.1, tt))) - .5) * turb;
      vec3 q = p + w; float ring = 0.;
      for (int k = 0; k < 8; k++) {            // shock fronts from touch, feeding, beats, and their echoes
        float a = uWaveAmp[k];
        if (a > 0.) { vec3 e = q - uWave[k].xyz; float el = length(e) + 1e-3, dw = (el - uWave[k].w) * 2.2, g = exp(-dw * dw) * a; q += e / el * g * .3; ring += g; }
      }
      if (uTouch.w > 0.) { vec3 e2 = q - uTouch.xyz; float tg = exp(-dot(e2, e2) * 2.6) * uTouch.w; q += normalize(e2 + 1e-4) * tg * .4; ring += tg * .7; }   // your finger in the dust
      vec3 tint; float halo; float sh = shapes(q, tint, halo);
      if (halo + sh < .012) continue;
      float cv = carve(q);
      float rip = ripples(q) * uReson.x;
      float haze = n3(q * .7 + vec3(0., uT * .02, 3.)), wisp = w.x / turb + .5;
      float gas = (halo * .55 + sh * .25) * haze * haze * (.45 + wisp) * cv * max(0., 1. + rip * 2.4);
      C += T * mix(uAmb, tint, .45 + .4 * clamp(sh, 0., 1.)) * gas * dt * (.62 + ring * 2.5 + uAud.w * .6);
      if (sh > .02) {
        vec3 fq = q * 1.6 + vec3(0., -uT * .03, uT * .015) + uSeed;
        float f = fbm(fq);
        float soft = mix(.5, .1, uLife.x);
        float dust = smoothstep(-soft, soft, sh + (f - .47) * 1.6 - .8 + rip * .34) * cv * mix(.45, 1., uLife.x);
        if (dust > .01) {
          vec3 l = normalize(uLight - p);
          float shd = exp(-dustLo(q + l * .34) * 8.5);
          vec3 alb = mix(tint, vec3(.62, .46, .36), .4);                       // dusty, a little warm
          vec3 lit = alb * (uKey * shd * 1.45 + uAmb * .07) + tint * (1. - dust) * .26;   // thin edges glow in their own colour
          for (int k = 0; k < 8; k++) { float sb = uStar[k].w; if (sb > 0.) { vec3 ds = uStar[k].xyz - p; lit += alb * vec3(1., .9, .8) * sb * .5 / (dot(ds, ds) * 6. + .15); } }
          lit *= 1. + uAud.z * 1.6 * n3(q * 7. + uT * 2.) * (1. - dust) + ring * 1.5 + max(0., rip) * 1.1;
          float a = 1. - exp(-dust * dt * 9.);
          C += T * a * lit; T *= 1. - a;
          if (T < .02) break;
        }
      }
    }
  }
  for (int k = 0; k < 8; k++) {                // the stars themselves
    float sb = uStar[k].w;
    if (sb > 0.) { vec3 so = uStar[k].xyz - ro; float tc = dot(so, rd); vec3 dv = so - rd * tc; C += vec3(1., .93, .86) * sb * (.0022 / (dot(dv, dv) + .0005)) * mix(1., T, .55) * step(0., tc); }
  }
  C += bg * T;
  C *= 1. + uLife.w * .35;
  C = 1. - exp(-C * 1.35);
  C = pow(C, vec3(.92));
  vec2 vv = gl_FragCoord.xy / uRes - .5;
  C *= 1. - dot(vv, vv) * .55;
  C += (texture2D(uNoise, gl_FragCoord.xy / 256. + .37).g - .5) / 255.;
  gl_FragColor = vec4(C, 1.);
}`;

function nebInit(cv) {
  const gl = cv.getContext('webgl', { antialias: false, alpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: false });
  if (!gl) throw new Error('no webgl');
  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
  const pr = gl.createProgram();
  gl.attachShader(pr, sh(gl.VERTEX_SHADER, 'attribute vec2 a; void main(){ gl_Position = vec4(a, 0., 1.); }'));
  gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, NEB_FRAG)); gl.linkProgram(pr);
  if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(pr));
  gl.useProgram(pr);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer()); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(pr, 'a'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  // noise texture: G is R shifted by (37,17), which lets one fetch give two layers of 3D noise
  const N = 256, px = new Uint8Array(N * N * 4), r = new Uint8Array(N * N);
  let x = 1234567; const rnd = () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return (x >>> 0) & 255; };
  for (let i = 0; i < N * N; i++) r[i] = rnd();
  for (let y = 0; y < N; y++) for (let xx = 0; xx < N; xx++) { const o = (y * N + xx) * 4; px[o] = r[y * N + xx]; px[o + 1] = r[((y - 17) & 255) * N + ((xx - 37) & 255)]; px[o + 2] = rnd(); px[o + 3] = 255; }
  gl.bindTexture(gl.TEXTURE_2D, gl.createTexture()); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, N, N, 0, gl.RGBA, gl.UNSIGNED_BYTE, px);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  for (const n of ['uRes', 'uCenter', 'uT', 'uTan', 'uDist', 'uSeed', 'uCam', 'uNoise', 'uPole', 'uAxis', 'uCol', 'uVoid', 'uWave', 'uWaveAmp', 'uStar', 'uAud', 'uLife', 'uLight', 'uKey', 'uAmb', 'uB', 'uFrame', 'uRip', 'uReson', 'uTouch']) NEB.U[n] = gl.getUniformLocation(pr, n);
  gl.uniform1i(NEB.U.uNoise, 0);
  NEB.gl = gl;
}
function nebCanvas() {                            // one canvas and one GL context for the life of the app
  if (!NEB.canvas) { NEB.canvas = document.createElement('canvas'); NEB.canvas.id = 'gym-canvas'; try { nebInit(NEB.canvas); NEB.ok = true; } catch (e) { NEB.ok = false; console.warn('nebula renderer unavailable, using the 2D one:', e.message); NEB.canvas = document.createElement('canvas'); NEB.canvas.id = 'gym-canvas'; } }
  if (NEB.ok && !NEB.bound) {                     // click = touch, drag = stir and bow
    NEB.bound = true; const cv = NEB.canvas; let down = null;
    cv.addEventListener('mousedown', e => { down = { x: e.offsetX, y: e.offsetY, moved: false, t: performance.now(), lx: e.offsetX, ly: e.offsetY }; });
    cv.addEventListener('mousemove', e => { if (!down || !(e.buttons & 1)) return; if (!down.moved && Math.hypot(e.offsetX - down.x, e.offsetY - down.y) < 6) return;
      const now = performance.now(), sp = Math.hypot(e.offsetX - down.lx, e.offsetY - down.ly) / Math.max(8, now - down.t) * 1000; down.moved = true; down.lx = e.offsetX; down.ly = e.offsetY; down.t = now; nebDrag(e.offsetX, e.offsetY, sp); });
    const up = e => { if (down && !down.moved && e.type === 'mouseup') nebTouch(down.x, down.y); down = null; nebDragEnd(); };
    cv.addEventListener('mouseup', up); cv.addEventListener('mouseleave', up);
  }
  return NEB.canvas;
}

const hsl2rgb = (h, s, l) => { h = ((h % 360) + 360) % 360 / 360; const q = l < .5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q, f = t => { t = (t + 1) % 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < .5 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; }; return [f(h + 1 / 3), f(h), f(h - 1 / 3)]; };
const nvec = (t, k) => [noise(t + k), noise(t * 1.07 + k + 31.7), noise(t * .93 + k + 77.1)];

function nebFrame(c, t, mouse) {
  const gl = NEB.gl, cv = NEB.canvas, U = NEB.U, d = dna(c), fx = fxOf(c.slug), n = d.n, sd = d.seed * 100;
  // resolution: as sharp as this machine can hold at full frame rate
  if (NEB.last) { NEB.acc += Math.min(.1, t - NEB.last); if (++NEB.frames >= 40) { const ms = NEB.acc / NEB.frames * 1000; NEB.ms = ms; if (ms > 19) { NEB.cap = NEB.q; NEB.capT = t; NEB.q = Math.max(.35, NEB.q * .86); } else if (ms < 17.4) { if (NEB.cap && t - NEB.capT > 25) NEB.cap = 0; NEB.q = Math.min(1, NEB.cap ? NEB.cap * .9 : 1, NEB.q * 1.07); } NEB.acc = 0; NEB.frames = 0; } }
  NEB.last = t;
  if (NEB.frames === 0 && NEB.hud !== false) { const hud = document.getElementById('gym-fps'); if (hud && NEB.ms) hud.textContent = `${Math.round(1000 / NEB.ms)} fps · ${cv.width}×${cv.height}`; }
  const dpr = devicePixelRatio || 1, cw = cv.clientWidth, ch = cv.clientHeight, sc = dpr * NEB.q, W = Math.max(2, Math.round(cw * sc)), H = Math.max(2, Math.round(ch * sc));
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
  gl.viewport(0, 0, W, H);

  const au = audioLevels(), lv = au ? au.level : 0, S = Math.min(cw, ch), cx0 = cw / 2, cy0 = ch / 2 * .94;
  const L = live(fx, d, t, mouse, cx0, cy0, S, au), kick = Math.exp(-(t - L.beat) * 7), dt = L.dt || .016, ease = Math.min(1, dt * 1.7);
  const cx = cx0 + L.dx, cy = cy0 + L.dy;

  // camera
  const cy_ = Math.cos(L.yaw), sy_ = Math.sin(L.yaw), cp = Math.cos(L.pitch * .7), sp = Math.sin(L.pitch * .7), cr = Math.cos(L.roll * .6), sr = Math.sin(L.roll * .6);
  const M = [[cy_ * cr + sy_ * sp * sr, -cy_ * sr + sy_ * sp * cr, sy_ * cp], [cp * sr, cp * cr, -sp], [-sy_ * cr + cy_ * sp * sr, sy_ * sr + cy_ * sp * cr, cy_ * cp]];   // Ry * Rx * Rz
  const dist = 9, grow = n ? .98 + .1 * clamp(d.minutes / 30, 0, 1) + .14 * d.growth : .55, tan = .56 / grow * (1 + .04 * (L.breath - .5));
  const rot = v => [M[0][0] * v[0] + M[0][1] * v[1] + M[0][2] * v[2], M[1][0] * v[0] + M[1][1] * v[1] + M[1][2] * v[2], M[2][0] * v[0] + M[2][1] * v[1] + M[2][2] * v[2]];
  const toCam = p => [M[0][0] * p[0] + M[1][0] * p[1] + M[2][0] * p[2], M[0][1] * p[0] + M[1][1] * p[1] + M[2][1] * p[2], M[0][2] * p[0] + M[1][2] * p[1] + M[2][2] * p[2]];
  const proj = p => { const q = toCam(p), depth = dist - q[2]; return [cx + q[0] / (depth * tan) * S / 2, cy - q[1] / (depth * tan) * S / 2, depth]; };
  const unproj = (px, py, depth) => rot([(px - cx) / (S / 2) * depth * tan, -(py - cy) / (S / 2) * depth * tan, dist - depth]);

  // the pillars: one per limb, eased toward where they should be so feeding and training make it grow and morph
  const limbs = c.limbs && c.limbs.length > 1 ? c.limbs : null, K = n ? Math.min(6, Math.max(2, limbs ? limbs.length : 0) + (n > 12 ? 1 : 0)) : 1;
  const N = fx.neb || (fx.neb = { slots: [...Array(6)].map(() => ({ p: [0, 0, 0], a: [0, 1, 0], len: .3, rad: .3, col: [.5, .3, .8], w: 0, ring: 0 })), fresh: true });
  const pointer = mouse ? unproj(L.sx, L.sy, dist) : null;
  N.slots.forEach((s, j) => {
    const on = j < K, limb = limbs && limbs[j], share = limb ? limb.count / n : 1 / K;
    const yy = K > 1 ? 1 - 2 * (j + .5) / K : 0, rr = Math.sqrt(1 - yy * yy), ph = j * 2.39996 + d.seed * 6.28, base = [Math.cos(ph) * rr, yy * .75, Math.sin(ph) * rr];
    const wn = nvec(t * .045, j * 13 + sd), an = nvec(t * .038, j * 29 + sd + 50), spread = n ? .75 + .45 * d.growth : 0;
    const tp = [base[0] * spread + wn[0] * .45, base[1] * spread + wn[1] * .45 - .5, base[2] * spread + wn[2] * .45];
    let ta = [base[0] * .9 + an[0] * 1.1, base[1] * .9 + an[1] * 1.1 + .55, base[2] * .9 + an[2] * 1.1];
    if (pointer && L.curious > .05) for (let k = 0; k < 3; k++) ta[k] += (pointer[k] - tp[k]) * .12 * L.curious;      // it leans toward you when curious
    const al = Math.hypot(ta[0], ta[1], ta[2]) || 1; ta = ta.map(v => v / al);
    const tl = n ? (1.1 + 2.0 * d.growth + .5 * clamp(d.minutes / 30, 0, 1)) * (.55 + .9 * Math.sqrt(share)) * (1 + .06 * (L.breath - .5)) : .5;
    const trd = (n ? .4 + .5 * Math.sqrt(share) : .45) * (1 + (au ? au.bass * .38 : 0) + kick * .1) * (1 - .18 * L.startle) * (1 + s.ring * .22 * Math.sin(t * 19));
    const tc = hsl2rgb(hueOf(limb ? limb.mean.bright : d.bright) + (limb ? 0 : j * 24) + noise(t * .02 + j + sd) * 14, .72, .56), tw = on ? (limb || !limbs ? 1 : .6) : 0, e = N.fresh ? 1 : ease;
    for (let k = 0; k < 3; k++) { s.p[k] += (tp[k] - s.p[k]) * e; s.a[k] += (ta[k] - s.a[k]) * e; s.col[k] += (tc[k] - s.col[k]) * e; }
    s.len += (tl - s.len) * e * .6; s.rad += (trd - s.rad) * Math.min(1, e * 4); s.w += (tw - s.w) * e; s.ring *= Math.exp(-dt * 2.2);
  });
  N.fresh = false;
  const pole = new Float32Array(24), axis = new Float32Array(24), col = new Float32Array(24);
  N.slots.forEach((s, j) => { pole.set([s.p[0], s.p[1], s.p[2], s.rad], j * 4); axis.set([s.a[0], s.a[1], s.a[2], s.len], j * 4); col.set([s.col[0], s.col[1], s.col[2], s.w < .01 ? 0 : s.w], j * 4); });

  // voids: wandering cavities
  const nv = n ? 1 + (K > 2 ? 1 : 0) + (K > 4 ? 1 : 0) : 0, voids = new Float32Array(12), vlist = [];
  for (let k = 0; k < nv; k++) { const w = nvec(t * .04, k * 41 + sd + 9), s = N.slots[k % K], p = [s.p[0] + s.a[0] * s.len * .45 + w[0] * 1.1, s.p[1] + s.a[1] * s.len * .45 + w[1] * 1.1, s.p[2] + s.a[2] * s.len * .45 + w[2] * 1.1], r = (.34 + .16 * noise(t * .06 + k * 7 + sd)) * (1 + kick * .25 + L.startle * .5);
    voids.set([p[0], p[1], p[2], r], k * 4); vlist.push({ p, r }); }

  // shock fronts
  fx.waves = fx.waves.filter(w => t - w.t0 < 5);
  const wave = new Float32Array(32), wamp = new Float32Array(8), taps = [];
  for (const w of fx.waves) for (const [dly, amp] of [[0, 1], [.55, .55], [1.15, .3], [1.85, .16]]) {           // each front echoes, like reverb taps
    const age = t - w.t0 - dly; if (age < 0 || age > 2.6) continue;
    const sl = N.slots[(w.pole || 0) % K], o = w.o || [sl.p[0] + sl.a[0] * sl.len * .5, sl.p[1] + sl.a[1] * sl.len * .5, sl.p[2] + sl.a[2] * sl.len * .5];
    taps.push({ o, r: age * 2.1, a: (1 - age / 2.6) * (w.soft ? .5 : 1) * amp });
  }
  taps.sort((a, b) => b.a - a.a).slice(0, 8).forEach((tp, k) => { wave.set([tp.o[0], tp.o[1], tp.o[2], tp.r], k * 4); wamp[k] = tp.a; });

  // resonance: each pillar emits at its limb's tempo; the tail keeps everything ringing after sound stops
  L.tail = Math.max(lv, (L.tail || 0) * Math.exp(-dt / 1.3));
  const rip = new Float32Array(24);
  N.slots.forEach((sl, j) => { const limb = limbs && limbs[j], bpm = (limb && limb.mean.bpm) || d.bpm || 100, br = limb ? limb.mean.bright : d.bright;
    rip.set([2 * Math.PI / (.85 - .5 * clamp(br, 0, 1) + .2 * (120 / clamp(bpm, 60, 200))), bpm / 60 * Math.PI * (d.training ? 1.5 : 1), j * 1.9 + d.seed * 9, .75 + .25 * noise(t * .1 + j * 3 + sd)], j * 4); });
  const depth = n ? clamp((.07 + .2 * d.learned + .1 * d.growth) * (1 + L.tail * 2.6) + kick * .15 + L.startle * .1, 0, .7) : .03;

  // stars: one ignites every 25 epochs
  const ns = Math.min(8, Math.floor(d.epochs / 25) + (d.training ? 1 : 0)), star = new Float32Array(32);
  for (let k = 0; k < ns; k++) { const s = N.slots[k % K], hh = hash(c.slug + 'star' + k), u = .55 + hh * .5, o = nvec(t * .03, k * 17 + sd), newest = d.training && k === ns - 1;
    star.set([s.p[0] + s.a[0] * s.len * u + o[0] * .25, s.p[1] + s.a[1] * s.len * u + o[1] * .25, s.p[2] + s.a[2] * s.len * u + o[2] * .25,
      (.55 + .3 * hh + .2 * noise(t * 1.3 + k * 9) + (au ? au.high * .8 : 0)) * (newest ? .25 + .75 * Math.abs(noise(t * 7)) : 1)], k * 4); }

  const hue = hueOf(d.bright) + noise(t * .02 + sd) * 16 + (au ? (au.high - au.bass) * 40 : 0), lw = nvec(t * .05, sd + 200);
  const light = [lw[0] * 3.2 + (pointer ? pointer[0] * .5 * L.curious : 0), 3 + lw[1] * 1.2 + (pointer ? pointer[1] * .5 * L.curious : 0), lw[2] * 3.2 + 1.5];
  const key = hsl2rgb(hue + 30, .35, .82), amb = hsl2rgb(hue + 50 + d.seed * 140, .85, .5);
  const turb = (n ? (1 - d.learned) * (d.epochs ? .45 : .7) : .5) + lv * .9 + L.startle * .8 + (d.digesting ? .4 : 0) + (d.training ? .15 : 0);
  gl.uniform2f(U.uRes, W, H); gl.uniform2f(U.uCenter, cx * sc, (ch - cy) * sc);
  gl.uniform1f(U.uT, t % 10000 * (d.training ? 1.5 : 1)); gl.uniform1f(U.uTan, tan); gl.uniform1f(U.uDist, dist); gl.uniform1f(U.uSeed, d.seed * 40);
  gl.uniformMatrix3fv(U.uCam, false, [M[0][0], M[1][0], M[2][0], M[0][1], M[1][1], M[2][1], M[0][2], M[1][2], M[2][2]]);
  gl.uniform4fv(U.uPole, pole); gl.uniform4fv(U.uAxis, axis); gl.uniform4fv(U.uCol, col); gl.uniform4fv(U.uVoid, voids);
  gl.uniform4fv(U.uWave, wave); gl.uniform1fv(U.uWaveAmp, wamp); gl.uniform4fv(U.uRip, rip); gl.uniform4f(U.uReson, depth, L.tail, .35 + .4 * d.learned, 0); gl.uniform4fv(U.uStar, star);
  gl.uniform4f(U.uAud, au ? au.bass : 0, au ? au.mid : 0, au ? au.high : 0, lv);
  gl.uniform4f(U.uLife, n ? (d.epochs ? .4 + .6 * Math.max(d.learned, d.growth * .8) : .3) : .1, d.growth, turb, kick + (d.training ? .15 : 0));
  let ext = 1.5; N.slots.forEach(sl => { if (sl.w > .01) ext = Math.max(ext, Math.hypot(sl.p[0] + sl.a[0] * sl.len, sl.p[1] + sl.a[1] * sl.len, sl.p[2] + sl.a[2] * sl.len) + sl.rad * 3.4, Math.hypot(...sl.p) + sl.rad * 3.4); });
  gl.uniform1f(U.uB, Math.min(6, ext + .8)); gl.uniform1f(U.uFrame, (NEB.fr = (NEB.fr || 0) + 1) % 1024);
  const D = NEB.drag; D.s += ((D.on ? 1 : 0) - D.s) * Math.min(1, dt * (D.on ? 9 : 2.2)); gl.uniform4f(U.uTouch, D.p[0], D.p[1], D.p[2], D.s < .01 ? 0 : D.s);
  gl.uniform3fv(U.uLight, light); gl.uniform3fv(U.uKey, key); gl.uniform3fv(U.uAmb, amb);
  gl.drawArrays(gl.TRIANGLES, 0, 3);

  // where things are on screen, for touch
  fx.ngeom = { K, proj, unproj, dist, growth: d.growth, learned: d.learned,
    lobes: N.slots.slice(0, K).map((s, j) => { const a = proj(s.p), b3 = [s.p[0] + s.a[0] * s.len, s.p[1] + s.a[1] * s.len, s.p[2] + s.a[2] * s.len], b = proj(b3); return { j, a, b, a3: s.p.slice(), b3, r: s.rad / (a[2] * tan) * S / 2, slot: s }; }),
    voids: vlist.map(v => { const p = proj(v.p); return { x: p[0], y: p[1], r: v.r / (p[2] * tan) * S / 2 * 1.1, p: v.p, depth: p[2] }; }) };
}

/* touch: a void, a pillar (and where along it), the haze around it, or empty space each answer differently */
function nebTouch(x, y) {
  const c = Gym.cur; if (!c) return; const fx = fxOf(c.slug), G = fx.ngeom, L = fx.life; if (!G || !L) return;
  ac().resume(); const t = performance.now() / 1000, gr = G.growth, pure = clamp(.25 * gr + .75 * G.learned, 0, 1), rnd = Math.random;
  const v = G.voids.find(o => Math.hypot(o.x - x, o.y - y) < o.r);
  if (v) {                                           // a void: it flinches and answers from deep down
    const base = 41 * ALIEN_SCALE[G.voids.indexOf(v) * 2 % 7] * (1 + rnd() * .02);
    tone(base, { dur: 1.6 + gr * 3, attack: .12, gain: .22, partials: 1 + Math.round(gr * 5), detune: (1 - pure) * .05, bend: -.12 * (1 - pure), noise: (1 - pure) * .25, noiseAt: 1.5 });
    tone(base * 2 * ALIEN_SCALE[4], { dur: 1 + gr * 2.5, attack: .3, gain: .07 * (.3 + pure), when: .08, detune: (1 - pure) * .03 });
    L.startle = 1; fx.waves.push({ t0: t, o: v.p }); return;
  }
  let best = null;
  for (const o of G.lobes) { const ex = o.b[0] - o.a[0], ey = o.b[1] - o.a[1], u = clamp(((x - o.a[0]) * ex + (y - o.a[1]) * ey) / (ex * ex + ey * ey || 1), 0, 1), dd = Math.hypot(x - o.a[0] - ex * u, y - o.a[1] - ey * u) / (o.r * (1 - .5 * u) || 1); if (!best || dd < best.dd) best = { o, u, dd }; }
  if (best && best.dd < 1.15 && c.food.length) {       // a pillar: it sings the track that lives at that height
    const o = best.o, mem = c.food.filter((f, i) => (c.limbs && c.limbs.length > 1 ? (f.limb || 0) % G.K : i % G.K) === o.j).sort((a, b) => (a.core || 0) - (b.core || 0));
    const f = mem.length ? mem[Math.min(mem.length - 1, Math.floor(best.u * mem.length))] : c.food[0], fq = noteOf(f.bright ?? .3) * (1 + (rnd() - .5) * .01);
    tone(fq, { dur: .45 + gr * 2.6, gain: .2, type: pure > .5 ? 'sine' : 'triangle', partials: 1 + Math.round(gr * 4), detune: (1 - pure) * .045, bend: -(1 - pure) * .07, noise: (1 - pure) * .4 + .03, noiseAt: 3 });
    if (gr > .3) tone(fq * ALIEN_SCALE[4], { dur: .4 + gr * 2, gain: .06 * gr, when: .06 + rnd() * .05, detune: (1 - pure) * .03 });
    o.slot.ring = 1; fx.waves.push({ t0: t, o: o.a3.map((a, k) => a + (o.b3[k] - a) * best.u), soft: true }); return;
  }
  if (best && best.dd < 3.2) {                         // the haze: a glassy chime, and a shock front from that spot
    tone(320 + rnd() * 900, { dur: .9 + gr * 2.2, gain: .12, ratios: [1, 2.76, 5.4, 8.93].slice(0, 2 + Math.round(gr * 2)), detune: (1 - pure) * .03, noise: (1 - pure) * .18, noiseAt: 4 });
    fx.waves.push({ t0: t, o: G.unproj(x, y, best.o.a[2]) }); return;
  }
  tone(700 + rnd() * 1400, { dur: .22 + gr * .3, gain: .07, bend: rnd() > .5 ? 1.2 : -.6 });   // empty space: a chirp, and it notes where
  fx.waves.push({ t0: t, o: G.unproj(x, y, G.dist), soft: true }); L.sx = x; L.sy = y;
}

/* small still-ish portrait for the creature list */
function drawMini(g, W, H, c, t) {
  const d = dna(c), limbs = c.limbs && c.limbs.length > 1 ? c.limbs : null, K = d.n ? Math.max(2, limbs ? limbs.length : 0) : 1;
  g.clearRect(0, 0, W, H); g.save(); g.globalCompositeOperation = 'lighter';
  for (let j = 0; j < K; j++) {
    const a = j * 2.39996 + d.seed * 6.28 + t * .08, rr = d.n ? W * (.1 + .12 * d.growth) : 0, x = W / 2 + Math.cos(a) * rr + noise(t * .2 + j * 5) * 3, y = H / 2 + Math.sin(a) * rr * .8 + noise(t * .17 + j * 9) * 3;
    const rad = W * (.2 + .16 * Math.sqrt(limbs ? limbs[j].count / d.n : 1 / K)) * (d.n ? 1 : .7), hu = hueOf(limbs ? limbs[j].mean.bright : d.bright) + (limbs ? 0 : j * 24), gr = g.createRadialGradient(x, y, 0, x, y, rad);
    gr.addColorStop(0, `hsla(${hu},90%,65%,${.3 + .35 * d.growth})`); gr.addColorStop(.5, `hsla(${hu + 30},90%,45%,.14)`); gr.addColorStop(1, 'hsla(0,0%,0%,0)'); g.fillStyle = gr; g.fillRect(0, 0, W, H);
  }
  g.restore();
}

/* what is under a point: a void, a pillar (and how far along), the haze near one, or nothing */
function nebUnder(c, G, x, y) {
  const vi = G.voids.findIndex(o => Math.hypot(o.x - x, o.y - y) < o.r);
  if (vi >= 0) return { kind: 'void', vi, p: G.voids[vi].p, freq: 41 * ALIEN_SCALE[vi * 2 % 7] * 2 };
  let best = null;
  for (const o of G.lobes) { const ex = o.b[0] - o.a[0], ey = o.b[1] - o.a[1], u = clamp(((x - o.a[0]) * ex + (y - o.a[1]) * ey) / (ex * ex + ey * ey || 1), 0, 1), dd = Math.hypot(x - o.a[0] - ex * u, y - o.a[1] - ey * u) / (o.r * (1 - .5 * u) || 1); if (!best || dd < best.dd) best = { o, u, dd }; }
  if (best && best.dd < 1.15 && c.food.length) {
    const o = best.o, mem = c.food.filter((f, i) => (c.limbs && c.limbs.length > 1 ? (f.limb || 0) % G.K : i % G.K) === o.j).sort((a, b) => (a.core || 0) - (b.core || 0));
    const f = mem.length ? mem[Math.min(mem.length - 1, Math.floor(best.u * mem.length))] : c.food[0];
    return { kind: 'pillar', o, u: best.u, p: o.a3.map((a, k) => a + (o.b3[k] - a) * best.u), freq: noteOf(f.bright ?? .3) };
  }
  if (best && best.dd < 3.2) return { kind: 'haze', p: G.unproj(x, y, best.o.a[2]), freq: noteOf(.35 + .6 * clamp(1 - y / (NEB.canvas.clientHeight || 1), 0, 1)) * 2 };
  return { kind: 'space', p: G.unproj(x, y, G.dist), freq: noteOf(.5 + .5 * clamp(1 - y / (NEB.canvas.clientHeight || 1), 0, 1)) * 4 };
}

/* drag: your pointer pushes through the dust and bows it. The pitch follows whatever you are passing over. */
function nebDrag(x, y, speed) {
  const c = Gym.cur; if (!c) return; const fx = fxOf(c.slug), G = fx.ngeom; if (!G) return;
  const a = ac(), D = NEB.drag, now = a.currentTime, t = performance.now() / 1000, gr = G.growth, pure = clamp(.25 * gr + .75 * G.learned, 0, 1), hit = nebUnder(c, G, x, y);
  a.resume(); D.on = true; D.p = hit.p;
  if (!D.v) { const g = a.createGain(), g2 = a.createGain(), lp = a.createBiquadFilter(), o1 = a.createOscillator(), o2 = a.createOscillator(); g.gain.value = 0; lp.type = 'lowpass'; lp.frequency.value = 900; lp.Q.value = 4;
    o1.type = 'sawtooth'; o2.type = 'sine'; g2.gain.value = .5; o1.connect(lp); o2.connect(g2); g2.connect(lp); lp.connect(g); g.connect(voiceOut()); o1.start(); o2.start(); D.v = { g, lp, o1, o2 }; }
  const wob = 1 + (1 - pure) * .03 * Math.sin(t * 23), lvl = clamp(speed / 1400, .025, .16) * (hit.kind === 'space' ? .35 : hit.kind === 'haze' ? .7 : 1);
  D.v.o1.frequency.setTargetAtTime(hit.freq * wob, now, .05); D.v.o2.frequency.setTargetAtTime(hit.freq * (hit.kind === 'void' ? .5 : ALIEN_SCALE[4]) * (1 + (1 - pure) * .012), now, .05);
  D.v.lp.frequency.setTargetAtTime(500 + speed * 1.6 + pure * 1800, now, .08); D.v.g.gain.setTargetAtTime(lvl, now, .06);
  if (hit.kind === 'pillar') hit.o.slot.ring = Math.max(hit.o.slot.ring, .6);
  if (!D.lastWave || t - D.lastWave > (hit.kind === 'space' ? .5 : .22)) { D.lastWave = t; fx.waves.push({ t0: t, o: hit.p, soft: true }); if (fx.waves.length > 14) fx.waves.shift(); }
}
function nebDragEnd() {
  const D = NEB.drag; D.on = false;
  if (D.v) { const a = ac(), v = D.v; D.v = null; v.g.gain.setTargetAtTime(0, a.currentTime, .3); setTimeout(() => { try { v.o1.stop(); v.o2.stop(); } catch {} }, 2500); }
}

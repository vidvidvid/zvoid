/* The entity as a nebula, rendered on the GPU.
   A fragment shader marches rays through a 3D volume of dust and glowing gas, so there are no lines or particles:
   - pillars: one per limb (group of tracks). Their size follows how much that limb ate; colour follows its brightness.
   - dust: opaque, eroded by noise, lit by one moving light with real self-shadowing (dark cores, bright rims).
     Untrained it is soft fog; training sharpens it into sculpted forms.
   - gas: faint emissive haze around and between the pillars. Voids are cavities carved out of both.
   - stars: one ignites inside the dust every 25 epochs, and lights the dust around it.
   - resonance: every pillar emits waves at its limb's tempo. They cross, reflect and interfere, so the dust shows standing
     patterns. Touches, beats and feeding send shock fronts that echo three times. After sound stops it rings on, like reverb.
   - form: structure that only appears with training. The dust crystallises from its densest cores outward into a lattice
     of thin sheets (a gyroid morphing into another minimal surface) that light up as waves pass through. The voids turn
     from round holes into faceted cavities. Arcs begin to orbit it: one ring per limb, circling at that limb's tempo.
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
uniform vec4 uTrait[6];  // how each limb's food sounds: noisy, dynamic, bright, bassy (each 0..1)
uniform vec4 uTrait2[6]; // its tempo (0 slow .. 1 fast), how fast it builds its frame
uniform vec4 uVar[6];    // each limb's own skeleton: how far its ribs sweep back, how they bulge, their style (plain, paired, bladed, knobbed), how far they wrap around
uniform vec4 uVar2[6];   // its vertebrae (beads, discs, bones), dorsal spines, how many cables it has, and how they twist
uniform vec4 uPulse[6];  // energy running along each limb after a strike: where it is (0 base .. 1 tip), its strength, its width
uniform vec4 uScar[4];   // where it was struck: xyz in the body's own space, w how fresh the mark is
uniform vec4 uDof;       // depth of field: the distance in focus, how deep the sharp zone is, strength, how soft the background is
uniform vec4 uVoid[3];   // xyz, w radius
uniform vec4 uWave[8];   // xyz origin, w radius
uniform float uWaveAmp[8];
uniform vec4 uWaveK[8];   // sharpness, kind (0 shell, 1 sheet, 2 twist)
uniform vec4 uWaveN[8];   // direction of a sheet, or axis of a twist
uniform vec4 uRip[6];    // per pillar: wavenumber, angular speed, phase, strength
uniform vec4 uReson;     // ripple depth, reverb tail, reflected share, unused
uniform vec4 uStar[8];   // xyz, w brightness
uniform vec4 uAud;       // bass, mid, high, level
uniform vec4 uLife;      // learned, growth, turbulence, kick
uniform vec3 uLight, uKey, uAmb;
uniform float uB, uFrame, uFine;
uniform vec3 uEvP[51];    // energy arcs from outside: three jagged paths of 17 points each, re-struck by the app like lightning
uniform vec3 uFil[136];   // filaments rooted on the body: eight threads of seventeen points each
uniform vec4 uFilC[8];    // each one's colour and strength
uniform vec4 uEvI[3];     // each arc's brightness, where its bead of light is along it, the flare where it lands, its tint
uniform vec4 uTouch;     // xyz where the pointer is dragging, w strength
uniform float uForm;     // 0 = cloud, 1 = fully formed (grows with training)
uniform vec4 uGy;        // lattice: scale, drift speed, morph between two minimal surfaces, sheet thickness
uniform vec3 uDiscN, uDiscU, uDiscV;
uniform vec4 uDisc;      // inner radius, outer radius, half thickness, on
uniform vec4 uRing[8];   // radius, weight, arcs around, angular speed
uniform vec4 uProg;      // training: whole-session fraction, current-epoch fraction, on, head pulse
uniform vec4 uSweep;     // training: how far light has risen through the pillars (0 base .. 1 tip), its strength
uniform vec4 uFood[12];  // digesting: tracks waiting to be eaten, as motes (xyz, brightness)
float gH;                // how far along its pillar the last sampled point was
uniform float uSym;      // 1 = the body is mirrored across its midline
uniform vec4 uBuild;     // how far each part of the frame is built along every limb (0 base .. 1 tip): spine, ribs, cables, armour
float gFront;            // how close the last sampled point was to where the frame is being built right now
uniform vec4 uFract;     // branching: depth (grows with training), life-cycle rate
float gTip; vec3 gTint; bool gLite;
const int STEPS = 68;
vec3 gPa, gBa; float gR0, gBest;   // the pillar nearest the last sampled point, in its own frame
vec4 gTr, gTr2;           // the sound of the limb the last sampled point belongs to
vec4 gVa, gVb, gPu;       // that limb's own skeleton, and the pulse running along it
float gSeam;             // how deep in a groove of the body the last sampled point was

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

/* fractal growth: every limb sprouts branches, and branches sprout smaller ones. Each has its own life cycle: it builds
   outward with a glowing tip, holds, then crumbles into dust and regrows. So something is always being made and unmade. */
float branchField(vec3 pa, vec3 ba, float r0) {
  float L = length(ba); vec3 ax = ba / L; float z = dot(pa, ax); vec3 rv = pa - ax * z;
  vec3 u = normalize(cross(ax, vec3(.31, .95, .07))), v = cross(ax, u), q = vec3(dot(rv, u), dot(rv, v), z);
  float len = L, rad = r0, dsum = 0.; gTip = 0.;
  if (length(q.xy) > L * 1.05 + r0) return 0.;                                   // too far out for any branch to reach
  for (int lv = 0; lv < 2; lv++) {
    float fl = float(lv), on = clamp(uFract.x - fl, 0., 1.);
    if (on <= 0.) break;
    float nb = 3. + fl + floor(gTr.y * 2.6), cz = len / nb, id0 = floor(q.z / cz), bestD = 1e3, bestL = 0., bestR = rad * .5; vec3 bestP = q;
    for (int c = 0; c < 2; c++) {
      if (c == 1 && lv == 1) break;
      float id = id0 - float(c);
      if (id < 0. || id > nb - 1.) continue;
      float hsh = fract((id + 1.) * .6180339 + fl * .371 + uSeed * .137); vec2 cs = normalize(vec2(fract(hsh * 7.31 + id * .41) - .5, fract(hsh * 3.17 + id * .73) - .5) + 1e-3);
      float ph = fract(uT * uFract.y * (.6 + .8 * hsh) + hsh * 7.), grow = smoothstep(0., .4, ph) * (1. - smoothstep(.82, 1., ph)) * on;
      vec3 p = q - vec3(0., 0., (id + .5) * cz);
      p.xy = vec2(cs.x * p.x + cs.y * p.y, -cs.y * p.x + cs.x * p.y);
      p.xz = vec2(.5817 * p.x - .8134 * p.z, .8134 * p.x + .5817 * p.z);      // tilted outward: the branch now runs along +z
      float bl = len * (.4 + .5 * gTr.y) * grow, br = rad * (.55 - .1 * fl), hz = clamp(p.z, 0., bl), dc = length(vec3(p.xy, p.z - hz)) - br * (1. - .55 * hz / max(bl, 1e-3));
      float di = smoothstep(.9, -.6, dc / br) * min(1., grow * 4.), crumble = smoothstep(.7, 1., ph);
      if (crumble > 0. && di > 0.) di *= smoothstep(crumble * 1.25 - .25, crumble * 1.25, n3(pa * 2.6 + id * 7.));   // it does not shrink away: it crumbles
      dsum += di;
      if (ph < .4) { vec3 e = p - vec3(0., 0., bl); gTip += exp(-dot(e, e) / (br * br) * 2.5) * on; }               // it glows where it is growing
      if (dc < bestD) { bestD = dc; bestP = p; bestL = bl; bestR = br; }
    }
    if (bestD > rad * 3. || bestL < 1e-3) break;
    q = bestP; len = bestL; rad = bestR;
  }
  return dsum;
}
float shapes(vec3 q, out vec3 tint, out float halo) {
  float d = 0.; tint = vec3(0.); halo = 0.; gH = 0.; gBest = 1e3;
  for (int i = 0; i < 6; i++) {
    float w = uCol[i].w;
    if (w > 0.) {
      vec3 ba = uAxis[i].xyz * uAxis[i].w, pa = q - uPole[i].xyz;
      float h = clamp(dot(pa, ba) / dot(ba, ba), 0., 1.), r0 = uPole[i].w;
      vec4 tr = uTrait[i];
      float prof = (1. - (.28 + .58 * tr.z) * h) * (1. + tr.w * .5 * (1. - h) * (1. - h));       // bright food: long and tapering to a point. Bassy food: a heavy, swollen base
      float sd = length(pa - ba * h) - r0 * prof;
      if (tr.x > .02 && !gLite) { float kq = 6.5 / r0, sp = sin(pa.x * kq) * sin(pa.y * kq * 1.13 + 1.) * sin(pa.z * kq * .91 + 2.); sd -= r0 * tr.x * (.5 * pow(max(sp, 0.), 3.) - .1 * max(-sp, 0.)); }   // noisy food: a ragged, spiny surface
      if (w > .5 && sd / r0 < gBest) { gBest = sd / r0; gPa = pa; gBa = ba; gR0 = r0; gTint = uCol[i].rgb; if (!gLite) { gTr = tr; gTr2 = uTrait2[i]; gVa = uVar[i]; gVb = uVar2[i]; gPu = uPulse[i]; } }
      float di = smoothstep(.9, -.6, sd / r0) * w, hl = smoothstep(2.0, -.4, sd / r0) * w;
      d += di; halo += hl * hl; tint += uCol[i].rgb * (di + hl * .25); gH += h * (di + hl * .25);
    }
  }
  gTip = 0.;
  if (!gLite && uFract.x > 0. && gBest < 3.2) { float bf = branchField(gPa, gBa, gR0); d += bf; tint += gTint * bf; halo += bf * bf * .25; }
  gH /= max(d + halo * .25, 1e-3);
  tint /= max(d + halo * .25, 1e-3);
  return min(d, 1.5);
}
float nearest(vec3 p) {                      // distance to the outer edge of anything visible; lets rays leap over empty space
  float m = 1e3; p.x = mix(p.x, abs(p.x), uSym);
  for (int i = 0; i < 6; i++) {
    if (uCol[i].w > 0.) { vec3 ba = uAxis[i].xyz * uAxis[i].w, pa = p - uPole[i].xyz; float h = clamp(dot(pa, ba) / dot(ba, ba), 0., 1.); m = min(m, length(pa - ba * h) - uPole[i].w * (3.0 + .9 * uTrait[i].w) - 1.25 - uAxis[i].w * .3 * min(uFract.x, 1.)); }   // room for its branches
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
float discDist(vec3 p) {
  if (uDisc.w <= 0.) return 1e3;
  float hg = dot(p, uDiscN), r = length(p - uDiscN * hg);
  return max(abs(hg) - uDisc.z, max(r - uDisc.y, uDisc.x - r));
}
float carve(vec3 q) {                         // voids: round holes that become faceted, geometric cavities as it forms
  float c = 1.;
  for (int k = 0; k < 3; k++) {
    float r = uVoid[k].w;
    if (r > 0.) { vec3 v = q - uVoid[k].xyz; float dn = mix(length(v), (abs(v.x) + abs(v.y) + abs(v.z)) * .64, uForm); c *= smoothstep(r * mix(.5, .92, uForm), r * mix(1.5, 1.06, uForm), dn); }
  }
  return c;
}
float smin(float a, float b, float k) { float h = clamp(.5 + .5 * (b - a) / k, 0., 1.); return mix(b, a, h) - k * h * (1. - h); }
/* the body: a biomechanical armature along each pillar. Stacked vertebrae, open ribs, cables wound around the spine.
   It only exists once the creature has trained, and it grows in that order. Returns a signed distance. */
float built(float front, float hh) { return front <= .001 ? 0. : smoothstep(front + .015, front - .07, hh); }
float edge(float front, float hh) { float e = (hh - front) / .035; return front > .001 && front < .995 ? exp(-e * e) : 0.; }
float bodyL(vec3 pa, vec3 ba, float r0) {
  float hh = clamp(dot(pa, ba) / dot(ba, ba), 0., 1.);
  float L = length(ba); vec3 ax = ba / L; float z = dot(pa, ax); vec3 rv = pa - ax * z; float rho = length(rv);
  vec3 u = normalize(cross(ax, vec3(.31, .95, .07))), v = cross(ax, u); float phi = atan(dot(rv, v), dot(rv, u));
  vec4 B = clamp(uBuild * (.65 + .7 * gTr2.y), 0., 1.);                                       // each limb builds at its own pace: the more it was fed, the faster
  float taper = 1. - .45 * hh, sB = built(B.x, hh), rB = built(B.y, hh), cB = built(B.z, hh), pB = built(B.w, hh);
  gFront = max(max(edge(B.x, hh), edge(B.y, hh)), max(edge(B.z, hh), edge(B.w, hh))) * uProg.z;
  float vst = gVb.x;                                                                           // vertebrae: round beads, thin stacked discs, or long waisted bones
  float seg = r0 * mix(.52, .2, gTr2.x) * (vst > 1.5 ? 1.75 : vst > .5 ? .62 : 1.), sv = abs(sin(z * 3.14159 / seg));
  float vp = vst > 1.5 ? .46 + .6 * (1. - sv) * (1. - sv) : vst > .5 ? .5 + .56 * pow(sv, .22) : .6 + .4 * sqrt(sv);
  float d = rho - r0 * .24 * taper * vp * sB + (sB > .001 ? 0. : 1.);
  gSeam = smoothstep(.3, 0., sv) * sB;
  float gap = r0 * mix(.74, .34, gTr2.x), tilt = gVa.x, zs = z - tilt * rho, zc = (fract(zs / gap + .5) - .5) * gap;   // ribs: a cage around the cloud. They can sweep back like chevrons.
  float rr = r0 * (.98 - .34 * hh) * (1. + .08 * sin(z * 2.3 / r0)) * (1. + gVa.y * sin(3.14159 * hh));              // the cage can be a barrel or waisted
  float open = (1. - rB) * 1.5, wrap = gVa.w, rst = gVa.z;
  float th = r0 * (.028 + .034 * gTr.w) * smoothstep(wrap + open, wrap + 1.4 + open, cos(phi)) * min(1., rB * 3.);
  float zr = rst > .5 && rst < 1.5 ? abs(zc) - gap * .12 : zc, rk = rst > 1.5 && rst < 2.5 ? .36 : 1.;                // paired ribs; or flat blades standing out from the body
  if (rst > 2.5) th *= 1. + .95 * pow(.5 + .5 * cos(phi * 7.), 4.);                                                  // or knobbed, like knuckles
  d = smin(d, (length(vec2((rho - rr) * rk, zr)) - th) / sqrt(1. + tilt * tilt) + (th > 1e-4 ? 0. : 1.), r0 * .07);
  if (rB > .001) {                                                                           // cilia: a fringe of fine hairs on every rib, a row on each flank, beating in a wave that runs along the limb
    float ci = floor(zs / gap + .5), beat = sin(uT * 1.3 - ci * .7 + gTr2.x * 3.), Lh = r0 * (.34 + .2 * gTr.y), rq = clamp(rho - rr, 0., Lh), fr = rq / Lh;
    float hd = length(vec3(rho - rr - rq, zc - beat * gap * .42 * fr * fr, abs(abs(phi) - 1.45) * rho)) - r0 * .017 * (1. - fr * .8) * min(1., rB * 3.);
    d = smin(d, hd, r0 * .03);
  }
  if (gVb.y > .05 && rB > .001) {                                                            // dorsal spines: one from each vertebra along its back, longest at the base, raked toward the tip
    float cz = (fract(z / gap) - .5) * gap, Ls = r0 * (.3 + .95 * gVb.y) * (1. - .55 * hh) * min(1., rB * 2.), px = rho * cos(phi), py = rho * sin(phi), hx = clamp(px, 0., Ls);
    d = smin(d, length(vec3(px - hx, py, cz - hx * .4)) - r0 * .036 * (1. - hx / max(Ls, 1e-3) * .88), r0 * .04);
  }
  float cn = gVb.z, cs = 6.28318 / cn, tw = phi - z * gVb.w / r0, a2 = mod(tw + cs * .5, cs) - cs * .5, rc = r0 * .55 * taper, tc = r0 * .04 * cB;   // cables: from two to five helices, wound either way
  d = smin(d, length(vec2(rho - rc, a2 * rc)) - tc + (tc > 1e-4 ? 0. : 1.), r0 * .05);
  if (pB > .001) {                                                                           // armour: segmented plates over its back, as many around as it has cables, doubled
    float ps = 3.14159 / cn, Rp = r0 * (1.12 - .38 * hh), pz = (fract(z / (gap * 1.6)) - .5) * gap * 1.6, pa6 = abs(mod(phi + ps * .5, ps) - ps * .5);
    float plate = max(abs(rho - Rp) - r0 * .017 * pB, max(abs(pz) - gap * .68, pa6 * rho - Rp * ps * .45));
    d = min(d, max(plate, (-cos(phi - 2.1) - .2) * r0 * .4));
  }
  return max(d, max(-z, z - L) - r0 * .04);
}
float dustLo(vec3 q) {                       // cheap density, for shadows
  q.x = mix(q.x, abs(q.x), uSym);
  gLite = true; vec3 tt; float hl; float sh = shapes(q, tt, hl); gLite = false;
  if (sh < .02) return 0.;
  return smoothstep(-.3, .3, sh + (fbm2(q * 1.6 + vec3(0., -uT * .03, uT * .015) + uSeed) - .47) * 1.6 - .8) * carve(q);
}

void main() {
  vec2 uv = (gl_FragCoord.xy - uCenter) / (.5 * min(uRes.x, uRes.y));
  vec3 rd = normalize(uCam * vec3(uv * uTan, -1.)), ro = uCam * vec3(0., 0., uDist);

  // deep space behind it
  // the space it lives in: slow folded clouds in its own colours, dark lanes through them, and a faint web of threads that wakes with sound and training
  vec3 sd3 = rd * 2.2 + uSeed;
  vec3 wp = sd3 + (vec3(n3(sd3 * 1.3 + vec3(0., uT * .006, 0.)), n3(sd3 * 1.3 + 11.), n3(sd3 * 1.3 + 23.)) - .5) * 1.5;
  float c1 = n3(wp), c2 = n3(wp * 2.1 + 5.), c3 = n3(wp * 4.3 - 9.), c4 = n3(wp * 9.1 + 3.);
  float neb = smoothstep(.38, .95, c1 * .58 + c2 * .28 + c3 * .14 + c4 * .07);
  float lane = smoothstep(.56, .32, n3(wp * 1.7 + 31.));
  float web = pow(1. - abs(2. * n3(wp * 3.1 + vec3(0., 0., uT * .008)) - 1.), 16.) * (.35 + c1);
  vec3 bg = vec3(.005, .005, .013) + (mix(uAmb, uKey, c2) * .085 * neb + uKey * .03 * c3 * neb + vec3(.05, .02, .035) * c4 * neb) * (1. - lane * .75)
          + mix(uAmb, vec3(.6, .72, 1.), .5) * web * .03 * (1. + uAud.w * 2.5 + uProg.z * 1.2);
  vec3 gd = rd * 110., cell = floor(gd);
  float hs = fract(sin(dot(cell, vec3(127.1, 311.7, 74.7))) * 43758.5453);
  float tw = .7 + .3 * sin(uT * (1. + hs * 3.) + hs * 40.);
  bg += mix(vec3(1., .82, .7), vec3(.75, .86, 1.), fract(hs * 91.)) * step(.9972, hs) * smoothstep(.45, 0., length(fract(gd) - .5)) * tw * (.5 + fract(hs * 57.) * .9);
  vec3 gf = rd * 260., cf = floor(gf); float hf = fract(sin(dot(cf, vec3(12.9, 78.2, 37.7))) * 43758.5453);   // a second, far finer layer of faint stars for depth
  bg += vec3(.8, .86, 1.) * step(.992, hf) * smoothstep(.42, 0., length(fract(gf) - .5)) * (.12 + fract(hf * 33.) * .28) * (1. - neb * .5);

  vec3 C = vec3(0.); float T = 1., Dz = 0., Wz = 0., lineG = 0.;   // Dz, Wz: how far away what this pixel shows is, for the depth of field
  // orbiting arcs: one ring per limb, broken into arcs that circle at its tempo. A thin plane, intersected exactly.
  float tP = -1., ringA = 0.; vec3 ringC = vec3(0.);
  if (uDisc.w > 0.) {
    float dn = dot(rd, uDiscN), tq = abs(dn) > 1e-3 ? -dot(ro, uDiscN) / dn : -1.;
    if (tq > 0.) {
      vec3 pl = ro + rd * tq; float r = length(pl);
      if (r > uDisc.x * .6 && r < uDisc.y * 1.4) {
        float ang = atan(dot(pl, uDiscU), dot(pl, uDiscV)), dd = 0., hm = 0.;
        for (int j = 0; j < 8; j++) {
          float rw = uRing[j].y;
          if (rw > 0.) { float fj = float(j), wj = 1. + .17 * sin(ang * 2. + fj * 1.9 + uT * .07) + .1 * sin(ang * 3. - fj * 2.7 - uT * .05) + .05 * sin(ang * 7. + fj * 5.1 + uT * .11);   // each loop is its own uneven, slowly writhing thread, never a true circle
            float dr = (r - uRing[j].x * wj) / (.009 + .024 * pow(.5 + .5 * sin(ang * 3. + fj * 4.3 + uT * .2), 2.)), e = exp(-dr * dr) * smoothstep(-.15, .25, sin(ang * uRing[j].z + uT * uRing[j].w + float(j) * 2.4) - (1. - rw * 1.2)) * rw; dd += e; hm += e * fract(float(j) * .37 + .2); }
        }
        if (dd > .003) { ringA = 1. - exp(-dd * min(3.5, 1. / abs(dn)) * 1.1); ringC = mix(mix(uAmb, uKey, clamp(hm / dd, 0., 1.)), vec3(.9, .92, 1.), .45) * (.85 + uAud.w * 1.5 + uLife.w) * ringA; tP = tq; }
        if (uProg.z > 0.) {                     // training: two broken arcs in its orbit grow. Outer = the whole session, inner = this epoch.
          float a01 = fract(ang / 6.2831853 + .5), tau = a01 * 6.2831853;
          float seg1 = smoothstep(-.75, -.55, sin(tau * 29.) + .5 * sin(tau * 11. + 1.3)), seg2 = smoothstep(-.6, -.4, sin(tau * 41. + 2.) + .6 * sin(tau * 13.));   // irregular marks, like its script
          float rp = r / (1. + .07 * sin(ang * 3. + uT * .1) + .045 * sin(ang * 5. - uT * .07) + .025 * sin(ang * 11. + uT * .16)), d1 = (rp - 1.66) / .02, d2 = (rp - 1.52) / .013, h1 = min(abs(a01 - uProg.x), 1. - abs(a01 - uProg.x)) * 50., h2 = min(abs(a01 - uProg.y), 1. - abs(a01 - uProg.y)) * 50.;
          float g1 = exp(-d1 * d1) * (.05 + step(a01, uProg.x) * seg1 * .95) + exp(-h1 * h1 - d1 * d1 * .1) * (1.1 + uProg.w), g2 = exp(-d2 * d2) * (.035 + step(a01, uProg.y) * seg2 * .75) + exp(-h2 * h2 - d2 * d2 * .08) * (.9 + uProg.w);
          g1 *= uProg.z; g2 *= uProg.z;
          if (g1 + g2 > .01) { ringC += mix(vec3(1.), uKey, .3) * g1 + mix(vec3(1.), uAmb, .5) * g2; ringA = max(ringA, min(1., g1 + g2)); tP = tq; }
        }
      }
    }
  }
  float B = uB, b = dot(ro, rd), cc = dot(ro, ro) - B * B, h = b * b - cc;
  if (h > 0.) {
    h = sqrt(h);
    float t0 = max(-b - h, 0.), t1 = -b + h, dt = (t1 - t0) / float(STEPS);
    float t = t0 + dt * fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(.06711056, .00583715))) + uFrame * .618034);   // an even, non-clumping offset pattern; every pixel then steps through all offsets over the frames, so the blend converges fast
    float turb = 1.1 + uLife.z * 1.4, tt = uT * .035, lastSh = 0.;
    for (int i = 0; i < STEPS; i++) {
      vec3 p = ro + rd * t;
      if (tP > 0. && t >= tP) { C += T * ringC; T *= 1. - ringA * .35; tP = -1.; }   // the ray just passed through the arcs' plane
      float far = nearest(p);
      if (far > 0.) { t += max(dt, far * .85); if (t > t1) break; continue; }
      t += dt; if (t > t1 + dt) break;
      vec3 s = p * .45 + uSeed;
      vec3 w = (vec3(n3(s + vec3(0., tt, 0.)), n3(s + vec3(31.4, -tt, 7.7)), n3(s + vec3(5.2, 13.1, tt))) - .5) * turb;
      vec3 q = p + w; float ring = 0., melt = 0., grow = 0., bloom = 0.;   // a front does not just push the dust: it dissolves it as it passes, and the dust grows back thicker behind it
      for (int k = 0; k < 6; k++) {            // shock fronts from touch, feeding, beats, and their echoes
        float a = uWaveAmp[k];
        if (a > 0.) {
          vec3 e = q - uWave[k].xyz, wn = uWaveN[k].xyz; float el = length(e) + 1e-3, kind = uWaveK[k].y;
          float dm = kind > .5 && kind < 1.5 ? dot(e, wn) : el, dw = (dm - uWave[k].w) * uWaveK[k].x, g = exp(-dw * dw) * a;
          if (kind > .5) g *= exp(-el * el * .1);
          if (kind > 1.5) { float an = g * .7; q = uWave[k].xyz + e * cos(an) + cross(wn, e) * sin(an) + wn * dot(wn, e) * (1. - cos(an)); }   // twist the dust around an axis
          else q += (kind > .5 ? wn : e / el) * g * .1;
          ring += g; float tg0 = uWaveK[k].z; melt += g * (.2 + .8 * tg0); grow += exp(-(dw + 1.6) * (dw + 1.6)) * a * (kind > .5 ? exp(-el * el * .1) : 1.);
          if (kind < .5) bloom += a * tg0 * exp(-el * el * 4.5);   // where it was touched stays lit for a while, like a flush under skin
        }
      }
      if (uTouch.w > 0.) { vec3 e2 = q - uTouch.xyz; float tg = exp(-dot(e2, e2) * 2.6) * uTouch.w; q += normalize(e2 + 1e-4) * tg * .18; ring += tg * .7; melt += tg * .8; bloom += tg * .5; }   // your finger in the dust
      float sx = uSym > .5 && q.x < 0. ? -1. : 1.; q.x = mix(q.x, abs(q.x), uSym);                 // mirror symmetry: one side is the reflection of the other
      vec3 lF = normalize(uLight - p); lF.x *= sx; vec3 rdF = vec3(rd.x * sx, rd.yz);
      gLite = false; vec3 tint; float halo; float sh = shapes(q, tint, halo); float hAlong = gH; ring += gTip * 1.3;
      if (gBest < 2.5) { float pq = (clamp(dot(gPa, gBa) / dot(gBa, gBa), 0., 1.) - gPu.x) / gPu.z; ring += gPu.y * exp(-pq * pq) * smoothstep(2.5, .5, gBest); }   // a strike is conducted: a pulse runs along the limb
      for (int k = 0; k < 4; k++) { float sw = uScar[k].w; if (sw > 0.) { vec3 e3 = q - uScar[k].xyz; bloom += sw * exp(-dot(e3, e3) * 7.); } }   // where it was struck stays lit for a while, then heals
      if (halo + sh < .03) continue;
      float gk = 1.;
      if (sh < .02) { gk = 1.9; t += dt * .9; }            // out in the thin gas there is nothing fine to resolve: take longer strides
      bloom = min(bloom, .9); float cv = carve(q);
      float rip = ripples(q) * uReson.x;
      float haze = n3(q * .7 + vec3(0., uT * .02, 3.)), wisp = w.x / turb + .5;
      float sapD = (hAlong - uSweep.x) / .04, sap = uSweep.y * (smoothstep(uSweep.x + .05, uSweep.x - .03, hAlong) * .3 + exp(-sapD * sapD) * 1.5);   // training: light rises through each pillar, base to tip, once per epoch
      ring += sap;
      float ds = dt, shv = -1., bd = 1e3;                  // shv: shadow toward the light, worked out once and shared by body and dust
      if (uBuild.x > .001 && sh > .08 && gBest < 1.35) {   // the frame, only worked out close to a limb's own axis
        vec3 bpa = gPa, bba = gBa; float br0 = gR0; bd = bodyL(bpa, bba, br0); float seam = gSeam, front = gFront;
        if (bd < dt * .7) { ds = clamp(bd * .75, dt * .16, dt); t += ds - dt; }       // slow down near its surface so it stays crisp
        if (bd < .022) {
          float ab = (1. - exp(-smoothstep(.022, -.008, bd) * ds * 110.)) * cv;   // opacity by how far this step travelled inside it, so it does not depend on where the samples happen to land
          if (ab > .01) {
            float e = .035, nl = clamp((bodyL(bpa + lF * e, bba, br0) - bd) / e, 0., 1.), nv = clamp((bodyL(bpa - rdF * e, bba, br0) - bd) / e, 0., 1.); shv = dustLo(q + lF * .32); lastSh = shv; float shB = exp(-shv * 5.);
            vec3 hv = normalize(lF - rdF); float wet = pow(clamp((bodyL(bpa + hv * e, bba, br0) - bd) / e, 0., 1.), 48.) * (.3 + .7 * n3(q * 4.3 + vec3(0., -uT * .22, uT * .1))) * (.35 + shB * .65);   // it is wet: small sharp highlights that slide over it
            vec3 alb = mix(vec3(.15, .14, .17), tint, .2);                      // dark, glossy, like wet bone
            vec3 lb = alb * (uKey * nl * (.35 + shB * .65) * 2.2 + uAmb * .16) + pow(1. - nv, 2.5) * (uAmb * .7 + uKey * .45) * (.45 + shB * .55) + tint * .05
                    + tint * seam * (.4 + max(0., rip) * 2.6 + ring * 2.2 + uAud.w * .9)           // its seams glow, and carry the sound
                    + vec3(1., .84, .58) * front * 2.4                                               // white-hot where it is being built
                    + vec3(1., .97, .92) * wet * 1.5 + (tint * .5 + vec3(.55, .28, .18)) * bloom * (.3 + seam);
            Dz += T * ab * t; Wz += T * ab; C += T * ab * lb; T *= 1. - ab;
            if (T < .02) break;
          }
        }
      }
      if (uBuild.x > .2 && bd > .22) { float k = 1. + uBuild.x * (bd > .5 ? 1.7 : 1.); t += ds * (k - 1.); ds *= k; }   // the veil is thin and soft: stride through it, away from the frame
      float gas = (halo * .55 + sh * .25) * haze * haze * (.45 + wisp) * cv * max(0., 1. + rip * 2.4);
      C += T * mix(uAmb, tint, .45 + .4 * clamp(sh, 0., 1.)) * gas * ds * gk * (.62 + ring * 2.5 + bloom * 1.1 + melt * .6 + uAud.w * .6);
      if (sh > .02) {
        vec3 fq = q * 1.6 + vec3(0., -uT * .03, uT * .015) + uSeed;
        float f = fbm(fq);
        float soft = mix(.5, .1, uLife.x);
        float edg = sh + (f - .47) * 1.6 - .8 + rip * .34 - melt * .6 + grow * .3;
        if (abs(edg) < soft + .45) {            // fine grain where the dust thins out: two more octaves of fibre
          vec3 fa = gBa / (length(gBa) + 1e-4), ff = fq - fa * dot(fq, fa) * .8;   // the grain runs along the limb, like fibre, instead of every way at once like smoke
          float fine = (n3(ff * 6.1 + 3.) - .5) + (n3(ff * 10.1 - 5.) - .5) * .4;
          edg += fine * uFine * (1. - abs(edg) / (soft + .45));
        }
        float dust = smoothstep(-soft, soft, edg) * cv * mix(.45, 1., uLife.x);
        float lat = 0.;
        if (uForm > .01) {                      // the dust crystallises from its densest cores outward into a lattice of thin sheets
          vec3 g = q * uGy.x + vec3(0., uT * uGy.y, 0.);
          float fld = mix(dot(sin(g), cos(g.yzx)), (cos(g.x) + cos(g.y) + cos(g.z)) * .8, uGy.z);
          float mask = smoothstep(1.3 - uForm * 1.2, 1.5 - uForm * 1.2, sh + f * .35) * uForm;
          lat = smoothstep(uGy.w, uGy.w * .25, abs(fld)) * mask;
          dust = mix(dust, dust * (.1 + lat * 1.7), mask);
        }
        if (dust > .01) {
          vec3 l = normalize(uLight - p);
          if (shv < 0.) { if (mod(float(i), 3.) < 1.) { shv = dustLo(q + lF * .32); lastSh = shv; } else shv = lastSh; }   // shadows change slowly along a ray: work one out every other step
          float shd = exp(-shv * 8.5);
          vec3 alb = mix(tint, vec3(.62, .46, .36), .4);                       // dusty, a little warm
          vec3 lit = alb * (uKey * shd * 1.45 + uAmb * .07) + tint * (1. - dust) * .26;   // thin edges glow in their own colour
          for (int k = 0; k < 8; k++) { float sb = uStar[k].w; if (sb > 0.) { vec3 ds = uStar[k].xyz - p; lit += alb * vec3(1., .9, .8) * sb * .5 / (dot(ds, ds) * 6. + .15); } }
          lit *= 1. + uAud.z * 1.6 * n3(q * 7. + uT * 2.) * (1. - dust) + ring * 1.5 + max(0., rip) * 1.1;
          lit += (tint * .7 + vec3(.5, .3, .26)) * bloom * .9;
          float va = n3(q * 2.7 + uSeed + vec3(0., uT * .012, 0.)), vb = n3(q * 2.7 + 19.7 - uSeed);               // veins: lines where two folded sheets cross
          float vein = smoothstep(.075, 0., abs(va - .5)) * smoothstep(.075, 0., abs(vb - .5));
          lit += (tint * .9 + vec3(.3, .14, .12)) * vein * (.3 + 1.5 * pow(.5 + .5 * sin(hAlong * 9. - uT * 1.6 + va * 5.), 4.)) * (1. + uAud.x * 2. + ring * 6. + bloom * 5.);   // a pulse runs out along them from the base; a touch fires them like nerves
          lit += (tint * .65 + vec3(.38)) * lat * (.5 + max(0., rip) * 2.8 + ring * 2. + uAud.w * .8);   // the sheets carry the sound: they light up as waves pass
          float a = 1. - exp(-dust * (1. - max(uForm * .5, uBuild.x * .72)) * mix(1., smoothstep(0., .16, bd), .9) * ds * 9.);   // and clears around the frame, so you can see it                 // the dust thins to a shroud as the body forms
          Dz += T * a * t; Wz += T * a; C += T * a * lit; T *= 1. - a;
          if (T < .02) break;
        }
      }
    }
  }
  if (tP > 0.) { C += T * ringC; T *= 1. - ringA * .35; }
  for (int k = 0; k < 8; k++) {                // the stars themselves
    float sb = uStar[k].w;
    if (sb > 0.) { vec3 so = uStar[k].xyz - ro; float tc = dot(so, rd); vec3 dv = so - rd * tc; C += vec3(1., .93, .86) * sb * (.0022 / (dot(dv, dv) + .0005)) * mix(1., T, .55) * step(0., tc); }
  }
  for (int k = 0; k < 3; k++) {                // energy arcs: they strike in from far outside onto a part of the body, crawl, re-strike, and let go
    float ei = uEvI[k].x;
    if (ei > 0.) {
      float dm = 1e9, sm = 0.;
      for (int i = 0; i < 16; i++) {
        vec3 A = uEvP[k * 17 + i], u = uEvP[k * 17 + i + 1] - A, w0 = ro - A;
        float a = dot(u, u), b = dot(u, rd), c = dot(u, w0), d = dot(rd, w0), sc = clamp((c - b * d) / max(a - b * b, 1e-5), 0., 1.), tr = sc * b - d;
        vec3 dv = w0 + rd * tr - u * sc; float d2 = tr > 0. ? dot(dv, dv) : 1e9;
        if (d2 < dm) { dm = d2; sm = (float(i) + sc) / 16.; }
      }
      float fl = uEvI[k].z, pd = (sm - uEvI[k].y) / .06, bead = exp(-pd * pd), wide = floor(uEvI[k].w), wd = .00011 * (1. + fl * 3. + bead * 4.) * (.5 + sm) * (1. + wide * 1.1);
      float g = wd / (dm + wd) * (.45 + fl * 1.8 + bead * 2.5) + exp(-dm * 130.) * .045 * (1. + fl * 4.);
      vec3 so = uEvP[k * 17 + 16] - ro; float tc = dot(so, rd); vec3 dl = so - rd * tc; g += exp(-dot(dl, dl) * 70.) * fl * .35 * step(0., tc);   // the flare where it lands
      lineG += g * ei; C += mix(mix(uKey, uAmb, fract(uEvI[k].w)), vec3(.84, .95, 1.), .55 - wide * .15) * g * ei * mix(1., T, .7) * smoothstep(0., .3, sm);   // its outer end fades into the dark: no end is ever left hanging
    }
  }
  for (int k = 0; k < 8; k++) {                // filaments: fine threads that grow out of the limbs' tips and spines, thick at the root, and sway
    float fi = uFilC[k].w; bool sinew = fi > 1.5; if (sinew) fi -= 2.;
    if (fi > 0.) {
      float dm = 1e9, sm = 0., fk = float(k);
      for (int i = 0; i < 16; i++) {
        vec3 A = uFil[k * 17 + i], u = uFil[k * 17 + i + 1] - A, w0 = ro - A;
        float a = dot(u, u), b = dot(u, rd), c = dot(u, w0), d = dot(rd, w0), sc = clamp((c - b * d) / max(a - b * b, 1e-5), 0., 1.), tr = sc * b - d;
        vec3 dv = w0 + rd * tr - u * sc; float d2 = tr > 0. ? dot(dv, dv) : 1e9;
        if (d2 < dm) { dm = d2; sm = (float(i) + sc) / 16.; }
      }
      float tp = sinew ? .5 + .5 * abs(1. - 2. * sm) : 1. - sm * .8;
      float swell = pow(.5 + .5 * sin(sm * 19. - uT * 1.7 + fk * 2.1), 3.);                       // slow swellings travel along it, like something being swallowed
      float knot = sinew ? pow(max(0., sin(sm * 47. + fk)), 10.) : smoothstep(.93, 1., sm) * 2.2;   // a sinew is beaded like a wet web; a tendril ends in a small lit bulb
      float wd = (.00026 * tp * tp + .000008) * (1. + swell * 1.3 + knot * 1.6);
      float g = wd / (dm + wd) * (.7 + swell * .6 + knot * 1.1 + uAud.w * 1.4) + exp(-dm * 90.) * .03 * tp * (1. + swell);   // and a faint wet sheath around the core
      vec3 fcol = mix(mix(uFilC[k].rgb, vec3(.93, .9, .84), .25 + .45 * (sinew ? 1. - tp : sm)), vec3(1., .96, .9), min(1., knot * .5));
      lineG += g * fi; C += fcol * g * fi * mix(1., T, .8);
    }
  }
  for (int k = 0; k < 12; k++) {               // digesting: the tracks it has yet to eat drift around it as motes
    float fb = uFood[k].w;
    if (fb > 0.) {                               // each is a soft clump of its own dust drifting in, with a faint tail behind it
      vec3 fc = mix(uAmb, uKey, fract(float(k) * .37 + .15)), tail = normalize(uFood[k].xyz + 1e-3) * .17;
      for (int j = 0; j < 4; j++) {
        float fj = float(j); vec3 so = uFood[k].xyz + tail * fj - ro; float tc = dot(so, rd); vec3 dv = so - rd * tc; float d2 = dot(dv, dv), w = 1. + fj * .9;
        if (tc > 0.) C += mix(fc, vec3(1.), .25) * fb * (exp(-d2 * 55. / w) * .55 + (fj < .5 ? exp(-d2 * 700.) * .5 : 0.)) / (1. + fj * 1.1) * mix(1., T, .6);
      }
    }
  }
  C += bg * T;
  C *= 1. + uLife.w * .35;
  C = 1. - exp(-C * 1.35);
  C = pow(C, vec3(.92));
  vec2 vv = gl_FragCoord.xy / uRes - .5;
  C *= 1. - dot(vv, vv) * .55;
  C += (texture2D(uNoise, gl_FragCoord.xy / 256. + .37).g - .5) / 255.;
  float cover = min(1., Wz * 1.15), zf = Wz > 1e-4 ? Dz / Wz : uDof.x;                      // how out of focus this pixel is: sharp near the focus distance, soft far behind it; lightning and threads stay sharp
  gl_FragColor = vec4(C, mix(uDof.w, clamp(abs(zf - uDof.x) / uDof.y - .1, 0., 1.), cover) * (1. - clamp(lineG * 1.4, 0., 1.)) * uDof.z);
}`;

/* Blend this frame into the running image. Every frame shoots its rays at a slightly different spot inside each pixel
   and at a different depth offset, so the blend is a many-sample image: smooth edges, no grain, no stepping.
   History is clamped to what this frame's neighbourhood allows, so fast motion does not smear. */
const NEB_RESOLVE = `precision highp float;
uniform sampler2D uCur, uHist; uniform vec2 uPx, uTx, uJit; uniform float uMix;
void main() {
  vec2 uv = gl_FragCoord.xy * uPx, cu = uv + uJit;           // undo this frame's sub-pixel shift
  if (uMix < 0.) { gl_FragColor = mix(texture2D(uHist, uv), texture2D(uCur, cu), -uMix); return; }   // a capture: a plain average of every frame
  vec2 tc = (floor(cu / uTx) + .5) * uTx, dd = (cu - tc) / uTx;   // the one rendered sample nearest this screen pixel, and how far off it is
  vec4 c4 = texture2D(uCur, tc), h4 = texture2D(uHist, uv); vec3 c = c4.rgb, mn = c, mx = c, av = c;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    if (i == 0 && j == 0) continue;
    vec3 s = texture2D(uCur, tc + vec2(float(i), float(j)) * uTx).rgb; mn = min(mn, s); mx = max(mx, s); av += s;
  }
  av /= 9.;
  vec3 h = clamp(h4.rgb, mn - .015, mx + .015);
  float mv = smoothstep(.08, .32, length(av - h));            // where the picture really changed, follow it at once
  float w = exp(-dot(dd, dd) * 2.6) * 1.9;                    // a sample counts most for the screen pixel it actually landed on: over many frames this
  float kb = uMix > .99 ? 1. : clamp(uMix * w + mv * .3, 0., 1.);
  gl_FragColor = vec4(mix(h, mix(c, texture2D(uCur, cu).rgb, .55 + .45 * mv), kb), mix(h4.a, c4.a, kb));   // builds detail finer than the render resolution
}`;
/* Draw the blended image on the screen at the display's full resolution, with a little sharpening. */
const NEB_PRESENT = `precision highp float;
uniform sampler2D uTex, uNoise, uBloom; uniform vec2 uPx, uTx; uniform float uSharp, uBloomK, uDofR;
void main() {
  vec2 uv = gl_FragCoord.xy * uPx;
  vec4 c4 = texture2D(uTex, uv); vec3 c = c4.rgb; float coc = c4.a;
  vec3 n = texture2D(uTex, uv + vec2(uTx.x, 0.)).rgb + texture2D(uTex, uv - vec2(uTx.x, 0.)).rgb + texture2D(uTex, uv + vec2(0., uTx.y)).rgb + texture2D(uTex, uv - vec2(0., uTx.y)).rgb;
  c = max(vec3(0.), c + (c * 4. - n) * uSharp * (1. - coc));
  if (uDofR > 0. && coc > .03) {                                                       // depth of field: what is out of focus is spread over a small disc, as a lens would
    vec3 acc = c; float ws = 1., rad = coc * uDofR;
    for (int i = 0; i < 16; i++) { float fi = float(i) + .5, r = sqrt(fi / 16.) * rad, an = fi * 2.39996; vec4 sm = texture2D(uTex, uv + vec2(cos(an), sin(an)) * r * uTx); float w = clamp(sm.a * uDofR - r + 1., 0., 1.); acc += sm.rgb * w; ws += w; }   // only what is itself out of focus may spread, so sharp parts never smear
    c = acc / ws;
  }
  vec3 bl = texture2D(uBloom, uv).rgb; c += bl * uBloomK * (1. - c * .6);            // light bleeds softly from whatever is bright
  c += (texture2D(uNoise, gl_FragCoord.xy / 256. + .37).g - .5) / 255.;
  gl_FragColor = vec4(c, 1.);
}`;
/* Bloom: keep only what is bright, and blur it wide, in two passes at a quarter of the resolution. */
const NEB_BLOOM = `precision highp float;
uniform sampler2D uTex; uniform vec2 uPx, uDir; uniform float uThr;
void main() {
  vec2 uv = gl_FragCoord.xy * uPx; vec3 c = vec3(0.); float ws = 0.;
  for (int i = -7; i <= 7; i++) { float fi = float(i), w = exp(-fi * fi / 22.); vec3 s = texture2D(uTex, uv + uDir * fi).rgb; s = max(s - uThr, 0.) / max(1. - uThr, .05); c += s * w; ws += w; }
  gl_FragColor = vec4(c / ws, 1.);
}`;

/* The restructured renderer. Once per frame the creature's whole volume (its limbs, branches, voids, the turbulence and the
   shock fronts moving through it) is worked out one time, into a 3D texture. The rays then only look values up in that
   texture and add the fine grain, the skeleton and the light. Before, every one of those things was recomputed at every
   step of every ray. The shaders are derived from the single-pass one above, which stays as the fallback. */
const NEB_VN = 160;
function nebSources() {
  const cut = NEB_FRAG.indexOf('void main()'), common = NEB_FRAG.slice(0, cut); let main = NEB_FRAG.slice(cut);
  const i0 = main.indexOf('      vec3 s = p * .45 + uSeed;'), i1 = main.indexOf('      float haze = n3('); if (i0 < 0 || i1 < 0) throw new Error('march layout changed');
  const sub = (src, a, b) => { if (!src.includes(a)) throw new Error('missing: ' + a.slice(0, 50)); return src.replace(a, b); };
  let field = main.slice(i0, i1);
  field = sub(field, '      vec3 lF = normalize(uLight - p); lF.x *= sx; vec3 rdF = vec3(rd.x * sx, rd.yz);\n', '');
  field = sub(field, '      if (halo + sh < .03) continue;\n', '');
  field = sub(field, '      float gk = 1.;\n', '');
  field = sub(field, '      if (sh < .02) { gk = 1.9; t += dt * .9; }', '      //');
  field = sub(field, '      float sx = uSym', '      vec3 dsp = q - p;\n      float sx = uSym');
  const head = '#version 300 es\n#define texture2D texture\nprecision highp float; precision highp sampler3D;\n';
  const bake = head + 'layout(location = 0) out vec4 o0; layout(location = 1) out vec4 o1; layout(location = 2) out vec4 o2; layout(location = 3) out vec4 o3; uniform float uZ;\n' + common +
    'void main() {\n  vec3 p = vec3(gl_FragCoord.xy / ' + NEB_VN + '. * 2. - 1., uZ * 2. - 1.) * uB;\n  float turb = 1.1 + uLife.z * 1.4, tt = uT * .035;\n' + field +
    '  o0 = vec4(sh, halo, hAlong, gTip); o1 = vec4(tint, cv); o2 = vec4(dsp, ring); o3 = vec4(grow * .3 - melt * .6, bloom, rip, melt);\n}';
  const look = `      vec3 vc = p / (2. * uB) + .5; vec4 v0 = texture(uV0, vc); float fe = smoothstep(uB, uB * .88, length(p)), sh = v0.x * fe, halo = v0.y * fe;   // fade out toward the edge of the volume, so nothing is ever sliced off
      if (halo + sh < .03) continue;
      float gk = 1.;
      if (sh < .02) { gk = 1.9; t += dt * .9; }
      vec4 v1 = texture(uV1, vc), v2 = texture(uV2, vc), v3 = texture(uV3, vc);
      vec3 tint = v1.rgb, w = v2.xyz, q = p + w; float cv = v1.a, ring = v2.w, hAlong = v0.z, eadj = v3.x, bloom = v3.y, rip = v3.z, melt = v3.w;
      float sx = uSym > .5 && q.x < 0. ? -1. : 1.; q.x = mix(q.x, abs(q.x), uSym);
      vec3 lF = normalize(uLight - p); lF.x *= sx; vec3 rdF = vec3(rd.x * sx, rd.yz);
      gBest = 1e3; if (sh > .02) nearPillar(q);
`;
  main = main.slice(0, i0) + look + main.slice(i1);
  main = sub(main, '- melt * .6 + grow * .3', '+ eadj');
  if (!main.includes('dustLo(q + lF * .32)')) throw new Error('missing shadow call');
  main = main.split('dustLo(q + lF * .32)').join('shadowAt(p + normalize(uLight - p) * .32, q + lF * .32)');
  const extra = `uniform sampler3D uV0, uV1, uV2, uV3; out vec4 fragColor;
#define gl_FragColor fragColor
float nearPillar(vec3 q) {                   // which limb a point belongs to, for the frame and the grain. The dust itself comes from the volume.
  gBest = 1e3;
  for (int i = 0; i < 6; i++) {
    if (uCol[i].w > .5) {
      vec3 ba = uAxis[i].xyz * uAxis[i].w, pa = q - uPole[i].xyz; float h = clamp(dot(pa, ba) / dot(ba, ba), 0., 1.), r0 = uPole[i].w; vec4 tr = uTrait[i];
      float sd = length(pa - ba * h) - r0 * (1. - (.28 + .58 * tr.z) * h) * (1. + tr.w * .5 * (1. - h) * (1. - h));
      if (sd / r0 < gBest) { gBest = sd / r0; gPa = pa; gBa = ba; gR0 = r0; gTr = tr; gTr2 = uTrait2[i]; gVa = uVar[i]; gVb = uVar2[i]; gPu = uPulse[i]; }
    }
  }
  return gBest;
}
float shadowAt(vec3 ps, vec3 qs) {           // how much dust lies toward the light: two lookups and two noise fetches
  vec3 c = ps / (2. * uB) + .5; float s = texture(uV0, c).x;
  if (s < .02) return 0.;
  return smoothstep(-.3, .3, s + (fbm2(qs * 1.6 + vec3(0., -uT * .03, uT * .015) + uSeed) - .47) * 1.6 - .8) * texture(uV1, c).a;
}
`;
  let march = head + common + extra + main;
  march = sub(march, 'const int STEPS = 68;', 'const int STEPS = 88;');           // steps are cheap now, so take more of them
  march = sub(march, 'mod(float(i), 3.) < 1.', 'mod(float(i), 2.) < 1.');
  return { bake, march };
}
function nebScene(W, H) {                         // send this frame's values to each program, fill the volume, then draw the picture from it
  const gl = NEB.gl, V = NEB.vol, play = P => { gl.useProgram(P.p); for (const [fn, name, args] of NEB.calls) { const l = P.u[name]; if (l) gl[fn](l, ...args); } };
  if (V) {
    play(V.bake); gl.viewport(0, 0, V.n, V.n);
    for (let z = 0; z < V.n; z++) { gl.bindFramebuffer(gl.FRAMEBUFFER, V.fbs[z]); gl.uniform1f(V.bake.u.uZ, (z + .5) / V.n); gl.drawArrays(gl.TRIANGLES, 0, 3); }
    play(V.march);
  } else play(NEB.main);
  gl.bindFramebuffer(gl.FRAMEBUFFER, NEB.tg[0].fb); gl.viewport(0, 0, W, H); gl.drawArrays(gl.TRIANGLES, 0, 3);
}

function nebInit(cv) {
  const opts = { antialias: false, alpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: false };
  let gl = cv.getContext('webgl2', opts); const gl2 = !!gl; if (!gl) gl = cv.getContext('webgl', opts);
  if (!gl) throw new Error('no webgl');
  NEB.hdr = gl2 && !!gl.getExtension('EXT_color_buffer_float');   // 16-bit targets, so frames can be blended without banding
  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
  const vs = sh(gl.VERTEX_SHADER, 'attribute vec2 a; void main(){ gl_Position = vec4(a, 0., 1.); }');
  const vs3 = gl2 ? sh(gl.VERTEX_SHADER, '#version 300 es\nin vec2 a; void main(){ gl_Position = vec4(a, 0., 1.); }') : null;
  const mk = (src, names, v) => { const p = gl.createProgram(); gl.attachShader(p, v || vs); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, src)); gl.bindAttribLocation(p, 0, 'a'); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p)); const u = {}; for (const n of names) u[n] = gl.getUniformLocation(p, n);
    const nu = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); for (let i = 0; i < nu; i++) { const nm = gl.getActiveUniform(p, i).name.replace(/\[0\]$/, ''); u[nm] = gl.getUniformLocation(p, nm); } return { p, u }; };
  NEB.res = mk(NEB_RESOLVE, ['uCur', 'uHist', 'uPx', 'uTx', 'uJit', 'uMix']); NEB.out = mk(NEB_PRESENT, ['uTex', 'uNoise', 'uPx', 'uTx', 'uSharp', 'uBloom', 'uBloomK']); NEB.blm = mk(NEB_BLOOM, ['uTex', 'uPx', 'uDir', 'uThr']);
  NEB.vol = null;
  if (NEB.hdr && !NEB.noVol) try {
    const S = nebSources(), n = NEB_VN, V = { n, bake: mk(S.bake, [], vs3), march: mk(S.march, [], vs3), tex: [], fbs: [] };
    for (let k = 0; k < 4; k++) { const t = gl.createTexture(); gl.activeTexture(gl.TEXTURE4 + k); gl.bindTexture(gl.TEXTURE_3D, t); gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA16F, n, n, n, 0, gl.RGBA, gl.HALF_FLOAT, null);
      for (const [a, b] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_3D, a, b); V.tex.push(t); }
    for (let z = 0; z < n; z++) { const f = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, f); for (let k = 0; k < 4; k++) gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + k, V.tex[k], 0, z);
      gl.drawBuffers([0, 1, 2, 3].map(k => gl.COLOR_ATTACHMENT0 + k)); if (z === 0 && gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('volume target incomplete'); V.fbs.push(f); }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.activeTexture(gl.TEXTURE0);
    gl.useProgram(V.march.p); for (let k = 0; k < 4; k++) gl.uniform1i(V.march.u['uV' + k], 4 + k); gl.uniform1i(V.march.u.uNoise, 0); gl.useProgram(V.bake.p); gl.uniform1i(V.bake.u.uNoise, 0);
    NEB.vol = V;
  } catch (e) { console.warn('volume renderer unavailable, using the single-pass one:', e.message); NEB.vol = null; NEB.volErr = String(e.message); gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.activeTexture(gl.TEXTURE0); }
  if (!NEB.vol) { NEB.main = mk(NEB_FRAG, []); gl.useProgram(NEB.main.p); gl.uniform1i(NEB.main.u.uNoise, 0); }
  NEB.calls = []; NEB.shim = new Proxy(gl, { get: (g, k) => typeof k === 'string' && k.startsWith('uniform') ? (loc, ...a) => { NEB.calls.push([k, loc, a]); } : (typeof g[k] === 'function' ? g[k].bind(g) : g[k]) });   // uniforms are recorded by name, then sent to whichever programs draw this frame
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer()); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  // noise texture: G is R shifted by (37,17), which lets one fetch give two layers of 3D noise
  const N = 256, px = new Uint8Array(N * N * 4), r = new Uint8Array(N * N);
  let x = 1234567; const rnd = () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return (x >>> 0) & 255; };
  for (let i = 0; i < N * N; i++) r[i] = rnd();
  for (let y = 0; y < N; y++) for (let xx = 0; xx < N; xx++) { const o = (y * N + xx) * 4; px[o] = r[y * N + xx]; px[o + 1] = r[((y - 17) & 255) * N + ((xx - 37) & 255)]; px[o + 2] = rnd(); px[o + 3] = 255; }
  gl.bindTexture(gl.TEXTURE_2D, gl.createTexture()); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, N, N, 0, gl.RGBA, gl.UNSIGNED_BYTE, px);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  for (const n of ['uRes', 'uCenter', 'uT', 'uTan', 'uDist', 'uSeed', 'uCam', 'uNoise', 'uPole', 'uAxis', 'uCol', 'uTrait', 'uTrait2', 'uVoid', 'uWave', 'uWaveAmp', 'uStar', 'uAud', 'uLife', 'uLight', 'uKey', 'uAmb', 'uB', 'uFrame', 'uRip', 'uReson', 'uTouch', 'uForm', 'uGy', 'uDiscN', 'uDiscU', 'uDiscV', 'uDisc', 'uRing', 'uProg', 'uSweep', 'uWaveK', 'uWaveN', 'uFood', 'uSym', 'uBuild', 'uFract', 'uFine', 'uEvP', 'uEvI', 'uFil', 'uFilC', 'uVar', 'uVar2', 'uPulse', 'uScar', 'uDof']) NEB.U[n] = n;
  NEB.gl = gl; NEB.nz = r;
}
/* Three off-screen targets at the render resolution: this frame, and two that take turns holding the running blend. */
/* Two sets of targets: the live view's, and a separate one for time-lapse frames, so recording never disturbs what is on screen. */
function nebUse(rec) {
  const S = NEB.sets || (NEB.sets = [{ u: 1, ub: 8 }, { u: 10, ub: 13 }]), cur = NEB.setI == null ? null : S[NEB.setI], nx = S[rec ? 1 : 0];
  if (cur) { cur.tg = NEB.tg; cur.bl = NEB.bl; cur.flip = NEB.flip; cur.fresh = NEB.fresh; }
  NEB.setI = rec ? 1 : 0; NEB.tg = nx.tg; NEB.bl = nx.bl; NEB.flip = nx.flip || 0; NEB.fresh = nx.fresh !== false && !nx.tg ? true : !!nx.fresh; NEB.u = nx.u; NEB.ub = nx.ub;
}
function nebTargets(W, H, CW, CH, rec) {   // this frame at the render resolution; the running blend at the display's resolution, so it survives render-resolution changes
  const gl = NEB.gl;
  NEB.tg = NEB.tg || [0, 1, 2].map(() => ({ tex: gl.createTexture(), fb: gl.createFramebuffer(), w: 0, h: 0 }));
  NEB.tg.forEach((g, i) => {
    const w = i ? CW : W, h = i ? CH : H; if (g.w === w && g.h === h) return;
    g.w = w; g.h = h; if (i) NEB.fresh = true;
    gl.activeTexture(gl.TEXTURE0 + NEB.u + i); gl.bindTexture(gl.TEXTURE_2D, g.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, NEB.hdr ? gl.RGBA16F : gl.RGBA, w, h, 0, gl.RGBA, NEB.hdr ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, g.fb); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, g.tex, 0);
  });
  NEB.bl = NEB.bl || [0, 1].map(() => ({ tex: gl.createTexture(), fb: gl.createFramebuffer(), w: 0, h: 0 }));
  NEB.bl.forEach((g, i) => { const w = Math.max(2, CW >> 2), h = Math.max(2, CH >> 2); if (g.w === w && g.h === h) return; g.w = w; g.h = h;
    gl.activeTexture(gl.TEXTURE0 + NEB.ub + i); gl.bindTexture(gl.TEXTURE_2D, g.tex); gl.texImage2D(gl.TEXTURE_2D, 0, NEB.hdr ? gl.RGBA16F : gl.RGBA, w, h, 0, gl.RGBA, NEB.hdr ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, g.fb); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, g.tex, 0); });
  if (rec) { const o = NEB.recOut || (NEB.recOut = { tex: gl.createTexture(), fb: gl.createFramebuffer(), w: 0, h: 0 });   // where a time-lapse frame is finished, instead of the screen
    if (o.w !== CW || o.h !== CH) { o.w = CW; o.h = CH; gl.activeTexture(gl.TEXTURE15); gl.bindTexture(gl.TEXTURE_2D, o.tex); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, CW, CH, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindFramebuffer(gl.FRAMEBUFFER, o.fb); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, o.tex, 0); } }
  else { NEB.tw = W; NEB.th = H; }
  gl.activeTexture(gl.TEXTURE0); gl.bindFramebuffer(gl.FRAMEBUFFER, null);
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
    cv.addEventListener('dblclick', e => { const c = Gym.cur; if (!c) return; const G = fxOf(c.slug).ngeom; if (!G) return; const hit = nebUnder(c, G, e.offsetX, e.offsetY);   // double-click a limb: ask it to sing
      if (hit.kind === 'pillar') gymSing(c, c.limbs && c.limbs.length > 1 ? c.limbs[hit.o.j % c.limbs.length].id : null); });
  }
  return NEB.canvas;
}

const hsl2rgb = (h, s, l) => { h = ((h % 360) + 360) % 360 / 360; const q = l < .5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q, f = t => { t = (t + 1) % 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < .5 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; }; return [f(h + 1 / 3), f(h), f(h - 1 / 3)]; };
const nvec = (t, k) => [noise(t + k), noise(t * 1.07 + k + 31.7), noise(t * .93 + k + 77.1)];

/* Save a still far sharper than the screen: time stops, the picture is rendered at up to 3840 px and averaged over many frames, then written to outputs/captures. */
function nebCapture() { if (!NEB.ok || NEB.shot || !Gym.cur) return; NEB.shot = { t: NEB.last || performance.now() / 1000, n: 0, frames: 36, slug: Gym.cur.slug }; toast('capturing a still…'); }
function nebFrame(c, t, mouse, onScreen) {
  const SHOT = onScreen && NEB.shot && NEB.shot.rec ? null : NEB.shot, REC = !!(SHOT && SHOT.rec);   // a time-lapse frame is drawn off-screen, in its own targets; the live view carries on beside it
  nebUse(REC);
  if (SHOT) { t = SHOT.t; if (SHOT.c) c = SHOT.c; }   // a time-lapse frame is drawn from its own copy of the creature, on its own clock
  const GL = NEB.gl, gl = NEB.shim, cv = NEB.canvas, U = NEB.U, d = dna(c), fx = fxOf(c.slug), n = d.n, sd = d.seed * 100;
  // resolution: as sharp as this machine can hold at full frame rate
  if (NEB.last && !SHOT) {
    const fdt = Math.min(.1, t - NEB.last) * (NEB.half ? .5 : 1);   // at half frame rate, a frame that takes two display frames is on time, not late
    NEB.acc += fdt; NEB.fast = (NEB.fast || 0) + fdt; NEB.fastN = (NEB.fastN || 0) + 1;
    if (fdt < .012) NEB.short = (NEB.short || 0) + 1;                          // many short frames means a fast display, where real headroom is visible
    const drop = ms => { NEB.q = Math.max(.62, NEB.q * Math.max(.8, Math.min(.92, Math.sqrt(16.7 / ms)))); NEB.cap = NEB.q; NEB.capT = t; NEB.hold = Math.min(600, (NEB.hold || 20) * 2);   // it could not hold that size: stay at the smaller one, and wait longer each time before trying a step up again
      NEB.acc = 0; NEB.frames = 0; NEB.fast = 0; NEB.fastN = 0; };
    if (NEB.fastN >= 8) { const ms = NEB.fast / NEB.fastN * 1000; NEB.fast = 0; NEB.fastN = 0; if (ms > (NEB.half ? 24 : 20) && NEB.frames >= 0) drop(ms); }   // falling behind (a touch, a wave): give up resolution at once
    if (++NEB.frames >= 40) { const ms = NEB.acc / NEB.frames * 1000; NEB.ms = ms; const room = 17.4; NEB.short = 0;   // on a fast display we can see real headroom, so keep some for when it is touched
      if (ms > (NEB.half ? 21 : 18.5)) drop(ms); else if (ms < room && (!NEB.cap || t - NEB.capT > NEB.hold)) { NEB.capT = t; NEB.q = Math.min(NEB.qMax || 1, NEB.q * 1.06); }
      NEB.acc = 0; NEB.frames = 0; } }
  if (!REC) NEB.last = t;
  if (NEB.frames === 0 && NEB.hud !== false) { const hud = document.getElementById('gym-fps'); if (hud && Gym.sing) hud.textContent = Gym.sing.msg; else if (hud && NEB.ms) hud.textContent = (Gym.rec ? `● rec ${Gym.rec.i} · ` : '') + `${Math.round(1000 / NEB.ms)} fps · ${NEB.tw || 0}×${NEB.th || 0}`; }
  if ((fx.waves && fx.waves.some(w => t - w.t0 < 1.6)) || NEB.drag.on || (fx.ev && fx.ev.length)) NEB.busyT = t;   // while it is being touched or struck, each frame costs more:
  const busy = NEB.busyT != null && t - NEB.busyT < 1.2;                                                              // render a little smaller for that moment so it never stutters. The frame blend hides the step.
  let dpr = devicePixelRatio || 1, cw = cv.clientWidth, ch = cv.clientHeight, sc = dpr * NEB.q * (busy ? .8 : 1), W = Math.max(2, Math.round(cw * sc)), H = Math.max(2, Math.round(ch * sc));
  let CW = Math.max(2, Math.round(cw * dpr)), CH = Math.max(2, Math.round(ch * dpr));
  if (SHOT) { const k = Math.min(SHOT.size || 3840, GL.getParameter(GL.MAX_TEXTURE_SIZE)) / Math.max(cw, ch); sc = k; W = CW = Math.round(cw * k); H = CH = Math.round(ch * k); }   // the canvas itself is always at the display's full resolution
  if (!REC && (cv.width !== CW || cv.height !== CH)) { cv.width = CW; cv.height = CH; }
  nebTargets(W, H, CW, CH, REC);
  NEB.calls.length = 0;
  NEB.nf = (NEB.nf || 0) + 1; if (NEB.nf % 90 === 5 && !c.slug.includes('#')) grainWarm(c); if ((NEB.nf === 2 || NEB.nf === 200 || NEB.nf === 600 || NEB.nf === 1500) && typeof _clog === 'function') _clog(`info: entity renderer ${NEB.vol ? 'volume' : 'single-pass' + (NEB.volErr ? ' (' + NEB.volErr.slice(0, 160) + ')' : '')}, frame ${NEB.nf}, ${NEB.ms ? NEB.ms.toFixed(1) + ' ms' : 'timing…'}, ${NEB.tw}x${NEB.th}`);   // one line in the app log saying which renderer is in use
  const fr = (NEB.fr || 0) + 1, hal = (i, b) => { let f = 1, r = 0; while (i > 0) { f /= b; r += f * (i % b); i = Math.floor(i / b); } return r; };
  const jx = hal(fr % 16 + 1, 2) - .5, jy = hal(fr % 16 + 1, 3) - .5;   // a different spot inside the pixel every frame

  const au = audioLevels(), lv = au ? au.level : 0, S = Math.min(cw, ch), cx0 = cw / 2, cy0 = ch / 2 * .94;
  const L = live(fx, d, t, mouse, cx0, cy0, S, au), kick = Math.exp(-(t - L.beat) * 7), dt = SHOT ? (SHOT.rec && SHOT.n === 0 ? SHOT.step : 0) : (L.dt || .016), ease = Math.min(1, dt * 1.7);   // during a capture, time stands completely still
  const cx = cx0 + L.dx, cy = cy0 + L.dy;
  // nothing switches on or off: training fades in and out, and every state-driven value glides
  const trOn = !!(c.training && c.training.state === 'running'); fx.trn = (fx.trn || 0) + ((trOn ? 1 : 0) - (fx.trn || 0)) * Math.min(1, dt * .8); const trn = fx.trn;
  const SM = fx.sm || (fx.sm = {}), sm = (k, v, rate) => (SM[k] = SM[k] == null ? v : SM[k] + (v - SM[k]) * Math.min(1, dt * (rate || 1.2)));
  fx.clock = (fx.clock == null ? t % 1000 : fx.clock) + dt * (1 + .5 * trn);

  // camera
  const cy_ = Math.cos(L.yaw), sy_ = Math.sin(L.yaw), cp = Math.cos(L.pitch * .7), sp = Math.sin(L.pitch * .7), cr = Math.cos(L.roll * .6), sr = Math.sin(L.roll * .6);
  const M = [[cy_ * cr + sy_ * sp * sr, -cy_ * sr + sy_ * sp * cr, sy_ * cp], [cp * sr, cp * cr, -sp], [-sy_ * cr + cy_ * sp * sr, sy_ * sr + cy_ * sp * cr, cy_ * cp]];   // Ry * Rx * Rz
  const dist = 9, grow = n ? .98 + .1 * clamp(d.minutes / 30, 0, 1) + .14 * d.growth : .55, tan = Math.max(.56 / grow, (fx.extR || 0) / dist * 1.15) * (1 + .04 * (L.breath - .5));   // never so close that the body leaves the frame
  const rot = v => [M[0][0] * v[0] + M[0][1] * v[1] + M[0][2] * v[2], M[1][0] * v[0] + M[1][1] * v[1] + M[1][2] * v[2], M[2][0] * v[0] + M[2][1] * v[1] + M[2][2] * v[2]];
  const toCam = p => [M[0][0] * p[0] + M[1][0] * p[1] + M[2][0] * p[2], M[0][1] * p[0] + M[1][1] * p[1] + M[2][1] * p[2], M[0][2] * p[0] + M[1][2] * p[1] + M[2][2] * p[2]];
  const proj = p => { const q = toCam(p), depth = dist - q[2]; return [cx + q[0] / (depth * tan) * S / 2, cy - q[1] / (depth * tan) * S / 2, depth]; };
  const unproj = (px, py, depth) => rot([(px - cx) / (S / 2) * depth * tan, -(py - cy) / (S / 2) * depth * tan, dist - depth]);

  // the pillars: one per limb, eased toward where they should be so feeding and training make it grow and morph
  const limbs = c.limbs && c.limbs.length > 1 ? c.limbs : null, K = n ? Math.min(6, Math.max(2, limbs ? limbs.length : 0) + (n > 12 ? 1 : 0)) : 1;
  const N = fx.neb || (fx.neb = { slots: [...Array(6)].map(() => ({ p: [0, 0, 0], a: [0, 1, 0], len: .3, rad: .3, col: [.5, .3, .8], w: 0, ring: 0, tr: [.2, .3, .3, .3, .4, .5], pu: [0, 0, .1], pv: 0, po: [0, 0, 0], pw: [0, 0, 0], pt: [0, 0, 0] })), fresh: true });
  const pointer = mouse ? unproj(L.sx, L.sy, dist) : null;
  // mood: an untrained or struggling creature is restless and twitchy; as it learns, its movement slows and becomes assured
  const calm = n ? clamp(d.learned * 1.15, 0, 1) : .5, restless = (1 - calm) * (n && (d.epochs || trOn) ? 1 : .35);
  fx.mclock = (fx.mclock == null ? t % 1000 : fx.mclock) + dt * (.7 + .95 * (1 - calm)); const tm = fx.mclock;
  if (n && dt > 0 && Math.random() < dt * .05 * restless) L.startle = Math.max(L.startle, .1 + Math.random() * .1);
  L.flinch = false;
  if (n && dt > 0 && (fx.postNext == null || t > fx.postNext)) {                                 // posture: now and then a few limbs shift to a new pose and settle there, with weight
    if (fx.postNext != null) for (let k = 0, m = 1 + Math.floor(Math.random() * 3); k < m; k++) { const sl = N.slots[Math.floor(Math.random() * 6)]; sl.pt = [0, 1, 2].map(() => (Math.random() - .5) * .75); }
    fx.postNext = t + (5 + Math.random() * 11) * (.6 + .9 * calm);
  }
  N.slots.forEach((s, j) => {
    const on = j < K, limb = limbs && limbs[j], share = limb ? limb.count / n : 1 / K;
    const yy = K > 1 ? clamp(1 - 2 * (j + .5) / K, -1, 1) : 0, rr = Math.sqrt(Math.max(0, 1 - yy * yy)), ph = j * 2.39996 + d.bright * 9 + d.low * 5 + d.bpm * .021 + d.seed * .6, base = [Math.cos(ph) * rr, yy * .75, Math.sin(ph) * rr];
    const sm_ = limb ? limb.mean : d, S_ = { noise: clamp((sm_.noise ?? .2) * 1.25, 0, 1), dyn: clamp(((sm_.dyn ?? .3) - .15) * 1.8, 0, 1), bright: clamp(((sm_.bright ?? .3) - .12) * 2.2, 0, 1), low: clamp(((sm_.low ?? .3) - .35) * 1.9, 0, 1), bpm: clamp(((sm_.bpm ?? 100) - 65) / 110, 0, 1), loud: clamp(sm_.loud ?? .5, 0, 1) };   // this limb's sound, stretched so real music spans the range
    const wn = nvec(tm * .045, j * 13 + sd), an = nvec(tm * .038, j * 29 + sd + 50), jit = nvec(t * 1.9, j * 7 + sd + 400), spread = n ? (.75 + .45 * d.growth) * (.78 + .55 * S_.dyn) * (1 + .05 * (L.breath - .5)) : 0;
    const tp = [base[0] * spread + wn[0] * .45, base[1] * spread + wn[1] * .45 - .5, base[2] * spread + wn[2] * .45];
    let ta = [base[0] * .9 + an[0] * 1.1, base[1] * .9 + an[1] * 1.1 + .55, base[2] * .9 + an[2] * 1.1];
    if (n) ta[1] += (S_.bpm - .45) * 1.2;                                                          // fast food reaches up and out, slow food hangs
    { const kS = 5 + 9 * (1 - calm), cS = 2 * Math.sqrt(kS) * .42;                                 // the pose is carried on a soft spring: it overshoots a little and settles
      for (let k = 0; k < 3; k++) { s.pw[k] += ((s.pt[k] - s.po[k]) * kS - s.pw[k] * cS) * dt; s.po[k] += s.pw[k] * dt; if (!isFinite(s.po[k])) { s.po[k] = 0; s.pw[k] = 0; } ta[k] += s.po[k] + jit[k] * .13 * restless; } }
    const vk = c.slug + '|' + j + '|' + (limb ? limb.id + ':' + limb.count : n);                 // this limb's own skeleton, from how its food sounds and from who it is
    if (s.vk !== vk) { s.vk = vk; const hv = k => hash(c.slug + 'var' + j + '.' + k), best = a => a.indexOf(Math.max(...a));
      s.va = [clamp((S_.bpm - .4) * 1.4 + (hv(0) - .5) * .8, -.7, .85), clamp((hv(1) - .5) * .5 + (S_.low - .4) * .35, -.3, .4),
        best([.55 + hv(2) * .3, S_.dyn * 1.1 + hv(3) * .45, S_.bright * 1.1 + hv(4) * .45, S_.noise * 1.2 + hv(5) * .45]), -1.3 + clamp(S_.bright * .6 + hv(6) * .6, 0, 1)];
      s.vb = [best([.5 + hv(7) * .35, S_.low * 1.1 + hv(8) * .4, (1 - S_.bpm) * .75 + hv(9) * .4]), clamp(S_.noise * 1.1 + (hv(10) - .55) * .9, 0, 1),
        2 + Math.floor(clamp(S_.dyn * .8 + hv(11) * .7, 0, .999) * 4), (hv(12) < .5 ? -1 : 1) * (1.2 + 2 * S_.bpm + hv(13) * .8)]; }
    if (j === 0) { tp[0] = wn[0] * .1; ta[0] = an[0] * .2; ta[1] += .9; }                       // the first limb is the spine, on the midline
    else { tp[0] = Math.abs(tp[0]) + .28; ta[0] = Math.abs(ta[0]) + .2; }                          // the others come in mirrored pairs
    if (pointer && L.curious > .05) for (let k = 0; k < 3; k++) ta[k] += (pointer[k] - tp[k]) * .2 * L.curious;       // it leans toward you when curious
    const al = Math.hypot(ta[0], ta[1], ta[2]) || 1; ta = ta.map(v => v / al);
    const tl = n ? (1.1 + 2.0 * d.growth + .5 * clamp(d.minutes / 30, 0, 1)) * (.55 + .9 * Math.sqrt(share)) * (1 + .06 * (L.breath - .5)) * (.72 + .75 * S_.bright) * (1.2 - .42 * S_.low) * (.86 + .28 * S_.loud) : .5;
    const trd = (n ? (.4 + .5 * Math.sqrt(share)) * (.7 + .85 * S_.low) * (1.12 - .4 * S_.bright) * (.86 + .28 * S_.loud) : .45) * (1 + (au ? au.bass * .38 : 0) + kick * .1) * (1 - .05 * L.startle) * (1 + s.ring * .22 * Math.sin(t * 19)) * (1 + .07 * (L.breath - .5));
    const tc = hsl2rgb(hueOf(limb ? limb.mean.bright : d.bright) + (limb ? 0 : j * 24) + noise(t * .02 + j + sd) * 14, .72, .56), tw = on ? (limb || !limbs ? 1 : .6) : 0, e = N.fresh ? 1 : ease;
    for (let k = 0; k < 3; k++) { if (!isFinite(s.p[k])) s.p[k] = tp[k]; if (!isFinite(s.a[k])) s.a[k] = ta[k]; if (!isFinite(s.col[k])) s.col[k] = tc[k];
      s.p[k] += (tp[k] - s.p[k]) * e; s.a[k] += (ta[k] - s.a[k]) * e; s.col[k] += (tc[k] - s.col[k]) * e; }
    if (!isFinite(s.len)) s.len = tl; if (!isFinite(s.rad)) s.rad = trd; if (!isFinite(s.w)) s.w = 0;
    [S_.noise, S_.dyn, S_.bright, S_.low, S_.bpm, clamp(share * K * .5, 0, 1)].forEach((v, k) => { s.tr[k] += ((n ? v : s.tr[k]) - s.tr[k]) * e; });
    s.len += (tl - s.len) * e * .6; s.rad += (trd - s.rad) * Math.min(1, e * 4); s.w += (tw - s.w) * e; s.ring *= Math.exp(-dt * 2.2);
  });
  const singing = Gym.sing && Gym.sing.slug === c.slug ? Gym.sing : null; fx.sng = (fx.sng || 0) + ((singing ? 1 : 0) - (fx.sng || 0)) * Math.min(1, dt * 1.6); const sng = fx.sng, busyK = Math.max(trn, sng);
  if (singing) { const si = limbs ? Math.max(0, limbs.findIndex(l => l.id === singing.limb)) : 0, ss = N.slots[Math.min(si, K - 1)];   // composing: the limb that was asked hums, energy climbs it again and again, and the others answer
    fx.sfr = Math.max(singing.id === fx.sid ? fx.sfr || 0 : 0, singing.frac || 0); fx.sid = singing.id;
    if (ss) { ss.ring = Math.max(ss.ring, .5 + .35 * Math.sin(t * 5)); if (ss.pu[1] < .12) { ss.pu = [0, .95, .1]; ss.pv = .85; } }
    if (dt > 0 && Math.random() < dt * 1.1) { const o = N.slots[Math.floor(Math.random() * K)]; if (o && o !== ss && o.w > .3 && o.pu[1] < .1) { o.pu = [1, .45, .1]; o.pv = -.9; } } }
  N.fresh = false;
  { let er = 0; N.slots.forEach(sl => { if (sl.w > .3) er = Math.max(er, Math.hypot(Math.abs(sl.p[0]) + Math.abs(sl.a[0]) * sl.len, sl.p[1] + sl.a[1] * sl.len, sl.p[2] + sl.a[2] * sl.len) + sl.rad * 1.3 + sl.len * .28); }); fx.extR = fx.extR == null ? er : fx.extR + (er - fx.extR) * Math.min(1, dt * .8); }
  { let spill = 0;                                                                              // energy from a strike runs down the struck limb to the core, then out along every other limb
    N.slots.forEach(s => { const pu = s.pu; if (pu[1] <= .01) { pu[1] = 0; return; } pu[0] += s.pv * dt; pu[1] *= Math.exp(-dt * .55); if (s.pv < 0 && pu[0] <= 0) { spill = Math.max(spill, pu[1]); pu[1] = 0; } else if (pu[0] > 1.15) pu[1] = 0; });
    if (spill > .05) N.slots.forEach(s => { if (s.w > .3) { s.pu = [0, spill * .8, .11]; s.pv = 1.15; s.ring = Math.max(s.ring, spill * .5); } }); }
  const pole = new Float32Array(24), axis = new Float32Array(24), col = new Float32Array(24), trA = new Float32Array(24), trB = new Float32Array(24), vA = new Float32Array(24), vB = new Float32Array(24), puA = new Float32Array(24);
  N.slots.forEach((s, j) => { vA.set(s.va || [0, 0, 0, -.9], j * 4); vB.set(s.vb || [0, 0, 3, 2.2], j * 4); puA.set([s.pu[0], s.pu[1], s.pu[2], 0], j * 4); });
  N.slots.forEach((s, j) => { pole.set([s.p[0], s.p[1], s.p[2], s.rad], j * 4); axis.set([s.a[0], s.a[1], s.a[2], s.len], j * 4); col.set([s.col[0], s.col[1], s.col[2], s.w < .01 ? 0 : s.w], j * 4); trA.set([s.tr[0], s.tr[1], s.tr[2], s.tr[3]], j * 4); trB.set([s.tr[4], s.tr[5], 0, 0], j * 4); });

  // voids: wandering cavities
  const nv = n ? 1 + (K > 2 ? 1 : 0) + (K > 4 ? 1 : 0) : 0, voids = new Float32Array(12), vlist = [];
  for (let k = 0; k < nv; k++) { const w = nvec(t * .04, k * 41 + sd + 9), s = N.slots[k % K], p = [s.p[0] + s.a[0] * s.len * .45 + w[0] * 1.1, s.p[1] + s.a[1] * s.len * .45 + w[1] * 1.1, s.p[2] + s.a[2] * s.len * .45 + w[2] * 1.1], r = (.34 + .16 * noise(t * .06 + k * 7 + sd)) * (1 + kick * .25 + L.startle * .15);
    voids.set([p[0], p[1], p[2], r], k * 4); vlist.push({ p, r }); }

  // shock fronts
  fx.waves = fx.waves.filter(w => t - w.t0 < 5);
  const pickLimb = v => { if (!limbs) return v % K; let x = ((v * .618034) % 1) * n, i = 0; for (; i < limbs.length - 1 && x >= limbs[i].count; i++) x -= limbs[i].count; return Math.min(i, K - 1); };   // beats and training steps land on limbs in proportion to what each was fed: every step is one track
  const wave = new Float32Array(32), wamp = new Float32Array(8), wk = new Float32Array(32), wnv = new Float32Array(32), taps = [];
  for (const w of fx.waves) for (const [dly, amp] of (w.taps || [[0, 1], [.55, .55], [1.15, .3], [1.85, .16]])) {           // each front can come back, like reverb taps
    const age = t - w.t0 - dly, life = w.life || 2.6; if (age < 0 || age > life) continue;
    const sl = N.slots[pickLimb(w.pole || 0)], o = w.o || [sl.p[0] + sl.a[0] * sl.len * .5, sl.p[1] + sl.a[1] * sl.len * .5, sl.p[2] + sl.a[2] * sl.len * .5], sp = w.speed || 2.1, mode = w.mode || 0;
    taps.push({ o, r: w.implode ? Math.max(0, 2.6 - age * sp) : mode === 1 ? age * sp - 1.4 : mode === 2 ? age * sp * .6 : age * sp, a: (1 - age / life) * (w.soft ? .5 : 1) * amp * (w.amp || 1), k: w.width || 2.2, mode, n: w.n || [0, 1, 0], g: w.pole != null ? 0 : 1 });   // g: a touch or a strike, which also dissolves and flushes; beats and training pulses only ripple
  }
  for (const cg of fx.chg || []) taps.push({ o: cg.o, r: 0, a: cg.a, k: 2.7, mode: 0, n: [0, 1, 0], g: 1 });   // where a strike is about to land, the body starts to glow
  taps.sort((a, b) => b.a - a.a).slice(0, 6).forEach((tp, k) => { wave.set([tp.o[0], tp.o[1], tp.o[2], tp.r], k * 4); wamp[k] = tp.a; wk.set([tp.k, tp.mode, tp.g, 0], k * 4); wnv.set([tp.n[0], tp.n[1], tp.n[2], 0], k * 4); });

  // resonance: each pillar emits at its limb's tempo; the tail keeps everything ringing after sound stops
  L.tail = Math.max(lv, (L.tail || 0) * Math.exp(-dt / 1.3));
  const rip = new Float32Array(24);
  N.slots.forEach((sl, j) => { const limb = limbs && limbs[j], bpm = (limb && limb.mean.bpm) || d.bpm || 100, br = limb ? limb.mean.bright : d.bright;
    rip.set([2 * Math.PI / (.85 - .5 * clamp(br, 0, 1) + .2 * (120 / clamp(bpm, 60, 200))), bpm / 60 * Math.PI, j * 1.9 + d.seed * 9, .75 + .25 * noise(t * .1 + j * 3 + sd)], j * 4); });
  const depth = n ? clamp((.07 + .2 * d.learned + .1 * d.growth) * (1 + L.tail * 2.6) + kick * .15 + L.startle * .1, 0, .7) : .03;

  // stars: one ignites every 25 epochs
  const ns = Math.min(8, Math.floor(d.epochs / 25)), star = new Float32Array(32);                  // stars are earned: one per 25 finished epochs
  for (let k = 0; k < ns; k++) { const s = N.slots[k % K], hh = hash(c.slug + 'star' + k), u = .55 + hh * .5, o = nvec(t * .03, k * 17 + sd), newest = false;
    star.set([(s.p[0] + s.a[0] * s.len * u + o[0] * .25) * (k % 2 ? -1 : 1), s.p[1] + s.a[1] * s.len * u + o[1] * .25, s.p[2] + s.a[2] * s.len * u + o[2] * .25,
      (.55 + .3 * hh + .2 * noise(t * 1.3 + k * 9) + (au ? au.high * .8 : 0)) * (newest ? .25 + .75 * Math.abs(noise(t * 7)) : 1)], k * 4); }

  const hue = hueOf(d.bright) + noise(t * .02 + sd) * 16 + (au ? (au.high - au.bass) * 40 : 0), lw = nvec(t * .05, sd + 200);
  const light = [lw[0] * 3.2 + (pointer ? pointer[0] * .5 * L.curious : 0), 3 + lw[1] * 1.2 + (pointer ? pointer[1] * .5 * L.curious : 0), lw[2] * 3.2 + 1.5];
  const key = hsl2rgb(hue + 30, .35, .82), amb = hsl2rgb(hue + 50 + d.seed * 140, .85, .5);
  const turb = sm('turb', (n ? (1 - d.learned) * (d.epochs ? .45 : .7) : .5) + (d.digesting ? .4 : 0)) + lv * .9 + L.startle * .8 + trn * .15;
  gl.uniform2f(U.uRes, W, H); gl.uniform2f(U.uCenter, cx * sc + jx, (ch - cy) * sc + jy);
  gl.uniform1f(U.uT, fx.clock); gl.uniform1f(U.uTan, tan); gl.uniform1f(U.uDist, dist); gl.uniform1f(U.uSeed, d.seed * 40);
  gl.uniformMatrix3fv(U.uCam, false, [M[0][0], M[1][0], M[2][0], M[0][1], M[1][1], M[2][1], M[0][2], M[1][2], M[2][2]]);
  gl.uniform4fv(U.uTrait, trA); gl.uniform4fv(U.uTrait2, trB); gl.uniform4fv(U.uVar, vA); gl.uniform4fv(U.uVar2, vB); gl.uniform4fv(U.uPulse, puA); gl.uniform4fv(U.uPole, pole); gl.uniform4fv(U.uAxis, axis); gl.uniform4fv(U.uCol, col); gl.uniform4fv(U.uVoid, voids);
  gl.uniform4fv(U.uWave, wave); gl.uniform1fv(U.uWaveAmp, wamp); gl.uniform4fv(U.uWaveK, wk); gl.uniform4fv(U.uWaveN, wnv); gl.uniform4fv(U.uRip, rip); gl.uniform4f(U.uReson, depth, L.tail, .35 + .4 * d.learned, 0); gl.uniform4fv(U.uStar, star);
  gl.uniform4f(U.uAud, au ? au.bass : 0, au ? au.mid : 0, au ? au.high : 0, lv);
  gl.uniform4f(U.uLife, sm('sharp', n ? (d.epochs ? .4 + .6 * Math.max(d.learned, d.growth * .8) : .3) : .1, .6), d.growth, turb, kick + trn * .15);
  // form: structure that only exists once it has trained
  const form = sm('form', n && d.epochs ? clamp(d.growth * 1.12 * (.7 + .3 * d.learned), 0, 1) : 0, .6);
  const nrings = n && d.epochs ? Math.min(8, K + Math.floor(d.epochs / 60), Math.floor(d.epochs / 20)) : 0, rings = new Float32Array(32);
  for (let j = 0; j < nrings; j++) { const limb = limbs && limbs[j % limbs.length], bpm = (limb && limb.mean.bpm) || d.bpm || 100, share = limb ? limb.count / n : .5;
    rings.set([1.95 + j * .25 + .04 * noise(t * .1 + j * 5 + sd), clamp(.35 + share * 1.2 + (au ? au.mid * .4 : 0), .3, .95), 1 + ((j * 2 + Math.round(bpm / 40)) % 5), bpm / 60 * .28 * (j % 2 ? 1 : -1)], j * 4); }
  const dn0 = nvec(t * .03, sd + 300), dnv = [dn0[0] * .7, 1, dn0[2] * .7 + .35], dnl = Math.hypot(...dnv), DN = dnv.map(v => v / dnl);
  let DU = [DN[1], -DN[0], 0]; const dul = Math.hypot(...DU) || 1; DU = DU.map(v => v / dul); let DV = [DN[1] * DU[2] - DN[2] * DU[1], DN[2] * DU[0] - DN[0] * DU[2], DN[0] * DU[1] - DN[1] * DU[0]];
  gl.uniform1f(U.uForm, form); gl.uniform4f(U.uGy, 5.2 + d.bright * 4.5 + (au ? au.high * 1.5 : 0), .05 + lv * .25, .5 + .5 * noise(t * .03 + sd + 60), .26 + .1 * noise(t * .07 + sd));
  // training progress, made visible
  const tr = c.training && c.training.state === 'running' ? c.training : null, pg = fx.pg || (fx.pg = { i: 0, s: 0 });
  let inner = 0, sess = 0, sweepA = 0;
  if (tr) {
    const nowS = (tr.now || 0) + (performance.now() - (Gym.polledAt || performance.now())) / 1000;
    if (tr.stage === 'train') {
      const expect = tr.epoch_time || ((c.pace || .07) * tr.audio_secs + tr.tracks * .1) || 60, spe = Math.max(1, tr.steps_per_epoch || 1);
      const byStep = clamp((tr.step - tr.step0) / spe, 0, 1), byTime = clamp((nowS - tr.epoch_t0) / expect, 0, .97);
      inner = Math.max(byStep * .98, Math.min(byTime, byStep + 1 / spe));          // time fills in between steps, but never runs more than one step ahead
      sess = clamp((tr.epoch - tr.from_epoch + inner) / Math.max(1, tr.max_epochs - tr.from_epoch), 0, 1); sweepA = .85;
    } else { inner = tr.stage === 'load' ? 1 : clamp((tr.digested || 0) / Math.max(1, tr.tracks), 0, 1); sweepA = .3; }
  }
  if (tr) { pg.i = inner < pg.i - .3 ? inner : pg.i + (inner - pg.i) * Math.min(1, dt * 3); pg.s += (sess - pg.s) * Math.min(1, dt * 3); pg.dig = tr.stage === 'train' ? (pg.dig || 0) : clamp((tr.digested || 0) / Math.max(1, tr.tracks), 0, 1); }
  else if (trn < .01) { pg.i = 0; pg.s = 0; pg.dig = 0; }
  if (sng > .01 && trn < .01) gl.uniform4f(U.uProg, fx.sfr || 0, (t * .45) % 1, sng, sng * (.5 + .5 * Math.sin(t * 5)));   // composing: the outer arc in its orbit fills as the clip is made, the inner one keeps circling
  else gl.uniform4f(U.uProg, pg.s, pg.i, trn, trn * (.5 + .5 * Math.sin(t * 5)));
  // the frame: what has been built so far. It advances all the time while training, not only when an epoch lands.
  const E = d.epochs + (tr && tr.stage === 'train' ? pg.i : 0), bt = n ? [clamp(Math.max(E / 5, (pg.dig || 0) * .22 * trn), 0, 1), clamp((E - 2) / 20, 0, 1), clamp((E - 14) / 70, 0, 1), clamp((E - 50) / 250, 0, 1)] : [0, 0, 0, 0];
  const B = fx.bld || (fx.bld = bt.slice()); for (let k = 0; k < 4; k++) B[k] += (bt[k] - B[k]) * Math.min(1, dt * .9);
  gl.uniform4f(U.uBuild, B[0], B[1], B[2], B[3]);
  gl.uniform4f(U.uFract, n ? clamp(sm('depth', .95 + 1.05 * Math.min(1, d.growth * 1.6), .5), 0, 2) : 0, .03, 0, 0);
  fx.part = B[0] < .995 ? 'spine' : B[1] < .995 ? 'ribs' : B[2] < .995 ? 'cables' : B[3] < .995 ? 'armour' : null; fx.partPct = Math.round((B[0] < .995 ? B[0] : B[1] < .995 ? B[1] : B[2] < .995 ? B[2] : B[3]) * 100);
  if (busyK > .01) {                               // while it trains or composes, its orbit turns to face you enough to be read
    const wF = .55 * busyK, cf = rot([0, 0, 1]), mixN = [DN[0] * (1 - wF) + cf[0] * wF, DN[1] * (1 - wF) + cf[1] * wF, DN[2] * (1 - wF) + cf[2] * wF], ml = Math.hypot(...mixN) || 1; for (let k = 0; k < 3; k++) DN[k] = mixN[k] / ml;
    DU = [DN[1], -DN[0], 0]; const l2 = Math.hypot(...DU) || 1; DU = DU.map(v => v / l2); DV[0] = DN[1] * DU[2] - DN[2] * DU[1]; DV[1] = DN[2] * DU[0] - DN[0] * DU[2]; DV[2] = DN[0] * DU[1] - DN[1] * DU[0];
  }
  gl.uniform3fv(U.uDiscN, DN); gl.uniform3fv(U.uDiscU, DU); gl.uniform3fv(U.uDiscV, DV); gl.uniform4f(U.uDisc, busyK > .01 ? 1.42 : 1.8, Math.max(busyK > .01 ? 1.78 : 0, 2.1 + nrings * .25), .13, busyK > .01 ? 1 : 0); gl.uniform4fv(U.uRing, new Float32Array(32));   // the loose orbiting threads are gone: see the filaments, which are rooted on the body
  // food motes: one per track (or per group of tracks) while it digests; each is drawn in and absorbed as it is eaten
  const food = new Float32Array(48), FS = fx.foodS || (fx.foodS = []);
  if (tr && (tr.stage === 'digest' || tr.stage === 'start')) {
    const Mn = Math.min(12, tr.tracks || 0), frac = (tr.digested || 0) / Math.max(1, tr.tracks);
    for (let k = 0; k < Mn; k++) {
      const st = FS[k] || (FS[k] = { e: 0, a: 0 }); st.a = Math.min(1, st.a + dt / 1.6); const eaten = (k + 1) / Mn <= frac + 1e-6, sl = N.slots[k % K];
      if (eaten && st.e === 0) fx.waves.push({ t0: t + .9, o: [sl.p[0] + sl.a[0] * sl.len, sl.p[1] + sl.a[1] * sl.len, sl.p[2] + sl.a[2] * sl.len], soft: true, taps: [[0, 1]], speed: 2.6, width: 3 });
      if (eaten) st.e = Math.min(1, st.e + dt / 1.4);
      const a = k * 2.39996 + t * (.22 + (k % 3) * .05), orbR = 2.25 + .35 * noise(t * .2 + k * 7), out = [Math.cos(a) * orbR, Math.sin(t * .31 + k * 1.9) * .9, Math.sin(a) * orbR];
      const bu = Math.max(.06, B[0]), tip = [sl.p[0] + sl.a[0] * sl.len * bu, sl.p[1] + sl.a[1] * sl.len * bu, sl.p[2] + sl.a[2] * sl.len * bu],     // they fly to where the spine is being built
        e = st.e * st.e * (3 - 2 * st.e);
      food.set([out[0] + (tip[0] - out[0]) * e, out[1] + (tip[1] - out[1]) * e, out[2] + (tip[2] - out[2]) * e, st.e >= 1 ? 0 : (.55 + .25 * Math.sin(t * 3 + k)) * (1 + e * 1.5) * st.a], k * 4);
    }
  } else if (FS.length) fx.foodS = [];
  gl.uniform4fv(U.uFood, food); gl.uniform1f(U.uSym, n ? 1 : 0);
  let ext = 1.5; N.slots.forEach(sl => { if (sl.w > .01) ext = Math.max(ext, Math.hypot(sl.p[0] + sl.a[0] * sl.len, sl.p[1] + sl.a[1] * sl.len, sl.p[2] + sl.a[2] * sl.len) + sl.rad * 3.4, Math.hypot(...sl.p) + sl.rad * 3.4); });
  if (sng > .01 && trn < .01) gl.uniform4f(U.uSweep, (t * .55) % 1.15, sng * .75, 0, 0); else gl.uniform4f(U.uSweep, pg.i, trn * (tr && tr.stage !== 'train' ? .6 : 1), 0, 0);
  gl.uniform1f(U.uB, Math.min(7, ext + 1.4)); gl.uniform1f(U.uFrame, (NEB.fr = (NEB.fr || 0) + 1) % 1024);
  { // energy arcs: rarely, something far outside strikes a part of the body. The arc is jagged, re-strikes like lightning, hops between parts, and is heard.
    const ev = fx.ev || (fx.ev = []), rnd = Math.random, R = Math.max(6, ext * 3.2), act = 1 + trn * 1.2 + lv * 2;
    if (fx.seenT != null && t - fx.seenT > 1.5) { ev.length = 0; fx.chg = []; fx.evNext = t + 5 + rnd() * 12; }   // the view was away (hidden window, another creature): nothing is overdue, start waiting afresh
    fx.seenT = t;
    // never the same twice running: a bolt, a slow tendril, a discharge between two of its own parts, a web from three sides, a fork, one bare flicker, or the creature firing back
    const KD = { bolt: { amp: .3, dec: .78, hop: .35, re: 1, ease: 24, wide: 0, charge: true, gap: () => .1 + rnd() * rnd() * .9, life: () => 1.1 + rnd() * rnd() * 3.4 },
      tendril: { amp: .2, dec: .42, hop: .12, re: .2, ease: 1.6, wide: 2, soft: true, gap: () => 1 + rnd() * 1.8, life: () => 4 + rnd() * 5 },
      crawl: { amp: .42, dec: .7, hop: .5, re: 1, ease: 30, wide: 0, inner: true, gap: () => .07 + rnd() * .3, life: () => .8 + rnd() * 1.6 },
      flicker: { amp: .36, dec: .8, hop: 0, re: 1, ease: 40, wide: 1, dry: true, gap: () => 9, life: () => .16 + rnd() * .2 },
      out: { amp: .34, dec: .76, hop: 0, re: 1, ease: 26, wide: 1, out: true, charge: true, dry: true, gap: () => .12 + rnd() * .45, life: () => .5 + rnd() * 1.1 },
      heard: { amp: .32, dec: .78, hop: .2, re: 1, ease: 30, wide: 0, silent: true, gap: () => .08 + rnd() * .3, life: () => .3 + rnd() * .6 } };
    const V = (x, y, z) => NEB.nz[((y + 17 * (z - 1)) & 255) * 256 + ((x + 37 * (z - 1)) & 255)] / 255, sstep = f => f * f * (3 - 2 * f);
    const n3 = (x, y, z) => { const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z), fx_ = sstep(x - ix), fy = sstep(y - iy), fz = sstep(z - iz), L2 = k => { const a = V(ix, iy, iz + k), b = V(ix + 1, iy, iz + k), c2 = V(ix, iy + 1, iz + k), e2 = V(ix + 1, iy + 1, iz + k); return a + (b - a) * fx_ + (c2 - a) * fy + (a - b - c2 + e2) * fx_ * fy; }; const lo = L2(0); return lo + (L2(1) - lo) * fz; };
    const sdv = d.seed * 40, tt = fx.clock * .035, tS = 1.1 + turb * 1.4;
    const warp = q => { const x = q[0] * .45 + sdv, y = q[1] * .45 + sdv, z = q[2] * .45 + sdv; return [(n3(x, y + tt, z) - .5) * tS, (n3(x + 31.4, y - tt, z + 7.7) - .5) * tS, (n3(x + 5.2, y + 13.1, z + tt) - .5) * tS]; };
    const land = e => { const sl = N.slots[e.j] || N.slots[0], mx = e.j && n ? e.mx : 1, A = [(sl.p[0] + sl.a[0] * sl.len * e.hh) * mx, sl.p[1] + sl.a[1] * sl.len * e.hh, sl.p[2] + sl.a[2] * sl.len * e.hh];
      let q = A; for (let k = 0; k < 2; k++) { const w = warp(q); q = [A[0] - w[0], A[1] - w[1], A[2] - w[2]]; } return q; };   // the dust is displaced by turbulence, so find where that part of the body really appears
    const part = e => { e.j = Math.floor(rnd() * Math.min(K, N.slots.length)); e.hh = [1, 1, .66, .33, 0][Math.floor(rnd() * 5)]; e.mx = rnd() < .5 ? -1 : 1; };   // a limb's tip, a point on its spine, or the core
    const strike = (e, first) => {
      const kd = e.kd; if (!first && rnd() < kd.hop) part(e);
      const th = rnd() * 6.283, zz = rnd() * 2 - 1, rr = Math.sqrt(1 - zz * zz), k0 = first ? 0 : .82; let dx = e.dir[0] * k0 + rr * Math.cos(th) * (1 - k0), dy = e.dir[1] * k0 + zz * (1 - k0), dz = e.dir[2] * k0 + rr * Math.sin(th) * (1 - k0); const dl = Math.hypot(dx, dy, dz) || 1; e.dir = [dx / dl, dy / dl, dz / dl];
      if (kd.out && first) { const so = N.slots[e.j] || N.slots[0], ox = so.a[0] * (e.j && n ? e.mx : 1) + (rnd() - .5) * .7, oy = so.a[1] + (rnd() - .5) * .7, oz = so.a[2] + (rnd() - .5) * .7, ol = Math.hypot(ox, oy, oz) || 1; e.dir = [ox / ol, oy / ol, oz / ol]; }   // it fires back: out through the limb's own tip
      const Rr = kd.out ? R * .55 : R, A = land(e), T = e.tgt; T.set(e.from ? land(e.from) : [e.dir[0] * Rr, e.dir[1] * Rr, e.dir[2] * Rr], 0); T.set(A, 48);   // most come from far outside; some jump between two parts of the body
      const mid = (a, b, amp) => { if (b - a < 2) return; const m = (a + b) >> 1, ux = T[b * 3] - T[a * 3], uy = T[b * 3 + 1] - T[a * 3 + 1], uz = T[b * 3 + 2] - T[a * 3 + 2], ul = Math.hypot(ux, uy, uz) || 1;
        let ox = rnd() - .5, oy = rnd() - .5, oz = rnd() - .5; const pr = (ox * ux + oy * uy + oz * uz) / (ul * ul); ox -= ux * pr; oy -= uy * pr; oz -= uz * pr; const ol = Math.hypot(ox, oy, oz) || 1, kk = ul * amp * (.4 + rnd() * .9) / ol;
        T[m * 3] = (T[a * 3] + T[b * 3]) / 2 + ox * kk; T[m * 3 + 1] = (T[a * 3 + 1] + T[b * 3 + 1]) / 2 + oy * kk; T[m * 3 + 2] = (T[a * 3 + 2] + T[b * 3 + 2]) / 2 + oz * kk; mid(a, m, amp * kd.dec); mid(m, b, amp * kd.dec); };
      mid(0, 16, kd.amp); if (first) e.pts.set(T);
      e.last = t; e.flash = first ? 1.3 : (.5 + rnd() * .5) * kd.re; e.next = t + kd.gap();
      if (!first && kd.re < .5) return;                                   // a slow tendril only drifts: it does not strike again
      fx.waves.push({ t0: t, o: A, taps: first ? [[0, 1], [.22, .4]] : [[0, .4]], speed: 2.6, width: 2.8, amp: (first ? .7 : .16) * (kd.out ? .5 : 1), life: first ? 1.6 : .8 });   // the body feels every strike
      const sl = N.slots[e.j]; if (sl) sl.ring = 1; if (first && fx.life) fx.life.beat = t;
      if (sl && first && !kd.out) { sl.pu = [e.hh, 1, .1]; sl.pv = -1.7;                               // and conducts it: a pulse runs from where it landed down to the core, and on through the rest of the body
        if (!kd.soft) { const sc = fx.scars || (fx.scars = []); sc.push({ j: e.j, hh: e.hh, mx: e.mx, t0: t }); if (sc.length > 4) sc.shift(); } }   // a hard strike leaves a mark
      if (kd.out && first && fx.life) fx.life.startle = Math.max(fx.life.startle, .3);                 // firing back makes it recoil
      try { const a = ac(); if (a.state === 'running' && !SHOT && !kd.silent) { const lb = limbs && limbs[e.j] ? limbs[e.j].mean.bright : (d.bright ?? .3), f0 = noteOf(lb), pure = clamp(.25 * d.growth + .75 * d.learned, 0, 1);   // and it is heard: a crack, then the struck limb rings in its own note
        if (first && kd.soft) tone(f0 * (rnd() < .5 ? 1 : 1.5), { dur: 2.5 + d.growth * 3, gain: .09, attack: .5, partials: 1 + Math.round(d.growth * 3), detune: (1 - pure) * .03 });   // a tendril hums as it takes hold
        else if (first && kd.out) tone(f0 * 2, { dur: .45, gain: .07, attack: .003, bend: 1.1, noise: .4, noiseAt: 3, partials: 2 });   // its own discharge: a zap that rises as it leaves
        else if (first) { tone(2200 + rnd() * 2400, { dur: .07, gain: .06, bend: -.9, noise: .7, noiseAt: 1 }); if (!kd.dry) tone(f0 / 2, { when: .02, dur: 1.1 + d.growth * 2.4, gain: .15, attack: .004, partials: 2 + Math.round(d.growth * 3), detune: (1 - pure) * .04, bend: -.12, noise: .35, noiseAt: 5 }); }
        else tone(f0 * ALIEN_SCALE[Math.floor(rnd() * 7)] * (rnd() < .3 ? 2 : 1), { dur: .1 + rnd() * .25, gain: .045, bend: rnd() < .5 ? .25 : -.3, noise: .25, noiseAt: 6 }); } } catch (_) {}
    };
    if (fx.evNext == null) fx.evNext = t + 6 + rnd() * 9;
    if (t > fx.evNext && !ev.length && N.slots.length) {
      const canFire = n && (d.learned > .25 || d.epochs >= 20);                                       // only a creature that has learned something can fire back
      let kind; do { const x = rnd(); kind = x < .25 ? 'bolt' : x < .45 ? 'tendril' : x < .61 ? 'crawl' : x < .72 ? 'web' : x < .81 ? 'fork' : x < .88 ? 'flicker' : canFire ? 'out' : 'bolt'; } while (kind === fx.evLast); fx.evLast = kind;
      const rdir = () => { const z = rnd() * 1.6 - .8, th = rnd() * 6.283, r0 = Math.sqrt(1 - z * z); return [r0 * Math.cos(th), z, r0 * Math.sin(th)]; }, d0 = rdir();
      const cnt = kind === 'web' ? 3 : kind === 'fork' ? 2 : kind === 'tendril' && rnd() < .3 ? 2 : 1, kd = KD[kind] || KD.bolt, h0 = rnd();
      const chgT = kd.charge ? 1.2 + rnd() * 1.3 : 0;                                                 // a strike gathers first: the spot it will hit glows, and the body leans toward where it is coming from
      for (let i = 0; i < cnt; i++) { const c0 = t + i * (kind === 'web' ? .05 + rnd() * .2 : .1 + rnd() * .5), e = { c0, chg: chgT, t0: c0 + chgT, life: kd.life(), kd, dir: kind === 'fork' ? d0 : rdir(), pts: new Float32Array(51), tgt: new Float32Array(51), flash: 0, last: -9, born: false, hue: kind === 'web' ? h0 : rnd() };
        part(e); if (kd.out) e.hh = 1; if (kd.inner) { e.from = {}; part(e.from); if (e.from.j === e.j && e.from.hh === e.hh) e.from.hh = e.hh > .5 ? 0 : 1; } ev.push(e); }
      fx.evNext = t + (12 + rnd() * 30) / act;
    }
    if (au && lv > .05 && n) {                                                                       // while a track or a sung clip plays, the strikes come from the sound: a loud hit strikes the limb that sounds most like that moment
      fx.evNext = Math.max(fx.evNext, t + 6); fx.lvA = (fx.lvA || 0) + (lv - (fx.lvA || 0)) * Math.min(1, dt * 1.6);
      if (lv > fx.lvA * 1.4 + .06 && t - (fx.hitT || -9) > (fx.hitGap || 1.5) && ev.length < 2 && dt > 0) {
        const sum = au.bass + au.mid + au.high + 1e-3, br = au.high / sum * 1.6, lo = au.bass / sum; let bj = 0, bd = 1e9;
        N.slots.forEach((sl, j) => { if (j < K && sl.w > .3) { const dd = Math.abs(sl.tr[2] - br) + Math.abs(sl.tr[3] - lo) + rnd() * .15; if (dd < bd) { bd = dd; bj = j; } } });
        const kd = KD.heard, e = { c0: t, chg: 0, t0: t, life: kd.life(), kd, dir: [rnd() - .5, rnd() * .8 - .2, rnd() - .5], pts: new Float32Array(51), tgt: new Float32Array(51), flash: 0, last: -9, born: false, hue: rnd() };
        const dl = Math.hypot(...e.dir) || 1; e.dir = e.dir.map(v => v / dl); part(e); e.j = bj; ev.push(e); fx.hitT = t; fx.hitGap = 1.3 + rnd() * 1.9;
      }
    } else fx.lvA = 0;
    for (let i = ev.length - 1; i >= 0; i--) if (t - ev[i].t0 > ev[i].life) ev.splice(i, 1);
    const ep = new Float32Array(153), ei = new Float32Array(12), chgs = [], lean = { k: 0, d: [0, 1, 0] };
    ev.slice(0, 3).forEach((e, i) => {
      const age = t - e.t0;
      if (age < 0) {                                                                               // gathering: the place it will hit glows brighter and trembles, and a faint whine rises
        const k = e.chg ? clamp((t - e.c0) / e.chg, 0, 1) : 0, sl = N.slots[e.j]; if (k <= 0 || !sl) return;
        const mxq = e.j && n ? e.mx : 1; chgs.push({ o: [(sl.p[0] + sl.a[0] * sl.len * e.hh) * mxq, sl.p[1] + sl.a[1] * sl.len * e.hh, sl.p[2] + sl.a[2] * sl.len * e.hh], a: k * k * .5 * (1 + .25 * Math.sin(t * 31)) });
        sl.ring = Math.max(sl.ring, k * .55); if (!e.kd.out && k > lean.k) { lean.k = k; lean.d = e.dir; }
        if (e.kd.out && !e.rose) { e.rose = true; sl.pu = [0, .9, .1]; sl.pv = 1 / e.chg; }            // before it fires back, energy climbs the limb from the core to the tip
        if (!e.whine) { e.whine = true; try { const a = ac(); if (a.state === 'running' && !SHOT) tone(noteOf(d.bright ?? .3) * 2, { dur: e.chg, gain: .022, attack: e.chg * .85, bend: .6 }); } catch (_) {} }
        return;
      }
      if (!e.born) { e.born = true; strike(e, true); } else if (t > e.next) strike(e, false);
      const A = land(e), kf = Math.min(1, dt * e.kd.ease); e.tgt.set(A, 48); if (e.from) e.tgt.set(land(e.from), 0); for (let k = 0; k < 51; k++) e.pts[k] += (e.tgt[k] - e.pts[k]) * (k >= 48 ? 1 : kf);
      e.flash *= Math.exp(-dt * 6);
      ep.set(e.pts, i * 51); ei.set([Math.min(1, age / .06) * Math.min(1, (e.life - age) / .35) * (e.kd.soft ? .55 + .25 * Math.sin(age * 2.3) : .22 + .78 * Math.min(1, e.flash)), e.kd.soft ? (age * .7) % 1.5 : e.kd.out ? 1 - (t - e.last) / .2 : (t - e.last) / .14, Math.min(1.5, e.flash), e.hue * .999 + e.kd.wide], i * 4);   // a tendril carries slow beads of light inward, over and over
    });
    gl.uniform3fv(U.uEvP, ep); gl.uniform4fv(U.uEvI, ei); fx.chg = chgs;
    { const sc = fx.scars || [], sa = new Float32Array(16);                                          // the marks of old strikes: bright at first, an ember for a minute or so, then healed
      for (let i = sc.length - 1; i >= 0; i--) if (t - sc[i].t0 > 80 || t < sc[i].t0) sc.splice(i, 1);
      sc.forEach((m, i) => { const sl = N.slots[m.j]; if (!sl || i > 3) return; const a = t - m.t0, x = sl.p[0] + sl.a[0] * sl.len * m.hh;
        sa.set([n ? Math.abs(x) : x, sl.p[1] + sl.a[1] * sl.len * m.hh, sl.p[2] + sl.a[2] * sl.len * m.hh, (a < 2.5 ? .8 - .16 * a : .4 * Math.max(0, 1 - (a - 2.5) / 77.5)) * sl.w], i * 4); });
      gl.uniform4fv(U.uScar, sa); }
    gl.uniform4f(U.uDof, dist - ext * .28, ext * 1.25, NEB.dof == null ? 1 : NEB.dof, .5);
    // filaments: threads that belong to the body. Short antennae leave through the limbs' tips, and sinews are strung between two parts of it
    // (a side limb and the spine, or a limb and its mirror), fixed at both ends. More appear as it trains.
    const fp = new Float32Array(408), fc = new Float32Array(32), NF = Math.min(8, nrings), specs = [], fil = fx.fil || (fx.fil = []), startle = L.startle || 0;
    for (let r = 0; r < 3 && specs.length < 8; r++) for (let j = 0; j < K && specs.length < 8; j++) {
      if (r === 0) { specs.push({ a: { j, hh: .5, mx: 1 } }); if (j && n) specs.push({ a: { j, hh: .5, mx: -1 } }); }
      else if (j > 0) specs.push({ a: { j, hh: .8, mx: r === 1 ? 1 : -1 }, b: { j: 0, hh: Math.min(.9, .3 + .14 * j), mx: 1 } });
      else if (r === 1 && K > 1 && n) specs.push({ a: { j: 1, hh: .55, mx: 1 }, b: { j: 1, hh: .55, mx: -1 } });
    }
    specs.slice(0, NF).forEach((sp, k) => {
      const sl = N.slots[sp.a.j]; if (!sl || sl.w < .3) return;
      const mxs = sp.a.mx, ks = sp.a.j * 7 + (sp.b ? 3 + sp.b.j : 0), P = land(sp.a), sw0 = nvec(t * .1, ks * 17 + 3), sway = [sw0[0] * mxs, sw0[1], sw0[2]], tg = new Float32Array(27);   // a limb and its mirror move as one: same motion, reflected
      if (sp.b) {                                                                                   // a sinew: fixed at both ends, bowed outward. It breathes, and it twangs when a beat or a touch lands.
        const Q = land(sp.b), Ln = Math.hypot(Q[0] - P[0], Q[1] - P[1], Q[2] - P[2]), mid = [(P[0] + Q[0]) / 2, (P[1] + Q[1]) / 2, (P[2] + Q[2]) / 2], ml = Math.hypot(...mid) || 1, slack = .17 + .06 * Math.sin(t * .31 + ks * 1.3) - .08 * startle;
        const bow = [0, 1, 2].map(c => (mid[c] / ml * slack + sway[c] * .15 * (1 + lv * 2)) * Ln), tw = (kick * .07 + startle * .05) * Ln, s20 = nvec(t * .07, ks * 29 + 11), s2 = [s20[0], s20[1] * mxs, s20[2]];
        for (let i = 0; i < 9; i++) { const u = i / 8, h = Math.sin(Math.PI * u), h2 = Math.sin(2 * Math.PI * u) * (Math.sin(t * 27 + ks) * tw + s2[0] * .05 * Ln), h3 = Math.sin(3 * Math.PI * u) * Math.sin(t * 41 + ks * 2) * tw * .5;
          tg.set([P[0] + (Q[0] - P[0]) * u + bow[0] * h + s2[1] * h2 + sway[2] * h3, P[1] + (Q[1] - P[1]) * u + bow[1] * h + h2 + h3, P[2] + (Q[2] - P[2]) * u + bow[2] * h + s2[2] * h2], i * 3); }
      } else {                                                                                      // a tendril: out through the limb's end, then a curl. It reaches out and draws back, and snaps tight when startled.
        const ax = [sl.a[0], sl.a[1], sl.a[2]], rf = Math.abs(ax[1]) < .9 ? [0, 1, 0] : [1, 0, 0], u0 = [ax[1] * rf[2] - ax[2] * rf[1], ax[2] * rf[0] - ax[0] * rf[2], ax[0] * rf[1] - ax[1] * rf[0]], ul = Math.hypot(...u0) || 1, u = u0.map(v => v / ul), v = [ax[1] * u[2] - ax[2] * u[1], ax[2] * u[0] - ax[0] * u[2], ax[0] * u[1] - ax[1] * u[0]];
        const reach = .62 + .38 * Math.sin(t * .23 + ks * 2.1) - .3 * startle, seg = sl.len * (.07 + .04 * d.growth) * (.8 + .4 * ((ks * .618) % 1)) * Math.max(.3, reach);
        const ph = ks * 2.4 + t * .06 + sw0[0] * 1.5, curl = .17 + .1 * Math.sin(t * .35 + ks * 1.7) + sway[1] * .14 + startle * .45 + kick * .12 - lv * .1;
        { const bx = [0, 0, 0]; if (lean.k > 0) for (let q = 0; q < 3; q++) bx[q] += lean.d[q] * lean.k * .7;                    // it leans toward a strike that is gathering,
          if (pointer && L.curious > .05) { const dp = [pointer[0] - P[0], pointer[1] - P[1], pointer[2] - P[2]], dl = Math.hypot(...dp) || 1, wg = L.curious * .6 * Math.exp(-dl * dl / 7); for (let q = 0; q < 3; q++) bx[q] += dp[q] / dl * wg; }   // and reaches for you when you are near
          ax[0] += bx[0] * mxs; ax[1] += bx[1]; ax[2] += bx[2]; const nl = Math.hypot(...ax) || 1; for (let q = 0; q < 3; q++) ax[q] /= nl; }
        tg.set(P, 0);
        for (let i = 1; i < 9; i++) { const th = i === 1 ? 0 : Math.pow(i - 1, 1.3) * curl * .85, sg = i === 1 ? sl.len * .42 : seg * (1.2 - .08 * i), c = Math.cos(th), sn = Math.sin(th), pw = ph + sway[2] * .25 * i, cp = Math.cos(pw), spn = Math.sin(pw);
          for (let q = 0; q < 3; q++) P[q] += (ax[q] * c + (u[q] * cp + v[q] * spn) * sn) * sg * (q === 0 ? mxs : 1);
          tg.set(P, i * 3); }
      }
      // it has weight: the root follows the body at once, the rest trails behind and catches up, the far end last
      let st = fil[k]; if (!st || Math.hypot(st[0] - tg[0], st[1] - tg[1], st[2] - tg[2]) > 1.2) st = fil[k] = tg.slice();
      for (let i = 0; i < 9; i++) { const far = sp.b ? Math.sin(Math.PI * i / 8) : i / 8, rate = Math.min(1, dt * (16 - 12.5 * far)); for (let q = 0; q < 3; q++) st[i * 3 + q] += (tg[i * 3 + q] - st[i * 3 + q]) * (far < .01 ? 1 : rate); }
      for (let i = 0; i < 17; i++) {                                                               // drawn as a smooth curve through those nine points
        const f = i / 2, i1 = Math.min(7, Math.floor(f)), u = f - i1, i0 = Math.max(0, i1 - 1), i2 = i1 + 1, i3 = Math.min(8, i1 + 2);
        for (let q = 0; q < 3; q++) { const p0 = st[i0 * 3 + q], p1 = st[i1 * 3 + q], p2 = st[i2 * 3 + q], p3 = st[i3 * 3 + q]; fp[k * 51 + i * 3 + q] = .5 * (2 * p1 + (p2 - p0) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u * u + (3 * p1 - p0 - 3 * p2 + p3) * u * u * u); }
      }
      fc.set([sl.col[0], sl.col[1], sl.col[2], Math.min(1, sl.w) * (.8 + sl.ring * .8) * clamp(nrings - k, 0, 1) + (sp.b ? 2 : 0)], k * 4);
    });
    gl.uniform3fv(U.uFil, fp); gl.uniform4fv(U.uFilC, fc);
  }
  const D = NEB.drag; D.s += ((D.on ? 1 : 0) - D.s) * Math.min(1, dt * (D.on ? 9 : 2.2)); gl.uniform4f(U.uTouch, D.p[0], D.p[1], D.p[2], D.s < .01 ? 0 : D.s);
  gl.uniform1f(U.uFine, NEB.fine == null ? .42 : NEB.fine); gl.uniform3fv(U.uLight, light); gl.uniform3fv(U.uKey, key); gl.uniform3fv(U.uAmb, amb);
  nebScene(W, H);
  const fl = NEB.flip = 1 - (NEB.flip || 0), R = NEB.res, O = NEB.out;                 // blend into the running image
  GL.useProgram(R.p); GL.bindFramebuffer(GL.FRAMEBUFFER, NEB.tg[1 + fl].fb);
  GL.uniform1i(R.u.uCur, NEB.u); GL.uniform1i(R.u.uHist, NEB.u + 2 - fl); GL.viewport(0, 0, CW, CH); GL.uniform2f(R.u.uPx, 1 / CW, 1 / CH); GL.uniform2f(R.u.uTx, 1 / W, 1 / H); GL.uniform2f(R.u.uJit, jx / W, jy / H); GL.uniform1f(R.u.uMix, NEB.fresh ? 1 : SHOT ? -1 / (SHOT.n + 1) : .085); NEB.fresh = false;
  GL.drawArrays(GL.TRIANGLES, 0, 3);
  { const Bm = NEB.blm, b0 = NEB.bl[0], b1 = NEB.bl[1]; GL.useProgram(Bm.p); GL.viewport(0, 0, b0.w, b0.h); GL.uniform2f(Bm.u.uPx, 1 / b0.w, 1 / b0.h);   // bloom
    GL.bindFramebuffer(GL.FRAMEBUFFER, b0.fb); GL.uniform1i(Bm.u.uTex, NEB.u + 1 + fl); GL.uniform2f(Bm.u.uDir, 1.7 / b0.w, 0); GL.uniform1f(Bm.u.uThr, .42); GL.drawArrays(GL.TRIANGLES, 0, 3);
    GL.bindFramebuffer(GL.FRAMEBUFFER, b1.fb); GL.uniform1i(Bm.u.uTex, NEB.ub); GL.uniform2f(Bm.u.uDir, 0, 1.7 / b0.h); GL.uniform1f(Bm.u.uThr, 0); GL.drawArrays(GL.TRIANGLES, 0, 3); }
  GL.useProgram(O.p); GL.bindFramebuffer(GL.FRAMEBUFFER, REC ? NEB.recOut.fb : null); GL.viewport(0, 0, CW, CH);   // and show it at full resolution
  GL.uniform1i(O.u.uTex, NEB.u + 1 + fl); GL.uniform1i(O.u.uNoise, 0); GL.uniform2f(O.u.uPx, 1 / CW, 1 / CH); GL.uniform2f(O.u.uTx, 1 / CW, 1 / CH); GL.uniform1f(O.u.uSharp, .15); GL.uniform1i(O.u.uBloom, NEB.ub + 1); GL.uniform1f(O.u.uBloomK, NEB.bloom == null ? .5 : NEB.bloom); GL.uniform1f(O.u.uDofR, CH * .0048 * (NEB.dof == null ? 1 : NEB.dof));
  GL.drawArrays(GL.TRIANGLES, 0, 3);
  if (SHOT) { const sh = SHOT, hud = document.getElementById('gym-fps'); sh.n++; if (hud && !sh.rec) hud.textContent = `capturing ${sh.n}/${sh.frames} · ${CW}×${CH}`;
    if (sh.n >= sh.frames && sh.rec) { NEB.shot = null;                                   // read the finished frame back, turn it upright, and hand it over as a JPEG
      const px = new Uint8ClampedArray(CW * CH * 4); GL.bindFramebuffer(GL.FRAMEBUFFER, NEB.recOut.fb); GL.readPixels(0, 0, CW, CH, GL.RGBA, GL.UNSIGNED_BYTE, px); GL.bindFramebuffer(GL.FRAMEBUFFER, null);
      const c2 = NEB.rc2 || (NEB.rc2 = document.createElement('canvas')); if (c2.width !== CW || c2.height !== CH) { c2.width = CW; c2.height = CH; }
      const g2 = c2.getContext('2d'), row = CW * 4, tmp = new Uint8ClampedArray(row); for (let y = 0; y < CH >> 1; y++) { const a0 = y * row, b0 = (CH - 1 - y) * row; tmp.set(px.subarray(a0, a0 + row)); px.copyWithin(a0, b0, b0 + row); px.set(tmp, b0); }
      g2.putImageData(new ImageData(px, CW, CH), 0, 0); c2.toBlob(b => sh.done(b), 'image/jpeg', .93); }
    else if (sh.n >= sh.frames) { NEB.shot = null; NEB.last = 0; NEB.frames = 0; NEB.acc = 0;
      cv.toBlob(b => { if (sh.rec) return sh.done(b); if (!b) return toast('capture failed', true); fetch(`/api/gym/${sh.slug}/capture${NEB.quietShot ? '?quiet=1' : ''}`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: b }).then(r => r.json()).then(r => toast(r.name ? 'saved ' + r.name : 'capture failed', !r.name)).catch(e => toast('capture failed: ' + e.message, true)); }, sh.rec ? 'image/jpeg' : 'image/png', .93); } }

  // where things are on screen, for touch
  fx.ngeom = { K, proj, unproj, dist, growth: d.growth, learned: d.learned,
    lobes: N.slots.slice(0, K).flatMap((s, j) => (j && n ? [1, -1] : [1]).map(mx => { const a3 = [s.p[0] * mx, s.p[1], s.p[2]], a = proj(a3), b3 = [(s.p[0] + s.a[0] * s.len) * mx, s.p[1] + s.a[1] * s.len, s.p[2] + s.a[2] * s.len], b = proj(b3); return { j, a, b, a3, b3, r: s.rad / (a[2] * tan) * S / 2, slot: s }; })),
    voids: vlist.flatMap(v => (n ? [1, -1] : [1]).map(mx => { const p3 = [Math.abs(v.p[0]) * mx, v.p[1], v.p[2]], p = proj(p3); return { x: p[0], y: p[1], r: v.r / (p[2] * tan) * S / 2 * 1.1, p: p3, depth: p[2] }; })) };
}

/* touch: what you touched sets the pitch and timbre; HOW it answers is one of several gestures, never the same twice running */
const GESTURES = ['taps', 'gallop', 'rise', 'fall', 'shimmer', 'swarm', 'reverse', 'still'];
function nebRespond(fx, hit, base) {
  const t = performance.now() / 1000, a = ac(), rnd = Math.random, f0 = hit.freq * (1 + (rnd() - .5) * .01), p = hit.p;
  let v; do { v = GESTURES[Math.floor(rnd() * GESTURES.length)]; } while (v === NEB.lastGesture || (hit.kind === 'space' && (v === 'still' || v === 'reverse')));
  NEB.lastGesture = v;
  const E = voiceOut();                               // the room it answers in changes too: short and tight, or long and smeared
  E.dl.delayTime.setTargetAtTime({ taps: .31, gallop: .11, rise: .19, fall: .23, shimmer: .52, swarm: .07, reverse: .4, still: .6 }[v], a.currentTime, .04);
  E.fb.gain.setTargetAtTime({ taps: .3, gallop: .2, rise: .25, fall: .25, shimmer: .5, swarm: .35, reverse: .15, still: .08 }[v], a.currentTime, .04);
  const say = (dly, mult, gk, extra) => tone(f0 * mult, Object.assign({}, base, { when: dly, gain: (base.gain || .16) * gk * (base.gainK || 1) }, extra || {}));
  const step = i => ALIEN_SCALE[i % 7] * Math.pow(2, Math.floor(i / 7)), up = [0, 1, 0], rv = () => { const x = [rnd() - .5, rnd() - .5, rnd() - .5], l = Math.hypot(...x) || 1; return x.map(c => c / l); };
  if (v === 'taps') { say(0, 1, 1); [.33, .66, 1].forEach((d, i) => say(d, 1, .5 / (i + 1), { noise: 0 })); fx.waves.push({ t0: t, o: p, taps: [[0, 1], [.33, .5], [.66, .3], [1, .18]] }); }
  else if (v === 'gallop') { const ds = [0, .11, .22, .52, .63, .74]; ds.forEach((d, i) => say(d, 1, 1 / (1 + i * .5), { dur: (base.dur || 1) * .45 })); fx.waves.push({ t0: t, o: p, taps: ds.map((d, i) => [d, 1 / (1 + i * .5)]), speed: 3.6, width: 4 }); }
  else if (v === 'rise' || v === 'fall') { const dir = v === 'rise' ? 1 : -1;
    for (let i = 0; i < 5; i++) say(i * .17, dir > 0 ? step(i) : 1 / step(i), 1 / (1 + i * .35), { dur: (base.dur || 1) * .6 });
    fx.waves.push({ t0: t, o: p, mode: 1, n: up.map(c => c * dir), taps: [[0, 1], [.17, .8], [.34, .6], [.51, .45], [.68, .3]], speed: 1.9, width: 3 }); }
  else if (v === 'shimmer') { say(0, 1, .8, { attack: .08 }); say(.25, 2, .4, { attack: .3, dur: (base.dur || 1) * 1.6, noise: 0 }); say(.55, 3, .22, { attack: .5, dur: (base.dur || 1) * 2, noise: 0 }); say(.9, 4, .12, { attack: .6, dur: (base.dur || 1) * 2.2, noise: 0 });
    fx.waves.push({ t0: t, o: p, taps: [[0, .8], [.4, .65], [.9, .5], [1.5, .35]], speed: 1.05, width: 1.1, life: 3.6 }); }
  else if (v === 'swarm') { for (let i = 0; i < 9; i++) { const d = i ? rnd() * .7 : 0; say(d, step(Math.floor(rnd() * 9)) * (rnd() > .6 ? 2 : 1), .5 + rnd() * .5, { dur: .1 + rnd() * .22, noise: (base.noise || 0) * .5 });
      fx.waves.push({ t0: t + d, o: p.map(c => c + (rnd() - .5) * 1.3), taps: [[0, 1]], speed: 3, width: 4.5, amp: .55, life: 1.2 }); } }
  else if (v === 'reverse') { say(0, 1, .9, { attack: .5, dur: .62, noise: 0 }); say(.52, 1, 1.1, { dur: (base.dur || 1) * .5 }); say(.52, 2, .3, { dur: .3 });       // it draws breath, then strikes
    fx.waves.push({ t0: t, o: p, implode: true, taps: [[0, 1]], speed: 4.6, width: 2.6, life: .6 }); fx.waves.push({ t0: t + .54, o: p, taps: [[0, 1.2]], speed: 3.2, width: 2 }); }
  else { say(0, 1, 1, { dur: (base.dur || 1) * 2.2, attack: .05 }); say(0, 1.006, .5, { dur: (base.dur || 1) * 2.2, attack: .05, noise: 0 });                              // still: no echo at all, one long beating tone, and the dust turns
    fx.waves.push({ t0: t, o: p, mode: 2, n: rv(), taps: [[0, 1]], speed: 1.5, width: 1.3, life: 3.4, amp: 1.2 }); }
  if (fx.waves.length > 22) fx.waves.splice(0, fx.waves.length - 22);
  return v;
}
function nebTouch(x, y) {
  const c = Gym.cur; if (!c) return; const fx = fxOf(c.slug), G = fx.ngeom, L = fx.life; if (!G || !L) return;
  ac().resume(); const gr = G.growth, pure = clamp(.25 * gr + .75 * G.learned, 0, 1), hit = nebUnder(c, G, x, y);
  if (hit.kind === 'void') { hit.freq /= 2; L.startle = 1; nebRespond(fx, hit, { dur: 1.6 + gr * 3, attack: .12, gain: .22, partials: 1 + Math.round(gr * 5), detune: (1 - pure) * .05, bend: -.12 * (1 - pure), noise: (1 - pure) * .25, noiseAt: 1.5 }); }
  else if (hit.kind === 'pillar') { hit.o.slot.ring = 1; const mem = hit.track && grainCloud(c.slug, hit.track, { pure, pos: hit.u, n: 6 + Math.round(gr * 5), gain: .34, long: 1 + gr });   // it answers with scraps of the very track that lives where you touched
    nebRespond(fx, hit, { gainK: mem ? .45 : 1, dur: .45 + gr * 2.6, gain: .2, type: pure > .5 ? 'sine' : 'triangle', partials: 1 + Math.round(gr * 4), detune: (1 - pure) * .045, bend: -(1 - pure) * .07, noise: (1 - pure) * .4 + .03, noiseAt: 3 }); }
  else if (hit.kind === 'haze') { hit.freq = 320 + Math.random() * 900; if (c.food.length) grainCloud(c.slug, c.food[Math.floor(Math.random() * c.food.length)].name, { pure, n: 4, gain: .16, rate: 2, gap: .05 });   // the haze holds faint, sped-up echoes of anything it ate
    nebRespond(fx, hit, { dur: .9 + gr * 2.2, gain: .12, ratios: [1, 2.76, 5.4, 8.93].slice(0, 2 + Math.round(gr * 2)), detune: (1 - pure) * .03, noise: (1 - pure) * .18, noiseAt: 4 }); }
  else { hit.freq = 700 + Math.random() * 1400; nebRespond(fx, hit, { dur: .22 + gr * .3, gain: .07, bend: Math.random() > .5 ? 1.2 : -.6 }); L.sx = x; L.sy = y; }
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
function nebUnder(c, G, x, y, noVoid) {
  const vi = noVoid ? -1 : G.voids.findIndex(o => Math.hypot(o.x - x, o.y - y) < o.r);
  if (vi >= 0) return { kind: 'void', vi, p: G.voids[vi].p, freq: 41 * ALIEN_SCALE[vi * 2 % 7] * 2 };
  let best = null;
  for (const o of G.lobes) { const ex = o.b[0] - o.a[0], ey = o.b[1] - o.a[1], u = clamp(((x - o.a[0]) * ex + (y - o.a[1]) * ey) / (ex * ex + ey * ey || 1), 0, 1), dd = Math.hypot(x - o.a[0] - ex * u, y - o.a[1] - ey * u) / (o.r * (1 - .5 * u) || 1); if (!best || dd < best.dd) best = { o, u, dd }; }
  if (best && best.dd < 1.15 && c.food.length) {
    const o = best.o, mem = c.food.filter((f, i) => (c.limbs && c.limbs.length > 1 ? (f.limb || 0) % G.K : i % G.K) === o.j).sort((a, b) => (a.core || 0) - (b.core || 0));
    const mem5 = mem.slice(0, 5), f = mem5.length ? mem5[Math.min(mem5.length - 1, Math.floor(best.u * mem5.length))] : c.food[0];   // the tracks it holds in memory for this limb
    return { kind: 'pillar', o, u: best.u, dd: best.dd, p: o.a3.map((a, k) => a + (o.b3[k] - a) * best.u), freq: noteOf(f.bright ?? .3), track: f.name };
  }
  if (best && best.dd < 3.2) return { kind: 'haze', p: G.unproj(x, y, best.o.a[2]), freq: noteOf(.35 + .6 * clamp(1 - y / (NEB.canvas.clientHeight || 1), 0, 1)) * 2 };
  return { kind: 'space', p: G.unproj(x, y, G.dist), freq: noteOf(.5 + .5 * clamp(1 - y / (NEB.canvas.clientHeight || 1), 0, 1)) * 4 };
}

/* drag: your pointer pushes through the dust and bows it. The pitch follows whatever you are passing over. */
function nebDrag(x, y, speed) {
  const c = Gym.cur; if (!c) return; const fx = fxOf(c.slug), G = fx.ngeom; if (!G) return;
  const a = ac(), D = NEB.drag, now = a.currentTime, t = performance.now() / 1000, gr = G.growth, pure = clamp(.25 * gr + .75 * G.learned, 0, 1), hit = nebUnder(c, G, x, y, !!NEB.drag.track);   // once you are playing a limb, the voids inside it do not interrupt
  a.resume(); D.on = true; D.p = hit.p;
  if (!D.v) { const g = a.createGain(), g2 = a.createGain(), lp = a.createBiquadFilter(), o1 = a.createOscillator(), o2 = a.createOscillator(); g.gain.value = 0; lp.type = 'lowpass'; lp.frequency.value = 900; lp.Q.value = 4;
    o1.type = 'sawtooth'; o2.type = 'sine'; g2.gain.value = .5; o1.connect(lp); o2.connect(g2); g2.connect(lp); lp.connect(g); g.connect(voiceOut()); o1.start(); o2.start(); D.v = { g, lp, o1, o2 }; }
  const wob = 1 + (1 - pure) * .03 * Math.sin(t * 23), lvl = clamp(speed / 1400, .025, .16) * (hit.kind === 'space' ? .35 : hit.kind === 'haze' ? .7 : 1);
  D.v.o1.frequency.setTargetAtTime(hit.freq * wob, now, .05); D.v.o2.frequency.setTargetAtTime(hit.freq * (hit.kind === 'void' ? .5 : ALIEN_SCALE[4]) * (1 + (1 - pure) * .012), now, .05);
  D.v.lp.frequency.setTargetAtTime(500 + speed * 1.6 + pure * 1800, now, .08);
  D.speed = Math.max(D.speed || 0, speed); D.pure = pure; D.slug = c.slug; D.limb = null;
  if (hit.kind === 'pillar') { hit.o.slot.ring = Math.max(hit.o.slot.ring, .6);
    // A limb is an instrument made of its own tracks. Where you first touch it picks the track; from there, moving toward the tip plays forward through it,
    // moving back toward the base rewinds, and holding still freezes on that moment. Its middle plays clean; toward its edge the sound is shredded.
    const lk = hit.o.j + (hit.o.a3[0] < 0 ? 'm' : ''); if (D.lobe !== lk || !D.track) { D.lobe = lk; D.track = hit.track; D.head = null; D.lastU = hit.u; }
    const b = grainBuf(c.slug, D.track);
    if (b) { if (D.head == null) D.head = .1 + .8 * hit.u; D.head = clamp(D.head + (hit.u - D.lastU) * 22 / b.duration, 0, 1); }   // the whole length of the limb is about 22 seconds of the track
    D.lastU = hit.u; D.edge = clamp(((hit.dd || 0) - .3) / .75, 0, 1); D.limb = hit.o.slot.tr; D.buf = b;
  }
  D.v.g.gain.setTargetAtTime(D.limb && D.buf ? 0 : lvl * (D.limb ? .6 : 1), now, .06);              // on a limb you hear its tracks, not the drone; the drone is for voids, haze and empty space
  if (!D.tick) D.tick = setInterval(nebDragTick, 30);
  if (!D.lastWave || t - D.lastWave > (hit.kind === 'space' ? .5 : .22)) { D.lastWave = t; fx.waves.push({ t0: t, o: hit.p, soft: true, mode: Math.random() > .5 ? 2 : 0, n: [Math.random() - .5, Math.random() - .5, Math.random() - .5].map((c, i, v) => c / (Math.hypot(...v) || 1)), taps: [[0, 1], [.4, .4]], speed: 1.8 }); if (fx.waves.length > 18) fx.waves.shift(); }
}
function nebDragTick() {                                 // the grains keep coming while you hold, whether or not your hand moves
  const D = NEB.drag, t = performance.now() / 1000; if (!D.on) { clearInterval(D.tick); D.tick = 0; return; }
  D.speed = (D.speed || 0) * .86; const tr = D.limb, b = D.buf; if (!tr || !b) return;
  const sp = D.speed, e = D.edge || 0, pure = D.pure || 0, rnd = Math.random, gap = clamp(.085 - .04 * tr[4] - sp / 30000, .035, .09) * (1 - .35 * e);   // a fast-tempo limb speaks in denser grains, and so does a fast hand
  if (D.lastGrain && t - D.lastGrain < gap) return; D.lastGrain = t;
  const stut = tr[0] > .45 && rnd() < tr[0] * .3 ? Math.floor(rnd() * 3) * .06 : 0;                                                          // a noisy limb stutters
  const jit = ((rnd() - .5) * (.05 + 1.6 * e * e + .35 * tr[0] + .5 * (1 - pure)) - stut) / b.duration;                                    // toward the edge, the grains scatter in time
  const rate = (1 - .38 * tr[3] + .28 * tr[2]) * (rnd() < e * .32 ? (rnd() < .5 ? .5 : 2) : 1) * (1 + (1 - pure) * (rnd() - .5) * .05);     // a bassy limb sings low and slow, a bright one high; the edge throws octaves
  grainOne(b, { pos: clamp(D.head + jit, 0, 1), dur: (.26 + .2 * tr[3] + pure * .12) * (1 - .78 * e) * (.8 + rnd() * .4), gain: clamp(.16 + sp / 2600, .16, .36) * (1 - .3 * e), rate, attack: .03 * (1 - .7 * e) + .004 });
}
function nebDragEnd() {
  const D = NEB.drag; D.on = false; D.track = null; D.lobe = null; D.limb = null; D.buf = null; D.speed = 0;
  if (D.v) { const a = ac(), v = D.v; D.v = null; v.g.gain.setTargetAtTime(0, a.currentTime, .3); setTimeout(() => { try { v.o1.stop(); v.o2.stop(); } catch {} }, 2500); }
}

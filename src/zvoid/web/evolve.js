/* Evolve: breed a sound over rounds. Each round makes four mutations of the current parent; you pick the one that is most
   alive and it becomes the parent of the next round. The family tree is kept, so any earlier sound can be grown again. */
const EVO = { open: false, list: [], s: null, timer: 0, auto: true, creatures: [] };
const evoEl = () => $('#evo');
const evoIt = path => ({ path, kind: 'audio', size: 0, short: true, name: path.split('/').pop() });   // evolve's sounds are short: held in memory, so comparing them is instant

async function openEvo(sid) {
  if (typeof Gym !== 'undefined' && Gym.open) closeGym();
  EVO.open = true; evoEl().hidden = false; openDrawer(null);
  try { EVO.creatures = await api('/api/gym'); } catch (e) { EVO.creatures = []; }
  await evoList();
  const want = sid || (EVO.s && EVO.s.id) || (EVO.list[0] && EVO.list[0].id);
  if (want) { try { EVO.s = await api('/api/evolve/' + want); } catch (e) { EVO.s = null; } }
  evoDraw(); evoPoll();
}
function closeEvo() { EVO.open = false; evoEl().hidden = true; clearTimeout(EVO.timer); }
async function evoList() { try { EVO.list = await api('/api/evolve'); } catch (e) { EVO.list = []; } }
async function evoPoll() {
  clearTimeout(EVO.timer); if (!EVO.open) return;
  if (EVO.s && EVO.s.live) {
    try { const s = await api('/api/evolve/' + EVO.s.id), sig = x => JSON.stringify([x.live && [x.live.done, x.live.error], Object.keys(x.nodes).length, x.head]), was = sig(EVO.s), had = EVO.s.live;
      EVO.s = s; if (sig(s) !== was) evoDraw(); else evoLive();
      if (had && !s.live) { evoList().then(evoDraw); } } catch (e) {}
  }
  EVO.timer = setTimeout(evoPoll, EVO.s && EVO.s.live ? 450 : 2500);
}
function evoLive() {                                     // only the progress line changes while a mutation is being made
  const el = $('#evo-live'), l = EVO.s && EVO.s.live; if (!el || !l) return;
  el.querySelector('span').textContent = l.error ? 'it failed: ' + l.error : `round ${l.round} · ${l.msg}`;
  el.querySelector('i').style.width = Math.round(((l.done + (l.frac || 0)) / l.total) * 100) + '%';
}
async function evoDo(fn) { try { const r = await fn(); if (r && r.nodes) EVO.s = r; evoDraw(); evoPoll(); return r; } catch (e) { toast(String(e.message || e), true); } }
const evoRound = () => evoDo(() => api(`/api/evolve/${EVO.s.id}/round`, { json: { n: 4 } }));
async function evoPick(nid, grow) {
  await evoDo(() => api(`/api/evolve/${EVO.s.id}/pick`, { json: { node: nid } }));
  if (grow && EVO.auto && EVO.s && !EVO.s.live) evoRound();
}
async function evoKeep(nid) { try { const r = await api(`/api/evolve/${EVO.s.id}/keep`, { json: { node: nid } }); toast('kept in the library as “' + r.title + '”'); EVO.s = await api('/api/evolve/' + EVO.s.id); evoDraw(); } catch (e) { toast(String(e.message || e), true); } }
async function evoStart(body) {
  const b = $('#evo-new'); if (b) b.classList.add('busy');
  try { const s = await api('/api/evolve', { json: body }); EVO.s = s; await evoList(); if (!EVO.open) return openEvo(s.id); evoDraw(); evoPoll(); toast('started: make the first round'); }
  catch (e) { toast('could not start: ' + (e.message || e), true); }
  if (b) b.classList.remove('busy');
}
const evoSave = patch => api('/api/evolve/' + EVO.s.id, { method: 'PUT', json: patch }).then(s => { EVO.s = s; }).catch(() => {});
function evoNightBox(trained, s) {
  const N = (EVO.live && EVO.live.running ? EVO.live : EVO.night) || {}, box = h('div', { id: 'evo-night' });      // the box always shows the run that is going, whichever run or album is open on the right
  const toLive = async () => { EVO.viewId = null; EVO.album = null; EVO.showNight = true; EVO.sheet = null; await evoNightPoll(); evoDraw(); };
  if (N.running) {
    const left = N.per && N.count > N.made ? ` · about ${Math.max(1, Math.round((N.count - N.made) * N.per / 60))} min left` : '';
    const until = N.until ? new Date(N.until * 1000).toTimeString().slice(0, 5) : '';
    box.append(h('div', { class: 'evo-night-msg' }, N.phase === 'chiselling' ? `chiselling the ${N.made} songs until ${until} · ${N.carved} carvings kept of ${N.carves} tried` : `${N.made} of ${N.count} songs made${left}`), h('div', { class: 'evo-bar' }, h('i', { style: `width:${Math.round(N.made / N.count * 100)}%` })),
      h('small', { title: N.msg || '' }, N.msg || ''), h('div', { class: 'acts' }, h('button', { class: EVO.showNight && !EVO.album && !EVO.viewId ? '' : 'hot', onclick: toLive }, 'show the run'), h('button', { title: 'It ends after the try it is on. Songs already finished stay in the library.', onclick: () => api('/api/night/stop', { method: 'POST' }).then(evoNightPoll) }, '■ stop')));
  } else {
    EVO.nightWho = EVO.nightWho || new Set(N.creatures && N.creatures.length ? N.creatures : s && s.creature ? [s.creature] : trained.slice(-1).map(c => c.slug));
    const cnt = h('input', { type: 'number', min: 1, max: 200, value: EVO.nightCount || 20, style: 'width:58px', onchange: e => { EVO.nightCount = +e.target.value; est(); } });
    const tr = h('select', { title: 'How many goes each song gets. After each go it is measured (drums, pulse, contrast, how unlike the others it is) and its plan is rewritten before the next go. The best go is the song.', onchange: e => { EVO.nightTries = +e.target.value; est(); } }, [1, 2, 3, 4, 6].map(v => h('option', { value: v }, v === 1 ? '1 go each' : v + ' goes each'))); tr.value = EVO.nightTries || 2;
    const dir = h('textarea', { rows: 3, spellcheck: 'false', placeholder: 'what the collection is: nothing like the world has heard before, primal music of the future, drums that come and go…', oninput: e => { EVO.nightDir = e.target.value; } }); dir.value = EVO.nightDir != null ? EVO.nightDir : (s && s.direction) || '';
    const hrs = h('input', { type: 'number', min: 0, max: 16, step: .5, value: EVO.nightHours != null ? EVO.nightHours : 8, style: 'width:58px', title: 'After the songs are made, it keeps chiselling them for this long: one stretch of one song is made again, and the change is kept only if the song measures as more defined. 0 = make them and stop.', onchange: e => { EVO.nightHours = +e.target.value; est(); } });
    const estEl = h('small', {}), est = () => { const m = Math.round((+cnt.value || 20) * (+tr.value || 2) * 1.75 + (+cnt.value || 20) * .4), end = new Date(Date.now() + (m + (+hrs.value || 0) * 60) * 60000).toTimeString().slice(0, 5);
      estEl.textContent = `making them: about ${m >= 90 ? (m / 60).toFixed(1) + ' hours' : m + ' minutes'}` + ((+hrs.value || 0) ? ` · then chiselling for up to ${+hrs.value} h · done by about ${end}` : '') + ' · only the finished songs reach the library'; estEl.title = estEl.textContent; };
    est();
    box.append(h('div', { class: 'evo-who' }, trained.map(c => h('label', {}, h('input', { type: 'checkbox', checked: EVO.nightWho.has(c.slug), onchange: e => { e.target.checked ? EVO.nightWho.add(c.slug) : EVO.nightWho.delete(c.slug); } }), h('span', {}, c.name)))),
      dir, h('div', { class: 'acts' }, cnt, h('span', { class: 'gym-note' }, 'songs'), tr),
      h('div', { class: 'acts' }, h('span', { class: 'gym-note' }, 'then chisel for'), hrs, h('span', { class: 'gym-note' }, 'hours')), estEl,
      h('div', { class: 'acts' }, h('button', { class: 'hot', disabled: !trained.length, title: 'Both machines are kept awake while it runs. Leave Zvoid open.', onclick: async () => {
        if (!EVO.nightWho.size) return toast('tick at least one creature', true);
        try { EVO.night = await api('/api/night', { json: { creatures: [...EVO.nightWho], count: +cnt.value || 20, tries: +tr.value || 2, hours: +hrs.value || 0, direction: dir.value } }); EVO.viewId = null; EVO.album = null; EVO.showNight = true; EVO.sheet = null; evoDraw(); evoNightPoll(); toast('night shift started: leave Zvoid open'); } catch (e) { toast(String(e.message || e), true); } } }, 'make the collection ▸')),
      N.msg && N.finished ? h('small', { title: N.msg }, N.msg) : '',
      N.id ? h('div', { class: 'acts' }, h('button', { onclick: async () => { EVO.viewId = null; EVO.showNight = true; EVO.album = null; EVO.sheet = null; await evoNightPoll(); evoDraw(); } }, N.running ? 'show the run that is going' : 'show the latest run')) : '');
  }
  box.append(
      (EVO.albums || []).length ? h('h3', {}, 'albums') : '',
      (EVO.albums || []).length ? h('div', { class: 'alb-shelf', title: 'Every finished loop is kept as an album: its pieces as they sounded when the loop ended.' }, EVO.albums.map(a => h('button', { class: 'alb-item' + (EVO.album === a.folder ? ' on' : ''), onclick: () => { EVO.album = a.folder; evoDraw(); } },
        a.cover ? h('img', { src: albUrl(a.folder, 'cover.jpg'), alt: '' }) : h('span', { class: 'alb-blank' }), h('span', {}, h('b', {}, a.title), h('small', {}, `album ${a.n} · ${a.pieces.length} pieces`))))) : '');
  return box;
}
async function evoNightPoll() {
  clearTimeout(EVO.nightT);
  try { const sig = n => JSON.stringify([n.running, n.made, n.thrown, n.phase, n.carves, (n.msg || '').split(' · now:')[0]]), was = sig(EVO.night || {}); EVO.night = await api('/api/night' + (EVO.viewId ? '?id=' + EVO.viewId : '')); if (EVO.viewId && EVO.night.id !== EVO.viewId) EVO.viewId = null; EVO.live = EVO.viewId ? await api('/api/night').catch(() => null) : EVO.night; { const ls = sig(EVO.live || {}); if (EVO.viewId && ls !== EVO.liveSig) EVO.stale = true; EVO.liveSig = ls; }
    if (EVO.night.id && (EVO.open || !EVO.sheet)) await evoSheet();
    if (!EVO.coversAt || Date.now() - EVO.coversAt > 90000) { EVO.coversAt = Date.now(); evoCovers(); }
    const b = $('#btn-evo'); if (b) b.textContent = EVO.night.running ? (EVO.night.phase === 'chiselling' ? `⟲ evolve · chiselling` : `⟲ evolve · night ${EVO.night.made}/${EVO.night.count}`) : '⟲ evolve';
    const typing = !!(document.activeElement && document.activeElement.tagName === 'TEXTAREA' && document.activeElement.closest('.night-talk'));   // while you are writing an answer the screen is not rebuilt under you
    if (EVO.open) { if ((sig(EVO.night) !== was || EVO.stale) && !typing) evoDraw(); else { if (sig(EVO.night) !== was) EVO.stale = true; const m = document.querySelector('#evo-night small'); if (m && EVO.night.running) m.textContent = EVO.night.msg || ''; const m2 = $('#night-msg'); if (m2) m2.textContent = EVO.night.msg || ''; } } } catch (e) {}
  EVO.nightT = setTimeout(evoNightPoll, EVO.night && EVO.night.running ? 3000 : 20000);
}
async function evoSheet() {                              // the night's own notes: every piece it planned, what it tried, what it kept
  try {
    if (!EVO.outRoot) { const m = (LIB.items && LIB.items.length ? LIB.items : await api('/api/made')).find(x => x.path.includes('/outputs/')); if (m) EVO.outRoot = m.path.split('/outputs/')[0] + '/outputs'; }
    if (!EVO.outRoot) return;
    const r = await fetch(fileUrl(`${EVO.outRoot}/_night/${EVO.night.id}/collection.json`), { cache: 'no-store' }); if (!r.ok) return;
    const sh = await r.json(), nm = await fetch(fileUrl(`${EVO.outRoot}/_night/${EVO.night.id}/names.json`), { cache: 'no-store' }).then(q => q.ok ? q.json() : {}).catch(() => ({}));
    (sh.ideas || []).forEach((x, i) => { x.name = nm[i + 1] || x.title; });                       // names given afterwards; the night itself keeps using its own
    EVO.sheet = sh;
    if (!EVO.talkBusy) EVO.taste = await fetch('/api/night/taste?id=' + EVO.night.id, { cache: 'no-store' }).then(q => q.ok ? q.json() : null).catch(() => null);
    EVO.marks = await fetch('/api/night/marks?id=' + EVO.night.id, { cache: 'no-store' }).then(q => q.ok ? q.json() : null).catch(() => null);
    evoStale(sh);   // null until the app has been restarted with the marks in it
  } catch (e) {}
}
/* The night as a small vivarium. The creatures float in a ring in the dark, each a glowing body of its own species and
   colours. Every piece is an offspring hanging between the creatures that play it, joined to each by a living filament,
   and grown from a part of each parent's body. While it waits it is dust; while it is being made, light runs down the
   filaments into a churning cloud; once finished it has a body that beats at its own tempo. Carving strikes it like
   lightning and leaves a spark in orbit for every cut (bright if kept, in a guest's colour if a guest made it). A piece
   that is playing moves with its own sound and sends light back to its parents. Hover to read it, click to hear it. */
const NIGHT_W = 1000, NIGHT_H = 500;
function nightGlow(g, x, y, R, hue, hue2, t, sd, e) {
  for (let j = 0; j < 3; j++) {
    const a = j * 2.1 + sd * 6.28 + t * .11, bx = x + Math.cos(a) * R * .22 + noise(t * .2 + j * 5 + sd * 40) * R * .08, by = y + Math.sin(a) * R * .2 + noise(t * .17 + j * 9 + sd * 60) * R * .08;
    const rad = R * (1.15 + .3 * j), hu = j === 1 ? hue2 : hue, gr = g.createRadialGradient(bx, by, 0, bx, by, rad);
    gr.addColorStop(0, `hsla(${hu},95%,66%,${(j ? .16 : .34) * e})`); gr.addColorStop(.45, `hsla(${hu + 25},95%,48%,${.07 * e})`); gr.addColorStop(1, 'hsla(0,0%,0%,0)');
    g.fillStyle = gr; g.fillRect(bx - rad, by - rad, rad * 2, rad * 2);
  }
}
function nightForm(g, x, y, R, plan, hue, hue2, t, sd, a0, span, e) {
  const full = span > 6, st = (hu, l, a) => `hsla(${hu},95%,${l}%,${Math.min(1, a * e)})`, A = (k, n) => full ? a0 + k / n * 6.2832 : a0 + (n === 1 ? 0 : (k / (n - 1) - .5)) * span;
  const P = (a, r) => [x + Math.cos(a) * r, y + Math.sin(a) * r], lw = Math.max(.7, R * .035);
  g.lineCap = 'round'; g.lineJoin = 'round';
  if (plan === 1) {
    const n = full ? 6 + Math.floor(sd * 4) : 3;
    for (let k = 0; k < n; k++) { const a = A(k, n) + Math.sin(t * .4 + sd * 9) * .12, len = R * (.82 + .18 * Math.sin(t * 1.1 + k * 1.7 + sd * 20)), w = full ? 2.2 / n + .12 : .3, c1 = P(a - w, len * .7), c2 = P(a + w, len * .7), tip = P(a, len);
      g.beginPath(); g.moveTo(x, y); g.quadraticCurveTo(c1[0], c1[1], tip[0], tip[1]); g.quadraticCurveTo(c2[0], c2[1], x, y);
      g.fillStyle = st(hue, 60, .07); g.fill(); g.strokeStyle = st(k % 2 ? hue2 : hue, 70, .6); g.lineWidth = lw; g.stroke();
      g.beginPath(); g.arc(tip[0], tip[1], lw * 1.3, 0, 7); g.fillStyle = st(hue2, 80, .8); g.fill(); }
  } else if (plan === 2) {
    const pts = []; for (let i = 0; i <= 60; i++) pts.push(P(a0 + i * .22 + t * .15, R * .08 * Math.exp(i * .042)));
    g.beginPath(); pts.forEach((p, i) => i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1])); g.strokeStyle = st(hue, 70, .7); g.lineWidth = lw * 1.2; g.stroke();
    g.beginPath(); for (let i = 30; i <= 60; i += 3) { g.moveTo(pts[i][0], pts[i][1]); g.lineTo(pts[i - 28][0], pts[i - 28][1]); } g.strokeStyle = st(hue2, 66, .3); g.lineWidth = lw * .7; g.stroke();
  } else if (plan === 3) {
    const n = full ? 5 + Math.floor(sd * 3) : 2, deep = R > 22 ? 3 : 2;
    const br = (px, py, a, len, d, k) => { const aa = a + noise(t * .25 + d * 3.1 + k * 7.7 + sd * 50) * .28, ex = px + Math.cos(aa) * len, ey = py + Math.sin(aa) * len;
      g.beginPath(); g.moveTo(px, py); g.lineTo(ex, ey); g.strokeStyle = st(d ? hue : hue2, 62 + (deep - d) * 5, .65); g.lineWidth = lw * (.5 + d * .45); g.stroke();
      if (d) { br(ex, ey, aa + .5, len * .64, d - 1, k * 2 + 1); br(ex, ey, aa - .42, len * .64, d - 1, k * 2 + 2); } else { g.beginPath(); g.arc(ex, ey, lw * 1.1, 0, 7); g.fillStyle = st(hue2, 80, .9); g.fill(); } };
    for (let k = 0; k < n; k++) br(x, y, A(k, n), R * .44, deep, k + 1);
  } else if (plan === 4) {
    const n = full ? 7 + Math.floor(sd * 3) : 3, rot = full ? t * .05 : 0;
    for (let k = 0; k < n; k++) { const a = A(k, n) + rot, len = R * (.55 + .45 * hash('s' + k + sd)), b1 = P(a - .13, len * .34), b2 = P(a + .13, len * .34), tip = P(a, len), glint = .5 + .5 * Math.sin(t * 1.3 + k * 2.4);
      g.beginPath(); g.moveTo(x, y); g.lineTo(b1[0], b1[1]); g.lineTo(tip[0], tip[1]); g.lineTo(b2[0], b2[1]); g.closePath();
      g.fillStyle = st(hue, 66, .08 + .1 * glint); g.fill(); g.strokeStyle = st(k % 2 ? hue2 : hue, 76, .7); g.lineWidth = lw * .7; g.stroke();
      g.beginPath(); g.moveTo(x, y); g.lineTo(tip[0], tip[1]); g.strokeStyle = st(hue, 88, .25 + .3 * glint); g.stroke(); }
  } else {
    g.save(); g.translate(x, y); g.rotate(full ? sd * 6.28 + Math.sin(t * .2 + sd * 9) * .25 : a0);
    if (plan === 5) {
      g.rotate(-Math.PI / 2); const br = R * .5, sw = Math.sin(t * 1.4 + sd * 9) * .08;
      g.beginPath(); g.ellipse(0, -R * .2, br * (1 + sw), br * (.8 - sw), 0, Math.PI, 0); g.fillStyle = st(hue, 62, .12); g.fill(); g.strokeStyle = st(hue, 72, .7); g.lineWidth = lw; g.stroke();
      const n = full ? 7 : 4;
      for (let k = 0; k < n; k++) { const bx = (k / (n - 1) - .5) * br * 1.8; g.beginPath(); g.moveTo(bx, -R * .2);
        for (let i = 1; i <= 8; i++) g.lineTo(bx + Math.sin(t * 1.5 + i * .6 + k * 1.3) * R * .07 * i / 4, -R * .2 + i * R * .13); g.strokeStyle = st(k % 2 ? hue2 : hue, 70, .5); g.lineWidth = lw * .7; g.stroke(); }
    } else {
      const n = full ? 9 : 5, x0 = full ? -R * .85 : 0, x1 = full ? R * .85 : R * 1.05, sp = i => [x0 + (x1 - x0) * i / (n - 1), Math.sin(i * .7 + t * 1.2 + sd * 9) * R * .09];
      g.beginPath(); for (let i = 0; i < n; i++) { const p = sp(i); i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]); } g.strokeStyle = st(hue, 72, .8); g.lineWidth = lw * 1.3; g.stroke();
      for (let i = 0; i < n; i++) { const p = sp(i), rl = R * .5 * Math.sin(Math.PI * (i + .5) / n) * (1 + .08 * Math.sin(t * 1.6 + i));
        g.beginPath(); g.arc(p[0], p[1], lw * 1.2, 0, 7); g.fillStyle = st(hue2, 82, .9); g.fill();
        if (i && i < n - 1) for (const s of [-1, 1]) { g.beginPath(); g.moveTo(p[0], p[1]); g.quadraticCurveTo(p[0] - R * .05, p[1] + s * rl * .7, p[0] - R * .2, p[1] + s * rl); g.strokeStyle = st(i % 2 ? hue : hue2, 66, .5); g.lineWidth = lw * .75; g.stroke(); } }
    }
    g.restore();
  }
}
/* The night is painted by a shader of its own: every body is a cloud of light shaped by its species, every filament a
   thread of glowing gas, all bent by one slow field so nothing has a hard edge. (Without WebGL 2 it falls back to drawn lines.) */
const NIGHT_FRAG = `#version 300 es
precision highp float;
uniform vec2 uRes; uniform float uT; uniform int uNB, uNF;
uniform vec3 uSky; uniform vec4 uLook;
uniform vec4 uB0[96], uB1[96], uB2[96], uB3[96];
uniform vec4 uF0[48], uF1[48], uF2[48];
out vec4 o;
float h21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vn(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f); return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y); }
float fbm(vec2 p) { float a = .5, s = 0.; for (int i = 0; i < 4; i++) { s += a * vn(p); p = p * 2.03 + vec2(17.1, 9.2); a *= .5; } return s; }
vec3 body(vec2 p, vec4 b0, vec4 b1, vec4 b2, vec4 b3, vec2 w) {
  float R = b0.z; vec2 d = p - b0.xy;
  if (length(d) > R * 3.4) return vec3(0.);
  float turb = b2.w, sd = b1.y, beat = b3.w;
  d += w * R * (.5 + turb * 1.1);
  float r = length(d) / R, th = atan(d.y, d.x), a = th - b1.z;
  vec2 dir = d / max(length(d), .001);
  int plan = int(floor(b1.x + .5));
  float n1 = fbm(d / R * 2.2 + sd * 31. + vec2(0., uT * .12)), n2 = fbm(d / R * 5. + sd * 17. - vec2(uT * .2, 0.));
  float core = exp(-r * r * 6.), halo = exp(-r * 1.6) * (.25 + .75 * n1), s = 0.;
  vec2 l = vec2(cos(b1.z) * d.x + sin(b1.z) * d.y, -sin(b1.z) * d.x + cos(b1.z) * d.y) / R;
  if (plan == 1) {
    float n = 5. + floor(sd * 4.);
    float pet = pow(abs(cos(a * n * .5 + (n1 - .5) * 1.6 + sin(uT * .3 + sd * 9.) * .3)), 2.5);
    s = pet * exp(-pow(r - .6, 2.) * 4.5) * 1.3 + pow(abs(cos(a * n * .5)), 24.) * exp(-r * 2.) * .5;
  } else if (plan == 2) {
    s = smoothstep(.45, 1., sin(log(r + .05) * 7. - a + uT * .4 + n1)) * exp(-r * 1.5) * 1.4;
  } else if (plan == 3) {
    float q = 1. - abs(2. * fbm(dir * (2.4 + floor(r * 2.) * 1.3) + vec2(r * .3) + sd * 9. + (n1 - .5) * .5) - 1.);
    s = pow(q, 5.) * exp(-pow(max(r - .25, 0.), 2.) * 1.8) * 1.7 * smoothstep(.04, .3, r) + pow(n2, 4.) * exp(-pow(r - 1., 2.) * 6.) * 3.;
  } else if (plan == 4) {
    float n = 6. + floor(sd * 3.);
    float ray = pow(abs(cos(a * n * .5 + uT * .03)), 50.), ray2 = pow(abs(cos(a * n + 1. + uT * .03)), 80.);
    s = (ray * exp(-r * 1.2) * 1.8 + ray2 * exp(-r * 2.4) * 1.) * (.7 + .3 * sin(uT * 1.3 + sd * 20. + r * 6.));
    core *= 1.7;
  } else if (plan == 5) {
    float bell = exp(-pow((length(vec2(l.y, l.x * 1.2)) - .5) * 6., 2.)) * smoothstep(-.1, .15, l.x);
    float tn = pow(abs(cos(l.y * 9. + sin(l.x * 6. + uT * 1.5) * .9)), 8.) * exp(-pow(l.y * 1.8, 2.)) * smoothstep(.1, -.2, l.x) * exp(l.x * .9);
    s = bell * 1.3 + tn * 1.;
  } else if (plan == 0) {
    float y0 = sin(l.x * 3. + uT * 1.2 + sd * 9.) * .1, ends = smoothstep(1.15, .75, abs(l.x)), yy = l.y - y0;
    float spine = exp(-pow(yy * 9., 2.)) * ends;
    float rib = pow(abs(sin((l.x + abs(yy) * .4) * 9.)), 7.) * exp(-pow(max(abs(yy) - .6 * cos(clamp(l.x, -1.1, 1.1) * 1.35), 0.) * 7., 2.)) * ends;
    s = spine * 1.5 + rib * .75;
  } else {
    s = pow(n2, 3.) * exp(-r * 1.6) * 4.; core *= .5;
  }
  if (b1.w < 6.) { float da = abs(atan(sin(a), cos(a))), win = smoothstep(b1.w * .5 + .45, b1.w * .5 - .15, da); s *= win; halo *= .35 + .65 * win; }
  float I = (core * (1. + beat * 1.3) + halo * .5 + s * (.55 + n2 * 1.1)) * b0.w;
  vec3 c = mix(b2.rgb, b3.rgb, clamp(n1 * 1.5 - .4 + r * .3, 0., 1.));
  return c * I + vec3(1., .96, .98) * core * core * .55 * b0.w * (1. + beat);
}
vec3 fil(vec2 p, vec4 f0, vec4 f1, vec4 f2, vec2 w) {
  vec2 ab = f0.zw - f0.xy; float L = max(length(ab), 1.); vec2 dir = ab / L, nrm = vec2(-dir.y, dir.x), q = p - f0.xy + w * 16.;
  float u = dot(q, dir) / L; if (u < -.03 || u > 1.03) return vec3(0.);
  float env = sin(clamp(u, 0., 1.) * 3.14159);
  float off = (f2.x * L + (vn(vec2(u * 3. + f2.y * 13.7, uT * .35)) - .5) * 26.) * env;
  float d = dot(q, nrm) - off; if (abs(d) > 46.) return vec3(0.);
  float gas = vn(vec2(u * 16. - uT * .5, f2.y * 5.));
  float line = exp(-d * d / 2.5) * .8 + exp(-abs(d) / 8.) * .3 * (.3 + gas);
  float bead = pow(.5 + .5 * cos(6.2832 * 3. * (u - uT * f2.z) + f2.y * 6.), 20.) * exp(-d * d / 26.) * f2.w * 1.8;
  float ends = smoothstep(0., .08, u) * smoothstep(1., .92, u);
  return f1.rgb * (line * f1.a + bead) * ends;
}
void main() {
  vec2 p = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y) / uRes.x * 1000.;
  vec2 w = (vec2(fbm(p * .011 + vec2(uT * .05, 3.)), fbm(p * .011 + vec2(7., -uT * .045))) - .47) * uLook.y;
  float hz = pow(fbm(p * .004 + w * .9 + uT * .01), 3.);
  if (uLook.x > .5 && uLook.x < 1.5) { hz = pow(fbm(vec2(p.x * .0013 + uT * .008, p.y * .013) + w * .5), 3.) * 1.35; }
  else if (uLook.x > 1.5 && uLook.x < 2.5) { vec2 q = p - vec2(500., 500. * uRes.y / uRes.x); float an = atan(q.y, q.x); hz = pow(fbm(vec2(cos(an), sin(an)) * 1.9 + length(q) * .0022 - uT * .02 + w * .4), 3.) * 1.3; }
  else if (uLook.x > 2.5) { vec2 q = p * .006 + w * .6; float cell = abs(fbm(q) - fbm(q + 3.7)); hz = pow(1. - smoothstep(0., .2, cell), 3.) * .42 + pow(fbm(p * .003 + uT * .01), 3.) * .5; }
  vec3 c = uSky * hz * uLook.w;
  vec2 g = floor(p / 8.); float st = h21(g);
  if (st > uLook.z) { vec2 sp = (g + .5 + (vec2(h21(g + 3.), h21(g + 7.)) - .5) * .7) * 8.; float dd = length(p - sp); c += vec3(.7, .76, 1.) * exp(-dd * dd * 1.1) * (.35 + .3 * sin(uT * .8 + st * 700.)); }
  for (int i = 0; i < 48; i++) { if (i >= uNF) break; c += fil(p, uF0[i], uF1[i], uF2[i], w); }
  for (int i = 0; i < 96; i++) { if (i >= uNB) break; c += body(p, uB0[i], uB1[i], uB2[i], uB3[i], w); }
  c = 1. - exp(-c * 1.3);
  o = vec4(c + uSky * .155, 1.);
}`;
let NIGHTGL;
function nightGL() {
  if (NIGHTGL !== undefined) return NIGHTGL;
  NIGHTGL = null;
  try {
    const canvas = document.createElement('canvas'), gl = canvas.getContext('webgl2', { antialias: false, alpha: false });
    if (!gl || gl.getParameter(gl.MAX_FRAGMENT_UNIFORM_VECTORS) < 600) return null;
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    const prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, '#version 300 es\nin vec2 a; void main() { gl_Position = vec4(a, 0., 1.); }')); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, NIGHT_FRAG)); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer()); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'a'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0); gl.useProgram(prog);
    const U = {}; ['uRes', 'uT', 'uNB', 'uNF', 'uB0', 'uB1', 'uB2', 'uB3', 'uF0', 'uF1', 'uF2', 'uSky', 'uLook'].forEach(k => { U[k] = gl.getUniformLocation(prog, k); });
    canvas.addEventListener('webglcontextlost', () => { NIGHTGL = undefined; });
    NIGHTGL = { canvas, gl, U, b: [0, 1, 2, 3].map(() => new Float32Array(96 * 4)), f: [0, 1, 2].map(() => new Float32Array(48 * 4)) };
  } catch (e) { console.warn('night shader: ' + e.message); NIGHTGL = null; }
  return NIGHTGL;
}
/* Every run has a sky of its own, so no two collections look alike: its colour, what the haze is shaped like (clouds, strata, rays
   from the middle, a web), how much everything sways, how many stars, and how the creatures are set around the edge. All of it
   follows from the run itself, so a run always looks the same. The first collection keeps the sky it was made under. */
function nightLook(id, direction) {
  if (!id || id === 'cd5d7ef917') return { sky: [.10, .07, .2], v: [0, 1, .986, 1.1], rot: 0, rx: 395, ry: 160 };
  EVO.dirs = EVO.dirs || {}; if (direction) EVO.dirs[id] = direction; direction = direction || EVO.dirs[id] || '';
  const u = k => hash(id + k);
  /* a run sent to the underworld looks like it: a sky of dried blood with rays out of a pit, almost no stars, everything writhing,
     and every creature turned to ember, blood and bone instead of its own colours */
  if (/nether|demon|evil|ghoul|\bpit\b|underworld|hell|pekel/i.test(direction))
    return { mood: 'nether', sky: [.2, .008, .018], v: [2, 1.75, .9935, 1.75], rot: u('r') * 6.2832, rx: 372 + u('x') * 26, ry: 150 + u('y') * 20,
      hue: h => 352 + (((h % 360) + 360) % 360 - 180) / 180 * 30, hue2: h => 24 + (((h % 360) + 360) % 360 - 180) / 180 * 16 };
  const c = hsl2rgb(u('h') * 360, .8, .5).map(x => x * .27 + .012);
  return { sky: c, v: [1 + Math.floor(u('p') * 3), .65 + u('w') * 1.0, .976 + u('s') * .016, 1.05 + u('g') * .5], rot: u('r') * 6.2832, rx: 372 + u('x') * 26, ry: 150 + u('y') * 20 };
}
/* B: bodies as rows of sixteen numbers, F: filaments as rows of twelve */
function nightPaint(G, cw, ch, t, B, F, look) {
  look = look || nightLook(''); G.gl.uniform3f(G.U.uSky, look.sky[0], look.sky[1], look.sky[2]); G.gl.uniform4f(G.U.uLook, look.v[0], look.v[1], look.v[2], look.v[3]);
  const gl = G.gl; if (G.canvas.width !== cw || G.canvas.height !== ch) { G.canvas.width = cw; G.canvas.height = ch; }
  const nb = Math.min(96, B.length), nf = Math.min(48, F.length);
  for (let i = 0; i < nb; i++) for (let k = 0; k < 4; k++) G.b[k].set(B[i].slice(k * 4, k * 4 + 4), i * 4);
  for (let i = 0; i < nf; i++) for (let k = 0; k < 3; k++) G.f[k].set(F[i].slice(k * 4, k * 4 + 4), i * 4);
  gl.viewport(0, 0, cw, ch); gl.uniform2f(G.U.uRes, cw, ch); gl.uniform1f(G.U.uT, t % 3600); gl.uniform1i(G.U.uNB, nb); gl.uniform1i(G.U.uNF, nf);
  gl.uniform4fv(G.U.uB0, G.b[0]); gl.uniform4fv(G.U.uB1, G.b[1]); gl.uniform4fv(G.U.uB2, G.b[2]); gl.uniform4fv(G.U.uB3, G.b[3]);
  gl.uniform4fv(G.U.uF0, G.f[0]); gl.uniform4fv(G.U.uF1, G.f[1]); gl.uniform4fv(G.U.uF2, G.f[2]);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}
function evoNightMap(N0, sh0) {
  const W = NIGHT_W, H = NIGHT_H, cx = W / 2, cy = H / 2 - 14, ideas = (sh0 && sh0.ideas) || [], who = (N0.creatures || (sh0 && sh0.creatures) || []);
  const look = c => { const x = EVO.creatures.find(q => q.slug === c); return (x && x.look) || { plan: Math.floor(hash(c + 'p') * 6), hue: hash(c) * 360, hue2: hash(c + '2') * 360 }; };
  const L = {}, P = {}; const sky = nightLook(N0.id, sh0 && sh0.direction); who.forEach((c, i) => { const a = -Math.PI / 2 + sky.rot + i / who.length * Math.PI * 2; P[c] = [cx + Math.cos(a) * sky.rx, cy + 4 + Math.sin(a) * sky.ry]; const k = look(c); L[c] = sky.hue ? { ...k, hue: sky.hue(k.hue), hue2: sky.hue2(k.hue2) } : k; });
  const col = (c, l = 62, a = 1) => `hsla(${L[c].hue},92%,${l}%,${a})`;
  const pos = ideas.map((x, i) => { const cs = [x.creature, ...(x.mix || [])].filter(c => P[c]), k = cs.length || 1, a = i * 2.39996, j = 26 + (i % 5) * 9;
    let px = cs.reduce((s, c) => s + P[c][0], 0) / k, py = cs.reduce((s, c) => s + P[c][1], 0) / k;
    if (k === 1) { px = cx + (px - cx) * .62; py = cy + (py - cy) * .62; }
    return [px + Math.cos(a) * j * (k === 1 ? 1.3 : 1), py + Math.sin(a) * j * .8, cs]; });
  for (let rep = 0; rep < 80; rep++) for (let i = 0; i < pos.length; i++) {
    for (let j = i + 1; j < pos.length; j++) { const dx = pos[j][0] - pos[i][0], dy = pos[j][1] - pos[i][1], d = Math.hypot(dx * .6, dy) || 1; if (d < 62) { const f = (62 - d) / d / 2; pos[i][0] -= dx * f; pos[i][1] -= dy * f; pos[j][0] += dx * f; pos[j][1] += dy * f; } }
    for (const c in P) { const ex = pos[i][0] - P[c][0], ey = pos[i][1] - P[c][1], ed = Math.hypot(ex, ey) || 1; if (ed < 98) { pos[i][0] = P[c][0] + ex / ed * 98; pos[i][1] = P[c][1] + ey / ed * 98; } }
    pos[i][0] = Math.min(W - 50, Math.max(50, pos[i][0])); pos[i][1] = Math.min(H - 74, Math.max(30, pos[i][1])); }
  const box = document.createElement('div'); box.className = 'night-map'; const cv = document.createElement('canvas'), g = cv.getContext('2d'), GL = nightGL(); if (GL) box.append(GL.canvas); box.append(cv);
  const mono = (getComputedStyle(document.documentElement).getPropertyValue('--mono') || '').trim() || 'Menlo, monospace';
  const stars = Array.from({ length: 110 }, (_, i) => [hash('sx' + i) * W, hash('sy' + i) * H, .4 + hash('sr' + i) * 1.1, hash('sp' + i) * 6.28]);
  let hot = -1;
  const at = e => { const r = cv.getBoundingClientRect(), mx = (e.clientX - r.left) / r.width * W, my = (e.clientY - r.top) / r.height * H; let b = -1, bd = 30; pos.forEach((p, i) => { const d = Math.hypot(p[0] - mx, p[1] - my); if (d < bd) { bd = d; b = i; } }); return b; };
  const entry = i => { const sh = EVO.sheet && sh0 && EVO.sheet.id === sh0.id ? EVO.sheet : sh0; return ((sh && sh.songs) || []).find(e => e.n === i + 1); };
  cv.addEventListener('mousemove', e => { hot = at(e); const en = hot >= 0 && entry(hot); cv.style.cursor = en && en.path ? 'pointer' : 'default'; });
  cv.addEventListener('mouseleave', () => { hot = -1; });
  cv.addEventListener('click', e => { const i = at(e), en = i >= 0 && entry(i); if (en && en.path) libPlay({ path: en.path, kind: 'audio', size: 5e7 }); });
  /* a filament from a creature to a piece: a bowed line that never holds still */
  const fil = (a, b, t, k) => { const pts = [], dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1, nx = -dy / len, ny = dx / len, bow = (hash('b' + k) - .5) * len * .3;
    for (let i = 0; i <= 14; i++) { const u = i / 14, env = Math.sin(u * Math.PI), o = bow * env + noise(t * .35 + u * 3 + k * 13.7) * 9 * env; pts.push([a[0] + dx * u + nx * o, a[1] + dy * u + ny * o]); } return pts; };
  const along = (pts, u) => { const f = Math.min(.9999, Math.max(0, u)) * (pts.length - 1), i = Math.floor(f), w = f - i; return [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * w, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * w]; };
  const dot = (x, y, r, c) => { const gr = g.createRadialGradient(x, y, 0, x, y, r); gr.addColorStop(0, c); gr.addColorStop(1, 'hsla(0,0%,0%,0)'); g.fillStyle = gr; g.fillRect(x - r, y - r, r * 2, r * 2); };
  const frame = () => {
    if (!cv.isConnected) return;
    if (!cv.clientWidth || evoEl().hidden) { setTimeout(frame, 500); return; }
    requestAnimationFrame(frame);
    const dpr = Math.min(2, window.devicePixelRatio || 1), cw = Math.round(cv.clientWidth * dpr), ch = Math.round(cv.clientWidth * H / W * dpr);
    if (cv.width !== cw || cv.height !== ch) { cv.width = cw; cv.height = ch; }
    const t = performance.now() / 1000, N = EVO.night || N0, sh = EVO.sheet && sh0 && EVO.sheet.id === sh0.id ? EVO.sheet : sh0, done = {};
    ((sh && sh.songs) || []).forEach(e => { done[e.n] = e; });
    const cur = /song (\d+) of/.exec(N.msg || ''), carv = /“([^”]+)”/.exec(N.phase === 'chiselling' ? N.msg || '' : ''), au = audioLevels(), lv = au ? au.level : 0;
    g.setTransform(cw / W, 0, 0, cw / W, 0, 0); g.globalCompositeOperation = 'source-over'; g.clearRect(0, 0, W, H); g.globalCompositeOperation = 'lighter';
    const B = [], F = [], rgb = (hu, l = .6) => hsl2rgb(hu, .95, l);
    if (!GL) for (const s of stars) { g.fillStyle = `rgba(190,200,255,${.12 + .2 * (.5 + .5 * Math.sin(t * .8 + s[3]))})`; g.beginPath(); g.arc(s[0], s[1], s[2], 0, 7); g.fill(); }
    const glow = {}; who.forEach(c => { glow[c] = 0; });
    const state = ideas.map((x, i) => { const e = done[i + 1], making = N.running && N.phase !== 'chiselling' && cur && +cur[1] === i + 1; return { e, st: e && e.path ? 'done' : making ? 'making' : 'wait', carving: !!(carv && carv[1] === x.title), playing: !!(e && e.path && LIB.playing === e.path) }; });
    /* filaments, and the light that runs along them */
    ideas.forEach((x, i) => { const [px, py, cs] = pos[i], s = state[i], on = hot === i;
      cs.forEach((c, k) => {
        if (s.st === 'making') glow[c] += .5; if (s.carving) glow[c] += .3; if (s.playing) glow[c] += .3 + lv;
        if (GL) { const sp = s.st === 'making' ? .3 : s.carving ? .7 : s.playing ? -.4 : 0;
          F.push([P[c][0], P[c][1], px, py, ...rgb(L[c].hue, .62), (s.st === 'wait' ? .12 : s.st === 'making' ? .9 : s.playing ? .7 + lv * .6 : .34) + (on ? .6 : 0), (hash('b' + (i * 7 + k)) - .5) * .3, hash('f' + i + '.' + k), sp, sp ? (s.playing ? .5 + lv * 1.5 : 1) : 0]); return; }
        const pts = fil(P[c], [px, py], t, i * 7 + k), a = s.st === 'wait' ? .05 : s.st === 'making' ? .5 : s.playing ? .45 + lv * .4 : .16;
        g.beginPath(); pts.forEach((p, q) => q ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1])); g.strokeStyle = col(c, 62, Math.min(1, a + (on ? .4 : 0))); g.lineWidth = s.st === 'making' || s.playing ? 1.5 : 1; g.stroke();
        if (s.st === 'making') for (let b = 0; b < 3; b++) { const p = along(pts, (t * .32 + b / 3 + k * .11) % 1); dot(p[0], p[1], 9, col(c, 78, .95)); }
        if (s.carving) { const p = along(pts, (t * .7 + k * .3) % 1); dot(p[0], p[1], 7, 'rgba(230,250,255,.9)'); }
        if (s.playing) for (let b = 0; b < 2; b++) { const p = along(pts, 1 - (t * .45 + b / 2 + k * .17) % 1); dot(p[0], p[1], 6 + lv * 8, col(c, 80, .8)); } }); });
    /* the creatures */
    who.forEach((c, i) => { const [x, y] = P[c], lk = L[c], sd = hash(c + 'seed'), e = .95 + Math.min(.6, glow[c] * .5) + .08 * Math.sin(t * .9 + i), R = 46 * (1 + .05 * Math.sin(t * .7 + i * 2) + Math.min(.2, glow[c] * .12));
      if (GL) B.push([x, y, R * 1.1, e * .9, lk.plan | 0, sd, -Math.PI / 2 + sd * 6.28 + Math.sin(t * .2 + sd * 9) * .25, 7, ...rgb(lk.hue), 0, ...rgb(lk.hue2, .62), 0]);
      else { nightGlow(g, x, y, R, lk.hue, lk.hue2, t, sd, e); nightForm(g, x, y, R, lk.plan | 0, lk.hue, lk.hue2, t, sd, -Math.PI / 2 + sd * 6.28, 7, e); } });
    /* the pieces */
    ideas.forEach((x, i) => { const [px, py, cs] = pos[i], s = state[i], on = hot === i, sd = hash(x.title), k = cs.length || 1;
      if (s.st === 'wait') {
        if (GL) B.push([px, py, 13, on ? .9 : .42, -1, sd, 0, 7, ...rgb(L[cs[0]].hue), 0, ...rgb(L[cs[k - 1]].hue), 0]);
        else for (let m = 0; m < 5; m++) { const a = t * (.25 + m * .06) + m * 1.3 + sd * 6, c = cs[m % k]; dot(px + Math.cos(a) * (5 + m * 1.6), py + Math.sin(a * 1.2) * (4 + m), 3.2, col(c, 70, on ? .8 : .35)); } }
      else if (s.st === 'making') { const R = 15 + 3 * Math.sin(t * 5);
        if (GL) cs.forEach((c, q) => B.push([px, py, 26 + 5 * Math.sin(t * 5 + q), .75 + .25 * Math.sin(t * 7 + q * 2), L[c].plan | 0, sd + q * .21, q / k * 6.2832 + t * .6, k === 1 ? 7 : 6.2832 / k * .8, ...rgb(L[c].hue), 1, ...rgb(L[c].hue2, .62), .5 + .5 * Math.sin(t * 9)]));
        else { cs.forEach((c, q) => { nightGlow(g, px + noise(t * 2.3 + q * 9) * 5, py + noise(t * 2.1 + q * 4 + 3) * 5, R * .8, L[c].hue, L[c].hue2, t * 4, sd + q * .3, .9); nightForm(g, px, py, R * (.5 + .5 * Math.abs(noise(t * 1.4 + q * 5))), L[c].plan | 0, L[c].hue, L[c].hue2, t * 3, sd, q / k * 6.2832 + t * .6, 6.2832 / k * .7, .5 + .5 * Math.abs(noise(t * 3 + q))); });
          dot(px, py, 10 + 5 * Math.sin(t * 7), 'rgba(255,255,255,.75)'); } }
      else { const score = (s.e.score || {}).total || .5, beat = Math.exp(-((t * (x.bpm || 120) / 60) % 1) * 5), R = ((GL ? 17 : 13) + (GL ? 10 : 9) * score) * (1 + .1 * beat + (s.playing ? lv * .5 : 0) + (on ? .12 : 0)), e = .8 + .3 * beat + (s.playing ? .4 : 0);
        cs.forEach((c, q) => { const a0 = Math.atan2(P[c][1] - py, P[c][0] - px);
          if (GL) B.push([px, py, R, e * (k > 1 ? .6 : .75), L[c].plan | 0, sd + q * .21, k === 1 ? a0 + Math.PI : a0, k === 1 ? 7 : Math.min(1.7, 5.4 / k), ...rgb(L[c].hue), 0, ...rgb(L[c].hue2, .62), beat / k]);
          else { nightGlow(g, px + Math.cos(a0) * R * .25, py + Math.sin(a0) * R * .25, R * .62, L[c].hue, L[c].hue2, t, sd + q * .3, e * .8); nightForm(g, px, py, R, L[c].plan | 0, L[c].hue, L[c].hue2, t, sd + q * .21, k === 1 ? a0 + Math.PI : a0, k === 1 ? 7 : Math.min(1.5, 5 / k), e); } });
        if (!GL) dot(px, py, 5 + 4 * beat, `rgba(255,255,255,${.6 + .4 * beat})`);
        const orbit = GL ? R * .9 + 8 : R + 7;
        (s.e.carving || []).forEach((c, q) => { const a = q * .7 + t * .3; dot(px + Math.cos(a) * orbit, py + Math.sin(a) * orbit, c.kept ? 5 : 2.8, c.by && L[c.by] ? col(c.by, 75, c.kept ? .95 : .4) : `rgba(255,255,255,${c.kept ? .95 : .3})`); });
        g.shadowColor = 'rgba(120,240,255,.9)'; g.shadowBlur = 12;
        if (s.playing && au) { g.beginPath(); for (let q = 0; q <= 96; q++) { const a = q / 96 * 6.2832, r = R + 14 + au.wave[(q * 5) % 512] * 14; q ? g.lineTo(px + Math.cos(a) * r, py + Math.sin(a) * r) : g.moveTo(px + Math.cos(a) * r, py + Math.sin(a) * r); } g.closePath(); g.strokeStyle = 'rgba(46,230,214,.6)'; g.lineWidth = 1; g.stroke(); }
        if (s.carving) { const tick = Math.floor(t / .28), fr = (t / .28) % 1;
          for (let b = 0; b < 2; b++) { const a = hash('l' + tick + b) * 6.2832, sx = px + Math.cos(a) * 80, sy = py + Math.sin(a) * 60; g.beginPath(); g.moveTo(sx, sy);
            for (let q = 1; q < 7; q++) g.lineTo(sx + (px - sx) * q / 7 + (hash('j' + tick + b + q) - .5) * 16, sy + (py - sy) * q / 7 + (hash('k' + tick + b + q) - .5) * 16); g.lineTo(px, py); g.strokeStyle = `rgba(215,245,255,${.9 * (1 - fr)})`; g.lineWidth = 1.1; g.stroke(); }
          dot(px, py, 22 * (1 - fr) + 6, 'rgba(220,245,255,.6)'); }
        g.shadowBlur = 0; }
    });
    if (GL) nightPaint(GL, Math.round(cw * .75), Math.round(ch * .75), t, B, F, sky);
    /* words */
    g.globalCompositeOperation = 'source-over'; g.textAlign = 'center'; g.shadowColor = 'rgba(4,4,12,.95)'; g.shadowBlur = 5;
    who.forEach(c => { const [x, y] = P[c]; g.font = `600 12px ${mono}`; g.fillStyle = col(c, 76, .95); g.fillText(c.replace(/-/g, ' ').toUpperCase().split('').join(' '), x, y + (y > cy ? 74 : -62)); });
    const taken = who.map(c => [P[c][0], P[c][1] + (P[c][1] > cy ? 74 : -62), 110]);
    ideas.forEach((x, i) => { const [px, py] = pos[i], s = state[i], on = hot === i, r = s.st === 'wait' ? 10 : (GL ? 17 : 13) + (GL ? 10 : 9) * (((s.e || {}).score || {}).total || .5);
      g.font = `${on || s.playing ? 600 : 400} 10.5px ${mono}`; g.fillStyle = on || s.playing ? '#fff' : s.st === 'wait' ? 'rgba(120,116,150,.75)' : 'rgba(205,202,228,.92)'; { const nm = [...(x.name || x.title)], txt = on || s.playing || nm.length <= 18 ? nm.join('') : nm.slice(0, 17).join('') + '…', w = g.measureText(txt).width;
        const hit = (bx, by) => taken.some(q => Math.abs(q[0] - bx) < (q[2] + w) / 2 + 5 && Math.abs(q[1] - by) < 13);
        const spot = [[px, py + r + 16], [px, py - r - 9], [px, py + r + 30], [px, py - r - 23], [px + r + 8 + w / 2, py + 4], [px - r - 8 - w / 2, py + 4]].find(q => !hit(q[0], q[1])) || [px, py + r + 16];
        taken.push([spot[0], spot[1], w]); g.fillText(txt, spot[0], spot[1]); } });
    g.shadowBlur = 0;
    if (hot >= 0 && ideas[hot]) { const x = ideas[hot], e = done[hot + 1], cs = pos[hot][2], words = String(x.idea || '').split(' '), lines = ['']; words.forEach(w => { if ((lines[lines.length - 1] + ' ' + w).length > 44) lines.push(w); else lines[lines.length - 1] = (lines[lines.length - 1] + ' ' + w).trim(); });
      const head = `${String(hot + 1).padStart(2, '0')} · ${x.name || x.title} · ${x.bpm} bpm`, body = lines.slice(0, 5).map((l, q) => l + (q === 4 && lines.length > 5 ? '…' : '')), carved = e && e.carving && e.carving.length ? `${e.carving.filter(c => c.kept).length} of ${e.carving.length} carvings kept` : '';
      g.textAlign = 'left'; g.font = `600 12px ${mono}`; let bw = g.measureText(head).width; g.font = `10.5px ${mono}`; [cs.map(c => c.replace(/-/g, ' ')).join(' × '), ...body, carved].forEach(l => { bw = Math.max(bw, g.measureText(l).width); });
      const bh = 44 + body.length * 14 + (carved ? 16 : 0), bx = Math.min(W - bw - 30, Math.max(6, pos[hot][0] + 30)), by = Math.min(H - bh - 34, Math.max(6, pos[hot][1] - bh / 2));
      g.fillStyle = 'rgba(8,8,18,.9)'; g.strokeStyle = 'rgba(120,116,170,.5)'; g.lineWidth = 1; g.beginPath(); g.rect(bx, by, bw + 24, bh); g.fill(); g.stroke();
      g.font = `600 12px ${mono}`; g.fillStyle = '#fff'; g.fillText(head, bx + 12, by + 20);
      g.font = `10.5px ${mono}`; g.fillStyle = 'rgba(46,230,214,.95)'; g.fillText(cs.map(c => c.replace(/-/g, ' ')).join(' × '), bx + 12, by + 36);
      g.fillStyle = 'rgba(190,187,214,.9)'; body.forEach((l, q) => g.fillText(l, bx + 12, by + 52 + q * 14));
      if (carved) { g.fillStyle = 'rgba(150,146,180,.9)'; g.fillText(carved, bx + 12, by + 54 + body.length * 14); } }
    /* the night as a line: where it began, where it is now, where it ends */
    if (N.started && N.until) { const t0 = N.started, t1 = N.until, now = Math.min(t1, N.finished || Date.now() / 1000), X = v => 60 + (v - t0) / (t1 - t0) * (W - 120), hh = v => new Date(v * 1000).toTimeString().slice(0, 5), y = H - 14, live = N.phase === 'chiselling' ? '#2ee6d6' : '#a43cff';
      g.lineWidth = 2; g.strokeStyle = '#2a2a44'; g.beginPath(); g.moveTo(60, y); g.lineTo(W - 60, y); g.stroke(); g.strokeStyle = live; g.beginPath(); g.moveTo(60, y); g.lineTo(X(now), y); g.stroke();
      g.globalCompositeOperation = 'lighter'; dot(X(now), y, N.running ? 9 + 3 * Math.sin(t * 3) : 6, 'rgba(255,255,255,.95)'); g.globalCompositeOperation = 'source-over';
      g.font = `9.5px ${mono}`; g.fillStyle = '#6d6a88'; g.textAlign = 'left'; if (X(now) > 190) g.fillText(hh(t0), 60, y - 9); g.textAlign = 'right'; g.fillText(hh(t1), W - 60, y - 9);
      g.textAlign = 'center'; g.fillStyle = '#e9e7f5'; g.fillText(N.running ? (N.phase === 'chiselling' ? 'chiselling' : `making ${N.made}/${N.count}`) : 'finished', Math.min(W - 150, Math.max(110, X(now))), y - 9); }
  };
  requestAnimationFrame(frame);
  return box;
}
/* The conversation about taste. The program cannot hear, so it asks: one question at a time, with things to tap and room
   for your own words. After every answer it writes down again what it now believes, where you can read it and tell it
   that it is wrong. That understanding is what the next night's plans and carvings are written from. */
async function evoTalkDo(fn) {
  if (EVO.talkBusy) return;
  EVO.talkBusy = true; evoDraw();
  try { EVO.taste = await fn(); EVO.talkPicks = new Set(); EVO.talkText = ''; } catch (e) { toast(String(e.message || e), true); }
  EVO.talkBusy = false; evoDraw();
}
const evoAsk = n => evoTalkDo(() => api('/api/night/question', { json: { id: EVO.night.id, n: n || 0 } }));
function evoTalk(sh) {
  const T = EVO.taste; if (!T) return null;
  const q = T.asked, picks = EVO.talkPicks ||= new Set(), byN = {}, id = EVO.night.id; ((sh && sh.songs) || []).forEach(e => { byN[e.n] = e; });
  const name = n => { const x = ((sh && sh.ideas) || [])[n - 1]; return x ? (x.name || x.title) : 'piece ' + n; };
  const ta = h('textarea', { rows: 2, placeholder: EVO.fixing ? 'What did I get wrong?' : 'or in your own words…', oninput: e => { EVO.talkText = e.target.value; },
    onblur: () => setTimeout(() => { if (EVO.stale && !EVO.talkBusy && !(document.activeElement && document.activeElement.tagName === 'TEXTAREA' && document.activeElement.closest('.night-talk'))) { EVO.stale = false; evoDraw(); } }, 600) }); ta.value = EVO.talkText || '';
  const know = h('div', { class: 'talk-know' }, h('h4', {}, 'what I understand so far'),
    T.understanding.length ? h('ul', {}, T.understanding.map(u => h('li', {}, u))) : h('p', { class: 'gym-note' }, 'Nothing yet. Mark a piece “more” or “less”, or let me ask you something.'),
    T.understanding.length && !EVO.fixing && !EVO.talkBusy ? h('button', { class: 'talk-link', onclick: () => { EVO.fixing = true; EVO.talkText = ''; evoDraw(); } }, 'tell me something, or correct me…') : '');
  let ask;
  if (EVO.talkBusy) ask = h('p', { class: 'gym-note talk-think' }, 'thinking…');
  else if (EVO.fixing) ask = h('div', {}, h('h4', {}, 'tell me anything: what you hear in a piece, or what I got wrong'), ta,
    h('div', { class: 'acts' }, h('button', { class: 'hot', onclick: () => { const text = EVO.talkText || ''; if (!text.trim()) return toast('write what is wrong first', true); EVO.fixing = false; evoTalkDo(() => api('/api/night/answer', { json: { id, text, correction: true } })); } }, 'correct it'),
      h('button', { onclick: () => { EVO.fixing = false; EVO.talkText = ''; evoDraw(); } }, 'never mind')));
  else if (q) ask = h('div', {}, h('h4', {}, q.text),
    q.pieces.length ? h('div', { class: 'talk-pieces' }, q.pieces.filter(n => byN[n] && byN[n].path).map(n => h('span', { class: 'talk-piece' + (LIB.playing === byN[n].path ? ' playing' : '') },
      h('button', { class: 'evo-pp', data: { path: byN[n].path }, title: 'Play / stop', onclick: () => libPlay({ path: byN[n].path, kind: 'audio', size: 5e7 }) }), h('b', {}, name(n))))) : '',
    h('div', { class: 'talk-opts' }, q.options.map(o => h('button', { class: 'talk-opt' + (picks.has(o) ? ' on' : ''), onclick: e => { picks.has(o) ? picks.delete(o) : picks.add(o); e.currentTarget.classList.toggle('on'); } }, o))),
    ta,
    h('div', { class: 'acts' }, h('button', { class: 'hot', onclick: () => { if (!picks.size && !(EVO.talkText || '').trim()) return toast('tap an answer or write one', true);
        const body = { id, picks: [...picks], text: EVO.talkText || '' }; evoTalkDo(() => api('/api/night/answer', { json: body }).then(() => api('/api/night/question', { json: { id, n: 0 } }))); } }, 'answer'),
      h('button', { title: 'Skip this one and get a different question', onclick: () => evoAsk(0) }, 'ask me something else')));
  else ask = h('div', {}, h('p', { class: 'gym-note' }, T.answers ? `You have answered ${T.answers} question${T.answers === 1 ? '' : 's'}. I can keep asking.` : 'I can’t hear these, so I need to ask you about them.'),
    h('button', { class: 'hot', onclick: () => evoAsk(0) }, 'ask me something'));
  return h('div', { class: 'night-talk' }, know, h('div', { class: 'talk-ask' }, ask));
}
/* A rating belongs to the version you heard. When the piece has been changed since, the rating is shown as overtaken, so you know to listen again. */
async function evoStale(sh) {
  if (EVO.staleBusy || (EVO.staleAt && Date.now() - EVO.staleAt < 25000) || !EVO.marks || !sh) return; EVO.staleBusy = true; EVO.staleAt = Date.now();
  try { const all = await fetch(fileUrl(`${EVO.outRoot}/_night/marks.json`), { cache: 'no-store' }).then(r => r.ok ? r.json() : {}), out = {};
    for (const e of sh.songs || []) { const m = all[`${sh.id}:${e.n}`]; if (!m || !e.path || !(EVO.marks[e.n] > 0)) continue;
      const rated = m.at ? m.at * 1000 : new Date(String(m.when).replace(' ', 'T')).getTime() + 59000;
      const lm = await fetch(fileUrl(e.path), { headers: { Range: 'bytes=0-0' }, cache: 'no-store' }).then(r => r.headers.get('last-modified')).catch(() => null);
      if (lm && new Date(lm).getTime() > rated + 5000) out[e.n] = true; }
    const was = JSON.stringify(EVO.staleMarks || {}); EVO.staleMarks = out; if (JSON.stringify(out) !== was) EVO.stale = true;
  } catch (e) {} finally { EVO.staleBusy = false; }
}
/* How much you like a piece, 1 to 5. Nothing can measure taste, so this is what the carving and the next night steer by.
   Rate as many as you like in a row: the question about why comes once you pause, about the last one you rated. */
async function evoMarkPiece(n, v) {
  try { const N = EVO.night || {}, cur = (EVO.marks || {})[n] || 0, old = (EVO.staleMarks || {})[n];
    if (old && cur === v) { await api('/api/night/mark', { json: { id: N.id, n, mark: 0 } }); }      // tapping an overtaken rating again confirms it for the piece as it is now
    EVO.marks = await api('/api/night/mark', { json: { id: N.id, n, mark: old ? v : (cur === v ? 0 : v) } }); if (EVO.staleMarks) delete EVO.staleMarks[n]; EVO.staleAt = 0; evoDraw();
    clearTimeout(EVO.askT);
    if (cur !== v && EVO.taste) EVO.askT = setTimeout(() => { if (EVO.talkBusy || (document.activeElement && document.activeElement.closest && document.activeElement.closest('.night-talk'))) return; EVO.fixing = false; evoAsk(n); }, 6000);
  } catch (e) { toast(e.message, true); }
}
/* ---------- albums: what each finished loop came to, kept as it sounded then ---------- */
const albUrl = (a, name) => `/api/night/albumfile?album=${encodeURIComponent(a)}&name=${encodeURIComponent(name)}`;
/* A picture grown from the pieces themselves: every piece is the merged body of the creatures that play it, in their own
   colours and forms, drawn by the same shader as the night. One piece fills its cover; an album shows all of its pieces. */
function evoCoverBlob(pieces, title, sub, cid) {
  const G = nightGL(); if (!G || !pieces.length) return Promise.resolve(null);
  const S = 1200, one = pieces.length === 1, B = [], F = [], at = [], rgb = (hu, l = .6) => hsl2rgb(hu, .95, l);
  const sky = nightLook(cid);
  const look = c => { const x = (EVO.creatures || []).find(q => q.slug === c), k = (x && x.look) || { plan: Math.floor(hash(c + 'p') * 6), hue: hash(c) * 360, hue2: hash(c + '2') * 360 }; return sky.hue ? { ...k, hue: sky.hue(k.hue), hue2: sky.hue2(k.hue2) } : k; };
  pieces.forEach((p, i) => {
    const key = p.name || String(p.n), sd = hash(key + 'c'), cs = (p.creatures && p.creatures.length) ? p.creatures : ['void'], k = cs.length;
    const ang = i * 2.39996 + hash(title) * 6.2832, rad = one ? 0 : 70 + 340 * Math.sqrt((i + .5) / pieces.length), px = 500 + Math.cos(ang) * rad, py = (one ? 470 : 480) + Math.sin(ang) * rad * .9, R = one ? 230 : 46 + 24 * hash(key + 'r');
    at.push([px, py, cs]);
    cs.forEach((c, q) => { const L = look(c), a0 = q / k * 6.2832 + sd * 6.2832;
      if (B.length < 96) B.push([px, py, R, (k > 1 ? .62 : .78) + (one ? .12 : 0), L.plan | 0, sd + q * .21, a0, k === 1 ? 7 : Math.min(1.7, 5.4 / k), ...rgb(L.hue), 0, ...rgb(L.hue2, .62), hash(key + q) * .6 / k]); });
    if (one) for (let j = 0, m = 9 + Math.floor(hash(key + 'm') * 8); j < m; j++) {
      const a = j * 2.39996 + hash(key + 'a') * 6.2832, r = R * (1.25 + ((j * .381966 + hash(key + 'd')) % 1) * .95), x = px + Math.cos(a) * r, y = py + Math.sin(a) * r * .95, L = look(cs[j % k]);
      B.push([x, y, 16 + ((j * .618034 + hash(key + 's')) % 1) * 20, .5 + hash(key + 'e' + j) * .4, -1, hash(key + j), 0, 7, ...rgb(L.hue), 0, ...rgb(look(cs[(j + 1) % k]).hue2), 0]);
      F.push([px, py, x, y, ...rgb(L.hue, .62), .34 + hash(key + 'i' + j) * .4, (hash('b' + key + j) - .5) * .6, hash('f' + key + j), j % 3 ? 0 : .5, j % 3 ? 0 : 1]); } });
  if (!one) at.forEach(([x, y, cs], i) => { const nx = at.slice(i + 1).find(o => o[2].some(c => cs.includes(c))) || at[(i + 1) % at.length];      // threads run between pieces that share a creature
    if (F.length < 48 && nx) F.push([x, y, nx[0], nx[1], ...rgb(look(cs[0]).hue, .62), .42, (hash('b' + i) - .5) * .5, hash('f' + i + title), i % 4 ? 0 : .5, i % 4 ? 0 : 1]); });
  nightPaint(G, S, S, 40 + hash(title + (one ? pieces[0].n : 'album')) * 900, B, F, sky);
  const c2 = document.createElement('canvas'); c2.width = c2.height = S; const g = c2.getContext('2d'); g.drawImage(G.canvas, 0, 0);
  const shade = g.createLinearGradient(0, S - 260, 0, S); shade.addColorStop(0, 'rgba(4,4,10,0)'); shade.addColorStop(1, 'rgba(4,4,10,.82)'); g.fillStyle = shade; g.fillRect(0, S - 260, S, 260);
  const mono = 'ui-monospace, "SF Mono", Menlo, "Hiragino Sans", "Geeza Pro", monospace';
  g.textBaseline = 'alphabetic'; g.fillStyle = 'rgba(255,255,255,.94)'; g.font = `600 ${one ? 40 : 46}px ${mono}`; g.fillText(title, 60, S - 96, S - 120);
  g.fillStyle = 'rgba(255,255,255,.56)'; g.font = `22px ${mono}`; g.fillText(sub, 60, S - 56, S - 120);
  return new Promise(res => c2.toBlob(res, 'image/jpeg', .92));
}
/* Albums that have no pictures yet get them, a piece at a time, whenever this screen has the chance. */
async function evoCovers() {
  if (EVO.coversBusy) return; EVO.coversBusy = true;
  try { let A = await fetch('/api/night/albums', { cache: 'no-store' }).then(r => r.ok ? r.json() : null); if (!A) return;
    const had = JSON.stringify(EVO.albums || null); EVO.albums = A; if (EVO.open && had !== JSON.stringify(A)) EVO.stale = true;
    for (const a of A) { const todo = [...(a.cover ? [] : [0]), ...a.pieces.filter(p => !p.cover).map(p => p.n)]; if (!todo.length) continue; if (!nightGL()) break;
      if (a.collection && !(EVO.dirs || {})[a.collection]) { try { const sh = await fetch(fileUrl(`${EVO.outRoot}/_night/${a.collection}/collection.json`), { cache: 'no-store' }).then(r => r.ok ? r.json() : null); if (sh) nightLook(a.collection, sh.direction || ' '); } catch (e) {} }   // the album's pictures are drawn under its run's own sky
      for (const n of todo) { const p = a.pieces.find(x => x.n === n);
        const blob = await evoCoverBlob(n ? [p] : a.pieces, n ? p.name : a.title, n ? `${String(n).padStart(2, '0')} · ${(p.creatures || []).join(' × ').replace(/-/g, ' ')} · ${a.title}` : `album ${a.n} · ${a.pieces.length} pieces · ${(a.kept || '').slice(0, 10)}`, a.collection); if (!blob) break;
        await fetch(`/api/night/cover?album=${encodeURIComponent(a.folder)}&n=${n}`, { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: blob }); await new Promise(r => setTimeout(r, 40)); }
      EVO.albums = await api('/api/night/albums'); EVO.stale = true; }
    if (EVO.open && EVO.stale && !(document.activeElement && document.activeElement.tagName === 'TEXTAREA')) evoDraw();
  } catch (e) { console.warn('covers: ' + e.message); } finally { EVO.coversBusy = false; }
}
/* Carve a run further. Any run can be taken up again, from its album or from its own page; its album follows it. */
function evoCarveOn(id) {
  const hrs = h('input', { type: 'number', min: .5, max: 12, step: .5, value: EVO.carveH || 3, title: 'Hours of carving', oninput: e => { EVO.carveH = +e.target.value || 3; } });
  const busy = EVO.live && EVO.live.running;
  return h('div', { class: 'acts carve-on' }, h('button', { class: 'hot', disabled: !!busy, title: busy ? 'Another run is going. Stop it first, or wait until it ends.' : 'Takes this run up again: its pieces are carved further, and its album is brought up to date when the carving ends.',
    onclick: async () => { try { EVO.viewId = null; EVO.album = null; EVO.showNight = true; EVO.night = await api('/api/night/resume', { json: { id, hours: +hrs.value || 3 } }); EVO.sheet = null; evoDraw(); evoNightPoll(); toast('carving on: leave Zvoid open'); } catch (e) { toast(e.message, true); } } }, 'carve this run further'),
    h('span', { class: 'gym-note' }, 'for'), hrs, h('span', { class: 'gym-note' }, busy ? 'hours · another run is going now' : 'hours'));
}
function evoAlbumView(a) {
  const v = Date.now() - Date.now() % 60000, pic = (name, cls) => h('img', { class: cls, src: albUrl(a.folder, name) + '&v=' + v, alt: '', loading: 'lazy' });
  return h('div', { id: 'evo-main' },
    h('div', { class: 'alb-head' }, a.cover ? pic('cover.jpg', 'alb-cover') : h('div', { class: 'alb-cover' }),
      h('div', {}, h('small', {}, `album ${a.n} · as the run stood on ${a.kept || ''}`), h('h2', {}, a.title), h('p', { class: 'gym-note' }, `${a.pieces.length} pieces · played by ${(a.creatures || []).join(', ').replace(/-/g, ' ')}`), a.note ? h('p', { class: 'gym-note' }, a.note) : '',
        h('p', { class: 'gym-note' }, 'An album is what its run had come to the last time its carving ended. The run itself lives on: open it to see every piece as it is now, rate it and answer questions about it, or carve it further, and the album follows.'),
        h('div', { class: 'acts' }, a.collection ? h('button', { onclick: async () => { EVO.viewId = a.collection; EVO.album = null; EVO.showNight = true; EVO.sheet = null; await evoNightPoll(); evoDraw(); } }, 'open its run') : '',
          h('button', { onclick: () => api('/api/night/albums', { json: { album: a.folder } }).catch(e => toast(e.message, true)) }, 'show in Finder'),
          h('button', { onclick: async () => { EVO.viewId = null; EVO.album = null; EVO.showNight = true; EVO.sheet = null; await evoNightPoll(); evoDraw(); } }, EVO.live && EVO.live.running ? '← back to the run that is going' : '← back')),
        a.collection ? evoCarveOn(a.collection) : '')),
    h('div', { class: 'alb-list' }, a.pieces.map(p => { const path = 'album:' + a.folder + '/' + p.file;
      return h('div', { class: 'night-row alb-row' + (LIB.playing === path ? ' playing' : '') }, h('span', { class: 'night-n' }, String(p.n).padStart(2, '0')),
        h('button', { class: 'evo-pp', data: { path }, title: 'Play / stop', onclick: () => libPlay({ path, url: albUrl(a.folder, p.file), kind: 'audio', size: 5e7 }) }, LIB.playing === path ? '■' : '▶'),
        p.cover ? pic(p.file.replace(/\.[a-z0-9]+$/i, '.jpg'), 'alb-thumb') : h('span', { class: 'alb-thumb' }),
        h('div', {}, h('b', {}, p.name), h('small', {}, (p.creatures || []).join(' × ').replace(/-/g, ' ') + (p.rating ? ` · rated ${p.rating} of 5` : '')), h('p', { class: 'gym-note' }, p.idea || ''))); })));
}

function evoNightView() {                               // tonight, piece by piece: who plays it, what it is, and where it has got to
  const N = EVO.night || {}, sh = EVO.sheet && EVO.sheet.id === N.id ? EVO.sheet : null, ideas = (sh && sh.ideas) || [], done = {}, cur = /song (\d+) of/.exec(N.msg || '');
  ((sh && sh.songs) || []).forEach(e => { done[e.n] = e; });
  const who = x => [x.creature, ...(x.mix || [])].map(c => c.replace(/-/g, ' ')).join(' × ');
  const until = N.until ? new Date(N.until * 1000).toTimeString().slice(0, 5) : '';
  return h('div', { id: 'evo-main' },
    h('div', { class: 'evo-head' }, h('h2', {}, N.tag || 'the night'), h('small', {}, N.running ? (N.phase === 'chiselling' ? `chiselling until ${until} · ${N.carved} carvings kept of ${N.carves} tried` : `making the pieces · ${N.made} of ${N.count} · then chiselling until ${until}`) : (N.msg || 'finished'))),
    N.running ? h('p', { class: 'gym-note', id: 'night-msg' }, N.msg || '') : null,
    (() => { const al = (EVO.albums || []).find(q => q.collection === N.id);
      return h('p', { class: 'gym-note' }, 'This is the run itself: its pieces as they sound right now. ', al ? h('button', { class: 'talk-link', onclick: () => { EVO.album = al.folder; evoDraw(); } }, `Its album: ${al.title}`) : (N.running ? 'It becomes an album when its carving ends.' : '')); })(),
    !N.running && N.id ? evoCarveOn(N.id) : null,
    ideas.length ? evoNightMap(N, sh) : null,
    ideas.length && EVO.taste ? evoTalk(sh) : null,
    !ideas.length ? h('div', { class: 'evo-empty' }, N.running ? 'Writing the ideas…' : 'No night has been run yet. Start one on the left.') :
    h('div', { class: 'night-list' }, ideas.map((x, i) => { const n = i + 1, e = done[n], path = e && e.path, making = N.running && N.phase !== 'chiselling' && cur && +cur[1] === n, kept = e ? (e.carving || []).filter(c => c.kept).length : 0, tried = e ? (e.carving || []).length : 0;
      return h('div', { class: 'night-row' + (path ? ' done' : making ? ' making' : '') + (path && LIB.playing === path ? ' playing' : '') },
        h('span', { class: 'night-n' }, String(n).padStart(2, '0')),
        path ? h('button', { class: 'evo-pp', data: { path }, title: 'Play / stop', onclick: () => libPlay({ path, kind: 'audio', size: 5e7 }) }, LIB.playing === path ? '■' : '▶') : h('span', { class: 'night-dot' }, making ? '◌' : '·'),
        h('div', { class: 'night-what' }, h('b', {}, x.name || x.title, h('em', {}, `${x.bpm} bpm`)), h('small', { class: 'night-who' }, who(x)), h('small', { title: x.idea }, x.idea)),
        path ? libWave({ path, kind: 'audio', size: 5e7 }) : h('span', { class: 'night-wait' }, making ? 'being made now…' : 'waiting'),
        h('small', { class: 'night-carve', title: tried ? (e.carving || []).map(c => `${c.kept ? 'kept' : 'not kept'}: ${c.from}–${c.to}s${c.by ? ' by ' + c.by : ''} · ${c.why || ''}`).join('\n') : '' }, tried ? `${kept} of ${tried} carvings kept` : ''),
        path && EVO.marks ? h('span', { class: 'night-marks' + ((EVO.staleMarks || {})[n] ? ' old' : ''), title: ((EVO.staleMarks || {})[n] ? 'This piece has changed since you rated it. Listen again, then tap a number (the same one, if it still holds). · ' : '') + 'How much do you like it? 1: not this at all · 3: fine, but not it · 5: this is the direction (not the end goal). Tap the same number again to clear it.' },
          [1, 2, 3, 4, 5].map(v => h('button', { class: 'night-mark r' + v + ((EVO.marks[n] || 0) >= v ? ' on' : '') + (EVO.marks[n] === v ? ' at' : ''), onclick: () => evoMarkPiece(n, v) }, String(v)))) : h('span', {})); })));
}
function evoMark() { document.querySelectorAll('#evo .evo-pp').forEach(b => { const on = b.dataset.path === LIB.playing; b.textContent = on ? '■' : '▶'; const box = b.closest('.evo-card, .evo-step, .night-row, .talk-piece'); if (box) box.classList.toggle('playing', on); }); }

function evoCard(n, opts) {
  const it = evoIt(n.path), live = EVO.s.live;
  return h('div', { class: 'evo-card' + (LIB.playing === n.path ? ' playing' : '') + (opts.cur ? ' cur' : ''), data: { node: n.id } },
    h('div', { class: 'evo-top' }, h('button', { class: 'evo-pp', data: { path: n.path }, title: 'Play / stop (space pauses)', onclick: () => libPlay(it) }, LIB.playing === n.path ? '■' : '▶'),
      h('b', {}, opts.label || n.step || 'sound'), h('small', {}, (n.ideas || []).join(' · ') || (n.round ? 'the parent, lightly changed' : n.what))),
    libWave(it),
    h('div', { class: 'evo-acts' },
      opts.pick && h('button', { class: 'hot', disabled: !!live, title: 'This one lives: it becomes the parent of the next round', onclick: () => evoPick(n.id, true) }, 'pick ▸'),
      opts.back && h('button', { disabled: !!live, title: 'Go back to this sound and grow a different branch from it', onclick: () => evoPick(n.id, false) }, 'grow from here'),
      h('button', { title: n.kept ? 'Already in the library' : 'Put this sound in the library', disabled: !!n.kept, onclick: () => evoKeep(n.id) }, n.kept ? 'kept ✓' : 'keep')));
}
function evoDraw() {
  const el = evoEl(); if (!EVO.open) return;
  EVO.stale = false;
  const s = EVO.s, trained = EVO.creatures.filter(c => c.trained), fed = EVO.creatures.filter(c => c.food && c.food.length);
  const from = h('select', {}, fed.map(c => h('option', { value: c.slug }, c.name)));
  const left = h('div', { id: 'evo-left' },
    h('div', { class: 'drawer-head' }, h('span', {}, 'evolve'), h('button', { onclick: closeEvo, title: 'Back to the canvas (esc)' }, '← canvas')),
    h('p', { class: 'gym-note' }, 'Breed a sound. Each round makes four mutations of the current one. Pick the one that is most alive and it becomes the parent of the next round.'),
    h('h3', {}, 'start a new one'),
    fed.length ? h('div', { class: 'acts', id: 'evo-new' }, from, h('button', { title: 'Begin from a passage of one of this creature\'s own tracks', onclick: () => evoStart({ creature: from.value, direction: (s && s.direction) || 'primal music of the future' }) }, 'from its tracks ▸')) : null,
    h('p', { class: 'gym-note' }, 'Or open the library and press “evolve” on any clip.'),
    h('h3', {}, 'night shift'),
    h('p', { class: 'gym-note' }, 'Leave it running and wake up to a collection. Every song starts as its own idea, is made, measured, rewritten and made again; only the finished songs reach the library.'),
    evoNightBox(trained, s),
    h('h3', {}, 'sessions'),
    h('div', { class: 'evo-list' }, EVO.list.length ? EVO.list.map(x => h('button', { class: 'evo-row' + (s && x.id === s.id && !EVO.showNight ? ' cur' : ''), onclick: async () => { EVO.showNight = false; EVO.s = await api('/api/evolve/' + x.id); evoDraw(); evoPoll(); } },
      h('b', {}, x.name), h('small', {}, `${x.rounds} round${x.rounds === 1 ? '' : 's'}${x.creature ? ' · ◍ ' + x.creature.replace(/-/g, ' ') : ''}${x.live ? ' · running' : ''}`),
      h('span', { class: 'evo-x', title: 'Move this session to the Trash', onclick: async e => { e.stopPropagation(); try { await api('/api/evolve/' + x.id, { method: 'DELETE' }); if (s && s.id === x.id) EVO.s = null; await evoList(); evoDraw(); } catch (er) { toast(String(er.message || er), true); } } }, '×')))
      : h('p', { class: 'gym-note' }, 'None yet.')));
  if (EVO.showNight == null) EVO.showNight = !!(EVO.night && EVO.night.id);
  const alb = EVO.album && (EVO.albums || []).find(x => x.folder === EVO.album);
  if (alb) { const keep = $('#evo-main') ? $('#evo-main').scrollTop : 0; el.replaceChildren(left, evoAlbumView(alb)); if (keep) $('#evo-main').scrollTop = keep; return; }
  if (EVO.showNight && EVO.night && EVO.night.id) { const keep = $('#evo-main') ? $('#evo-main').scrollTop : 0; el.replaceChildren(left, evoNightView()); if (keep) $('#evo-main').scrollTop = keep; return; }
  if (!s) { el.replaceChildren(left, h('div', { id: 'evo-main' }, h('div', { class: 'evo-empty' }, 'Start a session on the left, or press “evolve” on a clip in the library.'))); return; }
  const N = s.nodes, head = N[s.head], line = []; for (let n = head; n; n = N[n.parent]) line.unshift(n);
  const kids = Object.values(N).filter(n => n.parent === head.id).sort((a, b) => ['close', 'near', 'far', 'wild'].indexOf(a.step) - ['close', 'near', 'far', 'wild'].indexOf(b.step) || a.id.localeCompare(b.id));
  const live = s.live, dir = h('textarea', { rows: 2, spellcheck: 'false', placeholder: 'where it should head, in a few words: primal music of the future, ritual drums, voices that are not human', onchange: () => evoSave({ direction: dir.value }) }); dir.value = s.direction || '';
  const cre = h('select', { onchange: () => evoSave({ creature: cre.value }) }, h('option', { value: '' }, 'no creature (the plain model)'), trained.map(c => h('option', { value: c.slug }, c.name))); cre.value = s.creature || '';
  const main = h('div', { id: 'evo-main' },
    h('div', { class: 'evo-head' }, h('h2', {}, s.name), h('small', {}, `round ${head.round} · ${Object.keys(N).length - 1} sound${Object.keys(N).length === 2 ? '' : 's'} made`)),
    h('div', { class: 'evo-ctl' },
      h('label', {}, h('span', {}, 'direction'), dir),
      h('label', {}, h('span', {}, 'played through'), cre),
      h('label', { title: 'How far each round strays from its parent. Left: small careful steps. Right: big leaps and more strange ideas.' }, h('span', {}, 'steps: careful ↔ wild'), h('input', { type: 'range', min: 0, max: 1, step: .05, value: s.wild == null ? .5 : s.wild, onchange: e => evoSave({ wild: +e.target.value }) })),
      h('label', { class: 'evo-auto', title: 'When you pick one, the next round starts by itself' }, h('input', { type: 'checkbox', checked: EVO.auto, onchange: e => { EVO.auto = e.target.checked; } }), h('span', {}, 'keep going after a pick'))),
    h('h3', {}, 'its line so far'),
    h('div', { class: 'evo-line' }, line.map((n, i) => h('div', { class: 'evo-step' + (n.id === head.id ? ' head' : '') + (LIB.playing === n.path ? ' playing' : ''), data: { node: n.id } },
      h('button', { class: 'evo-pp', data: { path: n.path }, onclick: () => libPlay(evoIt(n.path)) }, LIB.playing === n.path ? '■' : '▶'),
      h('div', { class: 'evo-step-t' }, h('b', {}, n.round ? 'round ' + n.round : 'start'), h('small', {}, n.what || '')), libWave(evoIt(n.path)),
      n.id !== head.id ? h('button', { disabled: !!live, title: 'Go back to this sound and grow a different branch from it', onclick: () => evoPick(n.id, false) }, 'grow from here') : h('span', { class: 'evo-now' }, 'the parent now'),
      h('button', { title: n.kept ? 'Already in the library' : 'Put this sound in the library', disabled: !!n.kept, onclick: () => evoKeep(n.id) }, n.kept ? 'kept ✓' : 'keep')))),
    h('h3', {}, kids.length || live ? `round ${head.round + 1}: which one is most alive?` : 'next'),
    live ? h('div', { id: 'evo-live' }, h('span', {}, live.error ? 'it failed: ' + live.error : `round ${live.round} · ${live.msg}`), h('div', { class: 'evo-bar' }, h('i', { style: `width:${Math.round((live.done + (live.frac || 0)) / live.total * 100)}%` })),
      h('button', { onclick: () => api(`/api/evolve/${s.id}/stop`, { method: 'POST' }) }, '■ stop')) : null,
    h('div', { class: 'evo-cards' }, kids.map(n => evoCard(n, { pick: true }))),
    !live ? h('div', { class: 'acts evo-go' }, h('button', { class: kids.length ? '' : 'hot', onclick: evoRound }, kids.length ? 'none of these: make four more ▸' : 'make a round ▸')) : null);
  const keepAt = ['#evo-left', '#evo-main'].map(q => { const o = $(q); return [q, o ? o.scrollTop : 0]; });
  el.replaceChildren(left, main);
  keepAt.forEach(([q, y]) => { const o = $(q); if (o && y) o.scrollTop = y; });
}
$('#btn-evo').onclick = () => (EVO.open ? closeEvo() : openEvo());
evoNightPoll();
addEventListener('keydown', e => { if (e.key === 'Escape' && EVO.open && !/INPUT|TEXTAREA|SELECT/.test((document.activeElement || {}).tagName || '')) closeEvo(); });

/* ---------- the player: what is playing, where in it you are, how long it is, and a bar to move through it ---------- */
const evoClock = t => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
function evoTitleOf(path) {
  if (!path) return ['', ''];
  if (path.startsWith('album:')) { for (const a of EVO.albums || []) for (const p of a.pieces) if (path === 'album:' + a.folder + '/' + p.file) return [p.name, `${a.title} · ${(p.creatures || []).join(' × ').replace(/-/g, ' ')}`]; }
  const sh = EVO.sheet; if (sh) { const e = (sh.songs || []).find(x => x.path === path); if (e) { const x = (sh.ideas || [])[e.n - 1] || {}; return [x.name || e.title, [e.creature, ...(e.mix || [])].join(' × ').replace(/-/g, ' ')]; } }
  const it = (LIB.items || []).find(x => x.path === path); return [it ? it.title : path.split('/').pop().replace(/\.[a-z0-9]+$/i, ''), ''];
}
/* What comes after (or before) a piece: the next one of its album, or of its run. An album plays through by itself. */
function evoNeighbour(path, step) {
  if (!path) return null;
  if (path.startsWith('album:')) { for (const a of EVO.albums || []) { const i = a.pieces.findIndex(p => path === 'album:' + a.folder + '/' + p.file), q = i < 0 ? null : a.pieces[i + step];
      if (q) return { path: 'album:' + a.folder + '/' + q.file, url: albUrl(a.folder, q.file), kind: 'audio', size: 5e7 }; if (i >= 0) return null; } return null; }
  const songs = ((EVO.sheet && EVO.sheet.songs) || []).filter(e => e.path).sort((x, y) => x.n - y.n), i = songs.findIndex(e => e.path === path), q = i < 0 ? null : songs[i + step];
  return q ? { path: q.path, kind: 'audio', size: 5e7 } : null;
}
function evoNext(path, step) { const it = EVO.open ? evoNeighbour(path, step) : null; if (it) { libPlay(it); return true; } return false; }
function evoPlayer() {
  let bar = document.getElementById('evo-player');
  if (!bar) {
    const fill = h('i'), track = h('div', { class: 'ep-track', title: 'Click anywhere to play from there' }, fill), now = h('span', { class: 'ep-time' }, '0:00'), len = h('span', { class: 'ep-time' }, '0:00');
    const pp = h('button', { class: 'ep-pp', title: 'Pause / play (space)' }, '❚❚'), name = h('b'), sub = h('small');
    const seek = e => { const [, d] = libPos(); if (!d || !LIB.p) return; const r = track.getBoundingClientRect(); libStart(clamp((e.clientX - r.left) / r.width, 0, .999) * d); };
    let drag = false; track.addEventListener('mousedown', e => { drag = true; seek(e); }); addEventListener('mousemove', e => { if (drag) seek(e); }); addEventListener('mouseup', () => { drag = false; });
    pp.onclick = () => { const p = LIB.p; if (!p) return; if (p.el) { p.el.paused ? p.el.play().catch(() => {}) : p.el.pause(); } else { libStop(); libMark(); } };
    const skip = step => () => { const was = LIB.playing; if (was && evoNeighbour(was, step)) { libStop(); evoNext(was, step); } };
    const prev = h('button', { class: 'ep-x', title: 'The piece before', onclick: skip(-1) }, '◀◀'), next = h('button', { class: 'ep-x', title: 'The next piece', onclick: skip(1) }, '▶▶');
    bar = h('div', { id: 'evo-player', hidden: true }, pp, h('div', { class: 'ep-what' }, name, sub), now, track, len, prev, next, h('button', { class: 'ep-x', title: 'Stop', onclick: () => { libStop(); libMark(); } }, '■'));
    bar._nav = [prev, next];
    document.body.append(bar);
    setInterval(() => {
      const on = !!(EVO.open && LIB.p && LIB.playing); bar.hidden = !on; document.body.classList.toggle('has-player', on); if (!on) return;
      const [t, d] = libPos(), [a, b] = evoTitleOf(LIB.playing);
      if (name.textContent !== a) name.textContent = a; if (sub.textContent !== b) sub.textContent = b;
      now.textContent = evoClock(t); len.textContent = d ? evoClock(d) : '–:––'; fill.style.width = (d ? clamp(t / d, 0, 1) * 100 : 0) + '%';
      pp.textContent = LIB.p.el && LIB.p.el.paused ? '▶' : '❚❚';
      bar._nav[0].disabled = !evoNeighbour(LIB.playing, -1); bar._nav[1].disabled = !evoNeighbour(LIB.playing, 1);
    }, 200);
  }
}
evoPlayer();

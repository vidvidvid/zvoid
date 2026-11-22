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
  const N = EVO.night || {}, box = h('div', { id: 'evo-night' });
  if (N.running) {
    const left = N.per && N.count > N.made ? ` · about ${Math.max(1, Math.round((N.count - N.made) * N.per / 60))} min left` : '';
    const until = N.until ? new Date(N.until * 1000).toTimeString().slice(0, 5) : '';
    box.append(h('div', { class: 'evo-night-msg' }, N.phase === 'chiselling' ? `chiselling the ${N.made} songs until ${until} · ${N.carved} carvings kept of ${N.carves} tried` : `${N.made} of ${N.count} songs made${left}`), h('div', { class: 'evo-bar' }, h('i', { style: `width:${Math.round(N.made / N.count * 100)}%` })),
      h('small', { title: N.msg || '' }, N.msg || ''), h('div', { class: 'acts' }, h('button', { class: EVO.showNight ? '' : 'hot', onclick: () => { EVO.showNight = true; evoDraw(); } }, 'show the pieces'), h('button', { title: 'It ends after the try it is on. Songs already finished stay in the library.', onclick: () => api('/api/night/stop', { method: 'POST' }).then(evoNightPoll) }, '■ stop')));
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
        try { EVO.night = await api('/api/night', { json: { creatures: [...EVO.nightWho], count: +cnt.value || 20, tries: +tr.value || 2, hours: +hrs.value || 0, direction: dir.value } }); evoDraw(); evoNightPoll(); toast('night shift started: leave Zvoid open'); } catch (e) { toast(String(e.message || e), true); } } }, 'make the collection ▸')),
      N.msg && N.finished ? h('small', { title: N.msg }, N.msg) : null,
      N.id ? h('div', { class: 'acts' }, h('button', { onclick: () => { EVO.showNight = true; evoDraw(); } }, 'show last night’s pieces')) : null);
  }
  return box;
}
async function evoNightPoll() {
  clearTimeout(EVO.nightT);
  try { const sig = n => JSON.stringify([n.running, n.made, n.thrown, n.phase, n.carves, (n.msg || '').split(' · now:')[0]]), was = sig(EVO.night || {}); EVO.night = await api('/api/night');
    if (EVO.night.id && (EVO.open || !EVO.sheet)) await evoSheet();
    const b = $('#btn-evo'); if (b) b.textContent = EVO.night.running ? (EVO.night.phase === 'chiselling' ? `⟲ evolve · chiselling` : `⟲ evolve · night ${EVO.night.made}/${EVO.night.count}`) : '⟲ evolve';
    if (EVO.open) { if (sig(EVO.night) !== was) evoDraw(); else { const m = document.querySelector('#evo-night small'); if (m && EVO.night.running) m.textContent = EVO.night.msg || ''; const m2 = $('#night-msg'); if (m2) m2.textContent = EVO.night.msg || ''; } } } catch (e) {}
  EVO.nightT = setTimeout(evoNightPoll, EVO.night && EVO.night.running ? 3000 : 20000);
}
async function evoSheet() {                              // the night's own notes: every piece it planned, what it tried, what it kept
  try {
    if (!EVO.outRoot) { const m = (LIB.items && LIB.items.length ? LIB.items : await api('/api/made')).find(x => x.path.includes('/outputs/')); if (m) EVO.outRoot = m.path.split('/outputs/')[0] + '/outputs'; }
    if (!EVO.outRoot) return;
    const r = await fetch(fileUrl(`${EVO.outRoot}/_night/${EVO.night.id}/collection.json`), { cache: 'no-store' }); if (r.ok) EVO.sheet = await r.json();
  } catch (e) {}
}
/* The night as a picture. The creatures stand in a ring, each in its own colour. Every piece is a small body drawn between
   the creatures that play it, tied to each by a thread: one creature, and it sits close to it; four, and it hangs in the
   middle. It is a faint outline while it waits, pulses while it is being made, and fills in when it is finished. Each
   carving leaves a mark in orbit round it: bright if it was kept, dim if not, and in a guest creature's colour when that
   creature did the carving. Click a finished piece to hear it. */
function evoNightMap(N, sh) {
  const NS = 'http://www.w3.org/2000/svg', el = (t, a, ...kids) => { const e = document.createElementNS(NS, t); for (const k in a) e.setAttribute(k, a[k]); kids.forEach(c => c != null && e.append(c)); return e; };
  const W = 1000, H = 470, cx = W / 2, cy = H / 2 - 6, ideas = (sh && sh.ideas) || [], who = (N.creatures || (sh && sh.creatures) || []), done = {}, cur = /song (\d+) of/.exec(N.msg || ''), carv = /“([^”]+)”/.exec(N.phase === 'chiselling' ? N.msg || '' : '');
  ((sh && sh.songs) || []).forEach(e => { done[e.n] = e; });
  const hue = c => { const x = EVO.creatures.find(q => q.slug === c); return x && x.look ? x.look.hue : (hash(c) * 360); }, col = (c, l = 62, a = 1) => `hsla(${hue(c)},90%,${l}%,${a})`;
  const P = {}; who.forEach((c, i) => { const a = -Math.PI / 2 + i / who.length * Math.PI * 2; P[c] = [cx + Math.cos(a) * 400, cy + Math.sin(a) * 178]; });
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'night-map' });
  const pos = ideas.map((x, i) => { const cs = [x.creature, ...(x.mix || [])].filter(c => P[c]), k = cs.length || 1, a = i * 2.39996, j = 26 + (i % 5) * 9;
    let px = cs.reduce((s, c) => s + P[c][0], 0) / k, py = cs.reduce((s, c) => s + P[c][1], 0) / k;
    if (k === 1) { px = cx + (px - cx) * .7; py = cy + (py - cy) * .7; }                           // a piece of one creature stays near it
    return [px + Math.cos(a) * j * (k === 1 ? 1.3 : 1), py + Math.sin(a) * j * .8, cs]; });
  for (let rep = 0; rep < 60; rep++) for (let i = 0; i < pos.length; i++) for (let j = i + 1; j < pos.length; j++) {     // nudge apart whatever lands on top of something else
    const dx = pos[j][0] - pos[i][0], dy = pos[j][1] - pos[i][1], d = Math.hypot(dx, dy) || 1; if (d < 46) { const f = (46 - d) / d / 2; pos[i][0] -= dx * f; pos[i][1] -= dy * f; pos[j][0] += dx * f; pos[j][1] += dy * f; }
    if (j === i + 1) for (const c in P) { const ex = pos[i][0] - P[c][0], ey = pos[i][1] - P[c][1], ed = Math.hypot(ex, ey) || 1; if (ed < 62) { pos[i][0] = P[c][0] + ex / ed * 62; pos[i][1] = P[c][1] + ey / ed * 62; } }     // and off the creatures themselves
    pos[i][0] = Math.min(W - 40, Math.max(40, pos[i][0])); pos[i][1] = Math.min(H - 60, Math.max(24, pos[i][1])); }
  const gT = el('g', {}), gN = el('g', {});
  ideas.forEach((x, i) => { const n = i + 1, e = done[n], [px, py, cs] = pos[i], making = N.running && N.phase !== 'chiselling' && cur && +cur[1] === n, carving = carv && carv[1] === x.title, st = e && e.path ? 'done' : making ? 'making' : 'wait';
    cs.forEach(c => gT.append(el('line', { x1: P[c][0], y1: P[c][1], x2: px, y2: py, stroke: col(c, 60, st === 'wait' ? .1 : st === 'making' ? .75 : .34), 'stroke-width': st === 'making' ? 1.6 : 1, class: st === 'making' || carving ? 'thread live' : 'thread' })));
    const r = st === 'done' ? 9 + 7 * ((e.score || {}).total || .5) : 9, g = el('g', { class: 'night-node ' + st + (carving ? ' carving' : '') + (e && e.path && LIB.playing === e.path ? ' playing' : ''), transform: `translate(${px},${py})` });
    cs.forEach((c, k) => { const a0 = k / cs.length * Math.PI * 2 - Math.PI / 2, a1 = (k + 1) / cs.length * Math.PI * 2 - Math.PI / 2;     // one slice per creature in it
      g.append(cs.length === 1 ? el('circle', { r, fill: st === 'wait' ? 'none' : col(c, 58, st === 'making' ? .55 : .9), stroke: col(c, 66, st === 'wait' ? .35 : 1), 'stroke-width': 1.2 })
        : el('path', { d: `M0,0 L${Math.cos(a0) * r},${Math.sin(a0) * r} A${r},${r} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${Math.cos(a1) * r},${Math.sin(a1) * r} Z`, fill: st === 'wait' ? 'none' : col(c, 58, st === 'making' ? .55 : .9), stroke: col(c, 66, st === 'wait' ? .35 : 1), 'stroke-width': 1 })); });
    ((e && e.carving) || []).forEach((c, k) => { const a = k * .7 - Math.PI / 2; g.append(el('circle', { cx: Math.cos(a) * (r + 6), cy: Math.sin(a) * (r + 6), r: c.kept ? 2.3 : 1.4, fill: c.by ? col(c.by, 68) : '#fff', opacity: c.kept ? .95 : .28 })); });
    g.append(el('text', { y: r + 15, 'text-anchor': 'middle', class: 'night-label' }, document.createTextNode(x.title)));
    const tip = el('title', {}); tip.textContent = `${String(n).padStart(2, '0')} · ${x.title} · ${x.bpm} bpm\n${cs.map(c => c.replace(/-/g, ' ')).join(' × ')}\n${x.idea}` + (e && e.carving && e.carving.length ? `\n${e.carving.filter(c => c.kept).length} of ${e.carving.length} carvings kept` : ''); g.append(tip);
    if (e && e.path) g.addEventListener('click', () => libPlay({ path: e.path, kind: 'audio', size: 5e7 }));
    gN.append(g); });
  const gC = el('g', {}); who.forEach(c => { const [x, y] = P[c], busy = N.running && new RegExp('Summoning creature “' + c + '”').test(N.msg || '');
    gC.append(el('circle', { cx: x, cy: y, r: 30, fill: col(c, 50, .1), stroke: col(c, 62, .9), 'stroke-width': 1.4, class: 'night-creature' + (busy ? ' busy' : '') }), el('circle', { cx: x, cy: y, r: 5, fill: col(c, 66) }),
      el('text', { x, y: y + (y > cy ? 48 : -40), 'text-anchor': 'middle', class: 'night-cname', fill: col(c, 72) }, document.createTextNode(c.replace(/-/g, ' ')))); });
  svg.append(gT, gC, gN);
  if (N.started && N.until) {                                                                  // the night as a line: where the making ended, where it is now
    const t0 = N.started, t1 = N.until, now = Math.min(t1, (N.finished || Date.now() / 1000)), x = t => 60 + (t - t0) / (t1 - t0) * (W - 120), hh = t => new Date(t * 1000).toTimeString().slice(0, 5);
    svg.append(el('line', { x1: 60, y1: H - 14, x2: W - 60, y2: H - 14, stroke: '#2a2a44', 'stroke-width': 2 }), el('line', { x1: 60, y1: H - 14, x2: x(now), y2: H - 14, stroke: N.phase === 'chiselling' ? '#2ee6d6' : '#a43cff', 'stroke-width': 2 }),
      el('circle', { cx: x(now), cy: H - 14, r: 4, fill: '#fff', class: N.running ? 'night-now' : '' }),
      x(now) > 190 ? el('text', { x: 60, y: H - 22, class: 'night-tick' }, document.createTextNode(hh(t0))) : null, el('text', { x: W - 60, y: H - 22, 'text-anchor': 'end', class: 'night-tick' }, document.createTextNode(hh(t1))),
      el('text', { x: Math.min(W - 150, Math.max(110, x(now))), y: H - 22, 'text-anchor': 'middle', class: 'night-tick on' }, document.createTextNode(N.running ? (N.phase === 'chiselling' ? 'chiselling' : `making ${N.made}/${N.count}`) : 'finished')));
  }
  return svg;
}
function evoNightView() {                               // tonight, piece by piece: who plays it, what it is, and where it has got to
  const N = EVO.night || {}, sh = EVO.sheet && EVO.sheet.id === N.id ? EVO.sheet : null, ideas = (sh && sh.ideas) || [], done = {}, cur = /song (\d+) of/.exec(N.msg || '');
  ((sh && sh.songs) || []).forEach(e => { done[e.n] = e; });
  const who = x => [x.creature, ...(x.mix || [])].map(c => c.replace(/-/g, ' ')).join(' × ');
  const until = N.until ? new Date(N.until * 1000).toTimeString().slice(0, 5) : '';
  return h('div', { id: 'evo-main' },
    h('div', { class: 'evo-head' }, h('h2', {}, N.tag || 'the night'), h('small', {}, N.running ? (N.phase === 'chiselling' ? `chiselling until ${until} · ${N.carved} carvings kept of ${N.carves} tried` : `making the pieces · ${N.made} of ${N.count} · then chiselling until ${until}`) : (N.msg || 'finished'))),
    N.running ? h('p', { class: 'gym-note', id: 'night-msg' }, N.msg || '') : null,
    ideas.length ? evoNightMap(N, sh) : null,
    !ideas.length ? h('div', { class: 'evo-empty' }, N.running ? 'Writing the ideas…' : 'No night has been run yet. Start one on the left.') :
    h('div', { class: 'night-list' }, ideas.map((x, i) => { const n = i + 1, e = done[n], path = e && e.path, making = N.running && N.phase !== 'chiselling' && cur && +cur[1] === n, kept = e ? (e.carving || []).filter(c => c.kept).length : 0, tried = e ? (e.carving || []).length : 0;
      return h('div', { class: 'night-row' + (path ? ' done' : making ? ' making' : '') + (path && LIB.playing === path ? ' playing' : '') },
        h('span', { class: 'night-n' }, String(n).padStart(2, '0')),
        path ? h('button', { class: 'evo-pp', data: { path }, title: 'Play / stop', onclick: () => libPlay({ path, kind: 'audio', size: 5e7 }) }, LIB.playing === path ? '■' : '▶') : h('span', { class: 'night-dot' }, making ? '◌' : '·'),
        h('div', { class: 'night-what' }, h('b', {}, x.title, h('em', {}, `${x.bpm} bpm`)), h('small', { class: 'night-who' }, who(x)), h('small', { title: x.idea }, x.idea)),
        path ? libWave({ path, kind: 'audio', size: 5e7 }) : h('span', { class: 'night-wait' }, making ? 'being made now…' : 'waiting'),
        h('small', { class: 'night-carve', title: tried ? (e.carving || []).map(c => `${c.kept ? 'kept' : 'not kept'}: ${c.from}–${c.to}s${c.by ? ' by ' + c.by : ''} · ${c.why || ''}`).join('\n') : '' }, tried ? `${kept} of ${tried} carvings kept` : '')); })));
}
function evoMark() { document.querySelectorAll('#evo .evo-pp').forEach(b => { const on = b.dataset.path === LIB.playing; b.textContent = on ? '■' : '▶'; const box = b.closest('.evo-card, .evo-step, .night-row'); if (box) box.classList.toggle('playing', on); });
  if (EVO.showNight && document.querySelector('.night-map')) { clearTimeout(EVO.markT); EVO.markT = setTimeout(evoDraw, 60); } }

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

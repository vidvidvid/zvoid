/* Patch canvas: modules, cables, players, and the run engine. Plain JS, no build step. */
'use strict';

/* report script errors to the app log (~/Library/Logs/Zvoid.log) */
const _clog = m => { try { fetch('/api/clientlog', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ msg: m }) }); } catch {} };
addEventListener('error', e => _clog(`${e.message} @ ${(e.filename || '').split('/').pop()}:${e.lineno}:${e.colno}`));
addEventListener('unhandledrejection', e => _clog('promise: ' + (e.reason && (e.reason.stack || e.reason.message) || e.reason)));

const $ = (s, root = document) => root.querySelector(s);
function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'style') e.style.cssText = v;
    else if (k === 'data') Object.assign(e.dataset, v);
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(3)) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(c));
  return e;
}
async function api(path, opts = {}) {
  if (opts.json !== undefined) { opts.body = JSON.stringify(opts.json); opts.headers = { 'Content-Type': 'application/json' }; opts.method ||= 'POST'; }
  const r = await fetch(path, opts);
  if (!r.ok) { let m = await r.text(); try { m = JSON.parse(m).detail || m; } catch {} throw new Error(String(m).slice(0, 2000)); }
  return r.json();
}
const fileUrl = p => '/api/file?path=' + encodeURIComponent(p);
const uid = () => Math.random().toString(36).slice(2, 9);
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- state ---------- */
const COLORS = { sample: '#e9e7f5', ace_step: '#ff2d9b', musicgen: '#a43cff', stable_audio: '#ff9d2e', demucs: '#2ee6d6', basic_pitch: '#b6ff3c' };
const GLYPHS = { sample: '◌', ace_step: '◈', musicgen: '◉', stable_audio: '◬', demucs: '⫶', basic_pitch: '⌁' };
const color = t => COLORS[t] || `hsl(${[...t].reduce((a, c) => a + c.charCodeAt(0) * 7, 0) % 360} 90% 65%)`;
let ENG = {};                                   // engine specs by id
let S = { nodes: {}, cables: [], view: { x: 80, y: 90, k: 1 } };
const R = {};                                   // runtime status per node: {state, msg, frac, jobId, error}
let sel = null;                                 // {node} or {cable}
const space = $('#space'), world = $('#world'), svg = $('#cables');
const nodeEls = new Map();

/* ---------- persistence ---------- */
let saveT;
function save() {
  clearTimeout(saveT);
  saveT = setTimeout(() => api('/api/patches/autosave', { method: 'PUT', json: S }).catch(() => {}), 400);
}
function status(msg) { $('#status').textContent = msg; }
function toast(msg, err) {
  const t = h('div', { class: 'toast' + (err ? ' err' : '') }, msg);
  $('#toasts').append(t); setTimeout(() => t.remove(), err ? 6000 : 2600);
}

/* ---------- view (pan / zoom) ---------- */
function applyView() {
  const { x, y, k } = S.view;
  world.style.transform = `translate(${x}px, ${y}px) scale(${k})`;
  space.style.backgroundSize = `${28 * k}px ${28 * k}px`;
  space.style.backgroundPosition = `${x}px ${y}px`;
}
const toWorld = (cx, cy) => ({ x: (cx - S.view.x) / S.view.k, y: (cy - S.view.y) / S.view.k });
function zoomAt(cx, cy, factor) {
  const k = Math.min(2, Math.max(0.25, S.view.k * factor));
  const w = toWorld(cx, cy);
  S.view.k = k; S.view.x = cx - w.x * k; S.view.y = cy - w.y * k;
  applyView(); save();
}
function fit() {
  const els = [...nodeEls.values()];
  if (!els.length) { S.view = { x: 80, y: 90, k: 1 }; return applyView(); }
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (const n of Object.values(S.nodes)) {
    const e = nodeEls.get(n.id); if (!e) continue;
    x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y); x1 = Math.max(x1, n.x + e.offsetWidth); y1 = Math.max(y1, n.y + e.offsetHeight);
  }
  const left = $('#chat').hidden ? 60 : 400, W = innerWidth - left - 60 - ($('#drawer').hidden ? 0 : 390), H = innerHeight - 190;
  const k = Math.min(1.1, Math.max(0.25, Math.min(W / (x1 - x0), H / (y1 - y0))));
  S.view = { k, x: left + (W - (x1 - x0) * k) / 2 - x0 * k, y: 80 + (H - (y1 - y0) * k) / 2 - y0 * k };
  applyView(); save();
}
space.addEventListener('wheel', e => {
  const t = e.target;
  if ((t.tagName === 'TEXTAREA' || t.tagName === 'PRE') && t.scrollHeight > t.clientHeight && !e.ctrlKey) return;
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.01));
  else { S.view.x -= e.deltaX; S.view.y -= e.deltaY; applyView(); save(); }
}, { passive: false });
space.addEventListener('mousedown', e => {
  if (e.target !== space && e.target !== world && e.target !== svg) return;
  select(null); closePalette();
  const sx = e.clientX - S.view.x, sy = e.clientY - S.view.y;
  space.classList.add('panning');
  const mv = ev => { S.view.x = ev.clientX - sx; S.view.y = ev.clientY - sy; applyView(); };
  const up = () => { space.classList.remove('panning'); removeEventListener('mousemove', mv); removeEventListener('mouseup', up); save(); };
  addEventListener('mousemove', mv); addEventListener('mouseup', up);
});
space.addEventListener('dblclick', e => { if (e.target === space || e.target === world) openPalette(e.clientX, e.clientY); });
$('#zoom').addEventListener('click', e => {
  const z = e.target.dataset.z; if (!z) return;
  if (z === 'fit') fit(); else zoomAt(innerWidth / 2, innerHeight / 2, z === 'in' ? 1.2 : 1 / 1.2);
});

/* ---------- audio players ---------- */
let AC; const ac = () => (AC ||= new (window.AudioContext || window.webkitAudioContext)());
/* everything that plays goes through one analyser, so the gym entity can hear it */
let ANA = null; const _fq = new Uint8Array(512), _tm = new Uint8Array(512), _wave = new Float32Array(512);
function bus() { if (!ANA) { ANA = ac().createAnalyser(); ANA.fftSize = 1024; ANA.smoothingTimeConstant = .72; ANA.connect(ac().destination); } return ANA; }
function audioLevels() {
  if (!ANA) return null;
  ANA.getByteFrequencyData(_fq); ANA.getByteTimeDomainData(_tm);
  let b = 0, m = 0, hsum = 0, tot = 0;
  for (let i = 1; i < 6; i++) b += _fq[i]; for (let i = 6; i < 90; i++) m += _fq[i]; for (let i = 90; i < 380; i++) hsum += _fq[i];
  for (let i = 0; i < 512; i++) { _wave[i] = (_tm[i] - 128) / 128; tot += Math.abs(_wave[i]); }
  const bass = Math.min(1, b / 5 / 255 * 1.1), mid = Math.min(1, m / 84 / 255 * 1.7), high = Math.min(1, hsum / 290 / 255 * 1.5);
  const level = Math.min(1, Math.max(tot / 512 * 3.5, (bass + mid + high) / 3 * .85));
  return level < .004 ? null : { level, bass, mid, high, freq: _fq, wave: _wave };
}
const bufs = new Map();
function loadBuf(path) {
  if (!bufs.has(path)) bufs.set(path, fetch(fileUrl(path)).then(r => r.arrayBuffer())
    .then(a => new Promise((res, rej) => ac().decodeAudioData(a, res, rej))).catch(e => { bufs.delete(path); throw e; }));
  return bufs.get(path);
}
const players = new Map();                       // key: nodeId|path
function player(nodeId, path, col) {
  const key = nodeId + '|' + path;
  if (players.has(key)) return players.get(key).el;
  const cv = h('canvas'), pp = h('button', { class: 'pp', title: 'Play / stop' }, '▶');
  const loopB = h('button', { title: 'Loop' }, '∞'), rev = h('button', { title: 'Show in Finder' }, '↗');
  const feedB = h('button', { title: 'Feed this to a creature in the vivarium', onclick: e => feedChooser(path, e) }, '◍');
  const el = h('div', { class: 'player' }, pp, cv, h('div', { class: 'tools' }, loopB, feedB, rev));
  const P = { el, buf: null, src: null, t0: 0, off: 0, loop: false, peaks: null, raf: 0 };
  players.set(key, P);
  const pos = () => P.src ? ((ac().currentTime - P.t0 + P.off) % P.buf.duration) : P.off;
  function draw() {
    const w = cv.clientWidth || 200, hh = cv.clientHeight || 34, d = devicePixelRatio || 1;
    if (cv.width !== w * d) { cv.width = w * d; cv.height = hh * d; }
    const g = cv.getContext('2d'); g.setTransform(d, 0, 0, d, 0, 0); g.clearRect(0, 0, w, hh);
    if (!P.peaks) { g.fillStyle = '#3a3a5c'; g.fillRect(4, hh / 2, w - 8, 1); return; }
    const n = P.peaks.length, bw = (w - 8) / n, play = P.buf ? pos() / P.buf.duration : 0;
    for (let i = 0; i < n; i++) {
      const a = Math.max(1, P.peaks[i] * (hh - 8));
      g.fillStyle = i / n < play ? col : '#4a4a70';
      g.fillRect(4 + i * bw, (hh - a) / 2, Math.max(1, bw - 1), a);
    }
    if (P.src || P.off) { g.fillStyle = '#fff'; g.fillRect(4 + play * (w - 8), 2, 1.5, hh - 4); }
  }
  function tick() { draw(); if (P.src) P.raf = requestAnimationFrame(tick); }
  P.stop = (keep) => {
    if (P.src) { P.off = keep ? pos() : 0; P.src.onended = null; try { P.src.stop(); } catch {} P.src = null; }
    else if (!keep) P.off = 0;
    el.classList.remove('playing'); pp.textContent = '▶'; draw();
  };
  P.play = async (from) => {
    await ac().resume(); if (!P.buf) return;
    if (P.src) P.stop(true);
    if (from != null) P.off = from;
    const s = ac().createBufferSource(); s.buffer = P.buf; s.loop = P.loop; s.connect(bus());
    s.onended = () => { if (P.src === s) { P.src = null; P.off = 0; el.classList.remove('playing'); pp.textContent = '▶'; draw(); } };
    P.t0 = ac().currentTime; s.start(0, P.off % P.buf.duration); P.src = s;
    el.classList.add('playing'); pp.textContent = '■'; tick();
  };
  pp.onclick = () => P.src ? P.stop() : P.play();
  cv.onclick = e => { if (P.buf) P.play((e.offsetX - 4) / (cv.clientWidth - 8) * P.buf.duration); };
  loopB.onclick = () => { P.loop = !P.loop; loopB.classList.toggle('on', P.loop); if (P.src) P.src.loop = P.loop; };
  rev.onclick = () => api('/api/reveal', { json: { path } });
  loadBuf(path).then(b => {
    P.buf = b; const ch = b.getChannelData(0), n = 90, step = Math.floor(ch.length / n) || 1; let mx = 0.001;
    P.peaks = Array.from({ length: n }, (_, i) => { let m = 0; for (let j = i * step; j < (i + 1) * step; j += 16) m = Math.max(m, Math.abs(ch[j] || 0)); mx = Math.max(mx, m); return m; }).map(v => v / mx);
    draw();
  }).catch(() => { cv.title = 'Could not decode this file'; });
  requestAnimationFrame(draw);
  return el;
}
function dropPlayers(nodeId, keepPaths = []) {
  for (const [k, P] of players) if (k.startsWith(nodeId + '|') && !keepPaths.includes(k.slice(nodeId.length + 1))) { P.stop(); players.delete(k); }
}

/* ---------- ports & outputs ---------- */
const audioParams = spec => (spec.params || []).filter(p => p.type === 'audio');
function outNames(n) {
  if (n.type === 'sample') return ['out'];
  const spec = ENG[n.type] || {}, base = spec.outputs || ['out'], res = n.result && n.result.outputs;
  if (res && spec.dynamic_outputs) return res.map(o => o.label);
  if (res && res.length > base.length) return res.map((o, i) => base[i] || `take ${i + 1}`);
  return base;
}
function outFile(n, name) {
  if (n.type === 'sample') return n.file ? { path: n.file.path, kind: 'audio', name: n.file.name } : null;
  const res = n.result && n.result.outputs; if (!res || !res.length) return null;
  if (name === 'midi') return res.find(o => o.kind === 'midi') || null;
  const names = outNames(n);
  return res.find(o => (o.label || '').toLowerCase() === String(name).toLowerCase())
    || (names.indexOf(name) >= 0 && res[names.indexOf(name)])
    || res.find(o => o.kind === 'audio') || null;
}
function portPos(nodeId, dir, name) {
  const el = nodeEls.get(nodeId); if (!el) return null;
  const p = el.querySelector(`.port.${dir}[data-port="${CSS.escape(name)}"]`) || el.querySelector(`.port.${dir}`);
  if (!p) return null;
  const r = p.getBoundingClientRect();
  return toWorld(r.left + r.width / 2, r.top + r.height / 2);
}

/* ---------- cables ---------- */
const NS = 'http://www.w3.org/2000/svg';
const curve = (a, b) => { const dx = Math.max(50, Math.abs(b.x - a.x) * 0.5); return `M${a.x},${a.y} C${a.x + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}`; };
let cableRaf = 0;
function drawCables() { cancelAnimationFrame(cableRaf); cableRaf = requestAnimationFrame(_drawCables); }
function _drawCables() {
  svg.querySelectorAll('.cable:not(.ghost)').forEach(g => g.remove());
  for (const c of S.cables) {
    const a = portPos(c.from.node, 'out', c.from.port), b = portPos(c.to.node, 'in', c.to.port);
    if (!a || !b) continue;
    const g = document.createElementNS(NS, 'g');
    const live = R[c.to.node] && R[c.to.node].state === 'running';
    g.setAttribute('class', 'cable' + (sel && sel.cable === c.id ? ' sel' : '') + (live ? ' live' : ''));
    g.style.setProperty('--c', color(S.nodes[c.from.node].type));
    for (const cls of ['hit', 'core', 'flow']) { const p = document.createElementNS(NS, 'path'); p.setAttribute('class', cls); p.setAttribute('d', curve(a, b)); g.append(p); }
    g.firstChild.addEventListener('mousedown', e => { e.stopPropagation(); select({ cable: c.id }); });
    g.firstChild.addEventListener('dblclick', e => { e.stopPropagation(); removeCable(c.id); });
    svg.append(g);
  }
  document.querySelectorAll('.port.in').forEach(p => p.classList.toggle('on', S.cables.some(c => c.to.node === p.dataset.node && c.to.port === p.dataset.port)));
  document.querySelectorAll('.port.out').forEach(p => p.classList.toggle('on', S.cables.some(c => c.from.node === p.dataset.node && c.from.port === p.dataset.port)));
}
function removeCable(id) { const c = S.cables.find(c => c.id === id); S.cables = S.cables.filter(c => c.id !== id); if (c && S.nodes[c.to.node]) renderNode(S.nodes[c.to.node]); drawCables(); save(); }
function connect(from, to) {
  if (from.node === to.node) return;
  if (upstream(from.node).has(to.node)) return toast('that would make a loop', true);
  S.cables = S.cables.filter(c => !(c.to.node === to.node && c.to.port === to.port));
  S.cables.push({ id: uid(), from, to });
  renderNode(S.nodes[to.node]); drawCables(); save();
}
function upstream(id, seen = new Set()) {
  for (const c of S.cables) if (c.to.node === id && !seen.has(c.from.node)) { seen.add(c.from.node); upstream(c.from.node, seen); }
  return seen;
}
function startCable(e, nodeId, dir, port, kind) {
  e.stopPropagation(); e.preventDefault();
  let from = dir === 'out' ? { node: nodeId, port } : null;
  if (dir === 'in') {                             // grabbing a wired input picks the cable back up
    const ex = S.cables.find(c => c.to.node === nodeId && c.to.port === port);
    if (!ex) return;
    from = ex.from; S.cables = S.cables.filter(c => c !== ex); renderNode(S.nodes[nodeId]); drawCables();
    kind = (outFile(S.nodes[from.node], from.port) || {}).kind;
  }
  const a = portPos(from.node, 'out', from.port);
  const g = document.createElementNS(NS, 'g'); g.setAttribute('class', 'cable ghost'); g.style.setProperty('--c', color(S.nodes[from.node].type));
  const p = document.createElementNS(NS, 'path'); p.setAttribute('class', 'core'); g.append(p); svg.append(g);
  let target = null;
  const mv = ev => {
    p.setAttribute('d', curve(a, toWorld(ev.clientX, ev.clientY)));
    const t = document.elementFromPoint(ev.clientX, ev.clientY);
    const hit = t && (t.closest('.port.in') || (t.closest('.row.in') && t.closest('.row.in').querySelector('.port.in')));
    if (target && target !== hit) target.classList.remove('target');
    target = hit; if (target) target.classList.add('target');
  };
  const up = () => {
    removeEventListener('mousemove', mv); removeEventListener('mouseup', up); g.remove();
    if (target) {
      target.classList.remove('target');
      if (kind === 'midi' || port === 'midi') toast('that port is MIDI — drag the .mid into your DAW instead', true);
      else connect(from, { node: target.dataset.node, port: target.dataset.port });
    }
    drawCables(); save();
  };
  addEventListener('mousemove', mv); addEventListener('mouseup', up);
}

/* ---------- controls ---------- */
function control(n, p) {
  const v = n.params[p.name] ?? p.default ?? (p.type === 'seed' ? -1 : '');
  const set = val => { n.params[p.name] = val; save(); };
  const label = (p.label || p.name.replace(/_/g, ' ')).replace(/\s*\(.*\)$/, '');
  let input, inline = false;
  if (p.type === 'textarea') { input = h('textarea', { rows: Math.min(p.lines || 2, 4), spellcheck: 'false' }); input.value = v; input.oninput = () => set(input.value); }
  else if (p.type === 'slider') {
    const rng = h('input', { type: 'range', min: p.min, max: p.max, step: p.step || 1 }), num = h('input', { type: 'number', min: p.min, max: p.max, step: p.step || 1 });
    const paint = () => rng.style.setProperty('--p', ((rng.value - p.min) / (p.max - p.min) * 100) + '%');
    rng.value = num.value = v; paint();
    rng.oninput = () => { num.value = rng.value; set(+rng.value); paint(); };
    num.onchange = () => { rng.value = num.value; set(+num.value); paint(); };
    input = h('div', { class: 'slider' }, rng, num);
  } else if (p.type === 'seed') {
    const num = h('input', { type: 'number', step: 1 }); num.value = v; num.onchange = () => set(num.value === '' ? -1 : +num.value);
    const rnd = h('button', { title: 'Random seed every run' }, 'random'), last = h('button', { title: 'Reuse the seed of the last result' }, 'last');
    rnd.onclick = () => { num.value = -1; set(-1); };
    last.onclick = () => { const s = n.result && n.result.seed; if (s != null) { num.value = s; set(s); } else toast('no result yet'); };
    input = h('div', { class: 'seed' }, num, h('div', { style: 'display:flex;gap:4px' }, rnd, last));
  } else if (p.type === 'int' || p.type === 'number') { input = h('input', { type: 'number', step: p.type === 'int' ? 1 : 'any' }); input.value = v ?? ''; input.onchange = () => set(input.value === '' ? null : +input.value); }
  else if (p.type === 'choice' && p.custom) {
    const known = p.choices.includes(v), sel = h('select', {}, p.choices.map(c => h('option', { value: c }, c)), h('option', { value: '__custom' }, 'custom…'));
    const txt = h('input', { type: 'text', spellcheck: 'false', placeholder: 'type any model id', hidden: known, style: 'margin-top:4px' });
    sel.value = known ? v : '__custom'; txt.value = known ? '' : v;
    sel.onchange = () => { txt.hidden = sel.value !== '__custom'; if (sel.value !== '__custom') set(sel.value); else txt.focus(); drawCables(); };
    txt.oninput = () => set(txt.value.trim());
    input = h('div', {}, sel, txt);
  } else if (p.type === 'choice') { input = h('select', {}, p.choices.map(c => h('option', { value: c }, c))); input.value = v; input.onchange = () => { set(input.value); }; }
  else if (p.type === 'creature') {
    const opts = (p.choices || ['']).slice(); if (v && !opts.includes(v)) opts.push(v);
    const sel = h('select', {}, opts.map(c => h('option', { value: c }, c || 'none'))); sel.value = v || ''; sel.onchange = () => set(sel.value);
    input = h('div', { class: 'seed' }, sel, h('button', { title: 'Open the vivarium', onclick: e => { e.preventDefault(); openGym(sel.value || undefined); } }, 'vivarium'));
  }
  else if (p.type === 'bool') { input = h('input', { type: 'checkbox', class: 'toggle' }); input.checked = !!v; input.onchange = () => set(input.checked); inline = true; }
  else { input = h('input', { type: 'text', spellcheck: 'false' }); input.value = v ?? ''; input.oninput = () => set(input.value); }
  return h('label', { class: 'ctl' + (inline ? ' inline' : ''), title: p.help || '' }, h('span', { class: 'lbl' }, label), input);
}

/* ---------- modules ---------- */
function select(s) {
  sel = s;
  for (const [id, e] of nodeEls) e.classList.toggle('sel', !!(s && s.node === id));
  drawCables();
}
function renderNode(n) {
  const isS = n.type === 'sample', spec = ENG[n.type];
  const c = color(n.type), r = R[n.id] || {};
  const e = h('div', { class: 'node' + (sel && sel.node === n.id ? ' sel' : '') + (r.state === 'running' ? ' running' : ''), data: { node: n.id }, style: `left:${n.x}px;top:${n.y}px;--c:${c}` });
  const title = isS ? 'sample' : spec ? (spec.tab || spec.name) : n.type + ' (missing)';
  const go = !isS && spec && h('button', { class: 'go', title: 'Run this module (shift-click: re-run everything upstream too)' }, r.state === 'running' ? '■' : '▸');
  if (go) go.onclick = ev => { ev.stopPropagation(); (R[n.id] || {}).state === 'running' ? stopNode(n.id) : runNode(n.id, new Map(), ev.shiftKey).catch(() => {}); };
  const head = h('div', { class: 'node-head' }, h('span', { class: 'glyph' }, GLYPHS[n.type] || '✦'), h('span', { class: 'node-title' }, title), go,
    h('button', { title: 'Remove', onclick: ev => { ev.stopPropagation(); removeNode(n.id); } }, '×'));
  head.addEventListener('mousedown', ev => dragNode(ev, n));
  e.append(head, h('div', { class: 'progress' + (r.frac == null ? ' indet' : '') }, h('i', { style: r.frac != null ? `width:${Math.round(r.frac * 100)}%` : '' })));
  e.addEventListener('mousedown', () => select({ node: n.id }));

  const body = h('div', { class: 'node-body' });
  if (isS) {
    body.append(n.file ? h('div', { class: 'lbl', style: 'font:10.5px var(--mono);color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap', title: n.file.name }, n.file.name)
      : h('div', { class: 'drop', onclick: () => pickFile(f => loadSample(n, f)) }, h('div', {}, 'drop audio here', h('br'), 'or click to choose')));
  } else if (spec) {
    if (!spec.installed) body.append(h('div', { class: 'badge', onclick: () => openDrawer('engines') }, 'not installed yet · open engines to install'));
    for (const p of audioParams(spec)) {
      const cab = S.cables.find(k => k.to.node === n.id && k.to.port === p.name);
      const src = cab && S.nodes[cab.from.node];
      body.append(h('div', { class: 'row in' + (cab ? ' wired' : ''), title: p.help || '' },
        h('span', { class: 'port in', data: { node: n.id, port: p.name }, onmousedown: ev => startCable(ev, n.id, 'in', p.name) }),
        h('span', { class: 'lbl' }, (p.label || p.name).replace(/\s*\(.*\)$/, '')),
        h('span', { class: 'hint' }, cab ? '← ' + (src.type === 'sample' ? (src.file ? src.file.name : 'sample') : (ENG[src.type] || {}).tab || src.type) + (cab.from.port !== 'out' ? ' · ' + cab.from.port : '') : 'wire audio in')));
    }
    const rest = (spec.params || []).filter(p => p.type !== 'audio');
    for (const p of rest.filter(p => !p.advanced)) body.append(control(n, p));
    const adv = rest.filter(p => p.advanced);
    const advBox = h('div', { class: 'adv', hidden: !n.adv });
    for (const p of adv) advBox.append(control(n, p));
    const extra = h('textarea', { rows: 1, spellcheck: 'false', placeholder: '{"any_model_kwarg": 1}' }); extra.value = n.params.extra || ''; extra.oninput = () => { n.params.extra = extra.value; save(); };
    advBox.append(h('label', { class: 'ctl', title: 'Raw JSON passed straight to the model call' }, h('span', { class: 'lbl' }, 'extra kwargs'), extra),
      h('div', { style: 'display:flex;gap:6px' }, h('button', { class: 'mini', onclick: () => api(`/api/engines/${n.type}/unload`, { method: 'POST' }).then(() => toast('model unloaded')) }, 'unload model'),
        spec.notes && h('button', { class: 'mini', onclick: () => openDrawer('tips', n.type) }, 'tips')));
    body.append(h('button', { class: 'adv-toggle', onclick: () => { n.adv = !n.adv; renderNode(n); save(); } }, (n.adv ? '▾' : '▸') + ' advanced'), advBox);
  }
  e.append(body);

  const outs = h('div', { class: 'outs' }), keep = [];
  for (const name of outNames(n)) {
    const f = outFile(n, name), midi = name === 'midi' || (f && f.kind === 'midi');
    const port = h('span', { class: 'port out' + (midi ? ' midi' : ''), data: { node: n.id, port: name }, onmousedown: ev => startCable(ev, n.id, 'out', name, midi ? 'midi' : 'audio') });
    let view;
    if (f && f.kind === 'audio') { keep.push(f.path); view = player(n.id, f.path, c); }
    else if (f) view = h('div', { class: 'midi-chip' }, h('span', { class: 'fn', title: f.name || '' }, f.name || 'file'), h('button', { class: 'mini', onclick: () => api('/api/reveal', { json: { path: f.path } }) }, 'show in finder'));
    else view = h('div', { class: 'empty' }, isS ? 'empty' : 'no signal yet');
    outs.append(h('div', { class: 'row out' }, port, isS ? null : h('span', { class: 'lbl' }, name, f && n.result && n.result.seed != null ? h('em', {}, 'seed ' + n.result.seed) : null), view));
  }
  dropPlayers(n.id, keep);
  e.append(outs);
  if (isS && n.file) outs.append(h('button', { class: 'mini', style: 'justify-self:start', onclick: () => pickFile(f => loadSample(n, f)) }, 'replace'));
  if (!isS) {
    const foot = h('div', { class: 'node-foot' + (r.state === 'error' ? ' err' : '') }, h('span', { class: 'msg' }, r.msg || (n.result ? `done in ${n.result.info && n.result.info.seconds}s` : 'idle')));
    if (r.state === 'error') foot.firstChild.onclick = () => { foot.classList.toggle('open'); if (foot.classList.contains('open') && !foot.querySelector('pre')) foot.append(h('pre', {}, r.error || '')); drawCables(); };
    e.append(foot);
  }
  const old = nodeEls.get(n.id);
  if (old) old.replaceWith(e); else world.append(e);
  nodeEls.set(n.id, e);
  drawCables();
}
function setStatus(id, patch) {                   // light update while a job runs (keeps focus in fields)
  const r = R[id] = Object.assign(R[id] || {}, patch), e = nodeEls.get(id); if (!e) return;
  e.classList.toggle('running', r.state === 'running');
  const bar = e.querySelector('.progress'); bar.classList.toggle('indet', r.frac == null); bar.firstChild.style.width = r.frac != null ? Math.round(r.frac * 100) + '%' : '';
  const go = e.querySelector('.go'); if (go) go.textContent = r.state === 'running' ? '■' : '▸';
  const msg = e.querySelector('.node-foot .msg'); if (msg) msg.textContent = r.msg || '';
}
function dragNode(ev, n) {
  if (ev.target.closest('button')) return;
  ev.preventDefault(); select({ node: n.id });
  const e = nodeEls.get(n.id), sx = ev.clientX, sy = ev.clientY, ox = n.x, oy = n.y; e.style.zIndex = ++zTop;
  const mv = m => { n.x = ox + (m.clientX - sx) / S.view.k; n.y = oy + (m.clientY - sy) / S.view.k; e.style.left = n.x + 'px'; e.style.top = n.y + 'px'; _drawCables(); };
  const up = () => { removeEventListener('mousemove', mv); removeEventListener('mouseup', up); save(); };
  addEventListener('mousemove', mv); addEventListener('mouseup', up);
}
let zTop = 5;
function addNode(type, x, y, extra = {}) {
  const c = toWorld(innerWidth / 2, innerHeight / 2);
  let nx = Math.round((x ?? c.x - 150) / 4) * 4, ny = Math.round((y ?? c.y - 160) / 4) * 4;
  while (Object.values(S.nodes).some(o => Math.abs(o.x - nx) < 24 && Math.abs(o.y - ny) < 24)) { nx += 36; ny += 36; }   // don't stack exactly
  const n = Object.assign({ id: uid(), type, x: nx, y: ny, params: {}, adv: false, result: null }, extra);
  S.nodes[n.id] = n; renderNode(n); select({ node: n.id }); save();
  return n;
}
function removeNode(id) {
  if ((R[id] || {}).state === 'running') stopNode(id);
  const hit = S.cables.filter(c => c.from.node === id).map(c => c.to.node);
  S.cables = S.cables.filter(c => c.from.node !== id && c.to.node !== id);
  dropPlayers(id); delete S.nodes[id]; delete R[id];
  nodeEls.get(id)?.remove(); nodeEls.delete(id);
  hit.forEach(t => S.nodes[t] && renderNode(S.nodes[t]));
  select(null); save();
}

/* ---------- samples (your audio) ---------- */
let pickCb = null;
function pickFile(cb) { pickCb = cb; const i = $('#file-pick'); i.value = ''; i.click(); }
$('#file-pick').onchange = e => { const f = e.target.files[0]; if (f && pickCb) pickCb(f); };
async function loadSample(n, file) {
  status('importing ' + file.name);
  try { n.file = await api('/api/upload?name=' + encodeURIComponent(file.name), { method: 'POST', body: file }); }
  catch (err) { return toast('could not import: ' + err.message, true); }
  renderNode(n); S.cables.filter(c => c.from.node === n.id).forEach(c => renderNode(S.nodes[c.to.node])); save(); status('ready_');
}
addEventListener('dragover', e => { e.preventDefault(); });
addEventListener('drop', e => {
  e.preventDefault();
  const isDir = [...(e.dataTransfer.items || [])].some(i => { try { const en = i.webkitGetAsEntry && i.webkitGetAsEntry(); return en && en.isDirectory; } catch { return false; } });
  if (isDir) { if (typeof Gym !== 'undefined' && Gym.open && Gym.cur) { toast('choose that folder in the dialog so it can be linked without copying'); return gymPickFolder(); } return toast('open the gym to feed a whole folder to a creature'); }
  const files = [...(e.dataTransfer.files || [])].filter(f => /audio|\.(wav|mp3|flac|aiff?|ogg|m4a)$/i.test(f.type + f.name) || (typeof Gym !== 'undefined' && Gym.open && /video|\.(mp4|mov|m4v|mkv|webm)$/i.test(f.type + f.name)));
  if (!files.length) return;
  if (typeof Gym !== 'undefined' && Gym.open) return gymFeedFiles(files);
  const el = e.target.closest && e.target.closest('.node'), target = el && S.nodes[el.dataset.node], w = toWorld(e.clientX, e.clientY);
  files.forEach((f, i) => {
    if (target && target.type === 'sample' && i === 0) return loadSample(target, f);
    const free = target && ENG[target.type] && audioParams(ENG[target.type]).find(p => !S.cables.some(c => c.to.node === target.id && c.to.port === p.name));
    const n = free ? addNode('sample', target.x - 360, target.y + i * 150) : addNode('sample', w.x - 150 + i * 30, w.y - 40 + i * 150);
    loadSample(n, f); if (free && i === 0) connect({ node: n.id, port: 'out' }, { node: target.id, port: free.name });
  });
});

/* ---------- running ---------- */
function runNode(id, memo = new Map(), fresh = false) {
  if (memo.has(id)) return memo.get(id);
  const job = (async () => {
    const n = S.nodes[id]; if (!n) throw new Error('module is gone');
    if (n.type === 'sample') { if (!n.file) { toast('a sample module is empty', true); throw new Error('empty sample'); } return; }
    const spec = ENG[n.type]; if (!spec) throw new Error('unknown engine');
    if ((R[id] || {}).state === 'running') return;
    const ins = S.cables.filter(c => c.to.node === id);
    setStatus(id, { state: 'waiting', msg: ins.length ? 'waiting for upstream…' : 'starting…', frac: null, error: null });
    try {
      await Promise.all(ins.map(c => { const u = S.nodes[c.from.node]; return (u.type === 'sample' || fresh || !u.result) ? runNode(u.id, memo, fresh) : null; }));
    } catch (err) { setStatus(id, { state: 'error', msg: 'upstream failed', error: String(err.message || err) }); renderNode(n); throw err; }
    const params = Object.assign({}, n.params);
    for (const p of audioParams(spec)) {
      const c = ins.find(c => c.to.port === p.name), f = c && outFile(S.nodes[c.from.node], c.from.port);
      if (f && f.kind !== 'audio') { setStatus(id, { state: 'error', msg: 'that input is not audio', error: '' }); renderNode(n); throw new Error('not audio'); }
      params[p.name] = f ? f.path : null;
    }
    setStatus(id, { state: 'running', msg: 'starting… (first run loads the model)', frac: null }); drawCables();
    status(`running ${spec.tab || spec.name}`);
    try {
      const { id: jid } = await api('/api/run', { json: { engine: n.type, params } });
      R[id].jobId = jid;
      for (;;) {
        await sleep(350);
        const j = await api('/api/jobs/' + jid);
        if (j.state === 'done') { n.result = { outputs: j.outputs, info: j.info, seed: j.seed }; setStatus(id, { state: 'done', msg: j.msg, frac: 1 }); break; }
        if (j.state === 'error' || j.state === 'cancelled') { const er = new Error(j.error || j.msg); er.cancelled = j.state === 'cancelled'; throw er; }
        setStatus(id, { state: 'running', msg: (j.msg || '') + (j.frac != null ? ` · ${Math.round(j.frac * 100)}%` : ''), frac: j.frac });
      }
    } catch (err) {
      const lines = String(err.message || err).split('\n');
      setStatus(id, { state: err.cancelled ? 'idle' : 'error', msg: err.cancelled ? 'stopped' : lines[0], error: lines.slice(1).join('\n').trim() });
      renderNode(n); status('ready_'); throw err;
    }
    renderNode(n); S.cables.filter(c => c.from.node === id).forEach(c => renderNode(S.nodes[c.to.node]));
    save(); status('ready_'); refreshEngines();
  })();
  memo.set(id, job);
  return job;
}
function stopNode(id) { const r = R[id]; if (r && r.jobId) api(`/api/jobs/${r.jobId}/cancel`, { method: 'POST' }); }
async function runAll() {
  const b = $('#run-all'); if (b.classList.contains('busy')) return;
  const ids = Object.values(S.nodes).filter(n => n.type !== 'sample').map(n => n.id);
  if (!ids.length) return toast('add a module first — double-click the void');
  b.classList.add('busy'); const memo = new Map();
  const res = await Promise.allSettled(ids.map(id => runNode(id, memo, true)));
  b.classList.remove('busy');
  const bad = res.filter(r => r.status === 'rejected').length;
  toast(bad ? `${bad} module${bad > 1 ? 's' : ''} failed` : 'circuit complete', !!bad);
}
$('#run-all').onclick = runAll;

/* ---------- palette & dock ---------- */
const moduleList = () => [{ id: 'sample', name: 'sample', hint: 'your audio' }, ...Object.values(ENG).map(e => ({ id: e.id, name: (e.tab || e.name).toLowerCase(), hint: e.kind === 'tool' ? 'tool' : 'generator' }))];
function buildDock() {
  const d = $('#dock'); d.replaceChildren();
  for (const m of moduleList()) d.append(h('button', { style: `--c:${color(m.id)}`, title: 'Add a ' + m.name + ' module', onclick: () => addNode(m.id) }, h('i'), m.name));
}
function closePalette() { $('#palette').hidden = true; }
function openPalette(cx, cy) {
  const p = $('#palette'), w = toWorld(cx, cy), q = h('input', { placeholder: 'add module…', spellcheck: 'false' }), list = h('div', { style: 'display:grid;gap:2px' });
  const fill = () => { list.replaceChildren(...moduleList().filter(m => m.name.includes(q.value.toLowerCase())).map((m, i) =>
    h('button', { class: i ? '' : 'cur', style: `--c:${color(m.id)}`, onclick: () => { addNode(m.id, w.x - 150, w.y - 20); closePalette(); } }, h('i'), m.name, h('small', {}, m.hint)))); };
  q.oninput = fill; q.onkeydown = e => { if (e.key === 'Enter') list.firstChild?.click(); if (e.key === 'Escape') closePalette(); e.stopPropagation(); };
  p.replaceChildren(q, list); fill();
  p.style.left = Math.min(cx, innerWidth - 270) + 'px'; p.style.top = Math.min(cy, innerHeight - 330) + 'px'; p.hidden = false; q.focus();
}

/* ---------- drawers ---------- */
let drawerKind = null, drawerTimer = 0;
$('#drawer-close').onclick = () => openDrawer(null);
$('#btn-library').onclick = () => openDrawer(drawerKind === 'library' ? null : 'library');
$('#btn-engines').onclick = () => openDrawer(drawerKind === 'engines' ? null : 'engines');
function openDrawer(kind, arg) {
  drawerKind = kind; clearInterval(drawerTimer);
  const d = $('#drawer'), body = $('#drawer-body'); d.hidden = !kind; if (!kind) return;
  $('#drawer-title').textContent = kind; body.replaceChildren();
  if (kind === 'tips') { const s = ENG[arg]; $('#drawer-title').textContent = (s.tab || s.name) + ' · tips'; body.append(h('div', { class: 'card' }, h('p', { style: 'white-space:pre-wrap;color:var(--text);user-select:text;-webkit-user-select:text' }, (s.tagline + '\n\n' + s.notes).replace(/\*\*|`/g, '')))); }
  d.classList.toggle('wide', kind === 'library');
  if (kind === 'library') libraryOpen(body);
  if (kind === 'engines') {
    const draw = async () => {
      const list = await api('/api/engines?sizes=true'); if (drawerKind !== 'engines') return;
      for (const e of list) ENG[e.id] = e;
      const logs = {}; await Promise.all(list.filter(e => e.installing || body.querySelector(`[data-log="${e.id}"]`)).map(async e => { logs[e.id] = await api(`/api/engines/${e.id}/install`); }));
      const scroll = body.scrollTop;
      body.replaceChildren(h('p', { style: 'color:var(--muted);margin:0;font-size:11.5px' }, 'Each engine has its own Python environment. Model weights download the first time you use them.'),
        ...list.map(e => h('div', { class: 'card', style: `--c:${color(e.id)}` },
          h('h4', {}, h('i', { class: e.running ? 'hot' : e.installed ? 'ok' : '' }), e.name),
          h('small', {}, e.installing ? 'installing…' : e.running ? 'loaded in memory' : e.installed ? 'installed · ' + (e.env_size || '') : 'not installed'),
          h('small', {}, 'models: ' + (e.disk || '?')), h('small', {}, e.license || ''),
          e.far && h('label', { style: 'display:flex;align-items:center;gap:8px;font-size:11px;color:var(--muted)', title: 'Where this engine makes its sound. On the PC it uses that machine\'s graphics card: faster, and this Mac stays free.' }, 'runs on',
            (() => { const sel = h('select', {}, h('option', { value: 'mac' }, 'this Mac'), h('option', { value: 'pc', disabled: !e.far.reachable }, e.far.name + (e.far.reachable ? '' : ' (not reachable)'))); sel.value = e.where || 'mac';
              sel.onchange = () => api(`/api/engines/${e.id}/where`, { json: { where: sel.value } }).then(r => { toast(r.where === 'pc' ? 'ACE-Step now runs on ' + e.far.name : 'ACE-Step now runs on this Mac'); draw(); }).catch(x => { toast(String(x.message || x), true); draw(); }); return sel; })()),
          h('div', { class: 'acts' }, h('button', { onclick: async () => { await api(`/api/engines/${e.id}/install`, { method: 'POST' }); logs[e.id] = {}; draw(); } }, e.installed ? 'reinstall' : 'install'),
            e.running && h('button', { onclick: () => api(`/api/engines/${e.id}/unload`, { method: 'POST' }).then(draw) }, 'unload')),
          logs[e.id] && h('pre', { data: { log: e.id } }, logs[e.id].log || 'starting…'))));
      body.scrollTop = scroll; body.querySelectorAll('pre').forEach(p => p.scrollTop = p.scrollHeight);
      Object.values(S.nodes).forEach(n => { if (ENG[n.type] && !(R[n.id] || {}).state?.match(/running|waiting/)) { const el = nodeEls.get(n.id); if (el && !!el.querySelector('.badge') === !!ENG[n.type].installed) renderNode(n); } });
    };
    draw(); drawerTimer = setInterval(draw, 2500);
  }
}
/* ---------- library: everything that was made, in one place ---------- */
const LIB = { tab: 'all', q: '', source: '', creature: '', stars: false, items: [], audio: null, playing: null };
const libDay = w => { const d = new Date((w || '').replace(' ', 'T')), t = new Date(), y = new Date(Date.now() - 864e5), same = (a, b) => a.toDateString() === b.toDateString();
  return isNaN(d) ? 'earlier' : same(d, t) ? 'today' : same(d, y) ? 'yesterday' : d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }); };
const libSize = n => n > 1e9 ? (n / 1e9).toFixed(1) + ' GB' : n > 1e6 ? (n / 1e6).toFixed(n > 1e7 ? 0 : 1) + ' MB' : Math.max(1, Math.round(n / 1e3)) + ' KB';
function libPlay(it) {
  if (!LIB.audio) { LIB.audio = new Audio(); LIB.audio.onended = () => { LIB.playing = null; libraryDraw(); }; try { ac().createMediaElementSource(LIB.audio).connect(bus()); } catch {} }
  if (LIB.playing === it.path) { LIB.audio.pause(); LIB.playing = null; } else { ac().resume(); LIB.audio.src = fileUrl(it.path); LIB.audio.play().catch(e => toast('could not play that: ' + e.message, true)); LIB.playing = it.path; }
  libraryDraw();
}
function libPreview(it) {                           // a still or a video, large
  const close = () => ov.remove(), ov = h('div', { class: 'lib-over', onclick: e => { if (e.target === ov) close(); } },
    it.kind === 'video' ? h('video', { src: fileUrl(it.path), controls: true, autoplay: true, loop: true }) : h('img', { src: fileUrl(it.path) }),
    h('div', { class: 'lib-over-bar' }, h('span', {}, it.title), h('button', { onclick: () => api('/api/reveal', { json: { path: it.path } }) }, 'show in finder'), h('button', { onclick: close }, 'close')));
  document.body.append(ov);
}
async function libTrash(it, btn) {
  if (!btn.dataset.armed) { btn.dataset.armed = '1'; btn.textContent = 'sure?'; btn.classList.add('armed'); setTimeout(() => { if (btn.isConnected) { delete btn.dataset.armed; btn.textContent = '×'; btn.classList.remove('armed'); } }, 3000); return; }
  try { await api('/api/made/trash', { json: { path: it.path } }); LIB.items = LIB.items.filter(x => x.path !== it.path); if (LIB.playing === it.path) { LIB.audio.pause(); LIB.playing = null; } libraryDraw(); toast('moved to the Trash'); } catch (e) { toast('could not delete: ' + e.message, true); }
}
async function libStar(it) { it.star = !it.star; libraryDraw(); try { await api('/api/made/star', { json: { path: it.path, on: it.star } }); } catch { it.star = !it.star; libraryDraw(); } }
function libraryDraw() {
  const list = $('#lib-list'); if (!list) return;
  const q = LIB.q.toLowerCase(), want = LIB.tab === 'all' ? null : LIB.tab;
  const items = LIB.items.filter(it => (!want || it.kind === want) && (!LIB.stars || it.star) && (!LIB.source || it.source === LIB.source) && (!LIB.creature || it.creature === LIB.creature)
    && (!q || (it.title + ' ' + it.name + ' ' + it.source + ' ' + it.creature + ' ' + it.model).toLowerCase().includes(q)));
  const counts = k => LIB.items.filter(it => k === 'all' || it.kind === k).length;
  $('#lib-tabs').replaceChildren(...[['all', 'all'], ['audio', 'audio'], ['midi', 'midi'], ['still', 'stills'], ['video', 'videos']].map(([k, label]) =>
    h('button', { class: LIB.tab === k ? 'on' : '', onclick: () => { LIB.tab = k; libraryDraw(); } }, `${label} ${counts(k)}`)));
  if (!items.length) { list.replaceChildren(h('p', { class: 'lib-empty' }, LIB.items.length ? 'Nothing matches these filters.' : 'Nothing here yet. Everything you make lands here.')); return; }
  const days = []; for (const it of items) { const dname = libDay(it.when); if (!days.length || days[days.length - 1].name !== dname) days.push({ name: dname, items: [] }); days[days.length - 1].items.push(it); }
  const meta = it => [it.source, it.creature && '◍ ' + it.creature.replace(/-/g, ' '), (it.when || '').slice(11, 16), it.seed != null && it.seed !== -1 && 'seed ' + it.seed, libSize(it.size)].filter(Boolean).join(' · ');
  const tools = it => h('div', { class: 'lib-tools' },
    h('button', { class: 'lib-star' + (it.star ? ' on' : ''), title: it.star ? 'Remove the star' : 'Star this as a keeper', onclick: () => libStar(it) }, it.star ? '★' : '☆'),
    it.kind === 'audio' && h('button', { title: 'Add to the canvas as a sample', onclick: () => { addNode('sample', undefined, undefined, { file: { path: it.path, name: it.name } }); toast('added to the canvas'); } }, '+ canvas'),
    h('button', { title: 'Show in Finder', onclick: () => api('/api/reveal', { json: { path: it.path } }) }, '↗'),
    h('button', { class: 'lib-del', title: 'Move to the Trash (click twice)', onclick: e => libTrash(it, e.currentTarget) }, '×'));
  list.replaceChildren(...days.flatMap(dy => {
    const rows = dy.items.filter(it => it.kind === 'audio' || it.kind === 'midi'), tiles = dy.items.filter(it => it.kind === 'still' || it.kind === 'video');
    return [h('h5', { class: 'lib-day' }, `${dy.name} · ${dy.items.length}`),
      tiles.length && h('div', { class: 'lib-grid' }, tiles.map(it => h('div', { class: 'lib-tile' },
        h('button', { class: 'lib-thumb', title: 'Open', onclick: () => libPreview(it) }, h('img', { loading: 'lazy', src: '/api/thumb?path=' + encodeURIComponent(it.path) }), it.kind === 'video' && h('i', {}, it.source === 'film' ? '▶ film' : '▶ time-lapse')),
        h('div', { class: 'lib-what', title: it.name }, it.title), h('div', { class: 'lib-meta' }, meta(it)), tools(it)))),
      ...rows.map(it => h('div', { class: 'lib-row' + (LIB.playing === it.path ? ' playing' : '') },
        it.kind === 'audio' ? h('button', { class: 'lib-pp', title: 'Play / stop', onclick: () => libPlay(it) }, LIB.playing === it.path ? '■' : '▶') : h('span', { class: 'lib-pp midi' }, '♪'),
        h('div', { class: 'lib-text' }, h('div', { class: 'lib-what', title: it.title + '\n' + it.name }, it.title), h('div', { class: 'lib-meta' }, meta(it))), tools(it)))];
  }).filter(Boolean));
}
async function libraryOpen(body) {
  const q = h('input', { placeholder: 'search…', spellcheck: 'false', value: LIB.q, oninput: e => { LIB.q = e.target.value; clearTimeout(q._t); q._t = setTimeout(libraryDraw, 150); } });
  const src = h('select', { title: 'Made by', onchange: e => { LIB.source = e.target.value; libraryDraw(); } }), cre = h('select', { title: 'Creature', onchange: e => { LIB.creature = e.target.value; libraryDraw(); } });
  const starB = h('button', { class: LIB.stars ? 'on' : '', title: 'Show only starred', onclick: () => { LIB.stars = !LIB.stars; starB.classList.toggle('on', LIB.stars); libraryDraw(); } }, '★ only');
  body.append(h('div', { id: 'lib-tabs' }), h('div', { class: 'lib-filters' }, q, src, cre, starB, h('button', { onclick: () => api('/api/reveal', { json: {} }) }, 'open folder')), h('div', { id: 'lib-list' }, h('p', { class: 'lib-empty' }, 'loading…')));
  try { LIB.items = await api('/api/made'); } catch (e) { LIB.items = []; toast('could not read the library: ' + e.message, true); }
  if (drawerKind !== 'library') return;
  const uniq = k => [...new Set(LIB.items.map(it => it[k]).filter(Boolean))].sort();
  src.replaceChildren(h('option', { value: '' }, 'made by anything'), ...uniq('source').map(v => h('option', { value: v, selected: v === LIB.source }, v)));
  cre.replaceChildren(h('option', { value: '' }, 'any creature'), ...uniq('creature').map(v => h('option', { value: v, selected: v === LIB.creature }, '◍ ' + v.replace(/-/g, ' '))));
  libraryDraw();
}

async function refreshEngines() { try { for (const e of await api('/api/engines')) ENG[e.id] = e; } catch {} }

/* ---------- patches ---------- */
async function refreshPatches() {
  const names = await api('/api/patches'), s = $('#patch-load');
  s.replaceChildren(h('option', { value: '' }, 'load…'), ...names.map(n => h('option', { value: n }, n)), h('option', { value: '__demo' }, 'demo circuit'));
}
function loadPatch(p) {
  for (const id of Object.keys(S.nodes)) dropPlayers(id);
  nodeEls.forEach(e => e.remove()); nodeEls.clear(); for (const k of Object.keys(R)) delete R[k];
  S = { nodes: p.nodes || {}, cables: (p.cables || []).filter(c => p.nodes[c.from.node] && p.nodes[c.to.node]), view: p.view || { x: 80, y: 90, k: 1 } };
  applyView(); Object.values(S.nodes).forEach(renderNode); select(null); save();
}
$('#patch-save').onclick = async () => {
  const name = $('#patch-name').value.trim(); if (!/^[\w\- ]{1,40}$/.test(name)) return toast('give the circuit a simple name first', true);
  await api('/api/patches/' + encodeURIComponent(name), { method: 'PUT', json: S }); toast('saved “' + name + '”'); refreshPatches();
};
$('#patch-load').onchange = async e => {
  const v = e.target.value; e.target.value = ''; if (!v) return;
  if (v === '__demo') { loadPatch(demoPatch()); return fit(); }
  const p = await api('/api/patches/' + encodeURIComponent(v)); if (p) { loadPatch(p); $('#patch-name').value = v; }
};
$('#patch-clear').onclick = () => { if (Object.keys(S.nodes).length && confirm('Remove every module from the canvas? Your generated files stay in the library.')) loadPatch({ nodes: {}, cables: [] }); };
function demoPatch() {
  const has = id => ENG[id], nodes = {}, cables = [];
  const add = (id, type, x, y, params = {}) => { if (type === 'sample' || has(type)) nodes[id] = { id, type, x, y, params, adv: false, result: null }; };
  add('src', 'sample', 0, 120); add('stems', 'demucs', 380, 60);
  add('jam', 'musicgen', 780, -40, { model: 'facebook/musicgen-small', prompt: 'continue this groove, add a hypnotic acid bassline', duration: 12 });
  add('notes', 'basic_pitch', 780, 520); add('song', 'ace_step', 1180, 120, { duration: 60 });
  const wire = (a, ap, b, bp) => { if (nodes[a] && nodes[b]) cables.push({ id: uid(), from: { node: a, port: ap }, to: { node: b, port: bp } }); };
  wire('src', 'out', 'stems', 'audio'); wire('stems', 'drums', 'jam', 'audio'); wire('stems', 'bass', 'notes', 'audio');
  return { nodes, cables, view: { x: 90, y: 130, k: 0.85 } };
}

/* ---------- claude chat ---------- */
let chatSession = null, chatBusy = false;
const chatLog = $('#chat-log');
function chatMsg(cls, text) { const m = h('div', { class: cls }, text); chatLog.append(m); chatLog.scrollTop = chatLog.scrollHeight; return m; }
function toggleChat(on) { const c = $('#chat'); c.hidden = on === undefined ? !c.hidden : !on; if (!c.hidden) { if (!chatLog.children.length) chatMsg('msg-c', 'Tell me what you want to hear, or what to change. I can add modules, wire them, set any knob and run the circuit.'); $('#chat-in').focus(); } }
$('#btn-chat').onclick = () => toggleChat(); $('#chat-close').onclick = () => toggleChat(false);
$('#chat-new').onclick = () => { chatSession = null; chatLog.replaceChildren(); toggleChat(true); };
function patchSummary() {                         // what Claude sees: settings and wiring, never audio
  return {
    modules: Object.values(S.nodes).map(n => ({
      id: n.id, type: n.type, params: n.type === 'sample' ? undefined : n.params,
      file: n.type === 'sample' ? (n.file ? n.file.name : null) : undefined,
      state: (R[n.id] || {}).state || (n.result ? 'done' : 'idle'), error: (R[n.id] || {}).state === 'error' ? (R[n.id].msg || '').slice(0, 300) : undefined,
      result: n.result ? { outputs: n.result.outputs.map(o => o.label), seed: n.result.seed, info: n.result.info } : null })),
    cables: S.cables.map(c => ({ from: c.from.node, from_port: c.from.port, to: c.to.node, to_port: c.to.port })),
  };
}
function applyActions(actions) {
  const ids = {}, done = [], fresh = [], toRun = []; let runEverything = false;
  const N = id => S.nodes[ids[id] || id];
  for (const a of actions) {
    try {
      if (a.op === 'add') {
        if (a.type !== 'sample' && !ENG[a.type]) throw new Error('unknown module ' + a.type);
        const n = addNode(a.type, -99999, -99999, { params: a.params || {} }); ids[a.id || n.id] = n.id; fresh.push(n.id); done.push(['+ ' + (a.type), 1]);
      } else if (a.op === 'set') { const n = N(a.node); if (!n) throw new Error('no module ' + a.node); Object.assign(n.params, a.params || {}); n.adv = n.adv || Object.keys(a.params || {}).some(k => ((ENG[n.type].params || []).find(p => p.name === k) || {}).advanced); renderNode(n); done.push(['set ' + Object.keys(a.params || {}).join(', '), 1]); }
      else if (a.op === 'connect') { const f = N(a.from), t = N(a.to); if (!f || !t) throw new Error('cannot wire that'); const port = a.to_port || (audioParams(ENG[t.type])[0] || {}).name; if (!audioParams(ENG[t.type] || {}).some(p => p.name === port)) throw new Error('no input ' + port); connect({ node: f.id, port: a.from_port || outNames(f)[0] }, { node: t.id, port }); done.push(['wire ' + (a.from_port || 'out') + ' → ' + t.type, 1]); }
      else if (a.op === 'disconnect') { const t = N(a.to), c = t && S.cables.find(c => c.to.node === t.id && (!a.to_port || c.to.port === a.to_port)); if (c) removeCable(c.id); done.push(['unwire', 1]); }
      else if (a.op === 'remove') { const n = N(a.node); if (n) removeNode(n.id); done.push(['− module', 1]); }
      else if (a.op === 'run') { const n = N(a.node); if (!n) throw new Error('no module ' + a.node); toRun.push(n.id); done.push(['run ' + n.type, 1]); }
      else if (a.op === 'run_all') { runEverything = true; done.push(['run circuit', 1]); }
      else if (a.op === 'clear') { loadPatch({ nodes: {}, cables: [] }); done.push(['clear', 1]); }
    } catch (err) { done.push([String(err.message || err), 0]); }
  }
  // lay new modules out: right of what feeds them, otherwise in a free column
  for (const id of fresh) {
    const n = S.nodes[id]; if (!n) continue;
    const ups = S.cables.filter(c => c.to.node === id).map(c => S.nodes[c.from.node]).filter(u => u.x > -9000);
    const others = Object.values(S.nodes).filter(o => o.id !== id && o.x > -9000);
    let x = ups.length ? Math.max(...ups.map(u => u.x)) + 400 : (others.length ? Math.min(...others.map(o => o.x)) : 0);
    let y = ups.length ? Math.min(...ups.map(u => u.y)) : (others.length ? Math.max(...others.map(o => o.y + (nodeEls.get(o.id)?.offsetHeight || 400))) + 50 : 0);
    const hgt = nodeEls.get(id)?.offsetHeight || 400;
    while (others.some(o => Math.abs(o.x - x) < 330 && y < o.y + (nodeEls.get(o.id)?.offsetHeight || 400) + 30 && o.y < y + hgt + 30)) y += 60;
    n.x = Math.round(x); n.y = Math.round(y); renderNode(n);
  }
  if (fresh.length) setTimeout(fit, 60);
  save();
  if (runEverything) runAll(); else { const memo = new Map(); toRun.forEach(id => runNode(id, memo, false).catch(() => {})); }
  return done;
}
$('#chat-form').onsubmit = async e => {
  e.preventDefault(); const box = $('#chat-in'), text = box.value.trim(); if (!text || chatBusy) return;
  chatBusy = true; box.value = ''; chatMsg('msg-u', text); const think = chatMsg('msg-c think', 'thinking…');
  try {
    const r = await api('/api/chat', { json: { message: text, patch: patchSummary(), session: chatSession } });
    chatSession = r.session || chatSession; think.remove();
    const m = chatMsg('msg-c', r.say || 'done.'), done = applyActions(r.actions || []);
    if (done.length) m.append(h('div', { class: 'acts-done' }, done.map(([t, ok]) => h('span', { class: ok ? '' : 'bad' }, t))));
  } catch (err) { think.remove(); chatMsg('msg-c err', String(err.message || err)); }
  chatBusy = false; chatLog.scrollTop = chatLog.scrollHeight;
};
$('#chat-in').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#chat-form').requestSubmit(); } });

/* ---------- keys ---------- */
addEventListener('keydown', e => {
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); return runAll(); }
  if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); return toggleChat(); }
  if (typeof Gym !== 'undefined' && Gym.open) { if (e.key === 'Escape' && !typing) closeGym(); return; }
  if (typing) return;
  if ((e.key === 'Backspace' || e.key === 'Delete') && sel) { e.preventDefault(); sel.node ? removeNode(sel.node) : removeCable(sel.cable); select(null); }
  if (e.key === 'f') fit();
  if (e.key === 'Tab' || e.key === ' ') { e.preventDefault(); openPalette(innerWidth / 2 - 125, innerHeight / 2 - 150); }
  if (e.key === 'Escape') { closePalette(); openDrawer(null); select(null); }
});
addEventListener('resize', drawCables);

/* ---------- boot ---------- */
(async function boot() {
  const meta = await api('/api/meta'); document.title = meta.name; $('#word').textContent = meta.name; $('#btn-chat').hidden = !meta.claude;
  await refreshEngines(); buildDock(); refreshPatches();
  const saved = await api('/api/patches/autosave').catch(() => null);
  if (saved && saved.nodes && Object.keys(saved.nodes).length) loadPatch(saved);
  else { loadPatch(demoPatch()); requestAnimationFrame(fit); }
  status('ready_');
})();

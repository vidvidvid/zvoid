/* The gym: raise creatures (ACE-Step adapters) on your own audio and watch them grow. */
'use strict';

const Gym = { list: [], cur: null, key: '', open: false, mouse: { x: 0, y: 0 }, raf: 0, timer: 0 };
const hash = s => { let x = 2166136261; for (const c of String(s)) { x ^= c.charCodeAt(0); x = Math.imul(x, 16777619); } return (x >>> 0) / 4294967296; };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/* ---------- what the creature is made of ---------- */
function dna(c) {
  const F = c.food || [], n = F.length, w = F.map(f => f.secs || 1), W = w.reduce((a, b) => a + b, 0) || 1;
  const avg = (k, d) => n ? F.reduce((a, f, i) => a + (f[k] ?? d) * w[i], 0) / W : d;
  const H = c.history || [], first = H.length ? H[0][1] : null, last = H.length ? H[H.length - 1][1] : null;
  const tr = c.training && c.training.state === 'running';
  return { n, F, seed: hash(c.slug), minutes: c.minutes || 0, epochs: c.epochs || 0, growth: 1 - Math.exp(-(c.epochs || 0) / 180),
    low: avg('low', .3), high: avg('high', .1), bright: avg('bright', .3), dyn: avg('dyn', .3), noise: avg('noise', .2), bpm: avg('bpm', 70), loud: avg('loud', .3),
    learned: first && last ? clamp((first - last) / first * 3, 0, 1) : 0, training: tr, digesting: tr && c.training.stage !== 'train', step: tr ? c.training.step : 0 };
}
const hueOf = bright => 285 - clamp(bright, 0, 1) * 230;            // dark & bassy = violet, bright = acid yellow-green

function drawCreature(g, W, H, c, t, mouse) {
  const d = dna(c), cx = W / 2, cy = H / 2, S = Math.min(W, H);
  g.clearRect(0, 0, W, H);
  const hue = hueOf(d.bright), hue2 = (hue + 50 + d.seed * 140) % 360;
  const beat = d.bpm / 60 * (d.training ? 1.6 : 1), pulse = .5 + .5 * Math.sin(t * beat * Math.PI);
  let R = S * (d.n ? .1 + .04 * clamp(d.minutes / 20, 0, 1) + .07 * d.growth : .07);
  R *= 1 + (.02 + d.dyn * .04) * pulse;
  g.lineCap = 'round'; g.lineJoin = 'round';

  if (!d.n) {                                                        // egg: nothing eaten yet
    g.save(); g.translate(cx, cy); g.rotate(Math.sin(t * .8) * .06);
    g.shadowColor = '#a43cff'; g.shadowBlur = 40 + pulse * 30; g.strokeStyle = '#6d5a9c'; g.lineWidth = 1.5; g.setLineDash([3, 7]);
    g.beginPath(); g.ellipse(0, 0, R * .8, R, 0, 0, 7); g.stroke(); g.setLineDash([]);
    const gr = g.createRadialGradient(0, R * .1, 0, 0, 0, R); gr.addColorStop(0, `rgba(164,60,255,${.25 + pulse * .2})`); gr.addColorStop(1, 'rgba(164,60,255,0)');
    g.fillStyle = gr; g.beginPath(); g.ellipse(0, 0, R * .8, R, 0, 0, 7); g.fill(); g.restore();
    return;
  }

  // spores: training steps drifting in to be eaten
  if (d.training) {
    for (let i = 0; i < 46; i++) {
      const a = i * 2.399 + t * .15, life = ((t * (.18 + (i % 5) * .03) + i * .137) % 1), rr = R * (5.5 - life * 4.8);
      g.fillStyle = `hsla(${(hue2 + i * 9) % 360},95%,70%,${life * .9})`;
      g.beginPath(); g.arc(cx + Math.cos(a + life * 2) * rr, cy + Math.sin(a + life * 2) * rr, 1 + life * 2.2, 0, 7); g.fill();
    }
  }

  // tentacles: one per track it ate
  const segs = 26;
  d.F.forEach((f, i) => {
    const th = hueOf(f.bright ?? .3), base = (i / d.n) * Math.PI * 2 + d.seed * 6.28 + Math.sin(t * .23 + i * 1.7) * .12;
    const len = R * (1.1 + clamp(Math.sqrt((f.secs || 20) / 30), .4, 3) * (.45 + d.growth * 1.7));
    const amp = R * (.12 + (f.dyn ?? .3) * .35), freq = 1.5 + (f.bpm ?? 100) / 60, speed = (f.bpm ?? 100) / 60 * (d.training ? 3 : 1.6);
    const w0 = R * (.1 + (f.low ?? .3) * .32);
    let px = cx + Math.cos(base) * R * .8, py = cy + Math.sin(base) * R * .8;
    g.shadowColor = `hsl(${th},95%,60%)`; g.shadowBlur = 14;
    for (let s = 1; s <= segs; s++) {
      const u = s / segs, off = Math.sin(u * freq * 2 - t * speed + i * 2.1) * amp * u, ang = base + Math.sin(t * .4 + i) * .15 * u;
      const x = cx + Math.cos(ang) * (R * .8 + len * u) + Math.cos(ang + 1.5708) * off, y = cy + Math.sin(ang) * (R * .8 + len * u) + Math.sin(ang + 1.5708) * off;
      g.strokeStyle = `hsla(${th + u * 40},92%,${52 + u * 18}%,${(.35 + d.growth * .55) * (1 - u * .35)})`;
      g.lineWidth = Math.max(1, w0 * (1 - u) ** 1.4);
      g.beginPath(); g.moveTo(px, py); g.lineTo(x, y); g.stroke(); px = x; py = y;
    }
    if (d.epochs) { g.fillStyle = `hsl(${th + 40},100%,80%)`; g.beginPath(); g.arc(px, py, 2 + d.growth * 3 + pulse * 1.5, 0, 7); g.fill(); }
  });

  // body: lobes from bass, spikes from treble, jitter until it has learned
  const lowA = .05 + d.low * .28, highA = clamp(d.high * 1.4 + d.noise * .06, .01, .24), spikes = 7 + Math.round(d.seed * 6), jit = (1 - d.learned) * (d.epochs ? .035 : .015);
  const rad = a => R * (1 + lowA * Math.sin(2 * a + d.seed * 9 + t * .31) + lowA * .6 * Math.sin(3 * a + d.seed * 4 - t * .22)
    + highA * Math.sin(spikes * a + t * 1.4) * (.6 + .4 * pulse) + jit * Math.sin(a * 23 + t * 9) + jit * Math.sin(a * 41 - t * 13));
  const body = new Path2D();
  for (let i = 0; i <= 160; i++) { const a = i / 160 * Math.PI * 2, r = rad(a), x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r; i ? body.lineTo(x, y) : body.moveTo(x, y); }
  body.closePath();
  const alpha = .35 + d.growth * .55, gr = g.createRadialGradient(cx - R * .25, cy - R * .3, R * .05, cx, cy, R * 1.35);
  gr.addColorStop(0, `hsla(${hue},100%,82%,${alpha})`); gr.addColorStop(.45, `hsla(${hue},92%,56%,${alpha * .9})`); gr.addColorStop(1, `hsla(${hue2},90%,34%,${alpha * .75})`);
  g.shadowColor = `hsl(${hue},95%,60%)`; g.shadowBlur = 30 + pulse * 40 * (.4 + d.loud) + (d.training ? 30 : 0);
  g.fillStyle = gr; g.fill(body); g.shadowBlur = 0;
  g.strokeStyle = `hsla(${hue2},100%,80%,${.35 + d.growth * .4})`; g.lineWidth = 1.2; g.stroke(body);

  // organs: more with every doubling of training
  const organs = clamp(Math.floor(Math.log2(d.epochs + 1) / 1.4), 0, 7);
  for (let i = 0; i < organs; i++) {
    const a = t * (.3 + i * .07) * (i % 2 ? 1 : -1) + i * 2.1, rr = R * (.25 + .09 * i) * .8;
    g.fillStyle = `hsla(${(hue2 + i * 35) % 360},100%,78%,.75)`; g.beginPath(); g.arc(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, R * .05 + pulse * 1.2, 0, 7); g.fill();
  }

  // eyes: it opens them once it has trained
  const eyes = d.epochs ? 1 + Math.floor(d.growth * 4.2) : 0, blink = (Math.sin(t * .7 + d.seed * 20) > .985) ? .12 : 1;
  for (let i = 0; i < eyes; i++) {
    const spread = eyes === 1 ? 0 : (i / (eyes - 1) - .5), ex = cx + spread * R * 1.15, ey = cy - R * (.18 + .12 * Math.cos(spread * 3.1)) , er = R * (eyes > 2 ? .15 : .2) * (1 - Math.abs(spread) * .35);
    g.fillStyle = '#f6f4ff'; g.beginPath(); g.ellipse(ex, ey, er, er * blink, 0, 0, 7); g.fill();
    const dx = (mouse ? mouse.x : cx) - ex, dy = (mouse ? mouse.y : cy) - ey, dl = Math.hypot(dx, dy) || 1, k = Math.min(er * .42, dl * .05);
    g.fillStyle = '#05050a'; g.beginPath(); g.ellipse(ex + dx / dl * k, ey + dy / dl * k * blink, er * .5, er * .5 * blink, 0, 0, 7); g.fill();
    g.fillStyle = `hsl(${hue2},100%,70%)`; g.beginPath(); g.arc(ex + dx / dl * k - er * .15, ey + dy / dl * k * blink - er * .15, er * .12, 0, 7); g.fill();
  }
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
  }
  document.querySelectorAll('canvas.mini-creature').forEach(m => {
    const c = Gym.list.find(x => x.slug === m.dataset.slug); if (!c) return;
    const g = m.getContext('2d'); if (m.width !== 112) { m.width = 112; m.height = 112; } g.setTransform(2, 0, 0, 2, 0, 0); drawCreature(g, 56, 56, c, t, null);
  });
  Gym.raf = requestAnimationFrame(gymFrame);
}
const stageName = c => !c.food.length ? 'egg' : !c.epochs ? 'larva' : c.epochs < 60 ? 'hatchling' : c.epochs < 250 ? 'juvenile' : c.epochs < 800 ? 'adult' : 'elder';

function gymRender() {
  const c = Gym.cur, tr = c && c.training, running = !!(tr && /running|stopping/.test(tr.state));
  const key = JSON.stringify([Gym.list.map(x => [x.slug, x.food.length, x.epochs, x.trained]), c && c.slug, c && c.food.map(f => f.name), running, c && c.trained]);
  if (key !== Gym.key) { Gym.key = key; gymBuild(); }
  if (!c) return;
  $('#gym-stats').textContent = `${stageName(c)} · ate ${c.food.length} track${c.food.length === 1 ? '' : 's'} (${c.minutes} min) · trained ${c.epochs} epoch${c.epochs === 1 ? '' : 's'}` + (c.history.length ? ` · loss ${c.history[c.history.length - 1][1].toFixed(3)}` : '');
  const st = $('#gym-status');
  st.textContent = tr ? (tr.state === 'error' ? '✖ ' + tr.error : tr.msg) : (c.trained ? 'ready. pick it in an ace-step module as “creature”.' : c.food.length ? 'fed, not trained yet.' : 'hungry. drop audio on it.');
  st.className = tr && tr.state === 'error' ? 'err' : '';
  const bar = $('#gym-bar i'); if (bar) bar.style.width = running && tr.max_epochs ? clamp((tr.epoch - (tr.max_epochs - (Gym.more || tr.max_epochs))) / (Gym.more || tr.max_epochs) * 100, 2, 100) + '%' : '0';
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

  const stage = h('div', { id: 'gym-stage' }, h('canvas', { id: 'gym-canvas' }),
    c ? h('div', { id: 'gym-caption' }, h('h1', {}, c.name), h('div', { id: 'gym-stats' })) : h('div', { id: 'gym-caption' }, h('h1', {}, 'no creatures yet'), h('div', {}, 'name one on the left and press hatch')));
  stage.addEventListener('mousemove', e => { const r = stage.getBoundingClientRect(); Gym.mouse = { x: e.clientX - r.left, y: e.clientY - r.top }; });

  const right = h('div', { id: 'gym-right' });
  if (c) {
    const saveId = () => api('/api/gym/' + c.slug, { method: 'PUT', json: { style: style.value, tag: tag.value } }).then(r => { Gym.cur = r; });
    const style = h('textarea', { rows: 2, spellcheck: 'false', placeholder: 'describe its sound in tags: dub techno, 120 bpm, tape hiss, deep chords', onchange: saveId }); style.value = c.style || '';
    const tag = h('input', { spellcheck: 'false', onchange: saveId }); tag.value = c.tag || '';
    const ep = h('input', { type: 'number', min: 1, max: 5000, step: 10, value: 100 }), rank = h('select', {}, [8, 16, 32, 64, 128].map(v => h('option', { value: v }, 'rank ' + v))); rank.value = (c.settings && c.settings.rank) || 64;
    const lr = h('select', {}, [['5e-5', 'gentle'], ['1e-4', 'normal'], ['2e-4', 'fast'], ['5e-4', 'reckless']].map(([v, l]) => h('option', { value: v }, `${l} (${v})`))); lr.value = '1e-4';
    const maxd = h('input', { type: 'number', min: 10, max: 600, step: 10, value: 240 });
    const go = fresh => { Gym.more = +ep.value || 100; gymDo(() => api(`/api/gym/${c.slug}/train`, { json: { epochs: Gym.more, rank: +rank.value, lr: +lr.value, max_duration: +maxd.value, fresh } })); };
    right.append(
      h('h3', {}, 'food'),
      h('div', { class: 'food' }, c.food.length ? c.food.map(f => {
        const cap = h('input', { spellcheck: 'false', placeholder: 'caption for this track (optional)', onchange: () => api('/api/gym/' + c.slug, { method: 'PUT', json: { captions: { [f.name]: cap.value } } }) }); cap.value = f.caption || '';
        return h('div', { class: 'food-row', style: `--c:hsl(${hueOf(f.bright ?? .3)},90%,60%)` }, h('i'), h('div', {}, h('b', { title: f.name }, f.name), h('small', {}, `${Math.round(f.secs)}s · ~${Math.round(f.bpm || 0)} bpm · bass ${Math.round((f.low || 0) * 100)}% · bright ${Math.round((f.bright || 0) * 100)}%`), cap),
          h('button', { title: 'Take this track away', disabled: running, onclick: () => gymDo(() => api(`/api/gym/${c.slug}/food/${encodeURIComponent(f.name)}`, { method: 'DELETE' })) }, '×'));
      }) : h('p', { class: 'gym-note' }, 'Nothing yet. Drop audio files anywhere on this screen.')),
      h('div', { class: 'acts' }, h('button', { disabled: running, onclick: () => { const i = $('#gym-pick'); i.value = ''; i.click(); } }, '+ feed files…'), h('button', { disabled: running, title: 'Pick a folder. Tracks are linked where they are, not copied.', onclick: gymPickFolder }, '+ feed a folder…')),
      h('h3', {}, 'identity'),
      h('label', { title: 'Used as the caption for every track that has no caption of its own. Good tags make a much better creature.' }, h('span', {}, 'its sound, in tags'), style),
      h('label', { title: 'A made-up word the model learns to associate with this sound. Zvoid adds it to your caption automatically when the creature is active.' }, h('span', {}, 'trigger word'), tag),
      h('h3', {}, 'training'),
      h('div', { class: 'gym-grid' },
        h('label', { title: 'How many more passes over the food. 100–300 is a good first session for 10–30 tracks.' }, h('span', {}, 'epochs to add'), ep),
        h('label', { title: 'Capacity of the adapter. Higher learns more detail but can memorise.' }, h('span', {}, 'capacity'), rank),
        h('label', { title: 'How big each learning step is.' }, h('span', {}, 'learning rate'), lr),
        h('label', { title: 'Longer tracks are cut to this many seconds.' }, h('span', {}, 'max seconds / track'), maxd)),
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
    sum.textContent = `${sel.length} of ${res.files.length} selected · ~${Math.round(mins)} min of training audio` + (sel.length > 60 ? ' · that is a lot: each epoch will be slow' : '');
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
    const paths = [...chosen]; feedB.disabled = true; let skipped = [];
    for (let i = 0; i < paths.length; i += 5) {
      sum.textContent = `eating ${Math.min(i + 5, paths.length)} / ${paths.length}…`;
      try { const r = await api(`/api/gym/${Gym.cur.slug}/feed_links`, { json: { paths: paths.slice(i, i + 5) } }); skipped = skipped.concat(r.skipped || []); Gym.cur = r; }
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

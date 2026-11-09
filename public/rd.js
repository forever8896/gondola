// Gondola: landing → stage → horizontal gallery of 26 cards (Original + 25 designs), driven by the run's SSE stream.
'use strict';
const $ = s => document.querySelector(s);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const host = u => { try { return new URL(u).host.replace(/^www\./, ''); } catch { return u || ''; } };
const pretty = s => s ? String(s).replace(/[-_]+/g, ' ').replace(/^./, c => c.toUpperCase()) : 'Design';
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const touch = matchMedia('(hover: none)').matches;
const mobile = () => innerWidth <= 720;
const root = document.documentElement;
const body = document.body;

// ---------------------------------------------------------------- state
let me = null;                        // /api/me: last/active run, optional operator limit
// A published share page sets window.GONDOLA_SHARE = { id, base }: a finished run served as static files.
const SHARE = window.GONDOLA_SHARE || null;
let runId = null, API = '', run = null, contentOrigin = '', queuePos = null, notFound = false;
const designs = new Map();            // n → design (publicDesign)
const cards = new Map();              // key ('o' | n) → card handle
let order = ['o'];                    // keys in row order
let focusKey = 'o';
let loadedOnce = false;
const doneSeen = new Set();           // designs already done when we first saw them (no toast for those)
let origShot = false, origLoading = false;
let cardW = 940;

// ---------------------------------------------------------------- layout
function layout() {
  const vw = innerWidth, vh = innerHeight;
  let w;
  if (mobile()) w = Math.round(vw * 0.88);
  else {
    const top = parseFloat(getComputedStyle(root).getPropertyValue('--stage-top')) || 104;
    const byHeight = (vh - top - 36 - 28 - 46 - 70) / 0.625;   // label above, url bar, shadow room, filmstrip
    w = Math.round(Math.max(300, Math.min(940, vw * 0.68, byHeight)));
  }
  cardW = w;
  root.style.setProperty('--w', w + 'px');
  root.style.setProperty('--scale', String((w - 2) / 1440));
  recenter();
  updateTransforms();
  renderTopLabel();
}
addEventListener('resize', () => requestAnimationFrame(layout));

// ---------------------------------------------------------------- landing
const input = $('#url'), form = $('#go');

function fmtReset(at) {
  const ms = new Date(at) - Date.now();
  if (!(ms > 0)) return 'resets soon';
  const h = Math.floor(ms / 3600_000), m = Math.ceil((ms % 3600_000) / 60_000);
  return h >= 1 ? `resets in ${h} h` : `resets in ${m} min`;
}
function renderRunsLeft() {
  if (!me) return;
  // Self-hosted: nothing about limits is shown unless the operator set DAILY_RUN_LIMIT and it is used up.
  const blocked = me.daily_limit && me.runs_left_today === 0 && !me.admin;
  body.classList.toggle('is-empty', !!blocked && !runId);
  input.disabled = !!blocked;
  const line = $('#runsleft');
  line.textContent = blocked ? `Today's runs are used up · ${fmtReset(me.resets_at)}` : '';
  const lr = $('#lastrun');
  const r = me.active_run || me.last_run;
  if (r && !runId) {
    lr.hidden = false; lr.href = '/r/' + r.id;
    lr.textContent = me.active_run ? `Your run on ${host(r.url)} is in progress →` : `Your last run: ${host(r.url)} →`;
  } else lr.hidden = true;
  renderTopLabel();
}
function rollRunsLeft(n) {
  const num = $('#runsnum');
  if (!num) return;
  if (reduced) { num.textContent = n; return; }
  num.classList.add('out');
  setTimeout(() => { num.textContent = n; num.classList.remove('out'); num.classList.add('in'); setTimeout(() => num.classList.remove('in'), 420); }, 400);
}
async function loadMe() {
  try { const r = await fetch('/api/me'); if (r.ok) me = await r.json(); } catch {}
  renderRunsLeft();
}

input.addEventListener('input', () => {
  const v = input.value, s = v.replace(/^\s*https?:\/\//i, '');
  if (s !== v) input.value = s;
  hint('');
});
function hint(text) { const h = $('#hint'); h.textContent = text; h.classList.toggle('on', !!text); }
function shake() {
  if (reduced) return;
  form.classList.remove('shake'); void form.offsetWidth; form.classList.add('shake');
}
const looksLikeDomain = s => /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(\/\S*)?$/i.test(s);

form.addEventListener('submit', async e => {
  e.preventDefault();
  if (input.disabled || form.classList.contains('checking')) return;
  const s = input.value.trim().replace(/^https?:\/\//i, '');
  if (!looksLikeDomain(s)) { hint(`That doesn't look like a domain · try ${s && !s.includes('.') ? s.replace(/[^a-z0-9-]/gi, '') || 'acme' : 'acme'}.com`); shake(); input.focus(); return; }
  form.classList.add('checking');
  try {
    const r = await fetch('/api/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'https://' + s }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      if (r.status === 429 && me?.active_run) return enterRun(me.active_run.id, true);
      throw new Error(j.error || 'Something went wrong. Try again.');
    }
    setTimeout(() => enterRun(j.id, true, 'https://' + s), reduced ? 0 : 150);
  } catch (err) {
    form.classList.remove('checking');
    hint(err.message); shake();
  }
});

// ---------------------------------------------------------------- enter the run view
function enterRun(id, animate, url) {
  runId = id; API = SHARE ? `${SHARE.base}data` : `/api/runs/${id}`;
  if (!SHARE && location.pathname !== '/r/' + id) history.pushState({ run: id }, '', '/r/' + id);
  if (!animate) { body.classList.add('no-anim'); }
  body.classList.remove('is-landing', 'is-empty');
  body.classList.add('is-run');
  if (!animate) requestAnimationFrame(() => requestAnimationFrame(() => body.classList.remove('no-anim')));
  if (url) run = { url, count: 25, status: 'queued' };
  ensureCard('o');
  toggleGrid(true);           // a run opens on the wall of all designs; clicking one opens the scroll view
  renderAll();
  layout();
  start();
}
addEventListener('popstate', () => location.reload());

// ---------------------------------------------------------------- cards
const CARD_HTML = `
  <div class="label" aria-hidden="true"><span></span></div>
  <div class="tilt">
    <div class="contact"></div><div class="floor"></div>
    <div class="body">
      <div class="bar"></div>
      <div class="screen">
        <div class="layer site"><img class="shot" alt="" decoding="async"></div>
        <div class="layer skeleton">
          <div class="r"><i style="width:8cqw;height:1.6cqw"></i><i></i><i class="ln" style="width:5cqw"></i><i class="ln" style="width:5cqw"></i><i style="width:7cqw;height:2.6cqw;border-radius:99px"></i></div>
          <i style="width:58%;height:9cqw;animation-delay:80ms"></i>
          <i class="ln" style="width:40%;animation-delay:160ms"></i>
          <i class="ln" style="width:34%;animation-delay:240ms"></i>
          <i style="height:22cqw;animation-delay:320ms"></i>
          <div class="cols"><i style="animation-delay:400ms"></i><i style="animation-delay:480ms"></i><i style="animation-delay:560ms"></i></div>
        </div>
        <div class="layer pill-caption"><span></span></div>
        <div class="layer ghost"></div>
        <div class="layer working"><div class="fam"></div><div class="act"><span></span></div><div class="steps"></div></div>
        <div class="layer flash"></div>
        <div class="layer failed-msg">This one didn't make it</div>
        <div class="layer scan"><span></span></div>
        <div class="layer controls">
          <div class="open-dot" aria-hidden="true">↗</div>
          <div class="ctl"><button class="btn copy" type="button">Copy prompt</button><a class="btn dark open" target="_blank" rel="noopener">Open ↗</a></div>
        </div>
      </div>
    </div>
  </div>`;

function buildCard(key, { grid = false } = {}) {
  const e = el('div', 'card');
  e.dataset.key = key;
  e.innerHTML = CARD_HTML;
  const c = {
    key, el: e, grid,
    label: e.querySelector('.label'), lname: e.querySelector('.label span'),
    tilt: e.querySelector('.tilt'), bar: e.querySelector('.bar'), screen: e.querySelector('.screen'),
    site: e.querySelector('.site'), shot: e.querySelector('.shot'),
    pill: e.querySelector('.pill-caption span'), ghost: e.querySelector('.ghost'),
    wFam: e.querySelector('.working .fam'), wAct: e.querySelector('.working .act span'), wSteps: e.querySelector('.working .steps'),
    scan: e.querySelector('.scan span'), copy: e.querySelector('.copy'), open: e.querySelector('.open'),
    iframe: null, ready: false, hover: false, state: '',
  };
  c.shot.onload = () => { c.site.classList.add('on'); if (key === 'o') { e.classList.add('has-shot'); } };
  if (!grid) {
    c.copy.addEventListener('click', ev => { ev.stopPropagation(); copyPrompt(key, c.copy); });
    c.open.addEventListener('click', ev => ev.stopPropagation());
    e.querySelector('.ctl').addEventListener('click', ev => ev.stopPropagation());   // a near-miss next to the buttons does nothing
    c.screen.addEventListener('mouseenter', () => { c.hover = true; syncPlayback(); });
    c.screen.addEventListener('mouseleave', () => { c.hover = false; clearTimeout(c.resume); c.resume = setTimeout(syncPlayback, 1200); });
    e.addEventListener('click', () => onCardClick(c));
  } else {
    e.querySelector('.controls').remove();
  }
  return c;
}
function ensureCard(key) {
  if (cards.has(key)) return cards.get(key);
  const c = buildCard(key);
  cards.set(key, c);
  $('#track').append(c.el);
  return c;
}

function dState(d) {
  switch (d.status) {
    case 'done': return 'done';
    case 'failed': return 'failed';
    case 'capturing': return 'capturing';
    case 'working': return 'working';
    case 'forking': return d.last_action === 'waiting for a start slot' ? 'waiting' : 'starting';
    default: return 'waiting';
  }
}
function origState() {
  if (notFound) return 'skeleton';
  const st = run?.status || 'queued';
  if (st === 'queued') return 'skeleton';
  if (st === 'ingesting') return 'reading';
  return origShot ? 'original' : (st === 'failed' ? 'skeleton' : 'reading');
}
function queueCaption() {
  if (notFound) return "This run doesn't exist, or it belongs to another browser";
  if (run?.status === 'failed') return 'This run could not read the site';
  if (run?.phase_note === 'waiting for free sandboxes') return 'Waiting for free sandboxes · starting soon';
  if (queuePos > 1) return `${plural(queuePos - 1, 'run', 'runs')} ahead of you · starting soon`;
  if (queuePos === 1) return "You're next · starting in a moment";
  return 'Starting…';
}
const readingCaption = () => (run?.phase_note || 'reading your site').replace(/^extracting:\s*/i, '').replace(/\.$/, '');
const designUrl = d => (SHARE ? `${SHARE.base}p/${d.n}/` : `${contentOrigin}/p/${d.token}/`);

/** Paint one card from its data. Works for row cards and grid cards. */
function paint(c) {
  const isO = c.key === 'o';
  const d = isO ? null : designs.get(c.key);
  const state = isO ? origState() : dState(d);
  const prev = c.state;
  if (state !== prev) {
    c.el.dataset.state = state;
    c.state = state;
    if (state === 'capturing' && prev) { c.el.querySelector('.flash').style.animation = 'none'; void c.el.offsetWidth; c.el.querySelector('.flash').style.animation = ''; }
  }
  setText(c.lname, isO ? 'Original' : state === 'done' ? (d.name || pretty(d.style_family)) : pretty(d.style_family));
  if (isO) {
    c.bar.textContent = host(run?.url);
    c.pill.textContent = queueCaption();
    setText(c.scan, readingCaption());
    if (origShot && !c.shot.getAttribute('src')) c.shot.src = `${API}/original.png`;
    c.el.classList.toggle('has-shot', origShot);
    c.shot.alt = 'Your current site';
    return;
  }
  const fam = pretty(d.style_family);
  c.ghost.textContent = fam;
  c.wFam.textContent = fam;
  setText(c.wAct, (d.last_action || 'starting').replace(/\s+/g, ' ').slice(0, 90));
  c.wSteps.textContent = plural(d.tool_calls || 0, 'step', 'steps');
  if (state === 'done') {
    c.bar.textContent = `${host(run?.url)} · ${d.name || fam}`;
    if (!c.shot.getAttribute('src')) { c.shot.loading = 'lazy'; c.shot.src = `${API}/designs/${d.n}/desktop.png`; c.shot.alt = `${d.name || fam}, desktop`; }
    if (d.token) c.open.href = designUrl(d);
  } else c.bar.textContent = '';
}
function setText(node, text) {
  if (node.textContent === text) return;
  if (reduced || !node.textContent) { node.textContent = text; return; }
  node.style.opacity = '0';
  setTimeout(() => { node.textContent = text; node.style.opacity = ''; }, 250);
}

// ---------------------------------------------------------------- row order: finished first
function computeOrder() {
  const ds = [...designs.values()];
  const rank = { done: 0, capturing: 1, working: 1, starting: 1, failed: 2, waiting: 3 };
  ds.sort((a, b) => {
    const ra = rank[dState(a)], rb = rank[dState(b)];
    if (ra !== rb) return ra - rb;
    if (ra === 0) return (new Date(a.finished_at || 0) - new Date(b.finished_at || 0)) || a.n - b.n;
    return a.n - b.n;
  });
  return ['o', ...ds.map(d => d.n)];
}
function applyOrder() {
  const next = computeOrder();
  for (const k of next) ensureCard(k);
  if (next.join() === order.join()) return;
  order = next;
  const track = $('#track');
  for (const k of order) track.append(cards.get(k).el);   // moves existing nodes, no rebuild
  recenter();
}

// ---------------------------------------------------------------- motion: a spring-driven track
// The row never scrolls natively. `pos` is the track offset in px (card i is centred at pos = i * span); a
// critically-damped spring (stiffness 170, damping 26, from the motion spec) carries it to `target`.
// Wheel and drag move `pos` directly and hand the release velocity to the spring, so motion never jumps.
const STIFF = 170, DAMP = 26;
let pos = 0, vel = 0, target = 0, held = false, rafId = 0, lastT = 0, settled = true;
const span = () => cardW + (mobile() ? 14 : 40);
const maxPos = () => Math.max(0, (order.length - 1) * span());
const focusIndex = () => Math.max(0, order.indexOf(focusKey));
const clampI = i => Math.max(0, Math.min(order.length - 1, i));

function kick() { if (!rafId) { lastT = 0; rafId = requestAnimationFrame(frame); } }
function frame(t) {
  rafId = 0;
  const dt = lastT ? Math.min((t - lastT) / 1000, 1 / 30) : 1 / 60;
  lastT = t;
  if (!held) {
    // Semi-implicit Euler in two half-steps: stable at 30-144 Hz.
    for (let i = 0; i < 2; i++) { const h = dt / 2; vel += (STIFF * (target - pos) - DAMP * vel) * h; pos += vel * h; }
    if (Math.abs(target - pos) < 0.3 && Math.abs(vel) < 4) { pos = target; vel = 0; }
  }
  paintTrack();
  const moving = held || pos !== target || vel !== 0;
  if (moving) { settled = false; rafId = requestAnimationFrame(frame); }
  else if (!settled) { settled = true; onSettle(); }
}
/** Rubber-band past either end, like a native overscroll. */
function rubber(p) {
  const m = maxPos();
  if (p < 0) return -Math.pow(-p, 0.7);
  if (p > m) return m + Math.pow(p - m, 0.7);
  return p;
}
function paintTrack() {
  if (!runId) return;
  const s = span(), p = rubber(pos);
  $('#track').style.transform = `translate3d(${(-p).toFixed(2)}px,0,0)`;
  const f = p / s;
  let best = 0, bestD = Infinity;
  order.forEach((k, i) => {
    const c = cards.get(k); if (!c) return;
    const d = i - f, ad = Math.abs(d);
    if (ad < bestD) { bestD = ad; best = i; }
    if (ad > 2.5 && c._far) return;                         // off-screen cards keep their last transform
    c._far = ad > 2.5;
    const a = Math.max(-1, Math.min(1, d));
    // The style name above the card follows the card's distance from centre: fades and lifts in as it arrives.
    const lo = Math.max(0, 1 - ad * 1.6);
    c.label.style.opacity = lo.toFixed(3);
    c.label.style.transform = `translate3d(0,${((1 - lo) * 10).toFixed(2)}px,0)`;
    c.tilt.style.transform = `rotateX(3deg) rotateY(${(-10 * a).toFixed(2)}deg) scale(${(1 - 0.15 * Math.abs(a)).toFixed(4)})`;
    const side = ad > 0.5;
    if (c._side !== side) { c._side = side; c.el.classList.toggle('side', side); }
  });
  const k = order[best];
  if (k !== undefined && k !== focusKey) { focusKey = k; onFocusChange(); }
}
function go(i, smooth = true) {
  i = clampI(i);
  target = i * span();
  if (!smooth || reduced) { pos = target; vel = 0; }
  kick();
}
function recenter() { if (!runId) return; pos = target = focusIndex() * span(); vel = 0; paintTrack(); }
function updateTransforms() { paintTrack(); }
function queueTransforms() { kick(); }

function onFocusChange() {
  for (const [k, c] of cards) c.el.classList.toggle('focus', k === focusKey);
  syncPlayback();
  renderBelow();
}
// Heavy work (loading iframes) waits until the track comes to rest so it never competes with the motion.
function onSettle() { mountIframes(); syncPlayback(); }

// ---------------------------------------------------------------- live sites inside cards
// Only the focused card and its neighbours hold a live iframe; everything else shows its screenshot.
function mountIframes() {
  if (!settled) return;
  const fi = focusIndex();
  order.forEach((k, i) => {
    const c = cards.get(k);
    if (!c || k === 'o') return;
    const d = designs.get(k);
    const want = d && d.status === 'done' && d.token && Math.abs(i - fi) <= 1 && !body.classList.contains('is-grid');
    if (want && !c.iframe) {
      const f = el('iframe');
      f.title = `${d.name || 'Design'}, live`;
      f.setAttribute('sandbox', 'allow-scripts allow-same-origin');
      f.setAttribute('tabindex', '-1');
      f.setAttribute('aria-hidden', 'true');
      f.referrerPolicy = 'no-referrer';
      f.src = designUrl(d) + (SHARE ? 'embed' : '?embed=1');
      f.onload = () => setTimeout(() => c.site.classList.add('live'), 250);
      c.site.append(f);
      c.iframe = f; c.ready = false;
    } else if (!want && c.iframe && Math.abs(i - fi) > 2) {   // keep a little slack so quick back-and-forth doesn't reload
      c.iframe.remove(); c.iframe = null; c.ready = false; c.playing = false; c.site.classList.remove('live');
    }
  });
}
function post(c, msg) { try { c.iframe?.contentWindow?.postMessage(msg, contentOrigin); } catch {} }
function syncPlayback() {
  for (const [k, c] of cards) {
    if (!c.iframe || !c.ready) continue;
    const play = k === focusKey && settled && !c.hover && !reduced && !body.classList.contains('is-grid') && !document.hidden;
    if (play && !c.playing) post(c, { rd: 'play', speed: 24 / ((cardW - 2) / 1440) });
    if (!play && c.playing) post(c, { rd: 'pause' });
    if (!play && c.playing && k !== focusKey) post(c, { rd: 'top' });
    c.playing = play;
  }
}
addEventListener('message', e => {
  if (!contentOrigin || e.origin !== contentOrigin || e.data?.rd !== 'ready') return;
  for (const c of cards.values()) if (c.iframe && c.iframe.contentWindow === e.source) { c.ready = true; c.playing = false; }
  syncPlayback();
});
document.addEventListener('visibilitychange', syncPlayback);

// ---------------------------------------------------------------- gallery input: wheel, keys, drag, click
const row = $('#row');
// A page inside a card iframe can call scrollIntoView(); the row is overflow:clip, but keep it pinned regardless.
row.addEventListener('scroll', () => { row.scrollLeft = 0; row.scrollTop = 0; }, { passive: true });

// Trackpads send a stream of small deltas: the track follows the fingers 1:1 and snaps with momentum when the
// stream stops. A mouse wheel sends coarse notches: each notch moves exactly one card along the spring.
let wheelIdle = 0, wheelVel = 0, lastWheelT = 0, notchLock = 0;
$('#stage').addEventListener('wheel', e => {
  const fc = cards.get(focusKey);
  const vertical = Math.abs(e.deltaY) > Math.abs(e.deltaX);
  // Over the focused finished card, vertical wheel scrolls the site itself.
  if (vertical && fc && fc.iframe && fc.ready && fc.screen.contains(e.target)) {
    e.preventDefault();
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    post(fc, { rd: 'by', dy: dy / ((cardW - 2) / 1440) });
    fc.hover = true; fc.playing = false; post(fc, { rd: 'pause' });
    clearTimeout(fc.resume); fc.resume = setTimeout(() => { fc.hover = fc.screen.matches(':hover'); syncPlayback(); }, 3000);
    return;
  }
  e.preventDefault();
  const raw = vertical ? e.deltaY : e.deltaX;
  const d = e.deltaMode === 1 ? raw * 16 : e.deltaMode === 2 ? raw * innerWidth : raw;
  const legacy = Math.abs(vertical ? e.wheelDeltaY : e.wheelDeltaX) || 0;
  const notch = e.deltaMode !== 0 || (legacy >= 120 && legacy % 120 === 0 && Math.abs(d) >= 50);
  const now = performance.now();
  if (notch) {
    if (now < notchLock) return;
    notchLock = now + 160;
    go(Math.round(target / span()) + Math.sign(d));
    return;
  }
  // Trackpad: follow directly, track velocity for the release.
  const dt = Math.max(8, now - (lastWheelT || now - 16));
  lastWheelT = now;
  wheelVel = 0.7 * wheelVel + 0.3 * (d / dt * 1000);
  held = true; vel = 0;
  pos = Math.max(-span() * 0.4, Math.min(maxPos() + span() * 0.4, pos + d));
  target = pos;
  kick();
  clearTimeout(wheelIdle);
  wheelIdle = setTimeout(release, 90);
}, { passive: false });
function release(v = wheelVel) {
  held = false; lastWheelT = 0; wheelVel = 0;
  const s = span(), from = Math.round(pos / s);
  // Project where the gesture would coast to; a firm flick advances at least one card.
  let i = Math.round((pos + v * 0.22) / s);
  if (i === from && Math.abs(v) > 500) i = from + Math.sign(v);
  i = clampI(Math.max(from - 2, Math.min(from + 2, i)));   // a fling coasts two cards at most
  target = i * s; vel = v;
  kick();
}

document.addEventListener('keydown', e => {
  if (!runId || e.target === input || e.metaKey || e.ctrlKey || e.altKey) return;
  if (body.classList.contains('is-grid')) { if (e.key === 'Escape') toggleGrid(false); return; }
  const cur = Math.round(target / span());
  if (e.key === 'ArrowRight') { e.preventDefault(); go(cur + 1); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); go(cur - 1); }
  else if (e.key === 'Home') go(0);
  else if (e.key === 'End') go(order.length - 1);
  else if (e.key === 'Enter' && document.activeElement === row) { const c = cards.get(focusKey); if (c) onCardClick(c); }
});

// Drag with mouse, pen or touch. Velocity comes from the last ~80 ms of samples.
let drag = null, dragMoved = false;
row.addEventListener('pointerdown', e => {
  if (e.button !== 0 || e.target.closest('.btn')) return;
  drag = { id: e.pointerId, x: e.clientX, y: e.clientY, start: pos, samples: [[performance.now(), e.clientX]] };
  dragMoved = false;
});
addEventListener('pointermove', e => {
  if (!drag || e.pointerId !== drag.id) return;
  const dx = e.clientX - drag.x;
  if (!dragMoved) {
    if (Math.abs(dx) < 6) return;
    if (e.pointerType === 'touch' && Math.abs(e.clientY - drag.y) > Math.abs(dx)) { drag = null; return; }
    dragMoved = true; row.classList.add('dragging');
    try { row.setPointerCapture(e.pointerId); } catch {}
    held = true; vel = 0;
  }
  const now = performance.now();
  drag.samples.push([now, e.clientX]);
  while (drag.samples.length > 2 && now - drag.samples[0][0] > 80) drag.samples.shift();
  pos = drag.start - dx;
  target = pos;
  kick();
});
function endDrag(e) {
  if (!drag || (e && e.pointerId !== drag.id)) return;
  const moved = dragMoved, sm = drag.samples;
  drag = null; row.classList.remove('dragging');
  if (!moved) return;
  const [t0, x0] = sm[0], [t1, x1] = sm[sm.length - 1];
  const v = t1 > t0 ? -(x1 - x0) / (t1 - t0) * 1000 : 0;    // px/s in track direction
  release(v);
  setTimeout(() => (dragMoved = false), 0);
}
addEventListener('pointerup', endDrag);
addEventListener('pointercancel', endDrag);

function onCardClick(c) {
  if (dragMoved) return;
  if (c.key !== focusKey) { go(order.indexOf(c.key)); return; }
  const d = designs.get(c.key);
  if (d && d.status === 'done' && d.token) window.open(designUrl(d), '_blank', 'noopener');
}

async function copyPrompt(n, btn) {
  const label = 'Copy prompt';
  try {
    const r = await fetch(`${API}/designs/${n}/prompt${SHARE ? '.txt' : ''}`);
    if (!r.ok) throw new Error();
    const text = await r.text();
    try { await navigator.clipboard.writeText(text); }
    catch {
      const ta = el('textarea'); ta.value = text; ta.style.cssText = 'position:fixed;opacity:0';
      body.append(ta); ta.select(); document.execCommand('copy'); ta.remove();
    }
    btn.textContent = '✓ Copied';
  } catch { btn.textContent = "Couldn't copy"; }
  clearTimeout(btn._t); btn._t = setTimeout(() => (btn.textContent = label), 1500);
}

// ---------------------------------------------------------------- below the row: caption, counts, filmstrip
function dots(palette, size) {
  const w = el('div', 'dots');
  for (const col of (palette || []).slice(0, 5)) { const i = el('i'); i.style.background = col; i.title = col; if (size) i.style.width = i.style.height = size; w.append(i); }
  return w;
}

function renderBelow() {
  if (!runId) return;
  // No text under the cards: the style name lives above each card. Touch screens (no hover) get the two
  // actions here instead, since they can't reveal them on the card.
  const tb = $('#touchbar');
  const d = focusKey === 'o' ? null : designs.get(focusKey);
  const want = touch && d && dState(d) === 'done' && d.token ? d.n : null;
  if (tb.dataset.n !== String(want)) {
    tb.dataset.n = String(want);
    tb.replaceChildren();
    if (want != null) {
      const cp = el('button', 'btn copy', 'Copy prompt'); cp.type = 'button'; cp.onclick = () => copyPrompt(d.n, cp);
      const op = el('a', 'btn dark', 'Open ↗'); op.href = designUrl(d); op.target = '_blank'; op.rel = 'noopener';
      tb.append(cp, op);
    }
  }
  renderFilm();
}

const slots = new Map();
function renderFilm() {
  const film = $('#film');
  order.forEach((k, i) => {
    let s = slots.get(k);
    if (!s) {
      s = el('button', 'slot'); s.type = 'button'; s.setAttribute('role', 'tab');
      s.onclick = () => go(order.indexOf(k));
      slots.set(k, s);
    }
    let kind, label;
    if (k === 'o') {
      kind = 'thumb'; label = 'Original';
      if (origShot) s.style.backgroundImage = `url("${API}/original.png")`; else { s.style.background = '#fff'; s.style.boxShadow = 'inset 0 5px 0 #e5e5e5'; }
      if (origShot) s.style.boxShadow = '';
    } else {
      const d = designs.get(k), st = dState(d);
      kind = st === 'done' ? 'thumb' : st === 'failed' ? 'muted' : st === 'waiting' ? 'ring' : 'dot';
      label = `${d.name || pretty(d.style_family)}, ${st}`;
      if (kind === 'thumb' && !s.style.backgroundImage) s.style.backgroundImage = `url("${API}/designs/${k}/desktop.png")`;
    }
    if (s.dataset.k !== kind) s.dataset.k = kind;
    s.setAttribute('aria-label', label); s.title = label;
    s.setAttribute('aria-selected', String(k === focusKey));
    s.classList.toggle('cur', k === focusKey);
    if (film.children[i] !== s) film.insertBefore(s, film.children[i] || null);
  });
}

function renderTopLabel() {
  if (!runId) return;
  const all = [...designs.values()];
  const count = all.length || run?.count || 25;
  const done = all.filter(d => d.status === 'done').length;
  const building = all.filter(d => ['forking', 'working', 'capturing'].includes(d.status)).length;
  $('#rl-domain').textContent = run?.url ? `${host(run.url)} · ${count} designs` : '';
  // On the wall, the progress line lives in the navbar so the grid can use the whole screen.
  const onWall = body.classList.contains('is-grid') && !mobile();
  $('#rl-runs').textContent = !onWall || !run ? ''
    : run.status === 'queued' ? queueCaption()
    : run.status === 'ingesting' ? readingCaption()
    : run.status === 'failed' && !done ? queueCaption()
    : `${done} of ${count} ready${building ? ` · ${building} building` : ''}`;
  let cmp = $('#rl-compare');
  if (!cmp) {
    cmp = el('button', 'rl-compare', 'Compare with original'); cmp.id = 'rl-compare'; cmp.type = 'button';
    cmp.onclick = () => { toggleGrid(false); requestAnimationFrame(() => go(order.indexOf('o'), false)); };
    $('#runlabel').append(cmp);
  }
  cmp.hidden = !onWall || !origShot;
  if (run?.url) document.title = `${host(run.url)} · Gondola`;
}

// ---------------------------------------------------------------- toasts
const toastQ = [];
let hiddenToasts = 0;
function toast(d) {
  const box = $('#toasts');
  const t = el('button', 'toast'); t.type = 'button';
  const th = el('div', 'th'); th.style.backgroundImage = `url("${API}/designs/${d.n}/desktop.png")`; if (d.palette?.[0]) th.style.backgroundColor = d.palette[0];
  const tx = el('div', 'tx'); tx.append(el('b', null, d.name || pretty(d.style_family)), el('span', null, pretty(d.style_family)));
  t.append(th, tx, dots(d.palette?.slice(0, 4), '8px'));
  t.onclick = () => { go(order.indexOf(d.n)); dismiss(t); };
  box.prepend(t);
  toastQ.unshift(t);
  while (toastQ.length > 3) { dismiss(toastQ.pop(), true); hiddenToasts++; }
  renderMore();
  t._timer = setTimeout(() => dismiss(t), 6000);
}
function dismiss(t, collapsed) {
  if (!t || t._gone) return;
  t._gone = true; clearTimeout(t._timer);
  const i = toastQ.indexOf(t); if (i >= 0) toastQ.splice(i, 1);
  t.classList.add('out');
  setTimeout(() => t.remove(), 420);
  if (!collapsed && !toastQ.length) { hiddenToasts = 0; }
  renderMore();
}
function renderMore() {
  const box = $('#toasts');
  let m = box.querySelector('.more');
  if (hiddenToasts > 0 && toastQ.length) {
    if (!m) { m = el('div', 'more'); box.append(m); }
    m.textContent = `+${hiddenToasts} more`;
  } else if (m) m.remove();
}

// ---------------------------------------------------------------- grid overview
const gridBtn = $('#gridtoggle');
gridBtn.addEventListener('click', () => toggleGrid(!body.classList.contains('is-grid')));
function toggleGrid(on) {
  body.classList.toggle('is-grid', on);
  gridBtn.setAttribute('aria-pressed', String(on));
  $('#grid').hidden = !on;
  if (on) renderGrid();
  renderTopLabel();
  mountIframes(); syncPlayback();
}
// The wall: a symmetric grid of all designs. Cells persist (no rebuild per render) so live previews keep running.
// Building with a page on disk → a scaled live iframe of the sandbox (proxied by the content origin, reloaded on
// every write). Finished → a full-page screenshot that slowly scrolls top → bottom → top. Click → the scroll view.
const wall = new Map();               // n → { el, frame, screen, img, iframe, work, fam, act, steps, name, sub, reloadT }
let wallHead = null;
const liveUrl = d => `${contentOrigin}/live/${d.token}/`;

function wallCell(n) {
  if (wall.has(n)) return wall.get(n);
  const e = el('button', 'wcell'); e.type = 'button';
  e.innerHTML = `<div class="wframe"><div class="wscreen"><img class="wfull" alt="" decoding="async">
    <div class="wwork"><div class="wfam"></div><div class="wact"></div><div class="wsteps"></div></div>
    <div class="wfail">Didn't make it</div></div></div><div class="wmeta"><b></b><span></span></div>`;
  const c = { n, el: e, screen: e.querySelector('.wscreen'), img: e.querySelector('.wfull'), iframe: null,
    fam: e.querySelector('.wfam'), act: e.querySelector('.wact'), steps: e.querySelector('.wsteps'),
    name: e.querySelector('.wmeta b'), sub: e.querySelector('.wmeta span'), reloadT: null, imgFor: '' };
  c.img.onload = () => { measureCell(c); e.classList.add('has-img'); };
  c.img.onerror = () => { if (!c.img.src.endsWith('desktop.png')) c.img.src = `${API}/designs/${n}/desktop.png`; };
  e.addEventListener('click', () => { toggleGrid(false); requestAnimationFrame(() => go(order.indexOf(n), false)); });
  wall.set(n, c);
  wallObserver?.observe(e);
  return c;
}

function paintCell(c) {
  const d = designs.get(c.n); if (!d) return;
  const st = dState(d);
  const fam = pretty(d.style_family);
  c.el.dataset.state = st;
  c.name.textContent = st === 'done' ? (d.name || fam) : fam;
  c.sub.textContent = st === 'done' ? fam : st === 'working' ? (d.live ? 'building · live' : 'building') : st;
  c.fam.textContent = fam;
  c.act.textContent = (d.last_action || (st === 'waiting' ? 'waiting for a sandbox' : 'starting')).replace(/\s+/g, ' ').slice(0, 80);
  c.steps.textContent = d.tool_calls ? plural(d.tool_calls, 'step', 'steps') : '';
  if (st === 'done' && d.token && c.imgFor !== 'done') {
    c.imgFor = 'done'; c.el.classList.remove('has-img', 'scrolls');
    c.img.src = `${API}/designs/${c.n}/full.jpg`; c.img.alt = `${d.name || fam}, full page`;
    dropLive(c);
  }
  const wantLive = st === 'working' && d.live && d.token && c.visible;
  if (wantLive && !c.iframe) {
    const f = el('iframe', 'wlive');
    f.setAttribute('sandbox', 'allow-scripts allow-same-origin');
    f.setAttribute('tabindex', '-1'); f.setAttribute('aria-hidden', 'true');
    f.referrerPolicy = 'no-referrer';
    f.onload = () => c.el.classList.add('is-live');
    f.src = liveUrl(d);
    c.screen.append(f); c.iframe = f;
  } else if (!wantLive && c.iframe && st !== 'working') dropLive(c);
}
/** Scroll distance = rendered image height − visible height (re-measured whenever the wall is resized). */
function measureCell(c) {
  if (!c.img.complete || !c.img.naturalWidth) return;
  const ih = c.img.getBoundingClientRect().height, vh = c.screen.getBoundingClientRect().height;
  const dist = Math.max(0, ih - vh);
  c.screen.style.setProperty('--dist', dist + 'px');
  c.screen.style.setProperty('--dur', Math.max(10, dist / 24 + 3).toFixed(1) + 's');
  c.screen.style.setProperty('--delay', (-(c.n * 1.7) % 9).toFixed(1) + 's');
  c.el.classList.toggle('scrolls', dist > 20 && !reduced);
}
function dropLive(c) { if (c.iframe) { c.iframe.remove(); c.iframe = null; } c.el.classList.remove('is-live'); clearTimeout(c.reloadT); }
/** The agent just wrote its page: reload that cell's live view (coalesced). */
function wallReload(n) {
  const c = wall.get(n), d = designs.get(n);
  if (!c?.iframe || !d?.token) { if (c) paintCell(c); return; }
  clearTimeout(c.reloadT);
  c.reloadT = setTimeout(() => { if (c.iframe) c.iframe.src = liveUrl(d) + '?v=' + Date.now(); }, 400);
}
const wallObserver = 'IntersectionObserver' in window ? new IntersectionObserver(entries => {
  for (const en of entries) {
    const c = [...wall.values()].find(x => x.el === en.target); if (!c) continue;
    c.visible = en.isIntersecting;
    if (!c.visible) dropLive(c); else paintCell(c);
  }
}, { rootMargin: '200px' }) : null;

/**
 * Fit the whole wall on screen (desktop/tablet), for any number of designs: try every column count, size cells
 * to the largest that fit (between 16:10 and slightly portrait), and prefer a full rectangle (5 × 5, 10 × 5) when
 * it is nearly as large as the best ragged layout. Phones scroll 2 columns.
 */
function sizeWall() {
  const g = $('#grid');
  const n = Math.max(1, wall.size || run?.count || 25);
  if (mobile()) {
    for (const k of ['--cw', '--ch', '--cols', '--vh', '--gx', '--gy']) g.style.removeProperty(k);
    const any = wall.values().next().value;
    const w = any?.screen.getBoundingClientRect().width;
    if (w) g.style.setProperty('--gs', String(w / 1440));
    return;
  }
  const dense = n > 30;
  const gx = dense ? 8 : 14, gy = dense ? 8 : 12;
  g.style.setProperty('--gx', gx + 'px'); g.style.setProperty('--gy', gy + 'px');
  const cs = getComputedStyle(g);
  const W = innerWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const H = innerHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  const options = [];
  for (let cols = 1; cols <= Math.min(n, 14); cols++) {
    const rows = Math.ceil(n / cols);
    let w = (W - (cols - 1) * gx) / cols, h = (H - (rows - 1) * gy) / rows;
    h = Math.min(h, w * 1.2);           // at most slightly portrait
    if (h < w / 1.6) w = h * 1.6;       // at most 16:10 wide
    options.push({ cols, w: Math.floor(w), h: Math.floor(h), area: w * h, full: n % cols === 0 });
  }
  const best = options.reduce((a, b) => (b.area > a.area ? b : a));
  const full = options.filter(o => o.full && o.area >= best.area * 0.8).sort((a, b) => b.area - a.area)[0];
  const pick = full || best;
  g.style.setProperty('--cols', String(pick.cols));
  g.style.setProperty('--cw', pick.w + 'px');
  g.style.setProperty('--ch', pick.h + 'px');
  g.style.setProperty('--gs', String(pick.w / 1440));
  g.style.setProperty('--vh', Math.round(pick.h / (pick.w / 1440)) + 'px');   // live page viewport height at 1440 wide
  requestAnimationFrame(() => { for (const c of wall.values()) measureCell(c); });
}
addEventListener('resize', () => { if (body.classList.contains('is-grid')) requestAnimationFrame(sizeWall); });

function renderGrid() {
  const g = $('#grid');
  if (!wallHead) {
    wallHead = el('div', 'wall-head');
    wallHead.innerHTML = `<div class="wh-main"><b></b><span></span></div><button class="wh-orig" type="button">Compare with your current site →</button>`;
    wallHead.querySelector('.wh-orig').onclick = () => { toggleGrid(false); requestAnimationFrame(() => go(order.indexOf('o'), false)); };
    g.prepend(wallHead);
  }
  const all = [...designs.values()].sort((a, b) => a.n - b.n);
  const done = all.filter(d => d.status === 'done').length, building = all.filter(d => ['forking', 'working', 'capturing'].includes(d.status)).length;
  wallHead.querySelector('b').textContent = host(run?.url) || 'Your site';
  wallHead.querySelector('span').textContent =
    run?.status === 'queued' ? queueCaption()
    : run?.status === 'ingesting' ? readingCaption()
    : run?.status === 'failed' ? queueCaption()
    : `${done} of ${all.length || run?.count || 25} ready${building ? ` · ${building} being built right now` : ''}`;
  wallHead.querySelector('.wh-orig').hidden = !origShot;
  for (const d of all) {
    const c = wallCell(d.n);
    if (!c.el.isConnected) g.append(c.el);
    paintCell(c);
  }
  sizeWall();
}

// ---------------------------------------------------------------- render orchestration
let renderQueued = false;
function scheduleRender() { if (!renderQueued) { renderQueued = true; requestAnimationFrame(renderAll); } }
function renderAll() {
  renderQueued = false;
  if (!runId) return;
  applyOrder();
  for (const c of cards.values()) paint(c);
  for (const [k, c] of cards) c.el.classList.toggle('focus', k === focusKey);
  renderTopLabel();
  renderBelow();
  mountIframes();
  syncPlayback();
  queueTransforms();
  if (body.classList.contains('is-grid')) renderGrid();
}

function tryOriginalShot() {
  if (origShot || origLoading || !run || !['building', 'done', 'failed'].includes(run.status) && !/snapshot/.test(run.phase_note || '')) return;
  origLoading = true;
  const img = new Image();
  img.onload = () => { origShot = true; origLoading = false; scheduleRender(); };
  img.onerror = () => { origLoading = false; };
  img.src = `${API}/original.png`;
}

function upsertDesign(d) {
  const prev = designs.get(d.n);
  const merged = { ...prev, ...d };
  designs.set(d.n, merged);
  if (merged.status === 'done') {
    if (!loadedOnce) doneSeen.add(d.n);
    else if (!doneSeen.has(d.n)) {
      doneSeen.add(d.n);
      toast(merged);
      // Arrival: the card slides in once it has moved to the front section.
      requestAnimationFrame(() => {
        const c = cards.get(d.n);
        if (c && !reduced) { c.el.classList.remove('arriving'); void c.el.offsetWidth; c.el.classList.add('arriving'); setTimeout(() => c.el.classList.remove('arriving'), 900); }
      });
    }
  }
}

// ---------------------------------------------------------------- data
async function load() {
  const r = await fetch(SHARE ? `${API}/run.json` : API);
  if (!r.ok) { notFound = true; scheduleRender(); return false; }
  const j = await r.json();
  run = j.run; contentOrigin = SHARE ? location.origin : j.content_origin; queuePos = j.queue_position;
  for (const d of j.designs) upsertDesign(d);
  loadedOnce = true;
  tryOriginalShot();
  scheduleRender();
  return true;
}

async function start() {
  if (SHARE) { await load(); return; }   // a share is a finished run: no session, no live stream
  loadMe();
  const ok = await load();
  if (!ok || ['done', 'failed'].includes(run.status)) return;
  // Safety net next to the live stream: resync every 5 s while the run is live.
  const poll = setInterval(async () => { if (['done', 'failed'].includes(run?.status)) { clearInterval(poll); loadMe(); return; } await load(); }, 5000);
  const es = new EventSource(`${API}/stream`);
  es.addEventListener('hello', () => load());
  es.addEventListener('run', e => {
    run = { ...run, ...JSON.parse(e.data) };
    if (run.status !== 'queued') queuePos = null;
    tryOriginalShot(); scheduleRender();
    if (['done', 'failed'].includes(run.status)) { es.close(); loadMe(); }
  });
  es.addEventListener('design', e => { upsertDesign(JSON.parse(e.data)); scheduleRender(); });
  es.addEventListener('live', e => { const l = JSON.parse(e.data); wallReload(l.n); });
  es.addEventListener('action', e => {
    const a = JSON.parse(e.data);
    const d = designs.get(a.n); if (!d) return;
    d.last_action = a.text; if (a.tool_calls) d.tool_calls = a.tool_calls;
    if (d.status === 'forking' || d.status === 'queued') d.status = 'working';
    const c = cards.get(a.n); if (c) paint(c);
    const wc = wall.get(a.n); if (wc) paintCell(wc);
    if (body.classList.contains('is-grid')) renderTopLabel();
    if (a.n === focusKey) renderBelow();
  });
}

// ---------------------------------------------------------------- boot
const m = /^\/r\/([A-Za-z0-9_-]{22})$/.exec(location.pathname);
if (SHARE) enterRun(SHARE.id, false);
else if (m) enterRun(m[1], false);
else {
  loadMe();
  layout(); setTimeout(() => input.focus({ preventScroll: true }), 50);
}

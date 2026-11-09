#!/usr/bin/env node
// Runs inside a sandbox (Node 22+, google-chrome). Two modes:
//   node qa.mjs check  http://localhost:3001/   → JSON list of concrete problems with the redesign
//   node qa.mjs profile <url>                   → markdown profile of a page's current look (palette, fonts, layout)
const [mode, url] = process.argv.slice(2);
const { spawn } = await import('node:child_process');
const PORT = 9300 + Math.floor(Math.random() * 500);
const chrome = spawn(process.env.CHROME || 'google-chrome', ['--headless=new', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=/tmp/qa-${PORT}`, 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let ready = false;
for (let i = 0; i < 40 && !ready; i++) { await sleep(250); try { await fetch(`http://127.0.0.1:${PORT}/json/version`); ready = true; } catch {} }

async function inspect(w, h, expr) {
  const t = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise(r => (ws.onopen = r));
  let id = 0, onLoad = () => {};
  const pending = new Map(), errors = [];
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'Page.loadEventFired') onLoad();
    if (m.method === 'Runtime.exceptionThrown') errors.push((m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text).split('\n')[0]);
  };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 600 });
  // Judge every page as a default visitor sees it, whatever the host's OS theme is.
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  const loaded = new Promise(r => (onLoad = r));
  await send('Page.navigate', { url });
  await Promise.race([loaded, sleep(15000)]);
  await sleep(1200);
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  ws.close();
  // A broken probe must never look like a clean page.
  if (r.result?.exceptionDetails) throw new Error('QA probe failed: ' + (r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text));
  return { value: JSON.parse(r.result?.result?.value ?? 'null'), errors };
}

const HELPERS = `
  const lum = c => { const m = c.match(/[\\d.]+/g); if (!m) return null; const [r, g, b, a = 1] = m.map(Number); if (a < 0.1) return null;
    return [r, g, b].map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0); };
  const bgOf = e => { while (e) { const s = getComputedStyle(e); if (s.backgroundImage !== 'none' && !s.backgroundImage.startsWith('linear')) return 'img';
    const m = s.backgroundColor.match(/[\\d.]+/g); if (m && (m[3] === undefined || +m[3] > 0.5)) return s.backgroundColor; e = e.parentElement; } return 'rgb(255,255,255)'; };
  const label = e => (e.innerText || e.getAttribute('src') || e.tagName).trim().replace(/\\s+/g, ' ').slice(0, 40);
`;

const CHECK = `(async () => { ${HELPERS}
  await document.fonts.ready; await new Promise(r => setTimeout(r, 600));
  const out = [];
  const vw = innerWidth, vh = innerHeight, mobile = vw < 600;
  if (document.documentElement.scrollWidth > vw + 2) {
    const wide = [...document.querySelectorAll('body *')].filter(e => { const r = e.getBoundingClientRect(); return r.width && r.right > vw + 2 && getComputedStyle(e).position !== 'fixed'; }).slice(0, 3);
    out.push('horizontal scroll at ' + vw + 'px: page is ' + document.documentElement.scrollWidth + 'px wide; too wide: ' + wide.map(e => e.tagName.toLowerCase() + (typeof e.className === 'string' && e.className ? '.' + e.className.split(' ')[0] : '')).join(', '));
  }
  for (const i of document.images) {
    if (i.complete && i.naturalWidth === 0) { out.push('broken image: ' + i.getAttribute('src')); continue; }
    const r = i.getBoundingClientRect(); if (!r.width || !r.height || !i.naturalWidth) continue;
    const ratio = (r.width / r.height) / (i.naturalWidth / i.naturalHeight), fit = getComputedStyle(i).objectFit;
    if (fit === 'fill' && Math.abs(ratio - 1) > 0.04) out.push('image stretched/squashed (object-fit: fill, aspect off by ' + Math.round(Math.abs(ratio - 1) * 100) + '%): ' + i.getAttribute('src'));
    if (fit === 'cover' && Math.abs(ratio - 1) > 0.18) out.push('image cropped by ' + Math.round(Math.abs(1 - Math.min(ratio, 1 / ratio)) * 100) + '% (object-fit: cover at ' + (r.width / r.height).toFixed(2) + ':1, natural ' + (i.naturalWidth / i.naturalHeight).toFixed(2) + ':1): ' + i.getAttribute('src') + '. Show it closer to its natural aspect ratio.');
  }
  let rules = 0;
  for (const sh of document.styleSheets) { try { if (!sh.href || sh.href.startsWith(location.origin)) rules += sh.cssRules.length; } catch {} }
  if (rules < 40) out.push('the page is barely styled (' + rules + ' CSS rules); build a full design system in style.css and make sure index.html links it');
  const bodyFont = getComputedStyle(document.body).fontFamily.toLowerCase();
  if (/^"?times new roman|^serif$/.test(bodyFont)) out.push('body text falls back to the browser default font; set the fonts named in the brief');
  const h1s = document.querySelectorAll('h1');
  if (h1s.length !== 1) out.push('page has ' + h1s.length + ' h1 elements; use exactly one');
  const h1 = h1s[0];
  if (h1) {
    const r = h1.getBoundingClientRect();
    if (r.top + window.scrollY > vh * 0.92) out.push((mobile ? 'mobile' : 'desktop') + ': the h1 starts below the first screen (at ' + Math.round(r.top + scrollY) + 'px); the name/headline must be visible without scrolling');
    const under = document.elementsFromPoint(Math.min(r.left + r.width / 2, vw - 1), Math.min(r.top + r.height / 2, vh - 1));
    if (under.some(e => e.tagName === 'IMG' || e.tagName === 'VIDEO' || (e !== h1 && bgOf(e) === 'img' && e.contains(h1)))) out.push('the h1 is placed over a photo; photos can contain their own text, so keep headlines off them');
  }
  let low = [];
  for (const e of document.querySelectorAll('p,li,a,td,dd,small,figcaption,h2,h3,label,span')) {
    if (!e.innerText?.trim() || e.children.length > 2) continue; const r = e.getBoundingClientRect(); if (!r.width) continue;
    const b = bgOf(e); if (b === 'img') continue; const L1 = lum(getComputedStyle(e).color), L2 = lum(b); if (L1 == null || L2 == null) continue;
    const cr = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05), fs = parseFloat(getComputedStyle(e).fontSize);
    if (cr < (fs >= 24 ? 3 : 4.5)) low.push('"' + label(e) + '" ' + cr.toFixed(1) + ':1');
  }
  low = [...new Set(low)];
  if (low.length) out.push('text below accessible contrast (need 4.5:1, 3:1 for 24px+): ' + low.slice(0, 5).join('; ') + (low.length > 5 ? ' and ' + (low.length - 5) + ' more' : ''));
  const tiny = [...document.querySelectorAll('p,li')].filter(e => e.innerText.trim().length > 60 && parseFloat(getComputedStyle(e).fontSize) < (mobile ? 14 : 13)).length;
  if (tiny) out.push(tiny + ' paragraphs set below ' + (mobile ? 14 : 13) + 'px; body text must be readable');
  const generic = /^(serif|sans-serif|monospace|system-ui|ui-|-apple|BlinkMacSystemFont|Times|Arial|Helvetica|Georgia|Courier|cursive|inherit|Tahoma|Verdana|Lucida)/i;
  const loaded = new Set([...document.fonts].filter(f => f.status === 'loaded').map(f => f.family.replace(/["']/g, '')));
  const used = new Set([...document.querySelectorAll('h1,h2,h3,p,a,li')].slice(0, 300).map(e => getComputedStyle(e).fontFamily.split(',')[0].replace(/["']/g, '').trim()));
  const missing = [...used].filter(f => !loaded.has(f) && !generic.test(f));
  if (missing.length) out.push('fonts declared but not loaded (check the Google Fonts link and family names): ' + missing.join(', '));
  return JSON.stringify(out);
})()`;

// Scroll the page top to bottom in steps and catch what only goes wrong while scrolling: titles running off the
// screen, clipped by their container or spilling out of their section; sticky elements taller than the screen or
// covering text; text that stays invisible after scrolling to it; sideways overflow mid-scroll.
const SCROLL = `(async () => { ${HELPERS}
  const wait = ms => new Promise(r => setTimeout(r, ms));
  await document.fonts.ready;
  const vw = innerWidth, vh = innerHeight, out = new Map();
  const add = (k, m) => { if (!out.has(k)) out.set(k, m); };
  const short = e => label(e).slice(0, 34);
  const H = () => Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
  const stickies = [...document.querySelectorAll('body *')].filter(e => /sticky|fixed/.test(getComputedStyle(e).position));
  // Content meant to move sideways: inside a horizontally scrollable rail, or in an animated (marquee) track.
  const sideways = e => { for (let a = e.parentElement; a && a !== document.body; a = a.parentElement) {
    const cs = getComputedStyle(a);
    if (/auto|scroll/.test(cs.overflowX) && a.scrollWidth > a.clientWidth + 4) return true;
    if (cs.animationName && cs.animationName !== 'none' && /translate|matrix/.test(cs.transform + (a.getAnimations?.().length ? 'translate' : ''))) return true;
  } return false; };
  // Does this element visibly paint at (x, y)? Images and shapes, a non-transparent background, or its own glyphs there.
  const paintsAt = (el, x, y) => {
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || parseFloat(cs.opacity) < 0.2) return false;
    if (/^(img|svg|video|canvas|path|circle|rect|polygon|ellipse|line|text)$/i.test(el.tagName)) return true;
    if (!/rgba\(0, 0, 0, 0\)|transparent/.test(cs.backgroundColor) || cs.backgroundImage !== 'none') return true;
    for (const n of el.childNodes) if (n.nodeType === 3 && n.textContent.trim()) {
      const rg = document.createRange(); rg.selectNodeContents(n);
      for (const rr of rg.getClientRects()) if (x >= rr.left && x <= rr.right && y >= rr.top && y <= rr.bottom) return true;
    }
    return false;
  };
  const inHeader = el => { for (let a = el; a && a !== document.body; a = a.parentElement) { const cs = getComputedStyle(a);
    if (/sticky|fixed/.test(cs.position)) { const r = a.getBoundingClientRect(); if (r.height < 160 && (r.top <= 4 || r.bottom >= innerHeight - 4)) return true; } } return false; };
  const isHeader = (e, r) => r.top <= 2 && r.height < 140 && r.width > vw * 0.6;   // ordinary site header bar
  const opacityOf = e => { let o = 1; for (let a = e; a && a !== document.documentElement; a = a.parentElement) { const s = getComputedStyle(a); o *= parseFloat(s.opacity); if (s.visibility === 'hidden') return 0; } return o; };
  const steps = Math.min(14, Math.max(2, Math.ceil(H() / (vh * 0.75))));
  for (let i = 0; i <= steps; i++) {
    window.scrollTo(0, Math.round(i * Math.max(0, H() - vh) / steps));
    await wait(450);
    if (document.documentElement.scrollWidth > vw + 2) add('hscroll', 'the page becomes wider than the screen while scrolling (' + document.documentElement.scrollWidth + 'px at ' + vw + 'px)');
    // titles
    for (const h of [...document.querySelectorAll('h1,h2,h3,h4,[class*=title],[class*=heading],[class*=display]')].slice(0, 120)) {
      const r = h.getBoundingClientRect(); if (!r.width || r.bottom < 0 || r.top > vh || !h.innerText?.trim()) continue;
      if (sideways(h)) continue;   // inside a horizontal rail or a moving marquee: off-screen on purpose
      const range = document.createRange(); range.selectNodeContents(h); const t = range.getBoundingClientRect();
      if (t.right > vw + 4 || t.left < -4) add('edge:' + short(h), 'title "' + short(h) + '" runs off the screen edge');
      for (let a = h.parentElement; a && a !== document.body; a = a.parentElement) {
        const cs = getComputedStyle(a);
        if (/hidden|clip/.test(cs.overflowX + ' ' + cs.overflowY)) {
          const ar = a.getBoundingClientRect();
          if (t.right > ar.right + 4 || t.left < ar.left - 4 || t.bottom > ar.bottom + 4) add('clip:' + short(h), 'title "' + short(h) + '" is cut off by its container (overflow hidden)');
          break;
        }
      }
      for (const p of [...(h.closest('section, article, header, footer') ?? document.body).querySelectorAll('p, li')].slice(0, 60)) {
        if (h.contains(p) || p.contains(h) || !p.innerText?.trim()) continue;
        if (p.innerText.trim().length < 28 && parseFloat(getComputedStyle(p).fontSize) <= 14) continue;   // small decorative label, not body text
        const pr = p.getBoundingClientRect();
        const ox = Math.min(t.right, pr.right) - Math.max(t.left, pr.left), oy = Math.min(t.bottom, pr.bottom) - Math.max(t.top, pr.top);
        if (ox > 8 && oy > 8) { add('overlap:' + short(h), 'title "' + short(h) + '" overlaps the text "' + short(p) + '"'); break; }
      }
      const sec = h.closest('section, header, footer, article');
      if (sec) { const sr = sec.getBoundingClientRect(); if (t.bottom > sr.bottom + 6 || t.right > sr.right + 6) add('spill:' + short(h), 'title "' + short(h) + '" spills outside its section into the next one'); }
    }
    // text covered by something painted on top of it (decorative numerals, shapes, images...). Decorations usually have
    // pointer-events: none, which also hides them from elementFromPoint, so make everything hit-testable for this test.
    const pe = document.createElement('style'); pe.textContent = '* { pointer-events: auto !important; }'; document.head.append(pe);
    for (const e of [...document.querySelectorAll('h1,h2,h3,p')].slice(0, 120)) {
      if (!e.innerText?.trim()) continue;
      const r = e.getBoundingClientRect(); if (!r.width || r.top < 0 || r.bottom > vh) continue;
      const range = document.createRange(); range.selectNodeContents(e);
      const lines = [...range.getClientRects()].filter(l => l.width > 4).slice(0, 4);
      let hits = 0, by = null;
      for (const l of lines) {
        const x = l.left + l.width / 2, y = l.top + l.height / 2;
        // walk down the paint stack at this point until we reach the text itself; count only things that visibly paint
        for (const el of document.elementsFromPoint(x, y)) {
          if (e.contains(el) || el.contains(e)) break;
          if (inHeader(el)) continue;   // content scrolling under a sticky/fixed header bar is normal
          if (paintsAt(el, x, y)) { hits++; by = el; break; }
        }
      }
      if (lines.length && hits >= Math.ceil(lines.length / 2)) add('cover-text:' + short(e), '"' + short(e) + '" is covered by another element on top of it (' + (by.tagName.toLowerCase() + (typeof by.className === 'string' && by.className ? '.' + by.className.split(' ')[0] : '')) + '); move decorations behind the text or out of its way');
    }
    pe.remove();
    // lines of one headline colliding (line-height too tight for the font)
    for (const h of [...document.querySelectorAll('h1,h2,h3')].slice(0, 60)) {
      const r = h.getBoundingClientRect(); if (!r.width || r.bottom < 0 || r.top > vh) continue;
      const range = document.createRange(); range.selectNodeContents(h);
      const ls = [...range.getClientRects()].filter(l => l.width > 4).sort((a, b) => a.top - b.top);
      const fs = parseFloat(getComputedStyle(h).fontSize);
      const tops = [...new Set(ls.map(l => Math.round(l.top)))];
      if (tops.length < 2) continue;
      const lh = parseFloat(getComputedStyle(h).lineHeight) || fs * 1.2;
      if (lh / fs < 0.9) add('collide:' + short(h), 'the lines of "' + short(h) + '" collide (line-height ' + (lh / fs).toFixed(2) + '); use at least 0.95, more for fonts with tall ascenders or accents');
    }
    // sticky / fixed elements
    for (const st of stickies) {
      const r = st.getBoundingClientRect(); if (!r.height || r.bottom < 0 || r.top > vh) continue;
      if (isHeader(st, r)) continue;
      if (getComputedStyle(st).position === 'sticky' && r.height > vh + 4) add('tall:' + short(st), 'a sticky element ("' + short(st) + '") is ' + Math.round(r.height) + 'px tall on a ' + vh + 'px screen, so its bottom can never be read');
      for (const p of [...document.querySelectorAll('p, li, h2, h3')].slice(0, 200)) {
        if (st.contains(p) || p.contains(st)) continue;
        const pr = p.getBoundingClientRect(); if (!pr.width || pr.top < 0 || pr.bottom > vh || !p.innerText?.trim()) continue;
        const hit = document.elementFromPoint(pr.left + pr.width / 2, pr.top + pr.height / 2);
        if (hit && st.contains(hit)) { add('cover:' + short(st), 'a sticky/fixed element ("' + short(st) + '") covers text ("' + short(p) + '") while scrolling'); break; }
      }
    }
    // text that never becomes visible
    for (const e of [...document.querySelectorAll('h1,h2,h3,p,li')].slice(0, 160)) {
      const r = e.getBoundingClientRect(); if (!r.width || r.top < 0 || r.bottom > vh || !e.innerText?.trim()) continue;
      if (opacityOf(e) < 0.15) add('ghost:' + short(e), 'text "' + short(e) + '" is still invisible after scrolling to it (an entrance animation never finishes)');
    }
  }
  window.scrollTo(0, 0);
  return JSON.stringify([...out.values()].slice(0, 12));
})()`;

const PROFILE = `(async () => { ${HELPERS}
  await document.fonts.ready;
  const count = new Map(); const add = (k, w) => count.set(k, (count.get(k) || 0) + w);
  const fonts = new Map();
  for (const e of document.querySelectorAll('body *')) {
    const r = e.getBoundingClientRect(); if (!r.width || !r.height) continue; const s = getComputedStyle(e);
    if (s.backgroundColor && !/rgba\\(0, 0, 0, 0\\)/.test(s.backgroundColor)) add('bg ' + s.backgroundColor, r.width * r.height);
    if (e.childNodes.length && [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) {
      add('text ' + s.color, (e.innerText || '').length);
      const f = s.fontFamily.split(',')[0].replace(/["']/g, '').trim(); fonts.set(f, (fonts.get(f) || 0) + (e.innerText || '').length);
    }
  }
  const hex = c => '#' + (c.match(/\\d+/g) || []).slice(0, 3).map(n => (+n).toString(16).padStart(2, '0')).join('');
  const bodyBg = getComputedStyle(document.body).backgroundColor;
  const colors = [...count].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k]) => k.split(' ')[0] + ' ' + hex(k.slice(k.indexOf(' ') + 1)));
  const h1 = document.querySelector('h1'); const hr = h1?.getBoundingClientRect();
  const hs = h1 ? getComputedStyle(h1) : null;
  const imgsTop = [...document.images].filter(i => { const r = i.getBoundingClientRect(); return r.top < innerHeight && r.width * r.height > 0.05 * innerWidth * innerHeight; }).length;
  return JSON.stringify({
    background: hex(bodyBg), colors, fonts: [...fonts].sort((a, b) => b[1] - a[1]).slice(0, 3).map(f => f[0]),
    h1: h1 ? { text: h1.innerText.trim().slice(0, 60), size: hs.fontSize, weight: hs.fontWeight, align: hs.textAlign, left: Math.round(hr.left), top: Math.round(hr.top) } : null,
    imagesAboveFold: imgsTop, height: document.documentElement.scrollHeight, maxWidth: Math.max(...[...document.querySelectorAll('main, section, article, body > div')].slice(0, 20).map(e => Math.round(e.getBoundingClientRect().width)), 0),
  });
})()`;

try {
  if (mode === 'check') {
    const d = await inspect(1440, 900, CHECK), m = await inspect(390, 844, CHECK);
    const issues = [...new Set([...(d.value ?? []).map(x => 'desktop: ' + x), ...(m.value ?? []).map(x => 'mobile: ' + x),
      ...[...new Set([...d.errors, ...m.errors])].slice(0, 3).map(e => 'JavaScript error: ' + e)])];
    console.log(JSON.stringify(issues));
  } else if (mode === 'scroll') {
    const d = await inspect(1440, 900, SCROLL), m = await inspect(390, 844, SCROLL);
    console.log(JSON.stringify([...new Set([...(d.value ?? []).map(x => 'desktop: ' + x), ...(m.value ?? []).map(x => 'mobile: ' + x)])]));
  } else if (mode === 'shot') {
    // Full-page capture for the scrolling grid: 1440 CSS px wide, saved at half scale as JPEG, height capped.
    const out = process.argv[4];
    const t = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise(r => (ws.onopen = r));
    let id = 0, onLoad = () => {};
    const pending = new Map();
    ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } if (m.method === 'Page.loadEventFired') onLoad(); };
    const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }, { name: 'prefers-reduced-motion', value: 'reduce' }] });
    const loaded = new Promise(r => (onLoad = r));
    await send('Page.navigate', { url });
    await Promise.race([loaded, sleep(15000)]);
    await sleep(1500);
    // Lazy images only load when scrolled to: make them eager, scroll through the page, wait for every image.
    await send('Runtime.evaluate', { awaitPromise: true, expression: `(async () => {
      document.querySelectorAll('img[loading=lazy]').forEach(i => { i.loading = 'eager'; });
      const wait = ms => new Promise(r => setTimeout(r, ms));
      const H = document.documentElement.scrollHeight;
      for (let y = 0; y < H; y += innerHeight * 0.8) { scrollTo(0, y); await wait(120); }
      await Promise.race([Promise.all([...document.images].map(i => i.complete ? 0 : new Promise(r => { i.onload = i.onerror = r; }))), wait(8000)]);
      scrollTo(0, 0); await wait(500);
    })()` });
    const metrics = await send('Page.getLayoutMetrics');
    const h = Math.min(9000, Math.ceil(metrics.result?.cssContentSize?.height ?? metrics.result?.contentSize?.height ?? 900));
    const shot = await send('Page.captureScreenshot', { format: 'jpeg', quality: 72, captureBeyondViewport: true, clip: { x: 0, y: 0, width: 1440, height: h, scale: 0.5 } });
    if (!shot.result?.data) throw new Error('screenshot failed');
    (await import('node:fs')).writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
    ws.close();
    console.log(JSON.stringify({ height: h }));
  } else if (mode === 'profile') {
    const { value: p } = await inspect(1440, 900, PROFILE);
    console.log([
      '# The current site\'s look (your design must be clearly different from this)',
      `- Page background: ${p.background}`,
      `- Most used colours (by area/text): ${p.colors.join(', ')}`,
      `- Fonts: ${p.fonts.join(', ') || 'system default'}`,
      p.h1 ? `- Headline: "${p.h1.text}" at ${p.h1.size}, weight ${p.h1.weight}, ${p.h1.align}-aligned, ${p.h1.left}px from the left, ${p.h1.top}px from the top` : '- No h1 headline',
      `- Large images in the first screen: ${p.imagesAboveFold}`,
      `- Content width: about ${p.maxWidth}px; page height ${p.height}px at 1440px wide`,
    ].join('\n'));
  }
} catch (e) { console.log(JSON.stringify(['QA checker error: ' + e.message])); process.exitCode = 3; } finally { chrome.kill(); }
process.exit(0);

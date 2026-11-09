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

import { createHmac, timingSafeEqual } from 'node:crypto';
import { sql, migrate, publicDesign, publicRun } from './db';
import { subscribe, startWorker, startSweeper, recover, randomId, queuePosition, limiter } from './pipeline';
import { DAILY_RUN_LIMIT, runsLeftToday, nextReset, startRun } from './access';

const SECRET = process.env.SESSION_SECRET!;
const APP_ORIGIN = process.env.APP_ORIGIN!;
const CONTENT_ORIGIN = process.env.CONTENT_ORIGIN!;
const SECURE = APP_ORIGIN.startsWith('https://');
const DEFAULT_COUNT = Number(process.env.DEFAULT_COUNT ?? 25);
const MAX_COUNT = Number(process.env.MAX_COUNT ?? 25);
const MODEL_ALLOW = new Set([
  'openrouter:deepseek/deepseek-v4.1-flash', 'openrouter:xiaomi/mimo-v2.6-pro', 'openrouter:google/gemini-3.8-flash',
  'openrouter:google/gemini-3.7-flash', 'openrouter:anthropic/claude-haiku-5.5', 'openrouter:z-ai/glm-5.3',
  'openrouter:z-ai/glm-5.3-flash', 'openrouter:minimax/minimax-m3', 'openrouter:openai/gpt-6-luna',
]);
const PUBLIC = new URL('../public/', import.meta.url).pathname;
if (!SECRET || SECRET.length < 32) throw new Error('SESSION_SECRET missing');

await migrate();
// RUN_WORKER=0 starts a read-only viewer (e.g. a second instance next to a busy one): no worker, no orphan cleanup.
if (process.env.RUN_WORKER !== '0') {
  await recover();
  startWorker();
  startSweeper();
}

// ---------- sessions: anonymous, cookie = id.hmac ----------
const sign = (id: string) => createHmac('sha256', SECRET).update(id).digest('base64url');
function readSession(req: Request): string | null {
  const m = /(?:^|;\s*)sid=([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})/.exec(req.headers.get('cookie') ?? '');
  if (!m) return null;
  const a = Buffer.from(sign(m[1])), b = Buffer.from(m[2]);
  return a.length === b.length && timingSafeEqual(a, b) ? m[1] : null;
}
async function ensureSession(req: Request): Promise<{ sid: string; setCookie?: string }> {
  const sid = readSession(req);
  if (sid) {
    const [row] = await sql`UPDATE sessions SET last_seen = now() WHERE id = ${sid} RETURNING id`;
    if (row) return { sid };
  }
  const id = randomId(16);
  await sql`INSERT INTO sessions (id) VALUES (${id})`;
  const cookie = `sid=${id}.${sign(id)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${SECURE ? '; Secure' : ''}`;
  return { sid: id, setCookie: cookie };
}

const json = (data: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...extra } });
const notFound = () => json({ error: 'not found' }, 404);

// ---------- operator access: /admin?token=ADMIN_TOKEN sets a signed 12-hour cookie ----------
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? '';
function isAdmin(req: Request): boolean {
  if (ADMIN_TOKEN.length < 32) return false;
  const m = /(?:^|;\s*)adm=(\d{10,13})\.([A-Za-z0-9_-]{43})/.exec(req.headers.get('cookie') ?? '');
  if (!m || Number(m[1]) < Date.now()) return false;
  const a = Buffer.from(sign('admin:' + m[1])), b = Buffer.from(m[2]);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The one authorization rule: a run is visible only to the session that created it (or an operator). 404, never 403. */
async function ownedRun(runId: string, sid: string | null, admin = false) {
  if (!/^[A-Za-z0-9_-]{22}$/.test(runId)) return null;
  if (admin) { const [run] = await sql`SELECT * FROM runs WHERE id = ${runId}`; return run ?? null; }
  if (!sid) return null;
  const [run] = await sql`SELECT * FROM runs WHERE id = ${runId} AND owner = ${sid}`;
  return run ?? null;
}

function validateUrl(input: unknown): URL | string {
  if (typeof input !== 'string' || input.length > 300) return 'Enter a URL.';
  let s = input.trim();
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  let u: URL;
  try { u = new URL(s); } catch { return 'That does not look like a URL.'; }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) return 'Only plain http(s) URLs.';
  const h = u.hostname.toLowerCase();
  if (!h.includes('.') || /^[\d.]+$/.test(h) || h.includes(':') || /(^|\.)(localhost|local|internal|lan|home|arpa)$/.test(h))
    return 'Use a public domain name.';
  if (u.port && !['80', '443'].includes(u.port)) return 'Only standard ports.';
  u.hash = '';
  return u;
}

/** A self-contained prompt that takes this homepage design and applies it to the user's whole site in Claude Code. */
function claudePrompt(run: any, d: any, files: string[]) {
  const base = `${CONTENT_ORIGIN}/p/${d.token}/`;
  const b = d.brief ?? {};
  const list = (v: unknown) => (Array.isArray(v) && v.length ? v.join(', ') : null);
  const lines = [
    `Redesign my ENTIRE website in the style of the reference design below.`,
    ``,
    `My site: ${run.url}`,
    `Reference design: "${d.name ?? b.style_family}". It is a redesign of my HOMEPAGE ONLY: ${base}`,
    d.summary ? `What it is: ${d.summary}` : null,
    ``,
    `## Reference files`,
    `Download these with curl, not WebFetch: you need the exact markup and CSS, not a summary.`,
    ...files.map(f => `  curl -s ${base}${f}`),
    `Images it uses are under ${base}assets/... and are the same images my site already has.`,
    ``,
    `## The direction it was built from`,
    b.style_family ? `- Style family: ${b.style_family}` : null,
    b.reference ? `- In the spirit of: ${b.reference}` : null,
    b.palette ? `- Palette: ${b.palette}` : null,
    list(d.palette) ? `- Palette as built: ${list(d.palette)}` : null,
    b.typography ? `- Typography: ${b.typography}` : null,
    list(d.fonts) ? `- Fonts as built: ${list(d.fonts)}` : null,
    b.layout ? `- Layout: ${b.layout}` : null,
    b.motion ? `- Motion: ${b.motion}` : null,
    b.density ? `- Density: ${b.density}` : null,
    b.hard_constraint ? `- Signature rule: ${b.hard_constraint}` : null,
    ``,
    `## What to do`,
    `1. Fetch the reference files and study them. Write a short design system to DESIGN.md: colour tokens, type scale and`,
    `   fonts, spacing, the components it uses (nav, buttons, cards or lists, section headers, media frames, footer),`,
    `   motion rules, and the 3-5 signature moves that make this style recognisable.`,
    `2. The reference covers only the homepage. Apply the design system to EVERY page of my site: find all routes in this`,
    `   codebase (homepage, subpages, project/case-study pages, blog index and posts, contact, 404, any templates) and redesign`,
    `   each one. Pages the reference doesn't show should look like they were designed by the same hand, not left in the old style.`,
    `3. Content stays exactly as it is in my codebase: every word, link, image, alt text, metadata and SEO tag. The reference's`,
    `   text was copied from my homepage, but my code is the source of truth. Do not invent content.`,
    `4. Stay in my existing stack and framework. Replace styles and components; keep routing, data loading and the build setup.`,
    `   Put the design tokens in one place (CSS variables or the theme config) so the whole site uses them.`,
    `5. Run the site locally, check every page at 1440px desktop and 390px mobile, fix anything broken, and make sure the`,
    `   build passes. Finish with the list of pages you changed.`,
    ``,
    `If this repository is not my site's source code, stop and ask me where it is.`,
  ];
  return lines.filter(l => l !== null).join('\n') + '\n';
}

const page = (file: string, setCookie?: string) =>
  new Response(Bun.file(PUBLIC + file), {
    headers: {
      'content-type': file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.css') ? 'text/css' : file.endsWith('.png') ? 'image/png' : 'text/javascript',
      'content-security-policy': `default-src 'self'; img-src 'self' data:; frame-src ${CONTENT_ORIGIN}; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; frame-ancestors 'none'`,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'same-origin',
      ...(setCookie ? { 'set-cookie': setCookie } : {}),
    },
  });

// ---------- app origin ----------
Bun.serve({
  port: Number(process.env.APP_PORT ?? 8787),
  idleTimeout: 0, // SSE streams stay open
  async fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname;

    if (req.method === 'GET' && (p === '/' || /^\/r\/[A-Za-z0-9_-]{22}$/.test(p))) {
      const s = await ensureSession(req);
      return page('index.html', s.setCookie); // one page: landing and run view, so submit can animate into the stage
    }
    if (req.method === 'GET' && /^\/static\/[a-z-]+\.(css|js|png)$/.test(p)) return page(p.slice(8));
    if (req.method === 'GET' && p === '/favicon.ico') return page('favicon.png');

    if (p === '/admin' && req.method === 'GET') {
      const given = Buffer.from(url.searchParams.get('token') ?? ''), want = Buffer.from(ADMIN_TOKEN);
      if (ADMIN_TOKEN.length < 32 || given.length !== want.length || !timingSafeEqual(given, want)) return notFound();
      const exp = String(Date.now() + 12 * 3600_000);
      return new Response(null, { status: 302, headers: { location: '/', 'set-cookie':
        `adm=${exp}.${sign('admin:' + exp)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200${SECURE ? '; Secure' : ''}` } });
    }

    const sid = readSession(req);
    const admin = isAdmin(req);

    if (p === '/api/runs' && req.method === 'POST') {
      // CSRF: only our own pages may start a run on the visitor's behalf.
      if (req.headers.get('origin') !== APP_ORIGIN || !req.headers.get('content-type')?.includes('application/json'))
        return json({ error: 'bad origin' }, 403);
      if (!sid) return json({ error: 'reload the page' }, 401);
      const body = await req.json().catch(() => ({}));
      const u = validateUrl(body.url);
      if (typeof u === 'string') return json({ error: u }, 400);
      const count = Math.max(2, Math.min(MAX_COUNT, Number(body.count) || DEFAULT_COUNT));
      // Model override is for local benchmarking only (ALLOW_MODEL_OVERRIDE=1), restricted to an allow-list.
      let model: string | null = null;
      if (body.model != null) {
        if (process.env.ALLOW_MODEL_OVERRIDE !== '1' || !MODEL_ALLOW.has(String(body.model))) return json({ error: 'model not allowed' }, 400);
        model = String(body.model);
      }
      const started = await startRun({ sid, admin, url: u, count, model });
      if (!started.ok) return json({ error: started.error }, started.status);
      return json({ id: started.id }, 201);
    }

    if (p === '/api/me' && req.method === 'GET') {
      const recent = sid ? await sql`SELECT id, url, status FROM runs WHERE owner = ${sid} ORDER BY created_at DESC LIMIT 1` : [];
      const [active] = sid ? await sql`SELECT id, url FROM runs WHERE owner = ${sid} AND status IN ('queued','ingesting','building') ORDER BY created_at DESC LIMIT 1` : [];
      return json({
        admin,
        // Only set when the operator configured DAILY_RUN_LIMIT; the UI shows nothing about limits otherwise.
        daily_limit: DAILY_RUN_LIMIT || null, runs_left_today: await runsLeftToday(), resets_at: DAILY_RUN_LIMIT ? nextReset().toISOString() : null,
        active_run: active ?? null, last_run: recent[0] ?? null,
      });
    }

    if (p === '/api/runs' && req.method === 'GET') {
      if (admin) return json((await sql`SELECT * FROM runs ORDER BY created_at DESC LIMIT 50`).map(publicRun));
      if (!sid) return json([]);
      const rows = await sql`SELECT * FROM runs WHERE owner = ${sid} ORDER BY created_at DESC LIMIT 20`;
      return json(rows.map(publicRun));
    }

    let m = /^\/api\/runs\/([A-Za-z0-9_-]{22})(\/.*)?$/.exec(p);
    if (m && req.method === 'GET') {
      const run = await ownedRun(m[1], sid, admin);
      if (!run) return notFound();
      const rest = m[2] ?? '';

      if (rest === '') {
        const designs = await sql`SELECT * FROM designs WHERE run_id = ${run.id} ORDER BY n`;
        const events = await sql`SELECT id, design_n AS n, text, created_at AS at FROM run_events WHERE run_id = ${run.id} ORDER BY id DESC LIMIT 60`;
        return json({
          run: publicRun(run), designs: designs.map(publicDesign), events: events.reverse(),
          queue_position: run.status === 'queued' ? await queuePosition(run.id) : null,
          content_origin: CONTENT_ORIGIN, starts_left_hour: limiter.remaining(3_600_000),
        });
      }

      if (rest === '/stream') {
        let unsub = () => {};
        const stream = new ReadableStream({
          start(ctrl) {
            const enc = new TextEncoder();
            const send = (event: string, data: unknown) => { try { ctrl.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)); } catch {} };
            unsub = subscribe(run.id, send);
            send('hello', { at: Date.now() });
            const ping = setInterval(() => send('ping', Date.now()), 20_000);
            req.signal.addEventListener('abort', () => { clearInterval(ping); unsub(); try { ctrl.close(); } catch {} });
          },
          cancel() { unsub(); },
        });
        return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' } });
      }

      if (rest === '/original.png') {
        const [f] = await sql`SELECT bytes FROM run_assets WHERE run_id = ${run.id} AND path = '_original.png'`;
        return f ? new Response(f.bytes, { headers: { 'content-type': 'image/png', 'cache-control': 'private, max-age=86400', 'x-content-type-options': 'nosniff' } }) : notFound();
      }

      const pr = /^\/designs\/(\d{1,3})\/prompt$/.exec(rest);
      if (pr) {
        const [d] = await sql`SELECT * FROM designs WHERE run_id = ${run.id} AND n = ${Number(pr[1])} AND status = 'done'`;
        if (!d) return notFound();
        const files = await sql`SELECT path FROM design_files WHERE design_id = ${d.id} AND path NOT LIKE '\_shot/%' AND path <> 'design.json' ORDER BY path`;
        return new Response(claudePrompt(run, d, files.map((f: any) => f.path)), {
          headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
        });
      }

      const s = /^\/designs\/(\d{1,3})\/(desktop\.png|mobile\.png|full\.jpg)$/.exec(rest);
      if (s) {
        const [f] = await sql`SELECT f.bytes FROM design_files f JOIN designs d ON d.id = f.design_id
                              WHERE d.run_id = ${run.id} AND d.n = ${Number(s[1])} AND f.path = ${'_shot/' + s[2]}`;
        return f ? new Response(f.bytes, { headers: { 'content-type': s[2].endsWith('.jpg') ? 'image/jpeg' : 'image/png', 'cache-control': 'private, max-age=86400', 'x-content-type-options': 'nosniff' } }) : notFound();
      }
    }
    return notFound();
  },
});

// Injected into embedded pages (?embed=1). Commands from the app origin: {rd:'play', speed: px/s} | {rd:'pause'} |
// {rd:'by', dy}. Plays top → bottom, holds 1.5 s at the footer, glides back to the top in 900 ms, repeats.
const EMBED_JS = `(()=>{const A=${JSON.stringify(APP_ORIGIN)};const se=document.scrollingElement||document.documentElement;
const st=document.createElement('style');st.textContent='html{scroll-behavior:auto!important;scrollbar-width:none}::-webkit-scrollbar{display:none}';document.head.appendChild(st);
let play=false,speed=36,y=0,hold=0,back=null,last=0;const max=()=>Math.max(0,se.scrollHeight-innerHeight);
const ease=t=>1-Math.pow(1-t,3);
function f(t){requestAnimationFrame(f);const dt=last?Math.min(t-last,100):0;last=t;
 if(back){const k=Math.min(1,(t-back.t0)/900);y=back.from*(1-ease(k));se.scrollTop=y;if(k>=1)back=null;return}
 if(!play)return;const m=max();if(m<=0)return;
 if(hold>0){hold-=dt;if(hold<=0)back={t0:t,from:y};return}
 y=Math.min(m,y+speed*dt/1000);se.scrollTop=y;if(y>=m)hold=1500}
requestAnimationFrame(f);
addEventListener('message',e=>{if(e.origin!==A||!e.data||typeof e.data.rd!=='string')return;const d=e.data;
 if(d.rd==='play'){play=true;if(d.speed>0)speed=Math.min(400,d.speed);y=se.scrollTop}
 else if(d.rd==='pause'){play=false}
 else if(d.rd==='by'&&isFinite(d.dy)){back=null;hold=0;y=Math.max(0,Math.min(max(),se.scrollTop+Number(d.dy)));se.scrollTop=y}
 else if(d.rd==='top'){back=null;hold=0;y=0;se.scrollTop=0}});
parent.postMessage({rd:'ready'},A)})();`;

const PAGE_CSP =
  "default-src 'self'; img-src 'self' data:; media-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
  "font-src 'self' https://fonts.gstatic.com data:; script-src 'self' 'unsafe-inline'; connect-src 'none'; form-action 'none'; " +
  `frame-ancestors ${APP_ORIGIN}`;
const LIVE_MIME: Record<string, string> = {
  html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', json: 'application/json',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml',
  ico: 'image/x-icon', mp4: 'video/mp4', webm: 'video/webm', woff2: 'font/woff2',
};

/**
 * Live preview of a design that is still being built: proxies the sandbox's own static server through the content
 * origin, so the browser never sees the Boat URL or its token and the page gets the same isolation (CSP) as finished
 * pages. Same capability rule as /p/: only the owner's API ever hands out the design token.
 */
// Boat's private preview URLs work like a login: GET ?_token=… answers 302 + a `_port_auth` cookie, and that cookie
// unlocks every path. Keep one cookie per sandbox origin (in memory) and re-authenticate when it is refused.
const previewCookies = new Map<string, string>();
async function previewFetch(base: URL, target: URL): Promise<Response> {
  const opts = (cookie?: string): RequestInit => ({ redirect: 'manual', signal: AbortSignal.timeout(15_000), headers: cookie ? { cookie } : {} });
  const known = previewCookies.get(base.origin);
  if (known) {
    const r = await fetch(target, opts(known));
    if (r.status < 300 || r.status === 404) return r;
  }
  const login = new URL(target);
  login.searchParams.set('_token', base.searchParams.get('_token') ?? '');
  const a = await fetch(login, opts());
  const cookie = a.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
  if (!cookie) return a;
  previewCookies.set(base.origin, cookie);
  if (previewCookies.size > 500) previewCookies.delete(previewCookies.keys().next().value!);
  return fetch(target, opts(cookie));
}

async function serveLive(token: string, rawPath: string): Promise<Response> {
  const notReady = (status = 404) => new Response('not ready', { status, headers: { 'cache-control': 'no-store' } });
  let path = decodeURIComponent(rawPath || 'index.html');
  if (path.endsWith('/')) path += 'index.html';
  if (path.split('/').includes('..') || path.startsWith('_')) return notReady();
  const [d] = await sql`SELECT status, preview_url FROM designs WHERE token = ${token}`;
  if (!d) return notReady();
  if (d.status === 'done') return Response.redirect(`/p/${token}/${path === 'index.html' ? '' : path}`, 302);
  if (!d.preview_url || d.status === 'failed') return notReady();
  const mime = LIVE_MIME[path.split('.').pop()!.toLowerCase()];
  if (!mime) return notReady();
  const base = new URL(d.preview_url);
  const target = new URL('/' + path.split('/').map(encodeURIComponent).join('/'), base.origin);
  try {
    const up = await previewFetch(base, target);
    if (!up.ok) return notReady(up.status === 404 ? 404 : 502);
    return new Response(await up.arrayBuffer(), {
      headers: { 'content-type': mime, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
                 'x-robots-tag': 'noindex', 'content-security-policy': PAGE_CSP },
    });
  } catch { return notReady(502); }
}

// ---------- content origin: serves agent-built pages, isolated from the app ----------
// Untrusted HTML never shares an origin with the app's cookies or API. Access is by capability URL:
// /p/<128-bit design token>/..., and the token is only ever handed to the run's owner.
if (process.env.CONTENT_PORT !== '0') Bun.serve({
  port: Number(process.env.CONTENT_PORT ?? 8788),
  idleTimeout: 30, // live previews proxy a sandbox that can take a while to answer
  async fetch(req) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('method not allowed', { status: 405 });
    const live = /^\/live\/([A-Za-z0-9_-]{22})\/(.*)$/.exec(new URL(req.url).pathname);
    if (live) return serveLive(live[1], live[2]);
    const m = /^\/p\/([A-Za-z0-9_-]{22})\/(.*)$/.exec(new URL(req.url).pathname);
    if (!m) {
      const bare = /^\/p\/([A-Za-z0-9_-]{22})$/.exec(new URL(req.url).pathname);
      return bare ? Response.redirect(`/p/${bare[1]}/`, 301) : new Response('not found', { status: 404 });
    }
    let path = decodeURIComponent(m[2] || 'index.html');
    if (path.endsWith('/')) path += 'index.html';
    if (path.split('/').includes('..') || path.startsWith('_shot/')) return new Response('not found', { status: 404 });
    const [d] = await sql`SELECT id, run_id FROM designs WHERE token = ${m[1]} AND status = 'done'`;
    if (!d) return new Response('not found', { status: 404 });
    let [f] = await sql`SELECT mime, bytes FROM design_files WHERE design_id = ${d.id} AND path = ${path}`;
    if (!f && path.startsWith('assets/')) [f] = await sql`SELECT mime, bytes FROM run_assets WHERE run_id = ${d.run_id} AND path = ${path}`;
    if (!f) return new Response('not found', { status: 404 });
    let body: Uint8Array | string = f.bytes;
    // ?embed=1: the app shows this page inside a scaled card and auto-scrolls it. Add a small helper that takes
    // play/pause/scroll commands from the app origin only. Pages served without ?embed are byte-for-byte untouched.
    if (new URL(req.url).searchParams.get('embed') === '1' && f.mime.startsWith('text/html')) {
      const html = new TextDecoder().decode(f.bytes);
      const tag = `<script>${EMBED_JS}</script>`;
      body = /<\/body>/i.test(html) ? html.replace(/<\/body>(?![\s\S]*<\/body>)/i, tag + '</body>') : html + tag;
    }
    return new Response(body, {
      headers: {
        'content-type': f.mime,
        'x-content-type-options': 'nosniff',
        'cache-control': 'private, max-age=3600',
        'referrer-policy': 'no-referrer',
        'x-robots-tag': 'noindex',
        // Pages may only load their own files and Google Fonts; no network calls, no forms posting out.
        'content-security-policy':
          "default-src 'self'; img-src 'self' data:; media-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
          "font-src 'self' https://fonts.gstatic.com data:; script-src 'self' 'unsafe-inline'; connect-src 'none'; form-action 'none'; " +
          `frame-ancestors ${APP_ORIGIN}`,
      },
    });
  },
});

console.log(`app      ${APP_ORIGIN}\ncontent  ${CONTENT_ORIGIN}`);

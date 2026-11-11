// Share pages: publish a finished run as a static page anyone can open, share and copy prompts from.
//
//   bun run share <domain | runId> [--skip 3,17] [--no-deploy]   publish (or update) the latest finished run for a site
//   bun run share list                                              list published shares
//   bun run share remove <slug>                                     take a share down
//   bun run share deploy                                            rebuild the landing page and redeploy everything
//
// Everything is built into shares/site/ (landing page at the root, shares under /s/<slug>/) and deployed with
// `wrangler deploy` as the static-assets Cloudflare Worker SHARE_PROJECT (default "gondola") on SHARE_ORIGIN's domain.
import { sql, publicDesign, publicRun } from '../src/db';
import { claudePrompt } from '../src/prompt';
import { embedJs } from '../src/embed';
import { mkdir, rm, writeFile, readFile, cp, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

const ROOT = join(import.meta.dir, '..');
const OUT = join(ROOT, 'shares');
const SITE = join(OUT, 'site');
const REGISTRY = join(OUT, 'index.json');
// Where shares are published, e.g. https://gondola.example.com or your https://gondola.<you>.workers.dev address.
// Needed to build a share (prompts and link previews use full URLs); `bun run share deploy` works without it.
const ORIGIN = (process.env.SHARE_ORIGIN ?? '').replace(/\/$/, '');
const needOrigin = () => {
  if (!/^https:\/\//.test(ORIGIN)) throw new Error(
    'set SHARE_ORIGIN in .env to the address your shares are served from, e.g. https://gondola.example.com (a domain on your ' +
    'Cloudflare account) or your free workers.dev address: run `bun run share deploy` once, it prints it.');
};
const PROJECT = process.env.SHARE_PROJECT ?? 'gondola';

type Share = { slug: string; run_id: string; url: string; count: number; created_at: string; updated_at: string };
const registry = async (): Promise<Share[]> => (existsSync(REGISTRY) ? JSON.parse(await readFile(REGISTRY, 'utf8')) : []);
const saveRegistry = (r: Share[]) => writeFile(REGISTRY, JSON.stringify(r, null, 2) + '\n');
const host = (u: string) => new URL(u).hostname.replace(/^www\./, '');
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const put = async (path: string, data: string | Uint8Array) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, data); };

// The security policy the app's content server gives design pages, for the same pages on the share site.
const PAGE_CSP =
  "default-src 'self'; img-src 'self' data:; media-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
  "font-src 'self' https://fonts.gstatic.com data:; script-src 'self' 'unsafe-inline'; connect-src 'none'; form-action 'none'; frame-ancestors 'self'";

// ---------------------------------------------------------------- the site root (landing page + shared static files)
async function buildRoot() {
  await mkdir(SITE, { recursive: true });
  for (const f of await readdir(join(ROOT, 'site'))) if (f !== 'CNAME') await cp(join(ROOT, 'site', f), join(SITE, f), { recursive: true });
  await mkdir(join(SITE, 'media'), { recursive: true });
  for (const f of ['promo.mp4', 'promo-poster.jpg', 'og.jpg', 'poster.jpg']) await cp(join(ROOT, 'docs/media', f), join(SITE, 'media', f));
  for (const f of ['logo.png', 'favicon.png', 'apple-touch-icon.png']) await cp(join(ROOT, 'public', f), join(SITE, f));
  await mkdir(join(SITE, 'static'), { recursive: true });
  for (const f of ['rd.js', 'rd.css', 'logo.png', 'favicon.png', 'apple-touch-icon.png']) await cp(join(ROOT, 'public', f), join(SITE, 'static', f));
  await writeFile(join(SITE, '_headers'), [
    // No X-Robots-Tag header here: on images it stops X from showing the link preview. Pages say noindex in a meta tag.
    '/s/*', '  Referrer-Policy: no-referrer', '',
    '/s/:slug/p/*', `  Content-Security-Policy: ${PAGE_CSP}`, '  X-Content-Type-Options: nosniff', '',
  ].join('\n'));
  // Design pages load images from assets/ next to them; one copy per share serves all of its designs.
  await writeFile(join(SITE, '_redirects'), '/s/:slug/p/:n/assets/* /s/:slug/assets/:splat 200\n');
}

// ---------------------------------------------------------------- one share
async function findRun(arg: string) {
  if (/^[A-Za-z0-9_-]{22}$/.test(arg)) {
    const [r] = await sql`SELECT * FROM runs WHERE id = ${arg}`;
    if (!r) throw new Error(`no run ${arg}`);
    return r;
  }
  const want = arg.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '').toLowerCase();
  const runs = await sql`SELECT * FROM runs WHERE status = 'done' ORDER BY created_at DESC`;
  const r = runs.find((r: any) => host(r.url) === want);
  if (!r) throw new Error(`no finished run for ${want} (bun run share list shows published ones; check the app for runs)`);
  return r;
}

async function publish(arg: string, skip: number[]) {
  needOrigin();
  const run = await findRun(arg);
  if (run.status !== 'done') throw new Error(`run ${run.id} is ${run.status}, not done`);
  const reg = await registry();
  const old = reg.find(s => s.run_id === run.id);
  const slug = old?.slug ?? `${host(run.url).replace(/[^a-z0-9]+/g, '-')}-${randomBytes(4).toString('hex').slice(0, 6)}`;
  const base = `/s/${slug}/`, dir = join(SITE, 's', slug);
  await rm(dir, { recursive: true, force: true });

  const designs = (await sql`SELECT * FROM designs WHERE run_id = ${run.id} AND status = 'done' ORDER BY n`).filter((d: any) => !skip.includes(d.n));
  if (!designs.length) throw new Error('this run has no finished designs');
  console.log(`${host(run.url)}: ${designs.length} designs → ${ORIGIN}${base}`);

  // Shared images of the run, and the screenshot of the original site.
  for (const a of await sql`SELECT path, bytes FROM run_assets WHERE run_id = ${run.id} AND (path LIKE 'assets/%' OR path = '_original.png')`)
    await put(a.path === '_original.png' ? join(dir, 'data/original.png') : join(dir, a.path), a.bytes);

  const pub: any[] = [];
  for (const d of designs) {
    const files = await sql`SELECT path, mime, bytes FROM design_files WHERE design_id = ${d.id} ORDER BY path`;
    const pageBase = `${ORIGIN}${base}p/${d.n}/`;
    const title = `${d.name ?? 'A redesign'}: a redesign of ${host(run.url)}`;
    for (const f of files) {
      if (f.path.startsWith('_shot/')) { await put(join(dir, 'data/designs', String(d.n), f.path.slice(6)), f.bytes); continue; }
      let body: Uint8Array | string = f.bytes;
      if (f.path === 'index.html') {
        const html = new TextDecoder().decode(f.bytes);
        // The cards in the scroll view auto-scroll a copy of the page that listens to the viewer.
        const tag = `<script>${embedJs(null)}</script>`;
        await put(join(dir, 'p', String(d.n), 'embed.html'), /<\/body>/i.test(html) ? html.replace(/<\/body>(?![\s\S]*<\/body>)/i, tag + '</body>') : html + tag);
        // The standalone page gets a link preview of its own.
        const og = [`<meta name="robots" content="noindex">`, `<meta property="og:title" content="${esc(title)}">`, `<meta property="og:description" content="Made by Gondola: 50 AI designers redesign a site at once.">`,
          `<meta property="og:image" content="${ORIGIN}${base}data/designs/${d.n}/desktop.png">`, `<meta name="twitter:card" content="summary_large_image">`,
          `<meta name="twitter:title" content="${esc(title)}">`, `<meta name="twitter:description" content="Made by Gondola: 50 AI designers redesign a site at once.">`,
          `<meta name="twitter:image" content="${ORIGIN}${base}data/designs/${d.n}/desktop.png">`].join('');
        body = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, m => m + og) : og + html;
      }
      await put(join(dir, 'p', String(d.n), f.path), body);
    }
    // A capture that half-failed leaves only the full-page shot: cut the first screen out of it for the viewer.
    const shots = join(dir, 'data/designs', String(d.n));
    if (!existsSync(join(shots, 'desktop.png')) && existsSync(join(shots, 'full.jpg'))) {
      const mk = Bun.which('magick') ?? Bun.which('convert');
      if (mk) await Bun.spawn([mk, join(shots, 'full.jpg'), '-crop', '720x450+0+0', '+repage', '-resize', '1440x900', join(shots, 'desktop.png')]).exited;
      console.warn(`! design ${d.n} had no desktop screenshot; made one from its full-page shot`);
    }
    if (!existsSync(join(shots, 'mobile.png')) && existsSync(join(shots, 'desktop.png'))) await cp(join(shots, 'desktop.png'), join(shots, 'mobile.png'));
    const src = files.filter((f: any) => !f.path.startsWith('_shot/') && f.path !== 'design.json').map((f: any) => f.path);
    await put(join(dir, 'data/designs', String(d.n), 'prompt.txt'), claudePrompt(run, d, src, pageBase));
    pub.push({ ...publicDesign(d), token: String(d.n), live: false, error: null });
  }
  await put(join(dir, 'data/run.json'), JSON.stringify({ run: { ...publicRun(run), status: 'done', count: designs.length }, designs: pub, content_origin: '', queue_position: null }));

  // The viewer: the app's own page in share mode, with its link preview and share buttons.
  const site = host(run.url), n = designs.length;
  const shareUrl = `${ORIGIN}${base}`;
  const tweet = `${n} AI designers redesigned ${site} at the same time. Pick a favorite:`;
  let html = await readFile(join(ROOT, 'public/index.html'), 'utf8');
  html = html.replace(/<title>[^<]*<\/title>/, `<title>${n} redesigns of ${esc(site)} · Gondola</title>`)
    .replace(/<meta name="description"[^>]*>/, [
      `<meta name="description" content="${n} AI designers redesigned ${esc(site)} at once. Open any design, or copy its prompt into Claude Code.">`,
      `<meta name="robots" content="noindex">`,
      `<meta property="og:title" content="${n} redesigns of ${esc(site)}">`,
      `<meta property="og:description" content="Made by ${n} AI designers at once with Gondola. Pick a favorite and copy it into Claude Code.">`,
      `<meta property="og:image" content="${shareUrl}og.jpg">`, `<meta property="og:image:width" content="1200">`, `<meta property="og:image:height" content="630">`,
      `<meta property="og:image:type" content="image/jpeg">`, `<meta property="og:type" content="website">`,
      `<meta property="og:url" content="${shareUrl}">`, `<meta name="twitter:card" content="summary_large_image">`, `<meta name="twitter:image" content="${shareUrl}og.jpg">`,
      `<meta name="twitter:image:alt" content="A wall of ${n} AI redesigns of ${esc(site)}">`,
      `<meta name="twitter:title" content="${n} redesigns of ${esc(site)}">`,
      `<meta name="twitter:description" content="Made by ${n} AI designers at once with Gondola. Pick a favorite and copy it into Claude Code.">`,
    ].join('\n'))
    .replace('<button class="gridtoggle"', `<div class="sharebar"><a class="btn dark" id="sh-x" target="_blank" rel="noopener" href="https://x.com/intent/post?text=${encodeURIComponent(tweet)}&url=${encodeURIComponent(shareUrl)}">Share on X</a><button class="btn" id="sh-copy" type="button">Copy link</button></div>\n  <button class="gridtoggle"`)
    .replace('<script src="/static/rd.js"></script>', [
      `<a class="madewith" href="/">Made with <b>Gondola</b> · make your own →</a>`,
      `<style>.sharebar{margin-left:auto;display:flex;gap:8px;pointer-events:auto}.sharebar .btn{font-size:13px;padding:7px 13px}.sharebar+.gridtoggle{margin-left:10px}`,
      `.madewith{position:fixed;left:20px;bottom:16px;z-index:30;font-size:12.5px;color:#555;text-decoration:none;background:rgba(255,255,255,.92);padding:7px 12px;border-radius:99px;box-shadow:0 2px 10px -4px rgba(0,0,0,.25)}.madewith b{color:#111;font-weight:600}`,
      `@media (max-width:640px){.sharebar #sh-copy{display:none}.madewith{display:none}}</style>`,
      `<script>window.GONDOLA_SHARE = ${JSON.stringify({ id: run.id, base })};`,
      `document.getElementById('sh-copy').onclick = e => { navigator.clipboard.writeText(${JSON.stringify(shareUrl)}).then(() => { e.target.textContent = 'Link copied'; setTimeout(() => (e.target.textContent = 'Copy link'), 1500); }); };</script>`,
      `<script src="/static/rd.js"></script>`,
    ].join('\n'));
  await put(join(dir, 'index.html'), html);

  await renderOg(dir, site, designs);

  const now = new Date().toISOString();
  const entry: Share = { slug, run_id: run.id, url: run.url, count: n, created_at: old?.created_at ?? now, updated_at: now };
  await saveRegistry([...reg.filter(s => s.slug !== slug), entry]);
  return shareUrl;
}

// ---------------------------------------------------------------- the link preview: a tilted wall of their designs
function chromeBin() {
  for (const c of [process.env.CHROME, 'chromium', 'google-chrome-stable', 'google-chrome', 'chromium-browser'])
    if (c && Bun.which(c)) return c;
  throw new Error('no Chrome/Chromium found for the preview image (set CHROME=/path/to/chrome)');
}
async function renderOg(dir: string, site: string, designs: any[]) {
  // Most colourful palettes first: they make the boldest preview.
  const sat = (hex: string) => { const m = /^#?([0-9a-f]{6})$/i.exec(hex ?? ''); if (!m) return 0; const v = parseInt(m[1], 16); const r = (v >> 16) / 255, g = ((v >> 8) & 255) / 255, b = (v & 255) / 255; const mx = Math.max(r, g, b), mn = Math.min(r, g, b); return mx === 0 ? 0 : (mx - mn) / mx; };
  const score = (d: any) => (d.palette ?? []).reduce((a: number, c: string) => a + sat(c), 0);
  // 48 cells (8 rows) so the tilted wall reaches every edge; a short run repeats, shifted so copies never sit side by side.
  const sorted = [...designs].sort((a, b) => score(b) - score(a));
  const picks: any[] = [];
  for (let i = 0; picks.length < 48; i++) picks.push(sorted[(i + Math.floor(i / sorted.length) * 3) % sorted.length]);
  const cells = picks.map(d => `<div class="c" style="background-image:url('data/designs/${d.n}/desktop.png')"></div>`).join('');
  const n = designs.length;
  const page = `<!doctype html><html><head><meta charset="utf-8"><link href="https://fonts.googleapis.com/css2?family=Inter+Tight:wght@400;500;600&display=swap" rel="stylesheet"><style>
html,body{margin:0;width:1200px;height:630px;overflow:hidden;background:#fff;font-family:'Inter Tight',sans-serif;color:#111}
.wall{position:absolute;left:600px;top:-260px;width:1150px;display:grid;grid-template-columns:repeat(6,170px);gap:12px;transform:perspective(1600px) rotateY(-24deg) rotateX(14deg) rotateZ(-6deg);transform-origin:0 50%}
.c{height:118px;border-radius:8px;background-size:cover;background-position:top;box-shadow:0 10px 24px -12px rgba(0,0,0,.45),0 0 0 1px rgba(0,0,0,.06)}
.fade{position:absolute;inset:0;background:linear-gradient(90deg,#fff 0,#fff 46%,rgba(255,255,255,.8) 53%,rgba(255,255,255,0) 64%)}
.txt{position:absolute;left:64px;top:0;bottom:0;width:480px;display:flex;flex-direction:column;justify-content:center}
.txt img{width:190px;margin-bottom:34px}
h1{font-size:${site.length > 22 ? 40 : 48}px;line-height:1.06;font-weight:600;letter-spacing:-.03em;margin:0 0 20px;overflow-wrap:anywhere}
p{font-size:20px;line-height:1.38;color:#555;margin:0}
</style></head><body><div class="wall">${cells}</div><div class="fade"></div>
<div class="txt"><img src="../../static/logo.png"><h1>${n} redesigns of ${esc(site)}</h1><p>Made by ${n} AI designers at once. Pick a favorite and copy it into Claude Code.</p></div></body></html>`;
  const tmp = join(dir, '_og.html');
  await writeFile(tmp, page);
  const prof = join(OUT, '.chrome-profile');
  const p = Bun.spawn([chromeBin(), '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=2', '--window-size=1200,630',
    '--allow-file-access-from-files', '--virtual-time-budget=6000', `--user-data-dir=${prof}`, `--screenshot=${join(dir, 'og.png')}`, `file://${tmp}`], { stdout: 'ignore', stderr: 'ignore' });
  const timer = setTimeout(() => p.kill('SIGKILL'), 90_000);
  await p.exited; clearTimeout(timer);
  await rm(tmp, { force: true });
  if (!existsSync(join(dir, 'og.png'))) throw new Error('preview image failed to render');
  // JPEG keeps the card small; fall back to the PNG when ImageMagick isn't installed.
  const mk = Bun.which('magick') ?? Bun.which('convert');
  // Rendered at 2x for sharpness, shipped at X's recommended 1200x630 (oversized card images can be dropped).
  if (mk) { const c = Bun.spawn([mk, join(dir, 'og.png'), '-resize', '1200x630', '-quality', '86', join(dir, 'og.jpg')]); await c.exited; await rm(join(dir, 'og.png'), { force: true }); }
  else await cp(join(dir, 'og.png'), join(dir, 'og.jpg'));
}

// ---------------------------------------------------------------- deploy
async function deploy() {
  const count = async (d: string): Promise<number> => { let n = 0; for (const e of await readdir(d)) { const p = join(d, e); n += (await stat(p)).isDirectory() ? await count(p) : 1; } return n; };
  const files = await count(SITE);
  if (files > 19_000) console.warn(`! ${files} files: Cloudflare allows 20,000 per site. Remove old shares (bun run share remove <slug>).`);
  // A Cloudflare Worker that only serves the static folder (Cloudflare's successor to Pages). With SHARE_DOMAIN set,
  // the deploy also attaches that domain; it must not have another DNS record (delete the old one first).
  const domain = process.env.SHARE_DOMAIN ?? (ORIGIN ? new URL(ORIGIN).hostname : '');
  const config = {
    name: PROJECT, compatibility_date: '2026-11-01', workers_dev: true,
    assets: { directory: 'site', html_handling: 'auto-trailing-slash' },
    ...(!domain || domain.endsWith('.workers.dev') ? {} : { routes: [{ pattern: domain, custom_domain: true }] }),
  };
  await writeFile(join(OUT, 'wrangler.json'), JSON.stringify(config, null, 2));
  await rm(join(OUT, 'wrangler.jsonc'), { force: true });
  const p = Bun.spawn(['bunx', 'wrangler', 'deploy'], { cwd: OUT, stdout: 'inherit', stderr: 'inherit' });   // not the repo root: keep .env out of wrangler's sight
  if (await p.exited !== 0) throw new Error('deploy failed. First time? Run: bunx wrangler login');
}

// ---------------------------------------------------------------- cli
const args = process.argv.slice(2);
const flag = (f: string) => args.includes(f);
const opt = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const cmd = args.find(a => !a.startsWith('--') && a !== opt('--skip'));
try {
  if (!cmd) {
    console.log('usage: bun run share <domain | runId> [--skip 3,17] [--no-deploy] | list | remove <slug> | deploy');
  } else if (cmd === 'list') {
    const reg = await registry();
    if (!reg.length) console.log('no shares yet');
    for (const s of reg) console.log(`${ORIGIN}/s/${s.slug}/  ${host(s.url)}  ${s.count} designs  updated ${s.updated_at.slice(0, 10)}`);
  } else if (cmd === 'remove') {
    const slug = args[args.indexOf('remove') + 1];
    const reg = await registry();
    if (!slug || !reg.some(s => s.slug === slug)) throw new Error(`no share ${slug} (see: bun run share list)`);
    await rm(join(SITE, 's', slug), { recursive: true, force: true });
    await saveRegistry(reg.filter(s => s.slug !== slug));
    await buildRoot(); await deploy();
    console.log(`removed ${ORIGIN}/s/${slug}/`);
  } else if (cmd === 'deploy') {
    await buildRoot(); await deploy();
  } else {
    const skip = (opt('--skip') ?? '').split(',').filter(Boolean).map(Number);
    await buildRoot();
    const url = await publish(cmd, skip);
    if (!flag('--no-deploy')) {
      await deploy();
      // Cloudflare rolls a new version out over ~15 s: only hand out the link once it loads.
      for (let i = 0; i < 24; i++) { const r = await fetch(`${url}og.jpg?v=${Date.now()}`).catch(() => null); if (r?.ok) break; await Bun.sleep(5000); }
    }
    console.log(`\n${flag('--no-deploy') ? 'built (not deployed)' : 'published'}: ${url}`);
  }
} catch (e: any) {
  console.error(`✖ ${e?.message ?? e}`);
  process.exitCode = 1;
} finally {
  await sql.close();
}

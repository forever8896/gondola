// `bun run prewarm <domain>`: read a site once and keep its snapshotted base sandbox, so the next run of that
// site skips the reading step and starts forking the moment you press enter (handy before a screen recording).
// The prepared copy lasts WARM_TTL_HOURS (default 24), then the sweeper removes it.
import { migrate } from '../src/db';
import { prewarm } from '../src/pipeline';

const arg = process.argv[2];
if (!arg) { console.error('usage: bun run prewarm <domain or url>'); process.exit(1); }
const url = new URL(/^https?:\/\//i.test(arg) ? arg : `https://${arg}`);
await migrate();
console.log(`Preparing ${url.href} (one sandbox: read the site, extract content and images, snapshot)…`);
const t = Date.now();
try {
  const { base, photos } = await prewarm(url, line => console.log('  ' + line));
  console.log(`\nReady in ${Math.round((Date.now() - t) / 1000)}s: base ${base}, ${photos} photo(s).`);
  console.log(`Runs of ${url.origin} in the next ${process.env.WARM_TTL_HOURS ?? 24} h start forking immediately.`);
  process.exit(0);
} catch (e: any) {
  console.error(`\nCould not prepare the site: ${e?.message ?? e}`);
  process.exit(1);
}

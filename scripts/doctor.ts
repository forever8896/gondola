// `bun run doctor`: checks everything a run depends on and says what to fix.
// Exit code 1 if something blocking is wrong.
import { SQL } from 'bun';
import { SUBSCRIPTION, claudeLocal } from '../src/llm';

const env = process.env;
let blocking = 0;
const ok = (m: string) => console.log(`  \x1b[32m✔\x1b[0m ${m}`);
const warn = (m: string) => console.log(`  \x1b[33m!\x1b[0m ${m}`);
const bad = (m: string) => { blocking++; console.log(`  \x1b[31m✖\x1b[0m ${m}`); };
const boat = async (args: string[]) => {
  const p = Bun.spawn(['boat', ...args, '--json'], { stdout: 'pipe', stderr: 'pipe', env: { PATH: env.PATH ?? '', HOME: env.HOME ?? '', BOAT_NO_UPDATE: '1' } });
  const out = await new Response(p.stdout).text();
  await p.exited;
  try { return JSON.parse(out.trim().split('\n').filter(l => l.startsWith('{')).pop() ?? 'null'); } catch { return null; }
};

console.log('Gondola doctor');

// .env
for (const k of ['DATABASE_URL', 'SESSION_SECRET', ...(SUBSCRIPTION ? [] : ['OPENROUTER_API_KEY']), 'APP_ORIGIN', 'CONTENT_ORIGIN'])
  if (!env[k]) bad(`${k} is missing in .env (run: bun run setup)`);
if ((env.SESSION_SECRET ?? '').length < 32) bad('SESSION_SECRET must be at least 32 characters');

// Postgres
try {
  const sql = new SQL(env.DATABASE_URL!);
  await sql`SELECT 1`;
  ok('Postgres reachable');
  await sql.close();
} catch (e: any) { bad(`Postgres not reachable (${String(e?.message ?? e).slice(0, 80)}): run docker compose up -d`); }

// Boat
const status = await boat(['status']);
if (status?.account?.loginState === 'active') ok(`Boat: signed in as ${status.account.identifier}`);
else bad("Boat: not signed in (run 'boat login')");
const limits = await boat(['limits']);
if (limits) {
  const max = limits.maxActiveSandboxes, count = Number(env.DEFAULT_COUNT ?? 25);
  ok(`Boat: up to ${max} sandboxes at once, ${limits.startLimits?.perMinute}/min, ${limits.startLimits?.perHour}/hour, ${limits.startLimits?.perDay}/day starts`);
  if (max < count + 1) bad(`Boat allows ${max} sandboxes at once, but a run needs ${count + 1} (DEFAULT_COUNT + 1). Lower DEFAULT_COUNT.`);
  const extra = limits.keepGoing?.enabled ? limits.startLimitsWithWallet : limits.startLimits;
  const want = { perMinute: Number(env.STARTS_PER_MINUTE ?? 11), perHour: Number(env.STARTS_PER_HOUR ?? 58), perDay: Number(env.STARTS_PER_DAY ?? 195) };
  for (const k of ['perMinute', 'perHour', 'perDay'] as const)
    if (extra?.[k] && want[k] > extra[k]) warn(`STARTS_${k.replace('per', 'PER_').toUpperCase()}=${want[k]} is above your Boat limit (${extra[k]}); starts past it will fail`);
  if (Number(env.MAX_ACTIVE_SANDBOXES ?? 95) > max) warn(`MAX_ACTIVE_SANDBOXES is above your Boat limit (${max})`);
}
const profiles = await boat(['ai', 'profiles']);
const def = profiles?.profiles?.find((p: any) => p.isDefault);
const creds: string[] = [...(def?.connected ?? []), ...Object.keys(def?.accounts ?? {})];
if (SUBSCRIPTION) {
  // Agents run Claude Code in the sandboxes on the Claude sign-in stored in your Boat profile.
  if (creds.some(c => /claude|anthropic/i.test(c))) ok(`Boat: Claude credentials in your default AI profile (${creds.filter(c => /claude|anthropic/i.test(c)).join(', ')})`);
  else bad("Boat: no Claude sign-in in your default AI profile. Connect your Claude account in the Boat dashboard (boat dashboard → AI credentials)");
  try { await claudeLocal('Reply with the word OK.', { timeoutMs: 90_000 }); ok('Local Claude Code CLI works (curator and image descriptions use your subscription)'); }
  catch (e: any) { bad(`Local Claude Code CLI failed: ${String(e?.message ?? e).slice(0, 120)}. Install Claude Code and sign in (claude)`); }
} else if (creds.includes('openrouter-api-key')) ok("Boat: OpenRouter key is in your default AI profile (the agents can reach models)");
else bad("Boat: no OpenRouter key in your default AI profile. Run: boat ai profile set-key default openrouter-api-key");

// OpenRouter
if (env.OPENROUTER_API_KEY && !SUBSCRIPTION) {
  const h = { Authorization: `Bearer ${env.OPENROUTER_API_KEY}` };
  const key: any = await fetch('https://openrouter.ai/api/v1/key', { headers: h }).then(r => r.ok ? r.json() : null).catch(() => null);
  if (!key) bad('OpenRouter: key rejected');
  else {
    const d = key.data;
    ok(`OpenRouter: key works${d.limit != null ? `, key limit $${d.limit} ($${Number(d.limit_remaining).toFixed(2)} left)` : ''}`);
    const credits: any = await fetch('https://openrouter.ai/api/v1/credits', { headers: h }).then(r => r.ok ? r.json() : null).catch(() => null);
    if (credits?.data) {
      const left = credits.data.total_credits - credits.data.total_usage;
      const msg = `OpenRouter: account balance $${left.toFixed(2)}`;
      // 25 agents at once each reserve their worst-case cost up front; a thin balance makes requests fail mid-run.
      if (left < 3) bad(`${msg}. Too low: add credits at https://openrouter.ai/settings/credits (a 25-design run uses ~$2, and parallel agents reserve more up front)`);
      else if (left < 10) warn(`${msg}. Low: parallel agents reserve credit up front; keep at least $10 to avoid lost designs`);
      else ok(msg);
    }
  }
}

console.log(blocking ? `\n${blocking} problem(s) to fix before a run will work.` : '\nAll good.');
process.exit(blocking ? 1 : 0);

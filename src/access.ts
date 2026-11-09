// Who may start a run. Gondola is self-hosted: by default anyone who can reach the server can start runs
// (one at a time per browser). If you expose it publicly, set DAILY_RUN_LIMIT to cap what strangers can spend.
import { sql } from './db';
import { randomId } from './pipeline';

/** Max runs per UTC day across all visitors (operators excluded). 0 = unlimited. */
export const DAILY_RUN_LIMIT = Number(process.env.DAILY_RUN_LIMIT ?? 0);

const dayStart = () => { const d = new Date(); d.setUTCHours(0, 0, 0, 0); return d; };
export const nextReset = () => new Date(dayStart().getTime() + 86_400_000);

export async function runsLeftToday(): Promise<number | null> {
  if (!DAILY_RUN_LIMIT) return null;
  const [{ n }] = await sql`SELECT count(*)::int AS n FROM runs WHERE funding <> 'admin' AND created_at >= ${dayStart()}`;
  return Math.max(0, DAILY_RUN_LIMIT - n);
}

type Start = { ok: true; id: string } | { ok: false; status: number; error: string };

/**
 * Create a run. A transaction-scoped advisory lock serialises the checks, so the daily limit can't be
 * over-claimed by simultaneous requests.
 */
export async function startRun(o: { sid: string; admin: boolean; url: URL; count: number; model: string | null; briefsFrom?: string | null }): Promise<Start> {
  return await sql.begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(424242)`;
    if (!o.admin) {
      const [{ active }] = await tx`SELECT count(*)::int AS active FROM runs WHERE owner = ${o.sid} AND status IN ('queued','ingesting','building')`;
      if (active > 0) return { ok: false, status: 429, error: 'You already have a run in progress.' } as Start;
      if (DAILY_RUN_LIMIT) {
        const [{ n }] = await tx`SELECT count(*)::int AS n FROM runs WHERE funding <> 'admin' AND created_at >= ${dayStart()}`;
        if (n >= DAILY_RUN_LIMIT) return { ok: false, status: 429, error: "Today's runs are used up. Try again tomorrow." } as Start;
      }
    }
    const id = randomId(16);
    await tx`INSERT INTO runs (id, owner, url, origin, count, model, funding, briefs_from)
             VALUES (${id}, ${o.sid}, ${o.url.href}, ${o.url.origin}, ${o.count}, ${o.model}, ${o.admin ? 'admin' : 'open'}, ${o.briefsFrom ?? null})`;
    return { ok: true, id } as Start;
  });
}

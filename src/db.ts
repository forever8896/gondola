import { SQL } from 'bun';

export const sql = new SQL(process.env.DATABASE_URL!);

export async function migrate() {
  const ddl = await Bun.file(new URL('../schema.sql', import.meta.url)).text();
  await sql.unsafe(ddl);
}

/** Fields of a design that its owner's browser may see. */
export const publicDesign = (d: any) => ({
  n: d.n,
  status: d.status,
  last_action: d.last_action,
  tool_calls: d.tool_calls,
  name: d.name,
  summary: d.summary,
  palette: d.palette,
  fonts: d.fonts,
  style_family: d.brief?.style_family,
  reference: d.brief?.reference,
  why: d.brief?.why ?? null,
  // The owner gets the capability token as soon as a sandbox exists: /live/<token>/ while building, /p/<token>/ when done.
  token: ['queued', 'failed'].includes(d.status) ? null : d.token,
  live: !!d.live_at && !['done', 'failed'].includes(d.status),
  error: d.error,
  started_at: d.started_at,
  finished_at: d.finished_at,
});

export const publicRun = (r: any) => ({
  id: r.id,
  url: r.url,
  origin: r.origin,
  count: r.count,
  model: r.model,
  status: r.status,
  phase_note: r.phase_note,
  error: r.error,
  cost_usd: r.cost_usd == null ? null : Number(r.cost_usd),
  created_at: r.created_at,
  started_at: r.started_at,
  finished_at: r.finished_at,
});

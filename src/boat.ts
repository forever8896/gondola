// Thin wrapper around the `boat` CLI plus a limiter that keeps us inside Boat's start limits.

// The CLI never needs our app secrets: give it a minimal environment.
const BOAT_ENV = {
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  HOME: process.env.HOME ?? '',
  BOAT_NO_UPDATE: '1',
};

export type BoatResult = { code: number; out: string; err: string };

export async function boat(
  args: string[],
  opts: { timeoutMs?: number; onLine?: (line: string) => void } = {},
): Promise<BoatResult> {
  const p = Bun.spawn(['boat', ...args], { stdout: 'pipe', stderr: 'pipe', env: BOAT_ENV });
  const timer = setTimeout(() => p.kill(), opts.timeoutMs ?? 120_000);
  let out = '';
  let buf = '';
  const dec = new TextDecoder();
  const errP = new Response(p.stderr).text();
  for await (const chunk of p.stdout) {
    const s = dec.decode(chunk, { stream: true });
    out += s;
    if (opts.onLine) {
      buf += s;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.trim()) try { opts.onLine(line); } catch {}
      }
    }
  }
  if (opts.onLine && buf.trim()) try { opts.onLine(buf); } catch {}
  const code = await p.exited;
  clearTimeout(timer);
  return { code, out, err: await errP };
}

export const lastJson = (s: string): any => {
  const lines = s.trim().split('\n').filter(l => l.startsWith('{'));
  for (let i = lines.length - 1; i >= 0; i--) try { return JSON.parse(lines[i]); } catch {}
  return null;
};

/** Shell-quote a string for the single command string that `boat exec` runs. */
export const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Write a text file into a sandbox without scp (fine up to ~64 KiB). */
export async function putFile(id: string, path: string, text: string) {
  const b64 = Buffer.from(text).toString('base64');
  const r = await boat(['exec', id, `mkdir -p $(dirname ${q(path)}) && echo ${b64} | base64 -d > ${q(path)}`]);
  if (r.code !== 0) throw new Error(`putFile ${path} failed: ${r.err.slice(-200)}`);
}

export async function exec(id: string, cmd: string, timeoutS = 30): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const r = await boat(['exec', id, '--json', '--timeout', String(timeoutS), cmd], { timeoutMs: (timeoutS + 60) * 1000 });
  const j = lastJson(r.out);
  return { ok: !!j && j.exitCode === 0, stdout: j?.stdout ?? '', stderr: j?.stderr ?? r.err };
}

/**
 * Boat's $20 plan: 12 starts/min, 60/hour, 200/day, 100 active. We stay a little under each
 * window. Every `boat new` and `boat fork` must take a slot first.
 */
export class StartLimiter {
  private times: number[] = [];
  private chain = Promise.resolve();
  constructor(private windows: { ms: number; max: number }[]) {}

  remaining(ms: number) {
    const w = this.windows.find(x => x.ms === ms)!;
    const now = Date.now();
    return w.max - this.times.filter(t => now - t < w.ms).length;
  }

  /** Can `n` starts happen within the hour/day windows (the minute window just paces them)? */
  canFit(n: number) {
    return this.windows.filter(w => w.ms > 60_000).every(w => this.remaining(w.ms) >= n);
  }

  take(): Promise<void> {
    const next = this.chain.then(async () => {
      for (;;) {
        const now = Date.now();
        this.times = this.times.filter(t => now - t < 86_400_000);
        let wait = 0;
        for (const w of this.windows) {
          const inWin = this.times.filter(t => now - t < w.ms);
          if (inWin.length >= w.max) wait = Math.max(wait, inWin[0] + w.ms - now + 250);
        }
        if (!wait) { this.times.push(now); return; }
        await Bun.sleep(Math.min(wait, 60_000));
      }
    });
    this.chain = next.catch(() => {});
    return next;
  }
}

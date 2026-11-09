// Server-side model calls (the curator and the image descriptions) through either backend:
//   AI_BACKEND=openrouter    (default) OpenRouter's API with OPENROUTER_API_KEY
//   AI_BACKEND=subscription  your local Claude Code CLI (`claude -p`), i.e. your own Claude subscription
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const SUBSCRIPTION = process.env.AI_BACKEND === 'subscription';
const LOCAL_MODEL = process.env.LOCAL_CLAUDE_MODEL ?? 'haiku';

/**
 * One headless Claude Code call on this machine. Runs without MCP servers or session history, with no tools unless
 * files are given (then Read only, limited to their folder), from an empty working directory. The environment is
 * reduced to what the CLI needs, and never includes ANTHROPIC_API_KEY, so it always bills the signed-in subscription.
 */
export async function claudeLocal(prompt: string, opts: { readDir?: string; timeoutMs?: number } = {}): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'gondola-claude-'));
  const env: Record<string, string> = {};
  for (const k of ['PATH', 'HOME', 'USER', 'LANG', 'TERM', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME']) if (process.env[k]) env[k] = process.env[k]!;
  const args = ['-p', '--model', LOCAL_MODEL, '--output-format', 'json', '--no-session-persistence', '--strict-mcp-config'];
  if (opts.readDir) args.push('--tools', 'Read', '--allowedTools', 'Read', '--add-dir', opts.readDir);
  else args.push('--tools', '');
  try {
    const p = Bun.spawn(['claude', ...args], { cwd, env, stdin: new Blob([prompt]), stdout: 'pipe', stderr: 'pipe' });
    const timer = setTimeout(() => p.kill(), opts.timeoutMs ?? 180_000);
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    await p.exited;
    clearTimeout(timer);
    let j: any;
    try { j = JSON.parse(out); } catch { throw new Error(`claude CLI: ${(err || out).trim().slice(-200) || 'no output'}`); }
    if (j.is_error) throw new Error(`claude CLI: ${String(j.result ?? j.subtype ?? 'error').slice(0, 200)}`);
    return String(j.result ?? '');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

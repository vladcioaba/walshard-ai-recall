/**
 * The ONE place that turns a (project, session) into something a shell will run.
 * Used by the CLI handoff, the pick-mode server and the UI's "Copy resume" button.
 *
 * Session ids come from file names and file contents that other software can write,
 * so they must look like ids: start alphanumeric (never a `-flag`), short, no shell metachars.
 */
import path from 'node:path';
import type { Tool } from './types.ts';

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function validSessionId(id: unknown): id is string {
  return typeof id === 'string' && SESSION_ID.test(id);
}

/** Paths we are willing to hand to a shell: absolute for this platform, no control characters. */
export function validPath(p: unknown, platform: NodeJS.Platform = process.platform): p is string {
  if (typeof p !== 'string' || !p) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f]/.test(p)) return false;
  if (platform === 'win32') return path.win32.isAbsolute(p) && /^(?:[A-Za-z]:[\\/]|\\\\)/.test(p);
  return p.startsWith('/');
}

const RESUME: Record<Tool, ((id?: string) => string[]) | undefined> = {
  claude: (id) => (id ? ['claude', '--resume', id] : ['claude', '--resume']),
  'copilot-cli': (id) => (id ? ['copilot', '--resume', id] : ['copilot', '--resume']),
  codex: (id) => (id ? ['codex', 'resume', id] : ['codex', 'resume']),
  'vscode-copilot': undefined,
};

/** POSIX sh single-quote. */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** PowerShell single-quoted literal (no expansion; '' escapes '). Also neutralize curly quotes PS treats as quotes. */
function psq(s: string): string {
  return `'${s.replace(/['‘’‚‛]/g, (q) => q + q)}'`;
}

/** Human-readable/copyable command for the user's shell, or undefined if inputs are not safe. */
export function resumeCommand(dir: string, tool?: Tool, sessionId?: string, platform: NodeJS.Platform = process.platform): string | undefined {
  if (!validPath(dir, platform)) return undefined;
  const id = sessionId === undefined ? undefined : validSessionId(sessionId) ? sessionId : null;
  if (id === null) return undefined; // never silently drop a bad id into a different command
  const argv = tool && RESUME[tool] ? RESUME[tool]!(id) : ['claude', '--resume'];
  return platform === 'win32'
    ? `Set-Location -LiteralPath ${psq(dir)}; ${argv.join(' ')}` // PowerShell (the Windows default shell)
    : `cd ${shq(dir)} && ${argv.join(' ')}`;
}

/**
 * Machine handoff for the shell function: TAB-separated `dir \t tool \t id`.
 * The shell function never evals it — it cd's to the dir and picks a fixed command by tool.
 */
export function handoff(dir: string, tool?: Tool, sessionId?: string, platform: NodeJS.Platform = process.platform): string | undefined {
  if (!validPath(dir, platform) || dir.includes('\t')) return undefined;
  if (sessionId !== undefined && !validSessionId(sessionId)) return undefined;
  const t = tool && RESUME[tool] ? tool : 'claude';
  return `${dir}\t${t}\t${sessionId ?? ''}`;
}

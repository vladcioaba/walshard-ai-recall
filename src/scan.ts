import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { scanClaude } from './adapters/claude.ts';
import { scanCodex } from './adapters/codex.ts';
import { scanCopilotCli } from './adapters/copilot.ts';
import { scanVscode } from './adapters/vscode.ts';
import { buildDocs, type Doc } from './search.ts';
import { bestCost, sessionCost } from './stats.ts';
import { syncStore } from './store.ts';
import type { Contribution, GitInfo, InstructionFile, Project, Prompt, Tool } from './types.ts';
import { validPath } from './resume.ts';
import { HOME, clean, readText, readdir, redact, slug, stat } from './util.ts';

const MAX_PROMPTS = 50;

/** Files/dirs inside a project that configure or brief an AI agent. */
const INSTRUCTION_CANDIDATES = [
  'CLAUDE.md', 'CLAUDE.local.md', '.claude/CLAUDE.md', '.claude/settings.json', '.claude/settings.local.json',
  '.claude/agents', '.claude/commands', '.claude/skills', '.claude/hooks', '.mcp.json',
  'AGENTS.md', '.codex', '.github/copilot-instructions.md', '.github/instructions', '.github/prompts', '.github/chatmodes',
  'GEMINI.md', '.gemini', '.cursorrules', '.cursor/rules', '.windsurfrules', '.clinerules', '.aider.conf.yml',
  'PROGRESS.md', 'TODO.md', 'PLAN.md',
];

export interface ScanResult {
  projects: Project[];
  scannedAt: number;
  durationMs: number;
  errors: string[];
  /** Search corpus per project id (includes full prompt history). */
  corpus: Map<string, Doc[]>;
}

export async function scanAll(): Promise<ScanResult> {
  const t0 = Date.now();
  const errors: string[] = [];
  const adapters: [string, () => Promise<Contribution[]>][] = [
    ['claude', scanClaude],
    ['copilot-cli', scanCopilotCli],
    ['vscode-copilot', scanVscode],
    ['codex', scanCodex],
  ];
  const results = await Promise.all(
    adapters.map(async ([name, fn]) => {
      try {
        return await fn();
      } catch (e: any) {
        errors.push(`${name}: ${e?.message ?? e}`);
        return [];
      }
    }),
  );

  const byPath = new Map<string, Project>();
  let dropped = 0;
  for (const list of results)
    for (const c of list) {
      try {
        merge(byPath, c);
      } catch {
        dropped++; // one malformed record must never take the whole scan down
      }
    }
  if (dropped) errors.push(`${dropped} malformed record(s) skipped`);

  // airecall's own index: remember sessions, re-add ones whose transcripts were deleted
  try {
    const live = [...byPath.values()].flatMap((p) => p.sessions.map((session) => ({ path: p.path, session })));
    for (const a of syncStore(live)) {
      try {
        merge(byPath, { path: a.path, tools: [a.session.tool], sessions: [a.session] });
      } catch {
        /* bad stored record */
      }
    }
  } catch (e: any) {
    errors.push(`index: ${e?.message ?? e}`);
  }

  const corpus = new Map<string, Doc[]>();
  for (const [key, p] of byPath) {
    try {
      const allPrompts = finalize(p);
      corpus.set(p.id, buildDocs(p, allPrompts));
    } catch (e: any) {
      errors.push(`${p.name}: ${e?.message ?? e}`);
      byPath.delete(key);
    }
  }

  const projects = [...byPath.values()].sort((a, b) => b.lastActive - a.lastActive);
  return { projects, scannedAt: Date.now(), durationMs: Date.now() - t0, errors, corpus };
}

const realCache = new Map<string, string>();

/** Canonical absolute path, or throws for values we refuse to treat as project paths. */
function normalize(p: unknown): string {
  if (typeof p !== 'string') throw new Error('non-string path');
  const expanded = p.replace(/^~(?=$|\/)/, HOME);
  if (!path.isAbsolute(expanded)) throw new Error('relative path'); // never resolve against our own cwd
  let r = path.resolve(expanded);
  r = r.length > 1 ? r.replace(/\/+$/, '') : r;
  if (!validPath(r)) throw new Error('path with control characters');
  // collapse /tmp vs /private/tmp and case variants on case-insensitive volumes
  let real = realCache.get(r);
  if (real === undefined) {
    try {
      real = fs.realpathSync.native(r);
    } catch {
      real = r;
    }
    realCache.set(r, real);
  }
  return real;
}

/** Unique, URL-safe id: readable slug + short hash of the full path (slugs alone collide: my-app vs my_app). */
function projectId(p: string): string {
  return `${slug(p).slice(-60).replace(/^-+/, "")}-${crypto.createHash('sha1').update(p).digest('hex').slice(0, 8)}`;
}

function pushAll<T>(target: T[], items: T[] | undefined, cap = Infinity): void {
  if (!items) return;
  for (const x of items) {
    if (target.length >= cap) break;
    target.push(x);
  }
}

function merge(map: Map<string, Project>, c: Contribution): void {
  const key = normalize(c.path);
  let p = map.get(key);
  if (!p) {
    p = {
      id: projectId(key),
      path: key,
      name: path.basename(key) || key,
      exists: false,
      tools: [],
      lastActive: 0,
      firstSeen: 0,
      sessions: [],
      memory: [],
      prompts: [],
      promptCount: 0,
      todos: [],
      plans: [],
      instructions: [],
      totals: { costUSD: 0, inputTokens: 0, outputTokens: 0, sessions: 0 },
    };
    map.set(key, p);
  }
  for (const t of c.tools ?? []) if (!p.tools.includes(t)) p.tools.push(t as Tool);
  // loops, not push(...spread): huge arrays overflow the call stack
  pushAll(p.sessions, c.sessions, 20_000);
  pushAll(p.memory, c.memory, 500);
  pushAll(p.prompts, c.prompts, 200_000);
  if (c.promptCount) p.promptCount += c.promptCount;
  pushAll(p.todos, c.todos, 500);
  pushAll(p.plans, c.plans, 50);
  if (c.claudeConfig) p.claudeConfig = c.claudeConfig;
}

/** Returns the full (uncapped) prompt history; p.prompts is capped. */
function finalize(p: Project): Prompt[] {
  p.exists = !!stat(p.path)?.isDirectory();

  // de-dupe sessions (a live session may also have a transcript)
  const seen = new Map<string, number>();
  p.sessions = p.sessions.filter((s, i) => {
    const k = `${s.tool}:${s.id}`;
    const prev = seen.get(k);
    if (prev === undefined) {
      seen.set(k, i);
      return true;
    }
    if (s.running) p.sessions[prev].running = true;
    return false;
  });
  p.sessions.sort((a, b) => (b.end ?? b.start ?? 0) - (a.end ?? a.start ?? 0));

  p.prompts.sort((a, b) => b.ts - a.ts);
  const allPrompts = p.prompts;
  if (!p.promptCount) p.promptCount = p.sessions.reduce((n, s) => n + (s.userMessages ?? 0), 0);
  p.prompts = p.prompts.slice(0, MAX_PROMPTS);

  let lo = Infinity;
  let hi = 0;
  const see = (t: unknown) => {
    if (typeof t === 'number' && t > 0 && Number.isFinite(t)) {
      if (t < lo) lo = t;
      if (t > hi) hi = t;
    }
  };
  for (const s of p.sessions) (see(s.start), see(s.end));
  for (const x of allPrompts) see(x.ts);
  for (const m of p.memory) see(m.mtime);
  p.lastActive = hi;
  p.firstSeen = lo === Infinity ? 0 : lo;

  for (const s of p.sessions) {
    p.totals.costUSD += bestCost(sessionCost(s)); // recorded if the agent logged it, else API-price estimate
    p.totals.inputTokens += (s.tokens?.input ?? 0) + (s.tokens?.cacheRead ?? 0) + (s.tokens?.cacheWrite ?? 0);
    p.totals.outputTokens += s.tokens?.output ?? 0;
  }
  p.totals.sessions = p.sessions.length;

  p.memory.sort((a, b) => (a.type === 'index' ? -1 : b.type === 'index' ? 1 : b.mtime - a.mtime));

  if (p.exists) {
    p.instructions = findInstructions(p.path);
    p.git = readGit(p.path);
  }
  return allPrompts;
}

function lstat(p: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(p);
  } catch {
    return undefined;
  }
}

/** True if `p` is a real file/dir (no symlink anywhere below `root`) that resolves inside `root`. */
function insideNoLinks(root: string, p: string): boolean {
  const rel = path.relative(root, p);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  let cur = root;
  for (const part of rel.split(path.sep)) {
    cur = path.join(cur, part);
    const st = lstat(cur);
    if (!st || st.isSymbolicLink()) return false;
  }
  return true;
}

function findInstructions(root: string): InstructionFile[] {
  const out: InstructionFile[] = [];
  for (const rel of INSTRUCTION_CANDIDATES) {
    const full = path.join(root, rel);
    if (!insideNoLinks(root, full)) continue; // a cloned repo can ship CLAUDE.md -> ~/.ssh/id_rsa
    const st = lstat(full);
    if (!st) continue;
    if (st.isDirectory()) {
      const n = readdir(full).filter((f) => !f.startsWith('.')).length;
      if (n) out.push({ name: `${rel}/ (${n})`, path: full, size: n, mtime: st.mtimeMs });
    } else {
      out.push({ name: rel, path: full, size: st.size, mtime: st.mtimeMs });
    }
  }
  return out;
}

/** Read git info from files only — no subprocess, works on missing git binary. */
function readGit(root: string): GitInfo | undefined {
  let gitDir = path.join(root, '.git');
  const st = stat(gitDir);
  if (!st) return undefined;
  if (st.isFile()) {
    // worktree / submodule: "gitdir: <path>" — only follow into a real .git/ tree
    const m = /^gitdir:\s*(.+)$/m.exec(readText(gitDir, 4096) ?? '');
    if (!m) return undefined;
    gitDir = path.resolve(root, m[1].trim());
    if (!gitDir.includes(`${path.sep}.git${path.sep}`) && !gitDir.endsWith(`${path.sep}.git`)) return undefined;
  }
  const head = (readText(path.join(gitDir, 'HEAD'), 4096) ?? '').split('\n')[0].trim();
  const ref = /^ref: refs\/heads\/([^\s\u0000-\u001f]{1,200})$/.exec(head);
  const branch = ref ? ref[1] : /^[0-9a-f]{40,64}$/.test(head) ? head.slice(0, 8) : undefined;
  const config = readText(path.join(gitDir, 'config'), 64 * 1024) ?? '';
  const url = /\[remote "origin"\][^[]*?url\s*=\s*(\S+)/.exec(config)?.[1];
  return { branch: branch && clean(branch), remote: url ? stripCreds(url) : undefined };
}

function stripCreds(url: string): string {
  try {
    const u = new URL(url);
    u.username = '';
    u.password = '';
    u.search = '';
    return clean(redact(u.toString()));
  } catch {
    // scp-style git@host:path or unparsable: drop everything before the last @ in the authority
    return clean(redact(url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/]*@/i, '$1')));
  }
}

const SENSITIVE_KEY = /key|token|secret|pass|auth|cred|cookie|session/i;

/** Mask values in agent config JSON (.mcp.json, settings*.json): env/header values and secret-looking keys. */
function maskJson(v: unknown, parentKey = '', underEnv = false): unknown {
  if (Array.isArray(v)) return v.map((x) => maskJson(x, parentKey, underEnv));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      const env = underEnv || k === 'env' || k === 'headers';
      out[k] = maskJson(x, k, env);
    }
    return out;
  }
  if (typeof v === 'string' && (underEnv || SENSITIVE_KEY.test(parentKey))) return '‹hidden›';
  return typeof v === 'string' ? redact(v) : v;
}

/** Read one file for the detail view, only if it belongs to a known project/memory/instruction path. */
export function readProjectFile(projects: Project[], file: string): string | undefined {
  let root: string | undefined;
  for (const p of projects) {
    if (p.instructions.some((i) => i.path === file)) root = p.path;
    for (const m of p.memory) if (m.path === file) root = path.dirname(m.path);
  }
  if (!root || !insideNoLinks(root, file)) return undefined;
  const st = lstat(file);
  if (!st?.isFile()) return undefined;
  const text = readText(file, 256 * 1024);
  if (text === undefined) return undefined;
  if (file.endsWith('.json')) {
    try {
      return JSON.stringify(maskJson(JSON.parse(text)), null, 2);
    } catch {
      /* not JSON: fall through to plain redaction */
    }
  }
  return clean(redact(text)).replace(/\r/g, '');
}

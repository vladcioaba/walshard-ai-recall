import fs from 'node:fs';
import type { Contribution, MemoryFile, Prompt, Session } from '../types.ts';
import { validSessionId } from '../resume.ts';
import {
  HOME, addDaily, clean, dict, eachJsonl, encodeClaudePath, join, num, oneLine, parseFrontmatter, pidAlive, readJson, readText, readdir, redact,
  safeKey, stat, str, text, toMs,
} from '../util.ts';

const ROOT = join(HOME, '.claude');
const PROJECTS = join(ROOT, 'projects');

/** Claude Code: transcripts, prompt history, ~/.claude.json registry, memory dirs, live sessions. */
export async function scanClaude(): Promise<Contribution[]> {
  const out: Contribution[] = [];
  const encodedToPath = new Map<string, string>(); // encoded dir -> real path

  // 1) Transcripts (real cwd is inside each record; folder names are lossy)
  for (const dir of readdir(PROJECTS)) {
    const full = join(PROJECTS, dir);
    for (const f of readdir(full)) {
      if (!f.endsWith('.jsonl')) continue;
      const s = await parseTranscript(join(full, f));
      if (!s) continue;
      // subagent transcripts live in <session>/subagents/*.jsonl and bill to the parent session
      const subDir = join(full, f.replace(/\.jsonl$/, ''), 'subagents');
      for (const sf of readdir(subDir)) if (sf.endsWith('.jsonl')) await parseTranscript(join(subDir, sf), s);
      encodedToPath.set(dir, s.cwd);
      out.push({ path: s.cwd, tools: ['claude'], sessions: [s.session] });
    }
  }

  // 2) Prompt history: survives transcript cleanup
  const history = new Map<string, Prompt[]>();
  await eachJsonl(join(ROOT, 'history.jsonl'), (h) => {
    const project = str(h.project);
    const display = text(h.display);
    if (!project || !display) return;
    const ts = toMs(h.timestamp) ?? 0;
    const list = history.get(project) ?? [];
    list.push({ tool: 'claude', text: display, ts });
    history.set(project, list);
  });
  for (const [p, prompts] of history) {
    out.push({ path: p, tools: ['claude'], prompts, promptCount: prompts.length });
    encodedToPath.set(encodeClaudePath(p), p);
  }

  // 3) ~/.claude.json project registry
  const cfg = readJson<any>(join(HOME, '.claude.json'));
  const registry = cfg?.projects && typeof cfg.projects === 'object' ? cfg.projects : {};
  for (const [p, v] of Object.entries<any>(registry)) {
    encodedToPath.set(encodeClaudePath(p), p);
    out.push({
      path: p,
      tools: ['claude'],
      claudeConfig: {
        mcpServers: Object.keys(v?.mcpServers && typeof v.mcpServers === 'object' ? v.mcpServers : {}).map(clean).slice(0, 100),
        allowedTools: Array.isArray(v?.allowedTools) ? v.allowedTools.length : 0,
        lastCostUSD: typeof v?.lastCost === 'number' ? v.lastCost : undefined,
        lastSessionId: validSessionId(v?.lastSessionId) ? v.lastSessionId : undefined,
      },
    });
  }

  // 4) Memory dirs: ~/.claude/projects/<encoded>/memory/*.md
  for (const dir of readdir(PROJECTS)) {
    const memDir = join(PROJECTS, dir, 'memory');
    const files = readdir(memDir).filter((f) => f.endsWith('.md'));
    if (!files.length) continue;
    const real = encodedToPath.get(dir) ?? guessPathFromEncoded(dir);
    const memory: MemoryFile[] = [];
    for (const f of files) {
      const p = join(memDir, f);
      let lst: fs.Stats;
      try {
        lst = fs.lstatSync(p);
      } catch {
        continue;
      }
      if (!lst.isFile()) continue; // refuse symlinks (memory/leak.md -> ~/.ssh/id_rsa)
      const raw = readText(p);
      if (raw === undefined) continue;
      const { meta, body } = parseFrontmatter(raw);
      memory.push({
        tool: 'claude',
        name: clean(f),
        path: p,
        type: safeKey(meta.type) ?? (f === 'MEMORY.md' ? 'index' : undefined),
        description: text(meta.description),
        content: clean(redact(body)).replace(/\r/g, ''),
        mtime: lst.mtimeMs,
      });
    }
    out.push({ path: real, tools: ['claude'], memory });
  }

  // 5) Live sessions: ~/.claude/sessions/<pid>.json
  for (const f of readdir(join(ROOT, 'sessions'))) {
    if (!f.endsWith('.json')) continue;
    const s = readJson<any>(join(ROOT, 'sessions', f));
    const pid = Number(s?.pid);
    if (!str(s?.cwd) || !Number.isInteger(pid) || pid <= 1 || !validSessionId(s?.sessionId) || !pidAlive(pid)) continue;
    out.push({
      path: s.cwd,
      tools: ['claude'],
      sessions: [{ tool: 'claude', id: s.sessionId, running: true, start: toMs(s.startedAt), title: '(running now)' }],
    });
  }

  return out;
}

/**
 * Best effort when no other source knows the real path:
 *   POSIX   '-Users-x-Work-foo' -> '/Users/x/Work/foo'
 *   Windows 'C--Users-x-foo'    -> 'C:\\Users\\x\\foo'
 */
function guessPathFromEncoded(dir: string): string {
  const drive = /^([A-Za-z])--(.*)$/.exec(dir);
  if (drive && process.platform === 'win32') {
    const root = `${drive[1].toUpperCase()}:\\`;
    return resolveEncoded(root, drive[2]) ?? root + drive[2].replace(/-/g, '\\');
  }
  return resolveEncoded('/', dir.replace(/^-/, '')) ?? dir.replace(/-/g, '/'); // fallback: lossy, flagged missing later
}

/** Walk the real filesystem, matching directory names whose encoding is a prefix of the remainder. */
function resolveEncoded(base: string, rest: string, depth = 0): string | undefined {
  if (!rest) return base;
  if (depth > 12) return undefined;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return undefined;
  }
  // longest names first so "my-game" wins over "my"; cap fan-out on huge directories
  const dirs = entries.filter((e) => e.isDirectory()).slice(0, 5000).sort((a, b) => b.name.length - a.name.length);
  for (const e of dirs) {
    const enc = encodeClaudePath(e.name);
    if (rest === enc) return join(base, e.name);
    if (rest.startsWith(enc + '-')) {
      const found = resolveEncoded(join(base, e.name), rest.slice(enc.length + 1), depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}

interface Parsed {
  cwd: string;
  session: Session;
  models: Set<string>;
  seenMsg: Set<string>;
}

/**
 * Parse one transcript. With `parent`, it's a subagent transcript: usage, tool calls and models
 * are added to the parent session (de-duplicated by message id); prompts/title are ignored.
 */
async function parseTranscript(file: string, parent?: Parsed): Promise<Parsed | undefined> {
  let cwd = '';
  const fileId = file.split('/').pop()!.replace(/\.jsonl$/, '');
  if (!parent && !validSessionId(fileId)) return undefined; // ids become shell arguments later
  const s: Session = parent?.session ?? {
    tool: 'claude',
    id: fileId,
    file,
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    topTools: dict(),
    usageDaily: dict(),
  };
  const models = parent?.models ?? new Set<string>();
  const seenMsg = parent?.seenMsg ?? new Set<string>();

  await eachJsonl(file, (o) => {
    const ts = toMs(o.timestamp);
    if (ts) {
      s.start = Math.min(s.start ?? ts, ts);
      s.end = Math.max(s.end ?? ts, ts);
    }
    if (parent) {
      if (o.type !== 'assistant') return;
    } else {
      if (!cwd) cwd = str(o.cwd) ?? '';
      const branch = str(o.gitBranch);
      if (branch && branch !== 'HEAD') s.branch = clean(branch).slice(0, 200);
    }

    switch (o.type) {
      case 'ai-title':
        s.title = text(o.aiTitle) ?? s.title;
        break;
      case 'cost-state':
        if (typeof o.totalCostUSD === 'number') s.costUSD = num(o.totalCostUSD);
        if (typeof o.totalLinesAdded === 'number') s.linesAdded = num(o.totalLinesAdded);
        if (typeof o.totalLinesRemoved === 'number') s.linesRemoved = num(o.totalLinesRemoved);
        break;
      case 'user': {
        if (o.isSidechain) break;
        const c = o.message?.content;
        const txt = typeof c === 'string' ? c : Array.isArray(c) ? c.find((b: any) => b?.type === 'text')?.text : undefined;
        const isToolResult = Array.isArray(c) && c.some((b: any) => b?.type === 'tool_result');
        if (!isToolResult && typeof txt === 'string' && txt) {
          s.userMessages!++;
          if (!s.firstPrompt && !txt.startsWith('<')) s.firstPrompt = oneLine(redact(txt), 200); // redact BEFORE truncating
        }
        break;
      }
      case 'assistant': {
        const m = o.message;
        if (!m || typeof m !== 'object') break;
        const model = safeKey(m.model);
        if (model && !model.startsWith('<')) models.add(model);
        for (const b of Array.isArray(m.content) ? m.content : []) {
          if (b?.type === 'tool_use') {
            s.toolCalls!++;
            const name = safeKey(b.name);
            if (name) s.topTools![name] = (s.topTools![name] ?? 0) + 1;
          }
        }
        // one API message may be split over several records: count usage once per message id
        const mid = str(m.id) ?? str(o.uuid);
        if (mid) {
          if (seenMsg.has(mid)) break;
          seenMsg.add(mid);
        }
        if (!parent) s.assistantMessages!++;
        const u = m.usage;
        if (u && typeof u === 'object') {
          const usage = {
            input: num(u.input_tokens),
            output: num(u.output_tokens),
            cacheRead: num(u.cache_read_input_tokens),
            cacheWrite: num(u.cache_creation_input_tokens),
          };
          s.tokens!.input += usage.input;
          s.tokens!.output += usage.output;
          s.tokens!.cacheRead += usage.cacheRead;
          s.tokens!.cacheWrite += usage.cacheWrite;
          if (!model?.startsWith('<')) addDaily(s.usageDaily!, ts, model ?? 'unknown', usage);
        }
        break;
      }
    }
  });

  s.models = [...models];
  if (parent) return parent;
  if (!cwd) return undefined;
  return { cwd, session: s, models, seenMsg };
}

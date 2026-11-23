import type { Contribution, Session } from '../types.ts';
import { validSessionId } from '../resume.ts';
import { HOME, clean, dict, eachJsonl, join, oneLine, readdir, redact, safeKey, stat, str, toMs } from '../util.ts';

const ROOT = process.env.CODEX_HOME ?? join(HOME, '.codex');

/**
 * OpenAI Codex CLI: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
 * First record is `session_meta` with payload.cwd. Format unverified on this machine — parsed defensively.
 */
export async function scanCodex(): Promise<Contribution[]> {
  const out: Contribution[] = [];
  for (const file of walkRollouts(join(ROOT, 'sessions'))) {
    let cwd = '';
    const s: Session = { tool: 'codex', id: file.split('/').pop()!.replace(/\.jsonl$/, ''), file, userMessages: 0, assistantMessages: 0, toolCalls: 0, topTools: dict() };
    const models = new Set<string>();
    await eachJsonl(file, (o) => {
      const ts = toMs(o.timestamp);
      if (ts) {
        s.start = Math.min(s.start ?? ts, ts);
        s.end = Math.max(s.end ?? ts, ts);
      }
      const p = o.payload && typeof o.payload === 'object' ? o.payload : o;
      if (o.type === 'session_meta' || p.type === 'session_meta') {
        cwd ||= str(p.cwd) ?? '';
        if (validSessionId(p.id)) s.id = p.id; // becomes `codex resume <id>`
        const br = str(p.git?.branch);
        if (br) s.branch = clean(br).slice(0, 200);
      }
      if (o.type === 'turn_context') {
        const m = safeKey(p.model);
        if (m) models.add(m);
      }
      if (p.type === 'message' && p.role === 'user') {
        s.userMessages!++;
        const text = Array.isArray(p.content) ? p.content.map((c: any) => c?.text ?? '').join(' ') : '';
        if (!s.firstPrompt && text && !text.startsWith('<')) s.firstPrompt = oneLine(redact(text), 200);
      }
      if (p.type === 'message' && p.role === 'assistant') s.assistantMessages!++;
      if (p.type === 'function_call' || p.type === 'local_shell_call') {
        s.toolCalls!++;
        const n = safeKey(p.name) ?? safeKey(p.type);
        if (n) s.topTools![n] = (s.topTools![n] ?? 0) + 1;
      }
    });
    if (!cwd || !validSessionId(s.id)) continue;
    s.models = [...models];
    s.title = s.firstPrompt ? oneLine(s.firstPrompt, 80) : undefined;
    out.push({ path: cwd, tools: ['codex'], sessions: [s] });
  }
  return out;
}

function* walkRollouts(dir: string, depth = 0): Generator<string> {
  for (const name of readdir(dir)) {
    const p = join(dir, name);
    if (name.endsWith('.jsonl')) yield p;
    else if (depth < 4 && stat(p)?.isDirectory()) yield* walkRollouts(p, depth + 1);
  }
}

import type { Contribution, Session, Todo } from '../types.ts';
import { validSessionId } from '../resume.ts';
import { HOME, addDaily, clean, dict, eachJsonl, join, num, oneLine, parseFlatYaml, readText, readdir, redact, safeKey, stat, str, text, toMs } from '../util.ts';

const ROOT = join(HOME, '.copilot', 'session-state');

/** GitHub Copilot CLI: ~/.copilot/session-state/<uuid>/{workspace.yaml,events.jsonl,plan.md,session.db} */
export async function scanCopilotCli(): Promise<Contribution[]> {
  const out: Contribution[] = [];
  for (const id of readdir(ROOT)) {
    if (!validSessionId(id)) continue; // the folder name becomes a `copilot --resume <id>` argument
    const dir = join(ROOT, id);
    const ws = parseFlatYaml(readText(join(dir, 'workspace.yaml'), 64 * 1024) ?? '');
    const cwd = ws.git_root || ws.cwd;
    if (!cwd) continue;

    const s: Session = {
      tool: 'copilot-cli',
      id,
      title: text(ws.summary),
      branch: ws.branch ? clean(ws.branch).slice(0, 200) : undefined,
      start: toMs(ws.created_at),
      end: toMs(ws.updated_at),
      userMessages: 0,
      assistantMessages: 0,
      toolCalls: 0,
      topTools: dict(),
      file: join(dir, 'events.jsonl'),
    };
    const models = new Set<string>();
    let outputTokens = 0;
    let metricsUsage: { input: number; output: number; cacheRead: number; cacheWrite: number } | undefined;
    let usageDaily: NonNullable<Session['usageDaily']> = dict();

    await eachJsonl(join(dir, 'events.jsonl'), (e) => {
      const ts = toMs(e.timestamp);
      if (ts) {
        s.start = Math.min(s.start ?? ts, ts);
        s.end = Math.max(s.end ?? ts, ts);
      }
      const d = e.data && typeof e.data === 'object' ? e.data : {};
      switch (e.type) {
        case 'user.message':
          s.userMessages!++;
          if (!s.firstPrompt && typeof d.content === 'string') s.firstPrompt = oneLine(redact(d.content), 200);
          break;
        case 'assistant.message':
          s.assistantMessages!++;
          outputTokens += num(d.outputTokens);
          break;
        case 'tool.execution_start': {
          s.toolCalls!++;
          const name = safeKey(d.toolName);
          if (name) s.topTools![name] = (s.topTools![name] ?? 0) + 1;
          break;
        }
        case 'tool.execution_complete': {
          const model = safeKey(d.model);
          if (model) models.add(model);
          break;
        }
        case 'session.shutdown': {
          const cur = safeKey(d.currentModel);
          if (cur) models.add(cur);
          // metrics are cumulative per shutdown: keep the LAST shutdown's numbers, don't sum
          if (typeof d.totalPremiumRequests === 'number') s.premiumRequests = num(d.totalPremiumRequests);
          if (d.modelMetrics && typeof d.modelMetrics === 'object') {
            metricsUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
            usageDaily = dict();
            for (const [rawModel, mm] of Object.entries<any>(d.modelMetrics)) {
              const model = safeKey(rawModel);
              if (!model) continue;
              const u = {
                input: Math.max(0, num(mm?.usage?.inputTokens) - num(mm?.usage?.cacheReadTokens)),
                output: num(mm?.usage?.outputTokens),
                cacheRead: num(mm?.usage?.cacheReadTokens),
                cacheWrite: num(mm?.usage?.cacheWriteTokens),
              };
              metricsUsage.input += u.input;
              metricsUsage.output += u.output;
              metricsUsage.cacheRead += u.cacheRead;
              metricsUsage.cacheWrite += u.cacheWrite;
              models.add(model);
              addDaily(usageDaily, ts ?? s.end, model, u);
            }
          }
          if (d.codeChanges && typeof d.codeChanges === 'object') {
            s.linesAdded = num(d.codeChanges.linesAdded) || s.linesAdded;
            s.linesRemoved = num(d.codeChanges.linesRemoved) || s.linesRemoved;
          }
          break;
        }
      }
    });
    s.models = [...models];
    // shutdown modelMetrics is authoritative; otherwise only streamed output tokens are known
    s.tokens = metricsUsage ?? { input: 0, output: outputTokens, cacheRead: 0, cacheWrite: 0 };
    if (Object.keys(usageDaily).length) s.usageDaily = usageDaily;

    const contribution: Contribution = { path: cwd, tools: ['copilot-cli'], sessions: [s] };

    const planPath = join(dir, 'plan.md');
    const plan = readText(planPath);
    if (plan) contribution.plans = [{ tool: 'copilot-cli', path: planPath, content: clean(redact(plan)), mtime: stat(planPath)?.mtimeMs ?? 0 }];

    const todos = await readTodos(join(dir, 'session.db'));
    if (todos.length) contribution.todos = todos;

    out.push(contribution);
  }
  return out;
}

async function readTodos(dbPath: string): Promise<Todo[]> {
  if (!stat(dbPath)) return [];
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      // a crafted DB could make `todos` a VIEW with an expensive/recursive query: require a real table, cap rows
      const kind = db.prepare("SELECT type FROM sqlite_master WHERE name = 'todos'").get() as { type?: string } | undefined;
      if (kind?.type !== 'table') return [];
      db.exec('PRAGMA query_only = ON');
      const rows = db.prepare('SELECT title, status, description FROM todos ORDER BY created_at LIMIT 500').all() as any[];
      const STATUS = new Set(['pending', 'in_progress', 'done', 'blocked']);
      return rows.map((r) => ({
        title: text(r.title) ?? '(untitled)',
        status: STATUS.has(r.status) ? String(r.status) : 'pending',
        description: text(r.description),
      }));
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

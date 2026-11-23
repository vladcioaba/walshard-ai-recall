import { fileURLToPath } from 'node:url';
import type { Contribution, Session } from '../types.ts';
import { HOME, join, num, oneLine, readJson, readdir, redact, safeKey, str, text, toMs } from '../util.ts';

function storageRoots(): string[] {
  const variants = ['Code', 'Code - Insiders', 'Cursor', 'Windsurf', 'VSCodium'];
  const base =
    process.platform === 'darwin'
      ? join(HOME, 'Library', 'Application Support')
      : process.platform === 'win32'
        ? process.env.APPDATA ?? join(HOME, 'AppData', 'Roaming')
        : join(HOME, '.config');
  return variants.map((v) => join(base, v, 'User', 'workspaceStorage'));
}

/** VS Code-family Copilot Chat: workspaceStorage/<hash>/{workspace.json, chatSessions/*.json} */
export async function scanVscode(): Promise<Contribution[]> {
  const out: Contribution[] = [];
  for (const root of storageRoots()) {
    const editor = root.split(/[\\/]/).at(-3) ?? 'Code';
    for (const hash of readdir(root)) {
      const dir = join(root, hash);
      const ws = readJson<any>(join(dir, 'workspace.json'));
      const folder = ws?.folder ?? ws?.workspace;
      if (typeof folder !== 'string' || !folder.startsWith('file://')) continue;
      let p: string;
      try {
        p = fileURLToPath(folder);
      } catch {
        continue;
      }
      const chatDir = join(dir, 'chatSessions');
      const files = readdir(chatDir).filter((f) => f.endsWith('.json'));
      if (!files.length) continue; // workspace without AI chat: not interesting

      const sessions: Session[] = [];
      for (const f of files) {
        const c = readJson<any>(join(chatDir, f));
        if (!c) continue;
        const reqs: any[] = Array.isArray(c.requests) ? c.requests : [];
        if (!reqs.length) continue;
        const first = str(reqs.find((r) => typeof r?.message?.text === 'string')?.message?.text);
        sessions.push({
          tool: 'vscode-copilot',
          id: safeKey(c.sessionId) ?? f.replace(/\.json$/, ''),
          title: text(c.customTitle) ?? (first ? oneLine(redact(first), 80) : undefined),
          firstPrompt: first ? oneLine(redact(first), 200) : undefined,
          start: toMs(c.creationDate) ?? toMs(reqs[0]?.timestamp),
          end: toMs(c.lastMessageDate) ?? toMs(reqs.at(-1)?.timestamp),
          userMessages: Math.min(reqs.length, 1e6),
          assistantMessages: reqs.filter((r) => r?.response).length,
          models: editor === 'Code' ? [] : [editor],
          file: join(chatDir, f),
        });
      }
      if (sessions.length) out.push({ path: p, tools: ['vscode-copilot'], sessions });
    }
  }
  return out;
}

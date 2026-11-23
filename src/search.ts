import type { Project } from './types.ts';

export type DocKind = 'path' | 'session' | 'memory' | 'prompt' | 'plan' | 'todo' | 'branch';

export interface Doc {
  kind: DocKind;
  label: string;
  text: string;
  ts?: number;
}

export interface Hit {
  kind: DocKind;
  label: string;
  snippet: string;
  ts?: number;
}

export interface SearchResult {
  id: string;
  path: string;
  name: string;
  score: number;
  hits: Hit[];
}

const WEIGHT: Record<DocKind, number> = { path: 12, branch: 6, session: 6, memory: 4, plan: 3, todo: 3, prompt: 1 };

/** Searchable docs for a project. `allPrompts` is the uncapped prompt history. */
export function buildDocs(p: Project, allPrompts: { text: string; ts: number }[]): Doc[] {
  const docs: Doc[] = [{ kind: 'path', label: 'path', text: p.path }];
  if (p.git?.branch) docs.push({ kind: 'branch', label: 'branch', text: p.git.branch });
  for (const s of p.sessions) {
    const text = [s.title, s.firstPrompt, s.branch].filter(Boolean).join(' — ');
    if (text) docs.push({ kind: 'session', label: s.title ?? 'session', text, ts: s.end ?? s.start });
  }
  for (const m of p.memory) docs.push({ kind: 'memory', label: m.name, text: `${m.description ?? ''}\n${m.content}`, ts: m.mtime });
  for (const pl of p.plans) docs.push({ kind: 'plan', label: 'plan.md', text: pl.content, ts: pl.mtime });
  for (const t of p.todos) docs.push({ kind: 'todo', label: t.status, text: `${t.title} ${t.description ?? ''}` });
  for (const x of allPrompts) docs.push({ kind: 'prompt', label: 'prompt', text: x.text, ts: x.ts });
  return docs;
}

export function search(projects: Project[], corpus: Map<string, Doc[]>, query: string, maxHits = 4): SearchResult[] {
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 0);
  if (!terms.length) return [];
  const out: SearchResult[] = [];

  for (const p of projects) {
    const docs = corpus.get(p.id) ?? [];
    const lowered = docs.map((d) => d.text.toLowerCase());
    // every term must appear somewhere in the project
    if (!terms.every((t) => lowered.some((l) => l.includes(t)))) continue;

    const scored: { d: Doc; n: number; i: number }[] = [];
    docs.forEach((d, i) => {
      const n = terms.filter((t) => lowered[i].includes(t)).length;
      if (n) scored.push({ d, n, i });
    });
    // best single match dominates; number of matches is only a tie-breaker
    let best = 0;
    for (const s of scored) best = Math.max(best, WEIGHT[s.d.kind] * s.n * (s.n === terms.length ? 2 : 1));
    let score = best * 10 + Math.min(scored.length, 20);
    // gentle recency boost
    const ageDays = p.lastActive ? (Date.now() - p.lastActive) / 864e5 : 365;
    score *= 1 + 1 / (1 + ageDays / 30);

    scored.sort((a, b) => b.n - a.n || WEIGHT[b.d.kind] - WEIGHT[a.d.kind] || (b.d.ts ?? 0) - (a.d.ts ?? 0));
    const hits = scored
      .filter((s) => s.d.kind !== 'path')
      .slice(0, maxHits)
      .map(({ d, i }) => ({ kind: d.kind, label: d.label, ts: d.ts, snippet: snippet(d.text, lowered[i], terms) }));
    out.push({ id: p.id, path: p.path, name: p.name, score: Math.round(score), hits });
  }
  return out.sort((a, b) => b.score - a.score);
}

function snippet(text: string, lower: string, terms: string[], radius = 70): string {
  const pos = Math.min(...terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0));
  const start = Math.max(0, pos - radius);
  const end = Math.min(text.length, pos + radius * 2);
  return (start > 0 ? '…' : '') + text.slice(start, end).replace(/\s+/g, ' ').trim() + (end < text.length ? '…' : '');
}

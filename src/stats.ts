import { PRICING_AS_OF, addUsage, emptyUsage, estimateCost, totalTokens, type Usage } from './pricing.ts';
import type { Project, Session, Tool } from './types.ts';
import { HOME, dayKey, dict, join, readJson, safeKey } from './util.ts';

export interface Cost {
  /** Cost the agent itself recorded (Claude `cost-state`). */
  recorded?: number;
  /** API list-price estimate from token counts; undefined if no priced model. */
  estimated?: number;
}

/** Usage per model for one session, optionally limited to days >= sinceDay. */
export function sessionUsage(s: Session, sinceDay?: string): Map<string, Usage> {
  const out = new Map<string, Usage>();
  if (s.usageDaily && Object.keys(s.usageDaily).length) {
    for (const [day, models] of Object.entries(s.usageDaily)) {
      if (sinceDay && day < sinceDay) continue;
      for (const [raw, u] of Object.entries(models ?? {})) {
        const model = safeKey(raw);
        if (model) addUsage(out.get(model) ?? out.set(model, emptyUsage()).get(model)!, u);
      }
    }
    return out;
  }
  // no per-day data: attribute session totals to its end day and first model
  if (!s.tokens || !totalTokens(s.tokens)) return out;
  const when = s.end ?? s.start;
  if (sinceDay && (!when || dayKey(when) < sinceDay)) return out;
  out.set(s.models?.[0] ?? 'unknown', { ...s.tokens });
  return out;
}

export function sessionCost(s: Session, sinceDay?: string): Cost {
  let estimated: number | undefined;
  for (const [model, u] of sessionUsage(s, sinceDay)) {
    const c = estimateCost(model, u);
    if (c !== undefined) estimated = (estimated ?? 0) + c;
  }
  // recorded cost is whole-session; only meaningful without a date window
  return { recorded: sinceDay ? undefined : s.costUSD, estimated };
}

/** Best single number: what the agent recorded, else our estimate. */
export const bestCost = (c: Cost) => c.recorded ?? c.estimated ?? 0;

interface Bucket {
  tokens: Usage;
  cost: number;
  sessions: number;
}
const bucket = (): Bucket => ({ tokens: emptyUsage(), cost: 0, sessions: 0 });

export interface Stats {
  window: { days?: number; sinceDay?: string };
  pricingAsOf: string;
  totals: Bucket & { recordedCost: number; estimatedOnlyCost: number; premiumRequests: number; unpricedTokens: number };
  byTool: Record<string, Bucket>;
  byModel: Record<string, Bucket & { priced: boolean }>;
  byProject: { id: string; name: string; path: string; lastActive: number; tokens: number; cost: number; sessions: number }[];
  daily: { day: string; tokens: number; cost: number }[];
  claudeAllTime?: ClaudeAllTime;
}

export interface ClaudeAllTime {
  asOf?: string;
  totalSessions?: number;
  totalMessages?: number;
  firstSessionDate?: string;
  costUSD: number;
  /** API list-price estimate from its token counts (costUSD is 0 on subscriptions). */
  estCostUSD: number;
  models: { model: string; tokens: number; costUSD: number; estCostUSD?: number }[];
  busiestHours: { hour: number; count: number }[];
}

export function computeStats(projects: Project[], opts: { days?: number } = {}): Stats {
  const sinceDay = opts.days ? dayKey(Date.now() - (opts.days - 1) * 864e5) : undefined;
  const totals = { ...bucket(), recordedCost: 0, estimatedOnlyCost: 0, premiumRequests: 0, unpricedTokens: 0 };
  const byTool: Record<string, Bucket> = dict();
  const byModel: Record<string, Bucket & { priced: boolean }> = dict();
  const byProject: Stats['byProject'] = [];
  const dailyMap = new Map<string, { tokens: number; cost: number }>();

  for (const p of projects) {
    const pb = { tokens: 0, cost: 0, sessions: 0 };
    for (const s of p.sessions) {
      const usage = sessionUsage(s, sinceDay);
      if (!usage.size && !(s.premiumRequests && !sinceDay)) continue;
      const cost = sessionCost(s, sinceDay);
      const c = bestCost(cost);
      const tb = (byTool[s.tool as Tool] ??= bucket());
      tb.sessions++;
      tb.cost += c;
      totals.sessions++;
      totals.cost += c;
      if (cost.recorded !== undefined) totals.recordedCost += cost.recorded;
      else totals.estimatedOnlyCost += cost.estimated ?? 0;
      if (!sinceDay) totals.premiumRequests += s.premiumRequests ?? 0;
      pb.sessions++;
      pb.cost += c;

      for (const [model, u] of usage) {
        const mb = (byModel[model] ??= { ...bucket(), priced: estimateCost(model, emptyUsage()) !== undefined });
        addUsage(mb.tokens, u);
        mb.sessions++;
        mb.cost += estimateCost(model, u) ?? 0;
        addUsage(tb.tokens, u);
        addUsage(totals.tokens, u);
        if (!mb.priced) totals.unpricedTokens += totalTokens(u);
        pb.tokens += totalTokens(u);
      }
      // daily series (estimated cost per day; recorded cost has no per-day split)
      for (const [day, models] of Object.entries(s.usageDaily ?? {})) {
        if (sinceDay && day < sinceDay) continue;
        const d = dailyMap.get(day) ?? dailyMap.set(day, { tokens: 0, cost: 0 }).get(day)!;
        for (const [raw, u] of Object.entries(models ?? {})) {
          const model = safeKey(raw);
          if (!model) continue;
          d.tokens += totalTokens(u);
          d.cost += estimateCost(model, u) ?? 0;
        }
      }
    }
    if (pb.sessions) byProject.push({ id: p.id, name: p.name, path: p.path, lastActive: p.lastActive, ...pb });
  }
  byProject.sort((a, b) => b.cost - a.cost || b.tokens - a.tokens);

  // contiguous daily series for the window (or the last 30 days of data)
  const days = opts.days ?? 30;
  const daily: Stats['daily'] = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = dayKey(Date.now() - i * 864e5);
    daily.push({ day, ...(dailyMap.get(day) ?? { tokens: 0, cost: 0 }) });
  }

  return {
    window: { days: opts.days, sinceDay },
    pricingAsOf: PRICING_AS_OF,
    totals,
    byTool,
    byModel,
    byProject,
    daily,
    claudeAllTime: readClaudeStatsCache(),
  };
}

/** ~/.claude/stats-cache.json: Claude Code's own all-time counters (may be stale). */
function readClaudeStatsCache(): ClaudeAllTime | undefined {
  const d = readJson<any>(join(HOME, '.claude', 'stats-cache.json'));
  if (!d) return undefined;
  const models = Object.entries<any>(d.modelUsage ?? {})
    .map(([model, u]) => {
      const usage = { input: u.inputTokens ?? 0, output: u.outputTokens ?? 0, cacheRead: u.cacheReadInputTokens ?? 0, cacheWrite: u.cacheCreationInputTokens ?? 0 };
      return { model, tokens: totalTokens(usage), costUSD: Number(u.costUSD) || 0, estCostUSD: estimateCost(model, usage) };
    })
    .sort((a, b) => (b.estCostUSD ?? 0) - (a.estCostUSD ?? 0) || b.tokens - a.tokens);
  const busiestHours = Object.entries<any>(d.hourCounts ?? {})
    .map(([h, n]) => ({ hour: Number(h), count: Number(n) || 0 }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 3);
  return {
    asOf: d.lastComputedDate,
    totalSessions: d.totalSessions,
    totalMessages: d.totalMessages,
    firstSessionDate: d.firstSessionDate,
    costUSD: models.reduce((n, m) => n + m.costUSD, 0),
    estCostUSD: models.reduce((n, m) => n + (m.estCostUSD ?? 0), 0),
    models,
    busiestHours,
  };
}

/**
 * Anthropic first-party API list prices, USD per 1M tokens (snapshot 2026-11-03).
 * Used only to ESTIMATE an API-equivalent cost from token counts. Subscription users
 * (Claude Pro/Max) don't pay per token, so treat these as "what this would cost on the API".
 * Cache write = 1.25 × input (5-minute TTL); cache read = 0.1 × input unless listed.
 */
interface Rate {
  input: number;
  output: number;
  cacheRead?: number;
}

const RATES: [prefix: string, rate: Rate][] = [
  // longest/most specific prefixes first
  ['claude-fable-5-2', { input: 8, output: 40, cacheRead: 0.2 }],
  ['claude-mythos-5-2', { input: 8, output: 40, cacheRead: 0.2 }],
  ['claude-fable-5-1', { input: 10, output: 50 }],
  ['claude-mythos-5-1', { input: 10, output: 50 }],
  ['claude-fable-5', { input: 10, output: 50 }],
  ['claude-mythos-5', { input: 10, output: 50 }],
  ['claude-opus-5-5', { input: 4, output: 20, cacheRead: 0.2 }],
  ['claude-opus-5', { input: 5, output: 25 }],
  ['claude-opus-4-8', { input: 5, output: 25 }],
  ['claude-opus-4-7', { input: 5, output: 25 }],
  ['claude-opus-4-6', { input: 5, output: 25 }],
  ['claude-opus-4-5', { input: 5, output: 25 }],
  ['claude-opus-4', { input: 15, output: 75 }],
  ['claude-sonnet-5-5', { input: 2, output: 10, cacheRead: 0.1 }],
  ['claude-sonnet-5', { input: 2, output: 10 }],
  ['claude-sonnet-4', { input: 3, output: 15 }],
  ['claude-3-7-sonnet', { input: 3, output: 15 }],
  ['claude-haiku-5-5', { input: 0.1, output: 0.5 }],
  ['claude-haiku-4-5', { input: 1, output: 5 }],
  ['claude-3-5-haiku', { input: 0.8, output: 4 }],
];

export const PRICING_AS_OF = '2026-11-03';

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export function emptyUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

export function addUsage(a: Usage, b: Partial<Usage> | undefined): Usage {
  a.input += n(b?.input);
  a.output += n(b?.output);
  a.cacheRead += n(b?.cacheRead);
  a.cacheWrite += n(b?.cacheWrite);
  return a;
}

export function totalTokens(u: Usage): number {
  return u.input + u.output + u.cacheRead + u.cacheWrite;
}

export function rateFor(model: string): Rate | undefined {
  const m = model.toLowerCase().replace(/^(anthropic\.|us\.anthropic\.)/, '');
  return RATES.find(([prefix]) => m === prefix || m.startsWith(prefix + '-') || m.startsWith(prefix + '@') || m.startsWith(prefix + '['))?.[1];
}

/** Estimated USD, or undefined when the model has no known price (e.g. non-Anthropic models). */
export function estimateCost(model: string, u: Usage): number | undefined {
  const r = rateFor(model);
  if (!r) return undefined;
  const cacheRead = r.cacheRead ?? r.input * 0.1;
  return (u.input * r.input + u.output * r.output + u.cacheWrite * r.input * 1.25 + u.cacheRead * cacheRead) / 1e6;
}

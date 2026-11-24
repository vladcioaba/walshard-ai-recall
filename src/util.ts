import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HOME = os.homedir();

export function readdir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

export function stat(p: string): fs.Stats | undefined {
  try {
    return fs.statSync(p);
  } catch {
    return undefined;
  }
}

export function readText(p: string, max = 512 * 1024): string | undefined {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return undefined;
    if (st.size <= max) return fs.readFileSync(p, 'utf8');
    const fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(max);
    fs.readSync(fd, buf, 0, max, 0);
    fs.closeSync(fd);
    return buf.toString('utf8') + '\n…(truncated)';
  } catch {
    return undefined;
  }
}

export function readJson<T = any>(p: string): T | undefined {
  const t = readText(p, 64 * 1024 * 1024);
  if (t === undefined) return undefined;
  try {
    return JSON.parse(t) as T;
  } catch {
    return undefined;
  }
}

const MAX_LINE = 32 * 1024 * 1024; // skip absurd single lines instead of crashing

/**
 * Stream a .jsonl file line by line; `filter` is a cheap substring pre-check before JSON.parse.
 * Hand-rolled splitter (not readline) so a multi-hundred-MB line is skipped instead of throwing
 * an uncatchable RangeError.
 */
export async function eachJsonl(file: string, fn: (o: any) => void, filter?: (line: string) => boolean): Promise<void> {
  let stream: fs.ReadStream;
  try {
    stream = fs.createReadStream(file);
  } catch {
    return;
  }
  const handle = (buf: Buffer) => {
    if (!buf.length) return;
    const line = buf.toString('utf8');
    if (filter && !filter(line)) return;
    try {
      fn(JSON.parse(line));
    } catch {
      /* skip malformed line or callback error */
    }
  };
  let parts: Buffer[] = [];
  let size = 0;
  let skipping = false;
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      let start = 0;
      for (let i = chunk.indexOf(10); i !== -1; i = chunk.indexOf(10, start)) {
        if (!skipping) {
          parts.push(chunk.subarray(start, i));
          handle(parts.length === 1 ? parts[0] : Buffer.concat(parts));
        }
        parts = [];
        size = 0;
        skipping = false;
        start = i + 1;
      }
      if (start < chunk.length && !skipping) {
        size += chunk.length - start;
        if (size > MAX_LINE) {
          skipping = true;
          parts = [];
        } else parts.push(chunk.subarray(start));
      }
    }
    if (!skipping && parts.length) handle(Buffer.concat(parts));
  } catch {
    /* unreadable file */
  }
}

/** String or undefined — never trust JSON field types. */
export function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

/** Finite non-negative number, else 0. */
export function num(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Strip terminal/control/bidi characters from display text (ANSI/OSC injection, line forging). */
export function clean(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '');
}

/** Free text from untrusted files: type-check, strip control chars, redact secrets. */
export function text(v: unknown): string | undefined {
  const s = str(v);
  return s === undefined ? undefined : redact(clean(s));
}

const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
/** Map key from untrusted data, or undefined if it could pollute prototypes. */
export function safeKey(v: unknown): string | undefined {
  const s = str(v);
  return s && !BAD_KEYS.has(s) && s.length <= 200 ? clean(s) : undefined;
}

/** Prototype-less record. */
export function dict<T>(): Record<string, T> {
  return Object.create(null);
}

/** Claude Code folder-name encoding: every non-alphanumeric char becomes '-'. Lossy. */
export function encodeClaudePath(p: string): string {
  return p.replace(/[^a-zA-Z0-9]/g, '-');
}

export function slug(p: string): string {
  return encodeClaudePath(p).replace(/^-+/, '').toLowerCase() || 'root';
}

export function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const kv = /^\s*([\w-]+):\s*(.*)$/.exec(line);
    if (kv && kv[2]) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, '').replace(/\\(["'])/g, '$1');
  }
  return { meta, body: text.slice(m[0].length) };
}

/** Minimal flat YAML (key: value per line). Enough for Copilot workspace.yaml. */
export function parseFlatYaml(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

const SECRET_PATTERNS: [RegExp, boolean][] = [
  // [pattern, keepsGroup1Prefix]
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END[^-]*-----|$)/g, false],
  [/\bsk-ant-[A-Za-z0-9_-]{16,}/g, false],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, false],
  [/\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g, false],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, false],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, false],
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, false],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, false],
  [/\bAIza[0-9A-Za-z_-]{35}/g, false],
  [/\bya29\.[0-9A-Za-z_-]{20,}/g, false],
  [/\bxox[a-z]-[A-Za-z0-9-]{10,}/g, false],
  [/\bxoxe\.[A-Za-z0-9.-]{10,}/g, false],
  [/\bxapp-[A-Za-z0-9-]{10,}/g, false],
  [/https:\/\/hooks\.slack\.com\/[^\s"']+/g, false],
  [/\bnpm_[A-Za-z0-9]{30,}/g, false],
  [/\bhf_[A-Za-z0-9]{30,}/g, false],
  [/\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, false],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, false],
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s\/:@"']+:)[^\s@\/"']+(?=@)/gi, true], // scheme://user:PASSWORD@
  [/(\bBearer\s+)[A-Za-z0-9._~+\/-]{16,}=*/g, true],
  [/(\b[\w-]*(?:api[_-]?key|access[_-]?key|secret|token|passw(?:or)?d|pwd|credential)s?["']?\s*[:=]\s*["']?)[^\s"',;]{4,}/gi, true],
  [/(--?(?:password|passwd|token|api-key|secret)[ =])[^\s"']{4,}/gi, true],
];

export function redact(s: string): string {
  let out = s;
  for (const [re, keep] of SECRET_PATTERNS) out = out.replace(re, (m, p1) => (keep && typeof p1 === 'string' ? p1 : '') + '‹redacted›');
  return out;
}

/** Collapse whitespace, strip control chars, truncate. Redact BEFORE calling this on secrets-bearing text. */
export function oneLine(s: string, max = 120): string {
  const t = clean(String(s)).replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

export function toMs(v: unknown): number | undefined {
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  if (typeof v === 'string' && v) {
    const n = Date.parse(v);
    return Number.isNaN(n) ? undefined : n;
  }
  return undefined;
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === 'EPERM';
  }
}

export function tildify(p: string): string {
  return clean(p.startsWith(HOME) ? '~' + p.slice(HOME.length) : p);
}

export function join(...p: string[]): string {
  return path.join(...p);
}

/** Local calendar day, YYYY-MM-DD. */
export function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function addDaily(
  target: NonNullable<import('./types.ts').Session['usageDaily']>,
  ms: number | undefined,
  model: string,
  u: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number },
): void {
  const key = safeKey(model);
  if (!ms || !key) return;
  const day = (target[dayKey(ms)] ??= dict());
  const m = (day[key] ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  m.input += num(u.input);
  m.output += num(u.output);
  m.cacheRead += num(u.cacheRead);
  m.cacheWrite += num(u.cacheWrite);
}

/** The last lines of an agent reply: control chars stripped, secrets redacted, earlier text dropped. */
export function replyTail(raw: string, maxLines = 8, maxChars = 900): string {
  const lines = redact(clean(raw)).split('\n').map((l) => l.trimEnd());
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  let out = lines.filter((l, i, a) => l || (a[i - 1] ?? '')).slice(-maxLines).join('\n').trim();
  if (out.length > maxChars) out = out.slice(-maxChars).replace(/^\S*\s/, '');
  // don't start inside a code block: drop an orphan closing fence
  if ((out.match(/^```/gm) ?? []).length % 2) out = out.replace(/^[\s\S]*?^```.*$\n?/m, '');
  const trimmed = out.length < lines.join('\n').trim().length;
  return (trimmed ? '… ' : '') + out.trim();
}

/** Tracks the last prompt and last text reply of one session, in transcript order. */
export class Turns {
  private prompt?: string;
  private reply?: string;
  private replyAt?: number;
  onPrompt(txt: unknown): void {
    if (typeof txt !== 'string' || !txt.trim() || txt.startsWith('<') || txt.startsWith('[Request interrupted')) return;
    this.prompt = oneLine(redact(txt), 300);
  }
  onReply(txt: unknown, ts?: number): void {
    if (typeof txt !== 'string' || !txt.trim()) return;
    this.reply = txt;
    this.replyAt = ts;
  }
  result(): { lastPrompt?: string; lastReply?: string; lastReplyAt?: number } {
    return { lastPrompt: this.prompt, lastReply: this.reply ? replyTail(this.reply) : undefined, lastReplyAt: this.replyAt };
  }
}

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { validSessionId } from './resume.ts';
import type { Session } from './types.ts';
import { HOME, text } from './util.ts';

/**
 * airecall's own persistent index (~/.airecall/sessions.json).
 * Keeps a numbers-and-titles summary of sessions so history survives agent-side cleanup
 * (Claude Code deletes transcripts after `cleanupPeriodDays`, default 30).
 *
 * Privacy rules:
 *  - never stores prompt text (no firstPrompt); titles are re-redacted on every load
 *  - entries older than AIRECALL_INDEX_DAYS (default 365) or beyond 10k sessions are dropped
 *  - `airecall forget <project|session>` / `airecall purge` delete data
 *  - AIRECALL_NO_INDEX=1 disables it entirely
 * This is the ONLY place airecall writes.
 */
const DIR = process.env.AIRECALL_DATA ?? path.join(HOME, '.airecall');
const FILE = path.join(DIR, 'sessions.json');
const MAX_SESSIONS = 10_000;
const RETENTION_DAYS = Number(process.env.AIRECALL_INDEX_DAYS) > 0 ? Number(process.env.AIRECALL_INDEX_DAYS) : 365;

interface Entry {
  path: string;
  session: Session;
  seenAt: number;
}
interface Stored {
  version: 1;
  sessions: Record<string, Entry>;
}

const key = (s: Session) => `${s.tool}:${s.id}`;

export function storeEnabled(): boolean {
  return !process.env.AIRECALL_NO_INDEX;
}

const LEGACY_DIR = path.join(HOME, '.aimon'); // pre-rename data folder

/** One-time move of ~/.aimon to ~/.airecall (only real, owned directories; never through symlinks). */
function migrateLegacy(): void {
  if (process.env.AIRECALL_DATA) return;
  try {
    fs.lstatSync(DIR);
    return; // new dir already exists
  } catch {
    /* fall through */
  }
  try {
    const st = fs.lstatSync(LEGACY_DIR);
    if (!st.isDirectory() || st.isSymbolicLink()) return;
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return;
    fs.renameSync(LEGACY_DIR, DIR);
  } catch {
    /* nothing to migrate */
  }
}

/** Refuse anything but a real, private directory owned by us. */
function safeDir(create: boolean): boolean {
  migrateLegacy();
  let st: fs.Stats;
  try {
    st = fs.lstatSync(DIR);
  } catch {
    if (!create) return false;
    fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
    st = fs.lstatSync(DIR);
  }
  if (st.isSymbolicLink() || !st.isDirectory()) return false;
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return false;
  if ((st.mode & 0o077) !== 0) fs.chmodSync(DIR, 0o700);
  return true;
}

function sanitize(e: any): Entry | undefined {
  const s = e?.session;
  if (!s || typeof e.path !== 'string' || !validSessionId(s.id)) return undefined;
  if (!['claude', 'copilot-cli', 'vscode-copilot', 'codex'].includes(s.tool)) return undefined;
  const { firstPrompt, lastPrompt, lastReply, lastReplyAt, running, file, archived, title, ...rest } = s;
  void firstPrompt, lastPrompt, lastReply, lastReplyAt, running, file, archived;
  return { path: e.path, seenAt: Number(e.seenAt) || 0, session: { ...rest, title: text(title) } };
}

export function loadStore(): Stored {
  const empty: Stored = { version: 1, sessions: Object.create(null) };
  try {
    if (!safeDir(false)) return empty;
    const st = fs.lstatSync(FILE);
    if (!st.isFile()) return empty; // symlink or something else: ignore
    const d = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (d?.version !== 1 || !d.sessions || typeof d.sessions !== 'object') return empty;
    for (const [k, v] of Object.entries(d.sessions)) {
      const e = sanitize(v);
      if (e && !['__proto__', 'constructor', 'prototype'].includes(k)) empty.sessions[k] = e;
    }
  } catch {
    /* first run or unreadable */
  }
  return empty;
}

function writeStore(store: Stored): void {
  if (!safeDir(true)) return;
  try {
    if (fs.lstatSync(FILE).isSymbolicLink()) fs.unlinkSync(FILE); // never write through a planted link
  } catch {
    /* doesn't exist yet */
  }
  const tmp = path.join(DIR, `.sessions.${crypto.randomBytes(6).toString('hex')}.tmp`);
  const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    fs.writeSync(fd, JSON.stringify(store));
    fs.fchmodSync(fd, 0o600);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, FILE);
}

function prune(store: Stored): void {
  const cutoff = Date.now() - RETENTION_DAYS * 864e5;
  const entries = Object.entries(store.sessions);
  for (const [k, e] of entries) {
    const last = e.session.end ?? e.session.start ?? e.seenAt;
    if (last && last < cutoff) delete store.sessions[k];
  }
  const left = Object.entries(store.sessions);
  if (left.length > MAX_SESSIONS) {
    left.sort((a, b) => (a[1].session.end ?? a[1].seenAt) - (b[1].session.end ?? b[1].seenAt));
    for (const [k] of left.slice(0, left.length - MAX_SESSIONS)) delete store.sessions[k];
  }
}

/**
 * Merge live sessions into the store; return stored sessions that are no longer live (archived).
 */
export function syncStore(live: { path: string; session: Session }[]): { path: string; session: Session }[] {
  if (!storeEnabled()) return [];
  const store = loadStore();
  const liveKeys = new Set<string>();
  const now = Date.now();
  for (const { path: p, session } of live) {
    if (!validSessionId(session.id)) continue;
    if (session.running && !session.file) continue; // live-only stub, nothing worth keeping
    const k = key(session);
    liveKeys.add(k);
    const e = sanitize({ path: p, session, seenAt: now });
    if (e) store.sessions[k] = e;
  }
  prune(store);
  const archived = Object.entries(store.sessions)
    .filter(([k]) => !liveKeys.has(k))
    .map(([, v]) => ({ path: v.path, session: { ...v.session, archived: true } }));
  try {
    writeStore(store);
  } catch {
    /* read-only home etc. — still return what we have */
  }
  return archived;
}

/** Delete stored sessions whose id or project path matches. Returns how many were removed. */
export function forget(match: (e: { key: string; path: string; id: string }) => boolean): number {
  const store = loadStore();
  let n = 0;
  for (const [k, e] of Object.entries(store.sessions)) {
    if (match({ key: k, path: e.path, id: e.session.id })) {
      delete store.sessions[k];
      n++;
    }
  }
  if (n) writeStore(store);
  return n;
}

/** Remove the whole index file. */
export function purge(): boolean {
  try {
    const st = fs.lstatSync(FILE);
    fs.unlinkSync(FILE);
    return st.isFile() || st.isSymbolicLink();
  } catch {
    return false;
  }
}

export const STORE_FILE = FILE;

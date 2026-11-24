import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resumeCommand, validSessionId } from './resume.ts';
import { readProjectFile, scanAll, type ScanResult } from './scan.ts';
import { search } from './search.ts';
import { computeStats } from './stats.ts';
import type { Project, Tool } from './types.ts';
import { dict, tildify } from './util.ts';
import { version } from './version.ts';

const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');
// Bind AND advertise the IPv4 literal: opening "localhost" lets another user squat on [::1]:PORT.
const HOST = '127.0.0.1';
const MAX_BODY = 16 * 1024;

let cache: ScanResult | undefined;
let scanning: Promise<ScanResult> | undefined;

async function getScan(force = false): Promise<ScanResult> {
  if (cache && !force && Date.now() - cache.scannedAt < 30_000) return cache;
  // never let a forced refresh start a second concurrent scan
  scanning ??= scanAll().finally(() => (scanning = undefined));
  cache = await scanning;
  return cache;
}

/** List view: drop heavy fields. */
function summary(p: Project) {
  const { memory, prompts, plans, sessions, ...rest } = p;
  const memoryTypes = dict<number>();
  for (const m of memory) memoryTypes[m.type ?? 'other'] = (memoryTypes[m.type ?? 'other'] ?? 0) + 1;
  return {
    ...rest,
    display: tildify(p.path),
    memoryCount: memory.length,
    memoryTypes,
    running: sessions.some((s) => s.running),
    headline:
      sessions.find((s) => s.title && s.title !== '(running now)')?.title ??
      memory.find((m) => m.type === 'project' && m.description)?.description ??
      prompts.find((x) => !/^[/!]/.test(x.text) && x.text.trim().split(/\s+/).length >= 4)?.text ??
      '',
    lastPrompt: prompts[0]?.text,
  };
}

/** Detail view: add the server-built resume command per session (the UI never builds shell text). */
function detail(p: Project) {
  return {
    ...p,
    display: tildify(p.path),
    sessions: p.sessions.map((s) => ({
      ...s,
      resume: p.exists && !s.archived && s.tool !== 'vscode-copilot' ? resumeCommand(p.path, s.tool, s.id) : undefined,
    })),
    resume: p.exists ? resumeCommand(p.path, 'claude') : undefined,
  };
}

export interface ServerOptions {
  port: number; // 0 = any free port
  open: boolean;
  /** Pick mode: first project chosen in the UI is returned and the server shuts down. */
  pick?: boolean;
}

export interface Choice {
  project: Project;
  sessionId?: string;
  tool?: Tool;
}

class HttpError extends Error {
  status: number;
  constructor(status: number, msg: string) {
    super(msg);
    this.status = status;
  }
}

/**
 * Normal mode: runs until Ctrl+C.
 * Pick mode: resolves with the user's choice, or undefined when they press Close in the UI or
 * the tab goes away (heartbeat stops). No idle timeout: an open tab can stay as long as the user
 * wants (Ctrl+C also cancels).
 */
export async function startServer(opts: ServerOptions): Promise<Choice | undefined> {
  // Per-run secret. Host/Origin checks only stop browsers; the token also stops other local
  // processes, other users on the machine and port-forwarders from reading or driving the API.
  const token = crypto.randomBytes(32).toString('base64url');
  let origin = ''; // exact allowed origin, set once the port is known
  let resolveChoice: (c: Choice | undefined) => void = () => {};
  const chosen = new Promise<Choice | undefined>((r) => (resolveChoice = r));
  let lastPing = 0;
  let done = false;

  const server = http.createServer(async (req, res) => {
    try {
      // DNS-rebinding guard: only answer requests addressed to our exact loopback host
      if (req.headers.host !== origin.slice('http://'.length)) throw new HttpError(403, 'forbidden host');
      const url = new URL(req.url ?? '/', origin);

      if (url.pathname.startsWith('/api/')) {
        // cross-site/no-cors requests (img tags, form posts) never reach handlers
        const site = req.headers['sec-fetch-site'];
        if (site && site !== 'same-origin') throw new HttpError(403, 'cross-site');
        const given = String(req.headers['x-airecall-token'] ?? '');
        if (given.length !== token.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(token)))
          throw new HttpError(401, 'missing or bad token');
        if (req.method === 'POST') {
          if (req.headers.origin !== origin) throw new HttpError(403, 'bad origin');
          if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) throw new HttpError(415, 'json only');
        }
        lastPing = Date.now();
        return await api(req, res, url);
      }

      if (req.method !== 'GET') throw new HttpError(405, 'method not allowed');
      // static UI (no data in these files; the token gates everything else)
      const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const full = path.join(UI_DIR, file);
      if (!full.startsWith(UI_DIR + path.sep) || !fs.existsSync(full) || !fs.lstatSync(full).isFile()) throw new HttpError(404, 'not found');
      const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }[path.extname(full)] ?? 'application/octet-stream';
      return send(res, 200, fs.readFileSync(full), `${type}; charset=utf-8`);
    } catch (e: any) {
      if (e instanceof HttpError) return send(res, e.status, e.message);
      return send(res, 500, 'internal error'); // don't echo exception text
    }
  });

  async function api(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
    const route = `${req.method} ${url.pathname}`;
    switch (route) {
      case 'GET /api/config':
        return json(res, { pick: !!opts.pick, version: version() });
      case 'POST /api/ping':
        return json(res, { ok: true });
      case 'POST /api/choose': {
        if (!opts.pick || done) throw new HttpError(404, 'not in pick mode');
        const body = await readJsonBody(req);
        const scan = await getScan();
        const p = scan.projects.find((x) => x.id === body.id);
        if (!p || !p.exists) throw new HttpError(404, 'unknown project');
        let s: Project['sessions'][number] | undefined;
        if (body.sessionId !== undefined) {
          s = p.sessions.find((x) => x.id === body.sessionId);
          if (!s || s.archived || !validSessionId(s.id)) throw new HttpError(400, 'bad session');
        }
        if (!resumeCommand(p.path, s?.tool, s?.id)) throw new HttpError(400, 'unsafe path');
        done = true;
        json(res, { ok: true });
        resolveChoice({ project: p, sessionId: s?.id, tool: s?.tool });
        return;
      }
      case 'POST /api/close': {
        // Explicit cancel from the UI's Close button.
        if (!opts.pick || done) throw new HttpError(404, 'not in pick mode');
        done = true;
        json(res, { ok: true });
        resolveChoice(undefined);
        return;
      }
      case 'GET /api/projects': {
        const scan = await getScan(url.searchParams.has('refresh'));
        return json(res, { scannedAt: scan.scannedAt, durationMs: scan.durationMs, errors: scan.errors, projects: scan.projects.map(summary) });
      }
      case 'GET /api/stats': {
        const scan = await getScan();
        const days = Math.min(3650, Math.max(0, Math.floor(Number(url.searchParams.get('days')) || 0))) || undefined;
        return json(res, computeStats(scan.projects, { days }));
      }
      case 'GET /api/search': {
        const scan = await getScan();
        const q = (url.searchParams.get('q') ?? '').slice(0, 200);
        return json(res, { q, results: search(scan.projects, scan.corpus, q).slice(0, 100) });
      }
      case 'GET /api/file': {
        const scan = await getScan();
        const text = readProjectFile(scan.projects, url.searchParams.get('path') ?? '');
        if (text === undefined) throw new HttpError(404, 'not allowed');
        return send(res, 200, text, 'text/plain; charset=utf-8');
      }
      case 'POST /api/open': {
        const body = await readJsonBody(req);
        const scan = await getScan();
        const p = scan.projects.find((x) => x.id === body.id);
        if (!p || !p.exists) throw new HttpError(404, 'unknown project');
        if (!['folder', 'terminal', 'vscode'].includes(body.app)) throw new HttpError(400, 'bad app');
        if (isBundle(p.path)) throw new HttpError(400, 'refusing to open an application bundle');
        openWith(body.app, p.path);
        return json(res, { ok: true });
      }
    }
    const m = /^GET \/api\/projects\/([A-Za-z0-9_-]{1,120})$/.exec(route);
    if (m) {
      const scan = await getScan();
      const p = scan.projects.find((x) => x.id === m[1]);
      if (!p) throw new HttpError(404, 'not found');
      return json(res, detail(p));
    }
    throw new HttpError(404, 'not found');
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, HOST, resolve);
  }).catch((e: any) => {
    if (e?.code === 'EADDRINUSE') {
      process.stderr.write(`port ${opts.port} busy — is airecall ui already running? try --port ${opts.port + 1}\n`);
      process.exit(1);
    }
    throw e;
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;

  const port = (server.address() as { port: number }).port;
  origin = `http://${HOST}:${port}`;
  // token travels in the fragment: never sent over the wire, never in server logs
  const url = `${origin}/#k=${token}`;
  process.stderr.write(
    opts.pick
      ? `airecall pick → choose a project in the browser (Ctrl+C to cancel)\n   if it didn't open: ${url}\n`
      : `airecall ui → ${url}\n   local only · this link contains a one-time key · Ctrl+C to stop\n`,
  );
  void getScan().catch(() => {}); // warm cache; errors surface on first request
  if (opts.open) openWith('browser', url);
  if (!opts.pick) return new Promise(() => {}); // run until killed

  // Pick mode: wait for a choice, an explicit Close, or the tab going away.
  // No idle/no-connect timeout. The tab pings every 3 s, but browsers throttle
  // timers in background tabs (Chrome: about once a minute after 5 min hidden),
  // so the grace period must comfortably exceed that or a still-open tab gets
  // closed under the user.
  const TAB_GONE_MS = 150_000;
  const watchdog = setInterval(() => {
    if (lastPing && Date.now() - lastPing > TAB_GONE_MS) resolveChoice(undefined);
  }, 5_000);
  const choice = await chosen;
  clearInterval(watchdog);
  // let the browser receive its response, then stop listening
  await new Promise((r) => setTimeout(r, 150));
  server.closeAllConnections?.();
  server.close();
  return choice;
}

const BUNDLE_EXT = new Set(['.app', '.prefpane', '.saver', '.workflow', '.bundle', '.pkg', '.mpkg', '.xpc', '.appex', '.kext', '.plugin', '.action', '.qlgenerator', '.mdimporter']);

/** macOS opens bundle directories by LAUNCHING them; refuse anything that looks like one. */
function isBundle(p: string): boolean {
  if (BUNDLE_EXT.has(path.extname(p).toLowerCase())) return true;
  try {
    return fs.existsSync(path.join(p, 'Contents', 'Info.plist'));
  } catch {
    return false;
  }
}

function openWith(app: string, target: string): void {
  const mac = process.platform === 'darwin';
  const win = process.platform === 'win32';
  const quiet = () => {};
  switch (app) {
    case 'browser':
      if (mac) execFile('open', [target], quiet);
      // verified on Windows: opens the default browser and keeps the #k= fragment
      else if (win) spawn('rundll32', ['url.dll,FileProtocolHandler', target], { detached: true, stdio: 'ignore' }).on('error', quiet).unref();
      else execFile('xdg-open', [target], quiet);
      return;
    case 'vscode':
      // `code` CLI is optional; fall back to the app bundle on macOS
      execFile('code', [target], (err) => {
        if (err && mac) execFile('open', ['-a', 'Visual Studio Code', target], quiet);
      });
      return;
    case 'terminal':
      if (mac) execFile('open', ['-a', 'Terminal', target], quiet);
      // no path inside a cmd.exe command line (cmd re-parses %VAR%, ^, & …): use cwd instead
      else if (win) {
        // prefer Windows Terminal (`wt -d <dir>` — argv, no shell); fall back to a new PowerShell window started in cwd
        const ps = () =>
          spawn('cmd', ['/c', 'start', '""', 'powershell', '-NoExit'], { cwd: target, detached: true, stdio: 'ignore', windowsVerbatimArguments: true })
            .on('error', quiet)
            .unref();
        const wt = spawn('wt', ['-d', target], { detached: true, stdio: 'ignore' });
        wt.on('error', ps); // wt.exe not installed
        wt.unref();
      }
      else spawn('x-terminal-emulator', [], { cwd: target, detached: true, stdio: 'ignore' }).on('error', quiet).unref();
      return;
    case 'folder':
      if (mac) execFile('open', ['-R', target], quiet); // reveal in Finder, never launch
      else if (win) execFile('explorer', [target], quiet);
      else execFile('xdg-open', [target], quiet);
      return;
  }
}

async function readJsonBody(req: http.IncomingMessage): Promise<any> {
  const len = Number(req.headers['content-length'] ?? 0);
  if (len > MAX_BODY) throw new HttpError(413, 'too large');
  const raw = await new Promise<string>((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => {
      data += c;
      if (data.length > MAX_BODY) {
        reject(new HttpError(413, 'too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
    req.on('close', () => reject(new HttpError(400, 'aborted')));
  });
  try {
    const v = JSON.parse(raw || '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    throw new HttpError(400, 'bad json');
  }
}

function json(res: http.ServerResponse, body: unknown): void {
  send(res, 200, JSON.stringify(body), 'application/json; charset=utf-8');
}

function send(res: http.ServerResponse, status: number, body: string | Buffer, type = 'text/plain; charset=utf-8'): void {
  if (res.headersSent) return;
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    'content-security-policy':
      "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'",
  });
  res.end(body);
}

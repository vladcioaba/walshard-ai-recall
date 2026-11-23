// Regression tests for the adversarial review findings. Fake $HOME, never touches the real one.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'airecall-sec-')));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.AIRECALL_DATA = path.join(home, '.airecall');

const enc = (p: string) => p.replace(/[^a-zA-Z0-9]/g, '-');
const w = (rel: string, body: string) => {
  const f = path.join(home, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, body);
};
const jsonl = (rows: object[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const T = new Date('2026-11-01T10:00:00Z').toISOString();

const a = path.join(home, 'Work', 'my-app');
const b = path.join(home, 'Work', 'my_app');
const evil = path.join(home, 'Work', 'Evil.app');
for (const d of [a, b, path.join(evil, 'Contents')]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(evil, 'Contents', 'Info.plist'), '<plist/>');
fs.writeFileSync(path.join(home, 'secret.txt'), 'TOP-SECRET-CONTENT');
fs.symlinkSync(path.join(home, 'secret.txt'), path.join(a, 'CLAUDE.md')); // repo ships a symlink
fs.writeFileSync(path.join(b, '.mcp.json'), JSON.stringify({ mcpServers: { gh: { env: { GITHUB_TOKEN: 'gh' + 'p_' + 'abcdefghijklmnopqrstuvwxyz0123' } } } }));

w(`.claude/projects/${enc(a)}/11111111-1111-1111-1111-111111111111.jsonl`, jsonl([
  { type: 'user', cwd: a, timestamp: T, message: { content: 'deploy with ' + 'sk_' + 'live_' + 'ABCDEFGHIJKLMNOPQRSTUV' + ' and postgres://admin:S3cretPassw0rd@db/x' } },
  { type: 'ai-title', aiTitle: 'Title with ' + 'gh' + 'p_' + 'abcdefghijklmnopqrstuvwxyz0123' + ' \u001b]52;c;cHduZWQ=\u0007 and \u001b[2K' },
  { type: 'assistant', cwd: a, timestamp: T, message: { id: 'm1', model: '__proto__', usage: { input_tokens: 5, output_tokens: 5 } } },
]));
w(`.claude/projects/${enc(b)}/22222222-2222-2222-2222-222222222222.jsonl`, jsonl([
  { type: 'user', cwd: b, timestamp: T, message: { content: 'bravo prompt' } },
  { type: 'user', cwd: { a: 1 }, timestamp: T, message: { content: 'malformed cwd object' } },
]));
// flag-injection session id + malformed record + relative path
w(`.claude/projects/x/--dangerously-skip-permissions.jsonl`, jsonl([{ type: 'user', cwd: a, timestamp: T, message: { content: 'x' } }]));
w('.claude/history.jsonl', jsonl([
  { display: 'alpha prompt', project: a, timestamp: Date.parse(T) },
  { display: 'numeric project', project: 123, timestamp: Date.parse(T) },
  { display: 'relative', project: 'relative/dir', timestamp: Date.parse(T) },
  { display: 'open the bundle', project: evil, timestamp: Date.parse(T) },
]));
// memory symlink
fs.mkdirSync(path.join(home, `.claude/projects/${enc(a)}/memory`), { recursive: true });
fs.symlinkSync(path.join(home, 'secret.txt'), path.join(home, `.claude/projects/${enc(a)}/memory/leak.md`));
w(`.claude/projects/${enc(a)}/memory/ok.md`, '---\ndescription: uses "token: abcd1234efgh"\ntype: project\n---\nbody');

const { scanAll, readProjectFile } = await import('../src/scan.ts');
const { search } = await import('../src/search.ts');
const { redact } = await import('../src/util.ts');
const { resumeCommand, handoff, validSessionId } = await import('../src/resume.ts');

test('malformed records never crash the scan', async () => {
  const r = await scanAll();
  assert.ok(r.projects.find((p) => p.path === a), 'good project survives');
  assert.ok(!r.projects.some((p) => p.path.endsWith('relative/dir')), 'relative paths dropped');
});

test('no prototype pollution from model names', async () => {
  await scanAll();
  assert.equal(({} as any).input, undefined);
  assert.equal(({} as any).output, undefined);
});

test('similar paths get distinct ids and separate search corpora', async () => {
  const { projects, corpus } = await scanAll();
  const pa = projects.find((p) => p.path === a)!;
  const pb = projects.find((p) => p.path === b)!;
  assert.notEqual(pa.id, pb.id);
  assert.equal(search(projects, corpus, 'alpha')[0]?.path, a);
  assert.equal(search(projects, corpus, 'bravo')[0]?.path, b);
  assert.equal(search(projects, corpus, 'bravo').length, 1);
});

test('secrets and control chars are removed from titles, prompts, descriptions', async () => {
  const { projects } = await scanAll();
  const pa = projects.find((p) => p.path === a)!;
  const s = pa.sessions.find((x) => x.tool === 'claude')!;
  assert.doesNotMatch(s.title!, /ghp_|\u001b|\u0007/);
  assert.doesNotMatch(s.firstPrompt!, /sk_live_|S3cretPassw0rd/);
  assert.doesNotMatch(pa.memory.find((m) => m.name === 'ok.md')!.description!, /abcd1234efgh/);
  for (const secret of ['AIza' + 'A'.repeat(35), '-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----', 'Authorization: Bearer abcdefghijklmnopqrstu', '"password": "hunter22"', 'ASIA' + 'B'.repeat(16)])
    assert.match(redact(secret), /‹redacted›/, secret);
});

test('symlinked CLAUDE.md / memory files are never listed or served', async () => {
  const { projects } = await scanAll();
  const pa = projects.find((p) => p.path === a)!;
  assert.ok(!pa.instructions.some((i) => i.name === 'CLAUDE.md'));
  assert.ok(!pa.memory.some((m) => m.name === 'leak.md'));
  assert.equal(readProjectFile(projects, path.join(a, 'CLAUDE.md')), undefined);
  const mcp = readProjectFile(projects, path.join(b, '.mcp.json'))!;
  assert.doesNotMatch(mcp, /ghp_/);
  assert.match(mcp, /‹hidden›/);
});

test('session ids that look like flags are rejected everywhere', async () => {
  const { projects } = await scanAll();
  assert.ok(!projects.some((p) => p.sessions.some((s) => s.id.startsWith('-'))));
  assert.equal(validSessionId('--dangerously-skip-permissions'), false);
  assert.equal(validSessionId('a;touch x'), false);
  assert.equal(resumeCommand(a, 'claude', '--x'), undefined);
  assert.equal(handoff(a, 'codex', '-y'), undefined);
  assert.equal(resumeCommand('relative', 'claude'), undefined);
  assert.equal(resumeCommand(`${a}\n`, 'claude'), undefined);
  assert.equal(resumeCommand(`/tmp/it's`, 'claude', 'abc-123'), `cd '/tmp/it'\\''s' && claude --resume abc-123`);
});

test('index: no prompt text stored, planted symlinks not followed, private perms', async () => {
  const dir = process.env.AIRECALL_DATA!;
  await scanAll();
  const file = path.join(dir, 'sessions.json');
  const raw = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(raw, /firstPrompt|alpha prompt|ghp_/);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  // plant a symlink as sessions.json → must be replaced, victim untouched
  const victim = path.join(home, 'victim.txt');
  fs.writeFileSync(victim, 'ORIGINAL');
  fs.rmSync(file);
  fs.symlinkSync(victim, file);
  await scanAll();
  assert.equal(fs.readFileSync(victim, 'utf8'), 'ORIGINAL');
  assert.ok(!fs.lstatSync(file).isSymbolicLink());
});

test('HTTP: token, host, cross-site and bundle guards', async () => {
  const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'airecall.js');
  const child = spawn(process.execPath, [bin, 'ui', '--no-open', '--port', '0'], { env: { ...process.env }, stdio: ['ignore', 'ignore', 'pipe'] });
  try {
    const url = await new Promise<string>((resolve, reject) => {
      let err = '';
      child.stderr.on('data', (d) => {
        err += d;
        const m = /(http:\/\/127\.0\.0\.1:\d+)\/#k=([\w-]+)/.exec(err);
        if (m) resolve(`${m[1]} ${m[2]}`);
      });
      child.on('exit', () => reject(new Error('server exited: ' + err)));
      setTimeout(() => reject(new Error('timeout: ' + err)), 15000);
    });
    const [origin, token] = url.split(' ');
    const get = (p: string, h: Record<string, string> = {}) => fetch(origin + p, { headers: h });
    assert.equal((await get('/api/projects')).status, 401, 'no token');
    assert.equal((await get('/api/projects', { 'x-airecall-token': 'nope'.padEnd(token.length, 'x') })).status, 401, 'bad token');
    assert.equal((await get('/api/projects', { 'x-airecall-token': token, 'sec-fetch-site': 'cross-site' })).status, 403, 'cross-site');
    const cfg = (await (await get('/api/config', { 'x-airecall-token': token })).json()) as any;
    const pkgVersion = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
    assert.equal(cfg.version, pkgVersion, 'web shows the packaged version');
    const ok = await get('/api/projects', { 'x-airecall-token': token });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('x-frame-options'), 'DENY');
    assert.match(ok.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
    const { projects } = (await ok.json()) as any;
    const evilP = projects.find((p: any) => p.path === evil);
    assert.ok(evilP, 'bundle project listed');
    const post = (body: object, h: Record<string, string> = {}) =>
      fetch(origin + '/api/open', { method: 'POST', headers: { 'x-airecall-token': token, origin, 'content-type': 'application/json', ...h }, body: JSON.stringify(body) });
    assert.equal((await post({ id: evilP.id, app: 'folder' })).status, 400, 'refuses .app bundle');
    assert.equal((await post({ id: evilP.id, app: 'folder' }, { origin: 'http://localhost:1' })).status, 403, 'bad origin');
    assert.equal((await post({ id: evilP.id, app: 'folder' }, { 'content-type': 'text/plain' })).status, 415, 'json only');
    assert.equal((await post({ id: evilP.id, app: 'calc' })).status, 400, 'unknown app');
  } finally {
    child.kill();
  }
});

test.after(() => fs.rmSync(home, { recursive: true, force: true }));

test('Windows: drive/UNC paths accepted, PowerShell-quoted resume commands', () => {
  const W = 'win32' as NodeJS.Platform;
  assert.equal(validSessionId('abc-123'), true);
  assert.equal(resumeCommand('C:\\Users\\me\\my app', 'claude', 'abc-123', W), "Set-Location -LiteralPath 'C:\\Users\\me\\my app'; claude --resume abc-123");
  assert.equal(resumeCommand("C:\\it's", 'codex', undefined, W), "Set-Location -LiteralPath 'C:\\it''s'; codex resume");
  assert.equal(resumeCommand('C:\\a\u2019b', 'claude', undefined, W), "Set-Location -LiteralPath 'C:\\a\u2019\u2019b'; claude --resume");
  assert.ok(resumeCommand('\\\\server\\share\\proj', 'claude', undefined, W));
  assert.equal(resumeCommand('relative\\dir', 'claude', undefined, W), undefined);
  assert.equal(resumeCommand('\\no-drive', 'claude', undefined, W), undefined);
  assert.equal(resumeCommand('C:\\x', 'claude', '--flag', W), undefined);
  assert.equal(handoff('C:\\Users\\me\\p', 'copilot-cli', 'id-1', W), 'C:\\Users\\me\\p\tcopilot-cli\tid-1');
  assert.equal(resumeCommand('C:\\x', 'claude', undefined, 'darwin'), undefined, 'win path not valid on posix');
});

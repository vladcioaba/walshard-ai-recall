// Smoke test: build a fake $HOME with Claude / Copilot CLI / Codex data, scan it, assert merged output.
// HOME must be set before importing the scanner (util.ts reads os.homedir() at load).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'airecall-test-'))); // scanner canonicalizes /var -> /private/var
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.AIRECALL_DATA = path.join(home, '.airecall');

const proj = path.join(home, 'Work', 'my_app'); // underscore: Claude's encoding is lossy
const gone = path.join(home, 'Work', 'old-thing');
fs.mkdirSync(path.join(proj, '.claude'), { recursive: true });
fs.mkdirSync(path.join(proj, '.git'), { recursive: true });
fs.writeFileSync(path.join(proj, 'CLAUDE.md'), '# My app\n');
fs.writeFileSync(path.join(proj, 'AGENTS.md'), 'codex rules');
fs.writeFileSync(path.join(proj, '.git', 'HEAD'), 'ref: refs/heads/feature/x\n');
fs.writeFileSync(path.join(proj, '.git', 'config'), '[remote "origin"]\n\turl = https://user:tok@github.com/acme/my_app.git\n');

const enc = (p: string) => p.replace(/[^a-zA-Z0-9]/g, '-');
const w = (rel: string, body: string) => {
  const f = path.join(home, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, body);
};
const jsonl = (rows: object[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const T0 = Date.parse('2026-11-01T10:00:00Z');

// --- Claude transcript
w(
  `.claude/projects/${enc(proj)}/s1.jsonl`,
  jsonl([
    { type: 'user', cwd: proj, gitBranch: 'feature/x', timestamp: new Date(T0).toISOString(), message: { role: 'user', content: 'Build the login page with ' + 'sk-' + 'ant-' + 'abcdefghijklmnopqrstuv' } },
    { type: 'assistant', cwd: proj, timestamp: new Date(T0 + 60e3).toISOString(), message: { id: 'm1', model: 'claude-opus-5-5', content: [{ type: 'tool_use', name: 'Edit' }], usage: { input_tokens: 100, output_tokens: 50 } } },
    { type: 'assistant', cwd: proj, timestamp: new Date(T0 + 61e3).toISOString(), message: { id: 'm1', model: 'claude-opus-5-5', content: [{ type: 'tool_use', name: 'Bash' }], usage: { input_tokens: 100, output_tokens: 50 } } },
    { type: 'user', cwd: proj, timestamp: new Date(T0 + 62e3).toISOString(), message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } },
    { type: 'ai-title', aiTitle: 'Login page' },
    { type: 'cost-state', totalCostUSD: 0.42, totalLinesAdded: 10, totalLinesRemoved: 2 },
    'not json' as unknown as object,
  ]).replace('"not json"', '{broken'),
);
// --- Claude memory + history + registry
w(`.claude/projects/${enc(proj)}/memory/MEMORY.md`, '- [Auth](auth.md)\n');
w(`.claude/projects/${enc(proj)}/memory/auth.md`, '---\nname: auth\ndescription: Uses \\"magic links\\" for auth\nmetadata:\n  type: project\n---\nBody text about passkeys.\n');
w(`.claude/projects/${enc(gone)}/memory/note.md`, '---\ndescription: orphan memory\ntype: feedback\n---\nx');
w('.claude/history.jsonl', jsonl([
  { display: 'first prompt', project: proj, timestamp: T0 - 864e5 },
  { display: 'add rate limiting to the api', project: proj, timestamp: T0 + 120e3 },
  { display: 'cleanup', project: gone, timestamp: T0 - 30 * 864e5 },
]));
w('.claude.json', JSON.stringify({ projects: { [proj]: { mcpServers: { github: {} }, allowedTools: ['Bash(ls)'], lastCost: 1.5 }, [gone]: {} } }));

// --- Copilot CLI
w('.copilot/session-state/c1/workspace.yaml', `id: c1\ncwd: ${proj}\ngit_root: ${proj}\nbranch: main\nsummary: Fix flaky tests\ncreated_at: 2026-10-01T10:00:00Z\nupdated_at: 2026-10-01T11:00:00Z\n`);
w('.copilot/session-state/c1/events.jsonl', jsonl([
  { type: 'user.message', timestamp: '2026-10-01T10:00:00Z', data: { content: 'fix the flaky tests' } },
  { type: 'tool.execution_start', timestamp: '2026-10-01T10:01:00Z', data: { toolName: 'bash' } },
  { type: 'assistant.message', timestamp: '2026-10-01T10:02:00Z', data: { outputTokens: 33 } },
]));
w('.copilot/session-state/c1/plan.md', '# Plan\n- step one\n');

// --- Codex
w('.codex/sessions/2026/11/02/rollout-1.jsonl', jsonl([
  { type: 'session_meta', timestamp: '2026-11-02T09:00:00Z', payload: { id: 'cx1', cwd: proj, git: { branch: 'main' } } },
  { type: 'response_item', timestamp: '2026-11-02T09:00:05Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'refactor the router' }] } },
  { type: 'response_item', timestamp: '2026-11-02T09:00:10Z', payload: { type: 'function_call', name: 'shell' } },
]));

const { scanAll } = await import('../src/scan.ts');
const { search } = await import('../src/search.ts');

test('merges all tools into one project with the real (non-lossy) path', async () => {
  const { projects, errors } = await scanAll();
  assert.deepEqual(errors, []);
  const p = projects.find((x) => x.path === proj);
  assert.ok(p, 'project found by real path');
  assert.deepEqual([...p.tools].sort(), ['claude', 'codex', 'copilot-cli']);
  assert.equal(p.exists, true);
  assert.equal(p.git?.branch, 'feature/x');
  assert.equal(p.git?.remote, 'https://github.com/acme/my_app.git', 'credentials stripped from remote');
  assert.deepEqual(p.claudeConfig?.mcpServers, ['github']);
  assert.ok(p.instructions.some((i) => i.name === 'CLAUDE.md'));
  assert.ok(p.instructions.some((i) => i.name === 'AGENTS.md'));
});

test('claude session: title, dedup usage per message id, tool counts, cost, redaction', async () => {
  const { projects } = await scanAll();
  const s = projects.find((x) => x.path === proj)!.sessions.find((x) => x.tool === 'claude')!;
  assert.equal(s.title, 'Login page');
  assert.equal(s.userMessages, 1, 'tool_result is not a user prompt');
  assert.equal(s.assistantMessages, 1, 'split records count once');
  assert.equal(s.tokens?.output, 50, 'usage counted once per message id');
  assert.equal(s.toolCalls, 2);
  assert.equal(s.costUSD, 0.42);
  assert.equal(s.branch, 'feature/x');
  assert.match(s.firstPrompt!, /‹redacted›/);
  assert.doesNotMatch(s.firstPrompt!, /sk-ant-/);
});

test('memory: frontmatter parsed, index first, orphan resolved and flagged missing', async () => {
  const { projects } = await scanAll();
  const p = projects.find((x) => x.path === proj)!;
  assert.equal(p.memory[0].name, 'MEMORY.md');
  const auth = p.memory.find((m) => m.name === 'auth.md')!;
  assert.equal(auth.type, 'project', 'nested metadata.type');
  assert.equal(auth.description, 'Uses "magic links" for auth');
  const orphan = projects.find((x) => x.path === gone)!;
  assert.equal(orphan.exists, false);
  assert.equal(orphan.memory.length, 1);
});

test('copilot + codex sessions, plans, prompts newest first', async () => {
  const { projects } = await scanAll();
  const p = projects.find((x) => x.path === proj)!;
  const gh = p.sessions.find((s) => s.tool === 'copilot-cli')!;
  assert.equal(gh.title, 'Fix flaky tests');
  assert.equal(gh.toolCalls, 1);
  assert.equal(p.plans.length, 1);
  const cx = p.sessions.find((s) => s.tool === 'codex')!;
  assert.equal(cx.id, 'cx1');
  assert.equal(cx.firstPrompt, 'refactor the router');
  assert.equal(p.prompts[0].text, 'add rate limiting to the api');
  assert.equal(p.promptCount, 2);
});

test('search ranks and finds memory body + prompts', async () => {
  const { projects, corpus } = await scanAll();
  assert.equal(search(projects, corpus, 'passkeys')[0]?.path, proj);
  assert.equal(search(projects, corpus, 'rate limiting')[0]?.hits[0].kind, 'prompt');
  assert.deepEqual(search(projects, corpus, 'nonexistentword'), []);
});

test('index keeps sessions after the transcript is deleted', async () => {
  await scanAll(); // populate index
  fs.rmSync(path.join(home, `.claude/projects/${enc(proj)}/s1.jsonl`));
  const { projects } = await scanAll();
  const s = projects.find((x) => x.path === proj)!.sessions.find((x) => x.tool === 'claude');
  assert.ok(s, 'session still listed');
  assert.equal(s.archived, true);
  assert.equal(s.title, 'Login page');
});

test.after(() => fs.rmSync(home, { recursive: true, force: true }));

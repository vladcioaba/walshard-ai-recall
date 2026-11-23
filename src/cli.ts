import fs from 'node:fs';
import readline from 'node:readline';
import { scanAll } from './scan.ts';
import { search } from './search.ts';
import { computeStats } from './stats.ts';
import { totalTokens } from './pricing.ts';
import type { Project, Tool } from './types.ts';
import { handoff, resumeCommand } from './resume.ts';
import { forget, purge, STORE_FILE } from './store.ts';
import { clean, oneLine, tildify } from './util.ts';

// colour only when the stream we're writing to is a terminal (set per command in main)
let useColor = !!process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = c('2'), bold = c('1'), red = c('31'), green = c('32'), yellow = c('33'), cyan = c('36'), magenta = c('35');

const BADGE: Record<Tool, [string, string]> = {
  claude: ['38;5;173', 'CC'],
  'copilot-cli': ['38;5;75', 'GH'],
  'vscode-copilot': ['38;5;39', 'VS'],
  codex: ['38;5;114', 'CX'],
};
const badge = (t: Tool) => c(BADGE[t][0])(BADGE[t][1]);

/**
 * Static shell function. Paste it into your rc file ONCE (`airecall init zsh >> ~/.zshrc`).
 * It never evals program output: `airecall go --handoff` prints `dir<TAB>tool<TAB>id`, and the
 * function cd's to the dir and runs a fixed command chosen by tool, with the id re-validated.
 */
const SHELL_FUNCTION = `# airecall: bare \`airecall\` opens the browser picker, then cd's + resumes the chosen session
airecall() {
  if [ $# -ne 0 ]; then command airecall "$@"; return; fi
  local __out __dir __tool __id __tab
  __tab="$(printf '\\t')"
  __out="$(command airecall go --handoff)" || return
  __dir="\${__out%%"$__tab"*}"; __out="\${__out#*"$__tab"}"
  __tool="\${__out%%"$__tab"*}"; __id="\${__out#*"$__tab"}"
  case "$__dir" in /*) ;; *) echo "airecall: refusing path" >&2; return 1;; esac
  case "$__id" in -*|*[!A-Za-z0-9._-]*) echo "airecall: refusing session id" >&2; return 1;; esac
  case "$__tool" in claude|copilot-cli|codex) ;; *) echo "airecall: unknown tool" >&2; return 1;; esac
  cd -- "$__dir" || return
  case "$__tool" in
    claude) if [ -n "$__id" ]; then claude --resume "$__id"; else claude --resume; fi ;;
    copilot-cli) if [ -n "$__id" ]; then copilot --resume "$__id"; else copilot --resume; fi ;;
    codex) if [ -n "$__id" ]; then codex resume "$__id"; else codex resume; fi ;;
    *) echo "airecall: unknown tool" >&2; return 1 ;;
  esac
}
`;

const HELP = `${bold('Walshard AI Recall')} (airecall) — find and resume AI agent projects (Claude Code, Copilot CLI, VS Code Copilot, Codex)

${bold('Usage')}
  airecall                          open the picker in the browser; on choice the server
                                 stops and your terminal cd's + resumes (needs init)
  airecall list [filter] [--json]   list all projects, newest first
  airecall show <filter|#>          details for one project in the terminal
  airecall stats [filter] [--days N] [--json]   tokens + cost by tool, model, project, day
  airecall search <words…>          full-text: paths, session titles, memory, plans, all prompts
  airecall pick [filter]            choose a project interactively; prints its path
  airecall ui [--port 4545] [--no-open]   open the local web dashboard
  airecall go [--path]              pick in the browser; server stops on choice;
                                 prints a resume command (or just the path)
  airecall forget <filter|session-id>   delete matching sessions from airecall's index
  airecall purge                    delete airecall's whole index (${tildify(STORE_FILE)})
  airecall help

${bold('Setup')} (once — writes a static function, nothing is eval'd at shell startup):
  airecall init zsh >> ~/.zshrc      ${dim('# or ~/.bashrc')}

${bold('Terminal-only picker')}:
  cr() { local p; p="$(airecall pick "$@")" || return; cd "$p" && claude --resume; }
`;

async function main(argv: string[]): Promise<void> {
  const [cmd = 'go', ...rest] = argv;
  const flags = new Set(rest.filter((a) => a.startsWith('--')));
  const args = rest.filter((a, i) => !a.startsWith('--') && rest[i - 1] !== '--port' && rest[i - 1] !== '--days');
  const filter = args.join(' ').toLowerCase();
  // interactive pickers draw on stderr; everything else on stdout
  if (cmd === 'pick' || cmd === 'go') useColor = !!process.stderr.isTTY && !process.env.NO_COLOR;

  switch (cmd) {
    case 'list':
    case 'ls': {
      const projects = await load(filter);
      if (flags.has('--json')) return void process.stdout.write(JSON.stringify(projects, null, 2) + '\n');
      printList(projects, process.stdout);
      return;
    }
    case 'search':
    case 's': {
      if (!filter) return fail('usage: airecall search <words…>');
      const scan = await scanAll();
      const results = search(scan.projects, scan.corpus, filter);
      if (flags.has('--json')) return void process.stdout.write(JSON.stringify(results, null, 2) + '\n');
      if (!results.length) return fail(`nothing matches "${filter}"`);
      const terms = filter.split(/\s+/);
      const hl = (t: string) => terms.reduce((acc, w) => acc.replace(new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), (m) => yellow(m)), t);
      for (const r of results.slice(0, 15)) {
        process.stdout.write(`${bold(r.name)}  ${dim(tildify(r.path))}\n`);
        for (const h of r.hits) process.stdout.write(`   ${magenta(h.kind.padEnd(8))} ${hl(oneLine(h.snippet, 140))}\n`);
      }
      process.stdout.write(dim(`\n${results.length} project${results.length === 1 ? "" : "s"} match\n`));
      return;
    }
    case 'stats':
    case 'statistics':
    case 'cost':
    case 'costs': {
      const i = rest.indexOf('--days');
      const days = i >= 0 ? Math.floor(Number(rest[i + 1])) || undefined : undefined;
      if (i >= 0 && (!days || days < 1 || days > 3650)) return fail('--days must be 1..3650');
      const q = filter;
      const projects = await load(q);
      const st = computeStats(projects, { days });
      if (flags.has('--json')) return void process.stdout.write(JSON.stringify(st, null, 2) + '\n');
      printStats(st, q);
      return;
    }
    case 'show': {
      const projects = await load('');
      const p = resolveOne(projects, filter);
      if (!p) return fail(`no project matches "${filter}"`);
      printDetail(p);
      return;
    }
    case 'pick': {
      const projects = await load(filter);
      if (!projects.length) return fail('no projects found');
      if (projects.length === 1 && resumeCommand(projects[0].path)) return void process.stdout.write(projects[0].path + '\n');
      printList(projects, process.stderr);
      const ans = await ask('pick #: ');
      const p = projects[Number(ans) - 1];
      if (!p) return fail('cancelled');
      if (!resumeCommand(p.path)) return fail('refusing unsafe path');
      process.stdout.write(p.path + '\n');
      return;
    }
    case 'ui':
    case 'serve':
    case 'go': {
      const pickMode = cmd === 'go' || flags.has('--pick');
      const i = rest.indexOf('--port');
      // pick mode uses a random free port so it never clashes with a long-running `airecall ui`
      const port = i >= 0 ? Number(rest[i + 1]) : pickMode ? 0 : Number(process.env.AIRECALL_PORT ?? 4545);
      if (!Number.isInteger(port) || port < 0 || port > 65535) return fail('--port must be 0..65535');
      const { startServer } = await import('./server.ts');
      const choice = await startServer({ port, open: !flags.has('--no-open'), pick: pickMode });
      if (!pickMode) return;
      if (!choice) {
        fail('no project chosen (tab closed or timed out)');
        process.exit(1);
      }
      const { project, tool, sessionId } = choice;
      const out = flags.has('--handoff')
        ? handoff(project.path, tool, sessionId)
        : flags.has('--path')
          ? (resumeCommand(project.path) && project.path)
          : resumeCommand(project.path, tool, sessionId);
      if (!out) {
        fail('refusing unsafe path or session id');
        process.exit(1);
      }
      process.stdout.write(out + '\n');
      if (process.stdout.isTTY && !flags.has('--handoff'))
        process.stderr.write(dim('tip: `airecall init zsh >> ~/.zshrc` once, and bare `airecall` will cd + resume for you\n'));
      process.exit(0);
    }
    case 'init':
      process.stdout.write(SHELL_FUNCTION);
      return;
    case 'forget': {
      if (!args.length) return fail('usage: airecall forget <project filter | session id>');
      const q = args.join(' ');
      const n = forget((e) => e.id === q || e.path.toLowerCase().includes(q.toLowerCase()));
      process.stdout.write(`${n} session${n === 1 ? '' : 's'} removed from ${tildify(STORE_FILE)}\n`);
      return;
    }
    case 'purge':
      process.stdout.write(purge() ? `deleted ${tildify(STORE_FILE)}\n` : 'nothing to delete\n');
      return;
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(HELP);
      return;
    default:
      // `airecall foo` == `airecall list foo`
      return main(['list', cmd, ...rest]);
  }
}

async function load(filter: string): Promise<Project[]> {
  const { projects, errors, corpus } = await scanAll();
  for (const e of errors) process.stderr.write(yellow(`warn: ${e}\n`));
  if (!filter) return projects;
  // rank by search score: path/title matches beat memory/prompt mentions
  const byId = new Map(projects.map((p) => [p.id, p]));
  return search(projects, corpus, filter).map((r) => byId.get(r.id)!);
}

function searchText(p: Project): string {
  return [p.path, ...p.sessions.map((s) => `${s.title ?? ''} ${s.firstPrompt ?? ''}`), ...p.memory.map((m) => m.description ?? '')]
    .join(' ')
    .toLowerCase();
}

function resolveOne(projects: Project[], q: string): Project | undefined {
  if (/^\d+$/.test(q)) return projects[Number(q) - 1];
  return (
    projects.find((p) => p.name.toLowerCase() === q) ??
    projects.find((p) => p.path.toLowerCase().includes(q)) ??
    projects.find((p) => searchText(p).includes(q))
  );
}

export function headline(p: Project): string {
  const s = p.sessions.find((x) => x.title && x.title !== '(running now)');
  if (s?.title) return s.title;
  const mem = p.memory.find((m) => m.type === 'project' && m.description);
  if (mem?.description) return mem.description;
  const prompt = p.prompts.find((x) => !/^[/!]/.test(x.text) && x.text.trim().split(/\s+/).length >= 4);
  if (prompt) return '> ' + prompt.text;
  return p.memory.find((m) => m.description)?.description ?? '';
}

function printList(projects: Project[], out: NodeJS.WriteStream): void {
  const width = out.columns ?? 120;
  const nameW = Math.min(36, Math.max(...projects.map((p) => tildify(p.path).length), 10));
  out.write(dim(`  #  ${'last'.padEnd(10)}  ${'tools'.padEnd(11)} ${'project'.padEnd(nameW)}  mem  summary\n`));
  projects.forEach((p, i) => {
    const running = p.sessions.some((s) => s.running);
    const mark = !p.exists ? red('✗') : running ? green('●') : ' ';
    const when = p.lastActive ? relDate(p.lastActive) : dim('—'.padEnd(10));
    const tools = (['claude', 'copilot-cli', 'vscode-copilot', 'codex'] as Tool[])
      .map((t) => (p.tools.includes(t) ? badge(t) : dim('··')))
      .join(' ');
    let name = tildify(p.path);
    if (name.length > nameW) name = '…' + name.slice(-(nameW - 1));
    const mem = p.memory.length ? magenta(String(p.memory.length).padStart(3)) : dim('  ·');
    const used = 2 + 1 + 1 + 10 + 2 + 11 + 1 + nameW + 2 + 3 + 2 + 3;
    const sum = oneLine(headline(p), Math.max(10, width - used));
    out.write(`${String(i + 1).padStart(3)}${mark} ${when}  ${tools} ${bold(name.padEnd(nameW))}  ${mem}  ${dim(sum)}\n`);
  });
  out.write(dim(`\n${projects.length} projects · ● running  ✗ folder missing · CC claude  GH copilot-cli  VS vscode-copilot  CX codex\n`));
}

function printDetail(p: Project): void {
  const w = (s = '') => process.stdout.write(s + '\n');
  const h = (s: string) => w('\n' + cyan(bold(s)));
  w(bold(p.name) + '  ' + dim(tildify(p.path)) + (p.exists ? '' : red('  (folder missing)')));
  w(
    [
      `tools: ${p.tools.join(', ')}`,
      p.git?.branch && `branch: ${p.git.branch}`,
      p.lastActive && `last active: ${new Date(p.lastActive).toLocaleString()}`,
      `sessions: ${p.totals.sessions}`,
      `prompts: ${p.promptCount}`,
      p.totals.costUSD > 0 && `cost: $${p.totals.costUSD.toFixed(2)}`,
    ]
      .filter(Boolean)
      .join(dim('  ·  ')),
  );
  if (p.git?.remote) w(dim(`remote: ${clean(p.git.remote)}`));

  if (p.memory.length) {
    h(`Memory (${p.memory.length})`);
    for (const m of p.memory) w(`  ${magenta((m.type ?? '-').padEnd(9))} ${m.name}${m.description ? dim('  — ' + oneLine(m.description, 90)) : ''}`);
  }
  if (p.todos.length) {
    h('Todos');
    for (const t of p.todos) w(`  ${t.status === 'done' ? green('✓') : t.status === 'in_progress' ? yellow('▶') : '○'} ${oneLine(t.title, 140)}`);
  }
  if (p.instructions.length) {
    h('Agent files in project');
    w('  ' + p.instructions.map((i) => i.name).join(dim('  ·  ')));
  }
  if (p.claudeConfig?.mcpServers.length) w(dim(`  MCP servers: ${p.claudeConfig.mcpServers.join(', ')}`));
  if (p.sessions.length) {
    h(`Sessions (${p.sessions.length})`);
    for (const s of p.sessions.slice(0, 12)) {
      const when = s.end ?? s.start;
      const bits = [
        s.userMessages ? `${s.userMessages} msg` : '',
        s.toolCalls ? `${s.toolCalls} tools` : '',
        s.costUSD ? `$${s.costUSD.toFixed(2)}` : '',
        s.branch ? `⎇ ${s.branch}` : '',
      ].filter(Boolean);
      w(`  ${badge(s.tool)} ${when ? relDate(when) : ''.padEnd(10)} ${s.running ? green('● ') : ''}${s.title ?? dim(s.firstPrompt ?? s.id)}  ${dim(bits.join(' · '))}`);
    }
  }
  if (p.prompts.length) {
    h('Recent prompts');
    for (const x of p.prompts.slice(0, 8)) w(`  ${dim(relDate(x.ts))} ${oneLine(x.text, 100)}`);
  }
}

const money = (n: number) => (n >= 100 ? `$${n.toFixed(0)}` : n >= 1 ? `$${n.toFixed(2)}` : n > 0 ? `$${n.toFixed(3)}` : '$0');
const num = (n: number) => (n >= 1e9 ? (n / 1e9).toFixed(1) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(Math.round(n)));
const bar = (v: number, max: number, width = 20) => {
  const n = max > 0 ? Math.max(v > 0 ? 1 : 0, Math.round((v / max) * width)) : 0;
  return c('38;5;173')('█'.repeat(n)) + ' '.repeat(width - n);
};
const TOOL_NAME: Record<string, string> = { claude: 'Claude Code', 'copilot-cli': 'Copilot CLI', 'vscode-copilot': 'VS Code Copilot', codex: 'Codex' };

function printStats(st: ReturnType<typeof computeStats>, filter: string): void {
  const w = (s = '') => process.stdout.write(s + '\n');
  const h = (s: string) => w('\n' + cyan(bold(s)));
  const t = st.totals;
  const scope = (st.window.days ? `last ${st.window.days} days` : 'all time') + (filter ? ` · projects matching "${filter}"` : '');
  w(bold(`Usage & cost — ${scope}`));
  w(dim(`cost = recorded by the agent when available, else estimated at Anthropic API list prices (${st.pricingAsOf}); subscriptions don't bill per token`));
  w();
  w(`  ${bold(money(t.cost))} ${dim('≈ cost')}   ${bold(num(totalTokens(t.tokens)))} ${dim('tokens')}   ${bold(String(t.sessions))} ${dim('sessions')}${t.premiumRequests ? `   ${bold(String(t.premiumRequests))} ${dim('Copilot premium requests')}` : ''}`);
  w(dim(`  input ${num(t.tokens.input)} · output ${num(t.tokens.output)} · cache read ${num(t.tokens.cacheRead)} · cache write ${num(t.tokens.cacheWrite)}`));
  w(dim(`  recorded ${money(t.recordedCost)} · estimated ${money(t.estimatedOnlyCost)}${t.unpricedTokens ? ` · ${num(t.unpricedTokens)} tokens on unpriced (non-Anthropic) models` : ''}`));

  const tools = Object.entries(st.byTool).sort((a, b) => b[1].cost - a[1].cost || totalTokens(b[1].tokens) - totalTokens(a[1].tokens));
  if (tools.length) {
    h('By tool');
    const max = Math.max(...tools.map(([, b]) => totalTokens(b.tokens)));
    for (const [tool, b] of tools)
      w(`  ${(TOOL_NAME[tool] ?? tool).padEnd(16)} ${bar(totalTokens(b.tokens), max)} ${num(totalTokens(b.tokens)).padStart(7)}  ${money(b.cost).padStart(8)}  ${dim(b.sessions + ' sessions')}`);
  }

  const models = Object.entries(st.byModel).sort((a, b) => b[1].cost - a[1].cost || totalTokens(b[1].tokens) - totalTokens(a[1].tokens));
  if (models.length) {
    h('By model');
    const max = Math.max(...models.map(([, b]) => b.cost || 0));
    for (const [m, b] of models)
      w(`  ${clean(m).padEnd(28)} ${bar(b.cost, max, 16)} ${num(totalTokens(b.tokens)).padStart(7)}  ${(b.priced ? money(b.cost) : 'n/a').padStart(8)}  ${dim(`out ${num(b.tokens.output)} · cache read ${num(b.tokens.cacheRead)}`)}`);
  }

  if (st.byProject.length) {
    h('Top projects');
    const max = Math.max(...st.byProject.map((p) => p.cost));
    for (const p of st.byProject.slice(0, 12))
      w(`  ${tildify(p.path).slice(-34).padEnd(34)} ${bar(p.cost, max, 14)} ${money(p.cost).padStart(8)}  ${num(p.tokens).padStart(7)}  ${dim(p.sessions + ' sess · ' + relDate(p.lastActive).trim())}`);
  }

  if (st.daily.some((d) => d.tokens)) {
    const blocks = '▁▂▃▄▅▆▇█';
    const max = Math.max(...st.daily.map((d) => d.cost));
    const spark = st.daily.map((d) => (d.cost ? blocks[Math.min(7, Math.floor((d.cost / max) * 7.999))] : dim('·'))).join('');
    const sum = st.daily.reduce((n, d) => n + d.cost, 0);
    h(`Daily (est. cost, last ${st.daily.length} days)`);
    w(`  ${st.daily[0].day.slice(5)} ${spark} ${st.daily.at(-1)!.day.slice(5)}   ${money(sum)} total · peak day ${money(max)}`);
    w(dim('  counts only days whose transcripts are still on disk or in the airecall index'));
  }

  const ca = st.claudeAllTime;
  if (ca && !filter && !st.window.days) {
    h(`Claude Code all-time ${dim(`(its own stats-cache.json, as of ${ca.asOf ?? '?'})`)}`);
    const stale = ca.asOf ? (Date.now() - Date.parse(ca.asOf)) / 864e5 : 0;
    w(`  ${bold(money(ca.costUSD || ca.estCostUSD))} ${dim(ca.costUSD ? 'recorded cost' : '≈ API-price equivalent')}   ${bold(String(ca.totalSessions ?? '?'))} ${dim('sessions')}   ${bold(num(ca.totalMessages ?? 0))} ${dim('messages')}   ${dim('since ' + (ca.firstSessionDate?.slice(0, 10) ?? '?'))}`);
    for (const m of ca.models.slice(0, 6)) w(`  ${clean(m.model).padEnd(28)} ${num(m.tokens).padStart(7)}  ${(m.costUSD ? money(m.costUSD) : m.estCostUSD !== undefined ? '≈' + money(m.estCostUSD) : 'n/a').padStart(9)}`);
    if (ca.busiestHours.length) w(dim(`  busiest hours: ${ca.busiestHours.map((x) => `${String(x.hour).padStart(2, '0')}:00`).join(', ')}`));
    if (stale > 7) w(yellow(`  note: Claude stopped updating this file ${Math.round(stale)} days ago — newer usage is only in the sections above`));
  }
}

function relDate(ms: number): string {
  const d = (Date.now() - ms) / 86400000;
  const s = d < 1 / 24 ? 'just now' : d < 1 ? `${Math.round(d * 24)}h ago` : d < 14 ? `${Math.round(d)}d ago` : new Date(ms).toISOString().slice(0, 10);
  return s.padEnd(10);
}

function ask(q: string): Promise<string> {
  return new Promise((resolve) => {
    let input: fs.ReadStream;
    try {
      input = fs.createReadStream('', { fd: fs.openSync('/dev/tty', 'r') });
    } catch {
      return resolve('');
    }
    const rl = readline.createInterface({ input, output: process.stderr });
    rl.question(q, (a) => {
      rl.close();
      input.destroy();
      resolve(a.trim());
    });
  });
}

function fail(msg: string): void {
  process.stderr.write(red(msg) + '\n');
  process.exitCode = 1;
}

main(process.argv.slice(2)).catch((e) => {
  process.stderr.write(red(String(e?.stack ?? e)) + '\n');
  process.exit(1);
});

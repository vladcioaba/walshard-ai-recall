// airecall dashboard — vanilla JS, no external requests.
const $ = (s, el = document) => el.querySelector(s);

// Per-run API key from the server, delivered in the URL fragment (#k=…), never sent over the wire.
let TOKEN = '';
try { TOKEN = sessionStorage.getItem('airecall.k') || ''; } catch {}
{
  const km = /(?:^#|&)k=([A-Za-z0-9_-]{20,})/.exec(location.hash);
  if (km) {
    TOKEN = km[1];
    try { sessionStorage.setItem('airecall.k', TOKEN); } catch {}
    history.replaceState(null, '', location.pathname + location.search);
  }
}
async function api(url, init = {}) {
  const headers = { ...(init.headers || {}), 'x-airecall-token': TOKEN };
  if (init.body) headers['content-type'] = 'application/json';
  const r = await fetch(url, { ...init, headers, credentials: 'omit' });
  if (r.status === 401) {
    document.body.innerHTML = '<div class="done"><h2>Link expired</h2><p class="muted">Open the dashboard from the link printed by <code>airecall ui</code> (it carries a one-time key).</p></div>';
    throw new Error('unauthorized');
  }
  return r;
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const TOOL_LABEL = { claude: 'Claude Code', 'copilot-cli': 'Copilot CLI', 'vscode-copilot': 'VS Code Copilot', codex: 'Codex' };
const TOOL_SHORT = { claude: 'Claude', 'copilot-cli': 'Copilot', 'vscode-copilot': 'VS Code', codex: 'Codex' };

const state = {
  projects: [],
  q: '',
  filters: new Set(),
  selected: null,
  detail: null,
  tab: 'overview',
  results: null, // search results from /api/search, or null when not searching
  pick: false, // pick mode: choosing a project ends the server and hands the path to the terminal
  sort: 'lastActive',
  view: 'project', // 'project' | 'stats'
  statsDays: 30,
};
try { state.sort = localStorage.getItem('airecall.sort') || 'lastActive'; } catch {}

const SORTS = {
  lastActive: (a, b) => b.lastActive - a.lastActive,
  name: (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
  cost: (a, b) => b.totals.costUSD - a.totals.costUSD || b.lastActive - a.lastActive,
  tokens: (a, b) => b.totals.inputTokens + b.totals.outputTokens - (a.totals.inputTokens + a.totals.outputTokens) || b.lastActive - a.lastActive,
  sessions: (a, b) => b.totals.sessions - a.totals.sessions || b.lastActive - a.lastActive,
  prompts: (a, b) => b.promptCount - a.promptCount || b.lastActive - a.lastActive,
  memory: (a, b) => b.memoryCount - a.memoryCount || b.lastActive - a.lastActive,
};

// ---------- data ----------
async function load(refresh = false) {
  // returns after the project list is rendered
  $('#refresh').classList.add('spin');
  try {
    const r = await api('/api/projects' + (refresh ? '?refresh=1' : ''));
    const data = await r.json();
    state.projects = data.projects;
    $('#scan-info').textContent = `${data.projects.length} projects · scanned in ${data.durationMs} ms`;
    if (data.errors?.length) toast('Some sources failed: ' + data.errors.join('; '));
    renderChips();
    renderList();
    const [hid, htab] = decodeURIComponent(location.hash.slice(1)).split('/');
    if (hid === 'stats') showStats(Number(htab) || 0);
    else {
      if (htab) state.tab = htab;
      if (hid && state.projects.some((p) => p.id === hid)) select(hid, false);
      else if (state.selected) select(state.selected, false);
    }
  } catch (e) {
    $('#scan-info').textContent = 'scan failed';
    toast(String(e));
  } finally {
    $('#refresh').classList.remove('spin');
  }
}

async function select(id, push = true) {
  state.selected = id;
  state.view = 'project';
  $('#stats-btn').setAttribute('aria-pressed', 'false');
  if (push) setHash();
  document.querySelectorAll('.item').forEach((el) => el.setAttribute('aria-selected', String(el.dataset.id === id)));
  $(`.item[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' });
  document.querySelector('.app').classList.add('has-detail');
  const r = await api('/api/projects/' + encodeURIComponent(id));
  if (!r.ok) return;
  state.detail = await r.json();
  if (state.selected === id) renderDetail();
}

// ---------- filters ----------
const FILTERS = [
  { id: 'running', label: '● running', test: (p) => p.running },
  { id: 'memory', label: 'has memory', test: (p) => p.memoryCount > 0 },
  { id: 'claude', label: 'Claude', test: (p) => p.tools.includes('claude') },
  { id: 'copilot-cli', label: 'Copilot CLI', test: (p) => p.tools.includes('copilot-cli') },
  { id: 'vscode-copilot', label: 'VS Code', test: (p) => p.tools.includes('vscode-copilot') },
  { id: 'codex', label: 'Codex', test: (p) => p.tools.includes('codex') },
  { id: 'missing', label: 'folder missing', test: (p) => !p.exists },
];

function visible() {
  const passes = (p) => [...state.filters].every((f) => FILTERS.find((x) => x.id === f).test(p));
  if (state.results) {
    const byId = new Map(state.projects.map((p) => [p.id, p]));
    return state.results.map((r) => byId.get(r.id)).filter((p) => p && passes(p));
  }
  return state.projects.filter(passes).sort(SORTS[state.sort] ?? SORTS.lastActive);
}

let searchSeq = 0;
let searchTimer;
function onQuery(q) {
  state.q = q;
  clearTimeout(searchTimer);
  if (q.trim().length < 2) {
    state.results = null;
    renderList();
    return;
  }
  searchTimer = setTimeout(async () => {
    const seq = ++searchSeq;
    const r = await api('/api/search?q=' + encodeURIComponent(q.trim()));
    const data = await r.json();
    if (seq !== searchSeq) return; // a newer query finished first
    state.results = data.results;
    renderList();
  }, 150);
}

function highlight(text) {
  const terms = state.q.trim().split(/\s+/).filter(Boolean).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const html = esc(text);
  if (!terms.length) return html;
  return html.replace(new RegExp(`(${terms.map((t) => esc(t)).join('|')})`, 'gi'), '<mark>$1</mark>');
}

function renderChips() {
  $('#chips').innerHTML = FILTERS.map((f) => {
    const n = state.projects.filter(f.test).length;
    if (!n) return '';
    return `<button class="chip" data-f="${f.id}" aria-pressed="${state.filters.has(f.id)}">${esc(f.label)} <span class="n">${n}</span></button>`;
  }).join('');
}

// ---------- list ----------
function renderList() {
  const list = visible();
  const hitsById = new Map((state.results ?? []).map((r) => [r.id, r.hits]));
  $('#list').innerHTML =
    list
      .map(
        (p) => `
    <li class="item ${p.exists ? '' : 'missing'}" role="option" data-id="${esc(p.id)}" aria-selected="${p.id === state.selected}">
      <div class="row1">
        ${p.running ? '<span class="dot" title="session running"></span>' : ''}
        <span class="name">${esc(p.name)}</span>
        <span class="when" title="${p.lastActive ? new Date(p.lastActive).toLocaleString() : ''}">${
          state.sort === 'cost' ? (p.totals.costUSD ? '$' + p.totals.costUSD.toFixed(2) : '—')
          : state.sort === 'tokens' ? compact(p.totals.inputTokens + p.totals.outputTokens)
          : rel(p.lastActive)}</span>
      </div>
      <div class="path">${esc(p.display)}</div>
      ${hitsById.get(p.id)?.length
        ? hitsById.get(p.id).slice(0, 2).map((h) => `<div class="hit"><span class="hk">${esc(h.kind)}</span> ${highlight(h.snippet)}</div>`).join('')
        : p.headline ? `<div class="head">${esc(p.headline)}</div>` : ''}
      <div class="meta">
        ${p.tools.map((t) => `<span class="badge ${t}">${TOOL_SHORT[t]}</span>`).join('')}
        ${p.memoryCount ? `<span class="badge mem">${p.memoryCount} memory</span>` : ''}
        ${p.exists ? '' : '<span class="badge bad">missing</span>'}
      </div>
    </li>`,
      )
      .join('') || '<li class="muted small" style="padding:16px">No matches</li>';
}

// ---------- detail ----------
function renderDetail() {
  const p = state.detail;
  const claudeSessions = p.sessions.filter((s) => s.tool === 'claude');
  const tokens = p.totals.inputTokens + p.totals.outputTokens;
  const tabs = [
    ['overview', 'Overview', ''],
    ['memory', 'Memory', p.memory.length],
    ['sessions', 'Sessions', p.sessions.length],
    ['prompts', 'Prompts', p.promptCount],
    ['files', 'Agent files', p.instructions.length],
    ...(p.todos.length || p.plans.length ? [['plans', 'Plans & todos', p.todos.length + p.plans.length]] : []),
  ];
  if (!tabs.some(([id]) => id === state.tab)) state.tab = 'overview';
  const headline = p.sessions.find((s) => s.title && s.title !== '(running now)')?.title ?? p.memory.find((m) => m.type === 'project')?.description;

  $('#detail').innerHTML = `
  <div class="wrap">
    <button class="btn back" data-act="back">← Projects</button>
    <div class="title-row">
      <div>
        <h2>${esc(p.name)}</h2>
        <div class="path">${esc(p.display)}</div>
      </div>
      <div class="actions">
        ${state.pick
          ? `<button class="btn primary" data-act="choose" ${p.exists ? '' : 'disabled'} title="Close this page and continue in your terminal (Enter)">Open in terminal ↵</button>`
          : `<button class="btn primary" data-act="copy-resume" ${p.resume ? '' : 'disabled'} title="cd into folder and resume a Claude session">Copy resume cmd</button>`}
        <button class="btn" data-act="open" data-app="terminal" ${p.exists ? '' : 'disabled'}>Terminal</button>
        <button class="btn" data-act="open" data-app="vscode" ${p.exists ? '' : 'disabled'}>VS Code</button>
        <button class="btn" data-act="open" data-app="folder" ${p.exists ? '' : 'disabled'}>Folder</button>
      </div>
    </div>
    ${headline ? `<p class="headline">${esc(headline)}</p>` : ''}
    <div class="tags">
      ${p.tools.map((t) => `<span class="badge ${t}">${TOOL_LABEL[t]}</span>`).join('')}
      ${p.exists ? '' : '<span class="badge bad">folder missing</span>'}
      ${p.sessions.some((s) => s.running) ? '<span class="badge ok">● session running</span>' : ''}
      ${p.git?.branch ? `<span class="tag">⎇ ${esc(p.git.branch)}</span>` : ''}
      ${p.git?.remote ? `<span class="tag">${esc(p.git.remote.replace(/^https?:\/\/|\.git$/g, ''))}</span>` : ''}
    </div>
    <div class="stats">
      ${stat('Last active', rel(p.lastActive), day(p.lastActive))}
      ${stat('First seen', day(p.firstSeen) || '—', p.firstSeen ? rel(p.firstSeen) : '')}
      ${stat('Sessions', p.totals.sessions, claudeSessions.length < p.totals.sessions ? `${claudeSessions.length} Claude` : 'transcripts kept')}
      ${stat('Prompts', fmt(p.promptCount), 'all time (history)')}
      ${stat('Memory', p.memory.length, Object.entries(countBy(p.memory, (m) => m.type ?? 'other')).map(([k, v]) => `${v} ${k}`).join(' · '))}
      ${tokens ? stat('Tokens', compact(tokens), `${compact(p.totals.outputTokens)} out · incl. cache`) : ''}
      ${p.totals.costUSD ? stat('Cost', '≈ $' + p.totals.costUSD.toFixed(2), 'API-price equivalent') : ''}
    </div>
    <nav class="tabs" role="tablist">
      ${tabs.map(([id, label, n]) => `<button class="tab" role="tab" data-tab="${id}" aria-selected="${state.tab === id}">${label}${n !== '' ? `<span class="n">${fmt(n)}</span>` : ''}</button>`).join('')}
    </nav>
    <section class="pane" id="pane">${renderPane(p)}</section>
  </div>`;
}

function renderPane(p) {
  switch (state.tab) {
    case 'memory':
      return memoryPane(p);
    case 'sessions':
      return sessionsPane(p);
    case 'prompts':
      return promptsPane(p);
    case 'files':
      return filesPane(p);
    case 'plans':
      return plansPane(p);
    default:
      return overviewPane(p);
  }
}

function overviewPane(p) {
  const lastSession = p.sessions[0];
  const recent = p.prompts.filter((x) => !/^[/!]/.test(x.text) && x.text.trim().length > 3).slice(0, 5);
  const projectMem = p.memory.filter((m) => m.type === 'project').slice(0, 4);
  const feedback = p.memory.filter((m) => m.type === 'feedback');
  const tools = Object.entries(
    p.sessions.reduce((a, s) => {
      for (const [k, v] of Object.entries(s.topTools ?? {})) a[k] = (a[k] ?? 0) + v;
      return a;
    }, {}),
  )
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);
  const maxTool = tools[0]?.[1] ?? 1;
  const models = [...new Set(p.sessions.flatMap((s) => s.models ?? []))];

  return `
    ${lastSession ? `
      <h3 class="section-title">Where you left off</h3>
      <div class="card" style="padding:14px 16px">
        <div class="s-title">${esc(lastSession.title ?? lastSession.firstPrompt ?? lastSession.id)}</div>
        <div class="s-sub">${TOOL_LABEL[lastSession.tool]} · ${rel(lastSession.end ?? lastSession.start)}${lastSession.branch ? ' · ⎇ ' + esc(lastSession.branch) : ''}${lastSession.userMessages ? ` · ${lastSession.userMessages} messages` : ''}</div>
        ${recent[0] ? `<div class="s-sub" style="margin-top:8px">Last prompt <span class="faint">(${rel(recent[0].ts)})</span>: <span style="color:var(--text)">${esc(trunc(recent[0].text, 240))}</span></div>` : ''}
      </div>` : ''}

    ${projectMem.length ? `
      <h3 class="section-title">Project memory</h3>
      <div class="mem-grid">${projectMem.map(memCard).join('')}</div>` : ''}

    ${feedback.length ? `
      <h3 class="section-title">Rules you gave the agent</h3>
      <div class="card" style="padding:6px 16px">
        ${feedback.map((m) => `<div class="todo"><span class="st st-in_progress">!</span><div><div>${esc(m.description ?? m.name)}</div><div class="s-sub mono">${esc(m.name)}</div></div></div>`).join('')}
      </div>` : ''}

    ${recent.length ? `
      <h3 class="section-title">Recent prompts</h3>
      <ul class="timeline card" style="padding:4px 16px">${recent.map(promptLi).join('')}</ul>` : ''}

    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px">
      ${tools.length ? `
        <div>
          <h3 class="section-title">Most used tools</h3>
          <div class="card" style="padding:12px 16px">
            ${tools.map(([k, v]) => `<div style="margin-bottom:8px"><div style="display:flex;justify-content:space-between" class="small"><span class="mono">${esc(k)}</span><span class="muted">${v}</span></div><div class="bar"><span style="width:${(v / maxTool) * 100}%"></span></div></div>`).join('')}
          </div>
        </div>` : ''}
      <div>
        <h3 class="section-title">Details</h3>
        <dl class="card kv" style="padding:12px 16px">
          <dt>Path</dt><dd class="mono">${esc(p.path)}</dd>
          ${models.length ? `<dt>Models</dt><dd>${models.map(esc).join(', ')}</dd>` : ''}
          ${p.claudeConfig?.mcpServers?.length ? `<dt>MCP servers</dt><dd>${p.claudeConfig.mcpServers.map(esc).join(', ')}</dd>` : ''}
          ${p.claudeConfig?.allowedTools ? `<dt>Allowed tools</dt><dd>${p.claudeConfig.allowedTools} rules</dd>` : ''}
          ${p.instructions.length ? `<dt>Agent files</dt><dd>${p.instructions.map((i) => esc(i.name)).join(', ')}</dd>` : ''}
          ${p.claudeConfig?.lastSessionId ? `<dt>Last session</dt><dd class="mono">${esc(p.claudeConfig.lastSessionId)}</dd>` : ''}
        </dl>
      </div>
    </div>`;
}

function memCard(m) {
  const t = m.type ?? 'other';
  return `
    <details class="card mem">
      <summary>
        <span class="mtype t-${esc(t)}">${esc(t)}</span>
        <span class="mname">${esc(m.name)}</span>
        <span class="mtime">${rel(m.mtime)}</span>
        ${m.description ? `<span class="mdesc">${esc(m.description)}</span>` : ''}
      </summary>
      <div class="md">${md(m.content)}</div>
    </details>`;
}

function memoryPane(p) {
  if (!p.memory.length) return empty('No memory files for this project.', 'Claude Code stores them in ~/.claude/projects/<encoded-path>/memory/.');
  const groups = countBy(p.memory, (m) => m.type ?? 'other');
  const order = ['index', 'project', 'feedback', 'user', 'reference', 'other'];
  return order
    .filter((t) => groups[t])
    .map((t) => `<h3 class="section-title">${t} · ${groups[t]}</h3><div class="mem-grid">${p.memory.filter((m) => (m.type ?? 'other') === t).map(memCard).join('')}</div>`)
    .join('');
}

function sessionsPane(p) {
  if (!p.sessions.length) return empty('No session transcripts kept.', 'Claude Code deletes transcripts after cleanupPeriodDays (default 30). Prompt history is still shown under Prompts.');
  return `
    <div class="card table-wrap">
      <table class="wide">
        <thead><tr><th>Session</th><th>Tool</th><th>When</th><th class="num">Msgs</th><th class="num">Tool calls</th><th class="num">Tokens</th><th class="num">Cost</th><th></th></tr></thead>
        <tbody>
          ${p.sessions
            .map((s) => {
              const tok = s.tokens ? s.tokens.input + s.tokens.output + s.tokens.cacheRead + s.tokens.cacheWrite : 0;
              return `<tr>
                <td>
                  <div class="s-title">${s.running ? '<span class="dot" style="display:inline-block;margin-right:6px"></span>' : ''}${esc(s.title ?? '(untitled)')}${s.archived ? ' <span class="badge" style="--c:var(--faint)" title="Transcript deleted by the agent; summary kept by airecall">archived</span>' : ''}</div>
                  ${s.firstPrompt && s.firstPrompt !== s.title ? `<div class="s-sub">${esc(trunc(s.firstPrompt, 140))}</div>` : ''}
                  <div class="s-sub mono">${esc(s.id)}${s.branch ? ' · ⎇ ' + esc(s.branch) : ''}${s.models?.length ? ' · ' + esc(s.models.join(', ')) : ''}${s.linesAdded ? ` · +${s.linesAdded}/−${s.linesRemoved ?? 0}` : ''}</div>
                </td>
                <td><span class="badge ${s.tool}">${TOOL_SHORT[s.tool]}</span></td>
                <td style="white-space:nowrap" title="${s.start ? new Date(s.start).toLocaleString() : ''}">${rel(s.end ?? s.start)}<div class="s-sub">${dur(s.start, s.end)}</div></td>
                <td class="num">${s.userMessages ?? '—'}</td>
                <td class="num">${s.toolCalls ?? '—'}</td>
                <td class="num">${tok ? compact(tok) : '—'}</td>
                <td class="num">${s.costUSD ? '$' + s.costUSD.toFixed(2) : '—'}</td>
                <td>${resumeCmd(p, s) && !s.archived
                  ? state.pick
                    ? `<button class="btn small primary" data-act="choose" data-session="${esc(s.id)}">Resume this</button>`
                    : `<button class="btn small" data-act="copy" data-text="${esc(resumeCmd(p, s))}">Copy resume</button>`
                  : ''}</td>
              </tr>`;
            })
            .join('')}
        </tbody>
      </table>
    </div>`;
}

function promptsPane(p) {
  if (!p.prompts.length) return empty('No prompt history.');
  return `<p class="muted small">Latest ${p.prompts.length} of ${fmt(p.promptCount)} prompts. Secrets that look like tokens are redacted.</p>
    <ul class="timeline card" style="padding:4px 16px">${p.prompts.map(promptLi).join('')}</ul>`;
}

function filesPane(p) {
  if (!p.exists) return empty('Folder no longer exists.');
  if (!p.instructions.length) return empty('No agent instruction files in this folder.', 'Looked for CLAUDE.md, AGENTS.md, .claude/, .github/copilot-instructions.md, .mcp.json, .cursor/rules, GEMINI.md…');
  return `<div class="files">${p.instructions
    .map((f) => `<button class="card file" data-act="view" data-path="${esc(f.path)}" ${f.name.endsWith(')') ? 'disabled' : ''}><div class="fname">${esc(f.name)}</div><div class="fmeta">${f.name.endsWith(')') ? 'folder' : bytes(f.size)} · ${rel(f.mtime)}</div></button>`)
    .join('')}</div><div id="viewer"></div>`;
}

function plansPane(p) {
  return `
    ${p.todos.length ? `<h3 class="section-title">Todos</h3><div class="card" style="padding:4px 16px">${p.todos
      .map((t) => `<div class="todo"><span class="st st-${esc(t.status)}">${{ done: '✓', in_progress: '▶', blocked: '■' }[t.status] ?? '○'}</span><div><div>${esc(t.title)}</div>${t.description ? `<div class="s-sub">${esc(t.description)}</div>` : ''}</div></div>`)
      .join('')}</div>` : ''}
    ${p.plans.map((pl) => `<h3 class="section-title">Plan · ${TOOL_LABEL[pl.tool]} · ${rel(pl.mtime)}</h3><div class="card md">${md(pl.content)}</div>`).join('')}`;
}

function promptLi(x) {
  const cmd = /^[/!]/.test(x.text);
  return `<li><span class="ts" title="${new Date(x.ts).toLocaleString()}">${rel(x.ts)}</span><span class="tx ${cmd ? 'cmd' : ''}">${esc(trunc(x.text, 600))}</span></li>`;
}

function resumeCmd(p, s) {
  return s.resume || ''; // built + validated server-side (src/resume.ts)
}

// ---------- stats view ----------
const TOOL_NAMES = { claude: 'Claude Code', 'copilot-cli': 'Copilot CLI', 'vscode-copilot': 'VS Code Copilot', codex: 'Codex' };
const tok = (u) => u.input + u.output + u.cacheRead + u.cacheWrite;
const usd = (n) => (n >= 100 ? '$' + n.toFixed(0) : n >= 1 ? '$' + n.toFixed(2) : n > 0 ? '$' + n.toFixed(3) : '$0');

async function showStats(days = state.statsDays) {
  state.view = 'stats';
  state.statsDays = days;
  state.selected = null;
  document.querySelectorAll('.item').forEach((el) => el.setAttribute('aria-selected', 'false'));
  $('#stats-btn').setAttribute('aria-pressed', 'true');
  document.querySelector('.app').classList.add('has-detail');
  history.replaceState(null, '', '#stats' + (days ? '/' + days : ''));
  const st = await (await api('/api/stats' + (days ? '?days=' + days : ''))).json();
  if (state.view !== 'stats') return;
  const t = st.totals;
  const tools = Object.entries(st.byTool).sort((a, b) => b[1].cost - a[1].cost || tok(b[1].tokens) - tok(a[1].tokens));
  const models = Object.entries(st.byModel).filter(([, b]) => tok(b.tokens)).sort((a, b) => b[1].cost - a[1].cost || tok(b[1].tokens) - tok(a[1].tokens));
  const maxModel = Math.max(...models.map(([, b]) => b.cost), 0.0001);
  const maxProj = Math.max(...st.byProject.map((p) => p.cost), 0.0001);
  const maxDay = Math.max(...st.daily.map((d) => d.cost), 0.0001);
  const ca = st.claudeAllTime;
  const staleDays = ca?.asOf ? Math.round((Date.now() - Date.parse(ca.asOf)) / 864e5) : 0;

  $('#detail').innerHTML = `
  <div class="wrap">
    <button class="btn back" data-act="back">← Projects</button>
    <div class="title-row">
      <div><h2>Usage &amp; cost</h2><div class="path">${days ? 'last ' + days + ' days' : 'all time'} · cost = recorded by the agent, else estimated at Anthropic API list prices (${esc(st.pricingAsOf)})</div></div>
      <div class="actions seg" role="group" aria-label="Time window">
        ${[[7, '7d'], [30, '30d'], [90, '90d'], [0, 'All']].map(([d, l]) => `<button data-days="${d}" aria-pressed="${(days || 0) === d}">${l}</button>`).join('')}
      </div>
    </div>
    <div class="stats">
      ${stat('Cost', '≈ ' + usd(t.cost), `recorded ${usd(t.recordedCost)} · est. ${usd(t.estimatedOnlyCost)}`)}
      ${stat('Tokens', compact(tok(t.tokens)), `${compact(t.tokens.output)} out · ${compact(t.tokens.cacheRead)} cache read`)}
      ${stat('Sessions', t.sessions, `${st.byProject.length} projects`)}
      ${t.premiumRequests ? stat('Copilot', t.premiumRequests, 'premium requests') : ''}
    </div>
    <p class="note">Subscriptions (Claude Pro/Max, Copilot) don't bill per token — this is what the same usage would cost on the API.${t.unpricedTokens ? ` ${compact(t.unpricedTokens)} tokens ran on non-Anthropic models and are not priced.` : ''}</p>

    <h3 class="section-title">Daily cost (estimated)</h3>
    <div class="card">
      <div class="chart">${st.daily.map((d) => `<div class="col ${d.cost ? '' : 'zero'}" title="${esc(d.day)}: ${usd(d.cost)} · ${compact(d.tokens)} tokens"><span style="height:${(d.cost / maxDay) * 100}%"></span></div>`).join('')}</div>
      <div class="chart-axis"><span>${esc(st.daily[0]?.day ?? '')}</span><span>peak ${usd(maxDay === 0.0001 ? 0 : maxDay)}</span><span>${esc(st.daily.at(-1)?.day ?? '')}</span></div>
    </div>

    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px">
      <div>
        <h3 class="section-title">By tool</h3>
        <div class="card table-wrap"><table>
          <thead><tr><th>Tool</th><th class="num">Tokens</th><th class="num">Cost</th><th class="num">Sessions</th></tr></thead>
          <tbody>${tools.map(([k, b]) => `<tr><td><span class="badge ${k}">${TOOL_NAMES[k] ?? esc(k)}</span></td><td class="num">${compact(tok(b.tokens))}</td><td class="num">${usd(b.cost)}</td><td class="num">${b.sessions}</td></tr>`).join('')}</tbody>
        </table></div>
      </div>
      <div>
        <h3 class="section-title">By model</h3>
        <div class="card table-wrap"><table>
          <thead><tr><th>Model</th><th></th><th class="num">Tokens</th><th class="num">Cost</th></tr></thead>
          <tbody>${models.map(([m, b]) => `<tr><td class="mono">${esc(m)}</td><td class="hbar-wrap"><div class="hbar" style="width:${(b.cost / maxModel) * 100}%"></div></td><td class="num">${compact(tok(b.tokens))}</td><td class="num">${b.priced ? usd(b.cost) : 'n/a'}</td></tr>`).join('')}</tbody>
        </table></div>
      </div>
    </div>

    <h3 class="section-title">By project</h3>
    <div class="card table-wrap"><table>
      <thead><tr><th>Project</th><th></th><th class="num">Cost</th><th class="num">Tokens</th><th class="num">Sessions</th><th>Last active</th></tr></thead>
      <tbody>${st.byProject.map((p) => `<tr class="clickable" data-id="${esc(p.id)}" style="cursor:pointer"><td><div class="s-title">${esc(p.name)}</div><div class="s-sub mono">${esc(p.path)}</div></td><td class="hbar-wrap"><div class="hbar" style="width:${(p.cost / maxProj) * 100}%"></div></td><td class="num">${usd(p.cost)}</td><td class="num">${compact(p.tokens)}</td><td class="num">${p.sessions}</td><td>${rel(p.lastActive)}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">No usage in this window.</td></tr>'}</tbody>
    </table></div>

    ${ca && !days ? `
    <h3 class="section-title">Claude Code all-time (its own counters, as of ${esc(ca.asOf ?? '?')})</h3>
    <div class="card" style="padding:12px 16px">
      <div class="stats" style="margin:0 0 10px">
        ${stat('≈ Cost', usd(ca.costUSD || ca.estCostUSD), ca.costUSD ? 'recorded' : 'API-price equivalent')}
        ${stat('Sessions', ca.totalSessions ?? '?', 'since ' + esc(ca.firstSessionDate?.slice(0, 10) ?? '?'))}
        ${stat('Messages', compact(ca.totalMessages ?? 0), ca.busiestHours.length ? 'busiest ' + ca.busiestHours.map((x) => String(x.hour).padStart(2, '0') + ':00').join(', ') : '')}
      </div>
      <table><tbody>${ca.models.map((m) => `<tr><td class="mono">${esc(m.model)}</td><td class="num">${compact(m.tokens)}</td><td class="num">${m.costUSD ? usd(m.costUSD) : m.estCostUSD != null ? '≈ ' + usd(m.estCostUSD) : 'n/a'}</td></tr>`).join('')}</tbody></table>
      ${staleDays > 7 ? `<p class="note">Claude Code stopped updating this file ${staleDays} days ago; newer usage appears only in the sections above.</p>` : ''}
    </div>` : ''}
  </div>`;
}

// ---------- tiny markdown ----------
function md(src) {
  const lines = String(src ?? '').split('\n');
  let out = '', inCode = false, list = null;
  const closeList = () => { if (list) { out += `</${list}>`; list = null; } };
  const inline = (s) =>
    esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|\W)\*([^*\s][^*]*)\*(?=\W|$)/g, '$1<em>$2</em>')
      .replace(/\[\[([^\]]+)\]\]/g, '<span class="wl">[[$1]]</span>')
      .replace(/\[([^\]\[]+)\]\(([^)\s\[\]"<>]+)\)/g, (m, label, href) =>
        /^https?:\/\//i.test(href) ? `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>` : `<span class="wl">${label}</span>`);
  for (const line of lines) {
    if (line.startsWith('```')) {
      closeList();
      out += inCode ? '</code></pre>' : '<pre><code>';
      inCode = !inCode;
      continue;
    }
    if (inCode) { out += esc(line) + '\n'; continue; }
    let m;
    if ((m = /^(#{1,4})\s+(.*)/.exec(line))) { closeList(); out += `<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`; }
    else if ((m = /^\s*[-*]\s+(.*)/.exec(line))) { if (list !== 'ul') { closeList(); out += '<ul>'; list = 'ul'; } out += `<li>${inline(m[1])}</li>`; }
    else if ((m = /^\s*\d+[.)]\s+(.*)/.exec(line))) { if (list !== 'ol') { closeList(); out += '<ol>'; list = 'ol'; } out += `<li>${inline(m[1])}</li>`; }
    else if ((m = /^>\s?(.*)/.exec(line))) { closeList(); out += `<blockquote>${inline(m[1])}</blockquote>`; }
    else if (!line.trim()) closeList();
    else { closeList(); out += `<p>${inline(line)}</p>`; }
  }
  closeList();
  if (inCode) out += '</code></pre>';
  return out;
}

// ---------- helpers ----------
function setHash() { history.replaceState(null, '', '#' + encodeURIComponent(state.selected ?? '') + (state.tab !== 'overview' ? '/' + state.tab : '')); }
function stat(k, v, s = '') { return `<div class="stat"><div class="k">${k}</div><div class="v">${esc(v)}</div>${s ? `<div class="s">${esc(s)}</div>` : ''}</div>`; }
function empty(msg, hint = '') { return `<div class="card" style="padding:28px;text-align:center"><div>${esc(msg)}</div>${hint ? `<div class="muted small" style="margin-top:6px">${esc(hint)}</div>` : ''}</div>`; }
function countBy(arr, fn) { return arr.reduce((a, x) => ((a[fn(x)] = (a[fn(x)] ?? 0) + 1), a), {}); }
function fmt(n) { return typeof n === 'number' ? n.toLocaleString() : n; }
function day(ms) { return ms ? new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : ''; }
function compact(n) { return Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(n); }
function bytes(n) { return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`; }
function trunc(s, n) { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
function shq(s) { return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`; }
function rel(ms) {
  if (!ms) return '—';
  const d = (Date.now() - ms) / 1000;
  if (d < 60) return 'just now';
  if (d < 3600) return `${Math.round(d / 60)}m ago`;
  if (d < 86400) return `${Math.round(d / 3600)}h ago`;
  if (d < 86400 * 14) return `${Math.round(d / 86400)}d ago`;
  if (d < 86400 * 60) return `${Math.round(d / 604800)}w ago`;
  return day(ms);
}
function dur(a, b) {
  if (!a || !b || b <= a) return '';
  const m = Math.round((b - a) / 60000);
  return m < 60 ? `${m} min` : m < 1440 ? `${(m / 60).toFixed(1)} h` : `${Math.round(m / 1440)} days span`;
}
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}
async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('Copied: ' + trunc(text, 70)); }
  catch { toast('Copy failed — ' + text); }
}

// ---------- events ----------
$('#q').addEventListener('input', (e) => onQuery(e.target.value));
$('#refresh').addEventListener('click', () => load(true));
$('#sort').value = state.sort;
$('#sort').addEventListener('change', (e) => {
  state.sort = e.target.value;
  try { localStorage.setItem('airecall.sort', state.sort); } catch {}
  renderList();
});
$('#stats-btn').addEventListener('click', () => showStats());
$('#chips').addEventListener('click', (e) => {
  const b = e.target.closest('.chip');
  if (!b) return;
  const f = b.dataset.f;
  state.filters.has(f) ? state.filters.delete(f) : state.filters.add(f);
  renderChips();
  renderList();
});
$('#list').addEventListener('click', (e) => {
  const li = e.target.closest('.item');
  if (li) select(li.dataset.id);
});
$('#detail').addEventListener('click', async (e) => {
  const seg = e.target.closest('[data-days]');
  if (seg) return showStats(Number(seg.dataset.days) || 0);
  const row = e.target.closest('tr[data-id]');
  if (row) return select(row.dataset.id);
  const tab = e.target.closest('.tab');
  if (tab) {
    state.tab = tab.dataset.tab;
    setHash();
    document.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-selected', String(t === tab)));
    $('#pane').innerHTML = renderPane(state.detail);
    return;
  }
  const b = e.target.closest('[data-act]');
  if (!b || b.disabled) return;
  const p = state.detail;
  switch (b.dataset.act) {
    case 'back':
      document.querySelector('.app').classList.remove('has-detail');
      break;
    case 'choose':
      choose(p, b.dataset.session);
      break;
    case 'copy-resume':
      if (p.resume) copy(p.resume);
      break;
    case 'copy':
      copy(b.dataset.text);
      break;
    case 'open': {
      const r = await api('/api/open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: p.id, app: b.dataset.app }) });
      toast(r.ok ? `Opening ${b.dataset.app}…` : 'Could not open');
      break;
    }
    case 'view': {
      const r = await api('/api/file?path=' + encodeURIComponent(b.dataset.path));
      const text = r.ok ? await r.text() : 'Cannot read file.';
      const name = b.querySelector('.fname').textContent;
      $('#viewer').innerHTML = `<div class="card viewer"><header><span>${esc(name)}</span><button class="btn small" data-act="close-viewer">Close</button></header>${
        name.endsWith('.md') ? `<div class="md">${md(text)}</div>` : `<pre>${esc(text)}</pre>`
      }</div>`;
      $('#viewer').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      break;
    }
    case 'close-viewer':
      $('#viewer').innerHTML = '';
      break;
  }
});
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input') && !['Escape', 'ArrowDown', 'ArrowUp', 'Enter'].includes(e.key)) return;
  if (e.target.matches('input, select') && e.key === 'Enter') return;
  if (e.key === 'Enter' && state.pick && state.detail?.resume && e.target === document.body) { e.preventDefault(); choose(state.detail); }
  else if (e.key === '/') { e.preventDefault(); $('#q').focus(); }
  else if (e.key === 'Escape') { $('#q').blur(); }
  else if (e.key === 'r' && !e.metaKey && !e.ctrlKey) load(true);
  else if (e.key === 's' && !e.metaKey && !e.ctrlKey) showStats();
  else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const ids = visible().map((p) => p.id);
    if (!ids.length) return;
    const i = ids.indexOf(state.selected);
    const next = e.key === 'ArrowDown' ? Math.min(ids.length - 1, i + 1) : Math.max(0, i - 1);
    select(ids[i < 0 ? 0 : next]);
  }
});

async function initPick() {
  try {
    state.pick = !!(await (await api('/api/config')).json()).pick;
  } catch {}
  if (!state.pick) return;
  document.body.classList.add('pick-mode');
  $('.sidebar').insertAdjacentHTML('afterbegin', '<div class="pick-banner">Choose a project → <b>Open in terminal</b> (or press Enter). This page closes itself.</div>');
  setInterval(() => api('/api/ping', { method: 'POST', body: '{}' }).catch(() => {}), 3000);
}

async function choose(p, sessionId) {
  const r = await api('/api/choose', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: p.id, sessionId }) }).catch(() => null);
  if (!r?.ok) return toast('Could not hand off to terminal');
  document.body.innerHTML = `<div class="done"><div class="check">✓</div><h2>${esc(p.name)}</h2><p class="muted mono">${esc(p.display)}</p><p>Back to your terminal. The airecall server has stopped — you can close this tab.</p></div>`;
  setTimeout(() => window.close(), 400); // works only if the browser allows it
}

initPick().then(load).then(() => {
  const q = new URLSearchParams(location.search).get('q');
  if (q) { $('#q').value = q; onQuery(q); }
});

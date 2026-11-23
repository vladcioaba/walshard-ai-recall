# Walshard AI Recall

`airecall` finds every folder you used an AI coding agent in (Claude Code, GitHub Copilot CLI,
VS Code Copilot Chat, Codex), even when you forgot the path, and shows its state, memory, sessions,
prompts, tokens and cost. Pick one in the browser and your terminal lands in it, resuming the session.

Read-only towards agent folders. Nothing leaves your machine.

## Security model

Every agent's prompts, memory and costs end up in one place, so airecall treats its own data and
everything it reads as hostile:

- **Server:** binds and advertises `127.0.0.1` only. Every `/api/*` call needs a random per-run
  key, delivered in the URL fragment (never sent over the network). Other local users, processes
  and port-forwarders get `401`. The server also checks Host (against DNS rebinding), rejects
  cross-site fetches (`Sec-Fetch-Site`), requires an exact Origin and JSON on POSTs, and forbids
  framing (`frame-ancestors 'none'`, `X-Frame-Options: DENY`).
- **Shell handoff:** no `eval`. `airecall go --handoff` prints `dir<TAB>tool<TAB>session-id`, and the
  static shell function `cd`s and runs a fixed command chosen by tool. Session ids must look like
  ids (no `-flags`, no metacharacters), checked in Node and again in the shell.
- **Untrusted input:** all JSON fields are type-checked, and one bad record can't break the scan.
  Text is stripped of terminal control and bidi characters and secrets are redacted (API keys,
  PEM blocks, URL credentials, bearer tokens, `password=`...). Symlinked instruction or memory
  files are never read. Agent config JSON (`.mcp.json`, `settings*.json`) is shown with its
  values masked. Map keys are safe against prototype pollution.
- **Folder / Terminal / VS Code buttons:** macOS uses "reveal in Finder" (`open -R`), and
  application bundles are never opened. On Windows the path is never placed inside a cmd.exe
  command line.
- **airecall's only write:** `~/.airecall/sessions.json` (directory 0700, file 0600, atomic write that
  never follows symlinks). It stores titles and numbers, no prompt text. Entries expire after 365
  days (`AIRECALL_INDEX_DAYS`), with a 10k-session cap. Remove data with `airecall forget <project|id>`
  or `airecall purge`. Disable the index with `AIRECALL_NO_INDEX=1`.

## Requirements

Node ≥ 22.13. No runtime dependencies.

## Install

```bash
npm install -g walshard-ai-recall
airecall init zsh >> ~/.zshrc   # or ~/.bashrc; static function, nothing eval'd at startup
```

Windows (PowerShell):

```powershell
npm install -g walshard-ai-recall
airecall init powershell >> $PROFILE   # then open a new PowerShell window
```

From source (development):

```bash
git clone https://github.com/vladcioaba/walshard-ai-recall && cd walshard-ai-recall
npm install && npm run build && npm link
node src/cli.ts list            # Node ≥ 23.6 runs the TypeScript sources directly
```

## Use

Then:

```bash
airecall                          # browser picker; terminal waits. Click a project/session →
                               # server stops, port closes, terminal cd's + resumes
airecall list [filter] [--json]   # terminal only: all projects, newest first
airecall search <words…>          # terminal only: paths, titles, memory, plans, every prompt
airecall show <filter|#>          # terminal only: details
airecall stats [filter] [--days N] # terminal only: tokens + cost by tool, model, project, day
airecall pick [filter]            # terminal only: numbered picker, prints the path
airecall ui [--port 4545]         # long-running dashboard; open the printed one-time link
airecall forget <filter|id>       # remove sessions from airecall's index
airecall purge                    # delete airecall's index
```

Picker details: random free port per run; closing the tab ends it within ~15 s; Ctrl+C cancels.
Without the shell function, `airecall go` just prints the command (e.g. `cd '/path' && claude --resume <id>`)
for you to copy. The function never evals it.

## Data sources

| Tool | Location | What we read |
|---|---|---|
| Claude Code | `~/.claude/projects/*/*.jsonl` | sessions: title, cwd, branch, tokens, cost, tools, models |
| | `~/.claude/history.jsonl` | every prompt + project (survives 30-day transcript cleanup) |
| | `~/.claude.json` → `projects` | project registry, MCP servers, last cost |
| | `~/.claude/projects/*/memory/*.md` | memory files (frontmatter type/description) |
| | `~/.claude/sessions/*.json` | currently running sessions |
| Copilot CLI | `~/.copilot/session-state/*/` | workspace.yaml, events.jsonl, plan.md, session.db todos |
| VS Code family | `…/User/workspaceStorage/*/chatSessions` | Copilot Chat sessions (Code, Insiders, Cursor, Windsurf, VSCodium) |
| Codex | `~/.codex/sessions/**/rollout-*.jsonl` | sessions (format not yet verified) |
| Project folder | `CLAUDE.md`, `AGENTS.md`, `.claude/`, `.github/copilot-instructions.md`, `.mcp.json`, … | agent instruction files, git branch/remote |

Claude's folder names are lossy (`my_app` → `my-app`), so real paths come from `cwd` inside the
transcripts/history, falling back to matching folders on disk.

## Test

```bash
npm test           # builds, then scans a fake $HOME with Claude/Copilot/Codex data
npm run typecheck
```

## Layout

```
bin/airecall.js        launcher (runs dist/)
src/cli.ts             list / show / pick / ui
src/scan.ts            merge adapters per project, inspect folders
src/adapters/*.ts      claude, copilot, vscode, codex
src/search.ts          full-text corpus + ranking
src/store.ts           ~/.airecall session index (survives transcript cleanup; retention + forget/purge)
src/resume.ts          the single validated builder for resume commands / shell handoff
src/server.ts          localhost API + static UI
test/                  node:test smoke + security regression tests on synthetic data
ui/                    dashboard (vanilla JS, no CDN)
```

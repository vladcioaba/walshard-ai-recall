export type Tool = 'claude' | 'copilot-cli' | 'vscode-copilot' | 'codex';

export interface Session {
  tool: Tool;
  id: string;
  title?: string;
  firstPrompt?: string;
  start?: number; // epoch ms
  end?: number;
  branch?: string;
  userMessages?: number;
  assistantMessages?: number;
  toolCalls?: number;
  models?: string[];
  tokens?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  costUSD?: number;
  linesAdded?: number;
  linesRemoved?: number;
  topTools?: Record<string, number>;
  running?: boolean;
  /** Token usage per local day (YYYY-MM-DD) per model. */
  usageDaily?: Record<string, Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>>;
  /** Last thing you asked, and the agent's last text reply (redacted, shortened). Not persisted. */
  lastPrompt?: string;
  lastReply?: string;
  lastReplyAt?: number;
  /** GitHub Copilot billing unit. */
  premiumRequests?: number;
  /** Transcript gone from the agent's dir; known only from airecall's own index. */
  archived?: boolean;
  file?: string;
}

export interface MemoryFile {
  tool: Tool;
  name: string;
  path: string;
  type?: string;
  description?: string;
  content: string;
  mtime: number;
}

export interface Todo {
  title: string;
  status: string;
  description?: string;
}

export interface Prompt {
  tool: Tool;
  text: string;
  ts: number;
}

export interface InstructionFile {
  name: string; // relative to project root
  path: string;
  size: number;
  mtime: number;
}

export interface GitInfo {
  branch?: string;
  remote?: string;
}

export interface Project {
  id: string; // stable slug from path
  path: string;
  name: string;
  exists: boolean;
  tools: Tool[];
  lastActive: number;
  firstSeen: number;
  sessions: Session[];
  memory: MemoryFile[];
  prompts: Prompt[]; // most recent first, capped
  promptCount: number;
  todos: Todo[];
  plans: { tool: Tool; path: string; content: string; mtime: number }[];
  instructions: InstructionFile[];
  git?: GitInfo;
  claudeConfig?: {
    mcpServers: string[];
    allowedTools: number;
    lastCostUSD?: number;
    lastSessionId?: string;
  };
  totals: { costUSD: number; inputTokens: number; outputTokens: number; sessions: number };
}

/** Partial contribution an adapter makes for a single project path. */
export type Contribution = Partial<Omit<Project, 'id' | 'path' | 'name' | 'exists' | 'totals'>> & { path: string };

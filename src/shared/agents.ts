/**
 * The coding agents Coplan plans with.
 *
 * Coplan started as a Claude Code plugin and the daemon, the MCP tools and
 * the browser are the same for every agent. What differs is the edge: how
 * each one reports its lifecycle to hooks, what it calls the tool it asks
 * the user questions with, whether a hook can add words to the user's next
 * prompt, and what the page should call it. That is all kept here, so the
 * rest of the code names an agent and never assumes one.
 */

export const AGENT_KINDS = ['claude', 'codex', 'cursor'] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

export interface AgentInfo {
  kind: AgentKind;
  /** How the page names it in a sentence: "Claude is working". */
  name: string;
  /** The product a user starts: "Start Claude Code in a project…". */
  product: string;
  /** Where a link to one of its sessions opens: "Open this session in …". */
  app: string;
  /** The structured-question tools whose calls mean "waiting on the user". */
  askTools: readonly string[];
  /** How the agent is told to ask the user something, in tool descriptions
   *  and prompts: "ask the user with …". */
  askWith: string;
  /**
   * Whether a hook can add context to the user's next prompt. Where it can,
   * the build prompt rides along with whatever the user types next ("go"
   * will do). Where it cannot, the user pastes the prompt themselves, and the
   * hook only notices that they did.
   */
  promptContext: boolean;
}

export const AGENTS: Record<AgentKind, AgentInfo> = {
  claude: {
    kind: 'claude',
    name: 'Claude',
    product: 'Claude Code',
    app: 'the Claude desktop app',
    askTools: ['AskUserQuestion'],
    askWith: 'AskUserQuestion',
    promptContext: true,
  },
  codex: {
    kind: 'codex',
    name: 'Codex',
    product: 'Codex',
    app: 'the Codex app',
    askTools: ['request_user_input', 'request_user_input_async'],
    // Codex only offers request_user_input in Plan mode.
    askWith: 'request_user_input (in Plan mode) or plainly',
    promptContext: true,
  },
  cursor: {
    kind: 'cursor',
    name: 'Cursor',
    product: 'Cursor',
    app: 'Cursor',
    // Cursor's hooks do not see AskQuestion today, so hooks/cursor.json
    // registers none for it: a question is noticed when the turn ends on
    // one. Named here for the prompts, which tell Cursor how to ask.
    askTools: ['AskQuestion'],
    askWith: 'AskQuestion or plainly',
    promptContext: false,
  },
};

/** Sessions saved before Coplan knew about other agents were all Claude's. */
export const DEFAULT_AGENT: AgentKind = 'claude';

export function isAgentKind(value: unknown): value is AgentKind {
  return typeof value === 'string' && (AGENT_KINDS as readonly string[]).includes(value);
}

/** An agent named by a header, an argument or a saved session; Claude when
 *  it is missing or unknown. */
export function parseAgent(value: unknown): AgentKind {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return isAgentKind(v) ? v : DEFAULT_AGENT;
}

export function agentInfo(kind: AgentKind | null | undefined): AgentInfo {
  return AGENTS[kind && isAgentKind(kind) ? kind : DEFAULT_AGENT];
}

type Env = Record<string, string | undefined>;

/**
 * Where an agent says, in a child process's environment, which session it is
 * running. Claude Code sets `CLAUDE_CODE_SESSION_ID` for its MCP servers.
 * Codex sets `CODEX_THREAD_ID`, and Cursor `CURSOR_CONVERSATION_ID`, for the
 * shell commands the agent runs — so `coplan open` finds the session — but
 * not for MCP servers: Codex names the thread on each call instead, and a
 * Cursor server is matched to a chat by its workspace.
 */
const SESSION_ENV: Record<AgentKind, readonly string[]> = {
  claude: ['CLAUDE_CODE_SESSION_ID'],
  codex: ['CODEX_THREAD_ID'],
  cursor: ['CURSOR_CONVERSATION_ID'],
};

export function sessionFromEnv(env: Env, agent: AgentKind): string | null {
  for (const key of SESSION_ENV[agent]) {
    const value = env[key]?.trim();
    if (value) return value;
  }
  return null;
}

/** The folder the agent has open, when its MCP config says so: Cursor passes
 *  `${workspaceFolder}`, since its servers do not start in the workspace. */
export function workspaceFromEnv(env: Env): string | null {
  const value = env['COPLAN_WORKSPACE']?.trim();
  // An unexpanded `${workspaceFolder}` names no folder at all.
  return value && !value.includes('${') ? value : null;
}

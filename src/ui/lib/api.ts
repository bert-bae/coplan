import type {
  Change,
  CleanupGroupId,
  CleanupOutcome,
  Plan,
  PlanOp,
  ReviewMode,
  SessionState,
  SessionSummary,
  StorageReport,
} from '../../shared/types.ts';
import type { GapSeverities } from '../../shared/check.ts';
import type { Block, ConfigRow } from '../../shared/blocks.ts';

/**
 * Client for the daemon.
 *
 * The auth token arrives in the link `coplan url` prints, or is traded for
 * the single-use login ticket in the one `coplan open` opens. It is taken out
 * of the address bar, kept in localStorage, and sent as a header. Kept, so
 * the plain links the tools print — a new tab, a bookmark — work once the
 * page has been opened with the key, as they did with a cookie. Not a
 * cookie: a cookie is not scoped to a port, so every other server on
 * 127.0.0.1 would be handed it, and a browser sends one by itself; storage
 * belongs to this origin alone and is sent only by this code.
 */
const TOKEN_KEY = 'coplan.token';

function takeFromLink(name: string): string | null {
  const url = new URL(window.location.href);
  const value = url.searchParams.get(name);
  if (value) {
    url.searchParams.delete(name);
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  }
  return value;
}

function keep(value: string): void {
  try {
    window.localStorage.setItem(TOKEN_KEY, value);
  } catch {
    /* private mode: kept in memory for this page */
  }
}

function readToken(): string | null {
  try {
    const fromLink = takeFromLink('token');
    if (fromLink) {
      keep(fromLink);
      return fromLink;
    }
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    /* no storage: nothing kept */
    return null;
  }
}

let token: string | null = typeof window === 'undefined' ? null : readToken();

async function logIn(): Promise<void> {
  const ticket = takeFromLink('login');
  if (!ticket) return;
  const res = await fetch(`/api/login?${new URLSearchParams({ ticket }).toString()}`, { method: 'POST', credentials: 'omit' });
  if (!res.ok) return;
  token = ((await res.json()) as { token: string }).token;
  keep(token);
}

/** Every call waits for a login ticket in the link to be traded. */
const signedIn: Promise<void> = typeof window === 'undefined' ? Promise.resolve() : logIn().catch(() => undefined);

const authHeaders = (): Record<string, string> => (token ? { authorization: `Bearer ${token}` } : {});

/** The address of the live stream, with a single-use ticket for it: a
 *  browser cannot send the token as a header on an EventSource. */
export async function eventsUrl(sessionId: string | null): Promise<string> {
  const { ticket } = await request<{ ticket: string }>('/api/events/ticket', { method: 'POST', body: '{}' });
  const query = new URLSearchParams({ ticket, ...(sessionId ? { session: sessionId } : {}) });
  return `/api/events?${query.toString()}`;
}

/** A refusal for want of the token (the daemon restarted with a new one). */
export class Unauthorized extends Error {}

async function request<T>(route: string, init?: RequestInit): Promise<T> {
  await signedIn;
  const res = await fetch(route, {
    credentials: 'omit',
    ...init,
    headers: { 'content-type': 'application/json', ...authHeaders(), ...(init?.headers ?? {}) },
  });
  if (res.status === 401) throw new Unauthorized("Unauthorized: this page does not hold Coplan's current key. Reopen it with `coplan open`.");
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // The daemon's refusals are written for the reader; show them as they are.
    let message = body;
    try {
      message = (JSON.parse(body) as { error?: string }).error ?? body;
    } catch {
      /* not JSON */
    }
    throw new Error(message ? message.slice(0, 300) : `${res.status} ${res.statusText}`);
  }
  const type = res.headers.get('content-type') ?? '';
  return (type.includes('json') ? await res.json() : await res.text()) as T;
}

export const api = {
  sessions: () => request<{ sessions: SessionSummary[]; version: string }>('/api/sessions'),

  /** The session, how its repository counts each plan-check rule, and the
   *  repository's checks a task can skip. (What is wrong with the harness
   *  config it reads comes over the live stream, as `config-errors`.) */
  session: (id: string) =>
    request<{ session: SessionState; planCheck?: GapSeverities; projectChecks?: ProjectChecks; projectReview?: ReviewMode }>(`/api/session/${id}`),

  /** Permanent: the daemon removes the session's on-disk directory too. */
  deleteSession: (id: string) => request<{ deleted: boolean }>(`/api/session/${id}`, { method: 'DELETE' }),

  renameSession: (id: string, title: string) =>
    request<{ title: string }>(`/api/session/${id}/title`, { method: 'POST', body: JSON.stringify({ title }) }),

  /** Every edit the user makes goes through here, as a batch applied all or nothing. */
  ops: (id: string, ops: PlanOp[]) =>
    request<{ plan: Plan; changes: Change[] }>(`/api/session/${id}/plan/ops`, {
      method: 'POST',
      body: JSON.stringify({ ops }),
    }),

  /** The plan exactly as harness_plan_read returns it, as blocks that
   *  name their sources. Looking does not count as the agent reading it. */
  readback: (id: string) => request<{ text: string; blocks: Block[]; version: number }>(`/api/session/${id}/plan/readback`),

  /** One task's brief, exactly as harness_task_brief returns it, as blocks. */
  brief: (id: string, taskId: string) =>
    request<{ text: string; blocks: Block[]; task: { id: string; title: string }; version: number }>(`/api/session/${id}/task/${encodeURIComponent(taskId)}/brief`),

  /** The handoff the harness would be given if the plan were submitted now. */
  promptPreview: (id: string, note: string) =>
    request<PromptPreview>(`/api/session/${id}/plan/prompt`, { method: 'POST', body: JSON.stringify({ note }) }),

  /** Lock the plan and hand it over to be built. `expect` is the version
   *  the preview was made from; a plan that moved on since is refused. */
  submitPlan: (id: string, body: { note: string; expect: number; hash?: string }) =>
    request<{ plan: Plan }>(`/api/session/${id}/plan/submit`, { method: 'POST', body: JSON.stringify(body) }),

  /** The whole plan as Markdown, with no build instructions, as blocks.
   *  Any phase; it signs nothing off and changes nothing. */
  exportPlan: (id: string) => request<{ text: string; blocks: Block[]; version: number }>(`/api/session/${id}/plan/export`),

  reopenPlan: (id: string) => request<{ plan: Plan }>(`/api/session/${id}/plan/reopen`, { method: 'POST', body: '{}' }),

  /** The ask for a task list Claude would get if the design were confirmed now. */
  designPreview: (id: string, note: string) =>
    request<PromptPreview>(`/api/session/${id}/plan/design/prompt`, { method: 'POST', body: JSON.stringify({ note }) }),

  /** Lock the design; Claude makes the task list from it. */
  confirmDesign: (id: string, body: { note: string; expect: number; hash?: string }) =>
    request<{ plan: Plan }>(`/api/session/${id}/plan/design/confirm`, { method: 'POST', body: JSON.stringify(body) }),

  reopenDesign: (id: string) => request<{ plan: Plan }>(`/api/session/${id}/plan/design/reopen`, { method: 'POST', body: '{}' }),

  /** The request to revise the plan per the open comments, as the agent
   *  would get it now. Changes nothing. */
  revisionPreview: (id: string, note: string) =>
    request<PromptPreview & { threadIds: string[] }>(`/api/session/${id}/plan/revisions/prompt`, { method: 'POST', body: JSON.stringify({ note }) }),

  /** Queue it: it goes to the agent with the user's next message in chat. */
  queueRevision: (id: string, body: { note: string; expect: number; hash?: string }) =>
    request<{ plan: Plan }>(`/api/session/${id}/plan/revisions`, { method: 'POST', body: JSON.stringify(body) }),

  /** Take back a request not yet sent. */
  withdrawRevision: (id: string) => request<{ plan: Plan }>(`/api/session/${id}/plan/revisions/withdraw`, { method: 'POST', body: '{}' }),

  /* ---------------------- daemon-wide actions ---------------------- */

  storage: () => request<{ report: StorageReport }>('/api/storage'),

  cleanStorage: (groups: CleanupGroupId[]) =>
    request<{ result: CleanupOutcome; report: StorageReport }>('/api/storage/clean', {
      method: 'POST',
      body: JSON.stringify({ groups }),
    }),

  restartDaemon: () => request<{ restarting: boolean }>('/api/daemon/restart', { method: 'POST', body: '{}' }),

  /** Unauthenticated liveness; `pid` tells a successor from a survivor. */
  health: () => request<{ ok: boolean; version: string; pid: number }>('/health'),
};

/** The repository's checks by stage, for a task to skip (#54). */
export interface ProjectChecks {
  implement: string[];
  review: string[];
}

export interface PromptPreview {
  prompt: string;
  /** The prompt as blocks, each naming its source; joined, they are `prompt`. */
  blocks?: Block[];
  /** The plan was too long to quote whole; the prompt points Claude at harness_plan_read. */
  trimmed: boolean;
  /** The prompt's fingerprint, handed back at sign-off: a prompt that
   *  changed since this preview is refused rather than sent unread. */
  hash?: string;
  /** The plan version the prompt was built from. */
  version: number;
  /** The longest prompt a hook hands Claude. */
  budget: number;
  maxNote: number;
  /** What the repository's `.coplan/config.json` says. */
  project?: ProjectSummary;
}

export interface ProjectSummary {
  /** Where the config was read from; null when there is none. */
  file: string | null;
  /** The review a task asks for where it does not say. */
  review: ReviewMode;
  /** Check names per stage. */
  checks: Record<'implement' | 'review' | 'final', string[]>;
  errors: string[];
  /** How each plan-check rule counts here; `error` holds the sign-off. */
  planCheck?: GapSeverities;
  /** The config settings the prompt is made with, and where each is set. */
  config?: ConfigRow[];
}

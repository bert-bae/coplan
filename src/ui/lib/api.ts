import type {
  BuildSettings,
  BuildTarget,
  Change,
  ExecutionMode,
  CleanupGroupId,
  CleanupOutcome,
  Plan,
  PlanOp,
  SessionState,
  SessionSummary,
  StorageReport,
} from '../../shared/types.ts';
import type { GapSeverities } from '../../shared/check.ts';
import type { Block, ConfigRow } from '../../shared/blocks.ts';

/**
 * Client for the daemon.
 *
 * The auth token arrives in the link `coplan open` hands out. It is taken out
 * of the address bar, kept in localStorage, and sent as a header. Kept, so
 * the plain links the tools print — a new tab, a bookmark — work once the
 * page has been opened with the key, as they did with a cookie. Not a
 * cookie: a cookie is not scoped to a port, so every other server on
 * 127.0.0.1 would be handed it, and a browser sends one by itself; storage
 * belongs to this origin alone and is sent only by this code.
 */
const TOKEN_KEY = 'coplan.token';

function readToken(): string | null {
  try {
    const url = new URL(window.location.href);
    const fromLink = url.searchParams.get('token');
    if (fromLink) {
      url.searchParams.delete('token');
      window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
      try {
        window.localStorage.setItem(TOKEN_KEY, fromLink);
      } catch {
        /* private mode: kept in memory for this page */
      }
      return fromLink;
    }
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    /* no storage: nothing kept */
    return null;
  }
}

const token: string | null = typeof window === 'undefined' ? null : readToken();

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

  session: (id: string) => request<{ session: SessionState }>(`/api/session/${id}`),

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

  /** The prompt Claude would be given if the plan were submitted now.
   *  Without a mode or `settings`, the repository's defaults are used — and
   *  returned. Export mode returns the plan as Markdown. */
  promptPreview: (id: string, target: BuildTarget | null, note: string, settings?: BuildSettings, mode?: ExecutionMode) =>
    request<PromptPreview>(`/api/session/${id}/plan/prompt`, {
      method: 'POST',
      body: JSON.stringify({ ...(target ? { target } : {}), ...(mode ? { mode } : {}), note, ...(settings ? { settings } : {}) }),
    }),

  /** Lock the plan and hand it over to be built. `expect` is the version
   *  the preview was made from; a plan that moved on since is refused. */
  submitPlan: (id: string, body: { target: BuildTarget; mode?: ExecutionMode; note: string; expect: number; hash?: string; settings?: BuildSettings }) =>
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
  /** The mode the prompt was built for (the build prompt only). */
  mode?: ExecutionMode;
  /** The settings the prompt was built with (the build prompt only). */
  settings?: BuildSettings;
  /** What the repository's `.coplan/config.json` says. */
  project?: ProjectSummary;
}

export interface ProjectSummary {
  /** Where the config was read from; null when there is none. */
  file: string | null;
  /** The mode Submit starts from: the repository's default. */
  mode?: ExecutionMode;
  defaults: BuildSettings;
  /** Hook names per stage. */
  checks: Record<'implement' | 'review' | 'final', string[]>;
  errors: string[];
  /** How each plan-check rule counts here; `error` holds the sign-off. */
  planCheck?: GapSeverities;
  /** The config settings the prompt is made with, and where each is set. */
  config?: ConfigRow[];
}

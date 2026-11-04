import type {
  BuildTarget,
  Change,
  CleanupGroupId,
  CleanupOutcome,
  Plan,
  PlanOp,
  SessionState,
  SessionSummary,
  StorageReport,
} from '../../shared/types.ts';

/**
 * Client for the daemon.
 *
 * The auth token arrives once in the query string and is exchanged for a
 * cookie by the daemon, so requests here carry no credentials of their own.
 */

async function request<T>(route: string, init?: RequestInit): Promise<T> {
  const res = await fetch(route, {
    credentials: 'same-origin',
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
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

  /** The plan exactly as Claude reads it. */
  planText: (id: string) => request<string>(`/api/session/${id}/plan/text`),

  /** The prompt Claude would be given if the plan were submitted now. */
  promptPreview: (id: string, target: BuildTarget, note: string) =>
    request<PromptPreview>(`/api/session/${id}/plan/prompt`, {
      method: 'POST',
      body: JSON.stringify({ target, note }),
    }),

  /** Lock the plan and hand it over to be built. `expect` is the version
   *  the preview was made from; a plan that moved on since is refused. */
  submitPlan: (id: string, body: { target: BuildTarget; note: string; expect: number }) =>
    request<{ plan: Plan }>(`/api/session/${id}/plan/submit`, { method: 'POST', body: JSON.stringify(body) }),

  reopenPlan: (id: string) => request<{ plan: Plan }>(`/api/session/${id}/plan/reopen`, { method: 'POST', body: '{}' }),

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
  /** The plan was too long to quote whole; the prompt points Claude at harness_plan_read. */
  trimmed: boolean;
  /** The plan version the prompt was built from. */
  version: number;
  /** The longest prompt a hook hands Claude. */
  budget: number;
  maxNote: number;
}

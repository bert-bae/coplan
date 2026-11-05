import type {
  BuildSettings,
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

  /** The prompt Claude would be given if the plan were submitted now.
   *  Without `settings`, the repository's defaults are used — and returned. */
  promptPreview: (id: string, target: BuildTarget, note: string, settings?: BuildSettings) =>
    request<PromptPreview>(`/api/session/${id}/plan/prompt`, {
      method: 'POST',
      body: JSON.stringify({ target, note, ...(settings ? { settings } : {}) }),
    }),

  /** Lock the plan and hand it over to be built. `expect` is the version
   *  the preview was made from; a plan that moved on since is refused. */
  submitPlan: (id: string, body: { target: BuildTarget; note: string; expect: number; hash?: string; settings?: BuildSettings }) =>
    request<{ plan: Plan }>(`/api/session/${id}/plan/submit`, { method: 'POST', body: JSON.stringify(body) }),

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
  /** The settings the prompt was built with (the build prompt only). */
  settings?: BuildSettings;
  /** What the repository's `.coplan/config.json` says. */
  project?: ProjectSummary;
}

export interface ProjectSummary {
  /** Where the config was read from; null when there is none. */
  file: string | null;
  defaults: BuildSettings;
  /** Hook names per stage. */
  checks: Record<'implement' | 'review' | 'final', string[]>;
  errors: string[];
}

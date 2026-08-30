import type {
  CleanupGroupId,
  CleanupOutcome,
  DiffPayload,
  GateResult,
  PlanStep,
  ReviewThread,
  SessionState,
  SessionSummary,
  ShipState,
  StorageReport,
  Task,
  TaskStatus,
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
    throw new Error(`${res.status} ${res.statusText}${body ? `: ${body.slice(0, 200)}` : ''}`);
  }
  return (await res.json()) as T;
}

export const api = {
  sessions: () => request<{ sessions: SessionSummary[]; version: string }>('/api/sessions'),

  session: (id: string) => request<{ session: SessionState; diff: DiffPayload | null }>(`/api/session/${id}`),

  /** Permanent: the daemon removes the session's on-disk directory too. */
  deleteSession: (id: string) =>
    request<{ deleted: boolean }>(`/api/session/${id}`, { method: 'DELETE' }),

  renameSession: (id: string, title: string) =>
    request<{ title: string }>(`/api/session/${id}/title`, {
      method: 'POST',
      body: JSON.stringify({ title }),
    }),

  diff: (id: string, refresh = false) =>
    request<{ diff: DiffPayload }>(`/api/session/${id}/diff${refresh ? '?refresh=1' : ''}`),

  resolveGate: (
    id: string,
    gateId: string,
    body: {
      verdict: GateResult['verdict'];
      comment?: string;
      steps?: PlanStep[];
      threads?: ReviewThread[];
      ship?: GateResult['ship'];
      answers?: Record<string, string>;
    },
  ) =>
    request<{ gate: unknown }>(`/api/session/${id}/gate/${gateId}/resolve`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  feedback: (id: string, body: { text: string; origin?: string; threads?: ReviewThread[] }) =>
    request<{ item: unknown; delivery: string }>(`/api/session/${id}/feedback`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  saveThreads: (id: string, threads: ReviewThread[]) =>
    request<{ threads: ReviewThread[] }>(`/api/session/${id}/threads`, {
      method: 'POST',
      body: JSON.stringify({ threads }),
    }),

  updateTask: (id: string, taskId: string, patch: { status?: TaskStatus; title?: string; detail?: string }) =>
    request<{ task: Task }>(`/api/session/${id}/tasks/${taskId}`, {
      method: 'POST',
      body: JSON.stringify(patch),
    }),

  reorderTasks: (id: string, ids: string[]) =>
    request<{ tasks: Task[] }>(`/api/session/${id}/tasks/reorder`, {
      method: 'POST',
      body: JSON.stringify({ ids }),
    }),

  replyToThread: (id: string, threadId: string, text: string) =>
    request<{ thread: ReviewThread }>(`/api/session/${id}/thread/${threadId}/reply`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),

  resolveThread: (id: string, threadId: string, resolved: boolean) =>
    request<{ thread: ReviewThread }>(`/api/session/${id}/thread/${threadId}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ resolved }),
    }),

  addCheck: (id: string, command: string) =>
    request<{ check: unknown }>(`/api/session/${id}/checks`, {
      method: 'POST',
      body: JSON.stringify({ command }),
    }),

  runChecks: (id: string, checkId?: string) =>
    request<{ started: boolean }>(`/api/session/${id}/checks/run`, {
      method: 'POST',
      body: JSON.stringify(checkId ? { checkId } : {}),
    }),

  cancelCheck: (id: string, checkId: string) =>
    request<{ cancelled: boolean }>(`/api/session/${id}/checks/cancel`, {
      method: 'POST',
      body: JSON.stringify({ checkId }),
    }),

  shipPreview: (id: string) =>
    request<{ ship: ShipState; providers: { id: string; kind: string; label: string }[] }>(
      `/api/session/${id}/ship`,
    ),

  executeShip: (id: string, ship: ShipState) =>
    request<{ ok: boolean; output: string; url?: string; summaryPath?: string; directive?: string }>(
      `/api/session/${id}/ship`,
      { method: 'POST', body: JSON.stringify({ ship }) },
    ),

  /* ---------------------- daemon-wide actions ---------------------- */

  storage: () => request<{ report: StorageReport }>('/api/storage'),

  cleanStorage: (groups: CleanupGroupId[]) =>
    request<{ result: CleanupOutcome; report: StorageReport }>('/api/storage/clean', {
      method: 'POST',
      body: JSON.stringify({ groups }),
    }),

  restartDaemon: () =>
    request<{ restarting: boolean; interrupted: string[] }>('/api/daemon/restart', {
      method: 'POST',
      body: '{}',
    }),

  /** Unauthenticated liveness, used to watch a restart complete. `pid`
   *  identifies the process, so a caller can tell a survivor from a
   *  successor rather than only knowing that something answered. */
  health: () => request<{ ok: boolean; version: string; pid: number }>('/health'),
};

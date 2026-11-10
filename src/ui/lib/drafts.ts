/**
 * Markdown editors open with text, by session and field (`<session>:summary`,
 * `:section:<id>`, `:task:<id>:detail`, `:caption:<diagram>`,
 * `:notes:<diagram>/<box>`). An editor that
 * unmounts (a tab or a session switch) reopens with its draft and what it
 * started from, and closing the page asks first while any holds unsaved
 * text. In memory only: a reload starts afresh, as the page does.
 */
export interface OpenDraft {
  draft: string;
  /** What editing started from, for the "changed while you were editing" warning. */
  version: number | undefined;
  value: string;
}

import { isDesignLocked, isLocked } from '../../shared/plan.ts';
import type { Plan } from '../../shared/types.ts';

export const openDrafts = new Map<string, OpenDraft>();

/** Whether any open editor holds text not saved yet. */
export function unsavedDrafts(): boolean {
  for (const d of openDrafts.values()) if (d.draft !== d.value) return true;
  return false;
}

/**
 * A session's plan, as it lands: its drafts that can no longer be saved, or
 * have nothing left to lose, go. That is a field that is gone, one that is
 * locked now, or one that holds the draft's text already (a save that
 * finished after its editor closed, say). With no plan (the session was
 * deleted), all of them go.
 */
export function pruneDrafts(sessionId: string, plan: Plan | null): void {
  const prefix = `${sessionId}:`;
  for (const [key, open] of openDrafts) {
    if (!key.startsWith(prefix)) continue;
    const now = plan ? fieldText(plan, key.slice(prefix.length)) : undefined;
    if (now === undefined || now === open.draft) openDrafts.delete(key);
  }
}

/** A field's text now: undefined when it is gone, or locked. */
function fieldText(plan: Plan, field: string): string | undefined {
  const design = isDesignLocked(plan);
  if (field === 'summary') return design ? undefined : plan.summary;
  let m = /^section:(.+)$/.exec(field);
  if (m) return design ? undefined : plan.sections.find((s) => s.id === m![1])?.body;
  m = /^task:(.+):detail$/.exec(field);
  if (m) {
    const task = plan.tasks.find((t) => t.id === m![1]);
    return task && !isLocked(plan) ? (task.detail ?? '') : undefined;
  }
  m = /^caption:(.+)$/.exec(field);
  if (m) {
    const diagram = plan.diagrams.find((d) => d.id === m![1]);
    return diagram && !design ? (diagram.caption ?? '') : undefined;
  }
  m = /^notes:([^/]+)\/(.+)$/.exec(field);
  if (m) {
    const node = plan.diagrams.find((d) => d.id === m![1])?.nodes.find((n) => n.id === m![2]);
    return node && !design ? (node.notes ?? '') : undefined;
  }
  return undefined;
}

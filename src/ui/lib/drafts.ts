/**
 * Editors open with text, by session and field (`<session>:summary`,
 * `:section:<id>`, `:task:<id>:detail`, `:task:<id>:files`,
 * `:caption:<diagram>`, `:notes:<diagram>/<box>`), and comments being
 * written (`:comment:<kind>:<id>`, `:reply:<thread>`). An editor that
 * unmounts (a tab or a session switch, another box selected) reopens with
 * its draft and what it started from, and closing the page asks first while
 * any holds unsaved text. In memory only: a reload starts afresh, as the
 * page does.
 */
export interface OpenDraft {
  draft: string;
  /** What editing started from, for the "changed while you were editing" warning. */
  version: number | undefined;
  value: string;
}

import { isDesignLocked, isLocked, targetExists } from '../../shared/plan.ts';
import type { Plan, TargetKind } from '../../shared/types.ts';

export const openDrafts = new Map<string, OpenDraft>();

/** A kept draft's key: the session it was written in, and its field. */
export function draftKey(sessionId: string | null, field: string): string {
  return `${sessionId ?? ''}:${field}`;
}

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

/** Which of the plan's sign-offs hold its fields still. */
interface Locks {
  design: boolean;
  plan: boolean;
}

/** A field's text now: undefined when it is gone, or locked (as the plan
 *  is, or as it would be with `locks`). */
function fieldText(plan: Plan, field: string, locks: Locks = { design: isDesignLocked(plan), plan: isLocked(plan) }): string | undefined {
  const design = locks.design;
  if (field === 'summary') return design ? undefined : plan.summary;
  let m = /^section:(.+)$/.exec(field);
  if (m) return design ? undefined : plan.sections.find((s) => s.id === m![1])?.body;
  m = /^task:(.+):(detail|files)$/.exec(field);
  if (m) {
    const task = plan.tasks.find((t) => t.id === m![1]);
    if (!task || locks.plan) return undefined;
    return m[2] === 'detail' ? (task.detail ?? '') : (task.files ?? []).join('\n');
  }
  // A comment is saved only once sent: until then the field holds nothing.
  // It goes with what it is on; a reply, with its thread, or once resolved.
  m = /^comment:([^:]+):(.*)$/.exec(field);
  if (m) return targetExists(plan, { kind: m[1] as TargetKind, id: m[2]! }) ? '' : undefined;
  m = /^reply:(.+)$/.exec(field);
  if (m) return plan.threads.some((t) => t.id === m![1] && !t.resolved) ? '' : undefined;
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

/**
 * What a sign-off would drop: the session's fields holding text not saved
 * that its lock would hold still, named for the user. Once the plan is
 * locked, pruneDrafts lets them go, and their text was never in the prompt.
 */
export function draftsLockedBy(sessionId: string | null, plan: Plan, signOff: 'design' | 'plan'): string[] {
  const prefix = draftKey(sessionId, '');
  const locks = { design: true, plan: signOff === 'plan' };
  const out: string[] = [];
  for (const [key, open] of openDrafts) {
    if (!key.startsWith(prefix) || open.draft === open.value) continue;
    const field = key.slice(prefix.length);
    if (fieldText(plan, field) !== undefined && fieldText(plan, field, locks) === undefined) out.push(fieldName(plan, field));
  }
  return out;
}

/** A kept field, as the user would look for it. */
function fieldName(plan: Plan, field: string): string {
  if (field === 'summary') return 'the summary';
  const [kind, id] = [field.slice(0, field.indexOf(':')), field.slice(field.indexOf(':') + 1)];
  if (kind === 'section') return `section "${plan.sections.find((s) => s.id === id)?.title ?? id}"`;
  if (kind === 'caption') return `the caption of "${plan.diagrams.find((d) => d.id === id)?.title ?? id}"`;
  if (kind === 'notes') {
    const [did, nid] = [id.slice(0, id.indexOf('/')), id.slice(id.indexOf('/') + 1)];
    return `the notes on box "${plan.diagrams.find((d) => d.id === did)?.nodes.find((n) => n.id === nid)?.label ?? nid}"`;
  }
  const task = /^(.+):(detail|files)$/.exec(id);
  return task ? `the ${task[2]} of task "${plan.tasks.find((t) => t.id === task[1])?.title ?? task[1]}"` : field;
}

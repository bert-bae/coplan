import { useEffect, useRef, useState } from 'react';
import { describeTarget, isDesignLocked, isLocked, targetExists } from '../../shared/plan.ts';
import { DEFAULT_BUILD_SETTINGS, effectiveReview, roundVerdict } from '../../shared/build.ts';
import type { Plan, TargetKind } from '../../shared/types.ts';

/**
 * Editors open with text, by session and field (`<session>:summary`,
 * `:section:<id>`, `:task:<id>:detail`, `:task:<id>:files`,
 * `:caption:<diagram>`, `:notes:<diagram>/<box>`), and comments being
 * written (`:comment:<kind>:<id>`, `:reply:<thread>`), and a change request
 * on a task in the user's review (`:review:<task>:<round>`). An editor that
 * unmounts (a tab or a session switch, another box selected) reopens with
 * its draft and what it started from, and closing the page asks first while
 * any holds unsaved text. In memory only: a reload starts afresh, as the
 * page does.
 */
export interface OpenDraft extends Started {
  draft: string;
}

/** What editing started from, for the "changed while you were editing"
 *  warning: the field's revision, and its text. */
interface Started {
  version: number | undefined;
  value: string;
}

export const openDrafts = new Map<string, OpenDraft>();

/** The editors open now, by draft key: told when a lock takes their field,
 *  so what was written does not stay on screen untracked. */
const holders = new Map<string, () => void>();

/** A kept draft's key: the session it was written in, and its field. */
function draftKey(sessionId: string | null, field: string): string {
  return `${sessionId ?? ''}:${field}`;
}

/** The draft kept for `field` in `sessionId`, if one is. */
export function keptDraft(sessionId: string | null, field: string): OpenDraft | undefined {
  return openDrafts.get(draftKey(sessionId, field));
}

/** Inline fields holding text refused as changed underneath (Editable's
 *  InlineText): not kept drafts, but text not saved all the same. Each with
 *  its session, its name, and the sign-off that locks it. */
export const refusedFields = new Map<object, { sessionId: string | null; name: string; lockedBy: 'design' | 'plan' }>();

/** Whether any open editor holds text not saved yet. */
export function unsavedDrafts(): boolean {
  if (refusedFields.size) return true;
  for (const d of openDrafts.values()) if (d.draft !== d.value) return true;
  return false;
}

/**
 * A session's plan, as it lands: its drafts that can no longer be saved, or
 * have nothing left to lose, go. That is a field that is gone, one that is
 * locked now, or one that holds the draft's text already (a save that
 * finished after its editor closed, an editor opened and not typed in).
 * An editor still open whose field a lock takes is told, kept or not.
 * With no plan (the session was deleted), all of them go. Returns those
 * that held unsaved text a lock took the field from (a sign-off made in
 * chat, say), named, for the user to be told, and to copy.
 */
export function pruneDrafts(sessionId: string, plan: Plan | null): { name: string; text: string }[] {
  const prefix = `${sessionId}:`;
  const locked: { name: string; text: string }[] = [];
  const locks = plan ? { design: isDesignLocked(plan), plan: isLocked(plan) } : null;
  const told = new Set<string>();
  for (const [key, open] of openDrafts) {
    if (!key.startsWith(prefix)) continue;
    const field = key.slice(prefix.length);
    // The field as it is, and whether the plan's sign-offs hold it still.
    const text = plan ? fieldText(plan, field, { design: false, plan: false }) : undefined;
    const held = text !== undefined && fieldText(plan!, field, locks!) === undefined;
    if (text !== undefined && !held && text !== open.draft) continue;
    openDrafts.delete(key);
    if (held) {
      holders.get(key)?.();
      told.add(key);
    }
    // Held, with text not saved (nor saved in the same plan as the lock).
    if (held && open.draft !== open.value && open.draft !== text) locked.push({ name: fieldName(plan!, field), text: open.draft });
  }
  // One open with nothing typed was let go at an earlier plan (above), so
  // is not kept: the lock that takes its field tells it too.
  if (plan) {
    for (const [key, drop] of holders) {
      if (!key.startsWith(prefix) || told.has(key) || openDrafts.has(key)) continue;
      const field = key.slice(prefix.length);
      if (fieldText(plan, field, { design: false, plan: false }) !== undefined && fieldText(plan, field, locks!) === undefined) drop();
    }
  }
  return locked;
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
    return m[2] === 'detail' ? (task.detail ?? '') : filesText(task.files);
  }
  // A comment is saved only once sent: until then the field holds nothing.
  // It goes with what it is on; a reply, with its thread (a resolved one
  // still takes replies).
  // Comments are open until the plan is submitted: a submitted plan takes none.
  m = /^comment:([^:]+):(.*)$/.exec(field);
  if (m) return !locks.plan && targetExists(plan, { kind: m[1] as TargetKind, id: m[2]! }) ? '' : undefined;
  m = /^reply:(.+)$/.exec(field);
  if (m) return !locks.plan && plan.threads.some((t) => t.id === m![1]) ? '' : undefined;
  // A change request to a task in the user's review: open while that round
  // waits on their verdict, whatever the locks (the plan is submitted by then).
  m = /^review:(.+):(\d+)$/.exec(field);
  if (m) {
    const task = plan.tasks.find((t) => t.id === m![1]);
    const mode = task && effectiveReview(plan, task, plan.submission?.settings?.review ?? DEFAULT_BUILD_SETTINGS.review);
    return task?.stage === 'review' && String(task.round) === m[2] && mode === 'user' && !roundVerdict(task, 'user') ? '' : undefined;
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
  for (const held of refusedFields.values()) {
    if (held.sessionId === sessionId && (signOff === 'plan' || held.lockedBy === 'design')) out.push(held.name);
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
  if (kind === 'comment') {
    const [on, at] = [id.slice(0, id.indexOf(':')), id.slice(id.indexOf(':') + 1)];
    return `the comment on ${describeTarget(plan, { kind: on as TargetKind, id: at })}`;
  }
  if (kind === 'reply') {
    const thread = plan.threads.find((t) => t.id === id);
    return thread ? `the reply on ${describeTarget(plan, thread.target)}` : 'a reply';
  }
  const task = /^(.+):(detail|files)$/.exec(id);
  return task ? `the ${task[2]} of task "${plan.tasks.find((t) => t.id === task[1])?.title ?? task[1]}"` : field;
}

/** A task's files as its field holds them: one path a line. */
export function filesText(files: string[] | undefined): string {
  return (files ?? []).join('\n');
}

/**
 * An editor's draft, kept among the open drafts while it is open: its view
 * going (a tab or session switch, another box selected) reopens it with
 * its text and where it started, and closing the page asks first. `field`
 * names it (null: not kept), in `sessionId` (useSessionId); `value` and
 * `version` are the field as it is now. A comment being written is one
 * too, with nothing saved (`value` ''): `openAtFirst`, its box is always
 * there.
 */
export function useKeptDraft(sessionId: string | null, field: string | null, value: string, version: number | undefined, openAtFirst = false) {
  const [key] = useState(() => (field ? draftKey(sessionId, field) : null));
  const [kept] = useState(() => (key ? openDrafts.get(key) : undefined));
  const [editing, setEditing] = useState(openAtFirst || Boolean(kept));
  const [draft, setDraft] = useState(kept?.draft ?? value);
  const [started, setStarted] = useState<Started>(() => (kept ? { version: kept.version, value: kept.value } : { version, value }));
  const [saving, setSaving] = useState(false);
  // The field as it is on screen now, for a save's answer that lands later.
  const now = useRef<Started>({ version, value });
  now.current = { version, value };
  useEffect(() => {
    if (!key) return;
    if (editing) openDrafts.set(key, { draft, ...started });
    else openDrafts.delete(key);
  }, [key, editing, draft, started]);
  // A lock that takes the field takes what was written (pruneDrafts offers
  // it to copy): the field opens afresh once it is free again.
  useEffect(() => {
    if (!key || !editing) return;
    const drop = () => {
      setDraft(now.current.value);
      setEditing(openAtFirst);
    };
    holders.set(key, drop);
    return () => {
      if (holders.get(key) === drop) holders.delete(key);
    };
  }, [key, openAtFirst, editing]);
  const close = () => setEditing(false);
  return {
    editing,
    draft,
    setDraft,
    started,
    saving,
    /** Open it on the field as it is now. */
    begin: () => {
      setStarted(now.current);
      setDraft(now.current.value);
      setEditing(true);
    },
    close,
    /**
     * Save it with `send`, unless it is the field's text already; resolves
     * whether it went in. Saved: closed, and gone from the kept drafts even
     * if the editor closed meanwhile. Refused (`send` resolved false, most
     * likely changed underneath): the text stays, and starts again from the
     * field as it is now, so a deliberate second save goes in — unless it
     * was closed meanwhile.
     */
    save: async (send: () => unknown): Promise<boolean> => {
      if (draft === now.current.value) {
        close();
        return true;
      }
      setSaving(true);
      const result = await send();
      setSaving(false);
      if (result !== false) {
        if (key) openDrafts.delete(key);
        close();
        return true;
      }
      setStarted(now.current);
      const open = key ? openDrafts.get(key) : undefined;
      if (key && open) openDrafts.set(key, { ...open, ...now.current });
      return false;
    },
  };
}

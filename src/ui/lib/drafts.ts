import { useEffect, useRef, useState } from 'react';
import { describeTarget, isDesignLocked, isLocked, targetExists } from '../../shared/plan.ts';
import { DEFAULT_BUILD_SETTINGS, effectiveReview, roundVerdict } from '../../shared/build.ts';
import type { Plan, ReviewMode, TargetKind } from '../../shared/types.ts';

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
  /** Saved while its editor was off screen, with more typed: `value` is
   *  the text that save put in. Next drawn, it starts from the field if the
   *  field still holds that; if someone changed it since, from the save,
   *  so the change is warned of. */
  restart?: boolean;
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

/** Kept drafts being saved now: a plan that lands meanwhile may be their
 *  own save's, so what they hold is not lost. */
const sending = new Set<string>();
/** How a send went, told to the editors of its draft that did not make it
 *  (drawn anew while it was out: its card moved): they wait on it, then
 *  close on its text sent (`text`), or start again from the field if it was
 *  refused, or if they hold more than was sent (typed while it was out). */
type SendNews = 'sending' | 'sent' | 'refused';
type SendWatcher = (news: SendNews, text: string) => void;
const sendWatchers = new Map<string, Set<SendWatcher>>();
function tellSend(key: string, news: SendNews, from: SendWatcher, text: string): void {
  if (news === 'sending') sending.add(key);
  else sending.delete(key);
  for (const watch of sendWatchers.get(key) ?? []) if (watch !== from) watch(news, text);
}
/** Of those, change requests a plan landing let go (their round no longer
 *  waits on the user) while being sent: offered if the send is refused, or,
 *  sent, if they hold more than went. */
const letGoWhileSending = new Map<string, DroppedDraft>();
let offerDropped: ((sessionId: string | null, dropped: DroppedDraft) => void) | null = null;
/** Where a draft let go while being sent is offered (the store's copy
 *  toast): refused, or sent holding more than went. */
export function onDroppedAfterSend(offer: (sessionId: string | null, dropped: DroppedDraft) => void): void {
  offerDropped = offer;
}

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
  if (refusedFields.size || letGoWhileSending.size) return true;
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
 * chat, say), or a change request whose round no longer waits on the user,
 * named, for the user to be told, and to copy.
 */
export function pruneDrafts(sessionId: string, plan: Plan | null, projectReview: ReviewMode = DEFAULT_BUILD_SETTINGS.review): DroppedDraft[] {
  const prefix = `${sessionId}:`;
  const locked: DroppedDraft[] = [];
  const locks = plan ? { design: isDesignLocked(plan), plan: isLocked(plan) } : null;
  const told = new Set<string>();
  for (const [key, open] of openDrafts) {
    if (!key.startsWith(prefix)) continue;
    const field = key.slice(prefix.length);
    // The field as it is, and whether the plan's sign-offs hold it still.
    const text = plan ? fieldText(plan, field, { design: false, plan: false }, projectReview) : undefined;
    const held = text !== undefined && fieldText(plan!, field, locks!, projectReview) === undefined;
    if (text !== undefined && !held && text !== open.draft) continue;
    openDrafts.delete(key);
    if (held) {
      holders.get(key)?.();
      told.add(key);
    }
    // Held, with text not saved (nor saved in the same plan as the lock).
    if (held && open.draft !== open.value && open.draft !== text) locked.push({ name: fieldName(plan!, field), text: open.draft, why: 'locked' });
    // A change request whose round no longer waits on the user (the agent
    // took the task back, or a verdict came in chat): its box is gone. One
    // being sent waits on its answer (its own verdict may land first): it
    // is offered only if the send is refused (save).
    const review = /^review:(.+):(\d+)$/.exec(field);
    if (review && plan && text === undefined && open.draft.trim()) {
      const title = plan.tasks.find((t) => t.id === review[1])?.title;
      const on = title === undefined ? 'a task since removed' : `task "${title}"`;
      const dropped: DroppedDraft = { name: `your change request on ${on} (round ${review[2]})`, text: open.draft, why: 'review' };
      if (sending.has(key)) letGoWhileSending.set(key, dropped);
      else locked.push(dropped);
    }
  }
  // One open with nothing typed was let go at an earlier plan (above), so
  // is not kept: the lock that takes its field tells it too.
  if (plan) {
    for (const [key, drop] of holders) {
      if (!key.startsWith(prefix) || told.has(key) || openDrafts.has(key)) continue;
      const field = key.slice(prefix.length);
      if (fieldText(plan, field, { design: false, plan: false }, projectReview) !== undefined && fieldText(plan, field, locks!, projectReview) === undefined) drop();
    }
  }
  return locked;
}

/** Unsaved text a plan landing took the field of: a sign-off's lock, or a
 *  review round that no longer waits on the user. */
export interface DroppedDraft {
  name: string;
  text: string;
  why: 'locked' | 'review' | 'added';
}

/** Which of the plan's sign-offs hold its fields still. */
interface Locks {
  design: boolean;
  plan: boolean;
}

/** A field's text now: undefined when it is gone, or locked (as the plan
 *  is, or as it would be with `locks`). */
function fieldText(
  plan: Plan,
  field: string,
  locks: Locks = { design: isDesignLocked(plan), plan: isLocked(plan) },
  /** The project's review mode, where the plan holds none. */
  review: ReviewMode = DEFAULT_BUILD_SETTINGS.review,
): string | undefined {
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
    const mode = task && effectiveReview(plan, task, plan.submission?.settings?.review ?? review);
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

/** A reply or a comment adds to what is there, rather than replacing it. */
const addsTo = (field: string | null): boolean => field !== null && /^(reply|comment):/.test(field);

/** What a draft still holds once `sent` has gone: for a field that adds,
 *  what came after it; for any other, all of it (the next save replaces). */
function afterSent(field: string | null, draft: string, sent: string): string {
  return addsTo(field) && draft.startsWith(sent) ? draft.slice(sent.length).replace(/^\s+/, '') : draft;
}

/**
 * An editor's draft, kept among the open drafts while it is open: its view
 * going (a tab or session switch, another box selected) reopens it with
 * its text and where it started, and closing the page asks first. `field`
 * names it (null: not kept), in `sessionId` (useSessionId); `value` and
 * `version` are the field as it is now. A comment being written is one
 * too, with nothing saved (`value` ''): `openAtFirst`, its box is always
 * there. `field` is read once, at mount: a caller whose field changes while
 * it is on screen draws it anew (a React key), as UserReview does by round.
 */
export function useKeptDraft(sessionId: string | null, field: string | null, value: string, version: number | undefined, openAtFirst = false) {
  const [key] = useState(() => (field ? draftKey(sessionId, field) : null));
  // The session it was kept in, as its key is: fixed at mount.
  const [keySession] = useState(sessionId);
  const [kept] = useState(() => (key ? openDrafts.get(key) : undefined));
  const [editing, setEditing] = useState(openAtFirst || Boolean(kept));
  const [draft, setDraft] = useState(kept?.draft ?? value);
  const [started, setStarted] = useState<Started>(() =>
    // (Compared trimmed: the daemon trims what it saves.)
    kept && !(kept.restart && value.trim() === kept.value.trim()) ? { version: kept.version, value: kept.value } : { version, value },
  );
  const [saving, setSaving] = useState(false);
  // Its draft being sent from an editor drawn before this one, and how that
  // went (tellSend).
  const [sentElsewhere, setSentElsewhere] = useState(() => (key ? sending.has(key) : false));
  const watchRef = useRef<SendWatcher>(() => {});
  const draftNow = useRef(draft);
  draftNow.current = draft;
  // Whether this editor is still drawn: a save that lands after it went
  // goes by the kept draft, which an editor drawn anew since has kept up.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  watchRef.current = (news, text) => {
    setSentElsewhere(news === 'sending');
    // Sent, and its box gone with its round (parked): closed, whatever it
    // holds; what was added while it went is offered by the sender (save).
    const parked = news === 'sent' && key !== null && letGoWhileSending.has(key);
    if (news === 'sent' && (draftNow.current.trim() === text.trim() || (addsTo(field) && !draftNow.current.trim()) || parked)) {
      setDraft(now.current.value);
      setEditing(openAtFirst);
    } else if (news !== 'sending') {
      // Sent, and typed on here (an editor drawn anew while it went): a reply
      // or a comment keeps only what came after, as the sender's own does.
      if (news === 'sent') {
        const rest = afterSent(field, draftNow.current, text);
        if (rest !== draftNow.current) setDraft(rest);
      }
      setStarted(now.current);
    }
  };
  const watch = useRef<SendWatcher>((news, text) => watchRef.current(news, text)).current;
  useEffect(() => {
    if (!key) return;
    const watchers = sendWatchers.get(key) ?? new Set();
    sendWatchers.set(key, watchers);
    watchers.add(watch);
    setSentElsewhere(sending.has(key));
    return () => {
      watchers.delete(watch);
      if (!watchers.size) sendWatchers.delete(key);
    };
  }, [key, watch]);
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
    saving: saving || sentElsewhere,
    /** Open it on the field as it is now. */
    begin: () => {
      setStarted(now.current);
      setDraft(now.current.value);
      setEditing(true);
    },
    close,
    /**
     * Save it with `send`, unless it is the field's text already; resolves
     * whether it went in. Saved: back to how it opens (closed; a comment
     * composer open and empty), and gone from the kept drafts even if the
     * editor closed meanwhile; unless more was typed while it went, which
     * stays open (a reply or comment: only what came after). Refused (`send` resolved false, most
     * likely changed underneath): the text stays, and starts again from the
     * field as it is now, so a deliberate second save goes in — unless it
     * was closed meanwhile.
     */
    save: async (send: () => unknown): Promise<boolean> => {
      if (draft === now.current.value) {
        close();
        return true;
      }
      // On its way already, from this editor or one drawn before it.
      if (key && sending.has(key)) return false;
      setSaving(true);
      const sent = draft;
      if (key) tellSend(key, 'sending', watch, sent);
      let result: unknown = false;
      let letGo: DroppedDraft | undefined;
      try {
        result = await send();
      } finally {
        if (key) {
          tellSend(key, result === false ? 'refused' : 'sent', watch, sent);
          letGo = letGoWhileSending.get(key);
          letGoWhileSending.delete(key);
        }
        setSaving(false);
        // Thrown, once its field had gone: offered all the same.
        if (result === false && letGo) offerDropped?.(keySession, letGo);
      }
      // Sent, its field gone with it (a change request that decided its
      // round): what was added while it went (in this box or one drawn anew,
      // on screen or not) is offered, not left on no screen.
      if (result !== false && letGo) {
        if (letGo.text.trim() && letGo.text.trim() !== sent.trim()) offerDropped?.(keySession, { ...letGo, why: 'added' });
        openDrafts.delete(key!);
      }
      // Refused once its field had gone (a change request whose round
      // stopped waiting as it was sent): offered now, and closed.
      if (result === false && letGo) {
        openDrafts.delete(key!);
        close();
        return false;
      }
      if (result !== false) {
        // More typed here while it went: kept open on it, starting again
        // from the field as it is now (the save in). A reply or a comment
        // adds rather than replaces, so it keeps only what came after what
        // was sent; a field keeps all of it, which the next save replaces.
        // (Its editor gone: the kept draft holds what was typed since, and
        // none kept is nothing typed — closed, or cleared, meanwhile.)
        const typed = mounted.current ? draftNow.current : ((key ? openDrafts.get(key)?.draft : undefined) ?? '');
        if (typed.trim() && typed.trim() !== sent.trim() && !letGo) {
          const adds = addsTo(field);
          const rest = afterSent(field, typed, sent);
          if (mounted.current && rest !== draftNow.current) setDraft(rest);
          setStarted(now.current);
          // Kept so too, for an editor off screen meanwhile: it cannot see
          // the field now, so it starts from it when next drawn (one that
          // adds: its field holds nothing still).
          const open = key ? openDrafts.get(key) : undefined;
          if (key && open) {
            openDrafts.set(key, adds ? { ...open, draft: rest, ...now.current } : { ...open, draft: rest, version: now.current.version, value: sent, restart: true });
          }
          return true;
        }
        // Gone from the kept drafts, unless an editor drawn anew meanwhile
        // (since let go) holds more than was sent.
        // (Or cleared while it went: nothing there to keep.)
        const keptNow = key ? openDrafts.get(key) : undefined;
        if (key && keptNow && (keptNow.draft.trim() === sent.trim() || !keptNow.draft.trim())) openDrafts.delete(key);
        // Kept with more, though this editor is still drawn: only another copy
        // of the box, typed on while this one sent, could do that. None is
        // drawn today (never reached in the tests); kept as a guard, so such a
        // copy would keep what came after rather than post the reply twice.
        else if (key && keptNow && addsTo(field)) openDrafts.set(key, { ...keptNow, draft: afterSent(field, keptNow.draft, sent) });
        // Back to how it opens: closed, or (a comment composer) open, empty.
        setEditing(openAtFirst);
        return true;
      }
      setStarted(now.current);
      const open = key ? openDrafts.get(key) : undefined;
      if (key && open) openDrafts.set(key, { ...open, ...now.current });
      return false;
    },
  };
}

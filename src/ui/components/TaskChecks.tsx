import { useEffect, useMemo, useState } from 'react';
import { store, useAgent, useStore } from '../store.ts';
import type { ProjectSummary } from '../lib/api.ts';
import { classNames } from '../lib/format.ts';
import { inheritedChecks, ownCheckWords, skipWords } from '../../shared/build.ts';
import { TASK_CHECK_STAGES, type Plan, type Task, type TaskCheck, type TaskCheckStage } from '../../shared/types.ts';

/**
 * A task's checks: the repository's that it runs, the ones the user skipped
 * on it, and its own. Only here does a skip get set — the agent can propose
 * one, never make one — so the gate a task is held to is the user's call.
 */

/** The repository's checks for a session, from the store's one request
 *  for them (see `store.project`). */
function useProject(): ProjectSummary | null | undefined {
  const sessionId = useStore((s) => s.sessionId);
  // Undefined until the first answer, so a preview waits for it rather than
  // being worked out twice.
  const [project, setProject] = useState<ProjectSummary | null | undefined>(undefined);
  useEffect(() => {
    if (!sessionId) return;
    let live = true;
    const read = () => void store.project(sessionId).then((p) => live && setProject(p));
    read();
    // Asked again now and then — the store answers from its copy until it is
    // half a minute old — so an edit to .coplan/config.json shows.
    const timer = window.setInterval(read, 30_000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [sessionId]);
  return project;
}

/** The repository's check names (every stage), as the daemon refuses them
 *  for a task's own: for previews that must match what accepting does. */
export function useReservedNames(): string[] | undefined {
  const project = useProject();
  return useMemo(
    () => (project === undefined ? undefined : project ? [...new Set([...project.checks.implement, ...project.checks.review, ...project.checks.final])] : []),
    [project],
  );
}

/** Which tasks have subtasks (build.ts's hasSubtasks), worked out once per
 *  task list: every card asks, and the list is the same object until it
 *  changes. */
const parentIds = new WeakMap<Plan['tasks'], Set<string>>();
function isParent(plan: Plan, id: string): boolean {
  let set = parentIds.get(plan.tasks);
  if (!set) parentIds.set(plan.tasks, (set = new Set(plan.tasks.flatMap((t) => (t.parentId ? [t.parentId] : [])))));
  return set.has(id);
}

/** "skips tests" and "+1 check": a gate changed on a task shows on its card. */
export function CheckChips({ plan, task }: { plan: Plan; task: Task }) {
  // The skips that hold — only on a task that is built (effectiveChecks's
  // rule): one left on a task since given subtasks gates nothing, and the
  // card must not say it does.
  const skips = isParent(plan, task.id) ? [] : (task.skipChecks ?? []);
  const own = task.addChecks ?? [];
  return (
    <>
      {skips.length > 0 && (
        <span
          className="chip is-skip"
          title={`Checks you skipped on this task: ${skipWords(skips)}`}
        >
          skips {skips.map((s) => s.name).join(', ')}
        </span>
      )}
      {own.length > 0 && (
        <span className="chip" title={`Its own checks: ${own.map(ownCheckWords).join('\n')}`}>
          +{own.length} check{own.length === 1 ? '' : 's'}
        </span>
      )}
    </>
  );
}

const strip = ({ by: _by, ...c }: TaskCheck) => c;

/**
 * `plan` says what the task inherits. A task with subtasks is not built
 * itself: it shows only its own checks — which hold every subtask — to add
 * or remove, and nothing to skip.
 */
export function TaskChecks({ plan, task, rev }: { plan: Plan; task: Task; rev: number }) {
  const agent = useAgent();
  const project = useProject();
  const [skipping, setSkipping] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [adding, setAdding] = useState(false);
  const editable = task.status !== 'done' && task.status !== 'dropped';
  const parent = isParent(plan, task.id);
  const skips = task.skipChecks ?? [];
  const own = task.addChecks ?? [];
  const inherited = parent ? [] : inheritedChecks(plan, task);
  // What can be skipped here: the repository's checks, and those it holds
  // from the tasks above it, each said where it comes from.
  const repo = parent ? [] : [...new Set([...(project?.checks.implement ?? []), ...(project?.checks.review ?? [])])];
  const rows = [
    ...repo.map((name) => ({ name, from: null as string | null })),
    ...inherited.filter(({ check }) => !repo.includes(check.name)).map(({ check, from }) => ({ name: check.name, from: from.title })),
  ];
  const unknown = parent ? [] : skips.filter((s) => project && !rows.some((r) => r.name === s.name));

  // Sent as the op takes them, {name, reason}: when each was skipped is the
  // daemon's to keep.
  const setSkips = (next: { name: string; reason?: string }[]) =>
    store.op({ op: 'upsert_task', id: task.id, skipChecks: next.map(({ name, reason }) => ({ name, ...(reason ? { reason } : {}) })), expect: rev });
  const startSkip = (name: string | null) => {
    setSkipping(name);
    setReason('');
  };
  const setOwn = (next: Omit<TaskCheck, 'by'>[]) => store.op({ op: 'upsert_task', id: task.id, addChecks: next, expect: rev });

  return (
    <div className="task-checks">
      {parent ? (
        <>
          <span className="muted">Its own checks hold every subtask under it; skip a check on a subtask.</span>
          {/* Set before it had subtasks: it gates nothing now, and goes. */}
          {skips.length > 0 && (
            <p className="muted task-check-unknown">
              A skip left from before it had subtasks gates nothing: {skips.map((s) => s.name).join(', ')}.{' '}
              {editable && (
                <button type="button" className="link" onClick={() => void setSkips([])}>
                  Remove
                </button>
              )}
            </p>
          )}
        </>
      ) : rows.length > 0 ? (
        <ul className="plain-list task-checks-list" aria-label={`The repository's checks for ${task.title}`}>
          {rows.map(({ name, from }) => {
            const skip = skips.find((s) => s.name === name);
            return (
              <li key={name} className={classNames('task-check', skip && 'is-skipped')}>
                <span className="mono">{name}</span>
                {from && <span className="muted">from "{from}"</span>}
                {skip ? (
                  <>
                    <span className="muted">skipped{skip.reason ? ` — ${skip.reason}` : ''}</span>
                    {editable && (
                      <button type="button" className="link" onClick={() => void setSkips(skips.filter((s) => s.name !== name))}>
                        Run it again
                      </button>
                    )}
                  </>
                ) : skipping === name ? (
                  <span className="task-check-skip">
                    <input
                      className="input"
                      value={reason}
                      placeholder="Why (shown in the brief and the report)"
                      aria-label={`Why skip ${name}`}
                      onChange={(e) => setReason(e.target.value)}
                    />
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={async () => {
                        const ok = await setSkips([...skips, { name, ...(reason.trim() ? { reason: reason.trim() } : {}) }]);
                        if (ok) startSkip(null);
                      }}
                    >
                      Skip
                    </button>
                    <button type="button" className="btn btn-sm btn-ghost" onClick={() => startSkip(null)}>
                      Cancel
                    </button>
                  </span>
                ) : (
                  editable && (
                    <button type="button" className="link" title={`${agent.name} will not run it, and it will not gate this task`} onClick={() => startSkip(name)}>
                      Skip on this task
                    </button>
                  )
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <span className="muted">{project ? 'The repository sets no implement or review checks.' : ''}</span>
      )}
      {unknown.map((s) => (
        <p key={s.name} className="muted task-check-unknown">
          Skips "{s.name}", which the repository has no check named.{' '}
          {editable && (
            <button type="button" className="link" onClick={() => void setSkips(skips.filter((x) => x.name !== s.name))}>
              Remove
            </button>
          )}
        </p>
      ))}
      {own.length > 0 && (
        <ul className="plain-list task-checks-list" aria-label={`Checks of ${task.title}'s own`}>
          {own.map((c) => (
            <li key={c.name} className="task-check">
              <span className="mono">{c.name}</span>
              <span className="muted mono">{c.run}</span>
              <span className="muted">
                {c.stage}
                {c.optional ? ', optional' : ''} · added by {c.by === 'user' ? 'you' : agent.name}
              </span>
              {editable && (
                <button type="button" className="link is-danger" onClick={() => void setOwn(own.filter((x) => x.name !== c.name).map(strip))}>
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {editable &&
        (adding ? (
          <AddCheck
            onCancel={() => setAdding(false)}
            onAdd={async (check) => {
              if (await setOwn([...own.map(strip), check])) setAdding(false);
            }}
          />
        ) : (
          <button type="button" className="link" onClick={() => setAdding(true)}>
            Add a check for this task
          </button>
        ))}
    </div>
  );
}

function AddCheck({ onAdd, onCancel }: { onAdd: (check: Omit<TaskCheck, 'by'>) => void; onCancel: () => void }) {
  const [name, setName] = useState('');
  const [run, setRun] = useState('');
  const [stage, setStage] = useState<TaskCheckStage>('review');
  const [optional, setOptional] = useState(false);
  return (
    <div className="task-check-add" role="group" aria-label="New check">
      <input className="input" value={name} placeholder="Name: db-check" aria-label="Check name" onChange={(e) => setName(e.target.value)} />
      <input className="input mono" value={run} placeholder="Command: pnpm db:check" aria-label="Check command" onChange={(e) => setRun(e.target.value)} />
      <select className="input" value={stage} aria-label="When it runs" onChange={(e) => setStage(e.target.value as TaskCheckStage)}>
        {TASK_CHECK_STAGES.map((s) => (
          <option key={s} value={s}>
            {s === 'review' ? 'review (gates the task)' : 'implement'}
          </option>
        ))}
      </select>
      <label className="task-check-optional">
        <input type="checkbox" checked={optional} onChange={(e) => setOptional(e.target.checked)} /> optional
      </label>
      <span className="row-actions">
        <button
          type="button"
          className="btn btn-sm btn-primary"
          disabled={!name.trim() || !run.trim()}
          onClick={() => onAdd({ name: name.trim(), run: run.trim(), stage, ...(optional ? { optional } : {}) })}
        >
          Add
        </button>
        <button type="button" className="btn btn-sm btn-ghost" onClick={onCancel}>
          Cancel
        </button>
      </span>
    </div>
  );
}

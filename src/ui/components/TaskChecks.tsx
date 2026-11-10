import { useState } from 'react';
import { useAgent, useEdit, useStore } from '../store.ts';
import { classNames } from '../lib/format.ts';
import { ancestorsOf, effectiveChecks, leafTasks } from '../../shared/build.ts';
import { TASK_CHECK_STAGES, type Plan, type Task, type TaskCheck, type TaskCheckStage } from '../../shared/types.ts';

/**
 * A task's own checks (#54): the repository checks the user skipped for it
 * and the checks they added for it. Only the user sets them — the agent
 * proposes — and they show wherever the task does, so a skipped gate is
 * never silent.
 */

/** Chips on a task's row or card: what it skips and what it adds. */
export function TaskCheckChips({ plan, task }: { plan: Plan; task: Task }) {
  const own = effectiveChecks(plan, task);
  if (!own.skip.length && !own.add.length) return null;
  return (
    <>
      {own.skip.length > 0 && (
        <span className="chip is-warning check-skip" title="Checks you skipped for this task: they are not run, and done does not wait on them">
          skips {own.skip.join(', ')}
        </span>
      )}
      {own.add.map((c) => (
        <span key={c.name} className="chip check-add" title={`Added for this task: ${c.run} (at ${c.stage}${c.optional ? ', optional' : ''})`}>
          ＋ {c.name}
        </span>
      ))}
    </>
  );
}

/**
 * Set a task's checks: untick a repository check to skip it, add one of
 * its own. What its parents set holds too, and is shown, not editable here.
 */
export function TaskChecksField({ plan, task }: { plan: Plan; task: Task }) {
  const edit = useEdit();
  const agent = useAgent();
  const repo = useStore((s) => s.projectChecks);
  const own = { add: task.addChecks ?? [], skip: task.skipChecks ?? [] };
  const inherited = effectiveChecks(plan, task);
  const fromParents = {
    skip: inherited.skip.filter((n) => !own.skip.includes(n)),
    add: inherited.add.filter((c) => !own.add.some((a) => a.name === c.name)),
  };
  const set = (patch: { add?: TaskCheck[]; skip?: string[] }) => void edit({ op: 'set_checks', id: task.id, ...patch });
  const names = [...new Set([...repo.implement, ...repo.review])];
  const parent = ancestorsOf(plan, task)[0];
  return (
    <div className="task-checks">
      {names.length ? (
        <ul className="plain-list task-checks-repo" aria-label={`The repository's checks for ${task.title}`}>
          {TASK_CHECK_STAGES.flatMap((stage) =>
            repo[stage].map((name) => {
              const skipped = inherited.skip.includes(name);
              const byParent = fromParents.skip.includes(name);
              return (
                <li key={`${stage}:${name}`}>
                  <label className={classNames('field-inline', skipped && 'is-skipped')}>
                    <input
                      type="checkbox"
                      checked={!skipped}
                      disabled={byParent}
                      onChange={() => set({ skip: skipped ? own.skip.filter((n) => n !== name) : [...own.skip, name] })}
                    />
                    <span>
                      <span className="task-check-name">{name}</span> <span className="muted">· {stage}</span>
                      {skipped && <span className="muted"> — skipped{byParent && parent ? ` for all of "${parent.title}"` : ''}</span>}
                    </span>
                  </label>
                </li>
              );
            }),
          )}
        </ul>
      ) : (
        <span className="muted">This repository sets no checks.</span>
      )}
      {inherited.add.length > 0 && (
        <ul className="plain-list task-checks-own" aria-label={`Checks added for ${task.title}`}>
          {inherited.add.map((c) => (
            <li key={c.name} className="chip check-add">
              <span>
                ＋ {c.name} <code>{c.run}</code> <span className="muted">· {c.stage}{c.optional ? ', optional' : ''}</span>
              </span>
              {own.add.some((a) => a.name === c.name) ? (
                <button type="button" className="icon-btn is-tiny" aria-label={`Remove the check ${c.name}`} title="Remove" onClick={() => set({ add: own.add.filter((a) => a.name !== c.name) })}>
                  ×
                </button>
              ) : (
                <span className="muted"> (from its parent)</span>
              )}
            </li>
          ))}
        </ul>
      )}
      <AddCheck onAdd={(c) => set({ add: [...own.add, c] })} taken={inherited.add.map((c) => c.name)} />
      <p className="muted task-checks-hint">
        Only you set these; {agent.name} proposes changes to them. A skipped check is not run and done does not wait on it; an added one gates
        the task like the repository's, unless optional.
      </p>
    </div>
  );
}

function AddCheck({ onAdd, taken }: { onAdd: (c: TaskCheck) => void; taken: string[] }) {
  const [run, setRun] = useState('');
  const [name, setName] = useState('');
  const [stage, setStage] = useState<TaskCheckStage>('review');
  const [optional, setOptional] = useState(false);
  const derived = name.trim() || run.trim().split(/\s+/).slice(0, 3).join(' ');
  const clash = taken.includes(derived);
  const add = () => {
    if (!run.trim() || clash) return;
    onAdd({ name: derived, run: run.trim(), stage, ...(optional ? { optional: true } : {}) });
    setRun('');
    setName('');
    setOptional(false);
  };
  return (
    <div className="task-checks-add" role="group" aria-label="Add a check for this task">
      <input className="input mono" value={run} placeholder="Command, e.g. pnpm db:check" aria-label="Command of the check to add" onChange={(e) => setRun(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
      <input className="input" value={name} placeholder="Name (optional)" aria-label="Name of the check to add" onChange={(e) => setName(e.target.value)} />
      <select className="input" value={stage} aria-label="When it runs" onChange={(e) => setStage(e.target.value as TaskCheckStage)}>
        <option value="review">at review</option>
        <option value="implement">at implement</option>
      </select>
      <label className="field-inline">
        <input type="checkbox" checked={optional} onChange={(e) => setOptional(e.target.checked)} /> optional
      </label>
      <button type="button" className="btn btn-sm" disabled={!run.trim() || clash} title={clash ? `This task already has a check called ${derived}` : undefined} onClick={add}>
        Add check
      </button>
    </div>
  );
}

/** Every task that skipped a check, for the build report to show (#54). */
export function SkippedChecks({ plan }: { plan: Plan }) {
  const skipped = leafTasks(plan)
    .map((t) => ({ t, skip: effectiveChecks(plan, t).skip }))
    .filter((x) => x.skip.length);
  if (!skipped.length) return null;
  return (
    <p className="report-skipped" data-testid="skipped-checks">
      <strong>Checks you skipped:</strong> {skipped.map(({ t, skip }) => `${t.id} ${t.title} (${skip.join(', ')})`).join('; ')}.
    </p>
  );
}

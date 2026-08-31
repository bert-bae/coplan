import { useEffect, useState } from 'react';
import { store, useSession, useGateOfKind, useStore } from '../store.ts';
import { api } from '../lib/api.ts';
import { Button, EmptyState, Explain, Panel, Spinner } from '../components/primitives.tsx';
import { StageBar, RequiredAction, NoActionNeeded } from '../components/StageStatus.tsx';
import { classNames } from '../lib/format.ts';
import type { ShipState, ShipStep } from '../../shared/types.ts';

const ALL_STEPS: ShipStep[] = ['checks', 'commit', 'push', 'pr', 'summary'];

const STEP_HELP: Record<ShipStep, string> = {
  checks: 'Refuse to continue if any check is failing',
  commit: 'Stage the reviewed files and commit them',
  push: 'Push the branch to origin',
  pr: 'Open a pull request with the provider below',
  summary: 'Write a markdown summary of the review into the repo',
};

/**
 * The ship stage.
 *
 * Everything here is composed by the daemon from the approved plan, the review
 * threads and the check results — the user edits rather than writes. Because
 * this step pushes code and opens PRs, it confirms explicitly and names the
 * branches involved.
 */
export function ShipView() {
  const session = useSession();
  const gate = useGateOfKind('ship');
  const sessionId = useStore((s) => s.sessionId);

  const [ship, setShip] = useState<ShipState | null>(null);
  const [providers, setProviders] = useState<{ id: string; kind: string; label: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [outcome, setOutcome] = useState<{ ok: boolean; output: string; url?: string; directive?: string } | null>(
    null,
  );

  useEffect(() => {
    if (!sessionId) return;
    let live = true;
    setLoading(true);
    api
      .shipPreview(sessionId)
      .then((res) => {
        if (!live) return;
        setShip(res.ship);
        setProviders(res.providers);
      })
      .catch((err: unknown) => store.fail(err))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [sessionId]);

  if (!session || !sessionId) return null;
  if (loading) return <div className="view-pad"><Spinner label="Composing from the plan and review…" /></div>;
  if (!ship) {
    return (
      <div className="view-pad">
        <EmptyState title="Nothing to ship yet" hint="The ship payload is built once there is a plan and a diff." />
      </div>
    );
  }

  const onBase = Boolean(ship.branch && ship.branch === ship.baseBranch);
  const failing = session.checks.filter((c) => c.status === 'failed');
  const provider = providers.find((p) => p.id === ship.provider);
  const patch = (p: Partial<ShipState>) => setShip((current) => (current ? { ...current, ...p } : current));

  /** Close the ship gate without shipping, so the session is not left parked
   *  on a stage the user has decided against. */
  const decline = async () => {
    if (!gate || busy) return;
    setBusy(true);
    setConfirming(false);
    try {
      await api.resolveGate(sessionId, gate.id, {
        verdict: 'rejected',
        comment: 'Do not ship this yet. Stop here and wait for direction.',
      });
      store.toast('success', 'Ship declined — Claude is told to stop and wait.');
    } catch (err) {
      store.fail(err);
    } finally {
      setBusy(false);
    }
  };

  const run = async () => {
    setBusy(true);
    setConfirming(false);
    try {
      const result = await api.executeShip(sessionId, ship);
      setOutcome(result);
      store.toast(result.ok ? 'success' : 'error', result.ok ? 'Ship finished.' : 'Ship failed — see the log.');
    } catch (err) {
      store.fail(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ship">
      <div className="ship-main">
        <StageBar tab="ship" />
        <Panel title="What will happen">
          <ul className="ship-steps">
            {ALL_STEPS.map((step) => {
              const on = ship.steps.includes(step);
              return (
                <li key={step} className={classNames('ship-step', on && 'is-on')}>
                  <label>
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={(e) =>
                        patch({
                          steps: e.target.checked
                            ? ALL_STEPS.filter((s) => s === step || ship.steps.includes(s))
                            : ship.steps.filter((s) => s !== step),
                        })
                      }
                    />
                    <span className="ship-step-name">{step}</span>
                    <span className="muted">{STEP_HELP[step]}</span>
                  </label>
                </li>
              );
            })}
          </ul>
        </Panel>

        <Panel title="Pull request">
          <label className="field">
            <span>Provider</span>
            <select value={ship.provider} onChange={(e) => patch({ provider: e.target.value })}>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          {provider?.kind === 'mcp' && (
            <Explain>
              This provider runs through an MCP server connected to the Claude session, not the harness. Claude
              performs the PR call itself and reports the URL back.
            </Explain>
          )}
          <label className="field">
            <span>Title</span>
            <input className="input" value={ship.title} onChange={(e) => patch({ title: e.target.value })} />
          </label>
          <label className="field">
            <span>Body</span>
            <textarea
              className="input ship-body"
              rows={14}
              value={ship.body}
              onChange={(e) => patch({ body: e.target.value })}
            />
          </label>
        </Panel>

        <Panel title="Commit message">
          <textarea
            className="input mono"
            rows={5}
            value={ship.commitMessage}
            onChange={(e) => patch({ commitMessage: e.target.value })}
          />
        </Panel>

        {outcome && (
          <Panel title={outcome.ok ? 'Result' : 'Ship failed'} className={outcome.ok ? 'is-ok' : 'is-failed'}>
            {outcome.url && (
              <p>
                <a href={outcome.url} target="_blank" rel="noreferrer">
                  {outcome.url}
                </a>
              </p>
            )}
            {outcome.directive && (
              <p className="explain">Handed to Claude to finish through its MCP server: {outcome.directive}</p>
            )}
            <pre className="check-output">{outcome.output}</pre>
          </Panel>
        )}
      </div>

      <aside className="ship-side">
        <h3 className="panel-title">Confirm</h3>
        <dl className="ship-facts">
          <dt>Branch</dt>
          <dd><code>{ship.branch ?? 'detached'}</code></dd>
          <dt>Base</dt>
          <dd><code>{ship.baseBranch ?? 'unknown'}</code></dd>
        </dl>

        {onBase && (
          <p className="warn-note">
            The session is on <code>{ship.branch}</code>, which is this repository's default branch. The harness
            will refuse to commit or push here — create a feature branch first.
          </p>
        )}
        {failing.length > 0 && ship.steps.includes('checks') && (
          <p className="warn-note">{failing.length} check(s) failing — the checks step will stop the ship.</p>
        )}
        {gate ? (
          <Explain>Shipping resolves the gate and reports the result back to the parked session.</Explain>
        ) : (
          <Explain>This runs git commands against your working tree right now.</Explain>
        )}

        {confirming ? (
          <div className="ship-confirm">
            <p>
              Run <strong>{ship.steps.join(' → ')}</strong> on <code>{ship.branch}</code>
              {ship.steps.includes('pr') && ship.baseBranch ? <> into <code>{ship.baseBranch}</code></> : null}?
            </p>
            <div className="row-actions">
              <Button variant="primary" onClick={() => void run()} disabled={busy}>
                {busy ? 'Running…' : 'Yes, ship it'}
              </Button>
              <Button variant="ghost" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : gate ? (
          /* The gate used to have exactly one exit. A user who decided not to
             ship had no way to say so, and the session sat parked. */
          <RequiredAction
            gate={gate}
            busy={busy}
            disabled={(id) => id === 'ship' && onBase}
            onChoose={(id) => (id === 'ship' ? setConfirming(true) : void decline())}
          />
        ) : (
          <>
            <NoActionNeeded tab="ship" />
            <div className="row-actions">
              <Button variant="primary" onClick={() => setConfirming(true)} disabled={busy || onBase}>
                Ship…
              </Button>
            </div>
          </>
        )}
      </aside>
    </div>
  );
}

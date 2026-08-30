import { useEffect, useState } from 'react';
import { store, useStore, formatBytes } from '../store.ts';
import { classNames } from '../lib/format.ts';
import type { CleanupGroupId, StorageGroup } from '../../shared/types.ts';

declare const __HARNESS_VERSION__: string;

/**
 * The two things the harness itself owns, rather than any one session:
 * reclaiming the files it has left on disk, and picking up a new build.
 *
 * They live in the rail's footer because that is the only part of the UI that
 * is not about the session you happen to be looking at — and both were
 * previously only reachable by leaving the browser for a terminal.
 */

/**
 * Groups pre-selected when the panel opens.
 *
 * Everything here is unambiguously garbage: a half-written file, a scratch
 * file from a finished ship, a log tail, an address for a process that is
 * gone. Recorded session history is deliberately left unticked — it is the
 * only group whose removal loses something a user might want back.
 */
const DEFAULT_SELECTION: CleanupGroupId[] = ['partial-writes', 'scratch', 'log', 'lock'];

export function GlobalActions() {
  const restarting = useStore((s) => s.restarting);
  const [panel, setPanel] = useState(false);
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="global">
      <div className="global-bar">
        <span className="global-version">
          v{typeof __HARNESS_VERSION__ === 'string' ? __HARNESS_VERSION__ : 'dev'}
        </span>
        {restarting && <span className="global-note">restarting…</span>}
        <span className="spacer" />
        <button
          type="button"
          className={classNames('icon-btn', 'is-tiny', panel && 'is-active')}
          aria-expanded={panel}
          title="Clean up stale harness files"
          disabled={restarting}
          onClick={() => {
            const next = !panel;
            setPanel(next);
            setConfirming(false);
            if (next) void store.loadStorage();
          }}
        >
          🧹
        </button>
        <button
          type="button"
          className={classNames('icon-btn', 'is-tiny', confirming && 'is-active')}
          title="Restart the daemon to pick up a new build"
          disabled={restarting}
          onClick={() => {
            setConfirming(!confirming);
            setPanel(false);
          }}
        >
          ⟳
        </button>
      </div>

      {confirming && (
        <div className="global-confirm">
          <span>Restart the daemon? Checks and ship commands still running will stop.</span>
          <div className="row-actions">
            <button
              type="button"
              className="link"
              onClick={() => {
                setConfirming(false);
                void store.restartDaemon();
              }}
            >
              Restart
            </button>
            <button type="button" className="link" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {panel && <StoragePanel />}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function StoragePanel() {
  const report = useStore((s) => s.storage);
  const busy = useStore((s) => s.storageBusy);
  const [selected, setSelected] = useState<CleanupGroupId[]>(DEFAULT_SELECTION);

  // Only groups that still hold something are shown, so the panel is a list
  // of decisions rather than a list of zeroes.
  const groups = (report?.groups ?? []).filter((g) => g.count > 0);
  const chosen = groups.filter((g) => selected.includes(g.id));
  const total = chosen.reduce((sum, g) => sum + g.bytes, 0);

  useEffect(() => {
    if (!report) void store.loadStorage();
  }, [report]);

  const toggle = (id: CleanupGroupId) =>
    setSelected(selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id]);

  return (
    <div className="global-panel">
      {!report ? (
        <p className="global-empty">{busy ? 'Scanning…' : 'Could not read the storage report.'}</p>
      ) : groups.length === 0 ? (
        <p className="global-empty">Nothing to clean up.</p>
      ) : (
        <>
          <ul className="global-groups">
            {groups.map((group) => (
              <GroupRow
                key={group.id}
                group={group}
                checked={selected.includes(group.id)}
                onToggle={() => toggle(group.id)}
              />
            ))}
          </ul>
          <div className="global-panel-foot">
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy || chosen.length === 0}
              onClick={() => void store.cleanStorage(chosen.map((g) => g.id))}
            >
              {busy ? 'Working…' : `Clean up ${formatBytes(total)}`}
            </button>
            <button type="button" className="link" disabled={busy} onClick={() => void store.loadStorage()}>
              Rescan
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function GroupRow({
  group,
  checked,
  onToggle,
}: {
  group: StorageGroup;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <li className="global-group">
      <label className="global-group-head">
        <input type="checkbox" checked={checked} onChange={onToggle} />
        <span className="global-group-name">{group.label}</span>
        <span className="global-group-size">{formatBytes(group.bytes)}</span>
      </label>
      {/* The consequence of ticking the box, which the label alone cannot
          carry — "Finished sessions" does not say that history goes with it. */}
      <p className="global-group-detail">{group.detail}</p>
    </li>
  );
}

import { useMemo, useState } from 'react';
import { store, useAgent, useStore } from '../store.ts';
import { Markdown } from './Markdown.tsx';
import { previewProposal, type ProposalPreview } from '../../shared/proposals.ts';
import type { Plan, Proposal } from '../../shared/types.ts';

/**
 * What the agent proposes, waiting on the user: each with its reason, what
 * it would change, and Accept / Reject. Accepting applies its edits as the
 * user's; rejecting keeps the plan and tells the agent why.
 */
export function ProposalsStrip({ plan }: { plan: Plan }) {
  const open = (plan.proposals ?? []).filter((p) => p.status === 'open');
  if (!open.length) return null;
  return (
    <section className="proposals" aria-label="Proposals">
      {open.map((p) => (
        <ProposalCard key={p.id} plan={plan} proposal={p} />
      ))}
    </section>
  );
}

export function ProposalCard({ plan, proposal: p, compact = false }: { plan: Plan; proposal: Proposal; compact?: boolean }) {
  const agent = useAgent();
  const previewing = useStore((s) => s.proposalPreview);
  // Shared with the canvas preview: one run per proposal per plan.
  const preview: ProposalPreview = useMemo(() => previewProposal(plan, p), [plan, p]);
  const blocker = preview.blocker;
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const answer = async (op: { op: 'accept_proposal'; id: string } | { op: 'reject_proposal'; id: string; note?: string }) => {
    setBusy(true);
    const ok = await store.op(op);
    setBusy(false);
    if (ok && store.getState().proposalPreview === p.id) store.set({ proposalPreview: null });
    if (ok) store.toast('success', op.op === 'accept_proposal' ? `Accepted "${p.title}".` : `Rejected "${p.title}". ${agent.name} hears why the next time it reads the plan.`);
  };
  const show = () => store.set({ proposalPreview: p.id, tab: 'diagrams', diagramId: preview.diagrams[0] ?? store.getState().diagramId });

  return (
    <article className="proposal" aria-labelledby={`proposal-${p.id}`}>
      <header className="proposal-head">
        <span className="panel-kicker">{agent.name} proposes</span>
        <h3 id={`proposal-${p.id}`} className="proposal-title">
          {p.title}
        </h3>
        <span className="item-id">{p.id}</span>
      </header>
      {!compact && <Markdown source={p.reason} className="proposal-reason" />}
      {preview.changes.length > 0 && (
        <details className="proposal-changes" open={compact}>
          <summary>
            {preview.changes.length} change{preview.changes.length === 1 ? '' : 's'}
          </summary>
          <ul className="plain-list">
            {preview.changes.slice(0, 12).map((c, i) => (
              <li key={i}>{c}</li>
            ))}
            {preview.changes.length > 12 && <li className="muted">…and {preview.changes.length - 12} more</li>}
          </ul>
        </details>
      )}
      {blocker && (
        <p className="proposal-blocked" role="note">
          {blocker}
        </p>
      )}
      {rejecting ? (
        <div className="proposal-reject">
          <label className="field-label" htmlFor={`reject-${p.id}`}>
            Why not? <span className="muted">(optional — {agent.name} reads it)</span>
          </label>
          <textarea id={`reject-${p.id}`} className="input" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
          <div className="proposal-actions">
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setRejecting(false)} disabled={busy}>
              Cancel
            </button>
            <button type="button" className="btn btn-sm" onClick={() => void answer({ op: 'reject_proposal', id: p.id, ...(note.trim() ? { note: note.trim() } : {}) })} disabled={busy}>
              Reject
            </button>
          </div>
        </div>
      ) : (
        <div className="proposal-actions">
          {!compact && preview.diagrams.length > 0 && preview.after && (
            <button type="button" className="btn btn-ghost btn-sm" aria-pressed={previewing === p.id} onClick={show}>
              Show on canvas
            </button>
          )}
          {compact && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => store.set({ proposalPreview: null })}>
              Close preview
            </button>
          )}
          <span className="spacer" />
          <button type="button" className="btn btn-sm" onClick={() => setRejecting(true)} disabled={busy}>
            Reject…
          </button>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => void answer({ op: 'accept_proposal', id: p.id })}
            disabled={busy || Boolean(blocker)}
            title={blocker ?? undefined}
          >
            Accept
          </button>
        </div>
      )}
    </article>
  );
}

import { store, useAgent, usePlan, useSession } from '../store.ts';
import { classNames, relativeTime } from '../lib/format.ts';
import { isLocked, unreadAreas } from '../../shared/plan.ts';
import { agentInfo, type AgentInfo } from '../../shared/agents.ts';
import type { SessionLink, SessionState, WaitingState } from '../../shared/types.ts';

/** What to tell the agent once the plan has been worked over. */
export const HANDOFF_MESSAGE =
  "I've updated the plan in Coplan. Read it with harness_plan_read, take my edits and comments into account, and tell me what changes.";

/**
 * The bridge back to the agent.
 *
 * The harness never talks to the agent and never answers for the user. All
 * it can do is say when the agent is behind or waiting, and take the user to
 * the session — in the agent's app when the session can be addressed, and
 * otherwise by putting the words on their clipboard.
 */
export function Handoff() {
  const session = useSession();
  const plan = usePlan();
  const agent = useAgent();
  if (!session) return null;
  // No count: one box edited forty times and forty boxes are both "changes",
  // and Claude reads the net result either way. Say where instead.
  const areas = unreadAreas(plan);
  // Once the plan is submitted, the strip under the header says where the
  // build stands; "Claude hasn't read your changes" no longer applies.
  const locked = isLocked(plan);
  const unread = locked ? 0 : areas.length;

  return (
    <div className="handoff">
      {plan &&
        !locked &&
        (unread > 0 ? (
          <span className="handoff-state is-behind" title={`You changed ${areas.join(', ')} since ${agent.name} last read the plan`}>
            <span className="dot is-attention" aria-hidden="true" />
            {agent.name} hasn't read your changes
          </span>
        ) : (
          <span className="handoff-state is-current" title={plan.claudeReadAt ? `Read ${new Date(plan.claudeReadAt).toLocaleString()}` : undefined}>
            ✓ {agent.name} is up to date{plan.claudeReadAt ? ` · read ${relativeTime(plan.claudeReadAt)}` : ''}
          </span>
        ))}
      {/* Without a link, the fallback copies "read my changes" — the wrong
          words for a submitted plan; the strip below offers its prompt. */}
      {(!locked || session.link) && <OpenInClaude session={session} primary={unread > 0} />}
      {plan && (
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          title={`The read-back, the next prompt and each task's brief, with where every part comes from`}
          onClick={() => store.openViewer({ tab: 'readback' })}
        >
          What {agent.name} reads
        </button>
      )}
    </div>
  );
}

/**
 * Opens the session in its agent. With no link — a local Claude session
 * without Remote Control, or a Cursor chat — the best the harness can do is
 * the message to type there.
 */
export function OpenInClaude({
  session,
  primary,
  label,
}: {
  session: SessionState;
  primary?: boolean;
  label?: string;
}) {
  const agent = agentInfo(session.agent);
  if (session.link) return <ClaudeLinks link={session.link} agent={agent} primary={primary} label={label ?? `Open in ${agent.name}`} />;
  return (
    <button
      type="button"
      className={classNames('btn btn-sm', primary && 'btn-primary')}
      title={`${whereItRuns(session)} has no link Coplan can open. Copies a message to paste there instead.`}
      onClick={() => void copyHandoff(agent)}
    >
      Copy message for {agent.name}
    </button>
  );
}

function ClaudeLinks({ link, agent, primary, label }: { link: SessionLink; agent: AgentInfo; primary?: boolean; label: string }) {
  return (
    <span className="claude-links">
      <a className={classNames('btn btn-sm', primary && 'btn-primary')} href={link.app} title={`Open this session in ${agent.app}`}>
        {label}
      </a>
      {link.web && (
        <a className="link claude-web" href={link.web} target="_blank" rel="noreferrer" title="Open this session on claude.ai">
          web
        </a>
      )}
    </span>
  );
}

/**
 * Claude is stopped on the user. The question is shown so they know what is
 * being asked, but it is answered in Claude — there is deliberately no way to
 * answer it here.
 */
export function WaitingBanner({ session }: { session: SessionState }) {
  const waiting = session.waiting;
  if (!waiting) return null;
  const agent = agentInfo(session.agent);
  return (
    <section className={classNames('waiting', `is-${waiting.kind}`)} role="status" aria-label={`${agent.name} is waiting on you`}>
      <div className="waiting-body">
        <p className="waiting-head">
          <span className="dot is-attention" aria-hidden="true" />
          {headline(waiting.kind, agent.name)}
          <span className="muted"> · {relativeTime(waiting.since)}</span>
        </p>
        {waiting.questions?.length ? (
          <ol className="waiting-questions">
            {waiting.questions.map((q, i) => (
              <li key={i}>
                {q.header && <span className="qchip">{q.header}</span>} <strong>{q.question}</strong>
                {q.options.length > 0 && (
                  <span className="waiting-options">
                    {q.multiSelect ? 'choose any: ' : 'choose one: '}
                    {q.options.join(' · ')}
                  </span>
                )}
              </li>
            ))}
          </ol>
        ) : (
          <p className="waiting-text">{waiting.text}</p>
        )}
        {!session.link && <p className="waiting-hint">{noLinkHint(session)}</p>}
      </div>
      <OpenInClaude
        session={session}
        primary
        label={waiting.kind === 'permission' ? `Decide in ${agent.name}` : `Answer in ${agent.name}`}
      />
    </section>
  );
}

function headline(kind: WaitingState['kind'], agent: string): string {
  switch (kind) {
    case 'question':
      return `${agent} is asking you`;
    case 'permission':
      return `${agent} needs your permission`;
    default:
      return `${agent} is waiting for your reply`;
  }
}

function whereItRuns(session: SessionState): string {
  if (session.agent === 'cursor') return 'A Cursor chat';
  return session.surface === 'desktop' ? 'This desktop session' : session.surface === 'cli' ? 'This terminal session' : 'This session';
}

function noLinkHint(session: SessionState): string {
  switch (session.agent) {
    case 'cursor':
      return 'Answer it in the Cursor chat that asked. Cursor has no link Coplan can open to a chat.';
    case 'codex':
      return 'Answer it where the Codex session is running.';
    default: {
      const where =
        session.surface === 'desktop' ? 'in the Claude desktop app' : session.surface === 'cli' ? 'in your terminal' : 'where the session is running';
      return `Answer it ${where}. Turn on Remote Control there (/remote-control) and this becomes a link that opens the session directly.`;
    }
  }
}

async function copyHandoff(agent: AgentInfo): Promise<void> {
  try {
    await navigator.clipboard.writeText(HANDOFF_MESSAGE);
    store.toast('success', `Copied — paste it into ${agent.name}'s chat.`);
  } catch {
    store.toast('info', `Tell ${agent.name}: "${HANDOFF_MESSAGE}"`);
  }
}

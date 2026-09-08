import { CHECK_RUN_BUDGET_MS, CHECK_TRANSPORT_HEADROOM_MS } from '../shared/config.ts';

/**
 * Tool definitions exposed to Claude.
 *
 * Descriptions are part of the session's prompt on every turn, so they are
 * written to be short and to teach the gate protocol without a skill having
 * to repeat it: publish → gate opens → end the turn → resume on the verdict.
 */

export interface ToolDef {
  name: string;
  /** The daemon endpoint this forwards to (`POST /mcp/<endpoint>`). */
  endpoint: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /**
   * How long to wait for the daemon, in ms. Defaults to {@link DEFAULT_BUDGET_MS}.
   *
   * A tool that does real work before it answers needs a budget drawn from
   * that work, not from what a status call costs. `harness_publish_checks`
   * runs the project's whole check suite before it opens its gate; against
   * the flat 30s budget every suite slower than that aborted, Claude was told
   * to call it again, and the retry re-ran the checks and cancelled the very
   * gate the user was looking at — so their click came back "gate is not
   * open" and nothing moved.
   */
  budgetMs?: number;
}

/** Enough for anything that only reads or writes harness state. */
export const DEFAULT_BUDGET_MS = 30_000;

/**
 * The daemon's own ceiling on one check run, plus transport headroom, so the
 * daemon's answer wins the race rather than the transport's. Derived from the
 * ceiling the daemon actually enforces rather than restated, so the two
 * cannot drift apart.
 */
export const CHECKS_BUDGET_MS = CHECK_RUN_BUDGET_MS + CHECK_TRANSPORT_HEADROOM_MS;

const STAGES = [
  'planning',
  'plan_review',
  'implementing',
  'code_review',
  'verification',
  'ship',
  'done',
];

export const TOOLS: ToolDef[] = [
  {
    name: 'harness_status',
    endpoint: 'status',
    description:
      'Read the harness state for this session: current stage, todo progress, files touched, whether a ' +
      'review gate is open, and whether the user left unread comments. Call this when resuming work or ' +
      'when unsure whether the user is waiting on you.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'harness_stage',
    endpoint: 'stage',
    description:
      'Move the session to a stage of the dev loop. Returns any project-specific instructions the user ' +
      'configured for that stage. Call this when you start planning and when you start implementing.',
    inputSchema: {
      type: 'object',
      properties: {
        stage: { type: 'string', enum: STAGES, description: 'The stage to move to.' },
        note: { type: 'string', description: 'One line describing what you are about to do.' },
      },
      required: ['stage'],
      additionalProperties: false,
    },
  },
  {
    name: 'harness_publish_plan',
    endpoint: 'plan',
    description:
      'Publish your implementation plan to the review UI and open the plan gate. The user can edit, ' +
      'reorder, drop and comment on individual steps. Then end your turn: the harness records the gate ' +
      'and hands you their verdict when the session next runs. Do not start implementing until it does.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short title for the work, reused as the PR title later.' },
        summary: { type: 'string', description: 'One or two sentences on the approach and why.' },
        markdown: {
          type: 'string',
          description: 'Optional prose to show above the steps — context, trade-offs, what you ruled out.',
        },
        steps: {
          type: 'array',
          description: 'The plan, one entry per step, in execution order.',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              detail: { type: 'string', description: 'Files touched, approach, or trade-offs.' },
            },
            required: ['title'],
          },
        },
      },
      required: ['title', 'steps'],
      additionalProperties: false,
    },
  },
  {
    name: 'harness_publish_diff',
    endpoint: 'diff',
    description:
      'Compute the current diff and open the code-review gate. The harness runs git itself — do not paste ' +
      'a diff. The user reviews it in the browser and can attach comments to specific line ranges. End your ' +
      'turn afterwards; their comments arrive as your next input.',
    inputSchema: {
      type: 'object',
      properties: {
        base_ref: {
          type: 'string',
          description:
            'Optional base to diff against. Defaults to the merge-base with the default branch, falling ' +
            'back to the commit the session started at.',
        },
      },
      additionalProperties: false,
    },
    // `git diff` against a large tree, plus a per-untracked-file pass.
    budgetMs: 180_000,
  },
  {
    name: 'harness_publish_checks',
    endpoint: 'checks',
    description:
      'Enter the verification stage: register the commands that prove the change works, run them, and ' +
      'stream their output to the UI. Omit `commands` to use the project-configured checks. Opens the ' +
      'verification gate for the user to sign off.',
    inputSchema: {
      type: 'object',
      properties: {
        commands: {
          type: 'array',
          items: { type: 'string' },
          description: 'Shell commands, e.g. ["npm run typecheck", "npm test"].',
        },
        run: { type: 'boolean', description: 'Run them immediately. Default true.' },
      },
      additionalProperties: false,
    },
    budgetMs: CHECKS_BUDGET_MS,
  },
  {
    name: 'harness_ship',
    endpoint: 'ship',
    description:
      'Enter the ship stage. The harness composes the commit message and PR title/body from the approved ' +
      'plan, the review threads and the check results, then opens the ship gate for the user to confirm. ' +
      'If the user picks an MCP-backed provider (Bitbucket, GitLab, …) you will receive a directive to ' +
      'perform the PR call yourself.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'harness_tasks',
    endpoint: 'tasks',
    description:
      'Read or create the task board. Approving a plan fills the board automatically, so usually you only ' +
      'call this with no arguments to read it back. Pass `tasks` to add subtasks you discovered while ' +
      'working. The board is what the user watches to see where you are.',
    inputSchema: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          description: 'Subtasks to add, in the order you intend to do them.',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'One concrete piece of work.' },
              detail: { type: 'string', description: 'What you intend to change, and where.' },
            },
            required: ['title'],
          },
        },
        replace: { type: 'boolean', description: 'Replace the board rather than append. Rarely correct.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'harness_task_update',
    endpoint: 'task_update',
    description:
      'Move a task on the board. Set `in_progress` BEFORE you start editing — files you touch are ' +
      'attributed to whichever task is in progress, which is how the user sees what each task changed. ' +
      'Set `done` when it is finished; `note` is required then and must say what you actually changed.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Full id or the short prefix shown on the board.' },
        status: { type: 'string', enum: ['todo', 'in_progress', 'blocked', 'done'] },
        note: {
          type: 'string',
          description: 'What changed. Required when completing a task; one or two lines is right.',
        },
      },
      required: ['task_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'harness_task_note',
    endpoint: 'task_note',
    description:
      'Record something on a task as you go: a change you made, a decision you took, a constraint you hit. ' +
      'This is the working record the user reviews against — write to it while the reason is still fresh, ' +
      'not reconstructed at the end.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        text: { type: 'string' },
        kind: { type: 'string', enum: ['change', 'decision', 'blocker', 'note'], description: 'Default: change.' },
      },
      required: ['task_id', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'harness_task_block',
    endpoint: 'task_block',
    description:
      'Stop work on a task and ask the user something you need to know. Use this the moment you would ' +
      'otherwise guess: it moves the card to BLOCKED with the question visible on the board, and their ' +
      'answer is recorded on the task as a decision automatically. Then end your turn — you are resumed ' +
      'with their answer.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        question: {
          type: 'string',
          description: 'What you need to know, and what you will do with each answer.',
        },
        options: { type: 'array', items: { type: 'string' }, description: 'Up to 6 one-click answers.' },
      },
      required: ['task_id', 'question'],
      additionalProperties: false,
    },
  },
  {
    name: 'harness_reply',
    endpoint: 'reply',
    description:
      'Reply to one of the user\'s line comments, in that comment\'s thread. Do this for every comment you ' +
      'receive — say what you changed, or why you disagree. Without it your answer lands in the activity ' +
      'feed as prose the user has to match up by hand. Marks the thread resolved unless resolve is false.',
    inputSchema: {
      type: 'object',
      properties: {
        thread_id: { type: 'string', description: 'The id from the comment you were given.' },
        text: { type: 'string' },
        resolve: { type: 'boolean', description: 'Default true. Pass false when the question is still open.' },
      },
      required: ['thread_id', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'harness_ask',
    endpoint: 'ask',
    description:
      'Ask the user a question in the UI. Use this INSTEAD of asking in prose — a question you only write ' +
      'in text reaches a terminal the user may not be looking at, and their reply in the browser cannot ' +
      'start a new turn. It opens a gate: end your turn afterwards and the harness resumes you with their ' +
      'answer.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'One clear question. State what you will do with each answer.' },
        options: {
          type: 'array',
          items: { type: 'string' },
          description: 'Up to 6 suggested answers, offered as one-click buttons. The user can still type their own.',
        },
        questions: {
          type: 'array',
          description:
            'Ask up to 4 related questions at once, each with its own options — use this instead of ' +
            '`question` when the answers are separate decisions, or when an option needs explaining.',
          items: {
            type: 'object',
            properties: {
              header: { type: 'string', description: 'Two or three words, shown as a chip. e.g. "Auth method".' },
              question: { type: 'string' },
              multiSelect: { type: 'boolean', description: 'Allow more than one option. Default false.' },
              options: {
                type: 'array',
                description: 'Up to 6 choices.',
                items: {
                  type: 'object',
                  properties: {
                    label: { type: 'string', description: 'The choice itself, 1-5 words.' },
                    description: { type: 'string', description: 'What picking this means, or its trade-off.' },
                  },
                  required: ['label'],
                },
              },
            },
            required: ['question', 'options'],
          },
        },
      },
      required: ['question'],
      additionalProperties: false,
    },
  },
  {
    name: 'harness_await',
    endpoint: 'await',
    description:
      'Escape hatch: block the current turn on the open gate. You almost never need it, and it holds the ' +
      'user\'s terminal for as long as it runs — ending your turn costs nothing and the verdict is handed ' +
      'to you when the session next runs, while this burns a turn per call and returns "pending" when the ' +
      'user is still thinking. Use it only when you must have the answer without yielding the turn.',
    inputSchema: {
      type: 'object',
      properties: {
        gate_id: { type: 'string', description: 'Defaults to the currently open gate.' },
        timeout_seconds: {
          type: 'number',
          description: 'How long to wait in one call (5-600). Default 120.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'harness_note',
    endpoint: 'note',
    description:
      'Post a one-line status update to the UI timeline. Use sparingly, for things the user cannot infer ' +
      'from your tool calls — a decision you made, or a blocker you hit.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false,
    },
  },
];

/**
 * What to tell Claude when the daemon outran its budget.
 *
 * "Call the tool again" is right for a tool that only reads state and wrong
 * for one that opens a gate: the daemon is still working, will open that gate
 * when it finishes, and a second call re-does the work and cancels the gate
 * the user is already reading — so their verdict comes back "gate is not
 * open". For those, stopping is the correct move, exactly as it is when the
 * call succeeds.
 */
export function timeoutText(tool: ToolDef): string {
  if (!tool.budgetMs) return '[cc-harness] The daemon did not respond in time. Call the tool again.';
  return (
    `[cc-harness] ${tool.name} is taking longer than ${Math.round(tool.budgetMs / 1000)}s. The harness is ` +
    `still working on it and opens the gate when it finishes. Do NOT call it again — a second run would ` +
    `discard this one and close the gate the user may already be reading. End your turn; you are handed ` +
    `the verdict when the session next runs, and harness_status says where it got to.`
  );
}

/**
 * How long to wait for the daemon on one call.
 *
 * This is the line that carried the bug: it used to be a flat `30_000` for
 * everything except `harness_await`, so `harness_publish_checks` — which runs
 * the project's whole suite before it answers — aborted on any suite slower
 * than that, and the retry Claude was told to make cancelled the gate the
 * user was already reading.
 */
export function budgetFor(tool: ToolDef, timeoutSeconds?: unknown): number {
  // `await` parks on purpose; give it headroom over its own timeout so the
  // daemon's answer wins the race rather than the transport's.
  if (tool.endpoint === 'await') return clampAwaitSeconds(timeoutSeconds) * 1000 + 15_000;
  return tool.budgetMs ?? DEFAULT_BUDGET_MS;
}

export function clampAwaitSeconds(value: unknown): number {
  const n = Number(value ?? 120);
  if (!Number.isFinite(n)) return 120;
  return Math.min(600, Math.max(5, n));
}

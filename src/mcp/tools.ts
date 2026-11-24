/**
 * Tool definitions exposed to Claude.
 *
 * Descriptions ride along in the session's prompt on every turn, so they are
 * short and carry the whole protocol on their own: publish the plan, tell the
 * user in chat, read it back when they say so, track tasks while working.
 * None of these tools waits for the user, and none asks them anything: every
 * question goes through AskUserQuestion in Claude's own chat.
 */
import { MAX_PROPOSAL_OPS, PROPOSABLE_OPS } from '../shared/proposal-ops.ts';

export interface ToolDef {
  name: string;
  /** The daemon endpoint this forwards to (`POST /mcp/<endpoint>`). */
  endpoint: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** Every tool only reads or writes harness state, so one budget fits all. */
export const DEFAULT_BUDGET_MS = 30_000;

const STATUS = { type: 'string', enum: ['todo', 'in_progress', 'blocked', 'done', 'dropped'] };

const NODE = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'Short slug, unique in the diagram, e.g. "api". Edges refer to it.' },
    label: { type: 'string' },
    kind: { type: 'string', enum: ['component', 'service', 'datastore', 'queue', 'external', 'actor', 'note'] },
    detail: { type: 'string', description: 'A few words shown on the box: its technology or role, e.g. "Redis, read-through".' },
    description: { type: 'string', description: 'Two to four sentences: what it does, owns, and how others talk to it. Give every box one.' },
    notes: { type: 'string', description: 'Markdown: decisions and why, alternatives ruled out, open concerns.' },
    taskIds: {
      type: 'array',
      items: { type: 'string' },
      description: 'Ids of the tasks that build this part.',
    },
  },
  required: ['id', 'label'],
};

const EDGE = {
  type: 'object',
  properties: {
    source: { type: 'string', description: 'Node id.' },
    target: { type: 'string', description: 'Node id.' },
    label: { type: 'string', description: 'What flows along it, e.g. "REST", "publishes events". "" clears it.' },
    dashed: { type: 'boolean', description: 'Optional, async or future connection.' },
    arrows: { type: 'string', enum: ['end', 'both', 'none'], description: 'Arrowheads. Default "end" (source to target).' },
  },
  required: ['source', 'target'],
};

const DIAGRAM = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'Keep an existing id to keep its layout and comments.' },
    title: { type: 'string' },
    nodes: { type: 'array', items: NODE },
    edges: { type: 'array', items: EDGE },
    direction: { type: 'string', enum: ['LR', 'TB'], description: 'Layout flow. Omit it to let Coplan pick what fits the graph.' },
    caption: { type: 'string' },
  },
  required: ['title', 'nodes'],
};

const REVIEW = { type: 'string', enum: ['subagent', 'self', 'user', 'skip'] };

/** What a task says about how it is built: what it waits on, where it lands,
 *  how it is reviewed, which boxes it builds. */
const BUILD_FIELDS: Record<string, unknown> = {
  dependsOn: {
    type: 'array',
    items: { type: 'string' },
    description: 'Ids of tasks that must be done first. Leave out whatever could run in parallel. Subtasks inherit it.',
  },
  branch: { type: 'string', description: 'Git branch the work lands on; subtasks inherit it. Omit for one PR on the current branch.' },
  review: { ...REVIEW, description: 'Only when not the build default: "user" for risky work, "skip" for trivial.' },
  builds: {
    type: 'array',
    items: { type: 'string' },
    description: 'Boxes it builds: node ids (or "diagramId/nodeId"). Given, it replaces the boxes the task built before; [] unlinks it.',
  },
};

/** The task schema, once, as a recursive $ref target (it was inlined four levels deep). */
function taskDefs(build = false): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    id: { type: 'string', description: 'Keep an existing id to keep its status and comments. Name it to refer to it in dependsOn.' },
    title: { type: 'string', description: 'One concrete piece of work.' },
    detail: { type: 'string', description: 'Objective, acceptance criteria, what is out of scope. Markdown.' },
    status: STATUS,
    files: { type: 'array', items: { type: 'string' }, description: 'Files you expect to touch.' },
    ...(build ? BUILD_FIELDS : {}),
    subtasks: { type: 'array', items: { $ref: '#/$defs/task' } },
  };
  return { task: { type: 'object', properties, required: ['title'] } };
}
const TASK_REF = { $ref: '#/$defs/task' };

/** The edits Claude is offered through harness_plan_edit. */
export const AGENT_OPS = [
  'set_meta',
  'upsert_section',
  'upsert_diagram',
  'upsert_task',
  'move_task',
  'move_section',
  'move_diagram',
  'upsert_node',
  'remove_node',
  'upsert_edge',
  'remove_edge',
  'comment',
  'reply',
  'resolve',
  'remove',
  'report',
  'withdraw_proposal',
  'propose',
] as const;

/** The edits a proposal may carry: the daemon's own list, so the two cannot drift. */
export const PROPOSAL_EDIT_OPS: readonly string[] = [...PROPOSABLE_OPS];

const STR_LIST = { type: 'array', items: { type: 'string' } };

/**
 * Every field an op in harness_plan_edit can carry: the union of what the
 * ops in AGENT_OPS take (the daemon's OP_FIELDS, which a test holds this
 * to). Which op takes which is in the tool's description, and the daemon
 * refuses a field the op does not take.
 */
const OP_PROPERTIES: Record<string, unknown> = {
  id: { type: 'string', description: 'The item to change. Omit it on upsert_* to add one.' },
  title: { type: 'string' },
  summary: { type: 'string', description: 'set_meta: the plan summary. Markdown.' },
  body: { type: 'string', description: 'upsert_section: the section body. Markdown.' },
  index: { type: 'integer', minimum: 0, description: 'Position among its siblings, from 0.' },
  expect: {
    type: 'integer',
    description: "upsert_section / upsert_diagram / upsert_task, and the box and arrow ops (the diagram's rev): the rev you read; refused if the item changed since.",
  },
  diagramId: { type: 'string', description: 'upsert_node / remove_node / upsert_edge / remove_edge: the diagram the box or arrow is in.' },
  label: { type: 'string', description: 'upsert_node: the box name. upsert_edge: what flows along it ("" clears it).' },
  description: { type: 'string', description: 'upsert_node: two to four sentences on what the part does, owns, and how others talk to it.' },
  notes: { type: 'string', description: 'upsert_node: Markdown — the decisions about this part and why.' },
  taskIds: { ...STR_LIST, description: 'upsert_node: the tasks that build this box (replaces its links).' },
  from: { type: 'string', description: 'upsert_edge / remove_edge: the box id the arrow starts at.' },
  to: { type: 'string', description: 'upsert_edge / remove_edge: the box id it points to.' },
  dashed: { type: 'boolean', description: 'upsert_edge: optional, async or future.' },
  arrows: { type: 'string', enum: ['end', 'both', 'none'], description: 'upsert_edge: arrowheads.' },
  nodes: { type: 'array', items: NODE, description: 'upsert_diagram: replaces the boxes.' },
  edges: { type: 'array', items: EDGE, description: 'upsert_diagram: replaces the arrows.' },
  direction: { type: 'string', enum: ['LR', 'TB'] },
  caption: { type: 'string' },
  parentId: { description: 'upsert_task (when adding) and move_task: the parent task id, or null for the top level.' },
  detail: {
    type: 'string',
    description: 'upsert_task: objective, acceptance criteria, out of scope (Markdown). upsert_node: a few words on the box, e.g. "Redis, read-through".',
  },
  files: STR_LIST,
  note: { type: 'string', description: 'upsert_task: one line on the task.' },
  dependsOn: { ...STR_LIST, description: 'upsert_task: replaces its dependencies; [] clears them.' },
  branch: { type: 'string', description: 'upsert_task: "" clears it.' },
  review: { type: 'string', enum: [...REVIEW.enum, ''], description: 'upsert_task: "" clears it.' },
  builds: { ...STR_LIST, description: 'upsert_task: the boxes it builds now, as node ids or "diagramId/nodeId" (replaces its links; [] unlinks it).' },
  threadId: { type: 'string', description: 'reply / resolve: the comment thread.' },
  text: { type: 'string', description: 'reply: your reply. report: the build report. Markdown.' },
  checks: {
    type: 'array',
    description: 'report: the final checks, as they came out.',
    items: { type: 'object', properties: { name: { type: 'string' }, ok: { type: 'boolean' }, note: { type: 'string' } }, required: ['name', 'ok'] },
  },
  reason: { type: 'string', description: 'propose: why the plan is better with it. Markdown.' },
  ops: {
    type: 'array',
    minItems: 1,
    maxItems: MAX_PROPOSAL_OPS,
    items: { $ref: '#/$defs/op' },
    description: 'propose: the edits proposed (content ops and set_checks).',
  },
  add: {
    type: 'array',
    description: 'set_checks: checks of the task\'s own, replacing those it had ([] clears them).',
    items: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        run: { type: 'string', description: 'The command, run from the repository root.' },
        stage: { type: 'string', enum: ['implement', 'review'], description: 'Default "review": done waits on it.' },
        optional: { type: 'boolean' },
      },
      required: ['run'],
    },
  },
  skip: { ...STR_LIST, description: 'set_checks: names of the repository\'s checks the task does not run ([] clears it).' },
  resolved: { type: 'boolean' },
  kind: {
    type: 'string',
    enum: ['section', 'diagram', 'task', 'component', 'service', 'datastore', 'queue', 'external', 'actor', 'note'],
    description: 'remove: section, diagram or task. upsert_node: the kind of box.',
  },
  decision: {
    type: 'array',
    items: { type: 'string' },
    description:
      'comment: makes it an open decision the user must answer — the comment is the question, these the choices ([] for an open question). Ask one per call; never decide what is the developers\' to decide.',
  },
  target: {
    type: 'object',
    description:
      'comment: what it is about. kind "plan" (id ""), "section", "diagram" or "task" with its id, or one box or arrow: ' +
      'kind "node" with id "diagramId/nodeId", kind "edge" with id "diagramId/edgeId".',
    properties: {
      kind: { type: 'string', enum: ['plan', 'section', 'diagram', 'task', 'node', 'edge'] },
      id: { type: 'string' },
    },
    required: ['kind', 'id'],
  },
};

export const TOOLS: ToolDef[] = [
  {
    name: 'harness_plan_publish',
    endpoint: 'publish',
    description:
      'Publish the whole plan to the Coplan UI, where the user reads and reshapes it. mode "architect": diagrams first, ' +
      'task ideas linked to the boxes they build (the task list comes after the user confirms the design). mode "tasklist": ' +
      'straight to tasks, for work in one contained area. Replaces the plan; items keep comments, statuses and layout ' +
      'when you keep their ids. Refused if the user changed the plan since you last read it, once the design is confirmed ' +
      '(use harness_tasks_publish), and during a build. ' +
      'Tasks here are the planned tasks, shown on the boxes that link them. Ask the user, with AskUserQuestion in ' +
      'chat (never in the plan), only when a decision cannot be undone or reaches outside this session; decide the ' +
      "rest and write it into the plan (a box's notes, a section), where they can change it. Does not wait for the " +
      'user: afterwards, tell them in chat that the plan is ready.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'What is being built, as a short title.' },
        mode: {
          type: 'string',
          enum: ['architect', 'tasklist'],
          description:
            '"architect": architecture first, for multi-system work, product flows and user journeys. "tasklist": straight ' +
            'to tasks, for targeted work where a diagram adds nothing. Kept when left out.',
        },
        headless: {
          type: 'boolean',
          description:
            'true when the user asked for --headless (no browser can reach the page: a cloud agent, a VM). Coplan keeps ' +
            'the plan in the working directory instead, as a page to publish as an Artifact and as Markdown; the user ' +
            'reviews it there and signs off in chat. Kept for the session once given.',
        },
        summary: {
          type: 'string',
          description:
            'Shown first: your understanding of the problem, how you are approaching it, and why architecture first or ' +
            'straight to tasks. A short paragraph or two. Markdown.',
        },
        sections: {
          type: 'array',
          description: 'Ordered prose sections, e.g. Context, Architecture, Data model, Risks, Out of scope.',
          items: {
            type: 'object',
            properties: { id: { type: 'string' }, title: { type: 'string' }, body: { type: 'string', description: 'Markdown.' } },
            required: ['title', 'body'],
          },
        },
        diagrams: { type: 'array', description: 'Architecture diagrams as boxes and arrows.', items: DIAGRAM },
        tasks: {
          type: 'array',
          description: 'architect: the task ideas, coarse, each with an id the boxes link to. tasklist: the task list itself, in build order.',
          items: TASK_REF,
        },
      },
      required: ['title', 'mode'],
      additionalProperties: false,
      $defs: taskDefs(true),
    },
  },
  {
    name: 'harness_plan_read',
    endpoint: 'read',
    description:
      'Read the plan back, leading with what the user changed since you last read it — the net effect, ' +
      'not each step: parts and connections added, removed or changed, tasks moved or added, and comments. ' +
      'Diagrams come back as an architecture: parts in flow order with their descriptions and decisions, ' +
      'then connections. Call it whenever the ' +
      'user says they have reviewed or updated the plan, and before publishing again. Every item carries its ' +
      'id for harness_plan_edit, and sections, diagrams and tasks their revision (rev) for `expect`.',
    inputSchema: {
      type: 'object',
      properties: {
        changes_only: {
          type: 'boolean',
          description: 'Only what changed and what is waiting on you, not the whole document. Default false.',
        },
        peek: {
          type: 'boolean',
          description:
            'Look without reading: the plan as it stands, but the user\'s changes stay unread for the next real read. ' +
            'For an audit, or a subagent, that must not mark them seen for the agent that has to act on them. Default false.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'harness_plan_check',
    endpoint: 'check',
    description:
      'Audit the plan for what it leaves open: boxes no task builds, tasks that build no box, boxes with no ' +
      'description, tasks with no detail once the task list is being made, box ids shared across diagrams, branch ' +
      'layouts a stack of pull requests cannot follow, and comments from the user nobody answered. Run it before ' +
      'you tell the user the design or the task list is ready, and fix or explain each gap. Reads nothing as seen.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'harness_plan_edit',
    endpoint: 'edit',
    description:
      'Make targeted changes to the plan, all or nothing: {ops: [{op, ...fields}]}. Each field names the op(s) it ' +
      'belongs to in its own description. Ops: set_meta, upsert_section, upsert_diagram, upsert_task, upsert_node, upsert_edge (omit id to add; nodes/edges ' +
      'on a diagram replace the current ones, kept items keep their layout and text unless restated), move_task, move_section, move_diagram, ' +
      'remove_node, remove_edge, remove {kind, id}, comment {target, text} (comment rather than overwrite when unsure), reply, resolve, ' +
      'report, withdraw_proposal. upsert_section, upsert_diagram and upsert_task take expect: the rev you read. ' +
      'propose {title, reason, ops} (alone in the call) suggests a change instead of making it: the user accepts ' +
      '(applied as theirs) or rejects it, and you hear the answer on your next read. Use it to flag a flaw you found, and ' +
      'for what a confirmed or submitted plan no longer lets you change. Refused if it would not apply now. A task\'s ' +
      'checks are the user\'s call, so only proposed: ops [{op: "set_checks", id, add?, skip?}]. ' +
      'Examples: {ops: [{op: "reply", threadId: "c2", text: "Done."}]}; {ops: [{op: "propose", title: "Write-through cache", ' +
      'reason: "Reads go stale.", ops: [{op: "upsert_node", diagramId: "d1", id: "cache", description: "Every write updates it."}]}]}. ' +
      'After the design is confirmed only tasks, task links and comments change; after submit only upsert_task, comment, ' +
      'reply, resolve, report.',
    inputSchema: {
      type: 'object',
      properties: {
        ops: { type: 'array', minItems: 1, items: { $ref: '#/$defs/op' } },
      },
      required: ['ops'],
      additionalProperties: false,
      $defs: {
        op: {
          type: 'object',
          description: 'One edit: "op" plus the fields that op takes (see the tool description).',
          properties: {
            op: { type: 'string', enum: [...new Set([...AGENT_OPS, ...PROPOSAL_EDIT_OPS])] },
            ...OP_PROPERTIES,
          },
          required: ['op'],
          additionalProperties: false,
        },
      },
    },
  },
  {
    name: 'harness_tasks_publish',
    endpoint: 'tasks',
    description:
      'Publish the task list for the design the user confirmed: replaces the task tree and nothing else. Break the ' +
      'planned tasks into focused ones (one objective each), link them with dependsOn (what must be done first — ' +
      'anything without one can run in parallel), say which boxes each builds, and give branches when the work lands ' +
      'as several (stacked) pull requests. Ids you keep keep their status, comments and box links. Then tell the user ' +
      'in chat it is ready to review. The build starts when they say so: here in chat (then call harness_plan_advance) ' +
      'or by submitting the plan in Coplan.',
    inputSchema: {
      type: 'object',
      properties: {
        tasks: { type: 'array', description: 'The task tree, in build order.', items: TASK_REF },
      },
      required: ['tasks'],
      additionalProperties: false,
      $defs: taskDefs(true),
    },
  },
  {
    name: 'harness_plan_advance',
    endpoint: 'advance',
    description:
      'The user told you in chat to go ahead: sign the plan off for them, as Coplan\'s Confirm or Submit would. ' +
      'to "tasks" when they are happy with the design and want the task list; to "build" when they say to build it ' +
      '(from the design or the task list: confirming the design first is optional). Only on their word, quoted in ' +
      'user_said — "looks good, build it" — and decide yourself whether what they said means go ahead. It uses the ' +
      'build settings they last chose in Coplan, or the repository\'s defaults, locks the plan as the page would, shows ' +
      'them in Coplan that it was signed off in chat with their words, and returns the prompt the page would have sent: ' +
      'act on it straight away. Refused if the plan has no tasks to build, or is already past that step.',
    inputSchema: {
      type: 'object',
      properties: {
        to: {
          type: 'string',
          enum: ['tasks', 'build'],
          description: '"tasks": confirm the design and make the task list. "build": submit the plan and build it.',
        },
        user_said: {
          type: 'string',
          description: 'What the user said in chat that means go ahead, in their words. Required.',
        },
      },
      required: ['to', 'user_said'],
      additionalProperties: false,
    },
  },
  {
    name: 'harness_task_next',
    endpoint: 'next',
    description:
      'What can be built now: tasks ready to start (none of their dependencies left), how many to run at once, ' +
      'what is in progress and at which step, and what every other task waits on. Call it when you start the build ' +
      'and whenever a task finishes. Once every task is done, it says how to finish: final checks, report, summary.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'harness_task_brief',
    endpoint: 'brief',
    description:
      "One task's focused brief, self-contained so it can be handed to a subagent as is: the objective and acceptance " +
      'criteria, the boxes it builds with their decisions and connections, what it comes after and before, what is out ' +
      'of scope, its branch, and its implement → review → refine cycle with the exact checks to run.',
    inputSchema: {
      type: 'object',
      properties: { task_id: { type: 'string' } },
      required: ['task_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'harness_task_update',
    endpoint: 'task',
    description:
      'Track progress while you build; the user follows it on the board. in_progress (stage "implement") on start, ' +
      'stage "review"/"refine" through the cycle, report checks, done with a one-line note once review passed, or ' +
      'blocked with a note. Always refused: starting or finishing a task that waits on another, progress on a task ' +
      'with subtasks. Refused when Managed (noted when Tracked): too many at once, review rounds past the limit, done ' +
      'without a passing verdict for the last round (the user\'s, if they review) or with a failing or unreported check, ' +
      'dropping signed-off work.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        status: STATUS,
        stage: { type: 'string', enum: ['implement', 'review', 'refine'], description: 'Step of the cycle; implies in_progress.' },
        checks: {
          type: 'array',
          description: 'The checks just run: the hooks from .coplan/config.json (`coplan check <stage> --json` prints these).',
          items: {
            type: 'object',
            properties: { name: { type: 'string' }, ok: { type: 'boolean' }, note: { type: 'string', description: 'One line: what failed.' } },
            required: ['name', 'ok'],
          },
        },
        note: { type: 'string', description: 'One line: what was done, or what it is blocked on.' },
        verdict: {
          type: 'string',
          enum: ['pass', 'changes'],
          description: "The review's outcome, once it is in: pass, or changes (then refine). Recorded for the task's current review round.",
        },
        summary: { type: 'string', description: 'With verdict: one line on what the review found.' },
        user_approved: {
          type: 'boolean',
          description:
            'Only when the user told you in chat: their verdict on a task they review, another review round past ' +
            'their maximum, more tasks at once, or done although a check fails. Put what they said in `note`.',
        },
      },
      required: ['task_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'harness_branch_update',
    endpoint: 'branch',
    description:
      'Record what became of one of the build\'s branches, so the board shows the stack and harness_task_next can say ' +
      'what to do when it moves: the pull request you opened for it (link, number, state), and later its state ' +
      'again (merged, closed). When a branch below it merges, harness_task_next says to rebase this one onto the base ' +
      'branch and point its pull request there — then record the new base.',
    inputSchema: {
      type: 'object',
      properties: {
        branch: { type: 'string', description: 'One of the plan\'s branches.' },
        pr_url: { type: 'string', description: 'The pull request\'s link.' },
        pr_number: { type: 'integer', minimum: 1 },
        pr_state: { type: 'string', enum: ['draft', 'open', 'merged', 'closed'] },
        base: { type: 'string', description: 'The branch its pull request targets now, when that changed (after a restack).' },
      },
      required: ['branch'],
      additionalProperties: false,
    },
  },
];

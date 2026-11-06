/**
 * Tool definitions exposed to Claude.
 *
 * Descriptions ride along in the session's prompt on every turn, so they are
 * short and carry the whole protocol on their own: publish the plan, tell the
 * user in chat, read it back when they say so, track tasks while working.
 * None of these tools waits for the user, and none asks them anything: every
 * question goes through AskUserQuestion in Claude's own chat.
 */

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
    description: {
      type: 'string',
      description:
        'Two to four sentences: what this part does, what it owns, and how others talk to it. Shown when the ' +
        'user hovers the box, and read back to you as the architecture. Give every box one.',
    },
    notes: {
      type: 'string',
      description: 'Markdown: the decisions about this part and why, the alternatives ruled out, open concerns.',
    },
    taskIds: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Tasks that build this part; the box shows their progress. In a publish, give those tasks an `id` ' +
        '(e.g. "cache-client") so you can refer to them here.',
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

/** Nested task schema, a few levels deep — deep enough for any real breakdown. */
function taskSchema(depth: number, build = false): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    id: { type: 'string', description: 'Keep an existing id to keep its status and comments. Name it to refer to it in dependsOn.' },
    title: { type: 'string', description: 'One concrete piece of work.' },
    detail: { type: 'string', description: 'Objective, acceptance criteria, what is out of scope. Markdown.' },
    status: STATUS,
    files: { type: 'array', items: { type: 'string' }, description: 'Files you expect to touch.' },
    ...(build ? BUILD_FIELDS : {}),
  };
  if (depth > 0) properties['subtasks'] = { type: 'array', items: taskSchema(depth - 1, build) };
  return { type: 'object', properties, required: ['title'] };
}

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
] as const;

/** The edits a proposal may carry (the daemon's PROPOSABLE_OPS). */
export const PROPOSAL_EDIT_OPS = [
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
  'remove',
] as const;

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
  resolved: { type: 'boolean' },
  kind: {
    type: 'string',
    enum: ['section', 'diagram', 'task', 'component', 'service', 'datastore', 'queue', 'external', 'actor', 'note'],
    description: 'remove: section, diagram or task. upsert_node: the kind of box.',
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
      'Publish the whole plan to the Coplan UI, where the user reads it visually, reorganizes it and ' +
      'comments on it. Include: a summary; sections for context, architecture and risks; diagrams of the ' +
      'design as nodes and edges (the UI lays them out and the user can rearrange them); and a task tree ' +
      'broken into subtasks. Replaces the plan; items keep their comments and statuses when you keep their ' +
      'ids, a box keeps its position, detail, description and notes and an arrow between the same two boxes its ' +
      'label and style unless you restate them ("" clears a label). Refused if the user has changed the plan since you last read it, ' +
      'once they confirm the design (then harness_tasks_publish makes the task list), and while it is being built. ' +
      'Tasks here are the planned tasks, shown on the boxes that link them. Ask decisions you need with ' +
      'AskUserQuestion in chat, not in the plan. Does not wait for the user: afterwards, tell them in chat ' +
      'that the plan is ready.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'What is being built, as a short title.' },
        summary: { type: 'string', description: 'One paragraph: the approach and why. Markdown.' },
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
        tasks: { type: 'array', description: 'The task tree, in execution order.', items: taskSchema(3) },
      },
      required: ['title'],
      additionalProperties: false,
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
      'Make targeted changes to the plan, applied together or not at all. Call it as {ops: [ … ]}, where each op ' +
      'is an object with an "op" field and only that op\'s fields: set_meta {title?, summary?}; upsert_section ' +
      '{id?, title?, body?, index?}; upsert_diagram {id?, title?, nodes?, edges?, direction?, caption?, index?} ' +
      '(nodes/edges replace the current ones; a box you keep keeps its position, detail, description and notes, and an ' +
      'arrow between the same two boxes keeps its label, dashed and arrows, unless you give them); upsert_task ' +
      '{id?, parentId?, index?, title?, detail?, files?, note?, dependsOn?, branch?, review?, builds?} ' +
      '(omit id to add; parentId makes it a subtask); move_task {id, parentId, index}; move_section {id, index}; ' +
      'move_diagram {id, index}; one box or arrow without restating the rest — upsert_node {diagramId, id, label?, ' +
      'kind?, detail?, description?, notes?, taskIds?} (only the fields you give change; a new box needs a label), ' +
      'remove_node {diagramId, id} (and its arrows), upsert_edge {diagramId, id?, from?, to?, label?, dashed?, arrows?} ' +
      '(by id to change one — an arrow\'s id is from->to unless the read shows another — or from and to to add one), ' +
      'remove_edge {diagramId, id? | from, to}; comment {target: {kind, id}, text} (start a thread — on a box: kind "node", id ' +
      '"diagramId/nodeId"; when you are unsure of a change, comment rather than overwrite); reply {threadId, text} ' +
      '(reply to a comment); resolve {threadId, resolved}; remove {kind: section|diagram|task, id}; report {text, checks?} ' +
      '(the final build report); withdraw_proposal {id} (take back a proposal of yours). upsert_section, upsert_diagram and upsert_task take expect: the rev you read. ' +
      'To suggest a change rather than make it, use harness_plan_propose. ' +
      'Example: {ops: [{op: "reply", threadId: "c2", text: "Done: split the cache."}]}. Once the user confirms the ' +
      'design only tasks, task links and comments change; once they submit the plan only upsert_task, comment, ' +
      'reply, resolve and report apply.',
    inputSchema: {
      type: 'object',
      properties: {
        ops: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            description: 'One edit: "op" plus the fields that op takes (see the tool description).',
            properties: {
              op: { type: 'string', enum: [...AGENT_OPS] },
              ...OP_PROPERTIES,
            },
            required: ['op'],
            additionalProperties: false,
          },
        },
      },
      required: ['ops'],
      additionalProperties: false,
    },
  },
  {
    name: 'harness_plan_propose',
    endpoint: 'propose',
    description:
      'Suggest a change to the plan instead of making it: a batch of edits (the same ops as harness_plan_edit, for the ' +
      "plan's content — sections, diagrams, boxes, arrows, tasks) that waits for the user. They see it in Coplan beside " +
      'what it changes, with your reason, and accept it (the edits apply, as theirs) or reject it (saying why if they ' +
      'like). Use it when you audit the plan and find something the user should decide — a design flaw, a missing ' +
      'part, a task split — and when the plan is confirmed or submitted, for the changes it no longer lets you make. ' +
      'Nothing changes until they answer; you hear it the next time you read the plan. It is refused if it would ' +
      'not apply to the plan as it is, and goes out of date if what it changes moves first. ' +
      'Example: {title: "Make the cache write-through", reason: "Reads after a write see stale data for up to the TTL.", ' +
      'ops: [{op: "upsert_node", diagramId: "d1", id: "cache", description: "Write-through: every write updates it."}]}.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'What it changes, in a few words.' },
        reason: { type: 'string', description: 'Why the plan is better with it. Markdown.' },
        ops: {
          type: 'array',
          minItems: 1,
          maxItems: 40,
          items: {
            type: 'object',
            description: 'One edit, as in harness_plan_edit.',
            properties: {
              op: { type: 'string', enum: [...PROPOSAL_EDIT_OPS] },
              ...OP_PROPERTIES,
            },
            required: ['op'],
            additionalProperties: false,
          },
        },
      },
      required: ['title', 'reason', 'ops'],
      additionalProperties: false,
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
      'in chat it is ready to review; they submit the plan to start the build.',
    inputSchema: {
      type: 'object',
      properties: {
        tasks: { type: 'array', description: 'The task tree, in build order.', items: taskSchema(3, true) },
      },
      required: ['tasks'],
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
      'Track progress while you build; the user follows it on the board. Mark a task in_progress (stage ' +
      '"implement") when you start it, set stage "review" and "refine" as it goes round its implement → review → ' +
      'refine cycle, report the checks you ran, and mark it done with a one-line note once review passed — or ' +
      'blocked with a note, asking the user with AskUserQuestion. The only way to report progress. Refused: ' +
      'starting or finishing a task that still waits on another; starting more at once than the user allowed; a ' +
      'review round past their limit; done before any review, without a passing verdict for its last review round ' +
      '(the user\'s own, when the user reviews it), or while a check fails or a review check was never reported; ' +
      'progress on a task that has subtasks.',
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

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

const STATUS = { type: 'string', enum: ['todo', 'in_progress', 'blocked', 'done'] };

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

/** Nested task schema, a few levels deep — deep enough for any real breakdown. */
function taskSchema(depth: number): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    id: { type: 'string', description: 'Keep an existing id to keep its status and comments.' },
    title: { type: 'string', description: 'One concrete piece of work.' },
    detail: { type: 'string', description: 'Approach, acceptance criteria, gotchas. Markdown.' },
    status: STATUS,
    files: { type: 'array', items: { type: 'string' }, description: 'Files you expect to touch.' },
  };
  if (depth > 0) properties['subtasks'] = { type: 'array', items: taskSchema(depth - 1) };
  return { type: 'object', properties, required: ['title'] };
}

export const TOOLS: ToolDef[] = [
  {
    name: 'harness_plan_publish',
    endpoint: 'publish',
    description:
      'Publish the whole plan to the Coplan UI, where the user reads it visually, reorganizes it and ' +
      'comments on it. Include: a summary; sections for context, architecture and risks; diagrams of the ' +
      'design as nodes and edges (the UI lays them out and the user can rearrange them); and a task tree ' +
      'broken into subtasks. Replaces the plan; items keep their comments and statuses when you keep their ' +
      'ids, a box keeps its position, description and notes and an arrow between the same two boxes its ' +
      'label and style unless you restate them ("" clears a label). Refused if the user has changed the plan since you last read it, ' +
      'and while they have submitted it to be built (it is locked until every task is done). Ask decisions you need with ' +
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
      'id for harness_plan_edit.',
    inputSchema: {
      type: 'object',
      properties: {
        changes_only: {
          type: 'boolean',
          description: 'Only what changed and what is waiting on you, not the whole document. Default false.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'harness_plan_edit',
    endpoint: 'edit',
    description:
      'Make targeted changes to the plan, applied together or not at all. Each op is an object with an "op" ' +
      'field: set_meta {title?, summary?}; upsert_section {id?, title?, body?, index?}; upsert_diagram {id?, ' +
      'title?, nodes?, edges?, direction?, caption?} (nodes/edges replace the current ones; a box you keep ' +
      'keeps its position, description and notes, and an arrow between the same two boxes keeps its label, ' +
      'dashed and arrows, unless you give them); upsert_task {id?, parentId?, index?, title?, detail?, status?, files?, ' +
      'note?} (omit id to add; parentId makes it a subtask); move_task {id, parentId, index}; reply ' +
      '{threadId, text} (reply to a comment); resolve {threadId, resolved}; remove {kind: ' +
      'section|diagram|task, id}. Once the user submits the plan to be built it is locked: only upsert_task, reply ' +
      'and resolve apply.',
    inputSchema: {
      type: 'object',
      properties: {
        ops: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              op: {
                type: 'string',
                enum: [
                  'set_meta',
                  'upsert_section',
                  'upsert_diagram',
                  'upsert_task',
                  'move_task',
                  'move_section',
                  'move_diagram',
                  'reply',
                  'resolve',
                  'remove',
                ],
              },
            },
            required: ['op'],
          },
        },
      },
      required: ['ops'],
      additionalProperties: false,
    },
  },
  {
    name: 'harness_task_update',
    endpoint: 'task',
    description:
      'Track progress on the plan while you work. Set a task in_progress when you start it and done when it ' +
      'is finished (with a one-line note of what you did), or blocked with a note saying why — and when ' +
      'blocked on a decision, ask it with AskUserQuestion. The user watches these statuses to follow your ' +
      'progression through the plan.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        status: STATUS,
        note: { type: 'string', description: 'One line: what was done, or what it is blocked on.' },
      },
      required: ['task_id', 'status'],
      additionalProperties: false,
    },
  },
];

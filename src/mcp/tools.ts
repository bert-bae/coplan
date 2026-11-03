/**
 * Tool definitions exposed to Claude.
 *
 * Descriptions ride along in the session's prompt on every turn, so they are
 * short and carry the whole protocol on their own: publish the plan, tell the
 * user in chat, read it back when they say so, track tasks while working.
 * None of these tools waits for the user — the conversation happens in chat.
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

const OPTION = {
  anyOf: [
    { type: 'string' },
    {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'The choice, 1-5 words.' },
        description: { type: 'string', description: 'What picking it means, or its trade-off.' },
      },
      required: ['label'],
    },
  ],
};

const QUESTION = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'Keep an existing id to keep its answer and comments.' },
    question: { type: 'string' },
    header: { type: 'string', description: 'Two or three words shown as a chip, e.g. "Storage".' },
    context: { type: 'string', description: 'Why it matters, or what each answer would change. Markdown.' },
    options: { type: 'array', items: OPTION, description: 'Up to 8 suggested answers.' },
    multiSelect: { type: 'boolean' },
    taskId: { type: 'string', description: 'The task this question holds up, if any.' },
  },
  required: ['question'],
};

const NODE = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'Short slug, unique in the diagram, e.g. "api". Edges refer to it.' },
    label: { type: 'string' },
    kind: { type: 'string', enum: ['component', 'service', 'datastore', 'queue', 'external', 'actor', 'note'] },
    detail: { type: 'string', description: 'One line under the label: responsibility or technology.' },
  },
  required: ['id', 'label'],
};

const EDGE = {
  type: 'object',
  properties: {
    source: { type: 'string', description: 'Node id.' },
    target: { type: 'string', description: 'Node id.' },
    label: { type: 'string', description: 'What flows along it, e.g. "REST", "publishes events".' },
    dashed: { type: 'boolean', description: 'Optional, async or future connection.' },
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
    direction: { type: 'string', enum: ['LR', 'TB'], description: 'Layout flow. Default LR.' },
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
      'Publish the whole plan to the harness UI, where the user reads it visually, reorganizes it, comments ' +
      'on it and answers your questions. Include: a summary; sections for context, architecture and risks; ' +
      'diagrams of the design as nodes and edges (the UI lays them out and the user can rearrange them); a ' +
      'task tree broken into subtasks; and every open question you need ' +
      'answered before building. Replaces the plan; items keep their comments and answers when you keep ' +
      'their ids. Refused if the user has changed the plan since you last read it. Does not wait for the ' +
      'user: afterwards, tell them in chat that the plan is ready and end your turn.',
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
        questions: { type: 'array', description: 'Decisions you need from the user.', items: QUESTION },
      },
      required: ['title'],
      additionalProperties: false,
    },
  },
  {
    name: 'harness_plan_read',
    endpoint: 'read',
    description:
      'Read the plan back, leading with everything the user changed since you last read it: edits, moved or ' +
      'added tasks, answers to your questions, questions they asked you, and comments. Call it whenever the ' +
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
      'title?, nodes?, edges?, direction?, caption?} (nodes/edges replace the current ones; positions are ' +
      'kept for node ids you keep); upsert_task {id?, parentId?, index?, title?, detail?, status?, files?, ' +
      'note?} (omit id to add; parentId makes it a subtask); move_task {id, parentId, index}; ' +
      'upsert_question {id?, question?, header?, context?, options?, multiSelect?, taskId?}; answer {id, ' +
      'text?, selected?} (answer a question the user asked you); reply {threadId, text} (reply to a ' +
      'comment); resolve {threadId, resolved}; remove {kind: section|diagram|task|question, id}.',
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
                  'upsert_question',
                  'answer',
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
      'is finished (with a one-line note of what you did), or blocked with a note saying why. The user ' +
      'watches these statuses to follow your progression through the plan.',
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

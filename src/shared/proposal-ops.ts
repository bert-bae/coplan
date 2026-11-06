/**
 * What a proposal may carry, in one small place: the plan engine enforces
 * it, and the MCP server's tool schema offers it — without the server
 * bundling the engine to learn two constants.
 */

/** The edits a proposal may carry: the plan's content — never progress, a
 *  comment, or another proposal. */
export const PROPOSABLE_OPS: ReadonlySet<string> = new Set([
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
]);

export const MAX_PROPOSAL_OPS = 40;

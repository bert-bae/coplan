// src/test/layout.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

// src/ui/lib/layout.ts
import dagre from "@dagrejs/dagre";
function nodeSize(node2) {
  const longest = Math.max(node2.label.length, Math.min(node2.detail?.length ?? 0, 40) * 0.8);
  const width = Math.round(Math.min(240, Math.max(140, longest * 7.5 + 40)));
  const height = node2.detail ? 64 : 44;
  return node2.kind === "datastore" ? { width, height: height + 12 } : { width, height };
}
function autoLayout(diagram, direction) {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: direction, nodesep: 36, ranksep: 70, marginx: 10, marginy: 10 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const node2 of diagram.nodes) g.setNode(node2.id, { ...nodeSize(node2) });
  for (const edge of diagram.edges) {
    if (edge.source !== edge.target) g.setEdge(edge.source, edge.target);
  }
  dagre.layout(g);
  const out = /* @__PURE__ */ new Map();
  for (const node2 of diagram.nodes) {
    const laid = g.node(node2.id);
    if (!laid) continue;
    out.set(node2.id, { x: Math.round(laid.x - laid.width / 2), y: Math.round(laid.y - laid.height / 2) });
  }
  return out;
}
function resolvePositions(diagram) {
  const placed = diagram.nodes.filter((n) => n.x !== void 0 && n.y !== void 0);
  const out = new Map(placed.map((n) => [n.id, { x: n.x, y: n.y }]));
  if (placed.length === diagram.nodes.length) return out;
  const auto = autoLayout(diagram, diagram.direction);
  if (placed.length === 0) return auto;
  let farX = -Infinity;
  let farY = -Infinity;
  for (const n of placed) {
    const size = nodeSize(n);
    farX = Math.max(farX, n.x + size.width);
    farY = Math.max(farY, n.y + size.height);
  }
  const fresh = diagram.nodes.filter((n) => !out.has(n.id));
  const minX = Math.min(...fresh.map((n) => auto.get(n.id)?.x ?? 0));
  const minY = Math.min(...fresh.map((n) => auto.get(n.id)?.y ?? 0));
  for (const n of fresh) {
    const p = auto.get(n.id) ?? { x: 0, y: 0 };
    out.set(
      n.id,
      diagram.direction === "LR" ? { x: p.x - minX + farX + 80, y: p.y } : { x: p.x, y: p.y - minY + farY + 80 }
    );
  }
  return out;
}

// src/test/layout.test.ts
var node = (id, extra = {}) => ({ id, label: id.toUpperCase(), kind: "component", ...extra });
var chain = (direction = "LR") => ({
  direction,
  nodes: [node("a"), node("b"), node("c")],
  edges: [
    { id: "a->b", source: "a", target: "b" },
    { id: "b->c", source: "b", target: "c" }
  ]
});
test("a left-to-right chain is laid out left to right", () => {
  const at = autoLayout(chain(), "LR");
  assert.ok(at.get("a").x < at.get("b").x && at.get("b").x < at.get("c").x);
});
test("a top-to-bottom chain is laid out top to bottom", () => {
  const at = autoLayout(chain("TB"), "TB");
  assert.ok(at.get("a").y < at.get("b").y && at.get("b").y < at.get("c").y);
});
test("saved positions are used as they are", () => {
  const d = chain();
  d.nodes = d.nodes.map((n, i) => ({ ...n, x: i * 10, y: 5 }));
  const at = resolvePositions(d);
  assert.deepEqual(at.get("c"), { x: 20, y: 5 });
});
test("a new node lands clear of the ones the user arranged", () => {
  const d = chain();
  d.nodes = [{ ...d.nodes[0], x: 0, y: 0 }, { ...d.nodes[1], x: 300, y: 0 }, d.nodes[2]];
  const at = resolvePositions(d);
  const farEdge = 300 + nodeSize(d.nodes[1]).width;
  assert.ok(at.get("c").x > farEdge, "past the right edge of the arranged nodes");
  assert.deepEqual(at.get("a"), { x: 0, y: 0 }, "the arranged ones do not move");
});
test("boxes with detail are taller", () => {
  assert.ok(nodeSize(node("a", { detail: "does things" })).height > nodeSize(node("a")).height);
});
//# sourceMappingURL=layout.test.js.map

// src/test/graph.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

// src/ui/lib/graph.ts
var twoWay = (e2) => e2.arrows === "both" || e2.arrows === "none";
function relationsOf(focus, edges, hops = 1) {
  const nodes = /* @__PURE__ */ new Map([[focus, "focus"]]);
  const rels = /* @__PURE__ */ new Map();
  const mark = (id, rel) => {
    const was = nodes.get(id);
    if (was === "focus") return;
    nodes.set(id, !was || was === rel ? rel : "both");
  };
  for (const e2 of edges) {
    if (e2.source === e2.target) continue;
    if (e2.source !== focus && e2.target !== focus) continue;
    const other = e2.source === focus ? e2.target : e2.source;
    if (twoWay(e2)) {
      rels.set(e2.id, "both");
      mark(other, "both");
    } else if (e2.source === focus) {
      rels.set(e2.id, "out");
      mark(other, "to");
    } else {
      rels.set(e2.id, "in");
      mark(other, "from");
    }
  }
  if (hops < 2) return { nodes, edges: rels };
  const first = new Map(nodes);
  const downstream = [...first].filter(([, r]) => r === "to" || r === "both").map(([id]) => id);
  const upstream = [...first].filter(([, r]) => r === "from" || r === "both").map(([id]) => id);
  for (const e2 of edges) {
    if (e2.source === e2.target || rels.has(e2.id)) continue;
    const onward = downstream.includes(e2.source) ? e2.target : twoWay(e2) && downstream.includes(e2.target) ? e2.source : null;
    if (onward && !first.has(onward)) {
      rels.set(e2.id, "out2");
      if (!nodes.has(onward)) nodes.set(onward, "to2");
      continue;
    }
    const back = upstream.includes(e2.target) ? e2.source : twoWay(e2) && upstream.includes(e2.source) ? e2.target : null;
    if (back && !first.has(back)) {
      rels.set(e2.id, "in2");
      if (!nodes.has(back)) nodes.set(back, "from2");
    }
  }
  return { nodes, edges: rels };
}
function bridgeOver(removed, edges) {
  const kept = edges.filter((e2) => !removed.has(e2.source) && !removed.has(e2.target));
  const bridges = [];
  const exists = (s, t) => kept.some((e2) => e2.source === s && e2.target === t) || bridges.some((b) => b.source === s && b.target === t);
  for (const into of edges) {
    if (removed.has(into.source) || !removed.has(into.target)) continue;
    const seen = /* @__PURE__ */ new Set([into.target]);
    const queue = [into.target];
    while (queue.length) {
      const at = queue.shift();
      for (const out of edges) {
        if (out.source !== at) continue;
        if (removed.has(out.target)) {
          if (!seen.has(out.target)) {
            seen.add(out.target);
            queue.push(out.target);
          }
          continue;
        }
        if (out.target === into.source || exists(into.source, out.target)) continue;
        bridges.push({
          source: into.source,
          target: out.target,
          ...into.label ? { label: into.label } : {},
          ...into.dashed || out.dashed ? { dashed: true } : {}
        });
      }
    }
  }
  return { kept, bridges };
}
function splitEdge(edge, id) {
  const style = { ...edge.dashed ? { dashed: true } : {}, ...edge.arrows ? { arrows: edge.arrows } : {} };
  return [
    { source: edge.source, target: id, ...edge.label ? { label: edge.label } : {}, ...style },
    { source: id, target: edge.target, ...style }
  ];
}

// src/ui/lib/history.ts
var History = class {
  constructor(limit = 100) {
    this.limit = limit;
  }
  past = [];
  future = [];
  /** `before` is the state just replaced by a new edit. */
  record(before) {
    this.past.push(before);
    if (this.past.length > this.limit) this.past.shift();
    this.future = [];
  }
  /** The state to go back to, given the one on screen; null if none. */
  undo(current) {
    const before = this.past.pop();
    if (before === void 0) return null;
    this.future.push(current);
    return before;
  }
  redo(current) {
    const after = this.future.pop();
    if (after === void 0) return null;
    this.past.push(current);
    return after;
  }
  clear() {
    this.past = [];
    this.future = [];
  }
  get canUndo() {
    return this.past.length > 0;
  }
  get canRedo() {
    return this.future.length > 0;
  }
};

// src/test/graph.test.ts
var e = (source, target, extra = {}) => ({ id: `${source}->${target}`, source, target, ...extra });
var EDGES = [e("user", "web"), e("web", "gw"), e("gw", "api", { label: "REST" }), e("api", "db"), e("api", "cache"), e("cache", "worker", { arrows: "both" }), e("api", "api")];
test("a box relates to its neighbours by direction", () => {
  const { nodes, edges } = relationsOf("api", EDGES);
  assert.deepEqual(Object.fromEntries(nodes), { api: "focus", gw: "from", db: "to", cache: "to" });
  assert.deepEqual(Object.fromEntries(edges), { "gw->api": "in", "api->db": "out", "api->cache": "out" });
});
test("arrows both ways, or without a direction, make a two-way neighbour", () => {
  assert.equal(relationsOf("cache", EDGES).nodes.get("worker"), "both");
  const both = relationsOf("a", [e("a", "b"), e("b", "a")]);
  assert.equal(both.nodes.get("b"), "both", "an arrow each way is both ways");
});
test("two steps out follows the flow in each direction, never back through the focus", () => {
  const { nodes, edges } = relationsOf("api", EDGES, 2);
  assert.equal(nodes.get("web"), "from2", "upstream of upstream");
  assert.equal(nodes.get("worker"), "to2", "downstream of downstream, across a two-way arrow");
  assert.equal(nodes.has("user"), false, "three steps is too far");
  assert.equal(edges.get("web->gw"), "in2");
  assert.equal(edges.get("cache->worker"), "out2");
  assert.equal(nodes.get("gw"), "from", "first-step relations are not overwritten");
});
test("a box with no connections relates only to itself", () => {
  const { nodes, edges } = relationsOf("lonely", EDGES);
  assert.deepEqual([...nodes], [["lonely", "focus"]]);
  assert.equal(edges.size, 0);
});
test("deleting the middle of a chain joins its ends, keeping what flowed in", () => {
  const { kept, bridges } = bridgeOver(/* @__PURE__ */ new Set(["gw"]), EDGES);
  assert.ok(!kept.some((x) => x.source === "gw" || x.target === "gw"));
  assert.deepEqual(bridges, [{ source: "web", target: "api" }]);
  const labelled = bridgeOver(/* @__PURE__ */ new Set(["api"]), [e("gw", "api", { label: "REST", dashed: true }), e("api", "db")]);
  assert.deepEqual(labelled.bridges, [{ source: "gw", target: "db", label: "REST", dashed: true }]);
});
test("deleting several boxes in a row bridges across all of them", () => {
  const { bridges } = bridgeOver(/* @__PURE__ */ new Set(["web", "gw"]), EDGES);
  assert.deepEqual(bridges, [{ source: "user", target: "api" }]);
});
test("bridging never doubles an arrow or loops a box to itself", () => {
  const { bridges } = bridgeOver(/* @__PURE__ */ new Set(["b"]), [e("a", "b"), e("b", "c"), e("a", "c"), e("c", "b"), e("b", "a")]);
  assert.deepEqual(bridges, [{ source: "c", target: "a" }]);
  const fan = bridgeOver(/* @__PURE__ */ new Set(["hub"]), [e("x", "hub"), e("y", "hub"), e("hub", "p"), e("hub", "q")]);
  assert.equal(fan.bridges.length, 4, "every way in to every way out");
});
test("a box put into an arrow takes its place on both halves", () => {
  const [first, second] = splitEdge(e("a", "c", { label: "events", dashed: true, arrows: "both" }), "b");
  assert.deepEqual(first, { source: "a", target: "b", label: "events", dashed: true, arrows: "both" });
  assert.deepEqual(second, { source: "b", target: "c", dashed: true, arrows: "both" });
});
test("undo steps back through recorded states, redo forward, and a new edit drops the redos", () => {
  const h = new History();
  assert.equal(h.undo(0), null);
  h.record(0);
  h.record(1);
  assert.equal(h.undo(2), 1);
  assert.equal(h.undo(1), 0);
  assert.equal(h.canUndo, false);
  assert.equal(h.redo(0), 1);
  h.record(1);
  assert.equal(h.canRedo, false, "a new edit forgets what was undone");
});
test("history keeps only so many steps", () => {
  const h = new History(3);
  for (let i = 0; i < 10; i++) h.record(i);
  assert.equal(h.undo(10), 9);
  assert.equal(h.undo(9), 8);
  assert.equal(h.undo(8), 7);
  assert.equal(h.undo(7), null);
});
//# sourceMappingURL=graph.test.js.map

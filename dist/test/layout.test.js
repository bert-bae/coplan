// src/test/layout.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

// src/ui/lib/layout.ts
import dagre from "@dagrejs/dagre";
var LABEL_CHAR = 7.4;
var DETAIL_CHAR = 6.1;
var LABEL_CHROME = 70;
var DETAIL_CHROME = 25;
var MIN_WIDTH = 170;
var MAX_WIDTH = 250;
function nodeSize(node2) {
  const label = node2.label.length * LABEL_CHAR;
  const detail = node2.detail ? Math.min(node2.detail.length, 46) * DETAIL_CHAR : 0;
  const raw = Math.max(label + LABEL_CHROME, detail ? detail / (node2.detail.length > 34 ? 2 : 1) + DETAIL_CHROME : 0);
  const width = Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, raw)) / 10) * 10;
  const labelLines = Math.min(2, Math.max(1, Math.ceil(label / (width - LABEL_CHROME))));
  const detailLines = node2.detail ? Math.min(2, Math.max(1, Math.ceil(node2.detail.length * DETAIL_CHAR / (width - DETAIL_CHROME)))) : 0;
  let height = 18 + labelLines * 17 + (detailLines ? 2 + detailLines * 14 : 0) + (node2.taskIds?.length ? 16 : 0);
  if (node2.kind === "datastore") height += 6;
  return { width, height: Math.max(44, height) };
}
function labelSize(label) {
  const text = label.length * 6.2;
  const lines = Math.min(2, Math.ceil(text / 160));
  return { width: Math.round(Math.min(172, text + 14)), height: 8 + lines * 14 };
}
var SPACING = {
  // In LR, nodesep is the vertical gap between boxes in one rank.
  LR: { nodesep: 30, ranksep: 72, edgesep: 14 },
  TB: { nodesep: 44, ranksep: 58, edgesep: 14 }
};
var SHELF_GAP = 72;
var computed = /* @__PURE__ */ new Map();
var COMPUTED_MAX = 16;
function autoLayout(diagram, direction) {
  const key = JSON.stringify([
    direction,
    diagram.nodes.map((n) => [n.id, n.label, n.detail ?? "", n.kind, n.taskIds?.length ? 1 : 0]),
    diagram.edges.map((e) => [e.id, e.source, e.target, e.label ?? ""])
  ]);
  let hit = computed.get(key);
  if (hit) computed.delete(key);
  else hit = seal(computeLayout(diagram, direction));
  computed.set(key, hit);
  if (computed.size > COMPUTED_MAX) computed.delete(computed.keys().next().value);
  return { positions: new Map([...hit.positions].map(([id, p]) => [id, { ...p }])), routes: new Map(hit.routes) };
}
function seal(layout) {
  for (const r of layout.routes.values()) {
    for (const p of r.points) Object.freeze(p);
    Object.freeze(r.points);
    if (r.label) Object.freeze(r.label);
    Object.freeze(r.from);
    Object.freeze(r.to);
    Object.freeze(r);
  }
  return layout;
}
function computeLayout(diagram, direction) {
  const degree = /* @__PURE__ */ new Map();
  for (const e of diagram.edges) {
    if (e.source === e.target) continue;
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  }
  const connected = diagram.nodes.filter((n) => degree.has(n.id));
  const loose = diagram.nodes.filter((n) => !degree.has(n.id));
  const positions = /* @__PURE__ */ new Map();
  const routes = /* @__PURE__ */ new Map();
  if (connected.length) {
    const ids = new Set(connected.map((n) => n.id));
    const g = new dagre.graphlib.Graph({ multigraph: true });
    g.setGraph({ rankdir: direction, ...SPACING[direction], marginx: 0, marginy: 0, acyclicer: "greedy", ranker: "network-simplex" });
    g.setDefaultEdgeLabel(() => ({}));
    for (const n of connected) g.setNode(n.id, { ...nodeSize(n) });
    for (const e of diagram.edges) {
      if (e.source === e.target || !ids.has(e.source) || !ids.has(e.target)) continue;
      g.setEdge(e.source, e.target, e.label ? { ...labelSize(e.label), labelpos: "c" } : { width: 0, height: 0 }, e.id);
    }
    dagre.layout(g);
    for (const n of connected) {
      const laid = g.node(n.id);
      positions.set(n.id, { x: Math.round(laid.x - laid.width / 2), y: Math.round(laid.y - laid.height / 2) });
    }
    for (const e of diagram.edges) {
      const laid = g.edge({ v: e.source, w: e.target, name: e.id });
      if (!laid?.points?.length) continue;
      routes.set(e.id, {
        points: laid.points.map((p) => ({ x: p.x, y: p.y })),
        ...e.label && laid.x !== void 0 && laid.y !== void 0 ? { label: { x: laid.x, y: laid.y } } : {},
        from: positions.get(e.source),
        to: positions.get(e.target)
      });
    }
  }
  shelve(loose, positions, new Map(diagram.nodes.map((n) => [n.id, nodeSize(n)])), direction);
  return normalize({ positions, routes });
}
function shelve(loose, positions, size, direction) {
  if (!loose.length) return;
  const sizes = loose.map((n) => size.get(n.id));
  const bounds = boundsOf(positions, size);
  const gapX = 40;
  const gapY = 32;
  if (!bounds) {
    const cols = Math.max(1, Math.ceil(Math.sqrt(loose.length * 1.6)));
    let y = 0;
    for (let row = 0; row * cols < loose.length; row++) {
      let x = 0;
      const items = loose.slice(row * cols, row * cols + cols);
      let tallest = 0;
      items.forEach((n, i) => {
        const s = sizes[row * cols + i];
        positions.set(n.id, { x, y });
        x += s.width + gapX;
        tallest = Math.max(tallest, s.height);
      });
      y += tallest + gapY;
    }
    return;
  }
  if (direction === "LR") {
    const limit = Math.max(bounds.maxX, bounds.minX + 3 * (MAX_WIDTH + gapX));
    let x = bounds.minX;
    let y = bounds.maxY + SHELF_GAP;
    let tallest = 0;
    loose.forEach((n, i) => {
      const s = sizes[i];
      if (x > bounds.minX && x + s.width > limit) {
        x = bounds.minX;
        y += tallest + gapY;
        tallest = 0;
      }
      positions.set(n.id, { x, y });
      x += s.width + gapX;
      tallest = Math.max(tallest, s.height);
    });
  } else {
    const limit = Math.max(bounds.maxY, bounds.minY + 4 * (60 + gapY));
    let x = bounds.maxX + SHELF_GAP;
    let y = bounds.minY;
    let widest = 0;
    loose.forEach((n, i) => {
      const s = sizes[i];
      if (y > bounds.minY && y + s.height > limit) {
        y = bounds.minY;
        x += widest + gapX;
        widest = 0;
      }
      positions.set(n.id, { x, y });
      y += s.height + gapY;
      widest = Math.max(widest, s.width);
    });
  }
}
function normalize(layout) {
  let minX = Infinity;
  let minY = Infinity;
  for (const p of layout.positions.values()) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
  }
  if (!Number.isFinite(minX) || minX === 0 && minY === 0) return layout;
  const at = (p) => ({ x: Math.round(p.x - minX), y: Math.round(p.y - minY) });
  const positions = new Map([...layout.positions].map(([id, p]) => [id, at(p)]));
  const routes = new Map(
    [...layout.routes].map(([id, r]) => [
      id,
      {
        points: r.points.map((p) => ({ x: p.x - minX, y: p.y - minY })),
        ...r.label ? { label: { x: r.label.x - minX, y: r.label.y - minY } } : {},
        from: at(r.from),
        to: at(r.to)
      }
    ])
  );
  return { positions, routes };
}
function resolveLayout(diagram) {
  const placed = diagram.nodes.filter((n) => n.x !== void 0 && n.y !== void 0);
  const positions = new Map(placed.map((n) => [n.id, { x: n.x, y: n.y }]));
  if (placed.length === diagram.nodes.length && diagram.edges.length === 0) return { positions, routes: /* @__PURE__ */ new Map() };
  const auto = autoLayout(diagram, diagram.direction);
  if (placed.length === 0) return auto;
  if (placed.length < diagram.nodes.length) placeNewcomers(diagram, positions, auto.positions);
  const routes = /* @__PURE__ */ new Map();
  for (const e of diagram.edges) {
    const r = auto.routes.get(e.id);
    if (r && samePoint(positions.get(e.source), r.from) && samePoint(positions.get(e.target), r.to)) routes.set(e.id, r);
  }
  return { positions, routes };
}
var RANK_GAP = 90;
var CLEARANCE = 22;
function placeNewcomers(diagram, positions, auto) {
  const lr = diagram.direction === "LR";
  const size = new Map(diagram.nodes.map((n) => [n.id, nodeSize(n)]));
  const fresh = diagram.nodes.filter((n) => !positions.has(n.id)).sort((a, b) => {
    const pa = auto.get(a.id) ?? { x: 0, y: 0 };
    const pb = auto.get(b.id) ?? { x: 0, y: 0 };
    return lr ? pa.x - pb.x || pa.y - pb.y : pa.y - pb.y || pa.x - pb.x;
  });
  const strays = [];
  for (const n of fresh) {
    const s = size.get(n.id);
    const sources = diagram.edges.filter((e) => e.target === n.id && e.source !== n.id && positions.has(e.source)).map((e) => e.source);
    const targets = diagram.edges.filter((e) => e.source === n.id && e.target !== n.id && positions.has(e.target)).map((e) => e.target);
    const anchors = sources.length ? sources : targets;
    if (!anchors.length) {
      strays.push(n);
      continue;
    }
    const boxes = anchors.map((id) => ({ ...positions.get(id), ...size.get(id) }));
    const centre = {
      x: boxes.reduce((t, b) => t + b.x + b.width / 2, 0) / boxes.length,
      y: boxes.reduce((t, b) => t + b.y + b.height / 2, 0) / boxes.length
    };
    const after = sources.length > 0;
    const want = lr ? {
      x: after ? Math.max(...boxes.map((b) => b.x + b.width)) + RANK_GAP : Math.min(...boxes.map((b) => b.x)) - RANK_GAP - s.width,
      y: centre.y - s.height / 2
    } : {
      x: centre.x - s.width / 2,
      y: after ? Math.max(...boxes.map((b) => b.y + b.height)) + RANK_GAP : Math.min(...boxes.map((b) => b.y)) - RANK_GAP - s.height
    };
    positions.set(n.id, findFreeSpot(want, s, positions, size, lr));
  }
  if (!strays.length) return;
  const sub = autoLayout(
    { nodes: strays.map((n) => ({ ...n, id: n.id })), edges: diagram.edges.filter((e) => strays.some((n) => n.id === e.source) && strays.some((n) => n.id === e.target)) },
    diagram.direction
  );
  const bounds = boundsOf(positions, size);
  for (const n of strays) {
    const p = sub.positions.get(n.id) ?? { x: 0, y: 0 };
    positions.set(n.id, lr ? { x: p.x + bounds.maxX + RANK_GAP, y: p.y + bounds.minY } : { x: p.x + bounds.minX, y: p.y + bounds.maxY + RANK_GAP });
  }
}
function findFreeSpot(want, s, positions, size, lr) {
  const clear = (p) => [...positions].every(([id, q]) => {
    const b = size.get(id) ?? { width: MIN_WIDTH, height: 44 };
    return p.x + s.width + CLEARANCE <= q.x || q.x + b.width + CLEARANCE <= p.x || p.y + s.height + CLEARANCE <= q.y || q.y + b.height + CLEARANCE <= p.y;
  });
  const step = lr ? 26 : 40;
  for (let k = 0; k < 60; k++) {
    const offset = Math.ceil(k / 2) * step * (k % 2 ? 1 : -1);
    const p = lr ? { x: want.x, y: want.y + offset } : { x: want.x + offset, y: want.y };
    if (clear(p)) return { x: Math.round(p.x), y: Math.round(p.y) };
  }
  return findFreeSpot(lr ? { x: want.x + s.width + RANK_GAP, y: want.y } : { x: want.x, y: want.y + s.height + RANK_GAP }, s, positions, size, lr);
}
function boundsOf(positions, size) {
  if (positions.size === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [id, p] of positions) {
    const s = size.get(id) ?? { width: MIN_WIDTH, height: 44 };
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x + s.width);
    maxY = Math.max(maxY, p.y + s.height);
  }
  return { minX, minY, maxX, maxY };
}
function samePoint(a, b) {
  return Boolean(a && b && Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5);
}

// src/test/layout.test.ts
var node = (id, extra = {}) => ({ id, label: id.toUpperCase(), kind: "component", ...extra });
var edge = (source, target, label) => ({ id: `${source}->${target}`, source, target, ...label ? { label } : {} });
var chain = (direction = "LR") => ({
  direction,
  nodes: [node("a"), node("b"), node("c")],
  edges: [edge("a", "b"), edge("b", "c")]
});
var system = (direction = "LR") => ({
  direction,
  nodes: [
    node("user", { kind: "actor", label: "Customer" }),
    node("web", { label: "Web app", detail: "Next.js storefront" }),
    node("gw", { kind: "service", label: "API gateway", detail: "Auth, rate limits" }),
    node("orders", { kind: "service", label: "Orders API", taskIds: ["t1"] }),
    node("cache", { kind: "datastore", label: "Redis", detail: "Read-through, 5 min TTL" }),
    node("db", { kind: "datastore", label: "Postgres" }),
    node("outbox", { kind: "queue", label: "Outbox" }),
    node("inv", { kind: "service", label: "Cache invalidator with a long name that wraps" }),
    node("note", { kind: "note", label: "Stale reads are fine for 5 minutes" }),
    node("later", { label: "Search (later)" })
  ],
  edges: [
    edge("user", "web"),
    edge("web", "gw", "HTTPS"),
    edge("gw", "orders", "REST"),
    edge("orders", "cache", "GET order:{id}"),
    edge("orders", "db", "SQL"),
    edge("db", "outbox", "CDC"),
    edge("outbox", "inv"),
    edge("inv", "cache", "DEL"),
    edge("cache", "orders", "hit")
  ]
});
function overlaps(nodes, at) {
  const out = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i];
      const b = nodes[j];
      const pa = at.get(a.id);
      const pb = at.get(b.id);
      const sa = nodeSize(a);
      const sb = nodeSize(b);
      const apart = pa.x + sa.width <= pb.x || pb.x + sb.width <= pa.x || pa.y + sa.height <= pb.y || pb.y + sb.height <= pa.y;
      if (!apart) out.push(`${a.id}/${b.id}`);
    }
  }
  return out;
}
test("a left-to-right chain is laid out left to right", () => {
  const at = autoLayout(chain(), "LR").positions;
  assert.ok(at.get("a").x < at.get("b").x && at.get("b").x < at.get("c").x);
});
test("a top-to-bottom chain is laid out top to bottom", () => {
  const at = autoLayout(chain("TB"), "TB").positions;
  assert.ok(at.get("a").y < at.get("b").y && at.get("b").y < at.get("c").y);
});
test("a real-sized system opens with nothing on top of anything, either way round", () => {
  for (const direction of ["LR", "TB"]) {
    const d = system(direction);
    const { positions } = autoLayout(d, direction);
    assert.equal(positions.size, d.nodes.length);
    assert.deepEqual(overlaps(d.nodes, positions), [], direction);
  }
});
test("the layout starts at the origin", () => {
  const { positions } = autoLayout(system(), "LR");
  assert.equal(Math.min(...[...positions.values()].map((p) => p.x)), 0);
  assert.equal(Math.min(...[...positions.values()].map((p) => p.y)), 0);
});
test("unconnected boxes go on a shelf under the flow, not beside where it starts", () => {
  const d = system("LR");
  const { positions } = autoLayout(d, "LR");
  const connected = d.nodes.filter((n) => !["note", "later"].includes(n.id));
  const bottom = Math.max(...connected.map((n) => positions.get(n.id).y + nodeSize(n).height));
  for (const id of ["note", "later"]) assert.ok(positions.get(id).y > bottom, `${id} sits below the graph`);
  assert.equal(positions.get("note").y, positions.get("later").y, "side by side on one shelf");
});
test("when the flow runs top to bottom, the shelf is beside it", () => {
  const d = system("TB");
  const { positions } = autoLayout(d, "TB");
  const connected = d.nodes.filter((n) => !["note", "later"].includes(n.id));
  const right = Math.max(...connected.map((n) => positions.get(n.id).x + nodeSize(n).width));
  for (const id of ["note", "later"]) assert.ok(positions.get(id).x > right, `${id} sits to the right`);
});
test("a diagram of loose boxes is a grid, not a line", () => {
  const nodes = Array.from({ length: 6 }, (_, i) => node(`n${i}`));
  const { positions } = autoLayout({ nodes, edges: [] }, "LR");
  const rows = new Set([...positions.values()].map((p) => p.y));
  assert.ok(rows.size >= 2, "more than one row");
  assert.deepEqual(overlaps(nodes, positions), []);
});
test("ranks leave room for the labels on the arrows between them", () => {
  const plain = autoLayout({ nodes: [node("a"), node("b")], edges: [edge("a", "b")] }, "LR").positions;
  const long = "publishes order events to subscribers";
  const labelled = autoLayout({ nodes: [node("a"), node("b")], edges: [edge("a", "b", long)] }, "LR").positions;
  const gap = (at) => at.get("b").x - (at.get("a").x + nodeSize(node("a")).width);
  assert.ok(gap(labelled) >= gap(plain) + labelSize(long).width - 20, "the gap grows by about the label");
});
test("every arrow gets a route from its source to its target, with a place for its label", () => {
  const d = system();
  const { routes, positions } = autoLayout(d, "LR");
  for (const e of d.edges) {
    const r = routes.get(e.id);
    assert.ok(r && r.points.length >= 2, e.id);
    assert.deepEqual(r.from, positions.get(e.source));
    assert.deepEqual(r.to, positions.get(e.target));
    if (e.label) assert.ok(r.label, `${e.id} has a label spot`);
  }
});
test("two arrows between the same boxes are laid out as two", () => {
  const d = { nodes: [node("a"), node("b")], edges: [edge("a", "b", "reads"), { ...edge("a", "b", "writes"), id: "a->b#2" }] };
  const { routes } = autoLayout(d, "LR");
  assert.equal(routes.size, 2);
});
test("saved positions are used as they are", () => {
  const d = chain();
  d.nodes = d.nodes.map((n, i) => ({ ...n, x: i * 10, y: 5 }));
  const { positions, routes } = resolveLayout(d);
  assert.deepEqual(positions.get("c"), { x: 20, y: 5 });
  assert.equal(routes.size, 0, "hand-placed boxes are joined directly, not along a stale route");
});
test("a tidied diagram, saved and reloaded, keeps its routes", () => {
  const d = system();
  const { positions } = autoLayout(d, "LR");
  const saved = { ...d, nodes: d.nodes.map((n) => ({ ...n, ...positions.get(n.id) })) };
  const { routes } = resolveLayout(saved);
  assert.equal(routes.size, d.edges.length);
});
test("a box added to an arranged diagram lands beside what it connects to", () => {
  const d = chain();
  d.nodes = [{ ...d.nodes[0], x: 0, y: 0 }, { ...d.nodes[1], x: 300, y: 0 }, { ...d.nodes[2], x: 600, y: 0 }, node("d")];
  d.edges = [...d.edges, edge("b", "d")];
  const { positions } = resolveLayout(d);
  const at = positions.get("d");
  assert.ok(at.x > 300 + nodeSize(d.nodes[1]).width, "after its source along the flow");
  assert.ok(at.x < 600 + nodeSize(d.nodes[2]).width, "not off past the far edge");
  assert.deepEqual(overlaps(d.nodes, positions), [], "and on top of nothing");
  assert.deepEqual(positions.get("a"), { x: 0, y: 0 }, "the arranged ones do not move");
});
test("a box with only a target lands before it", () => {
  const d = chain();
  d.nodes = [{ ...d.nodes[0], x: 400, y: 0 }, { ...d.nodes[1], x: 700, y: 0 }, { ...d.nodes[2], x: 1e3, y: 0 }, node("z")];
  d.edges = [...d.edges, edge("z", "a")];
  const at = resolveLayout(d).positions.get("z");
  assert.ok(at.x + nodeSize(node("z")).width < 400);
});
test("a new box with no placed neighbours goes past the arranged ones", () => {
  const d = chain();
  d.nodes = [{ ...d.nodes[0], x: 0, y: 0 }, { ...d.nodes[1], x: 300, y: 0 }, d.nodes[2], node("lone")];
  d.edges = [edge("a", "b")];
  const { positions } = resolveLayout(d);
  const farEdge = 300 + nodeSize(d.nodes[1]).width;
  assert.ok(positions.get("lone").x > farEdge);
  assert.deepEqual(overlaps(d.nodes, positions), []);
});
test("boxes with a subtitle or linked tasks are taller; long labels wrap rather than run on", () => {
  assert.ok(nodeSize(node("a", { detail: "does things" })).height > nodeSize(node("a")).height);
  assert.ok(nodeSize(node("a", { taskIds: ["t1"] })).height > nodeSize(node("a")).height);
  const long = nodeSize(node("a", { label: "A component with a really very long name indeed" }));
  assert.ok(long.width <= 250 && long.height > nodeSize(node("a")).height);
});
test("the same graph is laid out once, however often it is asked for", () => {
  const d = system();
  const first = autoLayout(d, "LR");
  const route = (l) => l.routes.get("web->gw");
  const dragged = autoLayout({ ...d, nodes: d.nodes.map((n) => ({ ...n, x: 99, y: 99 })) }, "LR");
  assert.equal(route(dragged), route(first), "where boxes sit is not part of it: the same work, reused");
  assert.deepEqual([...dragged.positions], [...first.positions]);
  const renamed = autoLayout({ ...d, nodes: d.nodes.map((n) => n.id === "web" ? { ...n, label: "Web storefront" } : n) }, "LR");
  assert.notEqual(route(renamed), route(first), "what changes a box's size is");
  assert.notEqual(route(autoLayout(d, "TB")), route(first));
});
test("a cached layout cannot be changed through what it hands out", () => {
  const d = system();
  const first = autoLayout(d, "LR");
  first.positions.get("web").x += 500;
  assert.notEqual(autoLayout(d, "LR").positions.get("web").x, first.positions.get("web").x, "positions are copies");
  assert.throws(() => {
    "use strict";
    first.routes.get("web->gw").points[0].x = 1;
  }, TypeError, "routes are frozen");
});
//# sourceMappingURL=layout.test.js.map

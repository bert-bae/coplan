// src/test/canvas-lib.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

// src/ui/lib/geometry.ts
function centre(r) {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}
function facingSides(a, b, direction = "LR") {
  const ca = centre(a);
  const cb = centre(b);
  const dx = cb.x - ca.x;
  const dy = cb.y - ca.y;
  const gapX = Math.abs(dx) - (a.width + b.width) / 2;
  const gapY = Math.abs(dy) - (a.height + b.height) / 2;
  const horizontal = dx >= 0 ? ["right", "left"] : ["left", "right"];
  const vertical = dy >= 0 ? ["bottom", "top"] : ["top", "bottom"];
  if (gapX > 0 && gapY > 0) {
    if (direction === "LR") return gapY > gapX * 2.5 ? vertical : horizontal;
    return gapX > gapY * 2.5 ? horizontal : vertical;
  }
  if (gapX > 0) return horizontal;
  if (gapY > 0) return vertical;
  return Math.abs(dx) / (a.width || 1) >= Math.abs(dy) / (a.height || 1) ? horizontal : vertical;
}
function clipToRect(r, toward) {
  const c = centre(r);
  const dx = toward.x - c.x;
  const dy = toward.y - c.y;
  if (dx === 0 && dy === 0) return c;
  const sx = dx ? r.width / 2 / Math.abs(dx) : Infinity;
  const sy = dy ? r.height / 2 / Math.abs(dy) : Infinity;
  const s = Math.min(sx, sy);
  return { x: c.x + dx * s, y: c.y + dy * s };
}
function splinePath(points) {
  if (points.length === 0) return "";
  const f = (n) => Math.round(n * 10) / 10;
  if (points.length === 1) return `M${f(points[0].x)},${f(points[0].y)}`;
  if (points.length === 2) return `M${f(points[0].x)},${f(points[0].y)}L${f(points[1].x)},${f(points[1].y)}`;
  let d = `M${f(points[0].x)},${f(points[0].y)}`;
  let x0 = points[0].x;
  let y0 = points[0].y;
  let x1 = points[1].x;
  let y1 = points[1].y;
  d += `L${f((5 * x0 + x1) / 6)},${f((5 * y0 + y1) / 6)}`;
  for (let i = 2; i < points.length; i++) {
    const { x, y } = points[i];
    d += `C${f((2 * x0 + x1) / 3)},${f((2 * y0 + y1) / 3)} ${f((x0 + 2 * x1) / 3)},${f((y0 + 2 * y1) / 3)} ${f((x0 + 4 * x1 + x) / 6)},${f((y0 + 4 * y1 + y) / 6)}`;
    x0 = x1;
    y0 = y1;
    x1 = x;
    y1 = y;
  }
  d += `C${f((2 * x0 + x1) / 3)},${f((2 * y0 + y1) / 3)} ${f((x0 + 2 * x1) / 3)},${f((y0 + 2 * y1) / 3)} ${f((x0 + 5 * x1) / 6)},${f((y0 + 5 * y1) / 6)}`;
  d += `L${f(x1)},${f(y1)}`;
  return d;
}
function lanes(edges2) {
  const groups = /* @__PURE__ */ new Map();
  for (const e of edges2) {
    if (e.source === e.target) continue;
    const key = [e.source, e.target].sort().join("\0");
    groups.set(key, [...groups.get(key) ?? [], e.id]);
  }
  const out = /* @__PURE__ */ new Map();
  for (const ids of groups.values()) {
    if (ids.length < 2) continue;
    ids.forEach((id, i) => out.set(id, (i - (ids.length - 1) / 2) * 14));
  }
  return out;
}

// src/shared/types.ts
var NODE_KINDS = ["component", "service", "datastore", "queue", "external", "actor", "note"];
var EDGE_ARROWS = ["end", "both", "none"];

// src/ui/lib/clipboard.ts
var CLIP_KIND = "cc-harness/diagram-selection";
function toClip(nodes2, edges2) {
  if (!nodes2.length) return null;
  const ids = new Set(nodes2.map((n) => n.id));
  return {
    kind: CLIP_KIND,
    version: 1,
    nodes: nodes2.map((n) => strip({ ...n })),
    edges: edges2.filter((e) => ids.has(e.source) && ids.has(e.target)).map((e) => strip({ ...e }))
  };
}
function serializeClip(clip) {
  return JSON.stringify(clip);
}
function parseClip(text) {
  if (!text || !text.includes(CLIP_KIND)) return null;
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const r = raw;
  if (!r || r.kind !== CLIP_KIND || !Array.isArray(r.nodes) || !Array.isArray(r.edges)) return null;
  const str = (v, max) => typeof v === "string" && v.trim() ? v.slice(0, max) : void 0;
  const num = (v) => typeof v === "number" && Number.isFinite(v) ? v : 0;
  const nodes2 = [];
  for (const n of r.nodes.slice(0, 120)) {
    const o = n;
    const id = str(o?.["id"], 60);
    if (!id || nodes2.some((x) => x.id === id)) continue;
    nodes2.push(
      strip({
        id,
        label: str(o["label"], 120) ?? id,
        kind: NODE_KINDS.includes(o["kind"]) ? o["kind"] : "component",
        detail: str(o["detail"], 400),
        description: str(o["description"], 4e3),
        notes: str(o["notes"], 2e4),
        taskIds: Array.isArray(o["taskIds"]) ? o["taskIds"].filter((t) => typeof t === "string") : void 0,
        x: num(o["x"]),
        y: num(o["y"])
      })
    );
  }
  if (!nodes2.length) return null;
  const ids = new Set(nodes2.map((n) => n.id));
  const edges2 = [];
  for (const e of r.edges.slice(0, 300)) {
    const o = e;
    const source = str(o?.["source"], 60);
    const target = str(o?.["target"], 60);
    if (!source || !target || !ids.has(source) || !ids.has(target)) continue;
    const arrows = EDGE_ARROWS.includes(o["arrows"]) ? o["arrows"] : void 0;
    edges2.push(strip({ source, target, label: str(o["label"], 120), dashed: o["dashed"] === true ? true : void 0, arrows: arrows === "end" ? void 0 : arrows }));
  }
  return { kind: CLIP_KIND, version: 1, nodes: nodes2, edges: edges2 };
}
function pasteClip(clip, taken, tasks, offset) {
  const used = new Set(taken);
  const ids = /* @__PURE__ */ new Map();
  for (const n of clip.nodes) {
    const id = freeId(n.id, used);
    used.add(id);
    ids.set(n.id, id);
  }
  const nodes2 = clip.nodes.map(
    (n) => strip({
      ...n,
      id: ids.get(n.id),
      taskIds: n.taskIds?.filter((t) => tasks.has(t)),
      x: Math.round(n.x + offset.x),
      y: Math.round(n.y + offset.y)
    })
  );
  const edges2 = clip.edges.map((e) => ({ ...e, source: ids.get(e.source), target: ids.get(e.target) }));
  return { nodes: nodes2, edges: edges2 };
}
function freeId(wanted, used) {
  if (!used.has(wanted)) return wanted;
  const base = wanted.replace(/-\d+$/, "").slice(0, 54);
  for (let n = 2; ; n++) {
    const id = `${base}-${n}`;
    if (!used.has(id)) return id;
  }
}
function strip(o) {
  for (const key of Object.keys(o)) {
    const v = o[key];
    if (v === void 0 || Array.isArray(v) && v.length === 0) delete o[key];
  }
  return o;
}

// src/test/canvas-lib.test.ts
var box = (x, y, width = 200, height = 50) => ({ x, y, width, height });
test("boxes side by side are joined side to side; stacked ones top to bottom", () => {
  assert.deepEqual(facingSides(box(0, 0), box(400, 0)), ["right", "left"]);
  assert.deepEqual(facingSides(box(400, 0), box(0, 0)), ["left", "right"]);
  assert.deepEqual(facingSides(box(0, 0), box(0, 200)), ["bottom", "top"]);
  assert.deepEqual(facingSides(box(0, 200), box(0, 0)), ["top", "bottom"]);
});
test("a diagonal follows the flow: sideways left to right, downwards top to bottom", () => {
  assert.deepEqual(facingSides(box(0, 0), box(300, 150), "LR"), ["right", "left"]);
  assert.deepEqual(facingSides(box(0, 0), box(300, 150), "TB"), ["bottom", "top"]);
});
test("a route is clipped to where it leaves the real box", () => {
  assert.deepEqual(clipToRect(box(0, 0, 100, 40), { x: 300, y: 20 }), { x: 100, y: 20 });
  assert.deepEqual(clipToRect(box(0, 0, 100, 40), { x: 50, y: -200 }), { x: 50, y: 0 });
});
test("a spline starts on the first point and ends on the last", () => {
  const d = splinePath([
    { x: 0, y: 0 },
    { x: 50, y: 80 },
    { x: 100, y: 0 }
  ]);
  assert.match(d, /^M0,0/);
  assert.match(d, /L100,0$/);
  assert.equal(splinePath([{ x: 0, y: 0 }, { x: 10, y: 10 }]), "M0,0L10,10");
});
test("arrows between the same two boxes are drawn apart, either way round", () => {
  const offsets = lanes([
    { id: "a", source: "x", target: "y" },
    { id: "b", source: "y", target: "x" },
    { id: "c", source: "x", target: "z" }
  ]);
  assert.equal(offsets.get("a"), -offsets.get("b"));
  assert.notEqual(offsets.get("a"), 0);
  assert.equal(offsets.has("c"), false, "a lone arrow keeps the middle");
});
var nodes = [
  { id: "api", label: "API", kind: "service", description: "Takes requests.", x: 100, y: 100 },
  { id: "db", label: "Postgres", kind: "datastore", taskIds: ["t1", "gone"], x: 400, y: 100 }
];
var edges = [
  { source: "api", target: "db", label: "SQL" },
  { source: "api", target: "elsewhere" }
];
test("a copy carries the boxes and only the arrows between them", () => {
  const clip = toClip(nodes, edges);
  assert.equal(clip.kind, CLIP_KIND);
  assert.deepEqual(clip.edges, [{ source: "api", target: "db", label: "SQL" }]);
  assert.deepEqual(parseClip(serializeClip(clip)), clip, "and survives the clipboard");
});
test("anything else on the clipboard is not a copy", () => {
  assert.equal(parseClip("hello"), null);
  assert.equal(parseClip(`{"kind":"${CLIP_KIND}","nodes":"nope","edges":[]}`), null);
  assert.equal(parseClip(`{"kind":"${CLIP_KIND}"`), null, "truncated");
  const odd = parseClip(JSON.stringify({ kind: CLIP_KIND, version: 1, nodes: [{ id: "a", kind: "spaceship", x: "far" }], edges: [{ source: "a", target: "b" }] }));
  assert.deepEqual(odd.nodes, [{ id: "a", label: "a", kind: "component", x: 0, y: 0 }], "odd fields are made safe");
  assert.deepEqual(odd.edges, [], "an arrow to a box not in the copy is dropped");
});
test("pasting renames what collides, drops links to tasks this plan lacks, and keeps the shape", () => {
  const clip = toClip(nodes, edges);
  const pasted = pasteClip(clip, ["api", "cache"], /* @__PURE__ */ new Set(["t1"]), { x: 32, y: 32 });
  assert.deepEqual(
    pasted.nodes.map((n) => [n.id, n.x, n.y]),
    [
      ["api-2", 132, 132],
      ["db", 432, 132]
    ]
  );
  assert.deepEqual(pasted.nodes[1].taskIds, ["t1"]);
  assert.equal(pasted.nodes[0].description, "Takes requests.");
  assert.deepEqual(pasted.edges, [{ source: "api-2", target: "db", label: "SQL" }]);
});
test("a copy of a copy counts on rather than stacking suffixes", () => {
  assert.equal(freeId("cache", /* @__PURE__ */ new Set(["cache"])), "cache-2");
  assert.equal(freeId("cache-2", /* @__PURE__ */ new Set(["cache", "cache-2"])), "cache-3");
  assert.equal(freeId("x".repeat(60), /* @__PURE__ */ new Set(["x".repeat(60)])).length <= 60, true);
});
//# sourceMappingURL=canvas-lib.test.js.map

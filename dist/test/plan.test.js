// src/test/plan.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

// src/shared/types.ts
var NODE_KINDS = ["component", "service", "datastore", "queue", "external", "actor", "note"];
var EDGE_ARROWS = ["end", "both", "none"];
var TASK_STATUSES = ["todo", "in_progress", "blocked", "done"];

// src/shared/plan.ts
var PlanError = class extends Error {
};
var MAX_CHANGES = 500;
var MAX_TITLE = 200;
var MAX_TEXT = 2e4;
var MAX_TASKS = 400;
var MAX_SECTIONS = 60;
var MAX_DIAGRAMS = 40;
var MAX_THREADS = 500;
var MAX_REPLIES = 200;
function emptyPlan(title = "Untitled plan", now = Date.now()) {
  return {
    title,
    summary: "",
    sections: [],
    diagrams: [],
    tasks: [],
    threads: [],
    changes: [],
    seq: 0,
    version: 0,
    claudeReadSeq: 0,
    claudeReadAt: null,
    revision: 0,
    createdAt: now,
    updatedAt: now
  };
}
var PREFIX = { section: "s", diagram: "d", task: "t", thread: "c" };
function nextId(plan, kind) {
  const prefix = PREFIX[kind];
  let max = 0;
  const scan = (id) => {
    if (!id.startsWith(prefix)) return;
    const n = Number(id.slice(prefix.length));
    if (Number.isInteger(n) && n > max) max = n;
  };
  for (const s of plan.sections) scan(s.id);
  for (const d of plan.diagrams) scan(d.id);
  for (const t of plan.tasks) scan(t.id);
  for (const c of plan.threads) scan(c.id);
  for (const ch of plan.changes) scan(ch.target.id);
  return `${prefix}${max + 1}`;
}
function idTaken(plan, id) {
  return plan.sections.some((s) => s.id === id) || plan.diagrams.some((d) => d.id === id) || plan.tasks.some((t) => t.id === id) || plan.threads.some((c) => c.id === id);
}
function claimId(plan, kind, wanted) {
  const id = clean(wanted, 40);
  if (id && /^[A-Za-z0-9_.-]+$/.test(id) && !idTaken(plan, id)) return id;
  return nextId(plan, kind);
}
function record(plan, author, kind, target, summary, now) {
  plan.seq += 1;
  plan.version += 1;
  const change = { seq: plan.seq, ts: now, author, kind, target, summary };
  plan.changes.push(change);
  if (plan.changes.length > MAX_CHANGES) plan.changes.splice(0, plan.changes.length - MAX_CHANGES);
  plan.updatedAt = now;
  return change;
}
function unreadByClaude(plan) {
  if (!plan) return [];
  return plan.changes.filter((c) => c.seq > plan.claudeReadSeq && c.author === "user");
}
function unreadItems(plan) {
  return new Set(unreadByClaude(plan).map((c) => `${c.target.kind}:${c.target.id}`)).size;
}
var RENAMED_PLAN = "renamed the plan";
function unreadAreas(plan) {
  const areas = [];
  const add = (what) => void (areas.includes(what) || areas.push(what));
  for (const c of unreadByClaude(plan)) {
    if (["commented", "replied", "resolved", "reopened"].includes(c.kind)) add("comments");
    else if (c.target.kind === "diagram") add(`the "${plan.diagrams.find((d) => d.id === c.target.id)?.title ?? c.target.id}" diagram`);
    else if (c.target.kind === "task") add("tasks");
    else if (c.target.kind === "section") add("sections");
    else if (c.summary.startsWith(RENAMED_PLAN)) add("the plan's title");
    else add("the summary");
  }
  return areas;
}
function markReadByClaude(plan, now = Date.now()) {
  plan.claudeReadSeq = plan.seq;
  plan.claudeReadAt = now;
  plan.claudeBaseline = baselineOf(plan);
}
function settleClaudeRead(plan) {
  if (unreadByClaude(plan).length > 0) return;
  plan.claudeReadSeq = plan.seq;
  plan.claudeBaseline = baselineOf(plan);
}
function foldClaudeEdit(base, before, after) {
  const out = structuredClone(base);
  if (before.title !== after.title) out.title = after.title;
  if (before.summary !== after.summary) out.summary = after.summary;
  out.sections = foldList(out.sections, before.sections, after.sections, foldFields);
  out.tasks = foldList(out.tasks, before.tasks, after.tasks, foldFields);
  out.diagrams = foldList(out.diagrams, before.diagrams, after.diagrams, (o, b, a) => {
    const { nodes: _on, edges: _oe, ...meta } = o;
    const { nodes: _bn, edges: _be, ...bMeta } = b;
    const { nodes: _an, edges: _ae, ...aMeta } = a;
    return {
      ...foldFields(meta, bMeta, aMeta),
      nodes: foldList(o.nodes, b.nodes, a.nodes, foldFields),
      edges: foldEdges(o.edges, b.edges, a.edges)
    };
  });
  return out;
}
function foldFields(o, b, a) {
  const out = { ...o };
  const was = b;
  const now = a;
  for (const key of /* @__PURE__ */ new Set([...Object.keys(was), ...Object.keys(now)])) {
    if (JSON.stringify(was[key]) === JSON.stringify(now[key])) continue;
    if (now[key] === void 0) delete out[key];
    else out[key] = structuredClone(now[key]);
  }
  return out;
}
function foldList(base, before, after, merge) {
  const has = (list, id) => list.some((x) => x.id === id);
  let out = base.filter((x) => !(has(before, x.id) && !has(after, x.id)));
  for (const a of after) {
    const b = before.find((x) => x.id === a.id);
    const i = out.findIndex((x) => x.id === a.id);
    if (b && i >= 0 && JSON.stringify(b) !== JSON.stringify(a)) out[i] = merge(out[i], b, a);
  }
  const order = (list) => list.filter((x) => has(after, x.id) && has(before, x.id)).map((x) => x.id).join("\0");
  if (order(before) !== order(after)) {
    const at = new Map(after.map((x, i) => [x.id, i]));
    let last = -1;
    const rank = new Map(
      out.map((x) => {
        const i = at.get(x.id);
        if (i !== void 0) last = i;
        return [x.id, i ?? last + 0.5];
      })
    );
    out = [...out].sort((x, y) => rank.get(x.id) - rank.get(y.id));
  }
  after.forEach((a, i) => {
    if (has(before, a.id) || has(out, a.id)) return;
    let at = 0;
    for (let j = i - 1; j >= 0; j--) {
      const k = out.findIndex((x) => x.id === after[j].id);
      if (k >= 0) {
        at = k + 1;
        break;
      }
    }
    out.splice(at, 0, structuredClone(a));
  });
  return out;
}
function sameContent(a, b) {
  return canonical(a) === canonical(b);
}
function canonical(value, key = "") {
  if (Array.isArray(value)) {
    const items = value.map((v) => canonical(v));
    if (key === "edges") items.sort();
    return `[${items.join(",")}]`;
  }
  if (value && typeof value === "object") {
    const o = value;
    const keys = Object.keys(o).filter((k) => o[k] !== void 0).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(o[k], k)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
function foldEdges(base, before, after) {
  const claude = matchEdges(before, after);
  let out = [...base];
  for (const gone of claude.removed) {
    const hit = matchEdges(out, [gone]).pairs[0]?.[0];
    if (hit) out = out.filter((e) => e !== hit);
  }
  for (const [b, a] of claude.pairs) {
    if (JSON.stringify(b) === JSON.stringify(a)) continue;
    const hit = matchEdges(out, [b]).pairs[0]?.[0];
    if (hit) out = out.map((e) => e === hit ? foldFields(e, b, a) : e);
  }
  return [...out, ...claude.added.map((e) => structuredClone(e))];
}
function validBaseline(raw) {
  const b = raw;
  const str = (v) => typeof v === "string";
  const list = (v, ok) => Array.isArray(v) && v.every((x) => x !== null && typeof x === "object" && ok(x));
  const whole = b !== null && typeof b === "object" && str(b.title) && str(b.summary) && list(b.sections, (x) => str(x["id"]) && str(x["title"]) && str(x["body"])) && list(b.tasks, (x) => str(x["id"]) && str(x["title"]) && str(x["status"]) && typeof x["order"] === "number") && list(
    b.diagrams,
    (x) => str(x["id"]) && str(x["title"]) && list(x["nodes"], (n) => str(n["id"]) && str(n["label"]) && str(n["kind"])) && list(x["edges"], (e) => str(e["source"]) && str(e["target"]))
  );
  return whole ? b : void 0;
}
function baselineOf(plan) {
  return structuredClone({
    title: plan.title,
    summary: plan.summary,
    sections: plan.sections.map(({ id, title, body }) => ({ id, title, body })),
    diagrams: plan.diagrams.map((d) => ({
      id: d.id,
      title: d.title,
      ...d.caption ? { caption: d.caption } : {},
      nodes: d.nodes.map(({ x: _x, y: _y, ...node }) => node),
      edges: d.edges
    })),
    tasks: plan.tasks.map(({ id, parentId, order, title, detail, status, files, note }) => ({
      id,
      parentId,
      order,
      title,
      status,
      ...detail ? { detail } : {},
      ...files?.length ? { files } : {},
      ...note ? { note } : {}
    }))
  });
}
function publishPlan(prev, input, now = Date.now()) {
  if (prev && unreadByClaude(prev).length > 0) {
    throw new PlanError(
      `The user has changed ${unreadItems(prev)} item(s) in the plan since you last read it. Call harness_plan_read first, then publish again (or use harness_plan_edit for targeted changes) so their edits are not overwritten.`
    );
  }
  const title = clean(input.title, MAX_TITLE);
  if (!title) throw new PlanError("A plan needs a title.");
  const base = prev ? structuredClone(prev) : emptyPlan(title, now);
  const next = { ...base, title, summary: clean(input.summary, MAX_TEXT) ?? base.summary };
  if ((input.sections?.length ?? 0) > MAX_SECTIONS) throw new PlanError(`A plan holds at most ${MAX_SECTIONS} sections.`);
  if ((input.diagrams?.length ?? 0) > MAX_DIAGRAMS) throw new PlanError(`A plan holds at most ${MAX_DIAGRAMS} diagrams.`);
  const sections = [];
  for (const raw of input.sections ?? []) {
    const old = base.sections.find((s) => s.id === raw.id);
    const id = old ? old.id : claimIdAmong(next, "section", raw.id, sections);
    const body = clean(raw.body, MAX_TEXT) ?? "";
    const sTitle = clean(raw.title, MAX_TITLE) ?? "Untitled";
    const same = old && old.title === sTitle && old.body === body;
    sections.push({
      id,
      title: sTitle,
      body,
      rev: same ? old.rev : (old?.rev ?? 0) + 1,
      updatedAt: same ? old.updatedAt : now,
      updatedBy: same ? old.updatedBy : "claude"
    });
  }
  const tasks = [];
  const walk = (list, parentId) => {
    (list ?? []).forEach((raw, order) => {
      if (tasks.length >= MAX_TASKS) throw new PlanError(`A plan holds at most ${MAX_TASKS} tasks.`);
      const tTitle = clean(raw?.title, MAX_TITLE);
      if (!tTitle) throw new PlanError("Every task needs a title.");
      const old = base.tasks.find((t) => t.id === raw.id);
      const id = old && !tasks.some((t) => t.id === old.id) ? old.id : claimIdAmong(next, "task", raw.id, tasks);
      const status = validStatus(raw.status) ?? old?.status ?? "todo";
      const detail = clean(raw.detail, MAX_TEXT);
      const note = clean(raw.note, MAX_TITLE * 2) ?? old?.note;
      const files = cleanList(raw.files) ?? old?.files;
      tasks.push({
        id,
        parentId,
        order,
        title: tTitle,
        ...detail ? { detail } : {},
        status,
        ...files?.length ? { files } : {},
        ...note ? { note } : {},
        createdAt: old?.createdAt ?? now,
        updatedAt: now,
        createdBy: old?.createdBy ?? "claude"
      });
      walk(raw.subtasks, id);
    });
  };
  walk(input.tasks, null);
  const diagrams = [];
  for (const raw of input.diagrams ?? []) {
    const old = base.diagrams.find((d) => d.id === raw.id);
    const id = old ? old.id : claimIdAmong(next, "diagram", raw.id, diagrams);
    const dTitle = clean(raw.title, MAX_TITLE) ?? "Diagram";
    const caption = clean(raw.caption, MAX_TEXT);
    const graph = buildGraph(raw.nodes ?? [], raw.edges ?? [], old, dTitle, new Set(tasks.map((t) => t.id)));
    const direction = validDirection(raw.direction) ?? old?.direction ?? suggestDirection(graph.nodes, graph.edges);
    const same = old && old.title === dTitle && old.caption === caption && old.direction === direction && JSON.stringify([old.nodes, old.edges]) === JSON.stringify([graph.nodes, graph.edges]);
    diagrams.push({
      id,
      title: dTitle,
      rev: same ? old.rev : (old?.rev ?? 0) + 1,
      ...graph,
      direction,
      ...caption ? { caption } : {},
      updatedAt: same ? old.updatedAt : now,
      updatedBy: same ? old.updatedBy : "claude"
    });
  }
  next.sections = sections;
  next.diagrams = diagrams;
  next.tasks = tasks;
  next.threads = base.threads.map((thread) => detachIfOrphaned(next, base, thread));
  next.revision = base.revision + 1;
  if (!prev) next.createdAt = now;
  const change = record(
    next,
    "claude",
    "published",
    { kind: "plan", id: "" },
    prev ? `published revision ${next.revision} of the plan` : "published the plan",
    now
  );
  markReadByClaude(next, now);
  return { plan: next, changes: [change] };
}
function claimIdAmong(plan, kind, wanted, fresh2) {
  const key = { section: "sections", diagram: "diagrams", task: "tasks" }[kind];
  const probe = { ...plan, [key]: [...plan[key], ...fresh2] };
  return claimId(probe, kind, wanted);
}
function detachIfOrphaned(plan, before, thread) {
  if (targetExists(plan, thread.target)) return thread;
  const label = describeTarget(before, thread.target);
  return { ...thread, target: { kind: "plan", id: "" }, text: `(on removed ${label}) ${thread.text}` };
}
function normalizePlan(raw, fallbackTitle) {
  const now = Date.now();
  const list = (v) => Array.isArray(v) ? v : [];
  const plan = {
    ...emptyPlan(typeof raw.title === "string" && raw.title ? raw.title : fallbackTitle, now),
    ...raw,
    summary: typeof raw.summary === "string" ? raw.summary : "",
    sections: list(raw.sections).map((s) => ({ ...s, rev: typeof s.rev === "number" ? s.rev : 1 })),
    diagrams: list(raw.diagrams).map((d) => ({
      ...d,
      rev: typeof d.rev === "number" ? d.rev : 1,
      nodes: list(d.nodes),
      edges: list(d.edges),
      direction: d.direction === "TB" ? "TB" : "LR"
    })),
    tasks: list(raw.tasks),
    threads: list(raw.threads).map((t) => ({ ...t, replies: list(t.replies) })),
    changes: list(raw.changes),
    seq: typeof raw.seq === "number" ? raw.seq : 0,
    version: typeof raw.version === "number" ? raw.version : typeof raw.seq === "number" ? raw.seq : 0,
    claudeReadSeq: typeof raw.claudeReadSeq === "number" ? raw.claudeReadSeq : 0,
    claudeReadAt: typeof raw.claudeReadAt === "number" ? raw.claudeReadAt : null,
    revision: typeof raw.revision === "number" ? raw.revision : 0
  };
  const baseline = validBaseline(raw.claudeBaseline);
  if (baseline) plan.claudeBaseline = baseline;
  else delete plan.claudeBaseline;
  return plan;
}
function applyOps(plan, ops, author, now = Date.now()) {
  if (!Array.isArray(ops) || ops.length === 0) throw new PlanError("No edits were given.");
  const next = structuredClone(plan);
  const changes = [];
  ops.forEach((op, i) => {
    try {
      changes.push(...applyOne(next, op, author, now));
    } catch (err) {
      if (err instanceof PlanError && ops.length > 1) {
        throw new PlanError(`Edit ${i + 1} (${op?.op ?? "?"}): ${err.message}`);
      }
      throw err;
    }
  });
  if (author === "claude") {
    if (next.claudeBaseline && unreadByClaude(next).length > 0) {
      next.claudeBaseline = foldClaudeEdit(next.claudeBaseline, baselineOf(plan), baselineOf(next));
    }
    settleClaudeRead(next);
  }
  return { plan: next, changes };
}
function applyOne(plan, op, author, now) {
  const log = (kind, target, summary) => record(plan, author, kind, target, summary, now);
  switch (op?.op) {
    case "set_meta": {
      const out = [];
      const title = clean(op.title, MAX_TITLE);
      if (title && title !== plan.title) {
        plan.title = title;
        out.push(log("edited", { kind: "plan", id: "" }, `${RENAMED_PLAN} to "${title}"`));
      }
      if (typeof op.summary === "string" && op.summary !== plan.summary) {
        plan.summary = clean(op.summary, MAX_TEXT) ?? "";
        out.push(log("edited", { kind: "plan", id: "" }, "edited the plan summary"));
      }
      return out;
    }
    case "upsert_section": {
      const existing = op.id ? plan.sections.find((s) => s.id === op.id) : void 0;
      if (existing) {
        checkRev(existing, op.expect, "section", author);
        const title2 = clean(op.title, MAX_TITLE);
        const body = typeof op.body === "string" ? clean(op.body, MAX_TEXT) ?? "" : void 0;
        const changed = title2 && title2 !== existing.title || body !== void 0 && body !== existing.body;
        if (typeof op.index === "number") moveInList(plan.sections, existing.id, op.index);
        if (!changed) return [];
        if (title2) existing.title = title2;
        if (body !== void 0) existing.body = body;
        existing.rev += 1;
        existing.updatedAt = now;
        existing.updatedBy = author;
        return [log("edited", ref("section", existing.id), `edited section "${existing.title}"`)];
      }
      const title = clean(op.title, MAX_TITLE);
      if (!title) throw new PlanError(op.id ? `No section "${op.id}".` : "A new section needs a title.");
      if (plan.sections.length >= MAX_SECTIONS) throw new PlanError(`A plan holds at most ${MAX_SECTIONS} sections.`);
      const section = {
        id: claimId(plan, "section", op.id),
        title,
        body: clean(op.body, MAX_TEXT) ?? "",
        rev: 1,
        updatedAt: now,
        updatedBy: author
      };
      insertAt(plan.sections, section, op.index);
      return [log("created", ref("section", section.id), `added section "${title}"`)];
    }
    case "upsert_diagram": {
      const existing = op.id ? plan.diagrams.find((d) => d.id === op.id) : void 0;
      if (existing) {
        checkRev(existing, op.expect, "diagram", author);
        const before = structuredClone(existing);
        const title2 = clean(op.title, MAX_TITLE);
        if (title2) existing.title = title2;
        if (op.nodes || op.edges) {
          const graph2 = buildGraph(op.nodes ?? existing.nodes, op.edges ?? existing.edges, existing, existing.title, taskIdSet(plan));
          existing.nodes = graph2.nodes;
          existing.edges = graph2.edges;
        }
        const direction = validDirection(op.direction);
        if (direction) existing.direction = direction;
        if (typeof op.caption === "string") setOptional(existing, "caption", clean(op.caption, MAX_TEXT));
        if (typeof op.index === "number") moveInList(plan.diagrams, existing.id, op.index);
        const what = describeDiagramEdit(before, existing);
        const relaid = layoutChanged(before, existing);
        if (!what && !relaid) return [];
        existing.rev += 1;
        existing.updatedAt = now;
        if (!what) {
          plan.version += 1;
          plan.updatedAt = now;
          return [];
        }
        existing.updatedBy = author;
        const summary = what === EDITED_DESIGN ? `edited diagram "${existing.title}"` : `${what} in diagram "${existing.title}"`;
        return [log("edited", ref("diagram", existing.id), summary)];
      }
      if (op.id) throw new PlanError(`No diagram "${op.id}".`);
      if (plan.diagrams.length >= MAX_DIAGRAMS) throw new PlanError(`A plan holds at most ${MAX_DIAGRAMS} diagrams.`);
      const title = clean(op.title, MAX_TITLE) ?? "Diagram";
      const caption = clean(op.caption, MAX_TEXT);
      const graph = buildGraph(op.nodes ?? [], op.edges ?? [], void 0, title, taskIdSet(plan));
      const diagram = {
        id: claimId(plan, "diagram", void 0),
        title,
        rev: 1,
        ...graph,
        direction: validDirection(op.direction) ?? suggestDirection(graph.nodes, graph.edges),
        ...caption ? { caption } : {},
        updatedAt: now,
        updatedBy: author
      };
      insertAt(plan.diagrams, diagram, op.index);
      return [log("created", ref("diagram", diagram.id), `added diagram "${title}"`)];
    }
    case "upsert_task": {
      const existing = op.id ? findTask(plan, op.id) : void 0;
      if (existing) return editTask(plan, existing, op, author, now, log);
      const title = clean(op.title, MAX_TITLE);
      if (!title) throw new PlanError(op.id ? `No task "${op.id}".` : "A new task needs a title.");
      if (plan.tasks.length >= MAX_TASKS) throw new PlanError(`A plan holds at most ${MAX_TASKS} tasks.`);
      const parentId = op.parentId ? requireTask(plan, op.parentId).id : null;
      const detail = clean(op.detail, MAX_TEXT);
      const note = clean(op.note, MAX_TITLE * 2);
      const files = cleanList(op.files);
      const task = {
        id: claimId(plan, "task", op.id),
        parentId,
        order: Number.MAX_SAFE_INTEGER,
        title,
        ...detail ? { detail } : {},
        status: validStatus(op.status) ?? "todo",
        ...files?.length ? { files } : {},
        ...note ? { note } : {},
        createdAt: now,
        updatedAt: now,
        createdBy: author
      };
      plan.tasks.push(task);
      placeAmongSiblings(plan, task, op.index);
      const where = parentId ? ` under "${requireTask(plan, parentId).title}"` : "";
      return [log("created", ref("task", task.id), `added task "${title}"${where}`)];
    }
    case "move_task": {
      const task = requireTask(plan, op.id);
      const parentId = op.parentId ? requireTask(plan, op.parentId).id : null;
      if (parentId && (parentId === task.id || isDescendant(plan, parentId, task.id))) {
        throw new PlanError(`Cannot move "${task.title}" inside itself.`);
      }
      const from = task.parentId;
      task.parentId = parentId;
      task.updatedAt = now;
      normalizeSiblings(plan, from);
      placeAmongSiblings(plan, task, op.index);
      const where = parentId ? `under "${requireTask(plan, parentId).title}"` : "to the top level";
      const summary = from === parentId ? `reordered "${task.title}"` : `moved "${task.title}" ${where}`;
      return [log("moved", ref("task", task.id), summary)];
    }
    case "move_section": {
      const section = plan.sections.find((s) => s.id === op.id);
      if (!section) throw new PlanError(`No section "${op.id}".`);
      moveInList(plan.sections, section.id, op.index);
      return [log("moved", ref("section", section.id), `reordered section "${section.title}"`)];
    }
    case "move_diagram": {
      const diagram = plan.diagrams.find((d) => d.id === op.id);
      if (!diagram) throw new PlanError(`No diagram "${op.id}".`);
      moveInList(plan.diagrams, diagram.id, op.index);
      return [log("moved", ref("diagram", diagram.id), `reordered diagram "${diagram.title}"`)];
    }
    case "remove":
      return removeItem(plan, op.kind, op.id, log);
    case "comment": {
      const target = normalizeTarget(op.target);
      if (!targetExists(plan, target)) throw new PlanError(`Nothing to comment on at ${target.kind} "${target.id}".`);
      const text = clean(op.text, MAX_TEXT);
      if (!text) throw new PlanError("A comment needs text.");
      if (plan.threads.length >= MAX_THREADS) throw new PlanError(`A plan holds at most ${MAX_THREADS} comment threads.`);
      const thread = {
        id: claimId(plan, "thread", void 0),
        target,
        author,
        text,
        ts: now,
        resolved: false,
        replies: []
      };
      plan.threads.push(thread);
      return [log("commented", target, `commented on ${describeTarget(plan, target)}: ${short(text, 80)}`)];
    }
    case "reply": {
      const thread = plan.threads.find((c) => c.id === op.threadId);
      if (!thread) throw new PlanError(`No comment thread "${op.threadId}".`);
      const text = clean(op.text, MAX_TEXT);
      if (!text) throw new PlanError("A reply needs text.");
      if (thread.replies.length >= MAX_REPLIES) throw new PlanError("This thread is full; start a new comment.");
      thread.replies.push({ id: `${thread.id}.${thread.replies.length + 1}`, author, text, ts: now });
      return [log("replied", thread.target, `replied on ${describeTarget(plan, thread.target)}: ${short(text, 80)}`)];
    }
    case "resolve": {
      const thread = plan.threads.find((c) => c.id === op.threadId);
      if (!thread) throw new PlanError(`No comment thread "${op.threadId}".`);
      const resolved = op.resolved !== false;
      if (thread.resolved === resolved) return [];
      thread.resolved = resolved;
      return [
        log(
          resolved ? "resolved" : "reopened",
          thread.target,
          `${resolved ? "resolved" : "reopened"} a comment on ${describeTarget(plan, thread.target)}`
        )
      ];
    }
    default:
      throw new PlanError(`Unknown edit "${op?.op}".`);
  }
}
function editTask(plan, task, op, author, now, log) {
  const out = [];
  const edited = [];
  const title = clean(op.title, MAX_TITLE);
  if (title && title !== task.title) {
    task.title = title;
    edited.push("title");
  }
  if (typeof op.detail === "string" && op.detail !== (task.detail ?? "")) {
    setOptional(task, "detail", clean(op.detail, MAX_TEXT));
    edited.push("detail");
  }
  if (op.files) {
    setOptional(task, "files", cleanList(op.files)?.length ? cleanList(op.files) : void 0);
    edited.push("files");
  }
  if (typeof op.note === "string") {
    setOptional(task, "note", clean(op.note, MAX_TITLE * 2));
    if (!op.status) edited.push("note");
  }
  if (op.status !== void 0) {
    const status = validStatus(op.status);
    if (!status) throw new PlanError(`"${op.status}" is not a task status (${TASK_STATUSES.join(", ")}).`);
    if (status !== task.status) {
      task.status = status;
      task.updatedAt = now;
      const note = task.note && typeof op.note === "string" ? ` \u2014 ${short(task.note, 80)}` : "";
      out.push(log("status", ref("task", task.id), `marked "${task.title}" ${STATUS_WORDS[status]}${note}`));
    }
  }
  if (edited.length) {
    task.updatedAt = now;
    out.push(log("edited", ref("task", task.id), `edited the ${edited.join(", ")} of "${task.title}"`));
  }
  if (typeof op.index === "number") placeAmongSiblings(plan, task, op.index);
  void author;
  return out;
}
function removeItem(plan, kind, id, log) {
  const before = structuredClone(plan);
  let summary;
  switch (kind) {
    case "section": {
      const s = plan.sections.find((x) => x.id === id);
      if (!s) throw new PlanError(`No section "${id}".`);
      plan.sections = plan.sections.filter((x) => x.id !== id);
      summary = `removed section "${s.title}"`;
      break;
    }
    case "diagram": {
      const d = plan.diagrams.find((x) => x.id === id);
      if (!d) throw new PlanError(`No diagram "${id}".`);
      plan.diagrams = plan.diagrams.filter((x) => x.id !== id);
      summary = `removed diagram "${d.title}"`;
      break;
    }
    case "task": {
      const t = requireTask(plan, id);
      const doomed = /* @__PURE__ */ new Set([t.id, ...descendants(plan, t.id).map((d) => d.id)]);
      plan.tasks = plan.tasks.filter((x) => !doomed.has(x.id));
      normalizeSiblings(plan, t.parentId);
      for (const d of plan.diagrams) {
        for (const n of d.nodes) {
          if (!n.taskIds) continue;
          n.taskIds = n.taskIds.filter((id2) => !doomed.has(id2));
          if (n.taskIds.length === 0) delete n.taskIds;
        }
      }
      const extra = doomed.size > 1 ? ` and its ${doomed.size - 1} subtask(s)` : "";
      summary = `removed task "${t.title}"${extra}`;
      break;
    }
    default:
      throw new PlanError(`Cannot remove a "${kind}".`);
  }
  plan.threads = plan.threads.map((t) => detachIfOrphaned(plan, before, t));
  return [log("deleted", { kind, id }, summary)];
}
var MAX_NODES = 120;
var MAX_EDGES = 300;
var MAX_DESCRIPTION = 4e3;
function buildGraph(rawNodes, rawEdges, old, title, taskIds) {
  if (!Array.isArray(rawNodes) || !Array.isArray(rawEdges)) throw new PlanError(`Diagram "${title}": nodes and edges must be lists.`);
  if (rawNodes.length > MAX_NODES) throw new PlanError(`Diagram "${title}" has more than ${MAX_NODES} nodes.`);
  if (rawEdges.length > MAX_EDGES) throw new PlanError(`Diagram "${title}" has more than ${MAX_EDGES} edges.`);
  const nodes = [];
  for (const raw of rawNodes) {
    const id = clean(raw?.id, 60);
    if (!id) throw new PlanError(`Diagram "${title}": every node needs an id.`);
    if (nodes.some((n) => n.id === id)) throw new PlanError(`Diagram "${title}": node id "${id}" is used twice.`);
    const prev = old?.nodes.find((n) => n.id === id);
    const detail = clean(raw.detail, 400);
    const description = raw.description === void 0 ? prev?.description : clean(raw.description, MAX_DESCRIPTION);
    const notes = raw.notes === void 0 ? prev?.notes : clean(raw.notes, MAX_TEXT);
    const links = raw.taskIds === void 0 ? prev?.taskIds : cleanList(raw.taskIds);
    for (const t of links ?? []) {
      if (!taskIds.has(t)) throw new PlanError(`Diagram "${title}": node "${id}" links task "${t}", which is not in the plan.`);
    }
    const x = finite(raw.x) ?? prev?.x;
    const y = finite(raw.y) ?? prev?.y;
    nodes.push({
      id,
      label: clean(raw.label, 120) ?? prev?.label ?? id,
      kind: validKind(raw.kind) ?? prev?.kind ?? "component",
      ...detail ? { detail } : {},
      ...description ? { description } : {},
      ...notes ? { notes } : {},
      ...links?.length ? { taskIds: [...new Set(links)] } : {},
      ...x !== void 0 && y !== void 0 ? { x: Math.round(x), y: Math.round(y) } : {}
    });
  }
  const ids = new Set(nodes.map((n) => n.id));
  const edges = [];
  const cleaned = rawEdges.map((raw) => {
    const source = clean(raw?.source, 60);
    const target = clean(raw?.target, 60);
    if (!source || !target) throw new PlanError(`Diagram "${title}": every edge needs a source and a target.`);
    for (const end of [source, target]) {
      if (!ids.has(end)) throw new PlanError(`Diagram "${title}": an edge refers to node "${end}", which is not in the diagram.`);
    }
    return { raw, source, target, id: clean(raw.id, 80), label: raw.label === void 0 ? void 0 : clean(raw.label, 120) ?? "" };
  });
  const prevOf = new Map(matchEdges(old?.edges ?? [], cleaned).pairs.map(([b, a]) => [a, b]));
  for (const c of cleaned) {
    const { raw, source, target } = c;
    const prev = prevOf.get(c);
    let id = c.id ?? `${source}->${target}`;
    for (let n = 2; edges.some((e) => e.id === id); n++) id = `${source}->${target}#${n}`;
    const label = c.label === void 0 ? prev?.label : c.label || void 0;
    const dashed = raw.dashed === void 0 ? prev?.dashed : raw.dashed === true;
    const arrows = raw.arrows === void 0 ? prev?.arrows : validArrows(raw.arrows);
    edges.push({
      id,
      source,
      target,
      ...label ? { label } : {},
      ...dashed ? { dashed: true } : {},
      ...arrows && arrows !== "end" ? { arrows } : {}
    });
  }
  return { nodes, edges };
}
function describeDiagramEdit(before, after) {
  const parts = [];
  if (before.title !== after.title) parts.push(`renamed it from "${before.title}"`);
  const label = (d, id) => d.nodes.find((n) => n.id === id)?.label ?? id;
  const added = after.nodes.filter((n) => !before.nodes.some((b) => b.id === n.id));
  const removed = before.nodes.filter((n) => !after.nodes.some((a) => a.id === n.id));
  const changed = after.nodes.filter((n) => {
    const b = before.nodes.find((x) => x.id === n.id);
    return b && (b.label !== n.label || b.kind !== n.kind || (b.detail ?? "") !== (n.detail ?? "") || (b.description ?? "") !== (n.description ?? "") || (b.notes ?? "") !== (n.notes ?? ""));
  });
  const relinked = after.nodes.filter((n) => {
    const b = before.nodes.find((x) => x.id === n.id);
    return b && (b.taskIds ?? []).join() !== (n.taskIds ?? []).join();
  });
  const matched = matchEdges(before.edges, after.edges);
  const linked = matched.added;
  const unlinked = matched.removed;
  const relabeled = matched.pairs.filter(([b, e]) => (b.label ?? "") !== (e.label ?? "") || Boolean(b.dashed) !== Boolean(e.dashed) || (b.arrows ?? "end") !== (e.arrows ?? "end")).map(([, e]) => e);
  const list = (items) => items.length > 3 ? `${items.slice(0, 3).join(", ")} and ${items.length - 3} more` : items.join(", ");
  if (added.length) parts.push(`added ${list(added.map((n) => `"${n.label}"`))}`);
  if (removed.length) parts.push(`removed ${list(removed.map((n) => `"${n.label}"`))}`);
  if (changed.length) parts.push(`edited ${list(changed.map((n) => `"${n.label}"`))}`);
  if (relinked.length) parts.push(`changed the tasks behind ${list(relinked.map((n) => `"${n.label}"`))}`);
  if (linked.length) parts.push(`connected ${list(linked.map((e) => `${label(after, e.source)} \u2192 ${label(after, e.target)}`))}`);
  if (unlinked.length) parts.push(`disconnected ${list(unlinked.map((e) => `${label(before, e.source)} \u2192 ${label(before, e.target)}`))}`);
  if (relabeled.length) parts.push(`relabelled ${list(relabeled.map((e) => `${label(after, e.source)} \u2192 ${label(after, e.target)}`))}`);
  if ((before.caption ?? "") !== (after.caption ?? "")) parts.push("edited the caption");
  if (parts.length) return parts.join("; ");
  return designOf(before) !== designOf(after) ? EDITED_DESIGN : null;
}
var EDITED_DESIGN = "edited";
function designOf(d) {
  return JSON.stringify([d.title, d.caption ?? "", d.nodes.map(({ x: _x, y: _y, ...n }) => n), d.edges]);
}
function matchEdges(before, after) {
  const pairs = [];
  const left = [...before];
  const right = [...after];
  const take = (same) => {
    for (let i = 0; i < left.length; ) {
      const j = right.findIndex((a) => same(left[i], a));
      if (j < 0) {
        i++;
        continue;
      }
      pairs.push([left[i], right[j]]);
      left.splice(i, 1);
      right.splice(j, 1);
    }
  };
  const ends = (b, a) => b.source === a.source && b.target === a.target;
  take((b, a) => b.id !== void 0 && b.id === a.id && ends(b, a));
  take((b, a) => ends(b, a) && (b.label ?? "") === (a.label ?? ""));
  take(ends);
  return { pairs, removed: left, added: right };
}
function layoutChanged(before, after) {
  if (before.direction !== after.direction) return true;
  return after.nodes.some((n) => {
    const b = before.nodes.find((x) => x.id === n.id);
    return b && (b.x !== n.x || b.y !== n.y);
  });
}
function checkRev(item, expect, kind, author) {
  if (typeof expect !== "number" || expect === item.rev) return;
  const who2 = item.updatedBy === author ? "another edit" : item.updatedBy === "claude" ? "Claude" : "the user";
  throw new PlanError(
    `${kind[0].toUpperCase()}${kind.slice(1)} "${item.title}" was changed by ${who2} while this edit was open, so it was not saved. It now shows the latest version.`
  );
}
function taskIdSet(plan) {
  return new Set(plan.tasks.map((t) => t.id));
}
function validKind(value) {
  return NODE_KINDS.includes(value) ? value : void 0;
}
function validDirection(value) {
  return value === "LR" || value === "TB" ? value : void 0;
}
function validArrows(value) {
  return EDGE_ARROWS.includes(value) ? value : void 0;
}
function suggestDirection(nodes, edges) {
  const ranks = flowRanks(nodes, edges);
  if (ranks.size === 0) return "LR";
  const perRank = /* @__PURE__ */ new Map();
  for (const r of ranks.values()) perRank.set(r, (perRank.get(r) ?? 0) + 1);
  const depth = Math.max(...perRank.keys()) + 1;
  const breadth = Math.max(...perRank.values());
  const fit = (w, h) => Math.min(1, 1e3 / w, 680 / h);
  const lr = fit(depth * 300, breadth * 110);
  const tb = fit(breadth * 250, depth * 150);
  return tb > lr * 1.1 ? "TB" : "LR";
}
function flowRanks(nodes, edges) {
  const ids = new Set(nodes.map((n) => n.id));
  const out = /* @__PURE__ */ new Map();
  const connected = [];
  const seen = /* @__PURE__ */ new Set();
  for (const e of edges) {
    if (e.source === e.target || !ids.has(e.source) || !ids.has(e.target)) continue;
    out.set(e.source, [...out.get(e.source) ?? [], e.target]);
    for (const end of [e.source, e.target]) {
      if (!seen.has(end)) connected.push(end);
      seen.add(end);
    }
  }
  const state = /* @__PURE__ */ new Map();
  const order = [];
  const forward = /* @__PURE__ */ new Map();
  const visit = (v) => {
    state.set(v, "open");
    const keep = [];
    for (const w of out.get(v) ?? []) {
      if (state.get(w) === "open") continue;
      keep.push(w);
      if (!state.has(w)) visit(w);
    }
    forward.set(v, keep);
    state.set(v, "done");
    order.push(v);
  };
  for (const v of connected) if (!state.has(v)) visit(v);
  const rank = new Map(connected.map((v) => [v, 0]));
  for (const v of order.reverse()) {
    for (const w of forward.get(v) ?? []) rank.set(w, Math.max(rank.get(w) ?? 0, rank.get(v) + 1));
  }
  return rank;
}
function finite(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function findTask(plan, id) {
  return plan.tasks.find((t) => t.id === id);
}
function requireTask(plan, id) {
  const task = findTask(plan, id);
  if (!task) throw new PlanError(`No task "${id}".`);
  return task;
}
function childrenOf(plan, parentId) {
  return plan.tasks.filter((t) => t.parentId === parentId).sort((a, b) => a.order - b.order);
}
function descendants(plan, id) {
  const out = [];
  const visit = (pid) => {
    for (const child of childrenOf(plan, pid)) {
      out.push(child);
      visit(child.id);
    }
  };
  visit(id);
  return out;
}
function isDescendant(plan, candidate, ancestor) {
  return descendants(plan, ancestor).some((t) => t.id === candidate);
}
function normalizeSiblings(plan, parentId) {
  childrenOf(plan, parentId).forEach((t, i) => {
    t.order = i;
  });
}
function placeAmongSiblings(plan, task, index) {
  const siblings = childrenOf(plan, task.parentId).filter((t) => t.id !== task.id);
  const at = index === void 0 ? siblings.length : clampIndex(index, siblings.length);
  siblings.splice(at, 0, task);
  siblings.forEach((t, i) => {
    t.order = i;
  });
}
function outline(plan) {
  const out = [];
  const visit = (parentId, depth, prefix) => {
    childrenOf(plan, parentId).forEach((task, i) => {
      const number = prefix ? `${prefix}.${i + 1}` : String(i + 1);
      out.push({ task, depth, number });
      visit(task.id, depth + 1, number);
    });
  };
  visit(null, 0, "");
  return out;
}
function countTasks(plan) {
  const counts = { total: 0, done: 0, inProgress: 0, blocked: 0 };
  if (!plan) return counts;
  const parents = new Set(plan.tasks.map((t) => t.parentId).filter(Boolean));
  for (const t of plan.tasks) {
    if (parents.has(t.id)) continue;
    counts.total++;
    if (t.status === "done") counts.done++;
    else if (t.status === "in_progress") counts.inProgress++;
    else if (t.status === "blocked") counts.blocked++;
  }
  return counts;
}
var STATUS_WORDS = {
  todo: "to do",
  in_progress: "in progress",
  blocked: "blocked",
  done: "done"
};
function ref(kind, id) {
  return { kind, id };
}
function normalizeTarget(raw) {
  const rec = raw && typeof raw === "object" ? raw : {};
  const kind = String(rec["kind"] ?? "plan");
  return { kind, id: kind === "plan" ? "" : String(rec["id"] ?? "") };
}
function targetExists(plan, target) {
  switch (target.kind) {
    case "plan":
      return true;
    case "section":
      return plan.sections.some((s) => s.id === target.id);
    case "diagram":
      return plan.diagrams.some((d) => d.id === target.id);
    case "task":
      return plan.tasks.some((t) => t.id === target.id);
    default:
      return false;
  }
}
function describeTarget(plan, target) {
  switch (target.kind) {
    case "plan":
      return "the plan";
    case "section": {
      const s = plan.sections.find((x) => x.id === target.id);
      return s ? `section "${s.title}"` : `section ${target.id}`;
    }
    case "diagram": {
      const d = plan.diagrams.find((x) => x.id === target.id);
      return d ? `diagram "${d.title}"` : `diagram ${target.id}`;
    }
    case "task": {
      const t = plan.tasks.find((x) => x.id === target.id);
      return t ? `task "${t.title}"` : `task ${target.id}`;
    }
    default:
      return "an item";
  }
}
function validStatus(value) {
  return TASK_STATUSES.includes(value) ? value : void 0;
}
function clean(value, max, trim = true) {
  if (typeof value !== "string") return void 0;
  const out = (trim ? value.trim() : value.replace(/\s+$/, "")).slice(0, max);
  return out.trim() ? out : void 0;
}
function cleanList(value) {
  if (!Array.isArray(value)) return void 0;
  return value.map((v) => typeof v === "string" ? v.trim().slice(0, 300) : "").filter(Boolean).slice(0, 50);
}
function setOptional(obj, key, value) {
  if (value === void 0 || value === null || value === "") delete obj[key];
  else obj[key] = value;
}
function insertAt(list, item, index) {
  if (index === void 0) list.push(item);
  else list.splice(clampIndex(index, list.length), 0, item);
}
function moveInList(list, id, index) {
  const from = list.findIndex((x) => x.id === id);
  if (from < 0) return;
  const [item] = list.splice(from, 1);
  list.splice(clampIndex(index, list.length), 0, item);
}
function clampIndex(index, length) {
  if (!Number.isFinite(index)) return length;
  return Math.max(0, Math.min(length, Math.trunc(index)));
}
function short(text, max = 60) {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}\u2026` : line;
}

// src/shared/architecture.ts
var KIND_NOUN = {
  component: "component",
  service: "service",
  datastore: "data store",
  queue: "queue",
  external: "external system",
  actor: "actor",
  note: "note"
};
var STATUS_MARK = { todo: "[ ]", in_progress: "[~]", blocked: "[!]", done: "[x]" };
function diagramToMarkdown(diagram, opts = {}) {
  const ids = opts.ids ?? true;
  const hashes = "#".repeat(Math.min(6, Math.max(1, opts.level ?? 3)));
  const out = [`${hashes} ${ids ? `[${diagram.id}] ` : ""}${diagram.title}`];
  if (opts.note) out.push(`_${opts.note}_`);
  if (diagram.caption?.trim()) out.push("", diagram.caption.trim());
  const nodes = diagram.nodes;
  if (nodes.length === 0) {
    out.push("", "_No parts yet._");
    return out.join("\n");
  }
  const label = labeller(diagram);
  const ref2 = (n) => ids ? `${n.label} (\`${n.id}\`)` : n.label;
  const { ordered, notes, isolated } = flowOrder(diagram);
  const shape = shapeOf(diagram, ordered);
  if (shape) out.push("", shape);
  if (ordered.length) {
    out.push("", "**Parts**");
    for (const n of ordered) out.push(...renderPart(n, opts, ids));
  }
  if (isolated.length) {
    out.push("", `_Not connected to anything yet: ${isolated.map((n) => n.label).join(", ")}._`);
  }
  if (diagram.edges.length) {
    out.push("", "**Connections**");
    const rank = new Map(ordered.map((n, i) => [n.id, i]));
    const edges = [...diagram.edges].sort(
      (a, b) => (rank.get(a.source) ?? 1e9) - (rank.get(b.source) ?? 1e9) || (rank.get(a.target) ?? 1e9) - (rank.get(b.target) ?? 1e9)
    );
    for (const e of edges) out.push(`- ${edgePhrase(e, label)}${ids ? ` \`${e.source} ${ARROW[e.arrows ?? "end"]} ${e.target}\`` : ""}`);
  }
  if (notes.length) {
    out.push("", "**Notes on the diagram**");
    for (const n of notes) {
      out.push(`- ${ref2(n)}`);
      for (const text of [n.detail, n.description, n.notes]) if (text?.trim()) out.push(...indent(text, 2));
    }
  }
  return out.join("\n");
}
function renderPart(n, opts, ids) {
  const head = `- **${n.label}**${ids ? ` \`${n.id}\`` : ""} \u2014 ${KIND_NOUN[n.kind]}${n.detail ? `: ${oneLine(n.detail)}` : ""}`;
  const lines = [head];
  if (n.description?.trim()) lines.push(...indent(n.description, 2));
  if (n.notes?.trim()) lines.push("  Decisions:", ...indent(n.notes, 4));
  if (n.taskIds?.length) {
    const named = n.taskIds.map((id) => {
      const task = opts.tasks?.find((t) => t.id === id);
      if (!task) return ids ? id : null;
      return `${STATUS_MARK[task.status]} ${ids ? `${id} ` : ""}${task.title}`;
    });
    const list = named.filter(Boolean);
    if (list.length) lines.push(`  Built by: ${list.join("; ")}`);
  }
  return lines;
}
var ARROW = { end: "\u2192", both: "\u2194", none: "\u2014" };
function edgePhrase(e, label) {
  const flags = [e.dashed ? "dashed: optional, async or future" : "", e.arrows === "none" ? "no direction" : ""].filter(Boolean);
  return `${label(e.source)} ${ARROW[e.arrows ?? "end"]} ${label(e.target)}${e.label ? `: ${oneLine(e.label)}` : ""}${flags.length ? ` (${flags.join("; ")})` : ""}`;
}
function shapeOf(diagram, ordered) {
  const incoming = /* @__PURE__ */ new Set();
  const outgoing = /* @__PURE__ */ new Set();
  for (const e of diagram.edges) {
    if (e.source === e.target) continue;
    outgoing.add(e.source);
    incoming.add(e.target);
    if (e.arrows === "both" || e.arrows === "none") {
      outgoing.add(e.target);
      incoming.add(e.source);
    }
  }
  const names = (pick) => ordered.filter(pick).map((n) => n.label);
  const parts = [
    ["Entry points", names((n) => outgoing.has(n.id) && !incoming.has(n.id))],
    ["Data stores", names((n) => n.kind === "datastore")],
    ["Queues", names((n) => n.kind === "queue")],
    ["External systems", names((n) => n.kind === "external")]
  ];
  const said = parts.filter(([, list]) => list.length).map(([what, list]) => `${what}: ${list.join(", ")}.`);
  return said.length ? said.join(" ") : null;
}
function flowOrder(diagram) {
  const ranks = flowRanks(diagram.nodes, diagram.edges);
  const index = new Map(diagram.nodes.map((n, i) => [n.id, i]));
  const parts = diagram.nodes.filter((n) => n.kind !== "note");
  const connected = parts.filter((n) => ranks.has(n.id)).sort((a, b) => ranks.get(a.id) - ranks.get(b.id) || index.get(a.id) - index.get(b.id));
  const isolated = parts.filter((n) => !ranks.has(n.id));
  return { ordered: [...connected, ...isolated], notes: diagram.nodes.filter((n) => n.kind === "note"), isolated };
}
function diagramChanges(before, after, opts = {}) {
  const ids = opts.ids ?? true;
  const out = [];
  const label = (id) => after.nodes.find((n) => n.id === id)?.label ?? before.nodes.find((n) => n.id === id)?.label ?? id;
  const ref2 = (n) => ids ? `${n.label} (\`${n.id}\`)` : n.label;
  if (before.title !== after.title) out.push(`Renamed the diagram "${before.title}" \u2192 "${after.title}".`);
  if ((before.caption ?? "") !== (after.caption ?? "")) out.push(...prose("Edited the caption", after.caption, opts));
  const added = [];
  const removed = [];
  const changed = [];
  for (const n of after.nodes) {
    const b = before.nodes.find((x) => x.id === n.id);
    if (!b) {
      added.push(`Added ${ref2(n)} \u2014 ${KIND_NOUN[n.kind]}${n.detail ? `: ${oneLine(n.detail)}` : ""}.`);
      if (opts.withText) {
        if (n.description?.trim()) added.push(...indent(n.description, 2));
        if (n.notes?.trim()) added.push("  Decisions:", ...indent(n.notes, 4));
      }
      continue;
    }
    const facts = [];
    if (b.label !== n.label) facts.push(`renamed from "${b.label}"`);
    if (b.kind !== n.kind) facts.push(`now a ${KIND_NOUN[n.kind]} (was a ${KIND_NOUN[b.kind]})`);
    if ((b.detail ?? "") !== (n.detail ?? "")) facts.push(n.detail ? `subtitle "${oneLine(n.detail)}"` : "subtitle removed");
    const texts = [
      ["description", b.description, n.description],
      ["decisions", b.notes, n.notes]
    ];
    const editedText = texts.filter(([, was2, now2]) => (was2 ?? "").trim() !== (now2 ?? "").trim());
    for (const [what, , now2] of editedText) facts.push(now2?.trim() ? `${what} edited` : `${what} removed`);
    const was = b.taskIds ?? [];
    const now = n.taskIds ?? [];
    if (was.join() !== now.join()) facts.push(now.length ? `built by ${now.join(", ")}${was.length ? ` (was ${was.join(", ")})` : ""}` : "no longer linked to tasks");
    if (!facts.length) continue;
    changed.push(`Changed ${ref2(n)}: ${facts.join("; ")}.`);
    if (opts.withText) {
      for (const [what, , text] of editedText) {
        if (text?.trim()) changed.push(`  ${what[0].toUpperCase()}${what.slice(1)} now:`, ...indent(text, 4));
      }
    }
  }
  for (const b of before.nodes) {
    if (!after.nodes.some((n) => n.id === b.id)) removed.push(`Removed ${ref2(b)}.`);
  }
  out.push(...added, ...removed, ...changed);
  const { pairs, removed: cut, added: drawn } = matchEdges(before.edges, after.edges);
  const connected = [];
  const disconnected = [];
  const restyled = [];
  const unclaimed = [...drawn];
  for (const e of cut) {
    const back = (a) => a.source === e.target && a.target === e.source;
    const same = unclaimed.findIndex((a) => back(a) && (a.label ?? "") === (e.label ?? ""));
    const k = same >= 0 ? same : unclaimed.findIndex(back);
    if (k >= 0) {
      const [now] = unclaimed.splice(k, 1);
      restyled.push(`Reversed ${label(e.source)} \u2192 ${label(e.target)}: it now runs ${edgePhrase(now, label)}.`);
    } else {
      disconnected.push(`Disconnected ${edgePhrase(e, label)}.`);
    }
  }
  for (const e of unclaimed) connected.push(`Connected ${edgePhrase(e, label)}.`);
  for (const [b, e] of pairs) {
    const facts = [];
    if ((b.label ?? "") !== (e.label ?? "")) facts.push(e.label ? `now labelled "${oneLine(e.label)}"` : "label removed");
    if (Boolean(b.dashed) !== Boolean(e.dashed)) facts.push(e.dashed ? "now dashed (optional, async or future)" : "now solid");
    if ((b.arrows ?? "end") !== (e.arrows ?? "end")) facts.push({ end: "now one way", both: "now both ways", none: "now without direction" }[e.arrows ?? "end"]);
    if (facts.length) restyled.push(`Changed ${label(e.source)} \u2192 ${label(e.target)}: ${facts.join("; ")}.`);
  }
  out.push(...connected, ...disconnected, ...restyled);
  return out;
}
function contentOf(diagram) {
  return {
    id: diagram.id,
    title: diagram.title,
    ...diagram.caption ? { caption: diagram.caption } : {},
    nodes: diagram.nodes.map(({ x: _x, y: _y, ...n }) => n),
    edges: diagram.edges
  };
}
function labeller(diagram) {
  const names = new Map(diagram.nodes.map((n) => [n.id, n.label]));
  return (id) => names.get(id) ?? id;
}
function prose(what, text, opts) {
  if (!text?.trim()) return [`${what.replace(/^Edited/, "Removed")}.`];
  return opts.withText ? [`${what}:`, ...indent(text, 2)] : [`${what}.`];
}
function indent(text, by) {
  const pad = " ".repeat(by);
  return text.trim().split("\n").map((line) => line.trim() ? `${pad}${line.trimEnd()}` : "");
}
function oneLine(text) {
  return text.replace(/\s*\n\s*/g, " ").trim();
}

// src/daemon/render.ts
var STATUS_MARK2 = { todo: "[ ]", in_progress: "[~]", blocked: "[!]", done: "[x]" };
function renderPlan(plan, opts = {}) {
  const unread = unreadByClaude(plan);
  const out = [];
  out.push(`# ${plan.title}`);
  const counts = countTasks(plan);
  const meta = [
    `revision ${plan.revision}`,
    counts.total ? `tasks ${counts.done}/${counts.total} done` : "no tasks",
    `${plan.threads.filter((t) => !t.resolved).length} open comment(s)`
  ];
  out.push(`_${meta.join(" \xB7 ")}${opts.url ? ` \xB7 UI: ${opts.url}` : ""}_`);
  out.push("");
  out.push(renderChanges(plan, unread, Boolean(opts.changesOnly)));
  if (opts.changesOnly) {
    const touched = new Set(unread.map((c) => `${c.target.kind}:${c.target.id}`));
    const threads = plan.threads.filter((t) => !t.resolved && (touched.has(`${t.target.kind}:${t.target.id}`) || lastAuthor(t) === "user"));
    if (threads.length) out.push("", "## Comments waiting on you", ...threads.map((t) => renderThread(plan, t)));
    return out.join("\n").trim();
  }
  if (plan.summary.trim()) out.push("", "## Summary", plan.summary.trim());
  if (plan.sections.length) {
    out.push("", "## Sections");
    for (const s of plan.sections) {
      out.push("", `### [${s.id}] ${s.title}${s.updatedBy === "user" ? " _(edited by the user)_" : ""}`, s.body.trim() || "_(empty)_");
    }
  }
  if (plan.diagrams.length) {
    out.push("", "## Architecture");
    for (const d of plan.diagrams) {
      out.push("", diagramToMarkdown(d, { tasks: plan.tasks, note: d.updatedBy === "user" ? "last edited by the user" : void 0 }));
    }
  }
  out.push("", `## Tasks${counts.total ? ` (${counts.done}/${counts.total} done)` : ""}`);
  const rows = outline(plan);
  if (rows.length === 0) out.push("_(no tasks yet)_");
  for (const { task, depth } of rows) {
    const pad = "  ".repeat(depth);
    const by = task.createdBy === "user" ? " _(added by the user)_" : "";
    const note = task.note ? ` \u2014 ${task.note}` : "";
    out.push(`${pad}- ${STATUS_MARK2[task.status]} ${task.id} ${task.title}${by}${note}`);
    if (task.files?.length) out.push(`${pad}  files: ${task.files.join(", ")}`);
    if (task.detail) for (const line of task.detail.trim().split("\n")) out.push(`${pad}  ${line}`);
  }
  const open = plan.threads.filter((t) => !t.resolved);
  if (open.length) {
    out.push("", "## Open comments");
    for (const t of open) out.push(renderThread(plan, t));
  }
  out.push("", `_Statuses: ${Object.entries(STATUS_MARK2).map(([k, v]) => `${v} ${k}`).join(", ")}_`);
  return out.join("\n").trim();
}
function renderChanges(plan, unread, changesOnly) {
  if (unread.length === 0) {
    return plan.claudeReadAt ? "## Since you last read\nNothing \u2014 the user has not changed the plan." : "## Since you last read\nThis is your first read of this plan.";
  }
  const base = plan.claudeBaseline;
  if (!base) return renderChangeLog(unread);
  const touched = (kind) => new Set(unread.filter((c) => c.target.kind === kind).map((c) => c.target.id));
  const opts = { withText: changesOnly };
  const blocks = [];
  const block = (title, lines) => {
    if (lines.length) blocks.push(`**${title}**
${lines.map((l) => l.startsWith(" ") || l === "" ? l : `- ${l}`).join("\n")}`);
  };
  const meta = [];
  const userMeta = unread.some((c) => c.target.kind === "plan" && c.kind === "edited");
  if (userMeta && base.title !== plan.title) meta.push(`Renamed the plan "${base.title}" \u2192 "${plan.title}".`);
  if (userMeta && base.summary.trim() !== plan.summary.trim()) {
    meta.push(plan.summary.trim() ? "Edited the summary." : "Removed the summary.");
    if (changesOnly && plan.summary.trim()) meta.push(...indent(plan.summary, 2));
  }
  block("Plan", meta);
  for (const id of touched("diagram")) {
    const was = base.diagrams.find((d) => d.id === id);
    const now = plan.diagrams.find((d) => d.id === id);
    if (!was && now) {
      block(`New diagram [${now.id}] "${now.title}"`, [
        `${now.nodes.length} part(s), ${now.edges.length} connection(s)${changesOnly ? ":" : " \u2014 described in full below."}`,
        ...changesOnly ? indent(diagramToMarkdown(contentOf(now), { tasks: plan.tasks, level: 4 }), 2) : []
      ]);
    } else if (was && !now) {
      block(`Diagram "${was.title}"`, ["Removed the diagram."]);
    } else if (was && now) {
      block(`Diagram [${now.id}] "${now.title}"`, diagramChanges(contentOf(was), contentOf(now), opts));
    }
  }
  if (unread.some((c) => c.kind === "moved" && c.target.kind === "diagram") && reordered(base.diagrams, plan.diagrams)) {
    block("Diagrams", [`Reordered the diagrams: ${plan.diagrams.map((d) => `"${d.title}"`).join(", ")}.`]);
  }
  block("Tasks", taskChanges(base, plan, touched("task"), changesOnly));
  block("Sections", sectionChanges(base, plan, touched("section"), unread, changesOnly));
  const said = unread.filter((c) => ["commented", "replied", "resolved", "reopened"].includes(c.kind)).map((c) => `${capital(c.summary)}.`);
  block("Comments", [...new Set(said)]);
  const lead = changesOnly ? "_The net effect of their edits \u2014 not each step, and not where boxes were moved on the canvas._" : "_The net effect of their edits \u2014 not each step, and not where boxes were moved on the canvas. The full plan follows._";
  if (!blocks.length) {
    if (!sameContent(baselineOf(plan), base)) return renderChangeLog(unread);
    return `## Since you last read
The user made edits, but they cancel out: the plan's content is what you last read.`;
  }
  return ["## Since you last read \u2014 what the user changed", lead, "", blocks.join("\n\n")].join("\n");
}
function taskChanges(base, plan, ids, withText) {
  const out = [];
  const titleOf = (id) => id ? plan.tasks.find((t) => t.id === id)?.title ?? base.tasks.find((t) => t.id === id)?.title ?? id : null;
  const where = (parentId) => parentId ? `under "${titleOf(parentId)}"` : "at the top level";
  const place = (tasks, t) => tasks.filter((x) => x.parentId === t.parentId).sort((a, b) => a.order - b.order).findIndex((x) => x.id === t.id);
  for (const id of ids) {
    const was = base.tasks.find((t) => t.id === id);
    const now = plan.tasks.find((t) => t.id === id);
    if (!was && now) {
      out.push(`Added ${now.id} "${now.title}" ${where(now.parentId)}.`);
      if (withText && now.detail?.trim()) out.push(...indent(now.detail, 2));
      continue;
    }
    if (was && !now) {
      out.push(`Removed ${was.id} "${was.title}".`);
      continue;
    }
    if (!was || !now) continue;
    const facts = [];
    if (was.title !== now.title) facts.push(`renamed from "${was.title}"`);
    if (was.parentId !== now.parentId) facts.push(`moved ${where(now.parentId)}`);
    else if (place(base.tasks, was) !== place(plan.tasks, now)) facts.push(`moved to position ${place(plan.tasks, now) + 1} ${where(now.parentId)}`);
    if (was.status !== now.status) facts.push(`status ${was.status} \u2192 ${now.status}`);
    if ((was.detail ?? "").trim() !== (now.detail ?? "").trim()) facts.push(now.detail?.trim() ? "detail edited" : "detail removed");
    if ((was.files ?? []).join() !== (now.files ?? []).join()) facts.push(`files now ${now.files?.join(", ") || "none"}`);
    if ((was.note ?? "") !== (now.note ?? "")) facts.push(now.note ? `note "${now.note}"` : "note removed");
    if (!facts.length) continue;
    out.push(`Changed ${now.id} "${now.title}": ${facts.join("; ")}.`);
    if (withText && (was.detail ?? "").trim() !== (now.detail ?? "").trim() && now.detail?.trim()) out.push("  Detail now:", ...indent(now.detail, 4));
  }
  return out;
}
function sectionChanges(base, plan, ids, unread, withText) {
  const out = [];
  for (const id of ids) {
    const was = base.sections.find((s) => s.id === id);
    const now = plan.sections.find((s) => s.id === id);
    if (!was && now) {
      out.push(`Added [${now.id}] "${now.title}".`);
      if (withText && now.body.trim()) out.push(...indent(now.body, 2));
    } else if (was && !now) {
      out.push(`Removed "${was.title}".`);
    } else if (was && now) {
      const facts = [];
      if (was.title !== now.title) facts.push(`renamed from "${was.title}"`);
      if (was.body.trim() !== now.body.trim()) facts.push("text edited");
      if (facts.length) out.push(`Changed [${now.id}] "${now.title}": ${facts.join("; ")}.`);
      if (withText && was.body.trim() !== now.body.trim()) out.push(...indent(now.body, 2));
    }
  }
  if (unread.some((c) => c.kind === "moved" && c.target.kind === "section") && reordered(base.sections, plan.sections)) {
    out.push(`Reordered the sections: ${plan.sections.map((s) => `"${s.title}"`).join(", ")}.`);
  }
  return out;
}
function reordered(was, now) {
  const common = (list, other) => list.map((x) => x.id).filter((id) => other.some((o) => o.id === id));
  return common(was, now).join("\0") !== common(now, was).join("\0");
}
function renderChangeLog(unread) {
  const lines = [...new Set(unread.filter((c) => !/^rearranged \d+ node/.test(c.summary)).map((c) => `- ${c.summary} [${c.target.kind}${c.target.id ? ` ${c.target.id}` : ""}]`))];
  return [`## Since you last read \u2014 ${lines.length} change(s) by the user`, ...lines].join("\n");
}
function capital(text) {
  return text ? `${text[0].toUpperCase()}${text.slice(1)}` : text;
}
function renderThread(plan, t) {
  const lines = [`- [${t.id}] on ${describeTarget(plan, t.target)} \u2014 ${who(t.author)}: ${t.text}`];
  for (const r of t.replies) lines.push(`  \u21B3 ${who(r.author)}: ${r.text}`);
  if (lastAuthor(t) === "user") lines.push('  \u2192 reply with harness_plan_edit {op:"reply"} once you have acted on it');
  return lines.join("\n");
}
function who(author) {
  return author === "user" ? "user" : "you";
}
function lastAuthor(t) {
  return t.replies.length ? t.replies[t.replies.length - 1].author : t.author;
}
function unreadNotice(plan) {
  const areas = unreadAreas(plan);
  if (!plan || areas.length === 0) return null;
  return `[cc-harness] The user has changed the plan "${plan.title}" in the harness UI since you last read it (${areas.join(", ")}). Call harness_plan_read before acting on the plan.`;
}

// src/test/plan.test.ts
var INPUT = {
  title: "Add a cache",
  summary: "Put a read-through cache in front of the database.",
  sections: [{ title: "Context", body: "Reads are slow." }],
  diagrams: [
    {
      title: "Components",
      nodes: [
        { id: "api", label: "API", kind: "service" },
        { id: "cache", label: "Cache", kind: "datastore" },
        { id: "db", label: "Postgres", kind: "datastore" }
      ],
      edges: [
        { source: "api", target: "cache", label: "get" },
        { source: "cache", target: "db", label: "miss" }
      ]
    }
  ],
  tasks: [
    { title: "Storage layer", subtasks: [{ title: "Cache client" }, { title: "Invalidation", status: "blocked" }] },
    { title: "Wire into API" }
  ]
};
var fresh = () => publishPlan(null, INPUT, 1e3).plan;
test("publishing builds a nested task tree with readable ids", () => {
  const plan = fresh();
  assert.deepEqual(
    outline(plan).map((r) => `${r.number} ${r.task.id} ${r.task.title}`),
    ["1 t1 Storage layer", "1.1 t2 Cache client", "1.2 t3 Invalidation", "2 t4 Wire into API"]
  );
  assert.equal(plan.sections[0].id, "s1");
  assert.equal(plan.diagrams[0].id, "d1");
});
test("progress counts leaf tasks only", () => {
  assert.deepEqual(countTasks(fresh()), { total: 3, done: 0, inProgress: 0, blocked: 1 });
});
test("publishing marks the plan read by Claude", () => {
  const plan = fresh();
  assert.equal(plan.claudeReadSeq, plan.seq);
  assert.equal(unreadByClaude(plan).length, 0);
});
test("a user edit is unread by Claude until it reads the plan", () => {
  const { plan } = applyOps(fresh(), [{ op: "move_task", id: "t4", parentId: "t1", index: 0 }], "user");
  const unread = unreadByClaude(plan);
  assert.equal(unread.length, 1);
  assert.match(unread[0].summary, /moved "Wire into API" under "Storage layer"/);
  assert.match(unreadNotice(plan) ?? "", /harness_plan_read/);
});
test("Claude's own edits never show up as unread", () => {
  const { plan } = applyOps(fresh(), [{ op: "upsert_task", id: "t2", status: "done", note: "added client" }], "claude");
  assert.equal(unreadByClaude(plan).length, 0);
  assert.equal(unreadNotice(plan), null);
});
test("Claude editing does not swallow what the user did first", () => {
  let plan = applyOps(fresh(), [{ op: "comment", target: { kind: "task", id: "t4" }, text: "do this first" }], "user").plan;
  plan = applyOps(plan, [{ op: "upsert_task", id: "t2", status: "in_progress" }], "claude").plan;
  assert.equal(unreadByClaude(plan).length, 1, "the comment is still unread");
});
test("a republish is refused while the user has unread changes", () => {
  const edited = applyOps(fresh(), [{ op: "upsert_task", title: "Load test" }], "user").plan;
  assert.throws(() => publishPlan(edited, INPUT), (err) => err instanceof PlanError && /harness_plan_read/.test(err.message));
});
test("a republish keeps comments and statuses on surviving ids", () => {
  let plan = applyOps(
    fresh(),
    [
      { op: "comment", target: { kind: "task", id: "t2" }, text: "use the pooled client" },
      { op: "upsert_task", id: "t2", status: "done" }
    ],
    "user"
  ).plan;
  plan.claudeReadSeq = plan.seq;
  const next = publishPlan(plan, {
    ...INPUT,
    tasks: [{ id: "t1", title: "Storage layer", subtasks: [{ id: "t2", title: "Cache client (pooled)" }] }]
  }).plan;
  assert.equal(next.tasks.find((t) => t.id === "t2")?.status, "done", "a status Claude did not restate is kept");
  assert.equal(next.threads[0].target.id, "t2");
  assert.equal(next.revision, 2);
});
test("a comment on a removed item is kept, re-homed on the plan", () => {
  let plan = applyOps(fresh(), [{ op: "comment", target: { kind: "task", id: "t4" }, text: "drop this?" }], "user").plan;
  plan = applyOps(plan, [{ op: "remove", kind: "task", id: "t4" }], "user").plan;
  assert.equal(plan.threads[0].target.kind, "plan");
  assert.match(plan.threads[0].text, /on removed task "Wire into API"/);
});
test("removing a task removes its subtasks and unlinks them from the diagram", () => {
  const base = fresh();
  const d = base.diagrams[0];
  let plan = applyOps(
    base,
    [{ op: "upsert_diagram", id: "d1", nodes: d.nodes.map((n) => n.id === "cache" ? { ...n, taskIds: ["t3", "t4"] } : n), edges: d.edges }],
    "claude"
  ).plan;
  plan = applyOps(plan, [{ op: "remove", kind: "task", id: "t1" }], "user").plan;
  assert.deepEqual(plan.tasks.map((t) => t.id), ["t4"]);
  assert.deepEqual(plan.diagrams[0].nodes.find((n) => n.id === "cache")?.taskIds, ["t4"]);
  assert.match(plan.changes.at(-1).summary, /and its 2 subtask/);
});
test("moving a task re-parents it and reorders both sibling lists", () => {
  const { plan } = applyOps(fresh(), [{ op: "move_task", id: "t4", parentId: "t1", index: 0 }], "user");
  assert.deepEqual(
    outline(plan).map((r) => `${r.number} ${r.task.title}`),
    ["1 Storage layer", "1.1 Wire into API", "1.2 Cache client", "1.3 Invalidation"]
  );
  assert.match(plan.changes.at(-1).summary, /moved "Wire into API" under "Storage layer"/);
});
test("a task cannot be moved inside itself", () => {
  assert.throws(() => applyOps(fresh(), [{ op: "move_task", id: "t1", parentId: "t2", index: 0 }], "user"), /inside itself/);
});
test("a batch is all or nothing", () => {
  const before = fresh();
  assert.throws(
    () => applyOps(before, [{ op: "upsert_task", title: "Fine" }, { op: "remove", kind: "task", id: "t99" }], "user"),
    /Edit 2 \(remove\): No task "t99"/
  );
  assert.equal(before.tasks.length, 4, "the plan passed in is untouched");
});
test("ids are never reused, even after a delete", () => {
  let plan = applyOps(fresh(), [{ op: "remove", kind: "task", id: "t4" }], "user").plan;
  plan = applyOps(plan, [{ op: "upsert_task", title: "New" }], "user").plan;
  assert.ok(plan.tasks.some((t) => t.id === "t5"));
  assert.ok(!plan.tasks.some((t) => t.id === "t4"));
});
test("threads: reply and resolve are logged against the item", () => {
  let plan = applyOps(fresh(), [{ op: "comment", target: { kind: "section", id: "s1" }, text: "too vague" }], "user").plan;
  plan = applyOps(plan, [{ op: "reply", threadId: "c1", text: "expanded it" }, { op: "resolve", threadId: "c1", resolved: true }], "claude").plan;
  assert.equal(plan.threads[0].replies[0].author, "claude");
  assert.equal(plan.threads[0].resolved, true);
});
test("an edge to a node that does not exist is refused, naming it", () => {
  assert.throws(
    () => publishPlan(null, { title: "x", diagrams: [{ title: "D", nodes: [{ id: "a", label: "A" }], edges: [{ source: "a", target: "b" }] }] }),
    /refers to node "b"/
  );
});
test("diagram edits are described in words for Claude", () => {
  const { plan } = applyOps(
    fresh(),
    [
      {
        op: "upsert_diagram",
        id: "d1",
        nodes: [
          { id: "api", label: "API" },
          { id: "cache", label: "Redis" },
          { id: "db", label: "Postgres" },
          { id: "queue", label: "Jobs", kind: "queue" }
        ],
        edges: [
          { source: "api", target: "cache", label: "get" },
          { source: "api", target: "queue" }
        ]
      }
    ],
    "user"
  );
  const summary = plan.changes.at(-1).summary;
  assert.match(summary, /added "Jobs"/);
  assert.match(summary, /edited "Redis"/);
  assert.match(summary, /connected API → Jobs/);
  assert.match(summary, /disconnected Redis → Postgres|disconnected Cache → Postgres/);
});
test("dragging boxes saves the layout without telling Claude, and positions survive a republish", () => {
  const base = fresh();
  const moved = applyOps(
    base,
    [
      {
        op: "upsert_diagram",
        id: "d1",
        nodes: base.diagrams[0].nodes.map((n, i) => ({ ...n, x: i * 200, y: 40 })),
        edges: base.diagrams[0].edges
      }
    ],
    "user"
  ).plan;
  assert.equal(moved.changes.length, base.changes.length, "layout is not a change");
  assert.equal(unreadByClaude(moved).length, 0);
  assert.equal(moved.diagrams[0].rev, base.diagrams[0].rev + 1, "but it moves the revision, so a stale save is refused");
  assert.equal(moved.diagrams[0].nodes[1].x, 200);
  const republished = publishPlan(moved, { ...INPUT, diagrams: [{ id: "d1", ...INPUT.diagrams[0] }] }).plan;
  assert.equal(republished.diagrams[0].nodes.find((n) => n.id === "cache")?.x, 200, "Claude did not restate it, so it stays put");
});
test("a box carries notes and the tasks that build it", () => {
  const plan = publishPlan(null, {
    title: "x",
    tasks: [{ id: "build-cache", title: "Build the cache", subtasks: [{ title: "client" }] }],
    diagrams: [
      {
        title: "D",
        nodes: [{ id: "cache", label: "Cache", kind: "datastore", notes: "Redis, because we run it.", taskIds: ["build-cache"] }]
      }
    ]
  }).plan;
  const node = plan.diagrams[0].nodes[0];
  assert.equal(node.notes, "Redis, because we run it.");
  assert.deepEqual(node.taskIds, ["build-cache"]);
  assert.match(renderPlan(plan), /- \*\*Cache\*\* `cache` — data store\n  Decisions:\n    Redis, because we run it\.\n  Built by: \[ \] build-cache Build the cache/);
});
test("a box cannot link a task that does not exist", () => {
  assert.throws(
    () => publishPlan(null, { title: "x", diagrams: [{ title: "D", nodes: [{ id: "a", label: "A", taskIds: ["nope"] }] }] }),
    /links task "nope"/
  );
});
test("linking a box to tasks is described for Claude", () => {
  const base = fresh();
  const d = base.diagrams[0];
  const { plan } = applyOps(
    base,
    [{ op: "upsert_diagram", id: "d1", nodes: d.nodes.map((n) => n.id === "cache" ? { ...n, taskIds: ["t2"], notes: "LRU" } : n), edges: d.edges }],
    "user"
  );
  assert.match(plan.changes.at(-1).summary, /edited "Cache"; changed the tasks behind "Cache"/);
});
test("an edit that changes nothing logs nothing", () => {
  const plan = fresh();
  const d = plan.diagrams[0];
  const { changes } = applyOps(plan, [{ op: "upsert_diagram", id: d.id, nodes: d.nodes, edges: d.edges }], "user");
  assert.equal(changes.length, 0);
});
test("the rendering leads with the changes and carries every id", () => {
  const plan = applyOps(fresh(), [{ op: "upsert_task", title: "Shard it" }], "user").plan;
  const text = renderPlan(plan, { url: "http://x" });
  assert.ok(text.indexOf("Since you last read") < text.indexOf("## Tasks"));
  assert.match(text, /- \[ \] t2 Cache client/);
  assert.match(text, /- \[!\] t3 Invalidation/);
  assert.match(text, /\[d1\] Components/);
  assert.match(text, /- API → Cache: get `api → cache`/);
  assert.match(text, /Added t5 "Shard it" at the top level\./);
  assert.match(text, /t5 Shard it _\(added by the user\)_/);
  assert.doesNotMatch(text, /question/i, "questions live in Claude's chat, not the plan");
});
test("changes-only rendering skips the document", () => {
  const plan = applyOps(fresh(), [{ op: "comment", target: { kind: "plan", id: "" }, text: "looks good" }], "user").plan;
  const text = renderPlan(plan, { changesOnly: true });
  assert.match(text, /Commented on the plan: looks good/);
  assert.match(text, /Comments waiting on you/);
  assert.doesNotMatch(text, /## Tasks/);
});
test("a save made against an old revision is refused, naming who changed it", () => {
  let plan = fresh();
  const rev = plan.sections[0].rev;
  plan = applyOps(plan, [{ op: "upsert_section", id: "s1", body: "Claude rewrote this." }], "claude").plan;
  assert.throws(
    () => applyOps(plan, [{ op: "upsert_section", id: "s1", body: "my stale edit", expect: rev }], "user"),
    /was changed by Claude while this edit was open/
  );
  const ok = applyOps(plan, [{ op: "upsert_section", id: "s1", body: "my edit", expect: plan.sections[0].rev }], "user").plan;
  assert.equal(ok.sections[0].body, "my edit");
});
test("every change to a diagram moves its revision; a no-op does not", () => {
  const plan = fresh();
  const d = plan.diagrams[0];
  const same = applyOps(plan, [{ op: "upsert_diagram", id: "d1", nodes: d.nodes, edges: d.edges, expect: d.rev }], "user").plan;
  assert.equal(same.diagrams[0].rev, d.rev);
  const moved = applyOps(plan, [{ op: "upsert_diagram", id: "d1", nodes: d.nodes.map((n) => ({ ...n, x: 1, y: 2 })), edges: d.edges, expect: d.rev }], "user").plan;
  assert.equal(moved.diagrams[0].rev, d.rev + 1);
  assert.throws(() => applyOps(moved, [{ op: "upsert_diagram", id: "d1", caption: "x", expect: d.rev }], "user"), /not saved/);
});
test("a republish moves the revision only of what it changed", () => {
  const plan = fresh();
  const next = publishPlan(plan, { ...INPUT, sections: [{ id: "s1", title: "Context", body: "Reads are slow." }], diagrams: [{ id: "d1", ...INPUT.diagrams[0], title: "Renamed" }] }).plan;
  assert.equal(next.sections[0].rev, plan.sections[0].rev, "unchanged section keeps its revision");
  assert.equal(next.diagrams[0].rev, plan.diagrams[0].rev + 1);
});
test("a plan read from disk in any older shape is normalized, not rejected", () => {
  const plan = normalizePlan({ title: "old", sections: [{ id: "s1", title: "x", body: "y" }], diagrams: [{ id: "d1", title: "D" }] }, "fallback");
  assert.equal(plan.sections[0].rev, 1);
  assert.deepEqual(plan.diagrams[0].nodes, []);
  assert.deepEqual(plan.tasks, []);
  assert.equal(plan.claudeReadAt, null);
});
test("comment threads and plan items are bounded", () => {
  let plan = fresh();
  const many = Array.from({ length: 61 }, (_, i) => ({ title: `S${i}`, body: "" }));
  assert.throws(() => publishPlan(null, { title: "x", sections: many }), /at most 60 sections/);
  plan = applyOps(plan, [{ op: "comment", target: { kind: "plan", id: "" }, text: "a" }], "user").plan;
  const replies = Array.from({ length: 200 }, () => ({ op: "reply", threadId: "c1", text: "r" }));
  plan = applyOps(plan, replies, "user").plan;
  assert.throws(() => applyOps(plan, [{ op: "reply", threadId: "c1", text: "one more" }], "user"), /thread is full/);
});
//# sourceMappingURL=plan.test.js.map

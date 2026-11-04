var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/shared/paths.ts
import { homedir } from "node:os";
import path from "node:path";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
function harnessHome() {
  const override = process.env.CC_HARNESS_HOME;
  return override && !override.includes("${") ? override : path.join(homedir(), ".claude", "cc-harness");
}
function sanitizeId(id) {
  return id.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128) || "unknown";
}
function ensureHome() {
  const home2 = harnessHome();
  mkdirSync(home2, { recursive: true });
  mkdirSync(path.join(home2, "sessions"), { recursive: true });
  return home2;
}
var paths;
var init_paths = __esm({
  "src/shared/paths.ts"() {
    "use strict";
    paths = {
      home: harnessHome,
      lockFile: () => path.join(harnessHome(), "daemon.json"),
      logFile: () => path.join(harnessHome(), "daemon.log"),
      sessionsDir: () => path.join(harnessHome(), "sessions"),
      sessionDir: (id) => path.join(harnessHome(), "sessions", sanitizeId(id)),
      sessionState: (id) => path.join(harnessHome(), "sessions", sanitizeId(id), "state.json"),
      sessionEvents: (id) => path.join(harnessHome(), "sessions", sanitizeId(id), "events.jsonl"),
      configDir: harnessHome,
      instructionsDir: () => path.join(harnessHome(), "instructions")
    };
  }
});

// src/shared/types.ts
var NODE_KINDS, EDGE_ARROWS, TASK_STATUSES, BUILD_TARGETS;
var init_types = __esm({
  "src/shared/types.ts"() {
    "use strict";
    NODE_KINDS = ["component", "service", "datastore", "queue", "external", "actor", "note"];
    EDGE_ARROWS = ["end", "both", "none"];
    TASK_STATUSES = ["todo", "in_progress", "blocked", "done"];
    BUILD_TARGETS = ["session", "elsewhere"];
  }
});

// src/shared/plan.ts
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
function foldClaudeEdit(base, before2, after2) {
  const out = structuredClone(base);
  if (before2.title !== after2.title) out.title = after2.title;
  if (before2.summary !== after2.summary) out.summary = after2.summary;
  out.sections = foldList(out.sections, before2.sections, after2.sections, foldFields);
  out.tasks = foldList(out.tasks, before2.tasks, after2.tasks, foldFields);
  out.diagrams = foldList(out.diagrams, before2.diagrams, after2.diagrams, (o, b, a) => {
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
function foldList(base, before2, after2, merge) {
  const has = (list, id) => list.some((x) => x.id === id);
  let out = base.filter((x) => !(has(before2, x.id) && !has(after2, x.id)));
  for (const a of after2) {
    const b = before2.find((x) => x.id === a.id);
    const i = out.findIndex((x) => x.id === a.id);
    if (b && i >= 0 && JSON.stringify(b) !== JSON.stringify(a)) out[i] = merge(out[i], b, a);
  }
  const order = (list) => list.filter((x) => has(after2, x.id) && has(before2, x.id)).map((x) => x.id).join("\0");
  if (order(before2) !== order(after2)) {
    const at = new Map(after2.map((x, i) => [x.id, i]));
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
  after2.forEach((a, i) => {
    if (has(before2, a.id) || has(out, a.id)) return;
    let at = 0;
    for (let j = i - 1; j >= 0; j--) {
      const k = out.findIndex((x) => x.id === after2[j].id);
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
function foldEdges(base, before2, after2) {
  const claude = matchEdges(before2, after2);
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
  if (prev?.submission && planPhase(prev) !== "built") throw new PlanError(LOCKED_FOR_CLAUDE);
  if (prev && unreadByClaude(prev).length > 0) {
    throw new PlanError(
      `The user has changed ${unreadItems(prev)} item(s) in the plan since you last read it. Call harness_plan_read first, then publish again (or use harness_plan_edit for targeted changes) so their edits are not overwritten.`
    );
  }
  const title = clean(input.title, MAX_TITLE);
  if (!title) throw new PlanError("A plan needs a title.");
  const base = prev ? structuredClone(prev) : emptyPlan(title, now);
  delete base.submission;
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
function claimIdAmong(plan, kind, wanted, fresh) {
  const key = { section: "sections", diagram: "diagrams", task: "tasks" }[kind];
  const probe = { ...plan, [key]: [...plan[key], ...fresh] };
  return claimId(probe, kind, wanted);
}
function detachIfOrphaned(plan, before2, thread) {
  if (targetExists(plan, thread.target)) return thread;
  const label = describeTarget(before2, thread.target);
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
  const submission = validSubmission(raw.submission);
  if (submission) plan.submission = submission;
  else delete plan.submission;
  return plan;
}
function applyOps(plan, ops, author, now = Date.now()) {
  if (!Array.isArray(ops) || ops.length === 0) throw new PlanError("No edits were given.");
  if (plan.submission) checkLocked(ops, author);
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
        const before2 = structuredClone(existing);
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
        const what = describeDiagramEdit(before2, existing);
        const relaid = layoutChanged(before2, existing);
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
  const before2 = structuredClone(plan);
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
  plan.threads = plan.threads.map((t) => detachIfOrphaned(plan, before2, t));
  return [log("deleted", { kind, id }, summary)];
}
function planPhase(plan) {
  const submission = plan?.submission;
  if (!submission) return "planning";
  if (submission.target === "elsewhere") return "handed-off";
  if (!submission.deliveredAt) return "submitted";
  const counts = countTasks(plan);
  return counts.total > 0 && counts.done === counts.total ? "built" : "building";
}
function checkLocked(ops, author) {
  if (author === "user") throw new PlanError(LOCKED_FOR_USER);
  const refused = ops.find((op) => !TRACKING_OPS.has(op?.op ?? ""));
  if (refused) throw new PlanError(`${LOCKED_FOR_CLAUDE} (Refused: ${refused?.op ?? "an edit"}.)`);
}
function validTarget(value) {
  return BUILD_TARGETS.includes(value) ? value : void 0;
}
function cleanNote(value) {
  return clean(value, MAX_NOTE);
}
function submitPlan(plan, input, now = Date.now()) {
  if (plan.submission) throw new PlanError("The plan has already been submitted.");
  if (!input.prompt.trim()) throw new PlanError("There is no prompt to submit.");
  const next = structuredClone(plan);
  const note = cleanNote(input.note);
  next.submission = {
    at: now,
    target: input.target,
    ...note ? { note } : {},
    prompt: input.prompt,
    ...input.trimmed ? { trimmed: true } : {},
    deliveredAt: null
  };
  next.version += 1;
  next.updatedAt = now;
  return next;
}
function reopenPlan(plan, now = Date.now()) {
  if (!plan.submission) throw new PlanError("The plan is not locked.");
  const next = structuredClone(plan);
  delete next.submission;
  next.version += 1;
  next.updatedAt = now;
  return next;
}
function markDelivered(plan, now = Date.now()) {
  if (!plan.submission || plan.submission.target !== "session" || plan.submission.deliveredAt) return plan;
  const next = structuredClone(plan);
  next.submission.deliveredAt = now;
  markReadByClaude(next, now);
  next.version += 1;
  next.updatedAt = now;
  return next;
}
function validSubmission(raw) {
  const s = raw;
  if (!s || typeof s !== "object") return void 0;
  const target = validTarget(s.target);
  if (!target || typeof s.at !== "number" || typeof s.prompt !== "string" || !s.prompt) return void 0;
  return {
    at: s.at,
    target,
    ...typeof s.note === "string" && s.note ? { note: s.note } : {},
    prompt: s.prompt,
    ...s.trimmed === true ? { trimmed: true } : {},
    deliveredAt: typeof s.deliveredAt === "number" ? s.deliveredAt : null
  };
}
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
function describeDiagramEdit(before2, after2) {
  const parts = [];
  if (before2.title !== after2.title) parts.push(`renamed it from "${before2.title}"`);
  const label = (d, id) => d.nodes.find((n) => n.id === id)?.label ?? id;
  const added = after2.nodes.filter((n) => !before2.nodes.some((b) => b.id === n.id));
  const removed = before2.nodes.filter((n) => !after2.nodes.some((a) => a.id === n.id));
  const changed = after2.nodes.filter((n) => {
    const b = before2.nodes.find((x) => x.id === n.id);
    return b && (b.label !== n.label || b.kind !== n.kind || (b.detail ?? "") !== (n.detail ?? "") || (b.description ?? "") !== (n.description ?? "") || (b.notes ?? "") !== (n.notes ?? ""));
  });
  const relinked = after2.nodes.filter((n) => {
    const b = before2.nodes.find((x) => x.id === n.id);
    return b && (b.taskIds ?? []).join() !== (n.taskIds ?? []).join();
  });
  const matched = matchEdges(before2.edges, after2.edges);
  const linked = matched.added;
  const unlinked = matched.removed;
  const relabeled = matched.pairs.filter(([b, e]) => (b.label ?? "") !== (e.label ?? "") || Boolean(b.dashed) !== Boolean(e.dashed) || (b.arrows ?? "end") !== (e.arrows ?? "end")).map(([, e]) => e);
  const list = (items) => items.length > 3 ? `${items.slice(0, 3).join(", ")} and ${items.length - 3} more` : items.join(", ");
  if (added.length) parts.push(`added ${list(added.map((n) => `"${n.label}"`))}`);
  if (removed.length) parts.push(`removed ${list(removed.map((n) => `"${n.label}"`))}`);
  if (changed.length) parts.push(`edited ${list(changed.map((n) => `"${n.label}"`))}`);
  if (relinked.length) parts.push(`changed the tasks behind ${list(relinked.map((n) => `"${n.label}"`))}`);
  if (linked.length) parts.push(`connected ${list(linked.map((e) => `${label(after2, e.source)} \u2192 ${label(after2, e.target)}`))}`);
  if (unlinked.length) parts.push(`disconnected ${list(unlinked.map((e) => `${label(before2, e.source)} \u2192 ${label(before2, e.target)}`))}`);
  if (relabeled.length) parts.push(`relabelled ${list(relabeled.map((e) => `${label(after2, e.source)} \u2192 ${label(after2, e.target)}`))}`);
  if ((before2.caption ?? "") !== (after2.caption ?? "")) parts.push("edited the caption");
  if (parts.length) return parts.join("; ");
  return designOf(before2) !== designOf(after2) ? EDITED_DESIGN : null;
}
function designOf(d) {
  return JSON.stringify([d.title, d.caption ?? "", d.nodes.map(({ x: _x, y: _y, ...n }) => n), d.edges]);
}
function matchEdges(before2, after2) {
  const pairs = [];
  const left = [...before2];
  const right = [...after2];
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
function layoutChanged(before2, after2) {
  if (before2.direction !== after2.direction) return true;
  return after2.nodes.some((n) => {
    const b = before2.nodes.find((x) => x.id === n.id);
    return b && (b.x !== n.x || b.y !== n.y);
  });
}
function checkRev(item, expect, kind, author) {
  if (typeof expect !== "number" || expect === item.rev) return;
  const who = item.updatedBy === author ? "another edit" : item.updatedBy === "claude" ? "Claude" : "the user";
  throw new PlanError(
    `${kind[0].toUpperCase()}${kind.slice(1)} "${item.title}" was changed by ${who} while this edit was open, so it was not saved. It now shows the latest version.`
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
function currentTask(plan) {
  if (!plan) return null;
  return outline(plan).find((r) => r.task.status === "in_progress" && !plan.tasks.some((t) => t.parentId === r.task.id))?.task ?? null;
}
var PlanError, MAX_CHANGES, MAX_TITLE, MAX_TEXT, MAX_TASKS, MAX_SECTIONS, MAX_DIAGRAMS, MAX_THREADS, MAX_REPLIES, PREFIX, RENAMED_PLAN, MAX_NOTE, TRACKING_OPS, LOCKED_FOR_USER, LOCKED_FOR_CLAUDE, MAX_NODES, MAX_EDGES, MAX_DESCRIPTION, EDITED_DESIGN, STATUS_WORDS;
var init_plan = __esm({
  "src/shared/plan.ts"() {
    "use strict";
    init_types();
    PlanError = class extends Error {
    };
    MAX_CHANGES = 500;
    MAX_TITLE = 200;
    MAX_TEXT = 2e4;
    MAX_TASKS = 400;
    MAX_SECTIONS = 60;
    MAX_DIAGRAMS = 40;
    MAX_THREADS = 500;
    MAX_REPLIES = 200;
    PREFIX = { section: "s", diagram: "d", task: "t", thread: "c" };
    RENAMED_PLAN = "renamed the plan";
    MAX_NOTE = 4e3;
    TRACKING_OPS = /* @__PURE__ */ new Set(["upsert_task", "reply", "resolve"]);
    LOCKED_FOR_USER = "The plan has been submitted to be built, so it is locked. Reopen it to make changes.";
    LOCKED_FOR_CLAUDE = "The user has submitted this plan to be built, so it is locked: only task updates (harness_task_update, or upsert_task to add work you discover) and comment replies (reply, resolve) apply. If the design has to change, ask the user in chat \u2014 they can reopen the plan in Coplan.";
    MAX_NODES = 120;
    MAX_EDGES = 300;
    MAX_DESCRIPTION = 4e3;
    EDITED_DESIGN = "edited";
    STATUS_WORDS = {
      todo: "to do",
      in_progress: "in progress",
      blocked: "blocked",
      done: "done"
    };
  }
});

// src/shared/architecture.ts
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
function diagramChanges(before2, after2, opts = {}) {
  const ids = opts.ids ?? true;
  const out = [];
  const label = (id) => after2.nodes.find((n) => n.id === id)?.label ?? before2.nodes.find((n) => n.id === id)?.label ?? id;
  const ref2 = (n) => ids ? `${n.label} (\`${n.id}\`)` : n.label;
  if (before2.title !== after2.title) out.push(`Renamed the diagram "${before2.title}" \u2192 "${after2.title}".`);
  if ((before2.caption ?? "") !== (after2.caption ?? "")) out.push(...prose("Edited the caption", after2.caption, opts));
  const added = [];
  const removed = [];
  const changed = [];
  for (const n of after2.nodes) {
    const b = before2.nodes.find((x) => x.id === n.id);
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
  for (const b of before2.nodes) {
    if (!after2.nodes.some((n) => n.id === b.id)) removed.push(`Removed ${ref2(b)}.`);
  }
  out.push(...added, ...removed, ...changed);
  const { pairs, removed: cut, added: drawn } = matchEdges(before2.edges, after2.edges);
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
var KIND_NOUN, STATUS_MARK, ARROW;
var init_architecture = __esm({
  "src/shared/architecture.ts"() {
    "use strict";
    init_plan();
    KIND_NOUN = {
      component: "component",
      service: "service",
      datastore: "data store",
      queue: "queue",
      external: "external system",
      actor: "actor",
      note: "note"
    };
    STATUS_MARK = { todo: "[ ]", in_progress: "[~]", blocked: "[!]", done: "[x]" };
    ARROW = { end: "\u2192", both: "\u2194", none: "\u2014" };
  }
});

// src/shared/agents.ts
function isAgentKind(value) {
  return typeof value === "string" && AGENT_KINDS.includes(value);
}
function agentInfo(kind) {
  return AGENTS[kind && isAgentKind(kind) ? kind : DEFAULT_AGENT];
}
var AGENT_KINDS, AGENTS, DEFAULT_AGENT;
var init_agents = __esm({
  "src/shared/agents.ts"() {
    "use strict";
    AGENT_KINDS = ["claude", "codex", "cursor"];
    AGENTS = {
      claude: {
        kind: "claude",
        name: "Claude",
        product: "Claude Code",
        app: "the Claude desktop app",
        askTools: ["AskUserQuestion"],
        askWith: "AskUserQuestion",
        promptContext: true
      },
      codex: {
        kind: "codex",
        name: "Codex",
        product: "Codex",
        app: "the Codex app",
        askTools: ["request_user_input", "request_user_input_async"],
        // Codex only offers request_user_input in Plan mode.
        askWith: "request_user_input (in Plan mode) or plainly",
        promptContext: true
      },
      cursor: {
        kind: "cursor",
        name: "Cursor",
        product: "Cursor",
        app: "Cursor",
        // Cursor's hooks do not see AskQuestion today; a question is noticed
        // when the turn ends on one. Listed for when they do.
        askTools: ["AskQuestion"],
        askWith: "AskQuestion or plainly",
        promptContext: false
      }
    };
    DEFAULT_AGENT = "claude";
  }
});

// src/daemon/render.ts
function renderDocument(plan, opts = {}) {
  const { attribution = true, details = true, reader = "claude" } = opts;
  const out = [];
  if (plan.summary.trim()) out.push("", "## Summary", plan.summary.trim());
  if (plan.sections.length) {
    out.push("", "## Sections");
    for (const s of plan.sections) {
      const by = attribution && s.updatedBy === "user" ? " _(edited by the user)_" : "";
      out.push("", `### [${s.id}] ${s.title}${by}`, s.body.trim() || "_(empty)_");
    }
  }
  if (plan.diagrams.length) {
    out.push("", "## Architecture");
    for (const d of plan.diagrams) {
      const note = attribution && d.updatedBy === "user" ? "last edited by the user" : void 0;
      out.push("", diagramToMarkdown(d, { tasks: plan.tasks, note }));
    }
  }
  out.push("", ...renderTasks(plan, { attribution, details }));
  const open = plan.threads.filter((t) => !t.resolved);
  if (open.length) {
    out.push("", "## Open comments");
    for (const t of open) out.push(renderThread(plan, t, reader));
  }
  out.push("", STATUS_LEGEND);
  return out;
}
function renderTasks(plan, opts = {}) {
  const counts = countTasks(plan);
  const out = [`## Tasks${counts.total ? ` (${counts.done}/${counts.total} done)` : ""}`];
  const rows = outline(plan);
  if (rows.length === 0) out.push("_(no tasks yet)_");
  for (const { task, depth } of rows) {
    const pad = "  ".repeat(depth);
    const by = opts.attribution !== false && task.createdBy === "user" ? " _(added by the user)_" : "";
    const note = task.note ? ` \u2014 ${task.note}` : "";
    out.push(`${pad}- ${STATUS_MARK2[task.status]} ${task.id} ${task.title}${by}${note}`);
    if (task.files?.length) out.push(`${pad}  files: ${task.files.join(", ")}`);
    if (opts.details !== false && task.detail) for (const line of task.detail.trim().split("\n")) out.push(`${pad}  ${line}`);
  }
  return out;
}
function buildPrompt(plan, opts) {
  const here = opts.target === "session";
  const note = opts.note?.trim();
  const head = here ? sessionBrief(plan, agentInfo(opts.agent)) : outsideBrief(plan);
  const fromUser = note ? ["", "## From the user", ...note.split("\n").map((l) => `> ${l}`.trimEnd())] : [];
  const changes = here ? changesSinceRead(plan) : [];
  const full = [...head, ...fromUser, ...changes, ...renderDocument(plan, { attribution: here, reader: here ? "claude" : "outside" })];
  const text = full.join("\n").trim();
  if (!here || text.length <= PROMPT_BUDGET) return { prompt: text, trimmed: false };
  const pointer = `_The architecture (${plan.diagrams.length} diagram(s)), the sections and each task's detail are too long to quote here: call harness_plan_read for them before you start._`;
  const fixed = [...head, ...fromUser, ...clip(changes, 2500), "", pointer];
  if (plan.summary.trim()) fixed.push("", "## Summary", ...clip(plan.summary.trim().split("\n"), 1200));
  const room = PROMPT_BUDGET - fixed.join("\n").length - STATUS_LEGEND.length - 4;
  const tasks = renderTasks(plan, { details: false });
  const kept = [];
  let used = 0;
  for (const line of tasks) {
    if (used + line.length + 1 > room - 80) {
      kept.push(`- \u2026and ${tasks.length - kept.length} more line(s): harness_plan_read lists every task.`);
      break;
    }
    kept.push(line);
    used += line.length + 1;
  }
  return { prompt: [...fixed, "", ...kept, "", STATUS_LEGEND].join("\n").trim(), trimmed: true };
}
function sessionBrief(plan, agent) {
  return [
    `${BUILD_MARKER} "${plan.title}" \u2014 the user has reviewed it in Coplan and submitted it.`,
    "",
    "The plan is final. Its architecture is locked, and from here Coplan only follows your progress on its task board, so keep every task's status true as you go:",
    "",
    "1. Work through the tasks below in order.",
    "2. When you start a task, mark it in_progress with harness_task_update. When it is finished, mark it done with a one-line note of what you did.",
    `3. If you are stuck, mark the task blocked with a note saying on what, and ask the user with ${agent.askWith}.`,
    "4. For work that is not on the plan, add a task first (harness_plan_edit, upsert_task with a parentId), then do it.",
    "5. Do not redesign as you go: the diagrams and sections can no longer be edited. If the design has to change, stop and ask the user in chat \u2014 they can reopen the plan in Coplan."
  ];
}
function outsideBrief(plan) {
  return [
    `Build "${plan.title}". This plan was designed and reviewed before any code was written, and this is its final version.`,
    "",
    "1. Work through the tasks below in order. Each says what it involves and which files it is expected to touch.",
    "2. Build the architecture as described: its parts, what each one does and decides, and how they connect.",
    "3. If the design turns out not to work, stop and say why rather than redesigning as you go."
  ];
}
function changesSinceRead(plan) {
  const unread = unreadByClaude(plan);
  if (!plan.claudeBaseline || unread.length === 0) return [];
  return ["", renderChanges(plan, unread, false)];
}
function clip(lines, max) {
  const out = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length > max) {
      out.push("\u2026");
      break;
    }
    out.push(line);
    used += line.length + 1;
  }
  return out;
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
function renderThread(plan, t, reader = "claude") {
  const who = (author) => author === "user" ? "user" : reader === "claude" ? "you" : "planner";
  const lines = [`- [${t.id}] on ${describeTarget(plan, t.target)} \u2014 ${who(t.author)}: ${t.text}`];
  for (const r of t.replies) lines.push(`  \u21B3 ${who(r.author)}: ${r.text}`);
  if (reader === "claude" && lastAuthor(t) === "user") lines.push('  \u2192 reply with harness_plan_edit {op:"reply"} once you have acted on it');
  return lines.join("\n");
}
function lastAuthor(t) {
  return t.replies.length ? t.replies[t.replies.length - 1].author : t.author;
}
var STATUS_MARK2, STATUS_LEGEND, PROMPT_BUDGET, BUILD_MARKER;
var init_render = __esm({
  "src/daemon/render.ts"() {
    "use strict";
    init_plan();
    init_architecture();
    init_agents();
    STATUS_MARK2 = { todo: "[ ]", in_progress: "[~]", blocked: "[!]", done: "[x]" };
    STATUS_LEGEND = `_Statuses: ${Object.entries(STATUS_MARK2).map(([k, v]) => `${v} ${k}`).join(", ")}_`;
    PROMPT_BUDGET = 9e3;
    BUILD_MARKER = "[cc-harness] Build the plan";
  }
});

// src/daemon/store.ts
var store_exports = {};
__export(store_exports, {
  SessionStore: () => SessionStore,
  newSession: () => newSession,
  sanitizeId: () => sanitizeId,
  summarize: () => summarize
});
import { EventEmitter } from "node:events";
import { mkdirSync as mkdirSync2, readFileSync as readFileSync2, writeFileSync, readdirSync, existsSync as existsSync2, renameSync, rmSync, statSync } from "node:fs";
import path2 from "node:path";
function newSession(sessionId, cwd, agent = DEFAULT_AGENT) {
  const now = Date.now();
  return {
    sessionId,
    agent,
    cwd,
    repoRoot: null,
    branch: null,
    title: path2.basename(cwd) || sessionId.slice(0, 8),
    status: "active",
    waiting: null,
    surface: "unknown",
    link: null,
    createdAt: now,
    updatedAt: now,
    plan: null
  };
}
function summarize(s) {
  const plan = s.plan;
  return {
    sessionId: s.sessionId,
    agent: s.agent,
    title: s.title,
    planTitle: plan?.title ?? null,
    cwd: s.cwd,
    repoName: s.repoRoot ? path2.basename(s.repoRoot) : null,
    repoRoot: s.repoRoot,
    branch: s.branch,
    status: s.status,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    tasks: countTasks(plan),
    phase: planPhase(plan),
    current: currentTask(plan)?.title ?? null,
    waiting: s.waiting,
    surface: s.surface,
    link: s.link,
    openThreads: plan?.threads.filter((t) => !t.resolved).length ?? 0,
    unreadByClaude: unreadItems(plan)
  };
}
function readState(file) {
  if (!existsSync2(file)) return void 0;
  try {
    const state = JSON.parse(readFileSync2(file, "utf8"));
    if (!state || typeof state !== "object" || typeof state.sessionId !== "string") throw new Error("not a session");
    migrate(state);
    return state;
  } catch {
    quarantine(file);
    return void 0;
  }
}
function quarantine(file) {
  try {
    renameSync(file, path2.join(path2.dirname(file), `state.corrupt-${Date.now()}.json`));
  } catch {
  }
}
function migrate(state) {
  const raw = state;
  state.updatedAt = typeof state.updatedAt === "number" ? state.updatedAt : Date.now();
  state.createdAt ??= state.updatedAt;
  state.title = typeof state.title === "string" && state.title ? state.title : state.sessionId.slice(0, 8);
  state.cwd = typeof state.cwd === "string" ? state.cwd : "";
  if (state.status !== "ended") state.status = "idle";
  const oldPlan = raw["plan"];
  if (oldPlan && !Array.isArray(oldPlan["tasks"])) {
    const plan = emptyPlan(String(oldPlan["title"] ?? state.title));
    plan.summary = typeof oldPlan["summary"] === "string" ? oldPlan["summary"] : "";
    if (typeof oldPlan["markdown"] === "string" && oldPlan["markdown"].trim()) {
      plan.sections.push({ id: "s1", title: "Notes", body: oldPlan["markdown"], rev: 1, updatedAt: Date.now(), updatedBy: "claude" });
    }
    const steps = Array.isArray(oldPlan["steps"]) ? oldPlan["steps"] : [];
    steps.forEach((step, i) => {
      const now = Date.now();
      plan.tasks.push({
        id: `t${i + 1}`,
        parentId: null,
        order: i,
        title: String(step["title"] ?? `Step ${i + 1}`),
        ...typeof step["detail"] === "string" ? { detail: step["detail"] } : {},
        status: step["status"] === "done" ? "done" : "todo",
        createdAt: now,
        updatedAt: now,
        createdBy: "claude"
      });
    });
    state.plan = plan;
  }
  state.plan = state.plan && typeof state.plan === "object" ? normalizePlan(state.plan, state.title) : null;
  if (state.plan) {
    const plan = state.plan;
    delete plan["questions"];
    state.plan.threads = state.plan.threads.filter((t) => t.target.kind !== "question");
    state.plan.changes = state.plan.changes.filter((c) => c.target.kind !== "question");
  }
  state.waiting = null;
  state.surface ??= "unknown";
  state.link ??= null;
  state.agent = isAgentKind(state.agent) ? state.agent : DEFAULT_AGENT;
  for (const key of [
    "worktree",
    "transcriptPath",
    "stage",
    "stageNote",
    "baseRef",
    "startCommit",
    "reviewRound",
    "roundHistory",
    "tasks",
    "usage",
    "todos",
    "files",
    "commands",
    "timeline",
    "gates",
    "activeGateId",
    "threads",
    "checks",
    "ship",
    "pendingFeedback",
    "stats"
  ]) {
    delete raw[key];
  }
}
function mtimeOf(dir) {
  try {
    return statSync(dir).mtimeMs;
  } catch {
    return Date.now();
  }
}
function discardDir(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
  }
}
var PERSIST_DEBOUNCE_MS, SESSION_TTL_MS, MAX_SESSIONS, SessionStore;
var init_store = __esm({
  "src/daemon/store.ts"() {
    "use strict";
    init_paths();
    init_plan();
    init_render();
    init_agents();
    PERSIST_DEBOUNCE_MS = 400;
    SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1e3;
    MAX_SESSIONS = 60;
    SessionStore = class extends EventEmitter {
      sessions = /* @__PURE__ */ new Map();
      persistTimers = /* @__PURE__ */ new Map();
      constructor() {
        super();
        this.setMaxListeners(0);
        ensureHome();
        this.loadFromDisk();
      }
      /* ---------------------------------------------------------------- *
       * Lifecycle
       * ---------------------------------------------------------------- */
      loadFromDisk() {
        const dir = paths.sessionsDir();
        if (!existsSync2(dir)) return;
        const loaded = [];
        const expired = [];
        const cutoff = Date.now() - SESSION_TTL_MS;
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const sessionDir = path2.join(dir, entry.name);
          const file = path2.join(sessionDir, "state.json");
          if (!existsSync2(file)) {
            if (mtimeOf(sessionDir) < cutoff) expired.push(sessionDir);
            continue;
          }
          const state = readState(file);
          if (!state) continue;
          if ((state.updatedAt ?? 0) < cutoff) {
            expired.push(sessionDir);
            continue;
          }
          loaded.push(state);
        }
        loaded.sort((a, b) => b.updatedAt - a.updatedAt);
        for (const state of loaded.slice(0, MAX_SESSIONS)) this.sessions.set(state.sessionId, state);
        for (const sessionDir of expired) discardDir(sessionDir);
      }
      /** Forget a session in memory; its state stays on disk. */
      drop(id) {
        const timer = this.persistTimers.get(id);
        if (timer) {
          clearTimeout(timer);
          this.persistTimers.delete(id);
          this.persistNow(id);
        }
        const removed = this.sessions.delete(id);
        if (removed) this.broadcastSessionList();
        return removed;
      }
      /**
       * Delete a session for good, on disk too. Anything short of removing the
       * directory would let `ensure` resurrect it the next time a hook fired.
       */
      purge(id) {
        const timer = this.persistTimers.get(id);
        if (timer) {
          clearTimeout(timer);
          this.persistTimers.delete(id);
        }
        const removed = this.sessions.delete(id);
        discardDir(paths.sessionDir(id));
        if (removed) this.broadcastSessionList();
        return removed;
      }
      /** Evict sessions that ended a while ago, then enforce the cap. */
      sweep(opts = { endedTtlMs: 60 * 60 * 1e3 }) {
        const now = opts.now ?? Date.now();
        let dropped = 0;
        for (const state of [...this.sessions.values()]) {
          if (state.status === "ended" && now - (state.endedAt ?? state.updatedAt) > opts.endedTtlMs) {
            this.drop(state.sessionId);
            dropped++;
          }
        }
        for (const state of this.all().slice(MAX_SESSIONS)) {
          this.drop(state.sessionId);
          dropped++;
        }
        return dropped;
      }
      persistSoon(id) {
        const existing = this.persistTimers.get(id);
        if (existing) clearTimeout(existing);
        const timer = setTimeout(() => {
          this.persistTimers.delete(id);
          this.persistNow(id);
        }, PERSIST_DEBOUNCE_MS);
        timer.unref?.();
        this.persistTimers.set(id, timer);
      }
      persistNow(id) {
        const state = this.sessions.get(id);
        if (!state) return;
        try {
          const dir = paths.sessionDir(id);
          mkdirSync2(dir, { recursive: true });
          const tmp = path2.join(dir, `.state.${process.pid}.tmp`);
          writeFileSync(tmp, JSON.stringify(state, null, 2));
          renameSync(tmp, path2.join(dir, "state.json"));
        } catch {
        }
      }
      persistAll() {
        for (const id of this.sessions.keys()) this.persistNow(id);
      }
      /* ---------------------------------------------------------------- *
       * Access
       * ---------------------------------------------------------------- */
      get(id) {
        return this.sessions.get(id);
      }
      /** Get or create. A session that was swept from memory is read back from
       *  disk rather than overwritten with a blank one. */
      ensure(id, cwd, agent) {
        let state = this.sessions.get(id);
        if (!state) {
          state = readState(paths.sessionState(id)) ?? newSession(id, cwd || process.cwd(), agent);
          this.sessions.set(id, state);
          mkdirSync2(paths.sessionDir(id), { recursive: true });
          this.emitEvent({ type: "snapshot", session: state });
          this.broadcastSessionList();
        } else if (cwd && state.cwd !== cwd && !state.repoRoot) {
          state.cwd = cwd;
        }
        return state;
      }
      all() {
        return [...this.sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt);
      }
      /** The rail's rows, newest session first. Ordered on creation so rows
       *  never move out from under the cursor. */
      summaries() {
        return [...this.sessions.values()].sort((a, b) => b.createdAt - a.createdAt).map((s) => summarize(s));
      }
      /** Most recently updated session rooted at `cwd` — of `agent`, when one is
       *  named, so a Cursor window never picks up a Claude session in the same
       *  folder. */
      findByCwd(cwd, agent) {
        const normalized = path2.resolve(cwd);
        const matches = (value) => !!value && path2.resolve(value) === normalized;
        return this.all().find((s) => (!agent || s.agent === agent) && (matches(s.cwd) || matches(s.repoRoot)));
      }
      findByPid(pid, agent) {
        return this.all().find((s) => s.claudePid === pid && (!agent || s.agent === agent));
      }
      /* ---------------------------------------------------------------- *
       * Mutation
       * ---------------------------------------------------------------- */
      update(id, patch) {
        return this.mutate(id, (s) => Object.assign(s, patch));
      }
      /** Mutate in place, persist, and broadcast the whole session. */
      mutate(id, fn) {
        const state = this.sessions.get(id);
        if (!state) return void 0;
        fn(state);
        state.updatedAt = Date.now();
        this.persistSoon(id);
        this.emitEvent({ type: "snapshot", session: state });
        this.broadcastSessionList();
        return state;
      }
      /** Claude publishes the plan wholesale. Throws `PlanError` when refused. */
      publishPlan(id, input) {
        const session = this.sessions.get(id);
        if (!session) throw new Error("unknown session");
        const result = publishPlan(session.plan, input);
        this.mutate(id, (s) => {
          s.plan = result.plan;
        });
        return result;
      }
      /** Apply edits from either side. Throws `PlanError` when any op fails, in
       *  which case nothing is changed. */
      applyOps(id, ops, author) {
        const session = this.sessions.get(id);
        if (!session) throw new Error("unknown session");
        const base = session.plan ?? emptyPlan(session.title);
        const result = applyOps(base, ops, author);
        this.mutate(id, (s) => {
          s.plan = result.plan;
        });
        return result;
      }
      /**
       * The user submits the plan to be built. The prompt is built here, from
       * the plan as the daemon holds it, and only if that is still the version
       * the user previewed — what they read is what Claude gets.
       */
      submit(id, input) {
        const session = this.sessions.get(id);
        if (!session) throw new Error("unknown session");
        const plan = session.plan;
        if (!plan) throw new PlanError("There is no plan to submit yet.");
        if (typeof input.expect === "number" && input.expect !== plan.version) {
          throw new PlanError("The plan changed while you were reviewing it. The preview now shows the latest version \u2014 check it, then submit again.");
        }
        const { prompt, trimmed } = buildPrompt(plan, { target: input.target, agent: session.agent, ...input.note ? { note: input.note } : {} });
        const next = submitPlan(plan, { target: input.target, prompt, trimmed, ...input.note ? { note: input.note } : {} });
        this.mutate(id, (s) => {
          s.plan = next;
        });
        this.persistNow(id);
        return next;
      }
      /** Unlock a submitted plan. */
      reopen(id) {
        const session = this.sessions.get(id);
        if (!session) throw new Error("unknown session");
        if (!session.plan) throw new PlanError("There is no plan.");
        const next = reopenPlan(session.plan);
        this.mutate(id, (s) => {
          s.plan = next;
        });
        this.persistNow(id);
        return next;
      }
      /**
       * The build prompt is on its way to Claude, if one is waiting: returns it,
       * and records that it went. Only ever once per submission.
       */
      deliver(id) {
        const plan = this.sessions.get(id)?.plan;
        const submission = plan?.submission;
        if (!plan || !submission || submission.target !== "session" || submission.deliveredAt) return null;
        const next = markDelivered(plan);
        this.mutate(id, (s) => {
          s.plan = next;
        });
        this.persistNow(id);
        return next.submission ?? null;
      }
      /** Move Claude's read position to the end of the change log. */
      markRead(id) {
        const session = this.sessions.get(id);
        if (!session?.plan) return;
        if (session.plan.claudeReadSeq === session.plan.seq && session.plan.claudeReadAt && session.plan.claudeBaseline) return;
        this.mutate(id, (s) => {
          if (s.plan) markReadByClaude(s.plan);
        });
      }
      /* ---------------------------------------------------------------- *
       * Fan-out
       * ---------------------------------------------------------------- */
      emitEvent(event) {
        this.emit("event", event);
      }
      /**
       * The rail's list, coalesced: a canvas drag or a batch of hook events can
       * change a session many times in one tick, and every open page only needs
       * the last of them.
       */
      broadcastSessionList() {
        if (this.listQueued) return;
        this.listQueued = true;
        setImmediate(() => {
          this.listQueued = false;
          this.emitEvent({ type: "sessions", sessions: this.summaries() });
        });
      }
      listQueued = false;
    };
  }
});

// src/test/store.test.ts
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync as rmSync2, existsSync as existsSync3, mkdirSync as mkdirSync3, writeFileSync as writeFileSync2, readdirSync as readdirSync2, readFileSync as readFileSync3 } from "node:fs";
import { tmpdir } from "node:os";
import path3 from "node:path";
var home;
before(() => {
  home = mkdtempSync(path3.join(tmpdir(), "cc-harness-test-"));
  process.env["CC_HARNESS_HOME"] = home;
});
after(() => rmSync2(home, { recursive: true, force: true }));
async function freshStore() {
  const { SessionStore: SessionStore2 } = await Promise.resolve().then(() => (init_store(), store_exports));
  return new SessionStore2();
}
var PLAN = { title: "Plan", tasks: [{ title: "one" }, { title: "two" }] };
test("a plan survives a daemon restart", async () => {
  const store = await freshStore();
  store.ensure("s1", process.cwd());
  store.publishPlan("s1", PLAN);
  store.applyOps("s1", [{ op: "upsert_task", id: "t1", status: "done" }], "user");
  store.persistNow("s1");
  const reloaded = await freshStore();
  const plan = reloaded.get("s1")?.plan;
  assert.ok(plan, "the plan was reloaded from disk");
  assert.equal(plan.tasks.find((t) => t.id === "t1")?.status, "done");
  assert.equal(plan.changes.at(-1)?.author, "user", "and so was its change log");
});
test("a refused edit changes nothing", async () => {
  const store = await freshStore();
  store.ensure("s2", process.cwd());
  store.publishPlan("s2", PLAN);
  const before2 = JSON.stringify(store.get("s2").plan);
  assert.throws(() => store.applyOps("s2", [{ op: "upsert_task", title: "ok" }, { op: "remove", kind: "task", id: "nope" }], "user"));
  assert.equal(JSON.stringify(store.get("s2").plan), before2);
});
test("the user can start a plan before Claude publishes one", async () => {
  const store = await freshStore();
  store.ensure("s3", process.cwd());
  store.applyOps("s3", [{ op: "set_meta", title: "My idea" }, { op: "upsert_task", title: "first step" }], "user");
  const plan = store.get("s3").plan;
  assert.equal(plan.title, "My idea");
  assert.equal(plan.tasks[0].createdBy, "user");
});
test("reading moves Claude to the end of the change log", async () => {
  const store = await freshStore();
  store.ensure("s4", process.cwd());
  store.publishPlan("s4", PLAN);
  store.applyOps("s4", [{ op: "comment", target: { kind: "plan", id: "" }, text: "hm" }], "user");
  const { summarize: summarize2 } = await Promise.resolve().then(() => (init_store(), store_exports));
  assert.equal(summarize2(store.get("s4")).unreadByClaude, 1);
  store.markRead("s4");
  assert.equal(summarize2(store.get("s4")).unreadByClaude, 0);
});
test("every change is broadcast as a whole-session snapshot", async () => {
  const store = await freshStore();
  store.ensure("s5", process.cwd());
  const seen = [];
  store.on("event", (e) => seen.push(e.type));
  store.publishPlan("s5", PLAN);
  store.applyOps("s5", [{ op: "upsert_task", title: "more" }], "user");
  assert.ok(seen.includes("snapshot"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(seen.filter((t) => t === "sessions").length, 1, "the rail hears about it once per tick");
});
test("a session written by the old review loop is migrated to a plan", async () => {
  const dir = path3.join(home, "sessions", "legacy");
  mkdirSync3(dir, { recursive: true });
  writeFileSync2(
    path3.join(dir, "state.json"),
    JSON.stringify({
      sessionId: "legacy",
      cwd: process.cwd(),
      title: "old",
      status: "waiting",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      stage: "plan_review",
      gates: [{ id: "g" }],
      plan: { title: "Old plan", summary: "why", markdown: "notes", steps: [{ id: "s1", title: "step one" }], revision: 1 }
    })
  );
  const store = await freshStore();
  const s = store.get("legacy");
  assert.equal(s.plan?.title, "Old plan");
  assert.deepEqual(s.plan?.tasks.map((t) => t.title), ["step one"]);
  assert.equal(s.plan?.sections[0]?.body, "notes");
  assert.equal(s.status, "idle");
  assert.equal(s["gates"], void 0, "the review-loop state is dropped");
});
test("sweep evicts sessions that ended long ago and keeps live ones", async () => {
  const store = await freshStore();
  store.ensure("live", process.cwd());
  store.ensure("finished", process.cwd());
  store.update("finished", { status: "ended", endedAt: Date.now() - 2 * 60 * 60 * 1e3 });
  store.sweep({ endedTtlMs: 60 * 60 * 1e3 });
  assert.equal(store.get("finished"), void 0);
  assert.ok(store.get("live"));
});
test("an evicted session is read back from disk, not blanked", async () => {
  const store = await freshStore();
  store.ensure("evicted", process.cwd());
  store.publishPlan("evicted", PLAN);
  store.drop("evicted");
  assert.equal(store.get("evicted"), void 0);
  assert.equal(store.ensure("evicted", process.cwd()).plan?.title, "Plan");
});
test("purge removes a session from memory and from disk, for good", async () => {
  const store = await freshStore();
  store.ensure("gone", process.cwd());
  store.publishPlan("gone", PLAN);
  store.persistNow("gone");
  assert.equal(store.purge("gone"), true);
  assert.ok(!existsSync3(path3.join(home, "sessions", "gone")));
  assert.equal(store.ensure("gone", process.cwd()).plan, null, "a purged session does not come back");
  assert.equal(store.purge("never-existed"), false);
});
test("sessions older than the retention window are not loaded", async () => {
  const dir = path3.join(home, "sessions", "ancient");
  mkdirSync3(dir, { recursive: true });
  writeFileSync2(
    path3.join(dir, "state.json"),
    JSON.stringify({ sessionId: "ancient", cwd: process.cwd(), updatedAt: Date.now() - 90 * 24 * 60 * 60 * 1e3, status: "ended" })
  );
  const store = await freshStore();
  assert.equal(store.get("ancient"), void 0);
});
test("an unreadable state file is moved aside, never overwritten", async () => {
  const dir = path3.join(home, "sessions", "damaged");
  mkdirSync3(dir, { recursive: true });
  writeFileSync2(path3.join(dir, "state.json"), '{"sessionId":"damaged","plan":{"title":"precious"');
  const store = await freshStore();
  assert.equal(store.get("damaged"), void 0);
  const aside = readdirSync2(dir).find((f) => f.startsWith("state.corrupt-"));
  assert.ok(aside, "the damaged file is kept beside, for recovery by hand");
  assert.match(readFileSync3(path3.join(dir, aside), "utf8"), /precious/);
  store.ensure("damaged", process.cwd());
  store.persistNow("damaged");
  assert.ok(existsSync3(path3.join(dir, aside)));
});
test("a plan missing lists from an older build still loads", async () => {
  const dir = path3.join(home, "sessions", "sparse");
  mkdirSync3(dir, { recursive: true });
  writeFileSync2(
    path3.join(dir, "state.json"),
    JSON.stringify({ sessionId: "sparse", cwd: "/x", title: "t", status: "idle", updatedAt: Date.now(), plan: { title: "P", tasks: [], seq: 3 } })
  );
  const store = await freshStore();
  const plan = store.get("sparse")?.plan;
  assert.ok(plan);
  assert.deepEqual(plan.threads, []);
  assert.deepEqual(plan.diagrams, []);
  assert.equal(plan.seq, 3);
});
//# sourceMappingURL=store.test.js.map

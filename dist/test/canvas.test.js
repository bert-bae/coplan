var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/ui/lib/api.ts
async function request(route, init) {
  const res = await fetch(route, {
    credentials: "same-origin",
    ...init,
    headers: { "content-type": "application/json", ...init?.headers ?? {} }
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    let message = body;
    try {
      message = JSON.parse(body).error ?? body;
    } catch {
    }
    throw new Error(message ? message.slice(0, 300) : `${res.status} ${res.statusText}`);
  }
  const type = res.headers.get("content-type") ?? "";
  return type.includes("json") ? await res.json() : await res.text();
}
var api;
var init_api = __esm({
  "src/ui/lib/api.ts"() {
    "use strict";
    api = {
      sessions: () => request("/api/sessions"),
      session: (id) => request(`/api/session/${id}`),
      /** Permanent: the daemon removes the session's on-disk directory too. */
      deleteSession: (id) => request(`/api/session/${id}`, { method: "DELETE" }),
      renameSession: (id, title) => request(`/api/session/${id}/title`, { method: "POST", body: JSON.stringify({ title }) }),
      /** Every edit the user makes goes through here, as a batch applied all or nothing. */
      ops: (id, ops) => request(`/api/session/${id}/plan/ops`, {
        method: "POST",
        body: JSON.stringify({ ops })
      }),
      /** The plan exactly as Claude reads it. */
      planText: (id) => request(`/api/session/${id}/plan/text`),
      /** The prompt Claude would be given if the plan were submitted now. */
      promptPreview: (id, target, note) => request(`/api/session/${id}/plan/prompt`, {
        method: "POST",
        body: JSON.stringify({ target, note })
      }),
      /** Lock the plan and hand it over to be built. `expect` is the version
       *  the preview was made from; a plan that moved on since is refused. */
      submitPlan: (id, body) => request(`/api/session/${id}/plan/submit`, { method: "POST", body: JSON.stringify(body) }),
      reopenPlan: (id) => request(`/api/session/${id}/plan/reopen`, { method: "POST", body: "{}" }),
      /* ---------------------- daemon-wide actions ---------------------- */
      storage: () => request("/api/storage"),
      cleanStorage: (groups) => request("/api/storage/clean", {
        method: "POST",
        body: JSON.stringify({ groups })
      }),
      restartDaemon: () => request("/api/daemon/restart", { method: "POST", body: "{}" }),
      /** Unauthenticated liveness; `pid` tells a successor from a survivor. */
      health: () => request("/health")
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
var plan_exports = {};
__export(plan_exports, {
  MAX_CHANGES: () => MAX_CHANGES,
  MAX_NOTE: () => MAX_NOTE,
  PlanError: () => PlanError,
  applyOps: () => applyOps,
  baselineOf: () => baselineOf,
  childrenOf: () => childrenOf,
  cleanNote: () => cleanNote,
  countTasks: () => countTasks,
  currentTask: () => currentTask,
  descendants: () => descendants,
  describeTarget: () => describeTarget,
  emptyPlan: () => emptyPlan,
  flowRanks: () => flowRanks,
  isLocked: () => isLocked,
  markDelivered: () => markDelivered,
  markReadByClaude: () => markReadByClaude,
  matchEdges: () => matchEdges,
  normalizePlan: () => normalizePlan,
  outline: () => outline,
  planPhase: () => planPhase,
  publishPlan: () => publishPlan,
  reopenPlan: () => reopenPlan,
  sameContent: () => sameContent,
  short: () => short,
  submitPlan: () => submitPlan,
  suggestDirection: () => suggestDirection,
  targetExists: () => targetExists,
  unreadAreas: () => unreadAreas,
  unreadByClaude: () => unreadByClaude,
  unreadItems: () => unreadItems,
  validTarget: () => validTarget
});
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
function foldClaudeEdit(base, before, after2) {
  const out = structuredClone(base);
  if (before.title !== after2.title) out.title = after2.title;
  if (before.summary !== after2.summary) out.summary = after2.summary;
  out.sections = foldList(out.sections, before.sections, after2.sections, foldFields);
  out.tasks = foldList(out.tasks, before.tasks, after2.tasks, foldFields);
  out.diagrams = foldList(out.diagrams, before.diagrams, after2.diagrams, (o, b, a) => {
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
function foldList(base, before, after2, merge) {
  const has = (list, id) => list.some((x) => x.id === id);
  let out = base.filter((x) => !(has(before, x.id) && !has(after2, x.id)));
  for (const a of after2) {
    const b = before.find((x) => x.id === a.id);
    const i = out.findIndex((x) => x.id === a.id);
    if (b && i >= 0 && JSON.stringify(b) !== JSON.stringify(a)) out[i] = merge(out[i], b, a);
  }
  const order = (list) => list.filter((x) => has(after2, x.id) && has(before, x.id)).map((x) => x.id).join("\0");
  if (order(before) !== order(after2)) {
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
    if (has(before, a.id) || has(out, a.id)) return;
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
    const items2 = value.map((v) => canonical(v));
    if (key === "edges") items2.sort();
    return `[${items2.join(",")}]`;
  }
  if (value && typeof value === "object") {
    const o = value;
    const keys = Object.keys(o).filter((k) => o[k] !== void 0).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(o[k], k)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
function foldEdges(base, before, after2) {
  const claude = matchEdges(before, after2);
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
function planPhase(plan) {
  const submission = plan?.submission;
  if (!submission) return "planning";
  if (submission.target === "elsewhere") return "handed-off";
  if (!submission.deliveredAt) return "submitted";
  const counts = countTasks(plan);
  return counts.total > 0 && counts.done === counts.total ? "built" : "building";
}
function isLocked(plan) {
  return Boolean(plan?.submission);
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
function describeDiagramEdit(before, after2) {
  const parts = [];
  if (before.title !== after2.title) parts.push(`renamed it from "${before.title}"`);
  const label = (d, id) => d.nodes.find((n) => n.id === id)?.label ?? id;
  const added = after2.nodes.filter((n) => !before.nodes.some((b) => b.id === n.id));
  const removed = before.nodes.filter((n) => !after2.nodes.some((a) => a.id === n.id));
  const changed = after2.nodes.filter((n) => {
    const b = before.nodes.find((x) => x.id === n.id);
    return b && (b.label !== n.label || b.kind !== n.kind || (b.detail ?? "") !== (n.detail ?? "") || (b.description ?? "") !== (n.description ?? "") || (b.notes ?? "") !== (n.notes ?? ""));
  });
  const relinked = after2.nodes.filter((n) => {
    const b = before.nodes.find((x) => x.id === n.id);
    return b && (b.taskIds ?? []).join() !== (n.taskIds ?? []).join();
  });
  const matched = matchEdges(before.edges, after2.edges);
  const linked = matched.added;
  const unlinked = matched.removed;
  const relabeled = matched.pairs.filter(([b, e]) => (b.label ?? "") !== (e.label ?? "") || Boolean(b.dashed) !== Boolean(e.dashed) || (b.arrows ?? "end") !== (e.arrows ?? "end")).map(([, e]) => e);
  const list = (items2) => items2.length > 3 ? `${items2.slice(0, 3).join(", ")} and ${items2.length - 3} more` : items2.join(", ");
  if (added.length) parts.push(`added ${list(added.map((n) => `"${n.label}"`))}`);
  if (removed.length) parts.push(`removed ${list(removed.map((n) => `"${n.label}"`))}`);
  if (changed.length) parts.push(`edited ${list(changed.map((n) => `"${n.label}"`))}`);
  if (relinked.length) parts.push(`changed the tasks behind ${list(relinked.map((n) => `"${n.label}"`))}`);
  if (linked.length) parts.push(`connected ${list(linked.map((e) => `${label(after2, e.source)} \u2192 ${label(after2, e.target)}`))}`);
  if (unlinked.length) parts.push(`disconnected ${list(unlinked.map((e) => `${label(before, e.source)} \u2192 ${label(before, e.target)}`))}`);
  if (relabeled.length) parts.push(`relabelled ${list(relabeled.map((e) => `${label(after2, e.source)} \u2192 ${label(after2, e.target)}`))}`);
  if ((before.caption ?? "") !== (after2.caption ?? "")) parts.push("edited the caption");
  if (parts.length) return parts.join("; ");
  return designOf(before) !== designOf(after2) ? EDITED_DESIGN : null;
}
function designOf(d) {
  return JSON.stringify([d.title, d.caption ?? "", d.nodes.map(({ x: _x, y: _y, ...n }) => n), d.edges]);
}
function matchEdges(before, after2) {
  const pairs = [];
  const left = [...before];
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
  const ends2 = (b, a) => b.source === a.source && b.target === a.target;
  take((b, a) => b.id !== void 0 && b.id === a.id && ends2(b, a));
  take((b, a) => ends2(b, a) && (b.label ?? "") === (a.label ?? ""));
  take(ends2);
  return { pairs, removed: left, added: right };
}
function layoutChanged(before, after2) {
  if (before.direction !== after2.direction) return true;
  return after2.nodes.some((n) => {
    const b = before.nodes.find((x) => x.id === n.id);
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
    LOCKED_FOR_CLAUDE = "The user has submitted this plan to be built, so it is locked: only task updates (harness_task_update, or upsert_task to add work you discover) and comment replies (reply, resolve) apply. If the design has to change, ask the user in chat \u2014 they can reopen the plan in the harness.";
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

// src/ui/store.ts
var store_exports = {};
__export(store_exports, {
  TAB_IDS: () => TAB_IDS,
  describeError: () => describeError,
  formatBytes: () => formatBytes,
  store: () => store,
  usePlan: () => usePlan,
  useSession: () => useSession,
  useStore: () => useStore
});
import { useSyncExternalStore } from "react";
function describeError(err) {
  if (err instanceof Error) return err.message;
  return String(err);
}
async function waitForDaemon(previousPid, timeoutMs = 2e4) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => window.setTimeout(resolve, 250));
    try {
      const health = await api.health();
      if (health.ok && health.pid !== previousPid) return true;
    } catch {
    }
  }
  return false;
}
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
function readHash() {
  const match = /^#\/session\/([^/?]+)/.exec(window.location.hash);
  return match ? decodeURIComponent(match[1]) : null;
}
function loadPrefs() {
  try {
    const raw = window.localStorage.getItem(PREFS_KEY);
    if (!raw) return {};
    const saved = JSON.parse(raw);
    const prefs = {};
    const strings = (v) => Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
    if (typeof saved["collapsedSidebar"] === "boolean") prefs.collapsedSidebar = saved["collapsedSidebar"];
    if (Array.isArray(saved["pinned"])) prefs.pinned = strings(saved["pinned"]);
    if (Array.isArray(saved["collapsedProjects"])) prefs.collapsedProjects = strings(saved["collapsedProjects"]);
    if (Array.isArray(saved["collapsedTasks"])) prefs.collapsedTasks = strings(saved["collapsedTasks"]);
    if (saved["taskMode"] === "outline" || saved["taskMode"] === "board") prefs.taskMode = saved["taskMode"];
    if (typeof saved["hideDone"] === "boolean") prefs.hideDone = saved["hideDone"];
    return prefs;
  } catch {
    return {};
  }
}
function savePrefs(prefs) {
  try {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
  }
}
function useStore(select) {
  return useSyncExternalStore(
    store.subscribe,
    () => select(store.getState()),
    () => select(store.getState())
  );
}
function useSession() {
  return useStore((s) => s.session);
}
function usePlan() {
  return useStore((s) => s.session?.plan ?? null);
}
var TAB_IDS, initial, PREFS_KEY, Store, store;
var init_store = __esm({
  "src/ui/store.ts"() {
    "use strict";
    init_api();
    init_plan();
    TAB_IDS = ["diagrams", "tasks", "overview"];
    initial = {
      sessions: [],
      sessionId: null,
      session: null,
      tab: "diagrams",
      diagramId: null,
      connection: "connecting",
      taskMode: "outline",
      hideDone: false,
      collapsedTasks: [],
      collapsedSidebar: false,
      drawerOpen: false,
      pinned: [],
      collapsedProjects: [],
      focusTarget: null,
      storage: null,
      storageBusy: false,
      restarting: false,
      saving: 0,
      toasts: [],
      error: null
    };
    PREFS_KEY = "cc-harness:prefs";
    Store = class {
      state = { ...initial, ...loadPrefs() };
      listeners = /* @__PURE__ */ new Set();
      source = null;
      reconnectTimer;
      getState = () => this.state;
      subscribe = (listener) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
      };
      set(patch) {
        this.state = { ...this.state, ...patch };
        for (const listener of this.listeners) listener();
      }
      /* ---------------------------------------------------------------- *
       * Boot
       * ---------------------------------------------------------------- */
      async init() {
        const url = new URL(window.location.href);
        if (url.searchParams.has("token")) {
          url.searchParams.delete("token");
          window.history.replaceState({}, "", `${url.pathname}${url.hash}`);
        }
        try {
          const { sessions } = await api.sessions();
          this.set({ sessions });
          const target = readHash() ?? sessions[0]?.sessionId ?? null;
          if (target) await this.selectSession(target, false);
        } catch (err) {
          this.set({ error: describeError(err) });
        }
        if (!this.source) this.connect();
        window.addEventListener("hashchange", () => {
          const id = readHash();
          if (id && id !== this.state.sessionId) void this.selectSession(id, false);
        });
      }
      async selectSession(id, updateHash = true) {
        if (updateHash) window.location.hash = `#/session/${id}`;
        this.set({ sessionId: id, session: null, diagramId: null, error: null });
        this.connect();
        try {
          const { session } = await api.session(id);
          if (this.state.sessionId === id) this.set({ session });
        } catch (err) {
          if (this.state.sessionId === id) this.set({ error: describeError(err) });
        }
      }
      /* ---------------------------------------------------------------- *
       * Live connection
       * ---------------------------------------------------------------- */
      connect() {
        this.source?.close();
        window.clearTimeout(this.reconnectTimer);
        const query = this.state.sessionId ? `?session=${encodeURIComponent(this.state.sessionId)}` : "";
        const source = new EventSource(`/api/events${query}`);
        this.source = source;
        source.onopen = () => this.set({ connection: "live" });
        source.onerror = () => {
          this.set({ connection: "reconnecting" });
          window.clearTimeout(this.reconnectTimer);
          this.reconnectTimer = window.setTimeout(() => void this.resync(), 5e3);
        };
        source.onmessage = (message) => {
          try {
            this.apply(JSON.parse(message.data));
          } catch {
          }
        };
      }
      async resync() {
        if (this.state.connection === "live" || !this.state.sessionId) return;
        try {
          const { session } = await api.session(this.state.sessionId);
          this.set({ session, connection: "live" });
        } catch {
        }
      }
      apply(event) {
        switch (event.type) {
          case "sessions":
            this.set({ sessions: event.sessions });
            return;
          case "snapshot": {
            if (event.session.sessionId !== this.state.sessionId) return;
            const before = this.state.session?.plan;
            const after2 = event.session.plan;
            if (before && after2 && after2.revision > before.revision) {
              this.toast("info", `Claude published revision ${after2.revision} of the plan.`);
            }
            if (before?.submission && !before.submission.deliveredAt && after2?.submission?.deliveredAt) {
              this.toast("success", "Claude has the build prompt. Follow it on the board.");
            }
            this.set({ session: event.session });
            return;
          }
          case "ping":
            return;
        }
      }
      /* ---------------------------------------------------------------- *
       * Editing the plan
       * ---------------------------------------------------------------- */
      /**
       * Send edits to the daemon. Resolves true when they were accepted; on a
       * refusal the daemon's reason is shown and the plan is left as it was.
       */
      async ops(ops) {
        return await this.commit(ops) !== null;
      }
      /**
       * Send edits, and resolve with the plan exactly as the daemon left it after
       * them — or null when they were refused. Callers that build on the result
       * (the canvas's revision) need the daemon's answer, not whatever the store
       * holds by the time it arrives.
       */
      async commit(ops, sessionId = this.state.sessionId) {
        const id = sessionId;
        if (!id || ops.length === 0) return null;
        this.set({ saving: this.state.saving + 1 });
        try {
          const { plan } = await api.ops(id, ops);
          const session = this.state.session;
          const order = (p) => p.version ?? p.seq;
          if (session && session.sessionId === id && (!session.plan || order(plan) >= order(session.plan))) {
            this.set({ session: { ...session, plan } });
          }
          return plan;
        } catch (err) {
          this.fail(err);
          return null;
        } finally {
          this.set({ saving: Math.max(0, this.state.saving - 1) });
        }
      }
      op(op) {
        return this.ops([op]);
      }
      /** Put the daemon's answer in place, unless something newer has landed. */
      adoptPlan(sessionId, plan) {
        const session = this.state.session;
        const order = (p) => p.version ?? p.seq;
        if (session && session.sessionId === sessionId && (!session.plan || order(plan) >= order(session.plan))) {
          this.set({ session: { ...session, plan } });
        }
      }
      /**
       * Sign the plan off. From here it is locked and the page follows the build
       * on the board. Resolves false when the daemon refused — most often
       * because the plan moved on since the preview was made.
       */
      async submitPlan(input) {
        const id = this.state.sessionId;
        if (!id) return false;
        try {
          const { plan } = await api.submitPlan(id, input);
          this.adoptPlan(id, plan);
          this.set({ tab: "tasks", taskMode: "board" });
          this.toast(
            "success",
            input.target === "session" ? "Plan submitted and locked. Send any message in Claude to hand it the prompt." : "Plan submitted and locked. Paste the prompt where it will be built."
          );
          return true;
        } catch (err) {
          this.fail(err);
          return false;
        }
      }
      /** Unlock a submitted plan for changes. */
      async reopenPlan() {
        const id = this.state.sessionId;
        if (!id) return false;
        try {
          const { plan } = await api.reopenPlan(id);
          this.adoptPlan(id, plan);
          this.toast("info", "The plan is open for changes again. Tell Claude in chat once you have changed it.");
          return true;
        } catch (err) {
          this.fail(err);
          return false;
        }
      }
      /** Jump to an item from anywhere: a board card, the overview's "now". */
      focus(kind, id) {
        const tab = kind === "diagram" ? "diagrams" : kind === "task" ? "tasks" : "overview";
        if (kind === "diagram") this.set({ diagramId: id });
        if (kind === "node") {
          const [diagramId] = id.split(":");
          this.set({ tab: "diagrams", diagramId: diagramId ?? null, focusTarget: `node:${id}` });
          return;
        }
        if (kind === "task" && isLocked(this.state.session?.plan ?? null)) {
          this.set({ tab, taskMode: "board", focusTarget: `${kind}:${id}` });
          return;
        }
        if (kind === "task") {
          const tasks = this.state.session?.plan?.tasks ?? [];
          const ancestors = /* @__PURE__ */ new Set();
          let cursor = tasks.find((t) => t.id === id)?.parentId ?? null;
          while (cursor) {
            ancestors.add(cursor);
            cursor = tasks.find((t) => t.id === cursor)?.parentId ?? null;
          }
          this.set({ collapsedTasks: this.state.collapsedTasks.filter((t) => !ancestors.has(t)), taskMode: "outline" });
        }
        this.set({ tab, focusTarget: `${kind}:${id}` });
      }
      /* ---------------------------------------------------------------- *
       * Local preferences
       * ---------------------------------------------------------------- */
      setTab(tab) {
        this.set({ tab });
      }
      persistPrefs() {
        savePrefs({
          collapsedSidebar: this.state.collapsedSidebar,
          pinned: this.state.pinned,
          collapsedProjects: this.state.collapsedProjects,
          taskMode: this.state.taskMode,
          hideDone: this.state.hideDone,
          collapsedTasks: this.state.collapsedTasks
        });
      }
      setTaskMode(taskMode) {
        this.set({ taskMode });
        this.persistPrefs();
      }
      toggleHideDone() {
        this.set({ hideDone: !this.state.hideDone });
        this.persistPrefs();
      }
      toggleTaskCollapsed(id) {
        const collapsedTasks = this.state.collapsedTasks.includes(id) ? this.state.collapsedTasks.filter((t) => t !== id) : [...this.state.collapsedTasks, id];
        this.set({ collapsedTasks });
        this.persistPrefs();
      }
      toggleSidebar() {
        this.set({ collapsedSidebar: !this.state.collapsedSidebar });
        this.persistPrefs();
      }
      setDrawer(drawerOpen) {
        if (this.state.drawerOpen !== drawerOpen) this.set({ drawerOpen });
      }
      togglePin(sessionId) {
        const pinned = this.state.pinned.includes(sessionId) ? this.state.pinned.filter((id) => id !== sessionId) : [...this.state.pinned, sessionId];
        this.set({ pinned });
        this.persistPrefs();
      }
      toggleProject(key) {
        const collapsedProjects = this.state.collapsedProjects.includes(key) ? this.state.collapsedProjects.filter((k) => k !== key) : [...this.state.collapsedProjects, key];
        this.set({ collapsedProjects });
        this.persistPrefs();
      }
      async renameSession(sessionId, title) {
        const next = title.trim();
        if (!next) return;
        this.set({
          sessions: this.state.sessions.map((s) => s.sessionId === sessionId ? { ...s, title: next } : s),
          ...this.state.session?.sessionId === sessionId ? { session: { ...this.state.session, title: next } } : {}
        });
        try {
          await api.renameSession(sessionId, next);
        } catch (err) {
          this.fail(err);
        }
      }
      async deleteSession(sessionId) {
        try {
          await api.deleteSession(sessionId);
        } catch (err) {
          this.fail(err);
          return;
        }
        const sessions = this.state.sessions.filter((s) => s.sessionId !== sessionId);
        this.set({ sessions, pinned: this.state.pinned.filter((id) => id !== sessionId) });
        this.persistPrefs();
        if (this.state.sessionId === sessionId) {
          this.set({ sessionId: null, session: null });
          window.location.hash = "";
          const next = sessions[0]?.sessionId;
          if (next) await this.selectSession(next);
        }
        this.toast("success", "Session deleted.");
      }
      /* ---------------------------------------------------------------- *
       * Daemon-wide actions
       * ---------------------------------------------------------------- */
      async loadStorage() {
        this.set({ storageBusy: true });
        try {
          const { report } = await api.storage();
          this.set({ storage: report });
        } catch (err) {
          this.fail(err);
        } finally {
          this.set({ storageBusy: false });
        }
      }
      async cleanStorage(groups) {
        if (groups.length === 0) return;
        this.set({ storageBusy: true });
        try {
          const { result, report } = await api.cleanStorage(groups);
          this.set({ storage: report });
          if (result.failed.length) this.toast("error", `${result.failed.length} item(s) could not be removed.`);
          else if (result.removed === 0) this.toast("info", "Nothing left to clean up.");
          else this.toast("success", `Reclaimed ${formatBytes(result.freedBytes)}.`);
        } catch (err) {
          this.fail(err);
        } finally {
          this.set({ storageBusy: false });
        }
      }
      /** Restart the daemon, then reload once a *different* process answers. */
      async restartDaemon(waitMs = 2e4) {
        if (this.state.restarting) return;
        let previousPid = 0;
        try {
          previousPid = (await api.health()).pid;
        } catch {
        }
        try {
          const { restarting } = await api.restartDaemon();
          if (!restarting) {
            this.toast("error", "The daemon is already shutting down.");
            return;
          }
          this.set({ restarting: true, connection: "reconnecting" });
        } catch (err) {
          this.fail(err);
          return;
        }
        const arrived = await waitForDaemon(previousPid, waitMs);
        if (!arrived) {
          this.set({ restarting: false });
          this.toast("error", "The daemon did not come back. Run `harness start` in a terminal.");
          return;
        }
        this.reloadPage();
      }
      /** Overridable because jsdom will not let a test redefine `location.reload`. */
      reloadPage = () => window.location.reload();
      /* ---------------------------------------------------------------- *
       * Notices
       * ---------------------------------------------------------------- */
      toast(kind, text) {
        const toast = { id: `t${Date.now()}${Math.random().toString(36).slice(2, 6)}`, kind, text };
        this.set({ toasts: [...this.state.toasts, toast] });
        window.setTimeout(() => this.dismissToast(toast.id), kind === "error" ? 8e3 : 4e3);
      }
      dismissToast(id) {
        this.set({ toasts: this.state.toasts.filter((t) => t.id !== id) });
      }
      fail(err) {
        this.toast("error", describeError(err));
      }
    };
    store = new Store();
  }
});

// src/ui/lib/format.ts
function relativeTime(ts, now = Date.now()) {
  const delta = Math.max(0, now - ts);
  const seconds = Math.round(delta / 1e3);
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
function duration(ms) {
  const seconds = Math.max(0, Math.round(ms / 1e3));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}
function classNames(...parts) {
  return parts.filter(Boolean).join(" ");
}
var init_format = __esm({
  "src/ui/lib/format.ts"() {
    "use strict";
  }
});

// src/ui/components/GlobalActions.tsx
import { useEffect, useState } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
function GlobalActions() {
  const restarting = useStore((s) => s.restarting);
  const [panel, setPanel] = useState(false);
  const [confirming, setConfirming] = useState(false);
  return /* @__PURE__ */ jsxs("div", { className: "global", children: [
    /* @__PURE__ */ jsxs("div", { className: "global-bar", children: [
      /* @__PURE__ */ jsxs("span", { className: "global-version", children: [
        "v",
        true ? "0.2.0" : "dev"
      ] }),
      restarting && /* @__PURE__ */ jsx("span", { className: "global-note", children: "restarting\u2026" }),
      /* @__PURE__ */ jsx("span", { className: "spacer" }),
      /* @__PURE__ */ jsx(
        "button",
        {
          type: "button",
          className: classNames("icon-btn", "is-tiny", panel && "is-active"),
          "aria-expanded": panel,
          title: "Clean up stale harness files",
          disabled: restarting,
          onClick: () => {
            const next = !panel;
            setPanel(next);
            setConfirming(false);
            if (next) void store.loadStorage();
          },
          children: "\u{1F9F9}"
        }
      ),
      /* @__PURE__ */ jsx(
        "button",
        {
          type: "button",
          className: classNames("icon-btn", "is-tiny", confirming && "is-active"),
          title: "Restart the daemon to pick up a new build",
          disabled: restarting,
          onClick: () => {
            setConfirming(!confirming);
            setPanel(false);
          },
          children: "\u27F3"
        }
      )
    ] }),
    confirming && /* @__PURE__ */ jsxs("div", { className: "global-confirm", children: [
      /* @__PURE__ */ jsx("span", { children: "Restart the daemon? Open pages reconnect by themselves." }),
      /* @__PURE__ */ jsxs("div", { className: "row-actions", children: [
        /* @__PURE__ */ jsx(
          "button",
          {
            type: "button",
            className: "link",
            onClick: () => {
              setConfirming(false);
              void store.restartDaemon();
            },
            children: "Restart"
          }
        ),
        /* @__PURE__ */ jsx("button", { type: "button", className: "link", onClick: () => setConfirming(false), children: "Cancel" })
      ] })
    ] }),
    panel && /* @__PURE__ */ jsx(StoragePanel, {})
  ] });
}
function StoragePanel() {
  const report = useStore((s) => s.storage);
  const busy = useStore((s) => s.storageBusy);
  const [selected, setSelected] = useState(DEFAULT_SELECTION);
  const groups = (report?.groups ?? []).filter((g) => g.count > 0);
  const chosen = groups.filter((g) => selected.includes(g.id));
  const total = chosen.reduce((sum, g) => sum + g.bytes, 0);
  useEffect(() => {
    if (!report) void store.loadStorage();
  }, [report]);
  const toggle = (id) => setSelected(selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id]);
  return /* @__PURE__ */ jsx("div", { className: "global-panel", children: !report ? /* @__PURE__ */ jsx("p", { className: "global-empty", children: busy ? "Scanning\u2026" : "Could not read the storage report." }) : groups.length === 0 ? /* @__PURE__ */ jsx("p", { className: "global-empty", children: "Nothing to clean up." }) : /* @__PURE__ */ jsxs(Fragment, { children: [
    /* @__PURE__ */ jsx("ul", { className: "global-groups", children: groups.map((group) => /* @__PURE__ */ jsx(
      GroupRow,
      {
        group,
        checked: selected.includes(group.id),
        onToggle: () => toggle(group.id)
      },
      group.id
    )) }),
    /* @__PURE__ */ jsxs("div", { className: "global-panel-foot", children: [
      /* @__PURE__ */ jsx(
        "button",
        {
          type: "button",
          className: "btn btn-sm",
          disabled: busy || chosen.length === 0,
          onClick: () => void store.cleanStorage(chosen.map((g) => g.id)),
          children: busy ? "Working\u2026" : `Clean up ${formatBytes(total)}`
        }
      ),
      /* @__PURE__ */ jsx("button", { type: "button", className: "link", disabled: busy, onClick: () => void store.loadStorage(), children: "Rescan" })
    ] })
  ] }) });
}
function GroupRow({
  group,
  checked,
  onToggle
}) {
  return /* @__PURE__ */ jsxs("li", { className: "global-group", children: [
    /* @__PURE__ */ jsxs("label", { className: "global-group-head", children: [
      /* @__PURE__ */ jsx("input", { type: "checkbox", checked, onChange: onToggle }),
      /* @__PURE__ */ jsx("span", { className: "global-group-name", children: group.label }),
      /* @__PURE__ */ jsx("span", { className: "global-group-size", children: formatBytes(group.bytes) })
    ] }),
    /* @__PURE__ */ jsx("p", { className: "global-group-detail", children: group.detail })
  ] });
}
var DEFAULT_SELECTION;
var init_GlobalActions = __esm({
  "src/ui/components/GlobalActions.tsx"() {
    "use strict";
    init_store();
    init_format();
    DEFAULT_SELECTION = ["partial-writes", "log", "lock"];
  }
});

// src/ui/components/Sidebar.tsx
import { useEffect as useEffect2, useRef, useState as useState2 } from "react";
import { jsx as jsx2, jsxs as jsxs2 } from "react/jsx-runtime";
function Sidebar() {
  const sessions = useStore((s) => s.sessions);
  const current = useStore((s) => s.sessionId);
  const connection = useStore((s) => s.connection);
  const collapsed = useStore((s) => s.collapsedSidebar);
  const pinned = useStore((s) => s.pinned);
  const collapsedProjects = useStore((s) => s.collapsedProjects);
  const drawerOpen = useStore((s) => s.drawerOpen);
  const groups = groupSessions(sessions, pinned);
  return /* @__PURE__ */ jsxs2(
    "aside",
    {
      className: classNames("sidebar", collapsed && "is-collapsed", drawerOpen && "is-drawer-open"),
      "aria-label": "Sessions",
      children: [
        /* @__PURE__ */ jsxs2("header", { className: "sidebar-head", children: [
          /* @__PURE__ */ jsx2("span", { className: "logo", "aria-hidden": "true", children: "cc" }),
          /* @__PURE__ */ jsxs2("div", { className: "sidebar-brand", children: [
            /* @__PURE__ */ jsx2("strong", { children: "harness" }),
            /* @__PURE__ */ jsx2("span", { className: classNames("conn", `is-${connection}`), children: connection === "live" ? "live" : connection === "connecting" ? "connecting\u2026" : "reconnecting\u2026" })
          ] }),
          /* @__PURE__ */ jsx2(
            "button",
            {
              type: "button",
              className: "icon-btn",
              title: collapsed ? "Expand sidebar" : "Collapse sidebar",
              "aria-label": collapsed ? "Expand sidebar" : "Collapse sidebar",
              "aria-expanded": !collapsed,
              onClick: () => store.toggleSidebar(),
              children: /* @__PURE__ */ jsx2("span", { "aria-hidden": "true", children: collapsed ? "\u203A" : "\u2039" })
            }
          )
        ] }),
        collapsed && !drawerOpen ? /* @__PURE__ */ jsx2(CollapsedRail, { sessions, current }) : /* @__PURE__ */ jsx2("nav", { className: "session-list", "aria-label": "Live sessions", children: sessions.length === 0 ? /* @__PURE__ */ jsx2("p", { className: "sidebar-empty", children: "No sessions yet." }) : groups.map((group) => /* @__PURE__ */ jsx2(
          ProjectGroup,
          {
            group,
            current,
            open: !collapsedProjects.includes(group.key),
            showRepo: group.key === PINNED_KEY || group.key === WAITING_KEY
          },
          group.key
        )) }),
        /* @__PURE__ */ jsx2("footer", { className: "sidebar-foot", children: /* @__PURE__ */ jsx2(GlobalActions, {}) })
      ]
    }
  );
}
function groupSessions(sessions, pinned) {
  const pinnedSet = new Set(pinned);
  const groups = /* @__PURE__ */ new Map();
  for (const session of sessions) {
    const key = session.waiting ? WAITING_KEY : pinnedSet.has(session.sessionId) ? PINNED_KEY : session.repoRoot ?? session.cwd;
    let group = groups.get(key);
    if (!group) {
      group = key === WAITING_KEY ? { key, label: "Waiting on you", path: "", sessions: [] } : key === PINNED_KEY ? { key, label: "Pinned", path: "", sessions: [] } : {
        key,
        label: groupLabel(session),
        path: session.repoRoot ?? session.cwd,
        sessions: []
      };
      groups.set(key, group);
    }
    group.sessions.push(session);
  }
  for (const group of groups.values()) {
    group.sessions.sort((a, b) => b.createdAt - a.createdAt);
  }
  const rank = (key) => key === WAITING_KEY ? 0 : key === PINNED_KEY ? 1 : 2;
  return [...groups.values()].sort((a, b) => {
    if (rank(a.key) !== rank(b.key)) return rank(a.key) - rank(b.key);
    return (b.sessions[0]?.createdAt ?? 0) - (a.sessions[0]?.createdAt ?? 0);
  });
}
function groupLabel(session) {
  return session.repoName ?? basename(session.cwd) ?? "Unknown project";
}
function basename(p) {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}
function ProjectGroup({
  group,
  current,
  open,
  showRepo
}) {
  const holdsCurrent = group.sessions.some((s) => s.sessionId === current);
  const expanded = open || holdsCurrent;
  return /* @__PURE__ */ jsxs2("section", { className: classNames("session-group", expanded && "is-open"), children: [
    /* @__PURE__ */ jsxs2(
      "button",
      {
        type: "button",
        className: "session-group-head",
        "aria-expanded": expanded,
        title: group.path || void 0,
        onClick: () => store.toggleProject(group.key),
        children: [
          /* @__PURE__ */ jsx2("span", { className: "session-group-chevron", "aria-hidden": "true", children: expanded ? "\u25BE" : "\u25B8" }),
          /* @__PURE__ */ jsx2("span", { className: "session-group-name", children: group.label }),
          /* @__PURE__ */ jsx2("span", { className: "session-group-count", children: group.sessions.length })
        ]
      }
    ),
    expanded && /* @__PURE__ */ jsx2("div", { className: "session-group-body", children: group.sessions.map((s) => /* @__PURE__ */ jsx2(
      SessionRow,
      {
        session: s,
        active: s.sessionId === current,
        showRepo
      },
      s.sessionId
    )) })
  ] });
}
function SessionRow({
  session,
  active,
  showRepo
}) {
  const pinned = useStore((s) => s.pinned.includes(session.sessionId));
  const [confirming, setConfirming] = useState2(false);
  const [renaming, setRenaming] = useState2(false);
  return /* @__PURE__ */ jsxs2(
    "div",
    {
      className: classNames(
        "session-row",
        active && "is-active",
        confirming && "is-confirming"
      ),
      children: [
        renaming ? /* @__PURE__ */ jsx2(RenameField, { session, onDone: () => setRenaming(false) }) : /* @__PURE__ */ jsxs2(
          "button",
          {
            type: "button",
            className: "session-open",
            "aria-current": active ? "true" : void 0,
            onClick: () => {
              void store.selectSession(session.sessionId);
              store.setDrawer(false);
            },
            onDoubleClick: () => setRenaming(true),
            title: `${session.title}
${session.cwd}
Double-click to rename`,
            children: [
              /* @__PURE__ */ jsxs2("span", { className: "session-name", children: [
                session.waiting ? /* @__PURE__ */ jsx2("span", { className: "dot is-attention", title: "Claude is waiting on you", "aria-label": "Claude is waiting on you" }) : session.status === "active" && /* @__PURE__ */ jsx2("span", { className: "working-dot", title: "Claude is working", "aria-label": "Claude is working" }),
                session.planTitle ?? session.title
              ] }),
              session.waiting ? /* @__PURE__ */ jsx2("span", { className: "session-waiting", children: session.waiting.text }) : session.current && /* @__PURE__ */ jsxs2("span", { className: "session-now", children: [
                "now: ",
                session.current
              ] }),
              /* @__PURE__ */ jsxs2("span", { className: "session-sub", children: [
                session.planTitle && session.planTitle !== session.title && /* @__PURE__ */ jsx2("span", { className: "session-stage", children: session.title }),
                !session.planTitle && /* @__PURE__ */ jsx2("span", { className: "session-stage", children: "no plan yet" }),
                /* @__PURE__ */ jsx2("span", { className: classNames("session-state", `is-${session.status}`), children: SESSION_STATE_LABEL[session.status] ?? session.status }),
                session.branch && /* @__PURE__ */ jsx2("span", { className: "session-branch", children: session.branch })
              ] }),
              /* @__PURE__ */ jsxs2("span", { className: "session-foot", children: [
                showRepo && session.repoName && /* @__PURE__ */ jsx2("span", { className: "session-repo", children: groupLabel(session) }),
                session.tasks.total > 0 && /* @__PURE__ */ jsxs2("span", { title: `${session.tasks.done} of ${session.tasks.total} tasks done`, children: [
                  session.tasks.done,
                  "/",
                  session.tasks.total,
                  " tasks"
                ] }),
                /* @__PURE__ */ jsx2("span", { children: relativeTime(session.updatedAt) }),
                session.phase !== "planning" ? /* @__PURE__ */ jsx2("span", { className: classNames("pill", `is-phase-${session.phase}`), title: PHASE_TITLE[session.phase], children: PHASE_PILL[session.phase] }) : session.unreadByClaude > 0 && /* @__PURE__ */ jsx2("span", { className: "pill is-draft", title: "You changed the plan since Claude last read it", children: "unread" })
              ] })
            ]
          }
        ),
        session.waiting && session.link && !renaming && /* @__PURE__ */ jsx2("a", { className: "session-answer btn btn-sm btn-primary", href: session.link.app, title: "Open this session in the Claude desktop app", children: "Answer in Claude" }),
        /* @__PURE__ */ jsxs2("div", { className: "session-actions", children: [
          /* @__PURE__ */ jsx2(
            "button",
            {
              type: "button",
              className: "icon-btn is-tiny",
              title: "Rename this session",
              "aria-label": `Rename ${session.title}`,
              onClick: () => setRenaming(true),
              children: /* @__PURE__ */ jsx2("span", { "aria-hidden": "true", children: "\u270E" })
            }
          ),
          /* @__PURE__ */ jsx2(
            "button",
            {
              type: "button",
              className: classNames("icon-btn", "is-tiny", pinned && "is-active"),
              "aria-pressed": pinned,
              title: pinned ? "Unpin session" : "Pin session",
              "aria-label": pinned ? `Unpin ${session.title}` : `Pin ${session.title}`,
              onClick: () => store.togglePin(session.sessionId),
              children: /* @__PURE__ */ jsx2("span", { "aria-hidden": "true", children: pinned ? "\u2605" : "\u2606" })
            }
          ),
          /* @__PURE__ */ jsx2(
            "button",
            {
              type: "button",
              className: "icon-btn is-tiny is-danger",
              title: "Delete session",
              "aria-label": `Delete ${session.title}`,
              onClick: () => setConfirming(true),
              children: /* @__PURE__ */ jsx2("span", { "aria-hidden": "true", children: "\xD7" })
            }
          )
        ] }),
        confirming && /* @__PURE__ */ jsxs2("div", { className: "session-confirm", children: [
          /* @__PURE__ */ jsx2("span", { children: "Delete permanently?" }),
          /* @__PURE__ */ jsxs2("div", { className: "row-actions", children: [
            /* @__PURE__ */ jsx2(
              "button",
              {
                type: "button",
                className: "link is-danger",
                onClick: () => {
                  setConfirming(false);
                  void store.deleteSession(session.sessionId);
                },
                children: "Delete"
              }
            ),
            /* @__PURE__ */ jsx2("button", { type: "button", className: "link", onClick: () => setConfirming(false), children: "Cancel" })
          ] })
        ] })
      ]
    }
  );
}
function RenameField({ session, onDone }) {
  const [value, setValue] = useState2(session.title);
  const input = useRef(null);
  const done = useRef(false);
  useEffect2(() => {
    input.current?.select();
  }, []);
  const commit = () => {
    if (done.current) return;
    done.current = true;
    const next = value.trim();
    if (next && next !== session.title) void store.renameSession(session.sessionId, next);
    onDone();
  };
  const abandon = () => {
    if (done.current) return;
    done.current = true;
    onDone();
  };
  return /* @__PURE__ */ jsx2(
    "input",
    {
      ref: input,
      className: "session-rename",
      value,
      "aria-label": `Rename ${session.title}`,
      maxLength: 120,
      onChange: (e) => setValue(e.target.value),
      onBlur: commit,
      onKeyDown: (e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") abandon();
      }
    }
  );
}
function CollapsedRail({ sessions, current }) {
  const ordered = [...sessions].sort((a, b) => Number(Boolean(b.waiting)) - Number(Boolean(a.waiting)) || b.createdAt - a.createdAt);
  return /* @__PURE__ */ jsx2("nav", { className: "session-rail", "aria-label": "Sessions", children: ordered.map((s) => {
    const name = s.planTitle ?? s.title;
    return /* @__PURE__ */ jsxs2(
      "button",
      {
        type: "button",
        className: classNames("rail-item", s.sessionId === current && "is-active", s.waiting && "is-waiting"),
        "aria-current": s.sessionId === current ? "true" : void 0,
        title: `${name}${s.waiting ? ` \u2014 waiting on you: ${s.waiting.text}` : s.current ? ` \u2014 now: ${s.current}` : ""}`,
        "aria-label": `${name}${s.waiting ? ", waiting on you" : ""}`,
        onClick: () => void store.selectSession(s.sessionId),
        children: [
          /* @__PURE__ */ jsx2("span", { "aria-hidden": "true", children: initials(name) }),
          s.waiting && /* @__PURE__ */ jsx2("span", { className: "rail-dot is-attention", "aria-hidden": "true" }),
          !s.waiting && s.status === "active" && /* @__PURE__ */ jsx2("span", { className: "rail-dot is-working", "aria-hidden": "true" })
        ]
      },
      s.sessionId
    );
  }) });
}
function initials(name) {
  const all = name.replace(/[^A-Za-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
  const words = all.filter((w) => !MINOR_WORDS.has(w.toLowerCase()));
  if (words.length === 0) words.push(...all);
  return ((words[0]?.[0] ?? "?") + (words[1]?.[0] ?? "")).toUpperCase();
}
var SESSION_STATE_LABEL, PHASE_PILL, PHASE_TITLE, WAITING_KEY, PINNED_KEY, MINOR_WORDS;
var init_Sidebar = __esm({
  "src/ui/components/Sidebar.tsx"() {
    "use strict";
    init_store();
    init_GlobalActions();
    init_format();
    SESSION_STATE_LABEL = {
      active: "working",
      idle: "idle",
      ended: "ended"
    };
    PHASE_PILL = {
      submitted: "submitted",
      building: "building",
      built: "built",
      "handed-off": "handed off"
    };
    PHASE_TITLE = {
      submitted: "Submitted: waiting for Claude to pick it up",
      building: "Submitted and locked: Claude is building it",
      built: "Submitted and built: every task is done",
      "handed-off": "Submitted to be built somewhere else"
    };
    WAITING_KEY = "\0waiting";
    PINNED_KEY = "\0pinned";
    MINOR_WORDS = /* @__PURE__ */ new Set(["a", "an", "the", "to", "of", "for", "and", "in", "on", "with"]);
  }
});

// src/ui/components/Toasts.tsx
import { jsx as jsx3, jsxs as jsxs3 } from "react/jsx-runtime";
function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return /* @__PURE__ */ jsx3("div", { className: "toasts", role: "status", "aria-live": "polite", children: toasts.map((toast) => /* @__PURE__ */ jsxs3("div", { className: classNames("toast", `is-${toast.kind}`), children: [
    /* @__PURE__ */ jsx3("span", { children: toast.text }),
    /* @__PURE__ */ jsx3(
      "button",
      {
        type: "button",
        className: "toast-close",
        "aria-label": "Dismiss",
        onClick: () => store.dismissToast(toast.id),
        children: "\xD7"
      }
    )
  ] }, toast.id)) });
}
var init_Toasts = __esm({
  "src/ui/components/Toasts.tsx"() {
    "use strict";
    init_store();
    init_format();
  }
});

// src/ui/components/ConnectionBar.tsx
import { useEffect as useEffect3, useState as useState3 } from "react";
import { jsx as jsx4, jsxs as jsxs4 } from "react/jsx-runtime";
function ConnectionBar() {
  const connection = useStore((s) => s.connection);
  const [since, setSince] = useState3(null);
  const [now, setNow] = useState3(Date.now());
  useEffect3(() => {
    if (connection === "live") {
      setSince(null);
      return;
    }
    setSince((current) => current ?? Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1e3);
    return () => window.clearInterval(timer);
  }, [connection]);
  if (connection === "live" || !since || now - since < 2e3) return null;
  return /* @__PURE__ */ jsxs4("div", { className: "conn-bar", role: "status", children: [
    /* @__PURE__ */ jsx4("span", { "aria-hidden": "true", children: "\u26A0" }),
    /* @__PURE__ */ jsxs4("span", { children: [
      "Reconnecting \u2014 last update ",
      duration(now - since),
      " ago. What you see may be out of date."
    ] })
  ] });
}
var init_ConnectionBar = __esm({
  "src/ui/components/ConnectionBar.tsx"() {
    "use strict";
    init_store();
    init_format();
  }
});

// src/ui/components/ThemeToggle.tsx
import { useEffect as useEffect4, useState as useState4 } from "react";
import { jsx as jsx5, jsxs as jsxs5 } from "react/jsx-runtime";
function ThemeToggle() {
  const [theme, setTheme] = useState4(readStored);
  useEffect4(() => {
    const media = matchDark();
    const apply = () => {
      const resolved = theme === "system" ? media?.matches ? "dark" : "light" : theme;
      document.documentElement.setAttribute("data-theme", resolved);
    };
    apply();
    try {
      window.localStorage.setItem(KEY, theme);
    } catch {
    }
    if (theme !== "system" || !media) return;
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);
  return /* @__PURE__ */ jsx5("div", { className: "segmented", role: "group", "aria-label": "Colour theme", children: ORDER.map((option) => /* @__PURE__ */ jsxs5(
    "button",
    {
      type: "button",
      className: classNames("seg", theme === option && "is-active"),
      "aria-pressed": theme === option,
      title: LABEL[option],
      onClick: () => setTheme(option),
      children: [
        ICON[option],
        /* @__PURE__ */ jsx5("span", { className: "sr-only", children: LABEL[option] })
      ]
    },
    option
  )) });
}
function readStored() {
  try {
    const saved = window.localStorage.getItem(KEY);
    return saved === "light" || saved === "dark" || saved === "system" ? saved : "system";
  } catch {
    return "system";
  }
}
function matchDark() {
  try {
    return window.matchMedia?.("(prefers-color-scheme: dark)") ?? null;
  } catch {
    return null;
  }
}
var KEY, ORDER, LABEL, ICON;
var init_ThemeToggle = __esm({
  "src/ui/components/ThemeToggle.tsx"() {
    "use strict";
    init_format();
    KEY = "cc-harness:theme";
    ORDER = ["system", "light", "dark"];
    LABEL = { system: "Match the system", light: "Light", dark: "Dark" };
    ICON = {
      system: /* @__PURE__ */ jsxs5("svg", { viewBox: "0 0 16 16", width: "14", height: "14", "aria-hidden": "true", children: [
        /* @__PURE__ */ jsx5("circle", { cx: "8", cy: "8", r: "6", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }),
        /* @__PURE__ */ jsx5("path", { d: "M8 2a6 6 0 0 1 0 12z", fill: "currentColor" })
      ] }),
      light: /* @__PURE__ */ jsxs5("svg", { viewBox: "0 0 16 16", width: "14", height: "14", "aria-hidden": "true", children: [
        /* @__PURE__ */ jsx5("circle", { cx: "8", cy: "8", r: "3", fill: "currentColor" }),
        /* @__PURE__ */ jsx5("g", { stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round", children: /* @__PURE__ */ jsx5("path", { d: "M8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M3 3l1 1M12 12l1 1M3 13l1-1M12 4l1-1" }) })
      ] }),
      dark: /* @__PURE__ */ jsx5("svg", { viewBox: "0 0 16 16", width: "14", height: "14", "aria-hidden": "true", children: /* @__PURE__ */ jsx5("path", { d: "M13.5 10.2A6 6 0 0 1 5.8 2.5a6 6 0 1 0 7.7 7.7z", fill: "currentColor" }) })
    };
  }
});

// src/ui/components/Handoff.tsx
import { useEffect as useEffect5, useState as useState5 } from "react";
import { jsx as jsx6, jsxs as jsxs6 } from "react/jsx-runtime";
function Handoff() {
  const session = useSession();
  const plan = usePlan();
  const [viewing, setViewing] = useState5(false);
  if (!session) return null;
  const areas = unreadAreas(plan);
  const locked = isLocked(plan);
  const unread = locked ? 0 : areas.length;
  return /* @__PURE__ */ jsxs6("div", { className: "handoff", children: [
    plan && !locked && (unread > 0 ? /* @__PURE__ */ jsxs6("span", { className: "handoff-state is-behind", title: `You changed ${areas.join(", ")} since Claude last read the plan`, children: [
      /* @__PURE__ */ jsx6("span", { className: "dot is-attention", "aria-hidden": "true" }),
      "Claude hasn't read your changes"
    ] }) : /* @__PURE__ */ jsxs6("span", { className: "handoff-state is-current", title: plan.claudeReadAt ? `Read ${new Date(plan.claudeReadAt).toLocaleString()}` : void 0, children: [
      "\u2713 Claude is up to date",
      plan.claudeReadAt ? ` \xB7 read ${relativeTime(plan.claudeReadAt)}` : ""
    ] })),
    (!locked || session.link) && /* @__PURE__ */ jsx6(OpenInClaude, { session, primary: unread > 0 }),
    plan && /* @__PURE__ */ jsx6("button", { type: "button", className: "btn btn-sm btn-ghost", onClick: () => setViewing(true), children: "As Claude sees it" }),
    viewing && /* @__PURE__ */ jsx6(ClaudeView, { onClose: () => setViewing(false) })
  ] });
}
function OpenInClaude({
  session,
  primary,
  label = "Open in Claude"
}) {
  if (session.link) return /* @__PURE__ */ jsx6(ClaudeLinks, { link: session.link, primary, label });
  return /* @__PURE__ */ jsx6(
    "button",
    {
      type: "button",
      className: classNames("btn btn-sm", primary && "btn-primary"),
      title: `${whereItRuns(session)} has no link the harness can open. Copies a message to paste there instead.`,
      onClick: () => void copyHandoff(),
      children: "Copy message for Claude"
    }
  );
}
function ClaudeLinks({ link, primary, label }) {
  return /* @__PURE__ */ jsxs6("span", { className: "claude-links", children: [
    /* @__PURE__ */ jsx6("a", { className: classNames("btn btn-sm", primary && "btn-primary"), href: link.app, title: "Open this session in the Claude desktop app", children: label }),
    /* @__PURE__ */ jsx6("a", { className: "link claude-web", href: link.web, target: "_blank", rel: "noreferrer", title: "Open this session on claude.ai", children: "web" })
  ] });
}
function WaitingBanner({ session }) {
  const waiting = session.waiting;
  if (!waiting) return null;
  return /* @__PURE__ */ jsxs6("section", { className: classNames("waiting", `is-${waiting.kind}`), role: "status", "aria-label": "Claude is waiting on you", children: [
    /* @__PURE__ */ jsxs6("div", { className: "waiting-body", children: [
      /* @__PURE__ */ jsxs6("p", { className: "waiting-head", children: [
        /* @__PURE__ */ jsx6("span", { className: "dot is-attention", "aria-hidden": "true" }),
        HEADLINE[waiting.kind],
        /* @__PURE__ */ jsxs6("span", { className: "muted", children: [
          " \xB7 ",
          relativeTime(waiting.since)
        ] })
      ] }),
      waiting.questions?.length ? /* @__PURE__ */ jsx6("ol", { className: "waiting-questions", children: waiting.questions.map((q, i) => /* @__PURE__ */ jsxs6("li", { children: [
        q.header && /* @__PURE__ */ jsx6("span", { className: "qchip", children: q.header }),
        " ",
        /* @__PURE__ */ jsx6("strong", { children: q.question }),
        q.options.length > 0 && /* @__PURE__ */ jsxs6("span", { className: "waiting-options", children: [
          q.multiSelect ? "choose any: " : "choose one: ",
          q.options.join(" \xB7 ")
        ] })
      ] }, i)) }) : /* @__PURE__ */ jsx6("p", { className: "waiting-text", children: waiting.text }),
      !session.link && /* @__PURE__ */ jsx6("p", { className: "waiting-hint", children: noLinkHint(session) })
    ] }),
    /* @__PURE__ */ jsx6(OpenInClaude, { session, primary: true, label: waiting.kind === "permission" ? "Decide in Claude" : "Answer in Claude" })
  ] });
}
function whereItRuns(session) {
  return session.surface === "desktop" ? "This desktop session" : session.surface === "cli" ? "This terminal session" : "This session";
}
function noLinkHint(session) {
  const where = session.surface === "desktop" ? "in the Claude desktop app" : session.surface === "cli" ? "in your terminal" : "where the session is running";
  return `Answer it ${where}. Turn on Remote Control there (/remote-control) and this becomes a link that opens the session directly.`;
}
async function copyHandoff() {
  try {
    await navigator.clipboard.writeText(HANDOFF_MESSAGE);
    store.toast("success", "Copied \u2014 paste it into Claude's chat.");
  } catch {
    store.toast("info", `Tell Claude: "${HANDOFF_MESSAGE}"`);
  }
}
function ClaudeView({ onClose }) {
  const session = useSession();
  const plan = usePlan();
  const [text, setText] = useState5(null);
  useEffect5(() => {
    if (!session) return;
    let live = true;
    api.planText(session.sessionId).then((t) => live && setText(t)).catch((err) => live && setText(`Could not load: ${err.message}`));
    return () => {
      live = false;
    };
  }, [session?.sessionId, plan?.seq]);
  useEffect5(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return /* @__PURE__ */ jsxs6("div", { className: "lightbox", role: "dialog", "aria-modal": "true", "aria-label": "The plan as Claude reads it", children: [
    /* @__PURE__ */ jsx6("button", { type: "button", className: "lightbox-scrim", "aria-label": "Close", onClick: onClose }),
    /* @__PURE__ */ jsxs6("div", { className: "lightbox-body is-text", children: [
      /* @__PURE__ */ jsxs6("header", { className: "item-head", children: [
        /* @__PURE__ */ jsx6("h2", { className: "section-title", children: "What Claude reads" }),
        /* @__PURE__ */ jsx6("span", { className: "muted", children: "the output of harness_plan_read" }),
        /* @__PURE__ */ jsx6("span", { className: "spacer" }),
        /* @__PURE__ */ jsx6("button", { type: "button", className: "icon-btn", "aria-label": "Close", onClick: onClose, children: "\xD7" })
      ] }),
      /* @__PURE__ */ jsx6("pre", { className: "claude-text", children: text ?? "Loading\u2026" })
    ] })
  ] });
}
var HANDOFF_MESSAGE, HEADLINE;
var init_Handoff = __esm({
  "src/ui/components/Handoff.tsx"() {
    "use strict";
    init_store();
    init_api();
    init_format();
    init_plan();
    HANDOFF_MESSAGE = "I've updated the plan in the harness. Read it with harness_plan_read, take my edits and comments into account, and tell me what changes.";
    HEADLINE = {
      question: "Claude is asking you",
      permission: "Claude needs your permission",
      input: "Claude is waiting for your reply"
    };
  }
});

// src/ui/components/Progress.tsx
import { jsx as jsx7, jsxs as jsxs7 } from "react/jsx-runtime";
function ProgressBar({ counts, compact }) {
  const total = Math.max(1, counts.total);
  const pct = (n) => `${n / total * 100}%`;
  return /* @__PURE__ */ jsxs7(
    "span",
    {
      className: classNames("progress", compact && "is-compact"),
      role: "img",
      "aria-label": `${counts.done} of ${counts.total} tasks done${counts.inProgress ? `, ${counts.inProgress} in progress` : ""}${counts.blocked ? `, ${counts.blocked} blocked` : ""}`,
      children: [
        /* @__PURE__ */ jsx7("span", { className: "progress-seg is-done", style: { width: pct(counts.done) } }),
        /* @__PURE__ */ jsx7("span", { className: "progress-seg is-in_progress", style: { width: pct(counts.inProgress) } }),
        /* @__PURE__ */ jsx7("span", { className: "progress-seg is-blocked", style: { width: pct(counts.blocked) } })
      ]
    }
  );
}
var STATUS_LABEL, STATUS_GLYPH;
var init_Progress = __esm({
  "src/ui/components/Progress.tsx"() {
    "use strict";
    init_format();
    STATUS_LABEL = {
      todo: "To do",
      in_progress: "In progress",
      blocked: "Blocked",
      done: "Done"
    };
    STATUS_GLYPH = {
      todo: "",
      in_progress: "",
      blocked: "!",
      done: "\u2713"
    };
  }
});

// src/ui/components/Submit.tsx
import { useEffect as useEffect6, useRef as useRef2, useState as useState6 } from "react";
import { Fragment as Fragment2, jsx as jsx8, jsxs as jsxs8 } from "react/jsx-runtime";
function SubmitControl() {
  const plan = usePlan();
  const [open, setOpen] = useState6(false);
  const [viewing, setViewing] = useState6(false);
  const trigger = useRef2(null);
  if (!plan) return null;
  const phase = planPhase(plan);
  if (phase !== "planning") {
    return /* @__PURE__ */ jsxs8("span", { className: "lock-control", children: [
      /* @__PURE__ */ jsxs8("span", { className: classNames("lock-chip", `is-${phase}`), title: "Submitted plans cannot be edited; reopen it to change it", children: [
        /* @__PURE__ */ jsx8("span", { "aria-hidden": "true", children: "\u{1F512}" }),
        " ",
        PHASE_CHIP[phase]
      ] }),
      /* @__PURE__ */ jsx8("button", { type: "button", className: "btn btn-sm", onClick: () => setViewing(true), children: "View prompt" }),
      viewing && /* @__PURE__ */ jsx8(SubmittedPrompt, { plan, onClose: () => setViewing(false) })
    ] });
  }
  return /* @__PURE__ */ jsxs8(Fragment2, { children: [
    /* @__PURE__ */ jsx8(
      "button",
      {
        ref: trigger,
        type: "button",
        className: "btn btn-sm btn-primary",
        title: "Read the prompt Claude will be given, then lock the plan and hand it over to be built",
        onClick: () => setOpen(true),
        children: "Review & submit plan"
      }
    ),
    open && /* @__PURE__ */ jsx8(
      SubmitDialog,
      {
        onClose: () => {
          setOpen(false);
          trigger.current?.focus();
        }
      }
    )
  ] });
}
function SubmitDialog({ onClose }) {
  const session = useSession();
  const plan = usePlan();
  const sessionId = useStore((s) => s.sessionId);
  const [target, setTarget] = useState6("session");
  const [note, setNote] = useState6("");
  const [settled, setSettled] = useState6("");
  const [shown, setShown] = useState6(null);
  const [error, setError] = useState6(null);
  const [submitting, setSubmitting] = useState6(false);
  const body = useRef2(null);
  const version = plan?.version ?? 0;
  useEffect6(() => {
    body.current?.focus();
  }, []);
  useEffect6(() => {
    const timer = window.setTimeout(() => setSettled(note), NOTE_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [note]);
  useEffect6(() => {
    if (!sessionId) return;
    let live = true;
    api.promptPreview(sessionId, target, settled).then((preview2) => {
      if (!live) return;
      setShown({ preview: preview2, target, note: settled });
      setError(null);
    }).catch((err) => live && setError(err.message));
    return () => {
      live = false;
    };
  }, [sessionId, target, settled, version]);
  useEffect6(() => {
    const onKey = (e) => {
      if (e.key === "Escape" && !submitting) {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, submitting]);
  if (!session || !plan) return null;
  const current = Boolean(shown && shown.target === target && shown.note === note && shown.preview.version >= version);
  const preview = shown?.preview ?? null;
  const submit = async () => {
    if (!preview || !current) return;
    setSubmitting(true);
    if (target === "elsewhere") await copyText(preview.prompt, "Copied the prompt.");
    const ok = await store.submitPlan({ target, note, expect: preview.version });
    setSubmitting(false);
    if (ok) onClose();
  };
  return /* @__PURE__ */ jsxs8("div", { className: "lightbox", role: "dialog", "aria-modal": "true", "aria-labelledby": "submit-title", children: [
    /* @__PURE__ */ jsx8("button", { type: "button", className: "lightbox-scrim", "aria-label": "Close", onClick: onClose, disabled: submitting }),
    /* @__PURE__ */ jsxs8("div", { className: "lightbox-body submit", ref: body, tabIndex: -1, children: [
      /* @__PURE__ */ jsxs8("header", { className: "item-head", children: [
        /* @__PURE__ */ jsx8("h2", { className: "section-title", id: "submit-title", children: "Submit the plan" }),
        /* @__PURE__ */ jsx8("span", { className: "muted", children: plan.title }),
        /* @__PURE__ */ jsx8("span", { className: "spacer" }),
        /* @__PURE__ */ jsx8("button", { type: "button", className: "icon-btn", "aria-label": "Close", onClick: onClose, disabled: submitting, children: "\xD7" })
      ] }),
      /* @__PURE__ */ jsxs8("div", { className: "submit-grid", children: [
        /* @__PURE__ */ jsxs8("div", { className: "submit-side", children: [
          /* @__PURE__ */ jsx8(Checklist, { session, plan, target, trimmed: Boolean(preview?.trimmed && shown?.target === "session") }),
          /* @__PURE__ */ jsxs8("fieldset", { className: "submit-targets", children: [
            /* @__PURE__ */ jsx8("legend", { className: "field-label", children: "Who builds it?" }),
            TARGETS.map((t) => /* @__PURE__ */ jsxs8("label", { className: classNames("submit-target", target === t.id && "is-active"), children: [
              /* @__PURE__ */ jsx8("input", { type: "radio", name: "build-target", value: t.id, checked: target === t.id, onChange: () => setTarget(t.id) }),
              /* @__PURE__ */ jsxs8("span", { children: [
                /* @__PURE__ */ jsx8("strong", { children: t.label }),
                /* @__PURE__ */ jsx8("span", { className: "submit-target-hint", children: t.hint })
              ] })
            ] }, t.id))
          ] }),
          /* @__PURE__ */ jsxs8("label", { className: "field", children: [
            /* @__PURE__ */ jsx8("span", { className: "field-label", children: "Anything else for Claude?" }),
            /* @__PURE__ */ jsx8(
              "textarea",
              {
                className: "input",
                rows: 3,
                maxLength: preview?.maxNote ?? MAX_NOTE,
                value: note,
                placeholder: "Optional \u2014 where to start, what to leave alone, how to test it.",
                onChange: (e) => setNote(e.target.value)
              }
            )
          ] }),
          /* @__PURE__ */ jsxs8("p", { className: "explain", children: [
            "Submitting ",
            /* @__PURE__ */ jsx8("strong", { children: "locks the plan" }),
            ": the diagrams, tasks and sections can no longer be edited, and the page follows the build on the task board. You can reopen it if something has to change."
          ] }),
          /* @__PURE__ */ jsxs8("div", { className: "submit-actions", children: [
            /* @__PURE__ */ jsx8("button", { type: "button", className: "btn btn-ghost", onClick: onClose, disabled: submitting, children: "Cancel" }),
            /* @__PURE__ */ jsx8("button", { type: "button", className: "btn btn-primary", disabled: !current || submitting, onClick: () => void submit(), children: submitting ? "Submitting\u2026" : target === "session" ? "Submit and lock" : "Copy, submit and lock" })
          ] })
        ] }),
        /* @__PURE__ */ jsxs8("section", { className: "submit-preview", "aria-label": "The prompt", children: [
          /* @__PURE__ */ jsxs8("header", { className: "submit-preview-head", children: [
            /* @__PURE__ */ jsx8("span", { className: "field-label", children: target === "session" ? "The prompt Claude will get" : "The prompt to paste" }),
            preview && /* @__PURE__ */ jsxs8("span", { className: "muted submit-count", children: [
              preview.prompt.length.toLocaleString(),
              " characters",
              !current && " \xB7 updating\u2026"
            ] }),
            /* @__PURE__ */ jsx8("span", { className: "spacer" }),
            /* @__PURE__ */ jsx8(
              "button",
              {
                type: "button",
                className: "btn btn-sm",
                disabled: !preview,
                onClick: () => preview && void copyText(preview.prompt, "Copied the prompt."),
                children: "Copy"
              }
            )
          ] }),
          error ? /* @__PURE__ */ jsxs8("p", { className: "error-text", role: "alert", children: [
            "Could not build the prompt: ",
            error
          ] }) : /* @__PURE__ */ jsx8("pre", { className: classNames("claude-text", "submit-prompt", !current && "is-stale"), "data-testid": "prompt-preview", children: preview?.prompt ?? "Building the prompt\u2026" })
        ] })
      ] })
    ] })
  ] });
}
function Checklist({ session, plan, target, trimmed }) {
  const counts = countTasks(plan);
  const boxes = plan.diagrams.reduce((n, d) => n + d.nodes.length, 0);
  const open = plan.threads.filter((t) => !t.resolved).length;
  const unread = unreadAreas(plan);
  const notes = [];
  if (counts.total === 0) notes.push({ tone: "warn", text: "There are no tasks, so there will be nothing to follow on the board." });
  if (target === "session" && session.status === "ended") {
    notes.push({ tone: "warn", text: "This session has ended. Resume it in Claude to build here, or choose somewhere else." });
  }
  if (target === "session" && session.waiting) {
    notes.push({ tone: "warn", text: "Claude is waiting on you in chat. Answer it there; the prompt goes with the next message you type." });
  }
  if (target === "session" && unread.length) {
    notes.push({ tone: "info", text: `Claude has not read your latest changes (${unread.join(", ")}). The prompt lists them first.` });
  }
  if (open) notes.push({ tone: "info", text: `${open} open comment${open === 1 ? "" : "s"} go${open === 1 ? "es" : ""} with the plan.` });
  if (trimmed) {
    notes.push({
      tone: "info",
      text: "The plan is longer than fits in one message, so the prompt carries the task list and Claude reads the rest with harness_plan_read."
    });
  }
  return /* @__PURE__ */ jsxs8("div", { className: "submit-check", children: [
    /* @__PURE__ */ jsxs8("p", { className: "submit-summary", children: [
      plan.diagrams.length,
      " diagram",
      plan.diagrams.length === 1 ? "" : "s",
      " \xB7 ",
      boxes,
      " box",
      boxes === 1 ? "" : "es",
      " \xB7 ",
      counts.total,
      " task",
      counts.total === 1 ? "" : "s",
      counts.done ? ` (${counts.done} already done)` : ""
    ] }),
    notes.length > 0 && /* @__PURE__ */ jsx8("ul", { className: "submit-notes", children: notes.map((n, i) => /* @__PURE__ */ jsx8("li", { className: `is-${n.tone}`, children: n.text }, i)) })
  ] });
}
function SubmittedPrompt({ plan, onClose }) {
  const submission = plan.submission;
  useEffect6(() => {
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  if (!submission) return null;
  const delivered = submission.deliveredAt ? `Claude got it ${relativeTime(submission.deliveredAt)}` : submission.target === "session" ? "Not delivered yet: it goes with your next message in Claude" : "Handed off to build elsewhere";
  return /* @__PURE__ */ jsxs8("div", { className: "lightbox", role: "dialog", "aria-modal": "true", "aria-labelledby": "submitted-title", children: [
    /* @__PURE__ */ jsx8("button", { type: "button", className: "lightbox-scrim", "aria-label": "Close", onClick: onClose }),
    /* @__PURE__ */ jsxs8("div", { className: "lightbox-body is-text", children: [
      /* @__PURE__ */ jsxs8("header", { className: "item-head", children: [
        /* @__PURE__ */ jsx8("h2", { className: "section-title", id: "submitted-title", children: "The submitted prompt" }),
        /* @__PURE__ */ jsxs8("span", { className: "muted", children: [
          "submitted ",
          relativeTime(submission.at),
          " \xB7 ",
          delivered
        ] }),
        /* @__PURE__ */ jsx8("span", { className: "spacer" }),
        /* @__PURE__ */ jsx8("button", { type: "button", className: "btn btn-sm", onClick: () => void copyText(submission.prompt, "Copied the prompt."), children: "Copy" }),
        /* @__PURE__ */ jsx8("button", { type: "button", className: "icon-btn", "aria-label": "Close", onClick: onClose, children: "\xD7" })
      ] }),
      /* @__PURE__ */ jsx8("pre", { className: "claude-text", children: submission.prompt })
    ] })
  ] });
}
function PhaseStrip({ session }) {
  const tab = useStore((s) => s.tab);
  const [confirming, setConfirming] = useState6(false);
  const plan = session.plan;
  const phase = planPhase(plan);
  if (!plan?.submission || phase === "planning") return null;
  const submission = plan.submission;
  const counts = countTasks(plan);
  const now = currentTask(plan);
  const blocked = plan.tasks.filter((t) => t.status === "blocked" && !plan.tasks.some((c) => c.parentId === t.id));
  let head;
  let text;
  switch (phase) {
    case "submitted":
      head = "Submitted \u2014 waiting for Claude to start";
      text = session.status === "ended" ? "This session has ended. Resume it in Claude, then send any message: the prompt goes with it." : /* @__PURE__ */ jsxs8(Fragment2, { children: [
        "Send any message in Claude's chat \u2014 ",
        /* @__PURE__ */ jsx8("q", { children: "go" }),
        " will do \u2014 and the harness hands it the build prompt with it."
      ] });
      break;
    case "building":
      head = "Building";
      text = now ? /* @__PURE__ */ jsxs8(Fragment2, { children: [
        "Claude is on ",
        /* @__PURE__ */ jsx8("strong", { children: now.title }),
        now.note ? ` \u2014 ${now.note}` : ""
      ] }) : blocked.length ? `${blocked.length} task${blocked.length === 1 ? " is" : "s are"} blocked: ${blocked[0].title}${blocked[0].note ? ` \u2014 ${blocked[0].note}` : ""}` : "Claude has the plan. No task is in progress right now.";
      break;
    case "built":
      head = "Built";
      text = `Every task is done (${counts.total}).`;
      break;
    default:
      head = "Handed off";
      text = "The prompt was copied to build somewhere else, so progress is not followed here.";
  }
  return (
    // A region, not a live one: the board announces each move as it happens.
    /* @__PURE__ */ jsxs8("section", { className: classNames("phase", `is-${phase}`), "aria-label": "The build", children: [
      /* @__PURE__ */ jsxs8("div", { className: "phase-body", children: [
        /* @__PURE__ */ jsxs8("p", { className: "phase-head", children: [
          /* @__PURE__ */ jsx8("span", { "aria-hidden": "true", children: "\u{1F512}" }),
          " ",
          head,
          /* @__PURE__ */ jsxs8("span", { className: "muted", children: [
            " \xB7 submitted ",
            relativeTime(submission.at)
          ] })
        ] }),
        /* @__PURE__ */ jsx8("p", { className: "phase-text", children: text })
      ] }),
      counts.total > 0 && phase !== "handed-off" && /* @__PURE__ */ jsxs8("span", { className: "phase-progress", children: [
        /* @__PURE__ */ jsx8(ProgressBar, { counts, compact: true }),
        /* @__PURE__ */ jsxs8("span", { className: "muted", children: [
          counts.done,
          "/",
          counts.total
        ] })
      ] }),
      /* @__PURE__ */ jsx8("div", { className: "phase-actions", children: confirming ? /* @__PURE__ */ jsxs8("span", { className: "item-confirm", children: [
        submission.deliveredAt ? "Unlock the plan? Claude keeps building until you tell it otherwise in chat." : "Withdraw the submission?",
        /* @__PURE__ */ jsx8(
          "button",
          {
            type: "button",
            className: "link is-danger",
            onClick: () => {
              setConfirming(false);
              void store.reopenPlan();
            },
            children: submission.deliveredAt ? "Reopen" : "Withdraw"
          }
        ),
        /* @__PURE__ */ jsx8("button", { type: "button", className: "link", onClick: () => setConfirming(false), children: "Keep it" })
      ] }) : /* @__PURE__ */ jsxs8(Fragment2, { children: [
        phase === "submitted" && session.link && /* @__PURE__ */ jsx8(OpenInClaude, { session, primary: true }),
        (phase === "submitted" || phase === "handed-off") && /* @__PURE__ */ jsx8(
          "button",
          {
            type: "button",
            className: classNames("btn btn-sm", phase === "submitted" && !session.link && "btn-primary"),
            title: phase === "submitted" ? "Pasting it into Claude works too; it is not sent twice" : void 0,
            onClick: () => void copyText(submission.prompt, phase === "submitted" ? "Copied \u2014 paste it into Claude's chat." : "Copied the prompt."),
            children: "Copy prompt"
          }
        ),
        (phase === "building" || phase === "built") && tab !== "tasks" && /* @__PURE__ */ jsx8("button", { type: "button", className: "btn btn-sm", onClick: () => store.set({ tab: "tasks", taskMode: "board" }), children: "Follow on the board" }),
        /* @__PURE__ */ jsx8("button", { type: "button", className: "link", onClick: () => setConfirming(true), children: submission.deliveredAt ? "Reopen for changes" : "Withdraw" })
      ] }) })
    ] })
  );
}
async function copyText(text, ok) {
  try {
    await navigator.clipboard.writeText(text);
    store.toast("success", ok);
  } catch {
    store.toast("error", "The browser would not let the page use the clipboard. Select the prompt and copy it instead.");
  }
}
var TARGETS, NOTE_SETTLE_MS, PHASE_CHIP;
var init_Submit = __esm({
  "src/ui/components/Submit.tsx"() {
    "use strict";
    init_store();
    init_api();
    init_Handoff();
    init_Progress();
    init_format();
    init_plan();
    TARGETS = [
      {
        id: "session",
        label: "This Claude session",
        hint: "Your next message in its chat carries this prompt, and the board follows each task as Claude works through it."
      },
      {
        id: "elsewhere",
        label: "Somewhere else",
        hint: "Copy the prompt into the agent that will build it. The plan is locked all the same, but its progress cannot be followed here."
      }
    ];
    NOTE_SETTLE_MS = 300;
    PHASE_CHIP = {
      submitted: "Submitted",
      building: "Locked \xB7 building",
      built: "Built",
      "handed-off": "Locked \xB7 handed off"
    };
  }
});

// src/ui/lib/markdown.ts
function escapeHtml(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function matchXmlBlock(lines, i) {
  const open = /^\s*<([A-Za-z][\w:.-]*)\s*>(.*)$/.exec(lines[i] ?? "");
  if (!open) return null;
  const raw = open[1];
  const tag = raw.toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(XML_BLOCKS, tag)) return null;
  const close = `</${raw}>`;
  const rest = open[2] ?? "";
  const inline2 = rest.indexOf(close);
  if (inline2 >= 0) return { tag, body: rest.slice(0, inline2), endLine: i };
  const body = rest ? [rest] : [];
  for (let j = i + 1; j < lines.length; j++) {
    const line = lines[j];
    const at = line.indexOf(close);
    if (at >= 0) {
      if (line.slice(0, at)) body.push(line.slice(0, at));
      return { tag, body: body.join("\n"), endLine: j };
    }
    body.push(line);
  }
  return null;
}
function renderCommandGroup(fields) {
  const name = fields.get("command-name")?.trim();
  const args = fields.get("command-args")?.trim();
  const message = fields.get("command-message")?.trim();
  const head = [];
  if (name) head.push(`<span class="md-command-name">${escapeHtml(name)}</span>`);
  if (args) head.push(`<span class="md-command-args">${escapeHtml(args)}</span>`);
  const extra = message && message !== name && `/${message}` !== name ? message : "";
  return `<div class="md-command">` + (head.length ? `<div class="md-command-head">${head.join("")}</div>` : "") + (extra ? `<div class="md-command-message">${escapeHtml(extra)}</div>` : "") + `</div>`;
}
function renderDetailsBlock(spec, tag, body) {
  const text = body.replace(/^\n+|\n+$/g, "");
  return `<details class="md-xml is-${escapeHtml(tag)}"><summary>${escapeHtml(spec.label)}</summary><pre class="md-xml-body">${escapeHtml(text)}</pre></details>`;
}
function renderMarkdown(source) {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let inCode = false;
  let codeLang = "";
  let codeBuffer = [];
  let paragraph = [];
  const lists = [];
  let command = null;
  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    out.push(`<p>${inline(paragraph.join(" "))}</p>`);
    paragraph = [];
  };
  const closeDeepestList = () => {
    const list = lists.pop();
    if (!list) return;
    out.push("</li>");
    out.push(`</${list.type}>`);
  };
  const closeLists = () => {
    while (lists.length) closeDeepestList();
  };
  const flushCommand = () => {
    if (!command) return;
    out.push(renderCommandGroup(command));
    command = null;
  };
  const flushBlocks = () => {
    flushParagraph();
    closeLists();
    flushCommand();
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      if (inCode) {
        out.push(
          `<pre class="md-code"${codeLang ? ` data-lang="${escapeHtml(codeLang)}"` : ""}><code>${escapeHtml(codeBuffer.join("\n"))}</code></pre>`
        );
        codeBuffer = [];
        inCode = false;
        codeLang = "";
      } else {
        flushBlocks();
        inCode = true;
        codeLang = fence[1] ?? "";
      }
      continue;
    }
    if (inCode) {
      codeBuffer.push(line);
      continue;
    }
    const xml = matchXmlBlock(lines, i);
    if (xml) {
      const spec = XML_BLOCKS[xml.tag];
      if (spec.mode === "command") {
        flushParagraph();
        closeLists();
        command ??= /* @__PURE__ */ new Map();
        command.set(xml.tag, xml.body);
      } else {
        flushBlocks();
        out.push(renderDetailsBlock(spec, xml.tag, xml.body));
      }
      i = xml.endLine;
      continue;
    }
    if (!line.trim()) {
      flushBlocks();
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      flushBlocks();
      const level = heading[1].length + 1;
      out.push(`<h${level}>${inline(heading[2] ?? "")}</h${level}>`);
      continue;
    }
    const table = matchTable(lines, i);
    if (table) {
      flushBlocks();
      out.push(table.html);
      i = table.endLine;
      continue;
    }
    if (/^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushBlocks();
      out.push("<hr />");
      continue;
    }
    const item = matchListItem(line);
    if (item) {
      flushParagraph();
      flushCommand();
      pushListItem(out, lists, item);
      continue;
    }
    if (/^\s*>/.test(line)) {
      flushBlocks();
      out.push(`<blockquote>${inline(line.replace(/^\s*>\s?/, ""))}</blockquote>`);
      continue;
    }
    paragraph.push(line.trim());
  }
  if (inCode && codeBuffer.length) {
    out.push(`<pre class="md-code"><code>${escapeHtml(codeBuffer.join("\n"))}</code></pre>`);
  }
  flushBlocks();
  return out.join("\n");
}
function matchListItem(line) {
  const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
  const ordered = bullet ? null : /^(\s*)\d+[.)]\s+(.*)$/.exec(line);
  const match = bullet ?? ordered;
  if (!match) return null;
  const indent2 = (match[1] ?? "").replace(/\t/g, "  ").length;
  let content = match[2] ?? "";
  const item = { type: bullet ? "ul" : "ol", indent: indent2, content };
  const task = /^\[([ xX])\]\s+(.*)$/.exec(content);
  if (task && bullet) {
    item.task = true;
    item.checked = task[1] !== " ";
    content = task[2] ?? "";
    item.content = content;
  }
  return item;
}
function pushListItem(out, lists, item) {
  const closeDeepest = () => {
    const list = lists.pop();
    if (!list) return;
    out.push("</li>");
    out.push(`</${list.type}>`);
  };
  while (lists.length > 1 && item.indent < lists[lists.length - 1].indent) closeDeepest();
  const top = lists[lists.length - 1];
  if (!top || item.indent > top.indent) {
    out.push(`<${item.type}>`);
    lists.push({ type: item.type, indent: item.indent });
  } else if (top.type !== item.type) {
    closeDeepest();
    out.push(`<${item.type}>`);
    lists.push({ type: item.type, indent: item.indent });
  } else {
    out.push("</li>");
  }
  const box = item.task ? `<input type="checkbox" disabled${item.checked ? " checked" : ""} /> ` : "";
  const cls = item.task ? ` class="md-task${item.checked ? " is-done" : ""}"` : "";
  out.push(`<li${cls}>${box}${inline(item.content)}`);
}
function matchTable(lines, i) {
  const header = lines[i] ?? "";
  const divider = lines[i + 1] ?? "";
  if (!/\|/.test(header)) return null;
  if (!/^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(divider)) return null;
  const cells = (line) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
  const heads = cells(header);
  const aligns = cells(divider).map(
    (c) => c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : ""
  );
  const align = (n) => aligns[n] ? ` style="text-align:${aligns[n]}"` : "";
  const body = [];
  let end = i + 1;
  for (let j = i + 2; j < lines.length; j++) {
    const row = lines[j] ?? "";
    if (!row.trim() || !row.includes("|")) break;
    const tds = cells(row).map((c, n) => `<td${align(n)}>${inline(c)}</td>`).join("");
    body.push(`<tr>${tds}</tr>`);
    end = j;
  }
  const ths = heads.map((c, n) => `<th${align(n)}>${inline(c)}</th>`).join("");
  const html = `<div class="md-table-wrap"><table class="md-table"><thead><tr>${ths}</tr></thead>` + (body.length ? `<tbody>${body.join("")}</tbody>` : "") + `</table></div>`;
  return { html, endLine: end };
}
function inline(text) {
  let html = escapeHtml(text);
  const spans = [];
  html = html.replace(/`([^`]+)`/g, (_all, body) => {
    spans.push(`<code>${body}</code>`);
    return `${CODE_MARK}${spans.length - 1}${CODE_MARK}`;
  });
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
  html = html.replace(/(^|[\s(])_([^_\s][^_]*)_(?=$|[\s).,;:!?])/g, "$1<em>$2</em>");
  html = html.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  html = html.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  html = html.replace(/(^|\s)(https?:\/\/[^\s<]+)/g, '$1<a href="$2" target="_blank" rel="noreferrer">$2</a>');
  return html.replace(new RegExp(`${CODE_MARK}(\\d+)${CODE_MARK}`, "g"), (_all, n) => spans[Number(n)] ?? "");
}
var XML_BLOCKS, CODE_MARK;
var init_markdown = __esm({
  "src/ui/lib/markdown.ts"() {
    "use strict";
    XML_BLOCKS = {
      "command-name": { mode: "command", label: "name" },
      "command-args": { mode: "command", label: "args" },
      "command-message": { mode: "command", label: "message" },
      "system-reminder": { mode: "details", label: "system reminder" },
      "local-command-stdout": { mode: "details", label: "command output" },
      "local-command-stderr": { mode: "details", label: "command error output" },
      "user-prompt-submit-hook": { mode: "details", label: "hook output" },
      "ide_selection": { mode: "details", label: "editor selection" },
      "ide-selection": { mode: "details", label: "editor selection" },
      "function_results": { mode: "details", label: "tool result" },
      "task-notification": { mode: "details", label: "task notification" }
    };
    CODE_MARK = "\0";
  }
});

// src/ui/components/Markdown.tsx
import { useMemo } from "react";
import { jsx as jsx9 } from "react/jsx-runtime";
function Markdown({ source, className }) {
  const html = useMemo(() => renderMarkdown(source), [source]);
  return /* @__PURE__ */ jsx9("div", { className: className ? `md ${className}` : "md", dangerouslySetInnerHTML: { __html: html } });
}
var init_Markdown = __esm({
  "src/ui/components/Markdown.tsx"() {
    "use strict";
    init_markdown();
  }
});

// src/ui/components/Editable.tsx
import { useEffect as useEffect7, useRef as useRef3, useState as useState7 } from "react";
import { jsx as jsx10, jsxs as jsxs9 } from "react/jsx-runtime";
function InlineText({
  value,
  onSave,
  label,
  placeholder = "Untitled",
  className,
  as: Tag = "span",
  readOnly = false
}) {
  const [editing, setEditing] = useState7(false);
  const [draft, setDraft] = useState7(value);
  const done = useRef3(false);
  const input = useRef3(null);
  useEffect7(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);
  useEffect7(() => {
    if (editing) input.current?.select();
  }, [editing]);
  const start = () => {
    done.current = false;
    setDraft(value);
    setEditing(true);
  };
  const commit = () => {
    if (done.current) return;
    done.current = true;
    setEditing(false);
    const next = draft.trim();
    if (next && next !== value) void onSave(next);
  };
  const abandon = () => {
    done.current = true;
    setEditing(false);
    setDraft(value);
  };
  if (readOnly) return /* @__PURE__ */ jsx10(Tag, { className: classNames("inline-text", "is-readonly", !value && "is-empty", className), children: value || placeholder });
  if (editing) {
    return /* @__PURE__ */ jsx10(
      "input",
      {
        ref: input,
        className: classNames("inline-input", className),
        value: draft,
        "aria-label": label,
        onChange: (e) => setDraft(e.target.value),
        onBlur: commit,
        onKeyDown: (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          }
          if (e.key === "Escape") {
            e.stopPropagation();
            abandon();
          }
        }
      }
    );
  }
  return /* @__PURE__ */ jsx10(Tag, { className: classNames("inline-text", !value && "is-empty", className), children: /* @__PURE__ */ jsx10("button", { type: "button", className: "inline-trigger", onClick: start, title: "Click to edit", "aria-label": `${label}: ${value || placeholder}. Edit`, children: value || placeholder }) });
}
function MarkdownField({
  value,
  onSave,
  label,
  placeholder = "Nothing written yet.",
  emptyAction = "Add detail",
  rows = 6,
  className,
  startEditing = false,
  onCancel,
  version
}) {
  const [editing, setEditing] = useState7(startEditing);
  const [draft, setDraft] = useState7(value);
  const [saving, setSaving] = useState7(false);
  const startedAt = useRef3(version);
  const area = useRef3(null);
  useEffect7(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);
  useEffect7(() => {
    if (editing) area.current?.focus();
  }, [editing]);
  const begin = () => {
    startedAt.current = version;
    setEditing(true);
  };
  const changedUnderneath = editing && version !== void 0 && startedAt.current !== void 0 && version !== startedAt.current;
  const save = async () => {
    if (draft === value) {
      setEditing(false);
      return;
    }
    setSaving(true);
    const base = changedUnderneath ? version : startedAt.current;
    const result = await onSave(draft, base);
    setSaving(false);
    if (result === false) {
      startedAt.current = version;
      return;
    }
    setEditing(false);
  };
  const cancel = () => {
    setEditing(false);
    setDraft(value);
    onCancel?.();
  };
  const onKeyDown = (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void save();
    }
    if (e.key === "Escape") {
      e.stopPropagation();
      cancel();
    }
  };
  if (editing) {
    return /* @__PURE__ */ jsxs9("div", { className: classNames("md-field is-editing", className), children: [
      /* @__PURE__ */ jsx10(
        "textarea",
        {
          ref: area,
          className: "input md-input",
          value: draft,
          rows: Math.max(rows, Math.min(24, draft.split("\n").length + 1)),
          "aria-label": label,
          placeholder: "Markdown: **bold**, `code`, - lists, ## headings",
          onChange: (e) => setDraft(e.target.value),
          onKeyDown
        }
      ),
      changedUnderneath && /* @__PURE__ */ jsx10("p", { className: "md-conflict", role: "alert", children: "This changed while you were editing. Saving now replaces the newer version with your text \u2014 copy anything you want to keep from it first." }),
      /* @__PURE__ */ jsxs9("div", { className: "md-field-foot", children: [
        /* @__PURE__ */ jsx10("span", { className: "muted", children: "Markdown \xB7 \u2318/Ctrl+Enter to save \xB7 Esc to cancel" }),
        /* @__PURE__ */ jsx10("span", { className: "spacer" }),
        /* @__PURE__ */ jsx10("button", { type: "button", className: "btn btn-sm btn-ghost", onClick: cancel, children: "Cancel" }),
        /* @__PURE__ */ jsx10("button", { type: "button", className: "btn btn-sm btn-primary", disabled: saving, onClick: () => void save(), children: saving ? "Saving\u2026" : "Save" })
      ] })
    ] });
  }
  if (!value.trim()) {
    return /* @__PURE__ */ jsx10("div", { className: classNames("md-field is-empty", className), children: /* @__PURE__ */ jsxs9("button", { type: "button", className: "md-empty", onClick: begin, "aria-label": `${emptyAction}: ${label}`, children: [
      /* @__PURE__ */ jsx10("span", { className: "muted", children: placeholder }),
      " ",
      /* @__PURE__ */ jsx10("span", { className: "link", children: emptyAction })
    ] }) });
  }
  return /* @__PURE__ */ jsxs9("div", { className: classNames("md-field", className), children: [
    /* @__PURE__ */ jsx10(Markdown, { source: value }),
    /* @__PURE__ */ jsx10("button", { type: "button", className: "md-edit icon-btn is-tiny", title: `Edit ${label}`, "aria-label": `Edit ${label}`, onClick: begin, children: /* @__PURE__ */ jsx10("span", { "aria-hidden": "true", children: "\u270E" }) })
  ] });
}
function AddField({
  placeholder,
  label,
  onAdd,
  autoFocus,
  onCancel,
  children
}) {
  const [value, setValue] = useState7("");
  return /* @__PURE__ */ jsxs9(
    "form",
    {
      className: "add-field",
      onSubmit: async (e) => {
        e.preventDefault();
        const next = value.trim();
        if (!next) return;
        const ok = await onAdd(next);
        if (ok !== false) setValue("");
      },
      children: [
        /* @__PURE__ */ jsx10(
          "input",
          {
            className: "input",
            value,
            placeholder,
            "aria-label": label,
            autoFocus,
            onChange: (e) => setValue(e.target.value),
            onKeyDown: (e) => {
              if (e.key === "Escape" && onCancel) {
                e.stopPropagation();
                onCancel();
              }
            },
            onBlur: () => {
              if (!value.trim()) onCancel?.();
            }
          }
        ),
        children,
        /* @__PURE__ */ jsx10("button", { type: "submit", className: "btn btn-sm", disabled: !value.trim(), children: "Add" })
      ]
    }
  );
}
var init_Editable = __esm({
  "src/ui/components/Editable.tsx"() {
    "use strict";
    init_Markdown();
    init_format();
  }
});

// src/ui/components/primitives.tsx
import { jsx as jsx11, jsxs as jsxs10 } from "react/jsx-runtime";
function EmptyState({
  title,
  hint,
  action
}) {
  return /* @__PURE__ */ jsxs10("div", { className: "empty-state", children: [
    /* @__PURE__ */ jsx11("p", { className: "empty-title", children: title }),
    hint && /* @__PURE__ */ jsx11("p", { className: "empty-hint", children: hint }),
    action
  ] });
}
var init_primitives = __esm({
  "src/ui/components/primitives.tsx"() {
    "use strict";
    init_format();
  }
});

// src/ui/components/ErrorBoundary.tsx
import { Component } from "react";
import { jsx as jsx12, jsxs as jsxs11 } from "react/jsx-runtime";
var ErrorBoundary;
var init_ErrorBoundary = __esm({
  "src/ui/components/ErrorBoundary.tsx"() {
    "use strict";
    ErrorBoundary = class extends Component {
      state = { error: null };
      static getDerivedStateFromError(error) {
        return { error };
      }
      componentDidCatch(error, info) {
        console.error(`[cc-harness] ${this.props.label} failed to render`, error, info.componentStack);
      }
      componentDidUpdate(prev) {
        if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
      }
      render() {
        if (!this.state.error) return this.props.children;
        return /* @__PURE__ */ jsxs11("div", { className: "crash", role: "alert", children: [
          /* @__PURE__ */ jsxs11("p", { className: "crash-title", children: [
            "The ",
            this.props.label,
            " could not be shown."
          ] }),
          /* @__PURE__ */ jsxs11("p", { className: "crash-detail", children: [
            "Your plan is saved \u2014 this is a display problem only. ",
            /* @__PURE__ */ jsx12("code", { children: this.state.error.message })
          ] }),
          /* @__PURE__ */ jsxs11("div", { className: "row-actions", children: [
            /* @__PURE__ */ jsx12("button", { type: "button", className: "btn btn-sm btn-primary", onClick: () => this.setState({ error: null }), children: "Try again" }),
            /* @__PURE__ */ jsx12("button", { type: "button", className: "btn btn-sm", onClick: () => window.location.reload(), children: "Reload the page" })
          ] })
        ] });
      }
    };
  }
});

// src/ui/components/Threads.tsx
import { useState as useState8 } from "react";
import { jsx as jsx13, jsxs as jsxs12 } from "react/jsx-runtime";
function useThreads(target) {
  const plan = usePlan();
  return (plan?.threads ?? []).filter((t) => t.target.kind === target.kind && t.target.id === target.id);
}
function CommentToggle({
  target,
  open,
  onToggle,
  label
}) {
  const threads = useThreads(target);
  const unresolved = threads.filter((t) => !t.resolved).length;
  const waiting = threads.some((t) => !t.resolved && lastAuthor(t) === "claude");
  return /* @__PURE__ */ jsxs12(
    "button",
    {
      type: "button",
      className: classNames("comment-toggle", open && "is-active", unresolved > 0 && "has-comments", waiting && "has-reply"),
      "aria-expanded": open,
      title: unresolved ? `${unresolved} open comment(s)` : "Comment",
      "aria-label": unresolved ? `${unresolved} open comment(s) on ${label}` : `Comment on ${label}`,
      onClick: onToggle,
      children: [
        /* @__PURE__ */ jsx13("span", { "aria-hidden": "true", children: "\u{1F4AC}" }),
        unresolved > 0 && /* @__PURE__ */ jsx13("span", { className: "comment-count", children: unresolved })
      ]
    }
  );
}
function ThreadPanel({ target, label }) {
  const threads = useThreads(target);
  const [showResolved, setShowResolved] = useState8(false);
  const open = threads.filter((t) => !t.resolved);
  const resolved = threads.filter((t) => t.resolved);
  return /* @__PURE__ */ jsxs12("div", { className: "threads", "aria-label": `Comments on ${label}`, children: [
    open.map((t) => /* @__PURE__ */ jsx13(ThreadView, { thread: t }, t.id)),
    resolved.length > 0 && /* @__PURE__ */ jsxs12("button", { type: "button", className: "link threads-resolved", onClick: () => setShowResolved((v) => !v), children: [
      showResolved ? "Hide" : "Show",
      " ",
      resolved.length,
      " resolved"
    ] }),
    showResolved && resolved.map((t) => /* @__PURE__ */ jsx13(ThreadView, { thread: t }, t.id)),
    /* @__PURE__ */ jsx13(
      Composer,
      {
        placeholder: open.length ? "Add another comment\u2026" : `Comment on ${label}\u2026`,
        label: `New comment on ${label}`,
        onSend: (text) => store.op({ op: "comment", target, text })
      }
    )
  ] });
}
function ThreadView({ thread }) {
  const [replying, setReplying] = useState8(false);
  return /* @__PURE__ */ jsxs12("article", { className: classNames("thread", thread.resolved && "is-resolved"), children: [
    /* @__PURE__ */ jsx13(Entry, { author: thread.author, text: thread.text, ts: thread.ts }),
    thread.replies.map((r) => /* @__PURE__ */ jsx13(Entry, { author: r.author, text: r.text, ts: r.ts, reply: true }, r.id)),
    /* @__PURE__ */ jsxs12("div", { className: "thread-actions", children: [
      !thread.resolved && /* @__PURE__ */ jsx13("button", { type: "button", className: "link", onClick: () => setReplying((v) => !v), children: "Reply" }),
      /* @__PURE__ */ jsx13("button", { type: "button", className: "link", onClick: () => void store.op({ op: "resolve", threadId: thread.id, resolved: !thread.resolved }), children: thread.resolved ? "Reopen" : "Resolve" }),
      !thread.resolved && lastAuthor(thread) === "user" && /* @__PURE__ */ jsx13("span", { className: "muted", children: "Claude sees this when it next reads the plan" })
    ] }),
    replying && /* @__PURE__ */ jsx13(
      Composer,
      {
        placeholder: "Reply\u2026",
        label: "Reply",
        autoFocus: true,
        onSend: async (text) => {
          const ok = await store.op({ op: "reply", threadId: thread.id, text });
          if (ok) setReplying(false);
          return ok;
        },
        onCancel: () => setReplying(false)
      }
    )
  ] });
}
function Entry({ author, text, ts, reply }) {
  return /* @__PURE__ */ jsxs12("div", { className: classNames("thread-entry", reply && "is-reply", `by-${author}`), children: [
    /* @__PURE__ */ jsxs12("div", { className: "thread-meta", children: [
      /* @__PURE__ */ jsx13(AuthorBadge, { author }),
      /* @__PURE__ */ jsx13("span", { className: "muted", children: relativeTime(ts) })
    ] }),
    /* @__PURE__ */ jsx13(Markdown, { source: text })
  ] });
}
function AuthorBadge({ author }) {
  return /* @__PURE__ */ jsx13("span", { className: classNames("author", `is-${author}`), children: author === "user" ? "You" : "Claude" });
}
function Composer({
  placeholder,
  label,
  onSend,
  autoFocus,
  onCancel
}) {
  const [text, setText] = useState8("");
  const [busy, setBusy] = useState8(false);
  const send = async () => {
    const value = text.trim();
    if (!value || busy) return;
    setBusy(true);
    const ok = await onSend(value);
    setBusy(false);
    if (ok) setText("");
  };
  return /* @__PURE__ */ jsxs12("div", { className: "thread-composer", children: [
    /* @__PURE__ */ jsx13(
      "textarea",
      {
        className: "input",
        rows: text.includes("\n") ? 4 : 2,
        value: text,
        placeholder,
        "aria-label": label,
        autoFocus,
        onChange: (e) => setText(e.target.value),
        onKeyDown: (e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void send();
          }
          if (e.key === "Escape" && onCancel) {
            e.stopPropagation();
            onCancel();
          }
        }
      }
    ),
    /* @__PURE__ */ jsxs12("div", { className: "thread-composer-foot", children: [
      /* @__PURE__ */ jsx13("span", { className: "muted", children: "\u2318/Ctrl+Enter" }),
      /* @__PURE__ */ jsx13("span", { className: "spacer" }),
      onCancel && /* @__PURE__ */ jsx13("button", { type: "button", className: "btn btn-sm btn-ghost", onClick: onCancel, children: "Cancel" }),
      /* @__PURE__ */ jsx13("button", { type: "button", className: "btn btn-sm", disabled: !text.trim() || busy, onClick: () => void send(), children: "Comment" })
    ] })
  ] });
}
function lastAuthor(t) {
  return t.replies.length ? t.replies[t.replies.length - 1].author : t.author;
}
var init_Threads = __esm({
  "src/ui/components/Threads.tsx"() {
    "use strict";
    init_store();
    init_Markdown();
    init_format();
  }
});

// src/ui/lib/motion.ts
function prefersReducedMotion() {
  try {
    return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  } catch {
    return false;
  }
}
function scrollBehavior() {
  return prefersReducedMotion() ? "auto" : "smooth";
}
var init_motion = __esm({
  "src/ui/lib/motion.ts"() {
    "use strict";
  }
});

// src/ui/components/Item.tsx
import { useEffect as useEffect8, useRef as useRef4, useState as useState9 } from "react";
import { jsx as jsx14, jsxs as jsxs13 } from "react/jsx-runtime";
function Focusable({
  kind,
  id,
  className,
  children,
  as: Tag = "section"
}) {
  const focusTarget = useStore((s) => s.focusTarget);
  const ref2 = useRef4(null);
  const [flash, setFlash] = useState9(false);
  const mine = focusTarget === `${kind}:${id}`;
  useEffect8(() => {
    if (!mine) return;
    ref2.current?.scrollIntoView?.({ behavior: scrollBehavior(), block: "center" });
    setFlash(true);
    const timer = window.setTimeout(() => {
      setFlash(false);
      store.set({ focusTarget: null });
    }, 1600);
    return () => window.clearTimeout(timer);
  }, [mine]);
  return /* @__PURE__ */ jsx14(Tag, { ref: ref2, id: `${kind}-${id}`, className: classNames(className, flash && "is-flash"), children });
}
function ItemActions({
  label,
  index,
  count,
  onMove,
  onRemove
}) {
  const [confirming, setConfirming] = useState9(false);
  if (confirming) {
    return /* @__PURE__ */ jsxs13("span", { className: "item-confirm", children: [
      "Remove?",
      /* @__PURE__ */ jsx14("button", { type: "button", className: "link is-danger", onClick: onRemove, children: "Remove" }),
      /* @__PURE__ */ jsx14("button", { type: "button", className: "link", onClick: () => setConfirming(false), children: "Keep" })
    ] });
  }
  return /* @__PURE__ */ jsxs13("span", { className: "item-actions", children: [
    /* @__PURE__ */ jsx14(
      "button",
      {
        type: "button",
        className: "icon-btn is-tiny",
        disabled: index === 0,
        title: "Move up",
        "aria-label": `Move ${label} up`,
        onClick: () => onMove(index - 1),
        children: /* @__PURE__ */ jsx14("span", { "aria-hidden": "true", children: "\u2191" })
      }
    ),
    /* @__PURE__ */ jsx14(
      "button",
      {
        type: "button",
        className: "icon-btn is-tiny",
        disabled: index >= count - 1,
        title: "Move down",
        "aria-label": `Move ${label} down`,
        onClick: () => onMove(index + 1),
        children: /* @__PURE__ */ jsx14("span", { "aria-hidden": "true", children: "\u2193" })
      }
    ),
    /* @__PURE__ */ jsx14("button", { type: "button", className: "icon-btn is-tiny is-danger", title: "Remove", "aria-label": `Remove ${label}`, onClick: () => setConfirming(true), children: /* @__PURE__ */ jsx14("span", { "aria-hidden": "true", children: "\xD7" }) })
  ] });
}
var init_Item = __esm({
  "src/ui/components/Item.tsx"() {
    "use strict";
    init_store();
    init_motion();
    init_format();
  }
});

// src/ui/views/OverviewView.tsx
import { useState as useState10 } from "react";
import { jsx as jsx15, jsxs as jsxs14 } from "react/jsx-runtime";
function OverviewView() {
  const plan = usePlan();
  if (!plan) return null;
  return /* @__PURE__ */ jsxs14("div", { className: "view-pad doc", children: [
    /* @__PURE__ */ jsx15(Glance, { plan }),
    /* @__PURE__ */ jsxs14("fieldset", { className: "lockable", disabled: isLocked(plan), children: [
      /* @__PURE__ */ jsxs14("section", { className: "doc-block", "aria-labelledby": "summary-head", children: [
        /* @__PURE__ */ jsx15("h2", { id: "summary-head", className: "doc-label", children: "Summary" }),
        /* @__PURE__ */ jsx15(
          MarkdownField,
          {
            value: plan.summary,
            label: "the plan summary",
            placeholder: "No summary yet.",
            emptyAction: "Write one",
            onSave: (summary) => store.op({ op: "set_meta", summary })
          }
        )
      ] }),
      plan.sections.map((section, i) => /* @__PURE__ */ jsx15(SectionCard, { section, index: i, count: plan.sections.length }, section.id)),
      !isLocked(plan) && /* @__PURE__ */ jsx15("div", { className: "doc-add", children: /* @__PURE__ */ jsx15(
        AddField,
        {
          placeholder: "New section title \u2014 e.g. Data model, Risks, Out of scope",
          label: "New section title",
          onAdd: (title) => store.op({ op: "upsert_section", title, body: "" })
        }
      ) }),
      (!isLocked(plan) || plan.threads.some((t) => t.target.kind === "plan")) && /* @__PURE__ */ jsxs14("section", { className: "doc-block", "aria-labelledby": "general-head", children: [
        /* @__PURE__ */ jsx15("h2", { id: "general-head", className: "doc-label", children: "General comments" }),
        /* @__PURE__ */ jsx15(ThreadPanel, { target: { kind: "plan", id: "" }, label: "the plan" })
      ] })
    ] })
  ] });
}
function Glance({ plan }) {
  const counts = countTasks(plan);
  const openThreads = plan.threads.filter((t) => !t.resolved).length;
  const now = currentTask(plan);
  const blocked = plan.tasks.filter((t) => t.status === "blocked");
  return /* @__PURE__ */ jsxs14("div", { className: "glance", role: "list", "aria-label": "Plan at a glance", children: [
    /* @__PURE__ */ jsxs14("button", { type: "button", role: "listitem", className: "glance-tile", onClick: () => store.setTab("tasks"), children: [
      /* @__PURE__ */ jsx15("span", { className: "glance-label", children: "Tasks" }),
      /* @__PURE__ */ jsxs14("span", { className: "glance-value", children: [
        counts.done,
        /* @__PURE__ */ jsxs14("span", { className: "glance-of", children: [
          "/",
          counts.total
        ] })
      ] }),
      /* @__PURE__ */ jsx15(ProgressBar, { counts }),
      /* @__PURE__ */ jsxs14("span", { className: "glance-sub", children: [
        counts.inProgress ? `${counts.inProgress} in progress` : counts.total ? "none in progress" : "no tasks yet",
        counts.blocked ? ` \xB7 ${counts.blocked} blocked` : ""
      ] })
    ] }),
    /* @__PURE__ */ jsxs14(
      "button",
      {
        type: "button",
        role: "listitem",
        className: blocked.length ? "glance-tile is-attention" : "glance-tile",
        onClick: () => {
          const target = now ?? blocked[0];
          if (target) store.focus("task", target.id);
          else store.setTab("tasks");
        },
        children: [
          /* @__PURE__ */ jsx15("span", { className: "glance-label", children: now ? "Claude is on" : blocked.length ? "Blocked" : "Now" }),
          /* @__PURE__ */ jsx15("span", { className: "glance-now", children: now?.title ?? blocked[0]?.title ?? (counts.total && counts.done === counts.total ? "All done" : "Nothing in progress") }),
          /* @__PURE__ */ jsx15("span", { className: "glance-sub", children: now?.note ?? blocked[0]?.note ?? (blocked.length > 1 ? `${blocked.length} tasks blocked` : " ") })
        ]
      }
    ),
    /* @__PURE__ */ jsxs14("button", { type: "button", role: "listitem", className: "glance-tile", onClick: () => store.setTab("diagrams"), children: [
      /* @__PURE__ */ jsx15("span", { className: "glance-label", children: "Diagrams" }),
      /* @__PURE__ */ jsx15("span", { className: "glance-value", children: plan.diagrams.length }),
      /* @__PURE__ */ jsx15("span", { className: "glance-sub", children: plan.diagrams.map((d) => d.title).slice(0, 2).join(", ") || "none yet" })
    ] }),
    /* @__PURE__ */ jsxs14(
      "button",
      {
        type: "button",
        role: "listitem",
        className: "glance-tile",
        onClick: () => document.getElementById("general-head")?.scrollIntoView({ behavior: scrollBehavior(), block: "start" }),
        children: [
          /* @__PURE__ */ jsx15("span", { className: "glance-label", children: "Open comments" }),
          /* @__PURE__ */ jsx15("span", { className: "glance-value", children: openThreads }),
          /* @__PURE__ */ jsxs14("span", { className: "glance-sub", children: [
            "revision ",
            plan.revision || "draft"
          ] })
        ]
      }
    )
  ] });
}
function SectionCard({ section, index, count }) {
  const [comments, setComments] = useState10(false);
  const target = { kind: "section", id: section.id };
  return /* @__PURE__ */ jsxs14(Focusable, { kind: "section", id: section.id, className: "doc-block section-card", children: [
    /* @__PURE__ */ jsxs14("header", { className: "item-head", children: [
      /* @__PURE__ */ jsx15(
        InlineText,
        {
          as: "h2",
          className: "section-title",
          value: section.title,
          label: "Section title",
          onSave: (title) => store.op({ op: "upsert_section", id: section.id, title })
        }
      ),
      /* @__PURE__ */ jsx15("span", { className: "item-id", children: section.id }),
      /* @__PURE__ */ jsx15("span", { className: "spacer" }),
      /* @__PURE__ */ jsx15(CommentToggle, { target, label: section.title, open: comments, onToggle: () => setComments((v) => !v) }),
      /* @__PURE__ */ jsx15(
        ItemActions,
        {
          label: section.title,
          index,
          count,
          onMove: (to) => store.op({ op: "move_section", id: section.id, index: to }),
          onRemove: () => store.op({ op: "remove", kind: "section", id: section.id })
        }
      )
    ] }),
    /* @__PURE__ */ jsx15(
      MarkdownField,
      {
        value: section.body,
        label: `section "${section.title}"`,
        rows: 8,
        version: section.rev,
        onSave: (body, rev) => store.op({ op: "upsert_section", id: section.id, body, ...rev !== void 0 ? { expect: rev } : {} })
      }
    ),
    comments && /* @__PURE__ */ jsx15(ThreadPanel, { target, label: section.title })
  ] });
}
var init_OverviewView = __esm({
  "src/ui/views/OverviewView.tsx"() {
    "use strict";
    init_store();
    init_Editable();
    init_Threads();
    init_Item();
    init_Progress();
    init_motion();
    init_plan();
  }
});

// src/ui/lib/layout.ts
import dagre from "@dagrejs/dagre";
function nodeSize(node) {
  const label = node.label.length * LABEL_CHAR;
  const detail = node.detail ? Math.min(node.detail.length, 46) * DETAIL_CHAR : 0;
  const raw = Math.max(label + LABEL_CHROME, detail ? detail / (node.detail.length > 34 ? 2 : 1) + DETAIL_CHROME : 0);
  const width = Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, raw)) / 10) * 10;
  const labelLines = Math.min(2, Math.max(1, Math.ceil(label / (width - LABEL_CHROME))));
  const detailLines = node.detail ? Math.min(2, Math.max(1, Math.ceil(node.detail.length * DETAIL_CHAR / (width - DETAIL_CHROME)))) : 0;
  let height = 18 + labelLines * 17 + (detailLines ? 2 + detailLines * 14 : 0) + (node.taskIds?.length ? 16 : 0);
  if (node.kind === "datastore") height += 6;
  return { width, height: Math.max(44, height) };
}
function labelSize(label) {
  const text = label.length * 6.2;
  const lines = Math.min(2, Math.ceil(text / 160));
  return { width: Math.round(Math.min(172, text + 14)), height: 8 + lines * 14 };
}
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
      const items2 = loose.slice(row * cols, row * cols + cols);
      let tallest = 0;
      items2.forEach((n, i) => {
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
    const centre2 = {
      x: boxes.reduce((t, b) => t + b.x + b.width / 2, 0) / boxes.length,
      y: boxes.reduce((t, b) => t + b.y + b.height / 2, 0) / boxes.length
    };
    const after2 = sources.length > 0;
    const want = lr ? {
      x: after2 ? Math.max(...boxes.map((b) => b.x + b.width)) + RANK_GAP : Math.min(...boxes.map((b) => b.x)) - RANK_GAP - s.width,
      y: centre2.y - s.height / 2
    } : {
      x: centre2.x - s.width / 2,
      y: after2 ? Math.max(...boxes.map((b) => b.y + b.height)) + RANK_GAP : Math.min(...boxes.map((b) => b.y)) - RANK_GAP - s.height
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
var LABEL_CHAR, DETAIL_CHAR, LABEL_CHROME, DETAIL_CHROME, MIN_WIDTH, MAX_WIDTH, SPACING, SHELF_GAP, computed, COMPUTED_MAX, RANK_GAP, CLEARANCE;
var init_layout = __esm({
  "src/ui/lib/layout.ts"() {
    "use strict";
    LABEL_CHAR = 7.4;
    DETAIL_CHAR = 6.1;
    LABEL_CHROME = 70;
    DETAIL_CHROME = 25;
    MIN_WIDTH = 170;
    MAX_WIDTH = 250;
    SPACING = {
      // In LR, nodesep is the vertical gap between boxes in one rank.
      LR: { nodesep: 30, ranksep: 72, edgesep: 14 },
      TB: { nodesep: 44, ranksep: 58, edgesep: 14 }
    };
    SHELF_GAP = 72;
    computed = /* @__PURE__ */ new Map();
    COMPUTED_MAX = 16;
    RANK_GAP = 90;
    CLEARANCE = 22;
  }
});

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
function sidePoint(r, side, offset = 0) {
  switch (side) {
    case "top":
      return { x: r.x + r.width / 2 + offset, y: r.y };
    case "bottom":
      return { x: r.x + r.width / 2 + offset, y: r.y + r.height };
    case "left":
      return { x: r.x, y: r.y + r.height / 2 + offset };
    case "right":
      return { x: r.x + r.width, y: r.y + r.height / 2 + offset };
  }
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
function midpoint(points) {
  if (points.length === 0) return { x: 0, y: 0 };
  const lengths = [];
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const l = Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    lengths.push(l);
    total += l;
  }
  let left = total / 2;
  for (let i = 1; i < points.length; i++) {
    const l = lengths[i - 1];
    if (left <= l && l > 0) {
      const t = left / l;
      return { x: points[i - 1].x + (points[i].x - points[i - 1].x) * t, y: points[i - 1].y + (points[i].y - points[i - 1].y) * t };
    }
    left -= l;
  }
  return points[points.length - 1];
}
function loopPath(r) {
  const sx = r.x + r.width;
  const sy = r.y + r.height * 0.35;
  const ex = r.x + r.width * 0.75;
  const ey = r.y;
  return {
    path: `M${sx},${sy} C${sx + 46},${sy} ${ex},${ey - 46} ${ex},${ey}`,
    label: { x: sx + 22, y: ey - 22 }
  };
}
function lanes(edges) {
  const groups = /* @__PURE__ */ new Map();
  for (const e of edges) {
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
var init_geometry = __esm({
  "src/ui/lib/geometry.ts"() {
    "use strict";
  }
});

// src/ui/lib/graph.ts
function relationsOf(focus, edges, hops = 1) {
  const nodes = /* @__PURE__ */ new Map([[focus, "focus"]]);
  const rels = /* @__PURE__ */ new Map();
  const mark = (id, rel) => {
    const was = nodes.get(id);
    if (was === "focus") return;
    nodes.set(id, !was || was === rel ? rel : "both");
  };
  for (const e of edges) {
    if (e.source === e.target) continue;
    if (e.source !== focus && e.target !== focus) continue;
    const other = e.source === focus ? e.target : e.source;
    if (twoWay(e)) {
      rels.set(e.id, "both");
      mark(other, "both");
    } else if (e.source === focus) {
      rels.set(e.id, "out");
      mark(other, "to");
    } else {
      rels.set(e.id, "in");
      mark(other, "from");
    }
  }
  if (hops < 2) return { nodes, edges: rels };
  const first = new Map(nodes);
  const downstream = [...first].filter(([, r]) => r === "to" || r === "both").map(([id]) => id);
  const upstream = [...first].filter(([, r]) => r === "from" || r === "both").map(([id]) => id);
  for (const e of edges) {
    if (e.source === e.target || rels.has(e.id)) continue;
    const onward = downstream.includes(e.source) ? e.target : twoWay(e) && downstream.includes(e.target) ? e.source : null;
    if (onward && !first.has(onward)) {
      rels.set(e.id, "out2");
      if (!nodes.has(onward)) nodes.set(onward, "to2");
      continue;
    }
    const back = upstream.includes(e.target) ? e.source : twoWay(e) && upstream.includes(e.source) ? e.target : null;
    if (back && !first.has(back)) {
      rels.set(e.id, "in2");
      if (!nodes.has(back)) nodes.set(back, "from2");
    }
  }
  return { nodes, edges: rels };
}
function bridgeOver(removed, edges) {
  const kept = edges.filter((e) => !removed.has(e.source) && !removed.has(e.target));
  const bridges = [];
  const exists = (s, t) => kept.some((e) => e.source === s && e.target === t) || bridges.some((b) => b.source === s && b.target === t);
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
var twoWay;
var init_graph = __esm({
  "src/ui/lib/graph.ts"() {
    "use strict";
    twoWay = (e) => e.arrows === "both" || e.arrows === "none";
  }
});

// src/ui/lib/history.ts
var History;
var init_history = __esm({
  "src/ui/lib/history.ts"() {
    "use strict";
    History = class {
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
        const after2 = this.future.pop();
        if (after2 === void 0) return null;
        this.past.push(current);
        return after2;
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
  }
});

// src/ui/lib/clipboard.ts
function toClip(nodes, edges) {
  if (!nodes.length) return null;
  const ids = new Set(nodes.map((n) => n.id));
  return {
    kind: CLIP_KIND,
    version: 1,
    nodes: nodes.map((n) => strip({ ...n })),
    edges: edges.filter((e) => ids.has(e.source) && ids.has(e.target)).map((e) => strip({ ...e }))
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
  const nodes = [];
  for (const n of r.nodes.slice(0, 120)) {
    const o = n;
    const id = str(o?.["id"], 60);
    if (!id || nodes.some((x) => x.id === id)) continue;
    nodes.push(
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
  if (!nodes.length) return null;
  const ids = new Set(nodes.map((n) => n.id));
  const edges = [];
  for (const e of r.edges.slice(0, 300)) {
    const o = e;
    const source = str(o?.["source"], 60);
    const target = str(o?.["target"], 60);
    if (!source || !target || !ids.has(source) || !ids.has(target)) continue;
    const arrows = EDGE_ARROWS.includes(o["arrows"]) ? o["arrows"] : void 0;
    edges.push(strip({ source, target, label: str(o["label"], 120), dashed: o["dashed"] === true ? true : void 0, arrows: arrows === "end" ? void 0 : arrows }));
  }
  return { kind: CLIP_KIND, version: 1, nodes, edges };
}
function pasteClip(clip, taken, tasks, offset) {
  const used = new Set(taken);
  const ids = /* @__PURE__ */ new Map();
  for (const n of clip.nodes) {
    const id = freeId(n.id, used);
    used.add(id);
    ids.set(n.id, id);
  }
  const nodes = clip.nodes.map(
    (n) => strip({
      ...n,
      id: ids.get(n.id),
      taskIds: n.taskIds?.filter((t) => tasks.has(t)),
      x: Math.round(n.x + offset.x),
      y: Math.round(n.y + offset.y)
    })
  );
  const edges = clip.edges.map((e) => ({ ...e, source: ids.get(e.source), target: ids.get(e.target) }));
  return { nodes, edges };
}
function clipOrigin(clip) {
  return { x: Math.min(...clip.nodes.map((n) => n.x)), y: Math.min(...clip.nodes.map((n) => n.y)) };
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
var CLIP_KIND;
var init_clipboard = __esm({
  "src/ui/lib/clipboard.ts"() {
    "use strict";
    init_types();
    CLIP_KIND = "cc-harness/diagram-selection";
  }
});

// src/ui/lib/theme.ts
import { useEffect as useEffect9, useState as useState11 } from "react";
function useResolvedTheme() {
  const read = () => document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
  const [theme, setTheme] = useState11(read);
  useEffect9(() => {
    const observer = new MutationObserver(() => setTheme(read()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);
  return theme;
}
var init_theme = __esm({
  "src/ui/lib/theme.ts"() {
    "use strict";
  }
});

// src/ui/components/flow/shared.ts
import { createContext, useContext } from "react";
function useCanvas() {
  const api2 = useContext(CanvasContext);
  if (!api2) throw new Error("useCanvas outside the diagram editor");
  return api2;
}
var CanvasContext, KIND_LABEL, KIND_GLYPH, KIND_HINT;
var init_shared = __esm({
  "src/ui/components/flow/shared.ts"() {
    "use strict";
    CanvasContext = createContext(null);
    KIND_LABEL = {
      component: "Component",
      service: "Service",
      datastore: "Datastore",
      queue: "Queue",
      external: "External",
      actor: "Actor",
      note: "Note"
    };
    KIND_GLYPH = {
      component: "\u25A2",
      service: "\u2699",
      datastore: "\u26C1",
      queue: "\u2630",
      external: "\u2601",
      actor: "\u263A",
      note: "\u270E"
    };
    KIND_HINT = {
      component: "A part of the codebase: a module, a UI, a library",
      service: "Something that runs: an API, a worker, a job",
      datastore: "Where state lives: a database, a cache, a bucket",
      queue: "A queue, topic or stream between parts",
      external: "A system you depend on but do not own",
      actor: "A person or client that uses the system",
      note: "An annotation on the diagram, not a part of the system"
    };
  }
});

// src/ui/components/flow/PlanNode.tsx
import { useEffect as useEffect10, useRef as useRef5, useState as useState12 } from "react";
import { Handle, NodeToolbar, Position, useEdges, useNodes } from "@xyflow/react";
import { jsx as jsx16, jsxs as jsxs15 } from "react/jsx-runtime";
function PlanNode({ id, data, selected }) {
  const api2 = useCanvas();
  const editing = api2.editing === `node:${id}`;
  const p = data.progress;
  const state = !p ? null : p.blocked ? "blocked" : p.inProgress ? "in_progress" : p.done === p.total ? "done" : "todo";
  const summary = useHoverSummary();
  const hasStory = Boolean(data.description?.trim() || data.notes?.trim());
  return /* @__PURE__ */ jsxs15(
    "div",
    {
      className: classNames(
        "flow-node",
        `kind-${data.kind}`,
        selected && "is-selected",
        state && `progress-${state}`,
        editing && "is-editing",
        data.rel && `rel-${data.rel}`,
        data.dropTarget && "is-drop-target"
      ),
      style: { width: data.width, minHeight: data.height },
      children: [
        data.rel && data.rel !== "focus" && /* @__PURE__ */ jsx16("span", { className: `flow-node-rel rel-${data.rel}`, title: REL_HINT[data.rel], children: REL_BADGE[data.rel] }),
        SIDES.map(([side, position]) => /* @__PURE__ */ jsx16(Handle, { id: side, type: "source", position, className: `handle-${side}` }, side)),
        /* @__PURE__ */ jsxs15("div", { className: "flow-node-head", children: [
          /* @__PURE__ */ jsx16("span", { className: "flow-node-glyph", "aria-hidden": "true", children: KIND_GLYPH[data.kind] }),
          editing ? /* @__PURE__ */ jsx16(LabelInput, { value: data.label, seed: api2.editSeed, onDone: (label) => api2.finishNodeLabel(id, label) }) : /* @__PURE__ */ jsx16("span", { className: "flow-node-label", children: data.label }),
          /* @__PURE__ */ jsx16(
            "button",
            {
              type: "button",
              className: classNames("flow-node-info nodrag", hasStory && "has-story", summary.open && "is-open"),
              "aria-label": `About ${data.label}`,
              "aria-expanded": summary.open,
              onMouseEnter: summary.show,
              onMouseLeave: summary.hideSoon,
              onFocus: summary.show,
              onBlur: summary.hideNow,
              onKeyDown: (e) => {
                if (e.key === "Escape") summary.hideNow();
              },
              children: /* @__PURE__ */ jsx16(InfoIcon, {})
            }
          )
        ] }),
        data.detail && /* @__PURE__ */ jsx16("div", { className: "flow-node-detail", children: data.detail }),
        p && /* @__PURE__ */ jsxs15(
          "div",
          {
            className: "flow-node-progress",
            title: `${p.done} of ${p.total} tasks done${p.inProgress ? `, ${p.inProgress} in progress` : ""}${p.blocked ? `, ${p.blocked} blocked` : ""}`,
            children: [
              /* @__PURE__ */ jsx16(ProgressBar, { counts: p, compact: true }),
              /* @__PURE__ */ jsxs15("span", { children: [
                p.done,
                "/",
                p.total
              ] })
            ]
          }
        ),
        /* @__PURE__ */ jsx16(NodeToolbar, { isVisible: summary.open, position: summary.side, align: summary.align, offset: 10, className: "flow-summary-layer", children: summary.open && /* @__PURE__ */ jsx16(NodeSummary, { id, data, onEnter: summary.keep, onLeave: summary.hideSoon }) })
      ]
    }
  );
}
function useHoverSummary() {
  const [side, setSide] = useState12(null);
  const [align, setAlign] = useState12("center");
  const timer = useRef5(void 0);
  useEffect10(() => () => window.clearTimeout(timer.current), []);
  const keep = () => window.clearTimeout(timer.current);
  const show = (e) => {
    keep();
    const box = e.currentTarget.closest(".react-flow__node")?.getBoundingClientRect();
    const frame = e.currentTarget.closest(".react-flow")?.getBoundingClientRect();
    const roomAbove = box && frame ? box.top - frame.top : 0;
    setSide(roomAbove > 300 ? Position.Top : Position.Bottom);
    const half = 170;
    const centre2 = box ? box.left + box.width / 2 : 0;
    setAlign(!box || !frame ? "center" : centre2 - frame.left < half ? "start" : frame.right - centre2 < half ? "end" : "center");
  };
  const hideSoon = () => {
    keep();
    timer.current = window.setTimeout(() => setSide(null), 140);
  };
  const hideNow = () => {
    keep();
    setSide(null);
  };
  return { open: side !== null, side: side ?? Position.Top, align, show, keep, hideSoon, hideNow };
}
function NodeSummary({ id, data, onEnter, onLeave }) {
  const plan = usePlan();
  const edges = useEdges();
  const nodes = useNodes();
  const name = (nid) => nodes.find((n) => n.id === nid)?.data.label ?? nid;
  const out = edges.filter((e) => e.source === id && e.target !== id);
  const into = edges.filter((e) => e.target === id && e.source !== id);
  const tasks = (data.taskIds ?? []).map((t) => plan?.tasks.find((x) => x.id === t)).filter((t) => t !== void 0);
  const SHOWN = 5;
  const hidden = Math.max(0, out.length - SHOWN) + Math.max(0, into.length - SHOWN);
  return /* @__PURE__ */ jsxs15("div", { className: "flow-summary", role: "tooltip", onMouseEnter: onEnter, onMouseLeave: onLeave, children: [
    /* @__PURE__ */ jsxs15("header", { className: "flow-summary-head", children: [
      /* @__PURE__ */ jsx16("span", { className: classNames("kind-swatch", `kind-${data.kind}`), "aria-hidden": "true", children: KIND_GLYPH[data.kind] }),
      /* @__PURE__ */ jsx16("span", { className: "panel-kicker", children: KIND_LABEL[data.kind] })
    ] }),
    /* @__PURE__ */ jsx16("p", { className: "flow-summary-title", children: data.label }),
    data.detail && /* @__PURE__ */ jsx16("p", { className: "flow-summary-detail", children: data.detail }),
    data.description?.trim() ? /* @__PURE__ */ jsx16("div", { className: "flow-summary-body", children: /* @__PURE__ */ jsx16(Markdown, { source: data.description }) }) : /* @__PURE__ */ jsx16("p", { className: "flow-summary-empty", children: "No description yet. Select the box to write what it does." }),
    data.notes?.trim() && /* @__PURE__ */ jsxs15("section", { className: "flow-summary-section", children: [
      /* @__PURE__ */ jsx16("p", { className: "flow-summary-label", children: "Decisions" }),
      /* @__PURE__ */ jsx16("div", { className: "flow-summary-notes", children: /* @__PURE__ */ jsx16(Markdown, { source: data.notes }) })
    ] }),
    tasks.length > 0 && /* @__PURE__ */ jsxs15("section", { className: "flow-summary-section", children: [
      /* @__PURE__ */ jsxs15("p", { className: "flow-summary-label", children: [
        "Built by",
        data.progress && /* @__PURE__ */ jsxs15("span", { className: "flow-summary-progress", children: [
          /* @__PURE__ */ jsx16(ProgressBar, { counts: data.progress, compact: true }),
          " ",
          data.progress.done,
          "/",
          data.progress.total
        ] })
      ] }),
      /* @__PURE__ */ jsxs15("ul", { className: "flow-summary-list", children: [
        tasks.slice(0, SHOWN).map((t) => /* @__PURE__ */ jsxs15("li", { children: [
          /* @__PURE__ */ jsx16("span", { className: classNames("status-dot is-static", `is-${t.status}`), "aria-label": STATUS_LABEL[t.status], children: STATUS_GLYPH[t.status] }),
          t.title
        ] }, t.id)),
        tasks.length > SHOWN && /* @__PURE__ */ jsxs15("li", { className: "muted", children: [
          "and ",
          tasks.length - SHOWN,
          " more"
        ] })
      ] })
    ] }),
    (out.length > 0 || into.length > 0) && /* @__PURE__ */ jsxs15("section", { className: "flow-summary-section", children: [
      /* @__PURE__ */ jsx16("p", { className: "flow-summary-label", children: "Connections" }),
      /* @__PURE__ */ jsxs15("ul", { className: "flow-summary-list", children: [
        out.slice(0, SHOWN).map((e) => /* @__PURE__ */ jsxs15("li", { children: [
          /* @__PURE__ */ jsx16("span", { "aria-hidden": "true", children: e.data?.arrows === "both" ? "\u2194" : "\u2192" }),
          " ",
          name(e.target),
          e.data?.label && /* @__PURE__ */ jsxs15("span", { className: "muted", children: [
            " \xB7 ",
            e.data.label
          ] })
        ] }, e.id)),
        into.slice(0, SHOWN).map((e) => /* @__PURE__ */ jsxs15("li", { children: [
          /* @__PURE__ */ jsx16("span", { "aria-hidden": "true", children: e.data?.arrows === "both" ? "\u2194" : "\u2190" }),
          " ",
          name(e.source),
          e.data?.label && /* @__PURE__ */ jsxs15("span", { className: "muted", children: [
            " \xB7 ",
            e.data.label
          ] })
        ] }, e.id)),
        hidden > 0 && /* @__PURE__ */ jsxs15("li", { className: "muted", children: [
          "and ",
          hidden,
          " more"
        ] })
      ] })
    ] })
  ] });
}
function LabelInput({
  value,
  seed,
  onDone,
  className = "flow-node-input",
  placeholder
}) {
  const [draft, setDraft] = useState12(seed ?? value);
  const seeded = useRef5(Boolean(seed));
  const done = useRef5(false);
  const ref2 = useRef5(null);
  useEffect10(() => {
    let tries = 0;
    let frame = 0;
    const grab = () => {
      const el = ref2.current;
      if (!el) return;
      el.focus();
      if (document.activeElement !== el) {
        if (tries++ < 20) frame = window.requestAnimationFrame(grab);
      } else if (seeded.current) el.setSelectionRange(el.value.length, el.value.length);
      else el.select();
    };
    grab();
    return () => window.cancelAnimationFrame(frame);
  }, []);
  const finish = (v) => {
    if (done.current) return;
    done.current = true;
    onDone(v);
  };
  return /* @__PURE__ */ jsx16(
    "input",
    {
      ref: ref2,
      className: classNames(className, "nodrag nopan"),
      value: draft,
      "aria-label": "Rename",
      placeholder,
      maxLength: 120,
      onChange: (e) => setDraft(e.target.value),
      onBlur: () => finish(draft),
      onKeyDown: (e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(draft);
        if (e.key === "Escape") finish(null);
        if (e.key === "Tab") {
          e.preventDefault();
          finish(draft);
        }
      },
      onDoubleClick: (e) => e.stopPropagation()
    }
  );
}
function InfoIcon() {
  return /* @__PURE__ */ jsxs15("svg", { viewBox: "0 0 16 16", width: "14", height: "14", "aria-hidden": "true", children: [
    /* @__PURE__ */ jsx16("circle", { cx: "8", cy: "8", r: "6.6", fill: "none", stroke: "currentColor", strokeWidth: "1.4" }),
    /* @__PURE__ */ jsx16("rect", { x: "7.25", y: "7", width: "1.5", height: "4.6", rx: "0.75", fill: "currentColor" }),
    /* @__PURE__ */ jsx16("circle", { cx: "8", cy: "4.9", r: "0.95", fill: "currentColor" })
  ] });
}
var REL_BADGE, REL_HINT, SIDES;
var init_PlanNode = __esm({
  "src/ui/components/flow/PlanNode.tsx"() {
    "use strict";
    init_store();
    init_Markdown();
    init_Progress();
    init_format();
    init_shared();
    REL_BADGE = { to: "\u2192 to", from: "from \u2192", both: "\u21C4 both ways", to2: "\u2192 then", from2: "before \u2192" };
    REL_HINT = {
      to: "Downstream: the box in focus has an arrow to this one",
      from: "Upstream: this box has an arrow to the one in focus",
      both: "Connected both ways, or without a direction",
      to2: "Two steps downstream (hold Alt)",
      from2: "Two steps upstream (hold Alt)"
    };
    SIDES = [
      ["top", Position.Top],
      ["right", Position.Right],
      ["bottom", Position.Bottom],
      ["left", Position.Left]
    ];
  }
});

// src/ui/components/flow/PlanEdge.tsx
import { BaseEdge, EdgeLabelRenderer, getBezierPath, Position as Position2, useInternalNode } from "@xyflow/react";
import { Fragment as Fragment3, jsx as jsx17, jsxs as jsxs16 } from "react/jsx-runtime";
function PlanEdge({ id, source, target, data, markerEnd, markerStart, selected, style }) {
  const api2 = useCanvas();
  const from = useInternalNode(source);
  const to = useInternalNode(target);
  if (!from || !to) return null;
  const a = rectOf(from);
  const b = rectOf(to);
  if (!a.width || !b.width) return null;
  let path;
  let label;
  let ends2 = null;
  const route = data?.route;
  if (source === target) {
    ({ path, label } = loopPath(a));
  } else if (route && route.points.length >= 2 && samePoint(route.from, a) && samePoint(route.to, b)) {
    const pts = route.points.map((p) => ({ ...p }));
    pts[0] = clipToRect(a, pts[1]);
    pts[pts.length - 1] = clipToRect(b, pts[pts.length - 2]);
    path = splinePath(pts);
    label = route.label ?? midpoint(pts);
    ends2 = [pts[0], pts[pts.length - 1]];
  } else {
    const [sa, sb] = facingSides(a, b, api2.direction);
    const lane = data?.lane ?? 0;
    const s = sidePoint(a, sa, lane);
    const t = sidePoint(b, sb, lane);
    const [p, lx, ly] = getBezierPath({ sourceX: s.x, sourceY: s.y, sourcePosition: POSITION[sa], targetX: t.x, targetY: t.y, targetPosition: POSITION[sb], curvature: 0.3 });
    path = p;
    label = { x: lx, y: ly };
    ends2 = [s, t];
  }
  const editing = api2.editing === `edge:${id}`;
  const text = data?.label;
  const rel = data?.rel;
  return /* @__PURE__ */ jsxs16(Fragment3, { children: [
    /* @__PURE__ */ jsx17(
      BaseEdge,
      {
        id,
        path,
        markerEnd,
        markerStart,
        style,
        interactionWidth: 22,
        className: classNames(rel && `rel-${rel}`, data?.dropTarget && "is-drop-target")
      }
    ),
    data?.grips && ends2 && /* @__PURE__ */ jsx17(EdgeLabelRenderer, { children: ["source", "target"].map((end, i) => /* @__PURE__ */ jsx17(
      "button",
      {
        type: "button",
        className: `flow-edge-grip nodrag nopan is-${end}`,
        style: { transform: `translate(-50%, -50%) translate(${ends2[i].x}px, ${ends2[i].y}px)` },
        "aria-label": end === "source" ? "Drag to move where this arrow starts" : "Drag to move where this arrow ends",
        title: end === "source" ? "Drag onto another box to start the arrow there" : "Drag onto another box to end the arrow there",
        onPointerEnter: () => api2.hoverEdge(id),
        onPointerLeave: () => api2.hoverEdge(null),
        onPointerDown: (e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          e.stopPropagation();
          api2.startReconnect(id, end, e);
        }
      },
      end
    )) }),
    (text || editing) && /* @__PURE__ */ jsx17(EdgeLabelRenderer, { children: /* @__PURE__ */ jsx17(
      "div",
      {
        className: classNames(
          "flow-edge-label nodrag nopan",
          selected && "is-selected",
          data?.dashed && "is-dashed",
          editing && "is-editing",
          rel && `rel-${rel}`,
          data?.dim && "is-dim"
        ),
        style: { transform: `translate(-50%, -50%) translate(${label.x}px, ${label.y}px)` },
        onClick: () => api2.selectEdge(id),
        onDoubleClick: (e) => {
          e.stopPropagation();
          api2.startEditing(`edge:${id}`);
        },
        title: "Double-click to edit",
        children: editing ? /* @__PURE__ */ jsx17(LabelInput, { value: text ?? "", className: "flow-edge-input", placeholder: "What flows along it", onDone: (v) => api2.finishEdgeLabel(id, v) }) : text
      }
    ) })
  ] });
}
function rectOf(n) {
  return {
    x: n.internals.positionAbsolute.x,
    y: n.internals.positionAbsolute.y,
    width: n.measured.width ?? n.width ?? n.data.width,
    height: n.measured.height ?? n.height ?? n.data.height
  };
}
var POSITION;
var init_PlanEdge = __esm({
  "src/ui/components/flow/PlanEdge.tsx"() {
    "use strict";
    init_format();
    init_geometry();
    init_layout();
    init_PlanNode();
    init_shared();
    POSITION = { top: Position2.Top, right: Position2.Right, bottom: Position2.Bottom, left: Position2.Left };
  }
});

// src/ui/components/flow/Panels.tsx
import { useEffect as useEffect11, useLayoutEffect, useRef as useRef6, useState as useState13 } from "react";
import { Fragment as Fragment4, jsx as jsx18, jsxs as jsxs17 } from "react/jsx-runtime";
function CommitInput({
  value,
  label,
  placeholder,
  className,
  maxLength,
  onCommit
}) {
  const [draft, setDraft] = useState13(value);
  const live = useRef6({ draft, value, onCommit });
  live.current = { draft, value, onCommit };
  useEffect11(() => setDraft(value), [value]);
  useEffect11(
    () => () => {
      const { draft: draft2, value: value2, onCommit: onCommit2 } = live.current;
      if (draft2.trim() !== value2) onCommit2(draft2.trim());
    },
    []
  );
  const commit = () => {
    if (draft.trim() !== value) onCommit(draft.trim());
  };
  return /* @__PURE__ */ jsx18(
    "input",
    {
      className: classNames("input", className),
      value: draft,
      "aria-label": label,
      placeholder,
      maxLength,
      onChange: (e) => setDraft(e.target.value),
      onBlur: commit,
      onKeyDown: (e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") {
          e.stopPropagation();
          setDraft(value);
        }
      }
    }
  );
}
function CommitTextArea({
  value,
  label,
  placeholder,
  minRows = 3,
  maxLength,
  onCommit
}) {
  const [draft, setDraft] = useState13(value);
  const area = useRef6(null);
  const live = useRef6({ draft, value, onCommit });
  live.current = { draft, value, onCommit };
  useEffect11(() => setDraft(value), [value]);
  useEffect11(
    () => () => {
      const { draft: draft2, value: value2, onCommit: onCommit2 } = live.current;
      if (draft2.trim() !== value2.trim()) onCommit2(draft2.trim());
    },
    []
  );
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    if (el.scrollHeight) el.style.height = `${Math.min(el.scrollHeight + 2, 420)}px`;
  }, [draft]);
  const commit = () => {
    if (draft.trim() !== value.trim()) onCommit(draft.trim());
  };
  return /* @__PURE__ */ jsx18(
    "textarea",
    {
      ref: area,
      className: "input text-area",
      value: draft,
      rows: minRows,
      "aria-label": label,
      placeholder,
      maxLength,
      onChange: (e) => setDraft(e.target.value),
      onBlur: commit,
      onKeyDown: (e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          commit();
          area.current?.blur();
        }
        if (e.key === "Escape") {
          e.stopPropagation();
          setDraft(value);
        }
      }
    }
  );
}
function KindPicker({ value, onChange, label }) {
  return /* @__PURE__ */ jsxs17("div", { className: "kind-picker", role: "radiogroup", "aria-label": label, children: [
    NODE_KINDS.map((k) => /* @__PURE__ */ jsx18(
      "button",
      {
        type: "button",
        role: "radio",
        "aria-checked": value === k,
        "aria-label": KIND_LABEL[k],
        title: `${KIND_LABEL[k]} \u2014 ${KIND_HINT[k]}`,
        className: classNames("kind-option", `kind-${k}`, value === k && "is-active"),
        onClick: () => onChange(k),
        children: /* @__PURE__ */ jsx18("span", { className: "kind-swatch", "aria-hidden": "true", children: KIND_GLYPH[k] })
      },
      k
    )),
    /* @__PURE__ */ jsx18("span", { className: "kind-picker-name", children: value ? KIND_LABEL[value] : "Mixed" })
  ] });
}
function Segmented({ value, options, label, onChange }) {
  return /* @__PURE__ */ jsx18("div", { className: "segmented is-small", role: "radiogroup", "aria-label": label, children: options.map(([v, text, title]) => /* @__PURE__ */ jsx18("button", { type: "button", role: "radio", "aria-checked": value === v, title, className: classNames("seg", value === v && "is-active"), onClick: () => onChange(v), children: text }, v)) });
}
function NodePanel({
  node,
  nodes,
  edges,
  plan,
  onChange,
  onSelect,
  onConnect,
  onDisconnect,
  onAddConnected,
  onDuplicate,
  onRemove,
  onClose
}) {
  const [confirming, setConfirming] = useState13(false);
  const name = (id) => nodes.find((n) => n.id === id)?.data.label ?? id;
  const outgoing = edges.filter((e) => e.source === node.id);
  const incoming = edges.filter((e) => e.target === node.id && e.source !== node.id);
  const linked = node.data.taskIds ?? [];
  const rows = outline(plan);
  const linkable = rows.filter((r) => !linked.includes(r.task.id));
  const unconnected = nodes.filter((n) => n.id !== node.id && !outgoing.some((e) => e.target === n.id));
  return /* @__PURE__ */ jsxs17("div", { className: "arch-panel-body", "aria-label": `Details of ${node.data.label}`, children: [
    /* @__PURE__ */ jsxs17("header", { className: "panel-top", children: [
      /* @__PURE__ */ jsx18("span", { className: classNames("kind-swatch", `kind-${node.data.kind}`), "aria-hidden": "true", children: KIND_GLYPH[node.data.kind] }),
      /* @__PURE__ */ jsx18("span", { className: "panel-kicker", children: KIND_LABEL[node.data.kind] }),
      /* @__PURE__ */ jsx18("span", { className: "item-id", title: "Id \u2014 how Claude refers to this box", children: node.id }),
      /* @__PURE__ */ jsx18("span", { className: "spacer" }),
      /* @__PURE__ */ jsx18("button", { type: "button", className: "icon-btn is-tiny", "aria-label": "Close details", title: "Back to the diagram", onClick: onClose, children: "\xD7" })
    ] }),
    /* @__PURE__ */ jsx18(
      CommitInput,
      {
        className: "panel-title-input",
        value: node.data.label,
        label: "Box label",
        maxLength: 120,
        onCommit: (label) => label && onChange({ label })
      }
    ),
    /* @__PURE__ */ jsxs17("div", { className: "field", children: [
      /* @__PURE__ */ jsx18("span", { className: "field-label", children: "Kind" }),
      /* @__PURE__ */ jsx18(KindPicker, { value: node.data.kind, label: "Kind", onChange: (kind) => onChange({ kind }) })
    ] }),
    /* @__PURE__ */ jsxs17("label", { className: "field", children: [
      /* @__PURE__ */ jsxs17("span", { className: "field-label", children: [
        "On the box ",
        /* @__PURE__ */ jsx18("span", { className: "field-aside", children: "a few words: technology or role" })
      ] }),
      /* @__PURE__ */ jsx18(CommitInput, { value: node.data.detail ?? "", label: "Box detail", placeholder: "e.g. Redis, read-through", maxLength: 80, onCommit: (detail) => onChange({ detail }) })
    ] }),
    /* @__PURE__ */ jsxs17("label", { className: "field", children: [
      /* @__PURE__ */ jsxs17("span", { className: "field-label", children: [
        "Description ",
        /* @__PURE__ */ jsx18("span", { className: "field-aside", children: "shown when hovering \u24D8" })
      ] }),
      /* @__PURE__ */ jsx18(
        CommitTextArea,
        {
          value: node.data.description ?? "",
          label: `Description of ${node.data.label}`,
          placeholder: "What this part does, what it owns, and how other parts talk to it.",
          maxLength: 4e3,
          onCommit: (description) => onChange({ description })
        }
      )
    ] }),
    /* @__PURE__ */ jsxs17("div", { className: "field", children: [
      /* @__PURE__ */ jsx18("span", { className: "field-label", children: "Notes and decisions" }),
      /* @__PURE__ */ jsx18(
        MarkdownField,
        {
          value: node.data.notes ?? "",
          label: `notes on ${node.data.label}`,
          placeholder: "What was decided about this part, and why.",
          emptyAction: "Add a decision",
          rows: 6,
          onSave: (notes) => onChange({ notes })
        }
      )
    ] }),
    /* @__PURE__ */ jsxs17("div", { className: "field", children: [
      /* @__PURE__ */ jsx18("span", { className: "field-label", children: "Built by" }),
      linked.length > 0 ? /* @__PURE__ */ jsx18("ul", { className: "panel-tasks", children: linked.map((id) => {
        const task = plan.tasks.find((t) => t.id === id);
        if (!task) return null;
        return /* @__PURE__ */ jsxs17("li", { children: [
          /* @__PURE__ */ jsx18("span", { className: classNames("status-dot is-static", `is-${task.status}`), title: STATUS_LABEL[task.status], "aria-label": STATUS_LABEL[task.status], children: STATUS_GLYPH[task.status] }),
          /* @__PURE__ */ jsx18("button", { type: "button", className: "link panel-task", onClick: () => store.focus("task", id), children: task.title }),
          /* @__PURE__ */ jsx18("button", { type: "button", className: "icon-btn is-tiny", "aria-label": `Unlink ${task.title}`, title: "Unlink", onClick: () => onChange({ taskIds: linked.filter((t) => t !== id) }), children: "\xD7" })
        ] }, id);
      }) }) : /* @__PURE__ */ jsx18("p", { className: "muted panel-empty", children: "No tasks linked. Link the tasks that build this part to see its progress on the box." }),
      linkable.length > 0 && /* @__PURE__ */ jsxs17("select", { className: "input", "aria-label": `Link a task to ${node.data.label}`, value: "", onChange: (e) => e.target.value && onChange({ taskIds: [...linked, e.target.value] }), children: [
        /* @__PURE__ */ jsx18("option", { value: "", children: "Link a task\u2026" }),
        linkable.map(({ task, number, depth }) => /* @__PURE__ */ jsxs17("option", { value: task.id, children: [
          " ".repeat(depth * 3),
          number,
          " ",
          task.title
        ] }, task.id))
      ] })
    ] }),
    /* @__PURE__ */ jsxs17("div", { className: "field", children: [
      /* @__PURE__ */ jsx18("span", { className: "field-label", children: "Connections" }),
      outgoing.length + incoming.length > 0 ? /* @__PURE__ */ jsxs17("ul", { className: "panel-links", children: [
        outgoing.map((e) => /* @__PURE__ */ jsxs17("li", { children: [
          /* @__PURE__ */ jsxs17("button", { type: "button", className: "link", onClick: () => onSelect("edge", e.id), children: [
            e.data?.arrows === "both" ? "\u2194" : "\u2192",
            " ",
            name(e.target)
          ] }),
          e.data?.label && /* @__PURE__ */ jsxs17("span", { className: "muted", children: [
            " ",
            e.data.label
          ] }),
          /* @__PURE__ */ jsx18("span", { className: "spacer" }),
          /* @__PURE__ */ jsx18("button", { type: "button", className: "icon-btn is-tiny", "aria-label": `Remove connection to ${name(e.target)}`, title: "Disconnect", onClick: () => onDisconnect(e.id), children: "\xD7" })
        ] }, e.id)),
        incoming.map((e) => /* @__PURE__ */ jsxs17("li", { children: [
          /* @__PURE__ */ jsxs17("button", { type: "button", className: "link", onClick: () => onSelect("edge", e.id), children: [
            e.data?.arrows === "both" ? "\u2194" : "\u2190",
            " ",
            name(e.source)
          ] }),
          e.data?.label && /* @__PURE__ */ jsxs17("span", { className: "muted", children: [
            " ",
            e.data.label
          ] }),
          /* @__PURE__ */ jsx18("span", { className: "spacer" }),
          /* @__PURE__ */ jsx18("button", { type: "button", className: "icon-btn is-tiny", "aria-label": `Remove connection from ${name(e.source)}`, title: "Disconnect", onClick: () => onDisconnect(e.id), children: "\xD7" })
        ] }, e.id))
      ] }) : /* @__PURE__ */ jsx18("p", { className: "muted panel-empty", children: "Not connected. Drag from any edge of the box to another box, or into space for a new one." }),
      /* @__PURE__ */ jsxs17("div", { className: "row-actions", children: [
        unconnected.length > 0 && /* @__PURE__ */ jsxs17("select", { className: "input", "aria-label": `Connect ${node.data.label} to`, value: "", onChange: (e) => e.target.value && onConnect(e.target.value), children: [
          /* @__PURE__ */ jsx18("option", { value: "", children: "Connect to\u2026" }),
          unconnected.map((n) => /* @__PURE__ */ jsx18("option", { value: n.id, children: n.data.label }, n.id))
        ] }),
        /* @__PURE__ */ jsx18("button", { type: "button", className: "btn btn-sm", onClick: onAddConnected, title: "A new box, connected from this one", children: "+ Connected box" })
      ] })
    ] }),
    /* @__PURE__ */ jsxs17("footer", { className: "panel-foot", children: [
      /* @__PURE__ */ jsx18("button", { type: "button", className: "link", onClick: onDuplicate, title: "\u2318/Ctrl+D", children: "Duplicate" }),
      /* @__PURE__ */ jsx18("span", { className: "spacer" }),
      confirming ? /* @__PURE__ */ jsxs17("span", { className: "item-confirm", children: [
        "Delete this box and its arrows?",
        /* @__PURE__ */ jsx18("button", { type: "button", className: "link is-danger", onClick: onRemove, children: "Delete" }),
        /* @__PURE__ */ jsx18("button", { type: "button", className: "link", onClick: () => setConfirming(false), children: "Keep" })
      ] }) : /* @__PURE__ */ jsx18("button", { type: "button", className: "link is-danger", onClick: () => setConfirming(true), children: "Delete box" })
    ] })
  ] });
}
function EdgePanel({
  edge,
  nodes,
  onChange,
  onReverse,
  onSelect,
  onRemove,
  onClose
}) {
  const name = (id) => nodes.find((n) => n.id === id)?.data.label ?? id;
  const ends2 = (which) => /* @__PURE__ */ jsx18("select", { className: "input", "aria-label": which === "source" ? "From" : "To", value: edge[which], onChange: (e) => onChange({ [which]: e.target.value }), children: nodes.map((n) => /* @__PURE__ */ jsx18("option", { value: n.id, disabled: n.id === (which === "source" ? edge.target : edge.source), children: n.data.label }, n.id)) });
  return /* @__PURE__ */ jsxs17("div", { className: "arch-panel-body", "aria-label": "Details of the selected arrow", children: [
    /* @__PURE__ */ jsxs17("header", { className: "panel-top", children: [
      /* @__PURE__ */ jsx18("span", { className: "panel-kicker", children: "Connection" }),
      /* @__PURE__ */ jsx18("span", { className: "spacer" }),
      /* @__PURE__ */ jsx18("button", { type: "button", className: "icon-btn is-tiny", "aria-label": "Close details", title: "Back to the diagram", onClick: onClose, children: "\xD7" })
    ] }),
    /* @__PURE__ */ jsxs17("p", { className: "panel-edge", children: [
      /* @__PURE__ */ jsx18("button", { type: "button", className: "link", onClick: () => onSelect("node", edge.source), children: name(edge.source) }),
      /* @__PURE__ */ jsxs17("span", { "aria-hidden": "true", children: [
        " ",
        edge.data?.arrows === "both" ? "\u2194" : edge.data?.arrows === "none" ? "\u2014" : "\u2192",
        " "
      ] }),
      /* @__PURE__ */ jsx18("button", { type: "button", className: "link", onClick: () => onSelect("node", edge.target), children: name(edge.target) })
    ] }),
    /* @__PURE__ */ jsxs17("label", { className: "field", children: [
      /* @__PURE__ */ jsx18("span", { className: "field-label", children: "What flows along it" }),
      /* @__PURE__ */ jsx18(CommitInput, { value: edge.data?.label ?? "", label: "Arrow label", placeholder: "e.g. REST, publishes events", maxLength: 120, onCommit: (label) => onChange({ label }) })
    ] }),
    /* @__PURE__ */ jsxs17("div", { className: "field", children: [
      /* @__PURE__ */ jsx18("span", { className: "field-label", children: "Joins" }),
      /* @__PURE__ */ jsxs17("div", { className: "edge-ends", children: [
        ends2("source"),
        /* @__PURE__ */ jsx18("button", { type: "button", className: "icon-btn", "aria-label": "Reverse direction", title: "Reverse direction", onClick: onReverse, children: "\u21C4" }),
        ends2("target")
      ] })
    ] }),
    /* @__PURE__ */ jsxs17("div", { className: "field-row", children: [
      /* @__PURE__ */ jsxs17("div", { className: "field-col", children: [
        /* @__PURE__ */ jsx18("span", { className: "field-label", children: "Line" }),
        /* @__PURE__ */ jsx18(
          Segmented,
          {
            label: "Line",
            value: edge.data?.dashed ? "dashed" : "solid",
            options: [
              ["solid", "Solid", "A connection that is always there"],
              ["dashed", "Dashed", "Optional, async or future"]
            ],
            onChange: (v) => onChange({ dashed: v === "dashed" })
          }
        )
      ] }),
      /* @__PURE__ */ jsxs17("div", { className: "field-col", children: [
        /* @__PURE__ */ jsx18("span", { className: "field-label", children: "Arrowheads" }),
        /* @__PURE__ */ jsx18(
          Segmented,
          {
            label: "Arrowheads",
            value: edge.data?.arrows ?? "end",
            options: [
              ["end", "\u2192", "One way, from the first box to the second"],
              ["both", "\u2194", "Both ways"],
              ["none", "\u2014", "No direction"]
            ],
            onChange: (v) => onChange({ arrows: v === "end" ? void 0 : v })
          }
        )
      ] })
    ] }),
    /* @__PURE__ */ jsx18("p", { className: "panel-hint", children: "Or drag either end of the arrow on the canvas onto another box." }),
    /* @__PURE__ */ jsx18("footer", { className: "panel-foot", children: /* @__PURE__ */ jsx18("button", { type: "button", className: "link is-danger", onClick: onRemove, children: "Delete connection" }) })
  ] });
}
function SelectionPanel({
  nodes,
  edges,
  onKind,
  onCopy,
  onDuplicate,
  onRemove,
  onClose
}) {
  const kinds = new Set(nodes.map((n) => n.data.kind));
  const kind = kinds.size === 1 ? [...kinds][0] : null;
  return /* @__PURE__ */ jsxs17("div", { className: "arch-panel-body", "aria-label": "Details of the selection", children: [
    /* @__PURE__ */ jsxs17("header", { className: "panel-top", children: [
      /* @__PURE__ */ jsx18("span", { className: "panel-kicker", children: "Selection" }),
      /* @__PURE__ */ jsx18("span", { className: "spacer" }),
      /* @__PURE__ */ jsx18("button", { type: "button", className: "icon-btn is-tiny", "aria-label": "Clear selection", title: "Clear selection", onClick: onClose, children: "\xD7" })
    ] }),
    /* @__PURE__ */ jsxs17("p", { className: "panel-hint", children: [
      nodes.length,
      " box",
      nodes.length === 1 ? "" : "es",
      " and ",
      edges.length,
      " arrow",
      edges.length === 1 ? "" : "s",
      " selected."
    ] }),
    nodes.length > 0 && /* @__PURE__ */ jsxs17("div", { className: "field", children: [
      /* @__PURE__ */ jsx18("span", { className: "field-label", children: "Kind of every box" }),
      /* @__PURE__ */ jsx18(KindPicker, { value: kind, label: "Kind of every selected box", onChange: onKind })
    ] }),
    /* @__PURE__ */ jsxs17("div", { className: "row-actions", children: [
      nodes.length > 0 && /* @__PURE__ */ jsxs17(Fragment4, { children: [
        /* @__PURE__ */ jsx18("button", { type: "button", className: "btn btn-sm", onClick: onCopy, title: "\u2318/Ctrl+C", children: "Copy" }),
        /* @__PURE__ */ jsx18("button", { type: "button", className: "btn btn-sm", onClick: onDuplicate, title: "\u2318/Ctrl+D", children: "Duplicate" })
      ] }),
      /* @__PURE__ */ jsx18("button", { type: "button", className: "btn btn-sm btn-danger", onClick: onRemove, children: "Delete selection" })
    ] })
  ] });
}
function ReadOnlyPanel({
  nodes,
  edges,
  selectedNodes,
  selectedEdges,
  plan,
  onSelect,
  onClose
}) {
  const name = (id) => nodes.find((n) => n.id === id)?.data.label ?? id;
  const close = /* @__PURE__ */ jsx18("button", { type: "button", className: "icon-btn is-tiny", "aria-label": "Close details", title: "Back to the diagram", onClick: onClose, children: "\xD7" });
  if (selectedNodes.length === 1 && selectedEdges.length === 0) {
    const node = selectedNodes[0];
    const outgoing = edges.filter((e) => e.source === node.id);
    const incoming = edges.filter((e) => e.target === node.id && e.source !== node.id);
    const tasks = (node.data.taskIds ?? []).map((id) => plan.tasks.find((t) => t.id === id)).filter((t) => t !== void 0);
    return /* @__PURE__ */ jsxs17("div", { className: "arch-panel-body is-readonly", "aria-label": `Details of ${node.data.label}`, children: [
      /* @__PURE__ */ jsxs17("header", { className: "panel-top", children: [
        /* @__PURE__ */ jsx18("span", { className: classNames("kind-swatch", `kind-${node.data.kind}`), "aria-hidden": "true", children: KIND_GLYPH[node.data.kind] }),
        /* @__PURE__ */ jsx18("span", { className: "panel-kicker", children: KIND_LABEL[node.data.kind] }),
        /* @__PURE__ */ jsx18("span", { className: "item-id", children: node.id }),
        /* @__PURE__ */ jsx18("span", { className: "spacer" }),
        close
      ] }),
      /* @__PURE__ */ jsx18("h2", { className: "panel-title", children: node.data.label }),
      node.data.detail && /* @__PURE__ */ jsx18("p", { className: "panel-hint", children: node.data.detail }),
      node.data.description && /* @__PURE__ */ jsxs17("div", { className: "field", children: [
        /* @__PURE__ */ jsx18("span", { className: "field-label", children: "Description" }),
        /* @__PURE__ */ jsx18(Markdown, { source: node.data.description })
      ] }),
      node.data.notes && /* @__PURE__ */ jsxs17("div", { className: "field", children: [
        /* @__PURE__ */ jsx18("span", { className: "field-label", children: "Notes and decisions" }),
        /* @__PURE__ */ jsx18(Markdown, { source: node.data.notes })
      ] }),
      /* @__PURE__ */ jsxs17("div", { className: "field", children: [
        /* @__PURE__ */ jsx18("span", { className: "field-label", children: "Built by" }),
        tasks.length ? /* @__PURE__ */ jsx18("ul", { className: "panel-tasks", children: tasks.map((task) => /* @__PURE__ */ jsxs17("li", { children: [
          /* @__PURE__ */ jsx18("span", { className: classNames("status-dot is-static", `is-${task.status}`), title: STATUS_LABEL[task.status], "aria-label": STATUS_LABEL[task.status], children: STATUS_GLYPH[task.status] }),
          /* @__PURE__ */ jsx18("button", { type: "button", className: "link panel-task", title: "Show it on the board", onClick: () => store.focus("task", task.id), children: task.title })
        ] }, task.id)) }) : /* @__PURE__ */ jsx18("p", { className: "muted panel-empty", children: "No tasks are linked to this part." })
      ] }),
      outgoing.length + incoming.length > 0 && /* @__PURE__ */ jsxs17("div", { className: "field", children: [
        /* @__PURE__ */ jsx18("span", { className: "field-label", children: "Connections" }),
        /* @__PURE__ */ jsxs17("ul", { className: "panel-links", children: [
          outgoing.map((e) => /* @__PURE__ */ jsxs17("li", { children: [
            /* @__PURE__ */ jsxs17("button", { type: "button", className: "link", onClick: () => onSelect("edge", e.id), children: [
              e.data?.arrows === "both" ? "\u2194" : "\u2192",
              " ",
              name(e.target)
            ] }),
            e.data?.label && /* @__PURE__ */ jsxs17("span", { className: "muted", children: [
              " ",
              e.data.label
            ] })
          ] }, e.id)),
          incoming.map((e) => /* @__PURE__ */ jsxs17("li", { children: [
            /* @__PURE__ */ jsxs17("button", { type: "button", className: "link", onClick: () => onSelect("edge", e.id), children: [
              e.data?.arrows === "both" ? "\u2194" : "\u2190",
              " ",
              name(e.source)
            ] }),
            e.data?.label && /* @__PURE__ */ jsxs17("span", { className: "muted", children: [
              " ",
              e.data.label
            ] })
          ] }, e.id))
        ] })
      ] })
    ] });
  }
  if (selectedEdges.length === 1 && selectedNodes.length === 0) {
    const edge = selectedEdges[0];
    const how = edge.data?.arrows === "both" ? "both ways" : edge.data?.arrows === "none" ? "no direction" : "one way";
    return /* @__PURE__ */ jsxs17("div", { className: "arch-panel-body is-readonly", "aria-label": "Details of the connection", children: [
      /* @__PURE__ */ jsxs17("header", { className: "panel-top", children: [
        /* @__PURE__ */ jsx18("span", { className: "panel-kicker", children: "Connection" }),
        /* @__PURE__ */ jsx18("span", { className: "spacer" }),
        close
      ] }),
      /* @__PURE__ */ jsxs17("h2", { className: "panel-title", children: [
        /* @__PURE__ */ jsx18("button", { type: "button", className: "link", onClick: () => onSelect("node", edge.source), children: name(edge.source) }),
        " ",
        edge.data?.arrows === "both" ? "\u2194" : edge.data?.arrows === "none" ? "\u2014" : "\u2192",
        " ",
        /* @__PURE__ */ jsx18("button", { type: "button", className: "link", onClick: () => onSelect("node", edge.target), children: name(edge.target) })
      ] }),
      /* @__PURE__ */ jsxs17("p", { className: "panel-hint", children: [
        edge.data?.label ? `Carries: ${edge.data.label}. ` : "",
        edge.data?.dashed ? "Dashed: optional, async or later. " : "",
        how[0].toUpperCase() + how.slice(1),
        "."
      ] })
    ] });
  }
  return /* @__PURE__ */ jsxs17("div", { className: "arch-panel-body is-readonly", "aria-label": "Selection", children: [
    /* @__PURE__ */ jsxs17("header", { className: "panel-top", children: [
      /* @__PURE__ */ jsx18("span", { className: "panel-kicker", children: "Selection" }),
      /* @__PURE__ */ jsx18("span", { className: "spacer" }),
      close
    ] }),
    /* @__PURE__ */ jsxs17("p", { className: "panel-hint", children: [
      selectedNodes.length,
      " box",
      selectedNodes.length === 1 ? "" : "es",
      " and ",
      selectedEdges.length,
      " arrow",
      selectedEdges.length === 1 ? "" : "s",
      " selected. Select one to read about it."
    ] })
  ] });
}
var init_Panels = __esm({
  "src/ui/components/flow/Panels.tsx"() {
    "use strict";
    init_store();
    init_Editable();
    init_Markdown();
    init_Progress();
    init_format();
    init_plan();
    init_types();
    init_shared();
  }
});

// src/ui/components/flow/ContextMenu.tsx
import { useEffect as useEffect12, useLayoutEffect as useLayoutEffect2, useRef as useRef7, useState as useState14 } from "react";
import { jsx as jsx19, jsxs as jsxs18 } from "react/jsx-runtime";
function ContextMenu({
  at,
  title,
  entries,
  onClose
}) {
  const menu = useRef7(null);
  const [stack, setStack] = useState14([]);
  const [place, setPlace] = useState14(at);
  const view = stack.at(-1) ?? { title, entries };
  useLayoutEffect2(() => {
    const el = menu.current;
    const frame = el?.parentElement?.getBoundingClientRect();
    if (!el || !frame) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    setPlace({
      x: Math.max(4, at.x + w > frame.width - 4 ? at.x - w : at.x),
      y: Math.max(4, at.y + h > frame.height - 4 ? Math.max(4, frame.height - h - 4) : at.y)
    });
  }, [at.x, at.y, stack.length]);
  useEffect12(() => {
    items(menu.current)[0]?.focus();
  }, [stack.length]);
  useEffect12(() => {
    const away = (e) => {
      if (!menu.current?.contains(e.target)) onClose();
    };
    document.addEventListener("pointerdown", away, true);
    window.addEventListener("blur", onClose);
    return () => {
      document.removeEventListener("pointerdown", away, true);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);
  const onKeyDown = (e) => {
    e.stopPropagation();
    const list = items(menu.current);
    const at2 = list.indexOf(document.activeElement);
    const go = (i) => list[(i + list.length) % list.length]?.focus();
    if (e.key === "ArrowDown") {
      e.preventDefault();
      go(at2 + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      go(at2 - 1);
    } else if (e.key === "Home") {
      e.preventDefault();
      go(0);
    } else if (e.key === "End") {
      e.preventDefault();
      go(list.length - 1);
    } else if (e.key === "Escape" || e.key === "ArrowLeft" && stack.length) {
      e.preventDefault();
      if (stack.length) setStack((s) => s.slice(0, -1));
      else onClose();
    } else if (e.key === "Tab") {
      e.preventDefault();
      go(at2 + (e.shiftKey ? -1 : 1));
    }
  };
  const choose = (fn) => {
    onClose();
    fn();
  };
  return /* @__PURE__ */ jsxs18(
    "div",
    {
      ref: menu,
      className: "flow-menu nodrag nopan nowheel",
      role: "menu",
      "aria-label": view.title,
      style: { left: place.x, top: place.y },
      onKeyDown,
      onContextMenu: (e) => e.preventDefault(),
      children: [
        /* @__PURE__ */ jsxs18("div", { className: "flow-menu-title", children: [
          stack.length > 0 && /* @__PURE__ */ jsx19("button", { type: "button", role: "menuitem", className: "flow-menu-back", "aria-label": "Back", onClick: () => setStack((s) => s.slice(0, -1)), children: "\u2039" }),
          /* @__PURE__ */ jsx19("span", { children: view.title })
        ] }),
        view.entries.map((entry, i) => {
          switch (entry.kind) {
            case "separator":
              return /* @__PURE__ */ jsx19("div", { className: "flow-menu-sep", role: "separator" }, i);
            case "heading":
              return /* @__PURE__ */ jsx19("div", { className: "flow-menu-heading", role: "presentation", children: entry.label }, i);
            case "item":
              return /* @__PURE__ */ jsxs18(
                "button",
                {
                  type: "button",
                  role: "menuitem",
                  className: classNames("flow-menu-item", entry.danger && "is-danger"),
                  disabled: entry.disabled,
                  onClick: () => choose(entry.onSelect),
                  children: [
                    /* @__PURE__ */ jsx19("span", { className: "flow-menu-label", children: entry.label }),
                    entry.hint && /* @__PURE__ */ jsx19("kbd", { className: "flow-menu-hint", children: entry.hint })
                  ]
                },
                i
              );
            case "check":
              return /* @__PURE__ */ jsxs18("button", { type: "button", role: "menuitemcheckbox", "aria-checked": entry.checked, className: "flow-menu-item", onClick: () => choose(entry.onSelect), children: [
                /* @__PURE__ */ jsx19("span", { className: "flow-menu-check", "aria-hidden": "true", children: entry.checked ? "\u2713" : "" }),
                /* @__PURE__ */ jsx19("span", { className: "flow-menu-label", children: entry.label })
              ] }, i);
            case "choices":
              return /* @__PURE__ */ jsxs18("div", { className: "flow-menu-choices", role: "group", "aria-label": entry.label, children: [
                /* @__PURE__ */ jsx19("span", { className: "flow-menu-heading", children: entry.label }),
                /* @__PURE__ */ jsx19("div", { className: "flow-menu-choice-row", children: entry.options.map((o) => /* @__PURE__ */ jsx19(
                  "button",
                  {
                    type: "button",
                    role: "menuitemradio",
                    "aria-checked": Boolean(o.active),
                    "aria-label": o.label,
                    title: o.label,
                    className: classNames("flow-menu-choice", o.className, o.active && "is-active"),
                    onClick: () => choose(() => entry.onSelect(o.value)),
                    children: o.content
                  },
                  o.value
                )) })
              ] }, i);
            case "submenu":
              return /* @__PURE__ */ jsxs18(
                "button",
                {
                  type: "button",
                  role: "menuitem",
                  "aria-haspopup": "menu",
                  className: "flow-menu-item",
                  onClick: () => setStack((s) => [...s, { title: entry.label, entries: entry.entries }]),
                  onKeyDown: (e) => {
                    if (e.key === "ArrowRight") {
                      e.preventDefault();
                      setStack((s) => [...s, { title: entry.label, entries: entry.entries }]);
                    }
                  },
                  children: [
                    /* @__PURE__ */ jsx19("span", { className: "flow-menu-label", children: entry.label }),
                    entry.hint && /* @__PURE__ */ jsx19("kbd", { className: "flow-menu-hint", children: entry.hint }),
                    /* @__PURE__ */ jsx19("span", { className: "flow-menu-more", "aria-hidden": "true", children: "\u203A" })
                  ]
                },
                i
              );
          }
        })
      ]
    }
  );
}
function items(root) {
  if (!root) return [];
  return [...root.querySelectorAll('[role="menuitem"]:not(:disabled), [role="menuitemradio"], [role="menuitemcheckbox"]')].sort(
    (a, b) => a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
  );
}
var init_ContextMenu = __esm({
  "src/ui/components/flow/ContextMenu.tsx"() {
    "use strict";
    init_format();
  }
});

// src/ui/components/flow/Shortcuts.tsx
import { useEffect as useEffect13, useRef as useRef8 } from "react";
import { jsx as jsx20, jsxs as jsxs19 } from "react/jsx-runtime";
function ShortcutsOverlay({ onClose }) {
  const panel = useRef8(null);
  useEffect13(() => {
    const before = document.activeElement;
    panel.current?.focus();
    return () => before?.focus?.();
  }, []);
  return /* @__PURE__ */ jsx20(
    "div",
    {
      className: "flow-shortcuts-backdrop",
      onPointerDown: (e) => {
        if (e.target === e.currentTarget) onClose();
      },
      children: /* @__PURE__ */ jsxs19(
        "div",
        {
          ref: panel,
          className: "flow-shortcuts",
          role: "dialog",
          "aria-modal": "true",
          "aria-label": "Keyboard shortcuts",
          tabIndex: -1,
          onKeyDown: (e) => {
            e.stopPropagation();
            if (e.key === "Escape" || e.key === "?") {
              e.preventDefault();
              onClose();
            }
          },
          children: [
            /* @__PURE__ */ jsxs19("header", { className: "flow-shortcuts-head", children: [
              /* @__PURE__ */ jsx20("h2", { children: "Shortcuts" }),
              /* @__PURE__ */ jsx20("button", { type: "button", className: "icon-btn is-tiny", "aria-label": "Close shortcuts", onClick: onClose, children: "\xD7" })
            ] }),
            /* @__PURE__ */ jsx20("div", { className: "flow-shortcuts-groups", children: SHORTCUTS.map((g) => /* @__PURE__ */ jsxs19("section", { children: [
              /* @__PURE__ */ jsx20("h3", { children: g.group }),
              /* @__PURE__ */ jsx20("dl", { children: g.keys.map(([keys, what]) => /* @__PURE__ */ jsxs19("div", { className: "flow-shortcut", children: [
                /* @__PURE__ */ jsx20("dt", { children: /* @__PURE__ */ jsx20("kbd", { children: keys }) }),
                /* @__PURE__ */ jsx20("dd", { children: what })
              ] }, keys)) })
            ] }, g.group)) })
          ]
        }
      )
    }
  );
}
var MOD, ALT, SHORTCUTS;
var init_Shortcuts = __esm({
  "src/ui/components/flow/Shortcuts.tsx"() {
    "use strict";
    MOD = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? "\u2318" : "Ctrl+";
    ALT = MOD === "\u2318" ? "\u2325" : "Alt+";
    SHORTCUTS = [
      {
        group: "Add",
        keys: [
          ["Double-click or right-click empty canvas", "a box there"],
          ["Tab", "a box after the selected one, connected"],
          ["\u21E7Tab", "a box before it, connected"],
          ["Enter", "a box beside it, from the same boxes"],
          ["Drag from a box\u2019s edge into space", "a connected box there"]
        ]
      },
      {
        group: "Connect",
        keys: [
          ["Drag from a box\u2019s edge onto a box", "connect them"],
          ["Drag an arrow\u2019s end grip", "move that end to another box"],
          ["Drop an unconnected box on an arrow", "put it into the arrow"]
        ]
      },
      {
        group: "Edit",
        keys: [
          ["Type on a selected box", "rename it"],
          ["F2 or double-click", "rename a box or an arrow"],
          [`${MOD}C  ${MOD}X  ${MOD}V`, "copy, cut, paste"],
          [`${MOD}D`, "duplicate"],
          ["\u232B", "delete"],
          [`${ALT}\u232B`, "delete, keeping the flow through it"],
          [`${MOD}Z  \u21E7${MOD}Z`, "undo, redo"],
          ["Right-click, or \u21E7F10", "everything you can do to it"]
        ]
      },
      {
        group: "Select and move",
        keys: [
          ["Click / \u21E7-drag", "select one / select an area"],
          [`${MOD}A`, "select everything"],
          ["Arrow keys", "nudge the selection"],
          ["Hover or select a box", "see what it connects to"],
          [ALT === "\u2325" ? "Hold \u2325" : "Hold Alt", "see two steps out"],
          ["Esc", "clear the selection"]
        ]
      },
      {
        group: "View",
        keys: [
          ["\u21E71", "fit the whole diagram"],
          ["\u21E72", "zoom to the selection"],
          ["Space-drag", "pan"],
          ["?", "these shortcuts"]
        ]
      }
    ];
  }
});

// src/ui/components/flow/convert.ts
import { MarkerType } from "@xyflow/react";
function toFlow(diagram, plan) {
  const layout = resolveLayout(diagram);
  const nodes = diagram.nodes.map((n) => ({
    id: n.id,
    type: "plan",
    position: layout.positions.get(n.id) ?? { x: 0, y: 0 },
    data: {
      ...sized({
        label: n.label,
        kind: n.kind,
        ...n.detail ? { detail: n.detail } : {},
        ...n.description ? { description: n.description } : {},
        ...n.notes ? { notes: n.notes } : {},
        ...n.taskIds?.length ? { taskIds: n.taskIds } : {},
        width: 0,
        height: 0
      }),
      ...progressOf(plan, n.taskIds)
    }
  }));
  const edges = diagram.edges.map((e) => withRoute(makeEdge(e), layout));
  return { nodes, edges };
}
function signatureOf(d) {
  return JSON.stringify([d.nodes, d.edges, d.direction]);
}
function makeEdge(e, selected) {
  const arrows = e.arrows === "both" || e.arrows === "none" ? e.arrows : void 0;
  const marker = { type: MarkerType.ArrowClosed, width: 16, height: 16 };
  return {
    id: e.id,
    source: e.source,
    target: e.target,
    type: "plan",
    data: {
      ...e.label ? { label: e.label } : {},
      ...e.dashed ? { dashed: true } : {},
      ...arrows ? { arrows } : {},
      ...e.route ? { route: e.route } : {}
    },
    ...arrows !== "none" ? { markerEnd: marker } : {},
    ...arrows === "both" ? { markerStart: marker } : {},
    className: classNames(e.dashed && "is-dashed"),
    ...e.dashed ? { style: { strokeDasharray: "6 4" } } : {},
    ...selected ? { selected } : {}
  };
}
function withRoute(edge, layout) {
  const route = layout.routes.get(edge.id);
  const data = { ...edge.data };
  if (route) data.route = route;
  else delete data.route;
  return { ...edge, data };
}
function keepRoutes(prev, next, nodes) {
  const at = new Map(nodes.map((n) => [n.id, n.position]));
  return next.map((e) => {
    if (e.data?.route) return e;
    const old = prev.find((p) => p.id === e.id && p.source === e.source && p.target === e.target)?.data?.route;
    if (old && samePoint(at.get(e.source), old.from) && samePoint(at.get(e.target), old.to)) return { ...e, data: { ...e.data, route: old } };
    return e;
  });
}
function keepSelection(prev, next) {
  const selected = new Set(prev.filter((x) => x.selected).map((x) => x.id));
  return next.map((x) => selected.has(x.id) ? { ...x, selected: true } : x);
}
function sized(data) {
  const { width, height } = nodeSize(data);
  return { ...data, width, height };
}
function contentOf(d) {
  return {
    label: d.label,
    kind: d.kind,
    ...d.detail ? { detail: d.detail } : {},
    ...d.description ? { description: d.description } : {},
    ...d.notes ? { notes: d.notes } : {},
    ...d.taskIds?.length ? { taskIds: d.taskIds } : {}
  };
}
function edgeContent(d) {
  return { ...d?.label ? { label: d.label } : {}, ...d?.dashed ? { dashed: true } : {}, ...d?.arrows ? { arrows: d.arrows } : {} };
}
function graphOf(ns, es) {
  return {
    nodes: ns.map((n) => ({ id: n.id, ...contentOf(n.data) })),
    edges: es.map((e) => ({ id: e.id, source: e.source, target: e.target, ...e.data?.label ? { label: e.data.label } : {} }))
  };
}
function positionsOf(ns) {
  return new Map(ns.map((n) => [n.id, n.position]));
}
function sizesOf(ns) {
  return new Map(ns.map((n) => [n.id, { width: n.data.width, height: n.data.height }]));
}
function freeEdgeId(edges, source, target) {
  let id = `${source}->${target}`;
  for (let n = 2; edges.some((e) => e.id === id); n++) id = `${source}->${target}#${n}`;
  return id;
}
function round(p) {
  return { x: Math.round(p.x), y: Math.round(p.y) };
}
function progressOf(plan, taskIds) {
  if (!taskIds?.length) return { progress: void 0 };
  const seen = /* @__PURE__ */ new Map();
  for (const id of taskIds) {
    const task = plan.tasks.find((t) => t.id === id);
    if (!task) continue;
    seen.set(task.id, task);
    for (const d of descendants(plan, task.id)) seen.set(d.id, d);
  }
  if (seen.size === 0) return { progress: void 0 };
  return { progress: countTasks({ tasks: [...seen.values()] }) };
}
var init_convert = __esm({
  "src/ui/components/flow/convert.ts"() {
    "use strict";
    init_layout();
    init_format();
    init_plan();
  }
});

// src/ui/components/FlowCanvas.tsx
import { useCallback, useEffect as useEffect14, useMemo as useMemo2, useRef as useRef9, useState as useState15 } from "react";
import {
  Background,
  ConnectionMode,
  Controls,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow
} from "@xyflow/react";
import { jsx as jsx21, jsxs as jsxs20 } from "react/jsx-runtime";
function DiagramEditor(props) {
  return /* @__PURE__ */ jsx21(ReactFlowProvider, { children: /* @__PURE__ */ jsx21(Editor, { ...props }) });
}
function Editor({
  diagram,
  plan,
  onSave,
  aside,
  readOnly = false
}) {
  const theme = useResolvedTheme();
  const flow = useReactFlow();
  const wrapper = useRef9(null);
  const [initial2] = useState15(() => toFlow(diagram, plan));
  const [nodes, setNodes] = useState15(initial2.nodes);
  const [edges, setEdges] = useState15(initial2.edges);
  const [editing, setEditingState] = useState15(null);
  const [editSeed, setEditSeed] = useState15(null);
  const [hoverNode, setHoverNode] = useState15(null);
  const [hoverEdgeId, setHoverEdgeId] = useState15(null);
  const [twoHops, setTwoHops] = useState15(false);
  const [menu, setMenu] = useState15(null);
  const [shortcuts, setShortcuts] = useState15(false);
  const [reconnect, setReconnect] = useState15(null);
  const [dropEdge, setDropEdge] = useState15(null);
  const [, setHistoryTick] = useState15(0);
  const nodesRef = useRef9(nodes);
  const edgesRef = useRef9(edges);
  nodesRef.current = nodes;
  edgesRef.current = edges;
  const planRef = useRef9(plan);
  planRef.current = plan;
  const readOnlyRef = useRef9(readOnly);
  readOnlyRef.current = readOnly;
  const dragging = useRef9(false);
  const queue = useRef9({ pending: null, busy: false });
  const pointer = useRef9(null);
  const pastes = useRef9(0);
  const setEditing = useCallback((key, seed = null) => {
    setEditSeed(seed);
    setEditingState(key);
  }, []);
  const signature = useMemo2(() => signatureOf(diagram), [diagram]);
  const loaded = useRef9(signature);
  const nudge = useRef9(void 0);
  const baseRev = useRef9(diagram.rev);
  const history = useRef9(new History());
  const current = useRef9({ nodes: initial2.nodes, edges: initial2.edges, direction: diagram.direction });
  const currentKey = useRef9(JSON.stringify(patchOf(initial2.nodes, initial2.edges, diagram.direction)));
  const ownRevs = useRef9(/* @__PURE__ */ new Set([diagram.rev]));
  const historyLost = useRef9(false);
  const bumpHistory = () => setHistoryTick((n) => n + 1);
  const load = useCallback((source, p) => {
    const next = toFlow(source, p);
    const ns = keepSelection(nodesRef.current, next.nodes);
    const es = keepRoutes(edgesRef.current, keepSelection(edgesRef.current, next.edges), next.nodes);
    setNodes(ns);
    setEdges(es);
    baseRev.current = source.rev;
    loaded.current = signatureOf(source);
    current.current = { nodes: ns, edges: es, direction: source.direction };
    currentKey.current = JSON.stringify(patchOf(ns, es, source.direction));
    if (!ownRevs.current.has(source.rev)) {
      if (history.current.canUndo || history.current.canRedo) historyLost.current = true;
      history.current.clear();
      setHistoryTick((n) => n + 1);
    }
  }, []);
  useEffect14(() => {
    if (dragging.current || nudge.current !== void 0 || queue.current.busy || queue.current.pending) return;
    if (loaded.current !== signature) load(diagram, plan);
    else baseRev.current = diagram.rev;
  }, [signature, diagram.rev]);
  const progressKey = useMemo2(() => JSON.stringify(plan.tasks.map((t) => [t.id, t.status, t.parentId])), [plan.tasks]);
  useEffect14(() => {
    setNodes((ns) => ns.map((n) => ({ ...n, data: { ...n.data, ...progressOf(plan, n.data.taskIds) } })));
  }, [progressKey]);
  const focusTarget = useStore((s) => s.focusTarget);
  useEffect14(() => {
    const prefix = `node:${diagram.id}:`;
    if (!focusTarget?.startsWith(prefix)) return;
    const id = focusTarget.slice(prefix.length);
    setNodes((ns) => ns.map((n) => ({ ...n, selected: n.id === id })));
    setEdges((es) => es.map((e) => ({ ...e, selected: false })));
    window.requestAnimationFrame(() => void flow.fitView({ nodes: [{ id }], padding: 1.2, duration: 250, maxZoom: 1.2 }));
    store.set({ focusTarget: null });
  }, [focusTarget, diagram.id, flow]);
  const latest = () => store.getState().session?.plan?.diagrams.find((d) => d.id === diagram.id);
  const resyncFromServer = useCallback(() => {
    const p = store.getState().session?.plan;
    const now = p?.diagrams.find((d) => d.id === diagram.id);
    if (p && now) load(now, p);
  }, [diagram.id, load]);
  const flush = useCallback(async () => {
    const q = queue.current;
    if (q.busy) return;
    q.busy = true;
    try {
      while (q.pending) {
        const patch = q.pending;
        q.pending = null;
        const savedRev = await onSave({ ...patch, expect: baseRev.current });
        if (savedRev !== null) {
          baseRev.current = savedRev;
          ownRevs.current.add(savedRev);
        } else {
          q.pending = null;
          resyncFromServer();
        }
      }
    } finally {
      q.busy = false;
    }
    const now = latest();
    if (now && now.rev !== baseRev.current) resyncFromServer();
  }, [onSave, resyncFromServer]);
  const persist = useCallback(
    (ns, es, direction, opts = {}) => {
      if (readOnlyRef.current) return;
      const dir = direction ?? current.current.direction;
      const patch = patchOf(ns, es, dir);
      const key = JSON.stringify(patch);
      if (key === currentKey.current && !queue.current.pending) return;
      if (opts.record !== false) {
        history.current.record(current.current);
        historyLost.current = false;
        bumpHistory();
      }
      current.current = { nodes: ns, edges: es, direction: dir };
      currentKey.current = key;
      const superseded = queue.current.pending;
      const { direction: _dir, ...graph } = patch;
      const flowDir = direction ?? superseded?.direction;
      queue.current.pending = { ...graph, ...flowDir ? { direction: flowDir } : {} };
      void flush();
    },
    [flush]
  );
  const commit = useCallback(
    (ns, es, direction) => {
      setNodes(ns);
      setEdges(es);
      persist(ns, es, direction);
    },
    [persist]
  );
  const restore = useCallback(
    (snap) => {
      const selected = new Set(nodesRef.current.filter((n) => n.selected).map((n) => n.id));
      const ns = snap.nodes.map((n) => ({
        ...n,
        selected: selected.has(n.id),
        // Progress moves on whatever is undone; show it as it is now.
        data: { ...n.data, ...progressOf(planRef.current, n.data.taskIds) }
      }));
      const es = snap.edges.map((e) => ({ ...e, selected: false }));
      setNodes(ns);
      setEdges(es);
      setEditing(null);
      persist(ns, es, snap.direction !== current.current.direction ? snap.direction : void 0, { record: false });
      bumpHistory();
    },
    [persist, setEditing]
  );
  const undo = useCallback(() => {
    const before = history.current.undo(current.current);
    if (before) return restore(before);
    store.toast(
      "info",
      historyLost.current ? "Nothing to undo: this diagram was changed elsewhere since your last edit, and undoing past that would revert it." : "Nothing to undo."
    );
  }, [restore]);
  const redo = useCallback(() => {
    const after2 = history.current.redo(current.current);
    if (after2) restore(after2);
  }, [restore]);
  const onNodesChange = useCallback(
    (all) => {
      const changes = readOnlyRef.current ? all.filter((c) => c.type !== "position" && c.type !== "remove") : all;
      if (changes.length === 0) return;
      setNodes((ns) => applyNodeChanges(changes, ns));
      if (dragging.current || !changes.some((c) => c.type === "position" && c.position && !c.dragging)) return;
      window.clearTimeout(nudge.current);
      nudge.current = window.setTimeout(() => {
        nudge.current = void 0;
        persist(nodesRef.current, edgesRef.current);
      }, 300);
    },
    [persist]
  );
  const persistRef = useRef9(persist);
  persistRef.current = persist;
  useEffect14(
    () => () => {
      if (nudge.current === void 0) return;
      window.clearTimeout(nudge.current);
      nudge.current = void 0;
      persistRef.current(nodesRef.current, edgesRef.current);
    },
    []
  );
  const onEdgesChange = useCallback(
    (all) => {
      const changes = readOnlyRef.current ? all.filter((c) => c.type !== "remove") : all;
      if (changes.length) setEdges((es) => applyEdgeChanges(changes, es));
    },
    []
  );
  const connect = useCallback(
    (source, target, base = edgesRef.current, ns = nodesRef.current) => {
      if (source === target || base.some((e) => e.source === source && e.target === target)) return false;
      commit(ns, [...base, makeEdge({ id: freeEdgeId(base, source, target), source, target })]);
      return true;
    },
    [commit]
  );
  const onConnect = useCallback((conn) => conn.source && conn.target && connect(conn.source, conn.target), [connect]);
  const reveal = useCallback(
    (id) => {
      window.requestAnimationFrame(() => {
        const node = flow.getInternalNode(id);
        const rect = wrapper.current?.getBoundingClientRect();
        if (!node || !rect?.width) return;
        const { x, y, zoom } = flow.getViewport();
        const w = node.measured.width ?? node.data.width;
        const h = node.measured.height ?? node.data.height;
        const sx = node.internals.positionAbsolute.x * zoom + x;
        const sy = node.internals.positionAbsolute.y * zoom + y;
        if (sx < 0 || sy < 0 || sx + w * zoom > rect.width || sy + h * zoom > rect.height) {
          void flow.setCenter(node.internals.positionAbsolute.x + w / 2, node.internals.positionAbsolute.y + h / 2, { zoom, duration: 200 });
        }
      });
    },
    [flow]
  );
  const newId = () => {
    const ns = nodesRef.current;
    let k = ns.length + 1;
    while (ns.some((x) => x.id === `n${k}`)) k++;
    return `n${k}`;
  };
  const addNode = useCallback(
    (kind, opts = {}) => {
      const ns = nodesRef.current;
      const id = newId();
      const data = sized({ label: `New ${KIND_LABEL[kind].toLowerCase()}`, kind, width: 0, height: 0 });
      const lr = diagram.direction === "LR";
      const anchor = opts.near && ns.find((n) => n.id === opts.near.id);
      let want;
      if (opts.at) want = { x: opts.at.x - data.width / 2, y: opts.at.y - data.height / 2 };
      else if (anchor) {
        const { x, y } = anchor.position;
        const { width: w, height: h } = anchor.data;
        const gap = 90;
        want = {
          after: lr ? { x: x + w + gap, y } : { x, y: y + h + gap },
          before: lr ? { x: x - gap - data.width, y } : { x, y: y - gap - data.height },
          beside: lr ? { x, y: y + h + 40 } : { x: x + w + 50, y }
        }[opts.near.where];
      } else {
        const rect = wrapper.current?.getBoundingClientRect();
        const c = rect ? flow.screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }) : { x: 0, y: 0 };
        want = { x: c.x - data.width / 2, y: c.y - data.height / 2 };
      }
      const position = opts.at ? round(want) : findFreeSpot(want, data, positionsOf(ns), sizesOf(ns), lr);
      const node = { id, type: "plan", position, data, selected: true };
      const nextNodes = [...ns.map((x) => x.selected ? { ...x, selected: false } : x), node];
      let nextEdges = edgesRef.current.map((e) => e.selected ? { ...e, selected: false } : e);
      for (const s of opts.from ?? []) nextEdges = [...nextEdges, makeEdge({ id: freeEdgeId(nextEdges, s, id), source: s, target: id })];
      for (const t of opts.to ?? []) nextEdges = [...nextEdges, makeEdge({ id: freeEdgeId(nextEdges, id, t), source: id, target: t })];
      commit(nextNodes, nextEdges);
      setEditing(`node:${id}`);
      reveal(id);
      return id;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- newId reads live state through refs
    [commit, diagram.direction, flow, reveal, setEditing]
  );
  const addAfter = useCallback((id) => addNode("component", { near: { id, where: "after" }, from: [id] }), [addNode]);
  const addBefore = useCallback((id) => addNode("component", { near: { id, where: "before" }, to: [id] }), [addNode]);
  const addBeside = useCallback(
    (id) => {
      const node = nodesRef.current.find((n) => n.id === id);
      if (!node) return;
      const parents = [...new Set(edgesRef.current.filter((e) => e.target === id && e.source !== id).map((e) => e.source))];
      addNode(node.data.kind === "note" ? "component" : node.data.kind, { near: { id, where: "beside" }, from: parents });
    },
    [addNode]
  );
  const insertIntoEdge = useCallback(
    (edgeId, at) => {
      const edge = edgesRef.current.find((e) => e.id === edgeId);
      if (!edge) return;
      const id = newId();
      const data = sized({ label: "New component", kind: "component", width: 0, height: 0 });
      const node = { id, type: "plan", position: round({ x: at.x - data.width / 2, y: at.y - data.height / 2 }), data, selected: true };
      const ns = nodesRef.current.map((x) => x.selected ? { ...x, selected: false } : x);
      commit([...ns, node], spliced(edgesRef.current, edge, id));
      setEditing(`node:${id}`);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- newId reads live state through refs
    [commit, setEditing]
  );
  const onConnectEnd = useCallback(
    (event, state) => {
      if (state.isValid || !state.fromNode) return;
      const point = "changedTouches" in event ? event.changedTouches[0] : event;
      if (!point) return;
      const hit = document.elementFromPoint?.(point.clientX, point.clientY) ?? null;
      const onNode = hit?.closest(".react-flow__node")?.getAttribute("data-id");
      if (onNode) {
        if (onNode !== state.fromNode.id) connect(state.fromNode.id, onNode);
        return;
      }
      if (hit?.closest(".react-flow__pane")) {
        addNode("component", { at: flow.screenToFlowPosition({ x: point.clientX, y: point.clientY }), from: [state.fromNode.id] });
      }
    },
    [addNode, connect, flow]
  );
  const onDelete = useCallback(
    ({ nodes: gone, edges: cut }) => {
      const goneIds = new Set(gone.map((n) => n.id));
      const cutIds = new Set(cut.map((e) => e.id));
      commit(
        nodesRef.current.filter((n) => !goneIds.has(n.id)),
        edgesRef.current.filter((e) => !cutIds.has(e.id) && !goneIds.has(e.source) && !goneIds.has(e.target))
      );
    },
    [commit]
  );
  const removeKeepingFlow = useCallback(() => {
    const gone = new Set(nodesRef.current.filter((n) => n.selected).map((n) => n.id));
    const cut = new Set(edgesRef.current.filter((e) => e.selected).map((e) => e.id));
    if (!gone.size && !cut.size) return;
    const { kept, bridges } = bridgeOver(gone, edgesRef.current.filter((e) => !cut.has(e.id)).map(liteEdge));
    const keep = new Set(kept.map((k) => k.id));
    let es = edgesRef.current.filter((e) => keep.has(e.id));
    for (const b of bridges) es = [...es, makeEdge({ id: freeEdgeId(es, b.source, b.target), ...b })];
    commit(
      nodesRef.current.filter((n) => !gone.has(n.id)),
      es
    );
    if (bridges.length) store.toast("info", `Deleted, and joined ${bridges.length} connection${bridges.length === 1 ? "" : "s"} around it.`);
  }, [commit]);
  const onNodeDrag = useCallback((event, node, moving) => {
    const free = moving.length === 1 && !edgesRef.current.some((e) => e.source === node.id || e.target === node.id);
    const under = free ? document.elementsFromPoint?.(event.clientX, event.clientY) ?? [] : [];
    const hit = under.map((el) => el.closest(".react-flow__edge")?.getAttribute("data-id")).find(Boolean) ?? null;
    setDropEdge((was) => was === hit ? was : hit);
  }, []);
  const onDragStop = useCallback(
    (moved, into = null) => {
      dragging.current = false;
      setDropEdge(null);
      const at = new Map(moved.map((n) => [n.id, n.position]));
      const ns = nodesRef.current.map((n) => at.has(n.id) ? { ...n, position: at.get(n.id) } : n);
      const edge = into && edgesRef.current.find((e) => e.id === into);
      if (edge && moved.length === 1) commit(ns, spliced(edgesRef.current, edge, moved[0].id));
      else persist(ns, edgesRef.current);
    },
    [commit, persist]
  );
  const dropEdgeRef = useRef9(dropEdge);
  dropEdgeRef.current = dropEdge;
  const onNodeDragStop = useCallback((_, __, moved) => onDragStop(moved, dropEdgeRef.current), [onDragStop]);
  const onSelectionDragStop = useCallback((_, moved) => onDragStop(moved), [onDragStop]);
  const onDragStart = useCallback(() => {
    dragging.current = true;
    setMenu(null);
  }, []);
  const updateNodes = (ids, patch) => {
    const ns = nodesRef.current.map((n) => {
      if (!ids.has(n.id)) return n;
      const data = { ...n.data, ...patch };
      for (const key of ["detail", "description", "notes"]) if (!data[key]) delete data[key];
      return { ...n, data: { ...sized(data), ...progressOf(planRef.current, data.taskIds) } };
    });
    commit(ns, edgesRef.current);
  };
  const updateNode = (id, patch) => updateNodes(/* @__PURE__ */ new Set([id]), patch);
  const updateEdge = (id, patch) => {
    const es = edgesRef.current.map((e) => {
      if (e.id !== id) return e;
      const source = patch.source ?? e.source;
      const target = patch.target ?? e.target;
      const data = { ...e.data, ...patch };
      delete data.source;
      delete data.target;
      if (!data.label) delete data.label;
      if (!data.arrows) delete data.arrows;
      if (!data.dashed) delete data.dashed;
      if (source !== e.source || target !== e.target) delete data.route;
      return makeEdge({ id: e.id, source, target, ...data }, e.selected);
    });
    commit(nodesRef.current, es);
  };
  const updateEdgeRef = useRef9(updateEdge);
  updateEdgeRef.current = updateEdge;
  const reverseEdge = (id) => {
    const e = edgesRef.current.find((x) => x.id === id);
    if (e) updateEdge(id, { source: e.target, target: e.source });
  };
  const select = useCallback((kind, id) => {
    setNodes((ns) => ns.map((n) => ({ ...n, selected: kind === "node" && n.id === id })));
    setEdges((es) => es.map((e) => ({ ...e, selected: kind === "edge" && e.id === id })));
  }, []);
  const clearSelection = useCallback(() => {
    setNodes((ns) => ns.map((n) => n.selected ? { ...n, selected: false } : n));
    setEdges((es) => es.map((e) => e.selected ? { ...e, selected: false } : e));
  }, []);
  const selectAll = useCallback(() => {
    setNodes((ns) => ns.map((n) => ({ ...n, selected: true })));
    setEdges((es) => es.map((x) => ({ ...x, selected: true })));
  }, []);
  const removeSelected = useCallback(() => {
    void flow.deleteElements({ nodes: nodesRef.current.filter((n) => n.selected), edges: edgesRef.current.filter((e) => e.selected) });
  }, [flow]);
  const relayout = (direction) => {
    const at = autoLayout(graphOf(nodesRef.current, edgesRef.current), direction);
    const ns = nodesRef.current.map((n) => ({ ...n, position: at.positions.get(n.id) ?? n.position }));
    const es = edgesRef.current.map((e) => withRoute(e, at));
    commit(ns, es, direction);
    window.requestAnimationFrame(() => void flow.fitView(FIT));
  };
  const fitAll = useCallback(() => void flow.fitView({ ...FIT, duration: 200 }), [flow]);
  const fitSelection = useCallback(() => {
    const picked = nodesRef.current.filter((n) => n.selected);
    if (!picked.length) return fitAll();
    void flow.fitView({ nodes: picked.map((n) => ({ id: n.id })), padding: 0.5, maxZoom: 1.25, duration: 200 });
  }, [fitAll, flow]);
  const selectionClip = useCallback(() => {
    const picked = nodesRef.current.filter((n) => n.selected);
    return toClip(
      picked.map((n) => ({ id: n.id, ...contentOf(n.data), x: n.position.x, y: n.position.y })),
      edgesRef.current.map((e) => ({ source: e.source, target: e.target, ...edgeContent(e.data) }))
    );
  }, []);
  const paste = useCallback(
    (clip, where) => {
      const origin = clipOrigin(clip);
      pastes.current += 1;
      const step = 32 * pastes.current;
      const point = where === "pointer" ? pointer.current : where === "offset" ? null : where;
      const at = point ? { x: point.x - origin.x, y: point.y - origin.y } : { x: step, y: step };
      const tasks = new Set(planRef.current.tasks.map((t) => t.id));
      const made = pasteClip(clip, nodesRef.current.map((n) => n.id), tasks, at);
      const newNodes = made.nodes.map(({ id, x, y, ...content }) => ({
        id,
        type: "plan",
        position: { x, y },
        data: { ...sized({ ...content, width: 0, height: 0 }), ...progressOf(planRef.current, content.taskIds) },
        selected: true
      }));
      const base = edgesRef.current.map((e) => e.selected ? { ...e, selected: false } : e);
      const newEdges = made.edges.reduce((es, e) => [...es, makeEdge({ id: freeEdgeId(es, e.source, e.target), ...e })], base);
      commit([...nodesRef.current.map((n) => n.selected ? { ...n, selected: false } : n), ...newNodes], newEdges);
      return newNodes.length;
    },
    [commit]
  );
  const copySelection = useCallback(
    (data) => {
      const clip = selectionClip();
      if (!clip) return false;
      lastClip = clip;
      pastes.current = 0;
      const text = serializeClip(clip);
      if (data) data.setData("text/plain", text);
      else void navigator.clipboard?.writeText(text).catch(() => void 0);
      store.toast("info", `Copied ${clip.nodes.length} box${clip.nodes.length === 1 ? "" : "es"}. Paste with ${MOD}V, here or in another diagram.`);
      return true;
    },
    [selectionClip]
  );
  const duplicate = useCallback(() => {
    const clip = selectionClip();
    if (!clip) return;
    pastes.current = 0;
    paste(clip, "offset");
  }, [paste, selectionClip]);
  const startReconnect = useCallback((edgeId, end, e) => {
    setMenu(null);
    setReconnect({ edgeId, end, pointer: { x: e.clientX, y: e.clientY }, over: null });
  }, []);
  useEffect14(() => {
    if (!reconnect) return;
    const edge = edgesRef.current.find((x) => x.id === reconnect.edgeId);
    const fixed = edge ? reconnect.end === "source" ? edge.target : edge.source : null;
    const boxAt = (x, y) => {
      const hit = document.elementFromPoint?.(x, y)?.closest(".react-flow__node")?.getAttribute("data-id") ?? null;
      return hit && hit !== fixed ? hit : null;
    };
    const move = (ev) => setReconnect((r) => r && { ...r, pointer: { x: ev.clientX, y: ev.clientY }, over: boxAt(ev.clientX, ev.clientY) });
    const up = (ev) => {
      const over = boxAt(ev.clientX, ev.clientY);
      setReconnect(null);
      if (edge && over && over !== edge[reconnect.end]) updateEdgeRef.current(edge.id, { [reconnect.end]: over });
    };
    const key = (ev) => {
      if (ev.key === "Escape") setReconnect(null);
    };
    const cancel = () => setReconnect(null);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("blur", cancel);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("blur", cancel);
      window.removeEventListener("keydown", key, true);
    };
  }, [reconnect?.edgeId, reconnect?.end]);
  const hoverTimer = useRef9(void 0);
  const hoverEdge = useCallback((id) => {
    window.clearTimeout(hoverTimer.current);
    if (id) setHoverEdgeId(id);
    else hoverTimer.current = window.setTimeout(() => setHoverEdgeId(null), 160);
  }, []);
  useEffect14(() => () => window.clearTimeout(hoverTimer.current), []);
  const closeMenu = useCallback(() => setMenu(null), []);
  const openMenu = useCallback(
    (client, target) => {
      const rect = wrapper.current?.getBoundingClientRect();
      if (!rect) return;
      setMenu({ at: { x: client.x - rect.left, y: client.y - rect.top }, flow: flow.screenToFlowPosition(client), target });
    },
    [flow]
  );
  const openMenuForSelection = useCallback(() => {
    const rect = wrapper.current?.getBoundingClientRect();
    if (!rect) return;
    const picked = nodesRef.current.filter((n) => n.selected);
    const lines = edgesRef.current.filter((e) => e.selected);
    const centreOf = (id) => {
      const n = flow.getInternalNode(id);
      if (!n) return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      return flow.flowToScreenPosition({ x: n.internals.positionAbsolute.x + (n.measured.width ?? 0) / 2, y: n.internals.positionAbsolute.y + (n.measured.height ?? 0) / 2 });
    };
    if (picked.length === 1 && !lines.length) return openMenu(centreOf(picked[0].id), { kind: "node", id: picked[0].id });
    if (lines.length === 1 && !picked.length) {
      const a = centreOf(lines[0].source);
      const b = centreOf(lines[0].target);
      return openMenu({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, { kind: "edge", id: lines[0].id });
    }
    if (picked.length + lines.length > 1) return openMenu(centreOf(picked[0]?.id ?? ""), { kind: "selection" });
    openMenu({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }, { kind: "pane" });
  }, [flow, openMenu]);
  const kindChoices = (active) => NODE_KINDS.map((k) => ({
    value: k,
    label: KIND_LABEL[k],
    className: `kind-${k}`,
    active: k === active,
    content: /* @__PURE__ */ jsx21("span", { className: "kind-swatch", "aria-hidden": "true", children: KIND_GLYPH[k] })
  }));
  const menuEntries = (target, at) => {
    if (target.kind === "pane") {
      return {
        title: "Canvas",
        entries: [
          { kind: "choices", label: "Add a box here", options: kindChoices(null), onSelect: (k) => addNode(k, { at }) },
          { kind: "item", label: "Paste here", hint: `${MOD}V`, disabled: !lastClip, onSelect: () => lastClip && paste(lastClip, at) },
          { kind: "separator" },
          { kind: "item", label: "Select everything", hint: `${MOD}A`, onSelect: selectAll },
          { kind: "item", label: "Tidy layout", onSelect: () => relayout(diagram.direction) },
          { kind: "item", label: "Fit the whole diagram", hint: "\u21E71", onSelect: fitAll },
          { kind: "separator" },
          { kind: "item", label: "Undo", hint: `${MOD}Z`, disabled: !history.current.canUndo, onSelect: undo },
          { kind: "item", label: "Keyboard shortcuts", hint: "?", onSelect: () => setShortcuts(true) }
        ]
      };
    }
    if (target.kind === "node") {
      const node = nodesRef.current.find((n) => n.id === target.id);
      if (!node) return { title: "Box", entries: [] };
      const targets = new Set(edgesRef.current.filter((e) => e.source === node.id).map((e) => e.target));
      const others = nodesRef.current.filter((n) => n.id !== node.id && !targets.has(n.id));
      return {
        title: node.data.label,
        entries: [
          { kind: "item", label: "Rename", hint: "F2", onSelect: () => setEditing(`node:${node.id}`) },
          { kind: "choices", label: "Kind", options: kindChoices(node.data.kind), onSelect: (k) => updateNode(node.id, { kind: k }) },
          { kind: "separator" },
          { kind: "item", label: "Add a box after it", hint: "Tab", onSelect: () => addAfter(node.id) },
          { kind: "item", label: "Add a box before it", hint: "\u21E7Tab", onSelect: () => addBefore(node.id) },
          { kind: "item", label: "Add a box beside it", hint: "Enter", onSelect: () => addBeside(node.id) },
          {
            kind: "submenu",
            label: "Connect to",
            entries: others.length ? others.map((n) => ({ kind: "item", label: n.data.label, onSelect: () => connect(node.id, n.id) })) : [{ kind: "item", label: "Already connected to every box", disabled: true, onSelect: () => void 0 }]
          },
          { kind: "separator" },
          { kind: "item", label: "Copy", hint: `${MOD}C`, onSelect: () => copySelection(null) },
          { kind: "item", label: "Duplicate", hint: `${MOD}D`, onSelect: duplicate },
          { kind: "separator" },
          { kind: "item", label: "Delete, keeping the flow", hint: `${ALT}\u232B`, onSelect: removeKeepingFlow },
          { kind: "item", label: "Delete", hint: "\u232B", danger: true, onSelect: removeSelected }
        ]
      };
    }
    if (target.kind === "edge") {
      const edge = edgesRef.current.find((e) => e.id === target.id);
      if (!edge) return { title: "Connection", entries: [] };
      const name = (id) => nodesRef.current.find((n) => n.id === id)?.data.label ?? id;
      return {
        title: `${name(edge.source)} \u2192 ${name(edge.target)}`,
        entries: [
          { kind: "item", label: edge.data?.label ? "Edit label" : "Add a label", onSelect: () => setEditing(`edge:${edge.id}`) },
          { kind: "item", label: "Reverse direction", onSelect: () => reverseEdge(edge.id) },
          { kind: "check", label: "Dashed \u2014 optional, async or future", checked: Boolean(edge.data?.dashed), onSelect: () => updateEdge(edge.id, { dashed: !edge.data?.dashed }) },
          {
            kind: "choices",
            label: "Arrowheads",
            options: [
              ["end", "\u2192", "One way"],
              ["both", "\u2194", "Both ways"],
              ["none", "\u2014", "No direction"]
            ].map(([value, glyph, label]) => ({ value, label, active: (edge.data?.arrows ?? "end") === value, content: glyph })),
            onSelect: (v) => updateEdge(edge.id, { arrows: v === "end" ? void 0 : v })
          },
          { kind: "separator" },
          { kind: "item", label: "Insert a box here", onSelect: () => insertIntoEdge(edge.id, at) },
          { kind: "item", label: "Delete", hint: "\u232B", danger: true, onSelect: removeSelected }
        ]
      };
    }
    const picked = nodesRef.current.filter((n) => n.selected);
    const kinds = new Set(picked.map((n) => n.data.kind));
    return {
      title: `${picked.length} box${picked.length === 1 ? "" : "es"} selected`,
      entries: [
        ...picked.length ? [
          {
            kind: "choices",
            label: "Kind of every box",
            options: kindChoices(kinds.size === 1 ? [...kinds][0] : null),
            onSelect: (k) => updateNodes(new Set(picked.map((n) => n.id)), { kind: k })
          },
          { kind: "separator" },
          { kind: "item", label: "Copy", hint: `${MOD}C`, onSelect: () => copySelection(null) },
          { kind: "item", label: "Duplicate", hint: `${MOD}D`, onSelect: duplicate },
          { kind: "item", label: "Zoom to them", hint: "\u21E72", onSelect: fitSelection },
          { kind: "separator" },
          { kind: "item", label: "Delete, keeping the flow", hint: `${ALT}\u232B`, onSelect: removeKeepingFlow }
        ] : [],
        { kind: "item", label: "Delete", hint: "\u232B", danger: true, onSelect: removeSelected }
      ]
    };
  };
  const keys = useRef9({ undo, redo, duplicate, selectAll, addAfter, addBefore, addBeside, removeKeepingFlow, fitAll, fitSelection, openMenuForSelection, clearSelection });
  keys.current = { undo, redo, duplicate, selectAll, addAfter, addBefore, addBeside, removeKeepingFlow, fitAll, fitSelection, openMenuForSelection, clearSelection };
  const overlays = useRef9({ menu: false, shortcuts: false, reconnect: false });
  overlays.current = { menu: Boolean(menu), shortcuts, reconnect: Boolean(reconnect) };
  useEffect14(() => {
    const busy = (target) => {
      const el = target;
      if (!el || !(el instanceof HTMLElement)) return false;
      return el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName);
    };
    const onCanvas = () => {
      const active = document.activeElement;
      const canvas = wrapper.current;
      if (!active || !canvas) return true;
      return canvas.contains(active) || active.contains(canvas);
    };
    const ours = (e) => {
      if (busy(e.target) || busy(document.activeElement)) return false;
      const text = window.getSelection?.()?.toString() ?? "";
      return onCanvas() && !text;
    };
    const onCopy = (e) => {
      if (!ours(e) || !nodesRef.current.some((n) => n.selected)) return;
      if (copySelection(e.clipboardData)) e.preventDefault();
    };
    const onCut = (e) => {
      if (readOnlyRef.current || !ours(e) || !nodesRef.current.some((n) => n.selected)) return;
      if (copySelection(e.clipboardData)) {
        e.preventDefault();
        removeSelected();
      }
    };
    const onPaste = (e) => {
      if (readOnlyRef.current || !ours(e)) return;
      const text = e.clipboardData?.getData("text/plain");
      const clip = text ? parseClip(text) : lastClip;
      if (!clip) return;
      e.preventDefault();
      paste(clip, "pointer");
    };
    const onKey = (e) => {
      if (e.key === "Alt") setTwoHops(true);
      if (busy(e.target) || !onCanvas()) return;
      const o = overlays.current;
      if (o.menu || o.shortcuts || o.reconnect) return;
      const k = keys.current;
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      const selected = nodesRef.current.filter((n) => n.selected);
      const one = selected.length === 1 && !edgesRef.current.some((x) => x.selected) ? selected[0] : null;
      const claim = () => {
        e.preventDefault();
        e.stopPropagation();
      };
      if (readOnlyRef.current) {
        if (mod && key === "a" && !e.shiftKey) return claim(), k.selectAll();
        if (!mod && e.shiftKey && e.code === "Digit1") return claim(), k.fitAll();
        if (!mod && e.shiftKey && e.code === "Digit2") return claim(), k.fitSelection();
        if (e.key === "Escape") k.clearSelection();
        return;
      }
      if (mod) {
        if (key === "z") return claim(), e.shiftKey ? k.redo() : k.undo();
        if (key === "y") return claim(), k.redo();
        if (key === "d" && selected.length) return claim(), k.duplicate();
        if (key === "a" && !e.shiftKey) return claim(), k.selectAll();
        return;
      }
      if (e.key === "F10" && e.shiftKey || e.key === "ContextMenu") return claim(), k.openMenuForSelection();
      if (e.key === "?") return claim(), setShortcuts(true);
      if (e.shiftKey && e.code === "Digit1") return claim(), k.fitAll();
      if (e.shiftKey && e.code === "Digit2") return claim(), k.fitSelection();
      if ((e.key === "Backspace" || e.key === "Delete") && e.altKey && selected.length) return claim(), k.removeKeepingFlow();
      if (e.key === "Escape") {
        setEditing(null);
        k.clearSelection();
        return;
      }
      if (!one) return;
      if (e.key === "Tab") return claim(), e.shiftKey ? k.addBefore(one.id) : k.addAfter(one.id);
      if (e.key === "Enter" && !e.altKey) return claim(), k.addBeside(one.id);
      if (e.key === "F2") return claim(), setEditing(`node:${one.id}`);
      if (e.key.length === 1 && e.key !== " " && !e.altKey) return claim(), setEditing(`node:${one.id}`, e.key);
    };
    const onKeyUp = (e) => {
      if (e.key === "Alt") setTwoHops(false);
    };
    const onBlur = () => setTwoHops(false);
    document.addEventListener("copy", onCopy);
    document.addEventListener("cut", onCut);
    document.addEventListener("paste", onPaste);
    document.addEventListener("keydown", onKey);
    document.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      document.removeEventListener("copy", onCopy);
      document.removeEventListener("cut", onCut);
      document.removeEventListener("paste", onPaste);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [copySelection, paste, removeSelected, setEditing]);
  const api2 = useMemo2(
    () => ({
      direction: diagram.direction,
      editing: readOnly ? null : editing,
      editSeed,
      startEditing: (key) => {
        if (!readOnly) setEditing(key);
      },
      startReconnect: (edgeId, end, event) => {
        if (!readOnly) startReconnect(edgeId, end, event);
      },
      hoverEdge,
      finishNodeLabel: (id, label) => {
        setEditing(null);
        const node = nodesRef.current.find((n) => n.id === id);
        const next = label?.trim();
        if (node && next && next !== node.data.label) updateNode(id, { label: next });
      },
      finishEdgeLabel: (id, label) => {
        setEditing(null);
        const edge = edgesRef.current.find((e) => e.id === id);
        if (edge && label !== null && label.trim() !== (edge.data?.label ?? "")) updateEdge(id, { label: label.trim() });
      },
      selectEdge: (id) => select("edge", id)
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the updaters read live state through refs
    [diagram.direction, editing, editSeed, select, startReconnect, hoverEdge, setEditing, readOnly]
  );
  const selectedNodes = nodes.filter((n) => n.selected);
  const selectedEdges = edges.filter((e) => e.selected);
  const gesturing = Boolean(reconnect) || dragging.current;
  const focusNode = !gesturing && hoverNode || (selectedNodes.length === 1 && !selectedEdges.length ? selectedNodes[0].id : null);
  const focusEdge = focusNode ? null : !gesturing && hoverEdgeId || (selectedEdges.length === 1 && !selectedNodes.length ? selectedEdges[0].id : null);
  const relations = useMemo2(() => {
    const lite = edges.map(liteEdge);
    if (focusNode && nodes.some((n) => n.id === focusNode)) return relationsOf(focusNode, lite, twoHops ? 2 : 1);
    const e = focusEdge ? lite.find((x) => x.id === focusEdge) : void 0;
    if (!e) return null;
    const both = e.arrows === "both" || e.arrows === "none";
    return {
      nodes: /* @__PURE__ */ new Map([
        [e.source, both ? "both" : "from"],
        [e.target, both ? "both" : "to"]
      ]),
      edges: /* @__PURE__ */ new Map([[e.id, both ? "both" : "out"]])
    };
  }, [edges, nodes, focusNode, focusEdge, twoHops]);
  const drawnNodes = useMemo2(
    () => nodes.map((n) => {
      const rel = relations?.nodes.get(n.id);
      const dim = Boolean(relations) && !rel;
      const drop = reconnect?.over === n.id;
      if (!rel && !dim && !drop) return n;
      return { ...n, className: classNames(dim && "rel-dim", rel && `rel-${rel}`), data: { ...n.data, ...rel ? { rel } : {}, ...drop ? { dropTarget: true } : {} } };
    }),
    [nodes, relations, reconnect?.over]
  );
  const drawnEdges = useMemo2(() => {
    const offsets = lanes(edges);
    return edges.map((e) => {
      const rel = relations?.edges.get(e.id);
      const dim = Boolean(relations) && !rel;
      const grips = !readOnly && !reconnect && e.source !== e.target && (Boolean(e.selected) || hoverEdgeId === e.id);
      const lane = offsets.get(e.id);
      const drop = dropEdge === e.id;
      const moving = reconnect?.edgeId === e.id;
      if (!rel && !dim && !grips && lane === void 0 && !drop && !moving) return e;
      const colour = rel ? REL_COLOUR[rel] : void 0;
      const marker = (m) => m && typeof m === "object" && colour ? { ...m, color: colour } : m;
      return {
        ...e,
        className: classNames(e.className, rel && `rel-${rel}`, dim && "rel-dim", drop && "is-drop-target", moving && "is-reconnecting"),
        animated: rel === "out" || rel === "in" || rel === "out2" || rel === "in2",
        markerEnd: marker(e.markerEnd),
        markerStart: marker(e.markerStart),
        data: { ...e.data, ...lane !== void 0 ? { lane } : {}, ...rel ? { rel } : {}, ...dim ? { dim } : {}, ...grips ? { grips } : {}, ...drop ? { dropTarget: true } : {} }
      };
    });
  }, [edges, relations, reconnect, hoverEdgeId, dropEdge, readOnly]);
  let panel;
  if (readOnly && selectedNodes.length + selectedEdges.length > 0) {
    panel = /* @__PURE__ */ jsx21(
      ReadOnlyPanel,
      {
        nodes,
        edges,
        selectedNodes,
        selectedEdges,
        plan,
        onSelect: select,
        onClose: clearSelection
      }
    );
  } else if (selectedNodes.length === 1 && selectedEdges.length === 0) {
    const node = selectedNodes[0];
    panel = /* @__PURE__ */ jsx21(
      NodePanel,
      {
        node,
        nodes,
        edges,
        plan,
        onChange: (patch) => updateNode(node.id, patch),
        onSelect: select,
        onConnect: (target) => connect(node.id, target),
        onDisconnect: (id) => commit(nodesRef.current, edgesRef.current.filter((e) => e.id !== id)),
        onAddConnected: () => addAfter(node.id),
        onDuplicate: duplicate,
        onRemove: removeSelected,
        onClose: clearSelection
      },
      node.id
    );
  } else if (selectedEdges.length === 1 && selectedNodes.length === 0) {
    const edge = selectedEdges[0];
    panel = /* @__PURE__ */ jsx21(
      EdgePanel,
      {
        edge,
        nodes,
        onChange: (patch) => updateEdge(edge.id, patch),
        onReverse: () => reverseEdge(edge.id),
        onSelect: select,
        onRemove: removeSelected,
        onClose: clearSelection
      },
      edge.id
    );
  } else if (selectedNodes.length + selectedEdges.length > 1) {
    panel = /* @__PURE__ */ jsx21(
      SelectionPanel,
      {
        nodes: selectedNodes,
        edges: selectedEdges,
        onKind: (kind) => updateNodes(new Set(selectedNodes.map((n) => n.id)), { kind }),
        onCopy: () => copySelection(null),
        onDuplicate: duplicate,
        onRemove: removeSelected,
        onClose: clearSelection
      }
    );
  } else {
    panel = aside;
  }
  const shownMenu = menu ? menuEntries(menu.target, menu.flow) : null;
  const focusLabel = focusNode ? nodes.find((n) => n.id === focusNode)?.data.label ?? "" : "this connection";
  return /* @__PURE__ */ jsx21(CanvasContext.Provider, { value: api2, children: /* @__PURE__ */ jsxs20("div", { className: "arch-body", children: [
    /* @__PURE__ */ jsxs20(
      "div",
      {
        ref: wrapper,
        className: classNames("flow", reconnect && "is-reconnecting", readOnly && "is-readonly"),
        onMouseMove: (e) => {
          pointer.current = flow.screenToFlowPosition({ x: e.clientX, y: e.clientY });
        },
        onMouseLeave: () => {
          pointer.current = null;
        },
        onDoubleClick: (e) => {
          if (readOnly) return;
          const el = e.target;
          if (el.closest(".react-flow__node, .react-flow__edge, .react-flow__panel, .flow-edge-label, .flow-menu")) return;
          if (!el.closest(".react-flow__pane")) return;
          addNode("component", { at: flow.screenToFlowPosition({ x: e.clientX, y: e.clientY }) });
        },
        children: [
          /* @__PURE__ */ jsxs20(
            ReactFlow,
            {
              nodes: drawnNodes,
              edges: drawnEdges,
              nodeTypes,
              edgeTypes,
              onNodesChange,
              onEdgesChange,
              onConnect: readOnly ? void 0 : onConnect,
              onConnectEnd: readOnly ? void 0 : onConnectEnd,
              onDelete: readOnly ? void 0 : onDelete,
              nodesDraggable: !readOnly,
              nodesConnectable: !readOnly,
              onNodeDragStart: onDragStart,
              onNodeDrag,
              onNodeDragStop,
              onSelectionDragStart: onDragStart,
              onSelectionDragStop,
              onNodeDoubleClick: (_, node) => !readOnly && setEditing(`node:${node.id}`),
              onEdgeDoubleClick: (_, edge) => !readOnly && setEditing(`edge:${edge.id}`),
              onNodeMouseEnter: (_, node) => setHoverNode(node.id),
              onNodeMouseLeave: () => setHoverNode(null),
              onEdgeMouseEnter: (_, edge) => hoverEdge(edge.id),
              onEdgeMouseLeave: () => hoverEdge(null),
              onPaneContextMenu: (e) => {
                if (readOnly) return;
                e.preventDefault();
                openMenu({ x: e.clientX, y: e.clientY }, { kind: "pane" });
              },
              onNodeContextMenu: (e, node) => {
                if (readOnly) return;
                e.preventDefault();
                const many = nodesRef.current.filter((n) => n.selected).length + edgesRef.current.filter((x) => x.selected).length > 1;
                if (node.selected && many) return openMenu({ x: e.clientX, y: e.clientY }, { kind: "selection" });
                select("node", node.id);
                openMenu({ x: e.clientX, y: e.clientY }, { kind: "node", id: node.id });
              },
              onEdgeContextMenu: (e, edge) => {
                if (readOnly) return;
                e.preventDefault();
                select("edge", edge.id);
                openMenu({ x: e.clientX, y: e.clientY }, { kind: "edge", id: edge.id });
              },
              onSelectionContextMenu: (e) => {
                if (readOnly) return;
                e.preventDefault();
                openMenu({ x: e.clientX, y: e.clientY }, { kind: "selection" });
              },
              onMoveStart: () => setMenu(null),
              connectionMode: ConnectionMode.Loose,
              deleteKeyCode: readOnly ? null : ["Backspace", "Delete"],
              zoomOnDoubleClick: false,
              colorMode: theme,
              fitView: true,
              fitViewOptions: FIT,
              minZoom: 0.2,
              maxZoom: 2,
              defaultEdgeOptions: { type: "plan" },
              children: [
                /* @__PURE__ */ jsx21(Background, { gap: 18, size: 1 }),
                /* @__PURE__ */ jsx21(Controls, { showInteractive: false, position: "bottom-left", fitViewOptions: FIT }),
                /* @__PURE__ */ jsx21(MiniMap, { pannable: true, zoomable: true, position: "bottom-right", style: { width: 150, height: 96 }, nodeBorderRadius: 4 }),
                readOnly ? /* @__PURE__ */ jsx21(Panel, { position: "top-left", className: "flow-toolbar", children: /* @__PURE__ */ jsxs20("span", { className: "flow-locked", title: "The plan is submitted; reopen it to change the design", children: [
                  /* @__PURE__ */ jsx21("span", { "aria-hidden": "true", children: "\u{1F512}" }),
                  " Final design"
                ] }) }) : /* @__PURE__ */ jsxs20(Panel, { position: "top-left", className: "flow-toolbar", children: [
                  /* @__PURE__ */ jsx21(AddMenu, { onAdd: (kind) => addNode(kind) }),
                  /* @__PURE__ */ jsx21("button", { type: "button", className: "btn btn-sm", title: "Lay the whole diagram out again, along its flow", onClick: () => relayout(diagram.direction), children: "Tidy layout" }),
                  /* @__PURE__ */ jsx21(
                    "button",
                    {
                      type: "button",
                      className: "btn btn-sm",
                      title: diagram.direction === "LR" ? "Lay it out top to bottom" : "Lay it out left to right",
                      onClick: () => relayout(diagram.direction === "LR" ? "TB" : "LR"),
                      children: diagram.direction === "LR" ? "\u2192 Left to right" : "\u2193 Top to bottom"
                    }
                  ),
                  /* @__PURE__ */ jsxs20("span", { className: "flow-toolbar-group", children: [
                    /* @__PURE__ */ jsx21("button", { type: "button", className: "btn btn-sm btn-icon", "aria-label": "Undo", title: `Undo (${MOD}Z)`, disabled: !history.current.canUndo, onClick: undo, children: "\u21B6" }),
                    /* @__PURE__ */ jsx21("button", { type: "button", className: "btn btn-sm btn-icon", "aria-label": "Redo", title: `Redo (\u21E7${MOD}Z)`, disabled: !history.current.canRedo, onClick: redo, children: "\u21B7" })
                  ] }),
                  /* @__PURE__ */ jsx21("button", { type: "button", className: "btn btn-sm btn-icon", "aria-label": "Keyboard shortcuts", title: "Keyboard shortcuts (?)", onClick: () => setShortcuts(true), children: "?" })
                ] }),
                relations && /* @__PURE__ */ jsxs20(Panel, { position: "bottom-center", className: "flow-legend", children: [
                  /* @__PURE__ */ jsx21("span", { className: "flow-legend-item rel-from", title: "Boxes with an arrow into it", children: "from \u2192" }),
                  /* @__PURE__ */ jsx21("span", { className: "flow-legend-item rel-focus", children: focusLabel }),
                  /* @__PURE__ */ jsx21("span", { className: "flow-legend-item rel-to", title: "Boxes it has an arrow to", children: "\u2192 to" }),
                  /* @__PURE__ */ jsx21("span", { className: "flow-legend-item rel-both", title: "Connected both ways, or without a direction", children: "\u21C4 both" }),
                  focusNode && /* @__PURE__ */ jsx21("span", { className: "flow-legend-hint", children: twoHops ? "two steps out" : `hold ${ALT === "\u2325" ? "\u2325" : "Alt"} for two steps` })
                ] })
              ]
            }
          ),
          reconnect && /* @__PURE__ */ jsx21(ReconnectLine, { reconnect, edges, wrapper: wrapper.current }),
          menu && shownMenu && /* @__PURE__ */ jsx21(ContextMenu, { at: menu.at, title: shownMenu.title, entries: shownMenu.entries, onClose: closeMenu }),
          shortcuts && /* @__PURE__ */ jsx21(ShortcutsOverlay, { onClose: () => setShortcuts(false) })
        ]
      }
    ),
    /* @__PURE__ */ jsx21("aside", { className: "arch-panel", "aria-label": "Details", children: panel })
  ] }) });
}
function patchOf(ns, es, direction) {
  return {
    nodes: ns.map((n) => ({
      id: n.id,
      label: n.data.label,
      kind: n.data.kind,
      ...n.data.detail ? { detail: n.data.detail } : {},
      // Sent even when empty: leaving them out would keep the old text.
      description: n.data.description ?? "",
      notes: n.data.notes ?? "",
      taskIds: n.data.taskIds ?? [],
      x: Math.round(n.position.x),
      y: Math.round(n.position.y)
    })),
    edges: es.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      // Always said, even when empty: the daemon keeps an arrow's label
      // and style when an edit leaves them out.
      label: e.data?.label ?? "",
      dashed: Boolean(e.data?.dashed),
      arrows: e.data?.arrows ?? "end"
    })),
    direction
  };
}
function liteEdge(e) {
  return {
    id: e.id,
    source: e.source,
    target: e.target,
    ...e.data?.label ? { label: e.data.label } : {},
    ...e.data?.dashed ? { dashed: true } : {},
    ...e.data?.arrows ? { arrows: e.data.arrows } : {}
  };
}
function spliced(edges, edge, id) {
  const [first, second] = splitEdge(liteEdge(edge), id);
  let out = edges.filter((e) => e.id !== edge.id);
  for (const half of [first, second]) out = [...out, makeEdge({ id: freeEdgeId(out, half.source, half.target), ...half })];
  return out;
}
function ReconnectLine({ reconnect, edges, wrapper }) {
  const flow = useReactFlow();
  const edge = edges.find((e) => e.id === reconnect.edgeId);
  const rect = wrapper?.getBoundingClientRect();
  if (!edge || !rect) return null;
  const fixedId = reconnect.end === "source" ? edge.target : edge.source;
  const n = flow.getInternalNode(fixedId);
  if (!n) return null;
  const c = flow.flowToScreenPosition({ x: n.internals.positionAbsolute.x + (n.measured.width ?? 0) / 2, y: n.internals.positionAbsolute.y + (n.measured.height ?? 0) / 2 });
  const fixed = { x: c.x - rect.left, y: c.y - rect.top };
  const moving = { x: reconnect.pointer.x - rect.left, y: reconnect.pointer.y - rect.top };
  const [from, to] = reconnect.end === "target" ? [fixed, moving] : [moving, fixed];
  return /* @__PURE__ */ jsxs20("svg", { className: "flow-reconnect", "aria-hidden": "true", children: [
    /* @__PURE__ */ jsx21("defs", { children: /* @__PURE__ */ jsx21("marker", { id: "flow-reconnect-head", viewBox: "-10 -10 20 20", markerWidth: "14", markerHeight: "14", orient: "auto-start-reverse", refX: "0", refY: "0", children: /* @__PURE__ */ jsx21("polyline", { points: "-5,-4 0,0 -5,4 -5,-4" }) }) }),
    /* @__PURE__ */ jsx21("line", { x1: from.x, y1: from.y, x2: to.x, y2: to.y, markerEnd: "url(#flow-reconnect-head)" })
  ] });
}
function AddMenu({ onAdd }) {
  const [open, setOpen] = useState15(false);
  return /* @__PURE__ */ jsxs20("div", { className: "add-menu", children: [
    /* @__PURE__ */ jsx21("button", { type: "button", className: "btn btn-sm btn-primary", "aria-expanded": open, onClick: () => setOpen((v) => !v), title: "Or double-click or right-click empty canvas", children: "+ Box" }),
    open && /* @__PURE__ */ jsx21("div", { className: "add-menu-list", role: "menu", children: NODE_KINDS.map((k) => /* @__PURE__ */ jsxs20(
      "button",
      {
        type: "button",
        role: "menuitem",
        className: "add-menu-item",
        onClick: () => {
          setOpen(false);
          onAdd(k);
        },
        children: [
          /* @__PURE__ */ jsx21("span", { className: classNames("kind-swatch", `kind-${k}`), "aria-hidden": "true", children: KIND_GLYPH[k] }),
          KIND_LABEL[k]
        ]
      },
      k
    )) })
  ] });
}
var nodeTypes, edgeTypes, lastClip, REL_COLOUR, FIT;
var init_FlowCanvas = __esm({
  "src/ui/components/FlowCanvas.tsx"() {
    "use strict";
    init_store();
    init_layout();
    init_geometry();
    init_graph();
    init_history();
    init_clipboard();
    init_theme();
    init_format();
    init_types();
    init_PlanNode();
    init_PlanEdge();
    init_Panels();
    init_ContextMenu();
    init_Shortcuts();
    init_convert();
    init_shared();
    nodeTypes = { plan: PlanNode };
    edgeTypes = { plan: PlanEdge };
    lastClip = null;
    REL_COLOUR = {
      out: "var(--rel-to)",
      out2: "var(--rel-to)",
      in: "var(--rel-from)",
      in2: "var(--rel-from)",
      both: "var(--rel-both)"
    };
    FIT = { padding: 0.14, maxZoom: 1, minZoom: 0.4, duration: 0 };
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
function labeller(diagram) {
  const names = new Map(diagram.nodes.map((n) => [n.id, n.label]));
  return (id) => names.get(id) ?? id;
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

// src/ui/views/DiagramsView.tsx
import { useState as useState16 } from "react";
import { jsx as jsx22, jsxs as jsxs21 } from "react/jsx-runtime";
function DiagramsView() {
  const plan = usePlan();
  const chosen = useStore((s) => s.diagramId);
  const sessionId = useStore((s) => s.sessionId);
  if (!plan) return null;
  const diagram = plan.diagrams.find((d) => d.id === chosen) ?? plan.diagrams[0] ?? null;
  const locked = isLocked(plan);
  return /* @__PURE__ */ jsxs21("div", { className: "arch", children: [
    /* @__PURE__ */ jsxs21("div", { className: "arch-bar", children: [
      /* @__PURE__ */ jsx22("nav", { className: "arch-tabs", "aria-label": "Diagrams", children: plan.diagrams.map((d) => /* @__PURE__ */ jsxs21(
        "button",
        {
          type: "button",
          className: classNames("arch-tab", d.id === diagram?.id && "is-active"),
          "aria-current": d.id === diagram?.id ? "true" : void 0,
          onClick: () => store.set({ diagramId: d.id }),
          children: [
            d.title,
            /* @__PURE__ */ jsx22("span", { className: "arch-tab-count", children: d.nodes.length })
          ]
        },
        d.id
      )) }),
      !locked && /* @__PURE__ */ jsx22(NewDiagram, {}),
      /* @__PURE__ */ jsx22("span", { className: "spacer" }),
      locked ? /* @__PURE__ */ jsx22("p", { className: "toolbar-hint", children: "Hover a box to see its connections \xB7 each box fills up as the tasks that build it get done" }) : /* @__PURE__ */ jsxs21("p", { className: "toolbar-hint", children: [
        "Right-click for everything \xB7 ",
        /* @__PURE__ */ jsx22("kbd", { children: "Tab" }),
        " adds the next box \xB7 drag from a box's edge to connect \xB7",
        " ",
        /* @__PURE__ */ jsx22("kbd", { children: "?" }),
        " all shortcuts"
      ] }),
      /* @__PURE__ */ jsx22(SubmitControl, {})
    ] }),
    diagram ? /* @__PURE__ */ jsx22(
      DiagramEditor,
      {
        diagram,
        plan,
        readOnly: locked,
        onSave: async (patch) => {
          const plan2 = await store.commit([{ op: "upsert_diagram", id: diagram.id, ...patch }], sessionId);
          return plan2?.diagrams.find((d) => d.id === diagram.id)?.rev ?? null;
        },
        aside: /* @__PURE__ */ jsx22(DiagramPanel, { plan, diagram, locked })
      },
      `${sessionId}:${diagram.id}`
    ) : /* @__PURE__ */ jsx22("div", { className: "view-pad", children: /* @__PURE__ */ jsx22(
      EmptyState,
      {
        title: "No diagrams yet",
        hint: locked ? "This plan was submitted without a diagram." : "Ask Claude to draw the architecture \u2014 components, data flow, boundaries \u2014 or start one from a template."
      }
    ) })
  ] });
}
function NewDiagram() {
  const [open, setOpen] = useState16(false);
  const add = async (t) => {
    setOpen(false);
    const before = new Set(store.getState().session?.plan?.diagrams.map((d) => d.id));
    if (await store.op({ op: "upsert_diagram", title: t.title, nodes: t.nodes, edges: t.edges })) {
      const made = store.getState().session?.plan?.diagrams.find((d) => !before.has(d.id));
      if (made) store.set({ diagramId: made.id });
    }
  };
  return /* @__PURE__ */ jsxs21("div", { className: "add-menu", children: [
    /* @__PURE__ */ jsx22("button", { type: "button", className: "btn btn-sm", "aria-expanded": open, onClick: () => setOpen((v) => !v), children: "+ New diagram" }),
    open && /* @__PURE__ */ jsx22("div", { className: "add-menu-list", role: "menu", children: TEMPLATES.map((t) => /* @__PURE__ */ jsx22("button", { type: "button", role: "menuitem", className: "add-menu-item", onClick: () => void add(t), children: t.label }, t.label)) })
  ] });
}
function DiagramPanel({ plan, diagram, locked }) {
  const [confirming, setConfirming] = useState16(false);
  const index = plan.diagrams.findIndex((d) => d.id === diagram.id);
  const linked = diagram.nodes.filter((n) => n.taskIds?.length).length;
  return /* @__PURE__ */ jsxs21("div", { className: "arch-panel-body", "aria-label": `About ${diagram.title}`, children: [
    /* @__PURE__ */ jsxs21("header", { className: "panel-top", children: [
      /* @__PURE__ */ jsx22("span", { className: "panel-kicker", children: "Diagram" }),
      /* @__PURE__ */ jsx22("span", { className: "item-id", children: diagram.id }),
      /* @__PURE__ */ jsx22("span", { className: "spacer" }),
      /* @__PURE__ */ jsx22("span", { className: "muted panel-meta", children: locked ? "locked" : `${diagram.updatedBy === "user" ? "edited by you" : "by Claude"} \xB7 ${relativeTime(diagram.updatedAt)}` })
    ] }),
    /* @__PURE__ */ jsx22(
      InlineText,
      {
        as: "h2",
        className: "panel-title",
        value: diagram.title,
        label: "Diagram title",
        readOnly: locked,
        onSave: (title) => store.op({ op: "upsert_diagram", id: diagram.id, title })
      }
    ),
    locked ? diagram.caption ? /* @__PURE__ */ jsx22(Markdown, { source: diagram.caption }) : null : /* @__PURE__ */ jsx22(
      MarkdownField,
      {
        value: diagram.caption ?? "",
        label: `caption of "${diagram.title}"`,
        placeholder: "What this diagram shows.",
        emptyAction: "Describe it",
        rows: 3,
        onSave: (caption) => store.op({ op: "upsert_diagram", id: diagram.id, caption })
      }
    ),
    /* @__PURE__ */ jsxs21("p", { className: "panel-hint", children: [
      diagram.nodes.length,
      " boxes, ",
      diagram.edges.length,
      " arrows",
      linked ? `, ${linked} tracking tasks` : "",
      ".",
      " ",
      locked ? "The plan is submitted, so this is the final design. Select a box to read its details and how far the tasks that build it have got." : "Select a box to edit its details, decisions and the tasks that build it."
    ] }),
    /* @__PURE__ */ jsx22("div", { className: "row-actions", children: /* @__PURE__ */ jsx22(
      "button",
      {
        type: "button",
        className: "btn btn-sm",
        title: "The diagram as Claude reads it: every part, what it does and what was decided, then every connection",
        onClick: () => {
          const text = diagramToMarkdown(diagram, { tasks: plan.tasks });
          void navigator.clipboard?.writeText(text).then(() => store.toast("success", "Copied the diagram as Markdown.")).catch(() => store.toast("error", "The browser would not let the page use the clipboard."));
        },
        children: "Copy as Markdown"
      }
    ) }),
    /* @__PURE__ */ jsx22("ul", { className: "kind-legend", "aria-label": "Box kinds", children: NODE_KINDS.map((k) => /* @__PURE__ */ jsxs21("li", { children: [
      /* @__PURE__ */ jsx22("span", { className: classNames("kind-swatch", `kind-${k}`), "aria-hidden": "true", children: KIND_GLYPH[k] }),
      KIND_LABEL[k]
    ] }, k)) }),
    (!locked || plan.threads.some((t) => t.target.kind === "diagram" && t.target.id === diagram.id)) && /* @__PURE__ */ jsx22("fieldset", { className: "lockable", disabled: locked, children: /* @__PURE__ */ jsxs21("div", { className: "field", children: [
      /* @__PURE__ */ jsx22("span", { className: "field-label", children: "Comments" }),
      /* @__PURE__ */ jsx22(ThreadPanel, { target: { kind: "diagram", id: diagram.id }, label: diagram.title })
    ] }) }),
    !locked && /* @__PURE__ */ jsxs21("footer", { className: "panel-foot", children: [
      /* @__PURE__ */ jsx22("button", { type: "button", className: "link", disabled: index <= 0, onClick: () => void store.op({ op: "move_diagram", id: diagram.id, index: index - 1 }), children: "Move left" }),
      /* @__PURE__ */ jsx22(
        "button",
        {
          type: "button",
          className: "link",
          disabled: index >= plan.diagrams.length - 1,
          onClick: () => void store.op({ op: "move_diagram", id: diagram.id, index: index + 1 }),
          children: "Move right"
        }
      ),
      /* @__PURE__ */ jsx22("span", { className: "spacer" }),
      confirming ? /* @__PURE__ */ jsxs21("span", { className: "item-confirm", children: [
        "Remove?",
        /* @__PURE__ */ jsx22("button", { type: "button", className: "link is-danger", onClick: () => void store.op({ op: "remove", kind: "diagram", id: diagram.id }), children: "Remove" }),
        /* @__PURE__ */ jsx22("button", { type: "button", className: "link", onClick: () => setConfirming(false), children: "Keep" })
      ] }) : /* @__PURE__ */ jsx22("button", { type: "button", className: "link is-danger", onClick: () => setConfirming(true), children: "Remove diagram" })
    ] })
  ] });
}
var TEMPLATES;
var init_DiagramsView = __esm({
  "src/ui/views/DiagramsView.tsx"() {
    "use strict";
    init_store();
    init_Editable();
    init_Markdown();
    init_Threads();
    init_FlowCanvas();
    init_primitives();
    init_Submit();
    init_plan();
    init_format();
    init_architecture();
    init_types();
    TEMPLATES = [
      { label: "Blank", title: "New diagram", nodes: [], edges: [] },
      {
        label: "Components",
        title: "Components",
        nodes: [
          { id: "client", label: "Client", kind: "actor", description: "Whoever calls the API: a browser, an app, another service." },
          { id: "api", label: "API", kind: "service", description: "Takes requests, applies the rules, and reads and writes the database." },
          { id: "db", label: "Database", kind: "datastore", description: "The system of record." }
        ],
        edges: [
          { source: "client", target: "api", label: "HTTPS" },
          { source: "api", target: "db", label: "reads / writes" }
        ]
      },
      {
        label: "Pipeline",
        title: "Data flow",
        nodes: [
          { id: "source", label: "Source", kind: "external" },
          { id: "queue", label: "Queue", kind: "queue" },
          { id: "worker", label: "Worker", kind: "service" },
          { id: "store", label: "Store", kind: "datastore" }
        ],
        edges: [
          { source: "source", target: "queue", label: "events" },
          { source: "queue", target: "worker" },
          { source: "worker", target: "store" }
        ]
      }
    ];
  }
});

// src/ui/views/TasksView.tsx
import { useEffect as useEffect15, useMemo as useMemo3, useRef as useRef10, useState as useState17 } from "react";
import { Fragment as Fragment5, jsx as jsx23, jsxs as jsxs22 } from "react/jsx-runtime";
function TasksView() {
  const plan = usePlan();
  const mode = useStore((s) => s.taskMode);
  const hideDone = useStore((s) => s.hideDone);
  const sessionId = useStore((s) => s.sessionId);
  if (!plan) return null;
  const counts = countTasks(plan);
  if (isLocked(plan)) {
    const phase = planPhase(plan);
    return /* @__PURE__ */ jsxs22("div", { className: "view-pad", children: [
      /* @__PURE__ */ jsxs22("div", { className: "toolbar", children: [
        /* @__PURE__ */ jsxs22("p", { className: "toolbar-note", children: [
          /* @__PURE__ */ jsx23("span", { "aria-hidden": "true", children: "\u{1F512}" }),
          " ",
          phase === "handed-off" ? "Handed off to be built elsewhere, so these statuses do not move." : phase === "submitted" ? "The plan is locked. Cards move across the board once Claude starts and reports each task." : "The plan is locked. Cards move across the board as Claude reports each task."
        ] }),
        /* @__PURE__ */ jsx23("span", { className: "spacer" }),
        /* @__PURE__ */ jsxs22("span", { className: "toolbar-progress", children: [
          /* @__PURE__ */ jsx23(ProgressBar, { counts }),
          /* @__PURE__ */ jsxs22("span", { className: "muted", children: [
            counts.done,
            "/",
            counts.total,
            " done"
          ] })
        ] })
      ] }),
      plan.tasks.length === 0 ? /* @__PURE__ */ jsx23(EmptyState, { title: "No tasks", hint: "This plan was submitted without a task breakdown." }) : /* @__PURE__ */ jsx23(Board, { plan, readOnly: true }, sessionId)
    ] });
  }
  return /* @__PURE__ */ jsxs22("div", { className: "view-pad", children: [
    /* @__PURE__ */ jsxs22("div", { className: "toolbar", children: [
      /* @__PURE__ */ jsxs22("div", { className: "segmented", role: "group", "aria-label": "Task layout", children: [
        /* @__PURE__ */ jsx23("button", { type: "button", className: classNames("seg", mode === "outline" && "is-active"), "aria-pressed": mode === "outline", onClick: () => store.setTaskMode("outline"), children: "Outline" }),
        /* @__PURE__ */ jsx23("button", { type: "button", className: classNames("seg", mode === "board" && "is-active"), "aria-pressed": mode === "board", onClick: () => store.setTaskMode("board"), children: "Board" })
      ] }),
      mode === "outline" && /* @__PURE__ */ jsxs22("label", { className: "toggle", children: [
        /* @__PURE__ */ jsx23("input", { type: "checkbox", checked: hideDone, onChange: () => store.toggleHideDone() }),
        "Hide done"
      ] }),
      /* @__PURE__ */ jsx23("span", { className: "spacer" }),
      /* @__PURE__ */ jsxs22("span", { className: "toolbar-progress", children: [
        /* @__PURE__ */ jsx23(ProgressBar, { counts }),
        /* @__PURE__ */ jsxs22("span", { className: "muted", children: [
          counts.done,
          "/",
          counts.total,
          " done"
        ] })
      ] })
    ] }),
    plan.tasks.length === 0 ? /* @__PURE__ */ jsxs22(Fragment5, { children: [
      /* @__PURE__ */ jsx23(EmptyState, { title: "No tasks yet", hint: "Break the work down here, or ask Claude to publish a task tree with the plan." }),
      /* @__PURE__ */ jsx23(AddField, { placeholder: "Add a task\u2026", label: "New task", onAdd: (title) => store.op({ op: "upsert_task", title }) })
    ] }) : mode === "outline" ? /* @__PURE__ */ jsx23(Outline, { plan, hideDone }) : /* @__PURE__ */ jsx23(Board, { plan })
  ] });
}
function Outline({ plan, hideDone }) {
  const collapsed = useStore((s) => s.collapsedTasks);
  const [dragging, setDragging] = useState17(null);
  const [hint, setHint] = useState17(null);
  const [expanded, setExpanded] = useState17(null);
  const [addingUnder, setAddingUnder] = useState17(null);
  const partsByTask = useMemo3(() => {
    const map = /* @__PURE__ */ new Map();
    for (const d of plan.diagrams) {
      for (const n of d.nodes) {
        for (const t of n.taskIds ?? []) map.set(t, [...map.get(t) ?? [], { d, n }]);
      }
    }
    return map;
  }, [plan.diagrams]);
  const rows = useMemo3(() => {
    const hidden = /* @__PURE__ */ new Set();
    for (const id of collapsed) for (const d of descendants(plan, id)) hidden.add(d.id);
    return outline(plan).filter(({ task }) => !hidden.has(task.id) && !(hideDone && task.status === "done" && !hasChildren(plan, task.id)));
  }, [plan, collapsed, hideDone]);
  const dropOp = (draggedId, target, zone) => {
    if (draggedId === target.id || descendants(plan, draggedId).some((d) => d.id === target.id)) return null;
    if (zone === "inside") return { op: "move_task", id: draggedId, parentId: target.id, index: Number.MAX_SAFE_INTEGER };
    const siblings = childrenOf(plan, target.parentId).filter((t) => t.id !== draggedId);
    const at = siblings.findIndex((t) => t.id === target.id);
    return { op: "move_task", id: draggedId, parentId: target.parentId, index: zone === "before" ? at : at + 1 };
  };
  const onDragOver = (e, target) => {
    if (!dragging) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const y = (e.clientY - rect.top) / Math.max(1, rect.height);
    const zone = y < 0.28 ? "before" : y > 0.72 ? "after" : "inside";
    if (!dropOp(dragging, target, zone)) {
      setHint(null);
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (hint?.id !== target.id || hint.zone !== zone) setHint({ id: target.id, zone });
  };
  const onDrop = (e, target) => {
    e.preventDefault();
    const id = e.dataTransfer.getData(DRAG_TYPE) || dragging;
    const zone = hint?.id === target.id ? hint.zone : null;
    setHint(null);
    setDragging(null);
    if (!id || !zone) return;
    const op = dropOp(id, target, zone);
    if (!op) return;
    if (zone === "inside" && collapsed.includes(target.id)) store.toggleTaskCollapsed(target.id);
    void store.op(op);
  };
  return /* @__PURE__ */ jsxs22("div", { className: "task-outline", children: [
    /* @__PURE__ */ jsx23("div", { className: "outline-rows", role: "tree", "aria-label": "Task tree", children: rows.map(({ task, depth, number }) => /* @__PURE__ */ jsx23(
      TaskRow,
      {
        plan,
        task,
        depth,
        number,
        expanded: expanded === task.id,
        onToggleExpanded: () => setExpanded((cur) => cur === task.id ? null : task.id),
        dragging: dragging === task.id,
        dropZone: hint?.id === task.id ? hint.zone : null,
        onDragStart: (e) => {
          e.dataTransfer.setData(DRAG_TYPE, task.id);
          e.dataTransfer.setData("text/plain", task.title);
          e.dataTransfer.effectAllowed = "move";
          setDragging(task.id);
        },
        onDragEnd: () => {
          setDragging(null);
          setHint(null);
        },
        onDragOver: (e) => onDragOver(e, task),
        onDragLeave: () => setHint((h) => h?.id === task.id ? null : h),
        onDrop: (e) => onDrop(e, task),
        addingSubtask: addingUnder === task.id,
        onAddSubtask: () => setAddingUnder(task.id),
        onCloseAdd: () => setAddingUnder(null),
        parts: partsByTask.get(task.id) ?? NO_PARTS
      },
      task.id
    )) }),
    /* @__PURE__ */ jsx23(AddField, { placeholder: "Add a top-level task\u2026", label: "New top-level task", onAdd: (title) => store.op({ op: "upsert_task", title }) }),
    /* @__PURE__ */ jsx23("p", { className: "outline-help muted", children: "Drag a row onto another to nest it, or to its top or bottom edge to place it beside. With a row focused: Alt+\u2191/\u2193 reorders, Alt+\u2192 nests under the row above, Alt+\u2190 moves it out a level." })
  ] });
}
function TaskRow(props) {
  const { plan, task, depth, number, expanded } = props;
  const collapsed = useStore((s) => s.collapsedTasks.includes(task.id));
  const [comments, setComments] = useState17(false);
  const kids = childrenOf(plan, task.id);
  const sub = kids.length ? countTasks({ tasks: [task, ...descendants(plan, task.id)] }) : null;
  const threads = useThreads({ kind: "task", id: task.id });
  const target = { kind: "task", id: task.id };
  const parts = props.parts;
  const siblings = childrenOf(plan, task.parentId);
  const index = siblings.findIndex((t) => t.id === task.id);
  const parent = task.parentId ? plan.tasks.find((t) => t.id === task.parentId) : void 0;
  const moves = {
    up: index > 0 ? { op: "move_task", id: task.id, parentId: task.parentId, index: index - 1 } : null,
    down: index < siblings.length - 1 ? { op: "move_task", id: task.id, parentId: task.parentId, index: index + 1 } : null,
    // Nest under the sibling above, at the end of its subtasks.
    indent: index > 0 ? { op: "move_task", id: task.id, parentId: siblings[index - 1].id, index: Number.MAX_SAFE_INTEGER } : null,
    // Out one level, right after the old parent.
    outdent: parent ? {
      op: "move_task",
      id: task.id,
      parentId: parent.parentId,
      index: childrenOf(plan, parent.parentId).findIndex((t) => t.id === parent.id) + 1
    } : null
  };
  const onKeyDown = (e) => {
    if (!e.altKey || isTyping(e.target)) return;
    const op = e.key === "ArrowUp" ? moves.up : e.key === "ArrowDown" ? moves.down : e.key === "ArrowRight" ? moves.indent : e.key === "ArrowLeft" ? moves.outdent : null;
    if (!op) return;
    e.preventDefault();
    void store.op(op).then(() => {
      window.requestAnimationFrame(() => document.querySelector(`#task-${task.id} .task-line`)?.focus());
    });
  };
  return /* @__PURE__ */ jsxs22(Focusable, { kind: "task", id: task.id, as: "div", className: classNames("task", `is-${task.status}`, props.dragging && "is-dragging"), children: [
    /* @__PURE__ */ jsxs22(
      "div",
      {
        className: classNames("task-line", props.dropZone && `drop-${props.dropZone}`),
        style: { ["--depth"]: depth },
        role: "treeitem",
        "aria-level": depth + 1,
        "aria-expanded": kids.length ? !collapsed : void 0,
        "aria-label": `${number} ${task.title}, ${STATUS_LABEL[task.status]}`,
        tabIndex: 0,
        draggable: true,
        onDragStart: props.onDragStart,
        onDragEnd: props.onDragEnd,
        onDragOver: props.onDragOver,
        onDragLeave: props.onDragLeave,
        onDrop: props.onDrop,
        onKeyDown,
        children: [
          /* @__PURE__ */ jsx23("span", { className: "drag-handle", "aria-hidden": "true", title: "Drag to move", children: "\u22EE\u22EE" }),
          kids.length ? /* @__PURE__ */ jsx23(
            "button",
            {
              type: "button",
              className: "twisty",
              "aria-label": collapsed ? `Show subtasks of ${task.title}` : `Hide subtasks of ${task.title}`,
              onClick: () => store.toggleTaskCollapsed(task.id),
              children: collapsed ? "\u25B8" : "\u25BE"
            }
          ) : /* @__PURE__ */ jsx23("span", { className: "twisty is-leaf", "aria-hidden": "true" }),
          /* @__PURE__ */ jsx23(StatusDot, { task }),
          /* @__PURE__ */ jsx23("span", { className: "task-num", children: number }),
          /* @__PURE__ */ jsx23(
            InlineText,
            {
              className: "task-title",
              value: task.title,
              label: "Task title",
              onSave: (title) => store.op({ op: "upsert_task", id: task.id, title })
            }
          ),
          /* @__PURE__ */ jsxs22("span", { className: "task-badges", children: [
            sub && /* @__PURE__ */ jsxs22("span", { className: "chip", title: `${sub.done} of ${sub.total} subtasks done`, children: [
              sub.done,
              "/",
              sub.total
            ] }),
            task.note && /* @__PURE__ */ jsx23("span", { className: classNames("chip is-note", task.status === "blocked" && "is-warning"), title: task.note, children: task.note }),
            task.files?.length ? /* @__PURE__ */ jsxs22("span", { className: "chip", title: task.files.join("\n"), children: [
              task.files.length,
              " file",
              task.files.length === 1 ? "" : "s"
            ] }) : null,
            parts.map(({ d, n }) => /* @__PURE__ */ jsxs22(
              "button",
              {
                type: "button",
                className: "chip is-part",
                title: `Builds "${n.label}" in ${d.title} \u2014 show it`,
                onClick: () => store.focus("node", `${d.id}:${n.id}`),
                children: [
                  /* @__PURE__ */ jsx23("span", { "aria-hidden": "true", children: KIND_GLYPH[n.kind] }),
                  " ",
                  n.label
                ]
              },
              `${d.id}:${n.id}`
            )),
            task.createdBy === "user" && /* @__PURE__ */ jsx23("span", { className: "chip is-you", children: "added by you" })
          ] }),
          /* @__PURE__ */ jsx23("span", { className: "spacer" }),
          /* @__PURE__ */ jsxs22("span", { className: "task-actions", children: [
            /* @__PURE__ */ jsx23("button", { type: "button", className: "icon-btn is-tiny", title: "Add subtask", "aria-label": `Add a subtask to ${task.title}`, onClick: props.onAddSubtask, children: /* @__PURE__ */ jsx23("span", { "aria-hidden": "true", children: "\uFF0B" }) }),
            /* @__PURE__ */ jsx23(MoveButton, { op: moves.outdent, glyph: "\u2190", label: `Move ${task.title} out a level` }),
            /* @__PURE__ */ jsx23(MoveButton, { op: moves.indent, glyph: "\u2192", label: `Nest ${task.title} under the task above` }),
            /* @__PURE__ */ jsx23(MoveButton, { op: moves.up, glyph: "\u2191", label: `Move ${task.title} up` }),
            /* @__PURE__ */ jsx23(MoveButton, { op: moves.down, glyph: "\u2193", label: `Move ${task.title} down` })
          ] }),
          /* @__PURE__ */ jsx23(CommentToggle, { target, label: task.title, open: comments, onToggle: () => setComments((v) => !v) }),
          /* @__PURE__ */ jsx23(
            "button",
            {
              type: "button",
              className: classNames("icon-btn is-tiny", expanded && "is-active", (Boolean(task.detail) || threads.length > 0) && "has-detail"),
              "aria-expanded": expanded,
              title: "Details",
              "aria-label": `Details of ${task.title}`,
              onClick: props.onToggleExpanded,
              children: /* @__PURE__ */ jsx23("span", { "aria-hidden": "true", children: expanded ? "\u2303" : "\u2304" })
            }
          )
        ]
      }
    ),
    (expanded || comments) && /* @__PURE__ */ jsxs22("div", { className: "task-detail", style: { ["--depth"]: depth }, children: [
      expanded && /* @__PURE__ */ jsx23(TaskDetail, { plan, task }),
      comments && /* @__PURE__ */ jsx23(ThreadPanel, { target, label: task.title })
    ] }),
    props.addingSubtask && /* @__PURE__ */ jsx23("div", { className: "task-add-sub", style: { ["--depth"]: depth + 1 }, children: /* @__PURE__ */ jsx23(
      AddField,
      {
        placeholder: `Subtask of "${task.title}"\u2026`,
        label: `New subtask of ${task.title}`,
        autoFocus: true,
        onCancel: props.onCloseAdd,
        onAdd: async (title) => {
          const ok = await store.op({ op: "upsert_task", parentId: task.id, title });
          if (ok && collapsed) store.toggleTaskCollapsed(task.id);
          return ok;
        }
      }
    ) })
  ] });
}
function TaskDetail({ plan, task }) {
  const [confirming, setConfirming] = useState17(false);
  const subtasks = descendants(plan, task.id).length;
  return /* @__PURE__ */ jsxs22("div", { className: "task-detail-body", children: [
    /* @__PURE__ */ jsxs22("div", { className: "field-row", children: [
      /* @__PURE__ */ jsx23("span", { className: "field-label", children: "Status" }),
      /* @__PURE__ */ jsx23(StatusPicker, { task })
    ] }),
    /* @__PURE__ */ jsxs22("div", { className: "field-row", children: [
      /* @__PURE__ */ jsx23("span", { className: "field-label", children: "Note" }),
      /* @__PURE__ */ jsx23(
        InlineText,
        {
          className: "task-note",
          value: task.note ?? "",
          placeholder: "One line \u2014 what it's blocked on, or what was done",
          label: "Status note",
          onSave: (note) => store.op({ op: "upsert_task", id: task.id, note })
        }
      )
    ] }),
    /* @__PURE__ */ jsxs22("div", { className: "field-col", children: [
      /* @__PURE__ */ jsx23("span", { className: "field-label", children: "Detail" }),
      /* @__PURE__ */ jsx23(
        MarkdownField,
        {
          value: task.detail ?? "",
          label: `detail of "${task.title}"`,
          placeholder: "No detail yet.",
          emptyAction: "Add approach or acceptance criteria",
          onSave: (detail) => store.op({ op: "upsert_task", id: task.id, detail })
        }
      )
    ] }),
    /* @__PURE__ */ jsxs22("div", { className: "field-col", children: [
      /* @__PURE__ */ jsx23("span", { className: "field-label", children: "Files" }),
      /* @__PURE__ */ jsx23(FilesField, { task })
    ] }),
    /* @__PURE__ */ jsxs22("div", { className: "task-detail-foot", children: [
      /* @__PURE__ */ jsxs22("span", { className: "muted", children: [
        task.id,
        " \xB7 ",
        task.createdBy === "user" ? "added by you" : "added by Claude"
      ] }),
      /* @__PURE__ */ jsx23("span", { className: "spacer" }),
      confirming ? /* @__PURE__ */ jsxs22("span", { className: "item-confirm", children: [
        "Remove",
        subtasks ? ` with ${subtasks} subtask(s)` : "",
        "?",
        /* @__PURE__ */ jsx23("button", { type: "button", className: "link is-danger", onClick: () => void store.op({ op: "remove", kind: "task", id: task.id }), children: "Remove" }),
        /* @__PURE__ */ jsx23("button", { type: "button", className: "link", onClick: () => setConfirming(false), children: "Keep" })
      ] }) : /* @__PURE__ */ jsx23("button", { type: "button", className: "link is-danger", onClick: () => setConfirming(true), children: "Remove task" })
    ] })
  ] });
}
function FilesField({ task }) {
  const [editing, setEditing] = useState17(false);
  const [draft, setDraft] = useState17((task.files ?? []).join("\n"));
  if (!editing) {
    return /* @__PURE__ */ jsxs22("div", { className: "files", children: [
      task.files?.length ? /* @__PURE__ */ jsx23("ul", { className: "plain-list mono", children: task.files.map((f) => /* @__PURE__ */ jsx23("li", { children: f }, f)) }) : /* @__PURE__ */ jsx23("span", { className: "muted", children: "None listed." }),
      " ",
      /* @__PURE__ */ jsx23(
        "button",
        {
          type: "button",
          className: "link",
          onClick: () => {
            setDraft((task.files ?? []).join("\n"));
            setEditing(true);
          },
          children: "Edit"
        }
      )
    ] });
  }
  return /* @__PURE__ */ jsxs22("div", { className: "md-field is-editing", children: [
    /* @__PURE__ */ jsx23("textarea", { className: "input mono", rows: 4, value: draft, "aria-label": "Files, one per line", onChange: (e) => setDraft(e.target.value) }),
    /* @__PURE__ */ jsxs22("div", { className: "md-field-foot", children: [
      /* @__PURE__ */ jsx23("span", { className: "muted", children: "One path per line" }),
      /* @__PURE__ */ jsx23("span", { className: "spacer" }),
      /* @__PURE__ */ jsx23("button", { type: "button", className: "btn btn-sm btn-ghost", onClick: () => setEditing(false), children: "Cancel" }),
      /* @__PURE__ */ jsx23(
        "button",
        {
          type: "button",
          className: "btn btn-sm btn-primary",
          onClick: () => {
            setEditing(false);
            void store.op({ op: "upsert_task", id: task.id, files: draft.split("\n").map((f) => f.trim()).filter(Boolean) });
          },
          children: "Save"
        }
      )
    ] })
  ] });
}
function MoveButton({ op, glyph, label }) {
  return /* @__PURE__ */ jsx23("button", { type: "button", className: "icon-btn is-tiny", disabled: !op, title: label, "aria-label": label, onClick: () => op && void store.op(op), children: /* @__PURE__ */ jsx23("span", { "aria-hidden": "true", children: glyph }) });
}
function StatusDot({ task }) {
  const next = NEXT_STATUS[task.status];
  return /* @__PURE__ */ jsx23(
    "button",
    {
      type: "button",
      className: classNames("status-dot", `is-${task.status}`),
      title: `${STATUS_LABEL[task.status]} \u2014 click to mark ${STATUS_LABEL[next].toLowerCase()}`,
      "aria-label": `${task.title}: ${STATUS_LABEL[task.status]}. Mark ${STATUS_LABEL[next].toLowerCase()}`,
      onClick: () => void store.op({ op: "upsert_task", id: task.id, status: next }),
      children: /* @__PURE__ */ jsx23("span", { "aria-hidden": "true", children: STATUS_GLYPH[task.status] })
    }
  );
}
function StatusPicker({ task }) {
  return /* @__PURE__ */ jsx23("div", { className: "segmented", role: "radiogroup", "aria-label": `Status of ${task.title}`, children: TASK_STATUSES.map((s) => /* @__PURE__ */ jsx23(
    "button",
    {
      type: "button",
      role: "radio",
      "aria-checked": task.status === s,
      className: classNames("seg", `status-${s}`, task.status === s && "is-active"),
      onClick: () => void store.op({ op: "upsert_task", id: task.id, status: s }),
      children: STATUS_LABEL[s]
    },
    s
  )) });
}
function Board({ plan, readOnly = false }) {
  const [over, setOver] = useState17(null);
  const { arrived, announcement } = useArrivals(plan);
  const leaves = outline(plan).map((r) => r.task).filter((t) => !hasChildren(plan, t.id));
  return /* @__PURE__ */ jsxs22("div", { className: classNames("board", readOnly && "is-readonly"), children: [
    TASK_STATUSES.map((status) => {
      const cards = leaves.filter((t) => t.status === status);
      return /* @__PURE__ */ jsxs22(
        "section",
        {
          className: classNames("board-col", `is-${status}`, over === status && "is-over"),
          "aria-label": STATUS_LABEL[status],
          onDragOver: (e) => {
            if (readOnly || !e.dataTransfer.types.includes(DRAG_TYPE)) return;
            e.preventDefault();
            setOver(status);
          },
          onDragLeave: () => setOver((cur) => cur === status ? null : cur),
          onDrop: (e) => {
            if (readOnly) return;
            e.preventDefault();
            setOver(null);
            const id = e.dataTransfer.getData(DRAG_TYPE);
            const task = plan.tasks.find((t) => t.id === id);
            if (task && task.status !== status) void store.op({ op: "upsert_task", id, status });
          },
          children: [
            /* @__PURE__ */ jsxs22("header", { className: "board-col-head", children: [
              /* @__PURE__ */ jsx23("span", { className: classNames("status-dot is-static", `is-${status}`), "aria-hidden": "true", children: STATUS_GLYPH[status] }),
              /* @__PURE__ */ jsx23("h2", { children: STATUS_LABEL[status] }),
              /* @__PURE__ */ jsx23("span", { className: "board-count", children: cards.length })
            ] }),
            /* @__PURE__ */ jsxs22("div", { className: "board-cards", children: [
              cards.map(
                (task) => readOnly ? /* @__PURE__ */ jsx23(TrackedCard, { plan, task, arrived: arrived.has(task.id) }, task.id) : /* @__PURE__ */ jsx23(BoardCard, { plan, task }, task.id)
              ),
              cards.length === 0 && /* @__PURE__ */ jsx23("p", { className: "board-empty", children: readOnly ? "Nothing here yet" : "Drop tasks here" })
            ] })
          ]
        },
        status
      );
    }),
    /* @__PURE__ */ jsx23("p", { className: "sr-only", "aria-live": "polite", children: announcement })
  ] });
}
function useArrivals(plan) {
  const last = useRef10(null);
  const timers = useRef10(/* @__PURE__ */ new Set());
  const [arrived, setArrived] = useState17(() => /* @__PURE__ */ new Set());
  const [announcement, setAnnouncement] = useState17("");
  const key = plan.tasks.map((t) => `${t.id}:${t.status}`).join("|");
  useEffect15(() => {
    const before = last.current;
    last.current = new Map(plan.tasks.map((t) => [t.id, t.status]));
    if (!before) return;
    const moved = plan.tasks.filter((t) => before.has(t.id) && before.get(t.id) !== t.status && !hasChildren(plan, t.id));
    if (!moved.length) return;
    const ids = moved.map((t) => t.id);
    setArrived((cur) => /* @__PURE__ */ new Set([...cur, ...ids]));
    setAnnouncement(moved.map((t) => `${t.title}: ${STATUS_LABEL[t.status].toLowerCase()}`).join(". "));
    const timer = window.setTimeout(() => {
      timers.current.delete(timer);
      setArrived((cur) => {
        const next = new Set(cur);
        for (const id of ids) next.delete(id);
        return next;
      });
    }, ARRIVAL_MS);
    timers.current.add(timer);
  }, [key]);
  useEffect15(
    () => () => {
      for (const timer of timers.current) window.clearTimeout(timer);
    },
    []
  );
  return { arrived, announcement };
}
function TrackedCard({ plan, task, arrived }) {
  const [open, setOpen] = useState17(false);
  const path = [];
  let cursor = task.parentId ? plan.tasks.find((t) => t.id === task.parentId) : void 0;
  while (cursor) {
    path.unshift(cursor.title);
    cursor = cursor.parentId ? plan.tasks.find((t) => t.id === cursor.parentId) : void 0;
  }
  const more = Boolean(task.detail?.trim() || task.files?.length);
  return /* @__PURE__ */ jsxs22(Focusable, { kind: "task", id: task.id, as: "article", className: classNames("board-card", "is-tracked", `is-${task.status}`, arrived && "is-arrived"), children: [
    path.length > 0 && /* @__PURE__ */ jsx23("p", { className: "board-path", children: path.join(" \u203A ") }),
    /* @__PURE__ */ jsxs22("p", { className: "board-title-row", children: [
      task.status === "in_progress" && /* @__PURE__ */ jsx23("span", { className: "working-dot", title: "Claude is on it", "aria-label": "Claude is on it" }),
      more ? /* @__PURE__ */ jsx23("button", { type: "button", className: "board-title", "aria-expanded": open, onClick: () => setOpen((v) => !v), children: task.title }) : /* @__PURE__ */ jsx23("span", { className: "board-title", children: task.title })
    ] }),
    task.note && /* @__PURE__ */ jsx23("p", { className: "board-note", children: task.note }),
    open && /* @__PURE__ */ jsxs22("div", { className: "board-more", children: [
      task.detail?.trim() && /* @__PURE__ */ jsx23(Markdown, { source: task.detail }),
      task.files?.length ? /* @__PURE__ */ jsx23("p", { className: "board-files mono", children: task.files.join(", ") }) : null
    ] }),
    /* @__PURE__ */ jsxs22("footer", { className: "board-foot", children: [
      /* @__PURE__ */ jsx23("span", { className: "item-id", children: task.id }),
      arrived && /* @__PURE__ */ jsx23("span", { className: "pill is-moved", children: "just moved" }),
      /* @__PURE__ */ jsx23("span", { className: "spacer" }),
      /* @__PURE__ */ jsx23("span", { className: classNames("board-state", `is-${task.status}`), children: STATUS_LABEL[task.status] })
    ] })
  ] });
}
function BoardCard({ plan, task }) {
  const path = [];
  let cursor = task.parentId ? plan.tasks.find((t) => t.id === task.parentId) : void 0;
  while (cursor) {
    path.unshift(cursor.title);
    cursor = cursor.parentId ? plan.tasks.find((t) => t.id === cursor.parentId) : void 0;
  }
  const comments = plan.threads.filter((t) => !t.resolved && t.target.kind === "task" && t.target.id === task.id).length;
  return /* @__PURE__ */ jsxs22(
    "article",
    {
      className: classNames("board-card", `is-${task.status}`),
      draggable: true,
      onDragStart: (e) => {
        e.dataTransfer.setData(DRAG_TYPE, task.id);
        e.dataTransfer.setData("text/plain", task.title);
        e.dataTransfer.effectAllowed = "move";
      },
      children: [
        path.length > 0 && /* @__PURE__ */ jsx23("p", { className: "board-path", children: path.join(" \u203A ") }),
        /* @__PURE__ */ jsx23("button", { type: "button", className: "board-title", onClick: () => store.focus("task", task.id), children: task.title }),
        task.note && /* @__PURE__ */ jsx23("p", { className: "board-note", children: task.note }),
        /* @__PURE__ */ jsxs22("footer", { className: "board-foot", children: [
          /* @__PURE__ */ jsx23("span", { className: "item-id", children: task.id }),
          comments > 0 && /* @__PURE__ */ jsxs22("span", { className: "chip", children: [
            "\u{1F4AC} ",
            comments
          ] }),
          /* @__PURE__ */ jsx23("span", { className: "spacer" }),
          /* @__PURE__ */ jsxs22("label", { className: "sr-only", htmlFor: `status-${task.id}`, children: [
            "Status of ",
            task.title
          ] }),
          /* @__PURE__ */ jsx23(
            "select",
            {
              id: `status-${task.id}`,
              className: "board-status",
              value: task.status,
              onChange: (e) => void store.op({ op: "upsert_task", id: task.id, status: e.target.value }),
              children: TASK_STATUSES.map((s) => /* @__PURE__ */ jsx23("option", { value: s, children: STATUS_LABEL[s] }, s))
            }
          )
        ] })
      ]
    }
  );
}
function hasChildren(plan, id) {
  return plan.tasks.some((t) => t.parentId === id);
}
function isTyping(target) {
  const el = target;
  return Boolean(el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable));
}
var NEXT_STATUS, NO_PARTS, DRAG_TYPE, ARRIVAL_MS;
var init_TasksView = __esm({
  "src/ui/views/TasksView.tsx"() {
    "use strict";
    init_store();
    init_Editable();
    init_Threads();
    init_Item();
    init_FlowCanvas();
    init_Progress();
    init_primitives();
    init_Markdown();
    init_format();
    init_plan();
    init_types();
    NEXT_STATUS = {
      todo: "in_progress",
      in_progress: "done",
      blocked: "in_progress",
      done: "todo"
    };
    NO_PARTS = [];
    DRAG_TYPE = "application/x-harness-task";
    ARRIVAL_MS = 2400;
  }
});

// src/ui/App.tsx
var App_exports = {};
__export(App_exports, {
  App: () => App
});
import { useCallback as useCallback2, useEffect as useEffect16, useRef as useRef11 } from "react";
import { Fragment as Fragment6, jsx as jsx24, jsxs as jsxs23 } from "react/jsx-runtime";
function App() {
  const session = useSession();
  const sessionId = useStore((s) => s.sessionId);
  const tab = useStore((s) => s.tab);
  const error = useStore((s) => s.error);
  const sidebarCollapsed = useStore((s) => s.collapsedSidebar);
  const drawerOpen = useStore((s) => s.drawerOpen);
  const tabs = useRef11(null);
  const plan = session?.plan ?? null;
  useDocumentTitle(session);
  useShortcuts();
  useDrawerDismiss(drawerOpen);
  const onTabKeyDown = useCallback2(
    (event) => {
      const delta = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
      let next;
      if (delta !== 0) next = TAB_IDS[(TAB_IDS.indexOf(tab) + delta + TAB_IDS.length) % TAB_IDS.length];
      else if (event.key === "Home") next = TAB_IDS[0];
      else if (event.key === "End") next = TAB_IDS[TAB_IDS.length - 1];
      if (!next) return;
      event.preventDefault();
      store.setTab(next);
      tabs.current?.querySelector(`#${tabId(next)}`)?.focus();
    },
    [tab]
  );
  return /* @__PURE__ */ jsxs23("div", { className: classNames("app", sidebarCollapsed && "is-sidebar-collapsed", drawerOpen && "is-drawer-open"), children: [
    /* @__PURE__ */ jsx24("a", { className: "skip-link", href: `#${panelId(tab)}`, children: "Skip to content" }),
    /* @__PURE__ */ jsx24(Sidebar, {}),
    drawerOpen && /* @__PURE__ */ jsx24("button", { type: "button", className: "scrim", "aria-label": "Close the session list", onClick: () => store.setDrawer(false) }),
    /* @__PURE__ */ jsx24("main", { className: "main", "aria-label": "Plan", children: !sessionId ? /* @__PURE__ */ jsx24(NoSession, { error }) : !session ? error ? /* @__PURE__ */ jsx24(SessionUnavailable, { error }) : /* @__PURE__ */ jsx24(Loading, {}) : /* @__PURE__ */ jsxs23(Fragment6, { children: [
      /* @__PURE__ */ jsx24(Header, { session }),
      /* @__PURE__ */ jsx24(ConnectionBar, {}),
      /* @__PURE__ */ jsx24(WaitingBanner, { session }),
      /* @__PURE__ */ jsx24(PhaseStrip, { session }),
      !plan ? /* @__PURE__ */ jsx24(NoPlan, { session }) : /* @__PURE__ */ jsxs23(Fragment6, { children: [
        /* @__PURE__ */ jsx24("nav", { className: "tabs", role: "tablist", "aria-label": "Plan views", ref: tabs, onKeyDown: onTabKeyDown, children: TAB_IDS.map((t) => /* @__PURE__ */ jsx24(TabButton, { id: t, active: tab === t, plan }, t)) }),
        /* @__PURE__ */ jsx24("div", { className: "view", id: panelId(tab), role: "tabpanel", "aria-labelledby": tabId(tab), tabIndex: -1, children: /* @__PURE__ */ jsxs23(ErrorBoundary, { label: `${TAB_LABEL[tab]} view`, resetKey: `${sessionId}:${tab}`, children: [
          tab === "overview" && /* @__PURE__ */ jsx24(OverviewView, {}),
          tab === "diagrams" && /* @__PURE__ */ jsx24(DiagramsView, {}),
          tab === "tasks" && /* @__PURE__ */ jsx24(TasksView, {})
        ] }) }, tab)
      ] })
    ] }) }),
    /* @__PURE__ */ jsx24(Toasts, {})
  ] });
}
function TabButton({ id, active, plan }) {
  const badge = tabBadge(id, plan);
  return /* @__PURE__ */ jsxs23(
    "button",
    {
      type: "button",
      role: "tab",
      id: tabId(id),
      "aria-selected": active,
      "aria-controls": panelId(id),
      tabIndex: active ? 0 : -1,
      className: classNames("tab", active && "is-active"),
      onClick: () => store.setTab(id),
      children: [
        TAB_LABEL[id],
        badge && /* @__PURE__ */ jsxs23(Fragment6, { children: [
          /* @__PURE__ */ jsx24("span", { className: classNames("tab-badge", `is-${badge.tone}`), "aria-hidden": "true", children: badge.text }),
          /* @__PURE__ */ jsx24("span", { className: "sr-only", children: badge.label })
        ] })
      ]
    }
  );
}
function tabBadge(id, plan) {
  switch (id) {
    case "diagrams":
      return plan.diagrams.length ? { text: String(plan.diagrams.length), tone: "neutral", label: `${plan.diagrams.length} diagrams` } : null;
    case "tasks": {
      const c = countTasks(plan);
      return c.total ? { text: `${c.done}/${c.total}`, tone: "neutral", label: `${c.done} of ${c.total} done` } : null;
    }
    default:
      return null;
  }
}
function Header({ session }) {
  const saving = useStore((s) => s.saving);
  const plan = session.plan;
  const counts = countTasks(plan);
  return /* @__PURE__ */ jsxs23("header", { className: "head", children: [
    /* @__PURE__ */ jsxs23("div", { className: "head-main", children: [
      /* @__PURE__ */ jsx24(SessionsToggle, {}),
      plan ? /* @__PURE__ */ jsx24(
        InlineText,
        {
          as: "h1",
          className: "head-title",
          value: plan.title,
          label: "Plan title",
          readOnly: isLocked(plan),
          onSave: (title) => store.op({ op: "set_meta", title })
        }
      ) : /* @__PURE__ */ jsx24("h1", { className: "head-title", children: session.title }),
      saving > 0 && /* @__PURE__ */ jsx24("span", { className: "muted head-saving", children: "saving\u2026" }),
      /* @__PURE__ */ jsx24("span", { className: "spacer" }),
      /* @__PURE__ */ jsx24(Handoff, {}),
      /* @__PURE__ */ jsx24(ThemeToggle, {})
    ] }),
    /* @__PURE__ */ jsxs23("div", { className: "head-meta", children: [
      /* @__PURE__ */ jsx24("span", { className: classNames("head-status", `is-${session.waiting ? "waiting" : session.status}`), title: "The Claude session this plan belongs to", children: session.waiting ? "Claude is waiting on you" : session.status === "active" ? "Claude is working" : session.status === "idle" ? "Claude is idle" : "session ended" }),
      plan && plan.title !== session.title && /* @__PURE__ */ jsx24("span", { className: "head-stat", children: session.title }),
      session.branch && /* @__PURE__ */ jsx24("code", { className: "head-branch", children: session.branch }),
      counts.total > 0 && /* @__PURE__ */ jsxs23("span", { className: "head-progress", children: [
        /* @__PURE__ */ jsx24(ProgressBar, { counts, compact: true }),
        /* @__PURE__ */ jsxs23("span", { className: "head-stat", children: [
          counts.done,
          "/",
          counts.total,
          " tasks"
        ] })
      ] }),
      /* @__PURE__ */ jsx24("span", { className: "head-path", title: session.cwd, children: session.cwd })
    ] })
  ] });
}
function SessionsToggle() {
  const collapsed = useStore((s) => s.collapsedSidebar);
  const drawerOpen = useStore((s) => s.drawerOpen);
  const narrow = () => window.innerWidth <= 900;
  const label = collapsed ? "Show sessions" : "Hide sessions";
  return /* @__PURE__ */ jsx24(
    "button",
    {
      type: "button",
      className: "icon-btn sessions-toggle",
      title: `${label} ( [ )`,
      "aria-label": label,
      "aria-expanded": narrow() ? drawerOpen : !collapsed,
      onClick: () => narrow() ? store.setDrawer(true) : store.toggleSidebar(),
      children: /* @__PURE__ */ jsx24("span", { "aria-hidden": "true", children: "\u2630" })
    }
  );
}
function NoPlan({ session }) {
  return /* @__PURE__ */ jsx24("div", { className: "view", children: /* @__PURE__ */ jsx24(
    EmptyState,
    {
      title: "No plan yet",
      hint: /* @__PURE__ */ jsxs23(Fragment6, { children: [
        "In Claude's chat, run ",
        /* @__PURE__ */ jsx24("code", { children: "/harness <what you want to build>" }),
        ". Claude investigates the code, then publishes its plan here \u2014 the architecture, diagrams and a task breakdown \u2014 and asks what it needs to know in the chat."
      ] }),
      action: /* @__PURE__ */ jsx24("button", { type: "button", className: "btn", onClick: () => void store.op({ op: "set_meta", title: session.title || "Untitled plan" }), children: "Start a plan by hand" })
    }
  ) });
}
function Loading() {
  return /* @__PURE__ */ jsx24("div", { className: "view", children: /* @__PURE__ */ jsxs23("div", { className: "loading", role: "status", "aria-live": "polite", children: [
    /* @__PURE__ */ jsx24("span", { className: "spinner", "aria-hidden": "true" }),
    "Loading the plan\u2026"
  ] }) });
}
function SessionUnavailable({ error }) {
  const sessions = useStore((s) => s.sessions);
  const unauthorized = /401|unauthorized/i.test(error);
  const other = sessions[0];
  return /* @__PURE__ */ jsx24("div", { className: "view", children: /* @__PURE__ */ jsx24(
    EmptyState,
    {
      title: unauthorized ? "This page is not signed in to the harness" : "This session is not available",
      hint: unauthorized ? /* @__PURE__ */ jsxs23(Fragment6, { children: [
        "Open the harness with ",
        /* @__PURE__ */ jsx24("code", { children: "/harness-open" }),
        " in Claude, or ",
        /* @__PURE__ */ jsx24("code", { children: "harness open" }),
        " in a terminal \u2014 the link it prints carries the key this page needs."
      ] }) : /* @__PURE__ */ jsxs23(Fragment6, { children: [
        "It may have been deleted, or it ended long enough ago to be cleaned up. (",
        error,
        ")"
      ] }),
      action: !unauthorized && other ? /* @__PURE__ */ jsxs23("button", { type: "button", className: "btn", onClick: () => void store.selectSession(other.sessionId), children: [
        "Open ",
        other.planTitle ?? other.title
      ] }) : void 0
    }
  ) });
}
function NoSession({ error }) {
  if (error && /401|unauthorized/i.test(error)) return /* @__PURE__ */ jsx24(SessionUnavailable, { error });
  return /* @__PURE__ */ jsx24("div", { className: "view", children: /* @__PURE__ */ jsx24(
    EmptyState,
    {
      title: "No session yet",
      hint: /* @__PURE__ */ jsxs23(Fragment6, { children: [
        "Start Claude Code in a project with the harness enabled, then run ",
        /* @__PURE__ */ jsx24("code", { children: "/harness" }),
        ". Sessions appear here the moment they register.",
        error && /* @__PURE__ */ jsxs23("span", { className: "error-text", children: [
          " \xB7 ",
          error
        ] })
      ] }),
      action: /* @__PURE__ */ jsxs23("p", { className: "empty-hint", children: [
        "If a session is running and nothing shows up, the hooks are not firing \u2014 run ",
        /* @__PURE__ */ jsx24("code", { children: "harness doctor" }),
        "."
      ] })
    }
  ) });
}
function useDocumentTitle(session) {
  const title = session?.plan?.title ?? session?.title ?? "Coplan";
  const waiting = Boolean(session?.waiting);
  useEffect16(() => {
    document.title = waiting ? `\u25CF ${title} \u2014 Claude is waiting` : `${title} \u2014 plan`;
  }, [title, waiting]);
}
function useDrawerDismiss(open) {
  useEffect16(() => {
    if (!open) return;
    const onKey = (event) => {
      if (event.key === "Escape") store.setDrawer(false);
    };
    const onResize = () => {
      if (window.innerWidth > 900) store.setDrawer(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);
}
function useShortcuts() {
  useEffect16(() => {
    const handler = (event) => {
      const target = event.target;
      const typing = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable);
      if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      if (event.key === "[") {
        event.preventDefault();
        store.toggleSidebar();
        return;
      }
      const index = Number(event.key) - 1;
      const tab = TAB_IDS[index];
      if (tab && store.getState().session?.plan) {
        event.preventDefault();
        store.setTab(tab);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
}
var TAB_LABEL, tabId, panelId;
var init_App = __esm({
  "src/ui/App.tsx"() {
    "use strict";
    init_store();
    init_Sidebar();
    init_Toasts();
    init_ConnectionBar();
    init_ThemeToggle();
    init_Handoff();
    init_Submit();
    init_Editable();
    init_Progress();
    init_primitives();
    init_ErrorBoundary();
    init_OverviewView();
    init_DiagramsView();
    init_TasksView();
    init_format();
    init_plan();
    TAB_LABEL = {
      diagrams: "Architecture",
      tasks: "Tasks",
      overview: "Overview"
    };
    tabId = (id) => `tab-${id}`;
    panelId = (id) => `panel-${id}`;
  }
});

// src/test/canvas.test.tsx
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

// src/test/dom-env.ts
import { JSDOM } from "jsdom";
function setupDom(url = "http://127.0.0.1:1234/#/session/s1") {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url,
    pretendToBeVisual: true
  });
  const win = dom.window;
  const globals = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    location: dom.window.location,
    history: dom.window.history,
    localStorage: dom.window.localStorage,
    HTMLElement: win["HTMLElement"],
    HTMLInputElement: win["HTMLInputElement"],
    HTMLTextAreaElement: win["HTMLTextAreaElement"],
    HTMLSelectElement: win["HTMLSelectElement"],
    Element: win["Element"],
    Node: win["Node"],
    Event: win["Event"],
    CustomEvent: win["CustomEvent"],
    KeyboardEvent: win["KeyboardEvent"],
    MouseEvent: win["MouseEvent"],
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: (cb) => setTimeout(() => cb(Date.now()), 0),
    cancelAnimationFrame: (id) => clearTimeout(id)
  };
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
  }
  globalThis["IS_REACT_ACT_ENVIRONMENT"] = true;
  if (!("IntersectionObserver" in globalThis)) {
    Object.defineProperty(globalThis, "IntersectionObserver", {
      value: class {
        constructor(cb) {
          this.cb = cb;
        }
        observe() {
        }
        unobserve() {
        }
        disconnect() {
        }
        takeRecords() {
          return [];
        }
      },
      writable: true,
      configurable: true
    });
  }
  if (!("ResizeObserver" in globalThis)) {
    Object.defineProperty(globalThis, "ResizeObserver", {
      value: class {
        observe() {
        }
        unobserve() {
        }
        disconnect() {
        }
      },
      writable: true,
      configurable: true
    });
  }
  if (!("DOMMatrixReadOnly" in globalThis)) {
    Object.defineProperty(globalThis, "DOMMatrixReadOnly", {
      value: class {
        m22;
        constructor(transform) {
          const scale = /scale\(([\d.]+)\)/.exec(transform ?? "");
          this.m22 = scale ? Number(scale[1]) : 1;
        }
      },
      writable: true,
      configurable: true
    });
  }
  globalThis.MutationObserver ??= dom.window.MutationObserver;
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = function scrollIntoView() {
    };
  }
  if (!("EventSource" in globalThis)) {
    Object.defineProperty(globalThis, "EventSource", {
      value: class {
        constructor(url2) {
          this.url = url2;
        }
        onopen = null;
        onerror = null;
        onmessage = null;
        close() {
        }
      },
      writable: true,
      configurable: true
    });
  }
  return dom;
}
function stubFetch(handler) {
  const posts2 = [];
  Object.defineProperty(globalThis, "fetch", {
    value: async (input, init) => {
      const route = String(input);
      if (init?.method && init.method !== "GET") {
        posts2.push({ route, body: init.body ? JSON.parse(String(init.body)) : {} });
      }
      const body = handler(route, init);
      const status = body && typeof body === "object" && "__status" in body ? Number(body.__status) : 200;
      return {
        ok: status < 400,
        status,
        statusText: status < 400 ? "OK" : "Error",
        headers: { get: (name) => name.toLowerCase() === "content-type" ? typeof body === "string" ? "text/plain" : "application/json" : null },
        json: async () => body,
        text: async () => typeof body === "string" ? body : JSON.stringify(body)
      };
    },
    writable: true,
    configurable: true
  });
  return { posts: posts2 };
}

// src/test/canvas.test.tsx
import { jsx as jsx25 } from "react/jsx-runtime";
setupDom();
var { render, fireEvent, within, cleanup, act, screen, waitFor } = await import("@testing-library/react");
var { App: App2 } = await Promise.resolve().then(() => (init_App(), App_exports));
var { store: store2 } = await Promise.resolve().then(() => (init_store(), store_exports));
var { publishPlan: publishPlan2 } = await Promise.resolve().then(() => (init_plan(), plan_exports));
function makePlan() {
  return publishPlan2(
    null,
    {
      title: "Orders",
      diagrams: [
        {
          title: "Components",
          direction: "LR",
          nodes: [
            { id: "user", label: "Customer", kind: "actor" },
            { id: "gw", label: "Gateway", kind: "service" },
            { id: "api", label: "API", kind: "service" },
            { id: "db", label: "Postgres", kind: "datastore" },
            { id: "cache", label: "Redis", kind: "datastore" }
          ],
          edges: [
            { source: "user", target: "gw" },
            { source: "gw", target: "api", label: "REST" },
            { source: "api", target: "db", label: "SQL" },
            { source: "api", target: "cache" }
          ]
        }
      ]
    },
    Date.now()
  ).plan;
}
function makeSession(plan = makePlan()) {
  const now = Date.now();
  return { sessionId: "s1", cwd: "/repo", repoRoot: "/repo", branch: "main", title: "repo", status: "idle", waiting: null, surface: "unknown", link: null, createdAt: now, updatedAt: now, plan };
}
var posts;
async function boot(session = makeSession()) {
  ({ posts } = stubFetch((route) => {
    if (route.startsWith("/api/sessions")) return { sessions: [], version: "test" };
    if (route.endsWith("/plan/ops")) return { plan: store2.getState().session?.plan, changes: [] };
    if (route.startsWith("/api/session/")) return { session };
    return { ok: true };
  }));
  render(/* @__PURE__ */ jsx25(App2, {}));
  await act(async () => {
    await store2.init();
  });
  await waitFor(() => assert.ok(document.querySelector(".react-flow__node")));
}
var lastGraph = () => {
  const op = posts.filter((p) => p.route.endsWith("/plan/ops")).flatMap((p) => p.body["ops"]).filter((o) => o["op"] === "upsert_diagram").at(-1);
  assert.ok(op, "a save was sent");
  return { nodes: op["nodes"], edges: op["edges"] };
};
var saves = () => posts.filter((p) => p.route.endsWith("/plan/ops")).length;
var ends = (g = lastGraph()) => g.edges.map((e) => `${e["source"]}->${e["target"]}`).sort();
var nodeEl = (label) => [...document.querySelectorAll(".react-flow__node")].find((n) => n.querySelector(".flow-node-label")?.textContent === label);
var selectBox = async (label) => {
  await act(async () => {
    fireEvent.click(nodeEl(label));
  });
};
var press = async (key, init = {}) => {
  await act(async () => {
    fireEvent.keyDown(document.activeElement ?? document.body, { key, ...init });
  });
};
var settle = () => act(async () => {
  await new Promise((r) => setTimeout(r, 30));
});
beforeEach(() => {
  cleanup();
  window.localStorage.clear();
  store2.set({ sessions: [], sessionId: null, session: null, tab: "diagrams", diagramId: null, toasts: [], focusTarget: null, collapsedSidebar: false });
});
after(() => cleanup());
test("Tab adds a box after the selected one, connected, and starts naming it", async () => {
  await boot();
  await selectBox("API");
  await press("Tab");
  const g = lastGraph();
  const made = g.nodes.find((n) => !["user", "gw", "api", "db", "cache"].includes(n["id"]));
  assert.ok(made, "a new box");
  assert.ok(ends(g).includes(`api->${made["id"]}`), "connected from the selected box");
  assert.ok(document.querySelector(".flow-node-input"), "named in place");
});
test("Tab, a name, Tab again: a chain built without leaving the keyboard", async () => {
  await boot();
  await selectBox("Postgres");
  await press("Tab");
  let input = document.querySelector(".flow-node-input");
  await act(async () => {
    fireEvent.change(input, { target: { value: "Replica" } });
    fireEvent.keyDown(input, { key: "Tab" });
  });
  assert.equal(document.querySelector(".flow-node-input"), null, "Tab finished the name");
  await press("Tab");
  input = document.querySelector(".flow-node-input");
  await act(async () => {
    fireEvent.change(input, { target: { value: "Backup" } });
    fireEvent.keyDown(input, { key: "Enter" });
  });
  const g = lastGraph();
  const id = (label) => g.nodes.find((n) => n["label"] === label)?.["id"];
  assert.ok(ends(g).includes(`db->${id("Replica")}`));
  assert.ok(ends(g).includes(`${id("Replica")}->${id("Backup")}`), "the second box follows the first");
});
test("Shift+Tab adds one before it, and Enter one beside it fed by the same boxes", async () => {
  await boot();
  await selectBox("API");
  await press("Tab", { shiftKey: true });
  let g = lastGraph();
  const before = g.nodes.at(-1)["id"];
  assert.ok(ends(g).includes(`${before}->api`));
  await act(async () => {
    document.activeElement?.blur();
  });
  await selectBox("Postgres");
  await press("Enter");
  g = lastGraph();
  const beside = g.nodes.at(-1);
  assert.equal(beside["kind"], "datastore", "the same kind as its neighbour");
  assert.ok(ends(g).includes(`api->${beside["id"]}`), "fed by Postgres\u2019s parent");
});
test("right-clicking empty canvas offers a box of any kind, right there", async () => {
  await boot();
  await act(async () => {
    fireEvent.contextMenu(document.querySelector(".react-flow__pane"), { clientX: 300, clientY: 200 });
  });
  const menu = screen.getByRole("menu", { name: "Canvas" });
  await act(async () => {
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: "Queue" }));
  });
  assert.equal(lastGraph().nodes.at(-1)["kind"], "queue");
  assert.equal(screen.queryByRole("menu"), null, "and the menu closes");
});
test("a box's menu does what its shortcuts do, and names them", async () => {
  await boot();
  await act(async () => {
    fireEvent.contextMenu(nodeEl("Redis"), { clientX: 300, clientY: 200 });
  });
  const menu = screen.getByRole("menu", { name: "Redis" });
  assert.match(menu.textContent ?? "", /Add a box after itTab/);
  assert.match(menu.textContent ?? "", /Delete, keeping the flow/);
  await act(async () => {
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Connect to/ }));
  });
  await act(async () => {
    fireEvent.click(within(screen.getByRole("menu", { name: "Connect to" })).getByRole("menuitem", { name: "Customer" }));
  });
  assert.ok(ends().includes("cache->user"));
});
test("the menu works from the keyboard: Shift+F10 opens it, arrows move, Escape closes", async () => {
  await boot();
  await selectBox("Gateway");
  await press("F10", { shiftKey: true });
  const menu = screen.getByRole("menu", { name: "Gateway" });
  assert.equal(document.activeElement?.textContent, "RenameF2", "the first item has focus");
  await act(async () => {
    fireEvent.keyDown(menu, { key: "ArrowDown" });
  });
  assert.equal(document.activeElement?.getAttribute("role"), "menuitemradio", "the kind choices are next");
  await act(async () => {
    fireEvent.keyDown(menu, { key: "Escape" });
  });
  assert.equal(screen.queryByRole("menu"), null);
});
test("typing on a selected box renames it, from the key typed \u2014 even a digit the app would use", async () => {
  await boot();
  await selectBox("API");
  await press("2");
  const input = await waitFor(() => {
    const el = document.querySelector(".flow-node-input");
    assert.ok(el);
    return el;
  });
  assert.equal(input.value, "2", "typed over the old name");
  assert.equal(store2.getState().tab, "diagrams", '"2" did not switch to the Tasks tab');
  await act(async () => {
    fireEvent.change(input, { target: { value: "2nd API" } });
    fireEvent.keyDown(input, { key: "Enter" });
  });
  assert.equal(lastGraph().nodes.find((n) => n["id"] === "api")["label"], "2nd API");
});
test("with nothing selected, the app keeps its own keys", async () => {
  await boot();
  await press("2");
  assert.equal(store2.getState().tab, "tasks");
});
test("Alt+Backspace deletes a box and joins the flow around it", async () => {
  await boot();
  await selectBox("Gateway");
  await press("Backspace", { altKey: true });
  const g = lastGraph();
  assert.ok(!g.nodes.some((n) => n["id"] === "gw"));
  assert.deepEqual(ends(g), ["api->cache", "api->db", "user->api"]);
});
test("undo puts back the graph before the last edit, and redo puts it forward again", async () => {
  await boot();
  await selectBox("Gateway");
  await press("Backspace", { altKey: true });
  assert.ok(!lastGraph().nodes.some((n) => n["id"] === "gw"));
  await press("z", { ctrlKey: true });
  await settle();
  assert.ok(lastGraph().nodes.some((n) => n["id"] === "gw"), "the box is back");
  assert.deepEqual(ends(), ["api->cache", "api->db", "gw->api", "user->gw"], "and its arrows");
  await press("z", { ctrlKey: true, shiftKey: true });
  await settle();
  assert.ok(!lastGraph().nodes.some((n) => n["id"] === "gw"), "redone");
});
test("undo is a toolbar button too, disabled until there is something to undo", async () => {
  await boot();
  const undo = screen.getByRole("button", { name: "Undo", hidden: true });
  assert.equal(undo.disabled, true);
  await selectBox("API");
  await press("Tab");
  assert.equal(undo.disabled, false);
});
test("undo will not revert a change made elsewhere, and says so", async () => {
  await boot();
  await selectBox("API");
  await press("Tab");
  const before = saves();
  const s = store2.getState().session;
  const plan = structuredClone(s.plan);
  plan.diagrams[0].nodes.push({ id: "claude", label: "Added by Claude", kind: "service" });
  plan.diagrams[0].rev += 7;
  plan.version += 1;
  await act(async () => {
    store2.apply({ type: "snapshot", session: { ...s, plan } });
  });
  await settle();
  await act(async () => {
    document.activeElement?.blur();
  });
  await press("z", { ctrlKey: true });
  assert.equal(saves(), before, "nothing was sent");
  assert.match(store2.getState().toasts.at(-1)?.text ?? "", /changed elsewhere/);
});
test("selecting a box lights up what it connects to by direction, and fades the rest", async () => {
  await boot();
  await selectBox("API");
  await waitFor(() => assert.ok(document.querySelector(".react-flow__node.rel-focus, .flow-node.rel-focus")));
  const rel = (label) => nodeEl(label).querySelector(".flow-node-rel")?.textContent ?? null;
  assert.equal(rel("Gateway"), "from \u2192");
  assert.equal(rel("Postgres"), "\u2192 to");
  assert.equal(rel("Redis"), "\u2192 to");
  assert.ok(nodeEl("Customer").classList.contains("rel-dim"), "two steps away fades");
  assert.match(document.querySelector(".flow-legend")?.textContent ?? "", /from →API→ to/);
});
test("holding Alt reaches two steps out", async () => {
  await boot();
  await selectBox("API");
  await act(async () => {
    fireEvent.keyDown(document.body, { key: "Alt", altKey: true });
  });
  await waitFor(() => assert.equal(nodeEl("Customer").querySelector(".flow-node-rel")?.textContent, "before \u2192"));
  await act(async () => {
    fireEvent.keyUp(document.body, { key: "Alt" });
  });
  await waitFor(() => assert.ok(nodeEl("Customer").classList.contains("rel-dim")));
});
test("hovering previews a box\u2019s relationships without selecting it", async () => {
  await boot();
  await act(async () => {
    fireEvent.mouseEnter(nodeEl("Gateway"));
  });
  await waitFor(() => assert.equal(nodeEl("Customer").querySelector(".flow-node-rel")?.textContent, "from \u2192"));
  assert.equal(document.querySelectorAll(".react-flow__node.selected").length, 0);
});
test("? shows every shortcut, and Escape puts it away", async () => {
  await boot();
  await press("?");
  const sheet = screen.getByRole("dialog", { name: "Keyboard shortcuts" });
  assert.match(sheet.textContent ?? "", /Tab.*a box after the selected one/);
  assert.match(sheet.textContent ?? "", /delete, keeping the flow through it/);
  await act(async () => {
    fireEvent.keyDown(sheet, { key: "Escape" });
  });
  assert.equal(screen.queryByRole("dialog"), null);
});
//# sourceMappingURL=canvas.test.js.map

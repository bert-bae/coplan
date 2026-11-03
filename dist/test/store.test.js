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
  return process.env.CC_HARNESS_HOME || path.join(homedir(), ".claude", "cc-harness");
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
var NODE_KINDS, TASK_STATUSES;
var init_types = __esm({
  "src/shared/types.ts"() {
    "use strict";
    NODE_KINDS = ["component", "service", "datastore", "queue", "external", "actor", "note"];
    TASK_STATUSES = ["todo", "in_progress", "blocked", "done"];
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
    questions: [],
    threads: [],
    changes: [],
    seq: 0,
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
  for (const q of plan.questions) scan(q.id);
  for (const c of plan.threads) scan(c.id);
  for (const ch of plan.changes) scan(ch.target.id);
  return `${prefix}${max + 1}`;
}
function idTaken(plan, id) {
  return plan.sections.some((s) => s.id === id) || plan.diagrams.some((d) => d.id === id) || plan.tasks.some((t) => t.id === id) || plan.questions.some((q) => q.id === id) || plan.threads.some((c) => c.id === id);
}
function claimId(plan, kind, wanted) {
  const id = clean(wanted, 40);
  if (id && /^[A-Za-z0-9_.-]+$/.test(id) && !idTaken(plan, id)) return id;
  return nextId(plan, kind);
}
function record(plan, author, kind, target, summary, now) {
  plan.seq += 1;
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
function markReadByClaude(plan, now = Date.now()) {
  plan.claudeReadSeq = plan.seq;
  plan.claudeReadAt = now;
}
function settleClaudeRead(plan) {
  if (unreadByClaude(plan).length === 0) plan.claudeReadSeq = plan.seq;
}
function publishPlan(prev, input, now = Date.now()) {
  if (prev && unreadByClaude(prev).length > 0) {
    throw new PlanError(
      `The user has made ${unreadByClaude(prev).length} change(s) to the plan since you last read it. Call harness_plan_read first, then publish again (or use harness_plan_edit for targeted changes) so their edits are not overwritten.`
    );
  }
  const title = clean(input.title, MAX_TITLE);
  if (!title) throw new PlanError("A plan needs a title.");
  const base = prev ? structuredClone(prev) : emptyPlan(title, now);
  const next = { ...base, title, summary: clean(input.summary, MAX_TEXT) ?? base.summary };
  const sections = [];
  for (const raw of input.sections ?? []) {
    const old = base.sections.find((s) => s.id === raw.id);
    const id = old ? old.id : claimIdAmong(next, "section", raw.id, sections);
    const body = clean(raw.body, MAX_TEXT) ?? "";
    const sTitle = clean(raw.title, MAX_TITLE) ?? "Untitled";
    const same = old && old.title === sTitle && old.body === body;
    sections.push({ id, title: sTitle, body, updatedAt: same ? old.updatedAt : now, updatedBy: same ? old.updatedBy : "claude" });
  }
  const diagrams = [];
  for (const raw of input.diagrams ?? []) {
    const old = base.diagrams.find((d) => d.id === raw.id);
    const id = old ? old.id : claimIdAmong(next, "diagram", raw.id, diagrams);
    const dTitle = clean(raw.title, MAX_TITLE) ?? "Diagram";
    const caption = clean(raw.caption, MAX_TEXT);
    const graph = buildGraph(raw.nodes ?? [], raw.edges ?? [], old, dTitle);
    const direction = validDirection(raw.direction) ?? old?.direction ?? "LR";
    const same = old && old.title === dTitle && old.caption === caption && old.direction === direction && JSON.stringify([old.nodes, old.edges]) === JSON.stringify([graph.nodes, graph.edges]);
    diagrams.push({
      id,
      title: dTitle,
      ...graph,
      direction,
      ...caption ? { caption } : {},
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
  const questions = [];
  for (const raw of input.questions ?? []) {
    const text = clean(raw?.question, MAX_TEXT);
    if (!text) throw new PlanError("Every question needs its question text.");
    const old = base.questions.find((q) => q.id === raw.id);
    const id = old ? old.id : claimIdAmong(next, "question", raw.id, questions);
    questions.push(buildQuestion(id, raw, old, tasks, now));
  }
  for (const q of base.questions) {
    if (q.askedBy === "user" && !questions.some((x) => x.id === q.id)) questions.push(q);
  }
  next.sections = sections;
  next.diagrams = diagrams;
  next.tasks = tasks;
  next.questions = questions;
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
  const key = { section: "sections", diagram: "diagrams", task: "tasks", question: "questions" }[kind];
  const probe = { ...plan, [key]: [...plan[key], ...fresh] };
  return claimId(probe, kind, wanted);
}
function detachIfOrphaned(plan, before2, thread) {
  if (targetExists(plan, thread.target)) return thread;
  const label = describeTarget(before2, thread.target);
  return { ...thread, target: { kind: "plan", id: "" }, text: `(on removed ${label}) ${thread.text}` };
}
function buildQuestion(id, raw, old, tasks, now) {
  const header = clean(raw.header, 40);
  const context = clean(raw.context, MAX_TEXT);
  const taskId = raw.taskId && tasks.some((t) => t.id === raw.taskId) ? raw.taskId : void 0;
  return {
    id,
    question: clean(raw.question, MAX_TEXT) ?? old?.question ?? "",
    ...header ? { header } : {},
    ...context ? { context } : {},
    options: raw.options ? toOptions(raw.options) : old?.options ?? [],
    ...raw.multiSelect ? { multiSelect: true } : {},
    ...taskId ? { taskId } : {},
    askedBy: old?.askedBy ?? "claude",
    createdAt: old?.createdAt ?? now,
    ...old?.answer ? { answer: old.answer } : {}
  };
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
  if (author === "claude") settleClaudeRead(next);
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
        out.push(log("edited", { kind: "plan", id: "" }, `renamed the plan to "${title}"`));
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
        const title2 = clean(op.title, MAX_TITLE);
        const body = typeof op.body === "string" ? clean(op.body, MAX_TEXT) ?? "" : void 0;
        if (title2) existing.title = title2;
        if (body !== void 0) existing.body = body;
        existing.updatedAt = now;
        existing.updatedBy = author;
        const out = [log("edited", ref("section", existing.id), `edited section "${existing.title}"`)];
        if (typeof op.index === "number") moveInList(plan.sections, existing.id, op.index);
        return out;
      }
      const title = clean(op.title, MAX_TITLE);
      if (!title) throw new PlanError(op.id ? `No section "${op.id}".` : "A new section needs a title.");
      const section = {
        id: claimId(plan, "section", op.id),
        title,
        body: clean(op.body, MAX_TEXT) ?? "",
        updatedAt: now,
        updatedBy: author
      };
      insertAt(plan.sections, section, op.index);
      return [log("created", ref("section", section.id), `added section "${title}"`)];
    }
    case "upsert_diagram": {
      const existing = op.id ? plan.diagrams.find((d) => d.id === op.id) : void 0;
      if (existing) {
        const before2 = structuredClone(existing);
        const title2 = clean(op.title, MAX_TITLE);
        if (title2) existing.title = title2;
        if (op.nodes || op.edges) {
          const graph = buildGraph(op.nodes ?? existing.nodes, op.edges ?? existing.edges, existing, existing.title);
          existing.nodes = graph.nodes;
          existing.edges = graph.edges;
        }
        const direction = validDirection(op.direction);
        if (direction) existing.direction = direction;
        if (typeof op.caption === "string") setOptional(existing, "caption", clean(op.caption, MAX_TEXT));
        if (typeof op.index === "number") moveInList(plan.diagrams, existing.id, op.index);
        const what = describeDiagramEdit(before2, existing);
        if (!what) return [];
        existing.updatedAt = now;
        existing.updatedBy = author;
        const kind = what.startsWith("rearranged") ? "moved" : "edited";
        return [log(kind, ref("diagram", existing.id), `${what} in diagram "${existing.title}"`)];
      }
      if (op.id) throw new PlanError(`No diagram "${op.id}".`);
      const title = clean(op.title, MAX_TITLE) ?? "Diagram";
      const caption = clean(op.caption, MAX_TEXT);
      const diagram = {
        id: claimId(plan, "diagram", void 0),
        title,
        ...buildGraph(op.nodes ?? [], op.edges ?? [], void 0, title),
        direction: validDirection(op.direction) ?? "LR",
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
    case "upsert_question": {
      const existing = op.id ? plan.questions.find((q) => q.id === op.id) : void 0;
      if (existing) {
        const text2 = clean(op.question, MAX_TEXT);
        if (text2) existing.question = text2;
        if (typeof op.header === "string") setOptional(existing, "header", clean(op.header, 40));
        if (typeof op.context === "string") setOptional(existing, "context", clean(op.context, MAX_TEXT));
        if (op.options) existing.options = toOptions(op.options);
        if (typeof op.multiSelect === "boolean") setOptional(existing, "multiSelect", op.multiSelect || void 0);
        if (op.taskId !== void 0) setOptional(existing, "taskId", op.taskId ? requireTask(plan, op.taskId).id : void 0);
        return [log("edited", ref("question", existing.id), `edited question "${short(existing.question)}"`)];
      }
      const text = clean(op.question, MAX_TEXT);
      if (!text) throw new PlanError(op.id ? `No question "${op.id}".` : "A new question needs its question text.");
      if (op.taskId) requireTask(plan, op.taskId);
      const question = buildQuestion(claimId(plan, "question", op.id), { ...op, question: text }, void 0, plan.tasks, now);
      question.askedBy = author;
      plan.questions.push(question);
      return [log("created", ref("question", question.id), `asked "${short(text)}"`)];
    }
    case "answer": {
      const question = plan.questions.find((q) => q.id === op.id);
      if (!question) throw new PlanError(`No question "${op.id}".`);
      const selected = (op.selected ?? []).map((s) => String(s).trim()).filter(Boolean);
      const text = clean(op.text, MAX_TEXT) ?? "";
      if (!selected.length && !text) throw new PlanError("An answer needs a picked option or some text.");
      if (!question.multiSelect && selected.length > 1) {
        throw new PlanError(`"${short(question.question)}" takes one option, not ${selected.length}.`);
      }
      const answer = { selected, text, by: author, at: now };
      const had = Boolean(question.answer);
      question.answer = answer;
      return [log("answered", ref("question", question.id), `${had ? "changed the answer to" : "answered"} "${short(question.question)}": ${short(renderAnswer(answer), 80)}`)];
    }
    case "clear_answer": {
      const question = plan.questions.find((q) => q.id === op.id);
      if (!question) throw new PlanError(`No question "${op.id}".`);
      if (!question.answer) return [];
      delete question.answer;
      return [log("edited", ref("question", question.id), `reopened "${short(question.question)}"`)];
    }
    case "remove":
      return removeItem(plan, op.kind, op.id, log);
    case "comment": {
      const target = normalizeTarget(op.target);
      if (!targetExists(plan, target)) throw new PlanError(`Nothing to comment on at ${target.kind} "${target.id}".`);
      const text = clean(op.text, MAX_TEXT);
      if (!text) throw new PlanError("A comment needs text.");
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
      for (const q of plan.questions) if (q.taskId && doomed.has(q.taskId)) delete q.taskId;
      const extra = doomed.size > 1 ? ` and its ${doomed.size - 1} subtask(s)` : "";
      summary = `removed task "${t.title}"${extra}`;
      break;
    }
    case "question": {
      const q = plan.questions.find((x) => x.id === id);
      if (!q) throw new PlanError(`No question "${id}".`);
      plan.questions = plan.questions.filter((x) => x.id !== id);
      summary = `removed question "${short(q.question)}"`;
      break;
    }
    default:
      throw new PlanError(`Cannot remove a "${kind}".`);
  }
  plan.threads = plan.threads.map((t) => detachIfOrphaned(plan, before2, t));
  return [log("deleted", { kind, id }, summary)];
}
function buildGraph(rawNodes, rawEdges, old, title) {
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
    const x = finite(raw.x) ?? prev?.x;
    const y = finite(raw.y) ?? prev?.y;
    nodes.push({
      id,
      label: clean(raw.label, 120) ?? prev?.label ?? id,
      kind: validKind(raw.kind) ?? prev?.kind ?? "component",
      ...detail ? { detail } : {},
      ...x !== void 0 && y !== void 0 ? { x: Math.round(x), y: Math.round(y) } : {}
    });
  }
  const ids = new Set(nodes.map((n) => n.id));
  const edges = [];
  for (const raw of rawEdges) {
    const source = clean(raw?.source, 60);
    const target = clean(raw?.target, 60);
    if (!source || !target) throw new PlanError(`Diagram "${title}": every edge needs a source and a target.`);
    for (const end of [source, target]) {
      if (!ids.has(end)) throw new PlanError(`Diagram "${title}": an edge refers to node "${end}", which is not in the diagram.`);
    }
    let id = clean(raw.id, 80) ?? `${source}->${target}`;
    for (let n = 2; edges.some((e) => e.id === id); n++) id = `${source}->${target}#${n}`;
    const label = clean(raw.label, 120);
    edges.push({ id, source, target, ...label ? { label } : {}, ...raw.dashed ? { dashed: true } : {} });
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
    return b && (b.label !== n.label || b.kind !== n.kind || (b.detail ?? "") !== (n.detail ?? ""));
  });
  const moved = after2.nodes.filter((n) => {
    const b = before2.nodes.find((x) => x.id === n.id);
    return b && (b.x !== n.x || b.y !== n.y);
  });
  const edgeKey = (e) => `${e.source}->${e.target}`;
  const linked = after2.edges.filter((e) => !before2.edges.some((b) => edgeKey(b) === edgeKey(e)));
  const unlinked = before2.edges.filter((e) => !after2.edges.some((a) => edgeKey(a) === edgeKey(e)));
  const relabeled = after2.edges.filter((e) => {
    const b = before2.edges.find((x) => edgeKey(x) === edgeKey(e));
    return b && ((b.label ?? "") !== (e.label ?? "") || Boolean(b.dashed) !== Boolean(e.dashed));
  });
  const list = (items) => items.length > 3 ? `${items.slice(0, 3).join(", ")} and ${items.length - 3} more` : items.join(", ");
  if (added.length) parts.push(`added ${list(added.map((n) => `"${n.label}"`))}`);
  if (removed.length) parts.push(`removed ${list(removed.map((n) => `"${n.label}"`))}`);
  if (changed.length) parts.push(`edited ${list(changed.map((n) => `"${n.label}"`))}`);
  if (linked.length) parts.push(`connected ${list(linked.map((e) => `${label(after2, e.source)} \u2192 ${label(after2, e.target)}`))}`);
  if (unlinked.length) parts.push(`disconnected ${list(unlinked.map((e) => `${label(before2, e.source)} \u2192 ${label(before2, e.target)}`))}`);
  if (relabeled.length) parts.push(`relabelled ${list(relabeled.map((e) => `${label(after2, e.source)} \u2192 ${label(after2, e.target)}`))}`);
  if (before2.direction !== after2.direction) parts.push(`turned it ${after2.direction === "LR" ? "left-to-right" : "top-to-bottom"}`);
  if ((before2.caption ?? "") !== (after2.caption ?? "")) parts.push("edited the caption");
  if (parts.length) return parts.join("; ");
  if (moved.length) return `rearranged ${moved.length} node(s)`;
  return null;
}
function validKind(value) {
  return NODE_KINDS.includes(value) ? value : void 0;
}
function validDirection(value) {
  return value === "LR" || value === "TB" ? value : void 0;
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
    case "question":
      return plan.questions.some((q) => q.id === target.id);
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
    case "question": {
      const q = plan.questions.find((x) => x.id === target.id);
      return q ? `question "${short(q.question)}"` : `question ${target.id}`;
    }
    default:
      return "an item";
  }
}
function renderAnswer(answer) {
  const picked = answer.selected.join(", ");
  if (picked && answer.text) return `${picked} \u2014 ${answer.text}`;
  return picked || answer.text;
}
function validStatus(value) {
  return TASK_STATUSES.includes(value) ? value : void 0;
}
function toOptions(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((o) => {
    if (typeof o === "string") return o.trim() ? { label: o.trim().slice(0, 120) } : null;
    if (!o || typeof o !== "object") return null;
    const label = clean(o.label, 120);
    if (!label) return null;
    const description = clean(o.description, 400);
    return { label, ...description ? { description } : {} };
  }).filter((o) => o !== null).slice(0, MAX_OPTIONS);
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
var PlanError, MAX_CHANGES, MAX_TITLE, MAX_TEXT, MAX_OPTIONS, MAX_TASKS, PREFIX, MAX_NODES, MAX_EDGES, STATUS_WORDS;
var init_plan = __esm({
  "src/shared/plan.ts"() {
    "use strict";
    init_types();
    PlanError = class extends Error {
    };
    MAX_CHANGES = 500;
    MAX_TITLE = 200;
    MAX_TEXT = 2e4;
    MAX_OPTIONS = 8;
    MAX_TASKS = 400;
    PREFIX = { section: "s", diagram: "d", task: "t", question: "q", thread: "c" };
    MAX_NODES = 120;
    MAX_EDGES = 300;
    STATUS_WORDS = {
      todo: "to do",
      in_progress: "in progress",
      blocked: "blocked",
      done: "done"
    };
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
function newSession(sessionId, cwd) {
  const now = Date.now();
  return {
    sessionId,
    cwd,
    repoRoot: null,
    branch: null,
    title: path2.basename(cwd) || sessionId.slice(0, 8),
    status: "active",
    createdAt: now,
    updatedAt: now,
    plan: null
  };
}
function summarize(s) {
  const plan = s.plan;
  return {
    sessionId: s.sessionId,
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
    openQuestions: plan?.questions.filter((q) => !q.answer).length ?? 0,
    openThreads: plan?.threads.filter((t) => !t.resolved).length ?? 0,
    unreadByClaude: unreadByClaude(plan).length
  };
}
function readState(file) {
  try {
    if (!existsSync2(file)) return void 0;
    const state = JSON.parse(readFileSync2(file, "utf8"));
    if (!state?.sessionId) return void 0;
    migrate(state);
    return state;
  } catch {
    return void 0;
  }
}
function migrate(state) {
  const raw = state;
  state.createdAt ??= state.updatedAt ?? Date.now();
  if (state.status !== "ended") state.status = "idle";
  const oldPlan = raw["plan"];
  if (oldPlan && !Array.isArray(oldPlan["tasks"])) {
    const plan = emptyPlan(String(oldPlan["title"] ?? state.title));
    plan.summary = typeof oldPlan["summary"] === "string" ? oldPlan["summary"] : "";
    if (typeof oldPlan["markdown"] === "string" && oldPlan["markdown"].trim()) {
      plan.sections.push({ id: "s1", title: "Notes", body: oldPlan["markdown"], updatedAt: Date.now(), updatedBy: "claude" });
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
  state.plan ??= null;
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
      ensure(id, cwd) {
        let state = this.sessions.get(id);
        if (!state) {
          state = readState(paths.sessionState(id)) ?? newSession(id, cwd || process.cwd());
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
      /** Most recently updated session rooted at `cwd`. */
      findByCwd(cwd) {
        const normalized = path2.resolve(cwd);
        const matches = (value) => !!value && path2.resolve(value) === normalized;
        return this.all().find((s) => matches(s.cwd) || matches(s.repoRoot));
      }
      findByPid(pid) {
        return this.all().find((s) => s.claudePid === pid);
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
      /** Move Claude's read position to the end of the change log. */
      markRead(id) {
        const session = this.sessions.get(id);
        if (!session?.plan) return;
        if (session.plan.claudeReadSeq === session.plan.seq && session.plan.claudeReadAt) return;
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
      broadcastSessionList() {
        this.emitEvent({ type: "sessions", sessions: this.summaries() });
      }
    };
  }
});

// src/test/store.test.ts
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync as rmSync2, existsSync as existsSync3, mkdirSync as mkdirSync3, writeFileSync as writeFileSync2 } from "node:fs";
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
  assert.ok(seen.includes("snapshot"));
  assert.ok(seen.includes("sessions"), "the rail hears about it too");
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
//# sourceMappingURL=store.test.js.map

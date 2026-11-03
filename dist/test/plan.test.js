// src/test/plan.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

// src/shared/types.ts
var NODE_KINDS = ["component", "service", "datastore", "queue", "external", "actor", "note"];
var TASK_STATUSES = ["todo", "in_progress", "blocked", "done"];

// src/shared/plan.ts
var PlanError = class extends Error {
};
var MAX_CHANGES = 500;
var MAX_TITLE = 200;
var MAX_TEXT = 2e4;
var MAX_OPTIONS = 8;
var MAX_TASKS = 400;
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
var PREFIX = { section: "s", diagram: "d", task: "t", question: "q", thread: "c" };
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
function claimIdAmong(plan, kind, wanted, fresh2) {
  const key = { section: "sections", diagram: "diagrams", task: "tasks", question: "questions" }[kind];
  const probe = { ...plan, [key]: [...plan[key], ...fresh2] };
  return claimId(probe, kind, wanted);
}
function detachIfOrphaned(plan, before, thread) {
  if (targetExists(plan, thread.target)) return thread;
  const label = describeTarget(before, thread.target);
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
        const before = structuredClone(existing);
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
        const what = describeDiagramEdit(before, existing);
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
  plan.threads = plan.threads.map((t) => detachIfOrphaned(plan, before, t));
  return [log("deleted", { kind, id }, summary)];
}
var MAX_NODES = 120;
var MAX_EDGES = 300;
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
function describeDiagramEdit(before, after) {
  const parts = [];
  if (before.title !== after.title) parts.push(`renamed it from "${before.title}"`);
  const label = (d, id) => d.nodes.find((n) => n.id === id)?.label ?? id;
  const added = after.nodes.filter((n) => !before.nodes.some((b) => b.id === n.id));
  const removed = before.nodes.filter((n) => !after.nodes.some((a) => a.id === n.id));
  const changed = after.nodes.filter((n) => {
    const b = before.nodes.find((x) => x.id === n.id);
    return b && (b.label !== n.label || b.kind !== n.kind || (b.detail ?? "") !== (n.detail ?? ""));
  });
  const moved = after.nodes.filter((n) => {
    const b = before.nodes.find((x) => x.id === n.id);
    return b && (b.x !== n.x || b.y !== n.y);
  });
  const edgeKey = (e) => `${e.source}->${e.target}`;
  const linked = after.edges.filter((e) => !before.edges.some((b) => edgeKey(b) === edgeKey(e)));
  const unlinked = before.edges.filter((e) => !after.edges.some((a) => edgeKey(a) === edgeKey(e)));
  const relabeled = after.edges.filter((e) => {
    const b = before.edges.find((x) => edgeKey(x) === edgeKey(e));
    return b && ((b.label ?? "") !== (e.label ?? "") || Boolean(b.dashed) !== Boolean(e.dashed));
  });
  const list = (items) => items.length > 3 ? `${items.slice(0, 3).join(", ")} and ${items.length - 3} more` : items.join(", ");
  if (added.length) parts.push(`added ${list(added.map((n) => `"${n.label}"`))}`);
  if (removed.length) parts.push(`removed ${list(removed.map((n) => `"${n.label}"`))}`);
  if (changed.length) parts.push(`edited ${list(changed.map((n) => `"${n.label}"`))}`);
  if (linked.length) parts.push(`connected ${list(linked.map((e) => `${label(after, e.source)} \u2192 ${label(after, e.target)}`))}`);
  if (unlinked.length) parts.push(`disconnected ${list(unlinked.map((e) => `${label(before, e.source)} \u2192 ${label(before, e.target)}`))}`);
  if (relabeled.length) parts.push(`relabelled ${list(relabeled.map((e) => `${label(after, e.source)} \u2192 ${label(after, e.target)}`))}`);
  if (before.direction !== after.direction) parts.push(`turned it ${after.direction === "LR" ? "left-to-right" : "top-to-bottom"}`);
  if ((before.caption ?? "") !== (after.caption ?? "")) parts.push("edited the caption");
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

// src/daemon/render.ts
var STATUS_MARK = { todo: "[ ]", in_progress: "[~]", blocked: "[!]", done: "[x]" };
function renderPlan(plan, opts = {}) {
  const unread = unreadByClaude(plan);
  const out = [];
  out.push(`# ${plan.title}`);
  const counts = countTasks(plan);
  const meta = [
    `revision ${plan.revision}`,
    counts.total ? `tasks ${counts.done}/${counts.total} done` : "no tasks",
    `${plan.questions.filter((q) => !q.answer).length} open question(s)`,
    `${plan.threads.filter((t) => !t.resolved).length} open comment(s)`
  ];
  out.push(`_${meta.join(" \xB7 ")}${opts.url ? ` \xB7 UI: ${opts.url}` : ""}_`);
  out.push("");
  out.push(renderChanges(plan, unread));
  if (opts.changesOnly) {
    const openQuestions = plan.questions.filter((q) => !q.answer && q.askedBy === "user");
    if (openQuestions.length) out.push("", "## Questions the user asked you", ...openQuestions.map((q) => renderQuestion(plan, q)));
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
    out.push("", "## Diagrams");
    for (const d of plan.diagrams) out.push("", ...renderDiagram(d));
  }
  out.push("", `## Tasks${counts.total ? ` (${counts.done}/${counts.total} done)` : ""}`);
  const rows = outline(plan);
  if (rows.length === 0) out.push("_(no tasks yet)_");
  for (const { task, depth } of rows) {
    const pad = "  ".repeat(depth);
    const by = task.createdBy === "user" ? " _(added by the user)_" : "";
    const note = task.note ? ` \u2014 ${task.note}` : "";
    out.push(`${pad}- ${STATUS_MARK[task.status]} ${task.id} ${task.title}${by}${note}`);
    if (task.files?.length) out.push(`${pad}  files: ${task.files.join(", ")}`);
    if (task.detail) for (const line of task.detail.trim().split("\n")) out.push(`${pad}  ${line}`);
  }
  if (plan.questions.length) {
    out.push("", "## Questions");
    for (const q of plan.questions) out.push(renderQuestion(plan, q));
  }
  const open = plan.threads.filter((t) => !t.resolved);
  if (open.length) {
    out.push("", "## Open comments");
    for (const t of open) out.push(renderThread(plan, t));
  }
  out.push("", `_Statuses: ${Object.entries(STATUS_MARK).map(([k, v]) => `${v} ${k}`).join(", ")}_`);
  return out.join("\n").trim();
}
function renderDiagram(d) {
  const lines = [`### [${d.id}] ${d.title} _(${d.direction === "LR" ? "left to right" : "top to bottom"}${d.updatedBy === "user" ? ", edited by the user" : ""})_`];
  if (d.caption) lines.push(d.caption.trim());
  lines.push("nodes:");
  if (d.nodes.length === 0) lines.push("- _(none)_");
  for (const n of d.nodes) lines.push(`- ${n.id}: "${n.label}" (${n.kind})${n.detail ? ` \u2014 ${n.detail.replace(/\n/g, " ")}` : ""}`);
  if (d.edges.length) {
    lines.push("edges:");
    for (const e of d.edges) {
      lines.push(`- ${e.source} \u2192 ${e.target}${e.label ? ` "${e.label}"` : ""}${e.dashed ? " (dashed)" : ""}`);
    }
  }
  return lines;
}
function renderChanges(plan, unread) {
  if (unread.length === 0) {
    return plan.claudeReadAt ? "## Since you last read\nNothing \u2014 the user has not changed the plan." : "## Since you last read\nThis is your first read of this plan.";
  }
  const lines = [`## Since you last read \u2014 ${unread.length} change(s) by the user`];
  for (const c of unread) lines.push(`- ${c.summary} [${c.target.kind}${c.target.id ? ` ${c.target.id}` : ""}]`);
  return lines.join("\n");
}
function renderQuestion(plan, q) {
  const who2 = q.askedBy === "user" ? "asked by the user" : "asked by you";
  const header = q.header ? `[${q.header}] ` : "";
  const task = q.taskId ? ` (holds up ${q.taskId})` : "";
  const lines = [`- [${q.id}] ${header}${q.question} _(${who2}${task})_`];
  if (q.context) lines.push(`  context: ${q.context.trim().replace(/\n/g, "\n  ")}`);
  if (q.options.length) {
    lines.push(`  options${q.multiSelect ? " (multi-select)" : ""}: ${q.options.map((o) => o.description ? `${o.label} (${o.description})` : o.label).join("; ")}`);
  }
  if (q.answer) {
    lines.push(`  \u2192 ANSWERED by ${q.answer.by === "user" ? "the user" : "you"}: ${renderAnswer(q.answer)}`);
  } else {
    lines.push(q.askedBy === "user" ? '  \u2192 UNANSWERED \u2014 answer it with harness_plan_edit {op:"answer"}' : "  \u2192 unanswered");
  }
  return lines.join("\n");
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
  const unread = unreadByClaude(plan);
  if (!plan || unread.length === 0) return null;
  const kinds = /* @__PURE__ */ new Map();
  for (const c of unread) kinds.set(c.kind, (kinds.get(c.kind) ?? 0) + 1);
  const parts = [...kinds.entries()].map(([k, n]) => `${n} ${k}`).join(", ");
  return `[cc-harness] The user has changed the plan "${plan.title}" in the harness UI since you last read it (${parts}). Call harness_plan_read before acting on the plan.`;
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
  ],
  questions: [{ question: "Which cache?", header: "Backend", options: ["Redis", { label: "In-memory", description: "Lost on restart." }] }]
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
  assert.equal(plan.questions[0].id, "q1");
  assert.equal(plan.questions[0].options[1].description, "Lost on restart.");
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
  const { plan } = applyOps(fresh(), [{ op: "answer", id: "q1", selected: ["Redis"], text: "we already run it" }], "user");
  const unread = unreadByClaude(plan);
  assert.equal(unread.length, 1);
  assert.match(unread[0].summary, /answered "Which cache\?": Redis — we already run it/);
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
test("a republish keeps answers, comments and statuses on surviving ids", () => {
  let plan = applyOps(
    fresh(),
    [
      { op: "answer", id: "q1", selected: ["Redis"] },
      { op: "comment", target: { kind: "task", id: "t2" }, text: "use the pooled client" },
      { op: "upsert_task", id: "t2", status: "done" }
    ],
    "user"
  ).plan;
  plan.claudeReadSeq = plan.seq;
  const next = publishPlan(plan, {
    ...INPUT,
    tasks: [{ id: "t1", title: "Storage layer", subtasks: [{ id: "t2", title: "Cache client (pooled)" }] }],
    questions: [{ id: "q1", question: "Which cache?", options: ["Redis", "In-memory"] }]
  }).plan;
  assert.equal(next.questions[0].answer?.selected[0], "Redis");
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
test("removing a task removes its subtasks and unlinks its questions", () => {
  let plan = applyOps(fresh(), [{ op: "upsert_question", question: "TTL?", taskId: "t3" }], "claude").plan;
  plan = applyOps(plan, [{ op: "remove", kind: "task", id: "t1" }], "user").plan;
  assert.deepEqual(plan.tasks.map((t) => t.id), ["t4"]);
  assert.equal(plan.questions.find((q) => q.question === "TTL?")?.taskId, void 0);
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
    () => applyOps(before, [{ op: "upsert_task", title: "Fine" }, { op: "answer", id: "q99", text: "nope" }], "user"),
    /Edit 2 \(answer\): No question "q99"/
  );
  assert.equal(before.tasks.length, 4, "the plan passed in is untouched");
});
test("ids are never reused, even after a delete", () => {
  let plan = applyOps(fresh(), [{ op: "remove", kind: "task", id: "t4" }], "user").plan;
  plan = applyOps(plan, [{ op: "upsert_task", title: "New" }], "user").plan;
  assert.ok(plan.tasks.some((t) => t.id === "t5"));
  assert.ok(!plan.tasks.some((t) => t.id === "t4"));
});
test("a single-choice question refuses two answers", () => {
  assert.throws(() => applyOps(fresh(), [{ op: "answer", id: "q1", selected: ["Redis", "In-memory"] }], "user"), /takes one option/);
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
test("dragging boxes is logged as a rearrangement, and positions survive a republish", () => {
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
  assert.equal(moved.changes.at(-1).kind, "moved");
  assert.match(moved.changes.at(-1).summary, /rearranged 3 node/);
  moved.claudeReadSeq = moved.seq;
  const republished = publishPlan(moved, { ...INPUT, diagrams: [{ id: "d1", ...INPUT.diagrams[0] }] }).plan;
  assert.equal(republished.diagrams[0].nodes.find((n) => n.id === "cache")?.x, 200, "Claude did not restate it, so it stays put");
});
test("an edit that changes nothing logs nothing", () => {
  const plan = fresh();
  const d = plan.diagrams[0];
  const { changes } = applyOps(plan, [{ op: "upsert_diagram", id: d.id, nodes: d.nodes, edges: d.edges }], "user");
  assert.equal(changes.length, 0);
});
test("the rendering leads with the changes and carries every id", () => {
  const plan = applyOps(fresh(), [{ op: "upsert_question", question: "Should we shard?" }], "user").plan;
  const text = renderPlan(plan, { url: "http://x" });
  assert.ok(text.indexOf("Since you last read") < text.indexOf("## Tasks"));
  assert.match(text, /- \[ \] t2 Cache client/);
  assert.match(text, /- \[!\] t3 Invalidation/);
  assert.match(text, /\[d1\] Components/);
  assert.match(text, /- api → cache "get"/);
  assert.match(text, /\[q2\] Should we shard\? _\(asked by the user\)_/);
  assert.match(text, /UNANSWERED — answer it with harness_plan_edit/);
});
test("changes-only rendering skips the document", () => {
  const plan = applyOps(fresh(), [{ op: "comment", target: { kind: "plan", id: "" }, text: "looks good" }], "user").plan;
  const text = renderPlan(plan, { changesOnly: true });
  assert.match(text, /commented on the plan: looks good/);
  assert.match(text, /Comments waiting on you/);
  assert.doesNotMatch(text, /## Tasks/);
});
//# sourceMappingURL=plan.test.js.map

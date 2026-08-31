// src/test/feedback.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

// src/daemon/gates.ts
function renderFeedback(items) {
  if (items.length === 0) return "";
  const skipped = items.find((item) => item.skippedGate)?.skippedGate;
  const parts = [
    skipped ? `[cc-harness] The user skipped the ${skipped.kind.replace("_", " ")} gate ("${skipped.prompt}") and sent this message instead. That gate is closed \u2014 do not wait on it:` : "[cc-harness] The user submitted feedback in the review UI:"
  ];
  for (const item of items) {
    if (item.text) parts.push(`
${item.text}`);
    for (const thread2 of item.threads ?? []) {
      parts.push(renderThread(thread2));
    }
  }
  if (skipped) {
    parts.push(
      "\nAct on the message above instead of the step you were waiting on. Publish a new gate when you reach the next point that needs the user."
    );
    return parts.join("\n");
  }
  parts.push(
    "\nAddress each comment, then reply to it with harness_reply({ thread_id, text }) saying what you changed or why you disagree. When they are all answered, call harness_publish_diff again so the user can re-review."
  );
  return parts.join("\n");
}
function renderThread(thread2) {
  const range = thread2.startLine === thread2.endLine ? `${thread2.startLine}` : `${thread2.startLine}-${thread2.endLine}`;
  const lines = [`
\u2022 [${thread2.id}] ${thread2.file}:${range} (${thread2.side === "old" ? "before" : "after"})`];
  if (thread2.excerpt) {
    lines.push("  ```");
    for (const l of thread2.excerpt.split("\n")) lines.push(`  ${l}`);
    lines.push("  ```");
  }
  lines.push(`  \u2192 ${thread2.body}`);
  return lines.join("\n");
}
function renderGateResult(gate) {
  const result = gate.result;
  if (!result) return `[cc-harness] Gate ${gate.kind} is still open.`;
  const header = {
    approved: "approved",
    changes_requested: "requested changes",
    rejected: "rejected this",
    answered: "answered"
  };
  const parts = [`[cc-harness] The user ${header[result.verdict] ?? result.verdict} at the ${gate.kind} gate.`];
  if (result.comment) parts.push(`
${result.comment}`);
  if (result.steps?.length) {
    const edited = result.steps.filter((s) => s.comment || s.status === "dropped");
    if (edited.length) {
      parts.push("\nPlan changes:");
      for (const step of edited) {
        if (step.status === "dropped") parts.push(`\u2022 DROP \u2014 ${step.title}`);
        else parts.push(`\u2022 ${step.title}
  \u2192 ${step.comment}`);
      }
    }
    parts.push(`
Approved plan (${result.steps.filter((s) => s.status !== "dropped").length} steps):`);
    for (const [i, step] of result.steps.filter((s) => s.status !== "dropped").entries()) {
      parts.push(`${i + 1}. ${step.title}${step.detail ? ` \u2014 ${step.detail}` : ""}`);
    }
  }
  for (const thread2 of result.threads ?? []) parts.push(renderThread(thread2));
  if (result.ship) {
    const ship = result.ship;
    parts.push(
      `
Ship: provider=${ship.provider} steps=${ship.steps.join(" \u2192 ")}${ship.branch ? ` branch=${ship.branch}` : ""}${ship.baseBranch ? ` base=${ship.baseBranch}` : ""}`
    );
    if (ship.outcome) {
      parts.push(ship.outcome.ok ? `Result: ${ship.outcome.output}` : `FAILED: ${ship.outcome.output}`);
      if (ship.outcome.url) parts.push(`URL: ${ship.outcome.url}`);
    }
    if (ship.directive) {
      parts.push(
        `
ACTION REQUIRED \u2014 the user chose an MCP-backed provider, so you must open the pull request yourself:`,
        ship.directive,
        `
Title (use verbatim):
${ship.title}`,
        `
Body (use verbatim):
${ship.body}`,
        `
Then report the resulting URL with harness_note.`
      );
    }
  }
  if (result.verdict === "approved") {
    parts.push("\nProceed with the next stage.");
  } else if (result.verdict === "changes_requested") {
    parts.push(
      result.threads?.length ? "\nAddress each comment above, then reply to it with harness_reply({ thread_id, text })." : "\nAddress the feedback above before moving on."
    );
  } else if (result.verdict === "rejected") {
    parts.push("\nStop and wait for further direction from the user.");
  }
  return parts.join("\n");
}

// src/shared/hooks.ts
function stopBlock(reason) {
  return {
    decision: "block",
    reason,
    hookSpecificOutput: {
      hookEventName: "Stop",
      decision: "block",
      reason,
      additionalContext: reason
    }
  };
}
function additionalContext(event, text) {
  return {
    suppressOutput: true,
    hookSpecificOutput: {
      hookEventName: event,
      additionalContext: text
    }
  };
}

// src/test/feedback.test.ts
var thread = {
  id: "t1",
  file: "src/app.ts",
  side: "new",
  startLine: 12,
  endLine: 14,
  body: "This should handle the null case.",
  excerpt: "+const value = map.get(key);\n+return value.trim();",
  createdAt: 0,
  resolved: false
};
test("a line comment renders with its id, file, range and source", () => {
  const out = renderThread(thread);
  assert.match(out, /\[t1\]/, "the thread id is carried so the model can reply into it");
  assert.match(out, /src\/app\.ts:12-14/);
  assert.match(out, /value\.trim\(\)/);
  assert.match(out, /handle the null case/);
});
test("single-line comments render without a range", () => {
  assert.match(renderThread({ ...thread, endLine: 12 }), /src\/app\.ts:12 /);
});
test("queued feedback reads as an instruction, not a data dump", () => {
  const items = [
    { id: "f1", createdAt: 0, origin: "diff", text: "Two things to fix.", threads: [thread] }
  ];
  const out = renderFeedback(items);
  assert.match(out, /^\[cc-harness\]/);
  assert.match(out, /Two things to fix\./);
  assert.match(out, /src\/app\.ts:12-14/);
  assert.match(out, /Address each comment/);
  assert.match(out, /harness_reply/, "the model is told how to answer in-thread");
});
test("no feedback renders as nothing", () => {
  assert.equal(renderFeedback([]), "");
});
test("an approved plan gate hands back the final step list", () => {
  const gate = {
    id: "g1",
    kind: "plan",
    stage: "plan_review",
    prompt: "Review the plan",
    createdAt: 0,
    status: "resolved",
    waiting: false,
    result: {
      verdict: "approved",
      resolvedAt: 1,
      comment: "Looks right.",
      steps: [
        { id: "s1", title: "Add the parser" },
        { id: "s2", title: "Skip caching", status: "dropped" },
        { id: "s3", title: "Wire the route", comment: "use the existing helper" }
      ]
    }
  };
  const out = renderGateResult(gate);
  assert.match(out, /The user approved at the plan gate/);
  assert.match(out, /DROP — Skip caching/);
  assert.match(out, /use the existing helper/);
  assert.match(out, /Approved plan \(2 steps\)/, "dropped steps are excluded from the count");
  assert.match(out, /1\. Add the parser/);
  assert.match(out, /Proceed with the next stage/);
});
test("a rejection tells the model to stop rather than improvise", () => {
  const gate = {
    id: "g2",
    kind: "code_review",
    stage: "code_review",
    prompt: "Review the code",
    createdAt: 0,
    status: "resolved",
    waiting: false,
    result: { verdict: "rejected", resolvedAt: 1, comment: "Wrong approach." }
  };
  assert.match(renderGateResult(gate), /Stop and wait for further direction/);
});
test("stopBlock emits both known shapes of the Stop decision contract", () => {
  const out = stopBlock("do the thing");
  assert.equal(out.decision, "block");
  assert.equal(out.reason, "do the thing");
  assert.equal(out.hookSpecificOutput?.decision, "block");
  assert.equal(out.hookSpecificOutput?.reason, "do the thing");
  assert.equal(out.hookSpecificOutput?.additionalContext, "do the thing");
});
test("additionalContext never blocks", () => {
  const out = additionalContext("UserPromptSubmit", "note");
  assert.equal(out.decision, void 0);
  assert.equal(out.hookSpecificOutput?.additionalContext, "note");
});
//# sourceMappingURL=feedback.test.js.map

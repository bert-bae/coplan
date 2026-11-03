// src/test/mcp.test.ts
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// src/mcp/tools.ts
var STATUS = { type: "string", enum: ["todo", "in_progress", "blocked", "done"] };
var OPTION = {
  anyOf: [
    { type: "string" },
    {
      type: "object",
      properties: {
        label: { type: "string", description: "The choice, 1-5 words." },
        description: { type: "string", description: "What picking it means, or its trade-off." }
      },
      required: ["label"]
    }
  ]
};
var QUESTION = {
  type: "object",
  properties: {
    id: { type: "string", description: "Keep an existing id to keep its answer and comments." },
    question: { type: "string" },
    header: { type: "string", description: 'Two or three words shown as a chip, e.g. "Storage".' },
    context: { type: "string", description: "Why it matters, or what each answer would change. Markdown." },
    options: { type: "array", items: OPTION, description: "Up to 8 suggested answers." },
    multiSelect: { type: "boolean" },
    taskId: { type: "string", description: "The task this question holds up, if any." }
  },
  required: ["question"]
};
var NODE = {
  type: "object",
  properties: {
    id: { type: "string", description: 'Short slug, unique in the diagram, e.g. "api". Edges refer to it.' },
    label: { type: "string" },
    kind: { type: "string", enum: ["component", "service", "datastore", "queue", "external", "actor", "note"] },
    detail: { type: "string", description: "One line under the label: responsibility or technology." }
  },
  required: ["id", "label"]
};
var EDGE = {
  type: "object",
  properties: {
    source: { type: "string", description: "Node id." },
    target: { type: "string", description: "Node id." },
    label: { type: "string", description: 'What flows along it, e.g. "REST", "publishes events".' },
    dashed: { type: "boolean", description: "Optional, async or future connection." }
  },
  required: ["source", "target"]
};
var DIAGRAM = {
  type: "object",
  properties: {
    id: { type: "string", description: "Keep an existing id to keep its layout and comments." },
    title: { type: "string" },
    nodes: { type: "array", items: NODE },
    edges: { type: "array", items: EDGE },
    direction: { type: "string", enum: ["LR", "TB"], description: "Layout flow. Default LR." },
    caption: { type: "string" }
  },
  required: ["title", "nodes"]
};
function taskSchema(depth) {
  const properties = {
    id: { type: "string", description: "Keep an existing id to keep its status and comments." },
    title: { type: "string", description: "One concrete piece of work." },
    detail: { type: "string", description: "Approach, acceptance criteria, gotchas. Markdown." },
    status: STATUS,
    files: { type: "array", items: { type: "string" }, description: "Files you expect to touch." }
  };
  if (depth > 0) properties["subtasks"] = { type: "array", items: taskSchema(depth - 1) };
  return { type: "object", properties, required: ["title"] };
}
var TOOLS = [
  {
    name: "harness_plan_publish",
    endpoint: "publish",
    description: "Publish the whole plan to the harness UI, where the user reads it visually, reorganizes it, comments on it and answers your questions. Include: a summary; sections for context, architecture and risks; diagrams of the design as nodes and edges (the UI lays them out and the user can rearrange them); a task tree broken into subtasks; and every open question you need answered before building. Replaces the plan; items keep their comments and answers when you keep their ids. Refused if the user has changed the plan since you last read it. Does not wait for the user: afterwards, tell them in chat that the plan is ready and end your turn.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "What is being built, as a short title." },
        summary: { type: "string", description: "One paragraph: the approach and why. Markdown." },
        sections: {
          type: "array",
          description: "Ordered prose sections, e.g. Context, Architecture, Data model, Risks, Out of scope.",
          items: {
            type: "object",
            properties: { id: { type: "string" }, title: { type: "string" }, body: { type: "string", description: "Markdown." } },
            required: ["title", "body"]
          }
        },
        diagrams: { type: "array", description: "Architecture diagrams as boxes and arrows.", items: DIAGRAM },
        tasks: { type: "array", description: "The task tree, in execution order.", items: taskSchema(3) },
        questions: { type: "array", description: "Decisions you need from the user.", items: QUESTION }
      },
      required: ["title"],
      additionalProperties: false
    }
  },
  {
    name: "harness_plan_read",
    endpoint: "read",
    description: "Read the plan back, leading with everything the user changed since you last read it: edits, moved or added tasks, answers to your questions, questions they asked you, and comments. Call it whenever the user says they have reviewed or updated the plan, and before publishing again. Every item carries its id for harness_plan_edit.",
    inputSchema: {
      type: "object",
      properties: {
        changes_only: {
          type: "boolean",
          description: "Only what changed and what is waiting on you, not the whole document. Default false."
        }
      },
      additionalProperties: false
    }
  },
  {
    name: "harness_plan_edit",
    endpoint: "edit",
    description: 'Make targeted changes to the plan, applied together or not at all. Each op is an object with an "op" field: set_meta {title?, summary?}; upsert_section {id?, title?, body?, index?}; upsert_diagram {id?, title?, nodes?, edges?, direction?, caption?} (nodes/edges replace the current ones; positions are kept for node ids you keep); upsert_task {id?, parentId?, index?, title?, detail?, status?, files?, note?} (omit id to add; parentId makes it a subtask); move_task {id, parentId, index}; upsert_question {id?, question?, header?, context?, options?, multiSelect?, taskId?}; answer {id, text?, selected?} (answer a question the user asked you); reply {threadId, text} (reply to a comment); resolve {threadId, resolved}; remove {kind: section|diagram|task|question, id}.',
    inputSchema: {
      type: "object",
      properties: {
        ops: {
          type: "array",
          items: {
            type: "object",
            properties: {
              op: {
                type: "string",
                enum: [
                  "set_meta",
                  "upsert_section",
                  "upsert_diagram",
                  "upsert_task",
                  "move_task",
                  "move_section",
                  "move_diagram",
                  "upsert_question",
                  "answer",
                  "reply",
                  "resolve",
                  "remove"
                ]
              }
            },
            required: ["op"]
          }
        }
      },
      required: ["ops"],
      additionalProperties: false
    }
  },
  {
    name: "harness_task_update",
    endpoint: "task",
    description: "Track progress on the plan while you work. Set a task in_progress when you start it and done when it is finished (with a one-line note of what you did), or blocked with a note saying why. The user watches these statuses to follow your progression through the plan.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string" },
        status: STATUS,
        note: { type: "string", description: "One line: what was done, or what it is blocked on." }
      },
      required: ["task_id", "status"],
      additionalProperties: false
    }
  }
];

// src/test/mcp.test.ts
var MCP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "mcp", "main.js");
var home;
var server;
var port;
var holdMs = 0;
var received = [];
before(async () => {
  home = mkdtempSync(path.join(tmpdir(), "cc-harness-mcp-"));
  server = http.createServer((req, res) => {
    received.push(req.url ?? "");
    let body = "";
    req.on("data", (c) => body += c);
    req.on("end", () => {
      const send = () => {
        if (res.writableEnded) return;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: !req.url?.includes("refuse"), text: "[cc-harness] done" }));
      };
      if (holdMs) setTimeout(send, holdMs).unref();
      else send();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  port = typeof addr === "object" && addr ? addr.port : 0;
  writeFileSync(
    path.join(home, "daemon.json"),
    JSON.stringify({ pid: process.pid, port, token: "test-token", host: "127.0.0.1" })
  );
});
after(() => {
  server?.close();
  rmSync(home, { recursive: true, force: true });
});
beforeEach(() => {
  holdMs = 0;
  received = [];
});
function callTool(name, args = {}, waitMs = 1e4) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MCP], {
      env: { ...process.env, CC_HARNESS_HOME: home, CLAUDE_CODE_SESSION_ID: "mcp-test" },
      stdio: ["pipe", "pipe", "ignore"]
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`no response within ${waitMs}ms`));
    }, waitMs);
    let buffer = "";
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id === 2 && message.result) {
          clearTimeout(timer);
          child.kill();
          resolve(message.result);
        }
      }
    });
    child.on("error", reject);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })}
`);
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } })}
`
    );
  });
}
test("a tool call reaches the daemon and returns its prose verbatim", async () => {
  const result = await callTool("harness_plan_read");
  assert.equal(result.isError, false);
  assert.equal(result.content[0]?.text, "[cc-harness] done");
  assert.deepEqual(received, ["/mcp/read"]);
});
test("each tool forwards to its own endpoint", async () => {
  for (const [name, endpoint] of [
    ["harness_plan_publish", "/mcp/publish"],
    ["harness_plan_edit", "/mcp/edit"],
    ["harness_task_update", "/mcp/task"]
  ]) {
    received = [];
    await callTool(name, {});
    assert.deepEqual(received, [endpoint], name);
  }
});
test("the toolset is the planning loop and nothing else", () => {
  assert.deepEqual(
    TOOLS.map((t) => t.name).sort(),
    ["harness_plan_edit", "harness_plan_publish", "harness_plan_read", "harness_task_update"]
  );
  for (const tool of TOOLS) {
    assert.doesNotMatch(tool.description, /end your turn and wait|gate|harness_await/i, `${tool.name} must not ask Claude to wait`);
  }
});
test("the publish schema describes diagrams as nodes and edges", () => {
  const publish = TOOLS.find((t) => t.name === "harness_plan_publish");
  const diagrams = publish.inputSchema["properties"]["diagrams"];
  assert.ok(diagrams.items.properties["nodes"]);
  assert.ok(diagrams.items.properties["edges"]);
});
test("an unknown tool is an error, not a silent no-op", async () => {
  const child = spawn(process.execPath, [MCP], {
    env: { ...process.env, CC_HARNESS_HOME: home },
    stdio: ["pipe", "pipe", "ignore"]
  });
  const reply = await new Promise((resolve) => {
    child.stdout.on("data", (c) => resolve(c.toString()));
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "harness_await" } })}
`);
  });
  child.kill();
  assert.match(reply, /Unknown tool/);
});
//# sourceMappingURL=mcp.test.js.map

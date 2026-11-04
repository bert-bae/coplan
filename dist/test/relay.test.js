// src/test/relay.test.ts
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
var RELAY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "bin",
  "coplan-hook-relay.sh"
);
var home;
var server;
var port;
var received = [];
var holdMs = 0;
var responseBody = '{"suppressOutput":true}';
before(async () => {
  home = mkdtempSync(path.join(tmpdir(), "cc-harness-relay-"));
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => body += c);
    req.on("end", () => {
      const agent = req.headers["x-harness-agent"];
      received.push({ url: req.url ?? "", auth: req.headers.authorization, agent: typeof agent === "string" ? agent : void 0, body });
      const send = () => {
        if (res.destroyed || res.writableEnded) return;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(responseBody);
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
    JSON.stringify({ pid: process.pid, port, token: "test-token", host: "127.0.0.1" }, null, 2)
  );
  chmodSync(RELAY, 493);
});
after(() => {
  server?.close();
  rmSync(home, { recursive: true, force: true });
});
function relay(event, payload, env = {}, extra = []) {
  return new Promise((resolve) => {
    const child = spawn(RELAY, [event, ...extra], {
      env: { ...process.env, CC_HARNESS_HOME: home, ...env }
    });
    let stdout = "";
    child.stdout.on("data", (c) => stdout += c.toString());
    child.on("close", (code) => resolve({ stdout, code }));
    child.stdin.on("error", () => void 0);
    child.stdin.write(payload);
    child.stdin.end();
  });
}
test("forwards the payload with the token and echoes the response", async () => {
  received = [];
  const payload = JSON.stringify({ session_id: "s1", cwd: "/x" });
  const result = await relay("SessionEnd", payload);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, '{"suppressOutput":true}');
  assert.equal(received.length, 1);
  assert.equal(received[0].url, "/hook/SessionEnd");
  assert.equal(received[0].auth, "Bearer test-token");
  assert.equal(received[0].body, payload, "the payload is passed through byte for byte");
});
test("extra prompt context reaches the CLI unchanged", async () => {
  responseBody = JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "read the plan" } });
  const result = await relay("UserPromptSubmit", JSON.stringify({ session_id: "s1" }));
  assert.equal(result.code, 0);
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.additionalContext, "read the plan");
  responseBody = '{"suppressOutput":true}';
});
test("a daemon that hangs cannot hold a turn open", async () => {
  holdMs = 3e4;
  const started = Date.now();
  const result = await relay("Stop", '{"session_id":"s1"}');
  holdMs = 0;
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "");
  assert.ok(Date.now() - started < 8e3, `took ${Date.now() - started}ms`);
});
test("says nothing when there is no daemon", async () => {
  const empty = mkdtempSync(path.join(tmpdir(), "cc-harness-nodaemon-"));
  const result = await relay("SessionEnd", '{"session_id":"s1"}', { CC_HARNESS_HOME: empty });
  assert.equal(result.code, 0, "a missing daemon must never fail the hook");
  assert.equal(result.stdout, "");
  rmSync(empty, { recursive: true, force: true });
});
test("ignores a lock file left behind by a dead daemon", async () => {
  const stale = mkdtempSync(path.join(tmpdir(), "cc-harness-stale-"));
  writeFileSync(
    path.join(stale, "daemon.json"),
    // A pid that cannot be running: the kernel would have to have wrapped.
    JSON.stringify({ pid: 999999999, port, token: "test-token", host: "127.0.0.1" })
  );
  received = [];
  const result = await relay("SessionEnd", '{"session_id":"s1"}', { CC_HARNESS_HOME: stale });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "");
  assert.equal(received.length, 0, "it does not talk to a port owned by a dead pid");
  rmSync(stale, { recursive: true, force: true });
});
test("emits nothing when the response is not hook JSON", async () => {
  responseBody = "<html>gateway error</html>";
  const result = await relay("SessionEnd", '{"session_id":"s1"}');
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "", "anything that is not JSON is safer left unsaid");
  responseBody = '{"suppressOutput":true}';
});
test("exits quietly on empty stdin", async () => {
  received = [];
  const result = await relay("SessionEnd", "");
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "");
  assert.equal(received.length, 0);
});
test("exits quietly with no event name", async () => {
  const result = await relay("", '{"session_id":"s1"}');
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "");
});
test("a slow daemon does not hang a short-budget hook", async () => {
  holdMs = 300;
  const started = Date.now();
  const result = await relay("SessionEnd", '{"session_id":"s1"}');
  holdMs = 0;
  assert.equal(result.code, 0);
  assert.ok(Date.now() - started < 15e3);
});
test("a malformed lock file is treated as no daemon", async () => {
  const broken = mkdtempSync(path.join(tmpdir(), "cc-harness-broken-"));
  writeFileSync(path.join(broken, "daemon.json"), "not json at all");
  const result = await relay("SessionEnd", '{"session_id":"s1"}', { CC_HARNESS_HOME: broken });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "");
  rmSync(broken, { recursive: true, force: true });
});
test("says which agent the hook came from, Claude Code by default", async () => {
  received = [];
  await relay("SessionEnd", '{"session_id":"s1"}');
  await relay("stop", '{"conversation_id":"c1"}', {}, ["cursor"]);
  await relay("Stop", '{"session_id":"t1"}', {}, ["codex"]);
  assert.deepEqual(
    received.map((r) => [r.url, r.agent]),
    [
      ["/hook/SessionEnd", "claude"],
      ["/hook/stop", "cursor"],
      ["/hook/Stop", "codex"]
    ]
  );
});
test("an agent it does not know is sent as Claude Code, never passed through", async () => {
  received = [];
  await relay("SessionEnd", '{"session_id":"s1"}', {}, ['x"; rm -rf /']);
  assert.equal(received[0]?.agent, "claude");
});
//# sourceMappingURL=relay.test.js.map

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
  "hook-relay.sh"
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
      received.push({ url: req.url ?? "", auth: req.headers.authorization, body });
      const send = () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(responseBody);
      };
      if (holdMs) setTimeout(send, holdMs);
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
function relay(event, payload, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(RELAY, [event], {
      env: { ...process.env, CC_HARNESS_HOME: home, ...env }
    });
    let stdout = "";
    child.stdout.on("data", (c) => stdout += c.toString());
    child.on("close", (code) => resolve({ stdout, code }));
    child.stdin.write(payload);
    child.stdin.end();
  });
}
test("forwards the payload with the token and echoes the response", async () => {
  received = [];
  const payload = JSON.stringify({ session_id: "s1", tool_name: "Edit" });
  const result = await relay("PostToolUse", payload);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, '{"suppressOutput":true}');
  assert.equal(received.length, 1);
  assert.equal(received[0].url, "/hook/PostToolUse");
  assert.equal(received[0].auth, "Bearer test-token");
  assert.equal(received[0].body, payload, "the payload is passed through byte for byte");
});
test("a Stop decision reaches the CLI unchanged", async () => {
  responseBody = JSON.stringify({ decision: "block", reason: "do the thing" });
  const result = await relay("Stop", JSON.stringify({ session_id: "s1" }));
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), { decision: "block", reason: "do the thing" });
  responseBody = '{"suppressOutput":true}';
});
test("says nothing when there is no daemon", async () => {
  const empty = mkdtempSync(path.join(tmpdir(), "cc-harness-nodaemon-"));
  const result = await relay("PostToolUse", '{"session_id":"s1"}', { CC_HARNESS_HOME: empty });
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
  const result = await relay("PostToolUse", '{"session_id":"s1"}', { CC_HARNESS_HOME: stale });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "");
  assert.equal(received.length, 0, "it does not talk to a port owned by a dead pid");
  rmSync(stale, { recursive: true, force: true });
});
test("emits nothing when the response is not hook JSON", async () => {
  responseBody = "<html>gateway error</html>";
  const result = await relay("PostToolUse", '{"session_id":"s1"}');
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "", "anything that is not JSON is safer left unsaid");
  responseBody = '{"suppressOutput":true}';
});
test("exits quietly on empty stdin", async () => {
  received = [];
  const result = await relay("PostToolUse", "");
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
  const result = await relay("PostToolUse", '{"session_id":"s1"}');
  holdMs = 0;
  assert.equal(result.code, 0);
  assert.ok(Date.now() - started < 15e3);
});
test("a malformed lock file is treated as no daemon", async () => {
  const broken = mkdtempSync(path.join(tmpdir(), "cc-harness-broken-"));
  writeFileSync(path.join(broken, "daemon.json"), "not json at all");
  const result = await relay("PostToolUse", '{"session_id":"s1"}', { CC_HARNESS_HOME: broken });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "");
  rmSync(broken, { recursive: true, force: true });
});
//# sourceMappingURL=relay.test.js.map

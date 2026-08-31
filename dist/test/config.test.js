// src/test/config.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

// src/shared/config.ts
var DEFAULT_CONFIG = {
  autoOpen: false,
  maxTimelineEvents: 500,
  stopHoldSeconds: 540,
  awaitSeconds: 120,
  gateHoldRounds: 4,
  holdIdleSessions: false,
  maxDiffFileBytes: 4e5,
  idleShutdownMinutes: 120,
  stages: {
    verification: { checks: [] }
  },
  ship: {
    steps: ["checks", "commit", "push", "pr", "summary"],
    provider: "gh",
    providers: {
      gh: {
        kind: "command",
        label: "GitHub (gh CLI)",
        command: "gh pr create --base {{base}} --head {{branch}} --title {{title}} --body-file {{bodyFile}}"
      },
      bitbucket: {
        kind: "mcp",
        label: "Bitbucket (MCP)",
        directive: "Open a pull request using the connected Bitbucket MCP server. Use the title and body below verbatim, source branch {{branch}}, destination branch {{base}}. Report the resulting PR URL back with harness_note."
      },
      none: { kind: "none", label: "No PR \u2014 commit and push only" }
    },
    summaryPath: "docs/reviews/{{branch}}.md",
    commitTemplate: "{{title}}\n\n{{body}}"
  }
};
function isRecord(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function mergeConfig(base, override) {
  if (!isRecord(override)) return base;
  const out = { ...base, stages: { ...base.stages }, ship: { ...base.ship } };
  for (const [key, value] of Object.entries(override)) {
    if (key === "stages" && isRecord(value)) {
      for (const [stage, cfg] of Object.entries(value)) {
        if (!isRecord(cfg)) continue;
        const s = stage;
        out.stages[s] = { ...out.stages[s], ...cfg };
      }
    } else if (key === "ship" && isRecord(value)) {
      out.ship = {
        ...out.ship,
        ...value,
        providers: { ...out.ship.providers, ...value.providers ?? {} }
      };
    } else if (value !== void 0) {
      out[key] = value;
    }
  }
  return out;
}
function renderTemplate(tpl, vars) {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_m, k) => vars[k] ?? "");
}

// src/test/config.test.ts
test("project overrides merge without dropping shipped providers", () => {
  const merged = mergeConfig(DEFAULT_CONFIG, {
    ship: {
      provider: "bitbucket",
      providers: { gitlab: { kind: "mcp", directive: "use the gitlab server" } }
    }
  });
  assert.equal(merged.ship.provider, "bitbucket");
  assert.ok(merged.ship.providers["gh"], "built-in gh provider survives");
  assert.ok(merged.ship.providers["gitlab"], "custom provider is added");
  assert.deepEqual(merged.ship.steps, DEFAULT_CONFIG.ship.steps);
});
test("stage overrides merge per stage", () => {
  const merged = mergeConfig(DEFAULT_CONFIG, {
    stages: {
      verification: { checks: ["npm test"] },
      code_review: { instructions: ".claude/review.md" }
    }
  });
  assert.deepEqual(merged.stages.verification?.checks, ["npm test"]);
  assert.equal(merged.stages.code_review?.instructions, ".claude/review.md", "other stages merge too");
});
test("scalar overrides apply", () => {
  const merged = mergeConfig(DEFAULT_CONFIG, { autoOpen: false, stopHoldSeconds: 60 });
  assert.equal(merged.autoOpen, false);
  assert.equal(merged.stopHoldSeconds, 60);
});
test("merging does not mutate the defaults", () => {
  mergeConfig(DEFAULT_CONFIG, {
    ship: { provider: "none" },
    stages: { verification: { checks: ["x"] } }
  });
  assert.equal(DEFAULT_CONFIG.ship.provider, "gh");
  assert.deepEqual(DEFAULT_CONFIG.stages.verification?.checks, []);
});
test("garbage input is ignored rather than throwing", () => {
  assert.equal(mergeConfig(DEFAULT_CONFIG, null), DEFAULT_CONFIG);
  assert.equal(mergeConfig(DEFAULT_CONFIG, "nope"), DEFAULT_CONFIG);
  assert.equal(mergeConfig(DEFAULT_CONFIG, [1, 2]), DEFAULT_CONFIG);
});
test("templates substitute known keys and blank unknown ones", () => {
  assert.equal(renderTemplate("{{a}}-{{b}}-{{c}}", { a: "x", b: "y" }), "x-y-");
  assert.equal(renderTemplate("no placeholders", {}), "no placeholders");
});
//# sourceMappingURL=config.test.js.map

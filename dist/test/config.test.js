// src/test/config.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

// src/shared/config.ts
var DEFAULT_CONFIG = {
  autoOpen: false,
  promptNotice: true,
  idleShutdownMinutes: 120
};
function isRecord(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function mergeConfig(base, override) {
  if (!isRecord(override)) return base;
  const out = { ...base };
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    const value = override[key];
    if (value !== void 0 && typeof value === typeof DEFAULT_CONFIG[key]) {
      out[key] = value;
    }
  }
  return out;
}

// src/test/config.test.ts
test("known keys override", () => {
  const cfg = mergeConfig(DEFAULT_CONFIG, { autoOpen: true, idleShutdownMinutes: 5 });
  assert.equal(cfg.autoOpen, true);
  assert.equal(cfg.idleShutdownMinutes, 5);
  assert.equal(cfg.promptNotice, true);
});
test("keys from the old review loop are ignored rather than carried along", () => {
  const cfg = mergeConfig(DEFAULT_CONFIG, { gateHoldSeconds: 300, ship: { provider: "gh" } });
  assert.equal(cfg["gateHoldSeconds"], void 0);
  assert.equal(cfg["ship"], void 0);
});
test("a value of the wrong type is ignored", () => {
  assert.equal(mergeConfig(DEFAULT_CONFIG, { promptNotice: "no" }).promptNotice, true);
});
test("merging does not mutate the defaults", () => {
  mergeConfig(DEFAULT_CONFIG, { autoOpen: true });
  assert.equal(DEFAULT_CONFIG.autoOpen, false);
});
test("garbage input is ignored rather than throwing", () => {
  assert.deepEqual(mergeConfig(DEFAULT_CONFIG, "nonsense"), DEFAULT_CONFIG);
  assert.deepEqual(mergeConfig(DEFAULT_CONFIG, null), DEFAULT_CONFIG);
});
//# sourceMappingURL=config.test.js.map

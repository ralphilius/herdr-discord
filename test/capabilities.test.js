import test from "node:test";
import assert from "node:assert/strict";
import { midTurnStrategy, midTurnDescription } from "../src/capabilities.js";

test("kinds with native mid-turn input queueing send immediately", () => {
  assert.equal(midTurnStrategy("claude"), "queue");
  assert.equal(midTurnStrategy("codex"), "queue");
});

test("unknown kinds hold — typing mid-render would mangle input", () => {
  for (const kind of ["omp", "gemini", "pi", "droid", "something-new"]) {
    assert.equal(midTurnStrategy(kind), "hold");
  }
});

test("description matches the strategy so users see the right behavior", () => {
  assert.match(midTurnDescription("claude"), /queued by the agent/);
  assert.match(midTurnDescription("omp"), /held by the bridge/);
});

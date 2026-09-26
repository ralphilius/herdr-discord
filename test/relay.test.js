import test from "node:test";
import assert from "node:assert/strict";
import { Relay, collapse } from "../src/relay.js";

const snap = (lines) => lines.join("\n");
const stable = (n, prefix = "line") => [...Array(n).keys()].map((i) => `${prefix} ${i}`);

test("first snapshot seeds the baseline and emits nothing", () => {
  const r = new Relay();
  assert.deepEqual(r.update("t", snap([...stable(25), "⠋ spinner", "status bar"])), []);
});

test("baseline content is never back-posted, even once stable", () => {
  const r = new Relay();
  r.update("t", snap([...stable(25), "⠋ spinner", "status bar"]));
  // Spinner churns; baseline lines persist unchanged — still nothing to post.
  assert.deepEqual(r.update("t", snap([...stable(25), "⠙ spinner", "status bar"])), []);
  assert.deepEqual(r.update("t", snap([...stable(25), "⠹ spinner", "status bar"])), []);
});

test("a new line emits once it persists across a full tick", () => {
  const r = new Relay();
  r.update("t", snap([...stable(25), "⠋ spinner", "status bar"]));
  assert.deepEqual(r.update("t", snap([...stable(25), "hello world", "⠙ spinner", "status"])), []);
  assert.deepEqual(
    r.update("t", snap([...stable(25), "hello world", "⠹ spinner", "status"])),
    ["hello world"],
  );
});

test("churning spinner lines never emit", () => {
  const r = new Relay();
  r.update("t", snap([...stable(25), "⠋ working"]));
  for (const frame of ["⠙", "⠹", "⠸", "⠼"]) {
    assert.deepEqual(r.update("t", snap([...stable(25), `${frame} working`])), []);
  }
});

test("a burst pushes lines above the churn zone immediately", () => {
  const r = new Relay();
  r.update("t", snap([...stable(25), "⠋ spinner"]));
  const burst = stable(30, "burst");
  const emit = r.update("t", snap([...stable(25), ...burst, "⠙ spinner"]));
  // 31 candidate lines, bottom 20 deferred → first 11 emit now.
  assert.deepEqual(emit, burst.slice(0, 11));
  // Next tick they persist → the rest drains.
  const rest = r.update("t", snap([...stable(25), ...burst, "⠹ spinner"]));
  assert.deepEqual(rest, burst.slice(11));
});

test("flush drains the deferred tail (agent done/gone)", () => {
  const r = new Relay();
  r.update("t", snap([...stable(25), "⠋ spinner"]));
  r.update("t", snap([...stable(25), "final answer", "⠙ spinner"]));
  assert.deepEqual(r.flush("t"), ["final answer", "⠙ spinner"]);
  assert.deepEqual(r.flush("t"), []);
});

test("anchor survives content interleaved with blank lines", () => {
  const r = new Relay();
  const withBlanks = [];
  for (const l of stable(25)) withBlanks.push(l, "");
  r.update("t", snap([...withBlanks, "⠋ spinner"]));
  assert.deepEqual(r.update("t", snap([...withBlanks, "new line", "⠙ spinner"])), []);
  assert.deepEqual(
    r.update("t", snap([...withBlanks, "new line", "⠹ spinner"])),
    ["new line"],
  );
});

test("anchor loss rebases with a seam marker, without re-dumping", () => {
  const r = new Relay();
  r.update("t", snap([...stable(25), "⠋ spinner"]));
  // Display cleared — anchor is gone for three consecutive ticks.
  assert.deepEqual(r.update("t", snap(stable(25, "cleared"))), []);
  assert.deepEqual(r.update("t", snap(stable(25, "cleared"))), []);
  const emit = r.update("t", snap(stable(25, "cleared")));
  assert.ok(emit.some((l) => l.includes("display reset")));
  // The rebased snapshot's content is the new baseline — not posted.
  assert.ok(!emit.some((l) => l.startsWith("cleared")));
});

test("short snapshots still anchor and relay new output", () => {
  const r = new Relay();
  assert.deepEqual(r.update("t", snap(["boot", "⠋"])), []);
  assert.deepEqual(r.update("t", snap(["boot", "hello", "⠙"])), []);
  assert.deepEqual(r.update("t", snap(["boot", "hello", "⠹"])), ["hello"]);
  assert.deepEqual(r.update("t", snap(["boot", "hello", "done", "⠼"])), []);
  assert.deepEqual(r.update("t", snap(["boot", "hello", "done", "⠴"])), ["done"]);
});

test("a legitimately repeated line re-emits", () => {
  const r = new Relay();
  const turn = ["DONE", "step 1", "step 2", "step 3", "step 4"];
  r.update("t", snap([...stable(25), "⠋"]));
  r.update("t", snap([...stable(25), ...turn, "⠙"]));
  assert.deepEqual(r.update("t", snap([...stable(25), ...turn, "⠹"])), turn);
  // Same line again later, with new content around it — it must post again.
  r.update("t", snap([...stable(25), ...turn, ...stable(10, "mid"), "DONE", "⠼"]));
  const emit = r.update("t", snap([...stable(25), ...turn, ...stable(10, "mid"), "DONE", "⠴"]));
  assert.deepEqual(emit, [...stable(10, "mid"), "DONE"]);
});

test("flush re-anchors so post-flush output relays without a reset", () => {
  const r = new Relay();
  r.update("t", snap([...stable(25), "⠋"]));
  r.update("t", snap([...stable(25), "a", "⠙"]));
  r.update("t", snap([...stable(25), "a", "b", "⠹"]));
  r.flush("t"); // emits a, b, spinner tail — anchor must land on the stable part
  r.update("t", snap([...stable(25), "a", "b", "c", "⠴"]));
  assert.deepEqual(r.update("t", snap([...stable(25), "a", "b", "c", "⠸"])), ["c"]);
});

test("no reset-marker spam when the anchor was never established", () => {
  const r = new Relay();
  r.update("t", snap(["", "", ""]));
  for (let i = 0; i < 6; i++) {
    assert.deepEqual(r.update("t", snap(["", "", ""])), []);
  }
});

test("collapse folds consecutive duplicates and blank runs", () => {
  assert.deepEqual(collapse(["a", "a", "a", "b"]), ["a ×3", "b"]);
  assert.deepEqual(collapse(["a", "", "", "", "b"]), ["a", "", "b"]);
  assert.deepEqual(collapse([]), []);
});

test("drop clears thread state; a later update re-baselines", () => {
  const r = new Relay();
  r.update("t", snap([...stable(25), "⠋"]));
  assert.equal(r.has("t"), true);
  r.drop("t");
  assert.equal(r.has("t"), false);
  assert.deepEqual(r.update("t", snap(stable(25, "other"))), []);
});

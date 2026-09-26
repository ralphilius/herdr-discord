import test from "node:test";
import assert from "node:assert/strict";
import { handleUserText, flushQueue } from "../src/thread-input.js";

function fakeMsg(id = "m1") {
  return {
    id,
    reacts: [],
    replies: [],
    react: async function (e) {
      this.reacts.push(e);
    },
    reply: async function (c) {
      this.replies.push(c);
    },
  };
}

function fakeHerdr(overrides = {}) {
  const calls = { prompt: [], sendText: [], sendKeys: [] };
  const herdr = {
    promptAgent: async (...a) => calls.prompt.push(a),
    sendText: async (...a) => calls.sendText.push(a),
    sendKeys: async (...a) => calls.sendKeys.push(a),
    ...overrides,
  };
  return { calls, herdr };
}

const mapping = (over = {}) => ({
  agent_name: "dc-test",
  kind: "omp",
  pane_id: "w:p1",
  machine: null,
  last_status: "working",
  ...over,
});

test("working hold-kind: prompt is queued with ⏳ and a one-time explainer", async () => {
  const msg = fakeMsg();
  const { calls, herdr } = fakeHerdr();
  const m = mapping();
  let saved = 0;
  await handleUserText({ msg, mapping: m, text: "fix the tests", prompt: "u: fix the tests", herdr, persist: () => saved++ });
  assert.equal(calls.prompt.length, 0);
  assert.equal(m.queue.length, 1);
  assert.deepEqual(m.queue[0], { id: "m1", text: "u: fix the tests" });
  assert.deepEqual(msg.reacts, ["⏳"]);
  assert.equal(msg.replies.length, 1);
  assert.match(msg.replies[0], /can't take input mid-turn/);
  assert.equal(m.queue_explained, true);
  assert.ok(saved > 0);
});

test("the explainer posts only once per thread", async () => {
  const { herdr } = fakeHerdr();
  const m = mapping({ queue_explained: true });
  const msg = fakeMsg();
  await handleUserText({ msg, mapping: m, text: "x", prompt: "u: x", herdr, persist: () => {} });
  assert.equal(msg.replies.length, 0);
  assert.deepEqual(msg.reacts, ["⏳"]);
});

test("working queue-kind: prompt sends immediately with 📥", async () => {
  const msg = fakeMsg();
  const { calls, herdr } = fakeHerdr();
  const m = mapping({ kind: "claude" });
  await handleUserText({ msg, mapping: m, text: "go", prompt: "u: go", herdr, persist: () => {} });
  assert.equal(calls.prompt.length, 1);
  assert.equal(calls.prompt[0][0], "dc-test");
  assert.equal(calls.prompt[0][1], "u: go");
  assert.deepEqual(msg.reacts, ["📥"]);
  assert.equal(m.queue, undefined);
});

test("settled agent (idle/done): prompt sends with ✅", async () => {
  for (const status of ["idle", "done"]) {
    const msg = fakeMsg();
    const { calls, herdr } = fakeHerdr();
    const m = mapping({ last_status: status });
    await handleUserText({ msg, mapping: m, text: "go", prompt: "u: go", herdr, persist: () => {} });
    assert.equal(calls.prompt.length, 1);
    assert.deepEqual(msg.reacts, ["✅"]);
  }
});

test("gone agent: reply, no send, no queue", async () => {
  const msg = fakeMsg();
  const { calls, herdr } = fakeHerdr();
  const m = mapping({ last_status: "gone" });
  await handleUserText({ msg, mapping: m, text: "go", prompt: "u: go", herdr, persist: () => {} });
  assert.equal(calls.prompt.length, 0);
  assert.equal(msg.replies.length, 1);
  assert.match(msg.replies[0], /no longer running/);
  assert.equal(m.queue, undefined);
});

test("blocked agent: held with a blocked note, not the kind explainer", async () => {
  const msg = fakeMsg();
  const { calls, herdr } = fakeHerdr();
  const m = mapping({ last_status: "blocked" });
  await handleUserText({ msg, mapping: m, text: "go", prompt: "u: go", herdr, persist: () => {} });
  assert.equal(calls.prompt.length, 0);
  assert.equal(m.queue.length, 1);
  assert.match(msg.replies[0], /blocked/);
  assert.deepEqual(msg.reacts, ["⏳"]);
});

test("starting agent: held even for queue kinds", async () => {
  const msg = fakeMsg();
  const { calls, herdr } = fakeHerdr();
  const m = mapping({ kind: "claude", last_status: "starting" });
  await handleUserText({ msg, mapping: m, text: "go", prompt: "u: go", herdr, persist: () => {} });
  assert.equal(calls.prompt.length, 0);
  assert.equal(m.queue.length, 1);
});

test("!! types raw text into the pane and reacts ⚡", async () => {
  const msg = fakeMsg();
  const { calls, herdr } = fakeHerdr();
  const m = mapping({ kind: "omp", last_status: "working" });
  await handleUserText({ msg, mapping: m, text: "!!/btw status?", prompt: "u: !!/btw status?", herdr, persist: () => {} });
  assert.deepEqual(calls.sendText, [["w:p1", "/btw status?", null]]);
  assert.deepEqual(calls.sendKeys, [["dc-test", ["enter"], null]]);
  assert.equal(calls.prompt.length, 0);
  assert.deepEqual(msg.reacts, ["⚡"]);
});

test("bare !! gets a hint reply instead of silence", async () => {
  const msg = fakeMsg();
  const { calls, herdr } = fakeHerdr();
  await handleUserText({ msg, mapping: mapping(), text: "!!", prompt: "u: !!", herdr, persist: () => {} });
  assert.equal(calls.sendText.length, 0);
  assert.equal(msg.reacts.length, 0);
  assert.equal(msg.replies.length, 1);
});

test("!! while the agent is gone replies instead of typing into the pane", async () => {
  const msg = fakeMsg();
  const { calls, herdr } = fakeHerdr();
  const m = mapping({ last_status: "gone" });
  await handleUserText({ msg, mapping: m, text: "!!/btw hi", prompt: "u: !!/btw hi", herdr, persist: () => {} });
  assert.equal(calls.sendText.length, 0);
  assert.equal(calls.sendKeys.length, 0);
  assert.equal(msg.replies.length, 1);
  assert.match(msg.replies[0], /no longer running/);
});

test("agent_blocked race on send falls back to the queue", async () => {
  const msg = fakeMsg();
  const err = new Error("blocked");
  err.code = "agent_blocked";
  const { calls, herdr } = fakeHerdr();
  herdr.promptAgent = async (...a) => { calls.prompt.push(a); throw err; };
  const m = mapping({ kind: "claude" });
  await handleUserText({ msg, mapping: m, text: "go", prompt: "u: go", herdr, persist: () => {} });
  assert.equal(calls.prompt.length, 1);
  assert.equal(m.queue.length, 1);
  assert.deepEqual(msg.reacts, ["⏳"]);
});

test("other prompt errors propagate", async () => {
  const msg = fakeMsg();
  const err = new Error("server gone");
  const { herdr } = fakeHerdr();
  herdr.promptAgent = async () => { throw err; };
  await assert.rejects(
    handleUserText({ msg, mapping: mapping({ kind: "claude" }), text: "go", prompt: "u: go", herdr, persist: () => {} }),
    /server gone/,
  );
});

test("flushQueue drains FIFO and swaps ⏳ for ✅", async () => {
  const queued = [
    { id: "m1", text: "first" },
    { id: "m2", text: "second" },
  ];
  const { calls, herdr } = fakeHerdr();
  const removed = [];
  const msgs = new Map();
  for (const q of queued) {
    msgs.set(q.id, {
      reactions: { cache: new Map([["⏳", { users: { remove: async () => removed.push(q.id) } }]]) },
      react: async () => {},
    });
  }
  const thread = {
    send: async () => {},
    messages: { fetch: async (id) => msgs.get(id) },
  };
  const m = mapping({ queue: queued, last_status: "idle" });
  await flushQueue(thread, m, herdr, () => {});
  assert.deepEqual(calls.prompt.map((c) => c[1]), ["first", "second"]);
  assert.equal(m.queue.length, 0);
  assert.deepEqual(removed, ["m1", "m2"]);
});

test("flushQueue stops on error and keeps the remainder", async () => {
  const err = new Error("agent_blocked");
  err.code = "agent_blocked";
  const { calls, herdr } = fakeHerdr();
  herdr.promptAgent = async (...a) => { calls.prompt.push(a); throw err; };
  const thread = { send: async (c) => thread.sent.push(c), sent: [], messages: { fetch: async () => null } };
  const m = mapping({ queue: [{ id: "m1", text: "a" }, { id: "m2", text: "b" }] });
  await flushQueue(thread, m, herdr, () => {});
  assert.equal(calls.prompt.length, 1);
  assert.equal(m.queue.length, 2);
  assert.equal(thread.sent.length, 1);
  assert.match(thread.sent[0], /still queued/);
});

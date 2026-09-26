// Prompt routing for a mapped thread — pure orchestration over injected
// herdr calls and persistence, so the behavior is testable without discord.js
// or a Herdr server. `msg` is the discord.js message; `persist` saves state.
import { midTurnStrategy } from "./capabilities.js";

export async function handleUserText({ msg, mapping, text, prompt, herdr, persist }) {
  const status = mapping.last_status;
  if (status === "gone") {
    await msg.reply(`Agent \`${mapping.agent_name}\` is no longer running.`).catch(() => {});
    return;
  }

  if (text.startsWith("!!")) {
    // Raw passthrough: literal text + Enter into the pane, regardless of
    // agent state. The escape hatch for harness commands (`/btw`, …) and
    // force-send — whatever the TUI does with it is the user's call.
    const raw = text.slice(2);
    if (!raw) {
      await msg.reply("`!!` types raw input into the agent's pane — e.g. `!!/btw status?`").catch(() => {});
      return;
    }
    try {
      await herdr.sendText(mapping.pane_id, raw, mapping.machine);
      await herdr.sendKeys(mapping.agent_name, ["enter"], mapping.machine);
      await msg.react("⚡").catch(() => {});
    } catch (err) {
      await msg.reply(`Raw send failed: ${err.message}`).catch(() => {});
    }
    return;
  }

  const settled = status === "idle" || status === "done";
  const canSendNow =
    settled || (status === "working" && midTurnStrategy(mapping.kind) === "queue");
  if (!canSendNow) {
    // Held until the agent settles: non-queue kinds while working, and any
    // prompt while blocked/starting — `agent prompt` rejects blocked agents.
    (mapping.queue ??= []).push({ id: msg.id, text: prompt });
    if (status === "blocked") {
      await msg.reply("Agent is blocked on a dialog — held; it sends once resolved.").catch(() => {});
    } else if (!mapping.queue_explained) {
      mapping.queue_explained = true;
      await msg.reply(
        `\`${mapping.kind}\` can't take input mid-turn — holding until it settles. \`!!text\` sends raw input immediately.`,
      ).catch(() => {});
    }
    persist();
    await msg.react("⏳").catch(() => {});
    return;
  }
  try {
    await herdr.promptAgent(mapping.agent_name, prompt, mapping.machine);
    await msg.react(status === "working" ? "📥" : "✅").catch(() => {});
  } catch (err) {
    if (err.code === "agent_blocked") {
      // Raced with a blocked dialog — hold for the settle flush.
      (mapping.queue ??= []).push({ id: msg.id, text: prompt });
      persist();
      await msg.react("⏳").catch(() => {});
    } else {
      throw err;
    }
  }
}

// Send held prompts FIFO once the agent settles; swap each message's ⏳ for ✅.
export async function flushQueue(thread, mapping, herdr, persist) {
  const queue = mapping.queue ?? [];
  while (queue.length) {
    const entry = queue[0];
    try {
      await herdr.promptAgent(mapping.agent_name, entry.text, mapping.machine);
    } catch (err) {
      await thread
        .send(`Couldn't send a held message: ${err.message} — ${queue.length} still queued.`)
        .catch(() => {});
      return;
    }
    queue.shift();
    persist();
    if (entry.id) {
      const m = await thread.messages.fetch(entry.id).catch(() => null);
      await m?.reactions.cache.get("⏳")?.users.remove().catch(() => {});
      await m?.react("✅").catch(() => {});
    }
  }
}

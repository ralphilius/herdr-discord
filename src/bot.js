import {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { config, requireToken } from "./config.js";
import * as herdr from "./herdr.js";
import { parsePrompt, keysForOption } from "./prompts.js";
import { loadState, saveState } from "./state.js";

const token = requireToken();
const state = loadState();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const DISCORD_LIMIT = 1900;

function chunks(text) {
  const out = [];
  for (let i = 0; i < text.length; i += DISCORD_LIMIT) out.push(text.slice(i, i + DISCORD_LIMIT));
  return out.length ? out : ["(empty)"];
}

async function post(thread, text) {
  for (const part of chunks(text)) await thread.send(part);
}

async function postOutput(thread, text) {
  const body = text.trim() || "(no output)";
  for (const part of chunks(body)) {
    await thread.send(part.startsWith("```") ? part : `\`\`\`\n${part}\n\`\`\``);
  }
}

function slugify(name, taken) {
  const base = `dc-${name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "")}`.slice(0, 31);
  let candidate = base.replace(/-+$/, "") || "dc-agent";
  for (let i = 2; taken.has(candidate); i++) {
    candidate = `${base.slice(0, 28)}-${i}`;
  }
  return candidate;
}

// Directive lines in a thread's starter message: `kind:codex`, `cwd:/path`.
// Returns { kind, cwd, prompt } — the prompt is the remaining text.
function parseStarter(content) {
  const lines = (content ?? "").split("\n");
  const directives = {};
  const rest = [];
  for (const line of lines) {
    const m = line.trim().match(/^(kind|cwd)\s*:\s*(\S+)\s*$/i);
    if (m) directives[m[1].toLowerCase()] = m[2];
    else rest.push(line);
  }
  return { kind: directives.kind, cwd: directives.cwd, prompt: rest.join("\n").trim() };
}

function authorized(userId) {
  return config.allowedUsers.size === 0 || config.allowedUsers.has(userId);
}

async function onThreadCreate(thread) {
  try {
    if (config.guildId && thread.guildId !== config.guildId) return;
    if (state.threads[thread.id]) return;

    const channelCfg = config.channelConfig(thread.parentId);
    if (channelCfg === null) return;

    const starter = await thread.fetchStarterMessage().catch(() => null);
    if (starter && !authorized(starter.author.id)) return;

    await thread.join().catch(() => {});

    const { kind: kindDirective, cwd: cwdDirective, prompt } = parseStarter(starter?.content);
    const kind = kindDirective ?? channelCfg.kind ?? config.agentKind;
    const cwd = cwdDirective ?? channelCfg.cwd ?? config.cwd;

    await thread.send(`Starting a **${kind}** agent for this thread…`);

    const channelState = (state.channels[thread.parentId] ??= {});
    const workspace = await herdr.ensureWorkspace({
      workspaceId: channelState.workspace_id,
      cwd: channelCfg.cwd ?? config.cwd,
      label: channelCfg.label ?? thread.parent?.name ?? `discord-${thread.parentId}`,
    });
    channelState.workspace_id = workspace.workspace_id;

    const tab = await herdr.createTab({
      workspaceId: workspace.workspace_id,
      cwd,
      label: thread.name.slice(0, 60),
    });
    const paneId = tab.root_pane?.pane_id ?? tab.pane?.pane_id;
    if (!paneId) throw new Error("tab created but no root pane id in response");

    const existing = new Set(
      (await herdr.listAgents().catch(() => [])).map((a) => a.name ?? a.agent),
    );
    for (const t of Object.values(state.threads)) existing.add(t.agent_name);
    const name = slugify(thread.name, existing);

    await herdr.startAgent({ name, kind, paneId });

    state.threads[thread.id] = {
      workspace_id: workspace.workspace_id,
      tab_id: tab.tab?.tab_id,
      pane_id: paneId,
      agent_name: name,
      kind,
      channel_id: thread.parentId,
      last_status: "starting",
    };
    saveState(state);

    await post(
      thread,
      `Agent \`${name}\` (${kind}) is up — tab \`${tab.tab?.tab_id}\` in workspace \`${workspace.workspace_id}\`.\n` +
        "Reply here to prompt it. Commands: `!status` `!read [n]` `!approve` `!close` `!help`",
    );

    if (prompt) await herdr.promptAgent(name, prompt);
  } catch (err) {
    console.error("threadCreate failed:", err);
    await thread.send(`Failed to start agent: ${err.message}`).catch(() => {});
  }
}

async function onMessage(msg) {
  try {
    if (msg.author.bot || !msg.channel.isThread()) return;
    const mapping = state.threads[msg.channel.id];
    if (!mapping) return;
    if (!authorized(msg.author.id)) {
      await msg.reply("You are not on the allowed-users list for this bridge.");
      return;
    }

    const text = msg.content.trim();
    if (text.startsWith("!")) return onCommand(msg, mapping, text);

    const attachments = [...msg.attachments.values()].map((a) => a.url);
    const prompt =
      `${msg.member?.displayName ?? msg.author.username}: ${text}` +
      (attachments.length ? `\n${attachments.join("\n")}` : "");
    try {
      await herdr.promptAgent(mapping.agent_name, prompt);
      await msg.react("✅").catch(() => {});
    } catch (err) {
      if (err.code === "agent_blocked") {
        await msg.reply(
          "Agent is blocked on a prompt in Herdr. Resolve it in the terminal, or try `!approve`.",
        );
      } else {
        throw err;
      }
    }
  } catch (err) {
    console.error("messageCreate failed:", err);
    await msg.reply(`Error: ${err.message}`).catch(() => {});
  }
}

async function onCommand(msg, mapping, text) {
  const [cmd, arg] = text.slice(1).split(/\s+/, 2);
  switch (cmd.toLowerCase()) {
    case "status": {
      const agent = await herdr.getAgent(mapping.agent_name);
      const status = agent.status ?? agent.agent_status ?? "unknown";
      await msg.reply(
        `\`${mapping.agent_name}\` (${mapping.kind}) — **${status}**\n` +
          `workspace \`${mapping.workspace_id}\` tab \`${mapping.tab_id}\` pane \`${mapping.pane_id}\``,
      );
      break;
    }
    case "read": {
      const n = Math.min(Math.max(parseInt(arg, 10) || config.outputLines, 1), 80);
      await postOutput(msg.channel, await herdr.readAgent(mapping.agent_name, { lines: n }));
      break;
    }
    case "approve": {
      await herdr.sendKeys(mapping.agent_name, ["enter"]);
      await msg.react("👍").catch(() => {});
      break;
    }
    case "close": {
      await msg.reply("Closing the agent tab…");
      if (mapping.tab_id) await herdr.closeTab(mapping.tab_id).catch(() => {});
      delete state.threads[msg.channel.id];
      saveState(state);
      break;
    }
    case "help": {
      await msg.reply(
        "`!status` agent status · `!read [n]` last n output lines · " +
          "`!approve` send Enter to a blocked agent · `!close` close the agent tab\n" +
          "Starter message directives: `kind:<agent>` and `cwd:<path>` on their own lines.",
      );
      break;
    }
    default:
      break; // not a bridge command
  }
}

// Button rows for a blocked agent. custom_id format: "hd:keys:<agent>:<k1,k2>"
// sends those keys; "hd:modal:<agent>" opens a free-text answer modal;
// "hd:text:<agent>" is the modal submit.
function promptComponents(agentName, parsed) {
  const keyButton = (keys, label, style) =>
    new ButtonBuilder()
      .setCustomId(`hd:keys:${agentName}:${keys.join(",")}`)
      .setLabel(label.slice(0, 80))
      .setStyle(style);

  const rows = [];
  if (parsed.type === "options") {
    for (let r = 0; r * 5 < parsed.options.length && rows.length < 4; r++) {
      const row = new ActionRowBuilder();
      for (const opt of parsed.options.slice(r * 5, r * 5 + 5)) {
        row.addComponents(
          keyButton(keysForOption(parsed, opt.index), `${opt.num}. ${opt.label}`, ButtonStyle.Primary),
        );
      }
      rows.push(row);
    }
  } else if (parsed.type === "yesno") {
    rows.push(
      new ActionRowBuilder().addComponents(
        keyButton(["y"], "Yes", ButtonStyle.Success),
        keyButton(["n"], "No", ButtonStyle.Danger),
      ),
    );
  } else {
    rows.push(
      new ActionRowBuilder().addComponents(
        keyButton(["enter"], "Approve (Enter)", ButtonStyle.Success),
        keyButton(["esc"], "Cancel (Esc)", ButtonStyle.Danger),
      ),
    );
  }
  if (rows.length < 5) {
    rows.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`hd:modal:${agentName}`)
          .setLabel("Type answer…")
          .setStyle(ButtonStyle.Secondary),
      ),
    );
  }
  return rows;
}

function mappingForAgent(name) {
  return Object.values(state.threads).find((t) => t.agent_name === name);
}

async function markAnswered(ix, note) {
  const content = ix.message?.content ?? "";
  await ix.editReply({
    content: `${content}\n— ${note} by ${ix.user.username}`.slice(0, 2000),
    components: [],
  });
}

async function onInteraction(ix) {
  try {
    if (!ix.isButton() && !ix.isModalSubmit()) return;
    const [ns, kind, agentName, payload] = ix.customId.split(":");
    if (ns !== "hd" || !kind || !agentName) return;
    if (!authorized(ix.user.id)) {
      return ix.reply({ content: "You are not on the allowed-users list for this bridge.", ephemeral: true });
    }
    const mapping = mappingForAgent(agentName);
    if (!mapping) {
      return ix.reply({ content: `No agent named \`${agentName}\` is mapped anymore.`, ephemeral: true });
    }

    if (ix.isButton() && kind === "modal") {
      const modal = new ModalBuilder()
        .setCustomId(`hd:text:${agentName}`)
        .setTitle(`Answer ${agentName}`.slice(0, 45));
      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId("answer")
            .setLabel("Response sent to the agent")
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true),
        ),
      );
      return ix.showModal(modal);
    }

    if (ix.isButton() && kind === "keys") {
      const agent = await herdr.getAgent(agentName).catch(() => null);
      const status = agent?.status ?? agent?.agent_status;
      if (status && status !== "blocked") {
        return ix.update({
          content: `${ix.message.content}\n— already answered (agent is ${status})`,
          components: [],
        });
      }
      await ix.deferUpdate();
      await herdr.sendKeys(agentName, payload.split(","));
      return markAnswered(ix, `chose \`${payload}\``);
    }

    if (ix.isModalSubmit() && kind === "text") {
      const answer = ix.fields.getTextInputValue("answer");
      await ix.deferUpdate();
      await herdr.sendText(mapping.pane_id, answer);
      await herdr.sendKeys(agentName, ["enter"]);
      return markAnswered(ix, "sent a reply");
    }
  } catch (err) {
    console.error("interaction failed:", err);
    const reply = { content: `Error: ${err.message}`, ephemeral: true };
    await (ix.deferred || ix.replied ? ix.followUp(reply) : ix.reply(reply)).catch(() => {});
  }
}

async function pollAgents() {
  const agents = await herdr.listAgents().catch(() => null);
  if (agents === null) return;
  const byName = new Map();
  for (const a of agents) {
    const name = a.name ?? a.agent;
    if (name) byName.set(name, a.status ?? a.agent_status ?? "unknown");
  }

  let dirty = false;
  for (const [threadId, mapping] of Object.entries(state.threads)) {
    const status = byName.get(mapping.agent_name);
    const prev = mapping.last_status;

    if (status === undefined) {
      if (prev !== "gone") {
        mapping.last_status = "gone";
        dirty = true;
        const thread = await client.channels.fetch(threadId).catch(() => null);
        await thread?.send(`Agent \`${mapping.agent_name}\` is no longer running.`).catch(() => {});
      }
      continue;
    }
    if (status === prev) continue;

    mapping.last_status = status;
    dirty = true;
    if (!config.statusPosts || prev === "starting" || prev === "gone") continue;

    const thread = await client.channels.fetch(threadId).catch(() => null);
    if (!thread) continue;

    if (status === "blocked") {
      const snapshot = await herdr
        .readAgent(mapping.agent_name, { source: "detection", lines: 25 })
        .catch(() => "");
      if (snapshot.trim()) await postOutput(thread, snapshot).catch(() => {});
      await thread
        .send({
          content: `🛑 \`${mapping.agent_name}\` needs input — pick an option or reply here:`,
          components: promptComponents(mapping.agent_name, parsePrompt(snapshot)),
        })
        .catch(() => {});
    } else if (status === "done") {
      const output = await herdr
        .readAgent(mapping.agent_name, { lines: config.outputLines })
        .catch(() => "");
      await thread.send(`✅ \`${mapping.agent_name}\` finished.`).catch(() => {});
      if (output.trim()) await postOutput(thread, output).catch(() => {});
    }
  }
  if (dirty) saveState(state);
}

client.on("threadCreate", onThreadCreate);
client.on("messageCreate", onMessage);
client.on("interactionCreate", onInteraction);
client.once("clientReady", (c) => {
  console.log(`herdr-discord: logged in as ${c.user.tag}`);
  setInterval(() => pollAgents().catch((e) => console.error("poll failed:", e)), config.pollMs);
});

client.login(token);

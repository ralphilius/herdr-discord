import {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
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

// Directive lines in a thread's starter message: `kind:codex`, `cwd:/path`,
// `machine:gpu-box`. Returns the directives plus the remaining prompt text.
function parseStarter(content) {
  const lines = (content ?? "").split("\n");
  const directives = {};
  const rest = [];
  for (const line of lines) {
    const m = line.trim().match(/^(kind|cwd|machine)\s*:\s*(\S+)\s*$/i);
    if (m) directives[m[1].toLowerCase()] = m[2];
    else rest.push(line);
  }
  return { ...directives, prompt: rest.join("\n").trim() };
}

function authorized(userId) {
  return config.allowedUsers.size === 0 || config.allowedUsers.has(userId);
}

// Resolve a `workspace=` channel config value: workspace id or label.
async function resolveWorkspace(idOrLabel, machine) {
  const workspaces = await herdr.listWorkspaces(machine).catch(() => []);
  return (
    workspaces.find((w) => w.workspace_id === idOrLabel || w.label === idOrLabel) ?? null
  );
}

async function onThreadCreate(thread) {
  try {
    if (config.guildId && thread.guildId !== config.guildId) return;
    if (state.threads[thread.id]) return;

    const channelState = state.channels[thread.parentId];
    const channelCfg =
      config.channelConfig(thread.parentId, thread.parent?.topic) ??
      (channelState?.bound ? {} : null);
    if (channelCfg === null) return;

    const starter = await thread.fetchStarterMessage().catch(() => null);
    if (starter && !authorized(starter.author.id)) return;

    await thread.join().catch(() => {});

    const starter_directives = parseStarter(starter?.content);
    const { prompt } = starter_directives;
    const kind = starter_directives.kind ?? channelCfg.kind ?? config.agentKind;
    const cwd = starter_directives.cwd ?? channelCfg.cwd ?? config.cwd;
    const machine =
      starter_directives.machine ?? channelCfg.machine ?? channelState?.machine ?? null;

    await thread.send(`Starting a **${kind}** agent for this thread…`);

    const chState = (state.channels[thread.parentId] ??= {});
    let workspace;
    if (channelCfg.workspace) {
      workspace = await resolveWorkspace(channelCfg.workspace, machine);
      if (!workspace) {
        throw new Error(
          `workspace "${channelCfg.workspace}" not found${machine ? ` on ${machine}` : ""} — fix the channel topic or run \`!setup\``,
        );
      }
    } else {
      // Bound channels reuse their workspace only while the machine matches;
      // a machine override spins up elsewhere without touching the binding.
      const useBound = chState.bound && chState.machine === machine;
      workspace = await herdr.ensureWorkspace({
        workspaceId: useBound ? chState.workspace_id : null,
        cwd: channelCfg.cwd ?? config.cwd,
        label: channelCfg.label ?? thread.parent?.name ?? `discord-${thread.parentId}`,
        machine,
      });
      if (!chState.bound) {
        chState.machine = machine;
        chState.workspace_id = workspace.workspace_id;
      }
    }

    const tab = await herdr.createTab({
      workspaceId: workspace.workspace_id,
      cwd,
      label: thread.name.slice(0, 60),
      machine,
    });
    const paneId = tab.root_pane?.pane_id ?? tab.pane?.pane_id;
    if (!paneId) throw new Error("tab created but no root pane id in response");

    const existing = new Set(
      (await herdr.listAgents(machine).catch(() => [])).map((a) => a.name ?? a.agent),
    );
    for (const t of Object.values(state.threads)) {
      if ((t.machine ?? null) === machine) existing.add(t.agent_name);
    }
    const name = slugify(thread.name, existing);

    await herdr.startAgent({ name, kind, paneId, machine });

    state.threads[thread.id] = {
      workspace_id: workspace.workspace_id,
      tab_id: tab.tab?.tab_id,
      pane_id: paneId,
      agent_name: name,
      kind,
      machine,
      channel_id: thread.parentId,
      last_status: "starting",
    };
    saveState(state);

    await post(
      thread,
      `Agent \`${name}\` (${kind}) is up — tab \`${tab.tab?.tab_id}\` in workspace \`${workspace.workspace_id}\`` +
        `${machine ? ` on \`${machine}\`` : ""}.\n` +
        "Reply here to prompt it. Commands: `!status` `!read [n]` `!approve` `!close` `!help`",
    );

    if (prompt) await herdr.promptAgent(name, prompt, machine);
  } catch (err) {
    console.error("threadCreate failed:", err);
    await thread.send(`Failed to start agent: ${err.message}`).catch(() => {});
  }
}

async function onMessage(msg) {
  try {
    if (msg.author.bot) return;
    if (config.guildId && msg.guildId !== config.guildId) return;

    if (!msg.channel.isThread()) {
      if (msg.hasThread) return; // thread starter echo in the parent channel
      const text = msg.content.trim();
      if (text.startsWith("!")) await onChannelCommand(msg, text);
      return;
    }

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
      await herdr.promptAgent(mapping.agent_name, prompt, mapping.machine);
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

// Commands posted in the channel itself (not a thread). `!setup` binds the
// channel to an existing workspace; binding also watches the channel.
async function onChannelCommand(msg, text) {
  const [cmd, arg] = text.slice(1).split(/\s+/, 2);
  const chState = state.channels[msg.channelId];

  switch (cmd.toLowerCase()) {
    case "setup": {
      if (!authorized(msg.author.id)) {
        await msg.reply("You are not on the allowed-users list for this bridge.");
        return;
      }
      const machine =
        arg ||
        config.channelConfig(msg.channelId, msg.channel.topic)?.machine ||
        chState?.machine ||
        null;
      const workspaces = await herdr.listWorkspaces(machine).catch(() => []);
      const select = new StringSelectMenuBuilder()
        .setCustomId(`hd:setup:${msg.channelId}`)
        .setPlaceholder("Pick a Herdr workspace for this channel");
      for (const w of workspaces.slice(0, 24)) {
        select.addOptions({
          label: (w.label ?? w.workspace_id).slice(0, 100),
          value: JSON.stringify({ m: machine, w: w.workspace_id }),
          description: (w.cwd ?? "").slice(0, 100) || "existing workspace",
        });
      }
      select.addOptions({
        label: "New workspace (auto-created)",
        value: JSON.stringify({ m: machine, new: true }),
        description: "create one from this channel on the first thread",
      });
      await msg.reply({
        content: `Bind this channel to a Herdr workspace${machine ? ` on \`${machine}\`` : ""}:`,
        components: [new ActionRowBuilder().addComponents(select)],
      });
      break;
    }
    case "unbind": {
      if (!authorized(msg.author.id)) return;
      delete state.channels[msg.channelId];
      saveState(state);
      const stillWatched = config.channelConfig(msg.channelId, msg.channel.topic) !== null;
      await msg.reply(
        stillWatched
          ? "Workspace binding cleared — the topic/channels.json still watch this channel, so new threads auto-create a workspace."
          : "Channel unbound — new threads will no longer spawn agents.",
      );
      break;
    }
    case "status": {
      const watched =
        config.channelConfig(msg.channelId, msg.channel.topic) !== null || chState?.bound;
      const lines = [`Channel watched: **${watched ? "yes" : "no"}**`];
      if (chState?.workspace_id)
        lines.push(
          `Workspace: \`${chState.workspace_id}\`${chState.bound ? " (bound via !setup)" : " (auto-created)"}`,
        );
      if (chState?.machine) lines.push(`Machine: \`${chState.machine}\``);
      const threads = Object.values(state.threads).filter(
        (t) => t.channel_id === msg.channelId,
      ).length;
      lines.push(`Mapped threads: ${threads}`);
      await msg.reply(lines.join("\n"));
      break;
    }
    case "help": {
      await msg.reply(
        "`!setup [machine]` bind this channel to a Herdr workspace · `!unbind` clear the binding · `!status` channel state\n" +
          "Or put `herdr:` in the channel topic, e.g. `herdr: workspace=my-api kind=claude`.",
      );
      break;
    }
    default:
      break;
  }
}

async function onCommand(msg, mapping, text) {
  const [cmd, arg] = text.slice(1).split(/\s+/, 2);
  switch (cmd.toLowerCase()) {
    case "status": {
      const agent = await herdr.getAgent(mapping.agent_name, mapping.machine);
      const status = agent.status ?? agent.agent_status ?? "unknown";
      await msg.reply(
        `\`${mapping.agent_name}\` (${mapping.kind}) — **${status}**\n` +
          `workspace \`${mapping.workspace_id}\` tab \`${mapping.tab_id}\` pane \`${mapping.pane_id}\`` +
          (mapping.machine ? ` machine \`${mapping.machine}\`` : ""),
      );
      break;
    }
    case "read": {
      const n = Math.min(Math.max(parseInt(arg, 10) || config.outputLines, 1), 80);
      await postOutput(
        msg.channel,
        await herdr.readAgent(mapping.agent_name, { lines: n, machine: mapping.machine }),
      );
      break;
    }
    case "approve": {
      await herdr.sendKeys(mapping.agent_name, ["enter"], mapping.machine);
      await msg.react("👍").catch(() => {});
      break;
    }
    case "close": {
      await msg.reply("Closing the agent tab…");
      if (mapping.tab_id) await herdr.closeTab(mapping.tab_id, mapping.machine).catch(() => {});
      delete state.threads[msg.channel.id];
      saveState(state);
      break;
    }
    case "help": {
      await msg.reply(
        "`!status` agent status · `!read [n]` last n output lines · " +
          "`!approve` send Enter to a blocked agent · `!close` close the agent tab\n" +
          "Starter directives (own lines): `kind:<agent>` `cwd:<path>` `machine:<label>`. " +
          "Channel config goes in the channel topic: `herdr: kind=codex cwd=~/code/x`.",
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
    if (!ix.isButton() && !ix.isModalSubmit() && !ix.isStringSelectMenu()) return;
    const [ns, kind, agentName, payload] = ix.customId.split(":");
    if (ns !== "hd" || !kind || !agentName) return;
    if (!authorized(ix.user.id)) {
      return ix.reply({ content: "You are not on the allowed-users list for this bridge.", ephemeral: true });
    }

    if (ix.isStringSelectMenu() && kind === "setup") {
      const channelId = agentName;
      const v = JSON.parse(ix.values[0]);
      state.channels[channelId] = v.new
        ? { bound: true, machine: v.m ?? null }
        : { bound: true, machine: v.m ?? null, workspace_id: v.w };
      saveState(state);
      return ix.update({
        content: v.new
          ? `Channel bound — a new workspace will be created on the first thread${v.m ? ` on \`${v.m}\`` : ""}.`
          : `Channel bound to workspace \`${v.w}\`${v.m ? ` on \`${v.m}\`` : ""}. New threads spawn agents as tabs there.`,
        components: [],
      });
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
      const agent = await herdr.getAgent(agentName, mapping.machine).catch(() => null);
      const status = agent?.status ?? agent?.agent_status;
      if (status && status !== "blocked") {
        return ix.update({
          content: `${ix.message.content}\n— already answered (agent is ${status})`,
          components: [],
        });
      }
      await ix.deferUpdate();
      await herdr.sendKeys(agentName, payload.split(","), mapping.machine);
      return markAnswered(ix, `chose \`${payload}\``);
    }

    if (ix.isModalSubmit() && kind === "text") {
      const answer = ix.fields.getTextInputValue("answer");
      await ix.deferUpdate();
      await herdr.sendText(mapping.pane_id, answer, mapping.machine);
      await herdr.sendKeys(agentName, ["enter"], mapping.machine);
      return markAnswered(ix, "sent a reply");
    }
  } catch (err) {
    console.error("interaction failed:", err);
    const reply = { content: `Error: ${err.message}`, ephemeral: true };
    await (ix.deferred || ix.replied ? ix.followUp(reply) : ix.reply(reply)).catch(() => {});
  }
}

// Group thread mappings by machine: each Herdr server owns its own agents,
// so remote mappings are polled through `herdr --machine <label>`.
async function pollAgents() {
  const byMachine = new Map();
  for (const [threadId, mapping] of Object.entries(state.threads)) {
    const machine = mapping.machine ?? null;
    if (!byMachine.has(machine)) byMachine.set(machine, []);
    byMachine.get(machine).push([threadId, mapping]);
  }

  let dirty = false;
  for (const [machine, entries] of byMachine) {
    const agents = await herdr.listAgents(machine).catch(() => null);
    if (agents === null) continue;
    const byName = new Map();
    for (const a of agents) {
      const name = a.name ?? a.agent;
      if (name) byName.set(name, a.status ?? a.agent_status ?? "unknown");
    }
    for (const [threadId, mapping] of entries) {
      dirty = (await relayTransition(threadId, mapping, byName.get(mapping.agent_name))) || dirty;
    }
  }
  if (dirty) saveState(state);
}

// Compare a mapping's last status with the live one; post transitions and
// return true when state changed.
async function relayTransition(threadId, mapping, status) {
  const prev = mapping.last_status;

  if (status === undefined) {
    if (prev === "gone") return false;
    mapping.last_status = "gone";
    const thread = await client.channels.fetch(threadId).catch(() => null);
    await thread?.send(`Agent \`${mapping.agent_name}\` is no longer running.`).catch(() => {});
    return true;
  }
  if (status === prev) return false;

  mapping.last_status = status;
  if (!config.statusPosts || prev === "starting" || prev === "gone") return true;

  const thread = await client.channels.fetch(threadId).catch(() => null);
  if (!thread) return true;

  if (status === "blocked") {
    const snapshot = await herdr
      .readAgent(mapping.agent_name, { source: "detection", lines: 25, machine: mapping.machine })
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
      .readAgent(mapping.agent_name, { lines: config.outputLines, machine: mapping.machine })
      .catch(() => "");
    await thread.send(`✅ \`${mapping.agent_name}\` finished.`).catch(() => {});
    if (output.trim()) await postOutput(thread, output).catch(() => {});
  }
  return true;
}

client.on("threadCreate", onThreadCreate);
client.on("messageCreate", onMessage);
client.on("interactionCreate", onInteraction);
client.once("clientReady", (c) => {
  console.log(`herdr-discord: logged in as ${c.user.tag}`);
  setInterval(() => pollAgents().catch((e) => console.error("poll failed:", e)), config.pollMs);
});

client.login(token);

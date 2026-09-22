import { config } from "../config.js";
import { loadState } from "../state.js";
import { listAgents } from "../herdr.js";

const state = loadState();
const agents = await listAgents().catch(() => []);
const byName = new Map(agents.map((a) => [a.name ?? a.agent, a.status ?? a.agent_status]));

console.log(`herdr-discord bridge (${config.configDir})`);
console.log(`token: ${config.token ? "configured" : "MISSING — set DISCORD_BOT_TOKEN"}`);
console.log(`watched channels: ${Object.keys(config.channels).length || "all (no channels.json)"}`);
console.log(`default kind: ${config.agentKind}`);
console.log("");

const threads = Object.entries(state.threads);
if (!threads.length) {
  console.log("no mapped threads");
} else {
  for (const [threadId, t] of threads) {
    const live = byName.get(t.agent_name) ?? t.last_status;
    console.log(`thread ${threadId} -> ${t.agent_name} (${t.kind}) [${live}] ws:${t.workspace_id} tab:${t.tab_id}`);
  }
}

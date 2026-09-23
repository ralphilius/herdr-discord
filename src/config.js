import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseTopicConfig } from "./topics.js";

const root = process.env.HERDR_PLUGIN_ROOT ?? process.cwd();
const configDir = process.env.HERDR_PLUGIN_CONFIG_DIR ?? root;

function readEnvFile(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

// Config dir wins over the plugin root, so a local .env works for development
// while installed plugins read HERDR_PLUGIN_CONFIG_DIR.
const fileEnv = { ...readEnvFile(join(root, ".env")), ...readEnvFile(join(configDir, ".env")) };
const env = (key) => process.env[key] || fileEnv[key] || "";

function readChannels() {
  for (const dir of [configDir, root]) {
    const path = join(dir, "channels.json");
    if (existsSync(path)) {
      try {
        return JSON.parse(readFileSync(path, "utf8"));
      } catch (err) {
        console.error(`herdr-discord: failed to parse ${path}: ${err.message}`);
        return {};
      }
    }
  }
  return {};
}

const channels = readChannels();

export const config = {
  pluginId: process.env.HERDR_PLUGIN_ID ?? "herdr.discord",
  configDir,
  stateDir: process.env.HERDR_PLUGIN_STATE_DIR ?? root,
  token: env("DISCORD_BOT_TOKEN"),
  guildId: env("DISCORD_GUILD_ID"),
  allowedUsers: new Set(env("DISCORD_ALLOWED_USERS").split(",").map((s) => s.trim()).filter(Boolean)),
  agentKind: env("HERDR_AGENT_KIND") || "claude",
  cwd: env("HERDR_WORKSPACE_CWD") || null,
  autostart: env("DISCORD_AUTOSTART") === "1",
  statusPosts: env("DISCORD_STATUS_POSTS") !== "0",
  outputLines: Math.min(Math.max(parseInt(env("DISCORD_OUTPUT_LINES") || "30", 10) || 30, 1), 80),
  pollMs: Math.max(parseInt(env("DISCORD_POLL_MS") || "3000", 10) || 3000, 1000),
  channels,
  // A channel is watched when it has a channels.json entry (which overrides
  // everything) or when its topic carries a `herdr:` marker. Returns null for
  // unwatched channels.
  channelConfig(channelId, topic) {
    if (channels[channelId]) return channels[channelId];
    return parseTopicConfig(topic);
  },
};

export function requireToken() {
  if (!config.token) {
    console.error(
      `herdr-discord: DISCORD_BOT_TOKEN is not set. Copy .env.example to ${join(config.configDir, ".env")} and fill it in.`,
    );
    process.exit(1);
  }
  return config.token;
}

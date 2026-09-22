import { spawnSync } from "node:child_process";
import { config } from "./config.js";

// One-shot startup hook: reopen the Discord bot tab after the Herdr server
// (re)starts. Disabled by default; set DISCORD_AUTOSTART=1 in the plugin .env.
if (!config.autostart) process.exit(0);

const herdr = process.env.HERDR_BIN_PATH ?? "herdr";
const res = spawnSync(
  herdr,
  ["plugin", "pane", "open", "--plugin", config.pluginId, "--entrypoint", "bot", "--placement", "tab"],
  { encoding: "utf8" },
);
if (res.status !== 0) {
  console.error(`herdr-discord: autostart failed: ${res.stderr || res.stdout}`);
  process.exit(res.status ?? 1);
}
console.log("herdr-discord: bot tab opened");

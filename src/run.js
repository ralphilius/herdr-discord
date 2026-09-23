import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Supervisor for the bot pane: Herdr does not restart pane processes, so a
// crash or a missing token would leave the bridge dead until someone noticed.
// Restart the child with backoff (5s → 5m); a fast exit means something is
// wrong (bad config, token revoked), and retrying forever is still right —
// it self-heals once the .env is fixed. Closing the pane kills this process
// and its child together.
const bot = join(dirname(fileURLToPath(import.meta.url)), "bot.js");

const MIN_UPTIME_MS = 30_000;
const BASE_DELAY_MS = 5_000;
const MAX_DELAY_MS = 300_000;

let delay = BASE_DELAY_MS;

function start() {
  const child = spawn(process.execPath, [bot], { stdio: "inherit" });
  const startedAt = Date.now();
  child.on("error", (err) => {
    console.error(`herdr-discord: failed to spawn bot: ${err.message}`);
  });
  child.on("exit", (code, signal) => {
    const upMs = Date.now() - startedAt;
    if (upMs >= MIN_UPTIME_MS) delay = BASE_DELAY_MS;
    console.error(`herdr-discord: bot exited (code=${code} signal=${signal}) after ${Math.round(upMs / 1000)}s; restarting in ${Math.round(delay / 1000)}s`);
    setTimeout(start, delay);
    delay = Math.min(delay * 2, MAX_DELAY_MS);
  });
}

start();

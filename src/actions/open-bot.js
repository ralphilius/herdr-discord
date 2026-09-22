import { spawnSync } from "node:child_process";
import { config } from "../config.js";

const herdr = process.env.HERDR_BIN_PATH ?? "herdr";
const res = spawnSync(
  herdr,
  ["plugin", "pane", "open", "--plugin", config.pluginId, "--entrypoint", "bot", "--placement", "tab"],
  { encoding: "utf8", stdio: ["ignore", "inherit", "inherit"] },
);
process.exit(res.status ?? 1);

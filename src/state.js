import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";

const path = join(config.stateDir, process.env.HERDR_ENV ? "state.json" : "state.local.json");

function empty() {
  return { channels: {}, threads: {} };
}

export function loadState() {
  if (!existsSync(path)) return empty();
  try {
    return { ...empty(), ...JSON.parse(readFileSync(path, "utf8")) };
  } catch {
    return empty();
  }
}

export function saveState(state) {
  mkdirSync(config.stateDir, { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, path);
}

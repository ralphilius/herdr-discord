// Keep herdr-plugin.toml's version in lockstep with package.json.
// Runs as npm's `version` lifecycle script (after package.json is written,
// before the release commit), so `npm version patch` bumps both files.
import { readFileSync, writeFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const toml = readFileSync("herdr-plugin.toml", "utf8");
const updated = toml.replace(/^version = ".*"$/m, `version = "${version}"`);

if (updated === toml) {
  console.error(`sync-version: no version field updated in herdr-plugin.toml`);
  process.exit(1);
}
writeFileSync("herdr-plugin.toml", updated);
console.log(`sync-version: herdr-plugin.toml -> ${version}`);

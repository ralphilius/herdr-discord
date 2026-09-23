import { spawn } from "node:child_process";

const bin = process.env.HERDR_BIN_PATH ?? "herdr";

export class HerdrError extends Error {
  constructor(message, code, stderr) {
    super(message);
    this.code = code;
    this.stderr = stderr;
  }
}

// Run a herdr CLI command and return the parsed JSON response. Most CLI
// commands print {"id": ..., "result": {...}} or {"error": {...}}.
export function herdr(args, { timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new HerdrError(`herdr ${args.join(" ")} timed out`, "timeout", stderr));
    }, timeout);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new HerdrError(`failed to spawn ${bin}: ${err.message}`, "spawn_error", stderr));
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      let parsed;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        if (status !== 0) {
          reject(new HerdrError(`herdr ${args[0]} exited ${status}: ${stderr.trim()}`, "exit_error", stderr));
        } else {
          resolve({ raw: stdout });
        }
        return;
      }
      if (parsed.error) {
        reject(new HerdrError(parsed.error.message ?? "herdr error", parsed.error.code ?? "error", stderr));
      } else {
        resolve(parsed.result ?? parsed);
      }
    });
  });
}

// Same, but returns raw stdout for commands that print terminal text
// (pane read, agent read).
export function herdrText(args, { timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new HerdrError(`herdr ${args.join(" ")} timed out`, "timeout", stderr));
    }, timeout);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new HerdrError(`failed to spawn ${bin}: ${err.message}`, "spawn_error", stderr));
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      if (status !== 0) reject(new HerdrError(stderr.trim() || `exit ${status}`, "exit_error", stderr));
      else resolve(stdout);
    });
  });
}

// List commands print JSON by default on current Herdr builds; retry without
// --json for builds where the flag isn't accepted.
async function list(args, key) {
  const res = await herdr([...args, "--json"]).catch(() => herdr(args));
  return res[key] ?? (Array.isArray(res) ? res : []);
}

export function listAgents() {
  return list(["agent", "list"], "agents");
}

export function listWorkspaces() {
  return list(["workspace", "list"], "workspaces");
}

export async function findWorkspace(workspaceId) {
  const workspaces = await listWorkspaces();
  return workspaces.find((w) => w.workspace_id === workspaceId) ?? null;
}

export async function ensureWorkspace({ workspaceId, cwd, label }) {
  if (workspaceId) {
    const existing = await findWorkspace(workspaceId).catch(() => null);
    if (existing) return existing;
  }
  const args = ["workspace", "create", "--label", label, "--no-focus"];
  if (cwd) args.push("--cwd", cwd);
  const res = await herdr(args);
  return res.workspace;
}

export async function createTab({ workspaceId, cwd, label }) {
  const args = ["tab", "create", "--workspace", workspaceId, "--label", label, "--no-focus"];
  if (cwd) args.push("--cwd", cwd);
  return herdr(args);
}

export async function startAgent({ name, kind, paneId }) {
  return herdr(["agent", "start", name, "--kind", kind, "--pane", paneId], { timeout: 320000 });
}

export async function promptAgent(target, text) {
  return herdr(["agent", "prompt", target, text]);
}

export async function getAgent(target) {
  const res = await herdr(["agent", "get", target]);
  return res.agent ?? res;
}

export function readAgent(target, { source = "recent", lines = 30 } = {}) {
  return herdrText(["agent", "read", target, "--source", source, "--lines", String(lines)]);
}

export async function sendKeys(target, keys) {
  return herdr(["agent", "send-keys", target, ...keys]);
}

// Literal text into the pane's PTY (no Enter). Used for free-text answers
// to blocked agents, where send-keys would need one event per character.
export async function sendText(paneId, text) {
  return herdr(["pane", "send-text", paneId, text]);
}

export async function closeTab(tabId) {
  return herdr(["tab", "close", tabId]);
}

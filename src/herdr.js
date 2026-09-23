import { spawn } from "node:child_process";

const bin = process.env.HERDR_BIN_PATH ?? "herdr";

export class HerdrError extends Error {
  constructor(message, code, stderr) {
    super(message);
    this.code = code;
    this.stderr = stderr;
  }
}

function withMachine(args, machine) {
  return machine ? ["--machine", machine, ...args] : args;
}

// Run a herdr CLI command and return the parsed JSON response. Most CLI
// commands print {"id": ..., "result": {...}} or {"error": {...}}.
// `machine` routes the call to a saved SSH machine (`herdr --machine`).
export function herdr(args, { timeout = 30000, machine = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, withMachine(args, machine), { stdio: ["ignore", "pipe", "pipe"] });
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
export function herdrText(args, { timeout = 30000, machine = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, withMachine(args, machine), { stdio: ["ignore", "pipe", "pipe"] });
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
async function list(args, key, machine) {
  const res = await herdr([...args, "--json"], { machine }).catch(() => herdr(args, { machine }));
  return res[key] ?? (Array.isArray(res) ? res : []);
}

export function listAgents(machine) {
  return list(["agent", "list"], "agents", machine);
}

export function listWorkspaces(machine) {
  return list(["workspace", "list"], "workspaces", machine);
}

export async function findWorkspace(workspaceId, machine) {
  const workspaces = await listWorkspaces(machine);
  return workspaces.find((w) => w.workspace_id === workspaceId) ?? null;
}

export async function ensureWorkspace({ workspaceId, cwd, label, machine }) {
  if (workspaceId) {
    const existing = await findWorkspace(workspaceId, machine).catch(() => null);
    if (existing) return existing;
  }
  const args = ["workspace", "create", "--label", label, "--no-focus"];
  if (cwd) args.push("--cwd", cwd);
  const res = await herdr(args, { machine });
  return res.workspace;
}

export async function createTab({ workspaceId, cwd, label, machine }) {
  const args = ["tab", "create", "--workspace", workspaceId, "--label", label, "--no-focus"];
  if (cwd) args.push("--cwd", cwd);
  return herdr(args, { machine });
}

export async function startAgent({ name, kind, paneId, machine }) {
  return herdr(["agent", "start", name, "--kind", kind, "--pane", paneId], {
    timeout: 320000,
    machine,
  });
}

export async function promptAgent(target, text, machine) {
  return herdr(["agent", "prompt", target, text], { machine });
}

export async function getAgent(target, machine) {
  const res = await herdr(["agent", "get", target], { machine });
  return res.agent ?? res;
}

export function readAgent(target, { source = "recent", lines = 30, machine = null } = {}) {
  return herdrText(["agent", "read", target, "--source", source, "--lines", String(lines)], {
    machine,
  });
}

export async function sendKeys(target, keys, machine) {
  return herdr(["agent", "send-keys", target, ...keys], { machine });
}

// Literal text into the pane's PTY (no Enter). Used for free-text answers
// to blocked agents, where send-keys would need one event per character.
export async function sendText(paneId, text, machine) {
  return herdr(["pane", "send-text", paneId, text], { machine });
}

export async function closeTab(tabId, machine) {
  return herdr(["tab", "close", tabId], { machine });
}

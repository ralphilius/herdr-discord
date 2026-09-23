// Per-channel config embedded in the Discord channel topic. A channel is
// watched when its topic contains a `herdr:` marker:
//
//   "herdr:"                          → watch with global defaults
//   "herdr: kind=codex cwd=~/code/x"  → key=value pairs
//   "herdr: {\"kind\":\"codex\"}"      → JSON object
//
// Supported keys: cwd, kind, label, machine (a `herdr machine` profile).
// Forum channels work too — Discord stores their "guidelines" in `topic`.
const KNOWN_KEYS = new Set(["cwd", "kind", "label", "machine"]);

export function parseTopicConfig(topic) {
  if (!topic) return null;
  const m = topic.match(/herdr\s*:\s*(\{[^\n]*\}|[^\n]*)/i);
  if (!m) return null;
  const body = m[1].trim();

  const raw = {};
  if (body.startsWith("{")) {
    try {
      Object.assign(raw, JSON.parse(body));
    } catch {
      return {};
    }
  } else {
    for (const pair of body.split(/[;\s]+/)) {
      const eq = pair.indexOf("=");
      if (eq > 0) raw[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
    }
  }

  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (KNOWN_KEYS.has(k) && v != null) out[k] = String(v);
  }
  return out;
}

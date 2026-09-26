// Per-kind mid-turn behavior. Herdr doesn't expose a capability flag, so this
// table is owned here. `queue` kinds accept typed input while working — their
// TUI stacks it as a pending message (claude, codex). `hold` is the default:
// typing mid-render lands as garbage, so the bridge holds the prompt until the
// agent settles.
const MID_TURN = {
  claude: "queue",
  codex: "queue",
};

export function midTurnStrategy(kind) {
  return MID_TURN[kind] ?? "hold";
}

export function midTurnDescription(kind) {
  return midTurnStrategy(kind) === "queue"
    ? "queued by the agent"
    : "held by the bridge until idle";
}

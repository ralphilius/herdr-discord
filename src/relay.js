// Output relay: turns repeated `agent read` snapshots into appended lines.
//
// Snapshots are windows into scrollback whose bottom region is a live redraw
// zone (spinners, status bars, the input box). A line is emitted when it
// survives unchanged between two consecutive reads, or when enough newer
// output has pushed it above the churn zone. Spinner frames churn every tick
// so they never persist; real output does.
//
// State per thread:
//   anchor    last contiguous non-blank run of the last emitted region —
//             located in each new snapshot to find where new output starts
//   floor     baseline lines after the anchor; stripped from each candidate
//             so pre-relay content is never back-posted
//   deferred  lines after the floor not yet confirmed (the pending tail)
//   base      lines present at baseline/rebase time — suppressed forever so
//             pre-relay content can't emit. Emitted lines are NOT tracked:
//             legitimately repeated output must re-post.
//   misses    consecutive ticks where the anchor wasn't found (display reset)

const ANCHOR_LINES = 5;
const CHURN_LINES = 20;
const MAX_MISSES = 2;

// The part of a snapshot outside the bottom churn zone — safe to anchor on.
// Short snapshots shrink the churn window so they can still establish an
// anchor; below ~2 lines there's nothing to anchor to and we re-baseline.
function head(lines) {
  const churn = Math.min(CHURN_LINES, Math.max(1, lines.length - ANCHOR_LINES));
  return lines.slice(0, Math.max(0, lines.length - churn));
}

// Last contiguous non-blank run in `lines`, up to n lines. Returns the run
// and the index where it ends (blank lines inside the run would make the
// anchor unmatchable, so the run stops at the first blank).
function anchorRun(lines, n) {
  let end = lines.length;
  while (end > 0 && !lines[end - 1].trim()) end--;
  let start = end;
  while (start > 0 && lines[start - 1].trim() && end - start < n) start--;
  return { lines: lines.slice(start, end), end };
}

// Where the candidate region starts: the index after the full anchor span.
// The anchor's tail lives at the emission boundary and often rewrites, so a
// leading run of `anchor` counts — at least 3 lines (or the whole anchor when
// it's shorter). Latest occurrence wins.
function findAnchor(lines, anchor) {
  if (!anchor.length) return -1;
  const maxLen = Math.min(anchor.length, lines.length);
  const minLen = Math.min(anchor.length, 3);
  for (let len = maxLen; len >= minLen; len--) {
    let found = -1;
    outer: for (let i = lines.length - len; i >= 0; i--) {
      for (let j = 0; j < len; j++) {
        if (lines[i + j] !== anchor[j]) continue outer;
      }
      found = i;
    }
    if (found !== -1) return Math.min(found + anchor.length, lines.length);
  }
  return -1;
}

// Longest common prefix length.
function lcp(a, b) {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

// Collapse consecutive identical lines (`line ×N`) and runs of blank lines.
export function collapse(lines) {
  const out = [];
  for (const line of lines) {
    const prev = out[out.length - 1];
    if (!line.trim()) {
      if (prev && prev.text.trim()) out.push({ text: line, count: 1 });
      continue;
    }
    if (prev && prev.text === line) prev.count++;
    else out.push({ text: line, count: 1 });
  }
  return out.map((l) => (l.count > 1 ? `${l.text} ×${l.count}` : l.text));
}

function baselineState(lines) {
  const a = anchorRun(head(lines), ANCHOR_LINES);
  return {
    anchor: a.lines,
    floor: lines.slice(a.end),
    deferred: [],
    misses: 0,
    base: new Set(lines),
  };
}

export class Relay {
  constructor() {
    this.threads = new Map();
  }

  // Feed a fresh snapshot; returns lines ready to post (already collapsed).
  // The first read only seeds the baseline — pre-relay output isn't posted.
  update(threadId, text) {
    const lines = text.replace(/\r/g, "").split("\n");
    let s = this.threads.get(threadId);
    if (!s) {
      s = baselineState(lines);
      this.threads.set(threadId, s);
      return [];
    }

    const candStart = findAnchor(lines, s.anchor);
    if (candStart === -1) {
      s.misses++;
      if (s.misses <= MAX_MISSES) return [];
      // Anchor slid out of the read window or the display was cleared —
      // rebase on the current snapshot and surface the seam.
      const emit = s.deferred.filter((l) => !s.base.has(l));
      const hadAnchor = s.anchor.length > 0;
      const next = baselineState(lines);
      for (const l of s.base) next.base.add(l);
      this.threads.set(threadId, next);
      return emit.length || hadAnchor
        ? [...collapse(emit), "⟳ display reset — output may be missing above"]
        : [];
    }
    s.misses = 0;

    const candidate = lines.slice(candStart);
    const eff = candidate.slice(lcp(s.floor, candidate));
    const persisted = lcp(s.deferred, eff);
    const settled = Math.max(0, eff.length - CHURN_LINES);
    const emitLen = Math.max(persisted, settled);
    const raw = eff.slice(0, emitLen);
    s.deferred = eff.slice(emitLen);

    if (raw.length) {
      const a = anchorRun(raw, ANCHOR_LINES);
      if (a.lines.length) s.anchor = a.lines;
      s.floor = [];
    }
    const emit = raw.filter((l) => !s.base.has(l));
    return collapse(emit);
  }

  // Emit whatever is still deferred — the bottom is final once the agent is
  // done or gone. Re-anchors on the flushed tail so output after `done`
  // continues without a reset.
  flush(threadId) {
    const s = this.threads.get(threadId);
    if (!s) return [];
    const raw = s.deferred;
    const emit = raw.filter((l) => !s.base.has(l));
    // Anchor on the stable part of the flushed tail — the last line is often
    // still-churning UI and would break the anchor on the next tick.
    const a = anchorRun(head(raw), ANCHOR_LINES);
    if (a.lines.length) s.anchor = a.lines;
    s.deferred = [];
    return collapse(emit);
  }

  has(threadId) {
    return this.threads.has(threadId);
  }

  drop(threadId) {
    this.threads.delete(threadId);
  }
}

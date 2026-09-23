// Parse an agent's `detection` snapshot (the bottom-buffer Herdr uses for
// screen detection) into buttons the user can click to answer.

const CURSOR = /^\s*[❯›>●]/;
const NUMBERED = /^\s*[❯›>●•\-*]?\s*(\d+)[.)]\s+(.+?)\s*$/;
const YESNO = /\[y\/n\]|\(y\/n\)|\[yes\/no\]|\(yes\/no\)|\(y or n\)|\[y\/N\]|\[Y\/n\]/i;

export function parsePrompt(snapshot) {
  const lines = snapshot.split("\n");
  const options = [];
  let cursor = -1;
  lines.forEach((line, i) => {
    const m = line.match(NUMBERED);
    if (m) {
      options.push({ index: options.length, line: i, num: +m[1], label: m[2] });
      if (CURSOR.test(line)) cursor = options.length - 1;
    }
  });
  if (options.length >= 2 && options.length <= 20) return { type: "options", options, cursor };
  if (YESNO.test(snapshot)) return { type: "yesno" };
  return { type: "unknown" };
}

// Keys to send for a parsed option. With a visible cursor row, move the
// selection with arrows and confirm; without one, press the option's number.
export function keysForOption(parsed, i) {
  if (parsed.cursor >= 0) {
    const delta = i - parsed.cursor;
    const keys = [];
    for (let k = 0; k < Math.abs(delta); k++) keys.push(delta > 0 ? "down" : "up");
    keys.push("enter");
    return keys;
  }
  return [String(parsed.options[i].num)];
}

// Terminal styling. Only when a person is looking: stdout (or stderr, for
// errors) is a terminal, NO_COLOR is unset, and TERM is not "dumb". Agents and
// pipes get the plain text unchanged. FORCE_COLOR=1 turns it on regardless.

const wrap = (open, close) => (s, stream) => (styled(stream) ? `\x1b[${open}m${s}\x1b[${close}m` : String(s));

export function styled(stream = process.stdout) {
  const e = process.env;
  if (e.FORCE_COLOR && e.FORCE_COLOR !== "0") return true;
  if ("NO_COLOR" in e && e.NO_COLOR !== "") return false;
  if (e.TERM === "dumb") return false;
  return !!stream?.isTTY;
}

export const bold = wrap(1, 22);
export const dim = wrap(2, 22);
export const red = wrap(31, 39);
export const green = wrap(32, 39);
export const yellow = wrap(33, 39);
export const cyan = wrap(36, 39);

const STATUS = {
  done: green,
  yes: green,
  running: cyan,
  starting: cyan,
  queued: cyan,
  failed: red,
  lost: red,
  NO: red,
  timeout: yellow,
  cancelled: yellow,
};

// Color a status word; keeps any padding around it so columns stay aligned.
export function status(text) {
  const word = String(text).trim();
  const paint = STATUS[word];
  return paint ? String(text).replace(word, paint(word)) : String(text);
}

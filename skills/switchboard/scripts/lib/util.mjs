// Small helpers shared by every module. Zero dependencies.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

export class SbError extends Error {}

// Throw a user-facing error; the CLI entry point prints it without a stack.
export function die(msg) {
  throw new SbError(msg);
}

export function readJSON(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

export function writeJSON(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

export function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

export function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function home(...parts) {
  return path.join(process.env.SWITCHBOARD_USER_HOME || os.homedir(), ...parts);
}

export function tilde(p) {
  const h = process.env.SWITCHBOARD_USER_HOME || os.homedir();
  return p && p.startsWith(h) ? `~${p.slice(h.length)}` : p;
}

// Common install locations that are often missing from a non-login PATH
// (agents run tool commands in shells that may not source the user's rc files).
const EXTRA_BIN_DIRS = [".local/bin", ".opencode/bin", ".bun/bin", ".npm-global/bin", ".cursor/bin"];

export function which(bin) {
  if (!bin) return null;
  if (bin.includes("/")) return exists(bin) ? bin : null;
  const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  if (!process.env.SWITCHBOARD_STRICT_PATH) {
    dirs.push(...EXTRA_BIN_DIRS.map((d) => home(d)), "/opt/homebrew/bin", "/usr/local/bin");
  }
  for (const dir of dirs) {
    const p = path.join(dir, bin);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      if (fs.statSync(p).isFile()) return p;
    } catch {}
  }
  return null;
}

// Environment for a child agent process. When Switchboard itself runs inside a
// Claude Code session, that session exports variables meant only for its own
// tools (CLAUDECODE, CLAUDE_CODE_SIMPLE=1 "bare mode", ANTHROPIC_BASE_URL, ...).
// A child `claude` that inherits them ignores its saved login and reports
// "Not logged in". A sub-agent is a fresh session, so drop them.
const KEEP_CLAUDE_VARS = /^CLAUDE_CODE_(OAUTH_TOKEN|USE_BEDROCK|USE_VERTEX|USE_FOUNDRY|SKIP_.*_AUTH|MAX_OUTPUT_TOKENS|GIT_BASH_PATH)$/;

// Each vendor's own credentials. A sub-agent from one vendor never receives
// another vendor's keys (a shell command it runs could print them into a
// transcript that goes to its provider). OpenCode is multi-provider and reads
// provider keys from the environment by design, so it keeps the API keys.
const VENDOR_KEYS = {
  claude: /^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN)$/,
  codex: /^(OPENAI_API_KEY|CODEX_API_KEY)$/,
  cursor: /^CURSOR_API_KEY$/,
  opencode: /^OPENCODE_API_KEY$/,
  antigravity: /^GEMINI_API_KEY$/,
};
const PROVIDER_KEYS = /^(ANTHROPIC_API_KEY|OPENAI_API_KEY|GEMINI_API_KEY)$/;

export function childEnv(extra = {}, forAgent = null) {
  const env = { ...process.env };
  if (forAgent) {
    for (const k of Object.keys(env)) {
      const owner = Object.keys(VENDOR_KEYS).find((v) => VENDOR_KEYS[v].test(k));
      if (!owner || owner === forAgent) continue;
      if (forAgent === "opencode" && PROVIDER_KEYS.test(k)) continue;
      delete env[k];
    }
  }
  if (env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT) {
    for (const k of Object.keys(env)) {
      if (k === "CLAUDECODE" || k === "CLAUDE_PID" || k === "CLAUDE_EFFORT") delete env[k];
      else if (/^CLAUDE_CODE_/.test(k) && !KEEP_CLAUDE_VARS.test(k)) delete env[k];
      else if (/^(CLAUDE_AGENT_SDK_|CLAUDE_PLUGIN_|CODEX_COMPANION_)/.test(k)) delete env[k];
    }
    if (/^https:\/\/api\.anthropic\.com\/?$/.test(env.ANTHROPIC_BASE_URL || "")) delete env.ANTHROPIC_BASE_URL;
  }
  return { ...env, ...extra };
}

// spawnSync with sane defaults; never throws, returns { ok, code, out, err }.
export function run(bin, args, opts = {}) {
  const r = spawnSync(bin, args, {
    encoding: "utf8",
    timeout: opts.timeout ?? 30000,
    maxBuffer: 64 * 1024 * 1024,
    input: opts.input,
    cwd: opts.cwd,
    env: opts.env || childEnv(),
  });
  return {
    ok: r.status === 0,
    code: r.status,
    out: r.stdout || "",
    err: r.stderr || (r.error ? r.error.message : ""),
  };
}

export function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

export function realPath(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

// realpath that also works for paths that no longer exist (resolves the
// nearest existing parent), so /var/x and /private/var/x compare equal on macOS.
const canonCache = new Map();
export function canon(p) {
  if (!p) return p;
  if (canonCache.has(p)) return canonCache.get(p);
  let out;
  try {
    out = fs.realpathSync(p);
  } catch {
    const parent = path.dirname(p);
    out = parent === p ? p : path.join(canon(parent), path.basename(p));
  }
  canonCache.set(p, out);
  return out;
}

export function isTrue(v) {
  return v === true || v === "true" || v === "1" || v === "yes" || v === "on";
}

export function fmtDuration(ms) {
  if (ms == null || Number.isNaN(ms)) return "-";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

export function clock(ts) {
  return new Date(ts).toISOString().slice(11, 19);
}

// "2026-10-29 17:43" in UTC; compact enough for tables.
export function stamp(ts) {
  if (!ts) return "-";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toISOString().slice(0, 16).replace("T", " ");
}

export function ago(ts, now = Date.now()) {
  if (!ts) return "-";
  const s = Math.max(0, Math.round((now - new Date(ts).getTime()) / 1000));
  if (s < 90) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function oneLine(s, n = 120) {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

// Keep the start and end of a long text; the middle is usually the least useful.
export function clip(s, n) {
  const t = String(s ?? "");
  if (!n || t.length <= n) return t;
  const head = Math.ceil(n * 0.6);
  const tail = n - head;
  return `${t.slice(0, head)}\n[… ${t.length - n} characters cut …]\n${t.slice(t.length - tail)}`;
}

export function stripAnsi(s) {
  return String(s ?? "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
}

export function toMs(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return v < 1e12 ? v * 1000 : v; // seconds or ms
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

// Glob with * and ?, case-insensitive, matched against the whole string.
export function globRe(pattern) {
  const src = String(pattern)
    .split("")
    .map((c) => (c === "*" ? ".*" : c === "?" ? "." : c.replace(/[.+^${}()|[\]\\]/g, "\\$&")))
    .join("");
  return new RegExp(`^${src}$`, "i");
}

export function matchesAny(value, patterns) {
  if (!value) return false;
  return (patterns || []).some((p) => globRe(p).test(value));
}

export function cmpVersion(a, b) {
  const x = String(a).split(".").map(Number);
  const y = String(b).split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d;
  }
  return 0;
}

// Minimal flag parser: --flag value, --flag=value, boolean flags, positionals.
// spec: { name: "bool" | "value" | "list" | "optional" }, aliases: { "-n": "lines" }
export function parseArgs(argv, spec, aliases = {}) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    if (aliases[a]) a = `--${aliases[a]}`;
    if (a === "--") {
      out._.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      let [key, val] = a.slice(2).split(/=(.*)/s, 2);
      const kind = spec[key];
      if (!kind) die(`unknown option --${key}`);
      if (kind === "bool") out[key] = true;
      else if (kind === "optional") out[key] = val ?? true;
      else {
        if (val === undefined) {
          val = argv[++i];
          if (val === undefined) die(`--${key} needs a value`);
        }
        if (kind === "list") (out[key] ||= []).push(val);
        else out[key] = val;
      }
    } else out._.push(a);
  }
  return out;
}

export function readStdin() {
  if (process.stdin.isTTY) return "";
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

// Read a text file that may be zstd-compressed (Codex archives old sessions as .jsonl.zst).
export function readText(file) {
  if (!file.endsWith(".zst")) return fs.readFileSync(file, "utf8");
  const buf = fs.readFileSync(file);
  if (typeof zlib.zstdDecompressSync === "function") return zlib.zstdDecompressSync(buf).toString("utf8");
  const r = spawnSync("zstd", ["-dc"], { input: buf, maxBuffer: 512 * 1024 * 1024 });
  if (r.status === 0) return r.stdout.toString("utf8");
  die(`cannot read ${file}: needs Node 22.15+ or the zstd command`);
}

// Read only the first `bytes` of a file (for cheap header scans of big transcripts).
export function readHead(file, bytes = 262144) {
  if (file.endsWith(".zst")) return readText(file).slice(0, bytes);
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

// Parse JSONL text; skips blank and malformed lines (a transcript being written
// right now can end in a half line).
export function parseJsonl(text) {
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {}
  }
  return out;
}

export function walk(dir, { match, maxDepth = 8 } = {}) {
  const out = [];
  const go = (d, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (depth < maxDepth) go(p, depth + 1);
      } else if (!match || match(p, e.name)) out.push(p);
    }
  };
  go(dir, 0);
  return out;
}

export function mtime(p) {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return null;
  }
}

export function table(rows, headers) {
  const all = [headers, ...rows].map((r) => r.map((c) => String(c ?? "")));
  const widths = headers.map((_, i) => Math.max(...all.map((r) => [...r[i]].length)));
  return all
    .map((r, ri) => {
      const line = r.map((c, i) => (i === r.length - 1 ? c : c + " ".repeat(widths[i] - [...c].length))).join("  ");
      return ri === 0 ? `${line}\n${widths.map((w) => "-".repeat(w)).join("  ")}` : line;
    })
    .join("\n");
}

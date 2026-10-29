// Claude Code (Anthropic). CLI: `claude`. The CLI and the Claude desktop app's
// Code tab both write transcripts to ~/.claude/projects/<encoded-cwd>/<id>.jsonl
// (the `entrypoint` field says which). The desktop app keeps its own titles in
// its application-support folder. Headless runs: `claude -p --output-format stream-json`.

import fs from "node:fs";
import path from "node:path";
import { home, which, run, readHead, readText, parseJsonl, walk, mtime, toMs, oneLine, die } from "../util.mjs";
import { policyFor } from "../config.mjs";
import { describeTool, desktopApp, textOf, userTextIsNoise, isUnder, titleFrom } from "./common.mjs";

const CLAUDE_HOME = () => process.env.CLAUDE_CONFIG_DIR || home(".claude");
const ALIASES = ["fable", "opus", "sonnet", "haiku", "opusplan", "default", "best"];

const SURFACES = { "claude-desktop": "desktop", cli: "cli", "sdk-cli": "headless", "sdk-ts": "sdk", "sdk-py": "sdk" };

function desktopSessionsDir() {
  if (process.env.SWITCHBOARD_CLAUDE_DESKTOP_DIR) return process.env.SWITCHBOARD_CLAUDE_DESKTOP_DIR;
  if (process.platform === "darwin") return home("Library", "Application Support", "Claude", "claude-code-sessions");
  if (process.platform === "win32") return path.join(process.env.APPDATA || home("AppData", "Roaming"), "Claude", "claude-code-sessions");
  return home(".config", "Claude", "claude-code-sessions");
}

// cliSessionId -> { title, archived } from the desktop app's own session list.
function desktopTitles() {
  const out = {};
  for (const f of walk(desktopSessionsDir(), { match: (_, n) => /^local_.*\.json$/.test(n), maxDepth: 3 })) {
    try {
      const d = JSON.parse(fs.readFileSync(f, "utf8"));
      if (d.cliSessionId) out[d.cliSessionId] = { title: d.title, archived: !!d.isArchived };
    } catch {}
  }
  return out;
}

function sessionFiles() {
  const root = path.join(CLAUDE_HOME(), "projects");
  const out = [];
  let dirs = [];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return out;
  }
  for (const d of dirs) {
    let files = [];
    try {
      files = fs.readdirSync(path.join(root, d.name)).filter((n) => n.endsWith(".jsonl"));
    } catch {}
    for (const n of files) out.push(path.join(root, d.name, n));
  }
  return out;
}

function userText(o) {
  const c = o.message?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.filter((b) => b?.type === "text").map((b) => b.text).join("\n");
  return "";
}

// A slash command the user typed shows up wrapped in tags; keep it readable.
function cleanUserText(t) {
  const name = /<command-name>([^<]*)<\/command-name>/.exec(t);
  if (name) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(t);
    return `${name[1].trim()}${args && args[1].trim() ? ` ${args[1].trim()}` : ""}`;
  }
  return userTextIsNoise(t) ? "" : t;
}

function listSessions() {
  const titles = desktopTitles();
  const out = [];
  for (const file of sessionFiles()) {
    const id = path.basename(file, ".jsonl");
    let head = "";
    let tail = "";
    try {
      head = readHead(file, 196608);
      const size = fs.statSync(file).size;
      if (size > 196608) {
        const fd = fs.openSync(file, "r");
        const n = Math.min(size, 131072);
        const b = Buffer.alloc(n);
        fs.readSync(fd, b, 0, n, size - n);
        fs.closeSync(fd);
        tail = b.toString("utf8");
      }
    } catch {
      continue;
    }
    let cwd = null, entry = null, createdAt = null, firstUser = "", model = null, title = null, aiTitle = null;
    for (const o of parseJsonl(head + "\n" + tail)) {
      if (!cwd && o.cwd) cwd = o.cwd;
      if (!entry && o.entrypoint) entry = o.entrypoint;
      if (!createdAt && o.timestamp) createdAt = toMs(o.timestamp);
      if (o.type === "custom-title" && o.customTitle) title = o.customTitle;
      if (o.type === "ai-title" && o.aiTitle) aiTitle = o.aiTitle;
      if (o.type === "assistant" && o.message?.model && o.message.model !== "<synthetic>") model = o.message.model;
      if (!firstUser && o.type === "user" && !o.isMeta && !o.isSidechain) firstUser = cleanUserText(userText(o));
    }
    if (!cwd && !firstUser) continue; // empty or metadata-only file
    const d = titles[id];
    out.push({
      agent: "claude",
      id,
      title: d?.title || title || aiTitle || titleFrom(firstUser) || "(untitled)",
      cwd,
      surface: SURFACES[entry] || entry || "unknown",
      createdAt,
      updatedAt: mtime(file),
      model,
      file,
      archived: !!d?.archived,
    });
  }
  return out;
}

function loadSession(meta) {
  const rows = parseJsonl(readText(meta.file));
  const events = [];
  const pending = new Map();
  let model = meta.model;
  let sidechain = 0;
  for (const o of rows) {
    const ts = toMs(o.timestamp);
    if (o.isSidechain) {
      sidechain++;
      continue;
    }
    if (o.type === "user") {
      if (o.isCompactSummary) {
        events.push({ ts, type: "note", text: `The conversation was compacted here. Summary given to the model:\n${userText(o)}` });
        continue;
      }
      const c = o.message?.content;
      if (Array.isArray(c)) {
        for (const b of c) {
          if (b?.type !== "tool_result") continue;
          const e = pending.get(b.tool_use_id);
          if (!e) continue;
          const out = typeof b.content === "string" ? b.content : textOf(b.content);
          e.tool.output = out;
          const code = /^Exit code (\d+)/.exec(out || "");
          if (code) e.tool.exitCode = Number(code[1]);
          else if (e.tool.kind === "shell") e.tool.exitCode = b.is_error ? "error" : 0;
          if (b.is_error) e.tool.status = "error";
        }
      }
      if (o.isMeta) continue;
      const t = cleanUserText(userText(o));
      if (t) events.push({ ts, type: "user", text: t });
    } else if (o.type === "assistant") {
      if (o.message?.model && o.message.model !== "<synthetic>") model = o.message.model;
      if (o.isApiErrorMessage || o.error) {
        events.push({ ts, type: "error", text: textOf(o.message?.content) || String(o.error) });
        continue;
      }
      for (const b of o.message?.content || []) {
        if (b?.type === "text" && b.text.trim()) events.push({ ts, type: "assistant", text: b.text });
        else if (b?.type === "thinking" && b.thinking?.trim()) events.push({ ts, type: "reasoning", text: b.thinking });
        else if (b?.type === "tool_use") {
          const e = { ts, type: "tool", tool: describeTool(b.name, b.input) };
          pending.set(b.id, e);
          events.push(e);
        }
      }
    } else if (o.type === "system" && (o.level === "error" || o.subtype === "api_error")) {
      events.push({ ts, type: "error", text: o.content || o.error || "system error" });
    }
  }
  const last = [...events].reverse().find((e) => e.type !== "note");
  const notes = sidechain ? [`${sidechain} sub-agent (sidechain) entries are not shown.`] : [];
  const ended = last?.type === "error" ? "error" : last?.type === "tool" && last.tool.output == null ? "interrupted (a tool call never returned)" : "unknown";
  return { ...meta, model, events, ended, limits: null, notes };
}

// "claude-sonnet-5-5" -> also matched as "sonnet-5-5" and "sonnet", so a policy
// can say "sonnet" or "opus*" without knowing the full id.
function matchNames(id) {
  const names = [id];
  const short = id.replace(/^claude-/, "");
  names.push(short);
  const fam = /^(fable|opus|sonnet|haiku)/.exec(short);
  if (fam) names.push(fam[1]);
  return [...new Set(names)];
}

export default {
  name: "claude",
  label: "Claude Code",
  prefix: "cl",
  installHint: "curl -fsSL https://claude.ai/install.sh | bash   (or: npm install -g @anthropic-ai/claude-code)",
  loginHint: "claude auth login",
  efforts: ["low", "medium", "high", "xhigh", "max"],
  supports: { resume: true, modes: ["write", "ask"], stdinPrompt: true },
  verifiesModel: true,

  bin() {
    return policyFor("claude").bin || process.env.SWITCHBOARD_CLAUDE_BIN || which("claude");
  },
  desktop() {
    return desktopApp(["Claude.app"], [home(".config", "Claude")]);
  },
  version() {
    const b = this.bin();
    if (!b) return null;
    const r = run(b, ["--version"], { timeout: 15000 });
    return r.ok ? r.out.trim().replace(/\s*\(Claude Code\)\s*$/, "") : null;
  },
  auth() {
    const b = this.bin();
    if (!b) return { ok: false, detail: "not installed" };
    if (process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN) return { ok: true, detail: "credentials in environment" };
    if (process.env.CLAUDE_CODE_USE_BEDROCK || process.env.CLAUDE_CODE_USE_VERTEX) return { ok: true, detail: "cloud provider credentials" };
    const r = run(b, ["auth", "status"], { timeout: 20000 });
    try {
      const s = JSON.parse(r.out);
      if (s.loggedIn) return { ok: true, detail: `logged in (${s.authMethod || "account"})` };
      const hint = this.desktop() ? " The desktop app signs in on its own; the CLI needs its own login." : "";
      return { ok: false, detail: `CLI not logged in.${hint}` };
    } catch {
      return { ok: null, detail: oneLine(r.out + r.err, 100) || "could not read `claude auth status`" };
    }
  },
  takeover: (id) => `claude --resume ${id}`,

  listModels: () => ALIASES.filter((a) => !["default", "best", "opusplan"].includes(a)),
  resolveModel(want, effort) {
    const w = want.replace(/:latest$/, ""); // Claude's family aliases already follow the newest release
    if (!ALIASES.includes(w) && !/^claude-/.test(w)) die(`"${want}" is not a Claude model; use an alias (${ALIASES.slice(0, 4).join(", ")}) or a full claude-* id`);
    return { id: w, effort };
  },
  matchNames,
  isLatestOf(pattern, id) {
    return !!id && matchNames(id).includes(pattern.replace(/:latest$/, ""));
  },

  buildRun(job, prompt) {
    const args = ["-p", "--output-format", "stream-json", "--verbose"];
    if (job.model) args.push("--model", job.model);
    if (job.effort) args.push("--effort", job.effort);
    // Write jobs run without permission prompts (headless mode has nobody to ask),
    // like Cursor's --force. Read-only jobs deny anything that would need approval.
    if (job.mode === "write") args.push("--dangerously-skip-permissions");
    else args.push("--permission-mode", "dontAsk", "--disallowedTools", "Edit,Write,NotebookEdit,MultiEdit");
    if (job.resumeSessionId) args.push("--resume", job.resumeSessionId);
    for (const d of job.addDirs || []) args.push("--add-dir", d);
    return { bin: job.agentBin, args, stdin: prompt };
  },

  parser(ctx) {
    return (ev) => {
      if (ev.type === "system") {
        if (ev.subtype === "init") ctx.init({ sessionId: ev.session_id, model: ev.model, cwd: ev.cwd });
        return;
      }
      if (ev.type === "assistant") {
        if (ev.error) ctx.error(`${ev.error}: ${textOf(ev.message?.content)}`);
        for (const b of ev.message?.content || []) {
          if (b.type === "text") ctx.say(b.text);
          else if (b.type === "thinking" && b.thinking) ctx.log(`think  ${oneLine(b.thinking, 120)}`);
          else if (b.type === "tool_use") {
            const t = describeTool(b.name, b.input);
            const text = `${t.kind === "other" || t.kind === "mcp" ? b.name : t.kind}`.padEnd(6) + ` ${t.kind === "edit" || t.kind === "read" ? (t.paths || []).map(ctx.rel).join(", ") : t.summary}`;
            ctx.toolStart(b.id, { kind: t.kind === "edit" ? "edit" : t.kind, text, command: t.command, path: t.kind === "edit" ? t.paths?.[0] : null });
          }
        }
        return;
      }
      if (ev.type === "user") {
        for (const b of ev.message?.content || []) {
          if (b?.type !== "tool_result") continue;
          const out = typeof b.content === "string" ? b.content : textOf(b.content);
          const code = /^Exit code (\d+)/.exec(out || "");
          ctx.toolEnd(b.tool_use_id, b.is_error && !code ? { error: oneLine(out, 200) } : { exitCode: code ? Number(code[1]) : 0 });
        }
        return;
      }
      if (ev.type === "result") {
        ctx.final({ isError: !!ev.is_error || ev.subtype !== "success", result: ev.result, usage: ev.usage && { input: ev.usage.input_tokens, output: ev.usage.output_tokens, cacheRead: ev.usage.cache_read_input_tokens }, costUsd: ev.total_cost_usd, durationMs: ev.duration_ms });
      }
    };
  },

  sessions: {
    stores() {
      return [{ label: "Claude Code transcripts (CLI and desktop app)", path: path.join(CLAUDE_HOME(), "projects"), count: sessionFiles().length }];
    },
    list: listSessions,
    load: loadSession,
    inCwd: (s, dir) => isUnder(s.cwd, dir),
  },
};

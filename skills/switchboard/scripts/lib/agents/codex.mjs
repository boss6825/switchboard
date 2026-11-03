// Codex (OpenAI). CLI: `codex`. The desktop app, the IDE extension and the CLI
// all keep their threads in $CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl
// (archived ones under archived_sessions/, zstd-compressed), with thread names
// in session_index.jsonl. Headless runs: `codex exec --json`.

import fs from "node:fs";
import path from "node:path";
import {
  home, which, run, readJSON, readHead, readText, parseJsonl, walk, mtime, toMs, cmpVersion,
  globRe, oneLine, stripAnsi, die,
} from "../util.mjs";
import { policyFor } from "../config.mjs";
import { describeTool, desktopApp, textOf, userTextIsNoise, isUnder, patchPaths, titleFrom } from "./common.mjs";

const CODEX_HOME = () => process.env.CODEX_HOME || home(".codex");

const SURFACES = {
  "Codex Desktop": "desktop",
  codex_cli_rs: "cli",
  codex_exec: "exec",
  codex_vscode: "ide",
};

function modelsCache() {
  const c = readJSON(path.join(CODEX_HOME(), "models_cache.json"), null);
  const list = (c?.models || []).filter((m) => m.slug && !(m.visibility === "hide"));
  return list.map((m) => ({ id: m.slug, efforts: (m.supported_reasoning_levels || []).map((l) => l.effort).filter(Boolean), def: m.default_reasoning_level }));
}

const versionOf = (id) => (/(\d+(?:\.\d+)*)/.exec(id) || [])[1] || "0";

// "luna:latest" -> newest gpt-*-luna; "gpt-*-sol:latest" -> newest match of the glob.
function newestMatching(alias, models) {
  const key = alias.replace(/:latest$/, "");
  const re = key.includes("*") ? globRe(key) : new RegExp(`(^|-)${key.replace(/[.+^${}()|[\]\\]/g, "\\$&")}($|-)`, "i");
  const hits = models.filter((m) => re.test(m.id));
  hits.sort((a, b) => cmpVersion(versionOf(b.id), versionOf(a.id)));
  return hits[0] || null;
}

// The Codex desktop app sends the model a composed message: pasted-file
// headers, ambient browser state, annotations, then "## My request:". Keep the
// request and a short note of what was attached.
export function cleanUserText(t) {
  let s = String(t || "");
  s = s.replace(/<in-app-browser-context[\s\S]*?<\/in-app-browser-context>\s*/g, "");
  s = s.replace(/<response-annotations>[\s\S]*?<\/response-annotations>\s*/g, "(with annotations on an earlier reply)\n");
  const req = s.lastIndexOf("## My request:");
  if (req >= 0) {
    const files = [...s.slice(0, req).matchAll(/^## "(.+?)":/gm)].map((m) => oneLine(m[1], 60));
    const ann = /\(with annotations on an earlier reply\)/.test(s.slice(0, req)) ? " (with annotations on an earlier reply)" : "";
    s = `${files.length ? `[pasted: ${files.join("; ")}]${ann}\n` : ann ? `${ann.trim()}\n` : ""}${s.slice(req + "## My request:".length).trim()}`;
  }
  return s.trim();
}

function firstUserText(events) {
  return events.find((e) => e.type === "user")?.text || "";
}

// --------------------------------------------------------------- sessions

function threadNames() {
  const names = {};
  try {
    for (const o of parseJsonl(fs.readFileSync(path.join(CODEX_HOME(), "session_index.jsonl"), "utf8"))) {
      if (o.id && o.thread_name) names[o.id] = o.thread_name;
    }
  } catch {}
  return names;
}

function sessionFiles({ archived = true } = {}) {
  const live = walk(path.join(CODEX_HOME(), "sessions"), { match: (_, n) => /^rollout-.*\.jsonl$/.test(n) });
  const old = archived ? walk(path.join(CODEX_HOME(), "archived_sessions"), { match: (_, n) => /^rollout-.*\.jsonl(\.zst)?$/.test(n), maxDepth: 3 }) : [];
  return [...live.map((f) => ({ file: f, archived: false })), ...old.map((f) => ({ file: f, archived: true }))];
}

function metaFromHead(text) {
  const out = { firstUser: "" };
  for (const o of parseJsonl(text)) {
    const p = o.payload || {};
    if (o.type === "session_meta" && !out.id) {
      out.id = p.id || p.session_id;
      out.createdAt = toMs(p.timestamp || o.timestamp);
      out.cwd = p.cwd;
      out.originator = p.originator;
      out.subagent = typeof p.source === "object" && p.source !== null;
      out.cliVersion = p.cli_version;
    } else if (o.type === "turn_context" && p.model && !out.model) out.model = p.model;
    else if (!out.firstUser) {
      if (o.type === "event_msg" && p.type === "item_completed" && p.item?.type === "UserMessage") out.firstUser = cleanUserText(textOf(p.item.content));
      else if (o.type === "event_msg" && p.type === "user_message") out.firstUser = p.message || "";
      else if (o.type === "response_item" && p.type === "message" && p.role === "user") {
        const t = textOf(p.content);
        if (!userTextIsNoise(t)) out.firstUser = t;
      }
    }
  }
  return out;
}

function listSessions({ includeSubagents = false } = {}) {
  const names = threadNames();
  const out = [];
  for (const { file, archived } of sessionFiles()) {
    let head;
    try {
      head = readHead(file, 196608);
    } catch {
      continue;
    }
    const m = metaFromHead(head);
    if (!m.id) m.id = (/([0-9a-f]{8}-[0-9a-f-]{27,})\.jsonl/.exec(file) || [])[1];
    if (!m.id || (m.subagent && !includeSubagents)) continue;
    out.push({
      agent: "codex",
      id: m.id,
      title: names[m.id] || titleFrom(m.firstUser) || "(untitled)",
      cwd: m.cwd || null,
      surface: m.subagent ? "subagent" : SURFACES[m.originator] || m.originator || "unknown",
      createdAt: m.createdAt,
      updatedAt: mtime(file),
      model: m.model || null,
      file,
      archived,
    });
  }
  return out;
}

function loadSession(meta) {
  const rows = parseJsonl(readText(meta.file));
  const usesItems = rows.some((o) => o.type === "event_msg" && o.payload?.type === "item_completed");
  const events = [];
  const pendingCalls = new Map();
  let ended = "unknown";
  let limits = null;
  let model = meta.model;
  const notes = [];

  const push = (e) => events.push(e);
  for (const o of rows) {
    const p = o.payload || {};
    const ts = toMs(o.timestamp) || (p.completed_at_ms ?? null);
    if (o.type === "turn_context" && p.model) model = p.model;
    if (o.type === "compacted") push({ ts, type: "note", text: "The conversation was compacted here; earlier turns were summarised for the model." });
    if (o.type !== "event_msg" && o.type !== "response_item") continue;

    if (o.type === "event_msg") {
      if (p.type === "task_started") ended = "running";
      else if (p.type === "task_complete") ended = "completed";
      else if (p.type === "turn_aborted") {
        ended = `aborted (${p.reason || "unknown reason"})`;
        push({ ts, type: "note", text: `Turn aborted: ${p.reason || "unknown reason"}` });
      } else if (p.type === "error" || p.type === "stream_error") push({ ts, type: "error", text: p.message || JSON.stringify(p) });
      else if (p.type === "token_count" && p.rate_limits) limits = p.rate_limits;
      else if (p.type === "thread_goal_updated" && p.goal) push({ ts, type: "note", text: `Goal set: ${typeof p.goal === "string" ? p.goal : JSON.stringify(p.goal)}` });
    }

    if (usesItems) {
      if (!(o.type === "event_msg" && p.type === "item_completed")) continue;
      const it = p.item || {};
      const its = p.completed_at_ms || ts;
      switch (it.type) {
        case "UserMessage": {
          const t = cleanUserText(textOf(it.content));
          if (!userTextIsNoise(t)) push({ ts: its, type: "user", text: t });
          break;
        }
        case "AgentMessage":
          push({ ts: its, type: "assistant", text: textOf(it.content) });
          break;
        case "Reasoning": {
          const t = [...(it.summary_text || []), ...(it.raw_content || [])].map((x) => (typeof x === "string" ? x : x?.text || "")).join("\n").trim();
          if (t) push({ ts: its, type: "reasoning", text: t });
          break;
        }
        case "CommandExecution": {
          const cmd = Array.isArray(it.command) ? it.command.join(" ") : it.command;
          const parsed = (it.parsed_cmd || []).map((c) => c.cmd).filter(Boolean).join(" && ");
          const command = parsed || cmd;
          push({ ts: its, type: "tool", tool: { kind: "shell", name: "shell", command, summary: oneLine(command, 200), paths: [], output: it.aggregated_output, exitCode: it.exit_code, status: it.status } });
          break;
        }
        case "FileChange": {
          const paths = Object.keys(it.changes || {});
          const kinds = Object.values(it.changes || {}).map((c) => c?.type).filter(Boolean);
          push({ ts: its, type: "tool", tool: { kind: "edit", name: "apply_patch", paths, summary: paths.join(", "), status: it.status, changeKinds: kinds, output: it.stderr || "" } });
          break;
        }
        case "McpToolCall": {
          const out = (it.result?.content || []).map((c) => c.text || "").join("\n");
          push({ ts: its, type: "tool", tool: { kind: "mcp", name: `${it.server}.${it.tool}`, summary: `${it.server}.${it.tool} ${oneLine(JSON.stringify(it.arguments || {}), 120)}`, paths: [], output: out, status: it.status } });
          break;
        }
        case "WebSearch":
        case "WebSearchCall": {
          const q = it.query || it.action?.query || "";
          push({ ts: its, type: "tool", tool: { kind: "web", name: "web_search", summary: q, paths: [], status: it.status } });
          break;
        }
        case "Extension": {
          // Built-in extensions: web.search (query + opened url), image_gen.generation, ...
          if (/search|web/.test(it.kind || "")) {
            const what = [it.query, it.action?.url].filter(Boolean).join(" → ");
            push({ ts: its, type: "tool", tool: { kind: "web", name: it.kind, summary: what || it.kind, paths: [], status: it.status } });
          } else push({ ts: its, type: "tool", tool: { kind: "other", name: it.kind || "extension", summary: `${it.kind || "extension"}${it.savedPath ? ` → ${it.savedPath}` : ""}${it.revisedPrompt ? `: ${oneLine(it.revisedPrompt, 120)}` : ""}`, paths: [] } });
          break;
        }
        case "ImageView":
          push({ ts: its, type: "tool", tool: { kind: "read", name: "view_image", summary: it.path, paths: [it.path].filter(Boolean) } });
          break;
        case "SubAgentActivity":
        case "CollabAgentToolCall":
          push({ ts: its, type: "tool", tool: { kind: "agent", name: it.type, summary: [it.kind, it.model, it.tool].filter(Boolean).join(" "), paths: [] } });
          break;
        case "ContextCompaction":
          push({ ts: its, type: "note", text: "Context was compacted here." });
          break;
        case "Error":
          push({ ts: its, type: "error", text: it.message || JSON.stringify(it) });
          break;
        default:
          if (it.type) push({ ts: its, type: "tool", tool: { kind: "other", name: it.type, summary: it.type, paths: [] } });
      }
      continue;
    }

    // Older rollouts (before item_completed events): read the model-facing items.
    if (o.type === "response_item") {
      if (p.type === "message") {
        const t = textOf(p.content);
        if (p.role === "user" && !userTextIsNoise(t)) push({ ts, type: "user", text: cleanUserText(t) });
        else if (p.role === "assistant" && t) push({ ts, type: "assistant", text: t });
      } else if (p.type === "reasoning") {
        const t = (p.summary || []).map((s) => s.text || "").join("\n").trim();
        if (t) push({ ts, type: "reasoning", text: t });
      } else if (p.type === "function_call" || p.type === "custom_tool_call" || p.type === "local_shell_call") {
        let input = p.arguments ?? p.input ?? p.action;
        if (typeof input === "string") {
          try {
            input = JSON.parse(input);
          } catch {}
        }
        const name = p.name || (p.type === "local_shell_call" ? "shell" : "tool");
        const tool = describeTool(name === "exec_command" ? "shell" : name, input);
        if (name === "apply_patch" && typeof input === "string") tool.paths = patchPaths(input);
        const e = { ts, type: "tool", tool };
        pendingCalls.set(p.call_id, e);
        push(e);
      } else if (p.type === "function_call_output" || p.type === "custom_tool_call_output") {
        const e = pendingCalls.get(p.call_id);
        if (e) {
          const out = typeof p.output === "string" ? p.output : textOf(p.output) || JSON.stringify(p.output);
          e.tool.output = out;
          const code = /exit code:?\s*(\d+)/i.exec(out || "") || /"exit_code":\s*(\d+)/.exec(out || "");
          if (code) e.tool.exitCode = Number(code[1]);
        }
      } else if (p.type === "web_search_call") {
        push({ ts, type: "tool", tool: { kind: "web", name: "web_search", summary: p.action?.query || "", paths: [] } });
      }
    }
  }
  if (ended === "running") ended = "interrupted (the last turn never finished)";
  if (limits?.rate_limit_reached_type) notes.push(`Codex reported its usage limit was reached (${limits.rate_limit_reached_type}).`);
  return { ...meta, model, events, ended, limits: formatLimits(limits), notes, title: meta.title === "(untitled)" ? oneLine(firstUserText(events), 80) : meta.title };
}

function formatLimits(l) {
  if (!l) return null;
  const w = (x, label) => {
    if (!x || x.used_percent == null) return null;
    const reset = x.resets_at ? new Date(x.resets_at * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "?";
    return `${label}: ${x.used_percent}% used (resets ${reset})`;
  };
  const hours = (m) => (m ? (m % 1440 === 0 ? `${m / 1440}-day` : `${Math.round(m / 60)}-hour`) : "");
  return [w(l.primary, `${hours(l.primary?.window_minutes)} window`), w(l.secondary, `${hours(l.secondary?.window_minutes)} window`)].filter(Boolean).join("; ") || null;
}

// ------------------------------------------------------------------ adapter

export default {
  name: "codex",
  label: "Codex",
  prefix: "cx",
  installHint: "npm install -g @openai/codex   (or: brew install codex)",
  loginHint: "codex login",
  efforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
  supports: { resume: true, modes: ["write", "ask"], stdinPrompt: true },
  verifiesModel: false,

  bin() {
    return policyFor("codex").bin || process.env.SWITCHBOARD_CODEX_BIN || which("codex");
  },
  desktop() {
    const app = desktopApp(["Codex.app"]);
    if (app) return app;
    // Newer releases ship the Codex desktop app inside ChatGPT.app (bundle id com.openai.codex).
    const chatgpt = desktopApp(["ChatGPT.app"]);
    return chatgpt && fs.existsSync(path.join(chatgpt, "Contents", "Resources", "codex-cli")) ? chatgpt : null;
  },
  version() {
    const b = this.bin();
    if (!b) return null;
    const r = run(b, ["--version"], { timeout: 15000 });
    return r.ok ? r.out.trim().replace(/^codex-cli\s*/, "") : null;
  },
  auth() {
    const b = this.bin();
    if (!b) return { ok: false, detail: "not installed" };
    if (process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY) return { ok: true, detail: "API key in environment" };
    const r = run(b, ["login", "status"], { timeout: 20000 });
    const text = stripAnsi(r.out + r.err).trim();
    const ok = r.ok && /logged in/i.test(text) && !/not logged in/i.test(text);
    return { ok, detail: text.split("\n").find((l) => /logged|login|key/i.test(l)) || text.split("\n")[0] || "unknown" };
  },
  takeover: (id) => `codex resume ${id}`,

  listModels() {
    return modelsCache().map((m) => m.id);
  },
  // The top-level `model = "..."` in config.toml (before any [section]).
  defaultModel() {
    let text = "";
    try {
      text = fs.readFileSync(path.join(CODEX_HOME(), "config.toml"), "utf8");
    } catch {
      return null;
    }
    const top = text.split(/^\s*\[/m)[0];
    return (/^\s*model\s*=\s*"([^"]+)"/m.exec(top) || [])[1] || null;
  },
  resolveModel(want, effort, { notes }) {
    const models = modelsCache();
    let m;
    if (/:latest$/.test(want)) {
      m = newestMatching(want, models);
      if (!m) die(`no Codex model matches "${want}" (known: ${models.map((x) => x.id).join(", ") || "none cached yet; run codex once"})`);
      notes.push(`${want} resolves to ${m.id} today.`);
    } else {
      m = models.find((x) => x.id === want);
      if (!m && models.length) notes.push(`"${want}" is not in Codex's cached model list; passing it through as is.`);
    }
    if (effort && m?.efforts?.length && !m.efforts.includes(effort)) die(`Codex model ${m.id} does not offer effort "${effort}"; it offers: ${m.efforts.join(", ")}`);
    return { id: m?.id || want, effort };
  },
  matchNames: (id) => [id],
  isLatestOf(pattern, id) {
    return newestMatching(pattern, modelsCache())?.id === id;
  },

  buildRun(job, prompt) {
    const args = [];
    if (job.resumeSessionId) args.push("exec", "resume", "--json", "--skip-git-repo-check");
    else args.push("exec", "--json", "--skip-git-repo-check", "-C", job.cwd);
    // Codex's own OS sandbox: workspace-write lets it edit the workspace and run
    // commands (network off by default); read-only blocks all writes.
    args.push("-c", `sandbox_mode="${job.mode === "write" ? "workspace-write" : "read-only"}"`);
    if (job.mode === "write") args.push("-c", "sandbox_workspace_write.network_access=false"); // pinned, whatever config.toml says
    if (job.model) args.push("-m", job.model);
    if (job.effort) args.push("-c", `model_reasoning_effort="${job.effort}"`);
    if (!job.resumeSessionId) for (const d of job.addDirs || []) args.push("--add-dir", d);
    if (job.resumeSessionId) args.push(job.resumeSessionId);
    args.push("-"); // prompt on stdin: no argument-length limit, nothing for the shell to expand
    return { bin: job.agentBin, args, stdin: prompt };
  },

  // `codex exec --json` never names the model; Codex's own session file does.
  afterRun(state) {
    if (!state.sessionId || state.modelName) return;
    // Codex files sessions under the local date.
    const day = (t) => {
      const d = new Date(t);
      return path.join(CODEX_HOME(), "sessions", String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0"));
    };
    for (const dir of new Set([day(state.startedAt), day(Date.now())])) {
      let names = [];
      try {
        names = fs.readdirSync(dir).filter((n) => n.includes(state.sessionId));
      } catch {}
      for (const n of names) {
        const rows = parseJsonl(readHead(path.join(dir, n), 262144)).filter((o) => o.type === "turn_context" && o.payload?.model);
        const last = rows[rows.length - 1];
        if (last) {
          state.modelName = last.payload.model + (last.payload.effort ? ` (${last.payload.effort})` : "");
          return;
        }
      }
    }
  },

  parser(ctx) {
    return (ev) => {
      const it = ev.item || {};
      switch (ev.type) {
        case "thread.started":
          ctx.init({ sessionId: ev.thread_id });
          break;
        case "item.started":
          if (it.type === "command_execution") ctx.toolStart(it.id, { kind: "shell", text: `shell  ${oneLine(it.command, 160)}`, command: it.command });
          else if (it.type === "mcp_tool_call") ctx.toolStart(it.id, { kind: "mcp", text: `mcp    ${it.server}.${it.tool}` });
          else if (it.type === "web_search") ctx.toolStart(it.id, { kind: "web", text: `web    ${oneLine(it.query, 120)}` });
          break;
        case "item.completed":
          if (it.type === "agent_message") ctx.say(it.text);
          else if (it.type === "reasoning") ctx.log(`think  ${oneLine(it.text, 120)}`);
          else if (it.type === "command_execution") ctx.toolEnd(it.id, { exitCode: it.exit_code, command: it.command }, { kind: "shell", text: "shell", command: it.command });
          else if (it.type === "file_change") {
            const files = (it.changes || []).map((c) => ({ path: c.path, kind: c.kind === "add" ? "add" : c.kind === "delete" ? "delete" : "update" }));
            ctx.toolStart(it.id, { kind: "edit", text: `edit   ${files.map((f) => ctx.rel(f.path)).join(", ")}` });
            ctx.toolEnd(it.id, { files });
          } else if (it.type === "mcp_tool_call") ctx.toolEnd(it.id, it.error ? { error: it.error.message || "failed" } : {}, { kind: "mcp", text: "mcp" });
          else if (it.type === "web_search") ctx.toolEnd(it.id, {}, { kind: "web", text: "web" });
          else if (it.type === "error") ctx.error(it.message);
          else if (it.type === "todo_list") ctx.log(`plan   ${(it.items || []).map((x) => `${x.completed ? "[x]" : "[ ]"} ${x.text}`).join(" ")}`);
          break;
        case "turn.completed":
          ctx.final({ isError: false, usage: ev.usage });
          break;
        case "turn.failed":
          ctx.final({ isError: true, result: ev.error?.message || "turn failed" });
          break;
        case "error":
          ctx.error(ev.message || JSON.stringify(ev));
          break;
        default:
          break;
      }
    };
  },

  sessions: {
    stores() {
      const files = sessionFiles();
      return [{ label: "Codex threads (CLI, desktop app, IDE)", path: path.join(CODEX_HOME(), "sessions"), count: files.filter((f) => !f.archived).length, archived: files.filter((f) => f.archived).length }];
    },
    list: listSessions,
    load: loadSession,
    // Codex already imports Claude Code and Cursor chats itself; nothing to do here.
    inCwd: (s, dir) => isUnder(s.cwd, dir),
  },
};

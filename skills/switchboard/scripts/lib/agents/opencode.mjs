// OpenCode (sst/anomalyco). CLI: `opencode`. Sessions live in a SQLite
// database (~/.local/share/opencode/opencode.db; older releases used JSON files
// under storage/). The CLI, TUI and desktop app share it. Session content is
// read through `opencode export` when the CLI is present, because the database
// schema has changed between releases; the database is the fallback.
// Headless runs: `opencode run --format json`.
//
// Built from OpenCode's documentation and source; see README "Tested with".

import fs from "node:fs";
import path from "node:path";
import { home, which, run, readJSON, writeJSON, walk, toMs, cmpVersion, globRe, oneLine, stripAnsi, die, exists } from "../util.mjs";
import { SB_HOME, policyFor } from "../config.mjs";
import { query, tables } from "../sqlite.mjs";
import { describeTool, desktopApp, isUnder } from "./common.mjs";

const DATA = () => process.env.SWITCHBOARD_OPENCODE_DATA || path.join(process.env.XDG_DATA_HOME || home(".local", "share"), "opencode");
const DB = () => process.env.OPENCODE_DB || path.join(DATA(), "opencode.db");
const MODELS_CACHE = () => path.join(SB_HOME, "opencode-models.json");

function fetchModels({ refresh = false } = {}) {
  const cache = readJSON(MODELS_CACHE(), null);
  if (!refresh && cache?.ids?.length && Date.now() - cache.at < 6 * 3600 * 1000) return cache.ids;
  const bin = adapter.bin();
  if (!bin) return cache?.ids || [];
  const r = run(bin, ["models"], { timeout: 60000 });
  if (!r.ok) return cache?.ids || [];
  const ids = stripAnsi(r.out).split("\n").map((l) => l.trim()).filter((l) => /^[\w.-]+\/\S+$/.test(l));
  writeJSON(MODELS_CACHE(), { at: Date.now(), ids });
  return ids;
}

const versionOf = (id) => (/(\d+(?:\.\d+)*)/.exec(id.split("/").pop()) || [])[1] || "0";

function newestMatching(alias, ids) {
  const re = globRe(alias.replace(/:latest$/, ""));
  return ids.filter((id) => re.test(id)).sort((a, b) => cmpVersion(versionOf(b), versionOf(a)))[0] || null;
}

// ----------------------------------------------------------------- sessions

async function listFromDb() {
  const db = DB();
  if (!exists(db)) return null;
  const t = await tables(db);
  const table = t.has("session_v2") ? "session_v2" : t.has("session") ? "session" : null;
  if (!table) return null;
  const rows = await query(db, `select id, directory, title, time_created, time_updated from ${table} where parent_id is null order by time_updated desc`);
  return rows.map((r) => ({ id: r.id, cwd: r.directory, title: r.title, createdAt: toMs(r.time_created), updatedAt: toMs(r.time_updated) }));
}

function listFromCli() {
  const bin = adapter.bin();
  if (!bin) return null;
  const r = run(bin, ["session", "list", "--format", "json"], { timeout: 60000 });
  if (!r.ok) return null;
  try {
    const list = JSON.parse(r.out);
    return list.map((s) => ({ id: s.id, cwd: s.directory, title: s.title, createdAt: toMs(s.time?.created ?? s.created), updatedAt: toMs(s.time?.updated ?? s.updated) }));
  } catch {
    return null;
  }
}

function listFromFiles() {
  const dir = path.join(DATA(), "storage", "session");
  if (!exists(dir)) return null;
  return walk(dir, { match: (_, n) => n.endsWith(".json"), maxDepth: 2 })
    .map((f) => readJSON(f, null))
    .filter((s) => s?.id && !s.parentID)
    .map((s) => ({ id: s.id, cwd: s.directory, title: s.title, createdAt: toMs(s.time?.created), updatedAt: toMs(s.time?.updated) }));
}

async function listSessions() {
  let rows = null;
  try {
    rows = await listFromDb();
  } catch {}
  rows ||= listFromCli() || listFromFiles() || [];
  return rows.map((r) => ({ agent: "opencode", surface: "opencode", model: null, file: null, ...r, title: r.title || "(untitled)" }));
}

// One message in OpenCode's export shape: { info: { role, ... }, parts: [...] }.
function eventsFromMessage(msg, out) {
  const info = msg.info || msg;
  const ts = toMs(info.time?.created);
  const role = info.role;
  for (const p of msg.parts || []) {
    if (p.type === "text") {
      if (p.synthetic || !p.text?.trim()) continue;
      out.push({ ts, type: role === "user" ? "user" : "assistant", text: p.text });
    } else if (p.type === "reasoning" && p.text?.trim()) out.push({ ts, type: "reasoning", text: p.text });
    else if (p.type === "tool") {
      const st = p.state || {};
      const tool = describeTool(p.tool === "bash" ? "shell" : p.tool, st.input || {});
      tool.name = p.tool;
      tool.status = st.status;
      if (st.output != null) tool.output = typeof st.output === "string" ? st.output : JSON.stringify(st.output);
      if (st.error) tool.error = st.error;
      const exit = st.metadata?.exit ?? st.metadata?.exitCode;
      if (exit != null) tool.exitCode = exit;
      out.push({ ts, type: "tool", tool });
    } else if (p.type === "patch" && p.files?.length) out.push({ ts, type: "tool", tool: { kind: "edit", name: "patch", paths: p.files, summary: p.files.join(", ") } });
    else if (p.type === "subtask" || p.type === "agent") out.push({ ts, type: "tool", tool: { kind: "agent", name: p.type, summary: p.description || p.name || p.prompt || p.type, paths: [] } });
  }
  if (info.error) out.push({ ts, type: "error", text: info.error.data?.message || info.error.name || JSON.stringify(info.error) });
}

async function loadSession(meta, { preferDb = false } = {}) {
  const events = [];
  const notes = [];
  const bin = adapter.bin();
  let loaded = false;
  if (bin && !(preferDb && exists(DB()))) {
    const r = run(bin, ["export", meta.id], { timeout: 120000 });
    const start = r.out.indexOf("{");
    if (r.ok && start >= 0) {
      try {
        const data = JSON.parse(r.out.slice(start));
        for (const m of data.messages || []) eventsFromMessage(m, events);
        loaded = true;
      } catch {}
    }
  }
  if (!loaded && exists(DB())) {
    const t = await tables(DB());
    if (t.has("message") && t.has("part") && !t.has("session_message")) {
      const msgs = await query(DB(), "select id, data from message where session_id = ? order by time_created, id", [meta.id]);
      const parts = await query(DB(), "select message_id, data from part where session_id = ? order by time_created, id", [meta.id]);
      const byMsg = {};
      for (const p of parts) (byMsg[p.message_id] ||= []).push(JSON.parse(p.data));
      for (const m of msgs) eventsFromMessage({ info: JSON.parse(m.data), parts: byMsg[m.id] || [] }, events);
      loaded = true;
    } else if (t.has("session_message")) {
      // Newer schema (OpenCode 2.x): one row per message, parts inside `data`.
      // Row types: user (data.text), assistant (data.content[]: text, reasoning, tool),
      // synthetic (plan-mode reminders), agent-switched and idle (bookkeeping).
      const rows = await query(DB(), "select type, data from session_message where session_id = ? order by seq", [meta.id]);
      for (const r of rows) {
        let d = {};
        try {
          d = JSON.parse(r.data);
        } catch {}
        const ts = toMs(d.time?.created);
        if (r.type === "user") {
          // `opencode run` wraps a multi-word message in literal quotes; drop them.
          let text = String(d.text ?? "");
          if (text.length > 1 && text.startsWith('"') && text.endsWith('"')) text = text.slice(1, -1).replace(/\\"/g, '"');
          if (text.trim()) events.push({ ts, type: "user", text });
        } else if (r.type === "assistant") {
          if (d.model?.id && !meta.model) meta.model = d.model.id;
          for (const c of d.content || []) {
            if (c.type === "text" && c.text?.trim()) events.push({ ts, type: "assistant", text: c.text });
            else if (c.type === "reasoning" && c.text?.trim()) events.push({ ts, type: "reasoning", text: c.text });
            else if (c.type === "tool") {
              const st = c.state || {};
              const tool = describeTool(c.name === "bash" ? "shell" : c.name, st.input || {});
              tool.name = c.name;
              tool.status = st.status;
              const out = (st.content || []).map((x) => x.text).filter(Boolean).join("\n");
              if (out) tool.output = out;
              if (st.error) tool.error = typeof st.error === "string" ? st.error : JSON.stringify(st.error);
              events.push({ ts, type: "tool", tool });
            }
          }
          if (d.error) events.push({ ts, type: "error", text: d.error.message || d.error.type || JSON.stringify(d.error) });
        } else if (r.type === "idle" && d.outcome && d.outcome !== "succeeded") events.push({ ts, type: "error", text: `session ended: ${d.outcome}` });
      }
      loaded = true;
    }
  }
  if (!loaded) notes.push("Could not read this session: the opencode CLI is not on PATH and the database was not readable.");
  return { ...meta, events, ended: "unknown", limits: null, notes };
}

// ------------------------------------------------------------------ adapter

const adapter = {
  name: "opencode",
  label: "OpenCode",
  prefix: "oc",
  installHint: "curl -fsSL https://opencode.ai/install | bash   (or: npm install -g opencode-ai)",
  loginHint: "opencode auth login",
  efforts: null, // "variants" are provider-specific (high, max, minimal, ...)
  supports: { resume: true, modes: ["write", "ask"], stdinPrompt: false },
  verifiesModel: false,
  successOnCleanExit: true, // `run --format json` has no final "result" event

  bin() {
    return policyFor("opencode").bin || process.env.SWITCHBOARD_OPENCODE_BIN || which("opencode");
  },
  desktop() {
    return desktopApp(["OpenCode.app", "opencode.app"]);
  },
  version() {
    const b = this.bin();
    if (!b) return null;
    const r = run(b, ["--version"], { timeout: 15000 });
    return r.ok ? r.out.trim().replace(/^opencode\s+v?/i, "") : null; // 2.x prints "opencode v2.2.1"
  },
  auth() {
    const b = this.bin();
    if (!b) return { ok: false, detail: "not installed" };
    const r = run(b, ["auth", "list"], { timeout: 20000 });
    const text = stripAnsi(r.out + r.err);
    // 1.x lists "● Provider api"; 2.x prints "Provider  Label  stored|environment".
    const n = (text.match(/^\s*[●•*-]\s+\S/gm) || []).length || (text.match(/\s(stored|environment)\s*$/gm) || []).length;
    if (r.ok && n) return { ok: true, detail: `${n} provider credential(s)` };
    return { ok: null, detail: "no provider credentials found; OpenCode's free models may still work (check: opencode models)" };
  },
  takeover: (id) => `opencode --session ${id}`,

  listModels: ({ refresh = false } = {}) => fetchModels({ refresh }),
  resolveModel(want, effort, { notes }) {
    const ids = fetchModels();
    if (/:latest$/.test(want)) {
      const id = newestMatching(want, ids);
      if (!id) die(`no OpenCode model matches "${want}" (see: switchboard models opencode)`);
      notes.push(`${want} resolves to ${id} today.`);
      return { id, effort };
    }
    if (!want.includes("/")) die(`OpenCode models are named provider/model (e.g. opencode/some-model); got "${want}"`);
    if (ids.length && !ids.includes(want)) die(`"${want}" is not in \`opencode models\` (see: switchboard models opencode ${want.split("/")[0]})`);
    return { id: want, effort };
  },
  // Full provider/model only: "claude-sonnet-5-5" must not also allow some-other-provider/claude-sonnet-5-5.
  matchNames: (id) => [id],
  isLatestOf(pattern, id) {
    return newestMatching(pattern, fetchModels()) === id;
  },

  buildRun(job, prompt) {
    // 2.x dropped --dir and --variant: the folder is the working directory, the
    // variant rides on the model ("provider/model#low"), and --standalone keeps
    // the job off the shared background service so cancel stops all of it.
    const v2 = Number((this.version() || "0").split(".")[0]) >= 2;
    const args = ["run", "--format", "json", ...(v2 ? ["--standalone"] : ["--dir", job.cwd])];
    if (job.mode === "write") args.push("--auto"); // approve what isn't explicitly denied; nobody can answer prompts headless
    else args.push("--agent", "plan"); // OpenCode's built-in read-only agent
    if (v2 && job.effort && !job.model) die("OpenCode 2.x takes effort as part of the model (provider/model#variant); name a model with --model, or leave out --effort");
    if (job.model) args.push("--model", v2 && job.effort ? `${job.model}#${job.effort}` : job.model);
    if (!v2 && job.effort) args.push("--variant", job.effort);
    if (job.resumeSessionId) args.push("--session", job.resumeSessionId);
    args.push(prompt);
    return { bin: job.agentBin, args, stdin: null };
  },

  parser(ctx) {
    let started = false;
    let errored = false;
    let tokens = { input: 0, output: 0, reasoning: 0 };
    let cost = 0;
    return (ev) => {
      if (!started && ev.sessionID) {
        started = true;
        ctx.init({ sessionId: ev.sessionID });
      }
      const p = ev.part || {};
      switch (ev.type) {
        case "text":
          ctx.say(p.text);
          break;
        case "reasoning":
          ctx.log(`think  ${oneLine(p.text, 120)}`);
          break;
        case "tool_use": {
          const st = p.state || {};
          const t = describeTool(p.tool === "bash" ? "shell" : p.tool, st.input || {});
          const id = p.callID || p.id || `${p.tool}-${Date.now()}`;
          ctx.toolStart(id, { kind: t.kind, text: `${t.kind.padEnd(6)} ${t.kind === "edit" || t.kind === "read" ? t.paths.map(ctx.rel).join(", ") : t.summary}`, command: t.command, path: t.kind === "edit" ? t.paths[0] : null });
          const exit = st.metadata?.exit ?? st.metadata?.metadata?.exit;
          if (st.status === "error") ctx.toolEnd(id, { error: st.error || "tool failed" });
          else ctx.toolEnd(id, { exitCode: exit ?? (t.kind === "shell" ? "?" : 0) });
          break;
        }
        case "step_finish":
          if (p.tokens) {
            tokens = { input: tokens.input + (p.tokens.input || 0), output: tokens.output + (p.tokens.output || 0), reasoning: tokens.reasoning + (p.tokens.reasoning || 0) };
            ctx.state.usage = tokens;
          }
          if (p.cost) cost += p.cost;
          if (cost) ctx.state.costUsd = cost;
          if (p.reason === "stop" && !errored) ctx.final({ isError: false, usage: tokens, costUsd: cost || null });
          break;
        case "error": {
          let msg = ev.error?.data?.message || ev.error?.message || ev.error?.name || JSON.stringify(ev.error || ev);
          if (ev.error?.retryAfterMs) msg += ` (retry in ${Math.ceil(ev.error.retryAfterMs / 60000)} min)`;
          errored = true;
          ctx.error(msg);
          ctx.final({ isError: true, result: msg });
          break;
        }
        default:
          break;
      }
    };
  },

  sessions: {
    stores() {
      return [{ label: "OpenCode sessions (CLI, TUI, desktop app)", path: exists(DB()) ? DB() : path.join(DATA(), "storage"), count: exists(DB()) || exists(path.join(DATA(), "storage")) ? "present" : 0 }];
    },
    list: listSessions,
    load: loadSession,
    inCwd: (s, dir) => isUnder(s.cwd, dir),
  },
};

export default adapter;

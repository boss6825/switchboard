// Cursor. CLI: `cursor-agent` (also installed as `agent`). Both the CLI and the
// Cursor editor's agent write plain transcripts to
// ~/.cursor/projects/<encoded-cwd>/agent-transcripts/<id>/<id>.jsonl. The CLI
// also keeps ~/.cursor/chats/<hash>/<id>/ (encrypted store + meta.json with the
// cwd). Editor chats from before transcripts existed live only in the editor's
// state.vscdb database; they are read from there when Cursor left them readable.
// Headless runs: `cursor-agent -p --output-format stream-json`.

import fs from "node:fs";
import path from "node:path";
import {
  home, which, run, readJSON, writeJSON, readText, parseJsonl, walk, mtime, toMs, cmpVersion,
  oneLine, stripAnsi, die, exists,
} from "../util.mjs";
import { SB_HOME, policyFor } from "../config.mjs";
import { query, tables } from "../sqlite.mjs";
import { describeTool, desktopApp, decodeSlug, isUnder, titleFrom } from "./common.mjs";

const CURSOR_HOME = () => process.env.SWITCHBOARD_CURSOR_HOME || home(".cursor");
const MODELS_CACHE = () => path.join(SB_HOME, "cursor-models.json");
const MODELS_TTL_MS = Number(process.env.SWITCHBOARD_MODELS_TTL ?? 6 * 3600) * 1000;
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

function editorDb() {
  if (process.env.SWITCHBOARD_CURSOR_DB) return process.env.SWITCHBOARD_CURSOR_DB;
  if (process.platform === "darwin") return home("Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb");
  if (process.platform === "win32") return path.join(process.env.APPDATA || home("AppData", "Roaming"), "Cursor", "User", "globalStorage", "state.vscdb");
  return home(".config", "Cursor", "User", "globalStorage", "state.vscdb");
}

// ------------------------------------------------------------ model policy
//
// Cursor ids carry the effort: "grok-4.7-xhigh", "cursor-grok-4.6-high-fast".
// "<family>:latest" resolves, per job, to the newest version of that family at
// the chosen effort, so a new release is picked up without config changes.

export function parseModelId(id) {
  const m = /^(?:cursor-)?([a-z]+)-(\d+(?:\.\d+)*)-(low|medium|high|xhigh|max)(-fast)?$/.exec(id || "");
  return m ? { family: m[1], version: m[2], effort: m[3], fast: !!m[4] } : null;
}

function fetchModels({ refresh = false } = {}) {
  const cache = readJSON(MODELS_CACHE(), null);
  if (!refresh && cache?.ids?.length && Date.now() - cache.at < MODELS_TTL_MS) return cache;
  const bin = adapter.bin();
  const r = bin ? run(bin, ["models"], { timeout: 60000 }) : { ok: false, err: "cursor-agent not found" };
  if (!r.ok) {
    if (cache?.ids?.length) return cache; // offline: a stale list beats no list
    die(`could not list Cursor models: ${stripAnsi(r.err || r.out).trim()}`);
  }
  const ids = stripAnsi(r.out)
    .split("\n")
    .map((l) => l.replace(/[​-‍﻿]/g, "").trim())
    .filter((l) => / - /.test(l))
    .map((l) => l.split(" - ")[0].trim());
  const next = { at: Date.now(), ids, latest: cache?.latest || {} };
  writeJSON(MODELS_CACHE(), next);
  return next;
}

function newestInFamily(family, ids) {
  let best = null;
  for (const id of ids) {
    const p = parseModelId(id);
    if (p && p.family === family && !p.fast && (!best || cmpVersion(p.version, best) > 0)) best = p.version;
  }
  return best;
}

function familyId(family, version, effort, ids) {
  return ids.find((id) => {
    const p = parseModelId(id);
    return p && p.family === family && p.version === version && p.effort === effort && !p.fast;
  });
}

function resolveModel(want, effort, { notes }) {
  const models = fetchModels();
  const ids = models.ids;
  const alias = /^([a-z]+):latest$/.exec(want);
  // "grok-4.7" means that version at the chosen effort, unless it is itself a real id.
  const bare = ids.includes(want) ? null : /^(?:cursor-)?([a-z]+)-(\d+(?:\.\d+)*)$/.exec(want);
  if (alias || bare) {
    const family = (alias || bare)[1];
    const version = alias ? newestInFamily(family, ids) : bare[2];
    if (!version) die(`no ${family} models on your Cursor plan (checked ${ids.length} models; refresh with: switchboard models cursor --refresh)`);
    const eff = effort || "high";
    const id = familyId(family, version, eff, ids);
    if (!id) die(`${family} ${version} has no "${eff}" effort on your plan; available: ${EFFORTS.filter((e) => familyId(family, version, e, ids)).join(", ") || "none"}`);
    if (alias) {
      const prev = models.latest?.[family];
      if (prev && prev !== version) notes.push(`${family} ${version} is now the newest ${family} on your Cursor plan; using it instead of ${prev}.`);
      if (prev !== version) writeJSON(MODELS_CACHE(), { ...models, latest: { ...(models.latest || {}), [family]: version } });
    }
    return { id, effort: eff };
  }
  if (effort && !parseModelId(want)) die(`--effort applies to a family model (e.g. grok:latest or grok-4.7), not to "${want}"`);
  if (ids.length && !ids.includes(want)) die(`"${want}" is not a model on your Cursor plan (see: switchboard models cursor ${want.split("-")[0]})`);
  return { id: want, effort: parseModelId(want)?.effort || null };
}

// ----------------------------------------------------------------- sessions

function cliChats() {
  // id -> { cwd, createdAt } from the CLI's own chat folders.
  const out = {};
  for (const f of walk(path.join(CURSOR_HOME(), "chats"), { match: (_, n) => n === "meta.json", maxDepth: 3 })) {
    const m = readJSON(f, null);
    if (m) out[path.basename(path.dirname(f))] = { cwd: m.cwd, createdAt: m.createdAtMs };
  }
  return out;
}

function transcriptFiles() {
  const root = path.join(CURSOR_HOME(), "projects");
  const out = [];
  let projects = [];
  try {
    projects = fs.readdirSync(root);
  } catch {
    return out;
  }
  for (const slug of projects) {
    const dir = path.join(root, slug, "agent-transcripts");
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        const f = path.join(dir, e.name, `${e.name}.jsonl`);
        if (exists(f)) out.push({ file: f, id: e.name, slug });
      } else if (/\.jsonl$/.test(e.name)) out.push({ file: path.join(dir, e.name), id: e.name.replace(/\.jsonl$/, ""), slug });
    }
  }
  return out;
}

function queryText(t) {
  const q = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/.exec(t);
  if (q) return q[1];
  return /^\s*</.test(t) ? "" : t;
}

function firstUserQuery(file) {
  const fd = fs.openSync(file, "r");
  try {
    const b = Buffer.alloc(65536);
    const n = fs.readSync(fd, b, 0, b.length, 0);
    for (const o of parseJsonl(b.subarray(0, n).toString("utf8"))) {
      if (o.role !== "user") continue;
      for (const p of o.message?.content || []) if (p.type === "text" && queryText(p.text).trim()) return queryText(p.text);
    }
  } catch {
  } finally {
    fs.closeSync(fd);
  }
  return "";
}

async function editorHeaders() {
  const db = editorDb();
  if (!exists(db)) return [];
  try {
    const t = await tables(db);
    if (!t.has("composerHeaders")) return [];
    const rows = await query(db, "select composerId, createdAt, lastUpdatedAt, isArchived, isSubagent, value from composerHeaders where isSubagent = 0");
    return rows.map((r) => {
      let v = {};
      try {
        v = JSON.parse(r.value || "{}");
      } catch {}
      return { id: r.composerId, createdAt: r.createdAt, updatedAt: r.lastUpdatedAt, archived: !!r.isArchived, draft: !!v.isDraft, name: v.name, cwd: v.workspaceIdentifier?.uri?.fsPath || v.workspaceIdentifier?.uri?.path || null };
    }).filter((h) => !h.draft && /^[0-9a-f-]{36}$/.test(h.id));
  } catch {
    return [];
  }
}

async function listSessions({ legacy = true } = {}) {
  const cli = cliChats();
  const out = [];
  const seen = new Set();
  const editor = legacy ? await editorHeaders() : [];
  const editorById = Object.fromEntries(editor.map((h) => [h.id, h]));
  for (const t of transcriptFiles()) {
    seen.add(t.id);
    const c = cli[t.id];
    const h = editorById[t.id];
    out.push({
      agent: "cursor",
      id: t.id,
      title: (h?.name && h.name !== "New Agent" ? h.name : null) || titleFrom(firstUserQuery(t.file)) || "(untitled)",
      cwd: c?.cwd || h?.cwd || decodeSlug(t.slug) || null,
      surface: c ? "cli" : "editor",
      createdAt: c?.createdAt || h?.createdAt || null,
      updatedAt: mtime(t.file),
      model: null,
      file: t.file,
    });
  }
  for (const h of editor) {
    if (seen.has(h.id)) continue;
    out.push({
      agent: "cursor",
      id: h.id,
      title: h.name || "(untitled)",
      cwd: h.cwd,
      surface: "editor (older chat)",
      createdAt: h.createdAt,
      updatedAt: h.updatedAt || h.createdAt,
      model: null,
      file: null,
      db: editorDb(),
      archived: h.archived,
    });
  }
  return out;
}

function loadTranscript(meta) {
  const events = [];
  let ended = "unknown";
  for (const o of parseJsonl(readText(meta.file))) {
    if (o.type === "turn_ended") {
      ended = o.status || "unknown";
      if (o.error) events.push({ ts: null, type: "error", text: `Turn ended with error: ${o.error}` });
      continue;
    }
    for (const p of o.message?.content || []) {
      if (p.type === "text") {
        if (o.role === "user") {
          const t = queryText(p.text);
          if (t.trim()) events.push({ ts: null, type: "user", text: t });
        } else if (p.text.trim()) events.push({ ts: null, type: "assistant", text: p.text });
      } else if (p.type === "tool_use") {
        let input = p.input;
        if (p.name === "CallDynamicTool" && input) input = { namespace: input.namespace, toolName: input.toolName };
        events.push({ ts: null, type: "tool", tool: describeTool(p.name, input) });
      }
    }
  }
  const notes = ["Cursor's transcripts record what the agent did but not the tool results, so command outputs and exit codes are not available."];
  return { ...meta, events, ended, limits: null, notes };
}

async function loadEditorChat(meta) {
  const rows = await query(meta.db, "select value from cursorDiskKV where key = ?", [`composerData:${meta.id}`]);
  let data = {};
  try {
    data = JSON.parse(rows[0]?.value || "{}");
  } catch {}
  const headers = data.fullConversationHeadersOnly || [];
  if (!headers.length) {
    return { ...meta, events: [], ended: "unknown", limits: null, notes: ["Cursor keeps this chat's messages in an encrypted or compacted form; its content cannot be read from disk. Open it in Cursor instead."] };
  }
  const prefix = `bubbleId:${meta.id}:`;
  const bubbles = await query(meta.db, "select key, value from cursorDiskKV where key >= ? and key < ?", [prefix, `bubbleId:${meta.id};`]);
  const byId = {};
  for (const b of bubbles) {
    try {
      byId[b.key.slice(prefix.length)] = JSON.parse(b.value);
    } catch {}
  }
  const events = [];
  for (const h of headers) {
    const b = byId[h.bubbleId];
    if (!b) continue;
    const ts = toMs(b.createdAt);
    if (b.type === 1 && b.text?.trim()) events.push({ ts, type: "user", text: b.text });
    else if (b.type === 2) {
      if (b.text?.trim()) events.push({ ts, type: "assistant", text: b.text });
      const t = b.toolFormerData;
      if (t?.name) {
        let input = {};
        try {
          input = JSON.parse(t.rawArgs || t.params || "{}");
        } catch {}
        const tool = describeTool(t.name, input);
        tool.status = t.status;
        if (typeof t.result === "string") tool.output = t.result;
        events.push({ ts, type: "tool", tool });
      }
    }
  }
  return { ...meta, events, ended: "unknown", limits: null, notes: ["Read from Cursor's editor database (an older chat)."] };
}

// ------------------------------------------------------------------ adapter

const adapter = {
  name: "cursor",
  label: "Cursor",
  prefix: "cu",
  installHint: "curl https://cursor.com/install -fsS | bash",
  loginHint: "cursor-agent login",
  efforts: EFFORTS,
  supports: { resume: true, modes: ["write", "ask", "plan"], stdinPrompt: false },
  verifiesModel: false, // Cursor reports a display name ("Grok 4.7 256K Low"), not the id

  bin() {
    // Prefer the unambiguous name; "agent" is generic enough to collide.
    return policyFor("cursor").bin || process.env.SWITCHBOARD_CURSOR_BIN || which("cursor-agent") || which("agent");
  },
  desktop() {
    return desktopApp(["Cursor.app"], [home(".config", "Cursor")]);
  },
  version() {
    const b = this.bin();
    if (!b) return null;
    const r = run(b, ["--version"], { timeout: 15000 });
    return r.ok ? r.out.trim() : null;
  },
  auth() {
    const b = this.bin();
    if (!b) return { ok: false, detail: "not installed" };
    if (process.env.CURSOR_API_KEY) return { ok: true, detail: "CURSOR_API_KEY in environment" };
    const r = run(b, ["status"], { timeout: 30000 });
    const text = stripAnsi(r.out + r.err).trim();
    const ok = r.ok && /logged in/i.test(text) && !/not logged in/i.test(text);
    return { ok, detail: ok ? "logged in" : text.split("\n")[0] || "unknown" };
  },
  takeover: (id) => `cursor-agent --resume ${id}`,

  listModels: ({ refresh = false } = {}) => fetchModels({ refresh }).ids,
  resolveModel,
  matchNames(id) {
    const p = parseModelId(id);
    return p ? [id, p.family] : [id];
  },
  isLatestOf(pattern, id) {
    const family = pattern.replace(/:latest$/, "");
    const p = parseModelId(id);
    return !!p && p.family === family && !p.fast && p.version === newestInFamily(family, fetchModels().ids);
  },

  buildRun(job, prompt) {
    const args = ["-p", "--output-format", "stream-json", "--trust"];
    if (job.mode === "write") args.push("--force");
    else args.push("--mode", job.mode);
    if (job.model) args.push("--model", job.model);
    if (job.resumeSessionId) args.push("--resume", job.resumeSessionId);
    else args.push("--workspace", job.cwd);
    for (const d of job.addDirs || []) args.push("--add-dir", d);
    args.push(prompt);
    return { bin: job.agentBin, args, stdin: null };
  },

  parser(ctx) {
    const describe = (tc) => {
      const key = Object.keys(tc).find((k) => k.endsWith("ToolCall")) || "toolCall";
      const a = tc[key]?.args || {};
      const kind = key.replace(/ToolCall$/, "");
      switch (kind) {
        case "read":
          return { kind, text: `read   ${ctx.rel(a.path)}` };
        case "edit":
        case "write":
        case "delete":
          return { kind, text: `${kind.padEnd(6)} ${ctx.rel(a.path)}`, path: a.path };
        case "shell":
          return { kind, text: `shell  ${oneLine(a.command, 160)}`, command: a.command };
        case "grep":
          return { kind, text: `grep   ${oneLine(a.pattern, 80)}${a.path ? ` in ${ctx.rel(a.path)}` : ""}` };
        default:
          return { kind, text: `${kind.padEnd(6)} ${oneLine(a.globPattern || a.pattern || a.path || JSON.stringify(a), 100)}` };
      }
    };
    return (ev) => {
      switch (ev.type) {
        case "system":
          if (ev.subtype === "init") ctx.init({ sessionId: ev.session_id, model: ev.model, cwd: ev.cwd });
          break;
        case "assistant":
          ctx.say((ev.message?.content || []).filter((c) => c.type === "text").map((c) => c.text).join(""));
          break;
        case "tool_call": {
          const tc = ev.tool_call || {};
          const callId = ev.call_id || tc.toolCallId;
          if (ev.subtype === "started") ctx.toolStart(callId, describe(tc));
          else if (ev.subtype === "completed") {
            const key = Object.keys(tc).find((k) => k.endsWith("ToolCall"));
            const res = key ? tc[key].result : null;
            if (res?.error) ctx.toolEnd(callId, { error: JSON.stringify(res.error) }, describe(tc));
            else if (res?.success || res?.failure) {
              const s = res.success || res.failure || {};
              ctx.toolEnd(callId, { exitCode: s.exitCode ?? (res.success ? 0 : "?"), stderr: s.stderr, added: s.linesAdded || s.linesCreated || 0, removed: s.linesRemoved || 0 }, describe(tc));
            } else ctx.toolEnd(callId, {}, describe(tc));
          }
          break;
        }
        case "result":
          ctx.final({ isError: !!ev.is_error, result: ev.result, usage: ev.usage, durationMs: ev.duration_ms });
          break;
        default:
          break; // thinking deltas and user echo stay in events.jsonl only
      }
    };
  },

  sessions: {
    stores() {
      const files = transcriptFiles();
      const cli = cliChats();
      const db = editorDb();
      return [
        { label: "Cursor agent transcripts (CLI and editor)", path: path.join(CURSOR_HOME(), "projects"), count: files.length, cli: files.filter((f) => cli[f.id]).length },
        { label: "Cursor editor database (older editor chats)", path: db, count: exists(db) ? "present" : 0 },
      ];
    },
    list: listSessions,
    load: (meta) => (meta.file ? loadTranscript(meta) : loadEditorChat(meta)),
    inCwd: (s, dir) => isUnder(s.cwd, dir),
  },
};

export default adapter;

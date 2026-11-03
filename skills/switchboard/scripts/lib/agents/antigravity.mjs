// Google Antigravity. CLI: `agy`. The CLI keeps one SQLite file per
// conversation under ~/.gemini/antigravity-cli/conversations/<id>.db (steps as
// protobuf blobs) and an index in conversation_summaries.db; the Antigravity
// app keeps the same layout under ~/.gemini/antigravity/. There is no export
// command, so steps are decoded here by field number, read-only.
// Headless runs: `agy -p … --output-format stream-json`.
//
// Built from Antigravity's documentation and live runs of agy 1.4.12.

import fs from "node:fs";
import path from "node:path";
import { home, which, run, readJSON, writeJSON, mtime, toMs, cmpVersion, oneLine, stripAnsi, die, exists } from "../util.mjs";
import { SB_HOME, policyFor } from "../config.mjs";
import { query } from "../sqlite.mjs";
import { describeTool, desktopApp, isUnder, titleFrom } from "./common.mjs";

const GEMINI = () => process.env.SWITCHBOARD_ANTIGRAVITY_HOME || home(".gemini");
const STORES = () => [
  { dir: path.join(GEMINI(), "antigravity-cli"), surface: "cli", label: "Antigravity CLI conversations" },
  { dir: path.join(GEMINI(), "antigravity"), surface: "app", label: "Antigravity app conversations" },
];
const SETTINGS = () => path.join(GEMINI(), "antigravity-cli", "settings.json");
const MODELS_CACHE = () => path.join(SB_HOME, "antigravity-models.json");
const MODELS_TTL_MS = Number(process.env.SWITCHBOARD_MODELS_TTL ?? 6 * 3600) * 1000;
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

// ------------------------------------------------------------ model policy
//
// Gemini ids carry the effort: "gemini-3.8-flash-medium". "flash:latest" is the
// newest Flash at the chosen effort. Other ids (claude-sonnet-4-6, gpt-oss-…)
// are used as listed by `agy models`.

export function parseModelId(id) {
  const m = /^gemini-(\d+(?:\.\d+)*)-([a-z]+)-(low|medium|high|xhigh|max)$/.exec(id || "");
  return m ? { family: m[2], version: m[1], effort: m[3] } : null;
}

function fetchModels({ refresh = false } = {}) {
  const cache = readJSON(MODELS_CACHE(), null);
  if (!refresh && cache?.ids?.length && Date.now() - cache.at < MODELS_TTL_MS) return cache.ids;
  const bin = adapter.bin();
  const r = bin ? run(bin, ["models"], { timeout: 90000 }) : { ok: false, err: "agy not found" };
  const ids = r.ok ? stripAnsi(r.out).split("\n").map((l) => l.split(/\t|\s{2,}/)[0].trim()).filter((l) => /^[a-z][\w.-]*$/.test(l)) : [];
  if (!ids.length) {
    if (cache?.ids?.length) return cache.ids; // offline: a stale list beats no list
    die(`could not list Antigravity models: ${oneLine(stripAnsi(r.err || r.out).trim(), 200) || "agy models printed none"}`);
  }
  writeJSON(MODELS_CACHE(), { at: Date.now(), ids });
  return ids;
}

function newestInFamily(family, ids) {
  let best = null;
  for (const id of ids) {
    const p = parseModelId(id);
    if (p && p.family === family && (!best || cmpVersion(p.version, best) > 0)) best = p.version;
  }
  return best;
}

const familyId = (family, version, effort, ids) => ids.find((id) => {
  const p = parseModelId(id);
  return p && p.family === family && p.version === version && p.effort === effort;
});

function resolveModel(want, effort, { notes }) {
  const ids = fetchModels();
  const alias = /^([a-z]+):latest$/.exec(want);
  // "gemini-3.8-flash" means that version at the chosen effort.
  const bare = ids.includes(want) ? null : /^gemini-(\d+(?:\.\d+)*)-([a-z]+)$/.exec(want);
  if (alias || bare) {
    const family = alias ? alias[1] : bare[2];
    const version = alias ? newestInFamily(family, ids) : bare[1];
    if (!version) die(`no Gemini ${family} models in \`agy models\` (see: switchboard models antigravity)`);
    const eff = effort || "medium";
    const id = familyId(family, version, eff, ids);
    if (!id) die(`Gemini ${version} ${family} has no "${eff}" effort; available: ${EFFORTS.filter((e) => familyId(family, version, e, ids)).join(", ") || "none"}`);
    if (alias) notes.push(`${want} resolves to ${id} today.`);
    return { id, effort: eff };
  }
  if (effort && parseModelId(want)) die(`"${want}" already names its effort; use the family (e.g. ${want.replace(/-(low|medium|high|xhigh|max)$/, "")}) with --effort, or drop --effort`);
  if (ids.length && !ids.includes(want)) die(`"${want}" is not in \`agy models\` (see: switchboard models antigravity)`);
  return { id: want, effort: parseModelId(want)?.effort || effort || null };
}

// What would make a run bill beyond the plan's quota: a Gemini API key or a
// Google Cloud project instead of the signed-in account. AI credits are switched
// off per run instead (see buildRun).
function billedAuth() {
  const s = readJSON(SETTINGS(), {}) || {};
  if (s.modelProvider === "gemini") return "uses a Gemini API key (modelProvider is \"gemini\" in ~/.gemini/antigravity-cli/settings.json), which bills per token";
  if (/^(1|true|yes)$/i.test(process.env.AGY_ADC_AUTH || "")) return "signs in with Google Cloud credentials (AGY_ADC_AUTH is set), which bills the Cloud project";
  return null;
}

// ------------------------------------------------------- protobuf decoding
//
// A schemaless reader: each message becomes { field: [values] }, where a value
// is a number, or a Buffer for length-delimited fields. Field numbers below were
// read from agy 1.4.12's step blobs:
//   step.1 type (14 user input, 15 agent turn, 132 tool result), step.4 status (7 = error)
//   step.5.1.1 time (seconds)
//   user:   step.19.2 text
//   agent:  step.20.1 text, step.20.7[] tool call { 1 id, 2 name, 3 args JSON }
//   result: step.5.4 call { 1 id, 2 name, 3 args JSON }, step.140.2.1 output, step.31.2 error

function varint(b, i) {
  let r = 0;
  let s = 1;
  for (;;) {
    if (i >= b.length) throw new Error("truncated");
    const c = b[i++];
    r += (c & 0x7f) * s;
    if (c < 0x80) return [r, i];
    s *= 128;
  }
}

function pb(b) {
  const out = {};
  let i = 0;
  while (i < b.length) {
    let key;
    [key, i] = varint(b, i);
    const f = Math.floor(key / 8);
    const w = key % 8;
    if (!f) throw new Error("bad field");
    let v;
    if (w === 0) [v, i] = varint(b, i);
    else if (w === 1) (v = null), (i += 8);
    else if (w === 5) (v = null), (i += 4);
    else if (w === 2) {
      let n;
      [n, i] = varint(b, i);
      v = b.subarray(i, i + n);
      i += n;
    } else throw new Error("bad wire type");
    if (i > b.length) throw new Error("truncated");
    (out[f] ||= []).push(v);
  }
  return out;
}

const msg = (v) => {
  if (!Buffer.isBuffer(v)) return {};
  try {
    return pb(v);
  } catch {
    return {};
  }
};
const at = (m, ...fields) => {
  let cur = m;
  for (const f of fields.slice(0, -1)) cur = msg(cur?.[f]?.[0]);
  return cur?.[fields[fields.length - 1]]?.[0];
};
const str = (v) => (Buffer.isBuffer(v) ? v.toString("utf8") : typeof v === "number" ? String(v) : "");

const blob = (v) => (v == null ? null : typeof v === "string" ? Buffer.from(v, "hex") : Buffer.from(v));

// agy's parameter names (CommandLine, Path, Query, …) -> the names describeTool reads.
const TOOL_KIND = {
  run_command: "shell", send_command_input: "shell",
  edit_file: "edit", write_to_file: "write", write_file: "write", replace_file_content: "edit", multi_replace_file_content: "edit", sed_file: "edit", notebook_edit: "edit",
  read_file: "read", view_file: "read", list_dir: "list_dir",
  grep_search: "grep", find_by_name: "find", codesearch: "search",
  search_web: "web_search", read_url_content: "web_fetch", open_browser_url: "browse", read_browser_page: "browse",
  call_mcp_tool: "mcp__", invoke_subagent: "agent", browser_subagent: "agent", define_subagent: "agent",
  manage_task: "todo",
};

function toolRecord(name, args) {
  let a = {};
  try {
    a = typeof args === "string" ? JSON.parse(args || "{}") : args || {};
  } catch {}
  const input = {
    command: a.CommandLine,
    path: a.Path || a.AbsolutePath || a.TargetFile || a.DirectoryPath || a.File,
    pattern: a.Query || a.Pattern || a.SearchPattern,
    query: a.Query,
    url: a.Url || a.URL,
    server: a.ServerName,
    tool: a.ToolName,
    description: a.toolSummary || a.Task || a.Prompt,
  };
  const t = describeTool(TOOL_KIND[name] || name, input);
  t.name = name;
  return t;
}

async function loadSteps(file) {
  const rows = await query(file, "select idx, hex(step_payload) as payload from steps order by idx");
  const events = [];
  const calls = new Map();
  let parsed = 0;
  for (const r of rows) {
    const s = msg(blob(r.payload));
    const type = s[1]?.[0];
    if (type == null) continue;
    parsed++;
    const sec = at(s, 5, 1, 1);
    const ts = typeof sec === "number" ? sec * 1000 : null;
    const failed = s[4]?.[0] === 7;
    if (type === 14) {
      const text = str(at(s, 19, 2));
      if (text.trim()) events.push({ ts, type: "user", text });
    } else if (type === 15) {
      const a = msg(s[20]?.[0]);
      const text = str(a[1]?.[0]);
      if (text.trim()) events.push({ ts, type: "assistant", text });
      for (const c of a[7] || []) {
        const m = msg(c);
        calls.set(str(m[1]?.[0]), { ts, name: str(m[2]?.[0]), args: str(m[3]?.[0]) });
      }
    } else if (type === 132) {
      const c = msg(s[5]?.[0]);
      const call = msg(c[4]?.[0]);
      const id = str(call[1]?.[0]);
      const name = str(call[2]?.[0]) || calls.get(id)?.name || "tool";
      calls.delete(id);
      const tool = toolRecord(name, str(call[3]?.[0]) || calls.get(id)?.args);
      const output = str(at(s, 140, 2, 1));
      const error = str(at(s, 31, 2));
      if (output || error) tool.output = output || error;
      const exit = /exited with code (\d+)/.exec(output);
      if (exit) tool.exitCode = Number(exit[1]);
      tool.status = failed || error ? "failed" : "completed";
      if (error) tool.error = error;
      events.push({ ts, type: "tool", tool });
    }
  }
  for (const c of calls.values()) events.push({ ts: c.ts, type: "tool", tool: { ...toolRecord(c.name, c.args), status: "no result" } });
  return { events, parsed: parsed > 0 && events.length > 0 };
}

// ----------------------------------------------------------------- sessions

const fromUri = (u) => {
  try {
    return u?.startsWith("file://") ? decodeURIComponent(new URL(u).pathname) : u || null;
  } catch {
    return null;
  }
};
const firstWorkspace = (json) => {
  try {
    return fromUri(JSON.parse(json || "[]")[0]);
  } catch {
    return null;
  }
};
const time = (v) => toMs(typeof v === "string" ? v.replace(" ", "T") : v);

async function summaries(store) {
  const db = path.join(store.dir, "conversation_summaries.db");
  if (!exists(db)) return [];
  try {
    return await query(db, "select conversation_id, title, preview, workspace_uris, last_modified_time, parent_conversation_id from conversation_summaries");
  } catch {
    return [];
  }
}

function conversationFiles(store) {
  try {
    return fs.readdirSync(path.join(store.dir, "conversations")).filter((n) => /\.(db|pb)$/.test(n));
  } catch {
    return [];
  }
}

async function listSessions() {
  const out = [];
  const seen = new Set();
  for (const store of STORES()) {
    const files = Object.fromEntries(conversationFiles(store).map((n) => [n.replace(/\.(db|pb)$/, ""), path.join(store.dir, "conversations", n)]));
    for (const r of await summaries(store)) {
      if (r.parent_conversation_id || seen.has(r.conversation_id)) continue; // subagent runs belong to their parent
      seen.add(r.conversation_id);
      out.push({
        agent: "antigravity",
        id: r.conversation_id,
        title: r.title || titleFrom(r.preview) || "(untitled)",
        cwd: firstWorkspace(r.workspace_uris),
        surface: store.surface,
        createdAt: null,
        updatedAt: time(r.last_modified_time) || mtime(files[r.conversation_id]),
        model: null,
        file: files[r.conversation_id] || null,
        preview: r.preview,
      });
    }
    // Conversations the index does not know yet (it is rebuilt in the background).
    for (const [id, file] of Object.entries(files)) {
      if (seen.has(id) || !file.endsWith(".db")) continue;
      seen.add(id);
      let title = "(untitled)";
      try {
        const first = (await loadSteps(file)).events.find((e) => e.type === "user");
        if (first) title = titleFrom(first.text);
      } catch {}
      out.push({ agent: "antigravity", id, title, cwd: null, surface: store.surface, createdAt: null, updatedAt: mtime(file), model: null, file });
    }
  }
  return out;
}

async function loadSession(meta) {
  const notes = ["Antigravity has no export command; this chat was decoded from its local database, which a new agy release may change."];
  let events = [];
  if (meta.file?.endsWith(".db")) {
    try {
      const r = await loadSteps(meta.file);
      events = r.events;
      if (!r.parsed) notes.push("No messages could be decoded from this conversation's database; its format may have changed. Open it in Antigravity instead.");
    } catch (e) {
      notes.push(`Could not read ${meta.file}: ${oneLine(e.message, 160)}`);
    }
  } else {
    notes.push("Antigravity keeps this conversation in a format Switchboard cannot read; only its title and preview are shown. Open it in Antigravity instead.");
    if (meta.preview) events.push({ ts: meta.updatedAt, type: "note", text: meta.preview });
  }
  return { ...meta, createdAt: meta.createdAt || events.find((e) => e.ts)?.ts || null, events, ended: "unknown", limits: null, notes };
}

// ------------------------------------------------------------------ adapter

// One-run settings (agy --settings). Rules are added to the user's own, never
// replacing them: a run's `permissions` would otherwise stand in for theirs.
function runSettings(job) {
  const user = readJSON(SETTINGS(), {}) || {};
  const perms = user.permissions || {};
  const deny = [...(perms.deny || [])];
  const s = {};
  if (job.spend === "included") s.useG1Credits = false; // stop at the plan's quota; never spend AI credits
  // Commands run in the OS sandbox (workspace only, no network); anything that
  // needs to leave it is denied, because nobody can approve it headless.
  s.toolPermission = "proceed-in-sandbox";
  s.enableTerminalSandbox = true;
  if (job.mode === "write") {
    s.agentMode = "accept-edits";
    deny.push(`write_file(${path.join(job.cwd, ".git")})`); // no commits or branch changes
  } else deny.push("write_file(*)"); // read-only: also keeps sandboxed commands from writing
  s.permissions = { ...perms, deny: [...new Set(deny)] };
  return s;
}

const adapter = {
  name: "antigravity",
  label: "Antigravity",
  prefix: "ag",
  installHint: "curl -fsSL https://antigravity.google/cli/install.sh | bash   (see https://antigravity.google/docs/getting-started)",
  loginHint: "agy (sign in with your Google account when it asks)",
  efforts: EFFORTS,
  supports: { resume: true, modes: ["write", "ask"], stdinPrompt: false },
  verifiesModel: false, // init names the model only when --model was passed
  successOnCleanExit: false,

  bin() {
    return policyFor("antigravity").bin || process.env.SWITCHBOARD_ANTIGRAVITY_BIN || which("agy");
  },
  desktop() {
    return desktopApp(["Antigravity.app"]);
  },
  version() {
    const b = this.bin();
    if (!b) return null;
    const r = run(b, ["--version"], { timeout: 15000 });
    return r.ok ? r.out.trim().split("\n")[0].replace(/^agy\s+v?/i, "") : null;
  },
  auth() {
    const b = this.bin();
    if (!b) return { ok: false, detail: "not installed" };
    const billed = billedAuth();
    if (billed) return { ok: true, detail: billed.replace(/^uses|^signs in with/, (w) => (w === "uses" ? "using" : "signed in with")) };
    // `agy models` asks the backend for the account's models, so it fails when signed out.
    const r = run(b, ["models"], { timeout: 90000 });
    const text = stripAnsi(r.out + r.err);
    if (r.ok && /^\S+\t/m.test(r.out)) return { ok: true, detail: "signed in (models listed)" };
    if (/authenticat|sign.?in|log.?in|credential/i.test(text)) return { ok: false, detail: oneLine(text.trim(), 160) };
    return { ok: null, detail: oneLine(text.trim(), 160) || "could not tell" };
  },
  takeover: (id) => `agy --conversation ${id}`,

  listModels: ({ refresh = false } = {}) => fetchModels({ refresh }),
  resolveModel,
  // Every model on the user's plan counts against its quota and costs nothing
  // more. Runs set useG1Credits=false so an exhausted quota stops the job
  // instead of spending AI credits; API-key and Cloud sign-ins bill, so refuse them.
  included: {
    check: () => null,
    preflight: () => billedAuth(),
  },
  matchNames(id) {
    const p = parseModelId(id);
    return p ? [id, p.family, `gemini-${p.version}-${p.family}`] : [id];
  },
  isLatestOf(pattern, id) {
    const family = pattern.replace(/:latest$/, "");
    const p = parseModelId(id);
    return !!p && p.family === family && p.version === newestInFamily(family, fetchModels());
  },

  buildRun(job, prompt) {
    // Slash commands stay off: a brief that starts with "/" is text, not a command.
    const args = ["-p", prompt, "--output-format", "stream-json", "--disable-slash-commands"];
    args.push("--settings", JSON.stringify(runSettings(job)));
    if (job.model) args.push("--model", job.model);
    if (job.effort && !parseModelId(job.model)) args.push("--effort", job.effort);
    if (job.resumeSessionId) args.push("--conversation", job.resumeSessionId);
    for (const d of job.addDirs || []) args.push("--add-dir", d);
    return { bin: job.agentBin, args, stdin: null };
  },

  parser(ctx) {
    const text = new Map(); // step_index -> streamed text so far
    const describe = (s) => {
      const ti = s.tool_info || {};
      const t = toolRecord(ti.name || s.tool_name, ti.parameters);
      const where = t.kind === "edit" || t.kind === "read" ? t.paths.map(ctx.rel).join(", ") : t.summary;
      return { kind: t.kind, text: `${t.kind.padEnd(6)} ${where}`, command: t.command, path: t.kind === "edit" ? t.paths[0] : null };
    };
    return (ev) => {
      switch (ev.event) {
        case "init":
          ctx.init({ sessionId: ev.conversation_id, model: ev.init?.model, cwd: ev.init?.cwd });
          break;
        case "step_update": {
          const s = ev.step_update || {};
          if (s.step_type === "agent_response") {
            text.set(s.step_index, (text.get(s.step_index) || "") + (s.text_delta || ""));
            if (s.state !== "ACTIVE") {
              ctx.say(text.get(s.step_index));
              text.delete(s.step_index);
            }
          } else if (s.step_type === "tool") {
            const id = `step-${s.step_index}`;
            if (s.state === "ACTIVE") ctx.toolStart(id, describe(s));
            else {
              const ti = s.tool_info || {};
              const d = describe(s);
              const exit = /exited with code (\d+)/.exec(ti.output || "");
              if (ti.error || s.state === "ERROR") ctx.toolEnd(id, { error: ti.error?.message || "tool failed" }, d);
              else ctx.toolEnd(id, { exitCode: exit ? Number(exit[1]) : d.kind === "shell" ? "?" : 0 }, d);
            }
          } else if (s.subagent_info?.subagents?.length) {
            ctx.log(`agent  ${s.subagent_info.subagents.map((a) => a.type_name || a.role).join(", ")}`);
          }
          break;
        }
        case "result": {
          const r = ev.result || {};
          const usage = r.usage ? { input: r.usage.input_tokens, output: r.usage.output_tokens, reasoning: r.usage.thinking_tokens, cacheRead: r.usage.cache_read_tokens } : null;
          const denied = (r.denied_actions || []).map((d) => d.action).filter(Boolean);
          let isError = r.status !== "SUCCESS";
          let result = r.response || r.error || r.status;
          // A headless run that needed an approval it could not get still says SUCCESS.
          if (!isError && !String(r.response || "").trim() && denied.length) {
            isError = true;
            result = `Antigravity stopped without an answer: it needed permission for ${[...new Set(denied)].join(", ")}, which a headless job cannot grant (commands must run inside the sandbox: workspace only, no network).`;
          }
          if (isError) ctx.error(result);
          ctx.final({ isError, result, usage, durationMs: r.duration_seconds ? Math.round(r.duration_seconds * 1000) : null });
          break;
        }
        default:
          break;
      }
    };
  },

  sessions: {
    stores() {
      return STORES().map((s) => ({ label: s.label, path: path.join(s.dir, "conversations"), count: conversationFiles(s).length }));
    },
    list: listSessions,
    load: loadSession,
    inCwd: (s, dir) => isUnder(s.cwd, dir),
  },
};

export default adapter;

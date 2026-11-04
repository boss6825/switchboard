// Reading other agents' chats: list, search, show, and the handoff brief that
// lets one agent continue where another stopped.

import fs from "node:fs";
import path from "node:path";
import { agent as getAgent, allAgents } from "./agents/index.mjs";
import { repoRoot, workspaceState } from "./git.mjs";
import { isUnder } from "./agents/common.mjs";
import { cyan, dim } from "./ui.mjs";
import { die, usage, parseArgs, readText, oneLine, clip, stamp, ago, tilde, table, exists, canon, CLI } from "./util.mjs";

const LIST_SPEC = { agent: "value", all: "bool", cwd: "value", limit: "value", json: "bool", archived: "bool", subagents: "bool" };

function pickAgents(spec) {
  if (!spec) return allAgents();
  return spec.split(",").map((n) => getAgent(n.trim()) || die(`unknown agent "${n}"`));
}

async function gather(agents, { archived = false, subagents = false } = {}) {
  const out = [];
  const errors = [];
  for (const a of agents) {
    try {
      const list = await a.sessions.list({ includeSubagents: subagents });
      out.push(...list.filter((s) => archived || !s.archived));
    } catch (e) {
      errors.push(`${a.label}: ${e.message}`);
    }
  }
  out.sort((x, y) => (y.updatedAt || 0) - (x.updatedAt || 0));
  assignRefs(out);
  return { sessions: out, errors };
}

// Shortest id prefix (at least 8 characters) that is unique within its agent.
// Codex ids are time-ordered UUIDs, so threads created in the same second share
// their first 8 characters; those get a longer ref.
function assignRefs(list) {
  const byAgent = {};
  for (const s of list) (byAgent[s.agent] ||= []).push(s.id);
  for (const s of list) {
    const ids = byAgent[s.agent];
    let n = Math.min(8, s.id.length);
    while (n < s.id.length && ids.some((other) => other !== s.id && other.startsWith(s.id.slice(0, n)))) n++;
    if (s.id[n - 1] === "-") n++;
    s.ref = `${s.agent}:${s.id.slice(0, n)}`;
  }
}

function scopeDir(o) {
  const cwd = path.resolve(o.cwd || process.cwd());
  return repoRoot(cwd) || cwd;
}

// The calling agent's own live session is not something to hand off to itself.
function isSelf(s) {
  const own = process.env.CLAUDE_CODE_SESSION_ID || process.env.CODEX_THREAD_ID || process.env.CODEX_SESSION_ID;
  return !!own && s.id === own;
}

const ref = (s) => s.ref || `${s.agent}:${s.id.slice(0, 8)}`;

// A chat that was itself a delegated job starts with the standard sub-agent rules.
function taskOnly(text) {
  const i = String(text).indexOf("--- TASK ---");
  return i >= 0 ? `[delegated job; standard sub-agent rules omitted]\n${text.slice(i + 12).trim()}` : text;
}

function listRows(list) {
  return list.map((s) => [ref(s), s.surface, ago(s.updatedAt), oneLine(s.title, 56), tilde(s.cwd || "?")]);
}

export async function cmdSessions(argv) {
  const sub = ["list", "search", "show"].includes(argv[0]) ? argv[0] : "list";
  const rest = sub === argv[0] ? argv.slice(1) : argv;
  if (sub === "search") return cmdSearch(rest);
  if (sub === "show") return cmdShow(rest);

  const o = parseArgs(rest, LIST_SPEC);
  if (o._.length) return cmdShow(rest); // `sessions codex:last` reads as "show it"
  const { sessions, errors } = await gather(pickAgents(o.agent), o);
  const dir = scopeDir(o);
  let list = sessions;
  let scoped = false;
  if (!o.all) {
    const here = sessions.filter((s) => isUnder(s.cwd, dir));
    if (here.length) {
      list = here;
      scoped = true;
    }
  }
  list = list.slice(0, Number(o.limit || 15));
  if (o.json) return console.log(JSON.stringify(list, null, 2));
  for (const e of errors) console.log(`(could not read ${e})`);
  if (!list.length) return console.log(`No chats found. Run ${CLI} doctor to see which agents and stores were detected.`);
  console.log(scoped ? `Chats in ${tilde(dir)} (newest first; --all for every folder):\n` : `Chats in every folder (newest first${o.all ? "" : `; none are in ${tilde(dir)}`}):\n`);
  console.log(table(listRows(list), ["ref", "where", "updated", "title", "folder"], { paint: (c, i) => (i === 0 ? cyan(c) : i === 2 || i === 4 ? dim(c) : c) }));
  console.log(`\nRead one: ${CLI} sessions show <ref>     Continue one: ${CLI} handoff <ref>`);
}

// <agent>:<id-prefix> | <agent>:last | <id-prefix> | <words in the title>
export async function resolveSession(refStr, { cwd = process.cwd() } = {}) {
  if (!refStr) die("which chat? Give a ref like codex:last, codex:01a1894d, or words from its title");
  let [aName, key] = refStr.includes(":") ? refStr.split(/:(.*)/s, 2) : [null, refStr];
  const a = aName ? getAgent(aName) : null;
  if (aName && !a) {
    // "foo:bar" where foo is not an agent: treat the whole thing as title words.
    key = refStr;
  }
  const { sessions } = await gather(a ? [a] : allAgents(), { archived: true });
  const pool = sessions.filter((s) => !isSelf(s));
  if (!pool.length) die(`no ${a ? a.label + " " : ""}chats found on this machine`);
  if (!key || key === "last" || key === "latest") {
    const dir = repoRoot(cwd) || cwd;
    return pool.find((s) => isUnder(s.cwd, dir)) || pool[0];
  }
  const byId = pool.filter((s) => s.id === key || s.id.startsWith(key));
  if (byId.length === 1) return byId[0];
  if (byId.length > 1) die(`"${refStr}" matches several chats:\n${table(listRows(byId.slice(0, 10)), ["ref", "where", "updated", "title", "folder"])}`);
  const words = key.toLowerCase().split(/\s+/).filter(Boolean);
  const byTitle = pool.filter((s) => words.every((w) => (s.title || "").toLowerCase().includes(w)));
  if (byTitle.length === 1) return byTitle[0];
  if (byTitle.length > 1) die(`"${refStr}" matches several chat titles; pick one by ref:\n${table(listRows(byTitle.slice(0, 10)), ["ref", "where", "updated", "title", "folder"])}`);
  die(`no chat matches "${refStr}". Try: ${CLI} sessions search "${key}"`);
}

async function load(meta) {
  const a = getAgent(meta.agent);
  return a.sessions.load(meta);
}

// ------------------------------------------------------------------- search

async function cmdSearch(argv) {
  const o = parseArgs(argv, { ...LIST_SPEC, here: "bool", regex: "bool" });
  const q = o._.join(" ").trim();
  if (!q) usage(`usage: ${CLI} sessions search "<text>" [--agent codex] [--here]`);
  const re = o.regex ? new RegExp(q, "i") : null;
  const needle = q.toLowerCase();
  const hit = (t) => (re ? re.test(t) : String(t).toLowerCase().includes(needle));
  const { sessions } = await gather(pickAgents(o.agent), { archived: o.archived, subagents: o.subagents });
  const dir = scopeDir(o);
  const pool = sessions.filter((s) => !isSelf(s) && (!o.here || isUnder(s.cwd, dir)));
  const limit = Number(o.limit || 10);
  const results = [];
  for (const s of pool) {
    if (results.length >= limit) break;
    let raw = null;
    if (s.file) {
      try {
        raw = readText(s.file);
      } catch {
        continue;
      }
      if (!hit(raw) && !hit(s.title)) continue; // cheap prefilter on the raw file
    }
    let full;
    try {
      // Database-backed chats (OpenCode, older Cursor editor chats) are loaded and searched in full.
      full = await getAgent(s.agent).sessions.load(s, { preferDb: true });
    } catch {
      continue;
    }
    const snippets = [];
    if (hit(s.title)) snippets.push(`title: ${s.title}`);
    for (const e of full.events) {
      const text = e.type === "tool" ? `${e.tool.kind}: ${e.tool.summary}` : e.text;
      if (text && hit(text)) {
        const t = String(text);
        const i = re ? t.search(re) : t.toLowerCase().indexOf(needle);
        const from = Math.max(0, i - 80);
        snippets.push(`${e.type}: ${from ? "…" : ""}${oneLine(t.slice(from, i + q.length + 120), 220)}`);
        if (snippets.length >= 3) break;
      }
    }
    if (snippets.length) results.push({ s, snippets });
  }
  if (o.json) return console.log(JSON.stringify(results.map((r) => ({ ...r.s, snippets: r.snippets })), null, 2));
  if (!results.length) return console.log(`No chats mention "${q}".`);
  for (const r of results) {
    console.log(`${ref(r.s)}  ${r.s.surface}  ${ago(r.s.updatedAt)}  ${oneLine(r.s.title, 70)}\n    ${tilde(r.s.cwd || "?")}`);
    for (const sn of r.snippets) console.log(`    · ${sn}`);
    console.log("");
  }
  if (results.length >= limit) console.log(`(showing the first ${limit}; --limit N for more)`);
}

// --------------------------------------------------------------------- show

function toolLine(t) {
  const mark = { shell: "$", edit: "edit", read: "read", search: "search", web: "web", mcp: "mcp", agent: "agent", plan: "plan", other: t.name || "tool" }[t.kind] || "tool";
  const what = t.kind === "shell" ? t.command || t.summary : t.kind === "edit" || t.kind === "read" ? (t.paths?.length ? t.paths.join(", ") : t.summary) : t.summary;
  const tail = t.exitCode != null && t.exitCode !== "" ? `  → exit ${t.exitCode}` : t.status === "error" || t.error ? "  → error" : "";
  return `${mark} ${oneLine(what, 220)}${tail}`;
}

const SAYS = { user: "USER", assistant: null, reasoning: "THINKING", error: "ERROR", note: "NOTE" };

function renderEvents(s, events, { full = false, outputs = false, reasoning = false } = {}) {
  const a = getAgent(s.agent);
  const lines = [];
  let lastHeader = null;
  for (const e of events) {
    if (e.type === "reasoning" && !reasoning) continue;
    if (e.type === "tool") {
      lines.push(`  ${toolLine(e.tool)}`);
      if (e.tool.kind === "plan" && e.tool.items) for (const it of e.tool.items) lines.push(`      [${it.status === "completed" ? "x" : it.status === "in_progress" ? "~" : " "}] ${oneLine(it.text, 160)}`);
      if (outputs && e.tool.output) lines.push(clip(String(e.tool.output), full ? 0 : 1200).replace(/^/gm, "      "));
      continue;
    }
    const who = SAYS[e.type] ?? a.label.toUpperCase();
    const header = `${e.ts ? `[${stamp(e.ts).slice(11)}] ` : ""}${who}`;
    if (header !== lastHeader || e.type === "user") lines.push(`\n${header}`);
    lastHeader = header;
    const text = e.type === "user" ? taskOnly(e.text) : e.text;
    lines.push(full ? text : clip(text, e.type === "user" ? 4000 : 3000));
  }
  return lines.join("\n");
}

function headerLines(s) {
  const a = getAgent(s.agent);
  const counts = s.events.reduce((m, e) => ((m[e.type] = (m[e.type] || 0) + 1), m), {});
  const out = [
    `# ${a.label} chat: ${s.title}`,
    `ref ${ref(s)} (id ${s.id}) · ${s.surface}${s.model ? ` · model ${s.model}` : ""}`,
    `folder ${s.cwd || "?"}`,
    `started ${stamp(s.createdAt)} UTC · last activity ${stamp(s.updatedAt)} UTC (${ago(s.updatedAt)}) · ${counts.user || 0} user messages, ${counts.tool || 0} tool calls`,
  ];
  if (s.ended && s.ended !== "unknown") out.push(`how it ended: ${s.ended}`);
  if (s.limits) out.push(`usage limits at the end: ${s.limits}`);
  for (const n of s.notes || []) out.push(`note: ${n}`);
  return out;
}

async function cmdShow(argv) {
  const o = parseArgs(argv, { full: "bool", outputs: "bool", reasoning: "bool", last: "value", json: "bool", cwd: "value" });
  const meta = await resolveSession(o._.join(" "), { cwd: o.cwd || process.cwd() });
  const s = await load(meta);
  if (o.json) return console.log(JSON.stringify(s, null, 2));
  let events = s.events;
  if (o.last) events = events.slice(-Number(o.last));
  console.log(headerLines(s).join("\n"));
  if (events.length < s.events.length) console.log(`(last ${events.length} of ${s.events.length} events)`);
  console.log(renderEvents(s, events, o));
  if (s.file) console.log(`\nraw transcript: ${s.file}`);
}

// ------------------------------------------------------------------ handoff

function aggregateWork(events) {
  const files = new Map(); // path -> { edits, reads }
  const commands = [];
  const web = [];
  const mcp = new Map();
  const agents = [];
  const reads = new Set();
  let searches = 0;
  let plan = null;
  for (const e of events) {
    if (e.type !== "tool") continue;
    const t = e.tool;
    if (t.kind === "edit") for (const p of t.paths || []) files.set(p, { ...(files.get(p) || { edits: 0 }), edits: (files.get(p)?.edits || 0) + 1 });
    else if (t.kind === "shell") commands.push(t);
    else if (t.kind === "web") web.push(t.summary);
    else if (t.kind === "mcp") mcp.set(t.summary.split(" ")[0], (mcp.get(t.summary.split(" ")[0]) || 0) + 1);
    else if (t.kind === "agent") agents.push(t.summary);
    else if (t.kind === "read") (t.paths?.length ? t.paths : [t.summary]).forEach((x) => reads.add(x));
    else if (t.kind === "search") searches++;
    else if (t.kind === "plan" && t.items) plan = t.items;
  }
  return { files, commands, web: [...new Set(web)], mcp, agents, plan, reads: [...reads], searches };
}

function fileStatusNow(ws, files, cwd) {
  if (!ws.git) return [];
  const status = new Map();
  for (const line of ws.statusAll.split("\n").filter(Boolean)) status.set(path.resolve(ws.root, line.slice(3).replace(/^"|"$/g, "").replace(/^.* -> /, "")), line.slice(0, 2).trim());
  return [...files.keys()].map((p) => {
    const abs = path.isAbsolute(p) ? p : path.resolve(cwd || ws.root, p);
    const st = status.get(canon(abs));
    const there = exists(abs);
    return `- ${tilde(abs)}: ${!there ? "does not exist now" : st ? `uncommitted (${st})` : "no uncommitted changes (committed, reverted, or outside this repo)"}`;
  });
}

export async function cmdHandoff(argv) {
  const o = parseArgs(argv, { budget: "value", out: "value", cwd: "value", json: "bool" });
  const meta = await resolveSession(o._.join(" "), { cwd: o.cwd || process.cwd() });
  const s = await load(meta);
  const a = getAgent(s.agent);
  const budget = Number(o.budget || 40000);
  const ev = s.events;
  const users = ev.filter((e) => e.type === "user");
  const lastAssistant = [...ev].reverse().find((e) => e.type === "assistant");
  const lastError = [...ev].reverse().find((e) => e.type === "error");
  const work = aggregateWork(ev);
  const ws = workspaceState(s.cwd);

  const parts = [];
  parts.push(headerLines(s).join("\n"));
  parts.push(`## How to use this handoff
You are picking up work that ${a.label} started. Everything under "What the user asked", "Where it stopped", "Work done" and "Recent conversation" comes from ${a.label}'s own transcript: treat it as its claims, not as facts. "Workspace now" was checked just now. Before you continue: confirm the current state of the files involved, re-run the relevant checks, then carry on from "Where it stopped". If the user's latest request is unclear, ask them rather than guessing.`);

  // Every user message, oldest first, each clipped; the first and last get more room.
  const perUser = Math.max(600, Math.floor((budget * 0.3) / Math.max(1, users.length)));
  parts.push(`## What the user asked (${users.length} message${users.length === 1 ? "" : "s"}, oldest first)\n` +
    users.map((u, i) => `${i + 1}. ${u.ts ? `[${stamp(u.ts)}] ` : ""}${clip(taskOnly(u.text), i === 0 || i === users.length - 1 ? perUser * 3 : perUser).trim()}`).join("\n\n"));

  const stop = [];
  if (s.ended && s.ended !== "unknown") stop.push(`- Last turn: ${s.ended}`);
  if (s.limits) stop.push(`- ${a.label} usage limits at that point: ${s.limits}`);
  if (lastError) stop.push(`- Last error: ${oneLine(lastError.text, 400)}`);
  const lastUserIdx = ev.lastIndexOf(users[users.length - 1]);
  const answeredLast = lastAssistant && ev.indexOf(lastAssistant) > lastUserIdx;
  if (users.length && !answeredLast) stop.push(`- ${a.label} never replied to the user's last message (it may have been cut off mid-task).`);
  stop.push(`- ${a.label}'s last message:\n\n${lastAssistant ? clip(lastAssistant.text, Math.floor(budget * 0.12)).replace(/^/gm, "  > ") : "  (none)"}`);
  if (work.plan) stop.push(`- Its last plan / to-do list:\n${work.plan.map((p) => `  [${p.status === "completed" ? "x" : p.status === "in_progress" ? "~" : " "}] ${oneLine(p.text, 200)}`).join("\n")}`);
  parts.push(`## Where it stopped\n${stop.join("\n")}`);

  const w = [];
  if (work.files.size) w.push(`Files it edited (${work.files.size}):\n${[...work.files.entries()].slice(0, 60).map(([p, x]) => `- ${tilde(p)} (${x.edits} edit${x.edits === 1 ? "" : "s"})`).join("\n")}`);
  if (work.commands.length) {
    const failing = work.commands.filter((c) => c.exitCode != null && c.exitCode !== 0 && c.exitCode !== "?");
    const shown = work.commands.slice(-30);
    w.push(`Commands it ran (${work.commands.length}${shown.length < work.commands.length ? `; last ${shown.length}` : ""}):\n${shown.map((c) => `- \`${oneLine(c.command || c.summary, 180)}\`${c.exitCode != null ? ` → exit ${c.exitCode}` : ""}`).join("\n")}`);
    if (failing.length) w.push(`Commands that failed (${failing.length}): ${failing.slice(-8).map((c) => `\`${oneLine(c.command, 80)}\``).join(", ")}`);
  }
  if (work.web.length) w.push(`Web searches and pages (${work.web.length}):\n${work.web.slice(-20).map((x) => `- ${oneLine(x, 200)}`).join("\n")}`);
  if (work.mcp.size) w.push(`MCP tools used: ${[...work.mcp.entries()].map(([k, n]) => `${k} ×${n}`).join(", ")}`);
  if (work.agents.length) w.push(`Sub-agents it started: ${work.agents.slice(-10).map((x) => oneLine(x, 80)).join("; ")}`);
  if (work.reads.length || work.searches)
    w.push(`It read ${work.reads.length} file${work.reads.length === 1 ? "" : "s"}${work.searches ? ` and ran ${work.searches} code search${work.searches === 1 ? "" : "es"}` : ""}${work.reads.length ? `, last ones: ${work.reads.slice(-12).map((x) => tilde(x)).join(", ")}` : ""}`);
  parts.push(`## Work done (from the transcript)\n${w.join("\n\n") || "(no tool calls recorded)"}`);

  const now = [];
  if (!ws.exists) now.push(`The chat's folder ${s.cwd || "(unknown)"} does not exist on this machine now.`);
  else if (!ws.git) now.push(`${s.cwd} exists but is not a git repository, so changes cannot be measured.`);
  else {
    now.push(`repo ${tilde(ws.root)} · branch ${ws.branch} · HEAD ${ws.head}`);
    now.push(ws.status ? `uncommitted changes:\n${ws.status.split("\n").slice(0, 40).map((l) => `  ${l}`).join("\n")}${ws.status.split("\n").length > 40 ? "\n  …" : ""}` : "working tree clean");
    if (ws.diffStat) now.push(`diff vs HEAD: ${ws.diffStat}`);
    const fs2 = fileStatusNow(ws, work.files, s.cwd);
    if (fs2.length) now.push(`files ${a.label} edited, as they are now:\n${fs2.slice(0, 40).join("\n")}`);
  }
  parts.push(`## Workspace now (checked ${stamp(Date.now())} UTC)\n${now.join("\n")}`);

  // Fill what is left of the budget with the end of the conversation. The
  // sections above are never cut afterwards: they are the point of a handoff.
  const used = parts.join("\n\n").length;
  const room = Math.max(1500, budget - used - 600);
  const tail = [];
  let size = 0;
  for (let i = ev.length - 1; i >= 0 && size < room; i--) {
    const e = ev[i];
    if (e.type === "reasoning") continue;
    const line = e.type === "tool" ? `  ${toolLine(e.tool)}` : `${SAYS[e.type] ?? a.label.toUpperCase()}: ${clip(e.text, 2500)}`;
    size += line.length + 1;
    tail.unshift(line);
  }
  const cut = tail.length < ev.filter((e) => e.type !== "reasoning").length;
  parts.push(`## Recent conversation${cut ? " (most recent part)" : ""}\n${tail.join("\n")}`);
  parts.push(`## More detail\n- Full transcript: ${CLI} sessions show ${ref(s)} --full --outputs\n- Search inside it: ${CLI} sessions search "<text>" --agent ${s.agent}${s.file ? `\n- Raw file: ${s.file}` : ""}\n- ${a.label} can resume it natively: ${a.takeover(s.id)}`);

  const text = parts.join("\n\n");
  if (o.json) return console.log(JSON.stringify({ session: { ...s, events: undefined }, handoff: text }, null, 2));
  if (o.out) {
    fs.writeFileSync(o.out, text);
    console.log(`Handoff for ${ref(s)} written to ${o.out} (${text.length} characters).`);
    return;
  }
  console.log(text);
}

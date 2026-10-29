// Pieces shared by the agent adapters: tool classification, desktop app
// detection, and the normalized session shape every reader produces.
//
// A session, as readers return it:
//   { agent, id, title, cwd, surface, createdAt, updatedAt, model, file,
//     events: [ { ts, type, text, tool } ], ended, limits, notes }
// event.type: user | assistant | reasoning | tool | error | note
// event.tool: { kind, name, summary, command, paths, output, exitCode, status, error }
// tool.kind:  shell | edit | read | search | web | mcp | agent | plan | other

import fs from "node:fs";
import path from "node:path";
import { home, exists, oneLine, canon } from "../util.mjs";

const KINDS = [
  [/^(bash|shell|powershell|run_terminal_cmd|exec|exec_command|local_shell|awaitshell|command)$/i, "shell"],
  [/^(edit|multiedit|write|strreplace|str_replace|applypatch|apply_patch|notebookedit|editnotebook|delete|delete_file|search_replace|create_file|edit_file|patch)$/i, "edit"],
  [/^(read|readfile|read_file|view|imageview|cat|list|ls|list_dir)$/i, "read"],
  [/^(grep|glob|codebase_search|file_search|grep_search|search|find)$/i, "search"],
  [/^(websearch|webfetch|web_search|web_fetch|fetch|browse)$/i, "web"],
  [/^(task|agent|subagent|spawn_agent)$/i, "agent"],
  [/^(todowrite|todo|update_plan|createplan|updatecurrentstep|exitplanmode)$/i, "plan"],
];

export function toolKind(name = "") {
  if (/^mcp__|^mcp[:.]|calldynamictool/i.test(name)) return "mcp";
  for (const [re, kind] of KINDS) if (re.test(name)) return kind;
  return "other";
}

const pick = (o, ...keys) => {
  for (const k of keys) if (o && o[k] != null && o[k] !== "") return o[k];
  return null;
};

// Turn a tool call (name + input object) into a normalized tool record.
export function describeTool(name, input = {}) {
  const kind = toolKind(name);
  const i = typeof input === "string" ? { raw: input } : input || {};
  const t = { kind, name, paths: [] };
  switch (kind) {
    case "shell": {
      const c = pick(i, "command", "cmd", "raw");
      t.command = Array.isArray(c) ? c.join(" ") : c;
      t.summary = t.command;
      break;
    }
    case "edit":
    case "read": {
      const p = pick(i, "file_path", "path", "target_file", "notebook_path", "filePath");
      if (p) t.paths.push(p);
      if (!p && typeof i.raw === "string") t.paths.push(...patchPaths(i.raw));
      t.summary = t.paths.join(", ") || oneLine(JSON.stringify(i), 100);
      break;
    }
    case "search":
      t.summary = [pick(i, "pattern", "query", "glob_pattern", "globPattern"), pick(i, "path", "target_directory")].filter(Boolean).join(" in ");
      break;
    case "web":
      t.summary = pick(i, "url", "query", "search_term", "q") || oneLine(JSON.stringify(i), 100);
      break;
    case "mcp": {
      const tool = pick(i, "toolName", "tool");
      t.summary = [pick(i, "namespace", "server"), tool].filter(Boolean).join(".") || name;
      break;
    }
    case "agent":
      t.summary = pick(i, "description", "prompt") || name;
      break;
    case "plan": {
      const items = i.todos || i.plan || i.steps || i.items;
      if (Array.isArray(items))
        t.items = items.map((x) => (typeof x === "string" ? { text: x } : { text: x.content || x.step || x.text || x.title || "", status: x.status || (x.completed ? "completed" : "") }));
      t.summary = t.items ? `${t.items.length} item plan` : oneLine(JSON.stringify(i), 120);
      break;
    }
    default:
      t.summary = oneLine(typeof i.raw === "string" ? i.raw : JSON.stringify(i), 120);
  }
  t.summary = oneLine(t.summary || name, 200);
  return t;
}

// File paths named in an apply_patch / unified diff body.
export function patchPaths(text) {
  const out = new Set();
  for (const m of String(text).matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) out.add(m[1].trim());
  for (const m of String(text).matchAll(/^\+\+\+ b\/(.+)$/gm)) out.add(m[1].trim());
  return [...out];
}

// macOS: /Applications or ~/Applications. Linux/Windows: best-effort config folders.
export function desktopApp(appNames, linuxHints = []) {
  for (const n of appNames) {
    for (const dir of ["/Applications", home("Applications")]) {
      const p = path.join(dir, n);
      if (exists(p)) return p;
    }
  }
  if (process.platform !== "darwin") {
    for (const h of linuxHints) if (exists(h)) return h;
  }
  return null;
}

// Pull plain text out of message content in its usual shapes.
export function textOf(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((c) => (typeof c === "string" ? c : /^(text|input_text|output_text)$/i.test(c?.type || "") ? c.text : ""))
      .filter(Boolean)
      .join("\n");
  if (typeof content === "object" && typeof content.text === "string") return content.text;
  return "";
}

// "Users-arpit-projects-my-app" -> "/Users/arpit/projects/my-app", by walking
// the filesystem: each "-" is either a path separator or a literal "-" (or a
// dropped "."), and only the reading that exists on disk is kept.
const slugCache = new Map();
export function decodeSlug(slug) {
  if (slugCache.has(slug)) return slugCache.get(slug);
  const parts = slug.replace(/^-+/, "").split("-").filter((p) => p !== "");
  let found = null;
  const go = (dir, i) => {
    if (found) return;
    if (i >= parts.length) {
      found = dir;
      return;
    }
    for (let j = i + 1; j <= parts.length && !found; j++) {
      const word = parts.slice(i, j).join("-");
      for (const name of [word, `.${word}`, parts.slice(i, j).join(".")]) {
        const p = path.join(dir, name);
        if (fs.existsSync(p)) go(p, j);
        if (found) break;
      }
    }
  };
  go("/", 0);
  slugCache.set(slug, found);
  return found;
}

// A title from a chat's first message. Chats that were themselves delegated
// jobs (Switchboard or cursor-bridge) start with a long preamble; use the task.
export function titleFrom(text, n = 80) {
  let t = String(text || "");
  const task = t.indexOf("--- TASK ---");
  if (task >= 0) t = `[sub-agent job] ${t.slice(task + 12).trim().replace(/^Goal:\s*/i, "")}`;
  else if (/^You are an adversarial code reviewer/.test(t)) t = "[sub-agent review] adversarial code review";
  return oneLine(t, n);
}

export function isUnder(child, parent) {
  if (!child || !parent) return false;
  const rel = path.relative(canon(parent), canon(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function userTextIsNoise(t) {
  const s = String(t || "").trimStart();
  return (
    !s ||
    /^<(environment_context|user_instructions|permissions instructions|system-reminder|local-command-stdout|local-command-stderr|command-message|ide_opened_file|ide_selection|turn_aborted)\b/i.test(s) ||
    /^# AGENTS\.md instructions/i.test(s) ||
    /^Caveat: The messages below were generated/i.test(s)
  );
}

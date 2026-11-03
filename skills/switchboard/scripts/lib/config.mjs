// Where Switchboard keeps its state, and the per-agent model policy.
//
// ~/.switchboard/config.json (override the folder with SWITCHBOARD_HOME):
// {
//   "agents": {
//     "cursor": { "model": "grok:latest", "effort": "high", "chooseModel": false, "deny": ["*-fast"] },
//     "claude": { "model": "sonnet", "allow": ["sonnet", "haiku"] }
//   }
// }
//
// Policy keys, per agent (all optional):
//   enabled       false: never use this agent as a sub-agent
//   model         default model: an id, or "<family>:latest" for the newest of a family
//   effort        default effort (low|medium|high|xhigh|max, as the agent supports)
//   chooseModel   false: the orchestrating agent may not pick a model; the default always runs
//   chooseEffort  false: the orchestrating agent may not pick an effort
//   allow         model patterns the orchestrator may use (glob, "*" wildcard); empty = any
//   deny          model patterns that never run, even if allowed (e.g. "*-fast", "opus*")
//   efforts       efforts the orchestrator may use; empty = any the agent supports
//   timeout       seconds before a job is stopped (default 1800)
//   bin           path to the agent's CLI if it is not on PATH

import fs from "node:fs";
import path from "node:path";
import { home, readJSON, writeJSON, isTrue } from "./util.mjs";

export const VERSION = "0.1.0";
export const SB_HOME = process.env.SWITCHBOARD_HOME || home(".switchboard");
export const JOBS = path.join(SB_HOME, "jobs");
export const CONFIG_FILE = path.join(SB_HOME, "config.json");

export const POLICY_KEYS = {
  enabled: "bool",
  model: "string",
  effort: "string",
  chooseModel: "bool",
  chooseEffort: "bool",
  allow: "list",
  deny: "list",
  efforts: "list",
  timeout: "number",
  bin: "string",
};

// Defaults favour "don't spend the expensive model on small work": Claude Code
// as a sub-agent runs Sonnet unless the user or orchestrator says otherwise.
const DEFAULTS = {
  claude: { model: "sonnet", effort: "medium" },
  codex: {},
  cursor: {},
  opencode: {},
};

let cached = null;
let readOnly = false;

// For `install --dry-run`: use the config, never write it.
export function setReadOnly() {
  readOnly = true;
}

export function loadConfig() {
  if (cached) return cached;
  let cfg = readJSON(CONFIG_FILE, null);
  if (!cfg) {
    cfg = { agents: {} };
    const imported = importCursorBridge();
    if (imported) {
      cfg.agents.cursor = imported;
      cfg.importedFrom = "~/.cursor-bridge/config.json";
      if (!readOnly) try {
        writeJSON(CONFIG_FILE, cfg);
        process.stderr.write("switchboard: imported your Cursor model policy from ~/.cursor-bridge/config.json\n");
      } catch {}
    }
  }
  cfg.agents ||= {};
  cached = cfg;
  return cfg;
}

export function saveConfig(cfg) {
  writeJSON(CONFIG_FILE, cfg);
  cached = cfg;
}

export function policyFor(agent) {
  const cfg = loadConfig();
  const p = { ...(DEFAULTS[agent] || {}), ...(cfg.agents[agent] || {}) };
  return {
    enabled: p.enabled === undefined ? true : isTrue(p.enabled),
    model: p.model || null,
    effort: p.effort || null,
    chooseModel: p.chooseModel === undefined ? true : isTrue(p.chooseModel),
    chooseEffort: p.chooseEffort === undefined ? true : isTrue(p.chooseEffort),
    allow: p.allow || [],
    deny: p.deny || [],
    efforts: p.efforts || [],
    timeout: Number(p.timeout || 1800),
    bin: p.bin || null,
  };
}

// The cursor-bridge plugin (this project's predecessor) kept its policy in
// ~/.cursor-bridge/config.json. Carry it over so an existing lock keeps holding.
function importCursorBridge() {
  const file = path.join(process.env.CURSOR_BRIDGE_HOME || home(".cursor-bridge"), "config.json");
  if (!fs.existsSync(file)) return null;
  const old = readJSON(file, null);
  if (!old) return null;
  const p = {};
  if (old.model) p.model = old.model;
  if (old.effort) p.effort = old.effort;
  if (isTrue(old.lockModel)) p.chooseModel = false;
  if (old.allowFast !== undefined && !isTrue(old.allowFast)) p.deny = ["*-fast"];
  if (old.timeout) p.timeout = Number(old.timeout);
  if (old.agentBin) p.bin = old.agentBin;
  return Object.keys(p).length ? p : null;
}

export function setPolicy(agent, key, values) {
  const kind = POLICY_KEYS[key];
  const cfg = loadConfig();
  const cur = (cfg.agents[agent] ||= {});
  if (kind === "list") cur[key] = values.flatMap((v) => v.split(",")).map((v) => v.trim()).filter(Boolean);
  else if (kind === "bool") cur[key] = isTrue(values[0]);
  else if (kind === "number") cur[key] = Number(values[0]);
  else cur[key] = values.join(" ");
  saveConfig(cfg);
  return cur;
}

export function unsetPolicy(agent, key) {
  const cfg = loadConfig();
  if (cfg.agents[agent]) delete cfg.agents[agent][key];
  saveConfig(cfg);
  return cfg.agents[agent] || {};
}

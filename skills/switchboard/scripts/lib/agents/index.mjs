import claude from "./claude.mjs";
import codex from "./codex.mjs";
import cursor from "./cursor.mjs";
import opencode from "./opencode.mjs";
import antigravity from "./antigravity.mjs";

const AGENTS = { claude, codex, cursor, opencode, antigravity };

// Short names people (and agents) actually type.
const ALIASES = { "claude-code": "claude", cc: "claude", "cursor-agent": "cursor", agent: "cursor", oc: "opencode", "open-code": "opencode", agy: "antigravity", ag: "antigravity", "anti-gravity": "antigravity" };

export function agent(name) {
  if (!name) return null;
  const n = String(name).toLowerCase();
  return AGENTS[n] || AGENTS[ALIASES[n]] || null;
}

export function agentNames() {
  return Object.keys(AGENTS);
}

export function allAgents() {
  return Object.values(AGENTS);
}

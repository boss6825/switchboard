#!/usr/bin/env node
// Switchboard: let coding agents on one machine read each other's chats and
// use each other as sub-agents. Claude Code, Codex, Cursor, and OpenCode.
//
// Zero dependencies. Node 18+ (Node 22.13+ reads Cursor's and OpenCode's
// databases without the sqlite3 command). State lives in ~/.switchboard
// (override with SWITCHBOARD_HOME).

import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { VERSION, SB_HOME, JOBS, POLICY_KEYS, loadConfig, setPolicy, unsetPolicy } from "./lib/config.mjs";
import { describePolicy } from "./lib/policy.mjs";
import { agent as getAgent, allAgents, agentNames } from "./lib/agents/index.mjs";
import { SbError, die, parseArgs } from "./lib/util.mjs";
import * as jobs from "./lib/jobs.mjs";
import { cmdSessions, cmdHandoff } from "./lib/sessions.mjs";
import { cmdDoctor, cmdInstall, cmdUninstall } from "./lib/install.mjs";

jobs.setScript(fs.realpathSync(fileURLToPath(import.meta.url)));

const HELP = `switchboard ${VERSION} — your coding agents, working as one team

Read other agents' chats (and continue them):
  sessions [--agent codex] [--all] [--limit N]     Recent chats, this folder first
  sessions search "<text>" [--agent a] [--here]    Find chats that mention something
  sessions show <ref> [--full] [--outputs] [--last N]   Read one chat
  handoff <ref> [--budget 40000] [--out file]      Brief for continuing a chat: what was
                                                   asked, where it stopped, what it changed,
                                                   and the workspace as it is now
  <ref> is agent:last, agent:<id-prefix>, or words from the title (e.g. codex:last)

Use another agent as a sub-agent (background jobs):
  run <agent> [options] <task>     Start a job; task from args, --prompt-file, or stdin
      --mode write|ask             write (default) may edit files and run commands; ask is read-only
      --model <id>                 Only if the user's policy lets you choose (see: policy)
      --effort <level>             low|medium|high|xhigh|max (what the agent supports)
      --worktree                   Run in a fresh git worktree (safe for parallel writers)
      --wait                       Block until done (up to --wait-timeout secs, default 540)
      --timeout <secs>             Stop the job after this long (default 1800)
  review <agent> [--base <ref>] [focus]   Read-only adversarial review of the current diff
  resume <job> <follow-up>         Continue a finished job's session
  status [job] [--all] · wait [job...] [--any] · tail <job> [-f] · result [job...] · cancel <job>|--all
  models <agent> [filter] [--refresh]     Models the agent offers on your plan
  cleanup [--days N]               Delete old job records

Model policy (what sub-agents may run):
  policy                           Show every agent's policy
  policy set <agent> <key> <value...>   keys: ${Object.keys(POLICY_KEYS).join(", ")}
  policy unset <agent> <key>
  Examples:  policy set cursor model grok:latest      (always the newest Grok)
             policy set cursor chooseModel false       (orchestrator picks effort only)
             policy set claude allow sonnet haiku      (never Opus as a sub-agent)
             policy set cursor deny "*-fast"

Setup:
  doctor [--json]                  Which agents are installed, logged in, and where their chats are
  install [--agents a,b] [--dry-run]   Install the skill for every agent found on this machine
  uninstall [--purge]

Agents: ${agentNames().join(", ")}   ·   State: ${SB_HOME}`;

function cmdPolicy(argv) {
  const [action, name, key, ...values] = argv;
  if (!action || action === "show") {
    const cfg = loadConfig();
    for (const a of allAgents()) console.log(`${a.label.padEnd(12)} ${describePolicy(a)}`);
    if (cfg.importedFrom) console.log(`\n(Cursor policy was imported from ${cfg.importedFrom})`);
    return;
  }
  const a = getAgent(name) || die(`unknown agent "${name}"; one of: ${agentNames().join(", ")}`);
  if (!POLICY_KEYS[key]) die(`policy key must be one of: ${Object.keys(POLICY_KEYS).join(", ")}`);
  if (action === "set") {
    if (!values.length) die(`usage: policy set ${a.name} ${key} <value>`);
    if (key === "effort" && a.efforts && !a.efforts.includes(values[0])) die(`${a.label} effort must be one of ${a.efforts.join(", ")}`);
    setPolicy(a.name, key, values);
  } else if (action === "unset") unsetPolicy(a.name, key);
  else die("usage: policy [show] | policy set <agent> <key> <value...> | policy unset <agent> <key>");
  console.log(`${a.label}: ${describePolicy(a)}`);
}

function cmdModels(argv) {
  const o = parseArgs(argv, { refresh: "bool" });
  const a = getAgent(o._.shift()) || die(`usage: models <agent> [filter]; agents: ${agentNames().join(", ")}`);
  const filter = o._.join(" ").toLowerCase();
  const ids = a.listModels({ refresh: o.refresh || true });
  if (!ids.length) return console.log(`${a.label} did not report a model list.`);
  console.log(ids.filter((id) => !filter || id.toLowerCase().includes(filter)).join("\n"));
  if (a.name === "claude") console.log("(Claude Code also accepts full model ids such as claude-sonnet-5-5.)");
}

const COMMANDS = {
  sessions: cmdSessions,
  chats: cmdSessions,
  handoff: cmdHandoff,
  run: jobs.cmdRun,
  delegate: jobs.cmdRun,
  review: jobs.cmdReview,
  resume: jobs.cmdResume,
  status: jobs.cmdStatus,
  wait: jobs.cmdWait,
  tail: jobs.cmdTail,
  result: jobs.cmdResult,
  cancel: jobs.cmdCancel,
  cleanup: jobs.cmdCleanup,
  models: cmdModels,
  policy: cmdPolicy,
  doctor: cmdDoctor,
  install: cmdInstall,
  uninstall: cmdUninstall,
  __supervise: jobs.cmdSupervise,
};

const [cmd, ...rest] = process.argv.slice(2);
try {
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") console.log(HELP);
  else if (cmd === "--version" || cmd === "version") console.log(VERSION);
  else if (!COMMANDS[cmd]) die(`unknown command "${cmd}". Run: switchboard --help`);
  else {
    fs.mkdirSync(JOBS, { recursive: true });
    await COMMANDS[cmd](rest);
  }
} catch (e) {
  if (e instanceof SbError) {
    process.stderr.write(`switchboard: ${e.message}\n`);
    process.exit(1);
  }
  throw e;
}

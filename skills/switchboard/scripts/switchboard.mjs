#!/usr/bin/env node
// Switchboard: let coding agents on one machine read each other's chats and
// use each other as sub-agents. Claude Code, Codex, Cursor, and OpenCode.
//
// Zero dependencies. Node 18+ (Node 22.13+ reads Cursor's and OpenCode's
// databases without the sqlite3 command). State lives in ~/.switchboard
// (override with SWITCHBOARD_HOME).

import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { VERSION, JOBS, POLICY_KEYS, SPEND, loadConfig, setPolicy, unsetPolicy, setReadOnly, setSpend } from "./lib/config.mjs";
import { describePolicy } from "./lib/policy.mjs";
import { agent as getAgent, allAgents, agentNames } from "./lib/agents/index.mjs";
import { SbError, UsageError, die, usage, parseArgs, CLI } from "./lib/util.mjs";
import { overview, commandHelp, fullHelp, canonical, suggest } from "./lib/help.mjs";
import { red } from "./lib/ui.mjs";
import * as jobs from "./lib/jobs.mjs";
import { cmdSessions, cmdHandoff } from "./lib/sessions.mjs";
import { cmdDoctor, cmdInstall, cmdUninstall } from "./lib/install.mjs";

jobs.setScript(fs.realpathSync(fileURLToPath(import.meta.url)));

function cmdPolicy(argv) {
  const [action, name, key, ...values] = argv;
  if (!action || action === "show") {
    const cfg = loadConfig();
    for (const a of allAgents()) console.log(`${a.label.padEnd(12)} ${describePolicy(a)}`);
    if (cfg.importedFrom) console.log(`\n(Cursor policy was imported from ${cfg.importedFrom})`);
    return;
  }
  if (action === "spend") {
    if (!SPEND.includes(name)) usage(`usage: policy spend ${SPEND.join("|")}`);
    setSpend(name);
    for (const a of allAgents()) console.log(`${a.label.padEnd(12)} ${describePolicy(a)}`);
    return;
  }
  const a = getAgent(name) || die(`unknown agent "${name}"; one of: ${agentNames().join(", ")}`);
  if (!POLICY_KEYS[key]) die(`policy key must be one of: ${Object.keys(POLICY_KEYS).join(", ")}`);
  if (action === "set") {
    if (!values.length) usage(`usage: policy set ${a.name} ${key} <value>`);
    if (key === "effort" && a.efforts && !a.efforts.includes(values[0])) die(`${a.label} effort must be one of ${a.efforts.join(", ")}`);
    setPolicy(a.name, key, values);
  } else if (action === "unset") unsetPolicy(a.name, key);
  else usage("usage: policy [show] | policy set <agent> <key> <value...> | policy unset <agent> <key>");
  console.log(`${a.label}: ${describePolicy(a)}`);
}

function cmdModels(argv) {
  const o = parseArgs(argv, { refresh: "bool" });
  const a = getAgent(o._.shift()) || usage(`usage: models <agent> [filter]; agents: ${agentNames().join(", ")}`);
  const filter = o._.join(" ").toLowerCase();
  const ids = a.listModels({ refresh: !!o.refresh });
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

// --help / -h anywhere before a "--" asks for help (a task text is one argument, so it rarely collides).
const wantsHelp = (argv) => {
  const end = argv.indexOf("--");
  return (end < 0 ? argv : argv.slice(0, end)).some((a) => a === "--help" || a === "-h");
};

function cmdHelp(argv) {
  if (argv.includes("--all")) return console.log(fullHelp());
  if (!argv[0]) return console.log(overview());
  const name = canonical(argv[0]);
  if (!name) unknownCommand(argv[0]);
  console.log(commandHelp(name));
}

function unknownCommand(input) {
  const near = suggest(input);
  throw new UsageError(`unknown command "${input}"${near ? `. Did you mean "${near}"?` : ""}\nRun: ${CLI} --help`);
}

const [cmd, ...rest] = process.argv.slice(2);
try {
  if (!cmd || cmd === "--help" || cmd === "-h") cmdHelp(rest);
  else if (cmd === "help") cmdHelp(rest);
  else if (cmd === "--version" || cmd === "-v" || cmd === "-V" || cmd === "version") console.log(VERSION);
  else if (!COMMANDS[cmd]) unknownCommand(cmd);
  else if (cmd !== "__supervise" && wantsHelp(rest)) console.log(commandHelp(canonical(cmd)));
  else {
    // A dry run promises to write nothing, Switchboard's own state included.
    if (cmd === "install" && rest.includes("--dry-run")) setReadOnly();
    else fs.mkdirSync(JOBS, { recursive: true });
    await COMMANDS[cmd](rest);
  }
} catch (e) {
  if (e instanceof SbError) {
    const name = canonical(cmd);
    const hint = e instanceof UsageError && name && !e.message.includes("--help") ? `\nRun: ${CLI} ${name} --help` : "";
    process.stderr.write(`${red("switchboard:", process.stderr)} ${e.message}${hint}\n`);
    process.exit(e instanceof UsageError ? 2 : 1);
  }
  throw e;
}

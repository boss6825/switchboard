// Help text: a short overview, one page per command, and `help --all` for
// everything at once (what agents read). Plain text unless a person is looking.

import { VERSION, SB_HOME, POLICY_KEYS } from "./config.mjs";
import { agentNames } from "./agents/index.mjs";
import { bold, cyan, dim } from "./ui.mjs";
import { CLI } from "./util.mjs";

const REF = "<ref> is agent:last, agent:<id-prefix>, or words from the title (e.g. codex:last)";
const JOB = "<job> is a job id, or last for the newest job";

const RUN_OPTIONS = [
  ["--mode write|ask", "write (default) may edit files and run commands; ask is read-only"],
  ["--model <id>", `Only if the user's policy lets you choose (see: ${CLI} policy)`],
  ["--effort <level>", "low|medium|high|xhigh|max (what the agent supports)"],
  ["--worktree", "Run in a fresh git worktree (safe for parallel writers)"],
  ["--worktree-base <ref>", "Start the worktree from this ref instead of HEAD"],
  ["--cwd <dir>", "Run in this folder instead of the current one"],
  ["--add-dir <dir>", "Also give the agent access to this folder (repeatable)"],
  ["--prompt-file <file>", "Read the task from a file"],
  ["--name <text>", "A short name for the job in status lists"],
  ["--wait", "Block until done (up to --wait-timeout secs, default 540)"],
  ["--wait-timeout <secs>", "How long --wait blocks"],
  ["--timeout <secs>", "Stop the job after this long (default 1800)"],
  ["--allow-concurrent", "Start even if another write job runs here (tasks touch different files)"],
  ["--raw", "Send the task without the standard sub-agent rules (advanced)"],
  ["--json", "Print the job record as JSON"],
];

const LIST_OPTIONS = [
  ["--agent <a[,b]>", "Only these agents"],
  ["--all", "Every folder, not just this one"],
  ["--cwd <dir>", "Treat this folder as the current one"],
  ["--limit <n>", "How many to show (default 15)"],
  ["--archived", "Include archived chats"],
  ["--subagents", "Include the agents' own sub-agent chats"],
  ["--json", "Print as JSON"],
];

// group: the heading it sits under in the overview. aliases: other names that run it.
// Examples leave out the command name; it is added when printed (sw or switchboard).
export const COMMANDS = {
  sessions: {
    group: "chats",
    aliases: ["chats"],
    summary: "List recent chats, search them, or read one",
    usage: ["sessions [list] [options]", 'sessions search "<text>" [options]', "sessions show <ref> [options]"],
    sections: [
      ["Options for list", LIST_OPTIONS],
      ["Options for search (plus the list options)", [["--here", "Only chats in this folder"], ["--regex", "Treat the text as a regular expression"]]],
      [
        "Options for show",
        [
          ["--full", "Do not shorten long messages or outputs"],
          ["--outputs", "Include tool outputs"],
          ["--reasoning", "Include the agent's reasoning, where stored"],
          ["--last <n>", "Only the last n messages"],
          ["--json", "Print as JSON"],
        ],
      ],
    ],
    notes: [REF],
    examples: [
      ["sessions", "Chats in this folder, newest first"],
      ["sessions --agent codex --all", "Every Codex chat"],
      ['sessions search "rate limit"', "Chats that mention it"],
      ["sessions show cursor:last --outputs", "Read the latest Cursor chat"],
    ],
  },
  handoff: {
    group: "chats",
    summary: "Brief for continuing another agent's chat",
    usage: ["handoff <ref> [options]"],
    description: "What was asked, where it stopped, what it changed, and the workspace as it is now.",
    sections: [
      [
        "Options",
        [
          ["--budget <chars>", "Size limit for the brief (default 40000)"],
          ["--out <file>", "Write the brief to a file"],
          ["--cwd <dir>", "Describe the workspace in this folder"],
          ["--json", "Print as JSON"],
        ],
      ],
    ],
    notes: [REF],
    examples: [["handoff codex:last", "Pick up the latest Codex chat"]],
  },
  run: {
    group: "jobs",
    aliases: ["delegate"],
    summary: "Start a background job with another agent",
    usage: ["run <agent> [options] <task>"],
    description: "The task comes from the arguments, --prompt-file, or stdin.",
    sections: [["Options", RUN_OPTIONS]],
    examples: [
      ['run codex "add tests for lib/git.mjs"'],
      ['run cursor --mode ask --wait "why does login fail?"', "Read-only, wait for the answer"],
      ["run claude --worktree --prompt-file task.md", "Parallel-safe writer"],
    ],
  },
  review: {
    group: "jobs",
    summary: "Read-only adversarial review of the current diff",
    usage: ["review <agent> [--base <ref>] [options] [focus]"],
    description: "Reviews uncommitted changes, or the branch since --base (default: the default branch).",
    sections: [
      [
        "Options",
        [["--base <ref>", "Review the branch changes since this ref"], ...RUN_OPTIONS.filter(([f]) => /^--(model|effort|wait|wait-timeout|timeout|name|json)\b/.test(f))],
      ],
    ],
    examples: [["review codex --wait", "Review uncommitted work"], ['review cursor --base main "focus on error handling"']],
  },
  resume: {
    group: "jobs",
    summary: "Continue a finished job's session",
    usage: ["resume <job> <follow-up> [options]"],
    description: "Takes the same options as run.",
    notes: [JOB],
    examples: [['resume last "also update the README"']],
  },
  status: {
    group: "jobs",
    summary: "Show running and recent jobs",
    usage: ["status [job] [options]"],
    sections: [
      [
        "Options",
        [
          ["--all", "Jobs from every repository"],
          ["--limit <n>", "How many recent jobs (default 10)"],
          ["--json", "Print as JSON"],
        ],
      ],
    ],
    notes: [JOB],
  },
  wait: {
    group: "jobs",
    summary: "Block until jobs finish",
    usage: ["wait [job...] [options]"],
    sections: [
      [
        "Options",
        [
          ["--any", "Return when the first one finishes"],
          ["--timeout <secs>", "Give up waiting after this long (default 540)"],
          ["--interval <secs>", "Progress line every n seconds (default 20)"],
          ["--quiet", "No progress lines"],
        ],
      ],
    ],
    notes: [JOB],
  },
  tail: {
    group: "jobs",
    summary: "Show a job's live activity",
    usage: ["tail <job> [options]"],
    sections: [
      [
        "Options",
        [
          ["-n, --lines <n>", "How many lines (default 40)"],
          ["-f, --follow", "Keep printing new activity"],
        ],
      ],
    ],
    notes: [JOB],
  },
  result: {
    group: "jobs",
    summary: "Read a finished job's output",
    usage: ["result [job...] [options]"],
    description: "The answer, the files it changed (measured with git), and the commands it ran.",
    sections: [
      [
        "Options",
        [
          ["--full", "List every command it ran, not just the last 15"],
          ["--json", "Print as JSON"],
        ],
      ],
    ],
    notes: [JOB],
  },
  cancel: {
    group: "jobs",
    summary: "Stop a job",
    usage: ["cancel <job>", "cancel --all"],
    sections: [["Options", [["--all", "Every running job in this repository"]]]],
  },
  models: {
    group: "jobs",
    summary: "List the models an agent offers on your plan",
    usage: ["models <agent> [filter] [--refresh]"],
    sections: [["Options", [["--refresh", "Ask the agent again instead of using the cached list"]]]],
    examples: [["models cursor grok"]],
  },
  cleanup: {
    group: "jobs",
    summary: "Delete old job records",
    usage: ["cleanup [--days <n>]"],
    sections: [["Options", [["--days <n>", "Delete finished jobs older than this (default 7)"]]]],
  },
  policy: {
    group: "policy",
    summary: "Show or change what sub-agents may run",
    usage: ["policy", "policy set <agent> <key> <value...>", "policy unset <agent> <key>", "policy spend included|any"],
    description: "spend included (the install default) allows only free or plan-included models.",
    get sections() {
      return [["Keys", [[Object.keys(POLICY_KEYS).join(", "), ""]]]];
    },
    examples: [
      ["policy set cursor model grok:latest", "Always the newest Grok"],
      ["policy set cursor chooseModel false", "Orchestrator picks effort only"],
      ["policy set claude allow sonnet haiku", "Never Opus as a sub-agent"],
      ['policy set cursor deny "*-fast"'],
    ],
  },
  doctor: {
    group: "setup",
    summary: "Check which agents are installed and logged in",
    usage: ["doctor [options]"],
    description: "Also shows where each agent keeps its chats. Exits 1 if an agent needs attention.",
    sections: [
      [
        "Options",
        [
          ["--json", "Print as JSON"],
          ["--no-auth", "Skip the login checks"],
        ],
      ],
    ],
  },
  install: {
    group: "setup",
    summary: "Install the skill for every agent on this machine",
    usage: ["install [options]"],
    sections: [
      [
        "Options",
        [
          ["--agents <a,b>", "Only these agents"],
          ["--spend included|any", "Whether sub-agents may use paid models"],
          ["--dry-run", "Show what it would do; write nothing"],
          ["--force", "Replace skill folders Switchboard did not create"],
          ["--no-shim", "Do not add the switchboard and sw commands to ~/.local/bin"],
        ],
      ],
    ],
  },
  uninstall: {
    group: "setup",
    summary: "Remove what install added",
    usage: ["uninstall [--purge]"],
    sections: [["Options", [["--purge", "Also delete the state folder (config and job records)"]]]],
  },
};

const GROUPS = [
  ["chats", "Read and continue other agents' chats"],
  ["jobs", "Use another agent as a sub-agent"],
  ["policy", "Model policy"],
  ["setup", "Setup"],
];

// Name -> canonical command, aliases included.
export function canonical(name) {
  if (COMMANDS[name]) return name;
  return Object.keys(COMMANDS).find((k) => COMMANDS[k].aliases?.includes(name)) || null;
}

function columns(rows, indent = 2, w = Math.max(...rows.map(([a]) => a.length))) {
  return rows.map(([a, b]) => `${" ".repeat(indent)}${cyan(a)}${b ? " ".repeat(w - a.length + 2) + b : ""}`).join("\n");
}

const footer = () => dim(`Agents: ${agentNames().join(", ")}   ·   State: ${SB_HOME}`);

export function overview() {
  const out = [`${bold("switchboard")} ${VERSION} — your coding agents, working as one team`, "", `${bold("Usage:")} ${CLI} <command> [options]`];
  const w = Math.max(...Object.keys(COMMANDS).map((n) => n.length));
  for (const [g, title] of GROUPS) {
    const rows = Object.entries(COMMANDS)
      .filter(([, c]) => c.group === g)
      .map(([name, c]) => [name, c.summary]);
    out.push("", bold(title), columns(rows, 2, w));
  }
  out.push("", `Run ${cyan(`${CLI} <command> --help`)} for a command's options and examples,`, `or ${cyan(`${CLI} help --all`)} for every command at once.`, "", footer());
  return out.join("\n");
}

export function commandHelp(name) {
  const c = COMMANDS[name];
  const out = [`${bold(`${CLI} ${name}`)} — ${c.summary}`, "", bold("Usage:")];
  out.push(c.usage.map((u) => `  ${CLI} ${u}`).join("\n"));
  if (c.aliases) out.push("", dim(`Also: ${c.aliases.map((a) => `${CLI} ${a}`).join(", ")}`));
  if (c.description) out.push("", c.description);
  for (const [title, rows] of c.sections || []) out.push("", bold(`${title}:`), columns(rows));
  if (c.notes) out.push("", ...c.notes);
  if (c.examples) out.push("", bold("Examples:"), columns(c.examples.map(([cmd, what]) => [`${CLI} ${cmd}`, what])));
  return out.join("\n");
}

export function fullHelp() {
  const rule = dim("─".repeat(60));
  return [overview(), ...Object.keys(COMMANDS).map(commandHelp)].join(`\n\n${rule}\n\n`);
}

// Closest command for a typo, or null. Levenshtein distance <= 2, or a unique prefix.
export function suggest(input) {
  const names = Object.keys(COMMANDS).flatMap((k) => [k, ...(COMMANDS[k].aliases || [])]);
  const prefix = names.filter((n) => n.startsWith(input));
  if (input.length >= 2 && prefix.length === 1) return prefix[0];
  let best = null;
  let bestD = 3;
  for (const n of names) {
    const d = distance(input, n);
    if (d < bestD) [best, bestD] = [n, d];
  }
  return best;
}

function distance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return row[b.length];
}

# Switchboard

**Your coding agents, working as one team.**

Switchboard lets Claude Code, Codex, Cursor and OpenCode on the same machine read each
other's chats and use each other as sub-agents. It is one small command-line tool plus a skill
that every agent loads. No server, no account, no dependencies: it uses the agents' own
CLIs and the chat files they already keep on your disk.

Two things it does:

1. **Hand off a chat.** You hit Codex's 5-hour limit halfway through a task. Open Claude Code
   and say *"continue my last Codex chat"*. Claude reads the whole Codex session (every
   message, every command and its exit code, every file it edited, web searches, the usage
   limit it hit), checks the repo as it is now, and carries on. No copying and pasting from
   one app into another, and no lost tool history.
2. **Run your agents like a dev team.** Your main agent is the senior engineer: it plans,
   decides, and reviews. It hands small, well-defined tickets to junior developers: Cursor
   running Grok, OpenCode on a free model, or a cheaper Claude model. They work in the
   background. The senior checks their work before anything ships. The expensive model's quota
   goes to the hard parts, and you get to use the quota you already have on every other tool.

```
                    you
                     │
          ┌──────────▼──────────┐
          │  senior engineer     │   Claude Code (Opus) or Codex
          │  plans, reviews,     │   reads other agents' chats,
          │  keeps the hard work │   writes briefs, verifies results
          └──┬───────┬───────┬──┘
             │       │       │      switchboard run <agent> …
     ┌───────▼─┐ ┌───▼─────┐ ┌▼──────────┐
     │ Cursor  │ │OpenCode │ │ Claude     │   juniors: tests, refactors,
     │ (Grok)  │ │(free    │ │ (Sonnet,   │   docs, lint fixes, second
     │         │ │ models) │ │  Haiku)    │   opinions, reviews
     └─────────┘ └─────────┘ └────────────┘
```

You decide which models each junior may use. You can lock Cursor to "the newest Grok,
never a `-fast` variant", or keep Claude sub-agents off Opus. Switchboard refuses anything
else before the job starts.

## Install

You need Node.js 18 or later and at least one of: [Claude Code](https://claude.com/claude-code),
[Codex](https://developers.openai.com/codex/cli), [Cursor CLI](https://cursor.com/docs/cli),
[OpenCode](https://opencode.ai). macOS and Linux. Windows is untested.

**From a terminal:**

```bash
npx -y github:boss6825/switchboard install
```

**Or paste this into any of your coding agents:**

```
Install Switchboard (https://github.com/boss6825/switchboard) for every coding agent on this
machine. First ask me one question: may sub-agents use only free and plan-included models
(recommended), or any model, including ones billed at API prices? Then run
`npx -y github:boss6825/switchboard install --spend included` (or `--spend any`), then `switchboard doctor` (or
`node ~/.switchboard/app/scripts/switchboard.mjs doctor` if that is not on PATH). Tell me which
agents are ready. For any agent CLI that is missing or not logged in, give me the exact command
to run myself; do not install or log in for me.
```

`install` finds the agents on your machine and puts the `switchboard` skill where each one
looks, using as few copies as possible:

| Agent | Skill folder | Also read by |
|---|---|---|
| Claude Code | `~/.claude/skills/switchboard` | Cursor, OpenCode |
| Codex | `~/.agents/skills/switchboard` | Cursor, OpenCode |
| Cursor only | `~/.cursor/skills/switchboard` | |
| OpenCode only | `~/.config/opencode/skills/switchboard` | |

It also copies the tool to `~/.switchboard/app` and links `~/.local/bin/switchboard` to it.
In a terminal it asks once which models sub-agents may use (see [Spending](#spending)); an agent
running the install passes `--spend` instead, and with neither it picks free-only.
Restart open agent sessions afterwards. `switchboard uninstall` removes only what it added.

<details>
<summary>Other ways to install</summary>

From a clone:

```bash
git clone https://github.com/boss6825/switchboard ~/.switchboard/src
node ~/.switchboard/src/skills/switchboard/scripts/switchboard.mjs install
```

As a plugin (the repository is a Claude Code plugin marketplace; Codex and Cursor read the
same format). Use this instead of `install`, not as well, or the skill loads twice:

```bash
claude plugin marketplace add boss6825/switchboard && claude plugin install switchboard@switchboard
codex plugin marketplace add boss6825/switchboard && codex plugin add switchboard@switchboard
```
</details>

### Check your setup

```bash
switchboard doctor
```

```
Agent        CLI                              CLI login  Desktop app  Chats on disk               Switchboard skill
-----------  -------------------------------  ---------  -----------  --------------------------  -----------------
Claude Code  claude 2.1.308                   yes        yes          211                         ~/.claude/skills
Codex        codex 0.163.0                    yes        yes          136 (+5 archived)           ~/.agents/skills
Cursor       cursor-agent 2026.10.22-27dcf5f  yes        yes          143 (73 from CLI), present  ~/.agents/skills, ~/.claude/skills
OpenCode     not installed                    -          -            none                        -
```

**Desktop apps and CLIs.** Agents talk to each other through the CLIs, because every agent
already knows how to run a command. A desktop app can be signed in while its CLI is not (Claude
Code's desktop app and CLI keep separate logins), so `doctor` checks each CLI and tells you what
to run. It checks the login, not your remaining quota or credit.
For reading chats, the CLI doesn't matter: each agent's desktop app and CLI write to the same
place on disk (see [Where chats live](#where-chats-live)).

## Use

You don't need to remember commands. Talk to your agent:

- *"Continue the Codex chat about the rate limiter."*
- *"What did Cursor change in this repo yesterday?"*
- *"Search my old chats for the Stripe webhook fix."*
- *"Have Cursor write the tests for this module while you work on the migration."*
- *"Get a second opinion on this diff from Codex."*

The skill tells the agent which `switchboard` command to run. The same commands work in a
terminal:

| Command | What it does |
|---|---|
| `switchboard sessions` | Recent chats from every agent, this folder first (`--all`, `--agent codex`) |
| `switchboard sessions search "<text>"` | Search every agent's chats |
| `switchboard sessions show <ref>` | Read a chat: messages, tool calls, exit codes (`--outputs`, `--full`) |
| `switchboard handoff <ref>` | A brief to continue a chat: what was asked, where it stopped, what changed, the workspace now |
| `switchboard run <agent> <task>` | Start a background sub-agent job (`--mode ask` read-only, `--worktree`, `--effort`) |
| `switchboard review <agent>` | Read-only adversarial review of your diff by another agent |
| `switchboard status` / `wait` / `tail` / `result` / `resume` / `cancel` | Watch and manage jobs |
| `switchboard policy` | Which models each agent may run as a sub-agent |
| `switchboard doctor` / `install` / `uninstall` | Setup |

A `<ref>` is `agent:last`, `agent:<id-prefix>` (as `sessions` prints it), or words from the title.

### A handoff, start to finish

Example (shortened):

```
$ switchboard handoff codex:last
# Codex chat: Rate limiting for API client
ref codex:01a1a2b3 · desktop · model gpt-6-luna · folder ~/projects/api
how it ended: aborted (interrupted)
usage limits at the end: 5-hour window: 100% used (resets 2026-10-29 23:02 UTC)

## What the user asked (3 messages, oldest first)
## Where it stopped          ← last message, last error, its to-do list
## Work done                 ← 14 files edited, 54 commands with exit codes, web searches
## Workspace now             ← checked just now: branch, uncommitted files, each edited file's state
## Recent conversation
```

The receiving agent is told to treat the transcript as the other agent's claims, check the
files and re-run the tests, and only then continue.

## Spending

One switch, chosen at install, decides whether sub-agents may cost money beyond your plans:

| `spend` | Claude Code | Codex | Cursor | OpenCode |
|---|---|---|---|---|
| `included` (default) | no change (no free tier) | standard speed only: fast mode spends plan usage 1.5-2.5x faster | Grok models only, never `-fast`: other models bill at API price | models ending in `-free` only, read live from `opencode models` |
| `any` | no change | its own default speed | any model on your plan | any model you have access to |

```bash
switchboard policy spend any                  # allow paid models for every agent
switchboard policy set opencode spend any     # or just for one
```

The check runs inside Switchboard, so the lead agent spends no extra tokens or turns on it. It
sees a single refusal line only when it asks for a model the setting rules out, and when no
model is named Switchboard picks one that is allowed (for OpenCode, the first free model today).
OpenCode's free list changes without notice, and `big-pickle` is not counted as free because
its id does not say so.

## Model policy

Each agent has its own rules for what it may run as a sub-agent. Set them once:

```bash
switchboard policy set cursor model grok:latest     # always the newest Grok on your plan
switchboard policy set cursor chooseModel false     # the lead agent picks only the effort
switchboard policy set cursor deny "*-fast"         # never the pricier -fast variants
switchboard policy set claude allow sonnet haiku    # no Opus for small jobs
switchboard policy set opencode model opencode/<a-free-model>   # see: switchboard models opencode
switchboard policy set codex enabled false          # keep Codex's quota for yourself
switchboard policy                                  # show it all
```

| Key | Meaning |
|---|---|
| `model` | Default model: an id, or `<family>:latest` to follow new releases automatically |
| `effort` | Default effort (`low` … `max`, whatever the agent supports) |
| `chooseModel` | `false`: the lead agent may not pick a model; the default always runs |
| `chooseEffort` | `false`: the lead agent may not pick an effort |
| `allow` / `deny` | Model patterns (`*` wildcard). Deny wins. Claude ids also match their short form, so `opus*` blocks `claude-opus-5-5`. A bare family name such as `grok` allows every Grok, `-fast` ones included, unless you also deny them |
| `efforts` | Efforts the lead agent may use |
| `enabled` | `false`: never use this agent as a sub-agent |
| `spend` | `included` or `any`, overriding the install-time [spending](#spending) choice for this agent |

The policy lives in `~/.switchboard/config.json`. A job that can't get an allowed model does
not start; there is no silent fallback. Some details that keep the rules honest:

- For Claude, an alias like `sonnet` is checked again against the model Claude reports at
  startup, and the job is stopped if that model is not allowed.
- If an agent has an allow or deny list, it needs a named default model (Claude excepted, see
  above): otherwise the agent's own default would run unchecked. Cursor's `auto` router is
  refused for the same reason.
- `resume` checks the session's model against today's policy, so tightening the rules also
  applies to sessions started before.

If you used [cursor-bridge](#history) before, its Cursor policy is imported on first run.

## How delegation works

```
lead agent ─▶ switchboard run codex … ─▶ supervisor (detached) ─▶ codex exec --json …
                                              │ parses the event stream → state.json, activity.log
                                              │ enforces the timeout; cancel stops the whole process group
                                              └ on exit: final answer + file changes measured by git
lead agent ─▶ switchboard wait | result | resume | cancel
```

- Each job is the agent's own headless mode: `claude -p`, `codex exec`, `cursor-agent -p`,
  `opencode run`. A small detached supervisor owns it, so the job keeps running if the lead
  agent's tool call times out.
- **Changed files are measured with git**, not taken from the agent's report. Files that were
  already dirty aren't blamed on the job; changes made during a read-only job, or while another
  job shared the folder, are flagged.
- `--worktree` runs the job in a fresh git worktree on its own branch, for parallel or risky work.
- `resume <job>` continues the same session with its context. `result` also prints the agent's
  own resume command if you want to take over by hand.
- When Switchboard runs inside a Claude Code session, that session's private environment
  variables are removed before starting another agent. Without this, a child `claude` ignores
  its saved login and says "Not logged in".

## Where chats live

| Agent | On disk | Desktop app and CLI |
|---|---|---|
| Claude Code | `~/.claude/projects/<folder>/<id>.jsonl` | Same files. The desktop app keeps its own titles, which Switchboard uses. The app's "import CLI sessions" only changes what the app lists |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, archived ones zstd-compressed | Same files for the desktop app, CLI, IDE extension, and `codex exec`. Codex can also import Claude Code and Cursor chats itself |
| Cursor | `~/.cursor/projects/<folder>/agent-transcripts/<id>/<id>.jsonl` | Same files for the CLI and the editor. Tool results are not recorded, so exit codes are unknown. Older editor chats live in the editor's database; newer Cursor builds encrypt many of them, and Switchboard says so instead of guessing |
| OpenCode | `~/.local/share/opencode/opencode.db` | Read through `opencode export`; falls back to the database |

Everything is read-only. Switchboard never edits or deletes another agent's chats.

## Safety

- **Write jobs run without permission prompts**, because nobody is there to approve them:
  Cursor with `--force`, Claude Code with `--dangerously-skip-permissions`, OpenCode with
  `--auto`. Codex runs in its own OS sandbox (`workspace-write`, network access pinned off).
  Read-only jobs (`--mode ask`, `review`) use each agent's read-only mode; for Claude that also
  means no shell.
- Sub-agents are told not to commit, push, switch branches, install global packages, or edit
  outside the workspace. **That is an instruction to the model, not something Switchboard
  enforces.** Results do flag new commits. Use `--worktree` for anything risky.
- Transcripts can hold secrets and personal data. Switchboard reads them locally and prints
  them only to the agent or terminal that asked. The skill tells agents to treat transcript text
  as data, not as instructions.
- Each agent runs under its own login and its own provider's terms. A sub-agent's environment
  never contains another vendor's keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `CURSOR_API_KEY`,
  `CLAUDE_CODE_OAUTH_TOKEN`, ...), so a command it runs can't print them into its transcript.
  OpenCode keeps the provider API keys, because it uses them to reach those providers.
- One write job per repository at a time (use `--worktree` for parallel writers). If a job's
  supervisor dies, the job shows as `lost` while its agent keeps running, still holds the lock,
  and `cancel` stops it.

## Tested with

Offline: `node --test tests/` (fake CLIs for all four agents and synthetic chats in each format; no network, logins, or model usage).

Live, on macOS with Node 26.8, October 2026:

| | Claude Code 2.1.308 | Codex CLI 0.163.0 | Cursor CLI 2026.10.22 | OpenCode |
|---|---|---|---|---|
| Read real chats (list, search, show, handoff) | yes (210 chats) | yes (134 + archived) | yes (142 transcripts + editor database) | not tested: not installed on the test machine |
| Delegated job | started and authenticated; the test account had no API credit left, and the job failed with Claude's own error | write job + resume, result verified by re-running the tests | read-only job on `grok-4.7-low` | not tested |

OpenCode support is built from OpenCode's documentation and source (its `run --format json`
events and both database schemas) and covered by offline tests only. Reports from OpenCode
users are welcome.

## Known limits

- Agents' on-disk formats and headless event streams are not documented stable APIs. When one
  changes, the matching reader in `skills/switchboard/scripts/lib/agents/` needs an update; the
  fake CLI in `tests/fakes/` documents the shapes Switchboard expects.
- Cursor transcripts have no tool results, and many older Cursor editor chats are encrypted.
- Jobs are one-shot: you can't steer a running job. Cancel and re-brief, or `resume` after it ends.
- `doctor` checks that each CLI is logged in, not how much quota or credit is left.
- Changes are measured with `git status`, so files git ignores don't appear in the measured list;
  edits the agent reported to such files are listed separately.
- A job takes a few seconds (Codex, Claude) to about 45 seconds (Cursor) to start.

## Adding an agent

Each agent is one file implementing the same interface: find its CLI, check its login, list
and read its chats, resolve model names, build the headless command, and parse its event
stream. See [docs/adding-an-agent.md](docs/adding-an-agent.md). Gemini CLI, Amp, and Aider are
natural next ones.

## How this was reviewed

Besides the tests, Switchboard was used on itself: it ran an adversarial review of its own code
on Cursor (newest Grok, highest effort, read-only). Of its 20 findings, 19 held up: 18 were
fixed in code (most with a regression test), and one (a bare family name in an allow list
covers every model of that family) is intended and is now documented above. One, about git
rename parsing, was checked against git's real output and rejected.

## History

Switchboard grew out of cursor-bridge, a Claude Code plugin for delegating to Cursor CLI. Its
job runner, git-measured results, and `grok:latest` model alias carry over here for every agent.

## License

MIT

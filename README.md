# Switchboard

**Your coding agents, working as one team.**

Make your Coding agent control the other coding agents. Switchboard lets Claude Code, Codex, Cursor, OpenCode, and Antigravity on the same machine to collaborate and run each other as sub-agents. It is one small command-line tool.
Two things it does:

1. **Hand off a chat.** You hit Codex's 5-hour limit halfway through a task. Open Claude Code and say *"continue my last Codex chat"*. Claude reads that session (messages, commands and exit codes, edited files, web searches, the limit it hit), checks the repo as it is now, and carries on.
2. **Run your agents like a dev team.** Your main agent is the senior engineer: it plans, decides, and reviews. It hands small tickets to the others (Cursor on Grok, OpenCode on a free model, Antigravity on your Google plan, or a cheaper Claude model). They work in the background. The senior checks the work before anything ships, so the expensive quota stays on the hard parts.

**What it saves.** Up to 15% of the token usage on your main agent.

## Install

You need Node.js 18 or later and at least one of [Claude Code](https://claude.com/claude-code), [Codex](https://developers.openai.com/codex/cli), [Cursor CLI](https://cursor.com/docs/cli), [OpenCode](https://opencode.ai), or [Antigravity CLI](https://antigravity.google/product/antigravity-cli) (`agy`). macOS and Linux. Windows is untested.

**From a terminal:**

```bash
npx -y switchboard-pro install
```

The npm package is `switchboard-pro`. The commands are `switchboard` and `sw` (the same tool; `sw` keeps command lines short).

**Or paste this into any of your coding agents:**

```
Install Switchboard (https://github.com/boss6825/switchboard) for every coding agent on this
machine. First ask me one question: may sub-agents use only free and plan-included models
(recommended), or any model, including ones billed at API prices? Then run
`npx -y switchboard-pro install --spend included` (or `--spend any`), then `sw doctor` (or
`node ~/.switchboard/app/scripts/switchboard.mjs doctor` if that is not on PATH). Tell me which
agents are ready. For any agent CLI that is missing or not logged in, give me the exact command
to run myself; do not install or log in for me.
```

`install` puts the skill where each agent looks, copies the tool to `~/.switchboard/app`, and links `switchboard` and `sw` on your PATH. In a terminal it asks once which models sub-agents may use (see [Spending](#spending)). Restart open agent sessions afterwards. `switchboard uninstall` removes only what it added.

<details>
<summary>Other ways to install, and checking your setup</summary>

Where the skill is copied (as few copies as possible):

| Agent | Skill folder | Also read by |
|---|---|---|
| Claude Code | `~/.claude/skills/switchboard` | Cursor, OpenCode |
| Codex | `~/.agents/skills/switchboard` | Cursor, OpenCode |
| Cursor only | `~/.cursor/skills/switchboard` | |
| OpenCode only | `~/.config/opencode/skills/switchboard` | |
| Antigravity | `~/.gemini/antigravity-cli/skills/switchboard` | |

The tool lives at `~/.switchboard/app`, with `~/.local/bin/switchboard` and `~/.local/bin/sw` linked to it. If another `sw` is already on your PATH, that link is skipped (`--force` adds it anyway). An agent running the install passes `--spend`; with neither a prompt nor `--spend`, install picks free-only.

**Other ways to install**

As a global npm package (gives you `switchboard` and `sw`; then run `sw install` to add the skill):

```bash
npm install -g switchboard-pro
```

Straight from GitHub:

```bash
npx -y github:boss6825/switchboard install
```

From a clone:

```bash
git clone https://github.com/boss6825/switchboard ~/.switchboard/src
node ~/.switchboard/src/skills/switchboard/scripts/switchboard.mjs install
```

As a plugin (the repository is a Claude Code plugin marketplace; Codex and Cursor read the same format). Use this instead of `install`. Doing both loads the skill twice:

```bash
claude plugin marketplace add boss6825/switchboard && claude plugin install switchboard@switchboard
codex plugin marketplace add boss6825/switchboard && codex plugin add switchboard@switchboard
```

**Check your setup**

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

Agents talk to each other through the CLIs. A desktop app can be signed in while its CLI is not (Claude Code keeps those logins separate), so `doctor` checks each CLI and tells you what to run. It checks the login. Remaining quota and credit are separate. For reading chats, the CLI does not matter: the desktop app and the CLI write to the same place on disk (see [Where chats live](#where-chats-live)).

</details>

## Use

You don't need to remember commands. Talk to your agent:

- *"Continue the Codex chat about the rate limiter."*
- *"What did Cursor change in this repo yesterday?"*
- *"Search my old chats for the Stripe webhook fix."*
- *"Have Cursor write the tests for this module while you work on the migration."*
- *"Get a second opinion on this diff from Codex."*

The skill tells the agent which `switchboard` command to run. The same commands work in a terminal.

<details>
<summary>Commands</summary>

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

A `<ref>` is `agent:last`, `agent:<id-prefix>` (as `sessions` prints it), or words from the title. `switchboard <command> --help` shows options and examples; `switchboard help --all` prints every command. Color is for terminals (`NO_COLOR=1` turns it off). Wrong usage exits 2; other failures exit 1.

</details>

<details id="how-it-works">
<summary>How it works</summary>

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

The lead agent reads the other chats, writes the brief, and checks the result. The juniors do the bounded work.

</details>

<details>
<summary>A handoff, start to finish</summary>

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

The receiving agent treats the transcript as the other agent's claims, checks the files, re-runs the tests, and only then continues.

</details>

<details id="spending">
<summary>Spending</summary>

One switch, chosen at install, decides whether sub-agents may cost money beyond your plans:

| `spend` | Claude Code | Codex | Cursor | OpenCode | Antigravity |
|---|---|---|---|---|---|
| `included` (default) | unchanged (no free tier) | standard speed only. Fast mode spends the plan 1.5–2.5× faster | Grok only, never `-fast`. Other models bill at API price | ids ending in `-free`, live from `opencode models` | any plan model, with AI credits off for the run (`useG1Credits=false`). An empty quota stops the job. A Gemini API key or Google Cloud sign-in bills per use, so the job is refused |
| `any` | unchanged | the agent's own default speed | any model on your plan | any model you can access | your own credit setting |

```bash
switchboard policy spend any                  # allow paid models for every agent
switchboard policy set opencode spend any     # or just for one
```

The check runs inside Switchboard, so the lead agent spends no extra tokens on it. A disallowed model gets one refusal line. If you name no model, Switchboard picks an allowed one (for OpenCode, the first free model that day). OpenCode's free list changes without notice. `big-pickle` is excluded: its id does not end in `-free`.

</details>

<details id="model-policy">
<summary>Model policy</summary>

Each agent has its own rules for sub-agent runs. Set them once:

```bash
switchboard policy set cursor model grok:latest     # newest Grok on your plan
switchboard policy set cursor chooseModel false     # the lead agent picks only the effort
switchboard policy set cursor deny "*-fast"         # skip the pricier -fast variants
switchboard policy set claude allow sonnet haiku    # no Opus for small jobs
switchboard policy set opencode model opencode/<a-free-model>   # see: switchboard models opencode
switchboard policy set codex enabled false          # keep Codex's quota for yourself
switchboard policy                                  # show it all
```

| Key | Meaning |
|---|---|
| `model` | Default model: an id, or `<family>:latest` to follow new releases |
| `effort` | Default effort (`low` … `max`, whatever the agent supports) |
| `chooseModel` | `false`: the default model always runs |
| `chooseEffort` | `false`: the default effort always runs |
| `allow` / `deny` | Patterns (`*` wildcard). Deny wins. Claude ids also match their short form, so `opus*` blocks `claude-opus-5-5`. A bare family such as `grok` allows every Grok, including `-fast`, unless you also deny those |
| `efforts` | Efforts the lead agent may use |
| `enabled` | `false`: never use this agent as a sub-agent |
| `spend` | `included` or `any`, overriding the install-time [spending](#spending) choice for this agent |

The policy lives in `~/.switchboard/config.json`. A job with no allowed model does not start, and Switchboard does not substitute another model.

- A Claude alias such as `sonnet` is checked against the model Claude reports at startup. A mismatch stops the job.
- An allow or deny list needs a named default model, or the agent's own default would run unchecked. Claude is the exception (the alias check above). Cursor's `auto` router is refused for the same reason.
- `resume` checks the session's model against the policy in force today.
- A previous [cursor-bridge](#history) Cursor policy is imported on first run.

</details>

<details id="how-delegation-works">
<summary>How delegation works</summary>

```
lead agent ─▶ switchboard run codex … ─▶ supervisor (detached) ─▶ codex exec --json …
                                              │ parses the event stream → state.json, activity.log
                                              │ enforces the timeout; cancel stops the whole process group
                                              └ on exit: final answer + file changes measured by git
lead agent ─▶ switchboard wait | result | resume | cancel
```

- Each job is that agent's headless mode: `claude -p`, `codex exec`, `cursor-agent -p`, `opencode run`, `agy -p`. A detached supervisor owns it, so the job keeps running if the lead agent's tool call times out.
- **Changed files are measured with git**, not taken from the agent's report. Files that were already dirty are left out. Changes during a read-only job, or while another job shared the folder, are flagged.
- `--worktree` runs the job in a fresh git worktree on its own branch.
- `resume <job>` continues the same session. `result` also prints the agent's own resume command.
- Inside a Claude Code session, that session's private environment is removed before another agent starts. Otherwise a child `claude` ignores its saved login.

</details>

<details id="where-chats-live">
<summary>Where chats live</summary>

| Agent | On disk | Desktop app and CLI |
|---|---|---|
| Claude Code | `~/.claude/projects/<folder>/<id>.jsonl` | Same files. Switchboard uses the desktop app's titles. "Import CLI sessions" only changes what the app lists |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, archived ones zstd-compressed | Same files for the desktop app, CLI, IDE extension, and `codex exec`. Codex can also import Claude Code and Cursor chats |
| Cursor | `~/.cursor/projects/<folder>/agent-transcripts/<id>/<id>.jsonl` | Same files for the CLI and the editor. Tool results are absent, so exit codes are unknown. Older editor chats live in the editor database; newer builds encrypt many of them, and Switchboard says so |
| OpenCode | `~/.local/share/opencode/opencode.db` | Read through `opencode export`, then the database |
| Antigravity | `~/.gemini/antigravity-cli/conversations/<id>.db`, indexed by `conversation_summaries.db` | One SQLite file per conversation; steps are protobuf. `agy` has no export, so Switchboard decodes messages, tool calls, outputs, and errors (field layout of agy 1.4.12; a newer release may change it, and the chat then says so). The app's `~/.gemini/antigravity/` is read the same way. Subagent runs stay hidden |

Reading is read-only. Switchboard never edits or deletes another agent's chats.

</details>

<details id="safety">
<summary>Safety</summary>

- **Write jobs skip permission prompts**, because nobody is there to approve them: Cursor `--force`, Claude Code `--dangerously-skip-permissions`, OpenCode `--auto`. Codex uses its OS sandbox (`workspace-write`, network off). Antigravity sandboxes commands too (workspace only, no network), accepts workspace edits, and denies writes to `<workdir>/.git`. It never gets `--dangerously-skip-permissions`. Those rules are passed per run with `agy --settings` and added to your `permissions`. A command that needs to leave the sandbox is denied, and the job fails with the permission it needed. Read-only jobs (`--mode ask`, `review`) use each agent's read-only mode; for Claude that includes no shell.
- Sub-agents are told not to commit, push, switch branches, install global packages, or edit outside the workspace. **That is an instruction to the model.** Switchboard does not enforce it. Results do flag new commits. Use `--worktree` for risky work.
- Transcripts can hold secrets and personal data. Switchboard reads them locally and prints them only to the agent or terminal that asked. The skill tells agents to treat transcript text as data.
- Each agent runs under its own login. A sub-agent's environment never contains another vendor's keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `CURSOR_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `GEMINI_API_KEY`, ...). OpenCode keeps provider API keys, because it uses them to reach those providers.
- One write job per repository at a time (`--worktree` for parallel writers). If a supervisor dies, the job shows as `lost`, the agent keeps running, the lock stays held, and `cancel` stops it.

</details>

<details id="tested-with">
<summary>Tested with</summary>

Offline: `node --test tests/` (fake CLIs for all five agents and synthetic chats; no network, logins, or model usage).

Live, on macOS with Node 26.8, October 2026:

| | Claude Code 2.1.308 | Codex CLI 0.163.0 | Cursor CLI 2026.10.22 | OpenCode |
|---|---|---|---|---|
| Read real chats (list, search, show, handoff) | yes (210 chats) | yes (134 + archived) | yes (142 transcripts + editor database) | not on the test machine |
| Delegated job | started and authenticated; the test account had no API credit, and the job failed with Claude's own error | write job + resume, result verified by re-running the tests | read-only job on `grok-4.7-low` | not on the test machine |

Antigravity, live with agy 1.4.12 on 2026-11-04: real CLI chats (list, show, search); a read-only job, a write job (edit plus a sandboxed command), and a resume, on the plan's default model at low effort. App chats were not on the test machine.

OpenCode support is built from OpenCode's documentation and source (`run --format json` events and both database schemas) and covered by offline tests only.

</details>

<details id="known-limits">
<summary>Known limits</summary>

- On-disk formats and headless event streams are not stable APIs. When one changes, the reader in `skills/switchboard/scripts/lib/agents/` needs an update. The fake CLI in `tests/fakes/` documents the shapes Switchboard expects.
- Cursor transcripts have no tool results, and many older Cursor editor chats are encrypted.
- Jobs are one-shot. Cancel and re-brief, or `resume` after the job ends.
- `doctor` checks that each CLI is logged in. Quota and remaining credit are outside that check.
- Changes are measured with `git status`, so ignored files stay out of that list. Edits the agent reported on ignored files are listed separately.
- A job takes a few seconds (Codex, Claude) to about 45 seconds (Cursor) to start.

</details>

<details id="adding-an-agent">
<summary>Adding an agent</summary>

Each agent is one file with the same interface: find its CLI, check its login, list and read its chats, resolve model names, build the headless command, and parse its event stream. See [docs/adding-an-agent.md](docs/adding-an-agent.md). Gemini CLI, Amp, and Aider are natural next ones.

</details>

<details id="how-this-was-reviewed">
<summary>How this was reviewed</summary>

Switchboard reviewed its own code on Cursor (newest Grok, highest effort, read-only). Of 20 findings, 19 held: 18 were fixed, most with a regression test, and one is intended (a bare family name in an allow list covers every model of that family). One finding, about git rename parsing, was checked against git's real output and dropped.

</details>

<details id="history">
<summary>History</summary>

Switchboard grew out of cursor-bridge, a Claude Code plugin for delegating to Cursor CLI. The job runner, git-measured results, and `grok:latest` alias now apply to every agent.

</details>

## License

AGPL-3.0

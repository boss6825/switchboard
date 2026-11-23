# Architecture

How Switchboard lets one agent read and control the others, and how Grok Bot fits in.

## The pieces

```
          ┌──────────────────────── one machine ────────────────────────┐
          │                                                             │
 you ───▶ │  lead agent (Claude Code, Codex, Cursor, OpenCode, agy)     │
          │     │  reads SKILL.md, runs `sw <command>`                  │
          │     ▼                                                       │
          │  sw  (skills/switchboard/scripts/switchboard.mjs, Node, 0 deps)
          │     │                                                       │
          │     ├── read path:  agents/<name>.mjs → sessions.list/load  │
          │     │     reads each agent's chats from disk (JSONL, SQLite, │
          │     │     protobuf) into one normalized shape → handoff      │
          │     │                                                       │
          │     ├── control path (local agents): jobs.mjs               │
          │     │     spawn detached supervisor → adapter.buildRun()     │
          │     │     → headless CLI (claude -p, codex exec,             │
          │     │       cursor-agent, opencode run, agy)                 │
          │     │     parse event stream → ~/.switchboard/jobs/<id>/     │
          │     │     policy gate before start, git diff after end       │
          │     │                                                       │
          │     └── control path (remote agents): grokbot.mjs           │
          │           POST webhook ──────────────▶ Grok Bot (cloud)     │
          │           wait for reply file ◀── `sw grokbot reply` ◀──┐   │
          │                                     run on this Mac by   │   │
          │                                     the Bot (local exec) ┘   │
          └─────────────────────────────────────────────────────────────┘
```

**Distribution.** `sw install` copies one skill folder (`skills/switchboard`) into every
folder an installed agent reads skills from, and copies the tool to `~/.switchboard/app`.
Every agent learns the same commands from the same `SKILL.md`, so a feature added to `sw`
reaches Claude Code, Codex, Cursor, OpenCode and Antigravity at once. That is why Grok Bot
control lives in `sw` and not in a Claude-only skill.

**Read path.** One adapter per agent (`scripts/lib/agents/*.mjs`, see
[adding-an-agent.md](adding-an-agent.md)) knows where that agent stores chats and turns them
into one normalized session. `sessions`, `handoff`, and `doctor` only use the adapter
interface.

**Control path for local agents.** `sw run <agent>` writes a job record and starts a
detached supervisor (the same script, `__supervise`). The supervisor runs the agent's
headless CLI, parses its event stream into `state.json` and `activity.log`, enforces the
timeout, and on exit records the final answer and the file changes measured with git. The
caller only reads those files, so a job survives the caller's tool call timing out. The
model policy (`sw policy`) is checked before anything starts.

**Control path for remote agents (Grok Bot).** Grok Bot is not a CLI on this machine. It
runs on xAI's cloud computer. So there is nothing to spawn and no stream to parse. Instead:

1. `sw grokbot send` makes a request id, records it under
   `~/.switchboard/grokbot/requests/`, and POSTs JSON to the routine's webhook:
   `{ request_id, task, context, reply_command }`. Auth is the routine's key in a header
   (`Authorization: Bearer <key>` by default).
2. The Grok Bot routine does the task on its cloud computer.
3. The routine runs `reply_command` **on this Mac** (Grok Bot's local-computer execution),
   piping its answer on stdin: `sw grokbot reply --request-id <id> --status done`. That
   writes `~/.switchboard/grokbot/replies/<id>.json`. Only ids that `send` recorded are
   accepted.
4. `send` (or a later `sw grokbot wait --request-id <id>`) polls for that file and prints
   the answer as JSON. Default wait is 540 seconds, which stays under a 10-minute agent
   tool-call limit.

The URL, key and header name live in the macOS Keychain (`GROKBOT_WEBHOOK_URL`,
`GROKBOT_WEBHOOK_SECRET`, `GROKBOT_WEBHOOK_HEADER`), set by `sw grokbot setup`. Environment
variables with the same names override the Keychain (for Linux or CI).

## Why the webhook, and not the community Grok Bot CLIs

Two community CLIs exist. Both talk to Grok Bot's **private, undocumented** backend.

| | Routine webhook (chosen) | `gbot` (ScriptedAlchemy/grok-bot-cli) | `grokbot` (BugenZhao/grokbot-cli) |
|---|---|---|---|
| Interface | Documented by xAI ([Skills and routines → Webhooks](https://docs.x.ai/grok-bot/skills-routines-and-automations)) | Private gateway API | Private Connect API (`aiserver.v1`); its README says it "may change at any time" |
| Auth | One routine key you copy from the app, stored in Keychain | Decrypts the desktop app's stored session and routing secrets | Own browser sign-in, or borrows the app's session (macOS) |
| Breaks when | xAI changes a documented feature | Any app update that changes the private API or secret storage | Same; the repo has a schema-update procedure for this |
| Runtime | Node 18+, already required by `sw` | Node 22.19+, npm package | Rust binary, not notarized on macOS |
| Can do | Start a routine run with a task; get the answer back through local exec | List/create bots, send messages, read threads, Codex bridge | Message bots, read transcripts, status, toggle routines |
| Scope of access | Only the one routine you exposed | Everything your Grok Bot account can do | Everything your account can do |

The webhook wins on the two things that matter for a feature other agents depend on: it
will keep working across Grok Bot updates, and it gives an agent access to one routine,
not to your whole account. Its limits: you set up one routine by hand, each task is one
routine run (counts against routine rate limits: 200/hour per routine), and the reply needs
Grok Bot's local-computer execution turned on.

The CLIs stay useful as an **optional extra**, not a dependency: for reading a Bot's
transcript when a reply never arrived, or for richer control (create bots, multi-turn
threads). If one is installed and you want that, a later `grokbot` backend can shell out to
it the same way `sw run` shells out to agent CLIs, and fall back to the webhook when it
breaks.

## Extending to other agents

Nothing in the Grok Bot path is Claude-specific. Any agent that has the Switchboard skill
runs the same `sw grokbot send` command. Codex, Cursor, OpenCode and Antigravity get it on
the next `sw install`.

To add another remote agent (one that runs in someone else's cloud and accepts a webhook),
copy `lib/grokbot.mjs`: the request/reply files, the wait loop and the Keychain helpers do
not depend on Grok Bot. Only the payload shape, auth header and setup prompts change.

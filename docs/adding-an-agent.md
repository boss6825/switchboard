# Adding an agent

Every agent is one module in `skills/switchboard/scripts/lib/agents/`, registered in
`agents/index.mjs`. The rest of Switchboard (job runner, policy, session commands, installer)
works on the interface below and never special-cases an agent.

Start from the closest existing adapter: `codex.mjs` (JSONL transcripts, stdin prompt),
`cursor.mjs` (JSONL transcripts plus a SQLite store, prompt as an argument), `opencode.mjs`
(SQLite, reads through the agent's own export command), or `antigravity.mjs` (one SQLite file
per chat with protobuf steps, decoded without a schema; run rules passed per run as settings).

## The interface

```js
export default {
  name: "gemini",              // what users type: switchboard run gemini …
  label: "Gemini CLI",         // what output says
  prefix: "gm",                // job id prefix: gm-1030-a1b2c3
  installHint: "npm install -g @google/gemini-cli",
  loginHint: "gemini (then /auth)",
  efforts: ["low", "medium", "high"],   // or null if free-form
  supports: { resume: true, modes: ["write", "ask"], stdinPrompt: true },
  verifiesModel: false,        // true if the init event names the concrete model id
  successOnCleanExit: false,   // true if the stream has no final "result" event

  bin(),                       // path to the CLI or null; honour policyFor(name).bin and an env override
  desktop(),                   // path to a desktop app or null
  version(),                   // string or null
  auth(),                      // { ok: true | false | null, detail }
  takeover(sessionId),         // the command a human runs to reopen the session

  listModels({ refresh }),     // array of ids ([] if the CLI has no list)
  resolveModel(want, effort, { notes }),  // -> { id, effort }; handle "<family>:latest"; die() on unknown ids
  matchNames(id),              // names a policy pattern may match (e.g. short forms)
  isLatestOf(pattern, id),     // for allow entries like "flash:latest"
  included: {                  // what spend=included allows (optional; no entry = no limit)
    check(id),                 //   a reason string if this model costs extra, else null
    defaultModel(notes),       //   optional: the model to run when none is named
    preflight(),               //   optional: a reason string if any run would bill (e.g. an API key login)
  },

  buildRun(job, prompt),       // -> { bin, args, stdin } for one headless run
  parser(ctx),                 // -> (event) => void, translating the agent's event stream
  afterRun(state, job),        // optional: fill in details the stream lacked

  sessions: {
    stores(),                  // [{ label, path, count }] for doctor
    list(),                    // session metadata, cheap (read file heads, not whole files)
    load(meta),                // the normalized session (see agents/common.mjs)
    inCwd(session, dir),
  },
};
```

### `buildRun(job, prompt)`

`job` has `mode` (`write` or `ask`), `model`, `effort`, `cwd`, `addDirs`, `resumeSessionId`
and `agentBin`. Write mode must run without permission prompts (nobody can answer them);
ask mode must be the agent's read-only mode. Pass the prompt on stdin when the CLI supports it.

### `parser(ctx)`

Call these as events arrive; the job runner does the bookkeeping:

| Call | When |
|---|---|
| `ctx.init({ sessionId, model, cwd })` | The session starts |
| `ctx.say(text)` | The agent says something to the user |
| `ctx.toolStart(id, { kind, text, command?, path? })` | A tool call starts (`kind`: shell, edit, read, search, web, mcp, …) |
| `ctx.toolEnd(id, { exitCode?, error?, files?, added?, removed? }, fallback)` | It finishes |
| `ctx.final({ isError, result, usage, costUsd, durationMs })` | The run's final result |
| `ctx.error(message)` | An error the agent reported |
| `ctx.log(line)` | Anything else worth showing in `tail` |

The answer shown by `result` is what the agent said after its last tool call.

### Sessions

`list()` returns `{ agent, id, title, cwd, surface, createdAt, updatedAt, model, file }`.
`surface` says where the chat came from (cli, desktop, editor, exec, …). `load(meta)` returns
the same object plus `events`, `ended`, `limits` and `notes`; the event shape is documented at
the top of `agents/common.mjs`. Never write to the agent's files.

## Tests

Add your agent to `tests/fakes/fake-agent.mjs` (the event stream your parser expects, captured
from a real run) and a synthetic chat to `tests/helpers.mjs`. The job tests loop over every
agent automatically. Never commit real transcripts.

## Credentials

If the agent reads its own API key from the environment, add it to `VENDOR_KEYS` in
`lib/util.mjs` so other vendors' sub-agents never receive it.

## Skill folders

If the agent reads skills from a folder the installer does not know, add it to `skillDirs()` in
`lib/install.mjs`.

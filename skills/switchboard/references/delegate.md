# Delegating to another agent

You are the lead engineer; the sub-agent is a capable colleague who starts cold. You decide
what to hand off, write the brief, watch the job, and check the work before you tell the user
anything is done.

## Delegate or do it yourself

Delegate when all of these hold:
- The goal and the "done" condition fit in a few lines.
- The work is bounded: named files or a clear search area.
- You can check the result cheaply: a test, a type check, a build, a short diff.
- A mistake is recoverable (uncommitted changes, or `--worktree`).

Good fits: tests for specified behaviour, mechanical refactors and renames, applying a fix you
already diagnosed, boilerplate, docs, lint and type cleanup, migrating call sites,
codebase exploration ("find every place that does X"), second opinions, adversarial review.

Keep it yourself: unclear requirements, architecture choices, debugging with an unknown cause,
security- or data-sensitive changes (auth, payments, access control, migrations that drop
data), anything that needs this conversation's context, and the final verification. If writing
the brief takes longer than the task, do the task.

If the user names an agent ("have Cursor do it"), use it and say what you chose.

## Which agent

Ask `sb policy` and `sb doctor` once per session. Typical roles:
- **Cursor** (often locked by the user to its newest Grok): bulk mechanical work, tests,
  reviews, exploration.
- **OpenCode**: free or cheap models for docs, boilerplate, simple edits.
- **Codex**: strong at multi-file changes; runs in its own OS sandbox (no network in write mode).
- **Claude Code**: careful edits and reviews; defaults to Sonnet as a sub-agent.
An agent with `enabled=false` is off limits. A locked model is the user's decision.

## Write the brief

Switchboard prepends rules (stay in scope, no commits, no global installs, end with a REPORT).
You supply:

```
Goal: <the outcome, one sentence>
Context: <what you know: files, the diagnosed cause, decisions already made>
Scope: <files it may touch; what it must not touch>
Constraints: <conventions to match, things that look wrong but are intentional>
Done when: <observable condition, e.g. `npm test -- auth` passes and no other files change>
Verify with: <exact commands>
```

The sub-agent reads the repo's AGENTS.md / CLAUDE.md / rules, but nothing from this
conversation. Put every needed fact in the brief.

## Run it

```bash
sb run <agent> --effort <level> [--mode ask] [--worktree] <<'BRIEF'
...
BRIEF
```

- `--mode write` (default) may edit files and run commands without asking: Cursor runs with
  `--force`, Claude Code without permission prompts, OpenCode with `--auto`, Codex inside its
  workspace-write sandbox. `--mode ask` is read-only for every agent.
- **Effort**: pick the lowest likely to succeed. `low` trivial and mechanical; `medium` routine
  bounded edits; `high` multi-file changes or a focused investigation; `xhigh` tricky debugging,
  reviews, subtle changes. A failed cheap run that needs a rerun costs more than one right-sized run.
- **Model**: do not pass `--model` unless the user named one and the policy allows choosing.
  Check the "Started … model=" line; if it is not what the policy promises, cancel the job and
  tell the user.
- `--worktree` puts the job in a fresh git worktree on its own branch (from HEAD; your
  uncommitted changes are not in it). Without it, a second writer in the same checkout is refused.

## Watch it

Startup takes 5-45 seconds depending on the agent.
- Preferred: start `sb wait <job> --timeout 3000 --quiet` as a background command, keep working,
  and act when it finishes.
- Or block: `sb wait <job> --timeout 540` (stay under your tool's time limit; repeat if needed).
- Peek: `sb status`, `sb tail <job>`. Wrong direction: `sb cancel <job>`, then re-brief.
- Several jobs: start them all, then `sb wait <id1> <id2> [--any]`.

## Verify, then report

`sb result <job>` shows the answer, files changed **as measured by git**, and the commands it
ran with exit codes. Then:
1. Read the real diff, not the summary. Check it stayed in scope.
2. Run the "Verify with" commands yourself.
3. Compare claimed changes with the git-measured list; flag surprises and any new commits.
4. Fix small problems yourself, or follow up in the same session: `sb resume <job> <<'MORE' ... MORE`.
5. Tell the user which agent and model did what, what you verified, and what you did not.

## Adversarial review

```bash
sb review <agent> [--base main] [--effort xhigh] "<what to challenge>"
```

Read-only. A different model with no stake in the choices often catches what the author missed.
Treat each finding as a hypothesis: confirm it in the code before acting, and say which you
rejected and why.

# Continuing another agent's chat

## Where chats come from

| Agent | Store (shared by its CLI and desktop app) | Notes |
|---|---|---|
| Claude Code | `~/.claude/projects/<folder>/<id>.jsonl` | `where` shows desktop / cli / headless. Titles from the desktop app are used when present |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | Desktop app, CLI, IDE and `codex exec` all write here. `--archived` adds archived threads. Records the 5-hour and weekly usage windows |
| Cursor | `~/.cursor/projects/<folder>/agent-transcripts/<id>/` | CLI and editor both write here. No tool results are recorded, so exit codes are unknown. Older editor chats come from Cursor's database and are often encrypted (the tool says so) |
| OpenCode | `~/.local/share/opencode/opencode.db` | Read through `opencode export` when the CLI is installed |

## Commands

```bash
sb sessions                         # this folder, newest first, all agents
sb sessions --all --agent codex     # every folder, one agent
sb sessions search "rate limit"     # all agents, all folders; --here for this folder only
sb sessions show codex:last         # the transcript: user, agent, tool calls with exit codes
sb sessions show <ref> --outputs    # include tool outputs
sb sessions show <ref> --full --last 40
sb handoff <ref>                    # the brief to continue from
sb handoff <ref> --budget 20000     # smaller brief (characters)
sb handoff <ref> --out handoff.md   # write it to a file
```

## Reading a handoff

- **What the user asked**: every user message, oldest first. The last one is usually what
  is still open.
- **Where it stopped**: how the last turn ended (completed, aborted, interrupted), the last
  error, usage-limit figures (Codex), the agent's last message, and its last to-do list.
  "never replied to the user's last message" means it was cut off.
- **Work done**: files it edited, commands with exit codes (failures listed separately), web
  lookups, MCP tools, sub-agents. This is from the transcript.
- **Workspace now**: checked when you ran the command: branch, uncommitted changes, and for
  each file the agent edited whether it still differs. Trust this section over the others.

## Then

1. Read the files that matter and `git diff`.
2. Re-run the failing or relevant checks yourself.
3. Continue the open request. If the transcript and the files disagree, the files win; say so.
4. If the user's intent is unclear from the transcript, ask one question before starting.

The other agent's own resume command (shown under "More detail") reopens the chat in that
agent, if the user would rather go back to it later.

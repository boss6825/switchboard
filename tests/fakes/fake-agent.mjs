#!/usr/bin/env node
// Stand-in for the claude, codex, cursor-agent and opencode CLIs in offline
// tests. FAKE_KIND picks which one it imitates; it emits the event shapes each
// real CLI produced in October 2026 (captured from live runs; OpenCode's from
// its source). A SCENARIO:<name> token in the prompt picks the behaviour.
import fs from "node:fs";
import path from "node:path";

const kind = process.env.FAKE_KIND;
const args = process.argv.slice(2);
const log = (o) => process.env.FAKE_ARGS_LOG && fs.appendFileSync(process.env.FAKE_ARGS_LOG, JSON.stringify(o) + "\n");
log({ kind, args, simple: process.env.CLAUDE_CODE_SIMPLE || null, claudecode: process.env.CLAUDECODE || null, keys: Object.keys(process.env).filter((k) => /API_KEY|OAUTH_TOKEN|AUTH_TOKEN/.test(k)).sort() });
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- side commands
// OpenCode 2.x dropped `run --dir` and `--variant`; FAKE_OPENCODE_VERSION=1.x imitates the old CLI.
const ocVersion = process.env.FAKE_OPENCODE_VERSION || "2.2.1";
const ocNew = Number(ocVersion.split(".")[0]) >= 2;
if (args[0] === "--version") {
  console.log({ claude: "9.9.9 (Claude Code)", codex: "codex-cli 9.9.9", cursor: "2099.01.01-fake", opencode: ocNew ? `opencode v${ocVersion}` : ocVersion }[kind]);
  process.exit(0);
}
if (kind === "opencode" && args[0] === "run") {
  const bad = (ocNew ? ["--dir", "--variant"] : ["--standalone"]).find((f) => args.includes(f));
  if (bad) {
    process.stderr.write(`ERROR\n  Unrecognized flag: ${bad} in command opencode run\n`);
    process.exit(1);
  }
}
if (kind === "claude" && args[0] === "auth") {
  const loggedIn = !process.env.CLAUDE_CODE_SIMPLE; // mimic: bare mode never reads the saved login
  console.log(JSON.stringify({ loggedIn, authMethod: loggedIn ? "oauth_token" : "none" }));
  process.exit(0);
}
if (kind === "codex" && args[0] === "login") {
  console.log("Logged in using ChatGPT");
  process.exit(0);
}
if (kind === "cursor" && args[0] === "status") {
  console.log("✓ Logged in as test@example.invalid");
  process.exit(0);
}
if (kind === "cursor" && args[0] === "models") {
  const ids = process.env.FAKE_MODELS ? process.env.FAKE_MODELS.split(",") : ["auto", "gpt-5.2", "cursor-grok-4.6-high", "cursor-grok-4.6-high-fast", ...["low", "medium", "high", "xhigh"].flatMap((e) => [`grok-4.7-${e}`, `grok-4.7-${e}-fast`])];
  console.log("Available models\n\n" + ids.map((id) => `${id} - ${id}`).join("\n"));
  process.exit(0);
}
if (kind === "opencode" && args[0] === "models") {
  console.log(["opencode/free-model-1.5", "opencode/free-model-2.0", "anthropic/claude-sonnet-5-5"].join("\n"));
  process.exit(0);
}
if (kind === "opencode" && args[0] === "auth") {
  console.log("Credentials ~/.local/share/opencode/auth.json\n● Anthropic api");
  process.exit(0);
}

// ---- a run
const stdin = process.stdin.isTTY ? "" : fs.readFileSync(0, "utf8");
const prompt = stdin || args[args.length - 1] || "";
const scenario = (prompt.match(/SCENARIO:(\w+)/) || [])[1] || "ok";
const cwd = process.cwd();
const file = path.join(cwd, "fake-output.txt");
const sid = `00000000-fake-${kind}-0000-${String(process.pid).padStart(8, "0")}`;
const flag = (f) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : null;
};

async function slowPart() {
  if (scenario !== "slow") return;
  const { spawn } = await import("node:child_process");
  const c = spawn("sleep", ["60"], { stdio: "ignore" });
  if (process.env.FAKE_CHILD_PID) fs.writeFileSync(process.env.FAKE_CHILD_PID, String(c.pid));
  await sleep(30000);
}

if (kind === "codex") {
  out({ type: "thread.started", thread_id: sid });
  out({ type: "turn.started" });
  if (scenario === "fail") {
    out({ type: "turn.failed", error: { message: "You've hit your usage limit (fake)" } });
    process.exit(1);
  }
  await slowPart();
  out({ type: "item.completed", item: { id: "i0", type: "agent_message", text: "I'll look first." } });
  out({ type: "item.started", item: { id: "i1", type: "command_execution", command: "/bin/zsh -lc 'ls'", status: "in_progress" } });
  out({ type: "item.completed", item: { id: "i1", type: "command_execution", command: "/bin/zsh -lc 'ls'", aggregated_output: "a.txt\n", exit_code: 0, status: "completed" } });
  if (scenario === "edit") {
    fs.writeFileSync(file, "hello from fake codex\n");
    out({ type: "item.completed", item: { id: "i2", type: "file_change", changes: [{ path: file, kind: "add" }], status: "completed" } });
  }
  out({ type: "item.completed", item: { id: "i3", type: "agent_message", text: `Done (${scenario}).\n\nREPORT\n- ok` } });
  out({ type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } });
  process.exit(0);
}

if (kind === "claude") {
  const model = process.env.FAKE_CLAUDE_MODEL || `claude-${flag("--model") || "sonnet"}-5-5`;
  out({ type: "system", subtype: "hook_started", session_id: sid });
  out({ type: "system", subtype: "init", session_id: sid, model, cwd, permissionMode: flag("--permission-mode") || "default" });
  if (scenario === "fail") {
    out({ type: "assistant", message: { content: [{ type: "text", text: "Not logged in · Please run /login" }] }, error: "authentication_failed", session_id: sid });
    out({ type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login", session_id: sid });
    process.exit(1);
  }
  await slowPart();
  out({ type: "assistant", message: { content: [{ type: "text", text: "Checking." }, { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] }, session_id: sid });
  out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "a.txt" }] }, session_id: sid });
  if (scenario === "edit") {
    fs.writeFileSync(file, "hello from fake claude\n");
    out({ type: "assistant", message: { content: [{ type: "tool_use", id: "t2", name: "Write", input: { file_path: file, content: "x" } }] }, session_id: sid });
    out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t2", content: "File created" }] }, session_id: sid });
  }
  out({ type: "assistant", message: { content: [{ type: "text", text: `Done (${scenario}).\n\nREPORT\n- ok` }] }, session_id: sid });
  out({ type: "result", subtype: "success", is_error: false, result: `Done (${scenario}).`, session_id: sid, total_cost_usd: 0.01, duration_ms: 5, usage: { input_tokens: 3, output_tokens: 4 } });
  process.exit(0);
}

if (kind === "cursor") {
  const model = flag("--model") || "Auto";
  out({ type: "system", subtype: "init", session_id: sid, cwd, model });
  out({ type: "assistant", message: { content: [{ type: "text", text: "I'll look at the code first." }] }, session_id: sid });
  if (scenario === "fail") {
    process.stderr.write("Error: model quota exceeded (fake)\n");
    process.exit(1);
  }
  await slowPart();
  if (scenario === "edit") {
    fs.writeFileSync(file, "hello from fake cursor\n");
    out({ type: "tool_call", subtype: "started", call_id: "c2", tool_call: { editToolCall: { args: { path: file } } }, session_id: sid });
    out({ type: "tool_call", subtype: "completed", call_id: "c2", tool_call: { editToolCall: { args: { path: file }, result: { success: { linesAdded: 1, linesRemoved: 0 } } } }, session_id: sid });
  }
  out({ type: "tool_call", subtype: "started", call_id: "c3", tool_call: { shellToolCall: { args: { command: "ls" } } }, session_id: sid });
  out({ type: "tool_call", subtype: "completed", call_id: "c3", tool_call: { shellToolCall: { args: { command: "ls" }, result: { success: { exitCode: 0, stdout: "a.txt", stderr: "" } } } }, session_id: sid });
  out({ type: "assistant", message: { content: [{ type: "text", text: `Done (${scenario}).\n\nREPORT\n- ok` }] }, session_id: sid });
  out({ type: "result", subtype: "success", is_error: false, result: "Done.", duration_ms: 10, session_id: sid, usage: { inputTokens: 1, outputTokens: 1 } });
  process.exit(0);
}

if (kind === "opencode") {
  const ev = (type, data) => out({ type, timestamp: Date.now(), sessionID: sid, ...data });
  ev("step_start", { part: { type: "step-start" } });
  if (scenario === "fail") {
    if (ocNew) ev("error", { error: { type: "provider.free-limit", message: "Free usage limit reached (fake)", status: 429, retryAfterMs: 4979000 } });
    else ev("error", { error: { name: "ProviderAuthError", data: { message: "no credentials (fake)" } } });
    process.exit(1);
  }
  await slowPart();
  ev("text", { part: { type: "text", text: "Looking." } });
  ev("tool_use", { part: { type: "tool", callID: "b1", tool: "bash", state: { status: "completed", input: { command: "ls" }, output: "a.txt", metadata: { exit: 0 } } } });
  if (scenario === "edit") {
    fs.writeFileSync(file, "hello from fake opencode\n");
    ev("tool_use", { part: { type: "tool", callID: "w1", tool: "write", state: { status: "completed", input: { filePath: file }, output: "" } } });
  }
  ev("text", { part: { type: "text", text: `Done (${scenario}).\n\nREPORT\n- ok` } });
  ev("step_finish", { part: { type: "step-finish", reason: "stop", tokens: { input: 5, output: 6, reasoning: 0 }, cost: 0 } });
  process.exit(0);
}

process.stderr.write(`fake-agent: unknown FAKE_KIND ${kind}\n`);
process.exit(2);

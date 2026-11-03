// Test sandbox: a throwaway home folder holding chats in each agent's on-disk
// format (synthetic content only), fake agent CLIs on PATH, and a git repo.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const SB = path.join(here, "..", "skills", "switchboard", "scripts", "switchboard.mjs");
const FAKE = path.join(here, "fakes", "fake-agent.mjs");

export let sqlite = null;
try {
  const emit = process.emitWarning;
  process.emitWarning = () => {};
  sqlite = await import("node:sqlite");
  process.emitWarning = emit;
} catch {}

const w = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

export const IDS = {
  claude: "11111111-aaaa-4aaa-8aaa-000000000001",
  codex: "01a18000-0000-7000-8000-000000000001",
  codex2: "01a18000-0000-7000-8000-000000000002",
  cursorCli: "22222222-bbbb-4bbb-8bbb-000000000001",
  cursorEditor: "22222222-bbbb-4bbb-8bbb-000000000002",
  cursorOld: "22222222-bbbb-4bbb-8bbb-000000000003",
  opencode: "ses_fake000000000001",
  antigravity: "33333333-cccc-4ccc-8ccc-000000000001",
};

// Protocol buffers, enough to write Antigravity's step blobs: fields are
// [number, value] pairs; a value is an int, a string, or a nested field list.
const varint = (n) => {
  const out = [];
  while (n > 127) out.push((n % 128) | 128), (n = Math.floor(n / 128));
  out.push(n);
  return Buffer.from(out);
};
export const pbEncode = (fields) =>
  Buffer.concat(fields.map(([f, v]) => {
    if (typeof v === "number") return Buffer.concat([varint(f * 8), varint(v)]);
    const body = Array.isArray(v) ? pbEncode(v) : Buffer.from(String(v));
    return Buffer.concat([varint(f * 8 + 2), varint(body.length), body]);
  }));

// spend: the install-time choice to preseed ("any" so the fakes' paid-looking models run);
// null leaves ~/.switchboard empty, as on a fresh machine.
export function sandbox({ agents = ["claude", "codex", "cursor", "opencode", "antigravity"], spend = "any" } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-test-"));
  const home = path.join(root, "home");
  const repo = path.join(home, "work", "proj");
  const bin = path.join(root, "bin");
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(bin);

  const hasIdentity = spawnSync("git", ["config", "user.email"], { encoding: "utf8" }).stdout.trim();
  const gitEnv = hasIdentity ? process.env : { ...process.env, GIT_AUTHOR_NAME: "ci", GIT_AUTHOR_EMAIL: "ci@example.invalid", GIT_COMMITTER_NAME: "ci", GIT_COMMITTER_EMAIL: "ci@example.invalid" };
  const g = (...a) => spawnSync("git", ["-C", repo, ...a], { encoding: "utf8", env: gitEnv });
  g("init", "-q", "-b", "main");
  w(path.join(repo, "a.txt"), "one\n");
  g("add", ".");
  if (g("commit", "-qm", "init").status !== 0) throw new Error("fixture commit failed");

  for (const k of agents) {
    const name = { claude: "claude", codex: "codex", cursor: "cursor-agent", opencode: "opencode", antigravity: "agy" }[k];
    w(path.join(bin, name), `#!/bin/sh\nFAKE_KIND=${k} exec "${process.execPath}" "${FAKE}" "$@"\n`);
    fs.chmodSync(path.join(bin, name), 0o755);
  }
  const t0 = Date.parse("2026-10-29T10:00:00Z");
  const iso = (m) => new Date(t0 + m * 60000).toISOString();

  // Claude Code: one desktop chat with a tool call, an edit, a custom title.
  w(path.join(home, ".claude", "projects", "-work-proj", `${IDS.claude}.jsonl`), jsonl([
    { type: "user", cwd: repo, entrypoint: "claude-desktop", sessionId: IDS.claude, timestamp: iso(0), message: { role: "user", content: "Add a parser for the invoice CSV" } },
    { type: "assistant", cwd: repo, timestamp: iso(1), message: { model: "claude-sonnet-5-5", content: [{ type: "text", text: "Reading the CSV first." }, { type: "tool_use", id: "tu1", name: "Bash", input: { command: "head invoices.csv" } }] } },
    { type: "user", cwd: repo, timestamp: iso(1), message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: "Exit code 1\nhead: invoices.csv: No such file", is_error: true }] } },
    { type: "assistant", cwd: repo, timestamp: iso(2), message: { model: "claude-sonnet-5-5", content: [{ type: "tool_use", id: "tu2", name: "Write", input: { file_path: path.join(repo, "parser.py"), content: "..." } }] } },
    { type: "user", cwd: repo, timestamp: iso(2), message: { content: [{ type: "tool_result", tool_use_id: "tu2", content: "File created" }] } },
    { type: "user", cwd: repo, timestamp: iso(3), isMeta: true, message: { content: "<system-reminder>noise</system-reminder>" } },
    { type: "assistant", cwd: repo, timestamp: iso(4), message: { model: "claude-sonnet-5-5", content: [{ type: "text", text: "Parser written; tests still to do." }] } },
    { type: "custom-title", customTitle: "Invoice CSV parser", sessionId: IDS.claude },
  ]));
  w(path.join(home, "desktop-sessions", "acct", "org", "local_x.json"), JSON.stringify({ cliSessionId: IDS.claude, title: "Invoice parser (desktop title)", isArchived: false }));

  // Codex: a desktop thread that hit its usage limit, and a second thread created in the same second.
  const codexRows = (id, text) => [
    { timestamp: iso(10), type: "session_meta", payload: { id, session_id: id, timestamp: iso(10), cwd: repo, originator: "Codex Desktop", source: "vscode", cli_version: "0.163.0" } },
    { timestamp: iso(10), type: "turn_context", payload: { model: "gpt-6-luna", cwd: repo } },
    { timestamp: iso(10), type: "event_msg", payload: { type: "task_started", turn_id: "t1" } },
    { timestamp: iso(10), type: "event_msg", payload: { type: "item_completed", completed_at_ms: t0 + 600000, item: { type: "UserMessage", content: [{ type: "text", text: `# Files pasted by the user:\n\n## "spec.md": /tmp/x\n\n<in-app-browser-context source="ambient-ui-state">\nnoise\n</in-app-browser-context>\n\n## My request:\n${text}` }] } } },
    { timestamp: iso(11), type: "event_msg", payload: { type: "item_completed", completed_at_ms: t0 + 660000, item: { type: "CommandExecution", command: ["/bin/zsh", "-lc", "npm test"], parsed_cmd: [{ type: "unknown", cmd: "npm test" }], aggregated_output: "1 failing", exit_code: 1, status: "failed" } } },
    { timestamp: iso(12), type: "event_msg", payload: { type: "item_completed", completed_at_ms: t0 + 720000, item: { type: "FileChange", changes: { [path.join(repo, "src", "rate.ts")]: { type: "update", unified_diff: "@@" } }, status: "completed" } } },
    { timestamp: iso(12), type: "event_msg", payload: { type: "item_completed", completed_at_ms: t0 + 720000, item: { type: "Extension", kind: "web.search", query: "token bucket algorithm", action: { type: "open", url: "https://example.invalid/bucket" } } } },
    { timestamp: iso(13), type: "event_msg", payload: { type: "item_completed", completed_at_ms: t0 + 780000, item: { type: "AgentMessage", content: [{ type: "Text", text: "Half done: the limiter compiles but one test fails." }] } } },
    { timestamp: iso(13), type: "event_msg", payload: { type: "token_count", rate_limits: { primary: { used_percent: 100, window_minutes: 300, resets_at: 1793314925 }, secondary: { used_percent: 40, window_minutes: 10080, resets_at: 1793817153 }, rate_limit_reached_type: "primary" } } },
    { timestamp: iso(14), type: "event_msg", payload: { type: "error", message: "You've hit your usage limit." } },
  ];
  w(path.join(home, ".codex", "sessions", "2026", "10", "29", `rollout-2026-10-29T10-10-00-${IDS.codex}.jsonl`), jsonl(codexRows(IDS.codex, "Add rate limiting to the API client")));
  w(path.join(home, ".codex", "sessions", "2026", "10", "29", `rollout-2026-10-29T10-10-00-${IDS.codex2}.jsonl`), jsonl(codexRows(IDS.codex2, "Write the changelog")));
  w(path.join(home, ".codex", "session_index.jsonl"), jsonl([{ id: IDS.codex, thread_name: "Rate limiting for API client", updated_at: iso(14) }]));
  if (typeof zlib.zstdCompressSync === "function")
    w(path.join(home, ".codex", "archived_sessions", "rollout-2026-09-01T10-00-00-01a00000-0000-7000-8000-00000000000a.jsonl.zst"), zlib.zstdCompressSync(Buffer.from(jsonl(codexRows("01a00000-0000-7000-8000-00000000000a", "Old archived task")))));
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  w(path.join(home, ".codex", "models_cache.json"), JSON.stringify({ models: [
    { slug: "gpt-6-luna", supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }], visibility: "list" },
    { slug: "gpt-5.6-luna", supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }], visibility: "list" },
    { slug: "gpt-6.1-sol", supported_reasoning_levels: [{ effort: "low" }, { effort: "xhigh" }], visibility: "list" },
  ] }));

  // Cursor: a CLI chat and an editor chat (both transcripts), plus an older editor chat in the database.
  const tr = (id, text) => jsonl([
    { role: "user", message: { content: [{ type: "text", text: `<attached_files>x</attached_files>\n<user_query>\n${text}\n</user_query>` }] } },
    { role: "assistant", message: { content: [{ type: "text", text: "On it." }, { type: "tool_use", name: "Shell", input: { command: "pnpm lint" } }, { type: "tool_use", name: "StrReplace", input: { path: path.join(repo, "ui.tsx"), old_string: "a", new_string: "b" } }] } },
    { role: "assistant", message: { content: [{ type: "text", text: "Lint is clean now." }] } },
    { type: "turn_ended", status: "completed" },
  ]);
  w(path.join(home, ".cursor", "projects", "work-proj", "agent-transcripts", IDS.cursorCli, `${IDS.cursorCli}.jsonl`), tr(IDS.cursorCli, "Fix the lint errors"));
  w(path.join(home, ".cursor", "chats", "abc123", IDS.cursorCli, "meta.json"), JSON.stringify({ schemaVersion: 1, createdAtMs: t0, cwd: repo }));
  w(path.join(home, ".cursor", "projects", "work-proj", "agent-transcripts", IDS.cursorEditor, `${IDS.cursorEditor}.jsonl`), tr(IDS.cursorEditor, "Restyle the settings page"));
  const cursorDb = path.join(home, "cursor-editor", "state.vscdb");
  if (sqlite) {
    fs.mkdirSync(path.dirname(cursorDb), { recursive: true });
    const db = new sqlite.DatabaseSync(cursorDb);
    db.exec("CREATE TABLE composerHeaders (composerId TEXT PRIMARY KEY, workspaceId TEXT, createdAt INTEGER, lastUpdatedAt INTEGER, isArchived INTEGER, isSubagent INTEGER, recency INTEGER, checkpointAt INTEGER, subagentTypeName TEXT, value TEXT); CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);");
    const ins = db.prepare("INSERT INTO composerHeaders (composerId, createdAt, lastUpdatedAt, isArchived, isSubagent, value) VALUES (?, ?, ?, 0, 0, ?)");
    ins.run(IDS.cursorOld, t0 - 86400000, t0 - 86000000, JSON.stringify({ name: "Old editor chat about caching", workspaceIdentifier: { uri: { fsPath: repo } } }));
    ins.run(IDS.cursorEditor, t0, t0 + 60000, JSON.stringify({ name: "Settings restyle", workspaceIdentifier: { uri: { fsPath: repo } } }));
    ins.run("empty-state-draft", t0, t0, JSON.stringify({ isDraft: true }));
    const kv = db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)");
    kv.run(`composerData:${IDS.cursorOld}`, JSON.stringify({ fullConversationHeadersOnly: [{ bubbleId: "b1", type: 1 }, { bubbleId: "b2", type: 2 }] }));
    kv.run(`bubbleId:${IDS.cursorOld}:b1`, JSON.stringify({ type: 1, text: "Why is the cache stale?", createdAt: new Date(t0 - 86400000).toISOString() }));
    kv.run(`bubbleId:${IDS.cursorOld}:b2`, JSON.stringify({ type: 2, text: "The TTL is never refreshed.", toolFormerData: { name: "read_file", rawArgs: JSON.stringify({ target_file: "cache.ts" }), status: "completed", result: "..." } }));
    db.close();
  }

  // OpenCode: the v1 SQLite schema.
  const ocDir = path.join(home, ".local", "share", "opencode");
  if (sqlite) {
    fs.mkdirSync(ocDir, { recursive: true });
    const db = new sqlite.DatabaseSync(path.join(ocDir, "opencode.db"));
    db.exec(`CREATE TABLE session (id text PRIMARY KEY, project_id text, parent_id text, slug text, directory text, title text, version text, time_created integer, time_updated integer);
      CREATE TABLE message (id text PRIMARY KEY, session_id text, time_created integer, time_updated integer, data text);
      CREATE TABLE part (id text PRIMARY KEY, message_id text, session_id text, time_created integer, time_updated integer, data text);`);
    db.prepare("INSERT INTO session VALUES (?, 'p', NULL, 's', ?, 'Free-model docs pass', '1', ?, ?)").run(IDS.opencode, repo, t0 + 1200000, t0 + 1300000);
    db.prepare("INSERT INTO message VALUES ('m1', ?, ?, ?, ?)").run(IDS.opencode, t0 + 1200000, t0 + 1200000, JSON.stringify({ role: "user", time: { created: t0 + 1200000 } }));
    db.prepare("INSERT INTO message VALUES ('m2', ?, ?, ?, ?)").run(IDS.opencode, t0 + 1210000, t0 + 1210000, JSON.stringify({ role: "assistant", time: { created: t0 + 1210000 } }));
    const part = db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)");
    part.run("p1", "m1", IDS.opencode, t0 + 1200000, t0 + 1200000, JSON.stringify({ type: "text", text: "Document the public API" }));
    part.run("p2", "m2", IDS.opencode, t0 + 1210000, t0 + 1210000, JSON.stringify({ type: "tool", tool: "bash", state: { status: "completed", input: { command: "ls docs" }, output: "api.md", metadata: { exit: 0 } } }));
    part.run("p3", "m2", IDS.opencode, t0 + 1220000, t0 + 1220000, JSON.stringify({ type: "text", text: "Docs updated in docs/api.md." }));
    db.close();
  }

  // Antigravity: one CLI conversation (a database per conversation, steps as
  // protobuf, field numbers as agy 1.4.12 writes them) and the summary index.
  const agDir = path.join(home, ".gemini", "antigravity-cli");
  if (sqlite) {
    fs.mkdirSync(path.join(agDir, "conversations"), { recursive: true });
    const sec = (m) => [[1, [[1, Math.floor((t0 + m * 60000) / 1000)]]]];
    const steps = [
      [[1, 14], [4, 3], [5, sec(30)], [19, [[2, "Add retries to the upload client"]]]],
      [[1, 15], [4, 3], [5, sec(31)], [20, [[1, "Reading the client first."], [7, [[1, "call_1"], [2, "run_command"], [3, JSON.stringify({ CommandLine: "npm test" })]]]]]],
      [[1, 132], [4, 7], [5, [...sec(31), [4, [[1, "call_1"], [2, "run_command"], [3, JSON.stringify({ CommandLine: "npm test" })]]]]], [31, [[2, "permission check failed for unsandboxed \"npm test\""]]]],
      [[1, 132], [4, 3], [5, [...sec(32), [4, [[1, "call_2"], [2, "edit_file"], [3, JSON.stringify({ Path: path.join(repo, "upload.ts") })]]]]], [140, [[2, [[1, "Made 1 replacement"]]]]]],
      [[1, 15], [4, 3], [5, sec(33)], [20, [[1, "Retries added; tests could not run in the sandbox."]]]],
    ];
    const db = new sqlite.DatabaseSync(path.join(agDir, "conversations", `${IDS.antigravity}.db`));
    db.exec("CREATE TABLE steps (idx integer PRIMARY KEY, step_type integer NOT NULL DEFAULT 0, status integer NOT NULL DEFAULT 0, step_payload blob)");
    steps.forEach((st, i) => db.prepare("INSERT INTO steps VALUES (?, ?, ?, ?)").run(i, st[0][1], st[1][1], pbEncode(st)));
    db.close();
    const idx = new sqlite.DatabaseSync(path.join(agDir, "conversation_summaries.db"));
    idx.exec("CREATE TABLE conversation_summaries (conversation_id text PRIMARY KEY, title text, preview text, step_count integer, last_modified_time datetime, workspace_uris text, status text, source text, parent_conversation_id text NOT NULL DEFAULT '')");
    idx.prepare("INSERT INTO conversation_summaries VALUES (?, 'Upload client retries', 'Upload client retries', 5, ?, ?, 'CASCADE_RUN_STATUS_IDLE', '', '')").run(IDS.antigravity, new Date(t0 + 33 * 60000).toISOString().replace("T", " ").replace("Z", "+00:00"), JSON.stringify([`file://${repo}`]));
    idx.prepare("INSERT INTO conversation_summaries VALUES ('33333333-cccc-4ccc-8ccc-0000000000ff', 'A subagent run', '', 1, ?, '[]', '', '', ?)").run(new Date(t0).toISOString(), IDS.antigravity);
    idx.close();
  }

  if (spend) w(path.join(home, ".switchboard", "config.json"), JSON.stringify({ agents: {}, spend }));

  const argsLog = path.join(root, "args.log");
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|CODEX|CURSOR|OPENCODE|SWITCHBOARD|ANTHROPIC|AGY_|GEMINI)/.test(k))),
    // Only the fakes, node, and system tools: real agent CLIs on this machine must not leak in.
    PATH: [bin, path.dirname(process.execPath), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(path.delimiter),
    SWITCHBOARD_STRICT_PATH: "1",
    SWITCHBOARD_USER_HOME: home,
    SWITCHBOARD_HOME: path.join(home, ".switchboard"),
    SWITCHBOARD_CLAUDE_DESKTOP_DIR: path.join(home, "desktop-sessions"),
    SWITCHBOARD_CURSOR_DB: cursorDb,
    SWITCHBOARD_OPENCODE_DATA: ocDir,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    FAKE_ARGS_LOG: argsLog,
    FAKE_CHILD_PID: path.join(root, "child.pid"),
  };
  const run = (args, opts = {}) =>
    spawnSync(process.execPath, [SB, ...args], { cwd: opts.cwd || repo, encoding: "utf8", input: opts.input ?? "", env: { ...env, ...(opts.env || {}) }, timeout: 90000 });
  const calls = () => (fs.existsSync(argsLog) ? fs.readFileSync(argsLog, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
  const lastRun = (kind) => calls().filter((c) => c.kind === kind && !["--version", "auth", "login", "status", "models"].includes(c.args[0])).pop();
  return { root, home, repo, bin, env, run, g, calls, lastRun };
}

export const jobId = (s) => (s.match(/\b(cl|cx|cu|oc|ag)-\d{4}-[0-9a-f]{6}\b/) || [])[0];

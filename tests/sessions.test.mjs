// Reading other agents' chats. Offline: synthetic transcripts in each agent's format.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { sandbox, IDS, sqlite } from "./helpers.mjs";

test("lists chats from every agent, newest first, with the right surface and title", () => {
  const s = sandbox();
  const r = s.run(["sessions", "--json", "--limit", "50"]);
  assert.equal(r.status, 0, r.stderr);
  const list = JSON.parse(r.stdout);
  const by = Object.fromEntries(list.map((x) => [x.id, x]));
  assert.equal(by[IDS.claude].surface, "desktop");
  assert.equal(by[IDS.claude].title, "Invoice parser (desktop title)", "desktop app title wins");
  assert.equal(by[IDS.codex].title, "Rate limiting for API client", "Codex thread name from session_index");
  assert.equal(by[IDS.codex].surface, "desktop");
  assert.equal(by[IDS.codex2].title, "[pasted: spec.md]\nWrite the changelog".replace("\n", " "), "desktop wrapper stripped from the fallback title");
  assert.equal(by[IDS.cursorCli].surface, "cli");
  assert.equal(by[IDS.cursorEditor].surface, "editor");
  if (sqlite) {
    assert.equal(by[IDS.cursorEditor].title, "Settings restyle", "editor chat name from Cursor's database");
    assert.equal(by[IDS.cursorOld].surface, "editor (older chat)");
    assert.ok(!list.some((x) => x.id === "empty-state-draft"), "drafts are skipped");
    assert.equal(by[IDS.opencode].title, "Free-model docs pass");
  }
  assert.ok(!list.some((x) => x.archived), "archived Codex threads hidden by default");
});

test("refs stay unique when Codex ids share a time prefix", () => {
  const s = sandbox();
  const list = JSON.parse(s.run(["sessions", "--json", "--agent", "codex"]).stdout);
  const refs = list.map((x) => x.ref);
  assert.equal(new Set(refs).size, refs.length);
  assert.ok(refs.every((r) => r.length > "codex:01a18000".length), refs.join(" "));
  const amb = s.run(["sessions", "show", "codex:01a18000"]);
  assert.notEqual(amb.status, 0);
  assert.match(amb.stderr, /matches several chats/);
});

test("show: Codex chat with commands, exit codes, edits, web search and the usage limit", () => {
  const s = sandbox();
  const r = s.run(["sessions", "show", "codex:last"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /# Codex chat: Rate limiting for API client|# Codex chat: \[pasted/);
  const one = s.run(["sessions", "show", IDS.codex]).stdout;
  assert.match(one, /Add rate limiting to the API client/);
  assert.doesNotMatch(one, /in-app-browser-context/, "UI noise removed");
  assert.match(one, /\$ npm test  → exit 1/);
  assert.match(one, /edit .*src\/rate\.ts/);
  assert.match(one, /web token bucket algorithm → https:\/\/example\.invalid\/bucket/);
  assert.match(one, /Half done: the limiter compiles/, "AgentMessage parts of type Text are read");
  assert.match(one, /5-hour window: 100% used/);
  assert.match(one, /usage limit was reached \(primary\)/);
});

test("show: Claude chat pairs tool results with calls and hides meta messages", () => {
  const s = sandbox();
  const r = s.run(["sessions", "show", `claude:${IDS.claude.slice(0, 8)}`, "--outputs"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\$ head invoices\.csv  → exit 1/);
  assert.match(r.stdout, /edit .*parser\.py/);
  assert.match(r.stdout, /model claude-sonnet-5-5/);
  assert.doesNotMatch(r.stdout, /system-reminder/);
});

test("show: Cursor transcripts and older editor chats", () => {
  const s = sandbox();
  const cli = s.run(["sessions", "show", `cursor:${IDS.cursorCli}`]).stdout;
  assert.match(cli, /Fix the lint errors/);
  assert.doesNotMatch(cli, /attached_files/);
  assert.match(cli, /\$ pnpm lint/);
  assert.match(cli, /edit .*ui\.tsx/);
  assert.match(cli, /do not record .*tool results|not the tool results/);
  if (!sqlite) return;
  const old = s.run(["sessions", "show", "caching"]);
  assert.equal(old.status, 0, old.stderr);
  assert.match(old.stdout, /Why is the cache stale\?/);
  assert.match(old.stdout, /The TTL is never refreshed/);
  assert.match(old.stdout, /read cache\.ts/);
});

test("show: OpenCode session from its database", { skip: !sqlite }, () => {
  const s = sandbox();
  const r = s.run(["sessions", "show", "opencode:last"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Document the public API/);
  assert.match(r.stdout, /\$ ls docs  → exit 0/);
  assert.match(r.stdout, /Docs updated in docs\/api\.md/);
});

test("search finds text across agents and reports where", () => {
  const s = sandbox();
  const r = s.run(["sessions", "search", "limiter"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /codex:/);
  assert.match(r.stdout, /assistant: .*limiter compiles/);
  const none = s.run(["sessions", "search", "zebra-unicorn-42"]);
  assert.match(none.stdout, /No chats mention/);
});

test("handoff: every section, the limit hit, files as they are now", () => {
  const s = sandbox();
  fs.mkdirSync(path.join(s.repo, "src"), { recursive: true });
  fs.writeFileSync(path.join(s.repo, "src", "rate.ts"), "export {}\n"); // untracked now
  const r = s.run(["handoff", IDS.codex]);
  assert.equal(r.status, 0, r.stderr);
  const t = r.stdout;
  for (const h of ["## How to use this handoff", "## What the user asked", "## Where it stopped", "## Work done (from the transcript)", "## Workspace now", "## Recent conversation", "## More detail"]) assert.ok(t.includes(h), `missing ${h}`);
  assert.match(t, /5-hour window: 100% used/);
  assert.match(t, /Last error: You've hit your usage limit/);
  assert.match(t, /Commands that failed \(1\): `npm test`/);
  assert.match(t, /src\/rate\.ts: uncommitted \(\?\?\)/, "file status checked per file, untracked folders expanded");
  assert.match(t, /branch main/);
  assert.match(t, /codex resume 01a18000/);
});

test("handoff --out writes a file", () => {
  const s = sandbox();
  const out = path.join(s.root, "handoff.md");
  const r = s.run(["handoff", "claude:last", "--out", out]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(fs.readFileSync(out, "utf8"), /Parser written; tests still to do/);
});

test("archived Codex threads (zstd) are readable with --archived", { skip: typeof zlib.zstdCompressSync !== "function" }, () => {
  const s = sandbox();
  const list = JSON.parse(s.run(["sessions", "--json", "--archived", "--agent", "codex"]).stdout);
  const old = list.find((x) => x.archived);
  assert.ok(old, "archived thread listed");
  const r = s.run(["sessions", "show", old.id]);
  assert.match(r.stdout, /Old archived task/);
});

test("the calling agent's own session is excluded from last and search", () => {
  const s = sandbox();
  const r = s.run(["sessions", "show", "claude:last"], { env: { CLAUDE_CODE_SESSION_ID: IDS.claude } });
  assert.notEqual(r.status, 0, "only Claude chat is the caller's own");
  assert.match(r.stderr, /no Claude Code chats/);
});

test("search reads database-backed chats, not just their titles", { skip: !sqlite }, () => {
  const s = sandbox();
  assert.match(s.run(["sessions", "search", "public API"]).stdout, /opencode:/);
  assert.match(s.run(["sessions", "search", "TTL is never refreshed"]).stdout, /cursor:/);
});

test("rows still in a database's write-ahead log are read (OpenCode 2.x keeps new chats there)", { skip: !sqlite }, () => {
  const s = sandbox();
  const writer = new sqlite.DatabaseSync(path.join(s.home, ".local", "share", "opencode", "opencode.db"));
  try {
    writer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;");
    writer.prepare("INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated) VALUES (?, 'p1', NULL, 'x', ?, 'Fresh chat only in the WAL', '2.2.1', ?, ?)").run("ses_wal_only", s.repo, Date.now(), Date.now());
    for (const mode of ["node", "cli"]) {
      const r = s.run(["sessions", "--agent", "opencode", "--all"], { env: mode === "cli" ? { SWITCHBOARD_SQLITE: "cli" } : {} });
      assert.match(r.stdout, /Fresh chat only in the WAL/, `${mode}: ${r.stdout}${r.stderr}`);
    }
  } finally {
    writer.close();
  }
});

test("OpenCode 2.x session_message rows: quoted prompt cleaned, tools read, bookkeeping rows skipped", { skip: !sqlite }, () => {
  const s = sandbox();
  const db = new sqlite.DatabaseSync(path.join(s.home, ".local", "share", "opencode", "opencode.db"));
  try {
    db.exec("CREATE TABLE session_v2 (id TEXT, directory TEXT, title TEXT, parent_id TEXT, time_created INTEGER, time_updated INTEGER); CREATE TABLE session_message (session_id TEXT, seq INTEGER, type TEXT, data TEXT);");
    const now = Date.now();
    db.prepare("INSERT INTO session_v2 VALUES ('ses_v2', ?, 'Fix the adder', NULL, ?, ?)").run(s.repo, now, now);
    const rows = [
      ["synthetic", { time: { created: now }, text: "<system-reminder>plan mode</system-reminder>" }],
      ["user", { time: { created: now }, text: '"Fix the adder in math.mjs"' }],
      ["assistant", { time: { created: now }, model: { id: "free-model", providerID: "opencode" }, content: [
        { type: "text", text: "Looking at it." },
        { type: "tool", name: "bash", state: { status: "completed", input: { command: "node test.mjs" }, content: [{ type: "text", text: "fail" }] } },
        { type: "text", text: "Fixed: a - b is now a + b." },
      ] }],
      ["idle", { time: { created: now }, outcome: "succeeded" }],
    ];
    rows.forEach(([type, data], i) => db.prepare("INSERT INTO session_message VALUES ('ses_v2', ?, ?, ?)").run(i, type, JSON.stringify(data)));
  } finally {
    db.close();
  }
  const r = s.run(["sessions", "show", "opencode:ses_v2"]);
  assert.match(r.stdout, /Fix the adder in math\.mjs/);
  assert.doesNotMatch(r.stdout, /plan mode|"Fix the adder/);
  assert.match(r.stdout, /\$ node test\.mjs/);
  assert.match(r.stdout, /a - b is now a \+ b/);
  assert.match(r.stdout, /model free-model/);
  assert.doesNotMatch(r.stdout, /Install the opencode CLI/);
});

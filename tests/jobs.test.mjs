// Delegated jobs against fake agent CLIs: no network, no logins, no model usage.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { sandbox, jobId } from "./helpers.mjs";

const AGENTS = ["claude", "codex", "cursor", "opencode"];

for (const agent of AGENTS) {
  test(`${agent}: write job records git-measured changes, commands, and the final answer`, () => {
    const s = sandbox();
    const r = s.run(["run", agent, "--wait", "--wait-timeout", "60", "SCENARIO:edit make a file"]);
    assert.equal(r.status, 0, r.stderr);
    const id = jobId(r.stdout);
    assert.ok(id, r.stdout);
    assert.match(r.stdout, /Finished: .*=done/, r.stdout);
    const res = s.run(["result", id]).stdout;
    assert.match(res, /DONE/);
    assert.match(res, /Done \(edit\)/);
    assert.doesNotMatch(res, /I'll look|Checking\.|Looking\./, "narration before the last tool call is not the answer");
    assert.match(res, /\?\?\s+fake-output\.txt/);
    assert.match(res, /\[exit 0\] .*ls/);
    assert.match(res, /session: 00000000-fake/);
  });
}

test("write vs read-only flags per agent", () => {
  const s = sandbox();
  const flags = {};
  for (const agent of AGENTS) {
    for (const mode of ["write", "ask"]) {
      const r = s.run(["run", agent, "--mode", mode, "--wait", "--wait-timeout", "60", "SCENARIO:ok look"]);
      assert.equal(r.status, 0, r.stderr);
      flags[`${agent}:${mode}`] = s.lastRun(agent).args;
    }
  }
  assert.ok(flags["cursor:write"].includes("--force"));
  assert.ok(!flags["cursor:ask"].includes("--force") && flags["cursor:ask"].includes("ask"));
  assert.ok(flags["claude:write"].includes("--dangerously-skip-permissions"));
  assert.ok(flags["claude:ask"].includes("dontAsk") && !flags["claude:ask"].includes("--dangerously-skip-permissions"));
  assert.ok(flags["codex:write"].includes('sandbox_mode="workspace-write"'));
  assert.ok(flags["codex:ask"].includes('sandbox_mode="read-only"'));
  assert.ok(flags["opencode:write"].includes("--auto"));
  assert.ok(flags["opencode:ask"].includes("plan") && !flags["opencode:ask"].includes("--auto"));
  // Codex and Claude take the brief on stdin; it never appears in argv.
  assert.ok(!flags["codex:write"].some((a) => a.includes("SCENARIO")));
  assert.ok(!flags["claude:write"].some((a) => a.includes("SCENARIO")));
});

test("the brief carries the sub-agent rules, and the host agent's name", () => {
  const s = sandbox();
  const r = s.run(["run", "cursor", "--wait", "--wait-timeout", "60", "SCENARIO:ok task"], { env: { CLAUDECODE: "1" } });
  assert.equal(r.status, 0, r.stderr);
  const prompt = s.lastRun("cursor").args.at(-1);
  assert.match(prompt, /delegated sub-agent working for another coding agent \(Claude Code\)/);
  assert.match(prompt, /Do not git commit/);
});

test("a child claude never inherits the parent session's bare-mode variables", () => {
  const s = sandbox();
  const env = { CLAUDECODE: "1", CLAUDE_CODE_SIMPLE: "1", CLAUDE_CODE_ENTRYPOINT: "claude-desktop", ANTHROPIC_BASE_URL: "https://api.anthropic.com" };
  const doc = s.run(["doctor", "--json"], { env });
  const claude = JSON.parse(doc.stdout).agents.find((a) => a.agent === "claude");
  assert.equal(claude.login.ok, true, "auth check sees the real login");
  const r = s.run(["run", "claude", "--wait", "--wait-timeout", "60", "SCENARIO:ok"], { env });
  assert.equal(r.status, 0, r.stderr);
  const call = s.lastRun("claude");
  assert.equal(call.simple, null);
  assert.equal(call.claudecode, null);
});

test("failed jobs report the agent's own error", () => {
  const s = sandbox();
  for (const [agent, msg] of [["codex", /usage limit/], ["claude", /Not logged in/], ["cursor", /quota exceeded/], ["opencode", /no credentials/]]) {
    const r = s.run(["run", agent, "--wait", "--wait-timeout", "60", "SCENARIO:fail"]);
    const res = s.run(["result", jobId(r.stdout)]).stdout;
    assert.match(res, /FAILED/, `${agent}: ${res}`);
    assert.match(res, msg, `${agent}: ${res}`);
  }
});

test("pre-existing dirty files are not blamed on the job", () => {
  const s = sandbox();
  fs.writeFileSync(path.join(s.repo, "a.txt"), "user edit\n");
  const r = s.run(["run", "codex", "--wait", "--wait-timeout", "60", "SCENARIO:ok"]);
  assert.match(s.run(["result", jobId(r.stdout)]).stdout, /\(no file changes\)/);
});

test("a second in-place writer is refused; --worktree isolates it", () => {
  const s = sandbox();
  const a = s.run(["run", "codex", "SCENARIO:slow long task"]);
  assert.equal(a.status, 0, a.stderr);
  const b = s.run(["run", "claude", "SCENARIO:edit other"]);
  assert.notEqual(b.status, 0);
  assert.match(b.stderr, /already editing/);
  const c = s.run(["run", "claude", "--worktree", "--wait", "--wait-timeout", "60", "SCENARIO:edit isolated"]);
  assert.equal(c.status, 0, c.stderr);
  const res = s.run(["result", jobId(c.stdout)]).stdout;
  assert.match(res, /isolated git worktree, branch switchboard\//);
  assert.ok(!fs.existsSync(path.join(s.repo, "fake-output.txt")), "main checkout untouched");
  s.run(["cancel", jobId(a.stdout)]);
});

test("cancel stops the agent and the commands it started", async () => {
  const s = sandbox();
  const r = s.run(["run", "cursor", "SCENARIO:slow"]);
  const id = jobId(r.stdout);
  const pidFile = path.join(s.root, "child.pid");
  for (let i = 0; i < 100 && !fs.existsSync(pidFile); i++) await new Promise((x) => setTimeout(x, 100));
  const childPid = Number(fs.readFileSync(pidFile, "utf8"));
  assert.match(s.run(["cancel", id]).stdout, /Cancelling/);
  s.run(["wait", id, "--timeout", "20"]);
  assert.match(s.run(["status", id]).stdout, /cancelled/);
  await new Promise((x) => setTimeout(x, 500));
  assert.throws(() => process.kill(childPid, 0), "child process is gone");
});

test("resume continues the same session and keeps read-only mode", () => {
  const s = sandbox();
  const r = s.run(["run", "codex", "--mode", "ask", "--wait", "--wait-timeout", "60", "SCENARIO:ok first"]);
  const id = jobId(r.stdout);
  const again = s.run(["resume", id, "SCENARIO:ok follow up", "--wait", "--wait-timeout", "60"]);
  assert.equal(again.status, 0, again.stderr);
  const args = s.lastRun("codex").args;
  assert.ok(args.includes("resume") && args.some((a) => a.startsWith("00000000-fake")));
  assert.ok(args.includes('sandbox_mode="read-only"'));
});

test("review hands the diff to a read-only job", () => {
  const s = sandbox();
  fs.writeFileSync(path.join(s.repo, "a.txt"), "changed\n");
  const r = s.run(["review", "cursor", "--wait", "--wait-timeout", "60", "focus on edge cases"]);
  assert.equal(r.status, 0, r.stderr);
  const args = s.lastRun("cursor").args;
  assert.ok(!args.includes("--force"));
  assert.match(args.at(-1), /adversarial code reviewer/);
  assert.match(args.at(-1), /focus on edge cases/);
});

test("status, tail and cleanup", () => {
  const s = sandbox();
  const r = s.run(["run", "opencode", "--wait", "--wait-timeout", "60", "SCENARIO:ok"]);
  assert.match(s.run(["status"]).stdout, /done\s+opencode/);
  assert.match(s.run(["tail", jobId(r.stdout)]).stdout, /result success/);
  assert.match(s.run(["cleanup", "--days", "0"]).stdout, /Removed 1/);
});

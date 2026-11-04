// Delegated jobs against fake agent CLIs: no network, no logins, no model usage.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { sandbox, jobId } from "./helpers.mjs";
import { classifyError, retryHint } from "../skills/switchboard/scripts/lib/agents/common.mjs";

const AGENTS = ["claude", "codex", "cursor", "opencode", "antigravity"];

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

test("OpenCode 2.x gets its folder from the working directory and effort as model#variant; 1.x keeps --dir/--variant", () => {
  const s = sandbox();
  const args = (env) => {
    const r = s.run(["run", "opencode", "--model", "opencode/free-model-2.0", "--effort", "low", "--wait", "--wait-timeout", "60", "SCENARIO:ok"], { env });
    assert.equal(r.status, 0, r.stderr);
    const res = s.run(["result", jobId(r.stdout)]).stdout;
    assert.match(res, /DONE/, res);
    return s.lastRun("opencode").args;
  };
  const v2 = args({});
  assert.ok(v2.includes("opencode/free-model-2.0#low") && v2.includes("--standalone") && !v2.includes("--dir"), v2.join(" "));
  const v1 = args({ FAKE_OPENCODE_VERSION: "1.19.5" });
  assert.ok(v1.includes("--dir") && v1.includes("--variant") && v1.includes("opencode/free-model-2.0"), v1.join(" "));
  assert.match(s.run(["doctor", "--no-auth"]).stdout, /opencode 2\.2\.1\s/, "version shown once, without the name or v");
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
  for (const [agent, msg, kind] of [["codex", /usage limit/, "rate-limit"], ["claude", /Not logged in/, "not-logged-in"], ["cursor", /quota exceeded/, "rate-limit"], ["opencode", /Free usage limit reached \(fake\) \(retry in 83 min\)/, "rate-limit; retry in 83 min"], ["antigravity", /not recognized as a known model/, "model-gone"]]) {
    const r = s.run(["run", agent, "--wait", "--wait-timeout", "60", "SCENARIO:fail"]);
    assert.match(r.stdout, new RegExp(`=failed \\(${kind.split(";")[0]}\\)`), `${agent}: ${r.stdout}`);
    const res = s.run(["result", jobId(r.stdout)]).stdout;
    assert.match(res, /FAILED/, `${agent}: ${res}`);
    assert.match(res, msg, `${agent}: ${res}`);
    assert.ok(res.includes(`## Error (${kind})`), `${agent}: ${res}`);
    assert.match(res, /\nNext: /, `${agent}: ${res}`);
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

test("invalid --timeout fails before creating a job directory", () => {
  const s = sandbox();
  const jobs = path.join(s.home, ".switchboard", "jobs");
  const leftover = () => (fs.existsSync(jobs) ? fs.readdirSync(jobs) : []);
  for (const value of ["10m", "0", "-5"]) {
    const r = s.run(["run", "codex", "--timeout", value, "SECRET BRIEF about the payroll dump"]);
    assert.notEqual(r.status, 0, r.stderr);
    assert.match(r.stderr, /--timeout must be a positive number of seconds/, r.stderr);
    assert.deepEqual(leftover(), [], `timeout ${value} left ${leftover().join(",")}`);
  }
  const ok = s.run(["run", "codex", "--timeout", "30", "--wait", "--wait-timeout", "60", "SCENARIO:ok"]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.ok(jobId(ok.stdout));
});

test("cleanup removes old job dirs that have no job.json, not ones younger than a minute", () => {
  const s = sandbox();
  const jobs = path.join(s.home, ".switchboard", "jobs");
  const oldDir = path.join(jobs, "cx-0101-abcdef");
  const youngDir = path.join(jobs, "cx-0101-abc001");
  fs.mkdirSync(oldDir, { recursive: true });
  fs.writeFileSync(path.join(oldDir, "prompt.md"), "SECRET BRIEF about the payroll dump\n");
  const old = new Date(Date.now() - 120_000);
  fs.utimesSync(oldDir, old, old);
  fs.mkdirSync(youngDir, { recursive: true });
  fs.writeFileSync(path.join(youngDir, "prompt.md"), "in-flight brief\n");
  assert.match(s.run(["cleanup", "--days", "0"]).stdout, /Removed 1/);
  assert.equal(fs.existsSync(oldDir), false);
  assert.equal(fs.existsSync(youngDir), true);
});

test("review with invalid --timeout does not leave a diff behind", () => {
  const s = sandbox();
  fs.writeFileSync(path.join(s.repo, "a.txt"), "changed\n");
  const r = s.run(["review", "cursor", "--timeout", "10m", "focus on edge cases"]);
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /--timeout must be a positive number of seconds/, r.stderr);
  const jobs = path.join(s.home, ".switchboard", "jobs");
  assert.deepEqual(fs.existsSync(jobs) ? fs.readdirSync(jobs) : [], []);
  const reviews = path.join(s.home, ".switchboard", "review-inputs");
  assert.deepEqual(fs.existsSync(reviews) ? fs.readdirSync(reviews) : [], []);
});

test("one write lock per repository, not per folder", () => {
  const s = sandbox();
  fs.mkdirSync(path.join(s.repo, "pkg-a"));
  fs.mkdirSync(path.join(s.repo, "pkg-b"));
  const a = s.run(["run", "codex", "--cwd", path.join(s.repo, "pkg-a"), "SCENARIO:slow"]);
  assert.equal(a.status, 0, a.stderr);
  const b = s.run(["run", "cursor", "--cwd", path.join(s.repo, "pkg-b"), "SCENARIO:edit"]);
  assert.notEqual(b.status, 0);
  assert.match(b.stderr, /already editing/);
  s.run(["cancel", jobId(a.stdout)]);
});

test("a crashed supervisor leaves a live agent that cancel still stops", async () => {
  const s = sandbox();
  const r = s.run(["run", "cursor", "SCENARIO:slow"]);
  const id = jobId(r.stdout);
  const pidFile = path.join(s.root, "child.pid");
  for (let i = 0; i < 100 && !fs.existsSync(pidFile); i++) await new Promise((x) => setTimeout(x, 100));
  const job = JSON.parse(fs.readFileSync(path.join(s.home, ".switchboard", "jobs", id, "job.json"), "utf8"));
  process.kill(job.supervisorPid, "SIGKILL");
  await new Promise((x) => setTimeout(x, 300));
  const st = s.run(["status", id]).stdout;
  assert.match(st, /lost/);
  const again = s.run(["run", "claude", "SCENARIO:edit"]);
  assert.match(again.stderr, /already editing/, "an orphaned writer still holds the lock");
  assert.match(s.run(["cancel", id]).stdout, /stopped the agent/);
  await new Promise((x) => setTimeout(x, 500));
  const childPid = Number(fs.readFileSync(pidFile, "utf8"));
  assert.throws(() => process.kill(childPid, 0), "the agent's children are gone too");
});

test("each sub-agent gets only its own vendor's keys (OpenCode keeps provider keys)", () => {
  const s = sandbox();
  const env = { ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "o", CURSOR_API_KEY: "c", CLAUDE_CODE_OAUTH_TOKEN: "t", GEMINI_API_KEY: "g" };
  for (const agent of ["claude", "codex", "cursor", "opencode", "antigravity"]) s.run(["run", agent, "--mode", "ask", "--wait", "--wait-timeout", "60", "SCENARIO:ok"], { env });
  const seen = (agent) => s.lastRun(agent).keys.filter((k) => k in env); // ignore unrelated keys from this machine
  assert.deepEqual(seen("claude"), ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]);
  assert.deepEqual(seen("codex"), ["OPENAI_API_KEY"]);
  assert.deepEqual(seen("cursor"), ["CURSOR_API_KEY"]);
  assert.deepEqual(seen("opencode"), ["ANTHROPIC_API_KEY", "GEMINI_API_KEY", "OPENAI_API_KEY"]);
  assert.deepEqual(seen("antigravity"), ["GEMINI_API_KEY"]);
});

test("read-only Claude has no shell; Codex write mode pins network off", () => {
  const s = sandbox();
  s.run(["run", "claude", "--mode", "ask", "--wait", "--wait-timeout", "60", "SCENARIO:ok"]);
  const claude = s.lastRun("claude").args;
  assert.match(claude[claude.indexOf("--disallowedTools") + 1], /Bash/);
  s.run(["run", "codex", "--wait", "--wait-timeout", "60", "SCENARIO:ok"]);
  assert.ok(s.lastRun("codex").args.includes("sandbox_workspace_write.network_access=false"));
});

test("a raw prompt that starts with a dash is never read as a flag", () => {
  const s = sandbox();
  s.run(["run", "cursor", "--raw", "--mode", "ask", "--wait", "--wait-timeout", "60", "--", "--force SCENARIO:ok"]);
  const args = s.lastRun("cursor").args;
  assert.ok(!args.includes("--force"));
  assert.match(args.at(-1), /^Task:\n--force/);
});

test("resume restates the rules and re-checks the session's model against today's policy", () => {
  const s = sandbox();
  const r = s.run(["run", "cursor", "--model", "gpt-5.2", "--wait", "--wait-timeout", "60", "SCENARIO:ok"]);
  const id = jobId(r.stdout);
  const ok = s.run(["resume", id, "SCENARIO:ok more", "--wait", "--wait-timeout", "60"]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(s.lastRun("cursor").args.at(-1), /^Follow-up from the lead agent\. The rules from your first brief still apply/);
  s.run(["policy", "set", "cursor", "deny", "gpt-*"]);
  const no = s.run(["resume", id, "SCENARIO:ok again"]);
  assert.notEqual(no.status, 0);
  assert.match(no.stderr, /deny list/);
});

test("error kinds: the messages agents really print map to one label each", () => {
  const cases = [
    ["Credit balance is too low", "not-free"],
    ["Free usage limit reached. Upgrade or retry in ~78 min", "rate-limit"],
    ["You've hit your usage limit. Try again in 5 hours.", "rate-limit"],
    ["Not logged in · Please run /login", "not-logged-in"],
    ["'minimal' is not supported with the 'gpt-6-luna' model", "model-gone"],
    ["Model gpt-9 not found", "model-gone"],
    ["tests still fail after 3 attempts", "task-failed"],
  ];
  for (const [text, kind] of cases) assert.equal(classifyError(text), kind, text);
  assert.equal(retryHint("You've hit your usage limit. Try again in 5 hours."), "Try again in 5 hours");
  assert.equal(retryHint("no hint here"), null);
});

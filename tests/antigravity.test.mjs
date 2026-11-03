// Antigravity (agy): run flags, spend rules, failures, and its on-disk chats.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { sandbox, jobId, IDS, sqlite } from "./helpers.mjs";

const settingsOf = (args) => JSON.parse(args[args.indexOf("--settings") + 1]);
const runAg = (s, extra, opts) => s.run(["run", "antigravity", ...extra, "--wait", "--wait-timeout", "60"], opts);

test("antigravity: write runs sandboxed with .git protected; ask denies every write; user rules kept", () => {
  const s = sandbox();
  fs.mkdirSync(path.join(s.home, ".gemini", "antigravity-cli"), { recursive: true });
  fs.writeFileSync(path.join(s.home, ".gemini", "antigravity-cli", "settings.json"), JSON.stringify({ permissions: { deny: ["command(rm -rf)"], allow: ["command(git)"] } }));
  assert.equal(runAg(s, ["--mode", "write", "SCENARIO:ok"]).status, 0);
  const write = s.lastRun("antigravity").args;
  assert.ok(write.includes("--disable-slash-commands") && write.includes("stream-json"));
  assert.ok(!write.includes("--dangerously-skip-permissions"));
  const ws = settingsOf(write);
  assert.equal(ws.toolPermission, "proceed-in-sandbox");
  assert.equal(ws.enableTerminalSandbox, true);
  assert.equal(ws.agentMode, "accept-edits");
  assert.ok(ws.permissions.deny.some((d) => /^write_file\(\/.*\/\.git\)$/.test(d)), "absolute .git path (agy rejects relative ones)");
  assert.ok(ws.permissions.deny.includes("command(rm -rf)") && ws.permissions.allow.includes("command(git)"), "the user's own rules are not replaced");

  assert.equal(runAg(s, ["--mode", "ask", "SCENARIO:ok"]).status, 0);
  const ask = settingsOf(s.lastRun("antigravity").args);
  assert.ok(ask.permissions.deny.includes("write_file(*)"));
  assert.equal(ask.agentMode, undefined);
});

test("antigravity: spend=included turns AI credits off per run and refuses billed sign-ins", () => {
  const s = sandbox({ spend: "included" });
  assert.equal(runAg(s, ["SCENARIO:ok"]).status, 0);
  const args = s.lastRun("antigravity").args;
  assert.equal(settingsOf(args).useG1Credits, false);
  assert.ok(!args.includes("--model"), "no model named: Antigravity's own default");

  const adc = runAg(s, ["SCENARIO:ok"], { env: { AGY_ADC_AUTH: "true" } });
  assert.notEqual(adc.status, 0);
  assert.match(adc.stderr, /Google Cloud credentials.*spend=included/);
  fs.mkdirSync(path.join(s.home, ".gemini", "antigravity-cli"), { recursive: true });
  fs.writeFileSync(path.join(s.home, ".gemini", "antigravity-cli", "settings.json"), JSON.stringify({ modelProvider: "gemini" }));
  assert.match(runAg(s, ["SCENARIO:ok"]).stderr, /Gemini API key/);

  const any = sandbox({ spend: "any" });
  runAg(any, ["SCENARIO:ok"]);
  assert.equal(settingsOf(any.lastRun("antigravity").args).useG1Credits, undefined, "spend=any leaves the user's credit setting alone");
});

test("antigravity: flash:latest and family names resolve to the effort-suffixed id", () => {
  const s = sandbox();
  runAg(s, ["--model", "flash:latest", "--effort", "low", "SCENARIO:ok"]);
  let a = s.lastRun("antigravity").args;
  assert.equal(a[a.indexOf("--model") + 1], "gemini-3.8-flash-low");
  assert.ok(!a.includes("--effort"), "the effort is in the id");
  runAg(s, ["--model", "gemini-3.7-flash", "SCENARIO:ok"]);
  a = s.lastRun("antigravity").args;
  assert.equal(a[a.indexOf("--model") + 1], "gemini-3.7-flash-medium");
  runAg(s, ["--model", "claude-sonnet-4-6", "--effort", "high", "SCENARIO:ok"]);
  a = s.lastRun("antigravity").args;
  assert.equal(a[a.indexOf("--effort") + 1], "high", "models without an effort suffix take --effort");
  assert.notEqual(runAg(s, ["--model", "gemini-9-nope-high", "SCENARIO:ok"]).status, 0);
});

test("antigravity: a run that needed an approval it could not get is a failure that says so", () => {
  const s = sandbox();
  const r = runAg(s, ["SCENARIO:denied"]);
  assert.match(r.stdout, /=failed/);
  const res = s.run(["result", jobId(r.stdout)]).stdout;
  assert.match(res, /needed permission for command/);
  assert.match(res, /curl example\.invalid/, "the denied command is in the activity");
});

test("antigravity: lists the CLI chat (not its subagent runs) and reads it back", { skip: !sqlite }, () => {
  const s = sandbox();
  const list = s.run(["sessions", "--agent", "antigravity", "--all"]).stdout;
  assert.match(list, /antigravity:33333333\s+cli\s+.*Upload client retries/);
  assert.doesNotMatch(list, /A subagent run/);
  const show = s.run(["sessions", "show", "antigravity:last", "--outputs"]).stdout;
  assert.match(show, /Add retries to the upload client/);
  assert.match(show, /Reading the client first\./);
  assert.match(show, /npm test/);
  assert.match(show, /permission check failed/);
  assert.match(show, /upload\.ts/);
  assert.match(show, /Retries added; tests could not run in the sandbox\./);
  assert.match(s.run(["sessions", "search", "upload client"]).stdout, /antigravity:/);
  assert.match(s.run(["handoff", `antigravity:${IDS.antigravity.slice(0, 8)}`]).stdout, /Retries added/);
});

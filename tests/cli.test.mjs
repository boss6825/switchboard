// Help, typo hints, exit codes, and terminal-only styling.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sandbox } from "./helpers.mjs";

const ANSI = /\x1b\[/;

test("bare command and --help print the short overview, plain when piped", () => {
  const s = sandbox();
  for (const args of [[], ["--help"], ["-h"], ["help"]]) {
    const r = s.run(args);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Usage: switchboard <command> \[options\]/);
    assert.match(r.stdout, /switchboard <command> --help/);
    assert.doesNotMatch(r.stdout, ANSI);
  }
});

test("every command answers --help and -h without running", () => {
  const s = sandbox();
  for (const cmd of ["sessions", "chats", "handoff", "run", "delegate", "review", "resume", "status", "wait", "tail", "result", "cancel", "models", "cleanup", "policy", "doctor", "install", "uninstall"]) {
    const r = s.run([cmd, "--help"]);
    assert.equal(r.status, 0, `${cmd}: ${r.stderr}`);
    assert.match(r.stdout, /^switchboard \w+ — /, cmd);
    assert.match(r.stdout, /Usage:/, cmd);
  }
  assert.match(s.run(["tail", "-h"]).stdout, /-f, --follow/);
  assert.match(s.run(["help", "delegate"]).stdout, /^switchboard run — /);
});

test("help --all prints every command's page", () => {
  const r = sandbox().run(["help", "--all"]);
  assert.equal(r.status, 0);
  for (const cmd of ["sessions", "run", "policy", "uninstall"]) assert.match(r.stdout, new RegExp(`^switchboard ${cmd} — `, "m"));
});

test("--help after a -- is part of the task, not a help request", () => {
  const r = sandbox().run(["run", "codex", "--", "--help"]);
  assert.doesNotMatch(r.stdout, /^switchboard run — /);
});

test("version flags", () => {
  const s = sandbox();
  for (const f of ["-v", "--version", "version"]) assert.match(s.run([f]).stdout.trim(), /^\d+\.\d+\.\d+$/);
});

test("typos get a suggestion and exit 2; bad options point at the command's help", () => {
  const s = sandbox();
  const typo = s.run(["sesions"]);
  assert.equal(typo.status, 2);
  assert.match(typo.stderr, /Did you mean "sessions"\?/);
  assert.doesNotMatch(s.run(["zzzzzz"]).stderr, /Did you mean/);
  const bad = s.run(["status", "--bogus"]);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /unknown option --bogus\nRun: switchboard status --help/);
  const missing = s.run(["resume"]);
  assert.equal(missing.status, 2);
  // Ordinary failures stay exit 1.
  assert.equal(s.run(["result", "no-such-job"]).status, 1);
});

test("FORCE_COLOR styles output; NO_COLOR wins over a terminal", () => {
  const s = sandbox();
  assert.match(s.run(["--help"], { env: { FORCE_COLOR: "1" } }).stdout, ANSI);
  assert.doesNotMatch(s.run(["--help"], { env: { NO_COLOR: "1" } }).stdout, ANSI);
});

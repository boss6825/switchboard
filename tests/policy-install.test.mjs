// Model policy and the installer.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { sandbox, jobId } from "./helpers.mjs";

const startedModel = (out) => (out.match(/model=([^,)]+)/) || [])[1];

test("cursor grok:latest resolves to the newest non-fast Grok at the chosen effort", () => {
  const s = sandbox();
  s.run(["policy", "set", "cursor", "model", "grok:latest"]);
  const r = s.run(["run", "cursor", "--effort", "low", "--wait", "--wait-timeout", "60", "SCENARIO:ok"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(startedModel(r.stdout), "grok-4.7-low");
  const newer = s.run(["run", "cursor", "--effort", "high", "SCENARIO:ok"], { env: { FAKE_MODELS: "grok-4.7-high,grok-4.8-high,grok-4.8-high-fast", SWITCHBOARD_MODELS_TTL: "0" } });
  assert.equal(startedModel(newer.stdout), "grok-4.8-high");
  assert.match(newer.stdout, /grok 4\.8 is now the newest grok/);
});

test("lock: chooseModel=false refuses --model but allows effort; chooseEffort=false refuses effort", () => {
  const s = sandbox();
  s.run(["policy", "set", "cursor", "model", "grok:latest"]);
  s.run(["policy", "set", "cursor", "chooseModel", "false"]);
  const bad = s.run(["run", "cursor", "--model", "gpt-5.2", "SCENARIO:ok"]);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /locked .*do not pass --model/);
  assert.equal(s.run(["run", "cursor", "--effort", "xhigh", "--wait", "--wait-timeout", "60", "SCENARIO:ok"]).status, 0);
  s.run(["policy", "set", "cursor", "chooseEffort", "false"]);
  s.run(["policy", "set", "cursor", "effort", "medium"]);
  const eff = s.run(["run", "cursor", "--effort", "xhigh", "SCENARIO:ok"]);
  assert.match(eff.stderr, /locked .*effort/);
});

test("deny patterns block fast variants; allow lists restrict Claude to cheaper models", () => {
  const s = sandbox();
  s.run(["policy", "set", "cursor", "deny", "*-fast"]);
  const fast = s.run(["run", "cursor", "--model", "grok-4.7-high-fast", "SCENARIO:ok"]);
  assert.match(fast.stderr, /deny list/);
  s.run(["policy", "set", "claude", "allow", "sonnet", "haiku"]);
  const opus = s.run(["run", "claude", "--model", "opus", "SCENARIO:ok"]);
  assert.match(opus.stderr, /not in the user's allow list/);
  const ok = s.run(["run", "claude", "--model", "haiku", "--wait", "--wait-timeout", "60", "SCENARIO:ok"]);
  assert.equal(ok.status, 0, ok.stderr);
});

test("Claude's alias is checked again against the model it actually ran", () => {
  const s = sandbox();
  s.run(["policy", "set", "claude", "deny", "opus*"]);
  const r = s.run(["run", "claude", "--wait", "--wait-timeout", "60", "SCENARIO:slow"], { env: { FAKE_CLAUDE_MODEL: "claude-opus-5-5" } });
  const res = s.run(["result", jobId(r.stdout)]).stdout;
  assert.match(res, /FAILED/);
  assert.match(res, /policy: .*deny list/);
});

test("Codex family aliases and per-model effort checks", () => {
  const s = sandbox();
  const r = s.run(["run", "codex", "--model", "luna:latest", "--effort", "high", "--wait", "--wait-timeout", "60", "SCENARIO:ok"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(startedModel(r.stdout), "gpt-6-luna");
  const bad = s.run(["run", "codex", "--model", "gpt-5.6-luna", "--effort", "medium", "SCENARIO:ok"]);
  assert.match(bad.stderr, /does not offer effort "medium"/);
});

test("enabled=false keeps an agent off the team", () => {
  const s = sandbox();
  s.run(["policy", "set", "opencode", "enabled", "false"]);
  assert.match(s.run(["run", "opencode", "SCENARIO:ok"]).stderr, /turned off as a sub-agent/);
});

test("an existing cursor-bridge policy is imported once", () => {
  const s = sandbox();
  fs.mkdirSync(path.join(s.home, ".cursor-bridge"), { recursive: true });
  fs.writeFileSync(path.join(s.home, ".cursor-bridge", "config.json"), JSON.stringify({ model: "grok:latest", effort: "xhigh", lockModel: "true", allowFast: "false" }));
  const r = s.run(["policy"]);
  assert.match(r.stderr, /imported your Cursor model policy/);
  assert.match(r.stdout, /Cursor .*model=grok:latest .*effort=xhigh .*picks model: no .*deny=\*-fast/);
});

test("doctor reports installed CLIs, logins, chat stores, and missing agents", () => {
  const s = sandbox({ agents: ["claude", "codex", "cursor"] });
  const d = JSON.parse(s.run(["doctor", "--json"]).stdout);
  const by = Object.fromEntries(d.agents.map((a) => [a.agent, a]));
  assert.equal(by.codex.login.ok, true);
  assert.equal(by.cursor.login.ok, true);
  assert.equal(by.opencode.bin, null);
  const text = s.run(["doctor"]).stdout;
  assert.match(text, /OpenCode\s+not installed/);
  assert.match(text, /Switchboard skill not installed/);
});

test("install puts one self-contained copy where each agent looks, then uninstall removes only its own", () => {
  const s = sandbox();
  const dry = s.run(["install", "--dry-run"]);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /\.claude\/skills\/switchboard .*Claude Code/);
  assert.match(dry.stdout, /\.agents\/skills\/switchboard .*Codex/);
  assert.match(dry.stdout, /dry run/);
  assert.ok(!fs.existsSync(path.join(s.home, ".claude", "skills", "switchboard")));

  fs.mkdirSync(path.join(s.home, ".local", "bin"), { recursive: true });
  const r = s.run(["install"]);
  assert.equal(r.status, 0, r.stderr);
  for (const d of [".claude/skills/switchboard", ".agents/skills/switchboard", ".switchboard/app"]) {
    assert.ok(fs.existsSync(path.join(s.home, d, "SKILL.md")), `${d}/SKILL.md`);
    assert.ok(fs.existsSync(path.join(s.home, d, "scripts", "switchboard.mjs")), `${d} has the CLI`);
  }
  assert.ok(!fs.existsSync(path.join(s.home, ".cursor", "skills", "switchboard")), "Cursor reads ~/.claude/skills; no extra copy");
  const shim = path.join(s.home, ".local", "bin", "switchboard");
  assert.ok(fs.lstatSync(shim).isSymbolicLink());

  // The installed copy runs on its own.
  const installed = path.join(s.home, ".claude", "skills", "switchboard", "scripts", "switchboard.mjs");
  const v = s.run(["--version"]);
  assert.equal(v.stdout.trim(), JSON.parse(fs.readFileSync(path.join(s.home, ".claude", "skills", "switchboard", ".switchboard-install.json"))).version);
  assert.ok(fs.statSync(installed).mode & 0o100);

  const doc = JSON.parse(s.run(["doctor", "--json", "--no-auth"]).stdout);
  assert.ok(doc.agents.every((a) => a.skill.length), "every agent now sees the skill");

  // A folder of the same name that Switchboard did not create is left alone.
  fs.rmSync(path.join(s.home, ".agents", "skills", "switchboard"), { recursive: true });
  fs.mkdirSync(path.join(s.home, ".agents", "skills", "switchboard"));
  assert.match(s.run(["install"]).stderr, /not created by Switchboard/);

  const u = s.run(["uninstall"]);
  assert.equal(u.status, 0, u.stderr);
  assert.ok(!fs.existsSync(path.join(s.home, ".claude", "skills", "switchboard")));
  assert.ok(fs.existsSync(path.join(s.home, ".agents", "skills", "switchboard")), "foreign folder kept");
  assert.ok(!fs.existsSync(shim));
});

test("install works when run from inside node_modules (npx)", () => {
  const s = sandbox({ agents: ["codex"] });
  const pkg = path.join(s.root, "npx-cache", "node_modules", "switchboard-agents");
  fs.mkdirSync(pkg, { recursive: true });
  fs.cpSync(path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "skills"), path.join(pkg, "skills"), { recursive: true });
  const { spawnSync } = process.getBuiltinModule("node:child_process");
  const r = spawnSync(process.execPath, [path.join(pkg, "skills", "switchboard", "scripts", "switchboard.mjs"), "install"], { cwd: s.repo, env: s.env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(s.home, ".agents", "skills", "switchboard", "scripts", "lib", "jobs.mjs")));
});

test("install only for named agents", () => {
  const s = sandbox();
  const r = s.run(["install", "--agents", "codex", "--dry-run"]);
  assert.match(r.stdout, /\.agents\/skills\/switchboard/);
  assert.doesNotMatch(r.stdout, /\.claude\/skills/);
});

test("Claude's allow list is checked against the model it actually ran, not the alias", () => {
  const s = sandbox();
  s.run(["policy", "set", "claude", "allow", "sonnet", "haiku"]);
  const r = s.run(["run", "claude", "--model", "sonnet", "--wait", "--wait-timeout", "60", "SCENARIO:slow"], { env: { FAKE_CLAUDE_MODEL: "claude-opus-5-5" } });
  const res = s.run(["result", jobId(r.stdout)]).stdout;
  assert.match(res, /FAILED/);
  assert.match(res, /not in the user's allow list/);
});

test("a deny list needs a named model where the agent's default can't be checked; Cursor auto is refused", () => {
  const s = sandbox();
  s.run(["policy", "set", "cursor", "deny", "*-fast"]);
  assert.match(s.run(["run", "cursor", "SCENARIO:ok"]).stderr, /deny list but no default model/);
  assert.match(s.run(["run", "cursor", "--model", "auto", "SCENARIO:ok"]).stderr, /picks a model by itself/);
  s.run(["policy", "set", "cursor", "model", "grok:latest"]);
  assert.equal(s.run(["run", "cursor", "--wait", "--wait-timeout", "60", "SCENARIO:ok"]).status, 0);
});

test("reinstalling from an installed copy works, and a foreign shim is left alone", () => {
  const s = sandbox({ agents: ["claude"] });
  fs.mkdirSync(path.join(s.home, ".local", "bin"), { recursive: true });
  fs.writeFileSync(path.join(s.home, ".local", "bin", "switchboard"), "#!/bin/sh\necho old\n");
  assert.equal(s.run(["install"]).status, 0);
  const installed = path.join(s.home, ".claude", "skills", "switchboard", "scripts", "switchboard.mjs");
  const { spawnSync } = process.getBuiltinModule("node:child_process");
  const r = spawnSync(process.execPath, [installed, "install"], { cwd: s.repo, env: s.env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /left it alone/);
  assert.ok(fs.existsSync(installed), "the copy it ran from is still there");
  assert.equal(fs.readFileSync(path.join(s.home, ".local", "bin", "switchboard"), "utf8"), "#!/bin/sh\necho old\n");
});

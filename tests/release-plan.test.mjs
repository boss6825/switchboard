// What lands on npm: a marked commit bumps the version, a README edit does not.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyVersion, classify, githubPackageJson, planRelease, versionFrom } from "../scripts/release-plan.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const script = path.join(root, "scripts", "release-plan.mjs");

const commit = (subject, body = "") => ({ subject, body });

test("the version files in the repo agree", () => {
  assert.match(versionFrom(root), /^\d+\.\d+\.\d+$/);
});

test("ordinary sentences and docs commits do not publish", () => {
  for (const subject of [
    "Add Antigravity (agy) as a fifth agent",
    "Fix the findings from a self-review on Cursor (Grok)",
    "Revise README for clarity and emphasis on collaboration features",
    "docs: rewrite the install section",
    "chore: ignore a generated image",
    "Release 0.1.1: npm package switchboard-pro, short sw command, CLI help",
  ]) {
    assert.equal(classify(commit(subject)), null, subject);
  }
  const plan = planRelease({
    version: "0.1.1",
    commits: [commit("Revise README for clarity")],
  });
  assert.equal(plan.release, false);
  assert.match(plan.reason, /No feat, fix, perf/);
});

test("feat, fix, and perf choose one bump, and the biggest one wins", () => {
  assert.equal(classify(commit("fix: correct the sqlite fallback")).kind, "patch");
  assert.equal(classify(commit("perf: read fewer session rows")).kind, "patch");
  assert.equal(classify(commit("feat: add Antigravity")).kind, "minor");
  const plan = planRelease({
    version: "0.1.1",
    commits: [commit("fix: correct the sqlite fallback"), commit("feat: add Antigravity")],
  });
  assert.deepEqual(
    { release: plan.release, next: plan.next, level: plan.level },
    { release: true, next: "0.2.0", level: "minor" },
  );
  assert.match(plan.notes, /feat: add Antigravity/);
});

test("a breaking change stays below 1.0.0 unless the commit or the workflow asks for major", () => {
  const breaking = planRelease({
    version: "0.1.1",
    commits: [commit("feat!: drop the old install path")],
  });
  assert.equal(breaking.next, "0.2.0");
  const body = planRelease({
    version: "0.1.1",
    commits: [commit("fix: reject the old config", "BREAKING CHANGE: config.json keys moved")],
  });
  assert.equal(body.next, "0.2.0");
  const asked = planRelease({
    version: "0.1.1",
    commits: [commit("Add the fifth agent", "Ship it.\n\n[release major]")],
  });
  assert.equal(asked.next, "1.0.0");
  const afterOne = planRelease({
    version: "1.4.2",
    commits: [commit("feat!: drop the old install path")],
  });
  assert.equal(afterOne.next, "2.0.0");
});

test("[release] marks a sentence-style commit, and a hand-picked level overrides it", () => {
  assert.equal(planRelease({ version: "0.1.1", commits: [commit("Add Antigravity [release]")] }).next, "0.1.2");
  assert.equal(planRelease({ version: "0.1.1", commits: [commit("Add Antigravity", "[release minor]")] }).next, "0.2.0");
  const forced = planRelease({
    version: "0.1.1",
    level: "patch",
    commits: [commit("Revise README for clarity")],
  });
  assert.equal(forced.next, "0.1.2");
  assert.match(forced.notes, /Release workflow/);
  assert.equal(planRelease({ version: "0.1.1", level: "major", commits: [] }).next, "1.0.0");
});

test("the first run only marks the published version, and an existing tag is not published again", () => {
  const first = planRelease({ version: "0.1.1", commits: [commit("feat: add Antigravity")], hasBaselineTag: false });
  assert.equal(first.baseline, true);
  assert.equal(first.release, false);
  const again = planRelease({
    version: "0.1.1",
    commits: [commit("fix: correct the sqlite fallback")],
    nextAlreadyTagged: true,
  });
  assert.equal(again.release, false);
  assert.match(again.reason, /already tagged/);
});

test("applyVersion updates every copy and leaves the rest of the file alone", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-release-"));
  fs.mkdirSync(path.join(dir, "skills/switchboard/scripts/lib"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".claude-plugin"), { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), '{\n  "name": "switchboard-pro",\n  "version": "0.1.1",\n  "description": "keep me"\n}\n');
  fs.writeFileSync(path.join(dir, "skills/switchboard/scripts/lib/config.mjs"), 'export const VERSION = "0.1.1";\nexport const SB_HOME = "keep";\n');
  fs.writeFileSync(path.join(dir, ".claude-plugin/plugin.json"), '{\n  "name": "switchboard",\n  "version": "0.1.1"\n}\n');
  fs.writeFileSync(path.join(dir, ".claude-plugin/marketplace.json"), '{\n  "plugins": [\n    {\n      "name": "switchboard",\n      "version": "0.1.1"\n    }\n  ]\n}\n');
  applyVersion(dir, "0.2.0");
  assert.equal(versionFrom(dir), "0.2.0");
  assert.match(fs.readFileSync(path.join(dir, "package.json"), "utf8"), /"description": "keep me"/);
  assert.match(fs.readFileSync(path.join(dir, "skills/switchboard/scripts/lib/config.mjs"), "utf8"), /SB_HOME = "keep"/);
});

test("version files that disagree are refused", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-release-"));
  fs.mkdirSync(path.join(dir, "skills/switchboard/scripts/lib"), { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), '{\n  "version": "0.1.1"\n}\n');
  fs.writeFileSync(path.join(dir, "skills/switchboard/scripts/lib/config.mjs"), 'export const VERSION = "0.1.0";\n');
  assert.throws(() => versionFrom(dir), /config\.mjs is 0\.1\.0/);
});

test("the GitHub package is the scoped mirror of the same tarball", () => {
  const pkg = githubPackageJson({ name: "switchboard-pro", version: "0.2.0", bin: { sw: "skills/switchboard/scripts/switchboard.mjs" } });
  assert.equal(pkg.name, "@boss6825/switchboard-pro");
  assert.equal(pkg.version, "0.2.0");
  assert.equal(pkg.repository.url, "https://github.com/boss6825/switchboard.git");
  assert.equal(pkg.publishConfig.registry, "https://npm.pkg.github.com");
});

function gitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-release-git-"));
  // Use the machine's git identity when it has one. A local commit hook rejects
  // any other author; GitHub Actions has neither that hook nor an identity.
  const email = spawnSync("git", ["config", "user.email"], { encoding: "utf8" }).stdout.trim();
  const env = email
    ? process.env
    : {
        ...process.env,
        GIT_AUTHOR_NAME: "ci",
        GIT_AUTHOR_EMAIL: "ci@example.invalid",
        GIT_COMMITTER_NAME: "ci",
        GIT_COMMITTER_EMAIL: "ci@example.invalid",
      };
  const run = (args) => {
    const result = spawnSync("git", args, { cwd: dir, env, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  };
  run(["init", "-q", "-b", "main"]);
  fs.writeFileSync(path.join(dir, "package.json"), '{\n  "name": "switchboard-pro",\n  "version": "0.1.1"\n}\n');
  run(["add", "package.json"]);
  run(["commit", "-qm", "Release 0.1.1: already on npm"]);
  return { dir, env, run };
}

test("the command reads git history: baseline first, then the next feat commit", () => {
  const repo = gitRepo();
  const planOf = (level = "auto") => {
    const result = spawnSync(process.execPath, [script, "--level", level], { cwd: repo.dir, env: repo.env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const first = planOf();
  assert.equal(first.baseline, true);
  assert.equal(first.release, false);

  repo.run(["tag", "-a", "v0.1.1", "-m", "0.1.1"]);
  fs.writeFileSync(path.join(repo.dir, "README.md"), "docs\n");
  repo.run(["add", "README.md"]);
  repo.run(["commit", "-qm", "Revise README for clarity"]);
  assert.equal(planOf().release, false);

  fs.writeFileSync(path.join(repo.dir, "README.md"), "feature\n");
  repo.run(["add", "README.md"]);
  repo.run(["commit", "-qm", "feat: add Antigravity"]);
  const shipped = planOf();
  assert.equal(shipped.release, true);
  assert.equal(shipped.next, "0.2.0");

  // The tag for that version exists, but not on this commit, the way a re-run
  // sees it after a previous attempt tagged the release and this checkout is older.
  repo.run(["checkout", "-q", "--detach", "v0.1.1"]);
  repo.run(["commit", "-q", "--allow-empty", "-m", "side"]);
  repo.run(["tag", "v0.2.0"]);
  repo.run(["checkout", "-q", "main"]);
  const repeat = planOf();
  assert.equal(repeat.release, false);
  assert.match(repeat.reason, /already tagged/);
});

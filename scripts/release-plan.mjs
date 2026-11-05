// Decide whether a push to main should publish switchboard-pro, and write the
// new version into every file that carries it.
//
// A push publishes only when a commit since the last v* tag asks for it:
//   feat: ...                         minor (0.1.1 -> 0.2.0)
//   fix: ...  or  perf: ...           patch
//   feat!: ...  or  BREAKING CHANGE   minor while the version is 0.x, major after 1.0.0
//   [release]                         patch
//   [release minor] / [release major] that bump, including 1.0.0 from a 0.x version
// README edits and ordinary sentences ("Add Antigravity", "Fix the findings")
// do not publish. The Actions workflow can also be run by hand with patch,
// minor, or major, which publishes even when the commits say nothing.
//
// The first push, before any v* tag exists, only tags the current version.
// 0.1.1 is already on npm; that tag is the line later commits are measured from.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const GITHUB_PACKAGE = "@boss6825/switchboard-pro";
const VERSION_FILES = [
  "package.json",
  "skills/switchboard/scripts/lib/config.mjs",
  ".claude-plugin/plugin.json",
  ".claude-plugin/marketplace.json",
];
const RANK = { patch: 1, minor: 2, major: 3 };

const versionIn = (text) => text.match(/"version": "(\d+\.\d+\.\d+)"/)?.[1];

export function versionFrom(root) {
  const pkgPath = path.join(root, "package.json");
  const pkg = versionIn(fs.readFileSync(pkgPath, "utf8"));
  if (!pkg) throw new Error("package.json has no x.y.z version");
  const configPath = path.join(root, "skills/switchboard/scripts/lib/config.mjs");
  if (fs.existsSync(configPath)) {
    const source = fs.readFileSync(configPath, "utf8").match(/export const VERSION = "(\d+\.\d+\.\d+)";/)?.[1];
    if (source !== pkg) throw new Error(`config.mjs is ${source || "missing a version"}, package.json is ${pkg}`);
  }
  for (const rel of [".claude-plugin/plugin.json", ".claude-plugin/marketplace.json"]) {
    const file = path.join(root, rel);
    if (!fs.existsSync(file)) continue;
    const found = versionIn(fs.readFileSync(file, "utf8"));
    if (found !== pkg) throw new Error(`${rel} is ${found || "missing a version"}, package.json is ${pkg}`);
  }
  return pkg;
}

export function applyVersion(root, version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`unsupported version ${version}`);
  for (const rel of VERSION_FILES) {
    const file = path.join(root, rel);
    const text = fs.readFileSync(file, "utf8");
    const next = rel.endsWith("config.mjs")
      ? text.replace(/export const VERSION = "\d+\.\d+\.\d+";/, `export const VERSION = "${version}";`)
      : text.replace(/"version": "\d+\.\d+\.\d+"/, `"version": "${version}"`);
    if (next === text) throw new Error(`${rel} has no version to update`);
    fs.writeFileSync(file, next);
  }
}

export function bumpVersion(version, level) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match || !RANK[level]) throw new Error(`cannot bump ${version} by ${level}`);
  let [major, minor, patch] = match.slice(1).map(Number);
  if (level === "major") [major, minor, patch] = [major + 1, 0, 0];
  else if (level === "minor") [minor, patch] = [minor + 1, 0];
  else patch += 1;
  return `${major}.${minor}.${patch}`;
}

// null when the commit should not ship a version. explicitMajor is a request
// for 1.0.0 even while the package is still 0.x.
export function classify(commit) {
  const subject = commit.subject || "";
  const body = commit.body || "";
  if (/^Release\s+\d+\.\d+\.\d+\b/.test(subject)) return null;
  const tag = `${subject}\n${body}`.match(/\[release(?:\s+(patch|minor|major))?\]/i);
  if (tag) {
    const kind = (tag[1] || "patch").toLowerCase();
    return { kind, explicitMajor: kind === "major" };
  }
  const header = subject.match(/^(feat|fix|perf)(\([^)]+\))?(!)?: .+/);
  if (!header) return null;
  const breaking = header[3] === "!" || /^BREAKING CHANGE:/m.test(body);
  if (breaking) return { kind: "major", explicitMajor: false };
  return { kind: header[1] === "feat" ? "minor" : "patch", explicitMajor: false };
}

export function planRelease({ version, commits = [], level = "auto", hasBaselineTag = true, nextAlreadyTagged = false }) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`unsupported version ${version}`);
  if (level !== "auto" && !RANK[level]) throw new Error(`unsupported level ${level}`);
  if (!hasBaselineTag && level === "auto") {
    return {
      release: false,
      baseline: true,
      version,
      next: null,
      level: null,
      reason: `No release tag yet. Mark v${version} as already published and wait for the next change.`,
      notes: "",
      commits: [],
    };
  }

  const matched = [];
  for (const commit of commits) {
    const found = classify(commit);
    if (found) matched.push({ subject: commit.subject, ...found });
  }
  const requested = level === "auto" ? null : level;
  const bump = requested || (matched.length ? matched.reduce((best, item) => (RANK[item.kind] > RANK[best] ? item.kind : best), "patch") : null);
  if (!bump) {
    return {
      release: false,
      baseline: false,
      version,
      next: null,
      level: null,
      reason: "No feat, fix, perf, or [release] commit since the last tag.",
      notes: "",
      commits: [],
    };
  }

  const major = Number(version.split(".")[0]);
  const explicitMajor = level === "major" || matched.some((item) => item.explicitMajor);
  const applied = bump === "major" && major === 0 && !explicitMajor ? "minor" : bump;
  const next = bumpVersion(version, applied);
  const subjects = matched.map((item) => item.subject);
  const notes = (subjects.length ? subjects.map((subject) => `- ${subject}`) : [`- Version bump (${applied}) from the Release workflow.`]).join("\n");
  if (nextAlreadyTagged) {
    return {
      release: false,
      baseline: false,
      version,
      next,
      level: applied,
      reason: `v${next} is already tagged.`,
      notes,
      commits: subjects,
    };
  }
  return {
    release: true,
    baseline: false,
    version,
    next,
    level: applied,
    reason: `${applied} bump from ${version} to ${next}.`,
    notes,
    commits: subjects,
  };
}

// The copy GitHub Packages receives. The npm package stays unscoped
// switchboard-pro; GitHub's registry only accepts a scoped name, and that
// scoped package is what shows on the repository page.
export function githubPackageJson(pkg) {
  return {
    ...pkg,
    name: GITHUB_PACKAGE,
    repository: { type: "git", url: "https://github.com/boss6825/switchboard.git" },
    publishConfig: { registry: "https://npm.pkg.github.com", access: "public" },
  };
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" });
}

function latestTag() {
  try {
    return git(["describe", "--tags", "--abbrev=0", "--match", "v[0-9]*"]).trim();
  } catch {
    return null;
  }
}

function tagExists(name) {
  return git(["tag", "-l", name]).trim() === name;
}

function commitsSince(tag) {
  const args = ["log", "--format=%s%x1f%b%x1e"];
  if (tag) args.push(`${tag}..HEAD`);
  return git(args)
    .split("\x1e")
    .map((record) => {
      const [subject, body] = record.split("\x1f");
      return { subject: (subject || "").trim(), body: (body || "").trim() };
    })
    .filter((commit) => commit.subject);
}

function writeGithubOutput(plan) {
  if (!process.env.GITHUB_OUTPUT) return;
  const lines = [
    `release=${plan.release ? "true" : "false"}`,
    `baseline=${plan.baseline ? "true" : "false"}`,
    `version=${plan.version}`,
    `next=${plan.next || ""}`,
    `level=${plan.level || ""}`,
    `reason=${plan.reason.replace(/\n/g, " ")}`,
  ];
  if (plan.notes) lines.push("notes<<RELEASE_NOTES", plan.notes, "RELEASE_NOTES");
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
}

function runCli() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log("usage: node scripts/release-plan.mjs [--level auto|patch|minor|major]\n       node scripts/release-plan.mjs --apply <x.y.z>");
    return;
  }
  const applyAt = args.indexOf("--apply");
  if (applyAt !== -1) {
    applyVersion(process.cwd(), args[applyAt + 1]);
    return;
  }
  const levelAt = args.indexOf("--level");
  const level = levelAt === -1 ? "auto" : args[levelAt + 1];
  const version = versionFrom(process.cwd());
  const tag = latestTag();
  const commits = tag || level !== "auto" ? commitsSince(tag) : [];
  let plan = planRelease({ version, commits, level, hasBaselineTag: Boolean(tag) });
  if (plan.next && tagExists(`v${plan.next}`)) {
    plan = { ...plan, release: false, reason: `v${plan.next} is already tagged.` };
  }
  writeGithubOutput(plan);
  console.log(JSON.stringify(plan, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runCli();

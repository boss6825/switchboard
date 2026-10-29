// Git snapshots, so a job's file changes are measured rather than taken from
// the agent's own report, even when the checkout was already dirty.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export function git(cwd, args, opts = {}) {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });
  return r.status === 0 ? r.stdout : null;
}

export function repoRoot(cwd) {
  const out = git(cwd, ["rev-parse", "--show-toplevel"]);
  return out ? out.trim() : null;
}

export function snapshot(dir) {
  const root = repoRoot(dir);
  if (!root) return null;
  const head = (git(root, ["rev-parse", "HEAD"]) || "").trim() || null;
  const porcelain = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]) || "";
  const files = {};
  const parts = porcelain.split("\0").filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    const code = entry.slice(0, 2);
    files[entry.slice(3)] = code;
    if (code[0] === "R" || code[0] === "C") i++; // skip the rename source
  }
  const paths = Object.keys(files).slice(0, 2000);
  const hashes = {};
  const existing = paths.filter((p) => {
    try {
      return fs.statSync(path.join(root, p)).isFile();
    } catch {
      return false;
    }
  });
  if (existing.length) {
    const out = git(root, ["hash-object", "--", ...existing]);
    if (out) out.trim().split("\n").forEach((h, i) => (hashes[existing[i]] = h));
  }
  return { root, head, files, hashes };
}

export function diffSnapshots(before, after) {
  if (!before || !after) return null;
  const changed = [];
  for (const f of new Set([...Object.keys(before.files), ...Object.keys(after.files)])) {
    const b = before.files[f];
    const a = after.files[f];
    if (b !== a || before.hashes[f] !== after.hashes[f]) changed.push({ file: f, status: (a || "  ").trim() || "clean" });
  }
  let commits = [];
  if (before.head && after.head && before.head !== after.head) {
    const log = git(after.root, ["log", "--oneline", `${before.head}..${after.head}`]);
    commits = log ? log.trim().split("\n").filter(Boolean) : [`HEAD moved ${before.head.slice(0, 8)} -> ${after.head.slice(0, 8)}`];
  }
  return { changed: changed.sort((x, y) => x.file.localeCompare(y.file)), commits };
}

export function defaultBranch(root) {
  const head = git(root, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (head) return head.trim();
  for (const b of ["origin/main", "origin/master", "main", "master"]) if (git(root, ["rev-parse", "--verify", "--quiet", b])) return b;
  return null;
}

// Short "what does this checkout look like right now" block for handoffs.
export function workspaceState(dir) {
  if (!dir || !fs.existsSync(dir)) return { exists: false };
  const root = repoRoot(dir);
  if (!root) return { exists: true, git: false };
  return {
    exists: true,
    git: true,
    root,
    branch: (git(root, ["branch", "--show-current"]) || "").trim() || "(detached)",
    head: (git(root, ["log", "-1", "--format=%h %s (%cr)"]) || "").trim(),
    status: (git(root, ["status", "--short"]) || "").trimEnd(),
    // Per-file view (untracked folders expanded), for "is this file still changed?"
    statusAll: (git(root, ["status", "--porcelain=v1", "--untracked-files=all"]) || "").trimEnd(),
    diffStat: (git(root, ["diff", "--stat", "HEAD"]) || "").trim().split("\n").slice(-1)[0] || "",
  };
}

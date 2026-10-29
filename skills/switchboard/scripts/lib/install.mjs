// doctor: what is installed, logged in, and readable on this machine.
// install / uninstall: put the Switchboard skill where each detected agent looks.

import fs from "node:fs";
import path from "node:path";
import { allAgents, agent as getAgent } from "./agents/index.mjs";
import { describePolicy } from "./policy.mjs";
import { SB_HOME, VERSION } from "./config.mjs";
import { home, exists, isDir, tilde, parseArgs, readJSON, writeJSON, die, table } from "./util.mjs";

const SKILL = "switchboard";
const MARKER = ".switchboard-install.json";

// Folders each agent reads user-level skills from (verified against each
// agent's docs, October 2026). Cursor and OpenCode also read Claude's and the
// shared ~/.agents folder, so one copy there can serve several agents.
export function skillDirs(name) {
  const codexHome = process.env.CODEX_HOME || home(".codex");
  const opencodeCfg = path.join(process.env.XDG_CONFIG_HOME || home(".config"), "opencode");
  return {
    claude: [path.join(process.env.CLAUDE_CONFIG_DIR || home(".claude"), "skills")],
    codex: [home(".agents", "skills"), path.join(codexHome, "skills")],
    cursor: [home(".cursor", "skills"), home(".agents", "skills"), home(".claude", "skills"), path.join(codexHome, "skills")],
    opencode: [path.join(opencodeCfg, "skills"), home(".claude", "skills"), home(".agents", "skills")],
  }[name];
}

const CONFIG_DIRS = {
  claude: () => process.env.CLAUDE_CONFIG_DIR || home(".claude"),
  codex: () => process.env.CODEX_HOME || home(".codex"),
  cursor: () => home(".cursor"),
  opencode: () => path.join(process.env.XDG_DATA_HOME || home(".local", "share"), "opencode"),
};

function skillSource() {
  // This file is skills/switchboard/scripts/lib/install.mjs
  return path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
}

function detect(a, { auth = true } = {}) {
  const bin = a.bin();
  const desktop = a.desktop();
  const cfg = CONFIG_DIRS[a.name]();
  let login = { ok: null, detail: "-" };
  if (bin && auth) {
    try {
      login = a.auth();
    } catch (e) {
      login = { ok: null, detail: e.message };
    }
  }
  let stores = [];
  try {
    stores = a.sessions.stores();
  } catch {}
  const installedIn = skillDirs(a.name).filter((d) => exists(path.join(d, SKILL, "SKILL.md")));
  return {
    agent: a.name,
    label: a.label,
    present: !!(bin || desktop || isDir(cfg)),
    bin,
    version: bin ? a.version() : null,
    login,
    desktop,
    stores,
    skill: installedIn,
  };
}

function storeText(stores) {
  return stores
    .filter((s) => s.count)
    .map((s) => (typeof s.count === "number" ? `${s.count}${s.archived ? ` (+${s.archived} archived)` : ""}${s.cli != null ? ` (${s.cli} from CLI)` : ""}` : s.count))
    .join(", ") || "none";
}

export function cmdDoctor(argv) {
  const o = parseArgs(argv, { json: "bool", "no-auth": "bool" });
  const rows = allAgents().map((a) => detect(a, { auth: !o["no-auth"] }));
  if (o.json) return console.log(JSON.stringify({ version: VERSION, node: process.version, home: SB_HOME, agents: rows }, null, 2));

  console.log(`Switchboard ${VERSION} · node ${process.version} · ${process.platform} · state in ${tilde(SB_HOME)}\n`);
  const mark = (v) => (v === true ? "yes" : v === false ? "NO" : "?");
  console.log(
    table(
      rows.map((r) => [
        r.label,
        r.bin ? `${path.basename(r.bin)} ${r.version || ""}`.trim() : "not installed",
        r.bin ? `${mark(r.login.ok)}` : "-",
        r.desktop ? "yes" : "-",
        storeText(r.stores),
        r.skill.length ? r.skill.map(tilde).join(", ") : "-",
      ]),
      ["Agent", "CLI", "CLI login", "Desktop app", "Chats on disk", "Switchboard skill"],
    ),
  );

  const todo = [];
  for (const r of rows) {
    const a = getAgent(r.agent);
    if (!r.present) continue;
    if (!r.bin) todo.push(`${r.label}: ${r.desktop ? "the desktop app is installed but the CLI is not. " : ""}Switchboard drives agents through their CLI. Install it: ${a.installHint}`);
    else if (r.login.ok === false) todo.push(`${r.label}: ${r.login.detail} Log in: ${a.loginHint}`);
    else if (r.login.ok === null && r.login.detail !== "-") todo.push(`${r.label}: login state unclear (${r.login.detail}).`);
    if (r.present && !r.skill.length) todo.push(`${r.label}: Switchboard skill not installed where ${r.label} looks. Run: switchboard install`);
  }
  const absent = rows.filter((r) => !r.present).map((r) => r.label);
  console.log("");
  if (todo.length) console.log(`To fix:\n${todo.map((t) => `- ${t}`).join("\n")}`);
  else console.log("Everything detected is ready.");
  if (absent.length) console.log(`Not found on this machine (optional): ${absent.join(", ")}.`);

  console.log(`\nWhere chats live (one store per agent, shared by its CLI and desktop app):`);
  for (const r of rows) for (const s of r.stores) if (s.count) console.log(`- ${r.label}: ${s.label} — ${tilde(s.path)}`);
  console.log(`\nSub-agent model policy (change with: switchboard policy set <agent> <key> <value>):`);
  for (const a of allAgents()) console.log(`- ${a.label}: ${describePolicy(a)}`);
  process.exitCode = rows.some((r) => r.present && (!r.bin || r.login.ok === false)) ? 1 : 0;
}

// Pick the fewest folders that reach every detected agent.
function plan(rows, only) {
  const want = rows.filter((r) => r.present && (!only || only.includes(r.agent)));
  const targets = new Map(); // dir -> [agents]
  const covered = new Set();
  const add = (dir, agents) => {
    targets.set(dir, [...(targets.get(dir) || []), ...agents]);
    agents.forEach((x) => covered.add(x));
  };
  const has = (n) => want.some((r) => r.agent === n);
  if (has("claude")) add(skillDirs("claude")[0], ["claude"]);
  if (has("codex")) add(skillDirs("codex")[0], ["codex"]);
  for (const r of want) {
    if (covered.has(r.agent)) continue;
    const reads = skillDirs(r.agent);
    const shared = reads.find((d) => targets.has(d));
    if (shared) {
      targets.get(shared).push(r.agent);
      covered.add(r.agent);
    } else add(reads[0], [r.agent]);
  }
  // Agents that read a chosen folder anyway (Cursor reads ~/.claude/skills, ...).
  for (const r of want) for (const d of skillDirs(r.agent)) if (targets.has(d) && !targets.get(d).includes(r.agent)) targets.get(d).push(r.agent);
  return { want, targets };
}

function copySkill(src, dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  // Filter on the path inside the skill: run through npx, `src` itself is under node_modules.
  fs.cpSync(src, dest, { recursive: true, filter: (p) => !/(^|\/)(node_modules|\.DS_Store|\.switchboard-install\.json)$/.test(path.relative(src, p)) });
  fs.chmodSync(path.join(dest, "scripts", "switchboard.mjs"), 0o755);
  writeJSON(path.join(dest, MARKER), { version: VERSION, installedAt: new Date().toISOString(), source: src });
}

function ownedOrAbsent(dest) {
  return !exists(dest) || exists(path.join(dest, MARKER));
}

function onPath(dir) {
  return (process.env.PATH || "").split(path.delimiter).some((d) => path.resolve(d) === path.resolve(dir));
}

export function cmdInstall(argv) {
  const o = parseArgs(argv, { agents: "value", "dry-run": "bool", force: "bool", "no-shim": "bool" });
  const only = o.agents ? o.agents.split(",").map((n) => (getAgent(n.trim()) || die(`unknown agent "${n}"`)).name) : null;
  const rows = allAgents().map((a) => detect(a, { auth: false }));
  const { want, targets } = plan(rows, only);
  if (!want.length) die("no coding agents found on this machine (looked for Claude Code, Codex, Cursor, OpenCode). Install one, then rerun.");
  const src = skillSource();
  const app = path.join(SB_HOME, "app");
  const shimDir = home(".local", "bin");
  const shim = path.join(shimDir, "switchboard");

  console.log(`Found: ${want.map((r) => `${r.label}${r.bin ? "" : " (no CLI)"}`).join(", ")}`);
  console.log(`Installing the "${SKILL}" skill ${VERSION}:`);
  for (const [dir, agents] of targets) console.log(`- ${tilde(path.join(dir, SKILL))}  (read by ${[...new Set(agents)].map((n) => getAgent(n).label).join(", ")})`);
  console.log(`- ${tilde(app)}  (the command-line tool itself)`);
  const linkShim = !o["no-shim"] && (onPath(shimDir) || isDir(shimDir));
  if (linkShim) console.log(`- ${tilde(shim)} -> ${tilde(path.join(app, "scripts", "switchboard.mjs"))}`);

  const blocked = [...targets.keys()].map((d) => path.join(d, SKILL)).filter((d) => !ownedOrAbsent(d));
  if (blocked.length && !o.force) die(`these folders exist and were not created by Switchboard; not touching them (use --force to replace):\n${blocked.map((b) => `  ${b}`).join("\n")}`);
  if (o["dry-run"]) return console.log("\n(dry run: nothing written)");

  if (path.resolve(src) !== path.resolve(app)) copySkill(src, app);
  for (const dir of targets.keys()) copySkill(src, path.join(dir, SKILL));
  if (linkShim) {
    fs.mkdirSync(shimDir, { recursive: true });
    try {
      const cur = fs.lstatSync(shim);
      if (cur.isSymbolicLink() || o.force) fs.rmSync(shim);
    } catch {}
    if (!exists(shim)) fs.symlinkSync(path.join(app, "scripts", "switchboard.mjs"), shim);
  }
  writeJSON(path.join(SB_HOME, "install.json"), { version: VERSION, at: new Date().toISOString(), targets: [...targets.keys()].map((d) => path.join(d, SKILL)), shim: linkShim ? shim : null });

  console.log("\nDone.");
  const missingCli = want.filter((r) => !r.bin);
  for (const r of missingCli) console.log(`- ${r.label}: no CLI found, so other agents cannot delegate to it or check its login. Install: ${getAgent(r.agent).installHint}`);
  if (linkShim && !onPath(shimDir)) console.log(`- ${tilde(shimDir)} is not on your PATH; add it, or run: node ${tilde(path.join(app, "scripts", "switchboard.mjs"))}`);
  console.log(`- Restart open agent sessions so they load the new skill.`);
  console.log(`- Next: switchboard doctor   (checks each CLI's login and shows the model policy)`);
}

export function cmdUninstall(argv) {
  const o = parseArgs(argv, { purge: "bool" });
  const rec = readJSON(path.join(SB_HOME, "install.json"), { targets: [] });
  const candidates = new Set([...(rec.targets || []), ...allAgents().flatMap((a) => skillDirs(a.name).map((d) => path.join(d, SKILL)))]);
  let n = 0;
  for (const d of candidates) {
    if (exists(path.join(d, MARKER))) {
      fs.rmSync(d, { recursive: true, force: true });
      console.log(`removed ${tilde(d)}`);
      n++;
    }
  }
  const shim = rec.shim || home(".local", "bin", "switchboard");
  try {
    if (fs.lstatSync(shim).isSymbolicLink() && fs.readlinkSync(shim).includes(path.join(".switchboard", "app"))) {
      fs.rmSync(shim);
      console.log(`removed ${tilde(shim)}`);
    }
  } catch {}
  if (o.purge) {
    fs.rmSync(SB_HOME, { recursive: true, force: true });
    console.log(`removed ${tilde(SB_HOME)} (config, job records)`);
  } else {
    fs.rmSync(path.join(SB_HOME, "app"), { recursive: true, force: true });
    console.log(`kept ${tilde(SB_HOME)} (config and job records); --purge removes it`);
  }
  if (!n) console.log("No installed skill folders found.");
}


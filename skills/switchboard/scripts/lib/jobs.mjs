// Delegated jobs: run another agent's CLI headless as a tracked background job.
//
// `run` writes the job record and spawns a detached supervisor (this same
// script with the internal `__supervise` command). The supervisor owns the
// agent process: it parses the agent's event stream into state.json and
// activity.log, enforces the timeout, and on exit records the final answer and
// the git-measured file changes. Everything else (wait, status, result, cancel)
// only reads those files, so a job survives the caller's tool call timing out.

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { JOBS, SB_HOME, VERSION, policyFor } from "./config.mjs";
import { resolveModel, checkModelAllowed } from "./policy.mjs";
import { classifyError, retryHint } from "./agents/common.mjs";

// One line per failure kind: what the lead agent should do next.
const KIND_HINT = {
  "rate-limit": "this agent is out of usage for now. Wait, use another agent, or do it yourself; do not retry right away.",
  "not-free": "the account cannot pay for this model. Do not switch to another paid model; tell the user.",
  "not-logged-in": "the user must log in to this agent's CLI; you cannot do it for them.",
  "model-gone": "the model is missing, retired, or does not accept this setting. Check: switchboard models <agent>.",
  policy: "the user's policy refused this. Do not work around it; tell the user.",
  timeout: "the job ran out of time. Resume it with a narrower task, or raise --timeout.",
  "task-failed": "the agent ran but did not finish. Resume with what went wrong, or rerun once one step up, or do it yourself.",
};
import { snapshot, diffSnapshots, git, repoRoot, defaultBranch } from "./git.mjs";
import { agent as getAgent, agentNames } from "./agents/index.mjs";
import {
  die, readJSON, writeJSON, parseArgs, readStdin, pidAlive, realPath,
  fmtDuration, clock, oneLine, SbError, childEnv, canon,
} from "./util.mjs";

export const TERMINAL = new Set(["done", "failed", "cancelled", "timeout", "lost"]);
const MAX_INLINE_PROMPT = 100_000; // bigger briefs go to a file the agent is told to read
const MAX_REVIEW_DIFF = 400_000;

export let SCRIPT = null; // set by the entry point; used to spawn the supervisor and in hints
export function setScript(p) {
  SCRIPT = p;
}
const sb = () => `node "${SCRIPT}"`;

// ------------------------------------------------------------------ records

function newJobId(prefix) {
  const d = new Date();
  const md = `${d.getUTCMonth() + 1}`.padStart(2, "0") + `${d.getUTCDate()}`.padStart(2, "0");
  return `${prefix}-${md}-${crypto.randomBytes(3).toString("hex")}`;
}

const JOB_ID = /^[a-z]{2}-\d{4}-[0-9a-f]{6}$/;
const jobDir = (id) => {
  if (!JOB_ID.test(id)) die(`not a job id: "${id}"`);
  return path.join(JOBS, id);
};

// The agent process outlives a crashed supervisor (it has its own process
// group), so "lost" with a live agent still counts as running.
const agentAlive = (j) => !!j.state.agentPid && pidAlive(j.state.agentPid);
export const isActive = (j) => !TERMINAL.has(j.state.status) || (j.state.status === "lost" && agentAlive(j));
const workRootOf = (j) => j.state.workRoot || j.workRoot || canon(j.state.workdir || j.cwd);

export function loadJob(id) {
  if (!JOB_ID.test(id)) return null;
  const job = readJSON(path.join(jobDir(id), "job.json"));
  if (!job) return null;
  job.state = readJSON(path.join(jobDir(id), "state.json"), { status: "queued" });
  // A supervisor that died without writing a terminal status leaves the job "lost".
  if (!TERMINAL.has(job.state.status) && job.supervisorPid && !pidAlive(job.supervisorPid)) {
    const again = readJSON(path.join(jobDir(id), "state.json"), {});
    job.state = TERMINAL.has(again.status) ? again : { ...again, status: "lost", error: "supervisor process is gone" };
    if (job.state.status === "lost" && agentAlive(job))
      job.state.error = `supervisor process is gone but the agent (pid ${job.state.agentPid}) is still running; stop it with: switchboard cancel ${job.id}`;
  }
  return job;
}

export function allJobs() {
  let ids = [];
  try {
    ids = fs.readdirSync(JOBS).filter((n) => JOB_ID.test(n));
  } catch {
    return [];
  }
  return ids
    .map(loadJob)
    .filter(Boolean)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function scopeOf(cwd) {
  return repoRoot(cwd) || path.resolve(cwd);
}

function scopeJobs(jobs, cwd) {
  const root = scopeOf(cwd);
  return jobs.filter((j) => j.scope === root);
}

export function resolveJob(ref, { cwd = process.cwd() } = {}) {
  if (!ref || ref === "last" || ref === "latest") {
    const scoped = scopeJobs(allJobs(), cwd);
    if (!scoped.length) die("no jobs for this directory yet (status --all lists every job)");
    return scoped[scoped.length - 1];
  }
  const job = loadJob(ref);
  if (job) return job;
  const matches = allJobs().filter((j) => j.id.endsWith(ref) || j.name === ref);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) die(`"${ref}" matches several jobs: ${matches.map((j) => j.id).join(", ")}`);
  die(`no job "${ref}"`);
}

// ------------------------------------------------------------------ prompts

const preamble = (mode, host) => {
  const who = host ? `another coding agent (${host})` : "another coding agent";
  if (mode === "write")
    return `You are a delegated sub-agent working for ${who} that will review your work before anything ships.
Rules:
- Do exactly the task below. Do not widen scope or refactor unrelated code.
- Do not git commit, push, create or switch branches, or rewrite history. Leave changes uncommitted.
- Do not install global packages, change system settings, or edit files outside this workspace.
- If the task is ambiguous or you are blocked, stop and explain instead of guessing.
- Run the project's relevant tests or checks if they exist and are cheap.
Finish with a section titled "REPORT" listing: files changed, commands run and their results, anything you could not do or verify, and open questions.`;
  return `You are a delegated sub-agent working for ${who}. This is a READ-ONLY task: do not create, edit, or delete files.
Be concrete: cite file paths and line numbers. Separate verified facts from inference. Say plainly when you are unsure.
Finish with a section titled "REPORT" summarising your answer and anything you could not verify.`;
};

const REVIEW_PROMPT = ({ target, focus, diffRef, statusText }) => `You are an adversarial code reviewer. Another coding agent wrote the change below; your job is to find what is wrong with it, not to praise it. You have no stake in its decisions.

Review target: ${target}
${focus ? `Focus requested by the author: ${focus}\n` : ""}
The diff is in ${diffRef}. Read it in full, then open the surrounding source files in the workspace as needed to confirm each finding. Untracked/changed files per git status:
${statusText || "(none)"}

Look for, in priority order:
1. Correctness bugs: wrong logic, broken edge cases, off-by-one, null/undefined, race conditions, error paths that swallow failures.
2. Security and data safety: injection, missing authorization or ownership checks, secrets in code, unsafe deserialization, destructive operations without guards.
3. Design decisions that will hurt: wrong abstraction, hidden coupling, a simpler or safer approach that was missed. Challenge the chosen approach explicitly.
4. Missing or misleading tests.

Rules:
- Only report findings you can tie to specific lines. For each, give a concrete failure scenario (inputs/state -> wrong outcome).
- Rate each: severity (critical/high/medium/low) and confidence (high/medium/low).
- Do not pad with style nits. Zero findings is a valid answer if the change is sound.
- Do not modify any files.

Output format:
## Verdict
One line: SHIP / SHIP WITH FIXES / DO NOT SHIP, and why.
## Findings
Numbered list, most severe first: [severity/confidence] path:line — problem. Failure scenario. Suggested fix.
## Questions for the author
Decisions you could not judge without more context.`;

// Which agent is calling us, so the sub-agent's brief can name its boss.
export function hostAgent() {
  const e = process.env;
  if (e.CLAUDECODE || e.CLAUDE_CODE_ENTRYPOINT) return "Claude Code";
  if (e.CODEX_THREAD_ID || e.CODEX_SANDBOX || e.CODEX_HOME_DIR || e.CODEX_CI) return "Codex";
  if (e.CURSOR_AGENT || e.CURSOR_TRACE_ID || e.CURSOR_CLI) return "Cursor";
  if (e.OPENCODE || e.OPENCODE_SESSION_ID) return "OpenCode";
  return null;
}

// ---------------------------------------------------------------- commands

export const RUN_SPEC = {
  agent: "value",
  mode: "value",
  model: "value",
  effort: "value",
  cwd: "value",
  worktree: "bool",
  "worktree-base": "value",
  name: "value",
  wait: "bool",
  timeout: "value",
  "wait-timeout": "value",
  resume: "value",
  "prompt-file": "value",
  raw: "bool",
  "add-dir": "list",
  "allow-concurrent": "bool",
  json: "bool",
};

function pickAgent(o, fallback) {
  let name = o.agent;
  if (!name && o._.length && getAgent(o._[0])) name = o._.shift();
  name ||= fallback;
  if (!name) die(`which agent? Start with one of: ${agentNames().join(", ")} (e.g. switchboard run codex "<task>")`);
  const a = getAgent(name);
  if (!a) die(`unknown agent "${name}"; one of: ${agentNames().join(", ")}`);
  return a;
}

// Seconds until the supervisor kills the agent. Must run before any job
// directory or review-input is written: a NaN from `--timeout 10m` used to
// leave prompt.md on disk with no job.json, which cleanup could not see.
function jobTimeoutSec(o, adapter) {
  const timeoutSec = Number(o.timeout || policyFor(adapter.name).timeout || 1800);
  if (!(timeoutSec > 0)) die("--timeout must be a positive number of seconds");
  return timeoutSec;
}

export async function cmdRun(argv, extra = {}) {
  const o = parseArgs(argv, RUN_SPEC);
  let parent = null;
  if (o.resume) parent = resolveJob(o.resume);
  const adapter = pickAgent(o, parent?.agent || extra.agent);
  let prompt = extra.prompt || (o["prompt-file"] ? fs.readFileSync(o["prompt-file"], "utf8") : o._.join(" "));
  if (!prompt.trim()) prompt = readStdin();
  if (!prompt.trim()) die("no task given (pass it as an argument, --prompt-file, or on stdin)");

  let mode = o.mode || extra.mode || "write";
  let cwd = path.resolve(o.cwd || process.cwd());
  let sessionId = null;
  let effort = o.effort || null;
  let worktree = !!o.worktree;
  let requestedModel = o.model || null;

  if (parent) {
    if (parent.agent !== adapter.name) die(`job ${parent.id} ran on ${parent.agent}; resume it with the same agent`);
    if (!adapter.supports.resume) die(`${adapter.label} jobs cannot be resumed`);
    sessionId = parent.state.sessionId;
    if (!sessionId) die(`job ${parent.id} has no ${adapter.label} session id to resume`);
    if (!TERMINAL.has(parent.state.status)) die(`job ${parent.id} is still ${parent.state.status}; wait for it or cancel it first`);
    cwd = parent.state.workdir || parent.cwd; // continue where it ran, worktree included
    if (!requestedModel && !effort) effort = parent.effort || null;
    // Name the session's model again so today's policy is checked against it;
    // a resumed session would otherwise keep a model the user has since denied.
    if (!requestedModel && policyFor(adapter.name).chooseModel) requestedModel = parent.requestedModel || parent.model || null;
    mode = o.mode || parent.mode; // resuming a read-only review never silently becomes a writer
    worktree = false;
  }
  if (!adapter.supports.modes.includes(mode)) die(`--mode for ${adapter.label} must be one of ${adapter.supports.modes.join(", ")} (got ${mode})`);
  if (!fs.existsSync(cwd)) die(`directory does not exist: ${cwd}`);

  const bin = adapter.bin();
  if (!bin) die(`${adapter.label} CLI not found. Install: ${adapter.installHint}`);
  const resolved = resolveModel(adapter, { requested: requestedModel, effort });
  for (const n of resolved.notes) console.log(`note: ${n}`);

  const scope = parent ? parent.scope : scopeOf(cwd);
  if (worktree && !repoRoot(cwd)) die("--worktree needs a git repository");
  // Git measures a whole checkout, so the lock is per repository, not per folder.
  const workRoot = canon(repoRoot(cwd) || cwd);
  if (mode === "write" && !worktree && !o["allow-concurrent"]) {
    const clash = allJobs().find((j) => isActive(j) && j.mode === "write" && workRootOf(j) === workRoot);
    if (clash)
      die(
        `write job ${clash.id} is already editing ${workRoot}. Two writers in one checkout will clobber each other.\n` +
          `Use --worktree to isolate this job, wait for ${clash.id}, or pass --allow-concurrent if the tasks touch disjoint files.`,
      );
  }

  const timeoutSec = jobTimeoutSec(o, adapter);

  const id = newJobId(adapter.prefix);
  const dir = jobDir(id);
  fs.mkdirSync(dir, { recursive: true });
  const brief = o.raw || parent ? prompt : `${preamble(mode, hostAgent())}\n\n--- TASK ---\n${prompt}`;
  fs.writeFileSync(path.join(dir, "prompt.md"), brief);

  const job = {
    id,
    version: VERSION,
    agent: adapter.name,
    name: o.name || extra.name || oneLine(prompt.split("\n").find((l) => l.trim()) || "task", 60),
    kind: extra.kind || "task",
    mode,
    model: resolved.id,
    requestedModel: resolved.requested,
    effort: resolved.effort,
    spend: resolved.spend,
    cwd,
    scope,
    workRoot,
    worktree,
    worktreeBase: o["worktree-base"] || null,
    addDirs: [...(o["add-dir"] || []), ...(extra.addDirs || [])],
    resumeSessionId: sessionId,
    parent: parent ? parent.id : null,
    timeoutSec,
    agentBin: bin,
    host: hostAgent(),
    createdAt: new Date().toISOString(),
  };
  writeJSON(path.join(dir, "job.json"), job);
  writeJSON(path.join(dir, "state.json"), { status: "starting", startedAt: Date.now() });

  const sup = spawn(process.execPath, [SCRIPT, "__supervise", id], { detached: true, stdio: "ignore", cwd, env: process.env });
  job.supervisorPid = sup.pid;
  writeJSON(path.join(dir, "job.json"), job);
  sup.unref();

  if (o.json) {
    process.stdout.write(JSON.stringify({ id, agent: adapter.name, dir, mode, model: job.model, effort: job.effort, cwd, worktree }) + "\n");
  } else {
    const bits = [`mode=${mode}`, `model=${job.model || `${adapter.name}-default`}`];
    if (job.effort) bits.push(`effort=${job.effort}`);
    if (worktree) bits.push("worktree=yes");
    if (parent) bits.push(`resumes=${parent.id}`);
    console.log(`Started ${adapter.label} job ${id} (${bits.join(", ")})`);
    console.log(`  task: ${job.name}`);
    console.log(`  watch: ${sb()} wait ${id}     result: ${sb()} result ${id}`);
  }
  if (o.wait) return cmdWait([id, "--timeout", o["wait-timeout"] || "540"]);
}

// Create a fresh git worktree for an isolated job (works the same for every agent).
function makeWorktree(job) {
  const root = repoRoot(job.cwd);
  const branch = `switchboard/${job.id}`;
  const dir = path.join(SB_HOME, "worktrees", `${path.basename(root)}-${job.id}`);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const base = job.worktreeBase || "HEAD";
  const out = git(root, ["worktree", "add", "-b", branch, dir, base]);
  if (out === null) throw new SbError(`git worktree add failed for ${dir} (base ${base})`);
  // Run from the same subdirectory the caller was in.
  const sub = path.relative(root, job.cwd);
  const baseCommit = (git(dir, ["rev-parse", "HEAD"]) || "").trim();
  return { dir: sub && !sub.startsWith("..") ? path.join(dir, sub) : dir, top: dir, branch, baseCommit };
}

export function cmdSupervise([id]) {
  const dir = jobDir(id);
  const job = readJSON(path.join(dir, "job.json"));
  if (!job) process.exit(2);
  const adapter = getAgent(job.agent);
  const brief = fs.readFileSync(path.join(dir, "prompt.md"), "utf8");
  let policyError = null;
  try {
    if (!policyFor(adapter.name).enabled) throw new SbError(`${adapter.label} is turned off as a sub-agent`);
    if (job.model) checkModelAllowed(adapter, job.model, job.requestedModel);
  } catch (e) {
    policyError = e.message;
  }

  const state = {
    status: "running",
    startedAt: Date.now(),
    supervisorPid: process.pid,
    sessionId: job.resumeSessionId || null,
    workdir: job.cwd,
    toolCalls: 0,
    edits: {},
    commands: [],
    messages: [],
    lastActivity: `starting ${adapter.label}`,
    lastEventAt: Date.now(),
    workRoot: job.workRoot,
  };
  const activity = fs.createWriteStream(path.join(dir, "activity.log"), { flags: "a" });
  const events = fs.createWriteStream(path.join(dir, "events.jsonl"), { flags: "a" });
  const stderr = fs.createWriteStream(path.join(dir, "stderr.log"), { flags: "a" });
  let dirty = true;
  let finalEvent = null;
  let killedFor = null;
  let child = null;

  const flush = () => {
    if (!dirty) return;
    dirty = false;
    writeJSON(path.join(dir, "state.json"), state);
  };
  const log = (line) => {
    state.lastActivity = line;
    state.lastEventAt = Date.now();
    activity.write(`${clock(Date.now())}  ${line}\n`);
    dirty = true;
  };
  const fail = (msg) => {
    state.status = "failed";
    state.error = msg;
    state.endedAt = Date.now();
    log(msg);
    dirty = true;
    flush();
    setTimeout(() => process.exit(0), 50);
  };

  if (policyError) return fail(`policy: ${policyError}`);
  if (job.worktree) {
    try {
      const wt = makeWorktree(job);
      state.workdir = wt.dir;
      state.worktreeTop = wt.top;
      state.branch = wt.branch;
      state.worktreeBaseCommit = wt.baseCommit;
      state.workRoot = canon(wt.top);
      log(`created worktree ${wt.top} on branch ${wt.branch}`);
    } catch (e) {
      return fail(e.message);
    }
  }
  const workdir = state.workdir;
  const before = snapshot(workdir);

  let promptText = brief;
  if (job.parent)
    promptText = `Follow-up from the lead agent. The rules from your first brief still apply${job.mode === "write" ? " (stay in scope; no commits, pushes or branch changes; nothing outside this workspace)" : " (read-only: do not create, edit or delete files)"}.\n\n${promptText}`;
  if (!adapter.supports.stdinPrompt && /^\s*-/.test(promptText)) promptText = `Task:\n${promptText}`;
  const addDirs = [...(job.addDirs || [])];
  if (!adapter.supports.stdinPrompt && Buffer.byteLength(brief) > MAX_INLINE_PROMPT) {
    promptText = `Your full task brief is in the file ${path.join(dir, "prompt.md")}. Read that whole file first and follow it exactly.`;
    addDirs.push(dir);
  }

  // The parser context: adapters translate their own event stream into these calls.
  const pending = new Map();
  const rel = (p) => {
    if (!p) return "?";
    const r = path.relative(workdir, p);
    return r && !r.startsWith("..") && !path.isAbsolute(r) ? r : p;
  };
  const ctx = {
    state,
    log,
    rel,
    init({ sessionId, model, cwd } = {}) {
      if (sessionId) state.sessionId = sessionId;
      if (model) state.modelName = model;
      log(`session ${state.sessionId || "?"} started${model ? ` (${model})` : ""}${cwd ? ` in ${cwd}` : ""}`);
      if (model && adapter.verifiesModel) {
        try {
          checkModelAllowed(adapter, model, job.requestedModel, { runtime: true });
        } catch (e) {
          kill(`policy: ${e.message}`);
        }
      }
    },
    say(text) {
      if (!String(text || "").trim()) return;
      state.messages.push({ afterTool: state.toolCalls, text });
      log(`say    ${oneLine(text, 160)}`);
    },
    toolStart(callId, d) {
      state.toolCalls++;
      pending.set(callId, d);
      log(d.text);
    },
    toolEnd(callId, r = {}, fallback = null) {
      const d = pending.get(callId) || fallback || { kind: "tool", text: "tool" };
      pending.delete(callId);
      if (r.error) {
        log(`  ✗ ${d.kind} failed: ${oneLine(r.error, 140)}`);
        if (d.kind === "shell") state.commands.push({ command: d.command, exitCode: r.exitCode ?? "error" });
        return;
      }
      if (d.kind === "shell") {
        state.commands.push({ command: d.command || r.command, exitCode: r.exitCode ?? "?" });
        log(`  → exit ${r.exitCode ?? "?"}${r.stderr ? `  stderr: ${oneLine(r.stderr, 100)}` : ""}`);
      }
      for (const f of r.files || (d.path ? [{ path: d.path, kind: d.kind, added: r.added, removed: r.removed }] : [])) {
        if (!["edit", "write", "delete", "add", "update"].includes(f.kind)) continue;
        const e = (state.edits[realPath(path.resolve(workdir, f.path))] ||= { added: 0, removed: 0, kind: f.kind });
        e.added += f.added || 0;
        e.removed += f.removed || 0;
      }
    },
    final(ev) {
      finalEvent = ev;
      if (ev.usage) state.usage = ev.usage;
      if (ev.costUsd != null) state.costUsd = ev.costUsd;
      state.isError = !!ev.isError;
      log(`result ${ev.isError ? "error" : "success"}${ev.durationMs ? ` after ${fmtDuration(ev.durationMs)}` : ""}`);
    },
    error(msg) {
      state.agentErrors = [...(state.agentErrors || []), msg].slice(-5);
      log(`error  ${oneLine(msg, 160)}`);
    },
  };

  let spec;
  try {
    spec = adapter.buildRun({ ...job, cwd: workdir, addDirs }, promptText);
  } catch (e) {
    return fail(e.message);
  }
  const parser = adapter.parser(ctx);

  child = spawn(spec.bin, spec.args, {
    cwd: workdir,
    stdio: [spec.stdin != null ? "pipe" : "ignore", "pipe", "pipe"],
    env: childEnv({ ...(spec.env || {}), SWITCHBOARD_JOB: id }, adapter.name),
    detached: true, // own process group, so cancel/timeout also stops what the agent started
  });
  state.agentPid = child.pid;
  state.argv = [path.basename(spec.bin), ...spec.args.map((a) => (a === promptText ? "<prompt>" : a))];
  writeJSON(path.join(dir, "state.json"), state);
  if (spec.stdin != null) {
    child.stdin.on("error", () => {});
    child.stdin.end(spec.stdin);
  }

  let buf = "";
  child.stdout.on("data", (chunk) => {
    events.write(chunk);
    buf += chunk.toString("utf8");
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        log(`(unparsed) ${oneLine(line, 140)}`);
        continue;
      }
      state.lastEventAt = Date.now();
      try {
        parser(ev);
      } catch (e) {
        log(`(parser error) ${e.message}`);
      }
    }
  });
  child.stderr.on("data", (chunk) => stderr.write(chunk));

  const ticker = setInterval(flush, 1000);
  function kill(why) {
    if (killedFor) return;
    killedFor = why;
    log(`stopping agent: ${why}`);
    const signalGroup = (sig) => {
      try {
        process.kill(-child.pid, sig);
      } catch {
        try {
          child.kill(sig);
        } catch {}
      }
    };
    signalGroup("SIGTERM");
    setTimeout(() => signalGroup("SIGKILL"), 5000).unref();
  }
  const timer = setTimeout(() => kill(`timeout after ${job.timeoutSec}s`), job.timeoutSec * 1000);
  process.on("SIGTERM", () => kill("cancelled"));
  process.on("SIGINT", () => kill("cancelled"));
  child.on("error", (err) => log(`could not start ${spec.bin}: ${err.message}`));

  child.on("close", (code, signal) => {
    clearTimeout(timer);
    if (killedFor) {
      try {
        process.kill(-child.pid, "SIGKILL"); // stragglers the agent started
      } catch {}
    }
    clearInterval(ticker);
    const cancelled = fs.existsSync(path.join(dir, "cancel"));
    state.exitCode = code;
    state.signal = signal;
    state.endedAt = Date.now();
    if (cancelled || killedFor === "cancelled") state.status = "cancelled";
    else if (killedFor?.startsWith("policy:")) state.status = "failed";
    else if (killedFor) state.status = "timeout";
    else if (code === 0 && finalEvent && !finalEvent.isError) state.status = "done";
    else if (code === 0 && !finalEvent && adapter.successOnCleanExit && !state.agentErrors?.length) state.status = "done";
    else state.status = "failed";

    // The answer is what the agent said after its last tool call; earlier
    // messages are mostly narration ("I'll read X...").
    const msgs = state.messages;
    const lastTool = msgs.length ? msgs[msgs.length - 1].afterTool : 0;
    let answer = msgs.filter((m) => m.afterTool === lastTool).map((m) => m.text).join("\n\n").trim();
    if (!answer && finalEvent?.result) answer = String(finalEvent.result).trim();
    state.answer = answer;

    try {
      adapter.afterRun?.(state, job);
    } catch {}
    const after = snapshot(workdir);
    if (job.worktree) {
      // A fresh worktree starts clean, so everything dirty in it is the job's.
      state.git = after && { changed: Object.entries(after.files).map(([file, status]) => ({ file, status: status.trim() })), commits: [] };
      const base = state.worktreeBaseCommit;
      if (after && base && base !== after.head)
        state.git.commits = (git(after.root, ["log", "--oneline", `${base}..HEAD`]) || "").trim().split("\n").filter(Boolean);
    } else {
      state.git = diffSnapshots(before, after);
    }
    if (state.git && after) state.git.root = realPath(after.root);
    // Git sees the whole checkout, so a concurrent job's (or the user's) edits
    // in the same directory land in this job's list too. Record overlaps.
    state.overlapping = allJobs()
      .filter((x) => x.id !== id && workRootOf(x) === state.workRoot)
      .filter((x) => (x.state.startedAt || 0) < state.endedAt && (x.state.endedAt || Infinity) > state.startedAt)
      .map((x) => `${x.id} (${x.mode})`);

    if (state.status !== "done") {
      let errTail = "";
      try {
        errTail = fs.readFileSync(path.join(dir, "stderr.log"), "utf8").trim().split("\n").slice(-20).join("\n");
      } catch {}
      const agentSaid = finalEvent?.isError && finalEvent.result ? String(finalEvent.result) : "";
      state.error ||= killedFor || agentSaid || state.agentErrors?.slice(-1)[0] || errTail || `agent exited with code ${code}${signal ? ` (${signal})` : ""}`;
      state.errorKind = killedFor === "cancelled" || state.status === "cancelled" ? "cancelled" : killedFor?.startsWith("timeout") ? "timeout" : killedFor?.startsWith("policy") ? "policy" : classifyError([state.error, ...(state.agentErrors || []), errTail].join("\n"));
      state.retryAfter = state.errorKind === "rate-limit" ? retryHint([state.error, ...(state.agentErrors || []), errTail].join("\n")) : null;
    }
    dirty = true;
    flush();
    activity.end();
    events.end();
    stderr.end();
    setTimeout(() => process.exit(0), 50);
  });
}

function statusLine(j, now = Date.now()) {
  const s = j.state;
  const end = s.endedAt || now;
  const elapsed = s.startedAt ? fmtDuration(end - s.startedAt) : "-";
  const idle = !TERMINAL.has(s.status) && s.lastEventAt ? ` idle ${fmtDuration(now - s.lastEventAt)}` : "";
  return `${j.id}  ${s.status.padEnd(9)} ${j.agent.padEnd(8)} ${j.mode.padEnd(5)} ${elapsed.padStart(7)}${idle}  tools=${s.toolCalls ?? 0}  ${oneLine(j.name, 44)}\n    ${oneLine(s.lastActivity || "", 110)}`;
}

export function cmdStatus(argv) {
  const o = parseArgs(argv, { all: "bool", json: "bool", limit: "value" });
  if (o._[0]) {
    const j = resolveJob(o._[0]);
    if (o.json) return console.log(JSON.stringify(j, null, 2));
    console.log(statusLine(j));
    if (TERMINAL.has(j.state.status)) console.log(`    -> ${sb()} result ${j.id}`);
    return;
  }
  const jobs = o.all ? allJobs() : scopeJobs(allJobs(), process.cwd());
  const limit = Number(o.limit || 10);
  const running = jobs.filter(isActive);
  const recent = jobs.filter((j) => !isActive(j)).slice(-limit);
  if (o.json) return console.log(JSON.stringify([...running, ...recent], null, 2));
  if (!running.length && !recent.length) return console.log(o.all ? "No jobs yet." : "No jobs for this repository. (--all shows every job)");
  if (running.length) {
    console.log(`Running (${running.length}):`);
    running.forEach((j) => console.log(statusLine(j)));
  }
  if (recent.length) {
    console.log(`${running.length ? "\n" : ""}Recent:`);
    recent.reverse().forEach((j) => console.log(statusLine(j)));
  }
}

export async function cmdWait(argv) {
  const o = parseArgs(argv, { timeout: "value", any: "bool", quiet: "bool", interval: "value" });
  const ids = (o._.length ? o._ : ["last"]).map((r) => resolveJob(r).id);
  const timeoutMs = Number(o.timeout || 540) * 1000;
  const every = Number(o.interval || 20) * 1000;
  const start = Date.now();
  let lastPrint = 0;
  const seen = {};
  for (;;) {
    const states = ids.map(loadJob);
    const finished = states.filter((j) => TERMINAL.has(j.state.status));
    for (const j of finished) {
      if (seen[j.id]) continue;
      seen[j.id] = true;
      console.log(`[${clock(Date.now())}] ${j.id} ${j.state.status} after ${fmtDuration((j.state.endedAt || Date.now()) - j.state.startedAt)} (tools=${j.state.toolCalls ?? 0})`);
    }
    if (o.any ? finished.length > 0 : finished.length === states.length) {
      console.log(`\nFinished: ${finished.map((j) => `${j.id}=${j.state.status}${j.state.errorKind ? ` (${j.state.errorKind})` : ""}`).join(", ")}`);
      console.log(`Read the output with: ${sb()} result ${finished.map((j) => j.id).join(" ")}`);
      return;
    }
    if (Date.now() - start > timeoutMs) {
      console.log(`\nStill running after ${fmtDuration(Date.now() - start)}:`);
      states.filter((j) => !TERMINAL.has(j.state.status)).forEach((j) => console.log(statusLine(j)));
      console.log(`Wait again with: ${sb()} wait ${ids.join(" ")}`);
      return;
    }
    if (!o.quiet && Date.now() - lastPrint >= every) {
      lastPrint = Date.now();
      states
        .filter((j) => !TERMINAL.has(j.state.status))
        .forEach((j) => console.log(`[${clock(Date.now())}] ${j.id} ${j.state.status} tools=${j.state.toolCalls ?? 0}: ${oneLine(j.state.lastActivity, 100)}`));
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
}

export async function cmdTail(argv) {
  const o = parseArgs(argv, { lines: "value", follow: "bool" }, { "-n": "lines", "-f": "follow" });
  const j = resolveJob(o._[0]);
  const file = path.join(jobDir(j.id), "activity.log");
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {}
  console.log(text.split("\n").filter(Boolean).slice(-Number(o.lines || 40)).join("\n") || "(no activity yet)");
  if (!o.follow) return;
  let offset = Buffer.byteLength(text);
  for (;;) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const size = fs.statSync(file).size;
      if (size > offset) {
        const fd = fs.openSync(file, "r");
        const b = Buffer.alloc(size - offset);
        fs.readSync(fd, b, 0, b.length, offset);
        fs.closeSync(fd);
        process.stdout.write(b.toString("utf8"));
        offset = size;
      }
    } catch {}
    const cur = loadJob(j.id);
    if (TERMINAL.has(cur.state.status)) return console.log(`--- ${cur.id} ${cur.state.status}`);
  }
}

function renderResult(j, { full = false } = {}) {
  const a = getAgent(j.agent);
  const s = j.state;
  const out = [];
  const dur = s.startedAt ? fmtDuration((s.endedAt || Date.now()) - s.startedAt) : "-";
  out.push(`# ${a.label} job ${j.id} — ${s.status.toUpperCase()}`);
  out.push(`task: ${j.name}`);
  out.push(`mode: ${j.mode}   model: ${s.modelName || j.model || "agent default"}${j.effort ? `   effort: ${j.effort}` : ""}${j.spend ? `   spend: ${j.spend}` : ""}   time: ${dur}   tool calls: ${s.toolCalls ?? 0}`);
  out.push(`workdir: ${s.workdir || j.cwd}${j.worktree ? `  (isolated git worktree${s.branch ? `, branch ${s.branch}` : ""})` : ""}`);
  if (s.sessionId) out.push(`${a.label} session: ${s.sessionId}`);
  if (!TERMINAL.has(s.status)) {
    out.push(`\nStill ${s.status}. Last activity: ${s.lastActivity}`);
    return out.join("\n");
  }
  if (s.error && s.status !== "done") out.push(`\n## Error${s.errorKind ? ` (${s.errorKind}${s.retryAfter ? `; ${s.retryAfter}` : ""})` : ""}\n${s.error}${KIND_HINT[s.errorKind] ? `\nNext: ${KIND_HINT[s.errorKind]}` : ""}`);
  out.push(`\n## ${a.label}'s answer\n${s.answer || "(no final message)"}`);

  if (s.git) {
    out.push(`\n## Workspace changes while the job ran (measured by git, not self-reported)`);
    if (!s.git.changed.length) out.push("(no file changes)");
    for (const c of s.git.changed) {
      const e = s.edits?.[path.join(s.git.root, c.file)];
      const tag = e ? `${a.label} edit${e.added || e.removed ? ` +${e.added} -${e.removed}` : ""}` : `not via ${a.label}'s edit tool`;
      out.push(`- ${c.status.padEnd(3)} ${c.file}  [${tag}]`);
    }
    const seen = new Set(s.git.changed.map((c) => path.join(s.git.root, c.file)));
    const unseen = Object.entries(s.edits || {}).filter(([p]) => !seen.has(p));
    if (unseen.length) {
      out.push(`Edits ${a.label} reported that git does not show (ignored files, or outside the repository):`);
      for (const [p, e] of unseen) out.push(`- ${p}  (${e.kind}${e.added || e.removed ? ` +${e.added} -${e.removed}` : ""})`);
    }
    if ((s.git.changed.length || unseen.length) && j.mode !== "write") out.push(`⚠ This job was read-only, so these changes came from elsewhere (another job, a shell command, or you).`);
    if (s.overlapping?.length) out.push(`⚠ Other jobs ran in this directory at the same time: ${s.overlapping.join(", ")}. Some changes above may be theirs.`);
    if (s.git.commits?.length) out.push(`\n⚠ New commits during the job:\n${s.git.commits.map((c) => `- ${c}`).join("\n")}`);
  } else if (Object.keys(s.edits || {}).length) {
    out.push(`\n## Files edited (self-reported by ${a.label}; not a git repo)`);
    for (const [p, e] of Object.entries(s.edits)) out.push(`- ${p}  (+${e.added} -${e.removed})`);
  }

  if (s.commands?.length) {
    out.push(`\n## Commands ${a.label} ran`);
    const cmds = full ? s.commands : s.commands.slice(-15);
    if (cmds.length < s.commands.length) out.push(`(last ${cmds.length} of ${s.commands.length}; --full for all)`);
    for (const c of cmds) out.push(`- [exit ${c.exitCode}] ${oneLine(c.command, 200)}`);
  }
  if (s.usage) out.push(`\ntokens: ${Object.entries(s.usage).filter(([, v]) => typeof v === "number").map(([k, v]) => `${k}=${v}`).join(" ")}`);
  if (s.costUsd) out.push(`cost reported by ${a.label}: $${Number(s.costUsd).toFixed(4)}`);

  out.push(`\n## Next`);
  const wd = s.workdir || j.cwd;
  if (j.mode === "write" && s.git?.changed?.length) out.push(`- Review the diff yourself: git -C "${wd}" diff`);
  if (j.worktree && s.worktreeTop)
    out.push(`- Changes live in the worktree ${s.worktreeTop}; bring them over deliberately (e.g. git -C "${s.worktreeTop}" diff | git apply). Remove it when done: git worktree remove "${s.worktreeTop}" && git branch -D ${s.branch}`);
  if (s.sessionId) {
    if (a.supports.resume) out.push(`- Follow up in the same ${a.label} session: ${sb()} resume ${j.id} "<instructions>"`);
    out.push(`- Take over interactively: cd "${wd}" && ${a.takeover(s.sessionId)}`);
  }
  out.push(`- Raw logs: ${jobDir(j.id)}`);
  return out.join("\n");
}

export function cmdResult(argv) {
  const o = parseArgs(argv, { json: "bool", full: "bool" });
  const jobs = (o._.length ? o._ : ["last"]).map((r) => resolveJob(r));
  if (o.json) return console.log(JSON.stringify(jobs, null, 2));
  console.log(jobs.map((j) => renderResult(j, { full: o.full })).join("\n\n" + "─".repeat(60) + "\n\n"));
}

export async function cmdCancel(argv) {
  const o = parseArgs(argv, { all: "bool" });
  const targets = o.all ? scopeJobs(allJobs(), process.cwd()).filter(isActive) : [resolveJob(o._[0])];
  if (!targets.length) return console.log("Nothing running.");
  for (const j of targets) {
    if (!isActive(j)) {
      console.log(`${j.id} already ${j.state.status}`);
      continue;
    }
    fs.writeFileSync(path.join(jobDir(j.id), "cancel"), new Date().toISOString());
    const pid = j.state.supervisorPid || j.supervisorPid;
    if (pidAlive(pid)) {
      process.kill(pid, "SIGTERM");
      console.log(`Cancelling ${j.id} (supervisor ${pid}).`);
      continue;
    }
    // No supervisor: stop the agent's whole process group ourselves.
    const group = (sig) => {
      try {
        process.kill(-j.state.agentPid, sig);
      } catch {}
    };
    if (agentAlive(j)) {
      group("SIGTERM");
      for (let i = 0; i < 25 && agentAlive(j); i++) await new Promise((r) => setTimeout(r, 200));
      if (agentAlive(j)) group("SIGKILL");
    }
    const st = readJSON(path.join(jobDir(j.id), "state.json"), {});
    writeJSON(path.join(jobDir(j.id), "state.json"), { ...st, status: "cancelled", endedAt: Date.now(), error: "cancelled after its supervisor was gone" });
    console.log(`${j.id}: supervisor was gone; stopped the agent and marked it cancelled.`);
  }
}

export function cmdResume(argv) {
  const [ref, ...rest] = argv;
  if (!ref) die("usage: resume <job> <follow-up instructions>");
  return cmdRun(["--resume", ref, ...rest]);
}

export function cmdReview(argv) {
  const o = parseArgs(argv, { ...RUN_SPEC, base: "value" });
  const adapter = pickAgent(o);
  jobTimeoutSec(o, adapter);
  const cwd = path.resolve(o.cwd || process.cwd());
  const root = repoRoot(cwd);
  if (!root) die("review needs a git repository");
  let target, diff;
  const statusText = (git(root, ["status", "--short"]) || "").trim();
  if (o.base) {
    const mb = (git(root, ["merge-base", o.base, "HEAD"]) || "").trim();
    if (!mb) die(`cannot find merge base with ${o.base}`);
    target = `branch changes since ${o.base} (merge-base ${mb.slice(0, 8)}) plus uncommitted work`;
    diff = git(root, ["diff", mb]);
  } else if (statusText) {
    target = "uncommitted changes against HEAD";
    diff = git(root, ["diff", "HEAD"]);
  } else {
    const base = defaultBranch(root);
    const mb = base ? (git(root, ["merge-base", base, "HEAD"]) || "").trim() : "";
    if (!mb || mb === (git(root, ["rev-parse", "HEAD"]) || "").trim())
      die("nothing to review: working tree is clean and HEAD has no commits beyond the default branch (use --base <ref>)");
    target = `branch changes since ${base}`;
    diff = git(root, ["diff", mb]);
  }
  const untracked = (git(root, ["ls-files", "--others", "--exclude-standard"]) || "").trim();
  if (!diff?.trim() && !untracked) die("the diff is empty");

  const focus = o._.join(" ").trim();
  const rid = `review-${crypto.randomBytes(3).toString("hex")}`;
  const diffDir = path.join(SB_HOME, "review-inputs", rid);
  fs.mkdirSync(diffDir, { recursive: true });
  const diffFile = path.join(diffDir, "change.diff");
  let body = diff || "";
  if (Buffer.byteLength(body) > MAX_REVIEW_DIFF) body = body.slice(0, MAX_REVIEW_DIFF) + "\n\n[diff truncated by switchboard; read the remaining files directly]\n";
  fs.writeFileSync(diffFile, body);
  const prompt = REVIEW_PROMPT({
    target,
    focus,
    diffRef: `the file ${diffFile}`,
    statusText: statusText + (untracked ? `\nUntracked files (read them, they are part of the change):\n${untracked}` : ""),
  });
  const pass = [];
  for (const k of ["model", "effort", "timeout", "wait-timeout", "name"]) if (o[k]) pass.push(`--${k}`, o[k]);
  if (o.wait) pass.push("--wait");
  if (o.json) pass.push("--json");
  return cmdRun(["--agent", adapter.name, "--cwd", root, "--raw", ...pass], {
    prompt,
    mode: "ask",
    kind: "review",
    name: o.name || `adversarial review: ${target}${focus ? ` — ${oneLine(focus, 40)}` : ""}`,
    addDirs: [diffDir],
  });
}

export function cmdCleanup(argv) {
  const o = parseArgs(argv, { days: "value" });
  const cutoff = Date.now() - Number(o.days || 7) * 86400_000;
  // Dirs with no job.json are invisible to allJobs(); they used to accumulate
  // forever. Keep a one-minute floor so `cleanup --days 0` cannot race a run
  // that has mkdir'd but not yet written job.json.
  const orphanCutoff = Math.min(cutoff, Date.now() - 60_000);
  let n = 0;
  let ids = [];
  try {
    ids = fs.readdirSync(JOBS).filter((name) => JOB_ID.test(name));
  } catch {
    ids = [];
  }
  for (const id of ids) {
    const dir = jobDir(id);
    const job = loadJob(id);
    if (!job) {
      let mtime = 0;
      try {
        mtime = fs.statSync(dir).mtimeMs;
      } catch {
        continue;
      }
      if (mtime < orphanCutoff) {
        fs.rmSync(dir, { recursive: true, force: true });
        n++;
      }
      continue;
    }
    if (TERMINAL.has(job.state.status) && (job.state.endedAt || Date.parse(job.createdAt)) < cutoff) {
      fs.rmSync(dir, { recursive: true, force: true });
      n++;
    }
  }
  console.log(`Removed ${n} finished job record(s) older than ${o.days || 7} day(s). Worktrees are left in place; remove them with git worktree remove.`);
}

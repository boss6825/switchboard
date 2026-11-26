// Grok Bot bridge: a local webhook stands in for the Grok Bot routine. It checks
// the auth header, then does what the real routine does: runs the request's
// reply_command on this machine with the answer on stdin.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { sandbox, SB } from "./helpers.mjs";

const KEY = "test-key-not-real-0123";

function fakeGrokBot({ status = 202, reply = (p) => `answer to: ${p.task}`, replyStatus = "done", delayMs = 200, check } = {}) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const call = { headers: req.headers, body, payload: JSON.parse(body) };
      calls.push(call);
      if (check) check(call);
      res.writeHead(status).end(status < 300 ? "accepted" : "nope");
      if (status < 300 && reply) {
        setTimeout(() => {
          const cmd = call.payload.reply_command.replace(/--status done$/, `--status ${replyStatus}`);
          spawnSync("/bin/sh", ["-c", cmd], { input: reply(call.payload), env: process.env });
        }, delayMs);
      }
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, calls, url: `http://127.0.0.1:${server.address().port}/hook` })));
}

function runAsync(s, args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SB, ...args], { cwd: s.repo, env: { ...s.env, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ status: code, stdout, stderr }));
    child.stdin.end();
  });
}

// Never touch the real Keychain from tests.
const setup = () => ({ SWITCHBOARD_KEYCHAIN: "off" });

test("send posts the payload with a Bearer key and prints the reply", async () => {
  const s = sandbox();
  const bot = await fakeGrokBot();
  try {
    const env = { ...setup(s), GROKBOT_WEBHOOK_URL: bot.url, GROKBOT_WEBHOOK_SECRET: KEY };
    // reply_command carries SWITCHBOARD_HOME, so the Bot's reply lands in this sandbox.
    const r = await runAsync(s, ["grokbot", "send", "latest AI news", "--context", "for a blog", "--timeout", "20"], env);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.status, "done");
    assert.equal(out.result, "answer to: latest AI news");
    assert.match(out.request_id, /^gb_[0-9a-f]{16}$/);
    const call = bot.calls[0];
    assert.equal(call.headers.authorization, `Bearer ${KEY}`);
    assert.deepEqual(Object.keys(call.payload), ["request_id", "task", "context", "reply_command"]);
    assert.equal(call.payload.context, "for a blog");
    assert.match(call.payload.reply_command, /grokbot reply --request-id gb_[0-9a-f]{16} --status done$/);
    // The key never lands in the request record or the output.
    const recs = fs.readdirSync(path.join(s.env.SWITCHBOARD_HOME, "grokbot", "requests"));
    for (const f of recs) assert.doesNotMatch(fs.readFileSync(path.join(s.env.SWITCHBOARD_HOME, "grokbot", "requests", f), "utf8"), new RegExp(KEY));
    assert.doesNotMatch(r.stdout + r.stderr, new RegExp(KEY));
  } finally {
    bot.server.close();
  }
});

test("a custom header carries the raw key; a pasted 'Authorization: Bearer' line is accepted", async () => {
  const s = sandbox();
  const bot = await fakeGrokBot({ reply: null });
  try {
    const env = { ...setup(s), GROKBOT_WEBHOOK_URL: bot.url, GROKBOT_WEBHOOK_SECRET: KEY, GROKBOT_WEBHOOK_HEADER: "X-Api-Key" };
    const r = await runAsync(s, ["grokbot", "send", "hi", "--no-wait"], env);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(bot.calls[0].headers["x-api-key"], KEY);
    assert.equal(bot.calls[0].headers.authorization, undefined);
  } finally {
    bot.server.close();
  }
  const { normalizeKey } = await import("../skills/switchboard/scripts/lib/grokbot.mjs");
  assert.equal(normalizeKey(`Authorization: Bearer ${KEY}\n`), KEY);
  assert.equal(normalizeKey(`Bearer ${KEY}`), KEY);
  assert.equal(normalizeKey(` ${KEY} `), KEY);
});

test("a whsec_ secret signs the body the Standard Webhooks way", async () => {
  const s = sandbox();
  const raw = crypto.randomBytes(24);
  const secret = `whsec_${raw.toString("base64")}`;
  const bot = await fakeGrokBot({ reply: null });
  try {
    const r = await runAsync(s, ["grokbot", "send", "hi", "--no-wait"], { ...setup(s), GROKBOT_WEBHOOK_URL: bot.url, GROKBOT_WEBHOOK_SECRET: secret });
    assert.equal(r.status, 0, r.stderr);
    const { headers, body } = bot.calls[0];
    const want = crypto.createHmac("sha256", raw).update(`${headers["webhook-id"]}.${headers["webhook-timestamp"]}.${body}`).digest("base64");
    assert.equal(headers["webhook-signature"], `v1,${want}`);
    assert.equal(headers.authorization, undefined);
  } finally {
    bot.server.close();
  }
});

test("timeout prints pending and exits 5; wait picks the reply up later without resending", async () => {
  const s = sandbox();
  const bot = await fakeGrokBot({ reply: null });
  try {
    const env = { ...setup(s), GROKBOT_WEBHOOK_URL: bot.url, GROKBOT_WEBHOOK_SECRET: KEY };
    const r = await runAsync(s, ["grokbot", "send", "slow task", "--timeout", "1"], env);
    assert.equal(r.status, 5, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.status, "pending");
    assert.match(out.next, /grokbot wait --request-id gb_/);
    const id = out.request_id;

    const rep = s.run(["grokbot", "reply", "--request-id", id, "--status", "error"], { input: "could not reach X\n", env });
    assert.equal(rep.status, 0, rep.stderr);
    const w = s.run(["grokbot", "wait", "--request-id", id, "--timeout", "5"], { env });
    assert.equal(w.status, 1);
    assert.deepEqual({ ...JSON.parse(w.stdout), received_at: 0, seconds_after_send: 0 }, { request_id: id, status: "error", result: "could not reach X", received_at: 0, seconds_after_send: 0 });
    assert.equal(bot.calls.length, 1);
  } finally {
    bot.server.close();
  }
});

test("reply refuses unknown or malformed ids and empty answers", () => {
  const s = sandbox();
  const env = setup(s);
  const unknown = s.run(["grokbot", "reply", "--request-id", "gb_0000000000000000"], { input: "x", env });
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /no request gb_0000000000000000 was sent from this machine/);
  const bad = s.run(["grokbot", "reply", "--request-id", "../../etc/passwd"], { input: "x", env });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /not a Grok Bot request id/);
  const b64 = s.run(["grokbot", "reply", "--request-id", "gb_0000000000000000", "--force", "--result-b64", Buffer.from("héllo 'quoted'").toString("base64")], { env });
  assert.equal(b64.status, 0, b64.stderr);
  const w = s.run(["grokbot", "wait", "--request-id", "gb_0000000000000000", "--timeout", "0"], { env });
  assert.equal(JSON.parse(w.stdout).result, "héllo 'quoted'");
  const empty = s.run(["grokbot", "reply", "--request-id", "gb_0000000000000000", "--force"], { input: "  \n", env });
  assert.equal(empty.status, 2);
});

test("HTTP errors explain themselves; not set up says how to set up", async () => {
  const s = sandbox();
  const none = s.run(["grokbot", "send", "hi"], { env: setup(s) });
  assert.equal(none.status, 1);
  assert.match(none.stderr, /not set up.*grokbot setup/);
  const bot = await fakeGrokBot({ status: 401 });
  try {
    const r = await runAsync(s, ["grokbot", "send", "hi"], { ...setup(s), GROKBOT_WEBHOOK_URL: bot.url, GROKBOT_WEBHOOK_SECRET: KEY });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /HTTP 401.*key was rejected, or the routine is paused/);
  } finally {
    bot.server.close();
  }
  const plain = s.run(["grokbot", "send", "hi"], { env: { ...setup(s), GROKBOT_WEBHOOK_URL: "http://example.com/hook", GROKBOT_WEBHOOK_SECRET: KEY } });
  assert.match(plain.stderr, /must start with https/);
});

test("status shows what is set without printing values; instructions name the script", () => {
  const s = sandbox();
  const env = { ...setup(s), GROKBOT_WEBHOOK_URL: "https://hooks.example.invalid/secret-path", GROKBOT_WEBHOOK_SECRET: KEY };
  const st = s.run(["grokbot", "status"], { env });
  assert.equal(st.status, 0, st.stderr);
  assert.match(st.stdout, /Webhook URL\s+env/);
  assert.match(st.stdout, /Header\s+default \(Authorization\)/);
  assert.doesNotMatch(st.stdout, /secret-path|hooks\.example|test-key/);
  const ins = s.run(["grokbot", "instructions", "--print"], { env });
  assert.equal(ins.status, 0, ins.stderr);
  assert.match(ins.stdout, /grokbot reply --request-id <request_id> --status done <<'GROKBOT_REPLY'/);
  assert.ok(ins.stdout.includes(fs.realpathSync(SB)), "instructions carry the absolute script path");
  assert.doesNotMatch(ins.stdout, new RegExp(KEY));
});

test("extractUrl picks the webhook URL out of a pasted sentence", async () => {
  const { extractUrl } = await import("../skills/switchboard/scripts/lib/grokbot.mjs");
  assert.equal(extractUrl("https://hooks.example.invalid/a/b-1"), "https://hooks.example.invalid/a/b-1");
  assert.equal(extractUrl("Point it at `https://hooks.example.invalid/a/b-1`. Then copy the key."), "https://hooks.example.invalid/a/b-1");
  assert.equal(extractUrl("here: https://hooks.example.invalid/x."), "https://hooks.example.invalid/x");
  assert.equal(extractUrl("no url here"), "");
});

test("test sends a ping and prints the reply; instructions ask the Bot to create the routine", async () => {
  const s = sandbox();
  const bot = await fakeGrokBot({ reply: () => "pong" });
  try {
    const env = { ...setup(s), GROKBOT_WEBHOOK_URL: bot.url, GROKBOT_WEBHOOK_SECRET: KEY };
    const r = await runAsync(s, ["grokbot", "test"], env);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).result, "pong");
    assert.match(bot.calls[0].payload.task, /Reply with exactly the word: pong/);
  } finally {
    bot.server.close();
  }
  const ins = s.run(["grokbot", "instructions", "--print"], { env: setup(s) });
  assert.match(ins.stdout, /^Create a routine named "Switchboard" with a webhook trigger/);
});

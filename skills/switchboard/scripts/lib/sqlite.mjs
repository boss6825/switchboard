// Read-only SQLite queries for agents that keep chats in a database (Cursor's
// desktop app, OpenCode). Uses node:sqlite when this Node has it, otherwise
// the sqlite3 command (preinstalled on macOS and most Linux distributions).

import fs from "node:fs";
import { run, which, die } from "./util.mjs";

let nodeSqlite;

async function loadNodeSqlite() {
  if (nodeSqlite !== undefined) return nodeSqlite;
  // node:sqlite prints an ExperimentalWarning on some Node versions; it is noise here.
  const emit = process.emitWarning;
  process.emitWarning = (w, ...rest) => {
    if (String(w?.message || w).includes("SQLite")) return;
    return emit.call(process, w, ...rest);
  };
  try {
    nodeSqlite = await import("node:sqlite");
  } catch {
    nodeSqlite = null;
  } finally {
    process.emitWarning = emit;
  }
  return nodeSqlite;
}

// How to open a database another app is writing to. Without a write-ahead log,
// immutable=1 reads it without locks or touching any file. With one, the newest
// rows live in <file>-wal until the app checkpoints, and immutable=1 skips that
// file (OpenCode 2.x keeps fresh chats there), so open it read-only instead.
function uris(file) {
  let wal = 0;
  try {
    wal = fs.statSync(`${file}-wal`).size;
  } catch {}
  const base = `file:${encodeURI(file)}`;
  return wal > 0 ? [`${base}?mode=ro`, `${base}?immutable=1`] : [`${base}?immutable=1`];
}

export async function query(file, sql, params = []) {
  if (process.env.SWITCHBOARD_SQLITE !== "cli") {
    const mod = await loadNodeSqlite();
    if (mod?.DatabaseSync) {
      for (const uri of [...uris(file), file]) {
        let db;
        try {
          db = new mod.DatabaseSync(uri, { readOnly: true });
          return db.prepare(sql).all(...params);
        } catch (e) {
          if (uri === file) throw e;
        } finally {
          try {
            db?.close();
          } catch {}
        }
      }
    }
  }
  const bin = which("sqlite3");
  if (!bin) die("reading this agent's chats needs Node 22.13+ or the sqlite3 command");
  // The CLI has no bound parameters; inline them as quoted literals.
  let i = 0;
  const text = sql.replace(/\?/g, () => {
    const v = params[i++];
    return typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`;
  });
  let r;
  for (const uri of uris(file)) {
    r = run(bin, ["-json", "-readonly", uri, text], { timeout: 120000 });
    if (r.ok) return r.out.trim() ? JSON.parse(r.out) : [];
  }
  die(`sqlite3 failed on ${file}: ${r.err.trim()}`);
}

export async function tables(file) {
  const rows = await query(file, "select name from sqlite_master where type = 'table'");
  return new Set(rows.map((r) => r.name));
}

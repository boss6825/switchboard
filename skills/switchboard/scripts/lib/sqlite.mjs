// Read-only SQLite queries for agents that keep chats in a database (Cursor's
// desktop app, OpenCode). Uses node:sqlite when this Node has it, otherwise
// the sqlite3 command (preinstalled on macOS and most Linux distributions).

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

// Open with immutable=1 so a database the app is writing to right now is read
// without taking locks or touching its WAL files. Rows may lag by a few seconds.
export async function query(file, sql, params = []) {
  if (process.env.SWITCHBOARD_SQLITE !== "cli") {
    const mod = await loadNodeSqlite();
    if (mod?.DatabaseSync) {
      let db;
      try {
        try {
          db = new mod.DatabaseSync(`file:${encodeURI(file)}?immutable=1`, { readOnly: true });
        } catch {
          db = new mod.DatabaseSync(file, { readOnly: true });
        }
        return db.prepare(sql).all(...params);
      } finally {
        try {
          db?.close();
        } catch {}
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
  const r = run(bin, ["-json", "-readonly", `file:${encodeURI(file)}?immutable=1`, text], { timeout: 120000 });
  if (!r.ok) die(`sqlite3 failed on ${file}: ${r.err.trim()}`);
  return r.out.trim() ? JSON.parse(r.out) : [];
}

export async function tables(file) {
  const rows = await query(file, "select name from sqlite_master where type = 'table'");
  return new Set(rows.map((r) => r.name));
}

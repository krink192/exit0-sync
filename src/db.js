// SPDX-License-Identifier: AGPL-3.0-or-later
// SQLite storage for exit0-sync. One file, opened with Node's built-in node:sqlite (no native dependencies).
"use strict";
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const path = require("node:path");

const MIGRATIONS = [
  `CREATE TABLE users (
     id INTEGER PRIMARY KEY,
     username TEXT NOT NULL UNIQUE COLLATE NOCASE,
     pw_hash TEXT NOT NULL,
     seq INTEGER NOT NULL DEFAULT 0,          -- per-user change counter, bumped on every replica write
     created_at INTEGER NOT NULL
   );
   CREATE TABLE devices (
     id TEXT PRIMARY KEY,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     name TEXT NOT NULL,
     token_hash TEXT NOT NULL UNIQUE,          -- sha256 of the bearer token; the token itself is never stored
     created_at INTEGER NOT NULL,
     last_seen INTEGER NOT NULL
   );
   CREATE TABLE packs (
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     pack TEXT NOT NULL,
     epoch INTEGER NOT NULL DEFAULT 1,         -- bumped by a progress reset; devices on an older epoch start over
     PRIMARY KEY (user_id, pack)
   );
   CREATE TABLE replicas (
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     pack TEXT NOT NULL,
     device_id TEXT NOT NULL,                  -- kept after the device is revoked, so its progress still counts
     seq INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     doc TEXT NOT NULL,
     PRIMARY KEY (user_id, pack, device_id)
   );
   CREATE INDEX replicas_seq ON replicas (user_id, pack, seq);`,
];

function open(file) {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  if (file !== ":memory:") db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
  const version = db.prepare("PRAGMA user_version").get().user_version;
  for (let v = version; v < MIGRATIONS.length; v++) {
    tx(db, () => { db.exec(MIGRATIONS[v]); db.exec(`PRAGMA user_version = ${v + 1}`); });
  }
  return db;
}

function tx(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try { const r = fn(); db.exec("COMMIT"); return r; }
  catch (e) { db.exec("ROLLBACK"); throw e; }
}

module.exports = { open, tx };

// SPDX-License-Identifier: AGPL-3.0-or-later
// Data access: users, devices and per-device replicas. All SQL lives here.
"use strict";
const { tx } = require("./db");
const A = require("./auth");

class Conflict extends Error { constructor(msg, extra) { super(msg); this.extra = extra; } }

class Store {
  constructor(db, now) { this.db = db; this.now = now || Date.now; }

  // ---------------------------------------------------------------- users
  async addUser(username, password, hashOpts) {
    const e = A.checkUsername(username) || A.checkPassword(password); if (e) throw new Error(e);
    if (this.userByName(username)) throw new Error("That username is taken.");
    const hash = await A.hashPassword(password, hashOpts);
    const r = this.db.prepare("INSERT INTO users (username, pw_hash, created_at) VALUES (?, ?, ?)").run(username, hash, this.now());
    return this.userById(Number(r.lastInsertRowid));
  }
  userByName(u) { return this.db.prepare("SELECT * FROM users WHERE username = ?").get(u); }
  userById(id) { return this.db.prepare("SELECT * FROM users WHERE id = ?").get(id); }
  listUsers() {
    return this.db.prepare(`SELECT u.id, u.username, u.created_at, COUNT(d.id) AS devices FROM users u
                            LEFT JOIN devices d ON d.user_id = u.id GROUP BY u.id ORDER BY u.username`).all();
  }
  userCount() { return this.db.prepare("SELECT COUNT(*) AS n FROM users").get().n; }
  async setPassword(userId, password, hashOpts) {
    const e = A.checkPassword(password); if (e) throw new Error(e);
    this.db.prepare("UPDATE users SET pw_hash = ? WHERE id = ?").run(await A.hashPassword(password, hashOpts), userId);
  }
  deleteUser(userId) { this.db.prepare("DELETE FROM users WHERE id = ?").run(userId); }

  // ---------------------------------------------------------------- devices / tokens
  addDevice(userId, name) {
    const token = A.newToken(), id = A.newId(), t = this.now();
    name = String(name || "Device").trim().slice(0, 60) || "Device";
    this.db.prepare("INSERT INTO devices (id, user_id, name, token_hash, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, userId, name, A.sha256(token), t, t);
    return { token, device: { id, name, createdAt: t } };
  }
  deviceByToken(token) {
    if (typeof token !== "string" || token.length < 20) return null;
    const d = this.db.prepare("SELECT * FROM devices WHERE token_hash = ?").get(A.sha256(token));
    if (d && this.now() - d.last_seen > 60000) this.db.prepare("UPDATE devices SET last_seen = ? WHERE id = ?").run(this.now(), d.id);
    return d || null;
  }
  listDevices(userId) {
    return this.db.prepare("SELECT id, name, created_at AS createdAt, last_seen AS lastSeen FROM devices WHERE user_id = ? ORDER BY created_at").all(userId);
  }
  /** Revokes a device's token. Its replicas stay, so the progress it made still counts. */
  deleteDevice(userId, deviceId) {
    return this.db.prepare("DELETE FROM devices WHERE id = ? AND user_id = ?").run(deviceId, userId).changes > 0;
  }
  deleteOtherDevices(userId, keepId) { this.db.prepare("DELETE FROM devices WHERE user_id = ? AND id <> ?").run(userId, keepId || ""); }

  // ---------------------------------------------------------------- replicas
  epoch(userId, pack) {
    const r = this.db.prepare("SELECT epoch FROM packs WHERE user_id = ? AND pack = ?").get(userId, pack);
    return r ? r.epoch : 1;
  }
  /** Replicas changed after `since`, the current epoch and the latest seq for this pack. */
  pull(userId, pack, since) {
    const rows = this.db.prepare(`SELECT device_id, seq, updated_at, doc FROM replicas
                                  WHERE user_id = ? AND pack = ? AND seq > ? ORDER BY seq`).all(userId, pack, since || 0);
    const top = this.db.prepare("SELECT MAX(seq) AS s FROM replicas WHERE user_id = ? AND pack = ?").get(userId, pack).s || 0;
    return { epoch: this.epoch(userId, pack), seq: Math.max(top, since || 0),
             replicas: rows.map(r => ({ device: r.device_id, seq: r.seq, updatedAt: r.updated_at, doc: JSON.parse(r.doc) })) };
  }
  /**
   * Store a device's own replica. `base` is the seq of this device's replica the client last saw (0 = none yet),
   * so two tabs on the same device can't silently overwrite each other. Throws Conflict on epoch or base mismatch.
   */
  push(userId, pack, deviceId, { epoch, base, doc }) {
    const json = JSON.stringify(doc);
    return tx(this.db, () => {
      const cur = this.epoch(userId, pack);
      if (epoch !== cur) throw new Conflict("Progress was reset on another device.", { epoch: cur });
      const row = this.db.prepare("SELECT seq FROM replicas WHERE user_id = ? AND pack = ? AND device_id = ?").get(userId, pack, deviceId);
      const have = row ? row.seq : 0;
      if ((base || 0) !== have) throw new Conflict("This device's data changed elsewhere. Pull and try again.", { seq: have });
      const seq = this.db.prepare("UPDATE users SET seq = seq + 1 WHERE id = ? RETURNING seq").get(userId).seq;
      this.db.prepare(`INSERT INTO replicas (user_id, pack, device_id, seq, updated_at, doc) VALUES (?, ?, ?, ?, ?, ?)
                       ON CONFLICT (user_id, pack, device_id) DO UPDATE SET seq = excluded.seq, updated_at = excluded.updated_at, doc = excluded.doc`)
        .run(userId, pack, deviceId, seq, this.now(), json);
      return { seq, epoch: cur };
    });
  }
  /** Wipe every device's progress for a pack and start a new epoch. */
  reset(userId, pack) {
    return tx(this.db, () => {
      this.db.prepare("DELETE FROM replicas WHERE user_id = ? AND pack = ?").run(userId, pack);
      this.db.prepare(`INSERT INTO packs (user_id, pack, epoch) VALUES (?, ?, 2)
                       ON CONFLICT (user_id, pack) DO UPDATE SET epoch = epoch + 1`).run(userId, pack);
      return { epoch: this.epoch(userId, pack) };
    });
  }
}

module.exports = { Store, Conflict };

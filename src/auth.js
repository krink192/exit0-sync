// SPDX-License-Identifier: AGPL-3.0-or-later
// Passwords (scrypt), bearer tokens and login rate limiting.
"use strict";
const crypto = require("node:crypto");

// OWASP Password Storage Cheat Sheet: scrypt N=2^17, r=8, p=1 (about 128 MiB of memory per hash).
const SCRYPT = { N: 2 ** 17, r: 8, p: 1, keylen: 32 };
const MAXMEM = 256 * 1024 * 1024;
const PW_MIN = 10, PW_MAX = 256;

function scrypt(password, salt, o) {
  return new Promise((resolve, reject) =>
    crypto.scrypt(password, salt, o.keylen, { N: o.N, r: o.r, p: o.p, maxmem: MAXMEM }, (err, key) => err ? reject(err) : resolve(key)));
}

async function hashPassword(password, opts) {
  const o = Object.assign({}, SCRYPT, opts);
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, o);
  return ["scrypt", o.N, o.r, o.p, salt.toString("base64url"), key.toString("base64url")].join("$");
}

async function verifyPassword(password, stored) {
  const [alg, N, r, p, salt, hash] = String(stored).split("$");
  if (alg !== "scrypt") return false;
  const expected = Buffer.from(hash, "base64url");
  const key = await scrypt(password, Buffer.from(salt, "base64url"), { N: +N, r: +r, p: +p, keylen: expected.length });
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

/** Returns an error message, or null when the password is acceptable. */
function checkPassword(pw) {
  if (typeof pw !== "string" || pw.length < PW_MIN) return `Password must be at least ${PW_MIN} characters.`;
  if (pw.length > PW_MAX) return `Password must be at most ${PW_MAX} characters.`;
  return null;
}
function checkUsername(u) {
  if (typeof u !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,31}$/.test(u)) return "Username: 2-32 letters, numbers, dot, dash or underscore.";
  return null;
}

const newToken = () => crypto.randomBytes(32).toString("base64url");
const newId = () => crypto.randomBytes(9).toString("base64url");
const sha256 = s => crypto.createHash("sha256").update(s).digest("hex");

/** Fixed-window failure counter: at most `max` failed logins per key per `windowMs`. */
class Limiter {
  constructor(max, windowMs, now) { this.max = max; this.windowMs = windowMs; this.now = now || Date.now; this.hits = new Map(); }
  blocked(key) { const h = this.hits.get(key); if (!h) return false; if (this.now() - h.start > this.windowMs) { this.hits.delete(key); return false; } return h.n >= this.max; }
  fail(key) { const t = this.now(); const h = this.hits.get(key); if (!h || t - h.start > this.windowMs) this.hits.set(key, { start: t, n: 1 }); else h.n++; }
  clear(key) { this.hits.delete(key); }
  retryAfter(key) { const h = this.hits.get(key); return h ? Math.max(1, Math.ceil((h.start + this.windowMs - this.now()) / 1000)) : 0; }
}

module.exports = { hashPassword, verifyPassword, checkPassword, checkUsername, newToken, newId, sha256, Limiter, SCRYPT, PW_MIN };

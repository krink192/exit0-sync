// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const db = require("../src/db");
const { Store } = require("../src/store");
const { createServer } = require("../src/server");
const A = require("../src/auth");

const FAST = { N: 1024 };          // cheap scrypt for tests; production uses A.SCRYPT
let server, base, store, appDir;

async function call(method, p, { token, body, headers, raw } = {}) {
  const h = Object.assign({}, headers);
  if (token) h.Authorization = "Bearer " + token;
  if (body !== undefined) h["Content-Type"] = h["Content-Type"] || "application/json";
  const res = await fetch(base + p, { method, headers: h, body: body === undefined ? undefined : raw ? body : JSON.stringify(body) });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch (e) { /* static file */ }
  return { status: res.status, json, text, headers: res.headers };
}
const login = (username, password, device) => call("POST", "/v1/login", { body: { username, password, device } });

before(async () => {
  appDir = fs.mkdtempSync(path.join(os.tmpdir(), "exit0-app-"));
  fs.writeFileSync(path.join(appDir, "index.html"), "<!doctype html><title>exit 0</title>");
  fs.writeFileSync(path.join(os.tmpdir(), "exit0-secret.txt"), "secret");
  store = new Store(db.open(":memory:"));
  await store.addUser("jacob", "correct horse battery", FAST);
  await store.addUser("other", "another long password", FAST);
  server = createServer({ store, appDir, hashOpts: FAST });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  base = "http://127.0.0.1:" + server.address().port;
});
after(() => server.close());

test("health reports protocol and sign-up state", async () => {
  const r = await call("GET", "/v1/health");
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual([r.json.ok, r.json.protocol, r.json.signup], [true, 1, false]);
});

test("sign-up is off by default", async () => {
  const r = await call("POST", "/v1/signup", { body: { username: "new", password: "long enough pw" } });
  assert.strictEqual(r.status, 403);
});

test("wrong password and unknown user both get 401", async () => {
  assert.strictEqual((await login("jacob", "wrong password!!", "x")).status, 401);
  assert.strictEqual((await login("nobody", "whatever12345", "x")).status, 401);
});

test("login returns a token; username is case-insensitive; token is stored hashed", async () => {
  const r = await login("Jacob", "correct horse battery", "Fedora laptop");
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.user.username, "jacob");
  assert.strictEqual(r.json.device.name, "Fedora laptop");
  const rows = store.db.prepare("SELECT token_hash FROM devices").all().map(x => x.token_hash);
  assert(!rows.includes(r.json.token));
  assert(rows.includes(A.sha256(r.json.token)));
  const me = await call("GET", "/v1/me", { token: r.json.token });
  assert.strictEqual(me.json.device.id, r.json.device.id);
});

test("API needs a valid token", async () => {
  assert.strictEqual((await call("GET", "/v1/me")).status, 401);
  assert.strictEqual((await call("GET", "/v1/me", { token: "x".repeat(43) })).status, 401);
});

test("two devices sync replicas; a device can only write its own", async () => {
  const a = (await login("jacob", "correct horse battery", "Laptop")).json;
  const b = (await login("jacob", "correct horse battery", "Phone")).json;
  let pull = await call("GET", "/v1/packs/le010-test", { token: a.token });
  assert.deepStrictEqual(pull.json, { epoch: 1, seq: 0, replicas: [] });

  const put = await call("PUT", `/v1/packs/le010-test/replicas/${a.device.id}`, { token: a.token, body: { epoch: 1, base: 0, doc: { qstats: { q1: { seen: 1 } } } } });
  assert.strictEqual(put.status, 200);
  const seqA = put.json.seq;

  pull = await call("GET", "/v1/packs/le010-test?since=0", { token: b.token });
  assert.strictEqual(pull.json.replicas.length, 1);
  assert.strictEqual(pull.json.replicas[0].device, a.device.id);
  assert.deepStrictEqual(pull.json.replicas[0].doc, { qstats: { q1: { seen: 1 } } });
  assert.strictEqual(pull.json.seq, seqA);

  // stale base (another tab of the same device already wrote) -> 409 with the current seq
  const stale = await call("PUT", `/v1/packs/le010-test/replicas/${a.device.id}`, { token: a.token, body: { epoch: 1, base: 0, doc: {} } });
  assert.strictEqual(stale.status, 409);
  assert.strictEqual(stale.json.seq, seqA);

  const forged = await call("PUT", `/v1/packs/le010-test/replicas/${a.device.id}`, { token: b.token, body: { epoch: 1, base: seqA, doc: {} } });
  assert.strictEqual(forged.status, 403);

  // incremental pull only returns what changed
  await call("PUT", `/v1/packs/le010-test/replicas/${b.device.id}`, { token: b.token, body: { epoch: 1, base: 0, doc: { days: {} } } });
  pull = await call("GET", `/v1/packs/le010-test?since=${seqA}`, { token: a.token });
  assert.deepStrictEqual(pull.json.replicas.map(r => r.device), [b.device.id]);
});

test("users can't see each other's data", async () => {
  const o = (await login("other", "another long password", "PC")).json;
  const pull = await call("GET", "/v1/packs/le010-test", { token: o.token });
  assert.deepStrictEqual(pull.json.replicas, []);
});

test("reset wipes replicas, bumps the epoch, and rejects writes from the old epoch", async () => {
  const a = (await login("jacob", "correct horse battery", "Laptop")).json;
  await call("PUT", `/v1/packs/le010-reset/replicas/${a.device.id}`, { token: a.token, body: { epoch: 1, base: 0, doc: { x: 1 } } });
  const r = await call("POST", "/v1/packs/le010-reset/reset", { token: a.token });
  assert.strictEqual(r.json.epoch, 2);
  const pull = await call("GET", "/v1/packs/le010-reset", { token: a.token });
  assert.deepStrictEqual([pull.json.epoch, pull.json.replicas.length], [2, 0]);
  const old = await call("PUT", `/v1/packs/le010-reset/replicas/${a.device.id}`, { token: a.token, body: { epoch: 1, base: 0, doc: {} } });
  assert.strictEqual(old.status, 409);
  assert.strictEqual(old.json.epoch, 2);
  const ok = await call("PUT", `/v1/packs/le010-reset/replicas/${a.device.id}`, { token: a.token, body: { epoch: 2, base: 0, doc: {} } });
  assert.strictEqual(ok.status, 200);
});

test("bad input is rejected", async () => {
  const a = (await login("jacob", "correct horse battery", "Laptop")).json;
  assert.strictEqual((await call("GET", "/v1/packs/..%2Fetc", { token: a.token })).status, 400);
  assert.strictEqual((await call("PUT", `/v1/packs/le010/replicas/${a.device.id}`, { token: a.token, body: { epoch: 1, doc: [1] } })).status, 400);
  assert.strictEqual((await call("PUT", `/v1/packs/le010/replicas/${a.device.id}`, { token: a.token, body: "{nope", raw: true })).status, 400);
  assert.strictEqual((await call("PUT", `/v1/packs/le010/replicas/${a.device.id}`, { token: a.token, body: "{}", raw: true, headers: { "Content-Type": "text/plain" } })).status, 415);
  const big = JSON.stringify({ epoch: 1, base: 0, doc: { pad: "x".repeat(3 * 1024 * 1024) } });
  assert.strictEqual((await call("PUT", `/v1/packs/le010/replicas/${a.device.id}`, { token: a.token, body: big, raw: true })).status, 413);
});

test("devices can be listed and revoked; logout revokes the token", async () => {
  const a = (await login("jacob", "correct horse battery", "Laptop")).json;
  const b = (await login("jacob", "correct horse battery", "Old phone")).json;
  const list = await call("GET", "/v1/devices", { token: a.token });
  assert(list.json.devices.some(d => d.id === b.device.id));
  assert.strictEqual((await call("DELETE", `/v1/devices/${b.device.id}`, { token: a.token })).status, 200);
  assert.strictEqual((await call("GET", "/v1/me", { token: b.token })).status, 401);
  assert.strictEqual((await call("POST", "/v1/logout", { token: a.token })).status, 200);
  assert.strictEqual((await call("GET", "/v1/me", { token: a.token })).status, 401);
});

test("password change checks the current password and can sign out other devices", async () => {
  const a = (await login("other", "another long password", "A")).json;
  const b = (await login("other", "another long password", "B")).json;
  assert.strictEqual((await call("POST", "/v1/password", { token: a.token, body: { current: "nope", password: "a brand new password" } })).status, 403);
  assert.strictEqual((await call("POST", "/v1/password", { token: a.token, body: { current: "another long password", password: "short" } })).status, 400);
  const ok = await call("POST", "/v1/password", { token: a.token, body: { current: "another long password", password: "a brand new password", signOutOthers: true } });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual((await call("GET", "/v1/me", { token: b.token })).status, 401);
  assert.strictEqual((await call("GET", "/v1/me", { token: a.token })).status, 200);
  assert.strictEqual((await login("other", "a brand new password", "C")).status, 200);
});

test("repeated failed logins are rate limited", async () => {
  await store.addUser("target", "target long password", FAST);
  let last;
  for (let i = 0; i < 11; i++) last = await login("target", "wrong guess " + i, "x");
  assert.strictEqual(last.status, 429);
  assert(Number(last.headers.get("retry-after")) > 0);
  assert.strictEqual((await login("target", "target long password", "x")).status, 429);   // even the right password, until the window passes
});

test("CORS preflight is answered for the API", async () => {
  const r = await call("OPTIONS", "/v1/packs/le010", { headers: { Origin: "https://krink192.github.io", "Access-Control-Request-Method": "PUT" } });
  assert.strictEqual(r.status, 204);
  assert.strictEqual(r.headers.get("access-control-allow-origin"), "*");
  assert.match(r.headers.get("access-control-allow-headers"), /Authorization/);
});

test("serves the web app and refuses path traversal", async () => {
  const r = await call("GET", "/");
  assert.strictEqual(r.status, 200);
  assert.match(r.headers.get("content-type"), /text\/html/);
  assert.match(r.text, /exit 0/);
  assert.strictEqual((await call("GET", "/../exit0-secret.txt")).status, 404);
  assert.strictEqual((await call("GET", "/%2e%2e/exit0-secret.txt")).status, 404);
  assert.strictEqual((await call("GET", "/healthz")).text, "ok\n");
});

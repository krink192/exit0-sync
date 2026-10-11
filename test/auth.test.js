// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const A = require("../src/auth");

test("production scrypt parameters hash and verify", async () => {
  const h = await A.hashPassword("correct horse battery");
  assert.match(h, /^scrypt\$131072\$8\$1\$/);
  assert(await A.verifyPassword("correct horse battery", h));
  assert(!(await A.verifyPassword("correct horse batterY", h)));
});

test("same password gets a different salt each time", async () => {
  const a = await A.hashPassword("same password here", { N: 1024 }), b = await A.hashPassword("same password here", { N: 1024 });
  assert.notStrictEqual(a, b);
});

test("password and username rules", () => {
  assert(A.checkPassword("short"));
  assert.strictEqual(A.checkPassword("long enough!"), null);
  assert(A.checkPassword("x".repeat(257)));
  assert.strictEqual(A.checkUsername("jacob"), null);
  assert(A.checkUsername("j"));
  assert(A.checkUsername("bad name"));
  assert(A.checkUsername("../x"));
});

test("limiter blocks after max failures and resets after the window", () => {
  let t = 0; const L = new A.Limiter(3, 1000, () => t);
  for (let i = 0; i < 3; i++) L.fail("k");
  assert(L.blocked("k"));
  t = 1001; assert(!L.blocked("k"));
});

test("tokens are long and random", () => {
  const a = A.newToken(), b = A.newToken();
  assert.notStrictEqual(a, b);
  assert(a.length >= 43);
});

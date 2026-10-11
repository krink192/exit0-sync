#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// exit0-sync: self-hosted progress sync for exit 0.
//   exit0-sync serve                 start the server (default)
//   exit0-sync user add <name>       create an account (asks for the password)
//   exit0-sync user passwd <name>    change a password and sign out every device
//   exit0-sync user list             list accounts
//   exit0-sync user delete <name>    delete an account and all of its progress
//   exit0-sync devices <name>        list a user's signed-in devices
//   exit0-sync backup [file]         write a consistent copy of the database (safe while running)
// Settings come from environment variables; see README.md.
"use strict";
const readline = require("node:readline");
const db = require("../src/db");
const { Store } = require("../src/store");
const { createServer, VERSION } = require("../src/server");

const env = process.env;
const cfg = {
  db: env.EXIT0_DB || "./data/exit0.db",
  port: parseInt(env.PORT || "8080", 10),
  host: env.HOST || "0.0.0.0",
  appDir: env.EXIT0_APP_DIR || null,
  signup: /^(1|true|open|yes)$/i.test(env.EXIT0_SIGNUP || ""),
  trustProxy: /^(1|true|yes)$/i.test(env.EXIT0_TRUST_PROXY || ""),
};

function ask(question, hidden) {
  return new Promise(resolve => {
    if (!process.stdin.isTTY) {               // piped: read one line (for scripts: echo "$PW" | exit0-sync user add jacob)
      const rl = readline.createInterface({ input: process.stdin });
      rl.once("line", l => { resolve(l); rl.close(); });
      rl.once("close", () => resolve(""));
      return;
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) rl._writeToOutput = s => { if (s.includes(question)) process.stdout.write(s); };
    rl.question(question, a => { resolve(a); rl.close(); if (hidden) process.stdout.write("\n"); });
  });
}
async function newPassword() {
  const a = await ask("Password: ", true);
  if (process.stdin.isTTY) { const b = await ask("Repeat password: ", true); if (a !== b) throw new Error("Passwords don't match."); }
  return a;
}
const fmt = t => new Date(t).toISOString().replace("T", " ").slice(0, 16);

async function main(argv) {
  const [cmd = "serve", sub, name] = argv;
  if (cmd === "--version" || cmd === "version") return console.log(VERSION);
  const store = new Store(db.open(cfg.db));

  if (cmd === "serve") {
    const server = createServer({ store, appDir: cfg.appDir, signup: cfg.signup, trustProxy: cfg.trustProxy,
      log: (...a) => console.log(new Date().toISOString(), ...a) });
    server.listen(cfg.port, cfg.host, () => {
      console.log(`exit0-sync ${VERSION} listening on http://${cfg.host}:${cfg.port}`);
      console.log(`  database: ${cfg.db}${cfg.appDir ? `\n  web app:  ${cfg.appDir}` : ""}\n  sign-up:  ${cfg.signup ? "open" : "off (create accounts with: exit0-sync user add <name>)"}`);
      if (!store.userCount() && !cfg.signup) console.log("  No accounts yet. Create one: exit0-sync user add <name>");
    });
    const stop = () => server.close(() => process.exit(0));
    process.on("SIGTERM", stop); process.on("SIGINT", stop);
    return;
  }
  if (cmd === "user") {
    if (sub === "list") {
      const rows = store.listUsers();
      if (!rows.length) return console.log("No accounts.");
      for (const u of rows) console.log(`${u.username.padEnd(24)} ${String(u.devices).padStart(2)} device(s)   created ${fmt(u.created_at)}`);
      return;
    }
    if (!name) throw new Error("Give a username, for example: exit0-sync user " + (sub || "add") + " jacob");
    if (sub === "add") { const u = await store.addUser(name.toLowerCase(), await newPassword()); return console.log(`Created ${u.username}.`); }
    const u = store.userByName(name); if (!u) throw new Error(`No user named ${name}.`);
    if (sub === "passwd") { await store.setPassword(u.id, await newPassword()); store.deleteOtherDevices(u.id, null); return console.log(`Password changed. All of ${u.username}'s devices were signed out.`); }
    if (sub === "delete") {
      const yes = await ask(`Delete ${u.username} and all of their progress? Type the username to confirm: `);
      if (yes.trim().toLowerCase() !== u.username.toLowerCase()) return console.log("Cancelled.");
      store.deleteUser(u.id); return console.log(`Deleted ${u.username}.`);
    }
  }
  if (cmd === "backup") {
    // Consistent snapshot while the server keeps running (SQLite VACUUM INTO).
    const out = sub || `${cfg.db.replace(/\.db$/, "")}-backup-${new Date().toISOString().slice(0, 10)}.db`;
    if (require("node:fs").existsSync(out)) throw new Error(`${out} already exists.`);
    store.db.prepare("VACUUM INTO ?").run(out);
    return console.log(`Backup written to ${out}`);
  }
  if (cmd === "devices" && sub) {
    const u = store.userByName(sub); if (!u) throw new Error(`No user named ${sub}.`);
    for (const d of store.listDevices(u.id)) console.log(`${d.id}  ${d.name.padEnd(30)} last seen ${fmt(d.lastSeen)}`);
    return;
  }
  throw new Error("Unknown command. Run with no arguments to start the server, or see the comments at the top of bin/exit0-sync.js.");
}

main(process.argv.slice(2)).catch(e => { console.error("Error: " + e.message); process.exit(1); });

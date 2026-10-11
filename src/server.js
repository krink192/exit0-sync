// SPDX-License-Identifier: AGPL-3.0-or-later
// HTTP API (protocol v1) plus an optional static file server for the exit 0 web app.
"use strict";
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { Conflict } = require("./store");
const A = require("./auth");
const VERSION = require("../package.json").version;

const PACK_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png", ".svg": "image/svg+xml",
  ".ico": "image/x-icon", ".jpg": "image/jpeg", ".webp": "image/webp", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8" };

class HttpError extends Error { constructor(status, msg, extra) { super(msg); this.status = status; this.extra = extra; } }

function createApp(opts) {
  const { store } = opts;
  const signup = !!opts.signup;
  const maxBody = opts.maxBody || 2 * 1024 * 1024;
  const appDir = opts.appDir ? path.resolve(opts.appDir) : null;
  const log = opts.log || (() => {});
  const ipLimit = new A.Limiter(30, 15 * 60 * 1000, opts.now);    // failed logins per IP
  const userLimit = new A.Limiter(10, 15 * 60 * 1000, opts.now);  // failed logins per username
  const hashOpts = opts.hashOpts;

  function clientIp(req) {
    if (opts.trustProxy) {
      const cf = req.headers["cf-connecting-ip"]; if (cf) return String(cf);
      const xff = req.headers["x-forwarded-for"]; if (xff) return String(xff).split(",")[0].trim();
    }
    return req.socket.remoteAddress || "?";
  }

  function send(res, status, body, headers) {
    const data = body === undefined ? "" : JSON.stringify(body);
    res.writeHead(status, Object.assign({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }, headers));
    res.end(data);
  }

  function readJson(req) {
    return new Promise((resolve, reject) => {
      const type = String(req.headers["content-type"] || "");
      if (!type.startsWith("application/json")) return reject(new HttpError(415, "Send JSON (Content-Type: application/json)."));
      const declared = parseInt(req.headers["content-length"] || "0", 10);
      if (declared > maxBody * 4) { req.resume(); return reject(new HttpError(413, "Request body too large.")); }
      let size = 0, tooBig = false; const chunks = [];
      // Oversized bodies are drained and discarded (not kept in memory) so the client still gets a clean 413.
      req.on("data", c => { size += c.length; if (size > maxBody) { tooBig = true; chunks.length = 0; } else if (!tooBig) chunks.push(c); });
      req.on("end", () => {
        if (tooBig) return reject(new HttpError(413, "Request body too large."));
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); } catch (e) { reject(new HttpError(400, "Body is not valid JSON.")); }
      });
      req.on("error", reject);
    });
  }

  function auth(req) {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || "");
    const device = m && store.deviceByToken(m[1]);
    if (!device) throw new HttpError(401, "Sign in again.");
    return { device, user: store.userById(device.user_id) };
  }
  const pub = (user, device) => ({ user: { id: user.id, username: user.username }, device: { id: device.id, name: device.name } });

  async function login(req, res) {
    const ip = clientIp(req);
    const b = await readJson(req);
    const username = String(b.username || "").trim().toLowerCase();
    if (ipLimit.blocked(ip) || userLimit.blocked(username)) {
      throw new HttpError(429, "Too many failed sign-ins. Try again later.", { retryAfter: Math.max(ipLimit.retryAfter(ip), userLimit.retryAfter(username)) });
    }
    const user = store.userByName(username);
    // Hash even for unknown users so response time doesn't reveal which usernames exist.
    const ok = user ? await A.verifyPassword(String(b.password || ""), user.pw_hash) : (await A.hashPassword("x", hashOpts), false);
    if (!ok) { ipLimit.fail(ip); userLimit.fail(username); log("login failed", username, ip); throw new HttpError(401, "Wrong username or password."); }
    userLimit.clear(username);
    const { token, device } = store.addDevice(user.id, b.device);
    log("login", user.username, device.name);
    send(res, 200, Object.assign({ token }, pub(user, device)));
  }

  async function signupRoute(req, res) {
    if (!signup) throw new HttpError(403, "Sign-up is turned off on this server. Ask the admin for an account.");
    const ip = clientIp(req);
    if (ipLimit.blocked(ip)) throw new HttpError(429, "Too many attempts. Try again later.");
    const b = await readJson(req);
    let user;
    try { user = await store.addUser(String(b.username || "").trim().toLowerCase(), b.password, hashOpts); }
    catch (e) { ipLimit.fail(ip); throw new HttpError(400, e.message); }
    const { token, device } = store.addDevice(user.id, b.device);
    log("signup", user.username);
    send(res, 201, Object.assign({ token }, pub(user, device)));
  }

  function packOf(name) { if (!PACK_RE.test(name)) throw new HttpError(400, "Unknown pack name."); return name; }

  async function api(req, res, url) {
    const p = url.pathname, method = req.method;
    let m;
    if (p === "/v1/health" && method === "GET") return send(res, 200, { ok: true, app: "exit0-sync", version: VERSION, protocol: 1, signup });
    if (p === "/v1/login" && method === "POST") return login(req, res);
    if (p === "/v1/signup" && method === "POST") return signupRoute(req, res);

    const { user, device } = auth(req);
    if (p === "/v1/me" && method === "GET") return send(res, 200, pub(user, device));
    if (p === "/v1/logout" && method === "POST") { store.deleteDevice(user.id, device.id); return send(res, 200, { ok: true }); }
    if (p === "/v1/password" && method === "POST") {
      const b = await readJson(req);
      if (!(await A.verifyPassword(String(b.current || ""), user.pw_hash))) throw new HttpError(403, "Current password is wrong.");
      try { await store.setPassword(user.id, b.password, hashOpts); } catch (e) { throw new HttpError(400, e.message); }
      if (b.signOutOthers) store.deleteOtherDevices(user.id, device.id);
      return send(res, 200, { ok: true });
    }
    if (p === "/v1/devices" && method === "GET") return send(res, 200, { current: device.id, devices: store.listDevices(user.id) });
    if ((m = /^\/v1\/devices\/([\w-]+)$/.exec(p)) && method === "DELETE") {
      if (!store.deleteDevice(user.id, m[1])) throw new HttpError(404, "No such device.");
      return send(res, 200, { ok: true });
    }
    if ((m = /^\/v1\/packs\/([^/]+)$/.exec(p)) && method === "GET") {
      const since = Math.max(0, parseInt(url.searchParams.get("since") || "0", 10) || 0);
      return send(res, 200, store.pull(user.id, packOf(m[1]), since));
    }
    if ((m = /^\/v1\/packs\/([^/]+)\/replicas\/([\w-]+)$/.exec(p)) && method === "PUT") {
      const pack = packOf(m[1]);
      if (m[2] !== device.id) throw new HttpError(403, "A device can only write its own replica.");
      const b = await readJson(req);
      if (!b || typeof b.doc !== "object" || b.doc === null || Array.isArray(b.doc)) throw new HttpError(400, "doc must be an object.");
      if (!Number.isInteger(b.epoch) || !Number.isInteger(b.base || 0)) throw new HttpError(400, "epoch and base must be integers.");
      try { return send(res, 200, store.push(user.id, pack, device.id, b)); }
      catch (e) { if (e instanceof Conflict) throw new HttpError(409, e.message, e.extra); throw e; }
    }
    if ((m = /^\/v1\/packs\/([^/]+)\/reset$/.exec(p)) && method === "POST") return send(res, 200, store.reset(user.id, packOf(m[1])));
    throw new HttpError(404, "Not found.");
  }

  function serveStatic(req, res, url) {
    if (!appDir || (req.method !== "GET" && req.method !== "HEAD")) return send(res, 404, { error: "Not found." });
    let rel; try { rel = decodeURIComponent(url.pathname); } catch (e) { return send(res, 400, { error: "Bad path." }); }
    if (rel.endsWith("/")) rel += "index.html";
    const file = path.resolve(appDir, "." + rel);
    if (file !== appDir && !file.startsWith(appDir + path.sep)) return send(res, 404, { error: "Not found." });
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) return send(res, 404, { error: "Not found." });
      const ext = path.extname(file).toLowerCase();
      const fresh = ext === ".html" || ext === ".webmanifest" || path.basename(file) === "sw.js";
      res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream", "Content-Length": st.size,
        "Cache-Control": fresh ? "no-cache" : "public, max-age=3600" });
      if (req.method === "HEAD") return res.end();
      fs.createReadStream(file).pipe(res);
    });
  }

  return async function handler(req, res) {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    let url;
    try { url = new URL(req.url, "http://x"); } catch (e) { return send(res, 400, { error: "Bad URL." }); }
    if (url.pathname === "/healthz") { res.writeHead(200, { "Content-Type": "text/plain" }); return res.end("ok\n"); }
    if (!url.pathname.startsWith("/v1/")) { res.setHeader("X-Frame-Options", "SAMEORIGIN"); return serveStatic(req, res, url); }
    // The API uses bearer tokens (no cookies), so any origin may call it: the desktop app, GitHub Pages, or this server.
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Max-Age", "86400");
    if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
    try { await api(req, res, url); }
    catch (e) {
      if (e instanceof HttpError) {
        const headers = e.extra && e.extra.retryAfter ? { "Retry-After": String(e.extra.retryAfter) } : undefined;
        return send(res, e.status, Object.assign({ error: e.message }, e.extra), headers);
      }
      log("error", e && e.stack || e);
      send(res, 500, { error: "Server error." });
    }
  };
}

function createServer(opts) { return http.createServer(createApp(opts)); }

module.exports = { createServer, createApp, VERSION };

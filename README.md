# exit0-sync

Self-hosted progress sync for [exit 0](https://github.com/krink192/exit0-linux-essentials). Run it on your own
server and your progress (question history, spaced-repetition schedule, flashcards, labs, streak, exam date) stays
in step across the web app, the installed phone app and the desktop app. The container also serves the web app
itself, so one address gives you both.

- Accounts with username and password (scrypt, OWASP parameters), one sign-in per device, devices can be signed out
- Works offline: each device keeps working and catches up the next time it can reach the server
- No conflicts to resolve: every device uploads only its own progress and the app merges them (counts add up,
  the newest schedule wins), so the result is the same everywhere
- One SQLite file, zero npm dependencies, Node 22.13+ or the Docker image
- Free software under the GNU AGPL v3

## Quick start (Docker)

```bash
git clone https://github.com/krink192/exit0-sync && cd exit0-sync
docker compose up -d --build
docker compose exec exit0-sync exit0-sync user add jacob      # asks for a password (10+ characters)
```

Open `http://<server>:8080`, go to **Settings → Sync** and sign in. The server address is filled in for you.

Your phone and other computers need to reach the server over **HTTPS** (browsers only allow installing the app and
calling the server from an https page). Put it behind a reverse proxy or tunnel; see the runbook below.

## Runbook: Docker host + Cloudflare Tunnel

1. **Make sure the web app image has sync.** The container copies the app from `ghcr.io/krink192/exit0:latest`,
   which is published when the app repo makes a release. If the app's Settings page has no **Sync** card, publish
   a new app release first (`gh release create vX.Y.Z --repo krink192/exit0-linux-essentials --generate-notes`), then
   rebuild here with `docker compose build --pull`.
2. **Start it** on the Docker host (commands above). Check it: `curl -s http://localhost:8080/v1/health`.
3. **Create your account:** `docker compose exec exit0-sync exit0-sync user add jacob`.
   Sign-up from the app stays off unless you set `EXIT0_SIGNUP=true`.
4. **Publish it through your tunnel.** In Cloudflare Zero Trust → Networks → Tunnels → your tunnel → Public
   hostname: `exit0.<your-domain>` → `http://<docker-host-ip>:8080` (or `http://exit0-sync:8080` if `cloudflared`
   runs on the same Docker network). Keep `EXIT0_TRUST_PROXY=true` (the default in `compose.yaml`) so failed-login
   limits apply to the real client IP.
   - **Don't put a Cloudflare Access (or Authentik) login in front of `/v1/*`.** The app calls the API in the
     background with its own token and can't complete an SSO login page. If you want Access on the site, add a
     bypass policy for the path `/v1/`.
5. **Phone:** open `https://exit0.<your-domain>`, Settings → Sync → sign in, then install it (Android: browser menu →
   Install app / Add to Home screen; iPhone: Safari → Share → Add to Home Screen).
6. **Desktop app or GitHub Pages version:** Settings → Sync → server address `https://exit0.<your-domain>` → sign in.
7. **Backups:** `docker compose exec exit0-sync exit0-sync backup` writes a consistent copy to the data volume
   (`/data/exit0-backup-YYYY-MM-DD.db`). Copy it off the host, for example to a NAS:
   `docker cp exit0-sync:/data/exit0-backup-$(date +%F).db /mnt/nas/backups/`. To restore, stop the container and
   replace `/data/exit0.db` with a backup.
8. **Updates:** `git pull && docker compose up -d --build --pull always`.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `EXIT0_DB` | `./data/exit0.db` (`/data/exit0.db` in Docker) | SQLite database file |
| `PORT` / `HOST` | `8080` / `0.0.0.0` | Listen address |
| `EXIT0_APP_DIR` | none (`/srv/web` in Docker) | Folder with the web app to serve at `/` |
| `EXIT0_SIGNUP` | `false` | `true` lets anyone who can reach the server create an account |
| `EXIT0_TRUST_PROXY` | `false` (`true` in `compose.yaml`) | Use `CF-Connecting-IP` / `X-Forwarded-For` for rate limiting. Only enable behind a proxy. |

## Admin commands

```
exit0-sync user add <name>       create an account
exit0-sync user passwd <name>    change a password and sign out every device
exit0-sync user list             list accounts
exit0-sync user delete <name>    delete an account and all of its progress
exit0-sync devices <name>        list a user's signed-in devices
exit0-sync backup [file]         consistent copy of the database (safe while running)
```

In Docker, prefix with `docker compose exec exit0-sync`. For scripts, pipe the password: `echo "$PW" | exit0-sync user add jacob`.

## Run without Docker

```bash
node --version          # 22.13 or newer
EXIT0_APP_DIR=/path/to/exit0-linux-essentials/docs npm start
node bin/exit0-sync.js user add jacob
```

## Protocol v1

Bearer-token JSON API. CORS is open (`*`) because no cookies are used, so the desktop app and the GitHub Pages
version can call your server.

| Method | Path | |
|---|---|---|
| GET | `/v1/health` | `{ ok, app: "exit0-sync", version, protocol: 1, signup }` |
| POST | `/v1/login` | `{ username, password, device }` → `{ token, user, device }` |
| POST | `/v1/signup` | same as login, only when sign-up is on |
| GET | `/v1/me` | current user and device |
| POST | `/v1/logout` | revoke this device's token |
| POST | `/v1/password` | `{ current, password, signOutOthers }` |
| GET | `/v1/devices` | `{ current, devices: [{ id, name, createdAt, lastSeen }] }` |
| DELETE | `/v1/devices/{id}` | sign a device out (its progress stays) |
| GET | `/v1/packs/{pack}?since={seq}` | `{ epoch, seq, replicas: [{ device, seq, updatedAt, doc }] }` changed after `since` |
| PUT | `/v1/packs/{pack}/replicas/{deviceId}` | `{ epoch, base, doc }` → `{ seq, epoch }`. Own device only. 409 if `epoch` is stale (reset elsewhere) or `base` isn't this device's current seq |
| POST | `/v1/packs/{pack}/reset` | delete every device's progress for the pack, bump the epoch |

`doc` is opaque to the server (up to 2 MB). The merge rules live in the app (`docs/js/core.js`: `mergeStates`, `ownPart`).

## Security notes

- Passwords: scrypt N=2^17, r=8, p=1, random salt. Tokens: 256-bit random, stored as SHA-256 hashes only.
- Failed logins: 10 per username and 30 per IP per 15 minutes, then HTTP 429.
- The container runs as a non-root user with a read-only filesystem, no capabilities and `no-new-privileges`.
- Use HTTPS in front of it. Report security problems privately to the maintainer through GitHub.

## License

GNU Affero General Public License v3.0 or later. If you run a modified version for other people over a network, you
must offer them the source of your modified version.

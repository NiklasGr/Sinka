# Sinka

A self-hosted file-management and file-collection server, with an integrated file viewer.

The app binds **loopback only** (`127.0.0.1:9100`) and is reachable **exclusively over
HTTPS**. There is no LAN/plain-HTTP access path: the port
is not exposed to the network, and the app rejects any request that did not arrive as
HTTPS. Configuration is read from `.env`.

## First-time setup

After cloning, run the interactive installer — it creates `.env` (mode 600) with
everything the server needs:

```bash
bash scripts/install.sh
```

It walks through: the **admin account** (password stored as an scrypt hash), a
random **`SESSION_ENCRYPTION_KEY`**, the **encryption-at-rest vault** (gocryptfs
set up automatically), and optional
**StudIP / IServ** provider settings. The admin password doubles as the vault
passphrase — the installer keeps the two in sync. Re-running it backs up the existing
`.env` before overwriting (or aborts, your choice).

The inverse operation lives in the settings panel: **Hard Reset** wipes `.env` and all
user data (synced folders, uploads, logs, notes, credentials, sessions), shuts the
server down, and returns the installation to this pre-install state. The encrypted
vault *container* itself is left in place (empty); remove or re-initialise it manually
if desired.

## Autostart on boot

A systemd unit is provided so the server comes up automatically whenever the Pi is
powered on:

```bash
sudo cp deploy/sinka.service /etc/systemd/system/sinka.service
sudo systemctl daemon-reload
sudo systemctl enable --now sinka
systemctl status sinka      # active (running)
journalctl -u sinka -f      # live logs
```

All configuration (`NODE_ENV`, `SESSION_ENCRYPTION_KEY`, `ADMIN_*`, provider URLs, …)
lives in `.env` — the single source of truth. The unit does not duplicate it.
(The session-cookie signing secret is *not* configured: it is generated fresh on every
server start, so each restart requires a new admin login.)

## Encryption at rest

Pupil data — uploads, submission logs, and **sync folders** — is stored
inside a **filesystem-encrypted vault** (gocryptfs) that is
**unlocked by the admin login**. While unlocked the sync engine and your file manager
see ordinary plaintext folders and behave normally; on disk it is ciphertext; when the
device is off or logged out it is locked.

The app itself does no crypto — it just needs to know where the vault is mounted and how
to unlock it:

| `.env` var | Purpose |
|---|---|
| `SINKA_VAULT_MOUNT` | plaintext mount path; data lives under it; "unlocked" = mounted |
| `SINKA_UNLOCK_CMD` | command run at login (password piped on stdin) to unlock |
| `SINKA_LOCK_CMD` | *(optional)* command run at logout to re-lock |

Behaviour: after boot the vault is **locked** — the app serves the login page but
uploads are refused (`503`) and data routes send the admin to `/login`; logging in runs
`SINKA_UNLOCK_CMD` and "opens" the service. Upload targets and sync folders are required
to be **inside** the vault, so nothing personal is written unencrypted.

**Idle auto-logout:** closing the browser tab never fires `/logout`, so the vault would
otherwise stay unlocked. After `AUTO_LOGOUT_MINUTES` of no admin activity (default
**30**, `0` disables, configurable in Settings) the server locks the vault and destroys
all login sessions. It is deferred while an upload session is still open or a sync run is 
in flight (locking mid-run is unsafe).

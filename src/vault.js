// Transparent at-rest vault gate.
//
// The app performs no crypto itself. All personal data lives under a filesystem-encrypted
// mount, which is unlocked
// at admin login. This module only:
//   - reports whether the vault is unlocked (i.e. the mount is present), and
//   - runs the configured unlock/lock commands (password piped on stdin).
//
// Config (env):
//   SINKA_VAULT_MOUNT  plaintext mount path; data lives under it; "unlocked" = mounted.
//   SINKA_UNLOCK_CMD   command run at login to unlock (password on stdin). Optional.
//   SINKA_LOCK_CMD     command run at logout to lock. Optional.
//
// If SINKA_VAULT_MOUNT is unset the vault is considered disabled (always "unlocked") —
// intended only for local development, never for handling real personal data.

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const MOUNT = process.env.SINKA_VAULT_MOUNT ? path.resolve(process.env.SINKA_VAULT_MOUNT) : "";
const UNLOCK_CMD = process.env.SINKA_UNLOCK_CMD || "";
const LOCK_CMD = process.env.SINKA_LOCK_CMD || "";

// Project root — fallback base when no vault is configured (dev; data is NOT encrypted).
const PROJECT_ROOT = path.join(__dirname, "..");

function isConfigured() {
  return MOUNT !== "";
}

// Base directory the app's at-rest data hangs off (data/, private/sinka_sessions, …):
// the vault mount when configured, else the project root. Use this instead of reading
// SINKA_VAULT_MOUNT directly so paths never become `undefined` when the vault is unset.
function dataRoot() {
  return isConfigured() ? MOUNT : PROJECT_ROOT;
}

// True if MOUNT is an active mountpoint.
function isMounted() {
  const r = spawnSync("mountpoint", ["-q", MOUNT]);
  if (r.status === 0) return true;
  if (r.status === 1) return false;
  // mountpoint(1) unavailable — fall back to comparing device ids with the parent.
  try {
    return fs.statSync(MOUNT).dev !== fs.statSync(path.dirname(MOUNT)).dev;
  } catch {
    return false;
  }
}

function isUnlocked() {
  return !isConfigured() || isMounted();
}

// Run the unlock command with the password on stdin. Returns true if the vault ends up
// mounted. A no-op (returns current state) when no command is configured.
function unlock(password) {
  if (!isConfigured() || !UNLOCK_CMD) return isUnlocked();
  if (isMounted()) return true;
  const r = spawnSync(UNLOCK_CMD, { shell: true, input: `${password}\n`, timeout: 30000 });
  if (r.error) {
    console.error("Vault unlock command failed:", r.error.message);
    return false;
  }
  if (r.status !== 0) {
    console.error("Vault unlock command exited", r.status, r.stderr ? r.stderr.toString() : "");
  }
  return isMounted();
}

function lock() {
  if (!isConfigured() || !LOCK_CMD) return;
  const r = spawnSync(LOCK_CMD, { shell: true, timeout: 30000 });
  if (r.error) {
    console.error("Vault lock command failed:", r.error.message);
  } else if (r.status !== 0) {
    console.error("Vault lock command exited", r.status, r.stderr ? r.stderr.toString().trim() : "");
  }
}

// Whether a path resolves inside the vault mount (used to keep sync targets encrypted).
// Always true when the vault is disabled.
function pathInVault(p) {
  if (!isConfigured()) return true;
  const resolved = path.resolve(String(p || ""));
  return resolved === MOUNT || resolved.startsWith(MOUNT + path.sep);
}

module.exports = { isConfigured, isUnlocked, unlock, lock, pathInVault, dataRoot, MOUNT };

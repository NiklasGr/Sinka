// Admin activity clock for the auto-logout. Every request that passes the admin gate
// marks activity (see index.js); the scheduler compares the idle time against
// AUTO_LOGOUT_MINUTES and locks the vault when the admin has been away too long —
// e.g. after simply closing the browser tab, which never fires /logout.
//
// Initialised to "now" at startup so a restart with the vault still mounted (systemd
// restart) also counts down to a lock instead of staying open forever.

let lastActivityMs = Date.now();

function markActivity() {
  lastActivityMs = Date.now();
}

function idleMs() {
  return Date.now() - lastActivityMs;
}

module.exports = { markActivity, idleMs };

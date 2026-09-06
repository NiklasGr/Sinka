// Background scheduler: automatic sync runs, the retention job, and the idle
// auto-logout. Started once from index.js; reads its configuration from process.env
// on every tick, so changes made in the settings UI (which updates process.env
// immediately) apply without a restart.
//
//   SYNC_INTERVAL_MINUTES  run a full sync of all registered courses every N minutes
//   RETENTION_DAYS         delete upload data older than N days (checked twice a day)
//   AUTO_LOGOUT_MINUTES    lock the vault after N idle minutes (blank = 30, 0 = never)
//
// Nothing runs while the vault is locked (before login / after logout): the data the
// jobs operate on isn't mounted then, and providers couldn't read credentials anyway.
// runAllCourses() self-guards against overlapping runs, so a manual "Sync All" and a
// scheduled run can never race.

const fs = require("fs");
const path = require("path");
const vault = require("./vault");
const { runAllCourses, isRunning } = require("./sync/run-all");
const { runRetention } = require("./upload/data-lifecycle");
const { idleMs } = require("./auth/activity");
const sessions = require("./upload/sessions");

const TICK_MS = 60 * 1000;
const RETENTION_EVERY_MS = 12 * 60 * 60 * 1000;
const DEFAULT_AUTO_LOGOUT_MINUTES = 30;

// The Express login-session store (see index.js). Emptied on auto-logout so stale
// admin cookies die server-side, exactly as if /logout had been called.
const EXPRESS_SESSIONS_DIR = path.join(__dirname, "..", "private", "express_sessions");

let lastSyncAt = 0;      // epoch ms of the last scheduled sync start
let lastRetentionAt = 0; // epoch ms of the last retention run

function intSetting(name) {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

// Auto-logout threshold in minutes: on by default, explicit 0 disables.
function autoLogoutMinutes() {
  const raw = String(process.env.AUTO_LOGOUT_MINUTES ?? "").trim();
  if (raw === "") return DEFAULT_AUTO_LOGOUT_MINUTES;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? n : null; // 0 or invalid -> disabled
}

// Lock the vault and destroy every login session — the "admin walked away" logout.
async function autoLogout(idleMinutes) {
  console.warn(`[scheduler] auto-logout: no admin activity for ${idleMinutes} min — locking the vault`);
  try {
    const entries = await fs.promises.readdir(EXPRESS_SESSIONS_DIR).catch(() => []);
    for (const name of entries) {
      await fs.promises.rm(path.join(EXPRESS_SESSIONS_DIR, name), { force: true });
    }
  } catch (err) {
    console.error("[scheduler] could not clear login sessions:", err.message);
  }
  vault.lock();
}

async function tick() {
  if (!vault.isUnlocked()) return;

  // --- idle auto-logout --------------------------------------------------------
  // A closed browser tab never fires /logout, so the vault would stay unlocked
  // indefinitely. Lock it once the admin has been idle past the threshold — but never
  // while an upload session is still open (students may be submitting; uploads need
  // the unlocked vault) and never mid-sync (locking under the engine corrupts a run).
  const logoutMinutes = autoLogoutMinutes();
  if (
    logoutMinutes &&
    vault.isConfigured() && // dev mode has no vault to lock — nothing to protect
    idleMs() >= logoutMinutes * 60 * 1000 &&
    !isRunning() &&
    !sessions.readSessions().some((s) => sessions.isOpen(s))
  ) {
    await autoLogout(logoutMinutes);
    return; // vault is now locked; sync/retention below would only fail
  }

  const syncMinutes = intSetting("SYNC_INTERVAL_MINUTES");
  if (syncMinutes && Date.now() - lastSyncAt >= syncMinutes * 60 * 1000) {
    lastSyncAt = Date.now();
    try {
      const { alreadyRunning, results } = await runAllCourses();
      if (!alreadyRunning) {
        const failed = results.filter((r) => r.status === "error");
        console.log(`[scheduler] auto-sync: ${results.length} course(s), ${failed.length} failed`);
      }
    } catch (err) {
      console.error("[scheduler] auto-sync failed:", err);
    }
  }

  const retentionDays = intSetting("RETENTION_DAYS");
  if (retentionDays && Date.now() - lastRetentionAt >= RETENTION_EVERY_MS) {
    lastRetentionAt = Date.now();
    try {
      const r = await runRetention(retentionDays);
      if (r.filesDeleted || r.logEntriesRemoved || r.sessionsRemoved) {
        console.log(
          `[scheduler] retention (${retentionDays}d): deleted ${r.filesDeleted} file(s), ` +
          `${r.logEntriesRemoved} log entr(ies), ${r.notesRemoved} note record(s), ` +
          `${r.sessionsRemoved} stale session(s)`
        );
      }
    } catch (err) {
      console.error("[scheduler] retention failed:", err);
    }
  }
}

function start() {
  const timer = setInterval(() => { tick(); }, TICK_MS);
  timer.unref(); // never keep the process alive just for the scheduler
}

// tick is exported for tests only; the app drives it solely through start().
module.exports = { start, tick };

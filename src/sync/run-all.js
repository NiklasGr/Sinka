// Sync every registered course — the one implementation behind both the manual
// "Sync All" API and the scheduler's automatic runs.
//
// Fault-tolerant: providers the user isn't logged into are skipped, and one course
// failing doesn't stop the others. Each course's outcome (time, status, operation
// counts or error) is recorded on its registry entry for the UI to display.
//
// A module-level flag makes runs mutually exclusive: if a manual sync is clicked
// while the scheduler is mid-run (or vice versa), the second caller gets
// { alreadyRunning: true } instead of two engines racing over the same folders.

const { getProvider } = require("../providers");
const { runSync } = require("./engine");
const { readRegistry, recordSyncResult } = require("./registry");

let running = false;
// Live progress of the current run, for the UI's progress bar. `done` counts courses
// whose sync has finished (ok, skipped or failed); `current` names the one in flight.
let progress = { total: 0, done: 0, current: null };

function isRunning() {
  return running;
}

function getProgress() {
  return { running, total: progress.total, done: progress.done, current: progress.current };
}

function nowSec() {
  return Math.trunc(Date.now() / 1000);
}

// Compact per-course counts for the registry/UI (full lists would bloat the file).
function summarize(summary) {
  return {
    downloaded: summary.downloaded.length,
    uploaded: summary.uploaded.length,
    conflicts: summary.conflicts.length,
    deletedLocal: summary.deletedLocal.length,
    deletedRemote: summary.deletedRemote.length,
    skipped: summary.skipped.length + summary.foldersSkipped.length,
    unchanged: summary.unchanged,
  };
}

async function runAllCourses() {
  if (running) return { alreadyRunning: true, results: [] };
  running = true;
  const entries = readRegistry();
  progress = { total: entries.length, done: 0, current: null };
  try {
    const results = [];
    for (const entry of entries) {
      progress.current = entry.courseName;
      const ref = { provider: entry.provider, courseId: entry.courseId, courseName: entry.courseName };
      const provider = getProvider(entry.provider);
      if (!provider) {
        results.push({ ...ref, status: "error", error: "unbekannter Anbieter" });
        recordSyncResult(entry.provider, entry.courseId, { at: nowSec(), status: "error", error: "unbekannter Anbieter" });
        progress.done++;
        continue;
      }
      const ctx = provider.getContext();
      if (!ctx) {
        results.push({ ...ref, status: "skipped", reason: "nicht angemeldet" });
        recordSyncResult(entry.provider, entry.courseId, { at: nowSec(), status: "skipped", error: "nicht angemeldet" });
        progress.done++;
        continue;
      }
      try {
        const summary = await runSync({ provider, ctx, courseId: entry.courseId, courseDir: entry.localPath });
        results.push({ ...ref, status: "ok", summary });
        recordSyncResult(entry.provider, entry.courseId, { at: nowSec(), status: "ok", counts: summarize(summary) });
      } catch (error) {
        console.error(`Sync failed for ${entry.provider}/${entry.courseId}:`, error);
        results.push({ ...ref, status: "error", error: error.message });
        recordSyncResult(entry.provider, entry.courseId, { at: nowSec(), status: "error", error: error.message });
      }
      progress.done++;
    }
    return { alreadyRunning: false, results };
  } finally {
    running = false;
    progress.current = null;
  }
}

module.exports = { runAllCourses, isRunning, getProgress };

// Registry of the courses currently being synced, keyed by (provider, courseId).
// Persisted to data/synced_courses.json. This is distinct from the per-course
// manifest.json the sync engine keeps inside each course's localPath.

const path = require("path");
const vault = require("../vault");
const { readJsonArray, writeJsonAtomic } = require("../util/json-file");

// <vault>/data/synced_courses.json (or <projectRoot>/data/... when no vault is set).
const REGISTRY_PATH = path.join(vault.dataRoot(), "data", "synced_courses.json");

function readRegistry() {
  return readJsonArray(REGISTRY_PATH);
}

function writeRegistry(entries) {
  writeJsonAtomic(REGISTRY_PATH, entries);
}

// Add or update a synced-course entry. Re-adding the same (provider, courseId)
// updates it in place and preserves the original createdSyncAt timestamp.
function upsertEntry({ provider, courseId, courseName, localPath }) {
  const entries = readRegistry();
  const idx = entries.findIndex((e) => e.provider === provider && String(e.courseId) === String(courseId));
  const entry = {
    provider,
    courseId,
    courseName,
    localPath,
    createdSyncAt: idx === -1 ? Math.trunc(Date.now() / 1000) : entries[idx].createdSyncAt,
  };
  if (idx === -1) entries.push(entry);
  else entries[idx] = entry;
  writeRegistry(entries);
  return entry;
}

function removeEntry(provider, courseId) {
  writeRegistry(readRegistry().filter((e) => !(e.provider === provider && String(e.courseId) === String(courseId))));
}

// Record the outcome of a sync run on the course's entry, so the UI can show
// "last synced …" and surface failures without re-running anything.
//   lastSync = { at, status: "ok"|"skipped"|"error", error?, counts? }
function recordSyncResult(provider, courseId, lastSync) {
  const entries = readRegistry();
  const entry = entries.find((e) => e.provider === provider && String(e.courseId) === String(courseId));
  if (!entry) return; // course was removed mid-run
  entry.lastSync = lastSync;
  writeRegistry(entries);
}

module.exports = { readRegistry, upsertEntry, removeEntry, recordSyncResult };

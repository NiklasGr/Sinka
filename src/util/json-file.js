// Small-file JSON persistence used by the registries/stores (sync registry, upload
// sessions, submission logs, review notes, security logs, UI prefs). One canonical
// implementation of "read the file, tolerate it not existing yet, ignore a wrong
// top-level shape" so every store behaves identically on first run and after manual
// tampering — and one canonical implementation of writing it back safely.
//
// Sync on purpose: these files are tiny and every caller wants the value immediately.

const fs = require("fs");
const path = require("path");

function readParsed(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return undefined; // not created yet — caller's fallback applies
    throw err; // real I/O or corruption errors must surface, not silently reset the store
  }
}

// The file's contents as an array, or [] when missing / not an array.
function readJsonArray(filePath) {
  const parsed = readParsed(filePath);
  return Array.isArray(parsed) ? parsed : [];
}

// The file's contents as a plain object, or {} when missing / not an object.
function readJsonObject(filePath) {
  const parsed = readParsed(filePath);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
}

// Write JSON so a crash can never leave a half-written file behind.
//
// writeFileSync truncates the target first and then streams the bytes in, so losing
// power in between leaves a truncated, unparseable store — and on a Raspberry Pi running
// off an SD card with no UPS that is a realistic event, not a thought experiment. Writing
// to a sibling temp file and renaming means a reader always sees either the complete old
// content or the complete new one: rename(2) is atomic within a filesystem.
//
// Deliberately no fsync: without it, a power loss just after the rename can still lose
// the newest write, but it can no longer corrupt the store. Losing the last entry is
// recoverable; an unparseable sessions file is not. fsync on every write would cost tens
// of milliseconds per call on SD storage — too much for the access log, which writes on
// every file view, and not worth it for the failure it prevents.
function writeJsonAtomic(filePath, value, { mode } = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  // Apply the mode explicitly rather than relying on the write's creation mode: a stale
  // temp file left by an earlier crash keeps its own, possibly wider, permissions.
  if (mode !== undefined) fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, filePath);
}

module.exports = { readJsonArray, readJsonObject, writeJsonAtomic };

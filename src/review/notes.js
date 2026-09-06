// Persistent review data for the File Viewer: per-file notes and a review status.
//
// Stored as a single JSON object in data/review_notes.json, keyed by the file's
// vault-relative path (the stable identifier the viewer uses). Because it lives under
// the vault mount, it is ciphertext at rest like every other pupil-data file. There is
// no author field: the app has a single operator (see docs/file-viewer.md).
//
//   { "<vault-relative path>": { status, notes: [ { id, body, createdAt, updatedAt } ] } }
//
// There is deliberately NO grade field. Marks are Leistungsdaten under § 31a NSchG and
// belong in the school's central administration database, not in a second system beside
// it; see finding 09 of the data-protection audit.
//
// Path-keyed notes for a *synced* file may be orphaned if the remote renames/deletes it
// — accepted by design; the notes are retained, not pruned.
//
// All writes go through withLock so concurrent saves can't lose data to a
// read-modify-write race, and each write is an atomic tmp-rename.

const path = require("path");
const crypto = require("crypto");
const vault = require("../vault");
const { readJsonObject, writeJsonAtomic } = require("../util/json-file");

const DATA_DIR = path.join(vault.dataRoot(), "data");
const NOTES_PATH = path.join(DATA_DIR, "review_notes.json");

// The review-status enum. "unreviewed" is the implicit default for any file with no
// entry yet, so it is never stored explicitly.
const STATUSES = ["unreviewed", "reviewed", "needs-revision", "approved"];
const DEFAULT_STATUS = "unreviewed";

// Human-readable German label for a status value. Lives here next to STATUSES so the
// enum and its wording cannot drift apart between the viewer and the GDPR exports.
function statusLabel(status) {
  return {
    unreviewed: "Ungeprüft",
    reviewed: "Gesehen",
    "needs-revision": "Überarbeitung nötig",
    approved: "Akzeptiert",
  }[status] || status;
}

function nowSec() {
  return Math.trunc(Date.now() / 1000);
}

// --- persistence -------------------------------------------------------------

function readAll() {
  return readJsonObject(NOTES_PATH);
}

function writeAll(obj) {
  writeJsonAtomic(NOTES_PATH, obj);
}

// Serialise every mutation on the single notes file behind one promise chain.
let chain = Promise.resolve();
function withLock(task) {
  const run = chain.then(task, task);
  chain = run.catch(() => {});
  return run;
}

// A normalised entry ({ status, notes }) for a key, whether or not it exists yet.
function entryOf(all, key) {
  const e = all[key];
  if (e && typeof e === "object") {
    return {
      status: STATUSES.includes(e.status) ? e.status : DEFAULT_STATUS,
      notes: Array.isArray(e.notes) ? e.notes : [],
    };
  }
  return { status: DEFAULT_STATUS, notes: [] };
}

// Drop entries that carry no information (default status, no notes) so the
// file stays clean and unreviewed files never accumulate empty records.
function pruneEntry(all, key) {
  const e = all[key];
  if (!e) return;
  const statusDefault = e.status === DEFAULT_STATUS || !STATUSES.includes(e.status);
  if (statusDefault && (!e.notes || e.notes.length === 0)) {
    delete all[key];
  }
}

// --- reads -------------------------------------------------------------------

// The full { status, notes } for one file.
function getEntry(key) {
  return entryOf(readAll(), key);
}

// Map of key -> { status, noteCount } for a set of keys, read in one pass (used by the
// folder listing and the progress bar). Keys with no stored entry come back as the
// defaults.
function summariesFor(keys) {
  const all = readAll();
  const out = {};
  for (const k of keys) {
    const e = entryOf(all, k);
    out[k] = { status: e.status, noteCount: e.notes.length };
  }
  return out;
}

// --- mutations ---------------------------------------------------------------

function addNote(key, body) {
  return withLock(() => {
    const all = readAll();
    const entry = entryOf(all, key);
    const note = {
      id: crypto.randomBytes(6).toString("hex"),
      body: String(body),
      createdAt: nowSec(),
      updatedAt: nowSec(),
    };
    entry.notes.push(note);
    all[key] = entry;
    writeAll(all);
    return note;
  });
}

function updateNote(key, id, body) {
  return withLock(() => {
    const all = readAll();
    const entry = all[key];
    const note = entry && Array.isArray(entry.notes) ? entry.notes.find((n) => n.id === id) : null;
    if (!note) return null;
    note.body = String(body);
    note.updatedAt = nowSec();
    writeAll(all);
    return note;
  });
}

function deleteNote(key, id) {
  return withLock(() => {
    const all = readAll();
    const entry = all[key];
    if (!entry || !Array.isArray(entry.notes)) return false;
    const before = entry.notes.length;
    entry.notes = entry.notes.filter((n) => n.id !== id);
    if (entry.notes.length === before) return false;
    pruneEntry(all, key); // removing the last note may leave an empty default entry
    writeAll(all);
    return true;
  });
}

function setStatus(key, status) {
  if (!STATUSES.includes(status)) return Promise.reject(new Error("Invalid status"));
  return withLock(() => {
    const all = readAll();
    const entry = entryOf(all, key);
    entry.status = status;
    all[key] = entry;
    pruneEntry(all, key); // status back to default with nothing else -> drop the entry
    writeAll(all);
    return entry.status;
  });
}

// Remove every entry for the given keys (used by the GDPR erasure tool and the
// retention job when the underlying files are deleted). Returns how many existed.
function removeEntries(keys) {
  return withLock(() => {
    const all = readAll();
    let removed = 0;
    for (const k of keys) {
      if (all[k]) { delete all[k]; removed++; }
    }
    if (removed) writeAll(all);
    return removed;
  });
}

module.exports = {
  STATUSES,
  statusLabel,
  getEntry,
  summariesFor,
  addNote,
  updateNote,
  deleteNote,
  setStatus,
  removeEntries,
};

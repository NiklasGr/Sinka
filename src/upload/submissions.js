// Authoritative, append-only record of every file accepted by an upload session.
// Kept centrally in data/upload_submissions/<id>.json — deliberately NOT inside the
// session's target directory, which may be a synced course folder that would push
// the log to the remote on the next sync.
//
// Writes are serialised per session via withSessionLock so concurrent uploads
// can't lose entries to a read-modify-write race, and so filename collision checks
// (see naming.js) stay consistent within a session.

const fs = require("fs");
const path = require("path");
const { SUBMISSIONS_DIR } = require("./sessions");
const { readJsonArray, writeJsonAtomic } = require("../util/json-file");

// One promise chain per session id. Each queued task runs after the previous one
// settles; errors are swallowed on the stored chain so one failure doesn't poison
// the queue, while the caller still sees its own task's outcome.
const chains = new Map();

function withSessionLock(id, task) {
  const prev = chains.get(id) || Promise.resolve();
  const result = prev.then(task, task);
  chains.set(id, result.catch(() => {}));
  return result;
}

// The log holds uploader names. It lives under the encrypted vault mount (see
// docs/encryption-at-rest.md), so plain JSON on that mount is ciphertext at rest.
// Records deliberately carry no IP address — see the note at the appendSubmission
// call site in routes/public-upload.js.
function logPath(id) {
  return path.join(SUBMISSIONS_DIR, `${id}.json`);
}

function readLog(id) {
  return readJsonArray(logPath(id));
}

// Replace a session's whole log. Call inside withSessionLock(id, ...). An empty list
// deletes the file outright, so an erased/expired log leaves no residue on disk.
function writeLog(id, entries) {
  if (!entries.length) {
    try {
      fs.unlinkSync(logPath(id));
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
    return;
  }
  writeJsonAtomic(logPath(id), entries);
}

// Append one record. Call inside withSessionLock(id, ...).
function appendSubmission(id, record) {
  const entries = readLog(id);
  entries.push(record);
  writeLog(id, entries);
  return record;
}

module.exports = { withSessionLock, appendSubmission, readLog, writeLog };

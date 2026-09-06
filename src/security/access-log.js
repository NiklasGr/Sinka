// Access log for Art. 5(2) DSGVO — the accountability half of finding 07.
//
// The operator has decided the server keeps ONE account used by ONE person, so this log
// does not answer "who" — that is constant and known. What it answers is "what moved, and
// when": which pupil file was opened, which folder was zipped, which disclosure was
// exported, and which files the operator placed into a folder. That is the part nobody
// could reconstruct before, and it is what a breach assessment under Art. 33 actually
// needs — the question after an incident is never "who was logged in" but "which data was
// reachable in that window".
//
// The log names pupil files and is therefore pupil data itself. Two consequences:
// it lives in the vault, and it gets its OWN, shorter retention than the data it
// describes — otherwise the accountability record quietly becomes the longest-lived
// collection in the system. Pruning happens on write, so it needs no scheduler slot.

const path = require("path");
const vault = require("../vault");
const { readJsonArray, writeJsonAtomic } = require("../util/json-file");

const ACCESS_LOG_PATH = path.join(vault.dataRoot(), "data", "access_log.json");

// Shorter than RETENTION_DAYS (120 by default): the record of a look at a file must not
// outlive the file. Also capped, so a scripted download loop cannot grow it without end.
const RETENTION_DAYS = 90;
const MAX_ENTRIES = 5000;

// One *access* is not one HTTP request. The file route honours Range requests so pdf.js
// and large images can stream, which means a single viewing produces a full request plus
// several partial ones — five log lines for one look at one file. Cache-Control: no-store
// adds re-fetches on top. Repeats of the same access within this window are therefore
// folded into the first entry, which is the one that answers "when was this file
// reached". Two minutes is long enough to swallow one viewing (its requests arrive within
// seconds) and short enough that opening the same file again later still registers.
const DEDUPE_WINDOW_MS = 2 * 60 * 1000;

// action -> German label. Also the allow-list; an unknown action is a coding error.
const ACTIONS = {
  "file-view": "Datei geöffnet",
  "file-upload": "Datei(en) in einen Ordner hochgeladen",
  "course-zip": "Kursordner als Zip heruntergeladen",
  "uploads-zip": "Abgaben einer Sitzung als Zip heruntergeladen",
  "disclosure-export": "Auskunft nach Art. 15 exportiert",
};

function prune(entries) {
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const fresh = entries.filter((e) => {
    const t = Date.parse(e && e.at);
    return Number.isFinite(t) && t >= cutoff;
  });
  return fresh.length > MAX_ENTRIES ? fresh.slice(fresh.length - MAX_ENTRIES) : fresh;
}

// Has this exact access already been recorded moments ago? Scans backwards for the
// newest matching entry rather than only checking the last one, so an interleaved access
// to a different file does not defeat the check. `detail` is part of the comparison:
// viewing a file and downloading it are two different accesses.
function isRepeat(entries, entry, now = Date.now()) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (!e || e.action !== entry.action || e.target !== entry.target || (e.detail ?? null) !== entry.detail) continue;
    const t = Date.parse(e.at);
    return Number.isFinite(t) && now - t < DEDUPE_WINDOW_MS;
  }
  return false;
}

// Record one access. `target` is the vault-relative path or the folder/session name —
// the thing that was reached, not the person who reached it.
//
// Never throws: a failed write must not break the download the operator asked for. A
// missing log line is a gap in the record; a failed export is a broken tool.
function record(action, target, detail = null) {
  if (!Object.hasOwn(ACTIONS, action)) return;
  try {
    const entries = prune(readJsonArray(ACCESS_LOG_PATH));
    const entry = {
      at: new Date().toISOString(),
      action,
      target: String(target ?? "").slice(0, 400),
      detail: detail ? String(detail).slice(0, 200) : null,
    };
    if (isRepeat(entries, entry)) return; // same access still in flight — already recorded
    entries.push(entry);
    writeJsonAtomic(ACCESS_LOG_PATH, entries);
  } catch (err) {
    console.error("Access log write failed:", err.message);
  }
}

// Newest first, labelled for display.
function list(limit = 100) {
  return readJsonArray(ACCESS_LOG_PATH)
    .slice(-Math.max(1, limit))
    .reverse()
    .map((e) => ({ ...e, label: ACTIONS[e.action] || e.action }));
}

function count() {
  return readJsonArray(ACCESS_LOG_PATH).length;
}

module.exports = { RETENTION_DAYS, record, list, count };

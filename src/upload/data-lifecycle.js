// GDPR data lifecycle for collected uploads: the disclosure tool (Art. 15/20 — tell one
// student everything held about them), the erasure tool (Art. 17 — delete it on request)
// and the retention job (Art. 5(1)(e) — auto-delete upload data older than the
// configured age).
//
// All three work off the same records: for each upload session, the submission log names
// the stored files. Disclosure reads them; erasure and retention delete the file, its
// review notes and the log entry. Files may live inside synced course folders —
// deleting them locally propagates the deletion to StudIP/IServ on the next sync,
// which is the configured policy (full erasure; see docs/file-viewer.md + README).
//
// Erasures are recorded in data/erasure_log.json (date, query, counts) — a minimal
// accountability trail (Art. 5(2)) that itself lives inside the encrypted vault.

const fs = require("fs");
const path = require("path");
const vault = require("../vault");
const sessions = require("./sessions");
const { withSessionLock, readLog, writeLog } = require("./submissions");
const notes = require("../review/notes");
const { readJsonArray, writeJsonAtomic } = require("../util/json-file");
const { noticeFor } = require("../config/privacy");

const ERASURE_LOG_PATH = path.join(vault.dataRoot(), "data", "erasure_log.json");

function destDirOf(session) {
  return path.join(session.targetDir, ...String(session.subfolder || "").split("/").filter(Boolean));
}

// The review-notes key for an absolute path (same derivation as the review routes).
function noteKeyOf(abs) {
  return path.relative(path.resolve(vault.dataRoot()), abs).split(path.sep).join("/");
}

function normalizeName(s) {
  return String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
}

// Does a submission record belong to the queried person? Exact full name, in either
// order, so "max müller" and "müller max" both work.
//
// This used to accept substrings, which meant "Anna" also matched "Marianna Berg" and
// "Max Müller" also matched "Max Müller-Schmidt". Both callers act on the result in a
// way that cannot be taken back — an erasure deletes, and the deletion reaches Stud.IP
// or IServ on the next sync; a disclosure hands the data out. A near miss there is not
// a nuisance, it destroys or discloses a *different* person's records. Partial input is
// therefore answered with name suggestions (see nearMissesFor) rather than with data.
function matchesStudentExact(record, query) {
  const q = normalizeName(query);
  if (!q) return false;
  return (
    normalizeName(`${record.firstName} ${record.lastName}`) === q ||
    normalizeName(`${record.lastName} ${record.firstName}`) === q
  );
}

// Distinct stored names that contain the query without matching it exactly — the
// "did you mean" list. Only names travel back, never a record, so an incomplete query
// can never leak someone else's data.
function nearMissesFor(query) {
  const q = normalizeName(query);
  const out = new Set();
  if (!q) return [];
  for (const session of sessions.readSessions()) {
    for (const record of readLog(session.id)) {
      if (matchesStudentExact(record, query)) continue;
      const a = normalizeName(`${record.firstName} ${record.lastName}`);
      const b = normalizeName(`${record.lastName} ${record.firstName}`);
      if (a.includes(q) || b.includes(q)) out.add(`${record.firstName} ${record.lastName}`);
    }
  }
  return [...out].sort();
}

// --- shared core ---------------------------------------------------------------

// Walk every session's log; hand each record to `select`. When `execute` is set,
// delete the selected records' files + notes + log entries; otherwise just report.
async function sweep(select, { execute }) {
  const result = { matches: [], filesDeleted: 0, logEntriesRemoved: 0, notesRemoved: 0 };
  const noteKeys = [];

  for (const session of sessions.readSessions()) {
    const destDir = destDirOf(session);
    const log = readLog(session.id);
    const keep = [];
    let changed = false;

    for (const record of log) {
      if (!select(record)) {
        keep.push(record);
        continue;
      }
      const abs = path.join(destDir, record.storedName || "");
      const fileExists = !!record.storedName && fs.existsSync(abs);
      result.matches.push({
        sessionId: session.id,
        sessionName: session.name,
        at: record.at,
        firstName: record.firstName,
        lastName: record.lastName,
        storedName: record.storedName,
        fileExists,
      });
      changed = true;
      if (execute) {
        if (fileExists) {
          await fs.promises.rm(abs, { force: true });
          result.filesDeleted++;
        }
        noteKeys.push(noteKeyOf(abs));
        result.logEntriesRemoved++;
      } else {
        keep.push(record); // preview: leave the log untouched
      }
    }

    if (execute && changed) {
      await withSessionLock(session.id, () => writeLog(session.id, keep));
    }
  }

  if (execute && noteKeys.length) {
    result.notesRemoved = await notes.removeEntries(noteKeys);
  }
  return result;
}

// --- subject access (Art. 15 / Art. 20) --------------------------------------------

// Everything held about one person, assembled for an Art. 15 answer.
//
// Art. 15(1) covers "the personal data undergoing processing" — which includes what the
// school wrote *about* the pupil, so the review status and the full note texts are part
// of the answer, not just the uploaded files. Art. 15(1)(c)-(e) additionally
// require the recipients and the storage period; those come from the same source the
// upload page quotes to the pupil, so the two can never drift apart.
//
// Read-only: nothing here writes to disk.
function collectSubjectData(query) {
  const name = String(query || "").trim();
  const submissions = [];

  for (const session of sessions.readSessions()) {
    const destDir = destDirOf(session);
    const recipients = noticeFor(session).recipients;

    for (const record of readLog(session.id)) {
      if (!matchesStudentExact(record, name)) continue;
      const abs = record.storedName ? path.join(destDir, record.storedName) : null;
      const key = abs ? noteKeyOf(abs) : null;
      submissions.push({
        sessionName: session.name,
        at: record.at,
        firstName: record.firstName,
        lastName: record.lastName,
        originalName: record.originalName || null,
        storedName: record.storedName || null,
        size: typeof record.size === "number" ? record.size : null,
        receipt: record.receipt || null,
        location: key,
        fileExists: !!abs && fs.existsSync(abs),
        recipients,
        review: key ? notes.getEntry(key) : null,
      });
    }
  }

  const retentionRaw = String(process.env.RETENTION_DAYS || "").trim();
  const cfg = noticeFor(null);

  return {
    query: name,
    generatedAt: new Date().toISOString(),
    controller: cfg.controller,
    contact: cfg.contact,
    retentionDays: /^\d+$/.test(retentionRaw) ? Number(retentionRaw) : null,
    submissions,
    nearMisses: nearMissesFor(name),
    // What this answer does NOT cover, stated explicitly so an incomplete disclosure is
    // never mistaken for a complete one: files that reached a synced course folder from
    // Stud.IP/IServ rather than through an upload session are not indexed by name and
    // are not searched here (see finding 06 of the data-protection audit).
    coverage: {
      searched: ["Abgaben aus Upload-Sitzungen", "Prüfstatus und Notizen zu diesen Abgaben"],
      notSearched: ["Dateien, die über die Kurs-Synchronisation aus Stud.IP/IServ stammen"],
    },
  };
}

// --- erasure (Art. 17) -----------------------------------------------------------

function appendErasureRecord(record) {
  const entries = readJsonArray(ERASURE_LOG_PATH);
  entries.push(record);
  writeJsonAtomic(ERASURE_LOG_PATH, entries);
}

// Preview what an erasure for `query` would remove, without changing anything. Reports
// near-miss names alongside, so a partial query ("Müller") comes back as a list of full
// names to pick from instead of silently matching nobody.
async function previewErasure(query) {
  const result = await sweep((r) => matchesStudentExact(r, query), { execute: false });
  return { ...result, nearMisses: nearMissesFor(query) };
}

// Execute the erasure and record it in the accountability log.
async function executeErasure(query) {
  const result = await sweep((r) => matchesStudentExact(r, query), { execute: true });
  if (result.logEntriesRemoved || result.filesDeleted || result.notesRemoved) {
    appendErasureRecord({
      at: new Date().toISOString(),
      query: String(query),
      filesDeleted: result.filesDeleted,
      logEntriesRemoved: result.logEntriesRemoved,
      notesRemoved: result.notesRemoved,
    });
  }
  return result;
}

// --- retention (Art. 5(1)(e)) ------------------------------------------------------

// Delete all upload data older than `days`, then drop closed/expired sessions that are
// past the threshold and hold no remaining submissions.
async function runRetention(days) {
  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const isOld = (r) => {
    const t = Date.parse(r.at);
    return Number.isFinite(t) && t < cutoffMs;
  };
  const result = await sweep(isOld, { execute: true });

  let sessionsRemoved = 0;
  const cutoffSec = Math.trunc(cutoffMs / 1000);
  for (const session of sessions.readSessions()) {
    if (
      sessions.effectiveStatus(session) !== "open" &&
      session.createdAt < cutoffSec &&
      readLog(session.id).length === 0
    ) {
      sessions.removeSession(session.id);
      sessionsRemoved++;
    }
  }
  return { ...result, sessionsRemoved };
}

module.exports = { collectSubjectData, previewErasure, executeErasure, runRetention };

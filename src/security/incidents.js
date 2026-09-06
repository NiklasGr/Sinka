// Documentation half of Art. 33 DSGVO. Art. 33(5) requires the controller to document
// *every* personal-data breach — including the ones that need no notification — with the
// facts, the effects and the remedial action taken. Without a place to write that down,
// the duty is met by memory, which is to say not at all.
//
// Structured after Art. 33(3): nature of the breach, who and how many are affected, the
// likely consequences, and the measures taken. Each record also carries the moment the
// breach became *known*, because Art. 33(1) counts its 72 hours from there and not from
// when the breach happened — that deadline is computed and shown, so it cannot be missed
// by simply not noticing it.
//
// Lives in the vault next to the erasure log: an incident description names what went
// wrong with whose data and is itself sensitive.

const path = require("path");
const crypto = require("crypto");
const vault = require("../vault");
const { readJsonArray, writeJsonAtomic } = require("../util/json-file");

const INCIDENT_LOG_PATH = path.join(vault.dataRoot(), "data", "incident_log.json");

const NOTIFICATION_WINDOW_MS = 72 * 60 * 60 * 1000; // Art. 33 Abs. 1
const FIELD_MAX = 4000;

function text(value, max = FIELD_MAX) {
  return String(value ?? "").trim().slice(0, max);
}

function readIncidents() {
  return readJsonArray(INCIDENT_LOG_PATH);
}

function writeIncidents(entries) {
  writeJsonAtomic(INCIDENT_LOG_PATH, entries);
}

// Derived state the operator actually needs: how long is left of the 72 hours, and is
// the record still waiting for a decision.
function decorate(entry) {
  const noticed = Date.parse(entry.noticedAt);
  const deadline = Number.isFinite(noticed) ? noticed + NOTIFICATION_WINDOW_MS : null;
  const open = !entry.reportedToAuthority && !entry.noReportReason;
  return {
    ...entry,
    deadline: deadline ? new Date(deadline).toISOString() : null,
    hoursLeft: deadline ? Math.round((deadline - Date.now()) / 3600000) : null,
    overdue: !!(deadline && open && Date.now() > deadline),
    open,
  };
}

function listIncidents() {
  return readIncidents()
    .map(decorate)
    .sort((a, b) => String(b.noticedAt).localeCompare(String(a.noticedAt)));
}

// Art. 33(3) fields. `noticedAt` defaults to now — the common case is "I just found out".
function addIncident(input = {}) {
  const description = text(input.description);
  if (!description) throw new Error("Eine Beschreibung des Vorfalls ist erforderlich");

  const noticedRaw = text(input.noticedAt, 40);
  const noticed = noticedRaw && Number.isFinite(Date.parse(noticedRaw))
    ? new Date(noticedRaw).toISOString()
    : new Date().toISOString();

  const entry = {
    id: crypto.randomBytes(6).toString("hex"),
    recordedAt: new Date().toISOString(),
    noticedAt: noticed,
    description,                          // Art. 33(3)(a) — what happened
    affected: text(input.affected),       // Art. 33(3)(a) — categories and rough number
    consequences: text(input.consequences), // Art. 33(3)(c)
    measures: text(input.measures),       // Art. 33(3)(d)
    reportedToAuthority: false,
    reportedAt: null,
    noReportReason: "",                   // Art. 33(1) second half: why no report was needed
    subjectsInformed: false,              // Art. 34
  };

  const all = readIncidents();
  all.push(entry);
  writeIncidents(all);
  return decorate(entry);
}

// Resolve an incident: either it was reported, or it was assessed as not requiring a
// report — Art. 33(1) allows the latter, but only with a reason on file, so one of the
// two must be given.
function resolveIncident(id, { reported, reason, subjectsInformed } = {}) {
  const all = readIncidents();
  const entry = all.find((e) => e.id === id);
  if (!entry) return null;

  if (reported) {
    entry.reportedToAuthority = true;
    entry.reportedAt = new Date().toISOString();
    entry.noReportReason = "";
  } else {
    const why = text(reason);
    if (!why) throw new Error("Ohne Meldung ist eine Begründung erforderlich (Art. 33 Abs. 1)");
    entry.reportedToAuthority = false;
    entry.reportedAt = null;
    entry.noReportReason = why;
  }
  if (subjectsInformed !== undefined) entry.subjectsInformed = !!subjectsInformed;

  writeIncidents(all);
  return decorate(entry);
}

// Count of records still awaiting a decision, for the dashboard badge.
function openCount() {
  return listIncidents().filter((e) => e.open).length;
}

module.exports = {
  listIncidents,
  addIncident,
  resolveIncident,
  openCount,
};

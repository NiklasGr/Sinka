// Detection half of Art. 33 DSGVO: the 72-hour clock starts when a breach becomes
// *known*, so without any detection a notification deadline is unmeetable by accident
// rather than by decision. This records the security-relevant things the server already
// noticed and could only write to the journal before.
//
// DELIBERATELY IN MEMORY ONLY. The signals that matter most — failed admin logins,
// upload-code guessing — occur while the vault is LOCKED, so there is no encrypted place
// to write them at that moment, and a file outside the vault is precisely what finding 01
// was about. The buffer is therefore lost on restart, which the home page states plainly.
// Anything worth keeping is promoted by hand into the incident log (security/incidents.js),
// which does live in the vault.
//
// No unmasked personal data enters an event: callers pass an already-masked IP
// (util/redact.js). Events are counted and shown to the operator, never exported.

const MAX_EVENTS = 500;

// type -> German label for the dashboard. Also the allow-list: an unknown type is a
// programming error, not something to display.
const TYPES = {
  "login-failed": "Fehlgeschlagene Anmeldung",
  "login-rate-limited": "Anmeldung gesperrt (Ratenbegrenzung)",
  "upload-code-failed": "Falscher Abgabecode",
  "upload-code-locked": "Abgabe-Sitzung gesperrt (zu viele Fehlversuche)",
  "vault-unlock-failed": "Tresor konnte nicht entsperrt werden",
};

// Thresholds that turn a count into something worth looking at. Tuned to be quiet in
// normal school use: a teacher mistyping a password twice must not raise an alarm, or
// the alarm stops meaning anything.
const ALERT_RULES = [
  { type: "login-failed", within: 60 * 60 * 1000, count: 10,
    text: "Gehäufte Fehlanmeldungen — mögliches Durchprobieren von Passwörtern." },
  { type: "login-rate-limited", within: 60 * 60 * 1000, count: 1,
    text: "Die Anmeldung wurde wegen zu vieler Fehlversuche gesperrt." },
  { type: "upload-code-locked", within: 60 * 60 * 1000, count: 3,
    text: "Mehrere Abgabe-Sitzungen wurden wegen falscher Codes gesperrt." },
  { type: "vault-unlock-failed", within: 24 * 60 * 60 * 1000, count: 1,
    text: "Der Tresor ließ sich trotz korrektem Passwort nicht entsperren — Konfiguration prüfen." },
];

const events = [];
const startedAt = Date.now();

// Record one event. `detail` is a short, already-redacted string (masked IP, session
// name) or null — never a full address, never a pupil name.
function record(type, detail = null) {
  if (!Object.hasOwn(TYPES, type)) return;
  events.push({ at: Date.now(), type, detail: detail ? String(detail).slice(0, 120) : null });
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
}

function countSince(type, sinceMs) {
  let n = 0;
  for (const e of events) if (e.type === type && e.at >= sinceMs) n++;
  return n;
}

// Which thresholds are currently exceeded.
function activeAlerts(now = Date.now()) {
  return ALERT_RULES.filter((r) => countSince(r.type, now - r.within) >= r.count).map((r) => ({
    type: r.type,
    label: TYPES[r.type],
    text: r.text,
    count: countSince(r.type, now - r.within),
    windowHours: Math.round(r.within / 3600000),
  }));
}

// Dashboard view: per-type totals since start, plus the newest few for context.
function summary(now = Date.now()) {
  const byType = Object.keys(TYPES)
    .map((type) => ({
      type,
      label: TYPES[type],
      total: countSince(type, 0),
      lastHour: countSince(type, now - 3600000),
    }))
    .filter((row) => row.total > 0);

  return {
    since: new Date(startedAt).toISOString(),
    total: events.length,
    byType,
    alerts: activeAlerts(now),
    recent: events.slice(-10).reverse().map((e) => ({
      at: new Date(e.at).toISOString(),
      label: TYPES[e.type],
      detail: e.detail,
    })),
  };
}

// Tests only; the app never clears the buffer.
function _reset() {
  events.length = 0;
}

module.exports = { record, summary, _reset };

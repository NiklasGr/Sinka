// Home-dashboard API + the GDPR subject-access and erasure endpoints.
// Mounted behind requireAdmin.

const express = require("express");
const fs = require("fs");
const vault = require("../vault");
const { readRegistry } = require("../sync/registry");
const sessions = require("../upload/sessions");
const { readLog } = require("../upload/submissions");
const PDFDocument = require("pdfkit");
const { collectSubjectData, previewErasure, executeErasure } = require("../upload/data-lifecycle");
const { statusLabel } = require("../review/notes");
const securityEvents = require("../security/events");
const incidents = require("../security/incidents");
const accessLog = require("../security/access-log");

const router = express.Router();

// Everything the home dashboard shows, in one round trip.
router.get("/api/home/status", async (req, res) => {
  const courses = readRegistry().map((e) => ({
    provider: e.provider,
    courseName: e.courseName,
    lastSync: e.lastSync || null,
  }));

  const uploadSessions = sessions.readSessions().map((s) => ({
    name: s.name,
    status: sessions.effectiveStatus(s),
    submissionCount: readLog(s.id).length,
    expiresAt: s.expiresAt,
  }));

  // Free space where the data actually lives (the vault mount; SD cards fill up).
  let disk = null;
  try {
    const st = await fs.promises.statfs(vault.dataRoot());
    disk = { freeBytes: st.bavail * st.bsize, totalBytes: st.blocks * st.bsize };
  } catch {
    /* statfs unavailable — the card just won't show */
  }

  res.json({
    success: true,
    courses,
    sessions: uploadSessions,
    disk,
    autoSyncMinutes: Number(process.env.SYNC_INTERVAL_MINUTES) || null,
    retentionDays: Number(process.env.RETENTION_DAYS) || null,
    // Mirrors the scheduler's interpretation: blank = default 30, 0 = disabled.
    autoLogoutMinutes: String(process.env.AUTO_LOGOUT_MINUTES ?? "").trim() === ""
      ? 30
      : Number(process.env.AUTO_LOGOUT_MINUTES) || null,
    // Art. 33: what the server has noticed since it started, and how many documented
    // incidents still await a report-or-justify decision.
    security: { ...securityEvents.summary(), openIncidents: incidents.openCount() },
  });
});

// --- GDPR breach documentation (Art. 33 / 34) --------------------------------------
// Art. 33(5) requires every breach to be documented, including those that need no
// notification. The 72-hour clock of Art. 33(1) runs from the moment a breach became
// known, so each record carries that moment and the derived deadline.

// The access log: what pupil data was reached, and when. One account by design, so it
// records the "what", not the "who" (finding 07).
router.get("/api/access-log", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({
    success: true,
    entries: accessLog.list(100),
    total: accessLog.count(),
    retentionDays: accessLog.RETENTION_DAYS,
  });
});

router.get("/api/incidents", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ success: true, incidents: incidents.listIncidents() });
});

router.post("/api/incidents", (req, res) => {
  try {
    const entry = incidents.addIncident(req.body || {});
    res.json({ success: true, incident: entry });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Close a record: either it was reported to the supervisory authority, or it was
// assessed as not reportable — Art. 33(1) permits that, but the reason has to be on file.
router.post("/api/incidents/:id/resolve", (req, res) => {
  try {
    const entry = incidents.resolveIncident(req.params.id, req.body || {});
    if (!entry) return res.status(404).json({ error: "Vorfall nicht gefunden" });
    res.json({ success: true, incident: entry });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- GDPR subject access (Art. 15 / Art. 20) ---------------------------------------
// A disclosure has to be answerable within one month (Art. 12(3)), which is not
// realistic by hand across sessions, logs and notes. These endpoints assemble the whole
// answer: on screen for a quick look, as PDF for the file copy, as JSON for Art. 20.

const MIN_QUERY = 3;

function readName(req) {
  const raw = req.method === "GET" ? req.query.name : (req.body || {}).name;
  return String(raw || "").trim();
}

function fmtDe(value) {
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString("de-DE", { dateStyle: "medium", timeStyle: "short" });
}

// ASCII-only download name. The Content-Disposition quoted-string is not reliably
// decoded as UTF-8 across browsers — content-disposition emits a bare "ü" with no
// filename*=UTF-8'' fallback — and a mangled name on a document the school hands to a
// parent reads as a defect. Decompose accents away, map ß, drop everything else.
function downloadName(name) {
  const ascii = String(name)
    .replace(/ß/g, "ss")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // combining marks left behind by NFD
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return ascii || "auskunft";
}

function fmtBytes(n) {
  if (typeof n !== "number") return "–";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// The dossier as a PDF, structured the way Art. 15(1) lists its items so an
// authority reading it can check them off.
function disclosurePdf(d) {
  const doc = new PDFDocument({ margin: 56, info: { Title: `Datenauskunft — ${d.query}` } });
  const h = (t) => doc.moveDown(0.8).fontSize(12).font("Helvetica-Bold").fillColor("#000").text(t).moveDown(0.2);
  const body = (t, opts) => doc.fontSize(10).font("Helvetica").fillColor("#000").text(t, opts);
  const muted = (t) => doc.fontSize(9).font("Helvetica").fillColor("#666").text(t).fillColor("#000");

  doc.fontSize(17).font("Helvetica-Bold").text("Auskunft personenbezogener Daten");
  doc.moveDown(0.3);
  doc.fontSize(11).font("Helvetica").text(`Betroffene Person: ${d.query}`);
  muted(`Erstellt am ${fmtDe(d.generatedAt)}`);

  h("Verantwortliche Stelle");
  body(d.controller || "Nicht hinterlegt — bitte in den Einstellungen ergänzen.");
  h("Kontakt für Datenschutzfragen");
  body(d.contact || "Nicht hinterlegt — bitte in den Einstellungen ergänzen.");

  h("Zweck und Rechtsgrundlage");
  body("Einsammeln, Zuordnen und Bewerten von Abgaben.");

  h("Speicherdauer");
  body(d.retentionDays
    ? `Abgaben, Protokolleinträge und zugehörige Notizen werden automatisch gelöscht, sobald sie älter als ${d.retentionDays} Tage sind.`
    : "Es ist keine automatische Löschfrist eingestellt. Die Daten werden gelöscht, sobald sie für die Bewertung nicht mehr erforderlich sind.");

  h(`Gespeicherte Abgaben (${d.submissions.length})`);
  if (!d.submissions.length) {
    doc.fontSize(10).font("Helvetica-Oblique").text("Keine Abgaben gespeichert.");
  }
  for (const sub of d.submissions) {
    doc.moveDown(0.5);
    doc.fontSize(10).font("Helvetica-Bold").text(sub.originalName || sub.storedName || "(ohne Dateinamen)");
    doc.fontSize(9).font("Helvetica");
    body(`Sitzung: ${sub.sessionName}`);
    body(`Abgegeben: ${fmtDe(sub.at)}`);
    body(`Größe: ${fmtBytes(sub.size)}${sub.receipt ? ` · Abgabebeleg: ${sub.receipt}` : ""}`);
    if (sub.review) {
      body(`Prüfstatus: ${statusLabel(sub.review.status)}`);
      for (const n of sub.review.notes || []) {
        muted(`Anmerkung vom ${fmtDe(new Date(n.createdAt * 1000))}:`);
        body(n.body, { indent: 12 });
      }
    }
    body(`Empfänger: ${(sub.recipients || []).join("; ")}`);
  }

  h("Ihre Rechte");
  body("Berichtigung (Art. 16), Löschung (Art. 17), Einschränkung der Verarbeitung (Art. 18), "
     + "Widerspruch (Art. 21) sowie Beschwerde bei der Landesbeauftragten für den Datenschutz "
     + "Niedersachsen (Art. 77).");

  h("Umfang dieser Auskunft");
  for (const item of d.coverage.searched) body(`Durchsucht: ${item}`);
  for (const item of d.coverage.notSearched) body(`Nicht durchsucht: ${item}`);

  doc.end();
  return doc;
}

// Dossier as JSON, for display in the admin UI.
router.post("/api/disclosure", (req, res) => {
  const name = readName(req);
  if (name.length < MIN_QUERY) return res.status(400).json({ error: `Mindestens ${MIN_QUERY} Zeichen des Namens eingeben` });
  res.set("Cache-Control", "no-store");
  res.json({ success: true, dossier: collectSubjectData(name) });
});

// GET /api/disclosure/export?name=<full name>&format=pdf|json
// The handout copy. Served as an attachment and never cached — it is pupil data.
router.get("/api/disclosure/export", (req, res) => {
  const name = readName(req);
  if (name.length < MIN_QUERY) return res.status(400).json({ error: `Mindestens ${MIN_QUERY} Zeichen des Namens eingeben` });

  const dossier = collectSubjectData(name);
  const format = req.query.format === "json" ? "json" : "pdf";

  accessLog.record("disclosure-export", name, format);
  res.attachment(`Auskunft_${downloadName(name)}.${format}`);
  res.set("Cache-Control", "no-store");

  if (format === "json") {
    res.set("Content-Type", "application/json; charset=utf-8");
    return res.send(JSON.stringify(dossier, null, 2));
  }
  res.set("Content-Type", "application/pdf");
  const doc = disclosurePdf(dossier);
  doc.on("error", (err) => {
    console.error("Disclosure PDF error:", err);
    res.destroy(err);
  });
  doc.pipe(res);
});

// --- GDPR erasure (Art. 17) ------------------------------------------------------
// Two-step: preview shows exactly what a query matches; execute deletes it (files,
// log entries, review notes — full erasure incl. synced folders, per configured
// policy) and records the action in the erasure log.

router.post("/api/erasure/preview", async (req, res) => {
  const name = String((req.body || {}).name || "").trim();
  if (name.length < 3) return res.status(400).json({ error: "Mindestens 3 Zeichen des Namens eingeben" });
  const result = await previewErasure(name);
  res.json({ success: true, matches: result.matches, nearMisses: result.nearMisses });
});

router.post("/api/erasure/execute", async (req, res) => {
  const name = String((req.body || {}).name || "").trim();
  if (name.length < 3) return res.status(400).json({ error: "Mindestens 3 Zeichen des Namens eingeben" });
  try {
    const result = await executeErasure(name);
    res.json({
      success: true,
      filesDeleted: result.filesDeleted,
      logEntriesRemoved: result.logEntriesRemoved,
      notesRemoved: result.notesRemoved,
    });
  } catch (err) {
    console.error("Erasure failed:", err);
    res.status(500).json({ error: "Löschung fehlgeschlagen: " + err.message });
  }
});

module.exports = router;

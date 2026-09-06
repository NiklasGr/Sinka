// Admin API for managing upload sessions. Mounted behind requireAdmin, so every
// route here assumes an authenticated administrator. The student-facing side (the
// upload page + file POST) lives in a separate router mounted before the gate.

const express = require("express");
const fs = require("fs");
const path = require("path");
const QRCode = require("qrcode");
const archiver = require("archiver");

const sessions = require("../upload/sessions");
const { readLog } = require("../upload/submissions");
const { sanitizePathSegment } = require("../sync/engine");
const { readJsonObject, writeJsonAtomic } = require("../util/json-file");
const { noticeFor } = require("../config/privacy");
const { publicBase } = require("../config/runtime-settings");
const accessLog = require("../security/access-log");
const vault = require("../vault");

const router = express.Router();

// Bounds to keep an admin from creating an abusive or accidental session.
const MAX_DURATION_MINUTES = 7 * 24 * 60;        // one week
const MAX_FILE_SIZE_BYTES = 1024 * 1024 * 1024;  // 1 GiB hard ceiling per file
const DEFAULT_FILE_SIZE_BYTES = 25 * 1024 * 1024;

// Small admin UI preferences (e.g. the default allowed-extension list for new sessions).
const PREFS_PATH = path.join(vault.dataRoot(), "data", "upload-prefs.json");

function readPrefs() {
  return readJsonObject(PREFS_PATH);
}

function writePrefs(prefs) {
  writeJsonAtomic(PREFS_PATH, prefs);
}

// The absolute base students reach the server on — see publicBase in config/runtime-settings.
function publicLink(req, token) {
  return `${publicBase(req)}/u/${token}`;
}

// The view returned to the admin UI. Never exposes the codeHash or raw token
// fields beyond what's needed to build the link.
function toAdminView(req, s) {
  return {
    id: s.id,
    name: s.name,
    targetDir: s.targetDir,
    targetLabel: s.targetLabel,
    subfolder: s.subfolder,
    allowedExt: s.allowedExt,
    maxFileSizeBytes: s.maxFileSizeBytes,
    maxFilesPerUser: s.maxFilesPerUser,
    createdAt: s.createdAt,
    expiresAt: s.expiresAt,
    status: sessions.effectiveStatus(s),
    submissionCount: readLog(s.id).length,
    link: publicLink(req, s.token),
  };
}

// Normalise an allowed-extension list to lowercase ".ext" entries. An empty list
// means "any extension".
function normalizeExtensions(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const raw of input) {
    const ext = String(raw || "").trim().toLowerCase().replace(/^\.*/, "");
    if (ext) out.push(`.${ext}`);
  }
  return [...new Set(out)];
}

// A sanitised, traversal-safe relative subfolder (or "" for the target root).
function normalizeSubfolder(input) {
  return String(input || "")
    .split(/[\\/]+/)
    .map(sanitizePathSegment)
    .filter((seg) => seg && seg !== "." && seg !== "..")
    .join("/");
}

function isPositiveNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

// --- routes ------------------------------------------------------------------

router.get("/api/upload-sessions", (req, res) => {
  res.json({ success: true, sessions: sessions.readSessions().map((s) => toAdminView(req, s)) });
});

// Default new-session settings pre-filled into the form (saved via one button). Stored
// as the raw field strings; they are validated on use when a session is actually created.
const DEFAULT_KEYS = ["allowedExt", "durationMinutes", "maxFileSizeMb", "maxFilesPerUser"];

router.get("/api/upload-defaults", (req, res) => {
  const prefs = readPrefs();
  const out = { success: true };
  for (const k of DEFAULT_KEYS) out[k] = prefs[k] != null ? String(prefs[k]) : "";
  res.json(out);
});

router.post("/api/upload-defaults", (req, res) => {
  const body = req.body || {};
  const prefs = {};
  for (const k of DEFAULT_KEYS) prefs[k] = String(body[k] != null ? body[k] : "").trim();
  writePrefs(prefs);
  res.json({ success: true, ...prefs });
});

router.post("/api/upload-sessions", (req, res) => {
  const body = req.body || {};
  const name = String(body.name || "").trim();
  const targetDir = String(body.targetDir || "").trim();
  const durationMinutes = Number(body.durationMinutes);
  const maxFileSizeMb = body.maxFileSizeMb != null ? Number(body.maxFileSizeMb) : null;
  const maxFilesPerUser = body.maxFilesPerUser != null ? Number(body.maxFilesPerUser) : null;

  if (!name) return res.status(400).json({ error: "Name der Sitzung ist erforderlich" });
  if (!targetDir) return res.status(400).json({ error: "Ein Zielordner ist erforderlich" });
  if (!isPositiveNumber(durationMinutes)) {
    return res.status(400).json({ error: "Das Zeitlimit muss eine positive Zahl sein" });
  }
  if (durationMinutes > MAX_DURATION_MINUTES) {
    return res.status(400).json({ error: `Das Zeitlimit darf ${MAX_DURATION_MINUTES} Minuten nicht überschreiten` });
  }
  if (maxFilesPerUser != null && !(Number.isInteger(maxFilesPerUser) && maxFilesPerUser > 0)) {
    return res.status(400).json({ error: "Max. Dateien pro Person muss eine positive ganze Zahl sein" });
  }

  // The target must already exist as a directory (a synced course folder or a
  // local folder the admin has prepared).
  const resolvedTarget = path.resolve(targetDir);
  let stat;
  try {
    stat = fs.statSync(resolvedTarget);
  } catch {
    return res.status(400).json({ error: `Zielordner existiert nicht: ${resolvedTarget}` });
  }
  if (!stat.isDirectory()) {
    return res.status(400).json({ error: `Ziel ist kein Ordner: ${resolvedTarget}` });
  }
  // Keep collected uploads encrypted at rest: the target must be inside the vault.
  if (!vault.pathInVault(resolvedTarget)) {
    return res.status(400).json({ error: "Das Ziel muss im verschlüsselten Tresor liegen (SINKA_VAULT_MOUNT)" });
  }

  let maxFileSizeBytes = DEFAULT_FILE_SIZE_BYTES;
  if (maxFileSizeMb != null) {
    if (!isPositiveNumber(maxFileSizeMb)) {
      return res.status(400).json({ error: "Max. Dateigröße muss eine positive Zahl sein" });
    }
    maxFileSizeBytes = Math.round(maxFileSizeMb * 1024 * 1024);
    if (maxFileSizeBytes > MAX_FILE_SIZE_BYTES) {
      return res.status(400).json({ error: "Max. Dateigröße überschreitet die Obergrenze von 1024 MB" });
    }
  }

  const { session, code } = sessions.createSession({
    name,
    targetDir: resolvedTarget,
    targetLabel: String(body.targetLabel || "").trim() || resolvedTarget,
    subfolder: normalizeSubfolder(body.subfolder ?? name),
    allowedExt: normalizeExtensions(body.allowedExt),
    maxFileSizeBytes,
    maxFilesPerUser,
    durationMinutes,
  });

  // `code` is returned exactly once — it's not recoverable later, only regenerable.
  res.status(201).json({ success: true, session: toAdminView(req, session), code });
});

// Per-session dashboard data: the authoritative submissions log.
router.get("/api/upload-sessions/:id/submissions", (req, res) => {
  const session = sessions.getById(req.params.id);
  if (!session) return res.status(404).json({ error: "Sitzung nicht gefunden" });
  res.json({ success: true, submissions: readLog(session.id) });
});

// QR code (PNG) encoding the session's public link. Generated lazily so it always
// reflects the host the admin is currently on.
router.get("/api/upload-sessions/:id/qr", async (req, res) => {
  const session = sessions.getById(req.params.id);
  if (!session) return res.status(404).json({ error: "Sitzung nicht gefunden" });
  try {
    const png = await QRCode.toBuffer(publicLink(req, session.token), { type: "png", width: 320, margin: 1 });
    res.set("Content-Type", "image/png");
    res.set("Cache-Control", "no-store");
    res.send(png);
  } catch (err) {
    console.error("QR generation failed:", err);
    res.status(500).json({ error: "QR-Code konnte nicht erstellt werden" });
  }
});

// Download every file this session collected, as a zip. Scoped to the files named
// in the submissions log — never the rest of the target folder, which may hold
// unrelated synced course content.
router.get("/api/upload-sessions/:id/download", (req, res) => {
  const session = sessions.getById(req.params.id);
  if (!session) return res.status(404).json({ error: "Sitzung nicht gefunden" });

  const destDir = path.join(session.targetDir, ...session.subfolder.split("/").filter(Boolean));
  const seen = new Set();
  const files = [];
  for (const r of readLog(session.id)) {
    if (!r.storedName || seen.has(r.storedName)) continue;
    const abs = path.join(destDir, r.storedName);
    if (fs.existsSync(abs)) {
      files.push({ abs, name: r.storedName });
      seen.add(r.storedName);
    }
  }
  if (files.length === 0) return res.status(404).json({ error: "Keine hochgeladenen Dateien zum Herunterladen" });

  const zipName = (session.name || "uploads").replace(/[^\w.-]+/g, "_") + ".zip";
  accessLog.record("uploads-zip", session.name || session.id, `${files.length} Datei(en)`);
  res.attachment(zipName);

  const archive = archiver("zip", { zlib: { level: 9 } });
  archive.on("error", (err) => {
    console.error("Zip error:", err);
    res.destroy(err);
  });
  archive.pipe(res);
  for (const f of files) archive.file(f.abs, { name: f.name });
  archive.finalize();
});

// Print-friendly poster page: big QR + link (+ a code area the opener fills in
// client-side — the code itself is never stored server-side, only its hash).
router.get("/upload-sessions/:id/poster", (req, res) => {
  const session = sessions.getById(req.params.id);
  if (!session) return res.status(404).send("Sitzung nicht gefunden");
  res.render("poster", {
    id: session.id,
    name: session.name,
    link: publicLink(req, session.token),
    expiresAt: session.expiresAt,
    privacy: noticeFor(session), // same Art. 13 details as the upload page
  });
});

router.post("/api/upload-sessions/:id/close", (req, res) => {
  const session = sessions.closeSession(req.params.id);
  if (!session) return res.status(404).json({ error: "Sitzung nicht gefunden" });
  res.json({ success: true, session: toAdminView(req, session) });
});

router.post("/api/upload-sessions/:id/regenerate-code", (req, res) => {
  const code = sessions.regenerateCode(req.params.id);
  if (!code) return res.status(404).json({ error: "Sitzung nicht gefunden" });
  res.json({ success: true, code });
});

router.delete("/api/upload-sessions/:id", (req, res) => {
  if (!sessions.removeSession(req.params.id)) {
    return res.status(404).json({ error: "Sitzung nicht gefunden" });
  }
  res.json({ success: true });
});

module.exports = router;

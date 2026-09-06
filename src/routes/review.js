// Educator-only File Viewer / Review API. Mounted behind requireAdmin, which also
// guarantees an unlocked vault (see src/auth/admin-auth.js) — so every handler here
// runs only for an authenticated admin with plaintext data available.
//
// Two concerns dominate this file:
//   1. Path confinement. Every client-supplied path is resolved and checked to be the
//      vault root or a descendant of it (within()) before any fs access — the same
//      guard the folder browser uses (src/routes/fs.js). Nothing outside the vault is
//      ever listed or streamed.
//   2. Safe rendering. Reviewed files are student-supplied bytes shown in the admin's
//      browser. Only a whitelist of types is rendered inline; the Content-Type is taken
//      from that whitelist (never sniffed or echoed); SVG and everything else is served
//      as a download, never injected into the page. See the streaming route below.

const express = require("express");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const vault = require("../vault");
const notes = require("../review/notes");
const accessLog = require("../security/access-log");
const { uniqueName } = require("../upload/naming");

const router = express.Router();

// A generous ceiling so a note can't be used to bloat the store, while still allowing
// a full paragraph of commentary.
const MAX_NOTE_LENGTH = 10000;

// Ceilings for the operator's own uploads (see the upload route at the end of this file).
// The admin is trusted, so these are not a defence against them — they are a guard against
// filling the SD card by accident, which takes the whole server down with it.
const UPLOAD_MAX_BYTES = 250 * 1024 * 1024;
const UPLOAD_MAX_FILES = 20;

// Types we will render inline in the viewer, mapped to the exact Content-Type we serve.
// SVG is deliberately absent: it can carry <script> and would be a stored-XSS vector
// against the admin, so it is download-only (see below).
const VIEWABLE_MIME = {
  ".pdf": "application/pdf",
  ".txt": "text/plain; charset=utf-8",
  // Source code / notebooks are viewed as plain text only. Serving them as
  // text/plain (never a script/JSON type, nosniff enforced below) means the browser
  // treats them as inert text — they are displayed, never parsed or executed.
  ".java": "text/plain; charset=utf-8",
  ".py": "text/plain; charset=utf-8",
  ".cpp": "text/plain; charset=utf-8",
  ".ipynb": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".avif": "image/avif",
};

// A file's effective extension. Sync-conflict copies ("report.pdf.conflicted",
// "….conflicted-2") are typed by their underlying extension so the viewer can render
// both versions side by side; the content is the same synced data either way.
function extOf(name) {
  const base = String(name).replace(/\.conflicted(-\d+)?$/, "");
  return path.extname(base).toLowerCase();
}

function isViewable(name) {
  return Object.prototype.hasOwnProperty.call(VIEWABLE_MIME, extOf(name));
}

// The folder the viewer is confined to: the vault mount, or the project root in dev
// (matching vault.dataRoot(), which is where all at-rest data lives).
function rootDir() {
  return path.resolve(vault.dataRoot());
}

// True if p is the root or a descendant of it (identical to fs.js's guard).
function within(root, p) {
  return p === root || p.startsWith(root + path.sep);
}

// Resolve a client-supplied path (absolute or relative to the vault root) and confine
// it to the vault. Returns the absolute path, or null if it escapes the root.
function resolveInsideVault(input, { base } = {}) {
  const root = rootDir();
  if (input == null || input === "") return base || root;
  const raw = String(input);
  // Accept both absolute paths (as the folder browser emits) and vault-relative ones.
  const abs = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(base || root, raw);
  return within(root, abs) ? abs : null;
}

// Vault-relative POSIX path — the stable key used for notes and for the file API.
function relKey(abs) {
  return path.relative(rootDir(), abs).split(path.sep).join("/");
}

// GET /api/review/list?path=<dir>
// Lists the subfolders and files of a directory inside the vault. Files carry the
// metadata the viewer needs (size, mtime, whether we can render them inline).
router.get("/api/review/list", (req, res) => {
  const root = rootDir();
  const target = resolveInsideVault(req.query.path);
  if (!target) return res.status(400).json({ error: "Pfad liegt außerhalb des erlaubten Ordners" });

  let dirents;
  try {
    dirents = fs.readdirSync(target, { withFileTypes: true });
  } catch (error) {
    return res.status(400).json({ error: `Ordner „${target}“ kann nicht geöffnet werden: ${error.message}` });
  }

  const dirs = [];
  const files = [];
  for (const e of dirents) {
    const abs = path.join(target, e.name);
    if (e.isDirectory()) {
      dirs.push({ name: e.name, path: abs });
    } else if (e.isFile()) {
      let size = null;
      let mtime = null;
      try {
        const st = fs.statSync(abs);
        size = st.size;
        mtime = Math.trunc(st.mtimeMs / 1000);
      } catch {
        /* skip stat errors; leave nulls */
      }
      files.push({
        name: e.name,
        relPath: relKey(abs),
        ext: extOf(e.name),
        size,
        mtime,
        viewable: isViewable(e.name),
      });
    }
  }

  dirs.sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => a.name.localeCompare(b.name));

  // Enrich with review state so the list can show status badges + note counts.
  const summaries = notes.summariesFor(files.map((f) => f.relPath));
  for (const f of files) {
    const s = summaries[f.relPath];
    f.status = s.status;
    f.noteCount = s.noteCount;
  }

  const parent = target === root ? null : path.dirname(target);
  res.json({ path: target, parent, dirs, files });
});

// Resolve a client path param to the vault-relative note key, or null if it escapes
// the vault. The file need not exist (orphaned notes are accepted).
function keyFromPath(input) {
  const abs = resolveInsideVault(input);
  return abs ? relKey(abs) : null;
}

// GET /api/review/notes?path=<relPath> → { status, notes } for one file.
router.get("/api/review/notes", (req, res) => {
  const key = keyFromPath(req.query.path);
  if (!key) return res.status(400).json({ error: "Pfad liegt außerhalb des erlaubten Ordners" });
  res.json({ success: true, ...notes.getEntry(key) });
});

// POST /api/review/notes { path, body } → create a note.
router.post("/api/review/notes", async (req, res) => {
  const body = req.body || {};
  const key = keyFromPath(body.path);
  if (!key) return res.status(400).json({ error: "Pfad liegt außerhalb des erlaubten Ordners" });
  const text = String(body.body || "").trim();
  if (!text) return res.status(400).json({ error: "Notiztext darf nicht leer sein" });
  if (text.length > MAX_NOTE_LENGTH) return res.status(400).json({ error: "Notiz ist zu lang" });
  const note = await notes.addNote(key, text);
  res.status(201).json({ success: true, note });
});

// PUT /api/review/notes/:id { path, body } → edit a note's text.
router.put("/api/review/notes/:id", async (req, res) => {
  const body = req.body || {};
  const key = keyFromPath(body.path);
  if (!key) return res.status(400).json({ error: "Pfad liegt außerhalb des erlaubten Ordners" });
  const text = String(body.body || "").trim();
  if (!text) return res.status(400).json({ error: "Notiztext darf nicht leer sein" });
  if (text.length > MAX_NOTE_LENGTH) return res.status(400).json({ error: "Notiz ist zu lang" });
  const note = await notes.updateNote(key, req.params.id, text);
  if (!note) return res.status(404).json({ error: "Notiz nicht gefunden" });
  res.json({ success: true, note });
});

// DELETE /api/review/notes/:id?path=<relPath> → remove a note.
router.delete("/api/review/notes/:id", async (req, res) => {
  const key = keyFromPath(req.query.path);
  if (!key) return res.status(400).json({ error: "Pfad liegt außerhalb des erlaubten Ordners" });
  const ok = await notes.deleteNote(key, req.params.id);
  if (!ok) return res.status(404).json({ error: "Notiz nicht gefunden" });
  res.json({ success: true });
});

// POST /api/review/status { path, status } → set a file's review status.
router.post("/api/review/status", async (req, res) => {
  const body = req.body || {};
  const key = keyFromPath(body.path);
  if (!key) return res.status(400).json({ error: "Pfad liegt außerhalb des erlaubten Ordners" });
  if (!notes.STATUSES.includes(body.status)) {
    return res.status(400).json({ error: "Ungültiger Status" });
  }
  const status = await notes.setStatus(key, body.status);
  res.json({ success: true, status });
});

// GET /api/review/file?path=<relPath|abs>
// Streams one file's raw bytes for the viewer. Hardened: whitelist-derived Content-Type,
// no content sniffing, inline only for viewable types (everything else is a download),
// no caching of pupil data. Range requests are honoured (pdf.js + large images stream).
router.get("/api/review/file", (req, res) => {
  const abs = resolveInsideVault(req.query.path);
  if (!abs) return res.status(400).json({ error: "Pfad liegt außerhalb des erlaubten Ordners" });

  let stat;
  try {
    stat = fs.statSync(abs);
  } catch {
    return res.status(404).json({ error: "Datei nicht gefunden" });
  }
  if (!stat.isFile()) return res.status(400).json({ error: "Keine Datei" });

  const ext = extOf(abs);
  const viewable = isViewable(abs);
  const filename = path.basename(abs);
  // Viewable → inline so the browser renders it in-page; anything else (incl. SVG and
  // other active content) → attachment, so it can never execute in the app's origin.
  const mime = viewable ? VIEWABLE_MIME[ext] : "application/octet-stream";
  const disposition = viewable ? "inline" : "attachment";

  // Art. 5(2): record that this pupil file was reached, before it goes out.
  accessLog.record("file-view", relKey(abs), viewable ? "Anzeige" : "Download");

  res.set("Content-Type", mime);
  res.set("X-Content-Type-Options", "nosniff");
  res.set("Content-Disposition", `${disposition}; filename="${encodeURIComponent(filename)}"`);
  // Pupil data: never let it sit in a shared/browser cache (GDPR data minimisation).
  res.set("Cache-Control", "no-store");
  // Defence in depth: if the URL is opened directly, keep it inert.
  res.set("Content-Security-Policy", "default-src 'none'; sandbox");

  res.sendFile(abs, {
    acceptRanges: true,
    cacheControl: false, // we set Cache-Control ourselves (no-store)
    etag: false,         // no validators that could leak/allow caching of pupil data
    lastModified: false,
    dotfiles: "deny",
  }, (err) => {
    if (err && !res.headersSent) res.status(err.statusCode || 500).end();
  });
});

// POST /api/review/upload?path=<dir>
// Place local files into the folder the viewer is currently listing — the operator's own
// upload, distinct from the student-facing one in routes/public-upload.js.
//
// The target folder comes from the QUERY string, not the multipart body, because multer
// needs to know where to write before it has parsed any field. That also means the path
// is confined (resolveInsideVault) before a single byte is accepted, rather than after.
//
// Names are rebuilt with uniqueName(): a browser-supplied filename is untrusted input
// that could carry separators, and an existing file is never overwritten.
router.post("/api/review/upload", (req, res) => {
  const dirAbs = resolveInsideVault(req.query.path);
  if (!dirAbs) return res.status(400).json({ error: "Pfad liegt außerhalb des erlaubten Ordners" });

  let stat;
  try {
    stat = fs.statSync(dirAbs);
  } catch {
    return res.status(404).json({ error: "Ordner nicht gefunden" });
  }
  if (!stat.isDirectory()) return res.status(400).json({ error: "Das Ziel ist kein Ordner" });

  const stored = [];
  const uploader = multer({
    storage: multer.diskStorage({
      destination: (r, file, cb) => cb(null, dirAbs),
      filename: (r, file, cb) => {
        // multer hands us the raw client filename; latin1→utf8 recovers umlauts, which
        // browsers send as UTF-8 bytes in a header multer decodes as latin1.
        const original = Buffer.from(file.originalname, "latin1").toString("utf8");
        const name = uniqueName(dirAbs, original);
        stored.push(name);
        cb(null, name);
      },
    }),
    limits: { fileSize: UPLOAD_MAX_BYTES, files: UPLOAD_MAX_FILES },
  }).array("files");

  uploader(req, res, (err) => {
    if (err) {
      // Partial files may already sit in the target folder — remove them so a failed
      // upload never leaves half a file behind for someone to open.
      for (const name of stored) fs.rmSync(path.join(dirAbs, name), { force: true });
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({ error: `Eine Datei überschreitet ${Math.round(UPLOAD_MAX_BYTES / (1024 * 1024))} MB` });
      }
      if (err.code === "LIMIT_FILE_COUNT") {
        return res.status(413).json({ error: `Höchstens ${UPLOAD_MAX_FILES} Dateien auf einmal` });
      }
      return res.status(400).json({ error: "Upload fehlgeschlagen: " + err.message });
    }
    if (!stored.length) return res.status(400).json({ error: "Keine Datei ausgewählt" });

    // Recorded like the other data movements: a file added to a synced course folder
    // reaches Stud.IP or IServ on the next run, so this is a data flow, not a local edit.
    //
    // The names go into the detail, not just the count: the log folds repeats of the same
    // action+target+detail together (see DEDUPE_WINDOW_MS), so two separate single-file
    // uploads into one folder would otherwise collapse into a single line and understate
    // what was added. Naming the files also makes the entry answer the useful question.
    accessLog.record("file-upload", relKey(dirAbs), `${stored.length}: ${stored.join(", ")}`);
    res.json({ success: true, stored });
  });
});

module.exports = router;

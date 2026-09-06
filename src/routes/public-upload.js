// Student-facing upload routes. These are mounted BEFORE the admin gate
// (requireAdmin) — they are reachable without an admin login and are instead
// guarded by the session's short code. Everything is scoped to a session token
// taken from the URL.
//
//   GET  /u/:token                 the upload page (code form, then file form)
//   POST /api/u/:token/unlock      verify the code, rate-limited + lockout
//   POST /api/u/:token/files       accept uploads (must be unlocked + session open)

const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const multer = require("multer");
const { rateLimit, ipKeyGenerator } = require("express-rate-limit");

const sessions = require("../upload/sessions");
const { buildStoredName } = require("../upload/naming");
const { withSessionLock, appendSubmission } = require("../upload/submissions");
const { clientIp } = require("../util/client-ip");
const { noticeFor } = require("../config/privacy");
const { maskIp } = require("../util/redact");
const events = require("../security/events");
const vault = require("../vault");

// Temp landing zone: files buffer here, are validated, then moved to the target.
// Under private/ so it's gitignored and never served statically.
const TMP_DIR = path.join(vault.dataRoot(), "private", "upload_tmp");

const NAME_MAX = 100;
const DEFAULT_MAX_FILES = 50;

// --- code-attempt rate limiting (in-memory, per token + IP) ------------------

const MAX_FAILS = 6;
const LOCK_MS = 15 * 60 * 1000;
const attempts = new Map();

// Periodic reaper so the in-memory map can't grow without bound (many distinct
// token+IP keys never cleared, since only a successful unlock removes its own entry).
// An entry is dead once it is not actively locked and hasn't been touched within a
// lock window. Unref'd so it never keeps the process alive.
function sweepAttempts(now = Date.now()) {
  for (const [key, e] of attempts) {
    const lockActive = e.lockedUntil && now < e.lockedUntil;
    if (!lockActive && now - (e.updatedAt || 0) > LOCK_MS) attempts.delete(key);
  }
}
setInterval(sweepAttempts, LOCK_MS).unref();

function rateKey(id, ip) {
  return `${id}:${ip}`;
}

function rateState(id, ip) {
  const e = attempts.get(rateKey(id, ip));
  if (e && e.lockedUntil && Date.now() < e.lockedUntil) {
    return { locked: true, retryMin: Math.ceil((e.lockedUntil - Date.now()) / 60000) };
  }
  return { locked: false };
}

// Returns true when this attempt tripped the lockout, so the caller can record the
// escalation as a distinct security event rather than as one more wrong code.
function registerFail(id, ip) {
  const key = rateKey(id, ip);
  const e = attempts.get(key) || { fails: 0, lockedUntil: 0 };
  e.fails += 1;
  let locked = false;
  if (e.fails >= MAX_FAILS) {
    e.lockedUntil = Date.now() + LOCK_MS;
    e.fails = 0;
    locked = true;
  }
  e.updatedAt = Date.now(); // for the reaper
  attempts.set(key, e);
  return locked;
}

function resetRate(id, ip) {
  attempts.delete(rateKey(id, ip));
}

// --- unlock state (kept in the express session, keyed by the session token) ---

function isUnlocked(req, session) {
  const exp = req.session && req.session.uploadUnlocks && req.session.uploadUnlocks[session.token];
  return !!exp && Math.trunc(Date.now() / 1000) <= exp;
}

// --- helpers -----------------------------------------------------------------

function extAllowed(allowedExt, originalName) {
  if (!allowedExt || allowedExt.length === 0) return true;
  return allowedExt.includes(path.extname(originalName).toLowerCase());
}

// rename across the same device, falling back to copy+unlink across devices.
async function moveFile(src, dest) {
  try {
    await fs.promises.rename(src, dest);
  } catch (err) {
    if (err.code !== "EXDEV") throw err;
    await fs.promises.copyFile(src, dest);
    await fs.promises.unlink(src);
  }
}

async function cleanupTemp(files) {
  for (const f of files || []) {
    await fs.promises.unlink(f.path).catch(() => {});
  }
}

// A per-request multer instance carrying this session's size/count limits.
function makeUploader(session) {
  const storage = multer.diskStorage({
    destination: (req, file, cb) => {
      fs.mkdir(TMP_DIR, { recursive: true }, (err) => cb(err, TMP_DIR));
    },
    filename: (req, file, cb) => cb(null, crypto.randomBytes(16).toString("hex")),
  });
  return multer({
    storage,
    limits: {
      fileSize: session.maxFileSizeBytes || undefined,
      files: session.maxFilesPerUser || DEFAULT_MAX_FILES,
    },
  }).array("files");
}

// --- per-IP request rate limiting (defence-in-depth on a public endpoint) -----
//
// The unlock endpoint already enforces a per-(token, IP) lockout against code
// guessing; these limiters add a coarse per-IP cap across all sessions to blunt
// floods (the multer DoS patches handle malformed bodies, not request volume).

function jsonRateLimit({ windowMs, limit, message }) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    // Key on the real visitor IP (CF-Connecting-IP) rather than req.ip, which is
    // cloudflared's loopback address for every request behind the tunnel.
    keyGenerator: (req) => ipKeyGenerator(clientIp(req)),
    handler: (req, res) => res.status(429).json({ error: message }),
  });
}

const unlockLimiter = jsonRateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  message: "Zu viele Versuche. Bitte ein paar Minuten warten und erneut versuchen.",
});

const uploadLimiter = jsonRateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  message: "Zu viele Uploads von dieser Verbindung. Bitte kurz warten und erneut versuchen.",
});

// --- registration ------------------------------------------------------------

function registerPublicUploadRoutes(app) {
  // The upload page. Renders a friendly message for missing/closed sessions.
  app.get("/u/:token", (req, res) => {
    const session = sessions.getByToken(req.params.token);
    if (!session) {
      return res.status(404).render("upload-public", {
        state: "notfound", session: null, view: null, privacy: noticeFor(null),
      });
    }
    const status = sessions.effectiveStatus(session);
    const view = {
      token: session.token,
      name: session.name,
      allowedExt: session.allowedExt,
      maxFileSizeMb: session.maxFileSizeBytes ? Math.round(session.maxFileSizeBytes / (1024 * 1024)) : null,
      maxFilesPerUser: session.maxFilesPerUser || DEFAULT_MAX_FILES,
      expiresAt: session.expiresAt,
      unlocked: isUnlocked(req, session),
    };
    // Art. 13 notice — rendered on the page itself, because this is where the data is
    // handed over. See config/privacy.js.
    res.render("upload-public", {
      state: status === "open" ? "open" : "closed", session, view, privacy: noticeFor(session),
    });
  });

  // Verify the code. Rate-limited per token+IP with a lockout after repeated misses.
  app.post("/api/u/:token/unlock", unlockLimiter, (req, res) => {
    const session = sessions.getByToken(req.params.token);
    if (!session) return res.status(404).json({ error: "Sitzung nicht gefunden" });
    if (!sessions.isOpen(session)) return res.status(410).json({ error: "Diese Sitzung ist geschlossen" });

    const ip = clientIp(req);
    const limit = rateState(session.id, ip);
    if (limit.locked) {
      return res.status(429).json({ error: `Zu viele Versuche. Erneut versuchen in ${limit.retryMin} Min.` });
    }

    const code = (req.body && req.body.code) || "";
    if (!sessions.verifyCode(code, session.codeHash)) {
      // The session name is the teacher's own label, not pupil data; the address is
      // masked. Both stay inside the in-memory buffer (see security/events.js).
      const locked = registerFail(session.id, ip);
      events.record(locked ? "upload-code-locked" : "upload-code-failed",
        `${session.name} · ${maskIp(ip)}`);
      return res.status(401).json({ error: "Falscher Code" });
    }

    resetRate(session.id, ip);
    if (!req.session.uploadUnlocks) req.session.uploadUnlocks = {};
    req.session.uploadUnlocks[session.token] = session.expiresAt;
    req.session.save((err) => {
      if (err) return res.status(500).json({ error: "Sitzung konnte nicht gestartet werden" });
      res.json({ success: true, expiresAt: session.expiresAt });
    });
  });

  // Accept files. Requires the session to be open and unlocked in this browser.
  app.post("/api/u/:token/files", uploadLimiter, (req, res) => {
    const session = sessions.getByToken(req.params.token);
    if (!session) return res.status(404).json({ error: "Sitzung nicht gefunden" });
    if (!sessions.isOpen(session)) return res.status(410).json({ error: "Diese Sitzung ist geschlossen" });
    if (!isUnlocked(req, session)) return res.status(401).json({ error: "Bitte zuerst den Zugangscode eingeben" });
    // Files are written into the encrypted vault, which is mounted only while an admin
    // is logged in. If it's locked (e.g. after a restart), we can't store uploads yet.
    if (!vault.isUnlocked()) {
      return res.status(503).json({ error: "Uploads sind vorübergehend nicht möglich. Bitte später erneut versuchen." });
    }

    const uploader = makeUploader(session);
    uploader(req, res, async (err) => {
      if (err) {
        await cleanupTemp(req.files);
        if (err.code === "LIMIT_FILE_SIZE") {
          return res.status(413).json({ error: `Eine Datei überschreitet das Limit von ${session.maxFileSizeBytes / (1024 * 1024)} MB` });
        }
        if (err.code === "LIMIT_FILE_COUNT") {
          return res.status(413).json({ error: `Zu viele Dateien (max. ${session.maxFilesPerUser || DEFAULT_MAX_FILES})` });
        }
        return res.status(400).json({ error: "Upload fehlgeschlagen: " + err.message });
      }

      const firstName = String((req.body && req.body.firstName) || "").trim().slice(0, NAME_MAX);
      const lastName = String((req.body && req.body.lastName) || "").trim().slice(0, NAME_MAX);
      const files = req.files || [];

      if (!firstName || !lastName) {
        await cleanupTemp(files);
        return res.status(400).json({ error: "Vor- und Nachname sind erforderlich" });
      }
      if (files.length === 0) {
        return res.status(400).json({ error: "Mindestens eine Datei auswählen" });
      }

      const stored = [];
      const rejected = [];
      // Upload receipt: one short id per accepted batch, shown to the student and
      // written to every log record, so "I did submit!" disputes are resolvable.
      const receipt = crypto.randomBytes(4).toString("hex").toUpperCase();

      try {
        await withSessionLock(session.id, async () => {
          const destDir = path.join(session.targetDir, ...session.subfolder.split("/").filter(Boolean));
          await fs.promises.mkdir(destDir, { recursive: true });

          for (const file of files) {
            if (!extAllowed(session.allowedExt, file.originalname)) {
              await fs.promises.unlink(file.path).catch(() => {});
              rejected.push({ originalName: file.originalname, reason: "Dateityp nicht erlaubt" });
              continue;
            }
            const storedName = buildStoredName(firstName, lastName, file.originalname, destDir);
            await moveFile(file.path, path.join(destDir, storedName));
            // No IP here. § 31 Abs. 1 NSchG permits pupil data only "soweit
            // erforderlich", and the uploader's address serves none of the purposes
            // listed there — the receipt below already carries the proof-of-submission
            // role it might otherwise have had. Abuse defence works without it: the
            // code lockout and the per-IP limiter both key on the live address and
            // keep it in memory only.
            appendSubmission(session.id, {
              at: new Date().toISOString(),
              firstName,
              lastName,
              originalName: file.originalname,
              storedName,
              size: file.size,
              receipt,
            });
            stored.push({ originalName: file.originalname, storedName });
          }
        });
      } catch (processErr) {
        console.error(`Upload processing failed for session ${session.id}:`, processErr);
        await cleanupTemp(files);
        return res.status(500).json({ error: "Die hochgeladenen Dateien konnten nicht gespeichert werden" });
      }

      res.json({ success: true, stored, rejected, receipt: stored.length ? receipt : null });
    });
  });
}

module.exports = { registerPublicUploadRoutes };

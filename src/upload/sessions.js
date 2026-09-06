// Store for upload sessions — time-bound, code-protected collectors that gather
// files (plus uploader metadata) and drop them into a target directory. Persisted
// to data/upload_sessions.json. Mirrors the style of src/sync/registry.js.
//
// Two secrets guard a session:
//   - token: a long random value embedded in the shareable link / QR code, so the
//            URL itself is unguessable. Stored in the clear (it *is* the link).
//   - code:  a short human-typed value the admin shares verbally. Only its scrypt
//            hash is persisted; the plaintext is returned once at creation and on
//            an explicit regenerate, never stored.
//
// Submission logs are kept centrally in data/upload_submissions/<id>.json — never
// inside the target directory, which may be a synced course folder that would push
// the log to the remote on the next sync.

const path = require("path");
const crypto = require("crypto");
const vault = require("../vault");
const { readJsonArray, writeJsonAtomic } = require("../util/json-file");

const DATA_DIR = path.join(vault.dataRoot(), "data");
const SESSIONS_PATH = path.join(DATA_DIR, "upload_sessions.json");
const SUBMISSIONS_DIR = path.join(DATA_DIR, "upload_submissions");

function nowSec() {
  return Math.trunc(Date.now() / 1000);
}

// --- persistence -------------------------------------------------------------

function readSessions() {
  return readJsonArray(SESSIONS_PATH);
}

function writeSessions(entries) {
  writeJsonAtomic(SESSIONS_PATH, entries);
}

// --- token / code crypto -----------------------------------------------------

// The unguessable link token: 10 URL-safe chars (~60 bits). Short by request — the
// per-IP unlock rate limiter blunts online guessing of the token+code combination.
function generateToken() {
  return crypto.randomBytes(16).toString("base64url").slice(0, 10);
}

// A short human code from an unambiguous alphabet (no 0/O/1/I to avoid misreads).
function generateCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(8);
  let code = "";
  for (let i = 0; i < bytes.length; i++) code += alphabet[bytes[i] % alphabet.length];
  return code;
}

// Codes compare case-insensitively and ignore spaces the user might add.
function normalizeCode(code) {
  return String(code || "").replace(/\s+/g, "").toUpperCase();
}

function hashCode(code) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(normalizeCode(code), salt, 32);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

// Constant-time verification of a candidate code against a stored hash.
function verifyCode(code, stored) {
  const [scheme, saltHex, hashHex] = String(stored || "").split("$");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = crypto.scryptSync(normalizeCode(code), Buffer.from(saltHex, "hex"), expected.length);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

// --- status helpers ----------------------------------------------------------

function isExpired(session) {
  return session.expiresAt != null && nowSec() > session.expiresAt;
}

// "open" only while not manually closed and not past its deadline.
function effectiveStatus(session) {
  if (session.status === "closed") return "closed";
  if (isExpired(session)) return "expired";
  return "open";
}

function isOpen(session) {
  return !!session && effectiveStatus(session) === "open";
}

// --- lookups -----------------------------------------------------------------

function getById(id) {
  return readSessions().find((s) => s.id === id) || null;
}

function getByToken(token) {
  if (!token) return null;
  return readSessions().find((s) => s.token === token) || null;
}

// --- mutations ---------------------------------------------------------------

// Create a session. Returns { session, code } — `code` is the one-time plaintext
// to display to the admin; only its hash is persisted on the session.
function createSession({
  name,
  targetDir,
  targetLabel,
  subfolder,
  allowedExt,
  maxFileSizeBytes,
  maxFilesPerUser,
  durationMinutes,
}) {
  const entries = readSessions();
  const code = generateCode();
  const created = nowSec();
  const session = {
    id: crypto.randomBytes(6).toString("hex"),
    name,
    token: generateToken(),
    codeHash: hashCode(code),
    targetDir,
    targetLabel: targetLabel || targetDir,
    subfolder: subfolder || "",
    allowedExt: Array.isArray(allowedExt) ? allowedExt : [],
    maxFileSizeBytes: maxFileSizeBytes || null,
    maxFilesPerUser: maxFilesPerUser || null,
    createdAt: created,
    expiresAt: created + durationMinutes * 60,
    status: "open",
  };
  entries.push(session);
  writeSessions(entries);
  return { session, code };
}

// Mark a session closed (stops accepting uploads; keeps the record + files).
function closeSession(id) {
  const entries = readSessions();
  const session = entries.find((s) => s.id === id);
  if (!session) return null;
  session.status = "closed";
  writeSessions(entries);
  return session;
}

// There is deliberately NO class roster. It existed to drive a missing-submissions
// checklist, which meant storing the names of pupils who had handed in nothing and about
// whom the system held nothing else — a collection with no basis once the collecting is
// over (Art. 5 Abs. 1 lit. c and e DSGVO; § 31 Abs. 1 NSchG "soweit erforderlich").
// See finding 15 of the data-protection audit.

// Issue a fresh code, returning the one-time plaintext. Invalidates the old code.
function regenerateCode(id) {
  const entries = readSessions();
  const session = entries.find((s) => s.id === id);
  if (!session) return null;
  const code = generateCode();
  session.codeHash = hashCode(code);
  writeSessions(entries);
  return code;
}

// Remove the session record. Uploaded files and the submissions log are left on
// disk — they are real student data, not the session's to destroy.
function removeSession(id) {
  const entries = readSessions();
  const next = entries.filter((s) => s.id !== id);
  if (next.length === entries.length) return false;
  writeSessions(next);
  return true;
}

module.exports = {
  SUBMISSIONS_DIR,
  readSessions,
  getById,
  getByToken,
  createSession,
  closeSession,
  regenerateCode,
  removeSession,
  verifyCode,
  isOpen,
  effectiveStatus,
};

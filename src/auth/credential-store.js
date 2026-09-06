// Encrypted, per-provider credential store. Each provider's secrets (StudIP OAuth
// tokens, IServ login) live in their own file private/sinka_sessions/<provider>.json,
// encrypted at rest with AES-256-GCM (authenticated encryption).
//
// The key is derived from SESSION_ENCRYPTION_KEY (kept in .env, separate from the
// data). Note this protects data at rest only — a compromised running server can
// still decrypt, since it must to use the credentials.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const vault = require("../vault");
const { writeJsonAtomic } = require("../util/json-file");

// <vault>/private/sinka_sessions (or <projectRoot>/private/... when no vault is set).
const STORE_DIR = path.join(vault.dataRoot(), "private", "sinka_sessions");

// 32-byte key derived from the configured secret (accepts any string; use a long
// random value, e.g. `openssl rand -hex 32`).
function key() {
  const secret = process.env.SESSION_ENCRYPTION_KEY;
  if (!secret) throw new Error("SESSION_ENCRYPTION_KEY is not configured");
  return crypto.createHash("sha256").update(secret).digest();
}

function filePath(provider) {
  return path.join(STORE_DIR, `${provider}.json`);
}

function save(provider, data) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(data), "utf8"), cipher.final()]);
  const record = {
    v: 1,
    alg: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: ciphertext.toString("base64"),
  };
  // 0600 kept: even inside the vault these are the provider's live credentials, and the
  // mount is visible to the desktop session while unlocked.
  writeJsonAtomic(filePath(provider), record, { mode: 0o600 });
}

function load(provider) {
  let record;
  try {
    record = JSON.parse(fs.readFileSync(filePath(provider), "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
  const decipher = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(record.iv, "base64"));
  decipher.setAuthTag(Buffer.from(record.tag, "base64"));
  const plain = Buffer.concat([decipher.update(Buffer.from(record.data, "base64")), decipher.final()]);
  return JSON.parse(plain.toString("utf8"));
}

function clear(provider) {
  try {
    fs.unlinkSync(filePath(provider));
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
}

module.exports = { save, load, clear };

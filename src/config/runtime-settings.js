// Runtime-editable configuration. A small, explicit allow-list of non-secret URL
// settings can be changed from the admin settings UI. Each is persisted back to
// .env (so it survives a restart) and applied to process.env immediately — every
// consumer reads these lazily via process.env at call time, so no restart is
// needed for the change to take effect.
//
// Secrets (SESSION_ENCRYPTION_KEY, ADMIN_PASSWORD_HASH, the StudIP consumer
// key/secret) are deliberately NOT editable here.

const fs = require("fs");
const path = require("path");

const ENV_PATH = path.join(__dirname, "..", "..", ".env");

// key -> value type. "httpsurl" keys must be https:// URLs; "int" keys must be positive
// integers (blank = unset / feature disabled); "int0" additionally allows 0 as an
// explicit "off" for settings that are on by default when blank; "text" keys are
// short single-line strings shown to students (see TEXT_MAX below).
const MANAGED = {
  PUBLIC_BASE_URL: "httpsurl",
  STUDIP_BASE_URL: "httpsurl",
  ISERV_WEBDAV_URL: "httpsurl",
  SYNC_INTERVAL_MINUTES: "int", // auto-sync every N minutes (blank = manual sync only)
  RETENTION_DAYS: "int",        // auto-delete upload data older than N days (blank = keep forever)
  AUTO_LOGOUT_MINUTES: "int0",  // idle minutes before the vault auto-locks (blank = default 30, 0 = never)
  // Art. 13 GDPR requires the controller's identity and a contact for data-protection
  // questions to be given to students AT COLLECTION TIME. Both are deployment-specific
  // (they name the school), so they are configured here rather than hard-coded, and are
  // rendered on the upload page and the classroom poster.
  PRIVACY_CONTROLLER: "text",   // school name + postal address
  PRIVACY_CONTACT: "text",      // data-protection officer / contact address
};

// Single-line only, and short enough to display. Newlines and double quotes would
// also break the KEY="value" form that persist() writes into .env.
const TEXT_MAX = 300;
const MANAGED_KEYS = Object.keys(MANAGED);

// Absolute base URL the server is reached on. Prefer the explicit PUBLIC_BASE_URL
// (required behind a TLS-terminating proxy, or when the reachable host differs from
// what the request reports); otherwise derive it from the current request, which on a
// LAN is exactly the host:port the admin typed.
//
// Lives here because this module owns PUBLIC_BASE_URL. It used to be written out twice —
// once for the student upload link, once for the Stud.IP OAuth callback — and those two
// must agree: they are the same server seen by the same clients, so a drift between them
// would break exactly one of the two in a way nothing else would reveal.
function publicBase(req) {
  const configured = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
  return configured || `${req.protocol}://${req.get("host")}`;
}

// Current values, empty string when unset.
function getSettings() {
  const out = {};
  for (const key of MANAGED_KEYS) out[key] = process.env[key] || "";
  return out;
}

// Reject anything that isn't blank (= unset) or valid for the key's type.
function validate(values) {
  for (const key of MANAGED_KEYS) {
    const v = String(values[key] ?? "").trim();
    if (!v) continue; // blank clears the setting
    if (MANAGED[key] === "httpsurl") {
      let url;
      try {
        url = new URL(v);
      } catch {
        throw new Error(`${key} muss eine gültige URL sein`);
      }
      // https only. These URLs carry provider credentials and pupil data on the wire;
      // plain http would put both in cleartext, so there is no reason to allow it.
      if (url.protocol !== "https:") {
        throw new Error(`${key} muss eine https://-URL sein (unverschlüsseltes http:// ist nicht zulässig)`);
      }
    } else if (MANAGED[key] === "int" || MANAGED[key] === "int0") {
      const min = MANAGED[key] === "int0" ? 0 : 1;
      if (!/^\d+$/.test(v) || Number(v) < min) {
        throw new Error(`${key} muss eine ganze Zahl sein (mindestens ${min})`);
      }
    } else if (MANAGED[key] === "text") {
      if (v.length > TEXT_MAX) {
        throw new Error(`${key} darf höchstens ${TEXT_MAX} Zeichen lang sein`);
      }
      // eslint-disable-next-line no-control-regex
      if (/["\u0000-\u001f\u007f]/.test(v)) {
        throw new Error(`${key} darf keine Zeilenumbrüche oder Anführungszeichen enthalten`);
      }
    }
  }
}

// Rewrite .env in place, touching only MANAGED_KEYS. Every other line — comments,
// secrets, blank lines — is preserved verbatim. A commented "#KEY=" line is
// treated as the slot for KEY and gets rewritten (or re-commented when cleared).
function persist(values) {
  let lines = [];
  try {
    lines = fs.readFileSync(ENV_PATH, "utf8").split(/\r?\n/);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }

  const lineFor = (key, val) => (val ? `${key}="${val}"` : `#${key}=`);
  const seen = new Set();

  const next = lines.map((line) => {
    const m = line.match(/^\s*#?\s*([A-Z0-9_]+)\s*=/);
    if (m && MANAGED_KEYS.includes(m[1])) {
      seen.add(m[1]);
      return lineFor(m[1], String(values[m[1]] ?? "").trim());
    }
    return line;
  });

  // Append any managed key that had no slot yet.
  for (const key of MANAGED_KEYS) {
    if (!seen.has(key)) next.push(lineFor(key, String(values[key] ?? "").trim()));
  }

  fs.writeFileSync(ENV_PATH, next.join("\n"));
}

// Validate, persist to .env, then apply to the live process.env.
function updateSettings(values) {
  validate(values);
  persist(values);
  for (const key of MANAGED_KEYS) {
    const v = String(values[key] ?? "").trim();
    if (v) process.env[key] = v;
    else delete process.env[key];
  }
  return getSettings();
}


// Every URL the server ever dials out to or hands to a browser. validate() guards the
// ones editable in the settings UI, but .env is also written by install.sh and edited
// by hand, and nothing re-checks it at boot — so an http:// value could otherwise sit
// there unnoticed and carry provider credentials and pupil data in cleartext.
// ISERV_BASE_URL is included even though it is not runtime-editable: iserv.js derives
// the WebDAV root from it, so it reaches the network just the same.
const TLS_REQUIRED_KEYS = ["PUBLIC_BASE_URL", "STUDIP_BASE_URL", "ISERV_WEBDAV_URL", "ISERV_BASE_URL"];

// Names of the configured URLs that are not https. Empty array = everything is fine.
function insecureUrlKeys() {
  return TLS_REQUIRED_KEYS.filter((key) => {
    const v = (process.env[key] || "").trim();
    if (!v) return false; // unset is not insecure
    try {
      return new URL(v).protocol !== "https:";
    } catch {
      return true; // unparseable is not something we should dial either
    }
  });
}

module.exports = { getSettings, updateSettings, insecureUrlKeys, publicBase };

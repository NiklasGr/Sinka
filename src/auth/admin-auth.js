// App-level admin gate. A single administrator account guards every page, API
// route and static asset. Credentials are read from the environment:
//   ADMIN_USERNAME       - the login name (defaults to "admin")
//   ADMIN_PASSWORD_HASH  - "scrypt$<saltHex>$<hashHex>", generated with
//                          `node scripts/hash-password.js`
//
// The password is never stored in plaintext. Verification is constant-time so a
// caller cannot learn the hash by timing the comparison.

const crypto = require("crypto");
const { rateLimit, ipKeyGenerator } = require("express-rate-limit");
const vault = require("../vault");
const { clientIp } = require("../util/client-ip");
const { maskIp } = require("../util/redact");
const events = require("../security/events");

// Longest password/username the login will even hash. scryptSync burns real CPU per
// call (and blocks the event loop), so unbounded input would let an attacker turn the
// login into a DoS lever. Far above any legitimate credential length.
const MAX_CREDENTIAL_LENGTH = 256;

// Failed-attempt limiter for the admin login: 10 misses per IP per 15 minutes.
// Successful logins don't count, so a fumbled password or two never locks the
// teacher out. Keyed on the real visitor IP (CF-Connecting-IP behind the tunnel).
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  skipSuccessfulRequests: true,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  // The limiter keys on the FULL address — masking here would pool a whole /24 into
  // one bucket. Only the log line is truncated (see util/redact.js).
  keyGenerator: (req) => ipKeyGenerator(clientIp(req)),
  handler: (req, res) => {
    const masked = maskIp(clientIp(req));
    events.record("login-rate-limited", masked);
    console.warn(`Login rate limit hit for ${masked}`);
    res.status(429).render("login", {
      error: "Zu viele Anmeldeversuche. Bitte 15 Minuten warten und erneut versuchen.",
    });
  },
});

// Verify a candidate password against a stored "scrypt$<salt>$<hash>" record.
function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored || "").split("$");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = crypto.scryptSync(String(password), Buffer.from(saltHex, "hex"), expected.length);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

// Constant-time string equality for the username (avoids leaking it via timing).
function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// Routes that must stay reachable without a session. Registered before the gate.
function registerAdminRoutes(app) {
  app.get("/login", (req, res) => {
    // Only skip the form when fully ready: authenticated AND the vault is unlocked.
    // After a restart a session may still say isAdmin while the vault is locked — then
    // we must show the form so the admin re-enters the password to unlock it.
    if (req.session?.isAdmin && vault.isUnlocked()) return res.redirect("/home");
    res.render("login", { error: null });
  });

  app.post("/login", loginLimiter, (req, res) => {
    const { username, password } = req.body || {};
    const expectedUser = process.env.ADMIN_USERNAME || "admin";
    const storedHash = process.env.ADMIN_PASSWORD_HASH;

    if (!storedHash) {
      console.error("ADMIN_PASSWORD_HASH is not configured");
      return res.status(500).render("login", { error: "Der Server ist nicht für die Anmeldung konfiguriert." });
    }

    // Length gate BEFORE any scrypt work (see MAX_CREDENTIAL_LENGTH). Overlong input
    // is simply a failed login — same message, no oracle.
    const lengthOk =
      typeof username === "string" && username.length <= MAX_CREDENTIAL_LENGTH &&
      typeof password === "string" && password.length <= MAX_CREDENTIAL_LENGTH;

    const ok = lengthOk && safeEqual(username, expectedUser) && verifyPassword(password, storedHash);
    if (!ok) {
      // Audit trail in the journal: how often, roughly from where, and whether the
      // guess even targeted the real account name. The submitted username itself is
      // caller-controlled free text — it could be anyone's name — and the journal
      // sits outside the encrypted vault, so it is reduced to a match flag.
      const targetedAdmin = lengthOk && safeEqual(username, expectedUser);
      const masked = maskIp(clientIp(req));
      events.record("login-failed", `${masked}, Benutzername ${targetedAdmin ? "korrekt" : "falsch"}`);
      console.warn(
        `Failed admin login from ${masked} ` +
        `(username ${targetedAdmin ? "matched" : "did not match"})`
      );
      return res.status(401).render("login", { error: "Benutzername oder Passwort ist falsch." });
    }

    // The verified password also unlocks the at-rest vault (runs SINKA_UNLOCK_CMD).
    // If the vault can't be mounted, refuse rather than run with data inaccessible.
    if (!vault.unlock(password)) {
      // Correct password but no mount: either a misconfiguration or someone tampered
      // with the unlock command. Both are worth an operator's attention.
      events.record("vault-unlock-failed", null);
      return res.status(500).render("login", {
        error: "Das Passwort ist korrekt, aber der verschlüsselte Speicher konnte nicht " +
          "entsperrt werden. Tresor-Konfiguration prüfen (siehe docs/encryption-at-rest.md).",
      });
    }

    // Prevent session fixation: issue a fresh session on successful login.
    req.session.regenerate((err) => {
      if (err) {
        console.error("Session regenerate failed:", err);
        return res.status(500).render("login", { error: "Sitzung konnte nicht gestartet werden." });
      }
      req.session.isAdmin = true;
      req.session.save(() => res.redirect("/home"));
    });
  });

  app.post("/logout", (req, res) => {
    vault.lock(); // re-lock the vault; data is inaccessible until the next login
    req.session.destroy(() => {
      res.clearCookie("connect.sid");
      res.redirect("/login");
    });
  });
}

// The gate. Requires an authenticated admin AND an unlocked vault — so after a restart
// (session valid, vault unmounted) the admin is sent back to /login to re-unlock.
function requireAdmin(req, res, next) {
  if (req.session?.isAdmin && vault.isUnlocked()) return next();
  if (req.path.startsWith("/api/")) {
    return res.status(401).json({ error: "Anmeldung erforderlich" });
  }
  return res.redirect("/login");
}

module.exports = { registerAdminRoutes, requireAdmin };

const crypto = require("crypto");
const express = require("express");
const fs = require("fs");
const path = require("path");
const session = require("express-session");
const FileStore = require("session-file-store")(session);
const { loadEnvFile } = require('node:process');
const { PerformanceObserver, performance } = require('node:perf_hooks');

loadEnvFile(); // before providers read process.env

// Without a vault, data is stored UNENCRYPTED under the project dir. Fine for local
// development, but a misconfiguration in production — warn loudly so it's not silent.
if (!process.env.SINKA_VAULT_MOUNT) {
  console.warn("WARNING: SINKA_VAULT_MOUNT is not set — data is stored UNENCRYPTED (dev mode). Do not use for real personal data.");
}

// Refuse to start on a plain-http provider or public URL. The settings UI already
// rejects them, but .env is also written by install.sh and edited by hand — and an
// http:// value here would send provider credentials and pupil data over the wire in
// cleartext, which is exactly what the rest of this deployment is built to prevent.
// Aborting rather than warning: a warning scrolls past in the journal and the server
// keeps running, which is the one outcome that must not happen here.
const { insecureUrlKeys } = require("./src/config/runtime-settings");
const insecure = insecureUrlKeys();
if (insecure.length) {
  console.error(
    `FATAL: these URLs are not https — refusing to start: ${insecure.join(", ")}. ` +
    "Fix them in .env (or in Settings) so all traffic is TLS-protected."
  );
  process.exit(1);
}

const { providers } = require("./src/providers");
const { registerAdminRoutes, requireAdmin } = require("./src/auth/admin-auth");
const { markActivity } = require("./src/auth/activity");
const { registerPublicUploadRoutes } = require("./src/routes/public-upload");
const pageRoutes = require("./src/routes/pages");
const homeRoutes = require("./src/routes/home");
const fsRoutes = require("./src/routes/fs");
const syncRoutes = require("./src/routes/sync");
const adminUploadRoutes = require("./src/routes/admin-upload");
const reviewRoutes = require("./src/routes/review");
const settingsRoutes = require("./src/routes/settings");

const app = express();
const PORT = 9100;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Cache-buster for static assets: bumped every server start. Appended to script URLs so
// a restart (which is how backend changes are picked up) always delivers fresh JS to the
// browser, instead of a stale ES module lingering in the page.
app.locals.assetVersion = Date.now();

// The app is reached ONLY through the Cloudflare tunnel: cloudflared connects from
// 127.0.0.1 and forwards the original X-Forwarded-Proto/-For. Trusting loopback lets
// Express read those headers, while nothing off-box (the server binds loopback too)
// can set them.
app.set('trust proxy', 'loopback');

// HTTPS-only. Every legitimate request arrives over the tunnel as HTTPS (reflected in
// X-Forwarded-Proto, trusted above). Reject anything that isn't secure, so a plain
// HTTP request to the loopback port can never reach the app, its login, or any data.
app.use((req, res, next) => {
  if (req.secure) return next();
  res.status(403).send("HTTPS required");
});

// Baseline security headers on every response: no framing (clickjacking), no MIME
// sniffing, no referrer leakage to external links. Routes that need a stricter CSP
// (the review file streamer) overwrite the CSP header for their own responses.
app.use((req, res, next) => {
  res.set("Content-Security-Policy", "frame-ancestors 'none'");
  res.set("X-Frame-Options", "DENY"); // legacy-browser equivalent of frame-ancestors
  res.set("X-Content-Type-Options", "nosniff");
  res.set("Referrer-Policy", "no-referrer");
  res.set("Strict-Transport-Security", "'max-age=31536000; includeSubDomains; preload'");
  next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: false })); // login form submission

// Express's own session files (cookie/session-id plumbing). Kept separate from the
// provider credential store in private/sinka_sessions so its reaper never touches
// the encrypted <provider>.json files.
const SESSION_DIR = path.join(__dirname, 'private', 'express_sessions');
if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });

// The session-cookie signing secret is generated fresh on every start. It only signs
// the session-ID cookie (no data is encrypted with it), so the sole effect is that all
// sessions die with the process — the admin logs in again after a restart, which the
// vault gate forces after a reboot anyway. One less static secret to keep in .env.
// (SESSION_ENCRYPTION_KEY is unrelated and must stay configured: it encrypts stored
// provider credentials.)
const SESSION_SECRET = crypto.randomBytes(32).toString("hex");

app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  store: new FileStore({
    path: SESSION_DIR,
    ttl: 60 * 60 * 24 * 7,
    retries: 1,
    reapInterval: 60 * 60,
    logFn: () => {},
  }),
  // All traffic is HTTPS via the tunnel, so the session cookie is always Secure.
  cookie: { httpOnly: true, secure: true, sameSite: "lax", maxAge: 1000 * 60 * 60 * 24 * 7 },
}));

// =============================================================================
// ADMIN GATE
// =============================================================================
// Login/logout routes are registered first so they remain reachable without a
// session. Everything mounted after requireAdmin — static assets, pages, every
// API route and each provider's auth flow — requires an authenticated admin.

registerAdminRoutes(app);

// Student-facing upload routes live in front of the gate: reachable without an
// admin session and guarded instead by each session's short access code.
registerPublicUploadRoutes(app);

app.use(requireAdmin);

// Every authenticated request counts as admin activity for the auto-logout clock
// (closing the browser tab stops the requests, and the idle timer takes it from there).
app.use((req, res, next) => {
  markActivity();
  next();
});

app.use(express.static(path.join(__dirname, "public")));

// pdf.js library + worker, served straight from the installed dependency (behind the
// admin gate) so the File Viewer can render PDFs without vendoring a copy into the repo.
app.use("/vendor/pdfjs", express.static(path.join(__dirname, "node_modules", "pdfjs-dist", "build")));

// Each provider mounts its own auth flow (e.g. /auth/studip, /auth/iserv).
for (const provider of Object.values(providers)) {
  provider.registerAuthRoutes?.(app);
}

// Application routes.
app.use(pageRoutes);
app.use(homeRoutes);
app.use(syncRoutes);
app.use(fsRoutes);
app.use(adminUploadRoutes);
app.use(reviewRoutes);
app.use(settingsRoutes);

// Background jobs: auto-sync + retention (both no-ops until configured in Settings,
// and both idle while the vault is locked).
require("./src/scheduler").start();

// Bind to loopback only: the sole way in is the Cloudflare tunnel (cloudflared runs
// on this host and connects to 127.0.0.1). The port is not exposed to the LAN.
app.listen(PORT, "127.0.0.1", () => {
  console.log(`Server running on http://127.0.0.1:${PORT} (reachable only via the Cloudflare tunnel)`);
});

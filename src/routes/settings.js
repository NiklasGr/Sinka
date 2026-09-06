// Admin settings API: read and update the runtime-editable configuration, plus the
// hard reset. Mounted behind the admin gate, so only an authenticated admin can
// reach it.

const express = require("express");
const fs = require("fs");
const path = require("path");
const { getSettings, updateSettings } = require("../config/runtime-settings");
const { readRegistry } = require("../sync/registry");
const vault = require("../vault");

const PROJECT_ROOT = path.join(__dirname, "..", "..");

const router = express.Router();

router.get("/api/settings", (req, res) => {
  res.json({ success: true, settings: getSettings() });
});

router.post("/api/settings", (req, res) => {
  try {
    const settings = updateSettings(req.body || {});
    res.json({ success: true, settings });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Hard reset: return the installation to its pre-install.sh state. Deletes .env and
// every piece of user/session data the app has written:
//   - synced course folders (only those inside the data root — nothing outside it)
//   - <dataRoot>/data           registries, submission logs, review notes, erasure log
//   - <dataRoot>/private        encrypted provider credentials, upload temp files
//   - <dataRoot>/sinka_files    legacy upload area (if present)
//   - <project>/private         Express login sessions
// The vault *container* itself (gocryptfs cipher dir) is NOT destroyed —
// the app only ever sees the mount; after the wipe it holds no plaintext data and is
// re-locked. Afterwards the process exits: like a fresh clone, the server won't start
// again until scripts/install.sh has been run.
//
// Guarded by an explicit confirmation token so a stray request can never trigger it.
router.post("/api/hard-reset", async (req, res) => {
  if (String((req.body || {}).confirm) !== "RESET") {
    return res.status(400).json({ error: 'Bestätigung erforderlich: { "confirm": "RESET" } senden' });
  }

  const dataRoot = path.resolve(vault.dataRoot());
  const inDataRoot = (p) => {
    const abs = path.resolve(p);
    return abs === dataRoot || abs.startsWith(dataRoot + path.sep);
  };

  const targets = [
    // Synced course folders first, while the registry still exists to name them.
    ...readRegistry().map((e) => e.localPath).filter(inDataRoot),
    path.join(dataRoot, "data"),
    path.join(dataRoot, "private"),
    path.join(dataRoot, "sinka_files"),
    path.join(PROJECT_ROOT, "private"),
    path.join(PROJECT_ROOT, ".env"),
  ];

  try {
    for (const target of targets) {
      await fs.promises.rm(target, { recursive: true, force: true });
    }
  } catch (err) {
    console.error("Hard reset failed:", err);
    return res.status(500).json({ error: `Zurücksetzen fehlgeschlagen: ${err.message}` });
  }

  console.warn("HARD RESET performed by admin — data wiped, .env removed, shutting down.");
  res.json({
    success: true,
    message: "Zurücksetzen abgeschlossen. Der Server wird heruntergefahren — zum Neueinrichten scripts/install.sh ausführen.",
  });

  // Give the response time to flush, then re-lock the (now empty) vault and exit.
  // Like a fresh clone, the server cannot start again until install.sh recreates .env.
  setTimeout(() => {
    try { vault.lock(); } catch { /* best effort */ }
    process.exit(0);
  }, 500);
});

module.exports = router;

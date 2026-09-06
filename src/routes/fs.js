// Server-side filesystem browser used when choosing a sync/upload folder (Step 2).
//
// The browser is rooted at the encrypted vault (SINKA_VAULT_MOUNT) and cannot navigate
// above it, so sync/upload targets can only ever be inside the vault (matching the
// pathInVault checks on the sync/upload endpoints). When no vault is configured (dev),
// it falls back to the user's home directory.

const express = require("express");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vault = require("../vault");

const router = express.Router();

// The folder the browser is confined to.
function rootDir() {
  return vault.isConfigured() ? vault.MOUNT : path.resolve(os.homedir());
}

// True if p is the root or a descendant of it.
function within(root, p) {
  return p === root || p.startsWith(root + path.sep);
}

// List only the subdirectories of a path (defaults to, and confined within, the root).
router.get("/api/fs/list", (req, res) => {
  const root = rootDir();
  const target = req.query.path ? path.resolve(String(req.query.path)) : root;
  if (!within(root, target)) {
    return res.status(400).json({ error: "Pfad liegt außerhalb des erlaubten Ordners" });
  }
  try {
    const all = fs.readdirSync(target, { withFileTypes: true });
    const entries = all
      .filter((e) => e.isDirectory())
      .map((e) => ({ name: e.name, path: path.join(target, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    // No navigating above the root: parent is null once we're at the root.
    const parent = target === root ? null : path.dirname(target);
    // `empty` gates selection: only empty folders may be used as a sync folder.
    res.json({ path: target, parent, empty: all.length === 0, entries });
  } catch (error) {
    res.status(400).json({ error: `Ordner „${target}“ kann nicht geöffnet werden: ${error.message}` });
  }
});

// Create a new (empty) subfolder so the user can make a sync target on the spot.
router.post("/api/fs/mkdir", (req, res) => {
  const { path: parent, name } = req.body || {};
  if (!parent || !name) return res.status(400).json({ error: "Pfad und Name sind erforderlich" });
  if (/[\\/]/.test(name)) return res.status(400).json({ error: "Ordnername darf keine Pfadtrenner enthalten" });
  const root = rootDir();
  const parentResolved = path.resolve(String(parent));
  if (!within(root, parentResolved)) {
    return res.status(400).json({ error: "Pfad liegt außerhalb des erlaubten Ordners" });
  }
  const target = path.join(parentResolved, name);
  try {
    fs.mkdirSync(target); // non-recursive: fails if it already exists
    res.json({ success: true, path: target });
  } catch (error) {
    res.status(400).json({ error: `Ordner „${target}“ kann nicht erstellt werden: ${error.message}` });
  }
});

module.exports = router;

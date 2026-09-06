// Sync API: the per-provider course list, the synced-course registry, the sync-all
// run, and the conflict list (".conflicted" copies the engine creates when both sides
// changed a file).

const express = require("express");
const fs = require("fs");
const path = require("path");
const archiver = require("archiver");
const accessLog = require("../security/access-log");

const { getProvider } = require("../providers");
const { runAllCourses, getProgress } = require("../sync/run-all");
const { readRegistry, upsertEntry, removeEntry } = require("../sync/registry");
const vault = require("../vault");

const router = express.Router();

// Matches the names produced by uniqueConflictedPath() in the engine.
const CONFLICTED_RE = /\.conflicted(-\d+)?$/;

// Resolve the provider + auth context for a request, or send the appropriate error.
function resolveProvider(req, res) {
  const provider = getProvider(req.params.provider);
  if (!provider) {
    res.status(404).json({ error: `Unbekannter Anbieter „${req.params.provider}“` });
    return null;
  }
  const ctx = provider.getContext(req);
  if (!ctx) {
    res.status(401).json({ error: `Nicht bei ${provider.name} angemeldet` });
    return null;
  }
  return { provider, ctx };
}

// Step 1: courses the user can sync, for the course dropdown.
router.get("/api/:provider/courses", async (req, res) => {
  const resolved = resolveProvider(req, res);
  if (!resolved) return;
  const { provider, ctx } = resolved;
  try {
    if (!provider.listCourses) return res.status(404).json({ error: `${provider.name} kann keine Kurse auflisten` });
    res.json({ success: true, provider: provider.name, courses: await provider.listCourses(ctx) });
  } catch (error) {
    console.error('List courses error:', error);
    res.status(500).json({ error: "Kurse konnten nicht geladen werden", details: error.message });
  }
});

// Step 3: the registry of actively-synced courses.
router.get("/api/sync-registry", (req, res) => {
  res.json({ success: true, entries: readRegistry() });
});

router.post("/api/sync-registry", async (req, res) => {
  const { provider: providerName, courseId, courseName, localPath } = req.body || {};
  if (!providerName || !courseId || !localPath) {
    return res.status(400).json({ error: "Anbieter, Kurs und lokaler Ordner sind erforderlich" });
  }
  if (!getProvider(providerName)) return res.status(404).json({ error: `Unbekannter Anbieter „${providerName}“` });
  // Keep synced course data encrypted at rest: the folder must be inside the vault mount.
  if (!vault.pathInVault(localPath)) {
    return res.status(400).json({ error: "Der Synchronisationsordner muss im verschlüsselten Tresor liegen (SINKA_VAULT_MOUNT)" });
  }
  try {
    // A sync folder must be empty: create it if missing, reject it if it has contents.
    const existing = await fs.promises.readdir(localPath).catch((e) => {
      if (e.code === 'ENOENT') return null;
      throw e;
    });
    if (existing === null) await fs.promises.mkdir(localPath, { recursive: true });
    else if (existing.length > 0) return res.status(400).json({ error: "Der Ordner muss leer sein" });
  } catch (error) {
    return res.status(400).json({ error: `Ordner „${localPath}“ kann nicht verwendet werden: ${error.message}` });
  }
  const entry = upsertEntry({ provider: providerName, courseId, courseName: courseName || String(courseId), localPath });
  res.json({ success: true, entry });
});

router.delete("/api/sync-registry/:provider/:course_id", (req, res) => {
  removeEntry(req.params.provider, req.params.course_id);
  res.json({ success: true });
});

// Download a synced course folder as a zip. The folder path comes from the registry
// entry (never from the client), so nothing outside a registered sync folder can be
// zipped. manifest.json is sync bookkeeping, not course content — excluded.
router.get("/api/sync-registry/:provider/:course_id/download", (req, res) => {
  const entry = readRegistry().find(
    (e) => e.provider === req.params.provider && String(e.courseId) === String(req.params.course_id)
  );
  if (!entry) return res.status(404).json({ error: "Synchronisierter Kurs nicht gefunden" });

  let stat;
  try {
    stat = fs.statSync(entry.localPath);
  } catch {
    return res.status(404).json({ error: "Kursordner existiert nicht (wurde er schon synchronisiert?)" });
  }
  if (!stat.isDirectory()) return res.status(400).json({ error: "Der Kurspfad ist kein Ordner" });

  const zipName = (entry.courseName || "course").replace(/[^\w.-]+/g, "_") + ".zip";
  accessLog.record("course-zip", entry.localPath, entry.courseName || null);
  res.attachment(zipName);
  res.set("Cache-Control", "no-store");

  const archive = archiver("zip", { zlib: { level: 9 } });
  archive.on("error", (err) => {
    console.error("Course zip error:", err);
    res.destroy(err);
  });
  archive.pipe(res);
  // Whole folder, streamed (never buffered), rooted at the zip's top level.
  archive.directory(entry.localPath, false, (data) =>
    data.name === "manifest.json" ? false : data
  );
  archive.finalize();
});

// Step 4: sync every registered course (shared with the scheduler's automatic runs;
// see src/sync/run-all.js for the fault-tolerance and mutual-exclusion rules).
router.post("/api/sync", async (req, res) => {
  const { alreadyRunning, results } = await runAllCourses();
  if (alreadyRunning) {
    return res.status(409).json({ error: "Eine Synchronisation läuft bereits — bitte gleich erneut versuchen" });
  }
  res.json({ success: true, count: results.length, results });
});

// Live progress of the current sync run (manual or scheduled), polled by the UI's
// progress bar while a run is in flight.
router.get("/api/sync/progress", (req, res) => {
  res.json({ success: true, ...getProgress() });
});

// --- conflict surfacing --------------------------------------------------------

async function findConflictedFiles(dir) {
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return []; // sync folder missing/unreadable — nothing to report for it
  }
  const found = [];
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) found.push(...await findConflictedFiles(abs));
    else if (e.isFile() && CONFLICTED_RE.test(e.name)) found.push(abs);
  }
  return found;
}

// Vault-relative POSIX path, as the File Viewer's ?open= deep link expects.
function vaultRel(abs) {
  return path.relative(path.resolve(vault.dataRoot()), abs).split(path.sep).join("/");
}

// List every ".conflicted" copy across all synced courses, paired with its original
// so the UI can open both side by side in the File Viewer's compare mode.
router.get("/api/sync-conflicts", async (req, res) => {
  const conflicts = [];
  for (const entry of readRegistry()) {
    for (const abs of await findConflictedFiles(entry.localPath)) {
      const originalAbs = abs.replace(CONFLICTED_RE, "");
      conflicts.push({
        provider: entry.provider,
        courseName: entry.courseName,
        name: path.basename(abs),
        dir: path.dirname(abs),
        conflictedRel: vaultRel(abs),
        originalRel: vaultRel(originalAbs),
        originalExists: fs.existsSync(originalAbs),
      });
    }
  }
  res.json({ success: true, conflicts });
});

// Resolve a conflict by discarding the ".conflicted" copy (after the teacher has
// compared both versions). Confined twice: the name must match the conflict pattern,
// and the path must lie inside a registered sync folder — this route can delete
// nothing else.
router.delete("/api/sync-conflicts", async (req, res) => {
  const raw = String(req.query.path || "");
  const abs = path.resolve(raw);
  if (!CONFLICTED_RE.test(abs)) {
    return res.status(400).json({ error: "Keine Konfliktkopie (.conflicted)" });
  }
  const inSyncFolder = readRegistry().some((e) => {
    const root = path.resolve(e.localPath);
    return abs === root || abs.startsWith(root + path.sep);
  });
  if (!inSyncFolder) {
    return res.status(400).json({ error: "Pfad liegt nicht in einem synchronisierten Kursordner" });
  }
  try {
    await fs.promises.rm(abs, { force: false });
  } catch (err) {
    return res.status(400).json({ error: `Löschen fehlgeschlagen: ${err.message}` });
  }
  res.json({ success: true });
});

module.exports = router;

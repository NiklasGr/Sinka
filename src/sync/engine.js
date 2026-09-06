// =============================================================================
// SYNC ENGINE  (provider-agnostic)
// =============================================================================
//
// Three-way file/folder synchronisation between a local directory and a remote
// store. All remote access goes through a `provider` adapter (see providers/) 
// and an opaque auth `ctx`.
//
//
// Provider interface expected by runSync():
//   listTree(ctx, courseId)            -> { rootFolderId, files:[file], folders:[{path,id}] }
//   downloadFile(ctx, file, destPath)
//   uploadFile(ctx, folderId, localPath, name) -> { id, timestamp }
//   deleteFile(ctx, fileId)
//   createFolder(ctx, parentId, name)  -> { id }
//   deleteFolder(ctx, folderId)
//   isFolderEmpty(ctx, folderId)       -> boolean
//   canWriteFile(ctx, fileId)          -> boolean
//   canCreateInFolder(ctx, folderId)   -> boolean
//   canDeleteFolder(ctx, folderId)     -> boolean
//
// A remote `file` is `{ id, path, folderId, name, size, timestamp, ref }` where
// `timestamp` is an abstract, monotonically increasing version marker (a Unix
// time for Stud.IP, but the engine only ever compares it with `>`), and `ref` is
// provider-internal data passed back to downloadFile().

const fs = require("fs");
const path = require("path");
const { keyDigest } = require("../util/redact");

// --- path helpers ------------------------------------------------------------

function sanitizePathSegment(segment) {
  return String(segment).replace(/[\/\\:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim();
}

// A raw remote path turned into the course-relative on-disk key.
function sanitizeKey(rawPath) {
  return rawPath.split('/').map(sanitizePathSegment).join('/');
}

// --- manifest ----------------------------------------------------------------

// The course-relative posix path that identifies a manifest entry. Prefers the
// stored `path`; falls back to a legacy `localPath` (minus its course-dir prefix).
function manifestKey(entry) {
  if (entry.path) return entry.path;
  if (entry.localPath) return entry.localPath.split(/[\\/]/).slice(1).join('/');
  return '';
}

async function readManifest(courseDir) {
  try {
    const parsed = JSON.parse(await fs.promises.readFile(path.join(courseDir, 'manifest.json'), 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function writeManifest(courseDir, entries) {
  await fs.promises.mkdir(courseDir, { recursive: true });
  await fs.promises.writeFile(path.join(courseDir, 'manifest.json'), JSON.stringify(entries, null, 2), 'utf8');
}

// --- local filesystem --------------------------------------------------------

async function walkDir(dir) {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walkDir(fullPath));
    } else if (entry.name !== 'manifest.json') {
      files.push(fullPath);
    }
  }
  return files;
}

// Collect every subfolder as a course-relative posix path (e.g. "lecture/week1"),
// shallowest first so parents are always handled before their children.
async function collectLocalFolders(dir, relParts = []) {
  const folders = [];
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const parts = [...relParts, entry.name];
    folders.push(parts.join('/'));
    folders.push(...await collectLocalFolders(path.join(dir, entry.name), parts));
  }
  return folders;
}

// Find a free "<name>.conflicted" path so a conflicting local copy never clobbers
// an existing file.
function uniqueConflictedPath(absPath) {
  let candidate = `${absPath}.conflicted`;
  let counter = 2;
  while (fs.existsSync(candidate)) candidate = `${absPath}.conflicted-${counter++}`;
  return candidate;
}

// --- planning ----------------------------------------------------------------

// Pure three-way comparison: given the current remote files, current local files,
// and the last-synced baseline (manifest), decide one action per file. No I/O here
// so the logic can be reasoned about and tested in isolation.
//
// For each file we look at three states — local, remote, baseline — and detect
// whether each side changed since the baseline:
//   - local changed:   on-disk mtime is newer than the last sync (or size differs)
//   - remote changed:  the remote version timestamp is newer than the one recorded
function computeSyncPlan({ remoteFiles, localFiles, baseline, folderMap, courseDir }) {
  const items = new Map();
  const itemFor = (key) => {
    if (!items.has(key)) items.set(key, { key, remote: null, local: null, base: null });
    return items.get(key);
  };

  // Key every file by its course-relative on-disk path so the three views line up.
  for (const remote of remoteFiles) itemFor(sanitizeKey(remote.path)).remote = remote;
  for (const local of localFiles) itemFor(local.key).local = local;
  for (const base of baseline) itemFor(base.key).base = base;

  // Resolve the remote folder a file belongs in from its parent path. Undefined when
  // that folder doesn't exist remotely (e.g. couldn't be created for lack of
  // permission), which the executor treats as "skip this upload".
  const folderIdFor = (key) => {
    const parent = key.includes('/') ? key.slice(0, key.lastIndexOf('/')) : '';
    return folderMap.get(parent);
  };
  const absFor = (key) => path.join(courseDir, ...key.split('/'));

  const operations = [];
  // Log real work only — noops would flood the journal on every sync of a big course.
  // Never the key itself: an upload is stored as "Nachname_Vorname__titel.pdf", so the
  // key is a pupil's name, and the journal lives outside the encrypted vault (see
  // util/redact.js). The digest is enough to follow one file through a single run.
  const record = (op) => {
    if (op.type !== 'noop') console.log(`[sync:plan]   ${keyDigest(op.key)} -> ${op.type}`);
    operations.push(op);
  };
  for (const { key, remote, local, base } of items.values()) {
    const folderId = (remote && remote.folderId) || (base && base.folderId) || folderIdFor(key);
    const fileName = (local && local.fileName) || (remote && remote.name) || path.basename(key);
    const localAbsPath = local ? local.absPath : absFor(key);

    if (base) {
      const localChanged = !!local && (local.mtime > base.syncedAt
        || (base.baselineSize != null && local.size !== base.baselineSize));
      const remoteChanged = !!remote && remote.timestamp > base.baselineTimestamp;

      if (local && remote) {
        if (localChanged && remoteChanged) record({ type: 'conflict', key, localAbsPath, remote, folderId, fileName });
        else if (localChanged) record({ type: 'upload', key, localAbsPath, folderId, fileName, oldRemoteFileId: remote.id });
        else if (remoteChanged) record({ type: 'download', key, localAbsPath, remote, folderId, fileName });
        else record({ type: 'noop', key, base });
      } else if (local && !remote) {
        // Deleted remotely since last sync. A local edit wins (restore it remotely);
        // otherwise the deletion propagates to the local copy.
        if (localChanged) record({ type: 'upload', key, localAbsPath, folderId, fileName, oldRemoteFileId: null });
        else record({ type: 'deleteLocal', key, localAbsPath });
      } else if (!local && remote) {
        // Deleted locally since last sync. A remote edit wins (restore it locally);
        // otherwise the deletion propagates to the remote.
        if (remoteChanged) record({ type: 'download', key, localAbsPath, remote, folderId, fileName });
        else record({ type: 'deleteRemote', key, remoteFileId: remote.id });
      } else {
        // Gone on both ends — just drop the stale baseline entry.
        record({ type: 'dropBaseline', key });
      }
    } else if (local && remote) {
      // New on both sides with no shared history. Identical size ⇒ adopt as-is,
      // otherwise treat as a conflict.
      if (local.size === remote.size) record({ type: 'adopt', key, localAbsPath, remote, folderId, fileName });
      else record({ type: 'conflict', key, localAbsPath, remote, folderId, fileName });
    } else if (local) {
      record({ type: 'upload', key, localAbsPath, folderId, fileName, oldRemoteFileId: null });
    } else if (remote) {
      record({ type: 'download', key, localAbsPath, remote, folderId, fileName });
    }
  }
  // Counts per operation type carry everything the log is actually read for — how
  // much work a run found, and of what kind — without naming a single file.
  const counts = {};
  for (const op of operations) counts[op.type] = (counts[op.type] || 0) + 1;
  const breakdown = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([type, n]) => `${type}=${n}`)
    .join(' ');
  console.log(`[sync:plan] ${operations.length} operation(s) planned${breakdown ? ` (${breakdown})` : ''}`);
  return operations;
}

// --- execution ---------------------------------------------------------------

async function runSync({ provider, ctx, courseId, courseDir }) {
  console.log(`[sync:plan] starting sync for ${provider.name} course ${courseId}`);
  await fs.promises.mkdir(courseDir, { recursive: true });

  // Gather remote state: files plus a map of every existing remote folder path → id.
  const tree = await provider.listTree(ctx, courseId);
  const folderMap = new Map();
  for (const folder of tree.folders) folderMap.set(sanitizeKey(folder.path), folder.id);
  const rootFolderId = tree.rootFolderId ?? folderMap.get('');
  if (!rootFolderId) throw new Error('Could not determine root folder for course');
  folderMap.set('', rootFolderId);
  const remoteFiles = tree.files;

  const nowSec = Math.trunc(Date.now() / 1000);
  const newManifest = [];
  const folderManifest = [];
  const summary = {
    downloaded: [], uploaded: [], deletedLocal: [], deletedRemote: [], conflicts: [], skipped: [],
    foldersCreatedLocal: [], foldersCreatedRemote: [], foldersDeletedLocal: [], foldersDeletedRemote: [],
    foldersSkipped: [], unchanged: 0,
  };

  // Cache permission lookups for the duration of one sync run.
  const memo = (fn) => { const cache = new Map(); return (id) => { if (!cache.has(id)) cache.set(id, fn(id)); return cache.get(id); }; };
  const canWriteFile = memo((id) => provider.canWriteFile(ctx, id));
  const canCreateInFolder = memo((id) => provider.canCreateInFolder(ctx, id));
  const canDeleteFolder = memo((id) => provider.canDeleteFolder(ctx, id));

  // Read the baseline and split it: file entries feed the file planner; folder entries
  // tell a brand-new folder apart from one that was deleted on one side.
  const rawManifest = await readManifest(courseDir);
  const folderBaseline = new Map(
    rawManifest.filter((e) => e.type === 'folder').map((e) => [manifestKey(e), e])
  );

  // --- Reconcile folder structure before files, so every file has a parent to land in ---
  const folderEntry = (key, folderId) => ({ type: 'folder', folderId, path: key });
  const folderDepth = (key) => key.split('/').length;

  const remoteFolderKeys = new Set([...folderMap.keys()].filter((k) => k !== ''));
  const localFolderKeys = new Set(await collectLocalFolders(courseDir));
  const allFolderKeys = new Set([...remoteFolderKeys, ...localFolderKeys, ...folderBaseline.keys()]);

  const blockedFolders = new Set();
  const deleteLocalFolders = [];   // existed before, now gone on the remote → remove locally
  const deleteRemoteFolders = [];  // existed before, now gone locally → remove on the remote

  // Creation pass, shallowest-first so a parent exists before its children.
  for (const key of [...allFolderKeys].sort((a, b) => folderDepth(a) - folderDepth(b))) {
    const local = localFolderKeys.has(key);
    const remote = folderMap.has(key);
    const base = folderBaseline.has(key);
    const absDir = path.join(courseDir, ...key.split('/'));

    if (local && remote) {
      folderManifest.push(folderEntry(key, folderMap.get(key)));
    } else if (remote && !local) {
      if (base) {
        deleteRemoteFolders.push({ key });                    // gone locally → delete on the remote
      } else {
        await fs.promises.mkdir(absDir, { recursive: true }); // new on the remote → create locally
        summary.foldersCreatedLocal.push(key);
        folderManifest.push(folderEntry(key, folderMap.get(key)));
      }
    } else if (local && !remote) {
      if (base) {
        deleteLocalFolders.push({ key, absDir });             // gone on the remote → delete locally
      } else {
        // New local folder → create it on the remote where permitted.
        const parentKey = key.includes('/') ? key.slice(0, key.lastIndexOf('/')) : '';
        const parentId = folderMap.get(parentKey);
        const folderName = key.slice(key.lastIndexOf('/') + 1);
        if (!parentId || blockedFolders.has(parentKey) || !(await canCreateInFolder(parentId))) {
          blockedFolders.add(key);
          summary.foldersSkipped.push(key);
        } else {
          try {
            const created = await provider.createFolder(ctx, parentId, folderName);
            if (!created?.id) throw new Error('no folder id in response');
            folderMap.set(key, created.id);
            summary.foldersCreatedRemote.push(key);
            folderManifest.push(folderEntry(key, created.id));
          } catch (err) {
            console.error(`Failed to create remote folder ${keyDigest(key)}:`, err.message);
            blockedFolders.add(key);
            summary.foldersSkipped.push(key);
          }
        }
      }
    }
    // !local && !remote (baseline only) → gone on both ends, drop the stale entry.
  }

  // Gather local files and the file baseline.
  const localFiles = [];
  for (const absPath of await walkDir(courseDir)) {
    const stat = await fs.promises.stat(absPath);
    localFiles.push({
      key: path.relative(courseDir, absPath).split(path.sep).join('/'),
      absPath,
      fileName: path.basename(absPath),
      mtime: Math.trunc(stat.mtimeMs / 1000),
      size: stat.size,
    });
  }
  const baseline = rawManifest.filter((e) => e.type !== 'folder').map((e) => ({
    ...e,
    key: manifestKey(e),
    syncedAt: Number(e.syncedAt ?? e.downloadedAt) || 0,
    baselineSize: e.baselineSize ?? e.fileSize ?? null,
    baselineTimestamp: Number(e.baselineTimestamp ?? e.baselineRemoteChdate ?? e.downloadedAt) || 0,
  }));
  const operations = computeSyncPlan({ remoteFiles, localFiles, baseline, folderMap, courseDir });
  // Build a fresh baseline entry describing the post-sync state of one file.
  // syncedAt records the file's own mtime (not wall-clock now) so the next sync's
  // "local changed?" check only fires when the user actually edits the file.
  async function baselineEntry({ fileId, folderId, key, absPath, timestamp }) {
    const stat = await fs.promises.stat(absPath);
    return {
      fileId,
      folderId,
      path: key,
      syncedAt: Math.trunc(stat.mtimeMs / 1000),
      baselineSize: stat.size,
      baselineTimestamp: Number(timestamp) || nowSec,
    };
  }

  for (const op of operations) {
    switch (op.type) {
      case 'noop': {
        // Carry the baseline forward, rebuilt cleanly (drops the transient join key and
        // any legacy fields an older manifest may have carried).
        const b = op.base;
        newManifest.push({
          fileId: b.fileId,
          folderId: b.folderId,
          path: b.key,
          syncedAt: b.syncedAt,
          baselineSize: b.baselineSize,
          baselineTimestamp: b.baselineTimestamp,
        });
        summary.unchanged++;
        break;
      }

      case 'download': {
        await fs.promises.mkdir(path.dirname(op.localAbsPath), { recursive: true });
        await provider.downloadFile(ctx, op.remote, op.localAbsPath);
        newManifest.push(await baselineEntry({
          fileId: op.remote.id, folderId: op.folderId, key: op.key,
          absPath: op.localAbsPath, timestamp: op.remote.timestamp,
        }));
        summary.downloaded.push(op.key);
        break;
      }

      case 'upload': {
        // Parent folder couldn't be created on the remote (no permission) — keep the
        // file local-only and carry any existing baseline forward.
        if (!op.folderId) {
          const prev = baseline.find((b) => b.key === op.key);
          if (prev) newManifest.push(prev);
          summary.skipped.push(op.key);
          break;
        }
        // Only an overwrite needs a write-permission check; brand-new uploads don't.
        if (op.oldRemoteFileId && !(await canWriteFile(op.oldRemoteFileId))) {
          const prev = baseline.find((b) => b.key === op.key);
          if (prev) newManifest.push(prev);
          summary.skipped.push(op.key);
          break;
        }
        // Delete the old ref *before* uploading: some backends disambiguate a colliding
        // display name (e.g. "name[1]") if both exist at once.
        if (op.oldRemoteFileId) await provider.deleteFile(ctx, op.oldRemoteFileId);
        const uploaded = await provider.uploadFile(ctx, op.folderId, op.localAbsPath, op.fileName);
        newManifest.push(await baselineEntry({
          fileId: uploaded.id, folderId: op.folderId, key: op.key,
          absPath: op.localAbsPath, timestamp: uploaded.timestamp,
        }));
        summary.uploaded.push(op.key);
        break;
      }

      case 'deleteLocal':
        await fs.promises.rm(op.localAbsPath, { force: true });
        summary.deletedLocal.push(op.key);
        break;

      case 'deleteRemote':
        await provider.deleteFile(ctx, op.remoteFileId);
        summary.deletedRemote.push(op.key);
        break;

      case 'dropBaseline':
        break;

      case 'adopt':
        newManifest.push(await baselineEntry({
          fileId: op.remote.id, folderId: op.folderId, key: op.key,
          absPath: op.localAbsPath, timestamp: op.remote.timestamp,
        }));
        summary.unchanged++;
        break;

      case 'conflict': {
        // Preserve the local version under "<name>.conflicted", bring the remote
        // version down under the canonical name, then push the conflicted copy back
        // up so both versions exist on both ends.
        const conflictedAbs = uniqueConflictedPath(op.localAbsPath);
        await fs.promises.rename(op.localAbsPath, conflictedAbs);

        await fs.promises.mkdir(path.dirname(op.localAbsPath), { recursive: true });
        await provider.downloadFile(ctx, op.remote, op.localAbsPath);

        const conflictedName = path.basename(conflictedAbs);
        const conflictedUpload = await provider.uploadFile(ctx, op.folderId, conflictedAbs, conflictedName);

        newManifest.push(await baselineEntry({
          fileId: op.remote.id, folderId: op.folderId, key: op.key,
          absPath: op.localAbsPath, timestamp: op.remote.timestamp,
        }));
        const conflictedKey = path.relative(courseDir, conflictedAbs).split(path.sep).join('/');
        newManifest.push(await baselineEntry({
          fileId: conflictedUpload.id, folderId: op.folderId, key: conflictedKey,
          absPath: conflictedAbs, timestamp: conflictedUpload.timestamp,
        }));
        summary.conflicts.push({ file: op.key, conflictedCopy: conflictedKey });
        break;
      }
    }
  }

  // --- Propagate folder deletions after files, deepest-first, and only when the
  //     surviving side is now empty (never destroy a folder that still holds anything) ---
  const deepestFirst = (a, b) => folderDepth(b.key) - folderDepth(a.key);

  // Folder gone on the remote → remove the local directory if nothing remains in it.
  for (const { key, absDir } of deleteLocalFolders.sort(deepestFirst)) {
    const remaining = await fs.promises.readdir(absDir).catch(() => []);
    if (remaining.length === 0) {
      await fs.promises.rmdir(absDir).catch(() => {});
      summary.foldersDeletedLocal.push(key);
    } else {
      summary.foldersSkipped.push(key);
      folderManifest.push(folderEntry(key, folderBaseline.get(key)?.folderId));
    }
  }

  // Folder gone locally → remove it on the remote if it's empty there and we're permitted.
  for (const { key } of deleteRemoteFolders.sort(deepestFirst)) {
    const folderId = folderMap.get(key) ?? folderBaseline.get(key)?.folderId;
    const empty = await provider.isFolderEmpty(ctx, folderId);

    if (empty && await canDeleteFolder(folderId)) {
      try {
        await provider.deleteFolder(ctx, folderId);
        folderMap.delete(key);
        summary.foldersDeletedRemote.push(key);
      } catch (err) {
        console.error(`Failed to delete remote folder ${keyDigest(key)}:`, err.message);
        summary.foldersSkipped.push(key);
        folderManifest.push(folderEntry(key, folderId));
      }
    } else {
      summary.foldersSkipped.push(key);
      folderManifest.push(folderEntry(key, folderId));
    }
  }

  await writeManifest(courseDir, [...newManifest, ...folderManifest]);
  console.log(`[sync:plan] finished sync for ${provider.name} course ${courseId}`);
  return summary;
}

module.exports = { runSync, computeSyncPlan, sanitizePathSegment };

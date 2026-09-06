// Builds the on-disk filename for an uploaded file, baking the uploader's name in
// front of the original name. The submissions log (src/upload/submissions.js) is
// the authoritative record; this name is for at-a-glance recognition.
//
//   ("Max", "Müller", "report final.pdf")  ->  "Müller_Max__report final.pdf"
//
// On collision (same uploader, same original name — i.e. a re-upload) the name is
// auto-versioned: "..__2.pdf", "..__3.pdf", and so on. The collision check reads
// the destination directory, so callers must serialise placement per session (see
// withSessionLock) to avoid two concurrent uploads racing onto the same name.

const fs = require("fs");
const path = require("path");
const { sanitizePathSegment } = require("../sync/engine");

// A filename that is safe to place in destDir and does not overwrite anything there.
// Strips path separators and the characters Windows rejects (sanitizePathSegment), then
// versions on collision: "report.pdf", "report__2.pdf", …
//
// The caller must serialise placement against other writers to the same folder — the
// check and the write are separate steps, so two concurrent uploads could otherwise
// settle on the same name.
function uniqueName(destDir, desiredName) {
  const safe = sanitizePathSegment(desiredName) || "file";
  const ext = path.extname(safe);
  const base = path.basename(safe, ext) || "file";

  let candidate = `${base}${ext}`;
  let n = 2;
  while (fs.existsSync(path.join(destDir, candidate))) {
    candidate = `${base}__${n++}${ext}`;
  }
  return candidate;
}

function buildStoredName(firstName, lastName, originalName, destDir) {
  const last = sanitizePathSegment(lastName) || "Unknown";
  const first = sanitizePathSegment(firstName) || "Unknown";
  const safeOriginal = sanitizePathSegment(originalName) || "file";
  const ext = path.extname(safeOriginal);
  const base = path.basename(safeOriginal, ext) || "file";
  return uniqueName(destDir, `${last}_${first}__${base}${ext}`);
}

module.exports = { buildStoredName, uniqueName };

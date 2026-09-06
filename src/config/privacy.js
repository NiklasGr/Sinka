// The Art. 13 GDPR notice shown to students at the moment they hand over their data.
//
// Art. 13 requires the information AT COLLECTION TIME — it cannot be supplied later or
// kept somewhere the student never goes. The only page students ever see is the upload
// page, so the notice belongs there (and, for the offline case, on the classroom poster).
// Recital 58 additionally requires language a child can understand, which is why the
// page carries a short plain-language summary above the full text.
//
// Everything here is derived, not stored: the controller's identity and contact come
// from runtime settings (they name the school), the retention period from RETENTION_DAYS,
// and the recipients from how the session is actually configured. Nothing is invented —
// if a value is not configured, the notice says so rather than showing a placeholder that
// reads like a real answer.

const path = require("path");
const { readRegistry } = require("../sync/registry");

// Is this session's target inside a folder that gets synced to Stud.IP / IServ? If so
// the platform is a recipient of the submitted files and has to be named as one.
function syncTargetFor(targetDir) {
  if (!targetDir) return null;
  const target = path.resolve(targetDir);
  for (const entry of readRegistry()) {
    if (!entry.localPath) continue;
    const root = path.resolve(entry.localPath);
    if (target === root || target.startsWith(root + path.sep)) {
      return { provider: entry.provider, courseName: entry.courseName };
    }
  }
  return null;
}

const PROVIDER_LABELS = { studip: "Stud.IP", iserv: "IServ" };

// Build the notice for one upload session. `session` may be null (the page is being
// rendered for a closed or unknown link, where nothing is collected).
function noticeFor(session) {
  const controller = (process.env.PRIVACY_CONTROLLER || "").trim();
  const contact = (process.env.PRIVACY_CONTACT || "").trim();
  const retentionRaw = (process.env.RETENTION_DAYS || "").trim();
  const retentionDays = /^\d+$/.test(retentionRaw) ? Number(retentionRaw) : null;

  const sync = session ? syncTargetFor(session.targetDir) : null;

  const recipients = [
    "die Lehrkraft, die diese Abgabe eingesammelt hat",
  ];
  if (sync) {
    const label = PROVIDER_LABELS[sync.provider] || sync.provider;
    recipients.push(`${label} — die Dateien werden in den Kursordner der Schulplattform übertragen`);
  }

  return {
    controller: controller || null,
    contact: contact || null,
    retentionDays,
    recipients,
    // The two items Art. 13 Abs. 1 lit. a and b make mandatory. The upload page shows a
    // visible gap when either is missing, and the admin UI warns about it.
    complete: Boolean(controller && contact),
  };
}

module.exports = { noticeFor };

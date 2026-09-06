// Redaction helpers for anything that reaches a log sink.
//
// Log output leaves the encrypted vault. systemd writes it to the journal under
// /var/log/journal on the unencrypted SD card, where the retention job does not
// reach it and a Hard Reset does not remove it — so a name written to a log line
// outlives every deletion path the app offers, and is readable in plaintext if the
// device is lost. Nothing that identifies a pupil may therefore be interpolated
// into a console.* call.
//
// Two things used to leak: sync keys (uploads are stored as
// "Nachname_Vorname__titel.pdf", so the key *is* the name) and visitor IPs.
// Use keyDigest() and maskIp() for those. These are for LOGGING ONLY — rate
// limiters and lockouts must keep keying on the full address, or truncation would
// pool a whole /24 into one bucket.

const crypto = require("crypto");

// Per-process salt. Digests stay stable for the lifetime of one server run — long
// enough to follow a single file through one sync — and become meaningless after a
// restart. The salt matters because the input space is tiny: an unsalted digest of
// a name taken from a known class list is brute-forceable in milliseconds.
const DIGEST_SALT = crypto.randomBytes(16);

// Short, non-reversible stand-in for a file key or path.
function keyDigest(key) {
  const digest = crypto
    .createHash("sha256")
    .update(DIGEST_SALT)
    .update(String(key ?? ""))
    .digest("hex");
  return `#${digest.slice(0, 8)}`;
}

// Truncate an address so it still groups requests coming from one source without
// identifying a household connection: IPv4 loses its final octet, IPv6 keeps only
// the leading groups. Returns "unknown" for anything unparseable rather than
// falling back to the raw value.
function maskIp(ip) {
  const raw = String(ip ?? "").trim();
  if (!raw) return "unknown";

  // "::ffff:192.0.2.7" is an IPv4 address in IPv6 clothing — unwrap it first.
  const mapped = raw.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  const candidate = mapped ? mapped[1] : raw;

  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(candidate)) {
    return `${candidate.split(".").slice(0, 3).join(".")}.x`;
  }

  if (candidate.includes(":")) {
    // Keep at most the first three groups. An empty group means we hit the "::"
    // compression, so the prefix simply ends there.
    const head = [];
    for (const group of candidate.toLowerCase().split(":")) {
      if (head.length === 3 || group === "") break;
      head.push(group);
    }
    return head.length ? `${head.join(":")}:x` : "unknown";
  }

  return "unknown";
}

module.exports = { keyDigest, maskIp };

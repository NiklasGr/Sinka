#!/usr/bin/env bash
#
# First-time setup for Sinka: creates .env interactively so the server can start.
#
#   bash scripts/install.sh
#
# Covers:
#   - admin account (username + password -> scrypt hash; the password is NEVER stored)
#   - SESSION_ENCRYPTION_KEY (random; encrypts stored provider credentials)
#   - encryption-at-rest vault (gocryptfs)
#   - optional StudIP / IServ provider configuration
#
# The vault passphrase MUST equal the admin login password: the app unlocks the vault
# by piping the login password to the unlock command. The gocryptfs path below handles
# that automatically.
#
# Secrets are handled carefully: passwords are read without echo and passed to helpers
# via stdin/environment (never argv, which is world-readable in /proc), and .env is
# written with mode 600.

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$PROJECT_DIR/.env"

say()  { printf '%s\n' "$*"; }
bold() { printf '\033[1m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*"; }

# ask VAR "Prompt" "default"
ask() {
  local -n out=$1
  local prompt=$2 def=${3-}
  if [ -n "$def" ]; then
    read -r -p "$prompt [$def]: " out
    out=${out:-$def}
  else
    read -r -p "$prompt: " out
  fi
}

# ask_https_url VAR "Prompt" [default] — like ask(), but keeps asking until the answer
# is an https:// URL. Blank is still accepted (the setting stays unconfigured); plain
# http is not. index.js refuses to start when any provider or public URL is not https,
# so rejecting it here avoids handing over a finished install that cannot boot.
ask_https_url() {
  local -n url_out=$1
  local prompt=$2 def=${3-}
  while true; do
    if [ -n "$def" ]; then
      read -r -p "$prompt [$def]: " url_out
      url_out=${url_out:-$def}
    else
      read -r -p "$prompt: " url_out
    fi
    [ -z "$url_out" ] && return 0
    # Case-insensitive scheme, matching what the server's URL parser accepts.
    if [[ $url_out =~ ^[Hh][Tt][Tt][Pp][Ss]://[^/[:space:]]+ ]]; then
      return 0
    fi
    if [[ $url_out =~ ^[Hh][Tt][Tt][Pp]:// ]]; then
      warn "Only https:// is accepted — credentials and pupil data must not travel in cleartext."
    else
      warn "Please enter a full URL starting with https:// (for example https://example.org)."
    fi
  done
}

# ask_yn "Prompt" default(y|n) -> returns 0 for yes
ask_yn() {
  local prompt=$1 def=$2 reply
  read -r -p "$prompt [$( [ "$def" = y ] && echo Y/n || echo y/N )]: " reply
  reply=${reply:-$def}
  [[ $reply =~ ^[Yy] ]]
}

# ask_secret VAR "Prompt" — no echo, no default
ask_secret() {
  local -n out=$1
  read -rs -p "$2: " out
  printf '\n'
}

bold "Sinka first-time setup"
say  "Project: $PROJECT_DIR"
say

# --- prerequisites -------------------------------------------------------------

command -v node >/dev/null || { warn "node is required but not installed. Install Node.js first."; exit 1; }

if [ ! -d "$PROJECT_DIR/node_modules" ]; then
  if ask_yn "Dependencies (node_modules) are missing. Run 'npm install' now?" y; then
    (cd "$PROJECT_DIR" && npm install)
  else
    warn "Remember to run 'npm install' before starting the server."
  fi
fi

if [ -f "$ENV_FILE" ]; then
  warn "$ENV_FILE already exists."
  if ask_yn "Overwrite it? (a timestamped backup will be kept)" n; then
    backup="$ENV_FILE.bak.$(date +%Y%m%d-%H%M%S)"
    cp "$ENV_FILE" "$backup"
    chmod 600 "$backup"
    say "Backed up to $backup"
  else
    say "Aborted; existing configuration untouched."
    exit 0
  fi
fi

# --- 1. admin account ----------------------------------------------------------

say
bold "1) Admin account"
say "One administrator guards every page and API route."

ask ADMIN_USERNAME "Admin username" "admin"

while :; do
  ask_secret ADMIN_PASSWORD "Admin password (also unlocks the vault)"
  if [ -z "$ADMIN_PASSWORD" ]; then warn "Password must not be empty."; continue; fi
  if [ "${#ADMIN_PASSWORD}" -lt 8 ]; then
    warn "Warning: shorter than 8 characters — this password protects pupil data."
    ask_yn "Use it anyway?" n || continue
  fi
  ask_secret ADMIN_PASSWORD2 "Repeat password"
  [ "$ADMIN_PASSWORD" = "$ADMIN_PASSWORD2" ] && break
  warn "Passwords do not match, try again."
done
unset ADMIN_PASSWORD2

# scrypt hash, password via stdin so it never appears on a command line.
ADMIN_PASSWORD_HASH=$(printf '%s' "$ADMIN_PASSWORD" | node -e '
  const crypto = require("crypto");
  let d = "";
  process.stdin.on("data", (c) => (d += c)).on("end", () => {
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(d, salt, 32);
    console.log(`scrypt$${salt.toString("hex")}$${hash.toString("hex")}`);
  });
')

# --- 2. session encryption key ---------------------------------------------------

# Encrypts stored provider credentials at rest; must stay stable across restarts.
# (The session-cookie signing secret is NOT configured here — the server generates a
# fresh one on every start.)
SESSION_ENCRYPTION_KEY=$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')
say
bold "2) Session encryption key"
say "Generated a random SESSION_ENCRYPTION_KEY."

# --- 3. public base URL ----------------------------------------------------------

say
bold "3) Public base URL"
say "Absolute URL students reach the server on (your Cloudflare tunnel hostname)."
say "Leave blank to derive it from each request."
ask_https_url PUBLIC_BASE_URL "Public base URL (e.g. https://sinka.example.org)" ""

# --- 4. vault (encryption at rest) ----------------------------------------------

say
bold "4) Encryption at rest (vault)"
say "Pupil data (uploads, submission logs, sync folders, review notes) lives in a"
say "filesystem-encrypted vault unlocked by the admin login."
say

SINKA_VAULT_MOUNT=""
SINKA_VAULT_CIPHER=""
SINKA_UNLOCK_CMD=""
SINKA_LOCK_CMD=""


command -v gocryptfs >/dev/null || {
  warn "gocryptfs is not installed."
  if ask_yn "Install it now via 'sudo apt-get install gocryptfs'?" y; then
    sudo apt-get update && sudo apt-get install -y gocryptfs
  else
    warn "Install gocryptfs and re-run this script."; exit 1
  fi
}

ask SINKA_VAULT_CIPHER "Ciphertext directory" "$HOME/.sinka-vault.cipher"
ask SINKA_VAULT_MOUNT  "Plaintext mountpoint" "$HOME/sinka-vault"

if [ -e "$SINKA_VAULT_CIPHER/gocryptfs.conf" ]; then
  say "Existing gocryptfs vault found at $SINKA_VAULT_CIPHER — keeping it."
  warn "Its passphrase must equal the admin password entered above."
else
  mkdir -p "$SINKA_VAULT_CIPHER"
  chmod 700 "$SINKA_VAULT_CIPHER"
  say "gocryptfs can use AES-GCM or XChaCha20-Poly1305 file encryption. AES-GCM being much slower without hardware acceleration."
  ask GOCRYPTFS_ALGORITHM "Use AES-GCM [1] or XChaCha20-Poly1305 [2]" "2"
  say "Initialising the vault (passphrase = your admin password)…"
  # Passphrase via environment + -extpass, never argv.
  export SINKA_INSTALL_PW="$ADMIN_PASSWORD"
  if [ $GOCRYPTFS_ALGORITHM -eq 2 ]; then
    gocryptfs -init -xchacha -extpass printenv -extpass SINKA_INSTALL_PW "$SINKA_VAULT_CIPHER"
  else
    gocryptfs -init -extpass printenv -extpass SINKA_INSTALL_PW "$SINKA_VAULT_CIPHER"
  fi
  unset SINKA_INSTALL_PW
  warn "gocryptfs printed a MASTER KEY above — write it down and store it OFFLINE."
  warn "It is the only way to recover the data if the password is lost."
fi
mkdir -p "$SINKA_VAULT_MOUNT"

# -allow_other (used by the unlock script) needs user_allow_other in fuse.conf.
if ! grep -qs '^[[:space:]]*user_allow_other' /etc/fuse.conf; then
  if ask_yn "Enable 'user_allow_other' in /etc/fuse.conf (needed for the mount; sudo)?" y; then
    echo user_allow_other | sudo tee -a /etc/fuse.conf >/dev/null
  else
    warn "Without it, unlocking will fail. Add 'user_allow_other' to /etc/fuse.conf later."
  fi
fi

SINKA_UNLOCK_CMD="$PROJECT_DIR/deploy/sinka-unlock-gocryptfs"
SINKA_LOCK_CMD="$PROJECT_DIR/deploy/sinka-lock-gocryptfs"

unset ADMIN_PASSWORD

# --- 5. providers (optional) ------------------------------------------------------

say
bold "5) StudIP (optional)"
STUDIP_BASE_URL=""; STUDIP_CONSUMER_KEY=""; STUDIP_CONSUMER_SECRET=""
if ask_yn "Configure StudIP sync now?" n; then
  ask_https_url STUDIP_BASE_URL "StudIP base URL (e.g. https://studip.example.org/studip)"
  ask STUDIP_CONSUMER_KEY   "OAuth consumer key"
  ask STUDIP_CONSUMER_SECRET "OAuth consumer secret"
fi

say
bold "6) IServ (optional)"
ISERV_WEBDAV_URL=""
if ask_yn "Configure IServ sync now?" n; then
  ask_https_url ISERV_WEBDAV_URL "IServ WebDAV URL (e.g. https://webdav.example.org)"
fi

# --- write .env --------------------------------------------------------------------

umask 177
{
  echo "# Sinka configuration — generated by scripts/install.sh on $(date -Iseconds)"
  echo "# The admin password itself is NOT stored, only its scrypt hash."
  echo "SESSION_ENCRYPTION_KEY=\"$SESSION_ENCRYPTION_KEY\""
  echo "ADMIN_USERNAME=\"$ADMIN_USERNAME\""
  echo "ADMIN_PASSWORD_HASH=\"$ADMIN_PASSWORD_HASH\""
  [ -n "$PUBLIC_BASE_URL" ] && echo "PUBLIC_BASE_URL=\"$PUBLIC_BASE_URL\"" || echo "# PUBLIC_BASE_URL=\"https://your-host\""
  echo
  echo "# Encryption-at-rest vault"
  if [ -n "$SINKA_VAULT_MOUNT" ]; then
    echo "SINKA_VAULT_MOUNT=\"$SINKA_VAULT_MOUNT\""
    echo "SINKA_UNLOCK_CMD=\"$SINKA_UNLOCK_CMD\""
    echo "SINKA_LOCK_CMD=\"$SINKA_LOCK_CMD\""
    [ -n "$SINKA_VAULT_CIPHER" ] && echo "SINKA_VAULT_CIPHER=\"$SINKA_VAULT_CIPHER\""
  else
    echo "# SINKA_VAULT_MOUNT=  # unset: DEV MODE, data is unencrypted"
  fi
  echo
  echo "# StudIP"
  if [ -n "$STUDIP_BASE_URL" ]; then
    echo "STUDIP_BASE_URL=\"$STUDIP_BASE_URL\""
    echo "STUDIP_CONSUMER_KEY=\"$STUDIP_CONSUMER_KEY\""
    echo "STUDIP_CONSUMER_SECRET=\"$STUDIP_CONSUMER_SECRET\""
  else
    echo "# STUDIP_BASE_URL=\"https://studip.example.org/studip\""
    echo "# STUDIP_CONSUMER_KEY=\"\""
    echo "# STUDIP_CONSUMER_SECRET=\"\""
  fi
  echo
  echo "# IServ"
  if [ -n "$ISERV_WEBDAV_URL" ]; then
    echo "ISERV_WEBDAV_URL=\"$ISERV_WEBDAV_URL\""
  else
    echo "# ISERV_WEBDAV_URL=\"https://webdav.example.org\""
  fi
} > "$ENV_FILE"
chmod 600 "$ENV_FILE"

# --- done ---------------------------------------------------------------------------

say
bold "Setup complete — $ENV_FILE written (mode 600)."
say
say "Start the server:        node index.js"
say "Log in as:               $ADMIN_USERNAME  (logging in unlocks the vault)"
say
say "Recommended next steps:"
say "  - Autostart on boot: Edit the systemd unit file deploy/sinka.service and run the following command to enable it."
say "    sudo cp deploy/sinka.service /etc/systemd/system/ && sudo systemctl enable --now sinka"
say "  - Keep the gocryptfs master key offline; back up $SINKA_VAULT_CIPHER regularly (it is ciphertext)."
say
say "Provider URLs can be changed later in the web UI (settings) or by editing .env."

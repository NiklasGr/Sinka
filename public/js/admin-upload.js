// Admin-side upload session manager. Talks to /api/upload-sessions and reuses the
// existing /api/sync-registry to populate the target-folder dropdown.

const CUSTOM_TARGET = "__custom__";

let currentSessions = [];   // last loaded list, for dashboard lookups
let currentDashId = null;   // session currently shown in the dashboard
let customTargetDir = null; // folder chosen via the browser for the custom target
let folderBrowserPath = null; // directory currently shown in the folder browser

function setMessage(text, kind) {
  const el = document.getElementById("au-form-msg");
  el.textContent = text || "";
  el.className = "au-msg" + (kind ? " " + kind : "");
}

// --- target dropdown ---------------------------------------------------------

async function loadTargets() {
  const select = document.getElementById("au-target");
  try {
    const res = await fetch("/api/sync-registry");
    const data = await res.json();
    const entries = (data && data.entries) || [];
    select.innerHTML = "";
    for (const e of entries) {
      const opt = document.createElement("option");
      opt.value = e.localPath;
      opt.textContent = `${e.courseName} (${e.provider}) — ${e.localPath}`;
      opt.dataset.label = `${e.courseName} (${e.provider})`;
      select.appendChild(opt);
    }
    const custom = document.createElement("option");
    custom.value = CUSTOM_TARGET;
    custom.textContent = "Eigener Ordnerpfad…";
    select.appendChild(custom);
    if (!entries.length) select.value = CUSTOM_TARGET;
    toggleCustomPath();
  } catch {
    select.innerHTML = `<option value="${CUSTOM_TARGET}">Eigener Ordnerpfad…</option>`;
    toggleCustomPath();
  }
}

function toggleCustomPath() {
  const select = document.getElementById("au-target");
  const wrap = document.querySelector(".au-custom-path");
  wrap.style.display = select.value === CUSTOM_TARGET ? "flex" : "none";
}

// Returns { targetDir, targetLabel } from the current form selection, or null.
function resolveTarget() {
  const select = document.getElementById("au-target");
  if (select.value === CUSTOM_TARGET) {
    return customTargetDir ? { targetDir: customTargetDir, targetLabel: customTargetDir } : null;
  }
  if (!select.value) return null;
  const opt = select.selectedOptions[0];
  return { targetDir: select.value, targetLabel: opt ? opt.dataset.label : select.value };
}

// --- folder browser (for the custom target) ----------------------------------
// Like the sync folder browser, but any existing folder may be chosen — an upload
// target is typically a folder that already holds content (e.g. a synced course).

function openFolderBrowser() {
  document.getElementById("folder-browser").style.display = "flex";
  browseFolder(null);
}

function browseFolder(targetPath) {
  const url = targetPath ? `/api/fs/list?path=${encodeURIComponent(targetPath)}` : "/api/fs/list";
  fetch(url)
    .then((r) => (r.ok ? r.json() : r.json().then((e) => Promise.reject(new Error(e.error || "failed")))))
    .then((data) => {
      folderBrowserPath = data.path;
      document.getElementById("folder-browser-path").textContent = data.path;
      const list = document.getElementById("folder-browser-list");
      list.innerHTML = "";
      if (data.parent) {
        const up = document.createElement("li");
        up.textContent = "⬆ ..";
        up.onclick = () => browseFolder(data.parent);
        list.appendChild(up);
      }
      data.entries.forEach((entry) => {
        const li = document.createElement("li");
        li.textContent = "📁 " + entry.name;
        li.onclick = () => browseFolder(entry.path);
        list.appendChild(li);
      });
      document.getElementById("folder-browser-note").textContent = "";
    })
    .catch((err) => alert("Ordner kann nicht geöffnet werden: " + err.message));
}

function createFolderHere() {
  if (!folderBrowserPath) return;
  const name = prompt("Name des neuen Ordners:");
  if (!name) return;
  fetch("/api/fs/mkdir", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: folderBrowserPath, name }),
  })
    .then((r) => (r.ok ? r.json() : r.json().then((e) => Promise.reject(new Error(e.error || "failed")))))
    .then((data) => browseFolder(data.path))
    .catch((err) => alert("Ordner kann nicht erstellt werden: " + err.message));
}

function closeFolderBrowser() {
  document.getElementById("folder-browser").style.display = "none";
}

function confirmFolder() {
  if (!folderBrowserPath) return;
  customTargetDir = folderBrowserPath;
  document.getElementById("au-target-custom").textContent = folderBrowserPath;
  closeFolderBrowser();
}

// --- default new-session settings --------------------------------------------
// One "Save as defaults" button persists these form fields; they are pre-filled on load
// and re-applied after a session is created.

const DEFAULT_FIELDS = {
  allowedExt: "au-ext",
  durationMinutes: "au-duration",
  maxFileSizeMb: "au-maxsize",
  maxFilesPerUser: "au-maxfiles",
};

async function loadDefaults() {
  try {
    const res = await fetch("/api/upload-defaults");
    const d = await res.json();
    for (const [key, id] of Object.entries(DEFAULT_FIELDS)) {
      // Only override a field when a default was actually saved, so the built-in HTML
      // defaults (e.g. 120 min, 25 MB) survive when nothing is stored.
      if (d[key]) document.getElementById(id).value = d[key];
    }
  } catch {
    /* keep the built-in defaults if it can't be loaded */
  }
}

async function saveDefaults() {
  const body = {};
  for (const [key, id] of Object.entries(DEFAULT_FIELDS)) {
    body[key] = document.getElementById(id).value.trim();
  }
  try {
    const res = await fetch("/api/upload-defaults", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) return setMessage("Voreinstellungen konnten nicht gespeichert werden", "error");
    setMessage("Als Voreinstellung für neue Sitzungen gespeichert", "ok");
  } catch (err) {
    setMessage("Netzwerkfehler: " + err.message, "error");
  }
}

// --- create ------------------------------------------------------------------

async function createSession(event) {
  event.preventDefault();
  setMessage("");

  const target = resolveTarget();
  if (!target) return setMessage("Zielordner wählen oder eingeben", "error");

  const ext = document.getElementById("au-ext").value
    .split(",").map((s) => s.trim()).filter(Boolean);
  const maxFilesRaw = document.getElementById("au-maxfiles").value;

  const body = {
    name: document.getElementById("au-name").value.trim(),
    targetDir: target.targetDir,
    targetLabel: target.targetLabel,
    subfolder: document.getElementById("au-subfolder").value.trim(),
    durationMinutes: Number(document.getElementById("au-duration").value),
    maxFileSizeMb: Number(document.getElementById("au-maxsize").value),
    maxFilesPerUser: maxFilesRaw ? Number(maxFilesRaw) : null,
    allowedExt: ext,
  };

  try {
    const res = await fetch("/api/upload-sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) return setMessage(data.error || "Sitzung konnte nicht erstellt werden", "error");
    setMessage("Sitzung erstellt", "ok");
    document.getElementById("au-form").reset();
    loadDefaults(); // reset() clears the fields; re-fill them from the saved defaults
    customTargetDir = null;
    document.getElementById("au-target-custom").textContent = "Kein Ordner ausgewählt";
    toggleCustomPath();
    showReveal({ id: data.session.id, code: data.code, link: data.session.link });
    loadSessions();
  } catch (err) {
    setMessage("Netzwerkfehler: " + err.message, "error");
  }
}

// --- list --------------------------------------------------------------------

function fmtTime(unixSec) {
  return new Date(unixSec * 1000).toLocaleString("de-DE");
}

// German display names for session statuses (the CSS badge classes stay English).
const STATUS_DE = { open: "offen", closed: "geschlossen", expired: "abgelaufen" };

async function loadSessions() {
  const list = document.getElementById("au-list");
  try {
    const res = await fetch("/api/upload-sessions");
    const data = await res.json();
    const items = (data && data.sessions) || [];
    currentSessions = items;
    list.innerHTML = "";
    if (!items.length) {
      list.innerHTML = "<li>Noch keine Sitzungen.</li>";
      return;
    }
    for (const s of items) list.appendChild(renderSession(s));
  } catch (err) {
    list.innerHTML = `<li>Sitzungen konnten nicht geladen werden: ${err.message}</li>`;
  }
}

function renderSession(s) {
  const li = document.createElement("li");
  li.className = "au-item";

  const ext = s.allowedExt.length ? s.allowedExt.join(", ") : "alle";
  const sizeMb = s.maxFileSizeBytes ? Math.round(s.maxFileSizeBytes / (1024 * 1024)) : "?";
  const maxFiles = s.maxFilesPerUser || "unbegrenzt";

  li.innerHTML = `
    <div class="au-item__head">
      <span class="au-item__name"></span>
      <span class="au-badge ${s.status}">${STATUS_DE[s.status] || s.status}</span>
    </div>
    <div class="au-item__meta">
      Ziel: <span class="t-label"></span><br>
      Unterordner: <span class="t-sub"></span> ·
      Läuft ab: ${fmtTime(s.expiresAt)} ·
      Abgaben: ${s.submissionCount}<br>
      Erlaubt: ${ext} · Max. Größe: ${sizeMb} MB · Max./Person: ${maxFiles}
    </div>
    <div class="au-item__link"></div>
    <div class="au-item__actions"></div>
  `;
  li.querySelector(".au-item__name").textContent = s.name;
  li.querySelector(".t-label").textContent = s.targetLabel;
  li.querySelector(".t-sub").textContent = s.subfolder || "(Stammordner)";
  li.querySelector(".au-item__link").textContent = s.link;

  const actions = li.querySelector(".au-item__actions");
  actions.appendChild(button("Dashboard", () => showDashboard(s.id)));
  // Re-open the share popup: QR + link (no code — the code is one-time).
  actions.appendChild(button("Link & QR", () => showReveal({ id: s.id, link: s.link })));
  actions.appendChild(button("Link kopieren", () => copyText(s.link)));
  if (s.status === "open") {
    actions.appendChild(button("Schließen", () => closeSession(s.id)));
  }
  actions.appendChild(button("Code neu generieren", () => regenerateCode(s.id)));
  actions.appendChild(button("Löschen", () => deleteSession(s.id)));
  return li;
}

function button(label, onClick) {
  const b = document.createElement("button");
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

// --- actions -----------------------------------------------------------------

async function closeSession(id) {
  if (!confirm("Diese Sitzung schließen? Es werden dann keine Uploads mehr angenommen.")) return;
  await fetch(`/api/upload-sessions/${id}/close`, { method: "POST" });
  loadSessions();
}

async function regenerateCode(id) {
  if (!confirm("Neuen Code generieren? Der bisherige Code wird ungültig.")) return;
  const res = await fetch(`/api/upload-sessions/${id}/regenerate-code`, { method: "POST" });
  const data = await res.json();
  if (res.ok) {
    const s = currentSessions.find((x) => x.id === id);
    showReveal({ id, code: data.code, link: s ? s.link : null });
  }
}

async function deleteSession(id) {
  if (!confirm("Diesen Sitzungseintrag löschen? Hochgeladene Dateien bleiben erhalten.")) return;
  await fetch(`/api/upload-sessions/${id}`, { method: "DELETE" });
  loadSessions();
}

// --- per-session dashboard ---------------------------------------------------

function fmtSize(bytes) {
  if (bytes == null) return "";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

let dashPollTimer = null; // live-refresh timer while the dashboard is open

async function showDashboard(id) {
  const s = currentSessions.find((x) => x.id === id);
  if (!s) return;
  currentDashId = id;

  // Live updates: refresh the submissions while the dashboard is open, so names roll
  // in as the class uploads. Paused while the tab is hidden.
  clearInterval(dashPollTimer);
  dashPollTimer = setInterval(() => {
    if (document.visibilityState === "visible" && currentDashId) refreshDash();
  }, 5000);

  document.getElementById("au-dash-name").textContent = s.name;
  document.getElementById("au-dash-link").textContent = s.link;
  // Cache-buster so a re-opened dashboard re-renders the QR for the current host.
  document.getElementById("au-dash-qr").src = `/api/upload-sessions/${id}/qr?t=${Date.now()}`;
  const sizeMb = s.maxFileSizeBytes ? Math.round(s.maxFileSizeBytes / (1024 * 1024)) : "?";
  const ext = s.allowedExt.length ? s.allowedExt.join(", ") : "alle";
  document.getElementById("au-dash-meta").textContent =
    `Status: ${STATUS_DE[s.status] || s.status} · Ziel: ${s.targetLabel} · Unterordner: ${s.subfolder || "(Stammordner)"} · ` +
    `Erlaubt: ${ext} · Max. Größe: ${sizeMb} MB`;

  document.getElementById("au-dash").style.display = "flex";
  await refreshDash();
}

async function refreshDash() {
  if (!currentDashId) return;
  const tbody = document.getElementById("au-dash-rows");
  try {
    const res = await fetch(`/api/upload-sessions/${currentDashId}/submissions`);
    const data = await res.json();
    const subs = (data && data.submissions) || [];
    tbody.innerHTML = "";
    if (!subs.length) {
      tbody.innerHTML = "<tr><td colspan='5'>Noch keine Abgaben.</td></tr>";
    }
    for (const sub of subs) {
      const tr = document.createElement("tr");
      tr.appendChild(cell(new Date(sub.at).toLocaleString("de-DE")));
      tr.appendChild(cell(`${sub.lastName}, ${sub.firstName}`));
      tr.appendChild(cell(`${sub.originalName} → ${sub.storedName}`));
      tr.appendChild(cell(fmtSize(sub.size)));
      tr.appendChild(cell(sub.receipt || ""));
      tbody.appendChild(tr);
    }
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan='5'>Laden fehlgeschlagen: ${err.message}</td></tr>`;
  }
}

function cell(text) {
  const td = document.createElement("td");
  td.textContent = text;
  return td;
}

function downloadDash() {
  if (currentDashId) window.location.href = `/api/upload-sessions/${currentDashId}/download`;
}

// Open this session's collected files in the File Viewer (its target folder + subfolder).
function reviewDash() {
  const s = currentSessions.find((x) => x.id === currentDashId);
  if (!s) return;
  const full = s.subfolder ? `${s.targetDir}/${s.subfolder}` : s.targetDir;
  window.location.href = "/review?path=" + encodeURIComponent(full);
}

function closeDash(event) {
  if (event && event.currentTarget !== event.target) return;
  document.getElementById("au-dash").style.display = "none";
  currentDashId = null;
  clearInterval(dashPollTimer);
  dashPollTimer = null;
}

// --- poster ------------------------------------------------------------------

function openPoster(id) {
  if (id) window.open(`/upload-sessions/${id}/poster`, "_blank");
}

// From the share popup: stash the one-time code in sessionStorage so the poster page
// (same browser session only) can print it; it is never sent back to the server.
function openPosterFromReveal() {
  if (!currentReveal || !currentReveal.id) return;
  if (currentReveal.code) {
    sessionStorage.setItem(`posterCode:${currentReveal.id}`, currentReveal.code);
  }
  openPoster(currentReveal.id);
}

// --- reveal modal + clipboard ------------------------------------------------

// Share popup. Always shows the QR + link (from the session id); shows the access code
// only when one is passed (creation / regenerate) — it can't be recovered afterwards.
let currentReveal = null; // { id, code } of the open share popup, for the poster button

function showReveal({ id, code, link }) {
  currentReveal = { id, code };
  const qr = document.getElementById("au-reveal-qr");
  if (id) {
    qr.src = `/api/upload-sessions/${id}/qr?t=${Date.now()}`; // cache-buster for current host
    qr.style.display = "block";
  } else {
    qr.removeAttribute("src");
    qr.style.display = "none";
  }

  document.getElementById("au-reveal-link").textContent = link || "";

  document.getElementById("au-reveal-code").textContent = code || "";
  document.getElementById("au-reveal-code-wrap").style.display = code ? "block" : "none";

  document.getElementById("au-reveal").style.display = "flex";
}

function closeReveal(event) {
  if (event && event.target !== event.currentTarget && event.type === "click" && event.currentTarget.id !== "au-reveal") return;
  document.getElementById("au-reveal").style.display = "none";
}

function copyReveal() {
  copyText(document.getElementById("au-reveal-link").textContent);
}

function copyText(text) {
  if (!text) return;
  navigator.clipboard?.writeText(text).catch(() => {});
}

// --- init --------------------------------------------------------------------

document.getElementById("au-target").addEventListener("change", toggleCustomPath);
loadTargets();
loadSessions();
loadDefaults();

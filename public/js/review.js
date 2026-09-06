// File Viewer client: browse the vault, view files (image / PDF via pdf.js / text) in
// 1/2/4 compare panes, attach notes, and set a per-file review status.
//
// Loaded as an ES module so it can import pdf.js. All personal data it fetches
// (/api/review/file) is served no-store by the server; we never persist it client-side.

import * as pdfjsLib from "/vendor/pdfjs/pdf.min.mjs";
pdfjsLib.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/pdf.worker.min.mjs";

const els = {
  path: document.getElementById("rv-path"),
  dirs: document.getElementById("rv-dirs"),
  files: document.getElementById("rv-files"),
  empty: document.getElementById("rv-empty"),
  panes: document.getElementById("rv-panes"),
  split: document.getElementById("rv-split"),
  title: document.getElementById("rv-viewer-title"),
  notes: document.getElementById("rv-notes"),
  notesList: document.getElementById("rv-notes-list"),
  notesForm: document.getElementById("rv-notes-form"),
  noteBody: document.getElementById("rv-note-body"),
  notesMsg: document.getElementById("rv-notes-msg"),
  status: document.getElementById("rv-status"),
  folderMsg: document.getElementById("rv-folder-msg"),
  uploadBtn: document.getElementById("rv-upload-btn"),
  uploadInput: document.getElementById("rv-upload-input"),
  progress: document.getElementById("rv-progress"),
  progressFill: document.getElementById("rv-progress-fill"),
  progressLabel: document.getElementById("rv-progress-label"),
  imgTools: document.getElementById("rv-img-tools"),
  zoomIn: document.getElementById("rv-zoom-in"),
  zoomOut: document.getElementById("rv-zoom-out"),
  zoomLevel: document.getElementById("rv-zoom-level"),
  rotate: document.getElementById("rv-rotate"),
  fit: document.getElementById("rv-fit"),
  search: document.getElementById("rv-search"),
  filterStatus: document.getElementById("rv-filter-status"),
  filterExt: document.getElementById("rv-filter-ext"),
  sort: document.getElementById("rv-sort"),
};

const state = {
  dir: null,     // absolute path of the folder currently listed
  files: [],     // file objects for the listed folder (for status/progress updates)
  panes: [],     // pane objects (see buildPanes)
  focus: 0,      // index of the focused pane — notes/status/tools follow it
};

// relPath of the file in the focused pane (what notes/status/keyboard-nav act on).
function currentRel() {
  const pane = state.panes[state.focus];
  return pane && pane.file ? pane.file.relPath : null;
}

function fileUrl(relPath) {
  return "/api/review/file?path=" + encodeURIComponent(relPath);
}

function humanSize(bytes) {
  if (bytes == null) return "";
  const units = ["B", "KB", "MB", "GB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

// Escape a relPath for use inside a CSS attribute selector.
function cssEsc(s) {
  return (window.CSS && CSS.escape) ? CSS.escape(s) : s.replace(/["\\]/g, "\\$&");
}

// Fetch-and-download an attachment URL, surfacing errors in `msgEl` instead of
// navigating to a JSON error page.
async function downloadVia(url, fallbackName, msgEl) {
  msgEl.textContent = "";
  try {
    const res = await fetch(url);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || "Export fehlgeschlagen");
    }
    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = fallbackName;
    a.click();
    URL.revokeObjectURL(objectUrl);
  } catch (err) {
    msgEl.textContent = err.message;
  }
}

const IMG_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".avif"]);
// Types rendered through the plain-text renderer (textContent into <pre> — displayed
// only, never parsed or executed). Must match the server's text/plain whitelist.
const TEXT_EXTS = new Set([".txt", ".java", ".py", ".cpp", ".ipynb"]);

// --- directory browsing ------------------------------------------------------

async function loadDir(dirPath) {
  const url = "/api/review/list" + (dirPath ? "?path=" + encodeURIComponent(dirPath) : "");
  let data;
  try {
    const res = await fetch(url);
    data = await res.json();
    if (!res.ok) throw new Error(data.error || "Ordner konnte nicht geladen werden");
  } catch (err) {
    els.path.textContent = err.message;
    return;
  }
  state.dir = data.path;
  els.path.textContent = data.path;
  renderDirs(data.parent, data.dirs);
  renderFiles(data.files);
}

// --- uploading into the listed folder ----------------------------------------

function setFolderMsg(text, kind) {
  els.folderMsg.textContent = text || "";
  els.folderMsg.className = "rv-folder-msg" + (kind ? " " + kind : "");
}

els.uploadBtn.addEventListener("click", () => {
  if (!state.dir) return setFolderMsg("Kein Ordner ausgewählt.");
  els.uploadInput.click();
});

els.uploadInput.addEventListener("change", async () => {
  const files = [...els.uploadInput.files];
  // Reset immediately so picking the same file twice in a row still fires "change".
  els.uploadInput.value = "";
  if (!files.length || !state.dir) return;

  const fd = new FormData();
  for (const f of files) fd.append("files", f);
  setFolderMsg(`${files.length} Datei(en) werden hochgeladen…`);
  els.uploadBtn.disabled = true;
  try {
    const res = await fetch("/api/review/upload?path=" + encodeURIComponent(state.dir), {
      method: "POST",
      body: fd,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Upload fehlgeschlagen");
    // The server may have renamed to avoid overwriting; show what actually landed.
    setFolderMsg(`Hochgeladen: ${data.stored.join(", ")}`, "ok");
    await loadDir(state.dir);
  } catch (err) {
    setFolderMsg(err.message);
  } finally {
    els.uploadBtn.disabled = false;
  }
});

function renderDirs(parent, dirs) {
  els.dirs.innerHTML = "";
  if (parent) {
    els.dirs.appendChild(dirEntry("⬆", "..", parent));
  }
  for (const d of dirs) {
    els.dirs.appendChild(dirEntry("📁", d.name, d.path));
  }
}

function dirEntry(icon, label, targetPath) {
  const li = document.createElement("li");
  li.innerHTML = `<span class="rv-ico"></span><span class="rv-name"></span>`;
  li.querySelector(".rv-ico").textContent = icon;
  li.querySelector(".rv-name").textContent = label;
  li.addEventListener("click", () => loadDir(targetPath));
  return li;
}

function renderFiles(files) {
  state.files = files;
  populateExtFilter(files);
  renderFileList();
  renderProgress();
}

// Rebuild the type-filter dropdown from the extensions actually present, keeping the
// current selection when it still applies.
function populateExtFilter(files) {
  const prev = els.filterExt.value || "all";
  const exts = [...new Set(files.map((f) => f.ext).filter(Boolean))].sort();
  els.filterExt.innerHTML = "";
  const all = document.createElement("option");
  all.value = "all";
  all.textContent = "Alle Typen";
  els.filterExt.appendChild(all);
  for (const ext of exts) {
    const opt = document.createElement("option");
    opt.value = ext;
    opt.textContent = ext;
    els.filterExt.appendChild(opt);
  }
  els.filterExt.value = exts.includes(prev) ? prev : "all";
}

// The current filter+sort view of state.files. Uploader search works through the name
// filter because the uploader is baked into stored filenames ("Last_First__title.ext").
function visibleFiles() {
  const q = els.search.value.trim().toLowerCase();
  const status = els.filterStatus.value;
  const ext = els.filterExt.value;
  let out = state.files.filter((f) =>
    (!q || f.name.toLowerCase().includes(q)) &&
    (status === "all" || (f.status || "unreviewed") === status) &&
    (ext === "all" || f.ext === ext)
  );
  const by = els.sort.value;
  const statusRank = { unreviewed: 0, "needs-revision": 1, reviewed: 2, approved: 3 };
  if (by === "mtime") out.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
  else if (by === "size") out.sort((a, b) => (b.size || 0) - (a.size || 0));
  else if (by === "status") out.sort((a, b) =>
    (statusRank[a.status || "unreviewed"] - statusRank[b.status || "unreviewed"]) ||
    a.name.localeCompare(b.name));
  else out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

function renderFileList() {
  const files = visibleFiles();
  els.files.innerHTML = "";
  els.empty.style.display = files.length ? "none" : "block";
  els.empty.textContent = state.files.length && !files.length
    ? "Keine Dateien entsprechen dem aktuellen Filter."
    : "Dieser Ordner enthält keine Dateien.";
  for (const f of files) {
    const li = document.createElement("li");
    li.dataset.rel = f.relPath;
    li.innerHTML = `<span class="rv-dot"></span><span class="rv-ico"></span><span class="rv-name"></span><span class="rv-notecount"></span><span class="rv-size"></span><span class="rv-download"></span>`;
    setDot(li.querySelector(".rv-dot"), f.status);
    li.querySelector(".rv-ico").textContent = f.viewable ? (f.ext === ".pdf" ? "📄" : (TEXT_EXTS.has(f.ext) ? "📝" : "🖼")) : "⬇";
    li.querySelector(".rv-name").textContent = f.name;
    li.querySelector(".rv-notecount").textContent = f.noteCount ? `📝${f.noteCount}` : "";
    li.querySelector(".rv-size").textContent = humanSize(f.size);
    const dl = li.querySelector(".rv-download");
    dl.textContent = "⬇";
    dl.title = "Datei herunterladen";
    dl.addEventListener("click", (e) => {
      e.stopPropagation();
      setFolderMsg(""); // clears a leftover upload result, colour included
      downloadVia(fileUrl(f.relPath), f.name, els.folderMsg);
    });
    if (!f.viewable) li.classList.add("rv-file--download");
    if (f.relPath === currentRel()) li.classList.add("active");
    li.addEventListener("click", () => openFile(f, li));
    els.files.appendChild(li);
  }
}

els.search.addEventListener("input", renderFileList);
els.filterStatus.addEventListener("change", renderFileList);
els.filterExt.addEventListener("change", renderFileList);
els.sort.addEventListener("change", renderFileList);

// German display names for the review statuses (enum values stay English).
const STATUS_DE = {
  unreviewed: "ungeprüft",
  reviewed: "gesehen",
  "needs-revision": "überarbeiten",
  approved: "akzeptiert",
};

function setDot(dot, status) {
  dot.className = "rv-dot status-" + (status || "unreviewed");
  dot.title = STATUS_DE[status || "unreviewed"] || status;
}

// "Reviewed" for the progress bar = any status other than the default, over the
// viewable files (the ones an educator actually opens to review).
function renderProgress() {
  const viewable = state.files.filter((f) => f.viewable);
  if (!viewable.length) { els.progress.hidden = true; return; }
  const done = viewable.filter((f) => f.status && f.status !== "unreviewed").length;
  els.progress.hidden = false;
  els.progressFill.style.width = Math.round((done / viewable.length) * 100) + "%";
  els.progressLabel.textContent = `${done} / ${viewable.length} geprüft`;
}

// --- compare panes -------------------------------------------------------------

// Build n panes, keeping the files already open in the first n of the old panes.
function buildPanes(n) {
  const prev = state.panes;
  els.panes.innerHTML = "";
  els.panes.dataset.n = n;
  state.panes = [];

  for (let i = 0; i < n; i++) {
    const root = document.createElement("div");
    root.className = "rv-pane";
    const bar = document.createElement("div");
    bar.className = "rv-pane__bar";
    const body = document.createElement("div");
    body.className = "rv-pane__body";
    body.innerHTML = '<p class="rv-placeholder">Datei aus der Liste auswählen.</p>';
    root.append(bar, body);
    els.panes.appendChild(root);

    const pane = { index: i, root, bar, body, file: null, token: 0, img: null };
    // Clicking anywhere in a pane focuses it (mousedown so it wins over other handlers).
    root.addEventListener("mousedown", () => focusPane(i));
    state.panes.push(pane);

    const old = prev[i];
    if (old && old.file) renderInto(pane, old.file);
  }

  els.split.querySelectorAll("button").forEach((b) =>
    b.classList.toggle("active", Number(b.dataset.n) === n));
  focusPane(Math.min(state.focus, n - 1));
}

els.split.querySelectorAll("button").forEach((b) =>
  b.addEventListener("click", () => buildPanes(Number(b.dataset.n))));

// Focus a pane: highlight it and point the title, status, notes and image tools at it.
function focusPane(i) {
  state.focus = Math.max(0, Math.min(i, state.panes.length - 1));
  for (const p of state.panes) p.root.classList.toggle("focused", p.index === state.focus);

  const pane = state.panes[state.focus];
  const file = pane ? pane.file : null;
  els.title.textContent = file ? file.name : "Keine Datei ausgewählt";
  syncImgTools();
  markActiveListItem();
  if (file) {
    els.status.value = file.status || "unreviewed";
    loadNotes(file.relPath);
  } else {
    els.notes.hidden = true;
  }
}

function markActiveListItem() {
  const rel = currentRel();
  els.files.querySelectorAll("li.active").forEach((n) => n.classList.remove("active"));
  if (rel) {
    const li = els.files.querySelector(`li[data-rel="${cssEsc(rel)}"]`);
    if (li) li.classList.add("active");
  }
}

// --- viewing -----------------------------------------------------------------

function showMessage(pane, text, isError) {
  pane.body.innerHTML = "";
  pane.body.classList.remove("rv-pane__body--img");
  const p = document.createElement("p");
  p.className = "rv-msg" + (isError ? " error" : "");
  p.textContent = text;
  pane.body.appendChild(p);
}

// Open a file in the focused pane and point notes/status at it.
function openFile(file, li) {
  const pane = state.panes[state.focus];
  if (!pane) return;
  renderInto(pane, file);
  els.title.textContent = file.name;
  els.status.value = file.status || "unreviewed";
  markActiveListItem();
  loadNotes(file.relPath);
  if (li) li.classList.add("active");
}

// Render a file into a specific pane (used by openFile and by split rebuilds).
async function renderInto(pane, file) {
  pane.file = file;
  pane.img = null;
  pane.bar.textContent = file.name;
  const token = ++pane.token;
  syncImgTools();

  if (!file.viewable) {
    showMessage(pane, `„${file.name}“ kann nicht angezeigt werden.`, false);
    const a = document.createElement("a");
    a.className = "rv-download-link";
    a.href = fileUrl(file.relPath);
    a.textContent = "Datei herunterladen";
    const msg = pane.body.querySelector(".rv-msg");
    msg.appendChild(document.createElement("br"));
    msg.appendChild(a);
    return;
  }

  showMessage(pane, "Wird geladen…", false);
  try {
    if (TEXT_EXTS.has(file.ext)) await renderText(pane, file, token);
    else if (file.ext === ".pdf") await renderPdf(pane, file, token);
    else if (IMG_EXTS.has(file.ext)) renderImage(pane, file, token);
    else showMessage(pane, "Nicht unterstützter Dateityp.", true);
  } catch (err) {
    if (token === pane.token) showMessage(pane, err.message || "Datei konnte nicht geöffnet werden", true);
  }
}

// --- image rendering with zoom / rotate / fit ---------------------------------

const ZOOM_STEP = 1.25;
const ZOOM_MIN = 0.05;
const ZOOM_MAX = 16;

// Show the image toolbar when the focused pane displays an image; reflect its state.
function syncImgTools() {
  const pane = state.panes[state.focus];
  const img = pane && pane.img;
  els.imgTools.hidden = !img;
  if (img) {
    els.zoomLevel.textContent = Math.round(img.scale * 100) + "%";
    els.fit.classList.toggle("active", img.fit);
  }
}

function renderImage(pane, file, token) {
  if (token !== pane.token) return;
  pane.body.innerHTML = "";
  pane.body.classList.add("rv-pane__body--img");

  const stage = document.createElement("div");
  stage.className = "rv-img-stage";
  const img = new Image();
  img.alt = file.name;
  img.onload = () => {
    if (token !== pane.token) return;
    pane.img = { el: img, natW: img.naturalWidth, natH: img.naturalHeight, scale: 1, rot: 0, fit: true };
    applyImgView(pane);
    syncImgTools();
  };
  img.onerror = () => {
    if (token !== pane.token) return;
    pane.img = null;
    syncImgTools();
    showMessage(pane, "Bild konnte nicht geladen werden.", true);
  };
  img.src = fileUrl(file.relPath);
  stage.appendChild(img);
  pane.body.appendChild(stage);
}

// The image's on-screen bounding box swaps width/height at 90°/270°.
function rotatedBox(w, h, rot) {
  return rot % 180 === 0 ? { w, h } : { w: h, h: w };
}

// Scale that fits the (rotated) image inside its pane, never upscaling past 100%.
function fitScale(pane) {
  const availW = pane.body.clientWidth - 16;
  const availH = pane.body.clientHeight - 16;
  const box = rotatedBox(pane.img.natW, pane.img.natH, pane.img.rot);
  if (!box.w || !box.h || availW <= 0 || availH <= 0) return 1;
  return Math.min(availW / box.w, availH / box.h, 1);
}

function applyImgView(pane) {
  const v = pane.img;
  if (!v) return;
  if (v.fit) v.scale = fitScale(pane);
  const dispW = v.natW * v.scale;
  const dispH = v.natH * v.scale;
  const box = rotatedBox(dispW, dispH, v.rot);

  // The stage takes the rotated bounding box (so scrollbars are right); the image is
  // centered in it and rotated around its own center.
  const stage = v.el.parentElement;
  stage.style.width = Math.max(box.w, pane.body.clientWidth) + "px";
  stage.style.height = Math.max(box.h, pane.body.clientHeight) + "px";
  v.el.style.width = dispW + "px";
  v.el.style.height = dispH + "px";
  v.el.style.transform = `rotate(${v.rot}deg)`;

  if (pane.index === state.focus) syncImgTools();
}

function zoomBy(pane, factor) {
  if (!pane || !pane.img) return;
  pane.img.fit = false; // manual zoom leaves fit mode
  pane.img.scale = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, pane.img.scale * factor));
  applyImgView(pane);
}

function rotateImg(pane) {
  if (!pane || !pane.img) return;
  pane.img.rot = (pane.img.rot + 90) % 360;
  applyImgView(pane); // in fit mode the scale recomputes for the new orientation
}

function toggleFit(pane) {
  if (!pane || !pane.img) return;
  pane.img.fit = !pane.img.fit;
  if (!pane.img.fit) pane.img.scale = 1; // "actual size"
  applyImgView(pane);
}

function focusedPane() {
  return state.panes[state.focus] || null;
}

els.zoomIn.addEventListener("click", () => zoomBy(focusedPane(), ZOOM_STEP));
els.zoomOut.addEventListener("click", () => zoomBy(focusedPane(), 1 / ZOOM_STEP));
els.rotate.addEventListener("click", () => rotateImg(focusedPane()));
els.fit.addEventListener("click", () => toggleFit(focusedPane()));

// Ctrl+wheel zooms the image in the pane under the cursor instead of the browser page.
els.panes.addEventListener("wheel", (e) => {
  if (!e.ctrlKey) return;
  const root = e.target.closest && e.target.closest(".rv-pane");
  const pane = root && state.panes.find((p) => p.root === root);
  if (!pane || !pane.img) return;
  e.preventDefault();
  zoomBy(pane, e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP);
}, { passive: false });

// Refit on window resize so fit mode tracks pane sizes.
window.addEventListener("resize", () => {
  for (const pane of state.panes) {
    if (pane.img && pane.img.fit) applyImgView(pane);
  }
});

async function renderText(pane, file, token) {
  const res = await fetch(fileUrl(file.relPath));
  if (!res.ok) throw new Error("Textdatei konnte nicht geladen werden");
  const text = await res.text();
  if (token !== pane.token) return;
  pane.body.innerHTML = "";
  pane.body.classList.remove("rv-pane__body--img");
  const pre = document.createElement("pre");
  pre.textContent = text; // never innerHTML: student text is untrusted
  pane.body.appendChild(pre);
}

async function renderPdf(pane, file, token) {
  // isEvalSupported: false closes pdf.js's font-program eval path — student-supplied
  // PDFs are the least-trusted content this app renders (cf. CVE-2024-4367).
  const loadingTask = pdfjsLib.getDocument({ url: fileUrl(file.relPath), isEvalSupported: false });
  const pdf = await loadingTask.promise;
  if (token !== pane.token) { pdf.destroy(); return; }
  pane.body.innerHTML = "";
  pane.body.classList.remove("rv-pane__body--img");
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    if (token !== pane.token) { pdf.destroy(); return; }
    const viewport = page.getViewport({ scale: 1.5 });
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    pane.body.appendChild(canvas);
    await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
  }
}

// --- notes -------------------------------------------------------------------

function fmtTime(sec) {
  if (!sec) return "";
  return new Date(sec * 1000).toLocaleString("de-DE");
}

async function loadNotes(relPath) {
  els.notes.hidden = false;
  els.notesMsg.textContent = "";
  els.notesList.innerHTML = "";
  let data;
  try {
    const res = await fetch("/api/review/notes?path=" + encodeURIComponent(relPath));
    data = await res.json();
    if (!res.ok) throw new Error(data.error || "Notizen konnten nicht geladen werden");
  } catch (err) {
    els.notesList.innerHTML = "";
    setNotesMsg(err.message, true);
    return;
  }
  // Ignore a response that arrived after the user switched files/panes.
  if (relPath !== currentRel()) return;
  renderNotes(data.notes || []);
  // Keep the file-list note-count badge in sync.
  const file = state.files.find((f) => f.relPath === relPath);
  if (file) {
    file.noteCount = (data.notes || []).length;
    const badge = els.files.querySelector(`li[data-rel="${cssEsc(file.relPath)}"] .rv-notecount`);
    if (badge) badge.textContent = file.noteCount ? `📝${file.noteCount}` : "";
  }
}

function renderNotes(list) {
  els.notesList.innerHTML = "";
  if (!list.length) {
    const li = document.createElement("li");
    li.className = "rv-notes__empty";
    li.textContent = "Noch keine Notizen.";
    els.notesList.appendChild(li);
    return;
  }
  for (const note of list) els.notesList.appendChild(noteItem(note));
}

function noteItem(note) {
  const li = document.createElement("li");
  li.className = "rv-note";
  li.dataset.id = note.id;

  const body = document.createElement("div");
  body.className = "rv-note__body";
  body.textContent = note.body; // untrusted-ish; render as text

  const meta = document.createElement("div");
  meta.className = "rv-note__meta";
  const time = document.createElement("span");
  time.textContent = note.updatedAt && note.updatedAt !== note.createdAt
    ? `bearbeitet ${fmtTime(note.updatedAt)}`
    : fmtTime(note.createdAt);
  const actions = document.createElement("div");
  actions.className = "rv-note__actions";
  const editBtn = document.createElement("button");
  editBtn.type = "button";
  editBtn.textContent = "Bearbeiten";
  editBtn.addEventListener("click", () => startEdit(li, note));
  const delBtn = document.createElement("button");
  delBtn.type = "button";
  delBtn.textContent = "Löschen";
  delBtn.addEventListener("click", () => deleteNote(note.id));
  actions.append(editBtn, delBtn);
  meta.append(time, actions);

  li.append(body, meta);
  return li;
}

function startEdit(li, note) {
  li.innerHTML = "";
  const ta = document.createElement("textarea");
  ta.className = "rv-note__edit";
  ta.rows = 3;
  ta.value = note.body;
  ta.maxLength = 10000;
  const actions = document.createElement("div");
  actions.className = "rv-note__meta";
  const save = document.createElement("button");
  save.type = "button";
  save.textContent = "Speichern";
  save.addEventListener("click", () => saveEdit(note.id, ta.value));
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "Abbrechen";
  cancel.addEventListener("click", () => { if (currentRel()) loadNotes(currentRel()); });
  const wrap = document.createElement("div");
  wrap.className = "rv-note__actions";
  wrap.append(save, cancel);
  actions.append(wrap);
  li.append(ta, actions);
  ta.focus();
}

function setNotesMsg(text, isError) {
  els.notesMsg.textContent = text || "";
  els.notesMsg.className = "rv-notes__msg" + (isError ? " error" : "");
}

async function addNote(relPath, text) {
  const res = await fetch("/api/review/notes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: relPath, body: text }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Notiz konnte nicht hinzugefügt werden");
}

async function saveEdit(id, text) {
  const relPath = currentRel();
  if (!relPath) return;
  const body = text.trim();
  if (!body) { setNotesMsg("Notiztext darf nicht leer sein", true); return; }
  try {
    const res = await fetch("/api/review/notes/" + encodeURIComponent(id), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: relPath, body }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Notiz konnte nicht gespeichert werden");
    await loadNotes(relPath);
  } catch (err) {
    setNotesMsg(err.message, true);
  }
}

async function deleteNote(id) {
  const relPath = currentRel();
  if (!relPath) return;
  if (!confirm("Diese Notiz löschen?")) return;
  try {
    const res = await fetch(
      "/api/review/notes/" + encodeURIComponent(id) + "?path=" + encodeURIComponent(relPath),
      { method: "DELETE" }
    );
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Notiz konnte nicht gelöscht werden");
    await loadNotes(relPath);
  } catch (err) {
    setNotesMsg(err.message, true);
  }
}

els.status.addEventListener("change", async () => {
  const relPath = currentRel();
  if (!relPath) return;
  const status = els.status.value;
  try {
    const res = await fetch("/api/review/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: relPath, status }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Status konnte nicht gespeichert werden");
    // Reflect it in the file list dot + progress bar without a full reload.
    const file = state.files.find((f) => f.relPath === relPath);
    if (file) {
      file.status = data.status;
      const dot = els.files.querySelector(`li[data-rel="${cssEsc(file.relPath)}"] .rv-dot`);
      if (dot) setDot(dot, data.status);
      renderProgress();
    }
  } catch (err) {
    setNotesMsg(err.message, true);
  }
});

els.notesForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const relPath = currentRel();
  if (!relPath) return;
  const text = els.noteBody.value.trim();
  if (!text) { setNotesMsg("Notiztext darf nicht leer sein", true); return; }
  try {
    await addNote(relPath, text);
    els.noteBody.value = "";
    setNotesMsg("");
    await loadNotes(relPath);
  } catch (err) {
    setNotesMsg(err.message, true);
  }
});

// --- keyboard navigation -------------------------------------------------------

// Open the file `delta` positions away from the focused pane's file in the visible
// (filtered + sorted) list. With nothing open, start at the top/bottom.
function openByOffset(delta) {
  const files = visibleFiles();
  if (!files.length) return;
  let idx = files.findIndex((f) => f.relPath === currentRel());
  idx = idx === -1 ? (delta > 0 ? 0 : files.length - 1) : idx + delta;
  if (idx < 0 || idx >= files.length) return; // stop at the ends
  const file = files[idx];
  const li = els.files.querySelector(`li[data-rel="${cssEsc(file.relPath)}"]`);
  if (li) li.scrollIntoView({ block: "nearest" });
  openFile(file, li);
}

document.addEventListener("keydown", (e) => {
  // Never steal keys from form fields (search box, note editor, status select).
  const t = e.target;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
  if (e.ctrlKey || e.altKey || e.metaKey) return;

  switch (e.key) {
    case "ArrowRight":
    case "j":
      e.preventDefault();
      openByOffset(1);
      break;
    case "ArrowLeft":
    case "k":
      e.preventDefault();
      openByOffset(-1);
      break;
    case "1":
      buildPanes(1);
      break;
    case "2":
      buildPanes(2);
      break;
    case "4":
      buildPanes(4);
      break;
    case "Tab":
      // Cycle pane focus in compare mode.
      if (state.panes.length > 1) {
        e.preventDefault();
        focusPane((state.focus + 1) % state.panes.length);
      }
      break;
    case "+":
    case "=":
      zoomBy(focusedPane(), ZOOM_STEP);
      break;
    case "-":
      zoomBy(focusedPane(), 1 / ZOOM_STEP);
      break;
    case "r":
      rotateImg(focusedPane());
      break;
    case "f":
      toggleFit(focusedPane());
      break;
  }
});

// --- boot --------------------------------------------------------------------

// Build a file object from a bare relPath for ?open= deep links. Mirrors the server's
// typing rules, including seeing through ".conflicted" suffixes (sync conflicts).
function pseudoFile(rel) {
  const name = rel.split("/").pop();
  const base = name.replace(/\.conflicted(-\d+)?$/, "");
  const dot = base.lastIndexOf(".");
  const ext = dot >= 0 ? base.slice(dot).toLowerCase() : "";
  const viewable = IMG_EXTS.has(ext) || ext === ".pdf" || TEXT_EXTS.has(ext);
  return { name, relPath: rel, ext, viewable, status: null, noteCount: 0 };
}

buildPanes(1);
// Deep links: ?path= opens a folder (e.g. from the upload dashboard); one or two
// ?open=<relPath> params open files directly — two opens them side by side, which is
// how the sync page's "Compare in File Viewer" hands over a conflict pair.
const params = new URLSearchParams(location.search);
(async () => {
  await loadDir(params.get("path") || "");
  const rels = params.getAll("open").slice(0, 2);
  if (!rels.length) return;
  if (rels.length === 2) buildPanes(2);
  rels.forEach((rel, i) => {
    focusPane(i);
    // Prefer the listed file (it has status/notes metadata); fall back to a pseudo
    // object for files outside the listed folder.
    const listed = state.files.find((f) => f.relPath === rel);
    openFile(listed || pseudoFile(rel), null);
  });
  focusPane(0);
})();

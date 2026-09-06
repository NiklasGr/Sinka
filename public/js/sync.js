// File Sync page: provider tabs (authenticate + pick a course/folder), the empty-folder
// browser for choosing a sync target, the synced-course registry list, and "Sync All".
// The numbered steps below mirror the flow in src/routes/sync.js.

// Configuration for each content tab. `provider` is set for tabs backed by a sync
// provider (so their course list can be loaded); decorative tabs leave it null.
const contentTabs = [
  { type: 'studip', buttonId: 'studip-btn', contentId: 'studip-content', provider: 'studip' },
  { type: 'iserv', buttonId: 'iserv-btn', contentId: 'iserv-content', provider: 'iserv' },
];

// Function to show the selected content and update button states
function showContent(selectedType) {
  document.getElementById('default-content').style.display = 'none';
  contentTabs.forEach(tab => {
    const contentElement = document.getElementById(tab.contentId);
    const buttonElement = document.getElementById(tab.buttonId);

    if (tab.type === selectedType) {
      contentElement.style.display = 'block';
      buttonElement.classList.add('active');
    } else {
      contentElement.style.display = 'none';
      buttonElement.classList.remove('active');
    }
  });

  const tab = contentTabs.find(t => t.type === selectedType);
  if (tab && tab.provider) loadCourses(tab.provider);
}

// Initialize Event Listeners after DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
  contentTabs.forEach(tab => {
    const buttonElement = document.getElementById(tab.buttonId);
    if (buttonElement) {
      buttonElement.addEventListener('click', () => showContent(tab.type));
    }
  });
  loadSyncedCourses();
  loadConflicts();

  // If a scheduled auto-sync is already in flight when the page opens, show its bar.
  fetch('/api/sync/progress')
    .then(r => r.json())
    .then(p => {
      if (p.running) {
        updateSyncProgress(p);
        startSyncPolling(() => {
          finishSyncProgress(p.total);
          loadSyncedCourses();
          loadConflicts();
        });
      }
    })
    .catch(() => {});
});

function authenticate(service) {
  if (service === 'studip') {
    window.location.href = '/auth/studip';
  }
}

// IServ uses a login form (Basic auth) rather than an OAuth redirect.
function iservLogin(event) {
  event.preventDefault();
  const username = document.getElementById('iserv-username').value;
  const password = document.getElementById('iserv-password').value;
  fetch('/auth/iserv', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
    .then(response => (response.ok ? response.json() : response.json().then(e => Promise.reject(new Error(e.error || 'login failed')))))
    .then(() => {
      document.getElementById('iserv-password').value = '';
      loadCourses('iserv');
    })
    .catch(error => alert('IServ-Anmeldung fehlgeschlagen: ' + error.message));
}

// --- Step 1: course/folder dropdown ------------------------------------------

function loadCourses(provider) {
  const select = document.getElementById(`${provider}-course-select`);
  if (!select) return;
  fetch(`/api/${provider}/courses`)
    .then(response => (response.ok ? response.json() : Promise.reject(new Error('Not authenticated'))))
    .then(data => {
      select.innerHTML = '';
      if (!data.courses || data.courses.length === 0) {
        select.innerHTML = '<option value="">Nichts zum Synchronisieren gefunden</option>';
        return;
      }
      data.courses.forEach(course => {
        const option = document.createElement('option');
        option.value = course.id;
        option.dataset.name = course.name;
        option.textContent = course.semester ? `${course.name} (${course.semester})` : course.name;
        select.appendChild(option);
      });
    })
    .catch(error => {
      select.innerHTML = '<option value="">Zum Laden anmelden</option>';
      console.error(`Failed to load ${provider} courses:`, error);
    });
}

// --- Step 2: server-side folder browser --------------------------------------

let pendingSync = null;       // { provider, courseId, courseName } awaiting a folder
let folderBrowserPath = null; // the directory currently shown in the browser

function openFolderBrowser(provider) {
  const select = document.getElementById(`${provider}-course-select`);
  const courseId = select && select.value;
  if (!courseId) {
    alert('Zuerst etwas zum Synchronisieren auswählen.');
    return;
  }
  pendingSync = {
    provider,
    courseId,
    courseName: select.options[select.selectedIndex].dataset.name || courseId,
  };
  document.getElementById('folder-browser').style.display = 'flex';
  browseFolder(null);
}

function browseFolder(targetPath) {
  const url = targetPath ? `/api/fs/list?path=${encodeURIComponent(targetPath)}` : '/api/fs/list';
  fetch(url)
    .then(response => (response.ok ? response.json() : response.json().then(e => Promise.reject(new Error(e.error || 'failed')))))
    .then(data => {
      folderBrowserPath = data.path;
      document.getElementById('folder-browser-path').textContent = data.path;
      const list = document.getElementById('folder-browser-list');
      list.innerHTML = '';
      if (data.parent) {
        const up = document.createElement('li');
        up.textContent = '⬆ ..';
        up.onclick = () => browseFolder(data.parent);
        list.appendChild(up);
      }
      data.entries.forEach(entry => {
        const li = document.createElement('li');
        li.textContent = '📁 ' + entry.name;
        li.onclick = () => browseFolder(entry.path);
        list.appendChild(li);
      });

      // Only an empty folder may be used as a sync target.
      const confirm = document.getElementById('folder-browser-confirm');
      const note = document.getElementById('folder-browser-note');
      confirm.disabled = !data.empty;
      note.textContent = data.empty ? '' : 'Dieser Ordner ist nicht leer — bitte einen leeren Ordner wählen oder anlegen.';
    })
    .catch(error => alert('Ordner kann nicht geöffnet werden: ' + error.message));
}

function createFolderHere() {
  if (!folderBrowserPath) return;
  const name = prompt('Name des neuen Ordners:');
  if (!name) return;
  fetch('/api/fs/mkdir', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: folderBrowserPath, name }),
  })
    .then(response => (response.ok ? response.json() : response.json().then(e => Promise.reject(new Error(e.error || 'failed')))))
    .then(data => browseFolder(data.path))
    .catch(error => alert('Ordner kann nicht erstellt werden: ' + error.message));
}

function closeFolderBrowser() {
  document.getElementById('folder-browser').style.display = 'none';
  pendingSync = null;
}

// --- Step 3: register the selected course + folder ---------------------------

function confirmFolder() {
  if (!pendingSync || !folderBrowserPath) return;
  fetch('/api/sync-registry', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...pendingSync, localPath: folderBrowserPath }),
  })
    .then(response => (response.ok ? response.json() : response.json().then(e => Promise.reject(new Error(e.error || 'failed')))))
    .then(() => {
      closeFolderBrowser();
      loadSyncedCourses();
    })
    .catch(error => alert('Synchronisation konnte nicht eingerichtet werden: ' + error.message));
}

// "vor 5 Min." / "vor 3 Std." / a date — for the last-sync line.
function fmtAgo(epochSec) {
  if (!epochSec) return 'nie';
  const s = Math.max(0, Math.trunc(Date.now() / 1000) - epochSec);
  if (s < 60) return 'gerade eben';
  if (s < 3600) return `vor ${Math.trunc(s / 60)} Min.`;
  if (s < 86400) return `vor ${Math.trunc(s / 3600)} Std.`;
  return new Date(epochSec * 1000).toLocaleString('de-DE');
}

// Compact "3↓ 1↑ 1 Konflikt" from the counts recorded on the registry entry.
function fmtCounts(c) {
  if (!c) return '';
  const parts = [];
  if (c.downloaded) parts.push(`${c.downloaded}↓`);
  if (c.uploaded) parts.push(`${c.uploaded}↑`);
  if (c.deletedLocal || c.deletedRemote) parts.push(`${(c.deletedLocal || 0) + (c.deletedRemote || 0)} gelöscht`);
  if (c.conflicts) parts.push(`${c.conflicts} Konflikt${c.conflicts > 1 ? 'e' : ''}`);
  if (c.skipped) parts.push(`${c.skipped} übersprungen`);
  return parts.length ? parts.join(' · ') : 'keine Änderungen';
}

function loadSyncedCourses() {
  const list = document.getElementById('synced-courses-list');
  if (!list) return;
  fetch('/api/sync-registry')
    .then(response => response.json())
    .then(data => {
      list.innerHTML = '';
      if (!data.entries || data.entries.length === 0) {
        list.innerHTML = '<li>Noch keine Kurse synchronisiert.</li>';
        return;
      }
      data.entries.forEach(entry => {
        const li = document.createElement('li');
        li.textContent = `[${entry.provider}] ${entry.courseName} → ${entry.localPath} `;
        // Direct navigation (not fetch+blob) so large course zips stream to disk
        // instead of buffering in memory.
        const download = document.createElement('button');
        download.textContent = 'Herunterladen (zip)';
        download.onclick = () => {
          window.location.href = `/api/sync-registry/${encodeURIComponent(entry.provider)}/${encodeURIComponent(entry.courseId)}/download`;
        };
        li.appendChild(download);
        li.appendChild(document.createTextNode(' '));
        const remove = document.createElement('button');
        remove.textContent = 'Entfernen';
        remove.onclick = () => removeSync(entry.provider, entry.courseId);
        li.appendChild(remove);

        // Outcome of the most recent run (manual or scheduled), from the registry.
        const info = document.createElement('span');
        info.className = 'last-sync';
        const ls = entry.lastSync;
        if (!ls) {
          info.textContent = 'Letzte Synchronisation: nie';
        } else if (ls.status === 'ok') {
          info.textContent = `Letzte Synchronisation: ${fmtAgo(ls.at)} — ${fmtCounts(ls.counts)}`;
        } else {
          info.classList.add('error');
          const label = ls.status === 'skipped' ? 'übersprungen' : 'Fehler';
          info.textContent = `Letzte Synchronisation: ${fmtAgo(ls.at)} — ${label}: ${ls.error || ''}`;
        }
        li.appendChild(info);
        list.appendChild(li);
      });
    });
}

function removeSync(provider, courseId) {
  fetch(`/api/sync-registry/${encodeURIComponent(provider)}/${encodeURIComponent(courseId)}`, { method: 'DELETE' })
    .then(() => loadSyncedCourses());
}

// --- Step 4: sync every registered course ------------------------------------

// The run happens server-side in one request; a progress endpoint is polled while it
// is in flight so the bar can show "2 / 5 — syncing <course>".
let syncPollTimer = null;

function updateSyncProgress(p) {
  const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
  document.getElementById('sync-progress-fill').style.width = pct + '%';
  document.getElementById('sync-progress-label').textContent = p.total
    ? `${p.done} / ${p.total} Kurse synchronisiert` + (p.current ? ` — synchronisiere „${p.current}“…` : '')
    : 'Wird gestartet…';
}

// Poll the progress endpoint until the run ends; `onFinished` fires once it has.
function startSyncPolling(onFinished) {
  stopSyncPolling();
  document.getElementById('sync-progress').style.display = 'block';
  syncPollTimer = setInterval(async () => {
    try {
      const res = await fetch('/api/sync/progress');
      const p = await res.json();
      if (p.running) {
        updateSyncProgress(p);
      } else {
        stopSyncPolling();
        if (onFinished) onFinished();
      }
    } catch { /* transient fetch error — keep polling */ }
  }, 600);
}

function stopSyncPolling() {
  clearInterval(syncPollTimer);
  syncPollTimer = null;
}

// Fill the bar, hold it briefly so the completed state is visible, then hide it.
function finishSyncProgress(total) {
  updateSyncProgress({ running: false, total: total || 1, done: total || 1, current: null });
  setTimeout(() => { document.getElementById('sync-progress').style.display = 'none'; }, 1200);
}

function syncCourseFiles() {
  const btn = document.getElementById('sync-all-btn');
  const msg = document.getElementById('sync-all-msg');
  btn.disabled = true;
  msg.textContent = '';
  updateSyncProgress({ running: true, total: 0, done: 0, current: null });
  startSyncPolling(null); // the POST below signals completion; polling just draws the bar
  fetch('/api/sync', { method: 'POST' })
    .then(response => response.json().then(data => (response.ok ? data : Promise.reject(Object.assign(new Error(data.error || 'Synchronisation fehlgeschlagen'), { status: response.status })))))
    .then(data => {
      stopSyncPolling();
      finishSyncProgress((data.results || []).length);
      renderSyncResults(data.results || []);
      loadSyncedCourses(); // refresh the last-sync lines
      loadConflicts();     // a run may have created or resolved conflicts
    })
    .catch(error => {
      if (error.status === 409) {
        // A scheduled run is already in flight — follow it with the bar instead.
        msg.textContent = 'Eine Synchronisation läuft bereits…';
        startSyncPolling(() => {
          msg.textContent = '';
          finishSyncProgress(0);
          loadSyncedCourses();
          loadConflicts();
        });
      } else {
        stopSyncPolling();
        document.getElementById('sync-progress').style.display = 'none';
        msg.textContent = error.message;
      }
    })
    .finally(() => { btn.disabled = false; });
}

function renderSyncResults(results) {
  const section = document.getElementById('sync-results-section');
  const list = document.getElementById('sync-results');
  section.style.display = 'block';
  list.innerHTML = '';
  if (!results.length) {
    list.innerHTML = '<li>Keine Kurse registriert.</li>';
    return;
  }
  for (const r of results) {
    const li = document.createElement('li');
    const badge = document.createElement('span');
    badge.className = r.status;
    badge.textContent = r.status === 'ok' ? '✔' : r.status === 'skipped' ? '⏭' : '✖';
    li.appendChild(badge);
    let text = ` [${r.provider}] ${r.courseName}: `;
    if (r.status === 'ok') {
      const s = r.summary;
      text += fmtCounts({
        downloaded: s.downloaded.length, uploaded: s.uploaded.length,
        conflicts: s.conflicts.length,
        deletedLocal: s.deletedLocal.length, deletedRemote: s.deletedRemote.length,
        skipped: s.skipped.length + s.foldersSkipped.length,
      });
    } else {
      const label = r.status === 'skipped' ? 'übersprungen (nicht angemeldet)' : (r.error || r.reason || r.status);
      text += label;
    }
    li.appendChild(document.createTextNode(text));
    list.appendChild(li);
  }
}

// --- Conflicts -----------------------------------------------------------------

function loadConflicts() {
  fetch('/api/sync-conflicts')
    .then(response => response.json())
    .then(data => {
      const conflicts = data.conflicts || [];
      const section = document.getElementById('conflicts-section');
      const list = document.getElementById('conflicts-list');
      section.style.display = conflicts.length ? 'block' : 'none';
      list.innerHTML = '';
      for (const c of conflicts) {
        const li = document.createElement('li');

        const name = document.createElement('div');
        name.className = 'conflict-name';
        name.textContent = c.name;
        const meta = document.createElement('div');
        meta.className = 'conflict-meta';
        meta.textContent = `[${c.provider}] ${c.courseName} — ${c.dir}`;

        const actions = document.createElement('div');
        if (c.originalExists) {
          const compare = document.createElement('button');
          compare.textContent = 'Im File Viewer vergleichen';
          compare.onclick = () => {
            window.location.href = '/review?path=' + encodeURIComponent(c.dir) +
              '&open=' + encodeURIComponent(c.originalRel) +
              '&open=' + encodeURIComponent(c.conflictedRel);
          };
          actions.appendChild(compare);
        }
        const del = document.createElement('button');
        del.textContent = 'Konfliktkopie löschen';
        del.onclick = () => {
          if (!confirm(`„${c.name}“ löschen? Die synchronisierte Version der Datei bleibt erhalten.`)) return;
          fetch('/api/sync-conflicts?path=' + encodeURIComponent(c.dir + '/' + c.name), { method: 'DELETE' })
            .then(response => (response.ok ? loadConflicts() : response.json().then(e => alert(e.error || 'Löschen fehlgeschlagen'))));
        };
        actions.appendChild(del);

        li.append(name, meta, actions);
        list.appendChild(li);
      }
    })
    .catch(() => { /* leave the section as-is if the fetch fails */ });
}
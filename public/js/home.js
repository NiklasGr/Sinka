// Home dashboard: sync/session/storage status plus the GDPR subject-access and
// erasure tools
// (search → preview matches → confirm → execute).

function hmAgo(epochSec) {
  if (!epochSec) return "nie";
  const s = Math.max(0, Math.trunc(Date.now() / 1000) - epochSec);
  if (s < 60) return "gerade eben";
  if (s < 3600) return `vor ${Math.trunc(s / 60)} Min.`;
  if (s < 86400) return `vor ${Math.trunc(s / 3600)} Std.`;
  return new Date(epochSec * 1000).toLocaleDateString("de-DE");
}

function hmGb(bytes) {
  return (bytes / (1024 ** 3)).toFixed(1) + " GB";
}

// Build an element. `li(text)` used to be a second, narrower copy of this.
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

const li = (text) => el("li", null, text);

async function loadHomeStatus() {
  let data;
  try {
    const res = await fetch("/api/home/status");
    data = await res.json();
    if (!res.ok) throw new Error(data.error || "failed");
  } catch (err) {
    document.getElementById("hm-courses").innerHTML = "<li>Status konnte nicht geladen werden.</li>";
    return;
  }

  if (data.security) renderSecurity(data.security);

  // German display names for the session-status badges (CSS classes stay English).
  const STATUS_DE = { open: "offen", closed: "geschlossen", expired: "abgelaufen" };

  // Synced courses with their last outcome.
  const courses = document.getElementById("hm-courses");
  courses.innerHTML = "";
  if (!data.courses.length) courses.appendChild(li("Noch keine Kurse synchronisiert."));
  for (const c of data.courses) {
    const item = li(`[${c.provider}] ${c.courseName}`);
    const sub = document.createElement("span");
    sub.className = "sub";
    if (!c.lastSync) {
      sub.textContent = "Letzte Synchronisation: nie";
    } else if (c.lastSync.status === "ok") {
      sub.textContent = `Letzte Synchronisation: ${hmAgo(c.lastSync.at)} ✓`;
    } else {
      sub.classList.add("error");
      const label = c.lastSync.status === "skipped" ? "übersprungen" : "Fehler";
      sub.textContent = `Letzte Synchronisation: ${hmAgo(c.lastSync.at)} — ${label}: ${c.lastSync.error || ""}`;
    }
    item.appendChild(sub);
    courses.appendChild(item);
  }

  // Upload sessions (open first).
  const sess = document.getElementById("hm-sessions");
  sess.innerHTML = "";
  if (!data.sessions.length) sess.appendChild(li("Keine Upload-Sitzungen."));
  const ordered = [...data.sessions].sort((a, b) => (a.status === "open" ? -1 : 1) - (b.status === "open" ? -1 : 1));
  for (const s of ordered) {
    const item = li(`${s.name} — ${s.submissionCount} Abgabe(n)`);
    const badge = document.createElement("span");
    badge.className = `hm-badge ${s.status}`;
    badge.textContent = STATUS_DE[s.status] || s.status;
    item.appendChild(badge);
    sess.appendChild(item);
  }

  // Disk + background jobs.
  if (data.disk) {
    const used = data.disk.totalBytes - data.disk.freeBytes;
    const pct = Math.round((used / data.disk.totalBytes) * 100);
    document.getElementById("hm-disk").textContent =
      `Speicher: ${hmGb(data.disk.freeBytes)} frei von ${hmGb(data.disk.totalBytes)} (${pct}% belegt)`;
    const fill = document.getElementById("hm-disk-fill");
    fill.style.width = pct + "%";
    fill.className = "hm-disk__fill" + (pct >= 90 ? " crit" : pct >= 75 ? " warn" : "");
  } else {
    document.getElementById("hm-disk").textContent = "Speicher: nicht verfügbar";
  }
  const jobs = document.getElementById("hm-jobs");
  jobs.innerHTML = "";
  jobs.appendChild(li(data.autoSyncMinutes
    ? `Auto-Sync: alle ${data.autoSyncMinutes} Min.`
    : "Auto-Sync: aus (nur manuell) — in den Einstellungen aktivierbar"));
  jobs.appendChild(li(data.retentionDays
    ? `Aufbewahrung: Upload-Daten werden nach ${data.retentionDays} Tagen gelöscht`
    : "Aufbewahrung: aus (Daten bleiben unbegrenzt) — in den Einstellungen aktivierbar"));
  jobs.appendChild(li(data.autoLogoutMinutes
    ? `Auto-Abmeldung: Tresor wird nach ${data.autoLogoutMinutes} Min. Inaktivität gesperrt`
    : "Auto-Abmeldung: aus — der Tresor bleibt bis zur manuellen Abmeldung entsperrt"));
}

// --- security events + incident log (Art. 33) -------------------------------------

function renderSecurity(sec) {
  const alertBox = document.getElementById("hm-sec-alerts");
  const list = document.getElementById("hm-sec-events");
  if (!alertBox || !list) return;
  alertBox.innerHTML = "";
  list.innerHTML = "";

  for (const a of sec.alerts || []) {
    const div = el("div", "hm-alert");
    div.append(el("b", null, a.label));
    div.append(document.createTextNode(`${a.text} ${a.count}× in den letzten ${a.windowHours} Std.`));
    alertBox.append(div);
  }
  if (!(sec.alerts || []).length) {
    alertBox.append(el("div", "hm-ok", "Keine auffälligen Ereignisse."));
  }

  if (!(sec.byType || []).length) {
    list.append(el("li", null, "Seit dem Serverstart wurden keine sicherheitsrelevanten Ereignisse gezählt."));
    return;
  }
  for (const row of sec.byType) {
    const li = el("li", null, `${row.label}: ${row.total}`);
    li.append(el("span", "sub", `davon ${row.lastHour} in der letzten Stunde`));
    list.append(li);
  }
}

function fmtDateTime(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString("de-DE");
}

function renderIncidents(list) {
  const box = document.getElementById("hm-inc-list");
  if (!box) return;
  box.innerHTML = "";
  if (!list.length) {
    box.append(el("div", "hm-hint", "Noch keine Vorfälle dokumentiert."));
    return;
  }
  for (const inc of list) {
    const wrap = el("div", "hm-inc");
    wrap.append(el("b", null, inc.description));
    wrap.append(el("div", "hm-disc__meta",
      `Bekannt geworden: ${fmtDateTime(inc.noticedAt)}${inc.affected ? " · Betroffene: " + inc.affected : ""}`));

    if (inc.open) {
      const cls = inc.overdue ? "hm-inc__due over" : (inc.hoursLeft <= 24 ? "hm-inc__due soon" : "hm-inc__due");
      wrap.append(el("div", cls, inc.overdue
        ? `Meldefrist überschritten (seit ${Math.abs(inc.hoursLeft)} Std.) — Art. 33 Abs. 1`
        : `Noch ${inc.hoursLeft} Std. bis zum Ablauf der Meldefrist (Art. 33 Abs. 1)`));

      const actions = el("div", "hm-inc__actions");
      const reported = el("button", null, "An Aufsichtsbehörde gemeldet");
      reported.onclick = () => resolveIncident(inc.id, { reported: true });
      const noReport = el("button", null, "Keine Meldung nötig — begründen");
      noReport.onclick = () => {
        const reason = prompt("Begründung, warum keine Meldung erforderlich ist (Art. 33 Abs. 1):");
        if (reason && reason.trim()) resolveIncident(inc.id, { reported: false, reason });
      };
      actions.append(reported, noReport);
      wrap.append(actions);
    } else if (inc.reportedToAuthority) {
      wrap.append(el("div", "hm-inc__done", `Gemeldet am ${fmtDateTime(inc.reportedAt)}`));
    } else {
      wrap.append(el("div", "hm-inc__done", `Keine Meldung: ${inc.noReportReason}`));
    }
    box.append(wrap);
  }
}

async function loadAccessLog() {
  const list = document.getElementById("hm-acc-list");
  if (!list) return;
  try {
    const res = await fetch("/api/access-log");
    if (!res.ok) return;
    const data = await res.json();
    const days = document.getElementById("hm-acc-days");
    if (days && data.retentionDays) days.textContent = data.retentionDays;
    list.innerHTML = "";
    if (!(data.entries || []).length) {
      list.append(el("li", null, "Noch keine Zugriffe protokolliert."));
      return;
    }
    for (const e of data.entries.slice(0, 15)) {
      const li = el("li", null, `${e.label}: ${e.target}`);
      li.append(el("span", "sub", fmtDateTime(e.at) + (e.detail ? ` · ${e.detail}` : "")));
      list.append(li);
    }
    if (data.total > 15) {
      list.append(el("li", null, `… ${data.total - 15} weitere Einträge im Protokoll.`));
    }
  } catch (_) { /* leave the list as-is */ }
}

async function loadIncidents() {
  try {
    const res = await fetch("/api/incidents");
    if (!res.ok) return;
    const data = await res.json();
    renderIncidents(data.incidents || []);
  } catch (_) { /* leave the list as-is */ }
}

async function recordIncident() {
  const msg = document.getElementById("hm-inc-msg");
  const val = (id) => document.getElementById(id).value.trim();
  msg.textContent = "";
  try {
    const res = await fetch("/api/incidents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        noticedAt: val("hm-inc-noticed") ? new Date(val("hm-inc-noticed")).toISOString() : "",
        description: val("hm-inc-description"),
        affected: val("hm-inc-affected"),
        consequences: val("hm-inc-consequences"),
        measures: val("hm-inc-measures"),
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Speichern fehlgeschlagen");
    for (const id of ["hm-inc-noticed", "hm-inc-description", "hm-inc-affected",
                      "hm-inc-consequences", "hm-inc-measures"]) {
      document.getElementById(id).value = "";
    }
    msg.textContent = "Vorfall dokumentiert.";
    loadIncidents();
    loadHomeStatus();
  } catch (err) {
    msg.textContent = err.message;
  }
}

async function resolveIncident(id, payload) {
  try {
    const res = await fetch(`/api/incidents/${encodeURIComponent(id)}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Speichern fehlgeschlagen");
    loadIncidents();
    loadHomeStatus();
  } catch (err) {
    document.getElementById("hm-inc-msg").textContent = err.message;
  }
}

// --- subject access (Art. 15) -----------------------------------------------------

// Renders the dossier the server assembled. Everything goes in via textContent — this
// is pupil data and note bodies are free text.
function renderDossier(box, d) {
  box.innerHTML = "";

  if (!d.submissions.length) {
    box.append(el("div", null, `Zu „${d.query}“ sind keine Daten gespeichert.`));
    if (d.nearMisses.length) {
      box.append(el("div", "hm-disc__meta",
        `Ähnliche Namen im Bestand: ${d.nearMisses.join(", ")}. Bitte den vollständigen Namen eingeben.`));
    }
    return;
  }

  box.append(el("div", null, `${d.submissions.length} Abgabe(n)`));

  if (!d.controller || !d.contact) {
    box.append(el("div", "hm-disc__gap",
      "Verantwortliche Stelle und/oder Kontakt sind nicht hinterlegt — bitte in den Einstellungen ergänzen, sonst ist die Auskunft unvollständig."));
  }

  for (const sub of d.submissions) {
    const wrap = el("div", "hm-disc__sub");
    wrap.append(el("b", null, sub.originalName || sub.storedName || "(ohne Dateinamen)"));
    const bits = [`Sitzung: ${sub.sessionName}`, `Abgegeben: ${new Date(sub.at).toLocaleString("de-DE")}`];
    if (sub.receipt) bits.push(`Beleg: ${sub.receipt}`);
    if (!sub.fileExists) bits.push("Datei nicht mehr vorhanden");
    wrap.append(el("div", "hm-disc__meta", bits.join(" · ")));
    if (sub.review) {
      wrap.append(el("div", "hm-disc__meta", `Prüfstatus: ${sub.review.status}`));
      for (const n of sub.review.notes || []) {
        wrap.append(el("div", "hm-disc__note", n.body));
      }
    }
    box.append(wrap);
  }

  if (d.nearMisses.length) {
    box.append(el("div", "hm-disc__meta", `Ähnliche Namen im Bestand: ${d.nearMisses.join(", ")}`));
  }

  const actions = el("div", "hm-disc__actions");
  for (const [label, format] of [["Als PDF herunterladen", "pdf"], ["Als JSON herunterladen", "json"]]) {
    const a = el("a", null, label);
    a.href = `/api/disclosure/export?format=${format}&name=${encodeURIComponent(d.query)}`;
    actions.append(a);
  }
  box.append(actions);

  box.append(el("div", "hm-disc__cover",
    `Durchsucht: ${d.coverage.searched.join("; ")}. Nicht durchsucht: ${d.coverage.notSearched.join("; ")}.`));
}

async function discloseStudent() {
  const name = document.getElementById("hm-disc-name").value.trim();
  const box = document.getElementById("hm-disc-result");
  box.innerHTML = "";
  if (name.length < 3) { box.textContent = "Mindestens 3 Zeichen eingeben."; return; }

  try {
    const res = await fetch("/api/disclosure", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Zusammenstellung fehlgeschlagen");
    renderDossier(box, data.dossier);
  } catch (err) {
    box.textContent = err.message;
  }
}

// --- erasure tool ----------------------------------------------------------------

async function eraseStudent() {
  const name = document.getElementById("hm-erase-name").value.trim();
  const box = document.getElementById("hm-erase-result");
  box.innerHTML = "";
  if (name.length < 3) { box.textContent = "Mindestens 3 Zeichen eingeben."; return; }

  let data;
  try {
    const res = await fetch("/api/erasure/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    data = await res.json();
    if (!res.ok) throw new Error(data.error || "Suche fehlgeschlagen");
  } catch (err) {
    box.textContent = err.message;
    return;
  }

  const matches = data.matches || [];
  const nearMisses = data.nearMisses || [];
  if (!matches.length) {
    box.innerHTML = "";
    box.append(el("div", null, `Keine gespeicherten Uploads passen genau zu „${name}“.`));
    if (nearMisses.length) {
      box.append(el("div", "hm-disc__meta",
        `Ähnliche Namen im Bestand: ${nearMisses.join(", ")}. Bitte den vollständigen Namen eingeben — ` +
        "es wird nur exakt gelöscht, damit nie fremde Daten mit entfernt werden."));
    }
    return;
  }

  // Preview list, then an explicit confirm step.
  const intro = document.createElement("div");
  intro.textContent = `${matches.length} Eintrag/Einträge gefunden:`;
  const ul = document.createElement("ul");
  for (const m of matches) {
    const item = document.createElement("li");
    item.textContent = `${m.firstName} ${m.lastName} — ${m.storedName || "(keine Datei)"} ` +
      `(${m.sessionName}${m.fileExists ? "" : ", Datei bereits entfernt"})`;
    ul.appendChild(item);
  }
  const warn = document.createElement("div");
  warn.className = "danger";
  warn.textContent = "Die Löschung entfernt diese Dateien, ihre Protokolleinträge und Notizen " +
    "dauerhaft — auch aus synchronisierten Kursordnern (wird bei der nächsten Synchronisation " +
    "auch auf dem Server gelöscht).";
  const btn = document.createElement("button");
  btn.textContent = `${matches.length} Eintrag/Einträge endgültig löschen`;
  btn.onclick = async () => {
    if (!confirm(`Wirklich alle gespeicherten Daten zu „${name}“ löschen? Dies kann nicht rückgängig gemacht werden.`)) return;
    btn.disabled = true;
    try {
      const res = await fetch("/api/erasure/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || "Löschung fehlgeschlagen");
      box.innerHTML = "";
      box.textContent = `Gelöscht: ${result.filesDeleted} Datei(en), ${result.logEntriesRemoved} ` +
        `Protokolleintrag/-einträge, ${result.notesRemoved} Notiz-Einträge. Im Löschprotokoll vermerkt.`;
      loadHomeStatus();
    } catch (err) {
      box.textContent = err.message;
    }
  };
  // Order matters: hit list, then what was deliberately left out, then the warning and
  // the confirm button — so the operator reads the exclusions before deciding.
  const skipped = nearMisses.length
    ? el("div", "hm-disc__meta",
        `Nicht enthalten, weil der Name nicht exakt übereinstimmt: ${nearMisses.join(", ")}.`)
    : null;
  box.append(intro, ul, ...(skipped ? [skipped] : []), warn, btn);
}

document.addEventListener("DOMContentLoaded", () => {
  loadHomeStatus();
  loadAccessLog();
  loadIncidents();
});

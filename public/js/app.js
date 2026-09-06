// App shell, loaded on every page (see views/layout.ejs): the sidenav drawer and the
// settings overlay, which reads/writes the runtime-editable URLs via /api/settings.
// Page-specific behaviour lives in the per-page scripts (sync.js, admin-upload.js, …).

const sidenav = document.getElementById('mySidenav');
const settingsOverlay = document.getElementById('settingsOverlay');

function toggleNav() {
    sidenav.classList.toggle('open');
}

function openSettings() {
    settingsOverlay.classList.add('open');
    loadSettings();
}

function closeSettings(event) {
    if (event && event.target !== settingsOverlay) {
        return;
    }
    settingsOverlay.classList.remove('open');
}

// Populate the configuration form with the server's current values.
async function loadSettings() {
    const form = document.getElementById('settingsForm');
    if (!form) return;
    try {
        const res = await fetch('/api/settings');
        if (!res.ok) return;
        const { settings } = await res.json();
        for (const [key, value] of Object.entries(settings || {})) {
            if (form.elements[key]) form.elements[key].value = value || '';
        }
    } catch (_) {
        /* leave fields as-is if the fetch fails */
    }
}

// Persist configuration changes. Saved values apply immediately server-side.
function setupSettingsForm() {
    const form = document.getElementById('settingsForm');
    if (!form) return;
    const status = document.getElementById('settingsStatus');

    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const payload = {};
        for (const el of form.elements) {
            if (el.name) payload[el.name] = el.value.trim();
        }

        status.textContent = 'Wird gespeichert…';
        status.className = 'settings-status';
        try {
            const res = await fetch('/api/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Speichern fehlgeschlagen');
            status.textContent = 'Gespeichert. Änderungen gelten sofort.';
            status.classList.add('ok');
        } catch (err) {
            status.textContent = err.message;
            status.classList.add('error');
        }
    });
}

// Hard reset: wipe all data + configuration and return to the pre-install state.
// Deliberately hard to trigger — the exact word RESET must be typed, then confirmed.
async function hardReset() {
    const status = document.getElementById('hardResetStatus');
    const typed = prompt(
        'Dies löscht ALLE Daten: Konfiguration, synchronisierte Kursordner, Uploads, ' +
        'Abgabeprotokolle, Notizen, Zugangsdaten und Sitzungen. Es kann nicht rückgängig ' +
        'gemacht werden.\n\nZum Fortfahren RESET eingeben:'
    );
    if (typed === null) return;
    if (typed.trim() !== 'RESET') {
        status.textContent = 'Nicht zurückgesetzt — Bestätigungstext stimmt nicht überein.';
        status.className = 'settings-status';
        return;
    }
    if (!confirm('Wirklich alles löschen und den Server herunterfahren?')) return;

    status.textContent = 'Wird zurückgesetzt…';
    status.className = 'settings-status';
    try {
        const res = await fetch('/api/hard-reset', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ confirm: 'RESET' }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Zurücksetzen fehlgeschlagen');
        status.textContent = data.message;
        status.classList.add('ok');
    } catch (err) {
        status.textContent = err.message;
        status.classList.add('error');
    }
}

document.addEventListener('DOMContentLoaded', setupSettingsForm);

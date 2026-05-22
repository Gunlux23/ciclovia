# Cronologia percorsi — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline execution by author since no test suite).

**Goal:** Aggiungere cronologia persistente (max 30) dei percorsi calcolati con caricamento, modifica, rinomina, eliminazione, e gestione overflow (FIFO o manuale).

**Architecture:** Modulo dati separato `routeHistory.js` con storage localStorage proprio (`ciclovia.routes.v1`). UI tramite nuovo sheet attivato da voce nel menu hamburger. Wire-up in app.js per salvataggio automatico ad ogni calcolo riuscito.

**Tech Stack:** Vanilla JS ES modules, localStorage, Leaflet, no build, no test suite. Verifica manuale via Playwright MCP sul deploy GitHub Pages al termine.

**Spec di riferimento:** `docs/superpowers/specs/2026-05-22-cronologia-percorsi-design.md`

---

## Task 1: Modulo routeHistory.js (data layer)

**Files:**
- Create: `js/services/routeHistory.js`

- [ ] **Step 1:** Crea il file con contenuto completo:

```js
const STORAGE_KEY = 'ciclovia.routes.v1';
const MAX_ENTRIES = 30;
const SCHEMA_VERSION = 1;

const subscribers = new Set();
let cache = null;

function defaultState() {
  return { version: SCHEMA_VERSION, preference: null, entries: [] };
}

function isValidEntry(e) {
  return e && typeof e === 'object'
    && typeof e.id === 'string'
    && Array.isArray(e.waypoints) && e.waypoints.length >= 1
    && typeof e.profile === 'string';
}

function loadFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return defaultState();
    return {
      version: SCHEMA_VERSION,
      preference: (parsed.preference === 'fifo' || parsed.preference === 'manual')
        ? parsed.preference : null,
      entries: Array.isArray(parsed.entries)
        ? parsed.entries.filter(isValidEntry).slice(0, MAX_ENTRIES)
        : [],
    };
  } catch {
    return defaultState();
  }
}

function ensureLoaded() {
  if (cache === null) cache = loadFromStorage();
  return cache;
}

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
  } catch (err) {
    const e = new Error('QUOTA_EXCEEDED');
    e.code = 'QUOTA_EXCEEDED';
    throw e;
  }
}

function deepCopy(value) {
  return value == null || typeof value !== 'object'
    ? value
    : JSON.parse(JSON.stringify(value));
}

function notify() {
  const snap = list();
  for (const fn of subscribers) {
    try { fn(snap); } catch (e) { console.warn('[routeHistory] subscriber error', e); }
  }
}

function nextId() {
  return `r_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

export function isStorageAvailable() {
  try {
    const k = '__ciclovia_test__';
    localStorage.setItem(k, '1');
    localStorage.removeItem(k);
    return true;
  } catch {
    return false;
  }
}

export function list() {
  return deepCopy(ensureLoaded().entries);
}

export function get(id) {
  const e = ensureLoaded().entries.find((x) => x.id === id);
  return e ? deepCopy(e) : null;
}

export function add(entry) {
  const state = ensureLoaded();
  const newEntry = {
    id: entry.id || nextId(),
    createdAt: entry.createdAt || new Date().toISOString(),
    waypoints: deepCopy(entry.waypoints),
    profile: String(entry.profile || 'safety'),
    targetDistanceEnabled: !!entry.targetDistanceEnabled,
    targetDistanceKm: Number.isFinite(entry.targetDistanceKm) ? entry.targetDistanceKm : 30,
    loopSeed: Number.isFinite(entry.loopSeed) ? entry.loopSeed : 0,
    stats: deepCopy(entry.stats || {}),
    customName: (entry.customName && entry.customName.trim()) || null,
  };
  if (!isValidEntry(newEntry)) {
    return { added: false, reason: 'invalid' };
  }

  const updated = [newEntry, ...state.entries];

  if (updated.length > MAX_ENTRIES) {
    if (state.preference === 'fifo') {
      cache = { ...state, entries: updated.slice(0, MAX_ENTRIES) };
      try { persist(); } catch (err) { return { added: false, reason: err.code || 'storage' }; }
      notify();
      return { added: true, evictedFifo: true };
    }
    return {
      added: false,
      reason: 'full',
      preference: state.preference,
      pendingEntry: deepCopy(newEntry),
    };
  }

  cache = { ...state, entries: updated };
  try { persist(); } catch (err) { return { added: false, reason: err.code || 'storage' }; }
  notify();
  return { added: true };
}

export function remove(id) {
  const state = ensureLoaded();
  const filtered = state.entries.filter((e) => e.id !== id);
  if (filtered.length === state.entries.length) return false;
  cache = { ...state, entries: filtered };
  try { persist(); } catch { return false; }
  notify();
  return true;
}

export function removeMany(ids) {
  const state = ensureLoaded();
  const set = new Set(ids);
  const filtered = state.entries.filter((e) => !set.has(e.id));
  const removed = state.entries.length - filtered.length;
  if (removed === 0) return 0;
  cache = { ...state, entries: filtered };
  try { persist(); } catch { return 0; }
  notify();
  return removed;
}

export function rename(id, name) {
  const state = ensureLoaded();
  const cleaned = name && name.trim() ? name.trim().slice(0, 80) : null;
  let touched = false;
  const entries = state.entries.map((e) => {
    if (e.id !== id) return e;
    touched = true;
    return { ...e, customName: cleaned };
  });
  if (!touched) return false;
  cache = { ...state, entries };
  try { persist(); } catch { return false; }
  notify();
  return true;
}

export function clear() {
  cache = { ...ensureLoaded(), entries: [] };
  try { persist(); } catch { return; }
  notify();
}

export function getPreference() {
  return ensureLoaded().preference;
}

export function setPreference(pref) {
  if (pref !== 'fifo' && pref !== 'manual' && pref !== null) return;
  cache = { ...ensureLoaded(), preference: pref };
  try { persist(); } catch { return; }
  notify();
}

export function subscribe(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

export const MAX = MAX_ENTRIES;
```

- [ ] **Step 2:** Commit
```bash
git add js/services/routeHistory.js
git commit -m "feat: aggiungi modulo routeHistory per cronologia percorsi"
```

---

## Task 2: state.loadFromHistoryEntry

**Files:**
- Modify: `js/state.js` (aggiungere helper)

- [ ] **Step 1:** Aggiungere in fondo a `state.js`:

```js
export function loadFromHistoryEntry(entry) {
  if (!entry || !Array.isArray(entry.waypoints)) return;
  update({
    waypoints: entry.waypoints.map((w, i) => ({
      id: w.id || `w${Date.now()}_${i}`,
      lat: Number(w.lat),
      lon: Number(w.lon),
      label: w.label || '',
      source: w.source || 'history',
    })),
    profile: entry.profile || 'safety',
    targetDistanceEnabled: !!entry.targetDistanceEnabled,
    targetDistanceKm: Number.isFinite(entry.targetDistanceKm) ? entry.targetDistanceKm : 30,
    loopSeed: Number.isFinite(entry.loopSeed) ? entry.loopSeed : 0,
    route: null,
    status: 'idle',
    error: null,
  });
}
```

Anche aggiornare `update()`: `route` deve persistere? No, NON aggiungerlo a persist (è ricalcolabile). Ma la funzione `update` non controlla nulla per `route`, quindi va già bene.

- [ ] **Step 2:** Commit
```bash
git add js/state.js
git commit -m "feat: state.loadFromHistoryEntry per ricaricare entry cronologia"
```

---

## Task 3: app.js — salva entry su calcolo riuscito

**Files:**
- Modify: `js/app.js`

- [ ] **Step 1:** Aggiungere import in cima al file (vicino agli altri imports):

```js
import * as routeHistory from './services/routeHistory.js';
```

- [ ] **Step 2:** Dopo `state.update({ route, status: 'idle', error: null });` (intorno a riga 199), aggiungere:

```js
    // Salva in cronologia (se localStorage disponibile)
    if (routeHistory.isStorageAvailable()) {
      const addResult = routeHistory.add({
        waypoints: snap.waypoints,
        profile: usedProfile,
        targetDistanceEnabled: snap.targetDistanceEnabled,
        targetDistanceKm: snap.targetDistanceKm,
        loopSeed: snap.loopSeed,
        stats: {
          distanceKm: route.stats.km,
          ascentM: route.stats.dPos,
          durationMin: route.stats.timeMin,
        },
      });
      if (!addResult.added && addResult.reason === 'full') {
        uiApi.onHistoryFull(addResult);
      }
    }
```

`uiApi.onHistoryFull` sarà esposto da ui.js in Task 6. Per ora se non esiste (è ancora undefined a questo punto) il `?.` evita crash:

Cambiare in:
```js
      if (!addResult.added && addResult.reason === 'full' && uiApi.onHistoryFull) {
        uiApi.onHistoryFull(addResult);
      }
```

- [ ] **Step 3:** Commit
```bash
git add js/app.js
git commit -m "feat: salva ogni calcolo in routeHistory"
```

---

## Task 4: Markup index.html (menu + sheet + modali)

**Files:**
- Modify: `index.html`

- [ ] **Step 1:** Aggiungere voce "Cronologia" nel menu hamburger. Dopo riga `<button type="button" role="menuitem" id="menu-about">Informazioni</button>` (~r75), inserire:

```html
          <button type="button" role="menuitem" id="menu-history">Cronologia</button>
```

- [ ] **Step 2:** Aggiungere nuovo sheet dopo `</section>` di `sheet-stops` (cerca `</section>` dopo `id="sheet-stops"`, intorno r262). Inserire:

```html
  <!-- =========================================================
       Bottom sheet: Cronologia (nascosto fino ad apertura)
       ========================================================= -->
  <section
    class="sheet sheet--history"
    id="sheet-history"
    aria-label="Cronologia percorsi"
    hidden
  >
    <header class="sheet__header">
      <h2 class="sheet__title">
        <span>Cronologia</span>
        <span class="sheet__title-counter" id="history-counter">(0/30)</span>
      </h2>
      <div class="sheet__header-actions">
        <button
          type="button"
          id="sheet-history-close"
          class="btn btn--ghost"
          aria-label="Chiudi cronologia"
        >
          <span aria-hidden="true">×</span>
          <span>Chiudi</span>
        </button>
      </div>
    </header>

    <div class="sheet__body" id="sheet-history-body">
      <fieldset class="history-prefs">
        <legend class="history-prefs__legend">Quando piena:</legend>
        <label class="history-prefs__option">
          <input type="radio" name="history-pref" value="fifo" id="history-pref-fifo" />
          <span>Auto-elimina i più vecchi</span>
        </label>
        <label class="history-prefs__option">
          <input type="radio" name="history-pref" value="manual" id="history-pref-manual" />
          <span>Chiedo a me ogni volta</span>
        </label>
      </fieldset>

      <ol class="history-list" id="history-list" aria-label="Elenco percorsi salvati">
        <!-- popolato da ui.js -->
      </ol>
      <p class="history-empty" id="history-empty">
        Nessun percorso salvato. Calcola un percorso per iniziare.
      </p>

      <div class="history-footer">
        <button
          type="button"
          id="btn-history-clear"
          class="btn btn--ghost btn--danger"
        >
          Svuota cronologia
        </button>
      </div>
    </div>
  </section>

  <!-- =========================================================
       Modale: cronologia piena
       ========================================================= -->
  <div
    class="modal"
    id="modal-history-full"
    role="dialog"
    aria-modal="true"
    aria-labelledby="modal-history-full-title"
    hidden
  >
    <div class="modal__backdrop" data-close="1"></div>
    <div class="modal__panel">
      <header class="modal__header">
        <h2 class="modal__title" id="modal-history-full-title">Cronologia piena</h2>
      </header>
      <div class="modal__body" id="modal-history-full-body">
        <!-- popolato da ui.js a seconda della modalità -->
      </div>
      <footer class="modal__footer" id="modal-history-full-footer">
        <!-- pulsanti popolati da ui.js -->
      </footer>
    </div>
  </div>
```

- [ ] **Step 3:** Commit
```bash
git add index.html
git commit -m "feat: markup sheet cronologia + modale overflow"
```

---

## Task 5: CSS

**Files:**
- Modify: `css/style.css`

- [ ] **Step 1:** Aggiungere alla fine del file:

```css
/* ========================================================
   Cronologia percorsi
   ======================================================== */

.sheet--history {
  z-index: 25;
}

.sheet__title-counter {
  font-size: 0.85em;
  font-weight: 400;
  color: var(--c-text-muted, #777);
  margin-left: 0.5rem;
}

.history-prefs {
  border: 1px solid var(--c-border, #e0e0d8);
  border-radius: 8px;
  padding: 0.6rem 0.75rem;
  margin: 0 0 1rem 0;
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem 1rem;
  align-items: center;
  background: var(--c-surface-2, #fafaf6);
}

.history-prefs__legend {
  padding: 0 0.4rem;
  font-size: 0.85rem;
  color: var(--c-text-muted, #777);
}

.history-prefs__option {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.9rem;
  cursor: pointer;
}

.history-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.history-list[hidden] { display: none; }

.history-card {
  border: 1px solid var(--c-border, #e0e0d8);
  border-radius: 10px;
  padding: 0.75rem 0.85rem;
  background: var(--c-surface, #fff);
  display: grid;
  grid-template-columns: 1fr auto;
  grid-template-rows: auto auto;
  gap: 0.25rem 0.5rem;
  cursor: pointer;
  transition: background 0.15s ease, border-color 0.15s ease;
}

.history-card:hover,
.history-card:focus-within {
  background: var(--c-surface-2, #fafaf6);
  border-color: var(--c-primary, #2d5016);
}

.history-card__label {
  font-weight: 600;
  font-size: 0.95rem;
  color: var(--c-text, #222);
  grid-column: 1;
  grid-row: 1;
}

.history-card__meta {
  font-size: 0.8rem;
  color: var(--c-text-muted, #777);
  grid-column: 1;
  grid-row: 2;
}

.history-card__actions {
  grid-column: 2;
  grid-row: 1 / span 2;
  display: flex;
  align-items: center;
  gap: 0.25rem;
}

.history-card__action {
  background: transparent;
  border: 0;
  width: 32px;
  height: 32px;
  padding: 0;
  border-radius: 6px;
  cursor: pointer;
  font-size: 1.1rem;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.history-card__action:hover {
  background: var(--c-surface-2, #f0f0e8);
}

.history-empty {
  text-align: center;
  color: var(--c-text-muted, #777);
  padding: 2rem 1rem;
  margin: 0;
}

.history-empty[hidden] { display: none; }

.history-footer {
  margin-top: 1.25rem;
  display: flex;
  justify-content: center;
}

.btn--danger {
  color: #b00020;
}

/* ========================================================
   Modale generica + history-full
   ======================================================== */

.modal[hidden] { display: none; }

.modal {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
}

.modal__backdrop {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
}

.modal__panel {
  position: relative;
  background: var(--c-surface, #fff);
  border-radius: 12px;
  max-width: 480px;
  width: 100%;
  max-height: 85vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 20px 50px rgba(0, 0, 0, 0.25);
}

.modal__header {
  padding: 1rem 1.25rem 0.5rem;
}

.modal__title {
  margin: 0;
  font-size: 1.05rem;
}

.modal__body {
  padding: 0.75rem 1.25rem;
  overflow-y: auto;
  flex: 1;
}

.modal__body p {
  margin: 0 0 0.75rem 0;
}

.modal__footer {
  padding: 0.75rem 1.25rem 1rem;
  display: flex;
  gap: 0.5rem;
  justify-content: flex-end;
  flex-wrap: wrap;
}

.modal__choice-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.modal__choice-list label {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  padding: 0.4rem 0.5rem;
  border-radius: 6px;
  cursor: pointer;
  font-size: 0.9rem;
}

.modal__choice-list label:hover {
  background: var(--c-surface-2, #fafaf6);
}
```

- [ ] **Step 2:** Commit
```bash
git add css/style.css
git commit -m "feat: stili cronologia + modali"
```

---

## Task 6: UI wiring in ui.js

**Files:**
- Modify: `js/ui.js`

- [ ] **Step 1:** Aggiungere import in cima:

```js
import * as routeHistory from './services/routeHistory.js';
```

- [ ] **Step 2:** Nell'oggetto `elements` (dopo `menuReset`), aggiungere:

```js
    menuHistory: document.getElementById('menu-history'),
    sheetHistory: document.getElementById('sheet-history'),
    sheetHistoryClose: document.getElementById('sheet-history-close'),
    historyList: document.getElementById('history-list'),
    historyEmpty: document.getElementById('history-empty'),
    historyCounter: document.getElementById('history-counter'),
    historyPrefFifo: document.getElementById('history-pref-fifo'),
    historyPrefManual: document.getElementById('history-pref-manual'),
    btnHistoryClear: document.getElementById('btn-history-clear'),
    modalHistoryFull: document.getElementById('modal-history-full'),
    modalHistoryFullBody: document.getElementById('modal-history-full-body'),
    modalHistoryFullFooter: document.getElementById('modal-history-full-footer'),
```

- [ ] **Step 3:** Aggiungere funzioni helper (es. prima della funzione `init` o dentro `init` prima del return — cerca pattern coerente con altre funzioni helper). Inserire dentro `init` dopo le altre funzioni helper interne:

```js
  /* ===== Cronologia percorsi ===== */

  let pendingHistoryEntry = null;

  function formatHistoryDate(iso) {
    try {
      const d = new Date(iso);
      const MESI = ['gen','feb','mar','apr','mag','giu','lug','ago','set','ott','nov','dic'];
      return `${d.getDate()} ${MESI[d.getMonth()]} ${d.getFullYear()}`;
    } catch {
      return '';
    }
  }

  function profileLabel(p) {
    const map = {
      safety: 'Evita traffico',
      trekking: 'Trekking',
      gravel: 'Gravel',
      fastbike: 'Strada',
      mtb: 'MTB',
    };
    return map[p] || p;
  }

  function formatHistoryEntryLabel(entry) {
    if (entry.customName) return entry.customName;
    const date = formatHistoryDate(entry.createdAt);
    const km = Number.isFinite(entry.stats?.distanceKm)
      ? `${entry.stats.distanceKm.toFixed(1)} km` : '–';
    return `${date} · ${km} · ${profileLabel(entry.profile)}`;
  }

  function formatHistoryEntryMeta(entry) {
    const tappe = entry.waypoints.length === 1 ? 'anello' : `${entry.waypoints.length} tappe`;
    const ascent = Number.isFinite(entry.stats?.ascentM)
      ? `${Math.round(entry.stats.ascentM)} m disliv.` : null;
    return [tappe, ascent].filter(Boolean).join(' · ');
  }

  function renderHistory() {
    if (!elements.historyList) return;
    const entries = routeHistory.list();
    elements.historyCounter && (elements.historyCounter.textContent = `(${entries.length}/${routeHistory.MAX})`);

    if (entries.length === 0) {
      elements.historyList.innerHTML = '';
      elements.historyList.hidden = true;
      if (elements.historyEmpty) elements.historyEmpty.hidden = false;
      return;
    }
    elements.historyList.hidden = false;
    if (elements.historyEmpty) elements.historyEmpty.hidden = true;

    elements.historyList.innerHTML = entries.map((e) => `
      <li class="history-card" data-id="${escapeHtml(e.id)}" tabindex="0" role="button" aria-label="Carica percorso: ${escapeHtml(formatHistoryEntryLabel(e))}">
        <div class="history-card__label">${escapeHtml(formatHistoryEntryLabel(e))}</div>
        <div class="history-card__meta">${escapeHtml(formatHistoryEntryMeta(e))}</div>
        <div class="history-card__actions">
          <button type="button" class="history-card__action" data-action="rename" data-id="${escapeHtml(e.id)}" aria-label="Rinomina percorso">✎</button>
          <button type="button" class="history-card__action" data-action="delete" data-id="${escapeHtml(e.id)}" aria-label="Elimina percorso">🗑</button>
        </div>
      </li>
    `).join('');
  }

  function syncHistoryPrefRadios() {
    const pref = routeHistory.getPreference();
    if (elements.historyPrefFifo) elements.historyPrefFifo.checked = pref === 'fifo';
    if (elements.historyPrefManual) elements.historyPrefManual.checked = pref === 'manual';
  }

  function openHistorySheet() {
    if (!elements.sheetHistory) return;
    if (!routeHistory.isStorageAvailable()) {
      showToast('Cronologia non disponibile (storage bloccato dal browser).', 'error');
      return;
    }
    renderHistory();
    syncHistoryPrefRadios();
    elements.sheetHistory.hidden = false;
    elements.sheetHistory.setAttribute('data-state', 'open');
  }

  function closeHistorySheet() {
    if (!elements.sheetHistory) return;
    elements.sheetHistory.hidden = true;
  }

  function handleHistoryListClick(e) {
    const actionBtn = e.target.closest('[data-action]');
    if (actionBtn) {
      e.stopPropagation();
      const id = actionBtn.getAttribute('data-id');
      const action = actionBtn.getAttribute('data-action');
      if (action === 'rename') {
        const current = routeHistory.get(id);
        const nuovo = window.prompt('Nuovo nome del percorso (vuoto = rimuove il nome):', current?.customName || '');
        if (nuovo !== null) {
          routeHistory.rename(id, nuovo);
        }
      } else if (action === 'delete') {
        if (window.confirm('Eliminare questo percorso dalla cronologia?')) {
          routeHistory.remove(id);
        }
      }
      return;
    }
    const card = e.target.closest('.history-card');
    if (card) {
      const id = card.getAttribute('data-id');
      const entry = routeHistory.get(id);
      if (entry) {
        stateModule.loadFromHistoryEntry(entry);
        closeHistorySheet();
        showToast('Percorso caricato — calcolo in corso…', 'info');
      }
    }
  }

  function handleHistoryClear() {
    if (!window.confirm('Svuotare TUTTA la cronologia? L\'azione non è reversibile.')) return;
    routeHistory.clear();
  }

  function handleHistoryPrefChange(e) {
    const val = e.target?.value;
    if (val === 'fifo' || val === 'manual') {
      routeHistory.setPreference(val);
      showToast(val === 'fifo'
        ? 'Cronologia: auto-eliminerò i più vecchi.'
        : 'Cronologia: chiederò a te ogni volta.', 'success');
    }
  }

  /* Modale "cronologia piena" */
  function showModal(modal) {
    if (modal) modal.hidden = false;
  }
  function hideModal(modal) {
    if (modal) modal.hidden = true;
  }

  function onHistoryFull(addResult) {
    pendingHistoryEntry = addResult.pendingEntry;
    const pref = routeHistory.getPreference();
    if (pref === null) {
      renderModalChoosePreference();
    } else {
      renderModalManualPrune();
    }
    showModal(elements.modalHistoryFull);
  }

  function renderModalChoosePreference() {
    if (!elements.modalHistoryFullBody || !elements.modalHistoryFullFooter) return;
    elements.modalHistoryFullBody.innerHTML = `
      <p>Hai raggiunto i ${routeHistory.MAX} percorsi salvati. Come vuoi gestire i prossimi?</p>
    `;
    elements.modalHistoryFullFooter.innerHTML = `
      <button type="button" class="btn btn--primary" id="pref-fifo-btn">Auto-elimina i più vecchi</button>
      <button type="button" class="btn btn--ghost" id="pref-manual-btn">Decido io ogni volta</button>
    `;
    document.getElementById('pref-fifo-btn')?.addEventListener('click', () => {
      routeHistory.setPreference('fifo');
      retryPendingAdd();
    }, { once: true });
    document.getElementById('pref-manual-btn')?.addEventListener('click', () => {
      routeHistory.setPreference('manual');
      hideModal(elements.modalHistoryFull);
      renderModalManualPrune();
      showModal(elements.modalHistoryFull);
    }, { once: true });
  }

  function renderModalManualPrune() {
    if (!elements.modalHistoryFullBody || !elements.modalHistoryFullFooter) return;
    const entries = routeHistory.list();
    elements.modalHistoryFullBody.innerHTML = `
      <p>Cronologia piena (${entries.length}/${routeHistory.MAX}). Seleziona quali percorsi eliminare per salvare il nuovo, oppure annulla.</p>
      <ul class="modal__choice-list">
        ${entries.map((e) => `
          <li>
            <label>
              <input type="checkbox" value="${escapeHtml(e.id)}" />
              <span>${escapeHtml(formatHistoryEntryLabel(e))}</span>
            </label>
          </li>
        `).join('')}
      </ul>
    `;
    elements.modalHistoryFullFooter.innerHTML = `
      <button type="button" class="btn btn--ghost" id="prune-cancel">Annulla</button>
      <button type="button" class="btn btn--primary" id="prune-confirm">Elimina selezionati e salva</button>
    `;
    document.getElementById('prune-cancel')?.addEventListener('click', () => {
      pendingHistoryEntry = null;
      hideModal(elements.modalHistoryFull);
      showToast('Percorso visualizzato ma non salvato in cronologia.', 'info');
    }, { once: true });
    document.getElementById('prune-confirm')?.addEventListener('click', () => {
      const ids = Array.from(elements.modalHistoryFullBody.querySelectorAll('input[type="checkbox"]:checked'))
        .map((cb) => cb.value);
      if (ids.length === 0) {
        showToast('Seleziona almeno un percorso da eliminare.', 'error');
        return;
      }
      routeHistory.removeMany(ids);
      retryPendingAdd();
    }, { once: true });
  }

  function retryPendingAdd() {
    if (!pendingHistoryEntry) {
      hideModal(elements.modalHistoryFull);
      return;
    }
    const res = routeHistory.add(pendingHistoryEntry);
    pendingHistoryEntry = null;
    hideModal(elements.modalHistoryFull);
    if (res.added) {
      showToast('Percorso salvato in cronologia.', 'success');
    } else {
      showToast('Impossibile salvare in cronologia.', 'error');
    }
  }
```

- [ ] **Step 4:** Wire-up degli event listener. Cerca la sezione di setup listener (dopo `if (elements.menuReset) { ... }`, ~r544 in ui.js). Aggiungere:

```js
    if (elements.menuHistory) {
      elements.menuHistory.addEventListener('click', () => {
        elements.menuPopover && (elements.menuPopover.hidden = true);
        elements.menuBtn && elements.menuBtn.setAttribute('aria-expanded', 'false');
        openHistorySheet();
      });
    }
    if (elements.sheetHistoryClose) {
      elements.sheetHistoryClose.addEventListener('click', closeHistorySheet);
    }
    if (elements.historyList) {
      elements.historyList.addEventListener('click', handleHistoryListClick);
      elements.historyList.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          const card = e.target.closest?.('.history-card');
          if (card) { e.preventDefault(); handleHistoryListClick({ target: card, stopPropagation() {} }); }
        }
      });
    }
    if (elements.btnHistoryClear) {
      elements.btnHistoryClear.addEventListener('click', handleHistoryClear);
    }
    if (elements.historyPrefFifo) elements.historyPrefFifo.addEventListener('change', handleHistoryPrefChange);
    if (elements.historyPrefManual) elements.historyPrefManual.addEventListener('change', handleHistoryPrefChange);
    if (elements.modalHistoryFull) {
      elements.modalHistoryFull.addEventListener('click', (e) => {
        if (e.target.matches('[data-close]')) {
          pendingHistoryEntry = null;
          hideModal(elements.modalHistoryFull);
        }
      });
    }

    // Re-render automatico cronologia quando cambia
    routeHistory.subscribe(() => {
      if (elements.sheetHistory && !elements.sheetHistory.hidden) {
        renderHistory();
      }
    });
```

- [ ] **Step 5:** Esporre `onHistoryFull` nell'oggetto restituito da `init()`. Cerca dove `init` ritorna `{ ... }` (probabilmente verso la fine del file). Aggiungere `onHistoryFull` tra le proprietà esportate:

```js
  return {
    // ... altre proprietà esistenti
    showToast,
    onHistoryFull,
    // ... altre
  };
```

- [ ] **Step 6:** Se la voce "Cronologia" deve essere nascosta quando localStorage non è disponibile, aggiungere in fondo a init (prima del return):

```js
    if (elements.menuHistory && !routeHistory.isStorageAvailable()) {
      elements.menuHistory.hidden = true;
    }
```

- [ ] **Step 7:** Commit
```bash
git add js/ui.js
git commit -m "feat: UI cronologia (sheet, list, modali, prefs)"
```

---

## Task 7: Service Worker (cache bump + nuovo asset)

**Files:**
- Modify: `sw.js`

- [ ] **Step 1:** Cambiare `SHELL_CACHE` da `ciclovia-shell-v4` a `ciclovia-shell-v5`

- [ ] **Step 2:** Aggiungere `'./js/services/routeHistory.js'` all'array `SHELL_ASSETS` (sezione `/* services */`)

- [ ] **Step 3:** Commit
```bash
git add sw.js
git commit -m "chore: SW v5 per includere routeHistory.js"
```

---

## Task 8: Push + verifica live + screenshot

- [ ] **Step 1:** Push:
```bash
git remote set-url origin "https://x-access-token:<TOKEN>@github.com/Gunlux23/ciclovia.git"
git push origin main
git remote set-url origin "https://github.com/Gunlux23/ciclovia.git"
```
Token dal file `C:\progetti\credenziali.txt` (entry `[2026-05-19] GitHub MCP — fine-grained PAT (Gunlux23) [ATTIVO]`).

- [ ] **Step 2:** Aspetta deploy:
```bash
until curl -s https://gunlux23.github.io/ciclovia/js/services/routeHistory.js | head -3 | grep -q STORAGE_KEY; do sleep 5; done
echo "Deploy OK"
```

- [ ] **Step 3:** Verifica via Playwright MCP:
   1. Navigate `https://gunlux23.github.io/ciclovia/?_=<timestamp>` (cache buster)
   2. Disinstalla SW vecchio + clear caches via `browser_evaluate`
   3. Reload
   4. Apri menu hamburger → conferma che c'è "Cronologia"
   5. Apri cronologia → conferma vista vuota corretta
   6. Aggiungi 2 waypoints sulla mappa, attendi calcolo
   7. Apri cronologia → conferma entry presente con label corretta
   8. Tap su entry → conferma waypoints caricati + sheet chiuso + calcolo triggera
   9. Test rename: click matita → prompt → cambia → verifica label custom
   10. Test delete: click cestino → confirm → verifica scomparsa
   11. Test svuota: bottone "Svuota cronologia" → verifica lista vuota

- [ ] **Step 4:** Se trovati bug, fix + commit + push + re-verify.

---

## Self-Review

**Spec coverage:**
- RF1 (auto-add) → Task 3 ✓
- RF2 (limite 30) → routeHistory.add() in Task 1 ✓
- RF3 (prima modale scelta pref) → renderModalChoosePreference in Task 6 ✓
- RF4 (pref persistente) → routeHistory.setPreference in Task 1 + UI radio Task 4/6 ✓
- RF5 (tap → carica) → handleHistoryListClick in Task 6 ✓
- RF6 (ricalcolo crea nuovo entry) → Task 3 (chiamato sempre) ✓
- RF7 (label auto) → formatHistoryEntryLabel Task 6 ✓
- RF8 (rinomina matita) → handleHistoryListClick Task 6 ✓
- RF9 (elimina singolo) → handleHistoryListClick Task 6 ✓
- RF10 (svuota tutto) → handleHistoryClear Task 6 ✓
- RF11 (voce menu) → Task 4 markup + Task 6 handler ✓

**Placeholder scan:** Nessun TBD/TODO. Tutti i blocchi di codice sono completi.

**Type consistency:** `routeHistory.MAX` esportata in Task 1, usata in Task 6. `pendingEntry` campo restituito in Task 1 (`add()`), usato in Task 6 (`onHistoryFull`). Nomi consistenti.

**Edge case "voce menu nascosta quando storage non disponibile"** → Task 6 Step 6 lo gestisce ✓.

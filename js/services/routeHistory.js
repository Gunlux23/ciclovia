/* =========================================================
   Ciclovia — routeHistory
   Cronologia persistente dei percorsi calcolati.
   Storage separato dallo state: ciclovia.routes.v1
   Max 30 entry; overflow gestito da preference 'fifo' | 'manual' | null.
   ========================================================= */

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
        ? parsed.preference
        : null,
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

const STORAGE_KEY = 'ciclovia.v1';

const initialState = {
  waypoints: [],
  profile: 'safety',
  route: null,
  status: 'idle',
  error: null,
  // Distanza target (feature opzionale).
  // Quando enabled è false, il routing è esattamente quello tradizionale.
  // Quando enabled è true e c'è 1 waypoint  → modalità anello.
  // Quando enabled è true e ci sono ≥2 waypoint → modalità estensione.
  // loopSeed è l'angolo iniziale per la modalità anello: ogni "Altro giro"
  // lo incrementa di un random in [0.5, 1.5] rad per cambiare zona.
  targetDistanceEnabled: false,
  targetDistanceKm: 30,
  loopSeed: 0,
};

let state = { ...initialState };
const subscribers = new Set();

function deepCopy(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(deepCopy);
  const out = {};
  for (const k of Object.keys(value)) out[k] = deepCopy(value[k]);
  return out;
}

function loadFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      waypoints: Array.isArray(parsed.waypoints) ? parsed.waypoints : [],
      profile: typeof parsed.profile === 'string' ? parsed.profile : 'trekking',
      targetDistanceEnabled: parsed.targetDistanceEnabled === true,
      targetDistanceKm: Number.isFinite(parsed.targetDistanceKm)
        ? Math.max(5, parsed.targetDistanceKm)
        : 30,
    };
  } catch {
    return null;
  }
}

function persist() {
  try {
    const payload = JSON.stringify({
      waypoints: state.waypoints,
      profile: state.profile,
      targetDistanceEnabled: state.targetDistanceEnabled,
      targetDistanceKm: state.targetDistanceKm,
    });
    localStorage.setItem(STORAGE_KEY, payload);
  } catch {
    // storage may be unavailable (private mode, quota): degrade silently
  }
}

function loadFromUrl() {
  if (typeof window === 'undefined' || !window.location) return null;
  const params = new URLSearchParams(window.location.search);
  const encoded = params.get('p');
  if (!encoded) return null;
  try {
    // local import to avoid circular dep at module load
    const json = decodeURIComponent(escape(atob(encoded.replace(/-/g, '+').replace(/_/g, '/'))));
    const data = JSON.parse(json);
    if (!data || typeof data !== 'object') return null;
    const waypoints = Array.isArray(data.w)
      ? data.w.map((w, i) => ({
          id: w.id || `w${Date.now()}_${i}`,
          lat: Number(w.lat),
          lon: Number(w.lon),
          label: w.label || '',
          source: w.source || 'share',
        }))
      : [];
    return {
      waypoints,
      profile: typeof data.p === 'string' ? data.p : 'trekking',
    };
  } catch {
    return null;
  }
}

function bootstrap() {
  const fromUrl = loadFromUrl();
  if (fromUrl) {
    state = { ...initialState, ...fromUrl };
    return;
  }
  const fromStorage = loadFromStorage();
  if (fromStorage) {
    state = { ...initialState, ...fromStorage };
  }
}

bootstrap();

export function getState() {
  return deepCopy(state);
}

export function update(patch) {
  const previous = deepCopy(state);
  state = { ...state, ...patch };
  if (
    'waypoints' in patch ||
    'profile' in patch ||
    'targetDistanceEnabled' in patch ||
    'targetDistanceKm' in patch
  ) {
    persist();
  }
  for (const fn of subscribers) {
    fn(deepCopy(state), previous);
  }
}

export function subscribe(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

function nextId() {
  return `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function addWaypoint(wp) {
  const waypoint = {
    id: wp.id || nextId(),
    lat: Number(wp.lat),
    lon: Number(wp.lon),
    label: wp.label || '',
    source: wp.source || 'tap',
  };
  update({ waypoints: [...state.waypoints, waypoint] });
  return waypoint;
}

export function removeWaypoint(id) {
  update({ waypoints: state.waypoints.filter((w) => w.id !== id) });
}

export function updateWaypoint(id, patch) {
  update({
    waypoints: state.waypoints.map((w) => (w.id === id ? { ...w, ...patch } : w)),
  });
}

export function reorderWaypoints(idsArray) {
  const map = new Map(state.waypoints.map((w) => [w.id, w]));
  const reordered = idsArray.map((id) => map.get(id)).filter(Boolean);
  if (reordered.length !== state.waypoints.length) return;
  update({ waypoints: reordered });
}

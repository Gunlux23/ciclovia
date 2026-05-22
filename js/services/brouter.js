const BROUTER_URL = 'https://brouter.de/brouter';
const TIMEOUT_MS = 15000;

// Mappa profilo UI → profilo BRouter base. Per "safety" (UI "Evita Traffico")
// si applica una logica speciale di cascata: vedi fetchRoute() più sotto.
const PROFILE_MAP = {
  safety: 'safety',                           // base, ma sovrascritto dalla cascata
  'fastbike-lowtraffic': 'fastbike-lowtraffic',
  trekking: 'trekking',
  gravel: 'gravel',
  fastbike: 'fastbike',
  road: 'fastbike',
  mtb: 'mtb',
};

// "Evita Traffico": cascata di profili BRouter da provare, in ordine.
// Ognuno viene tentato prima senza e poi con nogos sui tratti trafficati.
// Si esce appena uno produce un percorso con ≤ 0.1% di metri su strade
// primary/trunk/secondary (no bicycle=designated).
const ANTI_TRAFFIC_CASCADE = [
  'fastbike-lowtraffic',  // primo: low-traffic asfaltato
  'gravel',               // poi sterrato/strade bianche
  'mtb',                  // ultimo: sentieri + sterrati estremi
];
const BUSY_THRESHOLD_RATIO = 0.001;       // 0.1% di metri su strade trafficate
const BUSY_NOGO_CLUSTER_M = 80;           // distanza max per stessa zona da vietare
const BUSY_NOGO_MIN_RADIUS_M = 50;
const BUSY_NOGO_MAX_RADIUS_M = 200;
const BUSY_NOGO_BUFFER_M = 30;
const BUSY_NOGO_MAX_COUNT = 6;

export class RouteNotFoundError extends Error {
  constructor(message, rawDetail) {
    super(message);
    this.name = 'RouteNotFoundError';
    this.rawDetail = rawDetail;
  }
}

export class RouteServiceError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'RouteServiceError';
    this.status = status;
  }
}

function buildUrl(waypoints, brouterProfile, nogos) {
  const lonlats = waypoints.map((w) => `${w.lon},${w.lat}`).join('|');
  const params = new URLSearchParams({
    lonlats,
    profile: brouterProfile,
    alternativeidx: '0',
    format: 'geojson',
  });
  if (Array.isArray(nogos) && nogos.length > 0) {
    const nogoStr = nogos
      .map((n) => `${n.lon.toFixed(6)},${n.lat.toFixed(6)},${Math.round(n.radiusM || 50)}`)
      .join('|');
    params.set('nogos', nogoStr);
  }
  return `${BROUTER_URL}?${params.toString()}`;
}

// Chiamata diretta a BRouter con un profilo specifico. Niente cascata.
async function fetchRouteRaw(waypoints, brouterProfile, nogos) {
  if (!Array.isArray(waypoints) || waypoints.length < 2) {
    throw new RouteServiceError('Servono almeno due punti per calcolare un percorso.');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let response;
  try {
    response = await fetch(buildUrl(waypoints, brouterProfile, nogos), {
      method: 'GET',
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      throw new RouteServiceError('Timeout: il servizio di routing non risponde.');
    }
    throw new RouteServiceError(`Errore di rete: ${err.message}`);
  }
  clearTimeout(timer);

  const text = await response.text();
  const snippet = text.slice(0, 200).trim();
  const looksLikeJson = /^\s*[\[{]/.test(text);

  if (!response.ok) {
    throw new RouteServiceError(`BRouter ${response.status}: ${snippet}`, response.status);
  }

  if (!looksLikeJson) {
    if (/^\s*</.test(text)) {
      throw new RouteServiceError(`Risposta HTML inattesa: ${snippet}`);
    }
    if (/not\s*mapped|no\s*route\s*found/i.test(text)) {
      throw new RouteNotFoundError(snippet || 'Punto non raggiungibile.', snippet);
    }
    throw new RouteServiceError(`Risposta inattesa: ${snippet}`);
  }

  let data;
  try { data = JSON.parse(text); }
  catch { throw new RouteServiceError(`Risposta non interpretabile: ${snippet}`); }

  const feature = data.features && data.features[0];
  if (!feature || !feature.geometry) {
    throw new RouteNotFoundError('BRouter non ha restituito una geometria valida.', snippet);
  }

  const props = feature.properties || {};
  return {
    geojson: feature.geometry,
    properties: props,
    messages: props.messages || [],
  };
}

/* ============================================================
   Utility: misura "busy" e costruzione nogos
   ============================================================ */

// True per highway primary/trunk/secondary che NON sia bicycle=designated.
function isBusyTags(wayTagsStr) {
  const tags = Object.create(null);
  for (const part of (wayTagsStr || '').split(/\s+/)) {
    const i = part.indexOf('=');
    if (i > 0) tags[part.slice(0, i)] = part.slice(i + 1);
  }
  const highway = (tags.highway || '').toLowerCase();
  const bicycle = (tags.bicycle || '').toLowerCase();
  if (bicycle === 'designated') return false;
  return highway === 'primary' || highway === 'trunk' || highway === 'secondary';
}

function haversineM(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const x = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

// Analizza la response: somma metri busy/total e ritorna anche le coordinate
// dei tratti trafficati per la costruzione dei nogos.
function analyzeBusyResponse(resp) {
  const messages = resp.messages;
  if (!Array.isArray(messages) || messages.length < 3) {
    return { busy: 0, total: 0, busyCoords: [] };
  }
  const header = messages[0];
  if (!Array.isArray(header)) return { busy: 0, total: 0, busyCoords: [] };
  const lonIdx = header.indexOf('Longitude');
  const latIdx = header.indexOf('Latitude');
  const wayIdx = header.indexOf('WayTags');
  if (lonIdx < 0 || latIdx < 0 || wayIdx < 0) {
    return { busy: 0, total: 0, busyCoords: [] };
  }

  let busy = 0;
  let total = 0;
  const busyCoords = [];
  let prev = null;
  for (let r = 1; r < messages.length; r++) {
    const row = messages[r];
    if (!Array.isArray(row)) continue;
    const lon = parseInt(row[lonIdx], 10) / 1e6;
    const lat = parseInt(row[latIdx], 10) / 1e6;
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) { prev = null; continue; }
    const isBusy = isBusyTags(String(row[wayIdx] || ''));
    if (prev) {
      const d = haversineM(prev, { lat, lon });
      total += d;
      if (isBusy) {
        busy += d;
        // Punto centrale del segmento busy (per i nogos)
        busyCoords.push({
          lat: (prev.lat + lat) / 2,
          lon: (prev.lon + lon) / 2,
        });
      }
    }
    prev = { lat, lon };
  }
  return { busy, total, busyCoords };
}

// Cluster grow-from-seed dei punti busy → centroidi con raggio per i nogos.
function buildBusyNogos(busyCoords) {
  if (!busyCoords || busyCoords.length === 0) return [];
  const used = new Array(busyCoords.length).fill(false);
  const clusters = [];

  for (let i = 0; i < busyCoords.length; i++) {
    if (used[i]) continue;
    const cluster = [busyCoords[i]];
    used[i] = true;
    for (let g = 0; g < cluster.length; g++) {
      for (let j = i + 1; j < busyCoords.length; j++) {
        if (used[j]) continue;
        if (haversineM(cluster[g], busyCoords[j]) <= BUSY_NOGO_CLUSTER_M) {
          cluster.push(busyCoords[j]);
          used[j] = true;
        }
      }
    }
    if (cluster.length >= 1) clusters.push(cluster);
  }

  const nogos = clusters.map((cluster) => {
    const lat = cluster.reduce((s, c) => s + c.lat, 0) / cluster.length;
    const lon = cluster.reduce((s, c) => s + c.lon, 0) / cluster.length;
    let maxDist = 0;
    for (const p of cluster) maxDist = Math.max(maxDist, haversineM({ lat, lon }, p));
    const radiusM = Math.min(
      BUSY_NOGO_MAX_RADIUS_M,
      Math.max(BUSY_NOGO_MIN_RADIUS_M, maxDist + BUSY_NOGO_BUFFER_M),
    );
    return { lat, lon, radiusM, size: cluster.length };
  });

  nogos.sort((a, b) => b.size - a.size);
  return nogos.slice(0, BUSY_NOGO_MAX_COUNT).map(({ lat, lon, radiusM }) => ({ lat, lon, radiusM }));
}

/* ============================================================
   API pubblica
   ============================================================ */

// Calcola un percorso. Per UI profile='safety' (Evita Traffico) applica una
// cascata anti-traffico (fastbike-lowtraffic → gravel → mtb, ognuno con
// eventuale retry+nogos). Per altri profili, chiamata diretta.
export async function fetchRoute(waypoints, profile, options = {}) {
  if (profile !== 'safety') {
    // Profili "normali": comportamento standard
    const brouterProfile = PROFILE_MAP[profile] || 'trekking';
    return fetchRouteRaw(waypoints, brouterProfile, options.nogos);
  }

  // === Modalità "Evita Traffico" — cascata anti-traffico ===
  // Combinazione dei nogos esterni (es. dal trim del loop) con quelli generati.
  const externalNogos = options.nogos || [];

  let bestResp = null;
  let bestRatio = Infinity;

  for (const brouterProfile of ANTI_TRAFFIC_CASCADE) {
    let nogos = [...externalNogos];

    for (let attempt = 0; attempt < 2; attempt++) {
      let resp;
      try {
        resp = await fetchRouteRaw(waypoints, brouterProfile, nogos);
      } catch (err) {
        // Profilo o nogos troppo restrittivi → vai al prossimo
        if (err.name === 'RouteNotFoundError') break;
        if (err.name === 'RouteServiceError') {
          // Errore di rete/server: rilancia subito senza continuare la cascata
          throw err;
        }
        break;
      }

      const { busy, total } = analyzeBusyResponse(resp);
      const ratio = total > 0 ? busy / total : 0;

      if (ratio < bestRatio) {
        bestRatio = ratio;
        bestResp = resp;
      }

      // Sotto soglia → restituisci subito
      if (ratio <= BUSY_THRESHOLD_RATIO) return resp;

      // Sopra soglia: aggiungo nogos sui tratti busy e ritento (max 1 retry/profilo)
      if (attempt === 0) {
        const { busyCoords } = analyzeBusyResponse(resp);
        const newNogos = buildBusyNogos(busyCoords);
        if (newNogos.length === 0) break;
        nogos = [...externalNogos, ...newNogos];
      }
    }
  }

  // Cascata esaurita: restituisci il tentativo con minor % trafficate
  if (bestResp) return bestResp;
  throw new RouteNotFoundError('Nessun percorso trovato per la modalità Evita Traffico.');
}

const BROUTER_URL = 'https://brouter.de/brouter';
const TIMEOUT_MS = 15000;

const PROFILE_MAP = {
  // "Evita traffico" → safety: profilo BRouter pensato esplicitamente per evitare
  // il traffico (preferisce ciclabili, strade secondarie, anche al costo di
  // deviazioni più lunghe). Richiesta utente: meglio +10/20% di km che strade
  // trafficate. Se safety non trova nulla, la fallback chain in app.js prova
  // 'fastbike-lowtraffic' (compromesso) e poi profili più permissivi.
  safety: 'safety',
  // Profilo "interno" non esposto in UI: usato dal solo fallback per "Evita traffico"
  // quando safety puro fallisce. Tradeoff tra evita-traffico e diretto.
  'fastbike-lowtraffic': 'fastbike-lowtraffic',
  trekking: 'trekking',
  gravel: 'gravel',
  fastbike: 'fastbike',
  road: 'fastbike',
  mtb: 'mtb',
};

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

function buildUrl(waypoints, profile, nogos) {
  const lonlats = waypoints.map((w) => `${w.lon},${w.lat}`).join('|');
  const brouterProfile = PROFILE_MAP[profile] || 'trekking';
  const params = new URLSearchParams({
    lonlats,
    profile: brouterProfile,
    alternativeidx: '0',
    format: 'geojson',
  });
  // nogos: array di { lat, lon, radiusM } — zone vietate al routing.
  // Sintassi BRouter: nogos=lon,lat,radius|lon,lat,radius (radius in metri).
  if (Array.isArray(nogos) && nogos.length > 0) {
    const nogoStr = nogos
      .map((n) => `${n.lon.toFixed(6)},${n.lat.toFixed(6)},${Math.round(n.radiusM || 50)}`)
      .join('|');
    params.set('nogos', nogoStr);
  }
  return `${BROUTER_URL}?${params.toString()}`;
}

export async function fetchRoute(waypoints, profile, options = {}) {
  if (!Array.isArray(waypoints) || waypoints.length < 2) {
    throw new RouteServiceError('Servono almeno due punti per calcolare un percorso.');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let response;
  try {
    response = await fetch(buildUrl(waypoints, profile, options.nogos), {
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
    throw new RouteServiceError(
      `BRouter ${response.status}: ${snippet}`,
      response.status,
    );
  }

  // Solo se NON è JSON, prova a interpretare il testo come messaggio di errore.
  // BRouter ritorna testo plain (es. "from-position not mapped") quando un
  // waypoint non è agganciabile a una strada. Quando ritorna JSON, ci fidiamo:
  // il parsing successivo gestirà il caso di geometry mancante.
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
  try {
    data = JSON.parse(text);
  } catch {
    throw new RouteServiceError(`Risposta non interpretabile: ${snippet}`);
  }

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

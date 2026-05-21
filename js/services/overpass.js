// Più endpoint Overpass: l'istanza principale (overpass-api.de) ha rate limit
// stretti e va spesso in 429/504. Proviamo i mirror in sequenza finché uno risponde.
// Ordine: i mirror "kumi" e "private.coffee" sono spesso più reattivi del default.
// overpass-api.de è l'unico mirror con dati OSM aggiornati per i tag fontane:
// osm.ch ha un database statico molto vecchio e restituisce 0 elementi.
// Mettiamo i mirror "vivi" prima, e i mirror solo come ultima risorsa.
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
const TIMEOUT_MS = 12000;

// Cache in-memory per la durata della sessione: stessa bbox → niente seconda chiamata.
const cache = new Map(); // key: "minLat,minLon,maxLat,maxLon" → array

async function postWithFallback(query) {
  let lastErr = null;
  for (const url of OVERPASS_ENDPOINTS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `data=${encodeURIComponent(query)}`,
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (res.ok) return await res.json();
      // 429 / 504 / 5xx → prova il prossimo mirror
      lastErr = new Error(`Overpass HTTP ${res.status} (${new URL(url).host})`);
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
    }
  }
  throw lastErr || new Error('Tutti i mirror Overpass non rispondono.');
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function computeBboxFromGeoJSON(geojson, padM) {
  const coords = geojson?.coordinates || [];
  if (coords.length === 0) return null;
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;
  for (const c of coords) {
    const lon = c[0];
    const lat = c[1];
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
  }
  // ~111320 m per grado lat; lon scala con cos(lat).
  const latPad = padM / 111320;
  const midLat = (minLat + maxLat) / 2;
  const cos = Math.max(0.01, Math.cos((midLat * Math.PI) / 180));
  const lonPad = padM / (111320 * cos);
  return {
    minLat: minLat - latPad,
    maxLat: maxLat + latPad,
    minLon: minLon - lonPad,
    maxLon: maxLon + lonPad,
  };
}

/**
 * Cerca fontanelle entro `radiusM` da almeno un punto del percorso.
 * Ritorna un array `[{ lat, lon, name }]`. Su errori, throwa: il chiamante
 * deve gestire silenziosamente (è una feature di contorno).
 */
export async function findDrinkingWaterNearRoute(routeGeoJSON, { radiusM = 500 } = {}) {
  const coords = routeGeoJSON?.coordinates || [];
  if (coords.length === 0) return [];

  const bbox = computeBboxFromGeoJSON(routeGeoJSON, radiusM);
  if (!bbox) return [];

  // Overpass bbox order: (south, west, north, east) = (minLat, minLon, maxLat, maxLon)
  const bboxStr = `${bbox.minLat.toFixed(5)},${bbox.minLon.toFixed(5)},${bbox.maxLat.toFixed(5)},${bbox.maxLon.toFixed(5)}`;

  // Cache hit?
  if (cache.has(bboxStr)) return cache.get(bboxStr);

  // SOLO acqua potabile (richiesta utente). Escludiamo fontane decorative,
  // sorgenti non certificate, pozzi e rubinetti generici (potabilità non garantita).
  // Includiamo: amenity=drinking_water, man_made=drinking_fountain,
  // qualsiasi nodo con drinking_water=yes (esplicitamente potabile).
  // ESCLUDIAMO i nodi con drinking_water=no (fontane non potabili).
  const query = `[out:json][timeout:20];(nwr["amenity"="drinking_water"]["drinking_water"!="no"](${bboxStr});nwr["man_made"="drinking_fountain"]["drinking_water"!="no"](${bboxStr});nwr["drinking_water"="yes"](${bboxStr}););out tags center qt;`;

  const data = await postWithFallback(query);
  const elements = Array.isArray(data?.elements) ? data.elements : [];
  console.info(`[Overpass] Elementi grezzi: ${elements.length} (prima del filtro raggio ${radiusM}m)`);

  // Filtro Haversine: tieni solo se distanza minima da un punto del percorso ≤ radiusM.
  // Ottimizzazione: campiona il percorso (max ~2000 punti). I percorsi BRouter di solito
  // hanno migliaia di vertici densi: campionare aiuta senza degradare la precisione.
  const SAMPLE_MAX = 2000;
  const step = Math.max(1, Math.ceil(coords.length / SAMPLE_MAX));

  const out = [];
  for (const el of elements) {
    // node ha lat/lon diretti; way/relation hanno center: {lat, lon}
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    let minDist = Infinity;
    for (let i = 0; i < coords.length; i += step) {
      const c = coords[i];
      const d = haversineMeters(lat, lon, c[1], c[0]);
      if (d < minDist) {
        minDist = d;
        if (minDist <= radiusM) break;
      }
    }
    if (minDist <= radiusM) {
      const t = el.tags || {};
      const name = t.name || t['name:it'] || '';
      // Solo acqua potabile per richiesta utente: tutte sono potabili by query.
      out.push({ lat, lon, name, kind: 'Fontanella', potable: true });
    }
  }
  console.info(`[Overpass] Fontane entro ${radiusM}m: ${out.length}/${elements.length}`);
  cache.set(bboxStr, out);
  return out;
}

const PROFILE_SPEED_KMH = {
  safety: 16,
  trekking: 18,
  gravel: 16,
  fastbike: 22,
  mtb: 12,
};

const STERRATO_SURFACES = new Set([
  'gravel',
  'dirt',
  'ground',
  'unpaved',
  'sand',
  'compacted',
  'fine_gravel',
  'pebblestone',
  'grass',
  'earth',
  'mud',
]);

function haversine(a, b) {
  // [lon, lat] tuples; ignores elevation
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function parseMessages(rawMessages) {
  // BRouter messages structure:
  //   messages[0] = header array, e.g. ["Longitude","Latitude","Elevation","Distance","CostPerKm","ElevCost","TurnCost","NodeCost","InitialCost","WayTags","NodeTags","Time","Energy"]
  //   messages[1..] = rows aligned to the header
  if (!Array.isArray(rawMessages) || rawMessages.length < 2) return [];
  const header = rawMessages[0];
  const idx = {
    distance: header.indexOf('Distance'),
    wayTags: header.indexOf('WayTags'),
  };
  return rawMessages.slice(1).map((row) => ({
    distance: idx.distance >= 0 ? Number(row[idx.distance]) || 0 : 0,
    wayTags: idx.wayTags >= 0 ? String(row[idx.wayTags] || '') : '',
  }));
}

function classifySegment(wayTagsStr) {
  const tags = Object.create(null);
  for (const part of wayTagsStr.split(/\s+/)) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    tags[part.slice(0, i)] = part.slice(i + 1);
  }
  const surface = (tags.surface || '').toLowerCase();
  const highway = (tags.highway || '').toLowerCase();
  const bicycle = (tags.bicycle || '').toLowerCase();

  if (highway === 'cycleway' || bicycle === 'designated') return 'ciclabile';
  if (STERRATO_SURFACES.has(surface)) return 'sterrato';
  return 'asfaltoSecondario';
}

function buildElevationProfile(coords) {
  const elevation = [];
  if (!Array.isArray(coords) || coords.length === 0) return { elevation, totalMeters: 0, dPos: 0, dNeg: 0 };
  let cumulative = 0;
  let dPos = 0;
  let dNeg = 0;
  let prev = coords[0];
  elevation.push({ km: 0, ele: prev[2] ?? 0 });
  for (let i = 1; i < coords.length; i++) {
    const cur = coords[i];
    cumulative += haversine(prev, cur);
    const ele = cur[2] ?? elevation[elevation.length - 1].ele;
    const prevEle = prev[2] ?? ele;
    const diff = ele - prevEle;
    if (diff > 0) dPos += diff;
    else dNeg += -diff;
    elevation.push({ km: cumulative / 1000, ele });
    prev = cur;
  }
  return { elevation, totalMeters: cumulative, dPos, dNeg };
}

export function compute(brouterResponse) {
  const geojson = brouterResponse?.geojson;
  const coords = geojson?.coordinates || [];
  const props = brouterResponse?.properties || {};
  const rawMessages = brouterResponse?.messages || props.messages || [];

  const { elevation, totalMeters, dPos, dNeg } = buildElevationProfile(coords);

  const segments = parseMessages(rawMessages);
  const totals = { sterrato: 0, ciclabile: 0, asfaltoSecondario: 0 };
  let msgTotal = 0;
  for (const seg of segments) {
    const cat = classifySegment(seg.wayTags);
    totals[cat] += seg.distance;
    msgTotal += seg.distance;
  }

  const trackLength = Number(props['track-length']) || totalMeters;
  const km = trackLength / 1000;

  // Tempo: usa total-time di BRouter (modello fisico realistico che tiene conto
  // delle salite/discese e del profilo). Fallback a velocità fissa solo se mancante.
  let timeMin;
  let totalTimeSec = null;
  const rawTotalTime = props['total-time'];
  const parsedTotalTime = rawTotalTime != null ? parseInt(rawTotalTime, 10) : NaN;
  if (Number.isFinite(parsedTotalTime) && parsedTotalTime > 0) {
    totalTimeSec = parsedTotalTime;
    timeMin = Math.round(parsedTotalTime / 60);
  } else {
    const speed = PROFILE_SPEED_KMH[brouterResponse?.profile] || PROFILE_SPEED_KMH.trekking;
    timeMin = km > 0 ? Math.round((km / speed) * 60) : 0;
  }

  // Pendenza media: (dPos / distanza) * 100  →  dPos[m] / (km*1000) * 100  =  dPos / km / 10
  const gradeAvg = km > 0 ? Math.round((dPos / km / 10) * 10) / 10 : 0;

  // Pendenza massima: finestra mobile lungo l'elevation a ~200 m, massimo (deltaEle/window)*100.
  let gradeMax = 0;
  let eleMin = null;
  let eleMax = null;
  if (elevation.length > 1) {
    const WINDOW_M = 200;
    const winKm = WINDOW_M / 1000;
    for (let i = 0; i < elevation.length; i++) {
      const e = elevation[i].ele;
      if (Number.isFinite(e)) {
        if (eleMin === null || e < eleMin) eleMin = e;
        if (eleMax === null || e > eleMax) eleMax = e;
      }
    }
    let j = 0;
    for (let i = 0; i < elevation.length; i++) {
      while (j < elevation.length && elevation[j].km - elevation[i].km < winKm) j++;
      if (j >= elevation.length) break;
      const dKm = elevation[j].km - elevation[i].km;
      if (dKm <= 0) continue;
      const dEle = (elevation[j].ele ?? 0) - (elevation[i].ele ?? 0);
      const grade = (dEle / (dKm * 1000)) * 100;
      if (grade > gradeMax) gradeMax = grade;
    }
    gradeMax = Math.round(gradeMax * 10) / 10;
  }

  const pct = (val) => (msgTotal > 0 ? Math.round((val / msgTotal) * 100) : 0);

  return {
    km: Math.round(km * 10) / 10,
    dPos: Math.round(dPos),
    dNeg: Math.round(dNeg),
    timeMin,
    totalTimeSec,
    gradeAvg,
    gradeMax,
    eleMin: eleMin !== null ? Math.round(eleMin) : null,
    eleMax: eleMax !== null ? Math.round(eleMax) : null,
    pctSterrato: pct(totals.sterrato),
    pctCiclabile: pct(totals.ciclabile),
    pctAsfaltoSecondario: pct(totals.asfaltoSecondario),
    elevation,
  };
}

// --- Feature 3: segmentazione percorso per tipo strada -----------------------

const GRAVEL_SURFACES = new Set([
  'gravel', 'dirt', 'ground', 'unpaved', 'sand', 'compacted', 'fine_gravel',
]);

function classifySegmentType(wayTagsStr) {
  const tags = Object.create(null);
  for (const part of (wayTagsStr || '').split(/\s+/)) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    tags[part.slice(0, i)] = part.slice(i + 1);
  }
  const surface = (tags.surface || '').toLowerCase();
  const highway = (tags.highway || '').toLowerCase();
  const bicycle = (tags.bicycle || '').toLowerCase();

  if (highway === 'cycleway' || bicycle === 'designated') return 'cycleway';
  if (GRAVEL_SURFACES.has(surface)) return 'gravel';
  if (highway === 'primary' || highway === 'trunk' || highway === 'secondary') {
    if (bicycle !== 'designated') return 'busy';
  }
  if (highway === 'path' || highway === 'track' || highway === 'footway' || highway === 'bridleway') {
    return 'path';
  }
  return 'asphalt';
}

/**
 * Costruisce segmenti tipizzati dal `messages` BRouter, ritornando **indici**
 * nel `geojson.coordinates` (LineString) invece di coordinate ricostruite.
 *
 * Ritorno: `[{ type, startIdx, endIdx }, ...]` con `startIdx`/`endIdx` inclusivi.
 *
 * Motivazione: i `messages` BRouter elencano solo i nodi OSM (estremi di ogni
 * way), non i punti intermedi che descrivono le curve della strada reale. Il
 * `geojson.coordinates` invece contiene tutti i punti (incluse le curve).
 * Lavorando per indici, il rendering può poi usare le coordinate "ricche" del
 * geojson e seguire fedelmente le curve.
 *
 * Mapping messages → indici geojson:
 *   - La prima riga di dati identifica il nodo n.1 (la partenza è il nodo 0).
 *   - Per ogni riga si cerca, *in avanti* da `lastIdx`, l'indice del punto
 *     nel geojson più vicino a `[lon, lat]` della riga (matching monotono).
 *   - Si uniscono segmenti consecutivi dello stesso tipo.
 *
 * Ritorna `[]` se i messages non sono parsabili o se il matching fallisce su
 * più del 50% delle righe (→ fallback al rendering monocolore in drawRoute).
 */
export function segmentRoute(geojson, rawMessages) {
  if (!Array.isArray(rawMessages) || rawMessages.length < 2) return [];
  const header = rawMessages[0];
  if (!Array.isArray(header)) return [];
  const lonIdx = header.indexOf('Longitude');
  const latIdx = header.indexOf('Latitude');
  const wayIdx = header.indexOf('WayTags');
  if (lonIdx < 0 || latIdx < 0 || wayIdx < 0) return [];

  const coords = geojson && Array.isArray(geojson.coordinates) ? geojson.coordinates : null;
  if (!coords || coords.length < 2) return [];

  const rows = rawMessages.slice(1);
  if (rows.length === 0) return [];

  // Tolleranza di matching: ~11 m a queste latitudini.
  const TOL_DEG = 0.0001;
  // Distanza al quadrato in gradi (sufficiente per ranking locale).
  const dist2 = (lon1, lat1, lon2, lat2) => {
    const dx = lon1 - lon2;
    const dy = lat1 - lat2;
    return dx * dx + dy * dy;
  };

  // Trova l'indice in coords (partendo da `from` in avanti) più vicino a [lon,lat].
  // Ferma la scansione appena la distanza ricomincia a crescere in modo deciso
  // dopo aver trovato un minimo entro la tolleranza (matching monotono).
  function matchIndex(lon, lat, from) {
    const tol2 = TOL_DEG * TOL_DEG;
    let bestIdx = -1;
    let bestD2 = Infinity;
    let foundWithinTol = false;
    for (let i = from; i < coords.length; i++) {
      const c = coords[i];
      const d2 = dist2(c[0], c[1], lon, lat);
      if (d2 < bestD2) {
        bestD2 = d2;
        bestIdx = i;
        if (d2 <= tol2) foundWithinTol = true;
      } else if (foundWithinTol && d2 > bestD2 * 16) {
        // Ci siamo allontanati molto dal minimo locale: stop.
        break;
      }
    }
    return { idx: bestIdx, d2: bestD2, ok: foundWithinTol };
  }

  const segments = [];
  let lastIdx = 0;
  let failed = 0;

  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    const lon = parseInt(row[lonIdx], 10) / 1e6;
    const lat = parseInt(row[latIdx], 10) / 1e6;
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
      failed++;
      continue;
    }
    const m = matchIndex(lon, lat, lastIdx);
    if (!m.ok || m.idx < 0 || m.idx <= lastIdx) {
      // Non riuscito a mappare: salta la riga (ma non rompere la sequenza).
      failed++;
      continue;
    }
    const endIdx = m.idx;
    const type = classifySegmentType(String(row[wayIdx] || ''));
    const last = segments[segments.length - 1];
    if (last && last.type === type && last.endIdx === lastIdx) {
      // Merge con il segmento precedente (stesso tipo, contiguo).
      last.endIdx = endIdx;
    } else {
      segments.push({ type, startIdx: lastIdx, endIdx });
    }
    lastIdx = endIdx;
  }

  // Se il matching ha fallito su più del 50% delle righe, abortisci.
  if (failed * 2 > rows.length) return [];
  if (segments.length === 0) return [];

  // Estendi l'ultimo segmento fino alla fine del geojson se è rimasto un gap
  // (può capitare se l'ultima riga non ha matchato).
  const lastSeg = segments[segments.length - 1];
  if (lastSeg.endIdx < coords.length - 1) {
    lastSeg.endIdx = coords.length - 1;
  }

  return segments;
}

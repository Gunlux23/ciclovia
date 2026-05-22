// Route planner: scegli il percorso giusto in base a presenza/assenza di un
// "target distance" desiderato dall'utente.
//
// Modalità:
//   - pass-through  → targetKm == null: una sola chiamata a BRouter coi
//                     waypoint forniti. Comportamento identico alla versione
//                     pre-feature.
//   - anello        → 1 waypoint + targetKm: genera 2 waypoint a distanza R
//                     dalla partenza con angoli (θ, θ+120°), itera scalando R
//                     finché D ∈ [0.9·target, 1.1·target].
//   - estensione    → ≥2 waypoint + targetKm: calcola percorso base. Se troppo
//                     corto, inserisce un waypoint di deviazione perpendicolare
//                     al segmento più lungo. Se troppo lungo, ritorna percorso
//                     minimo + warning.
//
// L'API è una singola funzione `planRoute()` che ritorna
// `{ geojson, messages, properties, mode, iterations, finalKm, warning }`
// oppure throwa (RouteNotFoundError, RouteServiceError, AbortError).

import * as brouter from './brouter.js';

const TOLERANCE = 0.10;       // ±10% sul target
const MAX_ITERATIONS = 5;     // tetto iterazioni per anello / estensione
const EARTH_R = 6371000;      // raggio terrestre medio in metri

// Anello: parametri per evitare sovrapposizioni andata/ritorno.
const OVERLAP_THRESHOLD = 0.04;       // 4% di celle visitate >1 volta = accettabile
const OVERLAP_THRESHOLD_M = 300;      // soglia ASSOLUTA: max 300m di tratto comune
                                      // (la % da sola scala male su giri lunghi: 1km
                                      // di A/R su 100km è solo 1% ma resta fastidioso)
const OVERLAP_ROTATION_RAD = Math.PI / 4;  // 45° per ogni nuovo tentativo
const OVERLAP_MAX_ATTEMPTS = 5;       // 5 rotazioni → copre fino a 180° con step 45°
const OVERLAP_CELL_M = 15;            // ~15 m per cella di discretizzazione

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

function toDeg(rad) {
  return (rad * 180) / Math.PI;
}

// Haversine: distanza in metri tra due punti lat/lon.
function haversineMeters(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.sqrt(a));
}

// Calcola lunghezza percorso (km) da una LineString GeoJSON sommando
// haversine sui segmenti consecutivi. BRouter restituisce anche
// `track-length` in `properties` ma è una stringa: per affidabilità
// la ricalcoliamo. Veloce: O(n).
function geojsonLengthKm(geojson) {
  const coords = (geojson && geojson.coordinates) || [];
  if (coords.length < 2) return 0;
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1];
    const b = coords[i];
    total += haversineMeters(a[1], a[0], b[1], b[0]);
  }
  return total / 1000;
}

// Genera un punto a `distanceM` dal punto (lat, lon) lungo l'angolo `bearingRad`
// (0 = nord, π/2 = est, π = sud, 3π/2 = ovest). Formula di destination point
// sulla sfera. Approssimazione molto accurata per distanze < 1000 km.
function destinationPoint(lat, lon, distanceM, bearingRad) {
  const φ1 = toRad(lat);
  const λ1 = toRad(lon);
  const δ = distanceM / EARTH_R;

  const φ2 = Math.asin(
    Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(bearingRad),
  );
  const λ2 = λ1 + Math.atan2(
    Math.sin(bearingRad) * Math.sin(δ) * Math.cos(φ1),
    Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2),
  );

  return { lat: toDeg(φ2), lon: ((toDeg(λ2) + 540) % 360) - 180 };
}

// Bearing dal punto A al punto B (radianti, 0 = nord).
function bearingRad(lat1, lon1, lat2, lon2) {
  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const Δλ = toRad(lon2 - lon1);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x =
    Math.cos(φ1) * Math.sin(φ2) -
    Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return Math.atan2(y, x);
}

// Discretizza il percorso in celle ~15m e calcola la frazione di celle visitate
// più di una volta. È un'euristica per misurare "quanto il giro si ripercorre
// addosso": andata e ritorno sulla stessa strada → molte celle con count>1.
// Strade adiacenti (es. due lati di una via) cadono in celle diverse, quindi
// non vengono erroneamente contate come overlap.
//
// 1°/(60 nautical miles) ≈ 0.000135° ≈ 15m. Usiamo 7400 = 1/0.000135.
function measureOverlap(geojson) {
  const coords = (geojson && geojson.coordinates) || [];
  if (coords.length < 2) return { pct: 0, meters: 0 };
  const cells = new Map();
  const scale = 1000 * (60 / OVERLAP_CELL_M);  // ≈ 4000 per OVERLAP_CELL_M=15
  for (const [lon, lat] of coords) {
    const key = `${Math.round(lat * scale)},${Math.round(lon * scale)}`;
    cells.set(key, (cells.get(key) || 0) + 1);
  }
  let overlapping = 0;
  for (const c of cells.values()) if (c > 1) overlapping++;
  return {
    pct: cells.size > 0 ? overlapping / cells.size : 0,
    meters: overlapping * OVERLAP_CELL_M,
  };
}

// Parametri di "trim" delle appendici A/R nell'anello.
// Dopo il calcolo, se il percorso contiene tratti che ripassano sulla stessa
// strada, vengono tagliati direttamente dal geojson (senza ricalcolare).
const TRIM_START_BUFFER_M = 200;        // ignora overlap entro 200m dalla partenza/arrivo
                                        // (è la chiusura naturale del giro, non un'appendice)
const TRIM_MIN_APPENDIX_LEN_M = 200;    // pathLen tra innesto e ritorno ≥ 200m
                                        // (corrisponde ad appendice di ≥ 100m solo andata)
const TRIM_MAX_REMOVED_RATIO = 0.5;     // safety: non rimuovere più del 50% del giro
                                        // (se sì, è un caso patologico, tieni l'originale)

// Rileva e rimuove appendici A/R dal geojson di un loop chiuso.
// Strategia:
//   1) Discretizza i punti del percorso in celle ~15m (riusa OVERLAP_CELL_M).
//   2) Per ogni indice i NON vicino all'origine, cerca il maggior j > i nella
//      stessa cella che NON è vicino all'origine.
//   3) Se la distanza percorsa tra i e j (lungo il path) è ≥ TRIM_MIN_APPENDIX_LEN_M,
//      è un'appendice: la rimuoviamo. Manteniamo coord[i] come snodo (è lo stesso
//      luogo geografico di coord[j]).
//   4) Guardia: se la rimozione totale supera il 50% del percorso → annulla
//      (il giro è probabilmente A/R puro o degenere).
//
// Ritorna { geojson, trimmedMeters }. Se nessuna appendice trovata,
// trimmedMeters=0 e geojson è quello originale.
function trimLoopAppendices(geojson, origin) {
  const coords = (geojson && geojson.coordinates) || [];
  if (coords.length < 10) return { geojson, trimmedMeters: 0 };

  // Marca punti vicini all'origine (chiusura del giro, NON tagliare lì).
  const nearOrigin = new Array(coords.length).fill(false);
  for (let i = 0; i < coords.length; i++) {
    const [lon, lat] = coords[i];
    if (haversineMeters(lat, lon, origin.lat, origin.lon) <= TRIM_START_BUFFER_M) {
      nearOrigin[i] = true;
    }
  }

  // Cell → array di indici nei coords.
  const scale = 1000 * (60 / OVERLAP_CELL_M);
  const cellMap = new Map();
  for (let i = 0; i < coords.length; i++) {
    const [lon, lat] = coords[i];
    const key = `${Math.round(lat * scale)},${Math.round(lon * scale)}`;
    if (!cellMap.has(key)) cellMap.set(key, []);
    cellMap.get(key).push(i);
  }

  const toRemove = new Array(coords.length).fill(false);
  const totalLenM = geojsonLengthKm(geojson) * 1000;

  let i = 0;
  while (i < coords.length - 1) {
    if (nearOrigin[i] || toRemove[i]) { i++; continue; }

    const [lon, lat] = coords[i];
    const key = `${Math.round(lat * scale)},${Math.round(lon * scale)}`;
    const same = cellMap.get(key) || [];

    // Trova il maggior j > i nella stessa cella, valido (non near-origin, non già marcato).
    let j = -1;
    for (let k = same.length - 1; k >= 0; k--) {
      const idx = same[k];
      if (idx > i && !nearOrigin[idx] && !toRemove[idx]) { j = idx; break; }
    }

    if (j > i + 3) {
      // Lunghezza tra i e j (tutto il "ramo" andata+ritorno).
      let pathLen = 0;
      for (let k = i; k < j; k++) {
        pathLen += haversineMeters(coords[k][1], coords[k][0], coords[k+1][1], coords[k+1][0]);
      }
      // Guardia: appendici troppo grosse vs il giro totale = caso patologico, skip.
      if (pathLen >= TRIM_MIN_APPENDIX_LEN_M && pathLen <= totalLenM * 0.5) {
        // Rimuovi coord[i+1 ... j] (j incluso: rappresenta il rientro nel
        // medesimo punto di coord[i], che resta come snodo).
        for (let k = i + 1; k <= j; k++) toRemove[k] = true;
        i = j + 1;
        continue;
      }
    }
    i++;
  }

  const newCoords = coords.filter((_, idx) => !toRemove[idx]);
  // Safety finale: se ho tolto troppo, annulla l'operazione.
  if (newCoords.length < coords.length * (1 - TRIM_MAX_REMOVED_RATIO)) {
    return { geojson, trimmedMeters: 0 };
  }
  if (newCoords.length === coords.length) {
    return { geojson, trimmedMeters: 0 };
  }
  const newGeojson = { ...geojson, coordinates: newCoords };
  const trimmedMeters = totalLenM - geojsonLengthKm(newGeojson) * 1000;
  return { geojson: newGeojson, trimmedMeters };
}

// Un tentativo è considerato "pulito" se sia % sia metri assoluti sono sotto soglia.
// Serve la AND perchè:
//   - solo % → fallisce su giri lunghi (1km su 100km = 1% ma è fastidioso)
//   - solo m → fallisce su giri corti (200m su 5km è il 4% del giro)
function isOverlapAcceptable(overlap) {
  return overlap.pct <= OVERLAP_THRESHOLD && overlap.meters <= OVERLAP_THRESHOLD_M;
}

// Errore astratto per quando un'iterazione viene cancellata dall'utente.
export class PlanAbortError extends Error {
  constructor() {
    super('Calcolo interrotto.');
    this.name = 'PlanAbortError';
  }
}

function checkAbort(signal) {
  if (signal && signal.aborted) throw new PlanAbortError();
}

// Calcola un tentativo di anello con QUADRILATERO: 3 waypoint a θ, θ+90°, θ+180°
// distribuiti su un semicerchio (forma "a ferro di cavallo"). Più strade
// differenti rispetto al triangolo precedente → minor probabilità di overlap.
async function tryLoopQuadrilateral({ origin, profile, R, θ, signal }) {
  const a = destinationPoint(origin.lat, origin.lon, R, θ);
  const b = destinationPoint(origin.lat, origin.lon, R, θ + Math.PI / 2);
  const c = destinationPoint(origin.lat, origin.lon, R, θ + Math.PI);
  const waypoints = [
    { lat: origin.lat, lon: origin.lon },
    a, b, c,
    { lat: origin.lat, lon: origin.lon },
  ];
  const resp = await brouter.fetchRoute(waypoints, profile);
  checkAbort(signal);
  return {
    resp,
    km: geojsonLengthKm(resp.geojson),
    overlap: measureOverlap(resp.geojson),  // { pct, meters }
    waypoints,
  };
}

/**
 * Costruisce un anello iterativo intorno al punto di partenza.
 *
 * Strategia a due livelli:
 *   - Ciclo esterno: aggiusta il RAGGIO finché la distanza ottenuta entra
 *     nella tolleranza ±10% del target.
 *   - Ciclo interno (per ogni R): prova fino a 5 rotazioni di 45° per ridurre
 *     l'overlap (sovrapposizione andata/ritorno) sotto la soglia del 4%.
 *
 * Se la distanza converge ma l'overlap resta alto, ritorna comunque il
 * miglior tentativo (overlap minimo) con un warning all'utente.
 */
async function planLoop({ origin, profile, targetKm, loopSeed, onProgress, signal }) {
  // Stima iniziale del raggio: il perimetro reale di un quadrilatero "a ferro
  // di cavallo" su strade reali è ≈ 5R (3 lati di R + lato di ritorno con
  // strade non-lineari ≈ 2R).
  let R = (targetKm * 1000) / 5;
  let θBase = Number.isFinite(loopSeed) ? loopSeed : 0;

  // Miglior tentativo globale (per fallback finale).
  let best = null;
  let bestDelta = Infinity;
  let lastErr = null;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    checkAbort(signal);

    if (onProgress) {
      onProgress({
        iteration: i + 1,
        totalIterations: MAX_ITERATIONS,
        targetKm,
        currentKm: best ? best.km : null,
        mode: 'loop',
      });
    }

    // Cerca il miglior tentativo a questo raggio variando θ se l'overlap è alto.
    // "Miglior" = minor numero di metri sovrapposti (più rappresentativo della %
    // su giri di lunghezze diverse).
    let attemptBest = null;
    let attemptBestMeters = Infinity;
    let lastKm = null;
    let attemptErr = null;

    for (let rot = 0; rot < OVERLAP_MAX_ATTEMPTS; rot++) {
      const θ = θBase + rot * OVERLAP_ROTATION_RAD;
      try {
        const t = await tryLoopQuadrilateral({ origin, profile, R, θ, signal });
        lastKm = t.km;

        if (t.overlap.meters < attemptBestMeters) {
          attemptBest = t;
          attemptBestMeters = t.overlap.meters;
        }

        if (isOverlapAcceptable(t.overlap)) break;
      } catch (err) {
        if (err.name === 'PlanAbortError') throw err;
        attemptErr = err;
      }
    }

    if (!attemptBest) {
      // Tutte le rotazioni hanno fallito a questo R: perturba R e riprova.
      lastErr = attemptErr;
      R *= 0.9;
      continue;
    }

    const km = attemptBest.km;
    const delta = Math.abs(km - targetKm);

    // Memorizza miglior tentativo globale (priorità: distanza, poi overlap).
    if (delta < bestDelta) {
      best = { ...attemptBest, delta };
      bestDelta = delta;
    }

    // In tolleranza? ritorna subito (eventualmente con appendici tagliate).
    if (km >= targetKm * (1 - TOLERANCE) && km <= targetKm * (1 + TOLERANCE)) {
      const trimResult = trimLoopAppendices(attemptBest.resp.geojson, origin);
      const finalKm = trimResult.trimmedMeters > 0
        ? geojsonLengthKm(trimResult.geojson)
        : km;
      const note = trimResult.trimmedMeters > 0
        ? `Rimosse appendici A/R per ~${Math.round(trimResult.trimmedMeters)}m.`
        : (isOverlapAcceptable(attemptBest.overlap)
            ? null
            : `Anello con ~${Math.round(attemptBest.overlap.meters)}m di tratto comune (rete stradale limitata in zona).`);
      return {
        geojson: trimResult.geojson,
        messages: attemptBest.resp.messages,
        properties: attemptBest.resp.properties,
        mode: 'loop',
        iterations: i + 1,
        finalKm,
        warning: note,
      };
    }

    // Aggiorna R proporzionalmente al rapporto target/ottenuto.
    if (km > 0) R = R * (targetKm / km);
    // Lieve perturbazione di θ tra iterazioni di distanza per evitare loop.
    θBase += 0.05;
  }

  // Esaurite iterazioni distanza: ritorna miglior tentativo globale,
  // eventualmente con appendici tagliate.
  if (best) {
    const trimResult = trimLoopAppendices(best.resp.geojson, origin);
    const finalKm = trimResult.trimmedMeters > 0
      ? geojsonLengthKm(trimResult.geojson)
      : best.km;
    const parts = [`Distanza approssimativa: ${finalKm.toFixed(1)} km (target ${targetKm} km)`];
    if (trimResult.trimmedMeters > 0) {
      parts.push(`Rimosse appendici A/R per ~${Math.round(trimResult.trimmedMeters)}m`);
    } else if (!isOverlapAcceptable(best.overlap)) {
      parts.push(`Tratto comune: ~${Math.round(best.overlap.meters)}m`);
    }
    return {
      geojson: trimResult.geojson,
      messages: best.resp.messages,
      properties: best.resp.properties,
      mode: 'loop',
      iterations: MAX_ITERATIONS,
      finalKm,
      warning: parts.join('. ') + '.',
    };
  }

  throw lastErr || new Error('Impossibile costruire un anello: nessun tentativo riuscito.');
}

/**
 * Trova l'indice della coppia (i, i+1) di waypoint consecutivi più distanti
 * in linea d'aria. Si usa per scegliere dove inserire il waypoint di
 * deviazione per la modalità estensione.
 */
function findLongestSegment(waypoints) {
  let bestIdx = 0;
  let bestDist = 0;
  for (let i = 0; i < waypoints.length - 1; i++) {
    const d = haversineMeters(
      waypoints[i].lat,
      waypoints[i].lon,
      waypoints[i + 1].lat,
      waypoints[i + 1].lon,
    );
    if (d > bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }
  return { idx: bestIdx, distanceM: bestDist };
}

/**
 * Estensione: i waypoint sono fissi, ma la distanza totale richiesta
 * (targetKm) è maggiore della distanza percorribile diretta. Inserisce
 * waypoint di deviazione perpendicolari al segmento più lungo, alternando
 * lato (sinistra/destra) per esplorare entrambe le direzioni.
 */
async function planExtension({ waypoints, profile, targetKm, onProgress, signal }) {
  // 1) Percorso base (senza deviazioni).
  if (onProgress) {
    onProgress({
      iteration: 1,
      totalIterations: MAX_ITERATIONS,
      targetKm,
      currentKm: null,
      mode: 'extension',
    });
  }
  const baseResp = await brouter.fetchRoute(waypoints, profile);
  checkAbort(signal);
  const baseKm = geojsonLengthKm(baseResp.geojson);

  // Caso 1: già nel range → fatto.
  if (baseKm >= targetKm * (1 - TOLERANCE) && baseKm <= targetKm * (1 + TOLERANCE)) {
    return {
      geojson: baseResp.geojson,
      messages: baseResp.messages,
      properties: baseResp.properties,
      mode: 'extension',
      iterations: 1,
      finalKm: baseKm,
      warning: null,
    };
  }

  // Caso 2: il percorso è già più lungo del target → warning + base.
  if (baseKm > targetKm * (1 + TOLERANCE)) {
    return {
      geojson: baseResp.geojson,
      messages: baseResp.messages,
      properties: baseResp.properties,
      mode: 'extension',
      iterations: 1,
      finalKm: baseKm,
      warning: `Le tappe scelte richiedono almeno ${baseKm.toFixed(1)} km, non posso ridurre a ${targetKm} km. Mostro il percorso più breve possibile.`,
    };
  }

  // Caso 3: troppo corto → aggiungi deviazione. Memorizza miglior tentativo.
  let best = { resp: baseResp, km: baseKm, delta: Math.abs(baseKm - targetKm) };
  // Lato della deviazione: -1 = sinistra rispetto al verso del segmento, +1 = destra.
  let side = -1;

  for (let iter = 1; iter < MAX_ITERATIONS; iter++) {
    checkAbort(signal);

    const seg = findLongestSegment(waypoints);
    const a = waypoints[seg.idx];
    const b = waypoints[seg.idx + 1];
    // Midpoint geografico approssimato (interpolazione lineare lat/lon: per
    // distanze << raggio terra l'errore è trascurabile).
    const mid = {
      lat: (a.lat + b.lat) / 2,
      lon: (a.lon + b.lon) / 2,
    };
    // Bearing perpendicolare al segmento.
    const segBearing = bearingRad(a.lat, a.lon, b.lat, b.lon);
    const perpBearing = segBearing + (side * Math.PI) / 2;
    // Offset proporzionale al deficit residuo: deficit_km / 4 → metri.
    const deficitKm = Math.max(2, targetKm - best.km);
    const offsetM = (deficitKm * 1000) / 4;
    const detour = destinationPoint(mid.lat, mid.lon, offsetM, perpBearing);

    // Inserisci il detour come waypoint tra a e b.
    const newWaypoints = [
      ...waypoints.slice(0, seg.idx + 1),
      detour,
      ...waypoints.slice(seg.idx + 1),
    ];

    if (onProgress) {
      onProgress({
        iteration: iter + 1,
        totalIterations: MAX_ITERATIONS,
        targetKm,
        currentKm: best.km,
        mode: 'extension',
      });
    }

    try {
      const resp = await brouter.fetchRoute(newWaypoints, profile);
      checkAbort(signal);
      const km = geojsonLengthKm(resp.geojson);
      const delta = Math.abs(km - targetKm);

      if (delta < best.delta) {
        best = { resp, km, delta };
      }

      // In tolleranza? finito.
      if (km >= targetKm * (1 - TOLERANCE) && km <= targetKm * (1 + TOLERANCE)) {
        return {
          geojson: resp.geojson,
          messages: resp.messages,
          properties: resp.properties,
          mode: 'extension',
          iterations: iter + 1,
          finalKm: km,
          warning: null,
        };
      }
      // Se è ancora troppo corto, prossima iterazione prova lato opposto.
      // Se è troppo lungo, ridurrà via offsetM minore (deficitKm diventa piccolo).
      side = -side;
    } catch (err) {
      if (err.name === 'PlanAbortError') throw err;
      // Fallita questa deviazione, prova lato opposto.
      side = -side;
    }
  }

  return {
    geojson: best.resp.geojson,
    messages: best.resp.messages,
    properties: best.resp.properties,
    mode: 'extension',
    iterations: MAX_ITERATIONS,
    finalKm: best.km,
    warning: `Distanza approssimativa: ${best.km.toFixed(1)} km (target ${targetKm} km).`,
  };
}

/**
 * Entry point del planner.
 *
 * @param {Object} opts
 * @param {Array<{lat,lon}>} opts.waypoints
 * @param {string} opts.profile
 * @param {number|null} opts.targetKm  null/undefined → modalità pass-through
 * @param {number} [opts.loopSeed=0]   angolo θ in radianti per la modalità anello
 * @param {(progress)=>void} [opts.onProgress]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{geojson, messages, properties, mode, iterations, finalKm, warning}>}
 */
export async function planRoute({
  waypoints,
  profile,
  targetKm = null,
  loopSeed = 0,
  onProgress = null,
  signal = null,
}) {
  if (!Array.isArray(waypoints) || waypoints.length === 0) {
    throw new Error('Servono uno o più waypoint.');
  }
  checkAbort(signal);

  // Modalità pass-through: nessun target → comportamento legacy.
  if (!Number.isFinite(targetKm) || targetKm <= 0) {
    if (waypoints.length < 2) {
      throw new Error('Servono almeno due waypoint per calcolare un percorso.');
    }
    const resp = await brouter.fetchRoute(waypoints, profile);
    return {
      geojson: resp.geojson,
      messages: resp.messages,
      properties: resp.properties,
      mode: 'passthrough',
      iterations: 1,
      finalKm: geojsonLengthKm(resp.geojson),
      warning: null,
    };
  }

  // Modalità anello: 1 waypoint + target.
  if (waypoints.length === 1) {
    return planLoop({
      origin: waypoints[0],
      profile,
      targetKm,
      loopSeed,
      onProgress,
      signal,
    });
  }

  // Modalità estensione: ≥2 waypoint + target.
  return planExtension({
    waypoints,
    profile,
    targetKm,
    onProgress,
    signal,
  });
}

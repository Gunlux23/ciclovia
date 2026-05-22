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
  if (coords.length < 2) return { pct: 0, meters: 0, overlapCoords: [] };
  // Mappa: cellKey → { count, lat, lon } (memorizza un sample per cella)
  const cells = new Map();
  const scale = 1000 * (60 / OVERLAP_CELL_M);  // ≈ 4000 per OVERLAP_CELL_M=15
  for (const [lon, lat] of coords) {
    const key = `${Math.round(lat * scale)},${Math.round(lon * scale)}`;
    const c = cells.get(key);
    if (c) c.count++;
    else cells.set(key, { count: 1, lat, lon });
  }
  let overlapping = 0;
  const overlapCoords = [];
  for (const cell of cells.values()) {
    if (cell.count > 1) {
      overlapping++;
      overlapCoords.push({ lat: cell.lat, lon: cell.lon });
    }
  }
  return {
    pct: cells.size > 0 ? overlapping / cells.size : 0,
    meters: overlapping * OVERLAP_CELL_M,
    overlapCoords,
  };
}

// Clustering "grow-from-seed" delle coordinate sovrapposte → punti nogo.
// Due coordinate appartengono allo stesso cluster se distano ≤ NOGO_CLUSTER_M.
// Per ogni cluster ritorna {lat, lon} = centroide, raggio = estensione/2 + buffer.
const NOGO_CLUSTER_M = 80;        // distanza max per stessa zona
const NOGO_MIN_RADIUS_M = 50;     // raggio minimo del nogo
const NOGO_MAX_RADIUS_M = 200;    // raggio massimo (evita di bloccare zone enormi)
const NOGO_BUFFER_M = 30;         // margine attorno al cluster
const NOGO_MAX_COUNT = 6;         // massimo numero di nogo (URL BRouter lunga)
const NOGO_MIN_SIZE = 3;          // ignora cluster di poche celle (rumore)

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

function buildNogosFromOverlap(overlapCoords) {
  if (!overlapCoords || overlapCoords.length < NOGO_MIN_SIZE) return [];
  const used = new Array(overlapCoords.length).fill(false);
  const clusters = [];

  for (let i = 0; i < overlapCoords.length; i++) {
    if (used[i]) continue;
    const cluster = [overlapCoords[i]];
    used[i] = true;
    // Espandi cluster: ogni nuovo punto può attirarne altri (grow)
    for (let g = 0; g < cluster.length; g++) {
      for (let j = i + 1; j < overlapCoords.length; j++) {
        if (used[j]) continue;
        if (haversineM(cluster[g], overlapCoords[j]) <= NOGO_CLUSTER_M) {
          cluster.push(overlapCoords[j]);
          used[j] = true;
        }
      }
    }
    if (cluster.length >= NOGO_MIN_SIZE) clusters.push(cluster);
  }

  // Per ogni cluster: centroide + raggio basato sull'estensione
  const nogos = clusters.map((cluster) => {
    const lat = cluster.reduce((s, c) => s + c.lat, 0) / cluster.length;
    const lon = cluster.reduce((s, c) => s + c.lon, 0) / cluster.length;
    const center = { lat, lon };
    let maxDist = 0;
    for (const p of cluster) maxDist = Math.max(maxDist, haversineM(center, p));
    const radiusM = Math.min(
      NOGO_MAX_RADIUS_M,
      Math.max(NOGO_MIN_RADIUS_M, maxDist + NOGO_BUFFER_M),
    );
    return { lat, lon, radiusM, size: cluster.length };
  });

  // Tieni solo i cluster più grandi (limita URL BRouter)
  nogos.sort((a, b) => b.size - a.size);
  return nogos.slice(0, NOGO_MAX_COUNT).map(({ lat, lon, radiusM }) => ({ lat, lon, radiusM }));
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
async function tryLoopQuadrilateral({ origin, profile, R, θ, signal, nogos, skipMids }) {
  // skipMids: array di indici dei waypoint intermedi da OMETTERE
  //   1 = a (θ), 2 = b (θ+90°), 3 = c (θ+180°).
  // Serve a "potare" uno o più vertici quando essi forzano appendici A/R inutili.
  const a = destinationPoint(origin.lat, origin.lon, R, θ);
  const b = destinationPoint(origin.lat, origin.lon, R, θ + Math.PI / 2);
  const c = destinationPoint(origin.lat, origin.lon, R, θ + Math.PI);
  const full = [
    { lat: origin.lat, lon: origin.lon },
    a, b, c,
    { lat: origin.lat, lon: origin.lon },
  ];
  const skipSet = new Set(Array.isArray(skipMids) ? skipMids : []);
  const waypoints = full.filter((_, i) => !skipSet.has(i));
  const resp = await brouter.fetchRoute(waypoints, profile, { nogos });
  checkAbort(signal);
  return {
    resp,
    km: geojsonLengthKm(resp.geojson),
    overlap: measureOverlap(resp.geojson),
    waypoints,
    midPoints: { a, b, c },
  };
}

// Identifica tutti i waypoint intermedi (a, b, c) che cadono "dentro" un
// cluster di overlap: cioè a meno di `thresholdM` da almeno un centroide.
// Sono i candidati alla potatura. Ritorna gli indici (sottinsieme di [1,2,3]).
//
// IMPORTANTE: non lasciamo mai meno di 1 waypoint intermedio (altrimenti il
// loop degenera in A/R puro). Quindi se ne troviamo 3 colpevoli, ne togliamo
// al massimo 2.
function findWaypointsInsideOverlap(midPoints, overlapCoords, thresholdM = 250) {
  if (!midPoints || !overlapCoords?.length) return [];
  const points = [
    { idx: 1, p: midPoints.a },
    { idx: 2, p: midPoints.b },
    { idx: 3, p: midPoints.c },
  ];
  const culprits = [];
  for (const { idx, p } of points) {
    let minDist = Infinity;
    for (const o of overlapCoords) {
      const d = haversineM(p, o);
      if (d < minDist) minDist = d;
    }
    if (minDist <= thresholdM) culprits.push({ idx, dist: minDist });
  }
  culprits.sort((a, b) => a.dist - b.dist);
  return culprits.slice(0, 2).map((c) => c.idx);
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

    let attemptBestθ = θBase;
    for (let rot = 0; rot < OVERLAP_MAX_ATTEMPTS; rot++) {
      const θ = θBase + rot * OVERLAP_ROTATION_RAD;
      try {
        const t = await tryLoopQuadrilateral({ origin, profile, R, θ, signal });
        lastKm = t.km;

        if (t.overlap.meters < attemptBestMeters) {
          attemptBest = t;
          attemptBestMeters = t.overlap.meters;
          attemptBestθ = θ;
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

    // RECUPERO OVERLAP — strategia a due livelli per eliminare A/R inutili
    // senza forzare il passaggio su strade trafficate.
    //
    // Priorità utente: evitare strade trafficate sopra ogni cosa.
    // Se BRouter aggira il problema passando da strade trafficate, il percorso
    // di solito risulta MOLTO PIÙ CORTO (sono più dirette dei raccordi
    // tranquilli). Useremo questa metrica come segnale "ha barato".
    if (!isOverlapAcceptable(attemptBest.overlap) && attemptBest.overlap.overlapCoords?.length) {

      // LIVELLO 1 — POTATURA: l'overlap può essere causato da uno o più
      // waypoint del quadrilatero piazzati in zone "senza uscita" (BRouter
      // ci va e torna per raggiungerli). Identifico TUTTI i waypoint vicini
      // a cluster overlap e provo combinazioni di rimozione, scegliendo la
      // migliore.
      const culprits = findWaypointsInsideOverlap(
        attemptBest.midPoints,
        attemptBest.overlap.overlapCoords,
      );
      if (culprits.length > 0) {
        // Combinazioni da provare, dalla più aggressiva (rimuovi entrambi)
        // alla più conservativa (rimuovi uno solo).
        const combos = [];
        if (culprits.length >= 2) combos.push(culprits.slice(0, 2)); // entrambi
        for (const c of culprits) combos.push([c]);                  // uno solo

        for (const skipMids of combos) {
          try {
            const tPrune = await tryLoopQuadrilateral({
              origin, profile, R, θ: attemptBestθ, signal, skipMids,
            });
            const overlapImproved = (attemptBest.overlap.meters - tPrune.overlap.meters) >= 200;
            // Per la potatura accettiamo accorciamenti più ampi:
            //   -25% se rimuoviamo 1 waypoint
            //   -40% se ne rimuoviamo 2 (togliere 2 lati su 4 accorcia molto
            //     e in genere è ancora un giro "decente")
            const minRatio = skipMids.length >= 2 ? 0.60 : 0.75;
            const notShortcut = tPrune.km >= attemptBest.km * minRatio;
            if (overlapImproved && notShortcut) {
              attemptBest = tPrune;
              attemptBestMeters = tPrune.overlap.meters;
              // Se ora va bene, esci dal loop combos
              if (isOverlapAcceptable(tPrune.overlap)) break;
            }
          } catch (err) {
            if (err.name === 'PlanAbortError') throw err;
          }
        }
      }

      // LIVELLO 2 — NOGOS: se la potatura non ha aiutato (o non era applicabile),
      // costruisci zone vietate dalle celle sovrapposte e ritenta sullo stesso θ.
      if (!isOverlapAcceptable(attemptBest.overlap) && attemptBest.overlap.overlapCoords?.length) {
        const nogos = buildNogosFromOverlap(attemptBest.overlap.overlapCoords);
        if (nogos.length > 0) {
          try {
            const tNogo = await tryLoopQuadrilateral({
              origin, profile, R, θ: attemptBestθ, signal, nogos,
            });
            const overlapImproved = (attemptBest.overlap.meters - tNogo.overlap.meters) >= 200;
            // Per i nogos siamo più severi (-15%) perchè un percorso molto più
            // corto suggerisce che BRouter ha scelto strade dirette/trafficate.
            const notShortcut = tNogo.km >= attemptBest.km * 0.85;
            if (overlapImproved && notShortcut) {
              attemptBest = tNogo;
              attemptBestMeters = tNogo.overlap.meters;
            }
          } catch (err) {
            if (err.name === 'PlanAbortError') throw err;
          }
        }
      }
    }

    const km = attemptBest.km;
    const delta = Math.abs(km - targetKm);

    // Memorizza miglior tentativo globale (priorità: distanza, poi overlap).
    if (delta < bestDelta) {
      best = { ...attemptBest, delta };
      bestDelta = delta;
    }

    // In tolleranza? ritorna subito (anche se overlap > soglia: useremo warning).
    if (km >= targetKm * (1 - TOLERANCE) && km <= targetKm * (1 + TOLERANCE)) {
      const acceptable = isOverlapAcceptable(attemptBest.overlap);
      return {
        geojson: attemptBest.resp.geojson,
        messages: attemptBest.resp.messages,
        properties: attemptBest.resp.properties,
        mode: 'loop',
        iterations: i + 1,
        finalKm: km,
        warning: acceptable
          ? null
          : `Anello con ~${Math.round(attemptBest.overlap.meters)}m di tratto comune (rete stradale limitata in zona).`,
      };
    }

    // Aggiorna R proporzionalmente al rapporto target/ottenuto.
    if (km > 0) R = R * (targetKm / km);
    // Lieve perturbazione di θ tra iterazioni di distanza per evitare loop.
    θBase += 0.05;
  }

  // Esaurite iterazioni distanza: ritorna miglior tentativo globale.
  if (best) {
    const overlapNote = !isOverlapAcceptable(best.overlap)
      ? ` Tratto comune: ~${Math.round(best.overlap.meters)}m.`
      : '';
    return {
      geojson: best.resp.geojson,
      messages: best.resp.messages,
      properties: best.resp.properties,
      mode: 'loop',
      iterations: MAX_ITERATIONS,
      finalKm: best.km,
      warning: `Distanza approssimativa: ${best.km.toFixed(1)} km (target ${targetKm} km).${overlapNote}`,
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

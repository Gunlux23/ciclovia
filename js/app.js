import * as state from './state.js';
import * as mapModule from './map.js';
import * as ui from './ui.js';
import * as brouter from './services/brouter.js';
import * as routePlanner from './services/routePlanner.js';
import * as nominatim from './services/nominatim.js';
import * as geolocation from './services/geolocation.js';
import * as overpass from './services/overpass.js';
import * as gpx from './lib/gpx.js';
import * as share from './lib/share.js';
import * as stats from './lib/stats.js';
import * as elevationChart from './lib/elevation-chart.js';

const RECALC_DEBOUNCE_MS = 400;

function waypointsKey(waypoints, profile, opts = {}) {
  const tdPart = opts.targetEnabled
    ? `|td:${opts.targetKm}|seed:${(opts.loopSeed || 0).toFixed(3)}`
    : '';
  return `${profile}|${waypoints.map((w) => `${w.lat.toFixed(5)},${w.lon.toFixed(5)}`).join('|')}${tdPart}`;
}

function arraysShallowEqualById(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i].id !== b[i].id) return false;
  return true;
}

document.addEventListener('DOMContentLoaded', () => {
  const mapApi = mapModule.init('map');

  const uiApi = ui.init(
    state,
    mapApi,
    { brouter, nominatim, geolocation },
    { gpx, share, elevationChart: elevationChart, stats },
  );

  let recalcTimer = null;
  let inFlightKey = null;
  let lastRouteKey = null;
  let inFlightAbort = null;

  function syncMarkers(current, previous) {
    const prevIds = new Set((previous?.waypoints || []).map((w) => w.id));
    const currIds = new Set(current.waypoints.map((w) => w.id));

    for (const id of prevIds) if (!currIds.has(id)) mapApi.removeMarker(id);

    for (const wp of current.waypoints) {
      if (prevIds.has(wp.id)) {
        mapApi.updateMarker(wp.id, { lat: wp.lat, lon: wp.lon });
      } else {
        mapApi.addMarker(wp);
      }
    }

    // Re-render to refresh role colors (start/via/end) when order changes.
    const prevList = previous?.waypoints || [];
    if (!arraysShallowEqualById(prevList, current.waypoints)) {
      mapApi.clearMarkers();
      for (const wp of current.waypoints) mapApi.addMarker(wp);
    }
  }

  async function recalculateRoute() {
    const snap = state.getState();
    const targetEnabled = snap.targetDistanceEnabled === true;
    const targetKm = targetEnabled && Number.isFinite(snap.targetDistanceKm)
      ? Math.max(1, snap.targetDistanceKm)
      : null;

    // Numero minimo di waypoint:
    //  - senza target: 2 (partenza + arrivo, come sempre)
    //  - con target + 1 waypoint: ok, modalità anello
    //  - con target + ≥2 waypoint: ok, modalità estensione
    const minWaypoints = targetKm ? 1 : 2;
    if (snap.waypoints.length < minWaypoints) {
      if (snap.route) state.update({ route: null });
      mapApi.clearRoute();
      mapApi.clearFountains();
      return;
    }

    const key = waypointsKey(snap.waypoints, snap.profile, {
      targetEnabled,
      targetKm,
      loopSeed: snap.loopSeed,
    });
    if (key === lastRouteKey) return;
    inFlightKey = key;

    // Cancella eventuale calcolo precedente in volo.
    if (inFlightAbort) inFlightAbort.abort();
    inFlightAbort = new AbortController();
    const localAbort = inFlightAbort;

    // Catena di fallback: profili sempre più permissivi finché uno restituisce
    // un percorso. Vale per tutte le modalità (passthrough, loop, estensione).
    // Per "Evita traffico" anteponiamo `safety` (più aggressivo nell'evitare
    // traffico ma con deviazioni lunghe), poi `fastbike-lowtraffic` come
    // compromesso, e solo dopo i profili generici.
    const TAIL = ['trekking', 'fastbike', 'shortest', 'car-eco', 'car-fast'];
    const dedup = (arr) => [...new Set(arr)];
    const FALLBACK_CHAIN = {
      safety: dedup(['safety', 'fastbike-lowtraffic', ...TAIL]),
      gravel: dedup(['gravel', ...TAIL]),
      mtb: dedup(['mtb', 'hiking-mountain', ...TAIL]),
      trekking: dedup(['trekking', ...TAIL]),
      fastbike: dedup(['fastbike', ...TAIL]),
    };
    const tryProfiles = FALLBACK_CHAIN[snap.profile] || dedup([snap.profile, ...TAIL]);

    state.update({ status: 'loading', error: null });
    let lastErr = null;
    let response = null;
    let usedProfile = snap.profile;

    const onProgress = (p) => {
      if (inFlightKey !== key) return;
      if (!targetKm) return; // niente progress per pass-through
      const cur = Number.isFinite(p.currentKm) ? `${p.currentKm.toFixed(0)} km` : '–';
      const modeLabel = p.mode === 'loop' ? 'anello' : 'estensione';
      // Notifica progresso solo dalla 2ª iterazione in poi (per non disturbare
      // sul caso più frequente dove la prima iterazione è già in tolleranza).
      if (p.iteration > 1) {
        uiApi.showToast(
          `${modeLabel}: tentativo ${p.iteration}/${p.totalIterations} (${cur} → ${targetKm} km)`,
          'info',
        );
      }
    };

    for (let i = 0; i < tryProfiles.length; i++) {
      const p = tryProfiles[i];
      try {
        response = await routePlanner.planRoute({
          waypoints: snap.waypoints,
          profile: p,
          targetKm,
          loopSeed: snap.loopSeed,
          onProgress,
          signal: localAbort.signal,
        });
        if (inFlightKey !== key) return;
        usedProfile = p;
        if (i > 0) {
          uiApi.showToast(`Profilo "${snap.profile}" non trovato, uso "${p}".`, 'info');
        }
        break;
      } catch (err) {
        if (err.name === 'PlanAbortError') return; // cancellato dall'utente
        if (inFlightKey !== key) return;
        lastErr = err;
        if (err.name !== 'RouteNotFoundError') break; // errore di rete: smetti
      }
    }

    if (!response) {
      const detail = (lastErr && lastErr.rawDetail) || (lastErr && lastErr.message) || '';
      console.warn('[Ciclovia] Routing failed:', detail);
      if (lastErr && lastErr.name === 'RouteNotFoundError') {
        uiApi.showToast(`Nessun percorso trovato. ${detail.slice(0, 120)}`, 'error');
      } else {
        uiApi.showToast(`Routing non raggiungibile. ${detail.slice(0, 120)}`, 'error');
      }
      state.update({ status: 'error', error: lastErr ? lastErr.message : 'unknown' });
      return;
    }

    if (response.warning) {
      uiApi.showToast(response.warning, 'info');
    }

    const computed = stats.compute({ ...response, profile: usedProfile });
    const segments = stats.segmentRoute(response.geojson, response.messages);
    const route = {
      routeKey: key,
      geojson: response.geojson,
      stats: {
        km: computed.km,
        dPos: computed.dPos,
        dNeg: computed.dNeg,
        timeMin: computed.timeMin,
        gradeAvg: computed.gradeAvg,
        gradeMax: computed.gradeMax,
        eleMin: computed.eleMin,
        eleMax: computed.eleMax,
        pctSterrato: computed.pctSterrato,
        pctCiclabile: computed.pctCiclabile,
        pctAsfaltoSecondario: computed.pctAsfaltoSecondario,
        fountainsCount: 0,
      },
      elevation: computed.elevation,
      segments,
      fountains: [],
    };
    lastRouteKey = key;
    state.update({ route, status: 'idle', error: null });
    mapApi.clearFountains();
    mapApi.drawRoute(route.geojson, segments);
    mapApi.fitToRoute(route.geojson);

    // Feature 2: fontanelle lungo il percorso (fire-and-forget, non blocca l'UX).
    // Confronto su `routeKey` (stringa stabile attraverso deepCopy di state).
    overpass
      .findDrinkingWaterNearRoute(route.geojson, { radiusM: 500 })
      .then((list) => {
        const cur = state.getState();
        if (!cur.route || cur.route.routeKey !== key) return;
        console.info(`[Ciclovia] Fontanelle trovate: ${list.length}`);
        mapApi.drawFountains(list);
        const nextStats = { ...cur.route.stats, fountainsCount: list.length };
        state.update({ route: { ...cur.route, fountains: list, stats: nextStats } });
      })
      .catch((err) => {
        console.warn('[Ciclovia] Overpass fontanelle non disponibili:', err.message || err);
      });
  }

  function scheduleRecalc() {
    clearTimeout(recalcTimer);
    recalcTimer = setTimeout(recalculateRoute, RECALC_DEBOUNCE_MS);
  }

  state.subscribe((current, previous) => {
    uiApi.renderAll(current);

    const waypointsChanged =
      !previous ||
      previous.waypoints.length !== current.waypoints.length ||
      previous.waypoints.some((w, i) => {
        const c = current.waypoints[i];
        return !c || c.id !== w.id || c.lat !== w.lat || c.lon !== w.lon;
      });

    if (waypointsChanged) syncMarkers(current, previous);

    const profileChanged = previous && previous.profile !== current.profile;
    const targetChanged = previous && (
      previous.targetDistanceEnabled !== current.targetDistanceEnabled ||
      previous.targetDistanceKm !== current.targetDistanceKm ||
      previous.loopSeed !== current.loopSeed
    );

    if (waypointsChanged || profileChanged || targetChanged) {
      const targetActive = current.targetDistanceEnabled === true &&
        Number.isFinite(current.targetDistanceKm) &&
        current.targetDistanceKm > 0;
      const minWp = targetActive ? 1 : 2;
      if (current.waypoints.length >= minWp) {
        scheduleRecalc();
      } else {
        lastRouteKey = null;
        mapApi.clearRoute();
        mapApi.clearFountains();
        if (current.route) state.update({ route: null });
      }
    }
  });

  mapApi.onLongPress(({ lat, lon }) => {
    const snap = state.getState();
    const index = snap.waypoints.length + 1;
    state.addWaypoint({ lat, lon, label: '', source: 'tap' });
    uiApi.showToast(`Aggiunto come tappa ${index}.`, 'info');
  });

  mapApi.onMarkerDrag((id, latlng) => {
    state.updateWaypoint(id, { lat: latlng.lat, lon: latlng.lon });
  });

  mapApi.onMarkerDelete((id) => {
    state.removeWaypoint(id);
    uiApi.showToast('Tappa eliminata.', 'info');
  });

  // "Altro giro": rigenera un anello con un seme angolare diverso.
  // Random tra 0.5 e 1.5 radianti per cambiare zona senza ripetere
  // sempre la stessa direzione opposta.
  uiApi.onAnotherLoop(() => {
    const snap = state.getState();
    const delta = 0.5 + Math.random();
    state.update({ loopSeed: (snap.loopSeed || 0) + delta });
  });

  // Initial render so existing state (from URL or localStorage) is reflected immediately.
  const bootState = state.getState();
  uiApi.renderAll(bootState);
  for (const wp of bootState.waypoints) mapApi.addMarker(wp);
  const bootTargetActive = bootState.targetDistanceEnabled === true &&
    Number.isFinite(bootState.targetDistanceKm) &&
    bootState.targetDistanceKm > 0;
  const bootMinWp = bootTargetActive ? 1 : 2;
  if (bootState.waypoints.length >= bootMinWp) scheduleRecalc();
});

const TOAST_DURATIONS = { info: 3000, success: 3000, error: 5000 };

function $(id) {
  const el = document.getElementById(id);
  if (!el) console.warn(`[ui] Elemento mancante: #${id}`);
  return el;
}

function formatKm(km) {
  if (!Number.isFinite(km)) return '–';
  return `${km.toFixed(1)} km`;
}
function formatMeters(m) {
  if (!Number.isFinite(m)) return '–';
  return `${Math.round(m)} m`;
}
function formatTime(min) {
  if (!Number.isFinite(min) || min <= 0) return '–';
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function describeWaypoint(wp, index, total) {
  if (wp.label) return wp.label;
  if (index === 0) return 'Partenza';
  if (index === total - 1) return 'Arrivo';
  return `Tappa ${index}`;
}

function roleForWaypoint(index, total) {
  if (index === 0) return { key: 'start', label: 'Partenza', icon: '📍' };
  if (total > 1 && index === total - 1) return { key: 'end', label: 'Destinazione', icon: '🏁' };
  return { key: 'mid', label: `Tappa ${index}`, icon: '•' };
}

export function init(stateModule, mapApi, services, libs) {
  const { brouter, nominatim, geolocation } = services;
  const { gpx, share, elevationChart } = libs;

  const elements = {
    profileSelect: $('profile-select'),
    searchWrap: document.getElementById('search'),
    searchToggle: document.getElementById('search-toggle'),
    searchPanel: document.getElementById('search-panel'),
    searchClose: document.getElementById('search-close'),
    searchInput: $('search-input'),
    searchResults: $('search-results'),
    tappeList: $('tappe-list'),
    btnAdd: $('btn-add-waypoint'),
    btnAddCurrent: document.getElementById('add-current'),
    btnGps: $('btn-use-gps'),
    menuBtn: document.getElementById('menu-btn'),
    menuPopover: document.getElementById('menu-popover'),
    menuAbout: document.getElementById('menu-about'),
    menuReset: document.getElementById('menu-reset'),
    sheetStops: document.getElementById('sheet-stops'),
    sheetStopsHandle: document.getElementById('sheet-stops-handle'),
    sheetResult: document.getElementById('result-sheet'),
    sheetResultHandle: document.getElementById('sheet-result-handle'),
    sheetResultClose: document.getElementById('sheet-result-close'),
    resultSheet: $('result-sheet'),
    statsKm: $('stats-km'),
    statsDpos: $('stats-dpos'),
    statsDneg: $('stats-dneg'),
    statsTime: $('stats-time'),
    statsGradeAvg: document.getElementById('stats-grade-avg'),
    statsGradeMax: document.getElementById('stats-grade-max'),
    statsElevMin: document.getElementById('stats-elev-min'),
    statsElevMax: document.getElementById('stats-elev-max'),
    statsFountains: document.getElementById('stats-fountains'),
    statsSterrato: $('stats-sterrato'),
    statsCiclabile: $('stats-ciclabile'),
    statsRoad: document.getElementById('pct-road'),
    surfCycle: document.getElementById('surf-cycle'),
    surfOff: document.getElementById('surf-off'),
    surfRoad: document.getElementById('surf-road'),
    chartCanvas: $('elevation-chart'),
    btnGpx: $('btn-gpx'),
    btnShare: $('btn-share'),
    btnAnotherLoop: document.getElementById('btn-another-loop'),
    toastContainer: $('toast-container'),
    // Distanza target
    tdEnable: document.getElementById('td-enable'),
    tdControls: document.getElementById('td-controls'),
    tdSlider: document.getElementById('td-slider'),
    tdInput: document.getElementById('td-input'),
    tdWarning: document.getElementById('td-warning'),
    tdHint: document.getElementById('td-hint'),
  };

  let chartInstance = null;
  let searchDebounceTimer = null;
  let pendingReplaceId = null;
  let anotherLoopHandler = null;

  function showToast(message, type = 'info') {
    if (!elements.toastContainer) {
      console[type === 'error' ? 'error' : 'log'](`[toast] ${message}`);
      return;
    }
    const toast = document.createElement('div');
    toast.className = `toast toast--${type}`;
    toast.textContent = message;
    elements.toastContainer.appendChild(toast);
    setTimeout(() => {
      toast.classList.add('toast--leaving');
      setTimeout(() => toast.remove(), 250);
    }, TOAST_DURATIONS[type] || 3000);
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function makePlaceholder(role, hint) {
    const li = document.createElement('li');
    li.className = `tappa-placeholder tappa-placeholder--${role.key}`;
    li.setAttribute('role', 'button');
    li.tabIndex = 0;
    li.setAttribute('aria-label', `${role.label}: ${hint}`);
    li.innerHTML = `
      <span class="tappa-placeholder__icon" aria-hidden="true">${role.icon}</span>
      <span class="tappa-placeholder__text">
        <span class="tappa-placeholder__role">${escapeHtml(role.label)}</span>
        <span class="tappa-placeholder__hint">${escapeHtml(hint)}</span>
      </span>
    `;
    const open = () => openWaypointSearch();
    li.addEventListener('click', open);
    li.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    });
    return li;
  }

  function renderTappeList(state) {
    const list = elements.tappeList;
    if (!list) return;
    list.innerHTML = '';
    const total = state.waypoints.length;
    const empty = elements.tappeList.parentElement
      ? elements.tappeList.parentElement.querySelector('#stops-empty')
      : null;

    // Mostra/nascondi il messaggio "Nessuna tappa" — usiamo i placeholder al suo posto
    if (empty) empty.hidden = true;

    if (total === 0) {
      list.appendChild(makePlaceholder(
        { key: 'start', label: 'Partenza', icon: '📍' },
        'Tocca per scegliere da dove partire',
      ));
      list.appendChild(makePlaceholder(
        { key: 'end', label: 'Destinazione', icon: '🏁' },
        'Tocca per scegliere dove arrivare',
      ));
      return;
    }

    state.waypoints.forEach((wp, index) => {
      const role = roleForWaypoint(index, total);
      const item = document.createElement('li');
      item.className = `tappa-item tappa-item--${role.key}`;
      item.dataset.id = wp.id;
      item.draggable = true;

      const badge = role.key === 'start' ? 'A' : role.key === 'end' ? 'B' : String(index + 1);
      const name = describeWaypoint(wp, index, total);
      item.innerHTML = `
        <div class="tappa-item__row">
          <span class="tappa-item__handle" aria-label="Trascina">⋮⋮</span>
          <span class="tappa-item__badge" aria-hidden="true">${badge}</span>
          <span class="tappa-item__label">
            <span class="tappa-item__role">${escapeHtml(role.label)}</span>
            <span class="tappa-item__name">${escapeHtml(name)}</span>
          </span>
          <button type="button" class="tappa-item__remove" aria-label="Rimuovi">×</button>
        </div>
        <div class="tappa-item__actions" aria-hidden="true">
          <button type="button" class="tappa-item__action tappa-item__action--change" data-action="change">Cambia</button>
          <button type="button" class="tappa-item__action tappa-item__action--delete" data-action="delete">Elimina</button>
        </div>
      `;

      item.querySelector('.tappa-item__remove').addEventListener('click', (e) => {
        e.stopPropagation();
        stateModule.removeWaypoint(wp.id);
      });

      // Tap su tutta la riga della tappa: toggla l'area azioni inline
      item.querySelector('.tappa-item__row').addEventListener('click', (e) => {
        // Non interferire con il pulsante "×" o gli handle dnd
        if (e.target.closest('.tappa-item__remove')) return;
        e.stopPropagation();
        const wasActive = item.dataset.active === 'true';
        // Chiudi tutte le altre
        list.querySelectorAll('.tappa-item[data-active="true"]').forEach((el) => {
          if (el !== item) {
            el.dataset.active = 'false';
            const a = el.querySelector('.tappa-item__actions');
            if (a) a.setAttribute('aria-hidden', 'true');
          }
        });
        item.dataset.active = wasActive ? 'false' : 'true';
        const actions = item.querySelector('.tappa-item__actions');
        if (actions) actions.setAttribute('aria-hidden', wasActive ? 'true' : 'false');
        // Centra sulla mappa al primo tap (apertura)
        if (!wasActive) mapApi.flyTo({ lat: wp.lat, lon: wp.lon });
      });

      // Pulsante "Elimina" inline → rimuove subito
      const btnDelete = item.querySelector('.tappa-item__action--delete');
      if (btnDelete) {
        btnDelete.addEventListener('click', (e) => {
          e.stopPropagation();
          stateModule.removeWaypoint(wp.id);
        });
      }
      // Pulsante "Cambia" inline → apre ricerca, marca per sostituzione
      const btnChange = item.querySelector('.tappa-item__action--change');
      if (btnChange) {
        btnChange.addEventListener('click', (e) => {
          e.stopPropagation();
          pendingReplaceId = wp.id;
          openWaypointSearch();
        });
      }

      attachDragAndDrop(item, list);
      list.appendChild(item);
    });

    // Se c'è solo la partenza, aggiungi placeholder destinazione
    if (total === 1) {
      list.appendChild(makePlaceholder(
        { key: 'end', label: 'Aggiungi destinazione', icon: '🏁' },
        'Tocca per scegliere dove arrivare',
      ));
    }
  }

  function attachDragAndDrop(item, list) {
    item.addEventListener('dragstart', (e) => {
      item.classList.add('tappa-item--dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', item.dataset.id);
    });
    item.addEventListener('dragend', () => {
      item.classList.remove('tappa-item--dragging');
      const ids = Array.from(list.querySelectorAll('.tappa-item')).map((el) => el.dataset.id);
      stateModule.reorderWaypoints(ids);
    });
    item.addEventListener('dragover', (e) => {
      e.preventDefault();
      const dragging = list.querySelector('.tappa-item--dragging');
      if (!dragging || dragging === item) return;
      const rect = item.getBoundingClientRect();
      const after = (e.clientY - rect.top) / rect.height > 0.5;
      list.insertBefore(dragging, after ? item.nextSibling : item);
    });
  }

  // Soglia oltre la quale il calcolo iterativo può essere lento
  // (>5 chiamate a BRouter su distanze elevate → tempi 10-30s).
  const SLOW_KM_THRESHOLD = 300;

  function renderTargetDistance(state) {
    const enabled = state.targetDistanceEnabled === true;
    const km = Number.isFinite(state.targetDistanceKm) ? state.targetDistanceKm : 30;

    if (elements.tdEnable && elements.tdEnable.checked !== enabled) {
      elements.tdEnable.checked = enabled;
    }
    if (elements.tdControls) elements.tdControls.hidden = !enabled;
    if (elements.tdSlider) {
      // Aggiorna slider senza generare evento input ricorsivo
      const sliderVal = Math.min(Number(elements.tdSlider.max) || 200, Math.max(5, km));
      if (Number(elements.tdSlider.value) !== sliderVal) {
        elements.tdSlider.value = String(sliderVal);
      }
    }
    if (elements.tdInput) {
      if (Number(elements.tdInput.value) !== km) {
        elements.tdInput.value = String(km);
      }
    }
    if (elements.tdWarning) {
      elements.tdWarning.hidden = !(enabled && km > SLOW_KM_THRESHOLD);
    }
    // Hint dinamico in base a quanti waypoint ci sono
    if (elements.tdHint) {
      const n = state.waypoints.length;
      if (!enabled) {
        elements.tdHint.textContent =
          'Attiva per scegliere la lunghezza desiderata del percorso.';
      } else if (n === 0) {
        elements.tdHint.textContent =
          'Aggiungi una partenza: verrà generato un anello che torna al punto di partenza.';
      } else if (n === 1) {
        elements.tdHint.textContent =
          'Modalità anello: giro che parte e torna alla partenza.';
      } else {
        elements.tdHint.textContent =
          'Modalità estensione: percorso allungato fino al target rispettando le tappe.';
      }
    }
    // Bottone "Altro giro" visibile solo in modalità anello dopo un calcolo
    if (elements.btnAnotherLoop) {
      const isLoopMode = enabled && state.waypoints.length === 1 && state.route;
      elements.btnAnotherLoop.hidden = !isLoopMode;
    }
  }

  function renderStats(state) {
    if (!elements.resultSheet) return;
    if (!state.route) {
      elements.resultSheet.classList.add('result-sheet--hidden');
      elements.resultSheet.dataset.state = 'hidden';
      elements.resultSheet.hidden = true;
      return;
    }
    const stats = state.route.stats || {};
    elements.resultSheet.classList.remove('result-sheet--hidden');
    elements.resultSheet.hidden = false;
    // Mostra il pannello in stato "open" al primo calcolo, poi rispetta lo
    // stato scelto dall'utente (peek/open/full).
    if (elements.resultSheet.dataset.state === 'hidden' || !elements.resultSheet.dataset.state) {
      elements.resultSheet.dataset.state = 'open';
    }
    if (elements.statsKm) elements.statsKm.textContent = formatKm(stats.km);
    if (elements.statsDpos) elements.statsDpos.textContent = `+${formatMeters(stats.dPos)}`;
    if (elements.statsDneg) elements.statsDneg.textContent = `-${formatMeters(stats.dNeg)}`;
    if (elements.statsTime) elements.statsTime.textContent = formatTime(stats.timeMin);
    if (elements.statsGradeAvg) {
      elements.statsGradeAvg.textContent = Number.isFinite(stats.gradeAvg)
        ? stats.gradeAvg.toFixed(1)
        : '—';
    }
    if (elements.statsGradeMax) {
      elements.statsGradeMax.textContent = Number.isFinite(stats.gradeMax)
        ? stats.gradeMax.toFixed(1)
        : '—';
    }
    if (elements.statsElevMin) {
      elements.statsElevMin.textContent = Number.isFinite(stats.eleMin)
        ? String(stats.eleMin)
        : '—';
    }
    if (elements.statsElevMax) {
      elements.statsElevMax.textContent = Number.isFinite(stats.eleMax)
        ? String(stats.eleMax)
        : '—';
    }
    if (elements.statsFountains) {
      elements.statsFountains.textContent = String(stats.fountainsCount ?? 0);
    }
    const pctCycle = Number(stats.pctCiclabile ?? 0);
    const pctOff = Number(stats.pctSterrato ?? 0);
    const pctRoad = Number(stats.pctAsfaltoSecondario ?? Math.max(0, 100 - pctCycle - pctOff));
    if (elements.statsSterrato) elements.statsSterrato.textContent = `${pctOff}%`;
    if (elements.statsCiclabile) elements.statsCiclabile.textContent = `${pctCycle}%`;
    if (elements.statsRoad) elements.statsRoad.textContent = `${Math.round(pctRoad)}%`;
    if (elements.surfCycle) elements.surfCycle.style.width = `${pctCycle}%`;
    if (elements.surfOff) elements.surfOff.style.width = `${pctOff}%`;
    if (elements.surfRoad) elements.surfRoad.style.width = `${pctRoad}%`;

    if (elements.chartCanvas && state.route.elevation) {
      if (!chartInstance) chartInstance = elevationChart.create(elements.chartCanvas, state.route.elevation);
      else elevationChart.update(chartInstance, state.route.elevation);
    }
  }

  function renderSearchResults(results) {
    const box = elements.searchResults;
    if (!box) return;
    box.innerHTML = '';
    if (!results || results.length === 0) {
      box.classList.remove('search-results--open');
      return;
    }
    for (const r of results) {
      const li = document.createElement('li');
      li.className = 'search-result';
      li.textContent = r.displayName;
      li.addEventListener('click', () => {
        const label = r.displayName.split(',')[0];
        if (pendingReplaceId) {
          stateModule.updateWaypoint(pendingReplaceId, {
            lat: r.lat,
            lon: r.lon,
            label,
            source: 'search',
          });
          pendingReplaceId = null;
        } else {
          stateModule.addWaypoint({
            lat: r.lat,
            lon: r.lon,
            label,
            source: 'search',
          });
        }
        box.innerHTML = '';
        box.classList.remove('search-results--open');
        if (elements.searchInput) elements.searchInput.value = '';
        closeSearch();
        mapApi.flyTo({ lat: r.lat, lon: r.lon });
      });
      box.appendChild(li);
    }
    box.classList.add('search-results--open');
  }

  const PROFILE_HINTS = {
    safety: 'Ciclabili e strade secondarie (può allungare per evitare traffico)',
    trekking: 'Ciclabili e asfalto a basso traffico',
    gravel: 'Ciclabili, sterrati e strade bianche',
    fastbike: 'Solo asfalto, evita traffico',
    mtb: 'Sentieri, single-track, sterrati ripidi',
  };

  function updateProfileHint(profile) {
    const hint = document.getElementById('profile-hint');
    if (hint) hint.textContent = PROFILE_HINTS[profile] || '';
  }

  function setProfile(profile) {
    stateModule.update({ profile });
    updateProfileHint(profile);
  }

  function openSearch() {
    if (elements.searchWrap) elements.searchWrap.dataset.open = 'true';
    if (elements.searchPanel) elements.searchPanel.hidden = false;
    if (elements.searchToggle) elements.searchToggle.setAttribute('aria-expanded', 'true');
    if (elements.searchInput) {
      try { elements.searchInput.focus(); } catch (_) { /* fail-soft */ }
    }
  }

  // Apre la ricerca con il bottom-sheet ridotto a peek (libera spazio mappa)
  function openWaypointSearch() {
    if (elements.sheetStops) {
      elements.sheetStops.dataset.state = 'peek';
      if (elements.sheetStopsHandle) {
        elements.sheetStopsHandle.setAttribute('aria-expanded', 'false');
      }
    }
    openSearch();
  }
  function closeSearch() {
    if (elements.searchWrap) elements.searchWrap.dataset.open = 'false';
    if (elements.searchPanel) elements.searchPanel.hidden = true;
    if (elements.searchToggle) elements.searchToggle.setAttribute('aria-expanded', 'false');
    pendingReplaceId = null;
  }

  function openMenu() {
    if (elements.menuPopover) elements.menuPopover.hidden = false;
    if (elements.menuBtn) elements.menuBtn.setAttribute('aria-expanded', 'true');
  }
  function closeMenu() {
    if (elements.menuPopover) elements.menuPopover.hidden = true;
    if (elements.menuBtn) elements.menuBtn.setAttribute('aria-expanded', 'false');
  }
  function isMenuOpen() {
    return !!(elements.menuPopover && !elements.menuPopover.hidden);
  }

  function cycleSheetState(sheetEl, handleEl) {
    if (!sheetEl) return;
    const current = sheetEl.dataset.state || 'peek';
    let next;
    if (current === 'peek') next = 'open';
    else if (current === 'full') next = 'open';
    else next = 'peek';
    sheetEl.dataset.state = next;
    if (handleEl) handleEl.setAttribute('aria-expanded', next === 'peek' ? 'false' : 'true');
  }

  function bindEvents() {
    if (elements.profileSelect) {
      elements.profileSelect.addEventListener('change', (e) => setProfile(e.target.value));
    }

    // --- Search toggle ---
    if (elements.searchToggle) {
      elements.searchToggle.addEventListener('click', (e) => {
        e.stopPropagation();
        openSearch();
      });
    }
    if (elements.searchClose) {
      elements.searchClose.addEventListener('click', (e) => {
        e.stopPropagation();
        closeSearch();
      });
    }
    if (elements.searchInput) {
      elements.searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeSearch();
      });
    }
    document.addEventListener('click', (e) => {
      if (!elements.searchWrap) return;
      if (elements.searchWrap.dataset.open !== 'true') return;
      if (!elements.searchWrap.contains(e.target)) closeSearch();
    });

    // Chiudi pannello azioni tappa quando si clicca fuori
    document.addEventListener('click', (e) => {
      if (!elements.tappeList) return;
      const active = elements.tappeList.querySelector('.tappa-item[data-active="true"]');
      if (!active) return;
      if (!active.contains(e.target)) {
        active.dataset.active = 'false';
        const actions = active.querySelector('.tappa-item__actions');
        if (actions) actions.setAttribute('aria-hidden', 'true');
      }
    });

    // --- Menu kebab ---
    if (elements.menuBtn) {
      elements.menuBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (isMenuOpen()) closeMenu();
        else openMenu();
      });
    }
    if (elements.menuReset) {
      elements.menuReset.addEventListener('click', () => {
        closeMenu();
        if (confirm('Azzerare il percorso corrente?')) {
          stateModule.update({ waypoints: [], route: null });
        }
      });
    }
    if (elements.menuAbout) {
      elements.menuAbout.addEventListener('click', () => {
        closeMenu();
        showToast(
          'Ciclovia — Percorsi ciclabili evita-traffico. Dati: BRouter + OpenStreetMap.',
          'info',
        );
      });
    }
    if (elements.menuPopover) {
      elements.menuPopover.addEventListener('click', (e) => e.stopPropagation());
    }
    document.addEventListener('click', (e) => {
      if (!isMenuOpen()) return;
      if (elements.menuBtn && elements.menuBtn.contains(e.target)) return;
      if (elements.menuPopover && elements.menuPopover.contains(e.target)) return;
      closeMenu();
    });

    // --- Sheet handles ---
    if (elements.sheetStops && !elements.sheetStops.dataset.state) {
      elements.sheetStops.dataset.state = 'peek';
    }
    if (elements.sheetStopsHandle) {
      elements.sheetStopsHandle.addEventListener('click', () => {
        cycleSheetState(elements.sheetStops, elements.sheetStopsHandle);
      });
    }
    if (elements.sheetResultHandle) {
      elements.sheetResultHandle.addEventListener('click', () => {
        cycleSheetState(elements.sheetResult, elements.sheetResultHandle);
      });
    }
    if (elements.sheetResultClose) {
      elements.sheetResultClose.addEventListener('click', () => {
        if (elements.sheetResult) {
          elements.sheetResult.dataset.state = 'hidden';
          elements.sheetResult.hidden = true;
        }
      });
    }

    // --- "Posizione" button (add current GPS as waypoint) ---
    if (elements.btnAddCurrent) {
      elements.btnAddCurrent.addEventListener('click', async () => {
        try {
          const pos = await geolocation.getCurrent();
          stateModule.addWaypoint({
            lat: pos.lat,
            lon: pos.lon,
            label: 'Posizione attuale',
            source: 'gps',
          });
        } catch (err) {
          showToast(err.message || 'Errore di geolocalizzazione.', 'error');
        }
      });
    }

    if (elements.searchInput) {
      elements.searchInput.addEventListener('input', (e) => {
        const q = e.target.value;
        clearTimeout(searchDebounceTimer);
        if (!q || q.length < 3) {
          renderSearchResults([]);
          return;
        }
        searchDebounceTimer = setTimeout(async () => {
          try {
            const results = await nominatim.search(q, { limit: 5 });
            if (results.length === 0) showToast('Nessun luogo trovato.', 'info');
            renderSearchResults(results);
          } catch (err) {
            if (err.name === 'NominatimRateLimitError') {
              showToast('Troppe ricerche, attendi.', 'error');
            } else {
              showToast('Ricerca non riuscita.', 'error');
            }
          }
        }, 350);
      });
    }

    if (elements.btnAdd) {
      elements.btnAdd.addEventListener('click', (e) => {
        e.stopPropagation();
        openWaypointSearch();
      });
    }

    if (elements.btnGps) {
      elements.btnGps.addEventListener('click', async () => {
        try {
          const pos = await geolocation.getCurrent();
          stateModule.addWaypoint({
            lat: pos.lat,
            lon: pos.lon,
            label: 'Posizione attuale',
            source: 'gps',
          });
          mapApi.flyTo({ lat: pos.lat, lon: pos.lon });
          if (pos.accuracy > 500) {
            showToast(`Posizione imprecisa (±${Math.round(pos.accuracy)} m).`, 'info');
          }
        } catch (err) {
          showToast(err.message || 'Errore di geolocalizzazione.', 'error');
        }
      });
    }

    if (elements.btnGpx) {
      elements.btnGpx.addEventListener('click', () => {
        const state = stateModule.getState();
        if (!state.route) {
          showToast('Calcola prima un percorso.', 'info');
          return;
        }
        const xml = gpx.fromGeoJSON(state.route.geojson, { name: 'Ciclovia route' });
        const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        gpx.download(xml, `ciclovia-${date}.gpx`);
      });
    }

    // --- Distanza target: toggle + slider + input numerico ---
    if (elements.tdEnable) {
      elements.tdEnable.addEventListener('change', (e) => {
        stateModule.update({ targetDistanceEnabled: !!e.target.checked });
      });
    }
    if (elements.tdSlider) {
      elements.tdSlider.addEventListener('input', (e) => {
        const km = Math.max(1, parseInt(e.target.value, 10) || 1);
        stateModule.update({ targetDistanceKm: km });
      });
    }
    if (elements.tdInput) {
      elements.tdInput.addEventListener('input', (e) => {
        const raw = parseInt(e.target.value, 10);
        if (!Number.isFinite(raw) || raw < 1) return;
        stateModule.update({ targetDistanceKm: raw });
      });
      elements.tdInput.addEventListener('blur', (e) => {
        const raw = parseInt(e.target.value, 10);
        if (!Number.isFinite(raw) || raw < 1) {
          // Ripristina valore valido se l'utente ha lasciato l'input invalido
          const current = stateModule.getState();
          e.target.value = String(current.targetDistanceKm || 30);
        }
      });
    }

    // --- Bottone "Altro giro" (visibile solo in modalità anello) ---
    if (elements.btnAnotherLoop) {
      elements.btnAnotherLoop.addEventListener('click', () => {
        if (anotherLoopHandler) anotherLoopHandler();
      });
    }

    if (elements.btnShare) {
      elements.btnShare.addEventListener('click', async () => {
        const state = stateModule.getState();
        if (state.waypoints.length < 2) {
          showToast('Aggiungi almeno due punti.', 'info');
          return;
        }
        const url = share.toUrl(state);
        try {
          const result = await share.shareOrCopy(url);
          if (result.method === 'clipboard') showToast('Link copiato negli appunti.', 'success');
        } catch (err) {
          showToast(err.message || 'Impossibile condividere.', 'error');
        }
      });
    }
  }

  bindEvents();

  return {
    renderAll(state) {
      if (elements.profileSelect && elements.profileSelect.value !== state.profile) {
        elements.profileSelect.value = state.profile;
      }
      updateProfileHint(state.profile);
      renderTappeList(state);
      renderTargetDistance(state);
      renderStats(state);
    },
    showToast,
    onAnotherLoop(callback) {
      anotherLoopHandler = callback;
    },
  };
}

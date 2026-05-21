const ROLE_COLORS = {
  start: '#2d5016',
  end: '#e07b00',
  via: '#666666',
};

// Colori percorso per tipo strada (Feature 3)
const SEGMENT_COLORS = {
  gravel: '#f5f5f0',    // bianco sterrato (con sottobordo per visibilità)
  asphalt: '#6b7280',   // grigio asfalto secondario
  cycleway: '#2563eb',  // blu ciclabile dedicata
  path: '#b45309',      // arancio scuro sentiero/track
  busy: '#dc2626',      // rosso strada trafficata
};

const LONG_PRESS_MS = 500;
const LONG_PRESS_MOVE_TOLERANCE = 8; // px

function buildIcon(role, label) {
  const color = ROLE_COLORS[role] || ROLE_COLORS.via;
  const html = `
    <div class="ciclovia-marker ciclovia-marker--${role}" style="--marker-color:${color}">
      <span class="ciclovia-marker__label">${label ?? ''}</span>
    </div>`;
  return L.divIcon({
    className: 'ciclovia-marker-wrapper',
    html,
    iconSize: [28, 28],
    iconAnchor: [14, 28],
  });
}

function roleFor(index, total) {
  if (index === 0) return 'start';
  if (index === total - 1 && total > 1) return 'end';
  return 'via';
}

export function init(containerId, { center = [44.39, 7.55], zoom = 12 } = {}) {
  const map = L.map(containerId, { zoomControl: false }).setView(center, zoom);

  L.control.zoom({ position: 'bottomleft' }).addTo(map);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap',
    maxZoom: 19,
  }).addTo(map);

  let routeLayer = null;
  let fountainsLayer = null;
  const markers = new Map();
  let markerDragHandler = null;
  let longPressHandler = null;
  let markerDeleteHandler = null;
  const MARKER_LONG_PRESS_MS = 500;

  function refreshMarkerIcons() {
    let i = 0;
    const total = markers.size;
    for (const entry of markers.values()) {
      const role = roleFor(i, total);
      const label = role === 'via' ? String(i + 1) : role === 'start' ? 'A' : 'B';
      entry.marker.setIcon(buildIcon(role, label));
      i++;
    }
  }

  function attachMarkerDrag(marker, id) {
    marker.on('dragend', () => {
      const ll = marker.getLatLng();
      if (markerDragHandler) markerDragHandler(id, { lat: ll.lat, lon: ll.lng });
    });
  }

  function attachMarkerLongPress(marker, id) {
    let timer = null;
    let triggered = false;

    const popupHtml = `
      <div class="marker-popup">
        <button type="button" class="marker-popup__delete" data-marker-delete>Elimina tappa</button>
      </div>`;
    marker.bindPopup(popupHtml, {
      closeButton: false,
      offset: [0, -8],
      className: 'ciclovia-marker-popup',
    });

    marker.on('popupopen', (e) => {
      const root = e.popup.getElement();
      if (!root) return;
      const btn = root.querySelector('[data-marker-delete]');
      if (btn) {
        btn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          marker.closePopup();
          if (markerDeleteHandler) markerDeleteHandler(id);
        });
      }
    });

    const start = () => {
      triggered = false;
      clearTimeout(timer);
      timer = setTimeout(() => {
        triggered = true;
        marker.openPopup();
      }, MARKER_LONG_PRESS_MS);
    };
    const cancel = () => {
      clearTimeout(timer);
      timer = null;
    };

    marker.on('mousedown', start);
    marker.on('touchstart', start);
    marker.on('mouseup', cancel);
    marker.on('mouseout', cancel);
    marker.on('touchend', cancel);
    marker.on('touchcancel', cancel);
    marker.on('dragstart', cancel);
    // Evita che il "click" sulla mappa subito dopo il long-press richiuda il popup
    marker.on('click', (e) => {
      if (triggered) {
        L.DomEvent.stopPropagation(e);
        triggered = false;
      }
    });
  }

  function setupLongPress() {
    const container = map.getContainer();
    let timer = null;
    let startPoint = null;
    let startLatLng = null;

    const clear = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      startPoint = null;
      startLatLng = null;
    };

    const onDown = (e) => {
      const point = e.touches ? e.touches[0] : e;
      startPoint = { x: point.clientX, y: point.clientY };
      const rect = container.getBoundingClientRect();
      const layerPoint = L.point(startPoint.x - rect.left, startPoint.y - rect.top);
      startLatLng = map.containerPointToLatLng(layerPoint);
      timer = setTimeout(() => {
        if (startLatLng && longPressHandler) {
          longPressHandler({ lat: startLatLng.lat, lon: startLatLng.lng });
        }
        timer = null;
      }, LONG_PRESS_MS);
    };

    const onMove = (e) => {
      if (!startPoint || !timer) return;
      const point = e.touches ? e.touches[0] : e;
      const dx = point.clientX - startPoint.x;
      const dy = point.clientY - startPoint.y;
      if (Math.hypot(dx, dy) > LONG_PRESS_MOVE_TOLERANCE) clear();
    };

    container.addEventListener('mousedown', onDown);
    container.addEventListener('mousemove', onMove);
    container.addEventListener('mouseup', clear);
    container.addEventListener('mouseleave', clear);
    container.addEventListener('touchstart', onDown, { passive: true });
    container.addEventListener('touchmove', onMove, { passive: true });
    container.addEventListener('touchend', clear);
    container.addEventListener('touchcancel', clear);
  }

  setupLongPress();

  return {
    leaflet: map,

    drawRoute(geojson, segments) {
      this.clearRoute();
      if (!geojson || !geojson.coordinates || geojson.coordinates.length === 0) return;

      const coords = geojson.coordinates;

      // Modalità segmentata (Feature 3): una polilinea per tipo strada con colori dedicati.
      // `segments` ora è un array di { type, startIdx, endIdx } che indicizza
      // `geojson.coordinates` — così la polilinea segue tutti i punti curvilinei
      // del geojson, non solo gli estremi dei nodi OSM dei messages BRouter.
      if (Array.isArray(segments) && segments.length > 0) {
        const group = L.featureGroup();
        for (const seg of segments) {
          if (!seg || typeof seg.startIdx !== 'number' || typeof seg.endIdx !== 'number') continue;
          if (seg.endIdx <= seg.startIdx) continue;
          // slice(start, end+1) per includere l'estremo finale.
          // Converte da [lon,lat] (geojson) a [lat,lon] (Leaflet).
          const slice = coords.slice(seg.startIdx, seg.endIdx + 1);
          if (slice.length < 2) continue;
          const latlngs = slice.map((c) => [c[1], c[0]]);
          const color = SEGMENT_COLORS[seg.type] || SEGMENT_COLORS.asphalt;
          // Per il colore "bianco" (gravel) aggiungi un sottobordo scuro per visibilità.
          if (seg.type === 'gravel') {
            L.polyline(latlngs, {
              color: '#444',
              weight: 7,
              opacity: 0.7,
              lineJoin: 'round',
              lineCap: 'round',
            }).addTo(group);
          }
          L.polyline(latlngs, {
            color,
            weight: 6,
            opacity: 0.85,
            lineJoin: 'round',
            lineCap: 'round',
          }).addTo(group);
        }
        if (group.getLayers().length > 0) {
          group.addTo(map);
          routeLayer = group;
          return;
        }
        // Se nessun segmento è risultato disegnabile, cadi nel fallback.
      }

      // Fallback: polilinea singola verde.
      const latlngs = coords.map((c) => [c[1], c[0]]);
      routeLayer = L.polyline(latlngs, {
        color: '#2d5016',
        weight: 5,
        opacity: 0.9,
        lineJoin: 'round',
        lineCap: 'round',
      }).addTo(map);
    },

    clearRoute() {
      if (routeLayer) {
        map.removeLayer(routeLayer);
        routeLayer = null;
      }
    },

    drawFountains(fountains) {
      this.clearFountains();
      if (!Array.isArray(fountains) || fountains.length === 0) return;
      fountainsLayer = L.layerGroup();
      // Marker stile "tappa" ma più piccolo, azzurro, con goccia bianca al centro.
      // Distinzione visiva tra acqua potabile (azzurro pieno) e altre fonti
      // (azzurro chiaro con bordo tratteggiato), per evitare ambiguità.
      const iconHtml = (potable) => `
        <div class="fountain-marker ${potable ? 'fountain-marker--potable' : 'fountain-marker--other'}">
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
            <path d="M12 2c-3 4-6 7-6 11a6 6 0 0 0 12 0c0-4-3-7-6-11z"
                  fill="#ffffff" stroke="#ffffff" stroke-width="0.5"
                  stroke-linejoin="round"/>
          </svg>
        </div>`;
      for (const f of fountains) {
        if (!Number.isFinite(f.lat) || !Number.isFinite(f.lon)) continue;
        const icon = L.divIcon({
          className: '',
          html: iconHtml(f.potable !== false),
          iconSize: [22, 22],
          iconAnchor: [11, 11],
          popupAnchor: [0, -12],
        });
        const label = f.name || f.kind || 'Fontanella';
        const sub = f.potable === false ? ' (verificare potabilità)' : '';
        L.marker([f.lat, f.lon], { icon, keyboard: false })
          .bindPopup(`💧 <b>${label}</b>${sub}`)
          .addTo(fountainsLayer);
      }
      fountainsLayer.addTo(map);
    },

    clearFountains() {
      if (fountainsLayer) {
        map.removeLayer(fountainsLayer);
        fountainsLayer = null;
      }
    },

    addMarker(waypoint) {
      if (markers.has(waypoint.id)) return;
      const marker = L.marker([waypoint.lat, waypoint.lon], {
        draggable: true,
        icon: buildIcon('via', ''),
        title: waypoint.label || '',
      }).addTo(map);
      attachMarkerDrag(marker, waypoint.id);
      attachMarkerLongPress(marker, waypoint.id);
      markers.set(waypoint.id, { marker });
      refreshMarkerIcons();
    },

    removeMarker(id) {
      const entry = markers.get(id);
      if (!entry) return;
      map.removeLayer(entry.marker);
      markers.delete(id);
      refreshMarkerIcons();
    },

    updateMarker(id, latlng) {
      const entry = markers.get(id);
      if (!entry) return;
      const lat = latlng.lat;
      const lon = latlng.lon ?? latlng.lng;
      entry.marker.setLatLng([lat, lon]);
    },

    clearMarkers() {
      for (const { marker } of markers.values()) map.removeLayer(marker);
      markers.clear();
    },

    fitToRoute(geojson) {
      if (!geojson || !geojson.coordinates || geojson.coordinates.length === 0) return;
      const bounds = L.latLngBounds(geojson.coordinates.map((c) => [c[1], c[0]]));
      map.fitBounds(bounds, { padding: [40, 40] });
    },

    flyTo(latlng, z = 14) {
      const lat = latlng.lat;
      const lon = latlng.lon ?? latlng.lng;
      map.flyTo([lat, lon], z, { duration: 0.6 });
    },

    onLongPress(callback) {
      longPressHandler = callback;
    },

    onMarkerDrag(callback) {
      markerDragHandler = callback;
    },

    onMarkerDelete(callback) {
      markerDeleteHandler = callback;
    },
  };
}

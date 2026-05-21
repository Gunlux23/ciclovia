# Ciclovia — Design

**Data:** 2026-05-20
**Autore:** Bruno (Gunlux23)
**Stato:** Approvato per implementazione

## 1. Obiettivo

Costruire una **PWA** che calcoli percorsi ciclistici ottimizzati per **evitare il traffico automobilistico**, preferendo piste ciclabili, sterrati e strade secondarie. L'utente inserisce partenza, arrivo e tappe intermedie; l'app restituisce un percorso interamente percorribile in bici con statistiche e file GPX scaricabile.

## 2. Requisiti

### Funzionali (MVP)
- Inserimento partenza/arrivo/tappe via: GPS attuale, ricerca indirizzo, tap sulla mappa, drag dei marker
- Tappe intermedie illimitate, riordinabili
- Selezione profilo bici: trekking, gravel, road (fastbike), MTB
- Calcolo percorso via BRouter
- Visualizzazione su mappa con polilinea evidenziata
- Statistiche: km, dislivello +/-, tempo stimato, % sterrato vs asfalto, % piste ciclabili
- Grafico altimetrico interattivo
- Export GPX
- Link condivisibile (URL serializzato)
- PWA installabile (mobile + desktop)
- Funzionamento parziale offline (ultimo percorso + tile cachate)

### Non funzionali
- Mobile-first
- Italiano come lingua principale
- Zero backend (nessun server custom, nessun DB, nessun auth)
- Tempo di calcolo percorso < 5s su rete 4G normale
- Bundle iniziale < 300 KB (escluso Leaflet/Chart vendor)

### Fuori scope (MVP)
- Account utente / salvataggio percorsi server-side
- Multi-percorso simultaneo / alternative
- Navigazione turn-by-turn
- Integrazione Strava/Komoot
- Self-hosting BRouter

## 3. Architettura

**PWA statica single-page** servita da qualsiasi static host (o aperta come `file://`).

### Fonti dati esterne

| Servizio | Endpoint | Uso |
|----------|----------|-----|
| BRouter | `https://brouter.de/brouter` | Calcolo percorso (GeoJSON + altimetria) |
| Nominatim | `https://nominatim.openstreetmap.org` | Geocoding indirizzi |
| OSM tiles | `https://{s}.tile.openstreetmap.org` | Sfondo mappa |

Tutte chiamate via `fetch()` dal browser. Headers `User-Agent` rispettati per Nominatim (richiesto dalle ToS: identifichiamo l'app come `Ciclovia/1.0`).

### Persistenza
- `localStorage`: ultimo set di waypoint + profilo selezionato
- Service worker cache: app shell + tile OSM visitati + ultime 10 risposte BRouter
- URL query string: serializzazione waypoint per condivisione

### Diagramma

```
┌─────────────────────────────────────────┐
│            Browser (PWA)                │
│  ┌─────────────┐    ┌──────────────┐    │
│  │  Leaflet    │    │ Chart.js     │    │
│  └─────────────┘    └──────────────┘    │
│  ┌────────────────────────────────────┐ │
│  │  app.js (orchestrazione)           │ │
│  └────────────────────────────────────┘ │
│  ┌────────────────────────────────────┐ │
│  │ services: brouter/nominatim/geo    │ │
│  └────────────────────────────────────┘ │
│  ┌────────────────────────────────────┐ │
│  │       Service Worker (cache)       │ │
│  └────────────────────────────────────┘ │
└──────────────┬──────────────────────────┘
               │ HTTPS
       ┌───────┼───────┐
       ▼       ▼       ▼
   BRouter  Nominatim  OSM tiles
```

## 4. Struttura file

```
ciclovia/
├── index.html
├── manifest.webmanifest
├── sw.js
├── css/
│   └── style.css
├── js/
│   ├── app.js              # entry: init, eventi, orchestrazione
│   ├── state.js            # stato globale con pub/sub
│   ├── map.js              # wrapper Leaflet
│   ├── ui.js               # pannelli DOM
│   ├── services/
│   │   ├── brouter.js
│   │   ├── nominatim.js
│   │   └── geolocation.js
│   ├── lib/
│   │   ├── gpx.js          # GeoJSON → GPX
│   │   ├── share.js        # waypoint ↔ URL
│   │   ├── stats.js        # km, dislivello, % superfici
│   │   └── elevation-chart.js
│   └── vendor/
│       ├── leaflet.js / .css
│       └── chart.umd.js
├── icons/
│   ├── icon-192.png
│   └── icon-512.png
└── tests/
    ├── test.html           # unit test browser
    ├── checklist.md        # manual test
    └── smoke.sh            # curl BRouter
```

### Boundary tra moduli

- `state.js` è l'**unica** sorgente di verità. Espone `get()`, `update(patch)`, `subscribe(fn)`.
- `map.js` non sa nulla di BRouter o stato globale: riceve eventi (drawRoute, addMarker), emette eventi (onLongPress, onMarkerDrag).
- `services/*` non toccano il DOM né `state` direttamente. Funzioni pure async.
- `lib/*` sono funzioni pure (no I/O esterno tranne download GPX).
- `app.js` orchestra: ascolta UI/mappa → chiama servizi → aggiorna stato → trigger render.

## 5. Modello dati (stato)

```js
{
  waypoints: [
    { id: 'w1', lat: 44.39, lon: 7.55, label: 'Cuneo', source: 'search' }
  ],
  profile: 'trekking',  // 'trekking' | 'gravel' | 'fastbike' | 'mtb'
  route: {
    geojson: { type:'LineString', coordinates: [[lon,lat,ele], ...] },
    stats: {
      km: 42.3,
      dPos: 520, dNeg: 480,
      timeMin: 145,
      pctSterrato: 28,
      pctCiclabile: 12,
      pctAsfaltoSecondario: 60,
    },
    elevation: [{ km: 0, ele: 530 }, { km: 0.5, ele: 545 }, ...],
  },
  status: 'idle' | 'loading' | 'error',
  error: null,
}
```

## 6. Data flow

### Calcolo percorso (azione centrale)

```
utente cambia waypoint/profilo
  → state.update({ waypoints | profile })
  → debounce 400ms se waypoints.length ≥ 2
  → app.recalculateRoute()
  → brouter.fetchRoute(waypoints, profile)
     URL: brouter.de/brouter?lonlats=lon,lat|lon,lat&profile=X&format=geojson
  → parse GeoJSON → stats.compute()
  → state.update({ route })
  → subscriber: map.drawRoute() + ui.renderStats() + elevationChart.update()
```

### Aggiunta waypoint

| Source | Trigger | Servizio |
|--------|---------|----------|
| gps | tap "📍" su pannello tappe | `geolocation.getCurrent()` |
| search | input in barra ricerca + scelta risultato | `nominatim.search()` |
| tap | long-press 500ms sulla mappa | nessuno (lat/lon dal click) |
| drag | dragend su marker esistente | nessuno |

Ogni aggiunta/modifica → `state.update` → ricalcolo automatico (debounced).

### Persistenza & restore

All'avvio:
1. Se URL ha `?p=...` → `share.deserialize()` → `state.update({ waypoints, profile })`
2. Altrimenti se `localStorage.ciclovia.v1` esiste → restore
3. Altrimenti stato vuoto (solo richiesta posizione GPS opzionale)

Su ogni cambio: `localStorage.setItem('ciclovia.v1', JSON.stringify({waypoints, profile}))`.

### Export GPX

```
ui click "Scarica GPX"
  → gpx.fromGeoJSON(state.route.geojson, { name: 'Ciclovia ...' })
  → Blob('application/gpx+xml')
  → URL.createObjectURL → <a download="ciclovia-YYYYMMDD.gpx"> click()
```

### Condivisione

```
serialize: { waypoints, profile } → JSON → base64url → URL ?p=...
share: navigator.share({ url }) se supportato, altrimenti clipboard.writeText
```

### Calcolo % superfici (stats.js)

BRouter restituisce `messages` per ogni segmento con tag OSM tra cui `surface` e `highway`:
- `surface ∈ {gravel, dirt, ground, unpaved, sand, compacted}` → sterrato
- `highway = cycleway` o `bicycle = designated` → ciclabile
- altrimenti → asfalto secondario

Somma distanze per categoria / distanza totale × 100.

## 7. UI (mobile-first)

Layout a stack: mappa full-screen di base, pannelli sovrapposti.

1. **Top bar** (sticky): logo "Ciclovia", selettore profilo (dropdown), menu (about, reset)
2. **Floating search** (collapsabile, top-right): icona lente → input
3. **Bottom sheet "Tappe"** (drag-up): lista riordinabile dei waypoint, pulsanti `+` e `📍`
4. **Bottom sheet "Risultato"** (compare dopo il calcolo, drag-up): statistiche grandi (km/dislivello), mini-grafico altimetria, pulsanti GPX/condividi

Tap sulla mappa lungo (500ms) → toast "Aggiunto come [tappa N]".

Drag marker → ricalcolo automatico (debounced).

## 8. Error handling

| Scenario | Comportamento |
|----------|---------------|
| BRouter timeout (>15s) o 5xx | Toast rosso "Servizio routing non raggiungibile". Stato preservato. |
| BRouter "no route possible" | Marker sospetto evidenziato in rosso, messaggio inline. |
| Nominatim 0 risultati | Inline "Nessun luogo trovato". |
| Nominatim rate limit (429) | Toast "Troppe ricerche, attendi". Debounce 1s tra ricerche. |
| Geolocation negata | Toast con istruzioni; fallback su ricerca/tap. |
| Geolocation imprecisa (accuracy >500m) | Marker con cerchio di accuratezza, no blocco. |
| Tile offline | Aree grigie (default Leaflet). |
| `localStorage` non disponibile | Try/catch silenzioso, app funziona senza persistenza. |
| Download GPX non supportato | Apri in nuova tab come `data:` URL. |

**Principio**: nessun errore distrugge lo stato; sempre fallback usabile; messaggi in italiano.

## 9. PWA

### manifest.webmanifest
```json
{
  "name": "Ciclovia",
  "short_name": "Ciclovia",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#f5f5f0",
  "theme_color": "#2d5016",
  "icons": [
    {"src":"icons/icon-192.png","sizes":"192x192","type":"image/png"},
    {"src":"icons/icon-512.png","sizes":"512x512","type":"image/png"}
  ]
}
```

### Service worker (sw.js)
Tre cache separate:
- `ciclovia-shell-v1`: HTML/CSS/JS/vendor (cache-first, precached on install)
- `ciclovia-tiles-v1`: tile OSM (stale-while-revalidate, max 200 entry LRU)
- `ciclovia-routes-v1`: risposte BRouter (cache-first per chiave `lonlats+profile`, max 10 LRU)

Aggiornamento app: nuovo SW si attiva al prossimo avvio (skipWaiting opzionale con prompt).

## 10. Testing

1. **Unit test inline** (`tests/test.html`): asserzioni base su `stats.js`, `gpx.js`, `share.js`. Apertura nel browser, risultati visibili.
   - Esempio: GeoJSON fixture con 3 segmenti surface=gravel → `pctSterrato == 33`.
2. **Checklist manuale** (`tests/checklist.md`): scenari smoke da provare prima di pushare.
3. **Smoke real** (`tests/smoke.sh`): `curl` a BRouter con waypoint fissi (es. Cuneo→Mondovì), verifica GeoJSON valido.

## 11. Deploy

MVP testabile locale aprendo `index.html` (alcune feature degradate: geolocation richiede HTTPS, service worker richiede `http://localhost`).

Per uso reale via telefono: deploy su Netlify drop / GitHub Pages (gratis, HTTPS automatico). Configurazione futura, non bloccante per MVP.

## 12. Dipendenze esterne

| Libreria | Versione | Come | Note |
|----------|----------|------|------|
| Leaflet | 1.9.x | locale `js/vendor/` | mappa |
| Chart.js | 4.x | locale `js/vendor/` | altimetria |
| Leaflet.Locate | 0.83.x (opz.) | locale | pulsante GPS pretty |

Niente npm, niente build step. Le librerie vendor sono scaricate una tantum e committate nel repo.

## 13. Rischi noti

- **BRouter rate limit / disponibilità**: API pubblica gratuita, nessuna SLA. Se diventa problema → self-host (sezione futura).
- **Nominatim ToS**: max 1 req/s, User-Agent obbligatorio, no uso pesante. Per ricerche frequenti valutare Photon.
- **Accuratezza % superfici**: dipende dalla qualità tag OSM nella zona. In aree poco mappate è approssimativo.
- **Profili BRouter "evita-traffico"**: ottimi ma non perfetti. Il profilo `trekking` è il default ragionevole.

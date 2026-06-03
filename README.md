# Ciclovia

PWA per calcolare **percorsi ciclistici** che evitano il traffico automobilistico, preferendo piste ciclabili, sterrati e strade secondarie. Routing via [BRouter](https://brouter.de), mappa via [OpenStreetMap](https://www.openstreetmap.org), geocoding via [Nominatim](https://nominatim.openstreetmap.org).

Zero backend, zero npm, zero build step.

<!-- BADGE VERSIONE: aggiornare il numero qui sotto ad ogni release, in sincronia
     con APP_VERSION in js/ui.js e il tag git. L'URL invece resta sempre lo stesso. -->
## ▶ Apri l'app

**[Apri Ciclovia — v1.0](https://gunlux23.github.io/ciclovia/)** — funziona su **desktop** e mobile, installabile come PWA.

> Link diretto (sempre lo stesso ad ogni versione): <https://gunlux23.github.io/ciclovia/>

## Come usarla

Apri `index.html` da un **server locale** (il service worker e la geolocalizzazione richiedono `http://localhost` o HTTPS, non `file://`):

```bash
# opzione 1 — Python (preinstallato ovunque)
python3 -m http.server 8000

# opzione 2 — Node
npx serve .
```

Poi vai a <http://localhost:8000>.

### Cosa puoi fare

- Aggiungere partenza, arrivo e tappe intermedie via GPS, ricerca indirizzo, tap-lungo sulla mappa, drag dei marker
- **Riordinare le tappe** trascinandole nella lista
- Premere **Calcola** per generare il percorso: prima componi tutte le tappe, poi calcoli (calcolo on-demand)
- Scegliere il profilo bici (incluso **Evita traffico**)
- Impostare una **distanza target**: con la sola partenza genera un **anello** che torna al punto di partenza; con partenza + arrivo allunga il percorso fino ai km desiderati
- Mostrare la **tua posizione in tempo reale** sulla mappa
- Vedere statistiche (km, dislivello, % sterrato vs asfalto vs ciclabile) e grafico altimetrico
- Vedere le **fontanelle di acqua potabile** lungo il percorso (dati OSM via Overpass)
- Scaricare il percorso come **GPX**
- Condividere il percorso via **link** (waypoint serializzati in URL)
- Rivedere e ricaricare percorsi dalla **cronologia**
- Installare la PWA su desktop o mobile

## Profili supportati

| Profilo (UI)             | Valore BRouter | Quando usarlo                                              |
|--------------------------|----------------|-----------------------------------------------------------|
| **Evita traffico** (default) | `safety`   | Privilegia ciclabili e strade secondarie, può allungare il giro per evitare il traffico |
| Trekking                 | `trekking`     | Mix di ciclabili e asfalto a basso traffico               |
| Gravel                   | `gravel`       | Predilige sterrati e strade bianche                       |
| Strada                   | `fastbike`     | Road bike, solo asfalto, pendenze contenute               |
| MTB                      | `mtb`          | Sentieri tecnici, single-track, sterrato impegnativo      |

> Per "Evita traffico" il routing applica una **cascata di fallback** anti-traffico: prova profili progressivamente più permissivi finché azzera i tratti su strade trafficate, accettando sterrato/sentieri pur di evitarle.

## Limitazioni note

- **BRouter pubblico**: API gratuita senza SLA, può essere lenta o non disponibile. Se diventa un problema → self-host.
- **Nominatim**: max **1 richiesta al secondo**, User-Agent obbligatorio. Il client applica debounce.
- **Fontanelle (Overpass)**: API pubblica gratuita senza SLA; le fontanelle mostrate dipendono dai tag OSM `drinking_water`/`drinking_fountain` nella zona e possono essere incomplete.
- **% superfici**: dipende dalla qualità dei tag OSM nella zona; in aree poco mappate è approssimativa.
- Funzionamento offline parziale: app shell + ultimo percorso + tile già visitate, niente nuovi calcoli.

## Test

### Unit test (browser)

Avvia il server locale (sopra) e apri <http://localhost:8000/tests/test.html>. I test sono ES module, quindi non funzionano da `file://`.

Ogni assertion viene mostrata in verde (pass) o rosso (fail), con riepilogo finale in alto.

### Smoke reale BRouter

```bash
./tests/smoke.sh
```

Lo script fa una chiamata reale a BRouter (Cuneo → Mondovì, profilo trekking), verifica che la risposta sia GeoJSON valido, e — se `jq` è installato — stampa km e dislivello.

### Checklist manuale

Prima di ogni push significativo, esegui i 25+ scenari in [`tests/checklist.md`](tests/checklist.md): GPS, ricerca, drag, calcolo per ogni profilo, GPX, condivisione, errori, offline, PWA install.

## Deploy

L'app è 100% statica. Il modo più rapido:

- **Netlify Drop** — trascina la cartella su <https://app.netlify.com/drop>, ottieni un URL HTTPS in 30s.
- **GitHub Pages** — push su una repo, abilita Pages dal branch `main`.
- **Cloudflare Pages** / qualsiasi static host.

HTTPS è **richiesto** per service worker e geolocalizzazione su dominio pubblico.

## Credits

- [BRouter](https://brouter.de) — routing engine open source di Arndt Brenschede
- [OpenStreetMap](https://www.openstreetmap.org/copyright) — dati cartografici sotto licenza ODbL
- [Nominatim](https://nominatim.org) — geocoding sui dati OSM
- [Overpass API](https://overpass-api.de) — query OSM per le fontanelle di acqua potabile
- [Leaflet](https://leafletjs.com) — libreria mappe (BSD-2)
- [Chart.js](https://www.chartjs.org) — grafico altimetrico (MIT)

# Ciclovia

PWA per calcolare **percorsi ciclistici** che evitano il traffico automobilistico, preferendo piste ciclabili, sterrati e strade secondarie. Routing via [BRouter](https://brouter.de), mappa via [OpenStreetMap](https://www.openstreetmap.org), geocoding via [Nominatim](https://nominatim.openstreetmap.org).

Zero backend, zero npm, zero build step.

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
- Scegliere il profilo bici
- Vedere statistiche (km, dislivello, % sterrato vs asfalto vs ciclabile) e grafico altimetrico
- Scaricare il percorso come **GPX**
- Condividere il percorso via **link** (waypoint serializzati in URL)
- Installare la PWA su desktop o mobile

## Profili supportati

| Profilo    | Quando usarlo                                        |
|------------|------------------------------------------------------|
| trekking   | Default ragionevole, mix asfalto + sterrato leggero  |
| gravel     | Predilige sterrati e strade bianche                  |
| fastbike   | Road bike, asfalto, pendenze contenute               |
| MTB        | Sentieri tecnici, sterrato impegnativo               |

## Limitazioni note

- **BRouter pubblico**: API gratuita senza SLA, può essere lenta o non disponibile. Se diventa un problema → self-host.
- **Nominatim**: max **1 richiesta al secondo**, User-Agent obbligatorio. Il client applica debounce.
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
- [Leaflet](https://leafletjs.com) — libreria mappe (BSD-2)
- [Chart.js](https://www.chartjs.org) — grafico altimetrico (MIT)

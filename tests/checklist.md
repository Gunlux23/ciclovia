# Ciclovia — Checklist smoke manuale

Da spuntare prima di ogni push significativo. Eseguire idealmente su mobile + desktop, in italiano.

## Avvio e base

- [ ] L'app si apre senza errori in console (DevTools → Console pulita)
- [ ] La mappa Leaflet è visibile, tile OSM caricate, attribuzione presente in basso a destra
- [ ] Il selettore profilo mostra: trekking, gravel, road (fastbike), MTB

## Input waypoint

- [ ] **GPS**: tap su icona "📍" → permesso del browser → marker "tappa 1" creato sulla mia posizione (entro 100m)
- [ ] **Ricerca indirizzo**: cerco "Cuneo" → vedo risultati Nominatim → tap su uno → waypoint aggiunto, mappa centra
- [ ] **Tap su mappa**: long-press 500ms su un punto → toast "Aggiunto come tappa N", marker creato
- [ ] **Drag marker**: trascino un marker esistente → al rilascio il percorso si ricalcola automaticamente
- [ ] Il pannello "Tappe" mostra la lista ordinata; posso riordinare con drag-and-drop

## Calcolo percorso

- [ ] Con 2 waypoint validi in Piemonte, profilo trekking, percorso calcolato in < 5s
- [ ] Polilinea evidenziata su mappa (colore distinto da OSM)
- [ ] Cambio profilo a "gravel" → percorso ricalcolato, statistiche aggiornate
- [ ] Cambio profilo a "road" (fastbike) → percorso ricalcolato
- [ ] Cambio profilo a "MTB" → percorso ricalcolato

## Statistiche e altimetria

- [ ] Pannello statistiche mostra: km totali, dislivello +/-, tempo stimato, % sterrato, % ciclabile, % asfalto
- [ ] I numeri sono plausibili (km coerenti con la distanza visiva sulla mappa)
- [ ] Grafico altimetrico Chart.js renderizzato, asse X in km, asse Y in m
- [ ] Hover/tap sul grafico evidenzia un punto sulla mappa (se implementato)

## Export e condivisione

- [ ] Pulsante "Scarica GPX" → download di file `ciclovia-YYYYMMDD.gpx` non vuoto
- [ ] Apro il GPX in editor di testo: presenza `<trkpt`, `<ele>`, coordinate plausibili
- [ ] Pulsante "Condividi" → ottengo un URL `?p=...`
- [ ] Apro l'URL condiviso in finestra nuova/incognito → stesso percorso ricostruito (waypoint + profilo)

## Errori

- [ ] Imposto un waypoint sull'oceano (es. centro Atlantico via long-press) → BRouter ritorna errore → toast/inline messaggio in italiano, app non si blocca
- [ ] Cerco una stringa senza risultati ("xyzqwertyabc") → messaggio "Nessun luogo trovato"
- [ ] Nego il permesso GPS → toast con istruzioni, ricerca/tap ancora funzionanti

## PWA e offline

- [ ] In Chrome/Edge desktop: icona "Installa" visibile nella barra → installazione funziona, app si apre standalone
- [ ] Su Android (Chrome): banner "Aggiungi a schermata Home" o opzione nel menu
- [ ] Carico un percorso → spengo la rete (DevTools → Network → Offline) → ricarico la pagina → app shell + ultimo percorso ancora visibili
- [ ] Service worker registrato (DevTools → Application → Service Workers)
- [ ] Manifest valido (DevTools → Application → Manifest, nessun warning)

## Mobile UX

- [ ] Layout responsive: bottom sheet "Tappe" raggiungibile col pollice, drag-up fluido
- [ ] Pulsanti touch-friendly (≥44×44 px)
- [ ] Nessun overflow orizzontale, niente zoom involontario su input

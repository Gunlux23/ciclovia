# Distanza target — Design

**Data:** 2026-05-21
**Stato:** approvato, pronto per piano di implementazione

## Obiettivo

Permettere all'utente di specificare una distanza chilometrica desiderata e
ottenere un percorso che la rispetti, in due modalità:

- **Anello**: solo partenza + distanza → giro che torna alla partenza.
- **Estensione A→B**: partenza + arrivo (con eventuali tappe) + distanza →
  percorso che passa per tutti i waypoint e raggiunge la distanza target.

## Decisioni di design

| Aspetto | Scelta |
| --- | --- |
| Tolleranza | ±10% (es. richiesto 100 km → accetto 90–110 km) |
| Waypoint che impongono distanza > target | Avviso "le tappe richiedono almeno X km" + calcolo percorso minimo |
| Modalità anello | Generazione automatica + bottone "Altro giro" per rigenerare con seme diverso |
| UI | Toggle opzionale + slider 5–200 km + input numerico per valori superiori |
| Limite massimo | Nessun limite hard. Badge giallo "calcolo lento (10-30s)" se distanza > 300 km |
| Backend routing | BRouter (già in uso), nessuna dipendenza esterna nuova |

## Architettura

### 1. UI (`index.html`, `css/style.css`, `js/ui.js`)

Nel pannello waypoint, sotto la lista delle tappe e sopra il selettore profilo:

```
┌─ Distanza target ──────────────────┐
│ [○──] Imposta distanza              │
│ ├─ Slider 5—200 km                  │  (visibile solo quando toggle ON)
│ ├─ Input numerico (qualsiasi km)    │
│ └─ Badge "calcolo lento" se > 300   │
└──────────────────────────────────────┘
```

Sotto i risultati, **solo in modalità anello**, appare il bottone
"🔄 Altro giro" che rigenera con un seme angolare diverso.

### 2. Stato (`js/state.js`)

Nuovi campi nello state:

```js
{
  targetDistanceEnabled: false,   // toggle on/off
  targetDistanceKm: 30,            // valore corrente in km
  loopSeed: 0,                     // angolo θ in radianti per anelli
}
```

### 3. Motore di pianificazione (`js/services/routePlanner.js` — nuovo)

Modulo che incapsula la logica iterativa. Espone:

```js
async function planRoute({
  waypoints,       // [{lat, lon}, ...]
  profile,         // 'safety', 'gravel', ...
  targetKm,        // null = comportamento attuale; numero = target
  loopSeed,        // angolo iniziale per anelli
  onProgress,      // callback (iteration, currentKm, targetKm)
  signal,          // AbortSignal per cancellazione
})
```

Restituisce `{ geojson, messages, iterations, finalKm, mode, warning }`.

#### Algoritmo modalità anello (1 solo waypoint = partenza)

1. **Stima raggio iniziale**: `R = target / 4` (approssimazione triangolare).
2. **Genera 2 waypoint** a distanza R dalla partenza, con angoli
   `θ = loopSeed` e `θ + 120°` (in radianti).
3. **Chiama BRouter** su `P → A → B → P` col profilo selezionato.
4. **Valuta distanza D**:
   - Se `0.9·target ≤ D ≤ 1.1·target` → ritorna il risultato.
   - Altrimenti: `R ← R · (target / D)`, ricomincia da step 2.
5. **Massimo 5 iterazioni**: oltre, restituisce il miglior tentativo
   (quello più vicino al target).
6. Su `onProgress` ad ogni iterazione, e check di `signal.aborted`.

#### Algoritmo modalità estensione (≥2 waypoint)

1. **Calcola percorso base** (BRouter con i waypoint dati).
2. Se `D_base > 1.1·target`:
   - Ritorna il percorso base + `warning: "Le tappe scelte richiedono almeno X km, non posso fare Y km."`.
3. Se `0.9·target ≤ D_base ≤ 1.1·target`:
   - Ritorna il percorso base, già conforme.
4. Se `D_base < 0.9·target`:
   - **Trova il segmento più lungo** tra waypoint consecutivi.
   - **Calcola il midpoint** geografico del segmento.
   - **Inserisci waypoint di deviazione** a distanza `δ = (target − D_base) / 4`
     perpendicolarmente al segmento. Alla prima iterazione si prende la
     perpendicolare "a sinistra" del verso di marcia; se la distanza
     ottenuta è ancora troppo corta, alla seconda iterazione si prova
     "a destra"; nelle iterazioni successive si aumenta `δ` mantenendo
     il lato che ha dato il risultato migliore.
   - Ricalcola con BRouter inserendo il waypoint di deviazione tra gli altri.
   - Itera fino a 5 volte; oltre, restituisce miglior tentativo.

### 4. Integrazione (`js/app.js`)

- Sostituire la chiamata diretta a `brouter.requestRoute` con
  `routePlanner.planRoute`.
- Quando `targetDistanceEnabled` è false e `targetKm = null` →
  `routePlanner` chiama direttamente BRouter senza iterazioni (zero overhead).
- Wire-up del toggle e dello slider sullo stato.
- Wire-up del bottone "Altro giro": incrementa `loopSeed` di un angolo random
  e richiama `planRoute`.

### 5. Feedback durante il calcolo

- Spinner con testo dinamico aggiornato dal callback `onProgress`:
  "Tentativo 2/5 — distanza attuale 87 km, target 100 km".
- Bottone "Annulla" durante il calcolo (usa `AbortController`).

### 6. Avvisi e warning

- Distanza > 300 km al cambio dello slider → badge UI "calcolo lento".
- Modalità estensione con `D_base > 1.1·target` → toast UI con il messaggio
  `warning` ritornato dal planner.
- Tutte e 5 le iterazioni fallite (nessuna nel range ±10%) → toast
  "Distanza approssimativa: X km (target Y km)".

## File modificati / nuovi

| File | Azione |
| --- | --- |
| `index.html` | Aggiunge pannello "Distanza target" con toggle + slider + input |
| `css/style.css` | Stili per pannello, badge avviso, bottone "Altro giro" |
| `js/state.js` | Nuovi campi: `targetDistanceEnabled`, `targetDistanceKm`, `loopSeed` |
| `js/ui.js` | Render pannello, gestione spinner iterativo, bottone "Altro giro", warning |
| `js/services/routePlanner.js` (nuovo) | Algoritmo iterativo per anelli ed estensioni |
| `js/services/brouter.js` | Nessuna modifica (già supporta waypoint multipli) |
| `js/app.js` | Sostituisce chiamata diretta a brouter con routePlanner; wire-up toggle/seed |

## Out of scope

- Ottimizzazione "elevazione totale target" (es. "voglio fare 1000m di dislivello").
- Suggerimento automatico di punti panoramici lungo il giro.
- Salvataggio/condivisione del seme per riprodurre un giro specifico
  (utile in futuro per condividere "il mio giro da 50km nei pressi di Cuneo",
  ma non in questa iterazione).
- Loop multi-giorno (es. "100 km al giorno per 3 giorni").

## Casi limite gestiti

| Scenario | Comportamento |
| --- | --- |
| Toggle off | Comportamento attuale, zero overhead |
| Solo partenza + toggle on | Modalità anello |
| Partenza+arrivo + toggle on | Modalità estensione |
| Distanza target = 0 o negativa | UI non lo consente (slider min = 5 km) |
| Waypoint che impongono distanza > target | Warning + percorso minimo |
| 5 iterazioni senza convergere | Restituisce miglior tentativo + toast informativo |
| Utente cancella durante calcolo | Iterazione corrente abortita, stato precedente preservato |
| Distanza > 300 km | Badge UI "calcolo lento" prima del calcolo |

## Test plan (alto livello)

- Anello 30 km da Cuneo con profilo "Evita traffico" → percorso 27-33 km che parte e torna a Cuneo.
- Estensione Cuneo→Saluzzo (~35 km diretto) con target 60 km → percorso ~54-66 km con deviazione.
- Estensione Cuneo→Saluzzo target 20 km (impossibile) → warning + percorso diretto.
- "Altro giro" su un anello → nuovo percorso diverso geograficamente, stessa distanza (entro tolleranza).
- Annulla durante calcolo → spinner sparisce, percorso precedente intatto.
- Distanza 500 km → badge giallo prima del calcolo, calcolo completa o restituisce miglior tentativo.

# Anello senza sovrapposizioni — Design

**Data:** 2026-05-21
**Stato:** approvato, in implementazione

## Obiettivo

Migliorare la modalità "anello" del route planner in modo che, ove possibile,
non passi due volte sulla stessa strada (andata e ritorno coincidenti). Quando
la rete stradale della zona impedisce un loop pulito, accettare comunque il
giro con il minor overlap possibile e avvisare l'utente.

## Decisioni di design

| Aspetto | Scelta |
| --- | --- |
| Forma base del loop | **Quadrilatero** (3 waypoint a θ, θ+90°, θ+180°), non più triangolo |
| Stima raggio iniziale | `R = target / 5` (perimetro reale ≈ 5R su strade reali) |
| Soglia overlap accettabile | **10%** dei segmenti percorsi |
| Caso "non risolvibile" | Accetta il miglior tentativo + toast warning con percentuale |
| Numero max iterazioni overlap | **3** (rotazione di 60° per tentativo) |
| Compatibilità | Bottone "Altro giro" continua a funzionare come prima |

## Architettura

### 1. Generazione waypoint quadrilateri

Prima (triangolo):
```js
const a = destinationPoint(origin, R, θ);
const b = destinationPoint(origin, R, θ + 2π/3);   // 120°
// loop: P → A → B → P  (3 lati)
```

Dopo (quadrilatero):
```js
const a = destinationPoint(origin, R, θ);            // 0°
const b = destinationPoint(origin, R, θ + π/2);      // 90°
const c = destinationPoint(origin, R, θ + π);        // 180°
// loop: P → A → B → C → P  (4 lati)
```

Quattro waypoint distribuiti su 180° (semicerchio) costringono BRouter a usare
strade diverse per andata e ritorno. Su 360° pieni (es. θ, θ+90, θ+180, θ+270)
i waypoint A e C sarebbero in direzioni opposte, ma il return path da C a P
finirebbe spesso sulla stessa strada di P→A. Tenendoli sul semicerchio si crea
un giro "a ferro di cavallo" che è naturalmente meno propenso a sovrapporsi.

### 2. Rilevamento overlap (`measureOverlapPct`)

Algoritmo: discretizzazione del percorso in celle geografiche.

```js
function measureOverlapPct(geojson) {
  const CELL_M = 15;  // dimensione cella in metri
  const cells = new Map();  // "lat_cell,lon_cell" → count
  const coords = geojson.coordinates;
  for (let i = 0; i < coords.length; i++) {
    const [lon, lat] = coords[i];
    const key = `${Math.round(lat * 7400)},${Math.round(lon * 7400)}`;
    // 1/0.000135 ≈ 7400 → ~15m per cella
    cells.set(key, (cells.get(key) || 0) + 1);
  }
  let overlapping = 0;
  for (const c of cells.values()) if (c > 1) overlapping++;
  return overlapping / cells.size; // 0..1
}
```

Note:
- La discretizzazione a 15m è un compromesso: troppo fine → falsi negativi su
  curve, troppo larga → falsi positivi su strade parallele
- Una cella visitata 2+ volte è considerata "overlap"
- Il bottone "Altro giro" continua a usare lo stesso meccanismo (cambio seed)

### 3. Ciclo iterativo

```
1. R = target / 5
2. θ_inner = θ  (dato da loopSeed)
3. for tentativo in [0, 1, 2]:
     waypoints = quadrilatero(origin, R, θ_inner)
     response = BRouter(waypoints)
     km = lunghezza(response)
     overlap = measureOverlapPct(response.geojson)
     se overlap ≤ 10%:
       return response  ✅
     altrimenti:
       memorizza miglior tentativo (overlap minimo)
       θ_inner += π/3  (60°)
4. return miglior_tentativo + warning("overlap X%")
```

Il ciclo della distanza target (rapporto km/target) è esterno e continua a
funzionare come prima. Quando un'iterazione di distanza converge entro
±10%, si fa il check di overlap. Se l'overlap è troppo alto si tenta una
rotazione, ma se la distanza esce di tolleranza si torna al ciclo distanza.

### 4. Warning all'utente

Se nessuna rotazione raggiunge overlap ≤10%, mostra un toast informativo:
> "Questo anello attraversa la stessa zona per X% del tracciato. In questa
>  area non c'è una rete stradale alternativa sufficiente."

Tipo toast: `info` (non `error`). Il percorso viene comunque mostrato.

### 5. Bottone "Altro giro"

Nessuna modifica al wire-up: continua a incrementare `loopSeed` di un random
in [0.5, 1.5] rad. Internamente il ciclo di rotazione overlap usa **+60°
incremento** che è quasi sempre indipendente dal seed iniziale.

## File modificati

| File | Azione |
| --- | --- |
| `js/services/routePlanner.js` | Modifica `planLoop()`: quadrilatero + measureOverlapPct + ciclo rotazione |
| `sw.js` | Bump cache shell → v3 (per forzare refresh nei client già installati) |

## Out of scope

- Loop completamente senza alcuna sovrapposizione "by design" usando `nogos`
  di BRouter (complesso, URL molto lunghe, costoso in chiamate)
- Anelli "a forma di otto" o multi-loop (es. >100 km)
- Statistica overlap visibile nelle stats del result-sheet (mostrata solo
  come warning condizionale)

## Casi limite gestiti

| Scenario | Comportamento |
| --- | --- |
| Loop trovato al 1° tentativo con overlap ≤10% | Ritorna direttamente |
| Loop trovato dopo 1-2 rotazioni | Ritorna senza warning |
| Nessun loop con overlap ≤10% in 3 rotazioni | Ritorna miglior tentativo + toast info |
| Zona con UNA SOLA strada (impossibile) | Toast "overlap 100%" (raro ma corretto) |
| Distanza target non convergente E overlap alto | Priorità alla distanza; overlap loggato come warning |
| AbortSignal | Interrompe tra le iterazioni come oggi |

## Test plan

- Loop 30 km da Cuneo (centro) → percorso ad anello con strade diverse per
  andata/ritorno, nessun warning
- Loop 10 km da una zona rurale con poche strade → warning con percentuale,
  ma percorso comunque visualizzato
- Loop 50 km in pianura piemontese → quadrilatero ampio, percorso simile a un
  giro "a ferro di cavallo"
- "Altro giro" più volte → genera percorsi geograficamente diversi

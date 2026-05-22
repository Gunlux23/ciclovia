# Cronologia percorsi — Design

**Data:** 2026-05-22
**Stato:** approvato, pronto per planning

## Obiettivo

Permettere all'utente di accedere a una cronologia dei percorsi calcolati,
caricarli per modificarli e gestirne il numero (eliminazione manuale o
automatica al raggiungimento del limite).

## Requisiti funzionali

| ID | Requisito |
|---|---|
| RF1 | Ogni calcolo BRouter riuscito → nuovo entry in cronologia |
| RF2 | Limite massimo: 30 entry |
| RF3 | Al primo superamento del limite, modale chiede preferenza: auto-elimina più vecchi (FIFO) oppure gestione manuale |
| RF4 | Preferenza salvata, modificabile dall'interfaccia cronologia |
| RF5 | Tap su entry → carica i suoi parametri come sessione corrente + ricalcola |
| RF6 | Ricalcolo di un entry caricato → nuovo entry (non sovrascrive il vecchio) |
| RF7 | Etichetta auto-generata: `<data> · <km> · <profilo>` |
| RF8 | Rinomina entry tramite icona matita |
| RF9 | Elimina entry singolo con conferma |
| RF10 | Svuota tutta la cronologia con conferma |
| RF11 | Accesso via voce "Cronologia" nel menu hamburger |

## Architettura

### Storage

Chiave localStorage **separata** dallo state corrente:

- Chiave: `ciclovia.routes.v1`
- Valore:
  ```json
  {
    "version": 1,
    "preference": "fifo" | "manual" | null,
    "entries": [ /* max 30, ordinati dal più recente */ ]
  }
  ```

Separata da `ciclovia.v1` (lo state) perchè la cronologia ha lifecycle
diverso (collezione persistente vs stato corrente) e per evitare di leggere/
scrivere l'intera cronologia ad ogni `update()` dello state.

### Schema entry

```json
{
  "id": "r_1747900000_a3b1",
  "createdAt": "2026-05-22T10:35:12Z",
  "waypoints": [{"lat": 44.39, "lon": 7.55, "label": "Cuneo", "source": "tap"}],
  "profile": "safety",
  "targetDistanceEnabled": true,
  "targetDistanceKm": 30,
  "loopSeed": 0.42,
  "stats": {"distanceKm": 30.2, "ascentM": 412, "durationMin": 110},
  "customName": null
}
```

Dimensione media stimata: ~1KB/entry. 30 entry ≈ 30KB, ampiamente entro
i limiti di localStorage (~5MB).

**GeoJSON / GPX non salvati**: troppo pesanti (centinaia di KB ciascuno).
Al ricaricamento entry si rifà fetch a BRouter; se il SW ha la risposta
in cache (cache `ciclovia-routes-v1`, 10 LRU) è istantaneo, altrimenti
~2s rete.

### Nuovo modulo `js/services/routeHistory.js`

API pubblica:

```js
list()                   // → array degli entry (deep copy)
get(id)                  // → entry o null
add(entry)               // → { added: bool, fullEvent?: {...} }
remove(id)               // → bool
rename(id, name)         // → bool (name vuoto/null = rimuove customName)
clear()                  // → void
getPreference()          // → 'fifo' | 'manual' | null
setPreference(pref)      // → void
subscribe(fn)            // → unsubscribe()
```

Logica `add()`:

1. Genera id univoco se mancante
2. Inserisce in testa a `entries`
3. Se length > 30:
   - `preference === 'fifo'` → rimuove l'ultimo (più vecchio), salva, ritorna `{added: true}`
   - `preference === 'manual'` o `null` → ROLLBACK (non aggiunge), ritorna `{added: false, fullEvent: {...}}` con info per la UI

La UI gestisce il caso `fullEvent`:
- Se `preference === null` → mostra modale scelta preferenza, poi ritenta
- Se `preference === 'manual'` → mostra modale checklist eliminazione

### Modifiche a moduli esistenti

**`js/state.js`** — aggiunge:
```js
export function loadFromHistoryEntry(entry) {
  update({
    waypoints: entry.waypoints,
    profile: entry.profile,
    targetDistanceEnabled: entry.targetDistanceEnabled,
    targetDistanceKm: entry.targetDistanceKm,
    loopSeed: entry.loopSeed,
    route: null,        // forza ricalcolo
    status: 'idle',
    error: null,
  });
}
```

**`js/app.js`** — quando arriva un route success:
```js
import * as routeHistory from './services/routeHistory.js';

// dopo calcolo riuscito:
routeHistory.add({
  waypoints: state.waypoints,
  profile: state.profile,
  targetDistanceEnabled: state.targetDistanceEnabled,
  targetDistanceKm: state.targetDistanceKm,
  loopSeed: state.loopSeed,
  stats: {
    distanceKm: route.distanceKm,
    ascentM: route.ascentM,
    durationMin: route.durationMin,
  },
});
```

**`js/ui.js`** — nuove funzioni:
- `renderHistorySheet()` — popola la lista dal modulo routeHistory
- `openHistorySheet()`, `closeHistorySheet()`
- `showHistoryFullModal(mode)` — modale per gestione overflow
- Handler menu "Cronologia"
- Subscribe a `routeHistory` per re-render lista quando cambia

**`index.html`** — nuovo markup:
- Voce `<button id="menu-history">Cronologia</button>` nel menu hamburger
- Nuovo elemento `<aside id="sheet-history" class="sheet sheet--history">` con stessa struttura di sheet-stops
- Markup template per modale "cronologia piena"

**`css/style.css`** — stili:
- `.history-card` (riga label, sub-info, azioni)
- `.history-card__actions` (icone matita/cestino)
- `.history-modal--full` (modale checklist)

**`sw.js`** — bump cache shell → v5, aggiungi `routeHistory.js` a SHELL_ASSETS.

## UI dettagliata

### Sheet cronologia

```
┌─────────────────────────────────────────┐
│ Cronologia (N/30)                  [×]  │
├─────────────────────────────────────────┤
│ Quando piena: ○ Auto-elimina  ○ Chiedo  │
├─────────────────────────────────────────┤
│ ┌─────────────────────────────────────┐ │
│ │ 22 mag 2026 · 30.2 km · Evita traf. │ │
│ │ 3 tappe · 412 m dislivello          │ │
│ │                          [✎] [🗑]  │ │
│ └─────────────────────────────────────┘ │
│ ┌─────────────────────────────────────┐ │
│ │ Giro del lago (rinominato)          │ │
│ │ 21 mag · 15.4 km · Trekking         │ │
│ │ 2 tappe · 180 m dislivello          │ │
│ │                          [✎] [🗑]  │ │
│ └─────────────────────────────────────┘ │
│                                         │
│        [ Svuota cronologia ]            │
└─────────────────────────────────────────┘
```

Tap sul corpo card → caricamento. Tap matita → prompt rinomina. Tap
cestino → confirm "Eliminare questo percorso?".

### Modale "cronologia piena, prima volta"

```
┌────────────────────────────────────────┐
│ Cronologia piena                       │
├────────────────────────────────────────┤
│ Hai raggiunto i 30 percorsi salvati.   │
│ Come vuoi gestire i prossimi?          │
│                                        │
│ [ Auto-elimina i più vecchi ]          │
│ [ Decido io ogni volta ]               │
└────────────────────────────────────────┘
```

### Modale "cronologia piena, mode=manual"

```
┌────────────────────────────────────────┐
│ Cronologia piena                  [×]  │
├────────────────────────────────────────┤
│ Per salvare il nuovo percorso, scegli  │
│ quali eliminare:                       │
│                                        │
│ ☐ 22 mag · 30.2 km · Evita traffico    │
│ ☐ 21 mag · 15.4 km · Trekking          │
│ ☐ ...                                  │
│                                        │
│ [Annulla]   [Elimina selezionati]      │
└────────────────────────────────────────┘
```

"Annulla" → il nuovo calcolo resta visualizzato come sessione corrente
ma NON viene salvato in cronologia.

## Flow di caricamento

```
1. User tap card cronologia
2. loadFromHistoryEntry(entry):
     state.update({ waypoints, profile, targetDistanceEnabled,
                    targetDistanceKm, loopSeed, route: null, ... })
3. close sheet-history
4. app.js subscriber (esistente) rileva cambio waypoints/profile/target
     → chiama scheduleRecalc() → planRoute() → BRouter
5. Calcolo riuscito → app.js chiama routeHistory.add(nuovo entry)
6. Sheet-history rimane chiuso, l'utente vede il percorso sulla mappa
```

Il caricamento sfrutta il meccanismo di auto-recalc già esistente in
`app.js:226` (subscribe a state che triggera `scheduleRecalc()` quando
waypoints/profile/target cambiano). Non serve introdurre un trigger
dedicato per la cronologia.

Caso particolare: se l'utente ricarica un entry che ha esattamente gli
stessi parametri del percorso attualmente visualizzato, la guardia
`lastRouteKey` in app.js evita un ricalcolo inutile e non viene creato
nuovo entry. È il comportamento desiderato.

Se l'utente apre la cronologia, il nuovo entry compare in cima.

## Edge cases

| Scenario | Comportamento |
|---|---|
| localStorage non disponibile | Cronologia disabilitata silenziosamente, voce menu nascosta, app funziona |
| Quota localStorage exceeded in add() | Toast errore "Spazio esaurito, svuota cronologia", entry non aggiunto |
| JSON corrotto allo startup | Reset a `{entries:[], preference:null}`, log warning console |
| Calcolo BRouter fallisce | Nessun add (gestito in app.js dopo verifica success) |
| Stessa sessione, ricalcoli identici | Duplicati salvati (comportamento richiesto) |
| Entry con profilo non più supportato | Fallback a `safety` al load, toast warning |
| Entry con waypoint fuori dal range BRouter | Errore di routing standard, nuovo entry NON creato |
| Modifica entry e ricalcolo | Nuovo entry creato; vecchio rimane |
| User cancella entry attualmente caricato | Lo state corrente NON viene toccato (l'app continua a mostrare il percorso); solo l'entry sparisce dalla cronologia |

## Out of scope

- Sync cloud / multi-device (è una PWA locale)
- Export cronologia (singola entry o tutta) — può essere RF futura
- Tag/categorie / preferiti / colori
- Ricerca/filtri nella cronologia (con 30 entry max è gestibile a vista)
- Salvataggio del GeoJSON per consultazione offline (problema di quota)
- Anteprime mini-mappa nelle card (costoso, complicato)

## Test plan (manuale)

1. Calcola un percorso → entry compare in cronologia con label corretta
2. Calcola 30 percorsi → al 31° appare modale scelta preferenza
3. Scelgo "Auto-elimina" → 31° viene salvato, 1° viene rimosso, totale resta 30
4. Verifico che preferenza è persistente: ricarico pagina → calcolo nuovo → auto-rimozione senza modale
5. Cambio preferenza a "Decido io" dalla UI → calcolo nuovo → modale checklist appare
6. Tap su entry vecchio → si carica + ricalcola; verifica che vecchio entry è ancora in lista
7. Modifico waypoint e ricalcolo → nuovo entry in cima, vecchio invariato
8. Rinomina entry → label custom appare; ricarico pagina → label custom persiste
9. Elimina entry singolo → conferma → sparisce
10. Svuota cronologia → conferma → lista vuota con messaggio
11. localStorage disabilitato (browser privato) → voce menu "Cronologia" nascosta
12. Apri DevTools → corrompi manualmente JSON → ricarica → reset automatico, app non crasha

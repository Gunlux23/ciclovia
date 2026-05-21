#!/usr/bin/env bash
# Ciclovia — smoke test reale contro BRouter
# Interroga BRouter con due waypoint fissi in Piemonte (Cuneo → Mondovì)
# Profilo: trekking. Verifica che la risposta sia GeoJSON valido.
#
# Exit code:
#   0 = OK
#   1 = errore (rete, formato, contenuto)

set -u

FROM="7.5495,44.3909"  # Cuneo
TO="7.8197,44.3886"    # Mondovì
PROFILE="trekking"
URL="https://brouter.de/brouter?lonlats=${FROM}|${TO}&profile=${PROFILE}&alternativeidx=0&format=geojson"

echo "[smoke] BRouter: ${PROFILE}  ${FROM} → ${TO}"
echo "[smoke] URL: ${URL}"

TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT

HTTP_CODE=$(curl -sS -o "$TMP" -w "%{http_code}" --max-time 30 "$URL" || echo "000")

if [ "$HTTP_CODE" != "200" ]; then
  echo "[smoke] FAIL: HTTP ${HTTP_CODE}"
  echo "[smoke] body (primi 400 char):"
  head -c 400 "$TMP"
  echo
  exit 1
fi

# Controlla che la risposta inizi con '{' (GeoJSON object)
FIRST_CHAR=$(head -c 1 "$TMP")
if [ "$FIRST_CHAR" != "{" ]; then
  echo "[smoke] FAIL: risposta non inizia con '{' (carattere: '${FIRST_CHAR}')"
  echo "[smoke] body (primi 400 char):"
  head -c 400 "$TMP"
  echo
  exit 1
fi

# Verifica presenza marker GeoJSON
if grep -q '"type":"FeatureCollection"' "$TMP" || grep -q '"FeatureCollection"' "$TMP"; then
  echo "[smoke] OK: GeoJSON FeatureCollection rilevato"
elif grep -q '"LineString"' "$TMP"; then
  echo "[smoke] OK: LineString rilevato"
else
  echo "[smoke] FAIL: nessun marker GeoJSON noto trovato nella risposta"
  echo "[smoke] body (primi 400 char):"
  head -c 400 "$TMP"
  echo
  exit 1
fi

# Estrai km totali se jq è installato
if command -v jq >/dev/null 2>&1; then
  # BRouter mette i totali in features[0].properties.track-length (metri, stringa)
  KM=$(jq -r '
    (.features[0].properties["track-length"] // .features[0].properties.tracklength // empty) as $m
    | if $m == "" or $m == null then "n/a"
      else (($m | tonumber) / 1000 | . * 100 | round / 100 | tostring + " km")
      end
  ' "$TMP" 2>/dev/null || echo "n/a")
  echo "[smoke] Distanza percorso: ${KM}"
  # Anche dislivello se disponibile
  ASCEND=$(jq -r '.features[0].properties["filtered ascend"] // .features[0].properties.totalAscend // "n/a"' "$TMP" 2>/dev/null)
  echo "[smoke] Dislivello (ascend): ${ASCEND} m"
else
  echo "[smoke] (jq non installato, skip parsing distanza)"
fi

SIZE=$(wc -c < "$TMP")
echo "[smoke] Dimensione risposta: ${SIZE} byte"
echo "[smoke] PASSED"
exit 0

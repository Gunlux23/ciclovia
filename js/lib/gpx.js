function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function formatNumber(n, decimals) {
  if (!Number.isFinite(n)) return '0';
  return Number(n).toFixed(decimals);
}

export function fromGeoJSON(geojson, { name = 'Ciclovia route', creator = 'Ciclovia' } = {}) {
  const coords = geojson?.coordinates || [];
  const now = new Date().toISOString();

  const points = coords
    .map((c) => {
      const lon = formatNumber(c[0], 7);
      const lat = formatNumber(c[1], 7);
      const ele = c.length > 2 ? formatNumber(c[2], 1) : null;
      return ele !== null
        ? `      <trkpt lat="${lat}" lon="${lon}"><ele>${ele}</ele></trkpt>`
        : `      <trkpt lat="${lat}" lon="${lon}"></trkpt>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="${escapeXml(creator)}"
     xmlns="http://www.topografix.com/GPX/1/1"
     xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
     xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">
  <metadata>
    <name>${escapeXml(name)}</name>
    <time>${now}</time>
  </metadata>
  <trk>
    <name>${escapeXml(name)}</name>
    <trkseg>
${points}
    </trkseg>
  </trk>
</gpx>
`;
}

export function download(gpxString, filename) {
  const blob = new Blob([gpxString], { type: 'application/gpx+xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || 'ciclovia.gpx';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke after the click is handled by the browser.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

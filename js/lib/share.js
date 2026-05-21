function toBase64Url(str) {
  // btoa works on Latin-1; encode UTF-8 first.
  const utf8 = unescape(encodeURIComponent(str));
  return btoa(utf8).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(str) {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4);
  return decodeURIComponent(escape(atob(padded)));
}

function round(n, decimals) {
  const m = 10 ** decimals;
  return Math.round(Number(n) * m) / m;
}

export function serialize(state) {
  const waypoints = (state?.waypoints || []).map((w) => {
    const out = { lat: round(w.lat, 6), lon: round(w.lon, 6) };
    if (w.label) out.label = w.label;
    return out;
  });
  const payload = { w: waypoints, p: state?.profile || 'trekking' };
  return toBase64Url(JSON.stringify(payload));
}

export function deserialize(encoded) {
  if (!encoded || typeof encoded !== 'string') return null;
  try {
    const json = fromBase64Url(encoded);
    const data = JSON.parse(json);
    if (!data || !Array.isArray(data.w)) return null;
    return {
      waypoints: data.w.map((w, i) => ({
        id: `w${i}`,
        lat: Number(w.lat),
        lon: Number(w.lon),
        label: w.label || '',
        source: 'share',
      })),
      profile: typeof data.p === 'string' ? data.p : 'trekking',
    };
  } catch {
    return null;
  }
}

export function toUrl(state) {
  const encoded = serialize(state);
  const base = `${window.location.origin}${window.location.pathname}`;
  return `${base}?p=${encoded}`;
}

export async function shareOrCopy(url, title = 'Ciclovia percorso') {
  if (navigator.share) {
    try {
      await navigator.share({ url, title });
      return { method: 'share' };
    } catch (err) {
      // User cancelled or share failed: fall through to clipboard if available.
      if (err && err.name === 'AbortError') return { method: 'share', cancelled: true };
    }
  }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    await navigator.clipboard.writeText(url);
    return { method: 'clipboard' };
  }
  throw new Error('Condivisione non supportata in questo browser.');
}

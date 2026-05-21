const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const MIN_INTERVAL_MS = 1000;

let lastCallAt = 0;
let pendingChain = Promise.resolve();

export class NominatimRateLimitError extends Error {
  constructor() {
    super('Troppe ricerche, attendi qualche secondo.');
    this.name = 'NominatimRateLimitError';
  }
}

export class NominatimError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NominatimError';
  }
}

function throttle() {
  // Serialize calls and ensure ≥1s between requests (Nominatim ToS).
  const run = pendingChain.then(async () => {
    const now = Date.now();
    const wait = Math.max(0, lastCallAt + MIN_INTERVAL_MS - now);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCallAt = Date.now();
  });
  pendingChain = run.catch(() => {});
  return run;
}

export async function search(query, { limit = 5 } = {}) {
  const trimmed = String(query || '').trim();
  if (!trimmed) return [];

  await throttle();

  const params = new URLSearchParams({
    q: trimmed,
    format: 'json',
    limit: String(limit),
    addressdetails: '0',
    'accept-language': 'it',
  });

  const response = await fetch(`${NOMINATIM_URL}?${params.toString()}`, {
    method: 'GET',
    headers: {
      'User-Agent': 'Ciclovia/1.0',
      'Accept': 'application/json',
    },
  });

  if (response.status === 429) throw new NominatimRateLimitError();
  if (!response.ok) throw new NominatimError(`Nominatim ha risposto con stato ${response.status}.`);

  const data = await response.json();
  if (!Array.isArray(data)) return [];

  return data.map((item) => ({
    lat: Number(item.lat),
    lon: Number(item.lon),
    displayName: item.display_name,
    type: item.type || item.class || 'place',
  }));
}

export class GeolocationDeniedError extends Error {
  constructor() {
    super('Permesso di geolocalizzazione negato.');
    this.name = 'GeolocationDeniedError';
  }
}
export class GeolocationUnavailableError extends Error {
  constructor() {
    super('Posizione non disponibile.');
    this.name = 'GeolocationUnavailableError';
  }
}
export class GeolocationTimeoutError extends Error {
  constructor() {
    super('Tempo scaduto nel recupero della posizione.');
    this.name = 'GeolocationTimeoutError';
  }
}
export class GeolocationUnsupportedError extends Error {
  constructor() {
    super('Geolocalizzazione non supportata da questo browser (richiede HTTPS).');
    this.name = 'GeolocationUnsupportedError';
  }
}

function mapError(err) {
  if (!err) return new GeolocationUnavailableError();
  switch (err.code) {
    case 1:
      return new GeolocationDeniedError();
    case 2:
      return new GeolocationUnavailableError();
    case 3:
      return new GeolocationTimeoutError();
    default:
      return new GeolocationUnavailableError();
  }
}

export function getCurrent({ timeout = 10000, highAccuracy = true } = {}) {
  return new Promise((resolve, reject) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      reject(new GeolocationUnsupportedError());
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        resolve({
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
        }),
      (err) => reject(mapError(err)),
      { enableHighAccuracy: highAccuracy, timeout, maximumAge: 0 },
    );
  });
}

export function watch(callback) {
  if (typeof navigator === 'undefined' || !navigator.geolocation) {
    throw new GeolocationUnsupportedError();
  }
  const id = navigator.geolocation.watchPosition(
    (pos) =>
      callback(null, {
        lat: pos.coords.latitude,
        lon: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
      }),
    (err) => callback(mapError(err), null),
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 },
  );
  return () => navigator.geolocation.clearWatch(id);
}

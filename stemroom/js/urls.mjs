// Keep application code local while API, artwork and audio use the room server.
const appRoot = new URL('../', import.meta.url);
const backendRoot = globalThis.StemroomConnection?.backendUrl;

export function roomBase(frontend = appRoot, backend = backendRoot) {
  return backend ? new URL(backend.replace(/\/+$/, '') + '/', frontend) : new URL(frontend);
}

export function appUrl(path, base = roomBase()) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) return path;
  return new URL(path.slice(1), base).href;
}

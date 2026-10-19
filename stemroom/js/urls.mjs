// Keep application code local while API, artwork and audio use the room server.
import {readConnection} from './connection.mjs';
const appRoot = new URL('../', import.meta.url);
let backendRoot = globalThis.StemroomConnection?.backendUrl;
const runtimeConfig = globalThis.StemroomConnection?.runtimeConfig;
let lastCheck = 0;

export async function refreshConnection() {
  if (!runtimeConfig || Date.now() - lastCheck < 10000) return;
  lastCheck = Date.now();
  const backend = await readConnection(new URL(runtimeConfig, appRoot));
  if (backend) backendRoot = backend;
}

await refreshConnection();

export function roomBase(frontend = appRoot, backend = backendRoot) {
  return backend ? new URL(backend.replace(/\/+$/, '') + '/', frontend) : new URL(frontend);
}

export function appUrl(path, base = roomBase()) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) return path;
  return new URL(path.slice(1), base).href;
}

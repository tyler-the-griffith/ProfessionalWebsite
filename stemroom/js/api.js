// REST helpers plus the live room connection (WebSocket) shared by every view.
import { useEffect, useState } from './lib.js';
import { appUrl, refreshConnection } from './urls.mjs';

async function request(method, path, body, isForm) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    if (isForm) opts.body = body;
    else { opts.body = JSON.stringify(body); opts.headers['content-type'] = 'application/json'; }
  }
  const r = await fetch(appUrl(path), opts);
  let data = null;
  try { data = await r.json(); } catch { /* empty body */ }
  if (!r.ok) throw new Error(data?.detail || `${r.status} ${r.statusText}`);
  return data;
}

export const api = {
  get: (p) => request('GET', p),
  post: (p, b = {}) => request('POST', p, b),
  put: (p, b) => request('PUT', p, b),
  patch: (p, b) => request('PATCH', p, b),
  del: (p) => request('DELETE', p),
  upload: (p, form) => request('POST', p, form, true),
};

// ---------------------------------------------------------------- live room

export const bus = new EventTarget();
export const clientId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
let room = null;
let connected = false;
let socket = null;
const subs = new Set();
const notify = () => subs.forEach((f) => f());

async function connect() {
  await refreshConnection();
  const url = new URL(appUrl('/ws'));
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('clientId', clientId);
  socket = new WebSocket(url);
  socket.onopen = () => { connected = true; notify(); };
  socket.onclose = () => {
    connected = false;
    bus.dispatchEvent(new CustomEvent("player-disconnected"));
    notify();
    setTimeout(connect, 1500);
  };
  socket.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'state') {
      room = msg.state;
      notify();
    } else if (msg.type === 'position') {
      if (room) { room = { ...room, stage: msg }; notify(); }
    } else if (msg.type === 'toast') {
      toast(msg.text, msg.error);
    }
    bus.dispatchEvent(new CustomEvent(msg.type, { detail: msg }));
  };
}
connect();

export function send(msg) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
}

export function useRoom() {
  const [, force] = useState(0);
  useEffect(() => {
    const f = () => force((x) => x + 1);
    subs.add(f);
    f(); // the socket may have delivered state between first render and subscribing
    return () => subs.delete(f);
  }, []);
  return { room, connected };
}

export function useBus(type, fn, deps = []) {
  useEffect(() => {
    const h = (e) => fn(e.detail);
    bus.addEventListener(type, h);
    return () => bus.removeEventListener(type, h);
  }, deps);
}

/** Stage position extrapolated to "now" (the stage only reports once a second). */
export function livePosition(stage) {
  if (!stage) return 0;
  if (stage.status !== 'playing') return stage.position || 0;
  return (stage.position || 0) + (Date.now() / 1000 - stage.at) * (stage.rate || 1);
}

// ---------------------------------------------------------------- toasts

export function toast(text, error = false) {
  bus.dispatchEvent(new CustomEvent('local-toast', { detail: { text, error, id: Math.random() } }));
}

export function guestName() {
  try { return localStorage.getItem('stemroom.name') || ''; } catch { return ''; }
}
export function setGuestName(n) {
  try { localStorage.setItem('stemroom.name', n); } catch { /* private mode */ }
}

// Shared UI pieces: icons, top bar, avatars, small controls, toasts, QR codes.
import { html, useEffect, useState, useRef, useMemo, initials, SINGER_COLORS } from './lib.js';
import { bus, useRoom } from './api.js';
import qrcode from '../vendor/qrcode.mjs';
import { appUrl } from './urls.mjs';

const P = {
  palette: 'M12 3a9 9 0 1 0 0 18h1a2 2 0 0 0 1-3.7 1.5 1.5 0 0 1 1-2.8h2a4 4 0 0 0 4-4C21 6.5 17 3 12 3zM7.5 10h.01M10 6.5h.01M15 6.5h.01M18 10h.01',
  link: 'M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
  users: 'M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM17 11.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM3 20a6 6 0 0 1 12 0M15 20a4 4 0 0 1 6-3.4',
  upload: 'M12 16V4M7 9l5-5 5 5M4 20h16',
  download: 'M12 4v12M7 11l5 5 5-5M4 20h16',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  check: 'M5 12l5 5 9-10',
  x: 'M6 6l12 12M18 6L6 18',
  grip: 'M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01',
  more: 'M6 12h.01M12 12h.01M18 12h.01',
  music: 'M9 18V5l11-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM20 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z',
  tv: 'M3 5h18v12H3zM8 21h8',
  back: 'M19 12H5M11 6l-6 6 6 6',
  arrow: 'M5 12h14M13 6l6 6-6 6',
  replay: 'M4 4v6h6M4.6 15a8 8 0 1 0 1.9-8.3L4 10',
  next: 'M5 5l10 7-10 7zM19 5v14',
  prev: 'M19 5L9 12l10 7zM5 5v14',
  sliders: 'M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0M16 4v4M10 10v4M18 16v4',
  loop: 'M17 2l4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-4.3-4.3',
  mic: 'M9 5a3 3 0 0 1 6 0v6a3 3 0 0 1-6 0zM5 11a7 7 0 0 0 14 0M12 18v3',
  split: 'M12 3v18M5 8v8M19 8v8',
  wand: 'M15 4V2M15 16v-2M8 9h2M20 9h2M17.8 11.8l1.4 1.4M17.8 6.2l1.4-1.4M12.2 6.2l-1.4-1.4M15 9 3 21',
  trash: 'M4 7h16M10 11v6M14 11v6M5 7l1 13h12l1-13M9 7V4h6v3',
  up: 'M12 19V5M6 11l6-6 6 6',
  full: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  edit: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4',
  text: 'M4 6h16M4 12h10M4 18h14',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
  play: 'M7 4l13 8-13 8z',
};

export function Icon({ name, size = 20, fill = false, stroke = 2 }) {
  if (name === 'play' || name === 'pause') {
    return html`<svg width=${size} height=${size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      ${name === 'play' ? html`<path d=${P.play}></path>` : html`<rect x="6" y="4" width="4" height="16" rx="1"></rect><rect x="14" y="4" width="4" height="16" rx="1"></rect>`}
    </svg>`;
  }
  const dots = name === 'grip' || name === 'more';
  return html`<svg width=${size} height=${size} viewBox="0 0 24 24" fill=${fill ? 'currentColor' : 'none'} stroke="currentColor"
    stroke-width=${dots ? 3 : stroke} stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d=${P[name]}></path></svg>`;
}

export function Logo({ size = 28 }) {
  return html`<svg width=${size} height=${size} viewBox="0 0 28 28" fill="none" stroke="var(--amber)" stroke-width="3" stroke-linecap="round" aria-hidden="true"><path d="M4 11v6M10 6v16M16 9v10M22 4v20"></path></svg>`;
}

function ThemePicker() {
  const controller = window.StemroomTheme;
  const [selected, setSelected] = useState(controller.current);
  const dialog = useRef();
  useEffect(() => {
    const changed = () => setSelected(controller.current());
    window.addEventListener('stemroom-theme-change', changed);
    return () => window.removeEventListener('stemroom-theme-change', changed);
  }, []);
  return html`<div class="theme-picker">
    <button class="btn theme-trigger" type="button" aria-label="Choose theme" aria-haspopup="dialog"
      title="Choose theme" onClick=${() => dialog.current.showModal()}><${Icon} name="palette" /><span>Theme</span></button>
    <dialog class="theme-dialog card" ref=${dialog} aria-labelledby="theme-title" aria-describedby="theme-description"
      onKeyDown=${e => e.stopPropagation()}>
      <div class="section-head"><h2 id="theme-title">Set the mood</h2><button class="icon-btn ghost" type="button" aria-label="Close themes" onClick=${() => dialog.current.close()}><${Icon} name="x" /></button></div>
      <p id="theme-description" class="hint">Choose a look for every page. Saved on this device.</p>
      <fieldset class="theme-options"><legend class="sr-only">Site theme</legend>
        ${controller.themes.map(theme => html`<label class=${'theme-option' + (selected === theme.id ? ' selected' : '')} key=${theme.id}>
          <span class="theme-swatches" aria-hidden="true">${theme.colors.map(color => html`<i style=${{background: color}}></i>`)}</span>
          <span class="theme-option-title"><strong>${theme.name}</strong><input type="radio" name="site-theme" value=${theme.id}
            checked=${selected === theme.id} onChange=${() => controller.set(theme.id)} aria-label=${theme.name} /></span>
          <span class="hint">${theme.description}</span>
        </label>`)}
      </fieldset>
      <div class="theme-footer"><button class="btn primary" type="button" onClick=${() => dialog.current.close()}>Done</button></div>
    </dialog>
  </div>`;
}

export function TopBar({ active, studioSong }) {
  const { room, connected } = useRoom();
  const songId = studioSong || room?.current?.songId;
  let studioLink = songId ? `#/studio/${songId}` : '#/studio';
  try { studioLink = localStorage.getItem('stemroom.studio') || studioLink; } catch {}
  const guests = room ? new Set([...room.queue, ...(room.current ? [room.current] : [])].map((e) => e.addedBy).filter(Boolean)).size : 0;
  return html`<header class="topbar">
    <a class="brand" href="#/"><${Logo} /><span>Stemroom</span></a>
    <nav class="nav" aria-label="Main">
      <a href="#/" aria-current=${active === 'queue' ? 'page' : null}>1 · Queue</a>
      <a href="#/stage" aria-current=${active === 'stage' ? 'page' : null}>2 · Stage</a>
      <a href=${studioLink} aria-current=${active === 'studio' ? 'page' : null}
         >3 · Studio</a>
    </nav>
    <div class="topbar-actions"><a class="portfolio-link" href="https://tylergriffith.us/" aria-label="Back to Tyler Griffith's website">← <span>Tyler Griffith</span></a><div class="room-chip" title=${connected ? 'Connected' : 'Reconnecting…'}>
      <span class=${'live-dot' + (connected ? '' : ' off')}></span>
      ${connected ? html`Live · ${guests} ${guests === 1 ? 'guest' : 'guests'}` : 'Reconnecting…'}
    </div><${ThemePicker}/></div>
  </header>`;
}

export function ConnectionNotice() {
  const { connected } = useRoom();
  const [waiting, setWaiting] = useState(false);
  useEffect(() => {
    if (connected) { setWaiting(false); return; }
    const timer = setTimeout(() => setWaiting(true), 6000);
    return () => clearTimeout(timer);
  }, [connected]);
  if (connected || !waiting) return null;
  return html`<div class="page-inner" role="status" style="padding:16px 24px 0">
    <div class="card"><strong>Waiting for the room</strong>
      <p class="hint">The room may be offline, or your connection may have dropped. Songs and shared controls will return automatically when the host reconnects.</p>
    </div></div>`;
}

function hash(s) {
  let h = 0;
  for (const c of s || '') h = (h * 31 + c.charCodeAt(0)) | 0;
  return Math.abs(h);
}
export const nameColor = (name) => SINGER_COLORS[hash(name) % SINGER_COLORS.length];

export function Avatar({ name, color, lg }) {
  return html`<span class=${'avatar' + (lg ? ' lg' : '')} style=${{ background: color || nameColor(name) }} aria-hidden="true">${initials(name)}</span>`;
}

export function Avatars({ names, duetColors }) {
  return html`<span class="avatars">${names.map((n, i) => html`<${Avatar} name=${n} color=${duetColors && names.length > 1 ? SINGER_COLORS[i] : null} />`)}</span>`;
}

export function Switch({ id, checked, onChange, label }) {
  return html`<span class="switch"><input id=${id} type="checkbox" role="switch" checked=${checked}
    aria-label=${label} onChange=${(e) => onChange(e.target.checked)} /><span></span></span>`;
}

export function Stepper({ value, label, onDown, onUp, format = (v) => v, min, max, unitLabel }) {
  return html`<div class="stepper" role="group" aria-label=${label}>
    <button class="icon-btn" type="button" aria-label=${`Lower ${label}`} onClick=${onDown} disabled=${min !== undefined && value <= min}><${Icon} name="minus" /></button>
    <span class="val" aria-live="polite">${format(value)}${unitLabel || ''}</span>
    <button class="icon-btn" type="button" aria-label=${`Raise ${label}`} onClick=${onUp} disabled=${max !== undefined && value >= max}><${Icon} name="plus" /></button>
  </div>`;
}

export function Toasts() {
  const [items, setItems] = useState([]);
  useEffect(() => {
    const h = (e) => {
      const t = e.detail;
      setItems((xs) => [...xs, t].slice(-3));
      setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== t.id)), 4200);
    };
    bus.addEventListener('local-toast', h);
    return () => bus.removeEventListener('local-toast', h);
  }, []);
  return html`<div class="toasts" role="status">${items.map((t) => html`<div class=${'toast' + (t.error ? ' error' : '')}>${t.text}</div>`)}</div>`;
}

export function QR({ text, size = 150, label }) {
  const svg = useMemo(() => {
    if (!text) return '';
    const q = qrcode(0, 'M');
    q.addData(text);
    q.make();
    const n = q.getModuleCount();
    let d = '';
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (q.isDark(y, x)) d += `M${x} ${y}h1v1h-1z`;
    return `<svg width="${size}" height="${size}" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges"><path d="${d}" fill="var(--bg)"/></svg>`;
  }, [text, size]);
  return html`<div class="qr" role="img" aria-label=${label || `QR code for ${text}`} dangerouslySetInnerHTML=${{ __html: svg }}></div>`;
}

export function Thumb({ src, sm }) {
  const [err, setErr] = useState(false);
  useEffect(() => setErr(false), [src]);
  if (!src || err) return html`<span class=${'thumb' + (sm ? ' sm' : '')}><${Icon} name="music" size=${sm ? 20 : 26} /></span>`;
  return html`<img class=${'thumb' + (sm ? ' sm' : '')} src=${appUrl(src)} alt="" loading="lazy" onError=${() => setErr(true)} />`;
}

export function useClickOutside(ref, onOut, active) {
  useEffect(() => {
    if (!active) return;
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) onOut(); };
    const k = (e) => { if (e.key === 'Escape') onOut(); };
    document.addEventListener('pointerdown', h);
    document.addEventListener('keydown', k);
    return () => { document.removeEventListener('pointerdown', h); document.removeEventListener('keydown', k); };
  }, [active]);
}

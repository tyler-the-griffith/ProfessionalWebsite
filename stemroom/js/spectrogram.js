// "How this song came apart": the stems' spectrograms on one shared time × pitch grid.
//   exploded — every stem as its own sheet, stacked in depth with the axes lined up
//   solo     — the mix in grey with the selected stem shown in place, in colour
//   colored  — one plot, each cell coloured by the stem that owns it
import { html, useState, useEffect, useRef, useMemo, fmtTime } from './lib.js';
import { api, useBus } from './api.js';

export const SPEC_VIEWS = [
  { id: 'exploded', label: 'Exploded view' },
  { id: 'solo', label: 'Solo in place' },
  { id: 'colored', label: 'Coloured plot' },
];
const VIEW_KEY = 'stemroom.spectrogramView';
const readView = () => { try { return SPEC_VIEWS.some((v) => v.id === localStorage.getItem(VIEW_KEY)) ? localStorage.getItem(VIEW_KEY) : 'exploded'; } catch { return 'exploded'; } };

const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const cssRgb = (name, fallback) => {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return /^#[0-9a-f]{6}$/i.test(v) ? hexRgb(v) : hexRgb(fallback);
};
const canvas = (w, h) => Object.assign(document.createElement('canvas'), { width: w, height: h });

/** Decoded bytes and linear power per stem. */
function decode(data) {
  const out = {};
  for (const [id, b64] of Object.entries(data.stems)) {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const power = new Float32Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) power[i] = bytes[i] ? 10 ** (((bytes[i] / 255) - 1) * data.rangeDb / 10) : 0;
    out[id] = { bytes, power };
  }
  return out;
}

/** One stem in its colour, transparent where it is silent. */
function layerImage(dec, cols, bands, rgb) {
  const c = canvas(cols, bands), img = c.getContext('2d').createImageData(cols, bands);
  for (let i = 0; i < dec.bytes.length; i++) {
    const a = (dec.bytes[i] / 255) ** 1.35;
    img.data[i * 4] = rgb[0]; img.data[i * 4 + 1] = rgb[1]; img.data[i * 4 + 2] = rgb[2]; img.data[i * 4 + 3] = a * 255;
  }
  c.getContext('2d').putImageData(img, 0, 0);
  return c;
}

/** Sum of stems: in grey, or with every cell coloured by its loudest stem. */
function mixImage(decs, stems, cols, bands, rangeDb, bg, grey, colored) {
  const c = canvas(cols, bands), img = c.getContext('2d').createImageData(cols, bands);
  const rgbs = stems.map((s) => hexRgb(s.color));
  for (let i = 0; i < cols * bands; i++) {
    let sum = 0, best = 0, bestP = -1;
    stems.forEach((s, k) => { const p = decs[s.id].power[i]; sum += p; if (p > bestP) { bestP = p; best = k; } });
    const v = sum > 0 ? Math.max(0, 1 + (10 * Math.log10(sum)) / rangeDb) ** 1.25 : 0;
    const to = colored ? rgbs[best] : grey;
    for (let ch = 0; ch < 3; ch++) img.data[i * 4 + ch] = bg[ch] + (to[ch] - bg[ch]) * v;
    img.data[i * 4 + 3] = 255;
  }
  c.getContext('2d').putImageData(img, 0, 0);
  return c;
}

export function SpectrogramCard({ song, stems, audible, selected, onSelect, duration, getTime, onSeek }) {
  const [data, setData] = useState(null);
  const [missing, setMissing] = useState(false);
  const [view, setView] = useState(readView);
  const [theme, setTheme] = useState(0);
  const ref = useRef();
  const geom = useRef(null);
  const asked = useRef(false);

  const load = () => api.get(`/api/songs/${song.id}/spectrogram`)
    .then((d) => { setData(d); setMissing(false); })
    .catch(() => {
      setMissing(true);
      // Songs prepared before this view existed get theirs drawn once, on first open.
      if (!asked.current) { asked.current = true; api.post(`/api/songs/${song.id}/spectrogram`).catch(() => {}); }
    });
  useEffect(() => { asked.current = false; setData(null); load(); }, [song.id, song.assetVersion]);
  useBus('song', (m) => { if (m.songId === song.id) load(); }, [song.id]);
  useEffect(() => {
    const h = () => setTheme((x) => x + 1);
    addEventListener('stemroom-theme-change', h);
    return () => removeEventListener('stemroom-theme-change', h);
  }, []);

  const shown = data ? stems.filter((s) => data.stems[s.id]) : [];
  const decs = useMemo(() => (data ? decode(data) : null), [data]);
  const audibleKey = shown.filter((s) => audible(s)).map((s) => s.id).join(',');
  const images = useMemo(() => {
    if (!decs) return null;
    const bg = cssRgb('--bg', '#18210F'), grey = cssRgb('--muted', '#BDC4A3');
    const on = shown.filter((s) => audible(s));
    const { cols, bands, rangeDb } = data;
    return {
      layers: Object.fromEntries(shown.map((s) => [s.id, layerImage(decs[s.id], cols, bands, hexRgb(s.color))])),
      colored: mixImage(decs, on.length ? on : shown, cols, bands, rangeDb, bg, grey, true),
      grey: mixImage(decs, shown, cols, bands, rangeDb, bg, grey, false),
    };
  }, [decs, audibleKey, shown.map((s) => s.id).join(','), theme]);

  // Draw continuously so the playhead moves; everything else is a handful of drawImage calls.
  useEffect(() => {
    if (!images) return;
    let raf;
    const c = ref.current;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const dpr = Math.min(2, devicePixelRatio || 1);
      const cssW = c.clientWidth;
      const n = shown.length;
      const cssH = view === 'exploded' ? Math.max(340, Math.min(780, 110 + n * 54)) : Math.max(220, Math.min(380, cssW * 0.32));
      if (c.width !== Math.round(cssW * dpr) || c.height !== Math.round(cssH * dpr)) {
        c.width = Math.round(cssW * dpr); c.height = Math.round(cssH * dpr); c.style.height = `${cssH}px`;
      }
      const g = c.getContext('2d'), W = c.width, H = c.height;
      const tok = getComputedStyle(document.documentElement);
      const text = tok.getPropertyValue('--text').trim() || '#FEFAE0';
      const dim = tok.getPropertyValue('--dim').trim() || '#A2B18D';
      const bg = tok.getPropertyValue('--bg').trim() || '#18210F';
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.fillStyle = bg; g.fillRect(0, 0, W, H);
      g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
      const { cols, bands } = data;
      const t = getTime();
      const axisH = 22 * dpr;
      const font = (px, w = 600) => `${w} ${px * dpr}px "Instrument Sans", system-ui, sans-serif`;

      if (view === 'exploded') {
        // Oblique stack: each sheet's pitch axis leans back to the right, and the sheets are
        // spaced so none hides another (a covered strip would be its low end: bass, kick).
        // On phones the legend below names the stems, so the sheets get the full width.
        const narrow = cssW < 600;
        const labelW = narrow ? 8 * dpr : Math.min(170 * dpr, W * 0.26);
        const step = (H - axisH - 14 * dpr) / Math.max(1, n);
        const sheetH = step * 0.9;
        const lean = Math.min(sheetH * 0.9, 60 * dpr, W * 0.07);
        const sheetW = W - labelW - lean - 14 * dpr;
        const sheets = shown.map((s, k) => ({ s, oy: 8 * dpr + k * step }));
        geom.current = { view, sheets, sheetW, sheetH, lean, labelW };
        sheets.forEach(({ s, oy }) => {
          const ox = labelW;
          const on = audible(s), sel = s.id === selected;
          // Map image (x: time, y: pitch row, row 0 = top) onto a sheared parallelogram.
          g.setTransform(sheetW / cols, 0, lean / bands, sheetH / bands, ox, oy);
          g.globalAlpha = on ? 0.92 : 0.35;
          g.fillStyle = bg; g.fillRect(0, 0, cols, bands);
          g.drawImage(images.layers[s.id], 0, 0);
          g.setTransform(1, 0, 0, 1, 0, 0);
          g.globalAlpha = on ? (sel ? 1 : 0.55) : 0.25;
          g.strokeStyle = s.color; g.lineWidth = (sel ? 2 : 1) * dpr;
          g.beginPath();
          g.moveTo(ox, oy); g.lineTo(ox + sheetW, oy);
          g.lineTo(ox + sheetW + lean, oy + sheetH); g.lineTo(ox + lean, oy + sheetH); g.closePath();
          g.stroke();
          g.globalAlpha = 1;
        });
        // Labels sit in the left column, beside the top edge of each sheet (the part that stays
        // visible), with a short leader to the sheet so nothing overlaps.
        g.font = font(13); g.textBaseline = 'middle'; g.textAlign = 'right';
        if (!narrow) sheets.forEach(({ s, oy }) => {
          const on = audible(s), sel = s.id === selected;
          const v = 0.5, ly = oy + v * sheetH, edge = labelW + v * lean;
          g.globalAlpha = on ? 1 : 0.45;
          g.font = font(13, sel ? 700 : 600);
          g.fillStyle = sel ? text : dim; g.fillText(s.name, labelW - 22 * dpr, ly);
          g.fillStyle = s.color; g.beginPath(); g.arc(labelW - 12 * dpr, ly, 4 * dpr, 0, 7); g.fill();
          g.strokeStyle = s.color; g.lineWidth = dpr; g.globalAlpha *= 0.5;
          g.beginPath(); g.moveTo(labelW - 6 * dpr, ly); g.lineTo(edge, ly); g.stroke();
          g.globalAlpha = 1;
        });
        // Playhead: the same moment drawn across every sheet.
        if (duration) {
          const x = labelW + (t / duration) * sheetW;
          g.strokeStyle = text; g.lineWidth = 1.5 * dpr; g.globalAlpha = 0.9;
          g.beginPath();
          sheets.forEach(({ oy }) => { g.moveTo(x, oy); g.lineTo(x + lean, oy + sheetH); });
          g.stroke();
          g.globalAlpha = 0.35; g.beginPath();
          g.moveTo(x + lean, sheets[0].oy + sheetH); g.lineTo(x + lean, sheets[n - 1].oy + sheetH); g.stroke();
          g.globalAlpha = 1;
        }
        drawAxis(g, labelW + lean, sheetW, H - axisH, axisH, duration, dpr, dim);
      } else {
        const top = 0, plotH = H - axisH, plotW = W;
        geom.current = { view, plotW, plotH };
        if (view === 'colored') {
          g.drawImage(images.colored, 0, 0, cols, bands, 0, top, plotW, plotH);
        } else {
          g.globalAlpha = 0.4; g.drawImage(images.grey, 0, 0, cols, bands, 0, top, plotW, plotH);
          g.globalAlpha = 1;
          const focus = shown.find((s) => s.id === selected) || shown[0];
          if (focus) g.drawImage(images.layers[focus.id], 0, 0, cols, bands, 0, top, plotW, plotH);
        }
        if (duration) {
          const x = (t / duration) * plotW;
          g.fillStyle = text; g.fillRect(x - dpr, top, 2 * dpr, plotH);
        }
        // Pitch hint on the left edge.
        g.font = font(11); g.textAlign = 'left'; g.fillStyle = dim; g.textBaseline = 'top';
        g.fillText('High', 8 * dpr, 6 * dpr); g.textBaseline = 'bottom'; g.fillText('Low', 8 * dpr, plotH - 4 * dpr);
        drawAxis(g, 0, plotW, plotH, axisH, duration, dpr, dim);
      }
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [images, view, selected, audibleKey, duration]);

  const pick = (e) => {
    const c = ref.current, G = geom.current;
    if (!G || !data) return;
    const r = c.getBoundingClientRect();
    const dpr = c.width / r.width;
    const px = (e.clientX - r.left) * dpr, py = (e.clientY - r.top) * dpr;
    if (G.view === 'exploded') {
      for (let k = G.sheets.length - 1; k >= 0; k--) {     // front sheet first
        const { s, oy } = G.sheets[k];
        const v = (py - oy) / G.sheetH;
        if (v < 0 || v > 1) continue;
        const u = (px - G.labelW - v * G.lean) / G.sheetW;
        if (u < 0 || u > 1) continue;
        onSelect(s.id);
        onSeek(u * duration);
        return;
      }
    } else if (py < G.plotH) {
      onSeek((px / G.plotW) * duration);
    }
  };

  const setV = (v) => { setView(v); try { localStorage.setItem(VIEW_KEY, v); } catch { /* per-device preference only */ } };
  const focus = shown.find((s) => s.id === selected) || shown[0];
  const hint = {
    exploded: 'Every stem on its own sheet, stacked on the same time and pitch axes. Click a sheet to select that stem and jump there.',
    solo: `${focus ? focus.name : 'The selected stem'} in colour, in place over the whole mix in grey. Pick another stem below or in the mixer.`,
    colored: 'The whole mix, each cell coloured by the stem that is loudest there. Muting or soloing in the mixer changes which stems take part.',
  }[view];

  return html`<section class="card spec-card" aria-label="How this song came apart">
    <div class="row wrap" style="justify-content: space-between; gap: 10px 16px">
      <div class="stack" style="gap: 2px; min-width: 0; flex: 1 1 320px">
        <span class="h2" style="font-size: 20px">How this song came apart</span>
        <span class="hint">${hint}</span>
      </div>
      <label class="row" style="gap: 8px"><span class="ctl-label">View</span>
        <select class="input" value=${view} onChange=${(e) => setV(e.target.value)} aria-label="Spectrogram view">
          ${SPEC_VIEWS.map((v) => html`<option value=${v.id}>${v.label}</option>`)}
        </select></label>
    </div>
    ${data ? html`<canvas class="spec-canvas" ref=${ref} onClick=${pick} role="img"
        aria-label=${`Spectrogram of ${song.title}, ${SPEC_VIEWS.find((v) => v.id === view).label.toLowerCase()}`}></canvas>
      <div class="spec-legend" role="group" aria-label="Show stem">
        ${shown.map((s) => html`<button type="button" aria-pressed=${s.id === focus?.id} class=${audible(s) ? '' : 'off'}
            onClick=${() => onSelect(s.id)}><span class="dot" style=${{ background: s.color }}></span>${s.name}</button>`)}
      </div>`
    : html`<div class="spec-empty">${missing ? 'Drawing the spectrogram for this song. It takes about 20 seconds.' : 'Loading the spectrogram…'}</div>`}
  </section>`;
}

function drawAxis(g, x0, w, y, h, duration, dpr, color) {
  if (!duration) return;
  g.font = `400 ${11 * dpr}px "JetBrains Mono", monospace`;
  g.fillStyle = color; g.textBaseline = 'middle'; g.textAlign = 'center';
  // Label every 30 s, 1 or 2 minutes: whichever keeps labels at least ~60 px apart.
  const step = [30, 60, 120, 300].find((st) => (st / duration) * w >= 60 * dpr) || 300;
  for (let s = 0; s <= duration; s += step) {
    const x = x0 + (s / duration) * w;
    g.fillRect(x - dpr / 2, y + 2 * dpr, dpr, 4 * dpr);
    g.fillText(fmtTime(s), Math.min(Math.max(x, 18 * dpr), x0 + w - 18 * dpr), y + h / 2 + 3 * dpr);
  }
}

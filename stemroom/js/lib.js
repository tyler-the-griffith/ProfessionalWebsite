import { h, render, Fragment } from 'preact';
import htm from 'htm';

export const html = htm.bind(h);
export { h, render, Fragment };
export { useState, useEffect, useRef, useMemo, useCallback, useLayoutEffect, useReducer } from 'preact/hooks';

export const fmtTime = (s) => {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
};

export const fmtKey = (k) => (k > 0 ? `+${k}` : k < 0 ? `−${Math.abs(k)}` : '0');

const NOTES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
export const keyName = (key, shift = 0) => {
  if (!key) return '';
  return `${NOTES[(((key.tonic + shift) % 12) + 12) % 12]} ${key.mode}`;
};
export const transposeChord = (name, shift) => {
  if (!shift) return name;
  const m = name.match(/^([A-G][♯♭]?)(.*)$/);
  if (!m) return name;
  const i = NOTES.indexOf(m[1]);
  return i < 0 ? name : NOTES[(((i + shift) % 12) + 12) % 12] + m[2];
};

export const SINGER_COLORS = ['var(--singer-0)', 'var(--singer-1)', 'var(--singer-2)'];
export const SINGER_HEX = ['#E09F3E', '#7FAFBA', '#D4605A'];
export const ALL_COLOR = 'var(--singer-all)';

export const initials = (name) => (name || '?').trim().split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();

export const singersLabel = (singers) => {
  if (!singers?.length) return 'Someone';
  if (singers.length === 1) return singers[0];
  return singers.slice(0, -1).join(', ') + ' & ' + singers[singers.length - 1];
};

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export function debounce(fn, ms) {
  let t;
  const d = (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  d.flush = (...args) => { clearTimeout(t); fn(...args); };
  return d;
}

export const isUrl = (s) => /^(https?:\/\/|www\.|youtu\.?be|m\.youtube)/i.test(s.trim()) || /^[\w-]{11}$/.test(s.trim());

// Lyric timing helpers, duet part assignment, and the big karaoke lyric display.
import { html, useEffect, useLayoutEffect, useRef, useState, useMemo, fmtTime, SINGER_COLORS, ALL_COLOR, singersLabel } from './lib.js';
import { vocalGaps, vocalCountdown } from './lyric-timing.js';

export function sectionAt(sections, t) {
  return (sections || []).find((s) => t >= s.start && t < s.end) || null;
}

/**
 * Who sings each line. Explicit assignments from the studio win; otherwise with two or more
 * singers we alternate verses between them and sing choruses together.
 */
export function resolveParts(lines, sections, nSingers) {
  if (!lines?.length) return [];
  if (nSingers < 2) return lines.map(() => 0);
  const chorusAt = (t) => sectionAt(sections, t + 0.05)?.label === 'Chorus';
  const parts = [];
  let verse = -1;
  let lastStanza = null;
  for (const l of lines) {
    if (l.singer !== null && l.singer !== undefined) {
      parts.push(l.singer === 'all' ? 'all' : Math.min(l.singer, nSingers - 1));
      continue;
    }
    if (chorusAt(l.start)) {
      parts.push('all');
      continue;
    }
    if (l.stanza !== lastStanza) { verse++; lastStanza = l.stanza; }
    parts.push(verse % nSingers);
  }
  return parts;
}

export const partColor = (p) => (p === 'all' ? ALL_COLOR : SINGER_COLORS[p] || SINGER_COLORS[0]);
export const partLabel = (p, singers) => (p === 'all' ? (singers.length > 2 ? 'Everyone' : 'Both') : singers[p] || `Singer ${p + 1}`);

/** Index of the line being sung, or the next one to sing if we're in a gap. */
export function activeLine(lines, t) {
  let lo = 0, hi = lines.length - 1, idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].start - 0.25 <= t) { idx = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (idx >= 0 && t <= lines[idx].end + 0.6) return { idx, upcoming: false };
  return { idx: Math.min(idx + 1, lines.length - 1), upcoming: idx + 1 < lines.length };
}

function Line({ line, cls, part, singers, duet }) {
  if (!line) return html`<p class=${'lyric ' + cls} aria-hidden="true"> </p>`;
  const sung = duet ? partColor(part) : 'var(--amber)';
  // Unsung words are cream tinted with the singer's colour; they fill in with the full colour.
  const unsung = duet ? `color-mix(in srgb, ${partColor(part)} 30%, var(--cream))` : 'var(--cream)';
  return html`<p class=${'lyric ' + cls}>
    ${duet && html`<span class="tag" style=${{ color: partColor(part) }}>${partLabel(part, singers)}</span>`}
    ${line.words.map((w) => html`<span class="w" data-s=${w.s} data-e=${w.e}
        style=${{ '--sung': sung, '--unsung': unsung }}>${w.t}</span>`)}
  </p>`;
}

/** The stage lyric display. `getTime` returns song time in seconds. */
export function LyricsView({ lyrics, sections, singers, getTime, getRate = () => 1, playing = true }) {
  const lines = lyrics?.lines || [];
  const offset = lyrics?.offset || 0;
  const duet = singers.length > 1;
  const parts = useMemo(() => resolveParts(lines, sections, singers.length), [lines, sections, singers.length]);
  const gaps = useMemo(() => vocalGaps(lines, offset), [lines, offset]);
  const [view, setView] = useState({ idx: 0, upcoming: true, section: null, countdown: null });
  const viewportRef = useRef();
  const trackRef = useRef();
  const positionRef = useRef();
  const positionedIndex = useRef(null);
  const timeRef = useRef({ getTime, getRate });
  timeRef.current = { getTime, getRate };
  const viewRef = useRef(view);
  viewRef.current = view;

  // Keep the actual lyric rows in place and move their track. Replacing four
  // text slots made each line jump even when their CSS had transitions.
  positionRef.current = (animate = false) => {
    const viewport = viewportRef.current;
    const track = trackRef.current;
    const row = track?.children[viewRef.current.idx];
    if (!row || !viewport?.clientHeight) return; // Stage can be hidden while audio continues.
    const y = viewport.clientHeight * 0.43 - row.offsetTop - row.offsetHeight / 2;
    track.style.transition = animate ? '' : 'none';
    track.style.transform = `translate3d(0, ${y}px, 0)`;
  };

  useLayoutEffect(() => {
    const previous = positionedIndex.current;
    // Move between neighboring lines, including replay. Land directly on a
    // distant seek or initial load instead of flying through the whole song.
    positionRef.current(previous !== null && Math.abs(view.idx - previous) === 1);
    positionedIndex.current = view.idx;
  }, [view.idx, lines.length, duet]);

  useEffect(() => {
    if (!viewportRef.current || !trackRef.current) return;
    const observer = new ResizeObserver(() => positionRef.current());
    observer.observe(viewportRef.current);
    observer.observe(trackRef.current);
    return () => observer.disconnect();
  }, [!!lines.length]);

  useEffect(() => {
    let raf;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      if (!lines.length) return;
      const t = timeRef.current.getTime() - offset;
      const { idx, upcoming } = activeLine(lines, t);
      const countdown = vocalCountdown(gaps, t, timeRef.current.getRate());
      const sec = sectionAt(sections, t)?.label || null;
      const v = viewRef.current;
      if (v.idx !== idx || v.upcoming !== upcoming || v.countdown !== countdown || v.section !== sec) {
        setView({ idx, upcoming, countdown, section: sec });
      }
      const el = trackRef.current?.children[idx];
      if (el) {
        for (const w of el.querySelectorAll('.w')) {
          const s = +w.dataset.s, e = +w.dataset.e;
          const p = t <= s ? 0 : t >= e ? 1 : (t - s) / Math.max(0.05, e - s);
          w.style.setProperty('--p', p.toFixed(3));
        }
      }
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [lines, sections, offset, gaps]);

  if (!lines.length) {
    return html`<div class="lyrics"><p class="lyric next">No lyrics for this one. Enjoy the instrumental!</p></div>`;
  }
  const i = view.idx;
  return html`<div class="lyrics" aria-live="off">
    <div class="lyrics-header">
      ${view.countdown !== null ? html`<div class=${'vocal-countdown' + (playing ? '' : ' paused') + (view.countdown <= 3 ? ' imminent' : '')}
        role="timer" aria-live="off" aria-label=${`${playing ? '' : 'Paused. '}Vocals in ${view.countdown} seconds`}>
        <span class="vocal-countdown-label">${playing ? 'Vocals in' : 'Paused · vocals in'}</span>
        <strong class="vocal-countdown-number" key=${view.countdown}>${view.countdown >= 60 ? fmtTime(view.countdown) : view.countdown}</strong>
        <span class="vocal-countdown-unit">${view.countdown >= 60 ? 'min:sec' : 'sec'}</span>
      </div>` : html`<span class=${'section-tag' + (view.section && !view.section.startsWith('Part') ? '' : ' hidden')}>${view.section || ' '}</span>`}
    </div>
    <div class="lyrics-window" ref=${viewportRef}>
      <div class="lyrics-track" ref=${trackRef}>
        ${lines.map((line, index) => html`<${Line} key=${index} line=${line}
          cls=${index === i ? 'cur' : index === i - 1 ? 'prev' : index === i + 1 ? 'next' : index === i + 2 ? 'next2' : 'distant'}
          part=${parts[index]} singers=${singers} duet=${duet} />`)}
      </div>
    </div>
  </div>`;
}

export { singersLabel };

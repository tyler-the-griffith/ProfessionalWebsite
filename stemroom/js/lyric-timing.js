// Vocal-free spans use lyric/word timing, independently of the display's early
// line selection. This keeps the count-in visible right up to the first word.
const LONG_BREAK = 4;

export function vocalGaps(lines, offset = 0) {
  const spans = [];
  for (const line of lines) {
    const words = line.words || [];
    const timedWords = words.length && words.every(w => Number.isFinite(w.s) && Number.isFinite(w.e) && w.e > w.s);
    if (timedWords) {
      for (const word of words) spans.push([word.s, word.e]);
    } else if (Number.isFinite(line.start) && Number.isFinite(line.end) && line.end > line.start) {
      spans.push([line.start, line.end]);
    }
  }
  spans.sort((a, b) => a[0] - b[0]);
  const gaps = [];
  // t = playback time - lyric offset; the beginning of the song is -offset.
  let end = -offset;
  for (const [start, stop] of spans) {
    if (start - end >= LONG_BREAK) gaps.push({ start: end, end: start });
    end = Math.max(end, stop); // Overlapping duet lines still contain vocals.
  }
  // No trailing gap: without another vocal there is nothing to count down to.
  return gaps;
}

export function vocalCountdown(gaps, t, rate = 1) {
  let lo = 0, hi = gaps.length - 1, index = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (gaps[mid].start <= t) { index = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  const gap = gaps[index];
  if (!gap || t >= gap.end) return null;
  const speed = Number.isFinite(rate) && rate > 0 ? rate : 1;
  return Math.max(1, Math.ceil((gap.end - t) / speed - 1e-8));
}

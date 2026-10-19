// Full control over one song: per-stem mix and effects, key/speed, loops, lyrics and duet parts.
import { html, useState, useEffect, useRef, useMemo, useCallback, fmtTime, fmtKey, keyName, transposeChord, clamp, debounce, singersLabel } from '../lib.js';
import { api, useRoom, useBus, toast, bus, clientId } from '../api.js';
import { appUrl } from '../urls.mjs';
import { Engine, computeGains, playableStems, stemMix, leadVocalLevel, TONE_NAMES, VOCAL } from '../engine.js';
import { resolveParts, partColor, partLabel, activeLine, sectionAt } from '../lyrics.js';
import { Icon, TopBar, Stepper, Switch, useClickOutside, Thumb } from '../ui.js';

import { Modal } from '../library.js';
const engine = new Engine();
async function previewPlay() {
  bus.dispatchEvent(new CustomEvent('studio-preview'));
  await api.post('/api/transport', { action: 'preview', clientId });
  await engine.play();
}


// ---------------------------------------------------------------- waveform

function Wave({ peaks, color, scale, duration, onSeek }) {
  const ref = useRef();
  const draw = useCallback(() => {
    const c = ref.current;
    if (!c || !peaks) return;
    const dpr = devicePixelRatio || 1;
    const w = c.clientWidth, h = c.clientHeight;
    c.width = w * dpr; c.height = h * dpr;
    const g = c.getContext('2d');
    g.scale(dpr, dpr);
    g.fillStyle = color;
    const bars = Math.max(1, Math.floor(w / 3));
    const per = peaks.length / bars;
    const s = 0.2 + 0.8 * Math.min(1.5, scale);
    for (let i = 0; i < bars; i++) {
      let m = 0;
      for (let j = Math.floor(i * per); j < Math.floor((i + 1) * per); j++) m = Math.max(m, peaks[j] || 0);
      const bh = Math.max(2, (m / 100) * h * s);
      g.fillRect(i * 3, (h - bh) / 2, 2, bh);
    }
  }, [peaks, color, scale]);
  useEffect(() => {
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, [draw]);
  return html`<canvas class="wave" ref=${ref} aria-hidden="true"
    onClick=${(e) => { const r = e.currentTarget.getBoundingClientRect(); onSeek(((e.clientX - r.left) / r.width) * duration); }}></canvas>`;
}

function Playhead({ duration, loop }) {
  const ref = useRef();
  useEffect(() => {
    let raf;
    const f = () => {
      raf = requestAnimationFrame(f);
      if (ref.current && duration) ref.current.style.left = `${(engine.time() / duration) * 100}%`;
    };
    f();
    return () => cancelAnimationFrame(raf);
  }, [duration]);
  return html`<div class="overlay-area">
    ${loop && html`<div class="loop-region" style=${{ left: `${(loop[0] / duration) * 100}%`, width: `${((loop[1] - loop[0]) / duration) * 100}%` }}><span>LOOP</span></div>`}
    <div class="playhead" ref=${ref}></div>
  </div>`;
}

// ---------------------------------------------------------------- mixer

function TrackRow({ stem, m, selected, peaks, duration, anySolo, onSelect, onChange }) {
  const audible = !m.mute && (!anySolo || m.solo);
  const linked = stem.id === 'backing_harmony' && m.followLead !== false;
  return html`<div class=${'track' + (selected ? ' sel' : '') + (stem.quiet ? ' quiet' : '')}>
    <div class="lane-head stack" style="gap: 2px">
      <div class="row" style="gap: 6px">
        <button class="track-name" type="button" onClick=${onSelect} aria-pressed=${selected}>
          <span class="dot" style=${{ background: stem.color }}></span>
          <span class="ellipsis">${stem.name}</span>
          ${stem.quiet && html`<span class="dim" style="font-size: 11px; font-weight: 500">barely there</span>`}
        </button>
        <button class="ms mute" type="button" aria-label=${`Mute ${stem.name}`} aria-pressed=${!!m.mute} onClick=${() => onChange({ mute: !m.mute })}>M</button>
        <button class="ms solo" type="button" aria-label=${`Solo ${stem.name}`} aria-pressed=${!!m.solo} onClick=${() => onChange({ solo: !m.solo })}>S</button>
      </div>
      <input type="range" min="0" max="150" value=${Math.round(m.vol * 100)} aria-label=${`${stem.name} volume`}
        disabled=${linked} title=${linked ? 'Follows the lead vocal level. Select this stem to unlink it.' : ''}
        style=${{ accentColor: stem.color }} onInput=${(e) => onChange({ vol: e.target.value / 100 })} />
    </div>
    <div class="lane-body" style=${{ opacity: audible ? 1 : 0.22 }}>
      <${Wave} peaks=${peaks} color=${stem.color} scale=${m.vol} duration=${duration} onSeek=${(t) => engine.seek(t)} />
    </div>
  </div>`;
}

function Inspector({ song, stem, m, onChange, busy }) {
  if (!stem) return null;
  const refine = (op) => api.post(`/api/songs/${song.id}/refine`, { stem: stem.id, op })
    .then(() => toast('Working on it. New stems appear when they\'re ready.')).catch((e) => toast(e.message, true));
  const hasKit = song.stems.some((s) => s.parent === 'drums');
  const hasDry = song.stems.some((s) => s.id === 'lead_dry');
  const linked = stem.id === 'backing_harmony' && m.followLead !== false;
  return html`<aside class="card inspector" aria-label="Stem settings">
    <div class="stack" style="gap: 4px">
      <span class="eyebrow">Selected stem</span>
      <span class="head"><span class="dot" style=${{ background: stem.color, width: '14px', height: '14px' }}></span>${stem.name}</span>
      <span class="hint">${stem.quiet ? 'Very little of this instrument was found in the song.' : `Average level ${stem.db} dB`}</span>
    </div>
    ${stem.id === 'backing_harmony' && html`<div class="stack" style="gap: 8px">
      <label class="row"><input type="checkbox" checked=${linked} onChange=${e => onChange({followLead:e.target.checked,vol:m.vol})}/>Follow lead vocal level</label>
      <span class="hint">Backing vocals during lead phrases follow its volume and Guide vocal setting. Unlink to set their level separately. Detection uses vocal activity, so separation bleed may also be included.</span>
    </div>`}
    <div class="stack" style="gap: 10px">
      <div class="kv"><label for="i-vol">Volume</label><span class="v">${Math.round(m.vol * 100)}%</span></div>
      <input id="i-vol" type="range" min="0" max="150" value=${Math.round(m.vol * 100)} disabled=${linked} onInput=${(e) => onChange({ vol: e.target.value / 100 })} />
      <div class="kv"><label for="i-pan">Pan</label><span class="v">${m.pan === 0 ? 'Center' : m.pan < 0 ? `${Math.round(-m.pan * 100)} L` : `${Math.round(m.pan * 100)} R`}</span></div>
      <input id="i-pan" type="range" min="-100" max="100" value=${Math.round(m.pan * 100)} onInput=${(e) => onChange({ pan: e.target.value / 100 })} onDblClick=${() => onChange({ pan: 0 })} />
      <div class="kv"><label for="i-rev">Reverb</label><span class="v">${Math.round(m.reverb * 100)}%</span></div>
      <input id="i-rev" type="range" min="0" max="100" value=${Math.round(m.reverb * 100)} onInput=${(e) => onChange({ reverb: e.target.value / 100 })} />
      <div class="kv"><label for="i-echo">Echo</label><span class="v">${Math.round(m.echo * 100)}%</span></div>
      <input id="i-echo" type="range" min="0" max="100" value=${Math.round(m.echo * 100)} onInput=${(e) => onChange({ echo: e.target.value / 100 })} />
    </div>
    <div class="stack" style="gap: 10px">
      <span style="font-size: 15px">Tone</span>
      <div class="chips" role="group" aria-label="Tone">
        ${Object.entries(TONE_NAMES).map(([k, label]) => html`<button type="button" aria-pressed=${m.tone === k} onClick=${() => onChange({ tone: k })}>${label}</button>`)}
      </div>
    </div>
    <div class="stack" style="gap: 8px; padding-top: 16px; border-top: 1px solid var(--line)">
      ${stem.id === 'drums' && !hasKit && html`<button class="btn" type="button" disabled=${busy} onClick=${() => refine('drumsep')}><${Icon} name="split" size=${18} />Split into kick, snare, toms and cymbals</button>`}
      ${VOCAL.has(stem.id) && stem.id !== 'lead_dry' && !hasDry && html`<button class="btn" type="button" disabled=${busy} onClick=${() => refine('dereverb')}><${Icon} name="wand" size=${18} />Make a dry copy (remove room reverb)</button>`}
      ${stem.id === 'backing' && html`<button class="btn" style="white-space:normal" type="button" disabled=${busy} onClick=${() => refine('harmonies')}><${Icon} name="split" size=${18} />Separate overlapping harmonies</button>`}
      <a class="btn" href=${appUrl(`/media/${song.id}/${stem.id}.flac?v=${song.assetVersion || "original"}`)} download><${Icon} name="download" size=${18} />Download this stem (FLAC)</a>
    </div>
  </aside>`;
}

function ExportMenu({ onExport }) {
  const [open, setOpen] = useState(false);
  const ref = useRef();
  useClickOutside(ref, () => setOpen(false), open);
  return html`<span style="position: relative" ref=${ref}>
    <button class="btn" type="button" aria-expanded=${open} onClick=${() => setOpen(!open)}><${Icon} name="download" size=${18} />Export</button>
    ${open && html`<div class="menu" role="menu">
      <button role="menuitem" onClick=${() => { setOpen(false); onExport('mp3'); }}>This mix as MP3</button>
      <button role="menuitem" onClick=${() => { setOpen(false); onExport('wav'); }}>This mix as WAV</button>
      <span class="hint" style="padding: 6px 12px">Includes levels, pan, key and speed. Effects stay in the app.</span>
    </div>`}
  </span>`;
}

// ---------------------------------------------------------------- lyrics & duet

function evenWords(text, start, end) {
  const words = text.split(/\s+/).filter(Boolean);
  const total = words.reduce((a, w) => a + Math.max(1, w.length), 0) || 1;
  let t = start;
  return words.map((w) => {
    const d = ((end - start) * Math.max(1, w.length)) / total;
    const o = { t: w, s: +t.toFixed(3), e: +(t + d).toFixed(3) };
    t += d;
    return o;
  });
}

function LyricsPanel({ data, singers, setSingers, entryId, onLyrics, busy }) {
  const lyrics = data.lyrics || { lines: [] };
  const lines = lyrics.lines || [];
  const sections = data.sections || [];
  const n = singers.length;
  const parts = useMemo(() => resolveParts(lines, sections, n), [lines, sections, n]);
  const [now, setNow] = useState(-1);
  const [q, setQ] = useState(`${data.song.artist || ''} ${data.song.title || ''}`.trim());
  const [results, setResults] = useState(null);
  const [paste, setPaste] = useState('');

  useEffect(() => {
    const t = setInterval(() => {
      if (!engine.playing) return;
      const { idx, upcoming } = activeLine(lines, engine.time() - (lyrics.offset || 0));
      setNow(upcoming ? -1 : idx);
    }, 200);
    return () => clearInterval(t);
  }, [lines, lyrics.offset]);

  const setLines = (ls) => onLyrics({ ...lyrics, lines: ls });
  const cycle = (i) => {
    const order = [null, ...Array.from({ length: n }, (_, k) => k), 'all'];
    const cur = lines[i].singer ?? null;
    const nextVal = order[(order.indexOf(cur) + 1) % order.length];
    setLines(lines.map((l, k) => (k === i ? { ...l, singer: nextVal } : l)));
  };
  const preset = (kind) => {
    if (kind === 'clear') return setLines(lines.map((l) => ({ ...l, singer: null })));
    if (kind === 'verses') {
      const auto = resolveParts(lines.map((l) => ({ ...l, singer: null })), sections, n);
      return setLines(lines.map((l, k) => ({ ...l, singer: auto[k] })));
    }
    if (kind === 'lines') return setLines(lines.map((l, k) => ({ ...l, singer: k % n })));
    if (kind === 'all') return setLines(lines.map((l) => ({ ...l, singer: 'all' })));
  };
  const editText = (i, text) => {
    const l = lines[i];
    if (text.trim() === l.text) return;
    setLines(lines.map((x, k) => (k === i ? { ...x, text: text.trim(), words: evenWords(text, x.start, x.end) } : x)));
  };
  const search = async (e) => {
    e.preventDefault();
    try { setResults(await api.post(`/api/songs/${data.song.id}/lyrics/search`, { q })); } catch (err) { toast(err.message, true); }
  };
  const use = (body) => api.post(`/api/songs/${data.song.id}/lyrics/use`, body)
    .then(() => toast('Re-timing the lyrics. This takes a few seconds.')).catch((e) => toast(e.message, true));

  // Group lines by stanza for display.
  const groups = [];
  lines.forEach((l, i) => {
    const sec = sectionAt(sections, l.start + 0.05);
    const key = l.stanza ?? sec?.label;
    if (!groups.length || groups[groups.length - 1].key !== key) groups.push({ key, label: sec?.label, items: [] });
    groups[groups.length - 1].items.push(i);
  });

  return html`<div class="columns">
    <section class="card col-main" style="gap: 6px">
      <div class="section-head" style="margin-bottom: 8px">
        <h2 class="h2">Lyrics</h2>
        <span class="hint">${lines.length} lines · from ${lyrics.source === 'lrclib' ? 'LRCLIB' : lyrics.source === 'whisper' ? 'transcribing the vocal' : lyrics.source === 'user' ? 'your paste' : 'nowhere yet'}${lyrics.autoOffset ? ` · auto-shifted ${lyrics.autoOffset > 0 ? '+' : ''}${lyrics.autoOffset}s` : ''}</span>
      </div>
      ${!lines.length && html`<p class="muted">No lyrics yet. Search for them on the right, or paste your own.</p>`}
      <div class="lyric-editor">
        ${groups.map((g) => html`<div class="le-stanza">
          ${g.label && html`<span class="eyebrow" style=${{ padding: '0 8px 4px', color: g.label === 'Chorus' ? 'var(--amber)' : null }}>${g.label}</span>`}
          ${g.items.map((i) => {
            const l = lines[i];
            const p = parts[i];
            return html`<div class=${'le-line' + (i === now ? ' now' : '')}>
              <button class="le-time" type="button" aria-label=${`Play from ${fmtTime(l.start)}`} onClick=${() => { engine.seek(Math.max(0, l.start + (lyrics.offset || 0) - 1)); previewPlay().catch(e=>toast(e.message,true)); }}>${fmtTime(l.start)}</button>
              <input class="le-text" value=${l.text} aria-label=${`Line ${i + 1}`} onChange=${(e) => editText(i, e.target.value)} />
              ${n > 1 && html`<button type="button" class=${'part-btn' + (l.singer == null ? ' auto' : '')} style=${l.singer == null ? null : { color: partColor(p) }}
                aria-label=${`Who sings this line: ${partLabel(p, singers)}${l.singer == null ? ' (automatic)' : ''}. Change`} onClick=${() => cycle(i)}>
                ${l.singer == null ? `Auto · ${partLabel(p, singers)}` : partLabel(p, singers)}</button>`}
            </div>`;
          })}
        </div>`)}
      </div>
    </section>

    <aside class="col-side">
      <section class="card stack" style="gap: 14px">
        <span class="h2" style="font-size: 20px">Duet parts</span>
        <span class="hint">${entryId ? 'Singers come from the queue entry.' : 'Preview with placeholder names; the queue entry\'s names show on stage.'} Each singer gets their own lyric colour.</span>
        <div class="stack" style="gap: 8px">
          ${singers.map((s, i) => html`<label class="field sm" style=${{ borderColor: `color-mix(in srgb, ${partColor(i)} 60%, var(--line))` }}>
            <span class="dot" style=${{ background: partColor(i) }}></span>
            <input value=${s} aria-label=${`Singer ${i + 1} name`} onChange=${(e) => setSingers(singers.map((x, k) => (k === i ? e.target.value || `Singer ${k + 1}` : x)))} />
            ${singers.length > 1 && html`<button class="icon-btn ghost" type="button" style="width: 36px; height: 36px" aria-label=${`Remove ${s}`} onClick=${() => setSingers(singers.filter((_, k) => k !== i))}><${Icon} name="x" size=${16} /></button>`}
          </label>`)}
          ${singers.length < 3 && html`<button class="btn dashed sm" type="button" onClick=${() => setSingers([...singers, `Singer ${singers.length + 1}`])}><${Icon} name="plus" size=${16} />Add a singer</button>`}
        </div>
        ${n > 1 && html`<div class="stack" style="gap: 8px">
          <button class="btn sm" type="button" onClick=${() => preset('verses')}>Swap each verse, chorus together</button>
          <button class="btn sm" type="button" onClick=${() => preset('lines')}>Swap every line</button>
          <button class="btn sm" type="button" onClick=${() => preset('all')}>Everyone sings everything</button>
          <button class="btn ghost sm" type="button" onClick=${() => preset('clear')}>Back to automatic</button>
          <span class="hint">Tap the part next to any line to change who sings it.</span>
        </div>`}
      </section>

      <section class="card stack" style="gap: 12px">
        <span class="h2" style="font-size: 20px">Timing</span>
        <div class="kv"><span>Lyrics early / late</span>
          <${Stepper} label="lyrics offset" value=${lyrics.offset || 0} format=${(v) => `${v > 0 ? '+' : ''}${v.toFixed(1)}s`}
            onDown=${() => onLyrics({ ...lyrics, offset: +((lyrics.offset || 0) - 0.1).toFixed(1) })}
            onUp=${() => onLyrics({ ...lyrics, offset: +((lyrics.offset || 0) + 0.1).toFixed(1) })} /></div>
        <span class="hint">If words light up before they're sung, add time. If they're late, take some away.</span>
      </section>

      <section class="card stack" style="gap: 12px">
        <span class="h2" style="font-size: 20px">Wrong lyrics?</span>
        <form class="row" style="gap: 8px" onSubmit=${search}>
          <label class="field sm grow"><input value=${q} aria-label="Search lyrics" onInput=${(e) => setQ(e.target.value)} /></label>
          <button class="icon-btn" type="submit" aria-label="Search lyrics"><${Icon} name="search" /></button>
        </form>
        ${results && html`<div class="lrc-results">
          ${results.length === 0 && html`<span class="hint">No matches.</span>`}
          ${results.slice(0, 8).map((r) => html`<div class="lrc-result">
            <div class="stack grow" style="gap: 2px">
              <span class="ellipsis" style="font-weight: 600">${r.title}</span>
              <span class="hint ellipsis">${r.artist}${r.duration ? ` · ${fmtTime(r.duration)}` : ''} · ${r.synced ? 'timed' : 'text only'}${Math.abs((r.duration || 0) - data.song.duration) < 4 ? ' · same length' : ''}</span>
            </div>
            <button class="btn sm" type="button" disabled=${busy} onClick=${() => use({ lrclibId: r.id })}>Use</button>
          </div>`)}
        </div>`}
        <details>
          <summary style="cursor: pointer; font-size: 15px; min-height: 32px">Paste your own lyrics</summary>
          <div class="stack" style="gap: 8px; margin-top: 8px">
            <textarea class="input" placeholder="Plain lines, or LRC with [mm:ss.xx] timestamps" aria-label="Lyrics to use" value=${paste} onInput=${(e) => setPaste(e.target.value)}></textarea>
            <button class="btn sm" type="button" disabled=${!paste.trim() || busy}
              onClick=${() => use(/\[\d+:\d+/.test(paste) ? { lrc: paste } : { plain: paste })}>Use these lyrics</button>
          </div>
        </details>
        <button class="btn ghost sm" type="button" disabled=${busy} onClick=${() => use({ whisper: true })}><${Icon} name="mic" size=${16} />Transcribe from the vocal instead</button>
      </section>
    </aside>
  </div>`;
}

// ---------------------------------------------------------------- view

export function StudioView({ songId, entryId, initialMixId }) {
  const { room } = useRoom();
  const alive=useRef(true);
  const [data, setData] = useState(null);
  const [peaks, setPeaks] = useState({});
  const [mix, setMix] = useState({ stems: {} });
  const [sel, setSel] = useState(null);
  const [tab, setTab] = useState('mixer');
  const [loadPct, setLoadPct] = useState(0);
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [loop, setLoop] = useState(null);
  const [mixId, setMixId] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveForm, setSaveForm] = useState(null);
  const [newName, setNewName] = useState('');
  const selection = useRef('');
  const rememberMix = id => {
    if(!alive.current)return;
    const link=`#/studio/${songId}?mix=${id}${entryId ? `&entry=${entryId}` : ''}`;
    history.replaceState(null,'',link);
    try { localStorage.setItem('stemroom.studio', link); } catch {}
  };
  const draftKey = id => `stemroom.draft.${songId}.${id}`;
  const updateMix = next => {
    setMix(next); setDirty(true);
    try { localStorage.setItem(draftKey(selection.current), JSON.stringify(next)); } catch {}
  };
  const chooseMix = m => {
    if (!m) return;
    let settings=m.settings, restored=false;
    try { const saved=localStorage.getItem(draftKey(m.id)); if(saved){settings=JSON.parse(saved);restored=true;} } catch {}
    selection.current=m.id;setMixId(m.id);setMix({stems:{},...settings});setDirty(restored);
    rememberMix(m.id);
  };
  const [karaoke, setKaraoke] = useState(false);
  const [names, setNames] = useState(['Singer 1', 'Singer 2']);
  const [error, setError] = useState(null);
  const [, tick] = useState(0);
  const stemsKey = useRef('');

  const entry = entryId && room ? (room.current?.id === entryId ? room.current : room.queue.find((e) => e.id === entryId)) : null;
  const key = mix.performance?.key ?? 0;
  const tempo = mix.performance?.tempo ?? 1;
  const performance = {key,tempo,guide:0.15,backing:true,...mix.performance};
  const singers = entry?.singers?.length > 1 ? entry.singers : names;
  const job = room?.jobs?.[songId];

  const fetchAll = async () => {
    const [d, p] = await Promise.all([api.get(`/api/songs/${songId}`), api.get(`/api/songs/${songId}/peaks`)]);
    if(!alive.current)return d;
    setData(d);
    setPeaks(p);
    if (!selection.current) chooseMix(d.mixes.find(m=>m.id===(initialMixId || entry?.mixId)) || d.mixes.find(m=>m.id===d.defaultMixId) || d.mixes[0]);
    return d;
  };

  useEffect(() => {
    alive.current=true;
    fetchAll().catch((e) => setError(e.message));
    return () => { alive.current=false; engine.pause(); engine.unload(); stemsKey.current = ''; };
  }, [songId]);

  // (Re)load audio when the set of stems changes.
  useEffect(() => {
    if (!data || data.song.status !== 'ready') return;
    const stems = playableStems(data.song);
    const k = `${data.song.assetVersion || 'original'}:${stems.map((s) => s.id).join(',')}`;
    if (k === stemsKey.current) return;
    stemsKey.current = k;
    const at = engine.time();
    const was = engine.playing;
    setReady(false);
    engine.load(songId, stems, setLoadPct, data.song.assetVersion || 'original').then((ok) => {
      if (!ok) return;
      setReady(true);
      if (at) engine.seek(at);
      if (was) previewPlay().catch(e=>toast(e.message,true));
      if (!sel) setSel(stems.find((s) => VOCAL.has(s.id))?.id || stems[0]?.id);
    }).catch((e) => toast(e.message, true));
  }, [data]);

  useEffect(() => {
    if (!ready || !data) return;
    const e = karaoke ? performance : null;
    engine.applyMix(computeGains(data.song, mix, e, { karaoke }), mix.master ?? 1);
  }, [ready, data, mix, karaoke, entry?.guide, entry?.backing]);
  useEffect(() => { if (ready) engine.setPitch(key, room?.settings.naturalVoice ?? true); }, [ready, key]);
  useEffect(() => { if (ready && engine.rate !== tempo) engine.setRate(tempo); }, [ready, tempo]);
  useEffect(() => { if (ready) engine.setLoop(loop); }, [ready, loop]);

  useEffect(() => {
    const h = () => setPlaying(engine.playing);
    engine.addEventListener('state', h);
    const t = setInterval(() => tick((x) => x + 1), 250);
    return () => { engine.removeEventListener('state', h); clearInterval(t); };
  }, []);

  useBus('stage-play', () => engine.pause(), []);
  useBus('transport', m => {if(['play','toggle','restart'].includes(m.action) || (m.action==='preview' && m.clientId!==clientId))engine.pause();}, []);
  useBus('position', m => {if(m.status==='playing')engine.pause();}, []);
  useBus('library', () => fetchAll().catch(e=>toast(e.message,true)), [songId]);
  useBus('song', (m) => { if (m.songId === songId) fetchAll(); }, [songId]);

  // Opened while the song was still processing (or after it failed): reload once it changes.
  const liveStatus = room?.songs?.[songId]?.status;
  const liveTitle = room?.songs?.[songId]?.title;
  useEffect(() => {
    if (data && liveStatus && (liveStatus !== data.song.status || liveTitle !== data.song.title)) fetchAll();
  }, [liveStatus, liveTitle]);

  const selectedMix = data?.mixes?.find(m=>m.id===mixId);
  const saveNamedMix = async (name, create=false) => {
    setSaving(true);
    try {
      const body={name, settings:{...mix,performance}};
      const saved=create ? await api.post(`/api/songs/${songId}/mixes`,body) : await api.put(`/api/songs/${songId}/mixes/${mixId}`,body);
      try { localStorage.removeItem(draftKey(saved.id)); localStorage.removeItem(draftKey(mixId)); } catch {}
      rememberMix(saved.id);selection.current=saved.id;setMixId(saved.id);setMix({stems:{},...saved.settings});setDirty(false);setSaveForm(null);
      await fetchAll();toast(`Saved “${saved.name}”`);
      return saved;
    } catch(e) {toast(e.message,true);return null;} finally {setSaving(false);}
  };
  const changeStem = (id, patch) => {
    const stem=data.song.stems.find(s=>s.id===id);
    updateMix({...mix, stems:{...mix.stems,[id]:{...stemMix(stem,mix),...patch}}});
  };
  const setLyrics = l => {
    const shared={...l,lines:l.lines.map(({singer,...line})=>line)};
    updateMix({...mix,duet:l.lines.map(line=>line.singer ?? null)});
    setData(d=>({...d,lyrics:shared}));
    api.put(`/api/songs/${songId}/lyrics`,{lines:shared.lines,offset:shared.offset}).catch(e=>toast(e.message,true));
  };
  const resetMix = () => updateMix({stems:{},master:1,performance:{key:0,tempo:1,guide:0.15,backing:true},duet:[]});
  const setKeyV = k => updateMix({...mix,performance:{...performance,key:clamp(k,-7,7)}});
  const setTempoV = t => updateMix({...mix,performance:{...performance,tempo:clamp(+t.toFixed(2),0.6,1.4)}});
  const doExport = async (format) => {
    const gains = computeGains(data.song, mix, performance, { karaoke });
    const body = { format, key, tempo, mix: Object.fromEntries(Object.entries(gains).map(([id, g]) => [id, { gain: g.gain * (mix.master ?? 1), pan: g.pan, on: g.gain > 0 }])) };
    toast('Rendering your mix…');
    try {
      const r = await api.post(`/api/songs/${songId}/export`, body);
      const a = document.createElement('a');
      a.href = appUrl(r.url); a.download = '';
      document.body.appendChild(a); a.click(); a.remove();
    } catch (e) { toast(e.message, true); }
  };
  const toggleLoop = () => {
    if (loop) return setLoop(null);
    const s = sectionAt(data.sections, engine.time());
    if (s) setLoop([s.start, s.end]);
  };

  if (error) return html`<div class="page"><div class="page-inner"><p class="pill err">${error}</p></div></div>`;
  if (!data) return html`<div class="page"><div class="page-inner"><p class="muted">Loading…</p></div></div>`;

  const song = data.song;
  const stems = playableStems(song);
  const duration = song.duration || engine.duration || 1;
  const sm = (s) => {
    const m = stemMix(s,mix);
    return s.id === 'backing_harmony' && m.followLead !== false ? {...m,vol:leadVocalLevel(song,mix)} : m;
  };
  const anySolo = stems.some((s) => sm(s).solo);
  const selStem = stems.find((s) => s.id === sel) || stems[0];
  const t = engine.time();
  // Keep the chord lane readable: skip chord changes too close to the previous label.
  const chords = [];
  for (const c of data.analysis?.chords || []) {
    if (c.end - c.start < 1 || (chords.length && c.start - chords[chords.length - 1].start < duration / 30)) continue;
    chords.push(c);
  }

  if (song.status !== 'ready') {
    return html`<div class="page"><div class="page-inner">
      <section class="card lg stack" style="gap: 14px"><h1 class="display" style="margin: 0">${song.title}</h1>
      ${song.status === 'error' && !job
        ? html`<span class="pill err" style="white-space: normal">${song.error}</span>
            <div><button class="btn primary" type="button" onClick=${() => api.post(`/api/songs/${songId}/retry`).catch((e) => toast(e.message, true))}><${Icon} name="replay" size=${18} />Try again</button></div>`
        : html`<span class="muted">${job?.label || 'Getting ready'} · ${Math.round((job?.progress || 0) * 100)}%</span>
            <div class="bar"><div style=${{ width: `${(job?.progress || 0) * 100}%` }}></div></div>`}
      </section></div></div>`;
  }

  return html`<div class="page"><div class="page-inner">

    <section class="song-head">
      <div class="studio-art"><${Thumb} src=${song.thumbnail}/></div>
      <div class="stack" style="gap: 10px; min-width: 0">
        <h1>${song.title}</h1>
        <div class="row wrap" style="gap: 8px; font-size: 14px">
          <span class="muted">${song.artist}${entry ? ` · ${singersLabel(entry.singers)}'s turn` : ''}</span>
          ${data.analysis?.tempo && html`<span class="chip">${Math.round(data.analysis.tempo * tempo)} BPM</span>`}
          ${data.analysis?.key && html`<span class="chip">${keyName(data.analysis.key, key)}${key ? ` (from ${keyName(data.analysis.key)})` : ''}</span>`}
          <span class="chip">${fmtTime(duration)}</span>
          <span class="chip">${stems.length} stems</span>
        </div>
      </div>
      <div class="row wrap" style="gap: 10px">
        <${ExportMenu} onExport=${doExport} />
        <a class="btn primary" href="#/stage"><${Icon} name="play" size=${16} />Back to the stage</a>
      </div>
    </section>

    <section class="card mix-toolbar stack" aria-label="Saved mixes">
      <div class="row wrap" style="gap:10px"><label class="mix-picker grow"><span class="ctl-label">Saved mix</span><select class="input" value=${mixId} aria-label="Saved mix" onChange=${e=>chooseMix(data.mixes.find(m=>m.id===e.target.value))}>${data.mixes.map(m=>html`<option value=${m.id}>${m.name}${m.id===data.defaultMixId?' · default':''}${m.needsReview?' · review':''}</option>`)}</select></label>
        <button class="btn primary" disabled=${saving} onClick=${()=>saveNamedMix(selectedMix.name)}>Save</button>
        <button class="btn" disabled=${saving} onClick=${()=>{setNewName('');setSaveForm('new');}}>Save as new</button>
        <button class="btn" disabled=${saving} onClick=${()=>{setNewName(`${selectedMix.name} copy`);setSaveForm('duplicate');}}>Duplicate</button>
        <button class="btn" disabled=${saving||mixId===data.defaultMixId} onClick=${async()=>{try{await api.post(`/api/songs/${songId}/mixes/${mixId}/default`);await fetchAll();toast('Default mix updated');}catch(e){toast(e.message,true);}}}>Set as default</button>
      </div>
      <span class="hint">${dirty?'Unsaved changes · draft kept on this device':'Saved'} · Audio and artwork are shared by every mix. Saved changes affect future queue entries.</span>
      ${selectedMix?.needsReview && html`<span class="pill err">Source audio changed. Check stem levels, timing and duet parts, then Save to mark this mix reviewed.</span>`}
      ${room?.current?.songId===songId && html`<div class="row wrap" style="gap:10px"><span class="hint grow">On stage: ${room.current.mixName || 'Default'} · its settings are kept with this performance.</span><button class="btn sm" disabled=${saving||dirty} onClick=${async()=>{try{await api.post(`/api/queue/${room.current.id}/mix`,{mixId});toast('Mix applied to the current performance');}catch(e){toast(e.message,true);}}}>Apply to current performance</button></div>`}
      <div class="row wrap" style="gap:18px"><label class="row" style="gap:10px">Guide vocal <input aria-label="Saved guide vocal" type="range" min="0" max="100" value=${Math.round(performance.guide*100)} onInput=${e=>updateMix({...mix,performance:{...performance,guide:e.target.value/100}})}/><span class="mono">${Math.round(performance.guide*100)}%</span></label>
        <label class="row" style="gap:8px"><input type="checkbox" checked=${performance.backing!==false} onChange=${e=>updateMix({...mix,performance:{...performance,backing:e.target.checked}})}/>Backing vocals</label><span class="hint">Studio preview pauses Stage playback.</span></div>
      ${song.harmonyAnalysis && html`<div class="row wrap" style="gap:12px">
        <span class="pill soft">${song.harmonyAnalysis.regions.length} overlapping vocal passages · ${fmtTime(song.harmonyAnalysis.overlapSeconds)}</span>
        <label class="row" style="gap:8px"><input type="checkbox" aria-label="Harmonies follow lead" checked=${mix.stems?.backing_harmony?.followLead !== false}
          onChange=${e=>changeStem('backing_harmony',{followLead:e.target.checked,vol:leadVocalLevel(song,mix)})}/>Harmonies follow lead</label>
        <span class="hint">Other backing vocals keep their own level. Solo “Overlapping harmonies” to hear the split.</span>
      </div>`}
    </section>
    ${saveForm && html`<${Modal} title=${saveForm==='duplicate'?'Duplicate mix':'Save a new mix'} onClose=${()=>setSaveForm(null)}><form class="stack" onSubmit=${e=>{e.preventDefault();saveNamedMix(newName,true);}}><label class="stack">Mix name<input class="input" required maxLength="80" value=${newName} onInput=${e=>setNewName(e.target.value)}/></label><button class="btn primary" disabled=${saving||!newName.trim()}>Save mix</button></form></${Modal}>`}
    <div class="tabs" role="tablist">
      <button role="tab" aria-selected=${tab === 'mixer'} onClick=${() => setTab('mixer')}>Mixer</button>
      <button role="tab" aria-selected=${tab === 'lyrics'} onClick=${() => setTab('lyrics')}>Lyrics & duet</button>
    </div>
    ${job && html`<div class="card tight row" style="gap: 14px"><span class="grow">${job.label}…</span><div class="bar" style="width: 200px"><div style=${{ width: `${job.progress * 100}%` }}></div></div></div>`}

    ${tab === 'mixer' ? html`<div class="columns">
      <section class="mixer col-main" aria-label="Stem mixer" style="gap: 0">
        ${!ready && html`<div class="row" style="padding: 8px 12px 14px; gap: 12px"><span class="muted grow">Loading stems…</span><div class="bar" style="width: 200px"><div style=${{ width: `${loadPct * 100}%` }}></div></div></div>`}
        <div class="lanes">
          <div class="lane">
            <span class="lane-head eyebrow" style="color: var(--dim)">Sections</span>
            <div class="lane-body sec-lane">
              ${data.sections.map((s) => html`<button type="button" style=${{ flex: Math.max(0.5, s.end - s.start) }}
                class=${(s.label === 'Chorus' ? 'chorus' : '') + (loop && loop[0] === s.start ? ' looped' : '')}
                onClick=${() => { engine.seek(s.start); if (loop) setLoop([s.start, s.end]); }} title=${`${s.label} · ${fmtTime(s.start)}`}>${s.label}</button>`)}
            </div>
          </div>
          ${chords.length > 0 && html`<div class="lane">
            <span class="lane-head eyebrow" style="color: var(--dim)">Chords</span>
            <div class="lane-body chord-lane" aria-label="Chords">
              ${chords.map((c) => html`<span style=${{ left: `${(c.start / duration) * 100}%` }}>${transposeChord(c.name, key)}</span>`)}
            </div>
          </div>`}
          ${stems.map((s) => html`<${TrackRow} key=${s.id} stem=${s} m=${sm(s)} selected=${s.id === sel} peaks=${peaks[s.id]} duration=${duration}
            anySolo=${anySolo} onSelect=${() => setSel(s.id)} onChange=${(p) => changeStem(s.id, p)} />`)}
          <${Playhead} duration=${duration} loop=${loop} />
        </div>
      </section>
      <div class="col-side"><${Inspector} song=${song} stem=${selStem} m=${selStem ? sm(selStem) : null} busy=${!!job}
        onChange=${(p) => changeStem(selStem.id, p)} /></div>
    </div>` : html`<${LyricsPanel} data=${{...data,lyrics:{...data.lyrics,lines:(data.lyrics?.lines||[]).map((l,i)=>({...l,singer:mix.duet?.[i] ?? null}))}}} singers=${singers} setSingers=${setNames} entryId=${entry && entry.singers.length > 1 ? entryId : null} onLyrics=${setLyrics} busy=${!!job} />`}

    <section class="transport" aria-label="Transport">
      <button class="icon-btn play" type="button" disabled=${!ready} aria-label=${playing ? 'Pause' : 'Play'} onClick=${() => engine.playing ? engine.pause() : previewPlay().catch(e=>toast(e.message,true))}><${Icon} name=${playing ? 'pause' : 'play'} /></button>
      <span class="mono" style="font-size: 15px; color: var(--text-2)"><span style="color: var(--cream)">${fmtTime(t)}</span> / ${fmtTime(duration)}</span>
      <button class="btn" type="button" aria-pressed=${!!loop} onClick=${toggleLoop}><${Icon} name="loop" size=${18} />${loop ? 'Looping' : 'Loop section'}</button>
      <span class="divider"></span>
      <div class="row" style="gap: 8px"><span class="ctl-label">Key</span>
        <${Stepper} label="key" value=${key} format=${fmtKey} min=${-7} max=${7} onDown=${() => setKeyV(key - 1)} onUp=${() => setKeyV(key + 1)} /></div>
      <div class="row" style="gap: 8px"><span class="ctl-label">Speed</span>
        <${Stepper} label="speed" value=${Math.round(tempo * 100)} unitLabel="%" min=${60} max=${140} onDown=${() => setTempoV(tempo - 0.05)} onUp=${() => setTempoV(tempo + 0.05)} /></div>
      <div class="row" style="gap: 10px"><label for="k-prev" style="font-size: 14px">Karaoke preview</label><${Switch} id="k-prev" checked=${karaoke} onChange=${setKaraoke} /></div>
      <div class="row" style="gap: 8px; width: 160px; margin-left: auto"><label class="ctl-label" for="master">Master</label>
        <input id="master" type="range" min="0" max="150" value=${Math.round((mix.master ?? 1) * 100)}
          onInput=${(e) => { const m = { ...mix, master: e.target.value / 100 }; updateMix(m); }} /></div>
      <button class="btn ghost sm" type="button" onClick=${resetMix}>Reset mix</button>
    </section>
  </div></div>`;
}

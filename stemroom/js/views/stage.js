// The big screen: plays the current song and shows the lyrics. Every other device is a remote.
import { html, useState, useEffect, useRef, useMemo, fmtTime, fmtKey, singersLabel, clamp, SINGER_COLORS } from '../lib.js';
import { api, useRoom, useBus, send, toast, clientId, bus } from '../api.js';
import { Engine, computeGains, playableStems } from '../engine.js';
import { LyricsView, activeLine } from '../lyrics.js';
import { Icon, Stepper, QR, Avatar, Thumb } from '../ui.js';

const engine = new Engine();

function Names({ singers }) {
  return html`${singers.map((n, i) => html`${i > 0 && html`<span style="color: var(--text-2)">${i === singers.length - 1 ? ' & ' : ', '}</span>`}<span style=${{ color: singers.length > 1 ? SINGER_COLORS[i] : 'var(--cream)' }}>${n}</span>`)}`;
}

function Splash({ room, entry, song, phase, loadPct, countdown, onStart }) {
  const [info, setInfo] = useState(null);
  useEffect(() => { if (!entry) api.get('/api/info').then(setInfo).catch(() => {}); }, [entry]);
  if (!entry) {
    return html`<div class="stage-splash">
      <span class="eyebrow amber">The stage is free</span>
      <span class="big">Who's next?</span>
      <span class="song">Scan to add a song from your phone</span>
      ${info && html`<${QR} text=${info.joinUrl} size=${220} label="QR code to add songs" />`}
      ${info && html`<span class="mono muted">${info.joinUrl}</span>`}
    </div>`;
  }
  const job = room.jobs?.[entry.songId];
  let status;
  if (song?.status === 'error' && !job) {
    status = html`<div class="stack" style="gap: 14px; align-items: center">
      <span class="pill err" style="white-space: normal; max-width: 640px">Couldn't prepare this song: ${song.error}</span>
      <div class="row" style="gap: 10px">
        <button class="btn primary" type="button" onClick=${() => api.post(`/api/songs/${entry.songId}/retry`)}><${Icon} name="replay" size=${18} />Try again</button>
        <button class="btn" type="button" onClick=${() => api.post('/api/transport', { action: 'next' })}>Skip to next singer</button>
      </div></div>`;
  }
  else if (phase === 'preparing') {
    const pct = Math.round((job?.progress || 0) * 100);
    status = html`<div class="stack" style="gap: 10px; width: min(520px, 80vw)">
      <div class="bar"><div style=${{ width: `${pct}%` }}></div></div>
      <span class="muted">${job?.label || 'Getting it ready'} · ${pct}%</span></div>`;
  } else if (phase === 'loading') {
    status = html`<div class="stack" style="gap: 10px; width: min(520px, 80vw)">
      <div class="bar"><div style=${{ width: `${Math.round(loadPct * 100)}%` }}></div></div>
      <span class="muted">Loading the stems…</span></div>`;
  } else {
    status = html`<div class="stack" style="gap: 16px; align-items: center">
      ${countdown != null && html`<span class="count">Starting in ${countdown}…</span>`}
      <button class="btn primary lg" type="button" onClick=${onStart}><${Icon} name="play" size=${18} />Start singing</button>
    </div>`;
  }
  return html`<div class="stage-splash">
    <${Thumb} src=${song?.thumbnail}/><span class="eyebrow amber">Up next</span>
    <span class="big"><${Names} singers=${entry.singers} /></span>
    <span class="song">${song?.title || '…'}${song?.artist ? html` <span class="dim">· ${song.artist}</span>` : ''}</span>
    ${status}
  </div>`;
}

export function StageView({ active }) {
  const { room } = useRoom();
  const entry = room?.current || null;
  const [unlocked, setUnlocked] = useState(false);
  const ownsPlayer = room?.playerId === clientId;
  const [loadError, setLoadError] = useState('');
  const [data, setData] = useState(null);          // {song, lyrics, sections, mix, analysis}
  const [phase, setPhase] = useState('idle');       // idle | preparing | loading | ready | playing | paused
  const [loadPct, setLoadPct] = useState(0);
  const [countdown, setCountdown] = useState(null);
  const [idle, setIdle] = useState(false);
  const [, tick] = useState(0);
  const loadedFor = useRef(null);
  const previewHold = useRef(false);
  const entryRef = useRef(entry);
  entryRef.current = entry;
  const song = room?.songs?.[entry?.songId];

  // Load the current entry's song once it's ready.
  useEffect(() => {
    if (!entry) { engine.unload(); loadedFor.current = null; setData(null); setPhase('idle'); return; }
    if (loadedFor.current === entry.id) return;
    if (song?.status !== 'ready') { engine.unload(); setData(null); setPhase('preparing'); return; }
    if (!unlocked || !ownsPlayer) return;
    loadedFor.current = entry.id;
    let cancelled = false;
    (async () => {
      setLoadError('');
      setPhase('loading');
      setLoadPct(0);
      try {
        const d = await api.get(`/api/songs/${entry.songId}?version=${entry.assetVersion || "original"}`);
        if (cancelled) return;
        setData(d);
        const ok = await engine.load(entry.songId, playableStems(d.song), setLoadPct, entry.assetVersion || "original");
        if (!ok || cancelled) return;
        setPhase('ready');
        send({ type: 'position', entryId: entry.id, t: 0, duration: engine.duration, status: 'ready', rate: entry.tempo });
      } catch (e) {
        toast(e.message, true);
        loadedFor.current = null;
        setLoadError(e.message);
        setPhase('error');
      }
    })();
    return () => { cancelled = true; };
  }, [entry?.id, song?.status, unlocked, ownsPlayer]);

  // This component stays mounted across routes. Only the designated screen owns audio.
  useEffect(() => {
    if (!ownsPlayer && unlocked) { engine.pause(); engine.unload(); loadedFor.current=null; setUnlocked(false); }
  }, [ownsPlayer, unlocked]);
  useBus('player-disconnected', () => {engine.pause();engine.unload();loadedFor.current=null;setUnlocked(false);}, []);
  useBus('studio-preview', () => { previewHold.current=true; if (engine.playing || phase === 'ready') { engine.pause(); setPhase('paused'); report('paused'); } }, [phase]);

  // Release audio only when the app itself unmounts.
  useEffect(() => () => {
    engine.pause();
    engine.unload();
    const e = entryRef.current;
    if (e) send({ type: 'position', entryId: e.id, t: 0, duration: 0, status: 'stopped', rate: 1 });
  }, []);

  // Live settings: mix, guide vocal, key, speed.
  useEffect(() => {
    if (!data || !entry || phase === 'loading') return;
    engine.applyMix(computeGains(data.song, entry.mixSnapshot || data.mix, entry), entry.mixSnapshot?.master ?? 1);
    engine.setPitch(entry.key, room.settings.naturalVoice);
    if (engine.rate !== entry.tempo) engine.setRate(entry.tempo);
  }, [data, entry?.guide, entry?.key, entry?.tempo, entry?.backing, room?.settings.naturalVoice, entry?.mixSnapshot, phase]);

  // Intermission countdown.
  useEffect(() => {
    if (previewHold.current || !ownsPlayer || phase !== 'ready' || !room.settings.autoAdvance) { setCountdown(null); return; }
    let n = room.settings.countdown;
    setCountdown(n);
    const t = setInterval(() => {
      n -= 1;
      if (n <= 0) { clearInterval(t); setCountdown(null); start(); } else setCountdown(n);
    }, 1000);
    return () => clearInterval(t);
  }, [phase, entry?.id, ownsPlayer, room?.settings.autoAdvance, room?.settings.countdown]);

  const report = (status) => {
    const e = entryRef.current;
    if (!e || !ownsPlayer) return;
    send({ type: 'position', entryId: e.id, t: engine.time(), duration: engine.duration, status, rate: engine.rate });
  };

  const start = async () => {
    if (!ownsPlayer || !engine.node) return;
    previewHold.current=false;
    bus.dispatchEvent(new CustomEvent('stage-play'));
    setCountdown(null);
    engine.seek(0);
    await engine.play();
    setPhase('playing');
    report('playing');
  };
  const toggle = async () => {
    if (!ownsPlayer) return;
    if (phase === 'ready') return start();
    if (engine.playing) { engine.pause(); setPhase('paused'); report('paused'); }
    else if (engine.node) { bus.dispatchEvent(new CustomEvent('stage-play')); await engine.play(); setPhase('playing'); report('playing'); }
  };
  const replayLine = () => {
    const lines = data?.lyrics?.lines || [];
    const t = engine.time() - (data?.lyrics?.offset || 0);
    const { idx } = activeLine(lines, t);
    const target = lines[Math.max(0, (lines[idx]?.start > t ? idx - 1 : idx))];
    engine.seek(target ? Math.max(0, target.start - 1.2) : Math.max(0, engine.time() - 5));
    report(engine.playing ? 'playing' : 'paused');
  };

  // Position reports + end-of-song detection.
  useEffect(() => {
    const t = setInterval(() => {
      if (phase === 'playing' || phase === 'paused') report(phase);
      tick((x) => x + 1);
    }, 1000);
    let raf;
    const watch = () => {
      raf = requestAnimationFrame(watch);
      if (engine.playing && engine.duration && engine.time() >= engine.duration - 0.12) {
        engine.pause();
        setPhase('ready');
        const e = entryRef.current;
        send({ type: 'ended', entryId: e?.id });
      }
    };
    watch();
    return () => { clearInterval(t); cancelAnimationFrame(raf); };
  }, [phase]);

  // Remote control from other devices.
  useBus('transport', (m) => {
    if (!ownsPlayer) return;
    if (m.action === 'preview') { previewHold.current=true; engine.pause();setPhase(engine.node ? 'paused' : phase);report('paused');return; }
    if (m.action === 'toggle') toggle();
    else if (m.action === 'play' && !engine.playing) toggle();
    else if (m.action === 'pause' && engine.playing) toggle();
    else if (m.action === 'seek') { engine.seek(m.t); report(engine.playing ? 'playing' : 'paused'); }
    else if (m.action === 'restart') { engine.seek(0); report(engine.playing ? 'playing' : 'paused'); }
    else if (m.action === 'replayLine') replayLine();
  }, [phase, data, ownsPlayer]);
  useBus('lyrics', (m) => { if (data && m.songId === data.song.id) setData({ ...data, lyrics: m.lyrics }); }, [data]);
  useBus('song', (m) => {
    if (data && m.songId === data.song.id) api.get(`/api/songs/${m.songId}?version=${entry?.assetVersion || 'original'}`).then((d) => setData({ ...d, song: data.song }));
  }, [data]);

  // Hide chrome while singing; any mouse movement brings it back.
  useEffect(() => {
    let t;
    const wake = () => { setIdle(false); clearTimeout(t); t = setTimeout(() => setIdle(true), 4000); };
    wake();
    addEventListener('pointermove', wake);
    addEventListener('keydown', wake);
    return () => { clearTimeout(t); removeEventListener('pointermove', wake); removeEventListener('keydown', wake); };
  }, []);

  useEffect(() => {
    const k = (e) => {
      if (!active || !ownsPlayer) return;
      if (e.target.closest('input, select, textarea, button, a, dialog, [role="dialog"]')) return;
      if (e.code === 'Space') { e.preventDefault(); toggle(); }
      else if (e.key === 'ArrowLeft') engine.seek(engine.time() - 5);
      else if (e.key === 'ArrowRight') engine.seek(engine.time() + 5);
      else if (e.key === 'f') fullscreen();
    };
    addEventListener('keydown', k);
    return () => removeEventListener('keydown', k);
  }, [phase, data, active, ownsPlayer]);

  const fullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen?.();
  };

  if (!room) return html`<div class="stage"><p class="muted">Connecting…</p></div>`;

  const patch = (b) => entry && api.patch(`/api/queue/${entry.id}`, b).catch((e) => toast(e.message, true));
  const singing = ownsPlayer && (phase === 'playing' || phase === 'paused');
  const stageLyrics = data && { ...data.lyrics, lines: (data.lyrics?.lines || []).map((l,i)=>({...l,singer:entry?.mixSnapshot?.duet?.[i] ?? null})) };
  const hide = idle && phase === 'playing';
  const next = room.queue[0];
  const nextSong = next && room.songs[next.songId];
  const t = engine.time();
  const dur = engine.duration || song?.duration || 0;
  const sections = data?.sections || [];
  const hasBacking = data?.song?.stems?.some((s) => s.id === 'backing');

  return html`<div class=${'stage' + (hide ? ' hide-cursor' : '')}>
    <div class=${'stage-top' + (hide ? ' idle-hide' : '')}>
      <div class="row" style="gap: 8px">
        <a class="btn outline" href="#/"><${Icon} name="back" size=${18} />Queue</a>
        <button class="icon-btn" type="button" aria-label="Full screen" title="Full screen (F)" onClick=${fullscreen}><${Icon} name="full" /></button>
      </div>
      ${singing && entry && html`<div class="stage-title">
        <span class="who"><${Names} singers=${entry.singers} /> ${entry.singers.length > 1 ? 'are' : 'is'} singing</span>
        <span class="song">${song?.title} <span class="muted" style="font-weight: 500">· ${song?.artist}</span></span>
      </div>`}
      ${next ? html`<div class="next-card">
        <${Avatar} name=${next.singers[0]} lg />
        <div class="stack" style="gap: 2px; min-width: 0">
          <span class="eyebrow">Up next · ${singersLabel(next.singers)}</span>
          <span class="ellipsis" style="font-weight: 600; font-size: 16px">${nextSong?.title || '…'}</span>
        </div>
      </div>` : html`<span></span>`}
    </div>

    ${singing && data ? html`<${LyricsView} lyrics=${stageLyrics} sections=${sections} singers=${entry.singers} getTime=${() => engine.time()} getRate=${() => engine.rate} playing=${phase === 'playing'} />`
      : html`<${Splash} room=${room} entry=${entry} song=${song} phase=${phase} loadPct=${loadPct} countdown=${countdown} onStart=${start} />`}

    ${entry && (singing || phase === 'ready') && html`<div class=${'stage-bottom' + (hide ? ' idle-hide' : '')}>
      ${singing && html`<section aria-label="Song progress" class="stack" style="gap: 8px">
        ${sections.length > 1 && html`<div class="progress-sections">
          ${sections.map((s) => html`<button type="button" style=${{ flex: Math.max(0.5, s.end - s.start) }}
            class=${t >= s.end ? 'past' : t >= s.start ? 'now' : ''} onClick=${() => engine.seek(s.start)}
            aria-label=${`Jump to ${s.label}`}>${s.label}</button>`)}
        </div>`}
        <div class="progress-track" onClick=${(e) => { const r = e.currentTarget.getBoundingClientRect(); engine.seek(((e.clientX - r.left) / r.width) * dur); }}>
          <div style=${{ width: `${(t / (dur || 1)) * 100}%` }}></div><i style=${{ left: `${(t / (dur || 1)) * 100}%` }}></i>
        </div>
        <div class="times"><span>${fmtTime(t)}</span><span>${fmtTime(dur)}</span></div>
      </section>`}
      <section class="dock" aria-label="Singer controls">
        <button class="icon-btn play lg" type="button" aria-label=${phase === 'playing' ? 'Pause' : 'Play'} onClick=${toggle}>
          <${Icon} name=${phase === 'playing' ? 'pause' : 'play'} size=${22} /></button>
        <button class="icon-btn" type="button" aria-label="Replay the last line" onClick=${replayLine} disabled=${!singing}><${Icon} name="replay" /></button>
        <span class="divider"></span>
        <div class="ctl" style="width: 220px">
          <div class="kv"><label class="ctl-label" for="st-guide">Guide vocal</label>
            <span class="mono" style="font-size: 13px; color: var(--amber)">${entry.guide === 0 ? 'Off' : `${Math.round(entry.guide * 100)}%`}</span></div>
          <input id="st-guide" type="range" min="0" max="100" value=${Math.round(entry.guide * 100)}
            onInput=${(e) => engine.applyMix(computeGains(data.song, entry.mixSnapshot || data.mix, { ...entry, guide: e.target.value / 100 }), entry.mixSnapshot?.master ?? 1)}
            onChange=${(e) => patch({ guide: e.target.value / 100 })} />
        </div>
        <div class="ctl center"><span class="ctl-label">Key</span>
          <${Stepper} label="key" value=${entry.key} format=${fmtKey} min=${-7} max=${7}
            onDown=${() => patch({ key: entry.key - 1 })} onUp=${() => patch({ key: entry.key + 1 })} /></div>
        <div class="ctl center"><span class="ctl-label">Speed</span>
          <${Stepper} label="speed" value=${Math.round(entry.tempo * 100)} unitLabel="%" min=${60} max=${140}
            onDown=${() => patch({ tempo: clamp(+(entry.tempo - 0.05).toFixed(2), 0.6, 1.4) })}
            onUp=${() => patch({ tempo: clamp(+(entry.tempo + 0.05).toFixed(2), 0.6, 1.4) })} /></div>
        ${hasBacking && html`<button class="btn" type="button" aria-pressed=${entry.backing !== false} onClick=${() => patch({ backing: entry.backing === false })}>
          <${Icon} name="users" size=${18} />Backing vocals ${entry.backing === false ? 'off' : 'on'}</button>`}
        <span class="divider"></span>
        <a class="btn ghost" href=${`#/studio/${entry.songId}?entry=${entry.id}`}><${Icon} name="sliders" size=${18} />Studio</a>
        <button class="btn" type="button" onClick=${() => api.post('/api/transport', { action: 'next' })}>Next singer<${Icon} name="next" size=${18} /></button>
      </section>
    </div>`}

    ${loadError && unlocked && html`<div class="stage-error card"><p>${loadError}</p><button class="btn" onClick=${()=>{setUnlocked(false);loadedFor.current=null;}}>Retry loading audio</button></div>`}
    ${!unlocked && html`<button class="unlock" type="button" onClick=${async () => {
      try { await engine.resume(); await api.post('/api/player/claim',{clientId,takeover:!!room.playerId});setUnlocked(true); }
      catch(e) { toast(e.message,true); }
    }}>
      <span class="stack" style="gap: 14px; align-items: center">
        <span class="icon-btn play lg" aria-hidden="true"><${Icon} name="play" size=${24} /></span>
        <span class="display" style="font-size: 34px; font-weight: 700">${room.playerId && !ownsPlayer ? "Play on this screen" : "Tap to open the stage"}</span>
        <span class="muted">${room.playerId && !ownsPlayer ? 'This moves playback here from the other screen.' : 'Sound continues when you switch between Queue, Stage and Studio. Press F for full screen.'}</span>
      </span>
    </button>`}
  </div>`;
}

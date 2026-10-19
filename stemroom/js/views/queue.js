import { LibraryView } from '../library.js';
// Host home: add songs, watch them get ready, run the queue, remote-control the stage.
import { html, useState, useEffect, useRef, fmtTime, fmtKey, singersLabel, clamp } from '../lib.js';
import { api, useRoom, toast, livePosition } from '../api.js';
import { Icon, TopBar, Avatars, Switch, Stepper, QR, Thumb, useClickOutside } from '../ui.js';
import { AddSong, uploadFile } from './add.js';

const songOf = (room, e) => room?.songs?.[e?.songId] || {};

function StatusCell({ song, job }) {
  if (job) {
    const pct = Math.round((job.progress || 0) * 100);
    return html`<span class="stack" style="gap: 6px; width: 140px">
      <span style="font-size: 13px" class="muted ellipsis">${job.state === 'queued' ? 'Waiting…' : `${pct}%`}</span>
      <span class="bar thin"><div style=${{ width: `${pct}%` }}></div></span>
    </span>`;
  }
  if (song.status === 'error') return html`<span class="pill err">Failed</span>`;
  if (song.status === 'ready') return html`<span class="pill ok"><${Icon} name="check" size=${16} stroke=${2.5} />Ready</span>`;
  return html`<span class="muted" style="font-size: 13px">Preparing…</span>`;
}

function SingersEditor({ entry, onDone }) {
  const [v, setV] = useState(entry.singers.join(' & '));
  const save = async (e) => {
    e?.preventDefault();
    await api.patch(`/api/queue/${entry.id}`, { singers: v.split(/\s*(?:,|&)\s*/).filter(Boolean) });
    onDone();
  };
  return html`<form class="row" style="gap: 6px" onSubmit=${save}>
    <input class="input" style="width: 170px" aria-label="Singers" value=${v} onInput=${(e) => setV(e.target.value)} autoFocus onBlur=${save} />
  </form>`;
}

function RowMenu({ entry, song, onClose, onEditSingers }) {
  const ref = useRef();
  useClickOutside(ref, onClose, true);
  const act = async (fn) => { onClose(); try { await fn(); } catch (e) { toast(e.message, true); } };
  return html`<div class="menu" ref=${ref} role="menu">
    <button role="menuitem" onClick=${() => act(() => api.post(`/api/queue/${entry.id}/now`))}><${Icon} name="play" size=${16} />Sing this now</button>
    <button role="menuitem" onClick=${() => act(() => api.post('/api/queue/reorder', { order: [entry.id] }))}><${Icon} name="up" size=${18} />Move to the top</button>
    <button role="menuitem" onClick=${() => { onClose(); onEditSingers(); }}><${Icon} name="users" size=${18} />Change singers</button>
    ${song.status === 'ready' && html`<a role="menuitem" href=${`#/studio/${entry.songId}?entry=${entry.id}`}><${Icon} name="sliders" size=${18} />Open in Studio</a>`}
    ${song.status === 'error' && html`<button role="menuitem" onClick=${() => act(() => api.post(`/api/songs/${entry.songId}/retry`))}><${Icon} name="replay" size=${18} />Try again</button>`}
    <button role="menuitem" class="danger" onClick=${() => act(() => api.del(`/api/queue/${entry.id}`))}><${Icon} name="trash" size=${18} />Remove from queue</button>
  </div>`;
}

function QueueRow({ entry, index, room, drag }) {
  const song = songOf(room, entry);
  const job = room.jobs?.[entry.songId];
  const [menu, setMenu] = useState(false);
  const [editing, setEditing] = useState(false);
  const setKey = (k) => api.patch(`/api/queue/${entry.id}`, { key: clamp(k, -7, 7) });
  return html`<li class=${'qrow' + (drag.dragId === entry.id ? ' dragging' : '') + (drag.overId === entry.id && drag.dragId !== entry.id ? ' drop-above' : '')}
      draggable="true"
      onDragStart=${(e) => { e.dataTransfer.effectAllowed = 'move'; drag.start(entry.id); }}
      onDragOver=${(e) => { e.preventDefault(); drag.over(entry.id); }}
      onDrop=${(e) => { e.preventDefault(); drag.drop(entry.id); }}
      onDragEnd=${drag.end}>
    <span class="grip" aria-hidden="true"><${Icon} name="grip" size=${18} /></span>
    <span class="num">${index + 1}</span>
    <${Thumb} src=${song.thumbnail} sm />
    <div class="grow stack" style="gap: 2px; flex: 1 1 200px">
      <span class="title ellipsis">${song.title || 'Loading…'}</span>
      <span class="sub ellipsis">${song.artist || ''}${entry.mixName ? ` · ${entry.mixName}` : ''}${song.status === 'error' ? ` · ${song.error}` : ''}</span>
    </div>
    ${editing ? html`<${SingersEditor} entry=${entry} onDone=${() => setEditing(false)} />`
      : html`<button class="who-chip" type="button" onClick=${() => setEditing(true)} aria-label=${`Singers: ${singersLabel(entry.singers)}. Change`}>
          <${Avatars} names=${entry.singers} duetColors />${singersLabel(entry.singers)}</button>`}
    <span class="row" style="gap: 4px" role="group" aria-label="Key for this singer">
      <button class="icon-btn ghost" type="button" aria-label="Lower key" onClick=${() => setKey(entry.key - 1)}><${Icon} name="minus" size=${16} /></button>
      <span class="chip" style="min-width: 64px; justify-content: center">Key ${fmtKey(entry.key)}</span>
      <button class="icon-btn ghost" type="button" aria-label="Raise key" onClick=${() => setKey(entry.key + 1)}><${Icon} name="plus" size=${16} /></button>
    </span>
    <span class="status"><${StatusCell} song=${song} job=${job} /></span>
    <span style="position: relative">
      <button class="icon-btn ghost" type="button" aria-label=${`More options for ${song.title || 'this song'}`} aria-expanded=${menu} onClick=${() => setMenu(!menu)}><${Icon} name="more" /></button>
      ${menu && html`<${RowMenu} entry=${entry} song=${song} onClose=${() => setMenu(false)} onEditSingers=${() => setEditing(true)} />`}
    </span>
  </li>`;
}

function useDragOrder(queue) {
  const [dragId, setDragId] = useState(null);
  const [overId, setOverId] = useState(null);
  return {
    dragId, overId,
    start: setDragId,
    over: setOverId,
    end: () => { setDragId(null); setOverId(null); },
    drop: (targetId) => {
      if (!dragId || dragId === targetId) return;
      const ids = queue.map((e) => e.id).filter((id) => id !== dragId);
      ids.splice(ids.indexOf(targetId), 0, dragId);
      api.post('/api/queue/reorder', { order: ids });
      setDragId(null); setOverId(null);
    },
  };
}

function Preparing({ room }) {
  const items = Object.entries(room.jobs || {}).filter(([, j]) => j.task === 'process');
  if (!items.length) return null;
  return html`${items.map(([sid, job]) => {
    const s = room.songs?.[sid] || {};
    const who = [...room.queue, room.current].find((e) => e?.songId === sid);
    const pct = Math.round(job.progress * 100);
    return html`<section class="card tight row wrap" style="gap: 16px 22px" aria-label="Song being prepared">
      <${Thumb} src=${s.thumbnail} />
      <div class="stack grow" style="gap: 3px; flex: 1 1 220px">
        <span class="eyebrow amber">${job.state === 'queued' ? 'In line to be prepared' : 'Getting ready'}</span>
        <span class="display ellipsis" style="font-size: 22px; font-weight: 700">${s.title || 'Fetching song info…'}</span>
        <span class="muted ellipsis" style="font-size: 14px">${s.artist || ''}${who ? ` · for ${singersLabel(who.singers)}` : ''}</span>
      </div>
      <div class="stack" style="gap: 8px; flex: 1 1 100%">
        <div class="bar"><div style=${{ width: `${pct}%` }}></div></div>
        <span class="muted" style="font-size: 13px">${job.label} · ${pct}%</span>
      </div>
    </section>`;
  })}`;
}

function StageCard({ room }) {
  const e = room.current;
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 500); return () => clearInterval(t); }, []);
  if (!e) {
    return html`<section class="cta">
      <span class="eyebrow">The stage is free</span>
      <span class="big">Add a song to start</span>
      <span>Paste a YouTube link, search, or drop in a file. The first song goes straight on stage.</span>
    </section>`;
  }
  const s = songOf(room, e);
  const st = room.stage || {};
  // The stage reports every second; anything older means no stage is open right now.
  const live = st.entryId === e.id && (st.status === 'playing' || st.status === 'paused') && Date.now() / 1000 - st.at < 5;
  const pos = livePosition(st);
  const patch = (b) => api.patch(`/api/queue/${e.id}`, b);
  return html`<section class="cta" aria-label="On stage">
    <span class="eyebrow">${live ? (st.status === 'playing' ? 'Singing now' : 'Paused') : 'Ready when you are'}</span>
    <div class="stack" style="gap: 4px">
      <span class="big">${singersLabel(e.singers)} ${e.singers.length > 1 ? 'are' : 'is'} up</span>
      <span style="font-size: 16px">${s.title || '…'}${s.artist ? ` · ${s.artist}` : ''}</span>
    </div>
    ${live ? html`
      <div class="stack" style="gap: 6px">
        <div class="bar"><div style=${{ width: `${(pos / (st.duration || 1)) * 100}%`, transition: 'none' }}></div></div>
        <div class="row mono" style="justify-content: space-between; font-size: 13px"><span>${fmtTime(pos)}</span><span>${fmtTime(st.duration)}</span></div>
      </div>
      <div class="row" style="gap: 10px">
        <button class="icon-btn play" style="background: var(--maroon); color: var(--cream)" type="button" aria-label=${st.status === 'playing' ? 'Pause' : 'Play'}
          onClick=${() => api.post('/api/transport', { action: 'toggle' })}><${Icon} name=${st.status === 'playing' ? 'pause' : 'play'} /></button>
        <button class="icon-btn" type="button" aria-label="Replay the last line" onClick=${() => api.post('/api/transport', { action: 'replayLine' })}><${Icon} name="replay" /></button>
        <button class="btn line grow" type="button" onClick=${() => api.post('/api/transport', { action: 'next' })}>Next singer<${Icon} name="next" size=${18} /></button>
      </div>
      <div class="stack" style="gap: 4px">
        <div class="kv"><label for="cta-guide">Guide vocal</label><span class="mono" style="font-size: 13px">${Math.round(e.guide * 100)}%</span></div>
        <input id="cta-guide" type="range" min="0" max="100" value=${Math.round(e.guide * 100)} onChange=${(ev) => patch({ guide: ev.target.value / 100 })} />
      </div>
      <div class="kv"><span>Key</span><${Stepper} label="key" value=${e.key} format=${fmtKey} min=${-7} max=${7} onDown=${() => patch({ key: e.key - 1 })} onUp=${() => patch({ key: e.key + 1 })} /></div>
    ` : html`
      <a class="btn dark lg" href="#/stage"><${Icon} name="play" size=${18} />${s.status === 'ready' ? 'Start the show' : 'Open the stage'}</a>
    `}
    <${TvHelp} />
  </section>`;
}

function TvHelp() {
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState(null);
  useEffect(() => { if (open && !info) api.get('/api/info').then(setInfo); }, [open]);
  return html`<button class="btn line" type="button" aria-expanded=${open} onClick=${() => setOpen(!open)}><${Icon} name="tv" size=${18} />Put the stage on the TV</button>
    ${open && html`<div style="font-size: 15px; line-height: 1.5">
      Open <strong class="mono">${info ? `${info.lanUrl}/#/stage` : '…'}</strong> in the TV's browser, or plug this laptop into the TV and open the Stage in a full-screen window.
      Choose Play on this screen to designate the playback device. Other screens act as remotes.
    </div>`}`;
}

function GuestsCard() {
  const [info, setInfo] = useState(null);
  useEffect(() => { api.get('/api/info').then(setInfo).catch(() => {}); }, []);
  return html`<section class="card row wrap" style="gap: 18px; padding: 20px">
    ${info && html`<${QR} text=${info.joinUrl} size=${130} label="QR code to join the party from a phone" />`}
    <div class="stack grow" style="gap: 6px; flex: 1 1 150px">
      <span class="h2" style="font-size: 20px">Guests add songs</span>
      <span class="hint">Scan with a phone on the same Wi-Fi to add songs from anywhere in the room.</span>
      ${info && html`<span class="mono" style="font-size: 13px; color: var(--text-2); word-break: break-all">${info.joinUrl}</span>`}
    </div>
  </section>`;
}

function SettingsCard({ settings }) {
  const set = (b) => api.put('/api/settings', b).catch((e) => toast(e.message, true));
  return html`<section class="card stack" style="gap: 14px">
    <span class="h2" style="font-size: 20px">Party settings</span>
    <div class="setting"><label for="s-auto">Start the next singer automatically</label>
      <${Switch} id="s-auto" checked=${settings.autoAdvance} onChange=${(v) => set({ autoAdvance: v })} /></div>
    <div class="setting"><label for="s-count">Countdown between songs</label>
      <select id="s-count" class="input" value=${String(settings.countdown)} onChange=${(e) => set({ countdown: +e.target.value })}>
        ${[5, 10, 20, 30].map((n) => html`<option value=${n}>${n} sec</option>`)}
      </select></div>
    <div class="stack" style="gap: 6px">
      <div class="kv"><label for="s-guide">Guide vocal for new songs</label><span class="v" style="color: var(--amber)">${Math.round(settings.defaultGuide * 100)}%</span></div>
      <input id="s-guide" type="range" min="0" max="100" value=${Math.round(settings.defaultGuide * 100)} onChange=${(e) => set({ defaultGuide: e.target.value / 100 })} />
      <span class="hint">How much of the original singer stays in. 0% is pure karaoke.</span>
    </div>
    <div class="setting"><label for="s-nat">Keep voices natural when changing key</label>
      <${Switch} id="s-nat" checked=${settings.naturalVoice} onChange=${(v) => set({ naturalVoice: v })} /></div>
    <div class="stack" style="gap: 8px">
      <span style="font-size: 15px">Separation quality</span>
      <div class="seg" role="group" aria-label="Separation quality">
        <button type="button" aria-pressed=${settings.quality === 'best'} onClick=${() => set({ quality: 'best' })}>Best · ~2 min</button>
        <button type="button" aria-pressed=${settings.quality === 'fast'} onClick=${() => set({ quality: 'fast' })}>Fast · ~20 s</button>
      </div>
      <span class="hint">Best also splits lead from backing vocals. Fast is handy when someone wants to sing right now.</span>
    </div>
  </section>`;
}

export function QueueView() {
  const { room } = useRoom();
  const [dropping, setDropping] = useState(false);
  const drag = useDragOrder(room?.queue || []);

  useEffect(() => {
    let depth = 0;
    const isFile = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
    const enter = (e) => { if (isFile(e)) { depth++; setDropping(true); } };
    const leave = (e) => { if (isFile(e) && --depth <= 0) { depth = 0; setDropping(false); } };
    const over = (e) => { if (isFile(e)) e.preventDefault(); };
    const drop = (e) => {
      if (!isFile(e)) return;
      e.preventDefault();
      depth = 0; setDropping(false);
      const f = e.dataTransfer.files?.[0];
      if (f) uploadFile(f, prompt('Who\'s singing this one?') || 'Someone', 'Host').catch((err) => toast(err.message, true));
    };
    addEventListener('dragenter', enter); addEventListener('dragleave', leave);
    addEventListener('dragover', over); addEventListener('drop', drop);
    return () => {
      removeEventListener('dragenter', enter); removeEventListener('dragleave', leave);
      removeEventListener('dragover', over); removeEventListener('drop', drop);
    };
  }, []);

  if (!room) return html`<div class="page"><div class="page-inner"><p class="muted">Connecting…</p></div></div>`;
  const minutes = Math.round(room.queue.reduce((a, e) => a + (room.songs[e.songId]?.duration || 210), 0) / 60);

  return html`<div class="page"><div class="page-inner">

    <div class="columns">
      <div class="col-main">
        <section class="card lg hero stack" style="gap: 20px">
          <h1>What are we singing?</h1>
          <p>Paste a YouTube link, search, or drop in a song. We split it into vocals, drums, bass and the rest, and line up the lyrics for the big screen.</p>
          <${AddSong} addedBy="Host" />
        </section>
        <${Preparing} room=${room} />
        <section class="stack" style="gap: 14px">
          <div class="section-head">
            <h2>Up next</h2>
            <span class="muted" style="font-size: 15px">${room.queue.length ? `${room.queue.length} ${room.queue.length === 1 ? 'song' : 'songs'} · about ${minutes} min · drag to reorder` : 'Nothing queued yet'}</span>
          </div>
          ${room.queue.length > 0 && html`<ol class="qlist">
            ${room.queue.map((e, i) => html`<${QueueRow} key=${e.id} entry=${e} index=${i} room=${room} drag=${drag} />`)}
          </ol>`}
        </section>
        <${LibraryView} />
      </div>
      <aside class="col-side">
        <${StageCard} room=${room} />
        <${GuestsCard} />
        <${SettingsCard} settings=${room.settings} />
      </aside>
    </div>
  </div>
  ${dropping && html`<div class="drop-overlay"><div>Drop to add this song</div></div>`}
  </div>`;
}

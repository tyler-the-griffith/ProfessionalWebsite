// "What are we singing?" — paste a link, search YouTube, or upload a file. Used by host and guests.
import { html, useState, useRef, isUrl, fmtTime } from '../lib.js';
import { api, toast } from '../api.js';
import { Icon } from '../ui.js';
import { finishImport, currentCollection } from '../library.js';

export async function uploadFile(file, singers, addedBy) {
  const fd = new FormData();
  fd.append('file', file);
  fd.append('singers', singers || '');
  fd.append('addedBy', addedBy || '');
  toast(`Uploading ${file.name}…`);
  fd.append('collectionId', currentCollection());
  const result = await finishImport(await api.upload('/api/upload', fd));
  if (!result.cancelled) toast(result.replacement ? 'Preparing replacement. Your original is still available.' : 'Added to the queue');
}

export function AddSong({ addedBy = 'Host', compact = false, onAdded }) {
  const [text, setText] = useState('');
  const [singers, setSingers] = useState(compact ? addedBy : '');
  const [results, setResults] = useState(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef();

  const add = async (body) => {
    setBusy(true);
    try {
      const result = await finishImport(await api.post('/api/queue', { ...body, singers: singers || addedBy, addedBy, collectionId: currentCollection() }));
      if (result.cancelled) return;
      toast(result.replacement ? 'Preparing replacement. Your original is still available.' : 'Added to the queue');
      setText('');
      setResults(null);
      if (!compact) setSingers('');
      onAdded?.();
    } catch (e) {
      toast(e.message, true);
    } finally {
      setBusy(false);
    }
  };

  const submit = async (e) => {
    e.preventDefault();
    const q = text.trim();
    if (!q) return;
    if (isUrl(q)) return add({ url: q });
    setBusy(true);
    try {
      setResults(await api.post('/api/search', { q }));
    } catch (err) {
      toast(err.message, true);
    } finally {
      setBusy(false);
    }
  };

  const onFile = async (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    try {
      await uploadFile(f, singers || addedBy, addedBy);
      onAdded?.();
    } catch (err) { toast(err.message, true); }
  };

  return html`<div class="stack" style="gap: 18px">
    <form class="add-form" onSubmit=${submit}>
      <label class="field accent main">
        <${Icon} name=${isUrl(text) || !text ? 'link' : 'search'} size=${22} />
        <input type="text" aria-label="YouTube link or song search" placeholder="Paste a YouTube link or search for a song"
          value=${text} onInput=${(e) => setText(e.target.value)} autocomplete="off" />
      </label>
      <label class="field who">
        <${Icon} name="users" size=${20} />
        <input type="text" aria-label="Who's singing" placeholder=${compact ? 'Your name (& a friend for a duet)' : 'Who\'s singing? (Sam & Lee for a duet)'}
          value=${singers} onInput=${(e) => setSingers(e.target.value)} />
      </label>
      <button class="btn primary lg" type="submit" disabled=${busy || !text.trim()}>
        <${Icon} name=${isUrl(text) ? 'plus' : 'search'} />${busy ? 'Checking song…' : isUrl(text) ? 'Add to queue' : 'Find it'}
      </button>
    </form>
    ${!compact && html`<div class="row wrap" style="gap: 8px 16px; font-size: 15px">
      <button class="btn dashed" type="button" onClick=${() => fileRef.current.click()}><${Icon} name="upload" size=${18} />Upload a file</button>
      <span class="muted">or drop a file anywhere · MP3, WAV, FLAC, M4A, video</span>
    </div>`}
    ${compact && html`<button class="btn dashed" type="button" onClick=${() => fileRef.current.click()}><${Icon} name="upload" size=${18} />Upload a song from this phone</button>`}
    <input ref=${fileRef} type="file" accept="audio/*,video/*" hidden onChange=${onFile} />
    ${results && html`<div class="stack" style="gap: 10px">
      <div class="row" style="justify-content: space-between">
        <span class="eyebrow">Pick the right one</span>
        <button class="btn ghost sm" type="button" onClick=${() => setResults(null)}><${Icon} name="x" size=${16} />Close</button>
      </div>
      ${results.length === 0 && html`<p class="muted" style="margin: 0">Nothing found. Try the artist and song name, or paste a link.</p>`}
      <div class="results">
        ${results.map((r) => html`<button class="result" type="button" disabled=${busy} onClick=${() => add({ videoId: r.id, title: r.title, channel: r.channel })}>
          <img src=${r.thumbnail} alt="" loading="lazy" />
          <span class="stack" style="gap: 4px; min-width: 0">
            <span class="t">${r.title}</span>
            <span class="muted" style="font-size: 13px">${r.channel}${r.duration ? ` · ${fmtTime(r.duration)}` : ''}</span>
          </span>
        </button>`)}
      </div>
    </div>`}
  </div>`;
}

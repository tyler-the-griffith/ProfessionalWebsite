import { html, useState, useEffect, useRef } from './lib.js';
import { api, bus, useBus, toast } from './api.js';
import { Icon, Thumb } from './ui.js';

export function currentCollection() { try { return localStorage.getItem('stemroom.collection') || ''; } catch { return ''; } }
export function Modal({ title, onClose, children }) {
  const ref = useRef();
  useEffect(() => {
    const before = document.activeElement;
    const root = ref.current;
    root.querySelector('button,input,select')?.focus();
    const key = e => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
      if (e.key === 'Tab') {
        const els = [...root.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),a[href]')];
        const first = els[0], last = els.at(-1);
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
        if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
    };
    root.addEventListener('keydown', key);
    return () => { root.removeEventListener('keydown', key); before?.isConnected && before.focus(); };
  }, []);
  return html`<div class="modal-shade"><section ref=${ref} class="modal card stack" role="dialog" aria-modal="true" aria-label=${title}>
    <div class="section-head"><h2>${title}</h2><button class="icon-btn" aria-label="Close dialog" onClick=${onClose}><${Icon} name="x" /></button></div>${children}
  </section></div>`;
}

// Imports can originate on Queue, Join or a file drop; the chooser lives above routes.
export function finishImport(result) {
  if (!result.duplicate) return Promise.resolve(result);
  return new Promise((resolve,reject) => bus.dispatchEvent(new CustomEvent('duplicate-import', { detail: { result, resolve, reject } })));
}
export function ImportDialog() {
  const [pending,setPending]=useState([]);
  const [busy,setBusy]=useState(false);
  const [mixId,setMixId]=useState('');
  useBus('duplicate-import', m => setPending(xs=>[...xs,m]),[]);
  const item=pending[0], data=item?.result;
  useEffect(()=>setMixId(data?.song?.defaultMixId || ''),[data?.token]);
  if (!data) return null;
  const s=data.song;
  const choose=async action=>{
    if (busy) return;
    setBusy(true);
    try {
      const response=await api.post(`/api/imports/${data.token}/resolve`,{action,mixId});
      item.resolve(response);setPending(xs=>xs.slice(1));
    } catch(e) { toast(e.message,true); }
    finally { setBusy(false); }
  };
  return html`<${Modal} title=${data.exact ? 'Already in your library' : 'Is this the same recording?'} onClose=${()=>choose('cancel')}>
    <div class="duplicate-song"><${Thumb} src=${s.thumbnail} /><div class="stack"><strong>${s.title}</strong><span class="muted">${s.artist}</span><span class="hint">${data.reason}</span></div></div>
    <p class="hint">${s.mixes.length} saved ${s.mixes.length===1?'mix':'mixes'}${s.collections.length ? ` · In ${s.collections.map(c=>c.name).join(', ')}` : ' · All songs'}</p>
    <label class="stack">Use this mix<select class="input" value=${mixId} onChange=${e=>setMixId(e.target.value)}>${s.mixes.map(m=>html`<option value=${m.id}>${m.name}</option>`)}</select></label>
    <button class="btn primary" disabled=${busy} onClick=${()=>choose('reuse')}>Use existing song</button>
    <button class="btn" disabled=${busy} onClick=${()=>choose('replace')}>Replace source audio</button>
    <span class="hint">Replacement keeps this song’s cover, collections and saved mixes. The existing audio stays available while the replacement is prepared. Queued performances keep their original source.</span>
    ${!data.exact && html`<button class="btn" disabled=${busy} onClick=${()=>choose('separate')}>Different recording — keep both</button>`}
    <button class="btn ghost" disabled=${busy} onClick=${()=>choose('cancel')}>Cancel</button>
  </${Modal}>`;
}

export function LibraryView() {
  const [data,setData]=useState(null);
  const [cid,setCid]=useState(currentCollection);
  const [members,setMembers]=useState([]);
  const [q,setQ]=useState('');
  const [status,setStatus]=useState('all');
  const [who,setWho]=useState('');
  const [manage,setManage]=useState(null);
  const [choices,setChoices]=useState({});
  const [form,setForm]=useState(null);
  const [name,setName]=useState('');
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const refreshId=useRef(0);
  const refresh=async()=>{
    const id=++refreshId.current;
    try {
      const d=await api.get('/api/library');
      const items=cid ? await api.get(`/api/collections/${cid}/songs`) : [];
      if(id!==refreshId.current)return;
      setData(d);setError('');
      if (cid && !d.collections.some(c=>c.id===cid)) { select(''); return; }
      setMembers(items);
    } catch(e) { setError(e.message); }
  };
  useEffect(()=>{ refresh();return ()=>{refreshId.current++;}; },[cid]);
  useBus('library',refresh,[cid]);
  useBus('song',refresh,[cid]);
  const select=id=>{refreshId.current++;setCid(id);setChoices({});try{localStorage.setItem('stemroom.collection',id);}catch{}};
  const run=async fn=>{if(busy)return;setBusy(true);try{await fn();await refresh();}catch(e){toast(e.message,true);}finally{setBusy(false);}};
  const collection=data?.collections.find(c=>c.id===cid);
  const songMap=new Map((data?.songs||[]).map(s=>[s.id,s]));
  const songs=cid ? members.map(m=>songMap.get(m.songId)).filter(Boolean) : data?.songs||[];
  const shown=songs.filter(s=>`${s.title} ${s.artist}`.toLowerCase().includes(q.toLowerCase()) && (status==='all'||s.status===status||(status==='processing'&&s.status==='queued')));
  const mixFor=s=>choices[s.id] || members.find(m=>m.songId===s.id)?.mixId || s.defaultMixId;
  const add=s=>run(async()=>{await api.post(`/api/library/${s.id}/queue`,{singers:who||'Someone',addedBy:'Host',mixId:mixFor(s)});toast(`${s.title} added to the queue`);});
  const move=(s,delta)=>run(async()=>{
    const ids=members.map(m=>m.songId),i=ids.indexOf(s.id),j=i+delta;
    if(j<0||j>=ids.length)return;
    [ids[i],ids[j]]=[ids[j],ids[i]];
    await api.put(`/api/collections/${cid}/order`,{ids});
  });
  const saveForm=e=>{e.preventDefault();run(async()=>{
    const c=form==='new'? await api.post('/api/collections',{name}):await api.patch(`/api/collections/${cid}`,{name});
    setForm(null);select(c.id);
  });};
  return html`<section class="library stack" aria-label="Song library">
    <div class="section-head"><div class="stack"><span class="eyebrow amber">Your library</span><h2>${collection?.name || 'All songs'}</h2></div>
      <button class="btn sm" onClick=${()=>{setForm('new');setName('');}}><${Icon} name="plus" size=${16}/>New collection</button></div>
    <div class="collection-tabs" role="group" aria-label="Collections">
      <button class="btn sm" aria-pressed=${!cid} onClick=${()=>select('')}>All songs <span class="dim">${data?.songs.length||0}</span></button>
      ${(data?.collections||[]).map(c=>html`<button class="btn sm" aria-pressed=${cid===c.id} onClick=${()=>select(c.id)}>${c.name} <span class="dim">${c.count}</span></button>`)}
    </div>
    ${cid && html`<div class="row wrap" style="gap:8px"><span class="hint grow">Songs can belong to more than one collection.</span>
      <button class="btn ghost sm" onClick=${()=>{setName(collection.name);setForm('rename');}}>Rename</button>
      <button class="btn ghost sm" onClick=${()=>run(async()=>{const ids=data.collections.map(c=>c.id),i=ids.indexOf(cid);if(i>0){[ids[i-1],ids[i]]=[ids[i],ids[i-1]];await api.put('/api/collection-order',{ids});}})}>Move collection left</button>
      <button class="btn ghost sm" onClick=${()=>{if(confirm(`Delete “${collection.name}”? Its songs and mixes will stay in All songs.`))run(async()=>{await api.del(`/api/collections/${cid}`);select('');});}}>Delete collection</button></div>`}
    <div class="library-filters"><label class="field sm grow"><${Icon} name="search" size=${18}/><input type="search" aria-label="Search library" placeholder="Search songs or artists" value=${q} onInput=${e=>setQ(e.target.value)}/></label>
      <select class="input" aria-label="Song status" value=${status} onChange=${e=>setStatus(e.target.value)}><option value="all">All statuses</option><option value="ready">Ready</option><option value="processing">Preparing</option><option value="error">Needs attention</option></select>
      <input class="input" aria-label="Library singer names" placeholder="Who’s singing?" value=${who} onInput=${e=>setWho(e.target.value)}/></div>
    ${error && html`<p class="pill err">${error}</p>`}
    ${!data && !error && html`<p class="muted">Loading your library…</p>`}
    ${data && !shown.length && html`<div class="library-empty"><${Icon} name="music" size=${30}/><p>${cid?'This collection is ready for songs. Choose All songs and use Collections on any song to add it here.':'Your songs will appear here when you paste a link or upload a file.'}</p></div>`}
    <div class="song-grid">${shown.map((s,i)=>html`<article class="song-card" key=${s.id}>
      <a class="song-art" href=${`#/studio/${s.id}?mix=${mixFor(s)}`} aria-label=${`Open ${s.title} in Studio`}><${Thumb} src=${s.thumbnail}/><span class=${'song-status '+s.status}>${s.status==='ready'?'Ready':s.status==='error'?'Needs attention':'Preparing'}</span></a>
      <div class="song-card-body stack"><strong class="song-title">${s.title}</strong><span class="muted song-artist">${s.artist||'Unknown artist'}</span>
        <label class="mix-picker"><span class="hint">Mix</span><select class="input" aria-label=${`Mix for ${s.title}`} value=${mixFor(s)} onChange=${e=>{const id=e.target.value;setChoices(x=>({...x,[s.id]:id}));if(cid)run(()=>api.put(`/api/collections/${cid}/songs/${s.id}`,{mixId:id}));}}>${s.mixes.map(m=>html`<option value=${m.id}>${m.name}${m.needsReview?' · review':''}</option>`)}</select></label>
        ${s.replacementError && html`<span class="hint">Replacement failed. Original retained.</span>`}
        ${s.status==='error' && html`<span class="hint">${s.error}</span>`}
        <div class="row wrap" style="gap:6px"><button class="btn primary sm grow" disabled=${busy} onClick=${()=>add(s)}><${Icon} name="plus" size=${16}/>Queue</button><a class="btn sm" href=${`#/studio/${s.id}?mix=${mixFor(s)}`}>Studio</a></div>
        <div class="row wrap" style="gap:6px"><button class="btn ghost sm" onClick=${()=>setManage(s)}>Collections${s.collections.length?` · ${s.collections.length}`:''}</button>
          ${s.status==='error' && html`<button class="btn ghost sm" disabled=${busy} onClick=${()=>run(()=>api.post(`/api/songs/${s.id}/retry`))}>Retry</button>`}
          ${cid && html`<button class="icon-btn" aria-label=${`Move ${s.title} earlier`} disabled=${busy||members[0]?.songId===s.id} onClick=${()=>move(s,-1)}><${Icon} name="up" size=${16}/></button><button class="btn ghost sm" disabled=${busy} onClick=${()=>run(()=>api.del(`/api/collections/${cid}/songs/${s.id}`))}>Remove</button>`}
        </div>
      </div>
    </article>`)}</div>
    ${manage && html`<${Modal} title="Add to collections" onClose=${()=>setManage(null)}><div class="duplicate-song"><${Thumb} src=${manage.thumbnail}/><strong>${manage.title}</strong></div>
      ${(data?.collections||[]).map(c=>html`<label class="membership"><input type="checkbox" disabled=${busy} checked=${songMap.get(manage.id)?.collections.some(x=>x.id===c.id)} onChange=${e=>run(()=>e.target.checked?api.put(`/api/collections/${c.id}/songs/${manage.id}`,{mixId:mixFor(manage)}):api.del(`/api/collections/${c.id}/songs/${manage.id}`))}/>${c.name}</label>`)}
      ${!data?.collections.length && html`<p class="hint">Create a collection with the New collection button first.</p>`}
      <span class="hint">Removing a membership keeps the song, its artwork and every saved mix in your library.</span><button class="btn primary" onClick=${()=>setManage(null)}>Done</button>
    </${Modal}>`}
    ${form && html`<${Modal} title=${form==='new'?'New collection':'Rename collection'} onClose=${()=>setForm(null)}><form class="stack" onSubmit=${saveForm}><label class="stack">Name<input class="input" value=${name} maxLength="80" required onInput=${e=>setName(e.target.value)}/></label><button class="btn primary" disabled=${busy||!name.trim()}>Save collection</button></form></${Modal}>`}
  </section>`;
}

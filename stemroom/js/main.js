import { html, render, useEffect, useState } from './lib.js';
import { Toasts, TopBar, ConnectionNotice } from './ui.js';
import { QueueView } from './views/queue.js';
import { StageView } from './views/stage.js';
import { StudioView } from './views/studio.js';
import { JoinView } from './views/join.js';
import { ImportDialog, LibraryView } from './library.js';

function parse() {
  const [path, query] = (location.hash.slice(1) || '/').split('?');
  const parts = path.split('/').filter(Boolean);
  return { parts, params: new URLSearchParams(query || '') };
}

function App() {
  const [route, setRoute] = useState(parse());
  useEffect(() => {
    const h = () => { setRoute(parse()); window.scrollTo(0, 0); };
    addEventListener('hashchange', h);
    return () => removeEventListener('hashchange', h);
  }, []);
  const [name, arg] = route.parts;
  let view;
  if (name === 'stage') view = null;
  else if (name === 'studio' && arg) view = html`<${StudioView} key=${arg + (route.params.get('mix') || '')} songId=${arg} entryId=${route.params.get('entry')} initialMixId=${route.params.get('mix')} />`;
  else if (name === 'studio') view = html`<div class="page"><div class="page-inner"><p>Choose a song to open its Studio.</p><${LibraryView}/></div></div>`;
  else if (name === 'join') view = html`<${JoinView} />`;
  else view = html`<${QueueView} />`;
  document.title = { stage: 'Stage · Stemroom', studio: 'Studio · Stemroom', join: 'Join the party · Stemroom' }[name] || 'Stemroom';
  if (name === 'studio' && arg) { try { localStorage.setItem('stemroom.studio', location.hash); } catch {} }
  return html`<${TopBar} active=${name || 'queue'} studioSong=${arg}/><${ConnectionNotice}/><main>${view}</main><div style=${{display:name==='stage'?'contents':'none'}}><${StageView} active=${name==='stage'}/></div><${ImportDialog}/><${Toasts} />`;
}

render(html`<${App} />`, document.getElementById('app'));

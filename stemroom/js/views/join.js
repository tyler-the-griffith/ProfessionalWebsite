// Guests' phones: say who you are, add songs, see when you're up.
import { html, useState, singersLabel } from '../lib.js';
import { useRoom, guestName, setGuestName } from '../api.js';
import { Logo, Avatars, Thumb } from '../ui.js';
import { AddSong } from './add.js';

export function JoinView() {
  const { room } = useRoom();
  const [name, setName] = useState(guestName());
  const [draft, setDraft] = useState('');

  if (!name) {
    return html`<main class="guest">
      <div class="row" style="gap: 10px"><${Logo} /><span class="display" style="font-size: 22px; font-weight: 700">Stemroom</span></div>
      <h1>Join the party</h1>
      <form class="stack" style="gap: 12px" onSubmit=${(e) => { e.preventDefault(); if (draft.trim()) { setGuestName(draft.trim()); setName(draft.trim()); } }}>
        <label class="field accent"><input aria-label="Your name" placeholder="Your name" value=${draft} onInput=${(e) => setDraft(e.target.value)} autoFocus /></label>
        <button class="btn primary lg" type="submit" disabled=${!draft.trim()}>Let's sing</button>
      </form>
    </main>`;
  }

  const mine = (e) => e.addedBy === name || e.singers.includes(name);
  const queue = room?.queue || [];
  const myNext = queue.findIndex(mine);
  const songs = room?.songs || {};
  const cur = room?.current;

  return html`<main class="guest">
    <div class="row" style="justify-content: space-between">
      <div class="row" style="gap: 10px"><${Logo} /><span class="display" style="font-size: 22px; font-weight: 700">Stemroom</span></div>
      <button class="btn ghost sm" type="button" onClick=${() => { setGuestName(''); setName(''); }}>Not ${name}?</button>
    </div>
    <h1>${myNext >= 0 ? (myNext === 0 ? 'You\'re up next!' : `You're ${myNext + 1} songs away`) : `Hi ${name}, what will you sing?`}</h1>
    <section class="card stack" style="gap: 16px; padding: 18px">
      <${AddSong} addedBy=${name} compact />
    </section>
    ${cur && html`<section class="card tight row" style="gap: 14px">
      <${Thumb} src=${songs[cur.songId]?.thumbnail} sm />
      <div class="stack grow" style="gap: 2px">
        <span class="eyebrow amber">On stage</span>
        <span class="ellipsis" style="font-weight: 600">${songs[cur.songId]?.title || '…'}</span>
        <span class="muted ellipsis" style="font-size: 14px">${singersLabel(cur.singers)}</span>
      </div>
    </section>`}
    <section class="stack" style="gap: 10px">
      <span class="eyebrow">Up next</span>
      ${queue.length === 0 && html`<p class="muted" style="margin: 0">The queue is empty. Add something!</p>`}
      <ol class="qlist">
        ${queue.map((e, i) => {
          const s = songs[e.songId] || {};
          return html`<li class=${'qrow' + (mine(e) ? ' mine' : '')} style="flex-wrap: nowrap">
            <span class="num">${i + 1}</span>
            <div class="stack grow" style="gap: 2px">
              <span class="ellipsis" style="font-weight: 600">${s.title || 'Getting it ready…'}</span>
              <span class="muted ellipsis" style="font-size: 13px">${singersLabel(e.singers)}${s.status === 'processing' ? ' · preparing' : ''}</span>
            </div>
            <${Avatars} names=${e.singers} duetColors />
          </li>`;
        })}
      </ol>
    </section>
  </main>`;
}

const theme = document.querySelector('#theme');
for (const item of window.StemroomTheme.themes) {
  const option = document.createElement('option');
  option.value = item.id;
  option.textContent = item.name;
  theme.append(option);
}
theme.value = window.StemroomTheme.current();
theme.addEventListener('change', () => window.StemroomTheme.set(theme.value));
window.addEventListener('stemroom-theme-change', () => { theme.value = window.StemroomTheme.current(); });

try {
  const response = await fetch('room.json', { cache: 'no-store' });
  if (!response.ok) throw new Error('Room address unavailable');
  const { url, note } = await response.json();
  const base = new URL(url);
  if (base.protocol !== 'https:' || base.username || base.password) throw new Error('Room requires HTTPS');
  for (const link of document.querySelectorAll('.launch, [data-route], #guest-link')) {
    const target = new URL(base);
    target.hash = link.id === 'guest-link' ? '#/join' : link.dataset.route || '#/';
    link.href = target.href;
  }
  document.querySelector('#connection-title').textContent = 'Your full Stemroom app';
  document.querySelector('#connection-description').textContent = note || 'The room opens on its separate host.';
} catch {
  document.querySelector('#connection-title').textContent = 'The online room is not configured yet';
  document.querySelector('#connection-description').textContent = 'The app works locally. Online audio processing is waiting for its server. Setup instructions are on GitHub.';
  for (const link of document.querySelectorAll('.launch, [data-route], #guest-link')) link.href = '#connection';
  for (const link of document.querySelectorAll('.launch')) link.textContent = 'Online room setup pending';
  for (const label of document.querySelectorAll('.route-action')) label.textContent = 'Online hosting coming next';
  document.querySelector('#guest-link').textContent = 'Run a local room ↗';
  document.querySelector('#guest-link').href = 'https://github.com/tyler-the-griffith/stemroom#setup-from-scratch';
}

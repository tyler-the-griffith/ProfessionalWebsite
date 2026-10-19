// Loaded before CSS so a saved theme is applied before the first paint.
(() => {
  const key = 'stemroom.theme';
  const themes = [
    { id: 'olive', name: 'Olive Garden Feast', description: 'Forest greens & golden copper', background: '#18210F', colors: ['#606C38', '#283618', '#FEFAE0', '#DDA15E', '#BC6C25'] },
    { id: 'autumn', name: 'Autumn Harvest', description: 'Dark coffee, wine & mellow gold', background: '#261A13', colors: ['#6F1D1B', '#BB9457', '#432818', '#99582A', '#FFE6A7'] },
    { id: 'ocean', name: 'Fiery Ocean', description: 'Deep blue & a spark of crimson', background: '#001E2D', colors: ['#780000', '#C1121F', '#FDF0D5', '#003049', '#669BBC'] },
  ];
  const valid = id => themes.some(theme => theme.id === id) ? id : 'olive';
  const read = () => { try { return valid(localStorage.getItem(key)); } catch { return 'olive'; } };
  const apply = id => {
    id = valid(id);
    document.documentElement.dataset.theme = id;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', themes.find(theme => theme.id === id).background);
    window.dispatchEvent(new Event('stemroom-theme-change'));
    return id;
  };
  window.StemroomTheme = {
    themes,
    current: () => valid(document.documentElement.dataset.theme),
    set(id) {
      const selected = apply(id);
      try { localStorage.setItem(key, selected); } catch { /* Still works for this visit when storage is unavailable. */ }
    },
  };
  apply(read());
  window.addEventListener('storage', event => {
    if (event.key === key || event.key === null) apply(read());
  });
})();

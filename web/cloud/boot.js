// Runs before the stylesheet paints anything: puts the stored appearance on
// <html> so the first frame is already the person's own theme, not the
// default green that `index.html` carries until the deferred `app.js` runs.
// It only reads; `app.js` stays the one place that decides and persists, and
// repeats every one of these choices on boot. Kept in its own file because
// the page's CSP allows no inline script.
(() => {
  const root = document.documentElement;
  let store = null;
  try { store = window.localStorage; } catch { return; }
  const read = (key) => { try { return store.getItem(key); } catch { return null; } };
  const THEMES = ['paper', 'green', 'amber', 'blue', 'matrix', 'mono'];
  const MODES = ['auto', 'light', 'dark'];
  const theme = read('tailchat-cloud-theme-chosen') != null && THEMES.includes(read('tailchat-cloud-theme'))
    ? read('tailchat-cloud-theme') : 'green';
  root.dataset.theme = theme;
  let mode = read('tailchat-cloud-mode');
  if (!MODES.includes(mode)) mode = read('tailchat-cloud-theme') === 'light' ? 'light' : 'auto';
  if (mode === 'auto') {
    mode = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  root.dataset.mode = mode;
  if (read('tailchat-cloud-depth') === 'off') root.dataset.depth = 'off';
  const wallpaper = read('tailchat-cloud-wallpaper');
  const WALLPAPERS = ['none', 'dots', 'ruled', 'diamond', 'aurora', 'waves', 'topo', 'doodle'];
  if (WALLPAPERS.includes(wallpaper) && (wallpaper !== 'none' || read('tailchat-cloud-wallpaper-chosen') != null)) {
    root.dataset.wallpaper = wallpaper;
  }
  if (read('tailchat-cloud-font-chosen') != null && ['serif', 'mono', 'sans'].includes(read('tailchat-cloud-font'))) {
    root.dataset.font = read('tailchat-cloud-font');
  } else if (theme === 'paper') {
    root.dataset.font = 'serif';
  }
})();

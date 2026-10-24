// Fills in the newest app versions wherever the page asks for them:
// <b data-appver="ios"></b> gets "1.0.1". Anything marked data-appver-line
// stays hidden until its number arrives, so a slow store never shows a blank.
fetch('/api/app-versions').then((r) => r.json()).then((v) => {
  document.querySelectorAll('[data-appver]').forEach((el) => {
    const n = v[el.dataset.appver] && v[el.dataset.appver].version;
    if (!n) return;
    el.textContent = n;
    const line = el.closest('[data-appver-line]');
    if (line) line.hidden = false;
  });
}).catch(() => {});

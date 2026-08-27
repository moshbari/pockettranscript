// Chrome refuses to let a page link to chrome://extensions, so the address is
// copied to the clipboard and the reader pastes it themselves.
const toastEl = document.getElementById('toast');
let toastTimer;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.add('hidden'), 2000);
}

document.getElementById('copyUrlBtn').addEventListener('click', async () => {
  const text = document.getElementById('chromeUrl').textContent.trim();
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied — paste it in Chrome');
  } catch {
    const r = document.createRange();
    r.selectNodeContents(document.getElementById('chromeUrl'));
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
    toast('Selected — press Copy');
  }
});

// Reading this on a phone is fine — installing on one isn't possible. Say so
// at the moment they'd otherwise tap Download and get a useless zip.
const onPhone = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
if (onPhone) {
  const dl = document.getElementById('dlBtn');
  dl.addEventListener('click', (e) => {
    if (dl.dataset.warned) return;         // second tap downloads anyway
    e.preventDefault();
    dl.dataset.warned = '1';
    dl.textContent = 'Tap again to download anyway';
    toast('This step needs your computer');
  });
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

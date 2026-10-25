// Notifications en temps réel : flux SSE (/events), compteur de la cloche, liste déroulante et pastilles.
(() => {
  const root = document.querySelector('[data-notif]');
  if (!root || !window.EventSource) return;
  const badges = document.querySelectorAll('[data-notif-count]');
  const list = document.querySelector('[data-notif-list]');
  const empty = document.querySelector('[data-notif-empty]');
  const readAll = document.querySelector('[data-read-all]');
  const nowLabel = root.dataset.now || '';

  const setCount = (n) => {
    badges.forEach((b) => { b.textContent = n > 9 ? '9+' : String(n); b.hidden = n < 1; });
    if (readAll) readAll.hidden = n < 1;
    document.title = document.title.replace(/^\(\d+\)\s*/, '');
    if (n > 0) document.title = `(${n}) ${document.title}`;
  };

  const toasts = (() => {
    const box = document.createElement('div');
    box.className = 'toasts'; box.setAttribute('aria-live', 'polite'); box.setAttribute('role', 'status');
    document.body.appendChild(box);
    return box;
  })();

  const toast = (n) => {
    const a = document.createElement('a');
    a.className = 'toast'; a.href = `/notifications/go/${n.id}`;
    const dot = document.createElement('span'); dot.className = 'toast-dot'; dot.setAttribute('aria-hidden', 'true');
    const txt = document.createElement('span'); txt.textContent = n.text;
    a.append(dot, txt);
    toasts.prepend(a);
    while (toasts.children.length > 3) toasts.lastChild.remove();
    setTimeout(() => { a.classList.add('out'); setTimeout(() => a.remove(), 300); }, 7000);
  };

  const addToList = (n) => {
    if (!list) return;
    const li = document.createElement('li');
    const a = document.createElement('a'); a.className = 'n-item unread'; a.href = `/notifications/go/${n.id}`;
    const t = document.createElement('span'); t.className = 'n-text'; t.textContent = n.text;
    const time = document.createElement('time'); time.className = 'n-time'; time.textContent = nowLabel;
    a.append(t, time); li.append(a);
    list.prepend(li);
    while (list.children.length > 8) list.lastChild.remove();
    if (empty) empty.hidden = true;
  };

  const es = new EventSource(`/events?lang=${encodeURIComponent(document.documentElement.lang || '')}`);
  es.addEventListener('count', (e) => setCount(JSON.parse(e.data).count));
  es.addEventListener('notification', (e) => {
    const n = JSON.parse(e.data);
    setCount(n.count); addToList(n); toast(n);
  });
  window.addEventListener('pagehide', () => es.close());

  // « Tout marquer comme lu » sans rechargement.
  readAll?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const csrf = document.querySelector('meta[name="csrf-token"]')?.content || '';
    try {
      const res = await fetch(readAll.action, { method: 'POST', headers: { 'x-requested-with': 'fetch', 'x-csrf-token': csrf, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(new FormData(readAll)) });
      if (!res.ok) { readAll.submit(); return; }
      setCount(0); list?.querySelectorAll('.unread').forEach((el) => el.classList.remove('unread'));
    } catch (err) { readAll.submit(); }
  });
})();

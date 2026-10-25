(() => {
  const csrf = document.querySelector('meta[name="csrf-token"]')?.content;

  // Thème clair / sombre.
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-theme-toggle]')) {
      const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
      document.documentElement.dataset.theme = next;
      try { localStorage.setItem('theme', next); } catch (err) { /* ignoré */ }
    }
    const copy = e.target.closest('[data-copy]');
    if (copy && navigator.clipboard) {
      navigator.clipboard.writeText(copy.dataset.copy).then(() => {
        const old = copy.title; copy.title = copy.dataset.copied; copy.classList.add('on');
        setTimeout(() => { copy.title = old; copy.classList.remove('on'); }, 1500);
      });
    }
  });

  // Votes, favoris et abonnements sans rechargement ; sans JavaScript, les formulaires fonctionnent quand même.
  document.addEventListener('submit', async (e) => {
    const form = e.target;
    const confirmMsg = e.submitter?.dataset.confirm || form.dataset.confirm;
    if (confirmMsg && !window.confirm(confirmMsg)) { e.preventDefault(); return; }
    const kind = form.dataset.toggle;
    if (!kind) return;
    e.preventDefault();
    const btn = form.querySelector('button');
    btn.disabled = true;
    try {
      const res = await fetch(form.action, {
        method: 'POST',
        headers: { 'x-requested-with': 'fetch', 'x-csrf-token': csrf || '', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(new FormData(form)),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401 && data.login) { window.location.href = data.login; return; }
      if (!res.ok) { form.submit(); return; }
      btn.classList.toggle('on', data.active);
      btn.setAttribute('aria-pressed', String(data.active));
      if (kind === 'vote') btn.querySelector('.count').textContent = data.count;
      if (kind === 'follow') {
        btn.textContent = data.active ? btn.dataset.labelOn : btn.dataset.labelOff;
        btn.classList.toggle('ghost', data.active || btn.dataset.compact === '1');
      }
    } catch (err) {
      form.submit();
    } finally {
      btn.disabled = false;
    }
  });

  // Image introuvable ou illisible : la couverture générative placée derrière prend le relais (la CSP interdit onerror en ligne).
  const dropBroken = (img) => {
    if (img.closest('.media')) img.remove();
    else if (img.closest('.cover, .thumb')) img.classList.add('broken');
  };
  document.addEventListener('error', (e) => { if (e.target.tagName === 'IMG') dropBroken(e.target); }, true);
  // Les erreurs survenues avant l'exécution de ce script (chargement différé) sont rattrapées ici.
  document.querySelectorAll('img').forEach((img) => { if (img.complete && img.naturalWidth === 0 && img.getAttribute('src')) dropBroken(img); });

  // Ferme le menu du compte au clic ailleurs.
  document.addEventListener('click', (e) => {
    document.querySelectorAll('details.menu[open]').forEach((d) => { if (!d.contains(e.target)) d.removeAttribute('open'); });
  });
})();

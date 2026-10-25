(() => {
  const body = document.getElementById('body');
  const preview = document.getElementById('preview');
  const previewBtn = document.getElementById('previewBtn');
  const msg = document.getElementById('editorMsg');
  const csrf = document.querySelector('meta[name="csrf-token"]')?.content;

  // Applique un format Markdown à la sélection.
  function wrap(before, after = before, placeholder = 'texte') {
    const { selectionStart: s, selectionEnd: e, value } = body;
    const sel = value.slice(s, e) || placeholder;
    body.setRangeText(before + sel + after, s, e, 'end');
    body.setSelectionRange(s + before.length, s + before.length + sel.length);
    body.focus();
  }
  function linePrefix(prefix) {
    const { selectionStart: s, value } = body;
    const start = value.lastIndexOf('\n', s - 1) + 1;
    body.setRangeText(prefix, start, start, 'end');
    body.focus();
  }
  const actions = {
    bold: () => wrap('**'),
    italic: () => wrap('*'),
    h2: () => linePrefix('## '),
    h3: () => linePrefix('### '),
    quote: () => linePrefix('> '),
    ul: () => linePrefix('- '),
    code: () => {
      const sel = body.value.slice(body.selectionStart, body.selectionEnd);
      sel.includes('\n') ? wrap('```\n', '\n```', 'code') : wrap('`');
    },
    link: () => {
      const url = window.prompt('Adresse du lien (https://…)');
      if (url) wrap('[', `](${url})`, 'texte du lien');
    },
  };
  document.getElementById('toolbar').addEventListener('click', (e) => {
    const a = e.target.closest('[data-md]')?.dataset.md;
    if (a) actions[a]();
  });

  // Raccourcis clavier.
  body.addEventListener('keydown', (e) => {
    if (!(e.metaKey || e.ctrlKey)) return;
    if (e.key === 'b') { e.preventDefault(); actions.bold(); }
    if (e.key === 'i') { e.preventDefault(); actions.italic(); }
    if (e.key === 'k') { e.preventDefault(); actions.link(); }
  });

  // Upload d'image, insérée à la position du curseur.
  const imgFile = document.getElementById('imgFile');
  document.getElementById('imgBtn').addEventListener('click', () => imgFile.click());
  imgFile.addEventListener('change', async () => {
    const file = imgFile.files[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('image', file);
    msg.textContent = 'Envoi de l\'image…';
    try {
      const res = await fetch('/admin/upload', { method: 'POST', headers: { 'x-csrf-token': csrf }, body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Échec de l\'envoi');
      const alt = window.prompt('Description de l\'image (accessibilité)', file.name.replace(/\.[^.]+$/, '')) || '';
      body.setRangeText(`\n![${alt}](${data.url})\n`, body.selectionStart, body.selectionEnd, 'end');
      msg.textContent = 'Image insérée.';
    } catch (err) {
      msg.textContent = err.message;
    }
    imgFile.value = '';
  });

  // Aperçu rendu côté serveur (identique au site).
  previewBtn.addEventListener('click', async () => {
    const showing = !preview.hidden;
    if (showing) {
      preview.hidden = true; body.hidden = false;
      previewBtn.setAttribute('aria-pressed', 'false'); previewBtn.textContent = 'Aperçu';
      return;
    }
    try {
      const res = await fetch('/admin/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrf },
        body: JSON.stringify({ md: body.value }),
      });
      const data = await res.json();
      preview.innerHTML = data.html; // HTML assaini côté serveur
      preview.hidden = false; body.hidden = true;
      previewBtn.setAttribute('aria-pressed', 'true'); previewBtn.textContent = 'Éditer';
    } catch {
      msg.textContent = 'Aperçu indisponible.';
    }
  });

  // Alerte si l'on quitte avec des modifications non enregistrées.
  let dirty = false;
  const form = body.form;
  form.addEventListener('input', () => { dirty = true; });
  form.addEventListener('submit', () => { dirty = false; });
  window.addEventListener('beforeunload', (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });
})();

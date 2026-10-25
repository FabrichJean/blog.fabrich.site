// Appliqué avant le rendu (pas de flash) : ?theme=light|dark, sinon choix du lecteur, sinon préférence du système.
try {
  var q = /[?&]theme=(light|dark)/.exec(location.search);
  if (q) localStorage.setItem('theme', q[1]);
  var saved = localStorage.getItem('theme');
  var dark = saved ? saved === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
} catch (e) { /* stockage indisponible : thème clair */ }

const FONTS = {
  sans: '"Schibsted Grotesk", system-ui, -apple-system, "Segoe UI", sans-serif',
  serif: '"Fraunces", "Iowan Old Style", Georgia, serif',
  mono: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
};
const FONT_LABELS = { sans: 'Grotesque (Schibsted Grotesk)', serif: 'Serif (Fraunces)', mono: 'Monospace (JetBrains Mono)' };
const HEX = /^#[0-9a-f]{6}$/i;

// Texte lisible sur la couleur d'accent : noir ou blanc selon la luminance.
function inkFor(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? '#111111' : '#ffffff';
}

// Les valeurs sont revalidées ici : rien d'autre qu'un hex ou une police de la liste n'atteint le CSS.
function themeCss(s) {
  const light = HEX.test(s.theme_accent) ? s.theme_accent : '#ff4b2b';
  const dark = HEX.test(s.theme_accent_dark) ? s.theme_accent_dark : '#ff7a59';
  const font = FONTS[s.theme_font] || FONTS.sans;
  return `:root,:root[data-theme="light"]{--accent:${light};--accent-ink:${inkFor(light)}}
:root[data-theme="dark"]{--accent:${dark};--accent-ink:${inkFor(dark)}}
:root{--font:${font}}
`;
}

module.exports = { themeCss, FONTS, FONT_LABELS, HEX };

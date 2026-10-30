/**
 * Gemeinsame Merkmalsfarben — eine Quelle für die 3D-Hervorhebung in den Viewern
 * (Panel 2/3) und für die Farblegende der Seite, damit beide nie auseinanderlaufen.
 * Reines Datenmodul: keine Imports, kein DOM-Zugriff beim Import.
 */

export const FEATURE_COLORS = {
  bore: 0xff1744,   // Bohrung
  mantle: 0xff2d92, // Außenmantel (Welle/Zapfen)
  fillet: 0xff8c00, // Verrundung
  tube: 0xaf52de,   // gebogener Kanal
  plane: 0x607080   // übrige Flächen
};

export const FEATURE_LABELS = {
  bore: 'Bohrung',
  mantle: 'Außenmantel (Welle/Zapfen)',
  fillet: 'Verrundung',
  tube: 'gebogener Kanal',
  plane: 'übrige Flächen'
};

// Reihenfolge der Merkmale in Legende und Farbzuweisung.
export const FEATURE_ORDER = ['bore', 'mantle', 'fillet', 'tube', 'plane'];

// Nur in der Legende abweichender Text (die 3D-Farbe bleibt unverändert).
const LEGEND_LABELS = {
  plane: 'übrige Flächen (Panel „Flächen-Regionen“: je Region eigene Farbe)'
};

// 0xRRGGBB → '#rrggbb' (kleinbuchstaben, 6 Stellen, nullgefüllt).
export function toCssHex(n) {
  return '#' + ((n >>> 0) & 0xffffff).toString(16).padStart(6, '0');
}

// CSS-Variablen --c-bore … --c-plane auf dem Root-Element setzen.
export function applyFeatureColorVars(root = document.documentElement) {
  if (!root) return;
  for (const key of FEATURE_ORDER) {
    root.style.setProperty(`--c-${key}`, toCssHex(FEATURE_COLORS[key]));
  }
}

// Legende als <li data-feature="…"><span class="legend__swatch"></span>Text</li> aufbauen.
export function buildFeatureLegend(ul) {
  if (!ul) return;
  ul.textContent = '';
  for (const key of FEATURE_ORDER) {
    const li = document.createElement('li');
    li.dataset.feature = key;

    const swatch = document.createElement('span');
    swatch.className = 'legend__swatch';
    swatch.setAttribute('aria-hidden', 'true');
    swatch.style.setProperty('--swatch', toCssHex(FEATURE_COLORS[key]));
    swatch.style.background = 'var(--swatch)';

    li.appendChild(swatch);
    li.appendChild(document.createTextNode(LEGEND_LABELS[key] || FEATURE_LABELS[key]));
    ul.appendChild(li);
  }
}

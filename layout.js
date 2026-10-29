// ── layout.js — Tabs, Ansichts-Umschalter und dokumentweites Drag & Drop ───
//
// Eigenständiges ES-Modul ohne Importe. Beim Laden werden nur Funktionen
// definiert, es gibt keine Seiteneffekte (kein DOM-Zugriff auf Modulebene).
// Enthält die reine Bedienlogik der Oberfläche (Spezifikation ui-spec.md 6.7):
//   • Tabs im Expertenbereich (Klick, Pfeiltasten, Pos1/Ende)
//   • Umschalter „Vergleich | Nur STEP“ (#compare-panel[data-view])
//   • Datei-Drop über das ganze Dokument (statt Handler am #drop-zone)
//
// Alle DOM-Zugriffe sind null-geprüft: fehlen Elemente (älterer Markupstand),
// bleibt die Funktion wirkungslos, statt einen Fehler zu werfen.

// ── Zustand ─────────────────────────────────────────────────────────────────

let dragDepth   = 0;      // Zähler für dragenter/dragleave — verhindert Flackern über Kindelemente
let dropCleanup = null;   // Entferner für eine eventuell bereits aktive Drop-Logik

// ── Tabs ────────────────────────────────────────────────────────────────────

/**
 * Alle Tab-Leisten im Suchwurzel verdrahten.
 * @param {ParentNode} root  Suchwurzel (Standard: das ganze Dokument)
 */
export function initTabs(root = document) {
  if (!root || typeof root.querySelectorAll !== 'function') return;
  const tablists = root.querySelectorAll('[role="tablist"]');
  tablists.forEach((tablist) => {
    const tabs = Array.from(tablist.querySelectorAll('[role="tab"]'));
    if (!tabs.length) return;

    tabs.forEach((tab) => {
      tab.addEventListener('click', () => selectTab(tab));
      tab.addEventListener('keydown', (e) => _onTabKeydown(e, tabs));
    });

    // Anfangszustand konsistent setzen: der als ausgewählt markierte Tab, sonst der erste.
    // So stimmen aria-selected, tabindex und die Sichtbarkeit der Panels zusammen.
    const initial = tabs.find((t) => t.getAttribute('aria-selected') === 'true') || tabs[0];
    selectTab(initial);
  });
}

/**
 * Tab auswählen: aria-selected und tabindex setzen, Panels ein-/ausblenden.
 * @param {Element} tab  der zu auswählende Tab
 */
export function selectTab(tab) {
  if (!tab) return;
  const tablist = typeof tab.closest === 'function' ? tab.closest('[role="tablist"]') : null;
  const tabs = tablist ? Array.from(tablist.querySelectorAll('[role="tab"]')) : [tab];

  tabs.forEach((t) => {
    const selected = t === tab;
    t.setAttribute('aria-selected', selected ? 'true' : 'false');
    t.setAttribute('tabindex', selected ? '0' : '-1');
    const panel = _panelOf(t);
    if (panel) panel.hidden = !selected;
  });
}

// Pfeiltasten blättern mit Wrap-Around, Pos1/Ende springen an den Rand.
function _onTabKeydown(e, tabs) {
  const idx = tabs.indexOf(e.currentTarget);
  if (idx < 0) return;

  let target = null;
  switch (e.key) {
    case 'ArrowRight': target = tabs[(idx + 1) % tabs.length]; break;
    case 'ArrowLeft':  target = tabs[(idx - 1 + tabs.length) % tabs.length]; break;
    case 'Home':       target = tabs[0]; break;
    case 'End':        target = tabs[tabs.length - 1]; break;
    default: return;
  }

  e.preventDefault();
  selectTab(target);
  target.focus?.();
}

// Das Panel eines Tabs über aria-controls auffinden (darf fehlen).
function _panelOf(tab) {
  const id = tab.getAttribute('aria-controls');
  if (!id) return null;
  return document.getElementById(id);
}

// ── Ansicht „Vergleich | Nur STEP“ ──────────────────────────────────────────

/**
 * Vergleichsansicht umschalten.
 * @param {'split'|'step'} view
 */
export function setCompareView(view) {
  const v = view === 'step' ? 'step' : 'split';

  const panel = document.getElementById('compare-panel');
  if (panel) panel.dataset.view = v;

  // Im STEP-only-Modus entfällt die Original-Ansicht.
  const original = document.getElementById('fig-original');
  if (original) original.hidden = (v === 'step');

  // Das passende Radio anwählen (die Beschriftung hängt per <label for> daran).
  const radio = document.getElementById(v === 'step' ? 'view-step' : 'view-split');
  if (radio) radio.checked = true;
}

/** @returns {'split'|'step'} aktuell gesetzte Ansicht */
export function getCompareView() {
  const panel = document.getElementById('compare-panel');
  return panel?.dataset?.view || 'split';
}

/** Die Radios der Ansichtsumschaltung verdrahten. */
export function initViewToggle() {
  const inputs = document.querySelectorAll('input[name="view-mode"]');
  inputs.forEach((input) => {
    input.addEventListener('change', () => setCompareView(input.value));
  });
}

// ── Drag & Drop über das ganze Dokument ─────────────────────────────────────

/**
 * Dokumentweite Datei-Ablage. Ersetzt die bisherigen Handler am #drop-zone:
 * Ereignisse am drop-zone blubbern nach oben, bestehende Tests bleiben gültig.
 * @param {{onFile?: (file: File) => void}} options
 * @returns {() => void} Aufräumfunktion (entfernt die Listener wieder)
 */
export function initDocumentDrop(options = {}) {
  const onFile = options?.onFile;

  // Ein zweiter Aufruf ersetzt die erste Registrierung (kein doppeltes onFile).
  if (dropCleanup) { dropCleanup(); dropCleanup = null; }

  const onDragEnter = (e) => {
    if (!_containsFiles(e)) return;
    dragDepth++;
    showDropHint();
  };

  const onDragOver = (e) => {
    if (!_containsFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    showDropHint();
  };

  const onDragLeave = () => {
    // Zähler nie unter null; Text-Drags haben nie erhöht → sie blenden nichts aus.
    if (dragDepth <= 0) return;
    dragDepth--;
    if (dragDepth === 0) hideDropHint();
  };

  const onDrop = (e) => {
    e.preventDefault();
    dragDepth = 0;
    hideDropHint();
    const file = e.dataTransfer?.files?.[0];
    if (file && typeof onFile === 'function') onFile(file);
  };

  document.addEventListener('dragenter', onDragEnter);
  document.addEventListener('dragover', onDragOver);
  document.addEventListener('dragleave', onDragLeave);
  document.addEventListener('drop', onDrop);

  dropCleanup = () => {
    document.removeEventListener('dragenter', onDragEnter);
    document.removeEventListener('dragover', onDragOver);
    document.removeEventListener('dragleave', onDragLeave);
    document.removeEventListener('drop', onDrop);
  };
  return dropCleanup;
}

// Enthält der Zug Dateien? (Text-Drags werden ignoriert.)
function _containsFiles(e) {
  const types = e.dataTransfer?.types;
  if (!types) return false;
  return Array.from(types).includes('Files');
}

// Hinweis einblenden — je nach Zustand des Körpers anders.
function showDropHint() {
  const state = document.body?.dataset?.state || 'empty';

  if (state === 'empty') {
    // Startbildschirm: die Ablagefläche selbst bekommt den Akzentrahmen.
    const dropZone = document.getElementById('drop-zone');
    if (dropZone) dropZone.classList.add('dragover');
  } else if (state === 'done' || state === 'error' || state === 'inspect') {
    // Etwas ist schon da: ein leichter Hinweis, dass die Datei ersetzt wird.
    const overlay = document.getElementById('drop-overlay');
    if (overlay) {
      overlay.removeAttribute('hidden');
      overlay.setAttribute('aria-hidden', 'false');
    }
  }
  // Im Zustand „running“ wird nichts eingeblendet (die Analyse läuft schon).
}

// Hinweis wieder ausblenden.
function hideDropHint() {
  const dropZone = document.getElementById('drop-zone');
  if (dropZone) dropZone.classList.remove('dragover');

  const overlay = document.getElementById('drop-overlay');
  if (overlay) {
    overlay.setAttribute('hidden', '');
    overlay.setAttribute('aria-hidden', 'true');
  }
}

// ── Zeichnen abwarten ───────────────────────────────────────────────────────

/**
 * Zwei Bilder aushalten — nötig, damit ein Skelett vor der synchronen Rechnung
 * wirklich gezeichnet wird (Popup rechnet bis zu 30 s blockierend).
 * @returns {Promise<void>}
 */
export function nextPaint() {
  return new Promise((resolve) => {
    const raf = typeof requestAnimationFrame === 'function'
      ? (fn) => requestAnimationFrame(fn)
      : (fn) => setTimeout(fn, 0);
    raf(() => raf(() => resolve()));
  });
}

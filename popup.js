import { formatBytesDe, describeDetailLevel } from './utils.js?v=2';
import { buildOutlinesDxf, buildOutlinesStep, buildVolumeStepBrepV2, buildVolumeStepTriangles } from './exporters.js?v=48';

import { initPipelineViewers, updateStlViewer, updateFeaturesViewer, updateBrepViewer } from './viewers.js?v=32';
import { initStepOcctViewer, loadStepIntoViewer } from './step-viewer.js?v=22';
import { buildVerdict, renderVerdict, clearVerdict, renderVerdictPending, renderVerdictError } from './verdict.js?v=6';
import { initTabs, initViewToggle, initFullscreen, setCompareView, initDocumentDrop, nextPaint } from './layout.js?v=5';
import { applyFeatureColorVars, buildFeatureLegend } from './feature-colors.js?v=1';
import {
  setStatus, setExportEnabled,
  setProgress, progressStep, startIndeterminateProgress, stopIndeterminateProgress,
  initProgressSteps, resetProgressSteps, setProgressStepStatus, setLiveDetail,
  handleWorkerProgress, getActiveStep, getStepByKey, setProgressStepCurrent
} from './ui.js?v=4';
import {
  updateStats, resetStats, renderOutlines, clearOutlines
} from './tables.js';
import {
  setPreviewData, renderPreview3D, initPreviewEvents, initPreviewModeToggle
} from './preview.js';

// ── Extension API ───────────────────────────────────────────────────────────

const extensionApi = typeof browser !== 'undefined' ? browser
  : typeof chrome !== 'undefined' ? chrome : null;

// ── DOM references ──────────────────────────────────────────────────────────

const fileInput          = document.getElementById('file-input');
const dropZone           = document.getElementById('drop-zone');
const paramOutput        = document.getElementById('param-output');
const copyBtn            = document.getElementById('copy-json');
const downloadBtn        = document.getElementById('download-json');
const downloadDxfBtn     = document.getElementById('download-dxf');
const downloadStepBtn    = document.getElementById('download-step');
const downloadStepSolBtn = document.getElementById('download-step-solid');
const detailSlider       = document.getElementById('detail-level');
const detailValueLabel   = document.getElementById('detail-value');
const detailHint         = document.getElementById('detail-hint');

// Basis-Hilfetext des Schalters „Blech-Biegungen schärfen“ (einmal gelesen).
const SHARPEN_BENDS_HELP_BASE = (document.getElementById('sharpen-bends-help')?.textContent || '').trim();

// ── State ───────────────────────────────────────────────────────────────────

let lastAnalysis   = null;
let lastSourceBuffer = null;
let lastFileName   = null;
let lastFileSize   = 0;
let isProcessing   = false;
let detailLevel    = detailSlider ? Number(detailSlider.value) : 70;

// Export-Cache: { key: JSON.stringify(exportOptions()), res: buildVolumeStepBrepV2(...) }.
// Verhindert, dass die STEP für jede Ansicht neu gebaut wird (Freiform: bis zu 30 s).
let lastExport     = null;

// Auto-Vorschau „Nachher“: Schwellen, ab denen der STEP-Viewer von selbst rendert.
let AUTO_RENDER_MAX_FACES = 3000;
let AUTO_RENDER_MAX_BYTES = 4000000;
window.__setAutoRenderLimits = (faces, bytes) => {
  if (Number.isFinite(faces)) AUTO_RENDER_MAX_FACES = faces;
  if (Number.isFinite(bytes)) AUTO_RENDER_MAX_BYTES = bytes;
};

// Wurde die Nachher-Vorschau schon einmal gezeigt? (Text „Vorschau veraltet – neu laden“)
let previewShown   = false;

const workerJobs     = new Map();
let workerJobCounter = 0;

// ── Export-Optionen (ui-spec.md 6.1) ───────────────────────────────────────
// Alle vier sind EXPORT-Optionen (Hauptthread, buildVolumeStepBrepV2) und keine
// Worker-Optionen: eine Änderung rechnet nur das Verdikt neu, nicht die Analyse.
const _defeatureOn       = () => document.getElementById('defeature-toggle')?.checked !== false;
const _sharpenBendsOn    = () => document.getElementById('sharpen-bends-toggle')?.checked === true;
const _extrusionBandsOn  = () => document.getElementById('extrusion-bands-toggle')?.checked !== false;  // Standard AN
const _fitSegmentationOn = () => document.getElementById('fit-segmentation-toggle')?.checked === true;  // Standard AUS
const exportOptions = () => ({
  defeature: _defeatureOn(), sharpenBends: _sharpenBendsOn(),
  extrusionBands: _extrusionBandsOn(),          // exporters.js:432  EXT = ARCS && extrusionBands !== false
  fitSegmentation: _fitSegmentationOn()         // exporters.js:405  nur true/'auto' aktiviert Freiform → false = heutiges Verhalten
});
const withExportOptions = (a) => (a ? { ...a, ...exportOptions() } : a);
window.__exportOptions = exportOptions;

const WORKER_TIMEOUT_MS = 60000;

// Kleinste Detailgröße (mesh-clean.js im Worker): Kanten darunter werden vor der Analyse
// kollabiert. 0 = aus. Standard 0,02 mm (Begründung in mesh-clean.js, Auswahl in popup.html).
const _minDetailMm = () => {
  const v = Number(document.getElementById('min-detail-select')?.value);
  return Number.isFinite(v) && v >= 0 ? v : 0.02;
};

// ── Worker setup ─────────────────────────────────────────────────────────────

const analysisWorker = _createAnalysisWorker();

function _createAnalysisWorker() {
  const workerUrl = extensionApi?.runtime?.getURL
    ? extensionApi.runtime.getURL('analysis-worker.js')
    : 'analysis-worker.js?v=21';
  const worker = new Worker(workerUrl, { type: 'module' });

  worker.onmessage = (event) => {
    const { id, ok, analysis, message, progress } = event.data || {};
    const job = workerJobs.get(id);
    if (!job) return;
    if (progress) { job.progress?.(progress); return; }
    workerJobs.delete(id);
    if (ok) job.resolve(analysis);
    else    job.reject(new Error(message || 'Analyse fehlgeschlagen.'));
  };

  worker.onerror = (event) => {
    console.error('Analyse-Worker Fehler', event);
    const msg = event?.message || 'Analyse-Worker Fehler – Details in der Konsole.';
    workerJobs.forEach(({ reject }, id) => { reject(new Error(msg)); workerJobs.delete(id); });
  };

  return worker;
}

function _runWorkerAnalysis(buffer, fileName, detail, onProgress, { reanalyzeOnly = false } = {}) {
  return new Promise((resolve, reject) => {
    const id    = ++workerJobCounter;
    const timer = setTimeout(() => {
      if (workerJobs.has(id)) {
        workerJobs.delete(id);
        reject(new Error('Analyse-Timeout: Die Verarbeitung hat zu lange gedauert (>60s). Versuche eine kleinere Datei.'));
      }
    }, WORKER_TIMEOUT_MS);

    workerJobs.set(id, {
      resolve: (r)   => { clearTimeout(timer); resolve(r); },
      reject:  (err) => { clearTimeout(timer); reject(err); },
      progress: onProgress
    });

    if (reanalyzeOnly) {
      analysisWorker.postMessage({ id, fileName, detailLevel: detail, reanalyzeOnly: true });
    } else {
      analysisWorker.postMessage({ id, buffer, fileName, detailLevel: detail, minDetailMm: _minDetailMm() }, [buffer]);
    }
  });
}

// ── File handling ─────────────────────────────────────────────────────────────

async function handleFile(file) {
  // Während einer laufenden Analyse keine neue Datei annehmen.
  if (isProcessing) return;
  const buffer = await file.arrayBuffer();
  if (isProcessing) return;
  lastSourceBuffer = buffer.slice(0);
  lastFileName     = file.name;
  lastFileSize     = buffer.byteLength;

  // Datei-Chip in der Kopfzeile (Name sofort, Größe nach der Analyse mit den Dreiecken).
  setFileChip(file.name, formatBytesDe(lastFileSize));

  await runAnalysis({ buffer: lastSourceBuffer, fileName: lastFileName, reason: 'upload', fileSize: lastFileSize });
}

async function reprocessDetailLevel() {
  if (!lastSourceBuffer || !lastFileName || isProcessing) return;
  await runAnalysis({ buffer: lastSourceBuffer, fileName: lastFileName, reason: 'detail', fileSize: lastFileSize });
}

// ── Zustände (ui-spec.md 3 + 6.2) ───────────────────────────────────────────

/**
 * Zustand des whole Popup setzen. Neben `body[data-state]` werden die Bereiche
 * über das `hidden`-Attribut ein- und ausgeblendet (robust auch ohne CSS).
 * @param {'empty'|'running'|'done'|'error'|'inspect'} state
 */
function setViewState(state) {
  document.body.dataset.state = state;

  const setHidden = (id, hidden) => {
    const el = document.getElementById(id);
    if (el) el.hidden = hidden;
  };

  setHidden('start-view',    state !== 'empty');
  setHidden('verdict-card',  state === 'empty' || state === 'inspect');
  setHidden('options-panel', state === 'inspect');
  setHidden('compare-panel', state === 'empty' || state === 'error');
  setHidden('expert-panel',  state !== 'done');
  setHidden('file-chip',     state === 'empty');
  setHidden('file-change',   state === 'empty');

  // Das Menü „Weitere Formate“ gehört zum Verdikt-Kasten: beim Zustandswechsel schließen.
  const moreFormats = document.getElementById('more-formats');
  if (moreFormats) moreFormats.open = false;

  // Bildunterschrift der Nachher-Ansicht: im Zustand „inspect“ steht dort eine
  // angesehene STEP-Datei, sonst der künftige Export.
  const figStepTitle = document.getElementById('fig-step-title');
  if (figStepTitle) {
    figStepTitle.textContent = (state === 'inspect') ? 'Angesehene STEP-Datei' : 'STEP – so wird exportiert';
  }

  // Die Ansichtsumschaltung „Vergleich | Nur STEP“ gibt es im Zustand „inspect“
  // nicht — sie würde dort in die leere Original-Ansicht führen.
  const seg = document.querySelector('#compare-panel .seg');
  if (seg) seg.hidden = (state === 'inspect');

  if (state !== 'inspect') {
    const title = document.getElementById('compare-title');
    if (title) title.textContent = 'Vorher / Nachher';
  }
}

// ── Export-Cache (ui-spec.md 6.3) ────────────────────────────────────────────

/** Basiname der analysierten Datei (ohne Endung) — für STEP-Dateinamen und Hinweise. */
function fileBase() {
  return (lastAnalysis?.meta?.fileName || lastFileName || 'model').replace(/\.[^.]+$/, '');
}

/** Export neu bauen und im Cache ablegen. */
function recomputeExport() {
  if (!lastAnalysis) {
    window.__lastExport = null;
    return null;
  }
  const key = JSON.stringify(exportOptions());
  const res = buildVolumeStepBrepV2(withExportOptions(lastAnalysis));
  lastExport = { key, res };
  window.__lastExport = res;
  return res;
}

/** Export aus dem Cache, wenn die Optionen noch passen — sonst neu bauen. */
function currentExport() {
  if (lastExport && lastExport.key === JSON.stringify(exportOptions())) return lastExport.res;
  return recomputeExport();
}

// ── Auto-Vorschau „Nachher“ (ui-spec.md 4) ──────────────────────────────────

/**
 * Nachher-Viewer automatisch rendern, wenn das Modell klein genug ist.
 * Sonst bleibt der Platzhalter mit „3D-Vorschau laden“ stehen.
 * @param {object|null} res  Ergebnis von buildVolumeStepBrepV2
 * @param {{changed?: boolean}} opts  changed = true nach einer Schalteränderung
 */
function autoPreview(res, { changed = false } = {}) {
  const ph     = document.getElementById('step-occt-placeholder');
  const phText = document.getElementById('step-occt-placeholder-text');
  const btn    = document.getElementById('step-render-button');

  const faces = res?.report?.faceCount ?? Infinity;
  if (res?.step && faces <= AUTO_RENDER_MAX_FACES && res.step.length <= AUTO_RENDER_MAX_BYTES) {
    if (ph) ph.hidden = true;
    loadStepIntoViewer(new TextEncoder().encode(res.step).buffer);
    previewShown = true;
  } else {
    if (ph) ph.hidden = false;
    if (phText) {
      phText.textContent = (changed && previewShown)
        ? 'Vorschau veraltet – neu laden'
        : 'Großes Modell – 3D-Vorschau auf Wunsch.';
    }
    if (btn) btn.disabled = !res?.step;
  }
}

// ── Main analysis pipeline ────────────────────────────────────────────────────

async function runAnalysis({ buffer, fileName, reason = 'upload', fileSize = 0 }) {
  if (!buffer || !fileName || isProcessing) return;
  const focusBefore = document.activeElement;
  isProcessing = true;
  lastExport = null;
  if (reason !== 'detail') {
    // Altdaten verwerfen: zu einer neuen Datei darf kein Ergebnis der
    // vorherigen Datei stehen bleiben.
    lastAnalysis = null;
    window.__lastExport = null;
  }
  const normalizedDetail = Math.max(0.1, Math.min(0.99, detailLevel / 100));
  const sizeLabel = formatBytesDe(fileSize || buffer.byteLength || 0);
  // Merkt sich, ob der Worker das Einlesen schon überstanden hat (Fortschritt ≥ 38 %).
  let readDone = false;

  resetProgressSteps(reason, sizeLabel);
  if (reason === 'upload') setProgressStepStatus('read', 'active', 'liest Datei …');
  else                     setProgressStepStatus('read', 'done', 'Cache');

  try {
    if (reason !== 'detail') {
      // Aus dem Zustand „STEP ansehen“ zurück in den normalen Ablauf.
      if (document.body.dataset.state === 'inspect') setCompareView('split');
      setViewState('running');
      // Bildunterschriften und Vorschau leeren — während der Analyse dürfen keine
      // Werte der vorherigen Datei stehen bleiben.
      const figOriginalMeta = document.getElementById('fig-original-meta');
      if (figOriginalMeta) figOriginalMeta.textContent = '';
      const figStepMeta = document.getElementById('fig-step-meta');
      if (figStepMeta) figStepMeta.textContent = '';
      const placeholder = document.getElementById('step-occt-placeholder');
      if (placeholder) placeholder.hidden = true;
    }

    if (reason === 'upload') {
      resetUI('lädt …', null);
      renderVerdictPending();
      setStatus(`Analysiere ${fileName} …`, 'processing');
      await progressStep(0.05, 'Datei wird gelesen …');
      setProgressStepStatus('read', 'active', 'liest Datei …');
    } else {
      setStatus('Detail wird neu angewandt …', 'processing');
      await progressStep(0.12, 'Detail wird neu angewandt …');
    }

    setExportEnabled(false);
    const _renderBtn = document.getElementById('step-render-button');
    const _exportBtn = document.getElementById('step-export-button');
    const _exportTriBtn = document.getElementById('step-export-triangles-button');
    if (_renderBtn) _renderBtn.disabled = true;
    if (_exportBtn) _exportBtn.disabled = true;
    if (_exportTriBtn) _exportTriBtn.disabled = true;
    await progressStep(0.2, reason === 'upload' ? 'Analyse-Worker wird vorbereitet …' : 'Neue Konturen werden berechnet …');
    if (reason === 'upload') setProgressStepStatus('read', 'done', sizeLabel ? `~${sizeLabel}` : 'fertig');
    setProgressStepStatus('prepare', 'active', 'Analyse wird initialisiert …');

    const workerLabel   = `Analyse läuft … (~${sizeLabel}) · Detail ${detailLevel}%`;
    const reanalyzeOnly = reason === 'detail';
    const workerBuffer  = reanalyzeOnly ? null : buffer.slice(0);
    setProgressStepStatus('prepare', 'done', 'bereit');
    setProgressStepStatus('projection', 'active', 'Projektionen berechnen …');
    setLiveDetail(workerLabel);
    startIndeterminateProgress(0.25, workerLabel);

    const analysis = await _runWorkerAnalysis(
      workerBuffer, fileName, normalizedDetail,
      // Wrapper: merkt sich, ob das Einlesen der Datei schon durch ist.
      (p) => {
        if (Number.isFinite(p?.ratio) && p.ratio >= 0.38) readDone = true;
        handleWorkerProgress(p);
      },
      { reanalyzeOnly }
    );
    lastAnalysis = analysis;

    paramOutput.value = JSON.stringify(analysis.parametric, null, 2);
    setPreviewData(analysis.previewPoints, analysis.boundingBox);
    stopIndeterminateProgress(0.95, 'Ergebnisse rendern …');

    ['projection','planar','cylinder','cone','sphere','volume'].forEach((k) => setProgressStepStatus(k, 'done', '✓'));
    setLiveDetail('Ergebnisse rendern …');
    await progressStep(0.96, 'Ergebnisse rendern …');

    updateStats(analysis.boundingBox, analysis.meta);
    renderOutlines(analysis.outlines);

    try { updateStlViewer(analysis.triangles, analysis.boundingBox); }      catch (e) { console.warn('STL viewer error:', e.message); }
    try { updateFeaturesViewer(analysis.triangles, analysis, analysis.boundingBox); } catch (e) { console.warn('Features viewer error:', e.message); }
    window.__analysisDebug = analysis; // DEBUG
    try { updateBrepViewer(null, analysis.boundingBox, analysis); } catch (e) { console.warn('B-Rep viewer error:', e.message); }

    // Export-Knöpfe freigeben. Der Nachher-Viewer rendert nicht automatisch —
    // er wird nach der Analyse über autoPreview() entschieden (Schwellen!).
    const exportBtn = document.getElementById('step-export-button');
    const exportTriBtn = document.getElementById('step-export-triangles-button');
    if (exportBtn) exportBtn.disabled = false;
    if (exportTriBtn) exportTriBtn.disabled = false;

    // Wasserdichtigkeits-Verdikt sofort anzeigen (rein geometrisch, ohne occt-Parsing).
    // „Rendern" visualisiert es danach zusätzlich im 3D-Viewer.
    try {
      const res = recomputeExport();
      renderVerdict(buildVerdict(res?.report ?? null, analysis, { defeature: _defeatureOn() }), { res, fileBase: fileBase() });
      setFigStepMeta(res?.report?.faceCount);
    } catch (e) { console.warn('Verdikt-Update fehlgeschlagen:', e.message); }

    // Kopfzeile: Größe + Dreiecke, Vergleichsansicht: Dreiecke und CAD-Flächen.
    const triText = analysis?.meta?.triangles?.toLocaleString('de-DE') ?? '?';
    setFileChip(fileName, `${formatBytesDe(lastFileSize)} · ${triText} Dreiecke`);
    const figOriginalMeta = document.getElementById('fig-original-meta');
    if (figOriginalMeta) figOriginalMeta.textContent = `${triText} Dreiecke`;

    setProgressStepStatus('exports', 'active', 'Exports werden vorbereitet …');
    setLiveDetail('Exports werden vorbereitet …');
    await progressStep(0.9, 'Exports werden vorbereitet …');
    setExportEnabled(true);
    setProgressStepStatus('exports', 'done', 'bereit');
    await progressStep(1, 'Fertig');
    setStatus(reason === 'detail' ? 'Detailgrad aktualisiert.' : 'Analyse abgeschlossen.', 'success');
    setLiveDetail('Analyse abgeschlossen.');
    setViewState('done');
    setProgressStepCurrent('');
    autoPreview(lastExport?.res);

    // Fokus: nach einem Upload auf den Hauptknopf — aber nur, wenn der Fokus vorher
    // neutral war (nicht, wenn der User gerade im Expertenbereich oder einem Schalter war).
    if (reason === 'upload') {
      const inDropZone = dropZone && focusBefore
        && typeof focusBefore.closest === 'function'
        && dropZone.contains(focusBefore);
      // Die Datei-Knöpfe sind ebenfalls neutral: von dort aus startet die Dateiauswahl.
      const onFileButton = focusBefore
        && ['file-pick-button', 'file-change', 'file-pick-error'].some(
          (id) => document.getElementById(id) === focusBefore);
      const neutral = !focusBefore
        || focusBefore === document.body
        || focusBefore === dropZone
        || focusBefore === fileInput
        || onFileButton
        || inDropZone;
      if (neutral) document.getElementById('step-export-button')?.focus();
    }
  } catch (error) {
    console.error(error);
    stopIndeterminateProgress();
    // Ergebnis verwerfen: nach einem Fehler darf kein alter Export benutzt werden.
    lastAnalysis = null;
    lastExport = null;
    window.__lastExport = null;
    // Scheitert schon das Einlesen, steht Schritt 1 in der Fehlerzeile.
    // (vor resetUI — das setzt den aktiven Schritt zurück)
    const step = (reason === 'upload' && !readDone) ? getStepByKey('read') : getActiveStep();
    resetUI('Fehler', null);
    setStatus(`Fehler beim Einlesen: ${error.message}`, 'error');
    setLiveDetail('Fehler beim Einlesen');
    const stepText = step ? `Abgebrochen bei Schritt ${step.index}: ${step.label}` : 'Abgebrochen';
    setProgressStepCurrent(stepText);
    renderVerdictError(error.message, stepText);
    setViewState('error');
  } finally {
    isProcessing = false;
  }
}

// ── Reset UI ──────────────────────────────────────────────────────────────────

function resetUI(message = '–', statusPayload = { text: 'Bereit – lege eine STL-Datei ab.', state: 'idle' }) {
  resetStats(message);
  paramOutput.value = '';
  setExportEnabled(false);
  stopIndeterminateProgress();
  setProgress(0, 'Bereit');
  resetProgressSteps('idle');
  clearOutlines();
  if (statusPayload) {
    setStatus(statusPayload.text, statusPayload.state);
    setViewState('empty');
  }
  setPreviewData();
  setProgress(0, 'Bereit');
  clearVerdict();
  lastExport = null;
  // Bildunterschriften leeren — sonst stehen hier die Werte der letzten Datei.
  const figOriginalMeta = document.getElementById('fig-original-meta');
  if (figOriginalMeta) figOriginalMeta.textContent = '';
  const figStepMeta = document.getElementById('fig-step-meta');
  if (figStepMeta) figStepMeta.textContent = '';
  const placeholder = document.getElementById('step-occt-placeholder');
  if (placeholder) placeholder.hidden = true;
}

// ── Hilfen für die Anzeige ───────────────────────────────────────────────────

/**
 * Datei-Chip in der Kopfzeile setzen: Name, Zusatzinfo und Tooltip.
 * @param {string} name  Dateiname (z. B. 'Bauteil.stl')
 * @param {string} meta  Zusatzinfo (Größe, Dreiecke …); leer = nur der Name
 */
function setFileChip(name, meta = '') {
  const title   = meta ? `${name} · ${meta}` : name;
  const chip     = document.getElementById('file-chip');
  const chipName = document.getElementById('file-chip-name');
  const chipMeta = document.getElementById('file-chip-meta');
  if (chipName) {
    chipName.textContent = name;
    chipName.title = title;
  }
  if (chipMeta) chipMeta.textContent = meta || '';
  if (chip) chip.title = title;
}

/** Flächenzahl der STEP in der Bildunterschrift der Nachher-Ansicht. */
function setFigStepMeta(faceCount) {
  const el = document.getElementById('fig-step-meta');
  if (!el) return;
  const n = Number.isFinite(faceCount) ? faceCount.toLocaleString('de-DE') : '–';
  el.textContent = `${n} Flächen`;
}

/** Schalter „Blech-Biegungen schärfen“: nur mit „Verrundungen entfernen“ wirksam. */
function syncSharpenBends() {
  const toggle = document.getElementById('sharpen-bends-toggle');
  const help   = document.getElementById('sharpen-bends-help');
  if (toggle) toggle.disabled = !_defeatureOn();
  if (help) {
    help.textContent = _defeatureOn()
      ? SHARPEN_BENDS_HELP_BASE
      : 'Nur zusammen mit „Verrundungen entfernen“ wirksam. ' + SHARPEN_BENDS_HELP_BASE;
  }
}

// ── Detail slider ─────────────────────────────────────────────────────────────

function updateDetailUI() {
  if (detailValueLabel) detailValueLabel.textContent = `${detailLevel}%`;
  if (detailHint) detailHint.textContent = `Automatik + Regler liefern ${describeDetailLevel(detailLevel)}.`;
}

// ── Event wiring ──────────────────────────────────────────────────────────────

fileInput?.addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';          // immer zurücksetzen, damit dieselbe Datei erneut gewählt werden kann
  if (file && !isProcessing) handleFile(file);
});

// Die drei Datei-Knöpfe öffnen den Dateidialog (die Beschriftung eines <label>
// ist nicht per Tastatur bedienbar).
['file-pick-button', 'file-change', 'file-pick-error'].forEach((id) => {
  document.getElementById(id)?.addEventListener('click', () => fileInput?.click());
});

if (detailSlider) {
  updateDetailUI();
  detailSlider.addEventListener('input', () => {
    detailLevel = Number(detailSlider.value);
    updateDetailUI();
  });
  detailSlider.addEventListener('change', () => {
    detailLevel = Number(detailSlider.value);
    updateDetailUI();
    reprocessDetailLevel();
  });
}

copyBtn?.addEventListener('click', async () => {
  if (!paramOutput.value) return;
  await navigator.clipboard?.writeText?.(paramOutput.value);
  copyBtn.textContent = 'Kopiert';
  setTimeout(() => (copyBtn.textContent = 'JSON kopieren'), 1500);
});

downloadBtn?.addEventListener('click', () => {
  if (!lastAnalysis) {
    setStatus('Keine Analysedaten vorhanden. Bitte zuerst eine STL-Datei analysieren.', 'error');
    return;
  }
  const blob = new Blob([paramOutput.value], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `${(lastAnalysis?.meta?.fileName || 'parametric-sketch').replace(/\.[^.]+$/, '')}-parametric.json`;
  a.click();
  URL.revokeObjectURL(url);
});

downloadDxfBtn?.addEventListener('click', () => {
  if (!lastAnalysis?.outlines) {
    setStatus('Keine Outline-Daten vorhanden. Bitte zuerst eine STL-Datei analysieren.', 'error');
    return;
  }
  const dxf  = buildOutlinesDxf(lastAnalysis.outlines);
  const blob = new Blob([dxf], { type: 'application/dxf' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `${(lastAnalysis?.meta?.fileName || 'parametric-sketch').replace(/\.[^.]+$/, '')}-outlines.dxf`;
  a.click();
  URL.revokeObjectURL(url);
});

downloadStepBtn?.addEventListener('click', () => {
  if (!lastAnalysis?.outlines) {
    setStatus('Keine Outline-Daten vorhanden. Bitte zuerst eine STL-Datei analysieren.', 'error');
    return;
  }
  try {
    const step = buildOutlinesStep(lastAnalysis.outlines);
    const blob = new Blob([step], { type: 'application/step' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `${(lastAnalysis?.meta?.fileName || 'parametric-sketch').replace(/\.[^.]+$/, '')}-outlines.step`;
    a.click();
    URL.revokeObjectURL(url);
    setStatus('STEP-Skizze exportiert (2D-Konturen der 3 Orthogonalprojektionen).', 'success');
  } catch (err) {
    console.error(err);
    setStatus(`STEP-Skizze fehlgeschlagen: ${err.message}`, 'error');
  }
});

downloadStepSolBtn?.addEventListener('click', () => {
  if (!lastAnalysis) {
    setStatus('Keine Analysedaten vorhanden. Bitte zuerst eine STL-Datei analysieren.', 'error');
    return;
  }
  try {
    const res = currentExport();
    if (!res?.step) {
      setStatus('STEP-Volumen fehlgeschlagen: zu wenig Flächen erkannt.', 'error');
      return;
    }
    renderVerdict(buildVerdict(res.report ?? null, lastAnalysis, { defeature: _defeatureOn() }), { res, fileBase: fileBase() });
    const blob = new Blob([res.step], { type: 'application/step' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `${(lastAnalysis?.meta?.fileName || 'parametric-sketch').replace(/\.[^.]+$/, '')}-volume.step`;
    a.click();
    URL.revokeObjectURL(url);
    const tight = res.report?.watertight
      ? 'wasserdicht'
      : `${res.report?.boundaryEdges ?? 0} offene Kanten`;
    setStatus(`STEP-Volumen exportiert (${res.report?.faceCount ?? 0} Flächen, ${tight}).`, 'success');
  } catch (err) {
    console.error(err);
    setStatus(`STEP-Volumen fehlgeschlagen: ${err.message}`, 'error');
  }
});

document.getElementById('step-export-button')?.addEventListener('click', () => {
  downloadStepSolBtn?.click();
});

document.getElementById('step-export-triangles-button')?.addEventListener('click', () => {
  if (!lastAnalysis) {
    setStatus('Keine Analysedaten. Bitte zuerst eine STL-Datei analysieren.', 'error');
    return;
  }
  try {
    const step = buildVolumeStepTriangles(lastAnalysis);
    if (!step) {
      setStatus('STEP Triangles fehlgeschlagen: keine Dreiecke.', 'error');
      return;
    }
    const blob = new Blob([step], { type: 'application/step' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `${(lastAnalysis?.meta?.fileName || 'model').replace(/\.[^.]+$/, '')}-triangles.step`;
    a.click();
    URL.revokeObjectURL(url);
    setStatus('STEP Triangles exportiert.', 'success');
  } catch (err) {
    console.error(err);
    setStatus(`STEP Triangles fehlgeschlagen: ${err.message}`, 'error');
  }
});

document.getElementById('step-render-button')?.addEventListener('click', () => {
  if (!lastAnalysis) {
    setStatus('Keine Analysedaten. Bitte STL neu analysieren.', 'error');
    return;
  }
  try {
    // Panel 4 prüft den V2-Boundary-Loop-STEP — genau das, was exportiert wird.
    // (Der Triangle-STEP wäre per Konstruktion immer geschlossen und damit als
    //  Dichtheitsprüfung wertlos.)
    const res = currentExport();
    if (!res?.step) {
      setStatus('Panel 4 Render fehlgeschlagen: zu wenig Flächen.', 'error');
      return;
    }
    renderVerdict(buildVerdict(res.report ?? null, lastAnalysis, { defeature: _defeatureOn() }), { res, fileBase: fileBase() });
    setStatus('Nachher-Vorschau wird geladen (kann bei großen Modellen dauern) …', 'processing');
    loadStepIntoViewer(new TextEncoder().encode(res.step).buffer);
    const placeholder = document.getElementById('step-occt-placeholder');
    if (placeholder) placeholder.hidden = true;
    previewShown = true;
  } catch (err) {
    console.error(err);
    setStatus(`Panel 4 Render fehlgeschlagen: ${err.message}`, 'error');
  }
});

/**
 * Beobachtet den Ladezustand des Nachher-Viewers und meldet ihn in der
 * Statuszeile – nur solange dort noch „wird geladen …“ steht.
 */
function initStepPreviewStatusWatch() {
  const viewer = document.getElementById('step-occt-viewer');
  if (!viewer || typeof MutationObserver === 'undefined') return;
  const banner = document.getElementById('status-banner');

  const observer = new MutationObserver(() => {
    const state = viewer.getAttribute('data-state');
    if (state !== 'ready' && state !== 'error') return;
    if (!banner || !banner.classList.contains('status--processing')) return;
    if (document.body?.dataset?.state !== 'done') return;
    if (state === 'ready') setStatus('3D-Vorschau geladen.', 'success');
    else                   setStatus('3D-Vorschau konnte nicht geladen werden.', 'error');
  });

  observer.observe(viewer, { attributes: true, attributeFilter: ['data-state'] });
}

// Kleinste Detailgröße geändert: das Netz selbst ändert sich → Datei komplett neu analysieren
// (der Detail-Regler nutzt das gecachte, bereits bereinigte Netz).
document.getElementById('min-detail-select')?.addEventListener('change', async () => {
  if (!lastSourceBuffer || !lastFileName || isProcessing) return;
  const note = document.getElementById('options-note');
  if (note) note.textContent = 'Datei wird neu analysiert …';
  await runAnalysis({ buffer: lastSourceBuffer, fileName: lastFileName, reason: 'upload', fileSize: lastFileSize });
  if (note) note.textContent = 'Wirken sofort auf das Ergebnis.';
});

// Gemeinsamer Handler für alle vier Export-Schalter (ui-spec.md 6.1).
async function onExportOptionChange() {
  syncSharpenBends();
  // Die Schalter wirken nur im Zustand „fertig“ — im Fehler-, Lauf- oder Leerzustand
  // gibt es kein Ergebnis, das neu berechnet werden könnte.
  if (document.body.dataset.state !== 'done') return;
  if (!lastAnalysis || isProcessing) return;   // die Optionen werden beim Analyse-Ende neu gelesen

  const card      = document.getElementById('verdict-card');
  const note      = document.getElementById('options-note');
  const exportBtn = document.getElementById('step-export-button');

  if (card) card.dataset.busy = 'true';
  if (note) note.textContent = 'Ergebnis wird neu berechnet …';
  if (exportBtn) exportBtn.disabled = true;
  await nextPaint();   // Skeleton malen, BEVOR die synchrone Rechnung blockiert

  try {
    const res = recomputeExport();
    renderVerdict(buildVerdict(res?.report ?? null, lastAnalysis, { defeature: _defeatureOn() }), { res, fileBase: fileBase() });
    setFigStepMeta(res?.report?.faceCount);
    autoPreview(res, { changed: true });
  } catch (e) {
    console.warn('Export-Option: Verdikt-Update fehlgeschlagen:', e.message);
  } finally {
    if (card) card.dataset.busy = 'false';
    if (note) note.textContent = 'Wirken sofort auf das Ergebnis.';
    if (exportBtn) exportBtn.disabled = !lastAnalysis || document.body.dataset.state !== 'done';
  }
}

document.getElementById('defeature-toggle')?.addEventListener('change', onExportOptionChange);
document.getElementById('sharpen-bends-toggle')?.addEventListener('change', onExportOptionChange);
document.getElementById('extrusion-bands-toggle')?.addEventListener('change', onExportOptionChange);
document.getElementById('fit-segmentation-toggle')?.addEventListener('change', onExportOptionChange);

// Fremde STEP-Datei über „STEP ansehen“ (step-viewer.js): Zustand „inspect“.
document.addEventListener('stlreverse:step-imported', (e) => {
  setViewState('inspect');
  setCompareView('step');
  const title = document.getElementById('compare-title');
  if (title) title.textContent = 'STEP-Datei ansehen';
  const placeholder = document.getElementById('step-occt-placeholder');
  if (placeholder) placeholder.hidden = true;
  setFileChip(e.detail?.name || 'STEP-Datei', 'STEP');
  const figStepMeta = document.getElementById('fig-step-meta');
  if (figStepMeta) figStepMeta.textContent = '';
  setStatus(`STEP-Datei geladen: ${e.detail?.name || ''}`, 'success');
});

// ── Menü „Weitere Formate“ ───────────────────────────────────────────────────

/**
 * Menü „Weitere Formate“: schließt nach einer Auswahl, bei Escape und bei einem
 * Klick außerhalb des Menüs.
 */
function initFormatsMenu() {
  const details = document.getElementById('more-formats');
  if (!details) return;
  const summary = details.querySelector('summary');
  const menu    = details.querySelector('.formats__menu');

  // (a) Auswahl im Menü → Menü schließen (der Klick-Handler des Knopfes läuft zuerst).
  menu?.addEventListener('click', () => { details.open = false; });

  // (b) Escape schließt das Menü und legt den Fokus auf die Überschrift.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !details.open) return;
    details.open = false;
    summary?.focus();
  });

  // (c) Klick außerhalb des Menüs → Menü schließen.
  document.addEventListener('pointerdown', (e) => {
    if (!details.open) return;
    if (details.contains(e.target)) return;
    details.open = false;
  });
}

// ── Init ──────────────────────────────────────────────────────────────────────

applyFeatureColorVars();
buildFeatureLegend(document.getElementById('feature-legend'));
initTabs();
initViewToggle();
initFullscreen();
initFormatsMenu();
initDocumentDrop({ onFile: (file) => handleFile(file) });
syncSharpenBends();

initProgressSteps();
initPreviewEvents();
initPreviewModeToggle();
try { initPipelineViewers(); }  catch (e) { console.warn('Pipeline viewers init failed:', e.message); }
try { initStepOcctViewer(); }   catch (e) { console.warn('STEP occt viewer init failed:', e.message); }
initStepPreviewStatusWatch();
resetUI();

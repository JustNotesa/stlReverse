import { formatBytes, describeDetailLevel } from './utils.js';
import { buildOutlinesDxf, buildOutlinesStep, buildVolumeStepBrepV2, buildVolumeStepTriangles } from './exporters.js?v=35';

import { initPipelineViewers, updateStlViewer, updateFeaturesViewer, updateBrepViewer } from './viewers.js?v=28';
import { initStepOcctViewer, loadStepIntoViewer } from './step-viewer.js?v=19';
import {
  setStatus, setExportEnabled,
  setProgress, progressStep, startIndeterminateProgress, stopIndeterminateProgress,
  initProgressSteps, resetProgressSteps, setProgressStepStatus, setLiveDetail,
  handleWorkerProgress
} from './ui.js';
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

// ── State ───────────────────────────────────────────────────────────────────

let lastAnalysis   = null;
let lastSourceBuffer = null;
let lastFileName   = null;
let lastFileSize   = 0;
let isProcessing   = false;
let detailLevel    = detailSlider ? Number(detailSlider.value) : 70;

const workerJobs     = new Map();
let workerJobCounter = 0;

// Defeaturing-Toggle: Verrundungen beim Export entfernen (Mündung → Kegel-Fase,
// gerade Kanten-Verrundung → scharfe Kante). Aus = Verrundungen bleiben facettiert.
const _defeatureOn = () => document.getElementById('defeature-toggle')?.checked !== false;
const withDefeature = (a) => (a ? { ...a, defeature: _defeatureOn() } : a);

const WORKER_TIMEOUT_MS = 60000;

// ── Worker setup ─────────────────────────────────────────────────────────────

const analysisWorker = _createAnalysisWorker();

function _createAnalysisWorker() {
  const workerUrl = extensionApi?.runtime?.getURL
    ? extensionApi.runtime.getURL('analysis-worker.js')
    : 'analysis-worker.js?v=19';
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
      analysisWorker.postMessage({ id, buffer, fileName, detailLevel: detail }, [buffer]);
    }
  });
}

// ── File handling ─────────────────────────────────────────────────────────────

async function handleFile(file) {
  const buffer = await file.arrayBuffer();
  lastSourceBuffer = buffer.slice(0);
  lastFileName     = file.name;
  lastFileSize     = buffer.byteLength;
  await runAnalysis({ buffer: lastSourceBuffer, fileName: lastFileName, reason: 'upload', fileSize: lastFileSize });
}

async function reprocessDetailLevel() {
  if (!lastSourceBuffer || !lastFileName || isProcessing) return;
  await runAnalysis({ buffer: lastSourceBuffer, fileName: lastFileName, reason: 'detail', fileSize: lastFileSize });
}

// ── Main analysis pipeline ────────────────────────────────────────────────────

async function runAnalysis({ buffer, fileName, reason = 'upload', fileSize = 0 }) {
  if (!buffer || !fileName || isProcessing) return;
  isProcessing = true;
  const normalizedDetail = Math.max(0.1, Math.min(0.99, detailLevel / 100));
  const sizeLabel = formatBytes(fileSize || buffer.byteLength || 0);

  resetProgressSteps(reason, sizeLabel);
  if (reason === 'upload') setProgressStepStatus('read', 'active', 'liest Datei …');
  else                     setProgressStepStatus('read', 'done', 'Cache');

  try {
    if (reason === 'upload') {
      resetUI('lädt …', null);
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
      workerBuffer, fileName, normalizedDetail, handleWorkerProgress, { reanalyzeOnly }
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

    // Panel 4 rendert nicht automatisch — User klickt „Rendern" (setzt V2-Boundary-Loop).
    const renderBtn = document.getElementById('step-render-button');
    const exportBtn = document.getElementById('step-export-button');
    const exportTriBtn = document.getElementById('step-export-triangles-button');
    if (renderBtn) renderBtn.disabled = false;
    if (exportBtn) exportBtn.disabled = false;
    if (exportTriBtn) exportTriBtn.disabled = false;

    // Wasserdichtigkeits-Verdikt sofort anzeigen (rein geometrisch, ohne occt-Parsing).
    // „Rendern" visualisiert es danach zusätzlich im 3D-Viewer.
    try {
      const v2 = buildVolumeStepBrepV2(withDefeature(analysis));
      setStepWatertightStatus(v2 ? v2.report : null);
    } catch (e) { console.warn('Wasserdichtigkeits-Check fehlgeschlagen:', e.message); }

    setProgressStepStatus('exports', 'active', 'Exports werden vorbereitet …');
    setLiveDetail('Exports werden vorbereitet …');
    await progressStep(0.9, 'Exports werden vorbereitet …');
    setExportEnabled(true);
    setProgressStepStatus('exports', 'done', 'bereit');
    await progressStep(1, 'Fertig');
    setStatus(reason === 'detail' ? 'Detailgrad aktualisiert.' : 'Analyse abgeschlossen.', 'success');
    setLiveDetail('Analyse abgeschlossen.');
  } catch (error) {
    console.error(error);
    stopIndeterminateProgress();
    resetUI('Fehler', null);
    setStatus(`Fehler beim Einlesen: ${error.message}`, 'error');
    setLiveDetail('Fehler beim Einlesen');
  } finally {
    isProcessing = false;
  }
}

// ── Reset UI ──────────────────────────────────────────────────────────────────

function resetUI(message = '–', statusPayload = { text: 'Bereit für STL-Upload.', state: 'idle' }) {
  resetStats(message);
  paramOutput.value = '';
  setExportEnabled(false);
  stopIndeterminateProgress();
  setProgress(0, 'Bereit');
  resetProgressSteps('idle');
  clearOutlines();
  if (statusPayload) setStatus(statusPayload.text, statusPayload.state);
  setPreviewData();
  setProgress(0, 'Bereit');
  setStepWatertightStatus(null);
}

// ── Detail slider ─────────────────────────────────────────────────────────────

function updateDetailUI() {
  if (detailValueLabel) detailValueLabel.textContent = `${detailLevel}%`;
  if (detailHint) detailHint.textContent = `Automatik + Regler liefern ${describeDetailLevel(detailLevel)}.`;
}

// ── Event wiring ──────────────────────────────────────────────────────────────

dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('dragover'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  const file = e.dataTransfer?.files?.[0];
  if (file) handleFile(file);
});

fileInput.addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  if (file) { handleFile(file); e.target.value = ''; }
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

copyBtn.addEventListener('click', async () => {
  if (!paramOutput.value) return;
  await navigator.clipboard?.writeText?.(paramOutput.value);
  copyBtn.textContent = 'Kopiert';
  setTimeout(() => (copyBtn.textContent = 'Kopieren'), 1500);
});

downloadBtn.addEventListener('click', () => {
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

downloadDxfBtn.addEventListener('click', () => {
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

downloadStepBtn.addEventListener('click', () => {
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

downloadStepSolBtn.addEventListener('click', () => {
  if (!lastAnalysis) {
    setStatus('Keine Analysedaten vorhanden. Bitte zuerst eine STL-Datei analysieren.', 'error');
    return;
  }
  try {
    const res = buildVolumeStepBrepV2(withDefeature(lastAnalysis));
    if (!res?.step) {
      setStatus('STEP-Volumen fehlgeschlagen: zu wenig Flächen erkannt.', 'error');
      return;
    }
    setStepWatertightStatus(res.report);
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
    const res = buildVolumeStepBrepV2(withDefeature(lastAnalysis));
    if (!res?.step) {
      setStatus('Panel 4 Render fehlgeschlagen: zu wenig Flächen.', 'error');
      return;
    }
    setStepWatertightStatus(res.report);
    setStatus('Panel 4: V2-Boundary-Loop-STEP wird geparst (kann bei großen Modellen dauern) …', 'processing');
    loadStepIntoViewer(new TextEncoder().encode(res.step).buffer);
  } catch (err) {
    console.error(err);
    setStatus(`Panel 4 Render fehlgeschlagen: ${err.message}`, 'error');
  }
});

// Defeaturing-Umschalter: Verdikt sofort neu berechnen (Rendern/Export lesen den Toggle ohnehin).
document.getElementById('defeature-toggle')?.addEventListener('change', () => {
  if (!lastAnalysis) return;
  try {
    const v2 = buildVolumeStepBrepV2(withDefeature(lastAnalysis));
    setStepWatertightStatus(v2 ? v2.report : null);
  } catch (e) { console.warn('Defeaturing-Toggle: Verdikt-Update fehlgeschlagen:', e.message); }
});

// Wasserdichtigkeits-Verdikt unter Panel 4 setzen (aus dem V2-Export-Befund).
function setStepWatertightStatus(report) {
  const el = document.getElementById('step-watertight-status');
  if (!el) return;
  if (!report) { el.textContent = ''; el.dataset.state = ''; return; }
  const { watertight, boundaryEdges, nonManifoldEdges, orientationDefects, edgeCount, faceCount } = report;
  if (watertight) {
    el.textContent = `✓ Wasserdicht: ${faceCount} Flächen, alle ${edgeCount} Kanten genau 1× vor- und 1× rückwärts genutzt → geschlossener Körper.`;
    el.dataset.state = 'ok';
    // Was die Rekonstruktion gemacht hat (nur wenn etwas passiert ist): echte CAD-Flächen statt
    // Facetten und entfernte Verrundungen — sonst sieht man dem Verdikt nicht an, warum die
    // Flächenzahl mit „Verrundungen entfernen“ so viel kleiner ist.
    const n = (v) => (Number.isFinite(v) ? v : 0);
    const done = [];
    if (n(report.boresConverted)) done.push(`${report.boresConverted} Bohrung${report.boresConverted === 1 ? '' : 'en'} als echter Zylinder`);
    if (n(report.mantlesConverted)) done.push(`${report.mantlesConverted} ${report.mantlesConverted === 1 ? 'Außenmantel' : 'Außenmäntel'} als echter Zylinder`);
    if (n(report.mantleConesConverted)) done.push(`${report.mantleConesConverted} ${report.mantleConesConverted === 1 ? 'Kegelmantel' : 'Kegelmäntel'} als echter Kegel`);
    if (n(report.mantleChamfersConverted)) done.push(`${report.mantleChamfersConverted} ${report.mantleChamfersConverted === 1 ? 'Fase/Spitze' : 'Fasen/Spitzen'} am Außenmantel als echter Kegel`);
    if (n(report.tubesConverted)) done.push(`${report.tubesConverted} gebogene${report.tubesConverted === 1 ? 'r Kanal' : ' Kanäle'} als exakte Fläche (${report.tubePieces} Stück)`);
    // Schalen-Befunde (assembleSolids): Hohlräume, umgestülpte Eingabe, verworfene Finnen
    if (n(report.voids)) done.push(report.voids === 1 ? '1 innerer Hohlraum als echter Hohlraum im Körper' : `${report.voids} innere Hohlräume als echte Hohlräume im Körper`);
    if (n(report.invertedShells)) done.push('Eingabe-Netz war innen-außen gestülpt — Flächen umgedreht');
    if (n(report.droppedShells)) done.push(`${report.droppedShells} hauchdünne Schale${report.droppedShells === 1 ? '' : 'n'} (Finne/Mini-Tasche) verworfen`);
    const rounds = [];
    if (n(report.bandsDefeatured))   rounds.push(`${report.bandsDefeatured} ${report.bandsDefeatured === 1 ? 'Rundungsband' : 'Rundungsbänder'} an Deckflächen`);
    if (n(report.cornersDefeatured)) rounds.push(`${report.cornersDefeatured} gerundete Profilecke${report.cornersDefeatured === 1 ? '' : 'n'}`);
    if (n(report.filletsDefeatured)) rounds.push(`${report.filletsDefeatured} Kanten-Verrundung${report.filletsDefeatured === 1 ? '' : 'en'}`);
    if (rounds.length) done.push(`scharf gemacht: ${rounds.join(', ')}`);
    // Sicherheits-Rückfall (Hülle offen oder Orientierung einer CAD-Fläche unstimmig): sagen, warum
    // weniger umgewandelt wurde als erkannt
    if (report.fallbackStage === 1) done.push('Sicherheits-Rückfall: Bohrungen, Mäntel, Kegel und Kanäle facettiert gelassen');
    else if (report.fallbackStage === 2) done.push('Sicherheits-Rückfall: komplett facettiert');
    if (done.length) {
      const detail = document.createElement('span');
      detail.className = 'watertight-detail';
      detail.textContent = done.join(' · ');
      el.append(document.createElement('br'), detail);
    }
  } else {
    const parts = [];
    if (boundaryEdges)      parts.push(`${boundaryEdges} offene Kante${boundaryEdges === 1 ? '' : 'n'}`);
    if (nonManifoldEdges)   parts.push(`${nonManifoldEdges} non-manifold-Kante${nonManifoldEdges === 1 ? '' : 'n'}`);
    if (orientationDefects) parts.push(`${orientationDefects} fehlorientierte Kante${orientationDefects === 1 ? '' : 'n'}`);
    // Seit dem Dicht-Urteil je Schale können dichte Körper NEBEN offenen Schalen stehen —
    // dann ist nur ein Teil offen, die Körper sind trotzdem echte Volumen.
    const solids = Number.isFinite(report.solids) ? report.solids : 0;
    const opens = Number.isFinite(report.openShells) ? report.openShells : 0;
    if (solids > 0) {
      el.textContent = `⚠ Teilweise offen: ${parts.join(', ')} von ${edgeCount} Kanten (${faceCount} Flächen) — ${solids} geschlossene${solids === 1 ? 'r' : ''} Körper als Volumen exportiert, ${opens} offene Schale${opens === 1 ? '' : 'n'} als Flächenmodell beigelegt.`;
    } else {
      el.textContent = `⚠ Nicht wasserdicht: ${parts.join(', ')} von ${edgeCount} Kanten (${faceCount} Flächen) → offene Hülle, kein Solid.`;
    }
    el.dataset.state = 'warn';
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────

initProgressSteps();
initPreviewEvents();
initPreviewModeToggle();
try { initPipelineViewers(); }  catch (e) { console.warn('Pipeline viewers init failed:', e.message); }
try { initStepOcctViewer(); }   catch (e) { console.warn('STEP occt viewer init failed:', e.message); }
resetUI();

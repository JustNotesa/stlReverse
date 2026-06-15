// ── DOM references ──────────────────────────────────────────────────────────

const statusBanner     = document.getElementById('status-banner');
const progressBar      = document.getElementById('progress-bar');
const progressText     = document.getElementById('progress-text');
const progressStepsEl  = document.getElementById('progress-steps');
const liveDetail       = document.getElementById('progress-live-detail');
const liveDetailLabel  = document.getElementById('progress-live-detail-label');
const liveDetailStats  = document.getElementById('progress-live-detail-stats');

const copyBtn            = document.getElementById('copy-json');
const downloadBtn        = document.getElementById('download-json');
const downloadDxfBtn     = document.getElementById('download-dxf');
const downloadStepBtn    = document.getElementById('download-step');
const downloadStepSolBtn = document.getElementById('download-step-solid');

// ── Module-level state ──────────────────────────────────────────────────────

const STEP_DEFS = [
  { key: 'read',       label: 'Datei einlesen' },
  { key: 'prepare',    label: 'Analyse vorbereiten' },
  { key: 'projection', label: 'Projektionen berechnen' },
  { key: 'planar',     label: 'Planare Flächen' },
  { key: 'cylinder',   label: 'Zylinder erkennen' },
  { key: 'cone',       label: 'Kegel erkennen' },
  { key: 'sphere',     label: 'Kugeln erkennen' },
  { key: 'volume',     label: 'Volumenrekonstruktion' },
  { key: 'exports',    label: 'Exports vorbereiten' },
];
const stepElements = new Map();

let currentProgressValue = 0;
let indeterminateTimer   = null;

const DEFAULT_LABEL = 'Bereit';
const DEFAULT_STATS = '–';

const nextFrame = () =>
  new Promise((resolve) => {
    const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (fn) => setTimeout(fn, 0);
    raf(resolve);
  });

// ── Status banner ───────────────────────────────────────────────────────────

export function setStatus(message, state = 'idle') {
  if (!statusBanner) return;
  statusBanner.textContent = message;
  statusBanner.classList.remove('status--idle', 'status--processing', 'status--success', 'status--error');
  statusBanner.classList.add(`status--${state}`);
}

// ── Export buttons ──────────────────────────────────────────────────────────

export function setExportEnabled(enabled) {
  const flag = Boolean(enabled);
  if (copyBtn)            copyBtn.disabled            = !flag;
  if (downloadBtn)        downloadBtn.disabled        = !flag;
  if (downloadDxfBtn)     downloadDxfBtn.disabled     = !flag;
  if (downloadStepBtn)    downloadStepBtn.disabled    = !flag;
  if (downloadStepSolBtn) downloadStepSolBtn.disabled = !flag;
}

// ── Progress bar ────────────────────────────────────────────────────────────

export function setProgress(value, label) {
  if (!progressBar || !progressText) return;
  const target = Number(value) || 0;
  if (label === 'Bereit') {
    currentProgressValue = target;
  } else if (target >= currentProgressValue) {
    currentProgressValue = target;
  }
  const clamped = Math.max(0, Math.min(1, currentProgressValue));
  progressBar.style.width = `${clamped * 100}%`;
  const pct = `${Math.round(clamped * 100)}%`;
  progressText.textContent = label ? `${pct} · ${label}` : `Fortschritt: ${pct}`;
}

export async function progressStep(value, label) {
  setProgress(Math.max(value, currentProgressValue), label);
  await nextFrame();
}

export function startIndeterminateProgress(startValue = 0.3, label = 'Analyse läuft …') {
  stopIndeterminateProgress();
  let current = Math.max(currentProgressValue, startValue);
  setProgress(current, label);
  indeterminateTimer = setInterval(() => {
    current = Math.min(current + 0.015, 0.94);
    setProgress(current, label);
  }, 200);
}

export function stopIndeterminateProgress(targetValue = null, label = null) {
  if (indeterminateTimer) { clearInterval(indeterminateTimer); indeterminateTimer = null; }
  if (targetValue !== null) {
    setProgress(Math.max(currentProgressValue, targetValue), label || 'Fertig');
  }
}

// ── Progress steps ──────────────────────────────────────────────────────────

export function initProgressSteps() {
  if (!progressStepsEl) return;
  progressStepsEl.innerHTML = '';
  stepElements.clear();
  STEP_DEFS.forEach(({ key, label }) => {
    const item    = document.createElement('li');
    item.className = 'progress-step status--pending';
    item.dataset.key = key;
    const labelSpan = document.createElement('span');
    labelSpan.textContent = label;
    const detail = document.createElement('small');
    item.appendChild(labelSpan);
    item.appendChild(detail);
    progressStepsEl.appendChild(item);
    stepElements.set(key, { element: item, detailEl: detail });
  });
}

export function resetProgressSteps(reason = 'upload', sizeLabel = '') {
  STEP_DEFS.forEach(({ key }) => setProgressStepStatus(key, 'pending', ''));
  if (reason === 'detail') {
    setProgressStepStatus('read', 'done', 'Cache');
  } else if (sizeLabel) {
    setProgressStepStatus('read', 'pending', `~${sizeLabel}`);
  }
  setLiveDetail();
}

export function setProgressStepStatus(key, status, detailText = '') {
  const entry = stepElements.get(key);
  if (!entry) return;
  const { element, detailEl } = entry;
  element.classList.remove('status--pending', 'status--active', 'status--done');
  element.classList.add(`status--${status}`);
  if (detailEl) detailEl.textContent = detailText || '';
}

// ── Live detail ─────────────────────────────────────────────────────────────

export function setLiveDetail(labelText = '', statsText = '') {
  const label = labelText?.trim() || DEFAULT_LABEL;
  const stats = statsText?.trim() || DEFAULT_STATS;
  if (liveDetailLabel) liveDetailLabel.textContent = label;
  if (liveDetailStats) {
    liveDetailStats.textContent   = stats;
    liveDetailStats.dataset.empty = stats === DEFAULT_STATS ? 'true' : 'false';
  }
  if (liveDetail) {
    const isIdle = label === DEFAULT_LABEL && stats === DEFAULT_STATS;
    liveDetail.dataset.state = isIdle ? 'idle' : 'active';
  }
}

// ── Worker progress handler ─────────────────────────────────────────────────

export function handleWorkerProgress(payload) {
  const { detail, ratio, processed, total, stage, stageDetail } = payload || {};

  if (indeterminateTimer && Number.isFinite(ratio)) {
    clearInterval(indeterminateTimer);
    indeterminateTimer = null;
  }

  const hasCounters  = Number.isFinite(processed) && Number.isFinite(total) && total > 0;
  const liveLabel    = _deriveStageLabel(detail) || 'Analyse läuft …';
  const showCounts   = hasCounters && processed < total;
  const detailForStep = showCounts
    ? _formatWorkerDetail(processed, total, liveLabel)
    : detail || _formatWorkerDetail(processed, total, liveLabel);

  const stageKey = _mapToStageKey(stage || detail);
  if (stageKey) {
    const ORDER = ['prepare', 'projection', 'planar', 'cylinder', 'cone', 'sphere', 'volume'];
    const idx   = ORDER.indexOf(stageKey);
    if (idx > 0) {
      ORDER.slice(0, idx).forEach((k) => {
        const e = stepElements.get(k);
        if (e && !e.element.classList.contains('status--done')) {
          setProgressStepStatus(k, 'done', '✓');
        }
      });
    }
    setProgressStepStatus(stageKey, 'active', stageDetail || detailForStep);
  }

  const statsText = hasCounters ? _formatWorkerStats(processed, total) : '';
  setLiveDetail(liveLabel, statsText);
  if (Number.isFinite(ratio)) setProgress(ratio, detailForStep);
}

// ── Private helpers ─────────────────────────────────────────────────────────

function _mapToStageKey(detail) {
  if (!detail) return null;
  const l = detail.toLowerCase();
  if (l.includes('projektion'))                      return 'projection';
  if (l.includes('planar') || l.includes('flächen')) return 'planar';
  if (l.includes('zylind') || l.includes('axial'))   return 'cylinder';
  if (l.includes('kegel')  || l.includes('kon'))     return 'cone';
  if (l.includes('kugel')  || l.includes('sphär'))   return 'sphere';
  if (l.includes('volumen') || l.includes('heightfield')) return 'volume';
  if (l.includes('vorbereitung') || l.includes('bounds')) return 'prepare';
  return null;
}

function _formatWorkerDetail(processed, total, label = 'Analyse läuft …') {
  if (!Number.isFinite(processed) || !Number.isFinite(total) || !total) return label;
  const pct    = Math.max(0, Math.min(100, Math.round((processed / total) * 100)));
  const bounded = pct === 0 && processed > 0 ? 1 : pct;
  const fmt    = (v) => v?.toLocaleString?.('de-DE') ?? v;
  return `${label.trim()} (${fmt(processed)} / ${fmt(total)} · ${bounded}%)`;
}

function _formatWorkerStats(processed, total) {
  if (!Number.isFinite(processed) || !Number.isFinite(total) || !total) return '';
  const pct = Math.max(0, Math.min(100, Math.round((processed / total) * 100)));
  const fmt = (v) => v?.toLocaleString?.('de-DE') ?? v;
  return `${fmt(processed)} / ${fmt(total)} · ${pct}%`;
}

function _deriveStageLabel(detailText) {
  if (!detailText) return '';
  for (const sep of ['(', '·']) {
    const idx = detailText.indexOf(sep);
    if (idx > 0) return detailText.slice(0, idx).trim();
  }
  return detailText.trim();
}

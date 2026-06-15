import { clamp, computePointBounds, computePrismBounds } from './utils.js';

// ── DOM references ──────────────────────────────────────────────────────────

const canvas3d      = document.getElementById('canvas-3d');
const toggleBtn     = document.getElementById('preview-mode-toggle');
const modeLabel     = document.getElementById('preview-mode-label');

// ── Module-level state ──────────────────────────────────────────────────────

let previewPoints      = [];
let previewBoundingBox = null;
let previewPrisms      = [];
let previewMode        = 'outline';
const previewRotation  = { azimuth: Math.PI / 4, elevation: Math.PI / 6 };
let previewZoom        = 1;
const previewDrag      = { active: false, lastX: 0, lastY: 0 };

// ── Public API ──────────────────────────────────────────────────────────────

export function setPreviewData(points = [], bbox = null, volumeData = null) {
  previewPoints      = Array.isArray(points) ? points : [];
  previewBoundingBox = bbox || null;
  previewPrisms      = Array.isArray(volumeData?.primitives) ? volumeData.primitives : [];
  if (!previewPrisms.length && previewMode === 'volume') previewMode = 'outline';
  updatePreviewModeUI();
  renderPreview3D();
}

export function renderPreview3D() {
  if (!canvas3d) return;
  const ctx = canvas3d.getContext('2d');
  ctx.clearRect(0, 0, canvas3d.width, canvas3d.height);
  ctx.fillStyle = '#03060c';
  ctx.fillRect(0, 0, canvas3d.width, canvas3d.height);

  let mode = previewMode;
  if (mode === 'volume' && !previewPrisms.length)  mode = 'outline';
  if (mode === 'outline' && !previewPoints.length && previewPrisms.length) mode = 'volume';

  if ((mode === 'outline' && !previewPoints.length) || (mode === 'volume' && !previewPrisms.length)) {
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.font = '12px system-ui';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Noch keine Daten', canvas3d.width / 2, canvas3d.height / 2);
    return;
  }

  const bbox =
    previewBoundingBox && Array.isArray(previewBoundingBox.min)
      ? previewBoundingBox
      : mode === 'volume'
        ? computePrismBounds(previewPrisms)
        : computePointBounds(previewPoints);
  const transform = _createTransform(bbox);

  if (mode === 'volume') _renderPrisms(ctx, transform);
  else                   _renderPoints(ctx, transform);
}

export function updatePreviewModeUI() {
  if (modeLabel) {
    modeLabel.textContent =
      previewMode === 'volume' ? 'Aktive Ansicht: STEP-Volumen' : 'Aktive Ansicht: Kontur';
  }
  if (toggleBtn) {
    if (!previewPrisms.length) {
      toggleBtn.disabled = true;
      toggleBtn.textContent = 'STEP-Volumen nicht verfügbar';
    } else {
      toggleBtn.disabled = false;
      toggleBtn.textContent = previewMode === 'volume' ? 'Zu Kontur wechseln' : 'Zu STEP-Volumen wechseln';
    }
  }
}

export function initPreviewEvents() {
  if (!canvas3d) return;
  canvas3d.addEventListener('pointerdown', _onDown);
  canvas3d.addEventListener('pointermove', _onMove);
  canvas3d.addEventListener('pointerup',   _onUp);
  canvas3d.addEventListener('pointerleave', _onUp);
  canvas3d.addEventListener('wheel', (e) => {
    e.preventDefault();
    previewZoom = Math.max(0.4, Math.min(4, previewZoom - Math.sign(e.deltaY) * 0.1));
    renderPreview3D();
  }, { passive: false });
}

export function initPreviewModeToggle() {
  if (!toggleBtn) return;
  toggleBtn.addEventListener('click', () => {
    if (previewMode === 'outline' && !previewPrisms.length) return;
    previewMode = previewMode === 'outline' ? 'volume' : 'outline';
    updatePreviewModeUI();
    renderPreview3D();
  });
  updatePreviewModeUI();
}

// ── Private helpers ─────────────────────────────────────────────────────────

function _onDown(e) {
  previewDrag.active = true;
  previewDrag.lastX  = e.clientX;
  previewDrag.lastY  = e.clientY;
  canvas3d.setPointerCapture(e.pointerId);
}

function _onMove(e) {
  if (!previewDrag.active) return;
  const dx = e.clientX - previewDrag.lastX;
  const dy = e.clientY - previewDrag.lastY;
  previewDrag.lastX = e.clientX;
  previewDrag.lastY = e.clientY;
  previewRotation.azimuth   += dx * 0.01;
  previewRotation.elevation  = clamp(previewRotation.elevation + dy * 0.01, -Math.PI / 2 + 0.1, Math.PI / 2 - 0.1);
  renderPreview3D();
}

function _onUp(e) {
  if (!previewDrag.active) return;
  previewDrag.active = false;
  if (canvas3d?.hasPointerCapture(e.pointerId)) canvas3d.releasePointerCapture(e.pointerId);
}

function _createTransform(bbox) {
  const center = [
    bbox.min?.[0] + (bbox.width || 0) / 2,
    bbox.min?.[1] + (bbox.depth || 0) / 2,
    bbox.min?.[2] + (bbox.height || 0) / 2,
  ];
  const extent = Math.max(bbox.width || 1, bbox.depth || 1, bbox.height || 1);
  const scale  = ((Math.min(canvas3d.width, canvas3d.height) / extent) * 0.45 * previewZoom) || 1;
  return {
    center, extent, scale,
    cosAz: Math.cos(previewRotation.azimuth),
    sinAz: Math.sin(previewRotation.azimuth),
    cosEl: Math.cos(previewRotation.elevation),
    sinEl: Math.sin(previewRotation.elevation),
    width: canvas3d.width, height: canvas3d.height
  };
}

function _project(t, x, y, z) {
  const nx = x - t.center[0], ny = y - t.center[1], nz = z - t.center[2];
  const rYx = nx * t.cosAz - nz * t.sinAz;
  const rYz = nx * t.sinAz + nz * t.cosAz;
  const rXy = ny * t.cosEl - rYz * t.sinEl;
  const rXz = ny * t.sinEl + rYz * t.cosEl;
  return { x: rYx * t.scale + t.width / 2, y: t.height / 2 - rXy * t.scale, depth: rXz };
}

function _renderPoints(ctx, t) {
  const projected = previewPoints.map(([x, y, z]) => _project(t, x, y, z));
  projected
    .sort((a, b) => a.depth - b.depth)
    .forEach((pt) => {
      const depth = clamp((pt.depth + t.extent) / (2 * t.extent), 0, 1);
      ctx.fillStyle = `rgba(85, 246, 199, ${0.3 + depth * 0.7})`;
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, Math.max(1, 3 - depth * 2), 0, Math.PI * 2);
      ctx.fill();
    });
}

function _renderPrisms(ctx, t) {
  const FACES = [
    { i: [0,1,2,3], c: 'rgba(16, 87, 130, 0.55)' },
    { i: [4,5,6,7], c: 'rgba(82, 238, 199, 0.4)' },
    { i: [0,1,5,4], c: 'rgba(30, 120, 150, 0.35)' },
    { i: [1,2,6,5], c: 'rgba(30, 120, 150, 0.3)' },
    { i: [2,3,7,6], c: 'rgba(30, 120, 150, 0.25)' },
    { i: [3,0,4,7], c: 'rgba(30, 120, 150, 0.3)' },
  ];
  const EDGES = [[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]];

  previewPrisms
    .map((p) => ({ p, depth: (p.zMin + p.zMax) / 2 }))
    .sort((a, b) => a.depth - b.depth)
    .forEach(({ p }) => {
      const pts = [
        [p.xMin,p.yMin,p.zMin],[p.xMax,p.yMin,p.zMin],[p.xMax,p.yMax,p.zMin],[p.xMin,p.yMax,p.zMin],
        [p.xMin,p.yMin,p.zMax],[p.xMax,p.yMin,p.zMax],[p.xMax,p.yMax,p.zMax],[p.xMin,p.yMax,p.zMax],
      ].map(([x,y,z]) => _project(t, x, y, z));

      FACES
        .map((f) => ({ ...f, d: f.i.reduce((acc, idx) => acc + pts[idx].depth, 0) / f.i.length }))
        .sort((a, b) => a.d - b.d)
        .forEach((f) => {
          ctx.beginPath();
          f.i.forEach((idx, k) => k === 0 ? ctx.moveTo(pts[idx].x, pts[idx].y) : ctx.lineTo(pts[idx].x, pts[idx].y));
          ctx.closePath();
          ctx.fillStyle = f.c;
          ctx.fill();
          ctx.strokeStyle = 'rgba(255,255,255,0.08)';
          ctx.stroke();
        });

      ctx.strokeStyle = 'rgba(255,255,255,0.5)';
      ctx.lineWidth = 1;
      EDGES.forEach(([s, e]) => {
        ctx.beginPath();
        ctx.moveTo(pts[s].x, pts[s].y);
        ctx.lineTo(pts[e].x, pts[e].y);
        ctx.stroke();
      });
    });
}

import { formatNumber } from './utils.js';

// ── DOM references ──────────────────────────────────────────────────────────

const statsFields = {
  width:  document.getElementById('width'),
  depth:  document.getElementById('depth'),
  height: document.getElementById('height'),
  faces:  document.getElementById('faces'),
};

const canvases = {
  XY: document.getElementById('canvas-xy'),
  YZ: document.getElementById('canvas-yz'),
  ZX: document.getElementById('canvas-zx'),
};

// ── Stats ───────────────────────────────────────────────────────────────────

export function updateStats(boundingBox, meta) {
  statsFields.width.textContent  = formatNumber(boundingBox.width);
  statsFields.depth.textContent  = formatNumber(boundingBox.depth);
  statsFields.height.textContent = formatNumber(boundingBox.height);
  statsFields.faces.textContent  = meta.triangles?.toLocaleString?.('de-DE') ?? '0';
}

export function resetStats(message = '–') {
  statsFields.width.textContent  = message;
  statsFields.depth.textContent  = message;
  statsFields.height.textContent = message;
  statsFields.faces.textContent  = message;
}

// ── Outlines ─────────────────────────────────────────────────────────────────

export function renderOutlines(outlines) {
  drawOutline(canvases.XY, outlines.XY);
  drawOutline(canvases.YZ, outlines.YZ);
  drawOutline(canvases.ZX, outlines.ZX);
}

export function clearOutlines() {
  Object.values(canvases).forEach((canvas) => {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.font = '12px system-ui';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Noch keine Daten', canvas.width / 2, canvas.height / 2);
  });
}

export function drawOutline(canvas, outline) {
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (!outline?.hull?.length) {
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.font = '12px system-ui';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('kein Profil', canvas.width / 2, canvas.height / 2);
    return;
  }

  const { bounds } = outline;
  const margin = 16;
  const dw = bounds.maxX - bounds.minX || 1;
  const dh = bounds.maxY - bounds.minY || 1;
  const scale = Math.min((canvas.width - margin * 2) / dw, (canvas.height - margin * 2) / dh);
  const toCanvas = ([x, y]) => [
    margin + (x - bounds.minX) * scale,
    canvas.height - margin - (y - bounds.minY) * scale
  ];

  ctx.strokeStyle = 'rgba(255,255,255,0.15)';
  ctx.lineWidth = 1;
  ctx.strokeRect(margin / 2, margin / 2, canvas.width - margin, canvas.height - margin);

  ctx.beginPath();
  outline.hull.forEach((pt, i) => {
    const [cx, cy] = toCanvas(pt);
    if (i === 0) ctx.moveTo(cx, cy); else ctx.lineTo(cx, cy);
  });
  ctx.closePath();
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#1baf80';
  ctx.stroke();
  ctx.fillStyle = 'rgba(27, 175, 128, 0.1)';
  ctx.fill();
}

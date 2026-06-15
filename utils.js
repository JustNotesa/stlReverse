/**
 * Reine Hilfsfunktionen ohne DOM- oder State-Abhängigkeiten.
 */

export function formatNumber(value) {
  if (!Number.isFinite(value)) return '0';
  return new Intl.NumberFormat('de-DE', { maximumFractionDigits: 3 }).format(value);
}

export function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function heightToColor(t) {
  const stops = [
    { stop: 0, color: [15, 23, 42] },
    { stop: 0.5, color: [56, 189, 248] },
    { stop: 1, color: [126, 251, 215] }
  ];
  const clamped = Math.max(0, Math.min(1, t));
  let left = stops[0];
  let right = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i += 1) {
    if (clamped >= stops[i].stop && clamped <= stops[i + 1].stop) {
      left = stops[i];
      right = stops[i + 1];
      break;
    }
  }
  const span = right.stop - left.stop || 1;
  const localT = Math.max(0, Math.min(1, (clamped - left.stop) / span));
  const mix = (a, b) => Math.round(a + (b - a) * localT);
  const r = mix(left.color[0], right.color[0]);
  const g = mix(left.color[1], right.color[1]);
  const b = mix(left.color[2], right.color[2]);
  return `rgb(${r}, ${g}, ${b})`;
}

export function formatCylinderAxis(feature) {
  if (feature.type === 'oblique' && feature.axisVector) {
    return `Schräg (${formatNumber(feature.axisVector[0])}, ${formatNumber(feature.axisVector[1])}, ${formatNumber(feature.axisVector[2])})`;
  }
  return feature.axisLabel || feature.axis || '–';
}

export function formatCylinderCenter(feature) {
  const center = feature.center || {};
  if (feature.type === 'axial') {
    if (feature.axis === 'X') return `Y ${formatNumber(center.y)} | Z ${formatNumber(center.z)}`;
    if (feature.axis === 'Y') return `X ${formatNumber(center.x)} | Z ${formatNumber(center.z)}`;
    if (feature.axis === 'Z') return `X ${formatNumber(center.x)} | Y ${formatNumber(center.y)}`;
  }
  return `(${formatNumber(center.x)}, ${formatNumber(center.y)}, ${formatNumber(center.z)})`;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const precision = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(precision)} ${units[unitIndex]}`;
}

export function describeDetailLevel(value) {
  if (value >= 90) return 'maximale Konturen';
  if (value >= 75) return 'feine Konturen';
  if (value >= 60) return 'ausgewogene Konturen';
  return 'glatte/vereinfachte Konturen';
}

export function computePointBounds(points = []) {
  if (!points.length) return { min: [0, 0, 0], width: 1, depth: 1, height: 1 };
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  points.forEach(([x, y, z]) => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  });
  return {
    min: [minX, minY, minZ],
    width: maxX - minX || 1,
    depth: maxY - minY || 1,
    height: maxZ - minZ || 1
  };
}

export function computePrismBounds(prisms = []) {
  if (!prisms.length) return { min: [0, 0, 0], width: 1, depth: 1, height: 1 };
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  prisms.forEach((prism) => {
    if (prism.xMin < minX) minX = prism.xMin;
    if (prism.yMin < minY) minY = prism.yMin;
    if (prism.zMin < minZ) minZ = prism.zMin;
    if (prism.xMax > maxX) maxX = prism.xMax;
    if (prism.yMax > maxY) maxY = prism.yMax;
    if (prism.zMax > maxZ) maxZ = prism.zMax;
  });
  return {
    min: [minX, minY, minZ],
    width: maxX - minX || 1,
    depth: maxY - minY || 1,
    height: maxZ - minZ || 1
  };
}

export function prepareOutlinePolygon(outline, bbox) {
  const fallback = [
    [bbox.min[0], bbox.min[1]],
    [bbox.min[0] + bbox.width, bbox.min[1]],
    [bbox.min[0] + bbox.width, bbox.min[1] + bbox.depth],
    [bbox.min[0], bbox.min[1] + bbox.depth]
  ];
  if (!outline?.hull?.length) return fallback;
  const polygon = dedupePolygonPoints(outline.hull.map(([x, y]) => [x, y]));
  if (polygon.length < 3) return fallback;
  const area = polygonSignedArea2d(polygon);
  if (area < 0) polygon.reverse();
  return polygon;
}

export function dedupePolygonPoints(points, epsilon = 1e-6) {
  const result = [];
  points.forEach(([x, y]) => {
    if (!result.length) {
      result.push([x, y]);
      return;
    }
    const [lastX, lastY] = result[result.length - 1];
    if (Math.abs(lastX - x) > epsilon || Math.abs(lastY - y) > epsilon) {
      result.push([x, y]);
    }
  });
  if (result.length >= 2) {
    const [firstX, firstY] = result[0];
    const [lastX, lastY] = result[result.length - 1];
    if (Math.abs(firstX - lastX) <= epsilon && Math.abs(firstY - lastY) <= epsilon) {
      result.pop();
    }
  }
  return result;
}

export function polygonSignedArea2d(points) {
  if (points.length < 3) return 0;
  let area = 0;
  for (let i = 0; i < points.length; i += 1) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    area += x1 * y2 - x2 * y1;
  }
  return area / 2;
}

export function normalizeVector(vec) {
  const length = Math.hypot(vec[0], vec[1], vec[2]) || 0;
  if (!length) return [0, 0, 0];
  return [vec[0] / length, vec[1] / length, vec[2] / length];
}

export function mapOutlinePointToDxf(plane, u, v) {
  switch (plane) {
    case 'XY':
      return [u, v];
    case 'YZ':
      return [u, v];
    case 'ZX':
      return [v, u];
    default:
      return [u, v];
  }
}

export function mapOutlinePointToStep(plane, u, v, offsets) {
  const config = offsets[plane];
  if (plane === 'XY') {
    return [u + config.shiftX, v + config.shiftY, 0];
  }
  if (plane === 'YZ') {
    return [config.x, u + config.shiftX, v + config.shiftY];
  }
  if (plane === 'ZX') {
    return [v + config.shiftX, config.y, u + config.shiftY];
  }
  return [u, v, 0];
}

export function defaultBounds() {
  return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
}

export function rectangleFromBounds(bounds) {
  const { minX, minY, maxX, maxY } = bounds || {};
  if (
    minX === undefined ||
    minY === undefined ||
    maxX === undefined ||
    maxY === undefined ||
    maxX - minX === 0 ||
    maxY - minY === 0
  ) {
    return null;
  }
  return [
    [minX, minY],
    [maxX, minY],
    [maxX, maxY],
    [minX, maxY]
  ];
}

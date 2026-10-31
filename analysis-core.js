// Netz-Vereinfachung (QEM-Kantenkollaps mit Gültigkeitsprüfungen) liegt in mesh-simplify.js;
// hier nur weitergereicht, damit Worker und Tests sie wie bisher aus analysis-core.js holen.
import { simplifyMesh } from './mesh-simplify.js?v=1';

function parseStl(buffer, progressCb) {
  if (!buffer?.byteLength) throw new Error('Leere Datei');
  const bytes = new Uint8Array(buffer);
  const decoder = new TextDecoder('utf-8');
  const header = decoder.decode(bytes.slice(0, 80)).trim();
  const dv = new DataView(buffer);
  const faceCount = buffer.byteLength >= 84 ? dv.getUint32(80, true) : 0;
  const expectedBinarySize = 84 + faceCount * 50;

  const looksBinary = expectedBinarySize === buffer.byteLength;
  const startsWithSolid = header.startsWith('solid');

  if (!looksBinary && startsWithSolid) {
    try {
      return parseAsciiStl(decoder.decode(bytes), progressCb);
    } catch (asciiError) {
      console.warn('ASCII STL Parsing fehlgeschlagen, versuche binär', asciiError);
      return parseBinaryStl(buffer, progressCb);
    }
  }

  return parseBinaryStl(buffer, progressCb);
}

function parseBinaryStl(buffer, progressCb) {
  const dataView = new DataView(buffer);
  if (buffer.byteLength < 84) {
    throw new Error('Ungültige STL-Datei: Zu klein für den binären Header (min. 84 Bytes).');
  }
  const faceCount = dataView.getUint32(80, true);
  if (!Number.isFinite(faceCount) || faceCount <= 0) {
    throw new Error('Die STL enthält keine Facetten.');
  }
  const expectedSize = 84 + faceCount * 50;
  if (buffer.byteLength < expectedSize) {
    throw new Error(`Unvollständige STL-Datei: Erwartet ${expectedSize} Bytes für ${faceCount} Facetten, aber nur ${buffer.byteLength} Bytes vorhanden.`);
  }

  const vertices = [];
  const faces = [];
  let offset = 84;

  const progressEvery = Math.max(1, Math.floor(faceCount / 50));

  for (let i = 0; i < faceCount; i += 1) {
    const normal = [
      dataView.getFloat32(offset, true),
      dataView.getFloat32(offset + 4, true),
      dataView.getFloat32(offset + 8, true)
    ];
    offset += 12;

    const v1 = [
      dataView.getFloat32(offset, true),
      dataView.getFloat32(offset + 4, true),
      dataView.getFloat32(offset + 8, true)
    ];
    offset += 12;

    const v2 = [
      dataView.getFloat32(offset, true),
      dataView.getFloat32(offset + 4, true),
      dataView.getFloat32(offset + 8, true)
    ];
    offset += 12;

    const v3 = [
      dataView.getFloat32(offset, true),
      dataView.getFloat32(offset + 4, true),
      dataView.getFloat32(offset + 8, true)
    ];
    offset += 12;

    offset += 2;

    addFace(faces, vertices, normal, v1, v2, v3);

    if (progressCb && i % progressEvery === 0) {
      progressCb({ processed: i + 1, total: faceCount, phase: 'binary-read' });
    }
  }

  return { faces, vertices: new Float32Array(vertices) };
}

function parseAsciiStl(text, progressCb) {
  const faces = [];
  const vertices = [];
  const lines = text.split(/\r?\n/);
  let currentNormal = null;
  let triangleVerts = [];
  let processed = 0;
  const total = lines.length;
  const progressEvery = Math.max(1, Math.floor(total / 50));

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith('facet normal')) {
      const [, , nx, ny, nz] = line.split(/\s+/);
      currentNormal = [Number(nx), Number(ny), Number(nz)];
      triangleVerts = [];
    } else if (line.startsWith('vertex')) {
      const [, x, y, z] = line.split(/\s+/);
      triangleVerts.push([Number(x), Number(y), Number(z)]);
    } else if (line.startsWith('endfacet')) {
      if (triangleVerts.length === 3) {
        addFace(faces, vertices, currentNormal, triangleVerts[0], triangleVerts[1], triangleVerts[2]);
        processed += 1;
        if (progressCb && processed % progressEvery === 0) {
          progressCb({ processed, total, phase: 'ascii-read' });
        }
      }
      triangleVerts = [];
    }
  }

  if (!faces.length) throw new Error('Keine Facetten im STL gefunden.');
  return { faces, vertices: new Float32Array(vertices) };
}

function addFace(faceCollection, vertexStore, normal, v1, v2, v3) {
  // Normale aus der Wicklung (Eckpunkt-Reihenfolge) — die in der STL gespeicherte Normale nur
  // als Rückfall für degenerierte Dreiecke. Viele Tools schreiben „facet normal 0 0 0“; das
  // wurde vorher als Nullvektor übernommen (STL-Spez.: Leser sollen dann aus der Wicklung
  // rechnen), und die Flächen-Vereinigung fasste alle Null-Normalen zu EINER Gruppe zusammen.
  let n = normalizeVector(computeFaceNormal(v1, v2, v3));
  if (!n[0] && !n[1] && !n[2] && normal?.every((value) => Number.isFinite(value))) {
    n = normalizeVector(normal);
  }
  const area = triangleArea(v1, v2, v3);

  faceCollection.push({
    normal: n,
    vertices: [v1, v2, v3],
    area
  });

  vertexStore.push(...v1, ...v2, ...v3);
}

function createStageProgressTracker(totalFaces) {
  const normalizedTotal = Math.max(1, totalFaces);
  const plan = [
    { key: 'prepare', weight: 0.12 },
    { key: 'projection', weight: 0.16 },
    { key: 'planar', weight: 0.4 },
    { key: 'axial', weight: 0.16 },
    { key: 'oblique', weight: 0.1 },
    { key: 'post', weight: 0.06 }
  ];
  const buckets = new Map();
  let assigned = 0;

  plan.forEach((stage, index) => {
    const remaining = normalizedTotal - assigned;
    let span =
      index === plan.length - 1
        ? remaining
        : Math.round(normalizedTotal * stage.weight);
    span = Math.max(1, span);
    span = Math.min(remaining, span);
    const safeSpan = remaining <= 0 ? 0 : span;
    buckets.set(stage.key, { start: assigned, span: safeSpan });
    assigned += safeSpan;
  });

  const fallbackSlot = buckets.get('post');
  let lastProcessed = 0;

  return (key, fraction = 0) => {
    const slot = buckets.get(key) || fallbackSlot;
    const clampedFraction = clamp01(fraction);
    const rawValue = slot.start + slot.span * clampedFraction;
    const processed = Math.max(lastProcessed, Math.min(normalizedTotal, Math.round(rawValue)));
    lastProcessed = processed;
    return processed;
  };
}

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function analyseMesh(mesh, fileName, options = {}) {
  const detailLevel = clampDetailLevel(options.detailLevel);
  const totalFaces = Math.max(1, mesh.faces.length);
  const progressCb = typeof options.progress === 'function' ? options.progress : null;
  const stageProgress = createStageProgressTracker(totalFaces);
  let displayedProcessed = 0;

  const emitStageProgress = (detail, options = {}) => {
    if (!progressCb) return;
    const {
      stageKey,
      fraction = 0,
      ratio = null,
      includeCounters = true
    } = options;
    if (stageKey) {
      displayedProcessed = stageProgress(stageKey, fraction);
    }
    const normalized = totalFaces ? displayedProcessed / totalFaces : 0;
    const fallbackRatio = ratio ?? 0.5 + 0.35 * normalized;
    const payload = {
      detail,
      ratio: Math.min(0.94, fallbackRatio)
    };
    if (includeCounters) {
      payload.processed = displayedProcessed;
      payload.total = totalFaces;
    }
    progressCb(payload);
  };

  emitStageProgress('Vorverarbeitung', { stageKey: 'prepare', fraction: 0.1, ratio: 0.52 });
  const boundingBox = computeBoundingBox(mesh.vertices);
  emitStageProgress('Bounds berechnet', { stageKey: 'prepare', fraction: 0.5, ratio: 0.54 });
  const outlines = {
    XY: projectOutline(mesh.vertices, 'XY', detailLevel),
    YZ: projectOutline(mesh.vertices, 'YZ', detailLevel),
    ZX: projectOutline(mesh.vertices, 'ZX', detailLevel)
  };
  emitStageProgress('Projektionen berechnet', { stageKey: 'projection', fraction: 1, ratio: 0.58 });

  // Primitiv-Erkennung (Planes/Cylinder/Cones/Spheres) wurde entfernt — nie produktiv.
  // Stattdessen übernimmt der Worker das Region-Growing (normalGroups) und segmentation.js.
  // Analyse liefert: bounding box, outlines, preview-points, surface area, volume.
  emitStageProgress('Analyse', { stageKey: 'post', fraction: 0.85, ratio: 0.93 });

  const surfaceArea = mesh.faces.reduce((acc, face) => acc + (face.area || 0), 0);
  const volume = Math.abs(computeSignedVolume(mesh.faces));

  const previewPoints = buildPreviewPoints(mesh.vertices);
  emitStageProgress('Vorschau erstellt', { stageKey: 'post', fraction: 1, ratio: 0.96 });

  const parametric = {
    generatedAt: new Date().toISOString(),
    meta: {
      fileName,
      triangles: mesh.faces.length,
      surfaceArea: roundTo(surfaceArea, 1e-3),
      volume: roundTo(volume, 1e-3),
      detailLevel
    },
    boundingBox,
    outlines: Object.fromEntries(
      Object.entries(outlines).map(([plane, outline]) => [
        plane,
        {
          area: outline.area,
          perimeter: outline.perimeter,
          points: outline.hull.map(([x, y]) => [roundTo(x, 1e-3), roundTo(y, 1e-3)]),
          bounds: outline.bounds
        }
      ])
    ),
    preview: {
      sampleCount: previewPoints.length
    }
  };

  // Dreiecke für 3D-Viewer vorbereiten (vereinfachtes Format)
  const trianglesForViewer = mesh.faces.map(face => ({
    vertices: face.vertices,
    normal: face.normal
  }));

  return {
    meta: parametric.meta,
    boundingBox,
    outlines,
    parametric,
    previewPoints,
    triangles: trianglesForViewer
  };
}

function computeBoundingBox(vertices) {
  if (!vertices.length) return { width: 0, height: 0, depth: 0, min: [0, 0, 0], max: [0, 0, 0] };
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;

  for (let i = 0; i < vertices.length; i += 3) {
    const x = vertices[i];
    const y = vertices[i + 1];
    const z = vertices[i + 2];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }

  return {
    min: [minX, minY, minZ],
    max: [maxX, maxY, maxZ],
    width: maxX - minX,
    depth: maxY - minY,
    height: maxZ - minZ
  };
}

function projectOutline(vertices, plane, detailLevel = 0.6) {
  const points = [];
  for (let i = 0; i < vertices.length; i += 3) {
    const x = vertices[i];
    const y = vertices[i + 1];
    const z = vertices[i + 2];
    if (plane === 'XY') points.push([x, y]);
    else if (plane === 'YZ') points.push([y, z]);
    else points.push([z, x]);
  }

  const hull = buildOutlineHull(points, detailLevel);
  const area = Math.abs(polygonArea(hull));
  const perimeter = polygonPerimeter(hull);
  const bounds = compute2dBounds(hull);

  return { plane, hull, area, perimeter, bounds };
}

function convexHull2d(points) {
  if (!points.length) return [];
  const unique = dedupePoints(points);
  if (unique.length <= 2) return unique;

  unique.sort((a, b) => (a[0] === b[0] ? a[1] - b[1] : a[0] - b[0]));

  const lower = [];
  for (const point of unique) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) {
      lower.pop();
    }
    lower.push(point);
  }

  const upper = [];
  for (let i = unique.length - 1; i >= 0; i -= 1) {
    const point = unique[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) {
      upper.pop();
    }
    upper.push(point);
  }

  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

function buildOutlineHull(points, detailLevel = 0.6) {
  const baseHull = convexHull2d(points);
  if (detailLevel <= 0.15 || baseHull.length <= 3) return baseHull;
  return refineHullWithConcavity(points, baseHull, detailLevel);
}

function dedupePoints(points, tolerance = 1e-4) {
  const map = new Map();
  for (const [x, y] of points) {
    const key = `${Math.round(x / tolerance)}|${Math.round(y / tolerance)}`;
    if (!map.has(key)) map.set(key, [x, y]);
  }
  return Array.from(map.values());
}

function cross(o, a, b) {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

function refineHullWithConcavity(points, baseHull, detailLevel) {
  if (!baseHull.length) return baseHull;
  const deduped = dedupePoints(points);
  const candidateMap = new Map();
  const baseKeys = new Set(baseHull.map((pt) => pointKey(pt)));
  deduped.forEach((pt) => {
    const key = pointKey(pt);
    if (!baseKeys.has(key)) candidateMap.set(key, pt);
  });
  const candidates = Array.from(candidateMap.values());
  if (!candidates.length) return baseHull;

  const bounds = compute2dBounds(deduped);
  const maxSpan = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY) || 1;
  const thresholdMin = maxSpan * 0.02;
  const threshold = Math.max(thresholdMin, maxSpan * (1 - detailLevel) * 0.35);
  const refined = baseHull.slice();
  let iterations = 0;

  while (candidates.length && iterations < 200) {
    let inserted = false;
    for (let i = 0; i < refined.length; i += 1) {
      const a = refined[i];
      const b = refined[(i + 1) % refined.length];
      let bestIndex = -1;
      let bestDistance = threshold;

      for (let j = 0; j < candidates.length; j += 1) {
        const candidate = candidates[j];
        if (cross(a, b, candidate) >= 0) continue;
        const distance = distancePointToEdge(candidate, a, b);
        if (distance > bestDistance) {
          bestDistance = distance;
          bestIndex = j;
        }
      }

      if (bestIndex !== -1) {
        const point = candidates.splice(bestIndex, 1)[0];
        refined.splice(i + 1, 0, point);
        inserted = true;
        if (refined.length > 1200) return refined;
      }
    }

    if (!inserted) break;
    iterations += 1;
  }

  return refined;
}

function polygonArea(points) {
  if (points.length < 3) return 0;
  let area = 0;
  for (let i = 0; i < points.length; i += 1) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    area += x1 * y2 - x2 * y1;
  }
  return area / 2;
}

function polygonPerimeter(points) {
  if (points.length < 2) return 0;
  let perimeter = 0;
  for (let i = 0; i < points.length; i += 1) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    perimeter += Math.hypot(x2 - x1, y2 - y1);
  }
  return perimeter;
}

function compute2dBounds(points) {
  if (!points.length) return { minX: 0, maxX: 0, minY: 0, maxY: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { minX, maxX, minY, maxY };
}

function buildPreviewPoints(vertices, limit = 4000) {
  if (!vertices || !vertices.length) return [];
  const result = [];
  const total = vertices.length / 3;
  const stride = Math.max(1, Math.floor(total / limit));
  for (let i = 0; i < total; i += stride) {
    result.push([
      vertices[i * 3],
      vertices[i * 3 + 1],
      vertices[i * 3 + 2]
    ]);
  }
  return result;
}

function roundTo(value, step = 1e-6) {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value / step) * step;
}

function computeFaceNormal(v1, v2, v3) {
  const ax = v2[0] - v1[0];
  const ay = v2[1] - v1[1];
  const az = v2[2] - v1[2];
  const bx = v3[0] - v1[0];
  const by = v3[1] - v1[1];
  const bz = v3[2] - v1[2];
  return [
    ay * bz - az * by,
    az * bx - ax * bz,
    ax * by - ay * bx
  ];
}

function triangleArea(v1, v2, v3) {
  const ax = v2[0] - v1[0];
  const ay = v2[1] - v1[1];
  const az = v2[2] - v1[2];
  const bx = v3[0] - v1[0];
  const by = v3[1] - v1[1];
  const bz = v3[2] - v1[2];
  const crossX = ay * bz - az * by;
  const crossY = az * bx - ax * bz;
  const crossZ = ax * by - ay * bx;
  return 0.5 * Math.hypot(crossX, crossY, crossZ);
}

function normalizeVector(vector) {
  const length = Math.hypot(vector[0], vector[1], vector[2]);
  if (!length) return [0, 0, 0];
  return [vector[0] / length, vector[1] / length, vector[2] / length];
}

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function computeSignedVolume(faces) {
  let total = 0;
  for (const face of faces) {
    const [v0, v1, v2] = face.vertices;
    total += dot(v0, cross3d(v1, v2));
  }
  return total / 6;
}

function cross3d(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0]
  ];
}

function distancePointToEdge(point, start, end) {
  const [px, py] = point;
  const [ax, ay] = start;
  const [bx, by] = end;
  const abx = bx - ax;
  const aby = by - ay;
  const apx = px - ax;
  const apy = py - ay;
  const area = Math.abs(abx * apy - aby * apx);
  const length = Math.hypot(abx, aby) || 1;
  return area / length;
}

function pointKey([x, y], tolerance = 1e-4) {
  return `${Math.round(x / tolerance)}|${Math.round(y / tolerance)}`;
}

function clampDetailLevel(value) {
  if (!Number.isFinite(value)) return 0.6;
  return Math.min(0.99, Math.max(0.05, value));
}

export {
  parseStl,
  analyseMesh,
  simplifyMesh,
  projectOutline,
  computeBoundingBox
};

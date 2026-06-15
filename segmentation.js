/**
 * segmentation.js — V2 Topologie-basierte Mesh-Segmentierung
 *
 * STATUS: PARKEND (2026-04-20). Aktuell nicht verdrahtet — der Worker nutzt
 * das einfachere Region-Growing via Dihedral-Winkel (normalGroups) direkt.
 * Dieses Modul ist die vollständigere Variante mit Primitiv-Fitting + Loop-
 * Klassifikation (LINE/ARC). Wird reaktiviert, wenn Face-Unification zu echter
 * Zylinder-/Kegel-Rekonstruktion ausgebaut wird (siehe TODO.md "Bohrungen erkennen").
 *
 * Pipeline:
 *   1. buildAdjacency     → Dreiecks-Nachbarschaftsgraph (geteilte Kanten)
 *   2. growRegions        → Region-Growing: zusammenhängende Flächen-Cluster
 *   3. fitPrimitive       → Primitiv-Anpassung (Ebene / Zylinder / Kegel) pro Region
 *   4. extractBoundary    → Grenzkanten zwischen verschiedenen Regionen
 *   5. chainLoops         → Geordnete geschlossene Vertex-Schleifen
 *   6. classifyEdges      → LINE oder ARC pro Schleifensegment
 *   7. assembleTopology   → Finales {regions, topology} Ergebnis
 *
 * Input:  mesh.faces von parseStl() — Array<{normal:[nx,ny,nz], vertices:[[x,y,z]×3], area:number}>
 * Output: SegmentationResult — {regions, topology, stats}
 */

// ============================================================
// VEKTORMATHEMATIK
// ============================================================

const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add3 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale3 = (v, s) => [v[0] * s, v[1] * s, v[2] * s];
const len3 = (v) => Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
const norm3 = (v) => { const l = len3(v) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const cross3 = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0]
];
const centroid3 = (pts) => {
  const s = [0, 0, 0];
  for (const p of pts) { s[0] += p[0]; s[1] += p[1]; s[2] += p[2]; }
  return scale3(s, 1 / pts.length);
};

// ============================================================
// VERTEX-DEDUPLIZIERUNG
// ============================================================

const vtxKey = (v, tol) =>
  `${Math.round(v[0] / tol)}|${Math.round(v[1] / tol)}|${Math.round(v[2] / tol)}`;

const canonicalEdgeKey = (vA, vB, tol) => {
  const kA = vtxKey(vA, tol), kB = vtxKey(vB, tol);
  return kA < kB ? `${kA}~${kB}` : `${kB}~${kA}`;
};

// ============================================================
// SCHRITT 1: DREIECKS-NACHBARSCHAFTSGRAPH
// ============================================================

/**
 * Baut einen Nachbarschaftsgraph: für jede Kante wird gespeichert welche
 * Dreiecke sie teilen. Dreiecke mit gemeinsamer Kante sind Nachbarn.
 *
 * @returns {{ edgeMap: Map, faceNeighbors: number[][] }}
 */
function buildAdjacency(faces, tol) {
  // edgeKey → { v0, v1, faceIndices: number[] }
  const edgeMap = new Map();
  const faceNeighbors = faces.map(() => []);

  for (let i = 0; i < faces.length; i++) {
    const verts = faces[i].vertices;
    const edgePairs = [
      [verts[0], verts[1]],
      [verts[1], verts[2]],
      [verts[2], verts[0]]
    ];
    for (const [vA, vB] of edgePairs) {
      const key = canonicalEdgeKey(vA, vB, tol);
      if (!edgeMap.has(key)) {
        edgeMap.set(key, { v0: vA, v1: vB, faceIndices: [] });
      }
      edgeMap.get(key).faceIndices.push(i);
    }
  }

  // Nachbarn ableiten: zwei Dreiecke teilen eine Kante → Nachbarn
  for (const entry of edgeMap.values()) {
    if (entry.faceIndices.length === 2) {
      const [fi, fj] = entry.faceIndices;
      faceNeighbors[fi].push(fj);
      faceNeighbors[fj].push(fi);
    }
  }

  return { edgeMap, faceNeighbors };
}

// ============================================================
// SCHRITT 2: REGION GROWING
// ============================================================

/**
 * BFS-basiertes Region Growing: benachbarte Dreiecke werden zur selben
 * Region zusammengefasst, wenn ihre Normalen ähnlich genug sind.
 *
 * dot(nA, nB) > normalThreshold → gleiche Region
 *
 * @returns {{ faceToRegion: Int32Array, regions: number[][] }}
 */
function growRegions(faces, faceNeighbors, normalThreshold) {
  const faceToRegion = new Int32Array(faces.length).fill(-1);
  const regions = [];
  const queue = [];

  for (let start = 0; start < faces.length; start++) {
    if (faceToRegion[start] !== -1) continue;

    const regionId = regions.length;
    const regionFaces = [];
    queue.length = 0;
    queue.push(start);
    faceToRegion[start] = regionId;

    let qi = 0;
    while (qi < queue.length) {
      const fi = queue[qi++];
      regionFaces.push(fi);
      const nA = faces[fi].normal;

      for (const fj of faceNeighbors[fi]) {
        if (faceToRegion[fj] !== -1) continue;
        const nB = faces[fj].normal;
        const d = nA[0] * nB[0] + nA[1] * nB[1] + nA[2] * nB[2];
        if (d >= normalThreshold) {
          faceToRegion[fj] = regionId;
          queue.push(fj);
        }
      }
    }

    regions.push(regionFaces);
  }

  return { faceToRegion, regions };
}

/**
 * Zweiter Pass: Kleine Splitter-Regionen (weniger als minFaces Dreiecke)
 * werden in die größte benachbarte Region eingemeindet.
 */
function mergeSmallRegions(faces, faceNeighbors, faceToRegion, regions, minFaces) {
  let changed = true;
  while (changed) {
    changed = false;
    for (let rid = 0; rid < regions.length; rid++) {
      const regionFaces = regions[rid];
      if (!regionFaces || regionFaces.length >= minFaces) continue;

      // Finde die größte benachbarte Region
      const neighborCounts = new Map();
      for (const fi of regionFaces) {
        for (const fj of faceNeighbors[fi]) {
          const nrid = faceToRegion[fj];
          if (nrid !== rid) {
            neighborCounts.set(nrid, (neighborCounts.get(nrid) || 0) + 1);
          }
        }
      }
      if (neighborCounts.size === 0) continue;

      let bestRid = -1, bestCount = 0;
      for (const [nrid, count] of neighborCounts) {
        if (regions[nrid] && count > bestCount) { bestCount = count; bestRid = nrid; }
      }
      if (bestRid === -1) continue;

      // Merge: alle Dreiecke von rid → bestRid
      for (const fi of regionFaces) {
        faceToRegion[fi] = bestRid;
        regions[bestRid].push(fi);
      }
      regions[rid] = null; // als gelöscht markieren
      changed = true;
    }
  }

  // Kompaktieren: null-Einträge entfernen und IDs neu vergeben
  const newRegions = regions.filter(Boolean);
  const oldToNew = new Map();
  for (let newId = 0; newId < newRegions.length; newId++) {
    for (const fi of newRegions[newId]) {
      oldToNew.set(faceToRegion[fi], newId); // wird mehrfach gesetzt, immer gleicher Wert
    }
  }
  // faceToRegion updaten
  for (let fi = 0; fi < faceToRegion.length; fi++) {
    faceToRegion[fi] = oldToNew.get(faceToRegion[fi]) ?? faceToRegion[fi];
  }

  return newRegions;
}

// ============================================================
// SCHRITT 3: PRIMITIV-ANPASSUNG
// ============================================================

/**
 * 3×3 symmetrische Eigenwertzerlegung via Jacobi-Iteration.
 * Gibt Eigenwerte+Eigenvektoren sortiert nach Eigenwert (aufsteigend) zurück.
 */
function eigen3x3Sym(A) {
  // Arbeitskopie
  const a = [A[0].slice(), A[1].slice(), A[2].slice()];
  // Eigenvektoren als Spalten (initialisiert als Einheitsmatrix)
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const PAIRS = [[0, 1], [0, 2], [1, 2]];

  for (let sweep = 0; sweep < 30; sweep++) {
    // Prüfe Konvergenz: Summe der Nebendiagonal-Quadrate
    let offSum = 0;
    for (const [p, q] of PAIRS) offSum += a[p][q] * a[p][q];
    if (offSum < 1e-24) break;

    for (const [p, q] of PAIRS) {
      if (Math.abs(a[p][q]) < 1e-14) continue;
      const tau = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = Math.sign(tau) / (Math.abs(tau) + Math.sqrt(1 + tau * tau));
      const c = 1 / Math.sqrt(1 + t * t);
      const s = t * c;
      const apq = a[p][q];
      // Diagonalelemente aktualisieren
      a[p][p] -= t * apq;
      a[q][q] += t * apq;
      a[p][q] = a[q][p] = 0;
      // r ist das dritte Indexelement (0+1+2=3)
      const r = 3 - p - q;
      const apr = a[p][r], aqr = a[q][r];
      a[p][r] = a[r][p] = c * apr - s * aqr;
      a[q][r] = a[r][q] = s * apr + c * aqr;
      // Eigenvektoren aktualisieren
      for (let i = 0; i < 3; i++) {
        const vip = v[i][p], viq = v[i][q];
        v[i][p] = c * vip - s * viq;
        v[i][q] = s * vip + c * viq;
      }
    }
  }

  // Eigenwerte und Spaltenvektoren sortiert nach Eigenwert (aufsteigend)
  const eigs = [
    { val: a[0][0], vec: [v[0][0], v[1][0], v[2][0]] },
    { val: a[1][1], vec: [v[0][1], v[1][1], v[2][1]] },
    { val: a[2][2], vec: [v[0][2], v[1][2], v[2][2]] }
  ].sort((x, y) => x.val - y.val);

  return eigs;
}

/** Ebenen-Fit: gewichteter Durchschnitt der Normalen */
function fitPlane(faces, indices) {
  let nx = 0, ny = 0, nz = 0;
  let cx = 0, cy = 0, cz = 0;
  let totalArea = 0;

  for (const i of indices) {
    const f = faces[i];
    const a = f.area || 1;
    nx += f.normal[0] * a; ny += f.normal[1] * a; nz += f.normal[2] * a;
    const v0 = f.vertices[0];
    cx += v0[0] * a; cy += v0[1] * a; cz += v0[2] * a;
    totalArea += a;
  }

  const normal = norm3([nx / totalArea, ny / totalArea, nz / totalArea]);
  const centroid = [cx / totalArea, cy / totalArea, cz / totalArea];
  const offset = dot3(normal, centroid);

  // Residual: mittlere Normalenabweichung
  let residual = 0;
  for (const i of indices) {
    const d = dot3(faces[i].normal, normal);
    residual += 1 - d * d;
  }
  residual /= indices.length;

  return { type: 'plane', normal, centroid, offset, residual };
}

/**
 * Zylinder-Fit via PCA auf den Normalen.
 * Die Zylinderachse ist der Eigenvektor zum kleinsten Eigenwert der
 * gewichteten Normalenkovarianzmatrix (alle Normalen ⊥ Achse).
 */
function fitCylinder(faces, indices) {
  let c00 = 0, c01 = 0, c02 = 0, c11 = 0, c12 = 0, c22 = 0;
  let cx = 0, cy = 0, cz = 0, totalArea = 0;

  for (const i of indices) {
    const n = faces[i].normal;
    const a = faces[i].area || 1;
    c00 += n[0] * n[0] * a; c01 += n[0] * n[1] * a; c02 += n[0] * n[2] * a;
    c11 += n[1] * n[1] * a; c12 += n[1] * n[2] * a; c22 += n[2] * n[2] * a;
    const v0 = faces[i].vertices[0];
    cx += v0[0] * a; cy += v0[1] * a; cz += v0[2] * a;
    totalArea += a;
  }

  const C = [
    [c00 / totalArea, c01 / totalArea, c02 / totalArea],
    [c01 / totalArea, c11 / totalArea, c12 / totalArea],
    [c02 / totalArea, c12 / totalArea, c22 / totalArea]
  ];

  const eigs = eigen3x3Sym(C);
  // Kleinster Eigenwert → Achsenrichtung (alle Normalen ⊥ Achse)
  const axis = norm3(eigs[0].vec);
  const eigenRatio = eigs[0].val / (eigs[2].val || 1);

  // Schwerpunkt, dann auf Ebene ⊥ Achse projizieren → Achspunkt
  const centroid = [cx / totalArea, cy / totalArea, cz / totalArea];
  const projC = dot3(centroid, axis);
  const axisPoint = sub3(centroid, scale3(axis, projC));

  // Mittlerer Radius: Abstand jedes Dreieck-Schwerpunkts von der Achse
  let sumR = 0, sumR2 = 0;
  for (const i of indices) {
    const v0 = faces[i].vertices[0];
    const toPoint = sub3(v0, axisPoint);
    const along = dot3(toPoint, axis);
    const radVec = sub3(toPoint, scale3(axis, along));
    const r = len3(radVec);
    sumR += r; sumR2 += r * r;
  }
  const radius = sumR / indices.length;
  const residual = sumR2 / indices.length - radius * radius; // Varianz

  return { type: 'cylinder', axis, axisPoint, radius, residual, eigenRatio };
}

/**
 * Kegel-Fit für achsenparallele Kegel (X/Y/Z).
 * Ein Kegel hat Normalen bei konstantem Winkel zur Achse:
 * dot(n_i, axis) = cos(α) = konstant für alle i.
 */
function fitCone(faces, indices) {
  const CANDIDATE_AXES = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

  for (const candidateAxis of CANDIDATE_AXES) {
    const dots = indices.map((i) => dot3(faces[i].normal, candidateAxis));
    const mean = dots.reduce((s, d) => s + d, 0) / dots.length;

    // Kegel-Bedingung: mittlerer Dot ∈ (0.05, 0.99) → nicht zu flach, nicht zu aufrecht
    if (Math.abs(mean) < 0.05 || Math.abs(mean) > 0.99) continue;

    const variance = dots.reduce((s, d) => s + (d - mean) ** 2, 0) / dots.length;
    if (variance > 0.01) continue; // Normalen nicht konsistent → kein Kegel

    const halfAngle = Math.acos(Math.abs(mean));
    const axis = mean > 0 ? candidateAxis : [-candidateAxis[0], -candidateAxis[1], -candidateAxis[2]];

    // Achsen-Extrempunkte bestimmen
    let axMin = Infinity, axMax = -Infinity;
    let cx = 0, cy = 0, cz = 0, totalArea = 0;
    for (const i of indices) {
      for (const v of faces[i].vertices) {
        const aCoord = dot3(v, axis);
        if (aCoord < axMin) axMin = aCoord;
        if (aCoord > axMax) axMax = aCoord;
      }
      const v0 = faces[i].vertices[0];
      const a = faces[i].area || 1;
      cx += v0[0] * a; cy += v0[1] * a; cz += v0[2] * a;
      totalArea += a;
    }
    const centroid = [cx / totalArea, cy / totalArea, cz / totalArea];

    // Radien an beiden Enden schätzen (unteres/oberes Viertel)
    const span = axMax - axMin;
    const computeRadiusAtBand = (loCoord, hiCoord) => {
      let sum = 0, count = 0;
      for (const i of indices) {
        const v = faces[i].vertices[0];
        const aCoord = dot3(v, axis);
        if (aCoord >= loCoord && aCoord <= hiCoord) {
          const radVec = sub3(v, scale3(axis, aCoord));
          sum += len3(radVec);
          count++;
        }
      }
      return count > 0 ? sum / count : 0;
    };
    const radiusBottom = computeRadiusAtBand(axMin, axMin + span * 0.25);
    const radiusTop = computeRadiusAtBand(axMax - span * 0.25, axMax);

    return {
      type: 'cone',
      axis,
      halfAngle,
      axisRange: [axMin, axMax],
      radiusBottom,
      radiusTop,
      centroid,
      residual: variance
    };
  }
  return null;
}

/**
 * Bestimmt das am besten passende Primitiv für eine Region.
 * Entscheidungsbaum: Ebene → Zylinder → Kegel → Unbekannt
 */
function fitPrimitive(faces, indices) {
  if (indices.length === 0) return { type: 'unknown' };

  const plane = fitPlane(faces, indices);
  // Sehr niedrige Normalen-Varianz → eindeutige Ebene
  if (plane.residual < 0.005) return plane;

  // PCA für Zylinder-Test
  const cyl = fitCylinder(faces, indices);
  // Eigenwertverhältnis klein → Achse gut definiert, Radius konsistent
  if (cyl.eigenRatio < 0.15 && cyl.residual < (cyl.radius * 0.15) ** 2) {
    // Kegel-Check: wenn die Normalen einen konstanten Achsen-Dot haben → Kegel
    const cone = fitCone(faces, indices);
    if (cone && cone.residual < 0.008) return cone;
    return cyl;
  }

  // Kegel-Test direkt (für achsen-ausgerichtete Kegel)
  const cone = fitCone(faces, indices);
  if (cone && cone.residual < 0.008) return cone;

  return plane; // Fallback
}

// ============================================================
// SCHRITT 4: GRENZKANTEN EXTRAHIEREN
// ============================================================

/**
 * Alle Kanten die zwei verschiedene Regionen trennen.
 * @returns {Array<{v0, v1, regionA, regionB}>}
 */
function extractBoundaryEdges(edgeMap, faceToRegion) {
  const boundary = [];
  for (const entry of edgeMap.values()) {
    if (entry.faceIndices.length !== 2) continue;
    const [fi, fj] = entry.faceIndices;
    const rA = faceToRegion[fi], rB = faceToRegion[fj];
    if (rA !== rB) {
      boundary.push({ v0: entry.v0, v1: entry.v1, regionA: rA, regionB: rB });
    }
  }
  return boundary;
}

// ============================================================
// SCHRITT 5: KANTEN ZU SCHLEIFEN VERKETTEN
// ============================================================

/**
 * Gruppiert Grenzkanten nach Region-Paaren und baut daraus
 * geschlossene Vertex-Schleifen (Loops).
 *
 * @returns {Map<string, {regionA, regionB, loops: [[[x,y,z]]]}> }
 */
function chainEdgesIntoLoops(boundaryEdges, tol) {
  // Gruppierung nach kanonischem Region-Paar
  const groups = new Map();
  for (const edge of boundaryEdges) {
    const key = `${Math.min(edge.regionA, edge.regionB)}:${Math.max(edge.regionA, edge.regionB)}`;
    if (!groups.has(key)) {
      groups.set(key, { regionA: edge.regionA, regionB: edge.regionB, edges: [] });
    }
    groups.get(key).edges.push(edge);
  }

  const result = new Map();
  for (const [key, group] of groups) {
    result.set(key, {
      regionA: group.regionA,
      regionB: group.regionB,
      loops: buildClosedChains(group.edges, tol)
    });
  }
  return result;
}

/**
 * Baut geschlossene Ketten aus einer Menge ungeordneter Kanten.
 * Jede Kante hat zwei Endpunkte; am Endpunkt treffen sich genau
 * zwei Kanten (manifoldes Mesh) → eindeutiger Traversierungspfad.
 */
function buildClosedChains(edges, tol) {
  // Vertex-Adjazenz: vtxKey → [nachbar-vtxKey]
  const adj = new Map();
  const ptByKey = new Map();
  const edgeVisited = new Set();

  for (const edge of edges) {
    const ka = vtxKey(edge.v0, tol), kb = vtxKey(edge.v1, tol);
    ptByKey.set(ka, edge.v0);
    ptByKey.set(kb, edge.v1);
    if (!adj.has(ka)) adj.set(ka, []);
    if (!adj.has(kb)) adj.set(kb, []);
    adj.get(ka).push(kb);
    adj.get(kb).push(ka);
  }

  const evKey = (ka, kb) => ka < kb ? `${ka}~${kb}` : `${kb}~${ka}`;
  const chains = [];

  for (const [startKey] of adj) {
    for (const firstNeighbor of adj.get(startKey)) {
      const ek = evKey(startKey, firstNeighbor);
      if (edgeVisited.has(ek)) continue;

      // Neue Kette starten
      const chain = [ptByKey.get(startKey)];
      edgeVisited.add(ek);

      let curKey = firstNeighbor;
      let prevKey = startKey;

      while (curKey !== startKey) {
        chain.push(ptByKey.get(curKey));

        // Nächste unbesuchte Kante finden (nicht zurück zu prevKey)
        const neighbors = adj.get(curKey) || [];
        const nextKey = neighbors.find((k) => {
          const e = evKey(curKey, k);
          return !edgeVisited.has(e);
        });

        if (!nextKey) break; // offene Kette oder nicht-mannigfaltig

        edgeVisited.add(evKey(curKey, nextKey));
        prevKey = curKey;
        curKey = nextKey;
      }

      if (curKey === startKey && chain.length >= 3) {
        chains.push(chain);
      }
    }
  }

  return chains;
}

// ============================================================
// SCHRITT 6: LINE / ARC KLASSIFIZIERUNG
// ============================================================

/**
 * Kreisfit durch 3 Punkte (Umkreis-Methode).
 * Gibt {center, radius, normal} zurück oder null bei Degeneration.
 */
function fitCircle3Points(p0, p1, p2) {
  const a = sub3(p1, p0);
  const b = sub3(p2, p0);
  const normal = norm3(cross3(a, b));

  if (len3(cross3(a, b)) < 1e-10) return null; // Punkte kollinear

  // Umkreismittelpunkt in der Ebene der drei Punkte
  const D = 2 * (a[0] * b[1] - a[1] * b[0] +
                 a[1] * b[2] - a[2] * b[1] +
                 a[2] * b[0] - a[0] * b[2]);
  if (Math.abs(D) < 1e-12) return null;

  // Kreismittelpunkt als Offset von p0
  const lenA2 = dot3(a, a), lenB2 = dot3(b, b);
  const ux = (lenA2 * (b[1] + b[2]) - lenB2 * (a[1] + a[2])) / D;
  const uy = (lenB2 * (a[0] + a[2]) - lenA2 * (b[0] + b[2])) / D;
  const uz = (lenA2 * (b[0] + b[1]) - lenB2 * (a[0] + a[1])) / D;

  const center = add3(p0, [ux, uy, uz]);
  const radius = len3(sub3(center, p0));

  if (!Number.isFinite(radius) || radius > 1e6) return null;

  return { center, radius, normal };
}

/**
 * Klassifiziert eine geschlossene Schleife von Punkten in LINE/ARC-Segmente.
 *
 * Methode:
 *   1. Krümmung κ[i] = Winkel zwischen dir[i-1→i] und dir[i→i+1]
 *   2. κ ≈ 0 → LINE
 *   3. κ ≈ konstant ≠ 0 → ARC (Kreisbogen)
 *   4. Sprünge in κ → Segment-Grenze
 */
function classifyLoop(loopPoints, curvatureVarianceThreshold = 0.04) {
  const n = loopPoints.length;
  if (n < 3) return [{ type: 'LINE', points: loopPoints }];

  // Richtungsvektoren der Kanten
  const dirs = loopPoints.map((p, i) => norm3(sub3(loopPoints[(i + 1) % n], p)));

  // Krümmung: Winkel zwischen aufeinanderfolgenden Richtungen
  const kappas = dirs.map((d, i) => Math.acos(Math.max(-1, Math.min(1, dot3(d, dirs[(i + 1) % n])))));

  // Segmente erkennen: Grenzen dort wo κ stark springt
  const segments = [];
  let segStart = 0;

  const flush = (end) => {
    if (end <= segStart) return;
    const pts = [];
    for (let k = segStart; k <= end; k++) pts.push(loopPoints[k % n]);

    const ks = [];
    for (let k = segStart; k < end; k++) ks.push(kappas[k % n]);
    const meanK = ks.reduce((s, v) => s + v, 0) / (ks.length || 1);
    const varK = ks.reduce((s, v) => s + (v - meanK) ** 2, 0) / (ks.length || 1);

    if (meanK < 0.02 || pts.length < 3) {
      segments.push({ type: 'LINE', points: pts });
    } else if (Math.sqrt(varK) < curvatureVarianceThreshold) {
      // Konstante Krümmung → Kreisbogen
      const mid = pts[Math.floor(pts.length / 2)];
      const circle = fitCircle3Points(pts[0], mid, pts[pts.length - 1]);
      if (circle) {
        segments.push({ type: 'ARC', points: pts, ...circle });
      } else {
        segments.push({ type: 'LINE', points: pts });
      }
    } else {
      // Gemischte Krümmung → als LINE exportieren (konservativ)
      segments.push({ type: 'LINE', points: pts });
    }
  };

  for (let i = 1; i < n; i++) {
    const prev = kappas[(i - 1) % n];
    const curr = kappas[i % n];
    // Segment-Grenze: Krümmungssprung oder Übergang flach ↔ gekrümmt
    const jump = Math.abs(curr - prev) > curvatureVarianceThreshold * 3;
    const toFlat = curr < 0.02 && prev >= 0.02;
    const fromFlat = curr >= 0.02 && prev < 0.02;
    if (jump || toFlat || fromFlat) {
      flush(i);
      segStart = i;
    }
  }
  flush(n - 1 + segStart); // letztes Segment schließen

  return segments.length > 0 ? segments : [{ type: 'LINE', points: loopPoints }];
}

// ============================================================
// SCHRITT 7: TOPOLOGIE ZUSAMMENSTELLEN
// ============================================================

/**
 * Bestimmt für jede Region ihre Schleifen.
 * Eine Schleife gehört zu einer Region, wenn sie auf der Grenze zwischen
 * dieser Region und einer anderen liegt.
 *
 * Für die äußere/innere Loop-Unterscheidung: Das Kreuzprodukt der
 * Schleifentangente mit der Flächen-Normalen zeigt nach innen oder außen.
 */
function assembleTopology(regions, primitives, loopsByPair, faceToRegion) {
  // Initialisiere leere Loop-Listen pro Region
  const regionLoops = regions.map(() => []); // regionId → [{edges, neighborRegion}]

  for (const [, pairData] of loopsByPair) {
    const { regionA, regionB, loops } = pairData;
    for (const loopPoints of loops) {
      const classifiedEdges = classifyLoop(loopPoints);

      // Gleiche Schleife, einmal pro Region (mit entgegengesetzter Orientierung)
      if (regionA < regions.length) {
        regionLoops[regionA].push({ edges: classifiedEdges, neighborRegion: regionB, points: loopPoints });
      }
      if (regionB < regions.length) {
        regionLoops[regionB].push({ edges: classifiedEdges, neighborRegion: regionA, points: loopPoints });
      }
    }
  }

  return regions.map((indices, id) => ({
    regionId: id,
    primitive: primitives[id],
    loops: regionLoops[id],
    area: indices.reduce((s, i) => s + (i < faceToRegion.length ? 1 : 0), 0)
  }));
}

// ============================================================
// ÖFFENTLICHE API
// ============================================================

/**
 * Vollständige V2-Segmentierungs-Pipeline.
 *
 * @param {Array} faces - mesh.faces von parseStl()
 * @param {object} options
 * @param {number} [options.normalThreshold=0.95]         - dot-Produkt-Schwellwert für Region Growing
 * @param {number} [options.curvatureVarianceThreshold=0.04] - Toleranz für ARC-Erkennung
 * @param {number} [options.vtxSnapTolerance=1e-3]        - Vertex-Deduplizierungs-Toleranz
 * @param {number} [options.minRegionFaces=3]             - Minimale Dreieckszahl pro Region
 * @param {function} [options.progress]                   - Fortschritts-Callback(ratio, detail)
 * @returns {SegmentationResult | null}
 */
export function segmentMesh(faces, options = {}) {
  const {
    normalThreshold = 0.95,
    curvatureVarianceThreshold = 0.04,
    vtxSnapTolerance = 1e-3,
    minRegionFaces = 3,
    progress = null
  } = options;

  if (!faces || faces.length === 0) return null;

  const report = (ratio, detail) => progress?.(ratio, detail);

  // Schritt 1: Nachbarschaftsgraph
  report(0.05, 'Segmentierung: Nachbarschaftsgraph aufbauen');
  const { edgeMap, faceNeighbors } = buildAdjacency(faces, vtxSnapTolerance);

  // Schritt 2: Region Growing
  report(0.20, 'Segmentierung: Regionen wachsen lassen');
  let { faceToRegion, regions } = growRegions(faces, faceNeighbors, normalThreshold);

  // Zweiter Pass: kleine Splitter-Regionen eingliedern
  report(0.35, 'Segmentierung: Kleine Regionen zusammenführen');
  regions = mergeSmallRegions(faces, faceNeighbors, faceToRegion, regions, minRegionFaces);

  // Schritt 3: Primitiv-Anpassung
  report(0.50, 'Segmentierung: Primitive anpassen');
  const primitives = regions.map((regionFaceIndices) => fitPrimitive(faces, regionFaceIndices));

  // Schritt 4: Grenzkanten
  report(0.65, 'Segmentierung: Grenzkanten extrahieren');
  const boundaryEdges = extractBoundaryEdges(edgeMap, faceToRegion);

  // Schritt 5: Schleifen verketten
  report(0.75, 'Segmentierung: Kanten zu Schleifen verketten');
  const loopsByPair = chainEdgesIntoLoops(boundaryEdges, vtxSnapTolerance);

  // Schritte 6+7: Klassifizierung und Topologie
  report(0.88, 'Segmentierung: Kantentypen bestimmen');
  const topology = assembleTopology(regions, primitives, loopsByPair, faceToRegion);

  report(1.0, 'Segmentierung abgeschlossen');

  // Primitive-Typ-Statistik
  const typeCount = { plane: 0, cylinder: 0, cone: 0, unknown: 0 };
  for (const p of primitives) typeCount[p.type] = (typeCount[p.type] || 0) + 1;

  return {
    regions: regions.map((indices, id) => ({
      id,
      triangleIndices: indices,
      primitive: primitives[id],
      area: indices.reduce((s, i) => s + (faces[i]?.area || 0), 0)
    })),
    topology,
    stats: {
      faceCount: faces.length,
      regionCount: regions.length,
      boundaryEdgeCount: boundaryEdges.length,
      primitiveTypes: typeCount
    }
  };
}

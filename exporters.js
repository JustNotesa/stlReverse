/**
 * Export-Funktionen:
 *   - buildOutlinesDxf / buildOutlinesStep: 2D-Konturen der Orthoprojektionen
 *   - buildVolumeStepBrepV2: 3D-Volumen-STEP aus normalGroups (Region-Growing)
 *   - buildVolumeStepTriangles: 1 ADVANCED_FACE pro STL-Dreieck (fallback)
 *
 * Ältere Feature-basierte Exporter (buildVolumeStepBrepV1, Legacy buildVolumeStepBrep)
 * sind entfernt — Feature-Detection für Cylinder/Cone/Sphere lief nie produktiv.
 * V1 liegt unter archive/buildVolumeStepBrepV1.js als Referenz.
 */
import {
  mapOutlinePointToDxf, mapOutlinePointToStep,
  defaultBounds, rectangleFromBounds
} from './utils.js';

export function buildOutlinesDxf(outlines) {
  const lines = [];
  const planeOrder = ['XY', 'YZ', 'ZX'];

  // DXF Header Section
  lines.push('0', 'SECTION', '2', 'HEADER');
  lines.push('9', '$ACADVER', '1', 'AC1015'); // AutoCAD 2000 format
  lines.push('9', '$INSUNITS', '70', '4'); // Units: Millimeters
  lines.push('9', '$MEASUREMENT', '70', '1'); // Metric
  lines.push('0', 'ENDSEC');

  // DXF Tables Section (Layer definitions)
  lines.push('0', 'SECTION', '2', 'TABLES');
  lines.push('0', 'TABLE', '2', 'LAYER', '70', String(planeOrder.length + 1));

  // Default layer 0
  lines.push('0', 'LAYER', '2', '0', '70', '0', '62', '7', '6', 'CONTINUOUS');

  // Layer for each projection plane with different colors
  const layerColors = { XY: '1', YZ: '3', ZX: '5' }; // Red, Green, Blue
  planeOrder.forEach((plane) => {
    lines.push('0', 'LAYER');
    lines.push('2', `Projection_${plane}`);
    lines.push('70', '0'); // Layer flags
    lines.push('62', layerColors[plane]); // Color number
    lines.push('6', 'CONTINUOUS'); // Linetype
  });

  lines.push('0', 'ENDTAB');
  lines.push('0', 'ENDSEC');

  // DXF Entities Section
  lines.push('0', 'SECTION', '2', 'ENTITIES');

  planeOrder.forEach((plane) => {
    const outline = outlines?.[plane];
    const points = outline?.hull;
    if (!points?.length) return;

    lines.push('0', 'LWPOLYLINE');
    lines.push('8', `Projection_${plane}`); // Layer name
    lines.push('62', layerColors[plane]); // Color
    lines.push('90', String(points.length)); // Number of vertices
    lines.push('70', '1'); // Closed polyline flag

    points.forEach(([u, v]) => {
      const [x, y] = mapOutlinePointToDxf(plane, u, v);
      lines.push('10', Number.isFinite(x) ? x.toFixed(6) : '0');
      lines.push('20', Number.isFinite(y) ? y.toFixed(6) : '0');
    });

    // Add dimension annotations for bounds
    const bounds = outline?.bounds;
    if (bounds) {
      const width = bounds.maxX - bounds.minX;
      const height = bounds.maxY - bounds.minY;

      // Add TEXT entity for dimension info
      lines.push('0', 'TEXT');
      lines.push('8', `Projection_${plane}`);
      lines.push('10', bounds.minX.toFixed(6));
      lines.push('20', (bounds.minY - 5).toFixed(6));
      lines.push('40', '2.5'); // Text height
      lines.push('1', `${plane}: ${width.toFixed(2)} x ${height.toFixed(2)}`);
    }
  });

  lines.push('0', 'ENDSEC', '0', 'EOF');
  return lines.join('\n');
}


export function buildOutlinesStep(outlines) {
  const planeOrder = ['XY', 'YZ', 'ZX'];
  const margin = 25;
  const xyBounds = outlines.XY?.bounds ?? defaultBounds();
  const yzBounds = outlines.YZ?.bounds ?? defaultBounds();
  const zxBounds = outlines.ZX?.bounds ?? defaultBounds();

  const widthXY = xyBounds.maxX - xyBounds.minX;
  const heightXY = xyBounds.maxY - xyBounds.minY;

  const offsets = {
    XY: { shiftX: -xyBounds.minX, shiftY: -xyBounds.minY, x: 0, y: 0 },
    YZ: { shiftX: -yzBounds.minX, shiftY: -yzBounds.minY, x: widthXY + margin, y: 0 },
    ZX: { shiftX: -zxBounds.minY, shiftY: -zxBounds.minX, x: 0, y: heightXY + margin }
  };

  const entities = [];
  const polylines = [];
  let nextId = 1;

  const toStepNumber = (value) => {
    if (!Number.isFinite(value)) return '0.';
    const fixed = Number(value).toFixed(6);
    return fixed.replace(/\.?0+$/, '') || '0';
  };

  const addPoint = (x, y, z = 0) => {
    const id = nextId++;
    entities.push(`#${id}=CARTESIAN_POINT('',(${toStepNumber(x)},${toStepNumber(y)},${toStepNumber(z)}));`);
    return id;
  };

  const addPolyline = (points) => {
    if (!points.length) return;
    const pointIds = points.map(([x, y, z]) => addPoint(x, y, z));
    pointIds.push(pointIds[0]);
    const id = nextId++;
    entities.push(`#${id}=POLYLINE('',(${pointIds.map((pt) => `#${pt}`).join(',')}));`);
    polylines.push(id);
  };

  planeOrder.forEach((plane) => {
    const outline = outlines?.[plane];
    if (!outline?.bounds) return;
    const hull =
      outline.hull?.length && outline.hull.length >= 3
        ? outline.hull
        : rectangleFromBounds(outline.bounds);
    if (!hull?.length) return;
    const points = hull.map(([u, v]) => mapOutlinePointToStep(plane, u, v, offsets));
    addPolyline(points);
  });

  if (!polylines.length) {
    throw new Error('Keine Outlines für STEP-Export vorhanden.');
  }

  // Unit definitions (more complete)
  const lengthUnitId = nextId++;
  entities.push(`#${lengthUnitId}=LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.);`);

  const planeAngleUnitId = nextId++;
  entities.push(`#${planeAngleUnitId}=PLANE_ANGLE_UNIT()NAMED_UNIT(*)SI_UNIT($,.RADIAN.);`);

  const solidAngleUnitId = nextId++;
  entities.push(`#${solidAngleUnitId}=SOLID_ANGLE_UNIT()NAMED_UNIT(*)SI_UNIT($,.STERADIAN.);`);

  // Uncertainty measure for geometric precision
  const uncertaintyId = nextId++;
  entities.push(`#${uncertaintyId}=UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-06),#${lengthUnitId},'distance accuracy value','maximum tolerance');`);

  const contextId = nextId++;
  entities.push(
    `#${contextId}=(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#${uncertaintyId}))GLOBAL_UNIT_ASSIGNED_CONTEXT((#${lengthUnitId},#${planeAngleUnitId},#${solidAngleUnitId}))REPRESENTATION_CONTEXT('','3D'));`
  );

  const curveSetId = nextId++;
  entities.push(`#${curveSetId}=GEOMETRIC_CURVE_SET('Outline Curves',(${polylines.map((id) => `#${id}`).join(',')}));`);

  const representationId = nextId++;
  entities.push(`#${representationId}=SHAPE_REPRESENTATION('Outlines',(#${curveSetId}),#${contextId});`);

  const timestamp = new Date().toISOString();
  return [
    'ISO-10303-21;',
    'HEADER;',
    "FILE_DESCRIPTION(('STLReverse Outlines - Parametric Sketch Export','Units: Millimeters'),'2;1');",
    `FILE_NAME('stlReverse-outlines.step','${timestamp}',('STLReverse'),('STLReverse Extension'),'STLReverse 0.1','STLReverse','');`,
    "FILE_SCHEMA(('AUTOMOTIVE_DESIGN'));",
    'ENDSEC;',
    'DATA;',
    ...entities,
    'ENDSEC;',
    'END-ISO-10303-21;'
  ].join('\n');
}
// ============================================================================
// V2 BRep STEP Generation — Topology-based (segmentation.js output)
//
// Strategy:
//   - Uses segmentation.topology (region growing by normal similarity)
//   - For each face region: collects all boundary loop points, projects to
//     local 2D (centroid + face normal), computes convex hull, back-projects
//     to 3D polygon.
//   - Builds one ADVANCED_FACE (PLANE surface) per region.
//   - Deduplicates shared edge endpoints for a valid MANIFOLD_SOLID_BREP.
//
// Returns { step, report } — step = STEP-Dateistring, report = Wasserdichtigkeits-
// Befund { faceCount, edgeCount, boundaryEdges, nonManifoldEdges, orientationDefects, watertight }.
// Gibt null zurück, wenn zu wenig Flächen für einen sinnvollen Körper vorliegen.
// ============================================================================

export function buildVolumeStepBrepV2(analysis) {
  // V2-Exporter: Nutzt echte Boundary-Loops aus normalGroups (wie Panel 3).
  // Jede normalGroup wird zu einer oder mehreren ADVANCED_FACE mit echten Polygon-Grenzen.
  const normalGroups = analysis?.normalGroups;
  if (!normalGroups?.length) return null;

  const entities = [];
  let id = 1;

  // ---- Number formatter ----
  const toStep = (v) => {
    if (!Number.isFinite(v)) return '0.';
    const t = Number(v).toFixed(6).replace(/(\.\d*?)0+$/, '$1');
    return t.includes('.') ? t : t + '.';
  };

  // ---- Entity helpers ----
  const addPoint = (pt) => {
    const pid = id++;
    entities.push(`#${pid}=CARTESIAN_POINT('',(${pt.map(toStep).join(',')}));`);
    return pid;
  };
  const addDirection = (vec) => {
    const len = Math.hypot(vec[0], vec[1], vec[2]) || 1;
    const d = vec.map((v) => v / len || 0);
    const did = id++;
    entities.push(`#${did}=DIRECTION('',(${d.map(toStep).join(',')}));`);
    return did;
  };
  const addVector = (dirId, mag) => {
    const vid = id++;
    entities.push(`#${vid}=VECTOR('',#${dirId},${toStep(mag)});`);
    return vid;
  };
  const addVertex = (ptId) => {
    const vid = id++;
    entities.push(`#${vid}=VERTEX_POINT('',#${ptId});`);
    return vid;
  };
  const addLine = (ptId, vecId) => {
    const lid = id++;
    entities.push(`#${lid}=LINE('',#${ptId},#${vecId});`);
    return lid;
  };
  const addEdgeCurve = (sv, ev, curveId) => {
    const eid = id++;
    entities.push(`#${eid}=EDGE_CURVE('',#${sv},#${ev},#${curveId},.T.);`);
    return eid;
  };
  const addOrientedEdge = (ecId, forward) => {
    const oid = id++;
    entities.push(`#${oid}=ORIENTED_EDGE('',*,*,#${ecId},.${forward ? 'T' : 'F'}.);`);
    return oid;
  };
  const addEdgeLoop = (oeIds) => {
    const lid = id++;
    entities.push(`#${lid}=EDGE_LOOP('',(${oeIds.map((e) => `#${e}`).join(',')}));`);
    return lid;
  };
  const addFaceOuterBound = (loopId) => {
    const bid = id++;
    entities.push(`#${bid}=FACE_OUTER_BOUND('',#${loopId},.T.);`);
    return bid;
  };
  const addFaceBound = (loopId) => {
    const bid = id++;
    entities.push(`#${bid}=FACE_BOUND('',#${loopId},.T.);`);
    return bid;
  };
  const addAxis2Placement3D = (loc, axis, refDir) => {
    const locId = addPoint(loc);
    const axId = addDirection(axis);
    const refId = addDirection(refDir);
    const pid = id++;
    entities.push(`#${pid}=AXIS2_PLACEMENT_3D('',#${locId},#${axId},#${refId});`);
    return pid;
  };
  const addPlane = (placId) => {
    const pid = id++;
    entities.push(`#${pid}=PLANE('',#${placId});`);
    return pid;
  };
  const addCircle = (placId, radius) => {
    const cid = id++;
    entities.push(`#${cid}=CIRCLE('',#${placId},${toStep(radius)});`);
    return cid;
  };
  const addCylindricalSurface = (placId, radius) => {
    const sid = id++;
    entities.push(`#${sid}=CYLINDRICAL_SURFACE('',#${placId},${toStep(radius)});`);
    return sid;
  };
  const addAdvancedFace = (boundIds, surfId, sameSense) => {
    const fid = id++;
    entities.push(`#${fid}=ADVANCED_FACE('',(${boundIds.map((b) => `#${b}`).join(',')}),#${surfId},.${sameSense ? 'T' : 'F'}.);`);
    return fid;
  };
  const addOpenShell = (faceIds) => {
    const sid = id++;
    entities.push(`#${sid}=OPEN_SHELL('',(${faceIds.map((f) => `#${f}`).join(',')}));`);
    return sid;
  };
  const addShellBasedSurfaceModel = (shellId) => {
    const bid = id++;
    entities.push(`#${bid}=SHELL_BASED_SURFACE_MODEL('V2 Reconstruction',(#${shellId}));`);
    return bid;
  };

  // ---- Math helpers (self-contained) ----
  const _dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const _sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const _cross3 = (a, b) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0]
  ];
  const _norm3 = (v) => {
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
  };

  // Stable reference direction perpendicular to `normal`
  const computeRefDir = (normal) => {
    const ax = Math.abs(normal[0]), ay = Math.abs(normal[1]), az = Math.abs(normal[2]);
    const ref = ax <= ay && ax <= az ? [1, 0, 0] : ay <= ax && ay <= az ? [0, 1, 0] : [0, 0, 1];
    return _norm3(_cross3(normal, ref));
  };

  // ---- Boundary loop extraction (same logic as Panel 3 viewer) ----
  const VKEY_DP = 4;
  // Naht-Normalisierung: An der Mantel-Naht (φ=0°↔360°) erzeugt der Tessellierer
  // sin(2π) ≈ -2.4e-16 → geometrisch identische Punkte bekommen y = -0.0 statt +0.0.
  // Ohne diese Normalisierung hashen sie auf "-0.0000" vs "0.0000" → die Kanten
  // entlang der Naht finden ihren Partner nicht → Hülle bleibt offen (Kegel-Bug).
  const fixZero = (v, dp) => { const r = +Number(v).toFixed(dp); return (r === 0 ? 0 : r).toFixed(dp); };
  const vtxKey = (v) => `${fixZero(v[0], VKEY_DP)},${fixZero(v[1], VKEY_DP)},${fixZero(v[2], VKEY_DP)}`;
  const edgeKeyFn = (a, b) => {
    const ka = vtxKey(a), kb = vtxKey(b);
    return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
  };

  // Chain boundary edges into closed loops (ordered 3D point lists).
  const chainEdges = (edges) => {
    const adj = new Map(); // vtxKey → { pt, nbs: [{ otherKey, otherPt, ek }] }
    for (const { v0, v1 } of edges) {
      const k0 = vtxKey(v0), k1 = vtxKey(v1);
      const ek = edgeKeyFn(v0, v1);
      if (!adj.has(k0)) adj.set(k0, { pt: v0, nbs: [] });
      if (!adj.has(k1)) adj.set(k1, { pt: v1, nbs: [] });
      adj.get(k0).nbs.push({ otherKey: k1, otherPt: v1, ek });
      adj.get(k1).nbs.push({ otherKey: k0, otherPt: v0, ek });
    }
    const used = new Set();
    const loops = [];
    for (const [startKey, entry] of adj) {
      for (const startNb of entry.nbs) {
        if (used.has(startNb.ek)) continue;
        used.add(startNb.ek);
        const loop = [entry.pt];
        let curKey = startNb.otherKey;
        let curPt = startNb.otherPt;
        let safety = adj.size * 2 + 10;
        while (curKey !== startKey && safety-- > 0) {
          loop.push(curPt);
          const curEntry = adj.get(curKey);
          if (!curEntry) break;
          let nextNb = null;
          for (const nb of curEntry.nbs) {
            if (!used.has(nb.ek)) { nextNb = nb; break; }
          }
          if (!nextNb) break;
          used.add(nextNb.ek);
          curKey = nextNb.otherKey;
          curPt = nextNb.otherPt;
        }
        if (loop.length >= 3 && curKey === startKey) loops.push(loop);
      }
    }
    return loops;
  };

  // Drop near-collinear intermediate points — normalized sin(angle) threshold ≈ 0.6°.
  // This heavily reduces loop vertex counts, turning triangulated boundaries into clean polygons.
  const SIMPLIFY_SIN_THRESHOLD = 0.01;
  const simplifyLoop = (loop) => {
    if (loop.length < 4) return loop;
    // Iterate passes until stable — removing one point can allow its neighbor to be removed too.
    let cur = loop.slice();
    for (let pass = 0; pass < 8; pass++) {
      const n = cur.length;
      if (n < 4) break;
      const out = [];
      for (let i = 0; i < n; i++) {
        const prev = out.length ? out[out.length - 1] : cur[(i - 1 + n) % n];
        const me = cur[i];
        const next = cur[(i + 1) % n];
        const d1 = _sub3(me, prev);
        const d2 = _sub3(next, me);
        const c = _cross3(d1, d2);
        const d1len = Math.hypot(d1[0], d1[1], d1[2]);
        const d2len = Math.hypot(d2[0], d2[1], d2[2]);
        const sinA = Math.hypot(c[0], c[1], c[2]) / ((d1len * d2len) || 1);
        if (sinA > SIMPLIFY_SIN_THRESHOLD) out.push(me);
      }
      if (out.length === cur.length || out.length < 3) break;
      cur = out;
    }
    return cur.length >= 3 ? cur : loop;
  };

  const pointInPoly2d = (pt, poly) => {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i][0], yi = poly[i][1];
      const xj = poly[j][0], yj = poly[j][1];
      const denom = (yj - yi) || 1e-20;
      if ((yi > pt[1]) !== (yj > pt[1]) &&
          pt[0] < ((xj - xi) * (pt[1] - yi)) / denom + xi) {
        inside = !inside;
      }
    }
    return inside;
  };

  // Extract faces from one normalGroup using connected-component flood fill.
  // Each spatial connected component is processed independently, preventing loop chains
  // from jumping between patches that only share a vertex (cause of spiky STEP geometry).
  // Nahezu 0: für einen WASSERDICHTEN Solid muss JEDE Region-Komponente eine Fläche werden —
  // eine weggelassene (kleine) Fläche verwaist ihre Kanten → offene Hülle. Echte Mini-Slivers
  // fängt ohnehin der `outerOe.length < 3`-Check unten ab.
  const MIN_FACE_AREA = 1e-6; // mm²
  const MIN_HOLE_AREA = 1e-6;

  const extractGroupFaces = (group) => {
    const verts = group.vertices;
    const normal = group.normal;
    // Mindestens 1 Dreieck (3 Verts) — ein >=3-Dreiecke-Filter verwarf hier 2-Dreieck-
    // Planflächen (z.B. Würfelwände) und machte den V2-Export unvollständig (Bug 2026-06-12).
    if (!Array.isArray(normal) || verts.length < 3) return [];

    const triCount = Math.floor(verts.length / 3);

    // Build triangle adjacency via shared edges.
    const triEdgeMap = new Map(); // edgeKey → [triIdx, ...]
    for (let t = 0; t < triCount; t++) {
      const tri = [verts[t * 3], verts[t * 3 + 1], verts[t * 3 + 2]];
      for (const [a, b] of [[tri[0], tri[1]], [tri[1], tri[2]], [tri[2], tri[0]]]) {
        const k = edgeKeyFn(a, b);
        if (!triEdgeMap.has(k)) triEdgeMap.set(k, []);
        triEdgeMap.get(k).push(t);
      }
    }

    // Flood fill connected components (triangles connected by shared edges).
    const visited = new Uint8Array(triCount);
    const components = [];
    for (let t = 0; t < triCount; t++) {
      if (visited[t]) continue;
      const comp = [];
      const queue = [t];
      visited[t] = 1;
      while (queue.length) {
        const cur = queue.pop();
        comp.push(cur);
        const tri = [verts[cur * 3], verts[cur * 3 + 1], verts[cur * 3 + 2]];
        for (const [a, b] of [[tri[0], tri[1]], [tri[1], tri[2]], [tri[2], tri[0]]]) {
          const k = edgeKeyFn(a, b);
          for (const nb of triEdgeMap.get(k)) {
            if (!visited[nb]) { visited[nb] = 1; queue.push(nb); }
          }
        }
      }
      components.push(comp);
    }

    // Process each connected component independently.
    const allFaces = [];
    for (const comp of components) {
      const compEdgeCount = new Map();
      const compEdgeEntries = new Map();
      for (const t of comp) {
        const tri = [verts[t * 3], verts[t * 3 + 1], verts[t * 3 + 2]];
        for (const [a, b] of [[tri[0], tri[1]], [tri[1], tri[2]], [tri[2], tri[0]]]) {
          const k = edgeKeyFn(a, b);
          compEdgeCount.set(k, (compEdgeCount.get(k) || 0) + 1);
          if (!compEdgeEntries.has(k)) compEdgeEntries.set(k, { v0: a, v1: b });
        }
      }
      const boundaryEdges = [];
      for (const [k, count] of compEdgeCount) {
        if (count === 1) boundaryEdges.push(compEdgeEntries.get(k));
      }
      if (boundaryEdges.length < 3) continue;

      const rawLoops = chainEdges(boundaryEdges);
      if (!rawLoops.length) continue;

      // Centroid for 2D projection.
      let cx = 0, cy = 0, cz = 0, ntot = 0;
      for (const loop of rawLoops) {
        for (const p of loop) { cx += p[0]; cy += p[1]; cz += p[2]; ntot++; }
      }
      if (ntot === 0) continue;
      const centroid = [cx / ntot, cy / ntot, cz / ntot];

      const uDir = computeRefDir(normal);
      const vDir = _norm3(_cross3(normal, uDir));
      const project2d = (p) => {
        const dp = _sub3(p, centroid);
        return [_dot3(dp, uDir), _dot3(dp, vDir)];
      };
      const loops2d = rawLoops.map(loop => loop.map(project2d));
      const signedAreas = loops2d.map(pts => {
        let a = 0;
        for (let i = 0; i < pts.length; i++) {
          const j = (i + 1) % pts.length;
          a += pts[i][0] * pts[j][1] - pts[j][0] * pts[i][1];
        }
        return a * 0.5;
      });
      const centroids2d = loops2d.map(pts => {
        let x = 0, y = 0;
        for (const p of pts) { x += p[0]; y += p[1]; }
        return [x / pts.length, y / pts.length];
      });

      // Nesting: each loop's parent = smallest *larger* containing loop.
      // Der `areaJ > areaI`-Test ist essenziell: bei einem zentrierten Loch (z.B.
      // block_with_hole) liegt der Schwerpunkt der äußeren Rechteck-Kontur GENAU im
      // kleinen Bohrungs-Ring. Ohne Größen-Check würde pointInPoly2d das Rechteck
      // fälschlich als "im Ring enthalten" einstufen → Außen/Innen vertauscht →
      // Ring wird als FACE_OUTER_BOUND emittiert (362 Kanten 3× genutzt → 732
      // non-manifold). Ein Container muss IMMER flächengrößer sein als sein Kind.
      const parent = new Array(rawLoops.length).fill(-1);
      for (let i = 0; i < rawLoops.length; i++) {
        let bestJ = -1, bestArea = Infinity;
        const areaI = Math.abs(signedAreas[i]);
        for (let j = 0; j < rawLoops.length; j++) {
          if (i === j) continue;
          const areaJ = Math.abs(signedAreas[j]);
          if (areaJ <= areaI) continue;                       // Eltern müssen größer sein
          if (pointInPoly2d(centroids2d[i], loops2d[j])) {
            if (areaJ < bestArea) { bestArea = areaJ; bestJ = j; }
          }
        }
        parent[i] = bestJ;
      }
      const depth = new Array(rawLoops.length).fill(0);
      for (let i = 0; i < rawLoops.length; i++) {
        let d = 0, p = parent[i];
        while (p !== -1 && d < 20) { d++; p = parent[p]; }
        depth[i] = d;
      }

      // WICHTIG für Wasserdichtigkeit: die ROHEN Loop-Vertices (= echte Mesh-Vertices) verwenden,
      // NICHT pro-Fläche projizieren oder vereinfachen. Sonst wandern gemeinsame Vertices
      // benachbarter Flächen unterschiedlich (projectOntoPlane: je eigene Ebene) bzw. eine Fläche
      // entfernt einen Punkt, den die Nachbarfläche behält (simplifyLoop → T-Junction) → Risse.
      // Mit Roh-Vertices teilen sich Nachbarflächen exakt dieselben Kanten → Edge-Registry dedupliziert
      // sie → jede Kante genau 2× → geschlossene Hülle. (Tradeoff: mehr Kanten, leicht facettiert.)
      for (let i = 0; i < rawLoops.length; i++) {
        if ((depth[i] % 2) !== 0) continue;
        if (Math.abs(signedAreas[i]) < MIN_FACE_AREA) continue;
        const outer = signedAreas[i] >= 0 ? rawLoops[i] : rawLoops[i].slice().reverse();
        const inner = [];
        for (let j = 0; j < rawLoops.length; j++) {
          if (parent[j] === i && Math.abs(signedAreas[j]) >= MIN_HOLE_AREA) {
            inner.push(signedAreas[j] <= 0 ? rawLoops[j] : rawLoops[j].slice().reverse());
          }
        }
        allFaces.push({ outer, inner, normal, centroid });
      }
    }
    return allFaces;
  };

  // ---- Step 1: Compute face polygons from all groups ----
  // ---- Analytische Voll-Bohrungen: erkannte Zylinder als EINE CYLINDRICAL_SURFACE + 2 Kreis-
  // Kanten statt Dutzender Facetten-Planes. Nahtlose Form (2 volle Kreis-Bounds) — empirisch
  // bestätigt, dass occt-import-js (Panel 4) sie parst. Drei Fallback-Ebenen schützen die
  // Wasserdicht-Baseline: (1) attemptBore→null pro Bohrung, (2) Rand-Match scheitert→facettiert,
  // (3) globaler Schutz unten (öffnet die Umwandlung die Hülle → komplett facettiert neu bauen).
  // Bohrungen tragen group.primitive; über die Worker-Grenze strukturell geklont → Objekt-Identität
  // gebrochen, daher Gruppierung über prim.id (stabile Ganzzahl), nie ===.
  const boreById = new Map();
  for (const group of normalGroups) {
    const p = group.primitive;
    if (p && p.type === 'cylinder' && p.kind === 'bore' && p.full === true && Number.isFinite(p.radius) && p.radius > 0) {
      let e = boreById.get(p.id);
      if (!e) { e = { prim: p, groups: [] }; boreById.set(p.id, e); }
      e.groups.push(group);
    }
  }

  // Rand-Geometrie aus der Vereinigung der Facetten extrahieren: Randkanten (genau 1× genutzt)
  // → geschlossene Loops. Durchgangsloch = genau 2 koaxiale Rand-Kreise; sonst Fallback (null).
  const attemptBore = (entry) => {
    const prim = entry.prim;
    const axis = _norm3(prim.axis), ap = prim.axisPoint, R = prim.radius;
    const ec = new Map();
    for (const g of entry.groups) {
      const vs = g.vertices, tc = Math.floor(vs.length / 3);
      for (let t = 0; t < tc; t++) {
        const tri = [vs[t * 3], vs[t * 3 + 1], vs[t * 3 + 2]];
        for (const [a, b] of [[tri[0], tri[1]], [tri[1], tri[2]], [tri[2], tri[0]]]) {
          const k = edgeKeyFn(a, b); const e = ec.get(k) || { c: 0, a, b }; e.c++; ec.set(k, e);
        }
      }
    }
    const bnd = []; for (const e of ec.values()) if (e.c === 1) bnd.push({ v0: e.a, v1: e.b });
    const loops = chainEdges(bnd);
    if (loops.length !== 2) return null; // v1: nur Durchgangslöcher
    const tol = Math.max(0.08, 0.06 * R);
    const refDir = computeRefDir(axis);
    const rims = [];
    for (const loop of loops) {
      let st = 0; for (const pt of loop) st += _dot3(_sub3(pt, ap), axis);
      const meanT = st / loop.length;
      const center = [ap[0] + axis[0] * meanT, ap[1] + axis[1] * meanT, ap[2] + axis[2] * meanT];
      for (const pt of loop) {
        const w = _sub3(pt, center), along = _dot3(w, axis);
        const perp = Math.hypot(w[0] - axis[0] * along, w[1] - axis[1] * along, w[2] - axis[2] * along);
        if (Math.abs(perp - R) > tol) return null;
      }
      const rimKey = `${fixZero(center[0], 3)},${fixZero(center[1], 3)},${fixZero(center[2], 3)}|${fixZero(R, 3)}`;
      rims.push({ center, axis, radius: R, refDir, rimKey, meanT });
    }
    rims.sort((a, b) => a.meanT - b.meanT); // [unten, oben]
    if (rims[0].rimKey === rims[1].rimKey) return null; // null-Höhe / kollabiert
    return { prim, rims, groups: entry.groups, surfCenter: rims[0].center };
  };

  // Innen-Loop einer Flachfläche rein GEOMETRISCH einem Rand zuordnen (simplifyLoop kann die
  // Polygon-Auflösung verändert haben → niemals über Vertex-Mengen vergleichen).
  const innerMatchesRim = (loop, normal, rim) => {
    if (Math.abs(_dot3(normal, rim.axis)) < 0.985) return false; // Wand ~⟂ zur Achse (≤10°)
    let cx = 0, cy = 0, cz = 0; for (const p of loop) { cx += p[0]; cy += p[1]; cz += p[2]; }
    const c = [cx / loop.length, cy / loop.length, cz / loop.length];
    if (Math.hypot(c[0] - rim.center[0], c[1] - rim.center[1], c[2] - rim.center[2]) > Math.max(0.15, 0.6 * rim.radius)) return false;
    const radTol = Math.max(0.1, 0.06 * rim.radius);
    for (const p of loop) {
      const w = _sub3(p, rim.center), along = _dot3(w, rim.axis);
      const perp = Math.hypot(w[0] - rim.axis[0] * along, w[1] - rim.axis[1] * along, w[2] - rim.axis[2] * along);
      if (Math.abs(perp - rim.radius) > radTol) return false;
    }
    return true;
  };

  // Tentative Pläne berechnen; erfolgreiche Bohrungs-Gruppen vorerst überspringen.
  const tentative = [];
  const skipGroups = new Set();
  for (const entry of boreById.values()) {
    let plan = null;
    try { plan = attemptBore(entry); } catch (_) { plan = null; }
    if (plan) { tentative.push(plan); for (const g of plan.groups) skipGroups.add(g); }
  }

  // faceDefs der Nicht-Bohrungs-Gruppen.
  const buildFaceDefs = (skip) => {
    const fds = [];
    for (const group of normalGroups) { if (skip && skip.has(group)) continue; fds.push(...extractGroupFaces(group)); }
    return fds;
  };
  const faceDefs = buildFaceDefs(skipGroups);

  // Rand-Matching: jeder Rand eines Plans muss GENAU einen freien Innen-Loop treffen; sonst
  // Plan verwerfen und die Bohrungs-Gruppen doch facettiert nachreichen.
  const finalPlans = [];
  for (const plan of tentative) {
    const matched = []; let okAll = true;
    for (const rim of plan.rims) {
      let hit = null;
      for (const fd of faceDefs) {
        for (const inner of fd.inner) {
          if (inner.circleRim) continue;
          if (innerMatchesRim(inner, fd.normal, rim)) { hit = inner; break; }
        }
        if (hit) break;
      }
      if (!hit) { okAll = false; break; }
      matched.push({ inner: hit, rim });
    }
    if (okAll) { for (const m of matched) m.inner.circleRim = m.rim; finalPlans.push(plan); }
    else { for (const g of plan.groups) faceDefs.push(...extractGroupFaces(g)); }
  }

  // ---- Step 2: Shared vertex + edge registry ----
  const ptRegistry = new Map(); // key → { ptId, vtxId }
  // Gleiche Naht-Normalisierung wie vtxKey (siehe oben): -0.0/+0.0 vereinheitlichen,
  // damit Naht-Vertices in der STEP-Topologie denselben CARTESIAN_POINT teilen.
  const ptKey = (p) => p.map((v) => fixZero(v, 4)).join(',');

  const getVertex = (pt) => {
    const key = ptKey(pt);
    if (!ptRegistry.has(key)) {
      const ptId = addPoint(pt);
      const vtxId = addVertex(ptId);
      ptRegistry.set(key, { ptId, vtxId });
    }
    return ptRegistry.get(key);
  };

  // Canonical edge key: smaller ptKey first → direction-independent dedup
  const edgeCanonKey = (p1, p2) => {
    const k1 = ptKey(p1), k2 = ptKey(p2);
    return k1 < k2 ? `${k1}||${k2}` : `${k2}||${k1}`;
  };
  const edgeRegistry = new Map(); // canonKey → { ecId, canonStartKey }
  // Wie wird jede kanonische Kante von ORIENTED_EDGEs benutzt — getrennt nach Richtung
  // (.T. = forward, .F. = reverse)? Eine saubere geschlossene Manifold-Kante wird GENAU
  // einmal vorwärts UND einmal rückwärts benutzt (fwd=1, rev=1). Abweichungen:
  //   fwd+rev == 1         → offene Randkante (Riss/Loch)
  //   fwd+rev  > 2         → non-manifold (Kante von >2 Flächen geteilt)
  //   fwd+rev == 2, fwd≠1  → Orientierungsfehler ({2,0}/{0,2}: zwei gleichgerichtete Nutzungen)
  // Das ist die geometrische Definition von „wasserdicht" und speist das Panel-4-Verdikt.
  // (Reine Multiplizität reicht NICHT: zwei gleichgerichtete Nutzungen würden sonst eine
  //  fehlorientierte/offene Hülle fälschlich als geschlossen melden.)
  const edgeUse = new Map(); // canonKey → { fwd, rev }

  const getOrCreateEdge = (p1, p2) => {
    const key = edgeCanonKey(p1, p2);
    if (!edgeRegistry.has(key)) {
      const { vtxId: sv } = getVertex(p1);
      const { ptId: startPtId } = ptRegistry.get(ptKey(p1));
      const { vtxId: ev } = getVertex(p2);
      const dir = [p2[0] - p1[0], p2[1] - p1[1], p2[2] - p1[2]];
      const len = Math.hypot(dir[0], dir[1], dir[2]) || 1;
      const dirId = addDirection(dir);
      const vecId = addVector(dirId, len);
      const lineId = addLine(startPtId, vecId);
      const ecId = addEdgeCurve(sv, ev, lineId);
      const k1 = ptKey(p1), k2 = ptKey(p2);
      edgeRegistry.set(key, { ecId, canonStartKey: k1 < k2 ? k1 : k2 });
    }
    return edgeRegistry.get(key);
  };

  // ---- Analytische Kreis-Kanten (Bohrungs-Ränder) ----
  // Volle Kreis-Kanten (EDGE_CURVE mit start==end-Vertex) dürfen NICHT durch getOrCreateEdge/
  // buildLoopEdges laufen (die überspringen p1==p2 als entartet und bauten sonst eine degenerierte
  // LINE). Daher eigene Registry, gekeyt über den Rand (Zentrum+Radius+Achse), NICHT über Endpunkte
  // (bei einem vollen Kreis identisch). Eigener Use-Zähler speist dasselbe Wasserdicht-Verdikt.
  const circleRegistry = new Map(); // rimKey → { ecId }
  const circleUse = new Map();      // rimKey → { fwd, rev }
  const getOrCreateCircleEdge = (rimKey, geom) => {
    if (!circleRegistry.has(rimKey)) {
      const placId = addAxis2Placement3D(geom.center, geom.axis, geom.refDir);
      const circleId = addCircle(placId, geom.radius);
      const v = getVertex([
        geom.center[0] + geom.radius * geom.refDir[0],
        geom.center[1] + geom.radius * geom.refDir[1],
        geom.center[2] + geom.radius * geom.refDir[2],
      ]);
      const ecId = addEdgeCurve(v.vtxId, v.vtxId, circleId);
      circleRegistry.set(rimKey, { ecId });
    }
    return circleRegistry.get(rimKey);
  };
  const useCircle = (rimKey, forward) => {
    const u = circleUse.get(rimKey) || { fwd: 0, rev: 0 };
    if (forward) u.fwd++; else u.rev++;
    circleUse.set(rimKey, u);
  };

  // ---- Step 3: Build ADVANCED_FACEs ----
  const buildLoopEdges = (points) => {
    const oeIds = [];
    const n = points.length;
    for (let i = 0; i < n; i++) {
      const p1 = points[i], p2 = points[(i + 1) % n];
      if (ptKey(p1) === ptKey(p2)) continue; // skip degenerate
      const edge = getOrCreateEdge(p1, p2);
      const ck = edgeCanonKey(p1, p2);
      const forward = ptKey(p1) === edge.canonStartKey;
      const u = edgeUse.get(ck) || { fwd: 0, rev: 0 };
      if (forward) u.fwd++; else u.rev++;
      edgeUse.set(ck, u);
      oeIds.push(addOrientedEdge(edge.ecId, forward));
    }
    return oeIds;
  };

  // ---- Step 3: Flächen emittieren — re-entrant, damit der globale Fallback alles facettiert
  // neu bauen kann. Setzt id/entities/Registries zurück und baut von vorn. (Vor dem ersten
  // Aufruf wurde noch nichts emittiert → entMark/idMark sind der Ausgangszustand.)
  const entMark = entities.length, idMark = id;
  const assemble = (faceDefsArg, plans) => {
    entities.length = entMark; id = idMark;
    ptRegistry.clear(); edgeRegistry.clear(); edgeUse.clear();
    circleRegistry.clear(); circleUse.clear();
    const faceIds = [];

    // Flachflächen (Innen-Loops mit `circleRim`-Tag werden als EINE Kreis-Kante emittiert).
    for (const { outer, inner, normal, centroid } of faceDefsArg) {
      const outerOe = buildLoopEdges(outer);
      if (outerOe.length < 3) continue;
      const bounds = [addFaceOuterBound(addEdgeLoop(outerOe))];
      for (const innerLoop of inner) {
        if (innerLoop.circleRim) {
          const rim = innerLoop.circleRim;
          const ce = getOrCreateCircleEdge(rim.rimKey, rim);
          useCircle(rim.rimKey, true); // Flachfläche nutzt den Kreis .T. (Gegenrichtung zum Mantel)
          bounds.push(addFaceBound(addEdgeLoop([addOrientedEdge(ce.ecId, true)])));
          continue;
        }
        const innerOe = buildLoopEdges(innerLoop);
        if (innerOe.length < 3) continue;
        bounds.push(addFaceBound(addEdgeLoop(innerOe)));
      }
      const placId = addAxis2Placement3D(centroid, normal, computeRefDir(normal));
      faceIds.push(addAdvancedFace(bounds, addPlane(placId), true));
    }

    // Zylinder-Mantelflächen (nahtlos: 1 CYLINDRICAL_SURFACE, 2 volle Kreis-Bounds).
    for (const plan of plans) {
      const r0 = plan.rims[0];
      const cylPlac = addAxis2Placement3D(plan.surfCenter, r0.axis, r0.refDir);
      const cylSurf = addCylindricalSurface(cylPlac, r0.radius);
      const bounds = [];
      for (let r = 0; r < plan.rims.length; r++) {
        const rim = plan.rims[r];
        const ce = getOrCreateCircleEdge(rim.rimKey, rim);
        useCircle(rim.rimKey, false); // Mantel nutzt den Kreis .F.
        const loopId = addEdgeLoop([addOrientedEdge(ce.ecId, false)]);
        bounds.push(r === 0 ? addFaceOuterBound(loopId) : addFaceBound(loopId));
      }
      faceIds.push(addAdvancedFace(bounds, cylSurf, true));
    }

    // Wasserdicht-Verdikt: Linien-Kanten (edgeUse) UND Kreis-Kanten (circleUse) nach denselben
    // Regeln zählen (1× = Randkante, >2 = non-manifold, 2 aber nicht 1fwd/1rev = Orientierungsfehler).
    let bE = 0, nmE = 0, oD = 0;
    const tally = (fwd, rev) => {
      const total = fwd + rev;
      if (total === 1) bE++;
      else if (total > 2) nmE++;
      else if (total === 2 && (fwd !== 1 || rev !== 1)) oD++;
    };
    for (const u of edgeUse.values()) tally(u.fwd, u.rev);
    for (const u of circleUse.values()) tally(u.fwd, u.rev);
    return {
      faceIds,
      report: {
        faceCount: faceIds.length,
        edgeCount: edgeUse.size + circleUse.size,
        boundaryEdges: bE, nonManifoldEdges: nmE, orientationDefects: oD,
        watertight: bE === 0 && nmE === 0 && oD === 0,
        boresConverted: plans.length,
      },
    };
  };

  let asm = assemble(faceDefs, finalPlans);
  // Globaler Schutz: öffnet die analytische Umwandlung die Hülle, wird ALLES facettiert neu gebaut
  // → die wasserdichte Baseline kann durch den Zylinder-Export nie regressieren.
  if (asm.report.boresConverted > 0 && !asm.report.watertight) {
    asm = assemble(buildFaceDefs(null), []);
  }
  const allFaceIds = asm.faceIds;
  const report = asm.report;
  if (allFaceIds.length < 2) return null;

  // ---- Step 4: Units + context ----
  const lenUnitId = id++;
  entities.push(`#${lenUnitId}=LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.);`);
  const ctxId = id++;
  entities.push(`#${ctxId}=GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNIT_ASSIGNED_CONTEXT((#${lenUnitId}))REPRESENTATION_CONTEXT('','');`);

  // ---- Step 5: Wasserdicht → echter Volumenkörper (CLOSED_SHELL + MANIFOLD_SOLID_BREP),
  // sonst offenes Flächenmodell (OPEN_SHELL) als Fallback, das das CAD selbst zu nähen versuchen kann.
  const faceRefs = allFaceIds.map(f => `#${f}`).join(',');
  let shapeRepId;
  if (report.watertight) {
    const shellId = id++;
    entities.push(`#${shellId}=CLOSED_SHELL('',(${faceRefs}));`);
    const solidId = id++;
    entities.push(`#${solidId}=MANIFOLD_SOLID_BREP('V2 Solid',#${shellId});`);
    shapeRepId = id++;
    entities.push(`#${shapeRepId}=ADVANCED_BREP_SHAPE_REPRESENTATION('V2 Volume',(#${solidId}),#${ctxId});`);
  } else {
    const shellId = id++;
    entities.push(`#${shellId}=OPEN_SHELL('',(${faceRefs}));`);
    const surfaceModelId = id++;
    entities.push(`#${surfaceModelId}=SHELL_BASED_SURFACE_MODEL('V2 Reconstruction',(#${shellId}));`);
    shapeRepId = id++;
    entities.push(`#${shapeRepId}=MANIFOLD_SURFACE_SHAPE_REPRESENTATION('V2 Volume',(#${surfaceModelId}),#${ctxId});`);
  }

  const appCtxId = id++;
  entities.push(`#${appCtxId}=APPLICATION_CONTEXT('automotive');`);
  const appProtId = id++;
  entities.push(`#${appProtId}=APPLICATION_PROTOCOL_DEFINITION('','automotive_design',2009,#${appCtxId});`);
  const prodCtxId = id++;
  entities.push(`#${prodCtxId}=PRODUCT_CONTEXT('design','',#${appCtxId});`);
  const prodId = id++;
  entities.push(`#${prodId}=PRODUCT('V2 B-Rep','V2 Reconstruction','',(#${prodCtxId}));`);
  const formId = id++;
  entities.push(`#${formId}=PRODUCT_DEFINITION_FORMATION_WITH_SPECIFIED_SOURCE('','',#${prodId},.NOT_KNOWN.);`);
  const prodDefId = id++;
  entities.push(`#${prodDefId}=PRODUCT_DEFINITION('','',#${formId},#${prodCtxId});`);
  const prodDefShapeId = id++;
  entities.push(`#${prodDefShapeId}=PRODUCT_DEFINITION_SHAPE('','',#${prodDefId});`);
  const shapeDefRepId = id++;
  entities.push(`#${shapeDefRepId}=SHAPE_DEFINITION_REPRESENTATION(#${prodDefShapeId},#${shapeRepId});`);

  const timestamp = new Date().toISOString();
  const step = [
    'ISO-10303-21;',
    'HEADER;',
    "FILE_DESCRIPTION(('STLReverse V2 Topology B-Rep'),'2;1');",
    `FILE_NAME('stlReverse-v2-brep.step','${timestamp}',('STLReverse'),('STLReverse'),'STLReverse','STLReverse','');`,
    "FILE_SCHEMA(('AUTOMOTIVE_DESIGN'));",
    'ENDSEC;',
    'DATA;',
    ...entities,
    'ENDSEC;',
    'END-ISO-10303-21;'
  ].join('\n');
  // Rückgabe als Objekt { step, report } — der Befund speist das Panel-4-Verdikt.
  // (Frühe Abbrüche oben geben weiterhin null zurück → Aufrufer prüfen auf falsy.)
  return { step, report };
}

// ─────────────────────────────────────────────────────────────────────────────
// Exporter: jedes STL-Dreieck als eigene ADVANCED_FACE (flach, gerade Kanten).
// Alle rohen Vertices (cyan Punkte in Panel 3) landen als VERTEX_POINT im STEP.
// Shell ist wasserdicht → CLOSED_SHELL + MANIFOLD_SOLID_BREP → Volumenkörper.
// Tradeoff: 1 Face pro Dreieck → ~11k Faces für bike light, große Dateien.
// ─────────────────────────────────────────────────────────────────────────────
export function buildVolumeStepTriangles(analysis) {
  const normalGroups = analysis?.normalGroups;
  if (!normalGroups?.length) return null;

  const entities = [];
  let id = 1;

  const toStep = (v) => {
    if (!Number.isFinite(v)) return '0.';
    const t = Number(v).toFixed(6).replace(/(\.\d*?)0+$/, '$1');
    return t.includes('.') ? t : t + '.';
  };

  const addPoint = (pt) => { const pid = id++; entities.push(`#${pid}=CARTESIAN_POINT('',(${pt.map(toStep).join(',')}));`); return pid; };
  const addDirection = (vec) => {
    const len = Math.hypot(vec[0], vec[1], vec[2]) || 1;
    const d = vec.map(v => v / len || 0);
    const did = id++; entities.push(`#${did}=DIRECTION('',(${d.map(toStep).join(',')}));`); return did;
  };
  const addVector = (dirId, mag) => { const vid = id++; entities.push(`#${vid}=VECTOR('',#${dirId},${toStep(mag)});`); return vid; };
  const addVertex = (ptId) => { const vid = id++; entities.push(`#${vid}=VERTEX_POINT('',#${ptId});`); return vid; };
  const addLine = (ptId, vecId) => { const lid = id++; entities.push(`#${lid}=LINE('',#${ptId},#${vecId});`); return lid; };
  const addEdgeCurve = (sv, ev, curveId) => { const eid = id++; entities.push(`#${eid}=EDGE_CURVE('',#${sv},#${ev},#${curveId},.T.);`); return eid; };
  const addOrientedEdge = (ecId, forward) => { const oid = id++; entities.push(`#${oid}=ORIENTED_EDGE('',*,*,#${ecId},.${forward ? 'T' : 'F'}.);`); return oid; };
  const addEdgeLoop = (oeIds) => { const lid = id++; entities.push(`#${lid}=EDGE_LOOP('',(${oeIds.map(e => `#${e}`).join(',')}));`); return lid; };
  const addFaceOuterBound = (loopId) => { const bid = id++; entities.push(`#${bid}=FACE_OUTER_BOUND('',#${loopId},.T.);`); return bid; };
  const addAxis2Placement3D = (loc, axis, refDir) => {
    const locId = addPoint(loc);
    const axId = addDirection(axis);
    const refId = addDirection(refDir);
    const pid = id++; entities.push(`#${pid}=AXIS2_PLACEMENT_3D('',#${locId},#${axId},#${refId});`); return pid;
  };
  const addPlane = (placId) => { const pid = id++; entities.push(`#${pid}=PLANE('',#${placId});`); return pid; };
  const addAdvancedFace = (boundIds, surfId, sameSense) => {
    const fid = id++;
    entities.push(`#${fid}=ADVANCED_FACE('',(${boundIds.map(b => `#${b}`).join(',')}),#${surfId},.${sameSense ? 'T' : 'F'}.);`);
    return fid;
  };

  const cross3 = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
  const norm3 = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0]/l, v[1]/l, v[2]/l]; };
  const refDirOf = (normal) => {
    const ax = Math.abs(normal[0]), ay = Math.abs(normal[1]), az = Math.abs(normal[2]);
    const ref = ax <= ay && ax <= az ? [1,0,0] : ay <= ax && ay <= az ? [0,1,0] : [0,0,1];
    return norm3(cross3(normal, ref));
  };

  // Registry für geteilte Vertices / Edges
  const ptKey = (p) => p.map(v => Number(v).toFixed(4)).join(',');
  const ptRegistry = new Map();
  const getVertex = (pt) => {
    const key = ptKey(pt);
    if (!ptRegistry.has(key)) {
      const ptId = addPoint(pt);
      const vtxId = addVertex(ptId);
      ptRegistry.set(key, { ptId, vtxId });
    }
    return ptRegistry.get(key);
  };
  const edgeCanonKey = (p1, p2) => { const k1 = ptKey(p1), k2 = ptKey(p2); return k1 < k2 ? `${k1}||${k2}` : `${k2}||${k1}`; };
  const edgeRegistry = new Map();
  const getOrCreateEdge = (p1, p2) => {
    const key = edgeCanonKey(p1, p2);
    if (!edgeRegistry.has(key)) {
      const { vtxId: sv } = getVertex(p1);
      const { ptId: startPtId } = ptRegistry.get(ptKey(p1));
      const { vtxId: ev } = getVertex(p2);
      const dir = [p2[0]-p1[0], p2[1]-p1[1], p2[2]-p1[2]];
      const len = Math.hypot(dir[0], dir[1], dir[2]) || 1;
      const dirId = addDirection(dir);
      const vecId = addVector(dirId, len);
      const lineId = addLine(startPtId, vecId);
      const ecId = addEdgeCurve(sv, ev, lineId);
      const k1 = ptKey(p1), k2 = ptKey(p2);
      edgeRegistry.set(key, { ecId, canonStartKey: k1 < k2 ? k1 : k2 });
    }
    return edgeRegistry.get(key);
  };

  // Eine Face pro Dreieck
  const allFaceIds = [];
  for (const group of normalGroups) {
    const verts = group.vertices;
    for (let i = 0; i + 2 < verts.length; i += 3) {
      const v0 = verts[i], v1 = verts[i+1], v2 = verts[i+2];
      if (ptKey(v0) === ptKey(v1) || ptKey(v1) === ptKey(v2) || ptKey(v0) === ptKey(v2)) continue;

      const e1 = [v1[0]-v0[0], v1[1]-v0[1], v1[2]-v0[2]];
      const e2 = [v2[0]-v0[0], v2[1]-v0[1], v2[2]-v0[2]];
      const nRaw = cross3(e1, e2);
      const nLen = Math.hypot(nRaw[0], nRaw[1], nRaw[2]);
      if (nLen < 1e-9) continue;
      const normal = [nRaw[0]/nLen, nRaw[1]/nLen, nRaw[2]/nLen];

      const oeIds = [];
      const pts = [v0, v1, v2];
      for (let k = 0; k < 3; k++) {
        const p1 = pts[k], p2 = pts[(k+1)%3];
        const edge = getOrCreateEdge(p1, p2);
        const forward = ptKey(p1) === edge.canonStartKey;
        oeIds.push(addOrientedEdge(edge.ecId, forward));
      }
      const loopId = addEdgeLoop(oeIds);
      const boundId = addFaceOuterBound(loopId);
      const centroid = [(v0[0]+v1[0]+v2[0])/3, (v0[1]+v1[1]+v2[1])/3, (v0[2]+v1[2]+v2[2])/3];
      const placId = addAxis2Placement3D(centroid, normal, refDirOf(normal));
      const planeId = addPlane(placId);
      allFaceIds.push(addAdvancedFace([boundId], planeId, true));
    }
  }
  if (allFaceIds.length < 4) return null;

  // Shell ist wasserdicht → CLOSED_SHELL + MANIFOLD_SOLID_BREP
  const shellId = id++;
  entities.push(`#${shellId}=CLOSED_SHELL('',(${allFaceIds.map(f => `#${f}`).join(',')}));`);
  const solidId = id++;
  entities.push(`#${solidId}=MANIFOLD_SOLID_BREP('Triangle Mesh Solid',#${shellId});`);

  const lenUnitId = id++;
  entities.push(`#${lenUnitId}=LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.);`);
  const ctxId = id++;
  entities.push(`#${ctxId}=GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNIT_ASSIGNED_CONTEXT((#${lenUnitId}))REPRESENTATION_CONTEXT('','');`);
  const shapeRepId = id++;
  entities.push(`#${shapeRepId}=ADVANCED_BREP_SHAPE_REPRESENTATION('Triangle Volume',(#${solidId}),#${ctxId});`);

  const appCtxId = id++; entities.push(`#${appCtxId}=APPLICATION_CONTEXT('automotive');`);
  const appProtId = id++; entities.push(`#${appProtId}=APPLICATION_PROTOCOL_DEFINITION('','automotive_design',2009,#${appCtxId});`);
  const prodCtxId = id++; entities.push(`#${prodCtxId}=PRODUCT_CONTEXT('design','',#${appCtxId});`);
  const prodId = id++; entities.push(`#${prodId}=PRODUCT('Triangle B-Rep','Triangle Solid','',(#${prodCtxId}));`);
  const formId = id++; entities.push(`#${formId}=PRODUCT_DEFINITION_FORMATION_WITH_SPECIFIED_SOURCE('','',#${prodId},.NOT_KNOWN.);`);
  const prodDefId = id++; entities.push(`#${prodDefId}=PRODUCT_DEFINITION('','',#${formId},#${prodCtxId});`);
  const prodDefShapeId = id++; entities.push(`#${prodDefShapeId}=PRODUCT_DEFINITION_SHAPE('','',#${prodDefId});`);
  const shapeDefRepId = id++; entities.push(`#${shapeDefRepId}=SHAPE_DEFINITION_REPRESENTATION(#${prodDefShapeId},#${shapeRepId});`);

  const timestamp = new Date().toISOString();
  return [
    'ISO-10303-21;',
    'HEADER;',
    "FILE_DESCRIPTION(('STLReverse Triangle B-Rep'),'2;1');",
    `FILE_NAME('stlReverse-triangles.step','${timestamp}',('STLReverse'),('STLReverse'),'STLReverse','STLReverse','');`,
    "FILE_SCHEMA(('AUTOMOTIVE_DESIGN'));",
    'ENDSEC;',
    'DATA;',
    ...entities,
    'ENDSEC;',
    'END-ISO-10303-21;'
  ].join('\n');
}

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
  // Defeaturing-Toggle (default AN): Verrundungen werden beim Export entfernt — Mündungs-
  // Verrundungen → Kegel-Fase (Chamfer-Pfad), Gerade-Kanten-Verrundungen → scharfe Kante.
  // OFF = Verrundungen bleiben (facettiert); nur exakte Direkt-Treffer konvertieren weiter.
  const DEFEATURE = analysis?.defeature !== false;

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
  const addConicalSurface = (placId, radius, semiAngle) => {
    const sid = id++;
    entities.push(`#${sid}=CONICAL_SURFACE('',#${placId},${toStep(radius)},${toStep(semiAngle)});`);
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
    // Degenerierte Gruppen (Null-Normale = ausschließlich kollineare/flächenlose Dreiecke,
    // z.B. aus kaputten Tessellierern) überspringen — sie können keine Fläche bilden und
    // würden sonst eine Müll-Fläche mit offenen Kanten emittieren.
    if (Math.hypot(normal[0], normal[1], normal[2]) < 0.5) return [];

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
    // Axial-Ebenen-Gate: der Loop MUSS in der Ebene DIESES Randes liegen (an seinem eigenen Ende).
    // Der Radialtest unten ist achsen-blind (projiziert den Achsanteil weg) — ohne dieses Gate würde
    // ein koaxialer Ring am ANDEREN Loch-Ende fälschlich matchen (geometrisch falsche Fläche, aber
    // topologisch wasserdicht → vom Verdikt NICHT gefangen). Trennt auch dünne Platten korrekt auf.
    if (Math.abs(_dot3(_sub3(c, rim.center), rim.axis)) > Math.max(0.05, 0.1 * rim.radius)) return false;
    const radTol = Math.max(0.1, 0.06 * rim.radius);
    for (const p of loop) {
      const w = _sub3(p, rim.center), along = _dot3(w, rim.axis);
      const perp = Math.hypot(w[0] - rim.axis[0] * along, w[1] - rim.axis[1] * along, w[2] - rim.axis[2] * along);
      if (Math.abs(perp - rim.radius) > radTol) return false;
    }
    return true;
  };

  // Tentative Pläne (Zylinder-Ränder). Erfolgreiche Bohrungs-Gruppen vorerst überspringen.
  const tentative = [];
  const boreSkip = new Set();
  for (const entry of boreById.values()) {
    let plan = null;
    try { plan = attemptBore(entry); } catch (_) { plan = null; }
    if (plan) { tentative.push(plan); for (const g of plan.groups) boreSkip.add(g); }
  }

  // faceDefs der Nicht-Bohrungs-Gruppen (mit Gruppen-Ref für Fillet-Filterung).
  const buildFaceDefs = (skip) => {
    const fds = [];
    for (const group of normalGroups) {
      if (skip && skip.has(group)) continue;
      for (const fd of extractGroupFaces(group)) { fd.group = group; fds.push(fd); }
    }
    return fds;
  };
  let faceDefs = buildFaceDefs(boreSkip);

  // Kreis-Deskriptor (Zentrum auf Achse, Radius, Achse, refDir, rimKey) — teilbar via circleRegistry.
  const mkCircleDesc = (center, radius, axis) => ({
    center, radius, axis, refDir: computeRefDir(axis),
    rimKey: `${fixZero(center[0], 3)},${fixZero(center[1], 3)},${fixZero(center[2], 3)}|${fixZero(radius, 3)}`,
  });
  // Ist `loop` ein koaxialer Kreis um die Bohrachse? → { center(auf Achse), radius, meanT } | null
  const loopAsCircle = (loop, normal, axis, ap) => {
    if (Math.abs(_dot3(normal, axis)) < 0.985) return null; // Wand ~⟂ zur Achse
    let cx = 0, cy = 0, cz = 0; for (const p of loop) { cx += p[0]; cy += p[1]; cz += p[2]; }
    const c0 = [cx / loop.length, cy / loop.length, cz / loop.length];
    let sr = 0; for (const p of loop) { const w = _sub3(p, c0), al = _dot3(w, axis); sr += Math.hypot(w[0] - axis[0] * al, w[1] - axis[1] * al, w[2] - axis[2] * al); }
    const radius = sr / loop.length;
    if (!(radius > 0)) return null;
    const radTol = Math.max(0.1, 0.06 * radius);
    for (const p of loop) { const w = _sub3(p, c0), al = _dot3(w, axis); const perp = Math.hypot(w[0] - axis[0] * al, w[1] - axis[1] * al, w[2] - axis[2] * al); if (Math.abs(perp - radius) > radTol) return null; }
    const meanT = _dot3(_sub3(c0, ap), axis);
    const center = [ap[0] + axis[0] * meanT, ap[1] + axis[1] * meanT, ap[2] + axis[2] * meanT];
    return { center, radius, meanT };
  };

  // Rand-Matching: DIREKT (Rand an flacher Fläche, Kreis = Rand) ODER CHAMFER (Rand an Verrundung/
  // Fase → flache Fläche etwas weiter außen; dazwischen wird ein KEGEL emittiert und die Fillet-
  // Facetten entfallen — User-Wunsch: gekrümmte Verrundung durch gerade Fase ersetzen). Jeder Rand
  // muss gelöst werden, sonst Plan verwerfen (facettiert).
  const CHAMFER_MAX = 3.0, CHAMFER_MIN = 0.04;
  const finalPlans = [];
  const chamferZones = [];
  for (const plan of tentative) {
    const matched = []; const claimed = new Set(); let okAll = true;
    for (const rim of plan.rims) {
      // (1) direkter Treffer
      let hit = null;
      for (const fd of faceDefs) { for (const inner of fd.inner) { if (inner.circleRim || claimed.has(inner)) continue; if (innerMatchesRim(inner, fd.normal, rim)) { hit = inner; break; } } if (hit) break; }
      if (hit) { claimed.add(hit); matched.push({ rim, inner: hit, mode: 'direct' }); continue; }
      // (2) Chamfer: koaxialer Kreis R2>R, axial nahe (|dz| ≤ CHAMFER_MAX) — nur mit Defeaturing-Toggle
      let cham = null;
      if (!DEFEATURE) { okAll = false; break; }
      for (const fd of faceDefs) {
        for (const inner of fd.inner) {
          if (inner.circleRim || claimed.has(inner)) continue;
          const circ = loopAsCircle(inner, fd.normal, rim.axis, rim.center);
          if (!circ) continue;
          if (circ.radius <= rim.radius + 0.02 || circ.radius > rim.radius + CHAMFER_MAX) continue;
          // loopAsCircle misst meanT bereits RELATIV zum übergebenen rim.center — dz ist also
          // direkt der Achsabstand des Flach-Kreises zur Rand-Ebene. (rim.meanT ist im Frame
          // des Bohrungs-axisPoint gemessen — NICHT subtrahieren: Referenzrahmen-Mix, der den
          // Chamfer-Pfad überall verhinderte.)
          const dz = circ.meanT;
          if (Math.abs(dz) < CHAMFER_MIN || Math.abs(dz) > CHAMFER_MAX) continue;
          cham = { inner, circ, dz }; break;
        }
        if (cham) break;
      }
      if (cham) { claimed.add(cham.inner); matched.push({ rim, inner: cham.inner, mode: 'chamfer', circ: cham.circ, dz: cham.dz }); continue; }
      okAll = false; break;
    }
    if (!okAll) { for (const g of plan.groups) for (const fd of extractGroupFaces(g)) { fd.group = g; faceDefs.push(fd); } continue; }
    plan.coneRims = [];
    for (const m of matched) {
      if (m.mode === 'direct') { m.inner.circleRim = m.rim; continue; }
      const flatDesc = mkCircleDesc(m.circ.center, m.circ.radius, m.rim.axis);
      m.inner.circleRim = flatDesc;                                   // flache Fläche nutzt äußeren Kreis R2@z2
      const coneAxis = m.dz >= 0 ? m.rim.axis : [-m.rim.axis[0], -m.rim.axis[1], -m.rim.axis[2]];
      const semiAngle = Math.atan2(Math.abs(m.circ.radius - m.rim.radius), Math.abs(m.dz));
      plan.coneRims.push({ rimDesc: m.rim, flatDesc, coneAxis, semiAngle });
      chamferZones.push({ axis: m.rim.axis, ap: m.rim.center, R: m.rim.radius, R2: m.circ.radius, zLo: Math.min(0, m.dz), zHi: Math.max(0, m.dz) });
    }
    finalPlans.push(plan);
  }

  // Fillet-Facetten entfernen: faceDefs, deren Loops KOMPLETT in einer Chamfer-Zone liegen (zwischen
  // Rand-Kreis R@z1 und Flach-Kreis R2@z2), entfallen — ihre Geometrie übernimmt der Kegel.
  if (chamferZones.length) {
    const inZone = (v) => {
      for (const z of chamferZones) {
        const w = _sub3(v, z.ap), al = _dot3(w, z.axis);
        const rho = Math.hypot(w[0] - z.axis[0] * al, w[1] - z.axis[1] * al, w[2] - z.axis[2] * al);
        if (rho >= z.R - 0.15 && rho <= z.R2 + 0.15 && al >= z.zLo - 0.15 && al <= z.zHi + 0.15) return true;
      }
      return false;
    };
    faceDefs = faceDefs.filter(fd => {
      if (fd.inner.some(l => l.circleRim)) return true;               // gematchte Flachfläche behalten
      const allV = [...fd.outer, ...fd.inner.flat()];
      return !allV.every(inZone);
    });
  }

  // ---- Body-Defeaturing: Gerade-Kanten-Verrundungen → scharfe Kante ----
  // Erkannte Teil-Zylinder-Fillets (kind='fillet') zwischen genau ZWEI Ebenen werden entfernt:
  // die Fillet-Facetten entfallen, die Rand-Vertices beider Nachbar-Ebenen wandern auf deren
  // SCHNITTLINIE (= die scharfe Kante, die der Konstrukteur verrundet hat), End-Kappen-Bögen
  // kollabieren auf den Eckpunkt. Vertex-Vereinheitlichung entlang der Linie (Union beider
  // Seiten, snap-merge) verhindert T-Junctions. Konservative Guards überall — jede Unsauberkeit
  // landet im Wasserdicht-Verdikt und der globale Fallback baut komplett facettiert neu.
  let filletsDefeatured = 0;
  {
    const defeaturedGroups = new Set();
    const filletById = new Map();
    if (DEFEATURE) {
      for (const group of normalGroups) {
        const p = group.primitive;
        if (p && p.type === 'cylinder' && p.kind === 'fillet' && p.full === false && Number.isFinite(p.radius) && p.radius > 0) {
          let e = filletById.get(p.id);
          if (!e) { e = { prim: p, groups: [] }; filletById.set(p.id, e); }
          e.groups.push(group);
        }
      }
    }
    if (filletById.size) {
      // 3x3-Löser (Cramer) für den Schnittlinien-Stützpunkt
      const solve3 = (r1, b1, r2, b2, r3, b3) => {
        const det = (m) =>
          m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
          m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
          m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
        const M = [r1, r2, r3];
        const D = det(M);
        if (Math.abs(D) < 1e-9) return null;
        const col = (M2, ci, b) => M2.map((row, ri) => row.map((x, cj) => (cj === ci ? b[ri] : x)));
        const b = [b1, b2, b3];
        return [det(col(M, 0, b)) / D, det(col(M, 1, b)) / D, det(col(M, 2, b)) / D];
      };
      // Kanten-Schlüssel → Gruppen (einmalig über alle Gruppen, für Nachbarschaft)
      const edgeToGroups = new Map();
      for (const group of normalGroups) {
        const vs = group.vertices, tc = Math.floor(vs.length / 3);
        for (let t = 0; t < tc; t++) {
          const tri = [vs[t * 3], vs[t * 3 + 1], vs[t * 3 + 2]];
          for (const [a, b] of [[tri[0], tri[1]], [tri[1], tri[2]], [tri[2], tri[0]]]) {
            const k = edgeKeyFn(a, b);
            let s = edgeToGroups.get(k); if (!s) { s = new Set(); edgeToGroups.set(k, s); }
            s.add(group);
          }
        }
      }
      const defeatureOne = (entry) => {
        const prim = entry.prim;
        const fAxis = _norm3(prim.axis), fAp = prim.axisPoint, rf = prim.radius;
        const own = new Set(entry.groups);
        // Rand-Kanten des Streifens → Nachbar-Gruppen (Gewicht = geteilte Kanten)
        const ec = new Map();
        for (const g of entry.groups) {
          const vs = g.vertices, tc = Math.floor(vs.length / 3);
          for (let t = 0; t < tc; t++) {
            const tri = [vs[t * 3], vs[t * 3 + 1], vs[t * 3 + 2]];
            for (const [a, b] of [[tri[0], tri[1]], [tri[1], tri[2]], [tri[2], tri[0]]]) {
              const k = edgeKeyFn(a, b); ec.set(k, (ec.get(k) || 0) + 1);
            }
          }
        }
        const nbWeight = new Map();
        for (const [k, c] of ec) {
          if (c !== 1) continue;
          const gs = edgeToGroups.get(k); if (!gs) continue;
          for (const g of gs) if (!own.has(g) && !defeaturedGroups.has(g)) nbWeight.set(g, (nbWeight.get(g) || 0) + 1);
        }
        // Seiten-Nachbarn (Normale ⊥ Fillet-Achse) in Orientierungs-Cluster; Kappen (∥ Achse)
        // sind erlaubt; SCHRÄGE Nachbarn dazwischen → unsauberer Fall → skip.
        const clusters = [];
        for (const [g, w] of nbWeight) {
          const ng = _norm3(g.normal);
          const dAx = Math.abs(_dot3(ng, fAxis));
          if (dAx > 0.3 && dAx < 0.8) return false;
          if (dAx >= 0.8) continue; // Kappe
          let cl = null;
          for (const c of clusters) if (Math.abs(_dot3(c.n, ng)) >= 0.99) { cl = c; break; }
          if (!cl) { cl = { n: ng, w: 0, ref: g }; clusters.push(cl); }
          cl.w += w; if (g.vertices.length > cl.ref.vertices.length) cl.ref = g;
        }
        if (clusters.length !== 2) return false; // gekrümmte Umgebung (viele Orientierungen) → v2
        const [A, B] = clusters;
        if (Math.abs(_dot3(A.n, B.n)) > Math.cos(20 * Math.PI / 180)) return false; // fast koplanar
        // Scharfe Kante = Schnittlinie der beiden Ebenen (Richtung ≈ Fillet-Achse)
        const d0 = _cross3(A.n, B.n);
        const dl = Math.hypot(d0[0], d0[1], d0[2]);
        if (dl < 1e-6) return false;
        const dir = [d0[0] / dl, d0[1] / dl, d0[2] / dl];
        if (Math.abs(_dot3(dir, fAxis)) < Math.cos(15 * Math.PI / 180)) return false;
        const planeOff = (cl) => { const vs = cl.ref.vertices; let s = 0; for (const v of vs) s += _dot3(cl.n, v); return s / vs.length; };
        const p0 = solve3(A.n, planeOff(A), B.n, planeOff(B), dir, _dot3(dir, fAp));
        if (!p0) return false;
        // Streifen-Ausdehnung entlang der Linie
        let tLo = Infinity, tHi = -Infinity;
        for (const g of entry.groups) for (const v of g.vertices) {
          const t = _dot3(_sub3(v, p0), dir); if (t < tLo) tLo = t; if (t > tHi) tHi = t;
        }
        if (!(tHi > tLo)) return false;
        const tolM = Math.max(0.1, 0.06 * rf);
        const onStrip = (v) => {
          const w = _sub3(v, fAp), al = _dot3(w, fAxis);
          const perp = Math.hypot(w[0] - fAxis[0] * al, w[1] - fAxis[1] * al, w[2] - fAxis[2] * al);
          if (Math.abs(perp - rf) > tolM) return false;
          const t = _dot3(_sub3(v, p0), dir);
          return t >= tLo - 0.5 && t <= tHi + 0.5;
        };
        // Betroffene Loops + verschobene Indizes einsammeln
        const affected = []; const allT = [];
        for (const fd of faceDefs) {
          if (own.has(fd.group) || defeaturedGroups.has(fd.group)) continue;
          for (const loop of [fd.outer, ...fd.inner]) {
            if (loop.circleRim) continue;
            const moved = [];
            for (let i = 0; i < loop.length; i++) if (onStrip(loop[i])) moved.push(i);
            if (!moved.length) continue;
            if (moved.length >= loop.length - 1) return false; // (fast) ganze Schleife auf dem Mantel
            for (const i of moved) allT.push(_dot3(_sub3(loop[i], p0), dir));
            affected.push({ loop, movedSet: new Set(moved) });
          }
        }
        if (affected.length < 2 || allT.length < 4) return false;
        // Kanonische Punkte entlang der Linie (Union A-Seite/B-Seite/Kappen, snap-merge 0.05mm)
        allT.sort((a, b) => a - b);
        const canonT = [];
        for (const t of allT) { if (!canonT.length || t - canonT[canonT.length - 1] > 0.05) canonT.push(t); }
        const canonPts = canonT.map(t => [p0[0] + dir[0] * t, p0[1] + dir[1] * t, p0[2] + dir[2] * t]);
        const canonIdx = (t) => { let bi = 0, bd = Infinity; for (let i = 0; i < canonT.length; i++) { const d = Math.abs(canonT[i] - t); if (d < bd) { bd = d; bi = i; } } return bi; };
        // Loops umschreiben: zusammenhängende Runs verschobener Vertices durch die kanonische
        // Punktfolge im jeweiligen Spann ersetzen (Kappen-Bögen kollabieren auf 1 Punkt).
        for (const { loop, movedSet } of affected) {
          let start = -1;
          for (let i = 0; i < loop.length; i++) if (!movedSet.has(i)) { start = i; break; }
          if (start < 0) return false;
          const n = loop.length;
          const rot = loop.slice(start).concat(loop.slice(0, start));
          const rotMoved = (i) => movedSet.has((i + start) % n);
          const out = [];
          let i = 0;
          while (i < rot.length) {
            if (!rotMoved(i)) { out.push(rot[i]); i++; continue; }
            let j = i; while (j < rot.length && rotMoved(j)) j++;
            const t1 = _dot3(_sub3(rot[i], p0), dir);
            const t2 = _dot3(_sub3(rot[j - 1], p0), dir);
            const i1 = canonIdx(Math.min(t1, t2)), i2 = canonIdx(Math.max(t1, t2));
            let seq = canonPts.slice(i1, i2 + 1);
            if (t1 > t2) seq = seq.slice().reverse();
            out.push(...seq);
            i = j;
          }
          loop.length = 0; loop.push(...out);
        }
        for (const g of entry.groups) defeaturedGroups.add(g);
        return true;
      };
      for (const entry of filletById.values()) {
        try { if (defeatureOne(entry)) filletsDefeatured++; } catch (_) { /* Guard */ }
      }
      if (defeaturedGroups.size) faceDefs = faceDefs.filter(fd => !defeaturedGroups.has(fd.group));
    }
  }

  // ---- Body-Defeaturing v2: Verrundungs-BAND zwischen Ebene und senkrechten Wänden ----
  // Typisch für 2,5D-Teile (Skizze extrudiert, Kanten verrundet): ein geschlossenes Band aus
  // Verrundungs-Facetten läuft rund um einen Loop einer Ebene P (Deckfläche) und verbindet sie
  // mit Wänden, die SENKRECHT auf P stehen (Normale ⊥ P). Entlang gerader Konturabschnitte ist
  // das Band ein Zylinder, an Konturbögen ein Torus — v1 (zwei Ebenen) greift dort nicht.
  // Gelöst als Ganzes: weil die Wände P's Normale enthalten, lässt sich jeder Wandpunkt an der
  // Bandkante entlang dieser Normale auf P schieben, ohne die Wand zu verlassen. Die neue Kontur
  // von P ist exakt der Wandquerschnitt in P's Ebene (= die scharfe Kante, die der Konstrukteur
  // verrundet hat), für gerade UND gekrümmte Konturabschnitte. Die Band-Facetten entfallen.
  // Konservativ: nur geschlossene Ringbänder (Loop von P komplett verrundet, Band grenzt nur an
  // P und Wände), Band muss gekrümmt sein (keine Fasen), neue Kontur muss einfach sein. Jede
  // Unsauberkeit fängt zusätzlich das Wasserdicht-Verdikt + der globale Fallback.
  let bandsDefeatured = 0;
  if (DEFEATURE) {
    try {
      bandsDefeatured = defeatureBands();
    } catch (_) { bandsDefeatured = 0; /* Guard: Änderungen werden erst nach allen Prüfungen angewandt */ }
  }
  function defeatureBands() {
    const WALL_COS = 1e-3;          // |n_W·d| ≤ … → Wand steht senkrecht auf P (CAD-Extrusion: ~1e-7)
    const PARALLEL_COS = 0.9995;    // |n·d| ≥ … → (fast) parallel zu P → kein Band-Element
    const MIN_SPREAD_DEG = 10;      // Band muss gekrümmt sein (Fasen bleiben unangetastet)
    const fds = faceDefs;
    const loopsOf = (fd) => [fd.outer, ...fd.inner].filter((L) => !L.circleRim);
    // Kante → [{ fi, loop }] über alle Flächen (gemeinsame Kanten = gemeinsame Punkt-Schlüssel).
    // Nach jedem angewandten Band neu aufgebaut (verschobene Wandpunkte ändern Kanten-Schlüssel).
    let edgeOwners;
    const buildOwners = () => {
      edgeOwners = new Map();
      fds.forEach((fd, fi) => {
        if (removed.has(fi)) return;
        for (const L of loopsOf(fd)) {
          for (let i = 0; i < L.length; i++) {
            const k = edgeKeyFn(L[i], L[(i + 1) % L.length]);
            let o = edgeOwners.get(k); if (!o) { o = []; edgeOwners.set(k, o); }
            o.push({ fi, loop: L });
          }
        }
      });
    };
    const nrm = fds.map((fd) => _norm3(fd.normal));
    // Polygonfläche je Fläche (Außen minus Innen), lazy — für die Band-Größenschranke
    const areaCache = new Map();
    const loopArea = (L, n) => { let sx = 0, sy = 0, sz = 0; for (let i = 0; i < L.length; i++) { const c = _cross3(L[i], L[(i + 1) % L.length]); sx += c[0]; sy += c[1]; sz += c[2]; } return Math.abs(sx * n[0] + sy * n[1] + sz * n[2]) / 2; };
    const fdArea = (fi) => {
      if (!areaCache.has(fi)) { const fd = fds[fi]; let a = loopArea(fd.outer, nrm[fi]); for (const L of fd.inner) a -= loopArea(L, nrm[fi]); areaCache.set(fi, Math.max(0, a)); }
      return areaCache.get(fi);
    };
    // Ausdehnung des Teils entlang einer Richtung (für die maximale Bandtiefe), gecacht
    const allPts = [];
    for (const fd of fds) for (const p of fd.outer) allPts.push(p);
    const extentCache = new Map();
    const extentAlong = (d) => {
      const key = d.map((x) => x.toFixed(3)).join(',');
      if (!extentCache.has(key)) {
        let lo = Infinity, hi = -Infinity;
        for (const p of allPts) { const t = _dot3(d, p); if (t < lo) lo = t; if (t > hi) hi = t; }
        extentCache.set(key, hi - lo);
      }
      return extentCache.get(key);
    };
    const removed = new Set();
    buildOwners();
    let done = 0;
    const order = fds.map((_, i) => i).sort((a, b) => fds[b].outer.length - fds[a].outer.length);
    for (const pi of order) {
      if (removed.has(pi)) continue;
      const P = fds[pi], d = nrm[pi];
      if (Math.hypot(d[0], d[1], d[2]) < 0.5) continue;
      // Ebenen-Offset von P (Mittel über die Loop-Punkte)
      let off = 0, cnt = 0;
      for (const p of P.outer) { off += _dot3(d, p); cnt++; }
      off /= cnt;
      for (const L of loopsOf(P)) {
        // (1) Jede Kante von L muss an GENAU eine Band-Fläche grenzen
        const Ledges = new Set();
        const seeds = new Set();
        let ok = true;
        for (let i = 0; i < L.length && ok; i++) {
          const k = edgeKeyFn(L[i], L[(i + 1) % L.length]);
          Ledges.add(k);
          const others = (edgeOwners.get(k) || []).filter((o) => o.fi !== pi);
          if (others.length !== 1) { ok = false; break; }
          const c = Math.abs(_dot3(nrm[others[0].fi], d));
          if (c <= WALL_COS || c >= PARALLEL_COS || removed.has(others[0].fi)) { ok = false; break; }
          seeds.add(others[0].fi);
        }
        if (!ok || !seeds.size) continue;
        // Größenschranke: ein Verrundungsband ist schmal und umgibt eine größere Fläche. Ohne
        // Schranke wuchs auf feinen Kugeln von JEDEM Flächenstück ein riesiges Band (50k-Kugel:
        // 9 s → 50 s, O(n²)). Ringförmige Deckflächen (schmaler Kragen) bekommen Spielraum (3×).
        const BAND_AREA_MAX = 3 * fdArea(pi);
        let bandArea = 0;
        for (const fi of seeds) bandArea += fdArea(fi);
        if (bandArea > BAND_AREA_MAX) continue;
        // Teil-Ausdehnung erst NACH der billigen Schranke (O(Punkte) je neuer Richtung — auf
        // Tori/Kugeln hat jedes Flächenstück eine eigene Richtung)
        const RMAX = Math.min(5, 0.45 * extentAlong(d));
        // (2) Band wachsen: Nachbarn sind Band (schräg + nah an P), Wand (⊥ P) oder P (nur über L)
        const band = new Set(seeds), queue = [...seeds];
        const wallEdges = [];          // { a, b } Bandkante zu einer Wand
        const walls = new Set();
        while (queue.length && ok) {
          const fi = queue.pop();
          const fd = fds[fi];
          for (const p of fd.outer) if (Math.abs(_dot3(d, p) - off) > RMAX) { ok = false; break; }
          if (!ok) break;
          for (const Lb of loopsOf(fd)) {
            for (let i = 0; i < Lb.length && ok; i++) {
              const a = Lb[i], b = Lb[(i + 1) % Lb.length];
              const k = edgeKeyFn(a, b);
              const others = (edgeOwners.get(k) || []).filter((o) => o.fi !== fi);
              if (others.length !== 1) { ok = false; break; }
              const ni = others[0].fi;
              if (band.has(ni)) continue;
              if (ni === pi) { if (!Ledges.has(k)) ok = false; continue; }
              if (removed.has(ni)) { ok = false; break; }
              const c = Math.abs(_dot3(nrm[ni], d));
              if (c <= WALL_COS) { walls.add(ni); wallEdges.push({ v0: a, v1: b }); continue; }
              if (c >= PARALLEL_COS) { ok = false; break; }
              band.add(ni); queue.push(ni);
              bandArea += fdArea(ni);
              if (bandArea > BAND_AREA_MAX || band.size > 50000) ok = false;
            }
          }
        }
        if (!ok || !wallEdges.length) continue;
        // (2b) „Wand“-Facetten, deren Ecken ALLE auf dem Band liegen, sind Splitter der Verrundung,
        // deren Normale zufällig ⊥ P steht (z.B. im Eck-Bereich, wo das Band um eine Konturecke
        // läuft). Als Wand würden sie beim Projizieren in P's Ebene kollabieren und die neue Kontur
        // liefe gleichsinnig um sie herum (eBike: 6 Orientierungsfehler) → zum Band schlagen und
        // die Grenze zu den echten Wänden neu bestimmen.
        {
          const bandPts = new Set();
          for (const fi of band) for (const Lb of loopsOf(fds[fi])) for (const p of Lb) bandPts.add(vtxKey(p));
          for (const wi of [...walls]) {
            const W = fds[wi];
            if ([W.outer, ...W.inner].every((Lw) => Lw.every((p) => bandPts.has(vtxKey(p))))) { walls.delete(wi); band.add(wi); }
          }
          wallEdges.length = 0; walls.clear();
          for (const fi of band) {
            for (const Lb of loopsOf(fds[fi])) {
              for (let i = 0; i < Lb.length && ok; i++) {
                const a = Lb[i], b = Lb[(i + 1) % Lb.length];
                const k = edgeKeyFn(a, b);
                const others = (edgeOwners.get(k) || []).filter((o) => o.fi !== fi);
                if (others.length !== 1) { ok = false; break; }
                const ni = others[0].fi;
                if (band.has(ni)) continue;
                if (ni === pi) { if (!Ledges.has(k)) ok = false; continue; }
                if (Math.abs(_dot3(nrm[ni], d)) <= WALL_COS && !removed.has(ni)) { walls.add(ni); wallEdges.push({ v0: a, v1: b }); continue; }
                ok = false;
              }
            }
          }
        }
        if (!ok || !wallEdges.length) continue;
        // (3) Gekrümmt? Winkel der Band-Normalen zu P müssen deutlich streuen
        let angMin = 90, angMax = 0;
        for (const fi of band) {
          const ang = Math.acos(Math.min(1, Math.abs(_dot3(nrm[fi], d)))) * 180 / Math.PI;
          if (ang < angMin) angMin = ang; if (ang > angMax) angMax = ang;
        }
        if (angMax - angMin < MIN_SPREAD_DEG) continue;
        // (4) Wand-Bandkante muss genau EIN geschlossener Ring sein
        const rings = chainEdges(wallEdges);
        if (rings.length !== 1 || rings[0].length < 3) continue;
        const ring = rings[0];
        // (5) Projektion auf P (entlang d — bleibt auf jeder Wand, da Wände d enthalten)
        const proj = new Map();       // vtxKey(alt) → neuer Punkt
        const newLoop = [];
        for (const p of ring) {
          const h = _dot3(d, p) - off;
          if (Math.abs(h) < 1e-6 || Math.abs(h) > RMAX) { ok = false; break; }
          const q = [p[0] - d[0] * h, p[1] - d[1] * h, p[2] - d[2] * h];
          proj.set(vtxKey(p), q);
          if (!newLoop.length || vtxKey(newLoop[newLoop.length - 1]) !== vtxKey(q)) newLoop.push(q);
        }
        if (!ok) continue;
        if (newLoop.length > 1 && vtxKey(newLoop[0]) === vtxKey(newLoop[newLoop.length - 1])) newLoop.pop();
        if (newLoop.length < 3) continue;
        // Nur Wände und Band dürfen die verschobenen Punkte benutzen (sonst Riss/T-Junction)
        for (let fi = 0; fi < fds.length && ok; fi++) {
          if (band.has(fi) || walls.has(fi) || removed.has(fi)) continue;
          for (const Lx of [fds[fi].outer, ...fds[fi].inner]) {
            for (const p of Lx) if (proj.has(vtxKey(p))) { ok = false; break; }
            if (!ok) break;
          }
        }
        if (!ok) continue;
        // (6) Orientierung wie der alte Loop, und die neue Kontur muss einfach sein (2D in P)
        const u = computeRefDir(d), v = _norm3(_cross3(d, u));
        const to2 = (p) => [_dot3(p, u), _dot3(p, v)];
        const area2 = (pts) => { let s = 0; for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; s += a[0] * b[1] - b[0] * a[1]; } return s / 2; };
        const old2 = L.map(to2);
        let new2 = newLoop.map(to2);
        if (Math.sign(area2(old2)) !== Math.sign(area2(new2))) { newLoop.reverse(); new2 = new2.reverse(); }
        const segX = (p1, p2, p3, p4) => {
          const o = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
          const d1 = o(p3, p4, p1), d2 = o(p3, p4, p2), d3 = o(p1, p2, p3), d4 = o(p1, p2, p4);
          return ((d1 > 1e-12 && d2 < -1e-12) || (d1 < -1e-12 && d2 > 1e-12)) && ((d3 > 1e-12 && d4 < -1e-12) || (d3 < -1e-12 && d4 > 1e-12));
        };
        const n2 = new2.length;
        for (let i = 0; i < n2 && ok; i++) {
          for (let j = i + 2; j < n2; j++) {
            if (i === 0 && j === n2 - 1) continue;
            if (segX(new2[i], new2[(i + 1) % n2], new2[j], new2[(j + 1) % n2])) { ok = false; break; }
          }
        }
        if (!ok) continue;
        // (7) Anwenden: P bekommt die Wandkontur, Wände werden bis P verlängert, Band entfällt
        L.length = 0; L.push(...newLoop);
        for (const wi of walls) {
          const W = fds[wi];
          for (const Lw of [W.outer, ...W.inner]) {
            for (let i = 0; i < Lw.length; i++) { const q = proj.get(vtxKey(Lw[i])); if (q) Lw[i] = q; }
          }
        }
        for (const fi of band) removed.add(fi);
        done++;
        buildOwners();
      }
    }
    if (removed.size) faceDefs = faceDefs.filter((_, i) => !removed.has(i));
    return done;
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

      // Chamfer-Kegel (Fase): überbrückt Rand-Kreis R@z1 (mit Zylinder geteilt) und Flach-Kreis
      // R2@z2 (mit der flachen Fläche geteilt). Orientierung: Kegel nutzt Rand .T. (Zylinder .F.),
      // Flach-Kreis .F. (Flachfläche .T.) → je Kreis 1×fwd/1×rev (wasserdicht).
      for (const cr of (plan.coneRims || [])) {
        const conePlac = addAxis2Placement3D(cr.rimDesc.center, cr.coneAxis, cr.rimDesc.refDir);
        const coneSurf = addConicalSurface(conePlac, cr.rimDesc.radius, cr.semiAngle);
        const ceRim = getOrCreateCircleEdge(cr.rimDesc.rimKey, cr.rimDesc);
        const ceFlat = getOrCreateCircleEdge(cr.flatDesc.rimKey, cr.flatDesc);
        useCircle(cr.rimDesc.rimKey, true);
        useCircle(cr.flatDesc.rimKey, false);
        const ob = addFaceOuterBound(addEdgeLoop([addOrientedEdge(ceRim.ecId, true)]));
        const ib = addFaceBound(addEdgeLoop([addOrientedEdge(ceFlat.ecId, false)]));
        faceIds.push(addAdvancedFace([ob, ib], coneSurf, true));
      }
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

  // ---- Kollineare Zwischenpunkte auf geraden Kanten entfernen ----
  // Die Loops tragen ROH-Netzpunkte (wasserdicht, s. extractGroupFaces) — eine im Netz unterteilte
  // gerade Kante (z.B. Seitenwand eines Extrusionsteils, entlang Z in Streifen tesselliert; oder die
  // kanonischen Punkte einer defeatureten scharfen Kante) wird so im STEP zur Kette kurzer Stücke,
  // die CAD als viele Kanten zeigt. Ein Punkt v fällt weg, wenn GENAU zwei Loops ihn nutzen, beide
  // mit denselben Nachbarn a,b in Gegenrichtung (a→v→b / b→v→a = die zwei Seiten EINER Kante) und
  // a,v,b kollinear sind (v zwischen a und b). Topologisch neutral: a–v und v–b (je 1×fwd/1×rev)
  // werden zu a–b (1×fwd/1×rev) → Wasserdicht-Bilanz unverändert. Gesperrt, wenn a–b schon als
  // Kante existiert (sonst non-manifold) oder ein Loop unter 3 Kanten fiele. Jede neue Kante merkt
  // sich die geschluckten Punkte — ALLE müssen auf ihr liegen (keine Drift über lange Ketten).
  // circleRim-Loops (analytische Kreise, keine Linien-Kanten) bleiben unberührt. Spiegelt die
  // Emission in assemble(): Schlüssel = vtxKey (≡ ptKey), gleiche Nachbarpunkte werden übersprungen,
  // Flächen mit < 3 Außen-Kanten bzw. Innen-Loops mit < 3 Kanten werden nicht emittiert.
  const COLLINEAR_DIST = 1e-4;  // mm — Abstand jedes geschluckten Punktes zur neuen Kante a–b
  const COLLINEAR_SIN = 1e-5;   // sin des Knickwinkels bei v (Ecken bleiben exakt erhalten)
  const kinkSin = (a, v, b) => {
    const d1 = _sub3(v, a), d2 = _sub3(b, v), c = _cross3(d1, d2);
    return Math.hypot(c[0], c[1], c[2]) / ((Math.hypot(d1[0], d1[1], d1[2]) * Math.hypot(d2[0], d2[1], d2[2])) || 1);
  };
  const removeCollinearPoints = (fds) => {
    // Schnellweg: die ERSTE Entfernung setzt einen Punkt voraus, der mit seinen direkten Loop-
    // Nachbarn kollinear ist — gibt es keinen, entfällt der Schlüssel-/Map-Aufbau. Gekrümmte Netze
    // (Kugel, Torus) haben keinen (50k-Kugel: ~60 ms gespart).
    const anyKink = () => {
      for (const fd of fds) {
        for (const L of [fd.outer, ...fd.inner]) {
          if (L.circleRim) continue;
          for (let i = 0, n = L.length; i < n; i++) if (kinkSin(L[(i - 1 + n) % n], L[i], L[(i + 1) % n]) < COLLINEAR_SIN) return true;
        }
      }
      return false;
    };
    if (!anyKink()) return 0;
    const recs = [];            // { pts, keys, prev, next, edges } — Loop als verkettete Liste
    const mkRec = (L) => {
      const n = L.length, keys = L.map(vtxKey);
      const prev = new Int32Array(n), next = new Int32Array(n);
      let edges = 0;
      for (let i = 0; i < n; i++) { prev[i] = (i - 1 + n) % n; next[i] = (i + 1) % n; if (keys[i] !== keys[next[i]]) edges++; }
      return { pts: L, keys, prev, next, edges, dead: null };
    };
    for (const fd of fds) {
      const outer = mkRec(fd.outer);
      if (outer.edges < 3) continue;               // assemble() überspringt die ganze Fläche
      recs.push(outer);
      for (const L of fd.inner) {
        if (L.circleRim) continue;
        const r = mkRec(L);
        if (r.edges >= 3) recs.push(r);
      }
    }
    // Kanten (Schlüsselpaar) → { n: Nutzungen, sw: geschluckte Punkte }; Punkt → Vorkommen
    const ek = (k1, k2) => (k1 < k2 ? `${k1}|${k2}` : `${k2}|${k1}`);
    const edgeMap = new Map();
    const occ = new Map();
    for (const r of recs) {
      for (let i = 0; i < r.keys.length; i++) {
        const k = r.keys[i], kn = r.keys[r.next[i]];
        if (k !== kn) { const e = ek(k, kn), o = edgeMap.get(e); if (o) o.n++; else edgeMap.set(e, { n: 1, sw: null }); }
        const oc = occ.get(k); if (oc) oc.push({ r, i }); else occ.set(k, [{ r, i }]);
      }
    }
    const distToLine = (p, a, ab, abLen) => { const c = _cross3(_sub3(p, a), ab); return Math.hypot(c[0], c[1], c[2]) / abLen; };
    const tryRemove = (kv) => {
      const oc = occ.get(kv);
      if (!oc || oc.length !== 2) return false;
      const [o1, o2] = oc;
      const r1 = o1.r, r2 = o2.r;
      if (r1.pts === r2.pts || r1.edges < 4 || r2.edges < 4) return false;
      const ia = r1.prev[o1.i], ib = r1.next[o1.i];
      const ka = r1.keys[ia], kb = r1.keys[ib];
      if (ka === kb || ka === kv || kb === kv) return false;
      if (r2.keys[r2.prev[o2.i]] !== kb || r2.keys[r2.next[o2.i]] !== ka) return false; // b→v→a
      const eab = ek(ka, kb);
      if (edgeMap.has(eab)) return false;          // a–b existiert schon → wäre non-manifold
      const a = r1.pts[ia], v = r1.pts[o1.i], b = r1.pts[ib];
      const ab = _sub3(b, a), abLen = Math.hypot(ab[0], ab[1], ab[2]);
      if (!(abLen > 0)) return false;
      const t = _dot3(_sub3(v, a), ab) / (abLen * abLen);
      if (!(t > 0 && t < 1)) return false;         // v muss ZWISCHEN a und b liegen
      if (!(kinkSin(a, v, b) < COLLINEAR_SIN)) return false;
      const eav = edgeMap.get(ek(ka, kv)), evb = edgeMap.get(ek(kv, kb));
      if (!eav || !evb || eav.n !== 2 || evb.n !== 2) return false;
      const sw = [v, ...(eav.sw || []), ...(evb.sw || [])];
      for (const p of sw) if (!(distToLine(p, a, ab, abLen) < COLLINEAR_DIST)) return false;
      // Anwenden: v in beiden Loops aushängen, Kanten-Buchhaltung nachziehen
      for (const { r, i } of oc) {
        const p = r.prev[i], n = r.next[i];
        r.next[p] = n; r.prev[n] = p; r.edges--;
        (r.dead || (r.dead = new Set())).add(i);
      }
      edgeMap.delete(ek(ka, kv)); edgeMap.delete(ek(kv, kb));
      edgeMap.set(eab, { n: 2, sw });
      occ.delete(kv);
      return true;
    };
    // Iterieren bis stabil: nach jeder Entfernung die neuen Nachbarn a,b erneut prüfen
    let removedCount = 0;
    const work = [];
    for (const [k, oc] of occ) if (oc.length === 2) work.push(k);
    while (work.length) {
      const kv = work.pop();
      const oc = occ.get(kv);
      if (!oc || oc.length !== 2) continue;
      const { r, i } = oc[0];
      const ka = r.keys[r.prev[i]], kb = r.keys[r.next[i]];
      if (tryRemove(kv)) { removedCount++; work.push(ka, kb); }
    }
    if (removedCount) {
      for (const r of recs) {
        if (!r.dead) continue;
        // in place verdichten: Loop-Objekt (fd.outer/inner) und Reihenfolge bleiben erhalten
        let w = 0;
        for (let i = 0; i < r.pts.length; i++) if (!r.dead.has(i)) r.pts[w++] = r.pts[i];
        r.pts.length = w;
      }
    }
    return removedCount;
  };
  removeCollinearPoints(faceDefs);

  let asm = assemble(faceDefs, finalPlans);
  asm.report.filletsDefeatured = filletsDefeatured;
  asm.report.bandsDefeatured = bandsDefeatured;
  // Globaler Schutz: öffnet die analytische Umwandlung ODER das Defeaturing die Hülle, wird
  // ALLES facettiert neu gebaut (buildFaceDefs(null) erzeugt FRISCHE, unmutierte Loops) —
  // die wasserdichte Baseline kann dadurch nie regressieren. (Die Kollinear-Bereinigung läuft auch
  // hier: sie ist topologisch neutral, sonst hätte „Defeaturing an" mehr Kanten als „aus".)
  if ((asm.report.boresConverted > 0 || filletsDefeatured > 0 || bandsDefeatured > 0) && !asm.report.watertight) {
    const fallbackDefs = buildFaceDefs(null);
    removeCollinearPoints(fallbackDefs);
    asm = assemble(fallbackDefs, []);
    asm.report.filletsDefeatured = 0;
    asm.report.bandsDefeatured = 0;
  }
  const allFaceIds = asm.faceIds;
  const report = asm.report;
  if (allFaceIds.length < 2) return null;

  // ---- Step 4: Units + context ----
  // WICHTIG: komplexe (UND-verknüpfte) STEP-Entitäten MÜSSEN in äußere Klammern `( … )`.
  // Ohne sie lesen strikte CAD-Importer (Fusion/FreeCAD/SolidWorks) die Einheit NICHT und
  // skalieren auf eine Default-Einheit → Bauteil erscheint z.B. 10× zu groß (mm als cm gelesen).
  // Außerdem Winkel- + Raumwinkel-Einheit + Unsicherheit angeben (Winkel nötig für CONICAL_SURFACE).
  const lenUnitId = id++;
  entities.push(`#${lenUnitId}=( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) );`);
  const angUnitId = id++;
  entities.push(`#${angUnitId}=( NAMED_UNIT(*) PLANE_ANGLE_UNIT() SI_UNIT($,.RADIAN.) );`);
  const solUnitId = id++;
  entities.push(`#${solUnitId}=( NAMED_UNIT(*) SI_UNIT($,.STERADIAN.) SOLID_ANGLE_UNIT() );`);
  const uncId = id++;
  entities.push(`#${uncId}=UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(0.01),#${lenUnitId},'distance_accuracy_value','confusion accuracy');`);
  const ctxId = id++;
  entities.push(`#${ctxId}=( GEOMETRIC_REPRESENTATION_CONTEXT(3) GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#${uncId})) GLOBAL_UNIT_ASSIGNED_CONTEXT((#${lenUnitId},#${angUnitId},#${solUnitId})) REPRESENTATION_CONTEXT('','3D') );`);

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

  // Komplexe Entitäten MIT äußeren Klammern (sonst Einheiten-Fehlskalierung im CAD, s. V2-Exporter).
  const lenUnitId = id++;
  entities.push(`#${lenUnitId}=( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) );`);
  const angUnitId = id++;
  entities.push(`#${angUnitId}=( NAMED_UNIT(*) PLANE_ANGLE_UNIT() SI_UNIT($,.RADIAN.) );`);
  const solUnitId = id++;
  entities.push(`#${solUnitId}=( NAMED_UNIT(*) SI_UNIT($,.STERADIAN.) SOLID_ANGLE_UNIT() );`);
  const uncId = id++;
  entities.push(`#${uncId}=UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(0.01),#${lenUnitId},'distance_accuracy_value','confusion accuracy');`);
  const ctxId = id++;
  entities.push(`#${ctxId}=( GEOMETRIC_REPRESENTATION_CONTEXT(3) GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#${uncId})) GLOBAL_UNIT_ASSIGNED_CONTEXT((#${lenUnitId},#${angUnitId},#${solUnitId})) REPRESENTATION_CONTEXT('','3D') );`);
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

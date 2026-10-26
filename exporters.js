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
import { matchTubeMouths } from './tube-sweep.js?v=1';

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
  // Defeaturing-Toggle (default AN): Verrundungen werden beim Export entfernt — Gerade-Kanten-
  // Verrundungen (v1), Verrundungs-Bänder (v2, auch an Loch-Mündungen) und Profil-Eckrundungen (v2b)
  // → scharfe Kante; danach werden Bohrungen mit nun scharfer Mündung zu Zylindern. Mündungen, die
  // v2 nicht schärfen kann (z.B. echte Fase), → Kegel-Fase (Chamfer-Pfad).
  // OFF = Verrundungen bleiben (facettiert); nur exakte Direkt-Treffer konvertieren weiter.
  const DEFEATURE = analysis?.defeature !== false;

  // ---- Test-Hooks (nur Tests/Node, tests/orientation-guard.mjs): STLREV_TEST_FLIP='bore'|'cone'|
  // 'tube' dreht den emittierten same_sense der jeweiligen analytischen Flächen ABSICHTLICH um,
  // 'tubecurve' die mittlere Übergangskurve jedes Kanals (beide Nutzungen). Die Kanten-Bilanz
  // (fwd/rev) bleibt dabei ausgeglichen, das Wasserdicht-Verdikt sieht nichts — genau diese Fälle
  // muss der Orientierungs-Wächter (assemble) fangen. STLREV_TEST_GUARD_REPORT_ONLY=1: Wächter
  // meldet nur (kein Fallback) — damit der Test die fehlerhafte Datei selbst prüfen kann.
  // Im Browser-Worker gibt es kein process → beide aus.
  const testEnv = (k) => (typeof process !== 'undefined' && process.env && process.env[k]) || '';
  const TEST_FLIP = testEnv('STLREV_TEST_FLIP');
  const testFlip = (kind) => TEST_FLIP === kind;
  const GUARD_FALLBACK = testEnv('STLREV_TEST_GUARD_REPORT_ONLY') !== '1';

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
  // (Gleiches Ergebnis wie `(+v.toFixed(dp) || 0).toFixed(dp)`, nur ohne zweites toFixed.)
  const fixZero = (v, dp) => { const s = Number(v).toFixed(dp); return s.charCodeAt(0) === 45 && +s === 0 ? s.slice(1) : s; };
  // Schlüssel je Punkt-Array merken: Defeaturing/Verschmelzen fragen dieselben Punkte tausendfach
  // ab (eBike: ~40 % der Exportzeit in toFixed). Die Koordinaten werden mitgeprüft, damit ein
  // nachträglich verändertes Array nie einen veralteten Schlüssel liefert.
  const vkCache = new WeakMap();
  const vtxKey = (v) => {
    const c = vkCache.get(v);
    if (c && c.x === v[0] && c.y === v[1] && c.z === v[2]) return c.k;
    const k = `${fixZero(v[0], VKEY_DP)},${fixZero(v[1], VKEY_DP)},${fixZero(v[2], VKEY_DP)}`;
    if (v && typeof v === 'object') vkCache.set(v, { x: v[0], y: v[1], z: v[2], k });
    return k;
  };
  const edgeKeyFn = (a, b) => {
    const ka = vtxKey(a), kb = vtxKey(b);
    return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
  };
  // Punkt-Nummern (gleicher vtxKey = gleiche Nummer) für Kanten-Schlüssel als ZAHL — die
  // Zeichenketten-Schlüssel kosteten bei der Ebenheits-Zerlegung am 50k-Stressnetz spürbar Zeit.
  const VID_M = 67108864;                                    // 2^26 Punkte → Schlüssel < 2^52
  const vidOf = new Map(), vidKeys = [];
  const vid = (p) => { const k = vtxKey(p); let i = vidOf.get(k); if (i === undefined) { i = vidKeys.length; vidOf.set(k, i); vidKeys.push(k); } return i; };
  const edgeNum = (a, b) => { const ia = vid(a), ib = vid(b); return ia < ib ? ia * VID_M + ib : ib * VID_M + ia; };

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

  // Rand-Kanten (genau 1× genutzt) einer Dreiecksmenge, gerichtet wie in ihrem Dreieck (Wicklung).
  const boundaryEdgesOf = (verts, tris) => {
    const cnt = new Map(), first = new Map();
    for (const t of tris) {
      const tri = [verts[t * 3], verts[t * 3 + 1], verts[t * 3 + 2]];
      for (const [a, b] of [[tri[0], tri[1]], [tri[1], tri[2]], [tri[2], tri[0]]]) {
        const k = edgeNum(a, b);
        cnt.set(k, (cnt.get(k) || 0) + 1);
        if (!first.has(k)) first.set(k, { v0: a, v1: b });
      }
    }
    const out = [];
    for (const [k, c] of cnt) if (c === 1) out.push(first.get(k));
    return out;
  };
  // Berührt sich der Rand selbst (Ecke mit > 2 Rand-Kanten)? Dann verkettet chainEdges (richtungs-
  // blind) dort beliebig weiter — der Loop läuft danach stückweise verkehrt herum, die Nachbarn
  // nutzen die Kanten gleichsinnig (dino: 44 Orientierungsfehler an 3 solchen Flächen).
  const hasPinch = (edges) => {
    const deg = new Map();
    for (const { v0, v1 } of edges) {
      for (const v of [v0, v1]) { const k = vtxKey(v), d = (deg.get(k) || 0) + 1; if (d > 2) return true; deg.set(k, d); }
    }
    return false;
  };
  // Gerichtete Rand-Kanten zu Loops verketten und an Mehrfach-Ecken auftrennen. Jede Kante folgt der
  // Dreieckswicklung → Außenränder laufen gegen den Uhrzeigersinn um die Normale, Löcher im
  // Uhrzeigersinn — egal, wie die Kette an einer Mehrfach-Ecke weiterläuft. null = Rand nicht in
  // geschlossene gerichtete Loops zerlegbar (uneinheitliche Wicklung) → richtungsblinder Weg.
  const chainDirected = (edges) => {
    const outs = new Map();
    edges.forEach((e, i) => { const k = vtxKey(e.v0), a = outs.get(k); if (a) a.push(i); else outs.set(k, [i]); });
    const used = new Uint8Array(edges.length);
    const loops = [];
    for (let s = 0; s < edges.length; s++) {
      if (used[s]) continue;
      const startKey = vtxKey(edges[s].v0);
      const pts = [], keys = [];
      let i = s, closed = false;
      for (let guard = 0; guard <= edges.length; guard++) {
        used[i] = 1; pts.push(edges[i].v0); keys.push(vtxKey(edges[i].v0));
        const kEnd = vtxKey(edges[i].v1);
        if (kEnd === startKey) { closed = true; break; }
        const cand = outs.get(kEnd);
        let next = -1;
        if (cand) for (const j of cand) if (!used[j]) { next = j; break; }
        if (next < 0) break;
        i = next;
      }
      if (!closed) return null;
      // Taucht ein Punkt erneut auf, ist das Stück seit seinem ersten Auftreten ein eigener
      // geschlossener Loop (gleichsinnig, da jede Kante der Wicklung folgt).
      const stP = [], stK = [], pos = new Map();
      for (let j = 0; j < pts.length; j++) {
        const k = keys[j], at = pos.get(k);
        if (at !== undefined) {
          const subP = stP.splice(at), subK = stK.splice(at);
          for (const kk of subK) pos.delete(kk);
          if (subP.length >= 3) loops.push(subP);
        }
        pos.set(k, stP.length); stP.push(pts[j]); stK.push(k);
      }
      if (stP.length >= 3) loops.push(stP);
    }
    return loops;
  };
  const loopCentroid = (loops) => {
    let cx = 0, cy = 0, cz = 0, ntot = 0;
    for (const loop of loops) for (const p of loop) { cx += p[0]; cy += p[1]; cz += p[2]; ntot++; }
    return ntot ? [cx / ntot, cy / ntot, cz / ntot] : null;
  };
  const projector2d = (normal, centroid) => {
    const uDir = computeRefDir(normal);
    const vDir = _norm3(_cross3(normal, uDir));
    return (p) => { const dp = _sub3(p, centroid); return [_dot3(dp, uDir), _dot3(dp, vDir)]; };
  };
  const signedArea2d = (pts) => {
    let a = 0;
    for (let i = 0; i < pts.length; i++) { const j = (i + 1) % pts.length; a += pts[i][0] * pts[j][1] - pts[j][0] * pts[i][1]; }
    return a * 0.5;
  };
  const centroid2d = (pts) => { let x = 0, y = 0; for (const p of pts) { x += p[0]; y += p[1]; } return [x / pts.length, y / pts.length]; };

  // Gerichtete Loops → Flächen: positive Fläche (um die Normale) = Außenrand, negative = Loch;
  // jedes Loch gehört zum kleinsten Außenrand, der es enthält. null, wenn ein Loch keinen hat.
  const facesFromDirectedLoops = (loops, normal, minFace, minHole) => {
    const centroid = loopCentroid(loops);
    if (!centroid) return [];
    const to2 = projector2d(normal, centroid);
    const l2 = loops.map((L) => L.map(to2));
    const areas = l2.map(signedArea2d), cents = l2.map(centroid2d);
    const outerIdx = [], holeIdx = [];
    areas.forEach((a, i) => { if (a > 0) outerIdx.push(i); else if (a < 0) holeIdx.push(i); });
    const holesOf = new Map(outerIdx.map((o) => [o, []]));
    for (const h of holeIdx) {
      let best = -1, bestA = Infinity;
      for (const o of outerIdx) if (areas[o] < bestA && areas[o] > -areas[h] && pointInPoly2d(cents[h], l2[o])) { best = o; bestA = areas[o]; }
      if (best < 0) return null;
      holesOf.get(best).push(h);
    }
    const faces = [];
    for (const o of outerIdx) {
      if (areas[o] < minFace) continue;
      const inner = holesOf.get(o).filter((h) => -areas[h] >= minHole).map((h) => loops[h]);
      faces.push({ outer: loops[o], inner, normal, centroid });
    }
    return faces;
  };

  // Richtungsblinder Weg (bisheriger Stand, für alle Ränder ohne Mehrfach-Ecke unverändert).
  const facesFromUndirected = (boundaryEdges, normal) => {
    const rawLoops = chainEdges(boundaryEdges);
    if (!rawLoops.length) return [];
    // Centroid for 2D projection.
    const centroid = loopCentroid(rawLoops);
    if (!centroid) return [];
    const project2d = projector2d(normal, centroid);
    const loops2d = rawLoops.map(loop => loop.map(project2d));
    const signedAreas = loops2d.map(signedArea2d);
    const centroids2d = loops2d.map(centroid2d);

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
    const faces = [];
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
      faces.push({ outer, inner, normal, centroid });
    }
    return faces;
  };

  // Berühren sich zwei Ränder einer Fläche in einer Ecke (Loch an Loch, Loch am Außenrand)?
  const loopsTouch = (fd) => {
    const seen = new Map();
    const loops = [fd.outer, ...fd.inner];
    for (let li = 0; li < loops.length; li++) {
      for (const p of loops[li]) { const k = vtxKey(p), o = seen.get(k); if (o !== undefined && o !== li) return true; seen.set(k, li); }
    }
    return false;
  };
  // Kanten-Valenz über ALLE Dreiecke des Netzes (lazy): > 2 = im Netz non-manifold. Liegt so eine
  // Kante INNERHALB einer Fläche (Faltung: zwei Dreiecke der Fläche + ein fremdes Blatt), bleibt sie
  // unsichtbar; wird die Fläche zerlegt, wäre sie 4× genutzt → die Teilflächen bekommen dafür eine
  // eigene Kanten-Instanz (fold, s. buildLoopEdges).
  let meshEdgeCount = null;
  const meshEdgeValence = (k) => {
    if (!meshEdgeCount) {
      meshEdgeCount = new Map();
      for (const g of normalGroups) {
        const vs = g.vertices;
        for (let t = 0; t + 2 < vs.length; t += 3) {
          for (const [a, b] of [[vs[t], vs[t + 1]], [vs[t + 1], vs[t + 2]], [vs[t + 2], vs[t]]]) { const e = edgeKeyFn(a, b); meshEdgeCount.set(e, (meshEdgeCount.get(e) || 0) + 1); }
        }
      }
    }
    return meshEdgeCount.get(k) || 0;
  };
  let foldSeq = 0;
  // Jedes Dreieck eine eigene (exakt ebene) Fläche, Rand in Wicklungsrichtung.
  const trianglesAsFaces = (verts, tris, normal) => {
    const faces = [], inner = new Map();
    for (const t of tris) {
      const a = verts[t * 3], b = verts[t * 3 + 1], c = verts[t * 3 + 2];
      const ka = vtxKey(a), kb = vtxKey(b), kc = vtxKey(c);
      if (ka === kb || kb === kc || ka === kc) continue;              // entartet: keine Fläche
      const wn = _cross3(_sub3(b, a), _sub3(c, a)), l = Math.hypot(wn[0], wn[1], wn[2]);
      faces.push({ outer: [a, b, c], inner: [], normal: l > 0 ? [wn[0] / l, wn[1] / l, wn[2] / l] : normal,
        centroid: [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3] });
      for (const [p, q] of [[a, b], [b, c], [c, a]]) { const e = edgeKeyFn(p, q); inner.set(e, (inner.get(e) || 0) + 1); }
    }
    const foldKeys = new Set();
    for (const [e, c] of inner) if (c === 2 && meshEdgeValence(e) > 2) foldKeys.add(e.replace('|', '||'));   // = edgeCanonKey
    if (foldKeys.size) { const fold = { id: ++foldSeq, keys: foldKeys }; for (const f of faces) f.fold = fold; }
    return faces;
  };

  // Flächen einer (kanten-zusammenhängenden) Dreiecksmenge. Jede Fläche merkt sich ihre Herkunft
  // (Dreiecke + Loop-Schnappschuss): enforcePlanarity zerlegt nur Flächen, deren Loops seither
  // unverändert sind. directed=true: immer gerichtet verketten (Teilflächen der Ebenheits-Zerlegung;
  // die brauchen keine Herkunft: keepSrc=false).
  const facesFromTris = (verts, tris, normal, { directed = false, minFace = MIN_FACE_AREA, minHole = MIN_HOLE_AREA, keepSrc = true } = {}) => {
    if (directed && tris.length === 1) {                      // Schnellweg: ein Dreieck = ein Loop
      const t = tris[0], a = verts[t * 3], b = verts[t * 3 + 1], c = verts[t * 3 + 2];
      if (vtxKey(a) === vtxKey(b) || vtxKey(b) === vtxKey(c) || vtxKey(a) === vtxKey(c)) return [];
      return [{ outer: [a, b, c], inner: [], normal, centroid: [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3] }];
    }
    const boundaryEdges = boundaryEdgesOf(verts, tris);
    if (boundaryEdges.length < 3) return [];
    let faces = null;
    if (directed || hasPinch(boundaryEdges)) {
      const loops = chainDirected(boundaryEdges);
      if (loops && loops.length) faces = facesFromDirectedLoops(loops, normal, minFace, minHole);
      // Ränder, die sich in einer Ecke berühren, sind gültige STEP-Topologie — occt (Panel 4,
      // FreeCAD) trianguliert solche Flächen aber nicht (dino: eine 91-mm²-Fläche fehlte). Darum
      // diese (seltenen) Dreiecksmengen als Einzeldreiecke ausgeben.
      if (faces && faces.some(loopsTouch)) faces = trianglesAsFaces(verts, tris, normal);
    }
    if (!faces || !faces.length) faces = facesFromUndirected(boundaryEdges, normal);
    if (keepSrc) {
      const single = faces.length === 1;
      for (const fd of faces) fd.src = { verts, tris, single, outer: fd.outer.slice(), inner: fd.inner.map((L) => L.slice()) };
    }
    return faces;
  };

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
    for (const comp of components) for (const fd of facesFromTris(verts, comp, normal)) allFaces.push(fd);
    return allFaces;
  };

  // ---- Step 1: Compute face polygons from all groups ----
  // ---- Analytische Voll-Bohrungen: erkannte Zylinder als EINE CYLINDRICAL_SURFACE + 2 Kreis-
  // Kanten statt Dutzender Facetten-Planes. Nahtlose Form (2 volle Kreis-Bounds) — empirisch
  // bestätigt, dass occt-import-js (Panel 4) sie parst. Fallback-Ebenen schützen die
  // Wasserdicht-Baseline: (1) attemptBore→null bzw. sharpBorePlan→null pro Bohrung, (2) Rand-Match
  // scheitert→facettiert, (3) öffnet die Umwandlung die Hülle → mit Toggle erst ohne Bohrungen neu
  // bauen (Defeaturing bleibt), (4) globaler Schutz unten → komplett facettiert neu bauen.
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
  // Nur KONKAVE Vollzylinder sind Bohrungen (Loch im Material: die Außennormalen der Wand zeigen
  // zur Achse). Ein konvexer Vollzylinder (Welle, Zapfen, Rohr-Außenwand) wird von der Erkennung
  // ebenfalls als 'bore' getaggt — seine Ränder liegen aber auf AUSSEN-Loops der Deckflächen; als
  // Bohrung behandelt, fand der Rand-Abgleich einen falschen Innen-Loop (Rohr Ra=40/Ri=38: Rand der
  // Außenwand ↔ Innen-Loop R38) → Hülle offen → globaler Fallback verwarf alles.
  const isConcaveBore = (entry) => {
    const axis = _norm3(entry.prim.axis), ap = entry.prim.axisPoint;
    let s = 0, w = 0;
    for (const g of entry.groups) {
      const vs = g.vertices;
      if (!vs.length || !Array.isArray(g.normal)) continue;
      let cx = 0, cy = 0, cz = 0; for (const v of vs) { cx += v[0]; cy += v[1]; cz += v[2]; }
      const d = _sub3([cx / vs.length, cy / vs.length, cz / vs.length], ap), al = _dot3(d, axis);
      const rad = _norm3([d[0] - axis[0] * al, d[1] - axis[1] * al, d[2] - axis[2] * al]);
      const wt = vs.length / 3;
      s += _dot3(_norm3(g.normal), rad) * wt; w += wt;
    }
    return w > 0 && s / w < -0.5; // Wand: −1 (zur Achse), konvexer Mantel: +1
  };
  for (const [k, e] of boreById) if (!isConcaveBore(e)) boreById.delete(k);

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
      let sr = 0;
      for (const pt of loop) {
        const w = _sub3(pt, center), along = _dot3(w, axis);
        const perp = Math.hypot(w[0] - axis[0] * along, w[1] - axis[1] * along, w[2] - axis[2] * along);
        if (Math.abs(perp - R) > tol) return null;
        sr += perp;
      }
      const rimKey = `${fixZero(center[0], 3)},${fixZero(center[1], 3)},${fixZero(center[2], 3)}|${fixZero(R, 3)}`;
      // loopR = GEMESSENER Radius des Rand-Loops (Mittel der Achsabstände) — Referenz für den
      // Direkt-Abgleich; `radius` (Fit des Primitivs) bleibt die Geometrie der Kreiskante.
      rims.push({ center, axis, radius: R, refDir, rimKey, meanT, loopR: sr / loop.length });
    }
    rims.sort((a, b) => a.meanT - b.meanT); // [unten, oben]
    if (rims[0].rimKey === rims[1].rimKey) return null; // null-Höhe / kollabiert
    return { prim, rims, groups: entry.groups, surfCenter: rims[0].center };
  };

  // Innen-Loop einer Flachfläche rein GEOMETRISCH einem Rand zuordnen (simplifyLoop kann die
  // Polygon-Auflösung verändert haben → niemals über Vertex-Mengen vergleichen).
  // Ein Direkt-Treffer IST derselbe Kantenzug wie der Bohrungsrand → gleiche Höhe und gleicher
  // Radius bis auf Rundung. Daher absolute bzw. am GEMESSENEN Rand-Radius geeichte Toleranzen:
  // die früheren R-relativen (axial 0.1·R, radial 0.06·R) ordneten bei kleiner Mündungsrundung an
  // großem Radius den Rand einem Loop ANDERER Höhe/anderen Radius zu (Platte Ø20 mit r=0.5: Rand
  // des Bohrungskerns z≈0.4/R10 ↔ Mündungskreis z=0/R10.5) → Verrundungsfacetten blieben übrig →
  // Hülle offen → globaler Fallback verwarf auch korrekte v2-Bänder.
  const RIM_AXIAL_TOL = 0.05;
  const innerMatchesRim = (loop, normal, rim) => {
    if (Math.abs(_dot3(normal, rim.axis)) < 0.985) return false; // Wand ~⟂ zur Achse (≤10°)
    let cx = 0, cy = 0, cz = 0; for (const p of loop) { cx += p[0]; cy += p[1]; cz += p[2]; }
    const c = [cx / loop.length, cy / loop.length, cz / loop.length];
    if (Math.hypot(c[0] - rim.center[0], c[1] - rim.center[1], c[2] - rim.center[2]) > Math.max(0.15, 0.6 * rim.radius)) return false;
    // Axial-Ebenen-Gate: der Loop MUSS in der Ebene DIESES Randes liegen (an seinem eigenen Ende).
    // Der Radialtest unten ist achsen-blind (projiziert den Achsanteil weg) — ohne dieses Gate würde
    // ein koaxialer Ring am ANDEREN Loch-Ende fälschlich matchen (geometrisch falsche Fläche, aber
    // topologisch wasserdicht → vom Verdikt NICHT gefangen). Trennt auch dünne Platten korrekt auf.
    if (Math.abs(_dot3(_sub3(c, rim.center), rim.axis)) > RIM_AXIAL_TOL) return false;
    // Radius: Mittel des Loops = gemessener Rand-Radius (exakt passend), Einzelpunkte mit der
    // Form-Toleranz aus attemptBore.
    const radTol = Math.max(0.1, 0.06 * rim.radius);
    const loopR = Number.isFinite(rim.loopR) ? rim.loopR : rim.radius;
    let sr = 0;
    for (const p of loop) {
      const w = _sub3(p, rim.center), along = _dot3(w, rim.axis);
      const perp = Math.hypot(w[0] - rim.axis[0] * along, w[1] - rim.axis[1] * along, w[2] - rim.axis[2] * along);
      if (Math.abs(perp - loopR) > radTol) return false;
      sr += perp;
    }
    return Math.abs(sr / loop.length - loopR) <= Math.max(0.02, 0.002 * loopR);
  };

  // faceDefs der Nicht-Bohrungs-Gruppen (mit Gruppen-Ref für Fillet-Filterung).
  const buildFaceDefs = (skip) => {
    const fds = [];
    for (const group of normalGroups) {
      if (skip && skip.has(group)) continue;
      for (const fd of extractGroupFaces(group)) { fd.group = group; fds.push(fd); }
    }
    return fds;
  };
  // Aktuelle Flächenliste; runPipeline() (unten) baut sie je Fallback-Stufe neu auf. v1/v2/v2b
  // lesen und ersetzen sie über diese Variable.
  let faceDefs = [];

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
  // muss gelöst werden, sonst Plan verwerfen (facettiert): `restore(plan)` gibt dann die
  // herausgenommenen Wandflächen der Bohrung an faceDefs zurück.
  const CHAMFER_MAX = 3.0, CHAMFER_MIN = 0.04;
  let finalPlans = [];
  let chamferZones = [];
  // Gruppen, deren Facetten eine Chamfer-Zone verdrängt hat (filterChamferZones) —
  // Beweismaterial für den Orientierungs-Wächter der Kegel-Flächen (assemble).
  let chamferDroppedGroups = new Set();
  const matchBorePlans = (tentative, restore) => {
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
      if (!okAll) { restore(plan); continue; }
      plan.coneRims = [];
      for (const m of matched) {
        if (m.mode === 'direct') { m.inner.circleRim = m.rim; continue; }
        const flatDesc = mkCircleDesc(m.circ.center, m.circ.radius, m.rim.axis);
        m.inner.circleRim = flatDesc;                                   // flache Fläche nutzt äußeren Kreis R2@z2
        const coneAxis = m.dz >= 0 ? m.rim.axis : [-m.rim.axis[0], -m.rim.axis[1], -m.rim.axis[2]];
        const semiAngle = Math.atan2(Math.abs(m.circ.radius - m.rim.radius), Math.abs(m.dz));
        const zone = { axis: m.rim.axis, ap: m.rim.center, R: m.rim.radius, R2: m.circ.radius, zLo: Math.min(0, m.dz), zHi: Math.max(0, m.dz) };
        plan.coneRims.push({ rimDesc: m.rim, flatDesc, coneAxis, semiAngle, zone });
        chamferZones.push(zone);
      }
      finalPlans.push(plan);
    }
  };

  // Fillet-Facetten entfernen: faceDefs, deren Loops KOMPLETT in einer Chamfer-Zone liegen (zwischen
  // Rand-Kreis R@z1 und Flach-Kreis R2@z2), entfallen — ihre Geometrie übernimmt der Kegel.
  const filterChamferZones = () => {
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
        if (!allV.every(inZone)) return true;
        if (fd.group) chamferDroppedGroups.add(fd.group);               // Original-Facetten für den Wächter
        return false;
      });
    }
  };

  // ---- Gebogene Kanäle (tube-sweep.js): Rohr-Pläne analog zu den Bohrungs-Plänen ----
  // detectTubes (Worker/Pipeline) hat die Kanal-Gruppen mit group.tube = spec getaggt (Biarc-Bahn,
  // Profilkreis, Mündungskurven). Pro Kanal müssen BEIDE Mündungen als Innen-Loop einer ebenen
  // Fläche gefunden werden → diese Loops werden zur analytischen Mündungskurve (circleRim-Mechanik
  // wie bei Bohrungen), die Kanal-Facetten entfallen, assemble() emittiert die Flächenkette.
  // Scheitert das Matching → Kanal bleibt facettiert; öffnet die Kette die Hülle → globaler Fallback.
  // Gruppierung über spec.id (Objekt-Identität geht an der Worker-Grenze verloren).
  // (Aufruf in runPipeline() unten — arbeitet auf der jeweils aktuellen faceDefs-Liste.)
  let tubePlans = [];
  const planTubes = () => {
    tubePlans = [];
    const byId = new Map();
    for (const g of normalGroups) {
      const sp = g.tube;
      if (!sp || !Array.isArray(sp.pieces) || !Array.isArray(sp.curves)) continue;
      let e = byId.get(sp.id);
      if (!e) { e = { spec: sp, groups: new Set() }; byId.set(sp.id, e); }
      e.groups.add(g);
    }
    const boreGroups = new Set();
    for (const pl of finalPlans) for (const g of pl.groups) boreGroups.add(g);
    for (const e of byId.values()) {
      if ([...e.groups].some((g) => boreGroups.has(g))) continue;
      const rest = faceDefs.filter((fd) => !e.groups.has(fd.group));
      let hits = null;
      try { hits = matchTubeMouths(e.spec, rest, (inner) => !!inner.circleRim); } catch (_) { hits = null; }
      if (!hits) continue;
      for (const h of hits) h.inner.circleRim = { ...e.spec.curves[h.curveIndex], rimKey: `tube${e.spec.id}:${h.curveIndex}` };
      tubePlans.push(e);
      faceDefs = rest;
    }
  };

  // ---- Body-Defeaturing: Gerade-Kanten-Verrundungen → scharfe Kante ----
  // Erkannte Teil-Zylinder-Fillets (kind='fillet') zwischen genau ZWEI Ebenen werden entfernt:
  // die Fillet-Facetten entfallen, die Rand-Vertices beider Nachbar-Ebenen wandern auf deren
  // SCHNITTLINIE (= die scharfe Kante, die der Konstrukteur verrundet hat), End-Kappen-Bögen
  // kollabieren auf den Eckpunkt. Vertex-Vereinheitlichung entlang der Linie (Union beider
  // Seiten, snap-merge) verhindert T-Junctions. Konservative Guards überall — jede Unsauberkeit
  // landet im Wasserdicht-Verdikt und der globale Fallback baut komplett facettiert neu.
  let filletsDefeatured = 0;
  const defeatureFillets = () => {
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
  };

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
  // (Aufruf in runPipeline() unten.)
  let bandsDefeatured = 0;
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
    // Erst ALLE Kandidaten (Ebene P, Loop L) bewerten, dann den mit den MEISTEN anliegenden Wänden
    // anwenden und neu bewerten. Die echte Deckfläche einer Extrusion grenzt an jede Profilwand;
    // eine Seitenwand, die zufällig auch von einem Band umschlossen ist (Rundrechteck-Profile mit
    // Eckradius ≈ Deck-Rundung), nur an Deck/Boden/Stirn. Die frühere gierige Reihenfolge nach
    // Punktzahl nahm bei in Z unterteilten Wänden die Seitenwand zuerst → falsche, nur teilweise
    // entrundete Geometrie (Härtetest w1–w3, wasserdicht und daher vom Verdikt nicht erkannt).
    // Umsetzung in Runden: alle Kandidaten bewerten, nach Wandanzahl absteigend anwenden; ein
    // Kandidat wird nur dann neu bewertet, wenn eine zuvor angewendete Änderung seine Flächen
    // (P, Band, Wände) berührt hat. Eine weitere Runde fängt Kandidaten, die erst durch andere
    // möglich wurden. (Vorher: nach JEDER Anwendung alles neu bewerten — eBike ~1 s langsamer.)
    let done = 0;
    for (let round = 0; round < 16; round++) {
      const cands = [];
      for (let pi = 0; pi < fds.length; pi++) {
        if (removed.has(pi)) continue;
        for (const L of loopsOf(fds[pi])) { const plan = evaluateBand(pi, L); if (plan) cands.push({ pi, L, plan }); }
      }
      if (!cands.length) break;
      cands.sort((a, b) => b.plan.walls.size - a.plan.walls.size);
      const touched = new Set();
      const hit = (set) => { for (const fi of set) if (touched.has(fi)) return true; return false; };
      let applied = 0;
      for (const c of cands) {
        if (removed.has(c.pi)) continue;
        let plan = c.plan;
        if (touched.has(c.pi) || hit(plan.band) || hit(plan.walls)) {
          plan = evaluateBand(c.pi, c.L);                  // Umgebung hat sich geändert → neu bewerten
          if (!plan) continue;
        }
        applyBand(plan);
        buildOwners();
        done++; applied++;
        touched.add(c.pi);
        for (const fi of plan.band) touched.add(fi);
        for (const fi of plan.walls) touched.add(fi);
      }
      if (!applied) break;
    }
    if (removed.size) faceDefs = faceDefs.filter((_, i) => !removed.has(i));
    return done;

    function evaluateBand(pi, L) {
      const P = fds[pi], d = nrm[pi];
      if (Math.hypot(d[0], d[1], d[2]) < 0.5) return null;
      // Ebenen-Offset von P (Mittel über die Loop-Punkte)
      let off = 0, cnt = 0;
      for (const p of P.outer) { off += _dot3(d, p); cnt++; }
      off /= cnt;
      {
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
        if (!ok || !seeds.size) return null;
        // Größenschranke: ein Verrundungsband ist schmal und umgibt eine größere Fläche. Ohne
        // Schranke wuchs auf feinen Kugeln von JEDEM Flächenstück ein riesiges Band (50k-Kugel:
        // 9 s → 50 s, O(n²)). Ringförmige Deckflächen (schmaler Kragen) bekommen Spielraum (3×).
        const BAND_AREA_MAX = 3 * fdArea(pi);
        let bandArea = 0;
        for (const fi of seeds) bandArea += fdArea(fi);
        if (bandArea > BAND_AREA_MAX) return null;
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
        if (!ok || !wallEdges.length) return null;
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
        if (!ok || !wallEdges.length) return null;
        // (3) Gekrümmt? Winkel der Band-Normalen zu P müssen deutlich streuen
        let angMin = 90, angMax = 0;
        for (const fi of band) {
          const ang = Math.acos(Math.min(1, Math.abs(_dot3(nrm[fi], d)))) * 180 / Math.PI;
          if (ang < angMin) angMin = ang; if (ang > angMax) angMax = ang;
        }
        if (angMax - angMin < MIN_SPREAD_DEG) return null;
        // (4) Wand-Bandkante muss genau EIN geschlossener Ring sein
        const rings = chainEdges(wallEdges);
        if (rings.length !== 1 || rings[0].length < 3) return null;
        const ring = rings[0];
        // (5) Projektion auf P (entlang d — bleibt auf jeder Wand, da Wände d enthalten)
        const proj = new Map();       // vtxKey(alt) → neuer Punkt
        const newLoop = [];
        let hLo = Infinity, hHi = -Infinity;
        for (const p of ring) {
          const h = _dot3(d, p) - off;
          if (Math.abs(h) < hLo) hLo = Math.abs(h); if (Math.abs(h) > hHi) hHi = Math.abs(h);
          if (Math.abs(h) < 1e-6 || Math.abs(h) > RMAX) { ok = false; break; }
          const q = [p[0] - d[0] * h, p[1] - d[1] * h, p[2] - d[2] * h];
          proj.set(vtxKey(p), q);
          if (!newLoop.length || vtxKey(newLoop[newLoop.length - 1]) !== vtxKey(q)) newLoop.push(q);
        }
        if (!ok) return null;
        // Gleichmäßige Bandtiefe: bei einer echten Deckfläche liegt die ganze Bandkante auf EINER
        // Höhe über P (= Verrundungsradius). Schwankt sie (Deck-Rundung vs. Eckradius), ist P eine
        // Seitenwand, um die zufällig auch ein Band läuft → nicht diese Fläche entrunden.
        if (hHi - hLo > Math.max(0.01, 0.02 * hHi)) return null;
        if (newLoop.length > 1 && vtxKey(newLoop[0]) === vtxKey(newLoop[newLoop.length - 1])) newLoop.pop();
        if (newLoop.length < 3) return null;
        // Nur Wände und Band dürfen die verschobenen Punkte benutzen (sonst Riss/T-Junction)
        for (let fi = 0; fi < fds.length && ok; fi++) {
          if (band.has(fi) || walls.has(fi) || removed.has(fi)) continue;
          for (const Lx of [fds[fi].outer, ...fds[fi].inner]) {
            for (const p of Lx) if (proj.has(vtxKey(p))) { ok = false; break; }
            if (!ok) break;
          }
        }
        if (!ok) return null;
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
        if (!ok) return null;
        return { L, newLoop, walls, band, proj };
      }
    }

    // (7) Anwenden: P bekommt die Wandkontur, Wände werden bis P verlängert, Band entfällt
    function applyBand({ L, newLoop, walls, band, proj }) {
      L.length = 0; L.push(...newLoop);
      for (const wi of walls) {
        const W = fds[wi];
        for (const Lw of [W.outer, ...W.inner]) {
          for (let i = 0; i < Lw.length; i++) { const q = proj.get(vtxKey(Lw[i])); if (q) Lw[i] = q; }
        }
      }
      for (const fi of band) removed.add(fi);
    }
  }

  // ---- Body-Defeaturing v2b: Profil-Eckrundungen (senkrechte Kanten) bei Extrusionsteilen ----
  // Nach v2 ist die Kontur einer Deckfläche P exakt der Wandquerschnitt. Verrundete senkrechte
  // Kanten erscheinen dort als Bogenlauf (viele kleine gleichsinnige Knicke) zwischen zwei langen
  // geraden Wänden A und B. Schärfen = Bogen durch den Schnittpunkt C der verlängerten Wände
  // ersetzen. Weil die Wände ⊥ P stehen, gehört zu jeder 2D-Position im Profil eine senkrechte
  // Kante: die Ersetzung gilt auf ALLEN Deckflächen (oben und unten) gleichzeitig, die Bogen-
  // Wandstreifen entfallen, A und B werden bis zur neuen Ecke verlängert. Vollkreise (Löcher)
  // haben keine geraden Nachbarn, Bögen zwischen parallelen Wänden (Langloch-Enden) keinen
  // Schnittpunkt — beide bleiben. Läuft ein Bogen ohne Tangente in eine Ecke (Bogenradius größer
  // als die Nachbarkante), wird der kurze Bogenabschnitt bis zur Ecke mitgenommen.
  // (Aufruf in runPipeline() unten.)
  let cornersDefeatured = 0;
  function defeatureProfileCorners() {
    const WALL_COS = 1e-3, PARALLEL_COS = 0.9999;
    const ARC_MIN_DEG = 0.3, ARC_MAX_DEG = 35;
    const MIN_LINE_SIN = Math.sin(10 * Math.PI / 180);
    let done = 0;
    for (let guard = 0; guard < 500; guard++) {
      const plan = findCorner();
      if (!plan) break;
      applyCorner(plan);
      done++;
    }
    return done;

    function findCorner() {
      const fds = faceDefs;
      const nrm = fds.map((fd) => _norm3(fd.normal));
      const edgeOwners = new Map();
      fds.forEach((fd, fi) => {
        for (const L of [fd.outer, ...fd.inner]) {
          if (L.circleRim) continue;
          for (let i = 0; i < L.length; i++) {
            const k = edgeKeyFn(L[i], L[(i + 1) % L.length]);
            let o = edgeOwners.get(k); if (!o) { o = []; edgeOwners.set(k, o); }
            o.push(fi);
          }
        }
      });
      for (let pi = 0; pi < fds.length; pi++) {
        const P = fds[pi], d = nrm[pi];
        const u = computeRefDir(d), v = _norm3(_cross3(d, u));
        const to2 = (p) => [_dot3(p, u), _dot3(p, v)];
        const key2 = (q) => `${fixZero(q[0], 4)},${fixZero(q[1], 4)}`;
        for (const L of [P.outer, ...P.inner]) {
          if (L.circleRim || L.length < 6) continue;
          // Alle Kanten des Loops müssen an Wände ⊥ P grenzen (scharfe Kontur nach v2)
          const owner = [];
          let ok = true;
          for (let i = 0; i < L.length; i++) {
            const os = (edgeOwners.get(edgeKeyFn(L[i], L[(i + 1) % L.length])) || []).filter((fi) => fi !== pi);
            if (os.length !== 1 || Math.abs(_dot3(nrm[os[0]], d)) > WALL_COS) { ok = false; break; }
            owner.push(os[0]);
          }
          if (!ok) continue;
          const n = L.length;
          const q = L.map(to2);
          const len = [], dir = [];
          for (let i = 0; i < n; i++) {
            const a = q[i], b = q[(i + 1) % n];
            const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
            len.push(l); dir.push(l > 0 ? [(b[0] - a[0]) / l, (b[1] - a[1]) / l] : [0, 0]);
          }
          // Knick am Punkt i (zwischen Kante i-1 und Kante i), vorzeichenbehaftet in Grad
          const turn = [];
          for (let i = 0; i < n; i++) {
            const a = dir[(i - 1 + n) % n], b = dir[i];
            turn.push(Math.atan2(a[0] * b[1] - a[1] * b[0], a[0] * b[0] + a[1] * b[1]) * 180 / Math.PI);
          }
          const isArc = (i) => Math.abs(turn[i]) >= ARC_MIN_DEG && Math.abs(turn[i]) <= ARC_MAX_DEG;
          // Vollkreis (Loch): keine Kante ist deutlich länger als die übrigen → kein gerader Nachbar
          const sortedLen = len.slice().sort((x, y) => x - y);
          let iLong = 0; for (let i = 1; i < n; i++) if (len[i] > len[iLong]) iLong = i;
          if (len[iLong] < 3 * sortedLen[Math.floor(n / 2)]) continue;
          // Durchlauf beginnt hinter der längsten Kante (= sicher an einer Lauf-Grenze). Ein Lauf
          // endet an jeder LANGEN Kante: zwischen zwei Eckrundungen liegt oft ein gerades Stück,
          // an das beide Bögen tangential anschließen (kleine Knicke an beiden Enden) — ohne diese
          // Grenze wuchsen beim eBike zwei Rundungen samt Geraden zu einem „Bogen“ zusammen.
          const s0 = (iLong + 1) % n;
          for (let k = 0; k < n; ) {
            const i0 = (s0 + k) % n;
            if (!isArc(i0)) { k++; continue; }
            const sg = Math.sign(turn[i0]);
            let e = i0, cnt = 1;
            const ch = [];
            while (k + cnt < n && isArc((e + 1) % n) && Math.sign(turn[(e + 1) % n]) === sg) {
              if (ch.length) { const srt = ch.slice().sort((x, y) => x - y); if (len[e] > 2.5 * srt[srt.length >> 1]) break; }
              ch.push(len[e]); e = (e + 1) % n; cnt++;
            }
            k += cnt;
            if (cnt < 2) continue;
            const chords = [];
            for (let c = 0, i = i0; c < cnt - 1; c++, i = (i + 1) % n) chords.push(len[i]);
            chords.sort((x, y) => x - y);
            const Lc = chords[Math.floor(chords.length / 2)];
            // Kurze Bogenkanten an den Enden mitnehmen (Bogen läuft ohne Tangente in eine Ecke)
            let j = i0, m = e, ext = 0;
            while (ext < 3 && len[(j - 1 + n) % n] <= 1.5 * Lc) { j = (j - 1 + n) % n; ext++; }
            ext = 0;
            while (ext < 3 && len[m] <= 1.5 * Lc) { m = (m + 1) % n; ext++; }
            const ia = (j - 1 + n) % n, ib = m;                // Kante A (endet in q[j]), Kante B (beginnt in q[m])
            if (len[ia] < 3 * Lc || len[ib] < 3 * Lc) continue;
            const dA = dir[ia], dB = dir[ib];
            const cr = dA[0] * dB[1] - dA[1] * dB[0];
            const dotAB = dA[0] * dB[0] + dA[1] * dB[1];
            let pathLen = 0; for (let i = j; i !== m; i = (i + 1) % n) pathLen += len[i];
            // Neue 2D-Lage der beiden Nahtpunkte q[j] (Ende A) und q[m] (Anfang B); null = bleibt.
            let newA = null, newB = null, mode;
            if (Math.abs(cr) >= MIN_LINE_SIN) {
              // Fall „cross“: A und B schneiden sich → Bogen kollabiert auf den Schnittpunkt C
              const wx = q[m][0] - q[j][0], wy = q[m][1] - q[j][1];
              const t = (wx * dB[1] - wy * dB[0]) / cr;   // q[j] + t·dA = q[m] + s·dB
              const s = (wx * dA[1] - wy * dA[0]) / cr;
              if (t < -1e-6 || s > 1e-6) continue;        // C muss A nach vorn und B nach hinten verlängern
              if (t > 2 * pathLen + 1e-6 || -s > 2 * pathLen + 1e-6) continue; // Plausibilität
              newA = newB = [q[j][0] + t * dA[0], q[j][1] + t * dA[1]];
              mode = 'cross';
            } else if (dotAB < -0.98) {
              // A ∥ B gegenläufig: die Rundung (Radius größer als die Kante) hat eine ganze Kante E
              // ersetzt und endet auf einer Seite mit einer ECKE statt tangential. E ist eindeutig:
              // sie beginnt an dieser Ecke und steht senkrecht auf A und B (eBike-Laschen: Ecke
              // (5,35) → Lotfußpunkt (0,35), exakt wie in der Referenz „ohne rundungen“).
              // Beidseitig tangential = Halbkreis (Langloch-Ende) → Konstruktion, bleibt.
              const tanA = Math.abs(turn[j]) <= ARC_MAX_DEG, tanB = Math.abs(turn[m]) <= ARC_MAX_DEG;
              if (!tanA && tanB) {
                const s = (q[j][0] - q[m][0]) * dB[0] + (q[j][1] - q[m][1]) * dB[1];
                if (s > 1e-6 || -s > 2 * pathLen + 1e-6) continue;
                newB = [q[m][0] + s * dB[0], q[m][1] + s * dB[1]];
                mode = 'endA';
              } else if (tanA && !tanB) {
                const t = (q[m][0] - q[j][0]) * dA[0] + (q[m][1] - q[j][1]) * dA[1];
                if (t < -1e-6 || t > 2 * pathLen + 1e-6) continue;
                newA = [q[j][0] + t * dA[0], q[j][1] + t * dA[1]];
                mode = 'endB';
              } else continue;
            } else continue;
            // Betroffene 2D-Positionen (q[j] … q[m])
            const K = new Set();
            for (let i = j; ; i = (i + 1) % n) { K.add(key2(q[i])); if (i === m) break; }
            const kA = key2(q[j]), kB = key2(q[m]);
            const lift = (c2, h) => [u[0] * c2[0] + v[0] * c2[1] + d[0] * h, u[1] * c2[0] + v[1] * c2[1] + d[1] * h, u[2] * c2[0] + v[2] * c2[1] + d[2] * h];
            const removeSet = new Set(), moves = [], capEdits = [];
            for (let fi = 0; fi < fds.length && ok; fi++) {
              const fd = fds[fi];
              const loops = [fd.outer, ...fd.inner];
              let any = false, all = true, onlySeam = true;
              for (const Lx of loops) for (const p of Lx) {
                const kk = key2(to2(p));
                if (K.has(kk)) { any = true; if (kk !== kA && kk !== kB) onlySeam = false; } else all = false;
              }
              if (!any) continue;
              const c = Math.abs(_dot3(nrm[fi], d));
              if (c <= WALL_COS) {
                if (all) { if (fd.inner.length) { ok = false; break; } removeSet.add(fi); } // Bogenstreifen (ohne Löcher)
                else if (onlySeam) moves.push(fi);
                else { ok = false; break; }
              } else if (c >= PARALLEL_COS) {
                // Deckfläche: Punkte in K bilden je Loop EINEN zusammenhängenden Lauf → ersetzen
                for (const Lx of loops) {
                  if (Lx.circleRim) { if (Lx.some((p) => K.has(key2(to2(p))))) ok = false; continue; }
                  const inK = Lx.map((p) => K.has(key2(to2(p))));
                  const cntK = inK.filter(Boolean).length;
                  if (!cntK) continue;
                  if (cntK === Lx.length) { ok = false; break; }
                  let st = 0; while (!(inK[st] && !inK[(st - 1 + Lx.length) % Lx.length])) { st++; if (st >= Lx.length) { ok = false; break; } }
                  if (!ok) break;
                  for (let r = 0; r < cntK; r++) if (!inK[(st + r) % Lx.length]) { ok = false; break; }
                  if (!ok) break;
                  const first = Lx[st], last = Lx[(st + cntK - 1) % Lx.length];
                  const fk = key2(to2(first)), lk = key2(to2(last));
                  if (!((fk === kA && lk === kB) || (fk === kB && lk === kA))) { ok = false; break; }
                  let h = 0; for (let r = 0; r < cntK; r++) h += _dot3(d, Lx[(st + r) % Lx.length]); h /= cntK;
                  // Ersatz in Laufrichtung: A-Seite, B-Seite (bleibende Punkte als Original-Objekt)
                  const repA = newA ? lift(newA, h) : (fk === kA ? first : last);
                  const repB = newB ? lift(newB, h) : (fk === kB ? first : last);
                  const rep = mode === 'cross' ? [repA] : (fk === kA ? [repA, repB] : [repB, repA]);
                  const out = [];
                  for (let r = 0; r < Lx.length; r++) {
                    const idx = (st + r) % Lx.length;
                    if (r === 0) out.push(...rep);
                    else if (!inK[idx]) out.push(Lx[idx]);
                  }
                  if (out.length < 3) { ok = false; break; }
                  // einfach geblieben? (2D-Schnitttest der neuen Kontur)
                  const o2 = out.map(to2), no = o2.length;
                  const ori = (a, b, c2) => (b[0] - a[0]) * (c2[1] - a[1]) - (b[1] - a[1]) * (c2[0] - a[0]);
                  for (let a = 0; a < no && ok; a++) for (let b = a + 2; b < no; b++) {
                    if (a === 0 && b === no - 1) continue;
                    const p1 = o2[a], p2 = o2[(a + 1) % no], p3 = o2[b], p4 = o2[(b + 1) % no];
                    const d1 = ori(p3, p4, p1), d2 = ori(p3, p4, p2), d3 = ori(p1, p2, p3), d4 = ori(p1, p2, p4);
                    if (((d1 > 1e-12 && d2 < -1e-12) || (d1 < -1e-12 && d2 > 1e-12)) && ((d3 > 1e-12 && d4 < -1e-12) || (d3 < -1e-12 && d4 > 1e-12))) { ok = false; break; }
                  }
                  if (!ok) break;
                  capEdits.push({ loop: Lx, out, h, repA, repB });
                }
              } else { ok = false; break; }
            }
            if (!ok) { ok = true; continue; }
            if (!removeSet.size || !capEdits.length) continue;
            // Fälle endA/endB: neue Wand E für die wiederhergestellte Kante. Ihre senkrechten
            // Kanten müssen ALLE Höhenpunkte der Nachbarwände an den Nahtstellen enthalten
            // (sonst T-Stoß). E's Außennormale = Laufrichtung × d (Material liegt links der Kontur).
            let newWall = null;
            if (mode !== 'cross') {
              const ptsA = new Map(), ptsB = new Map();   // Höhe (gerundet) → Punkt nach dem Umbau
              const addPt = (mp, p) => mp.set(_dot3(d, p).toFixed(5), p);
              for (const ce of capEdits) { addPt(ptsA, ce.repA); addPt(ptsB, ce.repB); }
              for (const fi of moves) for (const Lx of [fds[fi].outer, ...fds[fi].inner]) for (const p of Lx) {
                const kk = key2(to2(p));
                if (kk === kA) addPt(ptsA, newA ? lift(newA, _dot3(d, p)) : p);
                else if (kk === kB) addPt(ptsB, newB ? lift(newB, _dot3(d, p)) : p);
              }
              const byH = (mp) => [...mp.values()].sort((a, b) => _dot3(d, a) - _dot3(d, b));
              const colA = byH(ptsA), colB = byH(ptsB);
              if (colA.length < 2 || colB.length < 2) continue;
              // Umlauf: A unten → B unten → B hoch → A oben → A runter
              const loopE = [colA[0], ...colB, ...colA.slice(1).reverse()];
              const a2 = to2(colA[0]), b2 = to2(colB[0]);
              const tE = _norm3([u[0] * (b2[0] - a2[0]) + v[0] * (b2[1] - a2[1]), u[1] * (b2[0] - a2[0]) + v[1] * (b2[1] - a2[1]), u[2] * (b2[0] - a2[0]) + v[2] * (b2[1] - a2[1])]);
              const nE = _norm3(_cross3(tE, d));
              let nx = 0, ny = 0, nz = 0;
              for (let i = 0; i < loopE.length; i++) { const c3 = _cross3(loopE[i], loopE[(i + 1) % loopE.length]); nx += c3[0]; ny += c3[1]; nz += c3[2]; }
              if (nx * nE[0] + ny * nE[1] + nz * nE[2] < 0) loopE.reverse();
              let cx = 0, cy = 0, cz = 0; for (const p of loopE) { cx += p[0]; cy += p[1]; cz += p[2]; }
              newWall = { outer: loopE, inner: [], normal: nE, centroid: [cx / loopE.length, cy / loopE.length, cz / loopE.length], group: null };
            }
            return { removeSet, moves, capEdits, newA, newB, kA, kB, to2, key2, lift, d, newWall };
          }
        }
      }
      return null;
    }

    function applyCorner(plan) {
      const { removeSet, moves, capEdits, newA, newB, kA, kB, to2, key2, lift, d, newWall } = plan;
      for (const { loop, out } of capEdits) { loop.length = 0; loop.push(...out); }
      for (const fi of moves) {
        const fd = faceDefs[fi];
        for (const Lx of [fd.outer, ...fd.inner]) {
          for (let i = 0; i < Lx.length; i++) {
            const kk = key2(to2(Lx[i]));
            if (kk === kA && newA) Lx[i] = lift(newA, _dot3(d, Lx[i]));
            else if (kk === kB && newB) Lx[i] = lift(newB, _dot3(d, Lx[i]));
          }
        }
      }
      faceDefs = faceDefs.filter((_, i) => !removeSet.has(i));
      if (newWall) faceDefs.push(newWall);
    }
  }

  // ---- Scharfe Bohrungen NACH dem Defeaturing (nur mit Toggle) ----
  // Hat v2 die Mündungs-Verrundungen einer Bohrung geschärft, ist die Lochwand ein sauberer
  // Facetten-Mantel von Deckfläche zu Deckfläche, dessen zwei Rand-Loops EXAKT die Innen-Loops der
  // Deckflächen sind (v2 baut beide aus denselben projizierten Punkten). Dann ersetzt EINE
  // CYLINDRICAL_SURFACE die Wand und je eine volle Kreiskante die beiden Innen-Loops: scharfe
  // Mündung, keine Kegel-Fase. Gilt genauso für von Haus aus scharfe Bohrungen (block_with_hole).
  // Die Zuordnung ist topologisch (gemeinsame Kanten-Schlüssel, keine Toleranz-Suche) → die Hülle
  // bleibt geschlossen. Achse, Zentren und Radius kommen aus den Rand-Loops (Kreis-Fit in der
  // Deckebene), NICHT aus dem Primitiv: dessen Kern enthält an verrundeten Mündungen zusätzlich
  // leicht geneigte Verrundungsfacetten (eBike: R 2.51 statt 2.50, Höhe zu kurz). Das Primitiv
  // bestimmt nur, welche Flächen zur Lochwand gehören. Bohrungen, die hier nicht passen (Mündung
  // nicht geschärft, echte Fase, …), nimmt danach der bisherige Pfad (direkt/Fase).
  const SHARP_SEG_MAX_DEG = 45;     // Rand-Polygon: jede Kante überspannt ≤ 45° (≥ 8 Segmente)
  const SHARP_WALL_AXIS_COS = 0.02; // Wand-Normale ⟂ Achse (≤ ~1.1°)
  const loopEdgeCount = (L) => { let n = 0; for (let i = 0; i < L.length; i++) if (vtxKey(L[i]) !== vtxKey(L[(i + 1) % L.length])) n++; return n; };
  // Kreis-Fit (Kåsa, algebraisch) der Punkte in der Ebene ⟂ axis → { center, radius } | null
  const fitCircleInPlane = (pts, axis) => {
    const u = computeRefDir(axis), v = _norm3(_cross3(axis, u));
    let mx = 0, my = 0, mz = 0; for (const p of pts) { mx += p[0]; my += p[1]; mz += p[2]; }
    const m = [mx / pts.length, my / pts.length, mz / pts.length];
    let sxx = 0, sxy = 0, syy = 0, sxz = 0, syz = 0, sz = 0;
    for (const p of pts) {
      const w = _sub3(p, m), x = _dot3(w, u), y = _dot3(w, v), z = x * x + y * y;
      sxx += x * x; sxy += x * y; syy += y * y; sxz += x * z; syz += y * z; sz += z;
    }
    const det = sxx * syy - sxy * sxy;
    if (!(Math.abs(det) > 1e-18)) return null;
    const D = (-sxz * syy + syz * sxy) / det, E = (-syz * sxx + sxz * sxy) / det, F = -sz / pts.length;
    const cx = -D / 2, cy = -E / 2, r2 = cx * cx + cy * cy - F;
    if (!(r2 > 0)) return null;
    return { center: [m[0] + u[0] * cx + v[0] * cy, m[1] + u[1] * cx + v[1] * cy, m[2] + u[2] * cx + v[2] * cy], radius: Math.sqrt(r2) };
  };
  // Plan für EINE Bohrung → { plan, wall:Set<fi>, decks:[Loop, Loop] } | null
  const sharpBorePlan = (entry, owners, fdsOfGroup, taken) => {
    const W = new Set();
    for (const g of entry.groups) for (const fi of (fdsOfGroup.get(g) || [])) if (!taken.has(fi)) W.add(fi);
    if (W.size < 3) return null;
    // Rand der Wand: Kanten, die genau 1× in der Wand vorkommen — ihr Gegenüber ist genau EINE
    // Fläche außerhalb der Wand
    const cnt = new Map();
    for (const fi of W) {
      const fd = faceDefs[fi];
      for (const L of [fd.outer, ...fd.inner]) {
        if (L.circleRim) return null;
        for (let i = 0; i < L.length; i++) {
          const a = L[i], b = L[(i + 1) % L.length];
          if (vtxKey(a) === vtxKey(b)) continue;
          const k = edgeKeyFn(a, b);
          const e = cnt.get(k);
          if (e) e.n++; else cnt.set(k, { n: 1, v0: a, v1: b });
        }
      }
    }
    const rimEdges = [], otherOf = new Map();
    for (const [k, e] of cnt) {
      if (e.n > 2) return null;
      if (e.n === 2) continue;
      const others = (owners.get(k) || []).filter((o) => !W.has(o.fi));
      if (others.length !== 1 || taken.has(others[0].fi)) return null;
      rimEdges.push({ v0: e.v0, v1: e.v1 });
      otherOf.set(k, others[0]);
    }
    const rings = chainEdges(rimEdges);
    if (rings.length !== 2) return null;                       // Durchgangsloch: genau 2 Ränder
    // Jeder Rand = KOMPLETTER Innen-Loop genau einer Deckfläche
    const decks = [];
    for (const ring of rings) {
      let own = null;
      for (let i = 0; i < ring.length; i++) {
        const o = otherOf.get(edgeKeyFn(ring[i], ring[(i + 1) % ring.length]));
        if (!o || (own && (o.fi !== own.fi || o.loop !== own.loop))) return null;
        own = o;
      }
      const fd = faceDefs[own.fi];
      if (!fd.inner.includes(own.loop) || loopEdgeCount(own.loop) !== ring.length) return null;
      decks.push({ fi: own.fi, fd, loop: own.loop, ring });
    }
    if (decks[0].fi === decks[1].fi) return null;
    // Achse = Deck-Normale (beide Deckflächen parallel), orientiert von Rand 0 nach Rand 1
    const n0 = _norm3(decks[0].fd.normal), n1 = _norm3(decks[1].fd.normal);
    if (Math.abs(_dot3(n0, n1)) < 0.9999) return null;
    const f0 = fitCircleInPlane(decks[0].ring, n0), f1 = fitCircleInPlane(decks[1].ring, n0);
    if (!f0 || !f1) return null;
    const along = _dot3(_sub3(f1.center, f0.center), n0);
    const axis = along >= 0 ? n0 : [-n0[0], -n0[1], -n0[2]];
    const H = Math.abs(along);
    const R = (f0.radius + f1.radius) / 2;
    const tol = Math.max(0.01, 0.002 * R);
    if (Math.abs(f0.radius - f1.radius) > tol || !(H > tol)) return null;
    const c0 = f0.center;
    const c1 = [c0[0] + axis[0] * H, c0[1] + axis[1] * H, c0[2] + axis[2] * H];
    if (Math.hypot(f1.center[0] - c1[0], f1.center[1] - c1[1], f1.center[2] - c1[2]) > tol) return null; // koaxial
    const cyl = (p) => { const w = _sub3(p, c0), t = _dot3(w, axis); return { t, rho: Math.hypot(w[0] - axis[0] * t, w[1] - axis[1] * t, w[2] - axis[2] * t), w }; };
    // Ränder: eben (in ihrer Deckebene), auf dem Kreis, fein genug und einmal ganz um die Achse
    const ringAt = [0, H];
    for (let r = 0; r < 2; r++) {
      const ring = decks[r].ring;
      let turn = 0;
      for (let i = 0; i < ring.length; i++) {
        const a = cyl(ring[i]), b = cyl(ring[(i + 1) % ring.length]);
        if (Math.abs(a.t - ringAt[r]) > tol || Math.abs(a.rho - R) > tol) return null;
        const ra = _sub3(a.w, [axis[0] * a.t, axis[1] * a.t, axis[2] * a.t]);
        const rb = _sub3(b.w, [axis[0] * b.t, axis[1] * b.t, axis[2] * b.t]);
        const ang = Math.atan2(_dot3(_cross3(ra, rb), axis), _dot3(ra, rb));
        if (Math.abs(ang) > SHARP_SEG_MAX_DEG * Math.PI / 180) return null;
        turn += ang;
      }
      if (Math.abs(Math.abs(turn) - 2 * Math.PI) > 1e-3) return null;
    }
    // Wand: alle Punkte auf dem Mantel zwischen den Rändern, Normalen ⟂ Achse und zur Achse hin
    for (const fi of W) {
      const fd = faceDefs[fi];
      const n = _norm3(fd.normal);
      if (Math.abs(_dot3(n, axis)) > SHARP_WALL_AXIS_COS) return null;
      let cx = 0, cy = 0, cz = 0, np = 0;
      for (const L of [fd.outer, ...fd.inner]) {
        for (const p of L) {
          const q = cyl(p);
          if (Math.abs(q.rho - R) > tol || q.t < -tol || q.t > H + tol) return null;
          cx += p[0]; cy += p[1]; cz += p[2]; np++;
        }
      }
      const q = cyl([cx / np, cy / np, cz / np]);
      if (_dot3(n, _sub3(q.w, [axis[0] * q.t, axis[1] * q.t, axis[2] * q.t])) >= 0) return null; // konvex → keine Bohrung
    }
    const rim0 = mkCircleDesc(c0, R, axis), rim1 = mkCircleDesc(c1, R, axis);
    if (rim0.rimKey === rim1.rimKey) return null;
    return {
      plan: { prim: entry.prim, rims: [rim0, rim1], groups: entry.groups, surfCenter: rim0.center, coneRims: [] },
      wall: W, decks: [decks[0].loop, decks[1].loop],
    };
  };
  // Alle passenden Bohrungen umwandeln → Set der umgewandelten Einträge
  const convertSharpBores = () => {
    const done = new Set();
    if (!boreById.size) return done;
    const owners = new Map();       // Kante → [{ fi, loop }]
    const fdsOfGroup = new Map();   // Gruppe → [fi]
    faceDefs.forEach((fd, fi) => {
      if (fd.group) { let a = fdsOfGroup.get(fd.group); if (!a) { a = []; fdsOfGroup.set(fd.group, a); } a.push(fi); }
      for (const L of [fd.outer, ...fd.inner]) {
        if (L.circleRim) continue;
        for (let i = 0; i < L.length; i++) {
          const a = L[i], b = L[(i + 1) % L.length];
          if (vtxKey(a) === vtxKey(b)) continue;
          const k = edgeKeyFn(a, b);
          let o = owners.get(k); if (!o) { o = []; owners.set(k, o); }
          o.push({ fi, loop: L });
        }
      }
    });
    const drop = new Set();
    for (const entry of boreById.values()) {
      let res = null;
      try { res = sharpBorePlan(entry, owners, fdsOfGroup, drop); } catch (_) { res = null; }
      if (!res) continue;
      for (const fi of res.wall) drop.add(fi);
      res.decks[0].circleRim = res.plan.rims[0];
      res.decks[1].circleRim = res.plan.rims[1];
      finalPlans.push(res.plan);
      done.add(entry);
    }
    if (drop.size) faceDefs = faceDefs.filter((_, i) => !drop.has(i));
    return done;
  };

  // ---- Ablauf (re-entrant für die Fallback-Stufen) ----
  // withBores=false: ohne Bohrungs-Umwandlung (Defeaturing bleibt). Setzt faceDefs, finalPlans,
  // chamferZones und die Defeaturing-Zähler.
  // withBores=false (Fallback-Stufe 1): ohne analytische Bohrungen UND Kanäle neu bauen.
  const runPipeline = (withBores) => {
    finalPlans = []; chamferZones = []; tubePlans = []; chamferDroppedGroups = new Set();
    filletsDefeatured = 0; bandsDefeatured = 0; cornersDefeatured = 0;
    if (!DEFEATURE) {
      // Toggle AUS — bisheriger Ablauf unverändert: Bohrungs-Pläne aus den Original-Dreiecken,
      // Bohrungs-Gruppen vorerst überspringen, nur Direkt-Treffer; gescheiterte Pläne bekommen
      // frische Facetten.
      const tentative = [];
      const boreSkip = new Set();
      if (withBores) {
        for (const entry of boreById.values()) {
          let plan = null;
          try { plan = attemptBore(entry); } catch (_) { plan = null; }
          if (plan) { tentative.push(plan); for (const g of plan.groups) boreSkip.add(g); }
        }
      }
      faceDefs = buildFaceDefs(boreSkip);
      matchBorePlans(tentative, (plan) => { for (const g of plan.groups) for (const fd of extractGroupFaces(g)) { fd.group = g; faceDefs.push(fd); } });
      if (withBores) planTubes();
      return;
    }
    // Toggle AN — ERST entrunden (v1, v2, v2b), DANN Bohrungen. Die Bohrungs-Gruppen bleiben dafür
    // in faceDefs: v2 braucht die Lochwand als „Wand“ des Mündungsbandes. Früher liefen die
    // Bohrungs-Pläne zuerst → verrundete Mündungen bekamen eine Kegel-Fase statt einer scharfen Kante
    // bzw. blieben facettiert, wenn der Rand-Abgleich scheiterte (eBike).
    faceDefs = buildFaceDefs(null);
    // Kanäle VOR dem Entrunden: ihre Mündungen liegen (bisher) auf ebenen Flächen und werden über
    // circleRim aus v2 herausgehalten; die vielen Kanal-Facetten müssen v1/v2/v2b nicht mehr prüfen.
    // (Kanäle mit verrundeter Mündung bleiben facettiert — matchTubeMouths findet dann keinen Rand.)
    if (withBores) planTubes();
    defeatureFillets();
    try {
      bandsDefeatured = defeatureBands();
    } catch (_) { bandsDefeatured = 0; /* Guard: Änderungen werden erst nach allen Prüfungen angewandt */ }
    if (bandsDefeatured > 0) {
      try {
        cornersDefeatured = defeatureProfileCorners();
      } catch (_) { cornersDefeatured = 0; /* Guard: jede Ecke wird erst nach allen Prüfungen angewandt */ }
    }
    if (!withBores) return;
    const sharp = convertSharpBores();
    // Übrige Bohrungen: bisheriger Pfad (Ränder aus den Original-Dreiecken; direkt oder Fase →
    // Kegel). Bleibt für Mündungen, die v2 NICHT schärfen konnte (echte Fase, Mündung auf einer
    // Fläche ohne senkrechte Wand, …). Wandflächen herausnehmen; scheitert der Plan, kommen genau
    // diese (evtl. von v1/v2 angepassten) Flächen zurück.
    const tentative = [];
    const saved = new Map();
    for (const entry of boreById.values()) {
      if (sharp.has(entry)) continue;
      let plan = null;
      try { plan = attemptBore(entry); } catch (_) { plan = null; }
      if (!plan) continue;
      const gs = new Set(plan.groups);
      saved.set(plan, faceDefs.filter((fd) => gs.has(fd.group)));
      faceDefs = faceDefs.filter((fd) => !gs.has(fd.group));
      tentative.push(plan);
    }
    if (!tentative.length) return;
    matchBorePlans(tentative, (plan) => { faceDefs.push(...saved.get(plan)); });
    filterChamferZones();
  };

  // ---- Step 2: Shared vertex + edge registry ----
  const ptRegistry = new Map(); // key → { ptId, vtxId }
  // Gleiche Naht-Normalisierung wie vtxKey (siehe oben): -0.0/+0.0 vereinheitlichen,
  // damit Naht-Vertices in der STEP-Topologie denselben CARTESIAN_POINT teilen. Identische
  // Zeichenkette wie vtxKey (4 Nachkommastellen) — daher dessen Cache je Punkt nutzen (assemble
  // fragt jeden Punkt mehrfach ab; nach der Ebenheits-Zerlegung sind es deutlich mehr Kanten).
  const ptKey = (p) => vtxKey(p);

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
  const edgeRegistry = new Map(); // canonKey → { ecId, startKey }
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

  // key: kanonischer Kanten-Schlüssel; eine Falt-Kante (enforcePlanarity) bekommt einen eigenen
  // Schlüssel und damit eine eigene EDGE_CURVE zwischen denselben Ecken.
  const getOrCreateEdge = (p1, p2, key = edgeCanonKey(p1, p2)) => {
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
      // Bezug für die ORIENTED_EDGE-Richtung ist der TATSÄCHLICHE Start der EDGE_CURVE (p1 der
      // ersten Nutzung) — nicht der kleinere Punkt-Schlüssel. Früher stand hier min(k1,k2): ging
      // die erste Nutzung vom größeren zum kleineren Schlüssel, waren BEIDE Richtungs-Flags der
      // Kante vertauscht → Ränder in der STEP unterbrochen. Der Wasserdicht-Zähler sah das nicht
      // (weiter 1× vor/1× zurück), occt/Fusion sortieren still um, strikte Importer (CST/ACIS)
      // verlieren Flächen. Prüfung: tests/step-strict.mjs (loop-chain).
      edgeRegistry.set(key, { ecId, startKey: ptKey(p1) });
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
      // Geschlossene Kurve: CIRCLE (Standard), ELLIPSE (schräge Kanal-Mündung an Geradenstück) oder
      // B_SPLINE_CURVE_WITH_KNOTS (schräge Mündung an Bogenstück, aus tube-sweep.js). Ein Vertex.
      let circleId, vpt;
      if (geom.kind === 'bspline') {
        const cps = geom.ctrl.map((p) => addPoint(p));
        circleId = id++;
        entities.push(`#${circleId}=B_SPLINE_CURVE_WITH_KNOTS('',3,(${cps.map((c) => `#${c}`).join(',')}),.UNSPECIFIED.,.T.,.F.,(${geom.mults.join(',')}),(${geom.knots.map(toStep).join(',')}),.UNSPECIFIED.);`);
        vpt = geom.vertex;
      } else {
        const placId = addAxis2Placement3D(geom.center, geom.axis, geom.refDir);
        if (geom.kind === 'ellipse') {
          circleId = id++;
          entities.push(`#${circleId}=ELLIPSE('',#${placId},${toStep(geom.radius)},${toStep(geom.semi2)});`);
        } else circleId = addCircle(placId, geom.radius);
        vpt = [
          geom.center[0] + geom.radius * geom.refDir[0],
          geom.center[1] + geom.radius * geom.refDir[1],
          geom.center[2] + geom.radius * geom.refDir[2],
        ];
      }
      const v = getVertex(vpt);
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
  // fold (optional, aus enforcePlanarity): { id, keys } — Kanten zwischen Teilflächen einer
  // zerlegten Fläche, die im Netz non-manifold sind, laufen über eine eigene Kanten-Instanz.
  const buildLoopEdges = (points, fold) => {
    const oeIds = [];
    const n = points.length;
    for (let i = 0; i < n; i++) {
      const p1 = points[i], p2 = points[(i + 1) % n];
      if (ptKey(p1) === ptKey(p2)) continue; // skip degenerate
      let ck = edgeCanonKey(p1, p2);
      if (fold && fold.keys.has(ck)) ck += `#fold${fold.id}`;
      const edge = getOrCreateEdge(p1, p2, ck);
      const forward = ptKey(p1) === edge.startKey;
      const u = edgeUse.get(ck) || { fwd: 0, rev: 0 };
      if (forward) u.fwd++; else u.rev++;
      edgeUse.set(ck, u);
      oeIds.push(addOrientedEdge(edge.ecId, forward));
    }
    return oeIds;
  };

  // ---- Orientierungs-Wächter (lokal, billig) ----
  // Der Wasserdicht-Zähler prüft nur die Kanten-Bilanz (je Kante 1× vor, 1× zurück). Zwei Fehler
  // einer analytischen Fläche lassen diese Bilanz ausgeglichen:
  //   (a) same_sense verdreht — Innen und Außen der Fläche vertauscht;
  //   (b) eine Rand-Kurve KONSISTENT verdreht (beide Nutzungen) — die Fläche liegt dann rechts vom
  //       Rand: occt wählt still das Komplementär-Band (+8.8 % Volumen im Synthetik-Test, +400 % am
  //       eBike), strikte Importer (CST/ACIS) verwerfen die Fläche.
  // Darum prüft der Wächter je analytischer Fläche (Bohrungs-Zylinder, Fasen-Kegel, Kanal-Stück):
  //   (a) Normalen-Probe: effektive Normale (Flächennormale × same_sense) an den Schwerpunkten der
  //       ersetzten ORIGINAL-Dreiecke gegen deren Wicklungs-Normalen (zeigen aus dem Material);
  //       flächengewichtetes Mittel < 0 → Widerspruch.
  //   (b) Umlauf-Probe: je Rand einige Kurvenpunkte — die Fläche muss LINKS vom Rand liegen,
  //       (n_eff × Laufrichtung) · (Richtung zur Fläche) > 0 (Regel wie tests/step-strict.mjs).
  // Widerspruch → orientationGuardFailures im Report + Fallback wie bei offener Hülle (unten).
  const GUARD_MAX_TRIS = 400;        // Stützpunkte je Bohrung/Kegel (Stride) — fürs Vorzeichen üppig
  const GUARD_TUBE_MAX_TRIS = 6000;  // je Kanal (alle Stücke teilen sich EINEN Scan)
  const GUARD_LOOP_SAMPLES = 8;      // Kurvenpunkte je Rand für die Umlauf-Probe
  const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  // Flächengewichtetes Richtungs-Mittel: Σ(2A·cosθ)/Σ(2A) über die Dreiecke der Gruppen.
  // normalAt(p) = effektive Flächennormale (Einheitsvektor) am Punkt p (null = nicht auswertbar),
  // accept(p) filtert die Stützpunkte (z.B. auf die Chamfer-Zone). null = kein Beweismaterial.
  const guardScan = (groups, accept, normalAt) => {
    let total = 0;
    for (const g of groups) total += Math.floor(g.vertices.length / 3);
    if (!total) return null;
    const stride = Math.max(1, Math.ceil(total / GUARD_MAX_TRIS));
    let sum = 0, w = 0, idx = 0;
    for (const g of groups) {
      const vs = g.vertices, tc = Math.floor(vs.length / 3);
      for (let t = 0; t < tc; t++, idx++) {
        if (idx % stride) continue;
        const a = vs[t * 3], b = vs[t * 3 + 1], c = vs[t * 3 + 2];
        const wn = _cross3(_sub3(b, a), _sub3(c, a));          // Wicklungs-Normale, |wn| = 2·Fläche
        const area2 = Math.hypot(wn[0], wn[1], wn[2]);
        if (area2 < 1e-12) continue;
        const p = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
        if (accept && !accept(p)) continue;
        const n = normalAt(p);
        if (!n) continue;
        sum += _dot3(wn, n);                                   // = 2A·cos(Winkel)
        w += area2;
      }
    }
    return w > 0 ? sum / w : null;
  };
  // Punkte + Tangenten einer Rand-Kurve in ihrer NATÜRLICHEN Laufrichtung (wie emittiert):
  // CIRCLE/ELLIPSE laufen gegen den Uhrzeigersinn um ihre Achse, der B-Spline (schräge Kanal-
  // Mündung) in der Reihenfolge seiner Stützpunkte (geom.samples liegen auf der Kurve).
  const curveGuardSamples = (geom) => {
    const out = [];
    if (geom.kind === 'bspline') {
      const S = geom.samples;
      if (!Array.isArray(S) || S.length < 3) return out;
      const step = Math.max(1, Math.floor(S.length / GUARD_LOOP_SAMPLES));
      for (let i = 0; i < S.length; i += step) out.push({ p: S[i], t: _sub3(S[(i + 1) % S.length], S[(i - 1 + S.length) % S.length]) });
      return out;
    }
    const z = _norm3(geom.axis), rd = geom.refDir, rz = _dot3(rd, z);
    const x = _norm3([rd[0] - z[0] * rz, rd[1] - z[1] * rz, rd[2] - z[2] * rz]), y = _cross3(z, x);
    const a = geom.radius, b = geom.kind === 'ellipse' && Number.isFinite(geom.semi2) ? geom.semi2 : geom.radius;
    for (let i = 0; i < GUARD_LOOP_SAMPLES; i++) {
      const u = ((i + 0.5) / GUARD_LOOP_SAMPLES) * 2 * Math.PI, cu = Math.cos(u), su = Math.sin(u);
      out.push({
        p: [geom.center[0] + a * cu * x[0] + b * su * y[0], geom.center[1] + a * cu * x[1] + b * su * y[1], geom.center[2] + a * cu * x[2] + b * su * y[2]],
        t: [-a * su * x[0] + b * cu * y[0], -a * su * x[1] + b * cu * y[1], -a * su * x[2] + b * cu * y[2]],
      });
    }
    return out;
  };
  // Umlauf-Probe (b): loops = [{ geom, fwd, d }] — fwd = emittierte Nutzung (.T./.F.), d = Richtung
  // vom Rand in die Fläche hinein. Mehrheitsentscheid über die Kurvenpunkte; ohne auswertbare
  // Punkte kein Urteil (true).
  const loopSenseOk = (loops, normalAt) => {
    for (const L of loops) {
      let vote = 0, cnt = 0;
      for (const { p, t } of curveGuardSamples(L.geom)) {
        const n = normalAt(p);
        if (!n) continue;
        const left = _cross3(n, L.fwd ? t : [-t[0], -t[1], -t[2]]);   // „links“ vom Rand, in der Fläche
        vote += Math.sign(_dot3(left, L.d)); cnt++;
      }
      if (cnt && vote <= 0) return false;
    }
    return true;
  };
  // Effektive Normale eines Zylinder-Mantels am Punkt p: ±radial zur Achse (sgn = same_sense).
  const cylGuardNormal = (ap, axis, sgn) => (p) => {
    const w0 = _sub3(p, ap), al = _dot3(w0, axis);
    const rad = [w0[0] - axis[0] * al, w0[1] - axis[1] * al, w0[2] - axis[2] * al];
    const l = Math.hypot(rad[0], rad[1], rad[2]);
    return l > 1e-9 ? [sgn * rad[0] / l, sgn * rad[1] / l, sgn * rad[2] / l] : null;
  };
  // Effektive Kegel-Normale: STEP-Kegelnormale (radial von der Achse weg, um den Halbwinkel zur
  // Achse gekippt: radial·cosα − Achse·sinα) × same_sense.
  const coneGuardNormal = (cr, sgn) => {
    const ca = Math.cos(cr.semiAngle), sa = Math.sin(cr.semiAngle), ax = cr.coneAxis, ap = cr.rimDesc.center;
    return (p) => {
      const w0 = _sub3(p, ap), al = _dot3(w0, ax);
      const rad = [w0[0] - ax[0] * al, w0[1] - ax[1] * al, w0[2] - ax[2] * al];
      const l = Math.hypot(rad[0], rad[1], rad[2]);
      if (l < 1e-9) return null;
      return [sgn * (rad[0] / l * ca - ax[0] * sa), sgn * (rad[1] / l * ca - ax[1] * sa), sgn * (rad[2] / l * ca - ax[2] * sa)];
    };
  };
  // Stützpunkt-Filter: liegt p in der Chamfer-Zone? (gleiche Logik wie filterChamferZones)
  const inGuardZone = (z) => (p) => {
    const w0 = _sub3(p, z.ap), al = _dot3(w0, z.axis);
    const rho = Math.hypot(w0[0] - z.axis[0] * al, w0[1] - z.axis[1] * al, w0[2] - z.axis[2] * al);
    return rho >= z.R - 0.15 && rho <= z.R2 + 0.15 && al >= z.zLo - 0.15 && al <= z.zHi + 0.15;
  };
  // Rodrigues-Drehung von v um die Einheitsachse a um den Winkel u.
  const rotAboutAxis = (v, a, u) => {
    const c = Math.cos(u), s = Math.sin(u), d = _dot3(a, v) * (1 - c), x = _cross3(a, v);
    return [v[0] * c + x[0] * s + a[0] * d, v[1] * c + x[1] * s + a[1] * d, v[2] * c + x[2] * s + a[2] * d];
  };
  // Kanal-Wächter, je Stück k: accept(p) (gehört p geometrisch zu Stück k?), normalAt(p) (effektive
  // Normale mit dem emittierten same_sense ssOf(k)) und die Bahn-Tangenten tA/tB an Anfang/Ende.
  const tubeGuards = (tp, ssOf) => {
    const sp = tp.spec, r = sp.radius, tilted = Math.abs(sp.gamma) > 1e-9;
    const sinG = Math.abs(Math.sin(sp.gamma)), cosG = Math.cos(sp.gamma);
    const radTol = Math.max(0.15, 0.05 * r) + 0.15;
    const rLo = r * cosG - radTol, rHi = r + radTol;  // geneigtes Profil: Wandabstand ∈ [r·cosγ, r]
    return sp.pieces.map((pc, k) => {
      const sgn = ssOf(k) ? 1 : -1;
      if (pc.kind === 'line') {
        const lo = -r * sinG - 0.4, hi = pc.len + r * sinG + 0.4;
        const accept = (p) => {
          const w0 = _sub3(p, pc.profC), al = _dot3(w0, pc.dir);
          if (al < lo || al > hi) return false;
          const rho = Math.hypot(w0[0] - pc.dir[0] * al, w0[1] - pc.dir[1] * al, w0[2] - pc.dir[2] * al);
          return rho >= rLo && rho <= rHi;
        };
        let normalAt;
        if (!tilted) normalAt = cylGuardNormal(pc.profC, pc.dir, sgn);
        else {
          // SURFACE_OF_LINEAR_EXTRUSION: N = C'(u) × dir mit C'(u) = profM × (p0 − profC),
          // p0 = p auf die Profilebene zurückgeschoben (entlang dir).
          const md = _dot3(pc.dir, pc.profM);
          normalAt = (p) => {
            if (Math.abs(md) < 1e-9) return null;
            const v = _dot3(_sub3(p, pc.profC), pc.profM) / md;
            const p0 = [p[0] - pc.dir[0] * v, p[1] - pc.dir[1] * v, p[2] - pc.dir[2] * v];
            const n0 = _cross3(_cross3(pc.profM, _sub3(p0, pc.profC)), pc.dir);
            const l = Math.hypot(n0[0], n0[1], n0[2]);
            return l > 1e-9 ? [sgn * n0[0] / l, sgn * n0[1] / l, sgn * n0[2] / l] : null;
          };
        }
        return { accept, normalAt, tA: pc.dir, tB: pc.dir, sum: 0, w: 0 };
      }
      // Bogen-Stück (Drehung um pc.axis von ea Richtung eb um sweep): Winkelfenster + Abstand
      // zum Seelenkreis
      const mrg = (r * sinG + 0.4) / pc.R;
      const accept = (p) => {
        const w0 = _sub3(p, pc.O), al = _dot3(w0, pc.axis);
        const q = [w0[0] - pc.axis[0] * al, w0[1] - pc.axis[1] * al, w0[2] - pc.axis[2] * al];
        const rc = Math.hypot(q[0], q[1], q[2]);
        if (rc < 1e-9) return false;
        const dCore = Math.hypot(rc - pc.R, al);
        if (dCore < rLo || dCore > rHi) return false;
        let u = Math.atan2(_dot3(pc.eb, q), _dot3(pc.ea, q));
        if (u < 0) u += 2 * Math.PI;
        return u <= pc.sweep + mrg || u >= 2 * Math.PI - mrg;
      };
      let normalAt;
      if (!tilted) {
        // TOROIDAL_SURFACE: Normale zeigt vom Seelenkreis weg, × same_sense.
        normalAt = (p) => {
          const w0 = _sub3(p, pc.O), al = _dot3(w0, pc.axis);
          const q = [w0[0] - pc.axis[0] * al, w0[1] - pc.axis[1] * al, w0[2] - pc.axis[2] * al];
          const rc = Math.hypot(q[0], q[1], q[2]);
          if (rc < 1e-9) return null;
          const d0 = [p[0] - (pc.O[0] + q[0] / rc * pc.R), p[1] - (pc.O[1] + q[1] / rc * pc.R), p[2] - (pc.O[2] + q[2] / rc * pc.R)];
          const l = Math.hypot(d0[0], d0[1], d0[2]);
          return l > 1e-9 ? [sgn * d0[0] / l, sgn * d0[1] / l, sgn * d0[2] / l] : null;
        };
      } else {
        // SURFACE_OF_REVOLUTION: N = σ_u × σ_v exakt. Drehwinkel u aus der Ebenen-Bedingung des
        // mitrotierten Profils (p liegt in dessen Ebene): A + B·cos u + C·sin u = v0·m.
        const a = pc.axis, m = pc.profM, v0 = _sub3(pc.profC, pc.O);
        const am = _dot3(a, m), k0 = _dot3(v0, m), axm = _cross3(a, m);
        const mPerp = [m[0] - a[0] * am, m[1] - a[1] * am, m[2] - a[2] * am];
        normalAt = (p) => {
          const w0 = _sub3(p, pc.O);
          const A = _dot3(w0, a) * am;
          const B = _dot3(w0, mPerp), C = _dot3(w0, axm);
          const ramp = Math.hypot(B, C);
          if (ramp < 1e-12) return null;
          const qv = Math.max(-1, Math.min(1, (k0 - A) / ramp));
          const phi = Math.atan2(C, B), dac = Math.acos(qv);
          let bestU = 0, bestCu = null, bestErr = Infinity;
          for (const u of [phi + dac, phi - dac]) {
            const rv = rotAboutAxis(v0, a, u);
            const Cu = [pc.O[0] + rv[0], pc.O[1] + rv[1], pc.O[2] + rv[2]];
            const err = Math.abs(Math.hypot(p[0] - Cu[0], p[1] - Cu[1], p[2] - Cu[2]) - r);
            if (err < bestErr) { bestErr = err; bestU = u; bestCu = Cu; }
          }
          if (!bestCu || bestErr > Math.max(0.5, 0.1 * r)) return null;
          const Mu = rotAboutAxis(m, a, bestU);
          const su = _cross3(a, w0);                           // σ_u (Drehrichtung)
          const sv = _cross3(Mu, _sub3(p, bestCu));            // σ_v (CCW-Tangente des Profils)
          const n0 = _cross3(su, sv);
          const l = Math.hypot(n0[0], n0[1], n0[2]);
          return l > 1e-9 ? [sgn * n0[0] / l, sgn * n0[1] / l, sgn * n0[2] / l] : null;
        };
      }
      const cs = Math.cos(pc.sweep), ss = Math.sin(pc.sweep);
      const tB = [-ss * pc.ea[0] + cs * pc.eb[0], -ss * pc.ea[1] + cs * pc.eb[1], -ss * pc.ea[2] + cs * pc.eb[2]];
      return { accept, normalAt, tA: pc.eb, tB, sum: 0, w: 0 };
    });
  };
  // Normalen-Probe (a) für einen Kanal: EIN Scan über seine Original-Dreiecke; jedes Dreieck zählt
  // für das erste geometrisch passende Stück. Rückgabe: je Stück true = Widerspruch.
  const tubeScanFails = (tp, pcs) => {
    let total = 0;
    for (const g of tp.groups) total += Math.floor(g.vertices.length / 3);
    if (!total) return pcs.map(() => false);
    const stride = Math.max(1, Math.ceil(total / GUARD_TUBE_MAX_TRIS));
    let idx = 0;
    for (const g of tp.groups) {
      const vs = g.vertices, tc = Math.floor(vs.length / 3);
      for (let t = 0; t < tc; t++, idx++) {
        if (idx % stride) continue;
        const a3 = vs[t * 3], b3 = vs[t * 3 + 1], c3 = vs[t * 3 + 2];
        const wn = _cross3(_sub3(b3, a3), _sub3(c3, a3));
        const area2 = Math.hypot(wn[0], wn[1], wn[2]);
        if (area2 < 1e-12) continue;
        const p = [(a3[0] + b3[0] + c3[0]) / 3, (a3[1] + b3[1] + c3[1]) / 3, (a3[2] + b3[2] + c3[2]) / 3];
        for (const rec of pcs) {
          if (!rec.accept(p)) continue;
          const n = rec.normalAt(p);
          if (n) { rec.sum += _dot3(wn, n); rec.w += area2; }
          break;
        }
      }
    }
    return pcs.map((rec) => rec.w > 0 && rec.sum / rec.w < 0);
  };

  // ---- Step 3: Flächen emittieren — re-entrant, damit der globale Fallback alles facettiert
  // neu bauen kann. Setzt id/entities/Registries zurück und baut von vorn. (Vor dem ersten
  // Aufruf wurde noch nichts emittiert → entMark/idMark sind der Ausgangszustand.)
  const entMark = entities.length, idMark = id;
  const assemble = (faceDefsArg, plans, tubesArg = []) => {
    entities.length = entMark; id = idMark;
    ptRegistry.clear(); edgeRegistry.clear(); edgeUse.clear();
    circleRegistry.clear(); circleUse.clear();
    const faceIds = [];
    let guardFailures = 0, guardMs = 0;
    // Emittierte same_sense-Werte (korrekt bzw. vom Test-Hook gedreht) — der Wächter prüft
    // IMMER den tatsächlich emittierten Wert.
    const ssBore = testFlip('bore');   // korrekt .F.: Wand-Normale zeigt zur Achse (ins Loch)
    const ssCone = testFlip('cone');   // korrekt .F.: dito für die Fase

    // Kreis-Orientierung (ISO 10303-42, von strikten Importern wie CST/ACIS wörtlich genommen —
    // occt/Fusion reparieren still): Ein Loch-Rand läuft IM Uhrzeigersinn um die Flächennormale,
    // ein Mantel trägt seine Ränder so, dass die Fläche links liegt. Der CIRCLE läuft gegen den
    // Uhrzeigersinn um rim.axis → Richtung je Nutzung aus der Geometrie ableiten (früher pauschal
    // Deckfläche .T. / Mantel .F. — damit war eine der beiden Deckflächen jeder Bohrung falsch).
    // Kanal-Mündungen (rimKey 'tube…') bringen ihre Orientierung aus tube-sweep.js mit (.T.).
    const isTubeRim = (rim) => String(rim.rimKey).startsWith('tube');
    const holeLoopForward = (rim, faceNormal) => isTubeRim(rim) || _dot3(rim.axis, faceNormal) < 0;

    // Flachflächen (Innen-Loops mit `circleRim`-Tag werden als EINE Kreis-Kante emittiert).
    for (const { outer, inner, normal, centroid, fold } of faceDefsArg) {
      const outerOe = buildLoopEdges(outer, fold);
      if (outerOe.length < 3) continue;
      const bounds = [addFaceOuterBound(addEdgeLoop(outerOe))];
      for (const innerLoop of inner) {
        if (innerLoop.circleRim) {
          const rim = innerLoop.circleRim;
          const ce = getOrCreateCircleEdge(rim.rimKey, rim);
          const fwd = holeLoopForward(rim, normal);
          useCircle(rim.rimKey, fwd);
          bounds.push(addFaceBound(addEdgeLoop([addOrientedEdge(ce.ecId, fwd)])));
          continue;
        }
        const innerOe = buildLoopEdges(innerLoop, fold);
        if (innerOe.length < 3) continue;
        bounds.push(addFaceBound(addEdgeLoop(innerOe)));
      }
      const placId = addAxis2Placement3D(centroid, normal, computeRefDir(normal));
      faceIds.push(addAdvancedFace(bounds, addPlane(placId), true));
    }

    // Zylinder-Mantelflächen (nahtlos: 1 CYLINDRICAL_SURFACE, 2 volle Kreis-Bounds). Die STEP-
    // Zylindernormale zeigt von der Achse weg — bei einer Bohrung ins Material → same_sense .F.
    // (effektive Normale in den Hohlraum). Fläche links vom Rand: am oberen Ende (+Achse) läuft der
    // Rand gegen den Uhrzeigersinn um die Achse, am unteren im Uhrzeigersinn.
    for (const plan of plans) {
      const r0 = plan.rims[0];
      const ax = r0.axis;
      const cylPlac = addAxis2Placement3D(plan.surfCenter, ax, r0.refDir);
      const cylSurf = addCylindricalSurface(cylPlac, r0.radius);
      const tOf = (rim) => _dot3(_sub3(rim.center, plan.surfCenter), ax);
      const tMid = plan.rims.reduce((s, rim) => s + tOf(rim), 0) / plan.rims.length;
      const bounds = [], rimLoops = [];
      for (let r = 0; r < plan.rims.length; r++) {
        const rim = plan.rims[r];
        const ce = getOrCreateCircleEdge(rim.rimKey, rim);
        const isTop = tOf(rim) > tMid;
        const fwd = isTop === (_dot3(rim.axis, ax) > 0);
        useCircle(rim.rimKey, fwd);
        const loopId = addEdgeLoop([addOrientedEdge(ce.ecId, fwd)]);
        bounds.push(r === 0 ? addFaceOuterBound(loopId) : addFaceBound(loopId));
        rimLoops.push({ geom: rim, fwd });
      }
      faceIds.push(addAdvancedFace(bounds, cylSurf, ssBore));
      { // Wächter: (a) Wand-Facetten der Bohrung gegen die emittierte Mantel-Orientierung,
        // (b) Umlaufsinn beider Ränder (Fläche zwischen den Rändern = Richtung zum anderen Rand)
        const tg = nowMs();
        const nAt = cylGuardNormal(plan.surfCenter, ax, ssBore ? 1 : -1);
        const mean = guardScan(plan.groups, null, nAt);
        if (rimLoops.length === 2) {
          rimLoops[0].d = _sub3(rimLoops[1].geom.center, rimLoops[0].geom.center);
          rimLoops[1].d = _sub3(rimLoops[0].geom.center, rimLoops[1].geom.center);
        }
        if ((mean !== null && mean < 0) || (rimLoops.length === 2 && !loopSenseOk(rimLoops, nAt))) guardFailures++;
        guardMs += nowMs() - tg;
      }

      // Chamfer-Kegel (Fase): überbrückt Rand-Kreis R@z1 (mit Zylinder geteilt) und Flach-Kreis
      // R2@z2 (mit der flachen Fläche geteilt). Die STEP-Kegelnormale zeigt ins Material → same_sense
      // .F.; coneAxis zeigt vom Rand-Kreis zum Flach-Kreis. Fläche links vom Rand: Rand-Kreis im
      // Uhrzeigersinn um coneAxis, Flach-Kreis gegen den Uhrzeigersinn → je Kreis 1×fwd/1×rev mit
      // Zylinder bzw. Deckfläche.
      for (const cr of (plan.coneRims || [])) {
        const conePlac = addAxis2Placement3D(cr.rimDesc.center, cr.coneAxis, cr.rimDesc.refDir);
        const coneSurf = addConicalSurface(conePlac, cr.rimDesc.radius, cr.semiAngle);
        const ceRim = getOrCreateCircleEdge(cr.rimDesc.rimKey, cr.rimDesc);
        const ceFlat = getOrCreateCircleEdge(cr.flatDesc.rimKey, cr.flatDesc);
        const fRim = _dot3(cr.rimDesc.axis, cr.coneAxis) < 0;
        const fFlat = _dot3(cr.flatDesc.axis, cr.coneAxis) > 0;
        useCircle(cr.rimDesc.rimKey, fRim);
        useCircle(cr.flatDesc.rimKey, fFlat);
        const ob = addFaceOuterBound(addEdgeLoop([addOrientedEdge(ceRim.ecId, fRim)]));
        const ib = addFaceBound(addEdgeLoop([addOrientedEdge(ceFlat.ecId, fFlat)]));
        faceIds.push(addAdvancedFace([ob, ib], coneSurf, ssCone));
        { // Wächter: (a) die von der Chamfer-Zone verdrängten Original-Facetten gegen den Kegel,
          // (b) Umlaufsinn von Rand- und Flach-Kreis
          const tg = nowMs();
          const nAt = coneGuardNormal(cr, ssCone ? 1 : -1);
          const mean = guardScan(chamferDroppedGroups, cr.zone ? inGuardZone(cr.zone) : null, nAt);
          const dRF = _sub3(cr.flatDesc.center, cr.rimDesc.center);
          const loopsOk = loopSenseOk([
            { geom: cr.rimDesc, fwd: fRim, d: dRF },
            { geom: cr.flatDesc, fwd: fFlat, d: [-dRF[0], -dRF[1], -dRF[2]] },
          ], nAt);
          if ((mean !== null && mean < 0) || !loopsOk) guardFailures++;
          guardMs += nowMs() - tg;
        }
      }
    }

    // Kanal-Flächenketten (tube-sweep.js): Stück k zwischen Kurve k und k+1. Profil ⟂ Bahn (γ=0):
    // Gerade → CYLINDRICAL_SURFACE, Bogen → TOROIDAL_SURFACE. Profil geneigt (γ≠0, Profilkreis auf
    // der Mündungsfläche skizziert): Gerade → SURFACE_OF_LINEAR_EXTRUSION, Bogen →
    // SURFACE_OF_REVOLUTION des Profilkreises — beides exakt die gezogene Fläche.
    // Orientierung: Flächennormale zeigt in den Hohlraum. Kurven mit sense +1 laufen positiv um die
    // Bahnrichtung: Anfangskurve wird .F., Endkurve .T. benutzt (sense −1 umgekehrt); die ebene
    // Mündungsfläche benutzt ihre Kurve .T. → jede Kurve genau 1× vor, 1× zurück.
    for (const tp of tubesArg) {
      const sp = tp.spec, r = sp.radius, tilted = Math.abs(sp.gamma) > 1e-9;
      const keyOf = (k) => `tube${sp.id}:${k}`;
      const ssArr = [], fArr = [];
      // Test-Hook 'tubecurve': die mittlere Übergangskurve KONSISTENT gedreht (beide Nutzungen) —
      // Kanten-Bilanz bleibt dicht, nur die Umlauf-Probe des Wächters sieht es.
      const flipCurve = testFlip('tubecurve') && sp.pieces.length >= 2 ? Math.floor(sp.pieces.length / 2) : -1;
      sp.pieces.forEach((pc, k) => {
        let surf, sameSense;
        const profCircle = () => addCircle(addAxis2Placement3D(pc.profC, pc.profM, computeRefDir(pc.profM)), r);
        if (pc.kind === 'line') {
          sameSense = false; // Normale zeigt von der Achse weg
          if (!tilted) surf = addCylindricalSurface(addAxis2Placement3D(pc.profC, pc.dir, computeRefDir(pc.dir)), r);
          else {
            const sc = profCircle(), vec = addVector(addDirection(pc.dir), 1);
            surf = id++; entities.push(`#${surf}=SURFACE_OF_LINEAR_EXTRUSION('',#${sc},#${vec});`);
          }
        } else if (!tilted) {
          sameSense = false; // Torus-Normale zeigt vom Seelenkreis weg
          surf = id++; entities.push(`#${surf}=TOROIDAL_SURFACE('',#${addAxis2Placement3D(pc.O, pc.axis, pc.ea)},${toStep(pc.R)},${toStep(r)});`);
        } else {
          sameSense = true; // u = Drehwinkel (Bahnrichtung), v = Profil → Normale zeigt zum Profilmittelpunkt
          const sc = profCircle();
          const a1 = id++; entities.push(`#${a1}=AXIS1_PLACEMENT('',#${addPoint(pc.O)},#${addDirection(pc.axis)});`);
          surf = id++; entities.push(`#${surf}=SURFACE_OF_REVOLUTION('',#${sc},#${a1});`);
        }
        if (testFlip('tube')) sameSense = !sameSense; // Test-Hook: absichtlich gedreht
        ssArr[k] = sameSense;
        const c0 = sp.curves[k], c1 = sp.curves[k + 1];
        const e0 = getOrCreateCircleEdge(keyOf(k), c0), e1 = getOrCreateCircleEdge(keyOf(k + 1), c1);
        const f0 = (c0.sense < 0) !== (k === flipCurve), f1 = (c1.sense > 0) !== (k + 1 === flipCurve);
        fArr[k] = [f0, f1];
        useCircle(keyOf(k), f0); useCircle(keyOf(k + 1), f1);
        const ob = addFaceOuterBound(addEdgeLoop([addOrientedEdge(e0.ecId, f0)]));
        const ib = addFaceBound(addEdgeLoop([addOrientedEdge(e1.ecId, f1)]));
        faceIds.push(addAdvancedFace([ob, ib], surf, sameSense));
      });
      { // Wächter je Stück: (a) Kanal-Facetten gegen die emittierte Flächen-Orientierung,
        // (b) Umlaufsinn beider Ränder (Fläche liegt vom Anfangsrand aus in Bahnrichtung, vom
        // Endrand aus entgegen)
        const tg = nowMs();
        const pcs = tubeGuards(tp, (k) => ssArr[k]);
        const scanFail = tubeScanFails(tp, pcs);
        pcs.forEach((g, k) => {
          const loopsOk = loopSenseOk([
            { geom: sp.curves[k], fwd: fArr[k][0], d: g.tA },
            { geom: sp.curves[k + 1], fwd: fArr[k][1], d: [-g.tB[0], -g.tB[1], -g.tB[2]] },
          ], g.normalAt);
          if (scanFail[k] || !loopsOk) guardFailures++;
        });
        guardMs += nowMs() - tg;
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
        tubesConverted: tubesArg.length,
        tubePieces: tubesArg.reduce((n, tp) => n + tp.spec.pieces.length, 0),
        // Orientierungs-Wächter: analytische Flächen, deren Orientierung den Original-Dreiecken
        // bzw. ihren Rändern widerspricht (in DIESEM Zusammenbau; der Endbericht summiert alle
        // Fallback-Stufen auf).
        orientationGuardFailures: guardFailures,
        orientationGuardMs: Math.round(guardMs * 1000) / 1000,
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
  // ---- Ebenheit der emittierten PLANEs (strikte Importer) ----
  // Das Region-Growing fasst Facetten bis 2°/0.05 mm zu EINER Gruppe zusammen. Bei facettierten
  // Freiformen (Kugel, Verrundungen mit „Verrundungen entfernen“ AUS, organische Netze) lagen die
  // Rand-Punkte so bis 0.06 mm neben der emittierten Ebene — occt/Fusion tolerieren das, strikte
  // Kerne (ACIS/CST CAD Navigator rechnen mit ~1e-6 mm) nicht. Vor dem Zusammenbau wird darum JEDE
  // Fläche geprüft (Rand-Punkte ≤ PLANAR_TOL neben der Ebene centroid/normal); sonst
  //   (1) Ausgleichsebene durch die Rand-Punkte — reicht sie, wird nur die Ebene getauscht;
  //   (2) Zerlegung in exakt ebene Teilflächen: Region-Growing über die Original-Dreiecke der
  //       Fläche mit FESTER Saat-Ebene (größtes Dreieck zuerst, jede Ecke ≤ PLANAR_TOL), Ränder
  //       gerichtet nach der Dreieckswicklung. Für Flächen, deren Loops seit der Extraktion gleich
  //       geblieben sind oder nur einzelne Punkte ersetzt bekamen (v2 verlängert so die Wände bis
  //       zur Deckfläche — bei fein facettierten Rundungen oder Zylindern liegt die Wand-Gruppe dann
  //       bis 0.015 mm neben ihrer Ebene, Härtetest u/m32/m64); neu aufgebaute Loops (v1, v2-Deck,
  //       v2b, Kreis-Ränder) bleiben. Gegenprobe: die äußeren Kanten der Teilflächen müssen GENAU die
  //       Kanten der alten Fläche sein (gleiche Richtung) — sonst bleibt die alte Fläche.
  // CAD-Flächen liegen ohnehin exakt (≤ 7e-6 mm) und bleiben unberührt.
  const PLANAR_TOL = 5e-5;   // mm — Prüfer (tests/step-strict.mjs) erlaubt 1e-4; Rest für die Rundung
  const planeDev = (fd, n, c) => {
    let m = 0;
    for (const L of [fd.outer, ...fd.inner]) {
      if (L.circleRim) continue;
      for (const p of L) { const d = Math.abs(n[0] * (p[0] - c[0]) + n[1] * (p[1] - c[1]) + n[2] * (p[2] - c[2])); if (d > m) m = d; }
    }
    return m;
  };
  // Ausgleichsebene (Höhenfeld w = a·u + b·v über dem Rahmen der bisherigen Normale n0)
  const fitPlaneLsq = (fd, n0) => {
    const u = computeRefDir(n0), v = _norm3(_cross3(n0, u));
    const pts = [];
    for (const L of [fd.outer, ...fd.inner]) if (!L.circleRim) for (const p of L) pts.push(p);
    if (pts.length < 3) return null;
    const c = [0, 0, 0];
    for (const p of pts) { c[0] += p[0]; c[1] += p[1]; c[2] += p[2]; }
    c[0] /= pts.length; c[1] /= pts.length; c[2] /= pts.length;
    let suu = 0, suv = 0, svv = 0, suw = 0, svw = 0;
    for (const p of pts) {
      const d = _sub3(p, c), pu = _dot3(d, u), pv = _dot3(d, v), pw = _dot3(d, n0);
      suu += pu * pu; suv += pu * pv; svv += pv * pv; suw += pu * pw; svw += pv * pw;
    }
    const det = suu * svv - suv * suv;
    if (!(Math.abs(det) > 1e-18)) return null;
    const a = (suw * svv - svw * suv) / det, b = (svw * suu - suw * suv) / det;
    return { n: _norm3([n0[0] - a * u[0] - b * v[0], n0[1] - a * u[1] - b * v[1], n0[2] - a * u[2] - b * v[2]]), c };
  };
  // Wie hat sich die Fläche seit der Extraktion verändert? Map(alter Punkt-Schlüssel → neuer Punkt):
  // leer = unverändert; Einträge = einzelne Rand-Punkte ERSETZT, Loops sonst gleich (so verlängert v2
  // die Wände bis zur Deckfläche: Lw[i] = q). null = anders verändert (Loop neu aufgebaut, Kreis-
  // Rand, mehrere Flächen aus einer Komponente) → nicht zerlegbar.
  const movesSinceExtraction = (fd) => {
    const s = fd.src;
    if (!s || !s.single || fd.outer.length !== s.outer.length || fd.inner.length !== s.inner.length) return null;
    const mv = new Map();
    const same = (L, S) => {
      if (L.circleRim || L.length !== S.length) return false;
      for (let i = 0; i < L.length; i++) {
        if (L[i] === S[i]) continue;
        const k = vtxKey(S[i]), q = mv.get(k);
        if (q && vtxKey(q) !== vtxKey(L[i])) return false;
        mv.set(k, L[i]);
      }
      return true;
    };
    if (!same(fd.outer, s.outer)) return null;
    for (let j = 0; j < fd.inner.length; j++) if (!same(fd.inner[j], s.inner[j])) return null;
    return mv;
  };
  // Gerichtete Kanten der Linien-Loops einer Fläche zählen (s = ±1), Schlüssel a·VID_M + b.
  const addLoopEdges = (m, f, s) => {
    for (const L of [f.outer, ...f.inner]) {
      if (L.circleRim) continue;
      for (let i = 0; i < L.length; i++) {
        const a = vid(L[i]), b = vid(L[(i + 1) % L.length]);
        if (a !== b) { const k = a * VID_M + b; m.set(k, (m.get(k) || 0) + s); }
      }
    }
  };
  const revKey = (k) => (k % VID_M) * VID_M + Math.floor(k / VID_M);
  // index = gerichtete Kanten ALLER aktuellen Flächen (inkl. fd) — für die Gegenprobe.
  // moves (aus movesSinceExtraction): ersetzte Rand-Punkte. Die Teilflächen entstehen aus den
  // Original-Dreiecken, übernehmen danach die ersetzten Punkte und bekommen ihre Ebene neu
  // eingepasst — jede muss danach weiterhin exakt eben und gleich orientiert sein.
  const splitPlanar = (fd, index, moves) => {
    const { verts, tris } = fd.src;
    const T = tris.map((t) => {
      const a = verts[t * 3], b = verts[t * 3 + 1], c = verts[t * 3 + 2];
      const wn = _cross3(_sub3(b, a), _sub3(c, a)), area2 = Math.hypot(wn[0], wn[1], wn[2]);
      return { t, a, b, c, area2, n: area2 > 0 ? [wn[0] / area2, wn[1] / area2, wn[2] / area2] : null };
    });
    const byEdge = new Map();
    T.forEach((x, i) => {
      for (const [p, q] of [[x.a, x.b], [x.b, x.c], [x.c, x.a]]) { const k = edgeNum(p, q), l = byEdge.get(k); if (l) l.push(i); else byEdge.set(k, [i]); }
    });
    const order = T.map((_, i) => i).filter((i) => T[i].n).sort((i, j) => T[j].area2 - T[i].area2);
    const patchOf = new Int32Array(T.length).fill(-1);
    const patches = [];
    for (const s of order) {
      if (patchOf[s] >= 0) continue;
      const n = T[s].n, p0 = T[s].a;
      const on = (v) => Math.abs(n[0] * (v[0] - p0[0]) + n[1] * (v[1] - p0[1]) + n[2] * (v[2] - p0[2])) <= PLANAR_TOL;
      const members = [s];
      patchOf[s] = patches.length;
      for (let qi = 0; qi < members.length; qi++) {
        const x = T[members[qi]];
        for (const [p, q] of [[x.a, x.b], [x.b, x.c], [x.c, x.a]]) {
          for (const j of byEdge.get(edgeNum(p, q))) {
            const y = T[j];
            if (patchOf[j] >= 0 || !y.n || _dot3(y.n, n) <= 0 || !on(y.a) || !on(y.b) || !on(y.c)) continue;
            patchOf[j] = patches.length; members.push(j);
          }
        }
      }
      patches.push({ n, p0, tris: members.map((i) => T[i].t) });
    }
    if (!patches.length) return null;
    const parts = [];
    const moved = (L) => {                                   // ersetzte Punkte übernehmen
      const out = [];
      for (const p of L) { const q = moves.get(vtxKey(p)) || p; if (!out.length || vtxKey(out[out.length - 1]) !== vtxKey(q)) out.push(q); }
      while (out.length > 1 && vtxKey(out[0]) === vtxKey(out[out.length - 1])) out.pop();
      return out;
    };
    for (const P of patches) {
      for (const f of facesFromTris(verts, P.tris, P.n, { directed: true, minFace: 0, minHole: 0, keepSrc: false })) {
        if (moves && moves.size) {
          f.outer = moved(f.outer); f.inner = f.inner.map(moved);
          if (f.outer.length < 3 || f.inner.some((L) => L.length < 3)) return null;
          const fit = fitPlaneLsq(f, P.n);
          if (!fit || _dot3(fit.n, P.n) < 0.96 || planeDev(f, fit.n, fit.c) > PLANAR_TOL) return null;
          const to2 = projector2d(fit.n, fit.c);
          if (signedArea2d(f.outer.map(to2)) <= 0 || f.inner.some((L) => signedArea2d(L.map(to2)) >= 0)) return null;
          f.normal = fit.n; f.centroid = fit.c;
        } else {
          const h = _dot3(P.n, _sub3(f.centroid, P.p0));    // Ebene exakt durch die Saat
          f.centroid = [f.centroid[0] - P.n[0] * h, f.centroid[1] - P.n[1] * h, f.centroid[2] - P.n[2] * h];
          f.normal = P.n;
        }
        f.group = fd.group;
        parts.push(f);
      }
    }
    // Gegenprobe gegen die alte Fläche (own) und die übrigen Flächen (other = index − own):
    const own = new Map(), raw = new Map();
    addLoopEdges(own, fd, 1);
    for (const p of parts) addLoopEdges(raw, p, 1);
    const innerPairs = [];                                   // Kanten zwischen zwei Teilflächen
    for (const k of [...raw.keys()]) {
      const c = raw.get(k), r = revKey(k), cr = raw.get(r) || 0, x = Math.min(c, cr);
      if (x > 0) { raw.set(k, c - x); raw.set(r, cr - x); innerPairs.push(k); }
    }
    const other = (k) => (index.get(k) || 0) - (own.get(k) || 0);
    // (1) jede Kante der alten Fläche bleibt erhalten, gleichsinnig
    for (const [k, c] of own) if (c > 0 && (raw.get(k) || 0) !== c) return null;
    // (2) zusätzliche Rand-Kanten (Mini-Loops, die die alte Extraktion unter MIN_*_AREA verwarf)
    //     nur, wenn sie eine bisher OFFENE Gegen-Nutzung einer anderen Fläche schließen
    for (const [k, c] of raw) {
      const extra = c - (own.get(k) || 0);
      if (extra > 0 && other(revKey(k)) - other(k) < extra) return null;
    }
    // (3) innere Kanten, die schon andere Flächen nutzen: eine im Netz non-manifolde Kante, die
    //     bisher INNERHALB der Fläche lag (Faltung). Als gemeinsame Kante wäre sie 4× genutzt →
    //     die Teilflächen bekommen dafür eine eigene Kanten-Instanz (assemble: fold).
    const foldKeys = new Set();
    for (const k of innerPairs) {
      if (other(k) + other(revKey(k)) > 0) {
        const a = vidKeys[Math.floor(k / VID_M)], b = vidKeys[k % VID_M];
        foldKeys.add(a < b ? `${a}||${b}` : `${b}||${a}`);   // = edgeCanonKey (ptKey ≡ vtxKey)
      }
    }
    if (foldKeys.size) { const fold = { id: ++foldSeq, keys: foldKeys }; for (const p of parts) p.fold = fold; }
    return parts;
  };
  const enforcePlanarity = (fds) => {
    const out = [];
    const st = { refits: 0, splits: 0, parts: 0, rest: 0, restMax: 0 };
    let index = null;                                        // erst bei der ersten Zerlegung
    for (const fd of fds) {
      const n = _norm3(fd.normal);
      if (planeDev(fd, n, fd.centroid) <= PLANAR_TOL) { out.push(fd); continue; }
      if (!fd.inner.some((L) => L.circleRim)) {
        const fit = fitPlaneLsq(fd, n);
        if (fit && planeDev(fd, fit.n, fit.c) <= PLANAR_TOL) { fd.normal = fit.n; fd.centroid = fit.c; st.refits++; out.push(fd); continue; }
        let parts = null;
        const moves = movesSinceExtraction(fd);
        if (moves) {
          if (!index) { index = new Map(); for (const f of fds) addLoopEdges(index, f, 1); }
          try { parts = splitPlanar(fd, index, moves); } catch (_) { parts = null; }
        }
        if (parts) {
          addLoopEdges(index, fd, -1);
          for (const f of parts) { addLoopEdges(index, f, 1); out.push(f); }
          st.splits++; st.parts += parts.length;
          continue;
        }
      }
      st.rest++; st.restMax = Math.max(st.restMax, planeDev(fd, n, fd.centroid));
      out.push(fd);
    }
    return { fds: out, st };
  };
  const planarReport = (report, st) => {
    report.planarRefits = st.refits;          // Ebene durch Ausgleich ersetzt
    report.planarSplits = st.splits;          // Flächen in ebene Teilflächen zerlegt …
    report.planarParts = st.parts;            // … zu so vielen Teilflächen
    report.nonPlanarFaces = st.rest;          // nicht behebbar (verändert/Kreis-Rand) — bleiben
    report.nonPlanarMaxDev = Math.round(st.restMax * 1e7) / 1e7;
  };

  const assembleCurrent = () => {
    const pl = enforcePlanarity(faceDefs);
    faceDefs = pl.fds;
    removeCollinearPoints(faceDefs);
    const a = assemble(faceDefs, finalPlans, tubePlans);
    a.report.filletsDefeatured = filletsDefeatured;
    a.report.bandsDefeatured = bandsDefeatured;
    a.report.cornersDefeatured = cornersDefeatured;
    planarReport(a.report, pl.st);
    return a;
  };
  // Ein Zusammenbau gilt als gescheitert, wenn die Hülle offen ist ODER der Orientierungs-Wächter
  // eine analytische Fläche verworfen hat (s. assemble) — beides löst dieselben Fallback-Stufen
  // aus. Die Wächter-Befunde aller Stufen werden aufsummiert (Report: orientationGuardFailures,
  // fallbackStage 0 = keiner, 1 = ohne Bohrungen/Kanäle, 2 = facettiert).
  let guardTotal = 0, guardMsTotal = 0, fallbackStage = 0;
  const failed = (a) => !a.report.watertight || (GUARD_FALLBACK && a.report.orientationGuardFailures > 0);
  const tracked = (a) => { guardTotal += a.report.orientationGuardFailures; guardMsTotal += a.report.orientationGuardMs; return a; };
  runPipeline(true);
  let asm = tracked(assembleCurrent());
  // Fallback-Stufe 1 (nur mit Toggle): scheitert eine Bohrungs- oder Kanal-Umwandlung, ohne
  // sie neu bauen (Defeaturing bleibt) — sonst verwarf der globale Fallback auch korrekte Bänder/Ecken.
  if (DEFEATURE && (finalPlans.length > 0 || tubePlans.length > 0) && failed(asm)) {
    runPipeline(false);
    asm = tracked(assembleCurrent());
    fallbackStage = 1;
  }
  // Fallback-Stufe 2 (global): scheitert die analytische Umwandlung ODER das Defeaturing, wird
  // ALLES facettiert neu gebaut (buildFaceDefs(null) erzeugt FRISCHE, unmutierte Loops) —
  // die wasserdichte Baseline kann dadurch nie regressieren. (Die Kollinear-Bereinigung läuft auch
  // hier: sie ist topologisch neutral, sonst hätte „Defeaturing an" mehr Kanten als „aus".)
  if ((asm.report.boresConverted > 0 || asm.report.tubesConverted > 0 || filletsDefeatured > 0 || bandsDefeatured > 0 || cornersDefeatured > 0) && failed(asm)) {
    const pl = enforcePlanarity(buildFaceDefs(null));
    const fallbackDefs = pl.fds;
    removeCollinearPoints(fallbackDefs);
    asm = tracked(assemble(fallbackDefs, []));
    asm.report.filletsDefeatured = 0;
    asm.report.bandsDefeatured = 0;
    asm.report.cornersDefeatured = 0;
    planarReport(asm.report, pl.st);
    fallbackStage = 2;
  }
  asm.report.orientationGuardFailures = guardTotal;
  asm.report.orientationGuardMs = Math.round(guardMsTotal * 1000) / 1000;
  asm.report.fallbackStage = fallbackStage;
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
      edgeRegistry.set(key, { ecId, startKey: ptKey(p1) });   // tatsächlicher EDGE_CURVE-Start (s. V2)
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
        const forward = ptKey(p1) === edge.startKey;
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

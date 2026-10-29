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
import { matchTubeMouths } from './tube-sweep.js?v=4';
// Profil-Bögen (profile-arcs.js): gestreifte Rundungen → echte Zylinder-/Kegel-Flächen mit Bogen-Kanten
import { findArcBands, validateArcBands, applyArcBands, buildArcPlans, expandArcLoop } from './profile-arcs.js?v=3';

// Globale Unsicherheit im STEP-Kopf (UNCERTAINTY_MEASURE_WITH_UNIT, mm). Strikte Kerne (ACIS/CST)
// nehmen sie wörtlich: Punkte näher als dieser Wert gelten als derselbe Punkt, Kanten darunter als
// Punkt → mit dem früheren Pauschalwert 0.01 mm verwarf CST am Kabelhalter die Deckfläche (962 ihrer
// Randkanten < 0.01 mm). 1e-4 mm:
//   - größer als die bekannten Rest-Abweichungen (Rand↔Fläche ≤ 4.7e-5 mm, facettierte Rundungen
//     nach enforcePlanarity; 6 Nachkommastellen ≙ 5e-7) und genau die Schranke, die
//     tests/step-strict.mjs für Punkt↔Fläche/Kurve erzwingt — der Exporter garantiert also, was er
//     deklariert;
//   - deutlich kleiner als jede Kante, die ein Drucker abbildet: 46× unter der kürzesten Kante
//     eines unbereinigten Real-Netzes (Kabelhalter 0.0046 mm) und 200× unter der Mindest-
//     Detailgröße der Netz-Bereinigung (mesh-clean.js, Standard 0.02 mm);
//   - gleich dem Punkt-Raster des Region-Growing (Schlüssel auf 1e-4 mm).
export const STEP_UNCERTAINTY_MM = '1.E-04';

// Grund, warum der Bohrungs-Pfad (attemptBore) an einer Bohrung gescheitert ist:
//   'rims' — die Rand-Loops sind keine zwei sauberen Rand-Kreise (kein einfaches Durchgangsloch:
//            D-Loch, Steg in der Wand, …). Der Bohrungs-Pfad hat die WAND dann gar nicht beurteilt.
//   'wall' — die Ränder waren in Ordnung, aber die Wand ist kaputt (Delle, Verdrehung) → der
//            Bohrungs-Pfad hat sie geprüft und verworfen.
// Der Profil-Bogen-Pfad (arcBlockedGroups) darf eine Bohrungs-Wand nur dann übernehmen, wenn sie
// mit 'rims' gescheitert ist: dort hat der Bohrungs-Pfad die Wand-Qualität nie beurteilt. Bei
// 'wall' bleibt die Sperre — und der Bogen-Pfad ist ohnehin strenger (Fit 5e-3 mm ≪ Rand-Toleranz
// 0.08…0.06·R), eine gedellte Wand kann seinen Fit nicht bestehen.
const boreFailWhy = new WeakMap();

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

// ============================================================================
// Biegungs-Erkennung (Blechprofile): Innen- und Außenbogen KOAXIAL um dieselbe
// Achse, konstante Wandstärke t = r_außen − r_innen.
//
// DEFINITION eines Biegungs-Paares P1, P2 (zwei Zylinder-Primitive mit
// group.primitive.type === 'cylinder' und full === false; alle Gruppen mit gleichem
// primitive.id gehören zu einem Primitive):
//   (1) Achsen parallel:  |a1·a2| ≥ cos(0,5°)
//   (2) koaxial:          Abstand der Achsgeraden ≤ tolC = max(0,02; 0,01·max(r1,r2)) mm
//   (3) Radiusdifferenz:  t = |r2 − r1| ≥ 0,1 mm (= Wandstärke) und t ≤ 3·max(r1,r2) + 10 mm
//   (4) gleicher Winkelbereich: die Polarwinkel-Intervalle der Gruppen-Punkte (im Rahmen
//       senkrecht zur Achse) haben Start und Ende je auf ≤ 3° gleich — Innen- und Außenbogen
//       überstreichen denselben Bogen; daraus folgt: die anschliessenden geraden Wandstücke
//       sind parallel im Abstand t = konstante Wandstärke. ZUSÄTZLICH müssen die Bogenweiten
//       (span) je auf ≤ 3° gleich sein — sonst gelten z.B. ein 90°- und ein 270°-Bogen mit
//       vertauschten Enden (gleiche Endrichtungen) als Paar
//   (5) axiale Überdeckung: die Projektionen der Gruppen-Punkte auf die Achse überlappen zu
//       ≥ 50 % der kürzeren
// Ein Primitive kommt überhaupt nur als Biegungsbogen in Frage, wenn sein Bogen höchstens 200°
// überstreicht (KEIN Fast-Vollkreis: `full === false` heißt nur „Abdeckung unter der Schwelle“,
// ein 350°-Zylinder ist full:false) UND die größte Winkel-Lücke mindestens 3× so groß ist wie die
// zweitgrößte (sonst sind Start und Ende des Bogens nicht bestimmt — Schlitzrohr, C-Profil).
// Biegungs-Gruppen sind nur die Gruppen, die WIRKLICH auf dem Zylinder liegen (Streifen-Semantik
// wie in defeatureOne: alle Punkte radial ≤ tolM) — die tangential anschliessende Ebene, die die
// Erkennung dem Primitiv mitunter zuschlägt, gehört NICHT dazu und wird nicht ausgenommen.
//
// Rückgabe: { groups: Set der Biegungs-Gruppen, prims: Set der Primitive-IDs,
//             pairs: [[id1, id2], …] }.
export function findBendGroups(normalGroups) {
  const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross3 = (a, b) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0]
  ];
  const norm3 = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
  const PAR_COS = Math.cos(0.5 * Math.PI / 180);   // (1) Achsen parallel (0,5°)
  const ANG_TOL = 3;                             // (4) Winkelbereich-Toleranz [Grad]
  const T_MIN = 0.1;                             // (3) Mindest-Wandstärke [mm]
  const OVERLAP_MIN = 0.5;                       // (5) axiale Überdeckung
  const SPAN_MAX = 200;                          // (4a) Bogen höchstens 200° (kein Fast-Vollkreis)
  const GAP_RATIO = 3;                           // (4a) größte Lücke ≥ 3× zweitgrößte Lücke

  // Primitive sammeln (Gruppen mit gleichem primitive.id gehören zusammen)
  const byId = new Map();
  for (const g of normalGroups || []) {
    const p = g?.primitive;
    if (!p || p.type !== 'cylinder' || p.full !== false) continue;
    if (!Number.isFinite(p.radius) || !(p.radius > 0)) continue;
    if (!Array.isArray(p.axis) || !Array.isArray(p.axisPoint)) continue;
    let e = byId.get(p.id);
    if (!e) { e = { prim: p, groups: [], strip: [], pts: [] }; byId.set(p.id, e); }
    e.groups.push(g);
    // Nur Punkte, die WIRKLICH auf dem Zylinder liegen: die Erkennung schlägt dem Primitiv
    // mitunter die tangential anschliessende Ebene zu (Kabelhalter/Taschenecken) — die gehört
    // nicht zum Bogen (s. auch defeatureOne, s. „strip“).
    const vs = g.vertices;
    if (!Array.isArray(vs) || !vs.length) continue;
    const tolM = Math.max(0.1, 0.06 * p.radius);
    const a = norm3(p.axis);
    const rad = (v) => {
      const w = sub3(v, p.axisPoint), al = dot3(w, a);
      return Math.abs(Math.hypot(w[0] - a[0] * al, w[1] - a[1] * al, w[2] - a[2] * al) - p.radius);
    };
    if (vs.every((v) => Array.isArray(v) && v.length >= 3 && rad(v) <= tolM)) {
      e.strip.push(g);                       // Streifen: nur diese Gruppen sind Biegungs-Gruppen
      for (const v of vs) e.pts.push(v);
    }
  }
  const ents = [...byId.values()];

  // Je Primitive einmal: Winkelbereich (Start-/Endrichtung als WELT-Vektoren — rahmenunabhängig,
  // damit der Paar-Vergleich O(1) bleibt) und axiale Ausdehnung (entlang der eigenen Achse).
  for (const e of ents) {
    const p = e.prim;
    const a = norm3(p.axis), O = p.axisPoint;
    const ref = Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const u = norm3(cross3(a, ref)), v = norm3(cross3(a, u));
    const rad = [];                                   // { ang, dir } je Punkt
    let lo = Infinity, hi = -Infinity;
    for (const q of e.pts) {
      const w = sub3(q, O), s = dot3(w, a);
      if (s < lo) lo = s; if (s > hi) hi = s;
      const dir = [w[0] - a[0] * s, w[1] - a[1] * s, w[2] - a[2] * s];
      const l = Math.hypot(dir[0], dir[1], dir[2]);
      if (!(l > 1e-9)) continue;                      // Punkt auf der Achse → kein Winkel
      const n = [dir[0] / l, dir[1] / l, dir[2] / l];
      rad.push({ ang: Math.atan2(dot3(n, v), dot3(n, u)), dir: n });
    }
    e.axLo = lo; e.axHi = hi;
    if (!rad.length) { e.arc = null; continue; }
    // (4) Polarwinkel-Intervall: der Bogen ist das Komplement der größten Lücke
    rad.sort((x, y) => x.ang - y.ang);
    const gaps = [];
    for (let k = 0; k < rad.length; k++) {
      const p0 = rad[k].ang, p1 = (k + 1 < rad.length) ? rad[k + 1].ang : rad[0].ang + 2 * Math.PI;
      gaps.push(p1 - p0);
    }
    let gi = 0;
    for (let k = 1; k < gaps.length; k++) if (gaps[k] > gaps[gi]) gi = k;
    const gap = gaps[gi];
    const gap2 = gaps.reduce((m, g, k) => (k === gi ? m : Math.max(m, g)), 0);
    const span = (2 * Math.PI - gap) * 180 / Math.PI;
    // (4a) Kein Fast-Vollkreis und eindeutiger Bogen: der Bogen darf höchstens 200° überstreichen
    //      (ein 350°-Zylinder ist full:false, wäre aber kein Bogen) und die größte Lücke muss
    //      mindestens 3× so groß sein wie die zweitgrößte — sonst sind Start und Ende des Bogens
    //      nicht bestimmt (Schlitzrohr/C-Profil: Innen- UND Außenbogen).
    if (span > SPAN_MAX || gap * 180 / Math.PI < GAP_RATIO * gap2 * 180 / Math.PI) { e.arc = null; continue; }
    e.arc = { start: rad[(gi + 1) % rad.length].dir, end: rad[gi].dir, span };
  }

  const bendGroups = new Set(), bendPrims = new Set(), pairs = [];
  for (let i = 0; i < ents.length; i++) for (let j = i + 1; j < ents.length; j++) {
    if (!isBendPair(ents[i], ents[j])) continue;
    // Biegungs-Gruppen sind nur die STREIFEN (Gruppen, die WIRKLICH auf dem Zylinder liegen) —
    // die tangential anschliessende Ebene, die die Erkennung dem Primitiv zuschlägt, wird
    // NICHT von der Entrundung ausgenommen.
    for (const g of ents[i].strip) bendGroups.add(g);
    for (const g of ents[j].strip) bendGroups.add(g);
    bendPrims.add(ents[i].prim.id); bendPrims.add(ents[j].prim.id);
    pairs.push([ents[i].prim.id, ents[j].prim.id]);
  }
  return { groups: bendGroups, prims: bendPrims, pairs };

  function isBendPair(E1, E2) {
    const P1 = E1.prim, P2 = E2.prim;
    if (!Array.isArray(P2.axis) || !Array.isArray(P2.axisPoint)) return false;
    if (!E1.arc || !E2.arc) return false;                            // (4) ohne Winkelbereich
    const a1 = norm3(P1.axis), a2 = norm3(P2.axis);
    const par = dot3(a1, a2);
    if (Math.abs(par) < PAR_COS) return false;                        // (1) parallel
    const r1 = P1.radius, r2 = P2.radius;
    const t = Math.abs(r2 - r1);
    if (t < T_MIN || t > 3 * Math.max(r1, r2) + 10) return false;     // (3) Wandstärke
    const tolC = Math.max(0.02, 0.01 * Math.max(r1, r2));
    const w = sub3(P2.axisPoint, P1.axisPoint), al = dot3(w, a1);
    const dist = Math.hypot(w[0] - a1[0] * al, w[1] - a1[1] * al, w[2] - a1[2] * al);
    if (dist > tolC) return false;                                     // (2) koaxial
    // (4) gleicher Winkelbereich: Start und Ende je auf ≤ 3° gleich (in beide Richtungen
    //     möglich: die Achsen der beiden Primitive können gegenläufig gerichtet sein)
    const ang = (d1, d2) => {
      const c = Math.max(-1, Math.min(1, dot3(d1, d2)));
      return Math.acos(c) * 180 / Math.PI;
    };
    const same = (ang(E1.arc.start, E2.arc.start) <= ANG_TOL && ang(E1.arc.end, E2.arc.end) <= ANG_TOL)
      || (ang(E1.arc.start, E2.arc.end) <= ANG_TOL && ang(E1.arc.end, E2.arc.start) <= ANG_TOL);
    if (!same) return false;
    // (4) gleiche BOGENWEITE: sonst wären z.B. ein 90°- und ein 270°-Bogen mit vertauschten
    //     Enden (gleiche Endrichtungen) ein Paar
    if (Math.abs(E1.arc.span - E2.arc.span) > ANG_TOL) return false;
    // (5) axiale Überdeckung (beide Primitive auf die Achse von P1 bezogen)
    const O1 = P1.axisPoint, O2 = P2.axisPoint;
    const c = (O2[0] - O1[0]) * a1[0] + (O2[1] - O1[1]) * a1[1] + (O2[2] - O1[2]) * a1[2];
    const k = par >= 0 ? 1 : -1;
    const lo2 = c + Math.min(k * E2.axLo, k * E2.axHi), hi2 = c + Math.max(k * E2.axLo, k * E2.axHi);
    if (!Number.isFinite(E1.axLo) || !Number.isFinite(lo2)) return false;
    const shorter = Math.min(E1.axHi - E1.axLo, hi2 - lo2);
    if (!(shorter > 0)) return false;
    if (Math.min(E1.axHi, hi2) - Math.max(E1.axLo, lo2) < OVERLAP_MIN * shorter) return false;
    return true;
  }
}

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
  // Blech-Biegungen (Schalter „Blech-Biegungen schärfen“, Standard AUS): die Biegungen eines
  // Blechprofils (Innen- und Außenbogen KOAXIAL, konstante Wandstärke) bleiben per Default RUND —
  // der Exporter macht daraus echte Teil-Zylinder (profile-arcs.js). Nur mit sharpenBends=true
  // werden sie wie die übrigen Verrundungen geschärft. Echte Kanten-Verrundungen (ohne koaxialen
  // Gegenbogen: Taschenecken, Plattenkanten) werden weiterhin geschärft.
  const SHARPEN_BENDS = analysis?.sharpenBends === true;
  // Biegungs-Gruppen (einmal je Export bestimmt, s. findBendGroups): alle Gruppen, die zu einem
  // Biegungs-Paar gehören. Sie werden von JEDER Entrundung ausgenommen (v1, v2, v2b, v2c).
  const bendInfo = (DEFEATURE && !SHARPEN_BENDS) ? findBendGroups(normalGroups) : { groups: new Set(), prims: new Set(), pairs: [] };
  const bendGroups = bendInfo.groups;
  // Profil-Bögen (profile-arcs.js): Schalter + Sperrliste
  const ARCS = analysis?.profileArcs !== false;   // Profil-Bögen (profile-arcs.js)
  const arcBlocked = new Set();                     // Band-Signaturen, die facettiert bleiben (Rückfall)
  let arcStats = { tried: 0, retries: 0, dropped: 0 };
  // Normalgruppen, deren Wände die Primitive-Pfade (Mantel/Bohrung) beanspruchen: diese Wände
  // dürfen vom Bogen-Pfad NICHT in Bänder geteilt werden (deren Gates sind strenger).
  //  MANTEL: immer gesperrt — der Mantel-/Kegel-Pfad ist zuständig (Delle, Verdrehung, Knick, Fase).
  //  BOHRUNG: gesperrt, wenn der Bohrungs-Pfad die Wand beansprucht hat:
  //    * AN (Defeaturing an): der Bohrungs-Pfad prüft JEDE Bohrung (scharf/blind/Bestand) — er hat
  //      entschieden: umgewandelt ODER geometrisch verworfen (Delle, Verdrehung, zu dünner Steg,
  //      Rand an der Plattenkante). Seine Gates sind strenger als die des Bogen-Pfads: eine Teilung
  //      würde sie umgehen (Delle geglättet, Kreis-Kante schneidet den Nachbarn).
  //    * AUS (Defeaturing aus): der Bohrungs-Pfad ist auf Direkt-Treffer beschränkt (Fase/Senkung
  //      wird NUR mit Toggle umgewandelt) — eine Bohrung kann dort also aus zwei Gründen ausfallen:
  //        (a) NUR der Schalter: die Wand endet in einer Fase/Senkung (KEINE Deckfläche am Rand) —
  //            im AN-Lauf nähme sie der Kegel-Pfad. Dann darf der Bogen-Pfad sie übernehmen, sonst
  //            geht die gefaste Senkbohrung verloren (kein anderer Pfad nimmt sie).
  //        (b) GEOMETRIE: die Wand ist kein sauberer Zylinder (Delle, Verdrehung) ODER sie endet an
  //            einer Deckfläche, aber ein Gate des Bohrungs-Pfads hat sie abgelehnt (Freigang zu
  //            klein, Rand nicht in der Deckebene) — im AN-Lauf bliebe sie facettiert → sperren.
  //      Gesperrt werden im AUS-Export also: die umgewandelten Bohrungen (Direkt-Treffer), die
  //      geometrisch verworfenen (Wand kaputt) und die mit Deckfläche am Rand (Gate-Abgelehnte).
  // Die Sperre hängt von finalPlans und den aktuellen Flächen ab (je Lauf neu) → kein Cache; nur
  // der Bohrungs-Plan (netz-unabhängig) wird gemerkt.
  const arcBorePlan = new Map();       // Bohrung → Plan des Bohrungs-Pfads (null = Wand unbrauchbar)
  const borePathPlan = (entry) => {
    if (!arcBorePlan.has(entry)) {
      let plan = null;
      try { plan = attemptBore(entry); } catch (_) { plan = null; }
      arcBorePlan.set(entry, plan);
    }
    return arcBorePlan.get(entry);
  };
  // Endet die Wand der Bohrung an einer ebenen DECKFLÄCHE (deren Innen-Loop auf den Rand passt)?
  // Dann ist die Bohrung ein echtes Loch im Material (kein Fase-/Senkungs-Kegel am Rand).
  const boreRimOnDeck = (plan) => {
    for (const rim of plan.rims) {
      for (const fd of faceDefs) {
        if (!fd || !fd.normal) continue;
        for (const inner of fd.inner || []) {
          if (inner.circleRim) continue;
          if (innerMatchesRim(inner, fd.normal, rim)) return true;
        }
      }
    }
    return false;
  };
  const arcBlockedGroups = () => {
    const s = new Set();
    // Eine Bohrung, deren Wand der Bogen-Pfad übernehmen darf: der Bohrungs-Pfad ist an den
    // RÄNDERN gescheitert ('rims' — kein einfaches Durchgangsloch: D-Loch, Steg in der Wand …).
    // Er hat die Wand dann gar nicht beurteilt; seine Gates (Delle, Verdrehung, dünner Steg,
    // Rand an der Plattenkante) liefen also nie. Der Bogen-Pfad hat eigene, STRENGERE Gates
    // (Fit 5e-3 mm ≪ Rand-Toleranz 0.08…0.06·R; jeder Band-Bogen muss an genau eine ebene
    // Fläche oder ein anderes Band grenzen) — eine kaputte Wand kann sie nicht bestehen.
    // Bei 'wall' (Delle/Verdrehung) bleibt die Sperre: dort hat der Bohrungs-Pfad die Wand
    // geprüft und verworfen.
    const boreOpenForArcs = (e) => {
      if (borePathPlan(e)) return false;                 // Plan vorhanden → der Bohrungs-Pfad urteilt
      return boreFailWhy.get(e) === 'rims';
    };
    for (const [, e] of mantleById) for (const g of e.groups) s.add(g);
    for (const [, e] of boreById) {
      if (DEFEATURE) {                                                        // AN: der Bohrungs-Pfad entscheidet über jede Bohrung
        if (boreOpenForArcs(e)) continue;                                     // …außer er scheiterte an den Rändern
        for (const g of e.groups) s.add(g); continue;
      }
      let claimed = false;                                                     // AUS: Direkt-Treffer (in diesem Lauf umgewandelt)
      for (const pl of finalPlans) if (pl && pl.entry === e) { claimed = true; break; }
      if (!claimed) {
        const plan = borePathPlan(e);
        if (!plan) {
          if (boreFailWhy.get(e) === 'rims') continue;                        // Wand ungeprüft → Bogen-Pfad darf übernehmen
          for (const g of e.groups) s.add(g); continue;                        // Wand kaputt (Delle, Verdrehung)
        }
        if (boreRimOnDeck(plan)) for (const g of e.groups) s.add(g);           // Gate-Abgelehntes Loch (z. B. Freigang)
        continue;                                                              // …sonst nur der Schalter → Bogen-Pfad darf übernehmen
      }
      for (const g of e.groups) s.add(g);
    }
    return s;
  };

  // ---- Test-Hooks (nur Tests/Node, tests/orientation-guard.mjs): STLREV_TEST_FLIP='bore'|'mantle'|
  // 'mantlecone'|'cone'|'tube' dreht den emittierten same_sense der jeweiligen analytischen Flächen
  // ABSICHTLICH um ('mantlecone' = konvexe Kegel-Mäntel und Mantel-Fasen, 'cone' = Fasen-Kegel der
  // Bohrungen),
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
  // Punkte, Radien, Winkel mit 9 Nachkommastellen: ACIS (CST CAD Navigator) rechnet mit einer
  // absoluten Auflösung von 1e-6 mm — mit 6 Stellen lag allein die Rundung bis 8.7e-7 mm daneben,
  // zusammen mit der Ebenheit und den Linien-Enden darüber (Kabelhalter: Flächen fehlten in CST).
  const toStep = (v) => {
    if (!Number.isFinite(v)) return '0.';
    const t = Number(v).toFixed(9).replace(/(\.\d*?)0+$/, '$1');
    return t.includes('.') ? t : t + '.';
  };
  // Richtungen mit 12 Nachkommastellen: mit 6 lag bei langen schrägen Kanten/Flächen allein die
  // Rundung der Richtung daneben (schräger 300-mm-Quader: Kanten-Ende 1.2e-4 mm neben seiner LINE,
  // Rand 9.6e-5 mm neben der PLANE — strikte Importer, tests/step-strict.mjs).
  const toStepDir = (v) => {
    if (!Number.isFinite(v)) return '0.';
    const t = Number(v).toFixed(12).replace(/(\.\d*?)0+$/, '$1');
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
    entities.push(`#${did}=DIRECTION('',(${d.map((x) => toStepDir(x)).join(',')}));`);
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
  // Halbwinkel mit 12 Nachkommastellen (wie Richtungen): mit 6 lag der Rand eines langen Kegels
  // allein durch die Rundung des Winkels neben der Fläche (Fehler ≈ Mantellänge · 5e-7 / cos²α —
  // ab ~150 mm über der Toleranz strikter Importer, tests/step-strict.mjs).
  const addConicalSurface = (placId, radius, semiAngle) => {
    const sid = id++;
    entities.push(`#${sid}=CONICAL_SURFACE('',#${placId},${toStep(radius)},${toStepDir(semiAngle)});`);
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
  const vid = (p) => {
    const k = vtxKey(p), c = vkCache.get(p);                  // Nummer im vtxKey-Cache-Eintrag merken
    if (c && c.k === k && c.i !== undefined) return c.i;
    let i = vidOf.get(k);
    if (i === undefined) { i = vidKeys.length; vidOf.set(k, i); vidKeys.push(k); }
    if (c && c.k === k) c.i = i;
    return i;
  };
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

  // PINCH: Zwei Ränder EINER Fläche berühren sich in genau EINER Ecke (Loch an Loch, Loch am
  // Außenrand). Solche Flächen sind gültige STEP-Topologie, occt (Panel 4, FreeCAD) trianguliert
  // sie aber nicht (dino: eine 91-mm²-Fläche fehlte). Bisher wurde darum die GANZE Fläche als
  // Einzeldreiecke ausgegeben (Kabelhalter-Boden: 2764 Dreiecke → 2764 Flächen) — damit verlor der
  // Bogen-Pfad (profile-arcs.js) den Deckflächen-Rand und ALLE Profil-Bögen blieben facettiert.
  // Jetzt: die Dreiecke um den Berührpunkt werden abgetrennt, der Rest bleibt EINE Fläche; die
  // abgetrennten Keile werden nach Möglichkeit wieder mit dem Rest verschmolzen (s. d) — sonst
  // zerfielen die Bögen (Kreisbögen) der angrenzenden Wände in Teilstücke.
  // depth = Anzahl der Aufteilungen (ab 3 → Einzeldreiecke = garantiert gültige Ausgabe).
  const splitAtPinches = (verts, tris, normal, opts = {}, depth = 0) => {
    if (depth >= 3) return trianglesAsFaces(verts, tris, normal);        // Notfall (alte Ausgabe)
    const { directed = false, minFace = MIN_FACE_AREA, minHole = MIN_HOLE_AREA } = opts;
    // (a) Berühr-Ecken: Punkte, die in MEHREREN Rändern derselben Fläche vorkommen
    const P = new Set();
    const bEdges = boundaryEdgesOf(verts, tris);
    const dLoops = bEdges.length >= 3 ? chainDirected(bEdges) : null;
    const dFaces = dLoops && dLoops.length ? facesFromDirectedLoops(dLoops, normal, minFace, minHole) : null;
    for (const fd of dFaces || []) {
      const seen = new Map(), ls = [fd.outer, ...fd.inner];
      for (let li = 0; li < ls.length; li++) for (const p of ls[li]) {
        const k = vtxKey(p), o = seen.get(k);
        if (o !== undefined && o !== li) P.add(k);
        seen.set(k, li);
      }
    }
    if (!P.size) return trianglesAsFaces(verts, tris, normal);
    // (b) Stern um die Berühr-Ecken abtrennen, der Rest bleibt zusammen
    const star = [], rest = [];
    for (const t of tris) {
      const a = verts[t * 3], b = verts[t * 3 + 1], c = verts[t * 3 + 2];
      (P.has(vtxKey(a)) || P.has(vtxKey(b)) || P.has(vtxKey(c)) ? star : rest).push(t);
    }
    // (c) kanten-zusammenhängende Komponenten (zwei Dreiecke hängen an einer gemeinsamen Kante)
    const edgeComponents = (list) => {
      const byEdge = new Map();
      for (const t of list) {
        const a = verts[t * 3], b = verts[t * 3 + 1], c = verts[t * 3 + 2];
        for (const [p, q] of [[a, b], [b, c], [c, a]]) { const k = edgeKeyFn(p, q); const l = byEdge.get(k); if (l) l.push(t); else byEdge.set(k, [t]); }
      }
      const done = new Set(), out = [];
      for (const t of list) {
        if (done.has(t)) continue;
        const comp = [], queue = [t]; done.add(t);
        while (queue.length) {
          const cur = queue.pop(); comp.push(cur);
          const a = verts[cur * 3], b = verts[cur * 3 + 1], c = verts[cur * 3 + 2];
          for (const [p, q] of [[a, b], [b, c], [c, a]]) for (const nb of byEdge.get(edgeKeyFn(p, q)) || []) if (!done.has(nb)) { done.add(nb); queue.push(nb); }
        }
        out.push(comp);
      }
      return out;
    };
    const edgeSetOf = (list) => {
      const s = new Set();
      for (const t of list) {
        const a = verts[t * 3], b = verts[t * 3 + 1], c = verts[t * 3 + 2];
        for (const [p, q] of [[a, b], [b, c], [c, a]]) s.add(edgeKeyFn(p, q));
      }
      return s;
    };
    // (d) Die Keile des Sterns zurück in den Rest schieben: das gelingt, wenn die verschmolzene
    //     Fläche danach KEINE berührenden Ränder mehr hat (sonst wären es wieder berührende
    //     Ränder). Zuerst die am stärksten gebundenen Keile: der Rest soll zusammenbleiben, ein
    //     Spalt (ein Keil, der nur an EINER Kante hängt — das Material zwischen zwei Löchern)
    //     wird abgetrennt. Sonst zerfielen die Bögen (Kreisbögen) der angrenzenden Wände in
    //     Teilstücke, die der Bogen-Pfad (profile-arcs.js) nicht mehr bestätigen kann.
    const wouldTouch = (set) => {                     // hätte der Satz wieder berührende Ränder?
      const be = boundaryEdgesOf(verts, set);
      if (be.length < 3) return false;
      const loops = chainDirected(be);
      // Keine gerichteten Ränder (Ränder schließen nicht) → der Satz ist unsauber → nicht
      // verschmelzen (lieber zwei Flächen als eine mit berührenden Rändern).
      if (!loops || !loops.length) return true;
      const fs = facesFromDirectedLoops(loops, normal, minFace, minHole);
      return !!fs && fs.some(loopsTouch);
    };
    const groups = edgeComponents(rest).map((c) => ({ bulk: c, wedges: [], edges: edgeSetOf(c) }));
    const loose = [];
    for (const w of edgeComponents(star)) {
      const we = edgeSetOf(w);
      let best = -1, bestN = 0;
      groups.forEach((g, i) => { let n = 0; for (const k of we) if (g.edges.has(k)) n++; if (n > bestN) { bestN = n; best = i; } });
      if (best < 0) loose.push(w); else groups[best].wedges.push({ tris: w, hang: bestN });
    }
    // (e) jede Gruppe (Rest + verschmolzene Keile) und jeder abgetrennte Keil wieder als Fläche
    //     bauen (rekursiv — ein Rest-Pinch wird weiter getrennt)
    //     Sicherheitsnetz: ein Rand, der sich selbst berührt (derselbe Punkt am Anfang und am
    //     Ende) ist keine gültige Fläche (die Kettenspaltung an der Berühr-Ecke kann einen
    //     offenen Rest-Rand ergeben) → dort die Einzeldreiecke (garantiert gültig).
    const loopBroken = (fd) => {
      for (const L of [fd.outer, ...fd.inner]) {
        if (L.length < 3) return true;
        if (vtxKey(L[0]) === vtxKey(L[L.length - 1])) return true;
      }
      return false;
    };
    const buildGroup = (set) => {
      const fs = facesFromTris(verts, set, normal, sub);
      return fs.some(loopBroken) ? trianglesAsFaces(verts, set, normal) : fs;
    };
    const out = [];
    const sub = { directed, minFace, minHole, keepSrc: true, pinchDepth: depth + 1 };
    for (const g of groups) {
      let bulk = g.bulk;
      const sep = [];
      for (const w of g.wedges.slice().sort((a, b) => b.hang - a.hang)) {
        const merged = bulk.concat(w.tris);
        if (wouldTouch(merged)) sep.push(w.tris); else bulk = merged;
      }
      for (const fd of buildGroup(bulk)) out.push(fd);
      for (const w of sep) for (const fd of buildGroup(w)) out.push(fd);
    }
    for (const w of loose) for (const fd of buildGroup(w)) out.push(fd);
    // (f) FALTEN: Kanten, die im Dreieckssatz ZWEIMAL vorkommen und im Netz non-manifold sind,
    // werden nach dem Aufteilen zu Randkanten zwischen Teilflächen → eigene Kanten-Instanz.
    const inner = new Map();
    for (const t of tris) {
      const a = verts[t * 3], b = verts[t * 3 + 1], c = verts[t * 3 + 2];
      for (const [p, q] of [[a, b], [b, c], [c, a]]) { const e = edgeKeyFn(p, q); inner.set(e, (inner.get(e) || 0) + 1); }
    }
    const foldKeys = new Set();
    for (const [e, c] of inner) if (c === 2 && meshEdgeValence(e) > 2) foldKeys.add(e.replace('|', '||'));   // = edgeCanonKey
    if (foldKeys.size) {
      const fold = { id: ++foldSeq, keys: foldKeys };
      for (const fd of out) { if (fd.fold) for (const k of fd.fold.keys) fold.keys.add(k); fd.fold = fold; }
    }
    return out;
  };

  // Flächen einer (kanten-zusammenhängenden) Dreiecksmenge. Jede Fläche merkt sich ihre Herkunft
  // (Dreiecke + Loop-Schnappschuss): enforcePlanarity zerlegt nur Flächen, deren Loops seither
  // unverändert sind. directed=true: immer gerichtet verketten (Teilflächen der Ebenheits-Zerlegung;
  // die brauchen keine Herkunft: keepSrc=false). pinchDepth = Anzahl der Pinch-Aufteilungen.
  const facesFromTris = (verts, tris, normal, { directed = false, minFace = MIN_FACE_AREA, minHole = MIN_HOLE_AREA, keepSrc = true, pinchDepth = 0 } = {}) => {
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
      // nur die Dreiecke um den Berührpunkt abtrennen (splitAtPinches) — der Rest der Fläche
      // bleibt EINE Fläche (sonst verliert der Bogen-Pfad den Deckflächen-Rand).
      if (faces && faces.some(loopsTouch)) faces = splitAtPinches(verts, tris, normal, { directed, minFace, minHole, keepSrc }, pinchDepth);
    }
    if (!faces || !faces.length) faces = facesFromUndirected(boundaryEdges, normal);
    if (keepSrc) {
      const single = faces.length === 1;
      // Flächen aus splitAtPinches bringen ihre EIGENE Herkunft mit (pro Teilfläche) — nicht
      // überschreiben (sonst bekämen alle Teilflächen den ganzen Dreieckssatz).
      for (const fd of faces) if (!fd.src) fd.src = { verts, tris, single, outer: fd.outer.slice(), inner: fd.inner.map((L) => L.slice()) };
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
  // radialScore: flächengewichtetes Mittel von Normale·Radialrichtung über die Wandgruppen.
  const radialScore = (entry) => {
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
    return w > 0 ? s / w : 0;
  };
  const isConcaveBore = (entry) => radialScore(entry) < -0.5; // Wand: −1 (zur Achse), konvexer Mantel: +1
  // KONVEXE Voll-Zylinder (Score deutlich positiv) kommen in den Mantel-Pfad (eigene Umwandlung
  // unten: Außenwand → CYLINDRICAL_SURFACE, Ränder = Loops der Deckflächen — meist Außen-Loops, beim
  // Zapfen/der Stufenwelle auch ein Innen-Loop — oder Fasen/Kegelspitzen). Uneindeutige (dazwischen)
  // bleiben facettiert.
  const mantleById = new Map();
  for (const [k, e] of boreById) {
    const sc = radialScore(e);
    if (sc < -0.5) continue;
    boreById.delete(k);
    if (sc > 0.5) mantleById.set(k, e);
  }

  // D-Loch-Schutz (Review-Fund b): alle ECKEN eines D-Lochs (Kreis mit Sehnen-Abflachung) liegen
  // auf dem Radius — die Punktprüfungen allein sehen die Sehne nicht. Ein echter tessellierter
  // Kreis hat keine einzelne Kante, die ein Mehrfaches der übrigen überspannt; die Sehne schon.
  // Bezug ist der WINKEL-GEWICHTETE Median („typische grobe Kante“: die Kanten mindestens dieser
  // Größe decken die halbe Umrundung ab) — ein einfacher Median kippt bei Netzen mit
  // abwechselnd langen und kurzen Randkanten (block_with_hole: 179× 1.77° + 179× 0.23°) auf die
  // kurzen. Regel: größte Kante ≤ SEG_UNIFORM_FACTOR × gewichteter Median und ≤ SEG_MAX_DEG
  // (deckt auch eine Sehne über mehr als die halbe Umrundung ab). (2.05 statt 2.0: simplifyMesh
  // darf einen Zwischenpunkt entfernt haben → exakt doppelter Winkel, plus Rundung.)
  // SEG_MAX_DEG = 42° (≥ 9 Segmente) gilt für ALLE Kreis-Pfade (Bohrung scharf/Bestand, Mantel):
  // ein reguläres Achteck (45°) bleibt ein Achteck — als Kreis wäre die Fläche um 10 % falsch, und
  // der Grenzfall „genau 45°“ entschied sonst das Float-Rauschen. Feinere Tessellierungen (CAD-
  // Exporte: ≥ 16 Segmente, alle Samples ≤ 11.25°) sind nicht betroffen.
  const SEG_UNIFORM_FACTOR = 2.05;
  const SEG_MAX_DEG = 42;
  const SEG_ABS_MAX = SEG_MAX_DEG * Math.PI / 180;
  const ringAngleUniform = (ring, center, axis) => {
    const n = ring.length;
    if (n < 3) return false;
    const angs = [];
    let prev = null, total = 0;
    for (let i = 0; i <= n; i++) {
      const w = _sub3(ring[i % n], center), t = _dot3(w, axis);
      const r = [w[0] - axis[0] * t, w[1] - axis[1] * t, w[2] - axis[2] * t];
      if (prev) {
        // beide Radialvektoren ⟂ Achse → cross·axis = vorzeichenbehafteter Sinus-Anteil
        const ang = Math.abs(Math.atan2(_dot3(_cross3(prev, r), axis), _dot3(prev, r)));
        if (ang > 1e-9) { angs.push(ang); total += ang; } // deckungsgleiche Punkte überspringen
      }
      prev = r;
    }
    if (angs.length < 3) return false;
    angs.sort((a, b) => b - a); // absteigend
    let cum = 0, wMed = angs[angs.length - 1];
    for (const a of angs) { cum += a; if (cum >= total / 2) { wMed = a; break; } }
    return angs[0] <= SEG_ABS_MAX && angs[0] <= SEG_UNIFORM_FACTOR * wMed;
  };

  // Rand-Loops → 2 koaxiale Rand-Kreise auf dem Primitiv-Zylinder (gemeinsamer Kern von
  // attemptBore und attemptBoreCurrent). null bei jeder Abweichung (Fallback: facettiert).
  const BORE_RIM_TOL = (R) => Math.max(0.08, 0.06 * R); // Form-Toleranz Rand-Loops ↔ Primitiv (Bestandspfad)
  const rimsFromLoops = (loops, prim) => {
    if (loops.length !== 2) return null; // v1: nur Durchgangslöcher
    const axis = _norm3(prim.axis), ap = prim.axisPoint, R = prim.radius;
    const tol = BORE_RIM_TOL(R);
    const refDir = computeRefDir(axis);
    const meas = [];
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
      if (!ringAngleUniform(loop, center, axis)) return null; // D-Loch (Sehne) → kein Zylinder
      meas.push({ center, meanT, loopR: sr / loop.length, ring: loop, maxSeg: ringMaxSeg(loop, center, axis) });
    }
    // Radius der Kreiskanten: der GEMESSENE Rand-Radius (Mittel der Achsabstände beider Ringe), wenn
    // beide Ringe übereinstimmen — die Ecken eines tessellierten Kreises liegen exakt auf ihm. Der
    // Fit des Primitivs enthält an verrundeten Mündungen zusätzlich die ersten, fast senkrechten
    // Verrundungsfacetten (S1-Körper: Fit R 4.0048 statt 4.0 → Loch 0.12 % zu weit). Weichen die
    // Ringe voneinander ab, bleibt der Fit (wie bisher). loopR bleibt je Ring die Referenz für den
    // Direkt-Abgleich.
    const rTol = Math.max(0.01, 0.002 * R);
    const Rc = Math.abs(meas[0].loopR - meas[1].loopR) <= rTol ? (meas[0].loopR + meas[1].loopR) / 2 : R;
    // ring/maxSeg: Rand-Polygon und sein größter Segmentwinkel — für die Wand-Prüfung (boreWallOk) und
    // die Achs-Verfeinerung an den Deckebenen (refineBoreRims)
    const rims = meas.map(({ center, meanT, loopR, ring, maxSeg }) => ({
      center, axis, radius: Rc, refDir, meanT, loopR, ring, maxSeg,
      rimKey: `${fixZero(center[0], 3)},${fixZero(center[1], 3)},${fixZero(center[2], 3)}|${fixZero(Rc, 3)}`,
    }));
    rims.sort((a, b) => a.meanT - b.meanT); // [unten, oben]
    if (rims[0].rimKey === rims[1].rimKey) return null; // null-Höhe / kollabiert
    return rims;
  };
  // Größter Segmentwinkel (rad) eines Rand-Polygons um die Achse (deckungsgleiche Punkte zählen nicht)
  const ringMaxSeg = (ring, center, axis) => {
    let m = 0;
    const rad = (p) => { const w = _sub3(p, center), t = _dot3(w, axis); return [w[0] - axis[0] * t, w[1] - axis[1] * t, w[2] - axis[2] * t]; };
    for (let i = 0; i < ring.length; i++) {
      const a = rad(ring[i]), b = rad(ring[(i + 1) % ring.length]);
      m = Math.max(m, Math.abs(Math.atan2(_dot3(_cross3(a, b), axis), _dot3(a, b))));
    }
    return m;
  };
  // Wand einer Bohrung gegen den Zylinder aus ihren beiden Rand-Kreisen prüfen (gemeinsam für den scharfen
  // Pfad und den Bestandspfad attemptBore/attemptBoreCurrent; Gegenstück zur Mantel-Prüfung):
  //   - jeder Wand-Punkt (Ecken der Polygone `loops` und Zusatzpunkte `pts`, z. B. Original-Dreiecke einer
  //     Fläche) liegt axial zwischen den Rändern und radial zwischen Sehnen-Polygon und Mantel:
  //     ρ ∈ [R·cos(maxSeg/2) − tol, R + tol];
  //   - keine Wand-Kante überspannt um die Achse mehr als einen Randsegment-Winkel (loopsSpanOk) — sonst ist
  //     die Wand verdrillt (Hyperboloid, Taille innen): verdrillte Bohrung 30° wurde als Zylinder exportiert,
  //     wasserdicht und strikt sauber, aber 17 mm³ zu viel Loch.
  // rims = [unten, oben] (gleicher Radius, gleiche Achse). tol: Form-Toleranz des Pfads — scharfer Pfad
  // max(0.01, 0.002·R); der Bestandspfad behält seine Rand-Toleranz BORE_RIM_TOL (sein Primitiv-Kern
  // enthält an verrundeten Mündungen die erste Verrundungsreihe: washer_filleted Kern ρ 5.000 … 5.034,
  // Ränder bei 5.034 — strenger würde die bisherige Umwandlung mit Kegel-Fasen verlieren). → bool
  const boreWallOk = (rims, loops, pts, tol) => {
    const axis = rims[0].axis, c0 = rims[0].center, R = rims[0].radius;
    const H = _dot3(_sub3(rims[1].center, c0), axis);
    const maxSeg = Math.max(rims[0].maxSeg || 0, rims[1].maxSeg || 0);
    if (!(maxSeg > 0) || !(H > 0) || !(tol > 0)) return false;
    const rLo = R * Math.cos(maxSeg / 2) - tol, rHi = R + tol;
    const off = (p) => {
      const w = _sub3(p, c0), t = _dot3(w, axis);
      if (t < -tol || t > H + tol) return true;
      const rho = Math.hypot(w[0] - axis[0] * t, w[1] - axis[1] * t, w[2] - axis[2] * t);
      return !(rho >= rLo && rho <= rHi);
    };
    for (const L of loops) for (const p of L) if (off(p)) return false;
    for (const p of pts) if (off(p)) return false;
    return loopsSpanOk(loops, c0, axis, maxSeg, tol);
  };
  // Wand aus faceDefs-Indizes: Loops der aktuellen Flächen + Ecken ihrer Original-Dreiecke (Innenpunkte,
  // s. srcPointsOk) → { loops, pts } für boreWallOk
  const wallOfFaces = (fis) => {
    const loops = [], pts = [];
    for (const fi of fis) {
      const fd = faceDefs[fi];
      loops.push(fd.outer, ...fd.inner);
      const s = fd.src;
      if (s && s.verts && s.tris) for (const t of s.tris) for (let j = 0; j < 3; j++) pts.push(s.verts[t * 3 + j]);
    }
    return { loops, pts };
  };

  // Rand-Geometrie aus der Vereinigung der Facetten extrahieren: Randkanten (genau 1× genutzt)
  // → geschlossene Loops. Durchgangsloch = genau 2 koaxiale Rand-Kreise; sonst Fallback (null).
  const attemptBore = (entry) => {
    const ec = new Map(), tris = [];
    for (const g of entry.groups) {
      const vs = g.vertices, tc = Math.floor(vs.length / 3);
      for (let t = 0; t < tc; t++) {
        const tri = [vs[t * 3], vs[t * 3 + 1], vs[t * 3 + 2]];
        tris.push(tri);
        for (const [a, b] of [[tri[0], tri[1]], [tri[1], tri[2]], [tri[2], tri[0]]]) {
          const k = edgeKeyFn(a, b); const e = ec.get(k) || { c: 0, a, b }; e.c++; ec.set(k, e);
        }
      }
    }
    const bnd = []; for (const e of ec.values()) if (e.c === 1) bnd.push({ v0: e.a, v1: e.b });
    const rims = rimsFromLoops(chainEdges(bnd), entry.prim);
    if (!rims) { boreFailWhy.set(entry, 'rims'); return null; }   // kein einfaches Durchgangsloch
    const wall = { loops: tris, pts: [] };                       // Wand = Original-Dreiecke
    if (!boreWallOk(rims, wall.loops, wall.pts, BORE_RIM_TOL(rims[0].radius))) { boreFailWhy.set(entry, 'wall'); return null; }   // verdrillt / Delle → facettiert
    return { prim: entry.prim, rims, groups: entry.groups, surfCenter: rims[0].center, wall, entry };
  };

  // Wie attemptBore, aber die Ränder kommen aus den AKTUELLEN Wand-faceDefs statt aus den
  // Original-Dreiecken (Review-Fund a): hat v2 eine Mündung geschärft, existiert der alte Rand
  // (an der Verrundungs-Tangente) nicht mehr — er traf weder direkt (axial verschoben) noch als
  // Fase (gleicher Radius), und die Bohrung blieb KOMPLETT facettiert (gemischte Mündungen:
  // eine geschärft, eine echte Fase). Der Rand der aktuellen Wandflächen liegt dagegen genau
  // dort, wo die Wand heute endet: geschärft → in der Deckebene (Direkt-Treffer), echte Fase →
  // an der Fasen-Unterkante (Kegel-Pfad). Für unveränderte Wände identisch zu attemptBore.
  const attemptBoreCurrent = (entry, fdsOfGroup) => {
    const fis = new Set();
    for (const g of entry.groups) for (const fi of (fdsOfGroup.get(g) || [])) fis.add(fi);
    if (!fis.size) return null;
    const ec = new Map();
    for (const fi of fis) {
      const fd = faceDefs[fi];
      for (const L of [fd.outer, ...fd.inner]) {
        if (L.circleRim) return null;
        for (let i = 0; i < L.length; i++) {
          const a = L[i], b = L[(i + 1) % L.length];
          if (vtxKey(a) === vtxKey(b)) continue;
          const k = edgeKeyFn(a, b); const e = ec.get(k) || { c: 0, a, b }; e.c++; ec.set(k, e);
        }
      }
    }
    const bnd = []; for (const e of ec.values()) if (e.c === 1) bnd.push({ v0: e.a, v1: e.b });
    const rims = rimsFromLoops(chainEdges(bnd), entry.prim);
    if (!rims) return null;
    const wall = wallOfFaces(fis);
    if (!boreWallOk(rims, wall.loops, wall.pts, BORE_RIM_TOL(rims[0].radius))) return null;     // verdrillt / Delle → facettiert
    return { prim: entry.prim, rims, groups: entry.groups, surfCenter: rims[0].center, wall, entry };
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
  // Liegt der Kreis (center, R, ⟂ axis) in der Ebene der Deckfläche, wie assemble() sie emittiert
  // (PLANE durch fd.centroid, Normale fd.normal)? Strikte Importer prüfen „Rand liegt auf der
  // Fläche“ (tests/step-strict.mjs: 1e-4 mm). Gefährdet sind Kreise, deren Achse nicht von genau
  // dieser Deckfläche stammt: Primitiv-Fit (Bestandspfad) oder die Gegenseite im scharfen Pfad
  // (Parallel-Gate erlaubt ~0.8° → Abweichung R·sin δ). Toleranz: 1e-5 mm bzw. die eigene
  // Ebenheit der Deckfläche (Float32-Rauschen großer Koordinaten), falls größer — der Kreis darf
  // nicht schlechter liegen als die Polygon-Punkte, die er ersetzt. Geprüft an 8 Kreispunkten.
  const CIRCLE_PLANE_TOL = 1e-5; // mm
  const circleOnDeck = (center, R, axis, fd) => {
    const n = _norm3(fd.normal), u = computeRefDir(axis), v = _norm3(_cross3(axis, u));
    let tol = CIRCLE_PLANE_TOL;
    for (const L of [fd.outer, ...fd.inner]) for (const p of L) tol = Math.max(tol, Math.abs(_dot3(_sub3(p, fd.centroid), n)));
    for (let k = 0; k < 8; k++) {
      const a = k * Math.PI / 4, ca = R * Math.cos(a), sa = R * Math.sin(a);
      const p = [center[0] + u[0] * ca + v[0] * sa, center[1] + u[1] * ca + v[1] * sa, center[2] + u[2] * ca + v[2] * sa];
      if (!(Math.abs(_dot3(_sub3(p, fd.centroid), n)) <= tol)) return false;
    }
    return true;
  };
  // Freigang der Kreis-Umwandlung (Review-Fund): der Kreis durch die Polygon-Ecken ragt um die
  // Pfeilhöhe R·(1−cos(π/n)) über das Netz-Polygon (bei 42°-Segmenten bis 0.066·R). Bei dünnem Steg
  // schnitt er so einen Nachbar-Loop der Deckfläche (zweite Bohrung, Plattenkante, Außenmantel) —
  // Loops und Zylinder durchdrangen sich, die Datei blieb aber wasserdicht (Wächter 0, occt −33 %).
  // Der Kreis (center, R, ⟂ axis, in der Ebene von fd), der `loop` von fd ersetzen soll, muss darum zu
  // allen ANDEREN Loops der Fläche mindestens CIRCLE_CLEAR_TOL Abstand halten und richtig liegen: ein
  // Loch-Kreis im Außen-Loop und außerhalb der übrigen Löcher, ein Außenkreis (Mantel) um alle Löcher
  // herum. Bereits gesetzte Kreise (circleRim) zählen exakt als Kreis. Scheitert es → facettiert lassen.
  const CIRCLE_CLEAR_TOL = 0.01; // mm (= distance_accuracy_value der STEP-Datei)
  const circleClear = (center, R, axis, fd, loop) => {
    if (!fd || !(R > 0)) return false;
    const to2 = projector2d(_norm3(fd.normal), center);      // Kreismittelpunkt → Ursprung
    const isOuter = loop === fd.outer, tol = CIRCLE_CLEAR_TOL;
    // Abstand der Kreislinie (Ursprung, R) zur Strecke a–b: die Abstände der Streckenpunkte zum
    // Ursprung bilden das Intervall [dmin, dmax]
    const segDist = (a, b) => {
      const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
      const t = l2 > 0 ? Math.max(0, Math.min(1, -(a[0] * dx + a[1] * dy) / l2)) : 0;
      const dmin = Math.hypot(a[0] + t * dx, a[1] + t * dy), dmax = Math.max(Math.hypot(a[0], a[1]), Math.hypot(b[0], b[1]));
      return R < dmin ? dmin - R : (R > dmax ? R - dmax : 0);
    };
    for (const L of [fd.outer, ...fd.inner]) {
      if (L === loop) continue;
      const otherOuter = L === fd.outer;
      let P2;
      if (L.circleRim) {
        const g = L.circleRim;
        if (!g.kind || g.kind === 'circle') {
          const c2 = to2(g.center), d = Math.hypot(c2[0], c2[1]), Rg = g.radius;
          if (isOuter) { if (!(d + Rg <= R - tol)) return false; }        // Loch-Kreis im Außenkreis
          else if (otherOuter) { if (!(d + R <= Rg - tol)) return false; } // im Außenkreis (Mantel)
          else if (!(d >= R + Rg + tol)) return false;                     // zwei Löcher disjunkt
          continue;
        }
        P2 = rimPoints(g).map(to2);                                         // Kanal-Mündung (Ellipse/B-Spline)
      } else P2 = L.map(to2);
      if (P2.length < 3) continue;
      for (let i = 0; i < P2.length; i++) if (segDist(P2[i], P2[(i + 1) % P2.length]) < tol) return false;
      if (isOuter) { if (!P2.every((p) => Math.hypot(p[0], p[1]) < R)) return false; }       // Loch im Kreis
      else if (otherOuter) { if (!pointInPoly2d([0, 0], P2)) return false; }                 // Kreis im Außen-Loop
      else if (Math.hypot(P2[0][0], P2[0][1]) < R || pointInPoly2d([0, 0], P2)) return false; // Löcher disjunkt
    }
    return true;
  };
  // Freigang beider Rand-Kreise eines Plans an seinen Deck-Loops (scharfe Bohrung, Außenmantel)
  const rimsClear = (rims, decks) => rims.every((rim, r) => {
    const fd = faceDefs.find((f) => f.outer === decks[r] || f.inner.includes(decks[r]));
    return circleClear(rim.center, rim.radius, rim.axis, fd, decks[r]);
  });
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
    // Form-Toleranz aus attemptBore. Axial muss JEDER Punkt in der Rand-Ebene liegen (Review-
    // Fund c): der Schwerpunkt allein ließ bis ~10° geneigte Deckflächen (Keil, schräge Bohrung)
    // durch — der Kreis lag dann nicht in der Deckebene, der Mantel ragte um R·tanα über.
    const radTol = Math.max(0.1, 0.06 * rim.radius);
    const loopR = Number.isFinite(rim.loopR) ? rim.loopR : rim.radius;
    let sr = 0;
    for (const p of loop) {
      const w = _sub3(p, rim.center), along = _dot3(w, rim.axis);
      if (Math.abs(along) > RIM_AXIAL_TOL) return false;
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
  // Diagnose je Bohrung: prim.id → Ergebnis/Grund ('ok:through', 'ok:blind-flat', 'ok:blind-tip',
  // 'blind:<Gate>' — Gates: 'nowall' (keine Wandflächen übrig), 'wall', 'edges', 'rings:<n>', 'nodeck',
  // 'through', 'fit', … — sowie 'clear'). Nur für die Fehlersuche (Report boreNotes) — ohne Einfluss
  // auf den Export.
  let boreNotes = new Map();
  let chamferZones = [];
  // Gruppen, deren Facetten eine Chamfer-Zone verdrängt hat (filterChamferZones) —
  // Beweismaterial für den Orientierungs-Wächter der Kegel-Flächen (assemble).
  let chamferDroppedGroups = new Set();
  // Achs-Verfeinerung an den Deckebenen (Bestandspfad): rimsFromLoops nimmt Achse und Zentrum aus dem
  // Primitiv-Fit. Schon 2.6e-6 rad Kippung oder 2 µm Versatz (Senkung r=1/rw=0.3, gedrehte Lagen, weit vom
  // Ursprung) lassen den Kreis neben der Deckebene liegen → circleOnDeck (1e-5 mm) lehnt Bohrungen ab, die v2
  // exakt geschärft hat. Wie im scharfen Pfad: Achse = Normale der Deckfläche(n), an denen die Ränder enden
  // (Direkt-Treffer: Innen-Loop am Rand; Fase: koaxialer Flach-Kreis), Zentren und Radius = Kreis-Fit der
  // Rand-Polygone in der Deckebene. Danach dieselben harten Gates: Ränder eben und auf dem Kreis, koaxial,
  // gleicher Radius, Wand auf dem Zylinder (boreWallOk). → verfeinerte Ränder | null (dann bleibt der Fit)
  const DECK_AXIS_COS = Math.cos(1 * Math.PI / 180);   // Deck-Normale ↔ Primitiv-Achse (≤ 1°)
  const refineBoreRims = (plan) => {
    const rims = plan.rims, ax0 = rims[0].axis;
    if (!plan.wall || rims.length !== 2 || !rims[0].ring || !rims[1].ring) return null;
    const normals = [];
    for (const rim of rims) {
      for (const fd of faceDefs) {
        const n = _norm3(fd.normal);
        if (Math.abs(_dot3(n, ax0)) < DECK_AXIS_COS) continue;
        for (const inner of fd.inner) {
          if (inner.circleRim) continue;
          let deck = innerMatchesRim(inner, fd.normal, rim);
          if (!deck && DEFEATURE) {
            const circ = loopAsCircle(inner, fd.normal, rim.axis, rim.center);
            deck = !!circ && circ.radius > rim.radius + 0.02 && circ.radius <= rim.radius + CHAMFER_MAX && Math.abs(circ.meanT) >= CHAMFER_MIN && Math.abs(circ.meanT) <= CHAMFER_MAX;
          }
          if (deck) normals.push(n);
        }
      }
    }
    if (!normals.length) return null;
    // alle Kandidaten-Deckebenen parallel (wie sharpBorePlan), sonst keine eindeutige Achse
    if (normals.some((n) => Math.abs(_dot3(n, normals[0])) < 0.9999)) return null;
    const n0 = normals[0], axis = _dot3(n0, ax0) >= 0 ? n0 : [-n0[0], -n0[1], -n0[2]];
    const f0 = fitCircleInPlane(rims[0].ring, axis), f1 = fitCircleInPlane(rims[1].ring, axis);
    if (!f0 || !f1) return null;
    const R = (f0.radius + f1.radius) / 2, tol = Math.max(0.01, 0.002 * R);
    if (Math.abs(f0.radius - f1.radius) > tol) return null;
    const c0 = f0.center, H = _dot3(_sub3(f1.center, c0), axis);
    if (!(H > tol)) return null;
    const c1 = [c0[0] + axis[0] * H, c0[1] + axis[1] * H, c0[2] + axis[2] * H];
    if (Math.hypot(f1.center[0] - c1[0], f1.center[1] - c1[1], f1.center[2] - c1[2]) > tol) return null; // koaxial
    const out = [];
    for (const [r, c] of [[0, c0], [1, c1]]) {
      const ring = rims[r].ring;
      let sr = 0;
      for (const p of ring) {
        const w = _sub3(p, c), t = _dot3(w, axis), rho = Math.hypot(w[0] - axis[0] * t, w[1] - axis[1] * t, w[2] - axis[2] * t);
        if (Math.abs(t) > tol || Math.abs(rho - R) > tol) return null; // Rand eben in der Deckebene, auf dem Kreis
        sr += rho;
      }
      const d = mkCircleDesc(c, R, axis);
      out.push({ ...d, meanT: rims[r].meanT, loopR: sr / ring.length, ring, maxSeg: ringMaxSeg(ring, c, axis) });
    }
    if (out[0].rimKey === out[1].rimKey) return null;
    if (!boreWallOk(out, plan.wall.loops, plan.wall.pts, BORE_RIM_TOL(R))) return null;
    return out;
  };
  const matchBorePlans = (tentative, restore) => {
    // Ränder eines Plans den Deckflächen zuordnen → matched | null (ohne Seiteneffekte)
    const matchRims = (rims) => {
      const matched = []; const claimed = new Set();
      for (const rim of rims) {
        // (1) direkter Treffer — der Kreis muss zudem IN der Ebene der Deckfläche liegen (ohne
        // Verfeinerung ist die Kreis-Achse die des Primitiv-Fits; ein leicht gekippter Fit stünde sonst
        // neben der Deckfläche → strikte Importer verwerfen die Fläche)
        let hit = null;
        for (const fd of faceDefs) { for (const inner of fd.inner) { if (inner.circleRim || claimed.has(inner)) continue; if (innerMatchesRim(inner, fd.normal, rim) && circleOnDeck(rim.center, rim.radius, rim.axis, fd) && circleClear(rim.center, rim.radius, rim.axis, fd, inner)) { hit = inner; break; } } if (hit) break; }
        if (hit) { claimed.add(hit); matched.push({ rim, inner: hit, mode: 'direct' }); continue; }
        // (2) Chamfer: koaxialer Kreis R2>R, axial nahe (|dz| ≤ CHAMFER_MAX) — nur mit Defeaturing-Toggle
        //     Kabelhalter-Befund „Kegel über Kreuz“: in einer dünnen Platte (3 mm) mit Senkung an
        //     einem Ende und Fase am anderen griff der Rand am OBEREN Ende die Mündungs-Kreise am
        //     UNTEREN Deck (dz zeigte zurück DURCH die Bohrung) und umgekehrt — beide Kegel
        //     kreuzten die Bohrung, jeder Rand-Kreis war zweimal in derselben Richtung belegt
        //     (Orientierungsfehler) → globaler Fallback, alles facettiert.
        //     (a) Richtungsgate: der Flach-Kreis muss axial AUSSERHALB dieses Randes liegen, also
        //         auf der vom Bohrungs-Weg abgewandten Seite: dz * dot(rim.center − other.center,
        //         rim.axis) > 0. Bei rims.length ≠ 2 bleibt das alte Verhalten (kein Gate).
        //     (b) Es zählt der NÄCHSTE gültige Kandidat (kleinstes |dz|), nicht der zuerst gefundene:
        //         sonst reißt ein weiter entfernter Kreis dem Rand die eigentliche Fase weg.
        let cham = null;
        if (!DEFEATURE) return null;
        const otherRim = rims.length === 2 ? rims.find(r => r !== rim) : null;
        const outward = otherRim ? _dot3(_sub3(rim.center, otherRim.center), rim.axis) : 0;
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
            if (otherRim && !(dz * outward > 0)) continue;               // (a) außerhalb der Bohrung
            if (!circleOnDeck(circ.center, circ.radius, rim.axis, fd)) continue; // Flach-Kreis in der Deckebene
            if (!circleClear(circ.center, circ.radius, rim.axis, fd, inner)) continue; // … und mit Freigang
            if (!cham || Math.abs(dz) < Math.abs(cham.dz)) cham = { inner, circ, dz }; // (b) nächster Kandidat
          }
        }
        if (cham) { claimed.add(cham.inner); matched.push({ rim, inner: cham.inner, mode: 'chamfer', circ: cham.circ, dz: cham.dz }); continue; }
        return null;
      }
      return matched;
    };
    for (const plan of tentative) {
      // erst mit den an den Deckebenen verfeinerten Rändern, sonst mit denen aus dem Primitiv-Fit
      let matched = null;
      const refined = refineBoreRims(plan);
      if (refined) {
        matched = matchRims(refined);
        if (matched) { plan.rims = refined; plan.surfCenter = refined[0].center; }
      }
      if (!matched) matched = matchRims(plan.rims);
      if (!matched) { restore(plan); continue; }
      plan.coneRims = [];
      let firstRim = true;
      for (const m of matched) {
        const isFirst = firstRim; firstRim = false;
        if (m.mode === 'direct') {
          // Test-Hook 'bore': der ERSTE Rand des Plans bleibt ungetaggt → die Kreis-Kante wird nur
          // vom Zylinder genutzt (offene Kreis-Kante) → die Hülle reißt an dieser Bohrung auf.
          if (!(isFirst && breakNow('bore', [plan.entry]))) m.inner.circleRim = m.rim;
          continue;
        }
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
        if (fd.outer.circleRim || fd.inner.some(l => l.circleRim)) return true; // gematchte Flach-/Deckfläche behalten
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
  // ---- Rückfall je Merkmal (Entrundung) ----
  // Jede angewandte Entrundung (v1-Fillet, v2-Band, v2b-Ecke) wird als Operation registriert: welche
  // Rundungs-Gruppen sie entfernt hat, die Punkt-Schlüssel der entfernten Facetten und der neu gesetzten
  // Punkte, und an den veränderten Flächen die Marke fd.ops. Öffnet der Zusammenbau die Hülle, lassen
  // sich die Operationen an den offenen Kanten bestimmen (featureCulprits) — NUR deren Rundungen werden
  // gesperrt (blockedGroups, bleiben facettiert) und der Ablauf neu gebaut, statt alles zu facettieren.
  // blockedGroups gilt für alle weiteren Läufe dieses Exports (auch die Fallback-Stufen).
  const blockedGroups = new Set();
  // ---- Rückfall je Bohrung ----
  // Wie blockedGroups je Entrundungs-Gruppe, aber je Bohrung: der boreById-Eintrag (Plan + Wände)
  // bleibt FACETTIERT, wenn seine Umwandlung die Hülle aufreißt (offene Kreis-Kante, Wächter-Befund
  // an Zylinder oder Fasen-Kegel). Die übrigen Bohrungen bleiben analytisch.
  const blockedBores = new Set();  // boreById-Einträge, die facettiert bleiben (Rückfall je Bohrung)
  let featureOps = [];
  // Gesperrt = Rückfall je Merkmal (blockedGroups) ODER Biegungs-Gruppe (Blech-Biegung bleibt
  // rund, s. bendGroups). bendGroups steht in einem EIGENEN Set: blockedGroups wird im Rückfall
  // (buildStage) geleert und wiederhergestellt — die Biegungen bleiben dabei IMMER ausgenommen.
  const isBlocked = (groups) => { for (const g of groups) if (g && (blockedGroups.has(g) || bendGroups.has(g))) return true; return false; };
  const markOp = (fd, op) => { if (!fd.ops) fd.ops = new Set(); fd.ops.add(op); };
  const addLoopKeys = (set, fd) => { for (const L of [fd.outer, ...fd.inner]) if (!L.circleRim) for (const p of L) set.add(vtxKey(p)); };
  // Test-Hook (nur Node, tests/orientation-guard.mjs): STLREV_TEST_BREAK='v1'|'v2'|'v2b' verdirbt die
  // erste angewandte Operation dieser Art (eine Nachbarfläche wird nicht nachgezogen → offene Hülle) —
  // dieselbe Rundung in jedem weiteren Lauf, bis sie gesperrt ist.
  // STLREV_TEST_BREAK='bore' verdirbt die erste umgewandelte Bohrung: ihr erster Mündungs-Rand
  // bleibt ohne circleRim-Tag → die Kreis-Kante wird nur vom Zylinder genutzt (offene Kreis-Kante) →
  // die Hülle reißt an dieser Bohrung auf. Der Eintrag (boreById) bleibt dabei derselbe.
  const TEST_BREAK = testEnv('STLREV_TEST_BREAK');
  let brokenGroup = null;
  const breakNow = (kind, groups) => {
    if (TEST_BREAK !== kind || !groups.length) return false;
    if (!brokenGroup) brokenGroup = groups[0];
    return groups.includes(brokenGroup);
  };

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
      // Fasen-Enden einer Kanten-Verrundung (Kabelhalter: r=1-Kanten der Platte, an beiden Enden läuft
      // die 45°-Fase der Stirnfläche um die Rundung herum — ein facettierter Kegel). Scharf heißt dort:
      // die Fase der Fläche A (CA) und die der Fläche B (CB) treffen sich auf einer Gehrung von
      // P1 = A ∩ B ∩ CA (= A ∩ B ∩ CB, sonst kein einfacher Fall) bis P2 = CA ∩ CB ∩ E (E = Stirnfläche,
      // ⊥ zur Kante). Je Ende: die Fasen-Facetten CF (schräg, über Kanten verbunden, zwischen Rundungs-
      // Ende und Stirnfläche) entfallen, ihre Punkte in E werden zu P2. Jeder CF-Punkt liegt entweder
      // auf dem Rundungs-Ende oder in E, die Nachbarn von CF sind genau CA, CB und E (echte Ebenen),
      // P1 liegt am Rundungs-Ende, P2 in Fasen-Tiefe — sonst null (Rundung bleibt facettiert).
      const chamferEnds = (A, B, p0, dir, tLo, tHi, obliques, own, domPlane, rf, tolM, fAp, fAxis) => {
        const tOf = (v) => _dot3(_sub3(v, p0), dir);
        const perpOf = (v) => { const w = _sub3(v, fAp), al = _dot3(w, fAxis); return Math.hypot(w[0] - fAxis[0] * al, w[1] - fAxis[1] * al, w[2] - fAxis[2] * al); };
        const endOf = (g) => { let s = 0; for (const v of g.vertices) s += tOf(v); s /= g.vertices.length; return Math.abs(s - tLo) <= Math.abs(s - tHi) ? 0 : 1; };
        const tE = [tLo, tHi], sgn = [-1, 1];
        const oblique = (g) => { const d = Math.abs(_dot3(_norm3(g.normal), fAxis)); return d > 0.3 && d < 0.8; };
        let depth = 0;
        for (const g of obliques) { const e = endOf(g); for (const v of g.vertices) depth = Math.max(depth, (tOf(v) - tE[e]) * sgn[e]); }
        if (!(depth > 1e-3) || depth > 2 * rf) return null;
        const inZone = (g, e) => g.vertices.every((v) => { const dt = (tOf(v) - tE[e]) * sgn[e]; return dt >= -1e-3 && dt <= depth + 1e-3 && perpOf(v) <= rf + tolM; });
        // Schräge Nachbarn ganz in der Eckzone = Kegel-Facetten (CF); reicht eine darüber hinaus, ist es
        // eine Fasen-Ebene, der das Region-Growing die erste, fast tangentiale Kegel-Facette zugeschlagen hat.
        const cf = new Set(), cfEnd = new Map(), stack = [], planeCand = [];
        for (const g of obliques) { const e = endOf(g); if (!inZone(g, e)) { planeCand.push(g); continue; } cf.add(g); cfEnd.set(g, e); stack.push(g); }
        const edgesOf = (g) => { const vs = g.vertices, out = []; for (let t = 0; t + 2 < vs.length; t += 3) out.push([vs[t], vs[t + 1]], [vs[t + 1], vs[t + 2]], [vs[t + 2], vs[t]]); return out; };
        while (stack.length) {
          const g = stack.pop(), e = cfEnd.get(g);
          for (const [a, b] of edgesOf(g)) for (const h of edgeToGroups.get(edgeKeyFn(a, b)) || []) {
            if (cf.has(h) || own.has(h) || !oblique(h) || !inZone(h, e)) continue;
            cf.add(h); cfEnd.set(h, e); stack.push(h);
          }
        }
        const isA = new Set(A.groups), isB = new Set(B.groups);
        const touches = (g, set) => { for (const [a, b] of edgesOf(g)) for (const h of edgeToGroups.get(edgeKeyFn(a, b)) || []) if (set.has(h)) return true; return false; };
        const ends = [], allowed = new Set();
        for (const e of [0, 1]) {
          const mine = [...cf].filter((g) => cfEnd.get(g) === e);
          if (!mine.length) return null;                                  // Fase nur an einem Ende: kein einfacher Fall
          const nb = new Set(planeCand.filter((g) => endOf(g) === e));
          for (const g of mine) for (const [a, b] of edgesOf(g)) for (const h of edgeToGroups.get(edgeKeyFn(a, b)) || []) if (!cf.has(h) && !own.has(h)) nb.add(h);
          let E = null, CA = null, CB = null;
          const put = (cur, g) => { if (!cur) return { ref: g, gs: [g] }; cur.gs.push(g); if (g.vertices.length > cur.ref.vertices.length) cur.ref = g; return cur; };
          for (const h of nb) {
            if (isA.has(h) || isB.has(h)) continue;                       // die Seiten selbst (über eine Ecke)
            if (Math.abs(_dot3(_norm3(h.normal), dir)) >= Math.cos(Math.PI / 180)) { E = put(E, h); continue; }
            const ta = touches(h, isA), tb = touches(h, isB);
            if (ta === tb) return null;
            if (ta) CA = put(CA, h); else CB = put(CB, h);
          }
          if (!E || !CA || !CB) return null;
          const pl = {};
          for (const [nm, c] of [['E', E], ['CA', CA], ['CB', CB]]) {
            const dp = domPlane(c.ref);
            if (!dp) return null;
            for (const g of c.gs) { if (g === c.ref) continue; const dq = domPlane(g); if (!dq) return null; for (const tr of dq.sel) for (let j = 0; j < 3; j++) if (Math.abs(_dot3(dp.n, dq.vs[tr.t + j]) - dp.off) > 5e-5) return null; }
            pl[nm] = dp;
            for (const g of c.gs) allowed.add(g);
          }
          const P1 = solve3(A.n, A.off, B.n, B.off, pl.CA.n, pl.CA.off);
          if (!P1 || Math.abs(_dot3(pl.CB.n, P1) - pl.CB.off) > 2e-5) return null;  // CA und CB treffen A ∩ B im selben Punkt
          if (Math.abs(tOf(P1) - tE[e]) > 1e-3) return null;
          const P2 = solve3(pl.CA.n, pl.CA.off, pl.CB.n, pl.CB.off, pl.E.n, pl.E.off);
          if (!P2) return null;
          if (Math.abs((tOf(P2) - tE[e]) * sgn[e] - depth) > 1e-3) return null;
          // jeder Kegel-Punkt: Rundungs-Ende (Abstand r, t am Ende) oder Bogen in E (fester Abstand r2)
          const onEnd = (v) => Math.abs(perpOf(v) - rf) <= tolM && Math.abs(tOf(v) - tE[e]) <= 1e-3;
          const onE = (v) => Math.abs(_dot3(pl.E.n, v) - pl.E.off) <= 1e-4;
          let r2 = null;
          for (const g of mine) for (const v of g.vertices) {
            if (onEnd(v)) continue;
            if (!onE(v)) return null;
            const p = perpOf(v);
            if (r2 === null) r2 = p; else if (Math.abs(p - r2) > 1e-3) return null;
          }
          if (r2 === null) return null;
          // Bogenpunkte → P2: aus den Kegel-Facetten und aus Fasen-/Stirnflächen (zugeschlagene Facetten)
          const arcKeys = new Set();
          for (const g of [...mine, ...CA.gs, ...CB.gs, ...E.gs]) for (const v of g.vertices) if (onE(v) && !onEnd(v) && Math.abs(perpOf(v) - r2) <= 1e-3) arcKeys.add(vtxKey(v));
          // Fasen-Ebenen: Punkte in der Eckzone nur am Rundungs-Ende oder auf dem Bogen
          for (const g of [...CA.gs, ...CB.gs]) for (const v of g.vertices) {
            const dt = (tOf(v) - tE[e]) * sgn[e];
            if (perpOf(v) > rf + tolM || dt < -1e-3 || dt > depth + 1e-3) continue;
            if (!onEnd(v) && !arcKeys.has(vtxKey(v))) return null;
          }
          if (arcKeys.size < 2) return null;
          ends.push({ P1, P2, arcKeys });
        }
        return { cf, ends, allowed };
      };
      const defeatureOne = (entry) => {
        const prim = entry.prim;
        const fAxis = _norm3(prim.axis), fAp = prim.axisPoint, rf = prim.radius;
        const tolM = Math.max(0.1, 0.06 * rf);
        const radDev = (v) => {
          const w = _sub3(v, fAp), al = _dot3(w, fAxis);
          return Math.abs(Math.hypot(w[0] - fAxis[0] * al, w[1] - fAxis[1] * al, w[2] - fAxis[2] * al) - rf);
        };
        // Streifen = nur die Gruppen, die WIRKLICH auf dem Verrundungs-Zylinder liegen. Die Erkennung
        // schlägt dem Primitiv mitunter die tangential anschließende Ebene zu (Kabelhalter: Deckfläche
        // mit 1586 Dreiecken in der r=1-Rundung, Taschenwände in den r=0,3-Ecken) — die würde v1 sonst
        // als Teil der Rundung entfernen bzw. ihre Nachbarn für die Seiten-Ebenen halten. Solche
        // Gruppen sind hier Nachbarn (Seiten-Ebene) wie jede andere.
        const strip = entry.groups.filter((g) => g.vertices.every((v) => radDev(v) <= tolM));
        if (!strip.length || isBlocked(strip)) return false;
        const own = new Set(strip);
        // Rand-Kanten des Streifens → Nachbar-Gruppen (Gewicht = geteilte Kanten)
        const ec = new Map();
        for (const g of strip) {
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
        // Schräge Nachbarn an den Enden = Fase um die Rundung herum (s. chamferEnds).
        const clusters = [], caps = [], obliques = [];
        for (const [g, w] of nbWeight) {
          const ng = _norm3(g.normal);
          const dAx = Math.abs(_dot3(ng, fAxis));
          if (dAx > 0.3 && dAx < 0.8) { obliques.push(g); continue; }
          if (dAx >= 0.8) { caps.push(ng); continue; } // Kappe
          let cl = null;
          for (const c of clusters) if (Math.abs(_dot3(c.n, ng)) >= 0.99) { cl = c; break; }
          if (!cl) { cl = { n: ng, w: 0, ref: g, groups: [] }; clusters.push(cl); }
          cl.w += w; cl.groups.push(g); if (g.vertices.length > cl.ref.vertices.length) cl.ref = g;
        }
        if (clusters.length !== 2) return false; // gekrümmte Umgebung (viele Orientierungen) → v2
        const [A, B] = clusters;
        // Seiten = ECHTE Ebenen. Ebene je Gruppe aus ihren Dreiecken mit der Normale ihres größten
        // Dreiecks (± 0,05°, flächengewichtet; sie müssen ≥ 50 % der Gruppenfläche ausmachen) — NICHT
        // die mittlere Gruppen-Normale: das Region-Growing fasst bis 2° Knick zusammen und schlägt der
        // Wand oft die erste, fast tangentiale Facette einer Rundung zu (k1: Wand 1,2e-4 rad gekippt, die
        // neue Ecke lag 0,4 µm neben der Wand — für strikte Importer, Prüf-Toleranz 1e-4, nicht eben).
        // Eine „Wand“ aus Facetten eines flachen Bogens (Kabelhalter-Logo) hat keine solche Ebene.
        // Weitere Gruppen eines Clusters müssen in derselben Ebene liegen (5e-5 mm, float32-Eingabe).
        const FLAT_TOL = 5e-5, PLANE_COS = Math.cos(0.05 * Math.PI / 180);
        const domPlane = (g) => {
          const vs = g.vertices, tris = [];
          let big = null, aTot = 0;
          for (let t = 0; t + 2 < vs.length; t += 3) {
            const c = _cross3(_sub3(vs[t + 1], vs[t]), _sub3(vs[t + 2], vs[t]));
            const l = Math.hypot(c[0], c[1], c[2]);
            if (!(l > 0)) continue;
            const tr = { n: [c[0] / l, c[1] / l, c[2] / l], a: l / 2, t };
            tris.push(tr); aTot += tr.a;
            if (!big || tr.a > big.a) big = tr;
          }
          if (!big) return null;
          const sel = tris.filter((tr) => _dot3(tr.n, big.n) >= PLANE_COS);
          let sx = 0, sy = 0, sz = 0, aSel = 0;
          for (const tr of sel) { sx += tr.n[0] * tr.a; sy += tr.n[1] * tr.a; sz += tr.n[2] * tr.a; aSel += tr.a; }
          if (aSel < 0.5 * aTot) return null;
          let n = _norm3([sx, sy, sz]);
          if (_dot3(n, _norm3(g.normal)) < 0) n = [-n[0], -n[1], -n[2]];
          let off = 0;
          for (const tr of sel) off += tr.a * (_dot3(n, vs[tr.t]) + _dot3(n, vs[tr.t + 1]) + _dot3(n, vs[tr.t + 2])) / 3;
          return { n, off: off / aSel, sel, vs };
        };
        for (const cl of [A, B]) {
          const dp = domPlane(cl.ref);
          if (!dp) return false;
          cl.n = dp.n; cl.off = dp.off;
          for (const [g] of nbWeight) {
            if (g === cl.ref || Math.abs(_dot3(_norm3(g.normal), cl.n)) < 0.99) continue;  // Referenz / anderer Cluster / Kappe
            const dq = domPlane(g);
            if (!dq) return false;
            for (const tr of dq.sel) for (let j = 0; j < 3; j++) if (Math.abs(_dot3(cl.n, dq.vs[tr.t + j]) - cl.off) > FLAT_TOL) return false;
          }
        }
        if (Math.abs(_dot3(A.n, B.n)) > Math.cos(20 * Math.PI / 180)) return false; // fast koplanar
        // Scharfe Kante = Schnittlinie der beiden Ebenen (Richtung ≈ Fillet-Achse)
        const d0 = _cross3(A.n, B.n);
        const dl = Math.hypot(d0[0], d0[1], d0[2]);
        if (dl < 1e-6) return false;
        const dir = [d0[0] / dl, d0[1] / dl, d0[2] / dl];
        if (Math.abs(_dot3(dir, fAxis)) < Math.cos(15 * Math.PI / 180)) return false;
        // Kappen müssen SENKRECHT auf der scharfen Kante stehen (≤ 1°): ihre Bogen-Punkte kollabieren
        // unten über den Kanten-Parameter t auf die Linie — an einer SCHRÄGEN Stirnwand landeten sie an
        // verschiedenen t, also neben der Wand (Trapez mit verrundeter Ober-/Unterkante: Stirnwand
        // 0.47 mm uneben, ΔV +25 mm³ bei dichter Hülle). Solche Rundungen bleiben v2 (offenes Band).
        for (const n of caps) if (Math.abs(_dot3(n, dir)) < Math.cos(Math.PI / 180)) return false;
        const planeOff = (cl) => cl.off;
        // Verrundung = TANGENTIALER Übergang: beide Seiten-Ebenen berühren den Verrundungs-Zylinder,
        // ihr Abstand zur Achse ist genau r (CAD-Netze: Abweichung ~0). Sonst sind die „Seiten“ keine
        // Ebenen, an die die Rundung anschließt, sondern z.B. einzelne Facetten benachbarter gebogener
        // Wände (Kabelhalter: r = 0,3 in der Logo-Tasche, Abstand 0,37/0,66 statt 0,3 — der Schnitt
        // zweier Facetten lag 0,8 mm neben der Rundung, die Hülle riss auf und ALLES fiel in den
        // facettierten Rückfall). Solche Bereiche bleiben facettiert.
        const tangTol = Math.max(0.005, 0.01 * rf);
        for (const cl of [A, B]) if (Math.abs(Math.abs(_dot3(cl.n, fAp) - planeOff(cl)) - rf) > tangTol) return false;
        const p0 = solve3(A.n, planeOff(A), B.n, planeOff(B), dir, _dot3(dir, fAp));
        if (!p0) return false;
        // Streifen-Ausdehnung entlang der Linie
        let tLo = Infinity, tHi = -Infinity;
        for (const g of strip) for (const v of g.vertices) {
          const t = _dot3(_sub3(v, p0), dir); if (t < tLo) tLo = t; if (t > tHi) tHi = t;
        }
        if (!(tHi > tLo)) return false;
        const cham = obliques.length ? chamferEnds(A, B, p0, dir, tLo, tHi, obliques, own, domPlane, rf, tolM, fAp, fAxis) : null;
        if (obliques.length && !cham) return false;
        const gone = cham ? new Set([...own, ...cham.cf]) : own;     // entfallende Facetten
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
          if (gone.has(fd.group) || defeaturedGroups.has(fd.group)) continue;
          for (const loop of [fd.outer, ...fd.inner]) {
            if (loop.circleRim) continue;
            const moved = [];
            for (let i = 0; i < loop.length; i++) if (onStrip(loop[i])) moved.push(i);
            if (!moved.length) continue;
            if (moved.length >= loop.length - 1) return false; // (fast) ganze Schleife auf dem Mantel
            for (const i of moved) allT.push(_dot3(_sub3(loop[i], p0), dir));
            affected.push({ loop, movedSet: new Set(moved), fd });
          }
        }
        if (affected.length < 2 || allT.length < 4) return false;
        // Kanonische Punkte entlang der Linie (Union A-Seite/B-Seite/Kappen, snap-merge 0.05mm)
        allT.sort((a, b) => a - b);
        const canonT = [];
        for (const t of allT) { if (!canonT.length || t - canonT[canonT.length - 1] > 0.05) canonT.push(t); }
        const canonPts = canonT.map(t => [p0[0] + dir[0] * t, p0[1] + dir[1] * t, p0[2] + dir[2] * t]);
        const canonIdx = (t) => { let bi = 0, bd = Infinity; for (let i = 0; i < canonT.length; i++) { const d = Math.abs(canonT[i] - t); if (d < bd) { bd = d; bi = i; } } return bi; };
        // Fasen-Enden: der kanonische End-Punkt ist exakt die Ecke P1 (A ∩ B ∩ Fase)
        if (cham) for (const e of cham.ends) {
          const t1 = _dot3(_sub3(e.P1, p0), dir), i = canonIdx(t1);
          if (Math.abs(canonT[i] - t1) > 0.05) return false;
          canonT[i] = t1; canonPts[i] = e.P1;
        }
        // Operation registrieren (Rückfall je Merkmal): entfernte Facetten + neue Kanten-Punkte
        const op = { kind: 'v1', groups: cham ? [...strip, ...cham.cf] : strip, keys: new Set() };
        for (const fd of faceDefs) if (gone.has(fd.group)) addLoopKeys(op.keys, fd);
        for (const p of canonPts) op.keys.add(vtxKey(p));
        if (cham) for (const e of cham.ends) op.keys.add(vtxKey(e.P2));
        const sabotage = breakNow('v1', strip) ? affected[affected.length - 1] : null;
        // Loops umschreiben: zusammenhängende Runs verschobener Vertices durch die kanonische
        // Punktfolge im jeweiligen Spann ersetzen (Kappen-Bögen kollabieren auf 1 Punkt). Erst alle
        // neuen Loops berechnen, dann prüfen, dann übernehmen.
        for (const a of affected) {
          const { loop, movedSet } = a;
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
          a.out = out;
        }
        // Fasen-Enden: die Bogenpunkte der Fase auf der Stirnfläche E werden zur Ecke P2 (E ∩ CA ∩ CB);
        // betroffen sein dürfen nur E und die beiden Fasen-Ebenen (sonst bleibt die Rundung).
        if (cham) {
          const toP2 = new Map();
          for (const e of cham.ends) for (const k of e.arcKeys) toP2.set(k, e.P2);
          const outOf = new Map(affected.map((a) => [a.loop, a]));
          for (const fd of faceDefs) {
            if (gone.has(fd.group) || defeaturedGroups.has(fd.group)) continue;
            for (const loop of [fd.outer, ...fd.inner]) {
              if (loop.circleRim) continue;
              const a = outOf.get(loop), src = a ? a.out : loop;
              if (!src.some((p) => toP2.has(vtxKey(p)))) continue;
              if (!cham.allowed.has(fd.group)) return false;
              const out = [];
              for (const p of src) { const q = toP2.get(vtxKey(p)) || p; if (!out.length || vtxKey(out[out.length - 1]) !== vtxKey(q)) out.push(q); }
              while (out.length > 1 && vtxKey(out[0]) === vtxKey(out[out.length - 1])) out.pop();
              if (out.length < 3) return false;
              if (a) a.out = out; else affected.push({ loop, out, fd });
            }
          }
        }
        // Jede umgeschriebene Fläche muss danach EBEN sein (≤ PLANAR_TOL) oder von der Ebenheits-Prüfung
        // zerlegbar bleiben: Das Region-Growing schlägt einer Ebene oft fast tangentiale Facetten von
        // Rundungen zu (Kabelhalter-Deckfläche: 1,3 µm uneben) — ohne Umbau zerlegt enforcePlanarity
        // sie in exakt ebene Teile. Dafür merkt sich die Fläche den Umbau als Punkt-Abbildung + Kanten-
        // Linie (lineEdits, s. movesSinceExtraction); Voraussetzung: sie stammt als EINE Fläche aus
        // ihrer Gruppe (src.single). Bleibt sie trotzdem uneben, nimmt der Rückfall je Merkmal diese
        // Entrundung zurück (buildStage).
        const byFd = new Map();
        for (const a of affected) { let l = byFd.get(a.fd); if (!l) { l = []; byFd.set(a.fd, l); } l.push(a); }
        for (const [fd, list] of byFd) {
          const swap = (L) => { const a = list.find((x) => x.loop === L); return a ? a.out : L; };
          const tmp = { outer: swap(fd.outer), inner: fd.inner.map(swap) };
          const fit = fitPlaneLsq(tmp, _norm3(fd.normal));
          if (!fit || planeDev(tmp, fit.n, fit.c) > PLANAR_TOL) { if (!fd.src || !fd.src.single) return false; }
        }
        // Umbau als Abbildung: jeder verschobene Punkt → kanonischer Punkt seines t (bzw. P2), danach
        // Lücken entlang der Kante mit den kanonischen Zwischenpunkten füllen (= Lauf-Ersetzung oben)
        const edit = { map: new Map(), line: { p0, dir, canonT, canonPts, keys: new Set(canonPts.map(vtxKey)) } };
        for (const a of affected) {
          if (!a.movedSet) continue;
          for (const i of a.movedSet) edit.map.set(vtxKey(a.loop[i]), canonPts[canonIdx(_dot3(_sub3(a.loop[i], p0), dir))]);
        }
        if (cham) for (const e of cham.ends) for (const k of e.arcKeys) edit.map.set(k, e.P2);
        for (const a of affected) {
          if (a === sabotage) continue;
          markOp(a.fd, op);
          if (!a.fd.lineEdits) a.fd.lineEdits = [];
          if (!a.fd.lineEdits.includes(edit)) a.fd.lineEdits.push(edit);
          a.loop.length = 0; a.loop.push(...a.out);
        }
        for (const g of op.groups) defeaturedGroups.add(g);
        featureOps.push(op);
        return true;
      };
      for (const entry of filletById.values()) {
        // Biegung eines Blechprofils (Innen-/Außenbogen koaxial): bleibt per Default rund
        // (Schalter „Blech-Biegungen schärfen“); nur mit SHARPEN_BENDS wird sie geschärft.
        if (entry.groups.some((g) => bendGroups.has(g))) continue;
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
  // Konservativ: nur geschlossene Ringbänder (Loop von P komplett verrundet) oder verrundete
  // Abschnitte des Loops, die je an zwei Stirnwänden enden (offene Bänder, Rest des Loops scharf;
  // mehrere getrennte Abschnitte nur an Flächen, deren Loop schon im Netz so aussieht, s. evalLoop;
  // P und Seitenwände reichen deutlich über die Rundung hinaus — keine Zylinder-Facetten). Das
  // Band grenzt nur an P und Wände, schließt an P UND an die Wände tangential an (Verrundung —
  // keine Fase, keine Senkung), ist im Querschnitt ein Kreisbogen und schmal (Bandform, s.
  // evaluateBand); die neue Kontur muss einfach sein. Liegt zwischen Rundung und Wand ein Kegel/
  // eine Fase (Senkung mit verrundeter Kante), wird nur die Rundung geschärft, der Kegel bleibt
  // (schräge Wand, s. splitTiltedWall). Liegt der Kegel/die Fase ZWISCHEN zwei Rundungen (beide
  // Kanten verrundet) oder direkt an P (nur die Kante zur Wand verrundet), werden die Rundungen
  // geschärft und Kegel/Fase exakt bis P und bis zur Wand verlängert (s. splitMiddleLayer).
  // Jede Unsauberkeit fängt zusätzlich das Wasserdicht-Verdikt + der globale Fallback.
  // (Aufruf in runPipeline() unten.)
  let bandsDefeatured = 0;
  // Zähler für v2c (Kegel-Bänder, s. defeatureConeBands) — wird zu bandsDefeatured addiert.
  let coneBandsDefeatured = 0;
  function defeatureBands() {
    const WALL_COS = 1e-3;          // |n_W·d| ≤ … → Wand steht senkrecht auf P (CAD-Extrusion: ~1e-7)
    const PARALLEL_COS = 0.9995;    // |n·d| ≥ … → (fast) parallel zu P → kein Band-Element
    // Verrundung = TANGENTIALER Übergang. Eine mit N Segmenten tessellierte Rundung knickt an P und
    // an der Wand je um 45°/N (N ≥ 2: ≤ 22.5°; eBike ≤ 10°). Fasen knicken um 45°, Senkungen um
    // ≥ 30° (60°-Senkung; üblich 90°-Senkung → 45°). Knick > 25° an P oder an einer Wand → keine
    // Verrundung (sonst verschluckte das Band z.B. den Senkungskegel samt Rundung: Senkung weg).
    const TANGENT_COS = Math.cos(25 * Math.PI / 180), TANGENT_SIN = Math.sin(25 * Math.PI / 180);
    // Rundungsprofil (s. (5a)): Spielraum der Neigung je Punkt — deckt die µm-Verschiebung feiner
    // Rundungen (m32: erste/letzte Schicht in P bzw. Wand, ≤ 1.3°) ab; eine flache Zone weicht um
    // ≥ 20° ab (Senkung, verrundete Fase)
    const PROFILE_TOL_DEG = 3;
    // Kegel/Fase zwischen zwei Rundungen (s. splitMiddleLayer): Neigung der Lage, ihr Flächenanteil am
    // Band (billiger Vorfilter gegen Kugel-/Torus-Stücke), Mindestlänge, Treff-Toleranz
    const MID_TC_MIN = 12, MID_TC_MAX = 78;   // Grad — Mantellinie ≥ 12° gegen P (vgl. |g·d| ≥ 0.2), Rundung zur Wand ≥ 12°
    const MID_MIN_SHARE = 0.1;
    // Länge(C) / (Knick an C · Bogenradius), je Seite: echte Fase/Kegel (Knick = halber Bogenschritt)
    // = 2 × Länge in Bogenschritten — gemessen 17 (N=2) … 107; eine Facette einer STETIGEN Rundung
    // (Knick = ganzer Schritt), die f-mal so lang ist wie ihre Nachbarn: ≈ f — gemessen 3.1 … 13.4 für
    // f = 3 … 10. Ab 12 gilt die Zone als flach (Facette ≥ 12× länger = Krümmungsradius ≥ 12× größer).
    // Grenzfall bewusst konservativ: Rundung N=2, r = 1 an 1.3 mm Fase (6.6) bleibt unverändert.
    const MID_LEN_FACTOR = 12;
    // mm — Wandkante ∩ Mantellinie je Station (gemessen ≤ 1e-6 mm; die Nachbar-Station liegt R·sin(Δφ)
    // daneben: Bohrung R4/32 Seg. 0.78 mm, R1/128 Seg. 0.05 mm); trifft mehr als eine Station → keine Umwandlung
    const MID_MATCH_TOL = 2e-3;
    // offenes Band: Ausdehnung quer zur Rundung / Bandtiefe (s. (5)) — P ≥ 1, Seitenwände ≥ 0.5 (dünne
    // Platte mit Rundung oben UND unten: Steg (t − 2r)/r; Zylinder-/Bogen-Facette ≤ 0.43)
    const OPEN_MIN_DECK = 1, OPEN_MIN_SIDE = 0.5;
    const FOLD_TOL = 1e-4;          // mm — Spitze der Breite 0 (s. foldTip; = Prüf-Toleranz strikter Importer)
    const SNAP_MAX = 0.01;          // mm — größte Korrektur auf die exakten Ebenen (s. truePlane)
    const SNAP_NOISE = 5e-5;        // mm — darunter wird nicht korrigiert (float32-Rauschen, < Prüf-Toleranz 1e-4)
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
    // Polygonfläche je Fläche (Außen minus Innen), lazy — für den Saat-Vorfilter (applyBand
    // verwirft den Wert der geänderten Flächen)
    const areaCache = new Map();
    const loopArea = (L, n) => { let sx = 0, sy = 0, sz = 0; for (let i = 0; i < L.length; i++) { const c = _cross3(L[i], L[(i + 1) % L.length]); sx += c[0]; sy += c[1]; sz += c[2]; } return Math.abs(sx * n[0] + sy * n[1] + sz * n[2]) / 2; };
    const fdArea = (fi) => {
      if (!areaCache.has(fi)) { const fd = fds[fi]; let a = loopArea(fd.outer, nrm[fi]); for (const L of fd.inner) a -= loopArea(L, nrm[fi]); areaCache.set(fi, Math.max(0, a)); }
      return areaCache.get(fi);
    };
    // Exakte Ebene einer Fläche aus ihren Netz-Dreiecken → { n, c } (n·x = c) | null. Bei feinen
    // Rundungen (N ≥ 32: erste/letzte Schicht < 2°) schlägt das Region-Growing (2°/0.05 mm) den
    // tangentialen Streifen der Deckfläche bzw. der Wand zu — deren Rand liegt dann µm NEBEN der
    // echten Ebene (m32: 1.8 µm, strenge Importer: Rand neben der Fläche). Echte Ebene = die Dreiecke
    // mit der Normale des größten Dreiecks (± 0.05°), flächengewichtet; nur wenn sie die Fläche
    // dominieren (≥ 50 %). Gecacht je Fläche (die Netz-Dreiecke ändern sich nicht).
    const planeCache = new Map();
    const PLANE_COS = Math.cos(0.05 * Math.PI / 180);
    const truePlane = (fi) => {
      if (planeCache.has(fi)) return planeCache.get(fi);
      let res = null;
      const vs = fds[fi].group?.vertices;
      if (Array.isArray(vs) && vs.length >= 3) {
        const tris = [];
        let aTot = 0, big = null;
        for (let t = 0; t + 2 < vs.length; t += 3) {
          const c = _cross3(_sub3(vs[t + 1], vs[t]), _sub3(vs[t + 2], vs[t]));
          const l = Math.hypot(c[0], c[1], c[2]);
          if (!(l > 0)) continue;
          const tr = { n: [c[0] / l, c[1] / l, c[2] / l], a: l / 2, p: [(vs[t][0] + vs[t + 1][0] + vs[t + 2][0]) / 3, (vs[t][1] + vs[t + 1][1] + vs[t + 2][1]) / 3, (vs[t][2] + vs[t + 1][2] + vs[t + 2][2]) / 3] };
          tris.push(tr); aTot += tr.a;
          if (!big || tr.a > big.a) big = tr;
        }
        if (big && _dot3(big.n, nrm[fi]) > 0.99) {
          let sx = 0, sy = 0, sz = 0, aSel = 0;
          const sel = tris.filter((tr) => _dot3(tr.n, big.n) >= PLANE_COS);
          for (const tr of sel) { sx += tr.n[0] * tr.a; sy += tr.n[1] * tr.a; sz += tr.n[2] * tr.a; aSel += tr.a; }
          if (aSel >= 0.5 * aTot) {
            const n = _norm3([sx, sy, sz]);
            const p = [0, 0, 0];
            for (const tr of sel) for (let j = 0; j < 3; j++) p[j] += tr.p[j] * tr.a / aSel;
            res = { n, c: _dot3(n, p), p };
          }
        }
      }
      planeCache.set(fi, res);
      return res;
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
    // Ein Loop mit MEHREREN getrennten verrundeten Abschnitten (offene Bänder) liefert den ersten
    // anwendbaren Abschnitt; die übrigen folgen gleich danach (s. unten). Nur in Runde 0, also an den
    // Flächen, deren Loop schon im Netz so aussieht (Deckfläche mit mehreren verrundeten Kanten): erst
    // NACH dem Schärfen der Deck-Bänder bekommt eine Seitenwand zwei Abschnitte (links und rechts die
    // senkrechten Profil-Eckrundungen) — die bleiben v2b (defeatureProfileCorners).
    // gesperrte Rundungen (Rückfall je Merkmal) bleiben stehen
    // gesperrte Rundungen (Rückfall je Merkmal) und Biegungen von Blechprofilen bleiben stehen
    const bandBlocked = (plan) => { for (const fi of plan.band) if (fds[fi].group && (blockedGroups.has(fds[fi].group) || bendGroups.has(fds[fi].group))) return true; return false; };
    const evalLoop = (pi, L, multiOk) => {
      const info = { runs: 1 };
      for (let run = 0; run < info.runs; run++) { const plan = evaluateBand(pi, L, run, info, multiOk); if (plan && !bandBlocked(plan)) return plan; }
      return null;
    };
    let done = 0;
    for (let round = 0; round < 16; round++) {
      const cands = [];
      for (let pi = 0; pi < fds.length; pi++) {
        if (removed.has(pi)) continue;
        for (const L of loopsOf(fds[pi])) { const plan = evalLoop(pi, L, round === 0); if (plan) cands.push({ pi, L, plan }); }
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
          plan = evalLoop(c.pi, c.L, round === 0);         // Umgebung hat sich geändert → neu bewerten
          if (!plan) continue;
        }
        for (;;) {
          applyBand(plan);
          buildOwners();
          done++; applied++;
          touched.add(c.pi);
          for (const fi of plan.band) touched.add(fi);
          for (const fi of plan.walls) touched.add(fi);
          if (!plan.multi) break;
          plan = evalLoop(c.pi, c.L, true);                // weitere getrennte Abschnitte desselben Loops
          if (!plan) break;
        }
      }
      if (!applied) break;
    }
    if (removed.size) faceDefs = faceDefs.filter((_, i) => !removed.has(i));
    return done;

    // run: welcher der getrennten verrundeten Abschnitte von L (offene Bänder); info.runs ← Anzahl;
    // multiOk: mehrere Abschnitte zulässig (s. evalLoop)
    function evaluateBand(pi, L, run = 0, info = null, multiOk = false) {
      const P = fds[pi], d = nrm[pi];
      if (Math.hypot(d[0], d[1], d[2]) < 0.5) return null;
      // Ebenen-Offset von P (Mittel über die Loop-Punkte)
      let off = 0, cnt = 0;
      for (const p of P.outer) { off += _dot3(d, p); cnt++; }
      off /= cnt;
      {
        // (1) Jede Kante von L muss an GENAU eine Band-Fläche grenzen — und zwar tangential (Knick
        //     ≤ 25°, s. TANGENT_COS): eine Fase oder Senkung an P ist keine Verrundung. Offenes Band:
        //     ist nur EIN zusammenhängender Abschnitt von L verrundet, grenzt der Rest direkt an
        //     Wände ⊥ P (scharfe Kanten) — die beiden Wände an den Enden des Abschnitts sind die
        //     Stirnwände, auf denen das Band mit seinem Rundungsprofil endet (s. (4)).
        const Ledges = new Set();      // Kanten des verrundeten Abschnitts
        const seeds = new Set();
        const lNb = [];                // je Kante von L: Nachbarfläche, Band-Kante?
        let ok = true, lenL = 0;
        // Nicht tangentiale Nachbarn (Knick > 25°): nur als Kegel-/Fasenlage direkt an P zulässig (scharfe
        // Senkungs-/Fasenkante oben, Rundung erst zur Wand hin, s. splitMiddleLayer) — dann grenzt der
        // GANZE Loop an Facetten EINER Neigung (± 0.5°, höchstens MID_TC_MAX); sonst Abbruch an der
        // ersten unpassenden Kante (wie bisher an der ersten nicht tangentialen).
        let layerN = 0, layerLo = 90, layerHi = 0;
        for (let i = 0; i < L.length && ok; i++) {
          const a = L[i], b = L[(i + 1) % L.length];
          const k = edgeKeyFn(a, b);
          const others = (edgeOwners.get(k) || []).filter((o) => o.fi !== pi);
          if (others.length !== 1 || removed.has(others[0].fi)) { ok = false; break; }
          const ni = others[0].fi, c = Math.abs(_dot3(nrm[ni], d));
          const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
          if (c >= TANGENT_COS && c < PARALLEL_COS) {
            if (layerN) { ok = false; break; }
            Ledges.add(k); seeds.add(ni); lNb.push({ ni, band: true, k, len }); lenL += len;
          } else if (c <= WALL_COS) {
            if (layerN) { ok = false; break; }
            lNb.push({ ni, band: false });
          } else if (c < TANGENT_COS && i === layerN) {
            const ang = Math.acos(c) * 180 / Math.PI;
            layerN++; layerLo = Math.min(layerLo, ang); layerHi = Math.max(layerHi, ang);
            if (layerHi > MID_TC_MAX || layerHi - layerLo > 1) { ok = false; break; }
            Ledges.add(k); seeds.add(ni); lNb.push({ ni, band: true }); lenL += len;
          } else { ok = false; break; }
        }
        if (!ok || !seeds.size) return null;
        const atP = layerN > 0;        // Kegel-/Fasenlage direkt an P
        if (atP && layerN !== L.length) return null;
        // Offenes Band: ein Abschnitt (zyklisch) von Band-Kanten; A/B = Anfangs-/Endpunkt auf L,
        // endA/endB = Stirnwände (Nachbarn der scharfen Kanten davor/danach). Mehrere getrennte
        // Abschnitte: je Aufruf der Abschnitt `run` — Saat, Kanten und Länge nur dieses Abschnitts; ein
        // Band, das über eine fremde Kante wieder an P stößt, scheitert in (2) (Abschnitte verbunden).
        let open = null;
        if (lNb.some((x) => !x.band)) {
          const n = L.length;
          const starts = [];
          for (let i = 0; i < n; i++) if (lNb[i].band && !lNb[(i - 1 + n) % n].band) starts.push(i);
          if (info) info.runs = starts.length;
          if (run >= starts.length || (starts.length > 1 && !multiOk)) return null;
          const s = starts[run];
          let e = s; while (lNb[(e + 1) % n].band) e = (e + 1) % n;
          if (starts.length > 1) {
            seeds.clear(); Ledges.clear(); lenL = 0;
            for (let i = s; ; i = (i + 1) % n) { seeds.add(lNb[i].ni); Ledges.add(lNb[i].k); lenL += lNb[i].len; if (i === e) break; }
          }
          open = { s, e, A: L[s], B: L[(e + 1) % n], endA: lNb[(s - 1 + n) % n].ni, endB: lNb[(e + 1) % n].ni, multi: starts.length > 1 };
        } else if (run > 0) return null;
        // Laufzeit-Vorfilter: die Saat (erste Bandschicht) einer Verrundung ist ein schmaler Streifen
        // entlang L. Ist sie größer als 3× P, ist P keine Deckfläche, sondern ein Stück einer fein
        // tessellierten Kugel/eines Torus (Nachbarn so groß wie P) → verwerfen, ohne zu wachsen.
        let seedArea = 0;
        for (const fi of seeds) seedArea += fdArea(fi);
        if (seedArea > 3 * fdArea(pi)) return null;
        // Offenes Band, billige Vorstufe der Ausdehnungs-Schranke in (5): die erste Rundungsschicht ist
        // höchstens 2·sin(22.5°) = 0.77 × Bandtiefe breit (N ≥ 2), P mindestens 1 × → Saat ≤ 0.77·P.
        // Zylinder-Facette: Nachbar = gleich groß (1.0) → ohne Bandwachstum verwerfen.
        if (open && seedArea > 0.9 * fdArea(pi)) return null;
        // Bandform (ersetzt die groben Schranken „Bandfläche ≤ 3× P“ und „Tiefe ≤ min(5 mm, 0.45·
        // Teilhöhe)“): eine Verrundung ist ein SCHMALES Band entlang der Kontur von P, die Kontur
        // ist mindestens doppelt so lang wie der Rundungsbogen: |L| ≥ 2·(π/2)·r → Bandtiefe ≤ |L|/π.
        // Zulässig damit: Rippe 40×4 mit r=1.5 (Band 5× so groß wie die 1 mm schmale Deckfläche),
        // r=5.5 an einem 60×40-Block, r=1.2 an einer 2.5 mm dünnen Platte. Nicht: Kugelkappe über
        // winziger Polfläche auf einem Zylinder (Tiefe = Kugelradius), Flächenstück einer Kugel/
        // eines Torus — die Tiefensuche bricht ab, sobald ein Punkt tiefer liegt (früh, billig).
        const H_MAX = lenL / Math.PI;
        // Offenes Band: tiefer als Fläche(P)/Abschnittslänge darf es nach der Ausdehnungs-Schranke in
        // (5) ohnehin nicht werden — so bricht die Suche an Bogen-Facetten (Bohrung mit abwechselnd
        // langen/kurzen Facetten: Saat-Vorstufe greift nicht) nach wenigen Facetten ab.
        const H_GROW = open ? Math.min(H_MAX, fdArea(pi) / (OPEN_MIN_DECK * lenL)) : H_MAX;
        // (2) Band wachsen: Nachbarn sind Band (schräg + nah an P), Wand (⊥ P) oder P (nur über L)
        let band = new Set(seeds);
        const queue = [...seeds];
        let wallEdges = [];            // { v0, v1, wi, bi } Bandkante (Band-Fläche bi) zu einer Wand wi
        let walls = new Set();
        while (queue.length && ok) {
          const fi = queue.pop();
          const fd = fds[fi];
          for (const p of fd.outer) if (Math.abs(_dot3(d, p) - off) > H_GROW) { ok = false; break; }
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
              if (band.size > 50000) ok = false;
            }
          }
        }
        if (!ok || !wallEdges.length) return null;
        // (2b) „Wand“-Facetten, deren Ecken ALLE auf dem Band liegen, sind Splitter der Verrundung,
        // deren Normale zufällig ⊥ P steht (z.B. im Eck-Bereich, wo das Band um eine Konturecke
        // läuft). Als Wand würden sie beim Projizieren in P's Ebene kollabieren und die neue Kontur
        // liefe gleichsinnig um sie herum (eBike: 6 Orientierungsfehler) → zum Band schlagen und
        // die Grenze zu den echten Wänden neu bestimmen.
        let nonTangent = false;
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
                if (Math.abs(_dot3(nrm[ni], d)) <= WALL_COS && !removed.has(ni)) {
                  // (3) Tangential an die Wand? Die angrenzende Band-Facette muss fast ⊥ P stehen
                  // (Knick zur Wand ≤ 25°). Senkung: Kegel (45°) grenzt an die Bohrungswand → 45°.
                  // (Stirnwände eines offenen Bandes schneiden das Rundungsprofil quer — kein Knick.)
                  const isEnd = open && (ni === open.endA || ni === open.endB);
                  if (!isEnd && Math.abs(_dot3(nrm[fi], d)) > TANGENT_SIN) nonTangent = true;
                  walls.add(ni); wallEdges.push({ v0: a, v1: b, wi: ni, bi: fi, end: isEnd }); continue;
                }
                ok = false;
              }
            }
          }
        }
        if (!ok || !wallEdges.length) return null;
        // (3b) Nicht tangential an die Wände: nur zulässig, wenn zwischen Rundung und Wand eine
        // Kegel-/Fasen-Lage liegt (Senkung mit verrundeter Kante) — die wird zur schrägen Wand.
        let tilt = null, wallAng = 90;
        if (nonTangent && open) return null;
        // (3c) Kegel-/Fasenlage direkt an P: nur die Rundung zwischen ihr und der Wand ist ein Band
        if (atP) {
          if (nonTangent || open) return null;
          const mid = splitMiddleLayer(pi, L, band, wallEdges, seeds, d, off, true);
          return mid ? finishPlan(pi, L, mid.newLoop, mid.walls, mid.band, mid.proj, mid.planes) : null;
        }
        if (nonTangent) {
          tilt = splitTiltedWall(pi, band, wallEdges, Ledges, d);
          if (!tilt) return null;
          ({ band, walls, wallEdges } = tilt);
          wallAng = tilt.ang;
        }
        // (Gekrümmt ist das Band damit von selbst: tangential an P und an die Wände → die Band-
        // Normalen überstreichen mindestens 25°…65° zu P; reine Fasen scheitern schon an (1).)
        // (4) Wand-Bandkante muss genau EIN geschlossener Ring sein — offenes Band: EIN Weg von A nach
        // B über die Stirnwand bei A (Rundungsprofil, Tiefe 0 → r), die Seitenwände (Tiefe r) und die
        // Stirnwand bei B (r → 0); `ring` = die Punkte dazwischen (ohne A und B, die bleiben).
        let ring;
        if (!open) {
          const rings = chainEdges(wallEdges);
          if (rings.length !== 1 || rings[0].length < 3) return null;
          ring = rings[0];
        } else {
          ring = openBandPath(open, wallEdges, d, off);
          if (!ring) return null;
        }
        // (5) Projektion auf P (entlang d — bleibt auf jeder Wand, da Wände d enthalten; schräge
        // Kegel-Wände: entlang ihrer Mantellinie, s. splitTiltedWall)
        const proj = new Map();       // vtxKey(alt) → neuer Punkt
        let hLo = Infinity, hHi = -Infinity;
        for (const p of ring) {
          const h = _dot3(d, p) - off;
          if (!open || open.side.has(vtxKey(p))) { if (Math.abs(h) < hLo) hLo = Math.abs(h); if (Math.abs(h) > hHi) hHi = Math.abs(h); }
          if (Math.abs(h) < 1e-6 || Math.abs(h) > H_MAX) { ok = false; break; }
          const q = tilt ? tilt.project(p, h) : [p[0] - d[0] * h, p[1] - d[1] * h, p[2] - d[2] * h];
          if (!q) { ok = false; break; }
          proj.set(vtxKey(p), q);
        }
        if (!ok) return null;
        // Gleichmäßige Bandtiefe: bei einer echten Deckfläche liegt die ganze Bandkante auf EINER
        // Höhe über P (= Verrundungsradius). Schwankt sie (Deck-Rundung vs. Eckradius), ist P eine
        // Seitenwand, um die zufällig auch ein Band läuft → nicht diese Fläche entrunden.
        if (hHi - hLo > Math.max(0.01, 0.02 * hHi)) return null;
        // Offenes Band: P und die Seitenwände müssen über die Rundung hinaus reichen (echte Flächen des
        // Profils). Eine Bogen-Facette (Bohrung, Zapfen, Langloch- oder Halbkreis-Ende) hat tangentiale
        // Nachbarn; ihr „Band“ endet an der Facette 90° weiter, die als Wand gilt — und ein Viertelbogen
        // IST im Querschnitt ein tangentialer Kreisbogen: ohne diese Schranke wurde z.B. ein hohes
        // Halbkreis-Profil OHNE jede Rundung eckig (Basis 69260ed: ΔV +1719 mm³ bei dichter Hülle), mit
        // mehreren Abschnitten jeder hohe Zylinder zum Vierkant. Maß: Fläche / (Länge des Abschnitts ·
        // Bandtiefe) = Ausdehnung quer zur Rundung / Bandtiefe — Facette: Sehne/R ≤ 2·sin(12.5°) = 0.43
        // (tangential ≤ 25°), gemessen ≤ 0.22; Härtetest-Deckflächen/-Wände ≥ 4 (Seitenwände zusammen,
        // Stirnwände zählen nicht).
        if (open) {
          let aSide = 0;
          const sideW = new Set();
          for (const e of wallEdges) if (!e.end && !sideW.has(e.wi)) { sideW.add(e.wi); aSide += fdArea(e.wi); }
          if (fdArea(pi) < OPEN_MIN_DECK * lenL * hHi || aSide < OPEN_MIN_SIDE * lenL * hHi) return null;
        }
        // (5a) Rundungsprofil: im Querschnitt ist ein Verrundungsband EIN Kreisbogen (Radius r),
        // tangential an P und die Wände (Neigung θw, senkrecht 90°; Bandtiefe = r·(1 − cos θw)). Ein
        // Punkt in Tiefe h liegt dort, wo die Flächennormale um α(h) = acos(1 − h/r) gegen P geneigt
        // ist — die Normalen der angrenzenden Band-Facetten (an L zusätzlich P mit 0°, am Wandring die
        // Wand mit θw) müssen α(h) einschließen.
        // Eine flache Zone im Band liegt zu tief/zu flach für ihre Neigung: Senkungskegel zwischen
        // zwei Kanten-Rundungen (tangential an P UND an die Bohrung!), verrundete Fase → kein EINZELNES
        // Band; geschlossen und ohne Schräg-Wand: Kegel/Fase zwischen zwei Rundungen (splitMiddleLayer).
        let profileOk = true;
        {
          const lo = new Map(), hi = new Map(), pts = new Map();   // vtxKey → Neigung min/max (Grad), Punkt
          const note = (p, ang) => { const k = vtxKey(p); if (!(lo.get(k) <= ang)) lo.set(k, ang); if (!(hi.get(k) >= ang)) hi.set(k, ang); };
          for (const fi of band) {
            const ang = Math.acos(Math.min(1, Math.abs(_dot3(nrm[fi], d)))) * 180 / Math.PI;
            for (const Lb of loopsOf(fds[fi])) for (const p of Lb) { note(p, ang); pts.set(vtxKey(p), p); }
          }
          for (const p of L) note(p, 0);
          for (const p of ring) if (!open || open.side.has(vtxKey(p))) note(p, wallAng);
          const invR = (1 - Math.cos(wallAng * Math.PI / 180)) / hHi;
          for (const [k, p] of pts) {
            const al = Math.acos(Math.max(-1, Math.min(1, 1 - Math.abs(_dot3(d, p) - off) * invR))) * 180 / Math.PI;
            if (al < lo.get(k) - PROFILE_TOL_DEG || al > hi.get(k) + PROFILE_TOL_DEG) { profileOk = false; break; }
          }
        }
        if (!profileOk) {
          if (tilt || open) return null;
          const mid = splitMiddleLayer(pi, L, band, wallEdges, seeds, d, off, false);
          return mid ? finishPlan(pi, L, mid.newLoop, mid.walls, mid.band, mid.proj, mid.planes) : null;
        }
        // (5b) Exakte Ebenen (feine Rundungen, s. truePlane): jeden projizierten Punkt auf die echte
        // Ebene von P und die echte(n) Ebene(n) seiner Wand/Wände setzen (kleinste Verschiebung; an
        // der Ecke zweier Wände = Schnittpunkt dreier Ebenen). Nur µm-Korrekturen (≤ SNAP_MAX), und
        // nur für alle Punkte gemeinsam — sonst bleibt die einfache Projektion.
        const planes = tilt || open ? null : snapProjection(pi, proj, wallEdges, d);
        const newLoop = [];
        if (open) {
          // L ohne den verrundeten Abschnitt (B … A, scharfe Kanten bleiben), dann der projizierte Weg
          const n = L.length;
          for (let i = (open.e + 1) % n; ; i = (i + 1) % n) { newLoop.push(L[i]); if (i === open.s) break; }
        }
        for (const p of ring) {
          const q = proj.get(vtxKey(p));
          if (!newLoop.length || vtxKey(newLoop[newLoop.length - 1]) !== vtxKey(q)) newLoop.push(q);
        }
        if (newLoop.length > 1 && vtxKey(newLoop[0]) === vtxKey(newLoop[newLoop.length - 1])) newLoop.pop();
        // Offenes Band, das an einer EINSPRINGENDEN Ecke beginnt/endet: die Stirnwand läuft dort über die
        // Ecke hinaus, der projizierte Weg kehrt bei A (bzw. B) auf derselben Geraden um — A wäre eine
        // Spitze der Breite 0 in P und in der Stirnwand (dicht und volumentreu, aber zwei überlappende
        // Kanten je Fläche: entartet für strikte Kerne). A/B dann aus beiden Loops nehmen (Stirnwand:
        // applyBand, nach dem Verschieben).
        let folds = null;
        if (open) for (const E of [open.A, open.B]) if (dropFold(newLoop, vtxKey(E))) (folds || (folds = [])).push(vtxKey(E));
        if (newLoop.length < 3) return null;
        const plan = finishPlan(pi, L, newLoop, walls, band, proj, planes, folds);
        if (plan && open?.multi) plan.multi = true;
        return plan;
      }
    }

    // Spitze der Breite 0 bei loop[i]: beide Nachbarn liegen auf demselben Strahl von loop[i] aus
    // (Abstand des näheren Nachbarn von der Geraden des anderen ≤ FOLD_TOL)
    function foldTip(loop, i) {
      const n = loop.length;
      if (n <= 3) return false;
      const p = loop[i], u = _sub3(loop[(i - 1 + n) % n], p), w = _sub3(loop[(i + 1) % n], p);
      const lu = Math.hypot(u[0], u[1], u[2]), lw = Math.hypot(w[0], w[1], w[2]);
      if (!(lu > 0 && lw > 0) || _dot3(u, w) <= 0) return false;
      const c = _cross3(u, w);
      return Math.hypot(c[0], c[1], c[2]) / Math.max(lu, lw) <= FOLD_TOL;
    }
    // Spitze ab dem Punkt mit Schlüssel k abtragen: alle Punkte der zurückgefalteten Strecke liegen auf
    // ihr (A und die projizierten Stirnwand-Punkte bis zur echten Ecke) → die jeweilige Spitze entfernen,
    // bis ein Nachbar keine mehr bildet. → Anzahl entfernter Punkte
    function dropFold(loop, k) {
      let i = loop.findIndex((p) => vtxKey(p) === k), cnt = 0;
      while (i >= 0 && foldTip(loop, i)) {
        loop.splice(i, 1); cnt++;
        const m = loop.length;
        if (foldTip(loop, i % m)) i %= m;
        else if (foldTip(loop, (i - 1 + m) % m)) i = (i - 1 + m) % m;
        else break;
      }
      return cnt;
    }

    // Gemeinsame Schlussprüfungen eines Band-Plans → Plan | null
    function finishPlan(pi, L, newLoop, walls, band, proj, planes, folds = null) {
      let ok = true;
      const d = nrm[pi];
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
      return { pi, L, newLoop, walls, band, proj, planes, folds };
    }

    // (4) Offenes Band: Weg der Wand-Bandkanten von A nach B → Punkte zwischen A und B | null. Er muss
    // jede Kante genau einmal benutzen, auf der Stirnwand bei A beginnen (Tiefe steigt von 0 auf die
    // Bandtiefe), dann nur Seitenwände in Bandtiefe und am Ende die Stirnwand bei B (Tiefe fällt auf 0).
    // Merkt sich die Seitenwand-Punkte in open.side (für Bandtiefe und Rundungsprofil).
    function openBandPath(open, wallEdges, d, off) {
      const adj = new Map();
      wallEdges.forEach((e, idx) => {
        for (const [p, q] of [[e.v0, e.v1], [e.v1, e.v0]]) { const k = vtxKey(p); let a = adj.get(k); if (!a) { a = []; adj.set(k, a); } a.push({ q, idx }); }
      });
      const kA = vtxKey(open.A), kB = vtxKey(open.B);
      if (kA === kB || (adj.get(kA) || []).length !== 1 || (adj.get(kB) || []).length !== 1) return null;
      const used = new Set(), path = [];
      let k = kA;
      for (let guard = 0; guard <= wallEdges.length; guard++) {
        const nx = (adj.get(k) || []).filter((x) => !used.has(x.idx));
        if (k !== kA && k !== kB && (adj.get(k) || []).length !== 2) return null;   // verzweigt
        if (k === kB) break;
        if (nx.length !== 1) return null;
        used.add(nx[0].idx);
        k = vtxKey(nx[0].q);
        if (k !== kB) path.push(nx[0].q);
      }
      if (k !== kB || used.size !== wallEdges.length || !path.length) return null;
      // Abschnitte: Stirnwand A … Seitenwände … Stirnwand B
      const depth = (p) => Math.abs(_dot3(d, p) - off);
      const seq = [open.A, ...path, open.B];
      const kinds = [];               // je Kante des Weges: 'A' | 'S' | 'B'
      for (let i = 0; i + 1 < seq.length; i++) {
        const e = wallEdges[[...adj.get(vtxKey(seq[i]))].find((x) => vtxKey(x.q) === vtxKey(seq[i + 1])).idx];
        kinds.push(!e.end ? 'S' : e.wi === open.endA && (!kinds.length || kinds[kinds.length - 1] === 'A') ? 'A' : e.wi === open.endB ? 'B' : 'X');
      }
      const ord = kinds.join('');
      if (!/^A+S+B+$/.test(ord)) return null;
      const nA = ord.indexOf('S'), nB = ord.lastIndexOf('S') + 1;
      for (let i = 1; i <= nA; i++) if (depth(seq[i]) < depth(seq[i - 1]) - 1e-6) return null;              // Profil A: Tiefe steigt
      for (let i = nB; i + 1 < seq.length; i++) if (depth(seq[i + 1]) > depth(seq[i]) + 1e-6) return null;   // Profil B: Tiefe fällt
      open.side = new Set();
      for (let i = nA; i <= nB; i++) open.side.add(vtxKey(seq[i]));
      return path;
    }

    // (3b) Senkung/Fase mit verrundeter Deck-Kante: das Band (Rundung + Kegel) reicht bis zur Bohrungs-
    // wand und schließt dort NICHT tangential an. Liegen alle an die Wände grenzenden Band-Facetten
    // auf EINER Neigung θc (± 0.5°), ist diese Lage ein Kegel/eine Fase: sie wird zur schrägen „Wand“,
    // das Band ist nur die Rundung zwischen P und Kegel (flacher als θc, tangential an den Kegel, berührt
    // die alten Wände nicht), und der Kegel reicht nirgends bis P. Die neue Kante ist Kegel ∩ P: jeder
    // Ringpunkt läuft entlang der Mantellinie (Schnitt der Kegel-Facetten durch ihn; eine einzelne
    // Facette: Fallrichtung in ihrer Ebene) bis P — die Senkung bleibt, nur ihre Kanten-Rundung fällt.
    // → { band, walls, wallEdges, ang: θc, project(p, h) } | null
    function splitTiltedWall(pi, band, wallEdges, Ledges, d) {
      const angOf = (fi) => Math.acos(Math.min(1, Math.abs(_dot3(nrm[fi], d)))) * 180 / Math.PI;
      const B = new Set(wallEdges.map((e) => e.bi));
      let tc = 0; for (const fi of B) tc += angOf(fi); tc /= B.size;
      for (const fi of B) if (Math.abs(angOf(fi) - tc) > 0.5) return null;
      if (!(tc > 2 && 90 - tc > 25)) return null;
      const C = new Set(B), stack = [...B];
      while (stack.length) {
        const fi = stack.pop();
        for (const Lb of loopsOf(fds[fi])) {
          for (let i = 0; i < Lb.length; i++) {
            for (const o of edgeOwners.get(edgeKeyFn(Lb[i], Lb[(i + 1) % Lb.length])) || []) {
              if (o.fi === fi || C.has(o.fi) || !band.has(o.fi)) continue;
              if (Math.abs(angOf(o.fi) - tc) <= 0.5) { C.add(o.fi); stack.push(o.fi); }
            }
          }
        }
      }
      const R = new Set([...band].filter((fi) => !C.has(fi)));
      if (!R.size) return null;
      let aMin = 90, aMax = 0;
      for (const fi of R) { const a = angOf(fi); if (a > tc - 0.5) return null; aMin = Math.min(aMin, a); aMax = Math.max(aMax, a); }
      if (aMax - aMin < 0.25 * tc) return null;   // gekrümmt (≥ 2 Schichten) — eine einzelne Schräge (Doppel-Senkung) ist keine Rundung
      for (const fi of C) {
        for (const Lb of loopsOf(fds[fi])) for (let i = 0; i < Lb.length; i++) if (Ledges.has(edgeKeyFn(Lb[i], Lb[(i + 1) % Lb.length]))) return null;
      }
      const edges = [];
      for (const fi of R) {
        for (const Lb of loopsOf(fds[fi])) {
          for (let i = 0; i < Lb.length; i++) {
            const a = Lb[i], b = Lb[(i + 1) % Lb.length];
            const others = (edgeOwners.get(edgeKeyFn(a, b)) || []).filter((o) => o.fi !== fi);
            if (others.length !== 1) return null;
            const ni = others[0].fi;
            if (R.has(ni) || ni === pi) continue;
            if (!C.has(ni) || tc - angOf(fi) > 25) return null;   // berührt die alte Wand / nicht tangential an den Kegel
            edges.push({ v0: a, v1: b, wi: ni, bi: fi });
          }
        }
      }
      if (!edges.length) return null;
      const ringKeys = new Set();
      for (const e of edges) { ringKeys.add(vtxKey(e.v0)); ringKeys.add(vtxKey(e.v1)); }
      const W = new Set(), at = new Map();       // Kegel-Facetten am Ring; Ringpunkt → Facetten
      for (const fi of C) {
        for (const Lb of loopsOf(fds[fi])) {
          for (const p of Lb) {
            const k = vtxKey(p);
            if (!ringKeys.has(k)) continue;
            W.add(fi);
            let s = at.get(k); if (!s) { s = new Set(); at.set(k, s); } s.add(fi);
          }
        }
      }
      const project = (p, h) => {
        const g = lineThrough([...(at.get(vtxKey(p)) || [])], d);
        if (!g) return null;
        const gd = _dot3(g, d);
        if (Math.abs(gd) < 0.2) return null;
        const t = -h / gd;
        return [p[0] + g[0] * t, p[1] + g[1] * t, p[2] + g[2] * t];
      };
      return { band: R, walls: W, wallEdges: edges, ang: tc, project };
    }

    // Gemeinsame Gerade der Facetten fs durch ihren gemeinsamen Punkt (Mantellinie eines Kegels/einer
    // Fase, senkrechte Kante zweier Wände): Schnitt der beiden am stärksten gegeneinander geneigten
    // Facetten-Ebenen — jede weitere Facette muss sie enthalten; eine einzelne Ebene (bzw. nur
    // parallele): Fallrichtung zu d in ihr. → Einheitsvektor (Vorzeichen beliebig) | null
    function lineThrough(fs, d) {
      if (!fs.length) return null;
      let best = null;
      for (let i = 0; i < fs.length; i++) {
        for (let j = i + 1; j < fs.length; j++) {
          const c = _cross3(nrm[fs[i]], nrm[fs[j]]), l = Math.hypot(c[0], c[1], c[2]);
          if (!best || l > best.l) best = { c, l };
        }
      }
      if (best && best.l > 1e-3) {
        const g = [best.c[0] / best.l, best.c[1] / best.l, best.c[2] / best.l];
        for (const f of fs) if (Math.abs(_dot3(nrm[f], g)) > 1e-3) return null;   // keine gemeinsame Gerade
        return g;
      }
      const n = nrm[fs[0]], k = _dot3(d, n);
      return _norm3([d[0] - n[0] * k, d[1] - n[1] * k, d[2] - n[2] * k]);
    }

    // Rundungsprofil zwischen zwei Lagen (wie (5a)): im Querschnitt EIN Kreisbogen, tangential an Lage 1
    // (Neigung t1 in Tiefe h1) und Lage 2 (t2 in h2) → cos α(h) = cos t1 − (cos t1 − cos t2)·(h − h1)/(h2 − h1).
    // Die Neigungen der an einen Punkt grenzenden Facetten (auf Rand 1/2 zusätzlich t1/t2) müssen α(h)
    // einschließen (± PROFILE_TOL_DEG).
    function arcProfileOk(facets, edge1, t1, h1, edge2, t2, h2, d, off) {
      const lo = new Map(), hi = new Map(), pts = new Map();
      const note = (p, ang) => { const k = vtxKey(p); if (!(lo.get(k) <= ang)) lo.set(k, ang); if (!(hi.get(k) >= ang)) hi.set(k, ang); };
      for (const fi of facets) {
        const ang = Math.acos(Math.min(1, Math.abs(_dot3(nrm[fi], d)))) * 180 / Math.PI;
        for (const Lb of loopsOf(fds[fi])) for (const p of Lb) { note(p, ang); pts.set(vtxKey(p), p); }
      }
      for (const p of edge1) note(p, t1);
      for (const p of edge2) note(p, t2);
      const c1 = Math.cos(t1 * Math.PI / 180), c2 = Math.cos(t2 * Math.PI / 180);
      for (const [k, p] of pts) {
        const u = (Math.abs(_dot3(d, p) - off) - h1) / (h2 - h1);
        const al = Math.acos(Math.max(-1, Math.min(1, c1 - (c1 - c2) * u))) * 180 / Math.PI;
        if (al < lo.get(k) - PROFILE_TOL_DEG || al > hi.get(k) + PROFILE_TOL_DEG) return false;
      }
      return true;
    }

    // (3c) Kegel/Fase ZWISCHEN den Rundungen — Senkung oder Fase, deren Kanten verrundet sind:
    //   atP = false: P –Rundung R1– Lage C –Rundung R2– Wand. Das Band von P reicht tangential bis zur
    //                Wand, das Rundungsprofil (5a) scheitert an der flachen Lage C (Härtetest x5, x6);
    //   atP = true:  P –scharf– Lage C –Rundung R2– Wand. L grenzt ringsum mit EINER Neigung (Knick
    //                > 25°) an C, die Rundung liegt erst zwischen C und der Wand (x3).
    // C = zusammenhängende Facetten EINER Neigung tc (± 0.5°, Kegel/Fase), sie trennt das Band sauber in
    // R1 (an L) und R2 (an den Wänden). C bleibt, nur die Rundungen fallen weg:
    //   R1-Rand (R1 ∩ C) läuft entlang der Mantellinien von C bis P (wie splitTiltedWall) → neue Kontur
    //   von P = C ∩ P; R2-Rand auf C (R2 ∩ C) läuft entlang der Mantellinie von P weg, der Wand-Rand (R2 ∩
    //   Wand) entlang der Wandkante zu P hin — je Station treffen sich beide in EINEM Punkt S (Kante C ∩
    //   Wand). Die Stationen müssen Punkt für Punkt zusammenpassen (gleiche Anzahl, gleiche Reihenfolge,
    //   Geraden schneiden sich bis auf MID_MATCH_TOL, S liegt zwischen den beiden Rand-Tiefen) — sonst
    //   bliebe ein Riss oder eine T-Kante.
    // Schutz gegen Fehldeutung: R1 und R2 sind je EIN Kreisbogen (≥ 2 Schichten, tangential an beide
    // Nachbarn, Profilprüfung wie (5a)); C ist flach UND lang: eine nicht kreisförmige Rundung, deren
    // breiteste Schicht „C“ wäre, krümmt sich über deren Länge so stark wie an den Schichtknicken —
    // eine echte Fase/ein echter Kegel bleibt über ein Vielfaches der Bogenschritte gerade
    // (Länge(C) ≥ MID_LEN_FACTOR · Knick an C · Bogenradius, je Seite).
    // → { band: R1 ∪ R2, walls: berührte C-Facetten + Wände, proj, newLoop } | null
    function splitMiddleLayer(pi, L, band, wallEdges, seeds, d, off, atP) {
      const angOf = (fi) => Math.acos(Math.min(1, Math.abs(_dot3(nrm[fi], d)))) * 180 / Math.PI;
      const depthOf = (p) => Math.abs(_dot3(d, p) - off);
      const eachNb = (fi, fn) => {
        for (const Lb of loopsOf(fds[fi])) {
          for (let i = 0; i < Lb.length; i++) {
            const a = Lb[i], b = Lb[(i + 1) % Lb.length];
            for (const o of edgeOwners.get(edgeKeyFn(a, b)) || []) if (o.fi !== fi) fn(o.fi, a, b);
          }
        }
      };
      const BW = new Set(), W = new Set();     // Band-Facetten an den Wänden; Wände
      for (const e of wallEdges) { BW.add(e.bi); W.add(e.wi); }
      // (a) Neigung tc der Lage C und Start-Facetten
      let tc = 0;
      const start = [];
      if (atP) {
        for (const fi of seeds) { tc += angOf(fi); start.push(fi); }
        tc /= seeds.size;
      } else {
        // 1°-Fenster mit der größten Fläche unter den Facetten, die weder an L noch an eine Wand grenzen
        const cand = [];
        let aBand = 0;
        for (const fi of band) {
          const A = fdArea(fi);
          aBand += A;
          if (!seeds.has(fi) && !BW.has(fi)) cand.push({ fi, a: angOf(fi), A });
        }
        cand.sort((x, y) => x.a - y.a);
        let best = null;
        for (let i = 0, j = 0, s = 0; i < cand.length; i++) {
          s += cand[i].A;
          while (cand[i].a - cand[j].a > 1) s -= cand[j++].A;
          if (!best || s > best.s) best = { s, i, j };
        }
        if (!best || !(best.s >= MID_MIN_SHARE * aBand)) return null;
        let sa = 0;
        for (let k = best.j; k <= best.i; k++) sa += cand[k].a * cand[k].A;
        tc = sa / best.s;
        for (let k = best.j; k <= best.i; k++) if (Math.abs(cand[k].a - tc) <= 0.5) start.push(cand[k].fi);
      }
      if (!(tc >= MID_TC_MIN && tc <= MID_TC_MAX) || !start.length) return null;
      for (const fi of start) if (Math.abs(angOf(fi) - tc) > 0.5) return null;
      const C = new Set(start), stack = [...start];
      while (stack.length) {
        eachNb(stack.pop(), (ni) => { if (!C.has(ni) && band.has(ni) && Math.abs(angOf(ni) - tc) <= 0.5) { C.add(ni); stack.push(ni); } });
      }
      // (b) R1 (von L aus) und R2 (von den Wänden aus) ohne C: C muss das Band sauber trennen
      const flood = (from) => {
        const R = new Set(), st = [];
        for (const fi of from) if (!C.has(fi) && band.has(fi) && !R.has(fi)) { R.add(fi); st.push(fi); }
        while (st.length) eachNb(st.pop(), (ni) => { if (!R.has(ni) && !C.has(ni) && band.has(ni)) { R.add(ni); st.push(ni); } });
        return R;
      };
      const R1 = atP ? new Set() : flood(seeds), R2 = flood(BW);
      if (!R2.size || (!atP && !R1.size)) return null;
      for (const fi of band) if ((C.has(fi) ? 1 : 0) + (R1.has(fi) ? 1 : 0) + (R2.has(fi) ? 1 : 0) !== 1) return null;
      for (const fi of seeds) if (atP ? !C.has(fi) : !R1.has(fi)) return null;
      for (const fi of BW) if (!R2.has(fi)) return null;
      for (const fi of C) {                     // C grenzt nur an R1, R2, sich selbst (atP: und an P)
        let bad = false;
        eachNb(fi, (ni) => { if (!(C.has(ni) || R1.has(ni) || R2.has(ni) || (atP && ni === pi))) bad = true; });
        if (bad) return null;
      }
      // (c) R1 flacher, R2 steiler als C, beide gekrümmt (≥ 2 Schichten)
      const spread = (R) => { let lo = 90, hi = 0; for (const fi of R) { const a = angOf(fi); if (a < lo) lo = a; if (a > hi) hi = a; } return { lo, hi }; };
      if (R1.size) { const s = spread(R1); if (s.hi > tc - 0.5 || s.hi - s.lo < 0.25 * tc) return null; }
      { const s = spread(R2); if (s.lo < tc + 0.5 || s.hi - s.lo < 0.25 * (90 - tc)) return null; }
      // (d) Ränder an C (tangential: Knick ≤ 25°) und an den Wänden — je EIN geschlossener Ring
      const e1 = [], eC = [];
      let k1 = 0, k2 = 0;                       // größter Knick an C (Grad)
      for (const fi of R1) eachNb(fi, (ni, a, b) => { if (C.has(ni)) { e1.push({ v0: a, v1: b }); k1 = Math.max(k1, tc - angOf(fi)); } });
      for (const fi of R2) eachNb(fi, (ni, a, b) => { if (C.has(ni)) { eC.push({ v0: a, v1: b }); k2 = Math.max(k2, angOf(fi) - tc); } });
      if (k1 > 25 || k2 > 25) return null;
      const oneRing = (edges) => { const rs = chainEdges(edges); return rs.length === 1 && rs[0].length >= 3 ? rs[0] : null; };
      const ring1 = atP ? null : oneRing(e1), ringC = oneRing(eC), ringW = oneRing(wallEdges);
      if ((!atP && !ring1) || !ringC || !ringW) return null;
      // gleichmäßige Tiefe je Ring (wie (5)); Reihenfolge P < R1/C < C/R2 < Wand
      const meanDepth = (ring) => {
        let lo = Infinity, hi = -Infinity, s = 0;
        for (const p of ring) { const h = depthOf(p); if (h < lo) lo = h; if (h > hi) hi = h; s += h; }
        return hi - lo > Math.max(0.01, 0.02 * hi) ? NaN : s / ring.length;
      };
      const h1 = atP ? 0 : meanDepth(ring1), hC = meanDepth(ringC), hW = meanDepth(ringW);
      if (!(hC > h1 + 1e-6 && hW > hC + 1e-6) || (!atP && !(h1 > 1e-6))) return null;
      // (e) Profile: R1 Kreisbogen 0° (P) → tc, R2 Kreisbogen tc → 90° (Wand)
      if (R1.size && !arcProfileOk(R1, L, 0, 0, ring1, tc, h1, d, off)) return null;
      if (!arcProfileOk(R2, ringC, tc, hC, ringW, 90, hW, d, off)) return null;
      // (f) C flach und lang gegenüber den Bögen (s. oben)
      const rad = Math.PI / 180;
      const lenC = (hC - h1) / Math.sin(tc * rad);
      if (R1.size && lenC < MID_LEN_FACTOR * (k1 * rad) * (h1 / (1 - Math.cos(tc * rad)))) return null;
      if (lenC < MID_LEN_FACTOR * (k2 * rad) * ((hW - hC) / Math.cos(tc * rad))) return null;
      // (g) Neue Punkte aus den EXAKTEN Ebenen (truePlane): bei feinen Rundungen (halber Schichtwinkel
      // < 2°) schlägt das Region-Growing den tangentialen Streifen jeder Rundung der Nachbarfläche zu
      // (P, Kegel-/Fasen-Facette, Wand) — die Rand-Punkte liegen dann µm NEBEN der echten Fläche. Darum
      // Geraden als Schnitt der exakten Ebenen, nicht durch die Rand-Punkte; P, C und Wände tragen
      // danach ihre exakte Ebene (wie (5b)/applyBand).
      const planeOf = (fi) => truePlane(fi) || { n: nrm[fi], c: _dot3(nrm[fi], fds[fi].centroid), p: fds[fi].centroid };
      // Gerade der Facetten fs nahe p (vgl. lineThrough) → { x: Punkt nahe p, u: Richtung } | null
      const lineOfPlanes = (fs, p) => {
        if (!fs.length) return null;
        const pls = fs.map(planeOf);
        let best = null;
        for (let i = 0; i < pls.length; i++) {
          for (let j = i + 1; j < pls.length; j++) {
            const c = _cross3(pls[i].n, pls[j].n), l = Math.hypot(c[0], c[1], c[2]);
            if (!best || l > best.l) best = { i, j, c, l };
          }
        }
        let x, u;
        if (best && best.l > 1e-3) {
          u = [best.c[0] / best.l, best.c[1] / best.l, best.c[2] / best.l];
          const A = pls[best.i], B = pls[best.j], k = _dot3(A.n, B.n), den = 1 - k * k;
          const fa = (A.c - B.c * k) / den, fb = (B.c - A.c * k) / den;
          const x0 = [A.n[0] * fa + B.n[0] * fb, A.n[1] * fa + B.n[1] * fb, A.n[2] * fa + B.n[2] * fb];
          const t = _dot3(_sub3(p, x0), u);
          x = [x0[0] + u[0] * t, x0[1] + u[1] * t, x0[2] + u[2] * t];
          for (const pl of pls) if (Math.abs(_dot3(pl.n, u)) > 1e-3) return null;   // keine gemeinsame Gerade
        } else {
          const pl = pls[0], h = _dot3(pl.n, p) - pl.c, k = _dot3(d, pl.n);
          x = [p[0] - pl.n[0] * h, p[1] - pl.n[1] * h, p[2] - pl.n[2] * h];
          u = _norm3([d[0] - pl.n[0] * k, d[1] - pl.n[1] * k, d[2] - pl.n[2] * k]);
        }
        for (const pl of pls) if (Math.abs(_dot3(pl.n, x) - pl.c) > MID_MATCH_TOL) return null;
        if (Math.hypot(x[0] - p[0], x[1] - p[1], x[2] - p[2]) > SNAP_MAX) return null;   // Rand-Punkt weit neben den Ebenen
        return { x, u };
      };
      const facetsAt = new Map(), cTouched = new Set();
      const keysC = new Set(ringC.map(vtxKey));
      if (ring1) for (const p of ring1) keysC.add(vtxKey(p));
      for (const fi of C) {
        for (const Lb of loopsOf(fds[fi])) {
          for (const p of Lb) {
            const k = vtxKey(p);
            if (!keysC.has(k)) continue;
            cTouched.add(fi);
            let s = facetsAt.get(k); if (!s) { s = []; facetsAt.set(k, s); }
            if (!s.includes(fi)) s.push(fi);
          }
        }
      }
      const wallAt = new Map(), keysW = new Set(ringW.map(vtxKey));
      for (const wi of W) {
        for (const Lb of loopsOf(fds[wi])) {
          for (const p of Lb) {
            const k = vtxKey(p);
            if (!keysW.has(k)) continue;
            let s = wallAt.get(k); if (!s) { s = []; wallAt.set(k, s); }
            if (!s.includes(wi)) s.push(wi);
          }
        }
      }
      const proj = new Map(), newLoop = [];
      const planes = new Map();               // Fläche → exakte Ebene (applyBand)
      const usePlane = (fi) => { const t = truePlane(fi); if (t) planes.set(fi, t); };
      if (ring1) {
        // R1-Rand → P entlang der Mantellinie von C (Schnitt mit der exakten Ebene von P)
        const pP = planeOf(pi);
        usePlane(pi);
        for (const p of ring1) {
          const ln = lineOfPlanes(facetsAt.get(vtxKey(p)) || [], p);
          if (!ln) return null;
          const gd = _dot3(ln.u, pP.n);
          if (Math.abs(gd) < 0.2) return null;
          const t = (pP.c - _dot3(pP.n, ln.x)) / gd;
          const q = [ln.x[0] + ln.u[0] * t, ln.x[1] + ln.u[1] * t, ln.x[2] + ln.u[2] * t];
          proj.set(vtxKey(p), q);
          if (!newLoop.length || vtxKey(newLoop[newLoop.length - 1]) !== vtxKey(q)) newLoop.push(q);
        }
        if (newLoop.length > 1 && vtxKey(newLoop[0]) === vtxKey(newLoop[newLoop.length - 1])) newLoop.pop();
        if (newLoop.length < 3) return null;
      } else newLoop.push(...L);
      // R2-Rand auf C und Wand-Rand → gemeinsame Kante S: Station für Station
      const n = ringW.length;
      if (ringC.length !== n) return null;
      const gW = ringW.map((p) => lineOfPlanes(wallAt.get(vtxKey(p)) || [], p));
      const gC = ringC.map((c) => lineOfPlanes(facetsAt.get(vtxKey(c)) || [], c));
      if (gW.some((g) => !g) || gC.some((g) => !g)) return null;
      let scale = 0;
      for (const p of ringW) scale = Math.max(scale, Math.abs(p[0]), Math.abs(p[1]), Math.abs(p[2]));
      const tolM = Math.max(MID_MATCH_TOL, 4e-7 * scale);   // float32 fern vom Ursprung
      const meet = (i, j) => {                // nächste Punkte der Wandgeraden i und der Mantellinie j
        const { x: p, u: gw } = gW[i], { x: c, u: gc } = gC[j];
        const w0 = _sub3(p, c), b = _dot3(gw, gc), dd = _dot3(gw, w0), e = _dot3(gc, w0), den = 1 - b * b;
        if (!(den > 1e-6)) return null;
        const lam = (b * e - dd) / den, mu = (e - b * dd) / den;
        const A = [p[0] + gw[0] * lam, p[1] + gw[1] * lam, p[2] + gw[2] * lam];
        const B = [c[0] + gc[0] * mu, c[1] + gc[1] * mu, c[2] + gc[2] * mu];
        if (Math.hypot(A[0] - B[0], A[1] - B[1], A[2] - B[2]) > tolM) return null;
        const S = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2, (A[2] + B[2]) / 2];
        const h = depthOf(S);
        return h > hC + 1e-6 && h < hW - 1e-6 ? S : null;
      };
      let j0 = -1;
      for (let j = 0; j < n; j++) if (meet(0, j)) { if (j0 >= 0) return null; j0 = j; }   // eindeutig
      if (j0 < 0) return null;
      const dir = meet(1, (j0 + 1) % n) ? 1 : meet(1, (j0 - 1 + n) % n) ? -1 : 0;
      if (!dir) return null;
      for (let i = 0; i < n; i++) {
        const j = (((j0 + dir * i) % n) + n) % n;
        const S = meet(i, j);
        if (!S) return null;
        proj.set(vtxKey(ringW[i]), S);
        proj.set(vtxKey(ringC[j]), S);
      }
      const walls = new Set(cTouched);
      for (const wi of W) walls.add(wi);
      for (const fi of walls) usePlane(fi);
      return { band: new Set([...R1, ...R2]), walls, proj, newLoop, planes };
    }

    // (5b) Hilfen: projizierte Punkte auf die exakten Ebenen setzen → Map(fi → Ebene) | null.
    // Wände gehen SENKRECHT zu P ein (Normale ⊥ d gemacht, durch den Schwerpunkt ihrer Dreiecke):
    // so liegen der obere und der untere Punkt einer senkrechten Wandkante wieder exakt übereinander
    // (v2b vergleicht 2D-Lagen auf 1e-4 mm) — schräge Schnittgeraden zweier fast paralleler Facetten
    // (Eckrundung, gedrehtes Netz) verstärkten sonst das float32-Rauschen über die Wandhöhe.
    // Liegen alle Punkte schon innerhalb SNAP_NOISE auf den Ebenen (Normalfall), bleibt alles wie es ist.
    function snapProjection(pi, proj, wallEdges, d) {
      const tP = truePlane(pi);
      const wallsAt = new Map();      // vtxKey(Ringpunkt) → Set(Wand)
      for (const e of wallEdges) {
        for (const p of [e.v0, e.v1]) { const k = vtxKey(p); let s = wallsAt.get(k); if (!s) { s = new Set(); wallsAt.set(k, s); } s.add(e.wi); }
      }
      const vertPlane = new Map();    // Wand → Ebene ⊥ P
      const wallPlane = (wi) => {
        if (!vertPlane.has(wi)) {
          const tw = truePlane(wi);
          let pl = null;
          if (tw) { const k = _dot3(tw.n, d); const n = _norm3([tw.n[0] - d[0] * k, tw.n[1] - d[1] * k, tw.n[2] - d[2] * k]); pl = { n, c: _dot3(n, tw.p) }; }
          vertPlane.set(wi, pl);
        }
        return vertPlane.get(wi);
      };
      const used = new Map(), moved = new Map();
      if (tP) used.set(pi, tP);
      let worst = 0, noise = SNAP_NOISE;
      for (const [k, q] of proj) {
        const pls = tP ? [tP] : [];
        for (const wi of wallsAt.get(k) || []) { const pl = wallPlane(wi); if (pl) { pls.push(pl); used.set(wi, pl); } }
        for (const pl of pls) worst = Math.max(worst, Math.abs(_dot3(pl.n, q) - pl.c));
        noise = Math.max(noise, 2e-7 * Math.max(Math.abs(q[0]), Math.abs(q[1]), Math.abs(q[2]))); // float32 fern vom Ursprung
        const q2 = snapToPlanes(q, pls);
        if (!q2 || Math.hypot(q2[0] - q[0], q2[1] - q[1], q2[2] - q[2]) > SNAP_MAX) return null;
        moved.set(k, q2);
      }
      if (worst <= noise) return null;
      for (const [k, q2] of moved) proj.set(k, q2);
      return used;
    }
    // Kleinste Verschiebung von q auf den Schnitt der Ebenen (n·x = c), höchstens 3 unabhängige
    function snapToPlanes(q, pls) {
      const P = [];
      for (const pl of pls) {
        let dup = false;
        for (const x of P) {
          const cs = _dot3(x.n, pl.n);
          if (Math.abs(cs) > 0.99999) { if (Math.abs(x.c - Math.sign(cs) * pl.c) > 1e-4) return null; dup = true; break; }
        }
        if (!dup) P.push(pl);
      }
      if (!P.length) return q;
      if (P.length > 3) return null;
      // Gram-System G·λ = r (Gauß mit Pivotsuche), x = q + Σ λ_i n_i
      const k = P.length;
      const M = P.map((a, i) => [...P.map((b) => _dot3(a.n, b.n)), P[i].c - _dot3(P[i].n, q)]);
      for (let c = 0; c < k; c++) {
        let piv = c; for (let r = c + 1; r < k; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
        if (Math.abs(M[piv][c]) < 1e-9) return null;
        [M[c], M[piv]] = [M[piv], M[c]];
        for (let r = 0; r < k; r++) {
          if (r === c) continue;
          const f = M[r][c] / M[c][c];
          for (let j = c; j <= k; j++) M[r][j] -= f * M[c][j];
        }
      }
      const out = q.slice();
      for (let i = 0; i < k; i++) { const lam = M[i][k] / M[i][i]; for (let j = 0; j < 3; j++) out[j] += lam * P[i].n[j]; }
      return out;
    }

    // (7) Anwenden: P bekommt die Wandkontur, Wände werden bis P verlängert, Band entfällt. Wurde
    // auf exakte Ebenen gesetzt, tragen P und die Wände diese Ebenen auch als Flächen-Ebene (sonst
    // läge die STEP-PLANE µm neben ihrem Rand).
    function applyBand({ pi, L, newLoop, walls, band, proj, planes, folds }) {
      // Operation registrieren (Rückfall je Merkmal): entfernte Band-Facetten + neue Kontur-/Wandpunkte
      const op = { kind: 'v2', groups: [...band].map((fi) => fds[fi].group).filter(Boolean), keys: new Set() };
      for (const fi of band) addLoopKeys(op.keys, fds[fi]);
      const oldKeys = new Set(L.map(vtxKey));
      for (const q of newLoop) if (!oldKeys.has(vtxKey(q))) op.keys.add(vtxKey(q));   // nur NEUE Konturpunkte
      for (const q of proj.values()) op.keys.add(vtxKey(q));
      featureOps.push(op);
      markOp(fds[pi], op);
      for (const wi of walls) markOp(fds[wi], op);
      for (const [fi] of planes || []) markOp(fds[fi], op);
      const sabotage = breakNow('v2', op.groups) ? walls.values().next().value : -1;
      L.length = 0; L.push(...newLoop);
      for (const wi of walls) {
        if (wi === sabotage) continue;
        const W = fds[wi];
        for (const Lw of [W.outer, ...W.inner]) {
          for (let i = 0; i < Lw.length; i++) { const q = proj.get(vtxKey(Lw[i])); if (q) Lw[i] = q; }
          for (const k of folds || []) dropFold(Lw, k);   // dieselbe Spitze in der Stirnwand (s. evaluateBand)
        }
      }
      for (const [fi, pl] of planes || []) {
        const fd = fds[fi];
        const t = _dot3(pl.n, fd.centroid) - pl.c;
        fd.centroid = [fd.centroid[0] - pl.n[0] * t, fd.centroid[1] - pl.n[1] * t, fd.centroid[2] - pl.n[2] * t];
        fd.normal = pl.n.slice();
        nrm[fi] = pl.n.slice();
      }
      areaCache.delete(pi);
      for (const wi of walls) areaCache.delete(wi);
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
                  capEdits.push({ loop: Lx, out, h, repA, repB, fi });
                }
              } else { ok = false; break; }
            }
            if (!ok) { ok = true; continue; }
            if (!removeSet.size || !capEdits.length) continue;
            // gesperrte Eckrundung (Rückfall je Merkmal) und Biegung eines Blechprofils bleiben stehen
            if ([...removeSet].some((fi) => fds[fi].group && (blockedGroups.has(fds[fi].group) || bendGroups.has(fds[fi].group)))) continue;
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
      // Operation registrieren (Rückfall je Merkmal): entfernte Bogenstreifen + neue Eckpunkte
      const op = { kind: 'v2b', groups: [...removeSet].map((fi) => faceDefs[fi].group).filter(Boolean), keys: new Set() };
      for (const fi of removeSet) addLoopKeys(op.keys, faceDefs[fi]);
      for (const { repA, repB } of capEdits) { op.keys.add(vtxKey(repA)); op.keys.add(vtxKey(repB)); }
      for (const fi of moves) for (const Lx of [faceDefs[fi].outer, ...faceDefs[fi].inner]) for (const p of Lx) {
        const kk = key2(to2(p));
        if (kk === kA && newA) op.keys.add(vtxKey(lift(newA, _dot3(d, p))));
        else if (kk === kB && newB) op.keys.add(vtxKey(lift(newB, _dot3(d, p))));
      }
      featureOps.push(op);
      for (const { fi } of capEdits) markOp(faceDefs[fi], op);
      for (const fi of moves) markOp(faceDefs[fi], op);
      if (newWall) markOp(newWall, op);
      const sabotage = breakNow('v2b', op.groups) ? capEdits[0] : null;
      for (const ce of capEdits) { if (ce === sabotage) continue; ce.loop.length = 0; ce.loop.push(...ce.out); }
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
  const SHARP_SEG_MAX_DEG = SEG_MAX_DEG; // Rand-Polygon: jede Kante überspannt ≤ 42° (≥ 9 Segmente, s. ringAngleUniform)
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
    let maxSeg = 0;
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
        turn += ang; maxSeg = Math.max(maxSeg, Math.abs(ang));
      }
      if (Math.abs(Math.abs(turn) - 2 * Math.PI) > 1e-3) return null;
      if (!ringAngleUniform(ring, c0, axis)) return null; // D-Loch (Sehnen-Abflachung) → kein Zylinder
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
    // Innenpunkte der Wandflächen (Original-Dreiecke) und Verdrillung wie beim Mantel (boreWallOk)
    const wall = wallOfFaces(W);
    if (!boreWallOk([{ center: c0, axis, radius: R, maxSeg }, { center: c1, axis, radius: R, maxSeg }], wall.loops, wall.pts, tol)) return null;
    if (!circleOnDeck(c0, R, axis, decks[0].fd) || !circleOnDeck(c1, R, axis, decks[1].fd)) return null;
    const rim0 = mkCircleDesc(c0, R, axis), rim1 = mkCircleDesc(c1, R, axis);
    if (rim0.rimKey === rim1.rimKey) return null;
    return {
      plan: { prim: entry.prim, entry, rims: [rim0, rim1], groups: entry.groups, surfCenter: rim0.center, coneRims: [] },
      wall: W, decks: [decks[0].loop, decks[1].loop],
    };
  };
  // ---- BLINDLOCH (Sackloch) ----
  // Ein Sackloch hat an der Wand genau ZWEI Rand-Ringe, aber nur EINER davon ist der komplette
  // Innen-Loop einer ebenen Deckfläche (die Mündung). Der andere Ring ist der BODEN und hat zwei
  // erlaubte Formen:
  //   (a) FLACH: der komplette Außen-Loop genau EINER ebenen Fläche ohne weitere Innen-Loops
  //       (die Boden-Scheibe) — sie wird zur Kreis-Fläche mit der Kreis-Kante des Bodens;
  //   (b) SPITZE (Bohrspitze 118°/120°): ein Fächer konkaver Facetten, der in EINEM Punkt auf der
  //       Achse endet — wird zum Kegel mit VERTEX_LOOP an der Spitze.
  // Alles andere (runder Boden, Fase, unregelmäßiger Rand, zwei Mündungen = Durchgangsloch) bleibt
  // facettiert. Die Gates sind dieselben wie beim scharfen Durchgangsloch (Ringe eben/auf dem Kreis/
  // gleichmäßig, Wand ⟂ zur Achse und konkav, Wand auf dem Zylinder) — nur der zweite Rand ist der
  // Boden statt einer zweiten Deckfläche.
  const blindBorePlan = (entry, owners, fdsOfGroup, taken) => {
    const fail = (why) => { boreNotes.set(entry.prim.id, 'blind:' + why); return null; };
    const W = new Set();
    for (const g of entry.groups) for (const fi of (fdsOfGroup.get(g) || [])) if (!taken.has(fi)) W.add(fi);
    // 'nowall' = es sind KEINE Wandflächen übrig (die Gruppen hat z.B. ein Rohr/anderer Plan
    // schon übernommen) — eigener Code, damit 'wall' (Kreis-Rand auf der Wand) unterscheidbar bleibt.
    if (W.size < 3) return fail('nowall');
    // Rand der Wand: Kanten, die genau 1× in der Wand vorkommen — ihr Gegenüber ist genau EINE
    // Fläche außerhalb der Wand (wie sharpBorePlan)
    const cnt = new Map();
    for (const fi of W) {
      const fd = faceDefs[fi];
      for (const L of [fd.outer, ...fd.inner]) {
        if (L.circleRim) return fail('wall');
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
      if (e.n > 2) return fail('edges');
      if (e.n === 2) continue;
      const others = (owners.get(k) || []).filter((o) => !W.has(o.fi));
      if (others.length !== 1 || taken.has(others[0].fi)) return fail('edges');
      rimEdges.push({ v0: e.v0, v1: e.v1 });
      otherOf.set(k, others[0]);
    }
    const rings = chainEdges(rimEdges);
    if (rings.length !== 2 || rings[0].length + rings[1].length !== rimEdges.length) return fail('rings:' + rings.length);
    // Je Ring: gehört er zu genau EINER Fläche/Loop (own)? Und ist er der komplette Innen-Loop
    // einer ebenen Deckfläche (Mündung)? Genau EIN Ring darf Mündung sein — zwei = Durchgangsloch.
    const ringInfo = rings.map((ring) => {
      let own = null, single = true;
      for (let i = 0; i < ring.length; i++) {
        const o = otherOf.get(edgeKeyFn(ring[i], ring[(i + 1) % ring.length]));
        if (!o || (own && (o.fi !== own.fi || o.loop !== own.loop))) { single = false; break; }
        own = o;
      }
      const fd = (single && own) ? faceDefs[own.fi] : null;
      const isDeck = !!(single && fd && fd.inner.includes(own.loop) && !own.loop.circleRim && loopEdgeCount(own.loop) === ring.length);
      return { ring, own: single ? own : null, deck: isDeck ? { fi: own.fi, fd, loop: own.loop } : null };
    });
    const deckIdx = ringInfo.findIndex((ri) => ri.deck);
    if (deckIdx < 0) return fail('nodeck');
    if (ringInfo[1 - deckIdx].deck) return fail('through');   // zwei Mündungs-Ringe = Durchgangsloch
    const deck = ringInfo[deckIdx].deck;
    const deckRing = ringInfo[deckIdx].ring;
    const bottomRing = ringInfo[1 - deckIdx].ring;
    const bottomOwn = ringInfo[1 - deckIdx].own;
    // Achse = Deck-Normale, vom Boden zur Mündung; beide Ränder müssen koaxial sein
    const n = _norm3(deck.fd.normal);
    const f1 = fitCircleInPlane(deckRing, n), f0 = fitCircleInPlane(bottomRing, n);
    if (!f0 || !f1) return fail('fit');
    const along = _dot3(_sub3(f1.center, f0.center), n);
    const axis = along >= 0 ? n : [-n[0], -n[1], -n[2]];   // Achse: vom Boden zur Mündung
    const H = Math.abs(along);
    const R = (f0.radius + f1.radius) / 2;
    const tol = Math.max(0.01, 0.002 * R);
    if (Math.abs(f0.radius - f1.radius) > tol || !(H > tol)) return fail('radius');
    const c0 = f0.center;
    const c1 = [c0[0] + axis[0] * H, c0[1] + axis[1] * H, c0[2] + axis[2] * H];
    if (Math.hypot(f1.center[0] - c1[0], f1.center[1] - c1[1], f1.center[2] - c1[2]) > tol) return fail('coaxial');
    if (!(_dot3(n, axis) > 0.9999)) return fail('deckSide');  // Deckfläche zeigt zur Mündung
    const cyl = (p) => { const w = _sub3(p, c0), t = _dot3(w, axis); return { t, rho: Math.hypot(w[0] - axis[0] * t, w[1] - axis[1] * t, w[2] - axis[2] * t), w }; };
    // Ränder: eben (in ihrer Ebene), auf dem Kreis, fein genug und einmal ganz um die Achse
    const ringAt = [0, H];
    let maxSeg = 0;
    for (let r = 0; r < 2; r++) {
      const ring = r === 0 ? bottomRing : deckRing;
      let turn = 0;
      for (let i = 0; i < ring.length; i++) {
        const a = cyl(ring[i]), b = cyl(ring[(i + 1) % ring.length]);
        if (Math.abs(a.t - ringAt[r]) > tol || Math.abs(a.rho - R) > tol) return fail('ring');
        const ra = _sub3(a.w, [axis[0] * a.t, axis[1] * a.t, axis[2] * a.t]);
        const rb = _sub3(b.w, [axis[0] * b.t, axis[1] * b.t, axis[2] * b.t]);
        const ang = Math.atan2(_dot3(_cross3(ra, rb), axis), _dot3(ra, rb));
        if (Math.abs(ang) > SHARP_SEG_MAX_DEG * Math.PI / 180) return fail('ring');
        turn += ang; maxSeg = Math.max(maxSeg, Math.abs(ang));
      }
      if (Math.abs(Math.abs(turn) - 2 * Math.PI) > 1e-3) return fail('ring');
      if (!ringAngleUniform(ring, c0, axis)) return fail('ring'); // D-Loch (Sehnen-Abflachung) → kein Zylinder
    }
    // Wand: alle Punkte auf dem Mantel zwischen den Rändern, Normalen ⟂ Achse und zur Achse hin
    for (const fi of W) {
      const fd = faceDefs[fi];
      const nw = _norm3(fd.normal);
      if (Math.abs(_dot3(nw, axis)) > SHARP_WALL_AXIS_COS) return fail('wall');
      let cx = 0, cy = 0, cz = 0, np = 0;
      for (const L of [fd.outer, ...fd.inner]) {
        for (const p of L) {
          const q = cyl(p);
          if (Math.abs(q.rho - R) > tol || q.t < -tol || q.t > H + tol) return fail('wall');
          cx += p[0]; cy += p[1]; cz += p[2]; np++;
        }
      }
      const q = cyl([cx / np, cy / np, cz / np]);
      if (_dot3(nw, _sub3(q.w, [axis[0] * q.t, axis[1] * q.t, axis[2] * q.t])) >= 0) return fail('wall'); // konvex → keine Bohrung
    }
    // Innenpunkte der Wandflächen (Original-Dreiecke) und Verdrillung wie beim Mantel (boreWallOk)
    const wall = wallOfFaces(W);
    if (!boreWallOk([{ center: c0, axis, radius: R, maxSeg }, { center: c1, axis, radius: R, maxSeg }], wall.loops, wall.pts, tol)) return fail('wall');
    if (!circleOnDeck(c1, R, axis, deck.fd)) return fail('deckCircle');
    const rim0 = mkCircleDesc(c0, R, axis), rim1 = mkCircleDesc(c1, R, axis);
    if (rim0.rimKey === rim1.rimKey) return fail('rimKey');
    // (a) FLACHER BODEN: der Boden-Ring ist der komplette Außen-Loop genau EINER ebenen Fläche
    if (bottomOwn) {
      const fdB = faceDefs[bottomOwn.fi];
      if (bottomOwn.loop === fdB.outer && fdB.inner.length === 0 && !bottomOwn.loop.circleRim &&
          loopEdgeCount(bottomOwn.loop) === bottomRing.length && !W.has(bottomOwn.fi) && !taken.has(bottomOwn.fi) &&
          _dot3(_norm3(fdB.normal), axis) >= 0.9999) {          // Boden zeigt zur Mündung
        if (!circleOnDeck(c0, R, axis, fdB)) return fail('flat:circle');
        return {
          plan: { prim: entry.prim, entry, rims: [rim0, rim1], groups: entry.groups, surfCenter: rim0.center, coneRims: [], blind: 'flat' },
          wall: W, decks: [fdB.outer, deck.loop], rims: [rim0, rim1],
        };
      }
    }
    // (b) BOHRSPITZE: der Boden ist ein Band konkaver Facetten, das in EINER Spitze auf der Achse endet
    const band = coneBand(bottomRing, W, axis, c0, owners, taken, true);
    if (!band || band.deck) return fail('tip:band');
    const zAx = [-axis[0], -axis[1], -axis[2]];                  // von der Mündung zum Boden (Spitzenrichtung)
    let Ht = 0, top = null;
    for (const fi of band.W) { const fd = faceDefs[fi]; for (const L of [fd.outer, ...fd.inner]) for (const p of L) { const t = _dot3(_sub3(p, c0), zAx); if (t > Ht) { Ht = t; top = p; } } }
    if (!top || !(Ht > tol)) return fail('tip:top');
    const apex = [c0[0] + zAx[0] * Ht, c0[1] + zAx[1] * Ht, c0[2] + zAx[2] * Ht];
    if (Math.hypot(top[0] - apex[0], top[1] - apex[1], top[2] - apex[2]) > tol) return fail('tip:apex');
    if (!bandOnCone(band.W, c0, R, zAx, Ht, -R / Ht, tol, maxSeg, true)) return fail('tip:cone');
    if (!wallSpanOk(band.W, c0, zAx, maxSeg, tol)) return fail('tip:cone');
    const plan = {
      prim: entry.prim, entry, rims: [rim0, rim1], groups: entry.groups, surfCenter: rim0.center, coneRims: [], blind: 'tip',
      tip: { rim: rim0, apex, coneAxis: axis, semiAngle: Math.atan2(R, Ht), groups: band.groups, zone: { c0, zAx, H: Ht, R0: R, k: -R / Ht } },
    };
    return { plan, wall: new Set([...W, ...band.W]), decks: [deck.loop], rims: [rim1] };
  };
  // Alle passenden Bohrungen umwandeln → Set der umgewandelten Einträge.
  // blindOnly=true: nur Sacklöcher (blindBorePlan) — der scharfe Durchgangs-Pfad bleibt unberührt
  // (Toggle AUS: dort übernimmt der Bestandspfad attemptBore/matchBorePlans die Durchgangslöcher).
  const convertSharpBores = (blindOnly = false) => {
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
      if (blockedBores.has(entry)) continue;      // gesperrt (Rückfall je Bohrung) → bleibt facettiert
      let res = null;
      if (!blindOnly) { try { res = sharpBorePlan(entry, owners, fdsOfGroup, drop); } catch (_) { res = null; } }
      if (!res) {
        try { res = blindBorePlan(entry, owners, fdsOfGroup, drop); } catch (_) { res = null; }
      }
      if (!res) continue;
      const rims = res.rims || res.plan.rims;
      if (!rimsClear(rims, res.decks)) { boreNotes.set(entry.prim.id, 'clear'); continue; }
      for (const fi of res.wall) drop.add(fi);
      // Test-Hook 'bore': die erste Mündung bleibt ungetaggt → offene Kreis-Kante (s. breakNow).
      const broken = breakNow('bore', [entry]);
      res.decks.forEach((L, i) => { if (!(i === 0 && broken)) L.circleRim = rims[i]; });
      finalPlans.push(res.plan);
      boreNotes.set(entry.prim.id, res.plan.blind ? 'ok:blind-' + res.plan.blind : 'ok:through');
      done.add(entry);
    }
    if (drop.size) faceDefs = faceDefs.filter((_, i) => !drop.has(i));
    return done;
  };

  // ---- Konvexe Außen-Zylindermäntel (Welle, Zapfen, Scheiben-/Rohr-Außenwand) ----
  // Spiegelbild des scharfen Bohrungs-Pfads: ein voll umlaufender KONVEXER Mantel (radialScore
  // deutlich positiv — Facetten-Normalen zeigen von der Achse WEG) wird zu EINER
  // CYLINDRICAL_SURFACE, wenn beide Rand-Loops EXAKT ein kompletter Loop je einer ebenen Deckfläche
  // sind: meist der AUSSEN-Loop (Welle, Scheibe), beim Zapfen auf einer Platte bzw. der Stufenwelle
  // auf einer Seite ein INNEN-Loop (Platte um den Zapfen, Schulter der Stufenwelle). Dieselben
  // harten Gates wie sharpBorePlan: Ränder eben in der Deckebene, exakt auf dem Kreis, feine und
  // GLEICHMÄSSIGE Segmentwinkel (D-Wellen-Schutz), volle Umrundung, Wand ⟂ zu den Deckflächen,
  // Kreis in der Deck-Ebene, Wand konvex. Ein Innen-Loop als Deck bekommt die Kreis-Kante mit
  // derselben Lochrand-Regel wie eine Bohrung (assemble: holeLoopForward — im Uhrzeigersinn um die
  // Flächennormale), der Mantel nutzt sie gegenläufig.
  // FASE (C): grenzt ein Rand nicht direkt an eine Deckfläche, sondern an ein Band gleich geneigter
  // konvexer Facetten (coneBand, s. Kegel-Abschnitt), das seinerseits genau an einem kompletten Loop
  // einer parallelen ebenen Deckfläche endet, wird das Band ein Fasen-KEGEL zwischen dem Mantel-Rand
  // (Radius R) und dem Deck-Kreis (R_d, axial jenseits des Mantels) — Außenkanten-Fase (R_d < R)
  // wie Fuß-Fase eines Zapfens (R_d > R, Deck = Innen-Loop der Platte). Gates wie beim Kegel-Mantel:
  // Deck-Kreis fein/gleichmäßig/voll, koaxial, JEDER Band-Punkt auf dem Kegel, Normalen passen,
  // Deck-Kreis in der Deckebene. Der Mantel-Rand ist dann eine Kreis-Kante zwischen Zylinder und
  // Kegel (keine Deckfläche), der Deck-Kreis die Kante Kegel ↔ Deckfläche. Endet das Band ohne
  // Deckfläche in EINEM Punkt auf der Achse, ist es eine Kegelspitze (Welle mit Spitze, „Bleistift“;
  // Spitze als VERTEX_LOOP wie beim Kegel-Mantel). Eine Verrundung (mehrere Facetten-Reihen
  // verschiedener Neigung) endet weder an einer Deckfläche noch in einer Spitze → bleibt facettiert
  // (mit Toggle schärft v2 sie vorher, dann greift der direkte Weg).
  // Emission in assemble() als EIGENER Block (same_sense .T., Ränder so, dass die Fläche links
  // liegt), die Fasen im Kegel-Block; geprüft mit tests/step-strict.mjs (ohne Heilung) und
  // occt-Volumen gegen die exakte Geometrie (tests/mantle-regression.mjs).
  let mantlePlans = [];
  const sharpMantlePlan = (entry, owners, fdsOfGroup, taken, allOwners) => {
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
    if (rings.length !== 2) return null;                       // voller Mantel: genau 2 Ränder
    if (rings[0].length + rings[1].length !== rimEdges.length) return null; // jede Randkante in einem der Ringe
    // Jeder Rand = KOMPLETTER Loop (außen oder innen) genau einer Deckfläche — oder eine Fase (C):
    // Kegel-Band zwischen Rand und dem kompletten Loop einer Deckfläche (band ≠ null)
    const ends = [];
    for (const ring of rings) {
      let own = null, direct = true;
      for (let i = 0; i < ring.length && direct; i++) {
        const o = otherOf.get(edgeKeyFn(ring[i], ring[(i + 1) % ring.length]));
        if (!o) return null;
        if (own && (o.fi !== own.fi || o.loop !== own.loop)) direct = false;
        own = o;
      }
      if (direct) {
        const fd = faceDefs[own.fi];
        if ((fd.outer !== own.loop && !fd.inner.includes(own.loop)) || own.loop.circleRim || loopEdgeCount(own.loop) !== ring.length) return null;
        ends.push({ deck: { fi: own.fi, fd, loop: own.loop, ring }, band: null });
        continue;
      }
      if (!allOwners) return null;
      const band = coneBand(ring, W, _norm3(entry.prim.axis), entry.prim.axisPoint, allOwners(), taken);
      if (!band || (!band.deck && !CONE_APEX)) return null;
      ends.push({ deck: band.deck, band });                  // deck = null: Kegelspitze (Welle mit Spitze)
    }
    const dk = ends.filter((e) => e.deck);
    if (!dk.length || (dk.length === 2 && dk[0].deck.fi === dk[1].deck.fi)) return null;
    if (ends[0].band && ends[1].band && [...ends[1].band.W].some((fi) => ends[0].band.W.has(fi))) return null;
    // Achse = Deck-Normale (beide Deckflächen parallel), orientiert von Rand 0 nach Rand 1
    const n0 = _norm3(dk[0].deck.fd.normal), n1 = _norm3(dk[dk.length - 1].deck.fd.normal);
    if (Math.abs(_dot3(n0, n1)) < 0.9999) return null;
    const f0 = fitCircleInPlane(rings[0], n0), f1 = fitCircleInPlane(rings[1], n0);
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
    let maxSeg = 0;
    for (let r = 0; r < 2; r++) {
      const ring = rings[r];
      let turn = 0;
      for (let i = 0; i < ring.length; i++) {
        const a = cyl(ring[i]), b = cyl(ring[(i + 1) % ring.length]);
        if (Math.abs(a.t - ringAt[r]) > tol || Math.abs(a.rho - R) > tol) return null;
        const ra = _sub3(a.w, [axis[0] * a.t, axis[1] * a.t, axis[2] * a.t]);
        const rb = _sub3(b.w, [axis[0] * b.t, axis[1] * b.t, axis[2] * b.t]);
        const ang = Math.atan2(_dot3(_cross3(ra, rb), axis), _dot3(ra, rb));
        if (Math.abs(ang) > SHARP_SEG_MAX_DEG * Math.PI / 180) return null;
        turn += ang; maxSeg = Math.max(maxSeg, Math.abs(ang));
      }
      if (Math.abs(Math.abs(turn) - 2 * Math.PI) > 1e-3) return null;
      if (!ringAngleUniform(ring, c0, axis)) return null; // D-Welle (Sehnen-Abflachung) → kein Zylinder
    }
    // Wand: alle Punkte auf dem Mantel zwischen den Rändern, Normalen ⟂ Achse und von der Achse WEG
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
      if (_dot3(n, _sub3(q.w, [axis[0] * q.t, axis[1] * q.t, axis[2] * q.t])) <= 0) return null; // konkav → Bohrung, kein Mantel
      if (!srcPointsOk(fd, (p) => { const s = cyl(p); return s.rho > R + tol || s.rho < R * Math.cos(maxSeg / 2) - tol || s.t < -tol || s.t > H + tol; })) return null;
    }
    if (!wallSpanOk(W, c0, axis, maxSeg, tol)) return null;            // verdrillte Wand (Hyperboloid)
    const rims = [mkCircleDesc(c0, R, axis), mkCircleDesc(c1, R, axis)];
    if (rims[0].rimKey === rims[1].rimKey) return null;
    // Je Ende: Deck-Kreis = Mantel-Rand (direkt) bzw. Fasen-Kegel vom Mantel-Rand zum Deck-Kreis bzw.
    // Kegelspitze (Band ohne Deckfläche: alle Facetten laufen in EINEM Punkt auf der Achse zusammen)
    const wall = new Set(W), decks = [], deckRims = [], cones = [];
    for (let r = 0; r < 2; r++) {
      const e = ends[r], cr = r === 0 ? c0 : c1;
      if (!e.band) {
        if (!circleOnDeck(cr, R, axis, e.deck.fd)) return null;
        decks.push(e.deck.loop); deckRims.push(rims[r]);
        continue;
      }
      const out = r === 0 ? [-axis[0], -axis[1], -axis[2]] : axis;   // vom Mantel weg
      if (!e.deck) {
        let Ha = 0, top = null;
        for (const fi of e.band.W) { const fd = faceDefs[fi]; for (const L of [fd.outer, ...fd.inner]) for (const p of L) { const t = _dot3(_sub3(p, cr), out); if (t > Ha) { Ha = t; top = p; } } }
        if (!top || !(Ha > tol)) return null;
        const apex = [cr[0] + out[0] * Ha, cr[1] + out[1] * Ha, cr[2] + out[2] * Ha];
        if (Math.hypot(top[0] - apex[0], top[1] - apex[1], top[2] - apex[2]) > tol) return null; // Spitze auf der Achse
        if (!bandOnCone(e.band.W, cr, R, out, Ha, -R / Ha, tol, maxSeg) || !wallSpanOk(e.band.W, cr, axis, maxSeg, tol)) return null;
        cones.push({
          large: rims[r], small: null, apex, coneAxis: [-out[0], -out[1], -out[2]],
          semiAngle: Math.atan2(R, Ha), groups: e.band.groups, zone: { c0: cr, zAx: out, H: Ha, R0: R, k: -R / Ha }, chamfer: true,
        });
        for (const fi of e.band.W) wall.add(fi);
        continue;
      }
      const fdk = ringAsCircle(e.deck.ring, n0);
      if (!fdk) return null;
      const Hc = _dot3(_sub3(fdk.center, cr), out), Rd = fdk.radius;
      const tolC = Math.max(tol, 0.002 * Rd);
      if (!(Hc > tolC) || !(Math.abs(Rd - R) > tolC)) return null;     // Fase jenseits des Mantels, anderer Radius
      const cd = [cr[0] + out[0] * Hc, cr[1] + out[1] * Hc, cr[2] + out[2] * Hc];
      if (Math.hypot(fdk.center[0] - cd[0], fdk.center[1] - cd[1], fdk.center[2] - cd[2]) > tolC) return null; // koaxial
      const k = (Rd - R) / Hc;
      const segC = Math.max(maxSeg, fdk.maxSeg);
      if (!bandOnCone(e.band.W, cr, R, out, Hc, k, tolC, segC) || !wallSpanOk(e.band.W, cr, axis, segC, tolC)) return null;
      if (!circleOnDeck(cd, Rd, axis, e.deck.fd)) return null;
      const deckRim = mkCircleDesc(cd, Rd, axis);
      if (deckRim.rimKey === rims[r].rimKey || deckRim.rimKey === rims[1 - r].rimKey) return null;
      const grow = Rd > R;                                     // Fuß-Fase: Radius wächst zum Deck hin
      cones.push({
        large: grow ? deckRim : rims[r], small: grow ? rims[r] : deckRim, apex: null,
        coneAxis: grow ? out : [-out[0], -out[1], -out[2]],      // Richtung wachsenden Radius
        semiAngle: Math.atan2(Math.abs(Rd - R), Hc), groups: e.band.groups,
        zone: { c0: cr, zAx: out, H: Hc, R0: R, k }, chamfer: true,
      });
      for (const fi of e.band.W) wall.add(fi);
      decks.push(e.deck.loop); deckRims.push(deckRim);
    }
    return {
      plan: { prim: entry.prim, rims, groups: entry.groups, surfCenter: rims[0].center },
      wall, decks, deckRims, cones,
    };
  };
  // Alle passenden konvexen Mäntel umwandeln: Wandflächen entfallen, die Deck-Loops werden zur
  // analytischen Kreis-Kante (loop.circleRim; Außen- oder Innen-Loop). Scheitert ein Gate →
  // facettiert lassen.
  const convertMantles = () => {
    if (!mantleById.size) return;
    const fdsOfGroup = new Map();   // Gruppe → [fi]
    faceDefs.forEach((fd, fi) => {
      if (fd.group) { let a = fdsOfGroup.get(fd.group); if (!a) { a = []; fdsOfGroup.set(fd.group, a); } a.push(fi); }
    });
    // Rand-Punkte der Kandidaten-Wände (Kanten genau 1× in der Wand) — die Kanten-Eigentümer werden
    // nur für Kanten zwischen solchen Punkten gesammelt (sharpMantlePlan fragt nur Randkanten ab).
    // Spart bei großen Netzen den vollständigen Kanten-Index (Stress-Rohr, Toggle AUS: ~80 ms).
    const rimVerts = new Set();
    for (const entry of mantleById.values()) {
      const cnt = new Map();
      for (const g of entry.groups) {
        for (const fi of (fdsOfGroup.get(g) || [])) {
          const fd = faceDefs[fi];
          for (const L of [fd.outer, ...fd.inner]) {
            for (let i = 0; i < L.length; i++) {
              const a = L[i], b = L[(i + 1) % L.length];
              if (vtxKey(a) === vtxKey(b)) continue;
              const k = edgeKeyFn(a, b), e = cnt.get(k);
              if (e) e.n++; else cnt.set(k, { n: 1, a, b });
            }
          }
        }
      }
      for (const e of cnt.values()) if (e.n === 1) { rimVerts.add(vtxKey(e.a)); rimVerts.add(vtxKey(e.b)); }
    }
    if (!rimVerts.size) return;
    const owners = new Map();       // Randkante → [{ fi, loop }]
    faceDefs.forEach((fd, fi) => {
      for (const L of [fd.outer, ...fd.inner]) {
        if (L.circleRim) continue;
        for (let i = 0; i < L.length; i++) {
          const a = L[i], b = L[(i + 1) % L.length];
          const ka = vtxKey(a), kb = vtxKey(b);
          if (ka === kb || !rimVerts.has(ka) || !rimVerts.has(kb)) continue;
          const k = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
          let o = owners.get(k); if (!o) { o = []; owners.set(k, o); }
          o.push({ fi, loop: L });
        }
      }
    });
    // Vollständiger Kanten-Index erst, wenn ein Rand eine Fase sein könnte (coneBand läuft über das
    // ganze Band bis zur Deckfläche)
    let full = null;
    const allOwners = () => {
      if (full) return full;
      full = new Map();
      faceDefs.forEach((fd, fi) => {
        for (const L of [fd.outer, ...fd.inner]) {
          if (L.circleRim) continue;
          for (let i = 0; i < L.length; i++) {
            const a = L[i], b = L[(i + 1) % L.length];
            if (vtxKey(a) === vtxKey(b)) continue;
            const k = edgeKeyFn(a, b);
            let o = full.get(k); if (!o) { o = []; full.set(k, o); }
            o.push({ fi, loop: L });
          }
        }
      });
      return full;
    };
    const drop = new Set();
    for (const entry of mantleById.values()) {
      let res = null;
      try { res = sharpMantlePlan(entry, owners, fdsOfGroup, drop, allOwners); } catch (_) { res = null; }
      if (!res || !rimsClear(res.deckRims, res.decks)) continue;
      for (const fi of res.wall) drop.add(fi);
      res.decks.forEach((L, i) => { L.circleRim = res.deckRims[i]; });
      mantlePlans.push(res.plan);
      for (const cp of res.cones) mantleConePlans.push(cp);
    }
    if (drop.size) faceDefs = faceDefs.filter((_, i) => !drop.has(i));
  };

  // ---- Konvexe Kegel-Mäntel (Kegelstumpf, Kegel mit Spitze) als CONICAL_SURFACE ----
  // Die Erkennung (primitive-recognition.js) kennt keine Kegel — die Kandidaten kommen direkt aus
  // der Topologie: Saat ist ein Loop (außen oder innen) einer ebenen Fläche, der ein feiner,
  // gleichmäßig unterteilter VOLLKREIS ist (ringAsCircle). Die Facetten jenseits dieses Loops und
  // alle über Kanten anschließenden Facetten mit GLEICHER Neigung zur Achse (Normale von der Achse
  // weg = konvex) bilden die Wand. Ihr Rand muss sein:
  //   Kegelstumpf: genau 2 Ringe — der Saat-Loop und ein KOMPLETTER Loop einer zweiten, parallelen
  //     ebenen Deckfläche, mit anderem Radius (gleicher Radius = Zylinder → nicht hier);
  //   Kegel mit Spitze: genau 1 Ring (die Saat), alle Facetten laufen in EINEM Punkt auf der Achse
  //     zusammen (CONE_APEX).
  // Harte Gates wie beim Zylinder-Mantel: Ringe exakt auf ihrem Kreis in der Deckebene, Segmente
  // ≤ 42° und gleichmäßig (D-Schutz), volle Umrundung, koaxial; JEDER Wand-Punkt auf dem Kegel
  // (Toleranz wie beim Zylinder), jede Facetten-Normale passt zur Kegel-Normale (konvex), Kreise in
  // den Deck-Ebenen (circleOnDeck). Sonst bleibt die Wand facettiert. Flache, geneigte oder
  // unterbrochene Deckel, Kegel-Ketten ohne Deckfläche dazwischen und konkave Kegel (Senkung,
  // konisches Loch) bleiben damit facettiert.
  // Emission in assemble() als eigener Block (s. dort): same_sense .T. (die STEP-Kegelnormale zeigt
  // beim konvexen Kegel aus dem Material), Fläche links vom Rand, Spitze als VERTEX_LOOP.
  let mantleConePlans = [];
  let preSplitStats = null;         // Vorab-Zerlegung der unebenen Flächen (vor den Bohrungen)
  const CONE_APEX = true;           // Kegel mit Spitze umwandeln (VERTEX_LOOP an der Spitze)
  const CONE_TILT_TOL = 0.03;       // Wand-Flood: Achsanteil der Facetten-Normale wie die Saat (≈ ±1.7°)
  const CONE_NORMAL_COS = Math.cos(10 * Math.PI / 180); // Facetten-Normale ↔ Kegel-Normale
  const CONE_MIN_SEG = 9;           // ≥ 9 Segmente (SEG_MAX_DEG = 42°)
  const CONE_MAX_WALL = 20000;      // Wand-Flächen je Kandidat (Laufzeit-Schutz)
  // Geschlossener Punktzug (Ebene ⟂ n) als Vollkreis → { center, radius, maxSeg } | null: jeder
  // Punkt in der Kreisebene und auf dem Kreis, Segmente ≤ 42°, volle Umrundung, gleichmäßig.
  // maxSeg = größter Segmentwinkel (rad), Maß für wallSpanOk.
  const ringAsCircle = (ring, n) => {
    if (ring.length < CONE_MIN_SEG) return null;
    const f = fitCircleInPlane(ring, n);
    if (!f) return null;
    const tol = Math.max(0.01, 0.002 * f.radius);
    const rad = (p) => { const w = _sub3(p, f.center), t = _dot3(w, n); return { t, r: [w[0] - n[0] * t, w[1] - n[1] * t, w[2] - n[2] * t] }; };
    let turn = 0, maxSeg = 0;
    for (let i = 0; i < ring.length; i++) {
      const a = rad(ring[i]), b = rad(ring[(i + 1) % ring.length]);
      if (Math.abs(a.t) > tol || Math.abs(Math.hypot(a.r[0], a.r[1], a.r[2]) - f.radius) > tol) return null;
      const ang = Math.atan2(_dot3(_cross3(a.r, b.r), n), _dot3(a.r, b.r));
      if (Math.abs(ang) > SHARP_SEG_MAX_DEG * Math.PI / 180) return null;
      turn += ang; maxSeg = Math.max(maxSeg, Math.abs(ang));
    }
    if (Math.abs(Math.abs(turn) - 2 * Math.PI) > 1e-3) return null;
    if (!ringAngleUniform(ring, f.center, n)) return null;
    return { ...f, maxSeg };
  };
  // Innenpunkte einer Wand-Fläche: das Region-Growing fasst Facetten bis 0.05 mm Unebenheit zusammen,
  // Punkte im Inneren einer Fläche stehen in keinem Loop (eine 0.024 mm tiefe Delle mitten in der
  // Facette einer Welle R10 blieb so unsichtbar). Darum zusätzlich die Ecken ihrer Original-Dreiecke
  // (fd.src, falls vorhanden) prüfen — sie dürfen zwischen Sehnen-Polygon und Mantel liegen:
  // ρ ∈ [ρ_Mantel·cos(maxSeg/2) − tol, ρ_Mantel + tol]. off(p) = true → Punkt außerhalb.
  const srcPointsOk = (fd, off) => {
    const s = fd.src;
    if (!s || !s.verts || !s.tris) return true;
    for (const t of s.tris) for (let j = 0; j < 3; j++) if (off(s.verts[t * 3 + j])) return false;
    return true;
  };
  // Verdrillungs-Schutz (Wand eines Zylinders/Kegels): Punkte auf dem Mantel allein reichen nicht —
  // ist der obere Rand gegen den unteren verdreht und die Wand verbindet i ↔ i, liegen alle Punkte
  // auf den Randkreisen, die Facetten aber auf einem Hyperboloid (Taille bis R·(1 − cos(φ/2)) innen;
  // 30°-verdrillte Welle R5: Netz 1.7 % kleiner als der Zylinder). Eine echte Teilung verläuft
  // entlang der Mantellinien: jede Wand-Kante überspannt um die Achse höchstens einen Randsegment-
  // Winkel (Mantellinie 0, Sehne/Diagonale ≤ maxSeg). Kanten an der Spitze (Radius < rMin) zählen nicht.
  // loopsSpanOk: dieselbe Prüfung für beliebige geschlossene Polygone (Flächen-Loops, Original-Dreiecke —
  // gemeinsam mit dem Bohrungs-Pfad, s. boreWallOk)
  const loopsSpanOk = (loops, c, axis, maxSeg, rMin) => {
    const lim = maxSeg * 1.05 + 1e-9;
    for (const L of loops) {
      for (let i = 0; i < L.length; i++) {
        const wa = _sub3(L[i], c), wb = _sub3(L[(i + 1) % L.length], c);
        const ta = _dot3(wa, axis), tb = _dot3(wb, axis);
        const ra = [wa[0] - axis[0] * ta, wa[1] - axis[1] * ta, wa[2] - axis[2] * ta];
        const rb = [wb[0] - axis[0] * tb, wb[1] - axis[1] * tb, wb[2] - axis[2] * tb];
        if (Math.hypot(ra[0], ra[1], ra[2]) < rMin || Math.hypot(rb[0], rb[1], rb[2]) < rMin) continue;
        const x = _cross3(ra, rb);
        if (Math.atan2(Math.hypot(x[0], x[1], x[2]), _dot3(ra, rb)) > lim) return false;
      }
    }
    return true;
  };
  const wallSpanOk = (W, c, axis, maxSeg, rMin) => {
    const loops = [];
    for (const fi of W) { const fd = faceDefs[fi]; loops.push(fd.outer, ...fd.inner); }
    return loopsSpanOk(loops, c, axis, maxSeg, rMin);
  };
  const faceCentroid = (fd) => {
    let cx = 0, cy = 0, cz = 0, k = 0;
    for (const L of [fd.outer, ...fd.inner]) for (const p of L) { cx += p[0]; cy += p[1]; cz += p[2]; k++; }
    return [cx / k, cy / k, cz / k];
  };
  // Kegel-Band jenseits eines Rings (gemeinsamer Kern von Kegel-Mantel und Mantel-Fase): S0 = je
  // Ringkante genau EINE Fläche außerhalb von `stop` (Flächen auf der Ring-Seite: Saat-Deckfläche
  // bzw. Zylinder-Wand); Flood über gemeinsame Kanten zu Facetten GLEICHER Neigung zur Achse n0
  // (Normale von der Achse durch cs weg = konvex). Der Ring muss vollständig Rand des Bandes sein;
  // die übrigen Randkanten bilden keinen (Spitze) oder genau EINEN weiteren Ring, und der muss ein
  // KOMPLETTER Loop (außen oder innen) genau einer Fläche sein (Deckfläche).
  // → { W:Set<fi>, deck: { fi, fd, loop, ring } | null, groups } | null
  // concave=true: das Band ist die KONKAVE Innenwand (Bohrspitze) — die Facetten-Normalen zeigen dann
  // ZUR Achse statt von ihr weg (Spiegelbild der konvexen Kegel-Mäntel).
  const coneBand = (ring, stop, n0, cs, owners, taken, concave = false) => {
    const W = new Set(), startKeys = new Set();
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      if (vtxKey(a) === vtxKey(b)) continue;
      const k = edgeKeyFn(a, b);
      const others = (owners.get(k) || []).filter((o) => !stop.has(o.fi));
      if (others.length !== 1 || taken.has(others[0].fi)) return null;
      startKeys.add(k); W.add(others[0].fi);
    }
    if (!W.size) return null;
    // Neigung der Saat-Facetten zur Achse: weder Zylinder-Wand (⟂, < 0.2°) noch Deckfläche (∥).
    // Toleranz der Neigung relativ (grobe/ungleichmäßige Teilung: die Facetten-Neigung schwankt
    // um wenige % von α), damit bei kleiner Formschräge keine Zylinder-Facette (Neigung 0) mitläuft.
    let a0 = 0;
    for (const fi of W) a0 += _dot3(_norm3(faceDefs[fi].normal), n0);
    a0 /= W.size;
    if (!(Math.abs(a0) > 0.003 && Math.abs(a0) < 0.9998)) return null;
    const tiltTol = Math.min(CONE_TILT_TOL, Math.max(0.0015, 0.5 * Math.abs(a0)));
    const fitMemo = new Map();
    const fits = (fi) => {
      let ok = fitMemo.get(fi);
      if (ok !== undefined) return ok;
      const fd = faceDefs[fi], n = _norm3(fd.normal);
      ok = !fd.outer.circleRim && !fd.inner.some((L) => L.circleRim) && Math.abs(_dot3(n, n0) - a0) <= tiltTol;
      if (ok) { // konvex: Normale zeigt von der Achse weg (konkav: zur Achse hin)
        const w = _sub3(faceCentroid(fd), cs), t = _dot3(w, n0);
        ok = (concave ? -1 : 1) * _dot3(n, [w[0] - n0[0] * t, w[1] - n0[1] * t, w[2] - n0[2] * t]) > 0;
      }
      fitMemo.set(fi, ok);
      return ok;
    };
    for (const fi of W) if (!fits(fi)) return null;
    // Band: über gemeinsame Kanten alle passenden Facetten einsammeln
    const queue = [...W];
    while (queue.length) {
      const fd = faceDefs[queue.pop()];
      for (const L of [fd.outer, ...fd.inner]) {
        for (let i = 0; i < L.length; i++) {
          const a = L[i], b = L[(i + 1) % L.length];
          if (vtxKey(a) === vtxKey(b)) continue;
          for (const o of (owners.get(edgeKeyFn(a, b)) || [])) {
            if (stop.has(o.fi) || W.has(o.fi) || taken.has(o.fi) || !fits(o.fi)) continue;
            W.add(o.fi); queue.push(o.fi);
            if (W.size > CONE_MAX_WALL) return null;
          }
        }
      }
    }
    if (W.size < 3) return null;
    // Rand des Bandes: Kanten genau 1× im Band — außer dem Start-Ring Gegenüber genau EINE Fläche
    const cnt = new Map();
    for (const fi of W) {
      const fd = faceDefs[fi];
      for (const L of [fd.outer, ...fd.inner]) {
        for (let i = 0; i < L.length; i++) {
          const a = L[i], b = L[(i + 1) % L.length];
          if (vtxKey(a) === vtxKey(b)) continue;
          const k = edgeKeyFn(a, b), e = cnt.get(k);
          if (e) e.n++; else cnt.set(k, { n: 1, v0: a, v1: b });
        }
      }
    }
    const rimEdges = [], otherOf = new Map();
    let nStart = 0;
    for (const [k, e] of cnt) {
      if (e.n > 2) return null;
      if (e.n === 2) continue;
      if (startKeys.has(k)) { nStart++; continue; }
      const others = (owners.get(k) || []).filter((o) => !W.has(o.fi));
      if (others.length !== 1 || taken.has(others[0].fi)) return null;
      rimEdges.push({ v0: e.v0, v1: e.v1 });
      otherOf.set(k, others[0]);
    }
    if (nStart !== startKeys.size) return null;                 // Start-Ring ganz am Rand des Bandes
    const rings = chainEdges(rimEdges);
    if (rings.length > 1 || rings.reduce((s, r) => s + r.length, 0) !== rimEdges.length) return null; // jede Randkante in genau einem Ring
    let deck = null;
    if (rings.length === 1) {
      const dr = rings[0];
      let own = null;
      for (let i = 0; i < dr.length; i++) {
        const o = otherOf.get(edgeKeyFn(dr[i], dr[(i + 1) % dr.length]));
        if (!o || (own && (o.fi !== own.fi || o.loop !== own.loop))) return null;
        own = o;
      }
      const fd = faceDefs[own.fi];
      if ((fd.outer !== own.loop && !fd.inner.includes(own.loop)) || own.loop.circleRim || loopEdgeCount(own.loop) !== dr.length) return null;
      deck = { fi: own.fi, fd, loop: own.loop, ring: dr };
    } else if (rimEdges.length) return null;
    return { W, deck, groups: [...new Set([...W].map((fi) => faceDefs[fi].group).filter(Boolean))] };
  };
  // Liegt das Band auf dem Kegel ρ(t) = R0 + k·t (t entlang zAx ab c0, 0 ≤ t ≤ H)? Jeder Punkt
  // innerhalb tol, jede Facetten-Normale nahe der Kegel-Normale (e_r − k·zAx)/√(1+k²) — radial nach
  // außen, zur schmalen Seite gekippt — an ihrem Schwerpunkt. concave=true: das Band ist die
  // INNENwand (Bohrspitze) → die Facetten-Normalen zeigen zur Achse (Spiegelbild).
  const bandOnCone = (W, c0, R0, zAx, H, k, tol, maxSeg, concave = false) => {
    const cn = 1 / Math.sqrt(1 + k * k), cs = Math.cos(maxSeg / 2);
    // dr(p) = Achsabstand − Kegelradius auf Höhe t (null außerhalb 0 … H)
    const dr = (p) => {
      const w = _sub3(p, c0), t = _dot3(w, zAx);
      if (t < -tol || t > H + tol) return null;
      const rc = R0 + k * t;
      return { d: Math.hypot(w[0] - zAx[0] * t, w[1] - zAx[1] * t, w[2] - zAx[2] * t) - rc, rc };
    };
    const offLoop = (p) => { const q = dr(p); return !q || Math.abs(q.d) > tol; };
    const offSrc = (p) => { const q = dr(p); return !q || q.d > tol || q.d < -q.rc * (1 - cs) - tol; };
    for (const fi of W) {
      const fd = faceDefs[fi];
      for (const L of [fd.outer, ...fd.inner]) for (const p of L) if (offLoop(p)) return false;
      if (!srcPointsOk(fd, offSrc)) return false;
      const w = _sub3(faceCentroid(fd), c0), t = _dot3(w, zAx);
      const er = _norm3([w[0] - zAx[0] * t, w[1] - zAx[1] * t, w[2] - zAx[2] * t]);
      const nc = [(er[0] - k * zAx[0]) * cn, (er[1] - k * zAx[1]) * cn, (er[2] - k * zAx[2]) * cn];
      if (!((concave ? -1 : 1) * _dot3(_norm3(fd.normal), nc) >= CONE_NORMAL_COS)) return false;
    }
    return true;
  };
  // Plan für EINEN Saat-Loop → { plan, wall:Set<fi>, decks:[Loop…], rims:[Kreis…] } | null
  const sharpConePlan = (seed, owners, taken) => {
    const fi0 = seed.fi, L0 = seed.loop;
    const n0 = _norm3(faceDefs[fi0].normal);
    const R0 = seed.radius, c0 = seed.center;
    const band = coneBand(L0, new Set([fi0]), n0, c0, owners, taken);
    if (!band) return null;
    const { W, deck: d1, groups } = band;
    // Kegel: Radius ρ(t) = R0 + k·t entlang zAx (t = 0 in der Saat-Ebene)
    if (d1) {
      // ── Kegelstumpf zwischen zwei parallelen Deckflächen
      if (d1.fi === fi0 || Math.abs(_dot3(n0, _norm3(d1.fd.normal))) < 0.9999) return null;
      const f1 = ringAsCircle(d1.ring, n0);
      if (!f1) return null;
      const along = _dot3(_sub3(f1.center, c0), n0);
      const zAx = along >= 0 ? n0 : [-n0[0], -n0[1], -n0[2]];
      const H = Math.abs(along), R1 = f1.radius;
      const tol = Math.max(0.01, 0.002 * Math.max(R0, R1));
      if (!(H > tol) || !(Math.abs(R1 - R0) > tol)) return null;          // flach bzw. Zylinder
      const c1 = [c0[0] + zAx[0] * H, c0[1] + zAx[1] * H, c0[2] + zAx[2] * H];
      if (Math.hypot(f1.center[0] - c1[0], f1.center[1] - c1[1], f1.center[2] - c1[2]) > tol) return null; // koaxial
      const seg = Math.max(seed.maxSeg, f1.maxSeg);
      if (!bandOnCone(W, c0, R0, zAx, H, (R1 - R0) / H, tol, seg)) return null;
      if (!wallSpanOk(W, c0, zAx, seg, tol)) return null;                 // verdrillte Wand
      if (!circleOnDeck(c0, R0, zAx, faceDefs[fi0]) || !circleOnDeck(c1, R1, zAx, d1.fd)) return null;
      const rim0 = mkCircleDesc(c0, R0, zAx), rim1 = mkCircleDesc(c1, R1, zAx);
      if (rim0.rimKey === rim1.rimKey) return null;
      const grow = R1 > R0;                                   // wächst der Radius entlang zAx?
      return {
        plan: {
          large: grow ? rim1 : rim0, small: grow ? rim0 : rim1, apex: null,
          coneAxis: grow ? zAx : [-zAx[0], -zAx[1], -zAx[2]],   // Richtung wachsenden Radius
          semiAngle: Math.atan2(Math.abs(R1 - R0), H), groups,
          zone: { c0, zAx, H, R0, k: (R1 - R0) / H },
        },
        wall: W, decks: [L0, d1.loop], rims: [rim0, rim1],
      };
    }
    // ── Kegel mit Spitze: die Wand liegt auf EINER Seite der Saat-Ebene, ihr Punkt mit dem größten
    // Achsabstand ist die Spitze (auf der Achse)
    if (!CONE_APEX) return null;
    let st = 0;
    for (const fi of W) { const fd = faceDefs[fi]; for (const L of [fd.outer, ...fd.inner]) for (const p of L) st += _dot3(_sub3(p, c0), n0); }
    const zAx = st >= 0 ? n0 : [-n0[0], -n0[1], -n0[2]];
    let H = 0, top = null;
    for (const fi of W) { const fd = faceDefs[fi]; for (const L of [fd.outer, ...fd.inner]) for (const p of L) { const t = _dot3(_sub3(p, c0), zAx); if (t > H) { H = t; top = p; } } }
    const tol = Math.max(0.01, 0.002 * R0);
    if (!top || !(H > tol)) return null;
    const apex = [c0[0] + zAx[0] * H, c0[1] + zAx[1] * H, c0[2] + zAx[2] * H];
    if (Math.hypot(top[0] - apex[0], top[1] - apex[1], top[2] - apex[2]) > tol) return null; // Spitze auf der Achse
    if (!bandOnCone(W, c0, R0, zAx, H, -R0 / H, tol, seed.maxSeg) || !wallSpanOk(W, c0, zAx, seed.maxSeg, tol)) return null;
    if (!circleOnDeck(c0, R0, zAx, faceDefs[fi0])) return null;
    const rim0 = mkCircleDesc(c0, R0, zAx);
    return {
      plan: {
        large: rim0, small: null, apex, coneAxis: [-zAx[0], -zAx[1], -zAx[2]],
        semiAngle: Math.atan2(R0, H), groups, zone: { c0, zAx, H, R0, k: -R0 / H },
      },
      wall: W, decks: [L0], rims: [rim0],
    };
  };
  // Alle passenden konvexen Kegel umwandeln: Wandflächen entfallen, die Deck-Loops werden zur
  // analytischen Kreis-Kante (loop.circleRim). Scheitert ein Gate → facettiert lassen.
  const convertMantleCones = () => {
    // Saat-Loops: Vollkreis-Kandidaten (billiger Vorfilter — ohne Kandidaten kein Kanten-Index)
    const seeds = [];
    faceDefs.forEach((fd, fi) => {
      const n = _norm3(fd.normal);
      for (const L of [fd.outer, ...fd.inner]) {
        if (L.circleRim || loopEdgeCount(L) < CONE_MIN_SEG) continue;
        const f = ringAsCircle(L, n);
        if (f) seeds.push({ fi, loop: L, center: f.center, radius: f.radius, maxSeg: f.maxSeg });
      }
    });
    if (!seeds.length) return;
    const owners = new Map();       // Kante → [{ fi, loop }]
    faceDefs.forEach((fd, fi) => {
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
    for (const seed of seeds) {
      if (seed.loop.circleRim || drop.has(seed.fi)) continue;
      let res = null;
      try { res = sharpConePlan(seed, owners, drop); } catch (_) { res = null; }
      if (!res || !rimsClear(res.rims, res.decks)) continue;
      for (const fi of res.wall) drop.add(fi);
      res.decks.forEach((L, i) => { L.circleRim = res.rims[i]; });
      mantleConePlans.push(res.plan);
    }
    if (drop.size) faceDefs = faceDefs.filter((_, i) => !drop.has(i));
  };

  // ---- Body-Defeaturing v2c: Verrundungs-Bänder an KEGEL-Wänden schärfen ----
  // v2 (defeatureBands) schärft Bänder zwischen einer Ebene (Deckfläche) und Wänden, die
  // SENKRECHT auf der Ebene stehen (Wandnormale ⊥ Ebene). Steht an der Kante eine schräge Wand
  // (Kegel/Fase), bleibt das Band stehen: ein Kegelstumpf mit verrundeten Rändern bleibt
  // facettiert, obwohl „Verrundungen entfernen" an ist.
  // Dieser Pass schärft genau solche Bänder: Er läuft die Wand einer Deckfläche in Ringen (Zeilen)
  // ab und sucht im Profil (ρ, z) — dem Meridian-Schnitt durch die Achse — einen LAUF von ≥ 2
  // geraden Wandstücken, der einen Kreisbogen (Verrundung) bildet: zwischen einer Deckfläche und
  // einer schrägen Wand (Kegel) oder zwischen einer zylindrischen und einer kegelförmigen Wand.
  // Der scharfe Punkt X = Schnitt der beiden Nachbar-Geraden; die Ringe vor/nach dem Lauf werden
  // auf X's Radius und Höhe geschoben (gleicher Azimut → die Wand behält ihre Form, sie wird nur
  // verlängert bzw. verkürzt), die Verrundungs-Facetten entfallen. Danach erkennt
  // convertMantleCones() die scharfe Kegelwand als CONICAL_SURFACE.
  // Bohrungen und Senkungen (Normale nach innen) sind per Außen-Gate ausgeschlossen — sie gehören
  // zum Bohrungs-Pfad (dort wird die Fase zur Senkung). DECK–ZYL (die v2-Aufgabe) bleibt hier
  // unberührt.
  const defeatureConeBands = () => {
    const KINK_MAX = 25 * Math.PI / 180;      // Knick im Lauf (Verrundung): ≤ 25°
    const KINK_MIN = 0.05 * Math.PI / 180;     // … und > 0.05° (sonst kein echter Knick)
    const MERGE_COS = Math.cos(0.2 * Math.PI / 180);  // Zeilen gleicher Richtung → 1 Segment
    const AXIS_COS = Math.cos(2 * Math.PI / 180);      // CYL: Richtung ⊥ zur Achse (2°)
    const CONE_COS = Math.cos(2 * Math.PI / 180);      // CONE: ≥ 2° zu BEIDEN Profil-Achsen
    const MAX_ROWS = 256;                   // Zeilen je Wand (Laufzeit-Schutz)
    const MAX_ITERS = 64;                   // Schärfungen je Export
    const removed = new Set();              // entfernte Verrundungs-Facetten (Index in faceDefs)
    const cross2 = (p, q) => p[0] * q[1] - p[1] * q[0];
    const dot2 = (p, q) => p[0] * q[0] + p[1] * q[1];
    const ang2 = (p, q) => Math.acos(Math.max(-1, Math.min(1, dot2(p, q))));
    // Abstand Punkt → Gerade (Richtung ist Einheitsvektor)
    const distLine = (p, line) => Math.abs(cross2([p[0] - line.p[0], p[1] - line.p[1]], line.dir));
    let done = 0;
    for (let iter = 0; iter < MAX_ITERS; iter++) {
      // Saat: Flächen mit einem echten Kreis-Loop (Deckflächen, Deckel von Kegeln/Zylindern)
      const seeds = [];
      faceDefs.forEach((fd, fi) => {
        if (removed.has(fi)) return;
        const a = _norm3(fd.normal);
        for (const L of [fd.outer, ...fd.inner]) {
          if (L.circleRim) continue;
          const f = ringAsCircle(L, a);
          if (f) seeds.push({ fi, L, f, a });
        }
      });
      if (!seeds.length) break;
      // Vertex-Schlüssel → Flächen-Indizes (je Iteration neu: verschobene Punkte ändern Schlüssel)
      const vtxFaces = new Map();
      faceDefs.forEach((fd, fi) => {
        if (removed.has(fi)) return;
        for (const L of [fd.outer, ...fd.inner]) {
          if (L.circleRim) continue;
          for (const p of L) {
            const k = vtxKey(p);
            let o = vtxFaces.get(k);
            if (!o) { o = []; vtxFaces.set(k, o); }
            if (o[o.length - 1] !== fi) o.push(fi);
          }
        }
      });
      let plan = null;
      for (const s of seeds) {
        // Auswertung wirft nie nach einer Änderung: ein Fehler verwirft nur diese Saat,
        // bereits angewandte Bänder bleiben konsistent
        try { plan = evalConeSeed(s, vtxFaces); } catch (_) { plan = null; }
        if (plan) break;
      }
      if (!plan) break;
      applyConeBand(plan);
      done++;
    }
    if (removed.size) faceDefs = faceDefs.filter((_, i) => !removed.has(i));
    return done;

    // ---- Saat: Deckfläche P (Kreis-Loop L) → Wand in Zeilen ablaufen, Lauf suchen
    function evalConeSeed({ fi: pi, L, f, a }, vtxFaces) {
      const c = f.center;
      const tol = Math.max(0.01, 0.002 * f.radius);
      const uRef = computeRefDir(a), vRef = _cross3(a, uRef);
      // Punkt → Profil: z (Höhe entlang der Achse), ρ (Radius), e (Radialrichtung), Azimut
      const fr = (p) => {
        const w = _sub3(p, c);
        const z = _dot3(w, a);
        const rv = [w[0] - a[0] * z, w[1] - a[1] * z, w[2] - a[2] * z];
        const rho = Math.hypot(rv[0], rv[1], rv[2]);
        return { z, rho, e: rho > 1e-12 ? [rv[0] / rho, rv[1] / rho, rv[2] / rho] : null, az: Math.atan2(_dot3(w, vRef), _dot3(w, uRef)) };
      };
      // Umlaufsinn eines Loops um die Achse (positiv = rechtshändig um a)
      const senseOf = (loop) => {
        let s = 0;
        for (let i = 0; i < loop.length; i++) {
          const p = _sub3(loop[i], c), q = _sub3(loop[(i + 1) % loop.length], c);
          s += _dot3(_cross3(p, q), a);
        }
        return s >= 0 ? 1 : -1;
      };
      // ---- Zeilen (Ringe) der Wand unter dem Saat-Loop
      const rows = [];
      let R = L.slice();
      const used = new Set([pi]);
      let endDeck = null, zEnd = null;
      for (let k = 1; k <= MAX_ROWS; k++) {
        const rk = new Set(R.map(vtxKey));
        const cand = new Set();
        for (const key of rk) for (const fj of (vtxFaces.get(key) || [])) if (!used.has(fj) && !removed.has(fj)) cand.add(fj);
        if (!cand.size) break;
        const S = [...cand];
        // Enddeck? Genau eine ebene Fläche, deren Loop dem Ring entspricht
        if (S.length === 1) {
          const Q = faceDefs[S[0]];
          if (Math.abs(_dot3(_norm3(Q.normal), a)) >= 0.9999) {
            for (const Lq of [Q.outer, ...Q.inner]) {
              if (Lq.circleRim || Lq.length !== R.length) continue;
              let same = true;
              for (const p of Lq) if (!rk.has(vtxKey(p))) { same = false; break; }
              if (same) { endDeck = { fi: S[0], loop: Lq }; zEnd = fr(R[0]).z; break; }
            }
            if (endDeck) break;
          }
        }
        // Wandzeile: keine inneren Löcher, keine ebene Fläche (sonst Deck, nicht Wand)
        let bad = false;
        for (const fj of S) if (faceDefs[fj].inner.length) { bad = true; break; }
        if (!bad) for (const fj of S) if (Math.abs(_dot3(_norm3(faceDefs[fj].normal), a)) >= 0.9999) { bad = true; break; }
        if (bad) break;
        // Nächster Ring: alle Punkte der S-Flächen, die nicht im Ring davor liegen
        const nk = new Map();
        for (const fj of S) {
          const fd = faceDefs[fj];
          for (const Lp of [fd.outer, ...fd.inner]) for (const p of Lp) {
            const key = vtxKey(p);
            if (rk.has(key) || nk.has(key)) continue;
            nk.set(key, p);
          }
        }
        if (!nk.size) break;
        let rhoMin = Infinity, rhoMax = -Infinity, zMin = Infinity, zMax = -Infinity;
        for (const p of nk.values()) { const q = fr(p); rhoMin = Math.min(rhoMin, q.rho); rhoMax = Math.max(rhoMax, q.rho); zMin = Math.min(zMin, q.z); zMax = Math.max(zMax, q.z); }
        if (rhoMax <= tol) break;                                // Kegelspitze (kein Ring)
        if (rhoMax - rhoMin > tol || zMax - zMin > tol) break;    // kein Kreis-Ring
        const cyc = orderRing(nk, S);
        if (!cyc) break;
        rows.push({ faces: S, ring: cyc, ringPrev: R, p: [(rhoMin + rhoMax) / 2, (zMin + zMax) / 2] });
        for (const fj of S) used.add(fj);
        R = cyc;
      }
      // ---- Segmente: Zeilen mit gleicher Richtung (≤ 0.2°) → ein Segment
      const segs = [];
      let pPrev = [f.radius, 0];
      for (const row of rows) {
        const p = row.p;
        const d = [p[0] - pPrev[0], p[1] - pPrev[1]];
        const len = Math.hypot(d[0], d[1]);
        if (!(len > 1e-9)) break;
        const dir = [d[0] / len, d[1] / len];
        const last = segs[segs.length - 1];
        if (last && dot2(last.dir, dir) >= MERGE_COS) {
          last.rows.push(row); last.end = p; last.len += len;
          for (const fj of row.faces) last.faces.push(fj);
        } else {
          // `p`: Punkt auf der Geraden (Start des Segments) — distLine() und die X-Schnitt-
          // Rechnung brauchen ihn (die Profil-Gerade ist durch p + t*dir definiert).
          segs.push({ rows: [row], start: pPrev, p: pPrev, end: p, dir, len, faces: [...row.faces] });
        }
        pPrev = p;
      }
      if (segs.length < 2) return null;
      // ---- Nachbarn: Deckfläche (virtuell) oder reales Segment (ZYL/Kegel)
      const typeOf = (s) => {
        if (Math.abs(s.dir[1]) >= AXIS_COS) return 'CYL';       // ⊥ zur Achse
        if (Math.abs(s.dir[0]) <= CONE_COS) return 'CONE';       // schräg in beiden Achsen
        return null;
      };
      const deckA = { type: 'DECK', p: [f.radius, 0], dir: [1, 0], len: Infinity };
      const deckB = endDeck ? { type: 'DECK', p: [f.radius, zEnd], dir: [1, 0], len: Infinity } : null;
      for (let i = 0; i + 1 < segs.length; i++) {
        const A = i === 0 ? deckA : segs[i - 1];
        const aType = i === 0 ? 'DECK' : typeOf(segs[i - 1]);
        if (!aType) continue;
        for (let j = segs.length - 1; j >= i + 1; j--) {
          const B = (j === segs.length - 1) ? deckB : segs[j + 1];
          if (!B) continue;
          const bType = B === deckB ? 'DECK' : typeOf(segs[j + 1]);
          if (!bType) continue;
          const pair = aType + '-' + bType;
          if (pair !== 'DECK-CONE' && pair !== 'CONE-DECK' && pair !== 'CYL-CONE' && pair !== 'CONE-CYL') continue;
          const plan = checkRun(i, j, A, aType, B, bType);
          if (plan) return plan;
        }
      }
      return null;

      // ---- Lauf prüfen (Knicke, Kreis, Tangentialität, Außen-Gate, scharfer Punkt)
      function checkRun(i, j, A, aType, B, bType) {
        // rej(…): Lauf verwerfen (die Begründung steht als Text am Aufruf)
        const rej = () => null;
        const run = segs.slice(i, j + 1);
        // Deck-Linien: so orientieren, dass der Knick zum Lauf klein ist
        let dA = A.dir, dB = B.dir;
        if (aType === 'DECK') { const o = pickDir(run[0].dir); if (!o) return rej('pickDirA'); dA = o; }
        if (bType === 'DECK') { const o = pickDir(run[run.length - 1].dir); if (!o) return rej('pickDirB'); dB = o; }
        // Knicke: alle klein und im SELBEN Umlaufsinn
        const dirs = [dA, ...run.map((s) => s.dir), dB];
        let sign = 0;
        for (let t = 0; t + 1 < dirs.length; t++) {
          const ang = ang2(dirs[t], dirs[t + 1]);
          if (!(ang <= KINK_MAX && ang >= KINK_MIN)) return rej(`kink ${(ang * 180 / Math.PI).toFixed(2)}°`);
          const sg = Math.sign(cross2(dirs[t], dirs[t + 1]));
          if (!sg) return rej('kink sign 0');
          if (!sign) sign = sg; else if (sg !== sign) return rej('kink sign');
        }
        // Reale Nachbarn deutlich länger als das längste Lauf-Stück (echte Verrundung)
        let maxRunLen = 0;
        for (const s of run) maxRunLen = Math.max(maxRunLen, s.len);
        if (aType !== 'DECK' && A.len < 3 * maxRunLen) return rej('lenA');
        if (bType !== 'DECK' && B.len < 3 * maxRunLen) return rej('lenB');
        // Lauf-Punkte im Profil + Kreis-Fit (Kåsa)
        const pts = [run[0].start];
        for (const s of run) pts.push(s.end);
        if (pts.length < 3) return rej('pts');
        const fit = fitCircle2d(pts);
        if (!fit || !(fit.r > 0)) return rej('fit');
        const r = fit.r;
        let dev = 0;
        for (const p of pts) dev = Math.max(dev, Math.abs(Math.hypot(p[0] - fit.c[0], p[1] - fit.c[1]) - r));
        if (dev > Math.max(0.005, 0.02 * r)) return rej(`dev ${dev.toFixed(4)}/${r.toFixed(3)}`);
        // Tangentialität an beide Nachbar-Geraden
        const tolT = Math.max(0.01, 0.05 * r);
        if (Math.abs(distLine(fit.c, A) - r) > tolT) return rej(`tangA ${distLine(fit.c, A).toFixed(4)} vs ${r.toFixed(4)}`);
        if (Math.abs(distLine(fit.c, B) - r) > tolT) return rej(`tangB ${distLine(fit.c, B).toFixed(4)} vs ${r.toFixed(4)}`);
        // Lauf-Facetten + reale Nachbar-Facetten: Normale nach außen (Löcher/Senkungen ausgeschlossen)
        const runFaces = [];
        for (const s of run) for (const fj of s.faces) runFaces.push(fj);
        if (!outwardOk(runFaces, -1e-6)) return rej('out-run');
        if (aType !== 'DECK' && !outwardOk(A.faces, 0.05)) return rej('out-A');
        if (bType !== 'DECK' && !outwardOk(B.faces, 0.05)) return rej('out-B');
        // Gesperrt? (Rückfall je Merkmal) oder Biegung eines Blechprofils → Lauf bleibt facettiert
        for (const fj of runFaces) { const g = faceDefs[fj].group; if (g && (blockedGroups.has(g) || bendGroups.has(g))) return rej('blocked'); }
        // Auch die NACHBAR-Flächen, deren Punkte verschoben werden (replaceFaces: die erste Reihe von
        // B bzw. die letzte Reihe von A), dürfen keine Biegungs-Gruppe sein — sonst zöge der
        // Kegel-Band-Lauf die Biegung (Innen-/Außenbogen) mit auf den scharfen Punkt und
        // zerstörte sie.
        const firstRowB = bType === 'DECK' ? [] : B.rows[0].faces;
        const lastRowA = aType === 'DECK' ? [] : A.rows[A.rows.length - 1].faces;
        for (const fj of [...firstRowB, ...lastRowA]) { const g = faceDefs[fj].group; if (g && bendGroups.has(g)) return rej('blocked'); }
        // Scharfer Punkt X = Schnitt der Nachbar-Geraden
        const den = cross2(A.dir, B.dir);
        if (Math.abs(den) < 1e-9) return rej('parallel');
        const dv = [B.p[0] - A.p[0], B.p[1] - A.p[1]];
        const t = cross2(dv, B.dir) / den;
        const X = [A.p[0] + A.dir[0] * t, A.p[1] + A.dir[1] * t];
        if (aType === 'DECK') X[1] = 0;         // Deckebene exakt
        if (bType === 'DECK') X[1] = zEnd;      // Enddeck-Ebene exakt
        if (!(X[0] > Math.max(tol, 0.05 * r))) return rej(`Xrho ${X[0]}`);
        if (Math.hypot(X[0] - pts[0][0], X[1] - pts[0][1]) > 3 * r) return rej('X-start');
        const lastPt = pts[pts.length - 1];
        if (Math.hypot(X[0] - lastPt[0], X[1] - lastPt[1]) > 3 * r) return rej('X-end');
        // Ringe vor/nach dem Lauf
        const Rs = run[0].rows[0].ringPrev;
        const lastRow = run[run.length - 1].rows[run[run.length - 1].rows.length - 1];
        const Re = lastRow.ring;
        // Sicherheit: keine andere Fläche benutzt die Ring-Punkte
        const allowed = new Set([pi]);
        if (endDeck) allowed.add(endDeck.fi);
        for (const fj of runFaces) allowed.add(fj);
        for (const fj of firstRowB) allowed.add(fj);
        for (const fj of lastRowA) allowed.add(fj);
        for (const ring of [Rs, Re]) for (const p of ring) {
          for (const fj of (vtxFaces.get(vtxKey(p)) || [])) if (!allowed.has(fj)) return rej(`safety ${fj}`);
        }
        // Abbilden: Ring-Punkt auf X schieben (gleicher Azimut → die Wand behält ihre Form)
        const mapPoint = (p) => {
          const q = fr(p);
          return [c[0] + a[0] * X[1] + q.e[0] * X[0], c[1] + a[1] * X[1] + q.e[1] * X[0], c[2] + a[2] * X[1] + q.e[2] * X[0]];
        };
        const mapPts = new Map();
        let deckFace = -1, deckLoop = null, newLoop = null;
        let replaceFaces = [];
        if (aType === 'DECK') {
          // Deck-Loop ← abgebildete Re-Punkte (Umlaufsinn wie der alte Loop)
          for (const p of Re) mapPts.set(vtxKey(p), mapPoint(p));
          newLoop = Re.map((p) => mapPts.get(vtxKey(p)));
          if (senseOf(newLoop) !== senseOf(L)) newLoop.reverse();
          deckFace = pi; deckLoop = L;
          replaceFaces = firstRowB.slice();
        } else if (bType === 'DECK') {
          // Enddeck-Loop ← abgebildete Rs-Punkte
          for (const p of Rs) mapPts.set(vtxKey(p), mapPoint(p));
          newLoop = Rs.map((p) => mapPts.get(vtxKey(p)));
          if (senseOf(newLoop) !== senseOf(endDeck.loop)) newLoop.reverse();
          deckFace = endDeck.fi; deckLoop = endDeck.loop;
          replaceFaces = lastRowA.slice();
        } else {
          // Zylinder ↔ Kegel: beide Ringe auf dieselben neuen Punkte (eine scharfe Kante).
          // Die beiden Ring-Zyklen starten ggf. an verschiedenen Ecken (Index-Versatz) →
          // deshalb nach AZIMUT paaren, nicht nach Index.
          if (Rs.length !== Re.length) return rej('ring count');
          const normAz = (a) => { let v = a % (2 * Math.PI); if (v < 0) v += 2 * Math.PI; return v; };
          const azRs = Rs.map((p) => normAz(fr(p).az));
          const azRe = Re.map((p) => normAz(fr(p).az));
          const usedRe = new Set();
          for (let t = 0; t < Rs.length; t++) {
            let hit = -1;
            for (let u = 0; u < Re.length; u++) {
              if (usedRe.has(u)) continue;
              let d = azRs[t] - azRe[u];
              while (d > Math.PI) d -= 2 * Math.PI;
              while (d < -Math.PI) d += 2 * Math.PI;
              if (Math.abs(d) <= 1e-6) { hit = u; break; }
            }
            if (hit < 0) return rej(`azimut ${azRs[t].toFixed(6)}`);
            usedRe.add(hit);
            const np = mapPoint(Rs[t]);
            mapPts.set(vtxKey(Rs[t]), np);
            mapPts.set(vtxKey(Re[hit]), np);
          }
          if (usedRe.size !== Re.length) return rej('azimut bijektion');
          replaceFaces = [...lastRowA, ...firstRowB];
        }
        return { pi, qfi: endDeck ? endDeck.fi : -1, runFaces, mapPts, deckFace, deckLoop, newLoop, replaceFaces };
      }

      // Richtung der virtuellen Deck-Linie (z = const): so wählen, dass der Knick klein ist
      function pickDir(sd) {
        let best = null;
        for (const d of [[1, 0], [-1, 0]]) {
          const ang = ang2(d, sd);
          if (!best || ang < best.ang) best = { dir: d, ang };
        }
        return best.ang <= KINK_MAX ? best.dir : null;
      }
      // Außen-Gate: Radialanteil der Flächennormale am Loop-Schwerpunkt
      function outwardOk(faces, minRad) {
        for (const fj of faces) {
          const fd = faceDefs[fj];
          const n = _norm3(fd.normal);
          const ct = loopCentroid([fd.outer]);
          if (!ct) return false;
          const q = fr(ct);
          if (!q.e) return false;
          if (_dot3(n, q.e) < minRad) return false;
        }
        return true;
      }
    }

    // Ring N zu einem Zyklus ordnen (Kanten der S-Flächen, beide Enden in N)
    function orderRing(nk, S) {
      const adj = new Map();
      for (const fj of S) {
        const fd = faceDefs[fj];
        for (const Lp of [fd.outer, ...fd.inner]) {
          for (let i = 0; i < Lp.length; i++) {
            const k1 = vtxKey(Lp[i]), k2 = vtxKey(Lp[(i + 1) % Lp.length]);
            if (k1 === k2 || !nk.has(k1) || !nk.has(k2)) continue;
            if (!adj.has(k1)) adj.set(k1, []);
            if (!adj.has(k2)) adj.set(k2, []);
            const l1 = adj.get(k1), l2 = adj.get(k2);
            if (!l1.includes(k2)) l1.push(k2);
            if (!l2.includes(k1)) l2.push(k1);
          }
        }
      }
      for (const key of nk.keys()) { const l = adj.get(key); if (!l || l.length !== 2) return null; }
      const start = nk.keys().next().value;
      const out = [];
      let prev = null, cur = start;
      for (let guard = 0; guard <= nk.size; guard++) {
        out.push(nk.get(cur));
        const l = adj.get(cur);
        const nxt = l[0] === prev ? l[1] : l[0];
        if (nxt === start) return out.length === nk.size ? out : null;
        prev = cur; cur = nxt;
      }
      return null;
    }

    // Kreis-Fit (Kåsa) für Punkte (ρ, z) → { c, r } | null
    function fitCircle2d(pts) {
      const n = pts.length;
      if (n < 3) return null;
      let Sx = 0, Sy = 0, Sxx = 0, Syy = 0, Sxy = 0, Sz = 0, Sxz = 0, Syz = 0;
      for (const p of pts) {
        const x = p[0], y = p[1], z = x * x + y * y;
        Sx += x; Sy += y; Sxx += x * x; Syy += y * y; Sxy += x * y; Sz += z; Sxz += x * z; Syz += y * z;
      }
      const M = [[Sxx, Sxy, Sx, -Sxz], [Sxy, Syy, Sy, -Syz], [Sx, Sy, n, -Sz]];
      for (let cc = 0; cc < 3; cc++) {
        let piv = cc;
        for (let r = cc + 1; r < 3; r++) if (Math.abs(M[r][cc]) > Math.abs(M[piv][cc])) piv = r;
        if (Math.abs(M[piv][cc]) < 1e-12) return null;
        [M[cc], M[piv]] = [M[piv], M[cc]];
        for (let r = 0; r < 3; r++) {
          if (r === cc) continue;
          const fq = M[r][cc] / M[cc][cc];
          for (let j = cc; j < 4; j++) M[r][j] -= fq * M[cc][j];
        }
      }
      const D = M[0][3] / M[0][0], E = M[1][3] / M[1][1], F = M[2][3] / M[2][2];
      const cx = -D / 2, cy = -E / 2;
      const r2 = cx * cx + cy * cy - F;
      if (!(r2 > 0)) return null;
      return { c: [cx, cy], r: Math.sqrt(r2) };
    }

    // ---- Anwenden: Deck-Loop ersetzen, Ring-Punkte schieben, Lauf-Facetten entfernen
    function applyConeBand(plan) {
      const { pi, qfi, runFaces, mapPts, deckFace, deckLoop, newLoop, replaceFaces } = plan;
      const op = { kind: 'v2c', groups: runFaces.map((fj) => faceDefs[fj].group).filter(Boolean), keys: new Set() };
      for (const fj of runFaces) addLoopKeys(op.keys, faceDefs[fj]);
      for (const p of mapPts.values()) op.keys.add(vtxKey(p));
      featureOps.push(op);
      markOp(faceDefs[pi], op);
      if (qfi >= 0) markOp(faceDefs[qfi], op);
      // Deck-Loop ersetzen (dasselbe Array-Objekt → die Fläche behält ihre Identität)
      if (deckLoop) { deckLoop.length = 0; deckLoop.push(...newLoop); }
      // Ring-Punkte in den Nachbarflächen ersetzen
      const touched = new Set();
      for (const fj of replaceFaces) {
        const fd = faceDefs[fj];
        let changed = false;
        for (const Lp of [fd.outer, ...fd.inner]) {
          for (let i = 0; i < Lp.length; i++) {
            const np = mapPts.get(vtxKey(Lp[i]));
            if (np && np !== Lp[i]) { Lp[i] = np; changed = true; }
          }
        }
        if (changed) { touched.add(fj); markOp(fd, op); }
      }
      // Schwerpunkte nachziehen
      for (const fj of touched) { const fd = faceDefs[fj]; const ct = loopCentroid([fd.outer, ...fd.inner]); if (ct) fd.centroid = ct; }
      if (deckFace >= 0) { const fd = faceDefs[deckFace]; const ct = loopCentroid([fd.outer, ...fd.inner]); if (ct) fd.centroid = ct; }
      // Verrundungs-Facetten entfallen
      for (const fj of runFaces) removed.add(fj);
    }
  };

  // ---- Ablauf (re-entrant für die Fallback-Stufen) ----
  // withBores=false: ohne Bohrungs-Umwandlung (Defeaturing bleibt). Setzt faceDefs, finalPlans,
  // chamferZones und die Defeaturing-Zähler.
  // withBores=false (Fallback-Stufe 1): ohne analytische Bohrungen, Mäntel, Kegel UND Kanäle neu bauen.
  const runPipeline = (withBores) => {
    finalPlans = []; chamferZones = []; tubePlans = []; mantlePlans = []; mantleConePlans = []; chamferDroppedGroups = new Set();
    boreNotes = new Map();
    preSplitStats = null;
    filletsDefeatured = 0; bandsDefeatured = 0; cornersDefeatured = 0; coneBandsDefeatured = 0; featureOps = [];
    if (!DEFEATURE) {
      // Toggle AUS — bisheriger Ablauf unverändert: Bohrungs-Pläne aus den Original-Dreiecken,
      // Bohrungs-Gruppen vorerst überspringen, nur Direkt-Treffer; gescheiterte Pläne bekommen
      // frische Facetten.
      const tentative = [];
      const boreSkip = new Set();
      if (withBores) {
        for (const entry of boreById.values()) {
          if (blockedBores.has(entry)) continue;      // gesperrt (Rückfall je Bohrung) → bleibt facettiert
          let plan = null;
          try { plan = attemptBore(entry); } catch (_) { plan = null; }
          if (plan) { tentative.push(plan); for (const g of plan.groups) boreSkip.add(g); }
        }
      }
      faceDefs = buildFaceDefs(boreSkip);
      matchBorePlans(tentative, (plan) => { for (const g of plan.groups) for (const fd of extractGroupFaces(g)) { fd.group = g; faceDefs.push(fd); } });
      // Sacklöcher auch OHNE Toggle: der scharfe Pfad (blindOnly) ersetzt die Wand durch Zylinder +
      // Boden; die Durchgangslöcher behalten hier den Bestandspfad (attemptBore/matchBorePlans).
      if (withBores) { convertSharpBores(true); planTubes(); convertMantles(); convertMantleCones(); }
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
    // Kegel-Bänder (v2c): Verrundungen an schrägen Wänden (Kegel/Fase) schärfen — danach
    // erkennt convertMantleCones() die scharfe Kegelwand als CONICAL_SURFACE.
    try {
      coneBandsDefeatured = defeatureConeBands();
    } catch (_) { coneBandsDefeatured = 0; /* Guard: Änderungen werden erst nach allen Prüfungen angewandt */ }
    bandsDefeatured += coneBandsDefeatured;
    if (!withBores) return;
    // VOR der Bohrungs-Umwandlung: die unebenen Flächen zerlegen. Deckflächen mit einem Kreis-Rand
    // (Bohrungs-Mündung) lassen sich danach nicht mehr zerlegen (enforcePlanarity überspringt
    // Kreis-Rand-Flächen) → die Fläche bliebe uneben (Kabelhalter-Befund: bis 1,5e-3 mm schief) und
    // die Bohrungsachse nähme die schiefe Deckflächen-Normale. So sehen die Bohrungs-Pfade exakt
    // ebene Deck-Teile; strikte Importer (vertex-surface) verwerfen die Fläche sonst.
    markUntouched(faceDefs);
    const pl0 = enforcePlanarity(faceDefs);
    faceDefs = pl0.fds;
    preSplitStats = pl0.st;
    const sharp = convertSharpBores();
    convertMantles();
    convertMantleCones();
    // Übrige Bohrungen: bisheriger Pfad (direkt oder Fase → Kegel). Bleibt für Mündungen, die v2
    // NICHT schärfen konnte (echte Fase, Mündung auf einer Fläche ohne senkrechte Wand, …).
    // Die Ränder kommen dabei aus den AKTUELLEN Wand-faceDefs (attemptBoreCurrent, Review-Fund a):
    // nach v2 geschärfte Mündungen liegen so in der Deckebene (Direkt-Treffer), nur die echte Fase
    // geht in den Kegel-Pfad — vorher blieben gemischte Mündungen komplett facettiert, weil die
    // Ränder aus den ORIGINAL-Dreiecken stammten. Wandflächen herausnehmen; scheitert der Plan,
    // kommen genau diese (evtl. von v1/v2 angepassten) Flächen zurück.
    const tentative = [];
    const saved = new Map();
    const fdsOfGroupL = new Map();
    faceDefs.forEach((fd, fi) => {
      if (fd.group) { let a = fdsOfGroupL.get(fd.group); if (!a) { a = []; fdsOfGroupL.set(fd.group, a); } a.push(fi); }
    });
    for (const entry of boreById.values()) {
      if (sharp.has(entry) || blockedBores.has(entry)) continue;
      let plan = null;
      try { plan = attemptBoreCurrent(entry, fdsOfGroupL); } catch (_) { plan = null; }
      if (plan) tentative.push(plan);
    }
    if (!tentative.length) return;
    // Wandflächen erst NACH dem Scan aller Einträge herausnehmen (fdsOfGroupL indiziert faceDefs)
    for (const plan of tentative) {
      const gs = new Set(plan.groups);
      saved.set(plan, faceDefs.filter((fd) => gs.has(fd.group)));
      faceDefs = faceDefs.filter((fd) => !gs.has(fd.group));
    }
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

  // Auf die Ebenen gesetzte Eckpunkte (snapToPlanes, je assemble-Aufruf) — Schlüssel → Punkt
  let vertexSnap = null;
  // Schalen-Analyse (unten, 2. Durchgang von assemble): Kanten-Schlüssel → Komponenten-Kennung. Jede
  // Kante gehört genau einer Zusammenhangskomponente; ihre Ecken werden dann je Komponente angelegt —
  // zwei Körper, die sich in einer Ecke/Kante berühren, teilen sich so keinen VERTEX_POINT.
  let edgeScope = null;
  // w = die Koordinaten, wie sie in der Datei stehen (gerundet; bei gleichem Schlüssel die des
  // zuerst gesehenen Punkts) — LINE-Richtungen werden daraus berechnet.
  const getVertex = (pt, tag = '') => {
    const pk = ptKey(pt), key = tag ? `${tag}@${pk}` : pk;
    let v = ptRegistry.get(key);
    if (!v) {
      const q = (vertexSnap && vertexSnap.get(pk)) || pt;
      const ptId = addPoint(q);
      const vtxId = addVertex(ptId);
      v = { ptId, vtxId, w: q.map((x) => +toStep(x)) };
      ptRegistry.set(key, v);
    }
    return v;
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
      const tag = edgeScope ? edgeScope.get(key) || '' : '';
      const { vtxId: sv, ptId: startPtId, w: a } = getVertex(p1, tag);
      const { vtxId: ev, w: b } = getVertex(p2, tag);
      // Richtung aus den GESCHRIEBENEN Endpunkten: die LINE läuft dann exakt durch beide
      // CARTESIAN_POINTs (aus den ungerundeten Werten lag das Ende bis 1.2e-6 mm daneben).
      const dir = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
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
      const v = getVertex(vpt, edgeScope ? edgeScope.get(`c:${rimKey}`) || '' : '');
      const ecId = addEdgeCurve(v.vtxId, v.vtxId, circleId);
      circleRegistry.set(rimKey, { ecId });
    }
    return circleRegistry.get(rimKey);
  };
  // Kanten-Schlüssel der gerade entstehenden Fläche (assemble: Zusammenhangskomponenten der Schale)
  let faceKeySink = [];
  const useCircle = (rimKey, forward) => {
    const u = circleUse.get(rimKey) || { fwd: 0, rev: 0 };
    if (forward) u.fwd++; else u.rev++;
    circleUse.set(rimKey, u);
    faceKeySink.push(`c:${rimKey}`);
  };

  // Profil-Bögen (profile-arcs.js): Registry der Bogen-Kanten (EDGE_CURVE mit CIRCLE) + Nutzungszähler
  const arcRegistry = new Map();   // arcKey → { ecId, startKey }
  const arcUse = new Map();        // arcKey → { fwd, rev }
  let arcGeoms = null;             // Map arcKey → geom (aus buildArcPlans) für den laufenden Zusammenbau
  const getOrCreateArcEdge = (g) => {
    if (!arcRegistry.has(g.key)) {
      const tag = edgeScope ? edgeScope.get(`a:${g.key}`) || '' : '';
      const vA = getVertex(g.A, tag), vB = getVertex(g.B, tag);
      const circleId = addCircle(addAxis2Placement3D(g.center, g.axis, g.refDir), g.radius);
      arcRegistry.set(g.key, { ecId: addEdgeCurve(vA.vtxId, vB.vtxId, circleId), startKey: ptKey(g.A) });
    }
    return arcRegistry.get(g.key);
  };
  const useArc = (key, forward) => {
    const u = arcUse.get(key) || { fwd: 0, rev: 0 };
    if (forward) u.fwd++; else u.rev++;
    arcUse.set(key, u);
    faceKeySink.push(`a:${key}`);
  };

  // ---- Step 3: Build ADVANCED_FACEs ----
  // fold (optional, aus enforcePlanarity): { id, keys } — Kanten zwischen Teilflächen einer
  // zerlegten Fläche, die im Netz non-manifold sind, laufen über eine eigene Kanten-Instanz.
  // split (optional, Schalen-Analyse): Map Schlüssel → eigener Schlüssel dieser Fläche — eine Kante,
  // an der sich zwei Körper berühren (4 Nutzungen), wird je Körper-Fächer eine eigene Instanz.
  const buildLoopEdges = (points, fold, split = null, arcEdges = null) => {
    const oeIds = [];
    const n = points.length;
    for (let i = 0; i < n; i++) {
      const p1 = points[i], p2 = points[(i + 1) % n];
      if (ptKey(p1) === ptKey(p2)) continue; // skip degenerate
      // Profil-Bögen (profile-arcs.js): Kante mit Bogen-Geometrie → CIRCLE-Kante statt LINE
      if (arcEdges) {
        const ak = arcEdges.get(edgeCanonKey(p1, p2));
        if (ak !== undefined) {
          const g = arcGeoms && arcGeoms.get(ak);
          if (!g) throw new Error('Bogen ohne Geometrie: ' + ak);
          const e = getOrCreateArcEdge(g), fwd = ptKey(p1) === e.startKey;
          useArc(ak, fwd);
          oeIds.push(addOrientedEdge(e.ecId, fwd));
          continue;
        }
      }
      let ck = edgeCanonKey(p1, p2);
      if (fold && fold.keys.has(ck)) ck += `#fold${fold.id}`;
      if (split) { const s = split.get(ck); if (s) ck = s; }
      const edge = getOrCreateEdge(p1, p2, ck);
      const forward = ptKey(p1) === edge.startKey;
      const u = edgeUse.get(ck) || { fwd: 0, rev: 0 };
      if (forward) u.fwd++; else u.rev++;
      edgeUse.set(ck, u);
      faceKeySink.push(ck);
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
  // Darum prüft der Wächter je analytischer Fläche (Bohrungs-Zylinder, Außenmantel, Kegel-Mantel,
  // Fasen-Kegel, Kanal-Stück):
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
  // Dasselbe für einen Kegel-Mantel (Achse ax durch ap, ax zeigt zum wachsenden Radius).
  const coneNormalAt = (ap, ax, semiAngle, sgn) => {
    const ca = Math.cos(semiAngle), sa = Math.sin(semiAngle);
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
      const swept = tilted || pc.swept === true; // wie emittiert (s. assemble)
      if (pc.kind === 'line') {
        const lo = -r * sinG - 0.4, hi = pc.len + r * sinG + 0.4;
        const accept = (p) => {
          const w0 = _sub3(p, pc.profC), al = _dot3(w0, pc.dir);
          if (al < lo || al > hi) return false;
          const rho = Math.hypot(w0[0] - pc.dir[0] * al, w0[1] - pc.dir[1] * al, w0[2] - pc.dir[2] * al);
          return rho >= rLo && rho <= rHi;
        };
        let normalAt;
        if (!swept) normalAt = cylGuardNormal(pc.profC, pc.dir, sgn);
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
      if (!swept) {
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

  // ---- Eckpunkte exakt auf ihre Ebenen setzen ----
  // Eine ebene Fläche aus dem Netz ist nur bis aufs float32-Rauschen eben: Eckpunkte schräger
  // Flächen liegen µm neben der Ebene (enforcePlanarity lässt bis PLANAR_TOL zu). ACIS (CST CAD
  // Navigator) rechnet mit 1e-6 mm — dort fehlten solche Flächen. Jeder Polygon-Eckpunkt wird um
  // die kleinste Verschiebung d versetzt, mit der er alle Ebenen seiner Flächen erfüllt (kleinste
  // Quadrate, schwach regularisiert): 1 Ebene → Lot, 2 → nächster Punkt der Schnittgeraden, 3 →
  // Schnittpunkt. Gerechnet wird d, nicht der Punkt selbst — so bleibt das Gleichungssystem auch
  // bei fast parallelen Ebenen genau. Bleiben Ebenen unerfüllt (> SNAP_RES, z.B. 4 nicht exakt
  // durch einen Punkt laufende Ebenen) oder wäre der Weg > SNAP_MAX (fast parallele Ebenen mit
  // Versatz), bleibt der Punkt, wo er ist. Kreis-Ränder (circleRim) bleiben unberührt.
  const SNAP_RES = 1e-9, SNAP_MAX = 1e-3;
  const snapToPlanes = (fds) => {
    const at = new Map();
    for (const fd of fds) {
      const n = _norm3(fd.normal), c = _dot3(n, fd.centroid);
      for (const L of [fd.outer, ...fd.inner]) {
        if (L.circleRim) continue;
        for (const p of L) {
          const k = vtxKey(p);
          let e = at.get(k);
          if (!e) { e = { p, pl: [] }; at.set(k, e); }
          if (!e.pl.some((q) => q.fd === fd)) e.pl.push({ fd, n, c });
        }
      }
    }
    const snap = new Map();
    let moved = 0, kept = 0, maxMove = 0;
    for (const [k, { p, pl }] of at) {
      // (Σ n nᵀ + λ I) d = Σ n (c − n·p)
      const lam = 1e-10;
      const a = [lam, 0, 0, 0, lam, 0, 0, 0, lam], r = [0, 0, 0];
      let res0 = 0;
      for (const { n, c } of pl) {
        const e0 = c - _dot3(n, p);
        res0 = Math.max(res0, Math.abs(e0));
        for (let i = 0; i < 3; i++) { r[i] += n[i] * e0; for (let j = 0; j < 3; j++) a[i * 3 + j] += n[i] * n[j]; }
      }
      if (res0 <= SNAP_RES) continue;
      const det = a[0] * (a[4] * a[8] - a[5] * a[7]) - a[1] * (a[3] * a[8] - a[5] * a[6]) + a[2] * (a[3] * a[7] - a[4] * a[6]);
      if (!(Math.abs(det) > 0)) { kept++; continue; }
      const col = (i) => { const m = a.slice(); m[i] = r[0]; m[3 + i] = r[1]; m[6 + i] = r[2]; return (m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6])) / det; };
      const d = [col(0), col(1), col(2)];
      const x = [p[0] + d[0], p[1] + d[1], p[2] + d[2]];
      let res = 0;
      for (const { n, c } of pl) res = Math.max(res, Math.abs(_dot3(n, x) - c));
      const mv = Math.hypot(d[0], d[1], d[2]);
      if (!(res <= SNAP_RES) || mv > SNAP_MAX) { kept++; continue; }
      snap.set(k, x); moved++;
      if (mv > maxMove) maxMove = mv;
    }
    return { snap, moved, kept, maxMove };
  };

  // ---- Step 3: Flächen emittieren — re-entrant, damit der globale Fallback alles facettiert
  // neu bauen kann. Setzt id/entities/Registries zurück und baut von vorn. (Vor dem ersten
  // Aufruf wurde noch nichts emittiert → entMark/idMark sind der Ausgangszustand.)
  const entMark = entities.length, idMark = id;
  // shellOpts (optional, 2. Durchgang der Schalen-Analyse, s. assembleSolids): { drop: Set<faceDef>
  // (Schale verworfen), flip: Set<faceDef> (umgedreht ausgeben), split: Map<faceDef, Map<Schlüssel,
  // eigener Schlüssel>>, scope: Map<Kanten-Schlüssel, Komponente> (Ecken je Komponente) }.
  const assemble = (faceDefsArg, plans, tubesArg = [], mantlesArg = [], mantleConesArg = [], shellOpts = null, arcsArg = null) => {
    entities.length = entMark; id = idMark;
    ptRegistry.clear(); edgeRegistry.clear(); edgeUse.clear();
    circleRegistry.clear(); circleUse.clear();
    // Profil-Bögen (profile-arcs.js): Bogen-Kanten und ihre Geometrie für diesen Zusammenbau
    arcRegistry.clear(); arcUse.clear(); arcGeoms = arcsArg ? arcsArg.geoms : null;
    edgeScope = shellOpts && shellOpts.scope ? shellOpts.scope : null;
    // verworfene Schalen (2. Durchgang) setzen keine Eckpunkte — ihre Ebenen zählen nicht mit
    const snapRes = snapToPlanes(shellOpts && shellOpts.drop && shellOpts.drop.size ? faceDefsArg.filter((fd) => !shellOpts.drop.has(fd)) : faceDefsArg);
    vertexSnap = snapRes.snap;
    const faceIds = [], faceKeys = [], faceSrc = [];
    // Fläche aufnehmen + ihre Kanten-Schlüssel (buildLoopEdges/useCircle sammeln in faceKeySink);
    // src beschreibt die Fläche für die Schalen-Analyse (Volumen, Lage) — ohne src gilt ihre Schale
    // als nicht auswertbar (Körper wie bisher).
    const emitFace = (fid, src = null) => { faceIds.push(fid); faceKeys.push(faceKeySink); faceSrc.push(src); faceKeySink = []; };
    faceKeySink = [];
    let guardFailures = 0, guardMs = 0;
    // Bohrungs-Pläne, deren Wächter geschlagen hat (Zylinder oder einer seiner Fasen-Kegel) — der
    // Rückfall je Bohrung (buildStage) sperrt genau diese Bohrung (sie bleibt facettiert).
    const guardFailedPlans = new Set();
    // Emittierte same_sense-Werte (korrekt bzw. vom Test-Hook gedreht) — der Wächter prüft
    // IMMER den tatsächlich emittierten Wert.
    const ssBore = testFlip('bore');   // korrekt .F.: Wand-Normale zeigt zur Achse (ins Loch)
    const ssCone = testFlip('cone');   // korrekt .F.: dito für die Fase
    const ssMantle = !testFlip('mantle'); // korrekt .T.: konvexer Mantel, Normale zeigt aus dem Material
    const ssMantleCone = !testFlip('mantlecone'); // korrekt .T.: konvexer Kegel / Mantel-Fase, dito

    // Kreis-Orientierung (ISO 10303-42, von strikten Importern wie CST/ACIS wörtlich genommen —
    // occt/Fusion reparieren still): Ein Loch-Rand läuft IM Uhrzeigersinn um die Flächennormale,
    // ein Mantel trägt seine Ränder so, dass die Fläche links liegt. Der CIRCLE läuft gegen den
    // Uhrzeigersinn um rim.axis → Richtung je Nutzung aus der Geometrie ableiten (früher pauschal
    // Deckfläche .T. / Mantel .F. — damit war eine der beiden Deckflächen jeder Bohrung falsch).
    // Kanal-Mündungen (rimKey 'tube…') bringen ihre Orientierung aus tube-sweep.js mit (.T.).
    const isTubeRim = (rim) => String(rim.rimKey).startsWith('tube');
    const holeLoopForward = (rim, faceNormal) => isTubeRim(rim) || _dot3(rim.axis, faceNormal) < 0;
    // Außenrand einer Deckfläche (konvexer Mantel): GEGEN den Uhrzeigersinn um die Flächennormale.
    const outerLoopForward = (rim, faceNormal) => _dot3(rim.axis, faceNormal) > 0;

    // Flachflächen (Loops mit `circleRim`-Tag werden als EINE Kreis-Kante emittiert: Innen-Loops
    // an Bohrungen/Kanälen und am Fuß eines Zapfens/einer Wellenstufe, der Außen-Loop an konvexen
    // Mänteln und Kegeln). Richtung je Loop-Art: Außen-Loop gegen, Innen-Loop im Uhrzeigersinn um
    // die Flächennormale — die analytische Nachbarfläche nutzt die Kante gegenläufig.
    for (const fd of faceDefsArg) {
      if (shellOpts && shellOpts.drop && shellOpts.drop.has(fd)) continue;           // verworfene Schale
      const flip = !!(shellOpts && shellOpts.flip && shellOpts.flip.has(fd));
      const { outer, inner, normal, centroid, fold, arcEdges } = flip ? flippedFaceDef(fd) : fd;
      const split = shellOpts && shellOpts.split ? shellOpts.split.get(fd) || null : null;
      let outerBound;
      if (outer.circleRim) {
        const rim = outer.circleRim;
        const ce = getOrCreateCircleEdge(rim.rimKey, rim);
        const fwd = outerLoopForward(rim, normal);
        useCircle(rim.rimKey, fwd);
        outerBound = addFaceOuterBound(addEdgeLoop([addOrientedEdge(ce.ecId, fwd)]));
      } else {
        const outerOe = buildLoopEdges(outer, fold, split, arcEdges || null);
        if (outerOe.length < 3) { faceKeySink = []; continue; }
        outerBound = addFaceOuterBound(addEdgeLoop(outerOe));
      }
      const bounds = [outerBound];
      for (const innerLoop of inner) {
        if (innerLoop.circleRim) {
          const rim = innerLoop.circleRim;
          const ce = getOrCreateCircleEdge(rim.rimKey, rim);
          const fwd = holeLoopForward(rim, normal);
          useCircle(rim.rimKey, fwd);
          bounds.push(addFaceBound(addEdgeLoop([addOrientedEdge(ce.ecId, fwd)])));
          continue;
        }
        const innerOe = buildLoopEdges(innerLoop, fold, split, arcEdges || null);
        if (innerOe.length < 3) continue;
        bounds.push(addFaceBound(addEdgeLoop(innerOe)));
      }
      const placId = addAxis2Placement3D(centroid, normal, computeRefDir(normal));
      emitFace(addAdvancedFace(bounds, addPlane(placId), true), { fd, key: fd });
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
      emitFace(addAdvancedFace(bounds, cylSurf, ssBore), { band: plan.rims, sgn: ssBore ? 1 : -1, key: plan });
      { // Wächter: (a) Wand-Facetten der Bohrung gegen die emittierte Mantel-Orientierung,
        // (b) Umlaufsinn beider Ränder (Fläche zwischen den Rändern = Richtung zum anderen Rand)
        const tg = nowMs();
        const nAt = cylGuardNormal(plan.surfCenter, ax, ssBore ? 1 : -1);
        const mean = guardScan(plan.groups, null, nAt);
        if (rimLoops.length === 2) {
          rimLoops[0].d = _sub3(rimLoops[1].geom.center, rimLoops[0].geom.center);
          rimLoops[1].d = _sub3(rimLoops[0].geom.center, rimLoops[1].geom.center);
        }
        if ((mean !== null && mean < 0) || (rimLoops.length === 2 && !loopSenseOk(rimLoops, nAt))) { guardFailures++; guardFailedPlans.add(plan); }
        guardMs += nowMs() - tg;
      }

      // Bohrspitze (BLINDLOCH, plan.tip): Kegel vom Boden-Randkreis zur Spitze auf der Achse. Die
      // STEP-Kegelnormale zeigt radial von der Achse weg (zur schmalen Seite gekippt) — die Bohrung
      // ist konkav → gleiches same_sense wie die Lochwand (.F.): die effektive Normale zeigt in den
      // Hohlraum. Der Boden-Randkreis wird vom Zylinder GEGENLÄUFIG genutzt (je Kreis 1× vor/1×
      // zurück), die Spitze ist ein VERTEX_LOOP (nur ihr Punkt, keine Kante).
      if (plan.tip) {
        const tp = plan.tip, lg = tp.rim, cax = tp.coneAxis;
        const surf = addConicalSurface(addAxis2Placement3D(lg.center, cax, lg.refDir), lg.radius, tp.semiAngle);
        const ce = getOrCreateCircleEdge(lg.rimKey, lg);
        const fT = _dot3(lg.axis, cax) > 0;    // konkav: gegenläufig zur Zylinder-Nutzung desselben Kreises
        useCircle(lg.rimKey, fT);
        const bounds = [addFaceOuterBound(addEdgeLoop([addOrientedEdge(ce.ecId, fT)]))];
        const vl = id++;
        entities.push(`#${vl}=VERTEX_LOOP('',#${getVertex(tp.apex, edgeScope ? edgeScope.get(`c:${lg.rimKey}`) || '' : '').vtxId});`);
        bounds.push(addFaceBound(vl));
        emitFace(addAdvancedFace(bounds, surf, ssBore),
          { band: [lg, { center: tp.apex, radius: 0, axis: lg.axis, refDir: lg.refDir }], sgn: ssBore ? 1 : -1, key: tp });
        { // Wächter: (a) die Kegel-Facetten gegen die emittierte Kegel-Orientierung, (b) Umlaufsinn des Bodens
          const tg = nowMs();
          const nAt = coneNormalAt(lg.center, cax, tp.semiAngle, ssBore ? 1 : -1);
          const z = tp.zone;
          const onCone = (p) => {
            const w0 = _sub3(p, z.c0), t = _dot3(w0, z.zAx);
            if (t < -0.15 || t > z.H + 0.15) return false;
            return Math.abs(Math.hypot(w0[0] - z.zAx[0] * t, w0[1] - z.zAx[1] * t, w0[2] - z.zAx[2] * t) - (z.R0 + z.k * t)) <= 0.15;
          };
          const mean = guardScan(tp.groups, onCone, nAt);
          const rimLoops = [{ geom: lg, fwd: fT, d: _sub3(tp.apex, lg.center) }];
          if ((mean !== null && mean < 0) || !loopSenseOk(rimLoops, nAt)) { guardFailures++; guardFailedPlans.add(plan); }
          guardMs += nowMs() - tg;
        }
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
        emitFace(addAdvancedFace([ob, ib], coneSurf, ssCone), { band: [cr.rimDesc, cr.flatDesc], sgn: ssCone ? 1 : -1, key: cr });
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
          if ((mean !== null && mean < 0) || !loopsOk) { guardFailures++; guardFailedPlans.add(plan); }
          guardMs += nowMs() - tg;
        }
      }
    }

    // Konvexe Außenmäntel (Welle, Zapfen, Scheiben-Außenwand): wie oben 1 CYLINDRICAL_SURFACE mit
    // 2 vollen Kreis-Bounds, aber die STEP-Zylindernormale (von der Achse weg) zeigt hier schon aus
    // dem Material → same_sense .T.. Fläche links vom Rand: am unteren Ende läuft der Rand gegen
    // den Uhrzeigersinn um die Achse, am oberen im Uhrzeigersinn (Gegenrichtung zum Außenrand der
    // jeweiligen Deckfläche → je Kreis 1×fwd/1×rev).
    for (const plan of mantlesArg) {
      const r0 = plan.rims[0];
      const ax = r0.axis;
      const cylSurf = addCylindricalSurface(addAxis2Placement3D(plan.surfCenter, ax, r0.refDir), r0.radius);
      const tOf = (rim) => _dot3(_sub3(rim.center, plan.surfCenter), ax);
      const tMid = plan.rims.reduce((s, rim) => s + tOf(rim), 0) / plan.rims.length;
      const bounds = [], rimLoops = [];
      for (let r = 0; r < plan.rims.length; r++) {
        const rim = plan.rims[r];
        const ce = getOrCreateCircleEdge(rim.rimKey, rim);
        const isTop = tOf(rim) > tMid;
        const fwd = !isTop === (_dot3(rim.axis, ax) > 0);
        useCircle(rim.rimKey, fwd);
        const loopId = addEdgeLoop([addOrientedEdge(ce.ecId, fwd)]);
        bounds.push(r === 0 ? addFaceOuterBound(loopId) : addFaceBound(loopId));
        rimLoops.push({ geom: rim, fwd });
      }
      emitFace(addAdvancedFace(bounds, cylSurf, ssMantle), { band: plan.rims, sgn: ssMantle ? 1 : -1, key: plan });
      { // Wächter wie bei der Bohrung: Wand-Facetten gegen die Mantel-Orientierung, Umlaufsinn beider Ränder
        const tg = nowMs();
        const nAt = cylGuardNormal(plan.surfCenter, ax, ssMantle ? 1 : -1);
        const mean = guardScan(plan.groups, null, nAt);
        if (rimLoops.length === 2) {
          rimLoops[0].d = _sub3(rimLoops[1].geom.center, rimLoops[0].geom.center);
          rimLoops[1].d = _sub3(rimLoops[0].geom.center, rimLoops[1].geom.center);
        }
        if ((mean !== null && mean < 0) || (rimLoops.length === 2 && !loopSenseOk(rimLoops, nAt))) guardFailures++;
        guardMs += nowMs() - tg;
      }
    }

    // Konvexe Kegel-Mäntel (Kegelstumpf, Kegel mit Spitze; convertMantleCones) und Fasen an Zylinder-
    // Mänteln (sharpMantlePlan, chamfer: der große bzw. kleine Rand ist der Mantel-Rand, den der
    // Zylinder gegenläufig nutzt): CONICAL_SURFACE mit
    // Lage im Mittelpunkt des GROSSEN Randkreises, Achse coneAxis zur Seite wachsenden Radius (STEP:
    // Radius R + v·tan α wächst entlang der Achse — zwischen den Rändern ist v ≤ 0), Halbwinkel α.
    // Die natürliche Kegelnormale (radial nach außen, zur schmalen Seite gekippt) zeigt beim
    // konvexen Kegel aus dem Material → same_sense .T.. Fläche links vom Rand: der kleine Rand läuft
    // gegen, der große im Uhrzeigersinn um coneAxis — gegenläufig zur jeweiligen Deckfläche (Außen-
    // Loop gegen, Innen-Loop im Uhrzeigersinn um deren Normale). Die Spitze wird ein VERTEX_LOOP
    // (nur ihr Punkt, keine Kante).
    for (const cp of mantleConesArg) {
      const lg = cp.large, ax = cp.coneAxis;
      const surf = addConicalSurface(addAxis2Placement3D(lg.center, ax, lg.refDir), lg.radius, cp.semiAngle);
      const ceL = getOrCreateCircleEdge(lg.rimKey, lg);
      const fL = _dot3(lg.axis, ax) < 0;
      useCircle(lg.rimKey, fL);
      const bounds = [addFaceOuterBound(addEdgeLoop([addOrientedEdge(ceL.ecId, fL)]))];
      const rimLoops = [{ geom: lg, fwd: fL, d: _sub3(cp.small ? cp.small.center : cp.apex, lg.center) }];
      if (cp.small) {
        const sm = cp.small, ceS = getOrCreateCircleEdge(sm.rimKey, sm);
        const fS = _dot3(sm.axis, ax) > 0;
        useCircle(sm.rimKey, fS);
        bounds.push(addFaceBound(addEdgeLoop([addOrientedEdge(ceS.ecId, fS)])));
        rimLoops.push({ geom: sm, fwd: fS, d: _sub3(lg.center, sm.center) });
      } else {
        const vl = id++;
        entities.push(`#${vl}=VERTEX_LOOP('',#${getVertex(cp.apex, edgeScope ? edgeScope.get(`c:${lg.rimKey}`) || '' : '').vtxId});`);
        bounds.push(addFaceBound(vl));
      }
      // Schalen-Analyse: Band zwischen großem Rand und kleinem Rand bzw. Spitze (Kreis mit Radius 0)
      emitFace(addAdvancedFace(bounds, surf, ssMantleCone),
        { band: [lg, cp.small || { center: cp.apex, radius: 0, axis: lg.axis, refDir: lg.refDir }], sgn: ssMantleCone ? 1 : -1, key: cp });
      { // Wächter: (a) Wand-Facetten (nur Dreiecke im Kegel-Bereich) gegen die emittierte Kegel-
        // Orientierung, (b) Umlaufsinn der Ränder (Fläche = Richtung zum anderen Rand bzw. zur Spitze)
        const tg = nowMs();
        const nAt = coneNormalAt(lg.center, ax, cp.semiAngle, ssMantleCone ? 1 : -1);
        const z = cp.zone;
        const onCone = (p) => {
          const w0 = _sub3(p, z.c0), t = _dot3(w0, z.zAx);
          if (t < -0.15 || t > z.H + 0.15) return false;
          return Math.abs(Math.hypot(w0[0] - z.zAx[0] * t, w0[1] - z.zAx[1] * t, w0[2] - z.zAx[2] * t) - (z.R0 + z.k * t)) <= 0.15;
        };
        const mean = guardScan(cp.groups, onCone, nAt);
        if ((mean !== null && mean < 0) || !loopSenseOk(rimLoops, nAt)) guardFailures++;
        guardMs += nowMs() - tg;
      }
    }

    // Kanal-Flächenketten (tube-sweep.js): Stück k zwischen Kurve k und k+1. Profil ⟂ Bahn (γ=0):
    // Gerade → CYLINDRICAL_SURFACE, Bogen → TOROIDAL_SURFACE. Profil geneigt (γ≠0, Profilkreis auf
    // der Mündungsfläche skizziert): Gerade → SURFACE_OF_LINEAR_EXTRUSION, Bogen →
    // SURFACE_OF_REVOLUTION des Profilkreises — beides exakt die gezogene Fläche. γ=0-Stücke mit
    // pc.swept (Rand-Kurven > 1e-6 mm neben Zylinder/Torus, s. tube-sweep.js) ebenso als Sweep.
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
        // pc.swept (γ = 0, tube-sweep.js): Rand-Kurven liegen nicht exakt auf Zylinder/Torus der Bahn
        // → wie bei γ ≠ 0 die Extrusions-/Rotationsfläche des mitgeführten Profils (enthält sie exakt)
        const swept = tilted || pc.swept === true;
        // refDir des Profilkreises = profRef (refOf im Profil-Frame, s. tube-sweep.js): die Naht
        // (v = 0) der Rotations-/Extrusionsfläche muss durch den refDir-Vertex der Übergangskreise
        // und den Mündungs-Vertex laufen — sonst teilt OCCT den B-Spline neben der Naht auf und es
        // bleiben 3D-Lücken ~2e-5 mm (> 1e-6).
        const profCircle = () => addCircle(addAxis2Placement3D(pc.profC, pc.profM, pc.profRef || computeRefDir(pc.profM)), r);
        if (pc.kind === 'line') {
          sameSense = false; // Normale zeigt von der Achse weg
          if (!swept) surf = addCylindricalSurface(addAxis2Placement3D(pc.profC, pc.dir, computeRefDir(pc.dir)), r);
          else {
            const sc = profCircle(), vec = addVector(addDirection(pc.dir), 1);
            surf = id++; entities.push(`#${surf}=SURFACE_OF_LINEAR_EXTRUSION('',#${sc},#${vec});`);
          }
        } else if (!swept) {
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
        emitFace(addAdvancedFace([ob, ib], surf, sameSense), { tube: tp, k, key: tp });
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

    // Profil-Bögen (profile-arcs.js): je Band EINE CYLINDRICAL_/CONICAL_SURFACE, Rand = Bogen–Gerade–Bogen–Gerade
    // in Facetten-Umlaufrichtung (Fläche links), same_sense aus den Facetten-Normalen
    for (const pl of (arcsArg ? arcsArg.plans : [])) {
      const s = pl.surf;
      const plac = addAxis2Placement3D(s.loc, s.axis, s.refDir);
      const surf = s.kind === 'cyl' ? addCylindricalSurface(plac, s.radius) : addConicalSurface(plac, s.radius, s.semiAngle);
      const oe = [];
      for (const seg of pl.segs) {
        if (seg.type === 'arc') {
          const g = arcGeoms && arcGeoms.get(seg.arcKey);
          if (!g) throw new Error('Profil-Bogen unvollständig');
          const e = getOrCreateArcEdge(g), fwd = ptKey(seg.pts[0]) === e.startKey;
          useArc(seg.arcKey, fwd);
          oe.push(addOrientedEdge(e.ecId, fwd));
        } else {
          for (let i = 0; i + 1 < seg.pts.length; i++) {
            const p1 = seg.pts[i], p2 = seg.pts[i + 1];
            if (ptKey(p1) === ptKey(p2)) continue;
            let ck = edgeCanonKey(p1, p2);
            if (shellOpts && shellOpts.split) { /* nichts: Bänder werden nicht aufgeteilt */ }
            const edge = getOrCreateEdge(p1, p2, ck), fwd = ptKey(p1) === edge.startKey;
            const u = edgeUse.get(ck) || { fwd: 0, rev: 0 }; if (fwd) u.fwd++; else u.rev++; edgeUse.set(ck, u);
            faceKeySink.push(ck);
            oe.push(addOrientedEdge(edge.ecId, fwd));
          }
        }
      }
      if (oe.length < 3) throw new Error('Profil-Bogen unvollständig');
      emitFace(addAdvancedFace([addFaceOuterBound(addEdgeLoop(oe))], surf, pl.sense > 0), { arcBand: pl, key: pl });
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
    for (const u of arcUse.values()) tally(u.fwd, u.rev);   // Profil-Bögen (profile-arcs.js)
    // Zusammenhangskomponenten über gemeinsame Kanten: ein Netz aus mehreren Körpern (dino: 4)
    // wird zu mehreren Schalen — ein CLOSED_SHELL muss zusammenhängend sein (ISO 10303-42), eine
    // zerfallene Schale lehnen strikte Importer ab bzw. zerlegen sie still.
    const comp = faceIds.map((_, i) => i);
    const find = (i) => { while (comp[i] !== i) { comp[i] = comp[comp[i]]; i = comp[i]; } return i; };
    const owner = new Map();
    faceKeys.forEach((ks, i) => {
      for (const k of ks) { const o = owner.get(k); if (o === undefined) owner.set(k, i); else { const a = find(i), b = find(o); if (a !== b) comp[a] = b; } }
    });
    const shellMap = new Map();
    faceIds.forEach((f, i) => { const r = find(i), s = shellMap.get(r); if (s) s.push(f); else shellMap.set(r, [f]); });
    return {
      faceIds, faceKeys, faceSrc,
      guardFailedPlans,          // Bohrungs-Pläne mit Wächter-Befund (Rückfall je Bohrung)
      shells: [...shellMap.values()],
      report: {
        faceCount: faceIds.length,
        shells: shellMap.size,
        edgeCount: edgeUse.size + circleUse.size + arcUse.size,
        boundaryEdges: bE, nonManifoldEdges: nmE, orientationDefects: oD,
        watertight: bE === 0 && nmE === 0 && oD === 0,
        boresConverted: plans.length,
        boresBlind: plans.filter((p) => p.blind).length,        // davon Sacklöcher (flacher Boden / Spitze)
        mantlesConverted: mantlesArg.length,
        mantleConesConverted: mantleConesArg.filter((c) => !c.chamfer).length,   // Kegel-Mäntel
        mantleChamfersConverted: mantleConesArg.filter((c) => c.chamfer).length,  // Fasen/Kegelspitzen an Zylinder-Mänteln
        tubesConverted: tubesArg.length,
        tubePieces: tubesArg.reduce((n, tp) => n + tp.spec.pieces.length, 0),
        // Orientierungs-Wächter: analytische Flächen, deren Orientierung den Original-Dreiecken
        // bzw. ihren Rändern widerspricht (in DIESEM Zusammenbau; der Endbericht summiert alle
        // Fallback-Stufen auf).
        orientationGuardFailures: guardFailures,
        orientationGuardMs: Math.round(guardMs * 1000) / 1000,
        // snapToPlanes: auf ihre Ebenen gesetzte Eckpunkte / nicht setzbare (Rest bleibt) / größter Weg
        snappedVertices: snapRes.moved, snapKept: snapRes.kept,
        snapMaxMove: Math.round(snapRes.maxMove * 1e9) / 1e9,
        // Profil-Bögen (profile-arcs.js): Bänder → echte Zylinder-/Kegel-Flächen (statt Facetten)
        arcCylinders: arcsArg ? arcsArg.plans.filter((p) => p.kind === 'cyl').length : 0,
        arcCones: arcsArg ? arcsArg.plans.filter((p) => p.kind === 'cone').length : 0,
        arcFacetsReplaced: arcsArg ? arcsArg.plans.reduce((n, p) => n + ((p.band && p.band.facets) || []).length, 0) : 0,
        arcMaxSagitta: arcsArg ? Math.max(0, ...arcsArg.plans.map((p) => p.sag || 0)) : 0,
        arcVolumeDelta: arcsArg ? Math.round(arcsArg.plans.reduce((n, p) => n + (p.dV || 0), 0) * 1e6) / 1e6 : 0,
      },
    };
  };

  // ==== Schalen-Analyse: was ist jede Zusammenhangskomponente? ====
  // assemble() trennt die Flächen per Union-Find nur nach ZUSAMMENHANG. Früher wurde daraus pauschal
  // je Komponente ein Körper — auch Hohlräume (Würfel mit innerem Hohlraum: occt 9000 statt 7000),
  // invertierte Netze (block_edge_fillet) und Null-Volumen-Finnen; und ein einziger offener Fremdteil
  // machte ALLE Körper zu OPEN_SHELLs (und warf deren Bohrungen in die facettierte Basislinie). Jetzt:
  //   dicht, mittlere Dicke 3|V|/A < DEGEN_THICK (Finne, flacher Tetraeder) → verwerfen
  //   dicht, nicht in einer anderen dichten Komponente → Körper; V < 0 → Netz invertiert: umdrehen
  //   dicht, innerhalb einer Komponente mit ENTGEGENGESETZTEM Vorzeichen → deren Hohlraum (bzw. Insel
  //     in einem Hohlraum); gleiches Vorzeichen → eigener (eingeschlossener) Körper
  //   Hohlraum, der seinen Körper berührt (gemeinsame Ecke, Falt-Kante — dino) → kein gültiger Hohlraum
  //     (Schalen müssen disjunkt sein); bis POCKET_DROP_REL des Körpervolumens verworfen, sonst Hohlraum
  //     mit Hinweis
  //   offen/non-manifold → OPEN_SHELL in einem eigenen Flächenmodell neben den Körpern
  // Jede ausgegebene CLOSED_SHELL umschließt V > 0; Hohlräume stehen als ORIENTED_CLOSED_SHELL(.F.) in
  // einem BREP_WITH_VOIDS (ISO 10303-42; so schreibt auch OpenCascade). Volumen und Lage kommen aus den
  // emittierten Flächen (Divergenzsatz bzw. Raumwinkel; Kreise mit SHELL_SEG Punkten, Kanal-Stücke über
  // ihre Original-Facetten). Eine Kante mit 2·m Nutzungen (zwei Körper berühren sich entlang einer
  // Kante) wird nach Material-Keilen gepaart und je Paar eine eigene Kanten-Instanz (wie fold); Ecken
  // legt der 2. Durchgang je Komponente an (edgeScope) — sich berührende Körper teilen nichts.
  const SHELL_SEG = 128;            // Abtastung analytischer Kreise für Volumen und Lage
  const DEGEN_THICK = 1e-3;         // mm — mittlere Dicke 3|V|/A darunter: Blech ohne Volumen
  const POCKET_DROP_REL = 1e-4;     // berührender Hohlraum bis zu diesem Anteil am Körpervolumen → verwerfen
  const CONTAIN_BUDGET = 3e7;       // Raumwinkel-Auswertungen (Probepunkte × Dreiecke) für die Lage-Tests
  // Punkte einer Rand-Kurve in natürlicher Laufrichtung (CIRCLE/ELLIPSE gegen den Uhrzeigersinn um die
  // Achse ab refDir — wie emittiert, B-Spline in Stützpunkt-Reihenfolge)
  const rimPoints = (g) => {
    if (g.kind === 'bspline') return Array.isArray(g.samples) ? g.samples : [];
    const z = _norm3(g.axis), rd = g.refDir, rz = _dot3(rd, z);
    const x = _norm3([rd[0] - z[0] * rz, rd[1] - z[1] * rz, rd[2] - z[2] * rz]), y = _cross3(z, x);
    const a = g.radius, b = g.kind === 'ellipse' && Number.isFinite(g.semi2) ? g.semi2 : g.radius;
    const out = [];
    for (let j = 0; j < SHELL_SEG; j++) {
      const u = 2 * Math.PI * j / SHELL_SEG, ca = a * Math.cos(u), sb = b * Math.sin(u);
      out.push([g.center[0] + ca * x[0] + sb * y[0], g.center[1] + ca * x[1] + sb * y[1], g.center[2] + ca * x[2] + sb * y[2]]);
    }
    return out;
  };
  // Eckpunkt einer geschlossenen Rand-Kurve (wie getOrCreateCircleEdge)
  const rimVertex = (g) => (g.kind === 'bspline' ? g.vertex : [g.center[0] + g.radius * g.refDir[0], g.center[1] + g.radius * g.refDir[1], g.center[2] + g.radius * g.refDir[2]]);
  // Dreiecke einer emittierten Fläche, orientiert wie ihre effektive Normale (eben: Fächer je Rand vom
  // Ebenenpunkt aus, Kreise im emittierten Umlaufsinn; Zylinder/Kegel: Streifen zwischen den Rand-
  // Kreisen; Kanal: Original-Facetten, einmal je Kanal) + Flächeninhalt. null = Fläche unbekannt.
  const faceTris = (src) => {
    // Profil-Bögen (profile-arcs.js): Bogen-Fläche → ihre (exakten) Dreiecke
    if (src && src.arcBand) return { tris: src.arcBand.tris, area: src.arcBand.area };
    if (!src) return null;
    const tris = [];
    if (src.fd) {
      const fd = src.fd, n = fd.normal, p0 = fd.centroid;
      let vx = 0, vy = 0, vz = 0;
      [fd.outer, ...fd.inner].forEach((L, li) => {
        let P = L;
        if (L.circleRim) {
          // Umlaufsinn wie emittiert (tests/step-strict.mjs orient-plane): Außenrand gegen, Loch im
          // Uhrzeigersinn um die Flächennormale
          P = rimPoints(L.circleRim);
          let s = 0;
          for (let i = 0; i < P.length; i++) s += _dot3(_cross3(P[i], P[(i + 1) % P.length]), n);
          if ((li === 0) !== (s > 0)) P = P.slice().reverse();
        } else if (fd.arcEdges && arcGeoms) {
          // Profil-Bögen (profile-arcs.js): Bogen-Kanten auf ihre exakten Bogen-Punkte aufweiten
          P = expandArcLoop(L, fd.arcEdges, arcGeoms, vtxKey);
        }
        for (let i = 0; i < P.length; i++) {
          const a = P[i], b = P[(i + 1) % P.length];
          tris.push([p0, a, b]);
          const c = _cross3(_sub3(a, p0), _sub3(b, p0)); vx += c[0]; vy += c[1]; vz += c[2];
        }
      });
      return { tris, area: Math.hypot(vx, vy, vz) / 2 };
    }
    if (src.band) {
      // koaxiale Ränder; liegt der zweite nicht im selben Rahmen (Achse/refDir), wird er im Rahmen des
      // ersten abgetastet — sonst verdrillte der Streifen
      const [A, B] = src.band, PA = rimPoints(A), m = PA.length;
      const same = _dot3(_norm3(A.axis), _norm3(B.axis)) > 1 - 1e-9 && _dot3(A.refDir, B.refDir) > 1 - 1e-9;
      const PB = rimPoints(same ? B : { ...B, axis: A.axis, refDir: A.refDir });
      if (m < 3 || PB.length !== m) return null;
      const z = _norm3(A.axis);
      let flip = null, area = 0;
      for (let j = 0; j < m; j++) {
        const a0 = PA[j], a1 = PA[(j + 1) % m], b0 = PB[j], b1 = PB[(j + 1) % m];
        const n1 = _cross3(_sub3(a1, a0), _sub3(b1, a0)), n2 = _cross3(_sub3(b1, a0), _sub3(b0, a0));
        if (flip === null) {                     // Streifen-Normale radial wie die effektive Normale (sgn)?
          const w = _sub3([(a0[0] + a1[0] + b1[0]) / 3, (a0[1] + a1[1] + b1[1]) / 3, (a0[2] + a1[2] + b1[2]) / 3], A.center), al = _dot3(w, z);
          flip = Math.sign(_dot3(n1, [w[0] - z[0] * al, w[1] - z[1] * al, w[2] - z[2] * al])) !== src.sgn;
        }
        if (flip) tris.push([a0, b1, a1], [a0, b0, b1]); else tris.push([a0, a1, b1], [a0, b1, b0]);
        area += (Math.hypot(n1[0], n1[1], n1[2]) + Math.hypot(n2[0], n2[1], n2[2])) / 2;
      }
      return { tris, area };
    }
    if (src.tube) {
      let area = 0;
      if (src.k === 0) {
        for (const g of src.tube.groups) {
          const vs = g.vertices;
          for (let t = 0; t + 2 < vs.length; t += 3) {
            const a = vs[t], b = vs[t + 1], c = vs[t + 2], cr = _cross3(_sub3(b, a), _sub3(c, a));
            tris.push([a, b, c]); area += Math.hypot(cr[0], cr[1], cr[2]) / 2;
          }
        }
      }
      return { tris, area };
    }
    return null;
  };
  // Ecken einer emittierten Fläche (Schlüssel wie ptRegistry)
  const faceVertexKeys = (src, out) => {
    if (src.fd) {
      for (const L of [src.fd.outer, ...src.fd.inner]) {
        if (L.circleRim) { const v = rimVertex(L.circleRim); if (v) out.add(ptKey(v)); } else for (const p of L) out.add(ptKey(p));
      }
    } else if (src.band) {
      for (const g of src.band) { const v = rimVertex(g); if (v) out.add(ptKey(v)); }
    } else if (src.tube) {
      for (const g of src.tube.spec.curves) { const v = rimVertex(g); if (v) out.add(ptKey(v)); }
    } else if (src.arcBand) {
      // Profil-Bögen (profile-arcs.js): Ecken der Bogen-Fläche = Enden der Rand-Stücke
      for (const seg of src.arcBand.segs) for (const p of [seg.pts[0], seg.pts[seg.pts.length - 1]]) out.add(ptKey(p));
    }
  };
  // Raumwinkel des Dreiecks (a,b,c) von q aus (Van Oosterom/Strackee) — positiv, wenn die Normale von
  // q wegzeigt; Summe über eine geschlossene, außen orientierte Hülle = 4π innen, 0 außen.
  const solidAngle = (q, a, b, c) => {
    const r1 = _sub3(a, q), r2 = _sub3(b, q), r3 = _sub3(c, q);
    const l1 = Math.hypot(r1[0], r1[1], r1[2]), l2 = Math.hypot(r2[0], r2[1], r2[2]), l3 = Math.hypot(r3[0], r3[1], r3[2]);
    const num = _dot3(r1, _cross3(r2, r3));
    const den = l1 * l2 * l3 + _dot3(r1, r2) * l3 + _dot3(r1, r3) * l2 + _dot3(r2, r3) * l1;
    return 2 * Math.atan2(num, den);
  };
  // Netz-Kanten, die schon in der Eingabe defekt sind (Rand, > 2 Nutzungen, gleichsinnig) → ihre
  // Ecken. Offene Ränder der Ausgabe auf solchen Ecken stammen aus dem Netz, nicht aus der Umwandlung.
  let inputDefectV = null;
  const inputDefectVerts = () => {
    if (inputDefectV) return inputDefectV;
    const cnt = new Map();
    for (const g of normalGroups) {
      const vs = g.vertices;
      for (let t = 0; t + 2 < vs.length; t += 3) {
        for (const [p, q] of [[vs[t], vs[t + 1]], [vs[t + 1], vs[t + 2]], [vs[t + 2], vs[t]]]) {
          const ia = vid(p), ib = vid(q);
          if (ia === ib) continue;
          const k = ia < ib ? ia * VID_M + ib : ib * VID_M + ia, s = ia < ib ? 1 : -1, e = cnt.get(k);
          if (e) { e[0]++; e[1] += s; } else cnt.set(k, [1, s]);
        }
      }
    }
    inputDefectV = new Set();
    for (const [k, [nU, s]] of cnt) if (nU !== 2 || s !== 0) { inputDefectV.add(vidKeys[Math.floor(k / VID_M)]); inputDefectV.add(vidKeys[k % VID_M]); }
    return inputDefectV;
  };
  const defectFromInput = (k) => {
    if (k.startsWith('c:')) return false;                                  // Kreis-Kanten gibt es im Netz nicht
    if (k.startsWith('a:')) return false;                                  // Profil-Bögen (profile-arcs.js)
    const [k1, k2] = k.split('#')[0].split('||'), D = inputDefectVerts();
    return D.has(k1) && D.has(k2);
  };
  // Kante k mit 2·m Nutzungen (m ≥ 2, nur ebene Flächen): Nutzungen nach dem Winkel um die Kante sortieren,
  // Material-Keile abwechselnd; je Keil die beiden begrenzenden Flächen paaren → [[fi, fi], …] | null.
  const pairEdgeUses = (k, faceIdx, faceSrc) => {
    const uses = [];
    for (const fi of new Set(faceIdx)) {
      const src = faceSrc[fi];
      if (!src || !src.fd) return null;
      const fd = src.fd;
      if (fd.arcEdges) return null;    // Profil-Bögen (profile-arcs.js): keine Aufteilung
      let found = 0;
      for (const L of [fd.outer, ...fd.inner]) {
        if (L.circleRim) continue;
        for (let i = 0; i < L.length; i++) {
          const p1 = L[i], p2 = L[(i + 1) % L.length];
          if (ptKey(p1) === ptKey(p2)) continue;
          let ck = edgeCanonKey(p1, p2);
          if (fd.fold && fd.fold.keys.has(ck)) ck += `#fold${fd.fold.id}`;
          if (ck !== k) continue;
          found++;
          uses.push({ fi, t: _norm3(_sub3(p2, p1)), n: _norm3(fd.normal) });
        }
      }
      if (found !== 1) return null;
    }
    if (uses.length < 4 || uses.length % 2) return null;
    const e = uses[0].t;
    for (const u of uses) u.d = _norm3(_cross3(u.n, u.t));                  // vom Rand in die Fläche hinein
    const u0 = uses[0].d, w0 = _cross3(e, u0);
    for (const u of uses) {
      u.th = Math.atan2(_dot3(u.d, w0), _dot3(u.d, u0));
      u.mat = _dot3(u.n, _cross3(e, u.d)) < 0;                               // Material im Keil danach (+Winkel)?
    }
    uses.sort((p, q) => p.th - q.th);
    const pairs = [];
    for (let j = 0; j < uses.length; j++) {
      const p = uses[j], q = uses[(j + 1) % uses.length];
      if (p.mat === q.mat) return null;                                      // Keile wechseln nicht ab
      const dth = q.th - p.th + (j === uses.length - 1 ? 2 * Math.PI : 0);
      if (!(dth > 1e-6)) return null;                                        // deckungsgleiche Flächen
      if (p.mat) { if (!(_dot3(p.t, q.t) < 0)) return null; pairs.push([p.fi, q.fi]); }
    }
    return pairs;
  };
  // Zusammenhangskomponenten + Kanten-Bilanz je Komponente (über die aktuellen edgeUse/circleUse —
  // direkt nach dem assemble()-Aufruf, zu dem faceKeys gehört).
  const componentsOf = (faceKeys, splitKeys = null) => {
    const nF = faceKeys.length, par = Array.from({ length: nF }, (_, i) => i);
    const find = (i) => { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i]; } return i; };
    const owner = new Map();
    faceKeys.forEach((ks, i) => {
      for (const k of ks) { const o = owner.get(k); if (o === undefined) owner.set(k, i); else { const ra = find(i), rb = find(o); if (ra !== rb) par[ra] = rb; } }
    });
    const compOf = new Int32Array(nF), comps = [], idx = new Map();
    for (let i = 0; i < nF; i++) {
      const r = find(i);
      let c = idx.get(r);
      if (c === undefined) { c = comps.length; idx.set(r, c); comps.push({ idx: c, faces: [], bE: 0, nmE: 0, oD: 0, nonInput: false }); }
      compOf[i] = c; comps[c].faces.push(i);
    }
    const tally = (k, fwd, rev) => {
      const fi = owner.get(k);
      if (fi === undefined) return;
      const c = comps[compOf[fi]], tot = fwd + rev;
      if (tot === 1) c.bE++; else if (tot > 2) c.nmE++; else if (tot === 2 && fwd !== 1) c.oD++; else return;
      if (!c.nonInput && !defectFromInput(k)) c.nonInput = true;
    };
    for (const [k, u] of edgeUse) if (!splitKeys || !splitKeys.has(k)) tally(k, u.fwd, u.rev);
    for (const [rk, u] of circleUse) tally(`c:${rk}`, u.fwd, u.rev);
    for (const [ak, u] of arcUse) tally(`a:${ak}`, u.fwd, u.rev);   // Profil-Bögen (profile-arcs.js)
    for (const c of comps) c.closed = c.bE === 0 && c.nmE === 0 && c.oD === 0;
    return { comps, compOf };
  };
  const analyzeShells = (a) => {
    const nF = a.faceIds.length, src = a.faceSrc;
    // (1) Kanten mit 2·m Nutzungen je Material-Fächer aufteilen
    const keyFaces = new Map();
    a.faceKeys.forEach((ks, i) => { for (const k of ks) { const l = keyFaces.get(k); if (l) l.push(i); else keyFaces.set(k, [i]); } });
    const split = new Map(), splitKeys = new Set();
    let faceKeys = a.faceKeys;
    for (const [k, u] of edgeUse) {
      if (u.fwd + u.rev <= 2 || u.fwd !== u.rev) continue;
      const pairs = pairEdgeUses(k, keyFaces.get(k) || [], src);
      if (!pairs || pairs.length * 2 !== u.fwd + u.rev) continue;
      if (faceKeys === a.faceKeys) faceKeys = a.faceKeys.slice();
      splitKeys.add(k);
      pairs.forEach((pr, j) => {
        const nk = `${k}#nm${j}`;
        for (const fi of pr) {
          faceKeys[fi] = faceKeys[fi].map((x) => (x === k ? nk : x));
          let m = split.get(src[fi].fd);
          if (!m) { m = new Map(); split.set(src[fi].fd, m); }
          m.set(k, nk);
        }
      });
    }
    // (2) Komponenten, Dichtheit, Umwandlung
    const { comps, compOf } = componentsOf(faceKeys, splitKeys);
    for (const c of comps) {
      c.converted = c.faces.some((i) => { const s = src[i]; return !s || !s.fd || s.fd.untouched !== true || !!s.fd.outer.circleRim || s.fd.inner.some((L) => L.circleRim) || !!s.fd.arcEdges; });
      c.planar = c.faces.every((i) => { const s = src[i]; return s && s.fd && !s.fd.outer.circleRim && !s.fd.inner.some((L) => L.circleRim) && !s.fd.arcEdges; });
      c.kind = c.closed ? 'koerper' : 'offen';
      c.V = NaN;
    }
    // (3) Volumen + Fläche dichter Komponenten (Divergenzsatz, Bezugspunkt je Komponente)
    for (const c of comps) {
      if (!c.closed) continue;
      let V = 0, A = 0, o = null, ok = true;
      for (const i of c.faces) {
        const ft = faceTris(src[i]);
        if (!ft) { ok = false; break; }
        A += ft.area;
        for (const [p, q, r] of ft.tris) {
          if (!o) o = p;
          const pa = _sub3(p, o), pb = _sub3(q, o), pc = _sub3(r, o);
          V += _dot3(pa, _cross3(pb, pc)) / 6;
        }
      }
      if (ok && o) { c.V = V; c.A = A; c.thick = A > 0 ? 3 * Math.abs(V) / A : 0; }
    }
    const known = comps.filter((c) => c.closed && Number.isFinite(c.V));
    for (const c of known) if (c.thick < DEGEN_THICK) c.kind = 'flach';
    const solids = known.filter((c) => c.kind !== 'flach');
    // (4) Lage: liegt c in einer anderen dichten Komponente? Probe = eine Ecke von c, die keiner anderen
    //     Komponente gehört; Windungszahl über deren Flächen (Raumwinkel-Summe / 4π).
    const vkeys = comps.length > 1 ? comps.map((c) => { const s = new Set(); for (const i of c.faces) if (src[i]) faceVertexKeys(src[i], s); return s; }) : null;
    const vOwner = new Map();
    if (vkeys) vkeys.forEach((s, ci) => { for (const k of s) { const o = vOwner.get(k); vOwner.set(k, o === undefined ? ci : (o === ci ? o : -1)); } });
    let undecided = false;
    if (solids.length > 1) {
      let work = 0;
      for (const c of solids) { c.tris = []; for (const i of c.faces) for (const t of faceTris(src[i]).tris) c.tris.push(t); work += c.tris.length; }
      if (work * solids.length > CONTAIN_BUDGET) undecided = true;
      else {
        for (const c of solids) {
          const bb = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
          for (const t of c.tris) for (const p of t) for (let d = 0; d < 3; d++) { if (p[d] < bb[d]) bb[d] = p[d]; if (p[d] > bb[d + 3]) bb[d + 3] = p[d]; }
          c.bb = bb;
        }
        for (const c of solids) {
          const ci = c.idx;
          let q = null;
          for (const i of c.faces) {
            const s = src[i];
            const L = s && s.fd ? [s.fd.outer, ...s.fd.inner].find((LL) => !LL.circleRim) : null;
            if (L) for (const p of L) if (vOwner.get(ptKey(p)) === ci) { q = p; break; }
            if (q) break;
          }
          if (!q) { const t = c.tris[0]; q = [(t[0][0] + t[1][0] + t[2][0]) / 3, (t[0][1] + t[1][1] + t[2][1]) / 3, (t[0][2] + t[1][2] + t[2][2]) / 3]; }
          c.containers = [];
          for (const P of solids) {
            if (P === c || q[0] < P.bb[0] || q[1] < P.bb[1] || q[2] < P.bb[2] || q[0] > P.bb[3] || q[1] > P.bb[4] || q[2] > P.bb[5]) continue;
            let w = 0;
            for (const [ta, tb, tc] of P.tris) w += solidAngle(q, ta, tb, tc);
            w /= 4 * Math.PI;
            if (Math.abs(Math.abs(w) - Math.round(Math.abs(w))) > 0.25) undecided = true;   // Hülle nicht sauber geschlossen
            if (Math.abs(w) > 0.5) c.containers.push(P);
          }
        }
      }
      for (const c of solids) c.tris = null;
    }
    // (5) Typ von außen nach innen: Gegenvorzeichen zum innersten Behälter = dessen Hohlraum (bzw. Insel)
    const notes = [];
    if (!undecided) {
      solids.sort((p, q) => (p.containers ? p.containers.length : 0) - (q.containers ? q.containers.length : 0));
      for (const c of solids) {
        if (!c.containers || !c.containers.length) continue;
        let P = c.containers[0];
        for (const Q of c.containers) if (Math.abs(Q.V) < Math.abs(P.V)) P = Q;
        if (Math.sign(c.V) === Math.sign(P.V)) { if (P.kind === 'hohlraum') notes.push({ art: 'unklar', flaechen: c.faces.length, volumen: c.V }); continue; }
        if (P.kind !== 'koerper') continue;                                   // Insel im Hohlraum → Körper
        c.kind = 'hohlraum'; c.parent = P;
        const touches = vkeys && [...vkeys[c.idx]].some((k) => vOwner.get(k) === -1);
        if (touches) {
          if (Math.abs(c.V) <= POCKET_DROP_REL * Math.abs(P.V)) c.kind = 'tasche';
          else notes.push({ art: 'hohlraum-beruehrt', flaechen: c.faces.length, volumen: c.V });
        }
      }
    }
    // (6) umdrehen / verwerfen — nur rein ebene Komponenten (Kreis-Kanten und analytische Flächen
    //     tragen ihre Orientierung aus der Umwandlung; ein Widerspruch dort = Wächter-Fall → Rückfall)
    const drop = new Set(), flip = new Set();
    let shellFail = false;
    for (const c of known) {
      if (c.kind === 'flach' || c.kind === 'tasche') {
        if (c.planar) { for (const i of c.faces) drop.add(src[i].fd); notes.push({ art: c.kind, flaechen: c.faces.length, volumen: c.V }); }
        else { shellFail = true; c.kind = 'koerper'; }
        continue;
      }
      if (undecided && c.V < 0) { shellFail = true; continue; }                // Lage unklar → nicht raten
      if (c.V < 0) {
        if (c.planar) { c.flip = true; for (const i of c.faces) flip.add(src[i].fd); if (c.kind === 'koerper') notes.push({ art: 'invertiert', flaechen: c.faces.length, volumen: c.V }); }
        else shellFail = true;
      }
    }
    // (7) Ecken je Komponente, sobald sich ausgegebene Komponenten Ecken teilen
    let scope = null;
    if (vkeys) {
      const out = comps.map((c) => c.kind !== 'flach' && c.kind !== 'tasche');
      let shared = false;
      const vo = new Map();
      vkeys.forEach((s, ci) => { if (!out[ci] || shared) return; for (const k of s) { const o = vo.get(k); if (o === undefined) vo.set(k, ci); else if (o !== ci) { shared = true; break; } } });
      if (shared) {
        scope = new Map();
        comps.forEach((c, ci) => { for (const i of c.faces) for (const k of faceKeys[i]) scope.set(k, `K${ci}`); });
      }
    }
    // Kennung je Fläche (über beide Durchgänge stabil) → Komponente
    const compOfKey = new Map();
    for (let i = 0; i < nF; i++) if (src[i]) compOfKey.set(src[i].key, compOf[i]);
    const convFailed = comps.some((c) => !c.closed && (c.converted || c.nonInput));
    return {
      comps, compOfKey, notes, shellFail, convFailed,
      opts: { split, drop, flip, scope },
      pass2: split.size > 0 || drop.size > 0 || flip.size > 0 || scope !== null,
    };
  };
  // Endgültige Schalen-Struktur eines Zusammenbaus (direkt nach dessen assemble()-Aufruf):
  // Körper (Außenschale + Hohlräume) und offene Schalen, Typen aus der Analyse.
  const shellsOf = (a, an) => {
    const { comps } = componentsOf(a.faceKeys);
    const bodies = [], opens = [], byComp = new Map(), pendingVoids = [];
    let mismatch = false;
    for (const c of comps) {
      const fids = c.faces.map((i) => a.faceIds[i]);
      let ac = null;
      for (const i of c.faces) { const s = a.faceSrc[i]; const ci = s ? an.compOfKey.get(s.key) : undefined; if (ci !== undefined) { ac = an.comps[ci]; break; } }
      if (ac && ac.closed !== c.closed) mismatch = true;
      if (!c.closed) { opens.push(fids); continue; }
      if (ac && ac.kind === 'hohlraum' && ac.parent) { pendingVoids.push({ ac, fids }); continue; }
      const b = { faces: fids, voids: [] };
      bodies.push(b);
      if (ac) byComp.set(ac, b);
    }
    for (const { ac, fids } of pendingVoids) {
      const b = byComp.get(ac.parent);
      if (b) b.voids.push(fids); else { mismatch = true; bodies.push({ faces: fids, voids: [] }); }
    }
    return { bodies, opens, mismatch };
  };
  // Flächen gesetzt umgedreht ausgeben (Schalen-Analyse: invertiertes Netz, Hohlraum-Schale)
  const flippedFaceDef = (fd) => ({
    outer: fd.outer.slice().reverse(), inner: fd.inner.map((L) => L.slice().reverse()),
    normal: [-fd.normal[0], -fd.normal[1], -fd.normal[2]], centroid: fd.centroid, fold: fd.fold,
    arcEdges: fd.arcEdges,   // Profil-Bögen (profile-arcs.js): Bogen-Kanten mitnehmen
  });
  // Zusammenbau + Schalen-Analyse (+ 2. Durchgang, wenn Kanten aufgeteilt, Schalen verworfen/umgedreht
  // oder Ecken je Komponente angelegt werden müssen). failed() liest convFailed/shellFail.
  const assembleSolids = (fds, plans, tubes = [], mantles = [], mantleCones = [], arcs = null) => {
    let a = assemble(fds, plans, tubes, mantles, mantleCones, null, arcs);
    const an = analyzeShells(a);
    if (an.pass2) a = assemble(fds, plans, tubes, mantles, mantleCones, an.opts, arcs);
    const sh = shellsOf(a, an);
    a.bodies = sh.bodies; a.opens = sh.opens;
    a.convFailed = an.convFailed || sh.mismatch;
    a.shellFail = an.shellFail;
    const r = a.report;
    r.shells = sh.bodies.reduce((n, b) => n + 1 + b.voids.length, 0) + sh.opens.length;
    r.solids = sh.bodies.length;
    r.voids = sh.bodies.reduce((n, b) => n + b.voids.length, 0);
    r.openShells = sh.opens.length;
    r.invertedShells = an.notes.filter((x) => x.art === 'invertiert').length;
    r.droppedShells = an.notes.filter((x) => x.art === 'flach' || x.art === 'tasche').length;
    r.shellNotes = an.notes.slice(0, 20).map((x) => ({ art: x.art, flaechen: x.flaechen, volumen: Math.round(x.volumen * 1e6) / 1e6 }));
    return a;
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
      if (!fd.outer.circleRim) {                   // Kreis-Außenrand (konvexer Mantel): keine Linien-Kanten
        const outer = mkRec(fd.outer);
        if (outer.edges < 3) continue;             // assemble() überspringt die ganze Fläche
        recs.push(outer);
      }
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
  // v1-Umbau (fd.lineEdits, defeatureFillets) auf einen Loop anwenden: Punkte abbilden, Doppelte
  // entfernen, Lücken entlang der scharfen Kante mit den kanonischen Zwischenpunkten füllen.
  const applyLineEdits = (L, edits) => {
    let cur = L;
    for (const ed of edits) {
      const m = [];
      for (const p of cur) { const q = ed.map.get(vtxKey(p)) || p; if (!m.length || vtxKey(m[m.length - 1]) !== vtxKey(q)) m.push(q); }
      while (m.length > 1 && vtxKey(m[0]) === vtxKey(m[m.length - 1])) m.pop();
      const ln = ed.line;
      if (!ln.idx) ln.idx = new Map(ln.canonPts.map((q, i) => [vtxKey(q), i]));
      const out = [];
      for (let i = 0; i < m.length; i++) {
        out.push(m[i]);
        if (m.length < 2) break;
        const ia = ln.idx.get(vtxKey(m[i])), ib = ln.idx.get(vtxKey(m[(i + 1) % m.length]));
        if (ia === undefined || ib === undefined || Math.abs(ia - ib) < 2) continue;
        const st = ia < ib ? 1 : -1;
        for (let k = ia + st; k !== ib; k += st) out.push(ln.canonPts[k]);
      }
      cur = out;
    }
    return cur;
  };
  const movesSinceExtraction = (fd) => {
    const s = fd.src;
    if (fd.lineEdits && fd.lineEdits.length) {
      // v1-Umbau: die aktuellen Loops müssen GENAU die abgebildeten Herkunfts-Loops sein (bis auf
      // den Startpunkt) — dann lassen sich die Teilflächen aus den Original-Dreiecken genauso umbauen
      if (!s || !s.single || fd.inner.length !== s.inner.length) return null;
      const T = (L) => applyLineEdits(L, fd.lineEdits);
      const sameCyc = (L, S) => {
        if (L.circleRim) return false;
        const t = T(S);
        if (t.length !== L.length || !t.length) return false;
        const k0 = vtxKey(L[0]);
        const off = t.findIndex((q) => vtxKey(q) === k0);
        if (off < 0) return false;
        for (let i = 0; i < L.length; i++) if (vtxKey(t[(i + off) % t.length]) !== vtxKey(L[i])) return false;
        return true;
      };
      if (!sameCyc(fd.outer, s.outer)) return null;
      for (let j = 0; j < fd.inner.length; j++) if (!sameCyc(fd.inner[j], s.inner[j])) return null;
      return { size: 1, apply: T };
    }
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
    const moved = moves && moves.apply ? moves.apply : (L) => {   // ersetzte Punkte übernehmen
      const out = [];
      for (const p of L) { const q = moves.get(vtxKey(p)) || p; if (!out.length || vtxKey(out[out.length - 1]) !== vtxKey(q)) out.push(q); }
      while (out.length > 1 && vtxKey(out[0]) === vtxKey(out[out.length - 1])) out.pop();
      return out;
    };
    for (const P of patches) {
      for (const f of facesFromTris(verts, P.tris, P.n, { directed: true, minFace: 0, minHole: 0, keepSrc: false })) {
        if (moves && moves.size) {
          f.outer = moved(f.outer); f.inner = f.inner.map(moved);
          // v1-Umbau: Teilflächen, die ganz auf der scharfen Kante zusammenfallen (dem Rundungs-Rand
          // zugeschlagene, fast tangentiale Facetten), entfallen — die Gegenprobe unten sichert ab
          if (moves.apply && f.outer.length < 3) continue;
          if (f.outer.length < 3 || f.inner.some((L) => L.length < 3)) return null;
          const fit = fitPlaneLsq(f, P.n);
          const to2c = fit ? projector2d(fit.n, fit.c) : null;
          if (moves.apply && to2c && Math.abs(signedArea2d(f.outer.map(to2c))) < 1e-9) continue;
          if (!fit || _dot3(fit.n, P.n) < 0.96 || planeDev(f, fit.n, fit.c) > PLANAR_TOL) return null;
          const to2 = to2c;
          if (signedArea2d(f.outer.map(to2)) <= 0 || f.inner.some((L) => signedArea2d(L.map(to2)) >= 0)) return null;
          f.normal = fit.n; f.centroid = fit.c;
        } else {
          const h = _dot3(P.n, _sub3(f.centroid, P.p0));    // Ebene exakt durch die Saat
          f.centroid = [f.centroid[0] - P.n[0] * h, f.centroid[1] - P.n[1] * h, f.centroid[2] - P.n[2] * h];
          f.normal = P.n;
        }
        f.group = fd.group;
        f.ops = fd.ops;                                     // Rückfall je Merkmal: Marke vererben
        f.untouched = !!fd.untouched && !(moves && moves.size);   // Schalen-Analyse: Teil einer unveränderten Fläche
        f.splitPart = true;                                // Teilfläche einer Zerlegung (keine eigene Herkunft)
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
      if (!fd.outer.circleRim && !fd.inner.some((L) => L.circleRim)) {
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

  // Schalen-Analyse: welche Flächen sind seit der Extraktion unverändert (nicht umgewandelt — dieselben
  // Loop-Punkte wie im Herkunfts-Schnappschuss)? Vor enforcePlanarity/removeCollinearPoints markieren —
  // beide ändern nichts an der Form (Teilflächen der Zerlegung erben die Marke, s. splitPlanar).
  const markUntouched = (fds) => {
    const same = (L, S) => { if (!S || L.circleRim || L.length !== S.length) return false; for (let i = 0; i < L.length; i++) if (L[i] !== S[i]) return false; return true; };
    for (const fd of fds) {
      if (!fd.src && fd.splitPart) continue;   // Teilfläche: Marke aus splitPlanar behalten
      const s = fd.src;
      fd.untouched = !!s && fd.inner.length === s.inner.length && same(fd.outer, s.outer) && fd.inner.every((L, j) => same(L, s.inner[j]));
    }
  };
  const assembleCurrent = () => {
    markUntouched(faceDefs);
    const pl = enforcePlanarity(faceDefs);
    faceDefs = pl.fds;
    removeCollinearPoints(faceDefs);
    const a = assembleWithArcs(faceDefs, finalPlans, tubePlans, mantlePlans, mantleConePlans);
    a.report.filletsDefeatured = filletsDefeatured;
    a.report.bandsDefeatured = bandsDefeatured;
    a.report.coneBandsDefeatured = coneBandsDefeatured;
    a.report.cornersDefeatured = cornersDefeatured;
    if (preSplitStats) { pl.st.refits += preSplitStats.refits; pl.st.splits += preSplitStats.splits; pl.st.parts += preSplitStats.parts; }
    planarReport(a.report, pl.st);
    return a;
  };
  // Ein Zusammenbau gilt als gescheitert, wenn eine Schale offen ist, in der umgewandelt wurde bzw.
  // deren offene Kanten nicht schon im Netz offen sind (convFailed, je Schale — ein loses Dreieck neben
  // einem dichten Körper wirft dessen Bohrungen nicht mehr weg), ODER der Orientierungs-Wächter eine
  // analytische Fläche verworfen hat (s. assemble), ODER eine Schale mit analytischen Flächen
  // umgedreht/verworfen werden müsste (shellFail, Schalen-Analyse) — alles löst dieselben Fallback-
  // Stufen aus. Die Wächter-Befunde aller Stufen werden aufsummiert (Report: orientationGuardFailures,
  // fallbackStage 0 = keiner, 1 = ohne Bohrungen/Mäntel/Kegel/Kanäle, 2 = facettiert).
  let guardTotal = 0, guardMsTotal = 0, fallbackStage = 0;
  const failed = (a) => !!a.convFailed || (GUARD_FALLBACK && (a.report.orientationGuardFailures > 0 || !!a.shellFail));
  const tracked = (a) => { guardTotal += a.report.orientationGuardFailures; guardMsTotal += a.report.orientationGuardMs; return a; };
  // Profil-Bögen (profile-arcs.js): Bänder suchen, prüfen, anwenden; Geometrie aus den geschriebenen
  // (auf die Ebenen gesetzten, gerundeten) Koordinaten — dieselbe snapToPlanes-Rechnung wie in assemble.
  const convertArcs = (fds) => {
    if (!ARCS) return { fds, arcs: null };
    arcStats.tried++;
    try {
      // Wände, die die Primitive-Pfade (Mantel/Bohrung) beanspruchen, dürfen NICHT in Bänder
      // geteilt werden: deren Gates (Delle, Verdrehung, dünner Steg, Rand an der Plattenkante,
      // Konkavität) sind strenger als die des Bogen-Pfads — eine Teilung würde sie umgehen.
      const fb0 = findArcBands(fds, { vtxKey, blocked: arcBlocked, blockedGroups: arcBlockedGroups() });
      let det = validateArcBands(fds, fb0, { vtxKey });
      for (let it = 0; it < 4 && det.bands.length; it++) {
        const ap = applyArcBands(fds, det, { vtxKey });
        const snap = snapToPlanes(ap.fds).snap;
        const written = (p) => { const q = snap.get(vtxKey(p)) || p; return q.map((x) => +toStep(x)); };
        const res = buildArcPlans(fds, det, written, { vtxKey });   // ORIGINAL-Liste: band.facets indizieren sie
        if (!res.failed.size) return { fds: ap.fds, arcs: { plans: res.plans, geoms: res.geoms } };
        for (const b of det.bands) if (res.failed.has(b.id)) arcBlocked.add(b.sig);
        det = validateArcBands(fds, findArcBands(fds, { vtxKey, blocked: arcBlocked, blockedGroups: arcBlockedGroups() }), { vtxKey });
      }
    } catch (e) { /* Bögen sind optional: bei jedem Fehler facettiert */ }
    return { fds, arcs: null };
  };
  // Zusammenbau mit Bögen; scheitert er (failed) und liegt es an den Bögen, werden die Bänder an
  // defekten Kanten gesperrt und neu gebaut. Scheitert er danach weiter, liegt es nicht an den Bögen:
  // die Sperren werden zurückgenommen und der facettierte Zusammenbau geliefert. Der wird höchstens
  // einmal erzeugt — hat die letzte Runde schon ohne Bögen gebaut (cv.arcs === null), ist ihr Ergebnis
  // bereits der facettierte. Die anschließenden Rückfall-Stufen sehen so den facettierten Aufbau und
  // finden die defekte Kante im Netz (der Bogen-Aufbau verdeckt die Kanten der Originalflächen).
  const assembleWithArcs = (fds, plans, tubes = [], mantles = [], cones = []) => {
    const blocked0 = new Set(arcBlocked);
    let cv = convertArcs(fds);
    let a;
    try {
      a = assembleSolids(cv.fds, plans, tubes, mantles, cones, cv.arcs);
    } catch (e) {
      // Unvollständiger Bogen (Geometrie fehlt / Rand zu kurz) → Bögen verwerfen, facettiert bauen
      return assembleSolids(fds, plans, tubes, mantles, cones, null);
    }
    if (!cv.arcs || !failed(a)) return a;
    for (let r = 0; r < 2; r++) {
      arcStats.retries++;
      const bad = new Set();
      for (const [k, u] of edgeUse) { const t = u.fwd + u.rev; if (t === 1 || t > 2 || (t === 2 && u.fwd !== 1)) for (const x of String(k).split('#')[0].split('||')) bad.add(x); }
      for (const [k, u] of arcUse) { if (u.fwd !== 1 || u.rev !== 1) bad.add(`a:${k}`); }
      let hit = 0;
      for (const pl of cv.arcs.plans) {
        const keys = pl.segs.flatMap((s) => [vtxKey(s.pts[0]), vtxKey(s.pts[s.pts.length - 1])]);
        if (keys.some((k) => bad.has(k)) || pl.segs.some((s) => s.arcKey && bad.has(`a:${s.arcKey}`))) { arcBlocked.add(pl.sig); hit++; }
      }
      if (!hit || r === 1) { for (const pl of cv.arcs.plans) arcBlocked.add(pl.sig); }
      arcStats.dropped = arcBlocked.size;
      cv = convertArcs(fds);
      a = assembleSolids(cv.fds, plans, tubes, mantles, cones, cv.arcs);
      if (!failed(a)) return a;
      if (!cv.arcs) break;
    }
    // Weiter gescheitert → nicht die Bögen schuld: Sperren zurück, facettiert bauen (einmal).
    arcBlocked.clear(); for (const s of blocked0) arcBlocked.add(s);
    arcStats.dropped = arcBlocked.size;
    if (!cv.arcs) return a;                       // letzte Runde lief bereits ohne Bögen
    return assembleSolids(fds, plans, tubes, mantles, cones, null);
  };
  // Rückfall je Merkmal (vor den globalen Stufen): Scheitert ein Zusammenbau an defekten LINIEN-Kanten
  // (Randkante, non-manifold, Orientierungsfehler) oder bleibt eine umgebaute ebene Fläche uneben (s.
  // nonPlanarOps), werden die Entrundungen bestimmt, die das verursacht haben — (1) genau: ein Endpunkt ist Punkt einer entfernten Rundungs-Facette oder ein neu gesetzter
  // Punkt der Operation; (2) sonst grob: Marke fd.ops der Flächen an der Kante. Nur deren Rundungen
  // werden gesperrt (bleiben facettiert), der Lauf wird neu gebaut. Angenommen wird der neue Zusammenbau,
  // wenn er gelingt oder weniger defekte Kanten hat; sonst wird die Sperre zurückgenommen und der vorige
  // Zusammenbau wiederhergestellt. Höchstens MAX_FEATURE_RETRIES Neubauten je Stufe.
  // Rückfall je BOHRUNG (ebenfalls vor den globalen Stufen): Bohrungen tragen ihre Fehler selbst —
  // eine offene Kreis-Kante (Rand ohne Tag → nur vom Zylinder genutzt), ein Wächter-Befund an ihrem
  // Zylinder oder Fasen-Kegel oder eine defekte LINIEN-Kante an einer Fläche mit Kreis-Rand. Dann wird
  // NUR diese Bohrung gesperrt (blockedBores → bleibt facettiert), die übrigen bleiben analytisch.
  // Mäntel/Kegel/Kanäle und Schalen-Befunde bleiben bei den Stufen 1/2 unten.
  const MAX_FEATURE_RETRIES = 4;
  let featureRetries = 0, featuresDropped = 0, boresDropped = 0;
  const badLineKeys = () => {
    const out = [];
    for (const [k, u] of edgeUse) { const t = u.fwd + u.rev; if (t === 1 || t > 2 || (t === 2 && u.fwd !== 1)) out.push(k); }
    return out;
  };
  // defekte Kreis-Kanten (Randkante, non-manifold, Orientierungsfehler) — wie badLineKeys, aber Kreise
  const badCircleKeys = () => {
    const out = [];
    for (const [rk, u] of circleUse) { const t = u.fwd + u.rev; if (t === 1 || t > 2 || (t === 2 && u.fwd !== 1)) out.push(rk); }
    return out;
  };
  const badCircles = () => badCircleKeys().length;
  // Bohrungen, die den Fehler verursacht haben: (1) eine defekte Kreis-Kante gehört zu ihnen,
  // (2) der Wächter hat ihren Zylinder oder ihren Fasen-Kegel verworfen, (3) eine defekte LINIEN-Kante
  // liegt an einer Fläche mit Kreis-Rand (die Mündung dieser Bohrung).
  const boreCulprits = (a, bad) => {
    const out = new Set();
    const rimOwner = new Map();          // rimKey → boreById-Eintrag
    for (const plan of finalPlans) {
      if (!plan || !plan.entry) continue;
      for (const rim of (plan.rims || [])) if (rim && rim.rimKey) rimOwner.set(rim.rimKey, plan.entry);
      for (const cr of (plan.coneRims || [])) if (cr && cr.flatDesc && cr.flatDesc.rimKey) rimOwner.set(cr.flatDesc.rimKey, plan.entry);
      if (plan.tip && plan.tip.rim && plan.tip.rim.rimKey) rimOwner.set(plan.tip.rim.rimKey, plan.entry);
    }
    if (!rimOwner.size) return out;
    for (const rk of badCircleKeys()) { const e = rimOwner.get(rk); if (e) out.add(e); }
    if (a && a.guardFailedPlans) for (const plan of a.guardFailedPlans) if (plan && plan.entry) out.add(plan.entry);
    if (bad && bad.length) {
      // defekte LINIEN-Kante an einer Fläche mit Kreis-Rand → die Bohrung, deren Mündung DIESER Rand
      // trägt. Wichtig: der Rand muss die defekte Kante wirklich enthalten — eine Platte mit 3 Löchern
      // hat ALLE drei Mündungen in EINER Deckfläche; sonst würde jede Bohrung der Platte verurteilt.
      const badSet = new Set(bad.map((k) => String(k).split('#')[0]));
      const loopHasBad = (L) => {
        const n = L.length;
        for (let i = 0; i < n; i++) if (badSet.has(edgeCanonKey(L[i], L[(i + 1) % n]))) return true;
        return false;
      };
      a.faceKeys.forEach((ks, i) => {
        if (!ks.some((k) => badSet.has(String(k).split('#')[0]))) return;
        const src = a.faceSrc[i], fd = src && src.fd;
        if (!fd) return;
        for (const L of [fd.outer, ...fd.inner]) {
          if (!L || !L.circleRim) continue;
          const e = rimOwner.get(L.circleRim.rimKey);
          if (e && loopHasBad(L)) out.add(e);
        }
      });
    }
    return out;
  };
  // Defekte LINIEN-Kanten, die eine BOHRUNG verursacht hat: ihr Loop (die Mündung ohne circleRim-Tag)
  // liegt auf dem Randkreis dieser Bohrung. Sie werden NICHT als Merkmals-Fehler gedeutet — sonst zöge
  // der Merkmals-Rückfall ein Band mit, das die Mündung geschärft hat (und die ganze Bohrung mitnahm).
  const boreExplainedEdges = (a, bad, bores) => {
    const out = new Set();
    if (!bores.size || !bad || !bad.length) return out;
    const rims = [];
    for (const plan of finalPlans) {
      if (!plan || !plan.entry || !bores.has(plan.entry)) continue;
      for (const rim of (plan.rims || [])) if (rim && rim.radius) rims.push(rim);
      for (const cr of (plan.coneRims || [])) if (cr && cr.flatDesc && cr.flatDesc.radius) rims.push(cr.flatDesc);
    }
    if (!rims.length) return out;
    const onRim = (p, rim) => {
      const w = _sub3(p, rim.center), t = _dot3(w, rim.axis);
      const rho = Math.hypot(w[0] - rim.axis[0] * t, w[1] - rim.axis[1] * t, w[2] - rim.axis[2] * t);
      return Math.abs(rho - rim.radius) <= Math.max(0.15, 0.05 * rim.radius);
    };
    const badSet = new Set(bad.map((k) => String(k).split('#')[0]));
    a.faceKeys.forEach((ks, i) => {
      const hit = ks.filter((k) => badSet.has(String(k).split('#')[0]));
      if (!hit.length) return;
      const src = a.faceSrc[i], fd = src && src.fd;
      if (!fd) return;
      for (const L of [fd.outer, ...fd.inner]) {
        if (!L || L.circleRim || !L.length) continue;          // nur Loops OHNE Kreis-Tag (verdorbene Mündung)
        const n = L.length, le = new Set();
        for (let k = 0; k < n; k++) le.add(edgeCanonKey(L[k], L[(k + 1) % n]));
        const badHere = hit.filter((k) => le.has(String(k).split('#')[0]));
        if (!badHere.length) continue;
        if (!rims.some((rim) => L.every((p) => onRim(p, rim)))) continue;
        for (const k of badHere) out.add(k);
      }
    });
    return out;
  };
  const featureCulprits = (a, bad) => {
    // je defekter Kante die ZULETZT angewandte passende Operation (spätere bauen auf früheren auf —
    // v2b-Ecken auf den v2-Bändern; reicht das nicht, trifft der nächste Neubau die frühere)
    const ops = new Set();
    const ends = bad.map((k) => String(k).split('#')[0].split('||'));
    const latest = (hit) => { for (const [k1, k2] of ends) { let last = null; for (const op of featureOps) if (hit(op, k1, k2)) last = op; if (last) ops.add(last); } };
    latest((op, k1, k2) => op.keys.has(k1) && op.keys.has(k2));
    if (ops.size) return ops;
    latest((op, k1, k2) => op.keys.has(k1) || op.keys.has(k2));
    if (ops.size) return ops;
    const badSet = new Set(bad);
    a.faceKeys.forEach((ks, i) => {
      if (!ks.some((k) => badSet.has(k))) return;
      const src = a.faceSrc[i];
      if (src && src.fd && src.fd.ops) for (const op of src.fd.ops) ops.add(op);
    });
    return ops;
  };
  // Ebene Flächen, die eine Entrundung umgebaut hat und die nach enforcePlanarity UNEBEN geblieben sind
  // (strikte Importer verwerfen sie) — je Fläche die zuletzt angewandte Operation
  const nonPlanarOps = () => {
    const ops = new Set();
    let n = 0;
    for (const fd of faceDefs) {
      if (!fd.ops || fd.outer.circleRim || fd.inner.some((L) => L.circleRim)) continue;
      if (planeDev(fd, _norm3(fd.normal), fd.centroid) <= PLANAR_TOL) continue;
      n++;
      let last = null; for (const op of featureOps) if (fd.ops.has(op)) last = op;
      if (last) ops.add(last);
    }
    return { n, ops };
  };
  const buildStage = (withBores) => {
    runPipeline(withBores);
    let a = tracked(assembleCurrent());
    let np = DEFEATURE ? nonPlanarOps() : { n: 0, ops: new Set() };
    // Der Loop läuft jetzt auch ohne Defeaturing-Toggle (dann nur für Bohrungen).
    for (let r = 0; r < MAX_FEATURE_RETRIES && (failed(a) || np.ops.size); r++) {
      const bad = failed(a) ? badLineKeys() : [];
      // Fehlerlast des aktuellen Laufs: defekte LINIEN-Kanten + defekte Kreis-Kanten + Wächter-Befunde
      const dA = failed(a) ? bad.length + badCircles() + a.report.orientationGuardFailures : 0;
      const bores = withBores && failed(a) ? boreCulprits(a, bad) : new Set();
      const culprits = new Set(np.ops);
      if (DEFEATURE && bad.length) {
        // Kanten, die eine Bohrung verursacht hat, sind kein Merkmals-Fehler (s. boreExplainedEdges)
        const explained = boreExplainedEdges(a, bad, bores);
        for (const op of featureCulprits(a, bad.filter((k) => !explained.has(k)))) culprits.add(op);
      }
      if (!culprits.size && !bores.size) break;
      const savedBlocked = [...blockedGroups], savedBores = [...blockedBores];
      for (const op of culprits) for (const g of op.groups) blockedGroups.add(g);
      for (const e of bores) blockedBores.add(e);
      const saved = entities.slice(entMark), savedId = id;
      runPipeline(withBores);
      const b = tracked(assembleCurrent());
      featureRetries++;
      const npB = DEFEATURE ? nonPlanarOps() : { n: 0, ops: new Set() };
      const dB = failed(b) ? badLineKeys().length + badCircles() + b.report.orientationGuardFailures : 0;
      if ((!failed(b) || failed(a)) && dB + npB.n < dA + np.n) {
        a = b; np = npB; featuresDropped += culprits.size + bores.size; boresDropped += bores.size; continue;
      }
      blockedGroups.clear();
      for (const g of savedBlocked) blockedGroups.add(g);
      blockedBores.clear();
      for (const e of savedBores) blockedBores.add(e);
      entities.length = entMark;
      for (const e of saved) entities.push(e);
      id = savedId;
      break;
    }
    return a;
  };
  let asm = buildStage(true);
  // Fallbacks, wenn die Umwandlung (analytische Flächen ODER Defeaturing) scheitert — Hülle offen
  // oder Orientierungs-Wächter (s. failed):
  //   Stufe 2 (global): ALLES facettiert neu bauen (buildFaceDefs(null) erzeugt FRISCHE, unmutierte
  //     Loops) — die wasserdichte Baseline kann dadurch nie regressieren. (Die Kollinear-Bereinigung
  //     läuft auch hier: sie ist topologisch neutral, sonst hätte „Defeaturing an" mehr Kanten als „aus".)
  //   Stufe 1 (nur mit Toggle, nur bei Bohrungen/Mänteln/Kegeln/Kanälen): ohne diese neu bauen, Defeaturing
  //     bleibt — sonst verwarf der globale Fallback auch korrekte Bänder/Ecken.
  // Die Basislinie wird ZUERST gebaut: ist schon sie nicht wasserdicht (Netz von Haus aus offen, z.B.
  // gelochtes Netz), kann Stufe 1 die Hülle praktisch nie schließen — sie lief früher trotzdem und
  // kostete am gelochten eBike 39–57 % der Exportzeit. Ergebnis: Stufe 1, wenn sie gelingt, sonst
  // die Basislinie (deren Entitäten dafür gesichert und zurückgeschrieben werden).
  // (Zähler aus dem Bericht des angenommenen Zusammenbaus — die Lauf-Variablen können von einem
  // verworfenen Neubau stammen, s. buildStage)
  const ar = asm.report;
  const converted = ar.boresConverted > 0 || ar.mantlesConverted > 0 || ar.mantleConesConverted > 0 ||
    ar.mantleChamfersConverted > 0 || ar.tubesConverted > 0 || ar.filletsDefeatured > 0 || ar.bandsDefeatured > 0 ||
    ar.cornersDefeatured > 0;
  let stage1Tried = false;
  if (converted && failed(asm)) {
    const stage1 = DEFEATURE && (ar.boresConverted > 0 || ar.tubesConverted > 0 || ar.mantlesConverted > 0 || ar.mantleConesConverted > 0 || ar.mantleChamfersConverted > 0);
    const freshDefs = buildFaceDefs(null);
    markUntouched(freshDefs);
    const pl = enforcePlanarity(freshDefs);
    const fallbackDefs = pl.fds;
    removeCollinearPoints(fallbackDefs);
    const base = tracked(assembleWithArcs(fallbackDefs, []));
    base.report.filletsDefeatured = 0;
    base.report.bandsDefeatured = 0;
    base.report.coneBandsDefeatured = 0;
    base.report.cornersDefeatured = 0;
    planarReport(base.report, pl.st);
    asm = base; fallbackStage = 2;
    // Stufe 1 nur über einer vollständig dichten Basislinie (s. o.): eine schon im Netz offene Schale
    // bleibt offen, eine Umwandlung darin scheitert in Stufe 1 genauso.
    if (stage1 && !failed(base) && base.report.watertight) {
      stage1Tried = true;
      const baseEntities = entities.slice(entMark), baseId = id;
      const s1 = buildStage(false);
      if (!failed(s1)) { asm = s1; fallbackStage = 1; }
      else {
        entities.length = entMark;
        for (const e of baseEntities) entities.push(e);
        id = baseId;
      }
    }
  }
  // Befund für Tests/Diagnose: fallbackStage 0 = keine Fallback-Stufe, 1 = ohne Bohrungen/Mäntel/
  // Kegel/Kanäle neu gebaut, 2 = facettierte Basislinie; stage1Tried = Stufe 1 wurde überhaupt versucht.
  asm.report.orientationGuardFailures = guardTotal;
  asm.report.orientationGuardMs = Math.round(guardMsTotal * 1000) / 1000;
  asm.report.fallbackStage = fallbackStage;
  asm.report.stage1Tried = stage1Tried;
  // Rückfall je Merkmal: Neubauten und gesperrte (facettiert belassene) Entrundungen über alle Stufen
  asm.report.featureRetries = featureRetries;
  asm.report.featuresDropped = fallbackStage === 2 ? 0 : featuresDropped;   // facettierte Basislinie: nichts übrig
  // Blech-Biegungen: Zahl der Biegungs-Primitive, die von der Entrundung ausgenommen wurden
  // (0 mit Schalter „Blech-Biegungen schärfen“ oder ohne Entrundung).
  asm.report.bendsKept = bendInfo.prims.size;
  asm.report.boresDropped = fallbackStage === 2 ? 0 : boresDropped;         // dito: Bohrungen, die facettiert bleiben
  asm.report.boreNotes = [...boreNotes].map(([id, why]) => ({ id, why }));   // Diagnose je Bohrung
  // Profil-Bögen (profile-arcs.js): Neubauten und gesperrte (facettiert belassene) Bänder
  asm.report.arcRetries = arcStats.retries; asm.report.arcBandsBlocked = arcBlocked.size;
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
  entities.push(`#${uncId}=UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(${STEP_UNCERTAINTY_MM}),#${lenUnitId},'distance_accuracy_value','confusion accuracy');`);
  const ctxId = id++;
  entities.push(`#${ctxId}=( GEOMETRIC_REPRESENTATION_CONTEXT(3) GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#${uncId})) GLOBAL_UNIT_ASSIGNED_CONTEXT((#${lenUnitId},#${angUnitId},#${solUnitId})) REPRESENTATION_CONTEXT('','3D') );`);

  // ---- Step 5: je dichter Schale ein echter Volumenkörper (CLOSED_SHELL + MANIFOLD_SOLID_BREP; mit
  // Hohlräumen BREP_WITH_VOIDS, Hohlraum-Schale als ORIENTED_CLOSED_SHELL .F.), offene Schalen als
  // Flächenmodell (OPEN_SHELL), das das CAD selbst zu nähen versuchen kann — neben Körpern als eigene
  // Darstellung, über SHAPE_REPRESENTATION_RELATIONSHIP an dieselbe Produkt-Darstellung gebunden. Ein
  // Körper ohne Hohlraum = Ausgabe wie bisher. (Typen: Schalen-Analyse, assembleSolids.)
  const bodies = asm.bodies || [], opens = asm.opens || [];
  const refs = (ids) => ids.map((x) => `#${x}`).join(',');
  const addSurfaceModel = (name) => {
    const shellIds = opens.map((fs) => {
      const shellId = id++;
      entities.push(`#${shellId}=OPEN_SHELL('',(${refs(fs)}));`);
      return shellId;
    });
    const surfaceModelId = id++;
    entities.push(`#${surfaceModelId}=SHELL_BASED_SURFACE_MODEL('V2 Reconstruction',(${refs(shellIds)}));`);
    const repId = id++;
    entities.push(`#${repId}=MANIFOLD_SURFACE_SHAPE_REPRESENTATION('${name}',(#${surfaceModelId}),#${ctxId});`);
    return repId;
  };
  let shapeRepId;
  if (bodies.length) {
    const solidIds = bodies.map((b) => {
      const shellId = id++;
      entities.push(`#${shellId}=CLOSED_SHELL('',(${refs(b.faces)}));`);
      const solidId = id++;
      if (!b.voids.length) {
        entities.push(`#${solidId}=MANIFOLD_SOLID_BREP('V2 Solid',#${shellId});`);
        return solidId;
      }
      const voidIds = b.voids.map((vf) => {
        const vsId = id++;
        entities.push(`#${vsId}=CLOSED_SHELL('',(${refs(vf)}));`);
        const ocsId = id++;
        entities.push(`#${ocsId}=ORIENTED_CLOSED_SHELL('',*,#${vsId},.F.);`);
        return ocsId;
      });
      entities.push(`#${solidId}=BREP_WITH_VOIDS('V2 Solid',#${shellId},(${refs(voidIds)}));`);
      return solidId;
    });
    shapeRepId = id++;
    entities.push(`#${shapeRepId}=ADVANCED_BREP_SHAPE_REPRESENTATION('V2 Volume',(${refs(solidIds)}),#${ctxId});`);
    if (opens.length) {
      const surfRepId = addSurfaceModel('V2 Restflaechen');
      const relId = id++;
      entities.push(`#${relId}=SHAPE_REPRESENTATION_RELATIONSHIP('','',#${shapeRepId},#${surfRepId});`);
    }
  } else {
    shapeRepId = addSurfaceModel('V2 Volume');
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
  const toStepDir = (v) => {   // Richtungen mit 12 Nachkommastellen (s. buildVolumeStepBrepV2)
    if (!Number.isFinite(v)) return '0.';
    const t = Number(v).toFixed(12).replace(/(\.\d*?)0+$/, '$1');
    return t.includes('.') ? t : t + '.';
  };
  const addDirection = (vec) => {
    const len = Math.hypot(vec[0], vec[1], vec[2]) || 1;
    const d = vec.map(v => v / len || 0);
    const did = id++; entities.push(`#${did}=DIRECTION('',(${d.map((x) => toStepDir(x)).join(',')}));`); return did;
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
  entities.push(`#${uncId}=UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(${STEP_UNCERTAINTY_MM}),#${lenUnitId},'distance_accuracy_value','confusion accuracy');`);
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

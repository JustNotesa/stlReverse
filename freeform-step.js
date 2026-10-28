// ─────────────────────────────────────────────────────────────────────────────
// freeform-step.js — Freiform-B-Rep → STEP (AP214 AUTOMOTIVE_DESIGN, ISO 10303-21)
//
// Eigenes Modul für den Freiform-Pfad (Entwurf freeform-brep.js, Etappe 1): nimmt das
// B-Rep der Freiform-Module (vertices/edges/faces) und schreibt eine STEP-Datei mit EINER
// CLOSED_SHELL + MANIFOLD_SOLID_BREP. Flächen: PLANE, CYLINDRICAL_/CONICAL_/SPHERICAL_/
// TOROIDAL_SURFACE; Kanten: LINE, CIRCLE, B_SPLINE_CURVE_WITH_KNOTS.
//
// Zahlenformat, Einheiten, Kontext und Produkt-Wrapper sind wie in exporters.js
// (buildVolumeStepBrepV2, Zeilen 6828–6926). exporters.js wird hier NICHT importiert —
// der Einhängepunkt dort bleibt unberührt; die Unsicherheits-Konstante liegt daher lokal.
//
// Datenmodell (verbindlich, freeform-brep.js):
//   vertices : [[x,y,z], …]
//   edges    : [{ v0, v1, curve }]   v0/v1 = Index in vertices; die Kante läuft in
//                                   Kurvenrichtung v0 → v1 → EDGE_CURVE same_sense .T.
//   faces    : [{ surf, sameSense, loops: [{ outer, uses: [{ edge, fwd }] }] }]
//   surf     : {type:'plane',o,n} | {type:'cylinder',o,a,R} | {type:'cone',apex,a,alpha,h0?}
//             | {type:'sphere',c,R,axis?} | {type:'torus',c,a,Rm,r}
//   curve    : {type:'line',p,d} | {type:'circle',c,a,R,x}
//             | {type:'bspline',degree,ctrl,knots,mults}
// ─────────────────────────────────────────────────────────────────────────────

// Globale Unsicherheit im STEP-Kopf (UNCERTAINTY_MEASURE_WITH_UNIT, mm) — identisch zu
// exporters.js (STEP_UNCERTAINTY_MM). Eigene Kopie, damit exporters.js unangetastet bleibt.
const STEP_UNCERTAINTY_MM = '1.E-04';

// ---- Vektoren (self-contained) ----
const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add3 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul3 = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const len3 = (a) => Math.hypot(a[0], a[1], a[2]);
const norm3 = (a) => { const l = len3(a); return l > 0 ? mul3(a, 1 / l) : [0, 0, 0]; };

// Deterministische Senkrechte zur Achse: die Koordinatenachse mit dem kleinsten |Anteil|
// liefert die größte Querkomponente (≥ 0.7) — gleiche Eingabe → gleiche Datei.
const perpTo = (a) => {
  const ax = Math.abs(a[0]), ay = Math.abs(a[1]), az = Math.abs(a[2]);
  let base;
  if (ax <= ay && ax <= az) base = [1, 0, 0];
  else if (ay <= az) base = [0, 1, 0];
  else base = [0, 0, 1];
  return norm3(cross3(a, base));
};

// Referenzrichtung (x der AXIS2_PLACEMENT_3D): gewünschtes x orthogonalisiert gegen die
// Achse; ohne x (oder bei Entartung) eine deterministische Senkrechte.
const refDir = (axis, x) => {
  if (!x) return perpTo(axis);
  const o = sub3(x, mul3(axis, dot3(x, axis)));
  return len3(o) > 1e-9 ? norm3(o) : perpTo(axis);
};

// ---- Zahlenformat wie exporters.js ----
// Punkte, Radien, Winkel mit 9 Nachkommastellen (strikte Kerne rechnen mit ~1e-6 mm).
const toStep = (v) => {
  if (!Number.isFinite(v)) return '0.';
  const t = Number(v).toFixed(9).replace(/(\.\d*?)0+$/, '$1');
  return t.includes('.') ? t : t + '.';
};
// Richtungen mit 12 Nachkommastellen (schräge Flächen: 6 Stellen lagen neben der Fläche).
const toStepDir = (v) => {
  if (!Number.isFinite(v)) return '0.';
  const t = Number(v).toFixed(12).replace(/(\.\d*?)0+$/, '$1');
  return t.includes('.') ? t : t + '.';
};

// ─────────────────────────────────────────────────────────────────────────────
// Schreiber: B-Rep → STEP-Text + Zählwerk
//
// opts: { timestamp?, fileName? } — Zeitstempel/Dateiname im STEP-Kopf.
// Rückgabe: { step, counts: { faces, edges, vertices, surfaces, curves } }
// (surfaces/curves zählen nur die vorkommenden Typen)
// ─────────────────────────────────────────────────────────────────────────────
export function writeFreeformStep(brep, opts = {}) {
  const b = brep || {};
  const vertices = b.vertices || [];
  const edges = b.edges || [];
  const faces = b.faces || [];

  const entities = [];
  let id = 1;

  // ---- Entitäts-Helfer ----
  const addPoint = (pt) => {
    const pid = id++;
    entities.push(`#${pid}=CARTESIAN_POINT('',(${pt.map(toStep).join(',')}));`);
    return pid;
  };
  const addDirection = (vec) => {
    const d = norm3(vec);
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
  const addAxis2 = (loc, axis, ref) => {
    const locId = addPoint(loc);
    const axId = addDirection(axis);
    const refId = addDirection(ref);
    const pid = id++;
    entities.push(`#${pid}=AXIS2_PLACEMENT_3D('',#${locId},#${axId},#${refId});`);
    return pid;
  };
  const addLine = (ptId, vecId) => {
    const lid = id++;
    entities.push(`#${lid}=LINE('',#${ptId},#${vecId});`);
    return lid;
  };
  const addCircle = (placId, radius) => {
    const cid = id++;
    entities.push(`#${cid}=CIRCLE('',#${placId},${toStep(radius)});`);
    return cid;
  };
  const addBSpline = (degree, ctrlIds, knots, mults) => {
    const bid = id++;
    entities.push(`#${bid}=B_SPLINE_CURVE_WITH_KNOTS('',${degree},(${ctrlIds.map((c) => `#${c}`).join(',')}),.UNSPECIFIED.,.F.,.F.,(${mults.join(',')}),(${knots.map(toStep).join(',')}),.UNSPECIFIED.);`);
    return bid;
  };
  const addEdgeCurve = (sv, ev, curveId) => {
    const eid = id++;
    entities.push(`#${eid}=EDGE_CURVE('',#${sv},#${ev},#${curveId},.T.);`);
    return eid;
  };
  const addOrientedEdge = (ecId, fwd) => {
    const oid = id++;
    entities.push(`#${oid}=ORIENTED_EDGE('',*,*,#${ecId},.${fwd ? 'T' : 'F'}.);`);
    return oid;
  };
  const addEdgeLoop = (oeIds) => {
    const lid = id++;
    entities.push(`#${lid}=EDGE_LOOP('',(${oeIds.map((e) => `#${e}`).join(',')}));`);
    return lid;
  };
  const addBound = (loopId, outer) => {
    const bid = id++;
    entities.push(`#${bid}=${outer ? 'FACE_OUTER_BOUND' : 'FACE_BOUND'}('',#${loopId},.T.);`);
    return bid;
  };
  const addAdvancedFace = (boundIds, surfId, sameSense) => {
    const fid = id++;
    entities.push(`#${fid}=ADVANCED_FACE('',(${boundIds.map((b) => `#${b}`).join(',')}),#${surfId},.${sameSense ? 'T' : 'F'}.);`);
    return fid;
  };

  // ---- Ecken: je eine CARTESIAN_POINT + VERTEX_POINT ----
  const vtxIds = vertices.map((p) => addVertex(addPoint(p)));

  // ---- Kanten: je eine Kurve + EDGE_CURVE (Kante läuft in Kurvenrichtung v0 → v1) ----
  const curveCounts = {};      // nur vorkommende Typen
  const bump = (obj, key) => { obj[key] = (obj[key] || 0) + 1; };
  const edgeIds = edges.map((e) => {
    const c = e.curve || {};
    let curveId;
    if (c.type === 'circle') {
      const a = norm3(c.a || [0, 0, 1]);
      curveId = addCircle(addAxis2(c.c, a, refDir(a, c.x)), c.R);
      bump(curveCounts, 'CIRCLE');
    } else if (c.type === 'bspline') {
      const cps = (c.ctrl || []).map((p) => addPoint(p));
      curveId = addBSpline(c.degree ?? 3, cps, c.knots || [], c.mults || []);
      bump(curveCounts, 'B_SPLINE_CURVE_WITH_KNOTS');
    } else {
      // Gerade: Punkt = curve.p (Anfang), Richtung = curve.d (muss v0 → v1 zeigen)
      const d = norm3(c.d || sub3(vertices[e.v1] || [0, 0, 0], vertices[e.v0] || [0, 0, 0]));
      const dirId = addDirection(d);
      curveId = addLine(addPoint(c.p || vertices[e.v0] || [0, 0, 0]), addVector(dirId, 1));
      bump(curveCounts, 'LINE');
    }
    return addEdgeCurve(vtxIds[e.v0], vtxIds[e.v1], curveId);
  });

  // ---- Flächen: eine Flächenentität + Ränder je Fläche ----
  const surfaceCounts = {};    // nur vorkommende Typen
  const faceIds = [];
  for (const f of faces) {
    const s = f.surf || {};
    let surfId;
    if (s.type === 'cylinder') {
      const a = norm3(s.a || [0, 0, 1]);
      const placId = addAxis2(s.o, a, refDir(a, s.x));
      surfId = id++;
      entities.push(`#${surfId}=CYLINDRICAL_SURFACE('',#${placId},${toStep(s.R)});`);
      bump(surfaceCounts, 'CYLINDRICAL_SURFACE');
    } else if (s.type === 'cone') {
      // Kegel: Spitze + Achse + Halbwinkel; h0 = Abstand Spitze→Platzierungsebene
      const a = norm3(s.a || [0, 0, 1]);
      const h0 = s.h0 ?? 1;
      const placId = addAxis2(add3(s.apex || [0, 0, 0], mul3(a, h0)), a, refDir(a, s.x));
      surfId = id++;
      entities.push(`#${surfId}=CONICAL_SURFACE('',#${placId},${toStep(h0 * Math.tan(s.alpha))},${toStepDir(s.alpha)});`);
      bump(surfaceCounts, 'CONICAL_SURFACE');
    } else if (s.type === 'sphere') {
      const a = norm3(s.axis || [0, 0, 1]);
      const placId = addAxis2(s.c, a, refDir(a, s.x));
      surfId = id++;
      entities.push(`#${surfId}=SPHERICAL_SURFACE('',#${placId},${toStep(s.R)});`);
      bump(surfaceCounts, 'SPHERICAL_SURFACE');
    } else if (s.type === 'torus') {
      const a = norm3(s.a || [0, 0, 1]);
      const placId = addAxis2(s.c, a, refDir(a, s.x));
      surfId = id++;
      entities.push(`#${surfId}=TOROIDAL_SURFACE('',#${placId},${toStep(s.Rm)},${toStep(s.r)});`);
      bump(surfaceCounts, 'TOROIDAL_SURFACE');
    } else {
      const n = norm3(s.n || [0, 0, 1]);
      const placId = addAxis2(s.o, n, refDir(n, s.x));
      surfId = id++;
      entities.push(`#${surfId}=PLANE('',#${placId});`);
      bump(surfaceCounts, 'PLANE');
    }
    const boundIds = [];
    for (const loop of f.loops || []) {
      const oeIds = [];
      for (const u of loop.uses || []) {
        const ecId = edgeIds[u.edge];
        if (ecId === undefined) continue;          // unbenutzte Kante (kein gültiges B-Rep)
        oeIds.push(addOrientedEdge(ecId, u.fwd !== false));
      }
      boundIds.push(addBound(addEdgeLoop(oeIds), !!loop.outer));
    }
    faceIds.push(addAdvancedFace(boundIds, surfId, !!f.sameSense));
  }

  // ---- Hülle + Körper ----
  const shellId = id++;
  entities.push(`#${shellId}=CLOSED_SHELL('',(${faceIds.map((f) => `#${f}`).join(',')}));`);
  const solidId = id++;
  entities.push(`#${solidId}=MANIFOLD_SOLID_BREP('Freiform Solid',#${shellId});`);

  // ---- Einheiten + Kontext (wie exporters.js) ----
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

  // ---- Darstellung + Produkt-Wrapper ----
  const shapeRepId = id++;
  entities.push(`#${shapeRepId}=ADVANCED_BREP_SHAPE_REPRESENTATION('Freiform Volume',(#${solidId}),#${ctxId});`);
  const appCtxId = id++;
  entities.push(`#${appCtxId}=APPLICATION_CONTEXT('automotive');`);
  const appProtId = id++;
  entities.push(`#${appProtId}=APPLICATION_PROTOCOL_DEFINITION('','automotive_design',2009,#${appCtxId});`);
  const prodCtxId = id++;
  entities.push(`#${prodCtxId}=PRODUCT_CONTEXT('design','',#${appCtxId});`);
  const prodId = id++;
  entities.push(`#${prodId}=PRODUCT('Freiform B-Rep','Freiform Reconstruction','',(#${prodCtxId}));`);
  const formId = id++;
  entities.push(`#${formId}=PRODUCT_DEFINITION_FORMATION_WITH_SPECIFIED_SOURCE('','',#${prodId},.NOT_KNOWN.);`);
  const prodDefId = id++;
  entities.push(`#${prodDefId}=PRODUCT_DEFINITION('','',#${formId},#${prodCtxId});`);
  const prodDefShapeId = id++;
  entities.push(`#${prodDefShapeId}=PRODUCT_DEFINITION_SHAPE('','',#${prodDefId});`);
  const shapeDefRepId = id++;
  entities.push(`#${shapeDefRepId}=SHAPE_DEFINITION_REPRESENTATION(#${prodDefShapeId},#${shapeRepId});`);

  // Zeitstempel: echte Uhrzeit (wie exporters.js); für reproduzierbare Dateien opts.timestamp setzen
  const timestamp = opts.timestamp || new Date().toISOString();
  const step = [
    'ISO-10303-21;',
    'HEADER;',
    "FILE_DESCRIPTION(('STLReverse Freiform B-Rep'),'2;1');",
    `FILE_NAME('${opts.fileName || 'stlReverse-freiform-brep.step'}','${timestamp}',('STLReverse'),('STLReverse'),'STLReverse','STLReverse','');`,
    "FILE_SCHEMA(('AUTOMOTIVE_DESIGN'));",
    'ENDSEC;',
    'DATA;',
    ...entities,
    'ENDSEC;',
    'END-ISO-10303-21;'
  ].join('\n');

  return {
    step,
    counts: {
      faces: faces.length,
      edges: edges.length,
      vertices: vertices.length,
      surfaces: surfaceCounts,
      curves: curveCounts,
    },
  };
}

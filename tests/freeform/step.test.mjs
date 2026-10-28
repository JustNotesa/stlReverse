// ─────────────────────────────────────────────────────────────────────────────
// tests/freeform/step.test.mjs — Freiform-B-Rep → STEP (freeform-step.js)
//
// Vier von Hand gebaute Körper gehen durch den strengen STEP-Prüfer (tests/step-strict.mjs):
//   a) Würfel 10 mm          — 8 Ecken, 12 LINE-Kanten, 6 PLANE-Flächen (Außennormalen,
//                              Ränder gegen den Uhrzeigersinn um die effektive Normale)
//   b) Zylinder R=2, z 0…3   — jeder Randkreis in zwei Bögen (Ecken bei 0°/180°),
//                              4 CIRCLE-Kanten, keine Naht; Mantel mit 2 FACE_BOUND,
//                              Deckel (+z) und Boden (Flächennormale +z, same_sense .F.)
//   c) Halbkugel R=2 auf Scheibe — SPHERICAL_SURFACE + Ebene z=0 (same_sense .F.)
//   d) Würfel mit einer B-Spline-Kante — statt LINE eine B_SPLINE_CURVE_WITH_KNOTS
// Die STEP-Dateien landen in tests/freeform/out/.
//
// Ausführen:  .dev/test-stl.sh ff-step
// ─────────────────────────────────────────────────────────────────────────────
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeFreeformStep } from '../../freeform-step.js';
import { checkStepStrict } from '../step-strict.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'out');
mkdirSync(OUT, { recursive: true });

let failed = 0;
const test = (name, fn) => {
  try { fn(); console.log('ok ' + name); }
  catch (e) { failed++; console.log('FAIL ' + name + ': ' + (e && e.message ? e.message : String(e))); }
};

// B-Rep schreiben + Datei ablegen
const write = (name, brep) => {
  const res = writeFreeformStep(brep, { timestamp: '2026-10-28T00:00:00.000Z', fileName: name + '.step' });
  writeFileSync(join(OUT, name + '.step'), res.step);
  return res;
};

// Entitäten im STEP-Text zählen (#12=TYPE( … )
const countEntities = (step, type) => (step.match(new RegExp('#\\d+=' + type + '\\(', 'g')) || []).length;

// ---- (a) Würfel 10 mm ----
const cubeVertices = [
  [0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0],
  [0, 0, 10], [10, 0, 10], [10, 10, 10], [0, 10, 10],
];
// Kanten (v0 < v1); die Richtung zeigt immer von v0 nach v1
const cubePairs = [
  [0, 1], [0, 3], [1, 2], [2, 3], [0, 4], [1, 5], [3, 7], [2, 6], [4, 5], [4, 7], [5, 6], [6, 7],
];
const dirOf = (a, b) => {
  const d = [cubeVertices[b][0] - cubeVertices[a][0], cubeVertices[b][1] - cubeVertices[a][1], cubeVertices[b][2] - cubeVertices[a][2]];
  const l = Math.hypot(d[0], d[1], d[2]);
  return [d[0] / l, d[1] / l, d[2] / l];
};
const cubeEdges = cubePairs.map(([a, b]) => ({ v0: a, v1: b, curve: { type: 'line', p: cubeVertices[a], d: dirOf(a, b) } }));
// Ränder gegen den Uhrzeigersinn um die Außennormale
const cubeFaces = [
  { surf: { type: 'plane', o: [0, 0, 0], n: [0, 0, -1] }, sameSense: true, loops: [{ outer: true, uses: [{ edge: 1, fwd: true }, { edge: 3, fwd: false }, { edge: 2, fwd: false }, { edge: 0, fwd: false }] }] },
  { surf: { type: 'plane', o: [0, 0, 10], n: [0, 0, 1] }, sameSense: true, loops: [{ outer: true, uses: [{ edge: 8, fwd: true }, { edge: 10, fwd: true }, { edge: 11, fwd: true }, { edge: 9, fwd: false }] }] },
  { surf: { type: 'plane', o: [0, 0, 0], n: [0, -1, 0] }, sameSense: true, loops: [{ outer: true, uses: [{ edge: 0, fwd: true }, { edge: 5, fwd: true }, { edge: 8, fwd: false }, { edge: 4, fwd: false }] }] },
  { surf: { type: 'plane', o: [0, 10, 0], n: [0, 1, 0] }, sameSense: true, loops: [{ outer: true, uses: [{ edge: 6, fwd: true }, { edge: 11, fwd: false }, { edge: 7, fwd: false }, { edge: 3, fwd: true }] }] },
  { surf: { type: 'plane', o: [0, 0, 0], n: [-1, 0, 0] }, sameSense: true, loops: [{ outer: true, uses: [{ edge: 4, fwd: true }, { edge: 9, fwd: true }, { edge: 6, fwd: false }, { edge: 1, fwd: false }] }] },
  { surf: { type: 'plane', o: [10, 0, 0], n: [1, 0, 0] }, sameSense: true, loops: [{ outer: true, uses: [{ edge: 2, fwd: true }, { edge: 7, fwd: true }, { edge: 10, fwd: false }, { edge: 5, fwd: false }] }] },
];
const cubeBrep = { vertices: cubeVertices, edges: cubeEdges, faces: cubeFaces };

test('a) Würfel 10 mm: streng gültig', () => {
  const { step, counts } = write('cube', cubeBrep);
  const { violations, stats } = checkStepStrict(step);
  assert.deepEqual(violations.map((v) => `${v.kind}: ${v.msg}`), [], 'Verstöße im Würfel');
  assert.equal(stats.faces, 6);
  assert.deepEqual(counts, {
    faces: 6, edges: 12, vertices: 8,
    surfaces: { PLANE: 6 },
    curves: { LINE: 12 },
  });
  // 8 Eckpunkte + 12 Linien-Anfangspunkte + 6 Platzierungspunkte der Ebenen
  assert.equal(countEntities(step, 'CARTESIAN_POINT'), 26);
  assert.equal(countEntities(step, 'VERTEX_POINT'), 8);
  assert.equal(countEntities(step, 'EDGE_CURVE'), 12);
  assert.equal(countEntities(step, 'ORIENTED_EDGE'), 24);
  assert.equal(countEntities(step, 'EDGE_LOOP'), 6);
  assert.equal(countEntities(step, 'FACE_OUTER_BOUND'), 6);
  assert.equal(countEntities(step, 'ADVANCED_FACE'), 6);
  assert.equal(countEntities(step, 'CLOSED_SHELL'), 1);
  assert.equal(countEntities(step, 'MANIFOLD_SOLID_BREP'), 1);
});

// ---- (b) Zylinder R=2, z = 0…3 ----
// Ecken: 0/2 bei 0°, 1/3 bei 180° (unten 0,1 — oben 2,3)
const cylVertices = [[2, 0, 0], [-2, 0, 0], [2, 0, 3], [-2, 0, 3]];
const cylEdges = [
  { v0: 0, v1: 1, curve: { type: 'circle', c: [0, 0, 0], a: [0, 0, 1], R: 2, x: [1, 0, 0] } },   // unten 0°→180°
  { v0: 1, v1: 0, curve: { type: 'circle', c: [0, 0, 0], a: [0, 0, 1], R: 2, x: [-1, 0, 0] } },  // unten 180°→360°
  { v0: 2, v1: 3, curve: { type: 'circle', c: [0, 0, 3], a: [0, 0, 1], R: 2, x: [1, 0, 0] } },   // oben 0°→180°
  { v0: 3, v1: 2, curve: { type: 'circle', c: [0, 0, 3], a: [0, 0, 1], R: 2, x: [-1, 0, 0] } },  // oben 180°→360°
];
const cylFaces = [
  {   // Mantel: unterer Rand im Uhrzeigersinn (+z), oberer Rand dagegen
    surf: { type: 'cylinder', o: [0, 0, 0], a: [0, 0, 1], R: 2 }, sameSense: true,
    loops: [
      { outer: false, uses: [{ edge: 0, fwd: true }, { edge: 1, fwd: true }] },
      { outer: false, uses: [{ edge: 3, fwd: false }, { edge: 2, fwd: false }] },
    ],
  },
  {   // Deckel: Ebene z=3, Normale +z → Rand im Uhrzeigersinn um +z
    surf: { type: 'plane', o: [0, 0, 3], n: [0, 0, 1] }, sameSense: true,
    loops: [{ outer: true, uses: [{ edge: 2, fwd: true }, { edge: 3, fwd: true }] }],
  },
  {   // Boden: Flächennormale +z, same_sense .F. → effektive Normale −z → Rand im Uhrzeigersinn um −z
    surf: { type: 'plane', o: [0, 0, 0], n: [0, 0, 1] }, sameSense: false,
    loops: [{ outer: true, uses: [{ edge: 1, fwd: false }, { edge: 0, fwd: false }] }],
  },
];
const cylBrep = { vertices: cylVertices, edges: cylEdges, faces: cylFaces };

test('b) Zylinder R=2 z=0…3: streng gültig', () => {
  const { step, counts } = write('cylinder', cylBrep);
  const { violations, stats } = checkStepStrict(step);
  assert.deepEqual(violations.map((v) => `${v.kind}: ${v.msg}`), [], 'Verstöße im Zylinder');
  assert.equal(stats.faces, 3);
  assert.deepEqual(counts, {
    faces: 3, edges: 4, vertices: 4,
    surfaces: { PLANE: 2, CYLINDRICAL_SURFACE: 1 },
    curves: { CIRCLE: 4 },
  });
  assert.equal(countEntities(step, 'CIRCLE'), 4);
  assert.equal(countEntities(step, 'CYLINDRICAL_SURFACE'), 1);
  assert.equal(countEntities(step, 'FACE_BOUND'), 2);       // Mantel: beide Ränder FACE_BOUND
  assert.equal(countEntities(step, 'FACE_OUTER_BOUND'), 2); // Deckel + Boden
});

// ---- (c) Halbkugel R=2 (z ≥ 0) auf einer Scheibe z=0 ----
const hemiVertices = [[2, 0, 0], [-2, 0, 0]];
const hemiEdges = [
  { v0: 0, v1: 1, curve: { type: 'circle', c: [0, 0, 0], a: [0, 0, 1], R: 2, x: [1, 0, 0] } },
  { v0: 1, v1: 0, curve: { type: 'circle', c: [0, 0, 0], a: [0, 0, 1], R: 2, x: [-1, 0, 0] } },
];
const hemiFaces = [
  {   // Kugel: Achse [1,0,0] (Kugelachse ist beliebig), Normale nach außen
    surf: { type: 'sphere', c: [0, 0, 0], R: 2, axis: [1, 0, 0] }, sameSense: true,
    loops: [{ outer: true, uses: [{ edge: 0, fwd: true }, { edge: 1, fwd: true }] }],
  },
  {   // Scheibe z=0: Flächennormale +z, same_sense .F. → effektive Normale −z (unten)
    surf: { type: 'plane', o: [0, 0, 0], n: [0, 0, 1] }, sameSense: false,
    loops: [{ outer: true, uses: [{ edge: 0, fwd: false }, { edge: 1, fwd: false }] }],
  },
];
const hemiBrep = { vertices: hemiVertices, edges: hemiEdges, faces: hemiFaces };

test('c) Halbkugel R=2 auf Scheibe: nur "unsupported" erlaubt', () => {
  const { step, counts } = write('hemisphere', hemiBrep);
  const { violations, stats } = checkStepStrict(step);
  const kurz = violations.map((v) => `${v.kind}: ${v.msg}`);
  // Solange step-strict die Kugel nicht kennt, wird die Kugelfläche übersprungen ('unsupported').
  // Folge davon: ihre Randkanten gelten als nur 1× genutzt ('edge-use') und die Schale zerfällt
  // in zwei Teile ('shell-connected') — beides Merkmale der fehlenden Kugel-Unterstützung, keine
  // Fehler der Datei. Mit Kugel-Unterstützung (wird parallel ergänzt) muss die Datei sauber sein.
  const kugelUnbekannt = violations.some((v) => v.kind === 'unsupported' && /SPHERICAL/i.test(v.msg));
  if (kugelUnbekannt) {
    const erlaubt = new Set(['unsupported', 'edge-use', 'shell-connected']);
    assert.deepEqual(violations.filter((v) => !erlaubt.has(v.kind)).map((v) => `${v.kind}: ${v.msg}`), [],
      'Verstöße an der Halbkugel');
  } else {
    assert.deepEqual(kurz, [], 'Verstöße an der Halbkugel');
  }
  assert.deepEqual(counts, {
    faces: 2, edges: 2, vertices: 2,
    surfaces: { PLANE: 1, SPHERICAL_SURFACE: 1 },
    curves: { CIRCLE: 2 },
  });
  assert.equal(countEntities(step, 'SPHERICAL_SURFACE'), 1);
  assert.equal(countEntities(step, 'PLANE'), 1);
  assert.equal(stats.faces, 2);
});

// ---- (d) Würfel mit einer B-Spline-Kante ----
const bsplineBrep = {
  vertices: cubeVertices,
  edges: cubeEdges.map((e, i) => (i === 8
    ? { v0: e.v0, v1: e.v1, curve: { type: 'bspline', degree: 1, ctrl: [cubeVertices[e.v0], cubeVertices[e.v1]], knots: [0, 1], mults: [2, 2] } }
    : e)),
  faces: cubeFaces,
};

test('d) Würfel mit B-Spline-Kante: streng gültig', () => {
  const { step, counts } = write('bspline', bsplineBrep);
  const { violations, stats } = checkStepStrict(step);
  assert.deepEqual(violations.map((v) => `${v.kind}: ${v.msg}`), [], 'Verstöße im B-Spline-Würfel');
  assert.equal(stats.faces, 6);
  assert.deepEqual(counts, {
    faces: 6, edges: 12, vertices: 8,
    surfaces: { PLANE: 6 },
    curves: { LINE: 11, B_SPLINE_CURVE_WITH_KNOTS: 1 },
  });
  assert.equal(countEntities(step, 'B_SPLINE_CURVE_WITH_KNOTS'), 1);
  assert.equal(countEntities(step, 'LINE'), 11);
  assert.equal(countEntities(step, 'EDGE_CURVE'), 12);
});

process.exit(failed ? 1 : 0);

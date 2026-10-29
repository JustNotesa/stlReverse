// ─────────────────────────────────────────────────────────────────────────────
// tests/freeform/bstep.test.mjs — B-Spline-FLÄCHEN im Freiform-Pfad
//
// Von Hand gebaute Körper mit B_SPLINE_SURFACE_WITH_KNOTS als Deckfläche gehen durch
// den strengen STEP-Prüfer (tests/step-strict.mjs):
//   a) Würfel 10 mm (gedreht + verschoben), Deckfläche = bilinearer Patch über die 4
//      oberen Ecken, auf Grad 3 gehoben mit einem inneren Knoten 0,5 je Richtung
//      (5×5 Stützpunkte, alle in der Deckebene) — die übrigen 5 Flächen PLANE.
//   b) „Kissen-Würfel": gleicher Würfel, Deckfläche = bikubischer Patch 7×7; die Rand-
//      Zeilen/-Spalten liegen genau auf den 4 geraden Deckkanten (gleichmäßig verteilt),
//      die inneren Stützpunkte stehen 2 mm über der Deckebene (nach außen) → das Volumen
//      muss größer sein als das des Würfels.
//   c) Negativtest: eine obere Ecke um 1e-4 mm verschoben → der Prüfer muss einen
//      Verstoß „Rand neben der Fläche" melden.
//   d) sameSense der Deckfläche umgedreht → Orientierungs-Verstoß.
//
// Ausführen:  .dev/test-stl.sh freeform
// ─────────────────────────────────────────────────────────────────────────────
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { writeFreeformStep } from '../../freeform-step.js';
import { checkStepStrict, parseStep } from '../step-strict.mjs';

// ---- Vektoren / Rotation (beliebige Drehung + Verschiebung) ----
const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const norm3 = (a) => { const l = Math.hypot(a[0], a[1], a[2]); return a.map((x) => x / l); };
// Rodrigues: v → v·cosθ + (a×v)·sinθ + a·(a·v)·(1−cosθ)
const rotAround = (ax, ang) => {
  const a = norm3(ax), c = Math.cos(ang), s = Math.sin(ang), C = 1 - c;
  return (v) => {
    const cr = [a[1] * v[2] - a[2] * v[1], a[2] * v[0] - a[0] * v[2], a[0] * v[1] - a[1] * v[0]];
    const d = a[0] * v[0] + a[1] * v[1] + a[2] * v[2];
    return [v[0] * c + cr[0] * s + a[0] * d * C, v[1] * c + cr[1] * s + a[1] * d * C, v[2] * c + cr[2] * s + a[2] * d * C];
  };
};
const ROT = rotAround([0.31, -0.72, 0.63], 0.83);
const TRANS = [137.5, -88.25, 42.125];
const X = (p) => { const r = ROT(p); return [r[0] + TRANS[0], r[1] + TRANS[1], r[2] + TRANS[2]]; };   // Punkt
const XD = (v) => ROT(v);                                                                  // Richtung

// ---- Würfel 10 mm im lokalen Koordinatensystem ----
const LOCAL = [
  [0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0],
  [0, 0, 10], [10, 0, 10], [10, 10, 10], [0, 10, 10],
];
// Kanten (v0 → v1); Index = Kanten-Index der Faces unten
const EDGE_PAIRS = [
  [0, 1], [0, 3], [1, 2], [2, 3], [0, 4], [1, 5], [3, 7], [2, 6], [4, 5], [4, 7], [5, 6], [6, 7],
];

// ---- B-Spline-Stützpunktnetz der Deckfläche ----
// ctrl[i][j]: i = u-Index (Richtung E1 = Ecke 4 → 5), j = v-Index (E2 = Ecke 5 → 6).
// Die Randzeilen/-Spalten liegen auf den Deckkanten, die inneren Stützpunkte stehen
// `raise` mm über der Deckebene (Richtung = äußere Deckflächennormale).
const deckCtrl = (nu, nv, raise) => {
  const c = [];
  for (let i = 0; i < nu; i++) {
    const row = [];
    for (let j = 0; j < nv; j++) {
      const p = X([10 * i / (nu - 1), 10 * j / (nv - 1), 10]);
      const inn = (i > 0 && i < nu - 1 && j > 0 && j < nv - 1);
      if (inn && raise) { const n = XD([0, 0, 1]); row.push([p[0] + n[0] * raise, p[1] + n[1] * raise, p[2] + n[2] * raise]); }
      else row.push(p);
    }
    c.push(row);
  }
  return c;
};

// ---- Würfel-B-Rep mit B-Spline-Deckfläche ----
// topSurf: { ctrl, du, dv, knotsU, multsU, knotsV, multsV } | null (null → PLANE-Deckfläche)
// move:    { index, delta } — Ecke verschieben (Negativtest)
const buildCube = (topSurf, move = null) => {
  const V = LOCAL.map(X);
  if (move) V[move.index] = [V[move.index][0] + move.delta[0], V[move.index][1] + move.delta[1], V[move.index][2] + move.delta[2]];
  const dir = (a, b) => norm3(sub3(V[b], V[a]));
  const edges = EDGE_PAIRS.map(([a, b]) => ({ v0: a, v1: b, curve: { type: 'line', p: V[a], d: dir(a, b) } }));
  const plane = (o, n) => ({ type: 'plane', o: X(o), n: XD(n) });
  const faces = [
    { surf: plane([0, 0, 0], [0, 0, -1]), sameSense: true, loops: [{ outer: true, uses: [{ edge: 1, fwd: true }, { edge: 3, fwd: false }, { edge: 2, fwd: false }, { edge: 0, fwd: false }] }] },
    { surf: topSurf ? { type: 'bspline_surface', ...topSurf } : plane([0, 0, 10], [0, 0, 1]), sameSense: true, loops: [{ outer: true, uses: [{ edge: 8, fwd: true }, { edge: 10, fwd: true }, { edge: 11, fwd: true }, { edge: 9, fwd: false }] }] },
    { surf: plane([0, 0, 0], [0, -1, 0]), sameSense: true, loops: [{ outer: true, uses: [{ edge: 0, fwd: true }, { edge: 5, fwd: true }, { edge: 8, fwd: false }, { edge: 4, fwd: false }] }] },
    { surf: plane([0, 10, 0], [0, 1, 0]), sameSense: true, loops: [{ outer: true, uses: [{ edge: 6, fwd: true }, { edge: 11, fwd: false }, { edge: 7, fwd: false }, { edge: 3, fwd: true }] }] },
    { surf: plane([0, 0, 0], [-1, 0, 0]), sameSense: true, loops: [{ outer: true, uses: [{ edge: 4, fwd: true }, { edge: 9, fwd: true }, { edge: 6, fwd: false }, { edge: 1, fwd: false }] }] },
    { surf: plane([10, 0, 0], [1, 0, 0]), sameSense: true, loops: [{ outer: true, uses: [{ edge: 2, fwd: true }, { edge: 7, fwd: true }, { edge: 10, fwd: false }, { edge: 5, fwd: false }] }] },
  ];
  return { vertices: V, edges, faces };
};

// STEP-Text → B-Spline-Flächen-Entitäten (für die Rückprüfung des Stützpunktnetzes)
const bsplineSurfacesOf = (step) => {
  const ents = parseStep(step);
  const out = [];
  for (const e of ents.values()) {
    if (e.type !== 'B_SPLINE_SURFACE_WITH_KNOTS') continue;
    const net = e.args[3].map((row) => row.map((q) => {
      const p = ents.get(q.ref).args[1];
      return [p[0], p[1], p[2]];
    }));
    out.push({
      du: e.args[1], dv: e.args[2], net,
      multsU: e.args[8], multsV: e.args[9], knotsU: e.args[10], knotsV: e.args[11],
    });
  }
  return out;
};

// ---- (a) Deckfläche = bilinearer Patch über die 4 oberen Ecken, Grad 3, ein innerer
//      Knoten 0,5 je Richtung (5×5 Stützpunkte, alle in der Deckebene) ----
const flatDeck = {
  ctrl: deckCtrl(5, 5, 0),
  du: 3, dv: 3,
  knotsU: [0, 0.5, 1], multsU: [4, 1, 4],
  knotsV: [0, 0.5, 1], multsV: [4, 1, 4],
};
// ---- (b) Deckfläche = bikubischer Patch 7×7: Rand auf den Deckkanten, innere Stützpunkte
//      2 mm über der Deckebene ("Kissen") ----
const pillowDeck = {
  ctrl: deckCtrl(7, 7, 2),
  du: 3, dv: 3,
  knotsU: [0, 0.25, 0.5, 0.75, 1], multsU: [4, 1, 1, 1, 4],
  knotsV: [0, 0.25, 0.5, 0.75, 1], multsV: [4, 1, 1, 1, 4],
};

const write = (brep, name) => writeFreeformStep(brep, { timestamp: '2026-10-29T00:00:00.000Z', fileName: name + '.step' });

test('a) Würfel mit ebener B-Spline-Deckfläche: streng gültig, Volumen = 1000 mm³', () => {
  const { step, counts } = write(buildCube(flatDeck), 'bstep-cube');
  assert.deepEqual(counts.surfaces, { PLANE: 5, B_SPLINE_SURFACE_WITH_KNOTS: 1 });
  assert.deepEqual(counts.curves, { LINE: 12 });
  const { violations, stats, volumes } = checkStepStrict(step);
  assert.deepEqual(violations.map((v) => `${v.kind}: ${v.msg}`), [], 'Verstöße im B-Spline-Würfel');
  assert.equal(stats.faces, 6);
  assert.equal(stats.volumeSkipped, 0, 'Volumen der Schale wurde übersprungen');
  // Die Randpunkte liegen exakt auf der B-Spline-Fläche → der Abstand muss ~0 sein
  // (nächstgelegener Flächenpunkt mit ~1e-9 mm Genauigkeit).
  assert.ok(stats.maxVertexSurface < 1e-9, `Rand bis ${stats.maxVertexSurface.toExponential(2)} mm neben der Fläche`);
  assert.equal(volumes.length, 1);
  assert.ok(Math.abs(volumes[0].V - 1000) < 0.5, `Volumen ${volumes[0].V} mm³ statt 1000 mm³`);
});

test('a) STEP enthält B_SPLINE_SURFACE_WITH_KNOTS mit Grad 3/3 und demselben Stützpunktnetz', () => {
  const { step } = write(buildCube(flatDeck), 'bstep-cube');
  const surfs = bsplineSurfacesOf(step);
  assert.equal(surfs.length, 1, 'keine B_SPLINE_SURFACE_WITH_KNOTS in der Datei');
  assert.equal(surfs[0].du, 3);
  assert.equal(surfs[0].dv, 3);
  assert.deepEqual(surfs[0].multsU, [4, 1, 4]);
  assert.deepEqual(surfs[0].multsV, [4, 1, 4]);
  assert.deepEqual(surfs[0].knotsU, [0, 0.5, 1]);
  assert.deepEqual(surfs[0].knotsV, [0, 0.5, 1]);
  assert.equal(surfs[0].net.length, flatDeck.ctrl.length);
  assert.equal(surfs[0].net[0].length, flatDeck.ctrl[0].length);
  for (let i = 0; i < flatDeck.ctrl.length; i++) {
    for (let j = 0; j < flatDeck.ctrl[i].length; j++) {
      for (let k = 0; k < 3; k++) {
        assert.ok(Math.abs(surfs[0].net[i][j][k] - flatDeck.ctrl[i][j][k]) < 1e-9,
          `Stützpunkt ${i}/${j}/${k}: ${surfs[0].net[i][j][k]} statt ${flatDeck.ctrl[i][j][k]}`);
      }
    }
  }
});

test('b) Kissen-Würfel: streng gültig, Volumen größer als das des Würfels', () => {
  const { step, counts } = write(buildCube(pillowDeck), 'bstep-pillow');
  // für die OCP-Prüfung (tests/occt-check.py) ablegen
  mkdirSync(new URL('./out/', import.meta.url), { recursive: true });
  writeFileSync(new URL('./out/bstep-pillow.step', import.meta.url), step);
  assert.deepEqual(counts.surfaces, { PLANE: 5, B_SPLINE_SURFACE_WITH_KNOTS: 1 });
  const { violations, stats, volumes } = checkStepStrict(step);
  assert.deepEqual(violations.map((v) => `${v.kind}: ${v.msg}`), [], 'Verstöße im Kissen-Würfel');
  assert.equal(stats.volumeSkipped, 0, 'Volumen der Schale wurde übersprungen');
  assert.ok(stats.maxVertexSurface < 1e-9, `Rand bis ${stats.maxVertexSurface.toExponential(2)} mm neben der Fläche`);
  assert.equal(volumes.length, 1);
  assert.ok(volumes[0].V > 1000, `Volumen ${volumes[0].V} mm³ ist nicht größer als das Würfelvolumen (1000 mm³)`);
});

test('c) um 1e-4 mm verschobene obere Ecke: Verstoß "Rand neben der Fläche"', () => {
  // Die Datei-Toleranz des Prüfers ist TOL = 1e-4 mm — eine Verschiebung von genau 1e-4 mm
  // liegt damit auf der Schwelle. Strikte CAD-Kerne rechnen mit ~1e-6 mm, deshalb wird hier
  // mit tol = 1e-6 geprüft: die Abweichung muss dann auffallen.
  const n = XD([0, 0, 1]);                       // äußere Deckflächennormale
  const brep = buildCube(pillowDeck, { index: 4, delta: [n[0] * 1e-4, n[1] * 1e-4, n[2] * 1e-4] });
  const { step } = write(brep, 'bstep-verschoben');
  const { violations } = checkStepStrict(step, { tol: 1e-6 });
  const vs = violations.filter((v) => v.kind === 'vertex-surface');
  assert.ok(vs.length >= 1, `kein Verstoß "Rand neben der Fläche":\n    ${violations.map((v) => v.kind + ': ' + v.msg).join('\n    ')}`);
  assert.ok(vs.some((v) => /bspline_surface/.test(v.msg)),
    `die B-Spline-Fläche wurde nicht beanstandet:\n    ${vs.map((v) => v.msg).join('\n    ')}`);
  // die gemeldete Abweichung entspricht der Verschiebung (1e-4 mm)
  assert.ok(vs.some((v) => (v.d ?? 0) > 1e-5 && (v.d ?? 0) < 1e-3),
    `Abweichung unerwartet: ${vs.map((v) => v.d).join(', ')}`);
});

test('d) sameSense der Deckfläche umgedreht: Orientierungs-Verstoß', () => {
  // Der Rand der Fläche bleibt unverändert; die effektive Normale dreht sich um → der Rand
  // läuft jetzt im Uhrzeigersinn um sie (im Parameterraum CW). Der Prüfer meldet das als
  // orient-curved (Parameterfläche gegen same_sense).
  const brep = buildCube(pillowDeck);
  brep.faces[1].sameSense = false;
  const { step } = write(brep, 'bstep-verdreht');
  const { violations } = checkStepStrict(step);
  assert.ok(violations.some((v) => v.kind === 'orient-curved' && /bspline_surface/.test(v.msg)),
    `kein Orientierungs-Verstoß an der B-Spline-Fläche:\n    ${violations.map((v) => v.kind + ': ' + v.msg).join('\n    ')}`);
});

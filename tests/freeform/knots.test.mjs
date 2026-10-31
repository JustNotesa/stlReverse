// ─────────────────────────────────────────────────────────────────────────────
// tests/freeform/knots.test.mjs — B-Spline-Knoten: zusammenführen, schreiben, prüfen
//
// Hintergrund: ISO 10303-42 verlangt im B-Spline-Knotenvektor STRENG steigende,
// verschiedene Knotenwerte. Drei Stellen konnten das verletzen:
//   1) makeCompatible vereinigte die Knotenvektoren zweier Coons-Seiten nur mit
//      absoluter Toleranz (1e-12) — Knoten, die 1e-10 auseinanderlagen, blieben
//      getrennt und standen im STEP als zwei fast gleiche Werte.
//   2) Der STEP-Schreiber schrieb Knoten mit 9 Nachkommastellen — verschiedene
//      Knoten konnten auf denselben Text fallen.
//   3) Der strenge Prüfer (tests/step-strict.mjs) prüfte die Knotenvektoren gar nicht.
//
// Ausführen:  .dev/test-stl.sh freeform
// ─────────────────────────────────────────────────────────────────────────────
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCompatible, evalCurve } from '../../freeform-nurbs.js';
import { writeFreeformStep } from '../../freeform-step.js';
import { checkStepStrict } from '../step-strict.mjs';

const dev = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// ── 1) makeCompatible: nah beieinander liegende Knoten werden EIN Knoten ─────

test('makeCompatible: innere Knoten 1e-10 auseinander → ein streng steigender Vektor', () => {
  const mk = (k1) => ({
    type: 'bspline', degree: 3,
    ctrl: [[0, 0, 0], [2, 1, 0], [4, -1, 0], [6, 2, 0], [8, 0, 0]],
    knots: [0, k1, 1], mults: [4, 1, 4],
  });
  const A = mk(0.4);
  const B = mk(0.4 + 1e-10);
  const res = makeCompatible(A, B);
  assert.ok(res && res.length === 2, 'makeCompatible liefert zwei Kurven');
  const [a, b] = res;
  // beide Kurven: derselbe Knotenvektor, streng steigend, Mindestabstand 1e-9
  assert.deepEqual(a.knots, b.knots, 'beide Kurven haben denselben Knotenvektor');
  assert.deepEqual(a.mults, b.mults, 'beide Kurven haben dieselben Vielfachheiten');
  for (const c of [a, b]) {
    assert.ok(c.knots.length >= 2, 'Knotenvektor hat mindestens zwei Werte');
    for (let i = 1; i < c.knots.length; i++) {
      assert.ok(c.knots[i] > c.knots[i - 1], `Knoten ${i} ist nicht größer als ${i - 1}`);
      assert.ok(c.knots[i] - c.knots[i - 1] >= 1e-9, `Knotenabstand ${i}: ${c.knots[i] - c.knots[i - 1]}`);
    }
    // innerer Knoten: Vielfachheit ≤ Grad, Summe = Stützpunkte + Grad + 1
    let sum = 0;
    for (const m of c.mults) sum += m;
    assert.equal(sum, c.ctrl.length + c.degree + 1, 'Summe der Vielfachheiten');
    for (let i = 1; i < c.mults.length - 1; i++) assert.ok(c.mults[i] <= c.degree, 'innere Vielfachheit ≤ Grad');
  }
  // die Geometrie bleibt erhalten (das Snappen bewegt den Knoten nur um ≤ 1e-9)
  for (let i = 0; i <= 50; i++) {
    const u = i / 50;
    assert.ok(dev(evalCurve(a, u), evalCurve(A, u)) < 1e-6, `Geometrie A bei u=${u}`);
    assert.ok(dev(evalCurve(b, u), evalCurve(B, u)) < 1e-6, `Geometrie B bei u=${u}`);
  }
});

// ── 2) STEP-Schreiber: Knotenwerte mit voller Präzision, keine Doppelknoten ──

//_win: kleines B-Rep mit einer B-Spline-Fläche (Ebene als Tensorprodukt)
const surfaceBrep = (knotsU, knotsV) => {
  const N = 6;                                   // 6×6 Stützpunkte → Grad 3, Vielfachheiten 4,1,1,4
  const ctrl = [];
  for (let i = 0; i < N; i++) {
    const row = [];
    for (let j = 0; j < N; j++) row.push([(i / (N - 1)) * 10, (j / (N - 1)) * 10, 0]);
    ctrl.push(row);
  }
  const vertices = [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0]];
  const dir = (a, b) => {
    const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const l = Math.hypot(...d);
    return [d[0] / l, d[1] / l, d[2] / l];
  };
  const pairs = [[0, 1], [1, 2], [2, 3], [3, 0]];
  const edges = pairs.map(([a, b]) => ({ v0: a, v1: b, curve: { type: 'line', p: vertices[a], d: dir(vertices[a], vertices[b]) } }));
  const faces = [{
    surf: { type: 'bspline_surface', du: 3, dv: 3, ctrl, knotsU, multsU: [4, 1, 1, 4], knotsV, multsV: [4, 1, 1, 4] },
    sameSense: true,
    loops: [{ outer: true, uses: [{ edge: 0, fwd: true }, { edge: 1, fwd: true }, { edge: 2, fwd: true }, { edge: 3, fwd: true }] }],
  }];
  return { vertices, edges, faces };
};

// Knotenliste einer B_SPLINE_SURFACE_WITH_KNOTS aus dem STEP-Text holen
const surfEntity = (step) => step.match(/#\d+=B_SPLINE_SURFACE_WITH_KNOTS\([^;]*\);/)[0];
const uKnotList = (entity) => {
  // ohne Verschachtelung: die Stützpunkt-Zeilen und danach die vier Listen
  // (Vielfachheiten u, Vielfachheiten v, Knoten u, Knoten v) — die u-Knoten sind
  // die vorletzte Liste.
  const lists = entity.match(/\([^()]*\)/g);
  return lists[lists.length - 2];
};

test('writeFreeformStep: fast gleiche Knotenwerte → verschiedene STEP-Werte (oder Ausnahme)', () => {
  const knotsU = [0, 0.1234567891234, 0.1234567891239, 1];
  const knotsV = [0, 0.25, 0.75, 1];
  const brep = surfaceBrep(knotsU, knotsV);
  let step = null;
  let err = null;
  try {
    step = writeFreeformStep(brep, { timestamp: '2026-10-31T00:00:00.000Z', fileName: 'knots.step' }).step;
  } catch (e) {
    err = e;
  }
  if (err) {
    // zulässiger Ausweg: der Schreiber bricht ab (der Aufrufer fällt auf den alten Weg zurück)
    assert.equal(err.message, 'knot vector not strictly increasing', `unerwartete Ausnahme: ${err.message}`);
    return;
  }
  const ku = uKnotList(surfEntity(step));
  const vals = ku.slice(1, -1).split(',');
  assert.ok(vals.length >= 2, 'Knotenliste gefunden');
  for (let i = 1; i < vals.length; i++) {
    assert.notEqual(vals[i], vals[i - 1], `Knoten ${i} und ${i - 1} sind derselbe Text: ${vals[i]}`);
    assert.ok(+vals[i] > +vals[i - 1], `Knoten ${i} ist nicht größer als ${i - 1}: ${vals[i]} vs ${vals[i - 1]}`);
  }
});

// ── 3) Sicherheitsnetz im Schreiber: unzulässige Vielfachheit → Ausnahme ────

test('writeFreeformStep: Doppelknoten, dessen Vielfachheit nicht erlaubt ist → Ausnahme', () => {
  // Grad 1: ein innerer Knoten darf höchstens Vielfachheit 1 haben — zwei
  // gleiche Knotenwerte (Vielfachheit 1 + 1) dürfen nicht zusammengefasst werden.
  const N = 4;
  const ctrl = [];
  for (let i = 0; i < N; i++) {
    const row = [];
    for (let j = 0; j < N; j++) row.push([(i / (N - 1)) * 10, (j / (N - 1)) * 10, 0]);
    ctrl.push(row);
  }
  const brep = {
    vertices: [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0]],
    edges: [
      { v0: 0, v1: 1, curve: { type: 'line', p: [0, 0, 0], d: [1, 0, 0] } },
      { v0: 1, v1: 2, curve: { type: 'line', p: [10, 0, 0], d: [0, 1, 0] } },
      { v0: 2, v1: 3, curve: { type: 'line', p: [10, 10, 0], d: [-1, 0, 0] } },
      { v0: 3, v1: 0, curve: { type: 'line', p: [0, 10, 0], d: [0, -1, 0] } },
    ],
    faces: [{
      surf: {
        type: 'bspline_surface', du: 1, dv: 1, ctrl,
        knotsU: [0, 0.5, 0.5, 1], multsU: [2, 1, 1, 2],
        knotsV: [0, 1], multsV: [2, 2],
      },
      sameSense: true,
      loops: [{ outer: true, uses: [{ edge: 0, fwd: true }, { edge: 1, fwd: true }, { edge: 2, fwd: true }, { edge: 3, fwd: true }] }],
    }],
  };
  assert.throws(() => writeFreeformStep(brep, { timestamp: '2026-10-31T00:00:00.000Z', fileName: 'knots.step' }),
    /knot vector not strictly increasing/, 'der Schreiber bricht mit Ausnahme ab');
});

// ── 4) strenger Prüfer: Knotenverstöße melden ───────────────────────────────

test('checkStepStrict: doppelter Knotenwert → Verstoß "bspline-knots"', () => {
  const knotsU = [0, 0.25, 0.5, 1];
  const knotsV = [0, 0.125, 0.75, 1];
  const step = writeFreeformStep(surfaceBrep(knotsU, knotsV), {
    timestamp: '2026-10-31T00:00:00.000Z', fileName: 'knots.step',
  }).step;
  // gültige Datei: keine Knotenverstöße
  const ok = checkStepStrict(step);
  assert.equal(ok.violations.filter((v) => v.kind === 'bspline-knots').length, 0,
    `unerwartete Knotenverstöße: ${JSON.stringify(ok.violations.filter((v) => v.kind === 'bspline-knots'))}`);
  // dieselbe Datei mit doppeltem Knotenwert (nur die Knotenliste verändert)
  const ent = surfEntity(step);
  const ku = uKnotList(ent);
  assert.ok(ent.includes(ku), 'u-Knotenliste im Entity gefunden');
  const kaputt = step.replace(ku, '(0.,0.25,0.25,1.)');
  assert.notEqual(kaputt, step, 'Knotenliste wurde verändert');
  const res = checkStepStrict(kaputt);
  const knotVerstoesse = res.violations.filter((v) => v.kind === 'bspline-knots');
  assert.ok(knotVerstoesse.length > 0, 'Doppelknoten wird als "bspline-knots" gemeldet');
  assert.match(knotVerstoesse[0].msg, /nicht größer|Knotenwert/, `Meldung: ${knotVerstoesse[0].msg}`);
});

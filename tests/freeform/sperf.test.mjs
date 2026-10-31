// ─────────────────────────────────────────────────────────────────────────────
// tests/freeform/sperf.test.mjs — Tempo des strengen STEP-Prüfers (B-Spline-Flächen)
//
// Der strenge Prüfer (tests/step-strict.mjs) rechnet für jede B-Spline-Fläche den
// nächstgelegenen Flächenpunkt (Startgitter + projiziertes Gauss-Newton). Ohne caching
// wurde das Startgitter je ABFRAGE neu berechnet — bei großen Stützpunktnetzen
// (Blend-Patches) dominierte dieser Block die Laufzeit.
//
//   a) blend-rundquader-zylinder.step (26 Flächen, 12 B-Spline-Flächen, ~840 kB):
//      Ziel < 1.5 s. Vergleich gegen die alte Fassung (git HEAD) im selben Lauf.
//   b) Skalierung: ein B-Spline-Quader mit wachsendem Stützpunktnetz — die Zeit darf
//      nicht quadratisch wachsen (linear in Netzgröße × log Netz).
//
// Ausführen:  .dev/test-stl.sh freeform
// ─────────────────────────────────────────────────────────────────────────────
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync, appendFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { writeFreeformStep } from '../../freeform-step.js';
import { checkStepStrict } from '../step-strict.mjs';

const BLEND = join('tests/freeform/out', 'blend-rundquader-zylinder.step');
// Logdatei: die freiform-Suite läuft in den 900-s-Rahmen des Test-Runners (der Aufbau
// der Blend-Bodies dominiert) — die Messwerte stehen deshalb zusätzlich hier.
const LOG = join('tests/freeform/out', 'sperf.log');
const log = (s) => { try { mkdirSync(join('tests/freeform/out'), { recursive: true }); appendFileSync(LOG, s + '\n'); } catch (e) { /* nur Messwert */ } };
try { mkdirSync(join('tests/freeform/out'), { recursive: true }); writeFileSync(LOG, ''); } catch (e) { /* nur Messwert */ }

// ---- warten, bis blend.test.mjs die Datei geschrieben hat (die Testdateien laufen
//      parallel — die Datei wird von dort erzeugt) ----
const waitForFile = async (file, ms) => {
  const t0 = Date.now();
  let last = -1, stable = 0;
  for (;;) {
    if (existsSync(file)) {
      const s = statSync(file).size;
      if (s > 0 && s === last) { if (++stable >= 2) return true; } else stable = 0;
      last = s;
    }
    if (Date.now() - t0 > ms) return false;
    await new Promise((r) => setTimeout(r, 200));
  }
};

// ---- alte Fassung (git HEAD, also der Stand vor dieser Optimierung) zum Vergleich
//      laden (data:-URL — keine Datei, kein Import nebenbei) ----
const loadOld = async () => {
  try {
    const src = execFileSync('git', ['show', 'HEAD:tests/step-strict.mjs'], {
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, cwd: process.cwd(),
    });
    const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
    return mod.checkStepStrict;
  } catch (e) { return null; }
};

// ---- Quader mit B-Spline-Deckfläche (für die Skalierung) ----
const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const norm3 = (a) => { const l = Math.hypot(a[0], a[1], a[2]); return a.map((x) => x / l); };
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
const X = (p) => { const r = ROT(p); return [r[0] + TRANS[0], r[1] + TRANS[1], r[2] + TRANS[2]]; };
const XD = (v) => ROT(v);

const LOCAL = [
  [0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0],
  [0, 0, 10], [10, 0, 10], [10, 10, 10], [0, 10, 10],
];
const EDGE_PAIRS = [
  [0, 1], [0, 3], [1, 2], [2, 3], [0, 4], [1, 5], [3, 7], [2, 6], [4, 5], [4, 7], [5, 6], [6, 7],
];
// Deckfläche: n×n Stützpunkte, Grad 3, die inneren 2 mm über der Deckebene („Kissen“)
const pillowDeck = (n) => {
  const knots = [];
  for (let i = 0; i < n - 2; i++) knots.push(i / (n - 2));
  const mults = [4, ...Array(n - 4).fill(1), 4];
  const nrm = XD([0, 0, 1]);
  const ctrl = [];
  for (let i = 0; i < n; i++) {
    const row = [];
    for (let j = 0; j < n; j++) {
      const p = X([10 * i / (n - 1), 10 * j / (n - 1), 10]);
      const inn = (i > 0 && i < n - 1 && j > 0 && j < n - 1);
      row.push(inn ? [p[0] + nrm[0] * 2, p[1] + nrm[1] * 2, p[2] + nrm[2] * 2] : p);
    }
    ctrl.push(row);
  }
  return { ctrl, du: 3, dv: 3, knotsU: knots, multsU: mults, knotsV: knots, multsV: mults };
};
const buildCube = (topSurf, move = null) => {
  const V = LOCAL.map(X);
  if (move) V[move.index] = V[move.index].map((x, k) => x + move.delta[k]);
  const dir = (a, b) => norm3(sub3(V[b], V[a]));
  const edges = EDGE_PAIRS.map(([a, b]) => ({ v0: a, v1: b, curve: { type: 'line', p: V[a], d: dir(a, b) } }));
  const plane = (o, n) => ({ type: 'plane', o: X(o), n: XD(n) });
  return {
    vertices: V, edges,
    faces: [
      { surf: plane([0, 0, 0], [0, 0, -1]), sameSense: true, loops: [{ outer: true, uses: [{ edge: 1, fwd: true }, { edge: 3, fwd: false }, { edge: 2, fwd: false }, { edge: 0, fwd: false }] }] },
      { surf: { type: 'bspline_surface', ...topSurf }, sameSense: true, loops: [{ outer: true, uses: [{ edge: 8, fwd: true }, { edge: 10, fwd: true }, { edge: 11, fwd: true }, { edge: 9, fwd: false }] }] },
      { surf: plane([0, 0, 0], [0, -1, 0]), sameSense: true, loops: [{ outer: true, uses: [{ edge: 0, fwd: true }, { edge: 5, fwd: true }, { edge: 8, fwd: false }, { edge: 4, fwd: false }] }] },
      { surf: plane([0, 10, 0], [0, 1, 0]), sameSense: true, loops: [{ outer: true, uses: [{ edge: 6, fwd: true }, { edge: 11, fwd: false }, { edge: 7, fwd: false }, { edge: 3, fwd: true }] }] },
      { surf: plane([0, 0, 0], [-1, 0, 0]), sameSense: true, loops: [{ outer: true, uses: [{ edge: 4, fwd: true }, { edge: 9, fwd: true }, { edge: 6, fwd: false }, { edge: 1, fwd: false }] }] },
      { surf: plane([10, 0, 0], [1, 0, 0]), sameSense: true, loops: [{ outer: true, uses: [{ edge: 2, fwd: true }, { edge: 7, fwd: true }, { edge: 10, fwd: false }, { edge: 5, fwd: false }] }] },
    ],
  };
};

// ── a) Blend-Datei: Zeit (alt gegen neu) ────────────────────────────────────
test('a) blend-rundquader-zylinder.step: streng gültig und < 1.5 s', async () => {
  assert.ok(await waitForFile(BLEND, 600000), `STEP-Datei ${BLEND} wurde nicht erzeugt (blend.test.mjs?)`);
  const text = readFileSync(BLEND, 'utf8');

  // dreimal messen und das Beste nehmen (die Testdateien laufen parallel — die
  // Messung soll nicht an der Last der anderen Dateien hängen)
  let res = null, dtNeu = Infinity;
  for (let k = 0; k < 3; k++) {
    const t0 = performance.now();
    res = checkStepStrict(text);
    const dt = performance.now() - t0;
    if (dt < dtNeu) dtNeu = dt;
  }
  const bs = res.stats.bspline || {};
  const zeile = `neu ${dtNeu.toFixed(0)} ms · B-Spline-Flächen ${bs.faces}`
    + ` · Gitter ${bs.grid} · Abfragen ${bs.solve} · Newton ${bs.refine} (warm ${bs.warm})`
    + ` · Schritte ${bs.it} (voll ${bs.full}/halb ${bs.half}/grad ${bs.grad})`
    + ` · Auswertungen ${bs.at}/${bs.all} · Flächen ${res.stats.faces} · Verstöße ${res.violations.length}`;
  console.log(`     sperf: ${zeile}`);
  log(`a) blend-rundquader-zylinder.step (${text.length} Zeichen): ${zeile}`);

  const old = await loadOld();
  if (old) {
    const t1 = performance.now();
    const ores = old(text);
    const dtAlt = performance.now() - t1;
    console.log(`     sperf: alt ${dtAlt.toFixed(0)} ms → ${(dtAlt / Math.max(dtNeu, 1)).toFixed(1)}× schneller`);
    log(`a) alt ${dtAlt.toFixed(0)} ms → ${(dtAlt / Math.max(dtNeu, 1)).toFixed(1)}× schneller ·`
      + ` alt-Verstöße ${ores.violations.length} · alt maxRand ${ores.stats.maxVertexSurface.toExponential(2)} mm`
      + ` · neu maxRand ${res.stats.maxVertexSurface.toExponential(2)} mm`);
    // gleiches Ergebnis (keine Verstöße in beiden, gleiche Randgenauigkeit)
    assert.equal(ores.violations.length, res.violations.length, 'alte und neue Fassung melden verschiedene Verstöße');
    assert.ok(res.stats.maxVertexSurface <= ores.stats.maxVertexSurface * 1.5 + 1e-9,
      `Rand-Abweichung ${res.stats.maxVertexSurface.toExponential(2)} mm ist schlechter als alt ${ores.stats.maxVertexSurface.toExponential(2)} mm`);
  }
  assert.equal(res.violations.length, 0, `Verstöße: ${res.violations.slice(0, 3).map((v) => v.kind + ': ' + v.msg).join(' | ')}`);
  assert.ok(res.stats.maxVertexSurface < 1e-5, `Rand bis ${res.stats.maxVertexSurface.toExponential(2)} mm neben der Fläche`);
  assert.ok(dtNeu < 1500, `Prüfung dauerte ${dtNeu.toFixed(0)} ms statt < 1500 ms`);
});

// ── b) Negativtests: die Prüfergebnisse müssen unverändert auffallen ───────
test('b) Negativtests: 1e-4 mm neben der Fläche und umgedrehtes sameSense werden gemeldet', () => {
  const deck = pillowDeck(7);
  // Ecke um 1e-4 mm verschoben → "Rand neben der Fläche" (mit tol 1e-6 prüfen)
  const nrm = XD([0, 0, 1]);
  const brep = buildCube(deck, { index: 4, delta: nrm.map((x) => x * 1e-4) });
  // die Kante 8/9 hängen an dieser Ecke → der Rand weicht ab
  const { step } = writeFreeformStep(brep, { timestamp: '2026-10-30T00:00:00.000Z', fileName: 'sperf-verschoben.step' });
  const vs = checkStepStrict(step, { tol: 1e-6 }).violations.filter((v) => v.kind === 'vertex-surface');
  log(`b) verschobene Ecke: ${vs.length} vertex-surface-Verstöße (${vs.map((v) => (v.d ?? 0).toExponential(2)).join(', ')})`);
  assert.ok(vs.length >= 1, 'kein Verstoß "Rand neben der Fläche"');
  assert.ok(vs.some((v) => /bspline_surface/.test(v.msg)), 'die B-Spline-Fläche wurde nicht beanstandet');
  assert.ok(vs.some((v) => (v.d ?? 0) > 1e-5 && (v.d ?? 0) < 1e-3), `Abweichung unerwartet: ${vs.map((v) => v.d).join(', ')}`);

  // sameSense der Deckfläche umgedreht → Orientierungs-Verstoß
  const brep2 = buildCube(pillowDeck(7));
  brep2.faces[1].sameSense = false;
  const { step: step2 } = writeFreeformStep(brep2, { timestamp: '2026-10-30T00:00:00.000Z', fileName: 'sperf-verdreht.step' });
  const vo = checkStepStrict(step2).violations.filter((v) => v.kind === 'orient-curved');
  log(`b) umgedrehtes sameSense: ${vo.length} orient-curved-Verstöße`);
  assert.ok(vo.some((v) => /bspline_surface/.test(v.msg)), 'kein Orientierungs-Verstoß an der B-Spline-Fläche');

  // sauberer Körper: keine Verstöße
  const { step: step3 } = writeFreeformStep(buildCube(pillowDeck(7)), { timestamp: '2026-10-30T00:00:00.000Z', fileName: 'sperf-sauber.step' });
  const ok = checkStepStrict(step3);
  log(`b) sauberer Kissen-Quader: ${ok.violations.length} Verstöße · maxRand ${ok.stats.maxVertexSurface.toExponential(2)} mm · V ${ok.volumes.map((v) => v.V.toFixed(2)).join(', ')}`);
  assert.equal(ok.violations.length, 0, `Verstöße: ${ok.violations.map((v) => v.kind + ': ' + v.msg).join(' | ')}`);
  assert.ok(ok.stats.maxVertexSurface < 1e-9, `Rand bis ${ok.stats.maxVertexSurface.toExponential(2)} mm neben der Fläche`);
});

// ── c) Skalierung mit der Stützpunktnetzgröße ───────────────────────────────
test('c) Skalierung: die Zeit wächst nicht quadratisch mit dem Stützpunktnetz', () => {
  const time = (n) => {
    const { step } = writeFreeformStep(buildCube(pillowDeck(n)), { timestamp: '2026-10-30T00:00:00.000Z', fileName: `sperf-${n}.step` });
    const t0 = performance.now();
    const { violations, stats } = checkStepStrict(step);
    const dt = performance.now() - t0;
    assert.equal(violations.length, 0, `Verstöße bei n=${n}: ${violations.map((v) => v.kind + ': ' + v.msg).join(' | ')}`);
    assert.ok(stats.maxVertexSurface < 1e-9, `Rand bis ${stats.maxVertexSurface.toExponential(2)} mm neben der Fläche (n=${n})`);
    return dt;
  };
  const t9 = time(9), t17 = time(17), t33 = time(33);
  console.log(`     sperf: Netz 9×9 ${t9.toFixed(1)} ms · 17×17 ${t17.toFixed(1)} ms · 33×33 ${t33.toFixed(1)} ms`);
  log(`c) Skalierung: 9×9 ${t9.toFixed(1)} ms · 17×17 ${t17.toFixed(1)} ms · 33×33 ${t33.toFixed(1)} ms`);
  // 16× mehr Stützpunkte dürfen nicht 256× mehr Zeit kosten (Ziel: linear × log)
  assert.ok(t33 < 60 * Math.max(t9, 0.5), `33×33 braucht ${t33.toFixed(1)} ms, 9×9 brauchte ${t9.toFixed(1)} ms — zu stark superlinear`);
});

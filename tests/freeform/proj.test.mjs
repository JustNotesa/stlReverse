// ─────────────────────────────────────────────────────────────────────────────
// tests/freeform/proj.test.mjs — Projektion auf Blend-Flächen (Coons-Patches)
//
// Eine Blend-Fläche (Coons-Patch) hat vier Randkurven, die aus vielen Stücken
// zusammengesetzt sind. Ihre Parametrisierung ist stark ungleichförmig:
//   • ein Randstück kann < 1 % des u-Bereichs belegen (0,05-mm-Stück neben
//     5-mm-Stücken — die Parametrisierung erfolgt nach Kontrollpolygonlänge),
//   • eine Polseite (dreiseitiges Patch) kollabiert: die ganze Zeile fällt auf
//     einen Punkt.
// Ein gleichmäßiges Raster über die Domäne verfehlt solche Spuren — die
// Projektion blieb in einem Nebenminimum hängen und meldete Punkte, die EXAKT
// auf der Fläche liegen, 2e-3 … 1e-2 mm daneben.
//
// Der Test baut drei synthetische Flächen, tastet je 200 Randpunkte (die
// Eingangskurven ausgewertet) und 200 Innenpunkte (S an zufälligen (u,v)) ab
// und verlangt für beide Projektionen
//   • freeform-nurbs.js projectToSurface  → Abstand ≤ 1e-8 mm
//   • tests/step-strict.mjs (derselbe Auswerter wie im strengen Prüfer)
//     → Abstand ≤ 1e-8 mm
//
// Zum Vergleich misst der Test die alte Fassung (git HEAD): projectToSurface
// mit dem gleichmäßigen Raster und der alte strenge Prüfer. Ihre Zahlen
// werden nur protokolliert (die alte Fassung scheitert nur bei der Polseite
// b) reproduzierbar; bei a) und c) ist sie nicht schlechter) — verbindlich
// sind die Werte der neuen Fassung (≤ 1e-8 mm).
//
// Ausführen:  .dev/test-stl.sh freeform
// ─────────────────────────────────────────────────────────────────────────────
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import {
  lineToBspline, evalCurve, joinCurves, coonsPatch,
  evalSurface, surfaceDerivs, projectToSurface,
} from '../../freeform-nurbs.js';
import { interpCubic, len, sub, add, mul, dot, norm, cross } from '../../freeform-geom.js';
import { bsplineDistForTest } from '../step-strict.mjs';

// Messwerte zusätzlich in eine Datei: der Test-Runner zeigt nur die letzten
// Ausgabezeilen — die proj-Zeilen wären sonst abgeschnitten.
const LOG = 'tests/freeform/out/proj.log';
const log = (s) => {
  try {
    mkdirSync('tests/freeform/out', { recursive: true });
    appendFileSync(LOG, s + '\n');
  } catch (e) { /* nur Messwert */ }
};
try {
  mkdirSync('tests/freeform/out', { recursive: true });
  writeFileSync(LOG, '');
} catch (e) { /* nur Messwert */ }
// Messzeile: auf die Konsole (wie bisher) und zusätzlich in die Logdatei
const report = (s) => { console.log(`     proj: ${s}`); log(`proj: ${s}`); };

// ── Hilfen: Zufall, Rotation ────────────────────────────────────────────────

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(20261030);

function rotMat(axis, ang) {
  const a = norm(axis);
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  const t = 1 - c;
  const [x, y, z] = a;
  return [
    [t * x * x + c, t * x * y - s * z, t * x * z + s * y],
    [t * x * y + s * z, t * y * y + c, t * y * z - s * x],
    [t * x * z - s * y, t * y * z + s * x, t * z * z + c],
  ];
}
const ROT = rotMat([0.31, -0.77, 0.56], 0.83);
const SHIFT = [12.5, -6.25, 9.75];
// lokale Punktkoordinaten → gedreht + verschoben (nichts achsenparallel)
const X = (p) => add([dot(ROT[0], p), dot(ROT[1], p), dot(ROT[2], p)], SHIFT);

// Stück einer Kurve: kubisch mit einer Ausbuchtung senkrecht zur Richtung
function arcPiece(P, Q, bulge, n = 4) {
  const d = sub(Q, P);
  const nr = norm(cross(d, [0, 0, 1]));
  const ctrl = [P.slice()];
  for (let i = 1; i < n - 1; i++) {
    const t = i / (n - 1);
    ctrl.push(add(add(P, mul(d, t)), mul(nr, bulge * Math.sin(Math.PI * t))));
  }
  ctrl.push(Q.slice());
  return { type: 'bspline', degree: 3, ctrl, knots: [0, 1], mults: [4, 4] };
}

// Bogen mit gegebenem Radius (Sehne senkrecht zur Bogenebene)
function arcOfRadius(P, Q, R, bulgeDir, n = 9) {
  const d = sub(Q, P);
  const mid = mul(add(P, Q), 0.5);
  const half = len(d) / 2;
  const cd = Math.sqrt(Math.max(0, R * R - half * half));   // Abstand Sehnenmitte → Mittelpunkt
  const dir = norm(bulgeDir);
  const c = add(mid, mul(dir, -cd));
  const a = norm(sub(P, c));
  const b = norm(sub(Q, c));
  const ang = Math.acos(Math.max(-1, Math.min(1, dot(a, b))));
  const k = norm(cross(cross(a, b), a));
  const pts = [];
  for (let i = 0; i < n; i++) {
    const t = ang * (i / (n - 1));
    const v = add(mul(a, Math.cos(t)), mul(k, Math.sin(t)));
    pts.push(add(c, mul(v, R)));
  }
  return interpCubic(pts);
}

// Fläche (und ihre Randkurven) drehen + verschieben: die Abbildung ist affin,
// die Coons-Eigenschaft bleibt exakt erhalten
function transformSurface(S, xf) {
  return { ...S, ctrl: S.ctrl.map((row) => row.map(xf)) };
}

// ── (a) 4-seitiges Patch: c0 = 6 Stücke, davon eines 0,05 mm lang ───────────
//
// Die Stückgrenzen von c0 sind die inneren u-Knoten. Die Parametrisierung
// erfolgt nach Kontrollpolygonlänge → das 0,05-mm-Stück belegt < 1 % des
// u-Bereichs, während die 5-mm-Stücke ihn aufteilen.
function surfaceA() {
  const A = [0, 0, 0], B = [30, 0, 0], C = [30, 10, 0], D = [0, 10, 0];
  const segs = [[5, 4], [5, 4], [5, 4], [5, 4], [0.05, 16], [9.95, 4]];
  const pieces = [];
  let cur = A.slice();
  for (const [L, n] of segs) {
    const Q = add(cur, [L, 0, 0]);
    if (n === 4) {
      pieces.push(arcPiece(cur, Q, 0.6));
    } else {
      // 16 Stützpunkte auf 0,05 mm (kleine Welle)
      const pp = [];
      for (let i = 0; i < n; i++) {
        const t = i / (n - 1);
        pp.push(add(add(cur, mul(sub(Q, cur), t)), [0, 0, 0.004 * Math.sin(6 * Math.PI * t)]));
      }
      pieces.push(interpCubic(pp));
    }
    cur = Q;
  }
  const c0 = joinCurves(pieces);      // 6 Stücke
  const c1 = arcPiece(D, C, 0.4);     // eine glatte Kurve
  const d0 = arcPiece(A, D, 0.3);     // kurze Bögen
  const d1 = arcPiece(B, C, 0.3);
  const S = coonsPatch(c0, c1, d0, d1);
  assert.ok(S, 'a) coonsPatch liefert die Fläche');
  return { S, curves: [c0, c1, d0, d1] };
}

// ── (b) 3-seitiges Patch: d0 ist eine Punktseite (Pol) ─────────────────────
//
// Ein 10 mm × 0,6 mm langer Streifen, am Ende wie eine Verrundung r = 0,5 mm
// gebogen; die dritte Seite ist auf einen Punkt zusammengefallen.
function surfaceB() {
  const P = [0, 0, 0], A = [10, 0, 0], B = [10, 0.6, 0];
  const c0 = lineToBspline(P, A);              // 10 mm
  const c1 = arcPiece(P, B, 0.25);             // 10 mm, leicht gebogen
  const d0 = lineToBspline(P, P);              // Polseite (Punkt)
  const d1 = arcOfRadius(A, B, 0.5, [0, 0, 1]); // Bogen r = 0,5 mm
  const S = coonsPatch(c0, c1, d0, d1);
  assert.ok(S, 'b) coonsPatch liefert die Fläche');
  return { S, curves: [c0, c1, d1] };
}

// ── (c) Streifen 37 mm × 0,5 mm: c0 aus 3 Stücken, c1 aus 2 Stücken ───────
//
// Die Knicke liegen bei verschiedenen u-Parametern (12,3 / 24,7 mm gegen 25 mm)
// → die inneren u-Knoten liegen dicht beieinander, das dazwischen liegende
// Stück ist schmal in der Parametrisierung.
function surfaceC() {
  const A = [0, 0, 0], B = [37, 0, 0], C = [37, 0.5, 0], D = [0, 0.5, 0];
  const c0 = joinCurves([
    lineToBspline(A, [12.3, 0.35, 0]),
    lineToBspline([12.3, 0.35, 0], [24.7, -0.2, 0]),
    lineToBspline([24.7, -0.2, 0], B),
  ]);
  const c1 = joinCurves([
    lineToBspline(D, [25, 0.5, 0.4]),
    lineToBspline([25, 0.5, 0.4], C),
  ]);
  const d0 = lineToBspline(A, D);
  const d1 = lineToBspline(B, C);
  const S = coonsPatch(c0, c1, d0, d1);
  assert.ok(S, 'c) coonsPatch liefert die Fläche');
  return { S, curves: [c0, c1, d0, d1] };
}

// ── Abtastung ───────────────────────────────────────────────────────────────

// 200 Randpunkte: die Eingangskurven auswerten (die Randpunkte liegen damit
// exakt auf der Fläche — Fehler < 1e-15 mm)
function boundaryPoints(curves, n = 50) {
  const out = [];
  for (const c of curves) {
    const a = c.knots[0];
    const b = c.knots[c.knots.length - 1];
    for (let i = 0; i < n; i++) out.push(evalCurve(c, a + ((b - a) * i) / (n - 1)));
  }
  return out;
}

// 200 Innenpunkte: S an zufälligen (u,v) — der Punkt liegt exakt auf der Fläche
function interiorPoints(S, n = 200) {
  const u0 = S.knotsU[0], u1 = S.knotsU[S.knotsU.length - 1];
  const v0 = S.knotsV[0], v1 = S.knotsV[S.knotsV.length - 1];
  const out = [];
  for (let i = 0; i < n; i++) {
    const u = u0 + 0.001 * (u1 - u0) + rng() * 0.998 * (u1 - u0);
    const v = v0 + 0.001 * (v1 - v0) + rng() * 0.998 * (v1 - v0);
    out.push(evalSurface(S, u, v));
  }
  return out;
}

// ── Die alte Fassung zum Vergleich (git HEAD) ────────────────────────────────

// Alte projectToSurface: gleichmäßiges Raster über die Domäne als Startwert
// + Gauß-Newton (geklemmt). Genau diese Fassung blieb in Nebenminima hängen.
function legacyProject(S, p) {
  const u0 = S.knotsU[0], u1 = S.knotsU[S.knotsU.length - 1];
  const v0 = S.knotsV[0], v1 = S.knotsV[S.knotsV.length - 1];
  const N = 12;
  let bu = u0, bv = v0, bd = Infinity;
  for (let i = 0; i <= N; i++) {
    const u = u0 + ((u1 - u0) * i) / N;
    for (let j = 0; j <= N; j++) {
      const v = v0 + ((v1 - v0) * j) / N;
      const d = len(sub(evalSurface(S, u, v), p));
      if (d < bd) { bd = d; bu = u; bv = v; }
    }
  }
  let u = bu, v = bv, cur = bd;
  for (let it = 0; it < 80; it++) {
    const x = evalSurface(S, u, v);
    const r = sub(p, x);
    const d = surfaceDerivs(S, u, v);
    const a = dot(d.Su, d.Su), b = dot(d.Su, d.Sv), c = dot(d.Sv, d.Sv);
    const e1 = dot(d.Su, r), e2 = dot(d.Sv, r);
    const det = a * c - b * b;
    if (!(Math.abs(det) > 1e-300)) break;
    let step = 1, improved = false;
    for (let k = 0; k < 14; k++) {
      const du = (step * (c * e1 - b * e2)) / det;
      const dv = (step * (a * e2 - b * e1)) / det;
      const nu = Math.min(Math.max(u + du, u0), u1);
      const nv = Math.min(Math.max(v + dv, v0), v1);
      const nd = len(sub(evalSurface(S, nu, nv), p));
      if (nd < cur) {
        const impr = cur - nd;
        u = nu; v = nv; cur = nd; improved = true;
        if (impr < 1e-16) it = 80;
        break;
      }
      step *= 0.5;
    }
    if (!improved) break;
  }
  const x = evalSurface(S, u, v);
  return { u, v, x, dist: len(sub(x, p)) };
}

// Der alte strenge Prüfer (git HEAD) — ohne Datei: data:-URL
let oldChecker = null;
try {
  const src = execFileSync('git', ['show', 'HEAD:tests/step-strict.mjs'], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, cwd: process.cwd(),
  });
  oldChecker = (await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'))).checkStepStrict;
} catch (e) { oldChecker = null; }

// Surrogate-STEP: die Fläche als Fläche eines Gesichts mit einem Punkt-Rand an p
// (der Prüfer misst daran den Abstand des Punktes zur Fläche)
function surrogateStep(surf, p) {
  const L = [];
  let id = 1;
  const rows = [];
  for (const row of surf.ctrl) {
    const r = [];
    for (const q of row) {
      L.push(`#${id}=CARTESIAN_POINT('',(${q[0]},${q[1]},${q[2]}));`);
      r.push(`#${id}`);
      id++;
    }
    rows.push(`(${r.join(',')})`);
  }
  const sId = id++;
  L.push(`#${sId}=B_SPLINE_SURFACE_WITH_KNOTS('',${surf.du},${surf.dv},(${rows.join(',')}),.UNSPECIFIED.,.F.,.F.,.F.,(${surf.multsU.join(',')}),(${surf.multsV.join(',')}),(${surf.knotsU.join(',')}),(${surf.knotsV.join(',')}),.UNSPECIFIED.);`);
  const cId = id++;
  L.push(`#${cId}=CARTESIAN_POINT('',(${p[0]},${p[1]},${p[2]}));`);
  const vId = id++;
  L.push(`#${vId}=VERTEX_POINT('',#${cId});`);
  const vlId = id++;
  L.push(`#${vlId}=VERTEX_LOOP('',#${vId});`);
  const fbId = id++;
  L.push(`#${fbId}=FACE_OUTER_BOUND('',#${vlId},.T.);`);
  const afId = id++;
  L.push(`#${afId}=ADVANCED_FACE('',(#${fbId}),#${sId},.T.);`);
  return L.join('\n');
}

// Abstand des alten Prüfers zum Punkt p (null, wenn der alte Prüfer den
// Punkt-Rand nicht auswertet)
function oldCheckerDist(surf, p) {
  if (!oldChecker) return null;
  try {
    const r = oldChecker(surrogateStep(surf, p), { tol: 1e9 });
    return r.stats.maxVertexSurface;
  } catch (e) { return null; }
}

// ── Prüfung einer Fläche ────────────────────────────────────────────────────

const TOL = 1e-8;   // mm

// Kurve drehen + verschieben (affin → exakt)
function transformCurve(c, xf) {
  return { ...c, ctrl: c.ctrl.map(xf) };
}

const maxD = (list) => (list.length ? Math.max(...list.map((x) => x.d)).toExponential(2) : '0');

function checkSurface(S, curves) {
  const groups = [
    ['Rand', boundaryPoints(curves)],
    ['Innen', interiorPoints(S)],
  ];
  const bad = { proj: [], checker: [], legacyProj: [], legacyChecker: [] };
  let total = 0;
  for (const [label, pts] of groups) {
    for (const p of pts) {
      total++;
      const r = projectToSurface(S, p);
      if (!(r.dist <= TOL)) bad.proj.push({ label, d: r.dist });
      const d = bsplineDistForTest(S, p);
      if (!(d <= TOL)) bad.checker.push({ label, d });
      const lr = legacyProject(S, p);
      if (!(lr.dist <= TOL)) bad.legacyProj.push({ label, d: lr.dist });
      const od = oldCheckerDist(S, p);
      if (od !== null && !(od <= TOL)) bad.legacyChecker.push({ label, d: od });
    }
  }
  return { bad, total };
}

// ── Die drei Flächen ────────────────────────────────────────────────────────

test('a) 4-seitiges Patch (c0 = 6 Stücke, eines 0,05 mm lang): Rand und Innen exakt', () => {
  const { S, curves } = surfaceA();
  const Sx = transformSurface(S, X);
  const cx = curves.map((c) => transformCurve(c, X));
  const { bad, total } = checkSurface(Sx, cx);
  report(`a) neu ${bad.proj.length}/${total} daneben · alt ${bad.legacyProj.length}`
    + ` (max ${maxD(bad.legacyProj)} mm) · Prüfer neu ${bad.checker.length} · alt ${bad.legacyChecker.length}`
    + ` (max ${maxD(bad.legacyChecker)} mm)`);
  assert.deepEqual(bad.proj.map((x) => `${x.label}: ${x.d.toExponential(2)}`), [],
    'a) projectToSurface: Punkte, die exakt auf der Fläche liegen, wurden daneben gemeldet');
  assert.deepEqual(bad.checker.map((x) => `${x.label}: ${x.d.toExponential(2)}`), [],
    'a) strenger Prüfer: Punkte, die exakt auf der Fläche liegen, wurden daneben gemeldet');
});

test('b) 3-seitiges Patch (d0 = Punktseite, 10 mm × 0,6 mm, Bogen r = 0,5): Rand und Innen exakt', () => {
  const { S, curves } = surfaceB();
  const Sx = transformSurface(S, X);
  const cx = curves.map((c) => transformCurve(c, X));
  const { bad, total } = checkSurface(Sx, cx);
  report(`b) neu ${bad.proj.length}/${total} daneben · alt ${bad.legacyProj.length}`
    + ` (max ${maxD(bad.legacyProj)} mm) · Prüfer neu ${bad.checker.length} · alt ${bad.legacyChecker.length}`
    + ` (max ${maxD(bad.legacyChecker)} mm)`);
  assert.ok(bad.legacyProj.length > 0, 'b) die alte Fassung muss hier scheitern (sonst kein Repro)');
  assert.deepEqual(bad.proj.map((x) => `${x.label}: ${x.d.toExponential(2)}`), [],
    'b) projectToSurface: Punkte, die exakt auf der Fläche liegen, wurden daneben gemeldet');
  assert.deepEqual(bad.checker.map((x) => `${x.label}: ${x.d.toExponential(2)}`), [],
    'b) strenger Prüfer: Punkte, die exakt auf der Fläche liegen, wurden daneben gemeldet');
});

test('c) Streifen 37 mm × 0,5 mm (c0 = 3 Stücke, c1 = 2 Stücke): Rand und Innen exakt', () => {
  const { S, curves } = surfaceC();
  const Sx = transformSurface(S, X);
  const cx = curves.map((c) => transformCurve(c, X));
  const { bad, total } = checkSurface(Sx, cx);
  report(`c) neu ${bad.proj.length}/${total} daneben · alt ${bad.legacyProj.length}`
    + ` (max ${maxD(bad.legacyProj)} mm) · Prüfer neu ${bad.checker.length} · alt ${bad.legacyChecker.length}`
    + ` (max ${maxD(bad.legacyChecker)} mm)`);
  assert.deepEqual(bad.proj.map((x) => `${x.label}: ${x.d.toExponential(2)}`), [],
    'c) projectToSurface: Punkte, die exakt auf der Fläche liegen, wurden daneben gemeldet');
  assert.deepEqual(bad.checker.map((x) => `${x.label}: ${x.d.toExponential(2)}`), [],
    'c) strenger Prüfer: Punkte, die exakt auf der Fläche liegen, wurden daneben gemeldet');
});

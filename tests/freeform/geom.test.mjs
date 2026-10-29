// Tests für freeform-geom.js — Vektoren, sdist/normalAt/project, projectMulti,
// analytische Schnittkurven, B-Splines, Kurvenfit.
// Eigene Zahlen, keine Projektdateien als Quelle.
import assert from 'node:assert/strict';
import {
  add, sub, mul, dot, cross, len, norm,
  sdist, normalAt, project,
  projectMulti, analyticCurve, interpCubic, evalBspline, fitIntersectionCurve, sampleCurve,
} from '../../freeform-geom.js';

let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log('ok ' + name);
  } catch (e) {
    failed++;
    console.log('FAIL ' + name + ': ' + (e && e.message ? e.message : String(e)));
  }
}

const close = (a, b, tol, what) => {
  assert.ok(Math.abs(a - b) <= tol, `${what || ''} ${a} != ${b} (tol ${tol})`);
};
const closeV = (a, b, tol, what) => {
  for (let i = 0; i < 3; i++) close(a[i], b[i], tol, `${what || ''}[${i}]`);
};
const near = (p, t, tol, what) => closeV(p, t, tol, what);

// ── Hilfen: starre Bewegung ─────────────────────────────────────────────────
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
const rot = (M, p) => [dot(M[0], p), dot(M[1], p), dot(M[2], p)];

function xfSurf(s, M, T) {
  const rp = (p) => add(rot(M, p), T);
  switch (s.type) {
    case 'plane': return { type: 'plane', o: rp(s.o), n: rot(M, s.n) };
    case 'cylinder': return { type: 'cylinder', o: rp(s.o), a: rot(M, s.a), R: s.R };
    case 'cone': return { type: 'cone', apex: rp(s.apex), a: rot(M, s.a), alpha: s.alpha };
    case 'sphere': return { type: 'sphere', c: rp(s.c), R: s.R };
    case 'torus': return { type: 'torus', c: rp(s.c), a: rot(M, s.a), Rm: s.Rm, r: s.r };
    default: throw new Error('unbekannter Typ ' + s.type);
  }
}

// Winkel eines Punktes um die Achse a, gemessen von x aus (0..2π)
function angleAround(circ, pt) {
  const v = sub(pt, circ.c);
  let th = Math.atan2(dot(cross(circ.x, v), circ.a), dot(circ.x, v));
  if (th < 0) th += 2 * Math.PI;
  return th;
}
// Liegt pt auf dem positiven Bogen p→q des Kreises?
function onArc(circ, p, q, pt) {
  const tp = angleAround(circ, p);
  const tq = angleAround(circ, q);
  const tm = angleAround(circ, pt);
  const span = (tq - tp + 2 * Math.PI) % (2 * Math.PI);
  const rel = (tm - tp + 2 * Math.PI) % (2 * Math.PI);
  return rel <= span + 1e-9;
}

// ── 1) sdist / normalAt / project je Flächentyp ─────────────────────────────
const SQ3 = Math.sqrt(3) / 2;

test('sdist plane', () => {
  const s = { type: 'plane', o: [0, 0, 0], n: [0, 0, 1] };
  close(sdist(s, [1, 2, 3]), 3, 1e-12, 'sdist');
  closeV(normalAt(s, [1, 2, 3]), [0, 0, 1], 1e-12, 'n');
  near(project(s, [1, 2, 3]), [1, 2, 0], 1e-12, 'proj');
});

test('sdist cylinder', () => {
  const s = { type: 'cylinder', o: [0, 0, 0], a: [0, 0, 1], R: 2 };
  close(sdist(s, [3, 0, 1]), 1, 1e-12, 'sdist');
  close(sdist(s, [0, 0, 5]), -2, 1e-12, 'sdist achse');
  closeV(normalAt(s, [3, 0, 1]), [1, 0, 0], 1e-12, 'n');
  near(project(s, [3, 0, 1]), [2, 0, 1], 1e-12, 'proj');
});

test('sdist sphere', () => {
  const s = { type: 'sphere', c: [1, 0, 0], R: 2 };
  close(sdist(s, [4, 0, 0]), 1, 1e-12, 'sdist');
  closeV(normalAt(s, [4, 0, 0]), [1, 0, 0], 1e-12, 'n');
  near(project(s, [4, 0, 0]), [3, 0, 0], 1e-12, 'proj');
});

test('sdist torus', () => {
  const s = { type: 'torus', c: [0, 0, 0], a: [0, 0, 1], Rm: 3, r: 1 };
  close(sdist(s, [4, 0, 0]), 0, 1e-12, 'sdist auf fläche');
  close(sdist(s, [5, 0, 0]), 1, 1e-12, 'sdist');
  close(sdist(s, [0, 0, 2]), Math.sqrt(13) - 1, 1e-12, 'sdist innen');
  closeV(normalAt(s, [5, 0, 0]), [1, 0, 0], 1e-12, 'n');
  near(project(s, [5, 0, 0]), [4, 0, 0], 1e-12, 'proj');
});

test('sdist cone fern vom apex', () => {
  const s = { type: 'cone', apex: [0, 0, 0], a: [0, 0, 1], alpha: Math.PI / 6 };
  close(sdist(s, [1, 0, 1]), SQ3 - 0.5, 1e-12, 'sdist');
  closeV(normalAt(s, [1, 0, 1]), [SQ3, 0, -0.5], 1e-12, 'n');
  const pr = project(s, [1, 0, 1]);
  close(sdist(s, pr), 0, 1e-12, 'proj auf fläche');
  // auf dem Kegelmantel: Radius = h·tan(30°)
  close(sdist(s, [Math.tan(Math.PI / 6), 0, 1]), 0, 1e-12, 'sdist auf mantel');
});

test('sdist cone nahe apex', () => {
  const s = { type: 'cone', apex: [0, 0, 0], a: [0, 0, 1], alpha: Math.PI / 6 };
  close(sdist(s, [0.1, 0, 0.05]), 0.1 * SQ3 - 0.05 * 0.5, 1e-12, 'sdist');
  const pr = project(s, [0.1, 0, 0.05]);
  close(sdist(s, pr), 0, 1e-12, 'proj auf fläche');
});

test('sdist cone unter apex (nächster punkt spitze)', () => {
  const s = { type: 'cone', apex: [0, 0, 0], a: [0, 0, 1], alpha: Math.PI / 6 };
  const p = [0.01, 0, -0.05];
  close(sdist(s, p), Math.hypot(0.01, 0, 0.05), 1e-12, 'sdist');
});

test('vektoren', () => {
  near(add([1, 2, 3], [4, 5, 6]), [5, 7, 9], 0, 'add');
  near(sub([1, 2, 3], [4, 5, 6]), [-3, -3, -3], 0, 'sub');
  near(mul([1, 2, 3], 2), [2, 4, 6], 0, 'mul');
  close(dot([1, 2, 3], [4, 5, 6]), 32, 0, 'dot');
  near(cross([1, 0, 0], [0, 1, 0]), [0, 0, 1], 0, 'cross');
  close(len([3, 4, 0]), 5, 0, 'len');
  near(norm([0, 0, 7]), [0, 0, 1], 0, 'norm');
  near(norm([0, 0, 0]), [0, 0, 0], 0, 'norm 0');
});

// ── 2) projectMulti ────────────────────────────────────────────────────────
test('projectMulti drei ebenen (ecke)', () => {
  const S = [
    { type: 'plane', o: [0, 0, 0], n: [1, 0, 0] },
    { type: 'plane', o: [0, 0, 0], n: [0, 1, 0] },
    { type: 'plane', o: [0, 0, 0], n: [0, 0, 1] },
  ];
  const r = projectMulti(S, [1, 2, 3]);
  assert.ok(r.ok, 'nicht konvergiert: res=' + r.res);
  close(r.res, 0, 1e-10, 'res');
  near(r.x, [0, 0, 0], 1e-9, 'x');
});

test('projectMulti ebene + tangenter zylinder', () => {
  const S = [
    { type: 'plane', o: [0, 0, 0], n: [0, 0, 1] },
    { type: 'cylinder', o: [0, 0, 1], a: [1, 0, 0], R: 1 },
  ];
  const r = projectMulti(S, [3, 0.3, 0.05]);
  assert.ok(r.ok, 'nicht konvergiert: res=' + r.res + ' x=' + r.x);
  close(r.res, 0, 1e-10, 'res');
  near(r.x, [3, 0, 0], 1e-4, 'x');
});

test('projectMulti kugel + zylinder', () => {
  const S = [
    { type: 'sphere', c: [0, 0, 0], R: 2 },
    { type: 'cylinder', o: [0, 0, 0], a: [0, 0, 1], R: 1 },
  ];
  const r = projectMulti(S, [1, 0, 1]);
  assert.ok(r.ok, 'nicht konvergiert: res=' + r.res + ' x=' + r.x);
  close(r.res, 0, 1e-10, 'res');
  close(Math.abs(r.x[2]), Math.sqrt(3), 1e-8, '|z|');
  close(Math.hypot(r.x[0], r.x[1]), 1, 1e-8, 'radius');
});

test('projectMulti k=0 und k=1', () => {
  const r0 = projectMulti([], [1, 2, 3]);
  near(r0.x, [1, 2, 3], 0, 'x');
  assert.ok(r0.ok);
  const r1 = projectMulti([{ type: 'plane', o: [0, 0, 0], n: [0, 0, 1] }], [1, 2, 3]);
  near(r1.x, [1, 2, 0], 1e-12, 'x');
  assert.ok(r1.ok);
});

// ── 3) analytische Schnittkurven ───────────────────────────────────────────
const PLANE_Z = { type: 'plane', o: [0, 0, 0], n: [0, 0, 1] };
const PLANE_X = { type: 'plane', o: [0, 0, 0], n: [1, 0, 0] };

test('analyticCurve zwei ebenen → gerade', () => {
  const c = analyticCurve(PLANE_Z, PLANE_X, [0, 1, 0], [0, 2, 0], [0, 1.5, 0]);
  assert.ok(c, 'keine Kurve');
  assert.equal(c.type, 'line');
  near(c.p, [0, 1, 0], 1e-12, 'p');
  near(c.d, [0, 1, 0], 1e-12, 'd');
});

test('analyticCurve torus + ebene (tangential) → kreis', () => {
  const T = { type: 'torus', c: [0, 0, -0.5], a: [0, 0, 1], Rm: 3.5, r: 0.5 };
  const p = [3.5, 0, 0];
  const q = [0, 3.5, 0];
  const m = [3.5 / Math.SQRT2, 3.5 / Math.SQRT2, 0];
  const c = analyticCurve(T, PLANE_Z, p, q, m);
  assert.ok(c, 'keine Kurve');
  assert.equal(c.type, 'circle');
  close(c.R, 3.5, 1e-9, 'R');
  near(c.c, [0, 0, 0], 1e-9, 'c');
  assert.ok(onArc(c, p, q, m), 'm nicht auf dem positiven Bogen');
  // m auf der anderen Seite → a kippt
  const m2 = [3.5 / Math.SQRT2, -3.5 / Math.SQRT2, 0];
  const c2 = analyticCurve(T, PLANE_Z, p, q, m2);
  assert.ok(c2, 'keine Kurve');
  assert.equal(c2.type, 'circle');
  close(c2.R, 3.5, 1e-9, 'R');
  near(c2.a, [0, 0, -1], 1e-9, 'a gekippt');
  assert.ok(onArc(c2, p, q, m2), 'm2 nicht auf dem positiven Bogen');
});

test('analyticCurve zylinder + kugel → kreis bei z=10', () => {
  const C = { type: 'cylinder', o: [0, 0, 0], a: [0, 0, 1], R: 5 };
  const S = { type: 'sphere', c: [0, 0, 10], R: 5 };
  const p = [5, 0, 10];
  const q = [0, 5, 10];
  const m = [5 / Math.SQRT2, 5 / Math.SQRT2, 10];
  const c = analyticCurve(C, S, p, q, m);
  assert.ok(c, 'keine Kurve');
  assert.equal(c.type, 'circle');
  close(c.R, 5, 1e-9, 'R');
  near(c.c, [0, 0, 10], 1e-9, 'c');
  assert.ok(onArc(c, p, q, m), 'm nicht auf dem Bogen');
});

test('analyticCurve ebene + zylinder (tangential) → gerade', () => {
  const C = { type: 'cylinder', o: [0, 0, 1], a: [1, 0, 0], R: 1 };
  const p = [3, 0, 0];
  const q = [6, 0, 0];
  const c = analyticCurve(PLANE_Z, C, p, q, [4.5, 0, 0]);
  assert.ok(c, 'keine Kurve');
  assert.equal(c.type, 'line');
  near(c.d, [1, 0, 0], 1e-12, 'd');
});

// dieselben Fälle unter starrer Drehung + Verschiebung
const ROT = rotMat([0.3, 0.5, 0.81], 0.7);
const TRA = [2, -1, 0.5];
const xf = (p) => add(rot(ROT, p), TRA);

test('analyticCurve (gedreht) zwei ebenen → gerade', () => {
  const A = xfSurf(PLANE_Z, ROT, TRA);
  const B = xfSurf(PLANE_X, ROT, TRA);
  const p = xf([0, 1, 0]);
  const q = xf([0, 2, 0]);
  const c = analyticCurve(A, B, p, q, xf([0, 1.5, 0]));
  assert.ok(c, 'keine Kurve');
  assert.equal(c.type, 'line');
  near(c.p, p, 1e-9, 'p');
  near(c.d, rot(ROT, [0, 1, 0]), 1e-9, 'd');
});

test('analyticCurve (gedreht) torus + ebene → kreis', () => {
  const T = xfSurf({ type: 'torus', c: [0, 0, -0.5], a: [0, 0, 1], Rm: 3.5, r: 0.5 }, ROT, TRA);
  const A = xfSurf(PLANE_Z, ROT, TRA);
  const p = xf([3.5, 0, 0]);
  const q = xf([0, 3.5, 0]);
  const m = xf([3.5 / Math.SQRT2, 3.5 / Math.SQRT2, 0]);
  const c = analyticCurve(T, A, p, q, m);
  assert.ok(c, 'keine Kurve');
  assert.equal(c.type, 'circle');
  close(c.R, 3.5, 1e-9, 'R');
  near(c.c, xf([0, 0, 0]), 1e-9, 'c');
  assert.ok(onArc(c, p, q, m), 'm nicht auf dem Bogen');
  const m2 = xf([3.5 / Math.SQRT2, -3.5 / Math.SQRT2, 0]);
  const c2 = analyticCurve(T, A, p, q, m2);
  assert.ok(c2, 'keine Kurve');
  close(c2.R, 3.5, 1e-9, 'R');
  assert.ok(onArc(c2, p, q, m2), 'm2 nicht auf dem Bogen');
  // Achse umgeklappt: a2 ≈ -R·a
  assert.ok(len(cross(c2.a, rot(ROT, [0, 0, 1]))) < 1e-9, 'a2 nicht gekippt');
});

test('analyticCurve (gedreht) zylinder + kugel → kreis', () => {
  const C = xfSurf({ type: 'cylinder', o: [0, 0, 0], a: [0, 0, 1], R: 5 }, ROT, TRA);
  const S = xfSurf({ type: 'sphere', c: [0, 0, 10], R: 5 }, ROT, TRA);
  const p = xf([5, 0, 10]);
  const q = xf([0, 5, 10]);
  const m = xf([5 / Math.SQRT2, 5 / Math.SQRT2, 10]);
  const c = analyticCurve(C, S, p, q, m);
  assert.ok(c, 'keine Kurve');
  assert.equal(c.type, 'circle');
  close(c.R, 5, 1e-9, 'R');
  near(c.c, xf([0, 0, 10]), 1e-9, 'c');
  assert.ok(onArc(c, p, q, m), 'm nicht auf dem Bogen');
});

test('analyticCurve (gedreht) ebene + zylinder → gerade', () => {
  const C = xfSurf({ type: 'cylinder', o: [0, 0, 1], a: [1, 0, 0], R: 1 }, ROT, TRA);
  const A = xfSurf(PLANE_Z, ROT, TRA);
  const p = xf([3, 0, 0]);
  const q = xf([6, 0, 0]);
  const c = analyticCurve(A, C, p, q, xf([4.5, 0, 0]));
  assert.ok(c, 'keine Kurve');
  assert.equal(c.type, 'line');
  near(c.p, p, 1e-9, 'p');
  near(c.d, rot(ROT, [1, 0, 0]), 1e-9, 'd');
});

// ── 4) B-Splines ────────────────────────────────────────────────────────────
// deterministischer Zufall (LCG)
let seed = 123456789;
const rnd = () => {
  seed = (1103515245 * seed + 12345) % 2147483648;
  return seed / 2147483648;
};

test('interpCubic reproduziert punkte', () => {
  const pts = [];
  for (let i = 0; i < 10; i++) pts.push([rnd() * 100 - 50, rnd() * 100 - 50, rnd() * 100 - 50]);
  const c = interpCubic(pts);
  assert.ok(c, 'keine Kurve');
  assert.equal(c.type, 'bspline');
  assert.equal(c.degree, 3);
  assert.equal(c.ctrl.length, 10);
  assert.equal(c.params.length, 10);
  close(c.params[0], 0, 1e-12, 'params[0]');
  close(c.params[9], 1, 1e-12, 'params[9]');
  for (let i = 0; i < 10; i++) {
    const e = evalBspline(c, c.params[i]);
    near(e, pts[i], 1e-12, 'punkt ' + i);
  }
});

test('interpCubic 2 und 3 punkte', () => {
  const c2 = interpCubic([[0, 0, 0], [1, 2, 3]]);
  assert.equal(c2.degree, 1);
  near(c2.ctrl[0], [0, 0, 0], 1e-12, 'ctrl0');
  near(c2.ctrl[1], [1, 2, 3], 1e-12, 'ctrl1');
  assert.deepEqual(c2.knots, [0, 1]);
  assert.deepEqual(c2.mults, [2, 2]);
  const c3 = interpCubic([[0, 0, 0], [1, 2, 3], [4, 5, 6]]);
  assert.equal(c3.degree, 2);
  near(evalBspline(c3, c3.params[1]), [1, 2, 3], 1e-12, 'mittel');
});

test('evalBspline endpunkte', () => {
  const pts = [];
  for (let i = 0; i < 10; i++) pts.push([rnd() * 20, rnd() * 20, rnd() * 20]);
  const c = interpCubic(pts);
  near(evalBspline(c, 0), pts[0], 1e-12, 'start');
  near(evalBspline(c, 1), pts[9], 1e-12, 'ende');
  near(evalBspline(c, -1), pts[0], 1e-12, 'start (geklemmt)');
  near(evalBspline(c, 2), pts[9], 1e-12, 'ende (geklemmt)');
});

// ── 5) Schnittkurve als B-Spline ────────────────────────────────────────────
test('fitIntersectionCurve zylinder ∩ zylinder → bspline', () => {
  const A = { type: 'cylinder', o: [0, 0, 0], a: [0, 0, 1], R: 2 };
  const B = { type: 'cylinder', o: [0, 0, 0], a: [1, 0, 0], R: 1.5 };
  // p und q auf dem unteren bzw. oberen Ende des Bogens (phi = -0.6 / +0.6)
  const rp = projectMulti([A, B], [1.65, -1.13, 0.99]);
  const rq = projectMulti([A, B], [1.65, 1.13, 0.99]);
  assert.ok(rp.ok && rq.ok, 'Startpunkte nicht gefunden');
  const p = rp.x;
  const q = rq.x;
  // 5 Führungs(stütz-)punkte auf der Schnittkurve (zwischen p und q)
  const guides = [];
  for (const phi of [-0.5, -0.25, 0, 0.25, 0.5]) {
    const g = [2 * Math.cos(phi), 2 * Math.sin(phi), Math.sqrt(Math.max(0, 2.25 - 4 * Math.sin(phi) ** 2))];
    const rg = projectMulti([A, B], g);
    assert.ok(rg.ok, 'führungspunkt ' + phi + ' nicht projizierbar');
    guides.push(rg.x);
  }
  const res = fitIntersectionCurve(A, B, p, q, guides);
  assert.ok(!res.fail, 'fit fehlgeschlagen: ' + res.fail);
  assert.equal(res.curve.type, 'bspline');
  // Endpunkte exakt, alle Stützpunkte auf beiden Flächen
  near(res.pts[0], p, 1e-12, 'p');
  near(res.pts[res.pts.length - 1], q, 1e-12, 'q');
  for (const pt of res.pts) {
    close(Math.abs(sdist(A, pt)), 0, 1e-9, 'stützpunkt A');
    close(Math.abs(sdist(B, pt)), 0, 1e-9, 'stützpunkt B');
  }
  let maxErr = 0;
  for (let i = 0; i <= 200; i++) {
    const e = evalBspline(res.curve, i / 200);
    const err = Math.max(Math.abs(sdist(A, e)), Math.abs(sdist(B, e)));
    if (err > maxErr) maxErr = err;
  }
  assert.ok(maxErr <= 5e-7, 'maxFehler ' + maxErr);
});

// ── 6) Kreis-Stützpunkte: positive Umlaufrichtung ──────────────────────────
test('sampleCurve viertelbogen läuft über m (positive seite)', () => {
  const circ = { type: 'circle', c: [0, 0, 0], a: [0, 0, 1], R: 5, x: [1, 0, 0] };
  const p = [5, 0, 0];
  const q = [0, 5, 0];
  const m = [5 / Math.SQRT2, 5 / Math.SQRT2, 0];
  assert.ok(onArc(circ, p, q, m), 'm nicht auf dem positiven bogen');
  const s = sampleCurve(circ, p, q);
  assert.equal(s.length, 16, 'anzahl stützpunkte');
  const tp = angleAround(circ, p);
  const tq = angleAround(circ, q);
  const span = (tq - tp + 2 * Math.PI) % (2 * Math.PI);
  let best = Infinity;
  for (const e of s) {
    close(len(sub(e, circ.c)), 5, 1e-9, 'radius');
    const rel = (angleAround(circ, e) - tp + 2 * Math.PI) % (2 * Math.PI);
    assert.ok(rel <= span + 1e-9, 'stützpunkt außerhalb des positiven bogens: rel=' + rel);
    best = Math.min(best, len(sub(e, m)));
  }
  assert.ok(best < 0.3, 'kein stützpunkt nahe m: ' + best);
});

// ── 7) Marschierender B-Spline-Fit ─────────────────────────────────────────
// Torus (Rm=20, r=0,5) und Punkte auf seiner Oberfläche
const RM = 20, RR = 0.5;
const TOR = { type: 'torus', c: [0, 0, 0], a: [0, 0, 1], Rm: RM, r: RR };
const torPt = (th, ph) => [
  (RM + RR * Math.cos(ph)) * Math.cos(th),
  (RM + RR * Math.cos(ph)) * Math.sin(th),
  RR * Math.sin(ph),
];
// größter Abstand der Kurve zu beiden Flächen
function fitError(A, B, curve, n = 400) {
  let m = 0;
  for (let i = 0; i <= n; i++) {
    const e = evalBspline(curve, i / n);
    m = Math.max(m, Math.abs(sdist(A, e)), Math.abs(sdist(B, e)));
  }
  return m;
}

// (a) Ebene 5° schräg zur Torusachse, zwei Punkte 1,5 mm auseinander
test('fitIntersectionCurve ebene ∩ torus (5°) → bspline ≤ 5e-7', () => {
  const beta = 5 * Math.PI / 180;
  // ebene durch den äquator-punkt des torus, normale 5° von der achse weg
  const PL = { type: 'plane', o: torPt(0, 0), n: [Math.sin(beta), 0, Math.cos(beta)] };
  const eqPt = (th) => [(RM + RR) * Math.cos(th), (RM + RR) * Math.sin(th), 0];
  const rp = projectMulti([TOR, PL], eqPt(0.02));
  const rq = projectMulti([TOR, PL], eqPt(0.02 + 1.5 / (RM + RR)));
  assert.ok(rp.ok && rq.ok, 'endpunkte nicht projizierbar');
  const p = rp.x, q = rq.x;
  close(len(sub(q, p)), 1.5, 0.02, 'kettenlänge');
  close(Math.abs(sdist(TOR, p)), 0, 1e-9, 'p auf torus');
  close(Math.abs(sdist(PL, p)), 0, 1e-9, 'p auf ebene');
  close(Math.abs(sdist(TOR, q)), 0, 1e-9, 'q auf torus');
  close(Math.abs(sdist(PL, q)), 0, 1e-9, 'q auf ebene');
  // ohne führungsstützpunkte: marschieren über die sehnenlänge
  const res = fitIntersectionCurve(TOR, PL, p, q, []);
  assert.ok(!res.fail, 'fit fehlgeschlagen: ' + res.fail);
  assert.equal(res.curve.type, 'bspline');
  near(res.pts[0], p, 1e-12, 'p');
  near(res.pts[res.pts.length - 1], q, 1e-12, 'q');
  const err = fitError(TOR, PL, res.curve);
  assert.ok(err <= 5e-7, 'maxFehler ' + err);
  // mit führungsstützpunkten auf der kurve
  const guides = [];
  for (const t of [0.25, 0.5, 0.75]) {
    const g = projectMulti([TOR, PL], add(p, mul(sub(q, p), t)));
    assert.ok(g.ok, 'führungspunkt nicht projizierbar');
    guides.push(g.x);
  }
  const res2 = fitIntersectionCurve(TOR, PL, p, q, guides);
  assert.ok(!res2.fail, 'fit (mit guides) fehlgeschlagen: ' + res2.fail);
  const err2 = fitError(TOR, PL, res2.curve);
  assert.ok(err2 <= 5e-7, 'maxFehler (mit guides) ' + err2);
});

// (b) Ebene durch drei Toruspunkte (Facetten-Dreieck aus einer Verrundung)
test('fitIntersectionCurve ebene durch 3 toruspunkte ∩ torus → bspline', () => {
  const A = torPt(0, 0);          // äquator
  const B = torPt(0.05, 0);       // äquator, 1 mm weiter
  const C = torPt(0.025, -0.6);   // in die röhre hinein
  const PL = { type: 'plane', o: A, n: norm(cross(sub(B, A), sub(C, A))) };
  for (const pt of [A, B, C]) {
    close(Math.abs(sdist(TOR, pt)), 0, 1e-9, 'punkt auf torus');
    close(Math.abs(sdist(PL, pt)), 0, 1e-9, 'punkt auf ebene');
  }
  const res = fitIntersectionCurve(TOR, PL, A, B, []);
  assert.ok(!res.fail, 'fit fehlgeschlagen: ' + res.fail);
  assert.equal(res.curve.type, 'bspline');
  const err = fitError(TOR, PL, res.curve);
  assert.ok(err <= 5e-7, 'maxFehler ' + err);
  // mit Führungspunkten auf der Kurve (wie Netzpunkte einer Kette)
  const guides = [];
  for (const t of [0.2, 0.5, 0.8]) {
    const g = projectMulti([TOR, PL], [(RM + RR) * Math.cos(0.05 * t), (RM + RR) * Math.sin(0.05 * t), 0]);
    assert.ok(g.ok, 'führungspunkt nicht projizierbar');
    guides.push(g.x);
  }
  const res2 = fitIntersectionCurve(TOR, PL, A, B, guides);
  assert.ok(!res2.fail, 'fit (mit guides) fehlgeschlagen: ' + res2.fail);
  const err2 = fitError(TOR, PL, res2.curve);
  assert.ok(err2 <= 5e-7, 'maxFehler (mit guides) ' + err2);
});

// (c) verrauschte Führungspunkte mit Fast-Doppel-Punkten
test('fitIntersectionCurve mit verrauschten führungsstützpunkten → bspline', () => {
  const A = { type: 'cylinder', o: [0, 0, 0], a: [0, 0, 1], R: 2 };
  const B = { type: 'cylinder', o: [0, 0, 0], a: [1, 0, 0], R: 1.5 };
  const rp = projectMulti([A, B], [1.65, -1.13, 0.99]);
  const rq = projectMulti([A, B], [1.65, 1.13, 0.99]);
  assert.ok(rp.ok && rq.ok, 'startpunkte nicht gefunden');
  const p = rp.x, q = rq.x;
  const guides = [];
  for (const phi of [-0.5, -0.25, 0, 0.25, 0.5]) {
    const g = [2 * Math.cos(phi), 2 * Math.sin(phi), Math.sqrt(Math.max(0, 2.25 - 4 * Math.sin(phi) ** 2))];
    const rg = projectMulti([A, B], g);
    assert.ok(rg.ok, 'führungspunkt ' + phi + ' nicht projizierbar');
    // rauschen ±0,01 mm und Fast-Doppel-Punkt anhängen
    const d = norm([rnd() - 0.5, rnd() - 0.5, rnd() - 0.5]);
    const nv = add(rg.x, mul(d, 0.01 * (rnd() < 0.5 ? -1 : 1)));
    guides.push(nv);
    guides.push(add(nv, mul(d, 1e-4)));
  }
  const res = fitIntersectionCurve(A, B, p, q, guides);
  assert.ok(!res.fail, 'fit fehlgeschlagen: ' + res.fail);
  assert.equal(res.curve.type, 'bspline');
  const err = fitError(A, B, res.curve);
  assert.ok(err <= 5e-7, 'maxFehler ' + err);
});

// (d) lange Kette: Kugel ∩ Ebene → Kreis (analytischer Pfad)
test('fitIntersectionCurve kugel ∩ ebene (20°, 40 mm) → kreis', () => {
  const S = { type: 'sphere', c: [0, 0, 0], R: 300 };
  const ang = 20 * Math.PI / 180;
  const n = [Math.sin(ang), 0, Math.cos(ang)];
  const d = 150;                                    // Abstand Ebene–Kugelmittelpunkt
  const PL = { type: 'plane', o: mul(n, d), n };
  const Rc = Math.sqrt(300 * 300 - d * d);          // Radius des Schnittkreises
  const ex = norm(cross(n, [0, 1, 0]));             // Basis in der Ebene
  const ey = norm(cross(n, ex));
  const centre = mul(n, d);
  const at = (t) => add(centre, add(mul(ex, Rc * Math.cos(t)), mul(ey, Rc * Math.sin(t))));
  const half = 20 / Rc;                            // halbe Bogenlänge 20 mm
  const p = at(-half), q = at(half), m = at(0);
  close(2 * Rc * half, 40, 1e-9, 'bogenlänge');
  close(Math.abs(sdist(S, p)), 0, 1e-9, 'p auf kugel');
  close(Math.abs(sdist(PL, p)), 0, 1e-9, 'p auf ebene');
  const res = fitIntersectionCurve(S, PL, p, q, [m]);
  assert.ok(!res.fail, 'fit fehlgeschlagen: ' + res.fail);
  assert.equal(res.curve.type, 'circle', 'kein analytischer kreis');
  close(res.curve.R, Rc, 1e-6, 'R');
  near(res.curve.c, centre, 1e-9, 'kreismitte');
  // der positive Bogen enthält m
  assert.ok(onArc(res.curve, p, q, m), 'm nicht auf dem positiven bogen');
});

// ── 8) Linsen-Fall: Facetten-Ebene ∩ Verrundung ─────────────────────────────
// Die Ebene eines Facetten-Dreiecks (alle 3 Ecken auf der Verrundung)
// schneidet die Verrundung in einer geschlossenen "Linse". Die Kette einer
// Dreiecksseite muss dem Bogen NEBEN der Sehne folgen und darf nicht auf den
// Nachbarbogen der Linse springen (Faltung).

// Ebene durch 3 Punkte (Normale = Kreuzprodukt der Kanten)
function planeThrough(a, b, c) {
  return { type: 'plane', o: [a[0], a[1], a[2]], n: norm(cross(sub(b, a), sub(c, a))) };
}

// größter Abstand der Punkte zur Strecke p→q
function distToChord(pts, p, q) {
  const d = sub(q, p);
  const L2 = dot(d, d);
  let m = 0;
  for (const x of pts) {
    const w = sub(x, p);
    const t = L2 > 0 ? Math.max(0, Math.min(1, dot(w, d) / L2)) : 0;
    const dist = len(sub(w, mul(d, t)));
    if (dist > m) m = dist;
  }
  return m;
}

// alte Fit-Variante (nur 2 Bedingungen, freie Minimalnorm-Projektion) zum Vergleich
function oldFit(A, B, p, q) {
  const tol = 5e-7;
  const d = sub(q, p);
  const Ls = len(d);
  if (!(Ls > 1e-12)) return { fail: 'degen' };
  const maxShift = Math.min(0.5, Math.max(0.05, 0.5 * Ls));
  const proj = new Map();
  for (const n of [4, 8, 16, 32, 64, 128]) {
    const pts = [p];
    for (let i = 1; i < n; i++) {
      const key = i / n;
      let x = proj.get(key);
      if (!x) {
        const x0 = add(p, mul(d, i / n));
        const r = projectMulti([A, B], x0);
        if (!r.ok) return { fail: 'projectMulti' };
        const shift = len(sub(r.x, x0));
        if (shift > maxShift) return { fail: 'shift', detail: shift };
        x = r.x;
        proj.set(key, x);
      }
      if (!(pts.length && len(sub(pts[pts.length - 1], x)) < 1e-6)) pts.push(x);
    }
    if (!(pts.length && len(sub(pts[pts.length - 1], q)) < 1e-6)) pts.push(q);
    for (let i = 1; i < pts.length - 1; i++) {
      const d1 = sub(pts[i], pts[i - 1]);
      const d2 = sub(pts[i + 1], pts[i]);
      if (len(d1) > 1e-9 && len(d2) > 1e-9 && dot(d1, d2) <= 0) return { fail: 'fold', detail: i };
    }
    const c = interpCubic(pts);
    if (!c) return { fail: 'interp' };
    let maxErr = 0;
    for (let i = 0; i < c.params.length - 1; i++) {
      const u0 = c.params[i];
      const u1 = c.params[i + 1];
      for (let k = 1; k < 8; k++) {
        const e = evalBspline(c, u0 + (u1 - u0) * (k / 8));
        maxErr = Math.max(maxErr, Math.abs(sdist(A, e)), Math.abs(sdist(B, e)));
      }
    }
    if (maxErr <= tol) return { curve: c, pts, err: maxErr };
  }
  return { fail: 'maxPts' };
}

// (a) Facetten-Dreieck auf einer Torus-Verrundung: die Ebene schneidet die
// Verrundung in einer geschlossenen "Linse" durch alle 3 Ecken. Jede Seite
// des Dreiecks ist eine Kette, die auf beiden Flächen liegen muss.
test('fitIntersectionCurve linse: ebene ∩ torus (3 dreiecksseiten)', () => {
  const D = Math.PI / 180;
  const TOR = { type: 'torus', c: [0, 0, 0], a: [0, 0, 1], Rm: RM, r: RR };
  // Ecken auf der Verrundung: 2° Rohr, 0,5° Achse
  const P1 = torPt(0, -1 * D);
  const P2 = torPt(0.5 * D, 0);
  const P3 = torPt(0, 1 * D);
  const PL = planeThrough(P1, P2, P3);
  for (const pt of [P1, P2, P3]) {
    close(Math.abs(sdist(TOR, pt)), 0, 1e-9, 'ecke auf torus');
    close(Math.abs(sdist(PL, pt)), 0, 1e-9, 'ecke auf ebene');
  }
  const sides = [[P1, P2], [P2, P3], [P3, P1]];
  for (const [p, q] of sides) {
    const res = fitIntersectionCurve(PL, TOR, p, q, []);
    assert.ok(!res.fail, 'fit fehlgeschlagen: ' + res.fail + ' ' + res.detail);
    assert.equal(res.curve.type, 'bspline');
    near(res.pts[0], p, 1e-12, 'p');
    near(res.pts[res.pts.length - 1], q, 1e-12, 'q');
    // Restfehler der Kurve auf beiden Flächen (400 Stützpunkte)
    const err = fitError(PL, TOR, res.curve, 400);
    assert.ok(err <= 5e-7, 'maxFehler ' + err);
    // die Stützpunkte bleiben neben der Sehne (Bogen der Linse, kein Nachbarbogen)
    const d = distToChord(res.pts, p, q);
    assert.ok(d <= 0.05, 'abstand zur sehne ' + d);
  }
  // Regressionszeuge: ohne die Querschnitt-Bedingung (freie Minimalnorm-
  // Projektion) faltet die Linse an der Ecke P3 → der Fit schlägt fehl
  const alt = oldFit(PL, TOR, P3, P1);
  assert.ok(alt.fail, 'ohne Querschnitt-Ebene wäre kein Fehler aufgetreten');
  assert.equal(alt.fail, 'fold', 'erwartet Faltung, war ' + alt.fail);
});

// (b) dasselbe mit einer zylindrischen Verrundung (R = 0,5): 12° Rohr,
// 1° um die Torusachse (0,358 mm in Achsrichtung)
test('fitIntersectionCurve linse: ebene ∩ zylinder R=0,5 (3 dreiecksseiten)', () => {
  const D = Math.PI / 180;
  const CYL = { type: 'cylinder', o: [20, 0, 0], a: [0, 1, 0], R: RR };
  const cylPt = (phi, y) => [20 + RR * Math.cos(phi), y, RR * Math.sin(phi)];
  const P1 = cylPt(0, 0);
  const P2 = cylPt(6 * D, 0.1789);
  const P3 = cylPt(12 * D, 0.3578);
  const PL = planeThrough(P1, P2, P3);
  for (const pt of [P1, P2, P3]) {
    close(Math.abs(sdist(CYL, pt)), 0, 1e-9, 'ecke auf zylinder');
    close(Math.abs(sdist(PL, pt)), 0, 1e-9, 'ecke auf ebene');
  }
  const sides = [[P1, P2], [P2, P3], [P3, P1]];
  for (const [p, q] of sides) {
    const res = fitIntersectionCurve(PL, CYL, p, q, []);
    assert.ok(!res.fail, 'fit fehlgeschlagen: ' + res.fail + ' ' + res.detail);
    assert.equal(res.curve.type, 'bspline');
    near(res.pts[0], p, 1e-12, 'p');
    near(res.pts[res.pts.length - 1], q, 1e-12, 'q');
    const err = fitError(PL, CYL, res.curve, 400);
    assert.ok(err <= 5e-7, 'maxFehler ' + err);
    const d = distToChord(res.pts, p, q);
    assert.ok(d <= 0.05, 'abstand zur sehne ' + d);
  }
});

if (failed) {
  console.log('FAIL ' + failed + ' Fall(e)');
  process.exit(1);
}
console.log('alle Fälle ok');

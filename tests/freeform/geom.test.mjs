// Tests für freeform-geom.js — Vektoren, sdist/normalAt/project, projectMulti,
// analytische Schnittkurven, B-Splines, Kurvenfit.
// Eigene Zahlen, keine Projektdateien als Quelle.
import assert from 'node:assert/strict';
import {
  add, sub, mul, dot, cross, len, norm,
  sdist, normalAt, project,
  projectMulti, analyticCurve, interpCubic, evalBspline, fitIntersectionCurve,
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

if (failed) {
  console.log('FAIL ' + failed + ' Fall(e)');
  process.exit(1);
}
console.log('alle Fälle ok');

// Tests für freeform-nurbs.js — exakte B-Spline-Kurveoperationen, Coons-Patch,
// Flächenprojektion und Kurvenfit auf analytischen Flächen.
// Eigene Zahlen, feste Zufallsfolge (Seed), alles rotiert + verschoben,
// damit nichts achsenparallel ist.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  lineToBspline, evalCurve, reverseCurve, reparamCurve, elevateCurve, refineCurve,
  splitCurve, joinCurves, makeCompatible, coonsPatch,
  evalSurface, surfaceDerivs, surfaceNormal, projectToSurface,
  fitCurveOnSurface, interpPolyline,
} from '../../freeform-nurbs.js';
import { interpCubic, sdist, len, sub, add, mul, dot, norm, cross, normalAt } from '../../freeform-geom.js';

// ── Hilfen: Zufall, Rotation ────────────────────────────────────────────────

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(20261029);

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
// lokale Punktkoordinaten → gedrehte + verschobene Weltkoordinaten
const xf = (p) => add([dot(ROT[0], p), dot(ROT[1], p), dot(ROT[2], p)], SHIFT);
// Richtung (ohne Verschiebung) → gedreht
const xfDir = (p) => [dot(ROT[0], p), dot(ROT[1], p), dot(ROT[2], p)];

const dev = (a, b) => len(sub(a, b));
const scaleOf = (c) => {
  let s = 1;
  for (const p of c.ctrl) s = Math.max(s, len(p));
  return s;
};
const cscale = (list) => list.reduce((m, c) => Math.max(m, scaleOf(c)), 1);

// zufällige geklemmte kubische B-Spline-Kurve von A nach B mit n Kontrollpunkten
function randCubic(A, B, n, rr) {
  const nInt = n - 4;
  const ints = [];
  for (let i = 0; i < nInt; i++) {
    ints.push((i + 1) / (nInt + 1) + (rr() - 0.5) * 0.5 / (nInt + 1));
  }
  ints.sort((a, b) => a - b);
  const knots = [0, ...ints, 1];
  const mults = [4, ...ints.map(() => 1), 4];
  const ctrl = [A.slice()];
  for (let i = 0; i < n - 2; i++) ctrl.push(xf([rr() * 8 - 4, rr() * 8 - 4, rr() * 8 - 4]));
  ctrl.push(B.slice());
  return { type: 'bspline', degree: 3, ctrl, knots, mults };
}

// Abstand eines Punktes zu einer Kurve (grob + Verfeinerung)
function distToCurve(c, p) {
  const a = c.knots[0];
  const b = c.knots[c.knots.length - 1];
  let best = Infinity;
  let bu = a;
  const n = 500;
  for (let i = 0; i <= n; i++) {
    const u = a + ((b - a) * i) / n;
    const d = dev(evalCurve(c, u), p);
    if (d < best) { best = d; bu = u; }
  }
  let step = (b - a) / n;
  for (let it = 0; it < 60; it++) {
    step *= 0.5;
    for (const u of [bu - step, bu + step]) {
      if (u < a || u > b) continue;
      const d = dev(evalCurve(c, u), p);
      if (d < best) { best = d; bu = u; }
    }
  }
  return best;
}

// ── 1) Grad-Erhöhung, Knoten einfügen, Umkehren, Umparametrisieren ──────────

test('elevate/refine/reverse/reparam: Kurve bleibt geometrisch gleich', () => {
  const c = randCubic(xf([0, 0, 0]), xf([9, 3, -4]), 7, rng);
  const s = cscale([c]);
  const tol = 1e-12 * s;
  // Grad-Erhöhung 3 → 5
  const e = elevateCurve(c, 5);
  assert.ok(e, 'elevateCurve liefert eine Kurve');
  assert.equal(e.degree, 5);
  for (let i = 0; i <= 200; i++) {
    const u = i / 200;
    assert.ok(dev(evalCurve(c, u), evalCurve(e, u)) <= tol, `elevate bei u=${u}`);
  }
  // Knoten einfügen
  const r = refineCurve(c, [0.21, 0.55, 0.83]);
  assert.ok(r, 'refineCurve liefert eine Kurve');
  for (let i = 0; i <= 200; i++) {
    const u = i / 200;
    assert.ok(dev(evalCurve(c, u), evalCurve(r, u)) <= tol, `refine bei u=${u}`);
  }
  // Umkehren: rev(u) = c(a+b-u), gleiche Domäne
  const rv = reverseCurve(c);
  assert.equal(rv.knots[0], c.knots[0]);
  assert.equal(rv.knots[rv.knots.length - 1], c.knots[c.knots.length - 1]);
  for (let i = 0; i <= 200; i++) {
    const u = i / 200;
    assert.ok(dev(evalCurve(rv, u), evalCurve(c, 1 - u)) <= tol, `reverse bei u=${u}`);
  }
  // Umparametrisieren auf [2,5]
  const rp = reparamCurve(c, 2, 5);
  for (let i = 0; i <= 200; i++) {
    const t = i / 200;
    assert.ok(dev(evalCurve(rp, 2 + 3 * t), evalCurve(c, t)) <= tol, `reparam bei t=${t}`);
  }
});

// ── 2) Splitten und Verbinden ───────────────────────────────────────────────

test('splitCurve + joinCurves reproduziert die Kurve', () => {
  const c = randCubic(xf([1, 2, 3]), xf([-4, 7, 2]), 8, rng);
  const s = cscale([c]);
  const tol = 1e-12 * s;
  const parts = splitCurve(c, 0.37);
  assert.ok(parts && parts.length === 2, 'splitCurve liefert zwei Teile');
  const j = joinCurves(parts);
  assert.ok(j, 'joinCurves liefert eine Kurve');
  assert.equal(j.degree, c.degree);
  // gleiche Geometrie (die Parametrisierung wird von joinCurves neu gesetzt)
  for (let i = 0; i <= 60; i++) {
    const u = i / 60;
    assert.ok(distToCurve(c, evalCurve(j, u)) <= tol, `join bei u=${u}`);
  }
});

test('joinCurves: Gerade + Bogen + Gerade (Grad 1,3,1)', () => {
  const A = xf([0, 0, 0]);
  const B = xf([4, 0, 0]);
  const C = xf([6, 5, 1]);
  const M = xf([9, 6, 3]);
  const arcPts = [];
  for (let i = 0; i <= 8; i++) {
    const t = i / 8;
    arcPts.push(xf([4 + 2 * Math.sin(t * Math.PI / 2), 5 * (1 - Math.cos(t * Math.PI / 2)), t]));
  }
  const arc = interpCubic(arcPts);
  assert.ok(arc, 'interpCubic liefert den Bogen');
  const l1 = lineToBspline(A, B);
  const l2 = lineToBspline(C, M);
  const j = joinCurves([l1, arc, l2]);
  assert.ok(j, 'joinCurves verbindet die drei Stücke');
  assert.equal(j.degree, 3);
  const tol = 1e-10;
  for (const piece of [l1, arc, l2]) {
    const [a, b] = [piece.knots[0], piece.knots[piece.knots.length - 1]];
    for (let i = 0; i <= 40; i++) {
      const u = a + ((b - a) * i) / 40;
      const d = distToCurve(j, evalCurve(piece, u));
      assert.ok(d <= tol, `Stück ${i}: Abstand ${d}`);
    }
  }
});

// ── 5) Verrundungsstreifen am Viertelzylinder ──────────────────────────────

test('coonsPatch: Verrundungsstreifen am Viertelzylinder', () => {
  const R = 0.5;
  const L = 6;
  const rail = (ang) => lineToBspline(
    xf([R * Math.cos(ang), R * Math.sin(ang), 0]),
    xf([R * Math.cos(ang), R * Math.sin(ang), L]),
  );
  const arc = (z) => {
    const pts = [];
    for (let i = 0; i <= 8; i++) {
      const t = (i / 8) * (Math.PI / 2);
      pts.push(xf([R * Math.cos(t), R * Math.sin(t), z]));
    }
    return interpCubic(pts);
  };
  const c0 = rail(0);
  const c1 = rail(Math.PI / 2);
  const d0 = arc(0);
  const d1 = arc(L);
  const S = coonsPatch(c0, c1, d0, d1);
  assert.ok(S, 'coonsPatch liefert die Streifenfläche');
  // echter Zylinder zum Vergleich
  const cyl = { type: 'cylinder', o: xf([0, 0, 0]), a: xfDir([0, 0, 1]), R };
  // Fläche liegt auf dem Zylinder (20x20 Gitter, Abweichung < 2e-3 mm)
  for (let i = 0; i <= 20; i++) {
    for (let j = 0; j <= 20; j++) {
      const p = evalSurface(S, i / 20, j / 20);
      const e = Math.abs(sdist(cyl, p));
      assert.ok(e <= 2e-3, `Zylinderabweichung ${e} bei (${i / 20},${j / 20})`);
    }
  }
  // Ränder exakt
  const scale = cscale([c0, c1, d0, d1]);
  const tol = 1e-10 * scale;
  for (let i = 0; i <= 50; i++) {
    const u = i / 50;
    assert.ok(dev(evalSurface(S, u, 0), evalCurve(c0, u)) <= tol, `c0 bei u=${u}`);
    assert.ok(dev(evalSurface(S, u, 1), evalCurve(c1, u)) <= tol, `c1 bei u=${u}`);
  }
  for (let i = 0; i <= 50; i++) {
    const v = i / 50;
    assert.ok(dev(evalSurface(S, 0, v), evalCurve(d0, v)) <= tol, `d0 bei v=${v}`);
    assert.ok(dev(evalSurface(S, 1, v), evalCurve(d1, v)) <= tol, `d1 bei v=${v}`);
  }
  // Normalen und Ableitungen: endlich, Normalen unitär
  for (let i = 1; i < 10; i++) {
    for (let j = 1; j < 10; j++) {
      const n = surfaceNormal(S, i / 10, j / 10);
      assert.ok(n && Math.abs(len(n) - 1) < 1e-9, 'Normale unitär');
      const d = surfaceDerivs(S, i / 10, j / 10);
      assert.ok(d.P.every((x) => Number.isFinite(x)), 'Ableitung endlich');
    }
  }
  // Ableitungen gegen finite Differenzen prüfen
  const h = 1e-5;
  for (const [u, v] of [[0.2, 0.3], [0.55, 0.8], [0.9, 0.05]]) {
    const d = surfaceDerivs(S, u, v);
    const du = mul(sub(evalSurface(S, u + h, v), evalSurface(S, u - h, v)), 1 / (2 * h));
    const dv = mul(sub(evalSurface(S, u, v + h), evalSurface(S, u, v - h)), 1 / (2 * h));
    assert.ok(dev(d.Su, du) < 1e-5, `Su bei (${u},${v}): ${dev(d.Su, du)}`);
    assert.ok(dev(d.Sv, dv) < 1e-5, `Sv bei (${u},${v}): ${dev(d.Sv, dv)}`);
    assert.ok(dev(d.P, evalSurface(S, u, v)) < 1e-9, `P bei (${u},${v})`);
  }
});

// ── 3) Coons-Patch mit vier zufälligen kubischen Kurven ────────────────────

test('coonsPatch: vier zufällige Kurven, Ränder exakt', () => {
  const A = xf([0, 0, 0]);
  const B = xf([12, 1, -2]);
  const C = xf([1, 9, 3]);
  const D = xf([13, 8, 5]);
  const c0 = randCubic(A, B, 4, rng);
  const c1 = randCubic(C, D, 7, rng);
  const d0 = randCubic(A, C, 9, rng);
  const d1 = randCubic(B, D, 5, rng);
  const S = coonsPatch(c0, c1, d0, d1);
  assert.ok(S, 'coonsPatch liefert eine Fläche');
  assert.equal(S.type, 'bspline_surface');
  const scale = cscale([c0, c1, d0, d1]);
  const tol = 1e-10 * scale;
  // Ränder: S(u,0)=c0, S(u,1)=c1, S(0,v)=d0, S(1,v)=d1
  for (let i = 0; i <= 50; i++) {
    const u = i / 50;
    assert.ok(dev(evalSurface(S, u, 0), evalCurve(c0, u)) <= tol, `c0 bei u=${u}`);
    assert.ok(dev(evalSurface(S, u, 1), evalCurve(c1, u)) <= tol, `c1 bei u=${u}`);
  }
  for (let i = 0; i <= 50; i++) {
    const v = i / 50;
    assert.ok(dev(evalSurface(S, 0, v), evalCurve(d0, v)) <= tol, `d0 bei v=${v}`);
    assert.ok(dev(evalSurface(S, 1, v), evalCurve(d1, v)) <= tol, `d1 bei v=${v}`);
  }
  // Inneres: endlich und in der Nähe der Fläche
  for (let i = 1; i < 20; i++) {
    for (let j = 1; j < 20; j++) {
      const p = evalSurface(S, i / 20, j / 20);
      assert.ok(p.every((x) => Number.isFinite(x)), 'Innenpunkt endlich');
    }
  }
});

// ── 4) Coons-Patch mit verkürzter Seite (Punktkurve) ────────────────────────

test('coonsPatch: dreiseitiges Patch mit Punktseite', () => {
  const P = xf([2, 3, 1]);
  const B = xf([12, 1, -2]);
  const C = xf([13, 8, 5]);
  const c0 = randCubic(P, B, 6, rng);
  const c1 = randCubic(P, C, 4, rng);
  const d0 = { type: 'bspline', degree: 3, ctrl: [P, P, P, P], knots: [0, 1], mults: [4, 4] };
  const d1 = randCubic(B, C, 8, rng);
  const S = coonsPatch(c0, c1, d0, d1);
  assert.ok(S, 'coonsPatch liefert eine Fläche');
  const scale = cscale([c0, c1, d1]);
  const tol = 1e-10 * scale;
  for (let i = 0; i <= 50; i++) {
    const u = i / 50;
    assert.ok(dev(evalSurface(S, u, 0), evalCurve(c0, u)) <= tol, `c0 bei u=${u}`);
    assert.ok(dev(evalSurface(S, u, 1), evalCurve(c1, u)) <= tol, `c1 bei u=${u}`);
  }
  for (let i = 0; i <= 50; i++) {
    const v = i / 50;
    assert.ok(dev(evalSurface(S, 1, v), evalCurve(d1, v)) <= tol, `d1 bei v=${v}`);
    // die verkürzte Seite ist konstant der Punkt P
    assert.ok(dev(evalSurface(S, 0, v), P) <= tol, `Punktseite bei v=${v}`);
  }
});

// ── 6) Kurvenfit auf analytischen Flächen ──────────────────────────────────

// Einheitsvektor senkrecht zu a (a ist Einheitsvektor)
function perpTo(a) {
  const t = Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const d = sub(t, mul(a, dot(t, a)));
  return norm(d);
}

test('fitCurveOnSurface: Ebene, Zylinder, Kugel, Torus', () => {
  const cases = [];
  // Ebene: Gerade in der Ebene
  {
    const n = norm(xfDir([0.31, -0.82, 0.48]));
    const o = xf([1, 2, 3]);
    const d = perpTo(n);
    cases.push({
      name: 'Ebene',
      surf: { type: 'plane', o, n },
      curve: (t) => add(o, mul(d, t * 7)),
    });
  }
  // Zylinder: Wendel
  for (const R of [0.5, 5]) {
    const a = norm(xfDir([0.2, 0.5, -0.84]));
    const o = xf([0, 0, 0]);
    const e1 = perpTo(a);
    const e2 = norm(cross(a, e1));
    cases.push({
      name: `Zylinder R=${R}`,
      surf: { type: 'cylinder', o, a, R },
      curve: (t) => add(add(o, mul(e1, R * Math.cos(0.25 * Math.PI * t))),
        add(mul(e2, R * Math.sin(0.25 * Math.PI * t)), mul(a, t * 4))),
    });
  }
  // Kugel: Kreisbogen (120°)
  {
    const c = xf([2, -1, 4]);
    const R = 2;
    const e1 = norm(xfDir([1, 0, 0]));
    const e2 = norm(xfDir([0, 1, 0]));
    cases.push({
      name: 'Kugel R=2',
      surf: { type: 'sphere', c, R },
      curve: (t) => add(c, add(mul(e1, R * Math.cos((2 * Math.PI / 3) * t)),
        mul(e2, R * Math.sin((2 * Math.PI / 3) * t)))),
    });
  }
  // Torus: Rohrkreis-Bogen (120°) in der Rohrebene
  {
    const c = xf([0, 0, 0]);
    const a = norm(xfDir([0, 0, 1]));
    const Rm = 3;
    const r = 0.5;
    const u = norm(xfDir([1, 0, 0]));
    cases.push({
      name: 'Torus Rm=3 r=0.5',
      surf: { type: 'torus', c, a, Rm, r },
      curve: (t) => add(c, add(mul(u, Rm + r * Math.cos((2 * Math.PI / 3) * t)),
        mul(a, r * Math.sin((2 * Math.PI / 3) * t)))),
    });
  }
  for (const cs of cases) {
    const p = cs.curve(0);
    const q = cs.curve(1);
    // Führungspunkte mit 1e-4 mm Rauschen (in Richtung der Flächennormalen —
    // die Projektion auf die Fläche entfernt es wieder)
    const guides = [];
    for (let i = 1; i < 15; i++) {
      const g = cs.curve(i / 15);
      const nrm = normalAt(cs.surf, g);
      guides.push(add(g, mul(nrm, (rng() - 0.5) * 2e-4)));
    }
    const res = fitCurveOnSurface(cs.surf, p, q, guides);
    assert.ok(res.curve, `${cs.name}: fitCurveOnSurface liefert eine Kurve `
      + `(fail=${res.fail} err=${res.err} detail=${res.detail} `
      + `pts=${res.pts ? JSON.stringify(res.pts.map((x) => x.map((y) => +y.toFixed(5)))) : '-'})`);
    // Endpunkte exakt
    assert.ok(dev(evalCurve(res.curve, 0), p) <= 1e-12, `${cs.name}: Startpunkt exakt`);
    assert.ok(dev(evalCurve(res.curve, 1), q) <= 1e-12, `${cs.name}: Endpunkt exakt`);
    // die Kurve liegt auf der Fläche
    for (let i = 0; i <= 200; i++) {
      const u = i / 200;
      const e = Math.abs(sdist(cs.surf, evalCurve(res.curve, u)));
      assert.ok(e <= 5e-7, `${cs.name}: Flächenabstand ${e} bei u=${u}`);
    }
  }
});

test('fitCurveOnSurface: meldet Fehler (Enden, Faltung)', () => {
  const n = norm(xfDir([0, 0, 1]));
  const o = xf([0, 0, 0]);
  const surf = { type: 'plane', o, n };
  const d = norm(xfDir([1, 0, 0]));
  const e = norm(xfDir([0, 1, 0]));
  // Endpunkt liegt nicht auf der Fläche
  const bad = fitCurveOnSurface(surf, add(o, [0, 0, 0.01]), add(o, mul(d, 5)), []);
  assert.equal(bad.fail, 'ends');
  assert.ok(!bad.curve, 'keine Kurve bei falschen Endpunkten');
  // Zickzack-Führung → Faltung
  const p = add(o, mul(d, 0));
  const q = add(o, mul(d, 6));
  const g1 = add(o, add(mul(d, 4), mul(e, 3)));
  const g2 = add(o, add(mul(d, 2), mul(e, 0)));
  const zig = fitCurveOnSurface(surf, p, q, [g1, g2]);
  assert.equal(zig.fail, 'fold');
  assert.ok(!zig.curve, 'keine Kurve bei Faltung');
});

// ── 7) Projektion auf die Fläche ────────────────────────────────────────────

// Brute-Force-Projektion: grobes Gitter + lokale Verfeinerung
function bruteProject(S, p, n = 400) {
  const u0 = S.knotsU[0];
  const u1 = S.knotsU[S.knotsU.length - 1];
  const v0 = S.knotsV[0];
  const v1 = S.knotsV[S.knotsV.length - 1];
  let bu = u0;
  let bv = v0;
  let bd = Infinity;
  for (let i = 0; i <= n; i++) {
    const u = u0 + ((u1 - u0) * i) / n;
    for (let j = 0; j <= n; j++) {
      const v = v0 + ((v1 - v0) * j) / n;
      const d = dev(evalSurface(S, u, v), p);
      if (d < bd) { bd = d; bu = u; bv = v; }
    }
  }
  // lokal verfeinern (kleinere Gitter rund um den Treffer)
  let ru = (u1 - u0) / n;
  let rv = (v1 - v0) / n;
  for (let round = 0; round < 6; round++) {
    let nb = bd;
    let nu = bu;
    let nv = bv;
    for (let i = -8; i <= 8; i++) {
      for (let j = -8; j <= 8; j++) {
        const u = bu + (ru * i) / 8;
        const v = bv + (rv * j) / 8;
        if (u < u0 || u > u1 || v < v0 || v > v1) continue;
        const d = dev(evalSurface(S, u, v), p);
        if (d < nb) { nb = d; nu = u; nv = v; }
      }
    }
    bd = nb; bu = nu; bv = nv;
    ru /= 8;
    rv /= 8;
  }
  return bd;
}

test('projectToSurface: stimmt mit Brute-Force überein', () => {
  const R = 0.5;
  const L = 6;
  const rail = (ang) => lineToBspline(
    xf([R * Math.cos(ang), R * Math.sin(ang), 0]),
    xf([R * Math.cos(ang), R * Math.sin(ang), L]),
  );
  const arc = (z) => {
    const pts = [];
    for (let i = 0; i <= 8; i++) {
      const t = (i / 8) * (Math.PI / 2);
      pts.push(xf([R * Math.cos(t), R * Math.sin(t), z]));
    }
    return interpCubic(pts);
  };
  const S = coonsPatch(rail(0), rail(Math.PI / 2), arc(0), arc(L));
  assert.ok(S, 'Streifenfläche');
  for (let i = 0; i < 8; i++) {
    const u = rng();
    const v = rng();
    const base = evalSurface(S, u, v);
    // Punkt in der Nähe der Fläche
    const p = add(base, [(rng() - 0.5) * 0.6, (rng() - 0.5) * 0.6, (rng() - 0.5) * 0.6]);
    const pr = projectToSurface(S, p);
    assert.ok(pr, 'Projektion liefert ein Ergebnis');
    const bf = bruteProject(S, p);
    assert.ok(Math.abs(pr.dist - bf) <= 1e-6, `Abstand ${pr.dist} vs Brute ${bf} `
      + `u=${pr.u} v=${pr.v} punkt=${JSON.stringify(p.map((x) => +x.toFixed(4)))}`);
    assert.ok(dev(pr.x, evalSurface(S, pr.u, pr.v)) <= 1e-9, 'Projektionspunkt passt zum Parameter');
  }
});

test('joinCurves: C0-Variante (opts.c0Joint) mit Vielfachheit = Grad', () => {
  const A = xf([0, 0, 0]);
  const B = xf([4, 0, 0]);
  const C = xf([6, 5, 1]);
  const arcPts = [];
  for (let i = 0; i <= 8; i++) {
    const t = i / 8;
    arcPts.push(xf([4 + 2 * Math.sin(t * Math.PI / 2), 5 * (1 - Math.cos(t * Math.PI / 2)), t]));
  }
  const arc = interpCubic(arcPts);
  const l1 = lineToBspline(A, B);
  const l2 = lineToBspline(C, xf([9, 6, 3]));
  const j = joinCurves([l1, arc, l2], { c0Joint: true });
  assert.ok(j, 'joinCurves (c0Joint) liefert eine Kurve');
  // Verbindungsstellen mit Vielfachheit = Grad
  const inner = j.mults.slice(1, j.mults.length - 1);
  assert.ok(inner.every((m) => m <= 3), `Vielfachheiten ${JSON.stringify(j.mults)}`);
  assert.ok(inner.some((m) => m === 3), 'mindestens eine Verbindungsstelle mit Grad');
  // die Kurve ist stetig (die Stücke werden durchlaufen)
  const tol = 1e-6;
  for (const piece of [l1, arc, l2]) {
    const [a, b] = [piece.knots[0], piece.knots[piece.knots.length - 1]];
    for (let i = 0; i <= 20; i++) {
      const u = a + ((b - a) * i) / 20;
      const d = distToCurve(j, evalCurve(piece, u));
      assert.ok(d <= tol, `Stück ${i}: Abstand ${d}`);
    }
  }
});

// ── 8) makeCompatible und interpPolyline ────────────────────────────────────

test('makeCompatible: gleicher Grad, gleiche Knoten, gleiche Geometrie', () => {
  const c0 = randCubic(xf([0, 0, 0]), xf([9, 3, -4]), 6, rng);
  const c1 = randCubic(xf([0, 0, 0]), xf([9, 3, -4]), 4, rng);
  const [a2, b2] = makeCompatible(c0, c1);
  assert.ok(a2 && b2, 'makeCompatible liefert zwei Kurven');
  assert.equal(a2.degree, b2.degree);
  assert.equal(a2.degree, Math.max(c0.degree, c1.degree));
  assert.deepEqual(a2.knots, b2.knots);
  assert.deepEqual(a2.mults, b2.mults);
  assert.equal(a2.knots[0], 0);
  assert.equal(a2.knots[a2.knots.length - 1], 1);
  // die Geometrie bleibt erhalten
  const tol = 1e-12 * cscale([c0, c1]);
  for (let i = 0; i <= 100; i++) {
    const u = i / 100;
    assert.ok(dev(evalCurve(a2, u), evalCurve(c0, u)) <= tol, `a2 bei u=${u}`);
    assert.ok(dev(evalCurve(b2, u), evalCurve(c1, u)) <= tol, `b2 bei u=${u}`);
  }
});

test('interpPolyline: Freiraumkurve zwischen zwei Punkten', () => {
  const p = xf([0, 0, 0]);
  const q = xf([10, 4, -2]);
  const guides = [xf([3, 2, 1]), xf([6, 3, 0])];
  const c = interpPolyline(p, q, guides);
  assert.ok(c, 'interpPolyline liefert eine Kurve');
  assert.ok(dev(evalCurve(c, 0), p) <= 1e-12, 'Startpunkt exakt');
  assert.ok(dev(evalCurve(c, 1), q) <= 1e-12, 'Endpunkt exakt');
  // die Kurve läuft nahe an den Führungspunkten vorbei
  const scale = cscale([c]);
  for (const g of guides) {
    assert.ok(distToCurve(c, g) <= 0.05 * scale, 'Führungspunkt nahe der Kurve');
  }
  // Zwischenpunkte endlich
  for (let i = 0; i <= 20; i++) {
    assert.ok(evalCurve(c, i / 20).every((x) => Number.isFinite(x)), 'Zwischenpunkt endlich');
  }
});

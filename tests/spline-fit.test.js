// Tests für spline-fit.js — exakte kubische B-Spline-INTERPOLATION durch Netzpunkte.
// Eigene Generatoren, keine Projektdateien als Quelle.
import {
  interpolateCubic, evalSpline, derivSpline, splineSamples,
  spanDeviation, translateSpline, nearestParam,
} from '../spline-fit.js';

// ── Hilfen ──────────────────────────────────────────────────────────────────
const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// Kreis in der Ebene z = 7.85, Mitte (200, 80), Radius 3, Bogen 0…250°
const ARC = { c: [200, 80], r: 3, z: 7.85, a0: 0, a1: 250 };
const arcPoint = (deg) => {
  const t = deg * Math.PI / 180;
  return [ARC.c[0] + ARC.r * Math.cos(t), ARC.c[1] + ARC.r * Math.sin(t), ARC.z];
};
const arcPoints = (n) => {
  const out = [];
  for (let i = 0; i < n; i++) {
    const deg = ARC.a0 + (ARC.a1 - ARC.a0) * (n === 1 ? 0 : i / (n - 1));
    out.push(arcPoint(deg));
  }
  return out;
};

// Kubische Bézier (2D, z = 0)
const bezierPoint = (t, P) => {
  const mt = 1 - t;
  const w = [mt * mt * mt, 3 * mt * mt * t, 3 * mt * t * t, t * t * t];
  return [0, 1, 2].map((k) => w.reduce((s, wi, i) => s + wi * P[i][k], 0));
};

// Punkte auf einer Bézier mit gewünschten Bogenlängen-Abständen (gemischt 0.02 / 0.5 mm)
function bezierByArcLength(P, steps) {
  const M = 20000;
  const dense = [];
  for (let i = 0; i <= M; i++) dense.push(bezierPoint(i / M, P));
  const cum = [0];
  for (let i = 1; i <= M; i++) cum.push(cum[i - 1] + dist3(dense[i], dense[i - 1]));
  const at = (s) => {
    let i = 0;
    while (i < M && cum[i + 1] < s) i++;
    const d = cum[i + 1] - cum[i];
    const f = d > 0 ? (s - cum[i]) / d : 0;
    return [0, 1, 2].map((k) => dense[i][k] + f * (dense[i + 1][k] - dense[i][k]));
  };
  const out = [at(0)];
  let s = 0;
  for (const st of steps) {
    if (s + st > cum[M]) break;
    s += st;
    out.push(at(s));
  }
  return out;
}

// Gemeinsame Exaktheitsprüfungen für eine interpolierte Kurve
function checkExact(sp, pts) {
  expect(sp).not.toBeNull();
  // (a) jeder Eingabepunkt liegt auf der Kurve (an seinem eigenen Parameter)
  for (let k = 0; k < pts.length; k++) {
    const q = evalSpline(sp, sp.params[k]);
    expect(dist3(q, pts[k])).toBeLessThanOrEqual(1e-9);
  }
  // (b) Randkontrollpunkte sind bit-identische Kopien der Eingabepunkte
  expect(sp.ctrl[0]).toEqual(pts[0]);
  expect(sp.ctrl[sp.ctrl.length - 1]).toEqual(pts[pts.length - 1]);
  // (c) Knotenvektor: streng aufsteigend, Vielfachheiten passen
  for (let i = 1; i < sp.knots.length; i++) expect(sp.knots[i]).toBeGreaterThan(sp.knots[i - 1]);
  expect(sp.mults.reduce((s, m) => s + m, 0)).toBe(sp.ctrl.length + sp.degree + 1);
  expect(sp.mults[0]).toBe(sp.degree + 1);
  expect(sp.mults[sp.mults.length - 1]).toBe(sp.degree + 1);
  expect(sp.U.length).toBe(sp.ctrl.length + sp.degree + 1);
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('spline-fit.js', () => {
  describe('interpolateCubic — Kreisbogen', () => {
    test('2 Punkte → Grad 1', () => {
      const pts = arcPoints(2);
      const sp = interpolateCubic(pts);
      expect(sp).not.toBeNull();
      expect(sp.degree).toBe(1);
      checkExact(sp, pts);
      for (const c of sp.ctrl) expect(Math.abs(c[2] - ARC.z)).toBeLessThanOrEqual(1e-12);
    });

    test('3 Punkte → Grad 2', () => {
      const pts = arcPoints(3);
      const sp = interpolateCubic(pts);
      expect(sp).not.toBeNull();
      expect(sp.degree).toBe(2);
      checkExact(sp, pts);
      for (const c of sp.ctrl) expect(Math.abs(c[2] - ARC.z)).toBeLessThanOrEqual(1e-12);
    });

    test('4 Punkte → Grad 3', () => {
      const pts = arcPoints(4);
      const sp = interpolateCubic(pts);
      expect(sp).not.toBeNull();
      expect(sp.degree).toBe(3);
      checkExact(sp, pts);
      for (const c of sp.ctrl) expect(Math.abs(c[2] - ARC.z)).toBeLessThanOrEqual(1e-12);
    });

    test('40 Punkte → Grad 3', () => {
      const pts = arcPoints(40);
      const sp = interpolateCubic(pts);
      expect(sp).not.toBeNull();
      expect(sp.degree).toBe(3);
      checkExact(sp, pts);
      for (const c of sp.ctrl) expect(Math.abs(c[2] - ARC.z)).toBeLessThanOrEqual(1e-12);
      // Endpunkte der Kurve exakt
      expect(evalSpline(sp, sp.U[sp.U.length - sp.degree - 1])).toEqual(pts[pts.length - 1]);
    });
  });

  describe('interpolateCubic — S-Kurve (Bézier, ungleichmäßig abgetastet)', () => {
    const P = [[0, 0, 0], [7, 3, 0], [13, -3, 0], [20, 0, 0]];
    const steps = [];
    for (let i = 0; i < 60; i++) steps.push(i % 2 === 0 ? 0.02 : 0.5);
    const pts = bezierByArcLength(P, steps);

    test('Abtastung enthält 0.02-mm- und 0.5-mm-Schritte', () => {
      expect(pts.length).toBeGreaterThan(40);
      const d0 = dist3(pts[0], pts[1]);
      const d1 = dist3(pts[1], pts[2]);
      expect(d0).toBeGreaterThan(0.019);
      expect(d0).toBeLessThan(0.021);
      expect(d1).toBeGreaterThan(0.49);
      expect(d1).toBeLessThan(0.51);
    });

    test('Interpolation ist exakt', () => {
      const sp = interpolateCubic(pts);
      expect(sp).not.toBeNull();
      expect(sp.degree).toBe(3);
      checkExact(sp, pts);
      for (const c of sp.ctrl) expect(Math.abs(c[2])).toBeLessThanOrEqual(1e-12);
    });

    test('Spannweichen-Abweichung < 0.01 mm', () => {
      const sp = interpolateCubic(pts);
      const devs = spanDeviation(sp, pts, 8);
      expect(devs.length).toBe(pts.length - 1);
      for (const d of devs) expect(d).toBeLessThan(0.01);
    });
  });

  describe('interpolateCubic — kollineare Punkte', () => {
    test('Abweichung zur Sehne < 1e-9 mm', () => {
      const pts = [];
      for (let i = 0; i < 8; i++) pts.push([i * 1.0, 0, 0]);
      const sp = interpolateCubic(pts);
      expect(sp).not.toBeNull();
      checkExact(sp, pts);
      const devs = spanDeviation(sp, pts, 8);
      for (const d of devs) expect(d).toBeLessThan(1e-9);
    });
  });

  describe('translateSpline', () => {
    test('verschiebt alle Kontrollpunkte, Ränder exakt gesetzt', () => {
      const pts = arcPoints(6);
      const sp = interpolateCubic(pts);
      const A = [1, 2, 3];
      const B = [4, 5, 6];
      const t = translateSpline(sp, [0, 0, 1], A, B);
      expect(t).not.toBeNull();
      expect(t.ctrl[0]).toEqual(A);
      expect(t.ctrl[t.ctrl.length - 1]).toEqual(B);
      for (let i = 1; i < t.ctrl.length - 1; i++) {
        expect(t.ctrl[i][0]).toBeCloseTo(sp.ctrl[i][0], 12);
        expect(t.ctrl[i][1]).toBeCloseTo(sp.ctrl[i][1], 12);
        expect(t.ctrl[i][2]).toBeCloseTo(sp.ctrl[i][2] + 1, 12);
      }
      // Original bleibt unverändert
      expect(sp.ctrl[0]).toEqual(pts[0]);
      expect(t.knots).toEqual(sp.knots);
      expect(t.mults).toEqual(sp.mults);
      expect(t.params).toEqual(sp.params);
      expect(t.U).toEqual(sp.U);
    });
  });

  describe('Fehlerfälle', () => {
    test('doppelte aufeinanderfolgende Punkte → null', () => {
      expect(interpolateCubic([[0, 0, 0], [0, 0, 0], [1, 0, 0]])).toBeNull();
      expect(interpolateCubic([[0, 0, 0], [1e-10, 0, 0]])).toBeNull();
    });

    test('nur ein Punkt → null', () => {
      expect(interpolateCubic([[0, 0, 0]])).toBeNull();
      expect(interpolateCubic([])).toBeNull();
    });

    test('nicht-endliche Koordinate → null', () => {
      expect(interpolateCubic([[0, 0, 0], [1, NaN, 0]])).toBeNull();
      expect(interpolateCubic([[0, 0, 0], [Infinity, 1, 0]])).toBeNull();
    });
  });

  describe('derivSpline', () => {
    test('stimmt mit der zentralen Differenz überein', () => {
      const pts = arcPoints(40);
      const sp = interpolateCubic(pts);
      const lo = sp.U[sp.degree], hi = sp.U[sp.U.length - sp.degree - 1];
      const h = 1e-5;
      for (const f of [0.13, 0.37, 0.61, 0.88]) {
        const u = lo + (hi - lo) * f;
        const a = evalSpline(sp, u - h);
        const b = evalSpline(sp, u + h);
        const fd = [(b[0] - a[0]) / (2 * h), (b[1] - a[1]) / (2 * h), (b[2] - a[2]) / (2 * h)];
        const d = derivSpline(sp, u);
        for (let c = 0; c < 3; c++) {
          const den = Math.max(1e-12, Math.hypot(fd[0], fd[1], fd[2]));
          expect(Math.abs(d[c] - fd[c]) / den).toBeLessThan(1e-5);
        }
      }
    });
  });

  describe('splineSamples / nearestParam', () => {
    test('SAMPLES: Ränder sind exakte Kontrollpunkt-Kopien', () => {
      const pts = arcPoints(12);
      const sp = interpolateCubic(pts);
      const s = splineSamples(sp, 20);
      expect(s.length).toBe(21);
      expect(s[0]).toEqual(sp.ctrl[0]);
      expect(s[20]).toEqual(sp.ctrl[sp.ctrl.length - 1]);
    });

    test('nearestParam findet einen Punkt der Kurve', () => {
      const pts = arcPoints(12);
      const sp = interpolateCubic(pts);
      const target = evalSpline(sp, sp.params[5]);
      const u = nearestParam(sp, target, 200);
      const q = evalSpline(sp, u);
      expect(dist3(q, target)).toBeLessThan(1e-6);
    });
  });

  describe('interpolateCubic — Parametrisierung', () => {
    test('chord-Parametrisierung interpoliert ebenfalls exakt', () => {
      const pts = arcPoints(15);
      const sp = interpolateCubic(pts, { param: 'chord' });
      expect(sp).not.toBeNull();
      expect(sp.degree).toBe(3);
      checkExact(sp, pts);
      // Parameter: u_0 = 0, u_{n−1} = Gesamt-Sehnenlänge (mm)
      let L = 0;
      for (let i = 0; i + 1 < pts.length; i++) L += dist3(pts[i], pts[i + 1]);
      expect(sp.params[0]).toBe(0);
      expect(sp.params[sp.params.length - 1]).toBeCloseTo(L, 9);
      // Die Abstände der Parameter folgen den Sehnenlängen
      const d0 = dist3(pts[0], pts[1]);
      const d1 = dist3(pts[1], pts[2]);
      expect(sp.params[2] - sp.params[1]).toBeCloseTo(d1 / d0 * (sp.params[1] - sp.params[0]), 9);
    });

    test('zentripetal ist die Vorgabe', () => {
      const pts = arcPoints(6);
      const a = interpolateCubic(pts);
      const b = interpolateCubic(pts, { param: 'centripetal' });
      expect(a.params).toEqual(b.params);
    });
  });

  describe('Performance', () => {
    test('400 Punkte interpolieren in < 200 ms', () => {
      const pts = arcPoints(400);
      const t0 = Date.now();
      const sp = interpolateCubic(pts);
      const dt = Date.now() - t0;
      expect(sp).not.toBeNull();
      expect(sp.ctrl.length).toBe(400);
      expect(dt).toBeLessThan(200);
    });
  });
});

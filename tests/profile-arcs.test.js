// Tests für profile-arcs.js — Erkennung von Bogen-Bändern (Zylinder/Kegel) in
// extrudierten Profilen. Eigener Generator, keine Projektdateien als Quelle.
import {
  ARC_DEFAULTS, findArcBands, fitCircle2d, makeFrame, toLocal, axisCandidates,
} from '../profile-arcs.js';

const vtxKey = (p) => p.map((x) => (+x.toFixed(4) || 0).toFixed(4)).join(',');

// ── Vektoren ───────────────────────────────────────────────────────────────
const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross3 = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm3 = (a) => {
  const l = Math.hypot(a[0], a[1], a[2]);
  return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
};

// Rodrigues-Drehung um die Achse a (wird normiert), Winkel in rad
function rotAxis(a, ang) {
  const l = Math.hypot(a[0], a[1], a[2]);
  const u = [a[0] / l, a[1] / l, a[2] / l];
  const c = Math.cos(ang), s = Math.sin(ang);
  return (p) => {
    const d = u[0] * p[0] + u[1] * p[1] + u[2] * p[2];
    const cr = cross3(u, p);
    return [
      p[0] * c + cr[0] * s + u[0] * d * (1 - c),
      p[1] * c + cr[1] * s + u[1] * d * (1 - c),
      p[2] * c + cr[2] * s + u[2] * d * (1 - c),
    ];
  };
}

// Drehung um (ax,ay,az) Grad (X, dann Y, dann Z) + Verschiebung
function makeXform(anglesDeg, shift) {
  const r = anglesDeg.map((d) => d * Math.PI / 180);
  const rx = rotAxis([1, 0, 0], r[0]), ry = rotAxis([0, 1, 0], r[1]), rz = rotAxis([0, 0, 1], r[2]);
  const rot = (p) => rz(ry(rx(p)));
  const s = shift || [0, 0, 0];
  return {
    p: (q) => { const w = rot(q); return [w[0] + s[0], w[1] + s[1], w[2] + s[2]]; },
    v: (q) => rot(q),
  };
}

// ── Generator: Extrusion entlang z von „Ringen“ ───────────────────────────
// rings: [{ z, pts2d }] — alle Ringe mit gleicher Punktzahl, CCW.
// Facetten = Vierecke zwischen Ring k und k+1; Deckflächen unten (−z) / oben (+z).
function extrude(rings, xf) {
  const n = rings[0].pts2d.length;
  const map = xf ? (p) => xf.p(p) : (p) => p.slice();
  const P = rings.map((r) => r.pts2d.map(([x, y]) => map([x, y, r.z])));
  const face = (pts, normal) => {
    const nn = normal || norm3(cross3(sub3(pts[1], pts[0]), sub3(pts[2], pts[1])));
    const c = [0, 1, 2].map((k) => pts.reduce((s, p) => s + p[k], 0) / pts.length);
    return { outer: pts, inner: [], normal: nn, centroid: c };
  };
  const fds = [];
  for (let k = 0; k + 1 < rings.length; k++) {
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      fds.push(face([P[k][i], P[k][j], P[k + 1][j], P[k + 1][i]]));
    }
  }
  const z = xf ? xf.v([0, 0, 1]) : [0, 0, 1];
  fds.push(face(P[0].slice().reverse(), [-z[0], -z[1], -z[2]]));      // unten → −z
  fds.push(face(P[P.length - 1].slice(), z));                          // oben → +z
  return fds;
}

// ── Profile (alle CCW) ────────────────────────────────────────────────────
// Rechteck w×h mit Eckradien radii = [BR, TR, TL, BL], je Bogen segs Segmente
function roundedRect(w, h, radii, segs) {
  const out = [];
  const corners = [
    [[w / 2 - radii[0], -h / 2 + radii[0]], radii[0], -90, 0],
    [[w / 2 - radii[1], h / 2 - radii[1]], radii[1], 0, 90],
    [[-w / 2 + radii[2], h / 2 - radii[2]], radii[2], 90, 180],
    [[-w / 2 + radii[3], -h / 2 + radii[3]], radii[3], 180, 270],
  ];
  for (const [c, r, a0, a1] of corners) {
    if (!(r > 0)) { out.push([c[0], c[1]]); continue; }
    for (let i = 0; i <= segs; i++) {
      const a = (a0 + (a1 - a0) * i / segs) * Math.PI / 180;
      out.push([c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)]);
    }
  }
  return out;
}

// L-Profil: Schenkel legA/legB, Biegung innen rIn / außen rOut (konzentrisch)
function lProfile(legA, legB, rIn, rOut, segs) {
  const thick = rOut - rIn;
  const C = [rOut, rOut];
  const pts = [];
  for (let i = 0; i <= segs; i++) {                    // Außenbogen 180° → 270°
    const a = (180 + 90 * i / segs) * Math.PI / 180;
    pts.push([C[0] + rOut * Math.cos(a), C[1] + rOut * Math.sin(a)]);
  }
  pts.push([legA, 0], [legA, thick]);                  // Schenkel A
  for (let i = 0; i <= segs; i++) {                    // Innenbogen −90° → −180°
    const a = (-90 - 90 * i / segs) * Math.PI / 180;
    pts.push([C[0] + rIn * Math.cos(a), C[1] + rIn * Math.sin(a)]);
  }
  pts.push([rIn, legB], [0, legB]);                    // Schenkel B
  return pts;
}

// Langloch (Stadion): zwei Halbkreise r, Steglänge length
function stadium(length, r, segs) {
  const pts = [];
  for (let i = 0; i <= segs; i++) {
    const a = (-90 + 180 * i / segs) * Math.PI / 180;
    pts.push([length / 2 + r * Math.cos(a), r * Math.sin(a)]);
  }
  for (let i = 0; i <= segs; i++) {
    const a = (90 + 180 * i / segs) * Math.PI / 180;
    pts.push([-length / 2 + r * Math.cos(a), r * Math.sin(a)]);
  }
  return pts;
}

// regelmäßiges n-Eck
function regularPolygon(r, n) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (360 * i / n) * Math.PI / 180;
    pts.push([r * Math.cos(a), r * Math.sin(a)]);
  }
  return pts;
}

const run = (fds, opts = {}) => findArcBands(fds, { vtxKey, ...opts });

describe('profile-arcs.js — Band-Erkennung', () => {
  test('1: Rechteck 20×10 mit einer Eckrundung R3 (6 Seg.) → genau 1 Band "cyl"', () => {
    const prof = roundedRect(20, 10, [3, 0, 0, 0], 6);     // nur BR-Ecke gerundet
    const fds = extrude([{ z: 0, pts2d: prof }, { z: 8, pts2d: prof }]);
    const { bands, arcs, stats } = run(fds);
    expect(bands.length).toBe(1);
    const b = bands[0];
    expect(b.kind).toBe('cyl');
    expect(b.facets.length).toBe(6);
    expect(b.levels.lo.r).toBeCloseTo(3, 6);
    expect(b.levels.hi.r).toBeCloseTo(3, 6);
    expect(b.sense).toBe(1);
    expect(b.segs.length).toBe(4);
    expect(b.segs.map((s) => s.type)).toEqual(['arc', 'line', 'arc', 'line']);
    expect(b.segs[0].pts.length).toBe(7);
    expect(b.segs[2].pts.length).toBe(7);
    expect(b.segs[0].arcKey).toBeTruthy();
    expect(b.sig).toBeTruthy();
    expect(b.sig.split(';').length).toBe(4);
    expect(arcs.size).toBe(2);                              // ein Bogen unten, einer oben
    expect(stats.bands).toBe(1);
    expect(stats.cyl).toBe(1);
    expect(stats.cone).toBe(0);
    // Rahmen: Achse = z, rechtshändig
    expect(b.d[2]).toBeCloseTo(1, 9);
    expect(b.frame.e1[2]).toBeCloseTo(0, 9);
    expect(b.frame.e2[2]).toBeCloseTo(0, 9);
  });

  test('2: abgerundetes Rechteck 40×30, alle Ecken R5 (8 Seg.) → 4 Bänder "cyl"', () => {
    const prof = roundedRect(40, 30, [5, 5, 5, 5], 8);
    const fds = extrude([{ z: 0, pts2d: prof }, { z: 10, pts2d: prof }]);
    const { bands, arcs, stats } = run(fds);
    expect(bands.length).toBe(4);                           // Zyklus ist KEIN Vollkreis
    expect(bands.every((b) => b.kind === 'cyl')).toBe(true);
    expect(bands.every((b) => b.sense === 1)).toBe(true);
    expect(bands.every((b) => Math.abs(b.levels.lo.r - 5) < 1e-6)).toBe(true);
    expect(bands.every((b) => b.facets.length === 8)).toBe(true);
    expect(stats.cyl).toBe(4);
    expect(stats.cone).toBe(0);
    expect(arcs.size).toBe(8);                              // je Ecke unten + oben
  });

  test('3: 0,5×45°-Fasen oben/unten → 4 "cyl" + 8 "cone", alle sense +1', () => {
    const full = roundedRect(40, 30, [5, 5, 5, 5], 8);
    const ins = roundedRect(39, 29, [4.5, 4.5, 4.5, 4.5], 8);
    const fds = extrude([
      { z: 0, pts2d: ins }, { z: 0.5, pts2d: full },
      { z: 9.5, pts2d: full }, { z: 10, pts2d: ins },
    ]);
    const { bands, arcs, stats } = run(fds);
    expect(bands.length).toBe(12);
    expect(stats.cyl).toBe(4);
    expect(stats.cone).toBe(8);
    expect(bands.every((b) => b.sense === 1)).toBe(true);
    const cyl = bands.filter((b) => b.kind === 'cyl');
    const cone = bands.filter((b) => b.kind === 'cone');
    expect(cyl.every((b) => Math.abs(b.levels.lo.r - 5) < 1e-6)).toBe(true);
    // Kegel: unten Radius 4.5 → 5, oben 5 → 4.5
    expect(cone.filter((b) => b.levels.lo.r < b.levels.hi.r).length).toBe(4);
    expect(cone.filter((b) => b.levels.lo.r > b.levels.hi.r).length).toBe(4);
    expect(cone.every((b) => Math.abs(b.levels.hi.r - b.levels.lo.r) - 0.5 < 1e-6)).toBe(true);
    // 16 Bögen: je Ecke Deckfläche↔Kegel ×2 und Kegel↔Zylinder ×2 (Kegel- und
    // Zylinder-Bogen an derselben Höhe sind derselbe Bogen → owners 2)
    expect(arcs.size).toBe(16);
  });

  test('4: L-Blech mit Biegung (innen R3 / außen R5) → 2 Bänder "cyl"', () => {
    const prof = lProfile(20, 15, 3, 5, 8);
    const fds = extrude([{ z: 0, pts2d: prof }, { z: 10, pts2d: prof }]);
    const { bands } = run(fds);
    expect(bands.length).toBe(2);
    expect(bands.every((b) => b.kind === 'cyl')).toBe(true);
    const inner = bands.find((b) => b.sense === -1);
    const outer = bands.find((b) => b.sense === 1);
    expect(inner).toBeTruthy();
    expect(outer).toBeTruthy();
    expect(inner.levels.lo.r).toBeCloseTo(3, 6);
    expect(outer.levels.lo.r).toBeCloseTo(5, 6);
    expect(inner.segs[0].pts.length).toBe(9);
    expect(outer.segs[0].pts.length).toBe(9);
  });

  test('5: Langloch (Stadion) Länge 10, R4, 12 Seg. je Halbkreis → 2 Bänder', () => {
    const prof = stadium(10, 4, 12);
    const fds = extrude([{ z: 0, pts2d: prof }, { z: 10, pts2d: prof }]);
    const { bands } = run(fds);
    expect(bands.length).toBe(2);
    expect(bands.every((b) => b.kind === 'cyl')).toBe(true);
    expect(bands.every((b) => b.sense === 1)).toBe(true);
    expect(bands.every((b) => Math.abs(b.levels.lo.r - 4) < 1e-6)).toBe(true);
    expect(bands.every((b) => b.facets.length === 12)).toBe(true);
  });

  test('6: Vollzylinder R5 (32 Seg.) → 0 Bänder (Vollkreis)', () => {
    const prof = regularPolygon(5, 32);
    const fds = extrude([{ z: 0, pts2d: prof }, { z: 10, pts2d: prof }]);
    const { bands, stats } = run(fds);
    expect(bands.length).toBe(0);
    expect(stats.bands).toBe(0);
  });

  test('7: Sechseck-Prisma → 0 Bänder; Rechteck scharf → 0 Bänder', () => {
    const hex = regularPolygon(5, 6);
    const hexFds = extrude([{ z: 0, pts2d: hex }, { z: 10, pts2d: hex }]);
    expect(run(hexFds).bands.length).toBe(0);
    const rect = roundedRect(20, 10, [0, 0, 0, 0], 1);
    const rectFds = extrude([{ z: 0, pts2d: rect }, { z: 10, pts2d: rect }]);
    expect(run(rectFds).bands.length).toBe(0);
  });

  test('8: Fall 3 gedreht (20°,35°,10°) und verschoben → wieder 4 cyl + 8 cone', () => {
    const full = roundedRect(40, 30, [5, 5, 5, 5], 8);
    const ins = roundedRect(39, 29, [4.5, 4.5, 4.5, 4.5], 8);
    const xf = makeXform([20, 35, 10], [50, -20, 7]);
    const fds = extrude([
      { z: 0, pts2d: ins }, { z: 0.5, pts2d: full },
      { z: 9.5, pts2d: full }, { z: 10, pts2d: ins },
    ], xf);
    const { bands, stats } = run(fds);
    expect(bands.length).toBe(12);
    expect(stats.cyl).toBe(4);
    expect(stats.cone).toBe(8);
    expect(bands.every((b) => b.sense === 1)).toBe(true);
    // Achse der Bänder = gedrehte z-Achse (kanonisch: erste Komponente > 0)
    const z = xf.v([0, 0, 1]);
    for (const b of bands) {
      expect(Math.abs(Math.abs(b.d[0]) - Math.abs(z[0]))).toBeLessThan(1e-9);
      expect(Math.abs(Math.abs(b.d[1]) - Math.abs(z[1]))).toBeLessThan(1e-9);
      expect(Math.abs(Math.abs(b.d[2]) - Math.abs(z[2]))).toBeLessThan(1e-9);
    }
    expect(bands[0].d[0]).toBeGreaterThan(0);               // Vorzeichen kanonisch
  });

  test('9: gesperrte Signatur (opts.blocked) → 0 Bänder', () => {
    const prof = roundedRect(20, 10, [3, 0, 0, 0], 6);
    const fds = extrude([{ z: 0, pts2d: prof }, { z: 8, pts2d: prof }]);
    const first = run(fds);
    expect(first.bands.length).toBe(1);
    const blocked = new Set([first.bands[0].sig]);
    const second = run(fds, { blocked });
    expect(second.bands.length).toBe(0);
    expect(second.stats.bands).toBe(0);
  });

  test('10: fitCircle2d — Kreis mit Rauschen, kollineare Punkte', () => {
    const c = [1, 2], r = 3;
    const pts = [];
    for (let i = 0; i < 12; i++) {
      const a = (360 * i / 12) * Math.PI / 180;
      const noise = 1e-7;
      pts.push([c[0] + r * Math.cos(a) + noise, c[1] + r * Math.sin(a) - noise]);
    }
    const K = fitCircle2d(pts);
    expect(K).toBeTruthy();
    expect(K.c[0]).toBeCloseTo(c[0], 5);
    expect(K.c[1]).toBeCloseTo(c[1], 5);
    expect(K.r).toBeCloseTo(r, 5);
    expect(K.maxRes).toBeLessThan(1e-5);
    expect(fitCircle2d([[0, 0], [1, 1], [2, 2], [3, 3]])).toBeNull();
    expect(fitCircle2d([[0, 0], [1, 0]])).toBeNull();
  });

  test('Hilfsfunktionen: makeFrame rechtshändig, toLocal, axisCandidates', () => {
    const f = makeFrame([0, 0, 2]);
    expect(f.d[2]).toBeCloseTo(1, 12);
    const cross = [
      f.e1[1] * f.e2[2] - f.e1[2] * f.e2[1],
      f.e1[2] * f.e2[0] - f.e1[0] * f.e2[2],
      f.e1[0] * f.e2[1] - f.e1[1] * f.e2[0],
    ];
    expect(cross[2]).toBeCloseTo(1, 12);                 // e1 × e2 = d
    expect(cross[0]).toBeCloseTo(0, 12);
    expect(cross[1]).toBeCloseTo(0, 12);
    const loc = toLocal(f, [1, 2, 3]);
    expect(loc[2]).toBeCloseTo(3, 12);
    // Achsen-Kandidaten: nur die Deckflächen (≥ capMinPts Randpunkte)
    const prof = roundedRect(20, 10, [3, 0, 0, 0], 6);
    const fds = extrude([{ z: 0, pts2d: prof }, { z: 8, pts2d: prof }]);
    const axes = axisCandidates(fds, { vtxKey });
    expect(axes.length).toBe(1);
    expect(axes[0][2]).toBeCloseTo(1, 9);
    expect(ARC_DEFAULTS.minSegs).toBe(3);
  });
});


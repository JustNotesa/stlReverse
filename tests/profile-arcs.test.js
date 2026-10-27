// Tests für profile-arcs.js — Erkennung von Bogen-Bändern (Zylinder/Kegel) in
// extrudierten Profilen. Eigener Generator, keine Projektdateien als Quelle.
import {
  ARC_DEFAULTS, findArcBands, fitCircle2d, makeFrame, toLocal, axisCandidates,
  validateArcBands, applyArcBands, edgeCanonKey,
  arcGeometry, arcSamples, bandSurface, buildArcPlans, expandArcLoop,
  fitCoaxial2d, stackLevels,
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
const len3 = (a) => Math.hypot(a[0], a[1], a[2]);

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
// Fläche aus einem Punktloop (Normalen aus den ersten drei Punkten)
const face = (pts, normal) => {
  const nn = normal || norm3(cross3(sub3(pts[1], pts[0]), sub3(pts[2], pts[1])));
  const c = [0, 1, 2].map((k) => pts.reduce((s, p) => s + p[k], 0) / pts.length);
  return { outer: pts, inner: [], normal: nn, centroid: c };
};

// rings: [{ z, pts2d }] — alle Ringe mit gleicher Punktzahl, CCW.
// Facetten = Vierecke zwischen Ring k und k+1; Deckflächen unten (−z) / oben (+z).
function extrude(rings, xf) {
  const n = rings[0].pts2d.length;
  const map = xf ? (p) => xf.p(p) : (p) => p.slice();
  const P = rings.map((r) => r.pts2d.map(([x, y]) => map([x, y, r.z])));
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

// Gleiche Extrusion, aber mit fertigen 3D-Ringen (für verrauschte Netze)
function extrude3(rings3) {
  const n = rings3[0].length;
  const fds = [];
  for (let k = 0; k + 1 < rings3.length; k++) {
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      fds.push(face([rings3[k][i], rings3[k][j], rings3[k + 1][j], rings3[k + 1][i]]));
    }
  }
  fds.push(face(rings3[0].slice().reverse(), [0, 0, -1]));            // unten → −z
  fds.push(face(rings3[rings3.length - 1].slice(), [0, 0, 1]));       // oben → +z
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

// Wand eines Bogens als Dreiecksfächer: die obere Ringebene ist um step/2
// versetzt → die inneren Seitenkanten der Wand sind schräg (keine Mantellinien),
// nur die beiden Randkanten (Winkel a0 und a1) sind Mantellinien.
// lo: Winkel a0 + k·step,  hi: a0 + (k+½)·step, beide mit den exakten Randwinkeln.
function arcFan(c, r, a0, a1, segs, zLo, zHi) {
  const step = (a1 - a0) / segs;
  const P = (a, z) => [
    c[0] + r * Math.cos(a * Math.PI / 180),
    c[1] + r * Math.sin(a * Math.PI / 180),
    z,
  ];
  const lo = [], hi = [];
  for (let k = 0; k <= segs; k++) lo.push(P(a0 + k * step, zLo));
  hi.push(P(a0, zHi));
  for (let k = 0; k < segs; k++) hi.push(P(a0 + (k + 0.5) * step, zHi));
  hi.push(P(a1, zHi));
  // Zickzack-Fächer: abwechselnd (2 lo + 1 hi) und (1 lo + 2 hi); benachbarte
  // Dreiecke teilen genau eine Seitenkante (lo↔hi).
  const tris = [];
  for (let k = 0; k < segs; k++) {
    tris.push([hi[k], lo[k], lo[k + 1]]);
    tris.push([hi[k + 1], hi[k], lo[k + 1]]);
  }
  tris.push([lo[segs], hi[segs + 1], hi[segs]]);
  return { lo, hi, tris };
}

// Rundrechteck, dessen Wand zwischen den Ringebenen aus Dreiecksfächern besteht
function fanExtrusion(w, h, R, segs, zLo, zHi) {
  const corners = [
    [[w / 2 - R, -h / 2 + R], -90, 0],
    [[w / 2 - R, h / 2 - R], 0, 90],
    [[-w / 2 + R, h / 2 - R], 90, 180],
    [[-w / 2 + R, -h / 2 + R], 180, 270],
  ];
  const arcs = corners.map(([c, a0, a1]) => arcFan(c, R, a0, a1, segs, zLo, zHi));
  const fds = [];
  for (let ci = 0; ci < 4; ci++) {
    const cur = arcs[ci], nxt = arcs[(ci + 1) % 4];
    for (const t of cur.tris) fds.push(face(t));
    // gerade Kante zwischen zwei Ecken (Viereck, Seitenkanten = Mantellinien)
    fds.push(face([cur.lo[segs], nxt.lo[0], nxt.hi[0], cur.hi[segs + 1]]));
  }
  const capLo = [], capHi = [];
  for (const a of arcs) { capLo.push(...a.lo); capHi.push(...a.hi); }
  fds.push(face(capLo.slice().reverse(), [0, 0, -1]));      // unten → −z
  fds.push(face(capHi, [0, 0, 1]));                          // oben → +z
  return fds;
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

// Deterministisches Rauschen (LCG, fester Seed) — reproduzierbar
function lcg(seed) {
  let s = (seed >>> 0) || 1;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

// Profil mit EINEM flachen Bogen (R über 15°) zwischen zwei Geraden (spec-T2c):
// die Tangenten an den Bogenenden laufen senkrecht auseinander, links schließt
// eine Kante das Profil. `inset` → Fasen-Ring: Bogenradius −inset, alle
// Stützgeraden −inset (echter Parallelversatz → 45°-Fase).
function flatArcProfile(R, inset, segs) {
  const half = 7.5 * Math.PI / 180;
  const r = R - inset;
  const arc = [];
  for (let i = 0; i <= segs; i++) {
    const a = -half + (2 * half) * i / segs;
    arc.push([r * Math.cos(a), r * Math.sin(a)]);
  }
  // Stützgeraden (Außennormale n, Gleichung p·n = c)
  const lines = [
    { n: [Math.cos(-half), Math.sin(-half)], c: r },      // Tangente am Bogenanfang
    { n: [Math.cos(half), Math.sin(half)], c: r },        // Tangente am Bogenende
    { n: [0, 1], c: 62 - inset },                        // oben
    { n: [-1, 0], c: 30 - inset },                       // links
    { n: [0, -1], c: 62 - inset },                       // unten
  ];
  const isect = (l1, l2) => {
    const d = l1.n[0] * l2.n[1] - l1.n[1] * l2.n[0];
    const s = (l2.c - l1.c * (l1.n[0] * l2.n[0] + l1.n[1] * l2.n[1])) / d;
    return [l1.c * l1.n[0] - s * l1.n[1], l1.c * l1.n[1] + s * l1.n[0]];
  };
  const Ap = isect(lines[0], lines[4]);                  // Tangente unten
  const Bp = isect(lines[1], lines[2]);                  // Tangente oben
  const T = isect(lines[2], lines[3]);                   // links oben
  const Lb = isect(lines[3], lines[4]);                  // links unten
  return [Ap, ...arc, Bp, T, Lb];                        // CCW
}

// ── Profil: Ecke aus zwei tangential aneinanderstoßenden Bögen (spec-T1f) ────
// R5 über 45° (4 Seg.), dann R3 über 45° (4 Seg.) — beide CCW, sie berühren sich
// mit derselben Tangente. `inset` = 0.5 → Fasen-Ring: Bogenradien −0.5, die
// geraden Kanten 0.5 nach innen (Mittelpunkte der Bögen bleiben).
function twoTangentArcs(inset) {
  const seg = 4;
  const r5 = 5 - inset, r3 = 3 - inset;
  const C5 = [0, 0];
  const aEnd = -45 * Math.PI / 180;
  const P = [r5 * Math.cos(aEnd), r5 * Math.sin(aEnd)];      // Tangentenpunkt
  const td = [-Math.sin(aEnd), Math.cos(aEnd)];              // CCW-Tangente dort
  const C3 = [P[0] - r3 * td[1], P[1] + r3 * td[0]];          // links der Tangente
  const arcPts = (c, r, a0, a1, n) => {
    const out = [];
    for (let i = 0; i <= n; i++) {
      const a = (a0 + (a1 - a0) * i / n) * Math.PI / 180;
      out.push([c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)]);
    }
    return out;
  };
  const pts = [];
  pts.push(...arcPts(C5, r5, -90, -45, seg).slice(0, -1));   // R5-Bogen (ohne Tangentenpunkt)
  pts.push(...arcPts(C3, r3, -45, 0, seg));                   // R3-Bogen (Start = Tangentenpunkt)
  pts.push([C3[0] + r3, 10 - inset]);                         // gerade Kante nach oben
  pts.push([-10 + inset, 10 - inset]);                       // gerade Kante nach links
  pts.push([-10 + inset, -5 + inset]);                       // gerade Kante nach unten
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

  // ── Nachbar-Prüfung (validate) + Anwendung (apply) ────────────────────────
  // Fall 3: Rundrechteck 40×30, Ecken R5 (8 Seg.), 0,5-Fasen oben/unten
  const fall3 = () => {
    const full = roundedRect(40, 30, [5, 5, 5, 5], 8);
    const ins = roundedRect(39, 29, [4.5, 4.5, 4.5, 4.5], 8);
    return extrude([
      { z: 0, pts2d: ins }, { z: 0.5, pts2d: full },
      { z: 9.5, pts2d: full }, { z: 10, pts2d: ins },
    ]);
  };

  test('11: Fall 3 — validate: 12 Bänder, 8 capEdits, 16 Bögen; apply: 96 Facetten weg', () => {
    const fds = fall3();
    const det = run(fds);
    expect(det.bands.length).toBe(12);
    validateArcBands(fds, det, { vtxKey });
    expect(det.bands.length).toBe(12);
    expect(det.stats.valid).toBe(12);
    expect(det.capEdits.length).toBe(8);
    expect(det.arcs.size).toBe(16);
    // je Deckfläche 4 Bögen (je Ecke), je Bogen 9 Punkte (7 innere)
    const perFace = new Map();
    for (const ce of det.capEdits) perFace.set(ce.fi, (perFace.get(ce.fi) || 0) + 1);
    expect(perFace.size).toBe(2);
    expect([...perFace.values()].sort()).toEqual([4, 4]);
    expect(det.capEdits.every((ce) => ce.pts.length === 9)).toBe(true);
    expect(det.capEdits.every((ce) => ce.a && ce.b && ce.arcKey && ce.li === 0)).toBe(true);

    // apply: alle 12×8 Band-Facetten entfernen, Deckflächen glätten
    const res = applyArcBands(fds, det, { vtxKey });
    expect(res.removed.size).toBe(96);
    expect(res.fds.length).toBe(fds.length - 96);
    const caps = res.fds.filter((fd) => fd.arcEdges instanceof Map && fd.arcEdges.size);
    expect(caps.length).toBe(2);
    for (const c of caps) {
      expect(c.arcEdges.size).toBe(4);                      // 4 Bogen-Kanten je Deckfläche
      expect(c.outer.length).toBe(36 - 4 * 7);              // 28 innere Punkte entfernt
      expect(c.untouched).toBe(false);
      for (const k of c.arcEdges.keys()) expect(k).toContain('||');
    }
    // Original unverändert
    expect(fds[fds.length - 1].outer.length).toBe(36);
    expect(fds[fds.length - 2].outer.length).toBe(36);
  });

  test('12: obere Deckfläche entfernt → validate lässt alle Bänder fallen (0)', () => {
    const fds = fall3();
    const fds2 = fds.slice(0, -1);                          // obere Deckfläche weg
    const det = run(fds2);
    expect(det.bands.length).toBe(12);
    validateArcBands(fds2, det, { vtxKey });
    expect(det.bands.length).toBe(0);
    expect(det.stats.valid).toBe(0);
    expect(det.capEdits.length).toBe(0);
    expect(det.arcs.size).toBe(0);
  });

  test('13: edgeCanonKey — richtungsunabhängig, zwei Striche', () => {
    const a = [1, 2, 3], b = [4, 5, 6];
    expect(edgeCanonKey(vtxKey, a, b)).toBe(edgeCanonKey(vtxKey, b, a));
    expect(edgeCanonKey(vtxKey, a, b)).toContain('||');
    expect(edgeCanonKey(vtxKey, a, b).split('||').length).toBe(2);
  });

  // ── alignBands: gemeinsame Teilungsstellen der Bänder (spec-T1f) ────────────
  // Zahl der Eigentümer je Bogen
  const ownerCount = (arcs) => {
    const m = new Map();
    for (const rec of arcs.values()) m.set(rec.key, (rec.owners || []).length);
    return m;
  };

  test('14: zwei tangential aneinanderstoßende Bögen (R5/R3) mit Fasen → 2 cyl + 4 cone, alle gültig', () => {
    const full = twoTangentArcs(0);
    const ins = twoTangentArcs(0.5);
    const fds = extrude([
      { z: 0, pts2d: ins }, { z: 0.5, pts2d: full },
      { z: 9.5, pts2d: full }, { z: 10, pts2d: ins },
    ]);
    const det = run(fds);
    expect(det.bands.length).toBe(6);
    expect(det.stats.cyl).toBe(2);
    expect(det.stats.cone).toBe(4);
    expect(det.bands.every((b) => b.sense === 1)).toBe(true);
    // die beiden Bögen je Ecke: R5 (r 5) und R3 (r 3)
    const cyl = det.bands.filter((b) => b.kind === 'cyl');
    expect(cyl.map((b) => Math.round(b.levels.lo.r)).sort()).toEqual([3, 5]);
    // Kegel: unten 4.5 → 5 (R5) bzw. 2.5 → 3 (R3)
    const cone = det.bands.filter((b) => b.kind === 'cone');
    expect(cone.filter((b) => b.levels.lo.r > b.levels.hi.r).length).toBe(2);   // untere Fase
    expect(cone.filter((b) => b.levels.lo.r < b.levels.hi.r).length).toBe(2);   // obere Fase

    validateArcBands(fds, det, { vtxKey });
    expect(det.bands.length).toBe(6);
    expect(det.stats.valid).toBe(6);
    // 8 Bögen: 4 zwischen Zylinder und Kegel (2 Eigentümer) + 4 an den Deckflächen (1)
    expect(det.arcs.size).toBe(8);
    const own = ownerCount(det.arcs);
    const counts = [...own.values()].sort();
    expect(counts).toEqual([1, 1, 1, 1, 2, 2, 2, 2]);
    // die Bogen-Stücke zwischen Zylinder und Kegel: 2 Eigentümer, gleicher Polygonzug
    for (const rec of det.arcs.values()) {
      if (rec.owners.length !== 2) continue;
      expect(rec.owners[0].band).not.toBe(rec.owners[1].band);
    }
  });

  test('15: Teilungsstellen angeglichen — Zylinder-Bogen und Kegel-Bogen decken sich', () => {
    // Rundrechteck 11.85×11.85, Ecken R5 mit je 4 Seg. (Sehne 1.951), die kurzen
    // Geraden sind 1.85 lang. Im ZYLINDER-Band ist damit die ECKE die längste Kante
    // (1.951 > 1.85) → die Kette wird IN der Ecke geschnitten (der Zylinder-Bogen
    // beginnt eine Facette später). Im KEGEL-Band ist die Ecke kürzer (1.756) →
    // dort ist die GERADE die längste Kante → die Kette wird an der Geraden
    // geschnitten (der Kegel-Bogen umfasst die ganze Ecke). Die Teilungsstellen
    // liegen also verschieden: ohne Angleichen grenzt der Kegel-Bogen halb an das
    // Zylinder-Band, halb an eine Facette (beide Bänder fallen weg).
    const full = roundedRect(11.85, 11.85, [5, 5, 5, 5], 4);
    const ins = roundedRect(10.85, 10.85, [4.5, 4.5, 4.5, 4.5], 4);
    const fds = extrude([
      { z: 0, pts2d: ins }, { z: 0.5, pts2d: full },
      { z: 9.5, pts2d: full }, { z: 10, pts2d: ins },
    ]);
    const det = run(fds);
    // 4 Zylinder + 8 Kegel, und mindestens eine Teilung wurde angeglichen
    expect(det.bands.length).toBe(12);
    expect(det.stats.cyl).toBe(4);
    expect(det.stats.cone).toBe(8);
    expect(det.stats.aligned).toBeGreaterThanOrEqual(1);

    // alle Bänder bleiben gültig: Zylinder- und Kegel-Bögen decken sich
    const before = det.bands.length;
    validateArcBands(fds, det, { vtxKey });
    expect(det.bands.length).toBe(before);
    expect(det.stats.valid).toBe(before);
    // 16 Bögen: 8 zwischen Zylinder und Kegel (2 Eigentümer) + 8 an den Deckflächen (1)
    expect(det.arcs.size).toBe(16);
    const counts = [...ownerCount(det.arcs).values()].sort();
    expect(counts).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2]);
    // jeder Bogen mit 2 Eigentümern: Zylinder-Band + Kegel-Band
    for (const rec of det.arcs.values()) {
      if (rec.owners.length !== 2) continue;
      const kinds = rec.owners.map((ow) => det.bands[ow.band].kind).sort();
      if (kinds[0] === 'cyl' && kinds[1] === 'cone') expect(rec.owners.length).toBe(2);
    }
  });

  // ── Exakte Geometrie + Pläne (spec-T2, Abschnitt 3/4) ─────────────────────
  const written9 = (p) => p.map((x) => +x.toFixed(9));

  test('16: Fall 3 — buildArcPlans: 12 Pläne, failed leer, Radien/Semi-Winkel exakt', () => {
    const fds = fall3();
    const det = run(fds);
    validateArcBands(fds, det, { vtxKey });
    const { plans, geoms, failed } = buildArcPlans(fds, det, written9, { vtxKey });
    expect(failed.size).toBe(0);
    expect(plans.length).toBe(12);
    expect(geoms.size).toBe(16);
    for (const g of geoms.values()) {
      expect(g).toBeTruthy();
      expect(Math.abs(len3(sub3(g.Aw, g.center)) - g.radius)).toBeLessThan(1e-9);
      expect(Math.abs(len3(sub3(g.Bw, g.center)) - g.radius)).toBeLessThan(1e-9);
      expect([4.5, 5].some((r) => Math.abs(g.radius - r) < 1e-6)).toBe(true);
    }
    const cyl = plans.filter((p) => p.kind === 'cyl');
    const cone = plans.filter((p) => p.kind === 'cone');
    expect(cyl.length).toBe(4);
    expect(cone.length).toBe(8);
    for (const p of cyl) {
      expect(p.surf.kind).toBe('cyl');
      expect(Math.abs(p.surf.radius - 5)).toBeLessThan(1e-6);
      expect(Math.abs(p.area - (Math.PI / 2) * 5 * 9)).toBeLessThan(0.05);
    }
    for (const p of cone) {
      expect(p.surf.kind).toBe('cone');
      expect(Math.abs(p.surf.semiAngle - Math.PI / 4)).toBeLessThan(1e-6);
    }
    for (const p of plans) {
      expect(p.sag).toBeGreaterThan(0.02);
      expect(p.sag).toBeLessThan(0.03);
      expect(p.dV).toBeGreaterThan(0);
      expect(p.tris.length).toBe(2 * Math.max(8, 2 * p.band.nSegs));
      expect(p.sig).toBeTruthy();
      expect(p.segs).toBe(p.band.segs);
      expect(p.sense).toBe(1);
    }
  });

  test('17: gedrehter Fall — 12 Pläne, failed leer', () => {
    const full = roundedRect(40, 30, [5, 5, 5, 5], 8);
    const ins = roundedRect(39, 29, [4.5, 4.5, 4.5, 4.5], 8);
    const xf = makeXform([20, 35, 10], [50, -20, 7]);
    const fds = extrude([
      { z: 0, pts2d: ins }, { z: 0.5, pts2d: full },
      { z: 9.5, pts2d: full }, { z: 10, pts2d: ins },
    ], xf);
    const det = run(fds);
    validateArcBands(fds, det, { vtxKey });
    const { plans, geoms, failed } = buildArcPlans(fds, det, written9, { vtxKey });
    expect(failed.size).toBe(0);
    expect(plans.length).toBe(12);
    expect(geoms.size).toBe(16);
    for (const p of plans.filter((x) => x.kind === 'cyl')) {
      expect(Math.abs(p.surf.radius - 5)).toBeLessThan(1e-6);
    }
    for (const p of plans.filter((x) => x.kind === 'cone')) {
      expect(Math.abs(p.surf.semiAngle - Math.PI / 4)).toBeLessThan(1e-6);
    }
  });

  test('18: expandArcLoop — 4·(16−1) zusätzliche Punkte, alle auf ihren Kreisen', () => {
    const fds = fall3();
    const det = run(fds);
    validateArcBands(fds, det, { vtxKey });
    const res = applyArcBands(fds, det, { vtxKey });
    const { geoms } = buildArcPlans(fds, det, written9, { vtxKey });
    const caps = res.fds.filter((fd) => fd.arcEdges instanceof Map && fd.arcEdges.size);
    expect(caps.length).toBe(2);
    for (const cap of caps) {
      const expanded = expandArcLoop(cap.outer, cap.arcEdges, geoms, vtxKey, 16);
      expect(expanded.length).toBe(cap.outer.length + 4 * 15);
      const circles = [...cap.arcEdges.values()].map((k) => geoms.get(k));
      expect(circles.every(Boolean)).toBe(true);
      for (const p of expanded) {
        const on = circles.some((g) => Math.abs(len3(sub3(p, g.center)) - g.radius) < 1e-6);
        expect(on).toBe(true);
      }
      // die 15 inneren Proben je Bogen stecken in der Liste
      for (const g of circles) {
        for (const p of arcSamples(g, 16).slice(1, -1)) {
          expect(expanded.some((q) => vtxKey(q) === vtxKey(p))).toBe(true);
        }
      }
      // Original unverändert
      expect(cap.outer.length).toBe(8);
    }
  });

  test('19: gestörte Geometrie — lo-Punkt radial um 0.05 verschoben → kein Band', () => {
    const prof = roundedRect(20, 10, [3, 0, 0, 0], 6);
    const c = [20 / 2 - 3, -10 / 2 + 3];
    const a = -45 * Math.PI / 180;
    expect(Math.abs(prof[3][0] - (c[0] + 3 * Math.cos(a)))).toBeLessThan(1e-9);
    const moved = [c[0] + 3.05 * Math.cos(a), c[1] + 3.05 * Math.sin(a)];
    const prof2 = prof.map((q, i) => (i === 3 ? moved : q));
    const fds = extrude([{ z: 0, pts2d: prof2 }, { z: 8, pts2d: prof }]);
    expect(run(fds).bands.length).toBe(0);
  });

  // ── Gemeinsame Achse je Bogen-Stapel (spec-T2c) ───────────────────────────
  // Kurzer flacher Bogen (R20 über 15°, 5 Segmente) zwischen zwei Geraden,
  // Fasen 0.5 oben/unten, alle Netzpunkte um ±1e-6 mm verrauscht. Der Fit der
  // einzelnen Ebene ist bei so kurzen Bögen schlecht bestimmt → die Bögen eines
  // Stapels müssen eine GEMEINSAME Achse bekommen.
  test('20: kurzer flacher Bogen (R20/15°) mit Rauschen → 3 Pläne (1 Zylinder, 2 Kegel), failed leer', () => {
    const full = flatArcProfile(20, 0, 5);
    const ins = flatArcProfile(20, 0.5, 5);
    const rnd = lcg(20261027);
    const nz = () => (rnd() * 2 - 1) * 1e-6;
    // Deckflächen bleiben in ihrer Ebene (nur u,v verrauscht)
    const rings = [
      { z: 0, p: ins, planar: true },
      { z: 0.5, p: full, planar: false },
      { z: 9.5, p: full, planar: false },
      { z: 10, p: ins, planar: true },
    ];
    const fds = extrude3(rings.map((r) => r.p.map(([x, y]) => [
      x + nz(), y + nz(), r.z + (r.planar ? 0 : nz()),
    ])));

    const det = run(fds);
    expect(det.bands.length).toBe(3);
    expect(det.stats.cyl).toBe(1);
    expect(det.stats.cone).toBe(2);
    validateArcBands(fds, det, { vtxKey });
    expect(det.bands.length).toBe(3);
    expect(det.stats.valid).toBe(3);
    expect(det.arcs.size).toBe(4);                       // z = 0, 0.5, 9.5, 10

    const { plans, geoms, failed } = buildArcPlans(fds, det, written9, { vtxKey });
    expect(failed.size).toBe(0);
    expect(plans.length).toBe(3);
    expect(plans.filter((p) => p.kind === 'cyl').length).toBe(1);
    expect(plans.filter((p) => p.kind === 'cone').length).toBe(2);
    expect(geoms.size).toBe(4);
    for (const g of geoms.values()) expect(g).toBeTruthy();

    // Radien/Semi-Winkel: Zylinder R20, Kegel 19,5 → 20 (unten) bzw. 20 → 19,5 (oben)
    const cyl = plans.filter((p) => p.kind === 'cyl');
    expect(Math.abs(cyl[0].surf.radius - 20)).toBeLessThan(5e-3);
    for (const p of plans.filter((x) => x.kind === 'cone')) {
      expect(Math.abs(p.surf.radius - 20)).toBeLessThan(5e-3);
      expect(Math.abs(p.surf.semiAngle - Math.PI / 4)).toBeLessThan(1e-3);
    }

    // GEMEINSAME Achse: alle vier Bögen des Stapels haben dieselbe 2D-Mitte
    const frame = det.bands[0].frame;
    const uv = [...geoms.values()].map((g) => {
      const l = toLocal(frame, g.center);
      return [l[0], l[1]];
    });
    let maxSpread = 0;
    for (const a of uv) for (const b of uv) {
      maxSpread = Math.max(maxSpread, Math.hypot(a[0] - b[0], a[1] - b[1]));
    }
    expect(maxSpread).toBeLessThan(5e-3);

    // Abstand der Bogen-Punkte zur Bandfläche (das Kriterium von bandSurface)
    const surfDist = (surf, p) => {
      const x = sub3(p, surf.loc);
      const h = x[0] * surf.axis[0] + x[1] * surf.axis[1] + x[2] * surf.axis[2];
      const perp = [
        x[0] - surf.axis[0] * h, x[1] - surf.axis[1] * h, x[2] - surf.axis[2] * h,
      ];
      const rho = len3(perp);
      const R = surf.kind === 'cone' ? surf.radius + h * Math.tan(surf.semiAngle) : surf.radius;
      return Math.abs(rho - R) * (surf.kind === 'cone' ? Math.cos(surf.semiAngle) : 1);
    };
    let maxDev = 0;
    for (const p of plans) {
      for (const seg of p.band.segs) {
        if (seg.type !== 'arc') continue;
        const g = geoms.get(seg.arcKey);
        for (const q of arcSamples(g, 9)) maxDev = Math.max(maxDev, surfDist(p.surf, q));
      }
    }
    expect(maxDev).toBeLessThan(ARC_DEFAULTS.surfTol);
  });

  test('21: fitCoaxial2d — kurze koaxiale Bögen aus dem echten Netz (Kabelhalter-Logo)', () => {
    const P = [[[2.6973559856414795,20.812946319580078],[2.7284998893737793,20.76572608947754],[2.758817434310913,20.717971801757812],[2.788299322128296,20.669696807861328]],[[1.930361032485962,20.155942916870117],[1.909950613975525,20.18936538696289],[1.8889615535736084,20.22242546081543],[1.8674001693725586,20.255115509033203]]];
    const K = fitCoaxial2d(P);
    expect(K).toBeTruthy();
    expect(K.maxRes).toBeLessThan(1e-5);
    expect(Math.abs(K.r[0] - K.r[1] - 1)).toBeLessThan(1e-4);
  });

  // ── Dreiecksfächer: echte Netze tessellieren Bogen-Bänder als Dreiecke ────
  // Die obere Ringebene ist je Ecke um step/2 versetzt → die inneren Seitenkanten
  // der Wand sind schräg (keine Mantellinien). Nur die beiden END-Kanten eines
  // Bandes werden LINE-Kanten → sie müssen Mantellinien (senkrecht) sein.
  test('22: Dreiecksfächer-Wand (R5, 8 Seg.) → 4 "cyl"-Bänder, Enden senkrecht', () => {
    const fds = fanExtrusion(40, 30, 5, 8, 0, 10);
    const det = run(fds);
    expect(det.bands.length).toBe(4);
    expect(det.stats.cyl).toBe(4);
    expect(det.stats.cone).toBe(0);
    expect(det.bands.every((b) => b.kind === 'cyl')).toBe(true);
    expect(det.bands.every((b) => b.sense === 1)).toBe(true);
    expect(det.bands.every((b) => Math.abs(b.levels.lo.r - 5) < 1e-6)).toBe(true);
    expect(det.bands.every((b) => Math.abs(b.levels.hi.r - 5) < 1e-6)).toBe(true);
    // je Ecke 17 Dreiecke (Fächer) → 9 Segmente (8 unten / 9 oben)
    expect(det.bands.every((b) => b.facets.length === 17)).toBe(true);
    expect(det.bands.every((b) => b.nSegs === 9)).toBe(true);
    for (const b of det.bands) {
      expect(b.segs.map((s) => s.type)).toEqual(['arc', 'line', 'arc', 'line']);
      expect(b.segs[0].pts.length).toBe(9);                // lo: 9 Punkte
      expect(b.segs[2].pts.length).toBe(10);               // hi: 9 + 1 versetzter
      // die beiden Randkanten (LINIE-Segs) sind senkrecht → Mantellinien
      for (const seg of [b.segs[1], b.segs[3]]) {
        const [p, q] = seg.pts;
        expect(Math.abs(p[0] - q[0])).toBeLessThan(1e-9);
        expect(Math.abs(p[1] - q[1])).toBeLessThan(1e-9);
        expect(Math.abs(p[2] - q[2])).toBeCloseTo(10, 9);
      }
    }
    // alle Bänder gültig: je Bogen eine Deckfläche, 8 Bögen, 8 Deckflächen-Änderungen
    validateArcBands(fds, det, { vtxKey });
    expect(det.bands.length).toBe(4);
    expect(det.stats.valid).toBe(4);
    expect(det.arcs.size).toBe(8);
    expect(det.capEdits.length).toBe(8);
  });

  // ── Zeitbudget: die Band-Suche darf nicht unbegrenzt laufen ───────────────
  test('23: Zeitbudget (budgetMs: 0) → 0 Bänder, stats.budgetHit = true', () => {
    const prof = roundedRect(40, 30, [5, 5, 5, 5], 8);
    const fds = extrude([{ z: 0, pts2d: prof }, { z: 10, pts2d: prof }]);
    // ohne Budget: 4 Bögen (eine je Ecke)
    const normal = run(fds);
    expect(normal.bands.length).toBe(4);
    expect(normal.stats.budgetHit).toBe(false);
    // Budget abgelaufen → keine Kette wird mehr verarbeitet
    const det = run(fds, { budgetMs: 0 });
    expect(det.bands.length).toBe(0);
    expect(det.stats.bands).toBe(0);
    expect(det.stats.budgetHit).toBe(true);
    expect(ARC_DEFAULTS.budgetMs).toBe(2500);
  });

  // ── Achsen-Begrenzung: höchstens o.maxAxes Achsen-Kandidaten bearbeiten ────
  test('24: maxAxes: 0 → keine Achse → 0 Bänder (Rundrechteck)', () => {
    const prof = roundedRect(40, 30, [5, 5, 5, 5], 8);
    const fds = extrude([{ z: 0, pts2d: prof }, { z: 10, pts2d: prof }]);
    // ohne Begrenzung: 4 Bögen (eine je Ecke)
    const normal = run(fds);
    expect(normal.bands.length).toBe(4);
    // maxAxes 0 → keine Achse wird bearbeitet → keine Bänder
    const det = run(fds, { maxAxes: 0 });
    expect(det.bands.length).toBe(0);
    expect(det.stats.bands).toBe(0);
    expect(det.stats.axes).toBe(0);
    expect(ARC_DEFAULTS.maxAxes).toBe(6);
  });
});

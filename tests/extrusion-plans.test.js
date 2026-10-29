// Tests für extrusion-plans.js — Wandflächen erhabener/vertiefter Schriftzüge als
// SURFACE_OF_LINEAR_EXTRUSION über einer B-Spline-Kurve.
// Synthetisches Extrusionsband VON HAND gebaut (kein extrusion-bands.js nötig).
import {
  EXT_PLAN_DEFAULTS, buildExtPlans, expandCurveLoop, extGeomSamples, guardCorner,
} from '../extrusion-plans.js';
import { edgeCanonKey } from '../profile-arcs.js';
import { evalSpline, nearestParam, splineSamples } from '../spline-fit.js';

// ── Hilfen ──────────────────────────────────────────────────────────────────
const vtxKey = (p) => p.map((x) => (+x.toFixed(4) || 0).toFixed(4)).join(',');
const written = (p) => p.map((x) => +x.toFixed(9));

const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add3 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul3 = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const len3 = (a) => Math.hypot(a[0], a[1], a[2]);
const norm3 = (a) => { const l = len3(a); return l > 0 ? mul3(a, 1 / l) : [0, 0, 0]; };
const dist3 = (a, b) => len3(sub3(a, b));
const centroid3 = (pts) => [0, 1, 2].map((k) => pts.reduce((s, p) => s + p[k], 0) / pts.length);

/** auf 9 Nachkommastellen runden (−0 → 0) */
const r9 = (x) => { const v = +x.toFixed(9); return v === 0 ? 0 : v; };

// Kubische Bézier 2D: (0,0) → (10,0) mit Kontrollpunkten (2,5), (8,−5)
const CTRL2 = [[0, 0], [2, 5], [8, -5], [10, 0]];
function bez2(t) {
  const mt = 1 - t;
  const w = [mt * mt * mt, 3 * mt * mt * t, 3 * mt * t * t, t * t * t];
  return [0, 1].map((k) => w.reduce((s, wi, i) => s + wi * CTRL2[i][k], 0));
}

/** 25 UNGLEICHMÄSSIG dichte Stützstellen auf der Bézier */
function bezierPoints(nSeg) {
  const w = [];
  for (let i = 0; i < nSeg; i++) w.push(1 + 0.5 * Math.sin(i * 1.3));
  const sum = w.reduce((a, b) => a + b, 0);
  const out = [];
  let acc = 0;
  for (let i = 0; i < nSeg; i++) {
    acc += w[i];
    out.push(bez2(i === nSeg - 1 ? 1 : acc / sum).map(r9));
  }
  return out;
}

/** Bogen-Schlüssel wie in profile-arcs.js: Endpunkte (sortiert) + kleinster innerer Punkt */
function arcKeyOf(pts) {
  const ka = vtxKey(pts[0]), kb = vtxKey(pts[pts.length - 1]);
  const parts = ka < kb ? [ka, kb] : [kb, ka];
  let inner = '';
  for (let i = 1; i + 1 < pts.length; i++) {
    const k = vtxKey(pts[i]);
    if (!inner || k < inner) inner = k;
  }
  if (inner) parts.push(inner);
  return parts.join('|');
}

// ── Synthetisches Extrusionsband ────────────────────────────────────────────
/**
 * Erhabener Schriftzug: eine Wand aus 25 Vierecken zwischen z = 3 und z = 4 entlang
 * einer Bézier. Lo-Kante P (26 Punkte, vorwärts), Hi-Kante H (26 Punkte, rückwärts),
 * zwei ebene Deckflächen (lo: z = 3, hi: z = 4).
 *
 * opt: { tiltLo, flipFacet, sideShift, adjType }
 */
function makeCase(opt = {}) {
  const P2 = bezierPoints(25);
  const P = P2.map(([x, y]) => [x, y, 3]);                       // untere Kante
  const H = P.slice().reverse().map((p) => [p[0], p[1], 4]);    // obere Kante (rückwärts)

  // Wandfacetten: Vierecke P[k] → P[k+1] → oben → oben
  const facets = [];
  for (let k = 0; k + 1 < P.length; k++) {
    const a = P[k], b = P[k + 1];
    const aHi = [a[0], a[1], 4], bHi = [b[0], b[1], 4];
    const quad = [a, b, bHi, aHi];
    const nrm = norm3(cross3(sub3(b, a), sub3(bHi, b)));
    facets.push({ outer: quad, inner: [], normal: nrm, centroid: centroid3(quad) });
  }
  if (opt.flipFacet !== undefined) {
    const f = facets[opt.flipFacet];
    f.normal = mul3(f.normal, -1);
  }

  // Deckflächen
  const loCap = { outer: P.slice(), inner: [], normal: [0, 0, 1], centroid: centroid3(P) };
  const hiCap = { outer: H.slice(), inner: [], normal: [0, 0, 1], centroid: centroid3(H) };
  if (opt.tiltLo) {
    const t = opt.tiltLo;
    loCap.normal = [Math.sin(t), 0, Math.cos(t)];      // Kippung um die y-Achse
  }

  const fds = facets.concat([loCap, hiCap]);
  const loCapFi = facets.length, hiCapFi = facets.length + 1;

  // Seitenkante verschieben (obere Kante über P[0] → Ahi)
  if (opt.sideShift) H[H.length - 1][0] += opt.sideShift;

  const loKey = arcKeyOf(P), hiKey = arcKeyOf(H);
  const n = P.length - 1;
  const band = {
    id: 'e0', kind: 'ext', d: [0, 0, 1],
    frame: { d: [0, 0, 1], e1: [1, 0, 0], e2: [0, 1, 0] },
    facets: facets.map((_, i) => i),
    segs: [
      { type: 'arc', level: 'lo', pts: P, arcKey: loKey, adjType: 'cap', cap: { fi: loCapFi, li: 0 } },
      { type: 'line', pts: [P[n], H[0]] },
      { type: 'arc', level: 'hi', pts: H, arcKey: hiKey, adjType: 'cap', cap: { fi: hiCapFi, li: 0 } },
      { type: 'line', pts: [H[H.length - 1], P[0]] },
    ],
    levels: { lo: { t: 3 }, hi: { t: 4 } },
    sense: 1, sig: 'e0-sig', nSegs: n,
  };
  if (opt.adjType) band.segs[0].adjType = opt.adjType;

  const det = {
    bands: [band],
    arcs: new Map([
      [loKey, { key: loKey, pts: P, owners: [{ band: 'e0' }], kind: 'spline' }],
      [hiKey, { key: hiKey, pts: H, owners: [{ band: 'e0' }], kind: 'spline' }],
    ]),
    capEdits: [],
  };
  return { fds, det, band, P, H, facets, loKey, hiKey, loCapFi, hiCapFi };
}

const run = (C) => buildExtPlans(C.fds, C.det, written, { vtxKey });

// ── Band MIT Ecke (Deckfläche ist ein echtes Polygon) ───────────────────────
/**
 * Band, dessen Deckfläche ein Polygon [X, A, …Kurve…, Y] ist: der Bandkurve
 * folgen an ihren beiden Enden je ein Nachbarpunkt der Deckfläche (X an A, Y an
 * B) — das sind die „Nachbarkanten“, gegen die der Ecken-Wächter prüft.
 *
 * Die Kurve ist ein Kreisbogen (Radius 20 mm), der in A = (0,0) in +x startet
 * und 30° nach links dreht; die Bandhöhe ist 1 mm (z = 3 → z = 4).
 *
 * opt.nbrA — Nachbarpunkt X an der Ecke A (Default: [0, -10], weit weg vom
 *             Band, also unkritisch).  Setzt man X dicht an den Strahl der
 *             Kurve (scharfer Winkel), kreuzt die Kurve die Nachbarkante.
 */
function makeCornerCase(opt = {}) {
  const R = 20, aMax = (30 * Math.PI) / 180, nPts = 21;
  const P2 = [];
  for (let k = 0; k < nPts; k++) {
    const phi = (aMax * k) / (nPts - 1);
    P2.push([r9(R * Math.sin(phi)), r9(R * (1 - Math.cos(phi)))]);
  }
  const P = P2.map(([x, y]) => [x, y, 3]);                      // untere Kante
  const H = P.slice().reverse().map((p) => [p[0], p[1], 4]);   // obere Kante (rückwärts)
  const n = P.length - 1;

  // Nachbarpunkte der Deckfläche: X an A, Y an B (senkrecht zur Endtangente)
  const B = P[n];
  const X = opt.nbrA || [0, -10];
  const Y = [r9(B[0] - 5), r9(B[1] + 8.660254037844386)];

  // Wandfacetten (wie makeCase)
  const facets = [];
  for (let k = 0; k < n; k++) {
    const a = P[k], b = P[k + 1];
    const aHi = [a[0], a[1], 4], bHi = [b[0], b[1], 4];
    const quad = [a, b, bHi, aHi];
    const nrm = norm3(cross3(sub3(b, a), sub3(bHi, b)));
    facets.push({ outer: quad, inner: [], normal: nrm, centroid: centroid3(quad) });
  }

  // Deckflächen: Polygon [X, …Kurve…, Y] (oben dasselbe um z = 4 verschoben)
  const loOuter = [[X[0], X[1], 3], ...P, [Y[0], Y[1], 3]];
  const hiOuter = [[X[0], X[1], 4], ...P.map((p) => [p[0], p[1], 4]), [Y[0], Y[1], 4]];
  const loCap = { outer: loOuter, inner: [], normal: [0, 0, 1], centroid: centroid3(loOuter) };
  const hiCap = { outer: hiOuter, inner: [], normal: [0, 0, 1], centroid: centroid3(hiOuter) };

  const fds = facets.concat([loCap, hiCap]);
  const loCapFi = facets.length, hiCapFi = facets.length + 1;

  const loKey = arcKeyOf(P), hiKey = arcKeyOf(H);
  const band = {
    id: 'e0', kind: 'ext', d: [0, 0, 1],
    frame: { d: [0, 0, 1], e1: [1, 0, 0], e2: [0, 1, 0] },
    facets: facets.map((_, i) => i),
    segs: [
      { type: 'arc', level: 'lo', pts: P, arcKey: loKey, adjType: 'cap', cap: { fi: loCapFi, li: 0 } },
      { type: 'line', pts: [P[n], H[0]] },
      { type: 'arc', level: 'hi', pts: H, arcKey: hiKey, adjType: 'cap', cap: { fi: hiCapFi, li: 0 } },
      { type: 'line', pts: [H[H.length - 1], P[0]] },
    ],
    levels: { lo: { t: 3 }, hi: { t: 4 } },
    sense: 1, sig: 'e0-sig', nSegs: n,
  };
  const det = {
    bands: [band],
    arcs: new Map([
      [loKey, { key: loKey, pts: P, owners: [{ band: 'e0' }], kind: 'spline' }],
      [hiKey, { key: hiKey, pts: H, owners: [{ band: 'e0' }], kind: 'spline' }],
    ]),
    capEdits: [],
  };
  return { fds, det, band, P, H, X, Y, facets, loKey, hiKey };
}

// ── Tests ───────────────────────────────────────────────────────────────────
describe('extrusion-plans.js', () => {
  describe('buildExtPlans — erhabener Schriftzug', () => {
    test('Vorgaben', () => {
      expect(EXT_PLAN_DEFAULTS.surfTol).toBe(5e-5);
      expect(EXT_PLAN_DEFAULTS.sideTol).toBe(5e-5);
      expect(EXT_PLAN_DEFAULTS.samples).toBe(16);
    });

    test('Band ohne Fehlschlag → ein Plan, beide Splines', () => {
      const C = makeCase();
      const { plans, geoms, failed } = run(C);
      expect(failed.size).toBe(0);
      expect(plans.length).toBe(1);
      const plan = plans[0];
      expect(plan.id).toBe('e0');
      expect(plan.kind).toBe('ext');
      expect(plan.band).toBe(C.band);
      expect(geoms.has(C.loKey)).toBe(true);
      expect(geoms.has(C.hiKey)).toBe(true);
      expect(geoms.get(C.loKey).kind).toBe('spline');
      expect(geoms.get(C.hiKey).kind).toBe('spline');
      expect(geoms.get(C.loKey).A).toBe(C.P[0]);
      expect(geoms.get(C.loKey).B).toBe(C.P[C.P.length - 1]);
      expect(geoms.get(C.hiKey).A).toBe(C.H[C.H.length - 1]);
      expect(geoms.get(C.hiKey).B).toBe(C.H[0]);
      expect(plan.hiDev).toBeLessThanOrEqual(1e-3);
      expect(plan.sag).toBeGreaterThan(0);
      expect(plan.dV).toBeGreaterThanOrEqual(0);
    });

    test('jeder Netzpunkt liegt auf der unteren Kurve', () => {
      const C = makeCase();
      const { geoms } = run(C);
      const sp = geoms.get(C.loKey).sp;
      for (const p of C.P) {
        const u = nearestParam(sp, p);
        const c = evalSpline(sp, u);
        expect(dist3(c, p)).toBeLessThanOrEqual(1e-9);
      }
    });

    test('jeder Netzpunkt liegt auf der oberen Kurve', () => {
      const C = makeCase();
      const { geoms } = run(C);
      const sp = geoms.get(C.hiKey).sp;
      for (const p of C.H) {
        const u = nearestParam(sp, p);
        const c = evalSpline(sp, u);
        expect(dist3(c, p)).toBeLessThanOrEqual(1e-9);
      }
    });

    test('Kontrollpunkte exakt in den Deckebenen', () => {
      const C = makeCase();
      const { geoms } = run(C);
      for (const c of geoms.get(C.loKey).sp.ctrl) expect(Math.abs(c[2] - 3)).toBeLessThanOrEqual(1e-12);
      for (const c of geoms.get(C.hiKey).sp.ctrl) expect(Math.abs(c[2] - 4)).toBeLessThanOrEqual(1e-12);
    });

    test('Extrusionsrichtung und -länge', () => {
      const C = makeCase();
      const { plans } = run(C);
      const surf = plans[0].surf;
      expect(surf.kind).toBe('ext');
      expect(surf.dir[0]).toBeCloseTo(0, 12);
      expect(surf.dir[1]).toBeCloseTo(0, 12);
      expect(surf.dir[2]).toBeCloseTo(1, 12);
      expect(surf.len).toBeCloseTo(1, 12);
      expect(surf.sp).toBeTruthy();
    });

    test('sense folgt den Facetten-Normalen', () => {
      const C = makeCase();
      const { plans } = run(C);
      // Erwartetes Vorzeichen: Querprodukt (Kantenrichtung × hoch) gegen die Facetten-Normale
      const signs = C.facets.map((f) => {
        const n = cross3(sub3(f.outer[1], f.outer[0]), [0, 0, 1]);
        return Math.sign(dot3(n, f.normal));
      });
      expect(new Set(signs).size).toBe(1);
      expect(plans[0].sense).toBe(signs[0]);
      expect(plans[0].sense).toBe(1);
    });

    test('Dreiecke vorhanden und wie die Facetten orientiert', () => {
      const C = makeCase();
      const { plans } = run(C);
      const tris = plans[0].tris;
      expect(tris.length).toBeGreaterThan(0);
      expect(tris.length % 2).toBe(0);
      const ref = C.facets.reduce((acc, f) => add3(acc, f.normal), [0, 0, 0]);
      const n0 = cross3(sub3(tris[0][1], tris[0][0]), sub3(tris[0][2], tris[0][0]));
      expect(dot3(n0, ref)).toBeGreaterThan(0);
      // Fläche > 0 und ungefähr die Wandfläche (Länge × Höhe)
      expect(plans[0].area).toBeGreaterThan(0);
    });

    test('Bänder anderer Art werden ignoriert', () => {
      const C = makeCase();
      C.det.bands.push({ ...C.band, id: 'z0', kind: 'cyl' });
      const { plans, failed } = run(C);
      expect(plans.length).toBe(1);
      expect(failed.size).toBe(0);
    });
  });

  describe('expandCurveLoop', () => {
    test('Kanten-Bogen wird durch die Spline-Punkte ersetzt', () => {
      const C = makeCase();
      const { geoms } = run(C);
      const n = C.P.length - 1;
      const extra = [5, 5, 3];
      const capLoop = [C.P[0], C.P[n], extra];
      const arcEdges = new Map([[edgeCanonKey(vtxKey, C.P[0], C.P[n]), C.loKey]]);
      const out = expandCurveLoop(capLoop, arcEdges, geoms, vtxKey, 16);
      expect(out.length).toBe(capLoop.length + 15);
      expect(out[0]).toBe(C.P[0]);
      expect(out[16]).toBe(C.P[n]);
      expect(out[17]).toBe(extra);
      // Richtung: die eingefügten Punkte wandern von P[0] nach P[n]
      const samples = splineSamples(geoms.get(C.loKey).sp, 16);
      expect(dist3(out[1], samples[1])).toBeLessThanOrEqual(1e-12);
      for (let k = 1; k < 16; k++) {
        expect(dist3(out[k], C.P[0])).toBeLessThan(dist3(out[k + 1], C.P[0]));
        expect(dist3(out[k], C.P[n])).toBeGreaterThan(dist3(out[k + 1], C.P[n]));
      }
    });

    test('läuft der Loop rückwärts, kommen die Punkte umgekehrt', () => {
      const C = makeCase();
      const { geoms } = run(C);
      const n = C.P.length - 1;
      const extra = [5, 5, 3];
      const capLoop = [C.P[n], C.P[0], extra];
      const arcEdges = new Map([[edgeCanonKey(vtxKey, C.P[0], C.P[n]), C.loKey]]);
      const out = expandCurveLoop(capLoop, arcEdges, geoms, vtxKey, 16);
      expect(out.length).toBe(capLoop.length + 15);
      expect(out[0]).toBe(C.P[n]);
      expect(out[16]).toBe(C.P[0]);
      for (let k = 1; k < 16; k++) {
        expect(dist3(out[k], C.P[n])).toBeLessThan(dist3(out[k + 1], C.P[n]));
        expect(dist3(out[k], C.P[0])).toBeGreaterThan(dist3(out[k + 1], C.P[0]));
      }
    });

    test('ohne Bogen-Kante bleibt der Loop unverändert', () => {
      const C = makeCase();
      const { geoms } = run(C);
      const L = [C.P[0], C.P[C.P.length - 1], [5, 5, 3]];
      const out = expandCurveLoop(L, new Map(), geoms, vtxKey, 16);
      expect(out).toEqual(L);
    });
  });

  describe('extGeomSamples', () => {
    test('Spline-Geometrie: n+1 Punkte, Ränder exakt', () => {
      const C = makeCase();
      const { geoms } = run(C);
      const g = geoms.get(C.loKey);
      const s = extGeomSamples(g, 16);
      expect(s.length).toBe(17);
      expect(dist3(s[0], g.Aw)).toBe(0);
      expect(dist3(s[16], g.Bw)).toBe(0);
    });
  });

  describe('Fehlerfälle', () => {
    test('(a) Ahi um 0.01 mm in x verschoben → Scheitern (Seitenkante)', () => {
      const C = makeCase({ sideShift: 0.01 });
      const { plans, failed } = run(C);
      expect(plans.length).toBe(0);
      expect(failed.has('e0')).toBe(true);
    });

    test('(b) lo-Deckebene um 1e-3 rad gekippt → Scheitern', () => {
      const C = makeCase({ tiltLo: 1e-3 });
      const { plans, failed } = run(C);
      expect(plans.length).toBe(0);
      expect(failed.has('e0')).toBe(true);
    });

    test('(c) eine Facetten-Normale gespiegelt → Scheitern (sense)', () => {
      const C = makeCase({ flipFacet: 3 });
      const { plans, failed } = run(C);
      expect(plans.length).toBe(0);
      expect(failed.has('e0')).toBe(true);
    });

    test('(d) Bogen grenzt an ein Band statt an eine Deckfläche → Scheitern', () => {
      const C = makeCase({ adjType: 'band' });
      const { plans, failed } = run(C);
      expect(plans.length).toBe(0);
      expect(failed.has('e0')).toBe(true);
    });
  });

  // ── Ecken-Wächter (guardCorner) ───────────────────────────────────────────
  //
  // ARGUMENTE (alles 2D in der Deckebene, projiziert):
  //   corner2  [x, y]      Eckpunkt der Deckfläche (Start der Bandkurve)
  //   c2       [x, y]      Endsehne: Vektor vom Eckpunkt in die Bandkurve
  //   e2       [x, y]      Nachbarkante: Vektor vom Eckpunkt zum Nachbarpunkt
  //                         der Deckfläche (die „Nachbarkante“ als STRAHL)
  //   t2       [x, y]      Endtangente der Spline, zeigt IN die Kurve
  //   samples2 [[x, y], …] Abtastpunkte der Kurve OHNE die beiden Endpunkte,
  //                         absolut im Deckebenen-System
  //
  // Die Prüfungen im Code:
  //   (b) cross2(e2, t2) · cross2(e2, c2) < 0 UND t2·e2 > 0 → 'Endtangente kreuzt …'
  //   (c) je Abtastpunkt s: d = s − corner2; nur wenn |d| ≤ |e2| UND d·e2 > 0:
  //         |cross2(e2, d)| / |e2| ≤ 1e-6 mm → 'Kurve berührt …'
  //         cross2(e2, d) · cross2(e2, c2) < 0    → 'Kurve kreuzt …'
  describe('guardCorner — Ecken-Wächter direkt', () => {
    // Ecke in (0,0), Nachbarkante nach +x (e2 = [10,0]), Kurve nach +y (c2 = [0,10])
    const CORNER = [0, 0];
    const CHORD = [0, 10];
    const EDGE = [10, 0];

    test('(1) Kurve innen an der Nachbarkante, weit von ihr → null', () => {
      const r = guardCorner(CORNER, CHORD, EDGE, [0, 1], [[2, 5], [3, 8], [4, 6]]);
      expect(r).toBeNull();
    });

    test('(2) Endtangente kreuzt die Nachbarkante → Meldung', () => {
      const r = guardCorner(CORNER, CHORD, EDGE, [1, -1], []);
      expect(typeof r).toBe('string');
      expect(r).toMatch(/Endtangente kreuzt/);
    });

    test('(3) Kurve berührt die Nachbarkante (< 1e-6 mm) → Meldung', () => {
      const r = guardCorner(CORNER, CHORD, EDGE, [0, 1], [[5, 1e-9]]);
      expect(typeof r).toBe('string');
      expect(r).toMatch(/ber(?:ü|ue)hrt/);
    });

    test('(4) Kurve kreuzt die Nachbarkante → Meldung', () => {
      const r = guardCorner(CORNER, CHORD, EDGE, [0, 1], [[5, -2]]);
      expect(typeof r).toBe('string');
      expect(r).toMatch(/kreuzt die Nachbarkante/);
    });

    test('(5) Abtastpunkt weit von der Ecke (> |e2|) → ignoriert', () => {
      const r = guardCorner(CORNER, CHORD, EDGE, [0, 1], [[20, -2]]);
      expect(r).toBeNull();
    });

    test('(6) Abtastpunkt hinter der Ecke (d·e2 ≤ 0) → ignoriert', () => {
      const r = guardCorner(CORNER, CHORD, EDGE, [0, 1], [[-5, -2]]);
      expect(r).toBeNull();
    });
  });

  describe('Ecken-Wächter — Integration über buildExtPlans', () => {
    // Nachbarpunkt X an der Ecke A = (0,0), 10 mm weit auf dem Strahl 5°
    // (gegen die Startrichtung der Kurve) → sehr spitzer Winkel
    const sharp = [
      r9(10 * Math.cos((5 * Math.PI) / 180)),
      r9(10 * Math.sin((5 * Math.PI) / 180)),
    ];
    // derselbe Punkt, aber 90° zur Startrichtung der Kurve → weiter Winkel
    const wide = [0, 10];

    test('scharfer Winkel: Spline kreuzt die Nachbarkante → Band scheitert', () => {
      const C = makeCornerCase({ nbrA: sharp });
      const { plans, failed, reasons } = run(C);
      expect(failed.has('e0')).toBe(true);
      expect(plans.length).toBe(0);
      expect(reasons.get('e0')).toMatch(/Ecke unten vorn/);
      expect(reasons.get('e0')).toMatch(/Kurve kreuzt die Nachbarkante/);
    });

    test('weiter Winkel: dasselbe Band kommt durch', () => {
      const C = makeCornerCase({ nbrA: wide });
      const { plans, failed, reasons } = run(C);
      expect(failed.size).toBe(0);
      expect(reasons.size).toBe(0);
      expect(plans.length).toBe(1);
      expect(plans[0].id).toBe('e0');
    });
  });
});

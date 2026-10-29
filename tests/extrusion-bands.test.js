// Tests für extrusion-bands.js — Extrusionsbänder (Schriftzüge als Spline-Wände).
// Eigener Generator, keine Projektdateien als Quelle.
import { EXT_DEFAULTS, findExtBands, mergeDets, splitDet, dropCollisions } from '../extrusion-bands.js';
import { validateArcBands, applyArcBands, edgeCanonKey } from '../profile-arcs.js';

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

// Ebene Fläche aus einem Punktloop (Normalen aus den ersten drei Punkten)
const face = (pts, normal) => {
  const nn = normal || norm3(cross3(sub3(pts[1], pts[0]), sub3(pts[2], pts[1])));
  const c = [0, 1, 2].map((k) => pts.reduce((s, p) => s + p[k], 0) / pts.length);
  return { outer: pts, inner: [], normal: nn, centroid: c };
};

// Punkte-Cache: gleiche Koordinaten → gleiches Objekt (der vtxKey passt überall)
const cache = new Map();
function pt(x, y, z) {
  const k = vtxKey([x, y, z]);
  let p = cache.get(k);
  if (!p) { p = [x, y, z]; cache.set(k, p); }
  return p;
}

// ── Konturen (alle CCW) ────────────────────────────────────────────────────

// Kubischer Bezier, ungleichmäßig abgetastet (die Parametrisierung ist monoton)
function cubicFlat(P0, P1, P2, P3, n) {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = t - (0.2 / (2 * Math.PI)) * Math.sin(2 * Math.PI * t);
    const v = 1 - u;
    out.push([
      v * v * v * P0[0] + 3 * v * v * u * P1[0] + 3 * v * u * u * P2[0] + u * u * u * P3[0],
      v * v * v * P0[1] + 3 * v * v * u * P1[1] + 3 * v * u * u * P2[1] + u * u * u * P3[1],
    ]);
  }
  return out;
}

// (a) „S“-förmiger Zug: zwei kubische Bögen mit je einer scharfen Ecke an den Enden
function sContour() {
  const A = [0, 0], B = [10, 0];
  const r1 = cubicFlat(A, [3, -6], [7, -6], B, 18);      // unterer Bogen A → B
  const r2 = cubicFlat(B, [7, 6], [3, 6], A, 24);        // oberer Bogen B → A
  return r1.concat(r2.slice(1, -1));                    // geschlossen (A kommt nicht doppelt vor)
}

// (b) reiner Kreis
function circleContour(n, r) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = 2 * Math.PI * i / n;
    out.push([r * Math.cos(a), r * Math.sin(a)]);
  }
  return out;
}

// (c) geschlossene glatte NICHT-kreisrunde Kurve (Superellipse)
function superContour(a, b, n, e) {
  const p = 2 / e;
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = 2 * Math.PI * i / n;
    const c = Math.cos(t), s = Math.sin(t);
    out.push([
      a * Math.sign(c) * Math.pow(Math.abs(c), p),
      b * Math.sign(s) * Math.pow(Math.abs(s), p),
    ]);
  }
  return out;
}

// (d) Rundrechteck: vier gerade Seiten (je EINE Facette) + vier Viertelkreise (8 Seg.)
function roundedRectContour(w, h, r, segs) {
  const corners = [
    [[w / 2 - r, -h / 2 + r], -90, 0],
    [[w / 2 - r, h / 2 - r], 0, 90],
    [[-w / 2 + r, h / 2 - r], 90, 180],
    [[-w / 2 + r, -h / 2 + r], 180, 270],
  ];
  const out = [];
  for (const [c, a0, a1] of corners) {
    for (let i = 0; i <= segs; i++) {
      const a = (a0 + (a1 - a0) * i / segs) * Math.PI / 180;
      out.push([c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)]);
    }
  }
  return out;                                            // 36 Punkte (die geraden Seiten sind die Kanten dazwischen)
}

// (e) Stadion: zwei tangential an die langen Geraden stoßende Halbkreise
function stadiumContour(L, r, segs) {
  const out = [];
  out.push([-L / 2, -r], [L / 2, -r]);                    // untere Gerade (1 Facette)
  for (let i = 1; i <= segs; i++) {
    const a = (-90 + 180 * i / segs) * Math.PI / 180;
    out.push([L / 2 + r * Math.cos(a), r * Math.sin(a)]);
  }
  out.push([-L / 2, r]);                                 // obere Gerade (1 Facette)
  for (let i = 1; i < segs; i++) {
    const a = (90 + 180 * i / segs) * Math.PI / 180;
    out.push([-L / 2 + r * Math.cos(a), r * Math.sin(a)]);
  }
  return out;                                            // geschlossen (der Start kommt nicht doppelt vor)
}

// (e) zwei kubische Kurven, die TANGENTIAL an eine lange Gerade stoßen
// (die Gerade ist eine Facette für sich — sie bleibt planar)
function tangentCurvesContour() {
  const P0 = [0, 0], P1 = [10, -3], P2 = [24, -3];
  const c1 = cubicFlat(P0, [2, -6], [7, -3], P1, 16);    // untere Kurve P0 → P1 (Endtangente +x)
  const c2 = cubicFlat(P2, [27, -3], [6, 3], P0, 16);    // obere Kurve P2 → P0 (Anfangstangente +x)
  return { pts: c1.concat([P2], c2.slice(1, -1)), straightIdx: c1.length - 1 };
}

// (f) Taschen-Kontur wie im Fixture k1 (Kabelhalter): Rechteck 12×8, Unterseite als flacher
//     Bogen R10 (12 Sehnen), alle vier Ecken senkrecht r=0.5 (16 Seg.). Der Lauf unten ist
//     „Eckenrundung r0.5 → Bogen R10 → Eckenrundung r0.5“ (die beiden geraden Seiten sind
//     Breaks → der Lauf ist ein OFFENES Stück). Die beiden oberen Eckbögen sind je ein
//     einzelner Kreis (16 Seg.) → der Bogen-Pfad übernimmt sie.
function archPocketContour() {
  const x0 = 0, y0 = 0, w = 12, h = 8, f = 2, arcSeg = 12, rc = 0.5, seg = 16;
  const Rb = ((w / 2) ** 2 + f * f) / (2 * f);          // 10 → der flache Bogen R10
  const cx = x0 + w / 2, cy = y0 + Rb - f;
  const ex = x0 + rc;
  const ey = cy - Math.sqrt((Rb - rc) ** 2 - (ex - cx) ** 2);
  const aT = Math.atan2(ey - cy, ex - cx);             // Tangentenpunkt am Bogen (links)
  const pts = [];
  const corner = (mx, my, a0, a1) => {
    for (let k = 0; k <= seg; k++) {
      const a = a0 + (a1 - a0) * k / seg;
      pts.push([mx + rc * Math.cos(a), my + rc * Math.sin(a)]);
    }
  };
  corner(ex, ey, Math.PI, aT + 2 * Math.PI);            // unten links: Seite → Bogen
  for (let k = 1; k < arcSeg; k++) {                    // der flache Bogen (12 Sehnen)
    const a = aT + (-Math.PI - 2 * aT) * k / arcSeg;
    pts.push([cx + Rb * Math.cos(a), cy + Rb * Math.sin(a)]);
  }
  corner(x0 + w - rc, ey, Math.PI - aT, 2 * Math.PI);   // unten rechts: Bogen → Seite
  corner(x0 + w - rc, y0 + h - rc, 0, Math.PI / 2);
  corner(x0 + rc, y0 + h - rc, Math.PI / 2, Math.PI);
  return pts;
}

// ── Platte mit erhabener Glyphe ────────────────────────────────────────────
// Platte z = 0…3, Glyphenwand z = 3…4, Glyphen-Oberkappe bei z = 4,
// Platten-Oberfläche bei z = 3 mit der Kontur als Innen-Loop.
function glyphPlate(contour) {
  const fds = [];
  const n = contour.length;
  for (let i = 0; i < n; i++) {
    const a = contour[i], b = contour[(i + 1) % n];
    fds.push(face([pt(a[0], a[1], 3), pt(b[0], b[1], 3), pt(b[0], b[1], 4), pt(a[0], a[1], 4)]));
  }
  fds.push(face(contour.map((c) => pt(c[0], c[1], 4)), [0, 0, 1]));          // Glyphen-Oberkappe
  const top = face([pt(-60, -60, 3), pt(60, -60, 3), pt(60, 60, 3), pt(-60, 60, 3)], [0, 0, 1]);
  top.inner = [contour.map((c) => pt(c[0], c[1], 3)).reverse()];             // Kontur als Loch
  fds.push(top);
  const B = [[-60, -60], [60, -60], [60, 60], [-60, 60]];
  for (let i = 0; i < 4; i++) {
    const a = B[i], b = B[(i + 1) % 4];
    fds.push(face([pt(a[0], a[1], 0), pt(b[0], b[1], 0), pt(b[0], b[1], 3), pt(a[0], a[1], 3)]));
  }
  fds.push(face([pt(-60, 60, 0), pt(60, 60, 0), pt(60, -60, 0), pt(-60, -60, 0)], [0, 0, -1]));
  return fds;
}

const run = (fds, opts = {}) => findExtBands(fds, { vtxKey, ...opts });

describe('extrusion-bands.js — Extrusionsbänder (Schrift als Spline-Wand)', () => {
  test('1: S-Zug (Linse aus zwei Kubikbögen) → keine zwei Kurven mit gleichem Endpunkt-Paar', () => {
    const contour = sContour();
    const fds = glyphPlate(contour);
    const det = run(fds);
    // die Linse wird an den beiden scharfen Ecken getrennt; das längere Band wird
    // zusätzlich geteilt, damit keine zwei Kurven dasselbe Endpunkt-Paar haben
    expect(det.bands.length).toBeGreaterThanOrEqual(3);
    expect(det.stats.collisionSplits).toBeGreaterThanOrEqual(1);
    expect(det.stats.collisionDrops).toBe(0);
    // Datenmodell wie profile-arcs
    for (const b of det.bands) {
      expect(b.kind).toBe('ext');
      expect(typeof b.id).toBe('string');
      expect(b.id).toMatch(/^e\d+$/);
      expect(b.facets.length).toBeGreaterThanOrEqual(EXT_DEFAULTS.minFacets);
      expect(b.segs.length).toBe(4);
      expect(b.segs.map((s) => s.type)).toEqual(['arc', 'line', 'arc', 'line']);
      expect(b.segs[0].level).toBe('lo');
      expect(b.segs[2].level).toBe('hi');
      expect(b.segs[0].arcKey.startsWith('x|')).toBe(true);
      expect(b.segs[2].arcKey.startsWith('x|')).toBe(true);
      expect(b.segs[1].pts.length).toBe(2);
      expect(b.segs[3].pts.length).toBe(2);
      expect(b.levels.lo.t).toBeCloseTo(3, 9);
      expect(b.levels.hi.t).toBeCloseTo(4, 9);
      expect(b.nSegs).toBe(b.facets.length);
      expect(b.sense).toBe(1);                            // alle Facetten gleich orientiert
      expect(b.sig.split(';').length).toBe(4);
    }
    // eindeutige Band-Ids
    const ids = det.bands.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
    // KEINE zwei Kurven mit demselben Endpunkt-Paar — sonst überschreiben sie sich
    // in der arcEdges-Map der Deckfläche
    const curveKeys = det.bands.flatMap((b) => b.segs.filter((s) => s.type === 'arc')
      .map((s) => edgeCanonKey(vtxKey, s.pts[0], s.pts[s.pts.length - 1])));
    expect(new Set(curveKeys).size).toBe(curveKeys.length);
    // die Bogen-Schlüssel (mit innerem Punkt) sind ebenfalls eindeutig
    const keys = det.bands.flatMap((b) => b.segs.filter((s) => s.type === 'arc').map((s) => s.arcKey));
    expect(new Set(keys).size).toBe(keys.length);
    // keine scharfe Ecke liegt INNERHALB eines Bandes (die Ecken sind Band-Grenzen)
    const cornerKeys = new Set([vtxKey(pt(0, 0, 3)), vtxKey(pt(10, 0, 3))]);
    for (const b of det.bands) {
      for (const seg of [b.segs[0], b.segs[2]]) {
        const inner = seg.pts.slice(1, -1).map(vtxKey);
        expect(inner.some((k) => cornerKeys.has(k))).toBe(false);
      }
    }
    // validateArcBands: die Bögen grenzen an die Deckflächen → alle Bänder bleiben
    validateArcBands(fds, det, { vtxKey });
    expect(det.bands.length).toBeGreaterThanOrEqual(3);
    expect(det.stats.valid).toBe(det.bands.length);
    expect(det.capEdits.length).toBe(2 * det.bands.length);
    expect(det.arcs.size).toBe(2 * det.bands.length);
    for (const rec of det.arcs.values()) {
      expect(rec.kind).toBe('spline');
      expect(rec.owners.length).toBe(1);
    }
    // wie viele Kurven grenzen an welche Deckfläche?
    const capCount = new Map();
    for (const b of det.bands) {
      for (const seg of b.segs) {
        if (seg.type !== 'arc' || seg.adjType !== 'cap') continue;
        capCount.set(seg.cap.fi, (capCount.get(seg.cap.fi) || 0) + 1);
      }
    }
    expect(capCount.size).toBe(2);                       // Platten-Oberfläche + Glyphen-Oberkappe
    // applyArcBands: die Wand-Facetten verschwinden, die Deckflächen glätten
    const res = applyArcBands(fds, det, { vtxKey });
    expect(res.removed.size).toBeGreaterThan(0);
    expect(res.fds.length).toBe(fds.length - res.removed.size);
    // je Deckfläche: EIN Bogen-Eintrag (arcEdges) pro angrenzender Kurve
    for (const [fi, n] of capCount) {
      let gone = 0;
      for (let i = 0; i < fi; i++) if (res.removed.has(i)) gone++;
      const fd = res.fds[fi - gone];
      expect(fd.arcEdges instanceof Map).toBe(true);
      expect(fd.arcEdges.size).toBe(n);
    }
  });

  test('2: reiner Kreis (48 Seg.) → 0 Bänder (der Bogen-Pfad übernimmt)', () => {
    const fds = glyphPlate(circleContour(48, 5));
    const det = run(fds);
    expect(det.bands.length).toBe(0);
    expect(det.stats.circleSkipped).toBeGreaterThanOrEqual(1);
    expect(det.arcs.size).toBe(0);
  });

  test('3: geschlossene glatte Nicht-Kreis-Kurve (Superellipse) → genau 3 Bänder', () => {
    const fds = glyphPlate(superContour(8, 5, 60, 2.6));
    const det = run(fds);
    expect(det.bands.length).toBe(3);
    expect(det.stats.circleSkipped).toBe(0);
    for (const b of det.bands) {
      expect(b.kind).toBe('ext');
      expect(b.segs.length).toBe(4);
      expect(b.sense).toBe(1);
    }
    // jede Facette der Wand kommt in höchstens EINEM Band vor
    const counts = new Map();
    for (const b of det.bands) for (const fi of b.facets) counts.set(fi, (counts.get(fi) || 0) + 1);
    expect([...counts.values()].every((c) => c === 1)).toBe(true);
    validateArcBands(fds, det, { vtxKey });
    expect(det.bands.length).toBe(3);
    expect(det.capEdits.length).toBe(6);
  });

  test('4: Rundrechteck (gerade Seiten + Viertelkreise) → 0 Bänder', () => {
    const fds = glyphPlate(roundedRectContour(40, 30, 5, 8));
    const det = run(fds);
    expect(det.bands.length).toBe(0);
    expect(det.stats.circleSkipped).toBeGreaterThanOrEqual(1);
  });

  test('5: lange tangential angebundene Gerade → die Gerade ist in keinem Band', () => {
    const { pts, straightIdx } = tangentCurvesContour();
    const fds = glyphPlate(pts);
    const det = run(fds);
    // die beiden Kurven sind Bänder, die lange Gerade bleibt planar
    expect(det.bands.length).toBe(2);
    expect(det.stats.straightFacets).toBe(1);
    for (const b of det.bands) expect(b.facets).not.toContain(straightIdx);
    const inBands = new Set();
    for (const b of det.bands) for (const fi of b.facets) inBands.add(fi);
    expect(inBands.has(straightIdx)).toBe(false);
    // die Gerade ist auch nicht in der Menge der beanspruchten Facetten
    expect(det.claimed.has(straightIdx)).toBe(false);
    // Kontrolle: Stadion (Halbkreise + lange Geraden) → alles Kreisbögen → 0 Bänder
    const stad = run(glyphPlate(stadiumContour(20, 5, 8)));
    expect(stad.bands.length).toBe(0);
    expect(stad.stats.straightFacets).toBeGreaterThanOrEqual(2);
  });

  test('6: gesperrte Signatur (opts.blocked) → das Band fehlt', () => {
    const fds = glyphPlate(sContour());
    const first = run(fds);
    expect(first.bands.length).toBeGreaterThanOrEqual(3);
    const blocked = new Set([first.bands[0].sig]);
    const second = run(fds, { blocked });
    // die beiden S-Hälften haben dieselben vier Eckpunkte (A und B, je unten/oben)
    // → dieselbe Signatur → beide fallen weg
    expect(second.bands.length).toBeLessThan(first.bands.length);
    expect(second.bands.some((b) => b.sig === first.bands[0].sig)).toBe(false);
    expect(second.stats.bands).toBe(second.bands.length);
    // eine gesperrte TEIL-Signatur (aus dem Kollisions-Split) entfernt dieses Band
    const last = first.bands[first.bands.length - 1];
    const third = run(fds, { blocked: new Set([last.sig]) });
    expect(third.bands.length).toBeLessThan(first.bands.length);
    expect(third.bands.some((b) => b.sig === last.sig)).toBe(false);
    expect(third.stats.bands).toBe(third.bands.length);
  });

  test('7: mergeDets / splitDet — Runde mit leerem Bogen-Ergebnis', () => {
    const fds = glyphPlate(sContour());
    const ext = run(fds);
    const empty = { bands: [], arcs: new Map(), stats: { bands: 0, cyl: 0, cone: 0 } };
    const merged = mergeDets(empty, ext);
    expect(merged.bands.length).toBe(ext.bands.length);
    expect(merged.arcs.size).toBe(ext.arcs.size);
    expect(merged.stats.ext).toBe(ext.stats);
    expect(merged.stats.bands).toBe(0);
    // null ist erlaubt
    const none = mergeDets(null, null);
    expect(none.bands.length).toBe(0);
    expect(none.arcs.size).toBe(0);

    // splitDet: alles ist ein Extrusions-Band
    const det = { bands: merged.bands, arcs: merged.arcs, capEdits: [], stats: merged.stats };
    validateArcBands(fds, det, { vtxKey });
    const sp = splitDet(det);
    expect(sp.ext.bands.length).toBe(ext.bands.length);
    expect(sp.arc.bands.length).toBe(0);
    expect(sp.ext.arcs.size).toBe(ext.arcs.size);
    expect(sp.arc.arcs.size).toBe(0);
    expect(sp.ext.capEdits.length).toBe(det.capEdits.length);
    expect(sp.arc.capEdits.length).toBe(0);
    expect(sp.ext.stats).toBe(det.stats);
  });

  test('8: gesperrte Gruppe (opts.blockedGroups) → deren Wand-Facetten bleiben unbenutzt', () => {
    const fds = glyphPlate(sContour());
    // die Wand-Facetten (die ersten contour.length Flächen) bekommen die Gruppe 'wand'
    const wallCount = sContour().length;
    for (let i = 0; i < wallCount; i++) fds[i].group = 'wand';
    const normal = run(fds);
    expect(normal.bands.length).toBeGreaterThanOrEqual(3);
    const blocked = run(fds, { blockedGroups: new Set(['wand']) });
    expect(blocked.bands.length).toBe(0);
    expect(blocked.claimed.size).toBe(0);
  });

  test('9: Zeitbudget (budgetMs: 0) → 0 Bänder, stats.budgetHit = true', () => {
    const fds = glyphPlate(sContour());
    const normal = run(fds);
    expect(normal.bands.length).toBeGreaterThanOrEqual(3);
    expect(normal.stats.budgetHit).toBe(false);
    const det = run(fds, { budgetMs: 0 });
    expect(det.bands.length).toBe(0);
    expect(det.stats.budgetHit).toBe(true);
    expect(EXT_DEFAULTS.budgetMs).toBe(2500);
  });

  test('10: dropCollisions — Extrusions-Band mit demselben Endpunkt-Paar wie ein Bogen fällt weg', () => {
    const fds = glyphPlate(sContour());
    const det = run(fds);
    expect(det.bands.length).toBeGreaterThanOrEqual(3);
    const victim = det.bands[0];
    const lo = victim.segs[0];
    // ein "Kreis-Bogen-Band" mit genau demselben Endpunkt-Paar
    const fakeArc = {
      bands: [{
        id: 'a0', kind: 'arc',
        segs: [{ type: 'arc', level: 'lo', pts: [lo.pts[0], lo.pts[lo.pts.length - 1]] }],
      }],
      arcs: new Map(),
      stats: {},
    };
    const extDet = { bands: det.bands, arcs: det.arcs, stats: det.stats };
    const res = dropCollisions(fakeArc, extDet, vtxKey);
    expect(res.bands.length).toBe(det.bands.length - 1);
    expect(res.bands.some((b) => b.id === victim.id)).toBe(false);
    expect(res.stats.collisionWithArcs).toBe(1);
    // ohne vtxKey greift derselbe Notfall-Ersatz (vier Nachkommastellen)
    const res2 = dropCollisions(fakeArc, extDet);
    expect(res2.bands.length).toBe(det.bands.length - 1);
    // mergeDets lässt das kollidierende Band weg und zählt die Kollisionen
    const merged = mergeDets(fakeArc, extDet, vtxKey);
    expect(merged.bands.length).toBe(det.bands.length);   // 1 Bogen-Band + (n−1) Extrusions-Bänder
    expect(merged.stats.ext.collisionWithArcs).toBe(1);
  });

  test('11: offener Lauf (Rundung r0.5 → Bogen R10 → Rundung r0.5) → bleibt beim Bogen-Pfad', () => {
    const fds = glyphPlate(archPocketContour());
    const det = run(fds);
    // Der Lauf unten ist von drei guten Kreisstücken bedeckt (16 / 17 / 9 Segmente, Ø 14) —
    // der Bogen-Pfad (profile-arcs) macht daraus drei echte Zylinder, der Extrusions-Pfad
    // würde daraus EINEN Spline machen (falsch).
    expect(det.bands.length).toBe(0);
    expect(det.stats.circleSkipped).toBeGreaterThanOrEqual(1);
    // Gegenprobe: mit einem strengen arcAvgSegs wandert der Lauf in den Extrusions-Pfad
    const strict = run(fds, { arcAvgSegs: 100 });
    expect(strict.stats.circleSkipped).toBeLessThan(det.stats.circleSkipped);
    expect(strict.bands.length).toBe(1);
  });

  test('12: arcDet entscheidet nach dem TATSÄCHLICHEN Bogen-Ergebnis, nicht nach der Kreis-Schätzung', () => {
    const contour = archPocketContour();
    const fds = glyphPlate(contour);
    // (a) ohne arcDet: die geometrische Regel schickt den offenen Lauf zum Bogen-Pfad
    const geo = run(fds);
    expect(geo.bands.length).toBe(0);
    expect(geo.stats.circleSkipped).toBeGreaterThanOrEqual(1);
    // der Lauf, den die geometrische Regel an profile-arcs gab (Gegenprobe arcAvgSegs)
    const strict = run(fds, { arcAvgSegs: 100 });
    expect(strict.bands.length).toBe(1);
    const runFacets = new Set(strict.bands[0].facets);
    // (b) arcDet OHNE Bänder: profile-arcs hat dort nichts gebaut → der Lauf MUSS in den
    //     Extrusions-Pfad (sonst bleiben die Wände als ~50 flache Facetten stehen)
    const none = run(fds, { arcDet: { bands: [] } });
    expect(none.bands.length).toBeGreaterThanOrEqual(1);
    expect(none.bands.some((b) => b.facets.length === runFacets.size &&
      b.facets.every((fi) => runFacets.has(fi)))).toBe(true);
    // (c) arcDet, dessen 2 Bänder den Lauf (und die übrigen Stücke) abdecken: alle Stücke
    //     bleiben beim Bogen-Pfad → 0 Bänder
    const wall = Array.from({ length: contour.length }, (_, i) => i);
    const two = { bands: [{ facets: wall.slice(0, 40) }, { facets: wall.slice(40) }] };
    const kept = run(fds, { arcDet: two });
    expect(kept.bands.length).toBe(0);
    expect(kept.stats.circleSkipped).toBeGreaterThanOrEqual(1);
  });
});

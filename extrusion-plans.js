// ─────────────────────────────────────────────────────────────────────────────
// extrusion-plans.js — Wand eines erhabenen/vertieften Schriftzugs als echte
// SURFACE_OF_LINEAR_EXTRUSION (STEP) über einer interpolierten B-Spline-Kurve.
//
// ENTWURF
// Ein erhabener (oder vertiefter) Schriftzug ist ein schmaler Streifen: eine Wand aus
// ebenen, senkrechten Facetten zwischen ZWEI parallelen Deckflächen (unten/oben). Die
// untere Kante des Streifens ist ein Polygonzug in der unteren Ebene, die obere Kante
// derselbe Zug, um die Wandhöhe versetzt. Statt die Wand facettiert zu schreiben, wird
// sie als lineare Extrusion über der unteren Kante geschrieben:
//   SURFACE_OF_LINEAR_EXTRUSION( B_SPLINE_CURVE(untere Kante), VECTOR(dir, len) )
// Die obere Kante entsteht von selbst — die Extrusion verschiebt die Kurve um v.
//
// Datenmodell (siehe extrusion-bands.js und profile-arcs.js):
//   Band = { id, kind:'ext', d, frame, facets, segs, levels, sense, sig, nSegs }
//   segs = [ Bogen unten, Seite, Bogen oben, Seite ]; der Bogen unten läuft P[0]→P[n],
//          der Bogen oben LÄUFT RÜCKWÄRTS (H[0] über P[n], H[letzte] über P[0]).
//   Nach validateArcBands trägt jedes 'arc'-Segment adjType ('cap'|'band') und ggf.
//   cap = { fi, li } (die ebene Deckfläche im Index der ORIGINALEN fds).
//
// Voraussetzungen — jede verletzte führt zum Scheitern des Bands (failed):
//   - beide Bögen grenzen an eine ebene Deckfläche (adjType 'cap'),
//   - die beiden Seitenkanten sind parallel und gleich lang (sideTol),
//   - die Endpunkte liegen exakt auf ihren Deckebenen (surfTol),
//   - die untere Kurve bleibt auf der unteren Ebene, die obere auf der oberen,
//   - die oberen Innenpunkte liegen auf der um v verschobenen unteren Kurve (hiDev),
//   - alle Wandfacetten haben dieselbe STEP-Normale (sense).
//
// Alles gerechnet wird mit den GESCHRIEBENEN Koordinaten (written(p)): geschnappt und
// auf 9 Nachkommastellen gerundet — nur diese sind für den STEP-Import exakt.
//
// Geometrie der Fläche: die natürliche Normale der Extrusion ist C'(u) × v (Querprodukt
// aus der Kurventangente und der Extrusionsrichtung) — daraus wird das sense (Vorzeichen
// der STEP-Flächennormale) je Facette abgeleitet.
//
// API:
//   EXT_PLAN_DEFAULTS, buildExtPlans(fds, det, written, opts), expandCurveLoop(...),
//   extGeomSamples(geom, n)
// ─────────────────────────────────────────────────────────────────────────────

import { arcSamples, edgeCanonKey } from './profile-arcs.js';
import {
  interpolateCubic, evalSpline, derivSpline, splineSamples,
  spanDeviation, translateSpline, nearestParam,
} from './spline-fit.js';

/** Vorgaben der Extrusions-Planung. */
export const EXT_PLAN_DEFAULTS = {
  surfTol: 5e-5,      // mm: Endpunkt/Probe ↔ Deckebene (strenge Importer-Toleranz)
  sideTol: 5e-5,      // mm: Parallelität der beiden Seitenkanten
  samples: 16,        // Abtastpunkte je Kurve für die Ebenen-Prüfung
};

// ── Vektor-Helfer ───────────────────────────────────────────────────────────
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a); return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0]; };

/** Notfall-Vertex-Schlüssel (wie in profile-arcs.js): vier Nachkommastellen, −0 → 0. */
const defaultVtxKey = (p) => (p || []).map((x) => (+x.toFixed(4) || 0).toFixed(4)).join(',');

/** Schwerpunkt einer Punktliste */
const centroidOf = (pts) => {
  if (!pts || !pts.length) return null;
  const c = [0, 0, 0];
  for (const p of pts) { c[0] += p[0]; c[1] += p[1]; c[2] += p[2]; }
  return [c[0] / pts.length, c[1] / pts.length, c[2] / pts.length];
};

/** Zwei basisvektoren IN der Ebene mit der Normalen n (rechtshändig: e1 × e2 = n) */
function planeBasis(n) {
  const ax = Math.abs(n[0]), ay = Math.abs(n[1]), az = Math.abs(n[2]);
  const ref = ax <= ay && ax <= az ? [1, 0, 0] : (ay <= az ? [0, 1, 0] : [0, 0, 1]);
  const e1 = norm(cross(n, ref));
  const e2 = cross(n, e1);
  return { e1, e2 };
}

/** Abstand eines Punktes zur Ebene (Normalen n, Punkt c auf der Ebene) */
const planeDist = (n, c, p) => Math.abs(dot(n, sub(p, c)));

/** Orthogonale Projektion eines Punktes auf die Ebene (n, c) */
const projectOnPlane = (n, c, p) => sub(p, mul(n, dot(n, sub(p, c))));

/** Vorzeichenbehafteter Flächeninhalt eines geschlossenen 2D-Zugs (Schoelace) */
function polygonArea(pts2) {
  let s = 0;
  for (let i = 0; i < pts2.length; i++) {
    const a = pts2[i], b = pts2[(i + 1) % pts2.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return 0.5 * s;
}

/** Punkte einer Fläche, die zur unteren Kante des Bands gehören (sonst alle) */
function facetLoMid(fd, loKeys, vkey) {
  const L = fd.outer || [];
  if (!L.length) return null;
  const lo = [];
  for (const p of L) if (loKeys.has(vkey(p))) lo.push(p);
  return centroidOf(lo.length ? lo : L);
}

// ── Plan eines Bands ────────────────────────────────────────────────────────

/**
 * Plan für EIN Band (Extrusionsband).
 *
 * fds   — die ORIGINALEN Flächen (unveränderte Indizes der Band-Facetten und Deckflächen)
 * band  — das Band aus det.bands (kind 'ext')
 * wr    — (p) → geschriebene Koordinaten [x,y,z] | null
 *
 * → { plan, geoms } | null  (null = Band scheitert)
 */
function buildBand(band, list, wr, vkey, o) {
  const segs = band.segs || [];

  // ── 1. Beide Bögen müssen an eine ebene Deckfläche grenzen ────────────────
  const loSeg = segs.find((s) => s && s.type === 'arc' && s.level === 'lo');
  const hiSeg = segs.find((s) => s && s.type === 'arc' && s.level === 'hi');
  if (!loSeg || !hiSeg) return null;
  if (loSeg.adjType !== 'cap' || hiSeg.adjType !== 'cap') return null;
  if (!loSeg.cap || !hiSeg.cap) return null;
  const loFd = list[loSeg.cap.fi], hiFd = list[hiSeg.cap.fi];
  if (!loFd || !hiFd) return null;
  const loN = norm(loFd.normal || [0, 0, 0]);
  const hiN = norm(hiFd.normal || [0, 0, 0]);
  if (!(len(loN) > 0) || !(len(hiN) > 0)) return null;
  const loC = loFd.centroid || centroidOf(loFd.outer);
  const hiC = hiFd.centroid || centroidOf(hiFd.outer);
  if (!loC || !hiC) return null;

  const P = loSeg.pts || [], H = hiSeg.pts || [];
  if (P.length < 2 || H.length < 2) return null;
  const nP = P.length - 1;

  // ── 2. Endpunkte, Extrusionsrichtung, Seiten- und Ebenen-Prüfung ─────────
  const Alo = wr(P[0]), Blo = wr(P[nP]);
  const Ahi = wr(H[H.length - 1]), Bhi = wr(H[0]);
  if (!Alo || !Blo || !Ahi || !Bhi) return null;

  const dA = sub(Ahi, Alo);          // Seitenkante P[0] → oben
  const dB = sub(Bhi, Blo);          // Seitenkante P[n] → oben
  const v = mul(add(dA, dB), 0.5);   // mittlere Extrusionsrichtung
  const lv = len(v);
  if (!(lv > 1e-12)) return null;
  // Die beiden Seitenkanten müssen parallel und gleich lang sein (halbe Abweichung).
  if (len(sub(dA, v)) > o.sideTol) return null;
  // Die Endpunkte müssen exakt auf ihren Deckebenen liegen.
  if (planeDist(loN, loC, Alo) > o.surfTol) return null;
  if (planeDist(loN, loC, Blo) > o.surfTol) return null;
  if (planeDist(hiN, hiC, Ahi) > o.surfTol) return null;
  if (planeDist(hiN, hiC, Bhi) > o.surfTol) return null;

  // ── 3. Interpolationspunkte der unteren Kante (auf die untere Ebene projiziert) ──
  const Q = [Alo];
  for (let k = 1; k < nP; k++) {
    const q = wr(P[k]);
    if (!q) return null;
    Q.push(projectOnPlane(loN, loC, q));
  }
  Q.push(Blo);
  const spLo = interpolateCubic(Q);
  if (!spLo) return null;

  // ── 4. Obere Kante = untere, um v verschoben (Ränder exakt gesetzt) ────────
  const spHi = translateSpline(spLo, v, Ahi, Bhi);
  if (!spHi) return null;

  // ── 5. Ebenen-Prüfung der Kurven + Abgleich der oberen Innenpunkte ───────
  const loSamples = splineSamples(spLo, o.samples);
  for (const p of loSamples) if (planeDist(loN, loC, p) > o.surfTol) return null;
  const hiSamples = splineSamples(spHi, o.samples);
  for (const p of hiSamples) if (planeDist(hiN, hiC, p) > o.surfTol) return null;

  // Oberer Innenpunkt − v muss auf der unteren Kurve liegen (max. Abweichung hiDev).
  let hiDev = 0;
  for (let k = 1; k + 1 < H.length; k++) {
    const q = wr(H[k]);
    if (!q) return null;
    const target = sub(q, v);
    const u = nearestParam(spLo, target);
    if (u === null) return null;
    const c = evalSpline(spLo, u);
    if (!c) return null;
    const d = len(sub(c, target));
    if (d > hiDev) hiDev = d;
  }
  if (hiDev > 1e-3) return null;

  // ── 6. Geometrien der beiden Bögen ────────────────────────────────────────
  const geoms = new Map();
  geoms.set(loSeg.arcKey, {
    kind: 'spline', key: loSeg.arcKey,
    A: P[0], B: P[nP], Aw: Alo, Bw: Blo, sp: spLo,
  });
  geoms.set(hiSeg.arcKey, {
    kind: 'spline', key: hiSeg.arcKey,
    A: H[H.length - 1], B: H[0], Aw: Ahi, Bw: Bhi, sp: spHi,
  });

  // ── 7. Fläche: lineare Extrusion der unteren Kurve ────────────────────────
  const surf = { kind: 'ext', sp: spLo, dir: norm(v), len: lv };

  // ── 8. sense: die STEP-Normale C'(u) × v gegen die Facetten-Normalen ──────
  const loKeys = new Set(P.map(vkey));
  let sense = 0;
  for (const fi of band.facets || []) {
    const fd = list[fi];
    if (!fd || !fd.normal) return null;
    const nn = norm(fd.normal);
    if (!(len(nn) > 0)) return null;
    const mid = facetLoMid(fd, loKeys, vkey);
    if (!mid) return null;
    const u = nearestParam(spLo, projectOnPlane(loN, loC, mid));
    if (u === null) return null;
    const d = derivSpline(spLo, u);
    if (!d) return null;
    const dp = dot(cross(d, v), nn);
    const s = dp > 1e-12 ? 1 : (dp < -1e-12 ? -1 : 0);
    if (!s) return null;
    if (sense === 0) sense = s; else if (sense !== s) return null;
  }
  if (!sense) return null;
  if (band.sense !== undefined && band.sense !== null && band.sense !== sense) return null;

  // ── 9. Dreiecke der Wand (lo/hi laufen beide A→B, also deckungsgleich) ───
  const K = Math.max(8, 2 * (band.nSegs || 0));
  const Ls = splineSamples(spLo, K);
  const Hs = splineSamples(spHi, K);
  const tris = [];
  for (let k = 0; k < K; k++) {
    tris.push([Ls[k], Ls[k + 1], Hs[k + 1]]);
    tris.push([Ls[k], Hs[k + 1], Hs[k]]);
  }
  // Orientierung: Normale des ersten Dreiecks gegen Σ Facetten-Normalen.
  let ref = [0, 0, 0];
  for (const fi of band.facets || []) {
    const fd = list[fi];
    if (fd && fd.normal) ref = add(ref, fd.normal);
  }
  if (tris.length && len(ref) > 1e-12) {
    const n0 = cross(sub(tris[0][1], tris[0][0]), sub(tris[0][2], tris[0][0]));
    if (dot(n0, ref) < 0) {
      for (const t of tris) { const tmp = t[1]; t[1] = t[2]; t[2] = tmp; }
    }
  }
  let area = 0;
  for (const t of tris) area += 0.5 * len(cross(sub(t[1], t[0]), sub(t[2], t[0])));

  // ── 10. Diagnose: Sehnen-Abweichung (sag) und Volumen-Differenz (dV) ──────
  const devs = spanDeviation(spLo, Q);
  let sag = 0;
  for (const d of devs) if (d > sag) sag = d;
  const { e1, e2 } = planeBasis(loN);
  const to2 = (p) => [dot(p, e1), dot(p, e2)];
  const dV = Math.abs(polygonArea(Ls.map(to2)) - polygonArea(Q.map(to2))) * lv;

  // ── 11. Plan ──────────────────────────────────────────────────────────────
  const plan = {
    id: band.id, band, kind: 'ext',
    surf, sense, segs: band.segs,
    tris, area, sig: band.sig, dV, sag, hiDev,
  };
  return { plan, geoms };
}

/**
 * Pläne für alle Extrusionsbänder aus det.
 *
 * fds     — die ORIGINALEN Flächen (unveränderte Liste)
 * det     — Ergebnis der Band-Erkennung (det.bands; nur kind 'ext' wird genutzt)
 * written — (p) → geschriebene Koordinaten [x,y,z] eines Netzpunkts
 * opts    — { vtxKey (Pflicht), surfTol, sideTol, samples }
 *
 * → { plans, geoms, failed }   failed = Set der gescheiterten band.id
 */
export function buildExtPlans(fds, det, written, opts) {
  const o = { ...EXT_PLAN_DEFAULTS, ...(opts || {}) };
  const vkey = typeof o.vtxKey === 'function' ? o.vtxKey : defaultVtxKey;
  const list = fds || [];
  const wr = (p) => {
    if (!p) return null;
    const w = (typeof written === 'function') ? written(p) : p;
    if (!Array.isArray(w) || w.length < 3) return null;
    for (let i = 0; i < 3; i++) if (!Number.isFinite(w[i])) return null;
    return [w[0], w[1], w[2]];
  };
  const failed = new Set();
  const geoms = new Map();
  const plans = [];
  for (const band of (det && det.bands) || []) {
    if (!band || band.kind !== 'ext') continue;
    let res = null;
    try {
      res = buildBand(band, list, wr, vkey, o);
    } catch (e) {
      res = null;                      // ein Fehler im Band verwirft nur dieses Band
    }
    if (!res) { failed.add(band.id); continue; }
    plans.push(res.plan);
    for (const [k, g] of res.geoms) geoms.set(k, g);
  }
  return { plans, geoms, failed };
}

/**
 * Abtastpunkte einer Band-Geometrie: Spline-Kurve (splineSamples) oder Bogen
 * (arcSamples aus profile-arcs.js).
 * → [[x,y,z], …] mit n+1 Punkten
 */
export function extGeomSamples(geom, n) {
  if (!geom) return [];
  const N = Math.max(1, Math.floor(n) || 1);
  if (geom.kind === 'spline') return splineSamples(geom.sp, N);
  return arcSamples(geom, N);
}

/**
 * Loop mit Kurven-/Bogen-Kanten auf die genauen Kurven-Punkte aufweiten:
 * für jede Kante mit arcEdges-Eintrag werden die inneren Abtastpunkte (n Segmente)
 * in Richtung L[i] → L[i+1] eingefügt.
 * → neue Punktliste (Original unverändert)
 */
export function expandCurveLoop(L, arcEdges, geoms, vtxKey, n = 16) {
  if (!L || !L.length) return [];
  const vkey = typeof vtxKey === 'function' ? vtxKey : defaultVtxKey;
  const N = Math.max(1, Math.floor(n) || 1);
  const out = [];
  const m = L.length;
  for (let i = 0; i < m; i++) {
    out.push(L[i]);
    if (!arcEdges) continue;
    const a = L[i], b = L[(i + 1) % m];
    const key = edgeCanonKey(vkey, a, b);
    const arcKey = arcEdges instanceof Map ? arcEdges.get(key)
      : (typeof arcEdges === 'object' ? arcEdges[key] : null);
    if (!arcKey) continue;
    const g = geoms && typeof geoms.get === 'function' ? geoms.get(arcKey) : null;
    if (!g) continue;
    let pts = extGeomSamples(g, N);
    const ka = vkey(a), kb = vkey(b);
    const gA = vkey(g.A), gB = vkey(g.B);
    if (ka === gB && kb === gA) pts = pts.slice().reverse();
    for (let k = 1; k < N; k++) out.push(pts[k]);
  }
  return out;
}

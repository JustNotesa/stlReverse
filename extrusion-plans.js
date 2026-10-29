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

import { arcSamples, edgeCanonKey } from './profile-arcs.js?v=5';
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

// ── Wächter an scharfen Eckpunkten (Cap-Fläche ↔ Extrusion) ────────────────
// Endet die Bandkurve in einer scharfen Ecke der Deckfläche, kann die Endtangente der
// interpolierten Spline so weit von der Endsehne abweichen, dass die Kurve über die
// Nachbarkante der Deckfläche kippt. OCCT meldet dann eine Selbstschneidung zwischen
// der Cap-EBENE und der SURFACE_OF_LINEAR_EXTRUSION.

/** 2D-Differenz */
const sub2 = (a, b) => [a[0] - b[0], a[1] - b[1]];
/** 2D-Kreuzprodukt (a × b)·z */
const cross2 = (a, b) => a[0] * b[1] - a[1] * b[0];
/** Winkel (rad, unsigned, [0, π]) zwischen zwei 2D-Vektoren */
function angle2(a, b) {
  const la = Math.hypot(a[0], a[1]);
  const lb = Math.hypot(b[0], b[1]);
  if (!(la > 0) || !(lb > 0)) return 0;
  const c = (a[0] * b[0] + a[1] * b[1]) / (la * lb);
  return Math.acos(Math.min(1, Math.max(-1, c)));
}
/** Loop einer Fläche: li = 0 → außen, li = k → inner[k−1] */
function loopOf(fd, li) {
  if (!fd) return null;
  if (!li) return fd.outer || null;
  return (fd.inner || [])[li - 1] || null;
}

/**
 * Prüft einen Endpunkt eines Bandes an einer scharfen Ecke der Deckfläche.
 *
 * In der Deckebene projiziert (alles 2D):
 *   c = Endsehne (Vektor vom Eckpunkt in die Kurve), e = Nachbarkante (Vektor vom
 *   Eckpunkt zum Nachbarpunkt der Deckfläche), t = Endtangente (in die Kurve zeigend).
 *   phi = Winkel(c, e), tau = Winkel(t, c).
 *
 * Gefordert wird:
 *   (a) tau ≤ phi/2 — die Tangente darf höchstens halb so weit von der Endsehne
 *       abweichen wie die Nachbarkante,
 *   (b) t liegt auf derselben Seite der Geraden durch e wie c,
 *   (c) kein Abtastpunkt der Kurve (ohne die beiden Endpunkte) liegt auf der anderen
 *       Seite der Geraden durch e oder dicht (< 1e-6 mm) auf ihr.
 *
 * → null (in Ordnung) | String (Grund für das Scheitern des Bandes)
 */
function guardCorner(corner2, c2, e2, t2, samples2) {
  const lc = Math.hypot(c2[0], c2[1]);
  const le = Math.hypot(e2[0], e2[1]);
  if (!(lc > 1e-9) || !(le > 1e-9)) return null;             // entartet → überspringen
  const sC = cross2(e2, c2);
  if (Math.abs(sC) <= 1e-12 * le * lc) return null;          // c liegt auf der Geraden → nichts zu prüfen
  const deg = (r) => (r * 180 / Math.PI).toFixed(1);
  const phi = angle2(c2, e2);
  const tau = angle2(t2, c2);
  // (a) tau ≤ phi/2 war zu streng (NozzleBox: 19 von 82 Schrift-Bändern fielen weg, ohne dass
  // die Kurve die Nachbarkante kreuzte) — nur noch Diagnose; entscheidend sind (b) und (c).
  void tau; void deg;
  // (b) nur, wenn die Tangente auf der Seite des STRAHLS e liegt (dot > 0) — kreuzt sie nur die
  // rückwärtige Verlängerung (glatter Übergang ins Nachbarstück, phi ≈ 180°), ist das harmlos
  if (cross2(e2, t2) * sC < 0 && t2[0] * e2[0] + t2[1] * e2[1] > 0) return 'Endtangente kreuzt die Nachbarkante der Deckfläche';
  for (const s of samples2) {
    const d = sub2(s, corner2);
    if (Math.hypot(d[0], d[1]) > le) continue;                // nur in der Nähe der Ecke
    if (d[0] * e2[0] + d[1] * e2[1] <= 0) continue;          // nur auf der Seite des Strahls e
    const sd = cross2(e2, d);
    if (Math.abs(sd) / le <= 1e-6) return 'Kurve berührt die Nachbarkante der Deckfläche (< 1e-6 mm)';
    if (sd * sC < 0) return 'Kurve kreuzt die Nachbarkante der Deckfläche';
  }
  return null;
}

// ── Plan eines Bands ────────────────────────────────────────────────────────

/**
 * Plan für EIN Band (Extrusionsband).
 *
 * fds   — die ORIGINALEN Flächen (unveränderte Indizes der Band-Facetten und Deckflächen)
 * band  — das Band aus det.bands (kind 'ext')
 * wr    — (p) → geschriebene Koordinaten [x,y,z] | null
 * ctx   — { reason } — wird bei einem Verstoß am scharfen Eckpunkt gefüllt
 *
 * → { plan, geoms } | null  (null = Band scheitert)
 */
function buildBand(band, list, wr, vkey, o, ctx) {
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

  // ── 5b. Wächter an den scharfen Eckpunkten (Cap-Fläche ↔ Extrusion) ───────
  // Endet die Bandkurve in einer scharfen Ecke der Deckfläche, darf die Endtangente
  // der Spline nicht so stark von der Endsehne abweichen, dass die Kurve über die
  // Nachbarkante der Deckfläche kippt — OCCT meldet dann eine Selbstschneidung
  // zwischen der Cap-EBENE und der SURFACE_OF_LINEAR_EXTRUSION.
  const bLo = planeBasis(loN);
  const bHi = planeBasis(hiN);
  const to2Lo = (p) => [dot(p, bLo.e1), dot(p, bLo.e2)];
  const to2Hi = (p) => [dot(p, bHi.e1), dot(p, bHi.e2)];
  const uA = spLo.U[spLo.degree];                    // u am Anfang der unteren Kurve
  const uB = spLo.U[spLo.U.length - spLo.degree - 1];  // u am Ende der unteren Kurve
  const tanA = derivSpline(spLo, uA);                 // Endtangente vorn: zeigt IN die Kurve
  const tanB = derivSpline(spLo, uB);                 // Endtangente hinten: zeigt AUS der Kurve
  if (!tanA || !tanB) return null;
  const KS = Math.max(16, 4 * (band.nSegs || 0));
  const midLo = splineSamples(spLo, KS).slice(1, -1).map(to2Lo);   // ohne die beiden Endpunkte
  const midHi = splineSamples(spHi, KS).slice(1, -1).map(to2Hi);
  const keysLo = new Set(P.map(vkey));
  const keysHi = new Set(H.map(vkey));

  /**
   * Ein Band-Ende gegen die Nachbarkante der Deckfläche prüfen.
   * → null (in Ordnung) | String (Grund)
   */
  const guardEnd = (tag, loop, cOrig, cW, nOrig, to2, tan3, samples, keys) => {
    if (!loop || !loop.length) return null;
    const ck = vkey(cOrig);
    let i = -1;
    for (let k = 0; k < loop.length; k++) if (vkey(loop[k]) === ck) { i = k; break; }
    if (i < 0) return null;                             // Ecke nicht im Loop → überspringen
    const m = loop.length;
    const prev = loop[(i - 1 + m) % m];
    const next = loop[(i + 1) % m];
    const kc = vkey(nOrig);
    let nbr = null;                                     // der Nachbar auf der Kurven-Seite …
    if (vkey(prev) === kc) nbr = next;                  // … ist bekannt, der andere ist die
    else if (vkey(next) === kc) nbr = prev;             // Nachbarkante
    else return null;                                   // Kurven-Seite unklar → überspringen
    if (keys.has(vkey(nbr))) return null;               // entartet → überspringen
    const cW2 = wr(nOrig);
    if (!cW2) return null;
    const nbrW = wr(nbr) || nbr;
    const c2 = sub2(to2(cW2), to2(cW));                 // Endsehne
    const e2 = sub2(to2(nbrW), to2(cW));                // Nachbarkante
    const why = guardCorner(to2(cW), c2, e2, to2(tan3), samples);
    return why ? `Ecke ${tag}: ${why}` : null;
  };

  for (const end of [
    ['unten vorn', loopOf(loFd, loSeg.cap.li), P[0], Alo, P[1], to2Lo, tanA, midLo, keysLo],
    ['unten hinten', loopOf(loFd, loSeg.cap.li), P[nP], Blo, P[nP - 1], to2Lo, mul(tanB, -1), midLo, keysLo],
    ['oben vorn', loopOf(hiFd, hiSeg.cap.li), H[H.length - 1], Ahi, H[H.length - 2], to2Hi, tanA, midHi, keysHi],
    ['oben hinten', loopOf(hiFd, hiSeg.cap.li), H[0], Bhi, H[1], to2Hi, mul(tanB, -1), midHi, keysHi],
  ]) {
    const why = guardEnd(end[0], end[1], end[2], end[3], end[4], end[5], end[6], end[7], end[8]);
    if (why) { if (ctx) ctx.reason = why; return null; }
  }

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
  const { e1, e2 } = bLo;
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
 * → { plans, geoms, failed, reasons }
 *   failed  = Set der gescheiterten band.id
 *   reasons = Map band.id → Grund des Scheiterns (soweit bekannt)
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
  const reasons = new Map();
  const geoms = new Map();
  const plans = [];
  for (const band of (det && det.bands) || []) {
    if (!band || band.kind !== 'ext') continue;
    let res = null;
    const ctx = { reason: null };
    try {
      res = buildBand(band, list, wr, vkey, o, ctx);
    } catch (e) {
      res = null;                      // ein Fehler im Band verwirft nur dieses Band
    }
    if (!res) {
      failed.add(band.id);
      if (ctx.reason) reasons.set(band.id, ctx.reason);
      continue;
    }
    plans.push(res.plan);
    for (const [k, g] of res.geoms) geoms.set(k, g);
  }
  return { plans, geoms, failed, reasons };
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

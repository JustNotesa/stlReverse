// ─────────────────────────────────────────────────────────────────────────────
// extrusion-bands.js — EXTRUSIONSBÄNDER: Schriftzüge als SURFACE_OF_LINEAR_EXTRUSION.
//
// ENTWURF
// Ein erhabener oder vertiefter Schriftzug kommt aus dem Netz als Streifen schmaler ebener
// Facetten („Wand-Facetten“) zwischen zwei parallelen Ebenen (t_lo/t_hi entlang der Achse d);
// die Seitenkanten lo↔hi laufen parallel zu d. Die Kontur in der Draufsicht ist eine glatte
// Kurve (Schrift-Bezier) mit scharfen Ecken zwischen den Stücken.
//
// Bisher (profile-arcs.js) werden nur Stücke, die auf EINEN Kreis passen, zu echten
// Teil-Zylindern/-Kegeln. An Schriftkurven liefert das viele winzige Zylinder-Bänder
// (im Mittel 3,7 Facetten je Band) und lässt den Rest facettiert.
//
// Dieses Modul findet die „Extrusionsbänder“ (kind 'ext'): maximale glatte Läufe von
// Wand-Facetten, die KEIN einziger Kreisbogen sind. Später (extrusion-plans.js,
// exporters.js) wird jedes Band als EINE SURFACE_OF_LINEAR_EXTRUSION über einer kubischen
// B-Spline geschrieben, die die Netzpunkte EXAKT interpoliert: Rand = Unterkurve –
// Seiten-LINIE – Oberkurve – Seiten-LINIE; in den beiden Nachbarflächen (Deckflächen) wird
// der Polygonzug durch dieselbe B-Spline-Kante ersetzt.
//
// Datenmodell = Datenmodell von profile-arcs.js (Band, segs, levels, sense, sig, arcs),
// damit validateArcBands/applyArcBands unverändert auf der gemischten Liste
// (Bogen-Bänder + Extrusions-Bänder) arbeiten:
//   Band = { id: 'e<k>', kind: 'ext', d, frame, facets, segs, levels, sense, sig, nSegs }
//   segs = genau 4 Randstücke: { type:'arc', level:'lo'|'hi', pts, arcKey } und { type:'line', pts }
//   arcKey = 'x|' + kanonischer Schlüssel (wie profile-arcs) — das 'x|' hält sie von den
//            Kreis-Bögen getrennt.
// ─────────────────────────────────────────────────────────────────────────────

import {
  makeFrame, toLocal, axisCandidates, fitCircle2d, buildEdgeIndex, buildChains,
  edgeCanonKey,
} from './profile-arcs.js';
import { interpolateCubic, spanDeviation, nearestParam, evalSpline } from './spline-fit.js?v=1';

/** Vorgaben der Extrusionsband-Suche. */
export const EXT_DEFAULTS = {
  levelTol: 2e-3,      // mm: Punkte einer Höhe (entlang d)
  cornerDeg: 20,       // Grad: Knick, ab dem eine Kette endet (Ecke)
  minFacets: 3,        // Mindestzahl Facetten je Band
  maxFacets: 400,      // Höchstzahl Facetten je Band
  maxFacetPts: 6,      // Facetten mit mehr Ecken sind keine Band-Facetten
  capCos: 0.99999,     // |n·d| ≥ capCos: Fläche steht senkrecht zur Achse (Deckfläche)
  widthRatio: 4,       // Faktor: eine Facette ist „gerade“, wenn sie das 4-fache der Nachbarn misst
  devAbs: 2e-3,        // mm: Mindest-Abweichung der Spline vom Polygonzug
  devRel: 0.5,         // × (Segmentlänge × Knickwinkel): erlaubte Abweichung
  devMax: 0.05,        // mm: höchste erlaubte Abweichung
  hiTol: 1e-3,         // mm: Hi-Punkt muss auf der Lo-Spline liegen
  sideTol: 1e-4,       // mm: Seitenkante muss senkrecht zur Achse stehen
  circleTolAbs: 5e-3,  // mm: Netzpunkt ↔ Kreis
  circleTolRel: 2e-3,  // × r
  maxArcPieces: 2,     // so viele Kreisstücke darf ein Stück haben, um im Bogen-Pfad zu bleiben
  arcMinSegs: 3,       // Mindestzahl Segmente je Kreisstück
  arcAvgSegs: 8,       // Ø Segmente je Kreisstück — hat ein Stück MEHR Kreisstücke als
                       // maxArcPieces, bleibt es nur beim Bogen-Pfad (profile-arcs), wenn der
                       // Schnitt im Mittel gut genug ist: der Lauf „Rundung r0.5 → Bogen R10 →
                       // Rundung r0.5“ (Kreisstücke 16/17/9 Segmente, Ø 14) bleibt bei den
                       // Zylindern; Schriftkurven (viele kurze Stücke, Ø < 4) → Extrusions-Pfad.
  budgetMs: 2500,      // ms: Zeitbudget (Kettenverarbeitung stoppen)
  maxAxes: 6,          // Höchstzahl Achsen-Kandidaten je Lauf
  blocked: null,       // Set von Signaturen (Ecken-Schlüssel), die gesperrt sind
  blockedGroups: null, // Set von fd.group, deren Facetten nicht benutzt werden dürfen
};

// Zeitmessung (Budget) — performance.now() mit Fallback auf Date.now()
const nowMs = () => (typeof performance !== 'undefined' && performance &&
  typeof performance.now === 'function') ? performance.now() : Date.now();

// ── Vektor-Helfer ───────────────────────────────────────────────────────────
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a); return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0]; };

// ── Vertex-Schlüssel ────────────────────────────────────────────────────────
// vtxKey ist Pflicht-Option; der Ersatz ist nur eine Notfallklammer (identisch zum
// Test-Key: vier Nachkommastellen, -0 → 0).
const vtxKeyOf = (o) => (typeof o.vtxKey === 'function')
  ? o.vtxKey
  : (p) => (p || []).map((x) => (+x.toFixed(4) || 0).toFixed(4)).join(',');

// kanonischer Bogen-Schlüssel: Endpunkte (sortiert) + kleinster innerer Punkt
// (identisch zu arcKeyOf in profile-arcs.js) — das 'x|' hält Splines von Bögen getrennt.
function arcKeyOf(pts, vkey) {
  const ka = vkey(pts[0]), kb = vkey(pts[pts.length - 1]);
  const parts = ka < kb ? [ka, kb] : [kb, ka];
  let inner = '';
  for (let i = 1; i + 1 < pts.length; i++) {
    const k = vkey(pts[i]);
    if (!inner || k < inner) inner = k;
  }
  if (inner) parts.push(inner);
  return parts.join('|');
}

// ── Läufe einer Band-Facette ────────────────────────────────────────────────
/**
 * Lo-/Hi-Lauf einer Wand-Facette: der Loop besteht aus genau zwei zusammenhängenden
 * Punktfolgen (getrennt durch die beiden Seitenkanten lo↔hi).
 * → { loRun, hiRun } | null
 */
function facetRuns(fd, info, vkey) {
  const L = fd.outer;
  const n = L.length;
  const cls = new Array(n);
  for (let i = 0; i < n; i++) cls[i] = info.level.get(vkey(L[i])) || 'lo';
  let start = -1;
  for (let i = 0; i < n; i++) {
    if (cls[i] === 'hi' && cls[(i + 1) % n] === 'lo') { start = (i + 1) % n; break; }
  }
  if (start < 0) return null;
  const loRun = [], hiRun = [];
  let k = start;
  while (cls[k] === 'lo') { loRun.push(L[k]); k = (k + 1) % n; }
  while (cls[k] === 'hi') { hiRun.push(L[k]); k = (k + 1) % n; }
  if (k !== start) return null;
  return { loRun, hiRun };
}

/** Lauf so umkehren, dass er bei startKey beginnt und bei endKey endet (sonst null). */
function orientRun(run, startKey, endKey, vkey) {
  if (!run || !run.length) return null;
  if (run.length === 1) return vkey(run[0]) === startKey ? run : null;
  const k0 = vkey(run[0]), k1 = vkey(run[run.length - 1]);
  if (k0 === startKey && k1 === endKey) return run;
  if (k1 === startKey && k0 === endKey) return run.slice().reverse();
  return null;
}

/**
 * Richtung des Lo-Laufs einer Facette in LOOP-Reihenfolge (nicht in Kettenrichtung).
 * → Vektor (letzter − erster) | null
 */
function loopLoDir(fd, info, vkey) {
  const L = fd.outer;
  const n = L.length;
  const cls = new Array(n);
  for (let i = 0; i < n; i++) cls[i] = info.level.get(vkey(L[i])) || 'lo';
  let s = -1;
  for (let i = 0; i < n; i++) {
    if (cls[i] === 'lo' && cls[(i - 1 + n) % n] !== 'lo') { s = i; break; }
  }
  if (s < 0) return null;
  const run = [];
  let k = s;
  while (cls[k] === 'lo' && run.length < n) { run.push(L[k]); k = (k + 1) % n; }
  if (run.length < 2) return null;
  return sub(run[run.length - 1], run[0]);
}

// ── Bänder ───────────────────────────────────────────────────────────────────

/**
 * Band aus einer Folge von Wand-Facetten bauen (Kopie der Rand-Logik von makeBand in
 * profile-arcs.js, ohne Kreis-Geometrie):
 *   1. gerichtete Kanten der äußeren Loops sammeln, Gegenrichtungen streichen,
 *   2. Rest zu GENAU EINEM geschlossenen Loop verketten,
 *   3. Punkte je Ebene (lo/hi) zuordnen, genau ein hi→lo-Übergang,
 *   4. Rand = 4 Stücke: Bogen lo, Seite, Bogen hi, Seite.
 * Die Seitenkanten müssen senkrecht zur Achse stehen (sideTol), alle Facetten müssen
 * dieselbe Orientierung (sense) haben.
 * → Band | null
 */
function makeExtBand(ctx, facets) {
  const { fds, frame, o, vkey, facInfo } = ctx;

  // gerichtete Kanten (a→b) aller outer-Loops sammeln
  const dir = new Map();
  for (const fi of facets) {
    const L = fds[fi].outer;
    for (let k = 0; k < L.length; k++) {
      const a = L[k], b = L[(k + 1) % L.length];
      const ka = vkey(a), kb = vkey(b);
      if (ka === kb) continue;
      const key = ka + '>' + kb;
      if (!dir.has(key)) dir.set(key, { a, b, ka, kb });
    }
  }
  // innere Kanten (Gegenrichtung vorhanden) streichen
  const edges = [];
  for (const e of dir.values()) if (!dir.has(e.kb + '>' + e.ka)) edges.push(e);
  if (!edges.length) return null;

  // Rest zu GENAU EINEM geschlossenen Loop verketten
  const byStart = new Map();
  for (const e of edges) { if (byStart.has(e.ka)) return null; byStart.set(e.ka, e); }
  const loop = [];
  const firstKa = edges[0].ka;
  let e = edges[0], closed = false;
  for (let step = 0; step < edges.length; step++) {
    loop.push(e.a);
    const nx = byStart.get(e.kb);
    if (!nx) return null;                       // nicht geschlossen
    if (nx.ka === firstKa) { closed = true; break; }
    e = nx;
  }
  if (!closed || loop.length !== edges.length) return null;   // offen oder mehrere Loops

  // Höhen der Punkte → zwei Ebenen (lo = tief, hi = hoch)
  const n = loop.length;
  let tlo = Infinity, thi = -Infinity;
  for (let k = 0; k < n; k++) {
    const t = toLocal(frame, loop[k])[2];
    if (t < tlo) tlo = t;
    if (t > thi) thi = t;
  }
  const cls = new Array(n);
  for (let k = 0; k < n; k++) {
    const t = toLocal(frame, loop[k])[2];
    if (Math.abs(t - tlo) <= o.levelTol) cls[k] = 'lo';
    else if (Math.abs(t - thi) <= o.levelTol) cls[k] = 'hi';
    else return null;
  }
  // genau ein Übergang hi→lo → Loop dort beginnen (erster Punkt des lo-Laufs)
  let cut = -1, nTrans = 0;
  for (let k = 0; k < n; k++) {
    if (cls[k] === 'hi' && cls[(k + 1) % n] === 'lo') { cut = (k + 1) % n; nTrans++; }
  }
  if (nTrans !== 1) return null;
  const pts = loop.slice(cut).concat(loop.slice(0, cut));
  const c2 = cls.slice(cut).concat(cls.slice(0, cut));
  let nLo = 0; while (nLo < n && c2[nLo] === 'lo') nLo++;
  let nHi = 0; while (nLo + nHi < n && c2[nLo + nHi] === 'hi') nHi++;
  if (nLo < 2 || nHi < 2 || nLo + nHi !== n) return null;    // nicht genau 4 Läufe

  // 4 Rand-Stücke: Bogen lo, Seite, Bogen hi, Seite
  const segs = [
    { type: 'arc', level: 'lo', pts: pts.slice(0, nLo) },
    { type: 'line', pts: [pts[nLo - 1], pts[nLo]] },
    { type: 'arc', level: 'hi', pts: pts.slice(nLo, nLo + nHi) },
    { type: 'line', pts: [pts[nLo + nHi - 1], pts[0]] },
  ];
  // Die beiden Seitenkanten müssen senkrecht zur Achse stehen (sonst kein Extrusions-Band)
  for (const s of [segs[1], segs[3]]) {
    const a = toLocal(frame, s.pts[0]), b = toLocal(frame, s.pts[1]);
    if (!(Math.hypot(b[0] - a[0], b[1] - a[1]) <= o.sideTol)) return null;
  }
  const levels = {
    lo: { t: tlo, pts: segs[0].pts },
    hi: { t: thi, pts: segs[2].pts },
  };

  // sense: alle Facetten müssen dieselbe Orientierung haben
  const V = mul(frame.d, Math.sign(thi - tlo) || 1);
  let sense = 0;
  for (const fi of facets) {
    const fd = fds[fi];
    const nn = fd.normal ? norm(fd.normal) : null;
    if (!nn || !(len(nn) > 0)) return null;
    const T0 = loopLoDir(fd, facInfo.get(fi), vkey);
    if (!T0) return null;
    const T = norm(T0);
    if (!(len(T) > 0)) return null;
    const s = dot(cross(T, V), nn);
    const sg = s > 1e-9 ? 1 : (s < -1e-9 ? -1 : 0);
    if (!sg) return null;
    if (sense === 0) sense = sg; else if (sense !== sg) return null;
  }
  if (!sense) return null;

  // Signatur: die 4 Eckpunkte (Enden der beiden Bogen-Läufe)
  const sig = [pts[0], pts[nLo - 1], pts[nLo], pts[nLo + nHi - 1]].map(vkey).sort().join(';');
  if (o.blocked && typeof o.blocked.has === 'function' && o.blocked.has(sig)) return null;

  // Bogen-Schlüssel (mit 'x|' — Spline, kein Kreis)
  for (const s of segs) if (s.type === 'arc') s.arcKey = 'x|' + arcKeyOf(s.pts, vkey);

  return {
    kind: 'ext', d: frame.d, frame, facets: facets.slice(),
    segs, levels, sense, sig, nSegs: facets.length,
  };
}

// ── Kreis-Test ──────────────────────────────────────────────────────────────

/**
 * Greedy-Kreis-Abdeckung eines offenen 2D-Polygonzugs: von i aus wird j so weit
 * verlängert, bis die Punkte i…j auf EINEN Kreis passen (Toleranz max(abs, rel·r)).
 * → [{ i, j }, …]  (j = Index des letzten Punktes des Kreisstücks)
 */
function circleCover(pts2d, o) {
  const out = [];
  let i = 0;
  while (i < pts2d.length) {
    let best = -1;
    let j = Math.min(pts2d.length - 1, i + 2);         // mindestens 3 Punkte
    while (j < pts2d.length) {
      const K = fitCircle2d(pts2d.slice(i, j + 1));
      if (!K) break;
      const tol = Math.max(o.circleTolAbs, o.circleTolRel * K.r);
      if (K.maxRes > tol) break;
      best = j;
      j++;
    }
    if (best < 0) { out.push({ i, j: i }); i = i + 1; continue; }
    out.push({ i, j: best });
    i = best + 1;
  }
  return out;
}

// ── Abweichungs-Split ───────────────────────────────────────────────────────

/**
 * Knickwinkel an den Polygonzug-Ecken (rad). Die End-Ecken bekommen den Winkel ihres
 * EINZIGEN inneren Nachbarn (die Ecken außerhalb des Teils zählen nicht).
 * → Float64Array je Vertex
 */
function turningAngles(pts) {
  const n = pts.length;
  const at = new Float64Array(n);
  for (let i = 1; i + 1 < n; i++) {
    const ax = pts[i][0] - pts[i - 1][0], ay = pts[i][1] - pts[i - 1][1];
    const bx = pts[i + 1][0] - pts[i][0], by = pts[i + 1][1] - pts[i][1];
    const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
    if (!(la > 0) || !(lb > 0)) continue;
    let c = (ax * bx + ay * by) / (la * lb);
    if (c > 1) c = 1; else if (c < -1) c = -1;
    at[i] = Math.acos(c);
  }
  const end = Float64Array.from(at);
  if (n >= 3) { end[0] = at[1]; end[n - 1] = at[n - 2]; }
  return end;
}

// ── Haupt-API ───────────────────────────────────────────────────────────────

/**
 * Extrusionsbänder suchen.
 *
 * fds:  Array ebener Flächen { outer, inner, normal, centroid }
 * opts: { ...EXT_DEFAULTS, vtxKey (Pflicht), blocked (Set von Signaturen),
 *         blockedGroups (Set von fd.group),
 *         arcDet (VALIDIERTES profile-arcs-Ergebnis: { bands }) }
 * → { bands, arcs, claimed, stats }
 */
export function findExtBands(fds, opts) {
  const o = { ...EXT_DEFAULTS, ...opts };
  const vkey = vtxKeyOf(o);
  const list = fds || [];
  const index = buildEdgeIndex(list, { ...o, vtxKey: vkey, skipCircleRim: true });
  const maxAxes = Number.isFinite(o.maxAxes) ? Math.max(0, o.maxAxes) : Infinity;
  const axes = axisCandidates(list, o).slice(0, maxAxes);

  const bands = [];
  const claimed = new Set();
  const taken = new Set();
  const stats = {
    axes: axes.length, chains: 0, pieces: 0, circleSkipped: 0, straightFacets: 0,
    devSplits: 0, bands: 0, facets: 0, budgetHit: false,
    collisionSplits: 0, collisionDrops: 0,
  };
  const t0 = nowMs();
  const budgetMs = typeof o.budgetMs === 'number' ? o.budgetMs : Infinity;
  const overBudget = () => (nowMs() - t0) >= budgetMs;
  let idc = 0;
  const nextId = () => 'e' + (idc++);
  const ctxOf = new Map();                 // Band-Id → Kontext (für den Neu-Aufbau beim Split)

  for (const d of axes) {
    if (overBudget()) { stats.budgetHit = true; break; }
    const frame = makeFrame(d);
    const { facets: facInfo, chains } = buildChains(list, d, frame, index, taken, {
      ...o, vtxKey: vkey, maxSegDeg: o.cornerDeg, maxFacetPts: o.maxFacetPts,
      capCos: o.capCos, levelTol: o.levelTol,
    });
    stats.chains += chains.length;
    const ctx = { fds: list, frame, o, vkey, facInfo, index };
    for (const chain of chains) {
      if (overBudget()) { stats.budgetHit = true; break; }
      processChain(ctx, chain, { bands, claimed, taken, stats, over: overBudget, ctxOf }, nextId);
    }
    if (overBudget()) break;
  }

  // Kollisionen auflösen: zwei Kurven dürfen NICHT dasselbe Endpunkt-Paar haben
  // (in fd.arcEdges der Deckfläche würde die zweite die erste überschreiben)
  resolveCurveCollisions(bands, ctxOf, o, claimed, taken, stats, nextId);
  stats.bands = bands.length;
  stats.facets = bands.reduce((s, b) => s + (b.facets || []).length, 0);

  // Bögen (Kanten der Bänder) — wie am Ende von alignBands, mit kind 'spline'
  const arcs = new Map();
  for (const band of bands) {
    const segs = band.segs || [];
    segs.forEach((seg, si) => {
      if (seg.type !== 'arc') return;
      const key = seg.arcKey;
      let rec = arcs.get(key);
      if (!rec) {
        rec = {
          key, pts: seg.pts, d: band.d, frame: band.frame,
          level: band.levels[seg.level], owners: [], kind: 'spline',
        };
        arcs.set(key, rec);
      }
      rec.owners.push({ band: band.id, seg: si });
    });
  }
  return { bands, arcs, claimed, stats };
}

/**
 * Kette bearbeiten: Läufe und Breiten je Facette, „gerade“-Facetten (Breaks), Stücke,
 * Kreis-Test, dann Extrusionsbänder.
 */
function processChain(ctx, chain, state, nextId) {
  const { fds, frame, o, vkey, facInfo } = ctx;
  const m = chain.facets.length;
  if (m < o.minFacets) return;

  // ── Läufe (lo/hi) und Breiten je Facette ──────────────────────────────────
  const runs = new Array(m);
  const widths = new Float64Array(m);
  for (let k = 0; k < m; k++) {
    const fi = chain.facets[k];
    const info = facInfo.get(fi);
    if (!info) return;
    const r = facetRuns(fds[fi], info, vkey);
    if (!r) return;
    const sA = chain.sides[k], sB = chain.sides[k + 1];
    if (!sA || !sB) return;
    const loRun = orientRun(r.loRun, vkey(sA[0]), vkey(sB[0]), vkey);
    const hiRun = orientRun(r.hiRun, vkey(sA[1]), vkey(sB[1]), vkey);
    if (!loRun || !hiRun) return;
    runs[k] = { loRun, hiRun };
    const a = toLocal(frame, sA[0]), b = toLocal(frame, sB[0]);
    widths[k] = Math.hypot(b[0] - a[0], b[1] - a[1]);
  }

  // ── „gerade“-Facetten (Breaks) ────────────────────────────────────────────
  const isBreak = new Array(m).fill(false);
  for (let k = 0; k < m; k++) {
    const fd = fds[chain.facets[k]];
    if (o.blockedGroups && o.blockedGroups.size && fd && fd.group &&
        o.blockedGroups.has(fd.group)) { isBreak[k] = true; continue; }
    const nb = [];
    for (const off of [-2, -1, 1, 2]) {
      let idx = k + off;
      if (chain.cyclic) idx = ((idx % m) + m) % m;
      if (idx < 0 || idx >= m) continue;
      nb.push(widths[idx]);
    }
    if (!nb.length) continue;
    nb.sort((a, b) => a - b);
    const med = nb.length % 2
      ? nb[(nb.length - 1) / 2]
      : (nb[nb.length / 2 - 1] + nb[nb.length / 2]) / 2;
    if (widths[k] >= o.widthRatio * med) {
      isBreak[k] = true;
      state.stats.straightFacets++;
    }
  }

  // ── Stücke (maximale Läufe ohne Break) ────────────────────────────────────
  const pieces = [];
  if (chain.cyclic && !isBreak.some(Boolean)) {
    pieces.push({ cyclic: true, idx: Array.from({ length: m }, (_, i) => i) });
  } else {
    // zyklisch: beim ersten Break beginnen (das Stück läuft dann ggf. über den Ketten-Anfang)
    const start = chain.cyclic ? (isBreak.findIndex(Boolean) + 1) % m : 0;
    let cur = [];
    for (let i = 0; i < m; i++) {
      const k = chain.cyclic ? (start + i) % m : i;
      if (isBreak[k]) {
        if (cur.length) pieces.push({ cyclic: false, idx: cur });
        cur = [];
      } else cur.push(k);
    }
    if (cur.length) pieces.push({ cyclic: false, idx: cur });
  }

  // ── je Stück: Kreis-Test, dann Extrusionsband ─────────────────────────────
  for (const piece of pieces) {
    if (state.over()) { state.stats.budgetHit = true; break; }
    state.stats.pieces++;
    const lo = loPolyline(ctx, runs, piece.idx, piece.cyclic);
    if (lo.pts.length < 3) continue;
    const lo2d = lo.pts.map((p) => { const l = toLocal(frame, p); return [l[0], l[1]]; });
    // Bogen-Bänder von profile-arcs (opts.arcDet): das TATSÄCHLICHE Bogen-Ergebnis
    // entscheidet, ob ein Stück beim Bogen-Pfad bleibt. Die geometrische Kreis-Schätzung
    // ist nur der Notfall (ohne arcDet) — sie rät nur, was profile-arcs tun wird.
    const arcBands = (o.arcDet && Array.isArray(o.arcDet.bands)) ? o.arcDet.bands : null;
    // Ein Stück, das geometrisch EINEN Kreis ergibt, ist NIE ein Extrusionsband — auch
    // dann nicht, wenn arcDet es nicht abdeckt (profile-arcs' Gates verwerfen echte
    // Ringe): sonst würden die Ringe zu Splines (falsche Geometrie).
    let cover = null;
    if (piece.cyclic) {
      const K = fitCircle2d(lo2d);
      if (K && K.maxRes <= Math.max(o.circleTolAbs, o.circleTolRel * K.r)) {
        state.stats.circleSkipped++;
        continue;
      }
    } else {
      cover = circleCover(lo2d, o);
      // genau EIN Kreisstück über den GANZEN Lauf → der Lauf ist ein Kreis
      if (cover.length === 1 && cover[0].i === 0 && cover[0].j === lo2d.length - 1) {
        state.stats.circleSkipped++;
        continue;
      }
    }
    if (arcBands) {
      const F = new Set(piece.idx.map((k) => chain.facets[k]));
      const touched = new Set();
      let touching = 0;
      for (const ab of arcBands) {
        let hit = false;
        for (const fi of (ab.facets || [])) {
          if (!F.has(fi)) continue;
          hit = true;
          touched.add(fi);
        }
        if (hit) touching++;
      }
      const covered = touched.size;
      const avgMin = (typeof o.arcAvgSegs === 'number') ? o.arcAvgSegs : EXT_DEFAULTS.arcAvgSegs;
      // Das Stück bleibt beim Bogen-Pfad, wenn ALLE Facetten in Bogen-Bändern liegen und
      // entweder nur wenige Bänder betroffen sind oder der Schnitt im Mittel gut genug ist.
      const staysArc = covered === F.size && touching > 0 &&
        (touching <= o.maxArcPieces || covered / touching >= avgMin);
      if (staysArc) { state.stats.circleSkipped++; continue; }
    } else if (!piece.cyclic) {
      // Greedy-Kreis-Abdeckung: die Kreisstücke mit ihren Segmentzahlen
      const segsPer = cover.map((c) => c.j - c.i);
      const avgSegs = segsPer.length
        ? segsPer.reduce((a, b) => a + b, 0) / segsPer.length
        : 0;
      const avgMin = (typeof o.arcAvgSegs === 'number') ? o.arcAvgSegs : EXT_DEFAULTS.arcAvgSegs;
      // Das Stück bleibt beim Bogen-Pfad (profile-arcs), wenn ALLE Kreisstücke lang
      // genug sind UND entweder wenige Stücke vorliegen ODER der Schnitt im Mittel
      // gut genug ist (Schriftkurven: viele kurze Stücke → Ø klein → Extrusions-Pfad).
      const staysArc = segsPer.every((s) => s >= o.arcMinSegs) &&
        (cover.length <= o.maxArcPieces || avgSegs >= avgMin);
      if (staysArc) { state.stats.circleSkipped++; continue; }
    }

    // ── Teile: zyklisches Stück → 3 Teile (sonst kollidieren zwei Bogen-Kanten
    //    in der Deckfläche), offenes Stück → 1 Teil ───────────────────────────
    const parts = piece.cyclic ? splitCyclic(piece.idx, 3) : [piece.idx];
    for (const part of parts) {
      const chunks = [];
      splitTooLong(part, o.maxFacets, chunks);
      for (const chunk of chunks) {
        for (const fitted of fitPart(ctx, runs, chunk, state)) {
          if (fitted.length < o.minFacets) continue;
          const fiList = fitted.map((k) => chain.facets[k]);
          if (fiList.some((fi) => state.claimed.has(fi))) continue;
          const band = makeExtBand(ctx, fiList);
          if (!band) continue;
          band.id = nextId();
          if (state.ctxOf) state.ctxOf.set(band.id, ctx);
          for (const fi of fiList) { state.claimed.add(fi); state.taken.add(fi); }
          state.bands.push(band);
          state.stats.bands++;
          state.stats.facets += fiList.length;
        }
      }
    }
  }
}

/**
 * Lo- (bzw. Hi-) Polygonzug einer Facetten-Folge, mit der Facetten-Zuordnung je Punkt.
 * → { pts, facetOf }
 */
function polylineOf(runs, idx, which, vkey) {
  const pts = [], facetOf = [];
  for (const k of idx) {
    const run = runs[k][which];
    for (let i = 0; i < run.length; i++) {
      if (pts.length && vkey(pts[pts.length - 1]) === vkey(run[i])) continue;
      pts.push(run[i]);
      facetOf.push(k);
    }
  }
  return { pts, facetOf };
}

/** Lo-Polygonzug (zyklische Stücke: der letzte Punkt wiederholt den ersten → weg). */
function loPolyline(ctx, runs, idx, cyclic) {
  const vkey = ctx.vkey;
  const poly = polylineOf(runs, idx, 'loRun', vkey);
  if (cyclic && poly.pts.length > 1) {
    if (vkey(poly.pts[0]) === vkey(poly.pts[poly.pts.length - 1])) {
      poly.pts.pop();
      poly.facetOf.pop();
    }
  }
  return poly;
}

/** Hi-Polygonzug einer Facetten-Folge. */
function hiPolyline(ctx, runs, idx) {
  return polylineOf(runs, idx, 'hiRun', ctx.vkey);
}

/** Ein zyklisches Stück in n Teile (fast) gleicher Facettenzahl schneiden. */
function splitCyclic(idx, n) {
  const m = idx.length;
  const out = [];
  let a = 0;
  for (let i = 1; i < n; i++) {
    const b = Math.round((m * i) / n);
    if (b > a) out.push(idx.slice(a, b));
    a = b;
  }
  if (a < m) out.push(idx.slice(a));
  return out;
}

/** Zu lange Teile in Hälften teilen (maxFacets). */
function splitTooLong(idx, maxFacets, out) {
  if (!idx.length) return;
  if (idx.length <= maxFacets) { out.push(idx); return; }
  const mid = Math.floor(idx.length / 2);
  splitTooLong(idx.slice(0, mid), maxFacets, out);
  splitTooLong(idx.slice(mid), maxFacets, out);
}

/**
 * Abweichungs-Split: passt die kubische B-Spline nicht auf den Polygonzug (oder liegt
 * ein Hi-Punkt nicht auf der Spline), wird die Facette mit dem schlimmsten Span entfernt
 * (sie bleibt planar) und links/rechts neu versucht.
 * → Array von Facetten-Folgen, die passen
 */
function fitPart(ctx, runs, idx, state) {
  const { frame, o } = ctx;
  if (!idx.length) return [];
  const lo = loPolyline(ctx, runs, idx, false);
  if (lo.pts.length < 2) return [];
  const pts3 = lo.pts.map((p) => { const l = toLocal(frame, p); return [l[0], l[1], 0]; });
  const sp = interpolateCubic(pts3);
  if (!sp) return [];
  const devs = spanDeviation(sp, pts3);
  const th = turningAngles(pts3);

  // schlimmster Span
  let worst = -1, worstVal = -Infinity;
  for (let i = 0; i < devs.length; i++) {
    const c = Math.hypot(pts3[i + 1][0] - pts3[i][0], pts3[i + 1][1] - pts3[i][1]);
    const t = Math.max(th[i], th[i + 1]);
    const allowed = Math.min(o.devMax, Math.max(o.devAbs, o.devRel * c * t));
    const val = devs[i] - allowed;
    if (val > worstVal) { worstVal = val; worst = i; }
  }
  let remove = -1;
  if (worst >= 0 && worstVal > 0) {
    remove = lo.facetOf[worst];
  } else {
    // Hi-Punkte müssen auf der Lo-Spline liegen
    const hi = hiPolyline(ctx, runs, idx);
    for (let i = 0; i < hi.pts.length; i++) {
      const l = toLocal(frame, hi.pts[i]);
      const q = [l[0], l[1], 0];
      let same = false;
      for (const p of lo.pts) {
        const ll = toLocal(frame, p);
        if (Math.hypot(ll[0] - q[0], ll[1] - q[1]) <= 1e-6) { same = true; break; }
      }
      if (same) continue;
      const u = nearestParam(sp, q);
      let d = Infinity;
      if (u !== null) {
        const s = evalSpline(sp, u);
        if (s) d = Math.hypot(s[0] - q[0], s[1] - q[1]);
      }
      if (!(d <= o.hiTol)) { remove = hi.facetOf[i]; break; }
    }
  }
  if (remove < 0) return [idx];
  state.stats.devSplits++;
  const pos = idx.indexOf(remove);
  if (pos < 0) return [idx];
  const out = [];
  for (const sub of [idx.slice(0, pos), idx.slice(pos + 1)]) {
    if (sub.length < o.minFacets) continue;
    for (const p of fitPart(ctx, runs, sub, state)) out.push(p);
  }
  return out;
}

// ── Kollisionen (dieselbe Kurve an zwei Orten) ──────────────────────────────

/**
 * Band verwerfen: aus der Bandliste streichen; seine Facetten geben die
 * Beanspruchung (claimed/taken) wieder frei.
 */
function dropBand(bands, band, claimed, taken) {
  const at = bands.indexOf(band);
  if (at >= 0) bands.splice(at, 1);
  for (const fi of band.facets || []) {
    if (claimed) claimed.delete(fi);
    if (taken) taken.delete(fi);
  }
}

/**
 * ZWEI Kurven mit demselben Endpunkt-Paar dürfen nicht existieren: die Deckfläche
 * speichert ihre Bogen-Kanten in fd.arcEdges unter edgeCanonKey(a,b) — die zweite
 * Kurve würde die erste still überschreiben und die Hülle aufreißen.
 *
 * Deshalb werden alle 'arc'-Segmente aller Bänder nach edgeCanonKey gruppiert. Solange
 * ein Schlüssel mehrfach belegt ist, wird das Band mit den meisten Facetten in der
 * Mitte getrennt (zwei neue Bänder mit neuen Ids) — oder ganz verworfen, wenn es
 * zu kurz ist (< 2·minFacets, sonst gäbe es keine zwei gültigen Hälften).
 *
 * stats.collisionSplits / stats.collisionDrops zählen die Ereignisse.
 */
function resolveCurveCollisions(bands, ctxOf, o, claimed, taken, stats, nextId) {
  const minFacets = Math.max(1, o.minFacets || 1);
  for (;;) {
    // Gruppieren: Schlüssel → Bänder, die eine Kurve mit diesem Endpunkt-Paar haben
    const groups = new Map();
    for (const band of bands) {
      const ctx = ctxOf.get(band.id);
      if (!ctx) continue;
      for (const seg of band.segs || []) {
        if (seg.type !== 'arc') continue;
        const pts = seg.pts || [];
        if (pts.length < 2) continue;
        const key = edgeCanonKey(ctx.vkey, pts[0], pts[pts.length - 1]);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(band);
      }
    }
    // der erste Schlüssel mit mehr als einer Kurve
    let hit = null;
    for (const list of groups.values()) {
      if (list.length > 1) { hit = list; break; }
    }
    if (!hit) break;

    // das Band mit den meisten Facetten unter den Betroffenen
    const involved = [...new Set(hit)];
    let victim = involved[0];
    for (const b of involved) {
      if ((b.facets || []).length > (victim.facets || []).length) victim = b;
    }
    const n = (victim.facets || []).length;
    const ctx = ctxOf.get(victim.id);
    if (!ctx || n < 2 * minFacets) {
      dropBand(bands, victim, claimed, taken);
      stats.collisionDrops++;
      continue;
    }
    // an der mittleren Seitenkante trennen und beide Hälften neu bauen
    const mid = Math.floor(n / 2);
    const made = [];
    for (const part of [victim.facets.slice(0, mid), victim.facets.slice(mid)]) {
      const b = makeExtBand(ctx, part);
      if (!b) continue;
      b.id = nextId();
      ctxOf.set(b.id, ctx);
      made.push(b);
    }
    if (!made.length) {
      dropBand(bands, victim, claimed, taken);
      stats.collisionDrops++;
      continue;
    }
    const at = bands.indexOf(victim);
    bands.splice(at, 1, ...made);
    stats.collisionSplits++;
  }
}

// ── Zusammenführen / Aufteilen ──────────────────────────────────────────────

/**
 * Kollisionen zwischen Kreis-Bögen (profile-arcs) und Extrusions-Bändern aufräumen:
 * ein Extrusions-Band, dessen Lo- oder Hi-Kurve dasselbe Endpunkt-Paar hat wie ein
 * Bogen eines Kreis-Bandes, fällt weg (sonst überschreiben sie sich in fd.arcEdges
 * der Deckfläche).
 *
 * vkey: Vertex-Schlüssel; ohne Angabe der Notfall-Ersatz aus profile-arcs (vier
 * Nachkommastellen).
 * → extDet ohne die kollidierenden Bänder (stats.collisionWithArcs = Anzahl)
 */
export function dropCollisions(arcDet, extDet, vkey) {
  const a = arcDet || {};
  const e = extDet || {};
  const vk = (typeof vkey === 'function') ? vkey : vtxKeyOf({});
  // Endpunkt-Paare aller Kreis-Bögen
  const arcPairs = new Set();
  for (const b of a.bands || []) {
    for (const seg of b.segs || []) {
      if (seg.type !== 'arc') continue;
      const pts = seg.pts || [];
      if (pts.length < 2) continue;
      arcPairs.add(edgeCanonKey(vk, pts[0], pts[pts.length - 1]));
    }
  }
  const src = e.bands || [];
  const bands = src.filter((b) => {
    if (b.kind && b.kind !== 'ext') return true;
    for (const seg of b.segs || []) {
      if (seg.type !== 'arc') continue;
      const pts = seg.pts || [];
      if (pts.length < 2) continue;
      if (arcPairs.has(edgeCanonKey(vk, pts[0], pts[pts.length - 1]))) return false;
    }
    return true;
  });
  const removed = src.length - bands.length;
  if (!e.stats) e.stats = {};
  e.stats.collisionWithArcs = removed;
  return { ...e, bands, stats: e.stats };
}

/**
 * Bogen-Erkennung und Extrusions-Erkennung zusammenführen (eine gemeinsame Liste von
 * Bändern und Bögen, damit validateArcBands/applyArcBands auf ihr arbeiten können).
 * Extrusions-Bänder, die mit einem Kreis-Bogen um dieselben Endpunkte laufen, fallen weg.
 * vkey (optional): Vertex-Schlüssel; ohne Angabe der Notfall-Ersatz aus profile-arcs.
 * → { bands, arcs, stats }
 */
export function mergeDets(arcDet, extDet, vkey) {
  const a = arcDet || {};
  const e = dropCollisions(a, extDet || {}, vkey);
  const kept = new Set((e.bands || []).map((b) => b.id));
  const arcs = new Map();
  for (const [k, v] of (a.arcs instanceof Map ? a.arcs : new Map())) arcs.set(k, v);
  for (const [k, v] of (e.arcs instanceof Map ? e.arcs : new Map())) {
    const owners = (v && v.owners) || [];
    // Bogen eines verworfenen Extrusions-Bandes: nicht mitnehmen
    if (owners.length && !owners.some((ow) => kept.has(ow.band))) continue;
    arcs.set(k, v);
  }
  return {
    bands: [...(a.bands || []), ...(e.bands || [])],
    arcs,
    stats: { ...(a.stats || {}), ext: e.stats },
  };
}

/**
 * Ein VALIDIERTES Ergebnis (det.bands, det.arcs, det.capEdits aus validateArcBands) in
 * Bogen-Bänder und Extrusions-Bänder aufteilen.
 * Zugeordnet wird nach band.kind === 'ext' bzw. rec.kind === 'spline'; die capEdits
 * folgen der Zugehörigkeit ihres Bogens.
 * → { arc: { bands, arcs, capEdits, stats }, ext: { bands, arcs, capEdits, stats } }
 */
export function splitDet(det) {
  const d = det || {};
  const bands = d.bands || [];
  const arcs = d.arcs instanceof Map ? d.arcs : new Map();
  const extIds = new Set(bands.filter((b) => b.kind === 'ext').map((b) => b.id));
  const extKeys = new Set();
  for (const [key, rec] of arcs) {
    const owners = (rec && rec.owners) || [];
    if (rec.kind === 'spline' || owners.some((ow) => extIds.has(ow.band))) extKeys.add(key);
  }
  const arc = { bands: [], arcs: new Map(), capEdits: [], stats: d.stats };
  const ext = { bands: [], arcs: new Map(), capEdits: [], stats: d.stats };
  for (const b of bands) (extIds.has(b.id) ? ext.bands : arc.bands).push(b);
  for (const [key, rec] of arcs) (extKeys.has(key) ? ext.arcs : arc.arcs).set(key, rec);
  for (const ce of (d.capEdits || [])) {
    (extKeys.has(ce.arcKey) ? ext.capEdits : arc.capEdits).push(ce);
  }
  return { arc, ext };
}
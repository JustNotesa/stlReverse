// ─────────────────────────────────────────────────────────────────────────────
// freeform-brep.js — Freiform-Pfad (Etappe 1): fit-basierte Segmentierung → exakte
// Ebenen/Zylinder/Kegel/KUGELN/TORI beliebiger Lage → eigenes B-Rep → STEP.
//
// ENTWURF (Lead, 2026-10-28) — verbindlich für alle Freiform-Module
// ═══════════════════════════════════════════════════════════════════
// Problem: Spritzguss-/CATIA-Teile (Skoda-Haken) haben kleine Verrundungen (r 0,3–1) an
// gekrümmten Kanten und Eckkugeln. Region-Growing nach Normalen macht jede Facettenreihe zur
// eigenen Ebene (18 377 Flächen). Ein Fit-basierter Ansatz findet ~770 analytische Regionen.
//
// Pipeline (alles in eigenen Modulen, exporters.js hat nur EINEN markierten Einhängepunkt):
//   1. Netz      freeform-segment.js  indexMesh(triangles)  — Dreiecke der normalGroups (Reihenfolge
//                der Ecken = Außen-Orientierung) → geschweißtes Netz {P, tri, nV, T}; nur EINE dichte,
//                mannigfaltige Schale (jede Kante genau 2 Dreiecke, zusammenhängend), sonst null.
//   2. Segment.  freeform-segment.js  segmentByFit(mesh, {tol:0.02, angleDeg:12}) — Region-Growing mit
//                Modell-Fit (Ebene/Zylinder/Kegel/Kugel/Torus, Prototyp skoda/fitseg.mjs) → label[T] +
//                regions[{id,type,surf,tris,area}]; type 'facet' = kein Modell (surf null).
//   3. Snap      freeform-snap.js     snapSurfaces(...) — Verrundungen exakt tangential an ihre
//                Nachbarn legen (Fit-Rauschen macht tangentiale Paare sonst schnittlos/zweideutig):
//                Radien-Cluster vereinheitlichen; Zylinder ∥ Ebene im Abstand R; Torus-Achse ⟂ Ebene,
//                Mitte im Abstand r; Torus koaxial zu Zylinder, Rm = R ± r; Kugel auf Zylinderachse(n),
//                R = R_Zyl. Jede Änderung nur, wenn die Region danach noch ≤ 2·tol passt.
//   4. Topologie freeform-topology.js buildTopology(mesh, label, forceVertex) — Rand-Halbkanten je
//                Region (Fächer-Drehung um die Ecke, auch an Quetsch-Ecken), Ketten zwischen zwei
//                Regionen, B-Rep-Ecken (≠ 2 ausgehende Rand-Halbkanten), geschlossene Ketten an
//                mv[0] und mv[mitte] geteilt, Loops je Region als Folge {chain, fwd}.
//   5. Geometrie (hier, mit freeform-geom.js):
//      a) Ecken: projectMulti(alle analytischen Flächen der anliegenden Regionen, Netzpunkt) —
//         Levenberg-Marquardt mit Minimalnorm-Schritt; Rest ≤ 1e-10, Verschiebung ≤ Grenze.
//         Alle Ecken eines Facetten-Dreiecks sind B-Rep-Ecken (forceVertex), damit seine Ebene aus
//         den ENDGÜLTIGEN Eckpunkten folgt.
//      b) Facetten-Ebene = Ebene durch die 3 Endpunkte (Normale gleichsinnig zum Netz, sonst Fehler).
//      c) Kante zwischen Fläche A und B von p nach q: Strecke mit |p−q| < 1e-6 und tangentialen
//         Flächen → Kante fällt weg (Punktkontakt Kugel↔Ebene), Ecken werden vereinigt.
//         Sonst analyticCurve(A,B,p,q,mitte): LINE (Ebene∩Ebene, Zylinder∥…), CIRCLE (alle
//         koaxialen Drehflächen-Paare inkl. Ebene ⟂ Achse und Kugel mit Mitte auf der Achse,
//         Ebene∩Kugel). Sonst B_SPLINE_CURVE_WITH_KNOTS (kubisch, interpolierend) durch Stütz-
//         punkte, die per projectMulti([A,B]) EXAKT auf beiden Flächen liegen (Netz-Punkte der Kette
//         als Startwerte); Prüfung an Zwischen-Parametern ≤ 5e-7 auf beiden Flächen, sonst Stütz-
//         punkt einfügen (bis 64), sonst Fehler. Endpunkte = Eckpunkte (exakt).
//   6. Rückfall je Merkmal: jeder Fehler (Ecke, Kante, Orientierung) nennt die schuldige Region
//      (die kleinere nicht-ebene der beteiligten); sie wird zu Facetten (jedes Dreieck eine eigene
//      Ebene) — nur sie bleibt facettiert. Dann ab 4. neu, höchstens 8 Runden; danach null.
//   7. STEP: freeform-step.js writeFreeformStep({vertices, edges, faces}) — eigener Schreiber
//      (Zahlenformat/Kontext/Produkt wie exporters.js), SPHERICAL_SURFACE, TOROIDAL_SURFACE,
//      CIRCLE, B_SPLINE_CURVE_WITH_KNOTS, eine CLOSED_SHELL + MANIFOLD_SOLID_BREP.
//      same_sense je Region: flächengewichtetes Mittel von (Netz-Normale · natürliche Normale)
//      > 0 → .T.; Vorzeichen-Mischung > 10 % der Fläche → Fehler (Rückfall). Loops kommen aus
//      dem Netz (Außen-Orientierung) und sind damit für .T. wie .F. richtig (STEP: Ränder gegen
//      den Uhrzeigersinn um die EFFEKTIVE Normale). Ebene: Rand mit größter projizierter Fläche
//      = FACE_OUTER_BOUND; gekrümmt: 1 Rand → OUTER, sonst alle FACE_BOUND.
//
// Datenmodell (gemeinsam; Vektoren als [x,y,z], Richtungen normiert):
//   Fläche  { type:'plane',    o, n }
//           { type:'cylinder', o (Punkt auf Achse), a, R }
//           { type:'cone',     apex, a (öffnet in +a), alpha (Halbwinkel rad, 0<α<π/2) }
//           { type:'sphere',   c, R }
//           { type:'torus',    c, a, Rm (groß), r (klein), Rm > r > 0 }
//     natürliche Normale: Ebene n; sonst von Achse/Mitte/Rohr-Kreis weg nach außen.
//     sdist(s,p) = vorzeichenbehafteter euklidischer Abstand, + auf Seite der natürlichen Normale.
//   Kurve   { type:'line', p, d } | { type:'circle', c, a, R, x (Bezugsrichtung ⟂ a) }
//           | { type:'bspline', degree:3, ctrl:[[x,y,z]…], knots:[…verschieden], mults:[…] }
//     Kante läuft immer in Kurvenrichtung von v0 nach v1 (EDGE_CURVE same_sense .T.); bei CIRCLE
//     wird a so gewählt, dass der positive Bogen v0→v1 die Kettenmitte enthält.
//   Netz    { P: Float64Array(3·nV), tri: Int32Array(3·T), nV, T }  (Dreiecke außen gegen Uhrzeiger)
//
// Aktivierung (Schalter analysis.fitSegmentation: 'auto' Standard | true | false):
//   'auto': erst der bisherige Weg; nur wenn er sehr viele Flächen liefert (faceCount ≥ 5000 UND
//   faceCount ≥ 0,1 · Dreiecke — Kennzeichen „jede Facettenreihe eine Ebene“; Kabelhalter 218/14 514,
//   eBike 2306, dino < 5000 bleiben unberührt) wird der Freiform-Pfad versucht und nur genommen, wenn er
//   gültig ist UND ≤ 0,6 · so viele Flächen hat. true: Freiform immer versuchen, gültig → nehmen.
//   false: nie. AN/AUS (Defeaturing) wirkt in Etappe 1 nicht auf den Freiform-Pfad (Etappe 3).
//
// Nicht in Etappe 1: Formschrägen-Wände als B-Spline-Regelfläche (Etappe 2), Schärfen kleiner
// Verrundungen im AN-Modus (Etappe 3), mehrere Schalen/Hohlräume (→ bisheriger Weg).
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Umsetzung (Etappe 1) — Orchestrator
//
// Ablauf je Runde: Arbeitsregionen → Topologie → Snap → Orientierung → Ecken →
// Kanten → Flächen. Jeder Fehler nennt die schuldige Region; sie wird zur Fassade
// (jedes Dreieck eine eigene Ebene) und die Runde läuft erneut (höchstens 8 Runden).
// ─────────────────────────────────────────────────────────────────────────────
import { trianglesFromGroups, indexMesh, segmentByFit } from './freeform-segment.js';
import { buildTopology, checkTopology } from './freeform-topology.js';
import {
  normalAt, projectMulti, fitIntersectionCurve, evalBspline,
  add, sub, mul, dot, cross, len, norm,
} from './freeform-geom.js';
import { snapSurfaces } from './freeform-snap.js';
import { writeFreeformStep } from './freeform-step.js';

// ---- Grenzwerte (Etappe 1) ----
const ROUNDS_MAX = 12;           // höchstens 12 Runden
const STRIP_ROUNDS_MAX = 3;      // 3 Runden mit Streifen → Region ganz zur Fassade
const SEG_ANGLE_DEG = 12;        // Segmentierwinkel
const SENSE_MIN = 0.8;           // |flächengewichtetes Vorzeichen| je Region
const COLLAPSE_EPS = 1e-6;       // Kante fällt weg (Punktkontakt)
const FIT_TOL = 5e-7;            // Toleranz der Schnittkurve (B-Spline)
const EDGE_MAX_SHIFT = 0.5;      // größte Verschiebung eines Stützpunkts
const VERT_TOL = 1e-9;           // Rest der Eckprojektion (mm) — Ecken liegen exakt auf allen Flächen (ACIS 1e-6)

const now = () => (globalThis.performance && globalThis.performance.now)
  ? globalThis.performance.now() : Date.now();

function deepCopy(o) {
  if (Array.isArray(o)) return o.map(deepCopy);
  if (o && typeof o === 'object') {
    const r = {};
    for (const k of Object.keys(o)) r[k] = deepCopy(o[k]);
    return r;
  }
  return o;
}

// Netzpunkt
const ptOf = (mesh, mv) => [mesh.P[3 * mv], mesh.P[3 * mv + 1], mesh.P[3 * mv + 2]];

// Fläche in Kurzform (nur für das Debug-Protokoll)
const f4 = (x) => (Number.isFinite(x) ? x.toFixed(4) : 'NaN');
function surfDesc(s) {
  if (!s) return '-';
  const v = (a) => `[${(a || []).map(f4).join(',')}]`;
  switch (s.type) {
    case 'plane': return `Ebene o=${v(s.o)} n=${v(s.n)}`;
    case 'cylinder': return `Zylinder o=${v(s.o)} a=${v(s.a)} R=${f4(s.R)}`;
    case 'cone': return `Kegel apex=${v(s.apex)} a=${v(s.a)} alpha=${f4(s.alpha)}`;
    case 'sphere': return `Kugel c=${v(s.c)} R=${f4(s.R)}`;
    case 'torus': return `Torus c=${v(s.c)} a=${v(s.a)} Rm=${f4(s.Rm)} r=${f4(s.r)}`;
    default: return String(s.type);
  }
}

// Schwerpunkt eines Dreiecks
function centroidOf(mesh, t) {
  const { P, tri } = mesh;
  const i0 = tri[3 * t], i1 = tri[3 * t + 1], i2 = tri[3 * t + 2];
  return [
    (P[3 * i0] + P[3 * i1] + P[3 * i2]) / 3,
    (P[3 * i0 + 1] + P[3 * i1 + 1] + P[3 * i2 + 1]) / 3,
    (P[3 * i0 + 2] + P[3 * i1 + 2] + P[3 * i2 + 2]) / 3,
  ];
}

// Täter unter den Kandidaten: analytische Nicht-Ebenen zuerst, dann analytische
// Ebenen, zuletzt Facetten (an einer Facette kann nichts mehr gestreift werden)
function pickCulprit(cands) {
  let best = null;
  let bestRank = -1;
  for (const c of cands) {
    if (!c) continue;
    const analytic = c.kind === 'analytic';
    const nonPlane = analytic && c.surf && c.surf.type !== 'plane';
    const rank = nonPlane ? 3 : analytic ? 2 : 1;
    if (rank > bestRank || (rank === bestRank && best && c.area < best.area)) {
      best = c; bestRank = rank;
    }
  }
  return best;
}

// Kleinste analytische Region unter den Kandidaten
function pickSmallestAnalytic(cands) {
  let best = null;
  for (const c of cands) {
    if (!c || c.kind !== 'analytic') continue;
    if (!best || c.area < best.area) best = c;
  }
  return best;
}

// Zylinder/Kugel-Paar (Testschalter)
function isCylSphere(A, B) {
  const ta = A && A.type, tb = B && B.type;
  return (ta === 'cylinder' && tb === 'sphere') || (ta === 'sphere' && tb === 'cylinder');
}

// ─────────────────────────────────────────────────────────────────────────────
// Freiform-B-Rep bauen: normalGroups → { step, report, brep } | null
//
// opts: { tol (Segmentier-Toleranz, default 0.02), debug: { log: [] } }
// ─────────────────────────────────────────────────────────────────────────────
export function buildFreeformBrep(normalGroups, opts = {}) {
  const o = opts || {};
  const dbg = (o.debug && typeof o.debug === 'object') ? o.debug : null;
  const log = dbg ? (dbg.log || (dbg.log = [])) : null;
  try {
    return buildInner(normalGroups, o, log);
  } catch (e) {
    if (log) log.push(`Ausnahme: ${e && e.message ? e.message : String(e)}`);
    return null;
  }
}

function buildInner(normalGroups, opts, log) {
  const t0 = now();
  // 1) Netz: nur EINE dichte, mannigfaltige Schale
  const mesh = indexMesh(trianglesFromGroups(normalGroups));
  if (!mesh || !mesh.manifold || mesh.components !== 1) {
    if (log) log.push('Netz: nicht manifold oder mehrere Komponenten — Freiform-Pfad nicht möglich');
    return null;
  }
  // 2) Fit-basierte Segmentierung
  const seg = segmentByFit(mesh, { tol: opts.tol ?? 0.02, angleDeg: SEG_ANGLE_DEG });
  if (log) {
    const byType = {};
    for (const r of seg.regions) byType[r.type] = (byType[r.type] || 0) + 1;
    log.push(`Segmentierung: ${seg.regions.length} Regionen ${JSON.stringify(byType)}`);
    log.push(seg.regions.map((r) => `#${r.id} ${r.type} ${r.area.toFixed(1)}mm² ${r.tris.length}D`).join(', '));
    log.push(seg.regions.filter((r) => r.surf)
      .map((r) => `#${r.id} ${r.type} ${surfDesc(r.surf)}`).join(' | '));
  }
  // Streifen-Demotion: nur einzelne Dreiecke der schuldigen Region werden Facetten
  const state = {
    stripTris: new Set(),        // Netz-Dreiecke, die zu eigenen Facetten wurden
    demotedRegions: new Set(),   // Regionen, die ganz zur Fassade wurden
    stripRounds: new Map(),      // Region → Runden, in denen sie gestreift wurde
    testForceUsed: false,        // Testschalter: wirkt nur einmal
    segById: new Map(seg.regions.map((r) => [r.id, r])),
  };
  for (let round = 0; round < ROUNDS_MAX; round++) {
    const res = runRound(mesh, seg, state, round, opts, log);
    if (res.hard) return null;
    if (res.failures.length) {
      if (!res.strips.size) {
        if (log) log.push(`Runde ${round}: Fehler ohne schuldige Region → Abbruch`);
        return null;
      }
      const before = state.stripTris.size + state.demotedRegions.size;
      for (const [src, mvSet] of res.strips) {
        applyStrip(state, mesh, src, mvSet, round, log);
      }
      if (state.stripTris.size + state.demotedRegions.size === before) {
        if (log) log.push(`Runde ${round}: kein neuer Streifen → Abbruch`);
        return null;
      }
      continue;
    }
    // Erfolg → STEP
    const { step } = writeFreeformStep(res.brep);
    const ms = Math.round((now() - t0) * 10) / 10;
    const report = {
      faceCount: res.brep.faces.length,
      watertight: true,
      shells: 1,
      solids: 1,
      openShells: 0,
      voids: 0,
      fallbackStage: 0,
      boresConverted: 0,
      mantlesConverted: 0,
      tubesConverted: 0,
      bandsDefeatured: 0,
      filletsDefeatured: 0,
      cornersDefeatured: 0,
      freeform: {
        used: true,
        rounds: round + 1,
        demoted: countDemoted(seg, state),
        stripTris: state.stripTris.size,
        faces: res.facesByType,
        edges: res.edgesByType,
        ms,
      },
    };
    return { step, report, brep: res.brep };
  }
  if (log) log.push(`Nach ${ROUNDS_MAX} Runden noch Fehler → Abbruch`);
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Eine Runde: Arbeitsregionen, Topologie, Snap, Geometrie
// ─────────────────────────────────────────────────────────────────────────────
function runRound(mesh, seg, state, round, opts, log) {
  const { tri, nV, T, N, A } = mesh;
  const failures = [];
  const strips = new Map();            // Quellregion → Netzecken des Streifens
  const fail = (cands, reason, mvSet, pick) => {
    failures.push(reason);
    const c = pick ? pick(cands) : pickCulprit(cands);
    if (c && c.kind === 'analytic') {
      let s = strips.get(c.src);
      if (!s) { s = new Set(); strips.set(c.src, s); }
      for (const mv of (mvSet || [])) s.add(mv);
    }
    if (log) {
      log.push(`Runde ${round}: ${reason}${c
        ? ` → Täter: Region ${c.id} (${c.type}, ${c.area.toFixed(1)} mm²)`
        : ' → kein Täter'}`);
    }
  };

  // ── a) Arbeitsregionen: gestrippte und Facetten-Regionen werden Dreieck für Dreieck
  const regions = [];
  const byId = new Map();
  const wLabel = new Int32Array(T);
  const forceVertex = new Uint8Array(nV);
  const addFacet = (t, src) => {
    const wr = { id: regions.length, kind: 'facet', tris: [t], area: A[t], src, type: 'facet' };
    regions.push(wr); byId.set(wr.id, wr); wLabel[t] = wr.id;
    for (let k = 0; k < 3; k++) forceVertex[tri[3 * t + k]] = 1;
  };
  for (const r of seg.regions) {
    // Rest der Region ohne gestrippte Dreiecke
    const rest = r.tris.filter((t) => !state.stripTris.has(t));
    // ganze Region (Fassade, Eskalation oder verschwunden) → jedes Dreieck eine Facette
    if (r.type === 'facet' || state.demotedRegions.has(r.id) || !rest.length) {
      for (const t of r.tris) addFacet(t, r.id);
      continue;
    }
    // Streifen: die gestrippten Dreiecke werden Facetten, der Rest behält die
    // Fläche der Region (Original-Fit, kein Neu-Fit)
    for (const t of r.tris) if (state.stripTris.has(t)) addFacet(t, r.id);
    let area = 0;
    for (const t of rest) area += A[t];
    const wr = {
      id: regions.length, kind: 'analytic', surf: deepCopy(r.surf),
      tris: rest, area, src: r.id, type: r.type,
    };
    regions.push(wr); byId.set(wr.id, wr);
    for (const t of rest) wLabel[t] = wr.id;
  }

  // ── b) Topologie
  const topo = buildTopology(mesh, wLabel, { forceVertex });
  const terrs = checkTopology(topo);
  if (terrs.length) {
    if (log) log.push(`Runde ${round}: Topologiefehler: ${terrs.slice(0, 4).join(' | ')}`);
    return { hard: true };
  }

  // ── c) Snap: tangentiale Paare exakt zusammenführen
  let snap = null;
  try {
    snap = snapSurfaces({ mesh, regions: byId, chains: topo.chains }, {});
  } catch (e) {
    snap = null;
  }
  const surfs = (snap && snap.surfs && typeof snap.surfs.get === 'function') ? snap.surfs : null;
  for (const wr of regions) {
    if (wr.kind !== 'analytic') continue;
    let s = surfs ? surfs.get(wr.id) : null;
    if (!s || !s.type) s = surfs ? surfs.get(wr.src) : null;
    if (s && s.type) wr.surf = deepCopy(s);
  }

  // ── d) Orientierung je analytischer Region (flächengewichtet)
  for (const wr of regions) {
    if (wr.kind !== 'analytic') continue;
    let acc = 0;
    for (const t of wr.tris) {
      const d = dot([N[3 * t], N[3 * t + 1], N[3 * t + 2]], normalAt(wr.surf, centroidOf(mesh, t)));
      acc += A[t] * (d > 0 ? 1 : d < 0 ? -1 : 0);
    }
    const s = wr.area > 0 ? acc / wr.area : 0;
    wr.sense = s;
    if (!(Math.abs(s) >= SENSE_MIN)) {
      fail([wr], `Orientierung Region ${wr.id} (${wr.type}) = ${s.toFixed(3)} (zu schwach)`,
        regionVertices(mesh, wr));
    } else wr.sameSense = s > 0;
  }

  // ── e) Ecken: Projektion auf alle anliegenden analytischen Flächen
  const incident = new Map();                 // Netzecke → Regionen
  for (let t = 0; t < T; t++) {
    const id = wLabel[t];
    for (let k = 0; k < 3; k++) {
      const mv = tri[3 * t + k];
      let s = incident.get(mv);
      if (!s) { s = new Set(); incident.set(mv, s); }
      s.add(id);
    }
  }
  const edgeLen = new Float64Array(nV);      // mittlere Kantenlänge je Netzecke
  const edgeCnt = new Float64Array(nV);
  for (let t = 0; t < T; t++) {
    for (let k = 0; k < 3; k++) {
      const i = tri[3 * t + k], j = tri[3 * t + (k + 1) % 3];
      const l = len(sub(ptOf(mesh, j), ptOf(mesh, i)));
      edgeLen[i] += l; edgeCnt[i]++;
      edgeLen[j] += l; edgeCnt[j]++;
    }
  }
  const nv = topo.vertices.length;
  const X = new Array(nv);
  let worstRes = 0;
  for (let vi = 0; vi < nv; vi++) {
    const mv = topo.vertices[vi].mv;
    const p = ptOf(mesh, mv);
    const ids = incident.get(mv) || new Set();
    const S = [];
    for (const id of ids) {
      const wr = regions[id];
      if (wr.kind === 'analytic' && wr.surf) S.push(wr.surf);
    }
    if (!S.length) { X[vi] = p; continue; }   // nur Facetten → Netzecke bleibt
    const meanEdge = edgeCnt[mv] > 0 ? edgeLen[mv] / edgeCnt[mv] : 0;
    const maxShift = Math.min(0.5, Math.max(0.05, 3 * meanEdge));
    const r = projectMulti(S, p);
    const shift = len(sub(r.x, p));
    if (r.res > worstRes) worstRes = r.res;
    // projectMulti verlangt selbst Rest ≤ 1e-10 mm — das ist für GEFITTETE Flächen
    // (Genauigkeit ~1e-5 mm) nicht erreichbar: tangentiale Paare (Kugel auf Zylinderachse)
    // schneiden sich nie exakt. Deshalb gilt der Rest ≤ VERT_TOL (2e-5 mm, weit unter der
    // STEP-Unsicherheit 1e-4 mm) als Erfolg; ein echter Widerspruch (kein Schnittpunkt)
    // liefert einen Rest in Größenordnung der Fit-Toleranz und wird abgewiesen.
    const projOK = r.ok || (Number.isFinite(r.res) && r.res <= VERT_TOL);
    if (!projOK || shift > maxShift) {
      const cands = [...ids].map((id) => regions[id]).filter((w) => w.kind === 'analytic');
      fail(cands, `Ecke ${vi} (Netz ${mv} bei ${p.map((x) => x.toFixed(3)).join(',')}): `
        + `Projektion res=${r.res.toExponential(2)} mm, `
        + `Verschiebung ${shift.toExponential(2)} mm (Grenze ${maxShift.toFixed(3)}), `
        + `Flächen ${cands.map((c) => c.type).join('/')}`, [mv]);
      X[vi] = p;
      continue;
    }
    X[vi] = r.x;
  }
  if (log) log.push(`Runde ${round}: ${regions.length} Regionen, ${nv} Ecken, `
    + `größter Projektionsrest ${worstRes.toExponential(2)} mm`);

  // ── f) Zusammenfallen: Kante mit |X[start] − X[end]| < 1e-6 fällt weg
  const parent = new Int32Array(nv);
  for (let i = 0; i < nv; i++) parent[i] = i;
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[rb] = ra; };
  const collapsed = new Set();
  for (const ch of topo.chains) {
    const a = topo.vOfMesh[ch.mv[0]], b = topo.vOfMesh[ch.mv[ch.mv.length - 1]];
    if (a < 0 || b < 0) continue;
    const pa = X[find(a)], pb = X[find(b)];
    if (pa && pb && len(sub(pa, pb)) < COLLAPSE_EPS) {
      collapsed.add(ch.id);
      union(a, b);
    }
  }
  // leere Schleifen → Fehler
  for (const lp of topo.loops) {
    const uses = lp.uses.filter((u) => !collapsed.has(u.chain));
    if (!uses.length) {
      const wr = regions[lp.region];
      fail(wr && wr.kind === 'analytic' ? [wr] : [],
        `Schleife ${lp.region} wurde durch das Zusammenfallen leer`,
        loopMeshVertices(mesh, topo, lp));
    }
  }

  // ── Vertreterecke (Union-Find) und ihre Punkte
  const vIndex = new Map();
  const vertices = [];
  for (let i = 0; i < nv; i++) {
    const r = find(i);
    if (vIndex.has(r)) continue;
    vIndex.set(r, vertices.length);
    vertices.push(X[r] ? X[r].slice() : [0, 0, 0]);
  }
  const vIdx = (vi) => (vi >= 0 && vi < nv) ? vIndex.get(find(vi)) : undefined;

  // ── g) Facetten-Ebenen
  const facetSurf = new Map();                // Region → { surf, sameSense }
  for (const wr of regions) {
    if (wr.kind !== 'facet') continue;
    const t = wr.tris[0];
    const c = [tri[3 * t], tri[3 * t + 1], tri[3 * t + 2]];
    const pa = vertices[vIdx(topo.vOfMesh[c[0]])] || ptOf(mesh, c[0]);
    const pb = vertices[vIdx(topo.vOfMesh[c[1]])] || ptOf(mesh, c[1]);
    const pc = vertices[vIdx(topo.vOfMesh[c[2]])] || ptOf(mesh, c[2]);
    const nv2 = cross(sub(pb, pa), sub(pc, pa));
    const nl = len(nv2);
    const nrm = nl > 0 ? mul(nv2, 1 / nl) : [0, 0, 0];
    const agree = dot(nrm, [N[3 * t], N[3 * t + 1], N[3 * t + 2]]);
    const eLen = Math.max(len(sub(pb, pa)), len(sub(pc, pb)), len(sub(pa, pc)));
    if (!(nl > 1e-9 * eLen * eLen) || agree < 0.5) {
      fail(analyticTouching(mesh, wr, wLabel, regions, incident),
        `Facette ${t}: Ebene entartet oder gegen die Netznormale (${agree.toFixed(3)})`,
        [tri[3 * t], tri[3 * t + 1], tri[3 * t + 2]], pickSmallestAnalytic);
      continue;
    }
    facetSurf.set(wr.id, { surf: { type: 'plane', o: pa.slice(), n: nrm }, sameSense: true });
  }

  // ── h) Kanten: Schnittkurve zwischen den beiden anliegenden Flächen
  const edges = [];
  const edgeOf = new Map();                   // Kette → Kantenindex
  const surfOfRegion = (id) => {
    const wr = regions[id];
    if (!wr) return null;
    if (wr.kind === 'analytic') return wr.surf;
    const fs = facetSurf.get(wr.id);
    return fs ? fs.surf : null;
  };
  for (const ch of topo.chains) {
    if (collapsed.has(ch.id)) continue;
    const A2 = surfOfRegion(ch.L), B2 = surfOfRegion(ch.R);
    const vi0 = topo.vOfMesh[ch.mv[0]], vi1 = topo.vOfMesh[ch.mv[ch.mv.length - 1]];
    if (!A2 || !B2 || vi0 < 0 || vi1 < 0) {
      fail([regions[ch.L], regions[ch.R]], `Kette ${ch.id}: Fläche oder Ecke fehlt`, new Set(ch.mv));
      continue;
    }
    const v0 = vIdx(vi0), v1 = vIdx(vi1);
    if (v0 === v1) {
      fail([regions[ch.L], regions[ch.R]], `Kette ${ch.id}: beide Enden sind dieselbe Ecke`, new Set(ch.mv));
      continue;
    }
    // Testschalter: eine Kette einmal scheitern lassen (Streifen-Demotion prüfen)
    const forced = typeof opts.testForceChainFail === 'function'
      ? opts.testForceChainFail(A2, B2, ch)
      : !!(opts.testForceChainFail && isCylSphere(A2, B2));
    if (forced && !state.testForceUsed) {
      state.testForceUsed = true;
      fail([regions[ch.L], regions[ch.R]],
        `Kette ${ch.id} (${regions[ch.L].type}/${regions[ch.R].type}): Schnittkurve testForceChainFail`,
        new Set(ch.mv));
      continue;
    }
    const p = vertices[v0], q = vertices[v1];
    const guides = ch.mv.slice(1, -1).map((mv) => ptOf(mesh, mv));
    const res = fitIntersectionCurve(A2, B2, p, q, guides, { tol: FIT_TOL, maxShift: EDGE_MAX_SHIFT });
    if (res.fail) {
      fail([regions[ch.L], regions[ch.R]],
        `Kette ${ch.id} (${regions[ch.L].type}/${regions[ch.R].type}): Schnittkurve ${res.fail}`,
        new Set(ch.mv));
      continue;
    }
    // Kreisbogen: läuft der positive Bogen p→q "lang herum"? → Bogen spiegeln
    let curve = res.curve;
    if (curve && curve.type === 'circle') {
      curve = fixCircleArc(curve, p, q, chainPolyLen(mesh, ch, p, q));
    }
    edgeOf.set(ch.id, edges.length);
    edges.push({ v0, v1, curve });
  }

  // ── i) Flächen (mit Platzierungshinweisen für den STEP-Schreiber)
  const faces = [];
  const facesByType = { plane: 0, cylinder: 0, cone: 0, sphere: 0, torus: 0, facet: 0 };
  for (const wr of regions) {
    const loopIdx = topo.regionLoops.get(wr.id) || [];
    const loops = [];
    for (const li of loopIdx) {
      const lp = topo.loops[li];
      const uses = [];
      const chains = [];
      for (const u of lp.uses) {
        if (collapsed.has(u.chain)) continue;
        const ei = edgeOf.get(u.chain);
        if (ei === undefined) continue;
        uses.push({ edge: ei, fwd: !!u.fwd });
        chains.push(u.chain);
      }
      if (!uses.length) continue;             // (bereits als Fehler gemeldet)
      loops.push({ uses, chains });
    }
    if (!loops.length) continue;
    let surf = null, sameSense = true, kind = wr.kind;
    if (wr.kind === 'analytic') {
      surf = wr.surf;
      sameSense = !!wr.sameSense;
      placementHint(wr, surf, mesh);
    } else {
      const fs = facetSurf.get(wr.id);
      if (!fs) continue;                       // (bereits als Fehler gemeldet)
      surf = fs.surf;
      sameSense = true;
      kind = 'facet';
    }
    // Entartete Fläche: eine Schleife ohne Flächeninhalt darf nicht ausgegeben werden
    const degen = degenerateLoop(loops, edges, vertices, surf, sameSense);
    if (degen) {
      const cands = wr.kind === 'facet'
        ? analyticTouching(mesh, wr, wLabel, regions, incident)
        : analyticNeighbours(topo, regions, wr, degen.chains);
      if (!cands.length) {
        if (log) log.push(`Runde ${round}: entartete Fläche ${wr.id} ohne analytischen Nachbarn → Abbruch`);
        return { hard: true };
      }
      fail(cands, `Fläche ${wr.id} (${kind}): ${degen.why}`,
        chainMeshVertices(mesh, topo, degen.chains), pickSmallestAnalytic);
      continue;
    }
    // Außenrand: bei Ebenen der größte projizierte Flächeninhalt, bei gekrümmten
    // Flächen nur bei genau einem Rand
    if (surf.type === 'plane') {
      let big = -1, bigA = -1;
      loops.forEach((lp, i) => {
        const a = Math.abs(faceArea(loopPolygon(edges, lp.uses, vertices), surf));
        if (a > bigA) { bigA = a; big = i; }
      });
      loops.forEach((lp, i) => { lp.outer = (i === big); });
    } else {
      const one = loops.length === 1;
      loops.forEach((lp) => { lp.outer = one; });
    }
    for (const lp of loops) delete lp.chains;
    faces.push({ surf, sameSense, loops, kind });
    facesByType[kind === 'facet' ? 'facet' : surf.type] = (facesByType[kind === 'facet' ? 'facet' : surf.type] || 0) + 1;
  }
  const edgesByType = { line: 0, circle: 0, bspline: 0 };
  for (const e of edges) {
    const t = e.curve?.type || 'line';
    edgesByType[t] = (edgesByType[t] || 0) + 1;
  }

  if (failures.length) return { failures, strips, hard: false };

  return {
    failures, strips, hard: false,
    brep: { vertices, edges, faces },
    facesByType, edgesByType,
  };
}

// Analytische Regionen, die eine Facette berühren (Kandidaten für den Täter)
function analyticTouching(mesh, wr, wLabel, regions, incident) {
  const out = new Set();
  const { tri, nV } = mesh;
  const t = wr.tris[0];
  // Nachbardreiecke über die Kanten
  for (let k = 0; k < 3; k++) {
    const i = tri[3 * t + k], j = tri[3 * t + (k + 1) % 3];
    const lo = i < j ? i : j, hi = i < j ? j : i;
    const faces = mesh.edgeFaces.get(lo * nV + hi);
    if (!faces) continue;
    for (const f of faces) {
      if (f === t) continue;
      const o = regions[wLabel[f]];
      if (o && o.kind === 'analytic') out.add(o);
    }
  }
  // Regionen an den Ecken
  for (let k = 0; k < 3; k++) {
    const mv = tri[3 * t + k];
    const ids = incident.get(mv) || new Set();
    for (const id of ids) {
      const o = regions[id];
      if (o && o.kind === 'analytic') out.add(o);
    }
  }
  return [...out];
}

// ─────────────────────────────────────────────────────────────────────────────
// Streifen-Demotion (statt ganzer Region zur Fassade)
// ─────────────────────────────────────────────────────────────────────────────

// Kantenverbundene Komponenten einer Dreiecksmenge
function triComponents(mesh, tris) {
  const { tri, nV } = mesh;
  const edgeMap = new Map();
  for (const t of tris) {
    for (let k = 0; k < 3; k++) {
      const i = tri[3 * t + k], j = tri[3 * t + (k + 1) % 3];
      const key = i < j ? i * nV + j : j * nV + i;
      let a = edgeMap.get(key);
      if (!a) { a = []; edgeMap.set(key, a); }
      a.push(t);
    }
  }
  const parent = new Map();
  for (const t of tris) parent.set(t, t);
  const find = (x) => {
    const p = parent.get(x);
    if (p === undefined || p === x) return x;
    const r = find(p);
    parent.set(x, r);
    return r;
  };
  const union = (a, b) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  };
  for (const arr of edgeMap.values()) {
    for (let i = 1; i < arr.length; i++) union(arr[0], arr[i]);
  }
  const groups = new Map();
  for (const t of tris) {
    const r = find(t);
    let g = groups.get(r);
    if (!g) { g = []; groups.set(r, g); }
    g.push(t);
  }
  return [...groups.values()];
}

// Streifen einer Region demoten: nur die Dreiecke, die einen der beteiligten
// Netzecken berühren, werden Facetten. Der Rest der Region behält seine
// (unveränderte) gefittete Fläche; fällt er in mehrere kantenverbundene Teile,
// bleibt der größte, der Rest wird Fassade.
function applyStrip(state, mesh, srcId, mvSet, round, log) {
  const r = state.segById.get(srcId);
  if (!r) return;
  const { tri, A } = mesh;
  const cut = new Set();
  for (const t of r.tris) {
    for (let k = 0; k < 3; k++) {
      if (mvSet.has(tri[3 * t + k])) { cut.add(t); break; }
    }
  }
  const rest = r.tris.filter((t) => !cut.has(t) && !state.stripTris.has(t));
  const comps = triComponents(mesh, rest);
  let extra = [];
  if (comps.length > 1) {
    const areaOf = (arr) => { let s = 0; for (const t of arr) s += A[t]; return s; };
    comps.sort((a, b) => areaOf(b) - areaOf(a));
    for (let i = 1; i < comps.length; i++) extra = extra.concat(comps[i]);
  }
  let added = 0;
  for (const t of cut) if (!state.stripTris.has(t)) { state.stripTris.add(t); added++; }
  for (const t of extra) if (!state.stripTris.has(t)) { state.stripTris.add(t); added++; }
  let rounds = state.stripRounds.get(srcId);
  if (!rounds) { rounds = new Set(); state.stripRounds.set(srcId, rounds); }
  if (added > 0) rounds.add(round);
  // Eskalation: 3 Runden mit Streifen → die ganze Region wird Fassade
  if (added > 0 && rounds.size >= STRIP_ROUNDS_MAX && !state.demotedRegions.has(srcId)) {
    state.demotedRegions.add(srcId);
    for (const t of r.tris) if (!state.stripTris.has(t)) { state.stripTris.add(t); added++; }
  }
  if (log) {
    log.push(`Runde ${round}: Region ${srcId} gestreift — ${added} Dreiecke zur Fassade, `
      + `${rounds.size}/${STRIP_ROUNDS_MAX} Runden`);
  }
}

// Regionen, die ganz zur Fassade wurden
function countDemoted(seg, state) {
  let n = 0;
  for (const r of seg.regions) {
    if (r.type === 'facet') continue;
    let all = true;
    for (const t of r.tris) if (!state.stripTris.has(t)) { all = false; break; }
    if (all) n++;
  }
  return n;
}

// Netzecken einer Region
function regionVertices(mesh, wr) {
  const { tri } = mesh;
  const out = new Set();
  for (const t of wr.tris) for (let k = 0; k < 3; k++) out.add(tri[3 * t + k]);
  return out;
}

// Netzecken der Ketten einer Schleife
function chainMeshVertices(mesh, topo, chainIds) {
  const out = new Set();
  for (const cid of (chainIds || [])) {
    const ch = topo.chains[cid];
    if (!ch) continue;
    for (const mv of ch.mv) out.add(mv);
  }
  return out;
}

// Netzecken einer Topologie-Schleife
function loopMeshVertices(mesh, topo, lp) {
  return chainMeshVertices(mesh, topo, lp.uses.map((u) => u.chain));
}

// Länge des Kettenpolylines (Netzpunkte) von p nach q
function chainPolyLen(mesh, ch, p, q) {
  let L = 0;
  let prev = p;
  for (let i = 1; i < ch.mv.length - 1; i++) {
    const m = ptOf(mesh, ch.mv[i]);
    L += len(sub(m, prev));
    prev = m;
  }
  L += len(sub(q, prev));
  return L;
}

// ─────────────────────────────────────────────────────────────────────────────
// Kreisbogen: der positive Bogen p→q darf nicht "lang herum" laufen
// ─────────────────────────────────────────────────────────────────────────────

// Winkel eines Punktes um die Achse a, gemessen von x aus (0..2π)
function angAround(x, a, centre, pt) {
  const v = sub(pt, centre);
  let th = Math.atan2(dot(cross(x, v), a), dot(x, v));
  if (th < 0) th += 2 * Math.PI;
  return th;
}

// Punkt auf einem Kreis (Parameter θ) — Rechtssystem wie im STEP:
// die Umkreisrichtung ist (x, a×x, a), der Parameter läuft mit der Achse a
function circlePoint(c, th) {
  const side = norm(cross(c.a, c.x));
  return add(c.c, add(mul(c.x, c.R * Math.cos(th)), mul(side, c.R * Math.sin(th))));
}

// Länge des positiven Bogens p→q
function circleArcLen(c, p, q) {
  const a0 = angAround(c.x, c.a, c.c, p);
  let d = angAround(c.x, c.a, c.c, q) - a0;
  while (d <= 1e-12) d += 2 * Math.PI;
  return d * c.R;
}

// Läuft der positive Bogen p→q "lang herum"? → Achse spiegeln (x zeigt weiter auf p)
function fixCircleArc(c, p, q, polyLen) {
  if (!c || c.type !== 'circle' || !(c.R > 0)) return c;
  const arc = circleArcLen(c, p, q);
  const comp = 2 * Math.PI * c.R - arc;
  if (arc > 1.5 * polyLen + 1e-9 && Math.abs(comp - polyLen) < Math.abs(arc - polyLen)) {
    return Object.assign({}, c, { a: mul(c.a, -1) });
  }
  return c;
}

// ─────────────────────────────────────────────────────────────────────────────
// Entartete Flächen (Schleife ohne Flächeninhalt)
// ─────────────────────────────────────────────────────────────────────────────

// Stichproben einer Kante (von v0 nach v1)
function sampleEdge(e, vertices) {
  const c = e.curve || {};
  const p0 = vertices[e.v0], p1 = vertices[e.v1];
  if (!p0 || !p1) return [];
  if (c.type === 'circle' && c.c && c.a && c.x && c.R > 0) {
    const out = [];
    const a0 = angAround(c.x, c.a, c.c, p0);
    let d = angAround(c.x, c.a, c.c, p1) - a0;
    while (d <= 1e-12) d += 2 * Math.PI;
    for (let i = 0; i <= 8; i++) out.push(circlePoint(c, a0 + (d * i) / 8));
    return out;
  }
  if (c.type === 'bspline' && c.ctrl) {
    const out = [];
    for (let i = 0; i <= 8; i++) out.push(evalBspline(c, i / 8));
    return out;
  }
  return [p0, p1];
}

// Polygonzug einer Schleife (Eckpunkte + Stichproben der Kurven)
function loopPolygon(edges, uses, vertices) {
  const pts = [];
  for (const u of uses) {
    const e = edges[u.edge];
    if (!e) continue;
    const seg = sampleEdge(e, vertices);
    const arr = u.fwd === false ? seg.slice().reverse() : seg;
    for (const p of arr) {
      const last = pts[pts.length - 1];
      if (!last || len(sub(last, p)) > 1e-12) pts.push(p);
    }
  }
  return pts;
}

// Flächeninhalt einer Schleife (bei Ebenen: projiziert auf die Flächenebene)
function faceArea(pts, surf) {
  if (!pts || pts.length < 3) return 0;
  let ax = 0, ay = 0, az = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    ax += a[1] * b[2] - a[2] * b[1];
    ay += a[2] * b[0] - a[0] * b[2];
    az += a[0] * b[1] - a[1] * b[0];
  }
  if (surf && surf.type === 'plane' && surf.n) {
    return 0.5 * (ax * surf.n[0] + ay * surf.n[1] + az * surf.n[2]);
  }
  return 0.5 * Math.hypot(ax, ay, az);
}

// Entartete Schleife einer Fläche? (kein Flächeninhalt, zwei Geraden oder ein
// Außenrand, der verkehrt herum läuft)
function degenerateLoop(loops, edges, vertices, surf, sameSense) {
  for (const lp of loops) {
    if (lp.uses.length === 2) {
      const lines = lp.uses.every((u) => {
        const e = edges[u.edge];
        return e && e.curve && e.curve.type === 'line';
      });
      if (lines) return { why: 'Schleife aus 2 Geraden', chains: lp.chains };
    }
    const area = faceArea(loopPolygon(edges, lp.uses, vertices), surf);
    if (!(Math.abs(area) >= 1e-8)) {
      return { why: `Schleife ohne Flächeninhalt (${area.toExponential(2)} mm²)`, chains: lp.chains };
    }
  }
  // Ebenen: der Außenrand (größter projizierter Flächeninhalt) muss gegen den
  // Uhrzeigersinn um die effektive Normale laufen — sonst ist die Fläche falsch
  if (surf && surf.type === 'plane') {
    let big = -1, bigA = -1;
    loops.forEach((lp, i) => {
      const a = Math.abs(faceArea(loopPolygon(edges, lp.uses, vertices), surf));
      if (a > bigA) { bigA = a; big = i; }
    });
    if (big >= 0) {
      const a = faceArea(loopPolygon(edges, loops[big].uses, vertices), surf);
      const signed = sameSense ? a : -a;
      if (signed < 0) {
        return { why: `Außenrand läuft verkehrt herum (${a.toFixed(3)} mm²)`, chains: loops[big].chains };
      }
    }
  }
  return null;
}

// Analytische Regionen, die eine Fläche berühren
function analyticNeighbours(topo, regions, wr, chainIds) {
  const out = new Set();
  if (wr && wr.kind === 'analytic') out.add(wr);
  for (const cid of (chainIds || [])) {
    const ch = topo.chains[cid];
    if (!ch) continue;
    for (const id of [ch.L, ch.R]) {
      const o = regions[id];
      if (o && o.kind === 'analytic') out.add(o);
    }
  }
  return [...out];
}

// Platzierungshinweise für den STEP-Schreiber: Bezugsrichtung x (Parametrisierungsnaht)
// auf die abgewandte Seite der Region legen, Achse/Höhe der Fläche setzen
function placementHint(wr, surf, mesh) {
  if (!surf) return;
  const { A } = mesh;
  if (surf.type === 'cylinder' || surf.type === 'cone' || surf.type === 'torus') {
    // mittlere radiale Richtung (flächengewichtet) → x zeigt davon weg
    const base = surf.type === 'cone' ? surf.apex : (surf.type === 'torus' ? surf.c : surf.o);
    let rx = 0, ry = 0, rz = 0;
    for (const t of wr.tris) {
      const c = centroidOf(mesh, t);
      const w = sub(c, base);
      const h = dot(w, surf.a);
      const rad = sub(w, mul(surf.a, h));
      const wgt = A[t];
      rx += rad[0] * wgt; ry += rad[1] * wgt; rz += rad[2] * wgt;
    }
    const m = norm([rx, ry, rz]);
    if (len(m) > 1e-9) surf.x = mul(m, -1);
    if (surf.type === 'cone') {
      // mittlere axiale Höhe der Eckpunkte (Abstand Spitze → Platzierungsebene)
      let sum = 0, cnt = 0;
      const seen = new Set();
      for (const t of wr.tris) {
        for (let k = 0; k < 3; k++) {
          const mv = mesh.tri[3 * t + k];
          if (seen.has(mv)) continue;
          seen.add(mv);
          sum += dot(sub(ptOf(mesh, mv), surf.apex), surf.a);
          cnt++;
        }
      }
      if (cnt) surf.h0 = sum / cnt;
    }
  } else if (surf.type === 'sphere') {
    // mittlere Auswärtsnormale der Region → Achse ⟂ dazu, x = −m
    let mx = 0, my = 0, mz = 0;
    for (const t of wr.tris) {
      const w = A[t];
      mx += mesh.N[3 * t] * w; my += mesh.N[3 * t + 1] * w; mz += mesh.N[3 * t + 2] * w;
    }
    const m = norm([mx, my, mz]);
    if (len(m) > 1e-9) {
      const helper = Math.abs(m[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
      const ax = norm(cross(m, helper));
      surf.axis = ax;
      const proj = sub(m, mul(ax, dot(m, ax)));
      const pj = norm(proj);
      surf.x = len(pj) > 1e-9 ? mul(pj, -1) : mul(m, -1);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Freiform-Pfad wählen (Schalter analysis.fitSegmentation: 'auto' | true | false)
// ─────────────────────────────────────────────────────────────────────────────
export function chooseFreeform(analysis, legacy) {
  const mode = analysis?.fitSegmentation ?? 'auto';
  if (mode === false) return legacy;
  const groups = analysis?.normalGroups || [];
  let T = 0;
  for (const g of groups) T += Math.floor((g?.vertices?.length || 0) / 3);
  // 'auto': nur der bisherige Weg, solange er nicht auffällig viele Flächen liefert
  if (mode === 'auto' && !(legacy && legacy.report
    && legacy.report.faceCount >= 5000 && legacy.report.faceCount >= 0.1 * T)) return legacy;
  const ff = buildFreeformBrep(groups, {});
  if (!ff) {
    if (legacy?.report) legacy.report.freeform = { used: false, tried: true };
    return legacy;
  }
  // 'auto': nur nehmen, wenn deutlich weniger Flächen
  if (mode === 'auto' && legacy?.report && ff.report.faceCount > 0.6 * legacy.report.faceCount) {
    legacy.report.freeform = { used: false, tried: true, faceCount: ff.report.faceCount };
    return legacy;
  }
  return ff;
}

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
//
// Fehlerarten (Rundebilanz in opts.debug.log, eine Zeile je Runde):
//   vertex           Projektion einer Ecke ungenau (Rest > VERT_TOL)
//   chain:<grund>    Schnittkurve einer Kette gescheitert (fehlt/shift/maxPts/…)
//   degenerate       entartete Facette oder entartete Schleife
//   orientation      Vorzeichen der Flächennormale zu schwach
//
// Täterwahl: Eckenfehler → kleinste analytische NICHT-Ebene unter den beteiligten
// Regionen (sonst die kleinste analytische), Streifen = Ecke + 1-Ring; entartete
// Facette → kleinste Region, die die Eckbedingungen des Dreiecks besitzt; Kante →
// nicht-ebene Region bevorzugt. Findet sich KEINE analytische Region direkt, wird
// die Umgebung gesucht: analytische Regionen, deren Dreiecke Netzecken im 2-Ring
// (sonst 3-Ring) um den Fehler berühren, werden gestreift. Erst wenn dort auch
// nichts ist, wird abgebrochen (kein stilles Scheitern an einer einzelnen Fläche).
//
// Optionen: opts.maxRounds (Standard 12), opts.debug.log (Rundenbilanz),
//   opts.timeBudgetMs (Standard 6000 ms — Abbruch, wenn überschritten),
//   opts.maxFacetShare (Standard 0.25 — Anteil der zu Facetten demotierten
//   Dreiecke, ab dem der Versuch aussichtslos ist: das Ergebnis könnte den
//   bisherigen Weg nie schlagen),
//   opts.testForceChainFail / opts.testForceVertexFail (Testschalter, je einmal).
// ─────────────────────────────────────────────────────────────────────────────
import { trianglesFromGroups, indexMesh, segmentByFit } from './freeform-segment.js';
import { buildTopology, checkTopology } from './freeform-topology.js';
import {
  normalAt, projectMulti, fitIntersectionCurve, evalBspline,
  add, sub, mul, dot, cross, len, norm, project,
} from './freeform-geom.js';
import { snapSurfaces } from './freeform-snap.js';
import { writeFreeformStep } from './freeform-step.js';
import {
  lineToBspline, evalCurve, reverseCurve, splitCurve, joinCurves, coonsPatch,
  surfaceNormal, surfaceDerivs, projectToSurface, surfaceSamples, evalSurface,
  fitCurveOnSurface, interpPolyline,
} from './freeform-nurbs.js';

// ---- Grenzwerte (Etappe 1) ----
const ROUNDS_MAX = 12;           // höchstens 12 Runden (Standard; opts.maxRounds)
const TIME_BUDGET_MS = 6000;     // Zeitbudget je Versuch (ms; opts.timeBudgetMs)
const FACET_SHARE_MAX = 0.25;    // Anteil der zu Facetten demotierten Dreiecke (opts.maxFacetShare)
const CHECK_EVERY = 200;         // Zeitprüfung alle CHECK_EVERY Netzecken bzw. Ketten
const NEIGH_RING = 2;            // Ringe um einen Fehler: analytische Regionen suchen
const NEIGH_RING_MAX = 3;        // erst danach aufgeben (kein Abbruch, solange etwas da ist)
const STRIP_ROUNDS_MAX = 3;      // 3 Runden mit Streifen → Region ganz zur Fassade
const SEG_ANGLE_DEG = 12;        // Segmentierwinkel
const SENSE_MIN = 0.8;           // |flächengewichtetes Vorzeichen| je Region
const COLLAPSE_EPS = 1e-6;       // Kante fällt weg (Punktkontakt)
const FIT_TOL = 5e-7;            // Toleranz der Schnittkurve (B-Spline)
const EDGE_MAX_SHIFT = 0.5;      // größte Verschiebung eines Stützpunkts
const VERT_TOL = 1e-9;           // Rest der Eckprojektion (mm) — Ecken liegen exakt auf allen Flächen (ACIS 1e-6)
const VERT_TOL_BLEND = 1e-6;     // Rest bei Ecken MIT Blend-Nachbarn (mm): ohne die
// Fit-Fläche der Blend-Region ist die Projektion auf die beiden analytischen
// Nachbarn entartet (die Flächen sind tangential) — der Rest bleibt in der
// Fit-Genauigkeit (~1e-7 mm). Weit unter der STEP-Unsicherheit (1e-4 mm).

// ---- Blend-Patches (Teil-Rückfall, Etappe 1b) ----
// Eine Verrundungs-Region, deren gefittete Fläche ihre Nachbarn nicht exakt
// trifft, wird zu EINER B-Spline-Fläche (Coons-Patch über den Randkurven) —
// statt zu lauter Einzel-Facetten. Der Rückfall "Region ganz zur Fassade"
// bleibt, wenn der Patch nicht gelingt.
const BLEND_MAX_R = 3;            // mm — Radius (Zylinder/Kugel R, Torus r) bis zu dem eine Region als Blend taugt
const BLEND_MAX_AREA = 20;        // mm² — Fläche bis zu der eine Region (jeder Art) als Blend taugt
const BLEND_TOL_ABS = 0.05;       // mm — Mindestabstand Netzecke ↔ Blendfläche
const BLEND_TOL_REL = 0.12;       // × Durchmesser der Region (Mindestabstand).
// Der Coons-Patch nähert einen Randbogen von 90° nur mit ~10 % des
// Durchmessers genau (Sehnen-Sagitta) — der Anteil muss größer sein als der
// reine Fit-Rest, sonst fällt jede Kugelecke (dreiseitiges Patch) durch.
const BLEND_CORNER_DEG = 30;      // Grad — Wendepunkt eines Blendrands zählt als Ecke
const BLEND_SENSE_MIN = 0.8;      // |flächengewichtetes Vorzeichen| der Blendfläche
const BLEND_GRID = 6;             // 6×6 Stützstellen im Inneren (Normalentest)
// Arbeitsgrenzen je Patch (damit ein Patch nie unbegrenzt teuer wird):
const BLEND_MAX_CTRL = 400;       // Stützpunkte je Patch-Seite / Kontrollnetz-Richtung
const BLEND_MAX_NET = 40000;      // Stützpunkte im Kontrollnetz (Schreiber-Ausgabe!)
const BLEND_MAX_SAMPLES = 200;    // geprüfte Netzecken je Patch (gleichmäßige Stichprobe)
const BLEND_PROJ_ITERS = 25;      // Newton-Schritte je Projektion (Startwert aus dem Gitter)
const BLEND_SAMPLES_N = 8;        // 8×8 Gitterpunkte als Startwert der Projektion
const BLEND_CORNER_TRIES = 1;     // Eckensätze je Blend-Patch. Mehr (Alternativen aus den 6 schärfsten Knicken)
// rettete am Skoda Regionen, erzeugte aber OCP-ungültige Patches (3 Flächen, 61 Selbstschnitte) → aus
const BLEND_FOLD_COS = 0;         // Patch-Normale ↔ Netznormale: kleiner → Faltung (Patch verworfen)
const BLEND_EDGE_TOL = 2e-7;      // mm — Randstück ↔ Patch-Fläche (strenge Importer: 1e-6)
const BLEND_CHECK_EVERY = 16;     // Zeitprüfung alle BLEND_CHECK_EVERY Stichproben

const now = () => (globalThis.performance && globalThis.performance.now)
  ? globalThis.performance.now() : Date.now();

// Zeitmessung je Abschnitt (landet nur im Debug-Log als Zeile "ZEIT {…}")
let TIME = null;
function tm(key, t0) {
  if (!TIME) return;
  TIME[key] = (TIME[key] || 0) + (now() - t0);
}
function tmCount(key, n) {
  if (!TIME) return;
  TIME[key] = (TIME[key] || 0) + n;
}
function tmMax(key, n) {
  if (!TIME) return;
  TIME[key] = Math.max(TIME[key] || 0, n);
}

// Zeitbudget überschritten? (jetzt − Start des Versuchs ≥ Budget)
function budgetExceeded(state) {
  return now() - state.t0 >= state.budgetMs;
}

// Zu viele Dreiecke zu Facetten demotiert → das Ergebnis kann den bisherigen
// Weg nie schlagen (jedes Facett ist eine eigene Fläche) → sinnlos weiterlaufen
function hopeless(state, mesh) {
  return state.stripTris.size > state.shareMax * mesh.T;
}

// Protokollzeile: Zeitbudget überschritten
function logBudget(log, state) {
  if (log) {
    log.push(`Zeitbudget überschritten (${Math.round(now() - state.t0)} ms `
      + `> ${state.budgetMs} ms) → Abbruch`);
  }
}

// Protokollzeile: hoffnungslos (zu viele Facetten)
function logHopeless(log, state, mesh) {
  if (!log) return;
  const anteil = mesh.T > 0 ? (100 * state.stripTris.size) / mesh.T : 0;
  log.push(`Hoffnungslos: ${state.stripTris.size} von ${mesh.T} Dreiecken zu Facetten `
    + `demotiert (${anteil.toFixed(0)} % > ${(100 * state.shareMax).toFixed(0)} %) → Abbruch`);
}

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

// Kleinste analytische NICHT-Ebene unter den Kandidaten (sonst die kleinste
// analytische): Eckenfehler stammen fast immer von gekrümmten Flächen
function pickSmallestNonPlane(cands) {
  let best = null;
  for (const c of cands) {
    if (!c || c.kind !== 'analytic' || !c.surf) continue;
    if (c.surf.type === 'plane') continue;
    if (!best || c.area < best.area) best = c;
  }
  return best || pickSmallestAnalytic(cands);
}

// ─────────────────────────────────────────────────────────────────────────────
// Nachbarschaft im Netz (Ringe über die Dreieckskanten) — Umgebungssuche
// ─────────────────────────────────────────────────────────────────────────────

// Adjazenz Ecke → Nachbarecken (jede Dreieckskante verbindet zwei Ecken)
function buildVertexAdjacency(mesh) {
  const { tri, T } = mesh;
  const adj = new Map();
  const link = (a, b) => {
    let l = adj.get(a);
    if (!l) { l = new Set(); adj.set(a, l); }
    l.add(b);
  };
  for (let t = 0; t < T; t++) {
    const i0 = tri[3 * t], i1 = tri[3 * t + 1], i2 = tri[3 * t + 2];
    link(i0, i1); link(i1, i0);
    link(i1, i2); link(i2, i1);
    link(i2, i0); link(i0, i2);
  }
  return adj;
}

// Netzecken im Umkreis von seed (rings Schritte über die Dreieckskanten)
function vertexNeighbourhood(adj, seed, rings) {
  const cur = new Set(seed);
  let front = [...cur];
  for (let r = 0; r < rings && front.length; r++) {
    const next = [];
    for (const v of front) {
      const l = adj.get(v);
      if (!l) continue;
      for (const w of l) if (!cur.has(w)) { cur.add(w); next.push(w); }
    }
    front = next;
  }
  return cur;
}

// Analytische Regionen in der Umgebung der Netzecken (Ringe) + die Ecken selbst
function analyticNear(adj, incident, regions, seed, rings) {
  const verts = vertexNeighbourhood(adj, seed, rings);
  const found = new Map();          // Region → eine ihrer Ecken
  for (const mv of verts) {
    const ids = incident.get(mv);
    if (!ids) continue;
    for (const id of ids) {
      const w = regions[id];
      if (w && w.kind === 'analytic' && !found.has(w)) found.set(w, mv);
    }
  }
  return { regions: [...found.keys()], verts };
}

// Analytische Regionen an den Ecken eines Dreiecks (Eckenzuständigkeit):
// sie besitzen die Eckbedingungen, an denen das Dreieck entartet sein kann
function analyticAtVertices(mesh, wr, incident, regions) {
  const { tri } = mesh;
  const t = wr.tris[0];
  const found = new Map();          // Region → Netzecke
  for (let k = 0; k < 3; k++) {
    const mv = tri[3 * t + k];
    const ids = incident.get(mv);
    if (!ids) continue;
    for (const id of ids) {
      const w = regions[id];
      if (w && w.kind === 'analytic' && !found.has(w)) found.set(w, mv);
    }
  }
  return found;
}

// Zylinder/Kugel-Paar (Testschalter)
function isCylSphere(A, B) {
  const ta = A && A.type, tb = B && B.type;
  return (ta === 'cylinder' && tb === 'sphere') || (ta === 'sphere' && tb === 'cylinder');
}

// ─────────────────────────────────────────────────────────────────────────────
// Blend-Patches (Etappe 1b)
//
// Eine Region, die als "Blend" behandelt wird, bekommt keine analytische
// Fläche mehr: sie wird zu EINER B-Spline-Fläche (Coons-Patch), deren Rand
// die exakten Randkurven der Region enthält. Damit fällt der Rückfall
// "Streifen → Facetten" für kleine Verrundungen weg.
//
// Datenmodell der Blend-Region (Arbeitsregion):
//   { kind:'blend', type, tris (alle Dreiecke der Region), area, src, surf:null }
// Die Fläche (surf) entsteht erst beim Flächenbau (Schritt i).
// ─────────────────────────────────────────────────────────────────────────────

// Darf die Segmentierungs-Region als Blend (B-Spline-Patch) behandelt werden?
// Verrundungen bis BLEND_MAX_R und kleine Flächen (jede Art) taugen als Blend.
function blendEligible(r) {
  if (!r) return false;
  let R = null;
  if (r.type === 'cylinder' || r.type === 'sphere') R = r.surf ? r.surf.R : null;
  else if (r.type === 'torus') R = r.surf ? r.surf.r : null;
  if (R !== null && Number.isFinite(R) && R <= BLEND_MAX_R) return true;
  return Number.isFinite(r.area) && r.area <= BLEND_MAX_AREA;
}

// Domäne einer B-Spline-Kurve
function curveDomain(c) {
  return [c.knots[0], c.knots[c.knots.length - 1]];
}

// Tangente einer B-Spline-Kurve (numerisch, zentral)
function curveTangent(c, u) {
  const [a, b] = curveDomain(c);
  const h = Math.min(1e-4, Math.max(1e-9, (b - a) * 1e-3));
  const u0 = Math.max(a, u - h), u1 = Math.min(b, u + h);
  const t = sub(evalCurve(c, u1), evalCurve(c, u0));
  const l = len(t);
  return l > 1e-14 ? mul(t, 1 / l) : [0, 0, 0];
}

// Länge des Kontrollpolygons (wie in freeform-nurbs.js — die Stückgrenzen
// der joinCurves rechnen mit genau diesen Längen)
function ctrlPolyLen(c) {
  let L = 0;
  for (let i = 1; i < c.ctrl.length; i++) L += len(sub(c.ctrl[i], c.ctrl[i - 1]));
  return L;
}

// Die Randstücke einer Schleife als B-Spline-Stücke (in Laufrichtung der
// Schleife). Kreisbögen sind hier nicht erlaubt (Patch-Fehler), Geraden werden
// mit lineToBspline in B-Splines überführt.
function loopPieces(uses, edges, vertices) {
  const out = [];
  for (const u of uses) {
    const e = edges[u.edge];
    if (!e || !e.curve) return null;
    const c = e.curve;
    if (c.type === 'circle') return null;
    if (c.type === 'line') {
      const p0 = vertices[e.v0], p1 = vertices[e.v1];
      if (!p0 || !p1) return null;
      out.push(u.fwd === false ? lineToBspline(p1, p0) : lineToBspline(p0, p1));
    } else if (c.type === 'bspline') {
      const cc = {
        type: 'bspline', degree: c.degree, ctrl: c.ctrl.map((p) => p.slice()),
        knots: c.knots.slice(), mults: c.mults.slice(),
      };
      if (c.params) cc.params = c.params.slice();
      out.push(u.fwd === false ? reverseCurve(cc) : cc);
    } else return null;
  }
  return out.length ? out : null;
}

// Geschlossene Randkurve einer Blend-Region + die Parameter der Stückgrenzen
// (joints[k] = Übergang vom Stück k−1 zum Stück k; joints[0] = joints[n] = 0/1
// ist der Übergang vom letzten zum ersten Stück).
function closedBoundary(pieces) {
  const C = joinCurves(pieces);
  if (!C) return null;
  const lens = pieces.map(ctrlPolyLen);
  const total = lens.reduce((x, y) => x + y, 0);
  const s = [0];
  for (let k = 0; k < pieces.length; k++) {
    s.push(total > 0 ? s[k] + lens[k] / total : (k + 1) / pieces.length);
  }
  return { curve: C, joints: s };
}

// Bogenlängen-Messung auf der geschlossenen Kurve (gleichmäßige Abtastung)
function arcSampler(C, n = 400) {
  const [a, b] = curveDomain(C);
  const pts = [];
  for (let i = 0; i <= n; i++) pts.push(evalCurve(C, a + ((b - a) * i) / n));
  const cum = [0];
  for (let i = 1; i <= n; i++) cum.push(cum[i - 1] + len(sub(pts[i], pts[i - 1])));
  const total = cum[n];
  // Bogenlänge am Parameter u
  const at = (u) => {
    const t = Math.min(1, Math.max(0, (u - a) / (b - a || 1)));
    const x = t * n;
    const i = Math.min(n - 1, Math.floor(x));
    const f = x - i;
    return cum[i] + (cum[i + 1] - cum[i]) * f;
  };
  // Parameter zur Bogenlänge s
  const paramAt = (s) => {
    if (s <= 0) return a;
    if (s >= total) return b;
    let i = 1;
    while (i < n && cum[i] < s) i++;
    const seg = cum[i] - cum[i - 1];
    const f = seg > 1e-15 ? (s - cum[i - 1]) / seg : 0;
    return a + ((i - 1 + f) * (b - a)) / n;
  };
  return { total, at, paramAt };
}

// Die geschlossene Kurve an den Ecken-Parametern in Bögen zerlegen (die Bögen
// in der Reihenfolge des Umlaufs: Bogen i von ps[i] nach ps[i+1], der letzte
// Bogen schließt den Ring). ps = aufsteigende Parameter; ps[0] darf der Anfang
// der Domäne sein (der Übergang letztes → erstes Stück).
function splitClosed(C, ps) {
  const [a] = curveDomain(C);
  const n = ps.length;
  if (n < 2) return null;
  const hasWrap = Math.abs(ps[0] - a) < 1e-12;
  const arcs = new Array(n - 1);
  let cur = C;                      // Rest: [a … ps[i]]
  let wrap = null;                  // der Bogen ps[n−1] → b (≡ a)
  for (let i = n - 1; i >= 1; i--) {
    const sp = splitCurve(cur, ps[i]);
    if (!sp) return null;
    if (i === n - 1) wrap = sp[1];
    else arcs[i] = sp[1];
    cur = sp[0];
  }
  if (hasWrap) {
    arcs[0] = cur;                  // [a … ps[1]]
  } else {
    const sp = splitCurve(cur, ps[0]);
    if (!sp) return null;
    arcs[0] = sp[1];                // [ps[0] … ps[1]]
    wrap = joinCurves([wrap, sp[0]]);
    if (!wrap) return null;
  }
  arcs.push(wrap);                  // [ps[n−1] → a ≡ ps[0]]
  return arcs;
}

// Innere Knotenvielfachheit ≤ Grad? (strenge Importer verlangen das)
function multsOk(knots, mults, degree) {
  for (let i = 1; i < knots.length - 1; i++) {
    if ((mults[i] || 0) > degree) return false;
  }
  return true;
}

// Normale an einem Punkt der Fläche. Ist die Stelle entartet (z. B. die
// Punktseite eines dreiseitigen Patches), wird der nächstgelegene Punkt mit
// gültiger Normale genommen.
function normalNear(surf, u, v) {
  const n = surfaceNormal(surf, u, v);
  if (n) return n;
  const du = (surf.knotsU[surf.knotsU.length - 1] - surf.knotsU[0]) * 1e-2;
  const dv = (surf.knotsV[surf.knotsV.length - 1] - surf.knotsV[0]) * 1e-2;
  for (const [uu, vv] of [[u + du, v], [u, v + dv], [u + du, v + dv], [u + du / 10, v + dv / 10]]) {
    const m = surfaceNormal(surf, uu, vv);
    if (m) return m;
  }
  return null;
}

// Blend-Patch einer Region bauen:
//   Randkurven → geschlossene Kurve → Ecken (Wendepunkte) → Coons-Patch →
//   Prüfungen (Abstand der Netzpunkte, Normale, Sinn).
// Rückgabe { surf, sameSense } | { fail: Grund } | { hard: true } (Zeitbudget).
function buildBlendPatch(wr, uses, edges, vertices, mesh, state) {
  const { N, A } = mesh;
  const tStart = now();
  let t = tStart;
  if (state && budgetExceeded(state)) return { hard: true };
  const pieces = loopPieces(uses, edges, vertices);
  if (!pieces) return { fail: 'Randkurve' };
  // Rand zu aufwendig? (die geschlossene Randkurve bekommt alle Stützpunkte
  // der Randkanten; das Coons-Netz wächst dann quadratisch mit)
  let nCtrl = 0;
  for (const c of pieces) nCtrl += c.ctrl.length;
  if (nCtrl > 4 * BLEND_MAX_CTRL) return { fail: `Rand zu lang (${nCtrl} Stützpunkte)` };
  const cb = closedBoundary(pieces);
  if (!cb) {
    // Diagnose: größte Lücke zwischen aufeinanderfolgenden Stücken
    let gap = 0;
    for (let k = 0; k < pieces.length; k++) {
      const a = pieces[k], b = pieces[(k + 1) % pieces.length];
      gap = Math.max(gap, len(sub(evalCurve(a, curveDomain(a)[1]), evalCurve(b, curveDomain(b)[0]))));
    }
    return { fail: `geschlossene Kurve (Stücke ${pieces.length}, größte Lücke ${gap.toExponential(2)} mm)` };
  }
  tm('blend.boundary', t); t = now();
  if (state && budgetExceeded(state)) return { hard: true };
  const C = cb.curve;
  const joints = cb.joints;
  const n = pieces.length;
  // Wendepunkte an den Stückgrenzen (B-rep-Ecken des Rands)
  const cands = [];
  for (let k = 0; k < n; k++) {
    const prev = pieces[(k - 1 + n) % n], cur = pieces[k];
    const tIn = curveTangent(prev, curveDomain(prev)[1]);
    const tOut = curveTangent(cur, curveDomain(cur)[0]);
    const c = Math.max(-1, Math.min(1, dot(tIn, tOut)));
    cands.push({ param: joints[k], ang: (Math.acos(c) * 180) / Math.PI });
  }
  const sharp = cands.filter((c) => c.ang > BLEND_CORNER_DEG)
    .sort((a, b) => b.ang - a.ang || a.param - b.param);
  // Eckensätze: zuerst der bisherige (die 4 schärfsten Knicke bzw. Bogenlängen-
  // Ergänzung), dann Alternativen aus den bis zu 6 schärfsten Knicken (4er-, dann
  // 3er-Kombinationen). Ein falscher Eckensatz verdreht den Coons-Patch (Faltung,
  // Sinn) — die nächste Wahl rettet die Region vor dem Facetten-Rückfall.
  const cornerSets = [];
  const firstSet = (() => {
    let corners;
    if (sharp.length >= 4) {
      corners = sharp.slice(0, 4).map((c) => c.param).sort((a, b) => a - b);
    } else if (sharp.length === 3) {
      corners = sharp.map((c) => c.param).sort((a, b) => a - b);
    } else {
      // zu wenige scharfe Ecken: weitere Ecken nach Bogenlänge ergänzen, bis
      // vier da sind (der längste Bogen wird jeweils in der Mitte geteilt)
      const sampler = arcSampler(C);
      corners = sharp.map((c) => c.param).sort((a, b) => a - b);
      let guard = 0;
      while (corners.length < 4 && guard++ < 8) {
        const m = corners.length;
        let big = null;
        for (let i = 0; i < m; i++) {
          const s0 = corners[i], s1 = corners[(i + 1) % m];
          const l0 = sampler.at(s0);
          const l1 = sampler.at(s1) + (i === m - 1 ? sampler.total : 0);
          if (!big || l1 - l0 > big.l) big = { s0, s1, l: l1 - l0, l0, l1 };
        }
        if (!big || !(big.l > 1e-9)) break;
        const mid = sampler.paramAt((((big.l0 + big.l1) / 2) % sampler.total));
        if (corners.some((p) => Math.abs(p - mid) < 1e-9)) break;
        corners.push(mid);
        corners.sort((a, b) => a - b);
      }
      if (corners.length < 3) return { fail: `nur ${corners.length} Ecken` };
    }
    return corners;
  })();
  if (firstSet && firstSet.fail) return firstSet;
  cornerSets.push(firstSet);
  {
    const top = sharp.slice(0, 6).map((c) => c.param);
    const key = (cs) => cs.map((x) => x.toFixed(12)).join('|');
    const seen = new Set([key(firstSet)]);
    const combos = (k) => {
      const out = [];
      const rec = (i, acc) => {
        if (acc.length === k) { out.push(acc.slice().sort((a, b) => a - b)); return; }
        for (let j = i; j < top.length; j++) { acc.push(top[j]); rec(j + 1, acc); acc.pop(); }
      };
      rec(0, []);
      return out;
    };
    for (const cs of combos(4)) {
      if (cornerSets.length >= BLEND_CORNER_TRIES) break;
      const k = key(cs);
      if (seen.has(k)) continue;
      seen.add(k);
      cornerSets.push(cs);
    }
  }
  const attempt = (corners) => {
    // drei Ecken → dreiseitiges Patch (eine Seite ist ein Punkt)
    const three = corners.length === 3;
    const arcs = splitClosed(C, corners);
    if (!arcs) return { fail: 'Randbögen' };
    tm('blend.arcs', t); t = now();
    if (state && budgetExceeded(state)) return { hard: true };
    // Coons-Patch: c0 = s0, d1 = s1, c1 = reverse(s2), d0 = reverse(s3)
    const c0 = arcs[0], d1 = arcs[1];
    const c1 = reverseCurve(arcs[2]);
    let d0;
    if (three) {
      // dreiseitiges Patch: die vierte Seite ist ein Punkt (Ecke C0)
      const p0 = evalCurve(arcs[0], curveDomain(arcs[0])[0]);
      d0 = lineToBspline(p0, p0);
    } else {
      d0 = reverseCurve(arcs[3]);
    }
    // Arbeitsgrenze VOR dem Coons-Patch: das Kontrollnetz ist das Produkt der
    // Stützpunktzahlen der Seiten (die Seiten sind aus vielen Randkurven
    // zusammengesetzt, ihr Knotenvektor-Vereinigungsnetz explodiert sonst).
    // Der Rand muss exakt bleiben — also wird der Patch gemeldet, nicht gerundet.
    for (const [nm, c] of [['c0', c0], ['c1', c1], ['d0', d0], ['d1', d1]]) {
      if (c.ctrl.length > BLEND_MAX_CTRL) {
        return { fail: `Seite ${nm} zu lang (${c.ctrl.length} Stützpunkte)` };
      }
    }
    const surf = coonsPatch(c0, c1, d0, d1);
    if (!surf) return { fail: 'Coons-Patch' };
    tm('blend.coons', t); t = now();
    tmCount('blend.patches', 1);
    tmMax('blend.net', surf.ctrl.length * surf.ctrl[0].length);
    tmMax('blend.side', Math.max(c0.ctrl.length, c1.ctrl.length, d0.ctrl.length, d1.ctrl.length));
    if (surf.ctrl.length * surf.ctrl[0].length > BLEND_MAX_NET) {
      return { fail: `Kontrollnetz zu groß (${surf.ctrl.length}×${surf.ctrl[0].length})` };
    }
    // strenge Importer: innere Knotenvielfachheit ≤ Grad
    if (!multsOk(surf.knotsU, surf.multsU, surf.du) || !multsOk(surf.knotsV, surf.multsV, surf.dv)) {
      return { fail: 'Knotenvielfachheit' };
    }
    // Durchmesser der Region (Bounding-Box-Diagonale der Netzpunkte)
    const mvSet = [...regionVertices(mesh, wr)];
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const mv of mvSet) {
      const p = ptOf(mesh, mv);
      for (let d = 0; d < 3; d++) {
        if (p[d] < lo[d]) lo[d] = p[d];
        if (p[d] > hi[d]) hi[d] = p[d];
      }
    }
    const diam = len(sub(hi, lo));
    const tol = Math.max(BLEND_TOL_ABS, BLEND_TOL_REL * diam);
    // Abstand der Netzpunkte zur Patch-Fläche — gleichmäßige Stichprobe
    // (höchstens BLEND_MAX_SAMPLES Ecken; der Rand bleibt exakt, nur die
    // Prüfung wird billiger). Startwert der Projektion: das grobe Gitter der
    // Fläche (einmal berechnet) statt einer eigenen Raster-Suche je Punkt.
    const samples = surfaceSamples(surf, BLEND_SAMPLES_N);
    // Rand-Probe (Sicherheitsnetz) über die PARAMETER, nicht per Projektion: die
    // Projektion auf stark ungleich parametrisierte Patches (ein Randstück belegt
    // < 1 % des Parameterbereichs, Polseite) blieb in Nebenminima hängen und meldete
    // Schein-Abstände bis 0,05 mm. Geprüft wird, was die Konstruktion verspricht:
    //  (1) jedes Randstück k liegt auf der geschlossenen Kurve C im Intervall
    //      [joints[k], joints[k+1]] (lineare Umparametrisierung, exakt);
    //  (2) die Fläche trägt ihre vier Seiten: S(u,v0)=c0(u), S(u,v1)=c1(u),
    //      S(u0,v)=d0(v), S(u1,v)=d1(v).
    {
      const sU0 = surf.knotsU[0], sU1 = surf.knotsU[surf.knotsU.length - 1];
      const sV0 = surf.knotsV[0], sV1 = surf.knotsV[surf.knotsV.length - 1];
      let worst = 0;
      for (let k = 0; k < pieces.length; k++) {
        const pc = pieces[k];
        const [a0, a1] = curveDomain(pc);
        const [ca, cb] = curveDomain(C);
        const s0 = ca + (cb - ca) * joints[k], s1 = ca + (cb - ca) * joints[k + 1];
        for (let i = 0; i <= 4; i++) {
          const t = i / 4;
          const d = len(sub(evalCurve(pc, a0 + (a1 - a0) * t), evalCurve(C, s0 + (s1 - s0) * t)));
          if (d > worst) worst = d;
        }
      }
      const sideCheck = (c, at) => {
        const [a0, a1] = curveDomain(c);
        for (let i = 0; i <= 8; i++) {
          const t = i / 8;
          const d = len(sub(evalCurve(c, a0 + (a1 - a0) * t), at(t)));
          if (d > worst) worst = d;
        }
      };
      sideCheck(c0, (t) => evalSurface(surf, sU0 + (sU1 - sU0) * t, sV0));
      sideCheck(c1, (t) => evalSurface(surf, sU0 + (sU1 - sU0) * t, sV1));
      sideCheck(d0, (t) => evalSurface(surf, sU0, sV0 + (sV1 - sV0) * t));
      sideCheck(d1, (t) => evalSurface(surf, sU1, sV0 + (sV1 - sV0) * t));
      if (!(worst <= BLEND_EDGE_TOL)) {
        return { fail: `Rand neben dem Patch (${worst.toExponential(2)} mm)` };
      }
    }
    const stepV = Math.max(1, Math.ceil(mvSet.length / BLEND_MAX_SAMPLES));
    let checked = 0;
    for (let i = 0; i < mvSet.length; i += stepV) {
      const mv = mvSet[i];
      if (checked % BLEND_CHECK_EVERY === 0 && state && budgetExceeded(state)) return { hard: true };
      checked++;
      const p = ptOf(mesh, mv);
      let r = projectToSurface(surf, p, { samples, iters: BLEND_PROJ_ITERS, tol });
      if (!(r.dist <= tol)) {
        // Startwert war schlecht → volle Suche (teuer, aber selten)
        r = projectToSurface(surf, p, { grid: 12, tol });
      }
      if (!(r.dist <= tol)) {
        return { fail: `Abstand ${r.dist.toFixed(3)} mm > ${tol.toFixed(3)} mm` };
      }
    }
    tm('blend.dist', t); t = now();
    // Normale im Inneren (BLEND_GRID×BLEND_GRID Stützstellen)
    const u0 = surf.knotsU[0], u1 = surf.knotsU[surf.knotsU.length - 1];
    const v0 = surf.knotsV[0], v1 = surf.knotsV[surf.knotsV.length - 1];
    for (let i = 0; i < BLEND_GRID; i++) {
      for (let j = 0; j < BLEND_GRID; j++) {
        const u = u0 + ((u1 - u0) * (i + 0.5)) / BLEND_GRID;
        const v = v0 + ((v1 - v0) * (j + 0.5)) / BLEND_GRID;
        if (!surfaceNormal(surf, u, v)) {
          const d = surfaceDerivs(surf, u, v);
          const l = len(cross(d.Su, d.Sv));
          return {
            fail: `entartete Normale bei u=${u.toFixed(5)} v=${v.toFixed(5)} `
              + `(|Su×Sv|=${l.toExponential(2)}, Su=[${d.Su.map((x) => x.toFixed(3))}], `
              + `Sv=[${d.Sv.map((x) => x.toFixed(3))}])`,
          };
        }
      }
    }
    tm('blend.normal', t); t = now();
    // Sinn: flächengewichtetes Vorzeichen (Netznormale ↔ Flächennormale).
    // Stichprobe (die Fläche ist glatt — der Mittelwert ändert sich nicht).
    const step = Math.max(1, Math.ceil(wr.tris.length / 64));
    let acc = 0, accA = 0;
    for (let k = 0; k < wr.tris.length; k += step) {
      const t = wr.tris[k];
      if (state && budgetExceeded(state)) return { hard: true };
      const c = centroidOf(mesh, t);
      let r = projectToSurface(surf, c, { samples, iters: BLEND_PROJ_ITERS, tol });
      if (!(r.dist <= tol)) r = projectToSurface(surf, c, { grid: 12, tol });
      const nn = normalNear(surf, r.u, r.v);
      if (!nn) return { fail: 'entartete Normale' };
      const d = dot([N[3 * t], N[3 * t + 1], N[3 * t + 2]], nn);
      acc += A[t] * (d > 0 ? 1 : d < 0 ? -1 : 0);
      accA += A[t];
    }
    const s = accA > 0 ? acc / accA : 0;
    if (!(Math.abs(s) >= BLEND_SENSE_MIN)) {
      return { fail: `Sinn ${s.toFixed(3)} (Stücke ${n}, scharfe Ecken ${sharp.length}: `
        + `${cands.map((c) => c.ang.toFixed(0)).join('/')}, Ecken ${corners.length}, Dreiecke ${wr.tris.length})` };
    }
    // Faltung (Skoda: 4 Patches falteten an einer tangentialen Kante auf ihren Nachbarn,
    // dazu BOP-Selbstschnitte): die Flächennormale (mit Sinn) muss überall — auch an den
    // vier Seiten, wo Coons-Patches am ehesten kippen — zur Netznormale des nächsten
    // Regionsdreiecks zeigen (Skalarprodukt > BLEND_FOLD_COS).
    {
      const sg = s > 0 ? 1 : -1;
      const step2 = Math.max(1, Math.ceil(wr.tris.length / 200));
      const cents = [];
      for (let k = 0; k < wr.tris.length; k += step2) cents.push(wr.tris[k]);
      const cpts = cents.map((t) => centroidOf(mesh, t));
      const su0 = surf.knotsU[0], su1 = surf.knotsU[surf.knotsU.length - 1];
      const sv0 = surf.knotsV[0], sv1 = surf.knotsV[surf.knotsV.length - 1];
      const uvs = [];
      for (let i = 0; i <= 6; i++) {
        const t = 0.04 + (0.92 * i) / 6;
        uvs.push([t, 0.02], [t, 0.98], [0.02, t], [0.98, t]);
      }
      for (let i = 1; i < 5; i++) for (let j = 1; j < 5; j++) uvs.push([i / 5, j / 5]);
      for (const [a, b] of uvs) {
        const u = su0 + (su1 - su0) * a, v = sv0 + (sv1 - sv0) * b;
        const nn = normalNear(surf, u, v);
        if (!nn) continue;
        const P = evalSurface(surf, u, v);
        let bi = -1, bd = Infinity;
        for (let k = 0; k < cpts.length; k++) {
          const d = len(sub(cpts[k], P));
          if (d < bd) { bd = d; bi = k; }
        }
        if (bi < 0) continue;
        const t = cents[bi];
        const c = sg * dot([N[3 * t], N[3 * t + 1], N[3 * t + 2]], nn);
        if (c < BLEND_FOLD_COS && !(state && state.blendFoldCheck === false)) return { fail: `Faltung (cos ${c.toFixed(2)} bei u=${a.toFixed(2)} v=${b.toFixed(2)})` };
      }
    }
    return { surf, sameSense: s > 0 };
  };
  let firstFail = null;
  for (const cs of cornerSets) {
    const r = attempt(cs);
    if (r.hard || !r.fail) return r;
    if (!firstFail) firstFail = r;
  }
  return firstFail;
}

// ─────────────────────────────────────────────────────────────────────────────
// Freiform-B-Rep bauen: normalGroups → { step, report, brep } | null
//
// opts: { tol (Segmentier-Toleranz, default 0.02), debug: { log: [] },
//         timeBudgetMs (Standard 6000), maxFacetShare (Standard 0.25) }
// ─────────────────────────────────────────────────────────────────────────────
export function buildFreeformBrep(normalGroups, opts = {}) {
  const o = opts || {};
  const dbg = (o.debug && typeof o.debug === 'object') ? o.debug : null;
  const log = dbg ? (dbg.log || (dbg.log = [])) : null;
  try {
    const r = buildInner(normalGroups, o, log);
    if (log && TIME) log.push(`ZEIT ${JSON.stringify(TIME)}`);
    return r;
  } catch (e) {
    if (log) log.push(`Ausnahme: ${e && e.message ? e.message : String(e)}`
      + (e && e.stack ? `\n${e.stack}` : ''));
    return null;
  }
}

function buildInner(normalGroups, opts, log) {
  const t0 = now();
  TIME = {};
  // Zeitbudget und Facetten-Anteil (Grenzen gegen endlose Versuche)
  const budgetMs = Number.isFinite(opts.timeBudgetMs) ? Math.max(0, opts.timeBudgetMs) : TIME_BUDGET_MS;
  const shareMax = Number.isFinite(opts.maxFacetShare) ? Math.max(0, opts.maxFacetShare) : FACET_SHARE_MAX;
  // Blend-Patches (B-Spline-Flächen statt Facetten) — aus = exakt altes Verhalten
  const blendPatches = opts.blendPatches !== false;
  // 1) Netz: nur EINE dichte, mannigfaltige Schale
  const mesh = indexMesh(trianglesFromGroups(normalGroups));
  if (!mesh || !mesh.manifold || mesh.components !== 1) {
    if (log) log.push('Netz: nicht manifold oder mehrere Komponenten — Freiform-Pfad nicht möglich');
    return null;
  }
  // 2) Fit-basierte Segmentierung
  // Zeitbudget der Segmentierung = Budget des ganzen Versuchs (unter Last lief die
  // Segmentierung sonst in ihr eigenes 4-s-Limit und lieferte Tausende Rest-Facetten)
  const tSeg = now();
  const seg = segmentByFit(mesh, { tol: opts.tol ?? 0.02, angleDeg: SEG_ANGLE_DEG, timeBudgetMs: budgetMs });
  tm('seg', tSeg);
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
    blendRegions: new Set(),     // Regionen, die als B-Spline-Blend behandelt werden
    stripRounds: new Map(),      // Region → Runden, in denen sie gestreift wurde
    testForceUsed: false,        // Testschalter (Kette): wirkt nur einmal
    testForceVertexUsed: false,  // Testschalter (Ecke): wirkt nur einmal
    segById: new Map(seg.regions.map((r) => [r.id, r])),
    adj: buildVertexAdjacency(mesh),   // Nachbarschaft im Netz (Umgebungssuche)
    t0,                                 // Startzeit des Versuchs (Zeitbudget)
    budgetMs,                           // Zeitbudget in ms
    shareMax,                           // Anteil der zu Facetten demotierten Dreiecke
    blendPatches,                       // Blend-Patches an (Standard) oder aus
    blendFoldCheck: opts.blendFoldCheck !== false,   // Faltungsprüfung der Patches (Standard an; aus = mehr Patches, BOP-Selbstschnitte)
  };
  // Testschalter: Regionen von Anfang an als Blend behandeln
  if (blendPatches && typeof opts.testBlendRegions === 'function') {
    for (const r of seg.regions) {
      let want = false;
      try { want = !!opts.testBlendRegions(r); } catch (e) { want = false; }
      if (want) state.blendRegions.add(r.id);
    }
  }
  const maxRounds = Number.isFinite(opts.maxRounds) && opts.maxRounds > 0
    ? Math.floor(opts.maxRounds) : ROUNDS_MAX;
  for (let round = 0; round < maxRounds; round++) {
    // vor jeder Runde: Zeitbudget und Hoffnungslosigkeit prüfen
    if (budgetExceeded(state)) { logBudget(log, state); return null; }
    if (hopeless(state, mesh)) { logHopeless(log, state, mesh); return null; }
    // Fortschritt der Runde messen (vor der Runde: ein Blend-Patch kann die
    // Region schon in der Runde zur Fassade demotiert haben)
    const before = state.stripTris.size + state.demotedRegions.size + state.blendRegions.size;
    const tRound = now();
    const res = runRound(mesh, seg, state, round, opts, log);
    tm('round.total', tRound); tmCount('round.count', 1);
    if (res.hard) return null;
    if (res.failures.length) {
      for (const [src, mvSet] of res.strips) {
        // Blend-taugliche Region: die GANZE Region wird ein B-Spline-Patch
        // (kein Streifen, keine Facetten). Sonst der alte Streifen-Weg.
        const r = state.segById.get(src);
        if (blendPatches && r && !state.blendRegions.has(src)
          && !state.demotedRegions.has(src) && blendEligible(r)) {
          state.blendRegions.add(src);
          if (log) {
            log.push(`Runde ${round}: Region ${src} (${r.type}) wird zum B-Spline-Blend`);
          }
          continue;
        }
        applyStrip(state, mesh, src, mvSet, round, log);
      }
      const after = state.stripTris.size + state.demotedRegions.size + state.blendRegions.size;
      if (after === before) {
        if (log) {
          log.push(res.strips.size
            ? `Runde ${round}: kein neuer Streifen → Abbruch`
            : `Runde ${round}: Fehler ohne schuldige Region → Abbruch`);
        }
        return null;
      }
      continue;
    }
    // Erfolg → STEP (aber nur, wenn das Ergebnis den bisherigen Weg schlagen kann)
    if (hopeless(state, mesh)) { logHopeless(log, state, mesh); return null; }
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
        blends: state.blendRegions.size,
        faces: res.facesByType,
        edges: res.edgesByType,
        ms,
      },
    };
    return { step, report, brep: res.brep };
  }
  if (log) log.push(`Nach ${maxRounds} Runden noch Fehler → Abbruch`);
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Eine Runde: Arbeitsregionen, Topologie, Snap, Geometrie
// ─────────────────────────────────────────────────────────────────────────────
function runRound(mesh, seg, state, round, opts, log) {
  const { tri, nV, T, N, A } = mesh;
  const adj = state.adj;
  const failures = [];
  const strips = new Map();            // Quellregion → Netzecken des Streifens
  const failKinds = new Map();         // Fehlerart → Anzahl

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
    // Blend-Region: die ganze Region wird EIN B-Spline-Patch (keine Flächen-
    // projektion, keine Ecken-Zwang, kein Snap) — die Fläche entsteht später
    if (state.blendPatches && state.blendRegions.has(r.id)) {
      const wr = {
        id: regions.length, kind: 'blend', surf: null,
        tris: r.tris, area: r.area, src: r.id, type: r.type,
      };
      regions.push(wr); byId.set(wr.id, wr);
      for (const t of r.tris) wLabel[t] = wr.id;
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

  // ── Eckenzuständigkeit: Netzecke → Regionen (wer besitzt die Eckbedingung?)
  const incident = new Map();
  for (let t = 0; t < T; t++) {
    const id = wLabel[t];
    for (let k = 0; k < 3; k++) {
      const mv = tri[3 * t + k];
      let s = incident.get(mv);
      if (!s) { s = new Set(); incident.set(mv, s); }
      s.add(id);
    }
  }

  // ── Fehler melden: Täter suchen — sonst die Umgebung durchsuchen
  // (analytische Regionen im 2-Ring, sonst im 3-Ring um dem Fehler)
  // blendsAtStart: die Regionen, die zu Rundenbeginn Blend waren. Ein
  // Patch-Fehler demotiert nur solche Regionen — eine Region, die ERST in
  // dieser Runde zum Blend geworden ist (ihr Rand ist wegen des Kettenfehlers
  // noch unvollständig), wird erst in der nächsten Runde demotiert.
  const blendsAtStart = new Set(state.blendRegions);
  const fail = (kind, cands, reason, mvSet, pick, fopts) => {
    failures.push(reason);
    failKinds.set(kind, (failKinds.get(kind) || 0) + 1);
    // Blend-Patch gescheitert: die Region wird GANZ zur Fassade (alter Weg)
    // und bleibt kein Blend mehr.
    if (fopts && fopts.demote !== undefined && fopts.demote !== null) {
      const src = fopts.demote;
      if (blendsAtStart.has(src)) {
        state.demotedRegions.add(src);
        const rr = state.segById.get(src);
        if (rr) for (const t of rr.tris) state.stripTris.add(t);
        if (log) log.push(`Runde ${round}: ${reason} → Region ${src} ganz zur Fassade`);
      } else if (log) {
        log.push(`Runde ${round}: ${reason} → Region ${src} bleibt Blend (erst in der nächsten Runde demotiert)`);
      }
      return null;
    }
    let c = pick ? pick(cands) : pickCulprit(cands);
    let mv = mvSet;
    if (!c || c.kind !== 'analytic') {
      const seed = mvSet ? [...mvSet] : [];
      let near = seed.length ? analyticNear(adj, incident, regions, seed, NEIGH_RING) : null;
      if (!near || !near.regions.length) {
        near = seed.length ? analyticNear(adj, incident, regions, seed, NEIGH_RING_MAX) : null;
      }
      if (near && near.regions.length) {
        // alle analytischen Regionen der Umgebung streifen (mvSet = Nachbarschaft)
        const list = near.regions.slice().sort((a, b) => a.area - b.area);
        for (const w of list) {
          let s = strips.get(w.src);
          if (!s) { s = new Set(); strips.set(w.src, s); }
          for (const v of near.verts) s.add(v);
        }
        c = list[0];
        mv = near.verts;
        if (log) {
          log.push(`Runde ${round}: ${reason} → Umgebung: ${list.length} analytische Region(en) `
            + `(${list.map((w) => `#${w.id} ${w.type}`).join(', ')}) gestreift`);
        }
      } else c = null;
    }
    if (c && c.kind === 'analytic') {
      let s = strips.get(c.src);
      if (!s) { s = new Set(); strips.set(c.src, s); }
      for (const v of (mv || [])) s.add(v);
    }
    if (log) {
      log.push(`Runde ${round}: ${reason}${c
        ? ` → Täter: Region ${c.id} (${c.type}, ${c.area.toFixed(1)} mm²)`
        : ' → kein Täter'}`);
    }
    return c;
  };

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
  if (log && snap && snap.log) for (const s of snap.log) log.push(`Snap: ${s}`);
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
      fail('orientation', [wr], `Orientierung Region ${wr.id} (${wr.type}) = ${s.toFixed(3)} (zu schwach)`,
        regionVertices(mesh, wr));
    } else wr.sameSense = s > 0;
  }

  // ── e) Ecken: Projektion auf alle anliegenden analytischen Flächen
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
  const vFailed = new Set();                 // Ecken mit gescheiterter Projektion (Diagnose)
  let worstRes = 0;
  for (let vi = 0; vi < nv; vi++) {
    // Zeitbudget (alle CHECK_EVERY Ecken prüfen)
    if (vi % CHECK_EVERY === 0 && budgetExceeded(state)) {
      logBudget(log, state);
      return { hard: true };
    }
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
    let r = projectMulti(S, p);
    // Testschalter: die Projektion genau EINER Ecke scheitern lassen (wirkt einmal)
    const forced = !state.testForceVertexUsed && typeof opts.testForceVertexFail === 'function'
      && !!opts.testForceVertexFail(p);
    if (forced) {
      state.testForceVertexUsed = true;
      r = { x: p, res: 1e-3, iters: r.iters, ok: false };
    }
    const shift = len(sub(r.x, p));
    if (r.res > worstRes) worstRes = r.res;
    // projectMulti verlangt selbst Rest ≤ 1e-10 mm — das ist für GEFITTETE Flächen
    // (Genauigkeit ~1e-5 mm) nicht erreichbar: tangentiale Paare (Kugel auf Zylinderachse)
    // schneiden sich nie exakt. Deshalb gilt der Rest ≤ VERT_TOL (2e-5 mm, weit unter der
    // STEP-Unsicherheit 1e-4 mm) als Erfolg; ein echter Widerspruch (kein Schnittpunkt)
    // liefert einen Rest in Größenordnung der Fit-Toleranz und wird abgewiesen.
    // Ecke MIT Blend-Nachbarn: die Fit-Fläche der Blend-Region ist keine
    // Projektionsbedingung — die Projektion auf die (tangentialen) analytischen
    // Nachbarn allein ist entartet, der Rest bleibt in der Fit-Genauigkeit.
    const vTol = [...ids].some((id) => regions[id].kind === 'blend') ? VERT_TOL_BLEND : VERT_TOL;
    const projOK = r.ok || (Number.isFinite(r.res) && r.res <= vTol);
    if (!projOK || shift > maxShift) {
      const cands = [...ids].map((id) => regions[id]).filter((w) => w.kind === 'analytic');
      // Streifen um die Ecke (Ecke + 1-Ring): die kleinste nicht-ebene analytische
      // Region, die an der Ecke beteiligt ist, wird zur Fassade gestreift
      const nb = vertexNeighbourhood(adj, [mv], 1);
      fail('vertex', cands, `Ecke ${vi} (Netz ${mv} bei ${p.map((x) => x.toFixed(3)).join(',')}): `
        + `Projektion res=${r.res.toExponential(2)} mm, `
        + `Verschiebung ${shift.toExponential(2)} mm (Grenze ${maxShift.toFixed(3)}), `
        + `Flächen ${cands.map((c) => c.type).join('/')}`, nb, pickSmallestNonPlane);
      X[vi] = p;
      vFailed.add(vi);
      continue;
    }
    X[vi] = r.x;
  }
  if (log) log.push(`Ecken: ${nv}, größter Projektionsrest ${worstRes.toExponential(2)} mm`);

  // ── f) Zusammenfallen: Kante mit |X[start] − X[end]| < 1e-6 fällt weg
  const parent = new Int32Array(nv);
  for (let i = 0; i < nv; i++) parent[i] = i;
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[rb] = ra; };
  // Testschalter: in einem Facetten-Dreieck zwei Ecken zusammenlegen
  // (Schliff-Vorfall). Die Kette zwischen ihnen fällt dadurch weg, die
  // Fläche bekommt zwei gleiche Geraden. Gewählt wird die Kette, deren
  // Nachbarfläche keine Ebene ist — die beiden übrigen Ketten bleiben
  // Geraden. Die zusammengelegte Ecke wird auf ALLE anliegenden Flächen
  // projiziert, damit sie auf ihnen liegt (Randprüfung des STEP-Prüfers).
  // Rückgabe des Schalters: true → Kette selbst wählen; Zahl 0/1/2 → die
  // Kante zwischen ps[k] und ps[k+1] des Dreiecks fest vorgeben (Fächer aus
  // benachbarten Schliffen gezielt bauen).
  if (typeof opts.testMergeFacetVertices === 'function') {
    for (const wr of regions) {
      if (wr.kind !== 'facet') continue;
      for (const t of wr.tris) {
        const c = [tri[3 * t], tri[3 * t + 1], tri[3 * t + 2]];
        const ps = c.map((mv) => (topo.vOfMesh[mv] >= 0 ? X[topo.vOfMesh[mv]] : ptOf(mesh, mv)));
        const want = opts.testMergeFacetVertices(ps[0], ps[1], ps[2]);
        if (want === undefined || want === null || want === false) continue;
        const forced = typeof want === 'number' && want >= 0 && want <= 2;
        // Ketten des Dreiecks (Endpunkte je Eckenpaar)
        const chainsOf = new Map();
        for (const ch of topo.chains) {
          if (ch.L !== wr.id && ch.R !== wr.id) continue;
          const a0 = ch.mv[0], b0 = ch.mv[ch.mv.length - 1];
          chainsOf.set(`${Math.min(a0, b0)}|${Math.max(a0, b0)}`, ch);
        }
        let pick = null, pickAny = null, pickLen = Infinity;
        for (let k = 0; k < 3; k++) {
          const a0 = c[k], b0 = c[(k + 1) % 3];
          const ch = chainsOf.get(`${Math.min(a0, b0)}|${Math.max(a0, b0)}`);
          if (!ch) continue;
          if (forced) {
            if (k === want) pick = [a0, b0];
            continue;
          }
          const o = regions[ch.L === wr.id ? ch.R : ch.L];
          const ebene = !o || o.kind === 'facet' || o.type === 'plane';
          // die Kette neben einer Rundfläche zuerst zusammenlegen (die beiden
          // übrigen Ketten bleiben dann Geraden), sonst das kürzeste Paar
          const d = len(sub(ps[k], ps[(k + 1) % 3]));
          if (d < pickLen) { pickLen = d; pickAny = [a0, b0]; }
          if (!ebene) { pick = [a0, b0]; break; }
        }
        if (!pick) pick = pickAny;
        if (!pick) continue;
        const ia = topo.vOfMesh[pick[0]], ib = topo.vOfMesh[pick[1]];
        if (ia < 0 || ib < 0) continue;
        union(ia, ib);
        const rep = find(ia);
        const S = [];
        for (const mv of pick) {
          for (const id of (incident.get(mv) || [])) {
            const w = regions[id];
            if (w.kind === 'analytic' && w.surf) S.push(w.surf);
          }
        }
        if (S.length) {
          const r = projectMulti(S, X[rep]);
          if (r.ok || (Number.isFinite(r.res) && r.res <= VERT_TOL)) X[rep] = r.x;
        }
      }
    }
  }
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
      fail('degenerate', wr && wr.kind === 'analytic' ? [wr] : [],
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
    const entartet = !(nl > 1e-9 * eLen * eLen);
    // zwei Ecken auf demselben Punkt → Schliff: die Ebene entartet, die
    // Fläche hat keinen Inhalt und entfällt später (ihre beiden Kanten
    // werden verschmolzen). Statt des Fehlers: Ebene aus der Netznormale.
    const zusammen = len(sub(pa, pb)) < COLLAPSE_EPS || len(sub(pb, pc)) < COLLAPSE_EPS
      || len(sub(pc, pa)) < COLLAPSE_EPS;
    if (entartet && zusammen) {
      // Ebene durch die beiden verschiedenen Ecken, Richtung wie im Netz
      const ps = [pa, pb, pc];
      let A = null, B = null;
      for (let i = 0; i < 3 && !A; i++) {
        for (let j = i + 1; j < 3; j++) {
          if (len(sub(ps[i], ps[j])) < COLLAPSE_EPS) continue;
          A = ps[i]; B = ps[j]; break;
        }
      }
      if (A && B) {
        const nm = [N[3 * t], N[3 * t + 1], N[3 * t + 2]];
        let nn = norm(cross(sub(B, A), nm));
        if (dot(nn, nm) < 0) nn = mul(nn, -1);
        facetSurf.set(wr.id, { surf: { type: 'plane', o: A.slice(), n: nn }, sameSense: true });
        wr.sliver = true;
        continue;
      }
    }
    if (entartet || agree < 0.5) {
      // Ursache: die Ecken wurden auf analytische Flächen verschoben — schuld sind
      // die Regionen, die diese Eckbedingungen besitzen (kleinste davon wird gestreift)
      const owners = analyticAtVertices(mesh, wr, incident, regions);
      let c = null, mv0 = null;
      for (const [w, mv] of owners) {
        if (!c || w.area < c.area) { c = w; mv0 = mv; }
      }
      const nb = mv0 !== null
        ? vertexNeighbourhood(adj, [mv0], 1)
        : new Set([tri[3 * t], tri[3 * t + 1], tri[3 * t + 2]]);
      fail('degenerate', [...owners.keys()],
        `Facette ${t}: Ebene entartet oder gegen die Netznormale (${agree.toFixed(3)})`,
        nb, () => c);
      continue;
    }
    facetSurf.set(wr.id, { surf: { type: 'plane', o: pa.slice(), n: nrm }, sameSense: true });
  }

  // ── h) Kanten: Schnittkurve zwischen den beiden anliegenden Flächen
  let edges = [];
  const edgeOf = new Map();                   // Kette → Kantenindex
  const surfOfRegion = (id) => {
    const wr = regions[id];
    if (!wr) return null;
    if (wr.kind === 'analytic') return wr.surf;
    const fs = facetSurf.get(wr.id);
    return fs ? fs.surf : null;
  };
  for (let ci = 0; ci < topo.chains.length; ci++) {
    const ch = topo.chains[ci];
    // Zeitbudget (alle CHECK_EVERY Ketten prüfen)
    if (ci % CHECK_EVERY === 0 && budgetExceeded(state)) {
      logBudget(log, state);
      return { hard: true };
    }
    if (collapsed.has(ch.id)) continue;
    const wrL = regions[ch.L], wrR = regions[ch.R];
    const kindL = wrL ? wrL.kind : 'facet', kindR = wrR ? wrR.kind : 'facet';
    const hasBlend = kindL === 'blend' || kindR === 'blend';
    // Blend-Ketten kosten je Kette einen Kurvenfit auf der analytischen Fläche
    // → das Zeitbudget wird hier je Kette geprüft, nicht nur alle CHECK_EVERY.
    if (hasBlend && budgetExceeded(state)) {
      logBudget(log, state);
      return { hard: true };
    }
    const A2 = surfOfRegion(ch.L), B2 = surfOfRegion(ch.R);
    const vi0 = topo.vOfMesh[ch.mv[0]], vi1 = topo.vOfMesh[ch.mv[ch.mv.length - 1]];
    if ((!hasBlend && (!A2 || !B2)) || vi0 < 0 || vi1 < 0) {
      fail('chain:fehlt', [wrL, wrR],
        `Kette ${ch.id}: Fläche oder Ecke fehlt`, new Set(ch.mv));
      continue;
    }
    const v0 = vIdx(vi0), v1 = vIdx(vi1);
    if (v0 === v1) {
      fail('chain:identisch', [wrL, wrR],
        `Kette ${ch.id}: beide Enden sind dieselbe Ecke`, new Set(ch.mv));
      continue;
    }
    // Testschalter: eine Kette einmal scheitern lassen (Streifen-Demotion prüfen)
    const forced = typeof opts.testForceChainFail === 'function'
      ? opts.testForceChainFail(A2, B2, ch)
      : !!(opts.testForceChainFail && isCylSphere(A2, B2));
    if (forced && !state.testForceUsed) {
      state.testForceUsed = true;
      fail('chain:testForce', [wrL, wrR],
        `Kette ${ch.id} (${wrL.type}/${wrR.type}): Schnittkurve testForceChainFail`,
        new Set(ch.mv));
      continue;
    }
    const p = vertices[v0], q = vertices[v1];
    const guides = ch.mv.slice(1, -1).map((mv) => ptOf(mesh, mv));
    let res = null;
    let curve = null;
    if (hasBlend) {
      // Blend-Kante: analytisch↔blend (Kurve auf der analytischen Fläche),
      // blend↔blend (freie Kurve), facette↔blend (Gerade — die Facette ist
      // eben, ihre Kante liegt in der Facetten-Ebene).
      const anSide = kindL === 'analytic' ? wrL : (kindR === 'analytic' ? wrR : null);
      const faSide = kindL === 'facet' ? wrL : (kindR === 'facet' ? wrR : null);
      if (anSide && anSide.surf) {
        // Die Kurve liegt auf der analytischen Fläche. Liegt die Ecke nicht
        // exakt auf ihr (Rest ≤ VERT_TOL_BLEND, weil die Fit-Fläche der
        // Blend-Region nicht mitprojiziert wird), wird für den Fit auf die
        // Fläche projiziert und der Endpunkt danach auf die Ecke zurückgesetzt
        // (die Kante muss an der Ecke hängen — die Nachbarflächen teilen sie).
        const pp = project(anSide.surf, p), qq = project(anSide.surf, q);
        res = fitCurveOnSurface(anSide.surf, pp, qq, guides,
          { tol: FIT_TOL, maxShift: EDGE_MAX_SHIFT });
        if (res.fail) {
          fail(`chain:blend-${res.fail}`, [anSide],
            `Kette ${ch.id} (${wrL.type}/${wrR.type}): Blend-Kurve ${res.fail}`,
            new Set(ch.mv));
          continue;
        }
        curve = res.curve;
        if (curve && curve.ctrl && curve.ctrl.length >= 2) {
          curve.ctrl[0] = p.slice();
          curve.ctrl[curve.ctrl.length - 1] = q.slice();
        }
      } else if (faSide) {
        const d = sub(q, p);
        const dl = len(d);
        if (!(dl > 1e-12)) {
          fail('chain:blend-fehlt', [faSide],
            `Kette ${ch.id} (${wrL.type}/${wrR.type}): Blend-Kante ohne Länge`, new Set(ch.mv));
          continue;
        }
        curve = { type: 'line', p: p.slice(), d: mul(d, 1 / dl) };
      } else {
        const c = interpPolyline(p, q, guides);
        if (!c) {
          fail('chain:blend-poly', [wrL, wrR],
            `Kette ${ch.id} (${wrL.type}/${wrR.type}): Blend-Kurve nicht interpolierbar`,
            new Set(ch.mv));
          continue;
        }
        curve = c;
      }
    } else {
      res = fitIntersectionCurve(A2, B2, p, q, guides, { tol: FIT_TOL, maxShift: EDGE_MAX_SHIFT });
      if (!res.fail) curve = res.curve;
    }
    // Diagnose (nur mit opts.debug.chainStats): Paar, Ausgang, Normalenwinkel in der Kettenmitte
    if (opts.debug && Array.isArray(opts.debug.chainStats)) {
      const mid = guides.length ? guides[guides.length >> 1] : mul(add(p, q), 0.5);
      const na = A2 ? normalAt(A2, mid) : null;
      const nb = B2 ? normalAt(B2, mid) : null;
      const ang = (na && nb)
        ? Math.acos(Math.min(1, Math.abs(dot(na, nb)))) * 180 / Math.PI : NaN;
      opts.debug.chainStats.push({
        round, L: wrL.type, R: wrR.type, idL: wrL.src, idR: wrR.src, kL: wrL.kind, kR: wrR.kind,
        fail: (res && res.fail) || null, curve: curve ? curve.type : null, ang,
        endsOK: !vFailed.has(vi0) && !vFailed.has(vi1), n: ch.mv.length, A: A2, B: B2, p, q, mid,
      });
    }
    if (res && res.fail) {
      fail(`chain:${res.fail}`, [wrL, wrR],
        `Kette ${ch.id} (${wrL.type}/${wrR.type}): Schnittkurve ${res.fail}`,
        new Set(ch.mv));
      continue;
    }
    // Kreisbogen: läuft der positive Bogen p→q "lang herum"? → Bogen spiegeln
    if (curve && curve.type === 'circle') {
      curve = fixCircleArc(curve, p, q, chainPolyLen(mesh, ch, p, q));
    }
    edgeOf.set(ch.id, edges.length);
    edges.push({ v0, v1, curve });
  }

  // ── i) Flächen (mit Platzierungshinweisen für den STEP-Schreiber)
  const faces = [];
  const facesByType = { plane: 0, cylinder: 0, cone: 0, sphere: 0, torus: 0, facet: 0, bspline: 0 };
  const merged = new Map();                   // entfallene Kante → { keep, flip }
  const dropped = new Set();                  // entfallene Kanten
  // Kanten-Union-Find: eine entfallene Kante zeigt auf ihren Vertreter;
  // resolveEdge liefert (Vertreter, Richtungswechsel gegenüber der Ursprungskante)
  const resolveEdge = (i) => {
    let flip = false;
    let cur = i;
    const seen = new Set();
    while (merged.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      const m = merged.get(cur);
      if (m.flip) flip = !flip;
      cur = m.keep;
    }
    return { edge: cur, flip };
  };
  // Flächen sammeln: je Region ihre Schleifen (Uses der Kanten)
  const cand = [];
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
    } else if (wr.kind === 'blend') {
      // B-Spline-Patch: die Fläche entsteht nach dem Kanten-Verschmelzen
      // (dann sind die endgültigen Kanten bekannt)
      cand.push({ wr, kind: 'blend', surf: null, sameSense: true, loops, dead: false });
      continue;
    } else {
      const fs = facetSurf.get(wr.id);
      if (!fs) continue;                       // (bereits als Fehler gemeldet)
      surf = fs.surf;
      sameSense = true;
      kind = 'facet';
    }
    cand.push({ wr, kind, surf, sameSense, loops, dead: false });
  }
  // ── Schliffe: eine Schleife aus genau zwei Geraden zwischen denselben
  // Ecken läuft doppelt über dieselbe Strecke — sie hat keinen Inhalt und
  // entfällt; ihre beiden geometrisch gleichen Kanten werden zu einer
  // verschmolzen (die Nachbarflächen teilen sie sich danach). Das
  // Verschmelzen kann neue Schliffe erzeugen → bis zum Fixpunkt laufen.
  // Reihenfolge: Regionen (deterministisch), Schleifen in Randreihenfolge.
  for (let changed = true; changed;) {
    changed = false;
    for (const cf of cand) {
      if (cf.dead) continue;
      for (let li = 0; li < cf.loops.length; li++) {
        const sl = sliverOf(cf.loops[li], edges, resolveEdge);
        if (!sl) continue;
        if (sl.merge) {
          merged.set(sl.drop, { keep: sl.keep, flip: sl.flip });
          dropped.add(sl.drop);
        }
        cf.loops.splice(li, 1);               // die Schliff-Schleife entfällt
        if (!cf.loops.length) cf.dead = true; // die ganze Fläche entfällt
        if (log) {
          log.push(`Runde ${round}: Fläche ${cf.wr.id} (${cf.kind}) ist ein Schliff `
            + `(${sl.merge ? `zwei gleiche Geraden ${sl.keep}/${sl.drop}`
              : `beide Geraden dieselbe Kante ${sl.keep}`}) — `
            + `${cf.dead ? 'entfernt' : 'Schleife entfernt'}, Kanten verschmolzen`);
        }
        changed = true;
        break;                                 // Kanten haben sich geändert → neu prüfen
      }
    }
  }
  // ── Entartete Flächen: eine Schleife ohne Flächeninhalt darf nicht
  // ausgegeben werden (erst nach dem Schliff-Pass: der hat alle Schliffe
  // entfernt, damit bleibt kein Schliff für die Fehlersuche übrig)
  for (const cf of cand) {
    if (cf.dead) continue;
    const degen = degenerateLoop(cf.loops, edges, vertices, cf.surf, cf.sameSense);
    if (!degen) continue;
    const wr = cf.wr;
    cf.dead = true;
    const cands = wr.kind === 'facet'
      ? analyticTouching(mesh, wr, wLabel, regions, incident)
      : analyticNeighbours(topo, regions, wr, degen.chains);
    // Kein analytischer Nachbar direkt? → Umgebung (2 Ringe, sonst 3) suchen;
    // erst wenn dort auch nichts ist, aufgeben
    const seed = new Set(chainMeshVertices(mesh, topo, degen.chains));
    for (const mv of regionVertices(mesh, wr)) seed.add(mv);
    const c = fail('degenerate', cands, `Fläche ${wr.id} (${cf.kind}): ${degen.why}`,
      seed, pickSmallestAnalytic);
    if (!c) {
      if (log) log.push(`Runde ${round}: entartete Fläche ${wr.id} ohne analytischen Nachbarn `
        + `im ${NEIGH_RING_MAX}-Ring → Abbruch`);
      return { hard: true };
    }
  }
  // Flächen ausgeben (Außenrand bestimmen)
  const blendFaces = [];
  for (const cf of cand) {
    if (cf.dead) continue;
    const { surf, sameSense, kind, loops } = cf;
    if (kind === 'blend') {
      // Blend-Fläche: genau EIN Rand (sonst Patch-Fehler) — die Fläche selbst
      // wird nach dem Kanten-Verschmelzen gebaut
      const one = loops.length === 1;
      loops.forEach((lp) => { lp.outer = one; });
      for (const lp of loops) delete lp.chains;
      blendFaces.push({ cf, idx: faces.length });
      faces.push({ surf: null, sameSense: true, loops, kind: 'blend' });
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
  // Schliffe: die Verwendungen der verschmolzenen Kante umleiten (Richtung
  // bleibt relativ zur Eckenreihenfolge) und die entfallene Kante streichen
  if (merged.size) {
    const live = [];
    const idx = new Map();
    for (let i = 0; i < edges.length; i++) {
      if (dropped.has(i)) continue;
      idx.set(i, live.length);
      live.push(edges[i]);
    }
    for (const f of faces) {
      for (const lp of f.loops) {
        for (const u of lp.uses) {
          // jede Kantenummer wird neu vergeben (die entfallenen Kanten
          // verschieben alle folgenden), die verschmolzenen Kanten werden
          // auf ihren Vertreter umgeleitet (Richtung relativ zur
          // Eckenreihenfolge: die Vertreterecken entscheiden über den
          // Richtungswechsel)
          const r = resolveEdge(u.edge);
          u.edge = idx.get(r.edge);
          u.fwd = u.fwd !== r.flip;
        }
      }
    }
    edges = live;
    if (log) log.push(`Runde ${round}: ${dropped.size} Kante(n) verschmolzen, `
      + `${edges.length} Kanten bleiben`);
  }
  // ── Blend-Patches: je Blend-Region EINE B-Spline-Fläche über den
  // Randkurven (jetzt sind die endgültigen Kanten bekannt)
  for (const { cf, idx } of blendFaces) {
    if (budgetExceeded(state)) { logBudget(log, state); return { hard: true }; }
    const wr = cf.wr;
    if (cf.loops.length !== 1) {
      fail('blend', [], `Blend ${wr.id} (${wr.type}): ${cf.loops.length} Ränder (genau einer erwartet)`,
        regionVertices(mesh, wr), null, { demote: wr.src });
      continue;
    }
    const res = buildBlendPatch(wr, cf.loops[0].uses, edges, vertices, mesh, state);
    if (res.hard) { logBudget(log, state); return { hard: true }; }
    if (res.fail) {
      fail('blend', [], `Blend ${wr.id} (${wr.type}): ${res.fail}`,
        regionVertices(mesh, wr), null, { demote: wr.src });
      continue;
    }
    faces[idx].surf = res.surf;
    faces[idx].sameSense = res.sameSense;
    facesByType.bspline = (facesByType.bspline || 0) + 1;
  }
  const edgesByType = { line: 0, circle: 0, bspline: 0 };
  for (const e of edges) {
    const t = e.curve?.type || 'line';
    edgesByType[t] = (edgesByType[t] || 0) + 1;
  }

  // ── Rundenbilanz: Regionen, Facetten, Fehler je Art
  if (log) {
    let nFacet = 0;
    for (const wr of regions) if (wr.kind === 'facet') nFacet++;
    const kinds = [...failKinds.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([k, n]) => `${k} ${n}`).join(', ');
    log.push(`Runde ${round}: Regionen ${regions.length} · Facetten ${nFacet}`
      + ` · Fehler ${kinds || 'keine'}`);
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

// Schliff: eine Schleife aus genau zwei Geraden zwischen denselben Ecken.
// Der Rand läuft doppelt über dieselbe Strecke — die Schleife hat keinen
// Inhalt und entfällt; die beiden geometrisch gleichen Kanten (beide Geraden
// zwischen demselben Eckenpaar) werden zu einer verschmolzen.
//
// Beide Kanten werden zuerst auf ihren VERTRETER geführt (Union-Find der
// Kanten): eine Kante, die schon von einem früheren Schliff verschluckt
// wurde, zeigt auf die Kante, die sie ersetzt. Beide Verwendungen können
// also auf dieselbe Kante zeigen — dann entfällt die Schleife, ohne dass
// etwas zu verschmelzen ist.
//
// Eckenvergleich: die Kanten tragen als v0/v1 die VERTRETERecken (Union-Find
// der Netzecken nach dem Zusammenfallen der Kanten) — nicht die rohen
// Netzecken-Ids. Zwei zusammenfallende Ecken sind so dieselbe Ecke.
function sliverOf(lp, edges, resolveEdge) {
  const uses = lp && lp.uses;
  if (!uses || uses.length !== 2) return null;
  const r1 = resolveEdge(uses[0].edge), r2 = resolveEdge(uses[1].edge);
  const e1 = edges[r1.edge], e2 = edges[r2.edge];
  if (!e1 || !e2 || !e1.curve || !e2.curve) return null;
  if (e1.curve.type !== 'line' || e2.curve.type !== 'line') return null;
  if (e1.v0 === e1.v1 || e2.v0 === e2.v1) return null;
  const key = (e) => (e.v0 < e.v1 ? `${e.v0}|${e.v1}` : `${e.v1}|${e.v0}`);
  if (key(e1) !== key(e2)) return null;      // nicht dieselbe Strecke
  if (r1.edge === r2.edge) {
    // beide Verwendungen zeigen auf dieselbe Kante → nichts zu verschmelzen
    return { keep: r1.edge, drop: r1.edge, flip: false, merge: false };
  }
  const keep = Math.min(r1.edge, r2.edge);
  const drop = Math.max(r1.edge, r2.edge);
  // Richtungswechsel: laufen die beiden Kanten gleichsinnig (Startecken
  // gleich) oder gegensinnig (Startecke der einen = Endecke der anderen)?
  const flip = edges[keep].v0 === edges[drop].v1;
  return { keep, drop, flip, merge: true };
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
    // Achse = mittlere Auswärtsnormale der Region: ein Pol der
    // Kugel-Parametrisierung liegt IN der Fläche, der andere gegenüber —
    // die Naht der Parametrisierung liegt damit nicht auf dem Rand
    // (sonst Selbstschnitt an der Tangentialkante Kugel/Zylinder).
    // x = feste Einheitsrichtung ⟂ Achse (deterministisch).
    let mx = 0, my = 0, mz = 0;
    for (const t of wr.tris) {
      const w = A[t];
      mx += mesh.N[3 * t] * w; my += mesh.N[3 * t + 1] * w; mz += mesh.N[3 * t + 2] * w;
    }
    const m = norm([mx, my, mz]);
    if (len(m) > 1e-9) {
      const helper = Math.abs(m[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
      const x = sub(helper, mul(m, dot(helper, m)));
      const perp = len(x) > 1e-9 ? norm(x) : norm(cross(m, [0, 0, 1]));
      // Öffnungswinkel der Region um m (größter Winkel Netznormale ↔ m)
      let minCos = 1;
      for (const t of wr.tris) {
        const c = mesh.N[3 * t] * m[0] + mesh.N[3 * t + 1] * m[1] + mesh.N[3 * t + 2] * m[2];
        if (c < minCos) minCos = c;
      }
      if (minCos > Math.cos(70 * Math.PI / 180)) {
        // flache Kalotte (Skoda: Kugeln R ≈ 300 mm): Fläche auf den ÄQUATOR legen,
        // Naht (x) gegenüber. Mit dem Pol IN der Fläche nahm OCC die Gegenseite
        // (Fläche = ganze Kugel minus Kalotte, BRepCheck_UnorientableShape).
        surf.axis = perp;
        surf.x = mul(m, -1);
      } else {
        surf.axis = m;
        surf.x = perp;
      }
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
  // Zeitbudget: 'auto' darf nicht lange blockieren (der bisherige Weg steht
  // schon), 'true' (ausdrücklich gewünscht) darf länger rechnen
  const ff = buildFreeformBrep(groups, { timeBudgetMs: mode === 'auto' ? 6000 : 30000 });
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

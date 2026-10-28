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

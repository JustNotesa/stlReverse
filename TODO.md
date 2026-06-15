# TODO - STL Reverse Add-on

*Stand: 2026-04-20 — Nach Cleanup: RUN_V3BETA-Detektoren (Zylinder/Kegel/Kugel) entfernt, V1 archiviert.*

---

## Aktueller Pipeline-Stand (nach Cleanup 2026-04-20)

Was **tatsächlich funktioniert**:
- STL-Parsing (ASCII + binär) + Mesh-Simplification (>50k Dreiecke)
- Bounding-Box + 3 Orthoprojektionen (XY/YZ/ZX) mit konvexer Hülle
- **normalGroups** — Region-Growing via Dihedral-Winkel (15° Hard-Edge-Schwelle) in `analysis-worker.js`
- Exporter: `buildOutlinesDxf` (2D), `buildOutlinesStep` (2D-Konturen), `buildVolumeStepBrepV2` (Konvexe Hülle je Region → STEP), `buildVolumeStepTriangles` (1 PLANE pro Dreieck)
- 4 Viewer-Panels: STL-Mesh, Flächen-Regionen, B-Rep-Vorschau, STEP (occt-import-js)

Was **entfernt wurde** (nicht funktionsfähig / RUN_V3BETA-gated):
- `detectAxialCylindricalFeatures`, `detectLowPolyCylinders`, `detectObliqueCylindricalFeatures`
- `detectConicalFeatures`, `detectSphericalFeatures`, `detectPlanarFeatures`
- `reconstructVolumeFromHeightfield`, Volume-Heatmap-UI
- Plane/Cylinder/Cone/Sphere-Tabellen im Popup
- `buildVolumeStepSolid`, `buildVolumeStepSolidFromOutline`, Legacy-`buildVolumeStepBrep`

Was **archiviert** ist: `archive/buildVolumeStepBrepV1.js` — alter V1 Planes+Zylinder+Kegel-Exporter. Funktionierte in Isolation aber nur auf axis-aligned Primitiven; von V3-Detektoren abhängig die nie live waren.

Was **parkend** ist: `segmentation.js` — PCA-basierte Topologie-Segmentierung + LINE/ARC-Klassifizierung. Wird reaktiviert wenn Face-Unification zu echter Primitiv-Erkennung ausgebaut wird.

---

## Hohe Priorität — Face Unification als neue Basis

Ziel: `buildVolumeStepBrepV2` liefert aktuell 1 ADVANCED_FACE pro normalGroup-Region, aber als konvexe Hülle und mit duplizierten koplanaren Faces. Nächster Schritt: **Shape Healing / Face Unification** (Analog zu OCCT's `ShapeUpgrade_UnifySameDomain`), in pure JS.

- [ ] **face-unification.js Modul**
  - Input: `analysis.normalGroups` (Regionen mit Normal + Vertices)
  - Schritt 1: Gruppieren nach koplanarer Äquivalenz (Normal + Offset-Toleranz)
  - Schritt 2: Union der Boundary-Polygone pro Plane (Outer-Loop + Holes als Inner-Loops)
  - Schritt 3: Ausgabe als `{ plane, outerLoop, innerLoops[] }` — Basis für N-Gon ADVANCED_FACE
  - Entspricht dem Ansatz aus der CAD-Assistant-Session (ShapeUpgrade_UnifySameDomain in JS)

- [ ] **buildVolumeStepBrepV2 auf Face Unification umstellen**
  - Statt konvexe Hülle je Region: unified Plane-Faces mit echten Boundary-Loops (inkl. Löcher)
  - Drastisch weniger ADVANCED_FACEs in der STEP-Ausgabe
  - Grundlage für spätere Zylinder/Kegel-Erkennung (Ring-Topologie der Plane-Loops)

- [ ] **Panel 3 (B-Rep-Vorschau) auf unified Faces umstellen** — zeigt dann echte N-Gons statt konvexe Hüllen

## Mittlere Priorität

- [ ] **Analytischer STEP-Export — Rest-Fälle** (Voll-Durchgangsbohrungen sind erledigt, siehe unten). Offen:
  - **Blind­löcher** (Sackloch: 1 Rand-Loop statt 2) — braucht Boden-Cap (flach/rund). 4 der 6 fischerEbike-
    Bohrungen sind Blindlöcher (vermutlich verrundeter Boden → nicht sauber als Zylinder+Scheibe darstellbar).
  - **Geneigte/verrundete Loch-Mündungen** — wenn die Mündung nicht ~⟂ auf einer Flachfläche sitzt
    (fischerEbike id=1/id=5: ~10–20° schräg) findet das Rand-Matching keinen Innen-Loop → Fallback.
    Evtl. Toleranz lockern + per-Vertex-Radialtest als Schutz.
  - **Außen-Zylinder** (Vollzylinder, nicht Loch): Rand sitzt am AUSSEN-Loop der Deckel, nicht am Innen-Loop —
    Matching müsste auch Outer-Loops prüfen.
  - **Fillets als Teil-Zylinder** (full=false) — bleiben aktuell facettiert; `getOrCreateCircleEdge` ist
    für Bögen erweiterbar (Naht-Form aus dem Design-Plan).
- [ ] **Kegel/Kugel-Erkennung** — Kegel werden aktuell korrekt *verworfen* (RMS(n·Achse)- und Krümmungs-Rand-
  Check), aber noch nicht als `CONICAL_SURFACE`/`SPHERICAL_SURFACE` erkannt. Analoger Fit (Halbwinkel/Zentrum).
- [ ] **Full Online3DViewer in neuem Tab** (zukünftig, ~1–2 Tage Aufwand)
- [ ] **Full Online3DViewer in neuem Tab** (zukünftig, ~1–2 Tage Aufwand)

## Niedrige Priorität

- [ ] **Sketch-Rekonstruktion** — 2D-Grundskizze + Extrusionsrichtung aus unified Faces
- [ ] **FreeCAD .FCStd Export** — Parametrisches Modell
- [ ] **Playwright E2E-Tests** — File-Upload, Analyse, Export
- [ ] **Performance-Benchmarks** — dino_clip.stl als Referenz

---

## Erledigt

- [x] **Regressionstest analytische Bohrungen — Dünnplatten-Fall abgesichert (2026-06-15)** —
  `tests/bore-analytic-regression.mjs` (`npm run test:bore`) fährt die volle Pipeline
  (parseStl → buildNormalGroups → unify → recognizePrimitives → buildVolumeStepBrepV2) in Node
  und **asserted boresConverted===1 + Präsenz einer echten CYLINDRICAL_SURFACE** auf `washer_thin.stl`
  (dünne Platte t<0.6·R, der Auslöser des stillen Voll-Fallbacks) und `block_with_hole.stl` (dicke
  Kontrolle). Lücke vorher: occt-check + Wasserdicht-Sweep meldeten GRÜN, weil der facettierte Fallback
  selbst wasserdicht+occt-parsebar ist — der Feature-Verlust war unsichtbar. Belegt: mit zurückgenommenem
  Axial-Gate/claimed-Set liefert washer_thin boresConverted=0/CYLINDRICAL_SURFACE×0 (watertight bleibt true)
  → Test schlägt mit Exit 1 fehl; mit Fix grün. Code-Fix selbst lag bereits in Commit 4087978.
- [x] **Analytische Voll-Durchgangsbohrungen → CYLINDRICAL_SURFACE + CIRCLE (2026-06-15)** —
  Erkannte Voll-Bohrungen (`group.primitive`, kind=bore, full) werden als EINE nahtlose
  `CYLINDRICAL_SURFACE` mit 2 vollen `CIRCLE`-Rand-Kanten exportiert statt Dutzender Facetten-Planes;
  die Kreis-Kanten werden mit den angrenzenden Flachflächen geteilt. **block_with_hole: 461 → 7 Faces,
  weiterhin wasserdicht, occt parst, Loch ist ein glatter Kreis** (Browser verifiziert).
  - Repräsentation **nahtlos** (2 volle Kreis-Bounds, keine Naht) — empirisch gegen occt-import-js
    bestätigt (`tests/cyl-proto.cjs` testet seamless+hybrid; beide parsen, seamless ist einfacher).
  - Kreis-Kanten über eigene `circleRegistry`/`circleUse` (umgehen die LINE-Maschinerie wegen
    start==end-Vertex), ins selbe Wasserdicht-Verdikt eingefaltet.
  - Bohrungs-Gruppierung über **prim.id** (Worker-Strukturklon bricht Objekt-Identität — `===` unbrauchbar).
  - **3 Fallback-Ebenen** schützen die Baseline: attemptBore→null pro Bohrung; Rand-Match scheitert→facettiert;
    globaler Schutz (öffnet die Umwandlung die Hülle → ALLES facettiert neu) → 12/13 wasserdicht nie regressiert.
  - Verifiziert (`tests/occt-check.cjs`, alle 14 Samples): 13/14 wasserdicht, alle occt-parsebar, keine Regression.
    Design-Grundlage: 3-Agenten-Panel + Synthese (empirisch an `samples/FensterLueftungInsectProtect.step` belegt).
  - **Review-Fix (12-Agenten-Review)**: `innerMatchesRim` war achsen-blind → ein koaxialer Ring am
    FALSCHEN Loch-Ende konnte matchen (geometrisch ungültige Fläche, vom topologischen Verdikt nicht
    gefangen) UND dünne Platten (Dicke < 0.6·R) fielen still auf Facetten zurück. Fix: **Axial-Ebenen-Gate**
    (Loop muss in der Ebene SEINES Randes liegen) + **Per-Plan-Distinktheit** (zwei Ränder ≠ derselbe Loop).
    Neuer Regressions-Sample `washer_thin.stl` (Loch r=8 in 4 mm Platte) wandelt jetzt korrekt um (Browser
    verifiziert: 67 statt 130 Facetten-Flächen). `exporters.js?v=20`.
  - **Offen (low, Review-Befund 2)**: Mantel-Rand-Bounds nutzen gleiche Windung + sameSense=.T. (Normale
    radial nach außen). occt/OCCT re-orientiert beim Import (FreeCAD/Fusion) → rendert korrekt; ein strikter
    Validator könnte mäkeln. Nicht geändert, um den funktionierenden Stand nicht zu riskieren.
  - **Grenzen** (→ Fallback, kein Geometrie-Schaden): Blindlöcher, geneigte/verrundete Mündungen,
    Außen-Zylinder, Fillets — siehe „Mittlere Priorität".
- [x] **Panel 4: B-Rep-Kanten anzeigen (Flächengrenzen) + „Kanten"-Umschalter (2026-06-15)** —
  `step-viewer.js` zeichnet jetzt die Ränder der topologischen Flächen (PLANE, CYLINDRICAL_SURFACE, …)
  als dunkle Linien über dem gefüllten Körper (CAD-typische Drahtgitter-auf-Schattierung-Optik).
  occt-import-js liefert KEINE nativen Kanten, aber `brep_faces` (Dreiecks-Index-Bereiche je Fläche).
  `_buildFeatureEdges` ordnet jedes Dreieck seiner Fläche zu und zeichnet eine Mesh-Kante genau dann,
  wenn sie zwischen ZWEI verschiedenen Flächen liegt (oder echte Rand-/Non-manifold-Kante ist) —
  Tessellierungs-Innenkanten einer einzelnen Fläche werden unterdrückt (ein Zylinder = 2 Kreise + Naht,
  kein Facetten-Gitter). Position-basierte Kanten-Keys (1e-4, -0/+0-normalisiert) führen geteilte
  Vertices zusammen. `polygonOffset` auf den Flächen-Materialien verhindert Z-Fighting. Checkbox
  `#step-edges-toggle` schaltet Sichtbarkeit. Fallback ohne brep_faces: `THREE.EdgesGeometry(…,25°)`.
  **Verifiziert:** synthetischer Würfel → exakt 12 Kanten (6 Diagonalen + Flächen-Innenkanten unterdrückt);
  fischerEbike → **13948 erkannte Kanten == 13948 EDGE_CURVE im wasserdichten V2-STEP** (exakte
  Topologie-Übereinstimmung); Umschalter funktioniert, keine Konsolen-Fehler.
  Adversariale Review (22 Agenten, 19 Befunde → 4 bestätigt) → gefixt: (1) Fallback ohne brep_faces
  zeichnete Randkanten doppelt (edgeMap-Push UND EdgesGeometry) → beide Pfade jetzt sich gegenseitig
  ausschließend; (2) Naht geschlossener analytischer Flächen wird nicht gezeichnet (occt liefert keine
  Kanten-Topologie, Dihedral kann Naht/Facetten nicht trennen) → Kommentar korrigiert (nur Rand-Kreise);
  (3) Multi-Mesh-Baugruppen: geteilte Naht doppelt → dokumentiert (für Einzelkörper irrelevant);
  (4) Perf-Schutz `MAX_EDGE_TRIS=600000` gegen UI-Einfrieren bei riesigen externen Importen.
  Hinweis Review: der 13948-Match beweist nur planare B-Rep-Kanten (V2 ist rein planar) — verallgemeinert
  NICHT auf importierte analytische Zylinder/Kugeln (deren Nähte fehlen, Rand-Kreise sind korrekt).
  Cache-Buster: `step-viewer.js?v=17`.
- [x] **V2-STEP wasserdicht — CLOSED_SHELL + MANIFOLD_SOLID_BREP (2026-06-14)** — `buildVolumeStepBrepV2`
  liefert jetzt für geschlossene Eingangs-Meshes einen echten Solid (1 Körper in Fusion/FreeCAD) statt
  eines offenen Flächenverbunds. Drei zusammenwirkende Fixes:
  1. **Roh-Loops statt projectOntoPlane/simplifyLoop** — Loop-Vertices werden als echte Mesh-Vertices
     emittiert (nicht je Face auf dessen Mittel-Ebene projiziert oder vereinfacht). Damit teilen
     Nachbarflächen exakt dieselben Koordinaten → jede Kante wird genau 1×fwd + 1×rev genutzt.
     `MIN_FACE_AREA`/`MIN_HOLE_AREA` auf 1e-6 gesenkt (keine echten Löcher mehr verworfen).
  2. **Nesting-Fix (Außen/Innen)** — Eltern-Loop muss IMMER flächengrößer sein als sein Kind
     (`areaJ > areaI`). Ohne diesen Test lag bei einem **zentrierten Loch** (block_with_hole) der
     Schwerpunkt der äußeren Rechteck-Kontur im kleinen Bohrungs-Ring → Außen/Innen vertauscht →
     Ring als FACE_OUTER_BOUND emittiert → 732 non-manifold-Kanten. Jetzt 0.
  3. **Naht-Normalisierung (-0.0/+0.0)** — an der Mantel-Naht (φ=0°↔360°) erzeugt der Tessellierer
     `sin(2π) ≈ -2.4e-16` → geometrisch identische Punkte mit y=-0.0 statt +0.0; `toFixed(4)` hasht
     sie auf "-0.0000" vs "0.0000" → Naht-Kanten finden ihren Partner nicht. `fixZero()` in `vtxKey`
     und `ptKey` vereinheitlicht -0/+0 → **alle Kegel + schräge Zylinder** schließen sich.
  Wenn `report.watertight === true`: `CLOSED_SHELL` + `MANIFOLD_SOLID_BREP` + `ADVANCED_BREP_SHAPE_
  REPRESENTATION`; sonst Fallback `OPEN_SHELL` + `SHELL_BASED_SURFACE_MODEL` (Verdikt fängt es ehrlich).
  **Verifiziert (Node, alle 12 Samples, Ref-Integrität + Header geprüft): 11/12 wasserdicht** —
  cube, cylinder, cylinder_oblique_45/_xz, cone_flat/_frustum/_pointed, block_with_hole (Durchgangsloch),
  hemisphere, sphere_full, **fischerEbike (reales Bauteil, 8159 Faces)**. Einzige Ausnahme:
  dino_clip — **Eingangs-Mesh ist selbst non-manifold** (7 Kanten mit Valenz 4, zwei Flächen-Sheets
  an einer Kante) → kein sauberer Solid ohne Mesh-Reparatur möglich; Fallback OPEN_SHELL korrekt.
  Cache-Buster: `exporters.js?v=18`.
- [x] **Zylinder- UND Fillet-Erkennung via Seed-Grow-Fitting (2026-06-14)** — `primitive-recognition.js`
  (`recognizePrimitives`) komplett auf RANSAC-artiges Seed-Grow umgestellt: von einer gekrümmten Saat-
  Facette aus Zylinder (Achse via PCA der Normalen, Radius via robustem getrimmtem Kåsa-Fit) schätzen und
  die Region nur wachsen lassen, solange die Punkte auf dem Mantel liegen (Abstand≈Radius) und die Normale
  ⊥ zur Achse steht. Erkennt damit **volle Bohrungen UND Teil-Zylinder (gerade-Kanten-Fillets)** einheitlich
  (Erkenntnis aus der Fusion-STEP: ein gerade-Kanten-Fillet IST ein Viertel-Zylinder) und isoliert sie
  sauber von tangentialen Ebenen. Aufruf im Worker nach Face-Unification, try/catch-gekapselt, keine Mutation
  von Vertices/Normalen → STEP-Exporter & Wasserdichtigkeits-Verdikt unberührt.
  Validierungs-Gates: Mantel-Abweichung, **RMS(n·Achse)≈0** + **Konizitäts-Steigung d(radius)/d(achse)≈0**
  (verwerfen Kegel — auch dünne osculating gefittete Scheiben), und für Teil-Zylinder **Rand-muss-an-Ebenen-
  grenzen** (verwirft Kegel/Kugel-Scheiben, die von mehr Krümmung umgeben sind). `seedMinDeg=1°` deckt fein
  tessellierte Bohrungen ab; `seedMaxDeg=50°` deckt 8-seitige Zylinder ab. Anzeige: Bohrungen rot / Fillets
  orange in Panel 2+3, Zylinder-Overlay für volle Bohrungen; Daten in `__analysisDebug.primitives`.
  Verifiziert — synthetisch: Bohrungen N8/24/96 (exakter Radius, inkl. fein), Fillets R2–R6 (exakt, kein
  Flat-Leak), Würfel/Kegel ≥20° = 0. Browser: cylinder→1 R2, block_with_hole→1 R3.92, cube/cone_pointed→0,
  **fischerEbike→11 Zylinder R≈2.5** (6 Bohrungen + 5 Fillets; vorher 0/Fehltreffer).
  Adversariale Review (14 Agenten) → gefixt: robuster getrimmter Kåsa-Fit, Scratch-Puffer (Anti-Allokation),
  Anti-Blowup-Region-Marking (`failRegion`), Konizitäts-Test, catch-stats. Cache-Buster: worker `?v=11`,
  primitive-recognition import `?v=8`, viewers `?v=23`.
  **Bekannte Grenzen (anzeige-only, kein Geometrie-/Verdikt-Einfluss):** sehr flache Kegel (<~15° Halbwinkel,
  z. B. Entformungsschrägen) und volle Kugeln können als Fehltreffer auftauchen — im Maschinenbau selten.
- [x] **„Nachziehen" beim Rotieren behoben — eigentliche Ursache: Draw-Calls (2026-06-13)** —
  Panel 2 (`updateFeaturesViewer`) und Panel 3 (`updateBrepViewer`) erzeugten **1 Mesh+Material pro
  Region** (Panel 3 zusätzlich 1 LineSegments pro Region). Nach dem Region-Filter-Fix hat das echte
  Bauteil (fischerEbike-Mount, 399 Regionen) ~400 bzw. ~800 Objekte je Panel — alle 4 Panels rendern
  zudem in eigenen Endlos-RAF-Schleifen gleichzeitig. Messung: **~6 FPS (161 ms/Frame)** → unbenutzbar
  beim Drehen. Fix: alle Regionen pro Panel in **eine** Geometrie mit Vertex-Farben mergen (Panel 3:
  1 Flächen-Mesh + 1 gemergtes Linien-Set). Ergebnis: **~120 FPS (8,3 ms/Frame), ~19×**, Optik
  identisch (verifiziert mit fischerEbike + Würfel). viewers.js-Cache-Buster `?v=21`.
  Hinweis: `preserveDrawingBuffer: true` wurde zuvor ebenfalls entfernt (war ein Nebenfaktor, nicht
  die Hauptursache — das Symptom war komplexitätsabhängig, also Performance, nicht Puffer).
- [x] **Panel 4 = Wasserdichtigkeits-Prüfung (2026-06-13)** — Panel 4 zeigte vorher nie, ob der Körper
  geschlossen ist (occt rendert nur Dreiecke; Material war `DoubleSide` → Risse unsichtbar; „Rendern"
  parste den immer-geschlossenen Triangle-STEP). Jetzt: (1) `buildVolumeStepBrepV2` zählt Kanten-Nutzung
  richtungsgetrennt (fwd/rev) und liefert `report {faceCount, edgeCount, boundaryEdges, nonManifoldEdges,
  orientationDefects, watertight}`; (2) Verdikt-Zeile `#step-watertight-status` (grün/amber) erscheint
  automatisch nach der Analyse; (3) „Rendern" zeigt jetzt den **V2**-STEP (das Exportierte); (4) Renderer
  auf `FrontSide` + goldene `BackSide`-Innenflächen → offene Hüllen werden sichtbar wie in Fusion.
  Verifiziert: cube_ascii = wasserdicht/all-blau, block_with_hole = 706 offene Kanten/gold. Return-Shape
  von `buildVolumeStepBrepV2` ist jetzt `{step,report}` (alle Caller in popup.js angepasst, E2E-Test
  unberührt da über UI-Button). Adversarial-Review (8 Agents): 2 minor Findings bestätigt+gefixt.

- [x] **Bugfix 2026-06-12: Region-Filter verwarf echte Flächen** — `analysis-worker.js` filterte Regionen
  mit <3 Dreiecken; dadurch fehlten alle 4 Seitenwände (je 2 Dreiecke) von block_with_hole.stl in
  Panel 2/3/4 + STEP (459/1464 Dreiecke verworfen). Filter entfernt → 100 % Abdeckung, geschlossener
  Körper in allen Panels verifiziert. Worker-Cache-Buster in popup.js auf `?v=3` erhöht.
- [x] **Bugfix 2026-06-12 (Teil 2): Gleicher <3-Dreiecke-Filter im V2-Exporter** — `extractGroupFaces`
  in exporters.js verwarf 2-Dreieck-Flächen ebenfalls (`verts.length < 9`); cube_ascii.stl ergab
  dadurch `null` statt STEP. Auf `< 3` gesenkt → Würfel: 6 ADVANCED_FACEs; block_with_hole: 230 Faces
  inkl. Seitenwänden + 4 Loch-Loops. Export → Re-Import in Panel 4 (occt) zeigt geschlossenen Körper.
  Außerdem: Panel-4-Hinweistext korrigiert („Rendern" parst den Triangle-STEP, nicht den V2-STEP);
  exporters-Cache-Buster auf `?v=14`.
- [x] **Cleanup 2026-04-20** — RUN_V3BETA-Detektoren entfernt, V1 archiviert, Tables/Heatmap entfernt (exporters.js 2988→828, analysis-core.js 2310→768 Zeilen)
- [x] STEP-Viewer Panel 4 (occt-import-js Worker + Three.js)
- [x] Memory Cleanup + Error Handling (Worker-Timeout 60s, occt-Timeout 30s, Export try/catch)
- [x] buildVolumeStepBrepV2 — V2 STEP-Exporter auf Basis von normalGroups (konvexe Hülle)
- [x] Alle 4 Panels auf V2 Pipeline umgestellt (normalGroups, konvexe Hülle, STEP auto-load)
- [x] popup.js modularisiert (2.181 Zeilen → 6 Module: popup/viewers/step-viewer/ui/tables/preview)
- [x] Web Worker (analysis-worker.js) mit Job-ID-System + Detail-Slider-Caching
- [x] STL-Simplification (MAX_FACES=50000, Worker-Cache)
- [x] Unit-Tests + E2E-Tests + Visuelle Regressionstests
- [x] Test-STL-Dateien (cube_ascii, cylinder, block_with_hole, cone_pointed, dino_clip)
- [x] manifest.json data_collection_permissions

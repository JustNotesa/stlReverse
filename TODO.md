# TODO - STL Reverse Add-on

*Stand: 2026-10-27 — Mindest-Detailgröße (Mikro-Facetten weg); 2026-10-26 — STEP für strikte Importer (CST CAD Navigator/ACIS): Kanten-Richtungen, Kreis-Orientierung,
ebene Flächen, Schalen je Körper, Orientierungs-Wächter; Außenmäntel als echte Zylinder; Senkungen geschützt;
Erkennung 2–4× schneller. Testen im eingebauten Browser + Node-Harness (Firefox erst beim Packaging).*

**Tests (vor jedem Commit):** `npm test` (10 Suiten: unit, golden, v2 quick, ebike, tube, bore, mantel, collinear,
strict, orient). Jede Export-Änderung muss `npm run test:strict` bestehen (STEP ohne Heilung — occt/Fusion
reparieren still, CST nicht). Gewollte Golden-Änderungen: `npm run test:golden -- --update`, Diff prüfen, committen.

---

## Aktueller Pipeline-Stand

Was **tatsächlich funktioniert**:
- STL-Parsing (ASCII + binär) + Mesh-Simplification (>50k Dreiecke); Normalen aus der Wicklung
- Bounding-Box + 3 Orthoprojektionen (XY/YZ/ZX) mit konvexer Hülle
- **normalGroups** — Region-Growing in `region-growing.js` (gemeinsam für Worker + Tests): Dreieck gehört
  zur Region bei ≤2° zur MITTLEREN Regions-Normale und ≤0.05 mm zur Regions-Ebene; Saat = größte Dreiecke zuerst
- Face Unification (`face-unification.js`), Zylinder-/Bohrungs-Erkennung (`primitive-recognition.js`),
  analytischer Export (Zylinder, Kegel-Fasen), Body-Defeaturing (Verrundung → scharfe Kante, Toggle)
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
  - **Bögen, Rest:** Fächer-Splitter an der Kabelhalter-Hakenspitze (asymmetrisches Netz), ~100 Gravur-Facetten,
    `oneCircle` lässt evtl. fast gerade feine Läufe als Bogen durch (mm/oc-Ansatz verschlechterte den Kabelhalter).
  - **Sacklöcher, Rest:** mit Fase/Senkung an der Mündung, Stufenbohrung, Kugelboden → facettiert.
  - **Kegel–Kegel-Rundungen**, konkave Fußrundung „Kegel auf Platte“ ungetestet; Panel 2 färbt Kegel nicht.
  - **Geneigte/verrundete Loch-Mündungen** (auch die 2 eBike-Durchgangslöcher im AUS-Modus) — wenn die Mündung nicht ~⟂ auf einer Flachfläche sitzt
    (fischerEbike id=1/id=5: ~10–20° schräg) findet das Rand-Matching keinen Innen-Loop → Fallback.
    Evtl. Toleranz lockern + per-Vertex-Radialtest als Schutz.
  - **Fillets als Teil-Zylinder** (full=false) — bleiben aktuell facettiert; `getOrCreateCircleEdge` ist
    für Bögen erweiterbar (Naht-Form aus dem Design-Plan).

## Hohe Priorität — Verrundungs-umgebene Löcher → echte Zylinder (TOROIDAL_SURFACE), User-Wunsch 2026-06-15

Befund: ALLE Bohrungen des realen fischerEbike-Teils münden in **Verrundungen** (das Teil ist überall
verrundet) — keine grenzt an eine flache Fläche (`neighborsFlatParallel=0` für alle 6). Darum greift das
Kreis-Rand-Matching nicht (Kreis vs. facettierter Fillet passt nicht). Der naheliegende „Zylinder mit
facettiertem Rand"-Hack scheitert in occt (zerfällt in 2 Meshes). Sauberer Weg = die Verrundungen
ebenfalls analytisch als **TOROIDAL_SURFACE** exportieren, sodass Zylinder↔Torus↔Ebene sich echte
Kreis-Kanten teilen.

- [x] **Emission/Stitching machbar (EMPIRISCH belegt)** — Torus: `tests/torus-proto.cjs`; **Fase/Kegel
  (User-Idee, einfacher)**: `tests/cone-proto.cjs`. Beide bauen einen wasserdichten Solid aus gemischten
  analytischen Flächen (CYLINDRICAL + TOROIDAL bzw. CONICAL + PLANE) mit geteilten CIRCLE-Kanten, der
  sauber in occt parst (1 Mesh, 4 Faces). Repräsentation steht.
- [x] **Chamfer-Erkennung + -Integration implementiert** (statt Torus — User-Idee: Verrundung durch
  gerade Fase ersetzen). In `buildVolumeStepBrepV2`: pro Bohrungs-Rand, wenn KEIN direkter Flach-Treffer,
  Suche nach koaxialem Kreis R2>R im kleinen Achs-Abstand (`loopAsCircle`, CHAMFER_MAX=2.5) → Plan
  Zylinder + CONICAL_SURFACE-Kegel + Flach-Kreis; Fillet-Facetten in der Zone werden entfernt
  (`chamferZones`-Filter). Wasserdicht-Verdikt + 3-Ebenen-Fallback unverändert.
- [x] **Recognition-Härtung: verrundete Löcher werden erkannt (2026-06-15/16)** — `primitive-recognition.js`
  um **Phase 1 (Kanten-Achsen-Seeding)** erweitert: die Scharnier-Kante zweier benachbarter Zylinder-
  Facetten liegt EXAKT parallel zur Achse → exaktes lokales Achsen-Estimate BEVOR kontaminierte
  Bootstrap-PCA-Regionen die dünne Wand in ~12er-Splitter fressen (empirisch belegte Todesursache bei
  fillet-dominierten Löchern). Phase 1 verbraucht bei Fehlschlag NICHTS, akzeptiert nur volle Bohrungen;
  Phase 2 = bisheriger Pfad unverändert. Dazu: **Rettungspfad** (validateRegion → extractCylinderCore
  mit Min-ρ-Band-Trimmen [Loch-Fillets krümmen IMMER nach außen → Wand = Population am minimalen
  Achsabstand] → Regrow mit sauberem Modell, blockiert nur auf `claimed` → Kern-Politur) und
  **Anti-Kugel-Wächter** (weggetrimmte Facetten müssen nach außen krümmen; Schwelle 0.4%·r — bei 2%
  rutschte sphere_full durch, Regression behoben). `visited`/`claimed` getrennt (Anti-Aushungern).
- [x] **Chamfer-Konvertierung FUNKTIONIERT end-to-end (2026-06-16)** — Blocker war ein
  **Referenzrahmen-Bug**: `dz = circ.meanT − rim.meanT` mischte Frames (loopAsCircle misst relativ
  zum rim.center, rim.meanT relativ zum axisPoint) → Chamfer konnte NIE feuern. Fix: `dz = circ.meanT`.
  **Ergebnis:** `washer_filleted` (graduelle Verrundung, fillet-dominiert 12:1) → **652→77 Faces,
  1 CYLINDRICAL_SURFACE + 2 CONICAL_SURFACE (Fasen), wasserdicht, occt ok**; `washer_chamfered`
  (45°-Fase) ebenso. Volle Regression (17 Samples, `tests/pipeline.cjs`): 16/17 wasserdicht (nur dino,
  non-manifold Input), alle occt-ok, Kegel/Kugeln identisch zur Baseline, alle bisherigen
  Konvertierungen intakt. fischerEbike: Erkennung 6→10 Bohrungen (Segmente der gebogenen Bohrung),
  Konvertierung weiter 0 (Mündungen auf GEKRÜMMTEN Flächen — kein koaxialer Flach-Kreis vorhanden).
  Cache-Buster: primitive-recognition `?v=9`, worker `?v=12`, exporters `?v=22`.
- [ ] **fischerEbike-Konvertierung — gemessener Blocker (2026-06-16, exakte Achsen):** Pro Bohr-Ende
  nach koaxialen flachen Mündungs-Kreisen gesucht: **die meisten Enden haben KEINEN** (Mündung öffnet
  auf gekrümmte Fläche oder in den gebogenen Kanal); wo einer existiert, ist er **exzentrisch/oval**
  (ecc 0.24–4.7 mm bei R2.5; Bohrungen real 13–21° zur Mündungsfläche geneigt — kein Messfehler mehr).
  Kein einziges Loch hat an BEIDEN Enden einen flachen Kreis → Fase/Kegel hat nichts zum Anbinden.
  Facet-Rand-Zylinder scheitert in occt (belegt). **Konsequenz: Der Weg für solche Teile ist das
  Body-Defeaturing** — erst die KÖRPER-Verrundungen entfernen (→ Mündungsflächen werden flach+kreisrund),
  dann greift die bestehende Loch-Konvertierung. = der geplante Remove-Fillet-Toggle, nächster großer Bau.
- [x] **Body-Defeaturing v1 + Toggle-Switch (2026-06-16)** — Gerade-Kanten-Verrundungen zwischen
  ZWEI Ebenen werden beim Export durch die SCHARFE Schnittkante der Nachbar-Ebenen ersetzt:
  Fillet-Facetten entfallen, Rand-Vertices beider Ebenen wandern auf die Schnittlinie (kanonische
  Punkt-Union gegen T-Junctions), End-Kappen-Bögen kollabieren auf den Eckpunkt. Konservative
  Guards (genau 2 Ebenen-Cluster, Winkel ≥20°, Linie ∥ Fillet-Achse, schräge Nachbarn → skip);
  jede Unsauberkeit fängt das Wasserdicht-Verdikt + erweiterter globaler Fallback (jetzt auch bei
  filletsDefeatured>0). **Bewiesen:** `block_edge_fillet.stl` (Block mit verrundeter Längskante,
  hand-getaggt): 14 → 6 Flächen (scharfer Quader), wasserdicht, occt ok. Toggle AN/AUS verifiziert
  (washer_filleted: 77 Flächen mit Fasen ↔ 652 facettiert). Regression 17/18 wasserdicht, alle occt-ok.
  **UI:** Checkbox „Verrundungen entfernen (Fase/scharfe Kante)" in Panel 4 (default AN), Verdikt
  aktualisiert live beim Umschalten. `exporters.js?v=23`.
  **Offen:** (a) Die ERKENNUNG liefert auf synthetischen/degenerierten Prismen keine sauberen
  Teil-Zylinder-Fillets (Bootstrap kreuzt Flächen; Umkreis-Degenerat bei 2-Dreieck-Flächen ohne
  Innen-Vertices) → automatisches Feuern derzeit nur, wo die Erkennung Fillets korrekt taggt
  (fischerEbike-Fillets haben gekrümmte Nachbarn → Guards skippen korrekt). Partial-Fillet-Härtung
  = nächste Recognition-Etappe (analog zur Bohrungs-Härtung). (b) Ebene↔gekrümmt-Streifen (eBike-
  Außenkontur) = v2 des Defeaturing.
- [ ] **Optional später: echter Torus** statt Fase (mehr Detail) — Emission ist schon belegt
  (torus-proto). GEBOGENE Löcher: seit 2026-10-24 exakt (tube-sweep.js, s. Erledigt).
- [ ] **v2: Restfälle nach Runde I** — offene Bänder mit sehr dünnem Steg unter der Rundung (< 0,5·r, z.B. Platte
  2,5 mit r=1,2 oben UND unten) bleiben jetzt rund (vorher korrekt geschärft; neue Seitenwand-Schranke gegen eckig
  werdende Halbkreis-/Zylinder-Profile); Kegel/Fase zwischen Rundungen nur in einem Teil eines Loops (offenes Band
  mit Mittel-Lage) wird nicht bearbeitet; „Senkungen/Fasen geschärft“ zählt heute in bandsDefeatured mit.
- [ ] **Echtes Teil „Kabelhalter“ (User-STL, ~/Downloads/under_desk_cable_holder_vcd.stl — nicht ins Repo, fremde
  Lizenz): „Verrundungen entfernen“ fällt komplett in den Rückfall.** Erkennung: 9 Verrundungen, 1 Bohrung; v1 entfernt
  genau 1 Kanten-Verrundung an einem 0,5 mm dünnen Steg (x ≈ −39…−35, y 2,5…3,0) und setzt die neue Ecke auf
  (−39,385 | −3,425) — die Steg-Seitenflächen werden nicht nachgezogen → 24 offene Kanten, 2 Orientierungsfehler,
  auch ohne Bohrung (Stufe 1) → alles facettiert. Zwei Aufgaben (nach Agent F2, der gerade in defeatureBands arbeitet):
  (1) v1-Fehler an kurzen Verrundungen dünner Stege beheben bzw. dort sicher überspringen; (2) gezielter Rückfall je
  Merkmal (nur die Operation weglassen, an deren Flächen die offenen Kanten liegen) statt alles zu facettieren;
  (3) warum v1/v2 die übrigen 8 Verrundungen überspringen (Gate-Gründe je Rundung) — Abdeckung bei echten Teilen.
- [ ] **Ebenheit nur am Rand geprüft (AUS-Modus, feine Rundungen)** — m32/m64 AUS: eine Fläche ist randeben, ihr
  Inneres leicht gewölbt (flachste Bandschicht in der Deckgruppe) → B-Rep-Volumen weicht 3,6/0,9 mm³ vom Netz ab.
  Abhilfe: auch innere Dreiecksecken unveränderter Flächen prüfen.
- [ ] **Ecken, an denen 3 Verrundungen zusammenlaufen (Kugel-Eckstück)** — v1/v2 überspringen sie bewusst.
- [ ] **Gebogene Kanäle — Rest-Fälle** (Basis erledigt, s. Erledigt 2026-10-24 „tube-sweep.js“):
  - Facetten-Prüfung (D-Profil-Schutz) ist bewusst konservativ: sehr unregelmäßige Tessellierung kann facettiert
    bleiben (Ablehnungsgrund steht seit 2026-10-27 in der Ergebniszeile).
  - Nicht-ebene Bahnen (3D-Biarcs), Sackkanäle (1 Mündung), Mündung auf gekrümmter Fläche/Verrundung,
    Kanäle in Gruppen, die sich mit anderen Flächen eine Region teilen → bleiben derzeit facettiert.
  - Spline-Bahnen ergeben viele Bogenstücke (eBike: 16 + 11); ggf. B-Spline-Sweep statt Bogenkette.
  - eBike rechts: Modell-Restfehler im Bogen bis 0.037 mm (Profil-Neigung dort ~1° anders) — prüfen.
  - Restlaufzeit detectTubes auf großen Freiform-Kanälen ~2–3 s (score/marchNormal, linear).
- [ ] **Schalen — Restpunkte (nach dem Merge von `wt/schalen-freigang`, 2026-10-27)**:
  - BREP_WITH_VOIDS (Hohlraum im Körper) in Fusion/CST gegentesten (occt + OCP ok; Datei `cst-test/wuerfel-mit-hohlraum.step`).
  - Berührende Hohlräume über 1e-4 des Körpervolumens bleiben Hohlraum mit Hinweis (`shellNotes` 'hohlraum-beruehrt')
    und teilen dann Ecken mit der Außenschale — step-strict meldet dort shared-topology.
  - Lage-Tests haben ein Budget (CONTAIN_BUDGET): riesige Mehrkörper-Netze → unentschieden → V<0-Schalen lösen den
    sicheren Rückfall aus. `shell-volume` im Prüfer überspringt Drehflächen-Schalen (stats.volumeSkipped).
  - Semantik: `watertight=false` erzwingt keinen Rückfall mehr — Downstream-Annahmen „!watertight ⇒ facettiert“ prüfen.
- [ ] **CST-Rückmeldung des Users** zu den Testdateien in `cst-test/` (lokal, gitignored) abwarten — alle Dateien
  sind nach den Fixes frisch zu exportieren (dino jetzt 4 Körper ohne kaputte Zusatz-Schalen).
- [ ] **Review der Etappen 05fb3c3…6d67e62 abschließen** — Workflow-Lauf `wf_a998fde1-33d` wurde durch einen
  Absturz unterbrochen (Bereiche: Erkennung, Fasen-Export, Defeaturing, STEP-Gültigkeit, Integration).
- [ ] **Kegel/Kugel-Erkennung** — Kegel werden aktuell korrekt *verworfen* (RMS(n·Achse)- und Krümmungs-Rand-
  Check), aber noch nicht als `CONICAL_SURFACE`/`SPHERICAL_SURFACE` erkannt. Analoger Fit (Halbwinkel/Zentrum).
- [ ] **Full Online3DViewer in neuem Tab** (zukünftig, ~1–2 Tage Aufwand)
- [ ] **Full Online3DViewer in neuem Tab** (zukünftig, ~1–2 Tage Aufwand)

- [ ] **Spritzguss-/CATIA-Teile (Skoda-Haken, Printables, lokal `samples/`, nicht ins Repo): 18 377 Flächen / 17,6 MB**
  (Diagnose 2026-10-28): 58 % der Fläche Ebenen, 22 % kugelartig (gewölbte Formschrägen-Wände R≈300 + Eckkugeln R≈1),
  18 % Zylinder, 2 % Torus-Verrundungen (aber 33 % der Dreiecke). Kleine Verrundungen r 0,3–1 an gekrümmten Kanten →
  Region-Growing macht jede Facettenreihe zur Ebene (11 912 Gruppen). Bestehende Pfade greifen nicht (v2: Formschräge
  13–14°, profile-arcs: gekrümmte Nachbarn); Gate-Lockerung < 1 %. Ideal ≈ 400–800 Flächen. Vorschlag eigene Runde:
  (1) fit-basierte Analytik-Segmentierung (Prototyp scratchpad skoda/fitseg.mjs), SPHERICAL_/TOROIDAL_SURFACE,
  Kanten zwischen gekrümmten Flächen als B-Spline mit Projektion auf beide Flächen; (2) Formschrägen-Wand als
  B-Spline-Regelfläche; (3) danach AN-Variante, die kleine Verrundungen schärft.

## Niedrige Priorität

- [ ] **Sketch-Rekonstruktion** — 2D-Grundskizze + Extrusionsrichtung aus unified Faces
- [ ] **FreeCAD .FCStd Export** — Parametrisches Modell
- [ ] **Playwright E2E-Tests** — File-Upload, Analyse, Export
- [ ] **Performance-Benchmarks** — dino_clip.stl als Referenz

---

## Erledigt

- [x] **UI-Überarbeitung „Maker-Ablauf+“ (2026-10-29, `wt/ui-neu`)** — zwei Entwürfe (Maker-Ablauf / CAD-Werkbank), Jury,
  Umsetzung durch MiniMax, zwei unabhängige Prüfrunden. Ergebnis-Karte (Verdikt, STEP-Download ohne Scrollen, Kennzahlen,
  „Facettiert geblieben“ mit Grund), Optionen-Spalte mit Erklärsätzen, neue Schalter „Gravur als Extrusion“ (an) und
  „Freiform-Erkennung“ (aus), Vorher/Nachher-Viewer (Vergleich | Nur STEP), Expertenansicht mit Reitern, hell/dunkel, ab 700 px,
  Tastaturbedienung. Neue Module verdict.js, layout.js, feature-colors.js (+ tests/verdict.test.js). STEP-Ausgabe unverändert.
  Screenshots tests/screenshots/ui-neu-*.png.
- [x] **UI Etappe 2 (2026-10-30, `wt/ui-etappe2`)** — kompaktere Ergebnis-Karte, Viewer-Höhe folgt dem Fenster (1440×900 ohne
  Scrollen bei einfachen Teilen), gekoppelte Kameras (Schalter „Ansichten koppeln“), Vollbild-Knopf (Fullscreen-API, Overlay-Rückfall),
  Viewer zeigen das Teil nicht mehr gespiegelt (echte Drehung Z→Y statt y/z-Tausch), ehrlicher Zähler: report.rimFilletsToChamfer
  (Lochrand-Rundung → Fase/Kegel) und report.rimChamfersKept (echte Fase als Kegel). STEP-Ausgabe byte-gleich.
- [x] **Tempo + Testpflege (2026-10-30, `wt/tempo-tests`)** — Export 16–41 % schneller (NozzleBox AN −33 %, AUS −41 %;
  Skoda AN −32 %), STEP byte-gleich an 46 Dateien. Kanten-Index je Flächenliste gemerkt, vtxKey-Cache am Punkt, Kreis-Fit ohne
  Matrizen, nearestParam-Raster je Kurve. npm test um Suiten `freeform` und `gravur` erweitert (14 Suiten). Importe von
  profile-arcs/spline-fit jetzt einheitlich versioniert (keine doppelten Modul-Kopien mehr). Popup-Memo des Pakets verworfen
  (main hat currentExport). Offen: Export in den Web-Worker verlegen (blockiert bei großen Teilen ~5 s die UI); toter Code
  det3/solve3 (Matrix-Varianten) in profile-arcs.js; vtxKey-Symbol ist aufzählbar.
- [ ] **Kabelhalter-Reste (`wt/kabelhalter-rest`, NICHT gemergt):** Spalten-Kollaps in mesh-clean.js (142/151 statt 218/233),
  Prüfung: lagenabhängig — z5 verschoben/gedreht kippt AN auf ~255 Flächen, Kabelhalter schräg AN 752 → 1642. Kein Rückfall auf
  Einzel-Kollaps, Mikro-Kanten bleiben. Erst lagenstabil machen, Härtetest in mehreren Lagen. Unit-Tests insertRulings/guardCorner
  aus dem Branch sind brauchbar und können separat übernommen werden.
- [x] **Freiform Etappe 2 (2026-10-31, `wt/freiform2`)** — Verrundungen/kleine Regionen, deren Fit-Fläche die Nachbarn nicht
  exakt trifft, werden zu EINER B-Spline-Fläche (Coons-Patch über den Randkurven) statt zu Facetten; B_SPLINE_SURFACE_WITH_KNOTS
  im Schreiber und in step-strict (orient-bspline, neu bspline-knots: Knoten streng steigend, Vielfachheiten); robuste Projektion
  auf ungleich parametrisierte Patches (Startwerte je Knotenspanne, Rand-Isokurven); Faltungsprüfung (blendFoldCheck).
  Weiter nur hinter „Freiform-Erkennung“ (Standard aus); Standardpfad byte-gleich an 46 Dateien, npm test 14/14, Golden unverändert.
  **Skoda: noch kein Gewinn** — mit Freiform an fällt er auf den alten Weg zurück (51 % Facetten > 25 % → „Hoffnungslos“, 296 von
  558 Patches scheitern, meist Faltung), Ergebnis = AUS (18369/18370 Flächen, strict 0, OCP gültig), kostet aber ~30 s statt ~2 s.
  Ohne Facetten-Schwelle: 17720 Flächen (335 B-Spline), strict 0, OCP gültig, aber OCP-sa 17 gaps3d / 5 Selbstschnitte → nicht CST-sicher.
  Testkörper (Rundquader, Torus-Platte, Halbkugel, je 6 Lagen): Flächen lagenstabil, strict 0, OCP gleich wie main.
  Offen: Faltung der Patches am Skoda (Hauptgrund des Scheiterns); Kontrollnetze bis 10 000 Punkte (Datei 2,7–4,5 MB beim
  Rauschkörper, BLEND_MAX_NET 40000 zu großzügig); Zeitbudget wird überzogen (Skoda 33 s bei 30 s); gescheiterte Patches →
  Facetten mit BOP-Selbstschnitten (nur per Testschalter erreicht); verrauschter Rundquader lagenabhängig (Rückfall in 2 von 6 Lagen);
  'true' nimmt Freiform auch bei mehr Flächen als der alte Weg; Altlast: OCP-sa gaps3d an gedrehten Freiform-Körpern auch auf main.
- [ ] **UI Rest:** Mit „Verrundungen entfernen“ AUS zählt die Kachel echte Fasen (arcCones) als „bleiben rund“; Karte „überwiegend
  facettiert“ nicht grün einfärben (body[data-quality=faceted]); echter Esc-Test im nativen Firefox-Vollbild; veraltete E2E-Tests (tests/e2e).
- [x] **Kleinteile NozzleBox (2026-10-29, `wt/kleinteile`)** — (1) Ösen: Lochringe im STL gegeneinander verdreht
  (keine Mantellinie) → `insertRulings` (profile-arcs.js) setzt Punkte exakt auf den Kreis an Schnittwinkeln und
  trianguliert die Wand neu; Gravur-Ablauf läuft ohne/mit Mantellinien, weniger Flächen gewinnt. (2) Scharnier-Knöchel:
  `axisCandidates` übersprang Flächen mit circleRim → nur deren Kreis-Loops ignorieren. Härtetests z3/z4.
  NozzleBox 1621 → 1049 (AUS 1625 → 1053). Golden (AUS): washer_chamfered 219 → 12, washer_filleted 867 → 39,
  eBike 2306 → 1038. Risiko: Ecken-Abweichung NozzleBox bis 5,5e-6 mm (CST rechnet 1e-6) → CST-Test offen.
  Offen: Kabelhalter-Hakenspitze (gleiche Ursache, noch nicht erfasst), Unit-Tests insertRulings.
- [x] **Gravur als Extrusion (2026-10-29, `wt/gravur`)** — Schrift-/Logo-Wände zwischen zwei parallelen Ebenen
  (extrusion-bands.js) → SURFACE_OF_LINEAR_EXTRUSION über kubischer B-Spline durch die Netzpunkte (spline-fit.js,
  extrusion-plans.js); Deck-/Bodenfläche teilen dieselben Spline-Kanten; Prüfung/Anwenden über validateArcBands/applyArcBands.
  Echte Kreise bleiben Zylinder, geschlossene Konturen in 3 Stücke, Ecken-Wächter. Schalter `analysis.extrusionBands`
  (Standard an). NozzleBox 3537 → 1621 Flächen (AUS 3541 → 1625), OCP valid, BOP unverändert; Kabelhalter unverändert,
  Skoda 18377 → 18369. step-strict prüft Extrusionen. Testkörper: `node tests/gravur-regression.mjs` (nicht in npm test).
  Offen: CST-Test (B-Spline-Kanten neu dort), VCD-Logo Kabelhalter (Fächer-Wände, oben ≠ unten verschoben),
  Unit-Test Ecken-Wächter, OCP-Volumen bei Spline-Wänden leicht zu groß (Tessellierung stimmt).
- [x] **Freiform Etappe 1 (2026-10-29, `wt/freiform1`)** — neue Module freeform-*.js: fit-basierte Segmentierung
  (Ebene/Zylinder/Kegel/Kugel/Torus), Snap (tangentiale Verrundungen, Rollkugel, Eckkugeln), Topologie, Ecken per LM,
  Kanten LINE/CIRCLE oder B-Spline exakt auf beiden Flächen, SPHERICAL_/TOROIDAL_SURFACE. Testkörper (Rundquader r1,
  Platte mit Torus-Loch, Halbkugel auf Zylinder, je gedreht) exakt ohne Facetten. Schalter `analysis.fitSegmentation`
  (true/'auto'), **Standard aus**: am Skoda-Haken scheitert der Weg noch (98 % Facetten, +8 s). Tests: tests/freeform/*.test.mjs
  (noch nicht in npm test). Etappe 2: Rückfall-Streifen als B-Spline-Fläche statt Facetten, Rollkugel-Löser über
  Verrundungsketten, Ecken mit ≥ 4 Flächen (~800 am Skoda); Kegel-Weg ungetestet.
- [x] **NozzleBox (Printables, lokal `samples/`) 8893 → 3537 Flächen (2026-10-29, `wt/nozzlebox`)** — (1) Pinch: Ränder,
  die sich in einer Ecke berühren, zerlegten die ganze ebene Fläche in Einzeldreiecke (Ablageboden 2764 Flächen, dazu
  76 Halbring-Wände facettiert) → splitAtPinches teilt nur den Stern um den Berührpunkt ab; (2) Bohrung mit unsauberen
  Rändern (D-Loch, boreFailWhy 'rims') darf in den Bogen-Pfad. Härtetest z1/z2, expect.maxFaces. Golden: dino 3897 → 3861.
  Rest: Schrift-Gravur (→ erledigt, siehe Gravur), Ösen + Scharnier → erledigt, siehe Kleinteile.
- [x] **Release 0.2.2 (2026-10-28)** — erstmals per CLI signiert (`.dev/amo-sign.sh`, web-ext sign unlisted, Schlüssel aus ClaudeFirefox/AMO-Konto.env), GitHub-Release v0.2.2 mit signierter xpi, updates.json ergänzt.
- [x] **Splitter-Flächen auf Profil-Bögen (2026-10-28, `wt/splitter`)** — findArcBands nahm breite Ebene + erste
  Bogen-Facetten als Schein-Band (Fit-Radius ~200 mm, Toleranz > Pfeilhöhe) → 0,05-mm-Streifen quer über Wand und Fase.
  Vorausschau: reicht das Band ab i+1 weiter, wird i übersprungen. Kabelhalter AN 234 → 218, AUS 475 → 233 Flächen.
  Rest: 1 Stelle mit im STL um 2° verdrehten Fasen-Facetten (bräuchte Netzpunkt-Einfügung).
- [x] **Bögen-Rest am Kabelhalter + Schalter „Blech-Biegungen schärfen“ (2026-10-28, `wt/boegen-rest`, 4–5 MiniMax
  parallel)** — Pfeilhöhen-Prüfung statt Umkreis-Radius (Netzrauschen), kurze Proben unbestimmt, Vollringe in drei
  Bänder mit gemeinsamen Schnitten je Stapel (Ø8,5-Loch beidseitig gefast: 3 Zyl. + 6 Kegel), Gravur neben Bohrung
  (circleRim), Ausweichstufen in bandSurface; Ring-Sperren für Bohrungs-/Mantel-Wände. Schalter `sharpenBends`
  (Standard aus: Biegungen bleiben Teil-Zylinder), findBendGroups, report.bendsKept. Kabelhalter AN 1138 → 234 Flächen /
  0,25 MB, AUS 1824 → 475 / 0,47 MB, OCP gültig. Härtetest p7–p10, 105 Unit-Tests profile-arcs.
- [x] **Profil-Bögen als Teil-Zylinder/-Kegel (2026-10-27, `wt/profil-boegen`, Lead Claude + Code MiniMax)** — neues
  Modul `profile-arcs.js`: Bänder aus Facetten auf zwei koaxialen Kreisen → CYLINDRICAL/CONICAL_SURFACE-Teilflächen mit
  CIRCLE-Bogenkanten aus den geschriebenen Koordinaten; alignBands, Rückfall (gesperrte Bänder), Zeitbudget 2,5 s,
  Schalter analysis.profileArcs. Kabelhalter AN 4076 → 1138 Flächen / 1,28 MB (Tagesbeginn 7,6 MB), AUS 5906 → 1824 /
  1,92 MB, OCP gültig. Golden AUS: block_with_hole_and_fillet 21 → 8, lbracket 14 → 9, plate_4fillets 30 → 10, eBike
  2996 → 2306. Härtetest p1–p6. Offen: Blech-Biegungen werden im AN-Lauf von v1 scharf (Owner-Entscheidung), Rest-
  Fächer/Fasen-Dreiecke (~1600 Ebenen AUS), Bogen-Kanten in split/pairEdgeUses der Schalen-Analyse, Panel-Farben.
- [x] **Parallel-Runde Claude + MiniMax (2026-10-27, 3 Leads)** —
  (1) `wt/sackloch`: Sacklöcher mit flachem Boden (Kreisscheibe) und Bohrspitze 118°/120° (konkaver Kegel + VERTEX_LOOP),
  auch bei Toggle AUS; Rückfall je Bohrung (blockedBores/boreCulprits, boresDropped, STLREV_TEST_BREAK=bore); Härtetest
  s1–s7. Befund: das fischerEbike hat KEINE Sacklöcher (8 der 10 „Bohrungen“ sind Kanal-Stücke, 2 Durchgangslöcher mit
  verrundeter Mündung). (2) `wt/fasen-kegel`: Fasen 10–15° störten den Radius-Fit der Erkennung → Strikt-Durchlauf
  (Welle mit flacher Fase 130 → 4 Flächen); v2c `defeatureConeBands` schärft Rundungen an Kegelwänden (Kegelstumpf
  834 → 3 Flächen). (3) `wt/kanal-rest`: Kanal-Naht exakt (OCP gaps3d 2 → 0, Erwartungsliste bereinigt), kurze
  Zwischengeraden in Anker-Ketten (S-Kurve 21 → 5 Stücke), Ablehnungsgrund in der Ergebniszeile. Golden unverändert.
- [x] **Kabelhalter-Senkung (2026-10-27, `wt/senkung-kabel`, Lead Claude + Code MiniMax)** — Fasen-Pfad (matchRims)
  ordnete Mündungskreise über Kreuz zu (Suchfenster CHAMFER_MAX 3 mm = Plattendicke) → Kegel quer durch die Bohrung,
  Kreiskanten doppelt gleichsinnig, Stufe 1. Jetzt nur Kreise axial außerhalb des eigenen Randes, nächster gewinnt;
  enforcePlanarity vor convertSharpBores (AN mit Bohrungen). Kabelhalter AN: 5163 → 4076 Flächen, 5,8 → 4,55 MB,
  Stufe 0, Zylinder + 2 Kegel, OCP gültig. Härtetest k3/k4. Offen: Rückfall je Merkmal auch für Bohrungen.
- [x] **Runde J (2026-10-27): Mindest-Detailgröße, Kabelhalter-Verrundungen, Bohrungs-Pfad** —
  (A) `mesh-clean.js`: Kanten < τ werden vor dem Region-Growing kollabiert (Ecken/scharfe Kanten geschützt,
  Ebenen-Treue 1e-5, keine Durchdringung); UI „Kleinste Detailgröße“ aus/0,01/**0,02**/0,05/0,1 mm; STEP-Kopf
  UNCERTAINTY 1e-4 statt 0,01 mm. (K) v1 nimmt nur echte Zylinder-Gruppen und tangentiale, ebene Seiten
  (thin-web-Rückfall weg), Rückfall je Merkmal (nur die störende Rundung bleibt facettiert), gefaste Enden →
  Gehrung; Härtetest k1/k2. (B) boreWallOk (Verdrillung > 1 Segment → facettiert), Achse/Zentrum aus den
  Deckebenen (33 Bohrungs-Läufe in Drehlagen neu exakt). Kabelhalter AN: 6361 → 5163 Flächen, 7,6 → 5,8 MB,
  OCP gültig. Golden: eBike AUS 2997 → 2996, sphere_full 3127 → 3133 (Pole), eBike-Erkennung fillets 1 → 0
  (Export unverändert 47 Flächen).
- [x] **Schalen-Klassifikation + Freigang + OCP-Zweitprüfer (2026-10-27, Merge `wt/schalen-freigang`)** — die drei
  bestätigten Review-Funde: (1) je Komponente Volumen + Lage → Hohlräume als BREP_WITH_VOIDS (Würfel mit Hohlraum:
  occt 9000 → 7000 mm³), invertierte Eingabe umgedreht (block_edge_fillet), Finnen/Mini-Taschen verworfen (dino
  9 → 4 Körper, keine geteilte Topologie mehr); (2) Dicht-Urteil je Schale — dichter Körper neben losem Dreieck
  behält Bohrung/Mantel (block_with_hole: 187 → 8 Flächen), kanten-/eckberührende Würfel werden zwei gültige
  Körper; (3) Freigang der Kreis-Umwandlung (circleClear): dünne Stege bleiben facettiert statt selbstdurchdringend
  (r8: occt −33 % → exakt). step-strict: shell-volume, shared-topology, open-shell, loop-overlap. Neue Suiten
  `test:schalen` und `test:ocp` (volles OpenCascade: BRepCheck, BOP, ShapeAnalysis 1e-6, Volumen je Körper;
  Erwartungsliste je Datei — der Kabelhalter-Fehler wäre damit gefunden worden). npm test = 12 Suiten.

- [x] **Runde I (2026-10-27): Kanäle, Mäntel/Kegel, Senkungs-Restfälle** —
  **Kanäle (T):** U-Bögen laufen über die Anker-Kette (3 exakte Stücke statt 15 geknickter; Kreise vorher bis 0,022 mm
  neben ihren Flächen, jetzt ~1e-6), knickfreie Vereinfachung + Abschluss-Gate, D-Profil-Kanäle bleiben facettiert
  (Abflachung erhalten), step-strict ohne Fehlalarm an ≥ 180°-Torus-Bändern; tube-regression 13 Fälle.
  **Mäntel (M):** Zapfen auf Platte, Stufenwelle, konvexe Kegel als CONICAL_SURFACE (cone_frustum/flat 50 → 3, spitzer
  Kegel 49 → 2 mit VERTEX_LOOP), Fasen/Spitzen an Wellen; Schutz gegen verdrillte Wände (wallSpanOk) und verdeckte
  Dellen (srcPointsOk). **Senkungen (F2):** Kegel/Fase zwischen zwei Rundungen (x3, x5, x6 exakt), offene Bänder mit
  mehreren Abschnitten, zwei Altfehler behoben (Körper ohne Rundung wurde eckig: ΔV bis +1719 mm³; Spitze der Breite 0),
  v1 nur noch an senkrechten Kappen; Härtetest prüft jede Datei streng (61 Körper im Soll).

- [x] **v0.2.1 von Mozilla signiert + GitHub-Release (2026-10-27)** — Add-on-ID `{0f69a2ea-bf50-42ba-8055-dba7d55e509f}`
  (neutrale GUID, User wollte keine Firmen-Domain), Selbstvertrieb (unlisted) über AMO, freigeschaltet nach ~20 min.
  `update_url` → `updates.json` im Repo (automatische Updates). Paket per `npm run build:xpi` (nur Laufzeit-Dateien,
  Lizenztexte LGPL von occt-import-js). Release: https://github.com/JustNotesa/stlReverse/releases/tag/v0.2.1
- [x] **STEP-Genauigkeit für ACIS (2026-10-27, bfa2d6d)** — Kabelhalter des Users fehlten in CST Flächen (Winkel ok):
  LINE-Richtung aus ungerundeten Koordinaten, Punkte auf 6 Stellen gerundet → Kanten-Enden bis 1,2e-6 mm neben
  der Linie, OCCT mit 1e-6: 479 Flächen mit Selbstschnitt, 138 mit Lücken. Jetzt Richtung aus den geschriebenen
  Punkten, 9 Nachkommastellen, Eckpunkte auf ihre Ebenen (snapToPlanes). Rest: Eckpunkte, an denen ≥ 4 nicht exakt
  durch einen Punkt laufende Ebenen zusammenkommen, bleiben bis 4,6e-5 mm neben der Ebene.

- [x] **STEP für strikte Importer — CST CAD Navigator/ACIS (2026-10-26)** — User-Befund: Fusion 360 ok, CST verliert
  Flächen. occt und Fusion heilen beim Lesen still, CST nimmt die Datei wörtlich. Neuer Prüfer ohne Heilung
  `tests/step-strict.mjs` (`npm run test:strict`, Teil von `npm test`): Rand-Ketten, Kanten-Nutzung, Punkte auf
  Kurve/Fläche ≤ 1e-4 mm, Umlaufsinn eben/gekrümmt, Außenrand, Schalen-Zusammenhang. Behoben: (1) ORIENTED_EDGE-
  Flags bezogen sich auf den kleineren Punkt-Schlüssel statt auf den EDGE_CURVE-Start → Ränder in praktisch jeder
  Datei unterbrochen (4da905c); (2) Kreis-Orientierung an Bohrungen/Fasen aus der Geometrie (Lochrand im
  Uhrzeigersinn um die Flächennormale, Mantel same_sense passend zur Außennormale); (3) Ebenheit: jede PLANE trägt
  ihre Rand-Punkte ≤ 5e-5 mm (Ausgleichsebene oder Zerlegung in exakt ebene Teilflächen) — Freiformen bis 0,061 mm
  daneben; (4) Richtungen mit 12 Nachkommastellen; (5) je zusammenhängendem Körper eine eigene Schale (dino jetzt
  wasserdicht, 9 Schalen); (6) **Orientierungs-Wächter** je analytischer Fläche (Normalen-Probe gegen die ersetzten
  Dreiecke + Umlauf-Probe), Widerspruch → Fallback; Negativtests per `STLREV_TEST_FLIP` (`npm run test:orient`).
  Ergebnis: 59 177 → 0 Verstöße über alle Samples AN/AUS und alle Härtetest-Körper. Flächenzahl der Freiformen
  steigt (Kugel 2537 → 3127, eBike AUS 2288 → 2997), CAD-Teile unverändert.
- [x] **Konvexe Außenmäntel als echte Zylinder + 4 Bohrungs-Funde (Agent H, 2026-10-26)** — Mantel-Pfad
  (`sharpMantlePlan`/`convertMantles`): beide Ränder = komplette Außen-Loops ebener Deckflächen, harte Gates wie bei
  Bohrungen (+ Kreis liegt in der Deckebene). cylinder 65 → 3 Flächen, washer_thin 67 → 4, washer_chamfered/_filleted
  AN 77 → 6, Volumen gegen den exakten Zylinder rel. −4e-6. Funde: gemischte Mündungen (Ränder aus den aktuellen
  Wandflächen), D-Löcher bleiben D (gleichmäßige Segmentwinkel, 42°-Deckel), geneigte Deckflächen (jeder Loop-Punkt
  axial geprüft), Fallback baut die facettierte Basislinie zuerst (gelochtes eBike 0,7–1,2 s → 0,3–0,4 s).
  `npm run test:mantel`. Ergebnis-Zeile im Popup nennt Mäntel und Sicherheits-Rückfälle.
- [x] **v2: Senkungen geschützt, Bandform statt grober Schranken (Agent F, 2026-10-26)** — Review-Fund HOCH:
  verrundete Senkung wurde komplett weggeschärft (ΔV +55 mm³). Jetzt: Band nur bei tangentialem Anschluss (≤ 25°)
  und Kreisbogen-Profil; Kegel zwischen Rundung und Bohrung wird schräge Wand (nur die Rundung fällt, Senkung bleibt,
  exakt 45°). Schranken „Band ≤ 3× Deckfläche“/RMAX durch Bandform |L| ≥ π·Tiefe ersetzt → Rippe, r=5,5, dünne
  Platte exakt; m32/m64 exakt auf die echten Ebenen gesetzt; offenes Band (nur ein Abschnitt verrundet). 13 neue
  Härtetest-Körper (x1–x7, d2–d5, y1, y2).
- [x] **Erkennung 2–4× schneller, Ergebnis identisch (Agent G2, 2026-10-26)** — recognizePrimitives: flache Fit-
  Puffer, Radix-Index-Sort, Fixpunkt-Abbruch (sphere50k 10,8 s → 2,6 s); tube-sweep simplifyChain ohne
  superquadratischen Aufwand (Freiform-Kanal 50k: 23 s → 2 s) mit Unmöglichkeits-Beweis und Arbeitsbudget.
  Byte-identische STEP-Ausgabe (72/72), Golden-Stress sphere50k ~4 s.

- [x] **Gebogene Kanäle exakt (tube-sweep.js, 2026-10-24)** — neues Modul, läuft nach `recognizePrimitives`
  (Worker + Test-Pipelines), taggt `group.tube`. Erkennung: konkav gekrümmte Komponenten mit genau 2 ebenen
  Mündungen → Querschnitts-Marsch → Profil. **Befund eBike:** die Kanäle sind KEINE senkrechten Kreisrohre —
  der Profilkreis R2.5 liegt auf der Deckfläche, die Bahn startet geneigt (links γ = 24.1°, rechts −20.9°);
  Normalschnitte sind Ellipsen 2.5 × 2.27/2.33. Export daher exakt als gezogenes Profil:
  γ = 0 → CYLINDRICAL/TOROIDAL_SURFACE, γ ≠ 0 → SURFACE_OF_LINEAR_EXTRUSION/SURFACE_OF_REVOLUTION; Übergänge =
  starr mitgeführter Profilkreis (teilen sich exakt 1 Kante), schräge Mündung = ELLIPSE bzw. periodischer
  B-Spline (Schnitt End-Stück ∩ Ebene). Bahn: Anker-Kette (exakte Geraden/Bögen) oder vereinfachte Biarc-Kette.
  **eBike ohne Rundungen: 2367 → 47 Flächen** (27 Rotationsflächen + 2 Bohrungs-Zylinder), wasserdicht, occt ok,
  Volumen +0.047 % (occt fein: −0.046 %, Netz ist einbeschrieben). Bahn ↔ Profilschnitt-Mittelpunkte max 0.0085
  mm, Netz-Vertex ↔ Fläche max 0.032/0.037 mm. eBike mit Rundungen (gleiche Kanäle): 4608 → 2288 (Toggle aus),
  2429 → 109 (an). Synthetik `npm run test:tube`: Gerade+Bogen+Gerade → exakt 2 Zylinder + 1 Torus (R/Winkel auf
  0.005 mm/0.01°), schräger Austritt → ELLIPSE, γ = 20° → Rotation/Extrusion (γ = 19.99°), Delle/Mündungs-
  Fehler/Orientierungsfehler → facettiert + dicht. Report-Felder `tubesConverted`, `tubePieces`.
  Grenze des Wasserdicht-Zählers: eine konsistent umgedrehte Übergangskurve (beide Nutzungen) bleibt „dicht“,
  occt wählt dann das Komplementär-Band → Orientierung ist per occt-Volumen belegt (Probe: +400 % bei Fehler).
- [x] **Bohrungen NACH dem Entrunden → echte Zylinder (Agent D, 2026-10-24)** — Mit „Verrundungen entfernen“
  läuft erst v1/v2/v2b, dann die Bohrungs-Umwandlung. Neuer scharfer Pfad (`sharpBorePlan`/`convertSharpBores`):
  Wand mit genau 2 Rand-Loops, die exakt Innen-Loops zweier paralleler Deckflächen sind; Achse/Radius per
  Kreisfit aus den Rändern → CYLINDRICAL_SURFACE mit vollen Kreiskanten, keine Kegel-Fase mehr. Bohrungs-Abgleich
  gehärtet (nur konkave Vollzylinder, Axial-Gate 0,05 mm absolut, Radius = gemessener Rand-Radius — **tragend,
  nicht lockern**: alte R-relative Toleranzen ergaben nach v2 wasserdichte, aber falsche Körper, ΔV −746 mm³).
  Fallback-Stufe 1: offene Hülle → erst ohne Bohrungen neu bauen, dann facettiert. eBike: 2429 → 2367 Flächen,
  2 Zylinder (r=2,5 exakt), Facetten-Rest 2345, deckungsgleich. Offen: Mischfall (eine Mündung von v2 geschärft,
  andere echte Fase) bleibt facettiert; Kreis-Orientierung beider Deckflächen (.T. bei gemeinsamer Achse)
  für strenge CAD-Importer prüfen; `washer_filleted`-Sample hat konische Lochwand (bleibt Fase-Pfad, korrekt);
  `npm run test:unit` (Jest) scheitert vorbestehend am Import `detectConicalFeatures`.
- [x] **Export ~2,5× schneller (2026-10-24)** — Profiler: ~40 % der Exportzeit in `vtxKey` (3× toFixed je
  Punkt, tausendfach dieselben Punkte). Schlüssel je Punkt-Array per WeakMap gecacht (mit Koordinaten-Prüfung),
  `fixZero` ohne zweites toFixed; v2-Runden bewerten nur noch berührte Kandidaten neu. eBike-Export
  1,1–1,4 s → ~0,45 s, Ergebnisse identisch (Golden, v2, eBike, bore, collinear grün). Befund dabei: von den
  2409 eBike-Facetten stammen fast alle vom gebogenen Kanal (~760 Zylinder-Streifen r≈2,48) → Agent E.
- [x] **v2: Deckflächen-Wahl korrigiert + Härtetest integriert (2026-10-24)** — Härtetest (Agent A, `tests/fixtures-v2`,
  `npm run test:v2`) fand: v2 wählte bei Rundrechteck-Profilen mit in Z unterteilten Wänden eine SEITENWAND als
  Deckfläche (gierige Reihenfolge nach Punktzahl) → wasserdicht, aber nur teilweise entrundet (w1–w3). Fix:
  alle Kandidaten bewerten, den mit den meisten anliegenden Wänden zuerst anwenden, neu bewerten; dazu
  gleichmäßige Bandtiefe (Bandkante auf einer Höhe über P, ≤ max(0,01; 2 %)). w1–w3 jetzt exakt (inkl. v2b:
  scharfe Profilecken), Golden/Kurztest grün, eBike unverändert deckungsgleich mit der Referenz.
  Ebenfalls integriert: kollineare Zwischenpunkte (Agent B, `npm run test:collinear`), Erkennung der eBike-Y-
  Bohrungen (Agent C: Ausweich-Scharnier, wenn der erste Mündungsring flacher knickt als die Lochwand).
- [x] **Body-Defeaturing v2b: Profil-Eckrundungen bei Extrusionsteilen (2026-10-24)** — nach v2 ist die
  Deckflächen-Kontur der Wandquerschnitt; verrundete senkrechte Kanten erscheinen dort als Bogenlauf zwischen
  zwei geraden Wänden. Fall „cross“: Bogen → Schnittpunkt der verlängerten Wände. Fall „end“: Wände gegenläufig
  parallel, Rundung (Radius > Kantenlänge) hat eine ganze Kante ersetzt und endet in einer Ecke → Kante wird als
  neue Wandfläche rekonstruiert (beginnt an der Ecke, senkrecht auf beiden Wänden). Gilt auf beiden Deckflächen
  zugleich (gleiche 2D-Profilposition = gleiche senkrechte Kante). Läufe enden an langen Kanten (tangentiale
  Bögen an beiden Enden einer Geraden wuchsen sonst zusammen). Vollkreise (Löcher) und beidseitig tangentiale
  Halbkreise (Langloch-Enden) bleiben. **eBike: 6/6 Ecken, 2429 Flächen, Volumen 14163,0 mm³ = EXAKT die
  Referenz „ohne rundungen“, Schnittflächen auf allen Höhen identisch (Δ ≤ 0,01 mm²)**, wasserdicht, occt ok.
  Report-Feld `cornersDefeatured`. `exporters.js?v=25`.
- [x] **Kollineare Zwischenpunkte auf geraden Kanten entfernt (2026-10-24)** — im Netz unterteilte gerade Kanten
  (Extrusions-Wände in Z-Streifen, kanonische Punkte defeatureter Kanten, Facetten-Mäntel) waren im STEP Ketten
  kurzer Stücke. `removeCollinearPoints` (exporters.js, direkt vor `assemble`, auch im facettierten Fallback):
  Punkt fällt weg, wenn genau 2 Loops ihn nutzen, mit denselben Nachbarn a,b gegenläufig, a,v,b kollinear (v
  zwischen a und b, sin < 1e-5, ALLE geschluckten Punkte < 1e-4 mm von a–b); gesperrt, wenn a–b schon existiert
  oder ein Loop < 3 Kanten bekäme; circleRim-Loops unberührt. Topologisch neutral (Wasserdicht-Bilanz bleibt).
  **lbracket fein: 42 → 18 Kanten, 36 → 12 Ecken = identisch zum unverteilten Netz, senkrechte Kanten je EIN
  Stück.** cylinder 378 → 189, cone_pointed 432 → 96, plate_4fillets 24 → 12 (an) / 168 → 84 (aus); Flächenzahlen
  unverändert (Golden grün), occt-Volumen/-Fläche gleich (rel. ≤ 2e-6). Schnellweg ohne kollineare Punkte
  (50k-Kugel/Torus ~5 ms). Test: `node tests/collinear-regression.mjs`.
- [x] **Body-Defeaturing v2: Verrundungs-Bänder an Deckflächen von Extrusionsteilen (2026-10-24)** — 2,5D-Teile
  (Skizze extrudiert, Kanten verrundet) haben rund um jede Deckfläche ein geschlossenes Verrundungsband, das an
  geraden Konturabschnitten ein Zylinder, an Bögen ein Torus ist (v1 greift dort nicht). v2 behandelt das ganze
  Band: Wände stehen ⊥ zur Deckfläche → Wandpunkte an der Bandkante werden entlang der Deckflächen-Normale auf
  die Deckebene geschoben (bleiben exakt auf der Wand), neue Kontur = Wandquerschnitt. Schutz: nur geschlossene
  Ringbänder, Band nur an Deckfläche + Wände, gekrümmt (Fasen bleiben), Kontur einfach, Splitter-Facetten mit
  zufällig ⊥ Normale zum Band (sonst 6 Orientierungsfehler am eBike), Größenschranke Band ≤ 3× Deckfläche (sonst
  O(n²) auf Kugeln: 50k-Kugel 50 s). **eBike: 6 Bänder (je Deckfläche Außenrand + 2 Löcher), 4608 → 2499 Flächen,
  wasserdicht, occt ok.** Exaktheit belegt: Schnittfläche in den Verrundungszonen = voller Wandquerschnitt
  (1468,6 mm² auf allen Höhen). Report-Feld `bandsDefeatured`, im Golden-Test. `exporters.js?v=24`.
- [x] **Kanten-Verrundungen werden AUTOMATISCH erkannt → Body-Defeaturing greift ohne Hand-Tagging
  (2026-10-23)** — Phase 1 der Erkennung prüft Teil-Umläufe jetzt streng als gerade Kanten-Verrundung:
  echtes Prisma (alle inneren Scharnier-Kanten ∥ Achse, billig zuerst) → reguläre Gates inkl. „nur von
  EBENEN begrenzt“ → Bogen ≤ 180°, ohne Rettungspfad. Zwei Fehlerursachen behoben: (1) `grow()` nahm den
  Seed ungeprüft auf — eine Ebenen-Facette an der Tangentenkante ruinierte den Fit; (2) der Radius-Fit sah
  breite Nachbar-Ebenen (Schein-Zylinder R≈19.5 statt r=3) → Profilbreiten-Filter (Mantel = gleich breite
  schmale Streifen). **Ergebnis:** block_edge_fillet 14→6, block_with_hole_and_fillet 21→7 (Bohrung bleibt
  CYLINDRICAL), neue Samples `plate_4fillets` (4× R3.00/90° → 6 Flächen) und `lbracket_concave_fillet`
  (konkave Hohlkehle R4.00/90° → 8 Flächen), Ecken exakt im Ebenen-Schnittpunkt, wasserdicht, occt ok.
  Keine neuen Fehlerkennungen auf Kegel/Kugel/Torus. Generator: `tests/fixtures-gen/gen_extrude.mjs`.
- [x] **Zuverlässigkeit Flächen-Gruppierung + Golden-Test (2026-10-23)** — drei ältere Fehler, gefunden per
  Stresstest mit feiner Tessellierung: (1) Region-Growing verglich Nachbar mit Nachbar (≤2°) → bei feinen
  Netzen (CAD-Export „hohe Qualität“, <2°/Facette) kettete es ganze Rundungen zu EINER „Ebene“ (1°-Zylinder:
  Export 2 Flächen, nicht wasserdicht; 50k-Kugel: Export null). (2) Der alte Offset-Test verglich n₁·p₁ mit
  n₂·p₂ bei VERSCHIEDENEN Normalen → abhängig vom Abstand zum Ursprung, zerstückelte leicht gekrümmte
  Flächen willkürlich (eBike 8159 → jetzt 4608 Flächen). (3) `facet normal 0 0 0` wurde als Nullvektor
  übernommen; die Face Unification fasste alle Null-Normalen zu einer Gruppe. **Fix:** neues gemeinsames
  Modul `region-growing.js` (Worker + Node-Tests, vorher dreifach kopiert), Bezug = mittlere Regions-
  Normale + Regions-Ebene, Saat = größte Dreiecke zuerst; Normalen aus der Wicklung (analysis-core.js);
  Face Unification: Null-Normalen nie fusionieren + Ebenheits-Probe nach dem Mitteln. **Golden-Test**
  `npm run test:golden` (Kennzahlen aller Samples + 50k-Kugel/-Torus + Laufzeitgrenzen).
- [x] **Laufzeit-Fix Erkennung (2026-10-23, 6d67e62)** — Phase 1 lief auf Kugeln/Tori O(T²): sphere_full
  62 ms → 101 s (Worker-Abbruch nach 60 s!). Prisma-Vorfilter, gezieltes Merken gescheiterter Achsen,
  Schnell-Abbruch, deterministische Arbeits-Budgets, Naht-Fix im Vertex-Schlüssel. Jetzt 50k-Kugel ~9 s.
  Nebenbefund: die „10 Bohrungen“ des eBike aus 21d846a waren Segmente der gebogenen Bohrung aus dem
  Brute-Force (jetzt 6/5 wie vor der Härtung) → dafür eigener Rohrbogen-Erkenner nötig (offen, s.o.).
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

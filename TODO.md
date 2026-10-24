# TODO - STL Reverse Add-on

*Stand: 2026-10-23 — Zuverlässigkeits-Etappe: Laufzeit-Fix Erkennung, Region-Growing als gemeinsames
Modul (kein Verketten mehr bei feiner Tessellierung), Golden-Regressionstest. Testen im eingebauten
Browser + Node-Harness (Firefox erst beim Packaging).*

**Tests (vor jedem Commit):** `npm run test:golden` (alle Samples gegen `tests/golden.json` + 50k-Stressnetze,
Laufzeitgrenzen) und `npm run test:bore`. Gewollte Änderungen: `npm run test:golden -- --update`, Diff prüfen, committen.

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
  - **Blind­löcher** (Sackloch: 1 Rand-Loop statt 2) — braucht Boden-Cap (flach/rund). 4 der 6 fischerEbike-
    Bohrungen sind Blindlöcher (vermutlich verrundeter Boden → nicht sauber als Zylinder+Scheibe darstellbar).
  - **Geneigte/verrundete Loch-Mündungen** — wenn die Mündung nicht ~⟂ auf einer Flachfläche sitzt
    (fischerEbike id=1/id=5: ~10–20° schräg) findet das Rand-Matching keinen Innen-Loop → Fallback.
    Evtl. Toleranz lockern + per-Vertex-Radialtest als Schutz.
  - **Außen-Zylinder** (Vollzylinder, nicht Loch): Rand sitzt am AUSSEN-Loop der Deckel, nicht am Innen-Loop —
    Matching müsste auch Outer-Loops prüfen.
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
  (torus-proto). GEBOGENE Löcher (grün umrandet) bleiben in jedem Fall facettiert.
- [ ] **v2: verpasste Fälle aus dem Härtetest (sicher übersprungen, aber nicht entrundet)** — schmale Deckfläche
  (Rippe 40×4: Band > 3× Deckfläche), großer Radius r > 5 mm (RMAX = 5), dünne Platte (RMAX = 0,45·Höhe < r),
  dünne Rohre/Ringe. `node tests/fixtures-v2/check.mjs --only l,s,t2`. Schranken sind Laufzeit-/Sicherheitsnetze;
  feiner begründen (z.B. Band-Breite statt Fläche).
- [ ] **v2: feine Rundungen (N ≥ 32) versetzen Deckebene um µm** — Region-Growing schlägt die flachste Bandschicht
  der Deckfläche zu; Ebene aus dem Mittel der Loop-Punkte. ≤ r·(1−cos 2°), unter STEP-Unsicherheit. Abhilfe:
  exakte Ebene aus der ursprünglichen Deckflächen-Gruppe. `check.mjs --only m32,m64`.
- [ ] **Ecken, an denen 3 Verrundungen zusammenlaufen (Kugel-Eckstück)** — v1/v2 überspringen sie bewusst.
- [ ] **Rohrbogen-Erkenner (gebogene Bohrung)** — eine gebogene Bohrung ist lokal eine Kette exakter
  Zylinder-Segmente (alle Längskanten eines Segments parallel). Statt Brute-Force (O(T²), s. Erledigt) gezielt:
  Segment finden → entlang der Kette weiterlaufen → als ein Feature taggen (Panel 3), Export bleibt facettiert.
- [ ] **Review der Etappen 05fb3c3…6d67e62 abschließen** — Workflow-Lauf `wf_a998fde1-33d` wurde durch einen
  Absturz unterbrochen (Bereiche: Erkennung, Fasen-Export, Defeaturing, STEP-Gültigkeit, Integration).
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

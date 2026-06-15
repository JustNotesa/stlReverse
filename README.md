# STL Reverse Parametric Sketch

Ein WebExtension-Addon für Firefox/Chrome, das STL-Dreiecksmeshes lokal analysiert und daraus eine heuristische parametrische Beschreibung inkl. Orthoprojektionen ableitet. Die resultierenden Daten lassen sich als JSON exportieren und in einem CAD-Workflow weiterverwenden.

## Features
- **Drag & Drop / Dateiupload** für ASCII- und binäre `.stl`-Dateien mit rein lokaler Verarbeitung.
- **Maßangaben** zu Breite/Tiefe/Höhe, Dreiecksanzahl sowie geschätzter Oberfläche und Volumen.
- **Orthoprojektionen (XY, YZ, ZX)** als konvexe Hüllen der projizierten Punktwolke inkl. Canvas-Preview.
- **Live 3D Ansicht** mit dreh-/zoombarer pseudo-isometrischer Vorschau und umschaltbarer STEP-Volumenansicht aus den heuristischen Prismen.
- **STEP Webviewer (Beta)** nutzt Three.js + OrbitControls für eine interaktive WebGL-Vorschau des heuristischen Volumenexports – auf Wunsch lässt sich eine eigene `.step`-Datei laden.
- **Planarer Flächendetektor**, der Flächen nach Normalvektor clustert, deren Versatz sowie Spannweiten ermittelt und diese als parametrische Constraints ausgibt.
- **Zylindrische Feature-Erkennung** für Achsen entlang X/Y/Z sowie schräg liegende Rotationskörper (Heuristik via Normal-/PCA-Analyse) inkl. Radius, Länge, Zentrum und Flächenanteil.
- **Detail-Slider** für die Orthoprojektionen (Standard + manuelles Feintuning), damit STEP/DXF-Zeichnungen mehr bzw. weniger Konturen enthalten.
- **Export** der kompletten Analyse als JSON sowie komfortabler Copy-to-Clipboard-Button.
- **Konische Feature-Erkennung (Kegel)** erkennt kegelförmige Oberflächen mit linearer Radiusänderung entlang einer Achse, inkl. Kegelwinkel, Radien oben/unten und Länge.
- **Sphärische Feature-Erkennung (Kugeln)** erkennt kugelförmige oder halbkugelförmige Oberflächen mit Radius, Zentrum und Abdeckungsgrad (Vollkugel, Halbkugel, Teilkugel).
- **DXF-Exporter** mit Layer-Support (separate Layer pro Projektionsebene XY/YZ/ZX), Farbcodierung, Einheiten-Header (Millimeter) und Maßannotationen.
- **STEP Skizze (Step 1)** erzeugt eine STEP-Datei mit allen orthogonalen Konturen.
- **STEP Volumen (Step 2, Beta)** rekonstruiert ein detailabhängiges Höhenfeld, setzt daraus Quaderprismen zusammen und exportiert das heuristische CSG-Volumen (geeignet, um Taschen/Bohrungen grob abzubilden).
- **Status-Banner + Fortschrittsanzeige** zeigen Upload-/Analyse-Fortschritt oder Fehlermeldungen direkt in der Oberfläche an.
- **Mehrstufige Fortschrittsanzeige** mit benannten Analyse-Schritten (Datei lesen, Worker, Features, Exporte) liefert klares Feedback über den aktuellen Status.

## Installation (temporär)
1. Repository herunterladen oder entpacken.
2. Browser öffnen:
   - **Firefox**: `about:debugging` → "Dieses Firefox" → "Temporäres Add-on laden" → `manifest.json` auswählen.
   - **Chromium**: `chrome://extensions` → Entwicklermodus aktivieren → "Entpackte Erweiterung laden" → Ordner `stlReverse` wählen.
3. Über das Toolbar-Icon wird automatisch ein neuer Tab mit der Analyseoberfläche geöffnet (das vermeidet, dass Datei-Dialoge Popups schließen).
4. Derzeit läuft die Erweiterung auf Manifest V2 (hintergrundskript), wodurch Firefox keine speziellen Flags benötigt.

## Nutzung
1. STL-Datei in die Drop-Zone ziehen oder über den Dateidialog wählen.
2. Während der Analyse zeigt die Fortschrittsanzeige (inkl. Prozentbalken) die aktuellen Schritte.
3. Über den Detail-Slider kannst du die automatische Kontur-Analyse verfeinern. Änderungen lösen eine Neu-Berechnung aus.
4. Nach Abschluss erscheinen Maße, Projektionen, erkannte planare und zylindrische Features (axial oder schräg) sowie die generierte JSON-Beschreibung.
5. Über `DXF exportieren`, `STEP Skizze (Step 1)` und `STEP Volumen (Step 2)` lassen sich Zeichnung bzw. Volumenmodell exportieren. `JSON exportieren`/`Kopieren` liefert die vollständige Parametrik.
6. Optional das Ergebnis im `samples/`-Ordner testen (`samples/cube_ascii.stl`).

## Parametrische JSON-Struktur (Kurzfassung)
```json
{
  "meta": {
    "fileName": "part.stl",
    "triangles": 12345,
    "surfaceArea": 123.4,
    "volume": 456.7
  },
  "boundingBox": {
    "width": 10,
    "depth": 20,
    "height": 30
  },
  "outlines": {
    "XY": { "points": [[0,0], [10,0], ...], "area": 200, "perimeter": 60 },
    "YZ": { ... },
    "ZX": { ... }
  },
  "planes": [
    {
      "orientation": "XY",
      "offsetAxis": "Z",
      "offsetCoordinate": 12.5,
      "area": 80.2,
      "spans": [{ "axis": "X", "size": 30 }, { "axis": "Y", "size": 20 }],
      "centroid": { "x": 15, "y": 10, "z": 12.5 },
      "normal": [0, 0, 1]
    }
  ],
  "cylinders": [
    {
      "type": "axial",
      "axis": "Z",
      "axisVector": [0, 0, 1],
      "radius": 5,
      "length": 20,
      "center": { "x": 15, "y": 10, "z": 12 },
      "surfaceArea": 628.3
    }
  ],
  "cones": [
    {
      "type": "cone",
      "axis": "Z",
      "radiusTop": 2,
      "radiusBottom": 8,
      "taperAngle": 15.5,
      "length": 20,
      "center": { "x": 10, "y": 10, "z": 15 },
      "surfaceArea": 450.2
    }
  ],
  "spheres": [
    {
      "type": "sphere",
      "sphereType": "hemisphere",
      "radius": 10,
      "center": { "x": 20, "y": 20, "z": 10 },
      "coverage": 0.5,
      "surfaceArea": 628.3
    }
  ]
}
```

## Heuristiken & Grenzen
- Die Planaritätsprüfung basiert auf Normalvektoren und quantisiertem Versatz. Sehr kleine Flächen (< ~0.5 Einheiten²) werden ignoriert, um Mesh-Rauschen zu reduzieren.
- Orthoprojektionen verwenden konvexe Hüllen; konkave Details oder Durchbrüche werden dabei ggf. "aufgefüllt".
- Zylindrische Features werden heuristisch erkannt; stark verrauschte oder freiformige/konische Oberflächen können fehlklassifiziert werden und sollten manuell überprüft werden.

## Entwicklung & Tests
- Quellcode ist als native ES-Module organisiert (`popup.js` importiert `analysis-core.js`).
- Schneller Smoke-Test mit Node.js:
  ```bash
  node --input-type=module <<'NODE'
  import { promises as fs } from 'fs';
  import { parseStl, analyseMesh } from './analysis-core.js';
  const buf = await fs.readFile('samples/cube_ascii.stl');
  const mesh = parseStl(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  console.log(analyseMesh(mesh, 'cube_ascii.stl').meta);
  NODE
  ```
- Keine externen Abhängigkeiten erforderlich; das Styling ist rein CSS-basiert.

## To-do-Ideen
- Verfeinerte Freiform-/Kegel-Erkennung inkl. Robustheitsprüfungen gegen Mesh-Rauschen.
- Volumenmodell (Step 2) weiter anreichern (z. B. extrudierte Umrisse, Taschen/Fasen).
- DXF/STEP-Exporter um Layer, Einheiten-Annotationen und DWG/IGES-Ausgabe ergänzen.
- Parametrische Constraint-Bearbeitung und einfache Sketch-Bearbeitung direkt in der UI.

# CLAUDE.md — STL Reverse Firefox Add-on

## Pflichtschritte zu Beginn jeder Session

1. **TODO.md lesen** — `TODO.md` im Projektverzeichnis ist die primäre Aufgabenliste. Immer zuerst lesen, erledigte Punkte abhaken, neue Aufgaben eintragen.
2. **TODO.md aktuell halten** — Abgeschlossene Tasks sofort in den "Erledigt"-Abschnitt verschieben. Neue Tasks sofort eintragen.

## Nach jeder Implementierung — Screenshots

Screenshots **immer** mit dem **Playwright MCP** (Firefox) machen — kein Puppeteer, keine node-Skripte:

```bash
# 1. HTTP-Server starten (einmalig pro Session, falls nicht läuft)
python3 -m http.server 8888
# → http://localhost:8888/popup.html
```

### Playwright MCP — Ablauf

```
1. mcp__playwright__browser_navigate → http://localhost:8888/popup.html
2. mcp__playwright__browser_click    → ref des "Choose File" Buttons (aus snapshot)
3. mcp__playwright__browser_file_upload → absoluter Pfad zur STL-Datei
4. mcp__playwright__browser_wait_for → text: "Analyse abgeschlossen"
5. mcp__playwright__browser_take_screenshot → je Panel (siehe unten)
```

### Die 4 Panel-Selektoren (ref aus snapshot verwenden)

| Panel | Element-ID | Inhalt |
|-------|-----------|--------|
| 1 | `#stl-viewer` | Original STL Mesh |
| 2 | `#features-viewer` | Erkannte Features |
| 3 | `#brep-viewer` | Rekonstruiertes B-Rep |
| 4 | `#step-occt-viewer` | STEP-Datei (geparsed) |

**Regeln:**
- Immer alle 4 Panels screenshotten nach jeder Implementierung
- Kein `fullPage`, keine Buttons/Tabellen, nur die Panels
- Nur die Datei screenshotten die gerade getestet wird
- Screenshots speichern in `tests/screenshots/` mit sprechendem Namen z.B. `fahrrad-panel1-stl.png`

### Falls Firefox-MCP crasht

Das MCP-Profil kann gesperrt sein (laufende Firefox-Instanz):
```bash
pkill -f "mcp-firefox"
rm -rf ~/Library/Caches/ms-playwright/mcp-firefox-*
# Dann erneut mcp__playwright__browser_navigate aufrufen
```

## Projektarchitektur (Kurzübersicht)

- **Manifest V2**, ES6 Modules, Web Worker, Three.js
- **Hauptdateien**: `popup.js` (UI + Koordination), `analysis-core.js` (STL-Parsing + Analyse), `analysis-worker.js` (Worker-Wrapper), `segmentation.js` (V2 Topologie-Segmentierung), `exporters.js` (STEP/DXF/SVG Export)
- **Samples**: `samples/` — cube_ascii.stl, cylinder.stl, block_with_hole.stl, cone_pointed.stl, dino_clip.stl
- **Tests**: Jest (Unit), Playwright (E2E + Visual Regression)

## Roadmap (Kurzversion)

- **V1**: STL → geometrisch korrekte STEP-Datei (BRep, Planes + Zylinder + Kegel — fertig)
- **V2**: Topologie-basierte Segmentierung → Feature-Erkennung → parametrisches STEP (in Arbeit)
- Details in `TODO.md`

## Wichtige Entscheidungen

- Keine externen Analyse-Dependencies — alles pure JS
- `opencascade.js` (~30 MB WASM) ist zu schwer für Firefox Extension — nicht verwenden
- `online-3d-viewer` (mit occt-import-js ~7.6 MB) ist akzeptabel für STEP-Inline-Viewer
- CSP für occt-import-js: `unsafe-eval` (nicht `wasm-unsafe-eval`) — Emscripten braucht zusätzlich `new Function()`

/**
 * Unit-Tests für analysis-core.js und die HEUTIGE Erkennungs-Pipeline.
 *
 * Modernisiert 2026-10: analyseMesh liefert keine Primitive mehr (planes/
 * cylinders/spheres/cones und die alten detect*Features-Funktionen wurden
 * entfernt — die Erkennung lebt heute in eigenen Modulen). Getestet wird
 * deshalb derselbe Ablauf wie im Worker (vgl. analysis-worker.js bzw.
 * tests/pipeline.cjs):
 *
 *   parseStl → simplifyMesh (>50k) → buildNormalGroups (region-growing.js)
 *   → unifyCoplanarGroups (face-unification.js)
 *   → recognizePrimitives (primitive-recognition.js)
 *   → detectTubes (tube-sweep.js)
 *
 * Alle Erwartungswerte sind an der heutigen Pipeline GEMESSEN (Stand cb65fb1)
 * und decken sich mit tests/golden.json. Exakte Gesamt-Zählungen pro Sample
 * pinnt weiterhin der Golden-Test — hier stehen die SEMANTISCHEN Aussagen
 * (richtiger Radius, richtige Achse, richtige Anzahl der echten Features).
 *
 * Begriffe: kind 'bore' = voller 360°-Zylinder (auch ein konvexer Außenmantel
 * zählt so), kind 'fillet' = Teilzylinder (Verrundung).
 */

import { jest } from '@jest/globals';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import {
  parseStl,
  analyseMesh,
  simplifyMesh,
  computeBoundingBox,
  projectOutline
} from '../analysis-core.js';
import { buildNormalGroups } from '../region-growing.js';
import { cleanMesh } from '../mesh-clean.js';
import { unifyCoplanarGroups } from '../face-unification.js';
import { recognizePrimitives } from '../primitive-recognition.js';
import { detectTubes } from '../tube-sweep.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Großzügig: die Maschine ist oft stark ausgelastet (parallele Agents).
jest.setTimeout(120000);


// Hilfsfunktion: STL-Datei laden und als ArrayBuffer zurückgeben
const loadStl = (name) => {
  const content = readFileSync(join(__dirname, '../samples', name));
  return content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength);
};

// Worker-Pipeline bis zur Erkennung (einmal pro Datei, danach aus dem Cache)
const recognitionCache = new Map();
function runRecognition(file) {
  if (recognitionCache.has(file)) return recognitionCache.get(file);
  let mesh = cleanMesh(parseStl(loadStl(file), () => {})).mesh;   // Netz-Bereinigung wie im Worker
  if (mesh.faces.length > SIMPLIFY_ABOVE) mesh = simplifyMesh(mesh, SIMPLIFY_TARGET,  // wie analysis-worker.js
    () => {});
  let groups = buildNormalGroups(mesh);
  groups = unifyCoplanarGroups(groups).unified
    .sort((a, b) => b.vertices.length - a.vertices.length);
  const { primitives, stats } = recognizePrimitives(groups);
  const { tubes, stats: tubeStats } = detectTubes(groups);
  const result = { mesh, groups, primitives, stats, tubes, tubeStats };
  recognitionCache.set(file, result);
  return result;
}

// ============================================================
// parseStl — ASCII/Binär-Parsing und Validierung
// ============================================================
describe('parseStl', () => {
  test('sollte eine ASCII STL-Datei korrekt parsen', () => {
    const result = parseStl(loadStl('cube_ascii.stl'));

    expect(result).toBeDefined();
    expect(result.faces).toBeDefined();
    expect(result.vertices).toBeDefined();
    expect(result.faces.length).toBe(12); // Würfel hat 12 Dreiecke (6 Seiten × 2)
  });

  test('sollte eine Binär-STL korrekt parsen (cylinder.stl, 626 Dreiecke)', () => {
    const result = parseStl(loadStl('cylinder.stl'));
    expect(result.faces.length).toBe(626);
    expect(result.vertices.length).toBe(626 * 9);
  });

  test('sollte bei leerer Datei einen Fehler werfen', () => {
    expect(() => parseStl(new ArrayBuffer(0))).toThrow('Leere Datei');
  });

  test('sollte bei null einen Fehler werfen', () => {
    expect(() => parseStl(null)).toThrow('Leere Datei');
  });

  test('sollte Progress-Callback aufrufen', () => {
    const progressCb = jest.fn();
    parseStl(loadStl('cube_ascii.stl'), progressCb);

    expect(progressCb).toHaveBeenCalled();
  });

  test('sollte zu kleine Datei ablehnen (< 84 Bytes)', () => {
    expect(() => parseStl(new ArrayBuffer(50))).toThrow();
  });

  test('sollte abgeschnittene Binär-STL ablehnen', () => {
    // Header behauptet 100 Facetten, aber es ist nur Platz für 10
    const buf = new ArrayBuffer(84 + 10 * 50);
    const dv = new DataView(buf);
    dv.setUint32(80, 100, true);
    expect(() => parseStl(buf)).toThrow();
  });
});

// ============================================================
// analyseMesh — heutige Ergebnisform (keine Primitive mehr)
// ============================================================
describe('analyseMesh - Cube', () => {
  let analysis;

  beforeAll(() => {
    analysis = analyseMesh(parseStl(loadStl('cube_ascii.stl')), 'cube.stl');
  });

  test('sollte Meta-Daten liefern (Dateiname, Dreiecke, Fläche, Volumen)', () => {
    expect(analysis.meta.fileName).toBe('cube.stl');
    expect(analysis.meta.triangles).toBe(12);
    // Einheitswürfel: Oberfläche 6, Volumen 1
    expect(analysis.meta.surfaceArea).toBeCloseTo(6, 2);
    expect(analysis.meta.volume).toBeCloseTo(1, 2);
  });

  test('sollte Bounding Box korrekt berechnen (1×1×1)', () => {
    expect(analysis.boundingBox.width).toBeCloseTo(1, 2);
    expect(analysis.boundingBox.depth).toBeCloseTo(1, 2);
    expect(analysis.boundingBox.height).toBeCloseTo(1, 2);
  });

  test('sollte Umriss-Projektionen für XY/YZ/ZX liefern', () => {
    expect(Object.keys(analysis.outlines).sort()).toEqual(['XY', 'YZ', 'ZX']);
    expect(analysis.outlines.XY.area).toBeCloseTo(1, 2);
    expect(analysis.outlines.XY.perimeter).toBeCloseTo(4, 2);
    expect(analysis.outlines.XY.hull.length).toBe(4); // Quadrat
  });

  test('sollte Vorschau-Punkte und Viewer-Dreiecke liefern', () => {
    expect(analysis.previewPoints.length).toBeGreaterThan(0);
    expect(analysis.triangles.length).toBe(12);
    expect(analysis.triangles[0].vertices).toHaveLength(3);
    expect(analysis.triangles[0].normal).toHaveLength(3);
  });

  test('liefert KEINE Primitive mehr (Erkennung lebt in den Pipeline-Modulen)', () => {
    // Dokumentiert den Umzug: planes/cylinders/spheres/cones gibt es am
    // Analyse-Ergebnis nicht mehr — siehe recognizePrimitives/detectTubes unten.
    expect(analysis.planes).toBeUndefined();
    expect(analysis.cylinders).toBeUndefined();
    expect(analysis.spheres).toBeUndefined();
    expect(analysis.cones).toBeUndefined();
  });
});

describe('analyseMesh - reale Samples (Parsing + Bounding Box)', () => {
  test('cylinder.stl: 626 Dreiecke, 4×4×15, Volumen ≈ π·r²·h', () => {
    const analysis = analyseMesh(parseStl(loadStl('cylinder.stl')), 'cylinder.stl');
    expect(analysis.meta.triangles).toBe(626);
    expect(analysis.boundingBox.width).toBeCloseTo(4.0, 1);
    expect(analysis.boundingBox.depth).toBeCloseTo(4.0, 1);
    expect(analysis.boundingBox.height).toBeCloseTo(15.0, 1);
    // π × 2² × 15 ≈ 188.5 (tesselliert etwas kleiner)
    expect(analysis.meta.volume).toBeGreaterThan(150);
    expect(analysis.meta.volume).toBeLessThan(250);
  });

  test('block_with_hole.stl: 1464 Dreiecke, Würfel 25.6³, Volumen < Vollwürfel', () => {
    const analysis = analyseMesh(parseStl(loadStl('block_with_hole.stl')), 'block_with_hole.stl');
    expect(analysis.meta.triangles).toBe(1464);
    expect(analysis.boundingBox.width).toBeCloseTo(25.6, 1);
    expect(analysis.boundingBox.depth).toBeCloseTo(25.6, 1);
    expect(analysis.boundingBox.height).toBeCloseTo(25.6, 1);
    const cubeVolume = 25.6 ** 3; // ~16777 — Bohrung ist abgezogen
    expect(analysis.meta.volume).toBeLessThan(cubeVolume);
    expect(analysis.meta.volume).toBeGreaterThan(10000);
  });

  test('dino_clip: 3942 Dreiecke, Bounding Box ≈ 75.8 × 75.9 × 18.0', () => {
    const analysis = analyseMesh(parseStl(loadStl('dino_clip_v3_04-strong-closing.stl')), 'dino_clip.stl');
    expect(analysis.meta.triangles).toBe(3942);
    expect(analysis.boundingBox.width).toBeCloseTo(75.81, 1);
    expect(analysis.boundingBox.depth).toBeCloseTo(75.95, 1);
    expect(analysis.boundingBox.height).toBeCloseTo(18.01, 1);
  });

  test('eBike-Mount: 11594 Dreiecke, Bounding Box 61 × 10 × 35', () => {
    const analysis = analyseMesh(
      parseStl(loadStl('fischerEbike - FahrradLicht - mount unter sattel.stl')),
      'fischerEbike.stl'
    );
    expect(analysis.meta.triangles).toBe(11594);
    expect(analysis.boundingBox.width).toBeCloseTo(61.0, 1);
    expect(analysis.boundingBox.depth).toBeCloseTo(10.0, 1);
    expect(analysis.boundingBox.height).toBeCloseTo(35.0, 1);
  });
});

// ============================================================
// computeBoundingBox — nimmt die FLACHE Vertex-Liste (Float32Array)
// ============================================================
describe('computeBoundingBox', () => {
  test('sollte BoundingBox aus der Vertex-Liste berechnen', () => {
    const mesh = parseStl(loadStl('cube_ascii.stl'));
    const bbox = computeBoundingBox(mesh.vertices);

    expect(bbox.min).toEqual([0, 0, 0]);
    expect(bbox.max).toEqual([1, 1, 1]);
    expect(bbox.width).toBeCloseTo(1, 3);
    expect(bbox.depth).toBeCloseTo(1, 3);
    expect(bbox.height).toBeCloseTo(1, 3);
  });

  test('sollte für leere Vertex-Liste eine Null-Box liefern', () => {
    const bbox = computeBoundingBox(new Float32Array(0));
    expect(bbox.width).toBe(0);
    expect(bbox.min).toEqual([0, 0, 0]);
    expect(bbox.max).toEqual([0, 0, 0]);
  });
});

// ============================================================
// projectOutline — 2D-Umriss (konvexe Hülle) einer Projektion
// ============================================================
describe('projectOutline', () => {
  test('Würfel auf XY: Fläche 1, Umfang 4, 4 Hüllpunkte', () => {
    const mesh = parseStl(loadStl('cube_ascii.stl'));
    const outline = projectOutline(mesh.vertices, 'XY', 0.6);

    expect(outline.area).toBeCloseTo(1, 2);
    expect(outline.perimeter).toBeCloseTo(4, 2);
    expect(outline.hull.length).toBe(4);
    expect(outline.bounds).toEqual({ minX: 0, maxX: 1, minY: 0, maxY: 1 });
  });

  test('Würfel auf YZ: ebenfalls Einheitsquadrat', () => {
    const mesh = parseStl(loadStl('cube_ascii.stl'));
    const outline = projectOutline(mesh.vertices, 'YZ', 0.6);
    expect(outline.area).toBeCloseTo(1, 2);
    expect(outline.hull.length).toBe(4);
  });
});

// ============================================================
// simplifyMesh — Mesh-Dezimierung
// ============================================================
describe('simplifyMesh', () => {
  test('sollte Mesh auf Ziel-Facecount reduzieren', () => {
    const mesh = parseStl(loadStl('block_with_hole.stl'));
    const target = 500;
    const simplified = simplifyMesh(mesh, target);

    expect(simplified.faces.length).toBeLessThanOrEqual(target);
    expect(simplified.faces.length).toBeGreaterThan(0);
    expect(simplified.vertices).toBeDefined();
  });

  test('sollte Mesh unverändert lassen wenn unter Target', () => {
    const mesh = parseStl(loadStl('cube_ascii.stl')); // 12 Faces
    const simplified = simplifyMesh(mesh, 1000);

    expect(simplified.faces.length).toBe(mesh.faces.length);
  });

  test('sollte nach Simplification gültige Normalen haben', () => {
    const mesh = parseStl(loadStl('block_with_hole.stl'));
    const simplified = simplifyMesh(mesh, 500);

    simplified.faces.forEach(face => {
      expect(face.normal).toBeDefined();
      expect(face.normal.length).toBe(3);
      const len = Math.sqrt(face.normal[0] ** 2 + face.normal[1] ** 2 + face.normal[2] ** 2);
      expect(len).toBeGreaterThan(0.5);
    });
  });

  test('sollte Progress-Callback aufrufen', () => {
    const mesh = parseStl(loadStl('block_with_hole.stl'));
    const progressCb = jest.fn();
    simplifyMesh(mesh, 500, progressCb);

    expect(progressCb).toHaveBeenCalled();
  });
});

// ============================================================
// Pipeline: cylinder.stl — CAD-Zylinder (r=2, h=15, Z-Achse)
// ============================================================
describe('Pipeline - Cylinder (recognizePrimitives)', () => {
  let run;

  beforeAll(() => {
    run = runRecognition('cylinder.stl');
  });

  test('sollte genau 1 vollen Zylinder erkennen', () => {
    expect(run.stats.cylinders).toBe(1);
    expect(run.stats.bores).toBe(1); // voller Außenmantel zählt als kind 'bore'
    expect(run.stats.fillets).toBe(0);
    expect(run.primitives).toHaveLength(1);
    expect(run.primitives[0].full).toBe(true);
  });

  test('Radius sollte ≈ 2 sein', () => {
    expect(run.primitives[0].radius).toBeCloseTo(2.0, 1);
  });

  test('Achse sollte ±Z sein', () => {
    expect(Math.abs(run.primitives[0].axis[2])).toBeGreaterThan(0.999);
  });

  test('Höhe sollte ≈ 15 sein', () => {
    expect(run.primitives[0].height).toBeCloseTo(15.0, 1);
  });

  test('sollte die Zylinder-Gruppen mit group.primitive taggen', () => {
    const tagged = run.groups.filter(g => g.primitive);
    expect(tagged.length).toBeGreaterThan(0);
    expect(tagged[0].primitive.type).toBe('cylinder');
  });

  test('sollte keine Kanäle finden', () => {
    expect(run.tubeStats.tubes).toBe(0);
  });
});

// ============================================================
// Pipeline: block_with_hole.stl — Würfel mit Durchgangsbohrung
// ============================================================
describe('Pipeline - Block with Hole', () => {
  let run;

  beforeAll(() => {
    run = runRecognition('block_with_hole.stl');
  });

  test('sollte genau 1 Bohrung erkennen (keine Fillets)', () => {
    expect(run.stats.bores).toBe(1);
    expect(run.stats.fillets).toBe(0);
  });

  test('Bohrungsradius sollte ≈ 3.92 sein', () => {
    expect(run.primitives[0].radius).toBeCloseTo(3.92, 1);
  });

  test('Bohrung sollte ±Z-Achse haben und durchgehen (Höhe ≈ 25.6)', () => {
    expect(Math.abs(run.primitives[0].axis[2])).toBeGreaterThan(0.999);
    expect(run.primitives[0].height).toBeCloseTo(25.6, 1);
  });

  test('sollte keine Kanäle finden', () => {
    expect(run.tubeStats.tubes).toBe(0);
  });
});

// ============================================================
// Pipeline: washer_thin.stl — zwei konzentrische Voll-Zylinder
// ============================================================
describe('Pipeline - Washer (konzentrische Zylinder)', () => {
  let run;

  beforeAll(() => {
    run = runRecognition('washer_thin.stl');
  });

  test('sollte 2 volle Zylinder erkennen (Loch r=8 und Außenmantel r=15)', () => {
    expect(run.stats.cylinders).toBe(2);
    const radii = run.primitives.map(p => p.radius).sort((a, b) => a - b);
    expect(radii[0]).toBeCloseTo(8.0, 1);
    expect(radii[1]).toBeCloseTo(15.0, 1);
  });

  test('beide sollten Z-Achse und Plattendicke 4 haben', () => {
    for (const p of run.primitives) {
      expect(Math.abs(p.axis[2])).toBeGreaterThan(0.999);
      expect(p.height).toBeCloseTo(4.0, 1);
    }
  });
});

// ============================================================
// Pipeline: Negativkontrollen — kein False-Positive-Zylinder
// ============================================================
describe('Pipeline - Negativkontrollen', () => {
  test('cube_ascii.stl: keine Zylinder, keine Kanäle', () => {
    const run = runRecognition('cube_ascii.stl');
    expect(run.stats.cylinders).toBe(0);
    expect(run.tubeStats.tubes).toBe(0);
  });

  test('cone_pointed.stl: Kegelmantel ist KEIN Zylinder', () => {
    const run = runRecognition('cone_pointed.stl');
    expect(run.stats.cylinders).toBe(0);
    expect(run.tubeStats.tubes).toBe(0);
  });

  test('sphere_full.stl: Kugel ist KEIN Zylinder', () => {
    const run = runRecognition('sphere_full.stl');
    expect(run.stats.cylinders).toBe(0);
    expect(run.tubeStats.tubes).toBe(0);
  });
});

// ============================================================
// Pipeline: dino_clip — organische Form mit 4 kleinen Rundlöchern
// ============================================================
describe('Pipeline - Dino Clip', () => {
  let run;

  beforeAll(() => {
    run = runRecognition('dino_clip_v3_04-strong-closing.stl');
  });

  test('sollte 4 kleine Voll-Zylinder finden (wie golden.json: bores=4)', () => {
    // Gemessen an cb65fb1: 4 kleine Rundlöcher (r ≈ 4.3–4.5, je ≤ 40 Dreiecke).
    // Die organische Außenhaut liefert KEINE falschen Zylinder.
    expect(run.stats.bores).toBe(4);
    expect(run.stats.fillets).toBe(0);
    for (const p of run.primitives) {
      expect(p.radius).toBeGreaterThan(4);
      expect(p.radius).toBeLessThan(5);
      expect(p.triCount).toBeLessThanOrEqual(40);
    }
  });

  test('sollte keine Kanäle finden', () => {
    expect(run.tubeStats.tubes).toBe(0);
  });
});

// ============================================================
// Pipeline: eBike-Mount — echte Bohrungen + gebogene Kanäle
// ============================================================
describe('Pipeline - FischerEbike Mount (Bohrungen + Kanäle)', () => {
  let run;

  beforeAll(() => {
    run = runRecognition('fischerEbike - FahrradLicht - mount unter sattel.stl');
  });

  test('sollte genau die 2 echten Schraubbohrungen entlang ±Y finden (r ≈ 2.51)', () => {
    // Die Erkennung taggt daneben auch Kanalwand-Stücke als Zylinder
    // (Gesamtzahl pinnt der Golden-Test) — die ECHTEN Bohrungen sind die
    // beiden vollen Zylinder quer durchs Teil entlang der Y-Achse.
    const yBores = run.primitives.filter(p => p.full && Math.abs(p.axis[1]) > 0.99);
    expect(yBores).toHaveLength(2);
    for (const b of yBores) {
      expect(b.radius).toBeCloseTo(2.51, 1);
    }
  });

  test('detectTubes sollte genau 2 gebogene Kanäle finden', () => {
    expect(run.tubeStats.tubes).toBe(2);
    expect(run.tubes).toHaveLength(2);
  });

  test('Kanäle: Profilradius ≈ 2.5, je 2 Mündungen, Bahn aus Stücken', () => {
    for (const tube of run.tubes) {
      expect(tube.radius).toBeCloseTo(2.5, 1);
      expect(tube.mouths).toHaveLength(2);
      expect(tube.pieces.length).toBeGreaterThan(0);
      expect(Number.isFinite(tube.gamma)).toBe(true);
    }
  });

  test('sollte Kanal-Gruppen mit group.tube und Zylinder-Gruppen mit group.primitive taggen', () => {
    expect(run.groups.filter(g => g.tube).length).toBeGreaterThan(0);
    expect(run.groups.filter(g => g.primitive).length).toBeGreaterThan(0);
  });
});

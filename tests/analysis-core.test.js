/**
 * Unit Tests für analysis-core.js
 * Testet STL-Parsing und Mesh-Analyse-Funktionen
 */

import { jest } from '@jest/globals';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Import der zu testenden Funktionen
import {
  parseStl,
  analyseMesh,
  simplifyMesh,
  computeBoundingBox,
  detectPlanarFeatures,
  detectConicalFeatures,
  detectSphericalFeatures,
  detectObliqueCylindricalFeatures
} from '../analysis-core.js';

// Hilfsfunktion: STL-Datei laden und als ArrayBuffer zurückgeben
const loadStl = (name) => {
  const content = readFileSync(join(__dirname, '../samples', name));
  return content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength);
};

describe('parseStl', () => {
  test('sollte eine ASCII STL-Datei korrekt parsen', () => {
    const stlContent = readFileSync(join(__dirname, '../samples/cube_ascii.stl'));
    const buffer = stlContent.buffer.slice(
      stlContent.byteOffset,
      stlContent.byteOffset + stlContent.byteLength
    );

    const result = parseStl(buffer);

    expect(result).toBeDefined();
    expect(result.faces).toBeDefined();
    expect(result.vertices).toBeDefined();
    expect(result.faces.length).toBe(12); // Würfel hat 12 Dreiecke (6 Seiten × 2)
  });

  test('sollte bei leerer Datei einen Fehler werfen', () => {
    const emptyBuffer = new ArrayBuffer(0);

    expect(() => parseStl(emptyBuffer)).toThrow('Leere Datei');
  });

  test('sollte bei null einen Fehler werfen', () => {
    expect(() => parseStl(null)).toThrow('Leere Datei');
  });

  test('sollte Progress-Callback aufrufen', () => {
    const stlContent = readFileSync(join(__dirname, '../samples/cube_ascii.stl'));
    const buffer = stlContent.buffer.slice(
      stlContent.byteOffset,
      stlContent.byteOffset + stlContent.byteLength
    );

    const progressCb = jest.fn();
    parseStl(buffer, progressCb);

    expect(progressCb).toHaveBeenCalled();
  });
});

describe('analyseMesh - Cube', () => {
  let cubeMesh;

  beforeAll(() => {
    const stlContent = readFileSync(join(__dirname, '../samples/cube_ascii.stl'));
    const buffer = stlContent.buffer.slice(
      stlContent.byteOffset,
      stlContent.byteOffset + stlContent.byteLength
    );
    cubeMesh = parseStl(buffer);
  });

  test('sollte Mesh-Analyse durchführen', () => {
    const analysis = analyseMesh(cubeMesh, 'cube.stl');

    expect(analysis).toBeDefined();
    expect(analysis.meta).toBeDefined();
    expect(analysis.meta.fileName).toBe('cube.stl');
  });

  test('sollte Bounding Box korrekt berechnen', () => {
    const analysis = analyseMesh(cubeMesh, 'cube.stl');

    expect(analysis.boundingBox).toBeDefined();
    // Würfel von 0,0,0 bis 1,1,1
    expect(analysis.boundingBox.width).toBeCloseTo(1, 2);
    expect(analysis.boundingBox.depth).toBeCloseTo(1, 2);
    expect(analysis.boundingBox.height).toBeCloseTo(1, 2);
  });

  test('sollte planare Flächen erkennen', () => {
    const analysis = analyseMesh(cubeMesh, 'cube.stl');

    expect(analysis.planes).toBeDefined();
    // Würfel sollte 6 planare Flächen haben
    expect(analysis.planes.length).toBe(6);
  });
});

describe('computeBoundingBox', () => {
  test('sollte BoundingBox für einfache Vertices berechnen', () => {
    const mesh = {
      faces: [
        { vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0]] },
        { vertices: [[0, 0, 0], [0, 0, 1], [1, 0, 0]] }
      ],
      vertices: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0])
    };

    const bbox = computeBoundingBox(mesh);

    expect(bbox).toBeDefined();
    expect(bbox.min).toBeDefined();
    expect(bbox.max).toBeDefined();
  });
});

describe('detectPlanarFeatures', () => {
  let cubeMesh;

  beforeAll(() => {
    const stlContent = readFileSync(join(__dirname, '../samples/cube_ascii.stl'));
    const buffer = stlContent.buffer.slice(
      stlContent.byteOffset,
      stlContent.byteOffset + stlContent.byteLength
    );
    cubeMesh = parseStl(buffer);
  });

  test('sollte planare Features in einem Würfel erkennen', () => {
    const planes = detectPlanarFeatures(cubeMesh.faces);

    expect(planes).toBeDefined();
    expect(Array.isArray(planes)).toBe(true);
    expect(planes.length).toBe(6); // Würfel hat 6 Seiten
  });

  test('sollte korrekte Normalen für Würfel-Seiten haben', () => {
    const planes = detectPlanarFeatures(cubeMesh.faces);

    // Jede Ebene sollte eine Normale haben (als Array [x, y, z])
    planes.forEach(plane => {
      expect(plane.normal).toBeDefined();
      expect(Array.isArray(plane.normal)).toBe(true);
      expect(plane.normal.length).toBe(3);

      // Normale sollte normalisiert sein (Länge ≈ 1)
      const length = Math.sqrt(
        plane.normal[0] ** 2 +
        plane.normal[1] ** 2 +
        plane.normal[2] ** 2
      );
      expect(length).toBeCloseTo(1, 2);
    });
  });
});

// ============================================================
// cylinder.stl — CAD-exportierter Zylinder (r≈2, h=15, Z-Achse)
// ============================================================
describe('analyseMesh - Cylinder', () => {
  let mesh, analysis;

  beforeAll(() => {
    mesh = parseStl(loadStl('cylinder.stl'));
    analysis = analyseMesh(mesh, 'cylinder.stl');
  });

  test('sollte 626 Dreiecke parsen (Binary STL)', () => {
    expect(mesh.faces.length).toBe(626);
  });

  test('sollte Bounding Box korrekt berechnen', () => {
    const bb = analysis.boundingBox;
    expect(bb.width).toBeCloseTo(4.0, 0);
    expect(bb.depth).toBeCloseTo(4.0, 0);
    expect(bb.height).toBeCloseTo(15.0, 0);
  });

  test('sollte planare Flächen erkennen', () => {
    expect(analysis.planes.length).toBeGreaterThanOrEqual(10);
  });

  test('sollte mindestens 1 Zylinder erkennen', () => {
    expect(analysis.cylinders.length).toBeGreaterThanOrEqual(1);
  });

  test('Zylinder sollte Z-Achse haben', () => {
    const zCyl = analysis.cylinders.find(c => (c.axis || c.axisLabel) === 'Z');
    expect(zCyl).toBeDefined();
  });

  test('Zylinder-Radius sollte ca. 2 sein', () => {
    const zCyl = analysis.cylinders.find(c => (c.axis || c.axisLabel) === 'Z');
    expect(zCyl.radius).toBeCloseTo(2.0, 0);
  });

  test('Zylinder-Länge sollte ca. 15 sein', () => {
    const zCyl = analysis.cylinders.find(c => (c.axis || c.axisLabel) === 'Z');
    expect(zCyl.length).toBeCloseTo(15.0, 0);
  });

  test('sollte keine Kugeln erkennen', () => {
    expect(analysis.spheres.length).toBe(0);
  });

  test('Volumen und Oberfläche sollten plausibel sein', () => {
    // π × r² × h = π × 4 × 15 ≈ 188.5
    expect(analysis.meta.volume).toBeGreaterThan(150);
    expect(analysis.meta.volume).toBeLessThan(250);
    expect(analysis.meta.surfaceArea).toBeGreaterThan(150);
    expect(analysis.meta.surfaceArea).toBeLessThan(300);
  });
});

// ============================================================
// block_with_hole.stl — Würfel mit zylindrischer Bohrung
// ============================================================
describe('analyseMesh - Block with Hole', () => {
  let mesh, analysis;

  beforeAll(() => {
    mesh = parseStl(loadStl('block_with_hole.stl'));
    analysis = analyseMesh(mesh, 'block_with_hole.stl');
  });

  test('sollte 1464 Dreiecke parsen', () => {
    expect(mesh.faces.length).toBe(1464);
  });

  test('sollte einen Würfel mit 25.6mm Kantenlänge erkennen', () => {
    const bb = analysis.boundingBox;
    expect(bb.width).toBeCloseTo(25.6, 0);
    expect(bb.depth).toBeCloseTo(25.6, 0);
    expect(bb.height).toBeCloseTo(25.6, 0);
  });

  test('sollte mindestens 6 große planare Flächen erkennen', () => {
    // 6 Würfelseiten + viele kleine Tessellations-Flächen der Bohrung
    expect(analysis.planes.length).toBeGreaterThanOrEqual(6);
    // Die 6 größten Flächen sollten die Würfelseiten sein
    const largePlanes = analysis.planes.filter(p => p.area > 500);
    expect(largePlanes.length).toBe(6);
  });

  test('sollte genau 1 Zylinder erkennen (die Bohrung)', () => {
    expect(analysis.cylinders.length).toBe(1);
  });

  test('Bohrung sollte Z-Achse haben', () => {
    expect(analysis.cylinders[0].axis || analysis.cylinders[0].axisLabel).toBe('Z');
  });

  test('Bohrungsradius sollte ca. 3.9 sein', () => {
    expect(analysis.cylinders[0].radius).toBeCloseTo(3.92, 0);
  });

  test('Bohrungslänge sollte der Blockhöhe entsprechen (25.6)', () => {
    expect(analysis.cylinders[0].length).toBeCloseTo(25.6, 0);
  });

  test('sollte keine Kugeln erkennen', () => {
    expect(analysis.spheres.length).toBe(0);
  });

  test('Volumen sollte kleiner als Vollwürfel sein (Bohrung abgezogen)', () => {
    const cubeVolume = 25.6 ** 3; // ~16777
    expect(analysis.meta.volume).toBeLessThan(cubeVolume);
    expect(analysis.meta.volume).toBeGreaterThan(10000);
  });
});

// ============================================================
// dino_clip_v3_04-strong-closing.stl — Komplexe organische Form
// ============================================================
describe('analyseMesh - Dino Clip', () => {
  let mesh, analysis;

  beforeAll(() => {
    mesh = parseStl(loadStl('dino_clip_v3_04-strong-closing.stl'));
    analysis = analyseMesh(mesh, 'dino_clip.stl');
  });

  test('sollte 3942 Dreiecke parsen', () => {
    expect(mesh.faces.length).toBe(3942);
  });

  test('Bounding Box sollte korrekt sein', () => {
    const bb = analysis.boundingBox;
    expect(bb.width).toBeCloseTo(75.81, 0);
    expect(bb.depth).toBeCloseTo(75.95, 0);
    expect(bb.height).toBeCloseTo(18.01, 0);
  });

  test('sollte keine Zylinder erkennen (organische Form)', () => {
    expect(analysis.cylinders.length).toBe(0);
  });

  test('sollte keine Kugeln erkennen', () => {
    expect(analysis.spheres.length).toBe(0);
  });

  test('sollte viele planare Flächen erkennen (tessellierte Oberfläche)', () => {
    expect(analysis.planes.length).toBeGreaterThan(1000);
  });

  test('sollte 1 Kegel erkennen', () => {
    expect(analysis.cones.length).toBe(1);
  });

  test('Volumen und Oberfläche sollten plausibel sein', () => {
    expect(analysis.meta.volume).toBeGreaterThan(20000);
    expect(analysis.meta.surfaceArea).toBeGreaterThan(10000);
  });
});

// ============================================================
// fischerEbike...stl — Real-World mechanisches Teil (11K+ Dreiecke)
// ============================================================
describe('analyseMesh - FischerEbike Mount', () => {
  let mesh, analysis;

  beforeAll(() => {
    mesh = parseStl(loadStl('fischerEbike - FahrradLicht - mount unter sattel.stl'));
    analysis = analyseMesh(mesh, 'fischerEbike.stl');
  });

  test('sollte 11594 Dreiecke parsen', () => {
    expect(mesh.faces.length).toBe(11594);
  });

  test('Bounding Box sollte korrekt sein', () => {
    const bb = analysis.boundingBox;
    expect(bb.width).toBeCloseTo(61.0, 0);
    expect(bb.depth).toBeCloseTo(10.0, 0);
    expect(bb.height).toBeCloseTo(35.0, 0);
  });

  test('sollte mehrere Zylinder erkennen (Bohrungen, Rundungen)', () => {
    expect(analysis.cylinders.length).toBeGreaterThanOrEqual(10);
  });

  test('sollte Zylinder mit verschiedenen Achsen erkennen', () => {
    const axes = new Set(analysis.cylinders.map(c => c.axis || c.axisLabel));
    expect(axes.size).toBeGreaterThanOrEqual(2);
  });

  test('sollte keine Kugeln erkennen', () => {
    expect(analysis.spheres.length).toBe(0);
  });

  test('sollte viele planare Flächen erkennen', () => {
    expect(analysis.planes.length).toBeGreaterThan(100);
  });

  test('Analyse sollte unter 30 Sekunden abschließen', () => {
    const start = performance.now();
    analyseMesh(mesh, 'fischerEbike.stl');
    const duration = performance.now() - start;
    expect(duration).toBeLessThan(30000);
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
// Binary STL Bounds-Checking
// ============================================================
describe('parseStl - Binary STL Validierung', () => {
  test('sollte zu kleine Datei ablehnen (< 84 Bytes)', () => {
    const tooSmall = new ArrayBuffer(50);
    expect(() => parseStl(tooSmall)).toThrow();
  });

  test('sollte abgeschnittene Binary-STL ablehnen', () => {
    // Erstelle einen Header mit 100 Faces, aber zu wenig Daten
    const buf = new ArrayBuffer(84 + 10 * 50); // Nur Platz für 10 statt 100
    const dv = new DataView(buf);
    dv.setUint32(80, 100, true); // Behauptet 100 Faces
    expect(() => parseStl(buf)).toThrow();
  });
});

// ============================================================
// cone_pointed.stl — Spitzer Kegel (r=10, h=20, Z-Achse)
// ============================================================
describe('analyseMesh - Pointed Cone', () => {
  let mesh, analysis;

  beforeAll(() => {
    mesh = parseStl(loadStl('cone_pointed.stl'));
    analysis = analyseMesh(mesh, 'cone_pointed.stl');
  });

  test('sollte Kegel erkennen', () => {
    expect(analysis.cones.length).toBeGreaterThanOrEqual(1);
  });

  test('Kegel sollte Z-Achse haben', () => {
    const zCone = analysis.cones.find(c => c.axis === 'Z');
    expect(zCone).toBeDefined();
  });

  test('Kegel sollte hohe Fit-Qualität haben (R² > 0.95)', () => {
    const zCone = analysis.cones.find(c => c.axis === 'Z');
    expect(zCone.rSquared).toBeGreaterThan(0.95);
  });

  test('Kegel-Radien sollten plausibel sein (rBottom > rTop)', () => {
    const zCone = analysis.cones.find(c => c.axis === 'Z');
    expect(zCone.radiusBottom).toBeGreaterThan(zCone.radiusTop);
    expect(zCone.radiusBottom).toBeGreaterThan(5);
  });

  test('sollte keine Kugeln erkennen', () => {
    expect(analysis.spheres.length).toBe(0);
  });
});

// ============================================================
// cone_frustum.stl — Kegelstumpf (rB=10, rT=4, h=15, Z-Achse)
// ============================================================
describe('analyseMesh - Frustum Cone', () => {
  let mesh, analysis;

  beforeAll(() => {
    mesh = parseStl(loadStl('cone_frustum.stl'));
    analysis = analyseMesh(mesh, 'cone_frustum.stl');
  });

  test('sollte Kegel erkennen', () => {
    expect(analysis.cones.length).toBeGreaterThanOrEqual(1);
  });

  test('Kegelstumpf sollte zwei verschiedene Radien haben', () => {
    const zCone = analysis.cones.find(c => c.axis === 'Z');
    expect(zCone).toBeDefined();
    expect(zCone.radiusTop).toBeGreaterThan(2);
    expect(zCone.radiusBottom).toBeGreaterThan(zCone.radiusTop);
  });

  test('sollte keine Kugeln erkennen (kein False Positive)', () => {
    expect(analysis.spheres.length).toBe(0);
  });
});

// ============================================================
// cone_flat.stl — Flacher Kegel (rB=15, rT=12, h=5)
// ============================================================
describe('analyseMesh - Flat Cone', () => {
  let mesh, analysis;

  beforeAll(() => {
    mesh = parseStl(loadStl('cone_flat.stl'));
    analysis = analyseMesh(mesh, 'cone_flat.stl');
  });

  test('sollte Kegel erkennen trotz geringer Verjüngung', () => {
    expect(analysis.cones.length).toBeGreaterThanOrEqual(1);
  });

  test('sollte keine Kugeln erkennen', () => {
    expect(analysis.spheres.length).toBe(0);
  });
});

// ============================================================
// sphere_full.stl — CAD-exportierte Kugel (r≈2, 6240 Dreiecke)
// ============================================================
describe('analyseMesh - Full Sphere', () => {
  let mesh, analysis;

  beforeAll(() => {
    mesh = parseStl(loadStl('sphere_full.stl'));
    analysis = analyseMesh(mesh, 'sphere_full.stl');
  });

  test('sollte 6240 Dreiecke parsen', () => {
    expect(mesh.faces.length).toBe(6240);
  });

  test('sollte Bounding Box korrekt berechnen (r≈2)', () => {
    const bb = analysis.boundingBox;
    expect(bb.width).toBeCloseTo(4.0, 0);
    expect(bb.depth).toBeCloseTo(4.0, 0);
    expect(bb.height).toBeCloseTo(4.0, 0);
  });

  test('sollte genau 1 Kugel erkennen', () => {
    expect(analysis.spheres.length).toBe(1);
  });

  test('Kugel sollte Typ "full" haben', () => {
    expect(analysis.spheres[0].sphereType).toBe('full');
  });

  test('Radius sollte ca. 2 sein', () => {
    expect(analysis.spheres[0].radius).toBeCloseTo(2, 0);
  });

  test('Coverage sollte ca. 100% sein', () => {
    expect(analysis.spheres[0].coverage).toBeGreaterThan(0.9);
  });

  test('Volumen sollte plausibel sein (4/3 × π × r³ ≈ 33.5)', () => {
    expect(analysis.meta.volume).toBeGreaterThan(25);
    expect(analysis.meta.volume).toBeLessThan(45);
  });

  test('sollte keine Kegel erkennen', () => {
    expect(analysis.cones.length).toBe(0);
  });
});

// ============================================================
// cylinder_oblique_45.stl — Schräger Zylinder (45°, r=5, l=20)
// ============================================================
describe('analyseMesh - Oblique Cylinder 45°', () => {
  let mesh, analysis;

  beforeAll(() => {
    mesh = parseStl(loadStl('cylinder_oblique_45.stl'));
    analysis = analyseMesh(mesh, 'cylinder_oblique_45.stl');
  });

  test('sollte genau 1 schrägen Zylinder erkennen', () => {
    const oblique = analysis.cylinders.filter(c => (c.axis || c.axisLabel) === 'Schräg');
    expect(oblique.length).toBe(1);
  });

  test('Radius sollte ca. 5 sein', () => {
    const oblique = analysis.cylinders.find(c => (c.axis || c.axisLabel) === 'Schräg');
    expect(oblique.radius).toBeCloseTo(5, 0);
  });

  test('sollte keine Kugeln erkennen', () => {
    expect(analysis.spheres.length).toBe(0);
  });

  test('sollte keine Kegel erkennen', () => {
    expect(analysis.cones.length).toBe(0);
  });
});

// ============================================================
// cylinder_oblique_xz.stl — Schräger Zylinder (XZ-Ebene, r=3, l=15)
// ============================================================
describe('analyseMesh - Oblique Cylinder XZ', () => {
  let mesh, analysis;

  beforeAll(() => {
    mesh = parseStl(loadStl('cylinder_oblique_xz.stl'));
    analysis = analyseMesh(mesh, 'cylinder_oblique_xz.stl');
  });

  test('sollte schrägen Zylinder erkennen', () => {
    const oblique = analysis.cylinders.filter(c => (c.axis || c.axisLabel) === 'Schräg');
    expect(oblique.length).toBeGreaterThanOrEqual(1);
  });

  test('Radius sollte ca. 3 sein', () => {
    const oblique = analysis.cylinders.find(c => (c.axis || c.axisLabel) === 'Schräg');
    expect(oblique.radius).toBeCloseTo(3, 0);
  });

  test('sollte keine Kugeln erkennen (kein False Positive)', () => {
    expect(analysis.spheres.length).toBe(0);
  });
});

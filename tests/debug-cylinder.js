/**
 * Debug-Skript für Zylinder-Erkennung
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Manuelles Parsen der Cylinder STL
const stlPath = join(__dirname, '../samples/cylinder.stl');
const content = readFileSync(stlPath, 'utf-8');

// Alle Vertices extrahieren
const vertexRegex = /vertex\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)/g;
const vertices = [];
let match;

while ((match = vertexRegex.exec(content)) !== null) {
  vertices.push([parseFloat(match[1]), parseFloat(match[2]), parseFloat(match[3])]);
}

// Eindeutige Vertices
const uniqueMap = new Map();
vertices.forEach(v => {
  const key = `${v[0].toFixed(4)}_${v[1].toFixed(4)}_${v[2].toFixed(4)}`;
  uniqueMap.set(key, v);
});

const uniqueVertices = Array.from(uniqueMap.values());

console.log(`Gesamt Vertices: ${vertices.length}`);
console.log(`Eindeutige Vertices: ${uniqueVertices.length}`);

// Nach Z-Wert gruppieren
const byZ = new Map();
uniqueVertices.forEach(v => {
  const z = v[2].toFixed(2);
  if (!byZ.has(z)) byZ.set(z, []);
  byZ.get(z).push(v);
});

console.log('\nVertices nach Z-Wert:');
for (const [z, verts] of byZ) {
  console.log(`  Z=${z}: ${verts.length} Vertices`);
  verts.forEach(v => {
    const r = Math.hypot(v[0], v[1]);
    console.log(`    (${v[0].toFixed(2)}, ${v[1].toFixed(2)}) -> Radius: ${r.toFixed(3)}`);
  });
}

// Problem-Analyse
console.log('\n=== Problem-Analyse ===');
const z0Verts = byZ.get('0.00') || [];
const z10Verts = byZ.get('10.00') || [];

console.log(`Z=0: ${z0Verts.length} Vertices`);
console.log(`Z=10: ${z10Verts.length} Vertices`);

// Radien ohne Zentrum (0,0)
const z0Outer = z0Verts.filter(v => Math.hypot(v[0], v[1]) > 0.1);
const z10Outer = z10Verts.filter(v => Math.hypot(v[0], v[1]) > 0.1);

console.log(`\nOhne Zentrum (0,0):`);
console.log(`Z=0 outer: ${z0Outer.length} Vertices`);
console.log(`Z=10 outer: ${z10Outer.length} Vertices`);

if (z0Outer.length > 0) {
  const radii = z0Outer.map(v => Math.hypot(v[0], v[1]));
  const avgRadius = radii.reduce((a, b) => a + b, 0) / radii.length;
  const stdDev = Math.sqrt(radii.map(r => (r - avgRadius) ** 2).reduce((a, b) => a + b, 0) / radii.length);
  console.log(`\nZ=0 Radien: avg=${avgRadius.toFixed(3)}, stdDev=${stdDev.toFixed(6)}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// tests/freeform/gen.test.mjs — prüft die von gen.mjs erzeugten Testkörper.
//
// Je Körper (binäre STL, mit parseStl aus analysis-core.js gelesen):
//   • mannigfaltig — jede ungerichtete Kante genau 2× benutzt, gegenläufig
//   • ein zusammenhängender Körper (genau eine Komponente)
//   • Volumen > 0 und innerhalb der Tolerante von der analytischen Soll-Volumen
//   • keine entarteten Dreiecke (Fläche > 1e-9)
//
// Die Körper werden vor der Prüfung neu geschrieben (generateAll) — die STL im
// Verzeichnis tests/freeform/stl ist damit immer frisch.
// ─────────────────────────────────────────────────────────────────────────────
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateAll, describeBodies } from './gen.mjs';
import { parseStl } from '../../analysis-core.js';

let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`ok ${name}`); }
  catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); }
}

// Körper (neu) erzeugen — die STL-Dateien werden dadurch (re)geschrieben
const written = generateAll('tests/freeform/stl');
console.log(`${written.length} Körper erzeugt in tests/freeform/stl`);

// Punkte auf 4 Nachkommastellen schweißen (so wie die binäre STL sie speichert)
function weld(tris) {
  const map = new Map();
  const idx = (p) => {
    const k = `${p[0].toFixed(4)},${p[1].toFixed(4)},${p[2].toFixed(4)}`;
    let i = map.get(k);
    if (i === undefined) { i = map.size; map.set(k, i); }
    return i;
  };
  const ids = tris.map((t) => t.map(idx));
  const pts = new Array(map.size);
  for (const [k, i] of map) { const [x, y, z] = k.split(','); pts[i] = [Number(x), Number(y), Number(z)]; }
  return { ids, pts };
}

// Gerichtete Kanten zählen: jede Kante muss genau 2× und gegenläufig benutzt sein
function edgeReport(ids) {
  const dir = new Map();
  for (const [a, b, c] of ids) {
    for (const [p, q] of [[a, b], [b, c], [c, a]]) {
      const k = `${p}>${q}`;
      dir.set(k, (dir.get(k) || 0) + 1);
    }
  }
  let bad = 0;
  for (const [k, n] of dir) {
    const [p, q] = k.split('>');
    const back = dir.get(`${q}>${p}`) || 0;
    if (n !== 1 || back !== 1) bad++;
  }
  return { bad, edges: dir.size / 2 };
}

// Zusammenhang: genau eine Komponente (Union-Find)
function components(ids, nPts) {
  const parent = new Int32Array(nPts);
  for (let i = 0; i < nPts; i++) parent[i] = i;
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  for (const [a, b, c] of ids) {
    const ra = find(a), rb = find(b), rc = find(c);
    if (ra !== rb) parent[rb] = ra;
    if (find(rc) !== ra) parent[find(rc)] = ra;
  }
  const roots = new Set();
  for (let i = 0; i < nPts; i++) roots.add(find(i));
  return roots.size;
}

// Volumen (Divergenzsatz) und kleinste Dreiecksfläche
function volumeAndArea(ids, pts) {
  let v = 0, minArea = Infinity, degen = 0;
  for (const [ia, ib, ic] of ids) {
    const a = pts[ia], b = pts[ib], c = pts[ic];
    v += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    const area = Math.hypot(n[0], n[1], n[2]) / 2;
    if (area < minArea) minArea = area;
    if (!(area > 1e-9)) degen++;
  }
  return { volume: v, minArea, degen };
}

for (const body of describeBodies()) {
  const buf = readFileSync(join('tests/freeform/stl', body.file));
  const mesh = parseStl(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), () => {});
  const tris = mesh.faces.map((f) => f.vertices);
  const { ids, pts } = weld(tris);
  const { volume, minArea } = volumeAndArea(ids, pts);
  const dev = (Math.abs(volume - body.volume) / body.volume) * 100;
  console.log(`  ${body.file}: ${tris.length} Dreiecke, ${pts.length} Punkte, `
    + `Volumen ${volume.toFixed(3)} mm³ (Soll ${body.volume.toFixed(3)}, Abw. ${dev.toFixed(2)} %), `
    + `kleinste Fläche ${minArea.toExponential(2)} mm²`);

  check(`${body.file} mannigfaltig`, () => {
    const rep = edgeReport(ids);
    assert.equal(rep.bad, 0, `${rep.bad} Kanten nicht genau 2× gegenläufig benutzt (von ${rep.edges})`);
  });

  check(`${body.file} ein zusammenhängender Körper`, () => {
    const n = components(ids, pts.length);
    assert.equal(n, 1, `${n} Komponenten (nicht 1)`);
  });

  check(`${body.file} keine entarteten Dreiecke`, () => {
    const { degen } = volumeAndArea(ids, pts);
    assert.equal(degen, 0, `${degen} entartete Dreiecke (kleinste Fläche ${minArea})`);
  });

  check(`${body.file} Volumen positiv und in Toleranz`, () => {
    assert.ok(volume > 0, `Volumen ${volume.toFixed(3)} nicht positiv (Orientierung?)`);
    // 2 % für die Platte (48-Eck + Torusrundung), sonst 1 %
    const tol = body.file.includes('platte') ? 0.02 : 0.01;
    assert.ok(dev <= tol * 100, `Volumen ${volume.toFixed(3)} mm³ weicht ${dev.toFixed(2)} % von der Soll ${body.volume.toFixed(3)} mm³ ab (Toleranz ${tol * 100} %)`);
  });
}

if (failed) { console.log(`\n${failed} Fall(e) fehlgeschlagen`); process.exit(1); }
console.log('\nalle Fälle ok');

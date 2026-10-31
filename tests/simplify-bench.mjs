// Benchmarks für simplifyMesh (mesh-simplify.js) — NICHT Teil von npm test.
//
//   node tests/simplify-bench.mjs [--big] [--write <dir>]
//     --big         Körper auf ~500k statt ~200k Dreiecke
//     --write <dir> Eingangs-STLs (binär) nach <dir> schreiben
//
// Je Fall und Ziel-Facecount: Eingangs-/Ausgangs-Dreiecke, Laufzeit, Mannigfaltigkeit,
// Abweichung (relativ zur Bounding-Box-Diagonale) und Selbst-Überschneidungen.
import { mkdirSync } from 'fs';
import { join } from 'path';
import { simplifyMesh } from '../mesh-simplify.js';
import {
  uvSphere, torus, boxWithBores, transformMesh,
  checkClosedManifold, maxDeviation, selfIntersectionSample, bboxDiagonal, writeBinaryStl,
} from './simplify-bodies.mjs';

const argv = process.argv.slice(2);
const big = argv.includes('--big');
const wi = argv.indexOf('--write');
const outDir = wi >= 0 ? argv[wi + 1] : null;

const BORES = [
  { cx: 15, cy: 10, r: 4 }, { cx: 45, cy: 10, r: 4 },
  { cx: 15, cy: 30, r: 4 }, { cx: 45, cy: 30, r: 4 },
];
const ROT = { axis: [1, 2, 3], deg: 37, translate: [1000, -500, 250] };

// Körper: ~200k Dreiecke (bzw. ~500k mit --big)
const sphere = uvSphere(20, big ? 1001 : 401, 250);                        // 2·250·400 = 200 000
const torusMesh = torus(20, 4, big ? 500 : 400, big ? 500 : 250);          // 2·400·250 = 200 000
const box = boxWithBores({
  w: 60, h: 20, d: 40, bores: BORES, circleSeg: 512, wallSteps: big ? 122 : 48,
});
const boxRot = transformMesh(box, ROT);

const CASES = [
  { name: 'sphere', mesh: sphere },
  { name: 'torus', mesh: torusMesh },
  { name: 'box', mesh: box },
  { name: 'box-rot', mesh: boxRot },
];
const TARGETS = [50000, 100000];

if (outDir) {
  mkdirSync(outDir, { recursive: true });
  for (const c of CASES) {
    const p = writeBinaryStl(c.mesh, join(outDir, `${c.name}.stl`));
    console.log(`geschrieben: ${p} (${c.mesh.faces.length} Dreiecke)`);
  }
}

console.log(`\nsimplifyMesh-Bench  (${big ? '500k' : '200k'} Dreiecke, Ziele ${TARGETS.join(' / ')})\n`);
console.log([
  'Fall'.padEnd(9), 'Eingang'.padStart(9), 'Ziel'.padStart(8), 'Ausgang'.padStart(9),
  'ms'.padStart(8), 'manifold'.padStart(10), 'maxDev max'.padStart(11), 'mean'.padStart(11),
  'selfInt'.padStart(8),
].join(' '));

for (const c of CASES) {
  const diag = bboxDiagonal(c.mesh);
  for (const target of TARGETS) {
    const t0 = Date.now();
    const res = simplifyMesh(c.mesh, target);
    const ms = Date.now() - t0;
    const chk = checkClosedManifold(res);
    const dev = maxDeviation(c.mesh, res);
    const si = selfIntersectionSample(res);
    console.log([
      c.name.padEnd(9),
      String(c.mesh.faces.length).padStart(9),
      String(target).padStart(8),
      String(res.faces.length).padStart(9),
      String(ms).padStart(8),
      (chk.ok ? 'ja' : `nein(${chk.boundaryEdges}/${chk.nonManifoldEdges}/${chk.orientationErrors})`).padStart(10),
      (dev.max / diag).toExponential(3).padStart(11),
      (dev.mean / diag).toExponential(3).padStart(11),
      String(si.hits).padStart(8),
    ].join(' '));
  }
}
console.log('');

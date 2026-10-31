// Tests für mesh-simplify.js (simplifyMesh) — Körper + Prüfer aus ./simplify-bodies.mjs.
//
// Prüfkette je Fall: manifold (Kanten genau 2×, gegenläufig) → Ziel-Facecount →
// geometrische Abweichung (einseitiger Hausdorff) → Selbst-Überschneidung.
import { jest } from '@jest/globals';
import { simplifyMesh } from '../mesh-simplify.js';
import {
  uvSphere, torus, boxWithBores, transformMesh, inverseTransformMesh,
  checkClosedManifold, maxDeviation, selfIntersectionSample, planeDeviation, planeDeviationStats,
  signedVolume, trisToMesh,
} from './simplify-bodies.mjs';

jest.setTimeout(120000);

// ── Maße ───────────────────────────────────────────────────────────────────
const SPHERE_R = 10;
const TORUS_R = 20, TORUS_r = 4;
const BOX = { w: 60, h: 20, d: 40 };
const BORES = [
  { cx: 15, cy: 10, r: 4 }, { cx: 45, cy: 10, r: 4 },
  { cx: 15, cy: 30, r: 4 }, { cx: 45, cy: 30, r: 4 },
];
const ROT = { axis: [1, 2, 3], deg: 37, translate: [1000, -500, 250] };

// ── Körper (einmal erzeugt, für alle Tests) ────────────────────────────────
const sphere = uvSphere(SPHERE_R, 101, 200);                        // 2·200·100 = 40 000
const torusMesh = torus(TORUS_R, TORUS_r, 200, 100);                // 2·200·100 = 40 000
const box = boxWithBores({ ...BOX, bores: BORES, circleSeg: 288, wallSteps: 24 });
const boxFillet = boxWithBores({ ...BOX, bores: BORES, circleSeg: 64, wallSteps: 4, fillet: { r: 1.5, N: 4 } });
const boxRot = transformMesh(box, ROT);

// ── Hilfen ─────────────────────────────────────────────────────────────────
const hasExactVertex = (mesh, p) => mesh.faces.some((f) =>
  f.vertices.some((v) => v[0] === p[0] && v[1] === p[1] && v[2] === p[2]));

const centroid = (f) => [
  (f.vertices[0][0] + f.vertices[1][0] + f.vertices[2][0]) / 3,
  (f.vertices[0][1] + f.vertices[1][1] + f.vertices[2][1]) / 3,
  (f.vertices[0][2] + f.vertices[1][2] + f.vertices[2][2]) / 3,
];

// N Dreiecke aus dem Netz entfernen (offenes Netz)
function dropFaces(mesh, n) {
  const faces = mesh.faces.slice(n);
  const flat = [];
  for (const f of faces) for (const v of f.vertices) flat.push(v[0], v[1], v[2]);
  return { faces, vertices: new Float32Array(flat) };
}

const BODY_NAMES = ['sphere', 'torus', 'box', 'boxFillet', 'boxRot'];

// ── 0) Die erzeugten Körper selbst müssen geschlossen/manifold sein ───────
test('generated bodies are closed manifold', () => {
  const bodies = [sphere, torusMesh, box, boxFillet, boxRot];
  console.log('Dreiecke:', BODY_NAMES.map((n, i) => `${n}=${bodies[i].faces.length}`).join(' '));
  const report = bodies.map((m, i) => `${BODY_NAMES[i]}: ${JSON.stringify(checkClosedManifold(m))}`);
  console.log(report.join('\n'));
  const bad = bodies.map((m, i) => [BODY_NAMES[i], checkClosedManifold(m)]).filter(([, c]) => !c.ok);
  expect(bad.map(([n, c]) => `${n}: ${JSON.stringify(c)}`).join(' | ')).toBe('');
  // feste Körpergrößen (Regression der Erzeuger)
  expect({
    sphere: sphere.faces.length, torus: torusMesh.faces.length,
    box: box.faces.length, boxFillet: boxFillet.faces.length, boxRot: boxRot.faces.length,
  }).toEqual({ sphere: 40000, torus: 40000, box: 57812, boxFillet: 6772, boxRot: 57812 });
});

// ── 1) Kugel 40k → 10k ─────────────────────────────────────────────────────
test('sphere 40k → 10k: manifold, Ziel erreicht, Abweichung < 0,5 % R', () => {
  const res = simplifyMesh(sphere, 10000);
  expect(checkClosedManifold(res).ok).toBe(true);
  expect(res.faces.length).toBeLessThanOrEqual(10000);
  expect(res.faces.length).toBeGreaterThanOrEqual(9990);
  const dev = maxDeviation(sphere, res);
  console.log('Kugel: Abweichung max', dev.max, 'mean', dev.mean);
  expect(dev.max).toBeLessThan(0.005 * SPHERE_R);
});

// ── 2) Torus 40k → 8k ─────────────────────────────────────────────────────
test('torus 40k → 8k: manifold, Ziel erreicht, Abweichung < 1 % rminor', () => {
  const res = simplifyMesh(torusMesh, 8000);
  expect(checkClosedManifold(res).ok).toBe(true);
  expect(res.faces.length).toBeLessThanOrEqual(8000);
  expect(res.faces.length).toBeGreaterThanOrEqual(7900);
  const dev = maxDeviation(torusMesh, res);
  console.log('Torus: Abweichung max', dev.max, 'mean', dev.mean);
  expect(dev.max).toBeLessThan(0.01 * TORUS_r);
});

// ── 3) Quader mit 4 Bohrungen 60k → 15k ───────────────────────────────────
test('box with 4 bores → 15k: manifold, Deckflächen planar, Ecken exakt', () => {
  const res = simplifyMesh(box, 15000);
  expect(checkClosedManifold(res).ok).toBe(true);
  expect(res.faces.length).toBeLessThanOrEqual(15000);
  expect(res.faces.length).toBeGreaterThanOrEqual(14700);
  const size = Math.max(BOX.w, BOX.h, BOX.d);
  const top = planeDeviationStats(res, [0, 0, 1], -BOX.h);
  const bot = planeDeviationStats(res, [0, 0, -1], 0);
  console.log('Deckfläche oben:', JSON.stringify(top), 'unten:', JSON.stringify(bot));
  expect(top.count).toBeGreaterThan(0);
  expect(bot.count).toBeGreaterThan(0);
  expect(planeDeviation(res, [0, 0, 1], -BOX.h)).toBeLessThanOrEqual(1e-9 * size);
  expect(planeDeviation(res, [0, 0, -1], 0)).toBeLessThanOrEqual(1e-9 * size);
  expect(top.max).toBeLessThanOrEqual(1e-9 * size);
  expect(bot.max).toBeLessThanOrEqual(1e-9 * size);
  const corners = [];
  for (const z of [0, BOX.h]) {
    for (const [x, y] of [[0, 0], [BOX.w, 0], [BOX.w, BOX.d], [0, BOX.d]]) corners.push([x, y, z]);
  }
  const missing = corners.filter((c) => !hasExactVertex(res, c)).map((c) => c.join(','));
  expect(missing.join(' | ')).toBe('');
});

// ── 4) Derselbe Quader gedreht (37° um [1,2,3]) + verschoben ──────────────
test('rotated + translated box: gleiche Face-Anzahl, gleiche Güte', () => {
  const plain = simplifyMesh(box, 15000);
  const res = simplifyMesh(boxRot, 15000);
  expect(checkClosedManifold(res).ok).toBe(true);
  expect(Math.abs(res.faces.length - plain.faces.length))
    .toBeLessThanOrEqual(0.02 * plain.faces.length);
  const back = inverseTransformMesh(res, ROT);
  const devU = maxDeviation(box, plain);
  const devR = maxDeviation(box, back);
  console.log('Abweichung ungedreht', devU.max, 'gedreht', devR.max);
  expect(devR.max).toBeLessThanOrEqual(2 * devU.max + 1e-6);
});

// ── 5) Keine umgedrehten Flächen ──────────────────────────────────────────
test('no flipped faces', () => {
  const sres = simplifyMesh(sphere, 10000);
  const wrong = sres.faces.filter((f) => {
    const c = centroid(f);
    return f.normal[0] * c[0] + f.normal[1] * c[1] + f.normal[2] * c[2] <= 0;
  });
  expect(wrong.length).toBe(0);
  const bres = simplifyMesh(box, 15000);
  const v0 = signedVolume(box), v1 = signedVolume(bres);
  console.log('Volumen original', v0, 'Ergebnis', v1);
  expect(v1).toBeGreaterThan(0);
  expect(Math.abs(v1 - v0) / Math.abs(v0)).toBeLessThan(0.01);
});

// ── 6) Keine Selbst-Überschneidung ────────────────────────────────────────
test('no self-intersections', () => {
  const s = selfIntersectionSample(simplifyMesh(sphere, 10000), 2000);
  const b = selfIntersectionSample(simplifyMesh(box, 15000), 2000);
  console.log('Selbst-Überschneidung Kugel', JSON.stringify(s), 'Quader', JSON.stringify(b));
  expect(s.hits).toBe(0);
  expect(b.hits).toBe(0);
});

// ── 6b) Der Selbst-Überschneidungsprüfer muss echte Durchdringungen finden ─
// A = Tetraeder {x,y,z ≥ 0, x+y+z ≤ 10}; B steckt mit seiner Spitze (3,3,3) durch
// die schräge Fläche x+y+z=10 von A (echte Durchdringung). Wird B um 1 mm entlang
// der Flächennormalen (1,1,1)/√3 nach außen verschoben, liegen die Körper getrennt.
const tetraTris = ([a, b, c, d]) => {
  const det = (p) => (b[0] - a[0]) * ((c[1] - a[1]) * (p[2] - a[2]) - (c[2] - a[2]) * (p[1] - a[1]))
    - (b[1] - a[1]) * ((c[0] - a[0]) * (p[2] - a[2]) - (c[2] - a[2]) * (p[0] - a[0]))
    + (b[2] - a[2]) * ((c[0] - a[0]) * (p[1] - a[1]) - (c[1] - a[1]) * (p[0] - a[0]));
  // nach außen orientierte Flächen (Volumen > 0) bzw. umgekehrt
  return det(d) > 0
    ? [[a, c, b], [a, d, c], [a, b, d], [b, c, d]]
    : [[a, b, c], [a, c, d], [a, d, b], [b, d, c]];
};

test('self-intersection checker detects a real crossing', () => {
  const A = [[0, 0, 0], [10, 0, 0], [0, 10, 0], [0, 0, 10]];
  const B = [[3, 3, 3], [4, 4, 4], [6, 4, 4], [4, 6, 4]];
  const d = 1 / Math.sqrt(3);                       // 1 mm entlang (1,1,1)/√3
  const Bsep = B.map((p) => [p[0] + d, p[1] + d, p[2] + d]);
  const cross = selfIntersectionSample(trisToMesh([...tetraTris(A), ...tetraTris(B)]), 2000);
  const apart = selfIntersectionSample(trisToMesh([...tetraTris(A), ...tetraTris(Bsep)]), 2000);
  console.log('Durchdringung', JSON.stringify(cross), 'getrennt', JSON.stringify(apart));
  expect(cross.hits).toBeGreaterThan(0);
  expect(apart.hits).toBe(0);
});

// ── 7) Bereits kleines Netz → unverändert zurück ─────────────────────────
test('mesh with at most maxFaces is returned unchanged', () => {
  expect(simplifyMesh(sphere, sphere.faces.length)).toBe(sphere);
  expect(simplifyMesh(sphere, sphere.faces.length + 1000)).toBe(sphere);
  expect(simplifyMesh(box, box.faces.length)).toBe(box);
});

// ── 8) Fortschritts-Callback ──────────────────────────────────────────────
test('progress callback', () => {
  const calls = [];
  simplifyMesh(sphere, 10000, (p) => calls.push(p));
  console.log('Fortschritts-Callbacks:', calls.length);
  expect(calls.length).toBeGreaterThanOrEqual(5);
  let last = -Infinity;
  for (const c of calls) {
    expect(typeof c.processed).toBe('number');
    expect(typeof c.total).toBe('number');
    expect(c.processed).toBeGreaterThanOrEqual(last);
    last = c.processed;
  }
  const fin = calls[calls.length - 1];
  expect(fin.processed).toBe(fin.total);
});

// ── 9) Offenes Netz: Rand bleibt erhalten ─────────────────────────────────
test('open mesh: boundary edges preserved', () => {
  const open = dropFaces(sphere, 50);
  const res = simplifyMesh(open, 10000);
  const inChk = checkClosedManifold(open), outChk = checkClosedManifold(res);
  console.log('offenes Netz: Rand', inChk.boundaryEdges, '→', outChk.boundaryEdges,
    'nicht-manifold', outChk.nonManifoldEdges);
  expect(outChk.boundaryEdges).toBe(inChk.boundaryEdges);
  expect(outChk.nonManifoldEdges).toBe(0);
});

// ── 10) Performance-Rauchtest ─────────────────────────────────────────────
const perfTest = process.env.CI ? test.skip : test;
perfTest('performance smoke: sphere 200k → 50k in < 4 s', () => {
  const big = uvSphere(SPHERE_R, 401, 250);              // 2·250·400 = 200 000
  const t0 = Date.now();
  const res = simplifyMesh(big, 50000);
  const ms = Date.now() - t0;
  console.log('200k → 50k:', ms, 'ms, Ergebnis', res.faces.length);
  expect(res.faces.length).toBeLessThanOrEqual(50000);
  expect(ms).toBeLessThan(4000);
});

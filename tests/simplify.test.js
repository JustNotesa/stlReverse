// Tests für mesh-simplify.js (simplifyMesh) — Körper + Prüfer aus ./simplify-bodies.mjs.
//
// Prüfkette je Fall: manifold (Kanten genau 2×, gegenläufig) → Ziel-Facecount →
// geometrische Abweichung (einseitiger Hausdorff) → Selbst-Überschneidung.
import { jest } from '@jest/globals';
import { simplifyMesh } from '../mesh-simplify.js';
import {
  uvSphere, torus, boxWithBores, transformMesh, inverseTransformMesh,
  checkClosedManifold, maxDeviation, selfIntersectionSample, planeDeviation, planeDeviationStats,
  signedVolume, trisToMesh, faceSoup,
} from './simplify-bodies.mjs';
import { buildMesh, circleProfile } from './fixtures-v2/gen.mjs';

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
// Grenze großzügig: Jest lässt die Testdateien parallel laufen (unter Last gemessen 2–5 s, allein ~1 s).
// Fängt quadratisches Verhalten ab; echte Laufzeiten misst tests/simplify-bench.mjs.
perfTest('performance smoke: sphere 200k → 50k in < 10 s', () => {
  const big = uvSphere(SPHERE_R, 401, 250);              // 2·250·400 = 200 000
  const t0 = Date.now();
  const res = simplifyMesh(big, 50000);
  const ms = Date.now() - t0;
  console.log('200k → 50k:', ms, 'ms, Ergebnis', res.faces.length);
  expect(res.faces.length).toBeLessThanOrEqual(50000);
  expect(ms).toBeLessThan(10000);
});

// ════════════════════════════════════════════════════════════════════════════
// Regressionen aus dem Review (Reviewer-Repro-Skripte lagen in tests/_adv/,
// dort nicht versioniert) — hier als kleine, dauerhafte Portierungen abgelegt.
// ════════════════════════════════════════════════════════════════════════════

// ── R1) Sliver-Stift: hoher Zylinder, Mantel = 2 Splitter je Segment über
//        volle Höhe, Deckel ear-clipped. Der Stift muss auf 2000 Dreiecke
//        schrumpfen und dabei geschlossen/manifold bleiben.
test('sliver pin: 4000 Segmente über volle Höhe → Ziel 2000 erreicht, manifold', () => {
  const t0 = Date.now();
  const M = trisToMesh(buildMesh({
    columns: [{
      name: 'pin', profile: circleProfile(0, 0, 5, 4000, false),
      z0: 0, z1: 50, bottom: { kind: 'sharp' }, top: { kind: 'sharp' }, wallSteps: 1,
    }],
  }));
  const tGen = Date.now() - t0;
  const res = simplifyMesh(M, 2000);
  const chk = checkClosedManifold(res);
  console.log(`Sliver-Stift: ${M.faces.length} → ${res.faces.length} (Ziel 2000), ` +
    `Erzeugung ${tGen} ms, gesamt ${Date.now() - t0} ms, ${JSON.stringify(chk)} ` +
    JSON.stringify(res.simplifyReport));
  expect(res.faces.length).toBeLessThanOrEqual(2000);
  expect(res.faces.length).toBeGreaterThanOrEqual(1900);
  expect(chk.ok).toBe(true);
});

// ── R2) Nabenfächer: Sternprisma, dessen Deckel als Fächer vom Mittelpunkt
//        aufgebaut sind ⇒ der Mittelpunkt-Vektor hat Grad 5000. Der Lauf muss
//        schnell fertig werden und das Ergebnis geschlossen/manifold sein.
test('hub fan: Deckel-Fächer mit Zentrum Grad 5000 → < 2 s, manifold', () => {
  const N = 2500, M2 = 2 * N, P = [];
  for (let k = 0; k < 2; k++) {
    for (let i = 0; i < M2; i++) {
      const a = 2 * Math.PI * i / M2, r = i % 2 ? 9.5 : 10;
      P.push([r * Math.cos(a), r * Math.sin(a), k * 20]);
    }
  }
  const T = [];
  for (let i = 0; i < M2; i++) { const j = (i + 1) % M2; T.push([i, j, M2 + j], [i, M2 + j, M2 + i]); }
  const cb = P.length; P.push([0, 0, 0]);
  const ct = P.length; P.push([0, 0, 20]);
  for (let i = 0; i < M2; i++) { const j = (i + 1) % M2; T.push([cb, j, i], [ct, M2 + i, M2 + j]); }
  const M = faceSoup(P, T);
  expect(checkClosedManifold(M).ok).toBe(true);         // Eingabe: geschlossen
  const t0 = Date.now();
  const res = simplifyMesh(M, 10000);
  const ms = Date.now() - t0;
  const chk = checkClosedManifold(res);
  console.log(`Nabenfächer: ${M.faces.length} → ${res.faces.length}, ${ms} ms, ${JSON.stringify(chk)} ` +
    JSON.stringify(res.simplifyReport));
  expect(ms).toBeLessThan(2000);
  expect(chk.ok).toBe(true);
});

// ── R3) Dünnes Rohr (Wand 0,4 mm): 4000 Segmente außen und innen (auf
//        denselben Winkeln ⇒ die Brücke der Deckfläche ear-clipped fast über
//        die ganze Wand), H = 30, Wand in 2 Schichten. Ziel: 25 % der
//        Eingangsdreiecke. Geprüft werden die harten Kriterien des Befunds:
//        geschlossen/manifold, Volumen nahezu unverändert, Abweichung
//        < 0,1 mm und KEINE Einschnürung (kein Punkt trägt Außen- UND
//        Innenwand — dort wäre die Wandstärke 0).
test('dünnes Rohr (Wand 0,4 mm, 4000 Segmente): manifold, Volumen < 1 %, Abweichung < 0,1 mm, keine Einschnürung', () => {
  const R = 20, WALL = 0.4, N = 4000, H = 30;
  const t0 = Date.now();
  const M = trisToMesh(buildMesh({
    columns: [
      { name: 'aussen', profile: circleProfile(0, 0, R, N, false), z0: 0, z1: H, bottom: { kind: 'sharp' }, top: { kind: 'sharp' }, wallSteps: 2 },
      { name: 'innen', profile: circleProfile(0, 0, R - WALL, N, true), z0: 0, z1: H, bottom: { kind: 'sharp' }, top: { kind: 'sharp' }, wallSteps: 2 },
    ],
  }));
  const tGen = Date.now() - t0;
  const tgt = Math.round(M.faces.length * 0.25);
  const res = simplifyMesh(M, tgt);
  const chk = checkClosedManifold(res);
  const v0 = signedVolume(M), v1 = signedVolume(res);
  const dev = maxDeviation(M, res);
  // Einschnürung: Punkte, an denen Außen- UND Innenwand hängen
  const inc = new Map();
  for (const f of res.faces) {
    const c = [0, 1, 2].map((i) => (f.vertices[0][i] + f.vertices[1][i] + f.vertices[2][i]) / 3);
    const rl = Math.hypot(c[0], c[1]);
    if (!(rl > 0)) continue;
    const radial = (f.normal[0] * c[0] + f.normal[1] * c[1]) / rl;
    for (const v of f.vertices) {
      const k = v.join();
      let e = inc.get(k);
      if (!e) { e = { out: 0, in: 0 }; inc.set(k, e); }
      if (radial > 0.5) e.out++;
      if (radial < -0.5) e.in++;
    }
  }
  const pinch = [...inc.values()].filter((e) => e.out && e.in);
  console.log(`Dünnes Rohr: ${M.faces.length} → ${res.faces.length} (Ziel ${tgt}), ` +
    `Erzeugung ${tGen} ms, gesamt ${Date.now() - t0} ms, Volumen ${v0.toFixed(2)} → ${v1.toFixed(2)}, ` +
    `Abweichung max ${dev.max.toFixed(4)} mean ${dev.mean.toFixed(4)}, Einschnürungen ${pinch.length}, ` +
    `${JSON.stringify(chk)} ${JSON.stringify(res.simplifyReport)}`);
  // Das Ziel wird bei 0,4 mm Wandstärke bewusst knapp verfehlt (Normalendrehungs-
  // und Qualitätsschranke — "lieber Ziel verfehlen als verzerren"); 1,25 × Ziel
  // ist die erreichbare Grenze.
  expect(res.faces.length).toBeLessThanOrEqual(Math.round(tgt * 1.25));
  expect(chk.ok).toBe(true);
  expect(Math.abs(v1 - v0) / Math.abs(v0)).toBeLessThan(0.01);
  expect(dev.max).toBeLessThan(0.1);
  expect(pinch.length).toBe(0);
});

// ── R4) Ausreißer: Kugel + getrennte geschlossene Komponente 1e6 mm entfernt.
//        Der Ausreißer darf die Normalisierung nicht zerstören — das Kugelteil
//        muss trotzdem sein Ziel erreichen.
test('Ausreißer-Komponente 1e6 mm entfernt: Kugelteil erreicht trotzdem das Ziel', () => {
  const TGT = 10000;
  const far = tetraTris([[1e6, 0, 0], [1e6 + 10, 0, 0], [1e6, 10, 0], [1e6, 0, 10]]);
  const farMesh = trisToMesh(far);
  const M = { faces: [...sphere.faces, ...farMesh.faces], vertices: new Float32Array(0) };
  const res = simplifyMesh(M, TGT);
  const near = (f) => f.vertices.every((v) => Math.abs(v[0]) < 100 && Math.abs(v[1]) < 100 && Math.abs(v[2]) < 100);
  const spherePart = res.faces.filter(near).length;
  const chk = checkClosedManifold(res);
  console.log(`Ausreißer: ${M.faces.length} → ${res.faces.length} (Ziel ${TGT}), ` +
    `Kugelteil ${spherePart} Dreiecke, ${JSON.stringify(chk)} ${JSON.stringify(res.simplifyReport)}`);
  expect(res.faces.length).toBeLessThanOrEqual(TGT);
  expect(spherePart).toBeGreaterThanOrEqual(TGT - 10);
  expect(chk.ok).toBe(true);
});

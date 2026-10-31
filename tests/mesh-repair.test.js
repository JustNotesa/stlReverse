// Tests für mesh-repair.js — non-manifold-Kontaktflächen („Zwillinge") entfernen.
//
// Problem: Zwei flächig aneinandergefügte Körper (Deckel auf Topf, Box auf Box) tragen die
// Kontaktfläche DOPPELT — die Deckfläche des unteren (Normale +z) und die Bodenfläche des
// oberen (Normale -z). Jede Kante dieser Fläche wird von 4 Dreiecken benutzt (non-manifold).
// Die reguläre Vereinigung (BRep) verwirft beide Flächen als innere Zwillinge: die Wände
// laufen durch, jede Kante hat wieder genau 2 Dreiecke.
import { repairNonManifold } from '../mesh-repair.js';
import { box } from './shell-regression.mjs';
import { buildMesh, circleProfile, makeTransform, meshVolume, toBinaryStl } from './fixtures-v2/gen.mjs';
import { parseStl } from '../analysis-core.js';

// Dreieck mit Normale aus der Wicklung
const face = (a, b, c) => {
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const l = Math.hypot(n[0], n[1], n[2]) || 1;
  return { normal: [n[0] / l, n[1] / l, n[2] / l], vertices: [a, b, c] };
};
const meshOf = (tris) => ({ faces: tris.map(([a, b, c]) => face(a, b, c)) });

// Würfel, dessen BODENfläche die andere Diagonale hat (Kontaktfläche anders trianguliert)
const boxOtherBottom = (a, b) => {
  const tris = box(a, b);
  const [x0, y0, z0] = a, [x1, y1, z1] = b;
  const p = [x0, y0, z0], q = [x0, y1, z0], r = [x1, y1, z0], s = [x1, y0, z0];
  tris[0] = [p, q, s];
  tris[1] = [q, r, s];
  return tris;
};

// Geschlossen und mannigfaltig: jede ungerichtete Kante genau 2×, je Kante einmal in jeder Richtung
const closedManifold = (faces) => {
  const dir = new Map();
  const key = (v) => `${v[0].toFixed(4)},${v[1].toFixed(4)},${v[2].toFixed(4)}`;
  for (const f of faces) {
    const v = f.vertices;
    for (let k = 0; k < 3; k++) {
      const u = key(v[k]), w = key(v[(k + 1) % 3]);
      dir.set(`${u}>${w}`, (dir.get(`${u}>${w}`) || 0) + 1);
    }
  }
  for (const [k, n] of dir) {
    if (n !== 1) return false;
    const [a, b] = k.split('>');
    if ((dir.get(`${b}>${a}`) || 0) !== 1) return false;
  }
  return true;
};

// Volumen (Divergenzsatz) des Netzes
const triVolume = (a, b, c) => (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
const volume = (faces) => faces.reduce((s, f) => s + triVolume(f.vertices[0], f.vertices[1], f.vertices[2]), 0);

// Prisma über einem Profil (scharfe Enden)
const prism = (profile, z0, z1) => buildMesh({
  columns: [{ profile, z0, z1, bottom: { kind: 'sharp' }, top: { kind: 'sharp' } }],
});
// Dreiecke in der Ebene z
const trisAtZ = (tris, z) => tris.filter(([a, b, c]) => a[2] === z && b[2] === z && c[2] === z).length;

test('ein einzelner Würfel: nichts zu tun, dasselbe Netz-Objekt', () => {
  const m = meshOf(box([0, 0, 0], [10, 10, 10]));
  const { mesh: out, report } = repairNonManifold(m);
  expect(out).toBe(m);
  expect(report.nonManifoldEdges).toBe(0);
  expect(report.contactPairs).toBe(0);
  expect(report.removedTris).toBe(0);
  expect(report.nonManifoldEdgesAfter).toBe(0);
  expect(report.nonManifoldVerticesAfter).toBe(0);
});

test('zwei Würfel flächig aufeinander: beide Kontaktflächen verschwinden', () => {
  const m = meshOf([...box([0, 0, 0], [10, 10, 10]), ...box([0, 0, 10], [10, 10, 20])]);
  const { mesh: out, report } = repairNonManifold(m);
  expect(report.nonManifoldEdges).toBeGreaterThan(0);
  expect(report.removedTris).toBe(4);
  expect(report.contactPairs).toBeGreaterThan(0);   // die geteilte Diagonale ist selbst non-manifold
  expect(report.nonManifoldEdgesAfter).toBe(0);
  expect(report.nonManifoldVerticesAfter).toBe(0);
  expect(closedManifold(out.faces)).toBe(true);
  expect(volume(out.faces)).toBeCloseTo(2000, 6);
  expect(out.faces.length).toBe(20);
});

test('Kontaktfläche anders trianguliert: trotzdem Zwillingspaar', () => {
  const m = meshOf([...box([0, 0, 0], [10, 10, 10]), ...boxOtherBottom([0, 0, 10], [10, 10, 20])]);
  const { mesh: out, report } = repairNonManifold(m);
  expect(report.removedTris).toBe(4);
  expect(report.contactPairs).toBe(1);
  expect(report.nonManifoldEdgesAfter).toBe(0);
  expect(report.nonManifoldVerticesAfter).toBe(0);
  expect(closedManifold(out.faces)).toBe(true);
  expect(volume(out.faces)).toBeCloseTo(2000, 6);
});

test('zwei 24-Eck-Prismen übereinander: alle Kontaktflächen-Dreiecke weg', () => {
  const prof = circleProfile(0, 0, 10, 24);
  const lower = prism(prof, 0, 10);
  const upper = prism(prof.slice(5).concat(prof.slice(0, 5)), 10, 25);   // Profilanfang gedreht
  const m = meshOf([...lower, ...upper]);
  const { mesh: out, report } = repairNonManifold(m);
  expect(report.contactPairs).toBeGreaterThan(0);
  expect(report.removedTris).toBe(trisAtZ(lower, 10) + trisAtZ(upper, 10));
  expect(report.removedTris).toBeGreaterThan(0);
  expect(report.nonManifoldEdgesAfter).toBe(0);
  expect(report.nonManifoldVerticesAfter).toBe(0);
  expect(closedManifold(out.faces)).toBe(true);
  expect(volume(out.faces)).toBeCloseTo(meshVolume(lower) + meshVolume(upper), 6);
});

test('Berührung nur an einer Kante: nichts wird entfernt', () => {
  const m = meshOf([...box([0, 0, 0], [10, 10, 10]), ...box([10, 0, 10], [20, 10, 20])]);
  const { mesh: out, report } = repairNonManifold(m);
  expect(report.removedTris).toBe(0);
  expect(report.contactPairs).toBe(0);
  expect(report.nonManifoldEdgesAfter).toBe(1);
  expect(report.nonManifoldVerticesAfter).toBe(2);
  expect(out.faces.length).toBe(m.faces.length);
  out.faces.forEach((f, i) => expect(f).toBe(m.faces[i]));
});

test('Berührung nur in einer Ecke: keine non-manifold Kante, Punkt bleibt non-manifold', () => {
  const m = meshOf([...box([0, 0, 0], [10, 10, 10]), ...box([10, 10, 10], [20, 20, 20])]);
  const { mesh: out, report } = repairNonManifold(m);
  expect(report.nonManifoldEdges).toBe(0);
  expect(out).toBe(m);
  expect(report.removedTris).toBe(0);
  expect(report.nonManifoldVerticesAfter).toBe(1);
});

test('derselbe Würfel doppelt (gleiche Orientierung): kein Zwilling', () => {
  const c = box([0, 0, 0], [10, 10, 10]);
  const m = meshOf([...c, ...c]);
  const { mesh: out, report } = repairNonManifold(m);
  expect(report.removedTris).toBe(0);
  expect(report.contactPairs).toBe(0);
  expect(out.faces.length).toBe(24);
});

test('oberer Würfel umgekehrt (inward): Deckflächen gleich orientiert, kein Zwilling', () => {
  const m = meshOf([...box([0, 0, 0], [10, 10, 10]), ...box([0, 0, 10], [10, 10, 20], true)]);
  const { mesh: out, report } = repairNonManifold(m);
  expect(report.removedTris).toBe(0);
  expect(report.contactPairs).toBe(0);
  expect(out.faces.length).toBe(24);
});

test('Teilberührung (verschiedene Kontur): nichts wird entfernt, keine Ausnahme', () => {
  const m = meshOf([...box([0, 0, 0], [10, 10, 10]), ...box([0, 0, 10], [5, 10, 20])]);
  const { mesh: out, report } = repairNonManifold(m);
  expect(report.removedTris).toBe(0);
  expect(report.contactPairs).toBe(0);
  expect(out.faces.length).toBe(24);
});

test('Lage-unabhängigkeit: gedreht/verschoben bleibt dasselbe Ergebnis (float32 über STL)', () => {
  const poses = [{}, { t: [137.3, -88.1, 42.7] }, { rot: [23, 37, 11] }, { rot: [-31, 12, 78], t: [60, 3, -40] }];
  for (const pose of poses) {
    const T = makeTransform(pose);
    const moved = [...box([0, 0, 0], [10, 10, 10]), ...boxOtherBottom([0, 0, 10], [10, 10, 20])]
      .map((t) => t.map((p) => T.apply(p)));
    const buf = toBinaryStl(moved);
    const parsed = parseStl(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), () => {});
    const { mesh: out, report } = repairNonManifold(parsed);
    expect(report.removedTris).toBe(4);
    expect(report.contactPairs).toBe(1);
    expect(report.nonManifoldEdgesAfter).toBe(0);
    expect(closedManifold(out.faces)).toBe(true);
    expect(volume(out.faces)).toBeCloseTo(2000, 3);
  }
});

test('Lage-unabhängigkeit auch beim Prisma', () => {
  const prof = circleProfile(0, 0, 10, 24);
  const tris = [...prism(prof, 0, 10), ...prism(prof.slice(5).concat(prof.slice(0, 5)), 10, 25)];
  const want = trisAtZ(tris, 10);
  for (const pose of [{}, { t: [137.3, -88.1, 42.7] }, { rot: [23, 37, 11] }, { rot: [-31, 12, 78], t: [60, 3, -40] }]) {
    const T = makeTransform(pose);
    const moved = tris.map((t) => t.map((p) => T.apply(p)));
    const buf = toBinaryStl(moved);
    const parsed = parseStl(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), () => {});
    const { mesh: out, report } = repairNonManifold(parsed);
    expect(report.removedTris).toBe(want);
    expect(report.nonManifoldEdgesAfter).toBe(0);
    expect(closedManifold(out.faces)).toBe(true);
  }
});

test('40×40 Platte aus Einzelwürfeln: alle inneren Flächen weg', () => {
  const cells = [];
  for (let i = 0; i < 40; i++) for (let j = 0; j < 40; j++) cells.push(...box([i, j, 0], [i + 1, j + 1, 1]));
  const m = meshOf(cells);
  const t0 = Date.now();
  const { mesh: out, report } = repairNonManifold(m);
  const dt = Date.now() - t0;
  expect(report.nonManifoldEdgesAfter).toBe(0);
  expect(closedManifold(out.faces)).toBe(true);
  expect(volume(out.faces)).toBeCloseTo(1600, 6);
  expect(dt).toBeLessThan(2000);
});

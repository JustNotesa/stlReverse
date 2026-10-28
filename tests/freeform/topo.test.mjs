// ─────────────────────────────────────────────────────────────────────────────
// tests/freeform/topo.test.mjs — Tests für freeform-topology.js
//
// Fälle:  (a) Würfel (6 Regionen)      (b) Zylinder mit Deckel (3 Regionen)
//         (c) Quetschecke              (d) Ikosaeder (20 Regionen)
//         (e) forceVertex zerschneidet eine Kette
//         (f) Leistung: 50 000 Dreiecke / 20 000 Regionen < 1 s
// ─────────────────────────────────────────────────────────────────────────────
import assert from 'node:assert/strict';
import { buildTopology, checkTopology } from '../../freeform-topology.js';

let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log('ok ' + name);
  } catch (e) {
    failed++;
    console.log('FAIL ' + name + ': ' + (e && e.message ? e.message : String(e)));
  }
}

// ── Hilfen ───────────────────────────────────────────────────────────────────
function buildMesh(verts, tris) {
  const P = new Float64Array(verts.length * 3);
  for (let i = 0; i < verts.length; i++) {
    P[3 * i] = verts[i][0]; P[3 * i + 1] = verts[i][1]; P[3 * i + 2] = verts[i][2];
  }
  return { P, tri: new Int32Array(tris), nV: verts.length, T: tris.length / 3 };
}

/** Geschlossen (jede Kante in genau 2 Dreiecken) und auswärts orientiert? */
function assertClosedOutward(mesh, name) {
  const cnt = new Map();
  for (let t = 0; t < mesh.T; t++) {
    for (let e = 0; e < 3; e++) {
      const a = mesh.tri[3 * t + e], b = mesh.tri[3 * t + (e + 1) % 3];
      const k = a < b ? a + '_' + b : b + '_' + a;
      cnt.set(k, (cnt.get(k) || 0) + 1);
    }
  }
  for (const [k, c] of cnt) assert.equal(c, 2, `${name}: Kante ${k} in ${c} Dreiecken`);
  // Volumen über den Flusssatz: positiv ⇒ Außen-Orientierung
  let vol = 0;
  for (let t = 0; t < mesh.T; t++) {
    const p = (i) => {
      const v = mesh.tri[3 * t + i];
      return [mesh.P[3 * v], mesh.P[3 * v + 1], mesh.P[3 * v + 2]];
    };
    const [a, b, c] = [p(0), p(1), p(2)];
    vol += a[0] * (b[1] * c[2] - b[2] * c[1])
         - a[1] * (b[0] * c[2] - b[2] * c[0])
         + a[2] * (b[0] * c[1] - b[1] * c[0]);
  }
  assert.ok(vol / 6 > 0, `${name}: Volumen ${(vol / 6).toFixed(3)} ≤ 0 (Orientierung?)`);
}

/** Schleifenkette: netter Vertex als B-Rep-Ecke? */
function isVertex(topo, mv) { return topo.vOfMesh[mv] >= 0; }

// ── (a) Würfel: 12 Dreiecke, 6 Regionen (je eine Fläche) ───────────────────
function cubeCase() {
  const v = [
    [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
    [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1],
  ];
  const faces = [
    [0, 3, 2, 1],   // unten (-z)
    [4, 5, 6, 7],   // oben (+z)
    [0, 1, 5, 4],   // vorn (-y)
    [2, 3, 7, 6],   // hinten (+y)
    [1, 2, 6, 5],   // rechts (+x)
    [3, 0, 4, 7],   // links (-x)
  ];
  const tris = [], label = [];
  faces.forEach((f, i) => { tris.push(f[0], f[1], f[2], f[0], f[2], f[3]); label.push(i, i); });
  const mesh = buildMesh(v, tris);
  assertClosedOutward(mesh, 'Würfel');
  return { mesh, label: new Int32Array(label) };
}

// ── (b) Zylinder mit Deckeln: 24 Segmente, 3 Regionen ──────────────────────
function cylinderCase(seg = 24) {
  const R = 10, h = 5;
  const verts = [];
  for (let i = 0; i < seg; i++) { const a = 2 * Math.PI * i / seg; verts.push([R * Math.cos(a), R * Math.sin(a), h]); }
  for (let i = 0; i < seg; i++) { const a = 2 * Math.PI * i / seg; verts.push([R * Math.cos(a), R * Math.sin(a), -h]); }
  verts.push([0, 0, h]);        // 2*seg  Deckelmitte oben
  verts.push([0, 0, -h]);       // 2*seg+1 Deckelmitte unten
  const tris = [], label = [];
  for (let i = 0; i < seg; i++) {          // Mantel
    const j = (i + 1) % seg;
    tris.push(i, seg + i, seg + j, i, seg + j, j);
    label.push(0, 0);
  }
  for (let i = 0; i < seg; i++) {          // Deckel oben
    const j = (i + 1) % seg;
    tris.push(2 * seg, i, j);
    label.push(1);
  }
  for (let i = 0; i < seg; i++) {          // Deckel unten
    const j = (i + 1) % seg;
    tris.push(2 * seg + 1, seg + j, seg + i);
    label.push(2);
  }
  const mesh = buildMesh(verts, tris);
  assertClosedOutward(mesh, 'Zylinder');
  return { mesh, label: new Int32Array(label) };
}

// ── (c) Quetschecke: Fächer oben (Regionen 0/1 paarweise alternierend),
//        Fächer unten (Region 2) ─────────────────────────────────────────────
function pinchCase() {
  const verts = [[0, 0, 1]];               // 0 = Quetschmitte oben
  for (let i = 0; i < 8; i++) { const a = 2 * Math.PI * i / 8; verts.push([Math.cos(a), Math.sin(a), 1]); }
  verts.push([0, 0, -1]);                  // 9 = Mitte unten
  const L = [0, 0, 1, 1, 0, 0, 1, 1];
  const tris = [], label = [];
  for (let i = 0; i < 8; i++) {            // Fächer oben
    const j = (i + 1) % 8;
    tris.push(0, 1 + i, 1 + j);
    label.push(L[i]);
  }
  for (let i = 0; i < 8; i++) {            // Fächer unten (gedreht)
    const j = (i + 1) % 8;
    tris.push(9, 1 + j, 1 + i);
    label.push(2);
  }
  const mesh = buildMesh(verts, tris);
  assertClosedOutward(mesh, 'Quetschecke');
  return { mesh, label: new Int32Array(label) };
}

// ── (d) Ikosaeder: 20 Dreiecke, je eine Region ─────────────────────────────
function icosaCase() {
  const t = (1 + Math.sqrt(5)) / 2;
  const verts = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ];
  const faces = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];
  const tris = [], label = [];
  faces.forEach((f, i) => { tris.push(f[0], f[1], f[2]); label.push(i); });
  const mesh = buildMesh(verts, tris);
  assertClosedOutward(mesh, 'Ikosaeder');
  return { mesh, label: new Int32Array(label) };
}

// ── (f) Leistungsnetz: Zylindermantel 125 Spalten × 199 Reihen + 2 Deckel ──
function perfCase() {
  const seg = 125, rows = 199, R = 50, h = 100;
  const verts = [];
  for (let r = 0; r <= rows; r++) {
    for (let s = 0; s < seg; s++) {
      const a = 2 * Math.PI * s / seg;
      verts.push([R * Math.cos(a), R * Math.sin(a), -h + 2 * h * r / rows]);
    }
  }
  const V = (s, r) => r * seg + (s % seg);
  const tris = [], label = [];
  const rowOf = [];                        // Zeilenindex je Dreieck
  for (let r = 0; r < rows; r++) {
    for (let s = 0; s < seg; s++) {
      const s1 = (s + 1) % seg;
      const a = V(s, r), b = V(s1, r), c = V(s1, r + 1), d = V(s, r + 1);
      tris.push(a, b, c, a, c, d);
      rowOf.push(r, r);
    }
  }
  const topC = verts.length; verts.push([0, 0, h]);
  const botC = verts.length; verts.push([0, 0, -h]);
  for (let s = 0; s < seg; s++) {
    const s1 = (s + 1) % seg;
    tris.push(topC, V(s, rows), V(s1, rows)); label.push(-1);
    tris.push(botC, V(s1, 0), V(s, 0)); label.push(-1);
  }
  // Regionen: 19 998 Stücke im Mantel (zeilenweise) + 2 Deckel = 20 000
  const perRow = new Int32Array(rows);
  for (let r = 0; r < rows; r++) perRow[r] = r < 98 ? 101 : 100;
  let region = 0;
  const rowLabel = [];
  for (let r = 0; r < rows; r++) {
    const n = perRow[r], total = 2 * seg;
    for (let k = 0; k < n; k++) {
      const from = Math.floor(k * total / n), to = Math.floor((k + 1) * total / n);
      for (let i = from; i < to; i++) rowLabel[r * 2 * seg + i] = region;
      region++;
    }
  }
  for (let i = 0; i < rowOf.length; i++) label.push(rowLabel[i]);
  for (let i = 0; i < seg * 2; i++) label.push(region + (i < seg ? 0 : 1));
  const mesh = buildMesh(verts, tris);
  return { mesh, label: new Int32Array(label), regions: region + 2 };
}

// ── Tests ───────────────────────────────────────────────────────────────────
test('a) Würfel: 8 Ecken, 12 Ketten, 6 Schleifen à 4', () => {
  const { mesh, label } = cubeCase();
  const topo = buildTopology(mesh, label);
  assert.deepEqual(checkTopology(topo), []);
  assert.equal(topo.vertices.length, 8);
  assert.equal(topo.chains.length, 12);
  assert.equal(topo.loops.length, 6);
  for (const lp of topo.loops) assert.equal(lp.uses.length, 4);
  assert.equal(topo.regionLoops.size, 6);
  // alle 8 Netzpunkte sind B-Rep-Ecken
  for (let i = 0; i < mesh.nV; i++) assert.ok(isVertex(topo, i), `Ecke ${i} fehlt`);
  // jede Kette hat 2 Netzpunkte, L != R
  for (const c of topo.chains) {
    assert.equal(c.mv.length, 2);
    assert.notEqual(c.L, c.R);
  }
});

test('b) Zylinder: 4 Ecken, 4 Ketten, Band 2 Schleifen, Deckel 1', () => {
  const { mesh, label } = cylinderCase(24);
  const topo = buildTopology(mesh, label);
  assert.deepEqual(checkTopology(topo), []);
  assert.equal(topo.vertices.length, 4);
  assert.equal(topo.chains.length, 4);
  assert.equal(topo.loops.length, 4);
  const band = topo.regionLoops.get(0), top = topo.regionLoops.get(1), bot = topo.regionLoops.get(2);
  assert.equal(band.length, 2);
  assert.equal(top.length, 1);
  assert.equal(bot.length, 1);
  assert.equal(topo.loops[top[0]].uses.length, 2);
  assert.equal(topo.loops[bot[0]].uses.length, 2);
  // Die 4 Ecken liegen auf den beiden Randkreisen
  for (const vt of topo.vertices) {
    const z = mesh.P[3 * vt.mv + 2];
    assert.ok(Math.abs(Math.abs(z) - 5) < 1e-9, `Ecke ${vt.mv} liegt nicht am Rand (z=${z})`);
  }
  // Randkreis wird in zwei Ketten à 12 Halbkanten geteilt → 13 Netzpunkte
  for (const c of topo.chains) assert.equal(c.mv.length, 13);
});

test('c) Quetschecke: Region 0 berührt sich nur in der Mitte', () => {
  const { mesh, label } = pinchCase();
  const topo = buildTopology(mesh, label);
  assert.deepEqual(checkTopology(topo), []);
  assert.ok(isVertex(topo, 0), 'Quetschmitte ist keine B-Rep-Ecke');
  // Quetschmitte + 4 Randecken (0,2,4,6) = 5 Ecken, 8 Ketten, 5 Schleifen
  assert.equal(topo.vertices.length, 5);
  assert.equal(topo.chains.length, 8);
  assert.equal(topo.loops.length, 5);
  // Region 0 hat zwei Schleifen, beide laufen über die Quetschmitte
  const r0 = topo.regionLoops.get(0);
  assert.equal(r0.length, 2);
  for (const li of r0) {
    const uses = topo.loops[li].uses;
    const mv = uses.flatMap((u) => topo.chains[u.chain].mv);
    assert.ok(mv.includes(0), 'Schleife der Region 0 läuft nicht über die Mitte');
  }
  // Mitte der Unterseite ist keine Ecke (0 ausgehende Grenz-Halbkanten)
  assert.ok(!isVertex(topo, 9), 'Deckelmitte unten ist fälschlich Ecke');
});

test('d) Ikosaeder: 12 Ecken, 30 Ketten, 20 Schleifen à 3', () => {
  const { mesh, label } = icosaCase();
  const topo = buildTopology(mesh, label);
  assert.deepEqual(checkTopology(topo), []);
  assert.equal(topo.vertices.length, 12);
  assert.equal(topo.chains.length, 30);
  assert.equal(topo.loops.length, 20);
  for (const lp of topo.loops) assert.equal(lp.uses.length, 3);
});

test('e) forceVertex zerschneidet eine Kette', () => {
  const { mesh, label } = cylinderCase(24);
  const base = buildTopology(mesh, label);
  assert.deepEqual(checkTopology(base), []);
  const before = base.chains.find((c) => c.mv.includes(5) && c.mv[0] !== 5 && c.mv[c.mv.length - 1] !== 5);
  assert.ok(before, 'keine Kette mit Netzpunkt 5 im Inneren gefunden');
  const forced = new Uint8Array(mesh.nV);
  forced[5] = 1;
  const topo = buildTopology(mesh, label, { forceVertex: forced });
  assert.deepEqual(checkTopology(topo), []);
  assert.equal(topo.chains.length, base.chains.length + 1);
  const ends = topo.chains.filter((c) => c.mv[0] === 5 || c.mv[c.mv.length - 1] === 5);
  assert.equal(ends.length, 2, 'Netzpunkt 5 ist nicht genau Endpunkt zweier Ketten');
  const inner = topo.chains.filter((c) => c.mv.slice(1, -1).includes(5));
  assert.equal(inner.length, 0, 'Netzpunkt 5 liegt noch im Inneren einer Kette');
});

test('f) Leistung: 50 000 Dreiecke, 20 000 Regionen < 1 s', () => {
  const { mesh, label, regions } = perfCase();
  assert.equal(mesh.T, 50000);
  assert.equal(regions, 20000);
  const t0 = Date.now();
  const topo = buildTopology(mesh, label);
  const ms = Date.now() - t0;
  assert.deepEqual(checkTopology(topo), []);
  assert.ok(ms < 1000, `Laufzeit ${ms} ms ≥ 1000 ms`);
  console.log(`   (50 000 Dreiecke / ${regions} Regionen: ${ms} ms, ${topo.chains.length} Ketten)`);
});

if (failed) process.exit(1);

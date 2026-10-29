// ─────────────────────────────────────────────────────────────────────────────
// tests/freeform/seg.test.mjs — Prüft freeform-segment.js (Netz-Indizierung +
// Fit-basierte Segmentierung) an synthetischen geschlossenen Körpern.
//
// Ausführen:  .dev/test-stl.sh ff-seg
// ─────────────────────────────────────────────────────────────────────────────
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  trianglesFromGroups, indexMesh, segmentByFit, fitModel,
} from '../../freeform-segment.js';
import { parseStl } from '../../analysis-core.js';
import { cleanMesh } from '../../mesh-clean.js';
import { buildNormalGroups } from '../../region-growing.js';

let failed = 0;
const cases = [];
function test(name, fn) { cases.push([name, fn]); }

// ── Zufall (deterministisch) ─────────────────────────────────────────────────
function makeRng(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

// ── Netzgeneratoren (Dreiecke außen gegen Uhrzeiger) ────────────────────────
function boxTris(w, h, d) {
  const x0 = -w / 2, x1 = w / 2, y0 = -h / 2, y1 = h / 2, z0 = -d / 2, z1 = d / 2;
  const P = {
    '000': [x0, y0, z0], '100': [x1, y0, z0], '110': [x1, y1, z0], '010': [x0, y1, z0],
    '001': [x0, y0, z1], '101': [x1, y0, z1], '111': [x1, y1, z1], '011': [x0, y1, z1],
  };
  const quad = (a, b, c, d) => [[P[a], P[b], P[c]], [P[a], P[c], P[d]]];
  return [
    ...quad('001', '101', '111', '011'), // +Z
    ...quad('010', '110', '100', '000'), // −Z
    ...quad('100', '110', '111', '101'), // +X
    ...quad('000', '001', '011', '010'), // −X
    ...quad('010', '011', '111', '110'), // +Y
    ...quad('000', '100', '101', '001'), // −Y
  ];
}

function cylinderTris(R, h, seg) {
  const tris = [];
  const bot = [], top = [];
  for (let i = 0; i < seg; i++) {
    const a = 2 * Math.PI * i / seg;
    bot.push([R * Math.cos(a), R * Math.sin(a), -h / 2]);
    top.push([R * Math.cos(a), R * Math.sin(a), h / 2]);
  }
  for (let i = 0; i < seg; i++) {
    const j = (i + 1) % seg;
    const a = bot[i], b = bot[j], c = top[j], d = top[i];
    tris.push([a, b, c], [a, c, d]);
  }
  const cb = [0, 0, -h / 2], ct = [0, 0, h / 2];
  for (let i = 0; i < seg; i++) {
    const j = (i + 1) % seg;
    tris.push([cb, bot[j], bot[i]]); // Deckel −Z
    tris.push([ct, top[i], top[j]]); // Deckel +Z
  }
  return tris;
}

function sphereTris(R, nu, nv) {
  const tris = [];
  const ring = (j) => {
    const th = Math.PI * j / nv;
    const out = [];
    for (let i = 0; i < nu; i++) {
      const ph = 2 * Math.PI * i / nu;
      out.push([R * Math.sin(th) * Math.cos(ph), R * Math.sin(th) * Math.sin(ph), R * Math.cos(th)]);
    }
    return out;
  };
  const north = [0, 0, R], south = [0, 0, -R];
  const r1 = ring(1);
  for (let i = 0; i < nu; i++) { const j = (i + 1) % nu; tris.push([north, r1[i], r1[j]]); }
  for (let jj = 1; jj < nv - 1; jj++) {
    const up = ring(jj), lo = ring(jj + 1);
    for (let i = 0; i < nu; i++) {
      const j = (i + 1) % nu;
      tris.push([up[i], lo[i], lo[j]]);
      tris.push([up[i], lo[j], up[j]]);
    }
  }
  const rn = ring(nv - 1);
  for (let i = 0; i < nu; i++) { const j = (i + 1) % nu; tris.push([south, rn[j], rn[i]]); }
  return tris;
}

function torusTris(Rm, r, nu, nv) {
  const tris = [];
  const pt = (i, j) => {
    const th = 2 * Math.PI * i / nu, t = 2 * Math.PI * j / nv;
    const rr = Rm + r * Math.cos(t);
    return [rr * Math.cos(th), rr * Math.sin(th), r * Math.sin(t)];
  };
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++) {
      const i2 = (i + 1) % nu, j2 = (j + 1) % nv;
      const a = pt(i, j), b = pt(i2, j), c = pt(i2, j2), d = pt(i, j2);
      tris.push([a, b, c], [a, c, d]);
    }
  }
  return tris;
}

function frustumTris(r0, r1, h, seg) {
  const tris = [];
  const bot = [], top = [];
  for (let i = 0; i < seg; i++) {
    const a = 2 * Math.PI * i / seg;
    bot.push([r0 * Math.cos(a), r0 * Math.sin(a), 0]);
    top.push([r1 * Math.cos(a), r1 * Math.sin(a), h]);
  }
  for (let i = 0; i < seg; i++) {
    const j = (i + 1) % seg;
    const a = bot[i], b = bot[j], c = top[j], d = top[i];
    tris.push([a, b, c], [a, c, d]);
  }
  const cb = [0, 0, 0], ct = [0, 0, h];
  for (let i = 0; i < seg; i++) {
    const j = (i + 1) % seg;
    tris.push([cb, bot[j], bot[i]]);
    tris.push([ct, top[i], top[j]]);
  }
  return tris;
}

// starre Bewegung (Drehung + Verschiebung) — bleibt exakt, keine Rundung
function rigidVariant(tris, seed) {
  const rnd = makeRng(seed);
  const u = [rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1];
  const l = Math.hypot(u[0], u[1], u[2]);
  u[0] /= l; u[1] /= l; u[2] /= l;
  const ang = rnd() * 2 * Math.PI;
  const c = Math.cos(ang), s = Math.sin(ang), C = 1 - c;
  const R = [
    [u[0] * u[0] * C + c, u[0] * u[1] * C - u[2] * s, u[0] * u[2] * C + u[1] * s],
    [u[1] * u[0] * C + u[2] * s, u[1] * u[1] * C + c, u[1] * u[2] * C - u[0] * s],
    [u[2] * u[0] * C - u[1] * s, u[2] * u[1] * C + u[0] * s, u[2] * u[2] * C + c],
  ];
  const t = [(rnd() * 2 - 1) * 40, (rnd() * 2 - 1) * 40, (rnd() * 2 - 1) * 40];
  const ax = [0, 0, 1];
  const trueAxis = [
    R[0][0] * ax[0] + R[0][1] * ax[1] + R[0][2] * ax[2],
    R[1][0] * ax[0] + R[1][1] * ax[1] + R[1][2] * ax[2],
    R[2][0] * ax[0] + R[2][1] * ax[1] + R[2][2] * ax[2],
  ];
  const out = tris.map((tr) => tr.map((p) => [
    R[0][0] * p[0] + R[0][1] * p[1] + R[0][2] * p[2] + t[0],
    R[1][0] * p[0] + R[1][1] * p[1] + R[1][2] * p[2] + t[1],
    R[2][0] * p[0] + R[2][1] * p[1] + R[2][2] * p[2] + t[2],
  ]));
  return { tris: out, trueAxis };
}

const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const byType = (regions, t) => regions.filter((r) => r.type === t);

// ── Fälle ────────────────────────────────────────────────────────────────────
test('box 10x6x4: 6 Ebenen', () => {
  const mesh = indexMesh(boxTris(10, 6, 4));
  assert.ok(mesh, 'indexMesh lieferte null');
  assert.equal(mesh.T, 12);
  assert.equal(mesh.nV, 8);
  const { regions } = segmentByFit(mesh);
  assert.equal(regions.length, 6, `Regionen: ${regions.length} (${regions.map((r) => r.type).join(',')})`);
  for (const r of regions) assert.equal(r.type, 'plane', `Region ${r.id}: ${r.type}`);
});

test('box gedreht: 6 Ebenen', () => {
  const { tris } = rigidVariant(boxTris(10, 6, 4), 11);
  const mesh = indexMesh(tris);
  assert.ok(mesh, 'indexMesh lieferte null');
  const { regions } = segmentByFit(mesh);
  assert.equal(regions.length, 6, `Regionen: ${regions.length} (${regions.map((r) => r.type).join(',')})`);
  for (const r of regions) assert.equal(r.type, 'plane', `Region ${r.id}: ${r.type}`);
});

test('zylinder R5 h10: 1 Zylinder + 2 Ebenen', () => {
  const mesh = indexMesh(cylinderTris(5, 10, 48));
  assert.ok(mesh, 'indexMesh lieferte null');
  assert.equal(mesh.T, 48 * 4);
  const { regions } = segmentByFit(mesh);
  const cyl = byType(regions, 'cylinder');
  assert.equal(cyl.length, 1, `Zylinder: ${cyl.length} (${regions.map((r) => r.type).join(',')})`);
  assert.equal(byType(regions, 'plane').length, 2, `Ebenen: ${byType(regions, 'plane').length}`);
  assert.ok(Math.abs(cyl[0].surf.R - 5) < 1e-3, `R = ${cyl[0].surf.R}`);
  assert.ok(Math.abs(Math.abs(cyl[0].surf.a[2]) - 1) < 1e-6, `Achse ${cyl[0].surf.a}`);
});

test('zylinder gedreht: 1 Zylinder + 2 Ebenen', () => {
  const { tris, trueAxis } = rigidVariant(cylinderTris(5, 10, 48), 23);
  const mesh = indexMesh(tris);
  assert.ok(mesh, 'indexMesh lieferte null');
  const { regions } = segmentByFit(mesh);
  const cyl = byType(regions, 'cylinder');
  assert.equal(cyl.length, 1, `Zylinder: ${cyl.length} (${regions.map((r) => r.type).join(',')})`);
  assert.equal(byType(regions, 'plane').length, 2);
  assert.ok(Math.abs(cyl[0].surf.R - 5) < 1e-3, `R = ${cyl[0].surf.R}`);
  assert.ok(Math.abs(Math.abs(dot3(cyl[0].surf.a, trueAxis)) - 1) < 1e-6, `Achse ${cyl[0].surf.a}`);
});

test('kugel R7: 1 Kugel', () => {
  const mesh = indexMesh(sphereTris(7, 48, 24));
  assert.ok(mesh, 'indexMesh lieferte null');
  const { regions } = segmentByFit(mesh);
  assert.equal(regions.length, 1, `Regionen: ${regions.length} (${regions.map((r) => r.type).join(',')})`);
  assert.equal(regions[0].type, 'sphere');
  assert.ok(Math.abs(regions[0].surf.R - 7) < 1e-3, `R = ${regions[0].surf.R}`);
});

test('kugel gedreht: 1 Kugel', () => {
  const { tris } = rigidVariant(sphereTris(7, 48, 24), 37);
  const mesh = indexMesh(tris);
  assert.ok(mesh, 'indexMesh lieferte null');
  const { regions } = segmentByFit(mesh);
  assert.equal(regions.length, 1, `Regionen: ${regions.length} (${regions.map((r) => r.type).join(',')})`);
  assert.equal(regions[0].type, 'sphere');
  assert.ok(Math.abs(regions[0].surf.R - 7) < 1e-3, `R = ${regions[0].surf.R}`);
});

test('torus Rm10 r2: 1 Torus', () => {
  const mesh = indexMesh(torusTris(10, 2, 48, 24));
  assert.ok(mesh, 'indexMesh lieferte null');
  assert.equal(mesh.T, 48 * 24 * 2);
  const { regions } = segmentByFit(mesh);
  assert.equal(regions.length, 1, `Regionen: ${regions.length} (${regions.map((r) => r.type).join(',')})`);
  assert.equal(regions[0].type, 'torus');
  assert.ok(Math.abs(regions[0].surf.Rm - 10) < 1e-3, `Rm = ${regions[0].surf.Rm}`);
  assert.ok(Math.abs(regions[0].surf.r - 2) < 1e-3, `r = ${regions[0].surf.r}`);
});

test('torus gedreht: 1 Torus', () => {
  const { tris } = rigidVariant(torusTris(10, 2, 48, 24), 53);
  const mesh = indexMesh(tris);
  assert.ok(mesh, 'indexMesh lieferte null');
  const { regions } = segmentByFit(mesh);
  assert.equal(regions.length, 1, `Regionen: ${regions.length} (${regions.map((r) => r.type).join(',')})`);
  assert.equal(regions[0].type, 'torus');
  assert.ok(Math.abs(regions[0].surf.Rm - 10) < 1e-3, `Rm = ${regions[0].surf.Rm}`);
  assert.ok(Math.abs(regions[0].surf.r - 2) < 1e-3, `r = ${regions[0].surf.r}`);
});

test('kegelstumpf 5→2 über 6: 1 Kegel + 2 Ebenen', () => {
  const mesh = indexMesh(frustumTris(5, 2, 6, 48));
  assert.ok(mesh, 'indexMesh lieferte null');
  const { regions } = segmentByFit(mesh);
  const cone = byType(regions, 'cone');
  assert.equal(cone.length, 1, `Kegel: ${cone.length} (${regions.map((r) => r.type).join(',')})`);
  assert.equal(byType(regions, 'plane').length, 2, `Ebenen: ${byType(regions, 'plane').length}`);
  const alpha = cone[0].surf.alpha;
  assert.ok(Math.abs(alpha - Math.atan(3 / 6)) < 1e-3, `alpha = ${alpha} statt ${Math.atan(3 / 6)}`);
});

test('kegelstumpf gedreht: 1 Kegel + 2 Ebenen', () => {
  const { tris } = rigidVariant(frustumTris(5, 2, 6, 48), 71);
  const mesh = indexMesh(tris);
  assert.ok(mesh, 'indexMesh lieferte null');
  const { regions } = segmentByFit(mesh);
  const cone = byType(regions, 'cone');
  assert.equal(cone.length, 1, `Kegel: ${cone.length} (${regions.map((r) => r.type).join(',')})`);
  assert.equal(byType(regions, 'plane').length, 2);
  const alpha = cone[0].surf.alpha;
  assert.ok(Math.abs(alpha - Math.atan(3 / 6)) < 1e-3, `alpha = ${alpha}`);
});

test('indexMesh: mannigfaltig und zusammenhängend', () => {
  const meshes = [
    ['box', boxTris(10, 6, 4)],
    ['zylinder', cylinderTris(5, 10, 48)],
    ['kugel', sphereTris(7, 48, 24)],
    ['torus', torusTris(10, 2, 48, 24)],
    ['stumpf', frustumTris(5, 2, 6, 48)],
  ];
  for (const [name, tris] of meshes) {
    const mesh = indexMesh(tris);
    assert.ok(mesh, `${name}: Netz null`);
    assert.equal(mesh.manifold, true, `${name}: nicht mannigfaltig`);
    assert.equal(mesh.components, 1, `${name}: ${mesh.components} Komponenten`);
    assert.equal(mesh.T, tris.length, `${name}: Dreiecke ${mesh.T} statt ${tris.length}`);
  }
});

test('trianglesFromGroups: Rückweg', () => {
  const tris = boxTris(10, 6, 4);
  const groups = [];
  for (let i = 0; i < tris.length; i += 4) {
    const vertices = [];
    for (const t of tris.slice(i, i + 4)) for (const v of t) vertices.push(v);
    groups.push({ vertices });
  }
  const back = trianglesFromGroups(groups);
  assert.equal(back.length, tris.length);
  for (let i = 0; i < tris.length; i++) {
    for (let k = 0; k < 3; k++) {
      assert.deepEqual(back[i][k], tris[i][k], `Dreieck ${i}, Ecke ${k}`);
    }
  }
});

test('fitModel: kanonische Flächen', () => {
  const cyl = indexMesh(cylinderTris(5, 10, 48));
  const sph = indexMesh(sphereTris(7, 48, 24));
  const tor = indexMesh(torusTris(10, 2, 48, 24));
  // Zylinder nur auf der Mantelfläche (Deckel sind eigene Regionen)
  const { regions } = segmentByFit(cyl);
  const lat = byType(regions, 'cylinder')[0].tris;
  const c = fitModel(cyl, lat, 'cylinder');
  assert.ok(c, 'Zylinder-Fit null');
  assert.equal(c.type, 'cylinder');
  assert.ok(Math.abs(c.R - 5) < 1e-3, `R = ${c.R}`);
  const s = fitModel(sph, Array.from({ length: sph.T }, (_, i) => i), 'sphere');
  assert.ok(s, 'Kugel-Fit null');
  assert.ok(Math.abs(s.R - 7) < 1e-3, `R = ${s.R}`);
  const t = fitModel(tor, Array.from({ length: tor.T }, (_, i) => i), 'torus');
  assert.ok(t, 'Torus-Fit null');
  assert.ok(Math.abs(t.Rm - 10) < 1e-3, `Rm = ${t.Rm}`);
  assert.ok(Math.abs(t.r - 2) < 1e-3, `r = ${t.r}`);
  const p = fitModel(cyl, [0, 1], 'plane');
  assert.ok(p === null || p.type === 'plane');
});

test('Regionen zerlegen das Netz vollständig', () => {
  const meshes = [
    boxTris(10, 6, 4),
    cylinderTris(5, 10, 48),
    sphereTris(7, 48, 24),
    torusTris(10, 2, 48, 24),
    frustumTris(5, 2, 6, 48),
  ];
  for (const tris of meshes) {
    const mesh = indexMesh(tris);
    const { label, regions } = segmentByFit(mesh);
    const seen = new Int32Array(mesh.T).fill(-1);
    for (const r of regions) {
      assert.equal(r.id, regions.indexOf(r));
      for (const f of r.tris) {
        assert.equal(seen[f], -1, `Dreieck ${f} in zwei Regionen`);
        seen[f] = r.id;
        assert.equal(label[f], r.id, `label[${f}] = ${label[f]} statt ${r.id}`);
      }
      const a = r.tris.reduce((s, f) => s + mesh.A[f], 0);
      assert.ok(Math.abs(a - r.area) < 1e-9, `Fläche ${r.area} statt ${a}`);
    }
    for (let f = 0; f < mesh.T; f++) assert.notEqual(seen[f], -1, `Dreieck ${f} ohne Region`);
  }
});

test('Zeitbudget: übrige Dreiecke werden Facetten', () => {
  const mesh = indexMesh(torusTris(10, 2, 48, 24));
  const { label, regions } = segmentByFit(mesh, { timeBudgetMs: 0 });
  assert.ok(regions.length > 0);
  for (const r of regions) {
    assert.equal(r.type, 'facet', `Region ${r.id}: ${r.type}`);
    assert.equal(r.surf, null);
    assert.equal(r.tris.length, 1);
  }
  for (let f = 0; f < mesh.T; f++) assert.ok(label[f] >= 0, `Dreieck ${f} ohne Label`);
});

test('grobe Tessellierung: viele kleine Regionen', () => {
  // stark gewölbte, grob tessellierte Fläche → keine große analytische Region
  const tris = sphereTris(7, 8, 4);
  const mesh = indexMesh(tris);
  const { regions } = segmentByFit(mesh);
  assert.ok(regions.length >= 8, `Regionen: ${regions.length}`);
  for (const r of regions) assert.ok(r.surf, `Region ${r.id} ohne Fläche`);
  const total = regions.reduce((s, r) => s + r.tris.length, 0);
  assert.equal(total, mesh.T);
});

test('Ergebnis ist deterministisch', () => {
  const mesh = indexMesh(torusTris(10, 2, 32, 16));
  const a = segmentByFit(mesh);
  const b = segmentByFit(mesh);
  assert.equal(a.regions.length, b.regions.length);
  for (let i = 0; i < a.regions.length; i++) {
    assert.equal(a.regions[i].type, b.regions[i].type);
    assert.deepEqual(a.regions[i].tris, b.regions[i].tris);
    assert.deepEqual(a.regions[i].surf, b.regions[i].surf);
  }
  assert.deepEqual(Array.from(a.label), Array.from(b.label));
});

test('Kanten: je Kante genau zwei Dreiecke', () => {
  const mesh = indexMesh(torusTris(10, 2, 24, 12));
  let edges = 0;
  for (const [key, faces] of mesh.edgeFaces) {
    assert.equal(faces.length, 2, `Kante ${key}: ${faces.length} Dreiecke`);
    const lo = Math.floor(key / mesh.nV), hi = key - lo * mesh.nV;
    assert.ok(lo < hi, `Kantenschlüssel ${key} nicht min·nV+max`);
    edges++;
  }
  assert.equal(edges, mesh.T * 3 / 2);
  for (let f = 0; f < mesh.T; f++) assert.equal(mesh.adj[f].length, 3, `Dreieck ${f}: ${mesh.adj[f].length} Nachbarn`);
});

test('Echte Netze (Samples): Zylinder, Kegel und Fase erkannt', () => {
  const load = (name) => {
    const buf = readFileSync(new URL(`../../samples/${name}`, import.meta.url));
    const raw = parseStl(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    const mesh = cleanMesh(raw, { minDetailMm: 0.02 }).mesh;
    const tris = trianglesFromGroups(buildNormalGroups(mesh));
    return { tris, netz: indexMesh(tris) };
  };
  // gerader Zylinder: eine Zylinderfläche + zwei Deckel
  {
    const { netz } = load('cylinder.stl');
    assert.ok(netz, 'Zylinder-Netz null');
    const { regions } = segmentByFit(netz);
    assert.equal(byType(regions, 'cylinder').length, 1, `Zylinder: ${regions.map((r) => r.type).join(',')}`);
    assert.equal(byType(regions, 'plane').length, 2);
  }
  // Kegelstumpf: eine Kegelfläche + zwei Deckel
  {
    const { netz } = load('cone_frustum.stl');
    assert.ok(netz, 'Stumpf-Netz null');
    const { regions } = segmentByFit(netz);
    assert.equal(byType(regions, 'cone').length, 1, `Kegel: ${regions.map((r) => r.type).join(',')}`);
    assert.equal(byType(regions, 'plane').length, 2);
  }
  // Verrundung als Zylinder statt als Facettenreihe
  {
    const { netz } = load('block_edge_fillet.stl');
    assert.ok(netz, 'Fase-Netz null');
    const { regions } = segmentByFit(netz);
    assert.ok(byType(regions, 'cylinder').length >= 1, `Zylinder: ${regions.map((r) => r.type).join(',')}`);
    assert.ok(regions.length <= 12, `zu viele Regionen: ${regions.length}`);
  }
});

test('Nicht mannigfaltiges Netz → null', () => {
  const buf = readFileSync(new URL('../../samples/dino_clip_v3_04-strong-closing.stl', import.meta.url));
  const raw = parseStl(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const mesh = cleanMesh(raw, { minDetailMm: 0.02 }).mesh;
  const tris = trianglesFromGroups(buildNormalGroups(mesh));
  assert.equal(indexMesh(tris), null, 'Netz sollte nicht mannigfaltig sein');
});

test('indexMesh: entartete Dreiecke und −0 werden geschweißt', () => {
  const box = boxTris(10, 6, 4);
  // entartetes Dreieck (wiederholter Eckpunkt) wird übersprungen
  const withDeg = box.concat([[[1, 2, 3], [1, 2, 3], [1, 2, 3]]]);
  const m1 = indexMesh(withDeg);
  assert.ok(m1, 'Netz null');
  assert.equal(m1.T, 12, `Dreiecke: ${m1.T}`);
  assert.equal(m1.nV, 8, `Eckpunkte: ${m1.nV}`);
  // -0.0000 und 0.0000 sind derselbe Punkt
  const tiny = box.map((tr) => tr.map((v) => v.map((c) => (c === 0 ? -1e-9 : c))));
  const m2 = indexMesh(tiny);
  assert.ok(m2, 'Netz null');
  assert.equal(m2.nV, 8, `Eckpunkte: ${m2.nV}`);
  assert.equal(m2.T, 12);
});

// ── Echte Freiform-Netze: Regionen-Zählung (Original + starre Drehung) ───────
// Die Zählung muss für das Original und seine starre Drehung gleich sein —
// dafür sorgen die Saat-Reihenfolge (Fläche mit Toleranz, dann drehungs-
// unabhängiger Sekundärschlüssel) und die vertagten Saaten.
const FF_CASES = [
  ['ff_rundquader_r1', { plane: 6, cylinder: 12, sphere: 8 }],
  ['ff_platte_loch_torus', { plane: 6, cylinder: 1, torus: 1 }],
  ['ff_halbkugel_zylinder', { plane: 1, cylinder: 1, sphere: 1 }],
];
for (const [name, want] of FF_CASES) {
  for (const suffix of ['', '_gedreht']) {
    test(`${name}${suffix}: ${JSON.stringify(want)}`, () => {
      const buf = readFileSync(new URL(`./stl/${name}${suffix}.stl`, import.meta.url));
      const raw = parseStl(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
      const mesh = indexMesh(raw.faces.map((f) => f.vertices));
      assert.ok(mesh, 'Netz null');
      const { regions } = segmentByFit(mesh);
      const c = {};
      for (const r of regions) c[r.type] = (c[r.type] || 0) + 1;
      const same = Object.keys(want).length === Object.keys(c).length
        && Object.keys(want).every((k) => c[k] === want[k]);
      console.log(`      ${name}${suffix}: ${mesh.T} Dreiecke → ${regions.length} Regionen ${JSON.stringify(c)}`);
      if (!same) {
        // Diagnose: Regionen kompakt (Typ, Dreiecke, Fläche) — 12 je Zeile
        const parts = regions.map((r) => `R${r.id}:${r.type}/${r.tris.length}/${r.area.toFixed(2)}`);
        for (let i = 0; i < parts.length; i += 12) {
          console.log(`        ${parts.slice(i, i + 12).join(' ')}`);
        }
      }
      assert.deepEqual(c, want, `Regionen ${JSON.stringify(c)} statt ${JSON.stringify(want)}`);
    });
  }
}

// ── Diagnose: Kandidaten je Saat (nur Entwicklungswerkzeug) ───────────────────
test('Diagnose Varianten', () => {
  for (const name of ['ff_platte_loch_torus']) {
    const buf = readFileSync(new URL(`./stl/${name}.stl`, import.meta.url));
    const raw = parseStl(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    const mesh = indexMesh(raw.faces.map((f) => f.vertices));
    let count = 0;
    segmentByFit(mesh, {
      trace: (s, cands, best) => {
        if (!cands.some((c) => c.area > 20)) return;
        count++;
        if (count > 8) return;
        const line = cands.map((c) => `${c.hood}/${c.type}:n${c.len}:a${c.area.toFixed(1)}:r${c.rms.toExponential(1)}`).join(' ');
        const b = best ? `${best.type}:n${best.mem.length}:a${best.area.toFixed(1)}` : 'none';
        console.log(`  ${name} S${s} A${mesh.A[s].toFixed(1)} [${line}] => ${b}`);
      },
    });
  }
});

// ── Laufzeit ─────────────────────────────────────────────────────────────────

test('Laufzeit Torus 48x48', () => {
  const mesh = indexMesh(torusTris(10, 2, 48, 48));
  const t0 = performance.now();
  const { regions } = segmentByFit(mesh);
  const dt = performance.now() - t0;
  console.log(`      Torus 48x48: ${mesh.T} Dreiecke, ${regions.length} Region(en), ${dt.toFixed(0)} ms`);
  assert.equal(regions.length, 1, `Regionen: ${regions.length}`);
});

test('Laufzeit 26000 Dreiecke', () => {
  const mesh = indexMesh(torusTris(10, 2, 130, 100));
  const t0 = performance.now();
  const { regions } = segmentByFit(mesh);
  const dt = performance.now() - t0;
  console.log(`      ${mesh.T} Dreiecke: ${regions.length} Region(en), ${dt.toFixed(0)} ms`);
  assert.ok(dt < 2000, `${dt.toFixed(0)} ms > 2000 ms`);
});

test('Laufzeit viele Regionen', () => {
  // rauhe Kugel → viele kleine Regionen (schlechtester Fall); die Verformung
  // hängt nur vom Ort ab, damit gemeinsame Ecken gemeinsam verschoben bleiben
  const tris = sphereTris(20, 130, 100).map((tr) => tr.map((p) => {
    const s = 1 + 0.02 * Math.sin(3.1 * p[0] + 1.7 * p[1] + 2.3 * p[2]);
    return [p[0] * s, p[1] * s, p[2] * s];
  }));
  const mesh = indexMesh(tris);
  assert.ok(mesh, 'Netz null');
  const t0 = performance.now();
  const { regions } = segmentByFit(mesh);
  const dt = performance.now() - t0;
  console.log(`      rauhe Kugel: ${mesh.T} Dreiecke, ${regions.length} Regionen, ${dt.toFixed(0)} ms`);
  assert.ok(dt < 8000, `${dt.toFixed(0)} ms > 8000 ms`);
});

// ── Ausgabe ──────────────────────────────────────────────────────────────────
for (const [name, fn] of cases) {
  try {
    fn();
    console.log('ok ' + name);
  } catch (e) {
    failed++;
    console.log('FAIL ' + name + ': ' + (e && e.message ? e.message : e));
  }
}
if (failed) {
  console.log(`${failed} Fall/Fälle fehlgeschlagen`);
  process.exit(1);
}
console.log('alle Fälle ok');

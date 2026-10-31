// Testkörper + Netz-Prüfer für mesh-simplify.js (simplifyMesh).
//
// Meshformat wie parseStl (analysis-core.js): { faces: [{ normal, vertices: [[x,y,z]×3], area }],
// vertices: Float32Array }. Die Face-Koordinaten bleiben in Doppel-Genauigkeit (der Float32Array
// ist die float32-Kopie davon) — sonst wäre eine Drehung+Versatzung um 1000 mm bereits mit
// ~1e-4 mm Quantisierung versehen und der Genauigkeitsvergleich unbrauchbar.
//
// Enthält: Erzeuger (Kugel, Torus, Box mit Bohrungen), starre Transformationen, den
// Mannigfaltigkeitsprüfer und Geometrie-Messgrößen (Hausdorff-Abweichung, Selbst-Überschneidung,
// Planarität).
import { writeFileSync } from 'fs';
import { buildMesh, circleProfile, rectProfile } from './fixtures-v2/gen.mjs';

const PI = Math.PI;

// ── Grundhilfen ─────────────────────────────────────────────────────────────
export const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const len3 = (a) => Math.hypot(a[0], a[1], a[2]);
export const unit3 = (a) => { const l = len3(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

// Deterministischer LCG (Numerical Recipes) — reproduzierbare Stichproben.
export function lcg(seed = 0x2f6e2b1) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// ── faceSoup: positions + Dreiecks-Indizes → Mesh (parseStl-Format) ────────
export function faceSoup(positions, tris) {
  const faces = [], flat = [];
  for (const t of tris) {
    const a = positions[t[0]], b = positions[t[1]], c = positions[t[2]];
    const u = sub3(b, a), v = sub3(c, a);
    const n = cross3(u, v);
    const l = len3(n);
    const area = 0.5 * l;
    const va = [a[0], a[1], a[2]];
    const vb = [b[0], b[1], b[2]];
    const vc = [c[0], c[1], c[2]];
    faces.push({
      normal: l > 1e-20 ? [n[0] / l, n[1] / l, n[2] / l] : [0, 0, 0],
      vertices: [va, vb, vc],
      area,
    });
    flat.push(va[0], va[1], va[2], vb[0], vb[1], vb[2], vc[0], vc[1], vc[2]);
  }
  return { faces, vertices: new Float32Array(flat) };
}

// Dreiecksliste (Punkte) → Mesh mit deduplizierten Positionen
export function trisToMesh(tris) {
  const positions = [], index = new Map();
  const idx = tris.map((t) => t.map((p) => {
    const k = `${p[0]},${p[1]},${p[2]}`;
    let i = index.get(k);
    if (i === undefined) { i = positions.length; positions.push(p); index.set(k, i); }
    return i;
  }));
  return faceSoup(positions, idx);
}

// ── Kugel (geschlossen, nach außen orientiert, Pols als EINZIGNE Punkte) ────
export function uvSphere(R = 1, nLat = 32, nLon = 64) {
  const positions = [[0, 0, R]];
  const ringStart = [];
  for (let i = 1; i < nLat; i++) {
    ringStart.push(positions.length);
    const th = PI * i / nLat, st = Math.sin(th), ct = Math.cos(th);
    for (let j = 0; j < nLon; j++) {
      const ph = 2 * PI * j / nLon;
      positions.push([R * st * Math.cos(ph), R * st * Math.sin(ph), R * ct]);
    }
  }
  const south = positions.length;
  positions.push([0, 0, -R]);
  const tris = [];
  for (let j = 0; j < nLon; j++) {                       // Nordfächer
    tris.push([0, ringStart[0] + j, ringStart[0] + (j + 1) % nLon]);
  }
  for (let i = 0; i + 1 < nLat - 1; i++) {               // Bänder
    const s0 = ringStart[i], s1 = ringStart[i + 1];
    for (let j = 0; j < nLon; j++) {
      const j1 = (j + 1) % nLon;
      const a = s0 + j, b = s0 + j1, c = s1 + j1, d = s1 + j;
      tris.push([a, c, b], [a, d, c]);
    }
  }
  const last = ringStart[nLat - 2];
  for (let j = 0; j < nLon; j++) {                       // Süd-Fächer
    tris.push([last + j, south, last + (j + 1) % nLon]);
  }
  return faceSoup(positions, tris);
}

// ── Torus (geschlossen, nach außen orientiert) ─────────────────────────────
export function torus(Rmajor = 1, rminor = 0.3, nU = 64, nV = 32) {
  const positions = [];
  for (let i = 0; i < nU; i++) {
    const u = 2 * PI * i / nU, cu = Math.cos(u), su = Math.sin(u);
    for (let j = 0; j < nV; j++) {
      const v = 2 * PI * j / nV, cv = Math.cos(v), sv = Math.sin(v);
      positions.push([(Rmajor + rminor * cv) * cu, (Rmajor + rminor * cv) * su, rminor * sv]);
    }
  }
  const tris = [];
  for (let i = 0; i < nU; i++) {
    const i1 = (i + 1) % nU;
    for (let j = 0; j < nV; j++) {
      const j1 = (j + 1) % nV;
      const a = i * nV + j, b = i1 * nV + j, c = i1 * nV + j1, d = i * nV + j1;
      tris.push([a, b, c], [a, c, d]);
    }
  }
  return faceSoup(positions, tris);
}

// ── Quader mit senkrechten Durchgangsbohrungen ─────────────────────────────
// Nutzt den Extrusions-Generator aus fixtures-v2/gen.mjs (buildMesh): Außenkontur CCW,
// Bohrungen CW (Löcher), Deckflächen per Ear-Clipping mit Brücken.
// `wallSteps` unterteilt die Wände in Z, `circleSeg` die Bohrungen → feine Netze (bis 500k).
export function boxWithBores({ w = 60, h = 20, d = 40, bores = [], circleSeg = 64, wallSteps = 1, fillet = null } = {}) {
  const cap = fillet ? { kind: 'round', r: fillet.r, N: fillet.N } : { kind: 'sharp' };
  const columns = [{
    name: 'quader', profile: rectProfile(0, 0, w, d), z0: 0, z1: h,
    bottom: cap, top: cap, wallSteps,
  }];
  bores.forEach((b, i) => {
    columns.push({
      name: 'bohrung' + i, profile: circleProfile(b.cx, b.cy, b.r, circleSeg, true),
      z0: 0, z1: h, bottom: cap, top: cap, wallSteps,
    });
  });
  return trisToMesh(buildMesh({ columns }));
}

// ── Starre Transformation (Rodrigues) ───────────────────────────────────────
export function makeRigidTransform({ axis = [0, 0, 1], deg = 0, translate = [0, 0, 0] } = {}) {
  const a = unit3(axis);
  const th = deg * PI / 180, c = Math.cos(th), s = Math.sin(th), t = 1 - c;
  const R = [
    [t * a[0] * a[0] + c, t * a[0] * a[1] - s * a[2], t * a[0] * a[2] + s * a[1]],
    [t * a[0] * a[1] + s * a[2], t * a[1] * a[1] + c, t * a[1] * a[2] - s * a[0]],
    [t * a[0] * a[2] - s * a[1], t * a[1] * a[2] + s * a[0], t * a[2] * a[2] + c],
  ];
  const mul = (p) => [0, 1, 2].map((i) => R[i][0] * p[0] + R[i][1] * p[1] + R[i][2] * p[2]);
  return {
    R,
    apply: (p) => { const q = mul(p); return [q[0] + translate[0], q[1] + translate[1], q[2] + translate[2]]; },
    inverse: (p) => {
      const w = [p[0] - translate[0], p[1] - translate[1], p[2] - translate[2]];
      return [0, 1, 2].map((i) => R[0][i] * w[0] + R[1][i] * w[1] + R[2][i] * w[2]);
    },
  };
}

// Mesh drehen + verschieben (neues Mesh; Normalen mitgedreht, Flächen unverändert)
export function transformMesh(mesh, opts = {}) {
  const T = makeRigidTransform(opts);
  const faces = mesh.faces.map((f) => {
    const v = f.vertices.map((p) => { const q = T.apply(p); return [q[0], q[1], q[2]]; });
    const n = T.apply(f.normal);                        // Normale (Einheits-)Vektor → nur R
    const u = sub3(v[1], v[0]), w = sub3(v[2], v[0]);
    const cr = cross3(u, w), l = len3(cr);
    return {
      normal: l > 1e-20 ? [cr[0] / l, cr[1] / l, cr[2] / l] : [n[0], n[1], n[2]],
      vertices: v,
      area: f.area,
    };
  });
  const flat = [];
  for (const f of faces) for (const v of f.vertices) flat.push(v[0], v[1], v[2]);
  return { faces, vertices: new Float32Array(flat) };
}

// Invers transformieren (Drehung rückgängig + Verschiebung zurück)
export function inverseTransformMesh(mesh, opts = {}) {
  const T = makeRigidTransform(opts);
  const faces = mesh.faces.map((f) => {
    const v = f.vertices.map((p) => { const q = T.inverse(p); return [q[0], q[1], q[2]]; });
    const u = sub3(v[1], v[0]), w = sub3(v[2], v[0]);
    const cr = cross3(u, w), l = len3(cr);
    return {
      normal: l > 1e-20 ? [cr[0] / l, cr[1] / l, cr[2] / l] : [0, 0, 0],
      vertices: v,
      area: f.area,
    };
  });
  const flat = [];
  for (const f of faces) for (const v of f.vertices) flat.push(v[0], v[1], v[2]);
  return { faces, vertices: new Float32Array(flat) };
}

// ── Binäre STL schreiben ───────────────────────────────────────────────────
export function writeBinaryStl(mesh, path) {
  const n = mesh.faces.length;
  const buf = Buffer.alloc(84 + n * 50);
  buf.write('stlReverse simplify-test'.slice(0, 79), 0, 'ascii');
  buf.writeUInt32LE(n, 80);
  let o = 84;
  for (const f of mesh.faces) {
    const [a, b, c] = f.vertices;
    const u = sub3(b, a), v = sub3(c, a);
    const cr = cross3(u, v), l = len3(cr) || 1;
    const vals = [cr[0] / l, cr[1] / l, cr[2] / l, a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]];
    for (const x of vals) { buf.writeFloatLE(x, o); o += 4; }
    buf.writeUInt16LE(0, o); o += 2;
  }
  writeFileSync(path, buf);
  return path;
}

// ── Mannigfaltigkeitsprüfer ────────────────────────────────────────────────
// Kanten = ungerichtet; geschlossen-manifold = jede Kante genau 2×, gegenläufig durchlaufen.
// Welding über EXAKTE Koordinaten-Strings (weldExact=false → 1e-6 gerundet).
export function checkClosedManifold(mesh, { weldExact = true } = {}) {
  const faces = mesh?.faces || [];
  const keyOf = weldExact
    ? (v) => `${v[0]},${v[1]},${v[2]}`
    : (v) => `${v[0].toFixed(6)},${v[1].toFixed(6)},${v[2].toFixed(6)}`;
  const vmap = new Map();
  const idx = new Array(faces.length);
  let degenerateIndexFaces = 0;
  for (let f = 0; f < faces.length; f++) {
    const t = faces[f].vertices;
    const a = [];
    for (let i = 0; i < 3; i++) {
      const k = keyOf(t[i]);
      let id = vmap.get(k);
      if (id === undefined) { id = vmap.size; vmap.set(k, id); }
      a.push(id);
    }
    if (a[0] === a[1] || a[1] === a[2] || a[0] === a[2]) degenerateIndexFaces++;
    idx[f] = a;
  }
  // Kanten: ungerichtet zählen, gerichtet merken (Orientierung), Face-Listen (Fächer)
  const ecount = new Map(), edir = new Map(), eface = new Map();
  const vertFaces = new Map();
  const ekey = (p, q) => (p < q ? `${p}|${q}` : `${q}|${p}`);
  for (let f = 0; f < faces.length; f++) {
    const [a, b, c] = idx[f];
    for (const [p, q] of [[a, b], [b, c], [c, a]]) {
      const k = ekey(p, q);
      ecount.set(k, (ecount.get(k) || 0) + 1);
      let d = edir.get(k);
      if (!d) { d = new Map(); edir.set(k, d); }
      const dk = `${p}>${q}`;
      d.set(dk, (d.get(dk) || 0) + 1);
      let l = eface.get(k);
      if (!l) { l = []; eface.set(k, l); }
      l.push(f);
    }
    for (const v of [a, b, c]) {
      let l = vertFaces.get(v);
      if (!l) { l = []; vertFaces.set(v, l); }
      l.push(f);
    }
  }
  let boundaryEdges = 0, nonManifoldEdges = 0, orientationErrors = 0;
  for (const [k, n] of ecount) {
    if (n === 1) boundaryEdges++;
    else if (n > 2) nonManifoldEdges++;
    if (n >= 2) {
      const d = edir.get(k);
      const p = k.split('|')[0], q = k.split('|')[1];
      const d1 = d.get(`${p}>${q}`) || 0, d2 = d.get(`${q}>${p}`) || 0;
      if (d1 !== 1 || d2 !== 1) orientationErrors++;
    }
  }
  // doppelte Flächen (gleicher Vertex-Satz)
  const fseen = new Map();
  let duplicateFaces = 0;
  for (let f = 0; f < faces.length; f++) {
    const k = idx[f].slice().sort((x, y) => x - y).join(',');
    const c = (fseen.get(k) || 0) + 1;
    fseen.set(k, c);
    if (c > 1) duplicateFaces++;
  }
  // Fächer: um einen Vertex müssen die angrenzenden Flächen EINEN Zyklus bilden
  let multiFanVerts = 0;
  for (const [v, fl] of vertFaces) {
    if (fl.length <= 1) continue;
    const seen = new Set([fl[0]]);
    const stack = [fl[0]];
    while (stack.length) {
      const f = stack.pop();
      const [a, b, c] = idx[f];
      const spokes = [];
      if (a === v) spokes.push(ekey(v, b), ekey(v, c));
      else if (b === v) spokes.push(ekey(v, a), ekey(v, c));
      else spokes.push(ekey(v, a), ekey(v, b));
      for (const s of spokes) {
        for (const g of eface.get(s) || []) {
          if (!seen.has(g)) { seen.add(g); stack.push(g); }
        }
      }
    }
    if (seen.size < fl.length) multiFanVerts++;
  }
  const verts = vmap.size, edges = ecount.size, facesN = faces.length;
  const eulerChar = verts - edges + facesN;
  const ok = boundaryEdges === 0 && nonManifoldEdges === 0 && orientationErrors === 0 &&
    duplicateFaces === 0 && degenerateIndexFaces === 0 && multiFanVerts === 0;
  return {
    ok, faces: facesN, verts, boundaryEdges, nonManifoldEdges, orientationErrors,
    duplicateFaces, degenerateIndexFaces, multiFanVerts, eulerChar,
  };
}

// ── Einseitiger Hausdorff-Abstand (Stichproben aus A → nächste Fläche in B) ─
const dist2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

// Nächster Punkt auf einer Strecke
function closestOnSegment(p, a, b) {
  const ab = sub3(b, a);
  const l2 = dot3(ab, ab);
  if (!(l2 > 0)) return a;
  let t = dot3(sub3(p, a), ab) / l2;
  t = t < 0 ? 0 : (t > 1 ? 1 : t);
  return [a[0] + t * ab[0], a[1] + t * ab[1], a[2] + t * ab[2]];
}

// Nächster Punkt auf einem Dreieck — robust auch bei sehr flachen Dreiecken
// (Ebene-Projektion + Kreuzprodukt-Baryzentrik statt auslöschender Differenzen).
function closestPointOnTriangle(p, a, b, c) {
  const u = sub3(b, a), v = sub3(c, a), w = sub3(p, a);
  const n = cross3(u, v);
  const n2 = dot3(n, n);
  if (!(n2 > 1e-30)) {                       // entartet → auf eine Kante projizieren
    const q1 = closestOnSegment(p, a, b), q2 = closestOnSegment(p, b, c), q3 = closestOnSegment(p, c, a);
    const d1 = dist2(p, q1), d2 = dist2(p, q2), d3 = dist2(p, q3);
    return d1 <= d2 && d1 <= d3 ? q1 : (d2 <= d3 ? q2 : q3);
  }
  const t = dot3(n, w) / n2;                // Punkt auf die Dreiecksebene projizieren
  const pp = [p[0] - t * n[0], p[1] - t * n[1], p[2] - t * n[2]];
  const wp = sub3(pp, a);
  const lb = dot3(cross3(wp, v), n) / n2;    // baryzentrisch (vorzeichenstabil)
  const lc = dot3(cross3(u, wp), n) / n2;
  const la = 1 - lb - lc;
  if (la >= 0 && lb >= 0 && lc >= 0) return pp;   // innerhalb → Ebenenfußpunkt
  const q1 = closestOnSegment(pp, a, b), q2 = closestOnSegment(pp, b, c), q3 = closestOnSegment(pp, c, a);
  const d1 = dist2(p, q1), d2 = dist2(p, q2), d3 = dist2(p, q3);
  return d1 <= d2 && d1 <= d3 ? q1 : (d2 <= d3 ? q2 : q3);
}

// Uniformes Gitter über den Dreiecken (BBox-Zellen)
function buildTriGrid(tris) {
  const n = tris.length;
  let minx = Infinity, miny = Infinity, minz = Infinity, maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
  for (const t of tris) for (const p of t) {
    if (p[0] < minx) minx = p[0]; if (p[0] > maxx) maxx = p[0];
    if (p[1] < miny) miny = p[1]; if (p[1] > maxy) maxy = p[1];
    if (p[2] < minz) minz = p[2]; if (p[2] > maxz) maxz = p[2];
  }
  const ext = Math.max(maxx - minx, maxy - miny, maxz - minz) || 1;
  const nCells = Math.max(1, Math.ceil(Math.cbrt(Math.max(1, n))));
  const h = ext / nCells;
  const nc = [
    Math.max(1, Math.ceil((maxx - minx) / h) || 1),
    Math.max(1, Math.ceil((maxy - miny) / h) || 1),
    Math.max(1, Math.ceil((maxz - minz) / h) || 1),
  ];
  const cells = new Map();
  const ckey = (i, j, k) => `${i}|${j}|${k}`;
  const cellOf = (p) => [
    Math.min(nc[0] - 1, Math.max(0, Math.floor((p[0] - minx) / h))),
    Math.min(nc[1] - 1, Math.max(0, Math.floor((p[1] - miny) / h))),
    Math.min(nc[2] - 1, Math.max(0, Math.floor((p[2] - minz) / h))),
  ];
  const bboxCells = (t) => {
    const c0 = cellOf(t[0]), c1 = cellOf(t[1]), c2 = cellOf(t[2]);
    const lo = [Math.min(c0[0], c1[0], c2[0]), Math.min(c0[1], c1[1], c2[1]), Math.min(c0[2], c1[2], c2[2])];
    const hi = [Math.max(c0[0], c1[0], c2[0]), Math.max(c0[1], c1[1], c2[1]), Math.max(c0[2], c1[2], c2[2])];
    return [lo, hi];
  };
  const big = [];
  for (let i = 0; i < n; i++) {
    const [lo, hi] = bboxCells(tris[i]);
    const span = (hi[0] - lo[0] + 1) * (hi[1] - lo[1] + 1) * (hi[2] - lo[2] + 1);
    if (span > 512) {
      // Welt-BBox merken (für die Abstandssuche), Zell-Bbox reicht nicht
      const t = tris[i];
      const wlo = [
        Math.min(t[0][0], t[1][0], t[2][0]), Math.min(t[0][1], t[1][1], t[2][1]),
        Math.min(t[0][2], t[1][2], t[2][2]),
      ];
      const whi = [
        Math.max(t[0][0], t[1][0], t[2][0]), Math.max(t[0][1], t[1][1], t[2][1]),
        Math.max(t[0][2], t[1][2], t[2][2]),
      ];
      big.push({ i, lo: wlo, hi: whi });
      continue;
    }
    for (let a = lo[0]; a <= hi[0]; a++) for (let b = lo[1]; b <= hi[1]; b++) for (let c = lo[2]; c <= hi[2]; c++) {
      const k = ckey(a, b, c);
      let l = cells.get(k);
      if (!l) { l = []; cells.set(k, l); }
      l.push(i);
    }
  }
  return {
    h, nc, minx, miny, minz, cellOf, bboxCells, big,
    cellList: (i, j, k) => cells.get(ckey(i, j, k)),
    candidates(t) {
      const [lo, hi] = bboxCells(t);
      const out = new Set(big.map((b) => b.i));
      for (let a = lo[0]; a <= hi[0]; a++) for (let b = lo[1]; b <= hi[1]; b++) for (let c = lo[2]; c <= hi[2]; c++) {
        const l = cells.get(ckey(a, b, c));
        if (l) for (const i of l) out.add(i);
      }
      return out;
    },
  };
}

// Abstand eines Punktes zur nächsten Fläche von B (Gitter + Ringsuche)
function nearestDistance(grid, tris, p) {
  const c = grid.cellOf(p);
  let best = Infinity;
  // Sehr große Dreiecke (z. B. lange Ohr-Clipping-Dreiecke einer Deckfläche) liegen in zu
  // vielen Zellen → sie werden separat geführt und hier immer geprüft.
  for (const b of grid.big) {
    const dx = Math.max(b.lo[0] - p[0], 0, p[0] - b.hi[0]);
    const dy = Math.max(b.lo[1] - p[1], 0, p[1] - b.hi[1]);
    const dz = Math.max(b.lo[2] - p[2], 0, p[2] - b.hi[2]);
    if (dx * dx + dy * dy + dz * dz >= best * best) continue;
    const t = tris[b.i];
    const q = closestPointOnTriangle(p, t[0], t[1], t[2]);
    const d = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
    if (d < best) best = d;
  }
  for (let ring = 0; ring < 64; ring++) {
    const lo = [c[0] - ring, c[1] - ring, c[2] - ring];
    const hi = [c[0] + ring, c[1] + ring, c[2] + ring];
    for (let a = lo[0]; a <= hi[0]; a++) for (let b = lo[1]; b <= hi[1]; b++) for (let cc = lo[2]; cc <= hi[2]; cc++) {
      const cheb = Math.max(Math.abs(a - c[0]), Math.abs(b - c[1]), Math.abs(cc - c[2]));
      if (cheb !== ring) continue;
      if (a < 0 || b < 0 || cc < 0 || a >= grid.nc[0] || b >= grid.nc[1] || cc >= grid.nc[2]) continue;
      const bucket = grid.cellList(a, b, cc);
      if (!bucket) continue;
      for (const i of bucket) {
        const t = tris[i];
        const q = closestPointOnTriangle(p, t[0], t[1], t[2]);
        const d = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
        if (d < best) best = d;
      }
    }
    if (best <= ring * grid.h) break;
  }
  return best;
}

export function maxDeviation(meshA, meshB, samples = 2000) {
  const A = meshA.faces.map((f) => f.vertices);
  const B = meshB.faces.map((f) => f.vertices);
  if (!A.length || !B.length) return { max: Infinity, mean: Infinity };
  const grid = buildTriGrid(B);
  const rng = lcg(0x9e3779b9);
  let max = 0, sum = 0;
  for (let s = 0; s < samples; s++) {
    const fi = Math.min(A.length - 1, Math.floor(rng() * A.length));
    const t = A[fi];
    let r1 = rng(), r2 = rng();
    if (r1 + r2 > 1) { r1 = 1 - r1; r2 = 1 - r2; }
    const p = [
      t[0][0] + r1 * (t[1][0] - t[0][0]) + r2 * (t[2][0] - t[0][0]),
      t[0][1] + r1 * (t[1][1] - t[0][1]) + r2 * (t[2][1] - t[0][1]),
      t[0][2] + r1 * (t[1][2] - t[0][2]) + r2 * (t[2][2] - t[0][2]),
    ];
    const d = nearestDistance(grid, B, p);
    if (d > max) max = d;
    sum += d;
  }
  return { max, mean: sum / samples };
}

// ── Selbst-Überschneidung (Stichprobe) ─────────────────────────────────────
// Dreieck-Dreieck-Test nach Möller (1997); Paare, die einen Punkt gemeinsam haben,
// werden übersprungen (nicht "adjacent" im Mesh, aber geometrisch benachbart).
function triTriIntersect(V0, V1, V2, U0, U1, U2, eps) {
  let n1 = cross3(sub3(V1, V0), sub3(V2, V0));
  let n2 = cross3(sub3(U1, U0), sub3(U2, U0));
  const l1 = len3(n1), l2 = len3(n2);
  if (l1 < 1e-18 || l2 < 1e-18) return false;
  n1 = [n1[0] / l1, n1[1] / l1, n1[2] / l1];
  n2 = [n2[0] / l2, n2[1] / l2, n2[2] / l2];
  const d1 = -dot3(n1, V0), d2 = -dot3(n2, U0);
  const dv = [dot3(n2, V0) + d2, dot3(n2, V1) + d2, dot3(n2, V2) + d2];
  const du = [dot3(n1, U0) + d1, dot3(n1, U1) + d1, dot3(n1, U2) + d1];
  const coplanar = dv.every((x) => Math.abs(x) <= eps) && du.every((x) => Math.abs(x) <= eps);
  if (coplanar) return coplanarOverlap(V0, V1, V2, U0, U1, U2, n1, eps);
  if (dv.every((x) => x > eps) || dv.every((x) => x < -eps)) return false;
  if (du.every((x) => x > eps) || du.every((x) => x < -eps)) return false;
  const D = cross3(n1, n2);
  const dl = len3(D);
  if (dl < 1e-18) return false;
  const tOf = (P) => dot3(sub3(P, V0), D);
  const tV = [], tU = [];
  const V = [V0, V1, V2], U = [U0, U1, U2];
  for (let i = 0; i < 3; i++) {
    const j = (i + 1) % 3;
    if ((du[i] > eps && du[j] < -eps) || (du[i] < -eps && du[j] > eps)) {
      const s = du[i] / (du[i] - du[j]);
      const P = [
        V[i][0] + s * (V[j][0] - V[i][0]),
        V[i][1] + s * (V[j][1] - V[i][1]),
        V[i][2] + s * (V[j][2] - V[i][2]),
      ];
      tV.push(tOf(P));
    }
    if ((dv[i] > eps && dv[j] < -eps) || (dv[i] < -eps && dv[j] > eps)) {
      const s = dv[i] / (dv[i] - dv[j]);
      const P = [
        U[i][0] + s * (U[j][0] - U[i][0]),
        U[i][1] + s * (U[j][1] - U[i][1]),
        U[i][2] + s * (U[j][2] - U[i][2]),
      ];
      tU.push(tOf(P));
    }
  }
  if (!tV.length || !tU.length) return false;
  const tVmin = Math.min(...tV), tVmax = Math.max(...tV);
  const tUmin = Math.min(...tU), tUmax = Math.max(...tU);
  return !(tVmax < tUmin || tUmax < tVmin);
}

// Koplanare Dreiecke: 2D-Überlappung in der dominanten Ebene
function coplanarOverlap(V0, V1, V2, U0, U1, U2, n, eps) {
  const ax = Math.abs(n[0]), ay = Math.abs(n[1]), az = Math.abs(n[2]);
  const drop = ax > ay && ax > az ? 0 : (ay > az ? 1 : 2);
  const p2 = (p) => (drop === 0 ? [p[1], p[2]] : (drop === 1 ? [p[0], p[2]] : [p[0], p[1]]));
  const A = [p2(V0), p2(V1), p2(V2)], B = [p2(U0), p2(U1), p2(U2)];
  const area2 = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const segInt = (p1, p2_, p3, p4) => {
    const d1 = area2(p3, p4, p1), d2 = area2(p3, p4, p2_), d3 = area2(p1, p2_, p3), d4 = area2(p1, p2_, p4);
    if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
    const on = (a, b, c) => Math.abs(area2(a, b, c)) <= eps && Math.min(a[0], b[0]) - eps <= c[0] && c[0] <= Math.max(a[0], b[0]) + eps && Math.min(a[1], b[1]) - eps <= c[1] && c[1] <= Math.max(a[1], b[1]) + eps;
    if (on(p3, p4, p1) || on(p3, p4, p2_)) return true;
    if (on(p1, p2_, p3) || on(p1, p2_, p4)) return true;
    return false;
  };
  const inside = (p, t) => {
    const a = area2(t[0], t[1], p), b = area2(t[1], t[2], p), c = area2(t[2], t[0], p);
    return a >= -eps && b >= -eps && c >= -eps;
  };
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    if (segInt(A[i], A[(i + 1) % 3], B[j], B[(j + 1) % 3])) return true;
  }
  for (const p of A) if (inside(p, B)) return true;
  for (const p of B) if (inside(p, A)) return true;
  return false;
}

export function selfIntersectionSample(mesh, samples = 3000) {
  const tris = mesh.faces.map((f) => f.vertices);
  if (tris.length < 2) return { tested: 0, hits: 0 };
  const keys = tris.map((t) => new Set(t.map((p) => `${p[0]},${p[1]},${p[2]}`)));
  const grid = buildTriGrid(tris);
  let diag = 0;
  {
    let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (const t of tris) for (const p of t) for (let i = 0; i < 3; i++) { if (p[i] < mn[i]) mn[i] = p[i]; if (p[i] > mx[i]) mx[i] = p[i]; }
    diag = Math.hypot(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]) || 1;
  }
  const eps = diag * 1e-9;
  const rng = lcg(0x51ed270b);
  const hitsSet = new Set();
  let tested = 0;
  for (let s = 0; s < samples; s++) {
    const fi = Math.min(tris.length - 1, Math.floor(rng() * tris.length));
    const cands = grid.candidates(tris[fi]);
    for (const gj of cands) {
      if (gj === fi) continue;
      const A = tris[fi], B = tris[gj];
      // BBox-Overlap?
      let overlap = true;
      for (let i = 0; i < 3; i++) {
        const a0 = Math.min(A[0][i], A[1][i], A[2][i]), a1 = Math.max(A[0][i], A[1][i], A[2][i]);
        const b0 = Math.min(B[0][i], B[1][i], B[2][i]), b1 = Math.max(B[0][i], B[1][i], B[2][i]);
        if (a1 < b0 - eps || b1 < a0 - eps) { overlap = false; break; }
      }
      if (!overlap) continue;
      // gemeinsamer Punkt? → geometrisch benachbart, überspringen
      let shared = false;
      for (const k of keys[fi]) if (keys[gj].has(k)) { shared = true; break; }
      if (shared) continue;
      tested++;
      if (triTriIntersect(A[0], A[1], A[2], B[0], B[1], B[2], eps)) {
        const key = fi < gj ? `${fi}|${gj}` : `${gj}|${fi}`;
        hitsSet.add(key);
      }
    }
  }
  return { tested, hits: hitsSet.size };
}

// ── Planarität: max |n·v + d| über die Flächen mit Normale ≈ n ─────────────
export function planeDeviationStats(mesh, n, d, tol = 1e-6) {
  const nn = unit3(n);
  let max = 0, count = 0;
  for (const f of mesh.faces) {
    const fn = unit3(f.normal);
    if (Math.abs(fn[0] - nn[0]) > tol || Math.abs(fn[1] - nn[1]) > tol || Math.abs(fn[2] - nn[2]) > tol) continue;
    count++;
    for (const v of f.vertices) {
      const dev = Math.abs(nn[0] * v[0] + nn[1] * v[1] + nn[2] * v[2] + d);
      if (dev > max) max = dev;
    }
  }
  return { max, count };
}
export function planeDeviation(mesh, n, d, tol = 1e-6) {
  return planeDeviationStats(mesh, n, d, tol).max;
}

// Bounding-Box-Diagonale (für relative Abweichungen)
export function bboxDiagonal(mesh) {
  let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const f of mesh.faces) for (const v of f.vertices) for (let i = 0; i < 3; i++) {
    if (v[i] < mn[i]) mn[i] = v[i];
    if (v[i] > mx[i]) mx[i] = v[i];
  }
  return Math.hypot(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]) || 1;
}

// Signed Volumen (Divergenzsatz) — positiv bei nach außen orientierten Netzen
export function signedVolume(mesh) {
  let v = 0;
  for (const f of mesh.faces) {
    const [a, b, c] = f.vertices;
    v += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
  }
  return v;
}

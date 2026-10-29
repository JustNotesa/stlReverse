// ─────────────────────────────────────────────────────────────────────────────
// freeform-segment.js — Netz-Indizierung und Fit-basierte Segmentierung für den
// Freiform-Pfad (Etappe 1, siehe Entwurfskopf in freeform-brep.js).
//
//   1. indexMesh(triangles) — Dreiecke schweißen, Normalen/Flächen berechnen,
//      Kantennachbarschaft, Mannigfaltigkeit, Zusammenhang. Nur EINE dichte,
//      mannigfaltige Schale wird akzeptiert, sonst null.
//   2. segmentByFit(mesh, opts) — Region-Growing mit Modell-Fit
//      (Ebene/Zylinder/Kegel/Kugel/Torus) → label[] + regions[].
//
// Datenmodell (verbindlich, siehe freeform-brep.js):
//   Netz   { P: Float64Array(3·nV), tri: Int32Array(3·T), nV, T,
//            N: Float64Array(3·T)  Einheitsnormalen je Dreieck,
//            A: Float64Array(T)      Flächen je Dreieck,
//            adj: Array(T)           [[Nachbar, Dihedral°], …],
//            edgeFaces: Map(Kante → [Dreiecke]), manifold, components }
//   Fläche  { type:'plane',    o, n }
//           { type:'cylinder', o (Punkt auf der Achse), a, R }
//           { type:'cone',     apex, a (öffnet in +a), alpha (Halbwinkel rad) }
//           { type:'sphere',   c, R }
//           { type:'torus',    c, a, Rm (groß), r (klein), Rm > r > 0 }
// Alle Längen in mm, Winkel intern in rad, Dihedral in Grad.
// ─────────────────────────────────────────────────────────────────────────────

// ── Vektor-Helfer ────────────────────────────────────────────────────────────
const cr = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const L = (a) => Math.hypot(a[0], a[1], a[2]);
const nrm = (a) => { const l = L(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

// Orthonormale Basis zu a (u ⟂ a, v = a × u)
function basis(ax) {
  let u = cr(ax, [1, 0, 0]);
  if (L(u) < 1e-6) u = cr(ax, [0, 1, 0]);
  u = nrm(u);
  return [u, cr(ax, u)];
}

// Symmetrische 3×3-Matrix: kleinster Eigenvektor (Achse), größter (Ausdehnung)
function eig3(M) {
  const A = M.map((r) => r.slice());
  const V = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let it = 0; it < 60; it++) {
    let p = 0, q = 1;
    let mx = Math.abs(A[0][1]);
    if (Math.abs(A[0][2]) > mx) { mx = Math.abs(A[0][2]); p = 0; q = 2; }
    if (Math.abs(A[1][2]) > mx) { mx = Math.abs(A[1][2]); p = 1; q = 2; }
    if (mx < 1e-15) break;
    const th = (A[q][q] - A[p][p]) / (2 * A[p][q]);
    const t = (th >= 0 ? 1 : -1) / (Math.abs(th) + Math.sqrt(th * th + 1));
    const c = 1 / Math.sqrt(t * t + 1), s = t * c;
    for (let k = 0; k < 3; k++) { const a = A[k][p], b = A[k][q]; A[k][p] = c * a - s * b; A[k][q] = s * a + c * b; }
    for (let k = 0; k < 3; k++) { const a = A[p][k], b = A[q][k]; A[p][k] = c * a - s * b; A[q][k] = s * a + c * b; }
    for (let k = 0; k < 3; k++) { const a = V[k][p], b = V[k][q]; V[k][p] = c * a - s * b; V[k][q] = s * a + c * b; }
  }
  const vals = [A[0][0], A[1][1], A[2][2]];
  const idx = [0, 1, 2].sort((i, j) => vals[i] - vals[j]);
  return {
    values: idx.map((i) => vals[i]),
    vectors: idx.map((i) => [V[0][i], V[1][i], V[2][i]]),
  };
}

// lineares System (Gauss-Jordan mit Spaltenpivotisierung); null bei singulär
function solveN(M, b) {
  const n = b.length;
  const a = M.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
    if (Math.abs(a[p][c]) < 1e-14) return null;
    [a[c], a[p]] = [a[p], a[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = a[r][c] / a[c][c];
      for (let k = c; k <= n; k++) a[r][k] -= f * a[c][k];
    }
  }
  return a.map((r, i) => r[n] / r[i]);
}

// Achsrichtung deterministisch orientieren: erstes wesentliches Vorzeichen +.
function canonicalAxis(a) {
  const ax = [a[0], a[1], a[2]];
  let s = 1;
  if (ax[0] < -1e-12) s = -1;
  else if (Math.abs(ax[0]) <= 1e-12) {
    if (ax[1] < -1e-12) s = -1;
    else if (Math.abs(ax[1]) <= 1e-12 && ax[2] < 0) s = -1;
  }
  return [ax[0] * s, ax[1] * s, ax[2] * s];
}

const now = () => (globalThis.performance && globalThis.performance.now)
  ? globalThis.performance.now() : Date.now();

// ── Schritt 1: Dreiecksgruppen → Netz ────────────────────────────────────────

// Normalgruppen (je Gruppe .vertices = flache Liste [x,y,z] …) → Dreiecksliste
export function trianglesFromGroups(normalGroups) {
  const out = [];
  for (const g of normalGroups) {
    const v = g && g.vertices;
    if (!v || v.length < 3) continue;
    for (let i = 0; i + 2 < v.length; i += 3) out.push([v[i], v[i + 1], v[i + 2]]);
  }
  return out;
}

// Eckpunkt-Schlüssel: 4 Nachkommastellen, -0 → 0
const fz = (x) => { const s = x.toFixed(4); return s === '-0.0000' ? '0.0000' : s; };
const vkey = (v) => `${fz(v[0])},${fz(v[1])},${fz(v[2])}`;

// Dreiecke → geschweißtes Netz. Nur EINE dichte, mannigfaltige Schale → Netz,
// sonst null (siehe Entwurfskopf freeform-brep.js).
export function indexMesh(triangles) {
  if (!triangles || !triangles.length) return null;
  const vid = new Map();
  const px = [], py = [], pz = [];
  const idx = [];
  for (let f = 0; f < triangles.length; f++) {
    const t = triangles[f];
    if (!t || t.length < 3) continue;
    const keys = [vkey(t[0]), vkey(t[1]), vkey(t[2])];
    // entartete Dreiecke (wiederholter Eckpunkt) überspringen
    if (keys[0] === keys[1] || keys[1] === keys[2] || keys[0] === keys[2]) continue;
    const ids = [];
    for (let k = 0; k < 3; k++) {
      const v = t[k];
      let i = vid.get(keys[k]);
      if (i === undefined) {
        i = px.length;
        vid.set(keys[k], i);
        px.push(v[0]); py.push(v[1]); pz.push(v[2]);
      }
      ids.push(i);
    }
    idx.push(ids[0], ids[1], ids[2]);
  }
  const T = idx.length / 3;
  if (T === 0) return null;
  const nV = px.length;
  const P = new Float64Array(3 * nV);
  for (let i = 0; i < nV; i++) { P[3 * i] = px[i]; P[3 * i + 1] = py[i]; P[3 * i + 2] = pz[i]; }
  const tri = Int32Array.from(idx);

  const N = new Float64Array(3 * T);
  const A = new Float64Array(T);
  for (let f = 0; f < T; f++) {
    const i0 = tri[3 * f], i1 = tri[3 * f + 1], i2 = tri[3 * f + 2];
    const ax = P[3 * i1] - P[3 * i0], ay = P[3 * i1 + 1] - P[3 * i0 + 1], az = P[3 * i1 + 2] - P[3 * i0 + 2];
    const bx = P[3 * i2] - P[3 * i0], by = P[3 * i2 + 1] - P[3 * i0 + 1], bz = P[3 * i2 + 2] - P[3 * i0 + 2];
    const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    const l = Math.hypot(nx, ny, nz);
    A[f] = l / 2;
    if (l > 0) { N[3 * f] = nx / l; N[3 * f + 1] = ny / l; N[3 * f + 2] = nz / l; }
  }

  // Kanten: Map(min·nV+max → Dreiecksliste) + gerichtete Zählung
  const edgeFaces = new Map();
  const dirCount = new Map();
  for (let f = 0; f < T; f++) {
    for (let k = 0; k < 3; k++) {
      const i = tri[3 * f + k], j = tri[3 * f + (k + 1) % 3];
      if (i === j) continue;
      const lo = i < j ? i : j, hi = i < j ? j : i;
      const key = lo * nV + hi;
      let arr = edgeFaces.get(key);
      if (!arr) { arr = []; edgeFaces.set(key, arr); }
      arr.push(f);
      const dk = i * nV + j;
      dirCount.set(dk, (dirCount.get(dk) || 0) + 1);
    }
  }

  const adj = Array.from({ length: T }, () => []);
  let manifold = true;
  for (const faces of edgeFaces.values()) {
    if (faces.length !== 2) { manifold = false; continue; }
    const [f, g] = faces;
    const d = Math.acos(Math.max(-1, Math.min(1,
      N[3 * f] * N[3 * g] + N[3 * f + 1] * N[3 * g + 1] + N[3 * f + 2] * N[3 * g + 2]))) * 180 / Math.PI;
    adj[f].push([g, d]);
    adj[g].push([f, d]);
  }
  // jede Kante genau einmal in jeder Richtung benutzt
  if (manifold) {
    for (const [key, faces] of edgeFaces) {
      if (faces.length !== 2) { manifold = false; break; }
      const lo = Math.floor(key / nV), hi = key - lo * nV;
      if ((dirCount.get(lo * nV + hi) || 0) !== 1 || (dirCount.get(hi * nV + lo) || 0) !== 1) {
        manifold = false; break;
      }
    }
  }

  // Zusammenhang über Kanten
  let components = 0;
  const seen = new Uint8Array(T);
  const stack = [];
  for (let s = 0; s < T; s++) {
    if (seen[s]) continue;
    components++;
    seen[s] = 1; stack.push(s);
    while (stack.length) {
      const f = stack.pop();
      for (const [g] of adj[f]) if (!seen[g]) { seen[g] = 1; stack.push(g); }
    }
  }

  if (!manifold || components !== 1) return null;
  return { P, tri, nV, T, N, A, adj, edgeFaces, manifold, components };
}

// ── Schritt 2: Modell-Fits ───────────────────────────────────────────────────
// Jedes Modell liefert dist(x,y,z) (Abstand zur Fläche) und normal(x,y,z,out)
// (Einheitsnormale an der Stelle; das Vorzeichen ist unerheblich, der Vergleich
//  benutzt |cos|).

// Eckpunkte einer Dreiecksmenge (eindeutig)
function regionVerts(mesh, tris) {
  const { tri } = mesh;
  const set = new Set();
  for (const f of tris) for (let k = 0; k < 3; k++) set.add(tri[3 * f + k]);
  return set;
}

// gemittelte Vertex-Normalen (Fläche gewichtet), je Netz einmal berechnet
const vnormCache = new WeakMap();
function vertexNormals(mesh) {
  let vn = vnormCache.get(mesh);
  if (vn) return vn;
  const { P, tri, N, A, nV } = mesh;
  vn = new Float64Array(3 * nV);
  for (let f = 0; f < mesh.T; f++) {
    const w = A[f];
    for (let k = 0; k < 3; k++) {
      const i = tri[3 * f + k];
      vn[3 * i] += N[3 * f] * w; vn[3 * i + 1] += N[3 * f + 1] * w; vn[3 * i + 2] += N[3 * f + 2] * w;
    }
  }
  for (let i = 0; i < nV; i++) {
    const l = Math.hypot(vn[3 * i], vn[3 * i + 1], vn[3 * i + 2]);
    if (l > 0) { vn[3 * i] /= l; vn[3 * i + 1] /= l; vn[3 * i + 2] /= l; }
  }
  vnormCache.set(mesh, vn);
  return vn;
}

// Ebene: kleinster Eigenvektor der Vertex-Streuung
function fitPlaneModel(mesh, tris) {
  const { P, N, A } = mesh;
  const idx = regionVerts(mesh, tris);
  const n = idx.size;
  if (n < 3) return null;
  let cx = 0, cy = 0, cz = 0;
  for (const i of idx) { cx += P[3 * i]; cy += P[3 * i + 1]; cz += P[3 * i + 2]; }
  cx /= n; cy /= n; cz /= n;
  const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const i of idx) {
    const dx = P[3 * i] - cx, dy = P[3 * i + 1] - cy, dz = P[3 * i + 2] - cz;
    C[0][0] += dx * dx; C[0][1] += dx * dy; C[0][2] += dx * dz;
    C[1][0] += dy * dx; C[1][1] += dy * dy; C[1][2] += dy * dz;
    C[2][0] += dz * dx; C[2][1] += dz * dy; C[2][2] += dz * dz;
  }
  const e = eig3(C);
  let nx = e.vectors[0][0], ny = e.vectors[0][1], nz = e.vectors[0][2];
  // nach außen orientieren (mittlere Dreiecksnormale der Region)
  let mx = 0, my = 0, mz = 0, area = 0;
  for (const f of tris) { const w = A[f]; area += w; mx += N[3 * f] * w; my += N[3 * f + 1] * w; mz += N[3 * f + 2] * w; }
  if (area > 0) { mx /= area; my /= area; mz /= area; }
  if (nx * mx + ny * my + nz * mz < 0) { nx = -nx; ny = -ny; nz = -nz; }
  const surf = { type: 'plane', o: [cx, cy, cz], n: [nx, ny, nz] };
  return {
    type: 'plane', surf,
    dist: (x, y, z) => Math.abs((x - cx) * nx + (y - cy) * ny + (z - cz) * nz),
    normal: (x, y, z, out) => { out[0] = nx; out[1] = ny; out[2] = nz; return out; },
  };
}

// Zylinder: Achse aus der flächengewichteten Normalen-Kovarianz, Radius per
// Kreisfit in der Achsenebene
function fitCylModel(mesh, tris) {
  const { P, N, A } = mesh;
  let area = 0, mx = 0, my = 0, mz = 0;
  for (const f of tris) { const w = A[f]; area += w; mx += N[3 * f] * w; my += N[3 * f + 1] * w; mz += N[3 * f + 2] * w; }
  if (area <= 0) return null;
  // Achse: kleinster Eigenvektor der UNGEZENTRIERTEN Normalen-Kovarianz. Alle
  // Normalen einer Zylinderfläche stehen senkrecht auf der Achse → der Nullraum
  // der Kovarianz ist die Achse. Ungezentriert ist das auch bei schmalen
  // Flecken (zwei Streifen einer Verrundung) eindeutig; zentriert ist die
  // Kovarianz dort in der Normalenebene vom Rang 1 — der kleinste Eigenvektor
  // wäre dann beliebig und die Achse falsch.
  const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const f of tris) {
    const w = A[f];
    const dx = N[3 * f], dy = N[3 * f + 1], dz = N[3 * f + 2];
    C[0][0] += dx * dx * w; C[0][1] += dx * dy * w; C[0][2] += dx * dz * w;
    C[1][0] += dy * dx * w; C[1][1] += dy * dy * w; C[1][2] += dy * dz * w;
    C[2][0] += dz * dx * w; C[2][1] += dz * dy * w; C[2][2] += dz * dz * w;
  }
  const e = eig3(C);
  const ax = e.vectors[0];
  const [u, v] = basis(ax);
  const idx = regionVerts(mesh, tris);
  const Mx = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], b = [0, 0, 0];
  for (const i of idx) {
    const x = P[3 * i] * u[0] + P[3 * i + 1] * u[1] + P[3 * i + 2] * u[2];
    const y = P[3 * i] * v[0] + P[3 * i + 1] * v[1] + P[3 * i + 2] * v[2];
    const rr = [2 * x, 2 * y, 1];
    const yy = x * x + y * y;
    for (let i2 = 0; i2 < 3; i2++) { b[i2] += rr[i2] * yy; for (let j = 0; j < 3; j++) Mx[i2][j] += rr[i2] * rr[j]; }
  }
  const s = solveN(Mx, b);
  if (!s) return null;
  const R = Math.sqrt(s[2] + s[0] * s[0] + s[1] * s[1]);
  if (!(R > 0.05 && R < 2000)) return null;
  const ox = u[0] * s[0] + v[0] * s[1];
  const oy = u[1] * s[0] + v[1] * s[1];
  const oz = u[2] * s[0] + v[2] * s[1];
  const axc = canonicalAxis(ax);
  const [iax, iay, iaz] = axc;
  const surf = { type: 'cylinder', o: [ox, oy, oz], a: axc, R };
  return {
    type: 'cylinder', surf,
    dist: (x, y, z) => {
      const wx = x - ox, wy = y - oy, wz = z - oz;
      const h = wx * iax + wy * iay + wz * iaz;
      const rx = wx - iax * h, ry = wy - iay * h, rz = wz - iaz * h;
      return Math.abs(Math.hypot(rx, ry, rz) - R);
    },
    normal: (x, y, z, out) => {
      const wx = x - ox, wy = y - oy, wz = z - oz;
      const h = wx * iax + wy * iay + wz * iaz;
      let rx = wx - iax * h, ry = wy - iay * h, rz = wz - iaz * h;
      const l = Math.hypot(rx, ry, rz) || 1;
      out[0] = rx / l; out[1] = ry / l; out[2] = rz / l; return out;
    },
  };
}

// Kegel: Achse aus der zentrierten Normalen-Kovarianz, Apex aus n·x = n·q,
// Halbwinkel aus den Eckpunkten
function fitConeModel(mesh, tris) {
  const { P, N, A, tri } = mesh;
  let area = 0, mx = 0, my = 0, mz = 0;
  for (const f of tris) { const w = A[f]; area += w; mx += N[3 * f] * w; my += N[3 * f + 1] * w; mz += N[3 * f + 2] * w; }
  if (area <= 0) return null;
  mx /= area; my /= area; mz /= area;
  const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const f of tris) {
    const w = A[f];
    const dx = N[3 * f] - mx, dy = N[3 * f + 1] - my, dz = N[3 * f + 2] - mz;
    C[0][0] += dx * dx * w; C[0][1] += dx * dy * w; C[0][2] += dx * dz * w;
    C[1][0] += dy * dx * w; C[1][1] += dy * dy * w; C[1][2] += dy * dz * w;
    C[2][0] += dz * dx * w; C[2][1] += dz * dy * w; C[2][2] += dz * dz * w;
  }
  const e = eig3(C);
  let ax = e.vectors[0];
  const sa = mx * ax[0] + my * ax[1] + mz * ax[2];
  if (!(Math.abs(sa) > 0.01 && Math.abs(sa) < 0.995)) return null; // ~Zylinder / ~Ebene
  // Apex: n·x = n·q (Apex liegt in der Tangentialebene je Fläche)
  const Mx = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], b = [0, 0, 0];
  for (const f of tris) {
    const w = A[f];
    const i0 = tri[3 * f], i1 = tri[3 * f + 1], i2 = tri[3 * f + 2];
    const qx = (P[3 * i0] + P[3 * i1] + P[3 * i2]) / 3;
    const qy = (P[3 * i0 + 1] + P[3 * i1 + 1] + P[3 * i2 + 1]) / 3;
    const qz = (P[3 * i0 + 2] + P[3 * i1 + 2] + P[3 * i2 + 2]) / 3;
    const nv = [N[3 * f], N[3 * f + 1], N[3 * f + 2]];
    const y = nv[0] * qx + nv[1] * qy + nv[2] * qz;
    for (let i = 0; i < 3; i++) {
      b[i] += nv[i] * y * w;
      for (let j = 0; j < 3; j++) Mx[i][j] += nv[i] * nv[j] * w;
    }
  }
  const apex = solveN(Mx, b);
  if (!apex) return null;
  // Halbwinkel aus den Eckpunkten (Achse in +a öffnend)
  const idx = regionVerts(mesh, tris);
  let sx = 0, cnt = 0;
  for (const i of idx) {
    const wx = P[3 * i] - apex[0], wy = P[3 * i + 1] - apex[1], wz = P[3 * i + 2] - apex[2];
    const l = Math.hypot(wx, wy, wz);
    if (l < 1e-6) continue;
    sx += (wx * ax[0] + wy * ax[1] + wz * ax[2]) / l;
    cnt++;
  }
  if (!cnt) return null;
  const ca = sx / cnt;
  if (ca < 0) ax = [-ax[0], -ax[1], -ax[2]];
  const alpha = Math.acos(Math.min(1, Math.abs(ca)));
  if (!(alpha > 0.3 * Math.PI / 180 && alpha < 89 * Math.PI / 180)) return null;
  const sinA = Math.sin(alpha), cosA = Math.cos(alpha);
  const axx = ax[0], axy = ax[1], axz = ax[2];
  const apx = apex[0], apy = apex[1], apz = apex[2];
  const surf = { type: 'cone', apex: [apx, apy, apz], a: canonicalAxis(ax), alpha };
  return {
    type: 'cone', surf,
    dist: (x, y, z) => {
      const wx = x - apx, wy = y - apy, wz = z - apz;
      const h = wx * axx + wy * axy + wz * axz;
      const rx = wx - axx * h, ry = wy - axy * h, rz = wz - axz * h;
      const r = Math.hypot(rx, ry, rz);
      return Math.abs(r * cosA - h * sinA);
    },
    normal: (x, y, z, out) => {
      const wx = x - apx, wy = y - apy, wz = z - apz;
      const h = wx * axx + wy * axy + wz * axz;
      let rx = wx - axx * h, ry = wy - axy * h, rz = wz - axz * h;
      const l = Math.hypot(rx, ry, rz) || 1;
      rx /= l; ry /= l; rz /= l;
      out[0] = rx * cosA - axx * sinA;
      out[1] = ry * cosA - axy * sinA;
      out[2] = rz * cosA - axz * sinA;
      return out;
    },
  };
}

// Kugel: algebraischer Kugelfit über die Eckpunkte
function fitSphModel(mesh, tris) {
  const { P } = mesh;
  const idx = regionVerts(mesh, tris);
  if (idx.size < 4) return null;
  const M = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], b = [0, 0, 0, 0];
  for (const i of idx) {
    const x = P[3 * i], y = P[3 * i + 1], z = P[3 * i + 2];
    const r = [2 * x, 2 * y, 2 * z, 1];
    const yy = x * x + y * y + z * z;
    for (let i2 = 0; i2 < 4; i2++) { b[i2] += r[i2] * yy; for (let j = 0; j < 4; j++) M[i2][j] += r[i2] * r[j]; }
  }
  const s = solveN(M, b);
  if (!s) return null;
  const cx = s[0], cy = s[1], cz = s[2];
  const R = Math.sqrt(s[3] + cx * cx + cy * cy + cz * cz);
  if (!(R > 0.05 && R < 2000)) return null;
  const surf = { type: 'sphere', c: [cx, cy, cz], R };
  return {
    type: 'sphere', surf,
    dist: (x, y, z) => Math.abs(Math.hypot(x - cx, y - cy, z - cz) - R),
    normal: (x, y, z, out) => {
      let rx = x - cx, ry = y - cy, rz = z - cz;
      const l = Math.hypot(rx, ry, rz) || 1;
      out[0] = rx / l; out[1] = ry / l; out[2] = rz / l; return out;
    },
  };
}

// Torus (grob): Rohr-Mittelpunkte q = p − r·n liegen auf einem Kreis; 1D-Suche
// über r, Achse/Mitte/Rm aus dem Kreisfit.
function torusEvalR(pts, nrms, r) {
  const n = pts.length / 3;
  if (n < 4) return null;
  let cx = 0, cy = 0, cz = 0;
  const Q = new Float64Array(3 * n);
  for (let i = 0; i < n; i++) {
    const qx = pts[3 * i] - r * nrms[3 * i];
    const qy = pts[3 * i + 1] - r * nrms[3 * i + 1];
    const qz = pts[3 * i + 2] - r * nrms[3 * i + 2];
    Q[3 * i] = qx; Q[3 * i + 1] = qy; Q[3 * i + 2] = qz;
    cx += qx; cy += qy; cz += qz;
  }
  cx /= n; cy /= n; cz /= n;
  const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < n; i++) {
    const dx = Q[3 * i] - cx, dy = Q[3 * i + 1] - cy, dz = Q[3 * i + 2] - cz;
    C[0][0] += dx * dx; C[0][1] += dx * dy; C[0][2] += dx * dz;
    C[1][0] += dy * dx; C[1][1] += dy * dy; C[1][2] += dy * dz;
    C[2][0] += dz * dx; C[2][1] += dz * dy; C[2][2] += dz * dz;
  }
  const e = eig3(C);
  const ax = e.vectors[0];
  const [u, v] = basis(ax);
  const Mx = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], b = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const dx = Q[3 * i] - cx, dy = Q[3 * i + 1] - cy, dz = Q[3 * i + 2] - cz;
    const x = dx * u[0] + dy * u[1] + dz * u[2];
    const y = dx * v[0] + dy * v[1] + dz * v[2];
    const rr = [2 * x, 2 * y, 1];
    const yy = x * x + y * y;
    for (let i2 = 0; i2 < 3; i2++) { b[i2] += rr[i2] * yy; for (let j = 0; j < 3; j++) Mx[i2][j] += rr[i2] * rr[j]; }
  }
  const s = solveN(Mx, b);
  if (!s) return null;
  const Rm = Math.sqrt(s[2] + s[0] * s[0] + s[1] * s[1]);
  const ccx = cx + u[0] * s[0] + v[0] * s[1];
  const ccy = cy + u[1] * s[0] + v[1] * s[1];
  const ccz = cz + u[2] * s[0] + v[2] * s[1];
  let err = 0;
  for (let i = 0; i < n; i++) {
    const dx = Q[3 * i] - ccx, dy = Q[3 * i + 1] - ccy, dz = Q[3 * i + 2] - ccz;
    const h = dx * ax[0] + dy * ax[1] + dz * ax[2];
    const rx = dx - ax[0] * h, ry = dy - ax[1] * h, rz = dz - ax[2] * h;
    const rr = Math.hypot(rx, ry, rz);
    err += h * h + (rr - Rm) * (rr - Rm);
  }
  return { err: err / n, ax, c: [ccx, ccy, ccz], Rm, r };
}

function torusPoints(mesh, tris) {
  const { P } = mesh;
  const vn = vertexNormals(mesh);
  const idx = regionVerts(mesh, tris);
  const n = idx.size;
  const pts = new Float64Array(3 * n);
  const nrms = new Float64Array(3 * n);
  let k = 0;
  for (const i of idx) {
    pts[3 * k] = P[3 * i]; pts[3 * k + 1] = P[3 * i + 1]; pts[3 * k + 2] = P[3 * i + 2];
    nrms[3 * k] = vn[3 * i]; nrms[3 * k + 1] = vn[3 * i + 1]; nrms[3 * k + 2] = vn[3 * i + 2];
    k++;
  }
  return { pts, nrms, n };
}

// grobe Torus-Schätzung (Achse, Mitte, Rm, r)
function fitTorusRough(pts, nrms) {
  const n = pts.length / 3;
  if (n < 6) return null;
  const cand = [0.3, 0.5, 0.8, 1, 1.5, 2, 3, 4, 5, 7, 10, 15, 20, 30,
    -0.3, -0.5, -0.8, -1, -1.5, -2, -3, -4, -5, -7, -10, -15, -20, -30];
  let best = null;
  for (const r of cand) {
    const e = torusEvalR(pts, nrms, r);
    if (e && (!best || e.err < best.err)) best = e;
  }
  if (!best) return null;
  // Goldener Schnitt um das beste r
  let lo = best.r * 0.7, hi = best.r * 1.3;
  if (lo > hi) { const t = lo; lo = hi; hi = t; }
  for (let it = 0; it < 30; it++) {
    const m1 = lo + (hi - lo) * 0.382, m2 = lo + (hi - lo) * 0.618;
    const e1 = torusEvalR(pts, nrms, m1), e2 = torusEvalR(pts, nrms, m2);
    if (!e1 || !e2) break;
    if (e1.err < e2.err) hi = m2; else lo = m1;
  }
  const e = torusEvalR(pts, nrms, (lo + hi) / 2);
  if (!e) return null;
  const r = Math.abs(e.r);
  if (!(r > 0.05 && r < 500 && e.Rm > 0.01 && e.Rm < 2000)) return null;
  return { c: e.c, a: e.ax, Rm: e.Rm, r };
}

// ── Torus-Verfeinerung (Levenberg-Marquardt auf dem exakten Abstand) ───────
// Parameter: c(3), a(3, wird normiert), Rm, r
function torusResidual(p, pts, n, out) {
  let cx = p[0], cy = p[1], cz = p[2];
  let ax = p[3], ay = p[4], az = p[5];
  const al = Math.hypot(ax, ay, az) || 1;
  ax /= al; ay /= al; az /= al;
  const Rm = p[6], r = p[7];
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const wx = pts[3 * i] - cx, wy = pts[3 * i + 1] - cy, wz = pts[3 * i + 2] - cz;
    const h = wx * ax + wy * ay + wz * az;
    const rx = wx - ax * h, ry = wy - ay * h, rz = wz - az * h;
    const rr = Math.hypot(rx, ry, rz);
    const f = Math.hypot(rr - Rm, h) - r;
    out[i] = f;
    sum += f * f;
  }
  return sum;
}

// LM-Verfeinerung auf einer Teilmenge der Punkte (deterministisch gewählt)
function refineTorusParams(pts, n, init, maxIter = 60) {
  if (n < 8) return null;
  const p = new Float64Array([init.c[0], init.c[1], init.c[2], init.a[0], init.a[1], init.a[2], init.Rm, init.r]);
  const f = new Float64Array(n);
  let cost = torusResidual(p, pts, n, f);
  let lambda = 1e-3;
  const NP = 8;
  for (let iter = 0; iter < maxIter; iter++) {
    if (cost < 1e-24) break;
    // Jacobi-Matrix (zentrale Differenzen)
    const J = [];
    for (let k = 0; k < NP; k++) {
      const eps = 1e-6 * Math.max(1, Math.abs(p[k]));
      const q = Float64Array.from(p), qm = Float64Array.from(p);
      q[k] += eps; qm[k] -= eps;
      const fq = new Float64Array(n), fm = new Float64Array(n);
      torusResidual(q, pts, n, fq);
      torusResidual(qm, pts, n, fm);
      const col = new Float64Array(n);
      for (let i = 0; i < n; i++) col[i] = (fq[i] - fm[i]) / (2 * eps);
      J.push(col);
    }
    // Normalgleichungen JᵀJ + λI, Jᵀf
    const A = [], g = new Float64Array(NP);
    for (let k = 0; k < NP; k++) {
      const row = new Float64Array(NP);
      for (let j = 0; j < NP; j++) {
        let s = 0;
        for (let i = 0; i < n; i++) s += J[k][i] * J[j][i];
        row[j] = s;
      }
      A.push(row);
      let s = 0;
      for (let i = 0; i < n; i++) s += J[k][i] * f[i];
      g[k] = s;
    }
    let tr = 0;
    for (let k = 0; k < NP; k++) tr += A[k][k];
    const lam0 = lambda * (tr / NP || 1);
    for (let k = 0; k < NP; k++) A[k][k] += lam0;
    const rhs = new Float64Array(NP);
    for (let k = 0; k < NP; k++) rhs[k] = -g[k];
    const delta = solveN(A, rhs);
    if (!delta) break;
    const pn = new Float64Array(NP);
    for (let k = 0; k < NP; k++) pn[k] = p[k] + delta[k];
    const fn = new Float64Array(n);
    const cn = torusResidual(pn, pts, n, fn);
    if (cn < cost) {
      const rel = (cost - cn) / (cost || 1);
      p.set(pn); f.set(fn); cost = cn; lambda = Math.max(1e-9, lambda * 0.3);
      if (rel < 1e-12) break;
    } else {
      lambda *= 8;
      if (lambda > 1e12) break;
    }
  }
  let ax = p[3], ay = p[4], az = p[5];
  const al = Math.hypot(ax, ay, az) || 1;
  ax /= al; ay /= al; az /= al;
  return { c: [p[0], p[1], p[2]], a: [ax, ay, az], Rm: p[6], r: p[7], cost };
}

// Torus-Modell: grobe Schätzung → LM-Verfeinerung auf den Punkten
function fitTorusModel(mesh, tris, tol = 0.02) {
  const { pts, nrms, n } = torusPoints(mesh, tris);
  const rough = fitTorusRough(pts, nrms);
  if (!rough) return null;
  if (!(rough.r > 0.05 && rough.r < 500 && rough.Rm > rough.r && rough.Rm < 2000)) return null;
  // grobe Schätzung weit von den Punkten weg → kein Torus (spart die Verfeinerung)
  const reject = Math.max(0.25, 12 * tol);
  let maxd = 0;
  for (let i = 0; i < n; i++) {
    const d = torusDist(rough, pts[3 * i], pts[3 * i + 1], pts[3 * i + 2]);
    if (d > maxd) maxd = d;
  }
  if (maxd > reject) return null;
  // Teilmenge für die Verfeinerung (max. 400 Punkte, gleichmäßig)
  const step = Math.max(1, Math.ceil(n / 400));
  const m = Math.ceil(n / step);
  const sub = new Float64Array(3 * m);
  let k = 0;
  for (let i = 0; i < n; i += step) { sub[3 * k] = pts[3 * i]; sub[3 * k + 1] = pts[3 * i + 1]; sub[3 * k + 2] = pts[3 * i + 2]; k++; }
  const ref = refineTorusParams(sub, m, rough);
  let use = rough;
  if (ref && isFinite(ref.cost) && ref.cost <= torusResidualCost(rough, sub, m)
    && ref.r > 0.05 && ref.r < 500 && ref.Rm > ref.r && ref.Rm < 2000) use = ref;
  if (!(use.r > 0.05 && use.r < 500 && use.Rm > 0.01 && use.Rm < 2000)) return null;
  if (!(use.Rm > use.r)) return null;
  const cx = use.c[0], cy = use.c[1], cz = use.c[2];
  const axc = canonicalAxis(use.a);
  const [iax, iay, iaz] = axc;
  const Rm = use.Rm, r = use.r;
  const surf = { type: 'torus', c: [cx, cy, cz], a: axc, Rm, r };
  return {
    type: 'torus', surf,
    dist: (x, y, z) => {
      const wx = x - cx, wy = y - cy, wz = z - cz;
      const h = wx * iax + wy * iay + wz * iaz;
      const rx = wx - iax * h, ry = wy - iay * h, rz = wz - iaz * h;
      return Math.abs(Math.hypot(Math.hypot(rx, ry, rz) - Rm, h) - r);
    },
    normal: (x, y, z, out) => {
      const wx = x - cx, wy = y - cy, wz = z - cz;
      const h = wx * iax + wy * iay + wz * iaz;
      let rx = wx - iax * h, ry = wy - iay * h, rz = wz - iaz * h;
      const l = Math.hypot(rx, ry, rz) || 1;
      rx /= l; ry /= l; rz /= l;
      const qx = cx + rx * Rm, qy = cy + ry * Rm, qz = cz + rz * Rm;
      let ux = x - qx, uy = y - qy, uz = z - qz;
      const ul = Math.hypot(ux, uy, uz) || 1;
      out[0] = ux / ul; out[1] = uy / ul; out[2] = uz / ul; return out;
    },
  };
}

function torusResidualCost(params, pts, n) {
  const p = new Float64Array([params.c[0], params.c[1], params.c[2], params.a[0], params.a[1], params.a[2], params.Rm, params.r]);
  return torusResidual(p, pts, n, new Float64Array(n));
}

// Abstand eines Punktes zum Torus (Parameterform)
function torusDist(t, x, y, z) {
  const al = Math.hypot(t.a[0], t.a[1], t.a[2]) || 1;
  const ax = t.a[0] / al, ay = t.a[1] / al, az = t.a[2] / al;
  const wx = x - t.c[0], wy = y - t.c[1], wz = z - t.c[2];
  const h = wx * ax + wy * ay + wz * az;
  const rx = wx - ax * h, ry = wy - ay * h, rz = wz - az * h;
  return Math.abs(Math.hypot(Math.hypot(rx, ry, rz) - t.Rm, h) - t.r);
}

// Modell-Fit je Typ
function fitModelInternal(mesh, tris, type, tol = 0.02) {
  switch (type) {
    case 'plane': return fitPlaneModel(mesh, tris);
    case 'cylinder': return fitCylModel(mesh, tris);
    case 'cone': return fitConeModel(mesh, tris);
    case 'sphere': return fitSphModel(mesh, tris);
    case 'torus': return fitTorusModel(mesh, tris, tol);
    default: return null;
  }
}

// Modell-Fit (kanonische Fläche) für Tests
export function fitModel(mesh, tris, type) {
  const m = fitModelInternal(mesh, tris, type);
  return m ? m.surf : null;
}

// ── Schritt 2: Segmentierung ─────────────────────────────────────────────────
const TYPES = ['plane', 'cylinder', 'cone', 'sphere', 'torus'];
const RANK = { plane: 0, cylinder: 1, cone: 2, sphere: 3, torus: 4 };

// Vergleich zweier Modell-Kandidaten: Fläche zuerst, dann Restfehler, dann Rang.
// Eine gekrümmte Fläche schlägt eine Ebene, wenn sie mindestens 80 % der Fläche
// hat UND der Restfehler (RMS der Eckpunkte) ein Viertel des Ebenen-Rests ist
// (Ebene auf gekrümmtem Fleck: Rest ≈ Sehnenfehler; gekrümmtes Modell: Rest ≈ 0).
// Zwischen gekrümmten Typen gewinnt der einfachere Typ (RANG) nur, wenn sein
// Restfehler nicht mehr als 4x schlechter ist.
function betterCand(a, b) {
  if (!b) return true;
  const aC = a.type !== 'plane', bC = b.type !== 'plane';
  if (aC !== bC) {
    const cur = aC ? a : b;
    const flat = aC ? b : a;
    if (cur.area >= 0.8 * flat.area && cur.rms < 0.25 * flat.rms) return aC;
    if (cur.area > flat.area * 1.05) return aC;
    if (flat.area > cur.area * 1.05) return !aC;
    return !aC; // Gleichstand: die einfachere (Ebene) gewinnt
  }
  if (a.type !== b.type) {
    const lo = RANK[a.type] < RANK[b.type] ? a : b;
    const hi = lo === a ? b : a;
    if (lo.area > hi.area * 1.05) return lo === a;
    if (hi.area > lo.area * 1.05) return hi === a;
    // gleiche Fläche: der einfachere Typ gewinnt nur, wenn sein Rest nicht
    // mehr als 4x schlechter ist
    if (lo.rms > 4 * hi.rms + 1e-7) return hi === a;
    return lo === a;
  }
  if (a.area > b.area * 1.05) return true;
  if (a.area < b.area * 0.95) return false;
  return a.rms < b.rms;
}

// Saat-Reihenfolge: Fläche absteigend; Flächen innerhalb relativer Toleranz
// (1e-6 — größer als das Float-Rauschen einer starren Drehung) gelten als
// gleich. Innerhalb einer solchen Gruppe entscheidet der drehungsunabhängige
// Sekundärschlüssel "Anzahl Nachbarn mit Dihedral < 1°" (AUFSTEIGEND: Saaten
// ohne tangentiale Nachbarn zuerst — deren Modell-Fit ist nicht verfälscht),
// danach der Index. Damit ist die Reihenfolge für ein starre gedrehtes Netz
// dieselbe.
function seedOrder(mesh) {
  const { A, adj, T } = mesh;
  const key = new Int32Array(T);
  for (let f = 0; f < T; f++) {
    let c = 0;
    for (const [, d] of adj[f]) if (d < 1) c++;
    key[f] = c;
  }
  const byArea = Array.from({ length: T }, (_, i) => i).sort((a, b) => A[b] - A[a]);
  const groups = [];
  let cur = null;
  for (const i of byArea) {
    if (cur && Math.abs(A[cur[0]] - A[i]) <= 1e-6 * Math.max(A[cur[0]], A[i])) cur.push(i);
    else { cur = [i]; groups.push(cur); }
  }
  const order = [];
  for (const g of groups) {
    g.sort((a, b) => (key[a] - key[b]) || (a - b));
    for (const i of g) order.push(i);
  }
  return order;
}

// ── Nachbearbeitung: Wettbewerb, Verschmelzung, Schluss-Fit ─────────────────
// Wettbewerb: ein Dreieck an der Grenze zweier Regionen wechselt zu der
// Region, deren Modell es besser trifft (kleinere maximale Vertexabweichung).
// Verschmelzung: benachbarte Regionen gleichen Typs mit übereinstimmender
// Fläche werden zu einer Region (neu gefittet).

// maximale Vertexabweichung eines Dreiecks vom Modell
function triDev(mesh, m, f) {
  const { P, tri } = mesh;
  let d = 0;
  for (let k = 0; k < 3; k++) {
    const i = tri[3 * f + k];
    const dd = m.dist(P[3 * i], P[3 * i + 1], P[3 * i + 2]);
    if (dd > d) d = dd;
  }
  return d;
}

// Komponenten einer Dreiecksmenge (Zusammenhang über gemeinsame Kanten)
function edgeComps(mesh, tris) {
  const inSet = new Set(tris);
  const seen = new Set();
  const comps = [];
  for (const s of tris) {
    if (seen.has(s)) continue;
    seen.add(s);
    const comp = [s];
    const stack = [s];
    while (stack.length) {
      const f = stack.pop();
      for (const [g] of mesh.adj[f]) {
        if (inSet.has(g) && !seen.has(g)) { seen.add(g); comp.push(g); stack.push(g); }
      }
    }
    comps.push(comp);
  }
  return comps;
}

// Winkel zweier Richtungen (parallel auch bei Gegenrichtung)
const angAxes = (a, b) => {
  const d = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2]);
  return Math.acos(Math.min(1, d));
};
const pdist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// Abstand eines Punktes von einer Ebene
const planeDist = (s, p) =>
  Math.abs((p[0] - s.o[0]) * s.n[0] + (p[1] - s.o[1]) * s.n[1] + (p[2] - s.o[2]) * s.n[2]);

// Abstand zweier paralleler Achsen (Punkte auf den Achsen + Richtung)
function axisGap(p1, a1, p2, a2) {
  const dx = p2[0] - p1[0], dy = p2[1] - p1[1], dz = p2[2] - p1[2];
  const h = dx * a2[0] + dy * a2[1] + dz * a2[2];
  return Math.hypot(dx - a2[0] * h, dy - a2[1] * h, dz - a2[2] * h);
}

// Flächenschwerpunkt einer Region (Dreiecksschwerpunkte, flächengewichtet)
function regionCentroid(mesh, tris) {
  const { P, tri, A } = mesh;
  let cx = 0, cy = 0, cz = 0, w = 0;
  for (const f of tris) {
    const i0 = tri[3 * f], i1 = tri[3 * f + 1], i2 = tri[3 * f + 2];
    const a = A[f];
    cx += a * (P[3 * i0] + P[3 * i1] + P[3 * i2]) / 3;
    cy += a * (P[3 * i0 + 1] + P[3 * i1 + 1] + P[3 * i2 + 1]) / 3;
    cz += a * (P[3 * i0 + 2] + P[3 * i1 + 2] + P[3 * i2 + 2]) / 3;
    w += a;
  }
  if (!(w > 0)) return null;
  return [cx / w, cy / w, cz / w];
}

// Passen zwei Regionen gleichen Typs geometrisch zusammen?
function canMerge(a, b, tol, ca, cb) {
  if (a.type !== b.type) return false;
  const sa = a.model && a.model.surf, sb = b.model && b.model.surf;
  if (!sa || !sb) return false;
  switch (a.type) {
    case 'plane': {
      if (angAxes(sa.n, sb.n) > 0.5 * Math.PI / 180) return false;
      if (!ca || !cb) return false;
      return planeDist(sb, ca) < tol && planeDist(sa, cb) < tol;
    }
    case 'cylinder':
      return angAxes(sa.a, sb.a) <= 0.5 * Math.PI / 180
        && axisGap(sa.o, sa.a, sb.o, sb.a) < tol
        && Math.abs(sa.R - sb.R) < tol;
    case 'sphere':
      return pdist(sa.c, sb.c) < tol && Math.abs(sa.R - sb.R) < tol;
    case 'torus':
      return angAxes(sa.a, sb.a) <= 0.5 * Math.PI / 180
        && pdist(sa.c, sb.c) < tol
        && Math.abs(sa.Rm - sb.Rm) < tol && Math.abs(sa.r - sb.r) < tol;
    case 'cone':
      return angAxes(sa.a, sb.a) <= 0.5 * Math.PI / 180
        && pdist(sa.apex, sb.apex) < tol
        && Math.abs(sa.alpha - sb.alpha) < 0.5 * Math.PI / 180;
    default: return false;
  }
}

// Nachbearbeitung der Segmentierung → { regions, label }
function refineRegions(mesh, regions, models, opts) {
  const { tol, okTri, fit } = opts;
  const { adj, A, T } = mesh;
  const recs = [];
  const owner = new Int32Array(T).fill(-1);
  for (let i = 0; i < regions.length; i++) {
    const rec = { type: regions[i].type, model: models[i], tris: regions[i].tris.slice(), dead: false };
    recs.push(rec);
    for (const f of rec.tris) owner[f] = i;
  }

  // ── Nachbearbeitung: Wettbewerb und Verschmelzung, bis nichts mehr wechselt
  // Wettbewerb: ein Dreieck an der Grenze zweier Regionen wechselt zu der
  // Region, deren Modell es besser trifft (kleinere maximale Vertexabweichung).
  // Eine Region aus nur EINEM Dreieck trägt ihr Modell nicht (eine Ebene passt
  // drei Punkte immer, ein Zylinder durch drei Punkte ist beliebig) — ihr
  // Dreieck wandert daher zur Nachbarregion, die es annimmt.
  // Verschmelzung: benachbarte Regionen gleichen Typs mit übereinstimmender
  // Fläche werden zu einer Region (neu gefittet).
  const eps = 0.01 * tol;          // Gleichheit der Abweichungen (Rauschen)
  for (let round = 0; round < 4; round++) {
    let changed = false;

    // ── 1. Wettbewerb: bis zu 3 Runden ──────────────────────────────────────
    for (let sweep = 0; sweep < 3; sweep++) {
      const moves = [];
      for (let ri = 0; ri < recs.length; ri++) {
        const r = recs[ri];
        if (r.dead || !r.model || !r.tris.length) continue;
        const held = r.tris.length > 1;
        for (const f of r.tris) {
          const own = held ? triDev(mesh, r.model, f) : Infinity;
          let to = -1, best = Infinity, bestN = -1;
          for (const [g] of adj[f]) {
            const gi = owner[g];
            if (gi < 0 || gi === ri) continue;
            const s = recs[gi];
            if (s.dead || !s.model || !s.tris.length) continue;
            if (!okTri(s.model, f)) continue;
            const d = triDev(mesh, s.model, f);
            // bei gleicher Abweichung gewinnt die Region mit mehr Dreiecken:
            // ihr Modell ist besser belegt
            if (d < best - eps || (Math.abs(d - best) <= eps && s.tris.length > bestN)) {
              best = d; bestN = s.tris.length; to = gi;
            }
          }
          if (to < 0) continue;
          if (!okTri(r.model, f)) { moves.push(f, to); continue; }   // passt nicht mehr
          if (best < own - eps) { moves.push(f, to); continue; }    // bessere Fläche
          if (best <= own + eps && bestN > r.tris.length) moves.push(f, to);
        }
      }
      if (!moves.length) break;
      changed = true;
      // Bewegungen anwenden
      const touched = new Set();
      for (let k = 0; k < moves.length; k += 2) {
        const f = moves[k], to = moves[k + 1];
        const from = owner[f];
        if (from < 0 || from === to) continue;
        const fr = recs[from];
        const i = fr.tris.indexOf(f);
        if (i >= 0) fr.tris.splice(i, 1);
        recs[to].tris.push(f);
        owner[f] = to;
        touched.add(from); touched.add(to);
      }
      // leere Regionen ausscheiden (ihr Modell wäre ohne Dreiecke wertlos)
      for (const ri of touched) {
        const r = recs[ri];
        if (!r.dead && !r.tris.length) { r.dead = true; r.model = null; }
      }
      // Regionen, die auseinanderfallen, teilen
      for (const ri of touched) {
        const r = recs[ri];
        if (r.dead || r.tris.length < 2) continue;
        const comps = edgeComps(mesh, r.tris);
        if (comps.length < 2) continue;
        comps.sort((x, y) => (y.length - x.length) || (x[0] - y[0]));
        r.tris = comps[0];
        for (let ci = 1; ci < comps.length; ci++) {
          const tris = comps[ci];
          let type = r.type, m = null;
          if (tris.length >= 3) {
            m = fit(mesh, tris, type, tol);
            if (m && !tris.every((f) => okTri(m, f))) m = null;
          }
          if (!m) { type = 'plane'; m = fit(mesh, tris, 'plane', tol); }
          if (!m) { type = 'facet'; m = null; }
          recs.push({ type, model: m, tris: tris.slice(), dead: false });
          const ni = recs.length - 1;
          for (const f of tris) owner[f] = ni;
        }
      }
      // geänderte Regionen nachfitten (nur übernehmen, wenn alle passen)
      for (const ri of touched) {
        const r = recs[ri];
        if (r.dead || !r.model || !r.tris.length) continue;
        const m = fit(mesh, r.tris, r.type, tol);
        if (m && r.tris.every((f) => okTri(m, f))) r.model = m;
      }
    }

    // ── 2. Verschmelzung: gleiche Flächen zusammenführen ────────────────────
    for (let mr = 0; mr < 12; mr++) {
      const cents = recs.map((r) => (r.dead || !r.tris.length ? null : regionCentroid(mesh, r.tris)));
      let merged = false;
      for (let f = 0; f < T; f++) {
        for (const [g] of adj[f]) {
          if (g < f) continue;
          const ri = owner[f], rj = owner[g];
          if (ri < 0 || rj < 0 || ri === rj) continue;
          if (recs[ri].dead || recs[rj].dead) continue;
          if (!canMerge(recs[ri], recs[rj], tol, cents[ri], cents[rj])) continue;
          const tris = recs[ri].tris.concat(recs[rj].tris);
          const m = fit(mesh, tris, recs[ri].type, tol);
          if (!m || !tris.every((x) => okTri(m, x))) continue;
          for (const x of recs[rj].tris) owner[x] = ri;
          recs[ri].tris = tris; recs[ri].model = m;
          recs[rj].tris = []; recs[rj].model = null; recs[rj].dead = true;
          merged = true;
        }
      }
      if (!merged) break;
      changed = true;
    }

    if (!changed) break;
  }

  // ── 3. Schluss-Fit: jede Region mit ihrem Modell neu fitten ──────────────
  for (const r of recs) {
    if (r.dead || !r.model || !r.tris.length) continue;
    const m = fit(mesh, r.tris, r.type, tol);
    if (m && r.tris.every((f) => okTri(m, f))) r.model = m;
  }

  // Ergebnis neu aufbauen (fortlaufende Ids, Label konsistent)
  const out = [];
  const newLabel = new Int32Array(T).fill(-1);
  for (const r of recs) {
    if (r.dead || !r.tris.length) continue;
    const id = out.length;
    let area = 0;
    for (const f of r.tris) { newLabel[f] = id; area += A[f]; }
    out.push({ id, type: r.type, surf: r.model ? r.model.surf : null, tris: r.tris, area });
  }
  return { regions: out, label: newLabel };
}

export function segmentByFit(mesh, opts = {}) {
  const tol = opts.tol ?? 0.02;
  const angleDeg = opts.angleDeg ?? 12;
  const timeBudgetMs = opts.timeBudgetMs ?? 4000;
  const trim = opts.trim !== false;
  if (!mesh || !mesh.T) return { label: new Int32Array(0), regions: [] };
  const { P, tri, T, N, A, adj } = mesh;
  const ncos = Math.cos(angleDeg * Math.PI / 180);
  // Ebenen: Facetten einer echten Ebene liegen exakt darin (Normale ±0°) — mit dem allgemeinen
  // Winkel (12°) schluckte eine Ebene ganze Verrundungs-Streifen (r 1, 11,25° je Streifen).
  const ncosPlane = Math.cos((opts.planeAngleDeg ?? 3) * Math.PI / 180);
  const label = new Int32Array(T).fill(-1);
  const regions = [];
  const t0 = now();
  let timedOut = false;

  const nrmBuf = [0, 0, 0];
  const okTri = (m, f) => {
    const i0 = tri[3 * f], i1 = tri[3 * f + 1], i2 = tri[3 * f + 2];
    if (m.dist(P[3 * i0], P[3 * i0 + 1], P[3 * i0 + 2]) > tol) return false;
    if (m.dist(P[3 * i1], P[3 * i1 + 1], P[3 * i1 + 2]) > tol) return false;
    if (m.dist(P[3 * i2], P[3 * i2 + 1], P[3 * i2 + 2]) > tol) return false;
    const qx = (P[3 * i0] + P[3 * i1] + P[3 * i2]) / 3;
    const qy = (P[3 * i0 + 1] + P[3 * i1 + 1] + P[3 * i2 + 1]) / 3;
    const qz = (P[3 * i0 + 2] + P[3 * i1 + 2] + P[3 * i2 + 2]) / 3;
    m.normal(qx, qy, qz, nrmBuf);
    const c = nrmBuf[0] * N[3 * f] + nrmBuf[1] * N[3 * f + 1] + nrmBuf[2] * N[3 * f + 2];
    return Math.abs(c) >= (m.type === 'plane' ? ncosPlane : ncos);
  };

  // Nachbarschaft um eine Keimmenge erweitern (Dihedral ≤ 20°)
  const seedHood = (s, n) => {
    const out = [s];
    const seen = new Set(out);
    for (let qi = 0; qi < out.length && out.length < n; qi++) {
      for (const [g, d] of adj[out[qi]]) {
        if (seen.has(g) || label[g] >= 0 || d > 20) continue;
        seen.add(g); out.push(g);
        if (out.length >= n) break;
      }
    }
    return out;
  };

  // Restfehler: flächengewichteter RMS-Abstand der Eckpunkte zum Modell
  const modelRms = (m, mem) => {
    let s2 = 0, sw = 0;
    for (const f of mem) {
      const w = A[f];
      for (let k = 0; k < 3; k++) {
        const i = tri[3 * f + k];
        const d = m.dist(P[3 * i], P[3 * i + 1], P[3 * i + 2]);
        s2 += w * d * d;
        sw += w;
      }
    }
    return sw > 0 ? Math.sqrt(s2 / sw) : 0;
  };

  // größte Vertexabweichung eines Dreiecks vom Modell
  const maxDev = (m, f) => {
    let d = 0;
    for (let k = 0; k < 3; k++) {
      const i = tri[3 * f + k];
      const dd = m.dist(P[3 * i], P[3 * i + 1], P[3 * i + 2]);
      if (dd > d) d = dd;
    }
    return d;
  };

  // Abstand des Dreiecksmittelpunkts vom Modell
  const cenDev = (m, f) => {
    const i0 = tri[3 * f], i1 = tri[3 * f + 1], i2 = tri[3 * f + 2];
    return m.dist(
      (P[3 * i0] + P[3 * i1] + P[3 * i2]) / 3,
      (P[3 * i0 + 1] + P[3 * i1 + 1] + P[3 * i2 + 1]) / 3,
      (P[3 * i0 + 2] + P[3 * i1 + 2] + P[3 * i2 + 2]) / 3);
  };

  // Region wachsen lassen
  const grow = (seedSet, type) => {
    let set = seedSet;
    let m = fitModelInternal(mesh, set, type, tol);
    if (!m) return null;
    // Ausreißer abtrennen (greedy): das am weitesten abweichende Dreieck wird
    // entfernt, wenn der Restfehler dadurch deutlich kleiner wird. Damit fällt
    // eine tangential anliegende Nachbarfläche (Verrundung an der Ebene, Kugel
    // am Zylinder) aus der Saat heraus und das Modell wird sauber nachgeführt.
    for (let it = 0; trim && it < 4 && set.length > 3; it++) {
      const dev = set.map((f) => maxDev(m, f));
      const worst = dev.indexOf(Math.max(...dev));
      if (worst === 0) break;                       // die Saat bleibt erhalten
      const keep = set.filter((_, i) => i !== worst);
      if (keep.length < 3) break;
      const m2 = fitModelInternal(mesh, keep, type, tol);
      if (!m2) break;
      const rmsNow = modelRms(m, set);
      const rms2 = modelRms(m2, keep);
      if (!(rms2 < rmsNow * 0.7)) break;            // kein deutlicher Gewinn
      set = keep;
      m = m2;
    }
    for (const f of set) {
      if (!okTri(m, f)) return null;
    }
    // Gekrümmtes Modell: auch der Dreiecksmittelpunkt muss auf der Fläche liegen
    // (eine Kugel durch eine ebene Fläche trifft deren Ecken, aber nicht die
    // Fläche) — sonst ist das Modell entartet.
    if (type !== 'plane') {
      for (const f of set) if (cenDev(m, f) > 2 * tol) return null;
    }
    const rmsSeed = modelRms(m, set);
    // Wachsen: ein Nachbar darf den Restfehler der Region nicht verfälschen —
    // tangential anliegende Flächen (Verrundung neben Ebene) passen zwar in die
    // Toleranz, gehören aber nicht zur Fläche.
    const lim = Math.max(4 * rmsSeed, 0.25 * tol);
    const mem = set.slice();
    const inS = new Set(mem);
    let lastFit = mem.length;
    for (let qi = 0; qi < mem.length; qi++) {
      for (const [g, d] of adj[mem[qi]]) {
        if (inS.has(g) || label[g] >= 0 || d > 45) continue;
        if (!okTri(m, g)) continue;
        if (maxDev(m, g) > lim) continue;
        inS.add(g); mem.push(g);
        if (mem.length >= 2 * lastFit && mem.length >= 8) {
          const m2 = fitModelInternal(mesh, mem, type, tol);
          if (m2 && mem.every((f) => okTri(m2, f))) m = m2;
          lastFit = mem.length;
        }
      }
    }
    // Schluss-Fit auf allen Dreiecken der Region (nur übernehmen, wenn weiter gültig)
    const mf = fitModelInternal(mesh, mem, type, tol);
    if (mf && mem.every((f) => okTri(mf, f))) m = mf;
    let area = 0;
    for (const f of mem) area += A[f];
    return { type, model: m, mem, area, rms: modelRms(m, mem) };
  };

  // Region eintragen
  const models = [];
  const addRegion = (r) => {
    const id = regions.length;
    for (const f of r.mem) label[f] = id;
    regions.push({
      id,
      type: r.type,
      surf: r.model ? r.model.surf : null,
      tris: r.mem,
      area: r.area,
    });
    models.push(r.model || null);
  };

  // Modell-Suche zu einer Saat: Nachbarschaften 24/10/4, je alle Modelltypen.
  // Es wird NICHT bei der ersten erfolgreichen Nachbarschaft abgebrochen — das
  // beste Modell (Fläche, dann Restfehler, dann Rang) zählt.
  const trySeed = (s) => {
    let best = null;
    for (const n of [24, 10, 4]) {
      const hood = seedHood(s, n);
      for (const type of TYPES) {
        if (type === 'torus' && hood.length < 6) continue;
        const r = grow(hood, type);
        if (!r) continue;
        if (betterCand(r, best)) best = r;
      }
    }
    return best;
  };

  // Pass 1: alle Saaten. Passt auf kein Modell, wird die Saat VERTAGT und nicht
  // markiert — ihre Nachbarschaft streift sonst tangentiale Grenzen (z. B.
  // Zylinder↔Kugel) und passt auf kein Modell.
  // Pass 2: vertagte Saaten erneut, in gleicher Reihenfolge; die Nachbarschaft
  // besteht jetzt nur noch aus unmarkierten Dreiecken — das Modell passt.
  const order = seedOrder(mesh);
  const deferred = [];
  const run = (list, keep) => {
    for (const s of list) {
      if (label[s] >= 0) continue;
      if (now() - t0 >= timeBudgetMs) { timedOut = true; return; }
      const r = trySeed(s);
      if (r) addRegion(r);
      else if (keep) keep.push(s);
    }
  };
  run(order, deferred);
  if (!timedOut) run(deferred, null);

  // Zeitbudget überschritten: übrige Dreiecke einzeln als Facette
  if (timedOut) {
    for (let f = 0; f < T; f++) {
      if (label[f] >= 0) continue;
      const id = regions.length;
      label[f] = id;
      regions.push({ id, type: 'facet', surf: null, tris: [f], area: A[f] });
    }
    return { label, regions };
  }

  // Rückfall: jedes übrige Dreieck wird zur Ebene aus sich selbst (passt immer);
  // Facette nur, wenn selbst das entartete Dreieck scheitert.
  for (let f = 0; f < T; f++) {
    if (label[f] >= 0) continue;
    const r = grow([f], 'plane');
    if (r) addRegion(r);
    else {
      const id = regions.length;
      label[f] = id;
      regions.push({ id, type: 'facet', surf: null, tris: [f], area: A[f] });
      models.push(null);
    }
  }
  // Nachbearbeitung: Wettbewerb, Verschmelzung, Schluss-Fit
  const refined = refineRegions(mesh, regions, models, { tol, okTri, fit: fitModelInternal });
  return { label: refined.label, regions: refined.regions };
}

/**
 * mesh-simplify.js — QEM-Kantenkollaps-Simplifizierer (eigene Implementierung).
 *
 * Verfahren: Garland & Heckbert 1997 "Surface Simplification Using Quadric Error
 * Metrics" (QEM) plus die üblichen topologischen Validitätsprüfungen
 * (Link-Bedingung, Grad-Bedingung, Normalen-Drehung, Qualitätsschranke).
 *
 * API:
 *   simplifyMesh(mesh, maxFaces = 50000, progressCb = null, opts = {}) → mesh
 *
 * Eingabe : { faces: [{ normal, vertices:[[x,y,z]×3], area }], vertices: Float32Array }
 *           (Face-Soup aus parseStl)
 * Ausgabe : gleiche Form, plus `simplifyReport`.
 *
 * Alle Toleranzen rechnen in normalisierten Einheiten (BBox-Mitte / -Diagonale),
 * damit das Ergebnis unabhängig von Lage, Größe und Orientierung des Teils ist.
 */

export const SIMPLIFY_DEFAULTS = {
  featureDeg: 30,        // Kantenwinkel > ⇒ Feature-Kante
  featureWeight: 100,    // Gewicht der Feature-Ebenen
  maxNormalTurnDeg: 60,  // max. erlaubte Normalendrehung pro Kollaps
  minQuality: 0.1,       // min. Dreiecksqualität (1 = equilateral)
  tieBreak: 1e-3         // Zusatzkosten: kurze Kanten zuerst
};

/** Scratch-Ergebnis der Kostenberechnung (keine Allokation im heißen Loop). */
const _c = { key: 0, tx: 0, ty: 0, tz: 0, skip: false };

/** Binärer Min-Heap auf typisierten Arrays, mit lazy deletion. */
class EdgeHeap {
  constructor(cap = 1024) {
    this.key = new Float64Array(cap);
    this.a = new Int32Array(cap);
    this.b = new Int32Array(cap);
    this.va = new Int32Array(cap);
    this.vb = new Int32Array(cap);
    this.n = 0;
    this.cap = cap;
    this.ra = 0; this.rb = 0; this.rva = 0; this.rvb = 0;
  }
  grow() {
    const cap = this.cap * 2;
    const k = new Float64Array(cap); k.set(this.key); this.key = k;
    const a = new Int32Array(cap); a.set(this.a); this.a = a;
    const b = new Int32Array(cap); b.set(this.b); this.b = b;
    const va = new Int32Array(cap); va.set(this.va); this.va = va;
    const vb = new Int32Array(cap); vb.set(this.vb); this.vb = vb;
    this.cap = cap;
  }
  swap(i, j) {
    const k = this.key[i]; this.key[i] = this.key[j]; this.key[j] = k;
    const a = this.a[i]; this.a[i] = this.a[j]; this.a[j] = a;
    const b = this.b[i]; this.b[i] = this.b[j]; this.b[j] = b;
    const va = this.va[i]; this.va[i] = this.va[j]; this.va[j] = va;
    const vb = this.vb[i]; this.vb[i] = this.vb[j]; this.vb[j] = vb;
  }
  push(key, a, b, va, vb) {
    if (this.n === this.cap) this.grow();
    let i = this.n++;
    this.key[i] = key; this.a[i] = a; this.b[i] = b; this.va[i] = va; this.vb[i] = vb;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.key[p] <= this.key[i]) break;
      this.swap(p, i);
      i = p;
    }
  }
  /** Liefert true, wenn ein Element entnommen wurde (Werte in this.ra/…). */
  pop() {
    if (this.n === 0) return false;
    this.ra = this.a[0]; this.rb = this.b[0]; this.rva = this.va[0]; this.rvb = this.vb[0];
    this.n--;
    if (this.n > 0) {
      const l = this.n;
      this.key[0] = this.key[l]; this.a[0] = this.a[l]; this.b[0] = this.b[l];
      this.va[0] = this.va[l]; this.vb[0] = this.vb[l];
      let i = 0;
      for (;;) {
        const lft = 2 * i + 1, rgt = lft + 1;
        let m = i;
        if (lft < this.n && this.key[lft] < this.key[m]) m = lft;
        if (rgt < this.n && this.key[rgt] < this.key[m]) m = rgt;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return true;
  }
}

/** Quadrikfehler err(x) = xᵀAx + 2·[q3,q6,q8]·x + q9 (auf ≥ 0 geklemmt). */
function quadErr(q0, q1, q2, q3, q4, q5, q6, q7, q8, q9, x, y, z) {
  const e = q0 * x * x + 2 * q1 * x * y + 2 * q2 * x * z + 2 * q3 * x
    + q4 * y * y + 2 * q5 * y * z + 2 * q6 * y
    + q7 * z * z + 2 * q8 * z + q9;
  return e > 0 ? e : 0;
}

/** Dreiecksqualität: 4√3·A / (l0²+l1²+l2²) — 1 bei equilateral. */
function triQuality(ax, ay, az, bx, by, bz, cx, cy, cz) {
  const ux = bx - ax, uy = by - ay, uz = bz - az;
  const vx = cx - ax, vy = cy - ay, vz = cz - az;
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const area2 = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (area2 <= 0) return 0;
  const l0 = ux * ux + uy * uy + uz * uz;
  const l1 = vx * vx + vy * vy + vz * vz;
  const wx = cx - bx, wy = cy - by, wz = cz - bz;
  const l2 = wx * wx + wy * wy + wz * wz;
  const s = l0 + l1 + l2;
  if (s <= 0) return 0;
  // area2 = 2·A  ⇒  4√3·A = 2√3·area2
  return 3.4641016151377544 * area2 / s;
}

/**
 * Schritt 1+2: Face-Soup schweißen, normalisieren, Topologie aufbauen, Vertices sperren.
 * @returns {object} Topologie-Deskriptor
 */
function prepareMesh(src) {
  // ---------- Schritt 1a: Schweißen nach exakten Koordinaten ----------
  const vmap = new Map();
  const origFlat = [];
  const idxOf = (v) => {
    const k = v[0] + ',' + v[1] + ',' + v[2];
    let i = vmap.get(k);
    if (i === undefined) {
      i = origFlat.length / 3;
      vmap.set(k, i);
      origFlat.push(+v[0], +v[1], +v[2]);
    }
    return i;
  };
  const fi = [];
  for (let f = 0; f < src.length; f++) {
    const t = src[f].vertices;
    const a = idxOf(t[0]), b = idxOf(t[1]), c = idxOf(t[2]);
    if (a === b || b === c || a === c) continue;  // index-degeneriert → verwerfen
    fi.push(a, b, c);
  }
  const V = origFlat.length / 3;
  const Fc = fi.length / 3;
  const orig = Float64Array.from(origFlat);

  // ---------- Schritt 1b: Normalisierung ----------
  let x0 = Infinity, y0 = Infinity, z0 = Infinity;
  let x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < V; i++) {
    const x = orig[3 * i], y = orig[3 * i + 1], z = orig[3 * i + 2];
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
    if (z < z0) z0 = z; if (z > z1) z1 = z;
  }
  const cx = (x0 + x1) * 0.5, cy = (y0 + y1) * 0.5, cz = (z0 + z1) * 0.5;
  const ex = x1 - x0, ey = y1 - y0, ez = z1 - z0;
  let scale = Math.sqrt(ex * ex + ey * ey + ez * ez);
  if (!(scale > 0)) scale = 1;
  const P = new Float64Array(3 * V);
  for (let i = 0; i < V; i++) {
    P[3 * i] = (orig[3 * i] - cx) / scale;
    P[3 * i + 1] = (orig[3 * i + 1] - cy) / scale;
    P[3 * i + 2] = (orig[3 * i + 2] - cz) / scale;
  }

  // ---------- Schritt 2: Topologie ----------
  const F = Int32Array.from(fi);
  const alive = new Uint8Array(Fc).fill(1);
  const vf = new Array(V);
  for (let i = 0; i < V; i++) vf[i] = [];
  for (let f = 0; f < Fc; f++) {
    vf[F[3 * f]].push(f);
    vf[F[3 * f + 1]].push(f);
    vf[F[3 * f + 2]].push(f);
  }

  // Kante → Face-Anzahl + Orientierung (+1 wenn a→b mit a<b)
  const emap = new Map();
  for (let f = 0; f < Fc; f++) {
    const a = F[3 * f], b = F[3 * f + 1], c = F[3 * f + 2];
    for (let e = 0; e < 3; e++) {
      const p = e === 0 ? a : (e === 1 ? b : c);
      const q = e === 0 ? b : (e === 1 ? c : a);
      const lo = p < q ? p : q, hi = p < q ? q : p;
      const key = lo * V + hi;
      let rec = emap.get(key);
      if (!rec) { rec = { c: 0, s: 0, f0: -1, f1: -1 }; emap.set(key, rec); }
      rec.c++;
      rec.s += (p === lo) ? 1 : -1;
      if (rec.f0 < 0) rec.f0 = f; else if (rec.f1 < 0) rec.f1 = f;
    }
  }

  // ---------- Schritt 2b: Sperren (Topologie) ----------
  const locked = new Uint8Array(V);
  for (const [key, rec] of emap) {
    if (rec.c !== 2 || rec.s !== 0) {           // Rand / nicht-manifold / inkonsistent
      const lo = Math.floor(key / V), hi = key - lo * V;
      locked[lo] = 1; locked[hi] = 1;
    }
  }
  // Non-Manifold-Vertex: Walk um v; besucht der Walk nicht alle Faces ⇒ gesperrt
  const walkStamp = new Int32Array(V);
  const walkNext = new Int32Array(V);
  for (let v = 0; v < V; v++) {
    const list = vf[v];
    if (list.length < 2) continue;
    const ep = v + 1;
    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      const a = F[3 * f], b = F[3 * f + 1], c = F[3 * f + 2];
      let u, w;
      if (a === v) { u = b; w = c; } else if (b === v) { u = c; w = a; } else { u = a; w = b; }
      walkStamp[u] = ep; walkNext[u] = w;
    }
    const f0 = list[0];
    const a0 = F[3 * f0], b0 = F[3 * f0 + 1], c0 = F[3 * f0 + 2];
    let u0, w0;
    if (a0 === v) { u0 = b0; w0 = c0; } else if (b0 === v) { u0 = c0; w0 = a0; } else { u0 = a0; w0 = b0; }
    let u = u0, w = w0, cnt = 0;
    for (;;) {
      cnt++;
      if (walkStamp[w] !== ep) break;
      const nw = walkNext[w];
      u = w; w = nw;
      if (u === u0 && w === w0) break;
      if (cnt >= list.length) break;
    }
    if (cnt !== list.length) locked[v] = 1;
  }

  let lockedVerts = 0;
  for (let v = 0; v < V; v++) if (locked[v]) lockedVerts++;

  return { V, Fc, F, alive, vf, emap, P, orig, cx, cy, cz, scale, locked, lockedVerts };
}

/**
 * Schritt 3: Quadriken je Vertex (Flächenebenen + Feature-Ebenen) sowie die
 * Anzahl der Feature-Kanten je Vertex (Ecken-Erkennung).
 */
function buildQuadrics(T, O) {
  const { V, Fc, F, P, emap } = T;
  const Q = new Float64Array(10 * V);
  const fcount = new Uint8Array(V);
  const fn = new Float64Array(3 * Fc);

  const addQ = (v, a, b, c, d, w) => {
    const o = v * 10;
    Q[o] += w * a * a;
    Q[o + 1] += w * a * b;
    Q[o + 2] += w * a * c;
    Q[o + 3] += w * a * d;
    Q[o + 4] += w * b * b;
    Q[o + 5] += w * b * c;
    Q[o + 6] += w * b * d;
    Q[o + 7] += w * c * c;
    Q[o + 8] += w * c * d;
    Q[o + 9] += w * d * d;
  };

  // Flächenebenen: w = Flächeninhalt (normalisierte Einheiten)
  for (let f = 0; f < Fc; f++) {
    const i0 = F[3 * f], i1 = F[3 * f + 1], i2 = F[3 * f + 2];
    const ax = P[3 * i0], ay = P[3 * i0 + 1], az = P[3 * i0 + 2];
    const ux = P[3 * i1] - ax, uy = P[3 * i1 + 1] - ay, uz = P[3 * i1 + 2] - az;
    const vx = P[3 * i2] - ax, vy = P[3 * i2 + 1] - ay, vz = P[3 * i2 + 2] - az;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (!(len > 0)) continue;                     // entartetes Face → keine Ebene
    const area = len * 0.5;
    nx /= len; ny /= len; nz /= len;
    fn[3 * f] = nx; fn[3 * f + 1] = ny; fn[3 * f + 2] = nz;
    const d = -(nx * ax + ny * ay + nz * az);
    addQ(i0, nx, ny, nz, d, area);
    addQ(i1, nx, ny, nz, d, area);
    addQ(i2, nx, ny, nz, d, area);
  }

  // Feature-Kanten: scharfer Kantenknick ⇒ 2 Zwangsebenen durch die Kante
  const cosFeat = Math.cos(O.featureDeg * Math.PI / 180);
  for (const [key, rec] of emap) {
    if (rec.c !== 2 || rec.s !== 0) continue;    // kein mannfaltiger, konsistenter Rand
    const lo = Math.floor(key / V), hi = key - lo * V;
    const f0 = rec.f0, f1 = rec.f1;
    const dot = fn[3 * f0] * fn[3 * f1] + fn[3 * f0 + 1] * fn[3 * f1 + 1] + fn[3 * f0 + 2] * fn[3 * f1 + 2];
    if (dot >= cosFeat) continue;                // kein scharfer Knick
    const ex = P[3 * hi] - P[3 * lo], ey = P[3 * hi + 1] - P[3 * lo + 1], ez = P[3 * hi + 2] - P[3 * lo + 2];
    const elen2 = ex * ex + ey * ey + ez * ez;
    if (!(elen2 > 0)) continue;
    fcount[lo] = fcount[lo] < 255 ? fcount[lo] + 1 : 255;
    fcount[hi] = fcount[hi] < 255 ? fcount[hi] + 1 : 255;
    for (let k = 0; k < 2; k++) {
      const f = k === 0 ? f0 : f1;
      const nx = fn[3 * f], ny = fn[3 * f + 1], nz = fn[3 * f + 2];
      let mx = ey * nz - ez * ny, my = ez * nx - ex * nz, mz = ex * ny - ey * nx;
      const ml = Math.sqrt(mx * mx + my * my + mz * mz);
      if (!(ml > 0)) continue;
      mx /= ml; my /= ml; mz /= ml;
      const dd = -(mx * P[3 * lo] + my * P[3 * lo + 1] + mz * P[3 * lo + 2]);
      const w = O.featureWeight * elen2;
      addQ(lo, mx, my, mz, dd, w);
      addQ(hi, mx, my, mz, dd, w);
    }
  }
  return { Q, fcount };
}

/**
 * Edge-Collapse-Simplifizierung mit Quadric Error Metrics.
 *
 * @param {{faces: Array, vertices: Float32Array}} mesh - Face-Soup (parseStl)
 * @param {number} maxFaces - Ziel-Facecount
 * @param {function} [progressCb] - Fortschritt {processed, total, phase}
 * @param {object} [opts] - Überschreibt SIMPLIFY_DEFAULTS
 * @returns {{faces: Array, vertices: Float32Array, simplifyReport: object}}
 */
export function simplifyMesh(mesh, maxFaces = 50000, progressCb = null, opts = {}) {
  if (!mesh?.faces?.length || mesh.faces.length <= maxFaces) return mesh;

  const O = { ...SIMPLIFY_DEFAULTS, ...(opts || {}) };
  const t0 = Date.now();
  const src = mesh.faces;
  const inFaces = src.length;
  const total = inFaces - maxFaces;

  const T = prepareMesh(src);
  const { V, Fc, F, alive, vf, emap, P, orig, cx, cy, cz, scale, locked } = T;
  const { Q, fcount } = buildQuadrics(T, O);

  const report = {
    inFaces, outFaces: 0, collapses: 0, lockedVerts: T.lockedVerts,
    rejected: { link: 0, flip: 0, quality: 0, locked: 0 }, passes: 0, ms: 0
  };
  if (Fc === 0 || V === 0) {
    report.ms = Date.now() - t0;
    return { faces: [], vertices: new Float32Array(0), simplifyReport: report };
  }

  const ver = new Int32Array(V);       // Versionszähler je Vertex (Heap-Invalidierung)
  const dead = new Uint8Array(V);      // 1 = Vertex entfernt
  const moved = new Uint8Array(V);     // 1 = Vertex hat neue Position
  const heap = new EdgeHeap(1024);
  const cosTurn = Math.cos(O.maxNormalTurnDeg * Math.PI / 180);
  const tieBreak = O.tieBreak;

  // ---------- Schritt 4: Zielpunkt und Kosten einer Kante (a,b) ----------
  function edgeCost(a, b) {
    const oa = a * 10, ob = b * 10;
    const q0 = Q[oa] + Q[ob], q1 = Q[oa + 1] + Q[ob + 1], q2 = Q[oa + 2] + Q[ob + 2];
    const q3 = Q[oa + 3] + Q[ob + 3], q4 = Q[oa + 4] + Q[ob + 4], q5 = Q[oa + 5] + Q[ob + 5];
    const q6 = Q[oa + 6] + Q[ob + 6], q7 = Q[oa + 7] + Q[ob + 7], q8 = Q[oa + 8] + Q[ob + 8];
    const q9 = Q[oa + 9] + Q[ob + 9];
    const tr = q0 + q4 + q7;

    // Feature-Ecken: nie verschieben, nie ineinander kollabieren
    const fa = fcount[a], fb = fcount[b];
    const aCorner = fa >= 3 || fa === 1;
    const bCorner = fb >= 3 || fb === 1;
    if (aCorner && bCorner) { _c.skip = true; return; }

    const ax = P[3 * a], ay = P[3 * a + 1], az = P[3 * a + 2];
    const bx = P[3 * b], by = P[3 * b + 1], bz = P[3 * b + 2];
    const ex = bx - ax, ey = by - ay, ez = bz - az;
    const len = Math.sqrt(ex * ex + ey * ey + ez * ez);
    if (!(len > 0)) { _c.skip = true; return; }
    const mx = (ax + bx) * 0.5, my = (ay + by) * 0.5, mz = (az + bz) * 0.5;

    const errA = quadErr(q0, q1, q2, q3, q4, q5, q6, q7, q8, q9, ax, ay, az);
    const errB = quadErr(q0, q1, q2, q3, q4, q5, q6, q7, q8, q9, bx, by, bz);
    const errM = quadErr(q0, q1, q2, q3, q4, q5, q6, q7, q8, q9, mx, my, mz);
    let best = errM, tx = mx, ty = my, tz = mz;
    if (errA < best) { best = errA; tx = ax; ty = ay; tz = az; }
    if (errB < best) { best = errB; tx = bx; ty = by; tz = bz; }

    // Optimaler Punkt (Solvability über Cofaktoren)
    if (tr > 0) {
      const det = q0 * (q4 * q7 - q5 * q5) - q1 * (q1 * q7 - q2 * q5) + q2 * (q1 * q5 - q2 * q4);
      const t3 = tr / 3;
      if (Math.abs(det) > 1e-8 * t3 * t3 * t3) {
        const i00 = q4 * q7 - q5 * q5, i01 = q2 * q5 - q1 * q7, i02 = q1 * q5 - q2 * q4;
        const i11 = q0 * q7 - q2 * q2, i12 = q1 * q2 - q0 * q5, i22 = q0 * q4 - q1 * q1;
        const r0 = -q3, r1 = -q6, r2 = -q8;
        const ox = (i00 * r0 + i01 * r1 + i02 * r2) / det;
        const oy = (i01 * r0 + i11 * r1 + i12 * r2) / det;
        const oz = (i02 * r0 + i12 * r1 + i22 * r2) / det;
        const dx = ox - mx, dy = oy - my, dz = oz - mz;
        if (dx * dx + dy * dy + dz * dz <= 4 * len * len) {
          const eo = quadErr(q0, q1, q2, q3, q4, q5, q6, q7, q8, q9, ox, oy, oz);
          if (eo < best) { best = eo; tx = ox; ty = oy; tz = oz; }
        }
      }
    }

    if (aCorner !== bCorner) {
      // Genau eine Ecke ⇒ Ziel MUSS deren Position sein
      if (aCorner) { tx = ax; ty = ay; tz = az; best = errA; }
      else { tx = bx; ty = by; tz = bz; best = errB; }
    } else {
      // Endpunkt bevorzugen (exakte Koordinaten auf Ebenen/Kanten erhalten)
      const eps = 1e-7 * len;
      const tol = tr * eps * eps;
      if (Math.min(errA, errB) <= best + tol) {
        if (errA <= errB) { tx = ax; ty = ay; tz = az; best = errA; }
        else { tx = bx; ty = by; tz = bz; best = errB; }
      }
    }
    const tb = tieBreak * len;
    _c.key = best + tr * tb * tb;
    _c.tx = tx; _c.ty = ty; _c.tz = tz;
    _c.skip = false;
  }

  // ---------- Schritt 5: Start-Heap (alle Kanten ungesperrter Endpunkte) ----------
  for (const [key] of emap) {
    const lo = Math.floor(key / V), hi = key - lo * V;
    if (locked[lo] || locked[hi]) continue;
    edgeCost(lo, hi);
    if (_c.skip) continue;
    heap.push(_c.key, lo, hi, ver[lo], ver[hi]);
  }

  // ---------- Nachbarschafts-Hilfen (ohne Allokation im heißen Loop) ----------
  const nbrS = new Int32Array(V), nbrR = new Int32Array(V);
  const stampS = new Int32Array(V), stampR = new Int32Array(V);
  const qNew = new Float64Array(2 * V + 8);
  let epochS = 0, epochR = 0;

  /** Distinct-Nachbarn von v sammeln; Rückgabe = Grad. */
  function collectS(v) {
    const e = ++epochS, list = vf[v];
    let n = 0;
    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      if (!alive[f]) continue;
      const a = F[3 * f], b = F[3 * f + 1], c = F[3 * f + 2];
      if (a !== v && stampS[a] !== e) { stampS[a] = e; nbrS[n++] = a; }
      if (b !== v && stampS[b] !== e) { stampS[b] = e; nbrS[n++] = b; }
      if (c !== v && stampS[c] !== e) { stampS[c] = e; nbrS[n++] = c; }
    }
    return n;
  }
  function collectR(v) {
    const e = ++epochR, list = vf[v];
    let n = 0;
    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      if (!alive[f]) continue;
      const a = F[3 * f], b = F[3 * f + 1], c = F[3 * f + 2];
      if (a !== v && stampR[a] !== e) { stampR[a] = e; nbrR[n++] = a; }
      if (b !== v && stampR[b] !== e) { stampR[b] = e; nbrR[n++] = b; }
      if (c !== v && stampR[c] !== e) { stampR[c] = e; nbrR[n++] = c; }
    }
    return n;
  }
  /** Lebende Faces an v (bei manifoldem Mesh = Grad). */
  function aliveCount(v) {
    const list = vf[v];
    let n = 0;
    for (let i = 0; i < list.length; i++) if (alive[list[i]]) n++;
    return n;
  }
  function removeFace(list, f) {
    const i = list.indexOf(f);
    if (i >= 0) list.splice(i, 1);
  }
  /** Alle lebenden Kanten erneut einwerfen (neuer Pass). */
  function pushAllEdges() {
    const seen = new Set();
    for (let f = 0; f < Fc; f++) {
      if (!alive[f]) continue;
      const fa = F[3 * f], fb = F[3 * f + 1], fc = F[3 * f + 2];
      for (let e = 0; e < 3; e++) {
        const p = e === 0 ? fa : (e === 1 ? fb : fc);
        const q = e === 0 ? fb : (e === 1 ? fc : fa);
        const lo = p < q ? p : q, hi = p < q ? q : p;
        if (locked[lo] || locked[hi]) continue;
        const key = lo * V + hi;
        if (seen.has(key)) continue;
        seen.add(key);
        edgeCost(lo, hi);
        if (_c.skip) continue;
        heap.push(_c.key, lo, hi, ver[lo], ver[hi]);
      }
    }
  }

  // ---------- Schritt 6+7: Kollaps-Schleife ----------
  let aliveFaces = Fc;
  let collapses = 0;
  let removed = 0;
  let passes = 1;
  let passCollapses = 0;
  const rej = report.rejected;
  const progStep = Math.max(1, Math.floor(total * 0.02));
  let nextProg = progStep;

  while (aliveFaces > maxFaces) {
    if (heap.n === 0) {
      // Heap leer: neuer Pass (re-Push aller lebenden Kanten)
      if (passCollapses === 0 || passes >= 8) break;
      passes++; passCollapses = 0;
      pushAllEdges();
      continue;
    }
    heap.pop();
    const a = heap.ra, b = heap.rb;
    if (dead[a] || dead[b]) continue;
    if (ver[a] !== heap.rva || ver[b] !== heap.rvb) continue;

    edgeCost(a, b);
    if (_c.skip) continue;
    const tx = _c.tx, ty = _c.ty, tz = _c.tz;
    // Rolle: Überlebender = der Endpunkt, dessen Position behalten wird
    const s = (tx === P[3 * b] && ty === P[3 * b + 1] && tz === P[3 * b + 2]) ? b : a;
    const r = s === a ? b : a;
    if (locked[s] || locked[r]) { rej.locked++; continue; }

    // --- Faces der Kante (s,r) ---
    const vr = vf[r];
    let f1 = -1, f2 = -1, cv = -1, dv = -1, tooMany = false;
    for (let i = 0; i < vr.length; i++) {
      const f = vr[i];
      if (!alive[f]) continue;
      const fa = F[3 * f], fb = F[3 * f + 1], fc = F[3 * f + 2];
      if (fa !== s && fb !== s && fc !== s) continue;
      const o = (fa !== s && fa !== r) ? fa : ((fb !== s && fb !== r) ? fb : fc);
      if (f1 < 0) { f1 = f; cv = o; }
      else if (f2 < 0) { f2 = f; dv = o; }
      else { tooMany = true; break; }
    }
    if (f1 < 0 || f2 < 0 || tooMany) { rej.link++; continue; }

    // --- Link-Bedingung: neighbours(s) ∩ neighbours(r) == {c,d} ---
    const degS = collectS(s), degR = collectR(r);
    let inter = 0;
    for (let i = 0; i < degR; i++) if (stampS[nbrR[i]] === epochS) inter++;
    if (inter !== 2) { rej.link++; continue; }

    // --- Grad-Bedingung ---
    if (aliveCount(cv) < 4 || aliveCount(dv) < 4 || degS + degR - 4 < 3) { rej.link++; continue; }

    // --- Ring-Prüfung: Normalendrehung (Flip) und Qualität ---
    let qMinOld = Infinity;
    let nq = 0;
    let flipBad = false;
    for (let ring = 0; ring < 2 && !flipBad; ring++) {
      const list = ring === 0 ? vf[s] : vf[r];
      for (let i = 0; i < list.length; i++) {
        const f = list[i];
        if (!alive[f]) continue;
        const fa = F[3 * f], fb = F[3 * f + 1], fc = F[3 * f + 2];
        const ax = P[3 * fa], ay = P[3 * fa + 1], az = P[3 * fa + 2];
        const bx = P[3 * fb], by = P[3 * fb + 1], bz = P[3 * fb + 2];
        const cx = P[3 * fc], cy = P[3 * fc + 1], cz = P[3 * fc + 2];
        const qo = triQuality(ax, ay, az, bx, by, bz, cx, cy, cz);
        if (qo < qMinOld) qMinOld = qo;
        if ((fa === s || fb === s || fc === s) && (fa === r || fb === r || fc === r)) continue;
        const nax = (fa === s || fa === r) ? tx : ax;
        const nay = (fa === s || fa === r) ? ty : ay;
        const naz = (fa === s || fa === r) ? tz : az;
        const nbx = (fb === s || fb === r) ? tx : bx;
        const nby = (fb === s || fb === r) ? ty : by;
        const nbz = (fb === s || fb === r) ? tz : bz;
        const ncx = (fc === s || fc === r) ? tx : cx;
        const ncy = (fc === s || fc === r) ? ty : cy;
        const ncz = (fc === s || fc === r) ? tz : cz;
        // alte Normale
        const oux = bx - ax, ouy = by - ay, ouz = bz - az;
        const ovx = cx - ax, ovy = cy - ay, ovz = cz - az;
        const onx = ouy * ovz - ouz * ovy, ony = ouz * ovx - oux * ovz, onz = oux * ovy - ouy * ovx;
        const olen = Math.sqrt(onx * onx + ony * ony + onz * onz);
        // neue Normale
        const nux = nbx - nax, nuy = nby - nay, nuz = nbz - naz;
        const nvx = ncx - nax, nvy = ncy - nay, nvz = ncz - naz;
        const nnx = nuy * nvz - nuz * nvy, nny = nuz * nvx - nux * nvz, nnz = nux * nvy - nuy * nvx;
        const nlen = Math.sqrt(nnx * nnx + nny * nny + nnz * nnz);
        if (nlen <= 1e-14) { flipBad = true; break; }
        if (olen > 1e-14) {
          const dp = (onx * nnx + ony * nny + onz * nnz) / (olen * nlen);
          if (dp < cosTurn) { flipBad = true; break; }
        }
        qNew[nq++] = triQuality(nax, nay, naz, nbx, nby, nbz, ncx, ncy, ncz);
      }
    }
    if (flipBad) { rej.flip++; continue; }
    const thr = Math.min(O.minQuality, qMinOld);
    let qBad = false;
    for (let i = 0; i < nq; i++) if (qNew[i] < thr) { qBad = true; break; }
    if (qBad) { rej.quality++; continue; }

    // ---------- Schritt 7: Kollaps r → s an Position t ----------
    const sx = P[3 * s], sy = P[3 * s + 1], sz = P[3 * s + 2];
    if (tx !== sx || ty !== sy || tz !== sz) moved[s] = 1;
    P[3 * s] = tx; P[3 * s + 1] = ty; P[3 * s + 2] = tz;
    const os = s * 10, orr = r * 10;
    for (let i = 0; i < 10; i++) Q[os + i] += Q[orr + i];
    ver[s]++;
    dead[r] = 1;
    // die 2 Kantenfaces töten und aus den Adjazenzlisten entfernen
    alive[f1] = 0; alive[f2] = 0;
    removeFace(vf[s], f1); removeFace(vf[s], f2);
    removeFace(vf[cv], f1); removeFace(vf[cv], f2);
    removeFace(vf[dv], f1); removeFace(vf[dv], f2);
    // übrige Faces von r auf s umhängen
    const vr2 = vf[r];
    for (let i = 0; i < vr2.length; i++) {
      const f = vr2[i];
      if (!alive[f]) continue;
      if (F[3 * f] === r) F[3 * f] = s;
      else if (F[3 * f + 1] === r) F[3 * f + 1] = s;
      else F[3 * f + 2] = s;
      vf[s].push(f);
    }
    vf[r] = [];
    if (fcount[r] > fcount[s]) fcount[s] = fcount[r];   // Ecken-Status erben
    // Kanten (s,u) neu einwerfen
    const ns = collectS(s);
    for (let i = 0; i < ns; i++) {
      const u = nbrS[i];
      if (dead[u] || locked[u]) continue;
      const lo = s < u ? s : u, hi = s < u ? u : s;
      edgeCost(lo, hi);
      if (_c.skip) continue;
      heap.push(_c.key, lo, hi, ver[lo], ver[hi]);
    }
    aliveFaces -= 2;
    collapses++; passCollapses++; removed += 2;
    if (progressCb && removed >= nextProg) {
      progressCb({ processed: removed, total, phase: 'simplify' });
      nextProg += progStep;
    }
  }

  // ---------- Ausgabe: alle lebenden Faces, exakte Koordinaten für unveränderte Vertices ----------
  const OUT = new Float64Array(3 * V);
  for (let v = 0; v < V; v++) {
    if (moved[v]) {
      OUT[3 * v] = P[3 * v] * scale + cx;
      OUT[3 * v + 1] = P[3 * v + 1] * scale + cy;
      OUT[3 * v + 2] = P[3 * v + 2] * scale + cz;
    } else {
      OUT[3 * v] = orig[3 * v];
      OUT[3 * v + 1] = orig[3 * v + 1];
      OUT[3 * v + 2] = orig[3 * v + 2];
    }
  }
  const outFaces = [];
  const outV = new Float32Array(aliveFaces * 9);
  let oi = 0;
  for (let f = 0; f < Fc; f++) {
    if (!alive[f]) continue;
    const fa = F[3 * f], fb = F[3 * f + 1], fc = F[3 * f + 2];
    const ax = OUT[3 * fa], ay = OUT[3 * fa + 1], az = OUT[3 * fa + 2];
    const bx = OUT[3 * fb], by = OUT[3 * fb + 1], bz = OUT[3 * fb + 2];
    const gx = OUT[3 * fc], gy = OUT[3 * fc + 1], gz = OUT[3 * fc + 2];
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = gx - ax, vy = gy - ay, vz = gz - az;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    const normal = len > 0 ? [nx / len, ny / len, nz / len] : [0, 0, 0];
    outFaces.push({
      normal,
      vertices: [[ax, ay, az], [bx, by, bz], [gx, gy, gz]],
      area: len * 0.5
    });
    outV[oi++] = ax; outV[oi++] = ay; outV[oi++] = az;
    outV[oi++] = bx; outV[oi++] = by; outV[oi++] = bz;
    outV[oi++] = gx; outV[oi++] = gy; outV[oi++] = gz;
  }

  report.outFaces = outFaces.length;
  report.collapses = collapses;
  report.passes = passes;
  report.ms = Date.now() - t0;
  if (progressCb) progressCb({ processed: total, total, phase: 'simplify' });
  return { faces: outFaces, vertices: outV, simplifyReport: report };
}

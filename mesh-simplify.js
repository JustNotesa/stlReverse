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
  tieBreak: 1e-3,        // Zusatzkosten: kurze Kanten zuerst
  maxDegree: 24,         // F2: maximaler Vertexgrad (je Pass verdoppelt)
  intersectionCheck: true, // F3b: lokale Durchdringungsprüfung je Kollaps
  placement: 'endpoint', // F6: 'endpoint' (nur Endpunkte) | 'optimal'
  qTol: 0.999,           // F1: multiplikative Toleranz der Qualitätsschranke
  wallGuard: true,       // H2: Dünnwand-Wächter (Kreuzung der gegenüberliegenden Wand)
  maxErrorMm: 0.02,      // Fehlerschranke in Eingabe-Einheiten (mm): RMS-Abstand √(err/Gewicht) des Zielpunkts
                         // zu den Ebenen der zusammengefassten Ursprungsflächen. Teurere Kollapse entfallen —
                         // lieber das Ziel verfehlen als verzerren (harte Regeln wie Gradgrenze und Merkmals-
                         // linien zwingen sonst den Rest des Netzes zu langen Sehnen; dünnes Rohr 240k → 50k:
                         // Hausdorff 0,64 mm bei 0,4 mm Wand). Gleiche Größe wie mesh-clean.js
                         // DEFAULT_MIN_DETAIL_MM: die Vereinfachung verfälscht nicht mehr als die kleinste
                         // Detailgröße.
  maxErrorRel: 1e-4,     // N4: relative Fehlerschranke (Anteil der BBox-Diagonalen). Effektive Schranke =
                         // min(max(maxErrorMm, maxErrorRel · D), maxErrorRelMax · D) — eine rein absolute Schranke macht das
                         // Ergebnis größenabhängig (Kugel R=200 bleibt bei 62k statt 50k Faces, R=1000 bei
                         // 153k). Die relative Schranke gibt großen Teilen dasselbe relative Detailniveau.
                         // 0 = aus (beide Schranken 0 ⇒ keine Fehlerbegrenzung).
  maxErrorRelMax: 1e-3   // Obergrenze relativ zur Diagonalen: winzige Teile oder STL in Metern/Zoll dürfen nicht
                         // um „0,02 Einheiten“ verfälscht werden (Rohr ×0,01: Volumen +68 % ohne diese Grenze).
};

/** Scratch-Ergebnis der Kostenberechnung (keine Allokation im heißen Loop). */
const _c = { key: 0, tx: 0, ty: 0, tz: 0, src: -1, skip: false, reason: 0 };

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

/* ════════════════════════════════════════════════════════════════════════════
   F5 — robuste Statistik: Median-Punkt und median Kantenlänge.
   Ein einzelner Ausreißer (1e30, Infinity) darf die Normalisierung nicht
   zerstören ⇒ Median statt Mittelwert, Stichprobe statt Vollscan.
   ════════════════════════════════════════════════════════════════════════════ */
function medianOf(arr) {
  if (!arr.length) return 0;
  arr.sort((a, b) => a - b);
  return arr[arr.length >> 1];
}

/**
 * @returns {{mx:number,my:number,mz:number,L:number}} Median-Punkt und median
 *          Kantenlänge (Stichproben, O(n) auf der Stichprobe).
 */
function robustStats(orig, V, bad, F, Fc) {
  const NS = 10000;
  const stepV = Math.max(1, Math.ceil(V / NS));
  const xs = [], ys = [], zs = [];
  for (let i = 0; i < V; i += stepV) {
    if (bad[i]) continue;
    xs.push(orig[3 * i]); ys.push(orig[3 * i + 1]); zs.push(orig[3 * i + 2]);
  }
  const mx = medianOf(xs), my = medianOf(ys), mz = medianOf(zs);
  const NE = 10000;
  const stepE = Math.max(1, Math.ceil(Fc / NE));
  const ls = [];
  for (let f = 0; f < Fc; f += stepE) {
    const a = F[3 * f], b = F[3 * f + 1];
    if (bad[a] || bad[b]) continue;
    const dx = orig[3 * b] - orig[3 * a];
    const dy = orig[3 * b + 1] - orig[3 * a + 1];
    const dz = orig[3 * b + 2] - orig[3 * a + 2];
    ls.push(Math.sqrt(dx * dx + dy * dy + dz * dz));
  }
  let L = medianOf(ls);
  if (!(L > 0) || !Number.isFinite(L)) L = 1;
  return { mx, my, mz, L };
}

/* ════════════════════════════════════════════════════════════════════════════
   F3b — exakter Dreieck–Dreieck-Schnitttest (Möller 1997, intervallbasiert).
   Jedes Dreieck wird mit seinen EIGEN Kanten und den abständen der EIGEN
   Ecken zur fremden Ebene interpoliert (kein Vertauschung von dv/du).
   Fast koplanare Paare ⇒ 2D-Überlappungstest.
   ════════════════════════════════════════════════════════════════════════════ */

/** Scratch: 6 projizierte Punkte (A0..A2, B0..B2) als 2D. */
const _c2d = new Float64Array(12);

/** 2D-Überlappung zweier Dreiecke (nur echte Kreuzungen / strikt innen). */
function coplanarOverlap2D(A, B, nx, ny, nz, eps) {
  const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
  const drop = ax >= ay && ax >= az ? 0 : (ay >= az ? 1 : 2);
  const P = _c2d;
  for (let i = 0; i < 3; i++) {
    const x = A[3 * i], y = A[3 * i + 1], z = A[3 * i + 2];
    if (drop === 0) { P[2 * i] = y; P[2 * i + 1] = z; }
    else if (drop === 1) { P[2 * i] = x; P[2 * i + 1] = z; }
    else { P[2 * i] = x; P[2 * i + 1] = y; }
  }
  for (let i = 0; i < 3; i++) {
    const x = B[3 * i], y = B[3 * i + 1], z = B[3 * i + 2];
    if (drop === 0) { P[6 + 2 * i] = y; P[6 + 2 * i + 1] = z; }
    else if (drop === 1) { P[6 + 2 * i] = x; P[6 + 2 * i + 1] = z; }
    else { P[6 + 2 * i] = x; P[6 + 2 * i + 1] = y; }
  }
  const ar = (ax0, ay0, bx0, by0, cx0, cy0) => (bx0 - ax0) * (cy0 - ay0) - (by0 - ay0) * (cx0 - ax0);
  // echte Kreuzung (berührende Kanten zählen NICHT)
  for (let i = 0; i < 3; i++) {
    const j = (i + 1) % 3;
    for (let k = 0; k < 3; k++) {
      const l = (k + 1) % 3;
      const d1 = ar(P[6 + 2 * k], P[6 + 2 * k + 1], P[6 + 2 * l], P[6 + 2 * l + 1], P[2 * i], P[2 * i + 1]);
      const d2 = ar(P[6 + 2 * k], P[6 + 2 * k + 1], P[6 + 2 * l], P[6 + 2 * l + 1], P[2 * j], P[2 * j + 1]);
      const d3 = ar(P[2 * i], P[2 * i + 1], P[2 * j], P[2 * j + 1], P[6 + 2 * k], P[6 + 2 * k + 1]);
      const d4 = ar(P[2 * i], P[2 * i + 1], P[2 * j], P[2 * j + 1], P[6 + 2 * l], P[6 + 2 * l + 1]);
      if (((d1 > eps && d2 < -eps) || (d1 < -eps && d2 > eps)) &&
          ((d3 > eps && d4 < -eps) || (d3 < -eps && d4 > eps))) return true;
    }
  }
  // strikt innenliegender Punkt
  const sA = ar(P[0], P[1], P[2], P[3], P[4], P[5]) >= 0 ? 1 : -1;
  const sB = ar(P[6], P[7], P[8], P[9], P[10], P[11]) >= 0 ? 1 : -1;
  const inside = (px, py, bx0, by0, cx0, cy0, dx0, dy0, sgn) =>
    ar(bx0, by0, cx0, cy0, px, py) * sgn > eps &&
    ar(cx0, cy0, dx0, dy0, px, py) * sgn > eps &&
    ar(dx0, dy0, bx0, by0, px, py) * sgn > eps;
  for (let i = 0; i < 3; i++) {
    if (inside(P[2 * i], P[2 * i + 1], P[6], P[7], P[8], P[9], P[10], P[11], sB)) return true;
    if (inside(P[6 + 2 * i], P[6 + 2 * i + 1], P[0], P[1], P[2], P[3], P[4], P[5], sA)) return true;
  }
  return false;
}

/**
 * Dreieck–Dreieck-Schnitttest.
 * @param {Float64Array} A - 9 Koordinaten (A0,A1,A2)
 * @param {Float64Array} B - 9 Koordinaten (B0,B1,B2)
 * @param {Float64Array|null} pl - vorberechnete Ebene von A [nx,ny,nz,d] (oder null)
 * @returns {boolean} true, wenn sich die geschlossenen Dreiecke schneiden
 */
function triTriOverlap(A, B, pl) {
  let n1x, n1y, n1z, d1;
  if (pl) { n1x = pl[0]; n1y = pl[1]; n1z = pl[2]; d1 = pl[3]; }
  else {
    const e1x = A[3] - A[0], e1y = A[4] - A[1], e1z = A[5] - A[2];
    const e2x = A[6] - A[0], e2y = A[7] - A[1], e2z = A[8] - A[2];
    n1x = e1y * e2z - e1z * e2y; n1y = e1z * e2x - e1x * e2z; n1z = e1x * e2y - e1y * e2x;
    const l1 = Math.sqrt(n1x * n1x + n1y * n1y + n1z * n1z);
    if (!(l1 > 0)) return false;
    n1x /= l1; n1y /= l1; n1z /= l1;
    d1 = -(n1x * A[0] + n1y * A[1] + n1z * A[2]);
  }
  const f1x = B[3] - B[0], f1y = B[4] - B[1], f1z = B[5] - B[2];
  const f2x = B[6] - B[0], f2y = B[7] - B[1], f2z = B[8] - B[2];
  let n2x = f1y * f2z - f1z * f2y, n2y = f1z * f2x - f1x * f2z, n2z = f1x * f2y - f1y * f2x;
  const l2 = Math.sqrt(n2x * n2x + n2y * n2y + n2z * n2z);
  if (!(l2 > 0)) return false;
  n2x /= l2; n2y /= l2; n2z /= l2;
  const d2 = -(n2x * B[0] + n2y * B[1] + n2z * B[2]);
  // du: Abstände der B-Ecken zur Ebene A;  dv: Abstände der A-Ecken zur Ebene B
  const du0 = n1x * B[0] + n1y * B[1] + n1z * B[2] + d1;
  const du1 = n1x * B[3] + n1y * B[4] + n1z * B[5] + d1;
  const du2 = n1x * B[6] + n1y * B[7] + n1z * B[8] + d1;
  const dv0 = n2x * A[0] + n2y * A[1] + n2z * A[2] + d2;
  const dv1 = n2x * A[3] + n2y * A[4] + n2z * A[5] + d2;
  const dv2 = n2x * A[6] + n2y * A[7] + n2z * A[8] + d2;
  // alle Ecken strikt auf einer Seite ⇒ kein Schnitt
  if ((du0 > 0 && du1 > 0 && du2 > 0) || (du0 < 0 && du1 < 0 && du2 < 0)) return false;
  if ((dv0 > 0 && dv1 > 0 && dv2 > 0) || (dv0 < 0 && dv1 < 0 && dv2 < 0)) return false;
  // Toleranz bewusst sehr klein: keine Fehlalarme durch Rundung
  const sc = Math.max(
    Math.abs(A[3] - A[0]), Math.abs(A[4] - A[1]), Math.abs(A[5] - A[2]),
    Math.abs(A[6] - A[0]), Math.abs(A[7] - A[1]), Math.abs(A[8] - A[2]),
    Math.abs(B[3] - B[0]), Math.abs(B[4] - B[1]), Math.abs(B[5] - B[2]),
    Math.abs(B[6] - B[0]), Math.abs(B[7] - B[1]), Math.abs(B[8] - B[2]));
  const eps = sc * 1e-9;
  if (Math.abs(dv0) <= eps && Math.abs(dv1) <= eps && Math.abs(dv2) <= eps)
    return coplanarOverlap2D(A, B, n1x, n1y, n1z, sc * sc * 1e-9);
  // Schnittgerade D = n1 × n2 (normiert ⇒ t ist längenmaß)
  let Dx = n1y * n2z - n1z * n2y, Dy = n1z * n2x - n1x * n2z, Dz = n1x * n2y - n1y * n2x;
  const dl = Math.sqrt(Dx * Dx + Dy * Dy + Dz * Dz);
  if (!(dl > 1e-12)) return false;
  Dx /= dl; Dy /= dl; Dz /= dl;
  const ox = A[0], oy = A[1], oz = A[2];
  let amin = Infinity, amax = -Infinity, bmin = Infinity, bmax = -Infinity;
  // A-Kanten gegen Ebene B (Abstände dv der A-Ecken)
  for (let i = 0; i < 3; i++) {
    const j = (i + 1) % 3;
    const di = i === 0 ? dv0 : (i === 1 ? dv1 : dv2);
    const dj = j === 0 ? dv0 : (j === 1 ? dv1 : dv2);
    let px, py, pz;
    if (di === 0) { px = A[3 * i]; py = A[3 * i + 1]; pz = A[3 * i + 2]; }
    else if (dj === 0) { px = A[3 * j]; py = A[3 * j + 1]; pz = A[3 * j + 2]; }
    else if ((di > 0) !== (dj > 0)) {
      const s = di / (di - dj);
      px = A[3 * i] + s * (A[3 * j] - A[3 * i]);
      py = A[3 * i + 1] + s * (A[3 * j + 1] - A[3 * i + 1]);
      pz = A[3 * i + 2] + s * (A[3 * j + 2] - A[3 * i + 2]);
    } else continue;
    const t = (px - ox) * Dx + (py - oy) * Dy + (pz - oz) * Dz;
    if (t < amin) amin = t; if (t > amax) amax = t;
  }
  // B-Kanten gegen Ebene A (Abstände du der B-Ecken)
  for (let i = 0; i < 3; i++) {
    const j = (i + 1) % 3;
    const di = i === 0 ? du0 : (i === 1 ? du1 : du2);
    const dj = j === 0 ? du0 : (j === 1 ? du1 : du2);
    let px, py, pz;
    if (di === 0) { px = B[3 * i]; py = B[3 * i + 1]; pz = B[3 * i + 2]; }
    else if (dj === 0) { px = B[3 * j]; py = B[3 * j + 1]; pz = B[3 * j + 2]; }
    else if ((di > 0) !== (dj > 0)) {
      const s = di / (di - dj);
      px = B[3 * i] + s * (B[3 * j] - B[3 * i]);
      py = B[3 * i + 1] + s * (B[3 * j + 1] - B[3 * i + 1]);
      pz = B[3 * i + 2] + s * (B[3 * j + 2] - B[3 * i + 2]);
    } else continue;
    const t = (px - ox) * Dx + (py - oy) * Dy + (pz - oz) * Dz;
    if (t < bmin) bmin = t; if (t > bmax) bmax = t;
  }
  if (amin === Infinity || bmin === Infinity) return false;
  return !(amax < bmin || bmax < amin);
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

  // ---------- Schritt 1b: Normalisierung (robust gegen Ausreißer) ----------
  // F5: nicht-endliche Punkte und weit abseits liegende Ausreißer werden gesperrt
  //     und NICHT in die BBox der Normalisierung gerechnet.
  const bad = new Uint8Array(V);
  for (let i = 0; i < V; i++) {
    const x = orig[3 * i], y = orig[3 * i + 1], z = orig[3 * i + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) bad[i] = 1;
  }
  const Ftmp = Int32Array.from(fi);
  const { mx, my, mz, L } = robustStats(orig, V, bad, Ftmp, Fc);
  const far = new Uint8Array(V);
  const lim2 = (1e6 * L) * (1e6 * L);
  for (let i = 0; i < V; i++) {
    if (bad[i]) continue;
    const dx = orig[3 * i] - mx, dy = orig[3 * i + 1] - my, dz = orig[3 * i + 2] - mz;
    if (dx * dx + dy * dy + dz * dz > lim2) far[i] = 1;
  }
  let x0 = Infinity, y0 = Infinity, z0 = Infinity;
  let x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  let any = false;
  for (let i = 0; i < V; i++) {
    if (bad[i] || far[i]) continue;
    any = true;
    const x = orig[3 * i], y = orig[3 * i + 1], z = orig[3 * i + 2];
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
    if (z < z0) z0 = z; if (z > z1) z1 = z;
  }
  if (!any) { x0 = y0 = z0 = 0; x1 = y1 = z1 = 0; }
  const cx = (x0 + x1) * 0.5, cy = (y0 + y1) * 0.5, cz = (z0 + z1) * 0.5;
  const ex = x1 - x0, ey = y1 - y0, ez = z1 - z0;
  let scale = Math.sqrt(ex * ex + ey * ey + ez * ez);
  if (!(scale > 0) || !Number.isFinite(scale)) scale = 1;
  const P = new Float64Array(3 * V);
  for (let i = 0; i < V; i++) {
    if (bad[i]) { P[3 * i] = NaN; P[3 * i + 1] = NaN; P[3 * i + 2] = NaN; continue; }
    P[3 * i] = (orig[3 * i] - cx) / scale;
    P[3 * i + 1] = (orig[3 * i + 1] - cy) / scale;
    P[3 * i + 2] = (orig[3 * i + 2] - cz) / scale;
  }
  // Faces mit unbrauchbarem Vertex: von jeder Geometrieprüfung ausnehmen
  const faceBad = new Uint8Array(Fc);
  for (let f = 0; f < Fc; f++) {
    if (bad[Ftmp[3 * f]] || bad[Ftmp[3 * f + 1]] || bad[Ftmp[3 * f + 2]]) faceBad[f] = 1;
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
  // F5: unbrauchbare und abseits liegende Punkte bleiben unangetastet
  for (let v = 0; v < V; v++) if (bad[v] || far[v]) locked[v] = 1;
  for (let v = 0; v < V; v++) if (locked[v]) lockedVerts++;

  return { V, Fc, F, alive, vf, emap, P, orig, cx, cy, cz, scale, locked, lockedVerts, faceBad };
}

/**
 * Schritt 3: Quadriken je Vertex (Flächenebenen + Feature-Ebenen) sowie die
 * Anzahl der Feature-Kanten je Vertex (Ecken-Erkennung).
 */
function buildQuadrics(T, O) {
  const { V, Fc, F, P, emap, faceBad } = T;
  const Q = new Float64Array(10 * V);
  const fcount = new Int32Array(V);
  const fn = new Float64Array(3 * Fc);
  const fnl = new Float64Array(Fc);
  // F3a: exakte Liste der Feature-Nachbarn je Vertex (fcount = featNbr.length)
  const featNbr = new Array(V);
  for (let i = 0; i < V; i++) featNbr[i] = [];

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
    if (faceBad[f]) continue;
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
    fnl[f] = len;
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
    if (faceBad[f0] || faceBad[f1]) continue;
    if (!(fnl[f0] > 0) || !(fnl[f1] > 0)) continue;   // entartete Faces ⇒ kein Knick
    const dot = fn[3 * f0] * fn[3 * f1] + fn[3 * f0 + 1] * fn[3 * f1 + 1] + fn[3 * f0 + 2] * fn[3 * f1 + 2];
    if (dot >= cosFeat) continue;                // kein scharfer Knick
    const ex = P[3 * hi] - P[3 * lo], ey = P[3 * hi + 1] - P[3 * lo + 1], ez = P[3 * hi + 2] - P[3 * lo + 2];
    const elen2 = ex * ex + ey * ey + ez * ez;
    if (!(elen2 > 0)) continue;
    featNbr[lo].push(hi); featNbr[hi].push(lo);
    fcount[lo] = featNbr[lo].length;
    fcount[hi] = featNbr[hi].length;
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
  return { Q, fcount, featNbr };
}

/* ════════════════════════════════════════════════════════════════════════════
   H2 — Dünnwand-Wächter: Kreuzung der gegenüberliegenden Wand.

   Problem: bei dünnen Wänden (Rohr, Schale) kann die vereinfachte Fläche die
   gegenüberliegende Wand überschreiten — der lokale 2-Ring-Test sieht sie nicht.

   Der Wächter arbeitet direkt auf dem ORIGINAL-Mesh: statisches BVH über die
   Originaldreiecke (normierte Koordinaten; P0/F0 halten den Ausgangszustand
   fest, weil sich P/F während der Vereinfachung ändern).  Für jedes neue
   Ringdreieck T' eines Kollapses wird die BBox von T' im BVH abgefragt; jedes
   dort gefundene Originaldreieck O mit entgegengesetzter Normale
   (dot(n_T', n_O) < -0.2 — nur die gegenüberliegende Fläche zählt) wird mit dem
   exakten Dreieck–Dreieck-Test geprüft (T' mit aktuellen, O mit
   Originalkoordinaten).  Ein Treffer ⇒ Ablehnung (rejected.wall).
   Der Wächter wird in KEINEM Pass gelockert.
   ════════════════════════════════════════════════════════════════════════════ */

/** Quickselect: arr[lo..hi) so umsortieren, dass arr[k] der k-te Wert ist. */
function quickSelect(arr, lo, hi, k, coord) {
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    const x = coord[arr[lo]], y = coord[arr[mid]], z = coord[arr[hi - 1]];
    let pivot;
    if (x < y) pivot = (y < z) ? y : ((x < z) ? z : x);
    else pivot = (x < z) ? x : ((y < z) ? z : y);
    let i = lo, j = hi - 1;
    while (i <= j) {
      while (i < hi && coord[arr[i]] < pivot) i++;
      while (j >= lo && coord[arr[j]] > pivot) j--;
      if (i <= j) { const t = arr[i]; arr[i] = arr[j]; arr[j] = t; i++; j--; }
    }
    if (k <= j) { const nh = j + 1; if (nh >= hi) break; hi = nh; }
    else if (k >= i) { if (i <= lo) break; lo = i; }
    else return;
  }
}

/** Statisches BVH über die Dreiecke (flache typisierte Arrays, Median-Split). */
class TriBVH {
  constructor(F, P, Fc, faceBad) {
    this.F = F; this.P = P;
    let n = 0;
    for (let f = 0; f < Fc; f++) if (!faceBad[f]) n++;
    this.n = n;
    this.tri = new Int32Array(n);
    // Schwerpunkt je Dreiecks-ID (Indexierung wie die Dreiecksliste)
    this.cx = new Float64Array(Fc); this.cy = new Float64Array(Fc); this.cz = new Float64Array(Fc);
    // Einheitsnormale je Dreiecks-ID (H2: Gegen-Flächen-Erkennung)
    this.tn = new Float64Array(3 * Fc);
    let k = 0;
    for (let f = 0; f < Fc; f++) {
      if (faceBad[f]) continue;
      this.tri[k++] = f;
      const a = F[3 * f], b = F[3 * f + 1], c = F[3 * f + 2];
      this.cx[f] = (P[3 * a] + P[3 * b] + P[3 * c]) / 3;
      this.cy[f] = (P[3 * a + 1] + P[3 * b + 1] + P[3 * c + 1]) / 3;
      this.cz[f] = (P[3 * a + 2] + P[3 * b + 2] + P[3 * c + 2]) / 3;
      const ax = P[3 * a], ay = P[3 * a + 1], az = P[3 * a + 2];
      const ux = P[3 * b] - ax, uy = P[3 * b + 1] - ay, uz = P[3 * b + 2] - az;
      const vx = P[3 * c] - ax, vy = P[3 * c + 1] - ay, vz = P[3 * c + 2] - az;
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (len > 0) { this.tn[3 * f] = nx / len; this.tn[3 * f + 1] = ny / len; this.tn[3 * f + 2] = nz / len; }
    }
    const cap = 2 * n + 4;
    this.bmin = new Float64Array(3 * cap);
    this.bmax = new Float64Array(3 * cap);
    // H2: Box der Einheitsnormalen je Knoten (min/max je Komponente) — damit
    //     kann ein ganzer Teilbaum übersprungen werden, wenn in ihm kein
    //     Dreieck gegen die geprüfte Fläche zeigen kann.
    this.nb = new Float64Array(6 * cap);
    this.lc = new Int32Array(cap);      // Blatt: Start / Innen: linkes Kind
    this.rc = new Int32Array(cap);      // Blatt: Anzahl / Innen: rechtes Kind
    this.leaf = new Uint8Array(cap);    // 1 = Blatt
    this.nNodes = 1;                       // Knoten 0 = Wurzel (sonst überschreibt das erste Kind die Wurzel)
    this.stQ = new Int32Array(128);        // Stack der BBox-Abfrage (keine Allokation)
    if (n > 0) this._node(0, 0, n);
  }

  /** Knoten aufbauen (Median-Split auf der längsten Achse, Blatt ≤ 4 Dreiecke). */
  _node(node, start, count) {
    const F = this.F, P = this.P, tri = this.tri, cx = this.cx, cy = this.cy, cz = this.cz;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    // Ausdehnung der SCHWERPUNKTE (nicht der BBox): bei langen, schmalen
    // Dreiecken (Rohrwände, Nadeln) ist die BBox-Achse entartet — der Median-
    // Split auf der Schwerpunktachse bleibt dagegen räumlich sortiert.
    let c0 = Infinity, d0 = Infinity, e0 = Infinity, c1 = -Infinity, d1 = -Infinity, e1 = -Infinity;
    for (let i = start; i < start + count; i++) {
      const t = tri[i];
      for (let k = 0; k < 3; k++) {
        const v = F[3 * t + k];
        const x = P[3 * v], y = P[3 * v + 1], z = P[3 * v + 2];
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
        if (z < z0) z0 = z; if (z > z1) z1 = z;
      }
      const gx = cx[t], gy = cy[t], gz = cz[t];
      if (gx < c0) c0 = gx; if (gx > c1) c1 = gx;
      if (gy < d0) d0 = gy; if (gy > d1) d1 = gy;
      if (gz < e0) e0 = gz; if (gz > e1) e1 = gz;
    }
    const b = node * 3;
    this.bmin[b] = x0; this.bmin[b + 1] = y0; this.bmin[b + 2] = z0;
    this.bmax[b] = x1; this.bmax[b + 1] = y1; this.bmax[b + 2] = z1;
    if (count <= 4) { this.leaf[node] = 1; this.lc[node] = start; this.rc[node] = count; this._leafBox(node, start, count); return; }
    const ex = c1 - c0, ey = d1 - d0, ez = e1 - e0;
    let coord = cx, e = ex;
    if (ey > e) { coord = cy; e = ey; }
    if (ez > e) { coord = cz; e = ez; }
    const mid = start + (count >> 1);
    quickSelect(this.tri, start, start + count, mid, coord);
    const l = this.nNodes++, r = this.nNodes++;
    this.lc[node] = l; this.rc[node] = r;
    this._node(l, start, mid - start);
    this._node(r, mid, start + count - mid);
    // Normalen-Box der Kinder vereinigen
    const nb = this.nb, q = node * 6, ql = l * 6, qr = r * 6;
    for (let i = 0; i < 3; i++) {
      nb[q + 2 * i] = Math.min(nb[ql + 2 * i], nb[qr + 2 * i]);
      nb[q + 2 * i + 1] = Math.max(nb[ql + 2 * i + 1], nb[qr + 2 * i + 1]);
    }
  }

  /** Normalen-Box eines Blatts (H2: Knoten-Prüfung gegen die Gegenfläche). */
  _leafBox(node, start, count) {
    const nb = this.nb, tn = this.tn, tri = this.tri, q = node * 6;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = start; i < start + count; i++) {
      const t = tri[i];
      const x = tn[3 * t], y = tn[3 * t + 1], z = tn[3 * t + 2];
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (z < z0) z0 = z; if (z > z1) z1 = z;
    }
    nb[q] = x0; nb[q + 1] = x1; nb[q + 2] = y0; nb[q + 3] = y1; nb[q + 4] = z0; nb[q + 5] = z1;
  }

  /**
   * H2: Dreiecks-IDs, deren BVH-Knoten die angegebene BBox überlappen UND
   * deren Normale gegen die Prüffläche zeigen können (dot < -0.2).
   * Traversal mit einem expliziten typisierten Stack (keine Allokation).
   * @param {number[]} out - Scratch (Dreiecks-IDs)
   * @returns {number} Anzahl der gefundenen Dreiecke (gekappt auf out.length)
   */
  queryBox(x0, y0, z0, x1, y1, z1, nx, ny, nz, out) {
    const bmin = this.bmin, bmax = this.bmax, lc = this.lc, rc = this.rc;
    const leaf = this.leaf, tri = this.tri, st = this.stQ, nb = this.nb;
    let sp = 0, cnt = 0;
    st[sp++] = 0;
    while (sp > 0) {
      const node = st[--sp], b = node * 3;
      if (bmin[b] > x1 || bmax[b] < x0) continue;
      if (bmin[b + 1] > y1 || bmax[b + 1] < y0) continue;
      if (bmin[b + 2] > z1 || bmax[b + 2] < z0) continue;
      // Untergrenze des Skalarprodukts über die Normalen-Box des Knotens:
      // ist sie >= -0.2, kann in diesem Teilbaum kein Dreieck gegen die
      // Prüffläche zeigen ⇒ Teilbaum überspringen.
      const q = node * 6;
      const lo = (nx >= 0 ? nb[q] : nb[q + 1]) * nx
        + (ny >= 0 ? nb[q + 2] : nb[q + 3]) * ny
        + (nz >= 0 ? nb[q + 4] : nb[q + 5]) * nz;
      if (lo >= -0.2) continue;
      if (leaf[node]) {                          // Blatt: Dreiecke übernehmen
        const s0 = lc[node], c = rc[node];
        for (let i = s0; i < s0 + c; i++) {
          if (cnt >= out.length) return cnt;
          out[cnt++] = tri[i];
        }
      } else {                                    // Innen: Kinder pushen
        st[sp++] = lc[node];
        st[sp++] = rc[node];
      }
    }
    return cnt;
  }
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
  // G1: Der Produktionscode liest KEINE globalen Regler — die Optionen kommen
  //     ausschließlich aus `opts`.
  const t0 = Date.now();
  const src = mesh.faces;
  const inFaces = src.length;
  const total = inFaces - maxFaces;

  const T = prepareMesh(src);
  const { V, Fc, F, alive, vf, emap, P, orig, cx, cy, cz, scale, locked, faceBad } = T;
  const { Q, fcount, featNbr } = buildQuadrics(T, O);

  const report = {
    inFaces, outFaces: 0, collapses: 0, lockedVerts: T.lockedVerts,
    rejected: { link: 0, flip: 0, quality: 0, locked: 0, degree: 0, feature: 0, intersect: 0, wall: 0, error: 0 },
    passes: 0, ms: 0
  };
  const rej = report.rejected;
  /** N4: eine beim Einwerfen verworfene Kante zählen (Fehlerschranke überschritten). */
  function countPushSkip() {
    if (_c.reason === 3) rej.error++;
  }
  if (Fc === 0 || V === 0) {
    report.ms = Date.now() - t0;
    return { faces: [], vertices: new Float32Array(0), simplifyReport: report };
  }

  // ---------- H2: Dünnwand-Wächter vorbereiten ----------
  // Statisches BVH über die ORIGINALdreiecke (normierte Koordinaten).  P0/F0
  // halten den Ausgangszustand fest — P/F ändern sich während der
  // Vereinfachung (Positionen und Indizes).  Der Wächter vergleicht immer
  // gegen den Originalzustand.
  const useWallGuard = O.wallGuard !== false;
  const P0 = new Float64Array(3 * V);
  P0.set(P);
  const F0 = new Int32Array(3 * Fc);
  F0.set(F);
  const bvh = useWallGuard ? new TriBVH(F0, P0, Fc, faceBad) : null;

  const ver = new Int32Array(V);       // Versionszähler je Vertex (Heap-Invalidierung)
  const dead = new Uint8Array(V);      // 1 = Vertex entfernt
  // F6: Herkunft jedes Punktes (Index des Original-Vertex, -1 = berechnete Lage).
  // Damit landen Ausgabepunkte exakt auf Eingabepunkten (Ebenen/Zylinder exakt).
  const srcOf = new Int32Array(V);
  for (let v = 0; v < V; v++) srcOf[v] = v;
  const heap = new EdgeHeap(1024);
  const cosTurn = Math.cos(O.maxNormalTurnDeg * Math.PI / 180);
  const tieBreak = O.tieBreak;
  let passes = 1;                      // F4: ab Pass 3 werden Ecken-/Feature-Regeln gelockert
  const maxDegree = O.maxDegree > 0 ? O.maxDegree : 24;
  const useOptPlacement = O.placement === 'optimal';
  const checkIntersect = O.intersectionCheck !== false;

  // ---------- Schritt 4: Zielpunkt und Kosten einer Kante (a,b) ----------
  // N4: effektive Fehlerschranke = max(absolut, relativ zur BBox-Diagonale).
  //     `scale` ist die BBox-Diagonale in Eingabe-Einheiten (mm); die
  //     normalisierten Koordinaten haben die Diagonale 1.
  const diagMm = scale;
  const capAbs = O.maxErrorMm > 0 ? O.maxErrorMm : 0;
  const capRel = O.maxErrorRel > 0 ? O.maxErrorRel * diagMm : 0;
  const capHi = O.maxErrorRelMax > 0 ? O.maxErrorRelMax * diagMm : Infinity;
  const capMm = Math.min(Math.max(capAbs, capRel), capHi);
  const maxErrN = capMm > 0 ? capMm / diagMm : 0;   // normalisiert (Diagonale = 1)
  const maxErr2 = maxErrN * maxErrN;
  function edgeCost(a, b) {
    _c.reason = 0;
    const oa = a * 10, ob = b * 10;
    const q0 = Q[oa] + Q[ob], q1 = Q[oa + 1] + Q[ob + 1], q2 = Q[oa + 2] + Q[ob + 2];
    const q3 = Q[oa + 3] + Q[ob + 3], q4 = Q[oa + 4] + Q[ob + 4], q5 = Q[oa + 5] + Q[ob + 5];
    const q6 = Q[oa + 6] + Q[ob + 6], q7 = Q[oa + 7] + Q[ob + 7], q8 = Q[oa + 8] + Q[ob + 8];
    const q9 = Q[oa + 9] + Q[ob + 9];
    const tr = q0 + q4 + q7;

    // Feature-Ecken: nie verschieben, nie ineinander kollabieren.
    // F4/G2: ab Pass 3 werden NUR die Ecken-Regeln gelockert (nur der
    //     Quadrik-Term bleibt) — sonst erreicht verrauschtes Mesh sein Ziel nicht.
    const fa = fcount[a], fb = fcount[b];
    const relaxed = passes >= 3;
    const aCorner = !relaxed && (fa >= 3 || fa === 1);
    const bCorner = !relaxed && (fb >= 3 || fb === 1);
    // G2: Die F3a-Regel (Feature-Linie) wird in KEINEM Pass gelockert: Kante
    //     zwischen zwei Feature-Punkten, die selbst KEINE Feature-Kante ist,
    //     darf nicht kollabiert werden (verhindert Einschnürungen an dünnen
    //     Wänden, wo Außen- und Innenwand an einem Punkt zusammenlaufen).
    if (fa > 0 && fb > 0 && !isFeatureEdge(a, b)) { _c.skip = true; _c.reason = 2; return; }
    if (!relaxed && aCorner && bCorner) { _c.skip = true; _c.reason = 1; return; }

    const ax = P[3 * a], ay = P[3 * a + 1], az = P[3 * a + 2];
    const bx = P[3 * b], by = P[3 * b + 1], bz = P[3 * b + 2];
    const ex = bx - ax, ey = by - ay, ez = bz - az;
    const len = Math.sqrt(ex * ex + ey * ey + ez * ez);
    if (!(len > 0)) { _c.skip = true; return; }
    const mx = (ax + bx) * 0.5, my = (ay + by) * 0.5, mz = (az + bz) * 0.5;

    const errA = quadErr(q0, q1, q2, q3, q4, q5, q6, q7, q8, q9, ax, ay, az);
    const errB = quadErr(q0, q1, q2, q3, q4, q5, q6, q7, q8, q9, bx, by, bz);
    let best, tx, ty, tz, src;
    if (useOptPlacement) {
      const errM = quadErr(q0, q1, q2, q3, q4, q5, q6, q7, q8, q9, mx, my, mz);
      best = errM; tx = mx; ty = my; tz = mz; src = -1;
      if (errA < best) { best = errA; tx = ax; ty = ay; tz = az; src = a; }
      if (errB < best) { best = errB; tx = bx; ty = by; tz = bz; src = b; }
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
    } else {
      // F6 'endpoint': ausschließlich die beiden Endpunkte sind zulässig ⇒ jeder
      // Ausgabepunkt bleibt exakt ein Eingabepunkt (Ebenen/Zylinder bleiben exakt).
      if (errA <= errB) { best = errA; tx = ax; ty = ay; tz = az; src = a; }
      else { best = errB; tx = bx; ty = by; tz = bz; src = b; }
    }

    if (aCorner !== bCorner) {
      // Genau eine Ecke ⇒ Ziel MUSS deren Position sein
      if (aCorner) { tx = ax; ty = ay; tz = az; best = errA; src = a; }
      else { tx = bx; ty = by; tz = bz; best = errB; src = b; }
    } else if (useOptPlacement) {
      // Endpunkt bevorzugen (exakte Koordinaten auf Ebenen/Kanten erhalten)
      const eps = 1e-7 * len;
      const tol = tr * eps * eps;
      if (Math.min(errA, errB) <= best + tol) {
        if (errA <= errB) { tx = ax; ty = ay; tz = az; best = errA; src = a; }
        else { tx = bx; ty = by; tz = bz; best = errB; src = b; }
      }
    }
    // Fehlerschranke (normalisierte Einheiten: Diagonale = 1)
    if (maxErr2 > 0 && best > tr * maxErr2) { _c.skip = true; _c.reason = 3; return; }
    const tb = tieBreak * len;
    _c.key = best + tr * tb * tb;
    _c.tx = tx; _c.ty = ty; _c.tz = tz;
    _c.src = src;
    _c.skip = false;
    _c.reason = 0;
  }

  /** F3a: ist (a,b) eine Feature-Kante? (featNbr ist klein ⇒ linearer Scan) */
  function isFeatureEdge(a, b) {
    const L = featNbr[a];
    for (let i = 0; i < L.length; i++) if (L[i] === b) return true;
    return false;
  }

  // ---------- Schritt 5: Start-Heap (alle Kanten ungesperrter Endpunkte) ----------
  for (const [key] of emap) {
    const lo = Math.floor(key / V), hi = key - lo * V;
    if (locked[lo] || locked[hi]) continue;
    edgeCost(lo, hi);
    if (_c.skip) { countPushSkip(); continue; }
    heap.push(_c.key, lo, hi, ver[lo], ver[hi]);
  }

  // ---------- Nachbarschafts-Hilfen (ohne Allokation im heißen Loop) ----------
  const nbrS = new Int32Array(V), nbrR = new Int32Array(V);  const stampS = new Int32Array(V), stampR = new Int32Array(V);
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
  /** Lebende Faces an v — vf[v] enthält per Invariante nur lebende Faces ⇒ O(1). */
  /**
   * Exakter Grad (lebende Faces) je Vertex. Die Adjazenzlisten `vf` dürfen
   * zwischen zwei Kompaktierungen tote Faces enthalten (sie werden beim Scan
   * übersprungen) — der Grad wird deshalb separat in `deg` geführt, damit die
   * Gradformel deg(s)+deg(r)-4 unabhängig von der Listenhistorie stimmt.
   */
  const deg = new Int32Array(V);
  for (let v = 0; v < V; v++) deg[v] = vf[v].length;
  let deadEntries = 0;
  /** Entfernt alle toten Faces aus den Adjazenzlisten (amortisiert O(1)/Kollaps). */
  function compactLists() {
    for (let v = 0; v < V; v++) {
      const list = vf[v];
      let w = 0;
      for (let i = 0; i < list.length; i++) {
        const f = list[i];
        if (alive[f]) list[w++] = f;
      }
      list.length = w;
    }
    deadEntries = 0;
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
        if (_c.skip) { countPushSkip(); continue; }
        heap.push(_c.key, lo, hi, ver[lo], ver[hi]);
      }
    }
  }

  // ---------- F3b: lokale Durchdringungsprüfung ----------
  // Kandidaten sind die Faces des 2. Rings um die neue Ringfläche (alle Flächen,
  // die einen Nachbarknoten der neuen Ringdreiecke benutzen). Faces, die einen
  // Knoten mit dem geprüften Dreieck teilen, sind geometrisch benachbart und
  // werden übersprungen (wie beim exakten Prüfer des Reviewers: "0 gemeinsame
  // Punkte" zählt als echte Durchdringung).
  const _ta = new Float64Array(9), _tb = new Float64Array(9), _tpl = new Float64Array(4);
  // Obergrenze für den Grad eines Knotens, dessen Flächenliste als Kandidaten-
  // quelle abgeklappert wird (Fächer-Hubs ⇒ quadratische Zeit vermeiden).
  const MAXRINGDEG = 64;
  const candStamp = new Int32Array(Fc);
  let candEpoch = 0, candN = 0, nNew = 0;
  let cand = new Int32Array(1024);
  let candI = new Int32Array(3 * 1024);      // Knotenindizes (nach r→s-Ersetzung)
  let candP = new Float64Array(9 * 1024);    // Positionen
  let candB = new Float64Array(6 * 1024);    // BBox
  let ntI = new Int32Array(3 * 1024);       // neue Ringdreiecke: Indizes
  let ntP = new Float64Array(9 * 1024);     // neue Ringdreiecke: Positionen

  function growScratch() {
    const n = cand.length * 2;
    let t = new Int32Array(n); t.set(cand); cand = t;
    t = new Int32Array(3 * n); t.set(candI); candI = t;
    t = new Float64Array(9 * n); t.set(candP); candP = t;
    t = new Float64Array(6 * n); t.set(candB); candB = t;
    t = new Int32Array(3 * n); t.set(ntI); ntI = t;
    t = new Float64Array(9 * n); t.set(ntP); ntP = t;
  }

  /**
   * Neue Ringdreiecke bestimmen (s→t bzw. r→s).  Sie werden sowohl vom
   * Dünnwand-Wächter (G3) als auch von der Durchdringungsprüfung (F3b) genutzt.
   * @returns {number} Anzahl der neuen Ringdreiecke
   */
  function buildRing(s, r, f1, f2, tx, ty, tz) {
    nNew = 0;
    for (let ring = 0; ring < 2; ring++) {
      const list = ring === 0 ? vf[s] : vf[r];
      for (let i = 0; i < list.length; i++) {
        const f = list[i];
        if (!alive[f] || f === f1 || f === f2 || faceBad[f]) continue;
        if (nNew * 3 + 3 > ntI.length) growScratch();
        const g0 = F[3 * f], g1 = F[3 * f + 1], g2 = F[3 * f + 2];
        const i0 = (g0 === s || g0 === r) ? s : g0;
        const i1 = (g1 === s || g1 === r) ? s : g1;
        const i2 = (g2 === s || g2 === r) ? s : g2;
        const o = nNew * 3, po = nNew * 9;
        ntI[o] = i0; ntI[o + 1] = i1; ntI[o + 2] = i2;
        const ax = i0 === s ? tx : P[3 * i0], ay = i0 === s ? ty : P[3 * i0 + 1], az = i0 === s ? tz : P[3 * i0 + 2];
        const bx = i1 === s ? tx : P[3 * i1], by = i1 === s ? ty : P[3 * i1 + 1], bz = i1 === s ? tz : P[3 * i1 + 2];
        const cx = i2 === s ? tx : P[3 * i2], cy = i2 === s ? ty : P[3 * i2 + 1], cz = i2 === s ? tz : P[3 * i2 + 2];
        ntP[po] = ax; ntP[po + 1] = ay; ntP[po + 2] = az;
        ntP[po + 3] = bx; ntP[po + 4] = by; ntP[po + 5] = bz;
        ntP[po + 6] = cx; ntP[po + 7] = cy; ntP[po + 8] = cz;
        nNew++;
      }
    }
    return nNew;
  }

  // ---------- H2: Dünnwand-Wächter (Kreuzung der gegenüberliegenden Wand) ----------
  // Scratch: T' (aktuelle Koordinaten), O (Originalkoordinaten), BVH-Treffer.
  const _wt = new Float64Array(9), _wo = new Float64Array(9);
  let _wq = new Int32Array(2048);

  /** BVH-BBox-Abfrage; vergrößert den Scratch, falls sehr viele Dreiecke treffen. */
  function wallQuery(x0, y0, z0, x1, y1, z1, nx, ny, nz) {
    let cnt = bvh.queryBox(x0, y0, z0, x1, y1, z1, nx, ny, nz, _wq);
    if (cnt >= _wq.length) {
      const bigger = new Int32Array(_wq.length * 4);
      cnt = bvh.queryBox(x0, y0, z0, x1, y1, z1, nx, ny, nz, bigger);
      _wq = bigger;
    }
    return cnt;
  }

  /**
   * H2: Schneidet eines der neuen Ringdreiecke die gegenüberliegende Wand?
   * Geprüft wird gegen das ORIGINAL-Mesh (P0/F0 im statischen BVH): es zählen
   * nur Dreiecke mit entgegengesetzter Normale (dot < -0.2 — gleiche Fläche
   * oder quer zur Wand sind unkritisch) und ohne gemeinsamen Vertexindex.
   * @returns {boolean} true, wenn die Gegenwand geschnitten würde
   */
  function wallCrosses() {
    if (!nNew) return false;
    for (let k = 0; k < nNew; k++) {
      const po = k * 9, o = k * 3;
      const i0 = ntI[o], i1 = ntI[o + 1], i2 = ntI[o + 2];
      const ax = ntP[po], ay = ntP[po + 1], az = ntP[po + 2];
      const bx = ntP[po + 3], by = ntP[po + 4], bz = ntP[po + 5];
      const cx = ntP[po + 6], cy = ntP[po + 7], cz = ntP[po + 8];
      const ux = bx - ax, uy = by - ay, uz = bz - az;
      const vx = cx - ax, vy = cy - ay, vz = cz - az;
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (!(nl > 0)) continue;                     // entartetes Dreieck
      nx /= nl; ny /= nl; nz /= nl;
      const dp = -(nx * ax + ny * ay + nz * az);  // Ebene von T' (N3)
      // BBox von T' (expandiert)
      let x0 = ax, x1 = ax, y0 = ay, y1 = ay, z0 = az, z1 = az;
      if (bx < x0) x0 = bx; if (cx < x0) x0 = cx;
      if (bx > x1) x1 = bx; if (cx > x1) x1 = cx;
      if (by < y0) y0 = by; if (cy < y0) y0 = cy;
      if (by > y1) y1 = by; if (cy > y1) y1 = cy;
      if (bz < z0) z0 = bz; if (cz < z0) z0 = cz;
      if (bz > z1) z1 = bz; if (cz > z1) z1 = cz;
      const e = 1e-12;
      const cnt = wallQuery(x0 - e, y0 - e, z0 - e, x1 + e, y1 + e, z1 + e, nx, ny, nz);
      if (!cnt) continue;
      _wt[0] = ax; _wt[1] = ay; _wt[2] = az;
      _wt[3] = bx; _wt[4] = by; _wt[5] = bz;
      _wt[6] = cx; _wt[7] = cy; _wt[8] = cz;
      for (let q = 0; q < cnt; q++) {
        const of = _wq[q];
        // Nur entgegengesetzte Flächen zählen (gleiche Fläche / Querwand egal)
        const onx = bvh.tn[3 * of], ony = bvh.tn[3 * of + 1], onz = bvh.tn[3 * of + 2];
        if (nx * onx + ny * ony + nz * onz >= -0.2) continue;
        const oa = F0[3 * of], ob = F0[3 * of + 1], oc = F0[3 * of + 2];
        if (oa === i0 || oa === i1 || oa === i2) continue;
        if (ob === i0 || ob === i1 || ob === i2) continue;
        if (oc === i0 || oc === i1 || oc === i2) continue;
        const oax = P0[3 * oa], oay = P0[3 * oa + 1], oaz = P0[3 * oa + 2];
        const obx = P0[3 * ob], oby = P0[3 * ob + 1], obz = P0[3 * ob + 2];
        const ocx = P0[3 * oc], ocy = P0[3 * oc + 1], ocz = P0[3 * oc + 2];
        // N3: Ebenengleiche Gegenflächen sind KEINE Kreuzung. Zwei Körper, die
        //     sich flächig berühren (verschiedene Dreiecksgitter!), erzeugen
        //     ebengleiche, entgegengesetzt orientierte Flächen — der Wächter
        //     zählte sie bisher als Durchdringung (coplanarOverlap2D) und
        //     blockierte damit jeden Kollaps in der Nähe der Berührungsfläche.
        //     Zählt nur, was die Ebenen wirklich kreuzt.
        const od = -(onx * oax + ony * oay + onz * oaz);
        const d0 = nx * oax + ny * oay + nz * oaz + dp;   // Abstand der Original-Ecken zu Ebene(T')
        const d1 = nx * obx + ny * oby + nz * obz + dp;
        const d2 = nx * ocx + ny * ocy + nz * ocz + dp;
        const e0 = onx * ax + ony * ay + onz * az + od;   // Abstand der T'-Ecken zu Ebene(Original)
        const e1 = onx * bx + ony * by + onz * bz + od;
        const e2 = onx * cx + ony * cy + onz * cz + od;
        const sc = Math.max(
          Math.abs(bx - ax), Math.abs(by - ay), Math.abs(bz - az),
          Math.abs(cx - ax), Math.abs(cy - ay), Math.abs(cz - az),
          Math.abs(obx - oax), Math.abs(oby - oay), Math.abs(obz - oaz),
          Math.abs(ocx - oax), Math.abs(ocy - oay), Math.abs(ocz - oaz));
        const eps = sc * 1e-8 + 1e-12;                   // "dieselbe Ebene" (normiert: Diagonale = 1)
        if (Math.abs(d0) <= eps && Math.abs(d1) <= eps && Math.abs(d2) <= eps &&
            Math.abs(e0) <= eps && Math.abs(e1) <= eps && Math.abs(e2) <= eps) continue;
        _wo[0] = oax; _wo[1] = oay; _wo[2] = oaz;
        _wo[3] = obx; _wo[4] = oby; _wo[5] = obz;
        _wo[6] = ocx; _wo[7] = ocy; _wo[8] = ocz;
        if (triTriOverlap(_wt, _wo, null)) return true;
      }
    }
    return false;
  }

  /**
   * Prüft alle neuen Ringdreiecke (s→t bzw. r→s) gegen den 2. Ring.
   * @returns {boolean} true, wenn eine echte Durchdringung droht
   */
  function ringIntersects(s, r, tx, ty, tz) {
    if (!nNew) return false;
    // ---- 2. Kandidaten (2. Ring) sammeln ----
    // Fan-Knoten (Grad tausende, z.B. per Ear-Clipping abgetastete Deckflächen)
    // würden das Einsammeln quadratisch verteuern. Ihre Flächen liegen ohnehin
    // alle am Ring (sie teilen den Knoten) und werden vom gemeinsamen Knoten-Test
    // ohnehin übersprungen ⇒ Hub-Knoten werden gar nicht erst abgeklappert.
    candEpoch++; candN = 0;
    for (let k = 0; k < nNew; k++) {
      const o = k * 3;
      for (let vv = 0; vv < 3; vv++) {
        const v = ntI[o + vv];
        if (v === s) continue;
        const vl = vf[v];
        if (vl.length > MAXRINGDEG) continue;
        for (let j = 0; j < vl.length; j++) {
          const g = vl[j];
          if (!alive[g] || faceBad[g]) continue;
          if (candStamp[g] === candEpoch) continue;
          candStamp[g] = candEpoch;
          if (candN >= cand.length) growScratch();
          cand[candN++] = g;
        }
      }
    }
    if (!candN) return false;
    // ---- 3. Kandidaten-Daten einmal vorberechnen ----
    for (let c = 0; c < candN; c++) {
      const g = cand[c];
      const ga = F[3 * g], gb = F[3 * g + 1], gc = F[3 * g + 2];
      const qa = ga === r ? s : ga, qb = gb === r ? s : gb, qc = gc === r ? s : gc;
      const o = c * 3, po = c * 9, bo = c * 6;
      candI[o] = qa; candI[o + 1] = qb; candI[o + 2] = qc;
      const pax = qa === s ? tx : P[3 * qa], pay = qa === s ? ty : P[3 * qa + 1], paz = qa === s ? tz : P[3 * qa + 2];
      const pbx = qb === s ? tx : P[3 * qb], pby = qb === s ? ty : P[3 * qb + 1], pbz = qb === s ? tz : P[3 * qb + 2];
      const pcx = qc === s ? tx : P[3 * qc], pcy = qc === s ? ty : P[3 * qc + 1], pcz = qc === s ? tz : P[3 * qc + 2];
      candP[po] = pax; candP[po + 1] = pay; candP[po + 2] = paz;
      candP[po + 3] = pbx; candP[po + 4] = pby; candP[po + 5] = pbz;
      candP[po + 6] = pcx; candP[po + 7] = pcy; candP[po + 8] = pcz;
      let mnx = pax, mxx = pax, mny = pay, mxy = pay, mnz = paz, mxz = paz;
      if (pbx < mnx) mnx = pbx; if (pcx < mnx) mnx = pcx;
      if (pbx > mxx) mxx = pbx; if (pcx > mxx) mxx = pcx;
      if (pby < mny) mny = pby; if (pcy < mny) mny = pcy;
      if (pby > mxy) mxy = pby; if (pcy > mxy) mxy = pcy;
      if (pbz < mnz) mnz = pbz; if (pcz < mnz) mnz = pcz;
      if (pbz > mxz) mxz = pbz; if (pcz > mxz) mxz = pcz;
      candB[bo] = mnx; candB[bo + 1] = mny; candB[bo + 2] = mnz;
      candB[bo + 3] = mxx; candB[bo + 4] = mxy; candB[bo + 5] = mxz;
    }
    // ---- 4. jedes neue Ringdreieck gegen die Kandidaten prüfen ----
    for (let k = 0; k < nNew; k++) {
      const o = k * 3, po = k * 9;
      const i0 = ntI[o], i1 = ntI[o + 1], i2 = ntI[o + 2];
      const ax = ntP[po], ay = ntP[po + 1], az = ntP[po + 2];
      const bx = ntP[po + 3], by = ntP[po + 4], bz = ntP[po + 5];
      const cx = ntP[po + 6], cy = ntP[po + 7], cz = ntP[po + 8];
      const ux = bx - ax, uy = by - ay, uz = bz - az;
      const vx = cx - ax, vy = cy - ay, vz = cz - az;
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (!(nl > 0)) continue;                       // entartetes Dreieck
      nx /= nl; ny /= nl; nz /= nl;
      const dp = -(nx * ax + ny * ay + nz * az);
      let tlox = ax, thix = ax, tloy = ay, thiy = ay, tloz = az, thiz = az;
      if (bx < tlox) tlox = bx; if (cx < tlox) tlox = cx;
      if (bx > thix) thix = bx; if (cx > thix) thix = cx;
      if (by < tloy) tloy = by; if (cy < tloy) tloy = cy;
      if (by > thiy) thiy = by; if (cy > thiy) thiy = cy;
      if (bz < tloz) tloz = bz; if (cz < tloz) tloz = cz;
      if (bz > thiz) thiz = bz; if (cz > thiz) thiz = cz;
      for (let c = 0; c < candN; c++) {
        const co = c * 3;
        const qa = candI[co], qb = candI[co + 1], qc = candI[co + 2];
        if (qa === i0 || qa === i1 || qa === i2) continue;
        if (qb === i0 || qb === i1 || qb === i2) continue;
        if (qc === i0 || qc === i1 || qc === i2) continue;
        const bo = c * 6;
        if (candB[bo] > thix || candB[bo + 3] < tlox) continue;
        if (candB[bo + 1] > thiy || candB[bo + 4] < tloy) continue;
        if (candB[bo + 2] > thiz || candB[bo + 5] < tloz) continue;
        const cp = c * 9;
        // Ebenen-Halbraum-Test (billig, schließt die meisten Kandidaten aus)
        const d0 = nx * candP[cp] + ny * candP[cp + 1] + nz * candP[cp + 2] + dp;
        const d1 = nx * candP[cp + 3] + ny * candP[cp + 4] + nz * candP[cp + 5] + dp;
        const d2 = nx * candP[cp + 6] + ny * candP[cp + 7] + nz * candP[cp + 8] + dp;
        if ((d0 > 0 && d1 > 0 && d2 > 0) || (d0 < 0 && d1 < 0 && d2 < 0)) continue;
        _tpl[0] = nx; _tpl[1] = ny; _tpl[2] = nz; _tpl[3] = dp;
        _ta[0] = ax; _ta[1] = ay; _ta[2] = az;
        _ta[3] = bx; _ta[4] = by; _ta[5] = bz;
        _ta[6] = cx; _ta[7] = cy; _ta[8] = cz;
        _tb[0] = candP[cp]; _tb[1] = candP[cp + 1]; _tb[2] = candP[cp + 2];
        _tb[3] = candP[cp + 3]; _tb[4] = candP[cp + 4]; _tb[5] = candP[cp + 5];
        _tb[6] = candP[cp + 6]; _tb[7] = candP[cp + 7]; _tb[8] = candP[cp + 8];
        if (triTriOverlap(_ta, _tb, _tpl)) return true;
      }
    }
    return false;
  }

  // ---------- Schritt 6+7: Kollaps-Schleife ----------
  let aliveFaces = Fc;
  let collapses = 0;
  let removed = 0;
  let passCollapses = 0;
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
    if (_c.skip) { if (_c.reason === 2) rej.feature++; else if (_c.reason === 3) rej.error++; continue; }
    const tx = _c.tx, ty = _c.ty, tz = _c.tz;
    // Rolle: Überlebender = der Endpunkt, dessen Position behalten wird
    const s = (tx === P[3 * b] && ty === P[3 * b + 1] && tz === P[3 * b + 2]) ? b : a;
    const r = s === a ? b : a;
    if (locked[s] || locked[r]) { rej.locked++; continue; }

    // --- F2: Grad-Grenze (vor jeder teuren Prüfung, O(1)) ---
    // vf enthält nur lebende Faces ⇒ newDeg = deg(s)+deg(r)-4 nach dem Kollaps.
    // degLimit verdoppelt sich je Pass, damit Hubs in späteren Passen doch schrumpfen.
    const degLimit = maxDegree * (1 << (passes - 1));
    if (deg[s] + deg[r] - 4 > degLimit) { rej.degree++; continue; }

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
    if (deg[cv] < 4 || deg[dv] < 4 || degS + degR - 4 < 3) { rej.link++; continue; }

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
        const ow = cx - bx, ox2 = cy - by, oz2 = cz - bz;
        const osum = (oux * oux + ouy * ouy + ouz * ouz) + (ovx * ovx + ovy * ovy + ovz * ovz)
          + (ow * ow + ox2 * ox2 + oz2 * oz2);
        // neue Normale
        const nux = nbx - nax, nuy = nby - nay, nuz = nbz - naz;
        const nvx = ncx - nax, nvy = ncy - nay, nvz = ncz - naz;
        const nnx = nuy * nvz - nuz * nvy, nny = nuz * nvx - nux * nvz, nnz = nux * nvy - nuy * nvx;
        const nlen = Math.sqrt(nnx * nnx + nny * nny + nnz * nnz);
        const nw = ncx - nbx, nx2 = ncy - nby, nz2 = ncz - nbz;
        const nsum = (nux * nux + nuy * nuy + nuz * nuz) + (nvx * nvx + nvy * nvy + nvz * nvz)
          + (nw * nw + nx2 * nx2 + nz2 * nz2);
        // F5: Entartung skalenfrei prüfen (|cross| <= 1e-10 * (l0²+l1²+l2²))
        if (!(nlen > 1e-10 * nsum)) { flipBad = true; break; }
        // alte Normale ebenfalls skalenfrei: entartetes altes Dreieck ⇒ keine Drehprüfung
        if (olen > 1e-10 * osum) {
          const dp = (onx * nnx + ony * nny + onz * nnz) / (olen * nlen);
          if (dp < cosTurn) { flipBad = true; break; }
        }
        qNew[nq++] = triQuality(nax, nay, naz, nbx, nby, nbz, ncx, ncy, ncz);
      }
    }
    if (flipBad) { rej.flip++; continue; }
    // F1: multiplikative Toleranz — ein Kollaps, der den schlechtesten alten
    //     Splitter kongruent neu bildet, liegt nur wenige ULP tiefer.
    const thr = Math.min(O.minQuality, qMinOld) * (O.qTol ?? 0.999);
    let qBad = false;
    for (let i = 0; i < nq; i++) if (qNew[i] < thr) { qBad = true; break; }
    if (qBad) { rej.quality++; continue; }

    // ---------- neue Ringdreiecke (H2-Wächter und F3b-Prüfung) ----------
    if (checkIntersect || useWallGuard) buildRing(s, r, f1, f2, tx, ty, tz);

    // ---------- H2: Dünnwand-Wächter (in keinem Pass gelockert) ----------
    // Die neuen Ringdreiecke dürfen die gegenüberliegende Wand des
    // ORIGINAL-Meshes nicht schneiden.
    if (useWallGuard && wallCrosses()) { rej.wall++; continue; }

    // ---------- F3b: lokale Durchdringungsprüfung ----------
    if (checkIntersect && ringIntersects(s, r, tx, ty, tz)) { rej.intersect++; continue; }

    // ---------- Schritt 7: Kollaps r → s an Position t ----------
    const sx = P[3 * s], sy = P[3 * s + 1], sz = P[3 * s + 2];
    const sMoved = (tx !== sx || ty !== sy || tz !== sz);
    if (sMoved) {
      // F6: exakte Herkunft des neuen Punktes mitführen
      srcOf[s] = (_c.src >= 0 && srcOf[_c.src] >= 0) ? srcOf[_c.src] : -1;
    }
    P[3 * s] = tx; P[3 * s + 1] = ty; P[3 * s + 2] = tz;
    const os = s * 10, orr = r * 10;
    for (let i = 0; i < 10; i++) Q[os + i] += Q[orr + i];
    ver[s]++;
    dead[r] = 1;
    // die 2 Kantenfaces töten (die Listen werden erst beim Kompaktieren bereinigt)
    alive[f1] = 0; alive[f2] = 0;
    deg[s] -= 2; deg[r] = 0; deg[cv] -= 1; deg[dv] -= 1;
    deadEntries += 4;
    // übrige Faces von r auf s umhängen
    const vr2 = vf[r];
    let moved = 0;
    for (let i = 0; i < vr2.length; i++) {
      const f = vr2[i];
      if (!alive[f]) continue;
      if (F[3 * f] === r) F[3 * f] = s;
      else if (F[3 * f + 1] === r) F[3 * f + 1] = s;
      else F[3 * f + 2] = s;
      vf[s].push(f);
      moved++;
    }
    vf[r] = [];
    deg[s] += moved;
    // F3a: Feature-Nachbarn übernehmen — exakt, keine Duplikate.
    //   featNbr[r] → featNbr[s] (u ≠ s), in featNbr[u] wird r durch s ersetzt.
    const fr = featNbr[r], fs = featNbr[s];
    for (let i = fs.length - 1; i >= 0; i--) if (fs[i] === r) { fs.splice(i, 1); break; }
    for (let i = 0; i < fr.length; i++) {
      const u = fr[i];
      if (u === s) continue;
      let dup = false;
      for (let j = 0; j < fs.length; j++) if (fs[j] === u) { dup = true; break; }
      if (!dup) fs.push(u);
      const fu = featNbr[u];
      let hasS = false;
      for (let j = 0; j < fu.length; j++) if (fu[j] === s) { hasS = true; break; }
      if (!hasS) {
        for (let j = 0; j < fu.length; j++) if (fu[j] === r) { fu[j] = s; break; }
      }
      fcount[u] = fu.length;
    }
    featNbr[r] = [];
    fcount[s] = fs.length;
    // Kanten (s,u) neu einwerfen — F2: nur wenn der Grad unter der Grenze bleibt
    const ns = collectS(s);
    for (let i = 0; i < ns; i++) {
      const u = nbrS[i];
      if (dead[u] || locked[u]) continue;
      if (deg[s] + deg[u] - 4 > degLimit) continue;
      const lo = s < u ? s : u, hi = s < u ? u : s;
      edgeCost(lo, hi);
      if (_c.skip) { countPushSkip(); continue; }
      heap.push(_c.key, lo, hi, ver[lo], ver[hi]);
    }
    aliveFaces -= 2;
    // tote Einträge in den Adjazenzlisten gelegentlich aufräumen (amortisiert O(1))
    if (deadEntries > (aliveFaces >> 2)) compactLists();
    collapses++; passCollapses++; removed += 2;
    if (progressCb && removed >= nextProg) {
      progressCb({ processed: removed, total, phase: 'simplify' });
      nextProg += progStep;
    }
  }

  // ---------- Ausgabe: alle lebenden Faces, exakte Koordinaten für unveränderte Vertices ----------
  const OUT = new Float64Array(3 * V);
  for (let v = 0; v < V; v++) {
    const sv = srcOf[v];
    if (sv >= 0) {
      // F6: exakter Originalpunkt (Ebenen/Zylinder bleiben exakt planar)
      OUT[3 * v] = orig[3 * sv];
      OUT[3 * v + 1] = orig[3 * sv + 1];
      OUT[3 * v + 2] = orig[3 * sv + 2];
    } else {
      OUT[3 * v] = P[3 * v] * scale + cx;
      OUT[3 * v + 1] = P[3 * v + 1] * scale + cy;
      OUT[3 * v + 2] = P[3 * v + 2] * scale + cz;
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

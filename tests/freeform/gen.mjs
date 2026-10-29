// ─────────────────────────────────────────────────────────────────────────────
// tests/freeform/gen.mjs — synthetische Testkörper für den Freiform-Pfad (Etappe 1).
//
// Erzeugt geschlossene, mannigfaltige Netze (binäre STL) aus ANALYTISCH bekannten
// Körpern — damit der Freiform-Pfad gegen eine exakte Soll-Geometrie geprüft werden
// kann (Flächenzahl je Typ, Volumen).
//
// Körper:
//   ff_rundquader_r1.stl             Quader 20×14×10, ALLE 12 Kanten und 8 Ecken mit
//                                    r = 1 verrundet (Rollkugel): 6 Ebenen (um r
//                                    eingerückt), 12 Viertelzylinder, 8 Kugeloktanten.
//   ff_platte_loch_torus.stl         Platte 30×20×5 mit Durchgangsbohrung R4 um die
//                                    z-Achse; obere Mündung mit r = 0,5 verrundet
//                                    (Torus Rm 4,5 / r 0,5, Mitte (0,0,4,5)), unten scharf.
//   ff_halbkugel_zylinder.stl         Zylinder R5 (z = 0…10) + Halbkugel R5 (Mitte (0,0,10)),
//                                    48 Segmente, 12 Breitenringe, Polfächer.
//   je dazu eine GEDREHTE Variante: 37° um norm(1,2,3) + Verschiebung (12.5,−7.25,3.125).
//
// Bauweise: jeder Körper entsteht aus einem Pool gemeinsamer Punkte — Punkte auf
// gemeinsamen Grenzen werden NUR EINMAL berechnet (identische Float32-Werte) →
// keine T-Knoten, jede Kante genau 2×, gegenläufig. Die Oktanten nutzen als
// Randbögen GENAU die Bogenpunkte der benachbarten Viertelzylinder (Winkel i·90°/N),
// die Innenpunkte das normalisierte baryzentrische Gitter.
//
// Aufruf:  node tests/freeform/gen.mjs [zielordner]   (Default: tests/freeform/stl)
// Prüfung: node tests/freeform/gen.test.mjs             (Manifold/Volumen/Topologie)
// ─────────────────────────────────────────────────────────────────────────────
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';

const PI = Math.PI;
const D2R = PI / 180;

// ── Vektorhilfen ─────────────────────────────────────────────────────────────
const add3 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul3 = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm3 = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

// ── Punkt-Pool: gleiche Koordinaten → gleicher Punkt (Float32-Genauigkeit) ───
class Pool {
  constructor() { this.map = new Map(); }
  get(x, y, z) {
    const X = Math.fround(x), Y = Math.fround(y), Z = Math.fround(z);
    const k = `${X},${Y},${Z}`;
    let p = this.map.get(k);
    if (!p) { p = [X, Y, Z]; this.map.set(k, p); }
    return p;
  }
}

// ── Netz-Bauer: Dreiecke mit gewünschter Außen-Normale ──────────────────────
class Builder {
  constructor(pool) { this.pool = pool; this.tris = []; }
  // outward: Vektor oder Funktion (Zentroid) → Vektor
  tri(a, b, c, outward) {
    const o = typeof outward === 'function'
      ? outward([(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3])
      : outward;
    const n = cross3([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - a[0], c[1] - a[1], c[2] - a[2]]);
    const d = n[0] * o[0] + n[1] * o[1] + n[2] * o[2];
    this.tris.push(d < 0 ? [a, c, b] : [a, b, c]);
  }
}

// ── Rundquader: Rollkugel r an allen Kanten und Ecken ───────────────────────
// Aussenbox [0,a]×[0,b]×[0,c]; Innenbox [r,a−r]×[r,b−r]×[r,c−r]. Die Ebenen liegen
// um r eingerückt, die Kanten sind Viertelzylinder (r) um die Innenkante, die Ecken
// Kugeloktanten (r) um die Innenecke.
function buildRoundedBox({ a, b, c, r, N }) {
  const pool = new Pool();
  const mb = new Builder(pool);
  const lo = [r, r, r];
  const hi = [a - r, b - r, c - r];

  // Ebenen (6): Rechteck um r eingerückt, 2 Dreiecke
  for (let k = 0; k < 3; k++) {
    const u = (k + 1) % 3, v = (k + 2) % 3;
    for (const s of [0, 1]) {
      const p = s ? hi[k] + r : lo[k] - r;
      const n = [0, 0, 0]; n[k] = s ? 1 : -1;
      const corner = (uu, vv) => {
        const P = [0, 0, 0]; P[k] = p; P[u] = uu; P[v] = vv;
        return pool.get(P[0], P[1], P[2]);
      };
      const c00 = corner(lo[u], lo[v]), c10 = corner(hi[u], lo[v]);
      const c11 = corner(hi[u], hi[v]), c01 = corner(lo[u], hi[v]);
      mb.tri(c00, c10, c11, n);
      mb.tri(c00, c11, c01, n);
    }
  }

  // Kanten (12): Viertelzylinder um die Innenkante; Bogenpunkte A + r(cos α·n1 + sin α·n2)
  // (n1, n2 in zyklischer Achsenfolge: x→y, y→z, z→x) — die langen Kanten sind je
  // EINE Strecke von Ecke zu Ecke.
  for (let k = 0; k < 3; k++) {
    const u = (k + 1) % 3, v = (k + 2) % 3;
    for (const su of [0, 1]) for (const sv of [0, 1]) {
      const pu = su ? hi[u] : lo[u], pv = sv ? hi[v] : lo[v];
      const n1 = [0, 0, 0]; n1[u] = su ? 1 : -1;
      const n2 = [0, 0, 0]; n2[v] = sv ? 1 : -1;
      const arcAt = (end, i) => {
        const al = (i / N) * (PI / 2);
        const cs = Math.cos(al), sn = Math.sin(al);
        const P = [0, 0, 0];
        P[u] = pu; P[v] = pv; P[k] = end ? hi[k] : lo[k];
        return pool.get(
          P[0] + r * (cs * n1[0] + sn * n2[0]),
          P[1] + r * (cs * n1[1] + sn * n2[1]),
          P[2] + r * (cs * n1[2] + sn * n2[2]));
      };
      for (let i = 0; i < N; i++) {
        const a0 = arcAt(false, i), a1 = arcAt(false, i + 1);
        const b0 = arcAt(true, i), b1 = arcAt(true, i + 1);
        const am = ((i + 0.5) / N) * (PI / 2);
        const out = add3(mul3(n1, Math.cos(am)), mul3(n2, Math.sin(am)));
        mb.tri(a0, a1, b1, out);
        mb.tri(a0, b1, b0, out);
      }
    }
  }

  // Ecken (8): Kugeloktant, Dreiecksgitter (baryzentrisch, Ordnung N). Die drei
  // Randbögen nutzen GENAU die Bogenpunkte der drei benachbarten Viertelzylinder
  // (Winkel i·90°/N); die Innenpunkte kommen aus dem normalisierten Baryzentrischen.
  for (const sx of [0, 1]) for (const sy of [0, 1]) for (const sz of [0, 1]) {
    const C = [sx ? hi[0] : lo[0], sy ? hi[1] : lo[1], sz ? hi[2] : lo[2]];
    const d = [[sx ? 1 : -1, 0, 0], [0, sy ? 1 : -1, 0], [0, 0, sz ? 1 : -1]];
    const L = new Map();
    for (let i = 0; i <= N; i++) for (let j = 0; i + j <= N; j++) {
      const k = N - i - j;
      let dir;
      if (k === 0) {                     // Bogen d_x → d_y (Kante entlang z)
        const t = (j / N) * (PI / 2);
        dir = add3(mul3(d[0], Math.cos(t)), mul3(d[1], Math.sin(t)));
      } else if (i === 0) {              // Bogen d_y → d_z (Kante entlang x)
        const t = (k / N) * (PI / 2);
        dir = add3(mul3(d[1], Math.cos(t)), mul3(d[2], Math.sin(t)));
      } else if (j === 0) {              // Bogen d_z → d_x (Kante entlang y)
        const t = (i / N) * (PI / 2);
        dir = add3(mul3(d[2], Math.cos(t)), mul3(d[0], Math.sin(t)));
      } else {                           // Innenpunkt: baryzentrisch, normiert
        dir = norm3(add3(add3(mul3(d[0], i), mul3(d[1], j)), mul3(d[2], k)));
      }
      L.set(`${i},${j},${k}`, pool.get(C[0] + r * dir[0], C[1] + r * dir[1], C[2] + r * dir[2]));
    }
    const P = (i, j, k) => L.get(`${i},${j},${k}`);
    const radial = (p) => [p[0] - C[0], p[1] - C[1], p[2] - C[2]];
    // aufwärts gerichtete Gitterdreiecke
    for (let i = 0; i <= N - 1; i++) for (let j = 0; i + j <= N - 1; j++) {
      const k = N - 1 - i - j;
      mb.tri(P(i + 1, j, k), P(i, j + 1, k), P(i, j, k + 1), (cen) => radial(cen));
    }
    // abwärts gerichtete Gitterdreiecke
    for (let i = 0; i <= N - 2; i++) for (let j = 0; i + j <= N - 2; j++) {
      const k = N - 2 - i - j;
      mb.tri(P(i + 1, j + 1, k), P(i + 1, j, k + 1), P(i, j + 1, k + 1), (cen) => radial(cen));
    }
  }
  return mb.tris;
}

// ── Platte mit Durchgangsbohrung und verrundeter oberer Mündung ─────────────
// Rechteck [−15,15]×[−10,10]×[0,5], Bohrung R4 um z; obere Mündung mit r = 0,5
// verrundet (Torus: Mitte (0,0,4,5), Rm 4,5, r 0,5; Rohr in der Ebene z = 4,5,
// Öffnung R4,5 in der Deckfläche z = 5). Unten scharf.
const PLATE = { x0: -15, x1: 15, y0: -10, y1: 10, z0: 0, z1: 5, Rh: 4, r: 0.5, Rm: 4.5, zm: 4.5, seg: 48, tube: 8 };

// Ring zwischen Innenpolygon (48-gon, Radius Rin) und Rechteck: je Rechteckecke ein
// Fächer über den von der Ecke aus SICHTBAREN Teil des Innenrings (Tangentenwinkel
// acos(Rin/|Ecke|)); der Übergang zwischen zwei Fächern schließt das Dreieck
// (Ecke, Ecke, Innenpunkt). Äußerer Rand sind NUR die 4 Rechteckecken → keine
// T-Knoten zu den Seitenflächen.
function ringToRect(mb, inner, corners, outward, Rin) {
  const n = inner.length;
  const step = 2 * PI / n;                       // Winkelabstand der Innenpunkte (rad)
  const cs = corners.slice().sort((A, B) => A.angle - B.angle);
  const m = cs.length;
  const delta = cs.map((c) => Math.acos(Math.min(1, Rin / Math.hypot(c.p[0], c.p[1]))));
  const idx = (j) => inner[((j % n) + n) % n];
  for (let k = 0; k < m; k++) {
    const k1 = (k + 1) % m;
    const A = cs[k].p, B = cs[k1].p;
    const aA = cs[k].angle;
    const aB = cs[k1].angle + (k1 === 0 ? 2 * PI : 0);
    const j0 = Math.ceil(aA / step - 1e-9);      // erster Innenpunkt im Sektor
    const j1 = Math.ceil(aB / step - 1e-9);      // erster Innenpunkt nach dem Sektor
    // Split: letzter Punkt, den A noch sieht — ab da übernimmt B
    let jm = Math.floor((aA + delta[k]) / step);
    const jmin = Math.ceil((aB - delta[k1]) / step) - 1;
    if (jm < jmin) jm = jmin;
    if (jm < j0) jm = j0;
    if (jm > j1 - 1) jm = j1 - 1;
    for (let j = jm; j > j0; j--) mb.tri(A, idx(j), idx(j - 1), outward);   // Fächer A
    mb.tri(A, B, idx(jm), outward);                                        // Übergang
    for (let j = j1; j > jm; j--) mb.tri(B, idx(j), idx(j - 1), outward);   // Fächer B
  }
}

function buildPlate() {
  const pool = new Pool();
  const mb = new Builder(pool);
  const { x0, x1, y0, y1, z0, z1, Rh, r, Rm, zm, seg, tube } = PLATE;
  const P = (rho, th, z) => pool.get(rho * Math.cos(th), rho * Math.sin(th), z);
  const th = (j) => (j / seg) * 2 * PI;

  // Rohrwand (Zylinder R4, z = 0 … 4,5) — ein Streifen je Segment
  const wallLo = [], wallHi = [];
  for (let j = 0; j < seg; j++) { wallLo.push(P(Rh, th(j), z0)); wallHi.push(P(Rh, th(j), zm)); }
  const radial = (cen) => [-cen[0], -cen[1], 0];
  for (let j = 0; j < seg; j++) {
    const j2 = (j + 1) % seg;
    mb.tri(wallLo[j], wallLo[j2], wallHi[j2], radial);
    mb.tri(wallLo[j], wallHi[j2], wallHi[j], radial);
  }

  // Torus-Viertelrohr (Mündung): ψ von 180° (Rohr, z = 4,5) bis 90° (Öffnung, z = 5)
  const tubeRings = [];
  for (let k = 0; k <= tube; k++) {
    const psi = (PI - (k / tube) * (PI / 2));
    const rho = Rm + r * Math.cos(psi), z = zm + r * Math.sin(psi);
    const ring = [];
    for (let j = 0; j < seg; j++) ring.push(P(rho, th(j), z));
    tubeRings.push(ring);
  }
  for (let k = 0; k < tube; k++) for (let j = 0; j < seg; j++) {
    const j2 = (j + 1) % seg;
    const a = tubeRings[k][j], b = tubeRings[k][j2], c = tubeRings[k + 1][j2], d = tubeRings[k + 1][j];
    // Außen-Normale: vom Rohrquerschnitt weg (Mitte (Rm cos θ, Rm sin θ, zm))
    const cen = [(a[0] + d[0]) / 2, (a[1] + d[1]) / 2, (a[2] + d[2]) / 2];
    const thc = Math.atan2(cen[1], cen[0]);
    const out = norm3([cen[0] - Rm * Math.cos(thc), cen[1] - Rm * Math.sin(thc), cen[2] - zm]);
    mb.tri(a, b, c, out);
    mb.tri(a, c, d, out);
  }

  // Deckflächen oben (z = 5, Loch R4,5) und unten (z = 0, Loch R4): Ring zwischen
  // Innenring und Rechteck — äußerer Rand sind nur die 4 Rechteckecken.
  const cornerPts = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  const ang = (cx, cy) => ((Math.atan2(cy, cx) % (2 * PI)) + 2 * PI) % (2 * PI);
  const cornersTop = cornerPts.map(([cx, cy]) => ({ angle: ang(cx, cy), p: pool.get(cx, cy, z1) }));
  const cornersBot = cornerPts.map(([cx, cy]) => ({ angle: ang(cx, cy), p: pool.get(cx, cy, z0) }));
  ringToRect(mb, tubeRings[tube], cornersTop, [0, 0, 1], Rm);
  ringToRect(mb, wallLo, cornersBot, [0, 0, -1], Rh);

  // Seitenflächen (4): nur die Rechteckecken
  const side = (A, B) => {
    const p00 = pool.get(A[0], A[1], z0), p10 = pool.get(B[0], B[1], z0);
    const p11 = pool.get(B[0], B[1], z1), p01 = pool.get(A[0], A[1], z1);
    const out = norm3([A[0] + B[0] - (x0 + x1), A[1] + B[1] - (y0 + y1), 0]);
    mb.tri(p00, p10, p11, out);
    mb.tri(p00, p11, p01, out);
  };
  side([x0, y0], [x1, y0]);
  side([x1, y0], [x1, y1]);
  side([x1, y1], [x0, y1]);
  side([x0, y1], [x0, y0]);
  return mb.tris;
}

// ── Zylinder + Halbkugel ─────────────────────────────────────────────────────
const HALB = { R: 5, z0: 0, z1: 10, seg: 48, rings: 12 };

function buildHalfSphereCylinder() {
  const pool = new Pool();
  const mb = new Builder(pool);
  const { R, z0, z1, seg, rings } = HALB;
  const P = (rho, th, z) => pool.get(rho * Math.cos(th), rho * Math.sin(th), z);
  const th = (j) => (j / seg) * 2 * PI;

  // Boden: Fächer um (0,0,0)
  const bot = [], top = [];
  for (let j = 0; j < seg; j++) { bot.push(P(R, th(j), z0)); top.push(P(R, th(j), z1)); }
  const c0 = pool.get(0, 0, z0);
  for (let j = 0; j < seg; j++) {
    const j2 = (j + 1) % seg;
    mb.tri(c0, bot[j], bot[j2], [0, 0, -1]);
  }
  // Zylindermantel (z = 0 … 10): ein Streifen je Segment
  const radial = (cen) => [cen[0], cen[1], 0];
  for (let j = 0; j < seg; j++) {
    const j2 = (j + 1) % seg;
    mb.tri(bot[j], bot[j2], top[j2], radial);
    mb.tri(bot[j], top[j2], top[j], radial);
  }
  // Halbkugel (Mitte (0,0,10)): Breitenringe + Polfächer
  const sphereRings = [top];
  for (let k = 1; k <= rings; k++) {
    const phi = (k / (rings + 1)) * (PI / 2);
    const rho = R * Math.cos(phi), z = z1 + R * Math.sin(phi);
    const ring = [];
    for (let j = 0; j < seg; j++) ring.push(P(rho, th(j), z));
    sphereRings.push(ring);
  }
  const radialS = (cen) => [cen[0], cen[1], cen[2] - z1];
  for (let k = 0; k < rings; k++) for (let j = 0; j < seg; j++) {
    const j2 = (j + 1) % seg;
    const a = sphereRings[k][j], b = sphereRings[k][j2], c = sphereRings[k + 1][j2], d = sphereRings[k + 1][j];
    mb.tri(a, b, c, radialS);
    mb.tri(a, c, d, radialS);
  }
  // Pol (0,0,15)
  const pole = pool.get(0, 0, z1 + R);
  const last = sphereRings[rings];
  for (let j = 0; j < seg; j++) {
    const j2 = (j + 1) % seg;
    mb.tri(last[j], last[j2], pole, radialS);
  }
  return mb.tris;
}

// ── Starre Bewegung (gedrehte Varianten) ─────────────────────────────────────
const ROT_AXIS = norm3([1, 2, 3]);
const ROT_DEG = 37;
const SHIFT = [12.5, -7.25, 3.125];

function rotationMatrix(axis, deg) {
  const [x, y, z] = axis, a = deg * D2R, c = Math.cos(a), s = Math.sin(a), t = 1 - c;
  return [
    [t * x * x + c, t * x * y - s * z, t * x * z + s * y],
    [t * x * y + s * z, t * y * y + c, t * y * z - s * x],
    [t * x * z - s * y, t * y * z + s * x, t * z * z + c]
  ];
}

function transformMesh(tris, M, t) {
  const cache = new Map();
  const map = (p) => {
    let q = cache.get(p);
    if (!q) {
      q = [
        M[0][0] * p[0] + M[0][1] * p[1] + M[0][2] * p[2] + t[0],
        M[1][0] * p[0] + M[1][1] * p[1] + M[1][2] * p[2] + t[1],
        M[2][0] * p[0] + M[2][1] * p[1] + M[2][2] * p[2] + t[2]
      ];
      cache.set(p, q);
    }
    return q;
  };
  return tris.map(([a, b, c]) => [map(a), map(b), map(c)]);
}

// ── Soll-Geometrie: Flächenliste und Volumen je Körper ───────────────────────
// Rundquader: V = a'b'c' + 2(a'b'+b'c'+c'a')r + πr²(a'+b'+c') + 4/3 πr³
// Platte:    V = 30·20·5 − π·4²·5 − Rundungsmaterial (Pappus: der Rest der
//             Quadratecke r×r neben dem Viertelkreis, revolviert um z)
// Zylinder+Halbkugel: V = πR²h + (2/3)πR³
export function describeBodies() {
  const r = 1, a = 20, b = 14, c = 10;
  const ap = a - 2 * r, bp = b - 2 * r, cp = c - 2 * r;
  const volBox = ap * bp * cp + 2 * (ap * bp + bp * cp + cp * ap) * r + PI * r * r * (ap + bp + cp) + (4 / 3) * PI * r * r * r;
  // Mündungsrundung (r = 0,5) am Bohrungsrand: Rest der Quadratecke neben dem
  // Viertelkreis; Schwerpunkt bei r(10−3π)/(12−3π) je Achse von der Ecke (4; 5).
  const rf = 0.5;
  const aRest = rf * rf - PI * rf * rf / 4;
  const dRest = rf * (10 - 3 * PI) / (12 - 3 * PI);
  const volPlate = 30 * 20 * 5 - PI * 16 * 5 - 2 * PI * aRest * (4 + dRest);
  const volHalf = PI * 25 * 10 + (2 / 3) * PI * 125;
  const base = [
    { file: 'ff_rundquader_r1.stl', faces: { plane: 6, cylinder: 12, sphere: 8 }, volume: volBox },
    { file: 'ff_platte_loch_torus.stl', faces: { plane: 6, cylinder: 1, torus: 1 }, volume: volPlate },
    { file: 'ff_halbkugel_zylinder.stl', faces: { plane: 1, cylinder: 1, sphere: 1 }, volume: volHalf }
  ];
  const out = [];
  for (const b of base) {
    out.push(b);
    out.push({ file: b.file.replace(/\.stl$/, '_gedreht.stl'), faces: { ...b.faces }, volume: b.volume });
  }
  return out;
}

// ── Alle Körper bauen ────────────────────────────────────────────────────────
export function buildAllBodies() {
  const M = rotationMatrix(ROT_AXIS, ROT_DEG);
  const box = buildRoundedBox({ a: 20, b: 14, c: 10, r: 1, N: 8 });
  const plate = buildPlate();
  const half = buildHalfSphereCylinder();
  const bodies = [
    { file: 'ff_rundquader_r1.stl', tris: box },
    { file: 'ff_platte_loch_torus.stl', tris: plate },
    { file: 'ff_halbkugel_zylinder.stl', tris: half }
  ];
  const out = [];
  for (const b of bodies) {
    out.push(b);
    out.push({ file: b.file.replace(/\.stl$/, '_gedreht.stl'), tris: transformMesh(b.tris, M, SHIFT) });
  }
  return out;
}

// ── Binäre STL schreiben ─────────────────────────────────────────────────────
export function toBinaryStl(tris, name = 'freeform') {
  const buf = Buffer.alloc(84 + tris.length * 50);
  buf.write(`stlReverse freiform ${name}`.slice(0, 79), 0, 'ascii');
  buf.writeUInt32LE(tris.length, 80);
  let o = 84;
  for (const [a, b, c] of tris) {
    const n = norm3(cross3(
      [b[0] - a[0], b[1] - a[1], b[2] - a[2]],
      [c[0] - a[0], c[1] - a[1], c[2] - a[2]]));
    for (const x of [n[0], n[1], n[2], a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]]) {
      buf.writeFloatLE(x, o); o += 4;
    }
    buf.writeUInt16LE(0, o); o += 2;
  }
  return buf;
}

// ── Alle Körper in ein Verzeichnis schreiben ─────────────────────────────────
export function generateAll(outDir = 'tests/freeform/stl') {
  mkdirSync(outDir, { recursive: true });
  const written = [];
  for (const body of buildAllBodies()) {
    const buf = toBinaryStl(body.tris, body.file);
    writeFileSync(join(outDir, body.file), buf);
    written.push({ file: body.file, tris: body.tris.length, bytes: buf.length });
  }
  return written;
}

// CLI: node tests/freeform/gen.mjs [zielordner]
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = process.argv[2] || 'tests/freeform/stl';
  for (const w of generateAll(dir)) console.log(`${w.file}: ${w.tris} Dreiecke, ${w.bytes} Bytes`);
}

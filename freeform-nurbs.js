// ─────────────────────────────────────────────────────────────────────────────
// freeform-nurbs.js — exakte B-Spline-Werkzeuge für "Blend-Patches".
//
// Zweck: eine Verrundungs-Region, deren gefittete Fläche ihre Nachbarn nicht
// exakt trifft, wird zu EINER B-Spline-Fläche, deren Randkurven exakt
// enthalten sind (Coons-Patch). Dafür braucht es exakte Kurvenoperationen
// (Grad-Erhöhung, Knoten-Einfügen, Splitten, Verbinden) und ein exaktes
// Oberflächenmodell.
//
// Datenmodell (bindend, wie freeform-geom.js):
//   Kurve  { type:'bspline', degree:p, ctrl:[[x,y,z],…], knots:[…], mults:[…] }
//          geklemmt: erste/letzte Vielfachheit = p+1, sum(mults) = ctrl.length+p+1.
//          Optional: params (Stützparameter) — wird mitgeführt, aber nicht ausgewertet.
//   Fläche  { type:'bspline_surface', du, dv, ctrl:ctrl[i][j] (i = u, j = v),
//            knotsU, multsU, knotsV, multsV } — in beiden Richtungen geklemmt.
//
// Alle Funktionen sind rein (mutieren die Eingaben nicht) und hängen nur von
// ./freeform-geom.js ab. Alle Maße in mm.
//
// Hinweis zur Darstellung: joinCurves setzt die Verbindungsstellen mit der
// Vielfachheit D (klassische C0-Verbindung, gemeinsamer Randpunkt) — geometrisch
// exakt (gemessen 5e-15 mm) und für strenge Importer zulässig (innere Knoten-
// vielfachheit ≤ Grad). joinCurves(list, { c0Joint: false }) liefert die Variante
// mit Vielfachheit D+1 (nur für Tests).
// ─────────────────────────────────────────────────────────────────────────────

import {
  add, sub, mul, dot, cross, len,
  sdist, project, interpCubic,
} from './freeform-geom.js';

// ── Interne Hilfen: Knotenvektoren ──────────────────────────────────────────

// diskrete Knotenliste + Vielfachheiten → vollständiger Knotenvektor
function expandKnots(knots, mults) {
  const U = [];
  for (let i = 0; i < knots.length; i++) {
    const m = mults && mults[i] !== undefined ? mults[i] : 1;
    for (let k = 0; k < m; k++) U.push(knots[i]);
  }
  return U;
}

// vollständiger Knotenvektor → diskrete Liste + Vielfachheiten
function compressKnots(U) {
  const knots = [];
  const mults = [];
  for (let i = 0; i < U.length; i++) {
    const v = U[i];
    if (knots.length && Math.abs(knots[knots.length - 1] - v) < 1e-12) {
      mults[mults.length - 1]++;
    } else {
      knots.push(v);
      mults.push(1);
    }
  }
  return { knots, mults };
}

// Spannweite: U[k] <= u < U[k+1], k in [degree, nCtrl-1]
function findSpan(U, p, nCtrl, u) {
  if (u >= U[nCtrl]) return nCtrl - 1;
  let lo = p;
  let hi = nCtrl;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (u < U[mid + 1]) hi = mid; else lo = mid + 1;
  }
  return lo;
}

// Basisfunktionen N_{span-p..span,p}(u) (NURBS Book A2.2)
function basisFuns(U, p, u, span) {
  const N = new Float64Array(p + 1);
  const left = new Float64Array(p + 1);
  const right = new Float64Array(p + 1);
  N[0] = 1;
  for (let j = 1; j <= p; j++) {
    left[j] = u - U[span + 1 - j];
    right[j] = U[span + j] - u;
    let saved = 0;
    for (let r = 0; r < j; r++) {
      const den = right[r + 1] + left[j - r];
      const temp = den !== 0 ? N[r] / den : 0;
      N[r] = saved + right[r + 1] * temp;
      saved = left[j - r] * temp;
    }
    N[j] = saved;
  }
  return N;
}

// alle Basisfunktionen N_{i,p}(u), i = 0..nCtrl-1
function basisAll(U, p, nCtrl, u) {
  const out = new Float64Array(nCtrl);
  const span = findSpan(U, p, nCtrl, u);
  const N = basisFuns(U, p, u, span);
  for (let i = 0; i <= p; i++) out[span - p + i] = N[i];
  return out;
}

// Basisfunktionen + erste Ableitung (NURBS Book A2.2/A4.3); Ergebnis:
// ders[j][k] (j = Funktionsindex, k = Ableitungsordnung)
function dersBasisFuns(U, p, u, span, nDers) {
  const N = basisFuns(U, p, u, span);
  const ders = [];
  for (let j = 0; j <= p; j++) ders.push(new Float64Array(nDers + 1));
  for (let j = 0; j <= p; j++) ders[j][0] = N[j];
  if (nDers >= 1 && p >= 1) {
    // Ableitung über die Basisfunktionen des Grades p-1 (gleicher Knotenvektor)
    const M = basisFuns(U, p - 1, u, span);
    for (let j = 0; j <= p; j++) {
      const i = span - p + j;
      let d = 0;
      const den1 = U[i + p] - U[i];
      if (den1 !== 0 && j >= 1) d += (p * M[j - 1]) / den1;
      const den2 = U[i + p + 1] - U[i + 1];
      if (den2 !== 0 && j <= p - 1) d -= (p * M[j]) / den2;
      ders[j][1] = d;
    }
  }
  return ders;
}

// ── Interne Hilfen: Kurven ───────────────────────────────────────────────────

// Kurve bauen (params optional mitführen)
function makeCurve(p, ctrl, km, params) {
  const c = { type: 'bspline', degree: p, ctrl, knots: km.knots, mults: km.mults };
  if (params) c.params = params.slice();
  return c;
}

// Kopie einer Kurve (Eingaben werden nie mutiert)
function cloneCurve(c) {
  if (!c) return null;
  const out = makeCurve(c.degree, c.ctrl.map((p) => p.slice()), { knots: c.knots.slice(), mults: c.mults.slice() }, c.params);
  return out;
}

// Domäne [a,b] einer Kurve
function domain(c) {
  return [c.knots[0], c.knots[c.knots.length - 1]];
}

// Vielfachheit eines Knotenwertes im vollständigen Knotenvektor
function multOf(U, v) {
  const eps = 1e-12 * Math.max(1, Math.abs(v));
  let n = 0;
  for (let i = 0; i < U.length; i++) if (Math.abs(U[i] - v) <= eps) n++;
  return n;
}

// erster Index eines Knotenwertes im vollständigen Knotenvektor (-1: fehlt)
function firstIndexOf(U, v) {
  const eps = 1e-12 * Math.max(1, Math.abs(v));
  for (let i = 0; i < U.length; i++) if (Math.abs(U[i] - v) <= eps) return i;
  return -1;
}

// Bounding-Box-Diagonale der Kontrollpunkte = charakteristische Länge
function ctrlScale(pts) {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const p of pts) {
    for (let i = 0; i < 3; i++) {
      if (p[i] < lo[i]) lo[i] = p[i];
      if (p[i] > hi[i]) hi[i] = p[i];
    }
  }
  return Math.max(1e-9, Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]));
}

// Skala einer Kurvenliste
function curvesScale(list) {
  let s = 1;
  for (const c of list) if (c) s = Math.max(s, ctrlScale(c.ctrl));
  return s;
}

// Länge des Kontrollpolygons
function polyLen(c) {
  let L = 0;
  for (let i = 1; i < c.ctrl.length; i++) L += len(sub(c.ctrl[i], c.ctrl[i - 1]));
  return L;
}

// ── Knoten einfügen (Boehm, NURBS Book A5.1) — exakt ────────────────────────
// Der Knoten u wird einmal mehr eingefügt (Vielfachheit +1), exakt.
function insertKnot(U, ctrl, p, u) {
  const n = ctrl.length - 1;
  const eps = 1e-12 * Math.max(1, Math.abs(u));
  let g = -1; // erster Index der Knotengruppe
  let sU = 0; // Vielfachheit
  for (let i = 0; i < U.length; i++) {
    if (Math.abs(U[i] - u) <= eps) { if (g < 0) g = i; sU++; }
  }
  let k; // letzter Index der Gruppe bzw. Spannweite
  if (g >= 0) {
    k = g + sU - 1;
  } else {
    k = -1;
    for (let i = p; i <= n; i++) if (U[i] <= u && u < U[i + 1]) { k = i; break; }
    if (k < 0) return null; // außerhalb der Domäne
    sU = 0;
  }
  // Endknoten: keine weitere Einfügung möglich (Vielfachheit wäre > p+1)
  if (u <= U[p] + eps || u >= U[ctrl.length] - eps) return null;
  if (sU >= p + 1) return null;
  // Kontrollpunkte (Eckenschneiden, exakt)
  const Q = [];
  for (let i = 0; i <= k - p; i++) Q.push(ctrl[i].slice());
  for (let i = k - p + 1; i <= k - sU; i++) {
    const den = U[i + p] - U[i];
    const tau = den !== 0 ? (u - U[i]) / den : 0;
    const a = ctrl[i - 1];
    const b = ctrl[i];
    Q.push([
      (1 - tau) * a[0] + tau * b[0],
      (1 - tau) * a[1] + tau * b[1],
      (1 - tau) * a[2] + tau * b[2],
    ]);
  }
  for (let i = k - sU + 1; i <= n + 1; i++) Q.push(ctrl[i - 1].slice());
  // neuer Knotenvektor
  const UN = U.slice();
  UN.splice(k + 1, 0, u);
  return { U: UN, ctrl: Q };
}

// Kurve auf einen Ziel-Knotenvektor verfeinern (mehrfaches Einfügen)
function refineTo(c, tKnots, tMults) {
  const p = c.degree;
  let U = expandKnots(c.knots, c.mults);
  let ctrl = c.ctrl.map((q) => q.slice());
  for (let i = 0; i < tKnots.length; i++) {
    let guard = 0;
    while (multOf(U, tKnots[i]) < tMults[i] && guard++ < 64) {
      const res = insertKnot(U, ctrl, p, tKnots[i]);
      if (!res) return null;
      U = res.U;
      ctrl = res.ctrl;
    }
  }
  return makeCurve(p, ctrl, compressKnots(U), c.params);
}

// ── Kurven-Operationen (öffentlich) ─────────────────────────────────────────

// Gerade als B-Spline (Grad 1) von p nach q
export function lineToBspline(p, q) {
  return makeCurve(1, [p.slice(), q.slice()], { knots: [0, 1], mults: [2, 2] });
}

// Kurve auswerten (de Boor); u in der Domäne der Kurve
export function evalCurve(c, u) {
  const p = c.degree;
  const U = expandKnots(c.knots, c.mults);
  const nCtrl = c.ctrl.length;
  const uu = Math.min(Math.max(u, U[0]), U[U.length - 1]);
  const span = findSpan(U, p, nCtrl, uu);
  const d = [];
  for (let j = 0; j <= p; j++) d.push(c.ctrl[span - p + j].slice());
  for (let r = 1; r <= p; r++) {
    for (let j = p; j >= r; j--) {
      const i = span - p + j;
      const den = U[i + p - r + 1] - U[i];
      const alpha = den !== 0 ? (uu - U[i]) / den : 0;
      const a = d[j - 1];
      const b = d[j];
      d[j] = [
        (1 - alpha) * a[0] + alpha * b[0],
        (1 - alpha) * a[1] + alpha * b[1],
        (1 - alpha) * a[2] + alpha * b[2],
      ];
    }
  }
  return d[p];
}

// Kurve umkehren (exakt, gleiche Domäne): rev(u) = c(a+b-u)
export function reverseCurve(c) {
  if (!c) return null;
  const m = c.knots.length;
  const a = c.knots[0];
  const b = c.knots[m - 1];
  const knots = [];
  const mults = [];
  for (let i = 0; i < m; i++) {
    knots.push((a + b) - c.knots[m - 1 - i]);
    mults.push(c.mults[m - 1 - i]);
  }
  const ctrl = c.ctrl.slice().reverse().map((p) => p.slice());
  let params = null;
  if (c.params) params = c.params.slice().reverse().map((u) => (a + b) - u);
  return makeCurve(c.degree, ctrl, { knots, mults }, params);
}

// Kurve linear auf [a,b] umparametrisieren (exakt)
export function reparamCurve(c, a, b) {
  if (!c) return null;
  const k0 = c.knots[0];
  const k1 = c.knots[c.knots.length - 1];
  const f = (u) => (k1 - k0 === 0 ? a : a + ((u - k0) / (k1 - k0)) * (b - a));
  const knots = c.knots.map(f);
  let params = null;
  if (c.params) params = c.params.map(f);
  return makeCurve(c.degree, c.ctrl.map((p) => p.slice()), { knots, mults: c.mults.slice() }, params);
}

// Grad exakt erhöhen (Bézier-Zerlegung → Segmente heben → zusammensetzen).
// Die inneren Knoten behalten ihre Werte; alle Knoten (auch die inneren)
// bekommen die Vielfachheit D+1 — damit bleiben die Segmente geometrisch
// exakt erhalten und die Kurve ist stetig (C0 an den Segmentgrenzen).
export function elevateCurve(c, toDegree) {
  if (!c) return null;
  const p = c.degree;
  if (!(toDegree > p)) return cloneCurve(c);
  const D = toDegree;
  let U = expandKnots(c.knots, c.mults);
  let ctrl = c.ctrl.map((q) => q.slice());
  // 1) Bézier-Zerlegung: inneren Knoten auf Vielfachheit p+1 bringen
  for (let guard = 0; guard < 512; guard++) {
    const { knots, mults } = compressKnots(U);
    let idx = -1;
    for (let i = 1; i < knots.length - 1; i++) if (mults[i] < p + 1) { idx = i; break; }
    if (idx < 0) break;
    const res = insertKnot(U, ctrl, p, knots[idx]);
    if (!res) return null;
    U = res.U;
    ctrl = res.ctrl;
  }
  // 2) Kontrollpunkte in Bézier-Segmente gruppieren und jedes Segment heben
  const nSeg = ctrl.length / (p + 1);
  if (!Number.isInteger(nSeg) || nSeg < 1) return null;
  const segs = [];
  for (let k = 0; k < nSeg; k++) {
    let B = ctrl.slice(k * (p + 1), k * (p + 1) + p + 1);
    // Bézier-Grad Schritt für Schritt erhöhen (jeder Schritt exakt)
    for (let d = p; d < D; d++) {
      const Q = [];
      for (let j = 0; j <= d + 1; j++) {
        const w = j / (d + 1);
        const prev = j > 0 ? B[j - 1] : null;
        const cur = j <= d ? B[j] : null;
        Q.push([
          w * (prev ? prev[0] : 0) + (1 - w) * (cur ? cur[0] : 0),
          w * (prev ? prev[1] : 0) + (1 - w) * (cur ? cur[1] : 0),
          w * (prev ? prev[2] : 0) + (1 - w) * (cur ? cur[2] : 0),
        ]);
      }
      B = Q;
    }
    segs.push(B);
  }
  // 3) zusammensetzen: alle Knoten (Enden und innere) mit Vielfachheit D+1 —
  //    so bleiben die Segmente geometrisch EXAKT erhalten (die Randpunkte der
  //    Segmente sind identisch, die Kurve bleibt stetig/C0).
  const km = compressKnots(U);
  const mults = km.mults.map(() => D + 1);
  const out = [];
  for (const seg of segs) for (const q of seg) out.push(q);
  return makeCurve(D, out, { knots: km.knots, mults }, c.params);
}

// Knotenliste X in die Kurve einfügen (exakt, A5.4)
export function refineCurve(c, X) {
  if (!c) return null;
  let U = expandKnots(c.knots, c.mults);
  let ctrl = c.ctrl.map((q) => q.slice());
  const p = c.degree;
  for (const u of X || []) {
    const res = insertKnot(U, ctrl, p, u);
    if (!res) return null;
    U = res.U;
    ctrl = res.ctrl;
  }
  return makeCurve(p, ctrl, compressKnots(U), c.params);
}

// Kurve an u in zwei exakte Teile spalten (C0); u wird auf Vielfachheit p
// gebracht (u muss im Inneren der Domäne liegen, sonst null)
export function splitCurve(c, u) {
  if (!c) return null;
  const p = c.degree;
  const [a, b] = domain(c);
  const uu = Math.min(Math.max(u, a), b);
  if (!(uu > a && uu < b)) return null;
  let U = expandKnots(c.knots, c.mults);
  let ctrl = c.ctrl.map((q) => q.slice());
  let guard = 0;
  while (multOf(U, uu) < p && guard++ < 64) {
    const res = insertKnot(U, ctrl, p, uu);
    if (!res) return null;
    U = res.U;
    ctrl = res.ctrl;
  }
  if (multOf(U, uu) > p) return null; // nicht C0 trennbar
  const g = firstIndexOf(U, uu);
  if (g < 0) return null;
  const m = multOf(U, uu);
  // linkes Stück: Knoten vor u + u mit Vielfachheit p+1 (geklemmt)
  const leftCtrl = ctrl.slice(0, g);
  const leftU = U.slice(0, g).concat(new Array(p + 1).fill(uu));
  // rechtes Stück: u mit Vielfachheit p+1 + Knoten danach (Randpunkt geteilt)
  const rightCtrl = ctrl.slice(g - 1);
  const rightU = new Array(p + 1).fill(uu).concat(U.slice(g + m));
  const lp = c.params ? c.params.filter((x) => x <= uu + 1e-12) : null;
  const rp = c.params ? c.params.filter((x) => x >= uu - 1e-12) : null;
  return [
    makeCurve(p, leftCtrl, compressKnots(leftU), lp),
    makeCurve(p, rightCtrl, compressKnots(rightU), rp),
  ];
}

// Kontrollpolygon-Längen und Punkt auf einer Polylinie (Bogenlänge)
function arcLengths(poly) {
  const cum = [0];
  for (let i = 1; i < poly.length; i++) cum.push(cum[i - 1] + len(sub(poly[i], poly[i - 1])));
  return cum;
}

function polyPointAt(poly, cum, s) {
  const last = poly.length - 1;
  if (s <= 0) return poly[0].slice();
  if (s >= cum[last]) return poly[last].slice();
  let i = 1;
  while (i < last && cum[i] < s) i++;
  const seg = cum[i] - cum[i - 1];
  const t = seg > 1e-15 ? (s - cum[i - 1]) / seg : 0;
  return add(poly[i - 1], mul(sub(poly[i], poly[i - 1]), t));
}

// Kurven verbinden: alle Stücke auf den höchsten Grad, Stück k auf
// [s_k, s_{k+1}] (s proportional zur Kontrollpolygonlänge).
// Lücke > 1e-9*scale → null.
//
// Standard (opts.c0Joint !== false): Verbindungsstelle mit Vielfachheit D,
// gemeinsamer Randpunkt (vom vorherigen Stück) — exakt, da jedes Stück auf
// seinem Intervall unverändert bleibt. opts.c0Joint === false: Vielfachheit D+1
// (Stücke hintereinander; innerer Knoten > Grad, für STEP nicht verwenden).
export function joinCurves(list, opts = {}) {
  if (!list || !list.length) return null;
  if (list.length === 1) return cloneCurve(list[0]);
  const scale = curvesScale(list);
  const tol = 1e-9 * scale;
  // Lücken prüfen
  for (let k = 0; k < list.length - 1; k++) {
    const e = evalCurve(list[k], domain(list[k])[1]);
    const s = evalCurve(list[k + 1], domain(list[k + 1])[0]);
    if (len(sub(e, s)) > tol) return null;
  }
  const D = Math.max(...list.map((c) => c.degree));
  // Stückgrenzen s proportional zur Kontrollpolygonlänge
  const lens = list.map((c) => polyLen(c));
  const total = lens.reduce((x, y) => x + y, 0);
  const s = [0];
  for (let k = 0; k < list.length; k++) s.push(total > 0 ? s[k] + lens[k] / total : (k + 1) / list.length);
  // Stücke auf gleichen Grad und passendes Intervall bringen
  const pieces = [];
  for (let k = 0; k < list.length; k++) {
    const e = elevateCurve(list[k], D);
    if (!e) return null;
    const r = reparamCurve(e, s[k], s[k + 1]);
    if (!r) return null;
    pieces.push(r);
  }
  // Join-Punkt kommt vom VORHERIGEN Stück (exakt gemeinsam)
  for (let k = 1; k < pieces.length; k++) {
    const prev = pieces[k - 1];
    pieces[k].ctrl[0] = prev.ctrl[prev.ctrl.length - 1].slice();
  }
  const knots = [];
  const mults = [];
  const ctrl = [];
  if (opts.c0Joint !== false) {
    // Verbindungsstelle mit Vielfachheit D (C0), Randpunkt gemeinsam
    for (let i = 0; i < pieces[0].knots.length - 1; i++) {
      knots.push(pieces[0].knots[i]);
      mults.push(pieces[0].mults[i]);
    }
    for (let k = 1; k < pieces.length; k++) {
      knots.push(pieces[k - 1].knots[pieces[k - 1].knots.length - 1]);
      mults.push(D);
      for (let i = 1; i < pieces[k].knots.length - 1; i++) {
        knots.push(pieces[k].knots[i]);
        mults.push(pieces[k].mults[i]);
      }
    }
    const lastP = pieces[pieces.length - 1];
    knots.push(lastP.knots[lastP.knots.length - 1]);
    mults.push(D + 1);
    for (let k = 0; k < pieces.length; k++) {
      for (let i = k === 0 ? 0 : 1; i < pieces[k].ctrl.length; i++) ctrl.push(pieces[k].ctrl[i].slice());
    }
    return makeCurve(D, ctrl, { knots, mults });
  }
  // exakte Verbindung: Stücke hintereinander, Verbindungsstelle mit D+1
  for (let k = 0; k < pieces.length; k++) {
    const first = k === 0 ? 0 : 1; // erster Knoten = Verbindungsstelle (bereits gesetzt)
    for (let i = first; i < pieces[k].knots.length; i++) {
      knots.push(pieces[k].knots[i]);
      mults.push(pieces[k].mults[i]);
    }
  }
  for (let k = 0; k < pieces.length; k++) {
    for (let i = 0; i < pieces[k].ctrl.length; i++) ctrl.push(pieces[k].ctrl[i].slice());
  }
  return makeCurve(D, ctrl, { knots, mults });
}

// Zwei Kurven kompatibel machen: gleicher Grad, gleiche Domäne [0,1],
// identischer Knotenvektor — die Geometrie bleibt exakt erhalten.
export function makeCompatible(a, b) {
  if (!a || !b) return null;
  const a1 = reparamCurve(a, 0, 1);
  const b1 = reparamCurve(b, 0, 1);
  const D = Math.max(a1.degree, b1.degree);
  const a2 = elevateCurve(a1, D);
  const b2 = elevateCurve(b1, D);
  if (!a2 || !b2) return null;
  // Ziel-Knotenvektor: Vereinigung der Werte, Vielfachheit = Maximum
  const vals = [];
  for (const c of [a2, b2]) {
    for (let i = 0; i < c.knots.length; i++) {
      const v = c.knots[i];
      let hit = -1;
      for (let k = 0; k < vals.length; k++) if (Math.abs(vals[k].v - v) < 1e-12) { hit = k; break; }
      if (hit < 0) vals.push({ v, m: c.mults[i] });
      else vals[hit].m = Math.max(vals[hit].m, c.mults[i]);
    }
  }
  vals.sort((x, y) => x.v - y.v);
  const tKnots = vals.map((e) => e.v);
  const tMults = vals.map((e) => e.m);
  const a3 = refineTo(a2, tKnots, tMults);
  const b3 = refineTo(b2, tKnots, tMults);
  if (!a3 || !b3) return null;
  return [a3, b3];
}

// ── Coons-Patch ──────────────────────────────────────────────────────────────

// Koeffizienten der linearen Funktion (1-x) in einer B-Spline-Basis
function linearCoeffs(knots, mults, degree) {
  const L = makeCurve(1, [[1, 0, 0], [0, 0, 0]], { knots: [0, 1], mults: [2, 2] });
  const e = elevateCurve(L, degree);
  if (!e) return null;
  const r = refineTo(e, knots, mults);
  if (!r) return null;
  return r.ctrl.map((q) => q[0]);
}

// Coons-Patch als EINE B-Spline-Fläche:
//   S(u,0)=c0(u), S(u,1)=c1(u), S(0,v)=d0(v), S(1,v)=d1(v)
// Aufbau: Ruled_v(c0,c1) + Ruled_u(d0,d1) - Bilinear(Ecken).
// Die Randkurven sind damit exakt enthalten (Fehler ~1e-15).
export function coonsPatch(c0, c1, d0, d1) {
  if (!c0 || !c1 || !d0 || !d1) return null;
  const scale = curvesScale([c0, c1, d0, d1]);
  const tol = 1e-9 * scale;
  // alle Seiten auf [0,1] umparametrisieren
  const a0 = reparamCurve(c0, 0, 1);
  const a1 = reparamCurve(c1, 0, 1);
  const b0 = reparamCurve(d0, 0, 1);
  const b1 = reparamCurve(d1, 0, 1);
  if (!a0 || !a1 || !b0 || !b1) return null;
  // Eckbedingungen prüfen
  if (len(sub(evalCurve(a0, 0), evalCurve(b0, 0))) > tol) return null;
  if (len(sub(evalCurve(a0, 1), evalCurve(b1, 0))) > tol) return null;
  if (len(sub(evalCurve(a1, 0), evalCurve(b0, 1))) > tol) return null;
  if (len(sub(evalCurve(a1, 1), evalCurve(b1, 1))) > tol) return null;
  // kompatible Paare (gleicher Grad, gleiche Knoten)
  const cu = makeCompatible(a0, a1);
  const cv = makeCompatible(b0, b1);
  if (!cu || !cv) return null;
  const u0 = cu[0];
  const u1 = cu[1];
  const v0 = cv[0];
  const v1 = cv[1];
  // Ecken auf die c-Werte snappen (exakte Randbedingungen)
  const Q00 = evalCurve(u0, 0);
  const Q10 = evalCurve(u0, 1);
  const Q01 = evalCurve(u1, 0);
  const Q11 = evalCurve(u1, 1);
  v0.ctrl[0] = Q00.slice();
  v0.ctrl[v0.ctrl.length - 1] = Q01.slice();
  v1.ctrl[0] = Q10.slice();
  v1.ctrl[v1.ctrl.length - 1] = Q11.slice();
  // Koeffizienten der linearen Funktionen in der jeweiligen Basis
  const lu = linearCoeffs(u0.knots, u0.mults, u0.degree);
  const lv = linearCoeffs(v0.knots, v0.mults, v0.degree);
  if (!lu || !lv) return null;
  const ru = lu.map((x) => 1 - x);
  const rv = lv.map((x) => 1 - x);
  // Kontrollnetz
  const ctrl = [];
  for (let i = 0; i < u0.ctrl.length; i++) {
    const row = [];
    for (let j = 0; j < v0.ctrl.length; j++) {
      const p = [0, 0, 0];
      for (let d = 0; d < 3; d++) {
        p[d] += lv[j] * u0.ctrl[i][d] + rv[j] * u1.ctrl[i][d];   // (1-v)c0 + v c1
        p[d] += lu[i] * v0.ctrl[j][d] + ru[i] * v1.ctrl[j][d];   // (1-u)d0 + u d1
        p[d] -= lu[i] * lv[j] * Q00[d] + ru[i] * lv[j] * Q10[d]
          + lu[i] * rv[j] * Q01[d] + ru[i] * rv[j] * Q11[d];     // Bilinear-Ecken
      }
      row.push(p);
    }
    ctrl.push(row);
  }
  return {
    type: 'bspline_surface',
    du: u0.degree,
    dv: v0.degree,
    ctrl,
    knotsU: u0.knots.slice(),
    multsU: u0.mults.slice(),
    knotsV: v0.knots.slice(),
    multsV: v0.mults.slice(),
  };
}

// ── Flächen: Auswertung, Ableitungen, Normale, Projektion ───────────────────

// Vollständiger Knotenvektor einer Fläche (gecacht: die Auswertung ruft ihn
// sehr oft auf und die Vektoren ändern sich nie)
const knotCache = new WeakMap();
function surfaceKnots(S) {
  let e = knotCache.get(S);
  if (!e) {
    e = { U: expandKnots(S.knotsU, S.multsU), V: expandKnots(S.knotsV, S.multsV) };
    knotCache.set(S, e);
  }
  return e;
}

export function evalSurface(S, u, v) {
  const { U, V } = surfaceKnots(S);
  const nu = S.ctrl.length;
  const nv = S.ctrl[0].length;
  const uu = Math.min(Math.max(u, U[0]), U[U.length - 1]);
  const vv = Math.min(Math.max(v, V[0]), V[V.length - 1]);
  // nur die (du+1)×(dv+1) Stützpunkte im Parameter-Span sind beitragsstark
  // (alle anderen Basisfunktionen sind dort exakt 0) → O(Grad²) statt O(nu·nv)
  const spanU = findSpan(U, S.du, nu, uu);
  const spanV = findSpan(V, S.dv, nv, vv);
  const Nu = basisFuns(U, S.du, uu, spanU);
  const Nv = basisFuns(V, S.dv, vv, spanV);
  const out = [0, 0, 0];
  for (let i = 0; i <= S.du; i++) {
    const wi = Nu[i];
    if (wi === 0) continue;
    const gi = spanU - S.du + i;
    for (let j = 0; j <= S.dv; j++) {
      const w = wi * Nv[j];
      if (w === 0) continue;
      const c = S.ctrl[gi][spanV - S.dv + j];
      out[0] += w * c[0];
      out[1] += w * c[1];
      out[2] += w * c[2];
    }
  }
  return out;
}

// Punkt und erste Partielle Ableitungen
export function surfaceDerivs(S, u, v) {
  const { U, V } = surfaceKnots(S);
  const nu = S.ctrl.length;
  const nv = S.ctrl[0].length;
  const uu = Math.min(Math.max(u, U[0]), U[U.length - 1]);
  const vv = Math.min(Math.max(v, V[0]), V[V.length - 1]);
  const spanU = findSpan(U, S.du, nu, uu);
  const spanV = findSpan(V, S.dv, nv, vv);
  const dU = dersBasisFuns(U, S.du, uu, spanU, 1);
  const dV = dersBasisFuns(V, S.dv, vv, spanV, 1);
  const P = [0, 0, 0];
  const Su = [0, 0, 0];
  const Sv = [0, 0, 0];
  for (let i = 0; i <= S.du; i++) {
    const gi = spanU - S.du + i;
    if (gi < 0 || gi >= nu) continue;
    for (let j = 0; j <= S.dv; j++) {
      const gj = spanV - S.dv + j;
      if (gj < 0 || gj >= nv) continue;
      const c = S.ctrl[gi][gj];
      const w = dU[i][0] * dV[j][0];
      const wu = dU[i][1] * dV[j][0];
      const wv = dU[i][0] * dV[j][1];
      P[0] += w * c[0]; P[1] += w * c[1]; P[2] += w * c[2];
      Su[0] += wu * c[0]; Su[1] += wu * c[1]; Su[2] += wu * c[2];
      Sv[0] += wv * c[0]; Sv[1] += wv * c[1]; Sv[2] += wv * c[2];
    }
  }
  return { P, Su, Sv };
}

// Einheitsnormale (Su × Sv); null bei entarteter Ableitung
export function surfaceNormal(S, u, v) {
  const d = surfaceDerivs(S, u, v);
  const n = cross(d.Su, d.Sv);
  const l = len(n);
  if (!(l > 1e-14)) return null;
  return [n[0] / l, n[1] / l, n[2] / l];
}

// ── Startwerte: Knotenspannen statt gleichmäßigem Raster ────────────────────
//
// Die Parametrisierung einer Blend-Fläche ist stark ungleichförmig: die Seiten
// sind aus Randkurven zusammengesetzt, die nach Kontrollpolygonlänge
// parametrisiert werden. Ein Randstück kann < 1 % des u-Bereichs belegen
// (ein 0,05-mm-Stück neben 5-mm-Stücken), eine Polseite (dreiseitiges Patch)
// kollabiert ganz. Ein gleichmäßiges Raster über die Domäne verfehlt solche
// Spuren völlig — die Projektion blieb dann in einem Nebenminimum hängen und
// meldete Punkte, die exakt auf der Fläche liegen, bis 0,05 mm daneben.

// Spannen (Intervalle mit K[k+1] > K[k]) im gültigen Bereich [p, nCtrl-1]
function knotSpans(K, p, nCtrl) {
  const out = [];
  for (let k = p; k < nCtrl; k++) if (K[k + 1] > K[k]) out.push({ k, a: K[k], b: K[k + 1] });
  return out;
}

// geometrisches Gewicht je Span: die Kontrollpolygon-Länge im Span
// (Anhaltsmaß für die Bogenlänge — proportional dazu verteilt sich die
// Stützstellenzahl, damit der Abstand benachbarter Stützstellen überall
// ähnlich bleibt)
function spanWeights(S) {
  const { U, V } = surfaceKnots(S);
  const nu = S.ctrl.length;
  const nv = S.ctrl[0].length;
  const su = knotSpans(U, S.du, nu);
  const sv = knotSpans(V, S.dv, nv);
  const wu = su.map(({ k }) => {
    let s = 0;
    for (let i = k - S.du + 1; i <= k; i++) {
      let m = 0;
      for (let j = 0; j < nv; j++) m += len(sub(S.ctrl[i][j], S.ctrl[i - 1][j]));
      s += m / nv;
    }
    return s;
  });
  const wv = sv.map(({ k }) => {
    let s = 0;
    for (let j = k - S.dv + 1; j <= k; j++) {
      let m = 0;
      for (let i = 0; i < nu; i++) m += len(sub(S.ctrl[i][j], S.ctrl[i][j - 1]));
      s += m / nu;
    }
    return s;
  });
  return { su, sv, wu, wv };
}

// Stützstellen je Span verteilen: mindestens eine, der Rest proportional zum
// geometrischen Gewicht — ein schmaler Span (Randstück) bekommt so trotzdem
// seine Stützstellen, ein breiter mehr.
function allocSpan(weights, total) {
  const n = weights.length;
  const cnt = new Array(n).fill(1);
  const sum = weights.reduce((a, b) => a + b, 0);
  const left = total - n;
  if (left > 0 && sum > 0) {
    const exact = weights.map((w) => (left * w) / sum);
    let used = 0;
    for (let i = 0; i < n; i++) { const c = Math.max(1, Math.floor(exact[i])); cnt[i] = c; used += c; }
    const order = exact.map((e, i) => ({ i, f: e - Math.floor(e) })).sort((a, b) => b.f - a.f);
    for (let k = 0; used < total && k < order.length; k++) { cnt[order[k].i]++; used++; }
  }
  return cnt;
}

// Stützstellenwerte je Span (Spannenenden eingeschlossen; bei einer
// Stützstelle die Spanmitte)
function spanValues(spans, cnt) {
  const out = [];
  for (let i = 0; i < spans.length; i++) {
    const { a, b } = spans[i];
    const c = cnt[i];
    if (c <= 1) { out.push(0.5 * (a + b)); continue; }
    for (let k = 0; k < c; k++) out.push(a + ((b - a) * k) / (c - 1));
  }
  return out;
}

// Grobes Gitter von Flächenpunkten (Startwerte für die Projektion)
// Einmal je Fläche berechnet → die Projektion vieler Punkte kostet danach
// nur noch den Vergleich mit dem Gitter statt einer eigenen Raster-Suche.
// Die Stützstellen liegen je KNOTENSPAN, nicht gleichmäßig über die Domäne.
export function surfaceSamples(S, n = 8) {
  const { su, sv, wu, wv } = spanWeights(S);
  const nU = Math.min(64, Math.max(n + 1, 2 * su.length));
  const nV = Math.min(64, Math.max(n + 1, 2 * sv.length));
  const us = spanValues(su, allocSpan(wu, nU));
  const vs = spanValues(sv, allocSpan(wv, nV));
  const out = [];
  for (const u of us) for (const v of vs) out.push({ u, v, p: evalSurface(S, u, v) });
  return out;
}

// Stützstellen je Fläche zwischenspeichern (die Projektion vieler Punkte auf
// dieselbe Fläche soll das Gitter nur einmal rechnen)
const spanCache = new WeakMap();
function spanSamples(S, n = 8) {
  let e = spanCache.get(S);
  if (!e) { e = new Map(); spanCache.set(S, e); }
  let s = e.get(n);
  if (!s) { s = surfaceSamples(S, n); e.set(n, s); }
  return s;
}

// Minimum einer eindimensionalen Funktion: grobe Suche + goldener Schnitt
// (robust gegen mehrere lokale Minima — der grobe Scan findet das beste
// Intervall, der goldene Schnitt verfeinert darin)
function scanMin(f, a, b) {
  const N = 32;
  const ts = new Float64Array(N + 1);
  let bt = a;
  let bd = Infinity;
  let bi = 0;
  for (let i = 0; i <= N; i++) {
    const t = a + ((b - a) * i) / N;
    ts[i] = t;
    const d = f(t);
    if (d < bd) { bd = d; bt = t; bi = i; }
  }
  let lo = ts[Math.max(0, bi - 1)];
  let hi = ts[Math.min(N, bi + 1)];
  if (hi > lo) {
    const g = (Math.sqrt(5) - 1) / 2;
    let x1 = hi - g * (hi - lo);
    let x2 = lo + g * (hi - lo);
    let f1 = f(x1);
    let f2 = f(x2);
    for (let k = 0; k < 50 && hi - lo > 1e-14 * (1 + Math.abs(lo)); k++) {
      if (f1 < f2) { hi = x2; x2 = x1; f2 = f1; x1 = hi - g * (hi - lo); f1 = f(x1); }
      else { lo = x1; x1 = x2; f1 = f2; x2 = lo + g * (hi - lo); f2 = f(x2); }
    }
    const t = 0.5 * (lo + hi);
    const d = f(t);
    if (d < bd) { bd = d; bt = t; }
  }
  return { t: bt, d: bd };
}

// Startpunkte auf den vier Rand-Isokurven (u=u0, u=u1, v=v0, v=v1): dort liegt
// ein Randpunkt exakt — der 2-D-Newton verfeinert von dort auf Abstand null.
function boundaryMinima(S, p) {
  const { U, V } = surfaceKnots(S);
  const u0 = U[0];
  const u1 = U[U.length - 1];
  const v0 = V[0];
  const v1 = V[V.length - 1];
  const d = (q) => len(sub(q, p));
  const m0 = scanMin((t) => d(evalSurface(S, t, v0)), u0, u1);
  const m1 = scanMin((t) => d(evalSurface(S, t, v1)), u0, u1);
  const m2 = scanMin((t) => d(evalSurface(S, u0, t)), v0, v1);
  const m3 = scanMin((t) => d(evalSurface(S, u1, t)), v0, v1);
  return [
    { u: m0.t, v: v0, d: m0.d },
    { u: m1.t, v: v1, d: m1.d },
    { u: u0, v: m2.t, d: m2.d },
    { u: u1, v: m3.t, d: m3.d },
  ];
}

// Nächster Punkt auf der Fläche: Startwerte je Knotenspan + Gauß-Newton (geklemmt)
//
// Reihenfolge: bester Startwert → (falls das Ergebnis nicht stimmt) weitere
// Startwerte und die Rand-Isokurven. Der Newton bleibt sonst in einem
// Nebenminimum hängen, wenn der gesuchte Punkt auf dem Rand liegt: dort ist
// das Minimum am Rand des Parameterbereichs und der innere Gradient führt
// nicht dorthin.
export function projectToSurface(S, p, opts = {}) {
  const { U, V } = surfaceKnots(S);
  const u0 = U[0];
  const u1 = U[U.length - 1];
  const v0 = V[0];
  const v1 = V[V.length - 1];
  const iters = opts.iters !== undefined ? opts.iters : 80;
  const tol = opts.tol !== undefined ? opts.tol : 1e-9;

  // Startwerte: vorausberechnetes Gitter oder (je Fläche gecacht) die
  // Knotenspan-Abtastung
  const src = (opts.samples && opts.samples.length)
    ? opts.samples
    : spanSamples(S, opts.grid !== undefined ? opts.grid : 8);
  let bi = 0;
  let bd = Infinity;
  for (let i = 0; i < src.length; i++) {
    const q = src[i].p;
    const dx = q[0] - p[0];
    const dy = q[1] - p[1];
    const dz = q[2] - p[2];
    const d = dx * dx + dy * dy + dz * dz;
    if (d < bd) { bd = d; bi = i; }
  }
  if (!src.length) return { u: u0, v: v0, x: evalSurface(S, u0, v0), dist: Infinity };

  // Gauß-Newton aus einem Startwert (geklemmt, mit Längensuche)
  const refine = (us, vs) => {
    let u = us;
    let v = vs;
    let cur = len(sub(evalSurface(S, u, v), p));
    for (let it = 0; it < iters; it++) {
      const x = evalSurface(S, u, v);
      const r = sub(p, x);
      const d = surfaceDerivs(S, u, v);
      const a = dot(d.Su, d.Su);
      const b = dot(d.Su, d.Sv);
      const c = dot(d.Sv, d.Sv);
      const e1 = dot(d.Su, r);
      const e2 = dot(d.Sv, r);
      const det = a * c - b * b;
      if (!(Math.abs(det) > 1e-300)) break;
      let step = 1;
      let improved = false;
      for (let k = 0; k < 14; k++) {
        const du = (step * (c * e1 - b * e2)) / det;
        const dv = (step * (a * e2 - b * e1)) / det;
        const nu = Math.min(Math.max(u + du, u0), u1);
        const nv = Math.min(Math.max(v + dv, v0), v1);
        const nd = len(sub(evalSurface(S, nu, nv), p));
        if (nd < cur) {
          const impr = cur - nd;
          u = nu; v = nv; cur = nd; improved = true;
          if (impr < 1e-16) { it = iters; }
          break;
        }
        step *= 0.5;
      }
      if (!improved) break;
    }
    const x = evalSurface(S, u, v);
    return { u, v, x, dist: len(sub(x, p)) };
  };

  let best = refine(src[bi].u, src[bi].v);
  if (best.dist > tol) {
    // weitere Startwerte — nur solche, die verschiedene Punkte sind (an einer
    // Polseite fallen alle Startwerte einer Zeile auf denselben Punkt)
    const used = [best.x];
    for (let i = 0; i < src.length && used.length < 8; i++) {
      const q = src[i].p;
      if (used.some((w) => Math.abs(w[0] - q[0]) + Math.abs(w[1] - q[1]) + Math.abs(w[2] - q[2]) < 1e-9)) continue;
      used.push(q);
      const r = refine(src[i].u, src[i].v);
      if (r.dist < best.dist) best = r;
      if (best.dist <= tol) break;
    }
    // Rand-Isokurven: 1-D auf der Kurve (dort liegt der Punkt exakt), dann 2-D
    if (best.dist > tol) {
      for (const m of boundaryMinima(S, p)) {
        const r = refine(m.u, m.v);
        if (r.dist < best.dist) best = r;
        if (best.dist <= tol) break;
      }
    }
  }
  return best;
}

// ── Kurven auf analytischen Flächen ─────────────────────────────────────────

// größter Abstand einer Kurve zur Fläche (Zwischenparameter je Span)
function curveSdistMax(surf, c) {
  const spans = c.params && c.params.length > 1 ? c.params : [domain(c)[0], domain(c)[1]];
  let m = 0;
  for (let i = 0; i < spans.length - 1; i++) {
    const u0 = spans[i];
    const u1 = spans[i + 1];
    for (let k = 1; k <= 8; k++) {
      const e = evalCurve(c, u0 + ((u1 - u0) * k) / 9);
      const err = Math.abs(sdist(surf, e));
      if (err > m) m = err;
    }
  }
  return m;
}

// Kurve auf EINER analytischen Fläche (Ebene/Zylinder/Kegel/Kugel/Torus):
// Führungspunkte werden auf die Fläche projiziert, kubisch interpoliert und
// der Restfehler geprüft. Rückgabe { curve } oder { fail: … }.
export function fitCurveOnSurface(surf, p, q, guides, opts = {}) {
  const tol = opts.tol !== undefined ? opts.tol : 5e-7;
  const maxShift = opts.maxShift !== undefined ? opts.maxShift : 0.5;
  const maxPts = opts.maxPts !== undefined ? opts.maxPts : 129;
  // Endpunkte müssen auf der Fläche liegen
  if (Math.abs(sdist(surf, p)) > 1e-9) return { fail: 'ends' };
  if (Math.abs(sdist(surf, q)) > 1e-9) return { fail: 'ends' };
  // Polylinie Q = [p, ...Führungspunkte, q]
  const poly = [p];
  if (guides) for (const g of guides) poly.push(g);
  poly.push(q);
  const cum = arcLengths(poly);
  const Ls = cum[cum.length - 1];
  if (!(Ls > 1e-12)) return { fail: 'degenerate' };
  // Stufen: n = 4, 8, …, 128 Stützpunkte (n+1 Punkte insgesamt)
  const NS = [4, 8, 16, 32, 64, 128];
  let last = -1;
  for (let i = 0; i < NS.length; i++) if (NS[i] + 1 <= maxPts) last = i;
  if (last < 0) return { fail: 'maxPts', detail: maxPts };
  const proj = new Map();
  let maxErr = Infinity;
  for (let lvl = 0; lvl <= last; lvl++) {
    const n = NS[lvl];
    const pts = [p];
    for (let i = 1; i < n; i++) {
      const key = i / n; // n sind Zweierpotenzen → Schlüssel sind stabil
      let x = proj.get(key);
      if (!x) {
        const s = (i * Ls) / n;
        const x0 = polyPointAt(poly, cum, s);
        x = project(surf, x0);
        const shift = len(sub(x, x0));
        if (shift > maxShift) return { fail: 'shift', detail: shift };
        proj.set(key, x);
      }
      pts.push(x);
    }
    pts.push(q);
    // Faltung: aufeinanderfolgende Stützpunkte müssen fortschreiten
    for (let i = 1; i < pts.length - 1; i++) {
      const d1 = sub(pts[i], pts[i - 1]);
      const d2 = sub(pts[i + 1], pts[i]);
      if (len(d1) > 1e-9 && len(d2) > 1e-9 && dot(d1, d2) <= 0) {
        return { fail: 'fold', detail: i, pts };
      }
    }
    const c = interpCubic(pts);
    if (!c) return { fail: 'interp' };
    c.ctrl[0] = p.slice();                              // Endpunkte exakt
    c.ctrl[c.ctrl.length - 1] = q.slice();
    maxErr = curveSdistMax(surf, c);
    // Sicherheitsreserve, solange eine feinere Stufe folgt
    const need = lvl === last ? tol : tol * 0.25;
    if (maxErr <= need) return { curve: c, pts };
  }
  return { fail: 'maxPts', detail: maxPts, err: maxErr };
}

// Freiraumkurve zwischen zwei Blend-Patches: Stützpunkte in gleicher
// Bogenlänge entlang [p, ...guides, q], kubisch interpoliert.
export function interpPolyline(p, q, guides, opts = {}) {
  const maxPts = opts.maxPts !== undefined ? opts.maxPts : 17;
  const poly = [p];
  if (guides) for (const g of guides) poly.push(g);
  poly.push(q);
  const cum = arcLengths(poly);
  const Ls = cum[cum.length - 1];
  const n = Math.max(2, maxPts);
  const pts = [];
  for (let i = 0; i < n; i++) {
    const s = (i * Ls) / (n - 1);
    pts.push(polyPointAt(poly, cum, s));
  }
  pts[0] = p.slice();
  pts[n - 1] = q.slice();
  const c = interpCubic(pts);
  if (!c) return null;
  c.ctrl[0] = p.slice();
  c.ctrl[c.ctrl.length - 1] = q.slice();
  return c;
}

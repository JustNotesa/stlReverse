// ─────────────────────────────────────────────────────────────────────────────
// spline-fit.js — EXAKTE kubische B-Spline-INTERPOLATION durch Netzpunkte.
//
// ENTWURF
// Die Wand eines erhabenen oder vertieften Schriftzugs ist ein schmaler Streifen: die
// Ober- und Unterkante (bzw. die beiden Seitenkanten) des Schriftzugs sind Polygonzüge aus
// Netzpunkten. Im STEP-Export sollen diese Wände als SURFACE_OF_LINEAR_EXTRUSION über einer
// B_SPLINE_CURVE_WITH_KNOTS geschrieben werden, statt facettiert zu bleiben.
//
// Dafür braucht man eine Kurve, die (a) EXAKT durch die Netzpunkte läuft — der Importer prüft
// die Kantenexaktheit zwischen STL-Kante und Modell-Kante mit ~1e-6 mm — und (b) an beiden
// Enden auf den Netz-Ecken beginnt und endet.
//
// Globaler Interpolations-Spline (geklemmt, Grad p = min(3, n−1)):
//   Parameter: zentripetal (√ der Sehnenlänge) als Vorgabe. Bei stark ungleichmäßiger
//   Punktdichte (0.02 mm Abstand neben 0.5 mm) vermeidet das die Überschwinger der
//   gleichmäßigen Parametrisierung. 'chord' (Sehnenlänge) ist wählbar. Die Parameter werden
//   auf [0, L] normiert (L = Gesamt-Sehnenlänge in mm) — u_0 = 0, u_{n−1} = L.
//   Knotenvektor: geklemmt, die inneren Knoten sind nach Piegl/Tiller Gl. (9.8) („averaging")
//   die Mittelwerte der benachbarten Parameter → gut konditionierte Kollokationsmatrix.
//   Kollokation N·Ctrl = Q mit N[k][i] = N_{i,p}(u_k) — quadratisch (n×n), gelöst per LU mit
//   Spaltenpivotisierung. Die Lösung ist exakt (Restfehler ~1e-13 mm).
//   Die Randkontrollpunkte werden danach als BIT-IDENTISCHE KOPIEN des ersten/letzten
//   Eingabepunktes gesetzt → der STEP-Kurvenanfang liegt exakt auf der Netz-Ecke.
//
// Bewusst KEINE Glättung und KEINE Approximation: die Netzpunkte sind die Wahrheit, die
// Kurve ist nur ihre exakte, glatte Verbindung.
// ─────────────────────────────────────────────────────────────────────────────

/** Mindestabstand zweier aufeinanderfolgender Punkte (mm) — darunter ist die Parametrisierung unbestimmt. */
const MIN_STEP = 1e-9;
/** Zwei Knoten, die näher als dies beieinander liegen, gelten als derselbe Knoten. */
const KNOT_EPS = 1e-12;
/** Relative Schwelle für einen Pivot (Singuläritäts-Test). */
const PIV_REL = 1e-13;

const dist3 = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);

// ── Basisfunktionen / de Boor ───────────────────────────────────────────────

/**
 * Span (Knotenintervall-Index) zu u: der größte Index k mit U[k] ≤ u < U[k+1].
 * Randfälle: u ≥ U[nCtrl] → letzter Span, u ≤ U[p] → erster Span.
 */
function findSpan(u, p, U, nCtrl) {
  if (u >= U[nCtrl]) return nCtrl - 1;
  if (u <= U[p]) return p;
  let low = p, high = nCtrl;
  while (high - low > 1) {
    const mid = (low + high) >> 1;
    if (u < U[mid]) high = mid; else low = mid;
  }
  return low;
}

/**
 * Basisfunktionen N_{span−p,p} … N_{span,p} an der Stelle u (Piegl/Tiller A2.2).
 * out[j] ↔ N_{span−p+j, p}(u); out wird überschrieben.
 */
function basisFuns(span, u, p, U, out) {
  const left = new Array(p + 1);
  const right = new Array(p + 1);
  out[0] = 1;
  left[0] = 0; right[0] = 0;
  for (let j = 1; j <= p; j++) {
    left[j] = u - U[span + 1 - j];
    right[j] = U[span + j] - u;
    let saved = 0;
    for (let r = 0; r < j; r++) {
      const den = right[r + 1] + left[j - r];
      const temp = den !== 0 ? out[r] / den : 0;      // entarteter Knoten → 0
      out[r] = saved + right[r + 1] * temp;
      saved = left[j - r] * temp;
    }
    out[j] = saved;
  }
}

/**
 * Kurvenpunkt per de Boor (Piegl/Tiller A2.1) für beliebige (Grad, Knotenvektor, Kontroll-
 * punkte). u wird auf das gültige Intervall [U[p], U[n]] geklemmt; an den Rändern werden die
 * Randkontrollpunkte EXAKT zurückgegeben.
 */
function evalCurve(deg, U, ctrl, u) {
  const n = ctrl.length;
  const lo = U[deg], hi = U[U.length - deg - 1];
  let t = Number.isFinite(u) ? u : lo;
  if (t <= lo) return ctrl[0].slice();
  if (t >= hi) return ctrl[n - 1].slice();
  const span = findSpan(t, deg, U, n);
  // Skalare Arbeitsarrays statt Array-of-Arrays: spart je Kurvenpunkt (deg+1) Punkt-Arrays.
  // Hot-Path ist nearestParam (Raster + Golden-Section) — dort wird extrem oft evaluiert.
  const dx = new Array(deg + 1), dy = new Array(deg + 1), dz = new Array(deg + 1);
  for (let j = 0; j <= deg; j++) {
    const c = ctrl[span - deg + j];
    dx[j] = c[0]; dy[j] = c[1]; dz[j] = c[2];
  }
  for (let r = 1; r <= deg; r++) {
    for (let j = deg; j >= r; j--) {
      const den = U[span + 1 + j - r] - U[span - deg + j];
      const alpha = den !== 0 ? (t - U[span - deg + j]) / den : 0;
      // d[j−1] und d[j] VOR dem Überschreiben von d[j] lesen (j läuft abwärts).
      const ax = dx[j - 1], bx = dx[j];
      const ay = dy[j - 1], by = dy[j];
      const az = dz[j - 1], bz = dz[j];
      dx[j] = (1 - alpha) * ax + alpha * bx;
      dy[j] = (1 - alpha) * ay + alpha * by;
      dz[j] = (1 - alpha) * az + alpha * bz;
    }
  }
  return [dx[deg], dy[deg], dz[deg]];      // Ergebnis der de-Boor-Rekursion
}

// ── Lineares System ─────────────────────────────────────────────────────────

/**
 * Dichtes System A·X = B per LU mit Spaltenpivotisierung (A wird in-place zerlegt).
 * B: Array von n rechtseiten-Vektoren (Länge n), die in-place zur Lösung überschrieben werden.
 * → true bei Erfolg, false bei Singulärität oder nicht-endlichem Ergebnis.
 */
function luSolve(A, B, n) {
  // Maßstab der Matrix (die Kollokationsmatrix hat Einträge in [0,1])
  let scale = 0;
  for (let i = 0; i < n; i++) {
    const Ai = A[i];
    for (let j = 0; j < n; j++) { const v = Math.abs(Ai[j]); if (v > scale) scale = v; }
  }
  if (!(scale > 0) || !Number.isFinite(scale)) return false;
  const tol = PIV_REL * scale;
  for (let k = 0; k < n; k++) {
    // Pivot in der Spalte k suchen
    let piv = k, maxv = Math.abs(A[k][k]);
    for (let i = k + 1; i < n; i++) {
      const v = Math.abs(A[i][k]);
      if (v > maxv) { maxv = v; piv = i; }
    }
    if (!(maxv > tol) || !Number.isFinite(maxv)) return false;   // singulär
    if (piv !== k) {
      const t = A[piv]; A[piv] = A[k]; A[k] = t;
      for (const r of B) { const s = r[piv]; r[piv] = r[k]; r[k] = s; }
    }
    const Ak = A[k], akk = Ak[k];
    for (let i = k + 1; i < n; i++) {
      const Ai = A[i];
      const f = Ai[k] / akk;
      Ai[k] = f;
      if (f === 0) continue;
      for (let j = k + 1; j < n; j++) Ai[j] -= f * Ak[j];
      for (const r of B) r[i] -= f * r[k];
    }
  }
  // Rückwärtsauflösen
  for (const r of B) {
    for (let i = n - 1; i >= 0; i--) {
      const Ai = A[i];
      let s = r[i];
      for (let j = i + 1; j < n; j++) s -= Ai[j] * r[j];
      s /= Ai[i];
      if (!Number.isFinite(s)) return false;
      r[i] = s;
    }
  }
  return true;
}

// ── Haupt-API ───────────────────────────────────────────────────────────────

/**
 * Kubische B-Spline-INTERPOLATION durch pts (n ≥ 2 Punkte [x,y,z]).
 *
 * opts.param: 'centripetal' (Vorgabe) | 'chord' — Parametrisierung der Stützpunkte.
 *
 * Rückgabe:
 *   { degree, ctrl, U, knots, mults, params }
 *   ctrl:  n Kontrollpunkte [x,y,z]; ctrl[0] und ctrl[n−1] sind bit-identische Kopien der
 *          ersten/letzten Eingabepunkte.
 *   U:     vollständiger Knotenvektor (Länge n + degree + 1), geklemmt.
 *   knots: verschiedene Knotenwerte (aufsteigend), mults: deren Vielfachheiten.
 *   params:die Stützpunkt-Parameter u_0 … u_{n−1} (auf [0, L] normiert).
 *
 * → null bei n < 2, nicht-endlichen Koordinaten, zwei aufeinanderfolgenden Punkten näher als
 *   1e-9 mm oder einem singulären/nicht-endlichen Lösungsergebnis.
 */
export function interpolateCubic(pts, opts = {}) {
  const o = opts || {};
  if (!Array.isArray(pts) || pts.length < 2) return null;
  const n = pts.length;

  // Eingaben prüfen und kopieren
  const P = new Array(n);
  for (let k = 0; k < n; k++) {
    const q = pts[k];
    if (!q || q.length < 3) return null;
    if (!Number.isFinite(q[0]) || !Number.isFinite(q[1]) || !Number.isFinite(q[2])) return null;
    P[k] = [q[0], q[1], q[2]];
  }

  // Sehnenlängen (und Mindestabstand prüfen)
  const seg = new Array(n - 1);
  let L = 0;
  for (let k = 0; k + 1 < n; k++) {
    const l = dist3(P[k], P[k + 1]);
    if (!(l >= MIN_STEP)) return null;            // Duplikat / zu dicht beieinander
    seg[k] = l;
    L += l;
  }
  if (!(L > 0) || !Number.isFinite(L)) return null;

  // ── Stützpunkt-Parameter ──────────────────────────────────────────────────
  const centripetal = o.param !== 'chord';
  const params = new Array(n);
  params[0] = 0;
  let acc = 0;
  for (let k = 1; k < n; k++) {
    acc += centripetal ? Math.sqrt(seg[k - 1]) : seg[k - 1];
    params[k] = acc;
  }
  if (!(acc > 0)) return null;
  const scale = L / acc;                          // auf [0, L] normieren (u_0 = 0, u_{n−1} = L)
  for (let k = 1; k < n; k++) params[k] *= scale;
  params[0] = 0;
  params[n - 1] = L;

  // ── Knotenvektor (geklemmt, Piegl/Tiller Gl. 9.8 „averaging") ────────────
  const p = Math.min(3, n - 1);
  const U = new Array(n + p + 1);
  for (let i = 0; i <= p; i++) U[i] = params[0];
  for (let j = 1; j <= n - p - 1; j++) {
    let s = 0;
    for (let i = j; i <= j + p - 1; i++) s += params[i];
    U[p + j] = s / p;
  }
  for (let i = 0; i <= p; i++) U[n + i] = params[n - 1];

  // ── Kollokationsmatrix N[k][i] = N_{i,p}(u_k) ─────────────────────────────
  const M = new Array(n);
  const basis = new Array(p + 1);
  for (let k = 0; k < n; k++) {
    const row = new Float64Array(n);
    const span = findSpan(params[k], p, U, n);
    basisFuns(span, params[k], p, U, basis);
    for (let j = 0; j <= p; j++) {
      const i = span - p + j;
      if (i >= 0 && i < n) row[i] = basis[j];
    }
    M[k] = row;
  }

  // ── Lösung N·Ctrl = Q ────────────────────────────────────────────────────
  // Um den Schwerpunkt verschieben: das entkoppelt die Lösung von der Lage im Raum
  // (große Koordinatenwerte, z. B. 200 mm, würden sonst die Genauigkeit auffressen).
  const c = [0, 0, 0];
  for (const q of P) { c[0] += q[0]; c[1] += q[1]; c[2] += q[2]; }
  c[0] /= n; c[1] /= n; c[2] /= n;
  const rhs = [new Float64Array(n), new Float64Array(n), new Float64Array(n)];
  for (let k = 0; k < n; k++) {
    rhs[0][k] = P[k][0] - c[0];
    rhs[1][k] = P[k][1] - c[1];
    rhs[2][k] = P[k][2] - c[2];
  }
  if (!luSolve(M, rhs, n)) return null;

  const ctrl = new Array(n);
  for (let k = 0; k < n; k++) {
    ctrl[k] = [rhs[0][k] + c[0], rhs[1][k] + c[1], rhs[2][k] + c[2]];
  }
  // Die Randkontrollpunkte EXAKT auf die Eingabepunkte setzen (bit-identische Kopien).
  ctrl[0] = P[0].slice();
  ctrl[n - 1] = P[n - 1].slice();

  // ── Verschiedene Knoten und ihre Vielfachheiten ──────────────────────────
  const knots = [];
  const mults = [];
  for (let i = 0; i < U.length; i++) {
    const v = U[i];
    if (knots.length && Math.abs(v - knots[knots.length - 1]) < KNOT_EPS) {
      mults[mults.length - 1]++;
    } else {
      knots.push(v);
      mults.push(1);
    }
  }

  return { degree: p, ctrl, U, knots, mults, params };
}

/**
 * Kurvenpunkt zu u (de Boor). u wird auf [U[p], U[n]] geklemmt; am Ende des Intervalls wird
 * der letzte Kontrollpunkt EXAKT zurückgegeben.
 * → [x,y,z] | null (ungültige Kurve)
 */
export function evalSpline(sp, u) {
  if (!sp || !sp.ctrl || !sp.ctrl.length || !sp.U) return null;
  return evalCurve(sp.degree, sp.U, sp.ctrl, u);
}

/**
 * Erste Ableitung dC/du (Hodograph: Ableitungs-Kontrollpunkte, Grad p−1, Knoten U ohne
 * Randknoten). u wie bei evalSpline geklemmt.
 * → [dx,dy,dz] | null
 */
export function derivSpline(sp, u) {
  if (!sp || !sp.ctrl || !sp.ctrl.length || !sp.U) return null;
  const p = sp.degree;
  const ctrl = sp.ctrl, U = sp.U, n = ctrl.length;
  if (p < 1) return [0, 0, 0];
  // Ableitungs-Kontrollpunkte: Q_i = p·(P_{i+1} − P_i)/(U_{i+p+1} − U_{i+1})
  const dctrl = new Array(n - 1);
  for (let i = 0; i + 1 < n; i++) {
    const den = U[i + p + 1] - U[i + 1];
    const f = den !== 0 ? p / den : 0;
    dctrl[i] = [
      f * (ctrl[i + 1][0] - ctrl[i][0]),
      f * (ctrl[i + 1][1] - ctrl[i][1]),
      f * (ctrl[i + 1][2] - ctrl[i][2]),
    ];
  }
  // Knotenvektor der Ableitung: U ohne den ersten und den letzten Knoten
  const dU = U.slice(1, U.length - 1);
  return evalCurve(p - 1, dU, dctrl, u);
}

/**
 * n+1 gleichmäßig verteilte Punkte auf der Kurve (u von U[p] bis U[n]).
 * Das erste und das letzte Element sind EXAKTE Kopien des ersten/letzten Kontrollpunktes.
 * → [[x,y,z], …]
 */
export function splineSamples(sp, n) {
  if (!sp || !sp.ctrl || !sp.ctrl.length || !sp.U) return [];
  const cnt = Math.max(1, n | 0);
  const lo = sp.U[sp.degree], hi = sp.U[sp.U.length - sp.degree - 1];
  const out = new Array(cnt + 1);
  for (let i = 0; i <= cnt; i++) {
    if (i === 0) out[i] = sp.ctrl[0].slice();
    else if (i === cnt) out[i] = sp.ctrl[sp.ctrl.length - 1].slice();
    else out[i] = evalSpline(sp, lo + (hi - lo) * (i / cnt));
  }
  return out;
}

/** Abstand eines Punktes q von der Strecke a–b (mm). */
function pointSegmentDistance(q, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
  const len2 = dx * dx + dy * dy + dz * dz;
  let t = 0;
  if (len2 > 0) {
    t = ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy + (q[2] - a[2]) * dz) / len2;
    if (t < 0) t = 0; else if (t > 1) t = 1;
  }
  const ex = a[0] + t * dx - q[0];
  const ey = a[1] + t * dy - q[1];
  const ez = a[2] + t * dz - q[2];
  return Math.hypot(ex, ey, ez);
}

/**
 * Abweichung der Kurve von den SEHREN zwischen den Eingabepunkten: je Span i der größte
 * Abstand der Kurve (k inneren Stützstellen zwischen den Parametern params[i] und params[i+1])
 * von der Strecke pts[i]–pts[i+1].
 * sp muss das Ergebnis von interpolateCubic(pts) sein (nutzt sp.params).
 * → devs[i] (mm), Länge pts.length − 1
 */
export function spanDeviation(sp, pts, k = 8) {
  const devs = [];
  if (!sp || !sp.params || !Array.isArray(pts) || pts.length < 2) return devs;
  const cnt = Math.max(1, k | 0);
  for (let i = 0; i + 1 < pts.length; i++) {
    const u0 = sp.params[i], u1 = sp.params[i + 1];
    let worst = 0;
    for (let j = 1; j <= cnt; j++) {
      const u = u0 + (u1 - u0) * (j / (cnt + 1));     // innere Stützstellen
      const q = evalSpline(sp, u);
      if (!q) continue;
      const d = pointSegmentDistance(q, pts[i], pts[i + 1]);
      if (d > worst) worst = d;
    }
    devs.push(worst);
  }
  return devs;
}

/**
 * Kopie der Kurve, um v verschoben;_ctrl[0] = A und ctrl[letzter] = B, falls angegeben.
 * Knoten, Vielfachheiten und Parameter werden unverändert übernommen.
 * → neue Kurve | null
 */
export function translateSpline(sp, v, A, B) {
  if (!sp || !sp.ctrl || !sp.U) return null;
  const d = v || [0, 0, 0];
  const ctrl = sp.ctrl.map((q) => [q[0] + d[0], q[1] + d[1], q[2] + d[2]]);
  if (A) ctrl[0] = A.slice();
  if (B) ctrl[ctrl.length - 1] = B.slice();
  return {
    degree: sp.degree,
    ctrl,
    U: sp.U.slice(),
    knots: sp.knots ? sp.knots.slice() : [],
    mults: sp.mults ? sp.mults.slice() : [],
    params: sp.params ? sp.params.slice() : [],
  };
}

/**
 * Grob-Raster (cnt+1 Stützstellen) je Spline zwischenspeichern: nearestParam wird beim
 * Bandaufbau viele Male auf derselben Kurve aufgerufen, das Raster selbst ändert sich dabei
 * nie. WeakMap → der Eintrag stirbt mit der Kurve.
 */
const gridCache = new WeakMap();

/**
 * Parameter u, bei dem die Kurve dem Punkt p am nächsten liegt: grober Raster-Scan über n
 * Stützstellen, danach Golden-Section-Verfeinerung im Nachbarintervall.
 * → u | null
 */
export function nearestParam(sp, p, n = 200) {
  if (!sp || !p || !sp.ctrl || !sp.U) return null;
  const cnt = Math.max(2, n | 0);
  const lo = sp.U[sp.degree], hi = sp.U[sp.U.length - sp.degree - 1];
  // Raster holen; neu bauen, wenn Kurve oder Rasterweite gegenüber dem Cache-Eintrag wechselten.
  let grid = gridCache.get(sp);
  if (!grid || grid.ctrl !== sp.ctrl || grid.U !== sp.U
      || grid.degree !== sp.degree || grid.cnt !== cnt) {
    const gus = new Array(cnt + 1);
    const gq = new Float64Array(3 * (cnt + 1));
    for (let i = 0; i <= cnt; i++) {
      const u = lo + (hi - lo) * (i / cnt);
      gus[i] = u;
      const c = evalSpline(sp, u);
      gq[3 * i] = c[0]; gq[3 * i + 1] = c[1]; gq[3 * i + 2] = c[2];
    }
    grid = { ctrl: sp.ctrl, U: sp.U, degree: sp.degree, cnt, us: gus, q: gq };
    gridCache.set(sp, grid);
  }
  const us = grid.us, q = grid.q;
  const distAt = (u) => {
    const s = evalSpline(sp, u);
    return Math.hypot(s[0] - p[0], s[1] - p[1], s[2] - p[2]);
  };
  let bestIdx = 0, bestD = Infinity;
  for (let i = 0; i <= cnt; i++) {
    const d = Math.hypot(q[3 * i] - p[0], q[3 * i + 1] - p[1], q[3 * i + 2] - p[2]);
    if (d < bestD) { bestD = d; bestIdx = i; }
  }
  // Golden-Section im Intervall um die beste Rasterstelle
  let a = us[Math.max(0, bestIdx - 1)];
  let b = us[Math.min(cnt, bestIdx + 1)];
  const phi = (Math.sqrt(5) - 1) / 2;
  let c = b - phi * (b - a), d = a + phi * (b - a);
  let fc = distAt(c), fd = distAt(d);
  for (let it = 0; it < 80 && (b - a) > 1e-14 * Math.max(1, Math.abs(b)); it++) {
    if (fc < fd) {
      b = d; d = c; fd = fc;
      c = b - phi * (b - a);
      fc = distAt(c);
    } else {
      a = c; c = d; fc = fd;
      d = a + phi * (b - a);
      fd = distAt(d);
    }
  }
  const uBest = fc < fd ? c : d;
  return distAt(uBest) <= bestD ? uBest : us[bestIdx];
}

// ─────────────────────────────────────────────────────────────────────────────
// freeform-geom.js — Geometrie-Kern des Freiform-Pfads (Etappe 1).
//
// Datenmodell (Flächen/Kurven) laut Kopf freeform-brep.js — bindend:
//   Fläche { type:'plane',    o, n }
//          { type:'cylinder', o, a, R }
//          { type:'cone',     apex, a, alpha }
//          { type:'sphere',   c, R }
//          { type:'torus',    c, a, Rm, r }
//   Kurve  { type:'line', p, d } | { type:'circle', c, a, R, x }
//          { type:'bspline', degree, ctrl, knots, mults }
//
// sdist(s,p) = vorzeichenbehafteter euklidischer Abstand, + auf der Seite der
// natürlichen Normale. Alle Zahlen in mm. Reine Funktionen, keine Ausgabe.
// ─────────────────────────────────────────────────────────────────────────────

// ── Vektoren ────────────────────────────────────────────────────────────────

export function add(a, b) {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function sub(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function mul(a, s) {
  return [a[0] * s, a[1] * s, a[2] * s];
}

export function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

export function len(a) {
  return Math.hypot(a[0], a[1], a[2]);
}

export function norm(a) {
  const l = len(a);
  return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
}

// beliebige Einheitsrichtung senkrecht zu a (a muss Einheitsvektor sein)
function perpTo(a) {
  const t = Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  return norm(sub(t, mul(a, dot(t, a))));
}

// ── Flächen-Geometrie ───────────────────────────────────────────────────────

// radiale Komponente (senkrecht zur Achse) bei Zylinder/Kegel/Torus
function radialOf(s, p) {
  const o = s.type === 'cone' ? s.apex : (s.type === 'torus' ? s.c : s.o);
  const w = sub(p, o);
  const h = dot(s.a, w);
  return { w, h, rad: sub(w, mul(s.a, h)) };
}

// Torus: Rohrmittelpunkt (Tube-Zentrum) zum Punkt p
function torusTube(s, p) {
  const w = sub(p, s.c);
  const h = dot(s.a, w);
  let rad = sub(w, mul(s.a, h));
  if (len(rad) < 1e-12) rad = perpTo(s.a); // Punkt auf der Achse
  const u = norm(rad);
  return { u, q: add(s.c, mul(u, s.Rm)) };
}

// Vorzeichenbehafteter Abstand zur Fläche
export function sdist(s, p) {
  switch (s.type) {
    case 'plane':
      return dot(sub(p, s.o), s.n);
    case 'cylinder': {
      const { rad } = radialOf(s, p);
      return len(rad) - s.R;
    }
    case 'sphere':
      return len(sub(p, s.c)) - s.R;
    case 'torus': {
      const { q } = torusTube(s, p);
      return len(sub(p, q)) - s.r;
    }
    case 'cone': {
      const { h, rad } = radialOf(s, p);
      const rho = len(rad);
      const ca = Math.cos(s.alpha);
      const sa = Math.sin(s.alpha);
      const s0 = rho * ca - h * sa;
      // Fußpunkt auf dem Kegelmantel nur gültig auf der Öffnungsseite
      if (rho * sa + h * ca >= 0) return s0;
      const w = sub(p, s.apex);
      return (s0 >= 0 ? 1 : -1) * len(w); // nächster Punkt ist die Spitze
    }
    default:
      return NaN;
  }
}

// Natürliche Normale (Gradient von sdist) am nächstgelegenen Flächenpunkt
export function normalAt(s, p) {
  switch (s.type) {
    case 'plane':
      return s.n;
    case 'cylinder': {
      const { rad } = radialOf(s, p);
      return len(rad) > 1e-12 ? norm(rad) : perpTo(s.a);
    }
    case 'sphere':
      return norm(sub(p, s.c));
    case 'torus': {
      const { q } = torusTube(s, p);
      return norm(sub(p, q));
    }
    case 'cone': {
      const { rad } = radialOf(s, p);
      const u = norm(rad);
      return sub(mul(u, Math.cos(s.alpha)), mul(s.a, Math.sin(s.alpha)));
    }
    default:
      return [0, 0, 0];
  }
}

// Orthogonale Projektion des Punktes auf die Fläche
export function project(s, p) {
  const d = sdist(s, p);
  const n = normalAt(s, p);
  return sub(p, mul(n, d));
}

// ── Lineares Algebra ────────────────────────────────────────────────────────

// Gauß-Elimination mit Spaltenpivotisierung; A wird nicht verändert
function solveLinear(Ain, bin) {
  const n = bin.length;
  const M = [];
  for (let i = 0; i < n; i++) {
    const row = new Float64Array(n + 1);
    for (let j = 0; j < n; j++) row[j] = Ain[i][j];
    row[n] = bin[i];
    M.push(row);
  }
  for (let col = 0; col < n; col++) {
    let piv = col;
    let best = Math.abs(M[col][col]);
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs(M[r][col]);
      if (v > best) { best = v; piv = r; }
    }
    if (!(best > 1e-300)) return null; // singulär
    if (piv !== col) { const t = M[piv]; M[piv] = M[col]; M[col] = t; }
    const d = M[col][col];
    for (let r = col + 1; r < n; r++) {
      const f = M[r][col] / d;
      if (f === 0) continue;
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  const x = new Float64Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let c = r + 1; c < n; c++) s -= M[r][c] * x[c];
    x[r] = s / M[r][r];
  }
  return x;
}

// ── Schnittpunkt mehrerer Flächen ───────────────────────────────────────────

function maxRes(surfs, x) {
  let m = 0;
  for (const s of surfs) {
    const r = Math.abs(sdist(s, x));
    if (r > m) m = r;
  }
  return m;
}

// Levenberg-Marquardt mit Minimalnorm-Schritt: sucht x mit sdist_i(x)=0
export function projectMulti(surfs, x0, opts = {}) {
  const maxIter = opts.maxIter !== undefined ? opts.maxIter : 200;
  const tol = opts.tol !== undefined ? opts.tol : 1e-12;
  const k = surfs.length;
  if (k === 0) return { x: [x0[0], x0[1], x0[2]], res: 0, iters: 0, ok: true };
  if (k === 1) {
    const x = project(surfs[0], x0);
    const res = Math.abs(sdist(surfs[0], x));
    return { x, res, iters: 1, ok: res <= 1e-10 };
  }
  let x = [x0[0], x0[1], x0[2]];
  let lam = 1e-12;
  let iters = 0;
  let cur = maxRes(surfs, x);
  while (iters < maxIter && cur > tol) {
    const r = [];
    const J = [];
    for (const s of surfs) {
      r.push(sdist(s, x));
      J.push(normalAt(s, x));
    }
    for (let tries = 0; tries < 40; tries++) {
      // (J Jᵀ + λI) y = r
      const A = [];
      for (let i = 0; i < k; i++) {
        const row = new Float64Array(k);
        for (let j = 0; j < k; j++) {
          let acc = 0;
          for (let d = 0; d < 3; d++) acc += J[i][d] * J[j][d];
          row[j] = i === j ? acc + lam : acc;
        }
        A.push(row);
      }
      const y = solveLinear(A, r);
      if (!y) { lam *= 10; continue; }
      // dx = -Jᵀ y
      const dx = [0, 0, 0];
      for (let i = 0; i < k; i++) {
        for (let d = 0; d < 3; d++) dx[d] -= J[i][d] * y[i];
      }
      const xn = [x[0] + dx[0], x[1] + dx[1], x[2] + dx[2]];
      const rn = maxRes(surfs, xn);
      if (rn < cur) {
        x = xn;
        cur = rn;
        lam = Math.max(lam / 10, 1e-15);
        break; // Schritt angenommen
      }
      lam *= 10; // Schritt ablehnen, stärker dämpfen
    }
    iters++;
  }
  return { x, res: cur, iters, ok: cur <= 1e-10 };
}

// ── Analytische Schnittkurven ───────────────────────────────────────────────

// Toleranzen der Strukturprüfungen (Endprüfung: 16 Stützpunkte, VERIFY_TOL absolut):
// STL-Daten sind float32 — bei 10–30 mm Kantenlänge liegt das Rauschen bei
// ~1e-6 mm. An tangentialen Berührungen (Kugel↔Zylinder, Torus↔Ebene) ist die
// Lage einer projizierten Ecke axial nur quadratisch genau (Rest ~1e-13 mm →
// ~3e-7 mm). Die Strukturprüfungen müssen das auffangen, das eigentliche
// Kriterium bleibt die Endprüfung (die eine falsche Kurve zurückweist).
const TOL_REL = 1e-6;      // relativ zur Modellgröße (Radius/Kantenlänge)
const VERIFY_TOL = 1e-7;   // Endprüfung: Abstand der Stützpunkte von beiden Flächen (mm)

// charakteristische Größe eines Flächenpaares (Radius, Kettenlänge)
function geomScale(A, B, p, q) {
  let s = 1;
  const d = len(sub(q, p));
  if (Number.isFinite(d)) s = Math.max(s, d);
  for (const x of [A, B]) {
    if (!x) continue;
    if (Number.isFinite(x.R)) s = Math.max(s, x.R);
    if (Number.isFinite(x.Rm)) s = Math.max(s, x.Rm);
  }
  return s;
}

// Drehachse einer Fläche (Richtung + Punkt auf der Achse)
function axisOf(s) {
  switch (s.type) {
    case 'plane': return { dir: s.n, point: null };
    case 'cylinder': return { dir: s.a, point: s.o };
    case 'cone': return { dir: s.a, point: s.apex };
    case 'sphere': return { dir: null, point: s.c };
    case 'torus': return { dir: s.a, point: s.c };
    default: return { dir: null, point: null };
  }
}

// Gemeinsame Drehachse zweier Flächen (null, wenn keine).
// Die Toleranzen sind relativ zur Modellgröße: nach dem Snap sind die Achsen
// exakt parallel, ohne Snap (echtes Teil) weichen sie um den Fit-Rest ab.
function commonAxis(A, B, scale = 1) {
  if (A.type === 'plane' && B.type === 'plane') return null; // zwei Ebenen: Linie
  const ax = axisOf(A);
  const bx = axisOf(B);
  const angTol = TOL_REL;                        // Winkel (sin) für "parallel"
  const posTol = TOL_REL * Math.max(1, scale);   // Abstand der Achsen (mm)
  let dir = null;
  if (ax.dir && bx.dir) {
    if (len(cross(ax.dir, bx.dir)) > angTol) return null; // nicht parallel
    dir = ax.dir;
  } else if (ax.dir) {
    dir = ax.dir;
  } else if (bx.dir) {
    dir = bx.dir;
  } else {
    // beide richtungslos (nur Kugeln): Achse durch beide Mittelpunkte
    if (A.type !== 'sphere' || B.type !== 'sphere') return null;
    const d = sub(bx.point, ax.point);
    if (len(d) <= 1e-9) return null;
    dir = norm(d);
  }
  let O = null;
  if (ax.point && bx.point) {
    const v = sub(bx.point, ax.point);
    const off = len(sub(v, mul(dir, dot(v, dir))));
    if (off > posTol) return null; // Punkte nicht auf einer Achse
    O = ax.point;
  } else if (ax.point) {
    O = ax.point;
  } else if (bx.point) {
    O = bx.point;
  } else {
    return null;
  }
  return { dir: norm(dir), O };
}

// Winkel eines Punktes um die Achse a, gemessen von x aus (0..2π)
function angleAround(x, a, centre, pt) {
  const v = sub(pt, centre);
  let th = Math.atan2(dot(cross(x, v), a), dot(x, v));
  if (th < 0) th += 2 * Math.PI;
  return th;
}

// 16 Stützpunkte auf der Kurve zwischen p und q (positiver Bogen bei Kreisen)
export function sampleCurve(curve, p, q) {
  const out = [];
  if (curve.type === 'line') {
    // die Gerade hat ihre eigene Richtung (bei Zylindern die Achse) — die
    // Stützpunkte folgen der KURVE, nicht der Sehne p→q
    const d = curve.d ? curve.d : sub(q, p);
    const L = len(sub(q, p));
    for (let i = 0; i < 16; i++) out.push(add(p, mul(d, (L * i) / 15)));
    return out;
  }
  // Kreis: Theta der Endpunkte in der (eventuell gespiegelten) Achse
  const thq = angleAround(curve.x, curve.a, curve.c, q);
  // Umlaufrichtung: Winkel werden rechtshändig in (x, a×x) gemessen
  const side = norm(cross(curve.a, curve.x));
  for (let i = 0; i < 16; i++) {
    const t = (thq * i) / 15;
    const ct = Math.cos(t);
    const st = Math.sin(t);
    out.push(add(curve.c, add(mul(curve.x, curve.R * ct), mul(side, curve.R * st))));
  }
  return out;
}

// Prüfung: alle Stützpunkte müssen auf beiden Flächen liegen
function curveOnSurfaces(A, B, curve, p, q) {
  for (const e of sampleCurve(curve, p, q)) {
    if (Math.abs(sdist(A, e)) > VERIFY_TOL) return false;
    if (Math.abs(sdist(B, e)) > VERIFY_TOL) return false;
  }
  return true;
}

// Analytische Schnittkurve A∩B zwischen p und q; m = Punkt nahe der Bogenmitte
export function analyticCurve(A, B, p, q, m) {
  // Modellgröße des Paares → Toleranzen relativ dazu (STL-Rauschen float32:
  // ~1e-6 mm bei 10–30 mm; an Tangentialpunkten axial nur quadratisch genau)
  const scale = geomScale(A, B, p, q);
  const posTol = TOL_REL * scale;
  // R1: zwei Ebenen → Gerade
  if (A.type === 'plane' && B.type === 'plane') {
    const d = sub(q, p);
    if (len(d) <= 1e-9) return null;
    const curve = { type: 'line', p: [p[0], p[1], p[2]], d: norm(d) };
    return curveOnSurfaces(A, B, curve, p, q) ? curve : null;
  }
  // R2: gemeinsame Drehachse → Kreis
  const ax = commonAxis(A, B, scale);
  if (ax) {
    const centre = add(ax.O, mul(ax.dir, dot(ax.dir, sub(p, ax.O))));
    const R = len(sub(p, centre));
    if (R > 1e-9) {
      // p und q auf demselben Kreis: gleiche axiale Lage und gleicher Radius
      const d1 = Math.abs(dot(ax.dir, sub(q, p)));
      const d2 = Math.abs(len(sub(q, centre)) - R);
      if (d1 < posTol && d2 < posTol) {
        const x = norm(sub(p, centre));
        let a = ax.dir;
        if (len(sub(p, q)) > 1e-9 && m) {
          const thq = angleAround(x, a, centre, q);
          const thm = angleAround(x, a, centre, m);
          if (thm > thq) a = mul(a, -1); // m liegt nicht auf dem positiven Bogen
        }
        const curve = { type: 'circle', c: centre, a, R, x };
        return curveOnSurfaces(A, B, curve, p, q) ? curve : null;
      }
    }
  }
  // R3: Gerade auf Zylindern (tangentiale Berührung). Die RICHTUNG kommt aus
  // der Fläche (Zylinderachse), nicht aus den Ecken: bei Tangentialpunkten
  // liegt eine projizierte Ecke axial nur ~1e-6 mm genau auf der Achse, die
  // Kante selbst ist dagegen exakt.
  const cylA = A.type === 'cylinder' ? A : null;
  const cylB = B.type === 'cylinder' ? B : null;
  if (cylA || cylB) {
    const cyl = cylA || cylB;
    const other = cylA ? B : A;
    const d = sub(q, p);
    const L = len(d);
    if (L > 1e-9) {
      let dir = null;
      if (other.type === 'plane') {
        // Ebene ⊥ Achse → Schnitt ist eine Gerade parallel zur Achse. Der
        // Winkel muss so klein sein, dass die Gerade über die Kettenlänge
        // innerhalb der Endprüfung (VERIFY_TOL) bleibt.
        if (Math.abs(dot(other.n, cyl.a)) * L < VERIFY_TOL) dir = cyl.a;
      } else if (other.type === 'cylinder') {
        if (len(cross(other.a, cyl.a)) * L < VERIFY_TOL) dir = cyl.a;
      }
      if (dir) {
        const dd = dot(dir, d) < 0 ? mul(dir, -1) : dir;   // Richtung v0 → v1
        const w = sub(q, p);
        const off = len(sub(w, mul(dd, dot(w, dd))));      // q quer zur Achse
        if (off < posTol) {
          const curve = { type: 'line', p: [p[0], p[1], p[2]], d: dd };
          return curveOnSurfaces(A, B, curve, p, q) ? curve : null;
        }
      }
    }
  }
  return null;
}

// ── B-Splines ───────────────────────────────────────────────────────────────

// Spannweite suchen: U[k] <= u < U[k+1], k in [degree, nCtrl-1]
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

// Knotenvektor in verschiedene Werte und Vielfachheiten zerlegen
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

// Global interpolierende B-Spline-Kurve durch alle Punkte (NURBS Book A9.1)
export function interpCubic(points) {
  const m = points.length;
  if (m < 2) return null;
  if (m === 2) {
    return {
      type: 'bspline',
      degree: 1,
      ctrl: [[points[0][0], points[0][1], points[0][2]], [points[1][0], points[1][1], points[1][2]]],
      knots: [0, 1],
      mults: [2, 2],
      params: [0, 1],
    };
  }
  const p = m === 3 ? 2 : 3;
  const N = m - 1; // Index des letzten Punktes
  // Parameter nach Sehnenlänge, normiert auf [0,1]
  const u = new Float64Array(m);
  for (let i = 1; i < m; i++) u[i] = u[i - 1] + len(sub(points[i], points[i - 1]));
  if (u[N] > 0) for (let i = 0; i < m; i++) u[i] /= u[N];
  // Knotenvektor: gemittelt (Gl. 9.8), an den Enden eingeklemmt
  const U = new Float64Array(N + p + 2);
  for (let i = 0; i <= p; i++) U[i] = 0;
  for (let i = N + 1; i <= N + p + 1; i++) U[i] = 1;
  for (let j = p + 1; j <= N; j++) {
    let acc = 0;
    for (let i = 0; i <= p; i++) acc += u[j - p + i];
    U[j] = acc / (p + 1);
  }
  // Interpolationssystem M Q = P mit M[j][i] = N_{i,p}(u_j)
  const rows = [];
  for (let j = 0; j < m; j++) {
    const b = basisAll(U, p, m, u[j]);
    rows.push(Array.from(b));
  }
  const ctrl = [];
  for (let d = 0; d < 3; d++) {
    const rhs = points.map((pt) => pt[d]);
    const sol = solveLinear(rows, rhs);
    if (!sol) return null;
    ctrl.push(Array.from(sol));
  }
  const pts = [];
  for (let i = 0; i < m; i++) pts.push([ctrl[0][i], ctrl[1][i], ctrl[2][i]]);
  const { knots, mults } = compressKnots(Array.from(U));
  return { type: 'bspline', degree: p, ctrl: pts, knots, mults, params: Array.from(u) };
}

// B-Spline-Kurve auswerten (de Boor), u wird auf [0,1] begrenzt
export function evalBspline(c, u) {
  const p = c.degree;
  const U = [];
  for (let i = 0; i < c.knots.length; i++) {
    for (let k = 0; k < c.mults[i]; k++) U.push(c.knots[i]);
  }
  const nCtrl = c.ctrl.length;
  const uu = Math.min(Math.max(u, U[0]), U[U.length - 1]);
  const span = findSpan(U, p, nCtrl, uu);
  const d = [];
  for (let j = 0; j <= p; j++) d.push([c.ctrl[span - p + j][0], c.ctrl[span - p + j][1], c.ctrl[span - p + j][2]]);
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

// ── Schnittkurve als B-Spline ───────────────────────────────────────────────

// Sicherheitsreserve des B-Spline-Fits: Anteil der Toleranz, bis zu dem eine
// Stufe schon als gut genug gilt (wenn noch eine feinere Stufe folgt)
const FIT_RESERVE = 0.25;

// Stützpunkt anhängen, wenn er nicht zu dicht am Vorgänger liegt (mindestens
// 1e-6 mm Abstand — sonst entstehen winzige Knotenintervalle im B-Spline)
function pushPoint(pts, p) {
  if (pts.length && len(sub(pts[pts.length - 1], p)) < 1e-6) return;
  pts.push(p);
}

// Punkt auf der Polylinie bei Bogenlänge s (stückweise linear)
function polyPointAt(poly, cum, s) {
  const last = poly.length - 1;
  if (s <= 0) return poly[0];
  if (s >= cum[last]) return poly[last];
  let i = 1;
  while (i < last && cum[i] < s) i++;
  const seg = cum[i] - cum[i - 1];
  const t = seg > 1e-15 ? (s - cum[i - 1]) / seg : 0;
  return add(poly[i - 1], mul(sub(poly[i], poly[i - 1]), t));
}

// größter Abstand der Kurve zu beiden Flächen (Prüfparameter je Span)
function curveResidual(A, B, c) {
  let m = 0;
  for (let i = 0; i < c.params.length - 1; i++) {
    const u0 = c.params[i];
    const u1 = c.params[i +1];
    for (let k = 1; k < 8; k++) {
      const e = evalBspline(c, u0 + (u1 - u0) * (k / 8));
      const err = Math.max(Math.abs(sdist(A, e)), Math.abs(sdist(B, e)));
      if (err > m) m = err;
    }
  }
  return m;
}

// Schnittkurve A∩B: analytisch, sonst B-Spline durch projizierte Stützpunkte.
//
// B-Spline-Teil: die Führungspunkte (Netzpunkte der Kette) liegen unregelmäßig,
// rauschen und haben fast Doppel Punkte. Deshalb wird nicht durch sie hindurch
// interpoliert, sondern gleichmäßig über die Bogenlänge der Polylinie
// Q = [p, ...guides, q] marschiert: an n+1 äquidistanten Längen wird der
// Polylinienpunkt auf beide Flächen projiziert (liegt exakt auf der Schnittkurve).
// Das Gitter wird bei Verdopplung wiederverwendet (n → 2n enthält n).
export function fitIntersectionCurve(A, B, p, q, guides, opts = {}) {
  const tol = opts.tol !== undefined ? opts.tol : 5e-7;
  const maxPts = opts.maxPts !== undefined ? opts.maxPts : 129;
  const gs = guides && guides.length ? guides : null;
  const mid = gs ? gs[gs.length >> 1] : projectMulti([A, B], mul(add(p, q), 0.5)).x;
  const an = analyticCurve(A, B, p, q, mid);
  if (an) return { curve: an, pts: [p, q] };
  // beide Ebenen → Gerade (analytisch abgedeckt, hier nur als Absicherung)
  if (A.type === 'plane' && B.type === 'plane') {
    const d = sub(q, p);
    if (len(d) > 1e-9) return { curve: { type: 'line', p: [p[0], p[1], p[2]], d: norm(d) }, pts: [p, q] };
  }
  // Polylinie Q = [p, ...Führungspunkte, q] mit Bogenlänge s ∈ [0, Ls]
  const poly = [p];
  if (gs) for (const g of gs) poly.push(g);
  poly.push(q);
  const cum = [0];
  for (let i = 1; i < poly.length; i++) cum.push(cum[i - 1] + len(sub(poly[i], poly[i - 1])));
  const Ls = cum[cum.length - 1];
  if (!(Ls > 1e-12)) return { fail: 'projectMulti', detail: 'entartete Polylinie' };
  const maxShift = opts.maxShift !== undefined ? opts.maxShift
    : Math.min(0.5, Math.max(0.05, 0.5 * Ls));
  // Marschieren: n = 4, 8, … Stützpunkte (n+1 Punkte insgesamt)
  const NS = [4, 8, 16, 32, 64, 128];
  let last = -1;
  for (let i = 0; i < NS.length; i++) if (NS[i] + 1 <= maxPts) last = i;
  if (last < 0) return { fail: 'maxPts', detail: maxPts };
  const proj = new Map();                     // i/n → projizierter Punkt
  for (let lvl = 0; lvl <= last; lvl++) {
    const n = NS[lvl];
    const pts = [p];
    for (let i = 1; i < n; i++) {
      const key = i / n;                      // exakt: n sind Zweierpotenzen
      let x = proj.get(key);
      if (!x) {
        const x0 = polyPointAt(poly, cum, (i * Ls) / n);
        const r = projectMulti([A, B], x0);
        if (!r.ok) return { fail: 'projectMulti', detail: r.res };
        const shift = len(sub(r.x, x0));
        if (shift > maxShift) return { fail: 'shift', detail: shift };
        x = r.x;
        proj.set(key, x);
      }
      pushPoint(pts, x);
    }
    pushPoint(pts, q);
    // Faltung: aufeinanderfolgende Stützpunkte müssen in Chordrichtung fortschreiten
    for (let i = 1; i < pts.length - 1; i++) {
      const d1 = sub(pts[i], pts[i - 1]);
      const d2 = sub(pts[i + 1], pts[i]);
      if (len(d1) > 1e-9 && len(d2) > 1e-9 && dot(d1, d2) <= 0) {
        return { fail: 'fold', detail: i };
      }
    }
    const c = interpCubic(pts);
    if (!c) return { fail: 'projectMulti', detail: 'Interpolation' };
    const maxErr = curveResidual(A, B, c);
    // Sicherheitsreserve (nur solange eine feinere Stufe folgt): die Kurve soll
    // auch zwischen den Prüfparametern sicher innerhalb der Toleranz liegen
    const need = (lvl === last) ? tol : tol * FIT_RESERVE;
    if (maxErr <= need) return { curve: c, pts };
  }
  return { fail: 'maxPts', detail: maxPts };
}

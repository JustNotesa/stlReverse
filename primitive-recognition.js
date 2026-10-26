/**
 * primitive-recognition.js — Erkennung zylindrischer Flächen via Seed-Grow-Fitting.
 *
 * Erkennt sowohl VOLLE Zylinder (Bohrungen, 360°) als auch TEIL-Zylinder
 * (gerade-Kanten-Verrundungen / Fillets, ~90°) — beides ist dieselbe Flächenmathematik
 * (Achse + Radius), nur mit unterschiedlichem Rand (volle Kreise vs. Bögen + Tangentenlinien).
 *
 * Ansatz (RANSAC-artig, robuster als reines Winkel-Band-Growing):
 *   1. Von einer gekrümmten Saat-Facette aus die Zylinder-Achse + Radius schätzen
 *      (2-Punkt-Methode aus zwei Nachbar-Normalen).
 *   2. Region nur so weit wachsen lassen, wie die Dreiecks-Punkte auf dem Zylinder liegen
 *      (Abstand zur Achse ≈ Radius) UND ihre Normale ⊥ zur Achse steht.
 *   3. Achse + Radius aus der ganzen Region nachfitten (PCA der Normalen + Kåsa-Kreis),
 *      erneut wachsen, validieren (Mantel-Abweichung, Radius-Bereich, Winkel-Abdeckung).
 * Dadurch löst sich ein Zylinder sauber von tangential anschließenden EBENEN ab — die
 * deren Punkte driften vom Mantel weg / deren Normale ist nicht ⊥ Achse.
 *
 * Ändert NUR die Anzeige: betroffene Gruppen werden mit `group.primitive` getaggt
 * (gemeinsame Referenz pro Zylinder). normalGroups werden NICHT gemergt, Vertices/Normalen
 * NICHT verändert → STEP-Exporter und Wasserdichtigkeits-Verdikt bleiben unberührt.
 */

const DEG = Math.PI / 180;

// ── Vektor-Helfer ───────────────────────────────────────────────────────────
const sub   = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add   = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot   = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1]*b[2] - a[2]*b[1], a[2]*b[0] - a[0]*b[2], a[0]*b[1] - a[1]*b[0]];
const len   = (a) => Math.hypot(a[0], a[1], a[2]);
const norm  = (a) => { const l = len(a) || 1; return [a[0]/l, a[1]/l, a[2]/l]; };
const centroid3 = (vs) => { let c = [0,0,0]; for (const v of vs) c = add(c, v); return scale(c, 1 / (vs.length || 1)); };

const triNormal = (v0, v1, v2) => {
  const n = cross(sub(v1, v0), sub(v2, v0));
  const l = len(n);
  return l > 1e-12 ? [n[0]/l, n[1]/l, n[2]/l] : null;
};

// Senkrechter Abstand eines Punktes zur Achse (Linie axisPoint + t·axis, axis normiert).
const perpDist = (p, axisPoint, axis) => {
  const w = sub(p, axisPoint);
  const along = dot(w, axis);
  return len(sub(w, scale(axis, along)));
};

// ── 3x3-Gleichungssystem (Gauß mit Teilpivot) für Kåsa ──────────────────────
function solve3(A, b) {
  const m = [[A[0][0], A[0][1], A[0][2], b[0]],
             [A[1][0], A[1][1], A[1][2], b[1]],
             [A[2][0], A[2][1], A[2][2], b[2]]];
  for (let col = 0; col < 3; col++) {
    let piv = col;
    for (let r = col + 1; r < 3; r++) if (Math.abs(m[r][col]) > Math.abs(m[piv][col])) piv = r;
    if (Math.abs(m[piv][col]) < 1e-14) return null;
    [m[col], m[piv]] = [m[piv], m[col]];
    const d = m[col][col];
    for (let c = col; c < 4; c++) m[col][c] /= d;
    for (let r = 0; r < 3; r++) {
      if (r === col) continue;
      const f = m[r][col];
      for (let c = col; c < 4; c++) m[r][c] -= f * m[col][c];
    }
  }
  return [m[0][3], m[1][3], m[2][3]];
}

// ── Symmetrischer 3x3-Eigensolver (zyklisches Jacobi), Werte aufsteigend ─────
function eigenSym3(M) {
  const A = [[M[0][0], M[0][1], M[0][2]], [M[1][0], M[1][1], M[1][2]], [M[2][0], M[2][1], M[2][2]]];
  const V = [[1,0,0],[0,1,0],[0,0,1]];
  for (let it = 0; it < 100; it++) {
    let p = 0, q = 1, mx = Math.abs(A[0][1]);
    if (Math.abs(A[0][2]) > mx) { mx = Math.abs(A[0][2]); p = 0; q = 2; }
    if (Math.abs(A[1][2]) > mx) { mx = Math.abs(A[1][2]); p = 1; q = 2; }
    if (mx < 1e-14) break;
    const theta = (A[q][q] - A[p][p]) / (2 * A[p][q]);
    const sgn = theta >= 0 ? 1 : -1;
    const t = sgn / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
    const c = 1 / Math.sqrt(t * t + 1), s = t * c;
    for (let k = 0; k < 3; k++) { const akp = A[k][p], akq = A[k][q]; A[k][p] = c*akp - s*akq; A[k][q] = s*akp + c*akq; }
    for (let k = 0; k < 3; k++) { const apk = A[p][k], aqk = A[q][k]; A[p][k] = c*apk - s*aqk; A[q][k] = s*apk + c*aqk; }
    for (let k = 0; k < 3; k++) { const vkp = V[k][p], vkq = V[k][q]; V[k][p] = c*vkp - s*vkq; V[k][q] = s*vkp + c*vkq; }
  }
  const vals = [A[0][0], A[1][1], A[2][2]];
  const vecs = [[V[0][0],V[1][0],V[2][0]], [V[0][1],V[1][1],V[2][1]], [V[0][2],V[1][2],V[2][2]]];
  const idx = [0,1,2].sort((i, j) => vals[i] - vals[j]);
  return { values: idx.map(i => vals[i]), vectors: idx.map(i => vecs[i]) };
}

// Achse = Eigenvektor des kleinsten Eigenwerts der Normalen-Kovarianz (Normalen ⊥ Achse).
function pcaAxis(normals) {
  const M = [[0,0,0],[0,0,0],[0,0,0]];
  for (const n of normals) {
    M[0][0]+=n[0]*n[0]; M[0][1]+=n[0]*n[1]; M[0][2]+=n[0]*n[2];
    M[1][1]+=n[1]*n[1]; M[1][2]+=n[1]*n[2]; M[2][2]+=n[2]*n[2];
  }
  M[1][0]=M[0][1]; M[2][0]=M[0][2]; M[2][1]=M[1][2];
  const e = eigenSym3(M);
  return { axis: norm(e.vectors[0]), values: e.values };
}

// Kåsa-Kern in der Ebene ⊥ axis → { center3d, radius } OHNE Abweichungs-Statistik.
// Heiße Schleifen skalar ausgerollt (identische Operations-Reihenfolge wie die frühere
// Vektor-Helfer-Fassung, nur ohne Array-Allokationen pro Punkt — Ergebnisse bit-identisch).
function fitCircleCore(points, axis) {
  // centroid3 inline (gleiche Summen-Reihenfolge)
  let sx = 0, sy = 0, sz0 = 0;
  for (const p of points) { sx += p[0]; sy += p[1]; sz0 += p[2]; }
  const is = 1 / (points.length || 1);
  const c0x = sx * is, c0y = sy * is, c0z = sz0 * is;
  let u = cross(axis, [1, 0, 0]);
  if (len(u) < 1e-6) u = cross(axis, [0, 1, 0]);
  u = norm(u);
  const v = norm(cross(axis, u));
  const ux = u[0], uy = u[1], uz = u[2], vx = v[0], vy = v[1], vz = v[2];
  let Sxx=0, Sxy=0, Syy=0, Sx=0, Sy=0, Sxz=0, Syz=0, Sz=0;
  const N = points.length;
  for (const p of points) {
    const dx = p[0] - c0x, dy = p[1] - c0y, dz = p[2] - c0z;          // sub(p, c0)
    const x = dx*ux + dy*uy + dz*uz, y = dx*vx + dy*vy + dz*vz, z = x*x + y*y; // dot(d,u), dot(d,v)
    Sxx+=x*x; Sxy+=x*y; Syy+=y*y; Sx+=x; Sy+=y; Sxz+=x*z; Syz+=y*z; Sz+=z;
  }
  const sol = solve3([[Sxx,Sxy,Sx],[Sxy,Syy,Sy],[Sx,Sy,N]], [-Sxz,-Syz,-Sz]);
  if (!sol) return null;
  const cu = -sol[0]/2, cv = -sol[1]/2;
  const r2 = cu*cu + cv*cv - sol[2];
  if (r2 <= 0) return null;
  const radius = Math.sqrt(r2);
  // add(c0, add(scale(u, cu), scale(v, cv))) inline
  return { center: [c0x + (ux*cu + vx*cv), c0y + (uy*cu + vy*cv), c0z + (uz*cu + vz*cv)], radius };
}

// Kåsa-Kreis-Fit in der Ebene ⊥ axis → { center3d, radius, meanDev, maxDev }.
function fitCircleInPlane(points, axis) {
  const f = fitCircleCore(points, axis);
  if (!f) return null;
  const center = f.center, radius = f.radius;
  const ctx = center[0], cty = center[1], ctz = center[2];
  const ax0 = axis[0], ax1 = axis[1], ax2 = axis[2];
  let sum = 0, mx = 0;
  for (const p of points) {
    // perpDist(p, center, axis) inline
    const wx = p[0] - ctx, wy = p[1] - cty, wz = p[2] - ctz;
    const along = wx*ax0 + wy*ax1 + wz*ax2;
    const d = Math.abs(Math.hypot(wx - ax0*along, wy - ax1*along, wz - ax2*along) - radius);
    sum += d; if (d > mx) mx = d;
  }
  return { center, radius, meanDev: sum / points.length, maxDev: mx };
}

// Stabiler LSD-Radix-Sort: Indizes 0..n-1 aufsteigend nach NICHT-NEGATIVEN double-Schlüsseln.
// IEEE-754-Bitmuster nicht-negativer Doubles sind ordnungs-monoton und wert-eindeutig
// (kein −0, kein NaN im Einsatz hier) → exakt dieselbe Permutation wie ein stabiler
// Vergleichs-Sort (a,b)=>k[a]-k[b], nur ohne JS-Comparator-Aufrufe. (Little-Endian-Layout,
// wie auf allen unterstützten Plattformen.)
function sortIdxByNonNeg(keys, n) {
  const kb = new Uint32Array(keys.buffer, 0, n * 2); // [lo,hi] je Double
  let a = new Uint32Array(n), b = new Uint32Array(n);
  for (let i = 0; i < n; i++) a[i] = i;
  const count = new Uint32Array(257);
  for (let pass = 0; pass < 8; pass++) {
    const w = pass < 4 ? 0 : 1, shift = (pass & 3) * 8;
    count.fill(0);
    for (let i = 0; i < n; i++) count[((kb[2 * a[i] + w] >>> shift) & 0xff) + 1]++;
    let single = false;
    for (let k = 1; k <= 256; k++) if (count[k] === n) { single = true; break; }
    if (single) continue; // alle im selben Eimer → Pass ist ein No-op
    for (let k = 0; k < 256; k++) count[k + 1] += count[k];
    for (let i = 0; i < n; i++) { const j = a[i]; b[count[(kb[2 * j + w] >>> shift) & 0xff]++] = j; }
    const t = a; a = b; b = t;
  }
  return a;
}

// Robuster Kreis-Fit: getrimmte Kåsa-Iteration — verwirft Ausreißer (z. B. tangentiale
// Ebenen-Punkte, die nicht auf dem Zylinder liegen) und konvergiert auf den Mehrheits-Kreis.
function fitCircleRobust(points, axis) {
  let fit = fitCircleInPlane(points, axis);
  if (!fit) return null;
  let pts = points;
  const ax0 = axis[0], ax1 = axis[1], ax2 = axis[2];
  for (let it = 0; it < 4 && pts.length >= 8; it++) {
    // Residuen skalar in Typed-Array statt {p,r}-Objekten; stabiler Index-Sort liefert
    // exakt dieselbe Permutation wie der frühere Objekt-Sort (gleiche Vergleichswerte).
    const n = pts.length;
    const rs = new Float64Array(n);
    const cx = fit.center[0], cy = fit.center[1], cz = fit.center[2], R = fit.radius;
    for (let i = 0; i < n; i++) {
      const p = pts[i];
      const wx = p[0] - cx, wy = p[1] - cy, wz = p[2] - cz;         // perpDist inline
      const along = wx*ax0 + wy*ax1 + wz*ax2;
      rs[i] = Math.abs(Math.hypot(wx - ax0*along, wy - ax1*along, wz - ax2*along) - R);
    }
    const idx = new Array(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    idx.sort((a, b) => rs[a] - rs[b]);
    const med = rs[idx[Math.floor(n / 2)]] || 1e-9;
    // Residual-Schwelle relativ zum MEDIAN (unempfindlich gegen einen kontaminierten Startfit);
    // mit Mindest-Behalt, damit echte Kreis-Punkte nicht weggetrimmt werden.
    const lim = 2.5 * med;
    let keep = [];
    for (let i = 0; i < n; i++) { const j = idx[i]; if (rs[j] <= lim) keep.push(pts[j]); }
    const floor = Math.max(6, Math.floor(n * 0.5));
    if (keep.length < floor) { keep = []; for (let i = 0; i < floor; i++) keep.push(pts[idx[i]]); }
    const f2 = fitCircleInPlane(keep, axis);
    if (!f2) break;
    const converged = Math.abs(f2.radius - fit.radius) < 1e-4 * (fit.radius || 1);
    fit = f2; pts = keep;
    if (converged) break;
  }
  return fit;
}

// Winkel-Abdeckung um die Achse = 360° − größte Lücke (über Punkt-Winkel).
function coverageDeg(points, axisPoint, axis) {
  let u = cross(axis, [1, 0, 0]);
  if (len(u) < 1e-6) u = cross(axis, [0, 1, 0]);
  u = norm(u);
  const v = norm(cross(axis, u));
  const px = axisPoint[0], py = axisPoint[1], pz = axisPoint[2];
  const ux = u[0], uy = u[1], uz = u[2], vx = v[0], vy = v[1], vz = v[2];
  const ang = [];
  for (const p of points) {
    const dx = p[0] - px, dy = p[1] - py, dz = p[2] - pz;           // sub(p, axisPoint)
    ang.push(Math.atan2(dx*vx + dy*vy + dz*vz, dx*ux + dy*uy + dz*uz));
  }
  if (ang.length < 2) return 0;
  ang.sort((a, b) => a - b);
  let maxGap = (ang[0] + 2 * Math.PI) - ang[ang.length - 1];
  for (let i = 1; i < ang.length; i++) { const g = ang[i] - ang[i - 1]; if (g > maxGap) maxGap = g; }
  return (2 * Math.PI - maxGap) / DEG;
}

/**
 * recognizePrimitives(normalGroups, opts?) → { groups, primitives, stats }
 */
export function recognizePrimitives(normalGroups, opts = {}) {
  const SEED_MIN_COS = Math.cos((opts.seedMaxDeg ?? 50) * DEG);   // Saat-Kante: Knick ≤ 50° (deckt 8-seitige Zyl. = 45° ab)
  const SEED_MAX_COS = Math.cos((opts.seedMinDeg ?? 1)  * DEG);   //            und ≥ 1° (gekrümmt, deckt fein tessellierte Bohrungen ab)
  const MIN_TRIS     = opts.minTris       ?? 6;
  const MIN_RADIUS   = opts.minRadius     ?? 0.3;
  const DIST_RELTOL  = opts.distRelTol    ?? 0.04;                // Mantel-Toleranz beim Wachsen
  const DIST_ABSTOL  = opts.distAbsTol    ?? 0.05;
  const AXIS_PERP    = opts.axisPerpSin   ?? 0.26;                // |n·axis| ≤ sin(15°)
  const MANTEL_MEAN  = opts.mantelMeanRel ?? 0.05;
  const MANTEL_MAX   = opts.mantelMaxRel  ?? 0.30;
  const MIN_COV      = opts.minCoverageDeg ?? 30;                 // Fillet (~90°) erlaubt
  const FULL_COV     = opts.fullCoverageDeg ?? 300;              // ab hier „voll" (Bohrung)
  const EIGEN_MID    = opts.eigenMidMin   ?? 0.012;              // Normalen müssen ≥2D streuen (kein Plan)
  const AXIS_RMS_MAX = opts.axisRmsMax    ?? 0.10;              // RMS(n·achse): Zylinder≈0, Kegel/Kugel >0
  const FLAT_NB_RAD  = (opts.flatNbDeg    ?? 2.5) * DEG;        // Nachbar gilt als „flach" unter diesem Knick
                                                               // (fein genug, damit feine gekrümmte Facetten nicht als flach zählen)
  const TAPER_MAX    = opts.taperMax      ?? 0.05;             // max. d(radius)/d(achse) (≈ tan 3°) — sonst Kegel
  const BOOT_DEPTH   = opts.bootDepth     ?? 6;                  // Bootstrap-Patch: BFS-Tiefe
  const BOOT_MAX     = opts.bootMax       ?? 70;                 //                  + Größenkappe
  const COS_BOOT     = Math.cos((opts.bootAngleDeg ?? 50) * DEG); // dihedral-Schwelle fürs Bootstrap (inkl. 45°-Facetten)

  const empty = { groups: normalGroups || [], primitives: [], stats: { inputGroups: normalGroups?.length || 0, cylinders: 0, fillets: 0, bores: 0 } };
  if (!Array.isArray(normalGroups) || !normalGroups.length) return empty;

  // 1) Dreiecke flachklopfen (mit Gruppen-Index + frischer Normale)
  const tris = [];
  let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  normalGroups.forEach((grp, gi) => {
    const vs = grp.vertices;
    if (!Array.isArray(vs)) return;
    const tc = Math.floor(vs.length / 3);
    for (let t = 0; t < tc; t++) {
      const v0 = vs[t*3], v1 = vs[t*3+1], v2 = vs[t*3+2];
      const n = triNormal(v0, v1, v2);
      if (!n) continue;
      tris.push({ n, v: [v0, v1, v2], g: gi }); // (Schwerpunkt wurde nie gelesen — entfällt)
      for (const vv of [v0, v1, v2]) for (let k = 0; k < 3; k++) { if (vv[k] < mn[k]) mn[k] = vv[k]; if (vv[k] > mx[k]) mx[k] = vv[k]; }
    }
  });
  const T = tris.length;
  if (!T) return empty;
  const diag = len(sub(mx, mn)) || 1;
  const MAX_RADIUS = opts.maxRadius ?? diag; // Zylinder größer als das Bauteil ist unplausibel

  // 2) Manifold-Adjazenz
  // −0/+0 vereinheitlichen (wie fixZero im Exporter): an der Naht rotationssymmetrischer
  // Teile (θ = 0/2π) liefert sin(2π) ≈ −2e-16 → "-0.0000" ≠ "0.0000" → die Naht-Kante fehlte
  // in der Adjazenz (Grow musste den Umweg nehmen, Naht-Seeds sahen ihren Wand-Nachbarn nicht).
  const fz = (x) => { const s = x.toFixed(4); return s === '-0.0000' ? '0.0000' : s; };
  const key  = (p) => `${fz(p[0])},${fz(p[1])},${fz(p[2])}`;
  // Vertex-Keys je Facette EINMAL berechnen und cachen (toFixed ist teuer) — Adjazenz,
  // hingeAxis und isPrism vergleichen danach nur noch gecachte Strings (gleiche Werte).
  const triKeys = new Array(T);
  const edgeToTris = new Map();
  for (let i = 0; i < T; i++) {
    const v = tris[i].v;
    const tk = [key(v[0]), key(v[1]), key(v[2])];
    triKeys[i] = tk;
    for (let k = 0; k < 3; k++) {
      const ka = tk[k], kb = tk[(k + 1) % 3];
      const e = ka < kb ? ka + '|' + kb : kb + '|' + ka;           // ekey inline
      let a = edgeToTris.get(e); if (!a) { a = []; edgeToTris.set(e, a); }
      a.push(i);
    }
  }
  const adj = Array.from({ length: T }, () => []);
  for (const t of edgeToTris.values()) if (t.length === 2) { adj[t[0]].push(t[1]); adj[t[1]].push(t[0]); }

  // Helfer: passt ein Dreieck auf das Zylinder-Modell? (skalar, allokationsfrei)
  const fits = (ti, ap, ax, r, distTol) => {
    const t = tris[ti], n = t.n;
    if (Math.abs(n[0]*ax[0] + n[1]*ax[1] + n[2]*ax[2]) > AXIS_PERP) return false; // Normale ⊥ Achse?
    const px = ap[0], py = ap[1], pz = ap[2], ax0 = ax[0], ax1 = ax[1], ax2 = ax[2];
    for (const vv of t.v) {
      const wx = vv[0] - px, wy = vv[1] - py, wz = vv[2] - pz;     // perpDist inline
      const along = wx*ax0 + wy*ax1 + wz*ax2;
      if (Math.abs(Math.hypot(wx - ax0*along, wy - ax1*along, wz - ax2*along) - r) > distTol) return false;
    }
    return true;
  };
  // Wiederverwendbarer Scratch-Puffer (Generations-Stempel) statt new Uint8Array(T) pro Aufruf.
  const stamp = new Int32Array(T);
  let gen = 0;

  // Region per BFS wachsen (nur über noch freie, passende Nachbarn).
  // `growWork` zählt alle je gewachsenen Facetten — deterministisches Arbeits-Budget für
  // Phase 1 + Rettungspfad (siehe unten), damit Kugeln/Tori nicht quadratisch explodieren.
  let growWork = 0;
  const grow = (seed, ap, ax, r, distTol, visited) => {
    const g = ++gen;
    const region = [];
    const q = [seed];
    stamp[seed] = g;
    while (q.length) {
      const cur = q.pop();
      region.push(cur);
      for (const nb of adj[cur]) {
        if (stamp[nb] === g || visited[nb]) continue;
        if (fits(nb, ap, ax, r, distTol)) { stamp[nb] = g; q.push(nb); }
      }
    }
    growWork += region.length;
    return region;
  };
  // Arbeits-Budgets (in gewachsenen Facetten). Ohne sie lief sphere_full 101 s statt 62 ms:
  // Phase 1 verbraucht bei Fehlschlag nichts → jede Kugel-Facette startete einen vollen
  // Wachstums- + Rettungslauf über ein Großkreis-Band (O(T²)). Großzügig bemessen — reale
  // Teile bleiben weit darunter; bei Überschreitung wird nur der ZUSATZ-Pfad abgeschaltet,
  // Phase 2 (der ursprüngliche Pfad) läuft immer vollständig.
  const PHASE1_BUDGET = 40 * T + 50000;
  const RESCUE_BUDGET = 40 * T + 50000;
  let rescueWork = 0;
  let phase1Truncated = false, rescueTruncated = false;

  // Validierung einer Kandidaten-Region — EXAKT die bisherige Gate-Sequenz, aber ohne
  // Seiteneffekte (kein visited/failRegion), damit sie zweimal laufen kann: erst auf der
  // vollen Region (Verhalten wie bisher), bei Kontaminations-Scheitern erneut auf dem
  // extrahierten Zylinder-Kern (Rettungspfad für verrundungs-umgebene Bohrungen).
  const validateRegion = (regionArr, modelIn) => {
    if (regionArr.length < MIN_TRIS) return { ok: false, reason: 'tris' };
    const verts = [];
    for (const ti of regionArr) for (const vv of tris[ti].v) verts.push(vv);
    const circ = fitCircleInPlane(verts, modelIn.axis);
    if (!circ) return { ok: false, reason: 'fit' };
    const r = circ.radius;
    if (!(r >= MIN_RADIUS && r <= MAX_RADIUS)) return { ok: false, reason: 'radius' };
    if (circ.meanDev > Math.max(0.08, MANTEL_MEAN * r)) return { ok: false, reason: 'meandev' };
    if (circ.maxDev  > Math.max(0.5,  MANTEL_MAX  * r)) return { ok: false, reason: 'maxdev' };
    // Normalen müssen ≥2D streuen (sonst flach): mittlerer Eigenwert relevant
    const vls = modelIn.values;
    if (!(vls[2] > 0) || vls[1] / vls[2] < EIGEN_MID) return { ok: false, reason: 'eigen' };
    const axis = modelIn.axis, axisPoint = circ.center;
    // Zylinder-vs-Kegel/Kugel (lokal, billig): Normalen eines echten Zylinders stehen ⊥ zur Achse.
    let s2 = 0; for (const ti of regionArr) { const d = dot(tris[ti].n, axis); s2 += d * d; }
    if (Math.sqrt(s2 / regionArr.length) > AXIS_RMS_MAX) return { ok: false, reason: 'axisrms' };
    // Konizitäts-Test (global, fängt auch dünne Kegel-Scheiben): der Abstand zur Achse darf
    // entlang der Achse nicht systematisch driften (Kegel: d(radius)/d(achse) = tan(Halbwinkel)).
    {
      let st = 0, sp = 0, stt = 0, stp = 0; const nN = verts.length;
      const ccx = circ.center[0], ccy = circ.center[1], ccz = circ.center[2];
      const ax0 = axis[0], ax1 = axis[1], ax2 = axis[2];
      for (const vv of verts) {
        const wx = vv[0] - ccx, wy = vv[1] - ccy, wz = vv[2] - ccz; // sub(vv, center)
        const t = wx*ax0 + wy*ax1 + wz*ax2;                        // = dot(w, axis) = along
        const pd = Math.hypot(wx - ax0*t, wy - ax1*t, wz - ax2*t); // perpDist inline
        st += t; sp += pd; stt += t * t; stp += t * pd;
      }
      const den = nN * stt - st * st;
      const slope = Math.abs(den) > 1e-9 ? (nN * stp - st * sp) / den : 0;
      if (Math.abs(slope) > TAPER_MAX) return { ok: false, reason: 'taper' };
    }
    const cov = coverageDeg(verts, axisPoint, axis);
    if (cov < MIN_COV) return { ok: false, reason: 'coverage' };
    const full = cov >= FULL_COV;
    // Krümmungs-Rand-Test für TEIL-Zylinder (Fillets): müssen von EBENEN Flächen begrenzt sein,
    // nicht von weiterer gekrümmter Fläche → verwirft osculating gefittete Kegel-Scheiben.
    if (!full) {
      const regSet = new Set(regionArr);
      const seen = new Set();
      let flatN = 0, curvedN = 0;
      for (const ti of regionArr) {
        for (const nb of adj[ti]) {
          if (regSet.has(nb) || seen.has(nb)) continue;
          seen.add(nb);
          let maxAng = 0;
          for (const nn of adj[nb]) {
            if (regSet.has(nn)) continue; // Region-seitige Naht ignorieren
            const ang = Math.acos(Math.min(1, Math.abs(dot(tris[nb].n, tris[nn].n))));
            if (ang > maxAng) maxAng = ang;
          }
          if (maxAng < FLAT_NB_RAD) flatN++; else curvedN++;
        }
      }
      if (curvedN > flatN) return { ok: false, reason: 'curvedboundary' };
    }
    return { ok: true, verts, circ, r, axis, axisPoint, cov, full };
  };

  // Kern-Extraktion (Rettungspfad): Der grow zieht an Loch-Mündungen die ersten VERRUNDUNGS-
  // Facetten mit hinein (dort noch ≈Radius, Normale fast ⊥ Achse) → Fit kontaminiert →
  // Region fällt fälschlich als „Kegel" durch. Hier wird die Region iterativ auf den sauberen
  // Zylinder-Kern getrimmt (streng ⊥ Normale + kleines Radial-Residuum) und neu gefittet.
  const CORE_PERP = 0.12; // strenger als AXIS_PERP (0.26): schließt Fillet-Facetten aus
  const extractCylinderCore = (regionArr, modelIn) => {
    // Min-ρ-Band-Trimmen: Bei einer LOCH-Mündung krümmt die Verrundung IMMER nach außen
    // (ρ ≥ R) — die Zylinder-Wand ist die Facetten-Population am MINIMALEN Achsabstand.
    // Mehrheits-/Quantil-Trimmen versagt hier, weil die Wand bei tiefen Verrundungen die
    // MINDERHEIT ist (Fillet-Oskulations-Fits gewinnen, empirisch beobachtet). Das Min-ρ-Band
    // findet die Wand trotzdem; die PCA einer beliebigen WAND-Teilmenge liefert die wahre
    // Achse exakt (Wand-Normalen liegen in der Ebene ⊥ Achse) → Iteration entkippt die Achse.
    let m = modelIn;
    for (let it = 0; it < 4; it++) {
      // ρ/s skalar in Typed-Arrays + stabiler Index-Sort (statt Objekt-map+sort) —
      // gleiche Werte, gleiche Permutation, gleiche cand-Reihenfolge.
      const nR = regionArr.length;
      const rho = new Float64Array(nR), sN = new Float64Array(nR);
      const apx = m.axisPoint[0], apy = m.axisPoint[1], apz = m.axisPoint[2];
      const ax0 = m.axis[0], ax1 = m.axis[1], ax2 = m.axis[2];
      for (let i = 0; i < nR; i++) {
        const t = tris[regionArr[i]];
        let s = 0;
        for (const vv of t.v) {
          const wx = vv[0] - apx, wy = vv[1] - apy, wz = vv[2] - apz; // perpDist inline
          const along = wx*ax0 + wy*ax1 + wz*ax2;
          s += Math.hypot(wx - ax0*along, wy - ax1*along, wz - ax2*along);
        }
        rho[i] = s / 3;
        sN[i] = Math.abs(t.n[0]*ax0 + t.n[1]*ax1 + t.n[2]*ax2);
      }
      const idx = new Array(nR);
      for (let i = 0; i < nR; i++) idx[i] = i;
      idx.sort((a, b) => rho[a] - rho[b]);
      const rhoLo = rho[idx[Math.floor(nR * 0.1)]];
      const band = Math.max(0.12, 0.05 * rhoLo);
      const lim = rhoLo + band;
      const cand = [];
      for (let i = 0; i < nR; i++) { const j = idx[i]; if (rho[j] <= lim && sN[j] <= AXIS_PERP) cand.push(regionArr[j]); }
      if (cand.length < MIN_TRIS) return null;
      const { axis: ax, values } = pcaAxis(cand.map(ti => tris[ti].n));
      const verts = [];
      for (const ti of cand) for (const vv of tris[ti].v) verts.push(vv);
      const circ = fitCircleRobust(verts, ax);
      if (!circ || !(circ.radius >= MIN_RADIUS && circ.radius <= MAX_RADIUS)) return null;
      m = { axis: ax, axisPoint: circ.center, radius: circ.radius, circ, values };
    }
    // Finaler harter Kern: streng ⊥ Normale + enges Radial-Residuum (schließt Fillet-Ringe aus).
    const tol = Math.max(0.08, 0.05 * m.radius);
    const hpx = m.axisPoint[0], hpy = m.axisPoint[1], hpz = m.axisPoint[2];
    const ha0 = m.axis[0], ha1 = m.axis[1], ha2 = m.axis[2], hr = m.radius;
    const hard = [];
    for (const ti of regionArr) {                                   // filter(⊥ && every) inline
      const t = tris[ti];
      if (Math.abs(t.n[0]*ha0 + t.n[1]*ha1 + t.n[2]*ha2) > CORE_PERP) continue;
      let ok = true;
      for (const vv of t.v) {
        const wx = vv[0] - hpx, wy = vv[1] - hpy, wz = vv[2] - hpz; // perpDist inline
        const along = wx*ha0 + wy*ha1 + wz*ha2;
        if (Math.abs(Math.hypot(wx - ha0*along, wy - ha1*along, wz - ha2*along) - hr) > tol) { ok = false; break; }
      }
      if (ok) hard.push(ti);
    }
    if (hard.length < MIN_TRIS) return null;
    const { axis: axH, values: valsH } = pcaAxis(hard.map(ti => tris[ti].n));
    const vertsH = [];
    for (const ti of hard) for (const vv of tris[ti].v) vertsH.push(vv);
    const circH = fitCircleRobust(vertsH, axH);
    if (!circH || !(circH.radius >= MIN_RADIUS && circH.radius <= MAX_RADIUS)) return null;
    const mH = { axis: axH, axisPoint: circH.center, radius: circH.radius, circ: circH, values: valsH };
    // Anti-Kugel-Wächter: die WEGGETRIMMTEN Facetten müssen nach AUSSEN krümmen (Loch-Mündungs-
    // Fillet: ρ ≥ R) — krümmen sie nach INNEN (ρ < R), ist die Region ein Kugel-Äquator-Band
    // (sphere_full/hemisphere dürfen nicht als „Bohrung" durchrutschen).
    const coreSet = new Set(hard);
    let s = 0, n = 0;
    const gpx = mH.axisPoint[0], gpy = mH.axisPoint[1], gpz = mH.axisPoint[2];
    const ga0 = mH.axis[0], ga1 = mH.axis[1], ga2 = mH.axis[2], gr = mH.radius;
    for (const ti of regionArr) {
      if (coreSet.has(ti)) continue;
      for (const vv of tris[ti].v) {
        const wx = vv[0] - gpx, wy = vv[1] - gpy, wz = vv[2] - gpz; // perpDist inline
        const along = wx*ga0 + wy*ga1 + wz*ga2;
        s += Math.hypot(wx - ga0*along, wy - ga1*along, wz - ga2*along) - gr; n++;
      }
    }
    // Schwelle bewusst ENG (0.4% von r): ein Kugel-Äquator-Band krümmt nur sanft nach innen
    // (−1.8% bei ±15°-Band) und rutschte bei 2% durch (sphere_full-Regression). Loch-Mündungs-
    // Fillets krümmen nach AUSSEN (positiv) und sind von der Schwelle gar nicht betroffen.
    if (n && s / n < -Math.max(0.03, 0.004 * mH.radius)) return null; // nach innen → Kugel/Tonne
    return { core: hard, model: mH };
  };

  const visited = new Uint8Array(T);
  // `claimed` ⊂ `visited`: nur Facetten, die zu einem AKZEPTIERTEN Primitiv gehören.
  // Fehlschlag-Verbrauch (failRegion) setzt nur `visited` (Anti-Blowup fürs Seeding) —
  // der Rettungs-Regrow darf solche Facetten ZURÜCKHOLEN (sonst hungern Junk-Regionen
  // die Bohrungs-Wand aus, bevor je ein sauberes Modell entsteht).
  const claimed = new Uint8Array(T);
  const primitives = [];
  let bores = 0, fillets = 0;

  // Rettungspfad (gemeinsam für Phase 1 + 2): Kern entkontaminieren → mit dem sauberen
  // Modell vom Seed aus NEU wachsen (Regrow blockiert nur auf `claimed` — fehlschlag-
  // verbrauchte Facetten sind zurückholbar) → validieren, notfalls nochmals kern-trimmen.
  // Nur VOLLE Bohrungen werden gerettet: Teil-Zylinder-Rettung erzeugt Junk-„Fillets"
  // aus Torus-Patches (empirisch beobachtet), Bohrungen sind immer 360°.
  const RESCUE_REASONS = new Set(['meandev', 'maxdev', 'axisrms', 'taper']);
  // Rückgabe: null (gar nicht versucht/abgebrochen vor dem Regrow), { ok:false, touched }
  // (Regrow gelaufen, aber gescheitert — `touched` MUSS der Aufrufer mit verbrauchen, sonst
  // wird dasselbe Band von jedem Nachbar-Seed erneut durchwachsen) oder { ok:true, … }.
  const tryRescue = (seed, region, model, v) => {
    if (!RESCUE_REASONS.has(v.reason)) return null;
    if (rescueWork > RESCUE_BUDGET) { rescueTruncated = true; return null; }
    const ce = extractCylinderCore(region, model);
    if (!ce) return null;
    const distTol2 = Math.max(DIST_ABSTOL, DIST_RELTOL * ce.model.radius);
    const region2 = grow(seed, ce.model.axisPoint, ce.model.axis, ce.model.radius, distTol2, claimed);
    rescueWork += region2.length;
    const fail = { ok: false, touched: region2 };
    if (region2.length < MIN_TRIS) return fail;
    const { axis: ax2, values: vals2 } = pcaAxis(region2.map(ti => tris[ti].n));
    const verts2 = [];
    for (const ti of region2) for (const vv of tris[ti].v) verts2.push(vv);
    const circ2 = fitCircleRobust(verts2, ax2);
    if (!circ2 || !(circ2.radius >= MIN_RADIUS && circ2.radius <= MAX_RADIUS)) return fail;
    const model2 = { axis: ax2, axisPoint: circ2.center, radius: circ2.radius, circ: circ2, values: vals2 };
    let v2 = validateRegion(region2, model2);
    let tagged2 = region2;
    // Kern-Politur IMMER bevorzugen, wenn der Kern eigenständig als volle Bohrung validiert:
    // der Regrow sammelt grenzwertige Fillet-Ring-Facetten teilweise mit ein (fleckig) —
    // das verwebt die Rand-Loops der getaggten Fläche (1 Loop statt 2 Kreise) und bricht
    // die Kegel-/Kreis-Konvertierung im Exporter. Der polierte Kern hat saubere Ränder.
    const ce2 = extractCylinderCore(region2, model2);
    if (ce2) {
      const v3 = validateRegion(ce2.core, ce2.model);
      if (v3.ok && v3.full) { v2 = v3; tagged2 = ce2.core; }
    }
    if (!v2.ok || !v2.full) return fail;
    return { ok: true, v: v2, tagged: tagged2, consume: region.concat(region2) };
  };

  // Primitiv übernehmen: taggen (nur die Zylinderfläche → `claimed`, unantastbar) und
  // verbrauchen (`visited`: die ganze Region — schirmt weggetrimmte Fillet-Facetten
  // gegen Junk-Seeds ab).
  const acceptPrim = (v, tagged, consumeArr) => {
    let tMin = Infinity, tMax = -Infinity;
    for (const vv of v.verts) { const tt = dot(sub(vv, v.circ.center), v.axis); if (tt < tMin) tMin = tt; if (tt > tMax) tMax = tt; }
    const prim = {
      type: 'cylinder', kind: v.full ? 'bore' : 'fillet', full: v.full,
      id: primitives.length, axis: v.axis, axisPoint: add(v.circ.center, scale(v.axis, tMin)), radius: v.r, height: tMax - tMin,
      coverageDeg: v.cov, triCount: tagged.length,
      meanDevMm: v.circ.meanDev
    };
    primitives.push(prim);
    if (v.full) bores++; else fillets++;
    for (const ti of tagged) { claimed[ti] = 1; normalGroups[tris[ti].g].primitive = prim; }
    for (const ti of consumeArr) visited[ti] = 1;
  };

  // ── Phase 1: Kanten-Achsen-Seeding für VOLLE Bohrungen ──────────────────────
  // Die Scharnier-Kante zwischen zwei benachbarten Zylinder-Facetten liegt EXAKT parallel zur
  // Achse (gilt für jedes Prisma — unabhängig von Tessellierungs-Feinheit und Dihedralwinkel).
  // Damit hat jeder echte Zylinder ein exaktes lokales Achsen-Estimate, BEVOR kontaminierte
  // Bootstrap-PCA-Regionen (Phase 2) wachsen und die Wand in Splitter fressen können — bei
  // fillet-dominierten Löchern (tiefe Verrundung, dünne Wand) ist genau das der Killer:
  // die Wand wird sonst in ~12er-Häppchen von Junk-Regionen verbraucht (empirisch belegt).
  // Phase 1 verbraucht bei Fehlschlag NICHTS (globales `visited`) und akzeptiert volle
  // 360°-Bohrungen sowie — streng geprüft (Prisma + nur ebene Nachbarn, ohne Rettungspfad) —
  // gerade Kanten-Verrundungen (Teil-Zylinder). Alles andere behandelt Phase 2.
  // Gegen O(T²): (a) billiger Prisma-Vorfilter (s.u.), (b) `p1tried` merkt sich Facetten
  // gescheiterter Phase-1-Regionen — sie werden in Phase 1 nicht erneut als Seed probiert
  // (Phase 2 sieht sie unverändert), (c) PHASE1_BUDGET als hartes Sicherheitsnetz.
  const p1tried = new Uint8Array(T);
  const STRICT_PERP = 0.02; // |n·axis0| für „exakt senkrecht" (≈1.1°) — CAD-Prismen liegen bei ~1e-6
  // Profilbreite: Ausdehnung einer Facette quer zur Achse `ax`, in ihrer eigenen Ebene. Mantel-
  // Facetten eines Zylinders/einer Verrundung sind gleich breite, schmale Streifen; eine
  // angrenzende EBENE ist ein breiter Streifen. Ohne diese Unterscheidung landeten die
  // fernen Ebenen-Eckpunkte im Radius-Fit (Platte mit r=3-Verrundungen → Schein-Zylinder
  // R≈19.5, empirisch belegt).
  const profW = (ti, ax) => {
    const t = tris[ti], n = t.n;
    // norm(cross(ax, n)) inline (gleiche Reihenfolge: len||1, dann Division je Komponente)
    let dx = ax[1]*n[2] - ax[2]*n[1], dy = ax[2]*n[0] - ax[0]*n[2], dz = ax[0]*n[1] - ax[1]*n[0];
    const l = Math.hypot(dx, dy, dz) || 1;
    dx /= l; dy /= l; dz /= l;
    let lo = Infinity, hi = -Infinity;
    for (const vv of t.v) { const s = vv[0]*dx + vv[1]*dy + vv[2]*dz; if (s < lo) lo = s; if (s > hi) hi = s; }
    return hi - lo;
  };
  // Scharnier-Achse = gemeinsame Kante ti↔m (normiert) oder null. Vergleich über gecachte Keys.
  const hingeAxis = (ti, m) => {
    const ka = triKeys[ti], kb = triKeys[m], va = tris[ti].v;
    const sh = [];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) { if (ka[i] === kb[j]) { sh.push(va[i]); break; } }
    return sh.length === 2 ? norm(sub(sh[1], sh[0])) : null;
  };
  // Gekrümmte Nachbarn (Knick im Saat-Fenster), kleinster Knick zuerst; stabil sortiert →
  // bei Gleichstand gewinnt wie bisher der erste in adj-Reihenfolge.
  const hingeCands = (ti, skipVisited) => {
    const cand = [];
    for (const m of adj[ti]) {
      if (skipVisited && visited[m]) continue;
      const c = dot(tris[ti].n, tris[m].n);
      if (c >= SEED_MIN_COS && c <= SEED_MAX_COS) cand.push({ m, c });
    }
    return cand.sort((a, b) => b.c - a.c);
  };
  // Saat-Scharnier einer Facette → { nb, axis, wSeed } oder null.
  //  fallback=false (Regel-Durchlauf): der Nachbar mit dem KLEINSTEN Knick; besteht dessen Kante
  //    den Profilbreiten-Test nicht (breiter Streifen neben schmalem → kein Mantel-Scharnier) → null.
  //  fallback=true (Ausweich-Durchlauf): NUR wenn genau das passiert ist — dann der nächstgrößere
  //    Knick, dessen Kante den Profiltest besteht. Grund: an einer verrundeten Loch-Mündung knickt
  //    der erste Verrundungs-Ring (≈9–10°) SCHWÄCHER als die Wand selbst (32 Segmente = 11.25°) →
  //    JEDE Wand-Facette nahm die Mündungs-Sehne als „Achse" und fiel am Profiltest durch; das
  //    Loch bekam nie die exakte Kanten-Achse (eBike-Halter, Y-Löcher, empirisch belegt).
  const seedHinge = (ti, skipVisited, fallback) => {
    const cand = hingeCands(ti, skipVisited);
    for (let i = 0; i < cand.length; i++) {
      const m = cand[i].m;
      const axis = hingeAxis(ti, m);
      if (!axis) { if (fallback) continue; return null; }
      const wSeed = profW(ti, axis);
      if (wSeed > 2.5 * profW(m, axis)) { if (fallback) continue; return null; }
      return (i > 0) === fallback ? { nb: m, axis, wSeed } : null;
    }
    return null;
  };
  // Start-Achse einer Facette im laufenden Durchlauf, gecacht. Für das gezielte Merken (p1Fail)
  // ohne Rücksicht auf `visited` — es geht nur um „welche Achse würde diese Facette als Seed
  // liefern?". Regel-Durchlauf: Scharnier mit kleinstem Knick (ohne Profiltest, wie bisher).
  const edgeAxisCache = new Float64Array(T * 3);
  const edgeAxisState = new Uint8Array(T); // 0 = unbekannt, 1 = vorhanden, 2 = keine
  let p1fallback = false;
  const edgeAxisOf = (ti) => {
    if (edgeAxisState[ti] === 0) {
      let a = null;
      if (p1fallback) { const h = seedHinge(ti, false, true); if (h) a = h.axis; }
      else { const c = hingeCands(ti, false); if (c.length) a = hingeAxis(ti, c[0].m); }
      edgeAxisState[ti] = 2;
      if (a) {
        edgeAxisCache[ti * 3] = a[0]; edgeAxisCache[ti * 3 + 1] = a[1]; edgeAxisCache[ti * 3 + 2] = a[2];
        edgeAxisState[ti] = 1;
      }
    }
    return edgeAxisState[ti] === 1 ? [edgeAxisCache[ti * 3], edgeAxisCache[ti * 3 + 1], edgeAxisCache[ti * 3 + 2]] : null;
  };
  // Echtes Prisma: jede Kante, die zwei Region-Facetten mit VERSCHIEDENER Normale trennt,
  // liegt ∥ zur Achse (Zylinder-/Fillet-Streifen). Torus-/Kegel-Patches haben gedrehte bzw.
  // konvergierende Scharniere → fallen durch.
  const isPrism = (regionArr, ax) => {
    const inR = new Set(regionArr);
    let hinges = 0;
    for (const ti of regionArr) {
      for (const m of adj[ti]) {
        if (m < ti || !inR.has(m)) continue;
        if (dot(tris[ti].n, tris[m].n) > Math.cos(0.5 * DEG)) continue; // koplanar (Diagonale)
        const ka = triKeys[ti], kb = triKeys[m], va = tris[ti].v;
        const sh = [];
        for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) { if (ka[i] === kb[j]) { sh.push(va[i]); break; } }
        if (sh.length !== 2) return false;
        const e = norm(sub(sh[1], sh[0]));
        if (Math.abs(dot(e, ax)) < Math.cos(2 * DEG)) return false;
        hinges++;
      }
    }
    return hinges >= 2;
  };
  // Gezieltes Merken: nach einem Phase-1-Fehlschlag mit Start-Achse `failAxis` werden nur
  // Facetten markiert, deren EIGENE Start-Achse ∥ failAxis ist — sie würden praktisch denselben
  // Versuch wiederholen. Facetten mit anderer Achse (z.B. Bohrungs-Wand mit senkrechter Achse in
  // einer gescheiterten Verrundungs-Spalte mit waagerechter Achse) bleiben Seeds. Pauschales
  // Markieren der ganzen Region ließ die Wand verhungern (washer_filleted, empirisch belegt).
  const P1_SAME_AXIS_COS = Math.cos((opts.p1SameAxisDeg ?? 20) * DEG);
  const p1Fail = (failAxis, ...arrs) => {
    for (const a of arrs) {
      if (!a) continue;
      for (const ti of a) {
        if (p1tried[ti]) continue;
        const ea = edgeAxisOf(ti);
        if (ea && Math.abs(dot(ea, failAxis)) >= P1_SAME_AXIS_COS) p1tried[ti] = 1;
      }
    }
  };
  // Zwei Durchläufe über alle Seeds: erst mit Regel-Scharnier, dann (it ≥ T) nur mit Ausweich-
  // Scharnier (siehe seedHinge). Der Ausweich-Durchlauf sieht nur, was der erste übrig ließ —
  // dessen Ergebnisse bleiben damit unverändert. Ausweich-Scharniere schon im ersten Durchlauf
  // zerlegten z.B. die gebogene Bohrung des eBike-Halters anders (−1 Bohrung, empirisch belegt).
  for (let it = 0; it < 2 * T; it++) {
    const fallback = it >= T;
    const seed = fallback ? it - T : it;
    if (it === T) { p1fallback = true; p1tried.fill(0); edgeAxisState.fill(0); } // neue Start-Achsen
    if (visited[seed] || p1tried[seed]) continue;
    if (growWork > PHASE1_BUDGET) { phase1Truncated = true; break; }
    // Saat-Scharnier (gemeinsame Kante seed↔nb → Achsrichtung), nur über freie Nachbarn
    const hinge = seedHinge(seed, true, fallback);
    if (!hinge) continue;
    const axis0 = hinge.axis, wSeed = hinge.wSeed;
    // Achsen-beschränkter Bootstrap-Patch (Normale ⊥ axis0, ähnliche Profilbreite) für den Radius-Fit
    const boot = [];
    {
      const gb = ++gen;
      let layer = [seed]; stamp[seed] = gb;
      for (let depth = 0; depth < BOOT_DEPTH && layer.length && boot.length < BOOT_MAX; depth++) {
        const next = [];
        for (const cur of layer) {
          boot.push(cur);
          for (const m of adj[cur]) {
            if (stamp[m] === gb || visited[m]) continue;
            if (Math.abs(dot(tris[m].n, axis0)) <= AXIS_PERP && profW(m, axis0) <= 2.5 * wSeed) { stamp[m] = gb; next.push(m); }
          }
        }
        layer = next;
      }
    }
    if (boot.length < 4) continue;
    // Prisma-Vorfilter (O(Boot-Patch), kein Wachsen): auf einer echten Zylinderwand stehen
    // VIELE Facetten exakt ⊥ zur Scharnier-Achse (alle Wand-Facetten). Auf Kugel/Torus gilt
    // das nur für Seed + Nachbar selbst (deren gemeinsame Kante liegt in beiden Ebenen) —
    // die nächste Facette ist schon um den Teilungswinkel verdreht. Ausnahme: Kugel-Äquator-
    // band (lokal wirklich ein Prisma) — den fängt der Anti-Kugel-Wächter bzw. die Validierung.
    let strictN = 0;
    for (const ti of boot) if (Math.abs(dot(tris[ti].n, axis0)) <= STRICT_PERP) strictN++;
    if (strictN < 4) continue;
    const bverts = []; for (const ti of boot) for (const vv of tris[ti].v) bverts.push(vv);
    const circ0 = fitCircleRobust(bverts, axis0);
    if (!circ0 || !(circ0.radius >= MIN_RADIUS && circ0.radius <= MAX_RADIUS)) continue;
    // Wachsen + Nachfitten (enge Toleranz — die Achse ist ja exakt)
    p1tried[seed] = 1; // derselbe Seed wird in Phase 1 nie zweimal probiert
    let region = grow(seed, circ0.center, axis0, circ0.radius, Math.max(DIST_ABSTOL, DIST_RELTOL * circ0.radius), visited);
    if (region.length < MIN_TRIS) { p1Fail(axis0, region); continue; }
    let model = null, bad = false;
    for (let pass = 0; pass < 2; pass++) {
      const { axis: axF, values } = pcaAxis(region.map(ti => tris[ti].n));
      const verts = [];
      for (const ti of region) for (const vv of tris[ti].v) verts.push(vv);
      const circ = fitCircleRobust(verts, axF);
      if (!circ || !(circ.radius >= MIN_RADIUS && circ.radius <= MAX_RADIUS)) { bad = true; break; }
      model = { axis: axF, axisPoint: circ.center, radius: circ.radius, circ, values };
      region = grow(seed, model.axisPoint, model.axis, model.radius, Math.max(DIST_ABSTOL, DIST_RELTOL * circ.radius), visited);
      if (region.length < MIN_TRIS) { bad = true; break; }
    }
    if (bad || !model) { p1Fail(axis0, region); continue; }
    // grow() nimmt den Seed UNGEPRÜFT auf. Ist der Seed selbst kein Mantel-Dreieck (z.B. eine
    // Ebenen-Facette direkt an der Tangentenkante einer Verrundung — sie hat einen gekrümmten
    // Nachbarn und liefert sogar die exakte Achse), ruiniert sein ferner Eckpunkt den Fit.
    if (!fits(seed, model.axisPoint, model.axis, model.radius, Math.max(DIST_ABSTOL, DIST_RELTOL * model.radius))) {
      region = region.filter((ti) => ti !== seed);
      if (region.length < MIN_TRIS) { p1Fail(axis0, region); continue; }
    }
    // Schnell-Abbruch vor dem teuren Rettungspfad: Phase 1 akzeptiert nur volle Bohrungen, und
    // mit exakter Kanten-Achse umläuft eine echte Bohrungs-Region bereits hier den vollen Kreis
    // (Kontamination fügt höchstens Facetten hinzu, nimmt keine Umlauf-Abdeckung weg). Teil-
    // Bögen (Verrundungs-Spalten, Torus-Patches) → sofort aufgeben.
    {
      const cv = [];
      for (const ti of region) for (const vv of tris[ti].v) cv.push(vv);
      if (coverageDeg(cv, model.axisPoint, model.axis) < FULL_COV) {
        // Teil-Umlauf: Kandidat für eine GERADE KANTEN-VERRUNDUNG (Fillet). Streng prüfen,
        // OHNE Rettungspfad: echtes Prisma (alle inneren Scharnier-Kanten ∥ Achse — billig, bricht
        // auf Torus-/Kegel-Patches an der ersten gedrehten Kante ab) → reguläre Gates inkl.
        // „nur von EBENEN begrenzt" → plausibler Bogen (≤ 180°). Liefert die Fillets, die das
        // Body-Defeaturing im Exporter (Verrundung → scharfe Kante) braucht.
        const vF = isPrism(region, model.axis) ? validateRegion(region, model) : { ok: false };
        if (vF.ok && !vF.full && vF.cov <= 180) {
          acceptPrim(vF, region, region);
          continue;
        }
        p1Fail(axis0, region); continue;
      }
    }
    let v = validateRegion(region, model);
    let tagged = region;
    let touched = null;
    if (!v.ok) {
      const resc = tryRescue(seed, region, model, v);
      if (resc && resc.ok) { v = resc.v; tagged = resc.tagged; region = resc.consume; }
      else if (resc) touched = resc.touched;
    }
    if (!v.ok || !v.full) { p1Fail(axis0, region, touched); continue; } // Phase 1: kein globaler Verbrauch bei Fehlschlag
    if (tagged === region) {
      // Erstversuch ohne Rettung → Kern-Politur (falls valide): entfernt fleckig mitgewachsene
      // Fillet-Facetten von der getaggten Fläche → saubere Rand-Kreise für den Exporter.
      const ceP = extractCylinderCore(region, model);
      if (ceP) {
        const vP = validateRegion(ceP.core, ceP.model);
        if (vP.ok && vP.full) { v = vP; tagged = ceP.core; }
      }
    }
    acceptPrim(v, tagged, region);
  }

  // ── Phase 2: Bootstrap-PCA-Seeding (bisheriger Pfad, unverändert) ───────────
  for (let seed = 0; seed < T; seed++) {
    if (visited[seed]) continue;
    // bestgekrümmten freien Nachbarn finden (Saat-Kante)
    let nb = -1, bestC = -1;
    for (const m of adj[seed]) {
      if (visited[m]) continue;
      const c = dot(tris[seed].n, tris[m].n);
      if (c >= SEED_MIN_COS && c <= SEED_MAX_COS && c > bestC) { bestC = c; nb = m; }
    }
    if (nb < 0) { continue; } // keine gekrümmte Saat-Kante → kein Zylinder-Seed

    // Bootstrap: kleinen dihedral-zusammenhängenden Patch tiefenbegrenzt wachsen und daraus
    // Achse (PCA der Normalen) + Radius/Center (Kåsa über ECHTE Oberflächen-Vertices) schätzen.
    // Robuster als eine 2-Punkt-Schätzung über Schwerpunkte (die bei groben Facetten zu ungenau ist).
    const boot = [];
    {
      const gb = ++gen;
      let layer = [seed]; stamp[seed] = gb;
      for (let depth = 0; depth < BOOT_DEPTH && layer.length && boot.length < BOOT_MAX; depth++) {
        const next = [];
        for (const cur of layer) {
          boot.push(cur);
          for (const m of adj[cur]) {
            if (stamp[m] === gb || visited[m]) continue;
            if (dot(tris[cur].n, tris[m].n) >= COS_BOOT) { stamp[m] = gb; next.push(m); }
          }
        }
        layer = next;
      }
    }
    if (boot.length < 4) { visited[seed] = 1; continue; }
    const axisB = pcaAxis(boot.map(ti => tris[ti].n)).axis;
    const bverts = []; for (const ti of boot) for (const vv of tris[ti].v) bverts.push(vv);
    const circB = fitCircleRobust(bverts, axisB);
    if (!circB || !(circB.radius >= MIN_RADIUS && circB.radius <= MAX_RADIUS)) { visited[seed] = 1; continue; }

    // Erstes Wachsen mit großzügiger Toleranz; die genaue Achse/Radius kommt aus dem Nachfitten.
    let region = grow(seed, circB.center, axisB, circB.radius, Math.max(DIST_ABSTOL, 0.5 * circB.radius), visited);
    if (region.length < 3) { visited[seed] = 1; continue; }

    // Nachfitten: Achse via PCA der Normalen, Radius/Center via Kåsa
    let model = null;
    for (let pass = 0; pass < 2; pass++) {
      const normals = region.map(ti => tris[ti].n);
      const { axis: axF, values } = pcaAxis(normals);
      const verts = [];
      for (const ti of region) for (const vv of tris[ti].v) verts.push(vv);
      const circ = fitCircleRobust(verts, axF);
      if (!circ || !(circ.radius >= MIN_RADIUS && circ.radius <= MAX_RADIUS)) { region = null; break; }
      model = { axis: axF, axisPoint: circ.center, radius: circ.radius, circ, values };
      const distTol = Math.max(DIST_ABSTOL, DIST_RELTOL * circ.radius);
      region = grow(seed, model.axisPoint, model.axis, model.radius, distTol, visited);
      if (region.length < 3) { region = null; break; }
    }
    if (!region || !model) { visited[seed] = 1; continue; }
    // Anti-Blowup: bei Verwerfung wird unten die ganze Region als besucht markiert (failRegion),
    // damit eine verworfene Kegel-/Kugel-Region nicht von jedem Nachbar-Seed neu durchwachsen wird.
    // Bei Erfolg markiert die Tagging-Schleife die Region; nur dann werden Gruppen getaggt.
    const failRegion = () => { for (const ti of region) visited[ti] = 1; };

    // Validieren — erster Durchlauf exakt wie bisher (bestehende Fälle bleiben identisch);
    // bei Kontaminations-typischem Scheitern der Rettungspfad (nur volle Bohrungen).
    let v = validateRegion(region, model);
    let tagged = region;
    if (!v.ok) {
      const resc = tryRescue(seed, region, model, v);
      if (resc && resc.ok) { v = resc.v; tagged = resc.tagged; region = resc.consume; }
      else if (resc) region = region.concat(resc.touched); // gescheiterten Regrow mit verbrauchen
    }
    if (!v.ok) { failRegion(); continue; }
    // Teil-Zylinder (Verrundung) nur, wenn er ein echtes Prisma ist (alle inneren Scharniere ∥ Achse)
    // — wie in Phase 1. Ohne diese Prüfung hielt Phase 2 Stücke von Kegelmänteln, Torus-Bändern und
    // Bohrungsbruchstücke für „Verrundungen“ (cone_frustum: 7 Schein-Fillets); v1 wollte sie dann
    // entfernen, öffnete die Hülle und der Export fiel komplett auf facettiert zurück.
    if (!v.full && !isPrism(tagged, v.axis)) { failRegion(); continue; }

    acceptPrim(v, tagged, region);
  }

  return {
    groups: normalGroups,
    primitives,
    stats: {
      inputGroups: normalGroups.length, cylinders: primitives.length, bores, fillets,
      // Diagnose: true = Sicherheitsnetz hat gegriffen (Zusatzpfad gekappt, Phase 2 lief voll)
      phase1Truncated, rescueTruncated
    }
  };
}

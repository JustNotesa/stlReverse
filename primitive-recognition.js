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

// Kåsa-Kreis-Fit in der Ebene ⊥ axis → { center3d, radius, meanDev, maxDev }.
function fitCircleInPlane(points, axis) {
  const c0 = centroid3(points);
  let u = cross(axis, [1, 0, 0]);
  if (len(u) < 1e-6) u = cross(axis, [0, 1, 0]);
  u = norm(u);
  const v = norm(cross(axis, u));
  let Sxx=0, Sxy=0, Syy=0, Sx=0, Sy=0, Sxz=0, Syz=0, Sz=0;
  const N = points.length;
  for (const p of points) {
    const d = sub(p, c0);
    const x = dot(d, u), y = dot(d, v), z = x*x + y*y;
    Sxx+=x*x; Sxy+=x*y; Syy+=y*y; Sx+=x; Sy+=y; Sxz+=x*z; Syz+=y*z; Sz+=z;
  }
  const sol = solve3([[Sxx,Sxy,Sx],[Sxy,Syy,Sy],[Sx,Sy,N]], [-Sxz,-Syz,-Sz]);
  if (!sol) return null;
  const cu = -sol[0]/2, cv = -sol[1]/2;
  const r2 = cu*cu + cv*cv - sol[2];
  if (r2 <= 0) return null;
  const radius = Math.sqrt(r2);
  const center = add(c0, add(scale(u, cu), scale(v, cv)));
  let sum = 0, mx = 0;
  for (const p of points) { const d = Math.abs(perpDist(p, center, axis) - radius); sum += d; if (d > mx) mx = d; }
  return { center, radius, meanDev: sum / N, maxDev: mx };
}

// Robuster Kreis-Fit: getrimmte Kåsa-Iteration — verwirft Ausreißer (z. B. tangentiale
// Ebenen-Punkte, die nicht auf dem Zylinder liegen) und konvergiert auf den Mehrheits-Kreis.
function fitCircleRobust(points, axis) {
  let fit = fitCircleInPlane(points, axis);
  if (!fit) return null;
  let pts = points;
  for (let it = 0; it < 4 && pts.length >= 8; it++) {
    const res = pts.map(p => ({ p, r: Math.abs(perpDist(p, fit.center, axis) - fit.radius) }));
    res.sort((a, b) => a.r - b.r);
    const med = res[Math.floor(res.length / 2)].r || 1e-9;
    // Residual-Schwelle relativ zum MEDIAN (unempfindlich gegen einen kontaminierten Startfit);
    // mit Mindest-Behalt, damit echte Kreis-Punkte nicht weggetrimmt werden.
    let keep = res.filter(x => x.r <= 2.5 * med).map(x => x.p);
    const floor = Math.max(6, Math.floor(res.length * 0.5));
    if (keep.length < floor) keep = res.slice(0, floor).map(x => x.p);
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
  const ang = [];
  for (const p of points) { const d = sub(p, axisPoint); ang.push(Math.atan2(dot(d, v), dot(d, u))); }
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
      tris.push({ n, v: [v0, v1, v2], c: centroid3([v0, v1, v2]), g: gi });
      for (const vv of [v0, v1, v2]) for (let k = 0; k < 3; k++) { if (vv[k] < mn[k]) mn[k] = vv[k]; if (vv[k] > mx[k]) mx[k] = vv[k]; }
    }
  });
  const T = tris.length;
  if (!T) return empty;
  const diag = len(sub(mx, mn)) || 1;
  const MAX_RADIUS = opts.maxRadius ?? diag; // Zylinder größer als das Bauteil ist unplausibel

  // 2) Manifold-Adjazenz
  const key  = (p) => `${p[0].toFixed(4)},${p[1].toFixed(4)},${p[2].toFixed(4)}`;
  const ekey = (a, b) => { const ka = key(a), kb = key(b); return ka < kb ? ka + '|' + kb : kb + '|' + ka; };
  const edgeToTris = new Map();
  for (let i = 0; i < T; i++) {
    const v = tris[i].v;
    for (let k = 0; k < 3; k++) {
      const e = ekey(v[k], v[(k + 1) % 3]);
      let a = edgeToTris.get(e); if (!a) { a = []; edgeToTris.set(e, a); }
      a.push(i);
    }
  }
  const adj = Array.from({ length: T }, () => []);
  for (const t of edgeToTris.values()) if (t.length === 2) { adj[t[0]].push(t[1]); adj[t[1]].push(t[0]); }

  // Helfer: passt ein Dreieck auf das Zylinder-Modell?
  const fits = (ti, ap, ax, r, distTol) => {
    if (Math.abs(dot(tris[ti].n, ax)) > AXIS_PERP) return false;   // Normale ⊥ Achse?
    for (const vv of tris[ti].v) if (Math.abs(perpDist(vv, ap, ax) - r) > distTol) return false;
    return true;
  };
  // Wiederverwendbarer Scratch-Puffer (Generations-Stempel) statt new Uint8Array(T) pro Aufruf.
  const stamp = new Int32Array(T);
  let gen = 0;

  // Region per BFS wachsen (nur über noch freie, passende Nachbarn)
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
    return region;
  };

  const visited = new Uint8Array(T);
  const primitives = [];
  let bores = 0, fillets = 0;

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

    // Validieren
    if (region.length < MIN_TRIS) { failRegion(); continue; }
    const verts = [];
    for (const ti of region) for (const vv of tris[ti].v) verts.push(vv);
    const circ = fitCircleInPlane(verts, model.axis);
    if (!circ) { failRegion(); continue; }
    const r = circ.radius;
    if (!(r >= MIN_RADIUS && r <= MAX_RADIUS)) { failRegion(); continue; }
    if (circ.meanDev > Math.max(0.08, MANTEL_MEAN * r)) { failRegion(); continue; }
    if (circ.maxDev  > Math.max(0.5,  MANTEL_MAX  * r)) { failRegion(); continue; }
    // Normalen müssen ≥2D streuen (sonst flach): mittlerer Eigenwert relevant
    const vls = model.values;
    if (!(vls[2] > 0) || vls[1] / vls[2] < EIGEN_MID) { failRegion(); continue; }

    const axis = model.axis, axisPoint = circ.center;

    // Zylinder-vs-Kegel/Kugel (lokal, billig): Normalen eines echten Zylinders stehen ⊥ zur Achse.
    let s2 = 0; for (const ti of region) { const d = dot(tris[ti].n, axis); s2 += d * d; }
    if (Math.sqrt(s2 / region.length) > AXIS_RMS_MAX) { failRegion(); continue; }

    // Konizitäts-Test (global, fängt auch dünne Kegel-Scheiben): der Abstand zur Achse darf
    // entlang der Achse nicht systematisch driften. Bei einem Kegel ist d(radius)/d(achse) =
    // tan(Halbwinkel) ≠ 0 — die Steigung ist skaleninvariant, anders als der lokale RMS oben.
    {
      let st = 0, sp = 0, stt = 0, stp = 0; const nN = verts.length;
      for (const vv of verts) {
        const t = dot(sub(vv, circ.center), axis);
        const pd = perpDist(vv, circ.center, axis);
        st += t; sp += pd; stt += t * t; stp += t * pd;
      }
      const den = nN * stt - st * st;
      const slope = Math.abs(den) > 1e-9 ? (nN * stp - st * sp) / den : 0;
      if (Math.abs(slope) > TAPER_MAX) { failRegion(); continue; } // Kegel/Taper
    }

    const cov = coverageDeg(verts, axisPoint, axis);
    if (cov < MIN_COV) { failRegion(); continue; }
    const full = cov >= FULL_COV;

    // Krümmungs-Rand-Test für TEIL-Zylinder (Fillets): müssen von EBENEN Flächen begrenzt sein,
    // nicht von weiterer gekrümmter Fläche → verwirft osculating gefittete Kegel-Scheiben. Nur für
    // Teil-Zylinder, da er volle Bohrungen mit nicht-perfekt-ebenen Mündungen fälschlich verwerfen kann.
    // (Trade-off: eine dünne Kugel-Äquatorscheibe kann so als „Bohrung" durchrutschen — seltener Fall.)
    if (!full) {
      const regSet = new Set(region);
      const seen = new Set();
      let flatN = 0, curvedN = 0;
      for (const ti of region) {
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
      if (curvedN > flatN) { failRegion(); continue; } // von Krümmung begrenzt → Kegel/Kugel-Scheibe
    }

    // Höhe + End-Stützpunkt entlang der Achse (für Overlay)
    let tMin = Infinity, tMax = -Infinity;
    for (const vv of verts) { const tt = dot(sub(vv, circ.center), axis); if (tt < tMin) tMin = tt; if (tt > tMax) tMax = tt; }
    const height = tMax - tMin;
    const endPoint = add(circ.center, scale(axis, tMin));

    const prim = {
      type: 'cylinder', kind: full ? 'bore' : 'fillet', full,
      id: primitives.length, axis, axisPoint: endPoint, radius: r, height,
      coverageDeg: cov, triCount: region.length,
      meanDevMm: circ.meanDev
    };
    primitives.push(prim);
    if (full) bores++; else fillets++;

    for (const ti of region) { visited[ti] = 1; normalGroups[tris[ti].g].primitive = prim; }
  }

  return {
    groups: normalGroups,
    primitives,
    stats: { inputGroups: normalGroups.length, cylinders: primitives.length, bores, fillets }
  };
}

/**
 * tube-sweep.js — Erkennung gebogener KANÄLE (Rohr / „swept disk“: ein Kreis vom Radius r,
 * entlang einer Bahn gezogen) + Bahn-Fit als Biarc-Kette (tangential verkettete Kreisbögen
 * und Geraden).
 *
 * Ergebnis je Kanal: eine Kette exakter Flächen für den STEP-Export —
 *   Geradenstück  → CYLINDRICAL_SURFACE (Achse = Gerade, Radius r)
 *   Bogenstück    → TOROIDAL_SURFACE   (Hauptradius = Bogenradius, Nebenradius r)
 * Benachbarte Stücke teilen sich exakt EINE volle Kreiskante (Querschnittskreis an der
 * Übergangsstelle, Achse = Bahntangente). Weil die Kette G1-stetig ist (gemeinsame Tangente),
 * liegt dieser Kreis exakt auf BEIDEN Flächen.
 *
 * Ablauf (reine Funktionen, keine Abhängigkeiten):
 *   1. Dreiecke aller normalGroups einsammeln, Manifold-Kanten-Nachbarschaft aufbauen.
 *   2. Je glatter Kante (Knickwinkel klein) den lokalen Krümmungsradius schätzen: die beiden
 *      Normalen-Geraden c + s·n treffen sich bei einem Kanal (Hohlraum, Normale zeigt zur Achse)
 *      im Abstand r auf der Normalen-Seite → r_e = −(Δc·Δn)/|Δn|² > 0.
 *   3. Konkav gekrümmte Dreiecke zu Komponenten verbinden; Kandidat = genau 2 Rand-Loops
 *      (Durchgangskanal, Mündungen in ebenen Flächen), Gruppen vollständig enthalten.
 *   4. Mittellinie per „Marschieren“: von Mündung A aus Querschnitts-Ebenen ⟂ Bahntangente
 *      durch das Netz legen, Schnittpunkte mit den Netzkanten → Kreis-Fit (fester Radius) →
 *      exakter Mittelpunkt; Tangente aus den letzten Mittelpunkten nachführen.
 *   5. Ebene Bahn → 2D: gerade Abschnitte als Geraden, Rest per rekursiver Biarc-Näherung
 *      (Toleranz ≤ 0.02 mm zu den Mittelpunkten), Enden = Geraden bei schrägen Mündungen.
 *   6. Validierung: JEDER Netz-Vertex muss im Abstand r ± Toleranz zur Biarc-Bahn liegen.
 * Scheitert irgendein Schritt → kein Tag → Kanal bleibt facettiert (wasserdicht wie bisher).
 *
 * Getaggt wird je beteiligter Gruppe: group.tube = spec (gemeinsames, reines Datenobjekt —
 * übersteht die Worker-Grenze per structured clone; Gruppierung im Exporter über spec.id).
 */

// ── Vektor-Helfer ───────────────────────────────────────────────────────────
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const addv = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const DEG = Math.PI / 180;

// −0/+0 vereinheitlichen, 4 Nachkommastellen — identisch zu vtxKey im Exporter/Region-Growing.
const fz = (x) => { const s = x.toFixed(4); return s === '-0.0000' ? '0.0000' : s; };
const vkey = (v) => `${fz(v[0])},${fz(v[1])},${fz(v[2])}`;

// Beliebige Einheits-Senkrechte zu n (stabil)
const perpOf = (n) => {
  const ax = Math.abs(n[0]), ay = Math.abs(n[1]), az = Math.abs(n[2]);
  const ref = ax <= ay && ax <= az ? [1, 0, 0] : ay <= ax && ay <= az ? [0, 1, 0] : [0, 0, 1];
  return norm(cross(n, ref));
};

// ── Symmetrischer 3x3-Eigensolver (Jacobi), Eigenwerte aufsteigend ───────────
function eigenSym3(M) {
  const A = [M[0].slice(), M[1].slice(), M[2].slice()];
  const V = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let it = 0; it < 60; it++) {
    let p = 0, q = 1, mx = Math.abs(A[0][1]);
    if (Math.abs(A[0][2]) > mx) { mx = Math.abs(A[0][2]); p = 0; q = 2; }
    if (Math.abs(A[1][2]) > mx) { mx = Math.abs(A[1][2]); p = 1; q = 2; }
    if (mx < 1e-15) break;
    const th = (A[q][q] - A[p][p]) / (2 * A[p][q]);
    const t = (th >= 0 ? 1 : -1) / (Math.abs(th) + Math.sqrt(th * th + 1));
    const c = 1 / Math.sqrt(t * t + 1), s = t * c;
    for (let k = 0; k < 3; k++) {
      const akp = A[k][p], akq = A[k][q];
      A[k][p] = c * akp - s * akq; A[k][q] = s * akp + c * akq;
    }
    for (let k = 0; k < 3; k++) {
      const apk = A[p][k], aqk = A[q][k];
      A[p][k] = c * apk - s * aqk; A[q][k] = s * apk + c * aqk;
    }
    for (let k = 0; k < 3; k++) {
      const vkp = V[k][p], vkq = V[k][q];
      V[k][p] = c * vkp - s * vkq; V[k][q] = s * vkp + c * vkq;
    }
  }
  const idx = [0, 1, 2].sort((i, j) => A[i][i] - A[j][j]);
  return { values: idx.map((i) => A[i][i]), vectors: idx.map((i) => [V[0][i], V[1][i], V[2][i]]) };
}

// Ebenen-Fit (PCA): { c, n, maxDev }
function fitPlane(pts) {
  let c = [0, 0, 0];
  for (const p of pts) c = addv(c, p);
  c = mul(c, 1 / pts.length);
  const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const p of pts) {
    const d = sub(p, c);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) M[i][j] += d[i] * d[j];
  }
  const { vectors } = eigenSym3(M);
  const n = norm(vectors[0]);
  let maxDev = 0;
  for (const p of pts) maxDev = Math.max(maxDev, Math.abs(dot(sub(p, c), n)));
  return { c, n, u: norm(vectors[2]), maxDev };
}

// Rand-Kanten (genau 1× benutzt) zu geschlossenen Loops verketten (über Vertex-Schlüssel).
function chainLoops(bEdges) {
  const adj = new Map();
  for (const [ka, kb, pa, pb] of bEdges) {
    if (!adj.has(ka)) adj.set(ka, { p: pa, nb: [] });
    if (!adj.has(kb)) adj.set(kb, { p: pb, nb: [] });
    adj.get(ka).nb.push(kb); adj.get(kb).nb.push(ka);
  }
  for (const e of adj.values()) if (e.nb.length !== 2) return null; // Rand nicht sauber (Berührpunkte)
  const seen = new Set();
  const loops = [];
  for (const [k0, e0] of adj) {
    if (seen.has(k0)) continue;
    const loop = [];
    let prev = null, cur = k0;
    for (let guard = 0; guard <= adj.size; guard++) {
      seen.add(cur); loop.push(adj.get(cur).p);
      const nb = adj.get(cur).nb;
      const nxt = nb[0] !== prev ? nb[0] : nb[1];
      prev = cur; cur = nxt;
      if (cur === k0) break;
    }
    if (cur !== k0) return null;
    loops.push(loop);
    void e0;
  }
  return loops;
}

// ════════════════════════════════════════════════════════════════════════════
// 1.–3. Kandidaten-Komponenten
// ════════════════════════════════════════════════════════════════════════════
const DIH_MIN = 0.3 * DEG;   // darunter: Kante quasi eben → keine Krümmungs-Aussage
const DIH_MAX = 40 * DEG;    // darüber: scharfe Kante (Mündung in Ebene) → trennt Komponenten
const MIN_TRIS = 40;         // kleinere Komponenten lohnen keinen Rohr-Fit

function collectTriangles(normalGroups) {
  let n = 0;
  for (const g of normalGroups) n += Math.floor((g.vertices?.length || 0) / 3);
  const V = new Array(n);                // [a,b,c] Referenzen
  const N = new Float64Array(n * 3), C = new Float64Array(n * 3), A = new Float64Array(n);
  const G = new Int32Array(n);
  let t = 0;
  normalGroups.forEach((g, gi) => {
    const vs = g.vertices || [];
    for (let i = 0; i + 2 < vs.length; i += 3) {
      const a = vs[i], b = vs[i + 1], c = vs[i + 2];
      const u = sub(b, a), w = sub(c, a);
      const cr = cross(u, w), l = len(cr);
      V[t] = [a, b, c]; G[t] = gi; A[t] = l / 2;
      if (l > 1e-12) { N[3 * t] = cr[0] / l; N[3 * t + 1] = cr[1] / l; N[3 * t + 2] = cr[2] / l; }
      C[3 * t] = (a[0] + b[0] + c[0]) / 3; C[3 * t + 1] = (a[1] + b[1] + c[1]) / 3; C[3 * t + 2] = (a[2] + b[2] + c[2]) / 3;
      t++;
    }
  });
  return { n: t, V, N, C, A, G };
}

function findCandidates(T) {
  const { n, V, N, C, A } = T;
  // Kanten-Map: Schlüssel → [t, …]
  const keyOf = new Array(n);
  const edgeTris = new Map();
  for (let t = 0; t < n; t++) {
    const ks = [vkey(V[t][0]), vkey(V[t][1]), vkey(V[t][2])];
    keyOf[t] = ks;
    for (let k = 0; k < 3; k++) {
      const a = ks[k], b = ks[(k + 1) % 3];
      const ek = a < b ? a + '|' + b : b + '|' + a;
      let e = edgeTris.get(ek); if (!e) { e = []; edgeTris.set(ek, e); }
      e.push(t);
    }
  }
  // Glatte Manifold-Kanten + Krümmungsradius-Schätzung quer zur gemeinsamen Kante:
  // h = Höhe des jeweils gegenüberliegenden Eckpunkts über der Kante (im Dreieck), bei einem
  // Kreisquerschnitt h ≈ 2r·sin(φ/2) und Knickwinkel ≈ φ → r_e = (h_t + h_u)/2 / (2·sin(dih/2)).
  // (Schwerpunkt-Abstände wären um ~2/3 verzerrt — Schwerpunkt liegt nicht mittig über der Kante.)
  // Vorzeichen: konkav (Hohlraum, Normalen laufen zur Achse zusammen) ⇔ Δn·Δa < 0.
  const curved = new Uint8Array(n);
  const smooth = [];   // [t, u, rE (NaN = keine Aussage), dih]
  const opp = (t, ka, kb) => { const ks = keyOf[t]; for (let k = 0; k < 3; k++) if (ks[k] !== ka && ks[k] !== kb) return V[t][k]; return null; };
  for (const [ek, ts] of edgeTris) {
    if (ts.length !== 2) continue;
    const t = ts[0], u = ts[1];
    if (!(A[t] > 0) || !(A[u] > 0)) continue;
    const cs = N[3 * t] * N[3 * u] + N[3 * t + 1] * N[3 * u + 1] + N[3 * t + 2] * N[3 * u + 2];
    const dih = Math.acos(Math.max(-1, Math.min(1, cs)));
    if (dih > DIH_MAX) continue;
    let rE = NaN;
    if (dih >= DIH_MIN) {
      const [ka, kb] = ek.split('|');
      const at = opp(t, ka, kb), au = opp(u, ka, kb);
      if (at && au) {
        let e0 = null, e1 = null;
        for (let k = 0; k < 3; k++) { const kk = keyOf[t][k]; if (kk === ka) e0 = V[t][k]; else if (kk === kb) e1 = V[t][k]; }
        const ed = norm(sub(e1, e0));
        const hOf = (p) => { const w = sub(p, e0); return len(sub(w, mul(ed, dot(w, ed)))); };
        const dn = [N[3 * u] - N[3 * t], N[3 * u + 1] - N[3 * t + 1], N[3 * u + 2] - N[3 * t + 2]];
        const concave = dot(dn, sub(au, at)) < 0;
        if (concave) {
          rE = (hOf(at) + hOf(au)) / 2 / (2 * Math.sin(dih / 2));
          curved[t] = 1; curved[u] = 1;
        }
      }
    }
    smooth.push([t, u, rE, dih]);
  }
  // Union-Find über glatte Kanten zwischen konkav gekrümmten Dreiecken
  const par = new Int32Array(n); for (let i = 0; i < n; i++) par[i] = i;
  const find = (x) => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
  for (const [t, u] of smooth) if (curved[t] && curved[u]) { const a = find(t), b = find(u); if (a !== b) par[a] = b; }
  const comps = new Map();
  for (let t = 0; t < n; t++) if (curved[t]) { const r = find(t); let c = comps.get(r); if (!c) { c = []; comps.set(r, c); } c.push(t); }
  // Radius je Komponente: gewichteter Median der r_e (Gewicht = Knickwinkel) innerer Kanten
  const out = [];
  const rootOf = (t) => (curved[t] ? find(t) : -1);
  const radii = new Map();
  for (const [t, u, rE, dih] of smooth) {
    if (!(rE > 0)) continue;
    const r = rootOf(t); if (r < 0 || r !== rootOf(u)) continue;
    let L = radii.get(r); if (!L) { L = []; radii.set(r, L); } L.push([rE, dih]);
  }
  for (const [root, tris] of comps) {
    if (tris.length < MIN_TRIS) continue;
    const L = radii.get(root); if (!L || L.length < 10) continue;
    L.sort((p, q) => p[0] - q[0]);
    let wt = 0; for (const x of L) wt += x[1];
    let acc = 0, rMed = L[0][0];
    for (const x of L) { acc += x[1]; if (acc >= wt / 2) { rMed = x[0]; break; } }
    // Konsistenz: Großteil des Knickwinkel-Gewichts nahe rMed (Kanal-Querschnitt dominiert)
    let near = 0; for (const x of L) if (Math.abs(x[0] - rMed) <= 0.15 * rMed) near += x[1];
    if (near < 0.6 * wt) continue;
    out.push({ tris, r0: rMed });
  }
  return { candidates: out, keyOf };
}

// ════════════════════════════════════════════════════════════════════════════
// 4. Mittellinie per Querschnitts-Marsch
// ════════════════════════════════════════════════════════════════════════════
// Kreis-Fit mit freiem Radius in 2D (geometrisch, Gauss-Newton auf cx, cy, r), Start c0/r0.
function fitCircleFree(pts, c0, r0) {
  let cx = c0[0], cy = c0[1], r = r0;
  for (let it = 0; it < 40; it++) {
    // Normalgleichungen J^T J δ = J^T res, J = [dx/d, dy/d, −1]
    const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], g = [0, 0, 0];
    for (const p of pts) {
      const dx = cx - p[0], dy = cy - p[1];
      const d = Math.hypot(dx, dy) || 1e-12;
      const res = d - r, J = [dx / d, dy / d, -1];
      for (let i = 0; i < 3; i++) { g[i] += J[i] * res; for (let j = 0; j < 3; j++) M[i][j] += J[i] * J[j]; }
    }
    const det = M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1]) - M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0]) + M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0]);
    if (Math.abs(det) < 1e-18) return null;
    const solveCol = (ci) => { const Mc = M.map((row, ri) => row.map((x, cj) => (cj === ci ? g[ri] : x))); return (Mc[0][0] * (Mc[1][1] * Mc[2][2] - Mc[1][2] * Mc[2][1]) - Mc[0][1] * (Mc[1][0] * Mc[2][2] - Mc[1][2] * Mc[2][0]) + Mc[0][2] * (Mc[1][0] * Mc[2][1] - Mc[1][1] * Mc[2][0])) / det; };
    const s0 = solveCol(0), s1 = solveCol(1), s2 = solveCol(2);
    cx -= s0; cy -= s1; r -= s2;
    if (Math.hypot(s0, s1, s2) < 1e-10) break;
  }
  if (!(r > 0)) return null;
  let rms = 0, mx = 0;
  for (const p of pts) { const e = Math.hypot(cx - p[0], cy - p[1]) - r; rms += e * e; mx = Math.max(mx, Math.abs(e)); }
  return { c: [cx, cy], r, rms: Math.sqrt(rms / pts.length), max: mx };
}

// Kreis-Fit mit festem Radius r in 2D (Gauss-Newton auf dem Mittelpunkt), Start c0.
function fitCircleFixedR(pts, r, c0) {
  let cx = c0[0], cy = c0[1];
  for (let it = 0; it < 30; it++) {
    let JtJ00 = 0, JtJ01 = 0, JtJ11 = 0, Jtr0 = 0, Jtr1 = 0;
    for (const p of pts) {
      const dx = cx - p[0], dy = cy - p[1];
      const d = Math.hypot(dx, dy) || 1e-12;
      const res = d - r, jx = dx / d, jy = dy / d;
      JtJ00 += jx * jx; JtJ01 += jx * jy; JtJ11 += jy * jy; Jtr0 += jx * res; Jtr1 += jy * res;
    }
    const det = JtJ00 * JtJ11 - JtJ01 * JtJ01;
    if (Math.abs(det) < 1e-18) return null;
    const sx = (JtJ11 * Jtr0 - JtJ01 * Jtr1) / det, sy = (JtJ00 * Jtr1 - JtJ01 * Jtr0) / det;
    cx -= sx; cy -= sy;
    if (Math.hypot(sx, sy) < 1e-9) break;
  }
  let rms = 0, mx = 0;
  for (const p of pts) { const e = Math.hypot(cx - p[0], cy - p[1]) - r; rms += e * e; mx = Math.max(mx, Math.abs(e)); }
  return { c: [cx, cy], rms: Math.sqrt(rms / pts.length), max: mx };
}

// Winkel-Abdeckung (Grad) der Punkte um c in 2D (größte Lücke abgezogen)
function angularCoverage(pts, c) {
  const angs = pts.map((p) => Math.atan2(p[1] - c[1], p[0] - c[0])).sort((a, b) => a - b);
  let gap = 0;
  for (let i = 0; i < angs.length; i++) {
    const nx = i + 1 < angs.length ? angs[i + 1] : angs[0] + 2 * Math.PI;
    gap = Math.max(gap, nx - angs[i]);
  }
  return (2 * Math.PI - gap) / DEG;
}

// Netzkanten der Komponente (eindeutig) als flaches Float64Array [ax,ay,az,bx,by,bz, …] + Raster:
// jede Kante wird in ALLE Zellen ihrer Hüllbox eingetragen (lange Kanten in geraden Abschnitten),
// Abfrage mit Stempel-Array gegen Doppelte. Die Querschnitte sind der Hauptaufwand der Erkennung.
function buildEdgeIndex(T, tris, keyOf, cell) {
  const list = []; const seen = new Set();
  let total = 0;
  for (const t of tris) {
    for (let k = 0; k < 3; k++) {
      const ka = keyOf[t][k], kb = keyOf[t][(k + 1) % 3];
      const ek = ka < kb ? ka + '|' + kb : kb + '|' + ka;
      if (seen.has(ek)) continue; seen.add(ek);
      const a = T.V[t][k], b = T.V[t][(k + 1) % 3];
      list.push(a[0], a[1], a[2], b[0], b[1], b[2]);
      total += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    }
  }
  const E = Float64Array.from(list), nE = E.length / 6;
  const map = new Map();
  const key = (i, j, k) => (i * 73856093) ^ (j * 19349663) ^ (k * 83492791);
  for (let e = 0; e < nE; e++) {
    const o = 6 * e;
    const i0 = Math.floor(Math.min(E[o], E[o + 3]) / cell), i1 = Math.floor(Math.max(E[o], E[o + 3]) / cell);
    const j0 = Math.floor(Math.min(E[o + 1], E[o + 4]) / cell), j1 = Math.floor(Math.max(E[o + 1], E[o + 4]) / cell);
    const k0 = Math.floor(Math.min(E[o + 2], E[o + 5]) / cell), k1 = Math.floor(Math.max(E[o + 2], E[o + 5]) / cell);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) for (let k = k0; k <= k1; k++) {
      const kk = key(i, j, k);
      let bkt = map.get(kk); if (!bkt) { bkt = []; map.set(kk, bkt); } bkt.push(e);
    }
  }
  const stamp = new Int32Array(nE); let qid = 0;
  const query = (p, rad) => {
    qid++;
    const out = [];
    const i0 = Math.floor((p[0] - rad) / cell), i1 = Math.floor((p[0] + rad) / cell);
    const j0 = Math.floor((p[1] - rad) / cell), j1 = Math.floor((p[1] + rad) / cell);
    const k0 = Math.floor((p[2] - rad) / cell), k1 = Math.floor((p[2] + rad) / cell);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) for (let k = k0; k <= k1; k++) {
      const bkt = map.get(key(i, j, k));
      if (bkt) for (const e of bkt) if (stamp[e] !== qid) { stamp[e] = qid; out.push(e); }
    }
    return out;
  };
  return { E, query, total };
}

// Querschnitt: Ebene (p, Normale T) ∩ Netzkanten, nur Punkte nahe p → Kreis-Fit → Mittelpunkt
function crossSection(idx, p, T, r) {
  const u = perpOf(T), v = cross(T, u);
  const reach = r * 1.6, reach2 = reach * reach;
  const cand = idx.query(p, reach);
  const E = idx.E, px = p[0], py = p[1], pz = p[2], tx = T[0], ty = T[1], tz = T[2];
  const pts2 = [];
  for (const e of cand) {
    const o = 6 * e;
    const ax = E[o] - px, ay = E[o + 1] - py, az = E[o + 2] - pz;
    const bx = E[o + 3] - px, by = E[o + 4] - py, bz = E[o + 5] - pz;
    const da = ax * tx + ay * ty + az * tz, db = bx * tx + by * ty + bz * tz;
    if ((da > 0 && db > 0) || (da < 0 && db < 0) || da === db) continue;
    const s = da / (da - db);
    const wx = ax + (bx - ax) * s, wy = ay + (by - ay) * s, wz = az + (bz - az) * s;
    if (wx * wx + wy * wy + wz * wz > reach2) continue;
    pts2.push([wx * u[0] + wy * u[1] + wz * u[2], wx * v[0] + wy * v[1] + wz * v[2]]);
  }
  if (pts2.length < 6) return null;
  // Voller Querschnitt → freier Radius (liefert r), Teil-Querschnitt (schräge Mündung) → fester r
  let fit = fitCircleFixedR(pts2, r, [0, 0]);
  if (!fit) return null;
  // Ausreißer (Schnitt mit einem ANDEREN Kanalabschnitt, z.B. in engen Bögen) verwerfen, neu fitten
  for (let pass = 0; pass < 2; pass++) {
    const keep = pts2.filter((q) => Math.abs(Math.hypot(q[0] - fit.c[0], q[1] - fit.c[1]) - r) < Math.max(0.25, 0.12 * r));
    if (keep.length === pts2.length || keep.length < 6) break;
    pts2.length = 0; pts2.push(...keep);
    fit = fitCircleFixedR(pts2, r, fit.c);
    if (!fit) return null;
  }
  let cov = angularCoverage(pts2, fit.c), rFree = NaN;
  if (cov >= 300) {
    const ff = fitCircleFree(pts2, fit.c, r);
    if (ff && Math.abs(ff.r - r) < 0.3 * r) { fit = ff; rFree = ff.r; cov = angularCoverage(pts2, fit.c); }
  }
  return { c: addv(p, addv(mul(u, fit.c[0]), mul(v, fit.c[1]))), rms: fit.rms, max: fit.max, cov, n: pts2.length, rFree };
}

// ════════════════════════════════════════════════════════════════════════════
// 4. Mittellinie: Querschnitts-Marsch (Normalschnitte) + Profil-Neigung
// ════════════════════════════════════════════════════════════════════════════
function makeSectioner(T, tris, keyOf, rRef) {
  const idx = buildEdgeIndex(T, tris, keyOf, Math.max(0.5, 0.8 * rRef));
  const section = (p, n, r) => crossSection(idx, p, n, r);
  section.totalEdgeLen = idx.total;
  return section;
}

// Tangenten aus Nachbar-Mittelpunkten (Zentraldifferenz; an den Enden linear extrapoliert)
function centralTangents(cs) {
  const n = cs.length;
  return cs.map((c, i) => {
    if (n < 3) return norm(sub(cs[n - 1], cs[0]));
    if (i === 0) return norm(addv(mul(norm(sub(cs[1], cs[0])), 1.5), mul(norm(sub(cs[2], cs[1])), -0.5)));
    if (i === n - 1) return norm(addv(mul(norm(sub(cs[i], cs[i - 1])), 1.5), mul(norm(sub(cs[i - 1], cs[i - 2])), -0.5)));
    return norm(sub(cs[i + 1], cs[i - 1]));
  });
}

// Stationen mit Tangente aus den Nachbarn neu schneiden; Schnittnormale = nOf(Tangente).
function resect(section, st, r, nOf, passes) {
  let cur = st;
  for (let pass = 0; pass < passes && cur.length >= 3; pass++) {
    const tan = centralTangents(cur.map((s) => s.c));
    cur = cur.map((s, i) => {
      const cs = section(s.c, nOf(tan[i]), r);
      if (!cs || cs.cov < 150) return { ...s, T: tan[i] };
      return { ...cs, T: tan[i] };
    });
  }
  return cur;
}

// Marsch mit NORMAL-Schnitten (stabil: der Mittelpunkt eines Schnitts ist unempfindlich gegen
// eine leichte Fehlneigung der Ebene). Tangente am neuen Punkt extrapoliert (Sehnenrichtungen
// hinken in Bögen um κ·h nach), danach Zentraldifferenz-Verfeinerung.
function marchNormal(section, start, T0, plEnd, inEnd, r, h) {
  const st = [];
  let Tdir = T0, p = addv(start, mul(T0, h));
  const maxSteps = Math.ceil(section.totalEdgeLen / h) + 10;
  for (let i = 0; i < maxSteps; i++) {
    let cs = section(p, Tdir, r);
    if (!cs || cs.cov < 150) break;
    for (let it = 0; it < 2 && st.length >= 2; it++) {
      const d1 = norm(sub(st[st.length - 1].c, st[st.length - 2].c)), d2 = norm(sub(cs.c, st[st.length - 1].c));
      const tNew = norm(addv(mul(d2, 1.5), mul(d1, -0.5)));
      if (dot(tNew, Tdir) < 0.9) break;
      Tdir = tNew;
      const cs2 = section(cs.c, Tdir, r);
      if (!cs2 || cs2.cov < 150) break;
      cs = cs2;
    }
    if (dot(sub(cs.c, plEnd.c), inEnd) < 0) break; // jenseits der End-Mündung
    st.push({ ...cs, T: Tdir });
    p = addv(cs.c, mul(Tdir, h));
  }
  return resect(section, st, r, (t) => t, 2);
}

// Kreis-Fit eines Mündungs-Loops in seiner eigenen Ebene → { center, r, max } | null
function circleOfLoop(loop, pl) {
  const u = pl.u, v = cross(pl.n, u);
  const p2 = loop.map((p) => { const w = sub(p, pl.c); return [dot(w, u), dot(w, v)]; });
  let mr = 0; for (const q of p2) mr += Math.hypot(q[0], q[1]); mr /= p2.length;
  const f = fitCircleFree(p2, [0, 0], mr);
  if (!f) return null;
  return { center: addv(pl.c, addv(mul(u, f.c[0]), mul(v, f.c[1]))), r: f.r, max: f.max };
}

const median = (a) => { if (!a.length) return NaN; const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; };

// 3D-Ausgleichsgerade (PCA) → { c, d, maxDev }
function fitLine3(pts) {
  let c = [0, 0, 0]; for (const p of pts) c = addv(c, p); c = mul(c, 1 / pts.length);
  const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const p of pts) { const d = sub(p, c); for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) M[i][j] += d[i] * d[j]; }
  const d = norm(eigenSym3(M).vectors[2]);
  let maxDev = 0; for (const p of pts) { const w = sub(p, c); maxDev = Math.max(maxDev, len(sub(w, mul(d, dot(w, d))))); }
  return { c, d, maxDev };
}

// ════════════════════════════════════════════════════════════════════════════
// 5. Biarc-Näherung (2D, in der Bahn-Ebene)
// ════════════════════════════════════════════════════════════════════════════
const sub2 = (a, b) => [a[0] - b[0], a[1] - b[1]];
const add2 = (a, b) => [a[0] + b[0], a[1] + b[1]];
const mul2 = (a, s) => [a[0] * s, a[1] * s];
const dot2 = (a, b) => a[0] * b[0] + a[1] * b[1];
const cr2 = (a, b) => a[0] * b[1] - a[1] * b[0];
const len2 = (a) => Math.hypot(a[0], a[1]);
const norm2 = (a) => { const l = len2(a) || 1; return [a[0] / l, a[1] / l]; };
const rot2 = (a, th) => [a[0] * Math.cos(th) - a[1] * Math.sin(th), a[0] * Math.sin(th) + a[1] * Math.cos(th)];

// Kreisbogen von A (Tangente ta) nach B; nahezu gerade → Gerade.
function arcFrom(A, ta, B) {
  const c = sub2(B, A), cc = dot2(c, c);
  if (cc < 1e-14) return null;
  const k = 2 * cr2(ta, c) / cc;
  if (Math.abs(k) * Math.sqrt(cc) < 1e-7) { const d = norm2(c); return { kind: 'line', A, B, ta: d, tb: d }; }
  const th = 2 * Math.atan2(cr2(ta, c), dot2(ta, c));
  const C = add2(A, mul2([-ta[1], ta[0]], 1 / k));
  return { kind: 'arc', A, B, C, R: 1 / Math.abs(k), th, ta, tb: rot2(ta, th) };
}

// Biarc (gleiche Tangentenlängen d) zwischen (P0,t0) und (P1,t1) → [Stück, Stück] | null
function biarc(P0, t0, P1, t1) {
  const v = sub2(P1, P0), vt = dot2(v, add2(t0, t1)), vv = dot2(v, v);
  const tt = 1 - dot2(t0, t1);
  let d;
  if (tt < 1e-12) { if (!(vt > 1e-12)) return null; d = vv / (2 * vt); }
  else { const a = -2 * tt, b = -2 * vt; d = (-b - Math.sqrt(b * b - 4 * a * vv)) / (2 * a); }
  if (!(d > 1e-9) || !Number.isFinite(d)) return null;
  const Q0 = add2(P0, mul2(t0, d)), Q1 = sub2(P1, mul2(t1, d));
  const J = mul2(add2(Q0, Q1), 0.5);
  const tj = norm2(sub2(Q1, Q0));
  const out = [];
  const a1 = arcFrom(P0, t0, J), a2 = arcFrom(J, tj, P1);
  if (a1) out.push(a1);
  if (a2) out.push(a2);
  return out.length ? out : null;
}

function distToPiece2(q, pc) {
  if (pc.kind === 'line') {
    const d = sub2(pc.B, pc.A), L2 = dot2(d, d);
    const s = Math.max(0, Math.min(1, dot2(sub2(q, pc.A), d) / (L2 || 1)));
    return len2(sub2(q, add2(pc.A, mul2(d, s))));
  }
  const w = sub2(q, pc.C), a0 = sub2(pc.A, pc.C);
  let rel = Math.atan2(cr2(a0, w), dot2(a0, w)) * Math.sign(pc.th);
  if (rel < 0) rel += 2 * Math.PI;
  if (rel <= Math.abs(pc.th)) return Math.abs(len2(w) - pc.R);
  return Math.min(len2(sub2(q, pc.A)), len2(sub2(q, pc.B)));
}
const distToChain2 = (q, chain) => { let m = Infinity; for (const pc of chain) m = Math.min(m, distToPiece2(q, pc)); return m; };

// Kleines lineares Gleichungssystem (Gauß mit Pivot)
function solveSmall(M, b) {
  const n = b.length, A = M.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    if (Math.abs(A[p][c]) < 1e-14) return null;
    [A[c], A[p]] = [A[p], A[c]];
    for (let r = 0; r < n; r++) { if (r === c) continue; const f = A[r][c] / A[c][c]; for (let k = c; k <= n; k++) A[r][k] -= f * A[c][k]; }
  }
  return A.map((row, i) => row[n] / row[i]);
}

// Geglättete Position + Tangente je Station (lokale Parabel über Bogenlänge ±W)
function smoothNodes(Q, W) {
  const s = [0];
  for (let i = 1; i < Q.length; i++) s.push(s[i - 1] + len2(sub2(Q[i], Q[i - 1])));
  return Q.map((q, i) => {
    const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], bx = [0, 0, 0], by = [0, 0, 0];
    let cnt = 0;
    for (let j = 0; j < Q.length; j++) {
      const tau = s[j] - s[i]; if (Math.abs(tau) > W) continue;
      const row = [1, tau, tau * tau]; cnt++;
      for (let a = 0; a < 3; a++) { bx[a] += row[a] * Q[j][0]; by[a] += row[a] * Q[j][1]; for (let b = 0; b < 3; b++) M[a][b] += row[a] * row[b]; }
    }
    const cx = cnt >= 5 ? solveSmall(M, bx) : null, cy = cnt >= 5 ? solveSmall(M, by) : null;
    if (!cx || !cy) {
      const a = Q[Math.max(0, i - 1)], b = Q[Math.min(Q.length - 1, i + 1)];
      return { p: q, t: norm2(sub2(b, a)), s: s[i] };
    }
    return { p: [cx[0], cy[0]], t: norm2([cx[1], cy[1]]), s: s[i] };
  });
}

// Rekursive Biarc-Kette zwischen den Knoten (Abweichung der Roh-Stationen ≤ tol)
function fitBiarcChain(nodes, samplesBetween, tol) {
  const out = [];
  let ok = true;
  const rec = (a, b, depth) => {
    if (!ok) return;
    const ba = biarc(nodes[a].p, nodes[a].t, nodes[b].p, nodes[b].t);
    let dev = Infinity;
    if (ba) { dev = 0; for (const q of samplesBetween(a, b)) dev = Math.max(dev, distToChain2(q, ba)); }
    if (dev <= tol || b - a <= 1 || depth > 30) {
      if (!ba) { ok = false; return; }
      out.push(...ba); return;
    }
    const m = (a + b) >> 1;
    rec(a, m, depth + 1); rec(m, b, depth + 1);
  };
  rec(0, nodes.length - 1, 0);
  return ok ? out : null;
}

// Benachbarte Bögen mit gleichem Mittelpunkt/Radius bzw. kollineare Geraden verschmelzen
function mergePieces(pcs) {
  const out = [];
  for (const pc of pcs) {
    const last = out[out.length - 1];
    if (last && last.kind === 'arc' && pc.kind === 'arc' && Math.sign(last.th) === Math.sign(pc.th) &&
        len2(sub2(last.C, pc.C)) < 2e-3 && Math.abs(last.R - pc.R) < 2e-3) {
      out[out.length - 1] = { ...last, B: pc.B, th: last.th + pc.th, tb: pc.tb };
      continue;
    }
    if (last && last.kind === 'line' && pc.kind === 'line' && Math.abs(cr2(last.ta, pc.ta)) < 1e-6 && dot2(last.ta, pc.ta) > 0) {
      out[out.length - 1] = { ...last, B: pc.B };
      continue;
    }
    out.push(pc);
  }
  return out;
}

// ════════════════════════════════════════════════════════════════════════════
// 6. Modell-Prüfung: jeder Netz-Vertex muss auf dem gezogenen Profil liegen
// ════════════════════════════════════════════════════════════════════════════
// Profil-Lage entlang der Kette: Profilkreis (Mittelpunkt c, Normale m) starr mitbewegt.
// Für einen Vertex v die Profil-Ebene suchen, in der er liegt ((v − P(s))·m(s) = 0), dann
// Abstand |v − P(s)| − r. Geradenstück: Ebenen parallel → linear lösbar; Bogen: Bisektion.
function vertexResidual(v, pieces3, mOf, r) {
  let best = Infinity;
  for (const pc of pieces3) {
    if (pc.kind === 'line') {
      const m = mOf(pc.dir), tm = dot(pc.dir, m);
      const s = dot(sub(v, pc.p0), m) / tm;
      if (s < -0.02 || s > pc.len + 0.02) continue; // Rand-Toleranz 0.02 mm Weglänge
      const res = len(sub(v, addv(pc.p0, mul(pc.dir, s)))) - r;
      if (Math.abs(res) < 0.5 * r && Math.abs(res) < Math.abs(best)) best = res; // nur plausible Wurzel (nahe am Profil)
      continue;
    }
    // Schnelltest: grober Abstand zum Bogen
    const w = sub(v, pc.O), wa = dot(w, pc.axis);
    const rho = len(sub(w, mul(pc.axis, wa)));
    if (Math.abs(rho - pc.R) > 1.6 * r || Math.abs(wa) > 1.6 * r) continue;
    const ea = pc.ea, eb = pc.eb;
    const P = (th) => addv(pc.O, mul(addv(mul(ea, Math.cos(th)), mul(eb, Math.sin(th))), pc.R));
    const Tt = (th) => addv(mul(ea, -Math.sin(th)), mul(eb, Math.cos(th)));
    const f = (th) => dot(sub(v, P(th)), mOf(Tt(th)));
    const N = Math.max(4, Math.ceil(pc.sweep / (10 * DEG)));
    const eps = 0.02 / pc.R; // Rand-Toleranz 0.02 mm Weglänge
    let th0 = -eps, f0 = f(th0);
    for (let k = 1; k <= N; k++) {
      const th1 = k === N ? pc.sweep + eps : (pc.sweep * k) / N, f1 = f(th1);
      if (f0 === 0 || f0 * f1 < 0) {
        let a = th0, b = th1, fa = f0;
        for (let it = 0; it < 50; it++) { const m = 0.5 * (a + b), fm = f(m); if (fa * fm <= 0) b = m; else { a = m; fa = fm; } }
        const res = len(sub(v, P(0.5 * (a + b)))) - r;
        if (Math.abs(res) < 0.5 * r && Math.abs(res) < Math.abs(best)) best = res; // nur plausible Wurzel
      }
      th0 = th1; f0 = f1;
    }
  }
  return best;
}

// Kreis (c, Normale m, r) entlang t auf Ebene (pc, pn) projizieren → Ellipse
function projectCircle(c, m, r, a1, t, pc, pn) {
  const tn = dot(t, pn);
  if (Math.abs(tn) < 0.2) return null;
  const a2 = cross(m, a1);
  const proj = (x) => sub(x, mul(t, dot(sub(x, pc), pn) / tn));
  const C = proj(c);
  const f1 = sub(proj(addv(c, mul(a1, r))), C), f2 = sub(proj(addv(c, mul(a2, r))), C);
  const ph = 0.5 * Math.atan2(2 * dot(f1, f2), dot(f1, f1) - dot(f2, f2));
  const M1 = addv(mul(f1, Math.cos(ph)), mul(f2, Math.sin(ph))), M2 = addv(mul(f1, -Math.sin(ph)), mul(f2, Math.cos(ph)));
  let s1 = len(M1), s2 = len(M2), ref = norm(M1);
  if (s2 > s1) { const tmp = s1; s1 = s2; s2 = tmp; ref = norm(M2); }
  return { center: C, refDir: ref, semi1: s1, semi2: s2 };
}

// Abstand eines Punktes zu einer Mündungskurve (Kreis/Ellipse): in der Ebene radial + senkrecht
function curveDist(cv, p) {
  if (cv.kind === 'bspline') {
    const off = Math.abs(dot(sub(p, cv.center), cv.axis));
    let best = Infinity;
    const S = cv.samples, n = S.length;
    for (let i = 0; i < n; i++) {
      const a = S[i], b = S[(i + 1) % n], d = sub(b, a), L2 = dot(d, d) || 1e-30;
      const t = Math.max(0, Math.min(1, dot(sub(p, a), d) / L2));
      best = Math.min(best, len(sub(p, addv(a, mul(d, t)))));
    }
    return Math.max(best, off);
  }
  const w = sub(p, cv.center);
  const off = Math.abs(dot(w, cv.axis));
  const yDir = cross(cv.axis, cv.refDir);
  const x = dot(w, cv.refDir), y = dot(w, yDir);
  const s1 = cv.radius, s2 = cv.semi2 ?? cv.radius;
  const rho = Math.hypot(x, y), q = Math.hypot(x / s1, y / s2);
  const radial = q > 1e-12 ? Math.abs(rho - rho / q) : s2;
  return Math.hypot(radial, off);
}

// Geschlossener, periodischer kubischer C2-Spline durch pts (Sehnenlängen-Parametrisierung),
// dargestellt als B-Spline aus Bézier-Segmenten: Grad 3, Kontrollpunkte P0,B1,B2,P1,…,Pn=P0,
// Knoten 0..n mit Vielfachheiten 4,3,…,3,4. Alle Kontrollpunkte sind Linearkombinationen der
// Stützpunkte → liegt der Loop in einer Ebene, liegt die Kurve exakt in dieser Ebene.
function closedCubicSpline(pts) {
  const n = pts.length;
  if (n < 4) return null;
  const h = pts.map((p, i) => len(sub(pts[(i + 1) % n], p)));
  if (h.some((x) => !(x > 1e-9))) return null;
  // Tangenten D_i (je Parametereinheit): h_i·D_{i−1} + 2(h_{i−1}+h_i)·D_i + h_{i−1}·D_{i+1}
  //   = 3·[h_i·(P_i − P_{i−1})/h_{i−1} + h_{i−1}·(P_{i+1} − P_i)/h_i]   (zyklisch)
  const M = Array.from({ length: n }, () => new Float64Array(n));
  const rhs = [[], [], []];
  for (let i = 0; i < n; i++) {
    const im = (i - 1 + n) % n, ip = (i + 1) % n;
    const hm = h[im], hi = h[i];
    M[i][im] += hi; M[i][i] += 2 * (hm + hi); M[i][ip] += hm;
    for (let k = 0; k < 3; k++) rhs[k].push(3 * (hi * (pts[i][k] - pts[im][k]) / hm + hm * (pts[ip][k] - pts[i][k]) / hi));
  }
  const D = [0, 1, 2].map((k) => solveSmall(M.map((r) => Array.from(r)), rhs[k]));
  if (D.some((x) => !x)) return null;
  const Di = (i) => [D[0][i], D[1][i], D[2][i]];
  const ctrl = [], samples = [];
  for (let i = 0; i < n; i++) {
    const ip = (i + 1) % n;
    const b0 = pts[i], b1 = addv(pts[i], mul(Di(i), h[i] / 3)), b2 = sub(pts[ip], mul(Di(ip), h[i] / 3)), b3 = pts[ip];
    ctrl.push(b0, b1, b2);
    for (let j = 0; j < 6; j++) {
      const t = j / 6, u = 1 - t;
      samples.push(addv(addv(mul(b0, u * u * u), mul(b1, 3 * u * u * t)), addv(mul(b2, 3 * u * t * t), mul(b3, t * t * t))));
    }
  }
  ctrl.push(pts[0]);
  const mults = [4]; const knots = [0];
  for (let i = 1; i < n; i++) { mults.push(3); knots.push(i); }
  mults.push(4); knots.push(n);
  return { ctrl, mults, knots, samples };
}

// ════════════════════════════════════════════════════════════════════════════
// 7. Rohr-Fit je Kandidat → Spezifikation für den Exporter
// ════════════════════════════════════════════════════════════════════════════
const PLANE_TOL = 0.01;       // Mündung muss eben sein (mm)
const CIRC_TOL = 0.01;        // Mündung = Kreis (Profil), max. Abweichung (mm)
const PATH_PLANAR_TOL = 0.05; // Bahn muss eben sein (mm)
const FIT_TOL = 0.01;         // Biarc ↔ Stations-Mittelpunkte (mm); Vorgabe ≤ 0.02
const LINE_TOL = 0.012;       // ganze Bahn innerhalb dieser Toleranz gerade → Bohrung (mm)
const VERT_TOL = 0.04;        // Netz-Vertex ↔ Modell-Fläche (mm)
const MOUTH_TOL = 0.03;       // Mündungs-Loop ↔ Mündungskurve (mm)

const rotAbout = (x, axis, th) => addv(addv(mul(x, Math.cos(th)), mul(cross(axis, x), Math.sin(th))), mul(axis, dot(axis, x) * (1 - Math.cos(th))));

function fitTube(T, cand, keyOf, loops) {
  const fail = (why, extra = {}) => ({ fail: why, ...extra });
  let plA = fitPlane(loops[0]), plB = fitPlane(loops[1]);
  if (plA.maxDev > PLANE_TOL || plB.maxDev > PLANE_TOL) return fail('Mündung nicht eben');
  const section = makeSectioner(T, cand.tris, keyOf, cand.r0);
  let cc = [0, 0, 0];
  for (const t of cand.tris) cc = addv(cc, [T.C[3 * t], T.C[3 * t + 1], T.C[3 * t + 2]]);
  cc = mul(cc, 1 / cand.tris.length);
  const inward = (pl) => (dot(sub(cc, pl.c), pl.n) >= 0 ? pl.n : mul(pl.n, -1));
  let inA = inward(plA), inB = inward(plB);
  const h = Math.min(0.3, cand.r0 / 6);
  // (1) Marsch mit Normalschnitten, Radius aus vollen Querschnitten nachschärfen
  let st = marchNormal(section, plA.c, inA, plB, inB, cand.r0, h);
  const rFree = median(st.filter((s) => s.cov >= 300 && Number.isFinite(s.rFree)).map((s) => s.rFree));
  if (!Number.isFinite(rFree)) return fail('keine vollen Querschnitte');
  st = marchNormal(section, plA.c, inA, plB, inB, rFree, h);
  if (st.length < 8) return fail('Marsch zu kurz', { stations: st.length });
  if (dot(sub(st[st.length - 1].c, plB.c), inB) > 3 * h + rFree) return fail('Marsch erreicht Mündung B nicht');
  // Gerade Kanäle (= Bohrungen) bleiben beim bestehenden Bohrungs-Pfad
  if (fitLine3(st.map((s) => s.c)).maxDev <= LINE_TOL) return fail('gerade (Bohrungs-Pfad)');
  // (2) Bahn-Ebene
  const pp = fitPlane(st.map((s) => s.c));
  if (pp.maxDev > PATH_PLANAR_TOL) return fail('Bahn nicht eben', { dev: pp.maxDev });
  let Bn = pp.n;
  // (3) Profil: eine Mündung, die ein exakter Kreis ist (Profil auf der Fläche skizziert).
  //     Neigung γ = Drehung der Profilnormale gegen die Bahntangente um Bn.
  const gammaOf = (t, m) => Math.atan2(dot(cross(t, m), Bn), dot(t, m));
  const mkEnd = (loop, pl, inn, Tm) => {
    const circ = circleOfLoop(loop, pl);
    const m = dot(inn, Tm) >= 0 ? inn : mul(inn, -1); // Profilnormale in Marschrichtung
    const isCircle = !!circ && circ.max <= CIRC_TOL && Math.abs(circ.r - rFree) <= 0.2 * rFree && Math.abs(dot(m, Bn)) <= 0.03;
    return { loop, pl, circ, m, isCircle, gamma: isCircle ? gammaOf(Tm, m) : NaN };
  };
  let endA = mkEnd(loops[0], plA, inA, st[0].T);
  let endB = mkEnd(loops[1], plB, inB, st[st.length - 1].T);
  // Profil-Ende immer an den Anfang (Marschrichtung umdrehen)
  if (!endA.isCircle && endB.isCircle) {
    st = st.slice().reverse().map((s) => ({ ...s, T: mul(s.T, -1) }));
    [plA, plB] = [plB, plA]; [inA, inB] = [inB, inA];
    endA = mkEnd(loops[1], plA, inA, st[0].T);
    endB = mkEnd(loops[0], plB, inB, st[st.length - 1].T);
  }
  // Bahn-Ebenen-Normale exakt senkrecht zur gemessenen Profil-Normale machen: dann ist das
  // gedrehte Profil am Kreis-Ende EXAKT die Mündungsebene (sonst kippt es um ~1e-4 rad weg und
  // die Mündungs-Vertices liegen knapp vor dem ersten Stück).
  if (endA.isCircle) {
    const b2 = sub(Bn, mul(endA.m, dot(Bn, endA.m)));
    if (len(b2) > 0.99) Bn = norm(b2);
    endA.gamma = gammaOf(st[0].T, endA.m);
    if (endB.isCircle) endB.gamma = gammaOf(st[st.length - 1].T, endB.m);
  }
  const normalCs = st.map((s) => s.c);
  const tanN = centralTangents(normalCs);
  const rotG = (g) => (t) => norm(addv(mul(t, Math.cos(g)), mul(cross(Bn, t), Math.sin(g))));
  let gamma = 0, rProf = rFree;
  if (endA.isCircle) {
    rProf = endA.circ.r;
    // Neigung nachschärfen: Median-Abweichung der geneigten Schnitte vom Profilkreis minimieren
    const score = (g, every = 2) => {
      const nOf = rotG(g), rr = [];
      for (let i = 0; i < st.length; i += every) {
        const cs = section(normalCs[i], nOf(tanN[i]), rProf);
        if (cs && cs.cov >= 300) rr.push(cs.rms);
      }
      return rr.length >= 4 ? median(rr) : Infinity;
    };
    // Grob-Raster ±12° (2°-Schritte) um die Mündungs-Schätzung (die Tangente an der Mündung ist extrapoliert und
    // kann einige Grad daneben liegen), dann Goldener Schnitt ±2° um das beste Raster-Element.
    let gBest = endA.gamma, fBest = Infinity;
    for (let dg = -12; dg <= 12; dg += 2) {
      const g = endA.gamma + dg * DEG, f = score(g, 3);
      if (f < fBest) { fBest = f; gBest = g; }
    }
    let a = gBest - 2 * DEG, b = gBest + 2 * DEG;
    const gr = (Math.sqrt(5) - 1) / 2;
    let x1 = b - gr * (b - a), x2 = a + gr * (b - a), f1 = score(x1), f2 = score(x2);
    for (let it = 0; it < 14; it++) {
      if (f1 < f2) { b = x2; x2 = x1; f2 = f1; x1 = b - gr * (b - a); f1 = score(x1); }
      else { a = x1; x1 = x2; f1 = f2; x2 = a + gr * (b - a); f2 = score(x2); }
    }
    gamma = 0.5 * (a + b);
    if (Math.abs(gamma) < 0.2 * DEG) gamma = 0;
  }
  const mOf = rotG(gamma);
  // (4) Stationen in den Profil-Ebenen neu schneiden → Bahnpunkte
  // Nur VOLLE Querschnitte (≥ 300° Umfang) als Bahnpunkte: Teil-Schnitte an schrägen Mündungen
  // liefern mit festem Radius unzuverlässige Mittelpunkte (gemessen: Sprünge bis 0.8 mm).
  let P = resect(section, st.map((s, i) => ({ ...s, T: tanN[i] })), rProf, mOf, 2).filter((s) => s.cov >= 300);
  if (P.length < 8) return fail('zu wenige volle Profil-Schnitte');
  // Bahn-Knoten nur dort, wo der (geneigte) Profilkreis komplett im Material liegt — sonst kann
  // der Übergangskreis die Mündungsebene schneiden (Topologie) bzw. ein Teil-Schnitt verfälscht ihn.
  {
    const insideAll = (s0) => {
      const m = mOf(s0.T), a1 = perpOf(m), a2 = cross(m, a1);
      for (const [pl, inn] of [[plA, inA], [plB, inB]]) for (let j = 0; j < 24; j++) {
        const ph = (j / 24) * 2 * Math.PI;
        const q = addv(s0.c, addv(mul(a1, rProf * Math.cos(ph)), mul(a2, rProf * Math.sin(ph))));
        if (dot(sub(q, pl.c), inn) < 0.05) return false;
      }
      return true;
    };
    let i0 = 0, i1 = P.length - 1;
    while (i0 <= i1 && !insideAll(P[i0])) i0++;
    while (i1 >= i0 && !insideAll(P[i1])) i1--;
    P.splice(i1 + 1); P.splice(0, i0);
    if (P.length < 8) return fail('zu wenige innere Profil-Schnitte');
  }
  const secRms = median(P.filter((s) => s.cov >= 300).map((s) => s.rms));
  if (!(secRms <= 0.02)) return fail('Querschnitt passt nicht zum Profilkreis', { secRms, gammaDeg: gamma / DEG });
  // (5) 2D-Bahn in der Bahn-Ebene
  const o = pp.c, e1 = pp.u, e2 = cross(Bn, e1);
  const to2 = (p) => [dot(sub(p, o), e1), dot(sub(p, o), e2)];
  const to3 = (q) => addv(o, addv(mul(e1, q[0]), mul(e2, q[1])));
  const d2of = (t) => norm2([dot(t, e1), dot(t, e2)]);
  const d3of = (d) => norm(addv(mul(e1, d[0]), mul(e2, d[1])));
  const Q = P.map((s) => to2(s.c));
  const sm = smoothNodes(Q, 1.0);
  const unrot = (m) => norm(addv(mul(m, Math.cos(-gamma)), mul(cross(Bn, m), Math.sin(-gamma))));
  // Enden: Kreis-Ende = (Kreismittelpunkt, Tangente aus der Profilnormale). Sonst „offenes“ Ende:
  // Knoten = äußerste volle Station; das End-Stück wird danach durch die Mündungsebene verlängert,
  // die Mündungskurve ist der exakte Schnitt dieses Stücks mit der Ebene.
  const circB = endB.isCircle && Math.abs(endB.gamma - gamma) <= 3 * DEG;
  if (endA.isCircle && Math.abs(dot(sub(endA.circ.center, o), Bn)) > 0.05) return fail('Profilkreis nicht in Bahn-Ebene');
  if (circB && Math.abs(dot(sub(endB.circ.center, o), Bn)) > 0.05) return fail('Endkreis nicht in Bahn-Ebene');
  const nodes = [];
  if (endA.isCircle) nodes.push({ p: to2(endA.circ.center), t: d2of(unrot(endA.m)), i: -1 });
  for (let i = 0; i < Q.length; i++) nodes.push({ p: sm[i].p, t: sm[i].t, i });
  if (circB) nodes.push({ p: to2(endB.circ.center), t: d2of(unrot(endB.m)), i: Q.length });
  const samplesBetween = (a, b) => { const out = []; for (let i = nodes[a].i + 1; i < nodes[b].i; i++) if (i >= 0 && i < Q.length) out.push(Q[i]); return out; };
  let chain = fitBiarcChain(nodes, samplesBetween, FIT_TOL);
  if (!chain) return fail('Biarc-Fit gescheitert');
  chain = mergePieces(chain);
  if (!chain.some((pc) => pc.kind === 'arc')) return fail('gerade (Bohrungs-Pfad)');
  for (const pc of chain) if (pc.kind === 'arc' && pc.R < 1.25 * rProf) return fail('Bogen zu eng', { R: pc.R });
  // Abweichung Biarc-Mittellinie ↔ Stations-Mittelpunkte
  const sd = Q.map((q) => distToChain2(q, chain));
  const stationDev = { max: Math.max(...sd), mean: sd.reduce((x, y) => x + y, 0) / sd.length };
  if (stationDev.max > 2 * FIT_TOL + 0.005) return fail('Bahn-Abweichung zu groß', { stationDev });
  // (6) 3D-Stücke
  const mkArc3 = (p0, T3, kappa) => {
    if (Math.abs(kappa) < 1e-6) return { kind: 'line', p0, dir: T3, len: 0 };
    const O = addv(p0, mul(cross(Bn, T3), 1 / kappa)), axis = mul(Bn, Math.sign(kappa));
    const ea = norm(sub(p0, O));
    return { kind: 'arc', p0, O, axis, R: 1 / Math.abs(kappa), sweep: 0, ea, eb: cross(axis, ea) };
  };
  const pieces = chain.map((pc) => {
    if (pc.kind === 'line') return { kind: 'line', p0: to3(pc.A), dir: d3of(pc.ta), len: len2(sub2(pc.B, pc.A)) };
    const axis = mul(Bn, Math.sign(pc.th));
    const O = to3(pc.C), p0 = to3(pc.A), ea = norm(sub(p0, O));
    return { kind: 'arc', p0, O, axis, R: pc.R, sweep: Math.abs(pc.th), ea, eb: cross(axis, ea) };
  });
  const allV = [];
  { const seen = new Set(); for (const t of cand.tris) for (let k = 0; k < 3; k++) if (!seen.has(keyOf[t][k])) { seen.add(keyOf[t][k]); allV.push(T.V[t][k]); } }
  const refOf = (m) => norm(sub(Bn, mul(m, dot(Bn, m))));
  const profPoint = (pf, phi) => { const a1 = refOf(pf.m), a2 = cross(pf.m, a1); return addv(pf.c, addv(mul(a1, rProf * Math.cos(phi)), mul(a2, rProf * Math.sin(phi)))); };
  const moveProf = (pf, pc, frac = 1) => (pc.kind === 'line'
    ? { c: addv(pf.c, mul(pc.dir, pc.len * frac)), m: pf.m }
    : { c: addv(pc.O, rotAbout(sub(pf.c, pc.O), pc.axis, pc.sweep * frac)), m: rotAbout(pf.m, pc.axis, pc.sweep * frac) });
  // Stück verlängern (am Anfang rückwärts / am Ende vorwärts) um Weglänge step
  const growPiece = (pc, step, atStart) => {
    if (pc.kind === 'line') { pc.len += step; if (atStart) pc.p0 = sub(pc.p0, mul(pc.dir, step)); return; }
    const dth = step / pc.R;
    pc.sweep += dth;
    if (atStart) { pc.p0 = addv(pc.O, rotAbout(sub(pc.p0, pc.O), pc.axis, -dth)); pc.ea = norm(sub(pc.p0, pc.O)); pc.eb = cross(pc.axis, pc.ea); }
  };
  // Offenes Ende (schräge Mündung, keine Stationen mehr): End-Stück mit eigener Krümmung κ ab dem
  // äußersten Knoten (Tangente fest → G1). κ per Ausgleich der Netz-Vertices hinter dem Knoten
  // (die liegen exakt auf der Fläche) — reine Extrapolation des letzten Biarc-Bogens lag gemessen
  // 0.03–0.04 mm neben der Mündung.
  const fitEndPiece = (atStart) => {
    const node = atStart ? nodes[0] : nodes[nodes.length - 1];
    const p3 = to3(node.p), T3 = d3of(node.t);
    const m3 = mOf(T3);
    const zone = allV.filter((v) => (atStart ? -1 : 1) * dot(sub(v, p3), m3) > 0);
    const adj = atStart ? chain[0] : chain[chain.length - 1];
    const k0 = adj.kind === 'arc' ? Math.sign(adj.th) / adj.R : 0;
    const build = (kappa) => {
      // rückwärts am Anfang: gleicher Kreis, Laufrichtung −T → Krümmung −κ
      const pc = atStart ? mkArc3(p3, mul(T3, -1), -kappa) : mkArc3(p3, T3, kappa);
      growPiece(pc, 3 * rProf + 2, false);
      return pc;
    };
    const rmsOf = (kappa) => {
      if (zone.length < 6) return 0;
      const pc = build(kappa);
      let s = 0;
      for (const v of zone) { const e = vertexResidual(v, [pc], mOf, rProf); if (!Number.isFinite(e)) return Infinity; s += e * e; }
      return Math.sqrt(s / zone.length);
    };
    let a = k0 - 0.15, b = k0 + 0.15;
    const gr = (Math.sqrt(5) - 1) / 2;
    let x1 = b - gr * (b - a), x2 = a + gr * (b - a), f1 = rmsOf(x1), f2 = rmsOf(x2);
    for (let it = 0; it < 30; it++) {
      if (f1 < f2) { b = x2; x2 = x1; f2 = f1; x1 = b - gr * (b - a); f1 = rmsOf(x1); }
      else { a = x1; x1 = x2; f1 = f2; x2 = a + gr * (b - a); f2 = rmsOf(x2); }
    }
    const kappa = 0.5 * (a + b);
    // End-Stück in Kettenrichtung: am Anfang endet es im Knoten (Start wird rückwärts verlängert)
    const pc = mkArc3(p3, T3, kappa);
    return { pc, kappa, zone: zone.length, rms: rmsOf(kappa) };
  };
  const endFits = {};
  if (!endA.isCircle) { const f = fitEndPiece(true); endFits.A = { kappa: f.kappa, zone: f.zone, rms: f.rms }; pieces.unshift(f.pc); }
  if (!circB) { const f = fitEndPiece(false); endFits.B = { kappa: f.kappa, zone: f.zone, rms: f.rms }; pieces.push(f.pc); }
  const nP = pieces.length;
  // Profilkreis starr entlang der Kette mitführen (Übergangskreise liegen so EXAKT auf beiden
  // Nachbarflächen). profs[k] = Profil am Anfang von Stück k, profs[nP] = am Ende.
  const profs = new Array(nP + 1);
  const ka = endA.isCircle ? 0 : 1;
  profs[ka] = endA.isCircle ? { c: endA.circ.center, m: endA.m } : { c: to3(nodes[0].p), m: mOf(d3of(nodes[0].t)) };
  for (let k = ka; k < nP; k++) profs[k + 1] = moveProf(profs[k], pieces[k]);
  if (ka === 1) profs[0] = profs[1]; // Start-Stück hat noch Länge 0
  if (circB && (len(sub(profs[nP].c, endB.circ.center)) > 0.03 || dot(profs[nP].m, endB.m) < Math.cos(0.5 * DEG))) return fail('Profil trifft Endkreis nicht');
  // Offene Enden: End-Stück verlängern, bis sein End-Profil komplett jenseits der Mündungsebene liegt
  const extendEnd = (atStart, pl, inn) => {
    const pc = atStart ? pieces[0] : pieces[nP - 1];
    for (let it = 0; it < 200; it++) {
      const pf = atStart ? profs[0] : profs[nP];
      let minOut = Infinity;
      for (let j = 0; j < 24; j++) minOut = Math.min(minOut, -dot(sub(profPoint(pf, (j / 24) * 2 * Math.PI), pl.c), inn));
      if (minOut >= 0.05) return true;
      growPiece(pc, Math.max(0.05, 0.1 - minOut), atStart);
      if (atStart) profs[0] = moveProf(profs[1], pc, -1); else profs[nP] = moveProf(profs[nP - 1], pc, 1);
      if (pc.kind === 'arc' && pc.sweep > 1.5 * Math.PI) return false;
    }
    return false;
  };
  if (!endA.isCircle && !extendEnd(true, plA, inA)) return fail('Anfangs-Stück erreicht Mündung A nicht');
  if (!circB && !extendEnd(false, plB, inB)) return fail('End-Stück erreicht Mündung B nicht');
  for (let k = 0; k < nP; k++) { pieces[k].profC = profs[k].c; pieces[k].profM = profs[k].m; }
  // Kurven: 0 = Mündung A, 1..nP−1 = Übergänge, nP = Mündung B. sense +1 = Umlauf positiv um die
  // Bahnrichtung (Kurvenachse ≈ +T), −1 = negativ (Achse ≈ −T).
  const curves = profs.map((pf) => ({ kind: 'circle', center: pf.c, axis: pf.m, refDir: refOf(pf.m), radius: rProf, sense: 1 }));
  // Schnitt eines (offenen) End-Stücks mit der Mündungsebene: Gerade → exakte Ellipse,
  // Bogen → 72 exakte Schnittpunkte, periodischer kubischer Spline (Bézier-Segmente, liegt exakt
  // in der Ebene, trifft die Fläche in allen Stützpunkten exakt).
  const openMouth = (k, pl, isStart) => {
    const pc = pieces[k], pf = profs[k];
    const tDir = pc.kind === 'line' ? pc.dir : norm(cross(pc.axis, sub(pf.c, pc.O)));
    let ax = dot(pl.n, tDir) >= 0 ? pl.n : mul(pl.n, -1);
    if (!isStart) ax = mul(ax, -1);
    if (pc.kind === 'line') {
      const el = projectCircle(pf.c, pf.m, rProf, refOf(pf.m), pc.dir, pl.c, pl.n);
      if (!el) return null;
      const isCirc = Math.abs(el.semi1 - el.semi2) < 1e-6;
      return { kind: isCirc ? 'circle' : 'ellipse', center: el.center, axis: ax, refDir: norm(sub(el.refDir, mul(ax, dot(el.refDir, ax)))), radius: el.semi1, semi2: isCirc ? undefined : el.semi2, sense: isStart ? 1 : -1 };
    }
    const N = 72, pts = [];
    for (let j = 0; j < N; j++) {
      const X0 = profPoint(pf, (j / N) * 2 * Math.PI);
      const X = (th) => addv(pc.O, rotAbout(sub(X0, pc.O), pc.axis, th));
      const f = (th) => dot(sub(X(th), pl.c), pl.n);
      let a = 0, b = pc.sweep, fa = f(a), fb = f(b);
      if (fa * fb > 0) return null;
      for (let it = 0; it < 60; it++) { const m = 0.5 * (a + b), fm = f(m); if (fa * fm <= 0) { b = m; fb = fm; } else { a = m; fa = fm; } }
      // exakt in die Ebene legen (Rest-Fehler der Bisektion < 1e-12)
      const p = X(0.5 * (a + b));
      pts.push(sub(p, mul(pl.n, dot(sub(p, pl.c), pl.n))));
    }
    if (!isStart) pts.reverse();
    let c = [0, 0, 0]; for (const p of pts) c = addv(c, p); c = mul(c, 1 / N);
    const sp = closedCubicSpline(pts);
    if (!sp) return null;
    return { kind: 'bspline', center: c, axis: ax, refDir: norm(sub(pts[0], c)), radius: len(sub(pts[0], c)), sense: isStart ? 1 : -1, vertex: pts[0], ctrl: sp.ctrl, mults: sp.mults, knots: sp.knots, samples: sp.samples };
  };
  if (endA.isCircle) curves[0] = { kind: 'circle', center: endA.circ.center, axis: endA.m, refDir: refOf(endA.m), radius: endA.circ.r, sense: 1 };
  else curves[0] = openMouth(0, plA, true);
  if (circB) { const ax = mul(endB.m, -1); curves[nP] = { kind: 'circle', center: endB.circ.center, axis: ax, refDir: refOf(ax), radius: endB.circ.r, sense: -1 }; }
  else curves[nP] = openMouth(nP - 1, plB, false);
  if (!curves[0] || !curves[nP]) return fail('Mündungskurve nicht bestimmbar');
  // Mündungs-Loops müssen auf den Mündungskurven liegen
  const mouthDev = [Math.max(...endA.loop.map((p) => curveDist(curves[0], p))), Math.max(...endB.loop.map((p) => curveDist(curves[nP], p)))];
  if (Math.max(...mouthDev) > MOUTH_TOL) return fail('Mündungs-Loop passt nicht', { mouthDev });
  // Übergangskreise müssen vollständig im Material liegen (nicht durch eine Mündungsebene)
  for (let k = 1; k < nP; k++) {
    const pf = profs[k];
    for (const [pl, inn] of [[plA, inA], [plB, inB]]) {
      let mn = Infinity;
      for (let j = 0; j < 24; j++) mn = Math.min(mn, dot(sub(profPoint(pf, (j / 24) * 2 * Math.PI), pl.c), inn));
      if (mn < 0.02) return fail('Übergangskreis schneidet Mündungsebene', { k, mn });
    }
  }
  // (7) Vertex-Prüfung gegen das Modell (Netz-Vertices liegen bei CAD-Tessellierung exakt auf der Fläche)
  const verts = new Map();
  for (const t of cand.tris) for (let k = 0; k < 3; k++) verts.set(keyOf[t][k], T.V[t][k]);
  const res = [];
  for (const v of verts.values()) res.push(vertexResidual(v, pieces, mOf, rProf));
  const absRes = res.map(Math.abs);
  const vertDev = { max: Math.max(...absRes), mean: absRes.reduce((x, y) => x + y, 0) / absRes.length, n: absRes.length, medianSigned: median(res) };
  if (!(vertDev.max <= VERT_TOL)) return fail('Netz weicht vom Modell ab', { vertDev, gammaDeg: gamma / DEG, pieces: nP, badVertices: absRes.filter((x) => !(x <= VERT_TOL)).length });
  return {
    radius: rProf, gamma, B: Bn, pieces, curves,
    mouths: [{ curve: 0, planeC: plA.c, planeN: plA.n, nPts: endA.loop.length }, { curve: nP, planeC: plB.c, planeN: plB.n, nPts: endB.loop.length }],
    stats: {
      gammaDeg: gamma / DEG, radius: rProf, stations: P.length, secRms, stationDev, vertDev, mouthDev, endFits,
      lines: pieces.filter((p) => p.kind === 'line').length, arcs: pieces.filter((p) => p.kind === 'arc').length,
      mouthKinds: [curves[0].kind, curves[nP].kind],
    },
  };
}

// ════════════════════════════════════════════════════════════════════════════
// Öffentliche API
// ════════════════════════════════════════════════════════════════════════════
/**
 * detectTubes(normalGroups) — erkennt gebogene Kanäle und taggt deren Gruppen mit
 * group.tube = spec (rein datenförmig). Rückgabe { tubes: spec[], stats }.
 * spec = { id, radius, gamma, B, pieces[], curves[], mouths[], stats }
 *   pieces: { kind:'line', p0, dir, len, openStart, openEnd } | { kind:'arc', p0, O, axis, R, sweep, ea, eb }
 *           Stück k läuft von Kurve k nach Kurve k+1 (Profil starr mitgeführt).
 *   curves: { kind:'circle'|'ellipse', center, axis, refDir, radius (= Halbachse 1), semi2?, sense }
 *           sense +1: Umlauf positiv um die Bahnrichtung, −1: negativ.
 */
export function detectTubes(normalGroups) {
  const stats = { candidates: 0, tubes: 0, rejected: [] };
  const tubes = [];
  if (!Array.isArray(normalGroups) || !normalGroups.length) return { tubes, stats };
  for (const g of normalGroups) if (g && g.tube) delete g.tube;
  const T = collectTriangles(normalGroups);
  if (!T.n) return { tubes, stats };
  const { candidates, keyOf } = findCandidates(T);
  stats.candidates = candidates.length;
  let nextId = 0;
  for (const cand of candidates) {
    const reject = (why, extra) => { stats.rejected.push({ tris: cand.tris.length, r0: +cand.r0.toFixed(3), why, ...(extra || {}) }); };
    // Gruppen müssen vollständig in der Komponente liegen
    const gCount = new Map();
    for (const t of cand.tris) gCount.set(T.G[t], (gCount.get(T.G[t]) || 0) + 1);
    let pure = true;
    for (const [gi, c] of gCount) if (Math.floor(normalGroups[gi].vertices.length / 3) !== c) { pure = false; break; }
    if (!pure) { reject('Gruppe nur teilweise im Kanal'); continue; }
    // Topologie: genau 2 Rand-Loops (Durchgangskanal)
    const ec = new Map();
    for (const t of cand.tris) for (let k = 0; k < 3; k++) {
      const ka = keyOf[t][k], kb = keyOf[t][(k + 1) % 3];
      const ek = ka < kb ? ka + '|' + kb : kb + '|' + ka;
      const e = ec.get(ek); if (e) e.c++; else ec.set(ek, { c: 1, ka, kb, pa: T.V[t][k], pb: T.V[t][(k + 1) % 3] });
    }
    const bEdges = []; for (const e of ec.values()) if (e.c === 1) bEdges.push([e.ka, e.kb, e.pa, e.pb]);
    const loops = chainLoops(bEdges);
    if (!loops || loops.length !== 2) { reject(`Rand-Loops ${loops ? loops.length : 'unsauber'}`); continue; }
    let fit;
    try { fit = fitTube(T, cand, keyOf, loops); } catch (e) { fit = { fail: 'Ausnahme: ' + (e && e.message) }; }
    if (fit.fail) { const { fail: why, ...extra } = fit; reject(why, extra); continue; }
    const spec = { id: nextId++, ...fit };
    for (const gi of gCount.keys()) normalGroups[gi].tube = spec;
    tubes.push(spec);
  }
  stats.tubes = tubes.length;
  return { tubes, stats };
}

/**
 * Exporter-Hilfe: zu jeder Mündung eines Kanals den passenden Innen-Loop einer EBENEN Fläche
 * finden (rein geometrisch: Ebene parallel, alle Loop-Punkte auf der Mündungskurve).
 * faceDefs: [{ inner: [loop], normal }]. Rückgabe [{ fd, inner, curveIndex }, …] oder null.
 */
export function matchTubeMouths(spec, faceDefs, isTaken = () => false) {
  const hits = [];
  for (const mouth of spec.mouths) {
    const cv = spec.curves[mouth.curve];
    let hit = null;
    for (const fd of faceDefs) {
      if (!fd.normal || Math.abs(dot(norm(fd.normal), mouth.planeN)) < 0.9995) continue;
      for (const inner of fd.inner || []) {
        if (inner.length < 3 || isTaken(inner) || hits.some((x) => x.inner === inner)) continue;
        let ok = true;
        for (const p of inner) if (curveDist(cv, p) > MOUTH_TOL) { ok = false; break; }
        if (ok) { hit = { fd, inner, curveIndex: mouth.curve }; break; }
      }
      if (hit) break;
    }
    if (!hit) return null;
    hits.push(hit);
  }
  return hits;
}

export const _internal = { fitPlane, fitCircleFixedR, fitCircleFree, eigenSym3, biarc, arcFrom, vertexResidual, curveDist };

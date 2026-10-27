// ─────────────────────────────────────────────────────────────────────────────
// Profil-Bögen als echte Teil-Zylinder / Teil-Kegel (STEP: CYLINDRICAL_SURFACE / CONICAL_SURFACE,
// begrenzt von zwei Kreisbögen = CIRCLE-Kanten und zwei Geraden).
//
// ENTWURF
// Ein extrudiertes Profil mit Bögen (gebogenes Blech, Langloch, Taschenecke, Fasen an der
// Stirnseite) kommt aus dem Netz als Streifen schmaler ebener Facetten. Jede Facette eines
// Bogen-Streifens hat ALLE Ecken auf genau zwei „Ebenen“ (Höhen t entlang der Achse d) — unten und
// oben — und liegt mit diesen Ecken auf zwei koaxialen Kreisen (gleicher Radius: Zylinder,
// verschiedene Radien: Kegel, z. B. 45°-Fase an der Stirnseite entlang des Bogens). Ein solches
// BAND (Facetten zwischen denselben zwei Höhen, über Seitenkanten unten↔oben verkettet) wird EINE
// Teilfläche: Rand = Bogen unten + Gerade (Seite) + Bogen oben + Gerade (Seite). Der Bogen ersetzt den
// Polygonzug der Facetten-Unterkanten — in der Nachbarfläche (Deckfläche ⟂ d oder das nächste Band,
// z. B. Zylinder → Fasen-Kegel → Stirnfläche) genauso. Die Seiten-Geraden bleiben die Netzkanten,
// die das Band mit seinen Nachbarn (Gerade/Flachstück, Gegenbogen eines S-Hakens) teilt.
//
// Datenmodell (alles auf den ebenen faceDefs NACH enforcePlanarity + removeCollinearPoints, d.h.
// unmittelbar vor assemble):
//   Band  = { id, kind: 'cyl'|'cone', d, frame, facets: [fi], segs, levels: { lo, hi }, sense, sig }
//           segs: Rand des Bands in Facetten-Umlaufrichtung (gegen den Uhrzeigersinn um die
//           Außennormale), genau 4 Stücke: { type:'arc', level:'lo'|'hi', arcKey, pts } und
//           { type:'line', pts } im Wechsel; pts = Netzpunkte (Objekte aus den faceDefs).
//           level = { t, c2: [u, v] (Kreismitte im Rahmen), r, pts }
//   Arc   = { key, pts (Polygonzug, Richtung wie im ERSTEN Band), d, frame, level, owners }
//           key = kanonischer Schlüssel aus Endpunkten + kleinstem inneren Punkt (zwei Bögen
//           zwischen denselben Endpunkten bleiben verschieden).
//   CapEdit = { fi, li, arcKey, a, b }: in Loop li der ebenen Fläche fi den Polygonzug a…b durch
//           die Bogen-Kante ersetzen (innere Punkte fallen weg, fd.arcEdges: Kante(a,b) → arcKey).
//
// Erkennung (findArcBands):
//   1. Achsen-Kandidaten = Normalen ebener Flächen mit vielen Randpunkten (Deck-/Stirnflächen).
//   2. Je Achse: Facetten mit genau zwei Höhen (Toleranz levelTol) und genau zwei Seitenkanten
//      (unten↔oben); Nachbar-Facetten über eine Seitenkante mit gleichen Höhen und kleinem Knick
//      (≤ maxSegDeg) → Ketten.
//   3. Ketten gierig in Bänder teilen: alle Unten- und Oben-Punkte je auf einem Kreis (Toleranz
//      tolFit = max(tolFitAbs, tolFitRel·r), relativ zur Sehnen-Pfeilhöhe klein), Mitten koaxial,
//      jede Seitenkante eine Mantellinie (unten und oben im selben Winkel), Segmentwinkel ≤
//      maxSegDeg, gleicher Drehsinn, ≥ minSegs Segmente. Vollkreise (geschlossene Ketten) bleiben
//      den vorhandenen Mantel-/Bohrungs-Pfaden.
//   4. Rand des Bands = Vereinigung der gerichteten Facetten-Kanten (innere heben sich auf) → genau
//      ein Loop aus Bogen unten, Seite, Bogen oben, Seite. same_sense aus den Facetten-Normalen
//      (alle müssen zur STEP-Flächennormale gleich stehen).
//   5. Nachbar-Prüfung bis zum Fixpunkt: jeder Bogen grenzt Kante für Kante an GENAU eine ebene
//      Fläche ⟂ d (eine Loop) oder an genau ein anderes gültiges Band (gleicher Polygonzug). Sonst
//      fällt das Band weg (und mit ihm abhängige Bänder) → bleibt facettiert.
//
// Exakte Geometrie (buildArcPlans, NACH snapToPlanes, aus den GESCHRIEBENEN Koordinaten): jeder Bogen
// läuft exakt durch seine zwei geschriebenen Endpunkte (Kreisebene enthält beide, Mitte auf der
// Mittelsenkrechten nahe der Kreis-Anpassung), Umlaufsinn aus dem Polygonzug. Die Bandfläche
// (Zylinder: Achse d, Radius = Mittel; Kegel: Lage im großen Kreis, Achse zum wachsenden Radius)
// muss jeden Bogen auf surfTol enthalten, die Deckfläche ebenso — sonst fällt das Band weg.
//
// Einhängen (exporters.js): convertArcs() direkt vor assembleSolids (assembleCurrent und die
// facettierte Basislinie). Scheitert der Zusammenbau mit Bögen, werden die Bänder an defekten
// Kanten gesperrt (blocked, Signatur = Ecken-Schlüssel) und neu gebaut, zuletzt ganz ohne Bögen —
// ein gescheiterter Bogen bleibt facettiert, der Rest des Teils unberührt.
// ─────────────────────────────────────────────────────────────────────────────

export const ARC_DEFAULTS = {
  levelTol: 2e-3,      // mm: Punkte einer Höhe (entlang d)
  tolFitAbs: 5e-3,     // mm: Netzpunkt ↔ Kreis
  tolFitRel: 2e-3,     // × r
  maxSegDeg: 30,       // größter Segmentwinkel eines Bogens (gröber = Polygon, kein Bogen)
  minSegs: 3,          // Mindestzahl Segmente des längeren Bogens
  maxFacetPts: 6,      // Facetten mit mehr Ecken sind keine Band-Facetten
  capMinPts: 6,        // Achsen-Kandidat: ebene Fläche mit mindestens so vielen Randpunkten
  capCos: 0.99999,     // |n·d| ≥ capCos: Fläche steht senkrecht zur Achse (Deck-/Stirnfläche)
  surfTol: 5e-5,       // mm: exakter Bogen ↔ Bandfläche / Deckebene (strikte Importer)
  samples: 9,          // Abtastpunkte je Bogen für Prüfungen
};

// ── Vektor-Helfer ───────────────────────────────────────────────────────────
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a); return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0]; };

// 3x3-Determinante (M = [[m00,m01,m02],[m10,m11,m12],[m20,m21,m22]])
const det3 = (m) =>
  m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
  m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
  m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);

// 3x3-System M·x = b per Cramer — null bei singulärer Matrix
const solve3 = (M, b) => {
  const det = det3(M);
  if (!Number.isFinite(det) || det === 0) return null;
  const x = [];
  for (let j = 0; j < 3; j++) {
    const Mj = M.map((row, i) => row.map((v, k) => (k === j ? b[i] : v)));
    const dj = det3(Mj);
    if (!Number.isFinite(dj)) return null;
    x.push(dj / det);
  }
  return x;
};

// ── Rahmen (Achse + zwei Querachsen) ────────────────────────────────────────
// Rechtshändig: e1 × e2 = d. e1 = normiert(d × ref), ref = Koordinatenachse mit dem
// kleinsten |d_i| (nie parallel zu d → d × ref ≠ 0).
export function makeFrame(d) {
  const dd = norm(d);
  const ax = Math.abs(dd[0]), ay = Math.abs(dd[1]), az = Math.abs(dd[2]);
  const ref = ax <= ay && ax <= az ? [1, 0, 0] : (ay <= az ? [0, 1, 0] : [0, 0, 1]);
  const e1 = norm(cross(dd, ref));   // ⊥ d
  const e2 = cross(dd, e1);          // ⊥ d, |e2| = 1 → e1 × e2 = d
  return { d: dd, e1, e2 };
}

// Punkt → Rahmen-Koordinaten [u, v, t] = [p·e1, p·e2, p·d]
export function toLocal(frame, p) {
  return [dot(p, frame.e1), dot(p, frame.e2), dot(p, frame.d)];
}

/**
 * Kreis-Fit in 2D: Kasa (algebraisch) + 4 Gauss-Newton-Schritte (geometrisch).
 * pts: [[u,v],…] (≥ 3) → { c:[u,v], r, maxRes } | null
 * maxRes = max |‖p − c‖ − r|; null bei < 3 Punkten, kollinearen Punkten (det ≈ 0)
 * oder nicht endlichem Ergebnis.
 */
export function fitCircle2d(pts) {
  if (!pts || pts.length < 3) return null;
  const n = pts.length;
  // Schwerpunkt + Skalierung: Kasa ist sonst gegen große Koordinatenwerte empfindlich
  let mx = 0, my = 0;
  for (const p of pts) {
    if (!p || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) return null;
    mx += p[0]; my += p[1];
  }
  mx /= n; my /= n;
  let scale = 0;
  for (const p of pts) scale = Math.max(scale, Math.hypot(p[0] - mx, p[1] - my));
  if (!(scale > 0) || !Number.isFinite(scale)) return null;
  const nx = [], ny = [];
  for (const p of pts) { nx.push((p[0] - mx) / scale); ny.push((p[1] - my) / scale); }

  // Kasa: x² + y² = a·x + b·y + k   (a = 2cx, b = 2cy, k = r² − cx² − cy²)
  let Sx = 0, Sy = 0, Sxx = 0, Sxy = 0, Syy = 0, Su = 0, Sxu = 0, Syu = 0;
  for (let i = 0; i < n; i++) {
    const x = nx[i], y = ny[i], u = x * x + y * y;
    Sx += x; Sy += y; Sxx += x * x; Sxy += x * y; Syy += y * y;
    Su += u; Sxu += x * u; Syu += y * u;
  }
  const M = [[Sxx, Sxy, Sx], [Sxy, Syy, Sy], [Sx, Sy, n]];
  const b = [Sxu, Syu, Su];
  const det = det3(M);
  // Im Schwerpunkt gilt |det| = n·(Sxx·Syy − Sxy²) → relative Schwelle = Kollinearität
  const detRef = n * Math.max(Sxx * Syy, 1e-30);
  if (!Number.isFinite(det) || Math.abs(det) <= 1e-10 * detRef) return null;   // kollinear
  const sol = solve3(M, b);
  if (!sol) return null;
  let cx = sol[0] / 2, cy = sol[1] / 2;
  const r2 = sol[2] + cx * cx + cy * cy;
  if (!(r2 > 0) || !Number.isFinite(r2)) return null;
  let r = Math.sqrt(r2);

  // 4 Gauss-Newton-Schritte (geometrisch: ‖p − c‖ − r minimieren)
  for (let it = 0; it < 4; it++) {
    let m00 = 0, m01 = 0, m11 = 0, sjx = 0, sjy = 0, sres = 0, g0 = 0, g1 = 0, bad = false;
    for (let i = 0; i < n; i++) {
      const dx = cx - nx[i], dy = cy - ny[i];
      const dist = Math.hypot(dx, dy);
      if (!(dist > 0)) { bad = true; break; }
      const res = dist - r, jx = dx / dist, jy = dy / dist;
      m00 += jx * jx; m01 += jx * jy; m11 += jy * jy;
      sjx += jx; sjy += jy; sres += res;
      g0 += jx * res; g1 += jy * res;
    }
    if (bad) return null;
    const NN = [[m00, m01, -sjx], [m01, m11, -sjy], [-sjx, -sjy, n]];
    const gg = [g0, g1, -sres];
    const ds = solve3(NN, gg);
    if (!ds) break;                       // singulär: Kasa-Schätzung behalten
    cx -= ds[0]; cy -= ds[1]; r -= ds[2];
    if (!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(r) || !(r > 0)) return null;
  }

  // zurück in die Ausgangskoordinaten
  const cxO = cx * scale + mx, cyO = cy * scale + my, rO = r * scale;
  if (!Number.isFinite(cxO) || !Number.isFinite(cyO) || !Number.isFinite(rO)) return null;
  let maxRes = 0;
  for (const p of pts) {
    const e = Math.abs(Math.hypot(p[0] - cxO, p[1] - cyO) - rO);
    if (!Number.isFinite(e)) return null;
    if (e > maxRes) maxRes = e;
  }
  return { c: [cxO, cyO], r: rO, maxRes };
}

// Fläche trägt schon Bogen-Kanten (fd.arcEdges) → nicht als Achsen-Quelle nutzen
const hasArcEdges = (fd) => {
  const a = fd.arcEdges;
  if (!a) return false;
  if (Array.isArray(a)) return a.length > 0;
  if (a instanceof Map || a instanceof Set) return a.size > 0;
  if (typeof a === 'object') return Object.keys(a).length > 0;
  return !!a;
};

/**
 * Achsen-Kandidaten aus den ebenen Flächen: jede Fläche ohne circleRim/arcEdges mit
 * ≥ opts.capMinPts Randpunkten (Außen + Innen zusammen) liefert ihre Normale.
 * Vorzeichen kanonisch (erste Komponente mit |x| > 1e-9 positiv), Duplikate
 * (|cos| ≥ opts.capCos) werden zusammengefasst (erste gewinnt, Punktzahl addiert),
 * Sortierung nach Gesamtpunktzahl absteigend.
 */
export function axisCandidates(fds, opts) {
  const o = { ...ARC_DEFAULTS, ...opts };
  const out = [];
  for (const fd of fds || []) {
    if (!fd) continue;
    if (hasArcEdges(fd)) continue;
    const loops = [fd.outer, ...(fd.inner || [])];
    if (loops.some((L) => L && L.circleRim)) continue;   // analytischer Kreis-Rand
    let count = 0;
    for (const L of loops) if (L) count += L.length;
    if (count < o.capMinPts) continue;
    const nn = fd.normal;
    if (!nn || !Number.isFinite(nn[0]) || !Number.isFinite(nn[1]) || !Number.isFinite(nn[2])) continue;
    let d = norm(nn);
    if (!(len(d) > 0)) continue;
    // kanonisches Vorzeichen: erste Komponente mit |x| > 1e-9 positiv
    for (let i = 0; i < 3; i++) {
      if (Math.abs(d[i]) > 1e-9) { if (d[i] < 0) d = [-d[0], -d[1], -d[2]]; break; }
    }
    // Duplikate zusammenfassen — erste Normale gewinnt
    let hit = -1;
    for (let i = 0; i < out.length; i++) {
      if (Math.abs(dot(out[i].d, d)) >= o.capCos) { hit = i; break; }
    }
    if (hit >= 0) { out[hit].count += count; continue; }
    out.push({ d, count });
  }
  out.sort((a, b) => b.count - a.count);
  return out.map((a) => a.d);
}

// ── Vertex-Schlüssel ────────────────────────────────────────────────────────
// vtxKey ist Pflicht-Option; der Ersatz ist nur eine Notfallklammer (identisch zum
// Test-Key: vier Nachkommastellen, -0 → 0).
const vtxKeyOf = (o) => (typeof o.vtxKey === 'function')
  ? o.vtxKey
  : (p) => (p || []).map((x) => (+x.toFixed(4) || 0).toFixed(4)).join(',');

// kanonischer Kantenschlüssel (unabhängig von der Richtung)
const edgeKeyOf = (ka, kb) => (ka < kb ? ka + '|' + kb : kb + '|' + ka);

// ── Kanten-Index ────────────────────────────────────────────────────────────
/**
 * Alle Kanten aller Flächen: je Fläche fi und Loop li (0 = outer, k = inner[k−1]) die
 * Kante i (a = L[i], b = L[(i+1)%n]); Kanten mit gleichem vtxKey(a) = vtxKey(b)
 * werden übersprungen.
 * opts.skipCircleRim: Loops mit circleRim (analytischer Kreis-Rand) nicht indizieren.
 * → Map edgeKey → [{ fi, li, i, a, b }]
 */
function buildEdgeIndex(fds, opts) {
  const o = { ...ARC_DEFAULTS, ...opts };
  const vkey = vtxKeyOf(o);
  const index = new Map();
  (fds || []).forEach((fd, fi) => {
    if (!fd) return;
    const loops = [fd.outer, ...(fd.inner || [])];
    loops.forEach((L, li) => {
      if (!L || !L.length) return;
      if (o.skipCircleRim && L.circleRim) return;             // analytischer Kreis-Rand
      const n = L.length;
      for (let i = 0; i < n; i++) {
        const a = L[i], b = L[(i + 1) % n];
        const ka = vkey(a), kb = vkey(b);
        if (ka === kb) continue;
        const key = edgeKeyOf(ka, kb);
        let arr = index.get(key);
        if (!arr) { arr = []; index.set(key, arr); }
        arr.push({ fi, li, i, a, b });
      }
    });
  });
  return index;
}

// ── Ketten je Achse (Schritte 1 + 2) ─────────────────────────────────────────
/**
 * Schritt 1: Kandidaten-Facetten (ohne Innen-Loops, 3…maxFacetPts Punkte, |n·d| < capCos)
 *   mit genau zwei Höhen (levelTol) und genau zwei Seitenkanten (lo↔hi).
 * Schritt 2: Verkettung über gemeinsame Seitenkanten (gleiche Höhen, Knick ≤ maxSegDeg)
 *   → Pfade und Zyklen.
 * Ergebnis: { facets: Map fi → { fi, tlo, thi, level, sides, sideEdges },
 *             chains: [{ cyclic, facets, sides }] }
 * `taken` = Set bereits belegter fi (Band einer früheren Achse) → übersprungen.
 */
function buildChains(fds, d, frame, index, taken, opts) {
  const o = { ...ARC_DEFAULTS, ...opts };
  const vkey = vtxKeyOf(o);
  const levelTol = o.levelTol;
  const facets = new Map();

  // ── Schritt 1: Kandidaten-Facetten ─────────────────────────────────────────
  const list = fds || [];
  for (let fi = 0; fi < list.length; fi++) {
    const fd = list[fi];
    if (!fd) continue;
    if (taken && taken.has(fi)) continue;
    if (hasArcEdges(fd)) continue;
    if ((fd.inner || []).length) continue;                 // keine Innen-Loops
    const L = fd.outer;
    if (!L || L.circleRim) continue;                       // analytischer Kreis-Rand → ignorieren
    if (!L || L.length < 3 || L.length > o.maxFacetPts) continue;
    const nn = fd.normal;
    if (!nn) continue;
    const nd = norm(nn);
    if (!(len(nd) > 0)) continue;
    if (Math.abs(dot(nd, d)) >= o.capCos) continue;        // steht senkrecht zur Achse

    // Höhen aller Punkte
    const ts = new Array(L.length);
    let tmin = Infinity, tmax = -Infinity;
    for (let i = 0; i < L.length; i++) {
      const t = toLocal(frame, L[i])[2];
      ts[i] = t;
      if (t < tmin) tmin = t;
      if (t > tmax) tmax = t;
    }
    if (!(tmax - tmin > 10 * levelTol)) continue;

    // Punkte den Ebenen zuordnen (lo bei tmin, hi bei tmax)
    const level = new Map();
    let ok = true, sumLo = 0, nLo = 0, sumHi = 0, nHi = 0;
    for (let i = 0; i < L.length; i++) {
      const k = vkey(L[i]);
      const t = ts[i];
      if (Math.abs(t - tmin) <= levelTol) { level.set(k, 'lo'); sumLo += t; nLo++; }
      else if (Math.abs(t - tmax) <= levelTol) { level.set(k, 'hi'); sumHi += t; nHi++; }
      else { ok = false; break; }
    }
    if (!ok || !nLo || !nHi) continue;

    // Seitenkanten: Kanten mit einem lo- und einem hi-Punkt (genau 2 nötig)
    const sides = [];
    const n = L.length;
    for (let i = 0; i < n; i++) {
      const a = L[i], b = L[(i + 1) % n];
      const ka = vkey(a), kb = vkey(b);
      if (ka === kb) continue;
      const la = level.get(ka), lb = level.get(kb);
      if (!la || !lb || la === lb) continue;
      const key = edgeKeyOf(ka, kb);
      if (sides.some((s) => s.key === key)) continue;
      sides.push({ key, lo: la === 'lo' ? a : b, hi: la === 'lo' ? b : a });
    }
    if (sides.length !== 2) continue;

    facets.set(fi, {
      fi,
      tlo: sumLo / nLo,
      thi: sumHi / nHi,
      level,
      sides: [sides[0].key, sides[1].key],
      sideEdges: [[sides[0].lo, sides[0].hi], [sides[1].lo, sides[1].hi]],
    });
  }

  // ── Schritt 2: Nachbarschaft über gemeinsame Seitenkanten ─────────────────
  const adj = new Map();
  for (const [fi, info] of facets) {
    const nb = [];
    for (const sk of info.sides) {
      for (const e of index.get(sk) || []) {
        if (e.fi === fi) continue;
        const g = facets.get(e.fi);
        if (!g) continue;
        if (g.sides.indexOf(sk) < 0) continue;             // dort ebenfalls Seitenkante?
        if (Math.abs(info.tlo - g.tlo) > levelTol) continue;
        if (Math.abs(info.thi - g.thi) > levelTol) continue;
        const n1 = fds[fi].normal, n2 = fds[e.fi].normal;
        if (!n1 || !n2) continue;
        const cs = Math.min(1, Math.max(-1, dot(norm(n1), norm(n2))));
        if (Math.acos(cs) * 180 / Math.PI > o.maxSegDeg) continue;
        if (nb.some((x) => x.nb === e.fi)) continue;
        nb.push({ nb: e.fi, key: sk });
      }
    }
    adj.set(fi, nb);
  }

  // Punktpaar [lo, hi] einer Seitenkante (aus irgendeiner Kette-Fläche)
  const pairOf = (fchain, key) => {
    for (const fi of fchain) {
      const info = facets.get(fi);
      const i = info.sides.indexOf(key);
      if (i >= 0) return info.sideEdges[i];
    }
    return null;
  };

  // Kette ab `start` ablaufen (Weg → Pfad, geschlossener Weg → Zyklus)
  const walk = (start) => {
    const fchain = [start];
    const shared = [];                                    // shared[k] = Kante fchain[k]↔fchain[k+1]
    let cur = start, usedEdge = null;
    for (;;) {
      const step = adj.get(cur).filter((x) => x.key !== usedEdge)[0];
      if (!step) break;
      if (fchain.indexOf(step.nb) >= 0) {
        return { fchain, shared, closing: step.key, cyclic: true };
      }
      fchain.push(step.nb);
      shared.push(step.key);
      usedEdge = step.key;
      cur = step.nb;
    }
    return { fchain, shared, closing: null, cyclic: false };
  };

  // Seitenkanten der Kette: s_0 … s_m (Facette k und k+1 teilen s_{k+1})
  const makeChain = (w) => {
    const fchain = w.fchain;
    const sides = [];
    if (w.cyclic) {
      sides.push(pairOf(fchain, w.closing));
      for (const k of w.shared) sides.push(pairOf(fchain, k));
      sides.push(pairOf(fchain, w.closing));               // s_m = s_0
    } else {
      const first = facets.get(fchain[0]);
      const last = facets.get(fchain[fchain.length - 1]);
      let s0, sm;
      if (fchain.length === 1) { s0 = first.sides[0]; sm = first.sides[1]; }
      else {
        s0 = first.sides.find((k) => k !== w.shared[0]);
        sm = last.sides.find((k) => k !== w.shared[w.shared.length - 1]);
      }
      sides.push(pairOf(fchain, s0));
      for (const k of w.shared) sides.push(pairOf(fchain, k));
      sides.push(pairOf(fchain, sm));
    }
    return { cyclic: !!w.cyclic, facets: fchain, sides };
  };

  // Pfade zuerst (Endpunkte mit genau einem Nachbarn), danach Zyklen
  const chains = [];
  const visited = new Set();
  for (const [fi, nb] of adj) {
    if (nb.length !== 1 || visited.has(fi)) continue;
    const w = walk(fi);
    for (const x of w.fchain) visited.add(x);
    chains.push(makeChain(w));
  }
  for (const fi of facets.keys()) {
    if (visited.has(fi)) continue;
    const w = walk(fi);
    for (const x of w.fchain) visited.add(x);
    chains.push(makeChain(w));
  }

  return { facets, chains };
}

// ── Band-Erkennung (Schritte 3–5) ───────────────────────────────────────────

/**
 * Lo-/Hi-Lauf einer Band-Facette: der Loop besteht aus genau zwei zusammenhängenden
 * Punktfolgen (getrennt durch die beiden Seitenkanten lo↔hi).
 * → { loRun, hiRun } | null
 */
function facetRuns(fd, info, vkey) {
  const L = fd.outer;
  const n = L.length;
  const cls = new Array(n);
  for (let i = 0; i < n; i++) cls[i] = info.level.get(vkey(L[i])) || 'lo';
  let start = -1;
  for (let i = 0; i < n; i++) {
    if (cls[i] === 'hi' && cls[(i + 1) % n] === 'lo') { start = (i + 1) % n; break; }
  }
  if (start < 0) return null;
  const loRun = [], hiRun = [];
  let k = start;
  while (cls[k] === 'lo') { loRun.push(L[k]); k = (k + 1) % n; }
  while (cls[k] === 'hi') { hiRun.push(L[k]); k = (k + 1) % n; }
  if (k !== start) return null;
  return { loRun, hiRun };
}

/** Lauf so umkehren, dass er bei startKey beginnt und bei endKey endet (sonst null). */
function orientRun(run, startKey, endKey, vkey) {
  if (!run || !run.length) return null;
  if (run.length === 1) return vkey(run[0]) === startKey ? run : null;
  const k0 = vkey(run[0]), k1 = vkey(run[run.length - 1]);
  if (k0 === startKey && k1 === endKey) return run;
  if (k1 === startKey && k0 === endKey) return run.slice().reverse();
  return null;
}

/**
 * Vorzeichenbehaftete Winkel einer 2D-Polygon-Kette um c:
 * alle Winkel ≤ maxAng, |Winkel| > 1e-6 und gleiches Vorzeichen.
 * → +1 / −1 (Drehsinn) | 0 (unbrauchbar)
 */
function chainAngleSign(pts2d, c, maxAng) {
  let s = 0;
  for (let i = 0; i + 1 < pts2d.length; i++) {
    const a1 = Math.atan2(pts2d[i][1] - c[1], pts2d[i][0] - c[0]);
    const a2 = Math.atan2(pts2d[i + 1][1] - c[1], pts2d[i + 1][0] - c[0]);
    let d = a2 - a1;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    if (Math.abs(d) > maxAng || Math.abs(d) <= 1e-6) return 0;
    const sg = d > 0 ? 1 : -1;
    if (s === 0) s = sg; else if (s !== sg) return 0;
  }
  return s;
}

/** Achspunkt in 3D: Kreismitte (u,v) auf Höhe t */
const axisPoint = (frame, cu, cv, t) => [
  cu * frame.e1[0] + cv * frame.e2[0] + t * frame.d[0],
  cu * frame.e1[1] + cv * frame.e2[1] + t * frame.d[1],
  cu * frame.e1[2] + cv * frame.e2[2] + t * frame.d[2],
];

/** Schwerpunkt einer Punktliste */
const centroidOf = (pts) => {
  if (!pts || !pts.length) return null;
  const c = [0, 0, 0];
  for (const p of pts) { c[0] += p[0]; c[1] += p[1]; c[2] += p[2]; }
  return [c[0] / pts.length, c[1] / pts.length, c[2] / pts.length];
};

/** Umkreis-Radius eines Dreiecks in 2D — null bei kollinearen Punkten */
function circumRadius2d(a, b, c) {
  const ab = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const bc = Math.hypot(c[0] - b[0], c[1] - b[1]);
  const ca = Math.hypot(a[0] - c[0], a[1] - c[1]);
  const area = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;
  if (!(area > 0)) return null;                          // kollinear
  const R = (ab * bc * ca) / (4 * area);
  return Number.isFinite(R) ? R : null;
}

/**
 * Der Polygonzug muss ein Sehnenzug EINES Kreises sein (Kopf-Kommentar Punkt 3:
 * „alle Unten- und Oben-Punkte je auf einem Kreis“). Der Umkreis-Radius je drei
 * aufeinanderfolgenden Punkten muss zum gefitteten Radius passen — sonst rutscht ein
 * „gemischtes“ Band (Gerade + flacher Bogen) durch: dessen Fit-Radius ist riesig und
 * die Toleranz (∝ r) lässt dann jeden Restfehler zu.
 */
function oneCircle(pts2d, K, tolAbs, tolRel) {
  for (let i = 0; i + 2 < pts2d.length; i++) {
    const R = circumRadius2d(pts2d[i], pts2d[i + 1], pts2d[i + 2]);
    if (R === null) return false;                        // kollinear
    const tol = Math.max(tolAbs, tolRel * Math.max(K.r, R));
    if (Math.abs(R - K.r) > tol) return false;
  }
  return true;
}

/**
 * Prüft, ob die Facetten i..j der Kette ein Band ergeben (Schritt 3):
 * beide Läufe auf je einen Kreis, koaxial, Seitenkanten = Mantellinien,
 * Segmentwinkel klein und gleich gerichtet.
 * → { loPts, hiPts, Klo, Khi, tol, nSegs, tlo, thi } | null
 */
function tryBand(ctx, chain, i, j) {
  const { fds, frame, o, vkey, facInfo } = ctx;
  const sides = chain.sides;
  const loPts = [], hiPts = [];
  const seenLo = new Set(), seenHi = new Set();
  let tlo = 0, thi = 0, cnt = 0;
  for (let k = i; k <= j; k++) {
    const fi = chain.facets[k];
    const info = facInfo.get(fi);
    if (!info) return null;
    const runs = facetRuns(fds[fi], info, vkey);
    if (!runs) return null;
    const sA = sides[k], sB = sides[k + 1];
    if (!sA || !sB) return null;
    const loRun = orientRun(runs.loRun, vkey(sA[0]), vkey(sB[0]), vkey);
    const hiRun = orientRun(runs.hiRun, vkey(sA[1]), vkey(sB[1]), vkey);
    if (!loRun || !hiRun) return null;
    for (const p of loRun) { const kk = vkey(p); if (!seenLo.has(kk)) { seenLo.add(kk); loPts.push(p); } }
    for (const p of hiRun) { const kk = vkey(p); if (!seenHi.has(kk)) { seenHi.add(kk); hiPts.push(p); } }
    tlo += info.tlo; thi += info.thi; cnt++;
  }
  if (loPts.length < 3 || hiPts.length < 3) return null;
  const lo2d = loPts.map((p) => { const l = toLocal(frame, p); return [l[0], l[1]]; });
  const hi2d = hiPts.map((p) => { const l = toLocal(frame, p); return [l[0], l[1]]; });
  const Klo = fitCircle2d(lo2d), Khi = fitCircle2d(hi2d);
  if (!Klo || !Khi) return null;
  const rMax = Math.max(Klo.r, Khi.r);
  const tol = Math.max(o.tolFitAbs, o.tolFitRel * rMax);
  if (Klo.maxRes > tol || Khi.maxRes > tol) return null;
  if (Math.hypot(Klo.c[0] - Khi.c[0], Klo.c[1] - Khi.c[1]) > tol) return null;
  // Sehnenzug EINES Kreises (lokaler Umkreis je drei Punkte passt zum Fit-Radius)
  if (!oneCircle(lo2d, Klo, o.tolFitAbs, o.tolFitRel)) return null;
  if (!oneCircle(hi2d, Khi, o.tolFitAbs, o.tolFitRel)) return null;
  // Seitenkanten = Mantellinien: lo- und hi-Punkt im selben Polarwinkel
  for (let k = i; k <= j + 1; k++) {
    const s = sides[k];
    if (!s) return null;
    const a = toLocal(frame, s[0]), b = toLocal(frame, s[1]);
    const pa = Math.atan2(a[1] - Klo.c[1], a[0] - Klo.c[0]);
    const pb = Math.atan2(b[1] - Khi.c[1], b[0] - Khi.c[0]);
    let dphi = pa - pb;
    while (dphi > Math.PI) dphi -= 2 * Math.PI;
    while (dphi < -Math.PI) dphi += 2 * Math.PI;
    if (Math.abs(dphi) * rMax > tol) return null;
  }
  // Segmentwinkel: gleiches Vorzeichen in beiden Läufen
  const maxAng = o.maxSegDeg * Math.PI / 180;
  const sLo = chainAngleSign(lo2d, Klo.c, maxAng);
  if (!sLo) return null;
  if (chainAngleSign(hi2d, Khi.c, maxAng) !== sLo) return null;
  return {
    loPts, hiPts, Klo, Khi, tol, rMax,
    nSegs: Math.max(loPts.length - 1, hiPts.length - 1),
    tlo: tlo / cnt, thi: thi / cnt,
  };
}

/** Bogen-Schlüssel: Endpunkte (sortiert) + kleinster innerer Punkt ('' bei 2 Punkten) */
function arcKeyOf(pts, vkey) {
  const ka = vkey(pts[0]), kb = vkey(pts[pts.length - 1]);
  const parts = ka < kb ? [ka, kb] : [kb, ka];
  let inner = '';
  for (let i = 1; i + 1 < pts.length; i++) {
    const k = vkey(pts[i]);
    if (!inner || k < inner) inner = k;
  }
  if (inner) parts.push(inner);
  return parts.join('|');
}

/**
 * Band aus den Facetten i..j bauen (Schritt 4): Rand-Loop (genau 4 Läufe),
 * segs, levels, sense, sig.
 * → { band, arcs } | null   (arcs: [{ seg, key, pts, level }] der Bogen-Segs)
 */
function makeBand(ctx, chain, i, j, chk, id) {
  const { fds, frame, o, vkey } = ctx;
  const facets = chain.facets.slice(i, j + 1);

  // gerichtete Kanten (a→b) aller outer-Loops sammeln
  const dir = new Map();
  for (const fi of facets) {
    const L = fds[fi].outer;
    for (let k = 0; k < L.length; k++) {
      const a = L[k], b = L[(k + 1) % L.length];
      const ka = vkey(a), kb = vkey(b);
      if (ka === kb) continue;
      const key = ka + '>' + kb;
      if (!dir.has(key)) dir.set(key, { a, b, ka, kb });
    }
  }
  // innere Kanten (Gegenrichtung vorhanden) streichen
  const edges = [];
  for (const e of dir.values()) if (!dir.has(e.kb + '>' + e.ka)) edges.push(e);
  if (!edges.length) return null;

  // Rest zu GENAU EINEM geschlossenen Loop verketten
  const byStart = new Map();
  for (const e of edges) { if (byStart.has(e.ka)) return null; byStart.set(e.ka, e); }
  const loop = [];
  const firstKa = edges[0].ka;
  let e = edges[0], closed = false;
  for (let step = 0; step < edges.length; step++) {
    loop.push(e.a);
    const nx = byStart.get(e.kb);
    if (!nx) return null;                       // nicht geschlossen
    if (nx.ka === firstKa) { closed = true; break; }
    e = nx;
  }
  if (!closed || loop.length !== edges.length) return null;   // offen oder mehrere Loops

  // Punkte je Ebene zuordnen
  const n = loop.length;
  const cls = new Array(n);
  for (let k = 0; k < n; k++) {
    const t = toLocal(frame, loop[k])[2];
    if (Math.abs(t - chk.tlo) <= o.levelTol) cls[k] = 'lo';
    else if (Math.abs(t - chk.thi) <= o.levelTol) cls[k] = 'hi';
    else return null;
  }
  // genau ein Übergang hi→lo → Loop dort beginnen (erster Punkt des lo-Laufs)
  let cut = -1, nTrans = 0;
  for (let k = 0; k < n; k++) {
    if (cls[k] === 'hi' && cls[(k + 1) % n] === 'lo') { cut = (k + 1) % n; nTrans++; }
  }
  if (nTrans !== 1) return null;
  const pts = loop.slice(cut).concat(loop.slice(0, cut));
  const c2 = cls.slice(cut).concat(cls.slice(0, cut));
  let nLo = 0; while (nLo < n && c2[nLo] === 'lo') nLo++;
  let nHi = 0; while (nLo + nHi < n && c2[nLo + nHi] === 'hi') nHi++;
  if (nLo < 2 || nHi < 2 || nLo + nHi !== n) return null;    // nicht genau 4 Läufe

  // 4 Rand-Stücke: Bogen lo, Seite, Bogen hi, Seite
  const segs = [
    { type: 'arc', level: 'lo', pts: pts.slice(0, nLo) },
    { type: 'line', pts: [pts[nLo - 1], pts[nLo]] },
    { type: 'arc', level: 'hi', pts: pts.slice(nLo, nLo + nHi) },
    { type: 'line', pts: [pts[nLo + nHi - 1], pts[0]] },
  ];
  const levels = {
    lo: { t: chk.tlo, c2: chk.Klo.c, r: chk.Klo.r, pts: segs[0].pts },
    hi: { t: chk.thi, c2: chk.Khi.c, r: chk.Khi.r, pts: segs[2].pts },
  };

  // sense: STEP-Normale je Facette — alle gleich, sonst verwerfen
  const kind = Math.abs(chk.Klo.r - chk.Khi.r) <= chk.tol ? 'cyl' : 'cone';
  const d = frame.d;
  let sense = 0;
  let alpha = 0, ac = null;
  if (kind === 'cone') {
    alpha = Math.atan(Math.abs(chk.Khi.r - chk.Klo.r) / Math.abs(chk.thi - chk.tlo));
    ac = mul(d, Math.sign(chk.Khi.r - chk.Klo.r) * Math.sign(chk.thi - chk.tlo));
  }
  for (const fi of facets) {
    const fd = fds[fi];
    const nn = fd.normal ? norm(fd.normal) : null;
    if (!nn) return null;
    const s = fd.centroid || centroidOf(fd.outer);
    if (!s) return null;
    const ap = axisPoint(frame, chk.Klo.c[0], chk.Klo.c[1], dot(s, d));
    const rad = sub(s, ap);
    const perp = sub(rad, mul(d, dot(rad, d)));
    if (!(len(perp) > 1e-12)) return null;
    const rho = norm(perp);
    const N = kind === 'cyl' ? rho : sub(mul(rho, Math.cos(alpha)), mul(ac, Math.sin(alpha)));
    const dp = dot(nn, N);
    const sg = dp > 1e-9 ? 1 : (dp < -1e-9 ? -1 : 0);
    if (!sg) return null;
    if (sense === 0) sense = sg; else if (sense !== sg) return null;
  }
  if (!sense) return null;

  // Signatur: die 4 Eckpunkte (Enden der beiden Bogen-Läufe)
  const sig = [pts[0], pts[nLo - 1], pts[nLo], pts[nLo + nHi - 1]].map(vkey).sort().join(';');
  if (o.blocked && typeof o.blocked.has === 'function' && o.blocked.has(sig)) return null;

  // Bogen-Schlüssel
  const arcs = [];
  for (let s = 0; s < segs.length; s++) {
    const seg = segs[s];
    if (seg.type !== 'arc') continue;
    seg.arcKey = arcKeyOf(seg.pts, vkey);
    arcs.push({ seg: s, key: seg.arcKey, pts: seg.pts, level: seg.level });
  }

  const band = {
    id, kind, d: frame.d, frame,
    facets: facets.slice(),
    segs, levels, sense, sig,
    nSegs: chk.nSegs,
  };
  return { band, arcs };
}

/** Index der Facette mit der längsten lo-Kante (2D-Seitenlänge) */
function widestFacet(ctx, chain) {
  const { fds, frame, vkey, facInfo } = ctx;
  let best = -1, bestLen = -1;
  chain.facets.forEach((fi, k) => {
    const info = facInfo.get(fi);
    if (!info) return;
    const runs = facetRuns(fds[fi], info, vkey);
    if (!runs) return;
    let L = 0;
    for (let i = 0; i + 1 < runs.loRun.length; i++) {
      const a = toLocal(frame, runs.loRun[i]), b = toLocal(frame, runs.loRun[i + 1]);
      L += Math.hypot(b[0] - a[0], b[1] - a[1]);
    }
    if (L > bestLen) { bestLen = L; best = k; }
  });
  return best < 0 ? 0 : best;
}

/**
 * Zyklus an der Seitenkante direkt NACH der breitesten Facette aufschneiden
 * → Pfad, der bei der Facette nach der breitesten beginnt.
 */
function cutCycle(chain, k) {
  const m = chain.facets.length;
  const S = chain.sides;
  const facets = chain.facets.slice(k + 1).concat(chain.facets.slice(0, k + 1));
  const sides = [];
  for (let j = k + 1; j <= m - 1; j++) sides.push(S[j]);
  sides.push(S[0]);
  for (let j = 1; j <= k; j++) sides.push(S[j]);
  sides.push(S[k + 1]);
  return { cyclic: false, facets, sides };
}

/**
 * Herkunft eines Bands merken (Kontext, Kette, Facettenbereich) — nicht aufzählbar,
 * damit validate/apply es ignorieren.
 */
function setBandSrc(band, ctx, chain, i, j) {
  Object.defineProperty(band, '_src', {
    value: { ctx, chain, i, j }, enumerable: false, writable: true, configurable: true,
  });
  return band;
}

/**
 * Teilbänder eines Band-Bereichs [a..b] bauen (tryBand + makeBand, inkl. blocked).
 * Scheitert die Prüfung oder hat der Bereich zu wenige Segmente → kein Band
 * (die Facetten bleiben facettiert).
 */
function pushBand(ctx, chain, a, b, out) {
  const chk = tryBand(ctx, chain, a, b);
  if (!chk || chk.nSegs < ctx.o.minSegs) return;
  const made = makeBand(ctx, chain, a, b, chk, out.length);
  if (!made) return;
  setBandSrc(made.band, ctx, chain, a, b);
  out.push(made.band);
}

/**
 * Teilungsstellen eines Bandes: Facettengrenzen (Index s in der Kette), an denen ein
 * Bogen des Bandes einen inneren Punkt hat, der Bogen-ENDpunkt eines anderen Bandes ist.
 * Für das lo-Seg zählt der lo-Punkt der Seitenkante, für das hi-Seg der hi-Punkt.
 * → aufsteigend sortierte Liste der Grenzindizes (i < s ≤ j).
 */
function cutsOfBand(X, chain, i, j, breaks, vkey) {
  const cuts = new Set();
  for (const seg of (X.segs || [])) {
    if (seg.type !== 'arc' || !seg.pts || seg.pts.length < 3) continue;
    const useLo = seg.level === 'lo';
    for (let k = 1; k + 1 < seg.pts.length; k++) {
      const kk = vkey(seg.pts[k]);
      if (!breaks.has(kk)) continue;
      for (let s = i + 1; s <= j; s++) {
        const side = chain.sides[s];
        if (!side) continue;
        if (vkey(useLo ? side[0] : side[1]) === kk) { cuts.add(s); break; }
      }
    }
  }
  return [...cuts].sort((a, b) => a - b);
}

/**
 * alignBands — gemeinsame Teilungsstellen der Bänder übereinanderliegender Ebenen.
 *
 * Zylinder-Band und das darüberliegende Fasen-Kegel-Band werden je Kette (Ebene)
 * UNABHÄNGIG gierig geteilt → ihre Teilungsstellen können verschieden liegen. Dann
 * grenzt der Bogen des einen Bandes halb an das andere Band, halb an eine Facette →
 * validateArcBands verwirft beide.
 *
 * Vorgehen: `breaks` = alle Endpunkte aller Bogen-Segs aller Bänder. Hat ein Band X
 * einen Bogen, dessen INNERER Punkt ein Endpunkt eines anderen Bandes ist, so liegt
 * dort eine Teilungsstelle: X wird an dieser Facettengrenze in Teilbänder zerlegt
 * (Bereiche [i..s1−1], [s1..s2−1], …, [sk..j]; jeder Bereich neu prüfen — Bereiche,
 * die scheitern, entfallen → ihre Facetten bleiben facettiert). Wiederholen bis nichts
 * mehr kippt (höchstens 20 Durchgänge).
 *
 * `taken` bleibt unberührt (wirkt nur zwischen Achsen).
 * → { bands, arcs, stats }  (Ids fortlaufend neu vergeben, arcs neu gebaut)
 */
function alignBands(bands, opts) {
  const o = { ...ARC_DEFAULTS, ...opts };
  const vkey = vtxKeyOf(o);
  let cur = (bands || []).slice();
  let aligned = 0;

  for (let pass = 0; pass < 20; pass++) {
    // breaks: Endpunkte ALLER Bogen-Segs ALLER Bänder
    const breaks = new Set();
    for (const b of cur) {
      for (const s of (b.segs || [])) {
        if (s.type !== 'arc' || !s.pts || s.pts.length < 2) continue;
        breaks.add(vkey(s.pts[0]));
        breaks.add(vkey(s.pts[s.pts.length - 1]));
      }
    }
    let changed = false;
    const next = [];
    for (const X of cur) {
      const src = X._src;
      if (!src || !src.chain || !src.chain.sides) { next.push(X); continue; }
      const { ctx, chain } = src;
      const i = src.i, j = src.j;
      const cuts = cutsOfBand(X, chain, i, j, breaks, vkey);
      if (!cuts.length) { next.push(X); continue; }
      changed = true;
      aligned += cuts.length;
      let a = i;
      for (const s of cuts) {
        if (s - 1 >= a) pushBand(ctx, chain, a, s - 1, next);
        a = s;
      }
      if (j >= a) pushBand(ctx, chain, a, j, next);
    }
    cur = next;
    if (!changed) break;
  }

  // Ids fortlaufend neu vergeben, arcs neu bauen, stats zählen
  for (let k = 0; k < cur.length; k++) cur[k].id = k;
  const arcs = new Map();
  let cyl = 0, cone = 0;
  for (const band of cur) {
    if (band.kind === 'cyl') cyl++; else cone++;
    const segs = band.segs || [];
    segs.forEach((seg, si) => {
      if (seg.type !== 'arc') return;
      const key = seg.arcKey;
      let rec = arcs.get(key);
      if (!rec) {
        rec = {
          key, pts: seg.pts, d: band.d, frame: band.frame,
          level: band.levels[seg.level], owners: [],
        };
        arcs.set(key, rec);
      }
      rec.owners.push({ band: band.id, seg: si });
    });
  }
  return { bands: cur, arcs, stats: { bands: cur.length, cyl, cone, aligned } };
}

/**
 * Bänder suchen (Schritte 1–5 ohne Nachbar-Prüfung).
 * fds: Array ebener Flächen { outer, inner, normal, centroid }
 * opts: { ...ARC_DEFAULTS, vtxKey (Pflicht), blocked (Set von Signaturen, optional) }
 * → { bands: Band[], arcs: Map<arcKey, Arc>, stats }
 */
export function findArcBands(fds, opts) {
  const o = { ...ARC_DEFAULTS, ...opts };
  const vkey = vtxKeyOf(o);
  const list = fds || [];
  const index = buildEdgeIndex(list, o);
  const axes = axisCandidates(list, o);
  const bands = [];
  const stats = { axes: axes.length, candidates: 0, chains: 0, bands: 0, cyl: 0, cone: 0 };
  const taken = new Set();                       // Facetten mit Band einer früheren Achse

  for (const d of axes) {
    const frame = makeFrame(d);
    const { facets, chains } = buildChains(list, d, frame, index, taken, o);
    stats.candidates += facets.size;
    stats.chains += chains.length;
    const ctx = { fds: list, frame, o, vkey, facInfo: facets };

    for (const chain of chains) {
      let work = chain;
      if (chain.cyclic) {
        // Vollkreis? → nichts anlegen (bleibt facettiert)
        const whole = tryBand(ctx, chain, 0, chain.facets.length - 1);
        if (whole) continue;
        // sonst an der Seitenkante nach der breitesten lo-Kante aufschneiden
        work = cutCycle(chain, widestFacet(ctx, chain));
      }

      // gierig teilen: größtes j ≥ i mit gültigem Band
      const m = work.facets.length;
      let i = 0;
      while (i < m) {
        let j = i, chk = tryBand(ctx, work, i, i);
        while (j + 1 < m) {
          const c = tryBand(ctx, work, i, j + 1);
          if (!c) break;
          j++; chk = c;
        }
        if (chk && chk.nSegs >= o.minSegs) {
          const made = makeBand(ctx, work, i, j, chk, bands.length);
          if (made) {
            const band = made.band;
            setBandSrc(band, ctx, work, i, j);
            bands.push(band);
            for (const fi of band.facets) taken.add(fi);
            stats.bands++;
            if (band.kind === 'cyl') stats.cyl++; else stats.cone++;
          }
          i = j + 1;
          continue;
        }
        i = i + 1;
      }
    }
  }

  // Teilungsstellen der Bänder angleichen (Bänder übereinanderliegender Ebenen)
  const al = alignBands(bands, o);
  stats.bands = al.stats.bands;
  stats.cyl = al.stats.cyl;
  stats.cone = al.stats.cone;
  stats.aligned = al.stats.aligned;
  return { bands: al.bands, arcs: al.arcs, stats };
}

// ── Nachbar-Prüfung (Schritt 5) ─────────────────────────────────────────────

/**
 * Exporter-Kantenschlüssel für fd.arcEdges — ZWEI Striche als Trenner (anders als
 * der Index-Schlüssel '|'): k1<k2 ? k1+'||'+k2 : k2+'||'+k1.
 */
export const edgeCanonKey = (vtxKey, a, b) => {
  const k1 = vtxKey(a), k2 = vtxKey(b);
  return k1 < k2 ? k1 + '||' + k2 : k2 + '||' + k1;
};

/**
 * Schritt 5: Nachbar-Prüfung bis zum Fixpunkt.
 *
 * Jeder Bogen eines Bands muss Kante für Kante an GENAU eine fremde Fläche grenzen:
 *   (a) ein anderes, noch gültiges Band mit demselben Polygonzug  → Typ 'band'
 *   (b) eine ebene Deckfläche ⟂ d (kein Band-Facet, kein circleRim/arcEdges)
 *       mit demselben Loop                                        → Typ 'cap'
 *   (c) sonst → das Band fällt weg; das invalidiert wiederum seine Nachbarn.
 *
 * fds: ebene Flächen; det: Ergebnis von findArcBands (wird mutiert) → det
 * Ergebnisse: det.bands (nur gültige), det.arcs (nur Bögen mit gültigen Eigentümern),
 * det.capEdits (je Bogen mit Typ 'cap' genau ein Eintrag), det.stats.valid.
 */
export function validateArcBands(fds, det, opts) {
  const o = { ...ARC_DEFAULTS, ...opts };
  const vkey = vtxKeyOf(o);
  const list = fds || [];
  const arcs = det.arcs instanceof Map ? det.arcs : new Map();
  det.arcs = arcs;
  const index = buildEdgeIndex(list, { ...o, skipCircleRim: true });

  // Facetten, die zu irgendeinem Band gehören (auch zu einem später verworfenen)
  const bandFacets = new Set();
  for (const b of det.bands || []) for (const fi of b.facets || []) bandFacets.add(fi);

  const hasRim = (fd) => {
    for (const L of [fd.outer, ...(fd.inner || [])]) if (L && L.circleRim) return true;
    return false;
  };

  // Typ eines Bogen-Segments bestimmen (null → Band ungültig)
  const classify = (band, seg, bandOf) => {
    const pts = seg.pts || [];
    const own = new Set(band.facets || []);
    const owners = [];
    for (let k = 0; k + 1 < pts.length; k++) {
      const ka = vkey(pts[k]), kb = vkey(pts[k + 1]);
      if (ka === kb) continue;
      const foreign = (index.get(edgeKeyOf(ka, kb)) || []).filter((e) => !own.has(e.fi));
      if (foreign.length !== 1) return null;                 // 0 oder ≥2 fremde Eigentümer
      owners.push(foreign[0]);
    }
    if (!owners.length) return null;

    // (a) Nachbar-Band: alle fremden Eigentümer gehören zu EINEM gültigen Band B
    const nb = bandOf.get(owners[0].fi);
    if (nb && nb !== band && owners.every((e) => bandOf.get(e.fi) === nb)) {
      const rec = arcs.get(seg.arcKey);
      if (rec && (rec.owners || []).some((ow) => ow.band === nb.id)) {
        return { type: 'band', band: nb };
      }
    }

    // (b) Deckfläche: alle fremden Eigentümer = dieselbe Fläche, derselbe Loop
    const fi = owners[0].fi, li = owners[0].li;
    if (owners.every((e) => e.fi === fi && e.li === li)) {
      const fd = list[fi];
      if (fd && !bandFacets.has(fi) && !hasArcEdges(fd) && !hasRim(fd)) {
        const nn = fd.normal ? norm(fd.normal) : null;
        if (nn && len(nn) > 0 && Math.abs(dot(nn, band.d)) >= o.capCos) {
          return { type: 'cap', cap: { fi, li } };
        }
      }
    }
    return null;
  };

  // Fixpunkt: ungültige Bänder entfernen und wiederholen
  let valid = (det.bands || []).slice();
  for (;;) {
    const bandOf = new Map();
    for (const b of valid) for (const fi of b.facets || []) bandOf.set(fi, b);
    const bad = new Set();
    for (const band of valid) {
      for (const seg of band.segs || []) { seg.adjType = null; seg.cap = null; seg.adjBand = null; }
      let ok = true;
      for (const seg of band.segs || []) {
        if (seg.type !== 'arc') continue;
        const r = classify(band, seg, bandOf);
        if (!r) { ok = false; break; }
        seg.adjType = r.type;
        if (r.type === 'cap') seg.cap = r.cap; else seg.adjBand = r.band.id;
      }
      if (!ok) bad.add(band.id);
    }
    if (!bad.size) break;
    valid = valid.filter((b) => !bad.has(b.id));
  }

  // Marker der verworfenen Bänder entfernen
  const keep = new Set(valid);
  for (const b of det.bands || []) {
    if (keep.has(b)) continue;
    for (const seg of b.segs || []) { seg.adjType = null; seg.cap = null; seg.adjBand = null; }
  }
  det.bands = valid;

  // Bögen ohne gültige Eigentümer entfernen, Eigentümer bereinigen
  const ids = new Set(valid.map((b) => b.id));
  for (const [key, rec] of [...arcs]) {
    rec.owners = (rec.owners || []).filter((ow) => ids.has(ow.band));
    if (!rec.owners.length) arcs.delete(key);
  }

  // Deckflächen-Änderungen: je Bogen mit Typ 'cap' genau ein Eintrag
  const capEdits = [];
  const seen = new Set();
  for (const band of valid) {
    for (const seg of band.segs || []) {
      if (seg.type !== 'arc' || seg.adjType !== 'cap' || !seg.cap) continue;
      if (seen.has(seg.arcKey)) continue;
      const rec = arcs.get(seg.arcKey);
      if (!rec || !rec.pts || rec.pts.length < 2) continue;
      seen.add(seg.arcKey);
      capEdits.push({
        fi: seg.cap.fi, li: seg.cap.li, arcKey: seg.arcKey,
        a: rec.pts[0], b: rec.pts[rec.pts.length - 1], pts: rec.pts,
      });
    }
  }
  det.capEdits = capEdits;
  det.stats = det.stats || {};
  det.stats.valid = valid.length;
  return det;
}

// ── Anwendung ───────────────────────────────────────────────────────────────

/**
 * Inneren Abschnitt eines Bogens aus einem Loop entfernen.
 * Die inneren Punkte (ohne Endpunkte) müssen GENAU der zusammenhängende Abschnitt
 * zwischen a und b sein — in einer der beiden Laufrichtungen.
 * → neue Punktliste (Original unverändert)
 */
function removeArcPoints(L, ce, vkey) {
  const n = L.length;
  const ka = vkey(ce.a), kb = vkey(ce.b);
  let ia = -1, ib = -1;
  for (let i = 0; i < n; i++) {
    const k = vkey(L[i]);
    if (ia < 0 && k === ka) ia = i;
    if (ib < 0 && k === kb) ib = i;
  }
  if (ia < 0 || ib < 0 || ia === ib) {
    throw new Error('applyArcBands: Bogen-Endpunkte nicht (eindeutig) im Loop ' + ce.li);
  }
  const inner = (ce.pts || []).slice(1, -1).map(vkey);
  const section = (from, to) => {
    const idx = [];
    let i = (from + 1) % n;
    while (i !== to) {
      idx.push(i);
      i = (i + 1) % n;
      if (idx.length > n) break;
    }
    return idx;
  };
  const same = (idx, seq) => idx.length === seq.length && idx.every((i, k) => vkey(L[i]) === seq[k]);
  const fwd = section(ia, ib);
  const bwd = section(ib, ia);
  let del = null;
  if (same(fwd, inner)) del = fwd;
  else if (same(bwd, inner.slice().reverse())) del = bwd;
  if (!del) throw new Error('applyArcBands: Bogen-Abschnitt passt nicht zum Loop ' + ce.li);
  const rm = new Set(del);
  return L.filter((_, i) => !rm.has(i));
}

/**
 * Bänder anwenden: alle Band-Facetten entfernen, die Deckflächen glätten
 * (Polygonzug des Bogens → Bogen-Kante in fd.arcEdges).
 * Das Original wird NICHT mutiert.
 * → { fds: neue Liste, removed: Set<fi> }
 */
export function applyArcBands(fds, det, opts) {
  const o = { ...ARC_DEFAULTS, ...opts };
  const vkey = vtxKeyOf(o);
  const list = fds || [];
  const removed = new Set();
  for (const b of det.bands || []) for (const fi of b.facets || []) removed.add(fi);
  const editsByFi = new Map();
  for (const ce of det.capEdits || []) {
    if (!editsByFi.has(ce.fi)) editsByFi.set(ce.fi, []);
    editsByFi.get(ce.fi).push(ce);
  }
  const out = [];
  list.forEach((fd, fi) => {
    if (removed.has(fi)) return;
    const edits = editsByFi.get(fi);
    if (!edits || !edits.length) { out.push(fd); return; }
    const loops = [fd.outer, ...(fd.inner || [])];
    const newLoops = loops.map((L) => (L && L.length ? L.slice() : L));
    const arcEdges = new Map();
    for (const ce of edits) {
      const L = newLoops[ce.li];
      if (!L || !L.length) throw new Error('applyArcBands: Loop ' + ce.li + ' fehlt');
      newLoops[ce.li] = removeArcPoints(L, ce, vkey);
      arcEdges.set(edgeCanonKey(vkey, ce.a, ce.b), ce.arcKey);
    }
    out.push({
      ...fd,
      outer: newLoops[0],
      inner: fd.inner ? newLoops.slice(1) : fd.inner,
      arcEdges,
      untouched: false,
    });
  });
  return { fds: out, removed };
}

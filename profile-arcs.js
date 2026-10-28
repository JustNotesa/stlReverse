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
//      maxSegDeg, gleicher Drehsinn, ≥ minSegs Segmente. VORAUSSCHAU: reicht das Band ab der
//      nächsten Facette weiter, gehört die aktuelle Facette nicht zum Band (breite ebene
//      Profilseite vor einem fein facettierten Bogen → FAKE-Band) und wird übersprungen.
//      Ein gültiger VOLLKREIS (geschlossene Kette, ganzer Ring besteht als Band) wird in DREI
//      Bänder geteilt (Schnitt an den Mantellinien mit den Polarwinkeln 0, 2π/3, 4π/3) — zwei
//      Halbkreise hätten dieselben zwei Endpunkte und würden sich in fd.arcEdges überschreiben.
//      Ringe, die sich eine Ebene teilen
//      (Zylinder + Fasen-Kegel), bilden einen STAPEL: der Schnitt wird für den ganzen Stapel
//      GEMEINSAM gewählt (eine Winkelstelle, an der JEDER Ring eine Mantellinie hat) — sonst
//      lägen die Schnitte der Ringe auseinander und die Bögen passten nicht mehr aufeinander.
//      Ringe ohne Stapel schneiden über ein REGISTER (je Achse: die Schnittpunkte der schon
//      geteilten Ringe) an derselben Kante.
//   4. Rand des Bands = Vereinigung der gerichteten Facetten-Kanten (innere heben sich auf) → genau
//      ein Loop aus Bogen unten, Seite, Bogen oben, Seite. same_sense aus den Facetten-Normalen
//      (alle müssen zur STEP-Flächennormale gleich stehen).
//   5. Nachbar-Prüfung bis zum Fixpunkt: jeder Bogen grenzt Kante für Kante an GENAU eine ebene
//      Fläche ⟂ d (eine Loop) oder an genau ein anderes gültiges Band (gleicher Polygonzug). Sonst
//      fällt das Band weg (und mit ihm abhängige Bänder) → bleibt facettiert.
//   6. alignBands: Teilungsstellen der Bänder übereinanderliegender Ebenen angleichen (ein Band
//      wird an den Bogen-ENDpunkten der Nachbarbänder zerschnitten). Ein Reststück, das auf den
//      Kreisen des Eltern-Bands liegt und an beiden Enden Mantellinien hat, bleibt dabei ein Band
//      (sonst bliebe seine Facette facettiert und der Nachbarbogen fände keinen Nachbarn).
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
  budgetMs: 2500,      // ms: Zeitbudget für findArcBands (Kettenverarbeitung stoppen)
  maxAxes: 6,          // Achsen-Kandidaten je Export höchstens so viele - die mit den meisten Deckflächen-Punkten; ein feines Kugelnetz lieferte 49 Achsen und je Achse einen vollen Durchlauf aller Facetten
  noiseTol: 5e-4,      // mm: Rausch-Untergrenze der Pfeilhoehen-Pruefung, Netzpunkte sind auf ~1e-4 gerundet
  blockedGroups: null,  // Set von Normalgruppen, deren Wände NICHT in Bänder geteilt werden dürfen
                        // (Wände, die die Primitive-Pfade (Mantel/Bohrung) beanspruchen)
};

// Zeitmessung (Budget) — performance.now() mit Fallback auf Date.now()
const nowMs = () => (typeof performance !== 'undefined' && performance &&
  typeof performance.now === 'function') ? performance.now() : Date.now();

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

/**
 * Kreis-Fit mehrerer Ebenen mit GEMEINSAMER Mitte (spec-T2d):
 * eine Mitte c, je Ebene ein eigener Radius r_l.
 *
 * Der Einzelfit einer kurzen Ebene ist entlang der Mittelsenkrechten schlecht
 * bestimmt (Fehler ∝ Rauschen / Bogenwinkel) — der gemeinsame Fit über alle
 * Ebenen nutzt die Kopplung der Radien (bei einem Kegel: R_lo − R_hi genau
 * bekannt) und liefert eine viel bessere Mitte.
 *
 * Algebraisch (linear): u² + v² = 2·cu·u + 2·cv·v + k_l  (k_l = r_l² − |c|²)
 * → kleinste Quadrate über (2cu, 2cv, k_1..k_L) mit der Design-Matrix
 *   [u, v, e_l] (die Punkte vorher um den Gesamtschwerpunkt verschoben und
 *   skaliert wie in fitCircle2d), gelöst per Householder-QR. Die QR ist stabiler
 *   als die Normalgleichungen — bei kurzen Bögen ist das System stark
 *   konditioniert (quadrierte Kondition), die Normalgleichungen verlieren dort
 *   alle Genauigkeit.
 * Danach bis zu 12 Gauss-Newton-Schritte geometrisch (Residuen |p − c| − r_l,
 * Unbekannte (cu, cv, r_1..r_L)); ein Schritt wird nur übernommen, wenn er die
 * Quadratsumme der Residuen verkleinert — sonst bleibt die algebraische
 * Schätzung stehen.
 *
 * levels: [[ [u,v],… ], …] (je Ebene ≥ 2 Punkte)
 * → { c:[u,v], r:[r_l], maxRes } | null (zu wenig Punkte, singulär, unbrauchbare Radien)
 */
export function fitCoaxial2d(levels) {
  const Lv = [];
  for (const lv of (levels || [])) if (lv && lv.length >= 2) Lv.push(lv);
  if (!Lv.length) return null;
  const L = Lv.length;
  let n = 0;
  for (const lv of Lv) n += lv.length;
  if (n < 3) return null;

  // Schwerpunkt + Skalierung (wie fitCircle2d — sonst Kasa gegen große Werte)
  let mx = 0, my = 0;
  for (const lv of Lv) for (const p of lv) {
    if (!p || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) return null;
    mx += p[0]; my += p[1];
  }
  mx /= n; my /= n;
  let scale = 0;
  for (const lv of Lv) for (const p of lv) scale = Math.max(scale, Math.hypot(p[0] - mx, p[1] - my));
  if (!(scale > 0) || !Number.isFinite(scale)) return null;
  const N = Lv.map((lv) => lv.map((p) => [(p[0] - mx) / scale, (p[1] - my) / scale]));

  // ── algebraisch: kleinste Quadrate über (2cu, 2cv, k_1..k_L) ───────────────
  //    |p|² = 2·cu·p_x + 2·cv·p_y + k_l  →  [p_x, p_y, e_l] · (2cu, 2cv, k_l)
  const dim = 2 + L;
  const A = [], B = [];
  for (let l = 0; l < L; l++) {
    for (const p of N[l]) {
      const row = new Array(dim).fill(0);
      row[0] = p[0]; row[1] = p[1]; row[2 + l] = 1;
      A.push(row);
      B.push(p[0] * p[0] + p[1] * p[1]);
    }
  }
  const sol = lstsqQr(A, B, 1e-15);
  if (!sol) return null;
  let cu = sol[0] / 2, cv = sol[1] / 2;
  if (!Number.isFinite(cu) || !Number.isFinite(cv)) return null;
  let rr = new Array(L);
  let algOk = true;
  for (let l = 0; l < L; l++) {
    const r2 = sol[2 + l] + cu * cu + cv * cv;
    if (!(r2 > 0) || !Number.isFinite(r2)) { algOk = false; break; }
    rr[l] = Math.sqrt(r2);
  }
  if (!algOk) {
    // Radius imaginär → die algebraische Schätzung ist unbrauchbar (Zentrum zu
    // weit vom Bogen). Radien aus den Abständen zum Zentrum schätzen und dem
    // Gauss-Newton die Korrektur überlassen.
    for (let l = 0; l < L; l++) {
      let s = 0;
      for (const p of N[l]) s += Math.hypot(cu - p[0], cv - p[1]);
      const r = s / N[l].length;
      if (!(r > 0) || !Number.isFinite(r)) return null;
      rr[l] = r;
    }
  }

  // ── Gauss-Newton (geometrisch: ‖p − c‖ − r_l minimieren) ───────────────────
  const cost = (cx, cy, rad) => {
    let s = 0;
    for (let l = 0; l < L; l++) {
      for (const p of N[l]) {
        const d = Math.hypot(cx - p[0], cy - p[1]);
        if (!Number.isFinite(d)) return Infinity;
        const e = d - rad[l];
        s += e * e;
      }
    }
    return s;
  };
  let costNow = cost(cu, cv, rr);
  for (let it = 0; it < 12; it++) {
    const J = [], res = [];
    let bad = false;
    for (let l = 0; l < L; l++) {
      for (const p of N[l]) {
        const dx = cu - p[0], dy = cv - p[1];
        const dist = Math.hypot(dx, dy);
        if (!(dist > 0)) { bad = true; break; }
        const row = new Array(dim).fill(0);
        row[0] = dx / dist; row[1] = dy / dist; row[2 + l] = -1;
        J.push(row);
        res.push(-(dist - rr[l]));         // Ziel: J·δ = −Residuum
      }
      if (bad) break;
    }
    if (bad) break;
    const ds = lstsqQr(J, res, 1e-15);
    if (!ds) break;                       // singulär: algebraische Schätzung behalten
    const cu2 = cu - ds[0], cv2 = cv - ds[1];
    const rr2 = rr.map((r, l) => r - ds[2 + l]);
    if (!Number.isFinite(cu2) || !Number.isFinite(cv2)) break;
    if (!rr2.every((r) => r > 0 && Number.isFinite(r))) break;
    const c2 = cost(cu2, cv2, rr2);
    if (!(c2 < costNow)) break;            // Schritt verschlechtert → stehen bleiben
    cu = cu2; cv = cv2; rr = rr2; costNow = c2;
  }

  // zurück in die Ausgangskoordinaten
  const cxO = cu * scale + mx, cyO = cv * scale + my;
  if (!Number.isFinite(cxO) || !Number.isFinite(cyO)) return null;
  const rO = rr.map((r) => r * scale);
  let maxRes = 0;
  for (let l = 0; l < L; l++) {
    for (const p of Lv[l]) {
      const e = Math.abs(Math.hypot(p[0] - cxO, p[1] - cyO) - rO[l]);
      if (!Number.isFinite(e)) return null;
      if (e > maxRes) maxRes = e;
    }
  }
  return { c: [cxO, cyO], r: rO, maxRes };
}

/**
 * Kleinste Quadrate A·x ≈ b (A: m×n, m ≥ n) per Householder-QR.
 * Die Spalten werden nicht umgeordnet; die Matrix gilt als singulär, wenn ein
 * R-Diagonalelement kleiner als tol·|R₀₀| ist (relativ, Standard 1e-15) oder
 * eine Spalte Null ist. Gegenüber den Normalgleichungen bleibt die Genauigkeit
 * auch bei stark konditionierten Systemen erhalten (kein Quadrieren der
 * Konditionszahl).
 * → x (Länge n) | null
 */
function lstsqQr(A, b, tol = 1e-15) {
  const m = A.length;
  if (!m || !b || b.length !== m) return null;
  const n = A[0].length;
  if (m < n || !n) return null;
  const R = new Array(m);
  for (let i = 0; i < m; i++) {
    if (!A[i] || A[i].length !== n) return null;
    R[i] = A[i].slice();
  }
  const y = b.slice();
  let ref = 0;
  for (let k = 0; k < n; k++) {
    let nrm = 0;
    for (let i = k; i < m; i++) nrm += R[i][k] * R[i][k];
    nrm = Math.sqrt(nrm);
    if (!(nrm > 0)) return null;                    // Null-Spalte
    if (k === 0) ref = nrm;
    const alpha = R[k][k] > 0 ? -nrm : nrm;
    const v = new Array(m - k);
    for (let i = k; i < m; i++) v[i - k] = R[i][k];
    v[0] -= alpha;
    let vv = 0;
    for (let i = k; i < m; i++) vv += v[i - k] * v[i - k];
    if (!(vv > 0)) continue;                       // Householder trivial
    for (let j = k; j < n; j++) {
      let s = 0;
      for (let i = k; i < m; i++) s += v[i - k] * R[i][j];
      const f = (2 * s) / vv;
      for (let i = k; i < m; i++) R[i][j] -= f * v[i - k];
    }
    let s = 0;
    for (let i = k; i < m; i++) s += v[i - k] * y[i];
    const f = (2 * s) / vv;
    for (let i = k; i < m; i++) y[i] -= f * v[i - k];
    if (!(Math.abs(R[k][k]) > tol * ref)) return null;   // singulär (relativ)
  }
  const x = new Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = y[r];
    for (let k = r + 1; k < n; k++) s -= R[r][k] * x[k];
    x[r] = s / R[r][r];
    if (!Number.isFinite(x[r])) return null;
  }
  return x;
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
 * „alle Unten- und Oben-Punkte je auf einem Kreis”).
 *
 * Der Vergleich läuft über die PFEILHÖHE, nicht über den Umkreis-Radius: bei feiner
 * Facettierung (Sehne 0.05 mm) ist das Dreieck A-B-C fast entartet — sein Umkreis-
 * Radius schwankt zwischen 2.4 und 3.7, obwohl alle drei Punkte auf 6e-5 genau auf
 * R=3 liegen (der Radius folgt aus h ∝ 1/Fehler der Pfeilhöhe). Der Abstand des
 * mittleren Punktes B von der Sehne AC ist dagegen robust: er muss der erwarteten
 * Pfeilhöhe auf dem Fit-Kreis entsprechen.
 *
 * Ein gemischter Lauf (lange Gerade + Bogen) fällt weiterhin durch: die lange Sehne
 * erwartet eine große Pfeilhöhe, gemessen wird ~0. Kollineare Tripel sind damit kein
 * Sonderfall mehr (h = 0 ≪ hx).
 *
 * UNGLEICHMÄSSIGE SEGMENTE: die Formel r − sqrt(r² − L²/4) gilt nur, wenn B in der
 * SEHNENMITTE liegt (gleichmäßige Segmente). Bei ungleichmäßigen Segmenten (Dreiecks-
 * fächer mit halben Randsegmenten) sitzt B seitlich → die erwartete Pfeilhöhe wird an
 * der Stelle von B ausgewertet: der Kreispunkt an der Sehnen-Lage x liegt um
 * sqrt(r² − x²) von der Sehne weg, der Kreismittelpunkt um s = sqrt(r² − L²/4) →
 * hx = sqrt(r² − x²) − s (bei x = 0 identisch mit r − sqrt(r² − L²/4)).
 *
 * noiseTol (mm): Rausch-Untergrenze der Toleranz — die Netzpunkte sind auf ~1e-4
 * gerundet, das Rauschen der Pfeilhöhe ist entsprechend groß.
 */
export function oneCircle(pts2d, K, tolAbs, tolRel, noiseTol) {
  const nt = Number.isFinite(noiseTol) ? noiseTol : 0;
  const r = K.r;
  for (let i = 0; i + 2 < pts2d.length; i++) {
    const A = pts2d[i], B = pts2d[i + 1], C = pts2d[i + 2];
    const dx = C[0] - A[0], dy = C[1] - A[1];
    const L = Math.hypot(dx, dy);
    if (L === 0) return false;                          // entartetes Tripel
    if (L / 2 > r) return false;                       // Sehne länger als der Durchmesser
    const h = Math.abs(dx * (B[1] - A[1]) - dy * (B[0] - A[0])) / L;   // Abstand B → Gerade AC
    // Lage von B längs der Sehne: M = Mitte AC, e = Richtung AC, x = (B − M)·e
    // (x = 0 → B in der Sehnenmitte, |x| ≤ L/2 → B zwischen A und C)
    const ex = dx / L, ey = dy / L;
    const x = (B[0] - (A[0] + C[0]) / 2) * ex + (B[1] - (A[1] + C[1]) / 2) * ey;
    if (Math.abs(x) >= r) return false;                // B liegt nicht mehr auf dem Kreis
    // Abstand Mittelpunkt → Sehne (s) und erwartete Pfeilhöhe an der Stelle von B
    const s = Math.sqrt(Math.max(0, r * r - (L * L) / 4));
    const hx = Math.sqrt(r * r - x * x) - s;
    const tol = Math.max(nt, hx * Math.max(tolAbs / r, tolRel));
    if (Math.abs(h - hx) > tol) return false;
  }
  return true;
}

/**
 * Ist die Seitenkante s eine Mantellinie (Ruling)? Lo- und Hi-Punkt müssen den
 * gleichen Polarwinkel haben (jeweils um die Mitte ihres Kreises) — dann ist die
 * Kante eine Gerade der Band-Fläche (LINE-Kante im STEP-Band).
 */
function sideIsRuling(frame, side, cLo, cHi, rMax, tol) {
  if (!side) return false;
  const a = toLocal(frame, side[0]), b = toLocal(frame, side[1]);
  const pa = Math.atan2(a[1] - cLo[1], a[0] - cLo[0]);
  const pb = Math.atan2(b[1] - cHi[1], b[0] - cHi[0]);
  let dphi = pa - pb;
  while (dphi > Math.PI) dphi -= 2 * Math.PI;
  while (dphi < -Math.PI) dphi += 2 * Math.PI;
  return Math.abs(dphi) * rMax <= tol;
}

/**
 * Prüft, ob die Facetten i..j der Kette ein Band ergeben (Schritt 3):
 * beide Läufe auf je einen Kreis, koaxial, die beiden END-Seitenkanten =
 * Mantellinien, Segmentwinkel klein und gleich gerichtet.
 * → { loPts, hiPts, Klo, Khi, tol, nSegs, tlo, thi, endsOk, startOk, endOk } | null
 *    { insufficient: true } → noch zu wenige Punkte (Band erst ab mehr Facetten)
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
  if (loPts.length < 3 || hiPts.length < 3) return { insufficient: true, nSegs: -1 };
  const lo2d = loPts.map((p) => { const l = toLocal(frame, p); return [l[0], l[1]]; });
  const hi2d = hiPts.map((p) => { const l = toLocal(frame, p); return [l[0], l[1]]; });
  const Klo = fitCircle2d(lo2d), Khi = fitCircle2d(hi2d);
  if (!Klo || !Khi) return null;
  const rMax = Math.max(Klo.r, Khi.r);
  const tol = Math.max(o.tolFitAbs, o.tolFitRel * rMax);
  if (Klo.maxRes > tol || Khi.maxRes > tol) return null;
  if (Math.hypot(Klo.c[0] - Khi.c[0], Klo.c[1] - Khi.c[1]) > tol) return null;
  // Sehnenzug EINES Kreises (Pfeilhöhe je drei Punkte passt zum Fit-Radius)
  if (!oneCircle(lo2d, Klo, o.tolFitAbs, o.tolFitRel, o.noiseTol)) return null;
  if (!oneCircle(hi2d, Khi, o.tolFitAbs, o.tolFitRel, o.noiseTol)) return null;
  // Seitenkanten: NUR die beiden END-Kanten (sides[i], sides[j+1]) werden
  // LINE-Kanten des Bandes → sie müssen Mantellinien sein. Die inneren
  // Seitenkanten verschwinden beim Umwandeln in die Fläche — bei einem
  // Dreiecksfächer sind sie schräg und deshalb unkritisch.
  const startOk = sideIsRuling(frame, sides[i], Klo.c, Khi.c, rMax, tol);
  const endOk = sideIsRuling(frame, sides[j + 1], Klo.c, Khi.c, rMax, tol);
  const endsOk = startOk && endOk;
  // Segmentwinkel: gleiches Vorzeichen in beiden Läufen
  const maxAng = o.maxSegDeg * Math.PI / 180;
  const sLo = chainAngleSign(lo2d, Klo.c, maxAng);
  if (!sLo) return null;
  if (chainAngleSign(hi2d, Khi.c, maxAng) !== sLo) return null;
  return {
    loPts, hiPts, Klo, Khi, tol, rMax,
    nSegs: Math.max(loPts.length - 1, hiPts.length - 1),
    tlo: tlo / cnt, thi: thi / cnt,
    endsOk, startOk, endOk,
  };
}

/**
 * Band-Suche ab Startfacette i — gallopingend statt linear.
 *
 * "gültig" = tryBand liefert ein echtes Band (nicht null, nicht 'insufficient').
 * Die Gültigkeit gilt als monoton: 'insufficient' (zu wenige Punkte) nur am
 * Anfang, danach entweder gültig bis zum Ende der Kette oder ein Fehlschlag.
 * Deshalb:
 *   1. Galloping  j = i+1, i+2, i+4, i+8, … (bei m−1 gedeckelt) bis zum ersten
 *      Fehlschlag → letzter Erfolg / erster Fehlschlag als Grenzen.
 *   2. Binärsuche zwischen diesen Grenzen → größtes gültiges j.
 *   3. Kandidat: größtes gültiges j mit endsOk UND nSegs ≥ minSegs; sonst bis zu
 *      8 Schritte zurück (die beiden Band-Enden müssen Mantellinien sein).
 * → { chk, j } | null
 */
function scanBandFrom(ctx, chain, i, m) {
  const o = ctx.o;
  const cache = new Map();
  const probe = (j) => {
    let r = cache.get(j);
    if (!r) {
      const c = tryBand(ctx, chain, i, j);
      // Ein Fehlschlag mit weniger als minSegs Facetten ist UNBESTIMMT ('few'), nicht 'bad':
      // die erste Probe j = i+1 hat nur 2 Facetten (3 Punkte je Ebene) — der 3-Punkte-Kreis
      // ist exakt, aber seine Mitte so rauschempfindlich, dass die Koaxial-Prüfung
      // scheitert. 'bad' bräche die Galopp-Suche ab, obwohl tryBand(i, i+3) gültig ist.
      const few = (j - i + 1) < o.minSegs;
      r = { st: !c ? (few ? 'few' : 'bad') : (c.insufficient ? 'few' : 'ok'), c };
      cache.set(j, r);
    }
    return r;
  };

  // 1. Galloping — erster Fehlschlag bricht ab
  let lastOk = -1, firstBad = -1, firstChk = null;
  for (let j = i + 1, step = 1; j <= m - 1;) {
    const p = probe(j);
    if (p.st === 'ok') {
      if (!firstChk) {
        firstChk = p.c;
        // Start-Seitenkante muss Mantellinie sein — sonst beginnt hier kein Band
        if (!firstChk.startOk) return null;
      }
      lastOk = j;
    } else if (p.st === 'bad') { firstBad = j; break; }
    if (j >= m - 1) break;
    j = Math.min(m - 1, j + step);
    step *= 2;
  }

  // 2. Binärsuche: größtes gültiges j (a: gültig bzw. Sentinel i, b: ungültig/Ende)
  let a = lastOk >= 0 ? lastOk : i;
  let b = firstBad >= 0 ? firstBad : m;
  while (b - a > 1) {
    const mid = a + ((b - a) >> 1);
    if (probe(mid).st === 'ok') a = mid; else b = mid;
  }
  if (a <= i) return null;                       // kein gültiges Band ab i

  // 3. Kandidat: endsOk (Mantellinien an beiden Enden) + genug Segmente
  for (let d = 0; d <= 8; d++) {
    const j = a - d;
    if (j < i) break;
    const p = probe(j);
    if (p.st !== 'ok') continue;
    if (p.c.endsOk && p.c.nSegs >= o.minSegs) return { chk: p.c, j };
  }
  return null;
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

  // Gehört die Wand zu einem ERKANNTEN Primitive (Zylinder-Bohrung / -Mantel), darf der
  // Bogen-Pfad sie nicht übernehmen: der Primitive-Pfad hat über diese Wand entschieden —
  // er hat sie umgewandelt oder bewusst verworfen (Delle, verdrillte Wand, zu dünner Steg,
  // Rand an der Plattenkante, Konkavität). Seine Gates sind strenger als die des Bogen-Pfads:
  // der Bogen-Pfad würde die Wand trotzdem analytisch machen (Delle geglättet) und dabei
  // eine Kreis-Kante erzeugen, die den Nachbarn schneidet.
  if (o.blockedGroups && o.blockedGroups.size) {
    for (const fi of facets) {
      const fd = fds[fi];
      if (fd && fd.group && o.blockedGroups.has(fd.group)) return null;
    }
  }

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

/** Kürzester Winkelabstand zweier Winkel (rad) */
function angDist(a, b) {
  let d = Math.abs(a - b);
  if (d > Math.PI) d = 2 * Math.PI - d;
  return d;
}

/**
 * Grenzt die Ring-Wand an dieser Ebene (lo/hi) an eine ebene DECKFLÄCHE (Normale ⟂ d)?
 * Dann steht die Wand dort frei auf einer Deckfläche (ein Zylinder/Kegel zwischen zwei
 * Deckflächen); grenzt sie an eine andere Wand (Normale nicht ⟂ d), läuft der Ring in
 * einem Ring-Stapel weiter (z. B. Bohrung mit Fase an beiden Enden).
 * → true: an dieser Ebene liegt eine Deckfläche an
 */
function ringLevelHasDeck(ctx, chain, level) {
  const { fds, frame, o, vkey, facInfo, index } = ctx;
  if (!index) return false;
  const inChain = new Set(chain.facets);
  for (const fi of chain.facets) {
    const fd = fds[fi];
    const info = facInfo.get(fi);
    if (!fd || !info) continue;
    const runs = facetRuns(fd, info, vkey);
    if (!runs) continue;
    const run = level === 'lo' ? runs.loRun : runs.hiRun;
    if (!run || run.length < 2) continue;
    for (let k = 0; k + 1 < run.length; k++) {
      const ka = vkey(run[k]), kb = vkey(run[k + 1]);
      if (ka === kb) continue;
      const owners = index.get(edgeKeyOf(ka, kb)) || [];
      for (const ow of owners) {
        if (inChain.has(ow.fi)) continue;               // die Wand selbst
        const ofd = fds[ow.fi];
        if (!ofd || !ofd.normal) continue;
        const nn = norm(ofd.normal);
        if (len(nn) > 0 && Math.abs(dot(nn, frame.d)) >= o.capCos) return true;   // Deckfläche
      }
    }
  }
  return false;
}

/**
 * Einen gültigen VOLLRING (zyklische Kette, der ganze Ring besteht als Band) in
 * DREI Bänder teilen.
 *
 * Warum drei und nicht zwei: zwei Halbkreise hätten dieselben zwei Endpunkte — ihre
 * Bogen-Kanten bekämen in der Deckfläche denselben Kanten-Schlüssel edgeCanonKey(a,b)
 * und würden sich in fd.arcEdges überschreiben.
 *
 * Die drei Schnitte liegen an den MANTELLINIEN mit den Polarwinkeln 0, 2π/3 und 4π/3
 * (KANONISCHE Winkel, nicht die „breiteste Facette“).
 *
 * ÜBEREINANDERLIEGENDE RINGE (STAPEL: gleiche Achse, gemeinsame Ebene): die Schnitt-
 * wahl erfolgt GEMEINSAM für den ganzen Stapel (stackCutPlan) — nur eine Winkelstelle,
 * an der JEDER Ring eine Mantellinie hat. Sonst schneidet jeder Ring an seiner eigenen
 * Stelle (der Ring mit dem Dreiecksfächer schneidet neben dem Schnitt des Nachbarrings)
 * und die Bögen passen nicht mehr aufeinander (andere Polygonzüge → anderer arcKey) →
 * validateArcBands verwirft die Bänder.
 *
 * REGISTER (je Achse, `reg`): die Schnittpunkte der bereits geteilten Ringe (vkey der
 * lo- und hi-Punkte ihrer Schnitt-Seitenkanten). Ein Ring, der an einer Stelle NICHT
 * mehr eine Mantellinie hat (Fasen-Fächer: die Seitenkanten der Fächer-Dreiecke sind
 * schräg), fände sonst die NÄCHSTE Mantellinie zum Zielwinkel — eine Facette neben dem
 * Schnitt des Nachbarrings. Deshalb wird zuerst unter den Mantellinien gesucht, deren
 * lo-/hi-Punkt im Register steht (d. h. die Schnittkante ist dieselbe Kante wie bei
 * einem früheren Ring desselben Stapels — die Ringe teilen sich den Kreis an der
 * Bandgrenze); nur wenn keine solche Mantellinie im Zielwinkel-Fenster (≤ 30°) liegt,
 * gilt die nächste Mantellinie zum Zielwinkel.
 *
 * Scheitert einer der drei Teile (oder sind die drei Schnitte nicht verschieden), wird
 * der ganze Ring wie bisher übersprungen — es entstehen KEINE Teil-Bänder eines Rings.
 *
 * Die Schnitte werden NACH KETTEN-INDEX sortiert (die Winkelreihenfolge 0, 2π/3, 4π/3
 * gilt nur für die Auswahl der Schnittkante, nicht für die Reihenfolge der Teile).
 *
 * → true (der Ring ist in drei Bändern aufgeteilt) | false (Ring unverändert lassen)
 */
/**
 * Schnitt-Kandidaten eines Vollrings: die Seitenkanten der Kette, die Mantellinien
 * sind, mit ihrem Polarwinkel (0 … 2π) und den vkeys ihrer lo-/hi-Punkte.
 * → [{ k, phi, loKey, hiKey }]
 */
function ringCandidates(ctx, chain, whole) {
  const { frame, vkey } = ctx;
  const c = whole.Klo.c;
  const out = [];
  for (let k = 0; k < chain.facets.length; k++) {
    const side = chain.sides[k];
    if (!side) continue;
    if (!sideIsRuling(frame, side, whole.Klo.c, whole.Khi.c, whole.rMax, whole.tol)) continue;
    const l = toLocal(frame, side[0]);
    let phi = Math.atan2(l[1] - c[1], l[0] - c[0]);
    if (phi < 0) phi += 2 * Math.PI;
    if (phi >= 2 * Math.PI) phi -= 2 * Math.PI;
    out.push({ k, phi, loKey: vkey(side[0]), hiKey: vkey(side[1]) });
  }
  return out;
}

/**
 * Ring-Info für die STAPEL-Schnittwahl: die Mantellinien des Rings (ringCandidates)
 * je Ebene indexiert (lo- bzw. hi-Vertex → Mantellinie) und die Vertex-Mengen der
 * beiden Ebenen (zur Erkennung gemeinsamer Ebenen).
 */
function ringInfo(ctx, chain, whole) {
  const { vkey } = ctx;
  const cands = ringCandidates(ctx, chain, whole);
  const byLo = new Map(), byHi = new Map();
  for (const cd of cands) {
    if (!byLo.has(cd.loKey)) byLo.set(cd.loKey, cd);
    if (!byHi.has(cd.hiKey)) byHi.set(cd.hiKey, cd);
  }
  const loKeys = new Set((whole.loPts || []).map(vkey));
  const hiKeys = new Set((whole.hiPts || []).map(vkey));
  return {
    chain, whole, cands, byLo, byHi, loKeys, hiKeys,
    tlo: whole.tlo, thi: whole.thi,
    levels: [
      { t: whole.tlo, keys: loKeys },
      { t: whole.thi, keys: hiKeys },
    ],
  };
}

/**
 * STAPEL: die Vollringe einer Achse, die sich eine Ebene teilen — gleiche Höhe t
 * UND gemeinsame Vertices dort. Solche Ringe liegen übereinander (Zylinder zwischen
 * zwei Fasen-Kegeln) und müssen an derselben Winkelstelle geschnitten werden, damit
 * ihre Bögen aufeinander passen (gleicher Polygonzug → gleicher Bogen-Schlüssel).
 *
 * Ringe ohne gemeinsame Ebene bilden je einen eigenen (einelementigen) Stapel.
 * → [[info, …], …]   (jeder Stapel von unten nach oben)
 */
function ringStacks(ctx, rings) {
  const tol = ctx.o.levelTol;
  const parent = rings.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[rb] = ra; };
  // gemeinsame Ebene: gleiche Höhe UND mindestens ein gemeinsamer Vertex
  const shares = (a, b) => {
    for (const la of a.levels) {
      for (const lb of b.levels) {
        if (Math.abs(la.t - lb.t) > tol) continue;
        for (const k of la.keys) if (lb.keys.has(k)) return true;
      }
    }
    return false;
  };
  for (let i = 0; i < rings.length; i++) {
    for (let j = i + 1; j < rings.length; j++) {
      if (shares(rings[i], rings[j])) union(i, j);
    }
  }
  const groups = new Map();
  for (let i = 0; i < rings.length; i++) {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(rings[i]);
  }
  const out = [];
  for (const g of groups.values()) {
    g.sort((a, b) => (a.tlo - b.tlo) || (a.thi - b.thi));
    out.push(g);
  }
  return out;
}

/**
 * ZULÄSSIGE SCHNITTPOSITIONEN eines Stapels: eine Position ist eine Kette von
 * Mantellinien — je Ring eine —, die sich an den gemeinsamen Ebenen im selben Vertex
 * treffen. Der Schnitt liegt damit an derselben Winkelstelle in ALLEN Ringen des
 * Stapels:
 *
 *   Zylinder: die Mantellinie durch den Vertex an beiden Ebenen (sie bestimmt den
 *             Vertex der nächsten Ebene),
 *   Kegel:    die Mantellinie, deren Punkt auf der gemeinsamen Ebene genau der
 *             Vertex des Nachbarrings ist.
 *
 * Fehlt einem Ring an der Stelle die Mantellinie (Fasen-Fächer: die Seitenkante ist
 * schräg), ist die Position für den ganzen Stapel unzulässig — genau das war die
 * Fehlerquelle der Einzellogik (jeder Ring schnitt an seiner eigenen Stelle).
 *
 * → [{ phi, edges: [Mantellinie je Ring, unten→oben] }]
 */
function stackPositions(stack) {
  const out = [];
  for (const c0 of stack[0].cands) {
    const edges = [c0];
    let ok = true;
    for (let q = 1; q < stack.length; q++) {
      const next = stack[q].byLo.get(edges[q - 1].hiKey);
      if (!next) { ok = false; break; }
      edges.push(next);
    }
    if (ok) out.push({ phi: c0.phi, edges });
  }
  return out;
}

/**
 * SCHNITTWAHL eines Stapels: je Zielwinkel 0, 2π/3, 4π/3 den zulaessigen Schnitt mit
 * dem kleinsten Winkelabstand wählen (höchstens 60° — weiter weg liegt kein Schnitt).
 * Gibt es für einen Zielwinkel keinen zulaessigen Schnitt, wird der Stapel NICHT
 * gemeinsam geschnitten (→ Einzellogik mit Register).
 *
 * → { cuts: [{ phi, edges } × 3], positions } | null
 */
function stackCutPlan(stack) {
  const positions = stackPositions(stack);
  if (!positions.length) return null;
  const maxDev = 60 * Math.PI / 180;
  const cuts = [];
  for (const target of [0, 2 * Math.PI / 3, 4 * Math.PI / 3]) {
    let best = null, bd = Infinity;
    for (const pos of positions) {
      const d = angDist(pos.phi, target);
      if (d > maxDev) continue;
      if (d < bd) { bd = d; best = pos; }
    }
    if (!best) return null;
    cuts.push(best);
  }
  // die drei Schnitte müssen verschiedene Mantellinien sein — in JEDEM Ring des Stapels
  for (let q = 0; q < stack.length; q++) {
    if (new Set(cuts.map((c) => c.edges[q].k)).size !== 3) return null;
  }
  return { cuts, positions };
}

/**
 * Schnittwahl EINZELNES Rings (alte Logik): je Zielwinkel 0, 2π/3, 4π/3 zuerst die
 * Mantellinie, deren lo-/hi-Punkt ein Schnittpunkt eines früheren Rings derselben
 * Achse ist (REGISTER, nur im Zielwinkel-Fenster ≤ 30°), sonst die nächste
 * Mantellinie zum Zielwinkel.
 * → [k, k, k] (Ketten-Index der drei Schnitt-Seitenkanten) | null
 */
function pickRingCuts(cands, reg) {
  const cuts = [];
  const regWin = 30 * Math.PI / 180;
  for (const target of [0, 2 * Math.PI / 3, 4 * Math.PI / 3]) {
    // (1) Register: Mantellinie, deren lo-/hi-Punkt ein Schnittpunkt eines früheren
    //     Rings derselben Achse ist (nur im Zielwinkel-Fenster)
    let best = -1, bd = Infinity;
    if (reg && reg.size) {
      for (const cd of cands) {
        const d = angDist(cd.phi, target);
        if (d > regWin) continue;
        if (!reg.has(cd.loKey) && !reg.has(cd.hiKey)) continue;
        if (d < bd) { bd = d; best = cd.k; }
      }
    }
    // (2) Rückfall: nächste Mantellinie zum Zielwinkel
    if (best < 0) {
      bd = Infinity;
      for (const cd of cands) {
        const d = angDist(cd.phi, target);
        if (d < bd) { bd = d; best = cd.k; }
      }
    }
    if (best < 0) return null;
    cuts.push(best);
  }
  if (new Set(cuts).size !== 3) return null;
  return cuts;
}

/**
 * Einen gültigen VOLLRING (zyklische Kette, der ganze Ring besteht als Band) in
 * DREI Bänder teilen — an den drei vorgegebenen Schnitt-Seitenkanten
 * (Ketten-Index). Die Schnittwahl selbst: pickRingCuts (Einzellogik mit Register)
 * oder stackCutPlan (gemeinsame Wahl für den ganzen Stapel).
 */
function splitRing(ctx, chain, whole, bands, taken, stats, reg) {
  // Seitenkanten, die Mantellinien sind, mit ihrem Polarwinkel (0 … 2π)
  const cands = ringCandidates(ctx, chain, whole);
  if (cands.length < 3) return false;
  const cuts = pickRingCuts(cands, reg);
  if (!cuts) return false;
  return splitRingAt(ctx, chain, whole, bands, taken, stats, cuts, reg);
}

/**
 * Den Ring an den drei Schnitt-Seitenkanten `cuts` (Ketten-Index) in drei Bänder
 * teilen. Scheitert einer der drei Teile (oder sind die drei Schnitte nicht
 * verschieden), wird der ganze Ring übersprungen — es entstehen KEINE Teil-Bänder
 * eines Rings.
 */
function splitRingAt(ctx, chain, whole, bands, taken, stats, cuts, reg) {
  // ── Sperren: welche Ringe dürfen überhaupt in Bänder geteilt werden? ───────
  // Ein VOLLRING ist im Normalfall eine Primitive-Wand (Zylinder/Kegel zwischen zwei
  // Deckflächen). Für sie sind die Pfade mit den strengeren Gates zuständig:
  //   - der Mantel-/Kegel-Pfad (konvexe Außenwand: Dellen, Verdrehung, Knick, Fase),
  //   - der Bohrungs-Pfad (konkaves Loch: Steg zu dünn, Rand an der Plattenkante).
  // Der Bogen-Pfad prüft das nicht — er würde die Wand unbemerkt analytisch machen und
  // dabei die Form ändern (Delle geglättet, Knick weg) oder eine gefährliche
  // Kreis-Kante erzeugen (Kreis schneidet den Nachbarn). Deshalb:
  //   (1) Wand-Facetten gehören zu einem erkannten Primitive (Zylinder) → nicht teilen:
  //       die Primitive-Pfade haben entschieden (oder bewusst verworfen) — das prüft
  //       makeBand (blockedGroups) für ALLE Bänder, auch für die Ringe.
  //   (2) Die Wand ist eine vollständige Primitive-Wand (beide Ebenen an einer
  //       Deckfläche ⟂ d) → nicht teilen (Zylinder/Kegel zwischen zwei Deckflächen).
  //   (3) Die Wand ist konvex (Außenwand, Normalen zeigen von der Achse weg) → nicht
  //       teilen: das ist der Mantel-/Kegel-Pfad.
  // Was bleibt, sind Wände, die KEIN anderer Pfad nehmen kann: ein Loch mit Fasen an
  // beiden Enden (Ring aus Zylinder + Kegeln) — dort ist der Bogen-Pfad der einzige,
  // der die Wand als echte Teil-Zylinder/-Kegel schreiben kann.
  if (ringLevelHasDeck(ctx, chain, 'lo') && ringLevelHasDeck(ctx, chain, 'hi')) return false;
  const { o, vkey } = ctx;
  const m = chain.facets.length;
  if (!cuts || cuts.length !== 3) return false;
  if (new Set(cuts).size !== 3) return false;
  // Die Schnitte MÜSSEN nach KETTEN-INDEX aufsteigend sortiert werden: die Teile laufen
  // vorwärts im Ketten-Index (cuts[i] → cuts[i+1]), der Ketten-Index läuft aber je nach
  // Facetten-Orientierung im Uhrzeigersinn oder dagegen. Ohne Sortierung läuft Teil 0 den
  // langen Weg (über cuts[2]) — die drei Teile überlappen dann, ein Drittel des Rings fehlt
  // und die Bogen-Kanten werden doppelt benutzt (alle Bögen verworfen).
  const cs = cuts.slice().sort((a, b) => a - b);
  // Die drei Teile als Pfad-Ketten (sides hat facets.length + 1 Einträge)
  const parts = [];
  for (let i = 0; i < 3; i++) {
    const a = cs[i], b = cs[(i + 1) % 3];
    const idx = [];
    for (let k = a; k !== b; k = (k + 1) % m) idx.push(k);
    if (!idx.length) return false;
    const facets = idx.map((k) => chain.facets[k]);
    const sides = [];
    for (let t = 0; t <= idx.length; t++) sides.push(chain.sides[(a + t) % m]);
    parts.push({ cyclic: false, facets, sides });
  }
  // Jeder Facetten-Index des Rings muss in GENAU EINEM Teil liegen (sonst: Lücke oder
  // Doppelbelegung → der Ring bleibt facettiert)
  const seen = new Set();
  for (const part of parts) {
    for (const fi of part.facets) {
      if (seen.has(fi)) return false;
      seen.add(fi);
    }
  }
  if (seen.size !== m) return false;
  // Alle drei Teile müssen Bänder ergeben — sonst bleibt der ganze Ring facettiert
  const made = [];
  for (const part of parts) {
    const chk = tryBand(ctx, part, 0, part.facets.length - 1);
    if (!chk || chk.insufficient || !chk.endsOk || chk.nSegs < o.minSegs) return false;
    const mb = makeBand(ctx, part, 0, part.facets.length - 1, chk, -1);
    if (!mb) return false;
    made.push(mb);
  }
  // KONVEXE Wand (Außenwand: die Facetten-Normalen zeigen von der Achse weg) → das ist der
  // Mantel-/Kegel-Pfad (mit seinen strengeren Gates: Delle, Verdrehung, Knick, Fase). Der
  // Bogen-Pfad darf sie nicht übernehmen — er würde die Wand dabei glätten.
  if (made[0].band.sense > 0) return false;
  for (let i = 0; i < 3; i++) {
    const band = made[i].band;
    band.id = bands.length;
    setBandSrc(band, ctx, parts[i], 0, parts[i].facets.length - 1);
    bands.push(band);
    for (const fi of band.facets) taken.add(fi);
    stats.bands++;
    if (band.kind === 'cyl') stats.cyl++; else stats.cone++;
  }
  // Schnittpunkte dieses Rings ins Register (die lo-/hi-Punkte der Schnitt-Seitenkanten)
  if (reg) {
    for (const k of cs) {
      const s = chain.sides[k];
      if (!s) continue;
      reg.add(vkey(s[0]));
      reg.add(vkey(s[1]));
    }
  }
  return true;
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
 * Reststück eines geteilten Bandes: die Facetten [a..b] liegen auf denselben Kreisen
 * wie das Eltern-Band X (dessen Kreise stammen aus dem Fit des GANZEN Bandes) und die
 * beiden End-Seitenkanten sind Mantellinien bezüglich der Eltern-Mitten. Ein solches
 * Reststück (z. B. eine einzelne Facette, die alignBands am Ende eines Nachbarbogens
 * abgetrennt hat) ist selbst ein kleines Band — ohne diese Ausnahme blieben seine
 * Facetten facettiert und der Nachbarbogen fände keinen passenden Nachbarn.
 *
 * Der Kreisfit des Reststücks ist nicht scharf (1–2 Punkte je Ebene) → die Kreise des
 * Eltern-Bands werden übernommen (Klo/Khi, tol, rMax) und die Ebenen tlo/thi.
 * → { band, arcs } | null
 */
function remnantBand(ctx, chain, a, b, parent) {
  const { fds, frame, o, vkey, facInfo } = ctx;
  const pLo = parent && parent.levels ? parent.levels.lo : null;
  const pHi = parent && parent.levels ? parent.levels.hi : null;
  if (!pLo || !pHi || !pLo.c2 || !pHi.c2) return null;
  const rMax = Math.max(pLo.r, pHi.r);
  const tol = Math.max(o.tolFitAbs, o.tolFitRel * rMax);
  // Punkte des Reststücks sammeln (lo- und hi-Lauf je Facette)
  const loPts = [], hiPts = [];
  for (let k = a; k <= b; k++) {
    const fi = chain.facets[k];
    const info = facInfo.get(fi);
    if (!info) return null;
    const runs = facetRuns(fds[fi], info, vkey);
    if (!runs) return null;
    const sA = chain.sides[k], sB = chain.sides[k + 1];
    if (!sA || !sB) return null;
    const loRun = orientRun(runs.loRun, vkey(sA[0]), vkey(sB[0]), vkey);
    const hiRun = orientRun(runs.hiRun, vkey(sA[1]), vkey(sB[1]), vkey);
    if (!loRun || !hiRun) return null;
    for (const p of loRun) loPts.push(p);
    for (const p of hiRun) hiPts.push(p);
  }
  if (!loPts.length || !hiPts.length) return null;
  // alle Punkte auf den Kreisen des Eltern-Bands?
  for (const p of loPts) {
    const l = toLocal(frame, p);
    if (Math.abs(Math.hypot(l[0] - pLo.c2[0], l[1] - pLo.c2[1]) - pLo.r) > tol) return null;
  }
  for (const p of hiPts) {
    const l = toLocal(frame, p);
    if (Math.abs(Math.hypot(l[0] - pHi.c2[0], l[1] - pHi.c2[1]) - pHi.r) > tol) return null;
  }
  // beide End-Seitenkanten müssen Mantellinien bezüglich der Eltern-Mitten sein
  const s0 = chain.sides[a], s1 = chain.sides[b + 1];
  if (!s0 || !s1) return null;
  if (!sideIsRuling(frame, s0, pLo.c2, pHi.c2, rMax, tol)) return null;
  if (!sideIsRuling(frame, s1, pLo.c2, pHi.c2, rMax, tol)) return null;
  // mindestens ein Segment
  const nSegs = Math.max(loPts.length - 1, hiPts.length - 1);
  if (nSegs < 1) return null;
  const chk = {
    Klo: { c: pLo.c2, r: pLo.r },
    Khi: { c: pHi.c2, r: pHi.r },
    tol, rMax,
    tlo: pLo.t, thi: pHi.t,
    nSegs, endsOk: true, startOk: true, endOk: true,
  };
  const made = makeBand(ctx, chain, a, b, chk, -1);
  if (!made) return null;
  // Das Reststück ist ein Stück der FLÄCHE des Eltern-Bands: seine Bögen müssen auf
  // denselben Kreisen liegen (und dieselbe Bogen-Achse haben) wie die des Eltern-Bands
  // → der Bogen-Hinweis (die gemeinsame Achse des Bogen-Stapels) wird beim Bauen der
  // Pläne vom Eltern-Band übernommen.
  const pLoArc = (parent.segs || []).find((s) => s.type === 'arc' && s.level === 'lo');
  const pHiArc = (parent.segs || []).find((s) => s.type === 'arc' && s.level === 'hi');
  Object.defineProperty(made.band, 'stackParent', {
    value: {
      lo: pLoArc ? pLoArc.arcKey : null,
      hi: pHiArc ? pHiArc.arcKey : null,
    },
    enumerable: false, writable: true, configurable: true,
  });
  return made;
}

/**
 * Teilbänder eines Band-Bereichs [a..b] bauen (tryBand + makeBand, inkl. blocked).
 * Scheitert die Prüfung oder hat der Bereich zu wenige Segmente → kein Band
 * (die Facetten bleiben facettiert) — es sei denn, `parent` (das Eltern-Band, aus dem
 * der Bereich stammt) trägt die Prüfung: dann wird das Reststück zum Band (remnantBand).
 */
function pushBand(ctx, chain, a, b, out, parent) {
  const chk = tryBand(ctx, chain, a, b);
  if (chk && !chk.insufficient && chk.endsOk && chk.nSegs >= ctx.o.minSegs) {
    const made = makeBand(ctx, chain, a, b, chk, out.length);
    if (made) {
      setBandSrc(made.band, ctx, chain, a, b);
      out.push(made.band);
      return;
    }
  }
  if (!parent) return;
  const rem = remnantBand(ctx, chain, a, b, parent);
  if (!rem) return;
  rem.band.id = out.length;
  setBandSrc(rem.band, ctx, chain, a, b);
  out.push(rem.band);
}

/**
 * Teilungsstellen eines Bandes: Facettengrenzen (Index s in der Kette), an denen ein
 * Bogen des Bandes einen inneren Punkt hat, der Bogen-ENDpunkt eines anderen Bandes ist.
 * Für das lo-Seg zählt der lo-Punkt der Seitenkante, für das hi-Seg der hi-Punkt.
 * Geschnitten wird nur an Mantellinien — die Schnittkante wird LINE-Kante des Bandes.
 * → aufsteigend sortierte Liste der Grenzindizes (i < s ≤ j).
 */
function cutsOfBand(X, chain, i, j, breaks, vkey, o) {
  const cuts = new Set();
  const cLo = X.levels && X.levels.lo ? X.levels.lo.c2 : null;
  const cHi = X.levels && X.levels.hi ? X.levels.hi.c2 : null;
  if (!cLo || !cHi) return [];
  const rMax = Math.max(X.levels.lo.r, X.levels.hi.r);
  const tol = Math.max(o.tolFitAbs, o.tolFitRel * rMax);
  for (const seg of (X.segs || [])) {
    if (seg.type !== 'arc' || !seg.pts || seg.pts.length < 3) continue;
    const useLo = seg.level === 'lo';
    for (let k = 1; k + 1 < seg.pts.length; k++) {
      const kk = vkey(seg.pts[k]);
      if (!breaks.has(kk)) continue;
      for (let s = i + 1; s <= j; s++) {
        const side = chain.sides[s];
        if (!side) continue;
        if (!sideIsRuling(X.frame, side, cLo, cHi, rMax, tol)) continue;
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
 * die scheitern, entfallen → ihre Facetten bleiben facettiert; ein Reststück, das auf
 * den Kreisen des Eltern-Bands X liegt und an beiden Enden Mantellinien hat, wird
 * trotzdem zum Band — sonst bliebe seine Facette facettiert und der Nachbarbogen fände
 * keinen Nachbarn). Wiederholen bis nichts mehr kippt (höchstens 20 Durchgänge).
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
      const cuts = cutsOfBand(X, chain, i, j, breaks, vkey, o);
      if (!cuts.length) { next.push(X); continue; }
      changed = true;
      aligned += cuts.length;
      let a = i;
      for (const s of cuts) {
        if (s - 1 >= a) pushBand(ctx, chain, a, s - 1, next, X);
        a = s;
      }
      if (j >= a) pushBand(ctx, chain, a, j, next, X);
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
  // nur die ersten o.maxAxes Achsen bearbeiten (Kandidaten sind nach Punktzahl
  // absteigend sortiert → die mit den meisten Deckflächen-Punkten gewinnen)
  const maxAxes = Number.isFinite(o.maxAxes) ? Math.max(0, o.maxAxes) : Infinity;
  const axes = axisCandidates(list, o).slice(0, maxAxes);
  const bands = [];
  const stats = { axes: axes.length, candidates: 0, chains: 0, bands: 0, cyl: 0, cone: 0, budgetHit: false };
  const taken = new Set();                       // Facetten mit Band einer früheren Achse
  // Zeitbudget: nach Ablauf keine weiteren Ketten verarbeiten (Bänder bleiben)
  const t0 = nowMs();
  const budgetMs = typeof o.budgetMs === 'number' ? o.budgetMs : Infinity;
  const overBudget = () => (nowMs() - t0) >= budgetMs;

  axesLoop:
  for (const d of axes) {
    const frame = makeFrame(d);
    const { facets, chains } = buildChains(list, d, frame, index, taken, o);
    stats.candidates += facets.size;
    stats.chains += chains.length;
    const ctx = { fds: list, frame, o, vkey, facInfo: facets, index };
    // Register der Ring-Schnittpunkte (je Achse): die vkeys der lo-/hi-Punkte der
    // Schnitt-Seitenkanten der bereits geteilten Ringe. Ein später Ring schneidet
    // bevorzugt an derselben Kante (Mantellinie), damit die Bögen der Ringe
    // übereinanderliegender Ebenen denselben Polygonzug haben.
    const cutReg = new Set();

    // VORAB: die Vollringe dieser Achse bestimmen (Band-Fit + Mantellinien-Zahl).
    // Der Ring mit den WENIGSTEN Mantellinien (Fasen-Ring mit Fächern: dort fehlen
    // einzelne Mantellinien) wird ZUERST geteilt — er legt die Schnittkanten fest,
    // die übrigen Ringe desselben Stapels folgen dem Register. Sonst hinge die
    // Ausrichtung der Ringe an der Reihenfolge der Flächen im Netz.
    const wholeRings = new Map();                          // chain → { whole, nCand }
    for (const chain of chains) {
      if (!chain.cyclic) continue;
      if (overBudget()) break;
      const whole = tryBand(ctx, chain, 0, chain.facets.length - 1);
      if (!whole || whole.insufficient) { wholeRings.set(chain, { whole: null, nCand: 0 }); continue; }
      wholeRings.set(chain, { whole, nCand: ringCandidates(ctx, chain, whole).length });
    }
    // STAPEL: die Vollringe, die sich eine Ebene teilen (Zylinder zwischen zwei
    // Fasen-Kegeln o. ä.) — ihre Schnitte werden GEMEINSAM gewählt, damit alle Ringe
    // an derselben Winkelstelle geschnitten werden (die Bögen müssen aufeinander
    // passen). Ringe ohne Stapel folgen dem REGISTER (die Schnittpunkte der schon
    // geteilten Ringe).
    const ringInfos = [];
    for (const [chain, info] of wholeRings) {
      if (!info.whole) continue;
      ringInfos.push(ringInfo(ctx, chain, info.whole));
    }
    const planOf = new Map();                    // chain → { plan, qi }
    const planned = [];
    for (const st of ringStacks(ctx, ringInfos)) {
      if (st.length < 2) continue;               // einzelner Ring → Einzellogik
      const plan = stackCutPlan(st);
      if (!plan) continue;                       // kein gemeinsamer Schnitt → Einzellogik
      planned.push({ stack: st, plan });
      st.forEach((r, qi) => planOf.set(r.chain, { plan, qi }));
    }
    // Reihenfolge: der Stapel mit den WENIGSTEN zulaessigen Schnittpositionen zuerst
    // (er legt die Schnittkanten fest), danach die übrigen Ketten: der Ring mit den
    // WENIGSTEN Mantellinien zuerst (er legt die Schnittkanten fest, die übrigen
    // folgen dem Register). Sonst hinge die Ausrichtung an der Netz-Reihenfolge.
    planned.sort((a, b) => a.plan.positions.length - b.plan.positions.length);
    let refChain = null, refNCand = Infinity;
    for (const [chain, info] of wholeRings) {
      if (!info.whole || planOf.has(chain)) continue;
      if (info.nCand < refNCand) { refNCand = info.nCand; refChain = chain; }
    }
    const rest = chains.filter((c) => !planOf.has(c));
    const ordered = planned
      .flatMap((s) => s.stack.map((r) => r.chain))
      .concat(refChain ? [refChain] : [])
      .concat(rest.filter((c) => c !== refChain));

    for (const chain of ordered) {
      if (overBudget()) { stats.budgetHit = true; break axesLoop; }
      let work = chain;
      if (chain.cyclic) {
        // Vollkreis? → in DREI Bänder teilen (Schnitt an den Mantellinien mit den
        // Polarwinkeln 0, 2π/3, 4π/3). Scheitert die Teilung, bleibt der Ring
        // facettiert (es entstehen keine Teil-Bänder eines Rings).
        const cached = wholeRings.get(chain);
        const whole = cached ? cached.whole : tryBand(ctx, chain, 0, chain.facets.length - 1);
        if (whole && !whole.insufficient) {
          const pl = planOf.get(chain);
          if (pl) {
            // gemeinsamer Schnitt des Stapels: alle Ringe werden an DENSELBEN drei
            // Winkelstellen geschnitten → ihre Bögen passen aufeinander
            const cuts = pl.plan.cuts.map((c) => c.edges[pl.qi].k);
            splitRingAt(ctx, chain, whole, bands, taken, stats, cuts, cutReg);
          } else {
            splitRing(ctx, chain, whole, bands, taken, stats, cutReg);
          }
          continue;
        }
        // sonst an der Seitenkante nach der breitesten lo-Kante aufschneiden
        work = cutCycle(chain, widestFacet(ctx, chain));
      }

      // gierig teilen: größtes gültiges j ≥ i (gallopingend gesucht). Ein Band
      // gilt nur, wenn seine beiden END-Seitenkanten Mantellinien sind (LINE-Kanten
      // im STEP); die inneren Seitenkanten dürfen schräg sein (Dreiecksfächer).
      const m = work.facets.length;
      let i = 0;
      while (i < m) {
        if (!work.sides[i]) { i++; continue; }
        if (overBudget()) { stats.budgetHit = true; break axesLoop; }
        const found = scanBandFrom(ctx, work, i, m);
        if (found) {
          // VORAUSSCHAU: reicht das Band ab der NÄCHSTEN Facette weiter, dann gehört die
          // Facette i nicht zu diesem Band — sie blockiert es (breite ebene Profilseite
          // vor einem fein facettierten Bogen → FAKE-Band mit riesigem Kreisradius). Die
          // Facette i wird dann ohne Band übersprungen, damit die ersten Facetten des
          // echten Bogens nicht flach bleiben.
          if (i + 1 < m && work.sides[i + 1]) {
            const nx = scanBandFrom(ctx, work, i + 1, m);
            if (nx && nx.j > found.j) { i = i + 1; continue; }
          }
          const { chk, j: bestJ } = found;
          const made = makeBand(ctx, work, i, bestJ, chk, bands.length);
          if (made) {
            const band = made.band;
            setBandSrc(band, ctx, work, i, bestJ);
            bands.push(band);
            for (const fi of band.facets) taken.add(fi);
            stats.bands++;
            if (band.kind === 'cyl') stats.cyl++; else stats.cone++;
          }
          i = bestJ + 1;                     // auch bei gesperrter Signatur weiter
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
 *   (b) eine ebene Deckfläche ⟂ d (kein Band-Facet, kein arcEdges; der Loop, in dem
 *       der Bogen liegt, darf kein analytischer Kreis-Rand (circleRim) sein — andere
 *       Loops derselben Fläche, z. B. eine Bohrungs-Mündung, stören nicht)
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

  // Loop li einer Fläche (0 = außen, k = innen[k−1])
  const loopAt = (fd, li) => {
    if (!fd) return null;
    if (li === 0) return fd.outer || null;
    return (fd.inner || [])[li - 1] || null;
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
      // Nur der Loop, in dem der Bogen liegt, darf kein analytischer Kreis-Rand (circleRim)
      // sein — ANDERE Loops derselben Fläche (z. B. die Mündung einer Bohrung) stören nicht.
      const capLoop = fd ? loopAt(fd, li) : null;
      if (fd && capLoop && !bandFacets.has(fi) && !hasArcEdges(fd) && !capLoop.circleRim) {
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
 * Nicht-Index-Eigenschaften des Loops werden übernommen — `circleRim` jedoch NICHT:
 * der Loop ist danach ein kürzerer Polygonzug, ein analytischer Kreis-Rand (Bohrungs-
 * Mündung) passt nicht mehr zu ihm.
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
  const out = L.filter((_, i) => !rm.has(i));
  for (const k of Object.keys(L)) {
    if (/^\d+$/.test(k)) continue;              // Index
    if (k === 'circleRim') continue;            // analytischer Kreis-Rand: gehört zum ALTEN Loop
    out[k] = L[k];
  }
  return out;
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
    // Loops, die NICHT editiert werden, bleiben das ORIGINAL-Objekt: eine Kopie
    // (Array.prototype.slice) würde die Eigenschaft `circleRim` verlieren — der
    // analytische Kreis-Rand einer Bohrungs-Mündung in einem ANDEREN Loop derselben
    // Fläche würde dann als Polygon geschrieben und die Hülle aufreißen.
    const newLoops = loops.slice();
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

// ── Exakte Geometrie (Abschnitt 3) ─────────────────────────────────────────

/**
 * Exakte Bogen-Geometrie aus den GESCHRIEBENEN Endpunkt-Koordinaten.
 *
 * Aw/Bw = geschriebene Koordinaten von arc.pts[0] bzw. des letzten Punktes.
 * Die Sehne w = Bw − Aw; die Kreis-Ebene steht ⊥ z, wobei
 *   z = normiert(d − (w·d / w·w)·w)   (bei gleicher Höhe der Endpunkte: z = d)
 * Die Mitte liegt auf der Mittelsenkrechten der Sehre; ihre Lage längs u = norm(z × w)
 * folgt aus dem gefitteten Kreis-C0 (arc.level):  center = M + ((C0 − M)·u)·u.
 * Der Umlaufsinn kommt aus dem Polygonzug (Vorzeichen von Σ (p_k − c) × (p_{k+1} − c) · z).
 *
 * Prüfungen (sonst null): Radius = level.r (Toleranz), alle Polygonzug-Punkte auf der
 * Kreislinie, Summe der Segmentwinkel = sweep.
 *
 * hint2d (optional) — Mittelpunkt-Hinweis [u, v] im Rahmen des Bogens (die
 * gemeinsame Achse des Bogen-Stapels). Ohne ihn wird level.c2 (Kreis-Fit der
 * eigenen Ebene) benutzt; bei kurzen Bögen ist der Fit entlang der
 * Mittelsenkrechten schlecht bestimmt (Fehler ∝ Rauschen / Bogenwinkel).
 *
 * → { key, A, B, Aw, Bw, center, axis, refDir, radius, sweep } | null
 */
export function arcGeometry(arc, Aw, Bw, opts, hint2d) {
  const o = { ...ARC_DEFAULTS, ...opts };
  if (!arc || !Array.isArray(Aw) || !Array.isArray(Bw)) return null;
  const pts = arc.pts || [];
  if (pts.length < 2) return null;
  const w = sub(Bw, Aw);
  const ww = dot(w, w);
  if (!(ww > 1e-18)) return null;                     // |w| > 1e-9
  const d = arc.d;
  if (!d || !(len(d) > 0)) return null;
  let z = sub(d, mul(w, dot(w, d) / ww));
  if (!(len(z) > 1e-12)) return null;
  z = norm(z);
  const M = mul(add(Aw, Bw), 0.5);
  let u = cross(z, w);
  if (!(len(u) > 1e-12)) return null;
  u = norm(u);
  const frame = arc.frame, level = arc.level;
  if (!frame || !frame.e1 || !frame.e2 || !level || !level.c2) return null;
  const hint = (hint2d && hint2d.length >= 2 && Number.isFinite(hint2d[0]) && Number.isFinite(hint2d[1]))
    ? hint2d : level.c2;
  const C0 = add(add(mul(frame.e1, hint[0]), mul(frame.e2, hint[1])), mul(d, level.t));
  const s = dot(sub(C0, M), u);
  const center = add(M, mul(u, s));
  const vA = sub(Aw, center);
  const radius = len(vA);
  if (!(radius > 1e-9)) return null;

  // Umlaufsinn aus dem Polygonzug (Rohpunkte)
  let S = 0;
  for (let k = 0; k + 1 < pts.length; k++) {
    S += dot(cross(sub(pts[k], center), sub(pts[k + 1], center)), z);
  }
  if (S < 0) z = mul(z, -1);
  const refDir = norm(sub(vA, mul(z, dot(vA, z))));
  if (!(len(refDir) > 1e-12)) return null;
  const e2 = cross(z, refDir);
  const ang = (p) => {
    const v = sub(p, center);
    return Math.atan2(dot(v, e2), dot(v, refDir));
  };

  // Sweep: Winkel A → B gegen den Uhrzeigersinn um z, in (0, 2π)
  let sweep = ang(Bw) - ang(Aw);
  while (sweep < 0) sweep += 2 * Math.PI;
  if (!(sweep > 1e-9) || sweep > 2 * Math.PI - 1e-9) return null;

  const tol = Math.max(o.tolFitAbs, o.tolFitRel * radius);
  if (!(Math.abs(radius - level.r) <= tol)) {
    // Der Stapel-Hinweis (die gemeinsame Achse des Bogen-Stapels) liegt bei KURZEN Bögen
    // mitunter weit neben der Wahrheit: der Mittelpunkt ist dann entlang der Mittelsenk-
    // rechten schlecht bestimmt (Fehler ∝ Rauschen/Bogenwinkel), und der daraus berechnete
    // Radius passt dann nicht zum Radius der Ebene (level.r). Der eigene Fit der Ebene
    // (level.c2) bestimmt den Radius genau — mit ihm wird der Bogen wieder brauchbar.
    // Die Prüfung selbst bleibt streng (tolFit) — es wird nur ein anderer Mittelpunkt
    // versucht, nicht die Toleranz gelockert.
    if (hint2d && hint2d.length >= 2 && Number.isFinite(hint2d[0]) && Number.isFinite(hint2d[1])) {
      return arcGeometry(arc, Aw, Bw, opts, null);          // → level.c2
    }
    return null;
  }
  // Abstand jedes Polygonzug-Punktes zur Kreislinie (3D)
  for (const p of pts) {
    const v = sub(p, center);
    const hh = dot(v, z);
    const rho = len(sub(v, mul(z, hh)));
    const dr = rho - radius;
    if (!(Math.sqrt(hh * hh + dr * dr) <= tol)) return null;
  }
  // Summe der Segmentwinkel des Polygonzugs ≈ sweep
  let sum = 0, prev = ang(pts[0]);
  for (let k = 1; k < pts.length; k++) {
    const a = ang(pts[k]);
    let dd = a - prev;
    while (dd > Math.PI) dd -= 2 * Math.PI;
    while (dd < -Math.PI) dd += 2 * Math.PI;
    sum += dd;
    prev = a;
  }
  if (!(Math.abs(sum - sweep) <= 1e-3)) return null;

  return {
    key: arc.key,
    A: pts[0], B: pts[pts.length - 1],
    Aw: Aw.slice(), Bw: Bw.slice(),
    center, axis: z, refDir, radius, sweep,
  };
}

/**
 * n+1 Punkte auf dem Bogen: Parameter 0 → sweep.
 * Der erste Punkt ist Aw, der letzte Bw (exakt, nicht neu berechnet).
 */
export function arcSamples(geom, n) {
  if (!geom) return [];
  const N = Math.max(1, Math.floor(n) || 1);
  const e2 = cross(geom.axis, geom.refDir);
  const out = [];
  for (let k = 0; k <= N; k++) {
    if (k === 0) { out.push(geom.Aw.slice()); continue; }
    if (k === N) { out.push(geom.Bw.slice()); continue; }
    const t = geom.sweep * k / N;
    const c = Math.cos(t), s = Math.sin(t);
    out.push(add(geom.center, add(mul(geom.refDir, geom.radius * c), mul(e2, geom.radius * s))));
  }
  return out;
}

/** Abstand eines Punktes zur Zylinderfläche (Achse loc/axis, Radius r) */
const cylDist = (surf, p) => {
  const x = sub(p, surf.loc);
  const perp = sub(x, mul(surf.axis, dot(x, surf.axis)));
  return Math.abs(len(perp) - surf.radius);
};

/** Abstand eines Punktes zur Kegelfläche (loc = Mitte des großen Kreises) */
const coneDist = (surf, p) => {
  const x = sub(p, surf.loc);
  const hh = dot(x, surf.axis);
  const perp = sub(x, mul(surf.axis, hh));
  const R = surf.radius + hh * Math.tan(surf.semiAngle);
  return Math.abs(len(perp) - R) * Math.cos(surf.semiAngle);
};

/**
 * Bandfläche aus den beiden Bogen-Geometrien.
 *
 * KANDIDATEN (in der Reihenfolge der Präferenz — der erste, der beide Bögen trägt, gewinnt):
 *   Zylinder-Band ('cyl'):
 *     1. Zylinder mit Achse ∥ band.d durch gLo.center, Radius = Mittel der Radien
 *        (unverändertes Verhalten; die Kreise stehen senkrecht zur Achse → exakte Querschnitte)
 *     2. Kegel mit Achse ∥ band.d, wenn sich die Radien um mehr als surfTol unterscheiden
 *        (unverändertes Verhalten für echte Kegel-Bänder; NEU als Ausweichstufe für ein
 *        'cyl'-Band — das ist in Wahrheit minimal konisch, z. B. R_lo 0.663 / R_hi 0.658;
 *        vorher wurde es verworfen)
 *     3. Zylinder mit Achse durch BEIDE Bogen-Mitten (Mitten-Versatz, s. unten)
 *     4. Kegel mit Achse durch BEIDE Bogen-Mitten
 *   Kegel-Band ('cone'):
 *     1. Kegel mit Achse ∥ band.d (Achse zeigt zum wachsenden Radius),
 *        semiAngle = atan2(R_groß − R_klein, Höhenabstand) — unverändertes Verhalten
 *     2. Kegel mit Achse durch BEIDE Bogen-Mitten
 *
 * ACHSE AUS BEIDEN MITTEN: die beiden Bogen-Mitten liegen nicht auf einer gemeinsamen
 * Achsgeraden parallel zu d. arcGeometry holt den Mittelpunkt aus dem Stapel-Hinweis und
 * projiziert ihn auf die Mittelsenkrechte der jeweiligen Sehne — die beiden Sehnen sind aber
 * nur näherungsweise parallel (Rauschen der geschriebenen Punkte). Der Rest-Versatz der Mitten
 * (bei kleinem Radius schon ~1e-4 mm) schob die Hi-Proben neben die Fläche (surfTol 5e-5) →
 * das Band fiel weg (Kabelhalter: Gravur mit Eckrundungen r=0.3). Mit der Achse durch BEIDE
 * Mitten liegen beide Kreise auf der Fläche (die Kreise stehen dann nur O(ε²) daneben).
 * Diese Kandidaten kommen erst dran, wenn die unveränderten nicht tragen — sonst läge ein
 * Band, das vorher genau auf der Fläche lag, jetzt daneben (p7, eBike).
 *
 * Beide Bögen müssen auf der Fläche liegen (opts.surfTol) → sonst null.
 */
export function bandSurface(band, gLo, gHi, opts) {
  const o = { ...ARC_DEFAULTS, ...opts };
  if (!band || !gLo || !gHi) return null;
  const d = band.d;
  if (!d || !(len(d) > 0)) return null;
  const rLo = gLo.radius, rHi = gHi.radius, dr = rHi - rLo;
  const L = rLo >= rHi ? gLo : gHi;                      // großer Kreis
  const K = L === gLo ? gHi : gLo;                        // kleiner Kreis
  const dLK = sub(L.center, K.center);                   // von K nach L
  const hLK = len(dLK);
  const dv = sub(gHi.center, gLo.center);                // von lo nach hi
  const hBoth = len(dv);

  const cylSurf = (axis) => {
    const rd = sub(gLo.refDir, mul(axis, dot(gLo.refDir, axis)));
    if (!(len(rd) > 1e-12)) return null;
    return { kind: 'cyl', loc: gLo.center, axis, refDir: norm(rd), radius: (rLo + rHi) / 2 };
  };
  const coneSurf = (axis, h) => {
    const rd = sub(L.refDir, mul(axis, dot(L.refDir, axis)));
    if (!(len(rd) > 1e-12)) return null;
    return {
      kind: 'cone', loc: L.center, axis, refDir: norm(rd),
      radius: L.radius, semiAngle: Math.atan2(L.radius - K.radius, h),
    };
  };

  const cands = [];
  const hd = dot(dLK, d);
  const coneD = Math.abs(hd) > 1e-12 ? coneSurf(mul(d, hd >= 0 ? 1 : -1), Math.abs(hd)) : null;
  const coneBoth = hLK > 1e-12 ? coneSurf(mul(dLK, 1 / hLK), hLK) : null;
  if (band.kind === 'cone') {
    // Kegel-Band: Kegel ∥ d (unverändertes Verhalten), dann Kegel durch beide Mitten
    if (coneD) cands.push(coneD);
    if (coneBoth) cands.push(coneBoth);
  } else {
    // Zylinder-Band: Zylinder ∥ d (unverändertes Verhalten) …
    const s1 = cylSurf(d);
    if (s1) cands.push(s1);
    // … dann der Kegel, wenn die Radien zu weit auseinanderliegen (das Band ist in
    // Wahrheit minimal konisch: R_lo 0.663 / R_hi 0.658) …
    if (Math.abs(dr) > o.surfTol) {
      if (coneD) cands.push(coneD);
    }
    // … dann der Zylinder mit Achse durch BEIDE Bogen-Mitten (der Mitten-Versatz) …
    if (hBoth > 1e-12) {
      let ax = mul(dv, 1 / hBoth);
      if (dot(ax, d) < 0) ax = mul(ax, -1);                 // Vorzeichen wie d (STEP-Ausgabe stabil)
      const s3 = cylSurf(ax);
      if (s3) cands.push(s3);
    }
    // … und zuletzt der Kegel mit Achse durch beide Mitten
    if (Math.abs(dr) > o.surfTol && coneBoth) cands.push(coneBoth);
  }

  // Erster Kandidat, der beide Bögen trägt (≤ surfTol), gewinnt
  for (const surf of cands) {
    let ok = true;
    for (const g of [gLo, gHi]) {
      for (const p of arcSamples(g, o.samples)) {
        const dist = surf.kind === 'cone' ? coneDist(surf, p) : cylDist(surf, p);
        if (!(dist <= o.surfTol)) { ok = false; break; }
      }
      if (!ok) break;
    }
    if (ok) return surf;
  }
  return null;
}

// ── Pläne (Abschnitt 4) ────────────────────────────────────────────────────

/** Eigentümer-Bänder eines Bogens als failed markieren */
function failOwners(rec, failed) {
  for (const ow of (rec && rec.owners) || []) failed.add(ow.band);
}

/**
 * Deckfläche zu einem capEdit: der Klon (mit arcEdges, aus applyArcBands) oder —
 * falls die Liste keine Bogen-Kanten enthält — das Original über den Index.
 */
function findCapFace(list, ce, vkey) {
  const key = edgeCanonKey(vkey, ce.a, ce.b);
  const has = (fd) => {
    const ae = fd && fd.arcEdges;
    if (!ae) return false;
    if (ae instanceof Map) return ae.get(key) === ce.arcKey;
    if (typeof ae === 'object') return ae[key] === ce.arcKey;
    return false;
  };
  for (const fd of list) if (has(fd)) return fd;
  return list[ce.fi] || null;
}

/** Segmentwinkel (Betrag) eines Polygonzugs um einen Bogen */
function chainAngles(pts, g) {
  const e2 = cross(g.axis, g.refDir);
  const out = [];
  if (!pts || pts.length < 2) return out;
  const ang = (p) => {
    const v = sub(p, g.center);
    return Math.atan2(dot(v, e2), dot(v, g.refDir));
  };
  let prev = ang(pts[0]);
  for (let k = 1; k < pts.length; k++) {
    const a = ang(pts[k]);
    let dd = a - prev;
    while (dd > Math.PI) dd -= 2 * Math.PI;
    while (dd < -Math.PI) dd += 2 * Math.PI;
    out.push(Math.abs(dd));
    prev = a;
  }
  return out;
}

// ── Gemeinsame Achse je Bogen-Stapel (spec-T2c) ────────────────────────────
// Ein Stapel = Zusammenhangskomponente des Graphen Band — Bogen: ein Bogen
// verbindet seine Eigentümer-Bänder. Alle Bänder eines Stapels haben dieselbe
// Achse d und damit denselben Rahmen.

/** Union-Find: Wurzel finden (Pfadkompression) */
const ufRoot = (parent, x) => {
  while (parent.get(x) !== x) {
    parent.set(x, parent.get(parent.get(x)));
    x = parent.get(x);
  }
  return x;
};

/**
 * Stapel der Bänder: ein Bogen verbindet seine Eigentümer-Bänder (rec.owners[].band).
 * → { rootOf: Map<bandId, rootId>, groups: Map<rootId, Band[]> }
 */
function arcStacks(bands, arcs) {
  const parent = new Map();
  for (const b of bands) parent.set(b.id, b.id);
  for (const rec of arcs.values()) {
    const ow = (rec && rec.owners) || [];
    for (let i = 1; i < ow.length; i++) {
      const a = ow[0].band, b = ow[i].band;
      if (!parent.has(a) || !parent.has(b)) continue;
      const ra = ufRoot(parent, a), rb = ufRoot(parent, b);
      if (ra !== rb) parent.set(rb, ra);
    }
  }
  const rootOf = new Map(), groups = new Map();
  for (const b of bands) {
    const r = ufRoot(parent, b.id);
    rootOf.set(b.id, r);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(b);
  }
  return { rootOf, groups };
}

/**
 * Ebenen (Höhen) eines Stapels: die arc-Polygonzüge je Höhe t (± levelTol).
 * Bänder und Bögen eines Stapels teilen sich Ebenen (ein Kegel-Band und das
 * Zylinder-Band darüber liegen auf derselben Höhe) — die Punkte werden nach
 * vtxKey entdoppelt.
 * → [{ t, pts: [p3d, …] }]
 */
export function stackLevels(bands, vkey, o) {
  const groups = [];
  for (const b of bands) {
    for (const seg of b.segs || []) {
      if (seg.type !== 'arc') continue;
      const lvl = b.levels && b.levels[seg.level];
      if (!lvl || !Number.isFinite(lvl.t)) continue;
      let g = null;
      for (const gg of groups) if (Math.abs(gg.t - lvl.t) <= o.levelTol) { g = gg; break; }
      if (!g) { g = { t: lvl.t, pts: [], seen: new Set() }; groups.push(g); }
      for (const p of seg.pts || []) {
        const k = vkey(p);
        if (g.seen.has(k)) continue;
        g.seen.add(k);
        g.pts.push(p);
      }
    }
  }
  return groups;
}

/**
 * Gemeinsame Achse eines Stapels (2D im Rahmen des Stapels):
 * EIN gemeinsamer Kreis-Fit über ALLE Ebenen des Stapels (fitCoaxial2d) —
 * eine Mitte, je Ebene ein eigener Radius. Der Einzelfit einer kurzen Ebene ist
 * entlang der Mittelsenkrechten schlecht bestimmt; der gemeinsame Fit nutzt die
 * Kopplung der Radien (Kegel: R_lo − R_hi) und liefert eine bessere Mitte.
 * Passt der Fit nicht (maxRes > tol), wird der Stapel-Hinweis verworfen
 * (je Bogen dann level.c2 wie früher).
 * → [u, v] | null
 */
function stackAxis(bands, frame, o, vkey) {
  const groups = stackLevels(bands, vkey, o);
  const levels2d = [];
  for (const g of groups) {
    const pts = [];
    for (const p of g.pts) {
      const l = toLocal(frame, p);
      pts.push([l[0], l[1]]);
    }
    // Ebenen mit weniger als DREI Punkten bestimmen die Mitte nicht (z. B. ein
    // Reststück-Band mit EINEM Segment: je Ebene nur zwei Punkte) — sie fliegen aus
    // dem Fit; ohne brauchbare Ebene(n) gibt es keinen Hinweis (die Bögen benutzen dann
    // die eigene Kreismitte level.c2, z. B. die des Eltern-Bands).
    if (pts.length >= 3) levels2d.push(pts);
  }
  if (!levels2d.length) return null;
  const K = fitCoaxial2d(levels2d);
  if (!K) return null;
  const rMax = Math.max(...K.r);
  const tol = Math.max(o.tolFitAbs, o.tolFitRel * rMax);
  if (K.maxRes > tol) return null;
  return K.c;
}

/**
 * Mittelpunkt-Hinweis für einen Bogen: die gemeinsame Achse seines Stapels,
 * umgerechnet in den Rahmen des Bogens (die Rahmen sind je Stapel gleich).
 * → [u, v] | null
 */
function arcHint(rec, info) {
  if (!info || !info.c || !rec || !rec.frame || !rec.level) return null;
  const fs = info.frame, fa = rec.frame;
  const t = rec.level.t;
  if (!Number.isFinite(t)) return null;
  const tS = t * dot(fs.d, fa.d);                         // Höhe im Stapel-Rahmen
  const P = add(add(mul(fs.e1, info.c[0]), mul(fs.e2, info.c[1])), mul(fs.d, tS));
  return [dot(P, fa.e1), dot(P, fa.e2)];
}

/**
 * Pläne je gültigem Band bauen.
 *
 * fds2   — Flächenliste: die Deckflächen werden über ihre Bogen-Kante gefunden
 *          (Klon aus applyArcBands) oder sonst über den Index; die Normalen der
 *          Band-Facetten kommen aus band.facets — das sind Indizes der ORIGINAL-
 *          Liste (die auch validateArcBands gesehen hat).
 * det    — Ergebnis von validateArcBands.
 * written(p) → [x,y,z] — die geschriebenen Koordinaten eines Punkt-Objekts.
 *
 * → { plans, geoms, failed }   failed = Set der band.id
 */
export function buildArcPlans(fds2, det, written, opts) {
  const o = { ...ARC_DEFAULTS, ...opts };
  const vkey = vtxKeyOf(o);
  const list = fds2 || [];
  const arcs = det && det.arcs instanceof Map ? det.arcs : new Map();
  const wr = (p) => (typeof written === 'function' ? written(p) : [p[0], p[1], p[2]]);
  const failed = new Set();
  const geoms = new Map();

  // 0. Gemeinsame Achse je Bogen-Stapel → Mittelpunkt-Hinweis je Bogen
  const { rootOf, groups } = arcStacks((det && det.bands) || [], arcs);
  const stackInfo = new Map();                             // root → { frame, c }
  for (const [root, bs] of groups) {
    const frame = bs[0] && bs[0].frame;
    if (!frame) continue;
    stackInfo.set(root, { frame, c: stackAxis(bs, frame, o, vkey) });
  }
  const hints = new Map();                                 // arcKey → [u,v]
  for (const [key, rec] of arcs) {
    const ow = (rec && rec.owners) || [];
    const root = ow.length ? rootOf.get(ow[0].band) : undefined;
    const h = arcHint(rec, root === undefined ? null : stackInfo.get(root));
    if (h) hints.set(key, h);
  }
  // Reststück-Bänder (alignBands): ihr Bogen ist ein Stück des Eltern-Bogens → sie
  // übernehmen dessen Hinweis (die gemeinsame Achse des Bogen-Stapels). Sonst wäre
  // ihr eigener Stapel (je Ebene nur zwei Punkte) unbestimmt und der Bogen läge auf
  // einem anderen Kreis als der des Eltern-Bands.
  for (const band of (det && det.bands) || []) {
    const sp = band.stackParent;
    if (!sp) continue;
    for (const seg of band.segs || []) {
      if (seg.type !== 'arc') continue;
      const pk = sp[seg.level];
      if (!pk) continue;
      const h = hints.get(pk);
      if (h) hints.set(seg.arcKey, h);
    }
  }

  // 1. Exakte Geometrie je Bogen (aus den geschriebenen Endpunkten)
  for (const [key, rec] of arcs) {
    const raw = (rec && rec.pts) || [];
    if (raw.length < 2) { geoms.set(key, null); failOwners(rec, failed); continue; }
    const Aw = wr(raw[0]);
    const Bw = wr(raw[raw.length - 1]);
    const g = (Array.isArray(Aw) && Array.isArray(Bw))
      ? arcGeometry(rec, Aw, Bw, o, hints.get(key)) : null;
    geoms.set(key, g);
    if (!g) failOwners(rec, failed);
  }

  // 2. Deckflächen: jede Probe des Bogens muss in der Flächenebene liegen
  for (const ce of (det && det.capEdits) || []) {
    const g = geoms.get(ce.arcKey);
    if (!g) continue;                                   // Eigentümer sind schon failed
    const fd = findCapFace(list, ce, vkey);
    let bad = !fd;
    if (!bad) {
      const nn = fd.normal ? norm(fd.normal) : null;
      const c = fd.centroid || centroidOf(fd.outer);
      if (!nn || !(len(nn) > 0) || !c) bad = true;
      else {
        for (const p of arcSamples(g, o.samples)) {
          if (!(Math.abs(dot(nn, sub(p, c))) <= o.surfTol)) { bad = true; break; }
        }
      }
    }
    if (bad) failOwners(arcs.get(ce.arcKey), failed);
  }

  // 3. Bandflächen + Pläne
  const plans = [];
  for (const band of (det && det.bands) || []) {
    if (failed.has(band.id)) continue;
    const segs = band.segs || [];
    const loSeg = segs.find((s) => s.type === 'arc' && s.level === 'lo');
    const hiSeg = segs.find((s) => s.type === 'arc' && s.level === 'hi');
    if (!loSeg || !hiSeg) { failed.add(band.id); continue; }
    const gLo = geoms.get(loSeg.arcKey);
    const gHi = geoms.get(hiSeg.arcKey);
    const surf = bandSurface(band, gLo, gHi, o);
    if (!surf) { failed.add(band.id); continue; }

    // Proben: lo entlang segs[0], hi entlang segs[2] UMGEDREHT (Hk über Lk)
    const K = Math.max(8, 2 * (band.nSegs || 0));
    const L = arcSamples(gLo, K);
    if (vkey(loSeg.pts[0]) !== vkey(gLo.A)) L.reverse();
    const H = arcSamples(gHi, K);
    if (vkey(hiSeg.pts[hiSeg.pts.length - 1]) !== vkey(gHi.A)) H.reverse();

    const tris = [];
    for (let k = 0; k < K; k++) {
      tris.push([L[k], L[k + 1], H[k + 1]]);
      tris.push([L[k], H[k + 1], H[k]]);
    }
    // Orientierung: Normale des ersten Dreiecks gegen Σ Facetten-Normalen
    if (tris.length) {
      let ref = [0, 0, 0];
      for (const fi of band.facets || []) {
        const fd = list[fi];
        if (fd && fd.normal) ref = add(ref, fd.normal);
      }
      if (!(len(ref) > 1e-12)) {                        // Rückfall: radial nach außen
        const x = sub(tris[0][0], surf.loc);
        ref = sub(x, mul(surf.axis, dot(x, surf.axis)));
      }
      const n0 = cross(sub(tris[0][1], tris[0][0]), sub(tris[0][2], tris[0][0]));
      if (dot(n0, ref) < 0) {
        for (const t of tris) { const tmp = t[1]; t[1] = t[2]; t[2] = tmp; }
      }
    }
    let area = 0;
    for (const t of tris) {
      area += 0.5 * len(cross(sub(t[1], t[0]), sub(t[2], t[0])));
    }

    // Pfeilhöhe (beide Polygonzüge) und Volumen-Differenz Zylinder/Kegel
    let sag = 0;
    for (const [chain, g] of [[loSeg.pts, gLo], [hiSeg.pts, gHi]]) {
      for (const phi of chainAngles(chain, g)) {
        sag = Math.max(sag, g.radius * (1 - Math.cos(phi / 2)));
      }
    }
    const hBand = Math.abs((band.levels.hi.t) - (band.levels.lo.t));
    const rMean = band.kind === 'cone' ? (gLo.radius + gHi.radius) / 2 : gLo.radius;
    let dV = 0;
    for (const phi of chainAngles(loSeg.pts, gLo)) {
      dV += rMean * rMean / 2 * (phi - Math.sin(phi)) * hBand;
    }

    plans.push({
      id: band.id, band, kind: band.kind, surf, sense: band.sense,
      segs: band.segs, tris, area, sig: band.sig, dV, sag,
    });
  }
  return { plans, geoms, failed };
}

/**
 * Loop mit Bogen-Kanten auf die exakten Bogen-Punkte aufweiten:
 * für jede Kante mit arcEdges-Eintrag werden die inneren arcSamples-Punkte
 * (n Segmente) in Richtung L[i] → L[i+1] eingefügt.
 * → neue Punktliste (Original unverändert)
 */
export function expandArcLoop(L, arcEdges, geoms, vtxKey, n = 16) {
  if (!L || !L.length) return [];
  const vkey = typeof vtxKey === 'function' ? vtxKey : vtxKeyOf({});
  const N = Math.max(1, Math.floor(n) || 1);
  const out = [];
  const len = L.length;
  for (let i = 0; i < len; i++) {
    out.push(L[i]);
    if (!arcEdges) continue;
    const a = L[i], b = L[(i + 1) % len];
    const key = edgeCanonKey(vkey, a, b);
    const arcKey = arcEdges instanceof Map ? arcEdges.get(key)
      : (typeof arcEdges === 'object' ? arcEdges[key] : null);
    if (!arcKey) continue;
    const g = geoms && typeof geoms.get === 'function' ? geoms.get(arcKey) : null;
    if (!g) continue;
    let pts = arcSamples(g, N);
    const ka = vkey(a), kb = vkey(b);
    const gA = vkey(g.A), gB = vkey(g.B);
    if (ka === gB && kb === gA) pts = pts.slice().reverse();
    for (let k = 1; k < N; k++) out.push(pts[k]);
  }
  return out;
}

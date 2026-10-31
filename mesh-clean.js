/**
 * mesh-clean.js — Netz-Bereinigung „Kleinste Detailgröße“ (Mikro-Kanten entfernen).
 *
 * Läuft direkt nach parseStl, VOR simplifyMesh / Region-Growing — im Worker und in allen
 * Node-Pipelines (eine Quelle, s. region-growing.js).
 *
 * Warum: CAD-Exporte und Netz-Werkzeuge erzeugen Kanten von wenigen µm (Logo-Konturen,
 * Splitter-Dreiecke an Übergängen). Sie landen 1:1 als Kanten in der STEP. Kein Drucker bildet
 * sie ab (FDM ~0,4 mm, SLA ~0,05 mm), sie blähen die Datei auf, und strikte Kerne (ACIS/CST)
 * behandeln Kanten unter ihrer Auflösung als Punkt → Fläche wird verworfen (Kabelhalter: 962
 * Kanten < 0,01 mm in EINER Fläche, genau diese Fläche fehlte in CST).
 *
 * Verfahren: Halbkanten-Kollaps (der eine Endpunkt wandert auf den anderen — keine neuen
 * Koordinaten, Punkte auf Ebenen bleiben exakt auf ihrer Ebene). Kürzeste Kanten zuerst,
 * wiederholt, bis keine Kante < τ mehr kollabierbar ist. Schutzregeln:
 *   - nur Manifold-Kanten; Rand-/non-manifold-Punkte und Punkte mit mehreren Dreiecks-Fächern
 *     (Sanduhr) bewegen sich nie (offene Netze bleiben, wie sie sind)
 *   - Link-Bedingung: gemeinsame Nachbarn von a und b = genau die zwei Gegenpunkte → das Netz
 *     bleibt 2-mannigfaltig, keine Doppel-Dreiecke, keine Tetraeder-Faltung
 *   - Merkmale: Rang 0 glatt < Rang 1 auf scharfer Kante (genau 2 scharfe Kanten, Knick der
 *     Kantenlinie < CORNER_TURN_DEG) < Rang 2 Ecke. Es wandert immer der Punkt mit dem
 *     kleineren Rang; Ecken wandern nie; ein Punkt auf einer scharfen Kante wandert nur ENTLANG
 *     dieser Kante (a–b ist selbst scharf) — so bleiben Kantenlinien und Ecken erhalten
 *   - keine Dreiecks-Normale dreht sich um mehr als MAX_NORMAL_TURN_DEG, kein Dreieck entartet
 *   - Ebenen-Treue: b liegt in der Ebene jedes Dreiecks um a — in echten Ebenen (≥ 2 koplanare
 *     Kanten-Nachbarn) auf FLAT_DEV_MM genau, in gekrümmten Bereichen ≤ PLANE_DEV_FRAC·τ. Ebenen
 *     kippen so nie (sonst passt das Region-Growing eine schiefe Ebene ein → Selbstdurchdringung)
 *   - Volumenänderung je Kollaps: mittlere Verschiebung der Fläche um a ≤ τ/10
 *   - keine Durchdringung: die neuen Dreiecke um b schneiden kein Dreieck der Umgebung (Raster)
 *   - Spalten-Kollaps: Ring-Kanten einer Wand (Extrusion: Unterring + Oberring) werden nicht
 *     einzeln, sondern als SPALTE kollabiert — alle parallelen Kanten einer Viereck-Kette
 *     (coplanares Viereck ⇒ Kante gegenüber) wandern gemeinsam, in BEIDE Richtungen von der
 *     Startkante aus. Sonst dezimieren Ober- und Unterring unabhängig: die Punkte stehen nicht mehr
 *     übereinander, die Wand zerfällt in Fächer-Dreiecke und die Erkennung (Zylinder/Ebene)
 *     scheitert. Nur Spalten aus SCHARFEN Kanten (glatte Freiform bleibt beim Einzel-Kollaps).
 *     Transaktional: geprüft wird der Endzustand der ganzen Spalte; scheitert sie, wird sie
 *     zurückgenommen (report.columnBroken) und nur eine Splitter-Startkante (< τ/2) einzeln
 *     kollabiert (report.columnFallback); Kanten ab τ/2 bleiben dann, ebenso Kanten, deren
 *     Mantellinie an einen schon gröberen Ring stößt (Fasen-Deckring) — Mantellinien gehen vor.
 *     Lagenfest: Kandidaten nach gerundeter Länge + Punkt-Nummer sortiert, Ebenen-Toleranz ab
 *     128 mm vom Ursprung = float32-ULP (≤ 3e-5). Abschaltbar: opts.columns = false (exakt das alte
 *     Halbkanten-Verhalten). Prüfung: tests/lagen-regression.mjs (3 Körper × 12 Lagen).
 *     Gemessen 2026-10-31: Kabelhalter 218/233 → 118/131 Flächen (AN/AUS), in 5 Lagen nie
 *     schlechter als vorher; NozzleBox gleich, Skoda-Haken −1. Die erste, nicht transaktionale
 *     Fassung kippte z5 bei reiner Verschiebung von 14 auf ~260 Flächen (halbe Spalten).
 *
 * Standard τ = 0,02 mm (gemessen 2026-10-27): der Härtetest (61 Körper) bleibt exakt wie ohne
 * Bereinigung; bei 0,05 mm verlieren die fein tessellierten Rundungen m64 (Kanten 0,037 mm) und
 * x9 ihre exakte Schärfung (nur noch ≤ 0,01 mm) und das eBike seine Kanal-Stückelung (47 → 44
 * Flächen). Ein Schutz „gleichmäßiger Bögen“ (Kante läuft an beiden Enden ähnlich lang weiter)
 * wurde verworfen: am Kabelhalter sind 5178 der 5420 Kanten < 0,05 mm genau solche Ketten (feine
 * Bögen mit r 0,1–3 mm), der Schutz erodierte Kette um Kette über die Durchläufe (nicht stabil).
 *
 * Ergebnis: { mesh, report }. Ohne Kollaps wird das EINGABE-Netz (dasselbe Objekt) zurück-
 * gegeben; unveränderte Dreiecke behalten ihr Objekt und ihre exakten Koordinaten.
 */

export const DEFAULT_MIN_DETAIL_MM = 0.02;
const SHARP_DEG = 25;              // Diederwinkel ab dem eine Kante als scharf gilt
const CORNER_TURN_DEG = 35;        // Knick einer scharfen Kantenlinie ab dem ihr Punkt Ecke ist
const MAX_NORMAL_TURN_DEG = 30;    // max. Drehung einer Dreiecks-Normale je Kollaps
// Ebene Stücke (zwei Dreiecke des Fächers mit < FLAT_DEG Normalen-Unterschied): b muss in ihrer
// Ebene liegen (FLAT_DEV_MM ≈ float32-Auflösung der STL-Koordinaten bei ~100 mm)
const FLAT_DEG = 0.5;
const FLAT_DEV_MM = 1e-5;
// Ebenen-Treue: b darf höchstens so weit neben der Ebene jedes Dreiecks um a liegen (Anteil von τ)
const PLANE_DEV_FRAC = 0.02;
// Reihenfolge der Kandidaten: Länge auf dieses Raster gerundet, dann Punkt-Nummern (lagenunabhängig)
const SORT_QUANTUM_MM = 1e-4;

// −0/+0 vereinheitlichen; gleicher Schlüssel wie region-growing.js (1e-4 mm), damit die
// Topologie hier und im Region-Growing dieselbe ist.
const fz = (x) => { const s = x.toFixed(4); return s === '-0.0000' ? '0.0000' : s; };
const vtxKey = (v) => `${fz(v[0])},${fz(v[1])},${fz(v[2])}`;

/**
 * @param {{faces: Array<{normal:number[], vertices:number[][], area?:number}>}} mesh
 * @param {{minDetailMm?: number, trace?: Array, columns?: boolean}} [opts]
 *        trace: Liste für Diagnose (je Kollaps ein Eintrag); columns: false = Spalten-Kollaps aus
 */
export function cleanMesh(mesh, opts = {}) {
  const tau = opts.minDetailMm ?? DEFAULT_MIN_DETAIL_MM;
  const faces = mesh?.faces || [];
  const T = faces.length;
  const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const report = { minDetailMm: tau, inputTris: T, removedTris: 0, collapses: 0, shortBefore: 0, shortAfter: 0, minEdgeAfter: null, columnCollapses: 0, columnBroken: 0, columnFallback: 0, ms: 0 };
  if (!(tau > 0) || !T) return { mesh, report };

  // ---- Indiziertes Netz
  const keyIdx = new Map();
  const pos = [];          // Float64 je Punkt (x,y,z)
  const repr = [];         // Original-Koordinaten-Array je Punkt (für neu gebaute Dreiecke)
  const tri = new Int32Array(T * 3);
  for (let f = 0; f < T; f++) {
    const vs = faces[f].vertices;
    for (let k = 0; k < 3; k++) {
      const key = vtxKey(vs[k]);
      let i = keyIdx.get(key);
      if (i === undefined) { i = repr.length; keyIdx.set(key, i); repr.push(vs[k]); pos.push(vs[k][0], vs[k][1], vs[k][2]); }
      tri[f * 3 + k] = i;
    }
  }
  const V = repr.length;
  const P = Float64Array.from(pos);
  const alive = new Uint8Array(T).fill(1);
  const changed = new Uint8Array(T);
  const vTris = Array.from({ length: V }, () => []);
  // Topologisch entartete Dreiecke (zwei Punkte im selben 1e-4-Schlüssel): Kante < τ, weg damit
  for (let f = 0; f < T; f++) {
    const a = tri[f * 3], b = tri[f * 3 + 1], c = tri[f * 3 + 2];
    if (a === b || b === c || a === c) { alive[f] = 0; report.removedTris++; continue; }
    vTris[a].push(f); vTris[b].push(f); vTris[c].push(f);
  }

  const dist = (a, b) => Math.hypot(P[a * 3] - P[b * 3], P[a * 3 + 1] - P[b * 3 + 1], P[a * 3 + 2] - P[b * 3 + 2]);
  const ek = (a, b) => (a < b ? a * V + b : b * V + a);   // V² < 2^53 für alle realistischen Netze
  const triNormal = (f, moveFrom = -1, moveTo = -1) => {
    let i0 = tri[f * 3], i1 = tri[f * 3 + 1], i2 = tri[f * 3 + 2];
    if (i0 === moveFrom) i0 = moveTo; if (i1 === moveFrom) i1 = moveTo; if (i2 === moveFrom) i2 = moveTo;
    const ux = P[i1 * 3] - P[i0 * 3], uy = P[i1 * 3 + 1] - P[i0 * 3 + 1], uz = P[i1 * 3 + 2] - P[i0 * 3 + 2];
    const vx = P[i2 * 3] - P[i0 * 3], vy = P[i2 * 3 + 1] - P[i0 * 3 + 1], vz = P[i2 * 3 + 2] - P[i0 * 3 + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    return [nx, ny, nz, Math.hypot(nx, ny, nz)];
  };

  // ---- Kanten-Topologie und Merkmale (einmal, danach beim Kollaps fortgeschrieben)
  const edgeTris = new Map();
  for (let f = 0; f < T; f++) {
    if (!alive[f]) continue;
    for (let k = 0; k < 3; k++) {
      const key = ek(tri[f * 3 + k], tri[f * 3 + (k + 1) % 3]);
      const l = edgeTris.get(key);
      if (l) l.push(f); else edgeTris.set(key, [f]);
    }
  }
  const locked = new Uint8Array(V);
  const sharp = new Set();
  const COS_SHARP = Math.cos(SHARP_DEG * Math.PI / 180);
  for (const [key, ts] of edgeTris) {
    const a = Math.floor(key / V), b = key % V;
    if (ts.length !== 2) { locked[a] = 1; locked[b] = 1; continue; }
    const n0 = triNormal(ts[0]), n1 = triNormal(ts[1]);
    if (n0[3] < 1e-14 || n1[3] < 1e-14) continue;   // entartetes Dreieck: Winkel unbestimmt
    if ((n0[0] * n1[0] + n0[1] * n1[1] + n0[2] * n1[2]) / (n0[3] * n1[3]) < COS_SHARP) sharp.add(key);
  }
  // Sanduhr-Punkte (mehrere Dreiecks-Fächer) sperren
  for (let v = 0; v < V; v++) {
    if (locked[v] || vTris[v].length < 3) { if (vTris[v].length && vTris[v].length < 3) locked[v] = 1; continue; }
    const ts = vTris[v];
    const seen = new Set([ts[0]]);
    const stack = [ts[0]];
    while (stack.length) {
      const f = stack.pop();
      for (let k = 0; k < 3; k++) {
        const o = tri[f * 3 + k];
        if (o === v) continue;
        for (const g of edgeTris.get(ek(v, o)) || []) if (!seen.has(g)) { seen.add(g); stack.push(g); }
      }
    }
    if (seen.size !== ts.length) locked[v] = 1;
  }
  const sharpNbrs = (v) => {
    const out = [];
    for (const n of neighbors(v)) if (sharp.has(ek(v, n))) out.push(n);
    return out;
  };
  const COS_TURN = Math.cos(CORNER_TURN_DEG * Math.PI / 180);
  const rank = (v) => {
    if (locked[v]) return 3;
    const s = sharpNbrs(v);
    if (!s.length) return 0;
    if (s.length !== 2) return 2;
    // Knick der Kantenlinie in v: Richtung (s0→v) gegen (v→s1)
    const ax = P[v * 3] - P[s[0] * 3], ay = P[v * 3 + 1] - P[s[0] * 3 + 1], az = P[v * 3 + 2] - P[s[0] * 3 + 2];
    const bx = P[s[1] * 3] - P[v * 3], by = P[s[1] * 3 + 1] - P[v * 3 + 1], bz = P[s[1] * 3 + 2] - P[v * 3 + 2];
    const la = Math.hypot(ax, ay, az), lb = Math.hypot(bx, by, bz);
    if (la < 1e-12 || lb < 1e-12) return 2;
    // Tangentenpunkt (mit Spalten-Kollaps): lange Kante (Gerade, ≥ 10·τ) trifft auf eine Mikro-Kante
    // (Bogen) — wandert er, kippt die ebene Fläche an der Geraden um den Sehnen-Stich (Prisma:
    // Volumen −0,03 mm³; isFlat sieht ein einzelnes langes Viereck nicht als Ebene) → Ecke
    if (opts.columns !== false && Math.max(la, lb) >= 10 * tau && Math.min(la, lb) < tau) return 2;
    return (ax * bx + ay * by + az * bz) / (la * lb) < COS_TURN ? 2 : 1;
  };
  function neighbors(v) {
    const s = new Set();
    for (const f of vTris[v]) for (let k = 0; k < 3; k++) { const o = tri[f * 3 + k]; if (o !== v) s.add(o); }
    return s;
  }

  const COS_NTURN = Math.cos(MAX_NORMAL_TURN_DEG * Math.PI / 180);
  const planeDev = (opts.planeDevFrac ?? PLANE_DEV_FRAC) * tau;
  const COS_FLAT = Math.cos(FLAT_DEG * Math.PI / 180);
  let flatTol = FLAT_DEV_MM;          // s. unten (Raster): lagenfest mit Spalten-Kollaps
  const isFlat = (f) => {
    const n = triNormal(f);
    if (n[3] < 1e-14) return false;
    let k = 0;
    for (let e = 0; e < 3; e++) {
      for (const g of edgeTris.get(ek(tri[f * 3 + e], tri[f * 3 + (e + 1) % 3])) || []) {
        if (g === f) continue;
        const m = triNormal(g);
        if (m[3] > 1e-14 && (n[0] * m[0] + n[1] * m[1] + n[2] * m[2]) / (n[3] * m[3]) > COS_FLAT) { k++; break; }
      }
    }
    return k >= 2;
  };
  // ---- Raster der Dreiecke für die Durchdringungs-Prüfung (lokal: nur Dreiecke in der Nähe)
  // Ohne sie erzeugte der Kollaps am Kabelhalter eine Selbstdurchdringung (OCP BOPAlgo_SelfIntersect):
  // die Normalen-Prüfung sieht nur den Fächer um a, nicht eine nahe gegenüberliegende Wand.
  let bbMin = [Infinity, Infinity, Infinity], bbMax = [-Infinity, -Infinity, -Infinity];
  for (let v = 0; v < V; v++) for (let k = 0; k < 3; k++) { const x = P[v * 3 + k]; if (x < bbMin[k]) bbMin[k] = x; if (x > bbMax[k]) bbMax[k] = x; }
  const diag = Math.hypot(bbMax[0] - bbMin[0], bbMax[1] - bbMin[1], bbMax[2] - bbMin[2]) || 1;
  // Ebenen-Toleranz mit Spalten-Kollaps lagenfester: 1 float32-ULP der größten Koordinate, mindestens
  // FLAT_DEV_MM (bis 128 mm vom Ursprung unverändert), höchstens 3e-5 mm (bis 512 mm). Ab 128 mm ist
  // FLAT_DEV_MM kleiner als die Rundung der STL-Punkte: ebene Kollapse scheiterten dort zufällig
  // (r15fase 250 mm verschoben + gedreht: AN 14 → 21). Weiter draußen (1000 mm, ULP 6e-5) ließ die
  // größere Toleranz so viele Kollapse zu, dass die Ebenen kippten (rrect AN 14 → 404) → Deckel.
  // Ohne Spalten-Kollaps exakt das alte Verhalten.
  const maxAbs = Math.max(...bbMin.map(Math.abs), ...bbMax.map(Math.abs));
  flatTol = opts.columns !== false && maxAbs > 0 ? Math.min(3e-5, Math.max(FLAT_DEV_MM, 2 ** (Math.floor(Math.log2(maxAbs)) - 23))) : FLAT_DEV_MM;
  const H = Math.max(5 * tau, diag / 150);
  const grid = new Map();
  const oversize = new Set();        // Dreiecke über sehr viele Zellen: immer mitprüfen
  const cellRange = (f) => {
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let k = 0; k < 3; k++) { const v = tri[f * 3 + k]; for (let c = 0; c < 3; c++) { const x = P[v * 3 + c]; if (x < lo[c]) lo[c] = x; if (x > hi[c]) hi[c] = x; } }
    return [0, 1, 2].map((c) => [Math.floor((lo[c] - bbMin[c]) / H), Math.floor((hi[c] - bbMin[c]) / H)]);
  };
  const ckey = (i, j, k) => (i * 4096 + j) * 4096 + k;
  const gridInsert = (f) => {
    const r = cellRange(f);
    if ((r[0][1] - r[0][0] + 1) * (r[1][1] - r[1][0] + 1) * (r[2][1] - r[2][0] + 1) > 512) { oversize.add(f); return; }
    for (let i = r[0][0]; i <= r[0][1]; i++) for (let j = r[1][0]; j <= r[1][1]; j++) for (let k = r[2][0]; k <= r[2][1]; k++) {
      const key = ckey(i, j, k); const l = grid.get(key); if (l) l.push(f); else grid.set(key, [f]);
    }
  };
  // Segment p→q schneidet Dreieck (u,v,w) im Inneren (Ränder/Ecken ausgenommen)?
  const EPS = 1e-9;
  const segHitsTri = (p, q, u, v, w) => {
    const e1 = [v[0] - u[0], v[1] - u[1], v[2] - u[2]], e2 = [w[0] - u[0], w[1] - u[1], w[2] - u[2]];
    const d = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
    const h = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]];
    const det = e1[0] * h[0] + e1[1] * h[1] + e1[2] * h[2];
    if (Math.abs(det) < 1e-18) return false;           // parallel/koplanar: Normalen-Prüfung zuständig
    const inv = 1 / det;
    const s0 = [p[0] - u[0], p[1] - u[1], p[2] - u[2]];
    const bu = (s0[0] * h[0] + s0[1] * h[1] + s0[2] * h[2]) * inv;
    if (bu <= EPS || bu >= 1 - EPS) return false;
    const qv = [s0[1] * e1[2] - s0[2] * e1[1], s0[2] * e1[0] - s0[0] * e1[2], s0[0] * e1[1] - s0[1] * e1[0]];
    const bv = (d[0] * qv[0] + d[1] * qv[1] + d[2] * qv[2]) * inv;
    if (bv <= EPS || bu + bv >= 1 - EPS) return false;
    const t = (e2[0] * qv[0] + e2[1] * qv[1] + e2[2] * qv[2]) * inv;
    return t > EPS && t < 1 - EPS;
  };
  const pt = (v) => [P[v * 3], P[v * 3 + 1], P[v * 3 + 2]];
  // Seite der Punkte Q zur Ebene von A: alle echt auf einer Seite → kein Schnitt möglich
  const oneSide = (A, Q) => {
    const ux = A[1][0] - A[0][0], uy = A[1][1] - A[0][1], uz = A[1][2] - A[0][2];
    const vx = A[2][0] - A[0][0], vy = A[2][1] - A[0][1], vz = A[2][2] - A[0][2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const nl = Math.hypot(nx, ny, nz); if (nl < 1e-18) return true;
    let pos = 0, neg = 0;
    for (const q of Q) {
      const d = ((q[0] - A[0][0]) * nx + (q[1] - A[0][1]) * ny + (q[2] - A[0][2]) * nz) / nl;
      if (d > 1e-9) pos++; else if (d < -1e-9) neg++;
    }
    return pos === 3 || neg === 3;
  };
  const trisIntersect = (A, B) => {
    if (oneSide(A, B) || oneSide(B, A)) return false;
    for (let k = 0; k < 3; k++) if (segHitsTri(A[k], A[(k + 1) % 3], B[0], B[1], B[2])) return true;
    for (let k = 0; k < 3; k++) if (segHitsTri(B[k], B[(k + 1) % 3], A[0], A[1], A[2])) return true;
    return false;
  };
  // Durchdringt eines der Dreiecke um a nach dem Umzug a → b ein Dreieck der Umgebung?
  let stamp = new Int32Array(T), stampGen = 0;
  // star: zu prüfende Dreiecke (a → b umgezogen gedacht; a = −1: so, wie sie sind)
  const penetrates = (a, b, removed, star = vTris[a]) => {
    const news = [];
    for (const f of star) {
      if (removed.includes(f)) continue;
      const ids = [0, 1, 2].map((k) => (tri[f * 3 + k] === a ? b : tri[f * 3 + k]));
      const Tp = ids.map(pt);
      const lo = [0, 1, 2].map((c) => Math.min(Tp[0][c], Tp[1][c], Tp[2][c]));
      const hi = [0, 1, 2].map((c) => Math.max(Tp[0][c], Tp[1][c], Tp[2][c]));
      news.push({ ids, Tp, lo, hi });
    }
    stampGen++;
    for (const f of star) stamp[f] = stampGen;          // eigener Fächer: nicht prüfen
    const visit = (g) => {
      if (!alive[g] || stamp[g] === stampGen) return false;
      stamp[g] = stampGen;
      const g0 = tri[g * 3], g1 = tri[g * 3 + 1], g2 = tri[g * 3 + 2];
      // Achsen-Box-Vortest gegen ALLE neuen Dreiecke, dann exakter Test
      let gl0 = Infinity, gl1 = Infinity, gl2 = Infinity, gh0 = -Infinity, gh1 = -Infinity, gh2 = -Infinity;
      for (const v of [g0, g1, g2]) {
        const x = P[v * 3], y = P[v * 3 + 1], z = P[v * 3 + 2];
        if (x < gl0) gl0 = x; if (x > gh0) gh0 = x; if (y < gl1) gl1 = y; if (y > gh1) gh1 = y; if (z < gl2) gl2 = z; if (z > gh2) gh2 = z;
      }
      for (const o of news) {
        if (gh0 < o.lo[0] || gl0 > o.hi[0] || gh1 < o.lo[1] || gl1 > o.hi[1] || gh2 < o.lo[2] || gl2 > o.hi[2]) continue;
        if (o.ids.includes(g0) || o.ids.includes(g1) || o.ids.includes(g2)) continue;   // Fächer-Nachbar
        if (trisIntersect(o.Tp, [pt(g0), pt(g1), pt(g2)])) return true;
      }
      return false;
    };
    for (const nt of news) {
      const c0 = [0, 1, 2].map((c) => Math.floor((nt.lo[c] - bbMin[c]) / H));
      const c1 = [0, 1, 2].map((c) => Math.floor((nt.hi[c] - bbMin[c]) / H));
      for (let i = c0[0]; i <= c1[0]; i++) for (let j = c0[1]; j <= c1[1]; j++) for (let k = c0[2]; k <= c1[2]; k++) {
        const l = grid.get(ckey(i, j, k));
        if (l) for (const g of l) if (visit(g)) return true;
      }
    }
    // große Dreiecke: gleicher Box-Vortest wie im Raster (visit), jedes nur einmal
    for (const g of oversize) if (visit(g)) return true;
    return false;
  };

  // Kollaps a → b prüfen; liefert true, wenn zulässig
  // Link-Bedingung (rein topologisch): gemeinsame Nachbarn von a und b = genau die 2 Gegenpunkte
  const linkOk = (a, b) => {
    const ts = edgeTris.get(ek(a, b));
    if (!ts || ts.length !== 2) return false;
    const opp = new Set();
    for (const f of ts) for (let k = 0; k < 3; k++) { const o = tri[f * 3 + k]; if (o !== a && o !== b) opp.add(o); }
    if (opp.size !== 2) return false;
    const nb = neighbors(b);
    let common = 0;
    for (const n of neighbors(a)) if (nb.has(n)) { if (!opp.has(n)) return false; common++; }
    return common === 2;
  };
  const canCollapse = (a, b) => {
    if (!linkOk(a, b)) return false;
    const ts = edgeTris.get(ek(a, b));
    // Normalen, Entartung, Volumen
    let dV = 0, area = 0;
    const bx = P[b * 3], by = P[b * 3 + 1], bz = P[b * 3 + 2];
    // Dreiecke in echten Ebenen: mindestens 2 ihrer 3 Kanten-Nachbarn sind koplanar (< FLAT_DEG).
    // (Streifen eines fein facettierten Zylinders haben nur 1 koplanaren Nachbarn — ihr Quad-Partner.)
    const flat = vTris[a].map((f) => isFlat(f));
    let si = -1;
    let inPlane = true;      // b liegt in der Ebene JEDES Dreiecks um a
    for (const f of vTris[a]) {
      si++;
      if (f === ts[0] || f === ts[1]) { area += triNormal(f)[3] / 2; continue; }
      const o = triNormal(f), n = triNormal(f, a, b);
      area += o[3] / 2;
      // Ebenen-Treue: b muss (fast) in der Ebene jedes Dreiecks um a liegen — sonst zöge der Kollaps
      // eine Ebene schief (Tangentialpunkt Rundung/Ebene: eBike, Kante 0.009 mm am Rundungs-Ende)
      // In ebenen Stücken streng (float32-Genauigkeit): sonst kippt die Ebene um µm, das Region-
      // Growing passt eine schiefe Ebene ein, und die Nachbarkante sticht hindurch (Kabelhalter,
      // OCP BOPAlgo_SelfIntersect bei 1e-3 mm Spielraum).
      if (n[3] < 1e-12) return false;
      if (o[3] > 1e-14) {
        const dx = bx - P[a * 3], dy = by - P[a * 3 + 1], dz = bz - P[a * 3 + 2];
        const dev = Math.abs(dx * o[0] + dy * o[1] + dz * o[2]) / o[3];
        if (dev > (flat[si] ? flatTol : planeDev)) return false;
        if (dev > flatTol) inPlane = false;
      }
      if (o[3] > 1e-14 && (o[0] * n[0] + o[1] * n[1] + o[2] * n[2]) / (o[3] * n[3]) < COS_NTURN) return false;
      // Volumen-Änderung: Tetraeder (alte Fläche, b) — a wandert nach b
      const i0 = tri[f * 3], i1 = tri[f * 3 + 1], i2 = tri[f * 3 + 2];
      const px = P[a * 3] - bx, py = P[a * 3 + 1] - by, pz = P[a * 3 + 2] - bz;
      // Wicklungsreihenfolge (a, U, W)
      let U, W;
      if (i0 === a) { U = i1; W = i2; } else if (i1 === a) { U = i2; W = i0; } else { U = i0; W = i1; }
      const ux = P[U * 3] - bx, uy = P[U * 3 + 1] - by, uz = P[U * 3 + 2] - bz;
      const wx = P[W * 3] - bx, wy = P[W * 3 + 1] - by, wz = P[W * 3 + 2] - bz;
      dV += (px * (uy * wz - uz * wy) + py * (uz * wx - ux * wz) + pz * (ux * wy - uy * wx)) / 6;
    }
    if (area > 0 && Math.abs(dV) / area > tau / 10) return false;
    // Rein ebener Umzug ohne Kippen: der neue Fächer deckt genau die Fläche des alten → kann nichts
    // Neues durchdringen; nur sonst die (teure) Raster-Prüfung
    if (!inPlane && penetrates(a, b, ts)) return false;
    return true;
  };

  // Zustand sichern, den doCollapse(a, b) ändert → restore() stellt ihn exakt wieder her
  // (Spalten-Kollaps transaktional: scheitert ein späterer Zug, wird die ganze Spalte
  // zurückgenommen). Das Raster bleibt (Obermenge, stört nicht).
  const snapshot = (a, b) => {
    const fs = new Set(vTris[a]);
    for (const f of edgeTris.get(ek(a, b)) || []) fs.add(f);
    const vs = new Set([a, b]);
    for (const f of fs) for (let k = 0; k < 3; k++) vs.add(tri[f * 3 + k]);
    const tv = new Set(vs);
    for (const f of vTris[b]) for (let k = 0; k < 3; k++) tv.add(tri[f * 3 + k]);
    const keys = new Set();
    for (const f of fs) for (let k = 0; k < 3; k++) {
      const p = tri[f * 3 + k], q = tri[f * 3 + (k + 1) % 3];
      keys.add(ek(p, q)); keys.add(ek(p === a ? b : p, q === a ? b : q));
    }
    const sk = new Set();
    for (const n of neighbors(a)) { sk.add(ek(a, n)); if (n !== b) sk.add(ek(b, n)); }
    const triS = [...fs].map((f) => [f, tri[f * 3], tri[f * 3 + 1], tri[f * 3 + 2], alive[f], changed[f]]);
    const vtS = [...vs].map((v) => [v, vTris[v].slice()]);
    const toS = [...tv].map((v) => [v, touched[v]]);
    const edS = [...keys].map((k) => [k, edgeTris.has(k) ? edgeTris.get(k).slice() : null]);
    const shS = [...sk].map((k) => [k, sharp.has(k)]);
    const rem = report.removedTris, col = report.collapses;
    return () => {
      for (const [f, i0, i1, i2, al, chg] of triS) { tri[f * 3] = i0; tri[f * 3 + 1] = i1; tri[f * 3 + 2] = i2; alive[f] = al; changed[f] = chg; }
      for (const [v, l] of vtS) vTris[v] = l;
      for (const [v, t] of toS) touched[v] = t;
      for (const [k, l] of edS) { if (l) edgeTris.set(k, l); else edgeTris.delete(k); }
      for (const [k, s] of shS) { if (s) sharp.add(k); else sharp.delete(k); }
      report.removedTris = rem; report.collapses = col;
    };
  };

  const doCollapse = (a, b) => {
    const ts = edgeTris.get(ek(a, b)).slice();   // Kopie: die Liste wird unten geleert
    // Kanten-Buchführung: Kanten von a abmelden
    for (const f of vTris[a]) for (let k = 0; k < 3; k++) {
      const p = tri[f * 3 + k], q = tri[f * 3 + (k + 1) % 3];
      const key = ek(p, q); const l = edgeTris.get(key);
      if (l) { const i = l.indexOf(f); if (i >= 0) l.splice(i, 1); if (!l.length) edgeTris.delete(key); }
    }
    // Scharfe Kanten von a auf b umhängen
    for (const n of neighbors(a)) {
      const key = ek(a, n);
      if (sharp.has(key)) { sharp.delete(key); if (n !== b) sharp.add(ek(b, n)); }
    }
    for (const f of ts) {
      alive[f] = 0; report.removedTris++;
      for (let k = 0; k < 3; k++) { const v = tri[f * 3 + k]; const l = vTris[v]; const i = l.indexOf(f); if (i >= 0) l.splice(i, 1); }
    }
    // Kanten-Buchführung: die beiden entfernten Dreiecke hängen auch an Kanten von b/opp ab
    for (const f of ts) for (let k = 0; k < 3; k++) {
      const p = tri[f * 3 + k], q = tri[f * 3 + (k + 1) % 3];
      if (p === a || q === a) continue;
      const key = ek(p, q); const l = edgeTris.get(key);
      if (l) { const i = l.indexOf(f); if (i >= 0) l.splice(i, 1); if (!l.length) edgeTris.delete(key); }
    }
    for (const f of vTris[a]) {
      for (let k = 0; k < 3; k++) if (tri[f * 3 + k] === a) tri[f * 3 + k] = b;
      changed[f] = 1;
      vTris[b].push(f);
      gridInsert(f);                 // neue Lage ins Raster (alte Einträge stören nicht: Obermenge)
      for (let k = 0; k < 3; k++) {
        const key = ek(tri[f * 3 + k], tri[f * 3 + (k + 1) % 3]);
        const l = edgeTris.get(key);
        if (l) l.push(f); else edgeTris.set(key, [f]);
      }
    }
    vTris[a] = [];
    report.collapses++;
    // Umgebung als verändert markieren (abgelehnte Kanten dort werden erneut geprüft)
    for (const f of vTris[b]) for (let k = 0; k < 3; k++) touched[tri[f * 3 + k]] = report.collapses;
  };

  // ---- Spalten-Kollaps: parallele Ring-Kanten einer Wand GEMEINSAM kollabieren
  // Ein Viereck {a,b,x,y} aus zwei coplanaren Dreiecken (f auf a-b und Nachbar h):
  // die Kante gegenüber a-b ist {x,y}. Ist sie selbst eine Mikro-Kante, gehört sie zur
  // selben Spalte (Ring-Kante unten zu Ring-Kante oben) und wird mit kollabiert — sonst
  // dezimieren Ober- und Unterring unabhängig, die Punkte stehen nicht mehr übereinander
  // und die Wand zerfällt in Fächer-Dreiecke (Erkennung Zylinder/Ebene scheitert).
  const COS_QUAD = Math.cos(0.05 * Math.PI / 180);
  const third = (f, u, v) => {
    for (let k = 0; k < 3; k++) { const w = tri[f * 3 + k]; if (w !== u && w !== v) return w; }
    return -1;
  };
  // Partner-Kante von a-b: {from,to} = Kante gegenüber a-b im Viereck (from auf a-Seite)
  const quadPartner = (a, b, f) => {
    const ts = edgeTris.get(ek(a, b));
    if (!ts || ts.length !== 2 || ts.indexOf(f) < 0) return null;
    const nf = triNormal(f);
    if (nf[3] < 1e-14) return null;
    const x = third(f, a, b);
    if (x < 0) return null;
    let longRes = null;
    for (let e = 0; e < 2; e++) {
      // Nachbar über (a,x) bzw. (b,x)
      const u = e === 0 ? a : b, v = x;
      const l = edgeTris.get(ek(u, v));
      if (!l || l.length !== 2) continue;
      for (const h of l) {
        if (h === f || !alive[h]) continue;
        const nh = triNormal(h);
        if (nh[3] < 1e-14) continue;
        if ((nf[0] * nh[0] + nf[1] * nh[1] + nf[2] * nh[2]) / (nf[3] * nh[3]) < COS_QUAD) continue;   // coplanar?
        const y = third(h, u, v);
        if (y < 0 || y === a || y === b) continue;
        // Partner: der Punkt aus {x,y}, der mit a (bzw. b) über eine Viereck-SEITE verbunden ist
        const pA = e === 0 ? y : x, pB = e === 0 ? x : y;
        if (pA === a || pA === b || pB === a || pB === b) continue;
        if (!edgeTris.has(ek(pA, pB))) continue;
        if (dist(pA, pB) < tau) return { from: pA, to: pB };
        // Partner ist KEINE Mikro-Kante: gehört nicht in die Spalte (s. column/blocked) — merken,
        // aber weiter nach einem Mikro-Partner suchen
        if (!longRes) longRes = { from: pA, to: pB, long: true };
      }
    }
    return longRes;
  };
  // Kette der Spalte: [[a,b],[d,c],…] — jeder Zug = von → nach (von auf a-Seite)
  // In BEIDE Richtungen: Start a-b über das eine Dreieck (z. B. Wand nach oben) und über das
  // andere (Fase nach unten) — beginnt die Spalte an einem mittleren Ring, fehlte sonst eine Hälfte
  // und die Ringe dünnten wieder unabhängig aus (lagenabhängig: welche Hälfte, hing an der
  // Reihenfolge in edgeTris).
  const column = (a, b) => {
    const moves = [[a, b]];
    const seen = new Set([a, b]);
    const ts0 = edgeTris.get(ek(a, b));
    if (!ts0 || ts0.length !== 2) return moves;
    for (const first of ts0.slice()) {
      let from = a, to = b, only = first;
      for (;;) {
        const ts = edgeTris.get(ek(from, to));
        if (!ts || ts.length !== 2) break;
        let res = null;
        for (const f of (only >= 0 ? [only] : ts)) {
          const r = quadPartner(from, to, f);
          if (!r) continue;
          if (r.from === from || r.from === to || r.to === from || r.to === to) continue;
          if (seen.has(r.from) || seen.has(r.to)) continue;      // bereits gelaufen
          res = r; break;
        }
        only = -1;
        if (!res) break;
        if (res.long) {
          // Mantellinie zu einem Ring, der schon gröber ist (Deckring einer Fase gegen Wandring):
          // allein kollabiert entstünde ein Fächer im Viereck-Band → blocked (s. Anwende-Schleife)
          if (sharp.has(ek(from, to)) && sharp.has(ek(res.from, res.to))) moves.blocked = true;
          break;
        }
        if (moves.length >= 64) { moves.capped = true; break; }   // zu lang: lieber keine (halbe) Spalte
        moves.push([res.from, res.to]);
        seen.add(res.from); seen.add(res.to);
        from = res.from; to = res.to;
      }
    }
    return moves;
  };

  // ---- Iterieren: kürzeste Kanten zuerst, bis nichts mehr geht
  // ohne Spalten-Kollaps exakt das alte Verhalten (ungerundete Länge)
  const sortQ = opts.sortQuantumMm ?? (opts.columns !== false ? SORT_QUANTUM_MM : 0);
  const shortEdges = () => {
    const out = [];
    for (const [key, ts] of edgeTris) {
      if (!ts.length) continue;
      const a = Math.floor(key / V), b = key % V;
      const l = dist(a, b);
      if (l < tau) out.push([sortQ > 0 ? Math.round(l / sortQ) : l, a, b, key]);
    }
    // Reihenfolge lagenunabhängig: Länge auf sortQ gerundet (float32-Rundung einer verschobenen/
    // gedrehten STL ändert gleich lange Sehnen um µm), Gleichstand nach Punkt-Nummern (aus der
    // Dreiecks-Reihenfolge, unabhängig von der Lage im Raum)
    return out.sort((p, q) => p[0] - q[0] || p[3] - q[3]);
  };
  const touched = new Int32Array(V);            // Kollaps-Zähler der letzten Änderung am Punkt
  const failedAt = new Map();                   // Kante → Kollaps-Zähler bei der letzten Ablehnung
  const changedSince = (a, b, t) => {
    if (touched[a] > t || touched[b] > t) return true;
    for (const n of neighbors(a)) if (touched[n] > t) return true;
    for (const n of neighbors(b)) if (touched[n] > t) return true;
    return false;
  };
  let cand = shortEdges();
  report.shortBefore = cand.length;
  if (cand.length) for (let f = 0; f < T; f++) if (alive[f]) gridInsert(f);
  for (let pass = 0; pass < 50 && cand.length; pass++) {
    let did = 0;
    for (const [, a, b] of cand) {
      if (!vTris[a].length || !vTris[b].length) continue;
      if (!edgeTris.has(ek(a, b))) continue;
      const l = dist(a, b);
      if (l >= tau) continue;
      const fk = ek(a, b);
      if (failedAt.has(fk) && !changedSince(a, b, failedAt.get(fk))) continue;   // nichts Neues seit der Ablehnung
      const ra = rank(a), rb = rank(b);
      const isSharp = sharp.has(ek(a, b));
      // Richtung(en) nach Rang: es wandert der Punkt mit kleinerem Rang
      const dirs = [];
      const allowed = (from, to, rf, rt, sh) => {
        if (rf >= 2) return false;                       // Ecken / gesperrte Punkte wandern nie
        if (rf === 1 && !sh) return false;               // Kantenpunkt nur entlang seiner Kante
        if (rf > rt) return false;
        return true;
      };
      if (allowed(a, b, ra, rb, isSharp)) dirs.push([a, b]);
      if (allowed(b, a, rb, ra, isSharp)) dirs.push([b, a]);
      if (dirs.length === 2 && ra !== rb) dirs.length = 1;   // nur bei gleichem Rang beide Richtungen
      let ok = false;
      for (const [from, to] of dirs) {
        if (!canCollapse(from, to)) continue;
        // Spalte: parallele Ring-Kanten der Wand gemeinsam kollabieren (Ring oben zu Ring unten)
        // Nur Spalten aus SCHARFEN Kanten (Ring-Kanten zwischen Wand und Deck-/Fasenfläche):
        // auf glatten Freiform-Netzen (Breitenkreise einer Kugel, gekrümmte Streifen) sind
        // koplanare Vierecke kein Zeichen einer Mantellinie — dort bleibt es beim Einzel-Kollaps
        // (Skoda-Haken: sonst +3 Flächen; Golden sphere_full wich ab).
        let col = (opts.columns !== false) ? column(from, to) : null;
        if (col && (col.capped || (col.length > 1 && !col.every(([p, q]) => sharp.has(ek(p, q)))))) col = null;
        // Spalte an einen gröberen Ring gebunden (Partner keine Mikro-Kante): Kanten ab τ/2 bleiben,
        // damit die Viereck-Bänder (Fase/Wand) Mantellinien behalten; kürzere fallen immer
        if (col && col.blocked && l >= tau / 2) continue;
        if (!col || col.length === 1) {
          if (opts.trace) opts.trace.push({ from: repr[from], to: repr[to], len: l, rankFrom: rank(from), rankTo: rank(to) });
          doCollapse(from, to); did++; failedAt.delete(fk); ok = true; break;
        }
        // Die Spalte wird als GANZES geprüft: die Startkante hat canCollapse bestanden; die übrigen
        // Züge vorab nur auf Rang/Richtung und Topologie (einzeln geprüft verkippt jeder Zug die
        // langen Wand-Dreiecke, deren andere Ecke auf dem noch nicht versetzten Gegenring liegt →
        // jede Wand-Spalte scheiterte an der Ebenen-Treue). Nach dem Anwenden zählt der
        // ENDZUSTAND, gemessen an den Dreiecken um jeden versetzten Punkt p (Ziel q):
        //   - kein Dreieck entartet oder dreht sich um mehr als MAX_NORMAL_TURN_DEG
        //   - echte Ebenen (flat): q liegt in der Ebene des alten Dreiecks (FLAT_DEV_MM)
        //   - gekrümmt: der entfernte Punkt p liegt höchstens planeDev neben dem neuen Dreieck
        //     (Sehnen-Stich der gröberen Facette, z5: 1,5e-4 mm). Lockerer (0,05·τ) ließ die
        //     Rundungen so grob werden, dass die AN-Schärfung nicht mehr griff (z5 AN 14 → 17)
        //   - keine Durchdringung der Umgebung (wie canCollapse)
        // Scheitert etwas, wird die ganze Spalte zurückgenommen (transaktional) und nur die
        // Startkante einzeln kollabiert — halbe Spalten entstehen so nie, und keine Mikro-Kante
        // bleibt stehen, weil ihre Spalte scheiterte.
        let good = true;
        for (let i = 1; i < col.length && good; i++) {
          const [p, q] = col[i];
          good = edgeTris.has(ek(p, q)) && dist(p, q) < tau && allowed(p, q, rank(p), rank(q), sharp.has(ek(p, q))) && linkOk(p, q);
        }
        const undo = [], tr = [];
        if (good) {
          const before = new Map();          // Dreieck → { o: alte Normale, flat, ps: versetzte Punkte darin }
          for (const [p] of col) for (const f of vTris[p]) {
            let e = before.get(f);
            if (!e) { e = { o: triNormal(f), flat: isFlat(f), ps: [] }; before.set(f, e); }
            e.ps.push(p);
          }
          const target = new Map(col.map(([p, q]) => [p, q]));
          for (let i = 0; i < col.length && good; i++) {
            const [p, q] = col[i];
            if (i > 0 && !linkOk(p, q)) { good = false; break; }
            if (opts.trace) tr.push({ from: repr[p], to: repr[q], len: dist(p, q), rankFrom: rank(p), rankTo: rank(q) });
            undo.push(snapshot(p, q));
            doCollapse(p, q);
          }
          let inPlane = true;
          if (good) for (const [f, { o, flat: fl, ps }] of before) {
            if (!alive[f] || o[3] < 1e-14) continue;
            const n = triNormal(f);
            if (n[3] < 1e-12 || (o[0] * n[0] + o[1] * n[1] + o[2] * n[2]) / (o[3] * n[3]) < COS_NTURN) { good = false; break; }
            for (const p of ps) {
              const q = target.get(p);
              const dx = P[q * 3] - P[p * 3], dy = P[q * 3 + 1] - P[p * 3 + 1], dz = P[q * 3 + 2] - P[p * 3 + 2];
              const devOld = Math.abs(dx * o[0] + dy * o[1] + dz * o[2]) / o[3];
              const dev = fl ? devOld : Math.abs(dx * n[0] + dy * n[1] + dz * n[2]) / n[3];
              if (dev > (fl ? flatTol : planeDev)) { good = false; break; }
              if (devOld > flatTol) inPlane = false;
            }
            if (!good) break;
          }
          if (good && !inPlane) {
            // nur die Dreiecke, die einen versetzten Punkt trugen (die übrigen haben sich nicht bewegt)
            const star = [...before.keys()].filter((f) => alive[f]);
            if (penetrates(-1, -1, [], star)) good = false;
          }
        }
        if (!good) {
          for (let i = undo.length - 1; i >= 0; i--) undo[i]();
          report.columnBroken++;
          // Rückfall auf den Einzel-Kollaps nur für echte Splitter (< τ/2): allein kollabiert
          // zerstört die Kante die Mantellinie ihres Bandes (Fächer statt Vierecke, die Rundung
          // wird nicht mehr erkannt); Kanten ab τ/2 bleiben dann lieber stehen
          if (l >= tau / 2 || !canCollapse(from, to)) continue;
          report.columnFallback++;
          if (opts.trace) opts.trace.push({ from: repr[from], to: repr[to], len: l, rankFrom: rank(from), rankTo: rank(to) });
          doCollapse(from, to); did++; failedAt.delete(fk); ok = true; break;
        }
        if (opts.trace) opts.trace.push(...tr);
        report.columnCollapses++;
        did++; failedAt.delete(fk); ok = true;
        break;
      }
      if (!ok) failedAt.set(fk, report.collapses);
    }
    if (!did) break;
    cand = shortEdges();
  }
  const rest = shortEdges();
  report.shortAfter = rest.length;
  let minE = Infinity;
  for (const [key, ts] of edgeTris) { if (!ts.length) continue; const l = dist(Math.floor(key / V), key % V); if (l < minE) minE = l; }
  report.minEdgeAfter = Number.isFinite(minE) ? minE : null;

  if (!report.removedTris) { report.ms = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0; return { mesh, report }; }

  // ---- Ausgabe: unveränderte Dreiecke behalten ihr Objekt, veränderte werden neu gebaut
  const outFaces = [];
  for (let f = 0; f < T; f++) {
    if (!alive[f]) continue;
    if (!changed[f]) { outFaces.push(faces[f]); continue; }
    const v0 = repr[tri[f * 3]], v1 = repr[tri[f * 3 + 1]], v2 = repr[tri[f * 3 + 2]];
    const n = triNormal(f);
    const l = n[3] || 1;
    outFaces.push({ normal: [n[0] / l, n[1] / l, n[2] / l], vertices: [v0, v1, v2], area: n[3] / 2 });
  }
  const flat = new Float32Array(outFaces.length * 9);
  let o = 0;
  for (const f of outFaces) for (const v of f.vertices) { flat[o++] = v[0]; flat[o++] = v[1]; flat[o++] = v[2]; }
  report.ms = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
  return { mesh: { ...mesh, faces: outFaces, vertices: flat }, report };
}

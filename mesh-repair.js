/**
 * mesh-repair.js — Non-manifold-Kontaktflächen („Zwillinge") entfernen.
 *
 * Problem: Werden zwei Körper flächig aneinandergefügt (Deckel auf Topf, z = 70), trägt das
 * Ergebnis die Kontaktfläche DOPPELT: die Deckfläche des unteren Körpers (Normale +z) und die
 * Bodenfläche des oberen (Normale -z) haben dieselbe Kontur. Jede Kante dieser Fläche wird von
 * VIER Dreiecken benutzt (non-manifold). Die reguläre Vereinigung (BRep) verwirft beide Flächen
 * als „innere Zwillinge" — die Wände laufen durch, jede Kante hat wieder genau 2 Dreiecke.
 *
 * Verfahren: Kanten zählen (Valenz > 2 = non-manifold) → alle Dreiecke an solchen Kanten sind
 * Saatpunkte → Flicken wachsen über Kanten mit Valenz EXAKT 2 (also innerhalb einer ebenen
 * Fläche) weiter, solange die Nachbarfläche auf derselben Seite liegt (n_f·n_g > 0) und alle
 * Punkte des kleineren Dreiecks in der Ebene des größeren liegen (Punktabstand ≤ tol).
 * Flicken mit gleicher Rand-Signatur und entgegengesetzter Orientierung sind Zwillinge: beide
 * werden gelöscht. Danach sind die Wände wieder manifold.
 *
 * Grenzen: nur deckungsgleiche Flächenpaare werden erkannt (gleiche Kontur, gleiche Fläche,
 * entgegengesetzte Normale, gleiche Randkanten umgekehrt) — eine echte Vereinigung mit
 * unterschiedlichen Konturen (Teilüberdeckung, Versatz) bleibt unangetastet. Entartete
 * Dreiecke (zwei gleiche Punkt-Schlüssel) werden nicht ausgewertet, bleiben aber im Netz.
 *
 * Robustheit (2026-10-31):
 *   - Ebenen-Toleranz = max(1e-3 mm, 8·ULP des größten Koordinatenwerts): die STL schreibt
 *     float32 — bei 12 000 mm Versatz ist die Rundung ~1,4e-3 mm, die alte feste Toleranz
 *     lief dort ins Leere.
 *   - Der 1°-Winkeltest zwischen Nachbar-Dreiecken ist weg: dünne Dreiecke (Fächer aus 720…4096
 *     Segmenten) haben nach der float32-Rundung Normalenfehler > 1°, die Fläche zerfiel in
 *     einzelne Dreiecke und die Zwillinge wurden nicht gefunden. Stattdessen gilt: gleiche
 *     Seite (n_f·n_g > 0) + alle Punkte des kleineren Dreiecks in der Ebene des größeren.
 *   - Vor dem Entfernen wird geprüft, ob danach eine Kante mit UNGERADER Valenz (1, 3, …)
 *     entstünde — das würde einen intakten Körper aufreißen. Solche Paare werden verworfen
 *     (report.rejectedPairs).
 *   - Schneller Vor-Test: ohne non-manifold Kante wird das EINGABE-Netz (dasselbe Objekt)
 *     zurückgegeben, ohne die teure Kantentabelle zu bauen.
 *
 * Ergebnis: { mesh, report }. Ohne non-manifold Kante wird das EINGABE-Netz (dasselbe Objekt)
 * zurückgegeben; sonst { ...mesh, faces: kept } mit den unveränderten Dreiecks-Objekten.
 */

export const CONTACT_PLANE_TOL_MM = 1e-3;   // Ebenen-Abstand [mm] für „flach" (Grundwert)
const COS_1 = Math.cos(Math.PI / 180);       // cos(1°) — Zwillinge müssen entgegengesetzt zeigen
const MIN_AREA = 1e-12;                      // darunter = entartetes Dreieck

// −0/+0 vereinheitlichen; gleicher Schlüssel wie mesh-clean.js (1e-4 mm), damit die Topologie
// hier und dort dieselbe ist.
const fz = (x) => { const s = x.toFixed(4); return s === '-0.0000' ? '0.0000' : s; };
const vtxKey = (v) => `${fz(v[0])},${fz(v[1])},${fz(v[2])}`;

/**
 * @param {{faces: Array<{normal:number[], vertices:number[][], area?:number}>}} mesh
 * @param {{planeTol?: number}} [opts]  planeTol = erlaubter Abstand zur Ebene [mm]
 * @returns {{mesh: object, report: object}}
 */
export function repairNonManifold(mesh, opts = {}) {
  const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const faces = mesh?.faces || [];
  const T = faces.length;
  const planeTol = Number.isFinite(opts.planeTol) ? opts.planeTol : CONTACT_PLANE_TOL_MM;
  const report = { nonManifoldEdges: 0, contactPairs: 0, removedTris: 0, nonManifoldEdgesAfter: 0, nonManifoldVerticesAfter: 0, rejectedPairs: 0, ms: 0 };
  if (!T) { report.ms = now() - t0; return { mesh, report }; }

  // ---- 1) Vertex-Index (Reihenfolge des ersten Auftretens), Originalkoordinaten für die Geometrie
  const keyIdx = new Map();
  const px = [];                            // flache Koordinaten (x,y,z je Punkt)
  const tri = new Int32Array(T * 3);
  for (let f = 0; f < T; f++) {
    const vs = faces[f].vertices;
    for (let k = 0; k < 3; k++) {
      const key = vtxKey(vs[k]);
      let i = keyIdx.get(key);
      if (i === undefined) { i = keyIdx.size; keyIdx.set(key, i); px.push(vs[k][0], vs[k][1], vs[k][2]); }
      tri[f * 3 + k] = i;
    }
  }
  const V = keyIdx.size;

  // ---- 1b) Schneller Vor-Test: gibt es überhaupt eine Kante mit mehr als zwei Dreiecken?
  // Ohne sie ist nichts zu reparieren — dann wird das EINGABE-Netz (dasselbe Objekt)
  // zurückgegeben, ohne die Kantentabelle und die Punktfächer zu bauen. Das spart bei
  // sauberen Netzen (1 Mio. Dreiecke) den größten Teil der Laufzeit.
  // Die ungerichteten Kanten werden als Schlüssel a·V+b (a<b) in ein Float64Array gelegt,
  // sortiert und nach Läufen > 2 abgesucht.
  {
    const keys = new Float64Array(T * 3);
    let n = 0;
    for (let f = 0; f < T; f++) {
      const a = tri[f * 3], b = tri[f * 3 + 1], c = tri[f * 3 + 2];
      if (a === b || b === c || a === c) continue;         // entartet: zählt nicht mit
      for (let k = 0; k < 3; k++) {
        const u = tri[f * 3 + k], v = tri[f * 3 + (k + 1) % 3];
        keys[n++] = u < v ? u * V + v : v * V + u;
      }
    }
    const sub = keys.subarray(0, n);
    sub.sort();
    let nm = false;
    for (let i = 0; i < n;) {
      let j = i + 1;
      while (j < n && sub[j] === sub[i]) j++;
      if (j - i > 2) { nm = true; break; }
      i = j;
    }
    if (!nm) {
      // nonManifoldVerticesAfter bleibt 0 — Punktfächer werden nur gezählt, wenn es
      // überhaupt eine non-manifold KANTE gab (sonst wäre das Zählen der teure Weg).
      report.ms = now() - t0;
      return { mesh, report };
    }
  }

  // ---- 1c) Ebenen-Toleranz: die binäre STL speichert float32. Bei großen Koordinaten ist
  // die Rundung (ULP ≈ maxAbs·2⁻²³) größer als die alte feste Toleranz von 1e-3 mm — die
  // Flächen wurden dort nicht mehr als eben erkannt. Also: Toleranz = max(Grundwert, 8·ULP).
  let maxAbs = 0;
  for (let i = 0; i < px.length; i++) { const a = px[i] < 0 ? -px[i] : px[i]; if (a > maxAbs) maxAbs = a; }
  const ulp = maxAbs * 2 ** -23;                     // Rundungsmaß der float32-Koordinaten [mm]
  const tol = Math.max(planeTol, 8 * ulp);

  // ---- 2) Geometrie je Dreieck: Normale aus der Wicklung (Kreuzprodukt), Fläche = |Kreuz|/2
  const nrm = new Float64Array(T * 3);
  const area = new Float64Array(T);
  const lmax = new Float64Array(T);          // längste Kante [mm] (für die Höhe/Unsicherheit)
  const degen = new Uint8Array(T);
  for (let f = 0; f < T; f++) {
    const a = tri[f * 3], b = tri[f * 3 + 1], c = tri[f * 3 + 2];
    if (a === b || b === c || a === c) { degen[f] = 1; continue; }   // entartet: nicht auswerten
    const ax = px[a * 3], ay = px[a * 3 + 1], az = px[a * 3 + 2];
    const ux = px[b * 3] - ax, uy = px[b * 3 + 1] - ay, uz = px[b * 3 + 2] - az;
    const vx = px[c * 3] - ax, vy = px[c * 3 + 1] - ay, vz = px[c * 3 + 2] - az;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    area[f] = l / 2;
    lmax[f] = Math.max(Math.hypot(ux, uy, uz), Math.hypot(vx - ux, vy - uy, vz - uz), Math.hypot(vx, vy, vz));
    if (l > 0) { nrm[f * 3] = nx / l; nrm[f * 3 + 1] = ny / l; nrm[f * 3 + 2] = nz / l; }
  }

  // ---- 3) Ungerichtete Kanten → Liste der Dreiecke (Valenz)
  const edgeId = new Map();
  const edgeTris = [];
  const triEdge = new Int32Array(T * 3);
  for (let f = 0; f < T; f++) {
    if (degen[f]) continue;
    for (let k = 0; k < 3; k++) {
      const a = tri[f * 3 + k], b = tri[f * 3 + (k + 1) % 3];
      const key = a < b ? a * V + b : b * V + a;
      let id = edgeId.get(key);
      if (id === undefined) { id = edgeTris.length; edgeId.set(key, id); edgeTris.push([]); }
      edgeTris[id].push(f);
      triEdge[f * 3 + k] = id;
    }
  }
  const E = edgeTris.length;
  const valence = new Int32Array(E);
  let nmEdges = 0;
  for (let e = 0; e < E; e++) { valence[e] = edgeTris[e].length; if (valence[e] > 2) nmEdges++; }
  report.nonManifoldEdges = nmEdges;

  // ---- Kantenzählung und Punktfächer in einem gegebenen Teilnetz (alive = Maske)
  const analyzeKept = (alive) => {
    const eMap = new Map();      // Kante → [Dreiecke]
    const vFans = new Map();     // Punkt → [Dreiecke]
    for (let f = 0; f < T; f++) {
      if (!alive[f] || degen[f]) continue;
      const a = tri[f * 3], b = tri[f * 3 + 1], c = tri[f * 3 + 2];
      const vids = [a, b, c];
      for (let k = 0; k < 3; k++) {
        const u = vids[k], v = vids[(k + 1) % 3];
        const key = u < v ? u * V + v : v * V + u;
        const l = eMap.get(key);
        if (l) l.push(f); else eMap.set(key, [f]);
      }
      for (const vi of vids) { const l = vFans.get(vi); if (l) l.push(f); else vFans.set(vi, [f]); }
    }
    let nmE = 0;
    for (const l of eMap.values()) if (l.length > 2) nmE++;
    // Punkt non-manifold, wenn sein Fächer in mehrere Gruppen zerfällt: zwei Dreiecke um v
    // gehören nur dann zusammen, wenn sie eine Kante v–w mit Valenz genau 2 teilen.
    let nmV = 0;
    for (const [vi, list] of vFans) {
      if (list.length < 2) continue;
      const seen = new Set();
      let comps = 0;
      for (const s0 of list) {
        if (seen.has(s0)) continue;
        comps++;
        if (comps > 1) { nmV++; break; }
        const stack = [s0];
        seen.add(s0);
        while (stack.length) {
          const t = stack.pop();
          for (let k = 0; k < 3; k++) {
            const u = tri[t * 3 + k], v = tri[t * 3 + (k + 1) % 3];
            if (u !== vi && v !== vi) continue;
            const key = u < v ? u * V + v : v * V + u;
            const l = eMap.get(key);
            if (!l || l.length !== 2) continue;
            const g = l[0] === t ? l[1] : l[0];
            if (!seen.has(g)) { seen.add(g); stack.push(g); }
          }
        }
      }
    }
    return { nmE, nmV };
  };

  // Ohne non-manifold Kante: nichts zu tun — das ist schon oben (Schnell-Vor-Test) erledigt:
  // dort wird das EINGABE-Netz (dasselbe Objekt) zurückgegeben, ohne Kantentabelle und
  // Punktfächer zu bauen. nonManifoldVerticesAfter bleibt dabei 0 (nur gezählt, wenn es
  // überhaupt eine non-manifold KANTE gab).

  // ---- 4) Saatpunkte: Dreiecke an einer non-manifold Kante
  const isNM = new Uint8Array(T);
  for (let f = 0; f < T; f++) {
    if (degen[f]) continue;
    for (let k = 0; k < 3; k++) if (valence[triEdge[f * 3 + k]] > 2) { isNM[f] = 1; break; }
  }

  // ---- 5) Flicken wachsen: nur über Kanten mit Valenz EXAKT 2 (in einer ebenen Fläche bleiben)
  const compatible = (f, g) => {
    if (!(area[f] > MIN_AREA) || !(area[g] > MIN_AREA)) return false;
    // Gleiche Seite (keine Rückfaltung). Der alte 1°-Test fiel bei dünnen Dreiecken
    // (Fächer aus 720…4096 Segmenten): nach der float32-Rundung war der Normalenfehler
    // größer als 1°, die Fläche zerfiel in Einzeldreiecke und die Zwillinge wurden
    // nicht mehr gefunden. Die Ebenen-Bedingung unten ersetzt den Winkeltest.
    const d = nrm[f * 3] * nrm[g * 3] + nrm[f * 3 + 1] * nrm[g * 3 + 1] + nrm[f * 3 + 2] * nrm[g * 3 + 2];
    if (!(d > 0)) return false;
    const big = area[f] >= area[g] ? f : g, small = big === f ? g : f;
    const nx = nrm[big * 3], ny = nrm[big * 3 + 1], nz = nrm[big * 3 + 2];
    const bp = tri[big * 3] * 3;                       // erster Punkt des großen Dreiecks
    const d0 = nx * px[bp] + ny * px[bp + 1] + nz * px[bp + 2];
    // Unsicherheit der Referenzebene: ist das Referenzdreieck selbst ein sehr flacher
    // „Splitter" (Ear-Clipping aus 720…4096 Segmenten), ist die float32-Rundung RELATIV zur
    // Höhe groß — die aus der Rundung berechnete Normale kippt um ~ulp/height und die
    // Referenzebene damit ebenfalls. Der erlaubte Abstand wächst deshalb mit dem Hebelarm
    // |q − p_r|, gedeckelt bei 50·tol (sonst würde die Paarprüfung zur Ebenenprüfung
    // verkommen — die bleibt beim PATCH-VALIDITY-Test, s. Schritt 6).
    const hr = 2 * area[big] / lmax[big];              // Höhe des Referenzdreiecks [mm]
    const angErr = 4 * ulp / hr;                       // Winkelunsicherheit der Normalen [rad]
    for (let k = 0; k < 3; k++) {
      const q = tri[small * 3 + k] * 3;                // Punkte des kleineren Dreiecks
      const dist = nx * px[q] + ny * px[q + 1] + nz * px[q + 2] - d0;
      const lev = Math.hypot(px[q] - px[bp], px[q + 1] - px[bp + 1], px[q + 2] - px[bp + 2]);
      const tolPair = Math.min(tol + angErr * lev, 50 * tol);
      if (Math.abs(dist) > tolPair) return false;
    }
    return true;
  };

  const patchOf = new Int32Array(T).fill(-1);
  const patches = [];
  for (let s = 0; s < T; s++) {
    if (!isNM[s] || patchOf[s] !== -1) continue;
    const id = patches.length;
    const list = [s];
    patchOf[s] = id;
    for (let q = 0; q < list.length; q++) {
      const f = list[q];
      for (let k = 0; k < 3; k++) {
        const e = triEdge[f * 3 + k];
        if (valence[e] !== 2) continue;                 // non-manifold Kante: Flicken stoppen hier
        const lst = edgeTris[e];
        const g = lst[0] === f ? lst[1] : lst[0];
        if (patchOf[g] !== -1) continue;
        if (!compatible(f, g)) continue;
        patchOf[g] = id;
        list.push(g);
      }
    }
    patches.push(list);
  }

  // ---- 6) Flicken-Kenndaten: Fläche, flächengewichtete Normale, Schwerpunkt, Rand
  const patchInfo = [];
  for (const list of patches) {
    let A = 0, nx = 0, ny = 0, nz = 0, cx = 0, cy = 0, cz = 0;
    const cnt = new Map();       // Kante → {n, u, v} (u→v = Richtung aus der Wicklung)
    const verts = [];
    const vset = new Set();
    for (const f of list) {
      const ar = area[f];
      A += ar;
      nx += ar * nrm[f * 3]; ny += ar * nrm[f * 3 + 1]; nz += ar * nrm[f * 3 + 2];
      const i0 = f * 3, i1 = f * 3 + 1, i2 = f * 3 + 2;
      const p0 = tri[i0] * 3, p1 = tri[i1] * 3, p2 = tri[i2] * 3;
      cx += ar * (px[p0] + px[p1] + px[p2]) / 3;
      cy += ar * (px[p0 + 1] + px[p1 + 1] + px[p2 + 1]) / 3;
      cz += ar * (px[p0 + 2] + px[p1 + 2] + px[p2 + 2]) / 3;
      for (let k = 0; k < 3; k++) {
        const u = tri[i0 + k], v = tri[i0 + (k + 1) % 3];
        if (!vset.has(u)) { vset.add(u); verts.push(u); }
        if (!vset.has(v)) { vset.add(v); verts.push(v); }
        const key = u < v ? u * V + v : v * V + u;
        const rec = cnt.get(key);
        if (rec) rec.n++; else cnt.set(key, { n: 1, u, v });
      }
    }
    const nl = Math.hypot(nx, ny, nz);
    const N = nl > 0 ? [nx / nl, ny / nl, nz / nl] : [0, 0, 0];
    const C = A > 0 ? [cx / A, cy / A, cz / A] : [0, 0, 0];
    const boundary = [];
    let overused = false;
    for (const rec of cnt.values()) {
      if (rec.n > 2) { overused = true; break; }
      if (rec.n === 1) boundary.push(rec);
    }
    // Gültig: ebene Fläche (alle Punkte in der Ebene), keine Kante > 2× benutzt, Rand vorhanden
    let valid = !overused && boundary.length > 0;
    if (valid && nl > 0) {
      const d0 = N[0] * C[0] + N[1] * C[1] + N[2] * C[2];
      for (const vi of verts) {
        const d = N[0] * px[vi * 3] + N[1] * px[vi * 3 + 1] + N[2] * px[vi * 3 + 2] - d0;
        if (Math.abs(d) > tol) { valid = false; break; }
      }
    }
    if (valid) {
      // Alle Dreiecke der Fläche müssen auf derselben Seite liegen (n·N > 0). Der alte
      // 1°-Test fiel bei dünnen Dreiecken nach der float32-Rundung (Normalenfehler > 1°).
      for (const f of list) {
        if (!(area[f] > MIN_AREA)) continue;
        const d = N[0] * nrm[f * 3] + N[1] * nrm[f * 3 + 1] + N[2] * nrm[f * 3 + 2];
        if (!(d > 0)) { valid = false; break; }
      }
    }
    const sig = boundary.map((r) => `${Math.min(r.u, r.v)},${Math.max(r.u, r.v)}`).sort().join(';');
    patchInfo.push({ tris: list, area: A, N, C, boundary, verts, sig, valid });
  }

  // ---- 7) Zwillinge: gleiche Rand-Signatur, entgegengesetzte Orientierung, gleiche Fläche
  const canPair = (A, B) => {
    const d = A.N[0] * B.N[0] + A.N[1] * B.N[1] + A.N[2] * B.N[2];
    // Die flächengewichteten Normalen sind genau (Reihenfolge: Fläche gewinnt gegen Rundung)
    if (!(d < -COS_1)) return false;
    // Gleicher Rand + beide eben (tol) + gegenläufig legen das Gebiet schon fest; der Flächen-Vergleich
    // ist nur Plausibilität. 1e-6 relativ war zu eng: Splitter-Fächer weit vom Ursprung (Rohr R50/R40,
    // 720 Segmente, 1000 mm Versatz) wichen um 1,6e-6 ab → Zwilling verpasst.
    const tolArea = 1e-4 * Math.max(A.area, B.area) + 1e-9;
    if (Math.abs(A.area - B.area) > tolArea) return false;
    const bset = new Set(B.boundary.map((r) => `${r.u},${r.v}`));
    for (const r of A.boundary) if (!bset.has(`${r.v},${r.u}`)) return false;
    const d0 = A.N[0] * A.C[0] + A.N[1] * A.C[1] + A.N[2] * A.C[2];
    for (const vi of B.verts) {
      const dd = A.N[0] * px[vi * 3] + A.N[1] * px[vi * 3 + 1] + A.N[2] * px[vi * 3 + 2] - d0;
      if (Math.abs(dd) > tol) return false;
    }
    return true;
  };

  const groups = new Map();
  patchInfo.forEach((info, id) => {
    if (!info.valid) return;
    const g = groups.get(info.sig);
    if (g) g.push(id); else groups.set(info.sig, [id]);
  });
  // ---- 7b) Paare sammeln — noch NICHT entfernen: erst die Ungerad-Parität prüfen (s. 7c)
  const pairs = [];
  const used = new Uint8Array(patchInfo.length);
  for (const ids of groups.values()) {
    for (let i = 0; i < ids.length; i++) {
      const ai = ids[i];
      if (used[ai]) continue;
      const A = patchInfo[ai];
      for (let j = i + 1; j < ids.length; j++) {
        const bi = ids[j];
        if (used[bi]) continue;
        if (!canPair(A, patchInfo[bi])) continue;
        used[ai] = 1; used[bi] = 1;
        pairs.push({ ai, bi, tris: [...A.tris, ...patchInfo[bi].tris], on: false });
        break;
      }
    }
  }

  // ---- 7c) Nie einen intakten Körper aufreißen: nach dem Entfernen darf keine Kante eine
  //      UNGERADE Valenz (1, 3, …) bekommen — das wäre ein Loch. Betroffen sind nur Kanten,
  //      an denen Dreiecke entfernt werden (eine schon offene Kante im Eingang bleibt offen).
  //      Beispiel: geschlossener Würfel + eine zusätzliche, umgekehrt gewickelte Kopie seiner
  //      Deckfläche — die Kopie ist der Zwilling der echten Fläche; ohne diese Prüfung
  //      verschwände die Deckfläche und der Würfel würde offen.
  const removed = new Uint8Array(T);
  const pairOfTri = new Int32Array(T).fill(-1);
  const setPair = (pi, on) => {
    const p = pairs[pi];
    p.on = on;
    for (const f of p.tris) { removed[f] = on ? 1 : 0; pairOfTri[f] = on ? pi : -1; }
  };
  for (let pi = 0; pi < pairs.length; pi++) setPair(pi, true);
  const rem = new Int32Array(E);         // Valenz NACH dem Entfernen
  const lost = new Int32Array(E);        // wie viele Dreiecke dort verschwinden
  for (let round = 0; round <= pairs.length; round++) {
    for (let e = 0; e < E; e++) { rem[e] = valence[e]; lost[e] = 0; }
    for (let f = 0; f < T; f++) {
      if (!removed[f]) continue;
      for (let k = 0; k < 3; k++) { const e = triEdge[f * 3 + k]; rem[e]--; lost[e]++; }
    }
    let bad = -1;
    for (let e = 0; e < E; e++) if (lost[e] > 0 && (rem[e] & 1)) { bad = e; break; }
    if (bad < 0) break;
    const undo = new Set();
    for (const f of edgeTris[bad]) { const pi = pairOfTri[f]; if (pi >= 0) undo.add(pi); }
    if (!undo.size) break;
    for (const pi of undo) { setPair(pi, false); report.rejectedPairs++; }
  }
  report.contactPairs = pairs.reduce((s, p) => s + (p.on ? 1 : 0), 0);

  // ---- 8) Restnetz: Mannigfaltigkeit und Punktfächer zählen
  const kept = [];
  const alive = new Uint8Array(T);
  for (let f = 0; f < T; f++) { alive[f] = removed[f] ? 0 : 1; if (alive[f]) kept.push(faces[f]); }
  report.removedTris = T - kept.length;
  const after = analyzeKept(alive);
  report.nonManifoldEdgesAfter = after.nmE;
  report.nonManifoldVerticesAfter = after.nmV;
  report.ms = now() - t0;
  if (!report.removedTris) return { mesh: { ...mesh, faces: kept }, report };
  // Flache Punktliste (parseStl: mesh.vertices, 9 Werte je Dreieck) wie in mesh-clean.js neu
  // aufbauen — sonst blieben entfernte Flächen (z. B. eine Netz-Finne) in Hüllquader und Umriss.
  if (!mesh.vertices) return { mesh: { ...mesh, faces: kept }, report };
  const flat = new Float32Array(kept.length * 9);
  let o = 0;
  for (const f of kept) for (const v of f.vertices) { flat[o++] = v[0]; flat[o++] = v[1]; flat[o++] = v[2]; }
  return { mesh: { ...mesh, faces: kept, vertices: flat }, report };
}

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
 * Fläche) weiter, solange die Nachbarflächen flach (cos 1°) und eben (Punktabstand zur Ebene
 * ≤ CONTACT_PLANE_TOL_MM) passen. Flicken mit gleicher Rand-Signatur und entgegengesetzter
 * Orientierung sind Zwillinge: beide werden gelöscht. Danach sind die Wände wieder manifold.
 *
 * Grenzen: nur deckungsgleiche Flächenpaare werden erkannt (gleiche Kontur, gleiche Fläche,
 * entgegengesetzte Normale, gleiche Randkanten umgekehrt) — eine echte Vereinigung mit
 * unterschiedlichen Konturen (Teilüberdeckung, Versatz) bleibt unangetastet. Entartete
 * Dreiecke (zwei gleiche Punkt-Schlüssel) werden nicht ausgewertet, bleiben aber im Netz.
 *
 * Ergebnis: { mesh, report }. Ohne non-manifold Kante wird das EINGABE-Netz (dasselbe Objekt)
 * zurückgegeben; sonst { ...mesh, faces: kept } mit den unveränderten Dreiecks-Objekten.
 */

export const CONTACT_PLANE_TOL_MM = 1e-3;   // Ebenen-Abstand [mm] für „flach"
const COS_1 = Math.cos(Math.PI / 180);       // cos(1°) — Flachheit zweier Flächen
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
  const report = { nonManifoldEdges: 0, contactPairs: 0, removedTris: 0, nonManifoldEdgesAfter: 0, nonManifoldVerticesAfter: 0, ms: 0 };
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

  // ---- 2) Geometrie je Dreieck: Normale aus der Wicklung (Kreuzprodukt), Fläche = |Kreuz|/2
  const nrm = new Float64Array(T * 3);
  const area = new Float64Array(T);
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

  // Ohne non-manifold Kante: nichts zu tun — dasselbe Netz-Objekt zurückgeben.
  if (!nmEdges) {
    const after = analyzeKept(new Uint8Array(T).fill(1));
    report.nonManifoldEdgesAfter = after.nmE;
    report.nonManifoldVerticesAfter = after.nmV;
    report.ms = now() - t0;
    return { mesh, report };
  }

  // ---- 4) Saatpunkte: Dreiecke an einer non-manifold Kante
  const isNM = new Uint8Array(T);
  for (let f = 0; f < T; f++) {
    if (degen[f]) continue;
    for (let k = 0; k < 3; k++) if (valence[triEdge[f * 3 + k]] > 2) { isNM[f] = 1; break; }
  }

  // ---- 5) Flicken wachsen: nur über Kanten mit Valenz EXAKT 2 (in einer ebenen Fläche bleiben)
  const compatible = (f, g) => {
    if (!(area[f] > MIN_AREA) || !(area[g] > MIN_AREA)) return false;
    const d = nrm[f * 3] * nrm[g * 3] + nrm[f * 3 + 1] * nrm[g * 3 + 1] + nrm[f * 3 + 2] * nrm[g * 3 + 2];
    if (!(d > COS_1)) return false;
    const big = area[f] >= area[g] ? f : g, small = big === f ? g : f;
    const nx = nrm[big * 3], ny = nrm[big * 3 + 1], nz = nrm[big * 3 + 2];
    const bp = tri[big * 3] * 3;                       // erster Punkt des großen Dreiecks
    const d0 = nx * px[bp] + ny * px[bp + 1] + nz * px[bp + 2];
    for (let k = 0; k < 3; k++) {
      const q = tri[small * 3 + k] * 3;                // Punkte des kleineren Dreiecks
      const dist = nx * px[q] + ny * px[q + 1] + nz * px[q + 2] - d0;
      if (Math.abs(dist) > planeTol) return false;
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
    // Gültig: ebene Fläche (alle Punkte in der Ebene), flache Normale, keine Kante > 2×, Rand da
    let valid = !overused && boundary.length > 0;
    if (valid && nl > 0) {
      const d0 = N[0] * C[0] + N[1] * C[1] + N[2] * C[2];
      for (const vi of verts) {
        const d = N[0] * px[vi * 3] + N[1] * px[vi * 3 + 1] + N[2] * px[vi * 3 + 2] - d0;
        if (Math.abs(d) > planeTol) { valid = false; break; }
      }
    }
    if (valid) {
      for (const f of list) {
        if (!(area[f] > MIN_AREA)) continue;
        const d = N[0] * nrm[f * 3] + N[1] * nrm[f * 3 + 1] + N[2] * nrm[f * 3 + 2];
        if (!(d > COS_1)) { valid = false; break; }
      }
    }
    const sig = boundary.map((r) => `${Math.min(r.u, r.v)},${Math.max(r.u, r.v)}`).sort().join(';');
    patchInfo.push({ tris: list, area: A, N, C, boundary, verts, sig, valid });
  }

  // ---- 7) Zwillinge: gleiche Rand-Signatur, entgegengesetzte Orientierung, gleiche Fläche
  const canPair = (A, B) => {
    const d = A.N[0] * B.N[0] + A.N[1] * B.N[1] + A.N[2] * B.N[2];
    if (!(d < -COS_1)) return false;
    const tol = 1e-6 * Math.max(A.area, B.area) + 1e-9;
    if (Math.abs(A.area - B.area) > tol) return false;
    const bset = new Set(B.boundary.map((r) => `${r.u},${r.v}`));
    for (const r of A.boundary) if (!bset.has(`${r.v},${r.u}`)) return false;
    const d0 = A.N[0] * A.C[0] + A.N[1] * A.C[1] + A.N[2] * A.C[2];
    for (const vi of B.verts) {
      const dd = A.N[0] * px[vi * 3] + A.N[1] * px[vi * 3 + 1] + A.N[2] * px[vi * 3 + 2] - d0;
      if (Math.abs(dd) > planeTol) return false;
    }
    return true;
  };

  const groups = new Map();
  patchInfo.forEach((info, id) => {
    if (!info.valid) return;
    const g = groups.get(info.sig);
    if (g) g.push(id); else groups.set(info.sig, [id]);
  });
  const removed = new Uint8Array(T);
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
        report.contactPairs++;
        for (const f of A.tris) removed[f] = 1;
        for (const f of patchInfo[bi].tris) removed[f] = 1;
        break;
      }
    }
  }

  // ---- 8) Restnetz: Mannigfaltigkeit und Punktfächer zählen
  const kept = [];
  const alive = new Uint8Array(T);
  for (let f = 0; f < T; f++) { alive[f] = removed[f] ? 0 : 1; if (alive[f]) kept.push(faces[f]); }
  report.removedTris = T - kept.length;
  const after = analyzeKept(alive);
  report.nonManifoldEdgesAfter = after.nmE;
  report.nonManifoldVerticesAfter = after.nmV;
  report.ms = now() - t0;
  return { mesh: { ...mesh, faces: kept }, report };
}

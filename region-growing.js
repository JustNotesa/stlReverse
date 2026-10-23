/**
 * region-growing.js — Zerlegt ein Dreiecksnetz in EBENE Regionen (normalGroups).
 *
 * Einzige Quelle für Worker, Node-Tests und Regressionstests (vorher dreifach kopiert →
 * Tests konnten grün melden, während die App anders rechnete).
 *
 * Kriterium: ein Dreieck gehört zur Region, wenn es (a) über eine Manifold-Kante an die
 * Region grenzt, (b) seine Normale ≤ PLANAR_ANGLE_DEG von der flächengewichteten MITTLEREN
 * Normale der Region abweicht und (c) alle drei Eckpunkte ≤ PLANAR_OFFSET_MM von der
 * Regions-Ebene entfernt liegen.
 *
 * Warum gegen die REGION und nicht gegen den Nachbarn (alte Variante): bei feiner
 * Tessellierung (<2° pro Facette, typisch für CAD-Export „hohe Qualität“) kettete der
 * Nachbar-zu-Nachbar-Vergleich ganze Zylindermäntel/Kugeln zu EINER „Ebene“ → kaputter
 * Export (1°-Zylinder: Mantel = 1 Fläche, nicht wasserdicht; 50k-Kugel: Export null).
 *
 * Normalen kommen aus der Wicklung (Kreuzprodukt), die in der STL gespeicherte Normale nur
 * als Rückfall für degenerierte Dreiecke. Viele Tools speichern „facet normal 0 0 0“.
 * Saat-Reihenfolge: größte Dreiecke zuerst — deren Normale ist numerisch am genauesten,
 * schmale Splitter mit verrauschter Normale werden so nie zur Bezugsfläche einer Ebene.
 */

export const PLANAR_ANGLE_DEG = 2;
export const PLANAR_OFFSET_MM = 0.05;

// −0/+0 vereinheitlichen (Naht rotationssymmetrischer Teile), wie fixZero im Exporter.
const fz = (x) => { const s = x.toFixed(4); return s === '-0.0000' ? '0.0000' : s; };
const vtxKey = (v) => `${fz(v[0])},${fz(v[1])},${fz(v[2])}`;
const edgeKey = (a, b) => { const ka = vtxKey(a), kb = vtxKey(b); return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`; };

export function buildNormalGroups(mesh, opts = {}) {
  const faces = mesh?.faces || [];
  const n = faces.length;
  if (!n) return [];
  const COS = Math.cos((opts.angleDeg ?? PLANAR_ANGLE_DEG) * Math.PI / 180);
  const OFF = opts.offsetMm ?? PLANAR_OFFSET_MM;

  // Normale (Wicklung) + Fläche je Dreieck
  const triN = new Float64Array(n * 3);
  const triA = new Float64Array(n);
  const valid = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const [a, b, c] = faces[i].vertices;
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    if (l > 1e-12) {
      triN[i * 3] = nx / l; triN[i * 3 + 1] = ny / l; triN[i * 3 + 2] = nz / l;
      triA[i] = l / 2; valid[i] = 1;
    } else {
      const s = faces[i].normal || [0, 0, 0];
      const sl = Math.hypot(s[0], s[1], s[2]);
      if (sl > 1e-9) { triN[i * 3] = s[0] / sl; triN[i * 3 + 1] = s[1] / sl; triN[i * 3 + 2] = s[2] / sl; }
      triA[i] = 0; // degeneriert: nie Saat, wächst nirgends mit (eigene Gruppe)
    }
  }

  // Manifold-Adjazenz (Kanten mit genau 2 Dreiecken)
  const edgeToTris = new Map();
  for (let i = 0; i < n; i++) {
    const vs = faces[i].vertices;
    for (let k = 0; k < 3; k++) {
      const ek = edgeKey(vs[k], vs[(k + 1) % 3]);
      let e = edgeToTris.get(ek);
      if (!e) { e = []; edgeToTris.set(ek, e); }
      e.push(i);
    }
  }
  const adj = Array.from({ length: n }, () => []);
  for (const t of edgeToTris.values()) {
    if (t.length !== 2) continue;
    adj[t[0]].push(t[1]); adj[t[1]].push(t[0]);
  }

  // Saat-Reihenfolge: Fläche absteigend (stabil nach Index)
  const order = Array.from({ length: n }, (_, i) => i).sort((p, q) => (triA[q] - triA[p]) || (p - q));

  const visited = new Uint8Array(n);
  const regions = [];
  for (const seed of order) {
    if (visited[seed]) continue;
    visited[seed] = 1;
    const members = [seed];
    if (valid[seed]) {
      // Laufende Regions-Ebene: Σ A·n (Richtung) und Σ A·centroid
      let sx = triN[seed * 3] * triA[seed], sy = triN[seed * 3 + 1] * triA[seed], sz = triN[seed * 3 + 2] * triA[seed];
      const cen = (i) => { const [a, b, c] = faces[i].vertices; return [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3]; };
      let c0 = cen(seed);
      let cx = c0[0] * triA[seed], cy = c0[1] * triA[seed], cz = c0[2] * triA[seed], sa = triA[seed];
      const queue = [seed];
      while (queue.length) {
        const cur = queue.pop();
        for (const nb of adj[cur]) {
          if (visited[nb] || !valid[nb]) continue;
          const sl = Math.hypot(sx, sy, sz) || 1;
          const mx = sx / sl, my = sy / sl, mz = sz / sl;
          if (triN[nb * 3] * mx + triN[nb * 3 + 1] * my + triN[nb * 3 + 2] * mz < COS) continue;
          const d = (mx * cx + my * cy + mz * cz) / sa; // Ebenen-Offset der Region
          let inPlane = true;
          for (const v of faces[nb].vertices) {
            if (Math.abs(mx * v[0] + my * v[1] + mz * v[2] - d) > OFF) { inPlane = false; break; }
          }
          if (!inPlane) continue;
          visited[nb] = 1; members.push(nb); queue.push(nb);
          const A = triA[nb];
          sx += triN[nb * 3] * A; sy += triN[nb * 3 + 1] * A; sz += triN[nb * 3 + 2] * A;
          const c = cen(nb); cx += c[0] * A; cy += c[1] * A; cz += c[2] * A; sa += A;
        }
      }
    }
    // Gruppen-Normale: flächengewichtetes Mittel der Wicklungs-Normalen (bei rein
    // degenerierter Gruppe der Rückfall-Wert bzw. Nullvektor → Exporter überspringt sie).
    let gx = 0, gy = 0, gz = 0;
    const vertices = [];
    for (const t of members) {
      const w = triA[t] || 1e-12;
      gx += triN[t * 3] * w; gy += triN[t * 3 + 1] * w; gz += triN[t * 3 + 2] * w;
      for (const v of faces[t].vertices) vertices.push(v);
    }
    const gl = Math.hypot(gx, gy, gz);
    regions.push({ normal: gl > 1e-15 ? [gx / gl, gy / gl, gz / gl] : [0, 0, 0], vertices });
  }

  // KEIN Mindestgrößen-Filter: ebene Rechtecke bestehen in STLs typisch aus genau
  // 2 Dreiecken (ein >=3-Filter löschte Würfelwände, Bug 2026-06-12).
  return regions.sort((a, b) => b.vertices.length - a.vertices.length);
}

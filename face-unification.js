/**
 * face-unification.js — Pure-JS Pendant zu OCCT ShapeUpgrade_UnifySameDomain.
 *
 * Eingabe: normalGroups (aus Region-Growing in analysis-worker.js)
 *   - Jede Gruppe hat { normal: [x,y,z], vertices: [[x,y,z], ...] } (Dreiecks-Vertices flach)
 *
 * Ausgabe: unifiedGroups — gleiche Struktur, aber:
 *   - Gruppen mit identischer Ebenen-Gleichung (Normal + Offset) werden fusioniert
 *   - Region-Growing fusioniert nur topologisch verbundene Dreiecke. Face Unification
 *     vereinigt zusätzlich *räumlich getrennte* koplanare Patches (z.B. zwei Flächen
 *     die sich einen Loop-Durchbruch teilen oder durch ein anderes Feature getrennt sind).
 *
 * Effekt auf buildVolumeStepBrepV2: ADVANCED_FACEs die auf der gleichen PLANE liegen
 * landen im selben Loop-Extraction-Pass → extractGroupFaces kann bei Bedarf mehrere
 * Outer-Bounds + Holes korrekt nesten (Parent/Child-Polygon-Logik ist bereits drin).
 */

// Quantize a unit normal onto a finite grid so "nearly parallel" normals hash equal.
// NORMAL_QUANT = 200 → ~0.3° Winkel-Toleranz (1/200 in z-Komponente ≈ 0.005).
const NORMAL_QUANT = 200;
// Signed plane offset (normal · point) quantized to this step (mm). 0.02 mm = 20 µm.
const OFFSET_QUANT_MM = 0.02;

const EPS = 1e-9;

function normalizeNormal(n) {
  const l = Math.hypot(n[0], n[1], n[2]) || 1;
  return [n[0] / l, n[1] / l, n[2] / l];
}

// Canonicalize orientation: force first non-zero component positive so +n and -n
// (anti-parallel normals from opposite winding) do NOT get merged — we want them
// to stay separate because their facing direction is physically distinct.
// (If a surface genuinely has two-sided coplanar patches, region-growing had
//  no chance to merge them either — they are legitimately separate faces.)
function quantizeNormal(n) {
  const [x, y, z] = normalizeNormal(n);
  return [
    Math.round(x * NORMAL_QUANT),
    Math.round(y * NORMAL_QUANT),
    Math.round(z * NORMAL_QUANT)
  ];
}

function planeOffset(normal, point) {
  const n = normalizeNormal(normal);
  return n[0] * point[0] + n[1] * point[1] + n[2] * point[2];
}

function centroidOfVertices(verts) {
  if (!verts.length) return [0, 0, 0];
  let x = 0, y = 0, z = 0;
  for (const v of verts) { x += v[0]; y += v[1]; z += v[2]; }
  const k = 1 / verts.length;
  return [x * k, y * k, z * k];
}

/**
 * unifyCoplanarGroups(groups, opts?) → { unified, stats }
 *
 * @param {Array<{normal: number[], vertices: number[][]}>} groups
 * @param {object} [opts]
 * @param {number} [opts.offsetTolMm=0.05] Signed-offset tolerance in mm.
 * @returns {{ unified: Array, stats: { inputGroups, outputGroups, mergedPatches } }}
 */
export function unifyCoplanarGroups(groups, opts = {}) {
  const offsetTol = opts.offsetTolMm ?? 0.05;
  if (!Array.isArray(groups) || groups.length === 0) {
    return { unified: [], stats: { inputGroups: 0, outputGroups: 0, mergedPatches: 0 } };
  }

  // Bucket by quantized normal. Within a bucket, further bin by quantized offset.
  const byNormal = new Map();
  for (const g of groups) {
    if (!g.normal || !Array.isArray(g.vertices) || g.vertices.length < 3) continue;
    const n = normalizeNormal(g.normal);
    const c = centroidOfVertices(g.vertices);
    const offset = planeOffset(n, c);

    const nKey = quantizeNormal(n).join(',');
    if (!byNormal.has(nKey)) byNormal.set(nKey, []);
    byNormal.get(nKey).push({ group: g, normal: n, offset });
  }

  const unified = [];
  let mergedPatches = 0;

  for (const entries of byNormal.values()) {
    if (entries.length === 1) {
      unified.push(entries[0].group);
      continue;
    }
    // Sort by offset so we can cluster by a rolling tolerance window.
    entries.sort((a, b) => a.offset - b.offset);
    let clusterStart = 0;
    const emit = (i0, i1) => {
      if (i0 === i1) {
        unified.push(entries[i0].group);
        return;
      }
      // Fuse all vertices and recompute an average normal (normalized).
      let sx = 0, sy = 0, sz = 0;
      const merged = [];
      for (let k = i0; k <= i1; k++) {
        const e = entries[k];
        sx += e.normal[0];
        sy += e.normal[1];
        sz += e.normal[2];
        for (const v of e.group.vertices) merged.push(v);
        if (k > i0) mergedPatches++;
      }
      const l = Math.hypot(sx, sy, sz) || 1;
      unified.push({
        normal: [sx / l, sy / l, sz / l],
        vertices: merged,
        unified: true
      });
    };
    for (let i = 1; i < entries.length; i++) {
      if (entries[i].offset - entries[clusterStart].offset > offsetTol + EPS) {
        emit(clusterStart, i - 1);
        clusterStart = i;
      }
    }
    emit(clusterStart, entries.length - 1);
  }

  return {
    unified,
    stats: {
      inputGroups: groups.length,
      outputGroups: unified.length,
      mergedPatches
    }
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Regressionstest: Analytische Voll-Durchgangsbohrungen → CYLINDRICAL_SURFACE
//
// Schützt gezielt gegen den STILLEN Voll-Fallback bei DÜNNEN Platten (Plattendicke
// < 0.6·Bohrradius). Bug-Historie: innerMatchesRim ist radial achsen-blind; ohne
// Axial-Ebenen-Gate + per-Plan-claimed-Set matchen BEIDE Loch-Ränder denselben
// Innen-Loop → der gegenüberliegende Loop bleibt facettiert → die Kreis-Bilanz ist
// nicht (1fwd,1rev) → der globale Wasserdicht-Schutz baut ALLES facettiert neu.
//
// WARUM ein eigener Test (occt-check + Wasserdicht-Sweep reichen NICHT): der
// facettierte Fallback ist selbst wasserdicht UND occt-parsebar. Ein Sweep, der nur
// „parst occt? + watertight?" prüft, meldet GRÜN, obwohl das analytische Feature
// still verloren ging. Nur eine Assertion auf boresConverted===1 + Präsenz einer
// echten CYLINDRICAL_SURFACE hat hier Zähne. Belegt: mit zurückgenommenem Fix liefert
// washer_thin boresConverted=0 / CYLINDRICAL_SURFACE×0 — aber weiterhin watertight=true.
//
// samples/block_with_hole ist mit ~bewusst dicker Platte (t > 0.6·R) als Kontrolle
// dabei: es deckt den Dünnplatten-Pfad NICHT ab, muss aber ebenfalls analytisch
// umwandeln. Beide Fälle MÜSSEN boresConverted===1 + CYLINDRICAL_SURFACE + watertight.
//
// Läuft ohne Browser/Worker: spiegelt die Worker-Pipeline
//   parseStl → simplifyMesh → buildNormalGroups → unifyCoplanarGroups →
//   recognizePrimitives → buildVolumeStepBrepV2
// (buildNormalGroups ist im Worker eine inline-IIFE und nicht importierbar; hier mit
//  IDENTISCHEN Schwellen (cos(2°), 0.05 mm) nachgebildet — vgl. analysis-worker.js).
//
// Ausführen:  node tests/bore-analytic-regression.mjs   (Exit 0 = alle grün, 1 = Fehler)
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { parseStl, simplifyMesh } from '../analysis-core.js';
import { unifyCoplanarGroups } from '../face-unification.js';
import { recognizePrimitives } from '../primitive-recognition.js';
import { buildVolumeStepBrepV2 } from '../exporters.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SAMPLES = join(__dirname, '..', 'samples');
const MAX_FACES = 50000;

// Region-Growing über echte Ebenen — gespiegelt aus analysis-worker.js (IIFE in
// self.onmessage, dort nicht exportierbar). Schwellen MÜSSEN identisch bleiben:
//   PLANAR_COS = cos(2°), PLANAR_OFFSET_MM = 0.05.
function buildNormalGroups(mesh) {
  const faces = mesh.faces, n = faces.length;
  if (!n) return [];
  const PLANAR_COS = Math.cos(2 * Math.PI / 180);
  const PLANAR_OFFSET_MM = 0.05;
  const vtxKey = (v) => `${v[0].toFixed(4)},${v[1].toFixed(4)},${v[2].toFixed(4)}`;
  const edgeKey = (a, b) => { const ka = vtxKey(a), kb = vtxKey(b); return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`; };
  const triN = new Float32Array(n * 3), triOff = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const f = faces[i];
    const nx = f.normal[0], ny = f.normal[1], nz = f.normal[2];
    const l = Math.hypot(nx, ny, nz) || 1;
    triN[i * 3] = nx / l; triN[i * 3 + 1] = ny / l; triN[i * 3 + 2] = nz / l;
    const p0 = f.vertices[0];
    triOff[i] = (nx * p0[0] + ny * p0[1] + nz * p0[2]) / l;
  }
  const e2t = new Map();
  for (let i = 0; i < n; i++) {
    const vs = faces[i].vertices;
    for (let k = 0; k < 3; k++) {
      const ek = edgeKey(vs[k], vs[(k + 1) % 3]);
      let e = e2t.get(ek); if (!e) { e = []; e2t.set(ek, e); } e.push(i);
    }
  }
  const adj = Array.from({ length: n }, () => []);
  for (const tris of e2t.values()) {
    if (tris.length !== 2) continue;
    const [t1, t2] = tris, i1 = t1 * 3, i2 = t2 * 3;
    const cosA = triN[i1] * triN[i2] + triN[i1 + 1] * triN[i2 + 1] + triN[i1 + 2] * triN[i2 + 2];
    if (cosA < PLANAR_COS) continue;
    if (Math.abs(triOff[t1] - triOff[t2]) > PLANAR_OFFSET_MM) continue;
    adj[t1].push(t2); adj[t2].push(t1);
  }
  const visited = new Uint8Array(n), regions = [];
  for (let i = 0; i < n; i++) {
    if (visited[i]) continue;
    visited[i] = 1;
    const members = [i], q = [i];
    while (q.length) { const cur = q.pop(); for (const nb of adj[cur]) if (!visited[nb]) { visited[nb] = 1; members.push(nb); q.push(nb); } }
    let sx = 0, sy = 0, sz = 0; const vertices = [];
    for (const t of members) { const f = faces[t]; sx += f.normal[0]; sy += f.normal[1]; sz += f.normal[2]; for (const v of f.vertices) vertices.push(v); }
    const sl = Math.hypot(sx, sy, sz) || 1;
    regions.push({ normal: [sx / sl, sy / sl, sz / sl], vertices });
  }
  return regions.sort((a, b) => b.vertices.length - a.vertices.length);
}

function exportFor(file) {
  const buf = readFileSync(join(SAMPLES, file));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  let mesh = parseStl(ab, () => {});
  if (mesh.faces.length > MAX_FACES) mesh = simplifyMesh(mesh, MAX_FACES, () => {});
  let groups = buildNormalGroups(mesh);
  const { unified } = unifyCoplanarGroups(groups);
  groups = unified.sort((a, b) => b.vertices.length - a.vertices.length);
  const analysis = { normalGroups: groups };
  try { recognizePrimitives(analysis.normalGroups); } catch (e) { /* Erkennung optional — Export läuft trotzdem */ }
  const res = buildVolumeStepBrepV2(analysis);
  return { res, tris: mesh.faces.length };
}

// file → der Fall ist abgedeckt, sobald GENAU dieses analytische Verhalten gilt.
const CASES = [
  { file: 'washer_thin.stl',     note: 'dünne Platte (t < 0.6·R) — Dünnplatten-Pfad, der den Bug auslöste' },
  { file: 'block_with_hole.stl', note: 'dicke Platte (Kontrolle — deckt den Dünnplatten-Pfad NICHT ab)' },
];

let failures = 0;
const check = (label, cond) => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failures++;
};

for (const { file, note } of CASES) {
  console.log(`\n${file} — ${note}`);
  let res, tris;
  try { ({ res, tris } = exportFor(file)); }
  catch (e) { console.log(`  FAIL  Pipeline-Fehler: ${e.message}`); failures++; continue; }
  if (!res) { console.log('  FAIL  buildVolumeStepBrepV2 lieferte null'); failures++; continue; }
  const r = res.report;
  const cyl = (res.step.match(/CYLINDRICAL_SURFACE/g) || []).length;
  console.log(`  (${tris} tris) boresConverted=${r.boresConverted} CYLINDRICAL_SURFACE×${cyl} watertight=${r.watertight} faces=${r.faceCount}`);
  // Die entscheidende Assertion: das analytische Feature wurde NICHT still durch den
  // facettierten Fallback ersetzt.
  check('boresConverted === 1 (Bohrung analytisch umgewandelt, kein stiller Fallback)', r.boresConverted === 1);
  check('STEP enthält ≥1 CYLINDRICAL_SURFACE (echter Zylinder-Mantel, keine Facetten)', cyl >= 1);
  // Wasserdicht allein würde den Fallback NICHT auffangen (er ist selbst wasserdicht);
  // hier nur als zusätzliche Sicherung, dass der analytische Pfad gültige Topologie liefert.
  check('watertight === true', r.watertight === true);
}

console.log(`\n${failures === 0 ? '✅ alle Bohrungs-Regressionen grün' : `❌ ${failures} Assertion(en) fehlgeschlagen`}`);
process.exit(failures === 0 ? 0 : 1);

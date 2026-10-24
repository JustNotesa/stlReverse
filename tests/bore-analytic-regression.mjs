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
// (buildNormalGroups kommt aus dem gemeinsamen Modul region-growing.js — dasselbe wie im Worker.)
//
// Ausführen:  node tests/bore-analytic-regression.mjs   (Exit 0 = alle grün, 1 = Fehler)
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { parseStl, simplifyMesh } from '../analysis-core.js';
import { unifyCoplanarGroups } from '../face-unification.js';
import { buildNormalGroups } from '../region-growing.js';
import { recognizePrimitives } from '../primitive-recognition.js';
import { detectTubes } from '../tube-sweep.js';
import { buildVolumeStepBrepV2 } from '../exporters.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SAMPLES = join(__dirname, '..', 'samples');
const MAX_FACES = 50000;


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
  try { detectTubes(analysis.normalGroups); } catch (e) { /* Kanal-Erkennung optional, wie im Worker */ }
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

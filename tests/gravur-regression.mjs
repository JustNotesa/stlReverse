// ─────────────────────────────────────────────────────────────────────────────
// Regression für die synthetischen Gravur-Körper (tests/gravur-bodies.mjs).
//
// Die Körper werden durch die ECHTE Worker-Pipeline geschickt (parseStl → cleanMesh →
// buildNormalGroups → unifyCoplanarGroups → recognizePrimitives → detectTubes →
// buildVolumeStepBrepV2), die STEP mit occt geparst und gegen das Netz geprüft.
// Beide Defeaturing-Schalter werden gelaufen: AN (defeature: true) und AUS (false).
//
// Pro Export wird eine Zeile ausgegeben:
//   Name | AN/AUS | Flächen | wasserdicht | SURFACE_OF_LINEAR_EXTRUSION | B_SPLINE_CURVE_WITH_KNOTS |
//   report.extBands | strikte Importer-Verstöße (je Art) | ΔV(occt, Netz) | Exportzeit
//
// Prüfungen je Export (jede Abweichung wird gemeldet und zählt als Fehler, Exit-Code 1):
//   wasserdicht · 0 strikte Verstöße · occt parst die STEP · |ΔV|/V ≤ 1e-3 ·
//   Extrusionsflächen ≥ expect.minExtFaces · Flächenzahl ≤ expect.maxFaces
//
// Aufruf:  node tests/gravur-regression.mjs [--only name1,name2] [--write <zielordner>]
//          V2_EXPORTER=/pfad/exporters.js node tests/gravur-regression.mjs   (anderer Exporter)
// ─────────────────────────────────────────────────────────────────────────────
import { createRequire } from 'module';
import { pathToFileURL } from 'url';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { GRAVUR_BODIES, buildGravurMesh } from './gravur-bodies.mjs';
import { parseStl, simplifyMesh, SIMPLIFY_ABOVE, SIMPLIFY_TARGET } from '../analysis-core.js';
import { buildNormalGroups } from '../region-growing.js';
import { cleanMesh } from '../mesh-clean.js';
import { unifyCoplanarGroups } from '../face-unification.js';
import { recognizePrimitives } from '../primitive-recognition.js';
import { detectTubes } from '../tube-sweep.js';
import { checkStepStrict } from './step-strict.mjs';
import { toBinaryStl, meshVolume, triVolume } from './fixtures-v2/gen.mjs';

// Anderen Exporter prüfen (z. B. einen Fix-Kandidaten)
const { buildVolumeStepBrepV2 } = await import(
  process.env.V2_EXPORTER ? pathToFileURL(process.env.V2_EXPORTER).href : '../exporters.js'
);

const require = createRequire(import.meta.url);
const { getOcct } = require('./occt-check.cjs');

// Feine occt-Tessellierung (wie in tests/fixtures-v2/check.mjs)
const OCCT_PARAMS = { linearUnit: 'millimeter', linearDeflectionType: 'absolute_value', linearDeflection: 0.001, angularDeflection: 0.02 };
const VOL_TOL = 1e-3;               // |ΔV| / V_mesh

const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1].split(',') : null;
const writeDir = args.includes('--write') ? args[args.indexOf('--write') + 1] : null;

const origLog = console.log;
const quiet = (fn) => { console.log = () => {}; try { return fn(); } finally { console.log = origLog; } };

// Pipeline wie im Worker (tests/fixtures-v2/check.mjs)
function pipeline(mesh) {
  mesh = cleanMesh(mesh).mesh;
  if (mesh.faces.length > SIMPLIFY_ABOVE) mesh = simplifyMesh(mesh, SIMPLIFY_TARGET,  // wie analysis-worker.js
    () => {});
  const groups = unifyCoplanarGroups(buildNormalGroups(mesh)).unified
    .sort((a, b) => b.vertices.length - a.vertices.length);
  const { stats } = recognizePrimitives(groups);
  detectTubes(groups);                       // Kanal-Erkennung wie im Worker
  return { groups, stats };
}

// occt-Netz → Dreiecke
function occtTris(result) {
  const tris = [];
  for (const m of result.meshes || []) {
    const p = m.attributes.position.array, ix = m.index.array;
    const P = (i) => [p[3 * i], p[3 * i + 1], p[3 * i + 2]];
    for (let i = 0; i < ix.length; i += 3) tris.push([P(ix[i]), P(ix[i + 1]), P(ix[i + 2])]);
  }
  return tris;
}

const countOf = (text, what) => (text.match(new RegExp('=' + what + '\\(', 'g')) || []).length;

const occt = await getOcct();
const failures = [];
const lines = [];

origLog('Name                Mod faces  wt  ext  bsp extBands strict  ΔV(occt,Netz)   ms');

for (const entry of GRAVUR_BODIES) {
  if (only && !only.includes(entry.name)) continue;
  const tris = buildGravurMesh(entry);
  const buf = toBinaryStl(tris, entry.name);
  const mesh = parseStl(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), () => {});
  let vMesh = 0;
  for (const f of mesh.faces) vMesh += triVolume(...f.vertices);
  const { groups } = pipeline(mesh);

  if (writeDir) {
    mkdirSync(writeDir, { recursive: true });
    writeFileSync(join(writeDir, entry.name + '.stl'), buf);
  }

  for (const [tag, defeature] of [['AN', true], ['AUS', false]]) {
    const t0 = performance.now();
    const res = buildVolumeStepBrepV2({ normalGroups: groups, defeature });
    const exportMs = performance.now() - t0;
    if (!res) {
      lines.push(`${entry.name.padEnd(18)} ${tag.padEnd(3)} — Export lieferte null`);
      failures.push(`${entry.name} ${tag}: Export lieferte null`);
      continue;
    }
    const r = res.report, step = res.step;
    const parsed = quiet(() => occt.ReadFile('step', new Uint8Array(Buffer.from(step)), OCCT_PARAMS));
    const otris = parsed.success ? occtTris(parsed) : [];
    const vOcct = otris.length ? meshVolume(otris) : NaN;
    const dv = Number.isFinite(vOcct) && vMesh ? Math.abs(vOcct - vMesh) / Math.abs(vMesh) : NaN;
    const ext = countOf(step, 'SURFACE_OF_LINEAR_EXTRUSION');
    const bsp = countOf(step, 'B_SPLINE_CURVE_WITH_KNOTS');
    const extBands = r.extBands ?? '-';
    const strict = checkStepStrict(step, { folds: true }).violations.map((v) => v.kind);
    const kinds = {};
    for (const k of strict) kinds[k] = (kinds[k] || 0) + 1;
    const strictTxt = strict.length ? Object.entries(kinds).map(([k, n]) => `${k}:${n}`).join(' ') : '0';

    if (writeDir) writeFileSync(join(writeDir, `${entry.name}_${tag}.step`), step);

    lines.push(`${entry.name.padEnd(18)} ${tag.padEnd(3)} ${String(r.faceCount).padStart(5)} ${(r.watertight ? 'ja' : 'NEIN').padEnd(4)} ${String(ext).padStart(4)} ${String(bsp).padStart(4)} ${String(extBands).padStart(8)} ${strictTxt.padEnd(12)} ${(Number.isFinite(dv) ? dv.toExponential(2) : '-').padStart(10)} ${exportMs.toFixed(0).padStart(5)}`);

    // ── Pflichtprüfungen ──
    if (!r.watertight) {
      failures.push(`${entry.name} ${tag}: nicht wasserdicht (Rand ${r.boundaryEdges}, non-manifold ${r.nonManifoldEdges}, Orientierung ${r.orientationDefects})`);
    }
    if (strict.length) failures.push(`${entry.name} ${tag}: ${strict.length} Verstöße gegen strikte Importer (${strictTxt})`);
    if (!parsed.success) failures.push(`${entry.name} ${tag}: occt parst die STEP nicht`);
    else if (!otris.length) failures.push(`${entry.name} ${tag}: occt liefert kein Netz`);
    else if (!(dv <= VOL_TOL)) failures.push(`${entry.name} ${tag}: Volumen weicht ab: occt ${vOcct.toFixed(4)} vs Netz ${vMesh.toFixed(4)} (${dv.toExponential(2)} > ${VOL_TOL})`);
    if (ext < entry.expect.minExtFaces) failures.push(`${entry.name} ${tag}: ${ext} SURFACE_OF_LINEAR_EXTRUSION-Flächen, Soll ≥ ${entry.expect.minExtFaces}`);
    if (r.faceCount > entry.expect.maxFaces) failures.push(`${entry.name} ${tag}: ${r.faceCount} Flächen, Soll ≤ ${entry.expect.maxFaces}`);
  }
}

origLog(lines.join('\n'));
if (failures.length) {
  origLog(`\n❌ ${failures.length} Verletzungen:`);
  for (const f of failures) origLog('  ' + f);
} else {
  origLog('\n✅ alle Gravur-Körper im Soll');
}
process.exit(failures.length ? 1 : 0);


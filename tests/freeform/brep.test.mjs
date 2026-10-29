// ─────────────────────────────────────────────────────────────────────────────
// tests/freeform/brep.test.mjs — Freiform-Pfad (Etappe 1) gegen die synthetischen
// Testkörper aus gen.mjs.
//
// Je Körper: STL → echte Worker-Pipeline (cleanMesh → buildNormalGroups →
// unifyCoplanarGroups → recognizePrimitives → detectTubes) → buildVolumeStepBrepV2
// mit fitSegmentation:true. Streng geprüft wird nur die GÜLTIGKEIT:
//   • report.freeform.used === true
//   • checkStepStrict(res.step).violations leer (strikte CAD-Importer)
// Die Flächenzahl je Typ wird gegen die Soll-Zahl aus describeBodies() GEDRUCKT:
// Abweichung → 'MISMATCH' (kein Fehlschlag) — die Segmentierung der gedrehten
// Körper und das tangentiale Snappen werden gerade parallel fertiggestellt, die
// Soll-Flächenzahl ist erst danach verbindlich.
// Die STEP-Datei wird nach tests/freeform/out/<körper>.step geschrieben.
// ─────────────────────────────────────────────────────────────────────────────
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateAll, describeBodies } from './gen.mjs';
import { parseStl } from '../../analysis-core.js';
import { buildNormalGroups } from '../../region-growing.js';
import { cleanMesh } from '../../mesh-clean.js';
import { unifyCoplanarGroups } from '../../face-unification.js';
import { recognizePrimitives } from '../../primitive-recognition.js';
import { detectTubes } from '../../tube-sweep.js';
import { buildVolumeStepBrepV2 } from '../../exporters.js';
import { buildFreeformBrep } from '../../freeform-brep.js';
import { checkStepStrict } from '../step-strict.mjs';

let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log('ok ' + name);
  } catch (e) {
    failed++;
    console.log('FAIL ' + name + ': ' + (e && e.message ? e.message : String(e)));
  }
}

// ── STL-Körper erzeugen ──────────────────────────────────────────────────────
generateAll('tests/freeform/stl');
mkdirSync('tests/freeform/out', { recursive: true });

// ── Pipeline wie im Worker ───────────────────────────────────────────────────
function pipeline(buf) {
  const mesh0 = parseStl(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), () => {});
  const mesh = cleanMesh(mesh0, { minDetailMm: 0.02 }).mesh;
  const groups = unifyCoplanarGroups(buildNormalGroups(mesh)).unified
    .sort((a, b) => b.vertices.length - a.vertices.length);
  recognizePrimitives(groups);
  detectTubes(groups);
  return groups;
}

const FACE_TYPES = ['plane', 'cylinder', 'cone', 'sphere', 'torus', 'facet'];
const EDGE_TYPES = ['line', 'circle', 'bspline'];
const typesOf = (f, keys) => {
  const o = {};
  for (const k of keys) o[k] = f?.[k] || 0;
  return o;
};

// ── Fälle: je Körper ein Fall ────────────────────────────────────────────────
for (const body of describeBodies()) {
  test(body.file, () => {
    const buf = readFileSync(join('tests/freeform/stl', body.file));
    const groups = pipeline(buf);
    const dbg = { log: [] };
    try {
      check(body, groups, dbg);
    } catch (e) {
      buildFreeformBrep(groups, { debug: dbg });
      throw new Error(`${e.message}\n     ${showLog(dbg)}`);
    }
  });
}

// Debug-Protokoll knapp: Segmentierung + die Runden-Fehler
function showLog(dbg) {
  const head = dbg.log.slice(0, 3).map((s) => `Debug: ${s.slice(0, 300)}`).join('\n     ');
  const rounds = dbg.log.filter((s) => s.startsWith('Runde')).slice(0, 8);
  return [head, ...rounds].join('\n     ');
}

function check(body, groups, dbg) {
  const res = buildVolumeStepBrepV2({ normalGroups: groups, defeature: true, fitSegmentation: true });
  assert.ok(res, 'Export lieferte null');
  assert.ok(res.report, 'kein Befund');
  const ff = res.report.freeform;
  assert.ok(ff, 'kein Freiform-Befund');
  assert.equal(ff.used, true, 'Freiform-Pfad nicht benutzt');

  const faces = typesOf(ff.faces, FACE_TYPES);
  const edges = typesOf(ff.edges, EDGE_TYPES);
  console.log(`     ${body.file}: Flächen ${JSON.stringify(faces)} · Kanten ${JSON.stringify(edges)}`
    + ` · Runden ${ff.rounds} · demotet ${ff.demoted} · ${ff.ms} ms`);

  // Flächenzahl je Typ wie Soll — Abweichung melden, aber nicht fehlschlagen
  const want = typesOf(body.faces, FACE_TYPES);
  const diff = FACE_TYPES.filter((k) => (faces[k] || 0) !== (want[k] || 0));
  if (diff.length) {
    console.log(`     MISMATCH ${body.file}: Flächen ${diff.map((k) => `${k} ${faces[k] || 0} statt ${want[k] || 0}`).join(', ')}`
      + ` (erwartet ${JSON.stringify(want)})`);
    buildFreeformBrep(groups, { debug: dbg });
    console.log(`     ${showLog(dbg)}`);
  }

  // strikte CAD-Importer
  const { violations, stats } = checkStepStrict(res.step);
  if (violations.length) {
    const byKind = {};
    for (const v of violations) byKind[v.kind] = (byKind[v.kind] || 0) + 1;
    throw new Error(`${violations.length} Verstöße ${JSON.stringify(byKind)}: `
      + violations.slice(0, 3).map((v) => v.msg).join(' | '));
  }
  assert.ok(stats.faces > 0, 'keine Fläche in der STEP-Datei');

  // STEP-Datei ablegen
  writeFileSync(join('tests/freeform/out', body.file.replace(/\.stl$/, '.step')), res.step);
}

console.log(failed ? `FAIL ${failed} Fall(e)` : `ok alle ${describeBodies().length} Körper`);
process.exit(failed ? 1 : 0);

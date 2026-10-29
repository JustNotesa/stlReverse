// ─────────────────────────────────────────────────────────────────────────────
// tests/freeform/brep.test.mjs — Freiform-Pfad (Etappe 1) gegen die synthetischen
// Testkörper aus gen.mjs.
//
// Je Körper: STL → echte Worker-Pipeline (cleanMesh → buildNormalGroups →
// unifyCoplanarGroups → recognizePrimitives → detectTubes) → buildVolumeStepBrepV2
// mit fitSegmentation:true. Streng geprüft wird die GÜLTIGKEIT:
//   • report.freeform.used === true
//   • checkStepStrict(res.step).violations leer (strikte CAD-Importer)
// Für die beiden NICHT gedrehten Körper gilt zusätzlich die Soll-Flächenart
// (STRICT) — dort wird genau geprüft:
//   Platte mit Loch + Torus : {plane:6, cylinder:1, torus:1}, facet 0
//   Halbkugel + Zylinder     : {plane:1, cylinder:1, sphere:1}, facet 0
// Für die gedrehten Körper wird die Soll-Zahl nur GEMELDET (MISMATCH, kein
// Fehlschlag) — die Segmentierung der gedrehten Körper wird gerade parallel
// fertiggestellt, die Soll-Flächenzahl ist erst danach verbindlich.
//
// Zusatzfall "streifen-demotion": der Freiform-Bau wird direkt aufgerufen und
// eine Kette zwischen Zylinder und Kugel einmal scheitern gelassen
// (opts.testForceChainFail). Erwartet: nur ein STREIFEN wird demotiert —
// Zylinder- und Kugelfläche bleiben erhalten, es gibt Facetten, und die
// STEP-Datei bleibt strikt gültig.
//
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

// Soll-Flächenarten der beiden geraden Körper (strikt)
const STRICT = {
  'ff_platte_loch_torus.stl': { plane: 6, cylinder: 1, cone: 0, sphere: 0, torus: 1, facet: 0 },
  'ff_halbkugel_zylinder.stl': { plane: 1, cylinder: 1, cone: 0, sphere: 1, torus: 0, facet: 0 },
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
  const head = dbg.log.slice(0, 2).map((s) => `Debug: ${s.slice(0, 300)}`).join('\n     ');
  const rounds = dbg.log.filter((s) => s.startsWith('Runde')).slice(-12);
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
    + ` · Runden ${ff.rounds} · demotet ${ff.demoted} · Streifen ${ff.stripTris} · ${ff.ms} ms`);

  // Flächenzahl je Typ: bei den geraden Körpern strikt, sonst nur melden
  const want = STRICT[body.file];
  if (want) {
    assert.deepEqual(faces, want,
      `Flächenarten weichen ab: ${JSON.stringify(faces)} statt ${JSON.stringify(want)}`);
  } else {
    const w = typesOf(body.faces, FACE_TYPES);
    const diff = FACE_TYPES.filter((k) => (faces[k] || 0) !== (w[k] || 0));
    if (diff.length) {
      console.log(`     MISMATCH ${body.file}: Flächen ${diff.map((k) => `${k} ${faces[k] || 0} statt ${w[k] || 0}`).join(', ')}`
        + ` (erwartet ${JSON.stringify(w)})`);
    }
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

// ── Streifen-Demotion: eine Kette Zylinder↔Kugel scheitern lassen ─────────────
// Erwartung: nur die Dreiecke der schuldigen Region am Kettenverlauf werden
// Facetten — Zylinder- und Kugelfläche bleiben erhalten, die STEP bleibt gültig.
test('streifen-demotion', () => {
  const file = 'ff_halbkugel_zylinder.stl';
  const buf = readFileSync(join('tests/freeform/stl', file));
  const groups = pipeline(buf);
  const res = buildFreeformBrep(groups, { testForceChainFail: true });
  assert.ok(res, 'Freiform-Bau lieferte null');
  const ff = res.report && res.report.freeform;
  assert.ok(ff && ff.used, 'Freiform-Pfad nicht benutzt');
  const faces = typesOf(ff.faces, FACE_TYPES);
  console.log(`     streifen-demotion: Flächen ${JSON.stringify(faces)}`
    + ` · Runden ${ff.rounds} · demotet ${ff.demoted} · Streifen ${ff.stripTris}`);
  assert.ok(faces.cylinder >= 1, `kein Zylinder mehr: ${JSON.stringify(faces)}`);
  assert.ok(faces.sphere >= 1, `keine Kugel mehr: ${JSON.stringify(faces)}`);
  assert.ok(faces.facet > 0, `keine Facetten (kein Streifen): ${JSON.stringify(faces)}`);
  assert.ok(ff.stripTris > 0, 'kein Streifen gezählt');
  const { violations } = checkStepStrict(res.step);
  if (violations.length) {
    throw new Error(`${violations.length} Verstöße: `
      + violations.slice(0, 3).map((v) => `${v.kind}: ${v.msg}`).join(' | '));
  }
});

console.log(failed ? `FAIL ${failed} Fall(e)` : `ok alle ${describeBodies().length} Körper + Streifen-Demotion`);
process.exit(failed ? 1 : 0);

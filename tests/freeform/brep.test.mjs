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
// Zusatzfall "ecken-fehler": die Projektion EINER Ecke wird scheitern gelassen
// (opts.testForceVertexFail = Prädikat auf der Netzposition). Erwartet: die
// schuldige analytische Region wird um die Ecke gestreift (wenige Facetten),
// Zylinder und Torus bleiben erhalten, die STEP-Datei bleibt strikt gültig.
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

// Soll-Flächen- und Kantenarten ALLER sechs Körper (strikt): die gedrehten
// Körper müssen dieselben Zahlen liefern wie die geraden (die Achsen der
// gedrehten Flächen stehen nur nicht mehr senkrecht im Koordinatensystem).
const STRICT = {
  'ff_rundquader_r1.stl': {
    faces: { plane: 6, cylinder: 12, cone: 0, sphere: 8, torus: 0, facet: 0 },
    edges: { line: 24, circle: 24, bspline: 0 },
  },
  'ff_platte_loch_torus.stl': {
    faces: { plane: 6, cylinder: 1, cone: 0, sphere: 0, torus: 1, facet: 0 },
    edges: { line: 12, circle: 6, bspline: 0 },
  },
  'ff_halbkugel_zylinder.stl': {
    faces: { plane: 1, cylinder: 1, cone: 0, sphere: 1, torus: 0, facet: 0 },
    edges: { line: 0, circle: 4, bspline: 0 },
  },
};
for (const k of Object.keys(STRICT)) STRICT[`${k.replace('.stl', '')}_gedreht.stl`] = STRICT[k];

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

  // Flächen- und Kantenarten: strikt für alle sechs Körper
  const want = STRICT[body.file];
  assert.ok(want, `keine Soll-Werte für ${body.file}`);
  assert.deepEqual(faces, want.faces,
    `Flächenarten weichen ab: ${JSON.stringify(faces)} statt ${JSON.stringify(want.faces)}`);
  assert.deepEqual(edges, want.edges,
    `Kantenarten weichen ab: ${JSON.stringify(edges)} statt ${JSON.stringify(want.edges)}`);

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

// ── Ecken-Fehler: die Projektion EINER Ecke scheitern lassen ──────────────────
// Erwartung: die Ecke bleibt Netzpunkt, die schuldige analytische Region wird
// um die Ecke herum gestreift (wenige Facetten), der Rest bleibt analytisch —
// und die STEP-Datei bleibt strikt gültig.
test('ecken-fehler', () => {
  const file = 'ff_platte_loch_torus.stl';
  const buf = readFileSync(join('tests/freeform/stl', file));
  const groups = pipeline(buf);
  // B-Rep-Ecke unten rechts: Netzpunkt (15, 10, 0) — dort stoßen drei Ebenen
  // zusammen (Boden, Seitenfläche x = 15, Seitenfläche y = 10)
  const passt = (p) => Math.abs(p[0] - 15) < 1e-6 && Math.abs(p[1] - 10) < 1e-6
    && Math.abs(p[2]) < 1e-6;
  let getroffen = 0;
  const res = buildFreeformBrep(groups, {
    testForceVertexFail: (p) => {
      if (passt(p)) { getroffen++; return true; }
      return false;
    },
  });
  assert.ok(res, 'Freiform-Bau lieferte null');
  const ff = res.report && res.report.freeform;
  assert.ok(ff && ff.used, 'Freiform-Pfad nicht benutzt');
  const faces = typesOf(ff.faces, FACE_TYPES);
  console.log(`     ecken-fehler: Flächen ${JSON.stringify(faces)}`
    + ` · Runden ${ff.rounds} · demotet ${ff.demoted} · Streifen ${ff.stripTris}`);
  assert.ok(getroffen >= 1, 'erzwungene Ecke nicht erreicht');
  assert.ok(faces.facet > 0, `keine Facetten (kein Streifen): ${JSON.stringify(faces)}`);
  assert.ok(faces.facet < 30, `zu viele Facetten: ${JSON.stringify(faces)}`);
  assert.ok(ff.stripTris < 30, `zu viele gestreifte Dreiecke: ${ff.stripTris}`);
  assert.ok(faces.cylinder >= 1, `kein Zylinder mehr: ${JSON.stringify(faces)}`);
  assert.ok(faces.torus >= 1, `kein Torus mehr: ${JSON.stringify(faces)}`);
  const { violations } = checkStepStrict(res.step);
  if (violations.length) {
    throw new Error(`${violations.length} Verstöße: `
      + violations.slice(0, 3).map((v) => `${v.kind}: ${v.msg}`).join(' | '));
  }
});

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

// ── Schliff: zwei Ecken eines Facetten-Dreiecks fallen zusammen ─────────────
// Erwartung: die Fläche (ihr Rand läuft doppelt über dieselbe Strecke, sie hat
// keinen Inhalt) entfällt, ihre beiden geometrisch gleichen Geraden werden zu
// EINER Kante verschmolzen — die Nachbarflächen teilen sie sich danach —
// und die STEP-Datei bleibt strikt gültig.
test('schliff', () => {
  const file = 'ff_halbkugel_zylinder.stl';
  const buf = readFileSync(join('tests/freeform/stl', file));
  const groups = pipeline(buf);
  let getroffen = 0;
  const dbg = { log: [] };
  const res = buildFreeformBrep(groups, {
    // eine Kette Zylinder↔Kugel scheitern lassen → die Kugel wird gestreift
    // und zu Facetten (kleine Dreiecke auf der Kugel)
    testForceChainFail: true,
    // im ersten Facetten-Dreieck zwei Ecken zusammenlegen
    testMergeFacetVertices: () => { getroffen++; return getroffen === 1; },
    debug: dbg,
  });
  assert.ok(res, 'Freiform-Bau lieferte null');
  const ff = res.report && res.report.freeform;
  assert.ok(ff && ff.used, 'Freiform-Pfad nicht benutzt');
  const schliff = dbg.log.filter((s) => s.includes('Schliff'));
  console.log(`     schliff: Flächen ${JSON.stringify(typesOf(ff.faces, FACE_TYPES))}`
    + ` · Kanten ${JSON.stringify(typesOf(ff.edges, EDGE_TYPES))}`
    + ` · Schliffe ${schliff.length}${schliff.length ? ` — ${schliff[0]}` : ''}`);
  assert.ok(getroffen >= 1, 'Facetten-Dreieck nicht erreicht');
  assert.ok(schliff.length >= 1, 'kein Schliff erkannt');
  const { violations } = checkStepStrict(res.step);
  if (violations.length) {
    throw new Error(`${violations.length} Verstöße: `
      + violations.slice(0, 3).map((v) => `${v.kind}: ${v.msg}`).join(' | '));
  }
});

console.log(failed ? `FAIL ${failed} Fall(e)`
  : `ok alle ${describeBodies().length} Körper + Streifen-Demotion + Ecken-Fehler + Schliff`);
process.exit(failed ? 1 : 0);
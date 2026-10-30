// ─────────────────────────────────────────────────────────────────────────────
// tests/freeform/blend.test.mjs — Blend-Patches (Etappe 1b)
//
// Der Blend-Patch ersetzt den alten Rückfall "Region zur Fassade": eine
// Verrundungs-Region, deren gefittete Fläche ihre Nachbarn nicht exakt trifft,
// wird zu EINER B-Spline-Fläche (Coons-Patch über den exakten Randkurven).
//
// Fälle:
//   a) Rundquader (gedreht), alle ZYLINDER als Blend → 12 B-Spline-Flächen,
//      Kugeln und Ebenen bleiben analytisch, 0 Facetten, STEP streng gültig.
//   b) Rundquader (gedreht), alle NICHT-EBENEN als Blend → die 8 Eckkugeln
//      werden dreiseitige Patches (eine Seite ist ein Punkt), 0 Facetten.
//   c) Kettenfehler Zylinder↔Kugel (wie im alten Test) mit Blends: der Täter
//      wird EIN B-Spline-Fläche, keine Facetten.
//   d) verrauschter Körper (jede Netzecke 3e-3 mm verschoben): Vergleich
//      blendPatches aus (alter Streifen-Weg) und an (B-Spline-Flächen).
//
// Die STEP-Dateien landen in tests/freeform/out/.
// ─────────────────────────────────────────────────────────────────────────────
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseStl } from '../../analysis-core.js';
import { buildNormalGroups } from '../../region-growing.js';
import { cleanMesh } from '../../mesh-clean.js';
import { unifyCoplanarGroups } from '../../face-unification.js';
import { recognizePrimitives } from '../../primitive-recognition.js';
import { detectTubes } from '../../tube-sweep.js';
import { buildFreeformBrep } from '../../freeform-brep.js';
import { checkStepStrict } from '../step-strict.mjs';
import { buildAllBodies, toBinaryStl } from './gen.mjs';

let failed = 0;
const failLog = [];
let lastDbg = null;
function test(name, fn) {
  try {
    fn();
    console.log('ok ' + name);
  } catch (e) {
    failed++;
    const msg = 'FAIL ' + name + ': ' + (e && e.message ? e.message : String(e));
    failLog.push(msg);
    console.log(msg);
  }
  if (lastDbg) {
    writeFileSync(join('tests/freeform/out', `_blend-${name}.log`), (lastDbg.log || []).join('\n'));
    lastDbg = null;
  }
}

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

const FACE_TYPES = ['plane', 'cylinder', 'cone', 'sphere', 'torus', 'facet', 'bspline'];
const typesOf = (f, keys) => {
  const o = {};
  for (const k of keys) o[k] = f?.[k] || 0;
  return o;
};

// deterministischer Zufall (LCG)
function makeRng(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

// Jede Netzecke um einen deterministischen Vektor der Länge amp verschieben.
// Gleiche Ecken (gleiche Position) werden GLEICH verschoben → das Netz bleibt
// geschlossen (keine Risse). Die Gruppen-Ecken sind Punkt-Listen.
function noiseGroups(groups, seed = 20261029, amp = 3e-3) {
  const rng = makeRng(seed);
  const map = new Map();
  const shift = (x, y, z) => {
    const key = `${x},${y},${z}`;
    let q = map.get(key);
    if (!q) {
      const u = [rng() * 2 - 1, rng() * 2 - 1, rng() * 2 - 1];
      const l = Math.hypot(u[0], u[1], u[2]) || 1;
      q = [x + (amp * u[0]) / l, y + (amp * u[1]) / l, z + (amp * u[2]) / l];
      map.set(key, q);
    }
    return q;
  };
  return groups.map((g) => ({
    ...g,
    vertices: g.vertices.map((p) => shift(p[0], p[1], p[2])),
  }));
}

const BOX = 'ff_rundquader_r1_gedreht.stl';
// Die Körper im Speicher bauen (kein Dateizugriff → kein Rennen mit den
// anderen Testdateien, die dieselben STL-Dateien neu schreiben)
const BODIES = new Map(buildAllBodies().map((b) => [b.file, b]));
const groupsOf = (file) => {
  const body = BODIES.get(file);
  assert.ok(body, `Körper ${file} nicht gefunden`);
  return pipeline(toBinaryStl(body.tris, file));
};

// ── a) alle Zylinder als Blend ───────────────────────────────────────────────
test('blend-zylinder', () => {
  const groups = groupsOf(BOX);
  const dbg = { log: [] };
  lastDbg = dbg;
  const res = buildFreeformBrep(groups, {
    testBlendRegions: (r) => r.type === 'cylinder',
    debug: dbg,
  });
  assert.ok(res, `Freiform-Bau lieferte null\n${dbg.log.slice(-6).join('\n')}`);
  const ff = res.report.freeform;
  const faces = typesOf(ff.faces, FACE_TYPES);
  console.log(`     blend-zylinder: Flächen ${JSON.stringify(faces)}`
    + ` · Runden ${ff.rounds} · Blends ${ff.blends} · Facetten ${ff.stripTris}`);
  assert.equal(faces.bspline, 12, `B-Spline-Flächen: ${JSON.stringify(faces)}`);
  assert.equal(faces.cylinder, 0, `Zylinder übrig: ${JSON.stringify(faces)}`);
  assert.equal(faces.sphere, 8, `Kugeln: ${JSON.stringify(faces)}`);
  assert.equal(faces.plane, 6, `Ebenen: ${JSON.stringify(faces)}`);
  assert.equal(faces.facet, 0, `Facetten: ${JSON.stringify(faces)}`);
  const { violations } = checkStepStrict(res.step);
  assert.equal(violations.length, 0,
    `STEP-Verstöße: ${violations.slice(0, 4).map((v) => `${v.kind}: ${v.msg}`).join(' | ')}`);
  writeFileSync(join('tests/freeform/out', 'blend-rundquader-zylinder.step'), res.step);
});

// ── b) alle Nicht-Ebenen als Blend (Kugeln → dreiseitige Patches) ───────────
test('blend-ohne-ebenen', () => {
  const groups = groupsOf(BOX);
  const dbg = { log: [] };
  lastDbg = dbg;
  const res = buildFreeformBrep(groups, {
    testBlendRegions: (r) => r.type !== 'plane',
    debug: dbg,
  });
  assert.ok(res, `Freiform-Bau lieferte null\n${dbg.log.slice(-6).join('\n')}`);
  const ff = res.report.freeform;
  const faces = typesOf(ff.faces, FACE_TYPES);
  console.log(`     blend-ohne-ebenen: Flächen ${JSON.stringify(faces)}`
    + ` · Runden ${ff.rounds} · Blends ${ff.blends} · Facetten ${ff.stripTris}`);
  assert.equal(faces.bspline, 20, `B-Spline-Flächen: ${JSON.stringify(faces)}`);
  assert.equal(faces.plane, 6, `Ebenen: ${JSON.stringify(faces)}`);
  assert.equal(faces.facet, 0, `Facetten: ${JSON.stringify(faces)}`);
  const { violations } = checkStepStrict(res.step);
  assert.equal(violations.length, 0,
    `STEP-Verstöße: ${violations.slice(0, 4).map((v) => `${v.kind}: ${v.msg}`).join(' | ')}`);
  writeFileSync(join('tests/freeform/out', 'blend-rundquader-ohne-ebenen.step'), res.step);
});

// ── c) Kettenfehler Zylinder↔Kugel: der Täter wird EIN B-Spline-Fläche ──────
test('blend-kettenfehler', () => {
  const groups = groupsOf(BOX);
  const dbg = { log: [] };
  lastDbg = dbg;
  const res = buildFreeformBrep(groups, { testForceChainFail: true, debug: dbg });
  assert.ok(res, `Freiform-Bau lieferte null\n${dbg.log.slice(-6).join('\n')}`);
  const ff = res.report.freeform;
  const faces = typesOf(ff.faces, FACE_TYPES);
  console.log(`     blend-kettenfehler: Flächen ${JSON.stringify(faces)}`
    + ` · Runden ${ff.rounds} · Blends ${ff.blends} · Facetten ${ff.stripTris}`);
  assert.ok(faces.bspline >= 1, `keine B-Spline-Fläche: ${JSON.stringify(faces)}`);
  assert.equal(faces.facet, 0, `Facetten trotz Blend: ${JSON.stringify(faces)}`);
  const { violations } = checkStepStrict(res.step);
  assert.equal(violations.length, 0,
    `STEP-Verstöße: ${violations.slice(0, 4).map((v) => `${v.kind}: ${v.msg}`).join(' | ')}`);
  writeFileSync(join('tests/freeform/out', 'blend-kettenfehler.step'), res.step);
});

// ── d) verrauschter Körper: Blends statt Facetten ───────────────────────────
// Der Fall muss in < 60 s fertig sein: der Versuch bekommt ein Zeitbudget
// (30 s) und wird im Freiform-Bau an jeder teuren Stelle geprüft.
const BLEND_BUDGET_MS = 30000;
test('blend-rauschen', () => {
  const tAll = Date.now();
  const groups = noiseGroups(groupsOf(BOX));
  const dbgAlt = { log: [] };
  const tAlt = Date.now();
  const alt = buildFreeformBrep(groups, {
    blendPatches: false, debug: dbgAlt, timeBudgetMs: BLEND_BUDGET_MS,
  });
  const msAlt = Date.now() - tAlt;
  const dbgNeu = { log: [] };
  lastDbg = dbgNeu;
  const tNeu = Date.now();
  const neu = buildFreeformBrep(groups, {
    blendPatches: true, debug: dbgNeu, timeBudgetMs: BLEND_BUDGET_MS,
  });
  const msNeu = Date.now() - tNeu;
  const show = (r, dbg, tag) => {
    if (!r) return `${tag}: null (${dbg.log.slice(-2).join(' | ')})`;
    const f = typesOf(r.report.freeform.faces, FACE_TYPES);
    const v = checkStepStrict(r.step).violations;
    return `${tag}: Flächen ${JSON.stringify(f)} · Blends ${r.report.freeform.blends}`
      + ` · Facetten ${r.report.freeform.faces.facet} · Streifen ${r.report.freeform.stripTris}`
      + ` · Verstöße ${v.length}${v.length ? ` (${v.slice(0, 2).map((x) => x.kind).join(',')})` : ''}`;
  };
  console.log(`     blend-rauschen: ${show(alt, dbgAlt, 'alt')} · ${msAlt} ms`);
  console.log(`     blend-rauschen: ${show(neu, dbgNeu, 'neu')} · ${msNeu} ms`);
  for (const line of dbgNeu.log.filter((l) => l.startsWith('ZEIT'))) {
    console.log(`     blend-rauschen: ${line}`);
  }
  // Der Versuch muss entweder ein gültiges Ergebnis liefern …
  if (neu) {
    const vNeu = checkStepStrict(neu.step).violations;
    assert.equal(vNeu.length, 0,
      `STEP-Verstöße (neu): ${vNeu.slice(0, 4).map((v) => `${v.kind}: ${v.msg}`).join(' | ')}`);
    const fNeu = typesOf(neu.report.freeform.faces, FACE_TYPES);
    const fAlt = alt ? typesOf(alt.report.freeform.faces, FACE_TYPES) : null;
    if (fAlt) {
      assert.ok(fNeu.facet <= fAlt.facet,
        `mehr Facetten mit Blends: ${fNeu.facet} statt ${fAlt.facet}`);
    }
    writeFileSync(join('tests/freeform/out', 'blend-rauschen-neu.step'), neu.step);
  } else {
    // … oder innerhalb des Budgets aufgeben (und das sagen).
    console.log(`     blend-rauschen: neu=null — ${dbgNeu.log.slice(-3).join(' | ')}`);
    assert.ok(msNeu <= BLEND_BUDGET_MS + 5000,
      `Budget überschritten: ${msNeu} ms > ${BLEND_BUDGET_MS} ms`);
  }
  if (alt) writeFileSync(join('tests/freeform/out', 'blend-rauschen-alt.step'), alt.step);
  const msAll = Date.now() - tAll;
  console.log(`     blend-rauschen: gesamt ${msAll} ms`);
  assert.ok(msAll < 60000, `zu lang: ${msAll} ms (Limit 60 s)`);
});

writeFileSync(join('tests/freeform/out', '_fail-blend.log'), failLog.join('\n---\n'));
console.log(failed ? `FAIL ${failed} Fall(e)` : 'ok alle Blend-Fälle');
process.exit(failed ? 1 : 0);

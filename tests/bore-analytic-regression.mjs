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
// SYNTHETIK (zweiter Abschnitt): koaxiale Durchgangsbohrungen in GETRENNTEN Laschen
// (Gabel/Kreuzgabel). Zwei Bohrungen mit gleichem Radius und gleicher Segmentphase haben
// paarweise koplanare Wandfacetten → unifyCoplanarGroups verschmilzt sie zu EINER Gruppe;
// recognizePrimitives teilt eine solche Gruppe je Primitiv auf (stats.splitGroups) —
// ohne diesen Split blieben BEIDE Bohrungen facettiert (boresConverted=0). Die neuen Fälle
// decken die Bohrungsachse in z, x und y, eine schräge Lage, 12/24/48 Segmente, drei
// Laschen, einen randnahen Stresskörper (Loch 0,4 mm vom Rand — dort zählt nur
// Wasserfestigkeit + Striktheit) und die Einzel-Lasche als Kontrolle ab. Jede Bohrung
// muss analytisch umgewandelt werden: boresConverted === Anzahl Bohrungen und
// mindestens so viele CYLINDRICAL_SURFACE im STEP.
//
// SYNTHETIK (dritter Abschnitt): eine Platte mit einer REIHE von Durchgangsbohrungen — bei
// n ≡ 2 (mod 4) liegen je zwei Wandfacetten eines Lochs in einer Ebene mit den entsprechenden
// Facetten der ANDEREN Löcher (unifyCoplanarGroups verschmilzt sie zu EINER Gruppe), und nur
// der Gruppen-Split in recognizePrimitives (stats.splitGroups) sorgt dafür, dass jede der
// Bohrungen einzeln analytisch gewandelt wird; der Kontrollfall n ≡ 0 (mod 4) hat diese
// Koplanarität nicht.
//
// Läuft ohne Browser/Worker: spiegelt die Worker-Pipeline
//   parseStl → cleanMesh → simplifyMesh → buildNormalGroups → unifyCoplanarGroups →
//   recognizePrimitives → buildVolumeStepBrepV2
// (buildNormalGroups kommt aus dem gemeinsamen Modul region-growing.js — dasselbe wie im Worker.)
//
// Ausführen:  node tests/bore-analytic-regression.mjs   (Exit 0 = alle grün, 1 = Fehler)
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { parseStl, simplifyMesh, SIMPLIFY_ABOVE, SIMPLIFY_TARGET } from '../analysis-core.js';
import { unifyCoplanarGroups } from '../face-unification.js';
import { buildNormalGroups } from '../region-growing.js';
import { cleanMesh } from '../mesh-clean.js';
import { recognizePrimitives } from '../primitive-recognition.js';
import { detectTubes } from '../tube-sweep.js';
import { buildVolumeStepBrepV2 } from '../exporters.js';
import { buildMesh, circleProfile, rectProfile, checkManifold } from './fixtures-v2/gen.mjs';
import { checkStepStrict } from './step-strict.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SAMPLES = join(__dirname, '..', 'samples');


function exportFor(file) {
  const buf = readFileSync(join(SAMPLES, file));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  let mesh = cleanMesh(parseStl(ab, () => {})).mesh;   // Netz-Bereinigung wie im Worker
  if (mesh.faces.length > SIMPLIFY_ABOVE) mesh = simplifyMesh(mesh, SIMPLIFY_TARGET,  // wie analysis-worker.js
    () => {});
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

// ─────────────────────────────────────────────────────────────────────────────
// Synthetik: koaxiale Bohrungen in getrennten Laschen
//
// Gabelkörper (Kreuzgabel): k Laschen (Platten der Dicke t, jeweils mit EINER
// Durchgangsbohrung), durch eine Spalte der Weite g getrennt, verbunden durch einen
// Steg x ∈ [0, a], der die Spalte überbrückt. Alle Bohrungen liegen auf DERSELBEN
// Achse (‖ z, Zentrum (cx, cy), Radius R, n Segmente) → ihre Wandfacetten sind
// paarweise koplanar und werden von unifyCoplanarGroups zu einer Gruppe verschmolzen;
// recognizePrimitives teilt diese Gruppe je Primitiv auf (stats.splitGroups) —
// VOR diesem Split blieben alle Bohrungen facettiert (boresConverted=0).
//
// Lokales System: Bohrungsachse = +z. Plattenprofil (CCW, enthält die Steg-Eckpunkte
// (a,0) und (a,W), damit keine T-Knoten entstehen): [[a,0],[L,0],[L,W],[a,W],[0,W],[0,0]]
// (zyklisch verschoben gegenüber [[0,0],[a,0],…] — siehe den Kommentar in clevis()).
// Stegprofil: [[0,0],[a,0],[a,W],[0,W]] (nur in den Spalten, ohne Deckflächen —
// seine Enden werden auf die Platten geklebt). Lochprofil: circleProfile(..., true)
// (CW → Loch). Die Deckflächen sind EXPLIZIT gesetzt (body.caps), damit die
// Default-Deckflächen NICHT greifen: die Spalt-seitigen Plattenflächen sind nur der
// Bereich x ∈ [a, L] (dort sitzt das Loch), der Steg-Bereich x ∈ [0, a] gehört dem
// Steg.
// ─────────────────────────────────────────────────────────────────────────────
function clevis({ k = 2, t = 6, g = 14, L = 20, W = 10, a = 4, cx = 12, cy = 5, R = 2, n = 24, transform = null } = {}) {
  // Plattenprofil (CCW): enthält die Steg-Eckpunkte (a,0) und (a,W), damit die Steg-Flächen
  // ohne T-Knoten andocken. Startvertex (a,0) statt (0,0): das ist derselbe Polygon (zyklisch
  // verschoben) — aber das Ear-Clipping von gen.mjs lässt als letztes Dreieck die drei
  // verbleibenden Randpunkte stehen. Startet die Kontur bei (0,0), sind das (L,W),(a,W),(0,W)
  // — kollinear (alle auf y=W) → ein entartetes (flächenloses) Dreieck. Mit Start (a,0) ist
  // das Restdreieck (0,W),(0,0),(a,0) — nicht kollinear → sauberes Netz.
  const platePts = [[a, 0], [L, 0], [L, W], [a, W], [0, W], [0, 0]];   // CCW (Steg-Eckpunkte enthalten)
  const holePts = circleProfile(cx, cy, R, n, true);                   // CW → Loch
  const webPts = [[0, 0], [a, 0], [a, W], [0, W]];                     // CCW → Steg
  const columns = [], plateCol = [], holeCol = [];
  for (let i = 0; i < k; i++) {
    const z0 = i * (t + g), z1 = z0 + t;
    plateCol.push(columns.length);
    columns.push({ name: `lasche${i}`, profile: platePts, z0, z1, bottom: { kind: 'sharp' }, top: { kind: 'sharp' } });
    holeCol.push(columns.length);
    columns.push({ name: `bohrung${i}`, profile: holePts, z0, z1, bottom: { kind: 'sharp' }, top: { kind: 'sharp' } });
  }
  for (let i = 0; i + 1 < k; i++) {                                   // Steg in der Spalte
    columns.push({ name: `steg${i}`, profile: webPts, z0: i * (t + g) + t, z1: (i + 1) * (t + g), bottom: { kind: 'sharp' }, top: { kind: 'sharp' } });
  }
  const caps = [];
  // erste Lasche unten / letzte Lasche oben: volles Plattenprofil
  caps.push({ up: false, outer: { c: plateCol[0], end: 'bottom' }, holes: [{ c: holeCol[0], end: 'bottom' }] });
  caps.push({ up: true, outer: { c: plateCol[k - 1], end: 'top' }, holes: [{ c: holeCol[k - 1], end: 'top' }] });
  for (let i = 0; i < k; i++) {
    const z0 = i * (t + g), z1 = z0 + t;
    // Spalt-seitige Deckfläche: nur x ∈ [a, L] (das Steg-Feld x ∈ [0, a] gehört dem Steg)
    if (i < k - 1) caps.push({ up: true, outer: { pts: [[a, 0, z1], [L, 0, z1], [L, W, z1], [a, W, z1]] }, holes: [{ c: holeCol[i], end: 'top' }] });
    if (i > 0) caps.push({ up: false, outer: { pts: [[a, 0, z0], [L, 0, z0], [L, W, z0], [a, W, z0]] }, holes: [{ c: holeCol[i], end: 'bottom' }] });
  }
  const body = { columns, caps };
  if (transform) body.transform = transform;
  return body;
}

// Pipeline wie exportFor, aber aus Dreiecken (statt aus einer STL-Datei).
// WICHTIG: recognizePrimitives MUTIERT die Gruppenliste (es hängt die Untergruppen an)
// → je Export die Gruppen frisch bauen.
const quiet = (fn) => {
  const log = console.log;
  console.log = () => {};
  try { return fn(); } finally { console.log = log; }
};

function exportTris(tris, defeature) {
  const faces = tris.map((t) => {
    const [a, b, c] = t;
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const l = Math.hypot(n[0], n[1], n[2]) || 1;
    return { vertices: t.map((p) => [p[0], p[1], p[2]]), normal: [n[0] / l, n[1] / l, n[2] / l] };
  });
  return quiet(() => {
    const mesh = cleanMesh({ faces }).mesh;
    let groups = buildNormalGroups(mesh);
    groups = unifyCoplanarGroups(groups).unified.sort((a, b) => b.vertices.length - a.vertices.length);
    const analysis = { normalGroups: groups };
    let stats = null;
    try { stats = recognizePrimitives(analysis.normalGroups).stats; } catch (e) { /* Erkennung optional */ }
    try { detectTubes(analysis.normalGroups); } catch (e) { /* Kanal-Erkennung optional */ }
    const res = buildVolumeStepBrepV2({ normalGroups: groups, defeature });
    return { res, tris: mesh.faces.length, stats };
  });
}

// Gemeinsamer Fall-Ablauf: Körper bauen → Manifold prüfen → AN/AUS exportieren → Checks.
// `bores` = erwartete Anzahl Bohrungen (boresConverted === bores, CYLINDRICAL_SURFACE ≥ bores).
// `expectSplit` = erwarteter stats.splitGroups (null = nicht geprüft).
// `stress` = nur Wasserfestigkeit + Striktheit (keine Bohrungs-Assertions).
const runSynthCase = ({ name, note, build, bores, stress = false, expectSplit = null }) => {
  console.log(`\n${name} — ${note}`);
  let tris;
  try { tris = build(); }
  catch (e) {
    console.log(`  FAIL  Generator-Fehler: ${e.message}`);
    failures++;
    return;
  }
  const man = checkManifold(tris);
  if (!man.ok) {
    console.log(`  FAIL  Generator: Netz nicht manifold (${man.badEdges} Kanten, ${man.degenerate} entartet)`);
    failures++;
    return;
  }
  for (const [label, defeature] of [['AN', true], ['AUS', false]]) {
    let out;
    try { out = exportTris(tris, defeature); }
    catch (e) { console.log(`  FAIL  ${label}: Pipeline-Fehler: ${e.message}`); failures++; continue; }
    const { res, tris: ntris, stats } = out;
    if (!res) { console.log(`  FAIL  ${label}: buildVolumeStepBrepV2 lieferte null`); failures++; continue; }
    const r = res.report;
    const cyl = (res.step.match(/CYLINDRICAL_SURFACE/g) || []).length;
    const splitGroups = stats ? stats.splitGroups : '?';
    console.log(`  ${label}:  (${ntris} tris) boresConverted=${r.boresConverted} CYLINDRICAL_SURFACE×${cyl} watertight=${r.watertight} faces=${r.faceCount} splitGroups=${splitGroups}`);
    check(`${label}: watertight === true`, r.watertight === true);
    const strict = checkStepStrict(res.step);
    check(`${label}: STEP streng gültig (0 Verstöße)`, strict.violations.length === 0);
    if (strict.violations.length) {
      for (const v of strict.violations.slice(0, 5)) console.log(`        ${v.kind}: ${v.msg}`);
    }
    if (expectSplit !== null) {
      check(`${label}: splitGroups === ${expectSplit}`, stats && stats.splitGroups === expectSplit);
    }
    if (stress) continue;                       // Stresskörper: nur Wasserfestigkeit + Striktheit
    const okBores = r.boresConverted === bores;
    check(`${label}: boresConverted === ${bores} (JEDE Bohrung analytisch umgewandelt)`, okBores);
    check(`${label}: STEP enthält ≥${bores} CYLINDRICAL_SURFACE`, cyl >= bores);
    if (!okBores) {
      console.log(`        boreNotes: ${JSON.stringify(r.boreNotes || [])}`);
      console.log(`        (Bohrungen blieben facettiert — Gruppen-Split in recognizePrimitives hat nicht gegriffen)`);
    }
  }
};

// Defaults: 2 Laschen, Dicke t=6, Spalte g=14, Platte 20×10, Steg a=4,
// Bohrung (12, 5) R=2 mit n Segmenten, Achse ‖ z.
const SYNTH = [
  { name: 'gabel-z-24',        note: 'Bohrungsachse ‖ z, 24 Segmente, 2 Laschen' },
  { name: 'gabel-x-24',        note: 'Bohrungsachse ‖ x (wie Box_Bottom), 24 Segmente', params: { transform: { rot: [0, 90, 0] } } },
  { name: 'gabel-y-24',        note: 'Bohrungsachse ‖ y, 24 Segmente', params: { transform: { rot: [90, 0, 0] } } },
  { name: 'gabel-schraeg-24',  note: 'schräg im Raum (23°/37°/11°), 24 Segmente', params: { transform: { rot: [23, 37, 11], t: [-60, 80, 15] } } },
  { name: 'gabel-x-12',        note: 'grob: 12 Segmente, Achse ‖ x', params: { n: 12, transform: { rot: [0, 90, 0] } } },
  { name: 'gabel-x-48-klein',  note: 'fein: 48 Segmente, R=1,05 (wie Box_Bottom), Achse ‖ x', params: { n: 48, R: 1.05, t: 6, transform: { rot: [0, 90, 0] } } },
  { name: 'gabel-3laschen',    note: 'drei koaxiale Bohrungen, Achse ‖ x', params: { k: 3, g: 6, transform: { rot: [0, 90, 0] } } },
  { name: 'gabel-randnah',     note: 'STRESS: Bohrung 0,4 mm vom Rand — nur Wasserfestigkeit + Striktheit', params: { cy: 7.6, transform: { rot: [0, 90, 0] } }, stress: true },
  { name: 'einzel-lasche',     note: 'Kontrolle: eine Lasche, eine Bohrung, kein Steg', params: { k: 1 }, expectSplit: 0 },
];

console.log('\nSynthetik: koaxiale Bohrungen in getrennten Laschen');

for (const { name, note, params = {}, stress = false, expectSplit = null } of SYNTH) {
  const k = params.k ?? 2;
  runSynthCase({ name, note, build: () => buildMesh(clevis(params)), bores: k, stress, expectSplit });
}

// ─────────────────────────────────────────────────────────────────────────────
// Synthetik: Lochreihe in einer Platte (koplanare Wandfacetten)
//
// EINE Platte (Rechteck L×W, Dicke t) mit m Durchgangsbohrungen in einer Reihe entlang x
// (Mittelpunkte (pitch·(i+1), W/2), Radius R, n Segmente). Die Löcher sind PARALLEL, aber
// NICHT koaxial: ihre Wandfacetten sind deshalb nur TEILWEISE koplanar — und zwar genau dann,
// wenn n ≡ 2 (mod 4) ist: die Facetten-Normalen liegen bei (i+0,5)·(360°/n), also bei
// ±90° genau dann, wenn n/4 eine halbe Ganze ist. Die Facetten mit Normalen ±y liegen dann
// je Loch in einer Ebene, die ALLE Löcher gemeinsam haben → unifyCoplanarGroups verschmilzt
// sie zu EINER Gruppe (über die Löcher hinweg) → recognizePrimitives muss diese Gruppe je
// Primitiv aufteilen (stats.splitGroups > 0). Ohne diesen Split blieben die Löcher
// facettiert (boresConverted = 0). Der Kontrollfall n ≡ 0 (mod 4) hat diese Koplanarität
// nicht (alle Facetten-Normalen liegen neben ±90°) — dort greift der Split gar nicht.
//
// Lokales System: Bohrungsachse = +z, Plattenprofil = rectProfile(0, 0, L, W) (CCW),
// Lochprofil = circleProfile(..., true) (CW → Loch). Die Deckflächen kommen aus den
// Default-Caps (gen.mjs: je Außensäule oben/unten, Löcher = alle CW-Säulen) — die
// Durchgangsbohrungen sind damit voll durchbohrt.
// ─────────────────────────────────────────────────────────────────────────────
function lochreihe({ m, n, R = 2, pitch = 8, L, W = 10, t = 4, transform = null } = {}) {
  const Lp = L ?? pitch * (m + 1);                        // Plattenlänge: je pitch Rand um die Lochreihe (Rand pitch−R)
  const columns = [{
    name: 'platte', profile: rectProfile(0, 0, Lp, W), z0: 0, z1: t,
    bottom: { kind: 'sharp' }, top: { kind: 'sharp' },
  }];
  for (let i = 0; i < m; i++) {
    columns.push({
      name: `loch${i}`, profile: circleProfile(pitch * (i + 1), W / 2, R, n, true),
      z0: 0, z1: t, bottom: { kind: 'sharp' }, top: { kind: 'sharp' },
    });
  }
  const body = { columns };
  if (transform) body.transform = transform;
  return body;
}

// Defaults: Platte L = pitch·(m+1), W = 10, Dicke t = 4, Löcher R = 2, pitch = 8.
const LOCHREIHE = [
  { name: 'lochreihe-2x30',        note: '2 Löcher, 30 Segmente (n ≡ 2 mod 4 → je zwei Wandfacetten je Loch liegen mit den Facetten des anderen Lochs in einer Ebene)', params: { m: 2, n: 30 } },
  { name: 'lochreihe-3x18',        note: '3 Löcher, 18 Segmente (n ≡ 2 mod 4 → koplanare Wandfacetten über die Löcher hinweg)', params: { m: 3, n: 18 } },
  { name: 'lochreihe-3x18-schraeg', note: '3 Löcher, 18 Segmente, schräg im Raum (23°/37°/11°)', params: { m: 3, n: 18, transform: { rot: [23, 37, 11], t: [-60, 80, 15] } } },
  { name: 'lochreihe-4x24',        note: 'Kontrolle: 4 Löcher, 24 Segmente (n ≡ 0 mod 4 → keine koplanaren Wandfacetten über die Löcher hinweg)', params: { m: 4, n: 24 } },
];

console.log('\nSynthetik: Lochreihe in einer Platte (koplanare Wandfacetten)');

for (const { name, note, params = {} } of LOCHREIHE) {
  runSynthCase({ name, note, build: () => buildMesh(lochreihe(params)), bores: params.m });
}

console.log(`\n${failures === 0 ? '✅ alle Bohrungs-Regressionen grün' : `❌ ${failures} Assertion(en) fehlgeschlagen`}`);
process.exit(failures === 0 ? 0 : 1);

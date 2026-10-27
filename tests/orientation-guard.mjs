// ─────────────────────────────────────────────────────────────────────────────
// Orientierungs-Wächter (exporters.js, assemble): Positiv- und Negativtest.
//
// Der Wasserdicht-Zähler sieht nur die Kanten-Bilanz (je Kante 1× vor, 1× zurück). Eine
// analytische Fläche mit verdrehtem same_sense oder eine KONSISTENT verdrehte Rand-Kurve (beide
// Nutzungen) lässt diese Bilanz ausgeglichen — occt/Fusion reparieren still, strikte Importer
// (CST CAD Navigator, ACIS) verlieren Flächen. Der Wächter prüft je Bohrungs-Zylinder, Außenmantel,
// Kegel-Mantel, Fasen-Kegel und Kanal-Stück (a) die effektive Normale gegen die Wicklungs-Normalen der
// ersetzten Original-Dreiecke und (b) den Umlaufsinn der Ränder; Widerspruch →
// report.orientationGuardFailures + Fallback (Stufe 1: ohne Bohrungen/Mäntel/Kegel/Kanäle, Defeaturing
// bleibt; Stufe 2: facettiert).
//
//   Positiv:  alle Samples (AN/AUS) + Welle mit gefasten Außenkanten (gen.mjs) + Synthetik-Kanäle A–C
//             aus tube-regression → kein Fehlalarm
//   Negativ:  Test-Hook STLREV_TEST_FLIP = bore | mantle | mantlecone | cone | tube | tubecurve verdreht
//             die Flächen ('mantlecone' = konvexe Kegel-Mäntel inkl. Kegel mit Spitze und Mantel-Fasen)
//     (1) nur melden (STLREV_TEST_GUARD_REPORT_ONLY=1): Wächter schlägt an, das Wasserdicht-
//         Verdikt NICHT — und tests/step-strict.mjs findet den Fehler unabhängig (orient-curved)
//     (2) mit Fallback: Export fällt sauber zurück — wasserdicht, streng ohne Orientierungs-
//         Verstöße, die verdrehte Flächenart ist nicht mehr enthalten, Defeaturing bleibt (Stufe 1)
//   Laufzeit: Wächter-Anteil am Export (eBike; mit --stress zusätzlich 50k-Torus)
//
// Ausführen:  npm run test:orient          (Exit 0 = grün)
//             node tests/orientation-guard.mjs --stress
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { parseStl, simplifyMesh } from '../analysis-core.js';
import { buildNormalGroups } from '../region-growing.js';
import { cleanMesh } from '../mesh-clean.js';
import { unifyCoplanarGroups } from '../face-unification.js';
import { recognizePrimitives } from '../primitive-recognition.js';
import { detectTubes } from '../tube-sweep.js';
import { buildVolumeStepBrepV2 } from '../exporters.js';
import { checkStepStrict } from './step-strict.mjs';
import { channelBlock, cases as tubeCases } from './tube-regression.mjs';
import * as G from './fixtures-v2/gen.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SAMPLES = join(__dirname, '..', 'samples');
const MAX_FACES = 50000;            // wie analysis-worker.js
const STRESS = process.argv.includes('--stress');
const EBIKE_PLAIN = 'fischerEbike - FahrradLicht - mount unter sattel(ohne rundungen).stl';
const EBIKE = 'fischerEbike - FahrradLicht - mount unter sattel.stl';

const origLog = console.log;
const quiet = (fn) => { console.log = () => {}; try { return fn(); } finally { console.log = origLog; } };

function groupsOf(mesh) {
  mesh = cleanMesh(mesh).mesh;   // Netz-Bereinigung wie im Worker
  if (mesh.faces.length > MAX_FACES) mesh = simplifyMesh(mesh, MAX_FACES, () => {});
  const groups = unifyCoplanarGroups(buildNormalGroups(mesh)).unified.sort((a, b) => b.vertices.length - a.vertices.length);
  recognizePrimitives(groups);
  detectTubes(groups);
  return groups;
}
const sampleCache = new Map();
function sampleGroups(file) {
  if (!sampleCache.has(file)) {
    const buf = readFileSync(join(SAMPLES, file));
    sampleCache.set(file, quiet(() => groupsOf(parseStl(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), () => {}))));
  }
  return sampleCache.get(file);
}
const FIXTURES = join(__dirname, 'fixtures-v2', 'stl');
const fixtureCache = new Map();
function fixtureGroups(file) {
  if (!fixtureCache.has(file)) {
    const buf = readFileSync(join(FIXTURES, file));
    fixtureCache.set(file, quiet(() => groupsOf(parseStl(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), () => {}))));
  }
  return fixtureCache.get(file);
}
// Härtetest-Generator-Körper (tests/fixtures-v2/gen.mjs) im Speicher, z.B. Welle mit gefasten Außenkanten
const genCache = new Map();
function genGroups(name, body) {
  if (!genCache.has(name)) {
    const buf = G.toBinaryStl(G.buildMesh(body), name);
    genCache.set(name, quiet(() => groupsOf(parseStl(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), () => {}))));
  }
  return genCache.get(name);
}
const CHAMFERED_SHAFT = { columns: [{ profile: G.circleProfile(0, 0, 5, 64), z0: 0, z1: 20, bottom: { kind: 'chamfer', r: 1 }, top: { kind: 'chamfer', r: 1 } }] };
const synthCache = new Map();
function synthGroups(letter) {
  if (!synthCache.has(letter)) {
    const cs = tubeCases.find((c) => c.name.startsWith(letter));
    synthCache.set(letter, quiet(() => groupsOf(channelBlock(cs.mesh))));
  }
  return synthCache.get(letter);
}

// Export mit gesetzten Test-Hooks (exporters.js liest process.env bei jedem Aufruf)
function exportWith(groups, defeature, flip = '', reportOnly = false) {
  if (flip) process.env.STLREV_TEST_FLIP = flip; else delete process.env.STLREV_TEST_FLIP;
  if (reportOnly) process.env.STLREV_TEST_GUARD_REPORT_ONLY = '1'; else delete process.env.STLREV_TEST_GUARD_REPORT_ONLY;
  try {
    const t0 = performance.now();
    const res = quiet(() => buildVolumeStepBrepV2({ normalGroups: groups, defeature }));
    return { res, ms: performance.now() - t0 };
  } finally {
    delete process.env.STLREV_TEST_FLIP;
    delete process.env.STLREV_TEST_GUARD_REPORT_ONLY;
  }
}
const strictKinds = (step) => {
  const by = {};
  for (const v of checkStepStrict(step).violations) by[v.kind] = (by[v.kind] || 0) + 1;
  return by;
};
const count = (step, re) => (step.match(re) || []).length;

let fails = 0;
const check = (ok, msg) => { origLog(`  ${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) fails++; };

// ── Positiv: keine Fehlalarme ───────────────────────────────────────────────
origLog('Positivtest — kein Fehlalarm (alle Samples AN/AUS, gefaste Welle, Synthetik-Kanäle A–C)');
let guardMsMax = 0;
for (const f of readdirSync(SAMPLES).filter((x) => x.toLowerCase().endsWith('.stl')).sort()) {
  const g = sampleGroups(f);
  for (const on of [true, false]) {
    const { res } = exportWith(g, on);
    const r = res.report;
    guardMsMax = Math.max(guardMsMax, r.orientationGuardMs);
    const analytic = r.boresConverted + r.mantlesConverted + r.mantleConesConverted + r.tubesConverted;
    check(r.orientationGuardFailures === 0 && r.fallbackStage === 0,
      `${f.slice(0, 48).padEnd(48)} ${on ? 'AN ' : 'AUS'}  Wächter 0 (analytisch: ${r.boresConverted} Bohrungen, ${r.mantlesConverted} Mäntel, ${r.mantleConesConverted} Kegel, ${r.tubesConverted} Kanäle, Fallback-Stufe ${r.fallbackStage})${analytic ? '' : ' — nichts zu prüfen'}`);
  }
}
for (const on of [true, false]) {
  const { res } = exportWith(genGroups('gefaste Welle', CHAMFERED_SHAFT), on);
  const r = res.report;
  check(r.orientationGuardFailures === 0 && r.fallbackStage === 0 && r.mantlesConverted === 1 && r.mantleChamfersConverted === 2,
    `${'Welle mit gefasten Außenkanten (gen.mjs)'.padEnd(48)} ${on ? 'AN ' : 'AUS'}  Wächter 0 (analytisch: ${r.mantlesConverted} Mantel, ${r.mantleChamfersConverted} Fasen-Kegel)`);
}
for (const letter of ['A', 'B', 'C']) {
  const { res } = exportWith(synthGroups(letter), true);
  const r = res.report;
  check(r.orientationGuardFailures === 0 && r.tubesConverted === 1 && r.fallbackStage === 0,
    `Synthetik-Kanal ${letter}: Wächter 0, Kanal analytisch (${r.tubePieces} Stücke)`);
}

// ── Negativ: absichtlich verdrehte Flächen ──────────────────────────────────
// soll(r, step): die verdrehte Flächenart ist im Endergebnis nicht mehr enthalten
const NEG = [
  { flip: 'bore', on: true, src: () => sampleGroups('block_with_hole.stl'), name: 'block_with_hole', gone: (r) => r.boresConverted === 0 },
  { flip: 'bore', on: false, src: () => sampleGroups('washer_thin.stl'), name: 'washer_thin', gone: (r) => r.boresConverted === 0 },
  { flip: 'bore', on: true, src: () => sampleGroups(EBIKE), name: 'eBike verrundet', gone: (r) => r.boresConverted === 0, keepsDefeature: true },
  { flip: 'mantle', on: true, src: () => sampleGroups('cylinder.stl'), name: 'cylinder', gone: (r) => r.mantlesConverted === 0 },
  { flip: 'mantle', on: false, src: () => sampleGroups('washer_thin.stl'), name: 'washer_thin', gone: (r) => r.mantlesConverted === 0 },
  { flip: 'mantle', on: true, src: () => sampleGroups('washer_filleted.stl'), name: 'washer_filleted (Mantel + Bohrung + Kegel)', gone: (r) => r.mantlesConverted === 0 },
  { flip: 'mantle', on: true, src: () => fixtureGroups('v2_h_rohr.stl'), name: 'Härtetest h (Rohr, Deck-Rundungen)', gone: (r) => r.mantlesConverted === 0, keepsDefeature: true },
  { flip: 'mantle', on: true, src: () => fixtureGroups('v2_x_zapfen_rund.stl'), name: 'Härtetest j2 (Zapfen auf Platte: Rand = Innen-Loop)', gone: (r) => r.mantlesConverted === 0, keepsDefeature: true },
  { flip: 'mantlecone', on: true, src: () => sampleGroups('cone_frustum.stl'), name: 'cone_frustum (Kegelstumpf)', gone: (r, s) => r.mantleConesConverted === 0 && count(s, /CONICAL_SURFACE\(/g) === 0 },
  { flip: 'mantlecone', on: false, src: () => sampleGroups('cone_flat.stl'), name: 'cone_flat (flacher Kegelstumpf)', gone: (r, s) => r.mantleConesConverted === 0 && count(s, /CONICAL_SURFACE\(/g) === 0 },
  { flip: 'mantlecone', on: true, src: () => sampleGroups('cone_pointed.stl'), name: 'cone_pointed (Kegel mit Spitze, VERTEX_LOOP)', gone: (r, s) => r.mantleConesConverted === 0 && count(s, /CONICAL_SURFACE\(/g) === 0 },
  { flip: 'mantlecone', on: true, src: () => genGroups('gefaste Welle', CHAMFERED_SHAFT), name: 'Welle mit gefasten Außenkanten (Mantel-Fasen)', gone: (r, s) => r.mantleChamfersConverted === 0 && count(s, /CONICAL_SURFACE\(/g) === 0 },
  { flip: 'cone', on: true, src: () => sampleGroups('washer_chamfered.stl'), name: 'washer_chamfered', gone: (r, s) => count(s, /CONICAL_SURFACE\(/g) === 0 },
  { flip: 'cone', on: true, src: () => sampleGroups('washer_filleted.stl'), name: 'washer_filleted', gone: (r, s) => count(s, /CONICAL_SURFACE\(/g) === 0 },
  { flip: 'tube', on: true, src: () => sampleGroups(EBIKE_PLAIN), name: 'eBike ohne Rundungen', gone: (r) => r.tubesConverted === 0 },
  { flip: 'tube', on: true, src: () => sampleGroups(EBIKE), name: 'eBike verrundet', gone: (r) => r.tubesConverted === 0, keepsDefeature: true },
  { flip: 'tube', on: true, src: () => synthGroups('C'), name: 'Synthetik C (γ=20°, Rotation/Extrusion)', gone: (r) => r.tubesConverted === 0 },
  { flip: 'tubecurve', on: true, src: () => sampleGroups(EBIKE_PLAIN), name: 'eBike ohne Rundungen', gone: (r) => r.tubesConverted === 0 },
  { flip: 'tubecurve', on: false, src: () => synthGroups('A'), name: 'Synthetik A (Zylinder/Torus)', gone: (r) => r.tubesConverted === 0 },
  { flip: 'tubecurve', on: true, src: () => synthGroups('C'), name: 'Synthetik C (γ=20°)', gone: (r) => r.tubesConverted === 0 },
];
for (const n of NEG) {
  origLog(`\nNegativtest STLREV_TEST_FLIP=${n.flip} — ${n.name} (${n.on ? 'AN' : 'AUS'})`);
  const g = n.src();
  // (1) nur melden: der Fehler steckt in der Datei, das Verdikt sieht ihn nicht
  const bad = exportWith(g, n.on, n.flip, true).res;
  const sb = strictKinds(bad.step);
  check(bad.report.orientationGuardFailures > 0, `Wächter schlägt an (${bad.report.orientationGuardFailures} Flächen)`);
  check(bad.report.watertight === true, 'Wasserdicht-Verdikt sieht den Fehler NICHT (Kanten-Bilanz ausgeglichen)');
  check((sb['orient-curved'] || 0) > 0, `step-strict findet ihn unabhängig: orient-curved ${sb['orient-curved'] || 0}`);
  // (2) mit Fallback: sauberer Rückfall
  const { res } = exportWith(g, n.on, n.flip, false);
  const r = res.report, s = strictKinds(res.step);
  const orientBad = (s['orient-curved'] || 0) + (s['orient-plane'] || 0) + (s['loop-chain'] || 0) + (s['edge-use'] || 0) + (s['outer-bound'] || 0);
  check(r.orientationGuardFailures > 0 && r.fallbackStage >= 1, `Fallback ausgelöst (Stufe ${r.fallbackStage}, Wächter ${r.orientationGuardFailures})`);
  check(r.watertight && orientBad === 0, `Ergebnis wasserdicht, streng ohne Topologie-/Orientierungs-Verstöße ${JSON.stringify(s)}`);
  check(n.gone(r, res.step), 'verdrehte Flächenart nicht mehr im Export');
  if (n.keepsDefeature) check(r.fallbackStage === 1 && (r.bandsDefeatured > 0 || r.filletsDefeatured > 0), `Defeaturing bleibt erhalten (Stufe 1, ${r.bandsDefeatured} Bänder, ${r.cornersDefeatured} Ecken)`);
}

// ── Laufzeit ────────────────────────────────────────────────────────────────
origLog('\nLaufzeit des Wächters (Anteil am Export, Mittel aus 3 Läufen)');
const timeIt = (name, groups) => {
  let ex = 0, gd = 0;
  for (let i = 0; i < 3; i++) { const { res, ms } = exportWith(groups, true); ex += ms; gd += res.report.orientationGuardMs; }
  origLog(`  ${name.padEnd(40)} Export ${(ex / 3).toFixed(1).padStart(7)} ms, davon Wächter ${(gd / 3).toFixed(2).padStart(6)} ms (${(100 * gd / ex).toFixed(1)} %)`);
};
timeIt('eBike verrundet (AN)', sampleGroups(EBIKE));
timeIt('eBike ohne Rundungen (AN)', sampleGroups(EBIKE_PLAIN));
origLog(`  Maximum über alle Samples: ${guardMsMax.toFixed(2)} ms`);
if (STRESS) {
  // 50k-Torus wie golden-regression.mjs (Kanäle/Bohrungen gibt es dort nicht → Wächter ≈ 0)
  const faces = [];
  const add = (a, b, c) => { const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]; const nn = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]; const l = Math.hypot(...nn) || 1; faces.push({ normal: nn.map((x) => x / l), vertices: [a, b, c] }); };
  const Rb = 20, rt = 5, NU = 250, NV = 100;
  const P = (u, v) => { const U = 2 * Math.PI * u / NU, V = 2 * Math.PI * v / NV; return [(Rb + rt * Math.cos(V)) * Math.cos(U), (Rb + rt * Math.cos(V)) * Math.sin(U), rt * Math.sin(V)]; };
  for (let u = 0; u < NU; u++) for (let v = 0; v < NV; v++) { const a = P(u, v), b = P(u + 1, v), c = P(u + 1, v + 1), d = P(u, v + 1); add(a, b, c); add(a, c, d); }
  timeIt('Stress-Torus 50k (AN)', quiet(() => groupsOf({ faces })));
}

origLog(fails ? `\n❌ ${fails} Prüfung(en) fehlgeschlagen` : '\n✅ Orientierungs-Wächter grün (kein Fehlalarm, alle Verdrehungen gefangen, sauberer Rückfall)');
process.exit(fails ? 1 : 0);

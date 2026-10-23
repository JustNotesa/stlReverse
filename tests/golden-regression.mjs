// ─────────────────────────────────────────────────────────────────────────────
// Golden-Regressionstest: Kennzahlen JEDER Beispieldatei gegen tests/golden.json.
//
// Warum: „wasserdicht + occt parst" allein hat keine Zähne — der facettierte Fallback ist
// immer wasserdicht und parsebar, ein still verlorenes Feature (Bohrung, Fase) fällt so nicht
// auf. Hier wird je Sample exakt festgehalten: Flächenzahl, wasserdicht, umgewandelte
// Bohrungen, entfernte Verrundungen, Anzahl CYLINDRICAL/CONICAL_SURFACE, Erkennung
// (Bohrungen/Fillets), occt-Parse — plus eine Laufzeitgrenze gegen O(n²)-Regressionen
// (Bug-Historie: sphere_full lief 101 s statt 62 ms, der Worker bricht nach 60 s ab).
//
// Läuft die ECHTE Worker-Pipeline (gleiche Module, gleiche Reihenfolge wie analysis-worker.js):
//   parseStl → simplifyMesh (>50k) → buildNormalGroups → unifyCoplanarGroups →
//   recognizePrimitives → buildVolumeStepBrepV2 (Defeaturing-Toggle AN und AUS)
//
// Ausführen:   npm run test:golden            (Exit 0 = alles wie erwartet, 1 = Abweichung)
// Bewusst übernehmen (nach Prüfung des Diffs!):  npm run test:golden -- --update
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createRequire } from 'module';
import { parseStl, simplifyMesh } from '../analysis-core.js';
import { buildNormalGroups } from '../region-growing.js';
import { unifyCoplanarGroups } from '../face-unification.js';
import { recognizePrimitives } from '../primitive-recognition.js';
import { buildVolumeStepBrepV2 } from '../exporters.js';

const require = createRequire(import.meta.url);
const { parseStep } = require('./occt-check.cjs');
const __dirname = dirname(fileURLToPath(import.meta.url));
const SAMPLES = join(__dirname, '..', 'samples');
const GOLDEN = join(__dirname, 'golden.json');
const MAX_FACES = 50000;            // wie analysis-worker.js
const RECOG_LIMIT_MS = 10000;       // pro Sample — der Worker bricht nach 60 s ab (Browser ~2× langsamer)
const STRESS_LIMIT_MS = 20000;      // 50k-Stressnetze
const UPDATE = process.argv.includes('--update');

// Silence occt-import-js „StepFile : Incorrect …“-Rauschen auf stdout
const origLog = console.log;
const quiet = async (fn) => { console.log = () => {}; try { return await fn(); } finally { console.log = origLog; } };

function pipeline(mesh) {
  if (mesh.faces.length > MAX_FACES) mesh = simplifyMesh(mesh, MAX_FACES, () => {});
  const groups = unifyCoplanarGroups(buildNormalGroups(mesh)).unified
    .sort((a, b) => b.vertices.length - a.vertices.length);
  const t0 = performance.now();
  const { stats } = recognizePrimitives(groups);
  const recogMs = performance.now() - t0;
  return { groups, stats, recogMs };
}

async function metrics(groups, defeature) {
  const res = buildVolumeStepBrepV2({ normalGroups: groups, defeature });
  if (!res) return { exported: false };
  const r = res.report;
  const occt = await quiet(() => parseStep(res.step));
  return {
    exported: true,
    faces: r.faceCount,
    watertight: r.watertight,
    boresConverted: r.boresConverted,
    filletsDefeatured: r.filletsDefeatured ?? 0,
    cylindrical: (res.step.match(/CYLINDRICAL_SURFACE\(/g) || []).length,
    conical: (res.step.match(/CONICAL_SURFACE\(/g) || []).length,
    occt: !!occt.success,
  };
}

// Deterministische 50k-Stressnetze (UV-Kugel, Torus) — fangen O(n²) in der Erkennung.
function stressMesh(kind) {
  const faces = [];
  const add = (a, b, c) => {
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const l = Math.hypot(...n) || 1;
    faces.push({ normal: n.map((x) => x / l), vertices: [a, b, c] });
  };
  if (kind === 'sphere50k') {
    const R = 20, NL = 125, NO = 200;
    const P = (i, j) => { const th = Math.PI * i / NL, ph = 2 * Math.PI * j / NO; return [R * Math.sin(th) * Math.cos(ph), R * Math.sin(th) * Math.sin(ph), R * Math.cos(th)]; };
    for (let i = 0; i < NL; i++) for (let j = 0; j < NO; j++) {
      const a = P(i, j), b = P(i + 1, j), c = P(i + 1, j + 1), d = P(i, j + 1);
      if (i > 0) add(a, b, d);
      if (i < NL - 1) add(b, c, d);
    }
  } else {
    const Rb = 20, r = 5, NU = 250, NV = 100;
    const P = (u, v) => { const U = 2 * Math.PI * u / NU, V = 2 * Math.PI * v / NV; return [(Rb + r * Math.cos(V)) * Math.cos(U), (Rb + r * Math.cos(V)) * Math.sin(U), r * Math.sin(V)]; };
    for (let u = 0; u < NU; u++) for (let v = 0; v < NV; v++) {
      const a = P(u, v), b = P(u + 1, v), c = P(u + 1, v + 1), d = P(u, v + 1);
      add(a, b, c); add(a, c, d);
    }
  }
  return { faces };
}

const golden = existsSync(GOLDEN) ? JSON.parse(readFileSync(GOLDEN, 'utf8')) : {};
const next = {};
const failures = [];
const check = (name, key, got, want) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) failures.push(`${name}: ${key} = ${JSON.stringify(got)}, erwartet ${JSON.stringify(want)}`);
};

const files = readdirSync(SAMPLES).filter((f) => f.toLowerCase().endsWith('.stl')).sort();
for (const f of files) {
  const buf = readFileSync(join(SAMPLES, f));
  const mesh = parseStl(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), () => {});
  const { groups, stats, recogMs } = pipeline(mesh);
  const on = await metrics(groups, true);
  const off = await metrics(groups, false);
  const entry = { bores: stats.bores, fillets: stats.fillets, defeatureOn: on, defeatureOff: off };
  next[f] = entry;
  const flag = recogMs > RECOG_LIMIT_MS ? '  ⚠ LANGSAM' : '';
  origLog(`${f.padEnd(70)} ${String(Math.round(recogMs)).padStart(6)} ms  faces=${on.faces}/${off.faces} wt=${on.watertight} bores=${on.boresConverted} cone=${on.conical}${flag}`);
  if (recogMs > RECOG_LIMIT_MS) failures.push(`${f}: Erkennung ${Math.round(recogMs)} ms > ${RECOG_LIMIT_MS} ms (O(n²)-Regression?)`);
  if (!UPDATE) {
    const g = golden[f];
    if (!g) { failures.push(`${f}: kein Golden-Eintrag (neues Sample? → --update)`); continue; }
    for (const k of Object.keys(entry)) check(f, k, entry[k], g[k]);
  }
}

for (const kind of ['sphere50k', 'torus50k']) {
  const mesh = stressMesh(kind);
  const t0 = performance.now();
  const { groups } = pipeline(mesh);
  const res = buildVolumeStepBrepV2({ normalGroups: groups });
  const ms = performance.now() - t0;
  origLog(`[stress] ${kind.padEnd(61)} ${String(Math.round(ms)).padStart(6)} ms  faces=${res ? res.report.faceCount : 'null'} wt=${res ? res.report.watertight : '-'}`);
  if (ms > STRESS_LIMIT_MS) failures.push(`[stress] ${kind}: ${Math.round(ms)} ms > ${STRESS_LIMIT_MS} ms`);
  if (!res) failures.push(`[stress] ${kind}: Export lieferte null (Region-Growing-Kollaps?)`);
  else if (!res.report.watertight) failures.push(`[stress] ${kind}: nicht wasserdicht`);
}

if (UPDATE) {
  writeFileSync(GOLDEN, JSON.stringify(next, null, 2) + '\n');
  origLog(`\n✍  ${GOLDEN} aktualisiert (${Object.keys(next).length} Samples). Diff prüfen und committen.`);
}
if (failures.length) {
  origLog(`\n❌ ${failures.length} Abweichung(en):`);
  for (const x of failures) origLog('  - ' + x);
  process.exit(UPDATE ? 0 : 1);
}
origLog('\n✅ Golden-Regression grün');

// ─────────────────────────────────────────────────────────────────────────────
// Lagen-Regression der Netz-Bereinigung (mesh-clean.js, Spalten-Kollaps).
//
// Dieselben synthetischen Körper (Extrusion mit fein abgetasteter Rundung + Fasen, Sehnen
// UNTER der Mindest-Detailgröße τ = 0,02 mm) werden in 12 Lagen gelegt (Verschiebungen bis
// 1000 mm, schiefe Drehungen), als float32-STL geschrieben und durch die volle Pipeline
// geschickt (cleanMesh → Region-Growing → Primitive → buildVolumeStepBrepV2, AN und AUS).
//
// Prüfung je Körper und Lage (columns = Spalten-Kollaps an, Referenz = columns:false, das
// Halbkanten-Verhalten vor dem Spalten-Kollaps):
//   - AN-Flächen == body.anFaces (Schärfung der Rundung gelingt in JEDER Lage)
//   - AN- und AUS-Flächen mit Spalten-Kollaps ≤ Referenz in derselben Lage
//   - STEP AN und AUS streng gültig (step-strict.mjs, 0 Verstöße)
// Anlass 2026-10-31: der erste Spalten-Kollaps kippte z5 bei reiner Verschiebung von 14 auf
// ~260 AN-Flächen (halbe Spalten, Reihenfolge der Kantenwahl hing an float32-Rundung).
//   node tests/lagen-regression.mjs [--body z5] [--verbose]
// ─────────────────────────────────────────────────────────────────────────────
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const imp = (f) => import(pathToFileURL(join(ROOT, f)).href);
const gen = await imp('tests/fixtures-v2/gen.mjs');
const { parseStl } = await imp('analysis-core.js');
const { buildNormalGroups } = await imp('region-growing.js');
const { cleanMesh } = await imp('mesh-clean.js');
const { unifyCoplanarGroups } = await imp('face-unification.js');
const { recognizePrimitives } = await imp('primitive-recognition.js');
const { detectTubes } = await imp('tube-sweep.js');
const { buildVolumeStepBrepV2 } = await imp('exporters.js');
const { checkStepStrict } = await imp('tests/step-strict.mjs');

export const POSES = [
  {}, { t: [120, -75, 40] }, { t: [-3.3, 7.7, 1.1] }, { t: [50, 50, 0] }, { rot: [23, 37, 11] },
  { rot: [23, 37, 11], t: [120, -75, 40] }, { rot: [0, 0, 30] }, { rot: [45, 30, 60], t: [-60, 80, 15] },
  { t: [1000, -800, 500] }, { rot: [90, 0, 0] }, { rot: [0, 90, 17], t: [7, 7, 7] }, { rot: [-31, 12, 78], t: [250, 3, -40] },
];
const ch = (r) => ({ kind: 'chamfer', r });
const BODIES = [
  { ...gen.BODIES.find((b) => b.id === 'z5'), anFaces: 14 },
  {
    id: 'r15fase', anFaces: null,
    columns: [{ name: 'r15', profile: gen.tangentFilletRectProfile(0, 0, 12, 8, 1.5, 'tr', 0.75), z0: 0, z1: 10, bottom: ch(0.3), top: ch(0.3) }],
  },
  {
    id: 'rrect', anFaces: null,
    columns: [{ name: 'rr', profile: gen.roundedRectProfile(16, 10, 1, 90), z0: 0, z1: 8, bottom: ch(0.4), top: ch(0.4) }],
  },
];

const args = process.argv.slice(2);
const only = args.includes('--body') ? args[args.indexOf('--body') + 1] : null;
const verbose = args.includes('--verbose');
const faces = (r) => (r ? (r.step.match(/ADVANCED_FACE\(/g) || []).length : -1);
const log = console.log;
const run = (ab, columns) => {
  console.log = () => {};
  try {
    const cm = cleanMesh(parseStl(ab, () => {}), { columns });
    const g = unifyCoplanarGroups(buildNormalGroups(cm.mesh)).unified.sort((a, b) => b.vertices.length - a.vertices.length);
    recognizePrimitives(g); detectTubes(g);
    const on = buildVolumeStepBrepV2({ normalGroups: g, defeature: true });
    const off = buildVolumeStepBrepV2({ normalGroups: g, defeature: false });
    const strict = [on, off].reduce((s, r) => s + (r ? checkStepStrict(r.step).violations.length : 1), 0);
    return { on: faces(on), off: faces(off), strict, rep: cm.report };
  } finally { console.log = log; }
};

let bad = 0;
for (const body of BODIES) {
  if (only && body.id !== only) continue;
  log(`── ${body.id}`);
  for (const pose of POSES) {
    const stl = gen.toBinaryStl(gen.buildMesh({ ...body, transform: pose }));
    const ab = stl.buffer.slice(stl.byteOffset, stl.byteOffset + stl.byteLength);
    const col = run(ab, true), ref = run(ab, false);
    const why = [];
    if (body.anFaces != null && col.on !== body.anFaces) why.push(`AN ${col.on} ≠ ${body.anFaces}`);
    if (col.on > ref.on) why.push(`AN ${col.on} > Ref ${ref.on}`);
    if (col.off > ref.off) why.push(`AUS ${col.off} > Ref ${ref.off}`);
    if (col.strict) why.push(`strict ${col.strict}`);
    if (why.length) bad++;
    const extra = verbose ? `  Spalten ${col.rep.columnCollapses}, Rückfall ${col.rep.columnBroken}, kurz ${col.rep.shortAfter}/${ref.rep.shortAfter}` : '';
    log(`${why.length ? '❌' : '✅'} ${JSON.stringify(pose).padEnd(40)} AN/AUS ${String(col.on).padStart(3)}/${String(col.off).padStart(3)}  Ref ${String(ref.on).padStart(3)}/${String(ref.off).padStart(3)}${extra}${why.length ? '  ' + why.join(', ') : ''}`);
  }
}
log(bad ? `\n❌ ${bad} Lagen schlechter als ohne Spalten-Kollaps` : '\n✅ Spalten-Kollaps in allen Lagen ≤ Referenz');
process.exit(bad ? 1 : 0);

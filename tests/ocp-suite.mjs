// ─────────────────────────────────────────────────────────────────────────────
// Unabhängiger CAD-Kern als zweiter Prüfer: volles OpenCascade (OCP-Python-Bindings, tests/occt-check.py)
// liest die exportierten STEP-Dateien OHNE die ShapeFix-Reparatur-Sequenz und prüft sie. Exportiert
// werden alle Samples (Toggle AN und AUS) und die Schalen-/Freigang-Testkörper aus
// tests/shell-regression.mjs (CASES), dazu beliebige weitere STL-Dateien von der Kommandozeile.
//
// Je Datei (hart, rot bei Abweichung):
//   - lesbar, BRepCheck_Analyzer gültig
//   - Körperzahl = report.solids, jeder Körper V > 0 und nicht innen-außen
//   - keine Randkanten, wenn der Export keine offene Schale meldet
//   - Volumen: Summe der Körper = Soll (Testkörper, 1e-4) bzw. = occt-import-js-Volumen derselben
//     Datei (Samples, 1e-3; der heilende Viewer-Leser und der rohe Kern müssen denselben Körper sehen)
//   - BRepAlgoAPI_Check (Selbstdurchdringung, Mini-Kanten) und ShapeAnalysis_Wire mit 1e-6 mm
//     (ACIS-Auflösung, CST: CheckSelfIntersection, CheckGaps3d, CheckSmall) gegen eine
//     Erwartungsliste je Datei (EXPECT, Standard: keine Befunde) — NEUE oder mehr Befunde sind rot,
//     weniger werden gemeldet (Liste nachziehen).
// Was occt-check.py sieht und was nicht: s. Kopf dort (u.a. dreht der STEP-Übersetzer innen-außen
// vertauschte Körper still um — Schalen-Orientierung prüft tests/step-strict.mjs).
//
// Python mit OCP: Umgebungsvariable OCP_PYTHON (z.B. "arch -arm64 /usr/bin/python3"; gesetzt = nur
// dieser), sonst auf macOS "arch -arm64 /usr/bin/python3", dann "python3". Ohne OCP wird die Suite
// SAUBER übersprungen (Exit 0). NICHTS wird installiert.
//
// Ausführen:  npm run test:ocp            (Exit 0 = grün oder übersprungen)
//             node tests/ocp-suite.mjs ~/Downloads/teil.stl …   (zusätzliche STL, Erwartung: sauber)
// ─────────────────────────────────────────────────────────────────────────────
import { spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { dirname, join, basename } from 'path';
import { createRequire } from 'module';
import { parseStl, simplifyMesh } from '../analysis-core.js';
import { buildNormalGroups } from '../region-growing.js';
import { cleanMesh } from '../mesh-clean.js';
import { unifyCoplanarGroups } from '../face-unification.js';
import { recognizePrimitives } from '../primitive-recognition.js';
import { detectTubes } from '../tube-sweep.js';
import { buildVolumeStepBrepV2 } from '../exporters.js';
import * as G from './fixtures-v2/gen.mjs';
import { CASES, groupsOfTris, exportCase, wantVolume } from './shell-regression.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const origLog = console.log;
const quiet = (fn) => { console.log = () => {}; try { return fn(); } finally { console.log = origLog; } };

// ---- Python mit OCP finden
const candidates = [];
if (process.env.OCP_PYTHON) candidates.push(process.env.OCP_PYTHON.split(/\s+/).filter(Boolean));   // gesetzt → nur dieser
else {
  if (process.platform === 'darwin') candidates.push(['arch', '-arm64', '/usr/bin/python3']);
  candidates.push(['python3']);
}
let py = null;
for (const c of candidates) {
  const r = spawnSync(c[0], [...c.slice(1), '-c', 'import OCP'], { encoding: 'utf8' });
  if (!r.error && r.status === 0) { py = c; break; }
}
if (!py) {
  origLog('⏭  OCP (OpenCascade für Python) nicht gefunden — OCP-Suite übersprungen (kein Fehler).');
  process.exit(0);
}
origLog(`OCP-Prüfer: ${py.join(' ')} tests/occt-check.py`);

// ---- Erwartete Befunde je Datei (Schlüssel: Dateiname wie unten erzeugt). bop = BRepAlgoAPI_Check,
// sa = ShapeAnalysis (Anzahl Flächen). Alles nicht Aufgeführte muss befundfrei sein.
const EBIKE_PLAIN = 'fischerEbike - FahrradLicht - mount unter sattel(ohne rundungen).stl';
const EBIKE = 'fischerEbike - FahrradLicht - mount unter sattel.stl';
const EXPECT = {
  // dino: zwei Körper durchdringen sich schon im NETZ (44 Kanten-Durchstöße zwischen den Komponenten
  // mit 2176 und 1048 Dreiecken, gemessen am STL) plus Selbstberührungen innerhalb der Körper
  'dino_clip_v3_04-strong-closing.stl [AN]': { bop: { BOPAlgo_SelfIntersect: 51 } },
  'dino_clip_v3_04-strong-closing.stl [AUS]': { bop: { BOPAlgo_SelfIntersect: 51 } },
  // eBike: Übergangskurven der Kanal-SURFACE_OF_REVOLUTION liegen neben deren Naht — OCCT teilt sie
  // beim Lesen (Kanal-Bereich, bekannte Ausnahme, nicht hier zu beheben)
  [`${EBIKE_PLAIN} [AN]`]: { sa: { gaps3d: 2 } },
  [`${EBIKE_PLAIN} [AUS]`]: { sa: { gaps3d: 2 } },
  [`${EBIKE} [AN]`]: { sa: { gaps3d: 2 } },
  [`${EBIKE} [AUS]`]: { sa: { gaps3d: 2 } },
};
for (const cs of CASES) if (cs.ocpBop) for (const t of ['AN', 'AUS']) EXPECT[`${cs.name} [${t}]`] = { bop: cs.ocpBop };

// ---- Exportieren
const require = createRequire(import.meta.url);
const { getOcct } = require('./occt-check.cjs');
const occt = await getOcct();
// Gegenprobe-Volumen der Samples: occt-import-js tesselliert mit 0.002 mm / 0.05 rad (mit 0.0005 mm
// brauchte allein das eBike 48 s je Datei); gegen OCP gemessen ≤ 1.1e-4 relativ → Toleranz 1e-3 (die
// gesuchten Fehler lagen bei 28–33 %). Testkörper vergleichen exakt mit ihrem Soll (1e-4).
const OCCT_PARAMS = { linearUnit: 'millimeter', linearDeflectionType: 'absolute_value', linearDeflection: 0.002, angularDeflection: 0.05 };
const occtVolume = (step) => {
  const r = quiet(() => occt.ReadFile('step', new Uint8Array(Buffer.from(step)), OCCT_PARAMS));
  if (!r.success) return NaN;
  let v = 0;
  for (const m of r.meshes) {
    const p = m.attributes.position.array, ix = m.index.array;
    const P = (i) => [p[3 * i], p[3 * i + 1], p[3 * i + 2]];
    for (let i = 0; i < ix.length; i += 3) v += G.triVolume(P(ix[i]), P(ix[i + 1]), P(ix[i + 2]));
  }
  return v;
};
const groupsOfStl = (buf) => {
  let mesh = cleanMesh(parseStl(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), () => {})).mesh;
  if (mesh.faces.length > 50000) mesh = simplifyMesh(mesh, 50000, () => {});
  const groups = unifyCoplanarGroups(buildNormalGroups(mesh)).unified.sort((a, b) => b.vertices.length - a.vertices.length);
  quiet(() => recognizePrimitives(groups));
  quiet(() => detectTubes(groups));
  return groups;
};
const dir = mkdtempSync(join(tmpdir(), 'stlrev-ocp-'));
const jobs = [];   // { name, file, report, vSoll|null, vOcct }
const add = (name, res, vSoll = null) => {
  const file = join(dir, `${jobs.length}.step`);
  writeFileSync(file, res.step);
  jobs.push({ name, file, report: res.report, vSoll, vOcct: vSoll === null ? occtVolume(res.step) : null });
};
const t0 = performance.now();
for (const f of readdirSync(join(ROOT, 'samples')).filter((x) => x.toLowerCase().endsWith('.stl')).sort()) {
  const groups = groupsOfStl(readFileSync(join(ROOT, 'samples', f)));
  for (const def of [true, false]) add(`${f} [${def ? 'AN' : 'AUS'}]`, quiet(() => buildVolumeStepBrepV2({ normalGroups: groups, defeature: def })));
}
for (const cs of CASES) {
  const tris = cs.tris(), groups = groupsOfTris(tris), vSoll = wantVolume(cs, tris);
  for (const def of [true, false]) add(`${cs.name} [${def ? 'AN' : 'AUS'}]`, exportCase(groups, def), vSoll);
}
for (const p of process.argv.slice(2)) {
  if (!existsSync(p)) { origLog(`⚠  ${p} nicht gefunden — übersprungen`); continue; }
  const groups = groupsOfStl(readFileSync(p));
  for (const def of [true, false]) add(`${basename(p)} [${def ? 'AN' : 'AUS'}]`, quiet(() => buildVolumeStepBrepV2({ normalGroups: groups, defeature: def })));
}
origLog(`${jobs.length} STEP-Dateien exportiert (${((performance.now() - t0) / 1000).toFixed(1)} s); OCP prüft …`);

// ---- OCP prüfen (ein Python-Prozess für alle Dateien)
const t1 = performance.now();
const pr = spawnSync(py[0], [...py.slice(1), join(__dirname, 'occt-check.py'), ...jobs.map((j) => j.file)], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const byFile = new Map();
for (const line of (pr.stdout || '').split('\n')) { if (line.startsWith('{')) { const o = JSON.parse(line); byFile.set(o.file, o); } }
rmSync(dir, { recursive: true, force: true });
if (pr.status !== 0 || byFile.size !== jobs.length) {
  origLog(`❌ occt-check.py fehlgeschlagen (Exit ${pr.status}, ${byFile.size}/${jobs.length} Ergebnisse)\n${(pr.stderr || '').slice(-2000)}`);
  process.exit(1);
}
origLog(`OCP fertig (${((performance.now() - t1) / 1000).toFixed(1)} s)\n`);

// ---- Auswerten
let failures = 0;
const notes = [];
const cmpFindings = (got = {}, want = {}) => {
  const bad = [], fewer = [];
  for (const [k, n] of Object.entries(got)) if (n > (want[k] || 0)) bad.push(`${k} ${n} (erwartet ${want[k] || 0})`);
  for (const [k, n] of Object.entries(want)) if ((got[k] || 0) < n) fewer.push(`${k} ${got[k] || 0} statt ${n}`);
  return { bad, fewer };
};
for (const j of jobs) {
  const o = byFile.get(j.file), r = j.report, problems = [];
  if (!o.read) problems.push(`nicht lesbar ${o.error || ''}`);
  else {
    if (!o.valid) problems.push(`BRepCheck ungültig ${JSON.stringify(o.invalid.slice(0, 3))}`);
    if (o.solids.length !== r.solids) problems.push(`Körper ${o.solids.length} statt ${r.solids}`);
    if (o.solids.some((s) => !(s.volume > 0) || s.inverted)) problems.push(`Körper mit V ≤ 0 bzw. innen-außen: ${JSON.stringify(o.solids.map((s) => [Math.round(s.volume * 1e3) / 1e3, s.inverted]))}`);
    if (!r.openShells && o.freeEdges) problems.push(`${o.freeEdges} Randkanten ohne offene Schale`);
    const vs = o.solids.reduce((a, s) => a + s.volume, 0), vRef = j.vSoll ?? j.vOcct, tol = j.vSoll !== null ? 1e-4 : 1e-3;
    const rel = Math.abs(vs - vRef) / Math.max(Math.abs(vRef), 1e-9);
    if (!(rel <= tol)) problems.push(`Volumen ${vs.toFixed(4)} ≠ ${j.vSoll !== null ? 'Soll' : 'occt-import-js'} ${vRef.toFixed(4)} (rel. ${rel.toExponential(1)} > ${tol})`);
    const exp = EXPECT[j.name] || {};
    const b = cmpFindings(o.bop, exp.bop), s = cmpFindings(o.sa, exp.sa);
    if (b.bad.length) problems.push(`BOP: ${b.bad.join(', ')}`);
    if (s.bad.length) problems.push(`ShapeAnalysis 1e-6: ${s.bad.join(', ')}`);
    if (b.fewer.length || s.fewer.length) notes.push(`${j.name}: weniger Befunde als erwartet — ${[...b.fewer, ...s.fewer].join(', ')} (Erwartungsliste nachziehen)`);
  }
  const vs = o.read ? o.solids.reduce((a, s) => a + s.volume, 0) : NaN;
  const info = o.read ? `Körper ${o.solids.length}, V ${vs.toFixed(3)}, BOP ${JSON.stringify(o.bop)}, SA ${JSON.stringify(o.sa)}, ${o.ms} ms` : '';
  origLog(`${problems.length ? 'FAIL' : 'PASS'}  ${j.name.slice(0, 78).padEnd(78)} ${info}`);
  for (const p of problems) origLog(`        ${p}`);
  if (problems.length) failures++;
}
for (const n of notes) origLog(`ℹ  ${n}`);
origLog(`\n${failures === 0 ? `✅ OCP: alle ${jobs.length} Dateien gültig, Volumen stimmen, keine neuen Befunde` : `❌ OCP: ${failures} Datei(en) mit Abweichungen`}`);
process.exit(failures === 0 ? 0 : 1);

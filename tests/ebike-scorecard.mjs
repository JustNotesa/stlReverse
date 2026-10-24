// ─────────────────────────────────────────────────────────────────────────────
// eBike-Scorecard: Wie weit ist der fischerEbike-Halter „geknackt“?
//
// Referenz ist die eigene CAD-Version des Users OHNE Rundungen
// (samples/…(ohne rundungen).stl). Das verrundete Teil soll mit „Verrundungen entfernen“
// zu genau diesem Körper werden — und zwar aus echten CAD-Flächen statt Facetten.
//
// Gemessen:
//   1. Export-Report (wasserdicht, Flächen, entfernte Bänder/Ecken, umgewandelte Bohrungen)
//   2. Analytische Flächen in der STEP (CYLINDRICAL / TOROIDAL / CONICAL / PLANE)
//   3. FACETTEN-REST: Ebenen, deren Normale nicht achsparallel ist. Der Halter ist ein
//      rechtwinkliges Teil — jede schräge Ebene bildet eine gekrümmte Fläche (Loch, Kanal)
//      nach. Ziel: 0.
//   4. Geometrischer Abgleich mit der Referenz: Volumen und Querschnitte auf 6 Höhen.
//
// Ausführen:  npm run test:ebike   (informativ; Exit 1 nur bei Fehlern wie offener Hülle,
//                                   Volumen- oder Querschnitts-Abweichung > 0,5 %)
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createRequire } from 'module';
import { parseStl } from '../analysis-core.js';
import { buildNormalGroups } from '../region-growing.js';
import { unifyCoplanarGroups } from '../face-unification.js';
import { recognizePrimitives } from '../primitive-recognition.js';
import { buildVolumeStepBrepV2 } from '../exporters.js';

const require = createRequire(import.meta.url);
const { parseStep } = require('./occt-check.cjs');
const __dirname = dirname(fileURLToPath(import.meta.url));
const SAMPLES = join(__dirname, '..', 'samples');
const FILLETED = 'fischerEbike - FahrradLicht - mount unter sattel.stl';
const REFERENCE = 'fischerEbike - FahrradLicht - mount unter sattel(ohne rundungen).stl';
const origLog = console.log;
const quiet = async (fn) => { console.log = () => {}; try { return await fn(); } finally { console.log = origLog; } };

const load = (f) => { const buf = readFileSync(join(SAMPLES, f)); return parseStl(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), () => {}); };
const volume = (tris) => { let v = 0; for (const [a, b, c] of tris) v += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6; return Math.abs(v); };
// Netto-Schnittfläche eines geschlossenen Netzes mit der Ebene y = y0
const sliceArea = (tris, y0) => {
  let A = 0;
  for (const [a, b, c] of tris) {
    const pts = [a, b, c], s = pts.map((p) => p[1] - y0), X = [];
    for (let i = 0; i < 3; i++) { const p = pts[i], q = pts[(i + 1) % 3], sp = s[i], sq = s[(i + 1) % 3]; if ((sp < 0) !== (sq < 0)) { const t = sp / (sp - sq); X.push([p[0] + t * (q[0] - p[0]), p[2] + t * (q[2] - p[2])]); } }
    if (X.length !== 2) continue;
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    let [p, q] = X; if ((q[1] - p[1]) * n[0] - (q[0] - p[0]) * n[2] < 0) [p, q] = [q, p];
    A += (p[0] * q[1] - q[0] * p[1]) / 2;
  }
  return Math.abs(A);
};
// STEP auswerten: Flächentypen + schräge Ebenen (Facetten-Rest)
const stepStats = (step) => {
  const ents = new Map();
  for (const line of step.split('\n')) { const m = line.match(/^#(\d+)=(.*);$/); if (m) ents.set(m[1], m[2]); }
  const count = (re) => [...ents.values()].filter((e) => re.test(e)).length;
  let skew = 0;
  for (const e of ents.values()) {
    const m = e.match(/^ADVANCED_FACE\('[^']*',\([^)]*\),#(\d+),/);
    if (!m) continue;
    const surf = ents.get(m[1]) || '';
    const pm = surf.match(/^PLANE\('[^']*',#(\d+)\)/);
    if (!pm) continue;
    const ax = ents.get(pm[1]) || '';                         // AXIS2_PLACEMENT_3D('',#loc,#dir,#ref)
    const dm = ax.match(/AXIS2_PLACEMENT_3D\('[^']*',#\d+,#(\d+)/);
    const dir = dm && (ents.get(dm[1]) || '').match(/\(([^()]*)\)\)$/);
    if (!dir) continue;
    const n = dir[1].split(',').map(Number);
    if (Math.max(...n.map(Math.abs)) < 0.9999) skew++;
  }
  return {
    faces: count(/^ADVANCED_FACE\(/), plane: count(/^PLANE\(/), cylinder: count(/^CYLINDRICAL_SURFACE\(/),
    torus: count(/^TOROIDAL_SURFACE\(/), cone: count(/^CONICAL_SURFACE\(/), skewPlanes: skew,
  };
};

const mesh = load(FILLETED), ref = load(REFERENCE);
const groups = unifyCoplanarGroups(buildNormalGroups(mesh)).unified.sort((a, b) => b.vertices.length - a.vertices.length);
recognizePrimitives(groups);
const t0 = performance.now();
const res = buildVolumeStepBrepV2({ normalGroups: groups });
const ms = performance.now() - t0;
const r = res.report, st = stepStats(res.step);
const occ = await quiet(() => parseStep(res.step));
const trisStep = [];
for (const m of occ.meshes || []) { const P = m.attributes.position.array, I = m.index.array; for (let i = 0; i < I.length; i += 3) trisStep.push([0, 1, 2].map((k) => [P[I[i + k] * 3], P[I[i + k] * 3 + 1], P[I[i + k] * 3 + 2]])); }
const tRef = ref.faces.map((f) => f.vertices);
const vS = volume(trisStep), vR = volume(tRef);

const fails = [];
origLog('eBike-Scorecard (verrundet → „Verrundungen entfernen“ an)');
origLog(`  Export:      ${r.faceCount} Flächen, wasserdicht=${r.watertight}, Bänder=${r.bandsDefeatured ?? 0}, Ecken=${r.cornersDefeatured ?? 0}, Bohrungen=${r.boresConverted}, ${Math.round(ms)} ms, occt=${occ.success ? 'ok' : 'FEHLER'}`);
origLog(`  Flächenarten: PLANE ${st.plane} · CYLINDRICAL ${st.cylinder} · TOROIDAL ${st.torus} · CONICAL ${st.cone}`);
origLog(`  Facetten-Rest (schräge Ebenen, Ziel 0): ${st.skewPlanes}`);
origLog(`  Volumen:     ${vS.toFixed(1)} mm³  (Referenz ${vR.toFixed(1)}, Δ ${(vS - vR).toFixed(1)} = ${((vS - vR) / vR * 100).toFixed(3)} %)`);
const ys = [0.05, 0.5, 3, 5, 8.5, 9.95];
const sl = ys.map((y) => { const a = sliceArea(trisStep, y), b = sliceArea(tRef, y); return { y, a, b, d: a - b }; });
origLog('  Querschnitte: ' + sl.map((s) => `y=${s.y}: Δ ${s.d.toFixed(2)} mm²`).join(' · '));
if (!r.watertight) fails.push('Export nicht wasserdicht');
if (!occ.success) fails.push('occt kann die STEP nicht lesen');
if (Math.abs(vS - vR) / vR > 0.005) fails.push(`Volumen weicht ${((vS - vR) / vR * 100).toFixed(2)} % von der Referenz ab`);
for (const s of sl) if (Math.abs(s.d) / s.b > 0.005) fails.push(`Querschnitt y=${s.y} weicht ${(s.d / s.b * 100).toFixed(2)} % ab`);
if (fails.length) { origLog('\n❌ ' + fails.join('\n❌ ')); process.exit(1); }
origLog(`\n✅ deckungsgleich mit der Referenz — noch ${st.skewPlanes} Facetten statt echter Flächen`);

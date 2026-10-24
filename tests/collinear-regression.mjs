// ─────────────────────────────────────────────────────────────────────────────
// Regressionstest: kollineare Zwischenpunkte auf geraden Kanten (removeCollinearPoints)
//
// Der Exporter übernimmt ROH-Netzpunkte in die Flächen-Loops (wasserdicht). Ist eine gerade
// Kante im Netz unterteilt (Extrusionsteil, Seitenwände entlang Z in Streifen tesselliert),
// bestand sie im STEP aus einer Kette kurzer Stücke. Die Bereinigung fasst sie zu EINER Kante
// zusammen. Warum ein eigener Test: der Golden-Test zählt Flächen, nicht Kanten — eine
// zurückgenommene Bereinigung bliebe dort grün.
//
// Prüft je Paar fein/grob (gen_extrude.mjs: identische Geometrie, fein = Wände bei z=4/8/12/16
// bzw. 2.5/5/7.5 unterteilt): gleiche Anzahl EDGE_CURVE/VERTEX_POINT, IDENTISCHE Eckpunkte,
// wasserdicht, occt parst — mit Defeaturing an und aus. Dazu der L-Winkel konkret: 6 senkrechte
// Kanten, jede EIN Stück von z=0 bis z=20.
//
// Ausführen:  node tests/collinear-regression.mjs   (Exit 0 = alle grün, 1 = Fehler)
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync, mkdtempSync, rmSync } from 'fs';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createRequire } from 'module';
import { parseStl } from '../analysis-core.js';
import { unifyCoplanarGroups } from '../face-unification.js';
import { buildNormalGroups } from '../region-growing.js';
import { recognizePrimitives } from '../primitive-recognition.js';
import { buildVolumeStepBrepV2 } from '../exporters.js';

const require = createRequire(import.meta.url);
const { parseStep } = require('./occt-check.cjs');
const __dirname = dirname(fileURLToPath(import.meta.url));
const origLog = console.log;
const quiet = async (fn) => { console.log = () => {}; try { return await fn(); } finally { console.log = origLog; } };

const dir = mkdtempSync(join(tmpdir(), 'stlrev-collinear-'));
execFileSync(process.execPath, [join(__dirname, 'fixtures-gen', 'gen_extrude.mjs'), dir]);

// STEP-Topologie: Eckpunkte (sortiert) + Kanten als Punktpaare
function topo(step) {
  const ent = new Map();
  for (const m of step.matchAll(/#(\d+)=([A-Z_]+)\((.*)\);/g)) ent.set(+m[1], { t: m[2], a: m[3] });
  const pt = (id) => ent.get(id).a.match(/\(([^)]*)\)/)[1].split(',').map(Number);
  const vtx = (id) => pt(+ent.get(id).a.match(/#(\d+)/)[1]);
  const verts = [], edges = [];
  for (const e of ent.values()) {
    if (e.t === 'VERTEX_POINT') verts.push(pt(+e.a.match(/#(\d+)/)[1]).join(','));
    if (e.t === 'EDGE_CURVE') { const [sv, ev] = [...e.a.matchAll(/#(\d+)/g)].map((m) => +m[1]); edges.push([vtx(sv), vtx(ev)]); }
  }
  return { verts: verts.sort(), edges };
}

function exportFor(name, defeature) {
  const buf = readFileSync(join(dir, `${name}.stl`));
  const mesh = parseStl(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), () => {});
  const groups = unifyCoplanarGroups(buildNormalGroups(mesh)).unified.sort((a, b) => b.vertices.length - a.vertices.length);
  recognizePrimitives(groups);
  return buildVolumeStepBrepV2({ normalGroups: groups, defeature });
}

let failures = 0;
const check = (label, cond) => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failures++;
};

try {
  for (const base of ['lbracket_concave', 'plate_4fillets']) {
    for (const defeature of [true, false]) {
      console.log(`\n${base}_fine vs _coarse — Defeaturing ${defeature ? 'an' : 'aus'}`);
      const fine = exportFor(`${base}_fine`, defeature), coarse = exportFor(`${base}_coarse`, defeature);
      if (!fine || !coarse) { console.log('  FAIL  Export lieferte null'); failures++; continue; }
      const tf = topo(fine.step), tc = topo(coarse.step);
      console.log(`  fein: ${tf.edges.length} Kanten / ${tf.verts.length} Ecken, grob: ${tc.edges.length} / ${tc.verts.length}, Flächen ${fine.report.faceCount}/${coarse.report.faceCount}`);
      check('gleiche Anzahl EDGE_CURVE wie das unverteilte Netz', tf.edges.length === tc.edges.length);
      check('identische Eckpunkte (VERTEX_POINT-Koordinaten exakt gleich)', JSON.stringify(tf.verts) === JSON.stringify(tc.verts));
      check('watertight === true', fine.report.watertight === true);
      check('occt parst die STEP', !!(await quiet(() => parseStep(fine.step))).success);
      if (base === 'lbracket_concave' && defeature) {
        const vert = tf.edges.filter(([p, q]) => p[0] === q[0] && p[1] === q[1]);
        check('L-Winkel: 6 senkrechte Kanten, jede EIN Stück z=0↔20', vert.length === 6 && vert.every(([p, q]) => Math.abs(p[2] - q[2]) === 20));
        check('L-Winkel: 18 Kanten / 12 Ecken (Prisma mit 8 Flächen)', tf.edges.length === 18 && tf.verts.length === 12);
      }
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? '✅ Kollinear-Bereinigung grün' : `❌ ${failures} Assertion(en) fehlgeschlagen`}`);
process.exit(failures === 0 ? 0 : 1);

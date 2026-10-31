// ─────────────────────────────────────────────────────────────────────────────
// Berührende-Körper-Regression: Körper, die einander BERÜHREN, ohne sich zu durchdringen —
// Fläche an Fläche, Kante an Kante, Ecke an Ecke. Im Netz steht die Kontaktfläche ZWEIMAL da
// (einmal mit der Normale zum Körper A, einmal mit der Normale zum Körper B) → Kanten mit
// 4 Dreiecken (nicht-manifold). Das ist in der Praxis häufig: zusammengesetzte CAD-Körper,
// 3D-Druck-Teile, Boolean-Restflächen.
//
// Je Fall × 4 Posen (unverändert / verschoben / gedreht / gedreht+verschoben) × Toggle AN/AUS:
//   - das Ergebnis ist wasserdicht (keine Rand-, keine nicht-manifolde Kante, kein Orientierungsfehler)
//   - tests/step-strict.mjs: 0 Verstöße (strikte Importer wie CST/ACIS)
//   - Körperzahl und Hohlraumzahl wie erwartet (Report)
//   - occt-import-js-Volumen = Soll (1e-4 relativ)
//   - die FLÄCHENZAHL ist in allen 4 Posen gleich — der Export darf nicht von der Lage abhängen
//
// Pipeline exakt wie der Worker: STL → parseStl → cleanMesh → buildNormalGroups →
// unifyCoplanarGroups → recognizePrimitives → detectTubes → buildVolumeStepBrepV2.
// OCP (volles OpenCascade) prüft dieselben Körper in tests/ocp-suite.mjs (CONTACT_CASES).
//
// Ausführen:  node tests/contact-regression.mjs          (Exit 0 = grün)
//              node tests/contact-regression.mjs --print  (Messwerte als Tabelle)
// ─────────────────────────────────────────────────────────────────────────────
import { createRequire } from 'module';
import { parseStl } from '../analysis-core.js';
import { buildNormalGroups } from '../region-growing.js';
import { cleanMesh } from '../mesh-clean.js';
import { unifyCoplanarGroups } from '../face-unification.js';
import { recognizePrimitives } from '../primitive-recognition.js';
import { detectTubes } from '../tube-sweep.js';
import { buildVolumeStepBrepV2 } from '../exporters.js';
import * as G from './fixtures-v2/gen.mjs';
import { checkStepStrict } from './step-strict.mjs';
import { box } from './shell-regression.mjs';

const origLog = console.log;
const quiet = (fn) => { console.log = () => {}; try { return fn(); } finally { console.log = origLog; } };

// ---- Körper-Generatoren (alle Maße in mm, Normalen nach außen)
// Quader wie in shell-regression.mjs — aber die BODENfläche mit der ANDEREN Diagonale
// ((x1,y0)–(x0,y1) statt (x0,y0)–(x1,y1)): die Berührfläche zweier gestapelter Quader hat
// dann zwei verschiedene Triangulierungen (Kreuzung der Diagonalen im Mittelpunkt).
function boxBottomAlt(a, b) {
  const [x0, y0, z0] = a, [x1, y1, z1] = b;
  const P = (x, y, z) => [x, y, z];
  const t = box(a, b);
  const idx = t.findIndex((tr) => tr.every((p) => p[2] === z0));
  if (idx < 0) throw new Error('boxBottomAlt: Bodenfläche nicht gefunden');
  const alt = [[P(x0, y0, z0), P(x0, y1, z0), P(x1, y0, z0)], [P(x0, y1, z0), P(x1, y1, z0), P(x1, y0, z0)]];
  return [...t.slice(0, idx), ...alt, ...t.slice(idx + 2)];
}

// Becher: Außenquader A×A über z0…z1 mit quadratischem Hohlraum a×a, der zur OFFENEN Seite
// (zo) hin offen ist; der Hohlraum reicht von zc bis zo, der geschlossene Boden liegt bei zb.
// up = true → offen nach oben (zb = z0, zo = z1). shift = 1 → der Randring an zo wird mit der
// anderen Diagonale trianguliert (wie boxBottomAlt).
function cup(A, a, z0, z1, up, shift = 0) {
  const zo = up ? z1 : z0, zc = up ? z1 - (z1 - z0) / 2 : z0 + (z1 - z0) / 2, zb = up ? z0 : z1;
  const O = [[0, 0], [A, 0], [A, A], [0, A]], I = [[a, a], [A - a, a], [A - a, A - a], [a, A - a]];
  const t = [];
  const P3 = (p, z) => [p[0], p[1], z];
  const q = (p, r, s, u) => { t.push([p, r, s], [p, s, u]); };
  // Außenwände (O ist CCW → die Normalen zeigen nach außen)
  for (let i = 0; i < 4; i++) { const p = O[i], n = O[(i + 1) % 4]; q(P3(p, z0), P3(n, z0), P3(n, z1), P3(p, z1)); }
  // geschlossener Boden bei zb (Normale weg vom Körper)
  if (up) q(P3(O[0], zb), P3(O[3], zb), P3(O[2], zb), P3(O[1], zb));
  else q(P3(O[0], zb), P3(O[1], zb), P3(O[2], zb), P3(O[3], zb));
  // Innenwände zwischen zc und zo (Normale in den Hohlraum)
  const lo = Math.min(zo, zc), hi = Math.max(zo, zc);
  for (let i = 0; i < 4; i++) { const p = I[i], n = I[(i + 1) % 4]; q(P3(p, lo), P3(p, hi), P3(n, hi), P3(n, lo)); }
  // Hohlraum-Boden bei zc (Normale zur offenen Seite)
  if (up) q(P3(I[0], zc), P3(I[1], zc), P3(I[2], zc), P3(I[3], zc));
  else q(P3(I[0], zc), P3(I[3], zc), P3(I[2], zc), P3(I[1], zc));
  // Randring an zo (Normale weg vom Körper) — shift 1 = andere Diagonale
  for (let i = 0; i < 4; i++) {
    const k = (i + shift) % 4, o0 = O[k], o1 = O[(k + 1) % 4], i0 = I[k], i1 = I[(k + 1) % 4];
    if (shift % 2 === 0) {
      if (up) q(P3(o0, zo), P3(o1, zo), P3(i1, zo), P3(i0, zo));
      else q(P3(o0, zo), P3(i0, zo), P3(i1, zo), P3(o1, zo));
    } else {
      if (up) { t.push([P3(o0, zo), P3(o1, zo), P3(i0, zo)], [P3(o1, zo), P3(i1, zo), P3(i0, zo)]); }
      else { t.push([P3(o0, zo), P3(i0, zo), P3(o1, zo)], [P3(o1, zo), P3(i0, zo), P3(i1, zo)]); }
    }
  }
  return t;
}

// Quadratische Pyramide: Grundfläche = Quadrat (2 Dreiecke, Normale −z), Spitze über dem
// Zentrum. Der Körper ist geschlossen — die Grundfläche liegt z. B. auf der Deckfläche einer
// Platte (dort liegt dieselbe Fläche noch einmal mit Normale +z).
function pyramid(cx, cy, z0, size, h) {
  const a = size / 2;
  const c = [[cx - a, cy - a, z0], [cx + a, cy - a, z0], [cx + a, cy + a, z0], [cx - a, cy + a, z0]];
  const apex = [cx, cy, z0 + h];
  const tris = [
    [c[0], c[3], c[2]], [c[0], c[2], c[1]],           // Grundfläche, Normale −z
    [c[0], c[1], apex], [c[1], c[2], apex], [c[2], c[3], apex], [c[3], c[0], apex],   // Seitenflächen
  ];
  if (!(G.meshVolume(tris) > 0)) throw new Error('Pyramide ist nicht nach außen gewickelt');
  return tris;
}

// Raster aus Einzelquadern (10 mm) — jeder Würfel ein eigener Körper (Wandflächen doppelt)
const vox = (cells, s = 10) => cells.flatMap(([i, j, k]) => box([i * s, j * s, k * s], [(i + 1) * s, (j + 1) * s, (k + 1) * s]));

const sharp = { kind: 'sharp' };
const col = (profile, z0, z1) => ({ profile, z0, z1, bottom: sharp, top: sharp });
const rotProfile = (p, k) => p.slice(k).concat(p.slice(0, k));   // Startpunkt der Kontur verschieben
// 24-Eck-Prisma (Kreis, 24 Segmente) als Säule
const P24 = G.circleProfile(0, 0, 10, 24);
const prism = (profile, z0, z1) => G.buildMesh({ columns: [col(profile, z0, z1)] });
// Ring-Rahmen: Außenkontur rr (CCW) + Loch (CW) als zwei Säulen → ein Körper mit Hohlraum
const RR = G.roundedRectProfile(50, 30, 5, 8);
const RING_HOLE = G.roundedRectProfile(46, 26, 3, 8).map(([x, y]) => [x + 2, y + 2]).reverse();
// Soll-Volumen des Ring-Rahmens mit EXAKTEN Eckbögen: seit die Kontaktfläche entfernt ist, laufen die
// Wände über die ganze Höhe durch und die Profil-Bögen (profile-arcs.js) greifen (vorher 74 Facetten-Flächen)
const RING_VOL = 25 * ((50 * 30 - (4 - Math.PI) * 25) - (46 * 26 - (4 - Math.PI) * 9));
const ringBody = (rr, hole, z0, z1) => G.buildMesh({ columns: [col(rr, z0, z1), col(hole, z0, z1)] });

// Rändel-Platte: 6×4 Zellen (2×2 mm, 1 mm hoch) als EINZELNE Quader (Wandflächen doppelt) +
// je Zelle eine geschlossene Quadratpyramide auf der Deckfläche (Grundfläche = Zell-Deckquadrat)
function knurlPlate(hasPyramid) {
  const tris = [];
  for (let i = 0; i < 6; i++) for (let j = 0; j < 4; j++) {
    const x = 2 * i, y = 2 * j;
    tris.push(...box([x, y, 0], [x + 2, y + 2, 1]));
    if (hasPyramid(i, j)) tris.push(...pyramid(x + 1, y + 1, 1, 2, 1));
  }
  return tris;
}
// nur die Pyramiden (Basen bei z = 1) — benachbarte Pyramiden stoßen KANTE an KANTE
const knurlPyramids = () => {
  const tris = [];
  for (let i = 0; i < 6; i++) for (let j = 0; j < 4; j++) tris.push(...pyramid(2 * i + 1, 2 * j + 1, 1, 2, 1));
  return tris;
};

// want: solids/voids (Report), vol ('mesh' = Netz-Volumen oder Zahl),
// ocpBop: erwartete BRepAlgoAPI_Check-Befunde (OCP-Suite; berührende Körper melden SelfIntersect)
export const CONTACT_CASES = [
  { name: 'Würfel gestapelt (Deckfläche doppelt)', tris: () => [...box([0, 0, 0], [10, 10, 10]), ...box([0, 0, 10], [10, 10, 20])], want: { solids: 1, voids: 0, vol: 2000, faces: { AN: 6, AUS: 6 } } },
  { name: 'Würfel gestapelt, andere Diagonale', tris: () => [...box([0, 0, 0], [10, 10, 10]), ...boxBottomAlt([0, 0, 10], [10, 10, 20])], want: { solids: 1, voids: 0, vol: 2000, faces: { AN: 6, AUS: 6 } } },
  // 24-Eck-Prisma: die Sehnenlänge (2·R·sin(π/24) = 2,61 mm) ist groß genug für die
  // Kreis-Umwandlung (Freigang der Kreis-Umwandlung, vgl. shell-regression) → der Export liefert
  // einen ZYLINDER R10 × 25 mm, nicht das 24-Eck. Soll daher das Zylinder-Volumen, nicht das
  // Netz-Volumen ('mesh').
  { name: '24-Eck-Prismen gestapelt, verdrehte Triangulierung', tris: () => [...prism(P24, 0, 10), ...prism(rotProfile(P24, 5), 10, 25)], want: { solids: 1, voids: 0, vol: Math.PI * 100 * 25, faces: { AN: 3, AUS: 3 } } },
  { name: 'Ring-Rahmen gestapelt', tris: () => [...ringBody(RR, RING_HOLE, 0, 10), ...ringBody(RR, RING_HOLE, 10, 25)], want: { solids: 1, voids: 0, vol: RING_VOL, faces: { AN: 18, AUS: 18 } } },
  { name: 'Ring-Rahmen gestapelt, verdreht', tris: () => [...ringBody(RR, RING_HOLE, 0, 10), ...ringBody(rotProfile(RR, 7), rotProfile(RING_HOLE, 14), 10, 25)], want: { solids: 1, voids: 0, vol: RING_VOL, faces: { AN: 18, AUS: 18 } } },
  { name: 'Kasten aus zwei Bechern (Hohlraum)', tris: () => [...cup(30, 5, 0, 20, true), ...cup(30, 5, 20, 40, false)], want: { solids: 1, voids: 1, vol: 28000, faces: { AN: 12, AUS: 12 } } },
  { name: 'Kasten aus zwei Bechern, andere Diagonalen', tris: () => [...cup(30, 5, 0, 20, true), ...cup(30, 5, 20, 40, false, 1)], want: { solids: 1, voids: 1, vol: 28000, faces: { AN: 12, AUS: 12 } } },
  { name: 'zwei Würfel, Berührung an einer Kante', tris: () => [...box([0, 0, 0], [10, 10, 10]), ...box([10, 0, 10], [20, 10, 20])], want: { solids: 2, voids: 0, vol: 2000, faces: { AN: 12, AUS: 12 } }, ocpBop: { BOPAlgo_SelfIntersect: 3 } },
  { name: 'zwei Würfel, Berührung in einer Ecke', tris: () => [...box([0, 0, 0], [10, 10, 10]), ...box([10, 10, 10], [20, 20, 20])], want: { solids: 2, voids: 0, vol: 2000, faces: { AN: 12, AUS: 12 } }, ocpBop: { BOPAlgo_SelfIntersect: 1 } },
  // Bügel: 7 Voxel, die über Flächen verbunden sind — zwei davon berühren sich an einer KANTE
  // (die Berühr-Kante ist eine Nicht-manifold-Kante: der Kern meldet dafür Selbstdurchdringungen)
  { name: 'Bügel mit Berühr-Kante (ein Körper)', tris: () => vox([[0, 0, 0], [1, 1, 0], [-1, 0, 0], [-1, 1, 0], [-1, 2, 0], [0, 2, 0], [1, 2, 0]]), want: { solids: 1, voids: 0, vol: 7000, faces: { AN: 14, AUS: 14 } }, ocpBop: { BOPAlgo_SelfIntersect: 27 } },
  // Bügel: 6 Voxel — zwei davon berühren sich an einer Ecke
  { name: 'Bügel mit Berühr-Ecke (ein Körper)', tris: () => vox([[0, 0, 0], [1, 1, 1], [-1, 0, 0], [-1, 1, 0], [-1, 1, 1], [0, 1, 1]]), want: { solids: 1, voids: 0, vol: 6000, faces: { AN: 12, AUS: 12 } }, ocpBop: { BOPAlgo_SelfIntersect: 18 } },
  { name: 'Rändel-Pyramiden auf Platte', tris: () => knurlPlate(() => true), want: { solids: 1, voids: 0, vol: 'mesh', faces: { AN: 101, AUS: 101 } } },
  { name: 'Rändel-Pyramiden im Schachbrett', tris: () => knurlPlate((i, j) => (i + j) % 2 === 0), want: { solids: 1, voids: 0, vol: 'mesh', faces: { AN: 65, AUS: 65 } } },
  // Bekannte Grenze: die 24 Grundflächen liegen in EINER Ebene und stoßen Kante an Kante; Region-Growing
  // und Flächen-Vereinigung machen daraus eine Rechteck-Fläche → EIN Körper, dessen Seitenflächen sich
  // entlang der Tal-Kanten berühren (OCP: gültig, aber BOP meldet die Berührungen). Wasserdicht,
  // strikt sauber, Volumen exakt; getrennte Körper bräuchten eine Topologie-Trennung bis ins Region-Growing.
  { name: 'Pyramiden stoßen Kante an Kante (ohne Platte)', tris: knurlPyramids, want: { solids: 1, voids: 0, vol: 'mesh', faces: { AN: 97, AUS: 97 } }, ocpBop: { BOPAlgo_SelfIntersect: 53 } },
];

// ---- Pipeline wie im Worker
export function contactGroups(tris) {
  const buf = G.toBinaryStl(tris, 'beruehr');
  const mesh = cleanMesh(parseStl(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), () => {})).mesh;
  const groups = unifyCoplanarGroups(buildNormalGroups(mesh)).unified.sort((a, b) => b.vertices.length - a.vertices.length);
  quiet(() => recognizePrimitives(groups));
  quiet(() => detectTubes(groups));
  return groups;
}
export const contactExport = (groups, defeature) => quiet(() => buildVolumeStepBrepV2({ normalGroups: groups, defeature }));
// Soll-Volumen eines Falls (Netz-Volumen oder analytisch)
export const contactWantVolume = (cs, tris) => (cs.want.vol === 'mesh' ? G.meshVolume(tris) : cs.want.vol);

// ---- Posen: unverändert, verschoben, gedreht, gedreht+verschoben (alle starr → Volumen bleibt)
const POSES = [
  {},
  { t: [137.3, -88.1, 42.7] },
  { rot: [23, 37, 11] },
  { rot: [-31, 12, 78], t: [60, 3, -40] },
];

const isMain = process.argv[1] && process.argv[1].endsWith('contact-regression.mjs');
if (isMain) {
  const PRINT = process.argv.includes('--print');
  const require = createRequire(import.meta.url);
  const { getOcct } = require('./occt-check.cjs');
  const occt = await getOcct();
  const OCCT_PARAMS = { linearUnit: 'millimeter', linearDeflectionType: 'absolute_value', linearDeflection: 0.0005, angularDeflection: 0.01 };
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
  let failures = 0;
  const check = (label, cond) => { origLog(`      ${cond ? 'PASS' : 'FAIL'}  ${label}`); if (!cond) failures++; };
  const rows = [];   // Messwerte (--print)
  const overview = [];   // eine Zeile je Fall (Fehlerzahl)

  for (const cs of CONTACT_CASES) {
    const fails = [];
    const caseCheck = (label, cond) => { if (!cond) fails.push(label); check(label, cond); };
    const baseTris = cs.tris();
    const vSoll = contactWantVolume(cs, baseTris);
    const faces = { AN: [], AUS: [] };
    for (let pi = 0; pi < POSES.length; pi++) {
      const T = G.makeTransform(POSES[pi]);
      const tris = baseTris.map((t) => t.map((v) => T.apply(v)));
      const groups = contactGroups(tris);
      for (const def of [true, false]) {
        const tag = def ? 'AN' : 'AUS';
        const res = contactExport(groups, def);
        origLog(`  ${cs.name} [Pose ${pi}] [${tag}]`);
        if (!res) { caseCheck('Export liefert ein Ergebnis', false); continue; }
        const r = res.report, s = res.step, w = cs.want;
        const st = checkStepStrict(s);
        const v = occtVolume(s);
        origLog(`      Flächen=${r.faceCount} Körper=${r.solids} Hohlräume=${r.voids} wasserdicht=${r.watertight} V(occt)=${v.toFixed(3)} strict=${st.violations.length}`);
        caseCheck('wasserdicht (keine Rand-/nicht-manifolde Kante, kein Orientierungsfehler)', r.watertight === true);
        const kinds = [...new Set(st.violations.map((x) => x.kind))].join(',');
        caseCheck(`step-strict sauber${kinds ? ` (Verstöße: ${kinds})` : ''}`, st.violations.length === 0);
        caseCheck(`Körper = ${w.solids}`, r.solids === w.solids);
        if ('voids' in w) caseCheck(`Hohlräume = ${w.voids}`, r.voids === w.voids);
        const rel = Math.abs(v - vSoll) / vSoll;
        caseCheck(`occt-Volumen ${v.toFixed(3)} = Soll ${vSoll.toFixed(3)} (rel. ${rel.toExponential(1)} ≤ 1e-4)`, rel <= 1e-4);
        faces[tag].push(r.faceCount);
        if (w.faces && !PRINT) caseCheck(`Flächen = ${w.faces[tag]}`, r.faceCount === w.faces[tag]);
        rows.push({ name: cs.name, pose: pi, tag, faces: r.faceCount, solids: r.solids, voids: r.voids, wt: r.watertight, strict: st.violations.length, v, vSoll });
      }
    }
    // Die Flächenzahl darf nicht von der Lage des Körpers abhängen (je Toggle über alle Posen)
    for (const tag of ['AN', 'AUS']) {
      const f = faces[tag];
      caseCheck(`Flächenzahl in allen ${POSES.length} Posen gleich (${tag}): ${f.join(', ')}`, f.length === POSES.length && f.every((x) => x === f[0]));
    }
    overview.push({ name: cs.name, fails });
  }

  origLog('\n  Übersicht je Fall');
  for (const o of overview) {
    origLog(`    ${o.fails.length ? 'FAIL' : 'PASS'}  ${o.name.padEnd(46)} ${o.fails.length} Fehler${o.fails.length ? ': ' + [...new Set(o.fails)].join(' | ') : ''}`);
  }

  if (PRINT) {
    origLog('\n  Messwerte (Fall × Pose × Toggle)');
    origLog(`  ${'Fall'.padEnd(46)} ${'Pose'.padStart(4)} ${'Tgl'.padStart(4)} ${'Fläch'.padStart(6)} ${'Körper'.padStart(6)} ${'Hohlr'.padStart(6)} ${'wasserd'.padStart(8)} ${'strict'.padStart(6)} ${'V(occt)'.padStart(12)} ${'Soll'.padStart(12)}`);
    for (const r of rows) {
      origLog(`  ${r.name.padEnd(46)} ${String(r.pose).padStart(4)} ${r.tag.padStart(4)} ${String(r.faces).padStart(6)} ${String(r.solids).padStart(6)} ${String(r.voids).padStart(6)} ${String(r.wt).padStart(8)} ${String(r.strict).padStart(6)} ${r.v.toFixed(3).padStart(12)} ${r.vSoll.toFixed(3).padStart(12)}`);
    }
  }

  origLog(`\n${failures === 0 ? '✅ alle Berühr-Regressionen grün' : `❌ ${failures} Assertion(en) fehlgeschlagen`}`);
  process.exit(failures === 0 ? 0 : 1);
}

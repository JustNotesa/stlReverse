// ─────────────────────────────────────────────────────────────────────────────
// Schalen- und Freigang-Regression (Review-Funde 2026-10): Körper im Speicher erzeugt, ECHTE
// Pipeline wie der Worker (parseStl → buildNormalGroups → unifyCoplanarGroups → recognizePrimitives →
// detectTubes → buildVolumeStepBrepV2, Toggle AN und AUS). Je Fall:
//   - Schalen-Typen laut Report (Körper, Hohlräume, offene Schalen, verworfen, umgedreht) und in der
//     STEP-Datei (MANIFOLD_SOLID_BREP/BREP_WITH_VOIDS, ORIENTED_CLOSED_SHELL, OPEN_SHELL)
//   - Kreis-Umwandlung ja/nein (Bohrungen, Mäntel) — dünner Steg → facettiert, dicker Steg → Kreis
//   - occt-import-js-Volumen = Soll (Netz-Volumen bzw. mit exakten Kreisen)
//   - tests/step-strict.mjs ohne Heilung: 0 Verstöße (inkl. shell-volume, shared-topology,
//     open-shell, loop-overlap)
// Dazu ein Prüfer-Selbsttest: absichtlich verdorbene Dateien müssen die neuen strict-Regeln auslösen.
// OCP (volles OpenCascade) prüft dieselben Körper in tests/ocp-suite.mjs (CASES wird exportiert).
//
// Ausführen:  npm run test:schalen     (Exit 0 = grün)
// ─────────────────────────────────────────────────────────────────────────────
import { createRequire } from 'module';
import { parseStl } from '../analysis-core.js';
import { buildNormalGroups } from '../region-growing.js';
import { unifyCoplanarGroups } from '../face-unification.js';
import { recognizePrimitives } from '../primitive-recognition.js';
import { detectTubes } from '../tube-sweep.js';
import { buildVolumeStepBrepV2 } from '../exporters.js';
import * as G from './fixtures-v2/gen.mjs';
import { checkStepStrict } from './step-strict.mjs';

const PI = Math.PI;
const origLog = console.log;
const quiet = (fn) => { console.log = () => {}; try { return fn(); } finally { console.log = origLog; } };

// ---- Körper
// Quader [a,b] als Dreiecke; inward = Normalen ins Innere (Hohlraum-Schale bzw. invertiertes Netz)
export function box(a, b, inward = false) {
  const [x0, y0, z0] = a, [x1, y1, z1] = b;
  const P = (x, y, z) => [x, y, z];
  const quads = [
    [P(x0, y0, z0), P(x0, y1, z0), P(x1, y1, z0), P(x1, y0, z0)], [P(x0, y0, z1), P(x1, y0, z1), P(x1, y1, z1), P(x0, y1, z1)],
    [P(x0, y0, z0), P(x1, y0, z0), P(x1, y0, z1), P(x0, y0, z1)], [P(x1, y1, z0), P(x0, y1, z0), P(x0, y1, z1), P(x1, y1, z1)],
    [P(x0, y1, z0), P(x0, y0, z0), P(x0, y0, z1), P(x0, y1, z1)], [P(x1, y0, z0), P(x1, y1, z0), P(x1, y1, z1), P(x1, y0, z1)],
  ];
  const tris = [];
  for (const [p, q, r, s] of quads) { if (!inward) tris.push([p, q, r], [p, r, s]); else tris.push([p, r, q], [p, s, r]); }
  return tris;
}
const sharp = { kind: 'sharp' };
const col = (profile, z0, z1) => ({ profile, z0, z1, bottom: sharp, top: sharp });
// n-Eck-Loch (CW), Kanten-Mitte bei 0° — zwei Löcher zeigen sich die Kanten-Mitten zu
const holeN = (cx, cy, R, n) => { const p = []; for (let i = 0; i < n; i++) { const a = PI / n + 2 * PI * i / n; p.push([cx + R * Math.cos(a), cy + R * Math.sin(a)]); } return p.reverse(); };
const polyArea = (n, R) => n / 2 * R * R * Math.sin(2 * PI / n);   // reguläres n-Eck, Umkreis R
// Würfel 10³ mit doppelseitiger Netz-Finne (Blech ohne Dicke) auf der Deckfläche
function cubeWithFin() {
  const P = (x, y, z) => [x, y, z];
  const cube = box([0, 0, 0], [10, 10, 10]).filter((t) => !t.every((p) => p[2] === 10));
  const A = P(0, 0, 10), B = P(10, 0, 10), C = P(10, 10, 10), D = P(0, 10, 10), Pp = P(2, 5, 10), Q = P(8, 5, 10), R = P(8, 5, 13), S = P(2, 5, 13);
  return [...cube, [A, B, Q], [A, Q, Pp], [A, Pp, D], [B, C, Q], [Pp, Q, C], [Pp, C, D], [Pp, Q, R], [Pp, R, S], [Pp, R, Q], [Pp, S, R]];
}
// zwei Bohrungen R (n Segmente) in einer Platte 80×40×5, Steg zwischen den POLYGONEN
function twoBores(web, n = 14, R = 10) {
  const d = 2 * R * Math.cos(PI / n) + web;
  return G.buildMesh({ columns: [col(G.rectProfile(0, 0, 80, 40), 0, 5), col(holeN(25, 20, R, n), 0, 5), col(holeN(25 + d, 20, R, n), 0, 5)] });
}
// Welle R10 (64 Seg.) mit exzentrischer Bohrung R3 (10 Seg.), Steg Polygon→Mantel
function shaftEccentric(web) {
  const nh = 10, Rh = 3, e = 10 - Rh * Math.cos(PI / nh) - web;
  const hole = []; for (let i = 0; i < nh; i++) { const a = PI / nh + 2 * PI * i / nh + PI; hole.push([e + Rh * Math.cos(a), Rh * Math.sin(a)]); }
  return G.buildMesh({ columns: [col(G.circleProfile(0, 0, 10, 64), 0, 10), col(hole.reverse(), 0, 10)] });
}
// Bohrung R10 (12 Seg.) nahe der Plattenkante (Platte 60×40×5), Restwand Polygon→Kante
function boreNearEdge(wall) {
  const R = 10, n = 12;
  return G.buildMesh({ columns: [col(G.rectProfile(0, 0, 60, 40), 0, 5), col(holeN(30, R * Math.cos(PI / n) + wall, R, n), 0, 5)] });
}
const plateWithBore = () => G.buildMesh({ columns: [col(G.rectProfile(0, 0, 40, 30), 0, 10), col(G.circleProfile(20, 15, 4, 32, true), 0, 10)] });
const looseTri = [[200, 0, 0], [210, 0, 0], [200, 10, 0]];

// want: solids/voids/open/dropped/inverted/bores/mantles (Report), vol ('mesh' = Netz-Volumen oder Zahl),
// ocpBop: erwartete BRepAlgoAPI_Check-Befunde (OCP-Suite; berührende Körper melden SelfIntersect)
export const CASES = [
  { name: 'Würfel 20³ mit innerem Hohlraum 10³', tris: () => [...box([0, 0, 0], [20, 20, 20]), ...box([5, 5, 5], [15, 15, 15], true)], want: { solids: 1, voids: 1, open: 0, vol: 7000 } },
  { name: 'Quader mit zwei Hohlräumen', tris: () => [...box([0, 0, 0], [30, 20, 20]), ...box([5, 5, 5], [10, 10, 10], true), ...box([20, 10, 10], [25, 15, 15], true)], want: { solids: 1, voids: 2, vol: 12000 - 250 } },
  { name: 'Platte mit Bohrung + innerem Hohlraum', tris: () => [...G.buildMesh({ columns: [col(G.rectProfile(0, 0, 60, 40), 0, 20), col(G.circleProfile(20, 20, 5, 32, true), 0, 20)] }), ...box([35, 10, 5], [50, 30, 15], true)],
    want: { solids: 1, voids: 1, bores: 1, vol: 60 * 40 * 20 - PI * 25 * 20 - 3000 } },
  { name: 'Hohlraum in invertiertem Netz (ganz innen-außen)', tris: () => [...box([0, 0, 0], [20, 20, 20], true), ...box([5, 5, 5], [15, 15, 15])], want: { solids: 1, voids: 1, inverted: 1, vol: 7000 } },
  { name: 'Insel im Hohlraum (Würfel im Hohlraum im Würfel)', tris: () => [...box([0, 0, 0], [30, 30, 30]), ...box([5, 5, 5], [25, 25, 25], true), ...box([10, 10, 10], [20, 20, 20])], want: { solids: 2, voids: 1, vol: 27000 - 8000 + 1000 } },
  { name: 'zwei getrennte Würfel', tris: () => [...box([0, 0, 0], [10, 10, 10]), ...box([20, 0, 0], [30, 10, 10])], want: { solids: 2, voids: 0, vol: 2000 } },
  { name: 'Würfel + loses Dreieck', tris: () => [...box([0, 0, 0], [10, 10, 10]), looseTri], want: { solids: 1, open: 1, vol: 1000 } },
  { name: 'Platte mit Bohrung + loses Dreieck', tris: () => [...plateWithBore(), looseTri], want: { solids: 1, open: 1, bores: 1, vol: 40 * 30 * 10 - PI * 16 * 10 } },
  { name: 'zwei Würfel, Berührung an einer Kante', tris: () => [...box([0, 0, 0], [10, 10, 10]), ...box([10, 0, 10], [20, 10, 20])], want: { solids: 2, vol: 2000 }, ocpBop: { BOPAlgo_SelfIntersect: 3 } },
  { name: 'zwei Würfel, Berührung in einer Ecke', tris: () => [...box([0, 0, 0], [10, 10, 10]), ...box([10, 10, 10], [20, 20, 20])], want: { solids: 2, vol: 2000 }, ocpBop: { BOPAlgo_SelfIntersect: 1 } },
  { name: 'Würfel mit Netz-Finne', tris: cubeWithFin, want: { solids: 1, dropped: 1, vol: 1000 } },
  { name: 'invertierter Würfel', tris: () => box([0, 0, 0], [10, 10, 10], true), want: { solids: 1, inverted: 1, vol: 1000 } },
  // Freigang der Kreis-Umwandlung: dünner Steg → facettiert (Volumen = Netz), dicker Steg → Kreis
  { name: 'zwei Bohrungen, Steg 0.2 mm', tris: () => twoBores(0.2), want: { solids: 1, bores: 0, vol: 'mesh' } },
  { name: 'zwei Bohrungen, Steg 1.0 mm (Kontrolle)', tris: () => twoBores(1.0), want: { solids: 1, bores: 2, vol: 80 * 40 * 5 - 2 * PI * 100 * 5 } },
  { name: 'Welle + exzentrische Bohrung, Steg 0.08 mm', tris: () => shaftEccentric(0.08), want: { solids: 1, mantles: 1, bores: 0, vol: (PI * 100 - polyArea(10, 3)) * 10 } },
  { name: 'Welle + exzentrische Bohrung, Steg 0.5 mm (Kontrolle)', tris: () => shaftEccentric(0.5), want: { solids: 1, mantles: 1, bores: 1, vol: PI * (100 - 9) * 10 } },
  { name: 'Bohrung an der Plattenkante, Wand 0.15 mm', tris: () => boreNearEdge(0.15), want: { solids: 1, bores: 0, vol: 'mesh' } },
  { name: 'Bohrung an der Plattenkante, Wand 1.0 mm (Kontrolle)', tris: () => boreNearEdge(1.0), want: { solids: 1, bores: 1, vol: 60 * 40 * 5 - PI * 100 * 5 } },
];

// ---- Pipeline wie im Worker
export function groupsOfTris(tris) {
  const buf = G.toBinaryStl(tris, 'schalen');
  const mesh = parseStl(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), () => {});
  const groups = unifyCoplanarGroups(buildNormalGroups(mesh)).unified.sort((a, b) => b.vertices.length - a.vertices.length);
  quiet(() => recognizePrimitives(groups));
  quiet(() => detectTubes(groups));
  return groups;
}
export const exportCase = (groups, defeature) => quiet(() => buildVolumeStepBrepV2({ normalGroups: groups, defeature }));
// Soll-Volumen eines Falls (Netz-Volumen oder analytisch)
export const wantVolume = (cs, tris) => (cs.want.vol === 'mesh' ? G.meshVolume(tris) : cs.want.vol);

const isMain = process.argv[1] && process.argv[1].endsWith('shell-regression.mjs');
if (isMain) {
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
  const count = (s, re) => (s.match(re) || []).length;
  let failures = 0;
  const check = (label, cond) => { origLog(`    ${cond ? 'PASS' : 'FAIL'}  ${label}`); if (!cond) failures++; };

  for (const cs of CASES) {
    const tris = cs.tris();
    const groups = groupsOfTris(tris);
    const vSoll = wantVolume(cs, tris);
    for (const def of [true, false]) {
      const res = exportCase(groups, def);
      origLog(`  ${cs.name} [${def ? 'AN' : 'AUS'}]`);
      if (!res) { check('Export liefert ein Ergebnis', false); continue; }
      const r = res.report, s = res.step, w = cs.want;
      const st = checkStepStrict(s);
      const v = occtVolume(s);
      const solidsStep = count(s, /=MANIFOLD_SOLID_BREP\(/g) + count(s, /=BREP_WITH_VOIDS\(/g);
      origLog(`      faces=${r.faceCount} Körper=${r.solids} Hohlräume=${r.voids} offen=${r.openShells} verworfen=${r.droppedShells} umgedreht=${r.invertedShells} bores=${r.boresConverted} mantles=${r.mantlesConverted} fallback=${r.fallbackStage} V(occt)=${v.toFixed(3)} strict=${st.violations.length}`);
      check(`Körper = ${w.solids} (Report und STEP)`, r.solids === w.solids && solidsStep === w.solids);
      check(`Hohlräume = ${w.voids ?? 0} (Report und ORIENTED_CLOSED_SHELL .F.)`, r.voids === (w.voids ?? 0) && count(s, /=ORIENTED_CLOSED_SHELL\('',\*,#\d+,\.F\.\)/g) === (w.voids ?? 0));
      check(`offene Schalen = ${w.open ?? 0}`, r.openShells === (w.open ?? 0) && count(s, /=OPEN_SHELL\(/g) === (w.open ?? 0));
      check(`verworfen = ${w.dropped ?? 0}, umgedreht = ${w.inverted ?? 0}`, r.droppedShells === (w.dropped ?? 0) && r.invertedShells === (w.inverted ?? 0));
      if ('bores' in w) check(`Bohrungen umgewandelt = ${w.bores}`, r.boresConverted === w.bores);
      if ('mantles' in w) check(`Mäntel umgewandelt = ${w.mantles}`, r.mantlesConverted === w.mantles);
      check('kein Sicherheits-Rückfall', r.fallbackStage === 0);
      const rel = Math.abs(v - vSoll) / vSoll;
      check(`occt-Volumen ${v.toFixed(3)} = Soll ${vSoll.toFixed(3)} (rel. ${rel.toExponential(1)} ≤ 1e-4)`, rel <= 1e-4);
      const kinds = [...new Set(st.violations.map((x) => x.kind))].join(',');
      check(`step-strict sauber${kinds ? ` (Verstöße: ${kinds})` : ''}`, st.violations.length === 0);
    }
  }

  // ---- Prüfer-Selbsttest: absichtlich verdorbene Dateien → genau die neuen Regeln schlagen an
  origLog('\n  Prüfer-Selbsttest (step-strict, neue Regeln)');
  const kindsOf = (step) => new Set(checkStepStrict(step).violations.map((x) => x.kind));
  {
    // Würfel komplett umgedreht (same_sense .F. + alle Ränder .F.) — topologisch und je Fläche
    // stimmig, nur innen-außen vertauscht → shell-volume
    const s = exportCase(groupsOfTris(box([0, 0, 0], [10, 10, 10])), true).step
      .replace(/(=ADVANCED_FACE\('',\([^)]*\),#\d+,)\.T\.\);/g, '$1.F.);')
      .replace(/(=FACE(?:_OUTER)?_BOUND\('',#\d+,)\.T\.\);/g, '$1.F.);');
    const k = kindsOf(s);
    check(`umgedrehter Würfel → shell-volume (gefunden: ${[...k].join(',') || '–'})`, k.has('shell-volume') && k.size === 1);
  }
  {
    // zwei Körper teilen sich wieder den Eckpunkt → shared-topology
    const s0 = exportCase(groupsOfTris([...box([0, 0, 0], [10, 10, 10]), ...box([10, 10, 10], [20, 20, 20])]), true).step;
    const vp = [...s0.matchAll(/#(\d+)=CARTESIAN_POINT\('',\(10\.,10\.,10\.\)\);\n#(\d+)=VERTEX_POINT/g)].map((m) => +m[2]);
    const s = vp.length === 2 ? s0.replace(new RegExp(`#${vp[1]}([,)])`, 'g'), `#${vp[0]}$1`).replace(new RegExp(`^#${vp[0]}=VERTEX_POINT`, 'm'), `#${vp[0]}=VERTEX_POINT`) : s0;
    const k = kindsOf(s);
    check(`Eckpunkt in zwei Körpern → shared-topology (gefunden: ${[...k].join(',') || '–'})`, vp.length === 2 && k.has('shared-topology'));
  }
  {
    // dichte Hülle als OPEN_SHELL → open-shell
    const s = exportCase(groupsOfTris(box([0, 0, 0], [10, 10, 10])), true).step.replace('=CLOSED_SHELL(', '=OPEN_SHELL(');
    const k = kindsOf(s);
    check(`dichte OPEN_SHELL → open-shell (gefunden: ${[...k].join(',') || '–'})`, k.has('open-shell'));
  }
  {
    // Bohrungs-Kreis größer als die Platte → loop-overlap
    const s0 = exportCase(groupsOfTris(plateWithBore()), true).step;
    const s = s0.replace(/=CIRCLE\('',#(\d+),[0-9.]+\);/g, "=CIRCLE('',#$1,18.);");
    const k = kindsOf(s);
    check(`Loch-Kreis über den Außenrand → loop-overlap (gefunden: ${[...k].join(',') || '–'})`, s !== s0 && k.has('loop-overlap'));
  }

  origLog(`\n${failures === 0 ? '✅ alle Schalen-/Freigang-Regressionen grün' : `❌ ${failures} Assertion(en) fehlgeschlagen`}`);
  process.exit(failures === 0 ? 0 : 1);
}

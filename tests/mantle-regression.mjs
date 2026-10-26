// ─────────────────────────────────────────────────────────────────────────────
// Mantel-Regressionstest: konvexe Außen-Zylindermäntel (Welle, Scheibe, Rohr-Außenwand) als
// CYLINDRICAL_SURFACE + die Bohrungs-Funde aus dem Review (gemischte Mündungen, D-Loch, geneigte
// Deckfläche, Fallback bei offenen Netzen). Körper im Speicher erzeugt (tests/fixtures-v2/gen.mjs,
// keine neuen Samples → Golden-Satz unberührt) plus samples/cylinder.stl und washer_thin.stl.
//
// Läuft die ECHTE Pipeline wie der Worker (parseStl → buildNormalGroups → unifyCoplanarGroups →
// recognizePrimitives → detectTubes → buildVolumeStepBrepV2, Toggle AN und AUS) und prüft je Fall:
//   - Umwandlung ja/nein (report.mantlesConverted / boresConverted, Anzahl CYLINDRICAL/CONICAL)
//   - wasserdicht
//   - tests/step-strict.mjs OHNE Heilung (Ränder geschlossen, Orientierung, Rand auf Fläche) —
//     occt/Fusion reparieren still, strikte Importer (CST/ACIS) nicht
//   - occt-Volumen gegen das analytische Soll (umgewandelt) bzw. gegen das Netz (facettiert)
//
// Ausführen:  npm run test:mantel     (Exit 0 = grün)
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createRequire } from 'module';
import { parseStl, simplifyMesh } from '../analysis-core.js';
import { buildNormalGroups } from '../region-growing.js';
import { unifyCoplanarGroups } from '../face-unification.js';
import { recognizePrimitives } from '../primitive-recognition.js';
import { detectTubes } from '../tube-sweep.js';
import { buildVolumeStepBrepV2 } from '../exporters.js';
import * as G from './fixtures-v2/gen.mjs';
import { checkStepStrict } from './step-strict.mjs';

const require = createRequire(import.meta.url);
const { getOcct } = require('./occt-check.cjs');
const __dirname = dirname(fileURLToPath(import.meta.url));
const PI = Math.PI;
const origLog = console.log;
const quiet = (fn) => { console.log = () => {}; try { return fn(); } finally { console.log = origLog; } };

// ---- Pipeline wie im Worker
const groupsOfMesh = (mesh) => {
  if (mesh.faces.length > 50000) mesh = simplifyMesh(mesh, 50000, () => {});
  const groups = unifyCoplanarGroups(buildNormalGroups(mesh)).unified.sort((a, b) => b.vertices.length - a.vertices.length);
  quiet(() => recognizePrimitives(groups));
  quiet(() => detectTubes(groups));
  return groups;
};
const meshOfTris = (tris) => {
  const buf = G.toBinaryStl(tris, 'mantel');
  return parseStl(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), () => {});
};
const meshOfSample = (file) => {
  const buf = readFileSync(join(__dirname, '..', 'samples', file));
  return parseStl(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), () => {});
};
// ein Dreieck der größten Gruppe aus dem Netz entfernen → von Haus aus offenes Netz
const punctured = (mesh) => {
  const big = groupsOfMesh(mesh)[0];
  const key = (v) => v.map((x) => x.toFixed(5)).join(',');
  const tri = (vs) => vs.map(key).sort().join('|');
  const own = new Set();
  for (let t = 0; t + 2 < big.vertices.length; t += 3) own.add(tri([big.vertices[t], big.vertices[t + 1], big.vertices[t + 2]]));
  let ri = -1;
  for (let i = mesh.faces.length - 1; i >= 0 && ri < 0; i--) if (own.has(tri(mesh.faces[i].vertices))) ri = i;
  return { ...mesh, faces: mesh.faces.filter((_, i) => i !== ri) };
};

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
const check = (label, cond) => {
  console.log(`    ${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failures++;
};

// Einen Fall exportieren und prüfen. want: { mantles, bores, cyl, cone, faces, wt, vol, volTol, fallbackStage, stage1Tried }
// (nicht gesetzte Felder werden nicht geprüft; wt default true, strict default: muss sauber sein)
function runCase(name, groups, defeature, want) {
  const res = quiet(() => buildVolumeStepBrepV2({ normalGroups: groups, defeature }));
  console.log(`  ${name} [${defeature ? 'AN' : 'AUS'}]`);
  if (!res) { check('Export liefert ein Ergebnis', false); return; }
  const r = res.report;
  const cyl = count(res.step, /CYLINDRICAL_SURFACE\(/g), cone = count(res.step, /CONICAL_SURFACE\(/g);
  const st = checkStepStrict(res.step);
  const v = occtVolume(res.step);
  console.log(`      faces=${r.faceCount} wt=${r.watertight} mantles=${r.mantlesConverted} bores=${r.boresConverted} cyl=${cyl} cone=${cone} V(occt)=${v.toFixed(3)} strict=${st.violations.length} fallback=${r.fallbackStage}/${r.stage1Tried}`);
  if ('mantles' in want) check(`Mäntel umgewandelt = ${want.mantles}`, r.mantlesConverted === want.mantles);
  if ('bores' in want) check(`Bohrungen umgewandelt = ${want.bores}`, r.boresConverted === want.bores);
  if ('cyl' in want) check(`CYLINDRICAL_SURFACE × ${want.cyl}`, cyl === want.cyl);
  if ('cone' in want) check(`CONICAL_SURFACE × ${want.cone}`, cone === want.cone);
  if ('faces' in want) check(`Flächen = ${want.faces}`, r.faceCount === want.faces);
  check(`wasserdicht = ${want.wt ?? true}`, r.watertight === (want.wt ?? true));
  if (want.strict !== false) {
    const kinds = [...new Set(st.violations.map((x) => x.kind))].join(',');
    check(`step-strict sauber${kinds ? ` (Verstöße: ${kinds})` : ''}`, st.violations.length === 0);
  }
  if ('vol' in want) {
    const rel = Math.abs(v - want.vol) / want.vol, tol = want.volTol ?? 1e-4;
    check(`occt-Volumen ${v.toFixed(3)} ≈ ${want.vol.toFixed(3)} (rel. ${rel.toExponential(1)} ≤ ${tol})`, rel <= tol);
  }
  if ('fallbackStage' in want) check(`Fallback-Stufe = ${want.fallbackStage}`, r.fallbackStage === want.fallbackStage);
  if ('stage1Tried' in want) check(`Stufe 1 versucht = ${want.stage1Tried}`, r.stage1Tried === want.stage1Tried);
}
const both = (name, groups, want, wantAus = want) => { runCase(name, groups, true, want); runCase(name, groups, false, wantAus); };

// ---- Körper
const sharp = { kind: 'sharp' };
const { circleProfile, rectProfile } = G;
const polyA = (p) => Math.abs(G.polyArea(p));
const col = (profile, z0, z1, extra = {}) => ({ profile, z0, z1, bottom: sharp, top: sharp, ...extra });
const tris = (body) => G.buildMesh(body);
// D-Profil (CCW für Welle, CW für Loch): Kreis R, n Segmente, `flat` Segmente durch EINE Sehne ersetzt
const dProfile = (cx, cy, R, n, flat, hole = false) => {
  const pts = [];
  for (let i = 0; i < n; i++) { if (i > 0 && i < flat) continue; const a = 2 * PI * i / n; pts.push([cx + R * Math.cos(a), cy + R * Math.sin(a)]); }
  return hole ? pts.reverse() : pts;
};
// Kreis mit abwechselnd langen und kurzen Randkanten (wie block_with_hole)
const altCircle = (R, n) => { const pts = []; for (let i = 0; i < n; i++) for (const f of [0, 0.15]) { const a = 2 * PI * (i + f) / n; pts.push([R * Math.cos(a), R * Math.sin(a)]); } return pts; };
// Zylinder/Bohrung mit eigenem Verlauf der Deckebenen (geneigte Deckfläche)
function wedgeBody({ n = 32, R = 4, beta = 5, hole = false }) {
  const b = Math.tan(beta * PI / 180), ztop = (x) => 8 + b * (x - 20);
  const out = [];
  const ring = (zf) => { const r = []; for (let i = 0; i < n; i++) { const a = 2 * PI * i / n; const x = 20 + R * Math.cos(a), y = 15 + R * Math.sin(a); r.push([x, y, zf(x)]); } return r; };
  const cap = (outer, holes, up) => {
    const map = new Map([outer, ...holes].flat().map((p) => [`${p[0]},${p[1]}`, p]));
    for (const t of G.triangulateWithHoles(outer.map((p) => [p[0], p[1]]), holes.map((h) => h.map((p) => [p[0], p[1]])))) {
      const T = t.map((q) => map.get(`${q[0]},${q[1]}`)); out.push(up ? T : [T[0], T[2], T[1]]);
    }
  };
  const wall = (lo, hi) => { for (let i = 0; i < lo.length; i++) { const j = (i + 1) % lo.length; out.push([lo[i], lo[j], hi[j]], [lo[i], hi[j], hi[i]]); } };
  if (!hole) { // Welle mit schräg geschnittenem Deckel
    const lo = ring(() => 0), hi = ring(ztop);
    wall(lo, hi); cap(hi, [], true); cap(lo, [], false);
  } else {     // Keil (Platte mit schräger Oberseite) + senkrechte Bohrung
    const lo = ring(() => 0).reverse(), hi = ring(ztop).reverse();
    wall(lo, hi);
    const box = [[0, 0], [40, 0], [40, 30], [0, 30]];
    const b0 = box.map(([x, y]) => [x, y, 0]), b1 = box.map(([x, y]) => [x, y, ztop(x)]);
    wall(b0, b1); cap(b1, [hi], true); cap(b0, [lo], false);
  }
  return out;
}
// schräge Durchgangsbohrung (Achse um alpha gekippt) durch eine Platte 40×30×H, Mündungen = Ellipsen
function obliqueBore({ alpha = 8, n = 32, R = 4, H = 10 }) {
  const al = alpha * PI / 180, a = [Math.sin(al), 0, Math.cos(al)], u = [Math.cos(al), 0, -Math.sin(al)], c = [20, 15, 5];
  const ring = (z) => { const pts = []; for (let i = 0; i < n; i++) { const th = 2 * PI * i / n; const b = [c[0] + R * Math.cos(th) * u[0], c[1] + R * Math.sin(th), c[2] + R * Math.cos(th) * u[2]]; const t = (z - b[2]) / a[2]; pts.push([b[0] + t * a[0], b[1] + t * a[1], z]); } return pts.reverse(); };
  const lo = ring(0), hi = ring(H), out = [];
  for (let i = 0; i < n; i++) { const j = (i + 1) % n; out.push([lo[i], lo[j], hi[j]], [lo[i], hi[j], hi[i]]); }
  const box = [[0, 0], [40, 0], [40, 30], [0, 30]], b0 = box.map(([x, y]) => [x, y, 0]), b1 = box.map(([x, y]) => [x, y, H]);
  for (let i = 0; i < 4; i++) { const j = (i + 1) % 4; out.push([b0[i], b0[j], b1[j]], [b0[i], b1[j], b1[i]]); }
  const cap = (outer, hole, up) => { const map = new Map([...outer, ...hole].map((p) => [`${p[0]},${p[1]}`, p])); for (const t of G.triangulateWithHoles(outer.map((p) => [p[0], p[1]]), [hole.map((p) => [p[0], p[1]])])) { const T = t.map((q) => map.get(`${q[0]},${q[1]}`)); out.push(up ? T : [T[0], T[2], T[1]]); } };
  cap(b1, hi, true); cap(b0, lo, false);
  return out;
}
// Stufe-1-Rettung: Scheibe mit beidseitig gefaster Bohrung, Außenwand als Zickzack-64-Eck (R 5.10/5.06,
// kein Zylinder) komplett in den Fasen-Zonen → filterChamferZones schluckt sie → nur Stufe 1 ist dicht
function rescueBody() {
  const N = 64, Rr = 4, R2 = 5, H = 6, out = [];
  const pt = (r, i, z) => [r * Math.cos(2 * PI * (i % N) / N), r * Math.sin(2 * PI * (i % N) / N), z];
  const ro = (i) => ((i % N) % 2 ? 5.06 : 5.10);
  const quad = (a, b, c, d) => out.push([a, b, c], [a, c, d]);
  for (let i = 0; i < N; i++) {
    quad(pt(R2, i, 0), pt(R2, i + 1, 0), pt(ro(i + 1), i + 1, 0), pt(ro(i), i, 0));
    quad(pt(R2, i, 0), pt(Rr, i, 1), pt(Rr, i + 1, 1), pt(R2, i + 1, 0));
    quad(pt(Rr, i, 1), pt(Rr, i, 3), pt(Rr, i + 1, 3), pt(Rr, i + 1, 1));
    quad(pt(Rr, i, 3), pt(Rr, i, 5), pt(Rr, i + 1, 5), pt(Rr, i + 1, 3));
    quad(pt(Rr, i, 5), pt(R2, i, H), pt(R2, i + 1, H), pt(Rr, i + 1, 5));
    quad(pt(R2, i, H), pt(ro(i), i, H), pt(ro(i + 1), i + 1, H), pt(R2, i + 1, H));
    quad(pt(ro(i), i, 0), pt(ro(i + 1), i + 1, 0), pt(ro(i + 1), i + 1, H), pt(ro(i), i, H));
  }
  return out;
}
const meshVol = (t) => G.meshVolume(t);

// ════ 1. Samples ════
console.log('\n── Samples');
both('cylinder.stl', groupsOfMesh(meshOfSample('cylinder.stl')), { mantles: 1, bores: 0, cyl: 1, cone: 0, faces: 3, vol: PI * 2 * 2 * 15 });
both('washer_thin.stl', groupsOfMesh(meshOfSample('washer_thin.stl')), { mantles: 1, bores: 1, cyl: 2, cone: 0, faces: 4, vol: PI * (15 * 15 - 8 * 8) * 4 });

// ════ 2. Konvexe Mäntel, die umgewandelt werden MÜSSEN ════
console.log('\n── Mäntel: umwandeln');
const MANTLE_OK = [
  ['Welle R5 H20 (64 Seg.)', { columns: [col(circleProfile(0, 0, 5, 64), 0, 20)] }, PI * 25 * 20, 1],
  ['Welle gedreht + weit vom Ursprung', { columns: [col(circleProfile(0, 0, 5, 64), 0, 20)], transform: { rot: [30, 20, 10], t: [500, 300, -200] } }, PI * 25 * 20, 1],
  ['Scheibe R20 H0.5', { columns: [col(circleProfile(0, 0, 20, 96), 0, 0.5)] }, PI * 400 * 0.5, 1],
  ['Rohr Ra40/Ri38 H60', { columns: [col(circleProfile(0, 0, 40, 128), 0, 60), col(circleProfile(0, 0, 38, 128, true), 0, 60)] }, PI * (1600 - 1444) * 60, 2],
  ['Welle grob (16 Seg.)', { columns: [col(circleProfile(0, 0, 5, 16), 0, 20)] }, PI * 25 * 20, 1],
  ['Welle, Randkanten lang/kurz', { columns: [col(altCircle(5, 90), 0, 20)] }, PI * 25 * 20, 1],
  ['Welle, Wand in 4 Streifen', { columns: [col(circleProfile(0, 0, 5, 48), 0, 20, { wallSteps: 4 })] }, PI * 25 * 20, 1],
];
for (const [name, body, vol, nCyl] of MANTLE_OK) {
  both(name, groupsOfMesh(meshOfTris(tris(body))), { mantles: 1, bores: nCyl - 1, cyl: nCyl, cone: 0, faces: nCyl + 2, vol });
}
// verrundete Außenkanten: mit Toggle schärft v2 die Bänder → Mantel; ohne Toggle facettiert
{
  const body = { columns: [col(circleProfile(0, 0, 5, 64), 0, 20, { bottom: { kind: 'round', r: 1, N: 8 }, top: { kind: 'round', r: 1, N: 8 } })] };
  const t = tris(body), groups = groupsOfMesh(meshOfTris(t));
  runCase('Welle, Außenkanten r=1 verrundet', groups, true, { mantles: 1, cyl: 1, faces: 3, vol: PI * 25 * 20 });
  runCase('Welle, Außenkanten r=1 verrundet', groups, false, { mantles: 0, cyl: 0, vol: meshVol(t), volTol: 1e-5, strict: false });
}

// ════ 3. Konvexe Körper, die facettiert bleiben MÜSSEN ════
console.log('\n── Mäntel: facettiert lassen');
const MANTLE_NO = [
  ['D-Welle (64 Seg., Abflachung 7 Seg.)', { columns: [col(dProfile(0, 0, 5, 64, 7), 0, 20)] }],
  ['D-Welle (32 Seg., Abflachung 4 Seg.)', { columns: [col(dProfile(0, 0, 5, 32, 4), 0, 20)] }],
  ['Achtkant (reguläres 8-Eck)', { columns: [col(circleProfile(0, 0, 5, 8), 0, 20)] }],
  ['Welle, Außenkanten gefast (Rand nicht auf der Deckfläche)', { columns: [col(circleProfile(0, 0, 5, 64), 0, 20, { bottom: { kind: 'chamfer', r: 1 }, top: { kind: 'chamfer', r: 1 } })] }],
  ['Zapfen auf Platte (Rand = Innen-Loop)', { columns: [col(rectProfile(-20, -15, 40, 30), 0, 10), col(circleProfile(0, 0, 5, 64), 10, 25)],
    caps: [{ up: false, outer: { c: 0, end: 'bottom' }, holes: [] }, { up: true, outer: { c: 0, end: 'top' }, holes: [{ c: 1, end: 'bottom', rev: true }] }, { up: true, outer: { c: 1, end: 'top' }, holes: [] }] }],
];
for (const [name, body] of MANTLE_NO) {
  const t = tris(body);
  both(name, groupsOfMesh(meshOfTris(t)), { mantles: 0, cyl: 0, vol: meshVol(t), volTol: 1e-5 });
}
{
  const t = wedgeBody({ n: 64, R: 5, beta: 3 });
  both('Welle, Deckel 3° schräg (Rand = Ellipse)', groupsOfMesh(meshOfTris(t)), { mantles: 0, cyl: 0, vol: meshVol(t), volTol: 1e-5 });
}

// ════ 4. Review-Funde Bohrungen ════
const R_ = (r, N = 8) => ({ kind: 'round', r, N });
const plate = (cap = sharp) => ({ profile: rectProfile(0, 0, 40, 30), z0: 0, z1: 10, bottom: cap, top: cap });
const hole = (profile, bottom, top) => ({ profile, z0: 0, z1: 10, bottom, top });
const circ32 = circleProfile(20, 15, 4, 32, true);

console.log('\n── (a) gemischte Mündungen: oben verrundet (v2 schärft), unten echte Fase');
{
  const t = tris({ columns: [plate(), hole(circ32, { kind: 'chamfer', r: 1 }, R_(1))] });
  // Soll: Platte − Zylinder R4 (z 1..10) − Kegelstumpf R4→R2 (z 0..1); R2 = Fasen-Außenkreis des Generators
  const R2 = 4 + 1 / Math.cos(PI / 32);
  const vol = 40 * 30 * 10 - PI * 16 * 9 - PI / 3 * (16 + 4 * R2 + R2 * R2);
  runCase('Platte, Loch oben r=1 / unten Fase 1', groupsOfMesh(meshOfTris(t)), true, { bores: 1, cyl: 1, cone: 1, faces: 8, vol, volTol: 1e-5 });
}

console.log('\n── (b) D-Löcher werden KEINE vollen Zylinder');
for (const [name, n, flat] of [['D-Loch 32 Seg., Sehne über 45°', 32, 4], ['D-Loch 64 Seg., Sehne über 39°', 64, 7]]) {
  const prof = dProfile(20, 15, 4, n, flat, true);
  const tSharp = tris({ columns: [plate(), hole(prof, sharp, sharp)] });
  both(`${name}, scharf`, groupsOfMesh(meshOfTris(tSharp)), { bores: 0, cyl: 0, vol: meshVol(tSharp), volTol: 1e-5 });
  const tRound = tris({ columns: [plate(R_(1)), hole(prof, R_(0.5), R_(0.5))] });
  // mit Toggle schärft v2 alle Mündungen → Soll = scharfes D-Loch, nicht der Vollzylinder
  runCase(`${name}, Mündungen r=0.5`, groupsOfMesh(meshOfTris(tRound)), true, { bores: 0, cyl: 0, vol: meshVol(tSharp), volTol: 1e-5 });
}

console.log('\n── (c) geneigte Deckfläche / schräge Bohrung: Kreis läge nicht in der Deckebene');
{
  const t = wedgeBody({ n: 32, R: 4, beta: 5, hole: true });
  both('Keil 5°, senkrechte Bohrung', groupsOfMesh(meshOfTris(t)), { bores: 0, cyl: 0, vol: meshVol(t), volTol: 1e-5 });
  const t2 = obliqueBore({ alpha: 8 });
  both('Platte, Bohrung 8° schräg', groupsOfMesh(meshOfTris(t2)), { bores: 0, cyl: 0, vol: meshVol(t2), volTol: 1e-5 });
}

console.log('\n── (d) Fallback: Stufe 1 nur, wenn die facettierte Basislinie dicht ist');
{
  const S2 = { columns: [plate(), hole(circ32, sharp, R_(1))] };
  const mesh = meshOfTris(tris(S2));
  runCase('S2 (Loch oben verrundet), geschlossen', groupsOfMesh(mesh), true, { bores: 1, cyl: 1, fallbackStage: 0, stage1Tried: false });
  // gelocht: die Umwandlung öffnet nichts — das Netz ist offen; Basislinie direkt, Stufe 1 entfällt
  runCase('S2 gelocht (offenes Netz)', groupsOfMesh(punctured(mesh)), true, { bores: 0, wt: false, strict: false, fallbackStage: 2, stage1Tried: false });
  // geschlossen, aber die Bohrungs-Umwandlung öffnet die Hülle → Stufe 1 rettet
  runCase('Stufe-1-Rettung (Fasen-Zonen schlucken die Außenwand)', groupsOfMesh(meshOfTris(rescueBody())), true, { bores: 0, fallbackStage: 1, stage1Tried: true });
}

console.log(`\n${failures === 0 ? '✅ alle Mantel-/Bohrungs-Regressionen grün' : `❌ ${failures} Assertion(en) fehlgeschlagen`}`);
process.exit(failures === 0 ? 0 : 1);

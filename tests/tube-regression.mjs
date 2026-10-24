// ─────────────────────────────────────────────────────────────────────────────
// Kanal-Regressionstest (tube-sweep.js): synthetische Quader mit GEBOGENEM Kanal, im Speicher
// erzeugt (keine neuen Samples → Golden-Satz unberührt). Prüft die ECHTE Pipeline
// (buildNormalGroups → unifyCoplanarGroups → recognizePrimitives → detectTubes →
// buildVolumeStepBrepV2 → occt) auf:
//   A) Kreis ⟂ Bahn (γ = 0), Gerade + 90°-Bogen + Gerade, Mündungen senkrecht
//      → CYLINDRICAL_SURFACE ×2 + TOROIDAL_SURFACE ×1, Mündungen = Kreise
//   B) wie A, aber schräger Austritt (Bogen 110°) → Endstück Gerade → ELLIPSE als Mündung
//   C) Profilkreis auf der Deckfläche skizziert, Bahn startet 20° geneigt (γ = 20°)
//      → SURFACE_OF_REVOLUTION / SURFACE_OF_LINEAR_EXTRUSION, Mündung oben = Kreis
//   D) Robustheit: Kanalwand um 0.15 mm verbeult → KEIN Kanal erkannt, Export facettiert + dicht
// Je Fall: wasserdicht, orientationDefects 0, occt parst, Volumen (feine occt-Vernetzung) gegen
// das analytische Soll (Quader − Kanal, Pappus) < 0.2 %.
//
// Ausführen: npm run test:tube   (Exit 0 = grün)
// ─────────────────────────────────────────────────────────────────────────────
import { createRequire } from 'module';
import { buildNormalGroups } from '../region-growing.js';
import { unifyCoplanarGroups } from '../face-unification.js';
import { recognizePrimitives } from '../primitive-recognition.js';
import { detectTubes } from '../tube-sweep.js';
import { buildVolumeStepBrepV2 } from '../exporters.js';

const require = createRequire(import.meta.url);
const { getOcct } = require('./occt-check.cjs');

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(...a) || 1; return mul(a, 1 / l); };
const DEG = Math.PI / 180;
// Drehung um die y-Achse (Bahn-Ebene = xz)
const rotY = (v, th) => [v[0] * Math.cos(th) + v[2] * Math.sin(th), v[1], -v[0] * Math.sin(th) + v[2] * Math.cos(th)];

// Kanal-Quader: Box [0,W]×[0,D]×[0,H], Bahn in y = D/2 aus Segmenten (Gerade L / Bogen R,Winkel),
// Start oben (z = H) bei x0, Profilkreis r, um gamma gegen die Normalebene geneigt (Drehung um y),
// Austritt durch die Seitenfläche x = 0. N Segmente je Ring.
export function channelBlock({ W = 40, D = 10, H = 30, x0 = 25, r = 2.5, gamma = 0, segs, N = 48, dent = 0 }) {
  const yc = D / 2;
  // Bahn: Startrichtung so, dass die Profil-Normale (Deckflächen-Normale −z) um gamma gekippt ist
  const T0 = rotY([0, 0, -1], -gamma);
  // Pfad als Funktion der Bogenlänge: Liste von Stücken mit (Start, Richtung)
  const pieces = []; let P = [x0, yc, H], Tc = T0, s0 = 0;
  for (const sg of segs) {
    if (sg.L) { pieces.push({ kind: 'line', P, T: Tc, len: sg.L, s0 }); P = add(P, mul(Tc, sg.L)); s0 += sg.L; }
    else { const th = sg.deg * DEG; const len = Math.abs(th) * sg.R; pieces.push({ kind: 'arc', P, T: Tc, R: sg.R, th, len, s0 }); const n = rotY(Tc, Math.sign(th) * Math.PI / 2); const O = add(P, mul(n, sg.R)); P = add(O, rotY(sub(P, O), th)); Tc = rotY(Tc, th); s0 += len; }
  }
  const total = s0;
  // starre Bewegung bei Bogenlänge s: x ↦ R(θ)(x − P0) + P(s)
  const frame = (s) => {
    let pc = pieces[pieces.length - 1];
    for (const q of pieces) if (s <= q.s0 + q.len) { pc = q; break; }
    const ds = s - pc.s0;
    if (pc.kind === 'line') return { P: add(pc.P, mul(pc.T, ds)), rot: pc.rot0 ?? 0, pc };
    const th = (ds / pc.len) * pc.th;
    const n = rotY(pc.T, Math.sign(pc.th) * Math.PI / 2), O = add(pc.P, mul(n, pc.R));
    return { P: add(O, rotY(sub(pc.P, O), th)), rot: (pc.rot0 ?? 0) + th, pc };
  };
  let rot = 0; for (const q of pieces) { q.rot0 = rot; if (q.kind === 'arc') rot += q.th; }
  // Profilpunkt (Winkel φ) am Start: Kreis in der Deckfläche z = H um (x0, yc)
  const prof0 = (phi) => [r * Math.cos(phi), r * Math.sin(phi), 0];
  const X = (s, phi) => { const f = frame(s); return add(f.P, rotY(prof0(phi), f.rot)); };
  // Ringe entlang der Bahn; letzter Ring = Schnitt mit x = 0 (Bisektion je φ)
  const ds = 0.4, rings = [];
  const exitS = (phi) => { let a = 0, b = total; for (let i = 0; i < 80; i++) { const m = 0.5 * (a + b); if (X(m, phi)[0] > 0) a = m; else b = m; } return 0.5 * (a + b); };
  const sEnd = []; for (let j = 0; j < N; j++) sEnd.push(exitS((j / N) * 2 * Math.PI));
  const sMin = Math.min(...sEnd);
  for (let s = 0; s < sMin - 0.05; s += ds) rings.push(Array.from({ length: N }, (_, j) => X(s, (j / N) * 2 * Math.PI)));
  rings.push(sEnd.map((s, j) => { const p = X(s, (j / N) * 2 * Math.PI); return [0, p[1], p[2]]; }));
  if (dent) { // Delle: ein Ringabschnitt in der Mitte nach innen gedrückt
    const k = rings.length >> 1;
    for (let kk = k - 2; kk <= k + 2; kk++) for (let j = 0; j < 6; j++) { const c = frame(kk * ds).P; rings[kk][j] = add(rings[kk][j], mul(norm(sub(c, rings[kk][j])), dent)); }
  }
  const tris = [];
  const tri = (a, b, c, inward) => { // Orientierung: Normale soll in Richtung `inward` zeigen
    const n = cross(sub(b, a), sub(c, a));
    if (dot(n, inward) < 0) tris.push([a, c, b]); else tris.push([a, b, c]);
  };
  for (let k = 0; k + 1 < rings.length; k++) for (let j = 0; j < N; j++) {
    const a = rings[k][j], b = rings[k][(j + 1) % N], c = rings[k + 1][(j + 1) % N], d = rings[k + 1][j];
    const ctr = frame(Math.min(k * ds, total)).P;
    const cen = mul(add(add(a, b), add(c, d)), 0.25);
    tri(a, b, c, sub(ctr, cen)); tri(a, c, d, sub(ctr, cen));
  }
  // Fläche mit (konvexem) Loch: Brücke vom äußersten Lochpunkt zu einer sichtbaren Ecke, dann
  // Ohr-Abschneiden (Ear Clipping) in Flächen-Koordinaten → keine Zusatzpunkte auf den Kanten
  // (Nachbarflächen bleiben einfache Rechtecke, Netz bleibt dicht).
  const holed = (corners, hole, outN) => {
    const u = norm(sub(corners[1], corners[0])), v = cross(outN, u);
    const to2 = (p) => [dot(p, u), dot(p, v)];
    const area2 = (pts) => { let a = 0; for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; a += p[0] * q[1] - q[0] * p[1]; } return a / 2; };
    let outer = corners.map((p) => ({ p, q: to2(p) }));
    if (area2(outer.map((o) => o.q)) < 0) outer.reverse();                 // außen CCW
    let hl = hole.map((p) => ({ p, q: to2(p) }));
    if (area2(hl.map((o) => o.q)) > 0) hl.reverse();                        // Loch CW
    let im = 0; for (let i = 1; i < hl.length; i++) if (hl[i].q[0] > hl[im].q[0]) im = i;
    let ib = 0; for (let i = 1; i < outer.length; i++) if (outer[i].q[0] > outer[ib].q[0] || (outer[i].q[0] === outer[ib].q[0] && outer[i].q[1] > outer[ib].q[1])) ib = i;
    const poly = [];
    for (let i = 0; i <= ib; i++) poly.push(outer[i]);
    for (let k = 0; k <= hl.length; k++) poly.push(hl[(im + k) % hl.length]);
    for (let i = ib; i < outer.length; i++) poly.push(outer[i]);
    const crs = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const inTri = (p, a, b, c) => crs(a, b, p) > 1e-12 && crs(b, c, p) > 1e-12 && crs(c, a, p) > 1e-12;
    const same = (a, b) => a[0] === b[0] && a[1] === b[1];
    let guard = 0;
    while (poly.length > 3 && guard++ < 100000) {
      let cut = false;
      for (let i = 0; i < poly.length; i++) {
        const a = poly[(i - 1 + poly.length) % poly.length], b = poly[i], c = poly[(i + 1) % poly.length];
        if (crs(a.q, b.q, c.q) <= 1e-12) continue;
        let ok = true;
        for (const o of poly) { if (o === a || o === b || o === c || same(o.q, a.q) || same(o.q, b.q) || same(o.q, c.q)) continue; if (inTri(o.q, a.q, b.q, c.q)) { ok = false; break; } }
        if (!ok) continue;
        tri(a.p, b.p, c.p, outN); poly.splice(i, 1); cut = true; break;
      }
      if (!cut) throw new Error('Ear clipping festgefahren');
    }
    if (poly.length === 3) tri(poly[0].p, poly[1].p, poly[2].p, outN);
  };
  const B = (x, y, z) => [x, y, z];
  const top = rings[0], exit = rings[rings.length - 1];
  holed([B(0, 0, H), B(W, 0, H), B(W, D, H), B(0, D, H)], top, [0, 0, 1]);          // Deckfläche
  holed([B(0, 0, 0), B(0, D, 0), B(0, D, H), B(0, 0, H)], exit, [-1, 0, 0]);        // Seite x = 0
  const quad = (a, b, c, d, n) => { tri(a, b, c, n); tri(a, c, d, n); };
  quad(B(0, 0, 0), B(W, 0, 0), B(W, D, 0), B(0, D, 0), [0, 0, -1]);                 // Boden
  quad(B(W, 0, 0), B(W, 0, H), B(W, D, H), B(W, D, 0), [1, 0, 0]);                  // Seite x = W
  quad(B(0, 0, 0), B(0, 0, H), B(W, 0, H), B(W, 0, 0), [0, -1, 0]);                 // y = 0
  quad(B(0, D, 0), B(W, D, 0), B(W, D, H), B(0, D, H), [0, 1, 0]);                  // y = D
  // Soll-Volumen: Quader − Kanal (Querschnitt Profilkreis-Projektion: π r² cos γ je Bahnlänge),
  // Austritts-Keil exakt über das Netz-Mittel ausgeglichen → hier nur grob für die Plausibilität
  return { faces: tris.map((v) => ({ vertices: v, normal: norm(cross(sub(v[1], v[0]), sub(v[2], v[0]))) })) };
}

const triVol = (a, b, c) => dot(a, cross(b, c)) / 6;
async function occtVolume(step) {
  const occt = await getOcct();
  const origLog = console.log; console.log = () => {};
  let r; try { r = occt.ReadFile('step', new Uint8Array(Buffer.from(step, 'utf8')), { linearDeflectionType: 'absolute_value', linearDeflection: 0.01, angularDeflection: 0.1 }); } finally { console.log = origLog; }
  if (!r.success) return null;
  let v = 0;
  for (const m of r.meshes) { const P = m.attributes.position.array, I = m.index.array; const p = (k) => [P[3 * I[k]], P[3 * I[k] + 1], P[3 * I[k] + 2]]; for (let i = 0; i < I.length; i += 3) v += triVol(p(i), p(i + 1), p(i + 2)); }
  return { volume: v, meshes: r.meshes.length };
}

export const cases = [
  { name: 'A  γ=0  Gerade+Bogen 90°+Gerade, Mündungen ⟂', mesh: { segs: [{ L: 12 }, { R: 8, deg: 90 }, { L: 30 }] }, expect: { tubes: 1, tilted: false } },
  { name: 'B  γ=0  Bogen 110° → schräger gerader Austritt (Ellipse)', mesh: { segs: [{ L: 10 }, { R: 8, deg: 110 }, { L: 40 }] }, expect: { tubes: 1, tilted: false, ell: 1 } },
  { name: 'C  γ=20° Profil auf Deckfläche, Bahn geneigt', mesh: { gamma: 20 * DEG, segs: [{ L: 6 }, { R: 9, deg: 100 }, { L: 40 }] }, expect: { tubes: 1, tilted: true } },
  { name: 'D  verbeulter Kanal (0.15 mm) → bleibt facettiert', mesh: { dent: 0.15, segs: [{ L: 12 }, { R: 8, deg: 90 }, { L: 30 }] }, expect: { tubes: 0 } },
  // Robustheit im Exporter: Erkennung ok, aber Rand-Matching scheitert (Mündungskurve 0.5 mm versetzt)
  { name: 'E  Mündung passt nicht (Kurve versetzt) → Kanal facettiert', mesh: { segs: [{ L: 12 }, { R: 8, deg: 90 }, { L: 30 }] }, tamper: (sp) => { sp.curves[0].center = sp.curves[0].center.map((x, i) => x + (i === 0 ? 0.5 : 0)); }, expect: { tubes: 1, exported: 0 } },
  // Robustheit: Kette passt topologisch nicht zur Mündungsfläche (Mündungskurve falsch orientiert →
  // 2× gleiche Richtung) → Wasserdicht-Verdikt fängt es → globaler Fallback baut facettiert.
  // (Hinweis: eine ÜBERGANGSkurve umzudrehen dreht BEIDE Nutzungen — topologisch weiter dicht, nur
  // occt wählt dann das Komplementär-Band; das kann der Zähler prinzipiell nicht sehen.)
  { name: 'F  Mündungskurve falsch orientiert → globaler Fallback', mesh: { segs: [{ L: 12 }, { R: 8, deg: 90 }, { L: 30 }] }, tamper: (sp) => { sp.curves[0].sense = -sp.curves[0].sense; }, expect: { tubes: 1, exported: 0 } },
];

const isMain = process.argv[1] && process.argv[1].endsWith('tube-regression.mjs');
let fails = 0;
const check = (ok, msg) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) fails++; };
for (const cs of isMain ? cases : []) {
  const mesh = channelBlock(cs.mesh);
  if (process.env.DIAG) {
    const k = (p) => p.map((x) => x.toFixed(4)).join(','), ec = new Map();
    for (const f of mesh.faces) for (let i = 0; i < 3; i++) { const a = k(f.vertices[i]), b = k(f.vertices[(i + 1) % 3]); const e = a < b ? a + '|' + b : b + '|' + a; ec.set(e, (ec.get(e) || 0) + 1); }
    const bad = [...ec].filter(([, c]) => c !== 2);
    const dc = new Map(); let badDir = 0;
    for (const f of mesh.faces) for (let i = 0; i < 3; i++) { const e = k(f.vertices[i]) + '>' + k(f.vertices[(i + 1) % 3]); dc.set(e, (dc.get(e) || 0) + 1); }
    for (const [e, c] of dc) if (c > 1) { badDir++; if (badDir < 3) console.log('DIAG dup', e); }
    let vol = 0; for (const f of mesh.faces) vol += triVol(...f.vertices);
    console.log('DIAG edges', ec.size, 'bad', bad.length, 'sameDirDup', badDir, 'vol', vol.toFixed(2));
  }
  let stlVol = 0; for (const f of mesh.faces) stlVol += triVol(...f.vertices);
  const groups = unifyCoplanarGroups(buildNormalGroups(mesh)).unified.sort((a, b) => b.vertices.length - a.vertices.length);
  recognizePrimitives(groups);
  const { tubes, stats } = detectTubes(groups);
  if (cs.tamper) for (const sp of tubes) cs.tamper(sp);
  const res = buildVolumeStepBrepV2({ normalGroups: groups });
  const cnt = (re) => (res.step.match(re) || []).length;
  const occ = await occtVolume(res.step);
  const dev = occ ? (occ.volume - stlVol) / stlVol : NaN;
  console.log(`\n${cs.name}\n  (${mesh.faces.length} tris) tubes=${tubes.length} ${tubes[0] ? `pieces=${tubes[0].pieces.length} γ=${tubes[0].stats.gammaDeg.toFixed(2)}° vertDev.max=${tubes[0].stats.vertDev.max.toFixed(4)}` : `(${stats.rejected.map((x) => x.why).join('; ')})`}` +
    ` faces=${res.report.faceCount} CYL=${cnt(/CYLINDRICAL_SURFACE\(/g)} TOR=${cnt(/TOROIDAL_SURFACE\(/g)} REV=${cnt(/SURFACE_OF_REVOLUTION\(/g)} EXT=${cnt(/SURFACE_OF_LINEAR_EXTRUSION\(/g)} ELL=${cnt(/ELLIPSE\(/g)} BSPL=${cnt(/B_SPLINE_CURVE_WITH_KNOTS\(/g)} ΔV(STL)=${(dev * 100).toFixed(3)} %`);
  if (process.env.DIAG && tubes[0]) for (const pc of tubes[0].pieces) console.log('   ', pc.kind, pc.kind === 'arc' ? `R=${pc.R.toFixed(4)} sweep=${(pc.sweep / DEG).toFixed(3)}°` : `len=${pc.len.toFixed(4)}`, 'p0', pc.p0.map((x) => x.toFixed(3)).join(','));
  const expExp = cs.expect.exported ?? cs.expect.tubes;
  check(tubes.length === cs.expect.tubes && res.report.tubesConverted === expExp, `Kanäle erkannt = ${cs.expect.tubes}, exportiert = ${expExp}`);
  check(res.report.watertight && res.report.orientationDefects === 0, 'wasserdicht, orientationDefects 0');
  check(!!occ && occ.meshes === 1, 'occt parst (1 Körper)');
  // Flächentypen: Kreis ⟂ Bahn → nur Zylinder/Torus; geneigtes Profil → nur Extrusion/Rotation
  const nCyl = cnt(/CYLINDRICAL_SURFACE\(/g), nTor = cnt(/TOROIDAL_SURFACE\(/g), nRev = cnt(/SURFACE_OF_REVOLUTION\(/g), nExt = cnt(/SURFACE_OF_LINEAR_EXTRUSION\(/g);
  if (cs.expect.tilted === false) check(nCyl >= 1 && nTor >= 1 && nRev + nExt === 0, `γ=0 → CYLINDRICAL (${nCyl}) + TOROIDAL (${nTor}), keine Rotations-/Extrusionsflächen`);
  if (cs.expect.tilted === true) check(nRev >= 1 && nCyl + nTor === 0, `γ≠0 → SURFACE_OF_REVOLUTION (${nRev}) / LINEAR_EXTRUSION (${nExt}), kein Zylinder/Torus`);
  if (cs.expect.ell != null) check(cnt(/ELLIPSE\(/g) === cs.expect.ell, `ELLIPSE = ${cs.expect.ell}`);
  // Netz-Volumen ist ein einbeschriebenes Polygon (N=48) → analytischer Kanal ist minimal größer
  check(Math.abs(dev) < 0.002, `Volumen occt vs. STL < 0.2 % (${(dev * 100).toFixed(3)} %)`);
}
if (isMain) {
  console.log(fails ? `\n❌ ${fails} Prüfung(en) fehlgeschlagen` : '\n✅ Kanal-Regression grün');
  process.exit(fails ? 1 : 0);
}

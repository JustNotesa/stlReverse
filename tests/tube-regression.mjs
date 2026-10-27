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
//   E/F) Robustheit im Exporter (Mündung passt nicht / falsch orientiert) → facettiert
//   U) U-Bogen (Gerade + 180°-Bogen + Gerade, γ = 0), R = 4.0 / 4.2 / 7 / 12: exakt 3 Stücke
//      (Anker-Kette), Zylinder/Torus — früher Biarc-Kette mit Knick bis 4.2° (Kreise bis 0.022 mm
//      neben ihren Flächen) bzw. bei R = 4.0 ein Fehlalarm von step-strict am 180°-Torusband
//   S) S-Kurve mit 1 mm Zwischengerade (Anker-Kette greift nicht): Biarc-Vereinfachung ohne Knick
//      über das Budget — Profil höchstens 0.1° gegen die Bahn geneigt
//   P) D-Profil (Kreis mit ebener Abflachung) → KEIN Kanal, Abflachung bleibt, ΔV = 0 zum Netz
// Je Fall: wasserdicht, orientationDefects 0, occt parst, step-strict ohne Verstoß, Volumen (feine
// occt-Vernetzung) gegen das Netz < 0.2 % (Polygon-Effekt des einbeschriebenen N-Ecks).
//
// Ausführen: npm run test:tube   (Exit 0 = grün)
// ─────────────────────────────────────────────────────────────────────────────
import { createRequire } from 'module';
import { buildNormalGroups } from '../region-growing.js';
import { cleanMesh } from '../mesh-clean.js';
import { unifyCoplanarGroups } from '../face-unification.js';
import { recognizePrimitives } from '../primitive-recognition.js';
import { detectTubes } from '../tube-sweep.js';
import { buildVolumeStepBrepV2 } from '../exporters.js';
import { checkStepStrict, parseStep } from './step-strict.mjs';

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
// Start oben (z = H) bei x0, Profilkreis r (N Segmente je Ring) oder freies Profil `profile`
// (Punkte [x, y] um den Startpunkt in der Deckfläche, z.B. D-Profil), um gamma gegen die
// Normalebene geneigt (Drehung um y). Austritt `exit`: Seitenfläche x = 0 ('x0'), Boden ('bot')
// oder wieder die Deckfläche ('top', U-Bogen — zwei Löcher in einer Fläche).
export function channelBlock({ W = 40, D = 10, H = 30, x0 = 25, r = 2.5, gamma = 0, segs, N = 48, dent = 0, exit = 'x0', profile = null }) {
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
  // Profilpunkte am Start (Deckfläche z = H, um (x0, yc)): Kreis mit N Punkten oder `profile`
  const prof = profile ? profile.map((q) => [q[0], q[1], 0]) : Array.from({ length: N }, (_, j) => { const phi = (j / N) * 2 * Math.PI; return [r * Math.cos(phi), r * Math.sin(phi), 0]; });
  const NP = prof.length;
  const X = (s, j) => { const f = frame(s); return add(f.P, rotY(prof[j], f.rot)); };
  // Ringe entlang der Bahn; letzter Ring = Schnitt mit der Austrittsfläche (Bisektion je Profilpunkt)
  const ds = 0.4, rings = [];
  const depth = { x0: (p) => p[0], bot: (p) => p[2], top: (p) => H - p[2] }[exit]; // > 0: vor der Austrittsfläche
  const snap = { x0: (p) => [0, p[1], p[2]], bot: (p) => [p[0], p[1], 0], top: (p) => [p[0], p[1], H] }[exit];
  const exitS = (j) => {
    if (exit === 'x0') { let a = 0, b = total; for (let i = 0; i < 80; i++) { const m = 0.5 * (a + b); if (X(m, j)[0] > 0) a = m; else b = m; } return 0.5 * (a + b); }
    // erst sicher ins Material (Deckfläche: Start liegt in ihr), dann bis zur Durchstoßung marschieren
    let prev = 0, armed = exit !== 'top';
    for (let s = 0.05; s <= total; s += 0.05) {
      const d = depth(X(s, j));
      if (!armed) { if (d > 0.2) armed = true; prev = s; continue; }
      if (d <= 0) { let a = prev, b = s; for (let i = 0; i < 80; i++) { const m = 0.5 * (a + b); if (depth(X(m, j)) > 0) a = m; else b = m; } return 0.5 * (a + b); }
      prev = s;
    }
    throw new Error('Kanal erreicht die Austrittsfläche nicht');
  };
  const sEnd = []; for (let j = 0; j < NP; j++) sEnd.push(exitS(j));
  const sMin = Math.min(...sEnd);
  for (let s = 0; s < sMin - 0.05; s += ds) rings.push(Array.from({ length: NP }, (_, j) => X(s, j)));
  rings.push(sEnd.map((s, j) => snap(X(s, j))));
  if (dent) { // Delle: ein Ringabschnitt in der Mitte nach innen gedrückt
    const k = rings.length >> 1;
    for (let kk = k - 2; kk <= k + 2; kk++) for (let j = 0; j < 6; j++) { const c = frame(kk * ds).P; rings[kk][j] = add(rings[kk][j], mul(norm(sub(c, rings[kk][j])), dent)); }
  }
  const tris = [];
  const tri = (a, b, c, inward) => { // Orientierung: Normale soll in Richtung `inward` zeigen
    const n = cross(sub(b, a), sub(c, a));
    if (dot(n, inward) < 0) tris.push([a, c, b]); else tris.push([a, b, c]);
  };
  for (let k = 0; k + 1 < rings.length; k++) for (let j = 0; j < NP; j++) {
    const a = rings[k][j], b = rings[k][(j + 1) % NP], c = rings[k + 1][(j + 1) % NP], d = rings[k + 1][j];
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
  const top = rings[0], exitRing = rings[rings.length - 1];
  const quad = (a, b, c, d, n) => { tri(a, b, c, n); tri(a, c, d, n); };
  if (exit === 'top') {
    // U-Bogen: beide Löcher in der Deckfläche → Rechteck zwischen den Löchern teilen (je Teil ein
    // Loch); der Teilungspunkt liegt auch auf den Deck-Kanten der Seiten y = 0 / y = D (keine T-Stöße)
    const xs = (ring) => ring.map((p) => p[0]);
    const [lo, hi] = Math.max(...xs(exitRing)) < Math.min(...xs(top)) ? [exitRing, top] : [top, exitRing];
    const xm = 0.5 * (Math.max(...xs(lo)) + Math.min(...xs(hi)));
    holed([B(0, 0, H), B(xm, 0, H), B(xm, D, H), B(0, D, H)], lo, [0, 0, 1]);
    holed([B(xm, 0, H), B(W, 0, H), B(W, D, H), B(xm, D, H)], hi, [0, 0, 1]);
    quad(B(0, 0, 0), B(0, D, 0), B(0, D, H), B(0, 0, H), [-1, 0, 0]);               // Seite x = 0
    quad(B(0, 0, 0), B(W, 0, 0), B(W, D, 0), B(0, D, 0), [0, 0, -1]);                 // Boden
    quad(B(W, 0, 0), B(W, 0, H), B(W, D, H), B(W, D, 0), [1, 0, 0]);                  // Seite x = W
    for (const y of [0, D]) {                                                         // y = 0 / y = D (Fächer)
      const n = [0, y ? 1 : -1, 0], fan = [B(0, y, H), B(xm, y, H), B(W, y, H), B(W, y, 0)];
      for (let i = 0; i + 1 < fan.length; i++) tri(B(0, y, 0), fan[i], fan[i + 1], n);
    }
  } else {
    holed([B(0, 0, H), B(W, 0, H), B(W, D, H), B(0, D, H)], top, [0, 0, 1]);          // Deckfläche
    if (exit === 'x0') holed([B(0, 0, 0), B(0, D, 0), B(0, D, H), B(0, 0, H)], exitRing, [-1, 0, 0]); // Seite x = 0
    else quad(B(0, 0, 0), B(0, D, 0), B(0, D, H), B(0, 0, H), [-1, 0, 0]);
    if (exit === 'bot') holed([B(0, 0, 0), B(W, 0, 0), B(W, D, 0), B(0, D, 0)], exitRing, [0, 0, -1]); // Boden
    else quad(B(0, 0, 0), B(W, 0, 0), B(W, D, 0), B(0, D, 0), [0, 0, -1]);
    quad(B(W, 0, 0), B(W, 0, H), B(W, D, H), B(W, D, 0), [1, 0, 0]);                  // Seite x = W
    quad(B(0, 0, 0), B(0, 0, H), B(W, 0, H), B(W, 0, 0), [0, -1, 0]);                 // y = 0
    quad(B(0, D, 0), B(W, D, 0), B(W, D, H), B(0, D, H), [0, 1, 0]);                  // y = D
  }
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
  // U-Bogen: Ein- und Austritt in der Deckfläche. Früher projizierten die Stationen am Bogenende auf
  // die Gerade davor zurück → Anker-Kette scheiterte (außer R ≈ 3.8/4.0), die Biarc-Vereinfachung
  // knickte um bis zu 4.2° (Kreise bis 0.022 mm neben Zylinder/Torus). R = 4.0: Anker-Kette lief
  // schon, step-strict meldete aber orient-curved am 180°-Torusband (Fehlalarm).
  ...[4.0, 4.2, 7, 12].map((R) => ({ name: `U${R}  γ=0  U-Bogen R=${R} (Gerade + 180°-Bogen + Gerade)`, mesh: { W: 30 + 2 * R, x0: 22 + 2 * R, exit: 'top', segs: [{ L: 10 }, { R, deg: 180 }, { L: 14 }] }, expect: { tubes: 1, tilted: false, pieces: 3 } })),
  // S-Kurve mit 1 mm Zwischengerade (zu kurz für einen Anker → Biarc-Kette): früher knickte die
  // Vereinfachung um 2.6° (Kreise bis 0.004 mm neben ihren Flächen)
  { name: 'S1  γ=0  S-Kurve 60°/−60° mit 1 mm Zwischengerade', mesh: { exit: 'bot', segs: [{ L: 6 }, { R: 8, deg: 60 }, { L: 1 }, { R: 8, deg: -60 }, { L: 20 }] }, expect: { tubes: 1 } },
  // D-Profil (Kreis r = 2.5 mit ebener Abflachung, nur Eck-Vertices auf den D-Kanten): früher als
  // RUNDER Kanal exportiert (Abflachung weg, ΔV −0.14 %) — muss facettiert bleiben
  { name: 'P25  D-Profil α=25°, Abflachung ∥ Bahn-Ebene → bleibt facettiert', mesh: { profile: dProfile(2.5, 25 * DEG, Math.PI / 2, 40), segs: [{ L: 12 }, { R: 8, deg: 90 }, { L: 30 }] }, expect: { tubes: 0, flat: { n: [0, 1, 0], d: 5 + 2.5 * Math.cos(25 * DEG) } } },
  { name: 'P15  D-Profil α=15°, Abflachung ⟂ Bahn-Ebene → bleibt facettiert', mesh: { profile: dProfile(2.5, 15 * DEG, 0, 40), segs: [{ L: 12 }, { R: 8, deg: 90 }, { L: 30 }] }, expect: { tubes: 0 } },
];
// D-Profil: Kreisbogen von ψ+α bis ψ+2π−α (M Segmente), die Sehne schließt den Ring (keine Punkte darauf)
function dProfile(r, alpha, psi, M) {
  return Array.from({ length: M + 1 }, (_, j) => { const p = psi + alpha + (j / M) * (2 * Math.PI - 2 * alpha); return [r * Math.cos(p), r * Math.sin(p)]; });
}

const isMain = process.argv[1] && process.argv[1].endsWith('tube-regression.mjs');
let fails = 0;
const check = (ok, msg) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) fails++; };
for (const cs of isMain ? cases : []) {
  const mesh = cleanMesh(channelBlock(cs.mesh)).mesh;   // Netz-Bereinigung wie im Worker
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
  // Strikte Importer (CST/ACIS): ohne Heilung gültig — Kreise auf ihren Flächen, Ränder richtig herum
  const strict = checkStepStrict(res.step), kinds = {};
  for (const v of strict.violations) kinds[v.kind] = (kinds[v.kind] || 0) + 1;
  check(strict.violations.length === 0, `step-strict ohne Verstoß ${strict.violations.length ? JSON.stringify(kinds) : ''}(Rand↔Fläche max ${strict.stats.maxVertexSurface.toExponential(1)} mm)`);
  if (cs.expect.pieces) check(tubes[0] && tubes[0].pieces.length === cs.expect.pieces && /Anker/.test(tubes[0].stats.chainKind), `exakte Anker-Kette mit ${cs.expect.pieces} Stücken (${tubes[0]?.stats.chainKind}, ${tubes[0]?.pieces.length})`);
  // γ = 0: das starr mitgeführte Profil steht höchstens im Knick-Budget (0.1°) schräg zur Bahn
  for (const sp of tubes) if (sp.gamma === 0) check(sp.stats.profileTiltDeg <= 0.1 + 1e-6, `Profil-Neigung gegen die Bahn ${sp.stats.profileTiltDeg.toFixed(4)}° ≤ 0.1° (Sweep-Stücke ${sp.stats.sweptPieces})`);
  if (cs.expect.flat) { // Abflachung als eigene Ebene im STEP erhalten
    const ents = parseStep(res.step), P = (r) => ents.get(r.ref).args[1];
    const found = [...ents.values()].some((e) => {
      if (e.type !== 'PLANE') return false;
      const ax = ents.get(e.args[1].ref).args, o = P(ax[1]), n = P(ax[2]);
      return Math.abs(Math.abs(dot(n, cs.expect.flat.n)) - 1) < 1e-6 && Math.abs(dot(o, cs.expect.flat.n) - cs.expect.flat.d) < 1e-4;
    });
    check(found, 'Abflachung als PLANE erhalten');
  }
  // Netz-Volumen ist ein einbeschriebenes Polygon (N=48) → analytischer Kanal ist minimal größer;
  // bleibt der Kanal facettiert, muss das Volumen exakt dem Netz entsprechen
  if (expExp === 0 && !cs.tamper) check(Math.abs(dev) < 1e-6, `facettiert: Volumen occt = STL (ΔV ${(dev * 100).toExponential(1)} %)`);
  else check(Math.abs(dev) < 0.002, `Volumen occt vs. STL < 0.2 % (${(dev * 100).toFixed(3)} %)`);
}
if (isMain) {
  console.log(fails ? `\n❌ ${fails} Prüfung(en) fehlgeschlagen` : '\n✅ Kanal-Regression grün');
  process.exit(fails ? 1 : 0);
}

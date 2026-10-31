// ─────────────────────────────────────────────────────────────────────────────
// Härtetest Body-Defeaturing v2: alle Körper aus gen.mjs erzeugen, durch die ECHTE Worker-
// Pipeline schicken (parseStl → buildNormalGroups → unifyCoplanarGroups → recognizePrimitives →
// buildVolumeStepBrepV2), STEP mit occt parsen und gegen die analytisch bekannte SOLL-Geometrie
// prüfen: Volumen (Divergenzsatz über das occt-Netz), Schnittflächen auf mehreren Höhen,
// Bounding-Box und Abstand jedes STEP-Punkts zur Soll-Oberfläche.
//
// Drei Exporte je Körper (vier für Körper mit `bends`):
//   AUS  — defeature:false (Basislinie: muss das Netz exakt wiedergeben)
//   AN   — defeature:true, volle Pipeline (Bohrungen/v1/v2 + globaler Fallback)
//   v2   — defeature:true, Primitive entfernt → v2 (defeatureBands) ISOLIERT, ohne Bohrungs-/v1-Pfad
//   AN+B — wie AN, zusätzlich sharpenBends:true (Blech-Biegungen schärfen) — nur für Körper mit
//          `bends` (p1–p4, p6): dort müssen die Biegungen scharf werden (Soll = Rohprofil) —
//          außer bei `expect.bendsSharpenable: false` (p4/p6: Stirnseiten gefast → dort kann
//          keine Entrundung die Biegung schärfen; AN+B darf „Rundung bleiben“ liefern).
// Der v2-Lauf macht sichtbar, wenn der globale Fallback ein korrektes v2-Ergebnis verwirft, weil
// ein ANDERER Schritt die Hülle öffnet (AN: alles facettiert, v2 allein: Bänder wasserdicht).
//
// Regel: v2 muss je Körper ENTWEDER exakt richtig schärfen ODER sicher überspringen (Ergebnis
// wasserdicht und identisch zum Netz mit Rundung). Zulässige Ergebnisse = „Varianten“: jede
// Teilmenge der Rundungen scharf (eine Rundung = eine Säulen-Deckkante; v2 zählt sie in
// bandsDefeatured, v1 in filletsDefeatured) — exakt nachgerechnet; dazu bei Bohrungen die scharfe
// Bohrung (Ziel: v2 schärft die Mündung, Lochwand → Zylinder zwischen den Deckflächen) und der
// Chamfer-Pfad (Mündung → Kegel, zulässig) — Volumen aus den emittierten Zylinder-/Kegel-Parametern.
// Kreisrunde Außenwände (Rohr) darf der Mantel-Pfad als CYLINDRICAL_SURFACE liefern (mantleInfo).
// Fasen dürfen nie verschwinden, bei Soll „skip“ muss bandsDefeatured = 0 sein. Senkungen (x1–x4)
// dürfen nie verschwinden: zulässig ist nur Senkung mit Rundung (Netz), Senkung scharf (Ziel: nur die
// Kanten-Rundung weg, Kegel bleibt) oder ein Kegel durch die Rundung (Chamfer-Pfad), s. cskVariant.
//   exakt     → OK
//   ≤ 0.01 mm → OK mit Hinweis (Abweichung innerhalb der Toleranz-Stufe 0.01 mm = Planar-Toleranz des Region-Growing)
//   Bögen exakt → OK mit Hinweis (der Exporter hat facettierte Profil-Bögen durch echte Teil-Zylinder/
//                 -Kegel ersetzt: die Abweichung entspricht der Sehnen-Pfeilhöhe bzw. dem Bogen-Volumen;
//                 der Kandidat wird hier NICHT nach dem nächsten Volumen gewählt — die Volumina der
//                 Varianten liegen oft dicht beieinander (k1 v2) — es gewinnt die Variante mit dem
//                 KLEINSTEN beidseitigen Abstand, zulässig bis Sehnen-Pfeilhöhe + 0.01 mm)
//   sonst     → Soll-Verletzung (Exit 1); ebenso: offen, occt-Fehler, Fallback verwirft v2, zu langsam,
//               Verstoß gegen strikte Importer (tests/step-strict.mjs inkl. loop-fold, je Export AUS/AN/v2)
// Passt eine Variante, die nicht das Ziel ist (Rundung bleibt, obwohl v2 schärfen sollte) →
// Hinweis „Ziel verfehlt“ (sicher, aber nicht defeaturet).
//
// Blech-Biegungen (p1–p4, p6 mit `bends`): im AN-Lauf (Schalter „Blech-Biegungen schärfen“ AUS)
// bleiben die Biegungen RUND → Soll = „Rundung bleibt“ mit den Bögen als Teil-Zylinder (Bogen-Flächen
// wie im AUS-Export, Volumen = Netz). Der Zusatz-Lauf AN+B (sharpenBends: true) muss sie SCHARF machen
// → Soll = das scharfe Rohprofil (`bends.pts`, Volumen = polyArea × Höhe). Ausnahme: Körper mit
// `expect.bendsSharpenable: false` (p4/p6 — Stirnseiten gefast: dort kann keine Entrundung die
// Biegung schärfen, auch ohne den Schalter nicht) → AN+B darf „Rundung bleibt“ liefern (nur eine
// Notiz). Für alle anderen Körper mit `bends` ist ein AN+B-Ergebnis ohne scharfe Biegungen eine
// Soll-Verletzung (kein bloßer Hinweis). Der v2-isoliert-Lauf kennt keine Primitive (keine
// Biegungs-Erkennung) → dort frei (nur die universellen Pflichten).
// Taschenecken (p5, KEINE Biegung): die vier Ecken werden im AN-Lauf wie bisher geschärft → Soll =
// „4 von 4 Eckrundungen scharf“ (`cornerVariants`). AUS bleibt voll geprüft (Bogen-Flächen `arcsOff`,
// Volumen).
//
// Aufruf:  node tests/fixtures-v2/check.mjs [--only a,b,...] [--json] [--quick]
//          --quick: ohne Zusatz-/Stresskörper (nur a–i)
//          Stresskörper (>20k Dreiecke): nur Varianten „nichts“/„alles scharf“, ohne Abstandsprüfung
// ─────────────────────────────────────────────────────────────────────────────
import { createRequire } from 'module';
import { pathToFileURL } from 'url';
import { BODIES, STRESS, buildMesh, checkManifold, toBinaryStl, meshVolume, sharpen, polyArea, triVolume, makeTransform, sharpenCorners, bendsConcentric } from './gen.mjs';
import { parseStl, simplifyMesh } from '../../analysis-core.js';
import { buildNormalGroups } from '../../region-growing.js';
import { cleanMesh } from '../../mesh-clean.js';
import { unifyCoplanarGroups } from '../../face-unification.js';
import { recognizePrimitives } from '../../primitive-recognition.js';
import { detectTubes } from '../../tube-sweep.js';
import { checkStepStrict } from '../step-strict.mjs';

// Anderen Exporter prüfen (z. B. einen Fix-Kandidaten): V2_EXPORTER=/pfad/exporters.js node …
const { buildVolumeStepBrepV2 } = await import(process.env.V2_EXPORTER ? pathToFileURL(process.env.V2_EXPORTER).href : '../../exporters.js');

const require = createRequire(import.meta.url);
const { getOcct } = require('../occt-check.cjs');

const MAX_FACES = 50000;            // wie analysis-worker.js
const EXPORT_LIMIT_MS = 2000;       // Export AN: max(2 s, 3× Export AUS) (Worker bricht nach 60 s ab)
// Feine occt-Tessellierung: analytische Zylinder/Kegel sonst zu grob (Default ~13 Seg./Kreis)
const OCCT_PARAMS = { linearUnit: 'millimeter', linearDeflectionType: 'absolute_value', linearDeflection: 0.001, angularDeflection: 0.02 };
// Toleranzen: Planflächen-Ergebnis ist exakt (float32-Eingabe, 6 Nachkommastellen im STEP);
// analytische Flächen weichen um die occt-Facettierung ab (Bohrungs-Variante: ∝ Mantelfläche).
// AUS mit direkt umgewandelter Bohrung: echter Kreis statt Netz-Polygon → grobe Plausibilität.
const tolPlanar = (v) => 0.02 + 2e-5 * Math.abs(v);
const tolAnalytic = (v) => 5e-3 * Math.abs(v);
const tolSection = (a) => 0.01 + 1e-5 * Math.abs(a);
const DIST_TOL = 2e-3;              // mm: „exakt“ (6 Nachkommastellen + float32)
const STEP_UNC = 0.01;              // mm: Toleranz-Stufe (früher = UNCERTAINTY des Exporters; die ist seit
                                    // 2026-10-27 1e-4 mm, s. STEP_UNCERTAINTY_MM — die Stufe bleibt 0.01 mm)

const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1].split(',') : null;
const asJson = args.includes('--json');
const quick = args.includes('--quick');

const origLog = console.log;
const quiet = (fn) => { console.log = () => {}; try { return fn(); } finally { console.log = origLog; } };

function pipeline(mesh) {
  mesh = cleanMesh(mesh).mesh;   // Netz-Bereinigung wie im Worker
  if (mesh.faces.length > MAX_FACES) mesh = simplifyMesh(mesh, MAX_FACES, () => {});
  const t0 = performance.now();
  const groups = unifyCoplanarGroups(buildNormalGroups(mesh)).unified
    .sort((a, b) => b.vertices.length - a.vertices.length);
  const { stats } = recognizePrimitives(groups);
  detectTubes(groups); // Kanal-Erkennung wie im Worker (taggt group.tube)
  return { groups, stats, ms: performance.now() - t0 };
}

// occt-Netz → Dreiecke (3D-Punkte)
function occtTris(result) {
  const tris = [];
  for (const m of result.meshes || []) {
    const p = m.attributes.position.array, ix = m.index.array;
    const P = (i) => [p[3 * i], p[3 * i + 1], p[3 * i + 2]];
    for (let i = 0; i < ix.length; i += 3) tris.push([P(ix[i]), P(ix[i + 1]), P(ix[i + 2])]);
  }
  return tris;
}

// Schnittfläche eines geschlossenen, außen-orientierten Netzes mit der Ebene z = c:
// Schnitt-Segmente so orientieren, dass das Material links liegt (Richtung ẑ × n), dann Gauß.
// `inv` (optional): gedrehter/verschobener Körper → Punkte erst ins Körpersystem zurückbilden.
function sectionArea(tris, c, inv = null) {
  let A = 0;
  for (let [a, b, d] of tris) {
    if (inv) { a = inv(a); b = inv(b); d = inv(d); }
    const pts = [];
    for (const [p, q] of [[a, b], [b, d], [d, a]]) {
      const sp = p[2] - c, sq = q[2] - c;
      if ((sp < 0 && sq >= 0) || (sp >= 0 && sq < 0)) { const t = sp / (sp - sq); pts.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]); }
    }
    if (pts.length !== 2) continue;
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2]];
    let [P, Q] = pts;
    if ((Q[0] - P[0]) * -n[1] + (Q[1] - P[1]) * n[0] < 0) [P, Q] = [Q, P];
    A += (P[0] * Q[1] - Q[0] * P[1]) / 2;
  }
  return A;
}

// Abstand Punkt ↔ Dreieck (nächster Punkt nach Ericson, Real-Time Collision Detection 5.1.5)
function distPointTri(p, a, b, c) {
  const sub = (x, y) => [x[0] - y[0], x[1] - y[1], x[2] - y[2]];
  const dot = (x, y) => x[0] * y[0] + x[1] * y[1] + x[2] * y[2];
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
  const d1 = dot(ab, ap), d2 = dot(ac, ap);
  const at = (s, t) => Math.hypot(p[0] - (a[0] + ab[0] * s + ac[0] * t), p[1] - (a[1] + ab[1] * s + ac[1] * t), p[2] - (a[2] + ab[2] * s + ac[2] * t));
  if (d1 <= 0 && d2 <= 0) return at(0, 0);
  const bp = sub(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return at(1, 0);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return at(d1 / (d1 - d3), 0);
  const cp = sub(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return at(0, 1);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return at(0, d2 / (d2 - d6));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const w = (d4 - d3) / ((d4 - d3) + (d5 - d6)); return Math.hypot(p[0] - (b[0] + (c[0] - b[0]) * w), p[1] - (b[1] + (c[1] - b[1]) * w), p[2] - (b[2] + (c[2] - b[2]) * w)); }
  const den = 1 / (va + vb + vc);
  return at(vb * den, vc * den);
}
// Größter Abstand einer Punktmenge zu einer Dreiecks-Oberfläche (AABB-Vorfilter je Dreieck)
function maxDistToSurface(points, tris) {
  const boxes = tris.map(([a, b, c]) => [Math.min(a[0], b[0], c[0]), Math.min(a[1], b[1], c[1]), Math.min(a[2], b[2], c[2]), Math.max(a[0], b[0], c[0]), Math.max(a[1], b[1], c[1]), Math.max(a[2], b[2], c[2])]);
  let worst = 0, worstPt = null;
  for (const p of points) {
    let best = Infinity;
    for (let i = 0; i < tris.length; i++) {
      const bx = boxes[i];
      const dx = Math.max(bx[0] - p[0], 0, p[0] - bx[3]), dy = Math.max(bx[1] - p[1], 0, p[1] - bx[4]), dz = Math.max(bx[2] - p[2], 0, p[2] - bx[5]);
      if (dx * dx + dy * dy + dz * dz >= best * best) continue;
      const d = distPointTri(p, ...tris[i]);
      if (d < best) best = d;
    }
    if (best > worst) { worst = best; worstPt = p; }
  }
  return { worst, worstPt };
}
const uniquePts = (tris) => { const seen = new Set(), out = []; for (const t of tris) for (const p of t) { const k = p.join(','); if (!seen.has(k)) { seen.add(k); out.push(p); } } return out; };
const surfArea = (tris) => { let s = 0; for (const [a, b, c] of tris) { const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]; s += Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 2; } return s; };
const bbox = (tris) => {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const t of tris) for (const p of t) for (let k = 0; k < 3; k++) { if (p[k] < lo[k]) lo[k] = p[k]; if (p[k] > hi[k]) hi[k] = p[k]; }
  return [...lo, ...hi];
};
const fmtPt = (p) => p.map((x) => x.toFixed(3)).join(',');

// Punkte auf float32 runden (so wie die binäre STL sie speichert) — geteilte Punkte bleiben geteilt
const f32 = (tris) => { const m = new Map(); return tris.map((t) => t.map((p) => { let q = m.get(p); if (!q) { q = p.map(Math.fround); m.set(p, q); } return q; })); };

// Rundungen eines Körpers: je Säule und Ende mit konvexer/konkaver Rundung ein Eintrag (Senkung mit
// verrundeten Kanten: EIN Eintrag — scharf heißt dort: Kegel bleibt, nur die Rundungen fallen weg)
const isRounded = (spec) => ['round', 'concave'].includes(spec?.kind) || (spec?.kind === 'countersink' && (spec.r > 0 || spec.rw > 0));
// runs: zusammenhängende verrundete Kanten-Abschnitte (spec.edges, zyklisch) — v2 entfernt je Abschnitt
// höchstens ein (offenes) Band, d.h. eine Rundung kann bis zu `runs` Bänder zählen
const edgeRuns = (spec, n) => {
  if (!spec?.edges) return 1;
  const set = new Set(spec.edges);
  let runs = 0; for (let e = 0; e < n; e++) if (set.has(e) && !set.has((e - 1 + n) % n)) runs++;
  return Math.max(1, runs);
};
const roundedPairs = (body) => {
  const out = [];
  body.columns.forEach((col, c) => { for (const end of ['bottom', 'top']) if (isRounded(col[end])) out.push({ c, end, runs: edgeRuns(col[end], col.profile.length), key: `${col.name || 'S' + c}.${end === 'top' ? 'oben' : 'unten'}` }); });
  return out;
};

// Profil-Eckrundungen schärfen wie v2b (exporters.js defeatureProfileCorners): Bogenlauf (kleine
// gleichsinnige Knicke, endet an langen Kanten) zwischen zwei geraden Kanten → Schnittpunkt der
// verlängerten Kanten. Vollkreise (keine deutlich längere Kante) und Bögen zwischen parallelen
// Kanten bleiben. Für die idealen Testprofile genügen die tangentialen Fälle („cross“).
function sharpenProfile2D(pts) {
  const n = pts.length;
  if (n < 6) return pts;
  const len = [], dir = [], turn = [];
  for (let i = 0; i < n; i++) { const a = pts[i], b = pts[(i + 1) % n]; const l = Math.hypot(b[0] - a[0], b[1] - a[1]); len.push(l); dir.push([(b[0] - a[0]) / l, (b[1] - a[1]) / l]); }
  for (let i = 0; i < n; i++) { const a = dir[(i - 1 + n) % n], b = dir[i]; turn.push(Math.atan2(a[0] * b[1] - a[1] * b[0], a[0] * b[0] + a[1] * b[1]) * 180 / Math.PI); }
  const sorted = len.slice().sort((x, y) => x - y);
  let iLong = 0; for (let i = 1; i < n; i++) if (len[i] > len[iLong]) iLong = i;
  if (len[iLong] < 3 * sorted[n >> 1]) return pts;                 // Vollkreis
  const isArc = (i) => Math.abs(turn[i]) >= 0.3 && Math.abs(turn[i]) <= 35;
  const repl = new Map();                                           // Index j → { m, C }
  const s0 = (iLong + 1) % n;
  for (let k = 0; k < n; ) {
    const i0 = (s0 + k) % n;
    if (!isArc(i0)) { k++; continue; }
    const sg = Math.sign(turn[i0]); let e = i0, cnt = 1; const ch = [];
    while (k + cnt < n && isArc((e + 1) % n) && Math.sign(turn[(e + 1) % n]) === sg) {
      if (ch.length) { const srt = ch.slice().sort((x, y) => x - y); if (len[e] > 2.5 * srt[srt.length >> 1]) break; }
      ch.push(len[e]); e = (e + 1) % n; cnt++;
    }
    k += cnt;
    if (cnt < 2) continue;
    const ia = (i0 - 1 + n) % n, ib = e, dA = dir[ia], dB = dir[ib];
    const cr = dA[0] * dB[1] - dA[1] * dB[0];
    if (Math.abs(cr) < Math.sin(10 * Math.PI / 180)) continue;
    const wx = pts[e][0] - pts[i0][0], wy = pts[e][1] - pts[i0][1];
    const t = (wx * dB[1] - wy * dB[0]) / cr;
    repl.set(i0, { m: e, C: [pts[i0][0] + t * dA[0], pts[i0][1] + t * dA[1]] });
  }
  if (!repl.size) return pts;
  const out = []; const skip = new Set();
  for (const [j, { m }] of repl) for (let i = j; ; i = (i + 1) % n) { if (i !== j) skip.add(i); if (i === m) break; }
  for (let i = 0; i < n; i++) { if (repl.has(i)) out.push(repl.get(i).C); else if (!skip.has(i)) out.push(pts[i]); }
  return out;
}

// Zulässige planare Ergebnisse: jede Teilmenge der Rundungen scharf
function variantsFor(body, vMeshParsed, heavy) {
  const pairs = roundedPairs(body);
  const vs = [];
  const all = (1 << pairs.length) - 1;
  for (let m = 0; m <= all; m++) {
    if (heavy && m !== 0 && m !== all) continue; // Stresskörper: nur „nichts“ / „alles scharf“
    const S = pairs.filter((_, i) => m & (1 << i));
    const tris = f32(buildMesh(sharpen(body, (c, end) => S.some((p) => p.c === c && p.end === end))));
    vs.push({
      label: m === 0 ? 'Rundung bleibt (übersprungen)' : m === all ? 'alle Rundungen scharf' : `scharf: ${S.map((p) => p.key).join('+')}`,
      sharpCount: S.length, sharpMax: S.reduce((s, p) => s + p.runs, 0), planar: true, tris,
      volume: m === 0 ? vMeshParsed : meshVolume(tris), tol: tolPlanar,
      target: body.expect.mode === 'sharp' ? m === all : m === 0,
    });
  }
  // v1/v2 an senkrechten Eckrundungen (body.cornerVariants, Körper ohne Deck-Rundungen): jede Teilmenge der
  // Ecken scharf (Schnittpunkt der angrenzenden Kanten, s. gen.mjs sharpenCorners); Ziel = alle Ecken.
  // sharpMax = Zahl der Ecken: je Ecke entfernt der Exporter EIN Band (v2) bzw. eine Verrundung (v1).
  if (body.cornerVariants) {
    const { col, corners, kind } = body.cornerVariants;
    for (const v of vs) v.target = false;
    for (let m = 1; m < (1 << corners.length); m++) {
      const sel = corners.filter((_, i) => m & (1 << i));
      const bodyC = { ...body, columns: body.columns.map((c, i) => (i === col ? { ...c, profile: sharpenCorners(c.profile, sel) } : c)) };
      const tris = f32(buildMesh(bodyC));
      vs.push({ label: `${sel.length} von ${corners.length} Eckrundungen scharf (${kind || 'v1'})`, sharpCount: 0, sharpMax: corners.length, planar: true, tris, volume: meshVolume(tris), tol: tolPlanar, target: sel.length === corners.length });
    }
  }
  // v2b (seit 2026-10-24): nach den Deck-Bändern werden auch die senkrechten Profil-Eckrundungen
  // geschärft (eBike-Referenz „ohne rundungen“ hat dort scharfe Ecken) → zusätzliche Ziel-Variante.
  if (pairs.length) {
    const bodyP = { ...body, columns: body.columns.map((col) => ({ ...col, profile: sharpenProfile2D(col.profile) })) };
    if (bodyP.columns.some((col, i) => col.profile.length !== body.columns[i].profile.length)) {
      const tris = f32(buildMesh(sharpen(bodyP)));
      vs.push({ label: 'alle Rundungen + Profilecken scharf (v2b)', sharpCount: pairs.length, sharpMax: pairs.reduce((s, p) => s + p.runs, 0), planar: true, tris, volume: meshVolume(tris), tol: tolPlanar, target: body.expect.mode === 'sharp' });
    }
  }
  return vs;
}

// Soll-Variante „Blech-Biegungen schärfen“ (AN+B): das scharfe Rohprofil eines Blechprofils —
// bends.pts sind die Rohpunkte VOR der Rundung (gen.mjs: sheetLRaw/sheetURaw/sheetZRaw). Volumen =
// polyArea(bends.pts) × Höhe (scharfes Profil = Fläche × Höhe), Netz = Körper mit dieser Kontur.
// Diese Variante ist das ZIEL des AN+B-Laufs — aber nur für Körper, deren Biegungen sich
// überhaupt schärfen lassen (`expect.bendsSharpenable !== false`, Default true). Bei p4/p6
// (Stirnseiten gefast) kann keine Entrundung die Biegung schärfen (auch ohne Schalter nicht) →
// dort darf der AN+B-Lauf „Rundung bleibt“ liefern (nur eine Notiz, keine Soll-Verletzung).
function bendsSharpVariant(body) {
  if (!body.bends) return null;
  const col = body.bends.col ?? 0;
  const c = body.columns[col];
  if (!c) return null;
  const raw = body.bends.pts.map((p) => [p[0], p[1]]);
  const bodyC = { ...body, columns: body.columns.map((cc, i) => (i === col ? { ...cc, profile: raw } : cc)) };
  const tris = f32(buildMesh(bodyC));
  // Gefaste Stirnseiten (p4/p6/p7): seit v2d (exporters.js, defeatureChamferCorners) wird die Biegung
  // auch dort scharf, die Fase läuft als Gehrung um die Ecke → Soll = Rohprofil MIT den Fasen (Netz-Volumen
  // des Körpers mit Rohprofil und denselben Enden); scharfe Enden: Fläche × Höhe wie bisher.
  const sharpEnds = [c.bottom, c.top].every((sp) => !sp || sp.kind === 'sharp');
  return {
    label: 'Blech-Biegungen scharf (Rohprofil)', sharpCount: 0, sharpMax: 0, planar: true, tris,
    volume: sharpEnds ? Math.abs(polyArea(raw)) * (c.z1 - c.z0) : meshVolume(tris), tol: tolPlanar, target: true,
  };
}

// Konvexe Außenmäntel (exporters.js, Mantel-Pfad): die Außenwand einer kreisrunden Säule wird
// EINE CYLINDRICAL_SURFACE Rm, sobald beide Ränder Außen-Loops ebener Deckflächen sind (mit Toggle
// auch nach dem Schärfen der Deck-Verrundungen, z. B. Rohr h/u2/u). Je umgewandeltem Mantel ist das
// Profil-Polygon durch den Kreis Rm ersetzt (Rm aus der emittierten STEP); seine zwei Kreise müssen
// exakt in den Deckebenen liegen. Ohne Mantel-Zylinder in der STEP: dv = 0 (facettiert).
function mantleInfo(body, ent, plac) {
  const out = { dv: 0, aLat: 0, radii: [], parts: [], plaus: true };
  for (const col of body.columns) {
    const n = col.profile.length;
    if (polyArea(col.profile) <= 0 || n < 9) continue;             // nur Außenkonturen (CCW)
    const cx = col.profile.reduce((s, p) => s + p[0], 0) / n, cy = col.profile.reduce((s, p) => s + p[1], 0) / n;
    const rs = col.profile.map((p) => Math.hypot(p[0] - cx, p[1] - cy)), R = rs.reduce((s, r) => s + r, 0) / n;
    if (rs.some((r) => Math.abs(r - R) > 1e-6 * Math.max(1, R))) continue; // kein Kreisprofil
    let Rm = null; const zs = [];
    for (const e of ent.values()) {
      const m = e.match(/^CYLINDRICAL_SURFACE\('',(#\d+),([\d.]+)\)/);
      if (m) { const p = plac(m[1]); if (Math.hypot(p.loc[0] - cx, p.loc[1] - cy) < 0.05 && Math.abs(+m[2] - R) < 0.05) Rm = +m[2]; }
    }
    if (Rm === null) continue;
    for (const e of ent.values()) {
      const m = e.match(/^CIRCLE\('',(#\d+),([\d.]+)\)/);
      if (m) { const p = plac(m[1]); if (Math.hypot(p.loc[0] - cx, p.loc[1] - cy) < 0.05 && Math.abs(+m[2] - Rm) < 1e-6) zs.push(p.loc[2]); }
    }
    zs.sort((x, y) => x - y);
    const H = col.z1 - col.z0;
    out.dv += (Math.PI * Rm * Rm - polyArea(col.profile)) * H;
    out.aLat += 2 * Math.PI * Rm * H;
    out.radii.push(Rm);
    out.plaus = out.plaus && zs.length === 2 && Math.abs(zs[0] - col.z0) < 1e-3 && Math.abs(zs[1] - col.z1) < 1e-3;
    out.parts.push(`Mantel→Zylinder R${Rm.toFixed(3)}`);
  }
  return out;
}
const isMantleCircle = (mi, c) => mi.radii.some((Rm) => Math.abs(c.r - Rm) < 1e-6);

// Bohrungs-Chamfer-Pfad (läuft VOR v2): Lochwand → CYLINDRICAL_SURFACE Rc zwischen zwei Kreisen,
// Mündungs-Verrundung → Kegel von Rc auf den Mündungskreis R2 in der Deckebene. Parameter aus der
// emittierten STEP lesen (der Rand sitzt da, wo die Bohrungs-Erkennung die Wand enden lässt — oft
// schon in der ersten Rundungsschicht), Volumen exakt nachrechnen, Plausibilität gegen das Netz.
function boreVariant(body, b, step, others) {
  const ent = new Map();
  for (const line of step.split('\n')) { const m = line.match(/^#(\d+)=(.*);$/); if (m) ent.set(+m[1], m[2]); }
  const pt = (i) => ent.get(i).match(/,\(([^()]*)\)\)$/)[1].split(',').map(Number);
  const plac = (ref) => { const m = ent.get(+ref.slice(1)).match(/AXIS2_PLACEMENT_3D\('',(#\d+),(#\d+),(#\d+)\)/); return { loc: pt(+m[1].slice(1)), axis: pt(+m[2].slice(1)) }; };
  const col = body.columns[b.col];
  const cx = col.profile.reduce((s, p) => s + p[0], 0) / col.profile.length, cy = col.profile.reduce((s, p) => s + p[1], 0) / col.profile.length;
  let Rc = null; const circles = [];
  for (const v of ent.values()) {
    let m;
    if ((m = v.match(/^CYLINDRICAL_SURFACE\('',(#\d+),([\d.]+)\)/))) { const p = plac(m[1]); if (Math.hypot(p.loc[0] - cx, p.loc[1] - cy) < 0.05 && Math.abs(+m[2] - b.R) < 0.05) Rc = +m[2]; }
    if ((m = v.match(/^CIRCLE\('',(#\d+),([\d.]+)\)/))) { const p = plac(m[1]); if (Math.hypot(p.loc[0] - cx, p.loc[1] - cy) < 0.05) circles.push({ r: +m[2], z: p.loc[2] }); }
  }
  const fail = (why) => ({ label: `Bohrung→Zylinder+Kegel: ${why}`, sharpCount: others, bores: 1, cones: 2, planar: false, volume: NaN, tol: tolAnalytic, target: false });
  if (Rc === null) return fail('kein Zylinder');
  const mi = mantleInfo(body, ent, plac);
  const rim = circles.filter((c) => Math.abs(c.r - Rc) < 1e-6).map((c) => c.z).sort((x, y) => x - y);
  const mouth = circles.filter((c) => c.r > Rc + 0.02 && !isMantleCircle(mi, c)).sort((x, y) => x.z - y.z);
  if (rim.length !== 2 || mouth.length !== 2) return fail(`Kreise ${rim.length}/${mouth.length}`);
  const frustum = (r1, r2, h) => (Math.PI * h / 3) * (r1 * r1 + r1 * r2 + r2 * r2);
  let v = meshVolume(buildMesh(sharpen(body))) + Math.abs(polyArea(col.profile)) * (col.z1 - col.z0) + mi.dv;
  v -= Math.PI * Rc * Rc * (rim[1] - rim[0]) + frustum(Rc, mouth[0].r, rim[0] - mouth[0].z) + frustum(Rc, mouth[1].r, mouth[1].z - rim[1]);
  const R2nom = b.R + b.r / Math.cos(Math.PI / b.seg);
  const plaus = mi.plaus && Math.abs(Rc - b.R) < 0.02 && mouth.every((m) => Math.abs(m.r - R2nom) < 0.02) && Math.abs(mouth[0].z - col.z0) < 1e-3 && Math.abs(mouth[1].z - col.z1) < 1e-3
    && rim[0] > col.z0 && rim[0] <= col.z0 + b.r + 1e-3 && rim[1] < col.z1 && rim[1] >= col.z1 - b.r - 1e-3;
  // Toleranz ∝ Mantelfläche: occt facettiert Zylinder/Kegel mit Sehnenfehler ~linearDeflection
  const slant = (r2, h) => Math.hypot(r2 - Rc, h);
  const aLat = mi.aLat + 2 * Math.PI * Rc * (rim[1] - rim[0]) + Math.PI * (Rc + mouth[0].r) * slant(mouth[0].r, rim[0] - mouth[0].z) + Math.PI * (Rc + mouth[1].r) * slant(mouth[1].r, mouth[1].z - rim[1]);
  return {
    label: `außen scharf${mi.parts.length ? ' + ' + mi.parts.join(', ') : ''} + Bohrung→Zylinder R${Rc.toFixed(3)} (z ${rim[0].toFixed(3)}..${rim[1].toFixed(3)}) + 2 Kegel auf R${mouth[0].r.toFixed(3)}${plaus ? '' : ' [UNPLAUSIBEL]'}`,
    // Seit „erst entrunden, dann Bohrungen“ ist die scharfe Bohrung (unten) das Ziel; der Kegel-Pfad
    // bleibt zulässig (sicher), verfehlt aber das Ziel.
    sharpCount: others, bores: 1, cones: 2, planar: false, volume: plaus ? v : NaN, tol: () => 0.02 + 2 * OCCT_PARAMS.linearDeflection * aLat, target: false,
  };
}

// Scharfe Bohrungen (exporters.js: erst entrunden, dann Bohrungen): v2 schärft auch die Mündungs-
// bänder, danach wird jede Lochwand zwischen den nun scharfen Kreisrändern der beiden Deckflächen
// EINE CYLINDRICAL_SURFACE, keine Kegel. Alle Bohrungen `bores` gemeinsam: Volumen = alles scharf,
// je Loch das Polygon durch den Kreis Rc ersetzt (Rc aus der emittierten STEP); Ränder müssen exakt
// in den Deckebenen liegen.
function boreSharpVariant(body, bores, step, sharpCount) {
  const ent = new Map();
  for (const line of step.split('\n')) { const m = line.match(/^#(\d+)=(.*);$/); if (m) ent.set(+m[1], m[2]); }
  const pt = (i) => ent.get(i).match(/,\(([^()]*)\)\)$/)[1].split(',').map(Number);
  const plac = (ref) => { const m = ent.get(+ref.slice(1)).match(/AXIS2_PLACEMENT_3D\('',(#\d+),(#\d+),(#\d+)\)/); return { loc: pt(+m[1].slice(1)), axis: pt(+m[2].slice(1)) }; };
  const fail = (why) => ({ label: `Bohrung scharf→Zylinder: ${why}`, sharpCount, bores: bores.length, cones: 0, planar: false, volume: NaN, tol: tolAnalytic, target: false });
  const mi = mantleInfo(body, ent, plac);
  let v = meshVolume(buildMesh(sharpen(body))) + mi.dv, aLat = mi.aLat, plaus = mi.plaus;
  const parts = [];
  for (const b of bores) {
    const col = body.columns[b.col];
    const cx = col.profile.reduce((s, p) => s + p[0], 0) / col.profile.length, cy = col.profile.reduce((s, p) => s + p[1], 0) / col.profile.length;
    let Rc = null; const circles = [];
    for (const e of ent.values()) {
      let m;
      if ((m = e.match(/^CYLINDRICAL_SURFACE\('',(#\d+),([\d.]+)\)/))) { const p = plac(m[1]); if (Math.hypot(p.loc[0] - cx, p.loc[1] - cy) < 0.05 && Math.abs(+m[2] - b.R) < 0.05) Rc = +m[2]; }
      if ((m = e.match(/^CIRCLE\('',(#\d+),([\d.]+)\)/))) { const p = plac(m[1]); if (Math.hypot(p.loc[0] - cx, p.loc[1] - cy) < 0.05) circles.push({ r: +m[2], z: p.loc[2] }); }
    }
    if (Rc === null) return fail(`kein Zylinder (${col.name})`);
    const own = circles.filter((c) => !isMantleCircle(mi, c));   // Kreise eines koaxialen Außenmantels zählen nicht
    const rim = own.filter((c) => Math.abs(c.r - Rc) < 1e-6).map((c) => c.z).sort((x, y) => x - y);
    if (rim.length !== 2 || own.length !== 2) return fail(`Kreise ${rim.length}/${own.length} (${col.name})`);
    const H = col.z1 - col.z0;
    v += Math.abs(polyArea(col.profile)) * H - Math.PI * Rc * Rc * H;
    aLat += 2 * Math.PI * Rc * H;
    plaus = plaus && Math.abs(Rc - b.R) < 0.02 && Math.abs(rim[0] - col.z0) < 1e-3 && Math.abs(rim[1] - col.z1) < 1e-3;
    parts.push(`R${Rc.toFixed(3)} (z ${rim[0].toFixed(3)}..${rim[1].toFixed(3)})`);
  }
  return {
    label: `alle Rundungen scharf + Bohrung→Zylinder ${parts.join(', ')}${mi.parts.length ? ' + ' + mi.parts.join(', ') : ''}${plaus ? '' : ' [UNPLAUSIBEL]'}`,
    sharpCount, bores: bores.length, cones: 0, planar: false, volume: plaus ? v : NaN, tol: () => 0.02 + 2 * OCCT_PARAMS.linearDeflection * aLat,
    // Ziel: bei 'sharp' alle Rundungen scharf + Bohrung als Zylinder; bei 'skip' NICHTS scharf
    // (die Bohrung wird ohnehin in jedem Lauf umgewandelt) → dann ist diese Variante das Ziel.
    target: body.expect.mode === 'sharp' || (body.expect.mode === 'skip' && sharpCount === 0),
  };
}

// Sacklöcher (blind holes, body.holes): die Bohrung endet im Material — der Zylinder reicht nur
// vom Lochboden (zLo) bis zur Mündung (zHi); unten liegt eine flache Ebene (Lochboden) oder ein
// Kegel (Bohrspitze, Halbwinkel α = tipDeg/2). Je Loch: ein Zylinder Rc mit genau zwei Randkreisen
// (zLo, zHi) auf der Lochachse; bei Spitze zusätzlich ein Kegel auf derselben Achse.
// Volumen: Netz (Polygonzylinder, Spitzenteil als Polyeder) → analytisch (Kreis + Kegel).
function holesVariant(body, step, sharpCount) {
  const ent = new Map();
  for (const line of step.split('\n')) { const m = line.match(/^#(\d+)=(.*);$/); if (m) ent.set(+m[1], m[2]); }
  const pt = (i) => ent.get(i).match(/,\(([^()]*)\)\)$/)[1].split(',').map(Number);
  const plac = (ref) => { const m = ent.get(+ref.slice(1)).match(/AXIS2_PLACEMENT_3D\('',(#\d+),(#\d+),(#\d+)\)/); return { loc: pt(+m[1].slice(1)), axis: pt(+m[2].slice(1)) }; };
  // gedrehter/verschobener Körper: STEP-Punkte und -Richtungen ins Körpersystem zurückbilden
  const inv = body.transform ? makeTransform(body.transform).inverse : null;
  const locB = (p) => (inv ? inv(p) : p);
  const dirB = (v) => { if (!inv) return v; const o = inv([0, 0, 0]), q = inv(v); return [q[0] - o[0], q[1] - o[1], q[2] - o[2]]; };
  const tipHoles = body.holes.filter((h) => h.kind === 'tip');
  const fail = (why) => ({ label: `Sackloch: ${why}`, sharpCount, bores: body.holes.length, cones: tipHoles.length, planar: false, volume: NaN, tol: tolAnalytic, target: false });
  let v = meshVolume(buildMesh(sharpen(body))), aLat = 0, plaus = true;
  const parts = [];
  for (const h of body.holes) {
    const col = body.columns[h.col];
    const n = col.profile.length;
    const cx = col.profile.reduce((s, p) => s + p[0], 0) / n, cy = col.profile.reduce((s, p) => s + p[1], 0) / n;
    let Rc = null, cone = null;
    for (const e of ent.values()) {
      let m;
      if ((m = e.match(/^CYLINDRICAL_SURFACE\('',(#\d+),([\d.]+)\)/))) {
        const p = plac(m[1]), loc = locB(p.loc);
        if (Math.hypot(loc[0] - cx, loc[1] - cy) < 0.05 && Math.abs(+m[2] - h.R) < 0.05) Rc = +m[2];
      }
      if ((m = e.match(/^CONICAL_SURFACE\('',(#\d+),([\d.]+),(-?[\d.]+)\)/))) {
        const p = plac(m[1]), loc = locB(p.loc);
        if (Math.hypot(loc[0] - cx, loc[1] - cy) < 0.05) cone = { a: Math.abs(+m[3]), dir: dirB(p.axis) };
      }
    }
    if (Rc === null) return fail(`kein Zylinder (${col.name})`);
    const circles = [];
    for (const e of ent.values()) {
      const m = e.match(/^CIRCLE\('',(#\d+),([\d.]+)\)/);
      if (!m) continue;
      const p = plac(m[1]), loc = locB(p.loc);
      if (Math.hypot(loc[0] - cx, loc[1] - cy) < 0.05) circles.push({ r: +m[2], z: loc[2] });
    }
    const rim = circles.filter((c) => Math.abs(c.r - Rc) < 1e-6).map((c) => c.z).sort((x, y) => x - y);
    if (rim.length !== 2) return fail(`Randkreise ${rim.length} (${col.name})`);
    const [zLo, zHi] = rim;
    const A = Math.abs(polyArea(col.profile)), H = col.z1 - col.z0;
    v += A * H - Math.PI * Rc * Rc * (zHi - zLo);            // Polygonzylinder → Kreiszylinder
    aLat += 2 * Math.PI * Rc * (zHi - zLo);
    plaus = plaus && Math.abs(Rc - h.R) < 0.02 && Math.abs(zLo - col.z0) < 1e-3 && Math.abs(zHi - col.z1) < 1e-3;
    parts.push(`R${Rc.toFixed(3)} (z ${zLo.toFixed(3)}..${zHi.toFixed(3)})`);
    if (h.kind === 'tip') {
      if (!cone) return fail(`kein Kegel (${col.name})`);
      const aNom = h.tipDeg / 2 * Math.PI / 180;
      plaus = plaus && Math.abs(cone.a - aNom) < 0.01 && Math.abs(cone.dir[2]) > 0.99;
      const hNom = h.R / Math.tan(aNom);                       // Kegelhöhe im Netz (Polyeder)
      v += A * hNom / 3 - Math.PI * Rc * Rc * (Rc / Math.tan(cone.a)) / 3;
      aLat += Math.PI * Rc * (Rc / Math.sin(cone.a));          // Kegelmantel (für die Facettierungstoleranz)
      parts[parts.length - 1] += ` + Kegel ${(cone.a * 180 / Math.PI).toFixed(2)}°`;
    }
  }
  return {
    label: `Sackloch→Zylinder ${parts.join(', ')}${plaus ? '' : ' [UNPLAUSIBEL]'}`,
    sharpCount, bores: body.holes.length, cones: tipHoles.length, planar: false,
    volume: plaus ? v : NaN, tol: () => 0.02 + 2 * OCCT_PARAMS.linearDeflection * aLat, target: body.expect.mode === 'sharp',
  };
}

// Außenmantel ohne Bohrung (z. B. Zapfen y2): alles scharf, das Profil-Polygon der kreisrunden Säule
// durch den Mantel-Kreis Rm ersetzt (mantleInfo). Nur, wenn die STEP einen Mantel-Zylinder trägt.
function mantleSharpVariant(body, step) {
  const ent = new Map();
  for (const line of step.split('\n')) { const m = line.match(/^#(\d+)=(.*);$/); if (m) ent.set(+m[1], m[2]); }
  const pt = (i) => ent.get(i).match(/,\(([^()]*)\)\)$/)[1].split(',').map(Number);
  const plac = (ref) => { const m = ent.get(+ref.slice(1)).match(/AXIS2_PLACEMENT_3D\('',(#\d+),(#\d+),(#\d+)\)/); return { loc: pt(+m[1].slice(1)), axis: pt(+m[2].slice(1)) }; };
  const mi = mantleInfo(body, ent, plac);
  if (!mi.parts.length) return null;
  const pairs = roundedPairs(body);
  return {
    label: `alle Rundungen scharf + ${mi.parts.join(', ')}${mi.plaus ? '' : ' [UNPLAUSIBEL]'}`,
    sharpCount: pairs.length, sharpMax: pairs.reduce((s, p) => s + p.runs, 0), bores: 0, cones: 0, planar: false,
    volume: mi.plaus ? meshVolume(buildMesh(sharpen(body))) + mi.dv : NaN,
    tol: () => 0.02 + 2 * OCCT_PARAMS.linearDeflection * mi.aLat, target: body.expect.mode === 'sharp',
  };
}

// Senkung (body.countersink): die Bohrung wird Zylinder Rc (z0 … Rand) + EIN Kegel vom Rand auf den
// Mündungskreis R2 in der Deckebene. Ziel: Senkung scharf (Rand am Kegelfuß, R2 = scharfe Senkungs-
// kante — v2 schärft nur die Rundung, der Kegel bleibt); zulässig: Bohrungs-Chamfer-Pfad durch die
// Rundung (R2 = äußerer Tangentenpunkt der Deck-Rundung bzw. Rand am Beginn der Wand-Rundung).
// NICHT zulässig (keine Variante): Senkung weg (glatte Bohrung). Parameter aus der STEP, Volumen
// exakt nachgerechnet; Platte = Körper ohne Senkungs-Säule (äußere Rundungen scharf, `others`).
function cskVariant(body, c, step, others) {
  const ent = new Map();
  for (const line of step.split('\n')) { const m = line.match(/^#(\d+)=(.*);$/); if (m) ent.set(+m[1], m[2]); }
  const pt = (i) => ent.get(i).match(/,\(([^()]*)\)\)$/)[1].split(',').map(Number);
  const plac = (ref) => { const m = ent.get(+ref.slice(1)).match(/AXIS2_PLACEMENT_3D\('',(#\d+),(#\d+),(#\d+)\)/); return { loc: pt(+m[1].slice(1)), axis: pt(+m[2].slice(1)) }; };
  const col = body.columns[c.col];
  const cx = col.profile.reduce((s, p) => s + p[0], 0) / col.profile.length, cy = col.profile.reduce((s, p) => s + p[1], 0) / col.profile.length;
  let Rc = null; const circles = [];
  for (const e of ent.values()) {
    let m;
    if ((m = e.match(/^CYLINDRICAL_SURFACE\('',(#\d+),([\d.]+)\)/))) { const p = plac(m[1]); if (Math.hypot(p.loc[0] - cx, p.loc[1] - cy) < 0.05 && Math.abs(+m[2] - c.R) < 0.05) Rc = +m[2]; }
    if ((m = e.match(/^CIRCLE\('',(#\d+),([\d.]+)\)/))) { const p = plac(m[1]); if (Math.hypot(p.loc[0] - cx, p.loc[1] - cy) < 0.05) circles.push({ r: +m[2], z: p.loc[2] }); }
  }
  if (Rc === null) return null;                                   // Bohrung nicht umgewandelt → planare Varianten
  const fail = (why) => ({ label: `Senkung→Zylinder+Kegel: ${why}`, sharpCount: others, bores: 1, cones: 1, planar: false, volume: NaN, tol: tolAnalytic, target: false });
  const rim = circles.filter((k) => Math.abs(k.r - Rc) < 1e-6).map((k) => k.z).sort((x, y) => x - y);
  const mouth = circles.filter((k) => k.r > Rc + 0.02);
  if (rim.length !== 2 || mouth.length !== 1) return fail(`Kreise ${rim.length}/${mouth.length}`);
  const [zBot, zRim] = rim, R2 = mouth[0].r, zTop = mouth[0].z;
  const beta = (c.ang / 2) * Math.PI / 180, cosn = Math.cos(Math.PI / c.seg);
  const tlen = c.r * Math.tan((Math.PI / 2 - beta) / 2), tw = c.rw * Math.tan(beta / 2);
  const R2sharp = c.R + c.depth * Math.tan(beta) / cosn, R2round = c.R + (c.depth * Math.tan(beta) + tlen) / cosn;
  const plaus = Math.abs(Rc - c.R) < 0.02 && Math.abs(zBot - col.z0) < 1e-3 && Math.abs(zTop - col.z1) < 1e-3
    && zRim >= col.z1 - c.depth - tw - 0.02 && zRim <= col.z1 - c.depth + 0.02 && R2 >= R2sharp - 0.02 && R2 <= R2round + 0.02;
  const exact = Math.abs(R2 - R2sharp) < 0.01 && Math.abs(zRim - (col.z1 - c.depth)) < 0.01;
  const frustum = (r1, r2, h) => (Math.PI * h / 3) * (r1 * r1 + r1 * r2 + r2 * r2);
  const plateBody = { ...body, columns: body.columns.filter((_, i) => i !== c.col) };
  const v = meshVolume(buildMesh(sharpen(plateBody))) - Math.PI * Rc * Rc * (zRim - zBot) - frustum(Rc, R2, zTop - zRim);
  const aLat = 2 * Math.PI * Rc * (zRim - zBot) + Math.PI * (Rc + R2) * Math.hypot(R2 - Rc, zTop - zRim);
  const semi = Math.atan2(R2 - Rc, zTop - zRim) * 180 / Math.PI;
  return {
    label: `${others ? 'außen scharf + ' : ''}Senkung ${exact ? 'scharf' : 'durch die Rundung (Chamfer-Pfad)'} → Zylinder R${Rc.toFixed(3)} (z ${zBot.toFixed(3)}..${zRim.toFixed(3)}) + Kegel ${semi.toFixed(2)}° auf R${R2.toFixed(3)}${plaus ? '' : ' [UNPLAUSIBEL]'}`,
    sharpCount: others + (exact ? 1 : 0), bores: 1, cones: 1, planar: false, volume: plaus ? v : NaN,
    tol: () => 0.02 + 2 * OCCT_PARAMS.linearDeflection * aLat, target: exact && body.expect.mode === 'sharp',
  };
}

// Senkung an BEIDEN Enden (body.countersinkBoth): die Bohrung wird Zylinder Rc (zLo … zHi) + ZWEI
// Kegel — unten vom Mündungskreis (unten) auf den Rand, oben vom Rand auf den Mündungskreis (oben).
// Ziel: beide Enden scharf (die Kegel bleiben, nur die Kanten-Rundung fällt weg). Parameter aus der
// emittierten STEP lesen, Volumen exakt nachrechnen; Platte = Körper ohne Senkungs-Säule (äußere
// Rundungen scharf, `others`).
function cskBothVariant(body, c, step, others) {
  const ent = new Map();
  for (const line of step.split('\n')) { const m = line.match(/^#(\d+)=(.*);$/); if (m) ent.set(+m[1], m[2]); }
  const pt = (i) => ent.get(i).match(/,\(([^()]*)\)\)$/)[1].split(',').map(Number);
  const plac = (ref) => { const m = ent.get(+ref.slice(1)).match(/AXIS2_PLACEMENT_3D\('',(#\d+),(#\d+),(#\d+)\)/); return { loc: pt(+m[1].slice(1)), axis: pt(+m[2].slice(1)) }; };
  const col = body.columns[c.col];
  const cx = col.profile.reduce((s, p) => s + p[0], 0) / col.profile.length, cy = col.profile.reduce((s, p) => s + p[1], 0) / col.profile.length;
  let Rc = null; const circles = [];
  for (const e of ent.values()) {
    let m;
    if ((m = e.match(/^CYLINDRICAL_SURFACE\('',(#\d+),([\d.]+)\)/))) { const p = plac(m[1]); if (Math.hypot(p.loc[0] - cx, p.loc[1] - cy) < 0.05 && Math.abs(+m[2] - c.R) < 0.05) Rc = +m[2]; }
    if ((m = e.match(/^CIRCLE\('',(#\d+),([\d.]+)\)/))) { const p = plac(m[1]); if (Math.hypot(p.loc[0] - cx, p.loc[1] - cy) < 0.05) circles.push({ r: +m[2], z: p.loc[2] }); }
  }
  if (Rc === null) return null;                                   // Bohrung nicht umgewandelt → planare Varianten
  const fail = (why) => ({ label: `Senkung beidseitig→Zylinder+2 Kegel: ${why}`, sharpCount: others, bores: 1, cones: 2, planar: false, volume: NaN, tol: tolAnalytic, target: false });
  const rim = circles.filter((k) => Math.abs(k.r - Rc) < 1e-6).map((k) => k.z).sort((x, y) => x - y);
  const mouth = circles.filter((k) => k.r > Rc + 0.02).sort((x, y) => x.z - y.z);
  if (rim.length !== 2 || mouth.length !== 2) return fail(`Kreise ${rim.length}/${mouth.length}`);
  const [zLo, zHi] = rim;
  const cosn = Math.cos(Math.PI / c.seg);
  // Soll-Mündungsradius: das Mündungs-Polygon des Generators ist umschrieben (Kegelmantel berührt
  // die Polygonecken) → Radius = (R + Tiefe·tan β) / cos(π/Seg), wie R2sharp in cskVariant.
  const R2nom = (e) => c.R + e.depth * Math.tan((e.ang / 2) * Math.PI / 180) / cosn;
  const R2b = R2nom(c.bottom), R2t = R2nom(c.top);
  const chk = (t) => Math.abs(Rc - c.R) < t
    && Math.abs(mouth[0].z - col.z0) < t && Math.abs(mouth[1].z - col.z1) < t
    && Math.abs(zLo - (col.z0 + c.bottom.depth)) < t && Math.abs(zHi - (col.z1 - c.top.depth)) < t
    && Math.abs(mouth[0].r - R2b) < t && Math.abs(mouth[1].r - R2t) < t;
  const plaus = chk(0.02), exact = chk(0.01);
  const frustum = (r1, r2, h) => (Math.PI * h / 3) * (r1 * r1 + r1 * r2 + r2 * r2);
  const plateBody = { ...body, columns: body.columns.filter((_, i) => i !== c.col) };
  const v = meshVolume(buildMesh(sharpen(plateBody))) - Math.PI * Rc * Rc * (zHi - zLo)
    - frustum(Rc, mouth[0].r, zLo - mouth[0].z) - frustum(Rc, mouth[1].r, mouth[1].z - zHi);
  const aLat = 2 * Math.PI * Rc * (zHi - zLo)
    + Math.PI * (Rc + mouth[0].r) * Math.hypot(mouth[0].r - Rc, zLo - mouth[0].z)
    + Math.PI * (Rc + mouth[1].r) * Math.hypot(mouth[1].r - Rc, mouth[1].z - zHi);
  return {
    label: `Senkung beidseitig scharf → Zylinder R${Rc.toFixed(3)} (z ${zLo.toFixed(3)}..${zHi.toFixed(3)}) + 2 Kegel auf R${mouth[0].r.toFixed(3)}/R${mouth[1].r.toFixed(3)}${plaus ? '' : ' [UNPLAUSIBEL]'}`,
    sharpCount: others, bores: 1, cones: 2, planar: false, volume: plaus ? v : NaN,
    tol: () => 0.02 + 2 * OCCT_PARAMS.linearDeflection * aLat, target: exact && body.expect.mode === 'sharp',
  };
}

// Ergebnis einer Variante zuordnen: exakt, sonst ≤ STEP_UNC (Toleranz-Stufe), sonst null
function matchVariants(r, vs, ctx) {
  const { heights, inv, heavy } = ctx;
  const ob = bbox(r.otris);
  const verts = uniquePts(r.otris);
  const tried = [];
  const countsOk = (v) => {
    const why = [];
    if (r.bands > (v.sharpMax ?? v.sharpCount) || (r.bands < v.sharpCount && !r.fillets && !(v.bores && r.bores))) why.push(`bands ${r.bands}≠${v.sharpCount}`);
    // Bogen-Flächen (Teil-Zylinder/-Kegel aus den Profil-Bögen) sind keine analytischen Flächen
    // einer planaren Variante — sie zählen daher nicht mit.
    const cyl = r.cyl - r.arcCyl, cones = r.cones - r.arcCones;
    if (v.planar && (cyl > 0 || cones > 0)) why.push('analytische Flächen');
    if (!v.planar && (r.bores !== v.bores || cones !== v.cones)) why.push(`bores/cones ${r.bores}/${r.cones}`);
    return why;
  };
  for (const v of vs) {
    const why = countsOk(v);
    if (!Number.isFinite(v.volume)) why.push('Variante nicht bestimmbar');
    else if (Math.abs(r.volume - v.volume) > v.tol(v.volume)) why.push(`ΔV ${(r.volume - v.volume).toFixed(3)}`);
    if (!why.length && v.planar) {
      const vbb = bbox(v.tris);
      if (vbb.some((x, k) => Math.abs(x - ob[k]) > DIST_TOL)) why.push('BBox');
      for (const z of heights) { const a = sectionArea(r.otris, z, inv), s = sectionArea(v.tris, z, inv); if (Math.abs(a - s) > tolSection(s)) { why.push(`Schnitt z=${z}: ${a.toFixed(3)}≠${s.toFixed(3)}`); break; } }
      if (!why.length && !heavy) { const d = maxDistToSurface(verts, v.tris); if (d.worst > DIST_TOL) why.push(`Abstand ${d.worst.toFixed(4)} mm bei ${fmtPt(d.worstPt)}`); else v.maxDist = d.worst; }
    }
    tried.push({ v, why });
    if (!why.length) return { hit: v, tier: 'exakt', tried, dV: r.volume - v.volume, maxDist: v.maxDist };
  }
  // Toleranz-Stufe: nächstgelegene planare Variante (Zählwerte passend), beidseitiger Abstand ≤ 0.01 mm
  if (!heavy) {
    const cand = vs.filter((v) => v.planar && !countsOk(v).length && Number.isFinite(v.volume)).sort((a, b) => Math.abs(r.volume - a.volume) - Math.abs(r.volume - b.volume))[0];
    if (cand && Math.abs(r.volume - cand.volume) <= STEP_UNC * surfArea(cand.tris)) {
      const fwd = maxDistToSurface(verts, cand.tris), bwd = maxDistToSurface(uniquePts(cand.tris), r.otris);
      const worst = Math.max(fwd.worst, bwd.worst);
      if (worst <= STEP_UNC) return { hit: cand, tier: 'toleranz', tried, dV: r.volume - cand.volume, maxDist: worst, worstPt: fwd.worst >= bwd.worst ? fwd.worstPt : bwd.worstPt };
    }
  }
  // Stufe „bogen": der Exporter hat die facettierten Profil-Bögen durch echte Teil-Zylinder/-Kegel
  // ersetzt → das Volumen weicht um das Volumen zwischen Sehnen und Bögen ab (arcDV) und die
  // Oberfläche liegt um die größte Sehnen-Pfeilhöhe (arcSag) daneben. Zulässig, wenn die
  // Abweichung genau diesen Größen entspricht (2·arcDV als Sicherheitsfaktor).
  // Der Kandidat wird NICHT nach dem nächsten Volumen gewählt: die Volumina der Varianten liegen
  // oft dicht beieinander (k1 v2: „Rundung bleibt“ und „2 von 4 Eckrundungen scharf“ unterscheiden
  // sich um 0.05 mm³, das Volumen allein entscheidet also nicht). Stattdessen kommen ALLE planaren
  // Varianten mit passenden Zählwerten und einem Volumen in der Bogen-Toleranz infrage; es gewinnt
  // die mit dem KLEINSTEN beidseitigen Abstand (Stresskörper: nur Volumen, kein Abstand).
  if (r.arcCyl + r.arcCones > 0) {
    const cands = vs.filter((v) => v.planar && !countsOk(v).length && Number.isFinite(v.volume)
      && Math.abs(r.volume - v.volume) <= 2 * r.arcDV + tolPlanar(v.volume));
    if (cands.length) {
      if (heavy) {
        const cand = cands.slice().sort((a, b) => Math.abs(r.volume - a.volume) - Math.abs(r.volume - b.volume))[0];
        return { hit: cand, tier: 'bogen', tried, dV: r.volume - cand.volume, maxDist: undefined };
      }
      let best = null;
      for (const cand of cands) {
        const fwd = maxDistToSurface(verts, cand.tris), bwd = maxDistToSurface(uniquePts(cand.tris), r.otris);
        const worst = Math.max(fwd.worst, bwd.worst);
        if (!best || worst < best.worst) best = { cand, worst, worstPt: fwd.worst >= bwd.worst ? fwd.worstPt : bwd.worstPt };
      }
      if (best && best.worst <= r.arcSag + STEP_UNC) {
        return { hit: best.cand, tier: 'bogen', tried, dV: r.volume - best.cand.volume, maxDist: best.worst, worstPt: best.worstPt };
      }
    }
  }
  return { hit: null, tier: null, tried };
}

async function checkBody(body, occt) {
  // Körper mit `bends` (Blechprofil mit Biege-Bögen): der AN-Lauf muss die Biegungen RUND lassen
  // (Soll-Variante „Rundung bleibt“, Bögen als Teil-Zylinder) — der Zusatz-Lauf AN+B
  // (sharpenBends: true) muss sie SCHARF machen (Soll = Rohprofil). Der v2-isoliert-Lauf kennt
  // keine Primitive (keine Biegungs-Erkennung) → dort frei.
  const hasBends = !!body.bends;
  // Können die Biegungen dieses Körpers überhaupt geschärft werden? Default ja. Ausnahme: Körper,
  // an denen keine Entrundung die Biegung schärfen kann (p4/p6: Stirnseiten gefast) — dort ist
  // `expect.bendsSharpenable: false` gesetzt und der AN+B-Lauf darf „Rundung bleiben“ liefern.
  const bendsSharpenable = body.expect.bendsSharpenable !== false;
  const out = { id: body.id, file: body.file, desc: body.desc, expect: body.expect.mode, hasBends, problems: [], notes: [] };
  const tris = buildMesh(body);
  const man = checkManifold(tris);
  out.tris = tris.length;
  if (!man.ok) out.problems.push(`Generator: Netz nicht manifold (${man.badEdges} Kanten, ${man.degenerate} entartet)`);
  if (body.bends) {
    // Biege-Paare: Innen- und Außenbogen müssen konzentrisch sein (sonst ungleiche Wandstärke)
    try { bendsConcentric(body.bends.pts, body.bends.radii, body.bends.t); }
    catch (e) { out.problems.push(`Generator: Biege nicht konzentrisch (${e.message})`); }
  }
  const buf = toBinaryStl(tris, body.file);
  const mesh = parseStl(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), () => {});
  let vMesh = 0; for (const f of mesh.faces) vMesh += triVolume(...f.vertices);
  out.vMesh = vMesh;

  const { groups, stats, ms } = pipeline(mesh);
  out.recogMs = ms; out.recog = { groups: groups.length, bores: stats.bores, fillets: stats.fillets };
  // v2 isoliert: Gruppen-Kopien ohne Primitive → kein Bohrungs-/v1-Pfad, nur defeatureBands
  const groupsIso = groups.map((g) => ({ ...g, primitive: undefined }));

  const run = (defeature, gs, extra = {}) => {
    const t0 = performance.now();
    const res = buildVolumeStepBrepV2({ normalGroups: gs, defeature, ...extra });
    const exportMs = performance.now() - t0;
    if (!res) return { exported: false, exportMs };
    const r = res.report;
    const parsed = quiet(() => occt.ReadFile('step', new Uint8Array(Buffer.from(res.step)), OCCT_PARAMS));
    const otris = parsed.success ? occtTris(parsed) : [];
    return {
      exported: true, exportMs, faces: r.faceCount, watertight: r.watertight,
      boundaryEdges: r.boundaryEdges, nonManifoldEdges: r.nonManifoldEdges, orientationDefects: r.orientationDefects,
      bores: r.boresConverted, fillets: r.filletsDefeatured ?? 0, bands: r.bandsDefeatured ?? 0, fallbackStage: r.fallbackStage,
      corners: r.cornersDefeatured ?? 0, coneBands: r.coneBandsDefeatured ?? 0, bendsKept: r.bendsKept ?? 0,
      cyl: (res.step.match(/CYLINDRICAL_SURFACE\(/g) || []).length,
      cones: (res.step.match(/CONICAL_SURFACE\(/g) || []).length,
      // Bogen-Flächen des Exporters (Profil-Bögen → Teil-Zylinder/-Kegel): arcCylinders/arcCones
      // zählen die Flächen, arcMaxSagitta die größte Sehnen-Pfeilhöhe der ersetzten Facetten (mm),
      // arcVolumeDelta das Volumen zwischen Sehnen und Bögen (mm³). Liefert der Exporter sie noch
      // nicht, sind sie 0.
      arcCyl: r.arcCylinders ?? 0, arcCones: r.arcCones ?? 0,
      arcSag: r.arcMaxSagitta ?? 0, arcDV: r.arcVolumeDelta ?? 0,
      occt: !!parsed.success, occtMeshes: (parsed.meshes || []).length,
      volume: otris.length ? meshVolume(otris) : NaN, otris, step: res.step,
      strict: checkStepStrict(res.step, { folds: true }).violations.map((v) => v.kind),
    };
  };
  const off = run(false, groups);
  const on = run(true, groups);
  // AN + Biegungen schärfen (Schalter „Blech-Biegungen schärfen“): die Biegungen werden wie bisher
  // geschärft (Soll = Rohprofil). Nur für Körper mit Biegungen sinnvoll.
  const onB = hasBends ? run(true, groups, { sharpenBends: true }) : null;
  const iso = run(true, groupsIso);
  const strip = (r) => (r ? { ...r, otris: undefined, step: undefined } : null);
  out.off = strip(off); out.on = strip(on); out.iso = strip(iso);
  if (onB) out.onB = strip(onB);

  // ── Universelle Pflichten ──
  for (const [tag, r] of [['AUS', off], ['AN', on], ['AN+B', onB], ['v2', iso]]) {
    if (!r) continue;
    if (!r.exported) { out.problems.push(`${tag}: Export lieferte null`); continue; }
    if (!r.watertight) out.problems.push(`${tag}: nicht wasserdicht (Rand ${r.boundaryEdges}, non-manifold ${r.nonManifoldEdges}, Orientierung ${r.orientationDefects})`);
    if (r.orientationDefects) out.problems.push(`${tag}: ${r.orientationDefects} Orientierungsfehler`);
    if (!r.occt) out.problems.push(`${tag}: occt parst die STEP nicht`);
    else if (r.occtMeshes !== 1) out.problems.push(`${tag}: occt liefert ${r.occtMeshes} Netze statt 1`);
    if (r.strict.length) { const k = {}; for (const v of r.strict) k[v] = (k[v] || 0) + 1; out.problems.push(`${tag}: ${r.strict.length} Verstöße gegen strikte Importer (tests/step-strict.mjs) ${JSON.stringify(k)}`); }
  }
  const limit = Math.max(EXPORT_LIMIT_MS, 3 * (off.exportMs || 0));
  if (on.exported && on.exportMs > limit) out.problems.push(`AN: Export ${Math.round(on.exportMs)} ms > ${Math.round(limit)} ms`);
  // „Soll ist Überspringen“: im v2-isoliert-Lauf zählen die Bänder einer Blech-Biegung nicht — ohne
  // Primitive gibt es keine Biegungs-Erkennung, der Lauf schärft sie (dort frei, s. u.).
  const isoBands = hasBends ? 0 : iso.bands;
  if (body.expect.mode === 'skip' && (on.bands || isoBands)) out.problems.push(`v2 hat ${Math.max(on.bands, isoBands)} Band/Bänder entfernt, Soll ist Überspringen`);
  // v1-Soll (Anzahl entfernter Kanten-Verrundungen): weniger = Rückfall/Fehlschlag, mehr = unerwartet
  if (body.expect.fillets !== undefined && on.exported && on.fillets !== body.expect.fillets) out.problems.push(`AN: v1 entfernt ${on.fillets} Verrundung(en), Soll ${body.expect.fillets} (fallbackStage ${on.fallbackStage})`);
  // Soll-Bohrungszahl: die Bohrung muss umgewandelt werden (Zylinder + Kegel) — sonst Orientierungs-
  // fehler (Mündungs-Kegel über Kreuz dem falschen Rand zugeordnet → alles facettiert).
  if (body.expect.bores !== undefined && on.exported && on.bores !== body.expect.bores) out.problems.push(`AN: ${on.bores} Bohrung(en) umgewandelt, Soll ${body.expect.bores} (fallbackStage ${on.fallbackStage})`);
  // Soll-Zahl der Bogen-Flächen im AN-Export (Teil-Zylinder + Teil-Kegel aus den Profil-Bögen):
  // Abweichung = Problem. Der AN-Lauf darf die Bögen nicht verlieren — der Kreis-Rand-Loop einer
  // Bohrung in derselben Deckfläche (Kabelhalter-Befund) verwarf sonst ALLE Gravur-Bögen.
  if (body.expect.arcsOn !== undefined && on.exported) {
    const n = on.arcCyl + on.arcCones;
    if (n !== body.expect.arcsOn) out.problems.push(`AN: ${n} Bogen-Flächen, Soll ${body.expect.arcsOn} (fallbackStage ${on.fallbackStage})`);
  }
  // Höchstzahl der Flächen (AUS/AN): zerfällt eine Fläche in Einzel-Dreiecke (Pinch-Rückfall:
  // berührende Ränder können von occt nicht trianguliert werden), entstehen Hunderte Flächen —
  // das ist ein Fehler, kein Zufall (s. expect.maxFaces im Körper).
  if (body.expect.maxFaces !== undefined) {
    for (const [tag, r] of [['AUS', off], ['AN', on]]) {
      if (r && r.exported && r.faces > body.expect.maxFaces) out.problems.push(`${tag}: ${r.faces} Flächen, Soll ≤ ${body.expect.maxFaces}`);
    }
  }
  // Fallback verwirft v2: allein schärft v2 wasserdicht, in der vollen Pipeline ist alles facettiert.
  // Bei Körpern mit Biegungen darf das nicht gemeldet werden: der isolierte Lauf kennt keine
  // Primitive (keine Biegungs-Erkennung) und schärft die Biegung deshalb — der AN-Lauf lässt sie
  // per Default rund.
  if (!hasBends && iso.watertight && iso.bands > 0 && on.bands === 0 && on.bores === 0 && on.fillets === 0) {
    out.problems.push(`Fallback verwirft v2: v2 allein entfernt ${iso.bands} Band/Bänder wasserdicht, volle Pipeline liefert alles facettiert (Ursache außerhalb defeatureBands: ein anderer Schritt öffnet die Hülle → globaler Fallback)`);
  }

  // ── Basislinie AUS: muss das Netz wiedergeben ──
  const heavy = tris.length > 20000;
  const inv = body.transform ? makeTransform(body.transform).inverse : null;
  const heights = body.sections || defaultSections(body);
  // AUS mit Bogen-Flächen und sonst KEINEN analytischen Flächen: der Exporter hat die facettierten
  // Profil-Bögen durch echte Teil-Zylinder/-Kegel ersetzt → das Volumen weicht um das Bogen-Volumen
  // ab (arcDV) und die Oberfläche liegt um die Sehnen-Pfeilhöhe (arcSag) daneben.
  const hasArcs = off.exported && (off.arcCyl + off.arcCones > 0);
  const arcOnly = off.exported && (off.cyl - off.arcCyl === 0) && (off.cones - off.arcCones === 0);
  if (off.exported && off.occt && off.otris.length) {
    const tol = (off.cyl || off.cones) ? (arcOnly ? tolPlanar(vMesh) + 2 * off.arcDV : tolAnalytic(vMesh)) : tolPlanar(vMesh);
    const distLimit = (arcOnly ? off.arcSag : 0) + STEP_UNC;
    if (Math.abs(off.volume - vMesh) > tol) {
      const meshTris = f32(tris);
      const d = heavy ? null : Math.max(maxDistToSurface(uniquePts(off.otris), meshTris).worst, maxDistToSurface(uniquePts(meshTris), off.otris).worst);
      const msg = `AUS: STEP-Volumen ${off.volume.toFixed(3)} ≠ Netz ${vMesh.toFixed(3)} (Δ ${(off.volume - vMesh).toFixed(3)}${d !== null ? `, max. Abstand ${d.toFixed(4)} mm` : ''})`;
      if (d !== null && d <= distLimit) out.notes.push(msg + ` — innerhalb ${distLimit.toFixed(3)} mm (${hasArcs ? 'Bogen-Pfeilhöhe + ' : ''}Planar-Toleranz des Region-Growing, nicht v2)`);
      else out.problems.push(msg);
    }
  }
  // Erwartete Zahl der Bogen-Flächen im AUS-Export (Teil-Zylinder + Teil-Kegel aus Profil-Bögen)
  if (body.expect.arcsOff !== undefined && off.exported && (off.arcCyl + off.arcCones) < body.expect.arcsOff) {
    out.problems.push(`AUS: ${off.arcCyl + off.arcCones} Bogen-Flächen, Soll ≥ ${body.expect.arcsOff}`);
  }
  // Biegungen bleiben rund (AN, Schalter AUS): die Profil-Bögen müssen auch im AN-Export als echte
  // Teil-Zylinder/-Kegel dastehen (nicht geschärft sein).
  if (hasBends && body.expect.arcsOff !== undefined && on.exported && (on.arcCyl + on.arcCones) < body.expect.arcsOff) {
    out.problems.push(`AN: ${on.arcCyl + on.arcCones} Bogen-Flächen, Soll ≥ ${body.expect.arcsOff} (Biegungen müssen rund bleiben)`);
  }

  // ── AN, AN+B und v2 isoliert je einer zulässigen Variante zuordnen ──
  const planarVs = variantsFor(body, vMesh, heavy);
  const ctx = { heights, inv, heavy };
  const MATCH_KEY = { 'AN': 'onMatch', 'AN+B': 'onBMatch', 'v2': 'isoMatch' };
  for (const [tag, r] of [['AN', on], ['AN+B', onB], ['v2', iso]]) {
    if (!r || !(r.exported && r.occt && r.otris.length)) continue;
    // Netz-Prüfling (z5): geprüft wird die AUS-Seite (Flächenzahl, Bögen); die AN-Schärfung einer
    // Profil-Rundung MIT Fasen bildet variantsFor nicht ab → AN-Geometrie frei (Pflichten oben gelten).
    if (body.expect.anFree && tag !== 'v2') { out.notes.push(`${tag}: Geometrie frei (anFree)`); continue; }
    if (tag === 'v2' && hasBends) {
      // v2 isoliert: die Gruppen-Kopien tragen keine Primitive → keine Biegungs-Erkennung → der
      // Lauf schärft die Biegungen (anders als der AN-Lauf). Frei, nur die Pflichten oben.
      out.isoMatch = { match: null, tier: null, target: false };
      out.isoFree = true;
      out.notes.push('v2 isoliert: ohne Primitive keine Biegungs-Erkennung, frei');
      continue;
    }
    const vs = planarVs.slice();
    // Soll-Variante der geschärften Biegung: das scharfe Rohprofil (bends.pts), Volumen = Fläche × Höhe
    const bs = (tag !== 'v2') ? bendsSharpVariant(body) : null;
    if (bs) vs.push(bs);
    if (tag === 'AN' && body.boreChamfer) {
      vs.push(boreSharpVariant(body, body.boreChamfer, r.step, roundedPairs(body).length));
      for (const b of body.boreChamfer) vs.push(boreVariant(body, b, r.step, roundedPairs(body).filter((p) => p.c !== b.col).length));
    }
    if (tag === 'AN' && !body.boreChamfer) { const mv = mantleSharpVariant(body, r.step); if (mv) vs.push(mv); }
    if (tag === 'AN' && body.countersink) {
      for (const c of body.countersink) { const cv = cskVariant(body, c, r.step, roundedPairs(body).filter((p) => p.c !== c.col).length); if (cv) vs.push(cv); }
    }
    if (tag === 'AN' && body.countersinkBoth) {
      for (const c of body.countersinkBoth) { const cv = cskBothVariant(body, c, r.step, roundedPairs(body).filter((p) => p.c !== c.col).length); if (cv) vs.push(cv); }
    }
    if (tag === 'AN' && body.holes) vs.push(holesVariant(body, r.step, roundedPairs(body).length));
    const m = matchVariants(r, vs, ctx);
    const res = { match: m.hit ? m.hit.label : null, tier: m.tier, target: m.hit ? m.hit.target : false, dV: m.dV, maxDist: m.maxDist };
    out[MATCH_KEY[tag]] = res;
    if (tag === 'AN') {
      const main = m.hit || vs.find((v) => v.target) || vs[0];
      out.vSoll = main.volume;
      out.sections = heights.map((z) => ({ z, step: sectionArea(r.otris, z, inv), soll: main.tris ? sectionArea(main.tris, z, inv) : NaN, round: sectionArea(tris, z, inv) }));
    }
    if (!m.hit) {
      const tgt = vs.filter((v) => v.target).map((v) => `${v.label}: V=${v.volume.toFixed(3)}`).join(' | ');
      const nearest = m.tried.slice().sort((a, b) => a.why.length - b.why.length || Math.abs(r.volume - a.v.volume) - Math.abs(r.volume - b.v.volume))[0];
      out.problems.push(`${tag}: falsche Geometrie — keine zulässige Variante; beobachtet bands=${r.bands} fillets=${r.fillets} bores=${r.bores} cones=${r.cones} V=${r.volume.toFixed(3)}; Ziel ${tgt}; nächste: „${nearest.v.label}“ (${nearest.why.join('; ')})`);
    } else {
      if (m.tier === 'toleranz') out.notes.push(`${tag}: „${m.hit.label}” nur innerhalb 0.01 mm (ΔV ${m.dV.toFixed(3)}, max. Abstand ${m.maxDist.toFixed(4)} mm bei ${fmtPt(m.worstPt)})`);
      if (m.tier === 'bogen') out.notes.push(`${tag}: „${m.hit.label}” mit exakten Bögen (Pfeilhöhe ≤ ${r.arcSag.toFixed(4)} mm, ΔV ${m.dV.toFixed(3)} mm³)`);
      if (!m.hit.target) out.notes.push(`${tag}: sicher, aber Ziel verfehlt: „${m.hit.label}” (bands=${r.bands}, fillets=${r.fillets})`);
    }
    // AN+B (Schalter „Blech-Biegungen schärfen“): die Biegungen müssen SCHARF sein (Soll = Rohprofil).
    // Der Treffer kann unter einem anderen Etikett laufen (z.B. „Profilecken scharf (v2b)“, das
    // dieselbe Kontur hat) → deshalb über das Volumen vergleichen, nicht über die Identität.
    if (tag === 'AN+B' && hasBends && bs) {
      const hitBs = m.hit === bs || (m.hit && Math.abs(m.hit.volume - bs.volume) <= bs.tol(bs.volume));
      if (bendsSharpenable && !hitBs) {
        out.problems.push(`AN+B: Biegungen sind nicht scharf (${m.hit ? `„${m.hit.label}”` : 'keine passende Variante'}) — Soll „${bs.label}“ (V=${bs.volume.toFixed(3)})`);
      } else if (!bendsSharpenable && !hitBs && m.hit) {
        out.notes.push(`AN+B: Biegung bleibt rund („${m.hit.label}“) — bei diesem Körper kann keine Entrundung die Biegung schärfen (expect.bendsSharpenable: false)`);
      }
    }
  }
  return out;
}

// Standard-Schnitthöhen: in jeder Rundungs-/Fasenzone (0.37·r von der Deckfläche) + Säulenmitte;
// Senkung: mitten im Kegel und in der Kanten-Rundung
function defaultSections(body) {
  const zs = new Set();
  for (const col of body.columns) {
    zs.add(+((col.z0 + col.z1) / 2 + 0.0137).toFixed(4));
    for (const end of ['bottom', 'top']) {
      const s = col[end];
      if (!s || s.kind === 'sharp') continue;
      const at = (u) => zs.add(+(end === 'bottom' ? col.z0 + u : col.z1 - u).toFixed(4));
      if (s.kind === 'countersink') { at(0.5 * s.depth + 0.0137); if (s.r > 0) at(0.37 * s.r); continue; }
      at(0.37 * s.r);
    }
  }
  return [...zs].sort((a, b) => a - b);
}

const occt = await getOcct();
const results = [];
for (const body of [...BODIES, ...STRESS]) {
  if (only && !only.includes(body.id)) continue;
  if (quick && body.extra) continue;
  let r;
  try { r = await checkBody(body, occt); } catch (e) { r = { id: body.id, file: body.file, problems: [`Ausnahme: ${e.stack || e}`], notes: [] }; }
  results.push(r);
}

if (asJson) {
  origLog(JSON.stringify(results, null, 2));
} else {
  const f = (x, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : '-');
  const tierTxt = (m, free) => (free ? 'frei' : !m ? '-' : !m.match ? 'FALSCH' : m.tier === 'toleranz' ? '≤0.01' : m.tier === 'bogen' ? 'bogen' : 'exakt');
  // Bogen-Flächen (Teil-Zylinder + Teil-Kegel aus den Profil-Bögen) je Export
  const arcTxt = (r) => `${String(r.arcCyl ?? 0).padStart(2)}+${String(r.arcCones ?? 0).padStart(2)}`;
  origLog('id     Soll  tris  | AN: bands fil bore cone  wt   faces(AN/AUS) | Bögen AN/AUS | AN+B: bands fil wt geom | v2 allein: bands wt  geom  |  V_soll      V_STEP(AN)    ΔV     | recog exp-AN exp-AUS ms | Ergebnis');
  for (const r of results) {
    const on = r.on || {}, off = r.off || {}, iso = r.iso || {}, onB = r.onB || {};
    const verdict = r.problems.length ? 'VERLETZT' : r.notes.length ? 'OK*' : 'OK';
    const bTxt = r.onB ? `${String(onB.bands ?? '-').padStart(5)} ${String(onB.fillets ?? '-').padStart(3)} ${String(onB.watertight).padEnd(5)} ${tierTxt(r.onBMatch, false).padEnd(6)}` : '    -   -    -    -   ';
    origLog(
      `${r.id.padEnd(6)} ${String(r.expect || '').padEnd(5)} ${String(r.tris ?? '-').padStart(5)} |    ${String(on.bands ?? '-').padStart(5)} ${String(on.fillets ?? '-').padStart(3)} ${String(on.bores ?? '-').padStart(4)} ${String(on.cones ?? '-').padStart(4)}  ${String(on.watertight).padEnd(5)} ${String(on.faces ?? '-').padStart(5)}/${String(off.faces ?? '-').padEnd(6)} | ${arcTxt(on)}/${arcTxt(off)} |${bTxt} |       ${String(iso.bands ?? '-').padStart(5)} ${String(iso.watertight).padEnd(5)} ${tierTxt(r.isoMatch, r.isoFree).padEnd(6)} | ${f(r.vSoll, 3).padStart(11)} ${f(on.volume, 3).padStart(11)} ${f(on.volume - r.vSoll, 3).padStart(9)} | ${f(r.recogMs, 0).padStart(5)} ${f(on.exportMs, 0).padStart(6)} ${f(off.exportMs, 0).padStart(7)}    | ${verdict}${r.onMatch?.match ? ' – ' + r.onMatch.match + (r.onMatch.tier === 'toleranz' ? ' (≤0.01 mm)' : r.onMatch.tier === 'bogen' ? ' (Bögen exakt)' : '') : ''}${r.onBMatch?.match ? ' | AN+B: ' + r.onBMatch.match : ''}`);
  }
  for (const r of results) {
    if (!r.sections || !(r.problems.length || r.id.startsWith('g'))) continue;
    origLog(`\n[${r.id}] Schnittflächen z | STEP (AN) | Soll/Variante | Netz gerundet:`);
    for (const s of r.sections) origLog(`  z=${String(s.z).padEnd(7)} ${s.step.toFixed(3).padStart(10)} | ${f(s.soll, 3).padStart(10)} | ${s.round.toFixed(3).padStart(10)}`);
  }
  const bad = results.filter((r) => r.problems.length);
  const notes = results.filter((r) => r.notes?.length);
  if (notes.length) { origLog('\nHinweise (OK*):'); for (const r of notes) for (const n of r.notes) origLog(`  [${r.id}] ${n}`); }
  if (bad.length) {
    origLog(`\n❌ ${bad.length} Körper mit Soll-Verletzung:`);
    for (const r of bad) for (const p of r.problems) origLog(`  [${r.id}] ${p}`);
  } else origLog('\n✅ alle Körper im Soll');
}
process.exit(results.some((r) => r.problems.length) ? 1 : 0);

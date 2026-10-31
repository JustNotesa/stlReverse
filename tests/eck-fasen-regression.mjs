// ─────────────────────────────────────────────────────────────────────────────
// Eck-Fasen-Regression — senkrechte Profil-Eckrundungen, die oben/unten an einer
// FASE enden.
//
// Zweck: eine senkrechte Eckrundung im Profil (Rundrechteck), die an einer Fase
// endet, soll mit Defeaturing AN und „Biegungen … rund lassen“ AUS (sharpenBends) scharf werden
// (im Standard bleiben Box-Ecken gleicher Wandstärke rund — `pairs` = erwartete Zahl rund gelassener Bögen): die Wände treffen sich in einer
// senkrechten Kante, die Fasen laufen in einer Gehrung um die Ecke. Ohne Fase
// (scharfe Deckkanten) gilt das schon heute. AUS bleibt immer rund.
//
// Körper (Maße in mm, Profile CCW = Material links; Loch-/Taschen-Profile CW):
//   1 platte-fase         Säule rr(0,0,60,40,5,8), z 0…20, unten+oben ch(1.5)
//   2 platte-fase-unten   wie 1, oben scharf, unten ch(2)
//   3 schale              Box mit Tasche (Tasche offen oben, unten Hohlkehle)
//   4 schale-ohne-fase    wie 3, aber ohne Fasen (Kontrollkörper — heute schon scharf)
//   5 formschraege        Formschräge 2° + Deckrundung (nur Regression, kein Soll)
// Jeder Körper liegt in 4 Lagen (verschoben / gedreht) — der Export muss in JEDER
// Lage dasselbe Ergebnis liefern.
//
// Prüfung je Körper × Lage:
//   AN und AUS : Export != null, report.watertight, report.solids == 1,
//                 checkStepStrict(step).violations.length == 0
//   Volumen     : V_netz  = gen.meshVolume(gen.buildMesh(body + Lage))
//                 V_soll  = gen.bodyVolume(soll + Lage)          (ohne Soll: –)
//                 V_AN/V_AUS aus dem STEP (occt wie tests/fixtures-v2/check.mjs)
//     AN  mit Soll: „scharf“  wenn |V_AN − V_soll| ≤ 0.02 + 1e-5·V_soll
//                   „rund“   wenn |V_AN − V_netz| ≤ 0.5 (+ Bogen-Abweichung, s. u.)
//                   sonst FEHLER „falsche Geometrie“
//     AUS          |V_AUS − V_netz| ≤ 0.5 + 1e-4·V_netz (+ Bogen-Abweichung)
//   Erwartung    : expectAn je Körper — 1…4 „scharf“, 5 „egal“ (bei Abweichung FEHLER)
//
// Bogen-Abweichung: der Exporter wandelt facettierte Profil-Bögen in echte
// Teil-Zylinder/-Kegel um (profile-arcs.js). Der STEP enthält dann den EXAKTEN
// Bogen, das Netz nur die Sehnen — das Volumen weicht um `report.arcVolumeDelta`
// ab (gleicher Weg wie tests/fixtures-v2/check.mjs: Toleranz + 2·arcVolumeDelta).
// Ohne diese allowances würde die AUS-Prüfung jeden Körper mit umgewandelten Bögen
// als Volumenfehler melden.
//
// Aufruf:  node tests/eck-fasen-regression.mjs [--body <id>] [--verbose] [--soft3]
//           --soft3: Körper 3 (schale) gilt als „egal“ (nur Ausgabe, keine Fehler)
// Exit 1 bei FEHLER, sonst 0.
// ─────────────────────────────────────────────────────────────────────────────
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';
import { createRequire } from 'module';

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

const require = createRequire(import.meta.url);
const { getOcct } = require('./occt-check.cjs');

// Feine occt-Tessellierung (wie tests/fixtures-v2/check.mjs) — analytische
// Zylinder/Kegel sonst zu grob.
const OCCT_PARAMS = { linearUnit: 'millimeter', linearDeflectionType: 'absolute_value', linearDeflection: 0.001, angularDeflection: 0.02 };

// ── Argumente ───────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const only = args.includes('--body') ? args[args.indexOf('--body') + 1] : null;
const verbose = args.includes('--verbose');
const soft3 = args.includes('--soft3');

// ── Hilfen ──────────────────────────────────────────────────────────────────
const ch = (r) => ({ kind: 'chamfer', r });
const R = (r, N = 6) => ({ kind: 'round', r, N });
const cc = (r, N = 6) => ({ kind: 'concave', r, N });
const sharp = { kind: 'sharp' };
// Rundrechteck-Profil: Rechteck (x0,y0,w,h) mit Eckrundung r (seg Segmente je Bogen)
const rr = (x0, y0, w, h, r, seg) => gen.filletedPolygon(gen.rectProfile(x0, y0, w, h), [r, r, r, r], seg);

const POSES = [
  {}, { t: [120, -75, 40] }, { rot: [23, 37, 11], t: [-60, 80, 15] }, { rot: [90, 0, 0] },
];

// Schale: Deckflächen — oben mit Taschenöffnung, unten der Boden, plus der Taschenboden
const SCHALE_CAPS = [
  { up: true, outer: { c: 0, end: 'top' }, holes: [{ c: 1, end: 'top' }] },
  { up: false, outer: { c: 0, end: 'bottom' }, holes: [] },
  { up: true, outer: { c: 1, end: 'bottom', rev: true }, holes: [] },   // Taschenboden
];

const BODIES = [
  {
    id: 'platte-fase', expectAn: 'scharf', pairs: 0,
    desc: 'Säule 60×40, Eckrundung R5 (8 Seg.), z 0…20, unten+oben 1.5×45°-Fase',
    columns: [{ name: 'platte', profile: rr(0, 0, 60, 40, 5, 8), z0: 0, z1: 20, bottom: ch(1.5), top: ch(1.5) }],
    // Soll AN: Ecken scharf (Fasen bleiben)
    soll: {
      columns: [{ name: 'platte', profile: gen.rectProfile(0, 0, 60, 40), z0: 0, z1: 20, bottom: ch(1.5), top: ch(1.5) }],
    },
  },
  {
    id: 'platte-fase-unten', expectAn: 'scharf', pairs: 0,
    desc: 'wie platte-fase, aber nur unten gefast (ch 2), oben scharf',
    columns: [{ name: 'platte', profile: rr(0, 0, 60, 40, 5, 8), z0: 0, z1: 20, bottom: ch(2), top: sharp }],
    soll: {
      columns: [{ name: 'platte', profile: gen.rectProfile(0, 0, 60, 40), z0: 0, z1: 20, bottom: ch(2), top: sharp }],
    },
  },
  {
    id: 'schale', expectAn: 'scharf', pairs: 8,
    desc: 'Box 80×50×25 (Eckrundung R6) mit Tasche 72×42 (Eckrundung R3) von oben, unten Hohlkehle 1.5',
    columns: [
      { name: 'aussen', profile: rr(0, 0, 80, 50, 6, 8), z0: 0, z1: 25, bottom: ch(1.5), top: sharp },
      { name: 'tasche', profile: rr(4, 4, 72, 42, 3, 8).reverse(), z0: 2, z1: 25, bottom: cc(1.5), top: ch(1) },
    ],
    caps: SCHALE_CAPS,
    // Soll AN: außen + innen Ecken scharf, Bodenrundung scharf (Fasen bleiben)
    soll: {
      columns: [
        { name: 'aussen', profile: gen.rectProfile(0, 0, 80, 50), z0: 0, z1: 25, bottom: ch(1.5), top: sharp },
        { name: 'tasche', profile: gen.rectProfile(4, 4, 72, 42).reverse(), z0: 2, z1: 25, bottom: sharp, top: ch(1) },
      ],
      caps: SCHALE_CAPS,
    },
  },
  {
    id: 'schale-ohne-fase', expectAn: 'scharf', pairs: 8,
    desc: 'wie schale, aber ohne Fasen (Säule 0 unten scharf, Säule 1 oben scharf) — Kontrollkörper',
    columns: [
      { name: 'aussen', profile: rr(0, 0, 80, 50, 6, 8), z0: 0, z1: 25, bottom: sharp, top: sharp },
      { name: 'tasche', profile: rr(4, 4, 72, 42, 3, 8).reverse(), z0: 2, z1: 25, bottom: cc(1.5), top: sharp },
    ],
    caps: SCHALE_CAPS,
    soll: {
      columns: [
        { name: 'aussen', profile: gen.rectProfile(0, 0, 80, 50), z0: 0, z1: 25, bottom: sharp, top: sharp },
        { name: 'tasche', profile: gen.rectProfile(4, 4, 72, 42).reverse(), z0: 2, z1: 25, bottom: sharp, top: sharp },
      ],
      caps: SCHALE_CAPS,
    },
  },
  {
    id: 'formschraege', expectAn: 'egal',
    desc: 'Säule 40×30, Eckrundung R4, Formschräge 2°, oben Deckrundung R1.5 — nur Regression (kein Soll)',
    columns: [{ name: 'platte', profile: rr(0, 0, 40, 30, 4, 8), z0: 0, z1: 15, draftDeg: 2, bottom: sharp, top: R(1.5) }],
    soll: null,
  },
];

// ── Ausgabe-Hilfen ──────────────────────────────────────────────────────────
const log = console.log;
const quiet = (fn) => { console.log = () => {}; try { return fn(); } finally { console.log = log; } };
const quietAsync = async (fn) => { console.log = () => {}; try { return await fn(); } finally { console.log = log; } };
const fmt = (x, d = 3) => (Number.isFinite(x) ? x.toFixed(d) : '-');
const faceCount = (r) => (r ? (r.step.match(/ADVANCED_FACE\(/g) || []).length : -1);

// occt-Netz → Dreiecke (3D-Punkte) — wie tests/fixtures-v2/check.mjs
function occtTris(result) {
  const tris = [];
  for (const m of result.meshes || []) {
    const p = m.attributes.position.array, ix = m.index.array;
    const P = (i) => [p[3 * i], p[3 * i + 1], p[3 * i + 2]];
    for (let i = 0; i < ix.length; i += 3) tris.push([P(ix[i]), P(ix[i + 1]), P(ix[i + 2])]);
  }
  return tris;
}

const occt = await getOcct();
// Volumen des Exports aus dem STEP (Divergenzsatz über das occt-Netz)
async function stepVolume(step) {
  let r;
  try {
    r = await quietAsync(() => occt.ReadFile('step', new Uint8Array(Buffer.from(step)), OCCT_PARAMS));
  } catch (e) {
    return { ok: false, V: NaN, why: e.message };
  }
  if (!r || !r.success) return { ok: false, V: NaN };
  const tris = occtTris(r);
  if (!tris.length) return { ok: false, V: NaN };
  return { ok: true, V: gen.meshVolume(tris) };
}

// Strict-Prüfung (Verstöße je Export)
function strictOf(step) {
  try { return checkStepStrict(step).violations; } catch (e) { return [{ kind: 'Ausnahme', msg: e.message }]; }
}

// ── Prüfung ─────────────────────────────────────────────────────────────────
const errors = [];
let bad = 0;

for (const body of BODIES) {
  if (only && body.id !== only) continue;
  const expect = soft3 && body.id === 'schale' ? 'egal' : body.expectAn;
  log(`── ${body.id}  (erwartet AN: ${expect})`);
  log(`   ${body.desc}`);

  for (const pose of POSES) {
    const why = [];
    const poseTxt = JSON.stringify(pose);

    // Netz + Volumen des Netzes (Soll: der Körper mit scharfen Ecken)
    const tris = gen.buildMesh({ ...body, transform: pose });
    const Vnet = gen.meshVolume(tris);
    const Vsoll = body.soll ? gen.bodyVolume({ ...body.soll, transform: pose }) : NaN;

    // Pipeline: cleanMesh → buildNormalGroups → unifyCoplanarGroups → Primitive → Export
    const stl = gen.toBinaryStl(tris, body.id);
    const ab = stl.buffer.slice(stl.byteOffset, stl.byteOffset + stl.byteLength);
    const out = quiet(() => {
      const cm = cleanMesh(parseStl(ab, () => {}));
      const g = unifyCoplanarGroups(buildNormalGroups(cm.mesh)).unified
        .sort((a, b) => b.vertices.length - a.vertices.length);
      recognizePrimitives(g);
      detectTubes(g);
      return {
        // „AN“ hier = Verrundungen entfernen MIT „Biegungen … rund lassen“ AUS (sharpenBends) — alle Ecken scharf
        an: buildVolumeStepBrepV2({ normalGroups: g, defeature: true, sharpenBends: true }),
        // Standard (Biegungen rund lassen AN): Box-Ecken gleicher Wandstärke bleiben rund
        anStd: buildVolumeStepBrepV2({ normalGroups: g, defeature: true }),
        aus: buildVolumeStepBrepV2({ normalGroups: g, defeature: false }),
        mesh: cm.report,
      };
    });
    const { an, aus, anStd } = out;
    // Standard-AN: dicht, strict sauber; Box-Ecken-Paare (body.pairs) bleiben rund und werden gezählt
    if (!anStd || !anStd.report.watertight || anStd.report.solids !== 1) why.push('AN(Standard): nicht dicht / Solids ≠ 1');
    else {
      const vs = strictOf(anStd.step);
      if (vs.length) why.push(`AN(Standard): ${vs.length} strict-Verstöße`);
      const kept = anStd.report.cornerPairsKept || 0;
      if (body.pairs != null && kept !== body.pairs) why.push(`AN(Standard): ${kept} Box-Ecken rund gelassen, erwartet ${body.pairs}`);
    }

    // Pflichten je Export
    let vAn = 0, vAus = 0;
    for (const [tag, r] of [['AN', an], ['AUS', aus]]) {
      if (!r) { why.push(`${tag}: Export lieferte null`); continue; }
      if (!r.report.watertight) {
        why.push(`${tag}: nicht wasserdicht (Rand ${r.report.boundaryEdges}, non-manifold ${r.report.nonManifoldEdges}, Orientierung ${r.report.orientationDefects})`);
      }
      if (r.report.solids !== 1) why.push(`${tag}: ${r.report.solids} Solids statt 1`);
      const viol = strictOf(r.step);
      if (tag === 'AN') vAn = viol.length; else vAus = viol.length;
      if (viol.length) {
        const k = {};
        for (const v of viol) k[v.kind] = (k[v.kind] || 0) + 1;
        why.push(`${tag}: ${viol.length} strict-Verstöße ${JSON.stringify(k)}`);
      }
    }

    // Volumen der Exporte (aus dem STEP)
    const VAN = an ? await stepVolume(an.step) : { ok: false, V: NaN };
    const VAUS = aus ? await stepVolume(aus.step) : { ok: false, V: NaN };
    const arcAn = an?.report?.arcVolumeDelta ?? 0;      // Bogen-Abweichung (mm³)
    const arcAus = aus?.report?.arcVolumeDelta ?? 0;

    // AUS: das Netz muss wiedergegeben werden (Bogen-Abweichung zugerechnet)
    let dAus = NaN;
    if (aus) {
      if (!VAUS.ok) why.push('AUS: occt parst die STEP nicht');
      else {
        dAus = Math.abs(VAUS.V - Vnet);
        const tolAus = 0.5 + 1e-4 * Math.abs(Vnet) + 2 * Math.abs(arcAus);
        if (dAus > tolAus) {
          why.push(`AUS: Volumen ${VAUS.V.toFixed(3)} ≠ Netz ${Vnet.toFixed(3)} (Δ ${dAus.toFixed(3)} > ${tolAus.toFixed(3)}, Bogen-Abweichung ${arcAus})`);
        }
      }
    }

    // AN: scharf (Soll) oder rund (Netz)?
    let status = 'egal', dSoll = NaN, dNet = NaN;
    if (an) {
      if (!VAN.ok) why.push('AN: occt parst die STEP nicht');
      else {
        dNet = Math.abs(VAN.V - Vnet);
        if (body.soll) {
          dSoll = Math.abs(VAN.V - Vsoll);
          const tolSoll = 0.02 + 1e-5 * Math.abs(Vsoll);
          const tolNet = 0.5 + 2 * Math.abs(arcAn);          // + Bogen-Abweichung
          if (dSoll <= tolSoll) status = 'scharf';
          else if (dNet <= tolNet) status = 'rund';
          else {
            status = 'falsch';
            why.push(`AN: falsche Geometrie — V ${VAN.V.toFixed(3)} (Netz ${Vnet.toFixed(3)}, Soll ${Vsoll.toFixed(3)}): ΔV(soll) ${dSoll.toFixed(3)} > ${tolSoll.toFixed(3)}, ΔV(net) ${dNet.toFixed(3)} > ${tolNet.toFixed(3)}`);
          }
        }
      }
    }
    if (expect !== 'egal' && status !== expect && status !== 'falsch') {
      why.push(`AN: Status „${status}" ≠ erwartet „${expect}"`);
    }

    if (why.length) {
      bad++;
      for (const w of why) errors.push(`[${body.id} / ${poseTxt}] ${w}`);
    }

    const extra = verbose
      ? `  | V_netz ${fmt(Vnet)}  V_soll ${fmt(Vsoll)}  V_AN ${fmt(VAN.V)}  V_AUS ${fmt(VAUS.V)}` +
        `  | Bänder ${an?.report?.bandsDefeatured ?? '-'}  Verrundungen ${an?.report?.filletsDefeatured ?? '-'}` +
        `  Ecken ${an?.report?.cornersDefeatured ?? '-'}  Bögen ${an?.report?.arcCylinders ?? '-'}/${an?.report?.arcCones ?? '-'}` +
        `  BogenΔV ${fmt(arcAn)}  Fallback ${an?.report?.fallbackStage ?? '-'}  ΔV(AUS) ${fmt(dAus)}`
      : '';
    log(`${why.length ? '❌' : '✅'} ${body.id.padEnd(18)} ${poseTxt.padEnd(38)} AN/AUS-Flächen ${String(faceCount(an)).padStart(4)}/${String(faceCount(aus)).padEnd(4)}` +
      `  Status ${status.padEnd(7)}  ΔV(soll) ${fmt(dSoll).padStart(9)}  ΔV(net) ${fmt(dNet).padStart(9)}` +
      `  strict ${String(vAn).padStart(2)}/${String(vAus).padEnd(2)}${extra}`);
  }
  log('');
}

if (errors.length) {
  log(`❌ ${errors.length} Fehler in ${bad} Lagen/Körpern:`);
  for (const e of errors) log('  ' + e);
} else log('✅ alle Prüfungen bestanden');
process.exit(errors.length ? 1 : 0);

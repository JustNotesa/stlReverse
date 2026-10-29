// ─────────────────────────────────────────────────────────────────────────────
// tests/freeform/snap.test.mjs — prüft freeform-snap.js (Schritt 3: Verrundungen
// exakt tangential an ihre Nachbarn legen) an den synthetischen Körpern aus
// tests/freeform/gen.mjs.
//
// Prüfkette je Körper:  STL → indexMesh → segmentByFit (Regionen) → buildTopology
//                       (Ketten) → snapSurfaces (Kopien der Flächen).
//
// Geprüft wird, was nach dem Snap EXAKT gilt (Restfehler ~1e-12):
//   • Rundquader: jeder Zylinder tangentiell zu genau 2 Ebenen
//       |sdist(Ebene, Achsenpunkt)| = R  und  |a·n| = 0
//     jede Kugel: Mittelpunkt auf allen Zylinderachsen, R = deren R
//   • Platte: Torus-Achse parallel zur Bohrungsachse, Mitte auf ihr,
//     Rm = R_Zyl + r, Abstand der Torus-Mitte zur Deckfläche = ±r
//   • Halbkugel: Kugelmittelpunkt auf der Zylinderachse, R = R_Zyl
//
// Toleranzen: Größen, die der Snap EXAKT konstruiert (Tangentialität, R = R),
// werden mit 1e-9/1e-12 geprüft — auch an den gedrehten Körpern. Größen, die
// nur näherungsweise aus zwei unabhängigen Fits folgen (Kugelmittelpunkt auf
// mehreren Achsen, Torus-Achse ‖ Zylinderachse), sind beim gedrehten Körper
// durch das float32-Rauschen der STL (≈1e-6 mm) begrenzt → dort 1e-5.
//
// Die GEDREHTEN Körper werden nur geprüft, wenn die Segmentierung dieselben
// Flächenarten liefert wie der ungedrehte Körper. SegmenTIERT der gedrehte
// Körper anders (bekannter Segmentierungs-Fehler, wird parallel behoben), wird
// der Fall mit "SKIP (segmentation)" übersprungen statt zu scheitern.
//
// Aufruf:  .dev/test-stl.sh ff-snap
// ─────────────────────────────────────────────────────────────────────────────
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseStl } from '../../analysis-core.js';
import { indexMesh, segmentByFit } from '../../freeform-segment.js';
import { buildTopology } from '../../freeform-topology.js';
import { snapSurfaces } from '../../freeform-snap.js';
import { sdist, normalAt, dot, cross, len, sub, add, mul } from '../../freeform-geom.js';

let failed = 0;
const cases = [];
function test(name, fn) { cases.push([name, fn]); }

// ── Toleranzen ──────────────────────────────────────────────────────────────
const EXAKT = 1e-9;      // exakt konstruierte Abstände/Radien
const RICHTUNG = 1e-12;  // exakt konstruierte Richtungen
const GENAU = 1e-9;      // Mittelpunkt auf EINER Achse (exakt projiziert)
const RAUSCH = 1e-5;     // nur durch float32-Rauschen begrenzt

// ── Hilfen ───────────────────────────────────────────────────────────────────

// STL → Netz → Regionen → Topologie → Snap
function loadBody(file) {
  const buf = readFileSync(join('tests/freeform/stl', file));
  const parsed = parseStl(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), () => {});
  const tris = parsed.faces.map((f) => f.vertices);
  const mesh = indexMesh(tris);
  assert.ok(mesh, `${file}: indexMesh lieferte null`);
  const { label, regions } = segmentByFit(mesh);
  const topo = buildTopology(mesh, label);
  const snapRegions = regions.map((r) => ({
    id: r.id,
    kind: r.type === 'facet' ? 'facet' : 'analytic',
    surf: r.surf,
    tris: r.tris,
    area: r.area,
  }));
  const before = JSON.stringify(snapRegions.map((r) => (r.surf ? r.surf : null)));
  const { surfs, log } = snapSurfaces({ mesh, regions: snapRegions, chains: topo.chains });
  return { file, mesh, regions, surfs, log, chains: topo.chains, before, snapRegions };
}

// Flächenarten je Region (für den Vergleich gedreht/ungedreht)
function typeCounts(regions) {
  const c = {};
  for (const r of regions) c[r.type] = (c[r.type] || 0) + 1;
  return Object.keys(c).sort().map((k) => `${k}:${c[k]}`).join(',');
}

// Tangentiale Paare (Winkel der Flächennormalen an den Kettenpunkten, |cos|)
function anglePairs(mesh, surfs, chains) {
  const stats = new Map();
  for (const ch of chains) {
    const sL = surfs.get(ch.L);
    const sR = surfs.get(ch.R);
    if (!sL || !sR) continue;
    let sum = 0;
    let cnt = 0;
    for (const v of ch.mv) {
      const p = [mesh.P[3 * v], mesh.P[3 * v + 1], mesh.P[3 * v + 2]];
      sum += Math.acos(Math.min(1, Math.abs(dot(normalAt(sL, p), normalAt(sR, p)))));
      cnt++;
    }
    if (!cnt) continue;
    const key = ch.L < ch.R ? `${ch.L}|${ch.R}` : `${ch.R}|${ch.L}`;
    let st = stats.get(key);
    if (!st) { st = { L: Math.min(ch.L, ch.R), R: Math.max(ch.L, ch.R), sum: 0, cnt: 0 }; stats.set(key, st); }
    st.sum += sum;
    st.cnt += cnt;
  }
  const out = new Map();
  for (const [k, st] of stats) out.set(k, st);
  return out;
}

// Partner einer Region (nur tangentiale Paare, Winkel < tanDeg)
function partnersOf(pairs, id, surfs, type, tanDeg = 5) {
  const out = [];
  for (const st of pairs.values()) {
    if (st.sum / st.cnt >= tanDeg * Math.PI / 180) continue;
    const other = st.L === id ? st.R : (st.R === id ? st.L : null);
    if (other === null) continue;
    const s = surfs.get(other);
    if (!s) continue;
    if (type && s.type !== type) continue;
    out.push(other);
  }
  return out;
}

// Abstand eines Punktes zur Achse (o, a)
function axisDist(p, o, a) {
  return len(sub(p, add(o, mul(a, dot(sub(p, o), a)))));
}

// Flächen einer Region nach Typ
function byType(surfs, type) {
  const out = [];
  for (const [id, s] of surfs) if (s.type === type) out.push([id, s]);
  out.sort((x, y) => x[0] - y[0]);
  return out;
}

// Tangentiale Ebenen eines Zylinders (geometrisch: Achse parallel zur Ebene,
// Abstand der Achse = R) — nach Richtungen gruppiert, damit eine in mehrere
// Regionen zerschnittene Ebene nur einmal zählt
function tangentPlaneGroups(cyl, planes, tol = 1e-9) {
  // Vorzeichen der Normalen kanonisch (erste wesentliche Komponente +),
  // damit gleiche Ebenen dieselbe Richtung bekommen
  const canonical = (n) => {
    const s = (n[0] < -1e-12) || (Math.abs(n[0]) <= 1e-12 && (n[1] < -1e-12
      || (Math.abs(n[1]) <= 1e-12 && n[2] < 0))) ? -1 : 1;
    return s < 0 ? mul(n, -1) : n;
  };
  const groups = [];
  for (const [pid, p] of planes) {
    if (Math.abs(dot(cyl.a, p.n)) > tol) continue;
    if (Math.abs(Math.abs(sdist(p, cyl.o)) - cyl.R) > tol) continue;
    const n = canonical(p.n);
    const found = groups.find((g) => len(cross(g.n, n)) < 1e-3);
    if (found) found.ids.push(pid);
    else groups.push({ n, ids: [pid] });
  }
  return groups;
}

// ── Prüfungen ────────────────────────────────────────────────────────────────

// Rundquader: Zylinder ↔ 2 Ebenen exakt tangential, Kugel auf den Achsen
function checkBox(body, achseTol) {
  const { mesh, surfs, chains } = body;
  const pairs = anglePairs(mesh, surfs, chains);
  const cyls = byType(surfs, 'cylinder');
  const planes = byType(surfs, 'plane');
  const spheres = byType(surfs, 'sphere');

  for (const [cid, c] of cyls) {
    // Partner aus dem Netz (Winkel der Normalen) — die geometrische Prüfung
    // unten entscheidet dann, ob sie wirklich tangential sind
    const cand = partnersOf(pairs, cid, surfs, 'plane');
    const groups = tangentPlaneGroups(c, planes);
    assert.equal(groups.length, 2,
      `Zylinder ${cid}: ${groups.length} tangentiale Ebenen (Netz-Kandidaten ${cand.join(',')})`);
    for (const g of groups) {
      for (const pid of g.ids) {
        const p = surfs.get(pid);
        const d = Math.abs(sdist(p, c.o));
        assert.ok(Math.abs(d - c.R) < EXAKT,
          `Zylinder ${cid} ↔ Ebene ${pid}: |sdist| = ${d.toFixed(12)} statt R = ${c.R.toFixed(12)}`);
        assert.ok(Math.abs(dot(c.a, p.n)) < RICHTUNG,
          `Zylinder ${cid} ↔ Ebene ${pid}: a·n = ${dot(c.a, p.n).toExponential(3)}`);
      }
    }
  }
  for (const [sid, s] of spheres) {
    const tc = partnersOf(pairs, sid, surfs, 'cylinder');
    for (const cid of tc) {
      const c = surfs.get(cid);
      const d = axisDist(s.c, c.o, c.a);
      assert.ok(d < achseTol,
        `Kugel ${sid}: Abstand zur Achse ${cid} = ${d.toExponential(3)} (> ${achseTol})`);
      assert.equal(s.R, c.R, `Kugel ${sid}: R = ${s.R} statt ${c.R} (Zylinder ${cid})`);
    }
  }
}

// Platte: Torus koaxial zur Bohrung, Mitte auf der Achse, an der Deckfläche
function checkPlate(body, achseTol) {
  const { surfs } = body;
  const tor = byType(surfs, 'torus');
  const cyl = byType(surfs, 'cylinder');
  assert.equal(tor.length, 1, `Tori: ${tor.length}`);
  assert.equal(cyl.length, 1, `Zylinder: ${cyl.length}`);
  const [tid, t] = tor[0];
  const [cid, c] = cyl[0];

  const par = len(cross(t.a, c.a));
  assert.ok(par < achseTol,
    `Torus ${tid}: Achse nicht parallel zur Bohrung (|a×a| = ${par.toExponential(3)} > ${achseTol})`);
  const dc = axisDist(t.c, c.o, c.a);
  assert.ok(dc < GENAU, `Torus ${tid}: Mitte ${dc.toExponential(3)} von der Bohrungsachse entfernt`);
  assert.ok(Math.abs(t.Rm - (c.R + t.r)) < EXAKT,
    `Torus ${tid}: Rm = ${t.Rm.toFixed(12)} statt R_Zyl + r = ${(c.R + t.r).toFixed(12)}`);

  // tangentiale Ebene (Deckfläche): eine Ebene parallel zur Torusachse muss den
  // Torus berühren — ihr Abstand zur Torusmitte ist dann exakt ±r
  const parPlanes = byType(surfs, 'plane')
    .filter(([, p]) => Math.abs(dot(p.n, t.a)) > 1 - 1e-6)
    .map(([pid, p]) => [pid, p, Math.abs(Math.abs(sdist(p, t.c)) - t.r)])
    .sort((a, b) => a[2] - b[2]);
  assert.ok(parPlanes.length, `Torus ${tid}: keine Ebene parallel zur Torusachse`);
  const [pid, p, dev] = parPlanes[0];
  assert.ok(dev < EXAKT,
    `Torus ${tid} ↔ Ebene ${pid}: |sdist| = ${Math.abs(sdist(p, t.c)).toFixed(12)} `
    + `statt r = ${t.r.toFixed(12)} (Abweichung ${dev.toExponential(3)})`);
}

// Halbkugel: Kugel auf der Zylinderachse, R = R_Zyl
function checkHalf(body) {
  const { surfs, chains, mesh } = body;
  const pairs = anglePairs(mesh, surfs, chains);
  const sph = byType(surfs, 'sphere');
  const cyl = byType(surfs, 'cylinder');
  assert.equal(sph.length, 1, `Kugeln: ${sph.length}`);
  assert.equal(cyl.length, 1, `Zylinder: ${cyl.length}`);
  const [sid, s] = sph[0];
  const [cid, c] = cyl[0];
  const d = axisDist(s.c, c.o, c.a);
  assert.ok(d < GENAU, `Kugel ${sid}: Abstand zur Zylinderachse = ${d.toExponential(3)}`);
  assert.equal(s.R, c.R, `Kugel ${sid}: R = ${s.R} statt ${c.R}`);
}

// ── Fälle ────────────────────────────────────────────────────────────────────
const BODY = {
  box: 'ff_rundquader_r1.stl',
  boxG: 'ff_rundquader_r1_gedreht.stl',
  plate: 'ff_platte_loch_torus.stl',
  plateG: 'ff_platte_loch_torus_gedreht.stl',
  half: 'ff_halbkugel_zylinder.stl',
  halfG: 'ff_halbkugel_zylinder_gedreht.stl',
};

const bodies = {};
for (const [key, file] of Object.entries(BODY)) {
  bodies[key] = loadBody(file);
}

// gedreht/ungedreht: nur prüfen, wenn die Segmentierung gleich ist
const skips = [];
function rotatedCase(key, name, fn) {
  const plain = key.replace(/G$/, '');
  const same = typeCounts(bodies[key].regions) === typeCounts(bodies[plain].regions);
  if (!same) {
    skips.push(`SKIP (segmentation) ${name} — ${bodies[key].file}: `
      + `${typeCounts(bodies[key].regions)} statt ${typeCounts(bodies[plain].regions)}`);
    return;
  }
  test(name, () => fn(bodies[key]));
}

test('Rundquader: Zylinder tangential zu genau 2 Ebenen, Kugel auf den Achsen', () => {
  checkBox(bodies.box, GENAU);
});

rotatedCase('boxG', 'Rundquader gedreht: Zylinder tangential zu genau 2 Ebenen, Kugel auf den Achsen',
  (b) => checkBox(b, RAUSCH));

test('Platte: Torus koaxial zur Bohrung, Mitte auf der Achse, an der Deckfläche', () => {
  checkPlate(bodies.plate, RICHTUNG);
});

rotatedCase('plateG', 'Platte gedreht: Torus koaxial zur Bohrung, Mitte auf der Achse, an der Deckfläche',
  (b) => checkPlate(b, RAUSCH));

test('Halbkugel: Kugelmittelpunkt auf der Zylinderachse, R = R_Zyl', () => {
  checkHalf(bodies.half);
});

rotatedCase('halfG', 'Halbkugel gedreht: Kugelmittelpunkt auf der Zylinderachse, R = R_Zyl',
  (b) => checkHalf(b));

test('Snap verändert die Eingabe nicht', () => {
  for (const key of Object.keys(bodies)) {
    const b = bodies[key];
    const after = JSON.stringify(b.snapRegions.map((r) => (r.surf ? r.surf : null)));
    assert.equal(after, b.before, `${b.file}: Regionen wurden verändert`);
  }
});

test('Snap liefert für jede analytische Region eine Kopie', () => {
  for (const key of Object.keys(bodies)) {
    const b = bodies[key];
    for (const r of b.regions) {
      if (r.type === 'facet') {
        assert.equal(b.surfs.has(r.id), false, `${b.file}: Facette ${r.id} in surfs`);
        continue;
      }
      assert.ok(b.surfs.has(r.id), `${b.file}: Region ${r.id} fehlt in surfs`);
      const s = b.surfs.get(r.id);
      assert.notEqual(s, r.surf, `${b.file}: Region ${r.id} ist keine Kopie`);
      assert.equal(s.type, r.surf.type, `${b.file}: Region ${r.id}: Typ geändert`);
    }
  }
});

test('Snap ist deterministisch', () => {
  for (const key of Object.keys(bodies)) {
    const b = bodies[key];
    const again = snapSurfaces({ mesh: b.mesh, regions: b.snapRegions, chains: b.chains });
    assert.deepEqual([...again.surfs.keys()], [...b.surfs.keys()], `${b.file}: Region-IDs`);
    for (const [id, s] of again.surfs) {
      assert.deepEqual(s, b.surfs.get(id), `${b.file}: Region ${id} unterschiedlich`);
    }
    assert.deepEqual(again.log, b.log, `${b.file}: log unterschiedlich`);
  }
});

// ── Ausgabe ──────────────────────────────────────────────────────────────────
// Segmentierung (Regionenarten je Körper) — damit der Lead sieht, was erkannt wurde
console.log('--- Segmentierung ---');
for (const key of Object.keys(bodies)) {
  const b = bodies[key];
  console.log(`  ${b.file}: ${b.regions.length} Regionen (${typeCounts(b.regions)})`);
}
// Flächen und Snap-Protokoll der Körper mit gekrümmten Flächen
for (const key of ['plate', 'plateG', 'half', 'halfG']) {
  const b = bodies[key];
  for (const [id, s] of byType(b.surfs, 'cylinder')) {
    console.log(`     ${b.file}: Zylinder ${id}: R = ${s.R.toFixed(6)}, a = [${s.a.map((v) => v.toFixed(6))}]`);
  }
  for (const [id, s] of byType(b.surfs, 'sphere')) {
    console.log(`     ${b.file}: Kugel ${id}: R = ${s.R.toFixed(6)}, c = [${s.c.map((v) => v.toFixed(6))}]`);
  }
  for (const [id, s] of byType(b.surfs, 'torus')) {
    console.log(`     ${b.file}: Torus ${id}: Rm = ${s.Rm.toFixed(6)}, r = ${s.r.toFixed(6)}, `
      + `a = [${s.a.map((v) => v.toFixed(6))}], c = [${s.c.map((v) => v.toFixed(6))}]`);
  }
  for (const line of b.log) console.log(`     ${b.file}: log: ${line}`);
}
// Rundquader: nur Kurzfassung (das Protokoll ist sehr lang)
// eslint-disable-next-line no-unused-vars
for (const key of ['box', 'boxG']) {
  const b = bodies[key];
  const kontakte = b.log.filter((l) => l.includes('Kontakt-Test')).length;
  const snaps = b.log.filter((l) => !l.includes('Kontakt-Test')).length;
  console.log(`     ${b.file}: log: ${kontakte} tangentiale Paare (Kontakt-Test), ${snaps} Snap-Schritte`);
}

for (const line of skips) console.log(line);

for (const [name, fn] of cases) {
  try {
    fn();
    console.log('ok ' + name);
  } catch (e) {
    failed++;
    console.log('FAIL ' + name + ': ' + (e && e.message ? e.message : e));
  }
}

if (failed) {
  console.log(`${failed} Fall/Fälle fehlgeschlagen`);
  process.exit(1);
}
console.log('alle Fälle ok');

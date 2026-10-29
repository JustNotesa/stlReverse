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
//   • Platte: Bohrungsachse EXAKT orthogonal zur Deckfläche (|a×n| = 0),
//     Torus-Achse = Bohrungsachse, Torus-Mitte auf der Bohrungsachse,
//     Rm = R_Zyl + r, Abstand der Torus-Mitte zur Deckfläche = ±r
//   • Halbkugel: Kugelmittelpunkt auf der Zylinderachse, R = R_Zyl
//   • synthetisch: Zylinder zwischen zwei Ebenen, Achse um 0,3° geneigt →
//     nach dem Snap exakt (0,0,±1)
//
// Toleranzen: Größen, die der Snap EXAKT konstruiert (Tangentialität, R = R,
// orthogonale Achsen), werden mit 1e-9/1e-12 geprüft — auch an den gedrehten
// Körpern. Größen, die nur näherungsweise aus zwei unabhängigen Fits folgen
// (Kugelmittelpunkt auf mehreren Achsen), sind beim gedrehten Körper durch
// das float32-Rauschen der STL (≈1e-6 mm) begrenzt → dort 1e-5.
//
// Die GEDREHTEN Körper werden nur geprüft, wenn die Segmentierung dieselben
// Flächenarten liefert wie der ungedrehte Körper. SegmenTIERT der gedrehte
// Körper anders (bekannter Segmentierungs-Fehler, wird parallel behoben), wird
// der Fall mit "SKIP (segmentation)" übersprungen statt zu scheitern. AUSNAHME
// Platte: dort stören nur zusätzliche Facetten-Regionen (bekannter Fehler);
//   fehlen Zylinder oder Torus, wird trotzdem übersprungen.
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
import { sdist, normalAt, dot, cross, len, sub, add, mul, norm } from '../../freeform-geom.js';

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

// Platte: Bohrungsachse exakt orthogonal zur Deckfläche, Torus koaxial zur
// Bohrung, Mitte auf der Achse, an der Deckfläche
function checkPlate(body) {
  const { surfs } = body;
  const tor = byType(surfs, 'torus');
  const cyl = byType(surfs, 'cylinder');
  assert.equal(tor.length, 1, `Tori: ${tor.length}`);
  assert.equal(cyl.length, 1, `Zylinder: ${cyl.length}`);
  const [tid, t] = tor[0];
  const [cid, c] = cyl[0];

  // Deckfläche oben: die zur Torusachse parallele Ebene, an der der Torus
  // tangential anliegt (Abstand der Torusmitte zur Ebene = r)
  const decks = byType(surfs, 'plane')
    .filter(([, p]) => Math.abs(dot(p.n, t.a)) > 1 - 1e-6)
    .map(([pid, p]) => [pid, p, Math.abs(Math.abs(sdist(p, t.c)) - t.r)])
    .sort((a, b) => a[2] - b[2]);
  assert.ok(decks.length, `Torus ${tid}: keine Ebene parallel zur Torusachse`);
  const [pid, p, dev] = decks[0];

  // exakt: die Bohrungsachse steht senkrecht auf der Deckfläche
  const perp = len(cross(c.a, p.n));
  assert.ok(perp < RICHTUNG,
    `Zylinder ${cid}: Achse nicht orthogonal zur Deckfläche ${pid} `
    + `(|a×n| = ${perp.toExponential(3)})`);
  // exakt: Torus koaxial zur Bohrung
  const par = len(cross(t.a, c.a));
  assert.ok(par < RICHTUNG,
    `Torus ${tid}: Achse nicht parallel zur Bohrung (|a×a| = ${par.toExponential(3)})`);
  // exakt projiziert: Torusmitte auf der Bohrungsachse
  const dc = axisDist(t.c, c.o, c.a);
  assert.ok(dc < GENAU, `Torus ${tid}: Mitte ${dc.toExponential(3)} von der Bohrungsachse entfernt`);
  // exakt konstruiert: Rm = R_Zyl + r
  assert.ok(Math.abs(t.Rm - (c.R + t.r)) < EXAKT,
    `Torus ${tid}: Rm = ${t.Rm.toFixed(12)} statt R_Zyl + r = ${(c.R + t.r).toFixed(12)}`);
  // exakt: Abstand der Torusmitte zur Deckfläche = r
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

// ── Synthetischer Fall: Zylinder zwischen zwei Ebenen ─────────────────────
// Der Fit liefert die Achse um das float32-Rauschen der STL verkippt; die
// orthogonalen Achsen (Schritt 1b) müssen sie exakt auf die Ebenennormale
// setzen. Gebaut: Zylinder R5 zwischen den Ebenen z = 0 und z = 10, Achse um
// 0,3° gegen z geneigt.
function syntheticTiltedCylinder() {
  const N = 16;
  const R = 5;
  const z0 = 0;
  const z1 = 10;
  const pts = [];
  const idx = (x, y, z) => { pts.push([x, y, z]); return pts.length - 1; };
  const bot = [];
  const top = [];
  for (let j = 0; j < N; j++) {
    const th = (j / N) * 2 * Math.PI;
    bot.push(idx(R * Math.cos(th), R * Math.sin(th), z0));
    top.push(idx(R * Math.cos(th), R * Math.sin(th), z1));
  }
  const cB = idx(0, 0, z0);
  const cT = idx(0, 0, z1);
  const wall = [];
  const capB = [];
  const capT = [];
  for (let j = 0; j < N; j++) {
    const j2 = (j + 1) % N;
    wall.push([pts[bot[j]], pts[bot[j2]], pts[top[j2]]]);
    wall.push([pts[bot[j]], pts[top[j2]], pts[top[j]]]);
    capB.push([pts[cB], pts[bot[j2]], pts[bot[j]]]);
    capT.push([pts[cT], pts[top[j]], pts[top[j2]]]);
  }
  const mesh = indexMesh([...wall, ...capB, ...capT]);
  assert.ok(mesh, 'synthetisch: indexMesh lieferte null');
  // Netz-Indizes der Ringpunkte (indexMesh nummeriert die Ecken neu)
  const key = (p) => `${p[0]},${p[1]},${p[2]}`;
  const vidx = new Map();
  for (let i = 0; i < mesh.nV; i++) {
    vidx.set(key([mesh.P[3 * i], mesh.P[3 * i + 1], mesh.P[3 * i + 2]]), i);
  }
  const meshIdx = (list) => list.map((i) => vidx.get(key(pts[i])));
  const tilt = 0.3 * Math.PI / 180;
  const regions = [
    {
      id: 1,
      kind: 'analytic',
      surf: { type: 'plane', o: [0, 0, 0], n: [0, 0, -1] },
      tris: capB.map((_, k) => 2 * N + k),
      area: Math.PI * R * R,
    },
    {
      id: 2,
      kind: 'analytic',
      surf: { type: 'cylinder', o: [0, 0, 5], a: [Math.sin(tilt), 0, Math.cos(tilt)], R },
      tris: wall.map((_, k) => k),
      area: 2 * Math.PI * R * (z1 - z0),
    },
    {
      id: 3,
      kind: 'analytic',
      surf: { type: 'plane', o: [0, 0, 10], n: [0, 0, 1] },
      tris: capT.map((_, k) => 3 * N + k),
      area: Math.PI * R * R,
    },
  ];
  const chains = [
    { L: 2, R: 1, mv: meshIdx(bot) },
    { L: 2, R: 3, mv: meshIdx(top) },
  ];
  return { mesh, regions, chains };
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
// (need: nur diese Regionstypen müssen vorhanden sein — dann stören
//  zusätzliche Facetten-Regionen nicht, siehe Platte)
const skips = [];
function rotatedCase(key, name, fn, need) {
  const plain = key.replace(/G$/, '');
  const b = bodies[key];
  if (need) {
    const missing = need.filter((t) => !b.regions.some((r) => r.type === t));
    if (missing.length) {
      skips.push(`SKIP (segmentation) ${name} — ${b.file}: Region(en) ${missing.join(',')} fehlen`);
      return;
    }
  } else {
    const same = typeCounts(b.regions) === typeCounts(bodies[plain].regions);
    if (!same) {
      skips.push(`SKIP (segmentation) ${name} — ${b.file}: `
        + `${typeCounts(b.regions)} statt ${typeCounts(bodies[plain].regions)}`);
      return;
    }
  }
  test(name, () => fn(b));
}

test('Rundquader: Zylinder tangential zu genau 2 Ebenen, Kugel auf den Achsen', () => {
  checkBox(bodies.box, GENAU);
});

rotatedCase('boxG', 'Rundquader gedreht: Zylinder tangential zu genau 2 Ebenen, Kugel auf den Achsen',
  (b) => checkBox(b, RAUSCH));

test('Platte: Bohrungsachse orthogonal zur Deckfläche, Torus koaxial zur Bohrung, an der Deckfläche', () => {
  checkPlate(bodies.plate);
});

rotatedCase('plateG', 'Platte gedreht: Bohrungsachse orthogonal zur Deckfläche, Torus koaxial zur Bohrung, an der Deckfläche',
  (b) => checkPlate(b), ['cylinder', 'torus']);

test('Halbkugel: Kugelmittelpunkt auf der Zylinderachse, R = R_Zyl', () => {
  checkHalf(bodies.half);
});

rotatedCase('halfG', 'Halbkugel gedreht: Kugelmittelpunkt auf der Zylinderachse, R = R_Zyl',
  (b) => checkHalf(b));

test('Synthetisch: Zylinder zwischen zwei Ebenen, Achse 0,3° geneigt → exakt orthogonal', () => {
  const { mesh, regions, chains } = syntheticTiltedCylinder();
  const { surfs } = snapSurfaces({ mesh, regions, chains });
  const cyl = surfs.get(2);
  assert.ok(cyl, 'Zylinderregion fehlt in surfs');
  assert.equal(cyl.type, 'cylinder');
  // die geneigte Achse wurde auf die Ebenennormale gesetzt — exakt
  assert.equal(Math.abs(cyl.a[0]), 0, `a[0] = ${cyl.a[0]}`);
  assert.equal(Math.abs(cyl.a[1]), 0, `a[1] = ${cyl.a[1]}`);
  assert.equal(Math.abs(Math.abs(cyl.a[2]) - 1), 0, `a[2] = ${cyl.a[2]}`);
});

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

// ── Rollkugel: synthetische Körper ──────────────────────────────────────────
// Eine Verrundung vom Radius r ist eine Kugel, deren Mittelpunkt auf der
// SPINE läuft = offset(S1,s1·r) ∩ offset(S2,s2·r). Geprüft wird, dass die
// Verrundung nach dem Snap EXAKT tangential an ihren Stützen liegt.

// Einheitsrichtung senkrecht zu a
function perpUnit(a) {
  const t = Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  return norm(sub(t, mul(a, dot(t, a))));
}

// Rohrrahmen eines Torus bei Winkel phi: w = radial, q = Rohrmittelpunkt
function tubeFrame(torus, phi) {
  const e1 = perpUnit(torus.a);
  const e2 = norm(cross(e1, torus.a));
  const w = add(mul(e1, Math.cos(phi)), mul(e2, Math.sin(phi)));
  return { w, q: add(torus.c, mul(w, torus.Rm)) };
}

// Punkt auf der Torusfläche, dessen Normale in Richtung dir zeigt
function tubePoint(torus, phi, dir) {
  const { w, q } = tubeFrame(torus, phi);
  const dw = dot(dir, w);
  const da = dot(dir, torus.a);
  const n = Math.hypot(dw, da);
  if (!(n > 1e-9)) return null;
  return add(q, mul(add(mul(w, dw / n), mul(torus.a, da / n)), torus.r));
}

// Punktgitter je Fläche
function planeGrid(pl, s = 20) {
  const e1 = perpUnit(pl.n);
  const e2 = norm(cross(e1, pl.n));
  return (u, v) => add(pl.o, add(mul(e1, (u - 0.5) * s), mul(e2, (v - 0.5) * s)));
}
function cylGrid(cyl, len) {
  const e1 = perpUnit(cyl.a);
  const e2 = norm(cross(e1, cyl.a));
  return (u, v) => {
    const th = 2 * Math.PI * u;
    return add(add(cyl.o, mul(cyl.a, (v - 0.5) * len)),
      add(mul(e1, cyl.R * Math.cos(th)), mul(e2, cyl.R * Math.sin(th))));
  };
}
function torusGrid(torus) {
  return (u, v) => {
    const phi = 2 * Math.PI * u;
    const th = 2 * Math.PI * v;
    const { w, q } = tubeFrame(torus, phi);
    return add(q, add(mul(w, torus.r * Math.cos(th)), mul(torus.a, torus.r * Math.sin(th))));
  };
}
function sphereGrid(sph) {
  return (u, v) => {
    const ph = 2 * Math.PI * u;
    const th = Math.PI * v;
    return add(sph.c, mul([Math.sin(th) * Math.cos(ph), Math.sin(th) * Math.sin(ph), Math.cos(th)], sph.R));
  };
}

// Netz + Regionen: je Region ein Punktgitter; d.extra liefert zusätzliche
// Netzpunkte für die Ketten (d.extra → { name: Punkte })
function buildBody(defs) {
  const pts = [];
  const tris = [];
  const regions = [];
  const mark = {};
  for (const d of defs) {
    const nu = d.nu;
    const nv = d.nv;
    const vo = pts.length;
    const to = tris.length;
    for (let i = 0; i < nu; i++) {
      for (let j = 0; j < nv; j++) pts.push(d.fn(i / (nu - 1), j / (nv - 1)));
    }
    const idx = (i, j) => vo + i * nv + j;
    for (let i = 0; i < nu - 1; i++) {
      for (let j = 0; j < nv - 1; j++) {
        tris.push([idx(i, j), idx(i + 1, j), idx(i + 1, j + 1)]);
        tris.push([idx(i, j), idx(i + 1, j + 1), idx(i, j + 1)]);
      }
    }
    regions.push({
      id: d.id,
      kind: 'analytic',
      surf: d.surf,
      tris: Array.from({ length: (nu - 1) * (nv - 1) * 2 }, (_, k) => to + k),
      area: d.area || 1,
    });
    mark[d.name] = { vo, idx };
  }
  for (const d of defs) {
    if (!d.extra) continue;
    const groups = d.extra();
    for (const key of Object.keys(groups)) {
      const list = groups[key];
      const vo = pts.length;
      for (const p of list) pts.push(p);
      mark[d.name][key] = { vo, n: list.length };
    }
  }
  const mesh = {
    P: Float64Array.from(pts.flat()),
    tri: Int32Array.from(tris.flat()),
    nV: pts.length,
    T: tris.length,
  };
  return { mesh, regions, mark };
}

// Kettenpunkte (Vertex-Indizes) einer Zusatzgruppe
function groupIdx(mark, name, key) {
  const g = mark[name][key];
  return Array.from({ length: g.n }, (_, i) => g.vo + i);
}

// ── Fall 1: Torusverrundung zwischen der Ebene z=0 und einer Kugelwand ────
// Die Wand ist eine Kugel (Mittelpunkt (0,0,−300), R=301) und trifft die Ebene
// im Kreis mit Radius √601. Die Verrundung ist ein Torus mit Kleinradius 1:
// seine SPINE ist der Kreis Radius √603 in der Ebene z=1 auf der Kugel mit
// R=302. Mit Rauschen (1e-3) in c/a/Rm.
function syntheticTorusFillet() {
  const PLANE = { type: 'plane', o: [0, 0, 0], n: [0, 0, 1] };
  const WALL = { type: 'sphere', c: [0, 0, -300], R: 301 };
  const r = 1;
  const Rm = Math.sqrt(603);
  const torus = {
    type: 'torus',
    c: [1.5e-3, -2e-3, 1 + 1e-3],
    a: norm([1.2e-3, 0.5e-3, 1]),
    Rm: Rm + 1.5e-3,
    r,
  };
  const N = 24;
  const defs = [
    { name: 'plane', id: 1, nu: 6, nv: 6, surf: PLANE, fn: planeGrid(PLANE, 60) },
    { name: 'torus', id: 2, nu: N, nv: 9, surf: torus, fn: torusGrid(torus) },
    {
      name: 'wall',
      id: 3,
      nu: N,
      nv: 5,
      surf: WALL,
      fn: (u, v) => {
        const ph = 2 * Math.PI * u;
        const th = -0.04 + 0.08 * v; // Band um den höchsten Punkt der Kugel
        return add(WALL.c, mul([Math.sin(th) * Math.cos(ph), Math.sin(th) * Math.sin(ph), Math.cos(th)], WALL.R));
      },
    },
  ];
  defs[1].extra = () => {
    const ebene = [];
    const wand = [];
    for (let i = 0; i < N; i++) {
      const phi = (2 * Math.PI * i) / N;
      ebene.push(tubePoint(torus, phi, [0, 0, -1]));
      const { q } = tubeFrame(torus, phi);
      wand.push(tubePoint(torus, phi, norm(sub(WALL.c, q))));
    }
    return { ebene, wand };
  };
  const { mesh, regions, mark } = buildBody(defs);
  const chains = [
    { L: 2, R: 1, mv: groupIdx(mark, 'torus', 'ebene') },
    { L: 2, R: 3, mv: groupIdx(mark, 'torus', 'wand') },
  ];
  return { mesh, regions, chains, PLANE, WALL };
}

// ── Fall 2: Zylinderverrundung zwischen zwei nicht parallelen Ebenen ───────
// Die Verrundung sitzt in der Kehle der Ebenen z=0 und x=0: ihre Achse ist
// die Gerade x=1, z=1 (Richtung y), R=1. Mit Rauschen in o/a/R.
function syntheticCylinderFillet() {
  const P1 = { type: 'plane', o: [0, 0, 0], n: [0, 0, 1] };
  const P2 = { type: 'plane', o: [0, 0, 0], n: [1, 0, 0] };
  const cyl = {
    type: 'cylinder',
    o: [1.001, 1, 1.002],
    a: norm([0.0008, 1, 0.0006]),
    R: 1.0004,
  };
  const N = 24;
  const defs = [
    { name: 'p1', id: 1, nu: 6, nv: 6, surf: P1, fn: planeGrid(P1, 60) },
    { name: 'p2', id: 2, nu: 6, nv: 6, surf: P2, fn: planeGrid(P2, 60) },
    { name: 'cyl', id: 3, nu: N, nv: 5, surf: cyl, fn: cylGrid(cyl, 4) },
  ];
  defs[2].extra = () => {
    // Berührlinien: ein Zylinder berührt eine Ebene längs einer Erzeugenden
    // (die radiale Richtung zeigt zur Ebene)
    const radial = (dir) => norm(sub(dir, mul(cyl.a, dot(dir, cyl.a))));
    const unten = [];
    const seite = [];
    for (let i = 0; i < N; i++) {
      const t = (i / (N - 1) - 0.5) * 3;
      unten.push(add(add(cyl.o, mul(cyl.a, t)), mul(radial([0, 0, -1]), cyl.R)));
      seite.push(add(add(cyl.o, mul(cyl.a, t)), mul(radial([-1, 0, 0]), cyl.R)));
    }
    return { unten, seite };
  };
  const { mesh, regions, mark } = buildBody(defs);
  const chains = [
    { L: 3, R: 1, mv: groupIdx(mark, 'cyl', 'unten') },
    { L: 3, R: 2, mv: groupIdx(mark, 'cyl', 'seite') },
  ];
  return { mesh, regions, chains, P1, P2 };
}

// ── Fall 3: Eckkugel zwischen drei Ebenen und drei Zylinderverrundungen ────
// Die drei Koordinatenebenen x=0, y=0, z=0 mit drei Kantenverrundungen
// (Zylinder r=1, Achsen x=y, x=z, y=z) und der Eckkugel r=1 in der Ecke:
// ihr Mittelpunkt liegt auf allen drei Achsen → (1,1,1).
function syntheticCornerBall() {
  const PX = { type: 'plane', o: [0, 0, 0], n: [1, 0, 0] };
  const PY = { type: 'plane', o: [0, 0, 0], n: [0, 1, 0] };
  const PZ = { type: 'plane', o: [0, 0, 0], n: [0, 0, 1] };
  const CZ = { type: 'cylinder', o: [1, 1, -1], a: [0, 0, 1], R: 1 };
  const CY = { type: 'cylinder', o: [1, -1, 1], a: [0, 1, 0], R: 1 };
  const CX = { type: 'cylinder', o: [-1, 1, 1], a: [1, 0, 0], R: 1 };
  const ball = { type: 'sphere', c: [1.0012, 0.9994, 1.0007], R: 1 };
  const N = 20;
  const defs = [
    { name: 'px', id: 1, nu: 5, nv: 5, surf: PX, fn: planeGrid(PX, 8) },
    { name: 'py', id: 2, nu: 5, nv: 5, surf: PY, fn: planeGrid(PY, 8) },
    { name: 'pz', id: 3, nu: 5, nv: 5, surf: PZ, fn: planeGrid(PZ, 8) },
    { name: 'cz', id: 4, nu: N, nv: 5, surf: CZ, fn: cylGrid(CZ, 4) },
    { name: 'cy', id: 5, nu: N, nv: 5, surf: CY, fn: cylGrid(CY, 4) },
    { name: 'cx', id: 6, nu: N, nv: 5, surf: CX, fn: cylGrid(CX, 4) },
    { name: 'ball', id: 7, nu: N, nv: 11, surf: ball, fn: sphereGrid(ball) },
  ];
  // Berührlinien/-kreise (Kettenpunkte)
  const linie = (a, b, c) => {
    const out = [];
    for (let i = 0; i < N; i++) out.push(add(a, mul(b, (i / (N - 1) - 0.5) * c)));
    return out;
  };
  const kreis = (c, e1, e2, R) => {
    const out = [];
    for (let i = 0; i < N; i++) {
      const th = (2 * Math.PI * i) / N;
      out.push(add(c, add(mul(e1, R * Math.cos(th)), mul(e2, R * Math.sin(th)))));
    }
    return out;
  };
  defs[3].extra = () => ({
    px: linie([0, 1, 0], [0, 0, 1], 3),   // Kante x=y ↔ Ebene x=0
    py: linie([1, 0, 0], [0, 0, 1], 3),   // Kante x=y ↔ Ebene y=0
  });
  defs[4].extra = () => ({
    px: linie([0, 0, 1], [0, 1, 0], 3),   // Kante x=z ↔ Ebene x=0
    pz: linie([1, 0, 0], [0, 1, 0], 3),   // Kante x=z ↔ Ebene z=0
  });
  defs[5].extra = () => ({
    py: linie([0, 0, 1], [1, 0, 0], 3),   // Kante y=z ↔ Ebene y=0
    pz: linie([0, 1, 0], [1, 0, 0], 3),   // Kante y=z ↔ Ebene z=0
  });
  defs[6].extra = () => ({
    cz: kreis([1, 1, 1], [1, 0, 0], [0, 1, 0], 1), // Kugel ↔ Kante x=y
    cy: kreis([1, 1, 1], [1, 0, 0], [0, 0, 1], 1), // Kugel ↔ Kante x=z
    cx: kreis([1, 1, 1], [0, 1, 0], [0, 0, 1], 1), // Kugel ↔ Kante y=z
  });
  const { mesh, regions, mark } = buildBody(defs);
  const chains = [
    { L: 4, R: 1, mv: groupIdx(mark, 'cz', 'px') },
    { L: 4, R: 2, mv: groupIdx(mark, 'cz', 'py') },
    { L: 5, R: 1, mv: groupIdx(mark, 'cy', 'px') },
    { L: 5, R: 3, mv: groupIdx(mark, 'cy', 'pz') },
    { L: 6, R: 2, mv: groupIdx(mark, 'cx', 'py') },
    { L: 6, R: 3, mv: groupIdx(mark, 'cx', 'pz') },
    { L: 7, R: 4, mv: groupIdx(mark, 'ball', 'cz') },
    { L: 7, R: 5, mv: groupIdx(mark, 'ball', 'cy') },
    { L: 7, R: 6, mv: groupIdx(mark, 'ball', 'cx') },
  ];
  return { mesh, regions, chains };
}

// ── Fall 4: Eckkugel zwischen Ebene, Kugelwand und Torusverrundung ─────────
// Wie Fall 1 (Torus zwischen Ebene und Kugelwand), zusätzlich eine Kugel
// r=1, deren Mittelpunkt auf dem Rohrkreis des Torus liegt: sie berührt die
// Ebene, die Kugelwand und den Torus.
function syntheticBallThreeSupports() {
  const PLANE = { type: 'plane', o: [0, 0, 0], n: [0, 0, 1] };
  const WALL = { type: 'sphere', c: [0, 0, -300], R: 301 };
  const r = 1;
  const Rm = Math.sqrt(603);
  const torus = {
    type: 'torus',
    c: [1.2e-3, -1.5e-3, 1 + 0.8e-3],
    a: norm([1e-3, 0.4e-3, 1]),
    Rm: Rm + 1.2e-3,
    r,
  };
  const ball = { type: 'sphere', c: [Rm + 1.5e-3, 0.8e-3, 1 - 1.1e-3], R: 1 };
  const N = 24;
  const defs = [
    { name: 'plane', id: 1, nu: 6, nv: 6, surf: PLANE, fn: planeGrid(PLANE, 60) },
    { name: 'torus', id: 2, nu: N, nv: 9, surf: torus, fn: torusGrid(torus) },
    {
      name: 'wall',
      id: 3,
      nu: N,
      nv: 5,
      surf: WALL,
      fn: (u, v) => {
        const ph = 2 * Math.PI * u;
        const th = -0.04 + 0.08 * v;
        return add(WALL.c, mul([Math.sin(th) * Math.cos(ph), Math.sin(th) * Math.sin(ph), Math.cos(th)], WALL.R));
      },
    },
    { name: 'ball', id: 4, nu: 16, nv: 11, surf: ball, fn: sphereGrid(ball) },
  ];
  defs[1].extra = () => {
    const ebene = [];
    const wand = [];
    for (let i = 0; i < N; i++) {
      const phi = (2 * Math.PI * i) / N;
      ebene.push(tubePoint(torus, phi, [0, 0, -1]));
      const { q } = tubeFrame(torus, phi);
      wand.push(tubePoint(torus, phi, norm(sub(WALL.c, q))));
    }
    return { ebene, wand };
  };
  defs[3].extra = () => {
    // Berührpunkt mit der Ebene, Berührkreis mit der Wand, Querschnitt am Torus
    const ebene = [add(ball.c, [0, 0, -ball.R])];
    const wand = [];
    const u = norm(sub(ball.c, WALL.c));
    const e1 = perpUnit(u);
    const e2 = norm(cross(e1, u));
    for (let i = 0; i < N; i++) {
      const th = (2 * Math.PI * i) / N;
      wand.push(add(WALL.c, add(mul(e1, WALL.R * Math.cos(th)), mul(e2, WALL.R * Math.sin(th)))));
    }
    const tor = [];
    for (let i = 0; i < N; i++) {
      const th = (2 * Math.PI * i) / N;
      tor.push(add(ball.c, add(mul([1, 0, 0], ball.R * Math.cos(th)), mul([0, 0, 1], ball.R * Math.sin(th)))));
    }
    return { ebene, wand, tor };
  };
  const { mesh, regions, mark } = buildBody(defs);
  const chains = [
    { L: 2, R: 1, mv: groupIdx(mark, 'torus', 'ebene') },
    { L: 2, R: 3, mv: groupIdx(mark, 'torus', 'wand') },
    { L: 4, R: 1, mv: groupIdx(mark, 'ball', 'ebene') },
    { L: 4, R: 3, mv: groupIdx(mark, 'ball', 'wand') },
    { L: 4, R: 2, mv: groupIdx(mark, 'ball', 'tor') },
  ];
  return { mesh, regions, chains, PLANE, WALL };
}

// ── Prüfungen ────────────────────────────────────────────────────────────────

// Rollkugel: Torus zwischen Ebene und Kugelwand exakt tangential
test('Rollkugel: Torus zwischen Ebene und Kugelwand wird exakt tangential', () => {
  const { mesh, regions, chains, PLANE, WALL } = syntheticTorusFillet();
  const { surfs } = snapSurfaces({ mesh, regions, chains });
  const t = surfs.get(2);
  assert.ok(t, 'Torusregion fehlt in surfs');
  assert.equal(t.type, 'torus');
  assert.equal(t.r, 1, `Kleinradius ${t.r} statt 1`);
  for (let i = 0; i < 50; i++) {
    const phi = (2 * Math.PI * i) / 50;
    // Berührkreis mit der Ebene
    const pb = tubePoint(t, phi, [0, 0, -1]);
    const dP = Math.abs(sdist(PLANE, pb));
    assert.ok(dP <= 1e-9, `Ebene: |sdist| = ${dP.toExponential(3)} statt 0`);
    const cP = Math.abs(dot(normalAt(t, pb), normalAt(PLANE, pb)));
    assert.ok(1 - cP <= 1e-9, `Ebene: Normalen |cos| = ${cP}`);
    // Berührkreis mit der Kugelwand
    const { q } = tubeFrame(t, phi);
    const ps = tubePoint(t, phi, norm(sub(WALL.c, q)));
    const dW = Math.abs(sdist(WALL, ps));
    assert.ok(dW <= 1e-9, `Wand: |sdist| = ${dW.toExponential(3)} statt 0`);
    const cW = Math.abs(dot(normalAt(t, ps), normalAt(WALL, ps)));
    assert.ok(1 - cW <= 1e-9, `Wand: Normalen |cos| = ${cW}`);
  }
});

// Rollkugel: Zylinder zwischen zwei Ebenen exakt tangential
test('Rollkugel: Zylinderverrundung zwischen zwei Ebenen bleibt exakt tangential', () => {
  const { mesh, regions, chains, P1, P2 } = syntheticCylinderFillet();
  const { surfs } = snapSurfaces({ mesh, regions, chains });
  const c = surfs.get(3);
  assert.ok(c, 'Zylinderregion fehlt in surfs');
  assert.equal(c.type, 'cylinder');
  for (const p of [P1, P2]) {
    const an = Math.abs(dot(c.a, p.n));
    assert.ok(an <= 1e-9, `Achse nicht parallel zur Ebene: |a·n| = ${an.toExponential(3)}`);
    const d = Math.abs(Math.abs(sdist(p, c.o)) - c.R);
    assert.ok(d <= 1e-9, `Abstand zur Ebene ${d.toExponential(3)} statt R = ${c.R}`);
    // die Normalen an der Berührstelle sind parallel
    const foot = add(c.o, mul(c.a, dot(sub(p.o, c.o), c.a)));
    const q = sub(foot, mul(p.n, sdist(p, foot)));
    const cs = Math.abs(dot(normalAt(c, q), normalAt(p, q)));
    assert.ok(1 - cs <= 1e-9, `Normalen |cos| = ${cs}`);
  }
});

// Rollkugel: Eckkugel zwischen drei Ebenen und drei Zylinderverrundungen
test('Rollkugel: Eckkugel zwischen drei Ebenen und drei Zylinderverrundungen', () => {
  const { mesh, regions, chains } = syntheticCornerBall();
  const { surfs } = snapSurfaces({ mesh, regions, chains });
  const s = surfs.get(7);
  assert.ok(s, 'Kugelregion fehlt in surfs');
  assert.equal(s.type, 'sphere');
  const d = len(sub(s.c, [1, 1, 1]));
  assert.ok(d <= 1e-9, `Mitte ${s.c.map((v) => v.toFixed(12))} statt (1,1,1) (Abstand ${d.toExponential(3)})`);
  assert.equal(s.R, 1, `R = ${s.R} statt 1`);
  // die Eckkugel liegt exakt auf den drei Achsen der Kantenverrundungen
  for (const [cid, cidSurf] of byType(surfs, 'cylinder')) {
    const dd = axisDist(s.c, cidSurf.o, cidSurf.a);
    assert.ok(dd <= 1e-9, `Kugel: Abstand zur Achse ${cid} = ${dd.toExponential(3)}`);
  }
});

// Rollkugel: Eckkugel zwischen Ebene, Kugelwand und Torusverrundung
test('Rollkugel: Eckkugel zwischen Ebene, Kugelwand und Torusverrundung', () => {
  const { mesh, regions, chains, PLANE, WALL } = syntheticBallThreeSupports();
  const { surfs } = snapSurfaces({ mesh, regions, chains });
  const b = surfs.get(4);
  const t = surfs.get(2);
  assert.ok(b && t, 'Regionen fehlen in surfs');
  assert.equal(b.type, 'sphere');
  assert.equal(t.type, 'torus');
  // die Versatzflächen (SPINE der Verrundungen) — der Mittelpunkt liegt auf allen
  const offPlane = { type: 'plane', o: [0, 0, 1], n: [0, 0, 1] };
  const offWall = { type: 'sphere', c: [0, 0, -300], R: 302 };
  const offTorus = { type: 'torus', c: t.c, a: t.a, Rm: t.Rm, r: 0 };
  for (const [name, O] of [['Ebene', offPlane], ['Wand', offWall], ['Torus', offTorus]]) {
    const d = Math.abs(sdist(O, b.c));
    assert.ok(d <= 1e-10, `${name}: |sdist| = ${d.toExponential(3)} statt 0`);
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

// ─────────────────────────────────────────────────────────────────────────────
// freeform-snap.js — Schritt 3 des Freiform-Pfads (Entwurfskopf freeform-brep.js):
// Verrundungen EXAKT tangential an ihre Nachbarn legen.
//
// Fit-Rauschen (Modell-Fit auf ein Tessellat) macht ein tangentiales Paar
// (Verrundung ↔ Ebene, Zylinder ↔ Kugel, Torus ↔ Zylinder) scheinbar
// schneidlos oder mehrdeutig: die exakte Schnittkurve fehlt dann. Hier werden
// solche Paare exakt tangential gemacht (Rest ~1e-12), damit der spätere
// Ecken-/Kanten-Löser gemeinsame Punkte findet.
//
// Datenmodell (verbindlich, siehe Entwurfskopf freeform-brep.js):
//   Fläche { type:'plane',    o, n }
//          { type:'cylinder', o (Punkt auf der Achse), a, R }
//          { type:'cone',     apex, a, alpha }
//          { type:'sphere',   c, R }
//          { type:'torus',    c, a, Rm (groß), r (klein) }
//
// Eingabe
//   mesh    { P, tri, ... }                    (indexMesh)
//   regions [{ id, kind:'analytic'|'facet', surf, tris, area }]
//   chains  [{ L, R, mv }]                    (buildTopology; mv = Netzecken)
// Ausgabe
//   { surfs: Map(Region-Id → Fläche), log: string[] }
// Die Eingaben werden NIE verändert: jede analytische Region erhält eine Kopie.
//
// Schritte (Reihenfolge bindend):
//   0 tangentiale Paare: Winkel der Flächennormalen an den Kettenpunkten
//     — zusätzlich der Kontakt-Test (siehe unten), weil der Fit ein
//       Nachbarband mitverschlucken kann und die Regionsgrenze dann nicht
//       auf der Berührungsstelle liegt
//   1 Radien-Cluster (Zylinder R, Kugel R, Torus r) vereinheitlichen
//   1b orthogonale Achsen: Zylinder/Kegel/Torus, die mit einer Ebene eine
//      Kette teilen und deren Achse parallel zur Ebenennormale ist
//      (|a·n| > cos 0,5° — z. B. die Bohrung durch eine Platte), bekommen
//      die Achse exakt auf ±n gesetzt. Vorher (1b-0) bekommen genau
//      parallele Ebenen eine gemeinsame Normale: sonst wären die beiden
//      Deckflächen um das float32-Rauschen der STL gegeneinander
//      verkippt und der exakte Schnittkreis ginge verloren.
//   2 Zylinder exakt an seine tangentialen Ebenen legen
//   3 Torus koaxial zum Zylinder, Mitte exakt in der tangentialen Ebene
//   4 Kugel auf die Achse(n) ihrer tangentialen Zylinder setzen
//   5 jede Änderung prüfen (Restfehler ≤ 2·tol), sonst zurücknehmen
// ─────────────────────────────────────────────────────────────────────────────

import {
  sdist, normalAt, add, sub, mul, dot, cross, len, norm,
} from './freeform-geom.js';

const DEG = Math.PI / 180;
const COS5 = Math.cos(5 * DEG);
const COS05 = Math.cos(0.5 * DEG);    // orthogonale Achse ↔ Ebene
const COSPARA = Math.cos(0.05 * DEG);  // parallel: Ebenen-Normalen

// ── Hilfen ───────────────────────────────────────────────────────────────────

// Fläche kopieren (Vektoren als frische Arrays)
function copySurf(s) {
  switch (s.type) {
    case 'plane': return { type: 'plane', o: Array.from(s.o), n: Array.from(s.n) };
    case 'cylinder': return { type: 'cylinder', o: Array.from(s.o), a: Array.from(s.a), R: s.R };
    case 'cone': return { type: 'cone', apex: Array.from(s.apex), a: Array.from(s.a), alpha: s.alpha };
    case 'sphere': return { type: 'sphere', c: Array.from(s.c), R: s.R };
    case 'torus': return { type: 'torus', c: Array.from(s.c), a: Array.from(s.a), Rm: s.Rm, r: s.r };
    default: {
      const out = {};
      for (const k of Object.keys(s)) out[k] = Array.isArray(s[k]) ? Array.from(s[k]) : s[k];
      return out;
    }
  }
}

// 3×3-System lösen (Spaltenpivotisierung); null bei Singularität
function solve3(A, b) {
  const M = [
    [A[0][0], A[0][1], A[0][2], b[0]],
    [A[1][0], A[1][1], A[1][2], b[1]],
    [A[2][0], A[2][1], A[2][2], b[2]],
  ];
  for (let c = 0; c < 3; c++) {
    let piv = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (!(Math.abs(M[piv][c]) > 1e-14)) return null;
    if (piv !== c) { const t = M[c]; M[c] = M[piv]; M[piv] = t; }
    for (let r = 0; r < 3; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k < 4; k++) M[r][k] -= f * M[c][k];
    }
  }
  return [M[0][3] / M[0][0], M[1][3] / M[1][1], M[2][3] / M[2][2]];
}

// Zwei Flächen gleich? (für "unverändert")
function sameSurf(a, b) {
  if (!a || !b || a.type !== b.type) return false;
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
  for (const k of ka) {
    const va = a[k];
    const vb = b[k];
    if (Array.isArray(va)) {
      if (!Array.isArray(vb) || va.length !== vb.length) return false;
      for (let i = 0; i < va.length; i++) if (va[i] !== vb[i]) return false;
    } else if (va !== vb) return false;
  }
  return true;
}

// Zwei Vektoren gleich? (Werte, nicht Referenzen)
function sameVec(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

// Radius einer gekrümmten Fläche (Zylinder R, Kugel R, Torus r); null sonst
function radiusOf(s) {
  if (!s) return null;
  if (s.type === 'cylinder' || s.type === 'sphere') return s.R;
  if (s.type === 'torus') return s.r;
  return null;
}

// Radius setzen
function setRadius(s, v) {
  if (s.type === 'cylinder' || s.type === 'sphere') s.R = v;
  else if (s.type === 'torus') s.r = v;
}

// Stabiler Mittelwert (r0 + Σ(r−r0)/n) — bei gleichen Werten exakt r0
function meanOf(values) {
  if (!values.length) return NaN;
  const r0 = values[0];
  let s = 0;
  for (const v of values) s += v - r0;
  return r0 + s / values.length;
}

// Restfehler einer Fläche: größter |sdist| über die Dreiecksecken der Region
function maxResidual(mesh, region, surf) {
  const P = mesh.P;
  const tri = mesh.tri;
  let m = 0;
  for (const f of (region.tris || [])) {
    for (let k = 0; k < 3; k++) {
      const v = tri[3 * f + k];
      const d = Math.abs(sdist(surf, [P[3 * v], P[3 * v + 1], P[3 * v + 2]]));
      if (d > m) m = d;
    }
  }
  return m;
}

// Netzpunkte einer Region (eindeutig)
function regionVerts(mesh, region) {
  const set = new Set();
  const tri = mesh.tri;
  for (const f of (region.tris || [])) {
    for (let k = 0; k < 3; k++) set.add(tri[3 * f + k]);
  }
  return set;
}

// Kontakt-Test: berühren sich die beiden Flächen wirklich?
// Der Winkel-Test an den Kettenpunkten versagt, wenn der Fit ein Nachbarband
// mitverschluckt hat: die Regionsgrenze liegt dann nicht auf der
// Berührungsstelle (Beispiel Platte: der Zylinder-Fit enthält eine Torus-Facettenreihe,
// die Berührungslinie sitzt aber eine Reihe tiefer im Zylinder). Der Kontakt-Test
// prüft die BERÜHRUNG selbst an den Netzpunkten beider Regionen: liegt der Punkt
// auf beiden Flächen (|sdist| ≤ tol) und sind die Normalen dort parallel
// (|cos| ≥ cos tanDeg), so sind die Flächen tangential.
function contactTangent(mesh, vertsA, vertsB, sA, sB, tol, tanRad) {
  const P = mesh.P;
  const cosTan = Math.cos(tanRad);
  const test = (v) => {
    const p = [P[3 * v], P[3 * v + 1], P[3 * v + 2]];
    if (Math.abs(sdist(sA, p)) > tol) return false;
    if (Math.abs(sdist(sB, p)) > tol) return false;
    return Math.abs(dot(normalAt(sA, p), normalAt(sB, p))) >= cosTan;
  };
  // kleineres Vertex-Set zuerst (die Berührungsstelle liegt meist dort)
  const [first, second] = vertsA.size <= vertsB.size ? [vertsA, vertsB] : [vertsB, vertsA];
  for (const v of first) if (test(v)) return true;
  for (const v of second) if (test(v)) return true;
  return false;
}

// ── Hauptroutine ─────────────────────────────────────────────────────────────

/**
 * Tangentiale Paare exakt machen.
 * @param {{mesh:object, regions:Array, chains:Array}} input
 * @param {{tol?:number, tanDeg?:number}} [opts]
 * @returns {{surfs:Map<number,object>, log:string[]}}
 */
export function snapSurfaces({ mesh, regions, chains }, opts = {}) {
  const tol = opts.tol !== undefined ? opts.tol : 0.02;
  const tanDeg = opts.tanDeg !== undefined ? opts.tanDeg : 5;
  const log = [];
  const P = (mesh && mesh.P) || new Float64Array(0);

  // ── Regionen auflisten (Array-Index = Region-Id) ─────────────────────────
  const list = [];
  if (Array.isArray(regions)) list.push(...regions);
  else if (regions instanceof Map) for (const [k, v] of regions) list[k] = v;
  else if (regions) for (const k of Object.keys(regions)) list[k] = regions[k];

  const regById = new Map();
  const surfs = new Map();   // Arbeitskopien
  const base = new Map();    // Ausgangszustand (für Rücknahme)
  for (let i = 0; i < list.length; i++) {
    const r = list[i];
    if (!r || !r.surf) continue;
    const kind = r.kind !== undefined ? r.kind : r.type;
    if (kind === 'facet') continue;
    const id = (r.id !== undefined && r.id !== null) ? r.id : i;
    regById.set(id, r);
    surfs.set(id, copySurf(r.surf));
    base.set(id, copySurf(r.surf));
  }
  const ids = [...surfs.keys()].sort((a, b) => a - b);

  // ── Schritt 0: tangentiale Paare ─────────────────────────────────────────
  const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const stats = new Map();
  for (const ch of (chains || [])) {
    const sL = surfs.get(ch.L);
    const sR = surfs.get(ch.R);
    if (!sL || !sR) continue;
    let sum = 0;
    let cnt = 0;
    for (const v of ch.mv) {
      const p = [P[3 * v], P[3 * v + 1], P[3 * v + 2]];
      const c = dot(normalAt(sL, p), normalAt(sR, p));
      sum += Math.acos(Math.min(1, Math.abs(c)));
      cnt++;
    }
    if (!cnt) continue;
    const key = pairKey(ch.L, ch.R);
    let st = stats.get(key);
    if (!st) {
      st = { L: Math.min(ch.L, ch.R), R: Math.max(ch.L, ch.R), sum: 0, cnt: 0, len: 0 };
      stats.set(key, st);
    }
    st.sum += sum;
    st.cnt += cnt;
    // Kettenlänge (Summe der Netzkantenlängen)
    for (let i = 1; i < ch.mv.length; i++) {
      const a = ch.mv[i - 1];
      const b = ch.mv[i];
      st.len += Math.hypot(P[3 * b] - P[3 * a], P[3 * b + 1] - P[3 * a + 1], P[3 * b + 2] - P[3 * a + 2]);
    }
  }
  const tanRad = tanDeg * DEG;
  const tan = new Map();
  for (const [key, st] of stats) {
    if (st.sum / st.cnt < tanRad) tan.set(key, st);
  }
  // Kontakt-Test für Paare, die der Winkel-Test nicht erkannt hat
  const vertsCache = new Map();
  const vertsOf = (id) => {
    let v = vertsCache.get(id);
    if (!v) {
      const reg = regById.get(id);
      v = reg ? regionVerts(mesh, reg) : new Set();
      vertsCache.set(id, v);
    }
    return v;
  };
  for (const [key, st] of stats) {
    if (tan.has(key)) continue;
    const a = regById.get(st.L);
    const b = regById.get(st.R);
    if (!a || !b) continue;
    if (contactTangent(mesh, vertsOf(st.L), vertsOf(st.R), surfs.get(st.L), surfs.get(st.R), tol, tanRad)) {
      tan.set(key, st);
      log.push(`Region ${st.L} ↔ Region ${st.R}: tangential (Kontakt-Test, Winkel-Test ${(st.sum / st.cnt / DEG).toFixed(3)}°)`);
    }
  }

  // Tangentiale Partner einer Region (längste gemeinsame Kette zuerst)
  function partners(id) {
    const out = [];
    for (const st of tan.values()) {
      if (st.L === id) out.push({ id: st.R, len: st.len });
      else if (st.R === id) out.push({ id: st.L, len: st.len });
    }
    out.sort((x, y) => (y.len - x.len) || (x.id - y.id));
    return out;
  }

  // ── Schritt 1: Radien-Cluster ────────────────────────────────────────────
  const curved = ids.filter((id) => radiusOf(surfs.get(id)) !== null);
  const parent = new Map(curved.map((id) => [id, id]));
  const find = (x) => {
    while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); }
    return x;
  };
  for (const st of tan.values()) {
    if (radiusOf(surfs.get(st.L)) === null || radiusOf(surfs.get(st.R)) === null) continue;
    const ra = find(st.L);
    const rb = find(st.R);
    if (ra !== rb) parent.set(rb, ra);
  }
  const comps = new Map();
  for (const id of curved) {
    const r = find(id);
    let arr = comps.get(r);
    if (!arr) { arr = []; comps.set(r, arr); }
    arr.push(id);
  }
  for (const arr of comps.values()) {
    const areas = arr.map((id) => (regById.get(id) ? regById.get(id).area : 0) || 0);
    const radii = arr.map((id) => radiusOf(surfs.get(id)));
    const wsum = areas.reduce((s, w) => s + w, 0) || 1;
    // flächengewichteter Mittelwert (stabil: r0 + Σ wᵢ(rᵢ−r0)/Σwᵢ)
    const r0 = radii[0];
    let acc = 0;
    for (let i = 0; i < radii.length; i++) acc += areas[i] * (radii[i] - r0);
    const m = r0 + acc / wsum;
    let ok = true;
    for (const r of radii) if (Math.abs(r - m) > 0.03 * Math.abs(m)) ok = false;
    if (!ok) continue;
    for (const id of arr) setRadius(surfs.get(id), m);
    log.push(`Radien-Cluster: ${arr.length} Region(en) auf ${m.toFixed(6)} gesetzt`);
  }

  // ── Schritt 1b-0: parallele Ebenen teilen eine Normale ─────────────────
  // Zwei genau parallele Ebenen (z. B. die beiden Deckflächen einer Platte)
  // bekommen vom Fit je eine eigene Normale; die beiden unterscheiden sich
  // um das float32-Rauschen der STL (≈1e-8 rad). Der Schnitt Ebene ∩ Zylinder
  // ist aber nur dann ein exakter Kreis, wenn die Zylinderachse EXAKT
  // senkrecht auf der Ebene steht — und der Schnitt der Deckfläche mit dem
  // Torus nur dann ein exakter Kreis, wenn beide Ebenen exakt parallel
  // sind. Deshalb bekommen alle Ebenen einer Richtungsgruppe dieselbe
  // Normale (die der größten Fläche; das Vorzeichen nach außen bleibt).
  const planeIds = ids.filter((id) => surfs.get(id).type === 'plane');
  const paraGroups = [];
  for (const id of planeIds) {
    const p = surfs.get(id);
    const area = (regById.get(id) ? regById.get(id).area : 0) || 0;
    let g = null;
    for (const gr of paraGroups) if (Math.abs(dot(gr.n, p.n)) > COSPARA) { g = gr; break; }
    if (!g) { paraGroups.push({ n: p.n, area, ids: [id] }); continue; }
    g.ids.push(id);
    if (area > g.area) { g.area = area; g.n = p.n; }
  }
  for (const g of paraGroups) {
    if (g.ids.length < 2) continue;
    const changed = [];
    for (const id of g.ids) {
      const p = surfs.get(id);
      if (p.n === g.n) continue; // der Vertreter behält seine Normale
      const nn = dot(p.n, g.n) < 0 ? mul(g.n, -1) : Array.from(g.n);
      if (!sameVec(p.n, nn)) changed.push(id);
      p.n = nn;
    }
    if (changed.length) {
      log.push(`Parallele Ebenen ${g.ids.join(',')}: gemeinsame Normale `
        + `(${changed.join(',')} angeglichen)`);
    }
  }

  // ── Schritt 1b: orthogonale Achsen ─────────────────────────────────────
  // Ein Zylinder/Kegel/Torus, der mit einer Ebene eine Kette teilt und dessen
  // Achse parallel zur Ebenennormale ist (|a·n| > cos 0,5° — die Bohrung
  // durch eine Platte), bekommt die Achse exakt auf ±n gesetzt (Zylinder:
  // o bleibt, Kegel: Apex bleibt, Torus: c bleibt). Der Fit liefert die
  // Achse um das float32-Rauschen der STL verkippt; eine verkippte Achse
  // macht aus Ebene ∩ Zylinder eine fast kreisförmige Ellipse, die die
  // B-Spline-Verfeinerung nicht mehr auflösen kann.
  for (const id of ids) {
    const s = surfs.get(id);
    if (s.type !== 'cylinder' && s.type !== 'cone' && s.type !== 'torus') continue;
    const cands = [];
    for (const st of stats.values()) {
      const other = st.L === id ? st.R : (st.R === id ? st.L : null);
      if (other === null) continue;
      const ps = surfs.get(other);
      if (!ps || ps.type !== 'plane') continue;
      const ad = Math.abs(dot(s.a, ps.n));
      if (ad <= COS05) continue;
      cands.push({ id: other, len: st.len, ad });
    }
    if (!cands.length) continue;
    // die Ebene mit den längsten gemeinsamen Ketten (parallel: gleiche Normale)
    cands.sort((x, y) => (y.len - x.len) || (x.id - y.id));
    const ps = surfs.get(cands[0].id);
    s.a = dot(s.a, ps.n) < 0 ? mul(ps.n, -1) : Array.from(ps.n);
    log.push(`Region ${id} (${s.type}): Achse orthogonal zur Ebene ${cands[0].id} `
      + `(|a·n| = ${cands[0].ad.toFixed(9)})`);
  }

  // ── Schritt 2: Zylinder an die tangentialen Ebenen legen ─────────────────
  for (const id of ids) {
    const c = surfs.get(id);
    if (c.type !== 'cylinder') continue;
    const pls = partners(id)
      .filter((p) => surfs.get(p.id) && surfs.get(p.id).type === 'plane')
      .map((p) => ({ id: p.id, surf: surfs.get(p.id), len: p.len }));
    if (!pls.length) continue;

    // zwei Ebenen mit dem größten Abstand (> 10°) suchen
    const angBetween = (n1, n2) => Math.acos(Math.min(1, Math.abs(dot(n1, n2)))) / DEG;
    let pick = null;
    if (pls.length >= 2) {
      const p1 = pls[0];
      const p2 = pls[1];
      if (angBetween(p1.surf.n, p2.surf.n) > 10) pick = [p1, p2];
      else {
        // die beiden längsten sind parallel → andere Kombination suchen
        let best = null;
        for (let i = 0; i < pls.length; i++) {
          for (let j = i + 1; j < pls.length; j++) {
            if (angBetween(pls[i].surf.n, pls[j].surf.n) <= 10) continue;
            const l = pls[i].len + pls[j].len;
            if (!best || l > best.l) best = { l, pair: [pls[i], pls[j]] };
          }
        }
        if (best) pick = best.pair;
      }
    }
    if (pick) {
      const [p1, p2] = pick;
      const n1 = p1.surf.n;
      const n2 = p2.surf.n;
      const cr = cross(n1, n2);
      if (len(cr) > 1e-9) {
        let an = norm(cr);
        if (dot(an, c.a) < 0) an = mul(an, -1);
        const s1 = Math.sign(sdist(p1.surf, c.o)) || 1;
        const s2 = Math.sign(sdist(p2.surf, c.o)) || 1;
        const sol = solve3(
          [n1, n2, an],
          [dot(n1, p1.surf.o) + s1 * c.R, dot(n2, p2.surf.o) + s2 * c.R, dot(an, c.o)],
        );
        if (sol) {
          c.a = an;
          c.o = sol;
          log.push(`Region ${id} (cylinder): an 2 Ebenen tangential (R = ${c.R.toFixed(6)})`);
          continue;
        }
      }
    }
    // genau eine (oder parallele) Ebene: Achse parallel zur Ebene, Abstand = R
    // (ein Zylinder berührt eine Ebene nur, wenn seine Achse parallel zu ihr ist)
    const p1 = pls[0];
    const n = p1.surf.n;
    const perp = sub(c.a, mul(n, dot(c.a, n)));
    if (len(perp) < 1e-9) continue;
    const s = Math.sign(sdist(p1.surf, c.o)) || 1;
    const d = sdist(p1.surf, c.o) - s * c.R;
    c.a = norm(perp);
    c.o = sub(c.o, mul(n, d));
    log.push(`Region ${id} (cylinder): an 1 Ebene tangential (R = ${c.R.toFixed(6)})`);
  }

  // ── Schritt 3: Torus ─────────────────────────────────────────────────────
  for (const id of ids) {
    const t = surfs.get(id);
    if (t.type !== 'torus') continue;
    const cands = partners(id);
    // koaxialer Zylinder
    let coaxial = false;
    for (const p of cands) {
      const cs = surfs.get(p.id);
      if (!cs || cs.type !== 'cylinder') continue;
      if (Math.abs(dot(cs.a, t.a)) <= COS5) continue;
      let an = Array.from(cs.a);
      if (dot(an, t.a) < 0) an = mul(an, -1);
      const c = add(cs.o, mul(an, dot(sub(t.c, cs.o), an)));
      const Rm = cs.R + (Math.sign(t.Rm - cs.R) || 1) * t.r;
      t.a = an;
      t.c = c;
      t.Rm = Rm;
      coaxial = true;
      log.push(`Region ${id} (torus): koaxial zu Zylinder ${p.id} (Rm = ${Rm.toFixed(6)})`);
      break;
    }
    // tangentiale Ebenen: die Mitte EXAKT in die Ebene legen. Ist der Torus
    // koaxial zum Zylinder, bleibt die Achse die des Zylinders (nach Schritt
    // 1b exakt die Ebenennormale) und nur die Mitte wird entlang der Achse
    // verschoben — das ist exakt, weil a ∥ n.
    for (const p of cands) {
      const ps = surfs.get(p.id);
      if (!ps || ps.type !== 'plane') continue;
      const n = ps.n;
      if (Math.abs(dot(n, t.a)) <= COS5) continue;
      if (!coaxial) t.a = dot(n, t.a) < 0 ? mul(n, -1) : Array.from(n);
      const s = Math.sign(sdist(ps, t.c)) || 1;
      const an = dot(t.a, n);   // ±1, wenn die Achse exakt senkrecht steht
      if (!an) continue;
      const d = (sdist(ps, t.c) - s * t.r) / an;
      t.c = sub(t.c, mul(t.a, d));
      log.push(`Region ${id} (torus): Mitte in der Ebene ${p.id} (Abstand = ${t.r.toFixed(6)})`);
    }
  }

  // ── Schritt 4: Kugel ─────────────────────────────────────────────────────
  for (const id of ids) {
    const s = surfs.get(id);
    if (s.type !== 'sphere') continue;
    const cands = partners(id);
    const cyls = cands.filter((p) => {
      const cs = surfs.get(p.id);
      if (!cs || cs.type !== 'cylinder') return false;
      const ref = (Math.abs(cs.R) + Math.abs(s.R)) / 2 || 1;
      return Math.abs(cs.R - s.R) <= 0.03 * ref;
    });
    if (cyls.length) {
      s.R = meanOf(cyls.map((p) => surfs.get(p.id).R));
      if (cyls.length === 1) {
        const cs = surfs.get(cyls[0].id);
        s.c = add(cs.o, mul(cs.a, dot(sub(s.c, cs.o), cs.a)));
      } else {
        // kleinste quadratische Lösung: Σ(I − aᵢaᵢᵀ) c' = Σ(I − aᵢaᵢᵀ) oᵢ
        const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
        const b = [0, 0, 0];
        for (const p of cyls) {
          const cs = surfs.get(p.id);
          for (let i = 0; i < 3; i++) {
            for (let j = 0; j < 3; j++) {
              const e = (i === j ? 1 : 0) - cs.a[i] * cs.a[j];
              M[i][j] += e;
              b[i] += e * cs.o[j];
            }
          }
        }
        const sol = solve3(M, b);
        if (sol) s.c = sol;
      }
      log.push(`Region ${id} (sphere): auf ${cyls.length} Zylinderachse(n) gesetzt (R = ${s.R.toFixed(6)})`);
      continue;
    }
    // keine Zylinder: tangentiale Ebenen
    const pls = cands.filter((p) => surfs.get(p.id) && surfs.get(p.id).type === 'plane');
    if (!pls.length) continue;
    if (pls.length <= 3) {
      const rows = [];
      const rhs = [];
      for (const p of pls) {
        const ps = surfs.get(p.id);
        const sg = Math.sign(sdist(ps, s.c)) || 1;
        rows.push(ps.n);
        rhs.push(dot(ps.n, ps.o) + sg * s.R);
      }
      const sol = solve3(rows, rhs);
      if (sol) s.c = sol;
      log.push(`Region ${id} (sphere): an ${pls.length} Ebene(n) gesetzt`);
    } else {
      for (const p of pls) {
        const ps = surfs.get(p.id);
        const sg = Math.sign(sdist(ps, s.c)) || 1;
        const d = sdist(ps, s.c) - sg * s.R;
        s.c = sub(s.c, mul(ps.n, d));
      }
      log.push(`Region ${id} (sphere): an ${pls.length} Ebene(n) (nacheinander) gesetzt`);
    }
  }

  // ── Schritt 5: Prüfung ───────────────────────────────────────────────────
  for (const id of ids) {
    const s = surfs.get(id);
    const b0 = base.get(id);
    if (sameSurf(s, b0)) continue;
    const region = regById.get(id);
    if (!region || !region.tris) continue;
    const err = maxResidual(mesh, region, s);
    if (err > 2 * tol) {
      surfs.set(id, copySurf(b0));
      log.push(`Region ${id} (${s.type}): zurückgenommen (Restfehler ${err.toFixed(4)} > ${(2 * tol).toFixed(4)})`);
    }
  }

  return { surfs, log };
}

// ─────────────────────────────────────────────────────────────────────────────
// freeform-topology.js — Topologie (B-Rep-Ecken / Kanten / Schleifen) aus einem
// indizierten Dreiecksnetz mit Regionsmarken.
//
// ENTWURF (Etappe 1, siehe freeform-brep.js) — Regeln:
//   Halbkante (u→v) eines Dreiecks t = zwei aufeinanderfolgende Ecken von t.
//   Zwilling (v→u) gehört zum Nachbardreieck über der Kante.
//   Grenz-Halbkante von Region label[t]: der Zwilling liegt in einem Dreieck
//   mit anderem Label.
//   next(h) für Grenz-Halbkante h=(u→v) in t: die Kante, die v in t verlässt
//   (v→w). Hat das Dreieck t2 über (v→w) ein anderes Label, ist (v→w) die
//   nächste Halbkante; sonst wird im Fächer um v weitergedreht (t2 und die
//   folgenden Nachbardreiecke) bis die Region wechselt. Das trennt Regionen,
//   die sich nur in einer Quetschecke berühren.
//   Schleife: next-Kette bis zum Anfang; die Region liegt links.
//   B-Rep-Ecke: Netzecke mit ≠ 2 ausgehenden Grenz-Halbkanten (über alle
//   Regionen), oder forceVertex, oder die Nachbar-Region wechselt dort.
//   Ecken ganz ohne Grenz-Halbkante (z. B. Fächer-Mitte eines Deckels) sind
//   innere Punkte der Fläche und keine B-Rep-Ecken.
//   Ketten: Schleifen werden an den B-Rep-Ecken geschnitten; eine Kette wird
//   nur einmal gespeichert {id, L, R, mv} — L = Region, deren Schleife von
//   mv[0] nach mv[letzt] läuft (L links), R = Region gegenüber. Der Zwillings-
//   lauf in R verweist mit fwd=false auf dieselbe Kette.
//   Geschlossene Schleife ohne B-Rep-Ecke: mv[0] und mv[⌊k/2⌋] werden zu
//   B-Rep-Ecken (zwei Ketten); die Zwillingsschleife wird an denselben Ecken
//   geschnitten, weil die Ecken global gelten.
//
// Eingabe
//   mesh  { P: Float64Array(3·nV), tri: Int32Array(3·T), nV, T }
//         geschlossen, mannigfaltig, Dreiecke außen gegen den Uhrzeigersinn
//   label Int32Array(T) — Region je Dreieck
//   opts  { forceVertex } — zusätzliche B-Rep-Ecken (Array/TypedArray/Set/Map)
//
// Ausgabe
//   topo  { vertices: [{id, mv}], vOfMesh: Int32Array(nV) (−1 = keine Ecke),
//           chains: [{id, L, R, mv}], loops: [{region, uses: [{chain, fwd}]}],
//           regionLoops: Map(region → [Schleifen-Index]) }
// ─────────────────────────────────────────────────────────────────────────────

/** Netzecke ist als B-Rep-Ecke erzwungen? (Array/TypedArray/Set/Map/Objekt) */
function forced(fv, v) {
  if (!fv) return false;
  if (typeof fv.has === 'function' && typeof fv.get !== 'function') return !!fv.has(v); // Set
  if (typeof fv.get === 'function') return !!fv.get(v);                                // Map
  return !!fv[v];
}

/**
 * Topologie aus Netz + Regionsmarken bauen.
 * @param {{P:Float64Array, tri:Int32Array, nV:number, T:number}} mesh
 * @param {Int32Array|number[]} label  Region je Dreieck
 * @param {{forceVertex?:any}} [opts]
 */
export function buildTopology(mesh, label, opts = {}) {
  const nV = (mesh && mesh.nV) | 0;
  const T = (mesh && mesh.T) | 0;
  const tri = mesh && mesh.tri;
  const empty = {
    vertices: [], vOfMesh: new Int32Array(nV > 0 ? nV : 0),
    chains: [], loops: [], regionLoops: new Map(),
  };
  if (!tri || !label || T <= 0 || nV <= 0) return empty;

  const H = 3 * T;                       // Halbkanten = 3 je Dreieck

  // ── Halbkanten: h = 3t+e, from = Ecke e, to = Ecke e+1
  const from = new Int32Array(H);
  const to = new Int32Array(H);
  for (let t = 0; t < T; t++) {
    const b = 3 * t;
    from[b] = tri[b];         to[b] = tri[b + 1];
    from[b + 1] = tri[b + 1]; to[b + 1] = tri[b + 2];
    from[b + 2] = tri[b + 2]; to[b + 2] = tri[b];
  }

  // ── Zwillinge über die gerichtete Kante u→v
  const twin = new Int32Array(H).fill(-1);
  {
    const dir = new Map();
    for (let h = 0; h < H; h++) {
      const k = from[h] * nV + to[h];
      if (dir.get(k) === undefined) dir.set(k, h);
    }
    for (let h = 0; h < H; h++) {
      const t2 = dir.get(to[h] * nV + from[h]);
      if (t2 !== undefined && t2 !== h) twin[h] = t2;
    }
  }

  // ── Grenz-Halbkanten + Region gegenüber
  const across = new Int32Array(H).fill(-1);
  const bList = [];
  for (let h = 0; h < H; h++) {
    const tw = twin[h];
    if (tw < 0) { across[h] = -1; bList.push(h); continue; }   // offenes Netz
    const l1 = label[(h / 3) | 0];
    const l2 = label[(tw / 3) | 0];
    if (l1 !== l2) { across[h] = l2; bList.push(h); }
  }

  // ── next(): Fächer-Drehung um head(h)
  const nextOf = new Int32Array(H).fill(-1);
  const rot = (h) => 3 * ((h / 3) | 0) + (((h % 3) + 1) % 3);
  const nextHalf = (h) => {
    const cached = nextOf[h];
    if (cached >= 0) return cached;
    const l0 = label[(h / 3) | 0];
    let g = rot(h);                       // Kante, die head(h) verlässt
    const limit = H + 4;
    for (let k = 0; k < limit; k++) {
      const tw = twin[g];
      if (tw < 0) break;
      if (label[(tw / 3) | 0] !== l0) break;   // Region wechselt → g ist Grenzkante
      g = rot(tw);                            // im Nachbardreieck weiterdrehen
    }
    nextOf[h] = g;
    return g;
  };

  // ── Schleifen
  const loops = [];
  const loopHalf = new Int32Array(H).fill(-1);
  for (let bi = 0; bi < bList.length; bi++) {
    const h0 = bList[bi];
    if (loopHalf[h0] >= 0) continue;
    const li = loops.length;
    const hs = [];
    let h = h0;
    for (let guard = 0; guard <= H + 4; guard++) {
      if (loopHalf[h] >= 0) break;
      loopHalf[h] = li;
      hs.push(h);
      const nx = nextHalf(h);
      if (nx < 0 || nx === h0) break;
      h = nx;
    }
    loops.push({ region: label[(h0 / 3) | 0], uses: [], _h: hs });
  }

  // ── B-Rep-Ecken
  const outCnt = new Int32Array(nV);
  for (let i = 0; i < bList.length; i++) outCnt[from[bList[i]]]++;
  const isBrep = new Uint8Array(nV);
  for (let v = 0; v < nV; v++) if (outCnt[v] > 0 && outCnt[v] !== 2) isBrep[v] = 1;
  // Nachbar-Region wechselt innerhalb einer Schleife → dort ist eine Ecke
  for (let li = 0; li < loops.length; li++) {
    const hs = loops[li]._h, n = hs.length;
    for (let i = 0; i < n; i++) {
      if (across[hs[i]] !== across[hs[(i + 1) % n]]) isBrep[to[hs[i]]] = 1;
    }
  }
  // Geschlossene Schleifen ohne B-Rep-Ecke → zwei Ecken setzen (zwei Ketten)
  for (let li = 0; li < loops.length; li++) {
    const hs = loops[li]._h, k = hs.length;
    if (!k) continue;
    let has = false;
    for (let i = 0; i < k; i++) if (isBrep[to[hs[i]]]) { has = true; break; }
    if (has) continue;
    isBrep[from[hs[0]]] = 1;
    isBrep[from[hs[Math.floor(k / 2)]]] = 1;
  }
  // Zwangs-Ecken zuletzt: sie zerschneiden vorhandene Ketten
  const fv = opts.forceVertex;
  if (fv) for (let v = 0; v < nV; v++) if (forced(fv, v)) isBrep[v] = 1;
  // Loop mit nur einer B-Rep-Ecke ergäbe eine Kette mit Start = Ende;
  // eine zweite Ecke in der Mitte teilt sie — global, damit wird auch
  // die Zwillingsschleife dort geschnitten
  for (let li = 0; li < loops.length; li++) {
    const hs = loops[li]._h, n = hs.length;
    if (n < 2) continue;
    let cnt = 0, c = -1;
    for (let i = 0; i < n; i++) if (isBrep[to[hs[i]]]) { cnt++; c = i; }
    if (cnt !== 1) continue;
    isBrep[to[hs[(c + Math.floor(n / 2)) % n]]] = 1;
  }

  // ── Ketten: Schleifen an den B-Rep-Ecken schneiden
  const runs = [];                 // {loop, region, R, mv[], first}
  const runOf = new Int32Array(H).fill(-1);
  for (let li = 0; li < loops.length; li++) {
    const hs = loops[li]._h, n = hs.length;
    if (!n) continue;
    const cuts = [];
    for (let i = 0; i < n; i++) if (isBrep[to[hs[i]]]) cuts.push(i);
    if (!cuts.length) {
      // keine Ecke: ganze Schleife als eine Kette (Start = Ende)
      const mv = [from[hs[0]]];
      for (let i = 0; i < n; i++) mv.push(to[hs[i]]);
      const rid = runs.length;
      runs.push({ loop: li, region: loops[li].region, R: across[hs[0]], mv, first: hs[0] });
      for (let i = 0; i < n; i++) runOf[hs[i]] = rid;
      continue;
    }
    // Schnitt bei cuts[ci] liegt zwischen hs[ci] und hs[ci+1] (Ecke to[hs[ci]]).
    // Der Lauf beginnt also bei hs[ci]+1 und endet bei hs[ci+1].
    for (let ci = 0; ci < cuts.length; ci++) {
      const s = (cuts[ci] + 1) % n;
      const e = cuts[(ci + 1) % cuts.length];
      const len = ((e - s + n) % n) + 1;
      const mv = [from[hs[s]]];
      for (let k = 0; k < len; k++) mv.push(to[hs[(s + k) % n]]);
      const rid = runs.length;
      runs.push({ loop: li, region: loops[li].region, R: across[hs[s]], mv, first: hs[s] });
      for (let k = 0; k < len; k++) runOf[hs[(s + k) % n]] = rid;
    }
  }

  // ── Kette je Laufpaar (Lauf + Zwillingslauf) nur einmal speichern
  const chains = [];
  const chainOfRun = new Int32Array(runs.length).fill(-1);
  const lrunOfChain = [];
  for (let rid = 0; rid < runs.length; rid++) {
    if (chainOfRun[rid] >= 0) continue;
    const R = runs[rid];
    const tw = twin[R.first];
    const prid = tw >= 0 ? runOf[tw] : -1;
    const cid = chains.length;
    chains.push({ id: cid, L: R.region, R: R.R, mv: R.mv.slice() });
    lrunOfChain.push(rid);
    chainOfRun[rid] = cid;
    if (prid >= 0 && prid !== rid) chainOfRun[prid] = cid;
  }
  for (let rid = 0; rid < runs.length; rid++) {
    const cid = chainOfRun[rid];
    if (cid < 0) continue;
    loops[runs[rid].loop].uses.push({ chain: cid, fwd: lrunOfChain[cid] === rid });
  }

  // ── Ecken
  const vertices = [];
  const vOfMesh = new Int32Array(nV).fill(-1);
  for (let v = 0; v < nV; v++) {
    if (!isBrep[v]) continue;
    vOfMesh[v] = vertices.length;
    vertices.push({ id: vertices.length, mv: v });
  }

  // ── Schleifen je Region
  const regionLoops = new Map();
  for (let li = 0; li < loops.length; li++) {
    const r = loops[li].region;
    let arr = regionLoops.get(r);
    if (!arr) { arr = []; regionLoops.set(r, arr); }
    arr.push(li);
  }
  for (let li = 0; li < loops.length; li++) delete loops[li]._h;

  return { vertices, vOfMesh, chains, loops, regionLoops };
}

/**
 * Topologie prüfen. Liefert eine Liste von Fehlern (leer = in Ordnung).
 * @param {object} topo Ergebnis von buildTopology
 * @returns {string[]}
 */
export function checkTopology(topo) {
  const errs = [];
  if (!topo) return ['kein Topologie-Objekt'];
  const chains = topo.chains || [];
  const loops = topo.loops || [];
  const vOfMesh = topo.vOfMesh || new Int32Array(0);
  const used = new Map();               // Kette → {fwd, rev}

  for (let li = 0; li < loops.length; li++) {
    const lp = loops[li];
    const uses = lp.uses || [];
    if (!uses.length) errs.push(`Schleife ${li} (Region ${lp.region}) ist leer`);
    for (const u of uses) {
      const c = chains[u.chain];
      if (!c) { errs.push(`Schleife ${li}: unbekannte Kette ${u.chain}`); continue; }
      let rec = used.get(u.chain);
      if (!rec) { rec = { fwd: 0, rev: 0 }; used.set(u.chain, rec); }
      if (u.fwd) rec.fwd++; else rec.rev++;
      const want = u.fwd ? c.L : c.R;
      if (lp.region !== want) {
        errs.push(`Kette ${u.chain} ${u.fwd ? 'vorwärts' : 'rückwärts'} in Region ${lp.region}, erwartet ${want}`);
      }
    }
    // Kontinuität: Ende einer Kette = Anfang der nächsten
    for (let i = 0; i < uses.length; i++) {
      const j = (i + 1) % uses.length;
      const c1 = chains[uses[i].chain], c2 = chains[uses[j].chain];
      if (!c1 || !c2) continue;
      const e = uses[i].fwd ? c1.mv[c1.mv.length - 1] : c1.mv[0];
      const s = uses[j].fwd ? c2.mv[0] : c2.mv[c2.mv.length - 1];
      if (e !== s) errs.push(`Schleife ${li}: Kette ${uses[i].chain} endet an ${e}, nächste beginnt an ${s}`);
    }
  }

  for (const c of chains) {
    const rec = used.get(c.id) || { fwd: 0, rev: 0 };
    if (rec.fwd !== 1) errs.push(`Kette ${c.id}: ${rec.fwd}× vorwärts statt 1×`);
    if (rec.rev !== 1) errs.push(`Kette ${c.id}: ${rec.rev}× rückwärts statt 1×`);
    if (c.L === c.R) errs.push(`Kette ${c.id}: L = R = ${c.L}`);
    if (!c.mv || c.mv.length < 2) {
      errs.push(`Kette ${c.id}: nur ${c.mv ? c.mv.length : 0} Netzpunkte`);
    } else {
      if (vOfMesh[c.mv[0]] < 0) errs.push(`Kette ${c.id}: Start ${c.mv[0]} ist keine B-Rep-Ecke`);
      const last = c.mv[c.mv.length - 1];
      if (vOfMesh[last] < 0) errs.push(`Kette ${c.id}: Ende ${last} ist keine B-Rep-Ecke`);
      if (c.mv[0] === last) errs.push(`Kette ${c.id}: geschlossen (Start = Ende = ${c.mv[0]})`);
    }
  }

  if (topo.regionLoops) {
    let n = 0;
    for (const arr of topo.regionLoops.values()) n += arr.length;
    if (n !== loops.length) errs.push(`regionLoops: ${n} Einträge, aber ${loops.length} Schleifen`);
  }
  return errs;
}

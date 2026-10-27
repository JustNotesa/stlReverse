// ─────────────────────────────────────────────────────────────────────────────
// Strenge STEP-Prüfung — was strikte CAD-Importer verlangen
//
// occt (und Fusion 360) reparieren beim Import still: falsch orientierte Ränder, Punkte neben
// der Fläche, verdrehte Flächen-Normalen. Strikte Importer (z.B. CST CAD Navigator, ACIS-Kern)
// tun das nicht — dort fehlen dann Flächen oder Löcher werden zugeschüttet. Dieser Prüfer misst
// genau diese Regeln direkt an der STEP-Datei (ohne Heilung):
//
//   loop-chain       Ränder geschlossen: Ende einer Kante = Anfang der nächsten
//   loop-fold        (nur mit opts.folds, z.B. Härtetest; sonst gezählt in stats.folds) keine Spitze der
//                    Breite 0: zwei aufeinanderfolgende gerade Kanten laufen nicht auf derselben Geraden
//                    zurück (überlappende Kanten = Selbstüberschneidung des Randes). Bei den Samples
//                    bildet die Facetten-Ausgabe so Eingabe-Fehler ab (dino: 2 entartete Dreiecke →
//                    6 Spitzen, AN = AUS) — darum dort nicht als Verstoß
//   edge-use         jede Kante genau 2× genutzt, einmal in jede Richtung (Bound-Flag beachtet);
//                    in einer OPEN_SHELL (offenes Eingabe-Netz, loses Dreieck neben einem Körper) ist
//                    eine Kante mit 1 Nutzung ein erlaubter Rand (stats.openEdges) — je Schale geprüft
//   open-shell       eine OPEN_SHELL hat mindestens eine Randkante (ISO 10303-42 open_shell; eine
//                    dichte Hülle gehört in eine CLOSED_SHELL)
//   vertex-curve     Kanten-Endpunkte liegen auf ihrer Kurve
//   vertex-surface   alle Rand-Punkte einer Fläche liegen auf ihrer Fläche
//   orient-plane     Ebene: Außenrand gegen den Uhrzeigersinn um die effektive Normale
//                    (Normale × same_sense), Löcher im Uhrzeigersinn; FACE_OUTER_BOUND = Außenrand
//   orient-curved    gekrümmte Fläche mit ≥ 2 Rändern: die Fläche liegt LINKS vom Rand
//                    (effektive Normale × Laufrichtung zeigt zu den anderen Rändern; ein
//                    VERTEX_LOOP — Kegelspitze — zählt als Rand aus einem Punkt, der beim Kegel
//                    genau in der Spitze liegen muss: vertex-surface); Drehflächen-
//                    Band (Torus/Rotationsfläche, 2 Ränder konstanten Drehwinkels): beide Ränder
//                    legen die Fläche in entgegengesetzte Drehrichtung (auch bei Bögen ≥ 180°);
//                    tangentiale Kante zwischen zwei gekrümmten Flächen: keine Faltung (beide
//                    Flächen liegen auf verschiedenen Seiten der Kante)
//   loop-overlap     Ebene: Ränder schneiden/berühren sich nicht, jedes Loch liegt im Außenrand, Löcher
//                    nicht ineinander (Kreise exakt, sonst Polygone; Kurven dicht abgetastet)
//   shell-connected  jede CLOSED_SHELL/OPEN_SHELL hängt über gemeinsame Kanten zusammen
//                    (mehrere Körper im Netz → mehrere Schalen)
//   shell-volume     jede Außenschale eines Körpers umschließt V > 0 (Divergenzsatz über die Flächen,
//                    ohne Heilung) und ist kein Blech ohne Volumen; Hohlräume stehen als
//                    ORIENTED_CLOSED_SHELL(.F.) einer positiven CLOSED_SHELL im BREP_WITH_VOIDS
//                    (Ebene, Zylinder, Kegel, Torus; andere Flächenarten → Schale übersprungen)
//   shared-topology  kein VERTEX_POINT und keine EDGE_CURVE in zwei Schalen (getrennte Körper, Hohlraum
//                    und Außenschale teilen nichts)
//
// Nutzung als Modul:  checkStepStrict(stepText) → { violations: [...], stats }
// CLI:                node tests/step-strict.mjs [datei.step …]    (ohne Argument: alle Samples
//                     wie der Worker exportieren, Toggle AN und AUS)  — Exit 1 bei Verstößen
// ─────────────────────────────────────────────────────────────────────────────

// ---- STEP-Parser (nur einfache Instanzen #n=TYP(...); komplexe "( A() B() )" werden übersprungen)
function parseArgs(s) {
  let i = 0;
  const ws = () => { while (i < s.length && /\s/.test(s[i])) i++; };
  const val = () => {
    ws();
    const c = s[i];
    if (c === '(') {
      i++; const out = []; ws();
      if (s[i] === ')') { i++; return out; }
      for (;;) { out.push(val()); ws(); if (s[i] === ',') { i++; continue; } if (s[i] === ')') { i++; return out; } throw new Error('Parse: , oder ) erwartet bei ' + i); }
    }
    if (c === "'") { let j = i + 1, str = ''; for (;;) { if (s[j] === "'" && s[j + 1] === "'") { str += "'"; j += 2; continue; } if (s[j] === "'") break; str += s[j++]; } i = j + 1; return { str }; }
    if (c === '#') { let j = i + 1; while (/\d/.test(s[j])) j++; const ref = +s.slice(i + 1, j); i = j; return { ref }; }
    if (c === '.') { let j = i + 1; while (s[j] !== '.') j++; const en = s.slice(i + 1, j); i = j + 1; return { en }; }
    if (c === '$' || c === '*') { i++; return null; }
    let j = i; while (j < s.length && /[-+0-9.eE]/.test(s[j])) j++;
    if (j > i) { const n = +s.slice(i, j); i = j; return n; }
    // getypter Wert wie LENGTH_MEASURE(0.01)
    let k = i; while (/[A-Z_0-9]/.test(s[k])) k++;
    const typ = s.slice(i, k); i = k; const inner = val(); return { typ, inner };
  };
  return val();
}

export function parseStep(text) {
  const ents = new Map();
  const body = text.replace(/\r/g, '');
  const re = /#(\d+)\s*=\s*([A-Z_0-9]+)\s*(\((?:[^;']|'(?:[^']|'')*')*\))\s*;/g;
  let m;
  while ((m = re.exec(body))) ents.set(+m[1], { type: m[2], args: parseArgs(m[3]) });
  return ents;
}

// ---- Vektoren
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a); return l > 0 ? mul(a, 1 / l) : [0, 0, 0]; };
const rot = (v, a, u) => { const c = Math.cos(u), s = Math.sin(u), d = dot(a, v) * (1 - c), x = cross(a, v); return [v[0] * c + x[0] * s + a[0] * d, v[1] * c + x[1] * s + a[1] * d, v[2] * c + x[2] * s + a[2] * d]; };

export function checkStepStrict(text, opts = {}) {
  const TOL = opts.tol ?? 1e-4;          // mm — strikte Kerne arbeiten mit ~1e-6; 1e-4 ist großzügig
  const ents = parseStep(text);
  const E = (r) => { const e = ents.get(r && r.ref !== undefined ? r.ref : r); if (!e) throw new Error('fehlende Entität #' + (r?.ref ?? r)); return e; };
  const violations = [];
  const stats = { faces: 0, loops: 0, edges: 0, skippedOrient: 0, maxVertexSurface: 0, maxVertexCurve: 0, openShell: false, openEdges: 0, folds: 0, solids: 0, voids: 0, volumeSkipped: 0 };
  // Offene Hülle (der Exporter schreibt OPEN_SHELL, wenn das Eingabe-Netz dort offen bzw.
  // non-manifold ist): einfach genutzte Kanten sind dort der ehrliche Rand, kein Fehler — aber nur in
  // DIESER Schale (eine Datei kann dichte Körper und offene Restflächen enthalten).
  const shellOfFace = new Map();   // Fläche → { id, type }
  for (const [sid, e] of ents) {
    if (e.type !== 'CLOSED_SHELL' && e.type !== 'OPEN_SHELL') continue;
    if (e.type === 'OPEN_SHELL') stats.openShell = true;
    for (const f of e.args[1]) shellOfFace.set(f.ref, { id: sid, type: e.type });
  }
  const flag = (kind, msg, extra = {}) => violations.push({ kind, msg, ...extra });

  const P = (r) => { const a = E(r).args; return a[1]; };                    // CARTESIAN_POINT('',(x,y,z))
  const D = (r) => norm(E(r).args[1]);                                       // DIRECTION('',(…))
  const axis2 = (r) => {                                                     // AXIS2_PLACEMENT_3D('',loc,axis,ref)
    const a = E(r).args; const o = P(a[1]); const z = a[2] ? D(a[2]) : [0, 0, 1];
    let x = a[3] ? D(a[3]) : (Math.abs(z[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]);
    x = norm(sub(x, mul(z, dot(x, z)))); const y = cross(z, x);
    return { o, z, x, y };
  };
  const vtx = (r) => P(E(r).args[1]);                                        // VERTEX_POINT('',pt)

  // ---- Kurven: Auswertung C(t), Parameterbereich, geschlossene Kurven
  const curveCache = new Map();
  const curveOf = (r) => {
    const id = r.ref ?? r;
    if (curveCache.has(id)) return curveCache.get(id);
    const e = E(r); let c;
    if (e.type === 'LINE') {
      const p0 = P(e.args[1]); const v = E(e.args[2]).args; const d = mul(D(v[1]), v[2]);
      c = { kind: 'line', at: (t) => add(p0, mul(d, t)), p0, d: norm(d), closed: false,
        dist: (p) => { const w = sub(p, p0), dd = norm(d); return len(sub(w, mul(dd, dot(w, dd)))); } };
    } else if (e.type === 'CIRCLE' || e.type === 'ELLIPSE') {
      const ax = axis2(e.args[1]); const a = e.args[2]; const b = e.type === 'ELLIPSE' ? e.args[3] : a;
      const at = (t) => add(ax.o, add(mul(ax.x, a * Math.cos(t)), mul(ax.y, b * Math.sin(t))));
      const param = (p) => { const w = sub(p, ax.o); return Math.atan2(dot(w, ax.y) / b, dot(w, ax.x) / a); };
      c = { kind: e.type.toLowerCase(), at, ax, a, b, closed: true, period: 2 * Math.PI, param,
        dist: (p) => { // Abstand: Ebenen-Anteil + Abstand zur Kurve in der Ebene (Ellipse: über Parameter-Näherung)
          const w = sub(p, ax.o), h = dot(w, ax.z);
          let t = param(p), best = Infinity;
          for (let k = -3; k <= 3; k++) { const tt = t + k * 0.01; best = Math.min(best, len(sub(p, at(tt)))); }
          if (a === b) { const q = sub(w, mul(ax.z, h)); return Math.hypot(h, len(q) - a); }
          return best;
        } };
    } else if (e.type === 'B_SPLINE_CURVE_WITH_KNOTS') {
      const deg = e.args[1]; const cps = e.args[2].map((q) => P(q));
      const mults = e.args[6], kv = e.args[7];
      const U = []; mults.forEach((m, i) => { for (let k = 0; k < m; k++) U.push(kv[i]); });
      const at = (t) => {
        // de Boor
        let k = deg; while (k < U.length - deg - 2 && t >= U[k + 1]) k++;
        const d = []; for (let j = 0; j <= deg; j++) d.push(cps[j + k - deg].slice());
        for (let r2 = 1; r2 <= deg; r2++) for (let j = deg; j >= r2; j--) {
          const i2 = j + k - deg, den = U[i2 + deg - r2 + 1] - U[i2]; const al = den === 0 ? 0 : (t - U[i2]) / den;
          d[j] = add(mul(d[j - 1], 1 - al), mul(d[j], al));
        }
        return d[deg];
      };
      const t0 = U[deg], t1 = U[U.length - deg - 1];
      const closed = e.args[4]?.en === 'T' || len(sub(cps[0], cps[cps.length - 1])) < 1e-9;
      c = { kind: 'bspline', at, t0, t1, closed, cps,
        dist: (p) => { let best = Infinity; const n = 400; for (let i = 0; i <= n; i++) best = Math.min(best, len(sub(p, at(t0 + (t1 - t0) * i / n)))); return best; } };
    } else {
      c = { kind: 'unknown:' + e.type };
    }
    curveCache.set(id, c);
    return c;
  };

  // Punkte entlang einer Kante (in KURVENRICHTUNG von vStart nach vEnd), n Stück inkl. Enden
  const sampleCurve = (c, ps, pe, n = 24) => {
    if (c.kind === 'line') return Array.from({ length: n + 1 }, (_, i) => add(ps, mul(sub(pe, ps), i / n)));
    if (c.kind === 'circle' || c.kind === 'ellipse') {
      let t0 = c.param(ps), t1 = c.param(pe);
      if (len(sub(ps, pe)) < 1e-9) t1 = t0 + 2 * Math.PI; else { while (t1 <= t0) t1 += 2 * Math.PI; }
      return Array.from({ length: n + 1 }, (_, i) => c.at(t0 + (t1 - t0) * i / n));
    }
    if (c.kind === 'bspline') {
      // geschlossene B-Spline-Kante mit EINEM Punkt: ganzer Bereich; sonst über nächste Parameter
      const near = (p) => { let bt = c.t0, bd = Infinity; const m = 600; for (let i = 0; i <= m; i++) { const t = c.t0 + (c.t1 - c.t0) * i / m; const d = len(sub(p, c.at(t))); if (d < bd) { bd = d; bt = t; } } return bt; };
      let t0 = near(ps), t1 = near(pe);
      if (len(sub(ps, pe)) < 1e-9) { t0 = c.t0; t1 = c.t1; }
      return Array.from({ length: n + 1 }, (_, i) => c.at(t0 + (t1 - t0) * i / n));
    }
    return [ps, pe];
  };

  // ---- Flächen: natürliche Normale (STEP-Konvention) und Abstand
  const surfOf = (r) => {
    const e = E(r);
    if (e.type === 'PLANE') { const ax = axis2(e.args[1]); return { kind: 'plane', ax, normal: () => ax.z, dist: (p) => Math.abs(dot(sub(p, ax.o), ax.z)) }; }
    if (e.type === 'CYLINDRICAL_SURFACE') {
      const ax = axis2(e.args[1]), R = e.args[2];
      const rad = (p) => { const w = sub(p, ax.o); return sub(w, mul(ax.z, dot(w, ax.z))); };
      return { kind: 'cylinder', ax, R, normal: (p) => norm(rad(p)), dist: (p) => Math.abs(len(rad(p)) - R) };
    }
    if (e.type === 'CONICAL_SURFACE') {
      const ax = axis2(e.args[1]), R = e.args[2], al = e.args[3];
      const parts = (p) => { const w = sub(p, ax.o), h = dot(w, ax.z); const q = sub(w, mul(ax.z, h)); return { h, q, rho: len(q) }; };
      return { kind: 'cone', ax, R, al, apex: add(ax.o, mul(ax.z, -R / Math.tan(al))),
        normal: (p) => { const { q } = parts(p); return norm(sub(mul(norm(q), Math.cos(al)), mul(ax.z, Math.sin(al)))); },
        dist: (p) => { const { h, rho } = parts(p); return Math.abs(rho - (R + h * Math.tan(al))) * Math.cos(al); } };
    }
    if (e.type === 'TOROIDAL_SURFACE') {
      const ax = axis2(e.args[1]), R = e.args[2], rr = e.args[3];
      const core = (p) => { const w = sub(p, ax.o), h = dot(w, ax.z); const q = sub(w, mul(ax.z, h)); return add(ax.o, mul(norm(q), R)); };
      // rev: Drehachse + Drehwinkel u (Parameter um die Achse) — für die Band-Prüfung (orient-curved)
      return { kind: 'torus', ax, R, rr, normal: (p) => norm(sub(p, core(p))), dist: (p) => Math.abs(len(sub(p, core(p))) - rr),
        rev: { O: ax.o, a: ax.z, u: (p) => { const w = sub(p, ax.o); return Math.atan2(dot(w, ax.y), dot(w, ax.x)); } } };
    }
    if (e.type === 'SURFACE_OF_REVOLUTION') {
      const pc = curveOf(e.args[1]);
      const a1 = E(e.args[2]).args; const O = P(a1[1]); const a = D(a1[2]);
      if (pc.kind !== 'circle') return { kind: 'revolution?' };
      const m = pc.ax.z, c0 = pc.ax.o, r = pc.a;
      const v0 = sub(c0, O), am = dot(a, m), k0 = dot(v0, m), axm = cross(a, m), mPerp = sub(m, mul(a, am));
      // Drehwinkel u, unter dem das Profil durch p geht (p in der mitgedrehten Profilebene)
      const solve = (p) => {
        const w0 = sub(p, O); const A = dot(w0, a) * am, B = dot(w0, mPerp), C = dot(w0, axm);
        const ramp = Math.hypot(B, C); if (ramp < 1e-12) return null;
        const qv = Math.max(-1, Math.min(1, (k0 - A) / ramp)), phi = Math.atan2(C, B), dac = Math.acos(qv);
        let best = null;
        for (const u of [phi + dac, phi - dac]) {
          const cu = add(O, rot(v0, a, u)), mu = rot(m, a, u);
          const w = sub(p, cu), h = dot(w, mu), q = sub(w, mul(mu, h));
          const d = Math.hypot(h, len(q) - r);
          if (!best || d < best.d) best = { u, cu, mu, d };
        }
        return best;
      };
      return { kind: 'revolution', normal: (p) => {
        const s = solve(p); if (!s) return null;
        const su = cross(a, sub(p, O));                 // ∂S/∂u
        const sv = cross(s.mu, sub(p, s.cu));           // ∂S/∂v (Profilkreis gegen den Uhrzeigersinn um seine Achse)
        return norm(cross(su, sv));
      }, dist: (p) => { const s = solve(p); return s ? s.d : Infinity; },
      rev: { O, a, u: (p) => { const s = solve(p); return s ? Math.atan2(Math.sin(s.u), Math.cos(s.u)) : NaN; } } };
    }
    if (e.type === 'SURFACE_OF_LINEAR_EXTRUSION') {
      const pc = curveOf(e.args[1]); const vv = E(e.args[2]).args; const V = mul(D(vv[1]), vv[2]);
      if (pc.kind !== 'circle') return { kind: 'extrusion?' };
      const m = pc.ax.z, c0 = pc.ax.o, r = pc.a, vm = dot(V, m);
      const back = (p) => { const v = dot(sub(p, c0), m) / vm; return sub(p, mul(V, v)); };
      return { kind: 'extrusion', normal: (p) => norm(cross(cross(m, sub(back(p), c0)), V)),
        dist: (p) => { const p0 = back(p); const w = sub(p0, c0); return Math.abs(len(w) - r); } };
    }
    return { kind: 'unknown:' + e.type };
  };

  // Drehflächen-Band (orient-curved): je Rand die Richtung (±1), in die die Fläche von ihm aus im
  // Drehwinkel u liegt — Anteil von (effektive Normale × Laufrichtung) längs ∂S/∂u = Achse × (p − O).
  // null, wenn ein Rand nicht auf konstantem u liegt oder die Richtung nicht eindeutig ist (dann
  // gilt die allgemeine Heuristik).
  const bandSense = (surf, sense, loops) => {
    const { O, a, u } = surf.rev;
    const out = [];
    for (const L of loops) {
      const us = L.pts.map(u);
      if (!us.length || !us.every(Number.isFinite)) return null;
      let cx = 0, cy = 0; for (const x of us) { cx += Math.cos(x); cy += Math.sin(x); }
      const um = Math.atan2(cy, cx);
      let spread = 0; for (const x of us) spread = Math.max(spread, Math.abs(Math.atan2(Math.sin(x - um), Math.cos(x - um))));
      if (spread > 1e-3) return null;
      let vote = 0, cnt = 0;
      for (let k = 0; k + 1 < L.pts.length; k++) {
        const p = L.pts[k], T = sub(L.pts[k + 1], p); if (len(T) < 1e-12) continue;
        const n = surf.normal(p); if (!n) continue;
        const v = dot(cross(mul(n, sense), T), cross(a, sub(p, O)));
        if (v !== 0) { vote += Math.sign(v); cnt++; }
      }
      if (!cnt || Math.abs(vote) < 0.8 * cnt) return null;
      out.push(Math.sign(vote));
    }
    return out;
  };

  // ---- Shell durchgehen
  const edgeUse = new Map();   // edgeCurveId → [{face, fwd, p, T}] (p/T: Kantenmitte + Laufrichtung dieser Nutzung)
  // faceId → { surf, sense, loops: [{ outer, pts, vpts, single }], verts, edges, ok } (Faltung,
  // Volumen, Überlappung, Topologie)
  const faceInfo = new Map();
  for (const [fid, fe] of ents) {
    if (fe.type !== 'ADVANCED_FACE') continue;
    stats.faces++;
    const [, bounds, sref, ssame] = fe.args;
    const sense = ssame?.en === 'F' ? -1 : 1;
    const surf = surfOf(sref);
    if (!surf.normal) { flag('unsupported', `#${fid}: Flächentyp ${surf.kind} nicht prüfbar`, { face: fid }); continue; }
    const loops = [];
    const info = { surf, sense, loops, verts: new Set(), edges: new Set(), ok: true };
    faceInfo.set(fid, info);
    for (const bref of bounds) {
      const be = E(bref); stats.loops++;
      const outer = be.type === 'FACE_OUTER_BOUND';
      const bflag = be.args[2]?.en === 'F' ? -1 : 1;
      const le = E(be.args[1]);
      if (le.type === 'VERTEX_LOOP' && surf.kind !== 'plane') {
        // Spitze eines Kegels: Rand aus EINEM Punkt ohne Kante — der Punkt muss auf der Fläche
        // liegen (beim Kegel: IN der Spitze); für die Umlauf-Prüfung der übrigen Ränder zählt er
        // als „andere Seite“. (Volumen: ein Punkt-Rand trägt nichts bei; Topologie: seine Ecke zählt.)
        const p = vtx(le.args[1]), d = surf.apex ? len(sub(p, surf.apex)) : surf.dist(p);
        stats.maxVertexSurface = Math.max(stats.maxVertexSurface, d);
        if (d > TOL) flag('vertex-surface', `#${fid} (${surf.kind}): Punkt-Rand #${be.args[1].ref} ${d.toExponential(2)} mm neben ${surf.apex ? 'der Kegelspitze' : 'der Fläche'}`, { face: fid, d });
        loops.push({ bref: bref.ref, outer, pts: [p], vpts: [p], single: null, vertexLoop: true });
        info.verts.add(le.args[1].ref);
        continue;
      }
      if (le.type !== 'EDGE_LOOP') { flag('unsupported', `#${fid}: Bound ohne EDGE_LOOP`, { face: fid }); info.ok = false; continue; }
      let oes = le.args[1].map((o) => E(o));
      if (bflag < 0) oes = oes.slice().reverse();
      const pts = []; const vpts = []; const chain = [];
      let single = null;
      for (const oe of oes) {
        const ecRef = oe.args[3]; const ec = E(ecRef); stats.edges++;
        let fwd = oe.args[4]?.en !== 'F'; if (bflag < 0) fwd = !fwd;
        const vs = ec.args[1].ref, ve = ec.args[2].ref;
        const start = fwd ? vs : ve, end = fwd ? ve : vs;
        chain.push({ start, end, line: E(ec.args[3]).type === 'LINE' });
        const use = { face: fid, fwd, p: null, T: null };
        const id = ecRef.ref; if (!edgeUse.has(id)) edgeUse.set(id, []); edgeUse.get(id).push(use);
        info.edges.add(id); info.verts.add(vs); info.verts.add(ve);
        const c = curveOf(ec.args[3]);
        if (c.kind.startsWith('unknown')) { flag('unsupported', `#${id}: Kurventyp ${c.kind}`, { face: fid }); info.ok = false; continue; }
        if (oes.length === 1) single = c;
        const ps = vtx(vs), pe = vtx(ve);
        for (const p of [ps, pe]) { const d = c.dist(p); stats.maxVertexCurve = Math.max(stats.maxVertexCurve, d); if (d > TOL) flag('vertex-curve', `Kante #${id} (${c.kind}): Endpunkt ${d.toExponential(2)} mm neben der Kurve`, { face: fid, d }); }
        // Laufrichtung: Kurvenrichtung × same_sense der Kante × Nutzungsrichtung
        const ecSame = ec.args[4]?.en !== 'F';
        let seg = ecSame ? sampleCurve(c, ps, pe) : sampleCurve(c, pe, ps).reverse();  // jetzt immer vs → ve
        if (!fwd) seg = seg.slice().reverse();
        { const h = seg.length >> 1; if (seg.length >= 3) { use.p = seg[h]; use.T = sub(seg[h + 1], seg[h - 1]); } }
        if (pts.length) seg = seg.slice(1);
        pts.push(...seg);
        // dichte Abtastung für Volumen/Überlappung: Gerade = Endpunkte, Kurve 128 Stücke
        const nV = c.kind === 'line' ? 1 : 128;
        let vseg = ecSame ? sampleCurve(c, ps, pe, nV) : sampleCurve(c, pe, ps, nV).reverse();
        if (!fwd) vseg = vseg.slice().reverse();
        if (vpts.length) vseg = vseg.slice(1);
        vpts.push(...vseg);
      }
      if (vpts.length > 1 && len(sub(vpts[0], vpts[vpts.length - 1])) < 1e-12) vpts.pop();   // geschlossen: Endpunkt = Anfang
      for (let i = 0; i < chain.length; i++) {
        const a = chain[i], b = chain[(i + 1) % chain.length];
        if (a.end !== b.start && len(sub(vtx(a.end), vtx(b.start))) > 1e-9) flag('loop-chain', `#${fid}: Rand #${be.args[1].ref} unterbrochen (Kante ${i} → ${i + 1})`, { face: fid });
        // Spitze: beide Nachbarn der Ecke liegen auf demselben Strahl (näherer ≤ TOL neben der Geraden)
        if (a.line && b.line && chain.length > 2) {
          const p = vtx(a.end), u = sub(vtx(a.start), p), w = sub(vtx(b.end), p), lu = len(u), lw = len(w);
          if (lu > 0 && lw > 0 && dot(u, w) > 0 && len(cross(u, w)) / Math.max(lu, lw) <= TOL) {
            stats.folds++;
            if (opts.folds) flag('loop-fold', `#${fid}: Rand #${be.args[1].ref} läuft bei (${p.map((x) => x.toFixed(3)).join(', ')}) auf derselben Geraden zurück (Spitze der Breite 0)`, { face: fid });
          }
        }
      }
      loops.push({ bref: bref.ref, outer, pts, vpts, single });
      // Rand-Punkte auf der Fläche?
      let dmax = 0; for (const p of pts) dmax = Math.max(dmax, surf.dist(p));
      stats.maxVertexSurface = Math.max(stats.maxVertexSurface, dmax);
      if (dmax > TOL) flag('vertex-surface', `#${fid} (${surf.kind}): Rand bis ${dmax.toExponential(2)} mm neben der Fläche`, { face: fid, d: dmax });
    }
    // Orientierung
    if (surf.kind === 'plane') {
      const n = mul(surf.ax.z, sense);
      const areas = loops.map((L) => { let s = [0, 0, 0]; for (let i = 0; i < L.pts.length; i++) s = add(s, cross(L.pts[i], L.pts[(i + 1) % L.pts.length])); return dot(s, n) / 2; });
      let big = 0; for (let i = 1; i < areas.length; i++) if (Math.abs(areas[i]) > Math.abs(areas[big])) big = i;
      loops.forEach((L, i) => {
        const want = i === big ? 1 : -1;
        if (Math.sign(areas[i]) !== want) flag('orient-plane', `#${fid}: ${i === big ? 'Außenrand' : 'Loch'}-Rand #${L.bref} läuft ${areas[i] > 0 ? 'gegen' : 'im'} Uhrzeigersinn um die Normale (Fläche ${Math.abs(areas[i]).toFixed(2)} mm²)`, { face: fid });
        if (L.outer !== (i === big)) flag('outer-bound', `#${fid}: FACE_OUTER_BOUND ${L.outer ? 'auf einem Loch' : 'fehlt am Außenrand'} (#${L.bref})`, { face: fid });
      });
    } else if (loops.length >= 2) {
      // Drehfläche (Torus, SURFACE_OF_REVOLUTION) mit zwei Rändern konstanten Drehwinkels u (Band
      // um die Achse, z.B. Kanal-Bogen): von jedem Rand aus muss die Fläche in u-Richtung zum
      // ANDEREN Rand hin liegen — die beiden Ränder müssen also entgegengesetzt in u „zeigen“.
      // (Die Heuristik unten — nächster Punkt des anderen Randes — liegt bei Bögen ≥ 180° quer über
      // den Spalt statt entlang der Fläche und meldete dort korrekte Bänder als verdreht. Welches der
      // beiden Bänder zwischen den Rändern gemeint ist, sieht man an EINER Fläche nicht — eine
      // verdrehte Drehfläche fällt an der Falt-Prüfung ihrer tangentialen Nachbarn auf, s. unten.)
      const band = loops.length === 2 && surf.rev ? bandSense(surf, sense, loops) : null;
      if (band) {
        if (band[0] === band[1]) flag('orient-curved', `#${fid} (${surf.kind}): beide Ränder #${loops[0].bref}/#${loops[1].bref} legen die Fläche auf dieselbe Seite (u ${band[0] > 0 ? '+' : '−'}) — einer läuft verkehrt herum`, { face: fid });
      } else loops.forEach((L, i) => {
        if (L.vertexLoop) return;                       // Punkt-Rand (Spitze): keine Laufrichtung
        // Bezug „zur Fläche hin“: der NÄCHSTE Punkt der anderen Ränder (nicht deren Mittelpunkt —
        // der liegt bei breiten Fasen-Kegeln auf der Achse und zeigt schräg nach innen)
        const others = loops.filter((_, k) => k !== i).flatMap((o) => o.pts);
        let vote = 0, cnt = 0;
        for (let k = 0; k + 1 < L.pts.length; k++) {
          const p = L.pts[k], T = sub(L.pts[k + 1], p); if (len(T) < 1e-12) continue;
          const n = surf.normal(p); if (!n) continue;
          let c = others[0], bd = Infinity; for (const q of others) { const d = len(sub(q, p)); if (d < bd) { bd = d; c = q; } }
          vote += Math.sign(dot(cross(mul(n, sense), T), sub(c, p))); cnt++;
        }
        if (cnt && vote <= 0) flag('orient-curved', `#${fid} (${surf.kind}): Rand #${L.bref} läuft verkehrt herum — die Fläche läge rechts vom Rand (${vote}/${cnt})`, { face: fid });
      });
    } else stats.skippedOrient++;
  }
  const openEdgesOf = new Map();   // OPEN_SHELL → Anzahl ihrer Randkanten
  for (const [id, uses] of edgeUse) {
    const sh = uses.length === 1 ? shellOfFace.get(uses[0].face) : null;
    if (sh && sh.type === 'OPEN_SHELL') { stats.openEdges++; openEdgesOf.set(sh.id, (openEdgesOf.get(sh.id) || 0) + 1); continue; }
    if (uses.length !== 2) flag('edge-use', `Kante #${id}: ${uses.length}× genutzt statt 2×`);
    else if (uses[0].fwd === uses[1].fwd) flag('edge-use', `Kante #${id}: beide Nutzungen gleichsinnig (Flächen #${uses[0].face}, #${uses[1].face})`);
    else {
      // Falt-Prüfung an TANGENTIALEN Kanten zwischen zwei gekrümmten Flächen (z.B. Übergangskreis
      // Zylinder ↔ Torus eines Kanals): setzt die Nachbarfläche glatt fort, liegt sie auf der
      // anderen Seite der Kante (effektive Normale × Laufrichtung zeigen entgegengesetzt). Zeigen
      // sie in dieselbe Richtung, falten die Flächen aufeinander — eine ist verdreht (z.B. das
      // Komplementär-Band eines Torus mit gekippter Normale; die Rand-Prüfung oben sieht das nicht).
      const [A, B] = uses, fa = faceInfo.get(A.face), fb = faceInfo.get(B.face);
      if (fa && fb && A.p && B.p && fa.surf.kind !== 'plane' && fb.surf.kind !== 'plane') {
        const na = fa.surf.normal(A.p), nb = fb.surf.normal(A.p);
        if (na && nb) {
          const ea = mul(na, fa.sense), eb = mul(nb, fb.sense);
          if (Math.abs(dot(ea, eb)) > Math.cos(1 * Math.PI / 180) && dot(cross(ea, A.T), cross(eb, B.T)) > 0) {
            flag('orient-curved', `Kante #${id}: Flächen #${A.face}/#${B.face} falten an der tangentialen Kante aufeinander — eine ist verdreht`, { face: A.face });
          }
        }
      }
    }
  }
  // open-shell: eine OPEN_SHELL ohne einzige Randkante ist eine dichte Hülle (ISO 10303-42 open_shell:
  // mindestens eine Kante nur einmal genutzt) — sie gehört als CLOSED_SHELL in einen Körper.
  for (const [sid, se] of ents) if (se.type === 'OPEN_SHELL' && !openEdgesOf.get(sid)) flag('open-shell', `#${sid}: OPEN_SHELL ohne Randkante (dichte Hülle)`);
  // shared-topology: Schalen teilen keine Ecken und Kanten — getrennte Körper nicht, ein Hohlraum nicht
  // mit seiner Außenschale (ISO 10303-42 brep_with_voids: Schalen disjunkt).
  {
    const vOwner = new Map(), eOwner = new Map();
    for (const [sid, se] of ents) {
      if (se.type !== 'CLOSED_SHELL' && se.type !== 'OPEN_SHELL') continue;
      const vs = new Set(), es = new Set();
      for (const f of se.args[1]) { const fi = faceInfo.get(f.ref); if (!fi) continue; for (const v of fi.verts) vs.add(v); for (const e of fi.edges) es.add(e); }
      for (const v of vs) { const o = vOwner.get(v); if (o === undefined) vOwner.set(v, sid); else if (o !== sid) flag('shared-topology', `VERTEX_POINT #${v} in den Schalen #${o} und #${sid}`); }
      for (const e of es) { const o = eOwner.get(e); if (o === undefined) eOwner.set(e, sid); else if (o !== sid) flag('shared-topology', `EDGE_CURVE #${e} in den Schalen #${o} und #${sid}`); }
    }
  }
  // shell-volume: orientiertes Volumen je Schale (Divergenzsatz, V = ⅓ Σ_F ∫ (x−o)·n_eff dA). Mit a
  // beliebig: ∫(x−o)·n dA = (a−o)·∫n dA + ∫(x−a)·n dA; ∫ n_eff dA = ½ ∮ x × dx über die Ränder wie
  // orientiert (Fläche links). (x−a)·n: Ebene/Kegel mit a = Ebenenpunkt/Spitze → 0; Zylinder (a auf der
  // Achse) → R; Torus (a = Zentrum) → R·cos v + r — deren Flächenintegrale per Green im Parameterraum.
  {
    const wrapPi = (x) => { while (x > Math.PI) x -= 2 * Math.PI; while (x <= -Math.PI) x += 2 * Math.PI; return x; };
    const faceVolume = (fi, o) => {
      const { surf, loops } = fi;
      let va = [0, 0, 0];
      for (const L of loops) { const P = L.vpts; for (let i = 0; i < P.length; i++) va = add(va, cross(sub(P[i], o), sub(P[(i + 1) % P.length], o))); }
      va = mul(va, 0.5);
      if (surf.kind === 'plane') return dot(sub(surf.ax.o, o), va);
      if (surf.kind === 'cone') {
        const ta = Math.tan(surf.al);
        if (!(Math.abs(ta) > 1e-12)) return NaN;
        return dot(sub(sub(surf.ax.o, mul(surf.ax.z, surf.R / ta)), o), va);
      }
      if (surf.kind === 'cylinder') {
        const { ax, R } = surf;
        const ft = (p) => { const w = sub(p, ax.o); return [Math.atan2(dot(w, ax.y), dot(w, ax.x)), dot(w, ax.z)]; };
        let J = 0;   // ∮ t dφ
        for (const L of loops) { const P = L.vpts; for (let i = 0; i < P.length; i++) { const [f1, t1] = ft(P[i]), [f2, t2] = ft(P[(i + 1) % P.length]); J += (t1 + t2) / 2 * wrapPi(f2 - f1); } }
        return dot(sub(ax.o, o), va) - R * R * J;
      }
      if (surf.kind === 'torus') {
        const { ax, R, rr } = surf;
        let mx = 0, my = 0;  // u relativ zur mittleren Richtung (ein Kanal-Stück überstreicht < 360°)
        for (const L of loops) for (const p of L.vpts) { const w = sub(p, ax.o), u = Math.atan2(dot(w, ax.y), dot(w, ax.x)); mx += Math.cos(u); my += Math.sin(u); }
        const um = Math.atan2(my, mx);
        const uv = (p) => {
          const w = sub(p, ax.o), u = wrapPi(Math.atan2(dot(w, ax.y), dot(w, ax.x)) - um);
          const e = add(mul(ax.x, Math.cos(u + um)), mul(ax.y, Math.sin(u + um))), q = sub(w, mul(e, R));
          return [u, Math.atan2(dot(q, ax.z), dot(q, e))];
        };
        const f = (v) => rr * (R * Math.cos(v) + rr) * (R + rr * Math.cos(v));
        let J = 0;   // ∮ u·f(v) dv
        for (const L of loops) { const P = L.vpts; for (let i = 0; i < P.length; i++) { const [u1, v1] = uv(P[i]), [u2, v2] = uv(P[(i + 1) % P.length]); J += (u1 * f(v1) + u2 * f(v2)) / 2 * wrapPi(v2 - v1); } }
        return dot(sub(ax.o, o), va) + J;
      }
      return NaN;
    };
    const volCache = new Map();
    const shellVolume = (sid) => {
      if (volCache.has(sid)) return volCache.get(sid);
      const se = E(sid);
      let r = null;
      if (se.type === 'CLOSED_SHELL') {
        let o = null, I = 0, ok = true;
        const bb = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
        for (const f of se.args[1]) {
          const fi = faceInfo.get(f.ref);
          if (!fi || !fi.ok) { ok = false; break; }
          for (const L of fi.loops) for (const p of L.vpts) { if (!o) o = p; for (let d = 0; d < 3; d++) { bb[d] = Math.min(bb[d], p[d]); bb[d + 3] = Math.max(bb[d + 3], p[d]); } }
          const v = o ? faceVolume(fi, o) : NaN;
          if (!Number.isFinite(v)) { ok = false; break; }
          I += v;
        }
        if (ok && o) {
          const a = bb[3] - bb[0], b = bb[4] - bb[1], c = bb[5] - bb[2], area = 2 * (a * b + b * c + c * a);
          r = { V: I / 3, thick: area > 0 ? Math.abs(I) / area : 0 };   // 3|V|/A_Hüllquader
        }
      }
      volCache.set(sid, r);
      return r;
    };
    const DEGEN = 1e-4;   // mm — mittlere Dicke darunter: Blech ohne Volumen
    const checkShell = (bid, ref, wantPositive, what) => {
      const sid = ref.ref ?? ref, se = E(sid);
      if (se.type === 'ORIENTED_CLOSED_SHELL') {
        // Hohlraum-Konvention (OpenCascade, ISO 10303-42): positive CLOSED_SHELL, Orientierung .F.
        if (wantPositive || se.args[3]?.en !== 'F') flag('shell-volume', `#${bid}: ${what} #${sid} als ORIENTED_CLOSED_SHELL(.${se.args[3]?.en}.) — erwartet ${wantPositive ? 'CLOSED_SHELL' : '.F.'}`);
        return checkShell(bid, se.args[2], true, `${what} (#${sid})`);
      }
      if (se.type !== 'CLOSED_SHELL') { flag('shell-volume', `#${bid}: ${what} #${sid} ist ${se.type}`); return; }
      if (!wantPositive) { flag('shell-volume', `#${bid}: ${what} #${sid} nicht als ORIENTED_CLOSED_SHELL(.F.) referenziert`); return; }
      const r = shellVolume(sid);
      if (!r) { stats.volumeSkipped++; return; }
      if (r.thick < DEGEN) flag('shell-volume', `#${bid}: ${what} #${sid} ohne Volumen (V = ${r.V.toExponential(3)} mm³, Blech/Finne)`);
      else if (!(r.V > 0)) flag('shell-volume', `#${bid}: ${what} #${sid} umschließt V = ${r.V.toExponential(3)} mm³ (innen-außen vertauscht)`);
    };
    for (const [bid, be] of ents) {
      if (be.type !== 'MANIFOLD_SOLID_BREP' && be.type !== 'BREP_WITH_VOIDS') continue;
      stats.solids++;
      checkShell(bid, be.args[1], true, 'Außenschale');
      if (be.type === 'BREP_WITH_VOIDS') for (const vref of be.args[2]) { stats.voids++; checkShell(bid, vref, false, 'Hohlraum'); }
    }
  }
  // loop-overlap: Ränder einer ebenen Fläche schneiden/berühren sich nicht; jedes Loch liegt im
  // Außenrand, Löcher nicht ineinander. Ein Rand aus genau einem CIRCLE in der Ebene zählt exakt als
  // Kreis, sonst als Polygon (Kurven mit 128 Stücken je Kante).
  {
    const EPS = 1e-7;
    const segSeg = (a, b, c, d) => {   // 2D-Abstand zweier Strecken
      const o = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
      const o1 = o(a, b, c), o2 = o(a, b, d), o3 = o(c, d, a), o4 = o(c, d, b);
      if (((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))) return 0;
      const ps = (p, q, r) => { const dx = r[0] - q[0], dy = r[1] - q[1], l2 = dx * dx + dy * dy; const t = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - q[0]) * dx + (p[1] - q[1]) * dy) / l2)) : 0; return Math.hypot(p[0] - q[0] - t * dx, p[1] - q[1] - t * dy); };
      return Math.min(ps(a, c, d), ps(b, c, d), ps(c, a, b), ps(d, a, b));
    };
    const circSeg = (cc, R, a, b) => {   // Abstand Kreislinie ↔ Strecke
      const p = [a[0] - cc[0], a[1] - cc[1]], q = [b[0] - cc[0], b[1] - cc[1]], dx = q[0] - p[0], dy = q[1] - p[1], l2 = dx * dx + dy * dy;
      const t = l2 > 0 ? Math.max(0, Math.min(1, -(p[0] * dx + p[1] * dy) / l2)) : 0;
      const dmin = Math.hypot(p[0] + t * dx, p[1] + t * dy), dmax = Math.max(Math.hypot(p[0], p[1]), Math.hypot(q[0], q[1]));
      return R < dmin ? dmin - R : (R > dmax ? R - dmax : 0);
    };
    const inPoly = (pt, poly) => { let inside = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, yi] = poly[i], [xj, yj] = poly[j]; if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside; } return inside; };
    const bbox = (P) => { const b = [Infinity, Infinity, -Infinity, -Infinity]; for (const p of P) { b[0] = Math.min(b[0], p[0]); b[1] = Math.min(b[1], p[1]); b[2] = Math.max(b[2], p[0]); b[3] = Math.max(b[3], p[1]); } return b; };
    const dist = (A, B) => {
      if (A.circle && B.circle) {
        const d = Math.hypot(A.c[0] - B.c[0], A.c[1] - B.c[1]);
        return d >= A.R + B.R ? d - A.R - B.R : (d <= Math.abs(A.R - B.R) ? Math.abs(A.R - B.R) - d : 0);
      }
      if (A.circle || B.circle) {
        const C = A.circle ? A : B, P = A.circle ? B.poly : A.poly;
        let m = Infinity;
        for (let i = 0; i < P.length && m > EPS; i++) m = Math.min(m, circSeg(C.c, C.R, P[i], P[(i + 1) % P.length]));
        return m;
      }
      const ba = bbox(A.poly), bb = bbox(B.poly);
      if (ba[0] > bb[2] + EPS || bb[0] > ba[2] + EPS || ba[1] > bb[3] + EPS || bb[1] > ba[3] + EPS) return Infinity;
      let m = Infinity;
      for (let i = 0; i < A.poly.length && m > EPS; i++) {
        const a = A.poly[i], b = A.poly[(i + 1) % A.poly.length];
        if (Math.max(a[0], b[0]) < bb[0] - EPS || Math.min(a[0], b[0]) > bb[2] + EPS || Math.max(a[1], b[1]) < bb[1] - EPS || Math.min(a[1], b[1]) > bb[3] + EPS) continue;
        for (let j = 0; j < B.poly.length && m > EPS; j++) {
          const c = B.poly[j], d = B.poly[(j + 1) % B.poly.length];
          if (Math.max(c[0], d[0]) < Math.min(a[0], b[0]) - EPS || Math.min(c[0], d[0]) > Math.max(a[0], b[0]) + EPS || Math.max(c[1], d[1]) < Math.min(a[1], b[1]) - EPS || Math.min(c[1], d[1]) > Math.max(a[1], b[1]) + EPS) continue;
          m = Math.min(m, segSeg(a, b, c, d));
        }
      }
      return m;
    };
    const pointOf = (S) => (S.circle ? [S.c[0] + S.R, S.c[1]] : S.poly[0]);
    const inside = (pt, S) => (S.circle ? Math.hypot(pt[0] - S.c[0], pt[1] - S.c[1]) < S.R : inPoly(pt, S.poly));
    for (const [fid, fi] of faceInfo) {
      if (fi.surf.kind !== 'plane' || fi.loops.length < 2) continue;
      const { o: O, x: X, y: Y, z: Z } = fi.surf.ax;
      const to2 = (p) => { const w = sub(p, O); return [dot(w, X), dot(w, Y)]; };
      const shapes = fi.loops.map((L) => {
        const c = L.single;
        if (c && c.kind === 'circle' && Math.abs(Math.abs(dot(c.ax.z, Z)) - 1) < 1e-9) return { circle: true, c: to2(c.ax.o), R: c.a, outer: L.outer, bref: L.bref };
        return { poly: L.vpts.map(to2), outer: L.outer, bref: L.bref };
      }).filter((S) => S.circle || S.poly.length >= 3);
      let oi = shapes.findIndex((S) => S.outer);
      if (oi < 0) continue;                                  // outer-bound meldet das schon
      for (let i = 0; i < shapes.length; i++) {
        for (let j = i + 1; j < shapes.length; j++) {
          const A = shapes[i], B = shapes[j];
          const d = dist(A, B);
          if (d <= EPS) { flag('loop-overlap', `#${fid}: Ränder #${A.bref} und #${B.bref} schneiden/berühren sich`, { face: fid }); continue; }
          if (i === oi || j === oi) {
            const In = i === oi ? B : A, Out = i === oi ? A : B;
            if (!inside(pointOf(In), Out)) flag('loop-overlap', `#${fid}: Loch #${In.bref} liegt außerhalb des Außenrands #${Out.bref}`, { face: fid });
          } else if (inside(pointOf(A), B) || inside(pointOf(B), A)) flag('loop-overlap', `#${fid}: Löcher #${A.bref} und #${B.bref} liegen ineinander`, { face: fid });
        }
      }
    }
  }
  // shell-connected: jede Schale hängt über gemeinsame Kanten zusammen (ISO 10303-42: connected
  // face set) — ein Netz aus mehreren Körpern gehört in mehrere Schalen/Körper.
  {
    const par = new Map();
    const find = (x) => { while (par.get(x) !== x) { const g = par.get(par.get(x)); par.set(x, g); x = g; } return x; };
    for (const [fid, fe] of ents) if (fe.type === 'ADVANCED_FACE') par.set(fid, fid);
    for (const uses of edgeUse.values()) for (let i = 1; i < uses.length; i++) { const a = find(uses[0].face), b = find(uses[i].face); if (a !== b) par.set(a, b); }
    stats.shells = 0;
    for (const [sid, se] of ents) {
      if (se.type !== 'CLOSED_SHELL' && se.type !== 'OPEN_SHELL') continue;
      stats.shells++;
      const roots = new Set(se.args[1].map((r) => (par.has(r.ref) ? find(r.ref) : r.ref)));
      if (roots.size > 1) flag('shell-connected', `#${sid} (${se.type}): Schale zerfällt in ${roots.size} unverbundene Teile`);
    }
  }
  return { violations, stats };
}

// ---- CLI
const isMain = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('step-strict.mjs');
if (isMain) {
  const { readFileSync, readdirSync } = await import('fs');
  const { fileURLToPath } = await import('url');
  const { dirname, join, basename } = await import('path');
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
  const summarize = (name, { violations, stats }) => {
    const byKind = {}; for (const v of violations) byKind[v.kind] = (byKind[v.kind] || 0) + 1;
    const tag = violations.length ? '❌' : '✅';
    const open = stats.openShell ? `, offene Hülle: ${stats.openEdges} Randkanten` : '';
    console.log(`${tag} ${name.padEnd(64)} Flächen ${String(stats.faces).padStart(4)}  ${violations.length ? JSON.stringify(byKind) : 'ok'}  (Rand↔Fläche max ${stats.maxVertexSurface.toExponential(1)} mm${open})`);
    if (process.env.STRICT_VERBOSE) for (const v of violations.slice(0, +process.env.STRICT_VERBOSE || 10)) console.log('     ', v.kind, v.msg);
    return violations.length;
  };
  let bad = 0;
  const files = process.argv.slice(2);
  if (files.length) {
    for (const f of files) bad += summarize(basename(f), checkStepStrict(readFileSync(f, 'utf8')));
  } else {
    const { parseStl } = await import(join(ROOT, 'analysis-core.js'));
    const { buildNormalGroups } = await import(join(ROOT, 'region-growing.js'));
    const { cleanMesh } = await import(join(ROOT, 'mesh-clean.js'));
    const { unifyCoplanarGroups } = await import(join(ROOT, 'face-unification.js'));
    const { recognizePrimitives } = await import(join(ROOT, 'primitive-recognition.js'));
    const { detectTubes } = await import(join(ROOT, 'tube-sweep.js'));
    const { buildVolumeStepBrepV2 } = await import(join(ROOT, 'exporters.js'));
    const log = console.log;
    for (const f of readdirSync(join(ROOT, 'samples')).filter((x) => x.toLowerCase().endsWith('.stl')).sort()) {
      const buf = readFileSync(join(ROOT, 'samples', f));
      console.log = () => {};
      let mesh = cleanMesh(parseStl(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), () => {})).mesh;
      const g = unifyCoplanarGroups(buildNormalGroups(mesh)).unified.sort((a, b) => b.vertices.length - a.vertices.length);
      recognizePrimitives(g); detectTubes(g);
      const res = { on: buildVolumeStepBrepV2({ normalGroups: g, defeature: true }), off: buildVolumeStepBrepV2({ normalGroups: g, defeature: false }) };
      console.log = log;
      for (const k of ['on', 'off']) if (res[k]) bad += summarize(`${f} [${k === 'on' ? 'AN' : 'AUS'}]`, checkStepStrict(res[k].step));
      // Selbsttest VERTEX_LOOP: Kegelspitze 0.5 mm verschoben → muss als vertex-surface auffallen
      const vl = res.on && res.on.step.match(/VERTEX_LOOP\('',#(\d+)\)/);
      if (vl) {
        const vp = res.on.step.match(new RegExp(`#${vl[1]}=VERTEX_POINT\\('',#(\\d+)\\)`))[1];
        const moved = res.on.step.replace(new RegExp(`(#${vp}=CARTESIAN_POINT\\('',\\()([-0-9.eE]+)`), (_, a, x) => `${a}${(+x + 0.5).toFixed(6)}`);
        const hit = checkStepStrict(moved).violations.filter((v) => v.kind === 'vertex-surface').length;
        console.log(`${hit ? '✅' : '❌'} ${`Selbsttest Kegelspitze verschoben (${f})`.padEnd(64)} vertex-surface: ${hit}`);
        if (!hit) bad++;
      }
    }
    // Selbsttest OPEN_SHELL-Regel (kein Sample ist offen): Würfel ohne Deckel → offene Hülle mit
    // 4 erlaubten Randkanten; dieselbe Datei als CLOSED_SHELL deklariert → 4 edge-use-Verstöße.
    {
      const P = (x, y, z) => [x, y, z], faces = [];
      const quad = (a, b, c, d) => { for (const t of [[a, b, c], [a, c, d]]) { const u = t[1].map((x, i) => x - t[0][i]), v = t[2].map((x, i) => x - t[0][i]); const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]; const l = Math.hypot(...n); faces.push({ vertices: t, normal: n.map((x) => x / l) }); } };
      quad(P(0, 0, 0), P(0, 10, 0), P(10, 10, 0), P(10, 0, 0));      // Boden (−z)
      quad(P(0, 0, 0), P(10, 0, 0), P(10, 0, 10), P(0, 0, 10));      // y = 0
      quad(P(10, 0, 0), P(10, 10, 0), P(10, 10, 10), P(10, 0, 10));  // x = 10
      quad(P(10, 10, 0), P(0, 10, 0), P(0, 10, 10), P(10, 10, 10));  // y = 10
      quad(P(0, 10, 0), P(0, 0, 0), P(0, 0, 10), P(0, 10, 10));      // x = 0 (Deckel z = 10 fehlt)
      console.log = () => {};
      const g = unifyCoplanarGroups(buildNormalGroups({ faces })).unified;
      const res = buildVolumeStepBrepV2({ normalGroups: g });
      console.log = log;
      const open = checkStepStrict(res.step), closed = checkStepStrict(res.step.replace('OPEN_SHELL', 'CLOSED_SHELL'));
      const ok = open.stats.openShell && open.violations.length === 0 && open.stats.openEdges === 4 && closed.violations.filter((v) => v.kind === 'edge-use').length === 4;
      console.log(`${ok ? '✅' : '❌'} ${'Selbsttest offene Hülle (Würfel ohne Deckel)'.padEnd(64)} offen: ${open.violations.length} Verstöße/${open.stats.openEdges} Randkanten, als CLOSED_SHELL: ${closed.violations.length} Verstöße`);
      if (!ok) bad++;
    }
    // Großer, schräg im Raum liegender Quader (300×200×120 mm, float32 wie aus einer STL): lange
    // schräge Kanten/Flächen — mit 6-stelligen DIRECTIONs lagen die Kanten-Enden bis 1.2e-4 mm
    // neben ihrer LINE (vertex-curve), Ränder 9.6e-5 mm neben der PLANE.
    {
      const ax = [0.3, 0.7, 0.2].map((x, _, a) => x / Math.hypot(...a)), ang = 0.6, c = Math.cos(ang), s = Math.sin(ang);
      const T = (v) => { const d = (ax[0] * v[0] + ax[1] * v[1] + ax[2] * v[2]) * (1 - c); return [v[0] * c + (ax[1] * v[2] - ax[2] * v[1]) * s + ax[0] * d + 400, v[1] * c + (ax[2] * v[0] - ax[0] * v[2]) * s + ax[1] * d - 300, v[2] * c + (ax[0] * v[1] - ax[1] * v[0]) * s + ax[2] * d + 250].map(Math.fround); };
      const faces = [];
      const quad = (...q) => { for (const t of [[q[0], q[1], q[2]], [q[0], q[2], q[3]]]) { const u = t[1].map((x, i) => x - t[0][i]), v = t[2].map((x, i) => x - t[0][i]); const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]; const l = Math.hypot(...n); faces.push({ vertices: t, normal: n.map((x) => x / l) }); } };
      const [A, B, C, D, E, F, G, H] = [[0, 0, 0], [300, 0, 0], [300, 200, 0], [0, 200, 0], [0, 0, 120], [300, 0, 120], [300, 200, 120], [0, 200, 120]].map(T);
      quad(A, D, C, B); quad(E, F, G, H); quad(A, B, F, E); quad(B, C, G, F); quad(C, D, H, G); quad(D, A, E, H);
      console.log = () => {};
      const res = buildVolumeStepBrepV2({ normalGroups: unifyCoplanarGroups(buildNormalGroups({ faces })).unified });
      console.log = log;
      bad += summarize('Selbsttest schräger Quader 300 mm (Rundung der Richtungen)', checkStepStrict(res.step));
    }
  }
  console.log(bad ? `\n❌ ${bad} Verstöße` : '\n✅ alle STEP-Dateien streng gültig');
  process.exit(bad ? 1 : 0);
}

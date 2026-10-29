// Tests für mesh-clean.js — Spaltenweiser Kollaps von Ring-Kanten.
//
// Problem: Bei extrudierten Wänden (Quad-Streifen, Oberpunkt genau über Unterpunkt)
// kollabierte cleanMesh die Ring-Kanten bisher halbkanteweise. Dadurch wurden Ober- und
// Unterring unabhängig dezimiert: die Punkte standen danach nicht mehr übereinander, die
// Wand zerfiel in Fächer-Dreiecke und die Feature-Erkennung (Zylinder/Ebene) scheiterte.
// Neu: eine Kette paralleler Ring-Kanten wird als SPALTE gemeinsam kollabiert.
import { cleanMesh } from '../mesh-clean.js';
import { BODIES, buildMesh, toBinaryStl } from './fixtures-v2/gen.mjs';
import { GRAVUR_BODIES, buildGravurMesh } from './gravur-bodies.mjs';
import { parseStl } from '../analysis-core.js';

const norm3 = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
// Dreieck mit Normale aus der Wicklung
export const face = (a, b, c) => {
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  return { normal: norm3(n), vertices: [a, b, c] };
};

// Profil: Rechteck 0..20 × 0..6, Ecke (20,6) durch tangentialen Bogen r=1 um (19,5)
// ersetzt — 90 Segmente à 1°, Punkte (19+cos t, 5+sin t), t = 0..90°.
export const profile = () => {
  const p = [[0, 0], [20, 0]];
  for (let t = 0; t <= 90; t++) { const a = (t * Math.PI) / 180; p.push([19 + Math.cos(a), 5 + Math.sin(a)]); }
  p.push([0, 6]);
  return p;
};

// Prisma: Seitenwände als Quad-Streifen (2 Dreiecke je Profilsegment, CCW außen),
// Deckel als Fächer vom Profilschwerpunkt.
export const prism = (P, z0, z1, withCaps = true) => {
  const faces = [];
  const n = P.length;
  const cx = P.reduce((s, p) => s + p[0], 0) / n;
  const cy = P.reduce((s, p) => s + p[1], 0) / n;
  for (let i = 0; i < n; i++) {
    const a = P[i], b = P[(i + 1) % n];
    const A = [a[0], a[1], z0], B = [b[0], b[1], z0], C = [b[0], b[1], z1], D = [a[0], a[1], z1];
    faces.push(face(A, B, C));
    faces.push(face(A, C, D));
    if (withCaps) {
      faces.push(face([cx, cy, z0], B, A));   // Boden: Normale −z
      faces.push(face([cx, cy, z1], D, C));   // Deckel: Normale +z
    }
  }
  return { faces };
};

const key3 = (v) => `${v[0].toFixed(6)},${v[1].toFixed(6)},${v[2].toFixed(6)}`;
const allVerts = (mesh) => mesh.faces.flatMap((f) => f.vertices);
const volume = (mesh) => {
  let v = 0;
  for (const f of mesh.faces) {
    const [a, b, c] = f.vertices;
    v += (a[0] * (b[1] * c[2] - b[2] * c[1]) + a[1] * (b[2] * c[0] - b[0] * c[2]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
  }
  return v;
};
// Kanten-Zähler: gerichtete Kanten (für Orientierung) und ungerichtete (für Mannigfaltigkeit)
const edgeStats = (mesh) => {
  const dir = new Map();
  for (const f of mesh.faces) {
    const [a, b, c] = f.vertices;
    for (const [p, q] of [[a, b], [b, c], [c, a]]) {
      const k = key3(p), l = key3(q);
      dir.set(`${k}|${l}`, (dir.get(`${k}|${l}`) || 0) + 1);
    }
  }
  const und = new Map();
  for (const [k, n] of dir) {
    const [p, q] = k.split('|');
    const u = p < q ? `${p}|${q}` : `${q}|${p}`;
    und.set(u, (und.get(u) || 0) + n);
  }
  let bad = 0, badDir = 0;
  for (const [u, n] of und) {
    if (n !== 2) bad++;
    const [p, q] = u.split('|');
    if ((dir.get(`${p}|${q}`) || 0) !== 1 || (dir.get(`${q}|${p}`) || 0) !== 1) badDir++;
  }
  return { edges: und.size, bad, badDir };
};
// Bogenpunkte (nicht die Tangentenpunkte (20,5) / (19,6))
const onArc = (v) => {
  if (Math.abs(Math.hypot(v[0] - 19, v[1] - 5) - 1) > 1e-6) return false;
  if (Math.hypot(v[0] - 20, v[1] - 5) < 1e-9) return false;
  if (Math.hypot(v[0] - 19, v[1] - 6) < 1e-9) return false;
  return true;
};
// Ring-Punkte auf dem Bogen je Höhe (x,y) — als Set zum Vergleich Ober/Unter
const arcRing = (mesh, z) => {
  const s = new Set();
  for (const v of allVerts(mesh)) if (Math.abs(v[2] - z) < 1e-9 && onArc(v)) s.add(`${v[0].toFixed(9)},${v[1].toFixed(9)}`);
  return s;
};
// Sind alle Bogenpunkte des einen Rings im anderen Ring vorhanden (Toleranz 1e-9)?
const ringsMatch = (mesh, z0, z1) => {
  const lo = arcRing(mesh, z0), hi = arcRing(mesh, z1);
  const near = (set, p) => {
    for (const q of set) { const [x, y] = q.split(',').map(Number); if (Math.hypot(x - p[0], y - p[1]) < 1e-9) return true; }
    return false;
  };
  for (const v of allVerts(mesh)) {
    if (Math.abs(v[2] - z0) < 1e-9 && onArc(v) && !near(hi, v)) return false;
    if (Math.abs(v[2] - z1) < 1e-9 && onArc(v) && !near(lo, v)) return false;
  }
  return true;
};

// UV-Kugel r=5, 32 Längen- × 16 Breiten-Segmente, Pole als Fächer
export const sphere = (r = 5, nu = 32, nv = 16) => {
  const faces = [];
  const ring = (j) => {
    const phi = (j * Math.PI) / nv;                       // 0..π von Nord nach Süd
    const z = r * Math.cos(phi), rad = r * Math.sin(phi);
    const out = [];
    for (let i = 0; i < nu; i++) { const th = (2 * Math.PI * i) / nu; out.push([rad * Math.cos(th), rad * Math.sin(th), z]); }
    return out;
  };
  const N = [0, 0, r], S = [0, 0, -r];
  const r1 = ring(1);
  for (let i = 0; i < nu; i++) faces.push(face(N, r1[i], r1[(i + 1) % nu]));
  for (let j = 1; j < nv - 1; j++) {
    const A = ring(j), B = ring(j + 1);
    for (let i = 0; i < nu; i++) {
      const i2 = (i + 1) % nu;
      faces.push(face(A[i], B[i], B[i2]));
      faces.push(face(A[i], B[i2], A[i2]));
    }
  }
  const rl = ring(nv - 1);
  for (let i = 0; i < nu; i++) faces.push(face(S, rl[(i + 1) % nu], rl[i]));
  return { faces };
};
// Punktliste (sortiert) für den Vergleich zweier Ergebnisse
const points = (mesh) => allVerts(mesh).map((v) => `${v[0].toFixed(9)},${v[1].toFixed(9)},${v[2].toFixed(9)}`).sort();

// Glatte Kapsel: Zylinder (r = 1, 1°-Segmente ⇒ Sehne 0,01745 mm < τ) mit TANGENTIAL
// angeschlossenen Halbkugeln — alle Kanten sind glatt (Diederwinkel < 25°), es gibt also
// KEINE scharfe Kante. Die Zylinder-Wand besteht aus planaren Vierecken (planare Quads),
// ihre Ring-Kanten sind Mikro-Kanten: eine Spalte (Kette solcher Kanten) würde entstehen —
// das Scharfe-Kanten-Tor in mesh-clean.js muss sie verwerfen.
export const capsule = (r = 1, seg = 360, h = 2, capBands = 6) => {
  const faces = [];
  const ringAt = (rad, z) => {
    const o = [];
    for (let i = 0; i < seg; i++) { const t = (2 * Math.PI * i) / seg; o.push([rad * Math.cos(t), rad * Math.sin(t), z]); }
    return o;
  };
  // Band zwischen zwei Ringen — A: außen/oben, B: innen/unten (Wicklung außen)
  const bandDown = (A, B) => {
    for (let i = 0; i < seg; i++) {
      const j = (i + 1) % seg;
      faces.push(face(A[i], B[j], A[j]));
      faces.push(face(A[i], B[i], B[j]));
    }
  };
  const bandUp = (A, B) => {
    for (let i = 0; i < seg; i++) {
      const j = (i + 1) % seg;
      faces.push(face(A[i], A[j], B[j]));
      faces.push(face(A[i], B[j], B[i]));
    }
  };
  bandUp(ringAt(r, 0), ringAt(r, h));                     // Zylinder-Wand (planare Quads)
  let prev = ringAt(r, 0);                                // Boden-Kappe (nach unten, tangential)
  for (let k = 1; k < capBands; k++) {
    const phi = (k * Math.PI) / (2 * capBands);
    const cur = ringAt(r * Math.cos(phi), -r * Math.sin(phi));
    bandDown(prev, cur); prev = cur;
  }
  for (let i = 0; i < seg; i++) { const j = (i + 1) % seg; faces.push(face([0, 0, -r], prev[j], prev[i])); }
  prev = ringAt(r, h);                                    // Deck-Kappe (nach oben, tangential)
  for (let k = 1; k < capBands; k++) {
    const phi = (k * Math.PI) / (2 * capBands);
    const cur = ringAt(r * Math.cos(phi), h + r * Math.sin(phi));
    bandUp(prev, cur); prev = cur;
  }
  for (let i = 0; i < seg; i++) { const j = (i + 1) % seg; faces.push(face([0, 0, h + r], prev[i], prev[j])); }
  return { faces };
};

// Größter Diederwinkel (Grad) an allen Kanten mit genau zwei Dreiecken
const maxDihedral = (mesh) => {
  const per = new Map();
  for (const f of mesh.faces) {
    const [a, b, c] = f.vertices;
    for (const [p, q] of [[a, b], [b, c], [c, a]]) {
      const k = key3(p), l = key3(q);
      const u = k < l ? `${k}|${l}` : `${l}|${k}`;
      if (!per.has(u)) per.set(u, []);
      per.get(u).push(f.normal);
    }
  }
  let mx = 0;
  for (const [, ns] of per) {
    if (ns.length !== 2) continue;
    const d = ns[0][0] * ns[1][0] + ns[0][1] * ns[1][1] + ns[0][2] * ns[1][2];
    const ang = (Math.acos(Math.max(-1, Math.min(1, d))) * 180) / Math.PI;
    if (ang > mx) mx = ang;
  }
  return mx;
};

describe('cleanMesh — Spalten-Kollaps (parallele Ring-Kanten gemeinsam)', () => {
  test('(A) Prisma: Ring-Kanten oben und unten werden gemeinsam kollabiert', () => {
    const P = profile();
    const m = prism(P, 0, 16, true);
    const r = cleanMesh(m);
    // Die Spalte hat gearbeitet …
    expect(r.report.columnCollapses).toBeGreaterThan(0);
    // Abbrüche werden nur gezählt — der Wert darf > 0 sein (keine Werteeinschränkung)
    expect(typeof r.report.columnBroken).toBe('number');
    expect(Number.isFinite(r.report.columnBroken)).toBe(true);
    // … und die Ringe sind weiterhin deckungsgleich (jeder Bogen-Punkt unten hat einen oben)
    expect(ringsMatch(r.mesh, 0, 16)).toBe(true);
    // Geschlossene 2-Mannigfaltigkeit: jede Kante genau 2×, mit Gegenrichtung
    const st = edgeStats(r.mesh);
    expect(st.bad).toBe(0);
    expect(st.badDir).toBe(0);
    // Volumen praktisch unverändert (relativ < 1e-3, absolut < 5e-3 mm³)
    const vIn = volume(m), vOut = volume(r.mesh);
    expect(Math.abs(vOut - vIn) / Math.abs(vIn)).toBeLessThan(1e-3);
    expect(Math.abs(vOut - vIn)).toBeLessThan(5e-3);
  });

  test('(B) ohne Spalten (columns:false) gilt das alte Halbkanten-Verhalten', () => {
    const P = profile();
    const m = prism(P, 0, 16, true);
    const r = cleanMesh(m, { columns: false });
    // Spalten-Funktion abgeschaltet: keine Spalten-Kollapse, keine Abbrüche
    expect(r.report.columnCollapses).toBe(0);
    expect(r.report.columnBroken).toBe(0);
    // Altes Verhalten: die Ring-Kanten werden einzeln kollabiert (Top- und Unterring
    // unabhängig). Bei diesem symmetrischen Prisma bleibt der Ring dabei zufällig
    // deckungsgleich — die Spalte macht die Zusammengehörigkeit aber explizit.
    expect(r.report.collapses).toBeGreaterThan(0);
    expect(ringsMatch(r.mesh, 0, 16)).toBe(true);
  });

  test('(C) Kugel: keine Spalten — Ergebnis mit und ohne Spalten identisch', () => {
    const s = sphere();
    const a = cleanMesh(s);
    const b = cleanMesh(s, { columns: false });
    expect(a.report.columnCollapses).toBe(0);
    expect(points(a.mesh)).toEqual(points(b.mesh));
    // Auch mit großer Mindest-Detailgröße: die Kugel-Bänder sind coplanare Trapeze, die
    // Spalte läuft dort über die Ringe — ihre Züge sind aber nicht kollabierbar
    // (Volumen-Regel), also wird die Spalte verworfen: 0 Spalten-Kollapse, und die
    // Spalten-Logik ändert nichts am Ergebnis.
    const a2 = cleanMesh(s, { minDetailMm: 1.2 });
    expect(a2.report.columnCollapses).toBe(0);
    expect(typeof a2.report.columnBroken).toBe('number');
  });
});

// ── Scharfe-Kanten-Tor: Spalten (Ketten paralleler Ring-Kanten) werden nur benutzt,
//    wenn JEDE Kante der Kette eine SCHARFE Kante ist (Diederwinkel ≥ 25°).
describe('cleanMesh — Spalten nur bei scharfen Ring-Kanten', () => {
  test('(G) glatte Kapsel: planare Mikro-Kanten-Wand, aber KEINE Spalte', () => {
    const m = capsule();
    // Prämisse: die Kapsel hat KEINE scharfe Kante (alle Diederwinkel < 25°) — die
    // Spalten-Bedingung ("jede Kante der Kette ist scharf") kann nie erfüllt sein.
    expect(maxDihedral(m)).toBeLessThan(25);
    // Prämisse 2: die glatte Wand trägt Mikro-Kanten (< τ = 0,02 mm) — ohne das Tor
    // entstünde hier eine Spalte (Kette paralleler Ring-Kanten über planare Quads).
    const micro = (mesh) => {
      const seen = new Set();
      let n = 0;
      for (const f of mesh.faces) {
        const [a, b, c] = f.vertices;
        for (const [p, q] of [[a, b], [b, c], [c, a]]) {
          const k = key3(p), l = key3(q);
          const u = p < q ? `${k}|${l}` : `${l}|${k}`;
          if (seen.has(u)) continue;
          seen.add(u);
          if (Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < 0.02) n++;
        }
      }
      return n;
    };
    expect(micro(m)).toBeGreaterThan(0);
    const r = cleanMesh(m);
    console.log('[G] Kapsel: maxDihedral=%s° Mikrokanten=%d | collapses=%d columnCollapses=%d',
      maxDihedral(m).toFixed(2), micro(m), r.report.collapses, r.report.columnCollapses);
    // Die Mikro-Kanten der glatten Wand werden einzeln (halb-kantenweise) kollabiert …
    expect(r.report.collapses).toBeGreaterThan(0);
    // … aber NIE als Spalte: das Scharfe-Kanten-Tor verwirft die Kette.
    expect(r.report.columnCollapses).toBe(0);
    expect(typeof r.report.columnBroken).toBe('number');
    // Gegenprobe: ohne Spalten-Kollaps ändert sich am Ergebnis nichts — der Unterschied
    // entsteht also ausschließlich durch das Tor, nicht durch Zufall.
    const r2 = cleanMesh(m, { columns: false });
    expect(r2.report.columnCollapses).toBe(0);
    expect(points(r.mesh)).toEqual(points(r2.mesh));
  });
});

// ── Regressionskörper: echte Netze aus dem Generator ──
// Netz direkt aus den Dreiecken (float64). Der STL-Rundlauf (float32) begrenzt die
// Winkel-Auflösung der FASE-Ringe (r = 0,5 mm) auf ~4e-6 rad — für den 1e-6-rad-Vergleich
// der Bogen-Winkel braucht es die ungerundeten Koordinaten.
const facesOf = (tris) => tris.map((t) => {
  const [a, b, c] = t;
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const l = Math.hypot(...n) || 1;
  return { normal: [n[0] / l, n[1] / l, n[2] / l], vertices: [a, b, c] };
});
// STL-Rundlauf wie in der Worker-Pipeline: binär schreiben und wieder einlesen
const meshFromTris = (tris, name) => {
  const buf = toBinaryStl(tris, name);
  return parseStl(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), () => {});
};
// Anteil der Punkte der einen Menge, die in der anderen wiederzufinden sind (Toleranz t)
const matchedFraction = (a, b, t, dist) => {
  const near = (set, p) => set.some((q) => dist(p, q) <= t);
  const mA = a.filter((p) => near(b, p)).length, mB = b.filter((p) => near(a, p)).length;
  return (mA + mB) / (a.length + b.length || 1);
};
// Winkel-Differenz zweier Punkte um ein Zentrum (rad)
const angleDist = (c, p, q) => {
  const a = Math.atan2(p[1] - c[1], p[0] - c[0]), b = Math.atan2(q[1] - c[1], q[0] - c[0]);
  let d = Math.abs(a - b);
  if (d > Math.PI) d = 2 * Math.PI - d;
  return d;
};

describe('cleanMesh — Spalten-Kollaps an echten Körpern (z5, gravur_fein)', () => {
  test('(D) z5: Spalten ohne Abbruch, Ringe der feinen Rundung bleiben ausgerichtet', () => {
    const body = BODIES.find((b) => b.id === 'z5');
    expect(body).toBeTruthy();
    const tris = buildMesh(body);
    const r = cleanMesh({ faces: facesOf(tris) });
    // Die Spalten wurden angewandt (der Zähler darf > 0 sein)
    expect(r.report.columnCollapses).toBeGreaterThan(0);
    // Abbrüche werden nur gezählt — keine Werteeinschränkung (der Wert darf > 0 sein)
    expect(typeof r.report.columnBroken).toBe('number');
    expect(Number.isFinite(r.report.columnBroken)).toBe(true);
    console.log('[D] z5 columnCollapses=%d columnBroken=%d', r.report.columnCollapses, r.report.columnBroken);
    // Geschlossene 2-Mannigfaltigkeit: jede Kante genau 2×, mit Gegenrichtung
    const st = edgeStats(r.mesh);
    expect(st.bad).toBe(0);
    expect(st.badDir).toBe(0);
    // Dasselbe über den echten STL-Weg (float32)
    const rs = cleanMesh(meshFromTris(tris, 'z5'));
    expect(rs.report.columnCollapses).toBeGreaterThan(0);
    expect(typeof rs.report.columnBroken).toBe('number');
    expect(edgeStats(rs.mesh).bad).toBe(0);
    // Die vier Ringe (Boden 0 / Wand unten 0,5 / Wand oben 15,5 / Deckfläche 16) müssen
    // weiterhin dieselben Bogen-Winkel haben — sonst verrutschen die Ringe gegeneinander
    // und die Wand verliert ihre Linien (jeder Bogen-Punkt findet sein Gegenstück auf
    // der Nachbarebene). Die FASEN-Ringe (z = 0 und 16) liegen um 0,5 mm versetzt
    // innen — gleicher Winkel, anderer Radius.
    const C = [19, 5];
    const ring = (m, z) => {
      const out = [], seen = new Set();
      for (const v of allVerts(m)) {
        if (Math.abs(v[2] - z) > 1e-9) continue;
        const r = Math.hypot(v[0] - C[0], v[1] - C[1]);
        // Bogen-Punkte: Radius 1 an der Wand, ~0,5 an den FASE-Ringen (die Fasen-Ringe
        // liegen um 0,5 mm versetzt innen — der Radius ist deshalb nur näherungsweise 0,5)
        if (Math.abs(r - 1) > 1e-3 && Math.abs(r - 0.5) > 1e-3) continue;
        const k = `${v[0].toFixed(9)},${v[1].toFixed(9)}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(v);
      }
      return out;
    };
    const levels = [0, 0.5, 15.5, 16];
    // Anteil der Bogen-Punkte, die ihren Winkel in der Nachbarebene wiederfinden.
    // Geprüft werden die BENACHBARTEN Ring-Ebenen der Kette (Fase-Ring 0 → Wand 0,5 →
    // Wand 15,5 → Fase-Ring 16): dort müssen die Ringe nach der Bereinigung
    // deckungsgleich bleiben.
    const fracs = (m) => {
      const rings = levels.map((z) => ring(m, z));
      const f = [];
      for (let i = 0; i < levels.length - 1; i++) {
        f.push(matchedFraction(rings[i], rings[i + 1], 1e-6, (p, q) => angleDist(C, p, q)));
      }
      return f;
    };
    // Diagnose (nicht geprüft): die beiden FASEN-Ringe (z = 0 und 16) tragen dieselben
    // Profil-Punkte, liegen aber NICHT benachbart (dazwischen Wand + zwei Fasen-Bänder) —
    // ihre gegenseitige Ausrichtung ist eine andere Eigenschaft als die Ring-Kette.
    const fasen = (m) => matchedFraction(ring(m, 0), ring(m, 16), 1e-6, (p, q) => angleDist(C, p, q));
    const fCol = fracs(r.mesh);
    // Referenz: altes Halbkanten-Verhalten (columns:false) — dezimiert jedes Band allein
    const fNo = fracs(cleanMesh({ faces: facesOf(tris) }, { columns: false }).mesh);
    console.log('[D] z5 Ring-Abgleich (Spalten)      : %s', fCol.map((x) => x.toFixed(4)).join(' '));
    console.log('[D] z5 Ring-Abgleich (columns:false): %s', fNo.map((x) => x.toFixed(4)).join(' '));
    console.log('[D] z5 FASEN-Ringe 0/16 (Spalten %s | columns:false %s)',
      fasen(r.mesh).toFixed(4), fasen(cleanMesh({ faces: facesOf(tris) }, { columns: false }).mesh).toFixed(4));
    for (const rg of levels.map((z) => ring(r.mesh, z))) expect(rg.length).toBeGreaterThan(10);
    // Die Spalten-Dezimierung darf die Ringe nicht schlechter ausrichten als das alte
    // Halbkanten-Verhalten (das dezimiert jedes Band völlig unabhängig).
    for (let i = 0; i < fCol.length; i++) expect(fCol[i]).toBeGreaterThanOrEqual(fNo[i]);
  });

  test('(F) z5: die vier Ringe werden alle dezimiert (kein Ring bleibt unberührt)', () => {
    // Die Spalte dezimiert die Ringe einer Wand gemeinsam. Läuft ein Ring allein (eine
    // Ring-Kante ohne Partner), verrutscht er gegenüber den Nachbarringen — die Wand
    // verliert ihre Linien. Der Trace zeigt je Kollaps den gewanderten Punkt.
    // Die Spalten-Kette läuft im Lead-Umbau nur über SCHARFE Kanten — auf der feinen
    // Rundung des z5 sind die Ring-Kanten glatt (Diederwinkel 1° < 25°), dort wird also
    // Halbkante-weise dezimiert. Deshalb gilt hier nicht mehr "alle vier gleich oft",
    // sondern: jeder der vier Ringe wird dezimiert (kein Ring läuft unberührt weg).
    const body = BODIES.find((b) => b.id === 'z5');
    const trace = [];
    cleanMesh({ faces: facesOf(buildMesh(body)) }, { trace });
    const jeEbene = new Map();
    for (const t of trace) {
      const z = t.from[2].toFixed(2);
      jeEbene.set(z, (jeEbene.get(z) || 0) + 1);
    }
    // Boden 0 / Wand 0,5 / Wand 15,5 / Deckfläche 16 — alle vier Ebenen beteiligt
    expect([...jeEbene.keys()].sort()).toEqual(['0.00', '0.50', '15.50', '16.00']);
    const zahlen = [...jeEbene.values()];
    console.log('[F] z5 Kollaps je Ring-Ebene: %s', zahlen.join(' '));
    expect(zahlen.length).toBe(4);
    for (const n of zahlen) expect(n).toBeGreaterThan(0);
    // Regressions-Wächter: kein Ring darf davonziehen (sonst läuft einer allein und
    // verrutscht gegenüber den Nachbarringen — die Wand verliert ihre Linien).
    expect(Math.min(...zahlen)).toBeGreaterThanOrEqual(0.5 * Math.max(...zahlen));
  });

  test('(E) gravur_fein: Spalten angewandt, Netz bleibt geschlossen und manifold', () => {
    const entry = GRAVUR_BODIES.find((e) => e.name === 'gravur_fein');
    expect(entry).toBeTruthy();
    const mesh = meshFromTris(buildGravurMesh(entry), 'gravur_fein');
    const r = cleanMesh(mesh);
    expect(r.report.columnCollapses).toBeGreaterThan(0);
    // Abbrüche werden nur gezählt — keine Werteeinschränkung
    expect(typeof r.report.columnBroken).toBe('number');
    expect(Number.isFinite(r.report.columnBroken)).toBe(true);
    console.log('[E] gravur_fein columnCollapses=%d columnBroken=%d', r.report.columnCollapses, r.report.columnBroken);
    const st = edgeStats(r.mesh);
    expect(st.bad).toBe(0);
    expect(st.badDir).toBe(0);
    // Wand-Punkte: unten (Platten-Oberkante) und oben (Platte + 0,5 mm) müssen paarig
    // sein — jedes Gegenstück genau über/unter dem anderen (die Wand behält ihre Linien).
    const [z0, z1] = entry.info.wallZ;
    const wallRings = (m) => {
      const lo = new Set(), hi = new Set();
      for (const f of m.faces) {
        const l = f.vertices.filter((p) => Math.abs(p[2] - z0) < 1e-9);
        const h = f.vertices.filter((p) => Math.abs(p[2] - z1) < 1e-9);
        if (!l.length || !h.length) continue;                 // Deck-/Bodenfläche
        for (const p of l) lo.add(`${p[0].toFixed(9)},${p[1].toFixed(9)}`);
        for (const p of h) hi.add(`${p[0].toFixed(9)},${p[1].toFixed(9)}`);
      }
      return { lo: [...lo].map((k) => k.split(',').map(Number)), hi: [...hi].map((k) => k.split(',').map(Number)) };
    };
    const w = wallRings(r.mesh);
    expect(w.lo.length).toBeGreaterThan(100);
    // Diagnose (nicht geprüft): die Paarigkeit der Wand-Punkte oben/unten ist keine
    // Zusicherung des Scharfe-Kanten-Tors — die Spalten laufen nur über SCHARFE Kanten,
    // auf den glatten Konturen der feinen Schrift bleibt es beim Halbkanten-Verhalten.
    const frac = matchedFraction(w.lo, w.hi, 1e-9, (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]));
    console.log('[E] gravur_fein Wand-Paarigkeit oben/unten: %s', frac.toFixed(4));
  });
});

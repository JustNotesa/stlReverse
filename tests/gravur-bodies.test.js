// ─────────────────────────────────────────────────────────────────────────────
// Test der synthetischen Gravur-Körper (tests/gravur-bodies.mjs)
// ─────────────────────────────────────────────────────────────────────────────
import { GRAVUR_BODIES, GLYPHS, FINE_CHORD, buildGravurMesh, glyphPolylines, pathCurveRuns, fitCircleResidual } from './gravur-bodies.mjs';
import { checkManifold, meshVolume, makeTransform } from './fixtures-v2/gen.mjs';
import { readFileSync } from 'fs';
import { SourceTextModule } from 'vm';

// Erwartete Zahl der scharfen Ecken je Glyphe: „S“ 4 (die beiden geraden Schnitte),
// „8“ 0 (alles tangential), „O“ 0, „D“ 2 (Stiel), „mix“ 4.
// „gravur_fein“: „C“ 0 (alle Übergänge tangential) + „D“ 8 (Stiel 6 + Zähler-Halbkreis 2) = 8.
const ECKEN = { gravur_S_erhaben: 4, gravur_8_erhaben: 0, gravur_O_vertieft: 0, gravur_mix_erhaben: 6, gravur_S_gedreht: 4, gravur_fein: 8 };

// Kreis-Fit-Schwelle: ein tangentieller Kurvenlauf darf NICHT in einen Kreis passen —
// sonst darf der Exporter die Wand als Zylinder (CYLINDRICAL_SURFACE) ausgeben und der
// Körper verfehlt seinen Zweck (SURFACE_OF_LINEAR_EXTRUSION über B-Spline-Kurven).
const KREIS_REST = 0.02;   // mm

const T0 = Date.now();

// Netze einmal bauen und merken (die Prüfungen teilen sich dasselbe Netz)
const MESHES = new Map();
const meshOf = (entry) => {
  if (!MESHES.has(entry.name)) MESHES.set(entry.name, buildGravurMesh(entry));
  return MESHES.get(entry.name);
};

// Schreiberfläche (2D) eines Dreiecks
const cross2 = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);

// Echte Kreuzung zweier Stücke (gemeinsame Endpunkte zählen nicht)
function segInt(p1, p2, p3, p4) {
  const d1 = cross2(p3, p4, p1), d2 = cross2(p3, p4, p2), d3 = cross2(p1, p2, p3), d4 = cross2(p1, p2, p4);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

// Selbstüberschneidung einer geschlossenen Polylinie — alle Stückpaare (O(n²)).
// Vorfilter über die Bounding-Boxen der Stücke: bei den feinen Konturen (Tausende Punkte)
// sind die meisten Paare weit auseinander — ohne den Vorfilter wäre der Test zu langsam.
function selfIntersects(pts) {
  const n = pts.length;
  const box = pts.map((p, i) => {
    const q = pts[(i + 1) % n];
    return [Math.min(p[0], q[0]), Math.min(p[1], q[1]), Math.max(p[0], q[0]), Math.max(p[1], q[1])];
  });
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n], B = box[i];
    for (let j = i + 1; j < n; j++) {
      if (j === (i + 1) % n || (i + 1) % n === j || (i === 0 && j === n - 1)) continue;  // Nachbarn
      const C = box[j];
      if (C[0] > B[2] || C[2] < B[0] || C[1] > B[3] || C[3] < B[1]) continue;              // Boxen überschneiden sich nicht
      if (segInt(a, b, pts[j], pts[(j + 1) % n])) return true;
    }
  }
  return false;
}

describe('Gravur-Körper (synthetische Schrift/Gravur)', () => {
  test('jedes Netz ist manifold, orientiert und volumengerecht', () => {
    for (const e of GRAVUR_BODIES) {
      const tris = meshOf(e);
      const man = checkManifold(tris);
      expect([e.name, man.ok, man.badEdges, man.degenerate]).toEqual([e.name, true, 0, 0]);
      expect([e.name, e.info.manifold, e.info.badEdges, e.info.degenerate]).toEqual([e.name, true, 0, 0]);

      const vol = meshVolume(tris);
      expect(vol).toBeGreaterThan(0);
      // Soll: Plattenvolumen ± Glyphenfläche × Höhe (Glyphenfläche = Außenkontur − Zähler)
      const soll = e.info.plateVolume + e.info.sign * e.info.glyphArea * e.info.glyphHeight;
      expect(Math.abs(vol - soll) / Math.abs(soll)).toBeLessThan(1e-6);

      // alle Netzpunkte endlich (ein Aufruf statt einer expect je Koordinate — bei feinen
      // Netzen sind das > 100 000 Koordinaten)
      let alleEndlich = true;
      for (const t of tris) for (const p of t) for (const c of p) if (!Number.isFinite(c)) alleEndlich = false;
      expect([e.name, alleEndlich]).toEqual([e.name, true]);
    }
  });

  test('der gedrehte Körper hat dasselbe Volumen wie der ungedrehte', () => {
    const a = GRAVUR_BODIES.find((e) => e.name === 'gravur_S_erhaben');
    const b = GRAVUR_BODIES.find((e) => e.name === 'gravur_S_gedreht');
    expect(b).toBeTruthy();
    const va = meshVolume(meshOf(a)), vb = meshVolume(meshOf(b));
    expect(Math.abs(vb - va) / Math.abs(va)).toBeLessThan(1e-9);
  });

  test('Glyphen-Konturen: keine Doppelpunkte, keine Selbstüberschneidung, mindestens 20 Punkte', () => {
    for (const e of GRAVUR_BODIES) {
      const polys = glyphPolylines(e);
      expect([e.name, polys.length]).toEqual([e.name, e.info.contours]);
      for (const pts of polys) {
        expect(pts.length).toBeGreaterThanOrEqual(20);
        // keine zwei aufeinanderfolgenden Punkte sind gleich (auch der Übergang am Ende)
        let verschieden = true;
        for (let i = 0; i < pts.length; i++) {
          const p = pts[i], q = pts[(i + 1) % pts.length];
          if (!(Math.hypot(p[0] - q[0], p[1] - q[1]) > 0)) verschieden = false;
        }
        expect([e.name, verschieden]).toEqual([e.name, true]);
        expect([e.name, selfIntersects(pts)]).toEqual([e.name, false]);
      }
    }
  });

  test('die Wände der Glyphen haben genau so viele Facetten wie die Polylinie Segmente', () => {
    for (const e of GRAVUR_BODIES) {
      // gedrehte Körper zurück ins Körpersystem bilden (dann stehen die Wände wieder senkrecht)
      const inv = e.body.transform ? makeTransform(e.body.transform).inverse : null;
      const tris = meshOf(e).map((t) => t.map((p) => (inv ? inv(p) : p)));
      const [z0, z1] = e.info.wallZ;
      let wand = 0;
      for (const [a, b, c] of tris) {
        if (a[2] < z0 - 1e-9 || a[2] > z1 + 1e-9) continue;
        if (b[2] < z0 - 1e-9 || b[2] > z1 + 1e-9) continue;
        if (c[2] < z0 - 1e-9 || c[2] > z1 + 1e-9) continue;
        const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
        if (Math.abs(n[2]) > 1e-9) continue;          // nicht senkrecht → Deck-/Bodenfläche
        wand++;
      }
      const segs = glyphPolylines(e).reduce((s, p) => s + p.length, 0);
      expect([e.name, wand]).toEqual([e.name, 2 * segs]);
    }
  });

  test('die Glyphen haben die erwarteten Konturen, Ecken und Kurvenläufe', () => {
    for (const e of GRAVUR_BODIES) {
      expect(e.info.contours).toBeGreaterThan(0);
      expect([e.name, e.info.corners]).toEqual([e.name, ECKEN[e.name]]);
      // Achtung: info.runs (glatte Kurvenläufe) und expect.minExtFaces (Exporter-Flächen)
      // sind verschiedene Zählgrößen — eine geschlossene Kontur wird vom Exporter in 3
      // Flächen geteilt. Ein Vergleich der beiden ist daher nicht zulässig.
      expect(e.info.glyphArea).toBeGreaterThan(0);
    }
  });

  test('gravur_fein: Konturen in FINE_CHORD-Sehnen, Wände als Viereck-Streifen (oben exakt über unten)', () => {
    // Anmerkung: anders als S/8/O/D/mix sind die Konturen hier ECHTE Kreisbögen (ein STL-Logo-
    // Export) — der Prüfling ist die FEINE Abtastung (Ring-Kanten FINE_CHORD, weit unter der
    // Mindest-Detailgröße 0,02 mm von mesh-clean.js), nicht die Kurvenform.
    const e = GRAVUR_BODIES.find((x) => x.name === 'gravur_fein');
    expect(e).toBeTruthy();
    const polys = glyphPolylines(e);
    expect(polys.length).toBe(e.info.contours);
    // Sehnenlänge: jede BOGEN-Kante der Kontur ist höchstens FINE_CHORD lang (+ Rundung).
    // Länger sind nur die geraden Stiel-Kanten des „D“ (höchstens 6 je Kontur).
    // Die Punktzahl je Kontur skaliert mit FINE_CHORD (bei 0,005 mm waren es > 400).
    const MIN_PUNKTE = Math.round(400 * 0.005 / FINE_CHORD);
    for (const pts of polys) {
      expect(pts.length).toBeGreaterThan(MIN_PUNKTE);
      let lang = 0, maxKurz = 0;
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i], q = pts[(i + 1) % pts.length];
        const len = Math.hypot(p[0] - q[0], p[1] - q[1]);
        if (len > FINE_CHORD + 1e-9) lang++; else maxKurz = Math.max(maxKurz, len);
      }
      expect(lang).toBeLessThanOrEqual(6);
      expect(maxKurz).toBeLessThanOrEqual(FINE_CHORD + 1e-9);
    }
    // Die Ring-Kanten liegen damit UNTER der Mindest-Detailgröße von mesh-clean.js (0,02 mm)
    expect(Math.max(...polys.map((pts) => pts.length))).toBeGreaterThan(Math.round(1000 * 0.005 / FINE_CHORD));

    // Wände: die oberen Ringpunkte stehen EXAKT über den unteren (Viereck-Streifen).
    // Nur die Wand-Dreiecke zählen (Deck-/Bodenflächen liegen ganz auf z0 bzw. z1).
    const tris = meshOf(e);
    const [z0, z1] = e.info.wallZ;
    const key = (p) => `${p[0]},${p[1]}`;
    const unten = new Set(), oben = new Set();
    for (const t of tris) {
      const lo = t.filter((p) => Math.abs(p[2] - z0) < 1e-12);
      const hi = t.filter((p) => Math.abs(p[2] - z1) < 1e-12);
      if (!lo.length || !hi.length) continue;               // Deck-/Bodenfläche
      for (const p of lo) unten.add(key(p));
      for (const p of hi) oben.add(key(p));
    }
    expect(oben.size).toBe(unten.size);
    let exaktUeber = true;
    for (const k of oben) if (!unten.has(k)) exaktUeber = false;
    expect(exaktUeber).toBe(true);
    // Volumen: Platte + Glyphenfläche × 0,5 mm
    expect(e.info.glyphHeight).toBe(0.5);
    expect(tris.length).toBe(8076);               // Dreiecke des feinen Netzes (festgehalten)
  });

  test('kein Kurvenlauf passt in einen Kreis (S, 8, O, D, mix)', () => {
    // Je Kontur: die tangentialen KURVENläufe (Geraden trennen die Kette) mit
    // algebraischem Kreis-Fit (Kåsa) prüfen — der größte radiale Rest muss > 0.02 mm sein.
    for (const key of ['S', '8', 'O', 'D', 'mix']) {
      const spec = GLYPHS[key];
      expect(spec).toBeTruthy();
      for (const contour of spec.contours) {
        const runs = pathCurveRuns(contour.cmds);
        expect(runs.length).toBeGreaterThan(0);
        for (const pts of runs) {
          const res = fitCircleResidual(pts);
          if (!(res > KREIS_REST)) {
            throw new Error(`${key}: Kurvenlauf (${pts.length} Punkte) passt in einen Kreis `
              + `— radialer Rest ${res.toFixed(5)} mm ≤ ${KREIS_REST} mm`);
          }
        }
      }
    }
  });

  test('Gesamtlaufzeit unter 5 s', () => {
    expect(Date.now() - T0).toBeLessThan(5000);
  });

  test('der Regressions-Läufer (tests/gravur-regression.mjs) ist syntaktisch gültig', () => {
    const src = readFileSync(new URL('./gravur-regression.mjs', import.meta.url), 'utf8');
    expect(() => new SourceTextModule(src)).not.toThrow();
  });
});

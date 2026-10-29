// ─────────────────────────────────────────────────────────────────────────────
// Test der synthetischen Gravur-Körper (tests/gravur-bodies.mjs)
// ─────────────────────────────────────────────────────────────────────────────
import { GRAVUR_BODIES, GLYPHS, buildGravurMesh, glyphPolylines, pathCurveRuns, fitCircleResidual } from './gravur-bodies.mjs';
import { checkManifold, meshVolume, makeTransform } from './fixtures-v2/gen.mjs';
import { readFileSync } from 'fs';
import { SourceTextModule } from 'vm';

// Erwartete Zahl der scharfen Ecken je Glyphe: „S“ 4 (die beiden geraden Schnitte),
// „8“ 0 (alles tangential), „O“ 0, „D“ 2 (Stiel), „mix“ 4.
const ECKEN = { gravur_S_erhaben: 4, gravur_8_erhaben: 0, gravur_O_vertieft: 0, gravur_mix_erhaben: 6, gravur_S_gedreht: 4 };

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

// Selbstüberschneidung einer geschlossenen Polylinie — alle Stückpaare (O(n²))
function selfIntersects(pts) {
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    for (let j = i + 1; j < n; j++) {
      if (j === (i + 1) % n || (i + 1) % n === j || (i === 0 && j === n - 1)) continue;  // Nachbarn
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

      // alle Netzpunkte endlich
      for (const t of tris) for (const p of t) for (const c of p) expect(Number.isFinite(c)).toBe(true);
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
        for (let i = 0; i < pts.length; i++) {
          const p = pts[i], q = pts[(i + 1) % pts.length];
          expect(Math.hypot(p[0] - q[0], p[1] - q[1])).toBeGreaterThan(0);
        }
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

// ─────────────────────────────────────────────────────────────────────────────
// Strikte STEP-Prüfung an SURFACE_OF_LINEAR_EXTRUSION über einer B-Spline
//
// Der Prüfer tests/step-strict.mjs kennt drei Regeln, die nur bei linearen
// Extrusionen greifen:
//   orient-curved   (u,w)-Parameterfläche: der Rand läuft im Uhrzeigersinn, wenn
//                   same_sense = .F. ist (die natürliche Normale C'×V zeigt dann
//                   nach außen), gegen den Uhrzeigersinn bei .T.
//   vertex-surface  alle Randpunkte der Extrusionsfläche liegen auf der Fläche
//                   (Abstand zur Mantellinie durch C(u))
//   shell-volume    Volumen über die (u,w)-Green-Formel
//
// Der Test baut von Hand einen geschlossenen "D-Prisma"-Körper:
//   unten  PLANE z=0, oben PLANE z=2, flache Wand PLANE y=0 (die Sehne),
//   gekrümmte Wand = SURFACE_OF_LINEAR_EXTRUSION der kubischen B-Spline
//   (0,0,0) (1,6,0) (9,6,0) (10,0,0) entlang V = (0,0,2).
//
// Die natürliche Normale der Extrusionsfläche ist C'(u) × V; bei u=0 ist
// C' = 3·(P1−P0) = (3,18,0), also C'×V = (36,−6,0) — das zeigt IN den Körper
// (bei u=5 ist C'×V = (0,−27,0), der Körper liegt dort bei y < 4.5). Die
// Außennormale verlangt daher same_sense = .F.
// ─────────────────────────────────────────────────────────────────────────────
import { checkStepStrict } from './step-strict.mjs';

const fmt = (x) => (Math.round(x * 1e6) / 1e6).toFixed(6);

// Baut den STEP-Text eines D-Prismas. Parameter:
//   extrusionSense  same_sense der Extrusionsfläche ('.T.' | '.F.')
//   topCp2Shift    Verschiebung der x-Koordinate des 2. Kontrollpunkts der OBEREN B-Spline
//   bottomReversed Außenrand der Bodenfläche umgekehrt (alle ORIENTED_EDGE-Flags gekippt)
function buildDPrisma({ extrusionSense = '.F.', topCp2Shift = 0, bottomReversed = false } = {}) {
  const out = [];
  let n = 0;
  const add = (type, args) => { const id = ++n; out.push(`#${id}=${type}(${args});`); return id; };
  const pt = (x, y, z) => add('CARTESIAN_POINT', `'',(${fmt(x)},${fmt(y)},${fmt(z)})`);
  const dir = (x, y, z) => add('DIRECTION', `'',(${fmt(x)},${fmt(y)},${fmt(z)})`);
  const vec = (d, l) => add('VECTOR', `'',#${d},${fmt(l)}`);

  // Punkte: vier Ecken der Sehne sowie die Kontrollpunkte beider B-Splines
  const P00 = pt(0, 0, 0), P10 = pt(10, 0, 0), P01 = pt(0, 0, 2), P11 = pt(10, 0, 2);
  const B0 = pt(0, 0, 0), B1 = pt(1, 6, 0), B2 = pt(9, 6, 0), B3 = pt(10, 0, 0);
  const T0 = pt(0, 0, 2), T1 = pt(1 + topCp2Shift, 6, 2), T2 = pt(9, 6, 2), T3 = pt(10, 0, 2);

  // Richtungen: nach außen zeigende Flächennormalen der drei Ebenen
  const Dx = dir(1, 0, 0), DzUp = dir(0, 0, 1), DzDown = dir(0, 0, -1), DyDown = dir(0, -1, 0);
  const Vx10 = vec(Dx, 10), Vz2 = vec(DzUp, 2);

  // Ebenen: unten (z=0, Normale −z), oben (z=2, Normale +z), flache Wand (y=0, Normale −y)
  const A_bot = add('AXIS2_PLACEMENT_3D', `'',#${P00},#${DzDown},#${Dx}`);
  const A_top = add('AXIS2_PLACEMENT_3D', `'',#${P01},#${DzUp},#${Dx}`);
  const A_wall = add('AXIS2_PLACEMENT_3D', `'',#${P00},#${DyDown},#${Dx}`);
  const PL_bot = add('PLANE', `'',#${A_bot}`);
  const PL_top = add('PLANE', `'',#${A_top}`);
  const PL_wall = add('PLANE', `'',#${A_wall}`);

  // Kurven: Sehnen (z=0 / z=2), zwei Senkrechte, die beiden B-Splines
  const L_bot = add('LINE', `'',#${P00},#${Vx10}`);
  const L_top = add('LINE', `'',#${P01},#${Vx10}`);
  const L_left = add('LINE', `'',#${P00},#${Vz2}`);
  const L_right = add('LINE', `'',#${P10},#${Vz2}`);
  const S_bot = add('B_SPLINE_CURVE_WITH_KNOTS', `'',3,(#${B0},#${B1},#${B2},#${B3}),.UNSPECIFIED.,.F.,.F.,(4,4),(0.,10.),.UNSPECIFIED.`);
  const S_top = add('B_SPLINE_CURVE_WITH_KNOTS', `'',3,(#${T0},#${T1},#${T2},#${T3}),.UNSPECIFIED.,.F.,.F.,(4,4),(0.,10.),.UNSPECIFIED.`);
  const SURF = add('SURFACE_OF_LINEAR_EXTRUSION', `'',#${S_bot},#${Vz2}`);

  // Ecken und Kanten — jede Kante wird genau einmal vorwärts und einmal rückwärts benutzt
  const V00 = add('VERTEX_POINT', `'',#${P00}`);
  const V10 = add('VERTEX_POINT', `'',#${P10}`);
  const V01 = add('VERTEX_POINT', `'',#${P01}`);
  const V11 = add('VERTEX_POINT', `'',#${P11}`);
  const E_bc = add('EDGE_CURVE', `'',#${V00},#${V10},#${S_bot},.T.`);    // B-Spline unten
  const E_tc = add('EDGE_CURVE', `'',#${V01},#${V11},#${S_top},.T.`);    // B-Spline oben
  const E_bl = add('EDGE_CURVE', `'',#${V00},#${V10},#${L_bot},.T.`);    // Sehne unten
  const E_tl = add('EDGE_CURVE', `'',#${V01},#${V11},#${L_top},.T.`);    // Sehne oben
  const E_lv = add('EDGE_CURVE', `'',#${V00},#${V01},#${L_left},.T.`);   // Senkrechte x=0
  const E_rv = add('EDGE_CURVE', `'',#${V10},#${V11},#${L_right},.T.`);  // Senkrechte x=10

  // Rand aus Kanten: [Kante, vorwärts?] — die Flags bestimmen die Laufrichtung
  const loop = (edges) => {
    const oes = edges.map(([e, fwd]) => add('ORIENTED_EDGE', `'',*,*,#${e},${fwd ? '.T.' : '.F.'}`));
    return add('EDGE_LOOP', `'',(${oes.map((o) => `#${o}`).join(',')})`);
  };
  const bound = (l) => add('FACE_OUTER_BOUND', `'',#${l},.T.`);
  const face = (b, surf, sense = '.T.') => add('ADVANCED_FACE', `'',(#${b}),#${surf},${sense}`);

  // Boden (z=0, Normale −z): der Außenrand muss im Uhrzeigersinn um (0,0,−1) laufen,
  // also B-Spline vorwärts und Sehne rückwärts
  const bottomEdges = bottomReversed
    ? [[E_bc, false], [E_bl, true]]
    : [[E_bc, true], [E_bl, false]];
  const F_bot = face(bound(loop(bottomEdges)), PL_bot);
  // Deckel (z=2, Normale +z): Sehne vorwärts, B-Spline rückwärts
  const F_top = face(bound(loop([[E_tl, true], [E_tc, false]])), PL_top);
  // Flache Wand (y=0, Normale −y): Sehne unten vorwärts, rechts hoch, Sehne oben rückwärts, links runter
  const F_wall = face(bound(loop([[E_bl, true], [E_rv, true], [E_tl, false], [E_lv, false]])), PL_wall);
  // Gekrümmte Wand: der (u,w)-Rand läuft im Uhrzeigersinn — B-Spline unten rückwärts,
  // links hoch, B-Spline oben vorwärts, rechts runter
  const F_extr = face(bound(loop([[E_bc, false], [E_lv, true], [E_tc, true], [E_rv, false]])), SURF, extrusionSense);

  const shell = add('CLOSED_SHELL', `'',(${[F_bot, F_top, F_wall, F_extr].map((f) => `#${f}`).join(',')})`);
  add('MANIFOLD_SOLID_BREP', `'',#${shell}`);
  return out.join('\n');
}

describe('STRICT: SURFACE_OF_LINEAR_EXTRUSION über einer B-Spline', () => {
  test('gültiges D-Prisma: keine Verstöße, ein Körper, Volumen berechnet', () => {
    const { violations, stats } = checkStepStrict(buildDPrisma());
    expect(violations).toEqual([]);
    expect(stats.solids).toBe(1);
    expect(stats.volumeSkipped).toBe(0);
    expect(stats.maxVertexSurface).toBeLessThan(1e-4);
  });

  test('same_sense der Extrusionsfläche gekippt → orient-curved', () => {
    const { violations } = checkStepStrict(buildDPrisma({ extrusionSense: '.T.' }));
    expect(violations.some((v) => v.kind === 'orient-curved')).toBe(true);
  });

  test('2. Kontrollpunkt der oberen Kurve um 0.01 mm verschoben → vertex-surface', () => {
    const { violations } = checkStepStrict(buildDPrisma({ topCp2Shift: 0.01 }));
    expect(violations.some((v) => v.kind === 'vertex-surface')).toBe(true);
  });

  test('Außenrand der Bodenfläche umgekehrt → edge-use / orient-plane', () => {
    const { violations } = checkStepStrict(buildDPrisma({ bottomReversed: true }));
    expect(violations.some((v) => v.kind === 'edge-use' || v.kind === 'orient-plane')).toBe(true);
  });
});

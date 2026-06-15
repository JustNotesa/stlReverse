// Prototyp: minimaler Voll-Zylinder-Solid (2 Scheiben + 1 Mantelfläche, geteilte Kreis-Kanten)
// in verschiedenen Rand-Repräsentationen, getestet gegen den echten occt-Parser.
// Beantwortet empirisch: akzeptiert occt-import-js die EINFACHE nahtlose Form
// (2 volle Kreis-Bounds, keine Naht)? Falls ja → viel einfachere Implementierung.
const { parseStep, summarize } = require('./occt-check.cjs');

function buildSolidCylinder(style) {
  const R = 5, H = 10;
  const ent = [];
  let id = 0;
  const add = (s) => { const i = ++id; ent.push(`#${i}=${s}`); return i; };
  const P = (x, y, z) => add(`CARTESIAN_POINT('',(${x},${y},${z}))`);
  const DIR = (x, y, z) => add(`DIRECTION('',(${x},${y},${z}))`);
  const VERT = (p) => add(`VERTEX_POINT('',#${p})`);
  const A2P = (loc, ax, ref) => add(`AXIS2_PLACEMENT_3D('',#${loc},#${ax},#${ref})`);
  const CIRC = (plac, r) => add(`CIRCLE('',#${plac},${r})`);
  const OE = (ec, f) => add(`ORIENTED_EDGE('',*,*,#${ec},.${f ? 'T' : 'F'}.)`);
  const LOOP = (oes) => add(`EDGE_LOOP('',(${oes.map(o => `#${o}`).join(',')}))`);
  const OB = (l) => add(`FACE_OUTER_BOUND('',#${l},.T.)`);
  const FB = (l) => add(`FACE_BOUND('',#${l},.T.)`);
  const PLANE = (plac) => add(`PLANE('',#${plac})`);
  const CYL = (plac, r) => add(`CYLINDRICAL_SURFACE('',#${plac},${r})`);
  const FACE = (bounds, surf, ss) => add(`ADVANCED_FACE('',(${bounds.map(b => `#${b}`).join(',')}),#${surf},.${ss ? 'T' : 'F'}.)`);

  const refX = DIR(1, 0, 0);
  const zUp = DIR(0, 0, 1);
  const zDn = DIR(0, 0, -1);

  // Zentren + voll-Kreis-Vertex (phi=0 → center + R*refX)
  const cb = P(0, 0, 0), ct = P(0, 0, H);
  const vb = VERT(P(R, 0, 0));
  const vt = VERT(P(R, 0, H));

  // Kreis-Geometrie (Placement je Rand, gleiche refX-Richtung)
  const placBcirc = A2P(cb, zUp, refX), circB = CIRC(placBcirc, R);
  const placTcirc = A2P(ct, zUp, refX), circT = CIRC(placTcirc, R);

  let latBounds, ecB, ecT, extraTopBoundForLateral;
  if (style === 'seamless') {
    // Volle Kreiskanten (Vx->Vx), Mantel hat 2 Bounds (unten + oben), keine Naht.
    ecB = add(`EDGE_CURVE('',#${vb},#${vb},#${circB},.T.)`);
    ecT = add(`EDGE_CURVE('',#${vt},#${vt},#${circT},.T.)`);
    const cyl = CYL(A2P(cb, zUp, refX), R);
    // Mantel: bottom-Loop + top-Loop. Orientierung: unten .T., oben .F. (Gegenumlauf).
    const latBottom = OB(LOOP([OE(ecB, true)]));
    const latTop = FB(LOOP([OE(ecT, false)]));
    const latFace = FACE([latBottom, latTop], cyl, true);
    // Scheiben teilen dieselben Kreiskanten (Gegenorientierung)
    const botFace = FACE([OB(LOOP([OE(ecB, false)]))], PLANE(A2P(cb, zDn, refX)), true);
    const topFace = FACE([OB(LOOP([OE(ecT, true)]))], PLANE(A2P(ct, zUp, refX)), true);
    return { ent, faces: [latFace, botFace, topFace], id };
  } else { // 'hybrid' — Referenz-Form: voller Kreis unten, oben in 2 Bögen + Naht
    // Unten: voller Kreis (vb->vb). Oben: 2 Bögen zwischen antipodalen Vertices.
    const vt0 = VERT(P(R, 0, H));   // phi=0
    const vt1 = VERT(P(-R, 0, H));  // phi=180
    ecB = add(`EDGE_CURVE('',#${vb},#${vb},#${circB},.T.)`);
    const circT0 = CIRC(placTcirc, R), circT1 = CIRC(placTcirc, R);
    const ecT0 = add(`EDGE_CURVE('',#${vt0},#${vt1},#${circT0},.T.)`);
    const ecT1 = add(`EDGE_CURVE('',#${vt1},#${vt0},#${circT1},.T.)`);
    // Naht: LINE von vb (unten phi=0) zu vt0 (oben phi=0) — achsparallel
    const seamDir = DIR(0, 0, 1);
    const seamVec = add(`VECTOR('',#${seamDir},${H})`);
    const seamLine = add(`LINE('',#${P(R, 0, 0)},#${seamVec})`);
    const seam = add(`EDGE_CURVE('',#${vb},#${vt0},#${seamLine},.T.)`);
    const cyl = CYL(A2P(cb, zUp, refX), R);
    // Mantel-Loop (mirror reference order): [bottomFull .F., seam .T., topArc0 .F., topArc1 .F., seam .F.]
    const latLoop = LOOP([OE(ecB, false), OE(seam, true), OE(ecT0, false), OE(ecT1, false), OE(seam, false)]);
    const latFace = FACE([OB(latLoop)], cyl, true);
    const botFace = FACE([OB(LOOP([OE(ecB, true)]))], PLANE(A2P(cb, zDn, refX)), true);
    const topFace = FACE([OB(LOOP([OE(ecT0, true), OE(ecT1, true)]))], PLANE(A2P(ct, zUp, refX)), true);
    return { ent, faces: [latFace, botFace, topFace], id };
  }
}

function assemble(style) {
  const { ent, faces } = buildSolidCylinder(style);
  let id = ent.length ? Math.max(...ent.map(e => +e.match(/^#(\d+)=/)[1])) : 0;
  const add = (s) => { const i = ++id; ent.push(`#${i}=${s}`); return i; };
  const shell = add(`CLOSED_SHELL('',(${faces.map(f => `#${f}`).join(',')}))`);
  const solid = add(`MANIFOLD_SOLID_BREP('proto',#${shell})`);
  const lu = add(`( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) )`);
  const au = add(`( NAMED_UNIT(*) PLANE_ANGLE_UNIT() SI_UNIT($,.RADIAN.) )`);
  const su = add(`( NAMED_UNIT(*) SI_UNIT($,.STERADIAN.) SOLID_ANGLE_UNIT() )`);
  const ctx = add(`( GEOMETRIC_REPRESENTATION_CONTEXT(3) GLOBAL_UNIT_ASSIGNED_CONTEXT((#${lu},#${au},#${su})) GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#${add(`UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(0.01),#${lu},'','')`)})) REPRESENTATION_CONTEXT('','') )`);
  const absr = add(`ADVANCED_BREP_SHAPE_REPRESENTATION('proto',(#${solid}),#${ctx})`);
  const appctx = add(`APPLICATION_CONTEXT('automotive design')`);
  add(`APPLICATION_PROTOCOL_DEFINITION('','automotive_design',2009,#${appctx})`);
  const pc = add(`PRODUCT_CONTEXT('',#${appctx},'mechanical')`);
  const prod = add(`PRODUCT('proto','proto','',(#${pc}))`);
  const pdf = add(`PRODUCT_DEFINITION_FORMATION_WITH_SPECIFIED_SOURCE('','',#${prod},.NOT_KNOWN.)`);
  const pdctx = add(`PRODUCT_DEFINITION_CONTEXT('',#${appctx},'design')`);
  const pd = add(`PRODUCT_DEFINITION('','',#${pdf},#${pdctx})`);
  const pds = add(`PRODUCT_DEFINITION_SHAPE('','',#${pd})`);
  add(`SHAPE_DEFINITION_REPRESENTATION(#${pds},#${absr})`);
  const header = `ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('proto'),'2;1');\nFILE_NAME('proto.step','2026-01-01T00:00:00',(''),(''),'','','');\nFILE_SCHEMA(('AUTOMOTIVE_DESIGN'));\nENDSEC;\nDATA;\n`;
  return header + ent.join('\n') + '\nENDSEC;\nEND-ISO-10303-21;\n';
}

(async () => {
  for (const style of ['seamless', 'hybrid']) {
    const step = assemble(style);
    const r = await parseStep(step);
    const s = summarize(r);
    console.log(`${style.padEnd(9)} → parse:`, JSON.stringify(s), r.success ? '' : '(FEHLGESCHLAGEN)');
  }
})().catch(e => console.error('ERR', e.stack));

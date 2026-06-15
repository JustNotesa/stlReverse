// Empirischer Test: akzeptiert occt-import-js einen wasserdichten Solid aus
// CYLINDRICAL_SURFACE + TOROIDAL_SURFACE + PLANE, die sich CIRCLE-Kanten teilen?
// Modell: Vollzylinder R=5, H=10, mit konvexer Verrundung rf=1.5 an der oberen Kante.
//   Boden-Scheibe (z=0) | Mantel (z=0..H-rf) | Torus-Fillet | Deck-Scheibe (z=H, kleiner)
const { parseStep, summarize } = require('./occt-check.cjs');

function build() {
  const R=5, H=10, rf=1.5;
  const ent=[]; let id=0;
  const add=s=>{const i=++id;ent.push(`#${i}=${s}`);return i;};
  const P=(x,y,z)=>add(`CARTESIAN_POINT('',(${x},${y},${z}))`);
  const DIR=(x,y,z)=>add(`DIRECTION('',(${x},${y},${z}))`);
  const VERT=p=>add(`VERTEX_POINT('',#${p})`);
  const A2P=(loc,ax,ref)=>add(`AXIS2_PLACEMENT_3D('',#${loc},#${ax},#${ref})`);
  const CIRC=(plac,r)=>add(`CIRCLE('',#${plac},${r})`);
  const OE=(ec,f)=>add(`ORIENTED_EDGE('',*,*,#${ec},.${f?'T':'F'}.)`);
  const LOOP=oes=>add(`EDGE_LOOP('',(${oes.map(o=>`#${o}`).join(',')}))`);
  const OB=l=>add(`FACE_OUTER_BOUND('',#${l},.T.)`);
  const FB=l=>add(`FACE_BOUND('',#${l},.T.)`);
  const PLANE=p=>add(`PLANE('',#${p})`);
  const CYL=(p,r)=>add(`CYLINDRICAL_SURFACE('',#${p},${r})`);
  const TOR=(p,Rmaj,rmin)=>add(`TOROIDAL_SURFACE('',#${p},${Rmaj},${rmin})`);
  const FACE=(b,s,ss)=>add(`ADVANCED_FACE('',(${b.map(x=>`#${x}`).join(',')}),#${s},.${ss?'T':'F'}.)`);
  const refX=DIR(1,0,0), zUp=DIR(0,0,1), zDn=DIR(0,0,-1);
  // drei Kreise (volle, Vertex bei phi=0 → +X)
  const mkCircle=(zc,r)=>{const plac=A2P(P(0,0,zc),zUp,refX);const circ=CIRC(plac,r);const v=VERT(P(r,0,zc));const ec=add(`EDGE_CURVE('',#${v},#${v},#${circ},.T.)`);return ec;};
  const cBot=mkCircle(0,R);            // Boden-Rand
  const cCylTor=mkCircle(H-rf,R);      // Mantel↔Torus (Außen-Äquator des Torus, r=R)
  const cTorTop=mkCircle(H,R-rf);      // Torus↔Deck (r=R-rf)
  // Faces
  // Boden-Scheibe (normal -Z), Rand = cBot
  const botFace=FACE([OB(LOOP([OE(cBot,false)]))],PLANE(A2P(P(0,0,0),zDn,refX)),true);
  // Mantel (CYLINDRICAL_SURFACE R), 2 Bounds: cBot (unten) + cCylTor (oben)
  const cylFace=FACE([OB(LOOP([OE(cBot,true)])),FB(LOOP([OE(cCylTor,false)]))],CYL(A2P(P(0,0,0),zUp,refX),R),true);
  // Torus-Fillet: TOROIDAL_SURFACE, Zentrum auf Achse in Ebene der Tubus-Mittenkreises (z=H-rf),
  // major=R-rf, minor=rf. 2 Bounds: cCylTor + cTorTop
  const torFace=FACE([OB(LOOP([OE(cCylTor,true)])),FB(LOOP([OE(cTorTop,false)]))],TOR(A2P(P(0,0,H-rf),zUp,refX),R-rf,rf),true);
  // Deck-Scheibe (normal +Z), Rand = cTorTop
  const topFace=FACE([OB(LOOP([OE(cTorTop,true)]))],PLANE(A2P(P(0,0,H),zUp,refX)),true);
  return {ent,faces:[botFace,cylFace,torFace,topFace]};
}
function assemble(){
  const {ent,faces}=build();
  let id=Math.max(...ent.map(e=>+e.match(/^#(\d+)=/)[1]));
  const add=s=>{const i=++id;ent.push(`#${i}=${s}`);return i;};
  const shell=add(`CLOSED_SHELL('',(${faces.map(f=>`#${f}`).join(',')}))`);
  const solid=add(`MANIFOLD_SOLID_BREP('p',#${shell})`);
  const lu=add(`( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) )`);
  const au=add(`( NAMED_UNIT(*) PLANE_ANGLE_UNIT() SI_UNIT($,.RADIAN.) )`);
  const su=add(`( NAMED_UNIT(*) SI_UNIT($,.STERADIAN.) SOLID_ANGLE_UNIT() )`);
  const unc=add(`UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(0.01),#${lu},'','')`);
  const ctx=add(`( GEOMETRIC_REPRESENTATION_CONTEXT(3) GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#${unc})) GLOBAL_UNIT_ASSIGNED_CONTEXT((#${lu},#${au},#${su})) REPRESENTATION_CONTEXT('','') )`);
  const absr=add(`ADVANCED_BREP_SHAPE_REPRESENTATION('p',(#${solid}),#${ctx})`);
  const ac=add(`APPLICATION_CONTEXT('automotive design')`);
  add(`APPLICATION_PROTOCOL_DEFINITION('','automotive_design',2009,#${ac})`);
  const pc=add(`PRODUCT_CONTEXT('',#${ac},'mechanical')`);
  const pr=add(`PRODUCT('p','p','',(#${pc}))`);
  const pdf=add(`PRODUCT_DEFINITION_FORMATION_WITH_SPECIFIED_SOURCE('','',#${pr},.NOT_KNOWN.)`);
  const pdc=add(`PRODUCT_DEFINITION_CONTEXT('',#${ac},'design')`);
  const pd=add(`PRODUCT_DEFINITION('','',#${pdf},#${pdc})`);
  const pds=add(`PRODUCT_DEFINITION_SHAPE('','',#${pd})`);
  add(`SHAPE_DEFINITION_REPRESENTATION(#${pds},#${absr})`);
  return `ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('p'),'2;1');\nFILE_NAME('p.step','2026-01-01T00:00:00',(''),(''),'','','');\nFILE_SCHEMA(('AUTOMOTIVE_DESIGN'));\nENDSEC;\nDATA;\n`+ent.join('\n')+'\nENDSEC;\nEND-ISO-10303-21;\n';
}
(async()=>{ const step=assemble(); const r=await parseStep(step); console.log('cyl+torus+plane solid →',JSON.stringify(summarize(r)), r.success?'':'(FAIL)'); })().catch(e=>console.error('ERR',e.stack));

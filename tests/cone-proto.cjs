// Empirisch: akzeptiert occt einen wasserdichten Solid aus CYLINDRICAL_SURFACE + CONICAL_SURFACE
// (Chamfer/Fase) + PLANE mit geteilten CIRCLE-Kanten? Modell: Vollzylinder R=5, H=10, mit
// 45°-Fase c=1.5 an der oberen Kante. Boden(z=0) | Mantel(0..H-c) | Kegel-Fase | Deck(z=H, r=R-c).
const { parseStep, summarize } = require('./occt-check.cjs');
function build(){
  const R=5,H=10,c=1.5;
  const ent=[];let id=0;const add=s=>{const i=++id;ent.push(`#${i}=${s}`);return i;};
  const P=(x,y,z)=>add(`CARTESIAN_POINT('',(${x},${y},${z}))`);
  const DIR=(x,y,z)=>add(`DIRECTION('',(${x},${y},${z}))`);
  const VERT=p=>add(`VERTEX_POINT('',#${p})`);
  const A2P=(loc,ax,ref)=>add(`AXIS2_PLACEMENT_3D('',#${loc},#${ax},#${ref})`);
  const CIRC=(plac,r)=>add(`CIRCLE('',#${plac},${r})`);
  const OE=(ec,f)=>add(`ORIENTED_EDGE('',*,*,#${ec},.${f?'T':'F'}.)`);
  const LOOP=o=>add(`EDGE_LOOP('',(${o.map(x=>`#${x}`).join(',')}))`);
  const OB=l=>add(`FACE_OUTER_BOUND('',#${l},.T.)`);
  const FB=l=>add(`FACE_BOUND('',#${l},.T.)`);
  const PLANE=p=>add(`PLANE('',#${p})`);
  const CYL=(p,r)=>add(`CYLINDRICAL_SURFACE('',#${p},${r})`);
  const CONE=(p,r,ang)=>add(`CONICAL_SURFACE('',#${p},${r},${ang})`);
  const FACE=(b,s,ss)=>add(`ADVANCED_FACE('',(${b.map(x=>`#${x}`).join(',')}),#${s},.${ss?'T':'F'}.)`);
  const refX=DIR(1,0,0),zUp=DIR(0,0,1),zDn=DIR(0,0,-1);
  const mk=(zc,r)=>{const v=VERT(P(r,0,zc));return add(`EDGE_CURVE('',#${v},#${v},#${CIRC(A2P(P(0,0,zc),zUp,refX),r)},.T.)`);};
  const cBot=mk(0,R), cCylCone=mk(H-c,R), cConeTop=mk(H,R-c);
  const botFace=FACE([OB(LOOP([OE(cBot,false)]))],PLANE(A2P(P(0,0,0),zDn,refX)),true);
  const cylFace=FACE([OB(LOOP([OE(cBot,true)])),FB(LOOP([OE(cCylCone,false)]))],CYL(A2P(P(0,0,0),zUp,refX),R),true);
  // Kegel: Achse -Z (Radius wächst nach unten = schrumpft nach oben), Radius R bei z=H-c, Halbwinkel 45°
  const coneFace=FACE([OB(LOOP([OE(cCylCone,true)])),FB(LOOP([OE(cConeTop,false)]))],CONE(A2P(P(0,0,H-c),zDn,refX),R,0.7853981634),true);
  const topFace=FACE([OB(LOOP([OE(cConeTop,true)]))],PLANE(A2P(P(0,0,H),zUp,refX)),true);
  return {ent,faces:[botFace,cylFace,coneFace,topFace]};
}
function assemble(){
  const {ent,faces}=build();let id=Math.max(...ent.map(e=>+e.match(/^#(\d+)=/)[1]));
  const add=s=>{const i=++id;ent.push(`#${i}=${s}`);return i;};
  const shell=add(`CLOSED_SHELL('',(${faces.map(f=>`#${f}`).join(',')}))`);
  const solid=add(`MANIFOLD_SOLID_BREP('p',#${shell})`);
  const lu=add(`( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) )`);
  const au=add(`( NAMED_UNIT(*) PLANE_ANGLE_UNIT() SI_UNIT($,.RADIAN.) )`);
  const su=add(`( NAMED_UNIT(*) SI_UNIT($,.STERADIAN.) SOLID_ANGLE_UNIT() )`);
  const unc=add(`UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(0.01),#${lu},'','')`);
  const ctx=add(`( GEOMETRIC_REPRESENTATION_CONTEXT(3) GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#${unc})) GLOBAL_UNIT_ASSIGNED_CONTEXT((#${lu},#${au},#${su})) REPRESENTATION_CONTEXT('','') )`);
  const absr=add(`ADVANCED_BREP_SHAPE_REPRESENTATION('p',(#${solid}),#${ctx})`);
  const ac=add(`APPLICATION_CONTEXT('automotive design')`);add(`APPLICATION_PROTOCOL_DEFINITION('','automotive_design',2009,#${ac})`);
  const pc=add(`PRODUCT_CONTEXT('',#${ac},'mechanical')`);const pr=add(`PRODUCT('p','p','',(#${pc}))`);
  const pdf=add(`PRODUCT_DEFINITION_FORMATION_WITH_SPECIFIED_SOURCE('','',#${pr},.NOT_KNOWN.)`);
  const pdc=add(`PRODUCT_DEFINITION_CONTEXT('',#${ac},'design')`);const pd=add(`PRODUCT_DEFINITION('','',#${pdf},#${pdc})`);
  const pds=add(`PRODUCT_DEFINITION_SHAPE('','',#${pd})`);add(`SHAPE_DEFINITION_REPRESENTATION(#${pds},#${absr})`);
  return `ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('p'),'2;1');\nFILE_NAME('p.step','2026-01-01T00:00:00',(''),(''),'','','');\nFILE_SCHEMA(('AUTOMOTIVE_DESIGN'));\nENDSEC;\nDATA;\n`+ent.join('\n')+'\nENDSEC;\nEND-ISO-10303-21;\n';
}
(async()=>{const r=await parseStep(assemble());console.log('cyl+cone(chamfer)+plane →',JSON.stringify(summarize(r)),r.success?'':'(FAIL)');})().catch(e=>console.error('ERR',e.stack));

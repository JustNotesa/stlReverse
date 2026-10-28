// ─────────────────────────────────────────────────────────────────────────────
// strict.test.mjs — Strenge STEP-Prüfung an handgeschriebenen AP214-Körpern
//
// Prüft, dass der strenge Prüfer (tests/step-strict.mjs) SPHERICAL_SURFACE
// unterstützt: Kugel-Hemisphäre (z>=0) mit Schließe-Scheibe z=0, dieselbe
// Fläche mit verdrehtem sameSense (→ Verstoß) und die volle Kugel aus zwei
// Halbkugeln.
//
// Aufbau der Körper (wie von exporters.js geschrieben): Kopf, Einheiten,
// Kontext, Produkt; die Geometrie nur mit den Elementen, die der Prüfer
// braucht (Punkte, Richtungen, Achsenplatten, Kreis, Kanten, Ränder, Flächen,
// Schale, Körper).
//
// Ränder laufen gegen den Uhrzeigersinn um die EFFEKTIVE Normale (Fläche links):
//   Kugelhemisphäre (Normale radial nach außen)  → Rand von (2,0,0) über (0,2,0)
//   Schließe-Scheibe (Normale −z)                → Rand von (2,0,0) über (0,−2,0)
// ─────────────────────────────────────────────────────────────────────────────
import assert from 'node:assert/strict';
import { checkStepStrict } from '../step-strict.mjs';

let failed = 0;
const case_ = (name, fn) => {
  try { fn(); console.log(`ok ${name}`); }
  catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); }
};

const describe = (violations) =>
  violations.map((v) => `${v.kind}: ${v.msg}`).join('\n    ') || '(keine)';

const expectClean = (text) => {
  const { violations, stats } = checkStepStrict(text);
  assert.equal(violations.length, 0, `unerwartete Verstöße:\n    ${describe(violations)}`);
  // Die Kugelfläche muss mitgerechnet sein — sonst wäre die Schale still übersprungen.
  assert.equal(stats.volumeSkipped, 0, 'Schalenvolumen wurde übersprungen (Kugelfläche nicht gerechnet)');
  assert.ok(stats.faces >= 2, 'keine Flächen erkannt');
};

// ── Hemisphäre R=2 (z>=0) + Scheibe z=0 ─────────────────────────────────────
// sphereSense = sameSense der Kugelfläche (.T. = Normale radial nach außen)
const stepHemisphere = (sphereSense) => `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('STLReverse V2 Topology B-Rep'),'2;1');
FILE_NAME('stlReverse-v2-brep.step','2026-10-28T09:00:00.000Z',('STLReverse'),('STLReverse'),'STLReverse','STLReverse','');
FILE_SCHEMA(('AUTOMOTIVE_DESIGN'));
ENDSEC;
DATA;
#1=CARTESIAN_POINT('',(0.,0.,0.));
#2=DIRECTION('',(1.,0.,0.));
#3=DIRECTION('',(0.,0.,1.));
#4=AXIS2_PLACEMENT_3D('',#1,#2,#3);
#5=SPHERICAL_SURFACE('',#4,2.);
#6=CARTESIAN_POINT('',(0.,0.,0.));
#7=DIRECTION('',(0.,0.,1.));
#8=DIRECTION('',(1.,0.,0.));
#9=AXIS2_PLACEMENT_3D('',#6,#7,#8);
#10=CIRCLE('',#9,2.);
#11=CARTESIAN_POINT('',(2.,0.,0.));
#12=VERTEX_POINT('',#11);
#13=CARTESIAN_POINT('',(-2.,0.,0.));
#14=VERTEX_POINT('',#13);
#15=EDGE_CURVE('',#12,#14,#10,.T.);
#16=EDGE_CURVE('',#14,#12,#10,.T.);
#17=ORIENTED_EDGE('',*,*,#15,.T.);
#18=ORIENTED_EDGE('',*,*,#16,.T.);
#19=EDGE_LOOP('',(#17,#18));
#20=FACE_OUTER_BOUND('',#19,.T.);
#21=ADVANCED_FACE('',(#20),#5,${sphereSense});
#22=ORIENTED_EDGE('',*,*,#16,.F.);
#23=ORIENTED_EDGE('',*,*,#15,.F.);
#24=EDGE_LOOP('',(#22,#23));
#25=FACE_OUTER_BOUND('',#24,.T.);
#26=CARTESIAN_POINT('',(0.,0.,0.));
#27=DIRECTION('',(0.,0.,1.));
#28=DIRECTION('',(1.,0.,0.));
#29=AXIS2_PLACEMENT_3D('',#26,#27,#28);
#30=PLANE('',#29);
#31=ADVANCED_FACE('',(#25),#30,.F.);
#32=CLOSED_SHELL('',(#21,#31));
#33=MANIFOLD_SOLID_BREP('V2 Solid',#32);
#34=(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.));
#35=(PLANE_ANGLE_UNIT()NAMED_UNIT(*)SI_UNIT($,.RADIAN.));
#36=(SOLID_ANGLE_UNIT()NAMED_UNIT(*)SI_UNIT($,.STERADIAN.));
#37=UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-05),#34,'distance_accuracy_value','');
#38=(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#37))GLOBAL_UNIT_ASSIGNED_CONTEXT((#34,#35,#36))REPRESENTATION_CONTEXT('',''));
#39=ADVANCED_BREP_SHAPE_REPRESENTATION('V2 Volume',(#33),#38);
#40=APPLICATION_CONTEXT('automotive_design');
#41=APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2010,#40);
#42=PRODUCT_CONTEXT('design',#40,'mechanical');
#43=PRODUCT('V2 B-Rep','V2 Reconstruction','',(#42));
#44=PRODUCT_DEFINITION_FORMATION_WITH_SPECIFIED_SOURCE('','',#43,.NOT_KNOWN.);
#45=PRODUCT_DEFINITION_CONTEXT('design',#40,'');
#46=PRODUCT_DEFINITION('','',#44,#45);
#47=PRODUCT_DEFINITION_SHAPE('','',#46);
#48=SHAPE_DEFINITION_REPRESENTATION(#47,#39);
ENDSEC;
END-ISO-10303-21;
`;

// ── Volle Kugel R=2: zwei Halbkugeln an den beiden Äquatorbögen ────────────
const stepBall = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('STLReverse V2 Topology B-Rep'),'2;1');
FILE_NAME('stlReverse-v2-brep.step','2026-10-28T09:00:00.000Z',('STLReverse'),('STLReverse'),('STLReverse','STLReverse','');
FILE_SCHEMA(('AUTOMOTIVE_DESIGN'));
ENDSEC;
DATA;
#1=CARTESIAN_POINT('',(0.,0.,0.));
#2=DIRECTION('',(1.,0.,0.));
#3=DIRECTION('',(0.,0.,1.));
#4=AXIS2_PLACEMENT_3D('',#1,#2,#3);
#5=SPHERICAL_SURFACE('',#4,2.);
#6=CARTESIAN_POINT('',(0.,0.,0.));
#7=DIRECTION('',(0.,0.,1.));
#8=DIRECTION('',(1.,0.,0.));
#9=AXIS2_PLACEMENT_3D('',#6,#7,#8);
#10=CIRCLE('',#9,2.);
#11=CARTESIAN_POINT('',(2.,0.,0.));
#12=VERTEX_POINT('',#11);
#13=CARTESIAN_POINT('',(-2.,0.,0.));
#14=VERTEX_POINT('',#13);
#15=EDGE_CURVE('',#12,#14,#10,.T.);
#16=EDGE_CURVE('',#14,#12,#10,.T.);
#17=ORIENTED_EDGE('',*,*,#15,.T.);
#18=ORIENTED_EDGE('',*,*,#16,.T.);
#19=EDGE_LOOP('',(#17,#18));
#20=FACE_OUTER_BOUND('',#19,.T.);
#21=ADVANCED_FACE('',(#20),#5,.T.);
#22=ORIENTED_EDGE('',*,*,#16,.F.);
#23=ORIENTED_EDGE('',*,*,#15,.F.);
#24=EDGE_LOOP('',(#22,#23));
#25=FACE_OUTER_BOUND('',#24,.T.);
#26=ADVANCED_FACE('',(#25),#5,.T.);
#27=CLOSED_SHELL('',(#21,#26));
#28=MANIFOLD_SOLID_BREP('V2 Solid',#27);
#29=(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.));
#30=(PLANE_ANGLE_UNIT()NAMED_UNIT(*)SI_UNIT($,.RADIAN.));
#31=(SOLID_ANGLE_UNIT()NAMED_UNIT(*)SI_UNIT($,.STERADIAN.));
#32=UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-05),#29,'distance_accuracy_value','');
#33=(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#32))GLOBAL_UNIT_ASSIGNED_CONTEXT((#29,#30,#31))REPRESENTATION_CONTEXT('',''));
#34=ADVANCED_BREP_SHAPE_REPRESENTATION('V2 Volume',(#28),#33);
#35=APPLICATION_CONTEXT('automotive_design');
#36=APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2010,#35);
#37=PRODUCT_CONTEXT('design',#35,'mechanical');
#38=PRODUCT('V2 B-Rep','V2 Reconstruction','',(#37));
#39=PRODUCT_DEFINITION_FORMATION_WITH_SPECIFIED_SOURCE('','',#38,.NOT_KNOWN.);
#40=PRODUCT_DEFINITION_CONTEXT('design',#35,'');
#41=PRODUCT_DEFINITION('','',#39,#40);
#42=PRODUCT_DEFINITION_SHAPE('','',#41);
#43=SHAPE_DEFINITION_REPRESENTATION(#42,#34);
ENDSEC;
END-ISO-10303-21;
`;

// ── Fälle ───────────────────────────────────────────────────────────────────
case_('Hemispäre (Kugel + Schließe-Scheibe) ist streng gültig', () => {
  expectClean(stepHemisphere('.T.'));
});

case_('Hemispäre mit verdrehtem sameSense der Kugelfläche wird beanstandet', () => {
  const { violations } = checkStepStrict(stepHemisphere('.F.'));
  assert.ok(violations.length >= 1, 'kein Verstoß gemeldet');
  const relevant = violations.filter((v) => v.kind === 'shell-volume' || v.kind === 'orient-curved');
  assert.ok(relevant.length >= 1, `nur andere Verstöße gemeldet:\n    ${describe(violations)}`);
  // Die verdrehte Kugelfläche muss das Volumen umkehren (innen-außen vertauscht).
  assert.ok(relevant.some((v) => v.kind === 'shell-volume'), `kein Volumen-Verstoß:\n    ${describe(violations)}`);
});

case_('volle Kugel aus zwei Halbkugeln ist streng gültig', () => {
  expectClean(stepBall);
});

process.exit(failed ? 1 : 0);

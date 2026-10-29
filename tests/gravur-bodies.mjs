// ─────────────────────────────────────────────────────────────────────────────
// Synthetische Testkörper „Schrift/Gravur“ — Vorlauf für den Exporter-Pfad
// SURFACE_OF_LINEAR_EXTRUSION über B-Spline-Kurven.
//
// Echte Schriftzüge stammen aus Font-Outlines: geschlossene Konturen aus Geraden und
// quadratischen/kubischen Bézier-Kurven (KEINE Kreisbögen) — mit scharfen Ecken zwischen
// manchen Teilstücken und tangentialen Übergängen zwischen anderen. Die Körper hier sehen
// aus wie ein CAD-/Slicer-Export solcher Schrift: flache Platte, 1 mm hohe erhabene Glyphen
// bzw. 1 mm tiefe vertiefte Rillen.
//
// Die Werkzeuge kommen aus tests/fixtures-v2/gen.mjs (buildMesh baut das wasserdichte Netz,
// checkManifold/meshVolume/toBinaryStl/polyArea/makeTransform).
//
// Aufruf:  node tests/gravur-bodies.mjs [zielordner]   → schreibt je Körper <name>.stl
// ─────────────────────────────────────────────────────────────────────────────
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  buildMesh, checkManifold, meshVolume, toBinaryStl, polyArea, rectProfile, makeTransform, triangulateWithHoles,
} from './fixtures-v2/gen.mjs';

const DEG = Math.PI / 180;

// ── Pfad-Bausteine (Font-Outline-Format) ─────────────────────────────────────
// Ein Pfad ist eine Befehlsliste: ['M',x,y] Start, ['L',x,y] Gerade,
// ['Q',cx,cy,x,y] quadratische Bézier, ['C',c1x,c1y,c2x,c2y,x,y] kubische Bézier,
// ['Z'] schließen. Die Kontur ist geschlossen; der Startpunkt wird nicht doppelt geführt.

const binom = (n, k) => { let r = 1; for (let i = 0; i < k; i++) r = r * (n - i) / (i + 1); return r; };

// Bézier-Punkt (P = [P0 … Pn], P0 = Start, Pn = Ende)
function bezAt(P, t) {
  const n = P.length - 1, u = 1 - t, out = [0, 0];
  for (let k = 0; k < 2; k++) {
    let s = 0;
    for (let i = 0; i <= n; i++) s += P[i][k] * binom(n, i) * Math.pow(u, n - i) * Math.pow(t, i);
    out[k] = s;
  }
  return out;
}

// Tangente am Anfang bzw. Ende einer Bézier (Richtung, nicht normiert)
const tanStart = (P) => [P[1][0] - P[0][0], P[1][1] - P[0][1]];
const tanEnd = (P) => [P[P.length - 1][0] - P[P.length - 2][0], P[P.length - 1][1] - P[P.length - 2][1]];

// Winkel zwischen zwei Richtungen (Grad, 0…180)
function angleBetween(a, b) {
  return Math.abs(Math.atan2(a[0] * b[1] - a[1] * b[0], a[0] * b[0] + a[1] * b[1])) * 180 / Math.PI;
}

// Kreisbogen → kubische Bézier-Stücke (≤90° je Stück, Tangentenanschluss exakt).
// span > 0 = gegen den Uhrzeigersinn; die Laufrichtung steckt allein im Vorzeichen von
// tan(span/4), die Tangente T(b) = (−sin b, cos b) ist immer die CCW-Tangente.
export function arcCubics(cx, cy, r, a0, a1) {
  const span = a1 - a0, n = Math.max(1, Math.ceil(Math.abs(span) / (Math.PI / 2))), out = [];
  const pt = (a) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  for (let k = 0; k < n; k++) {
    const b0 = a0 + span * k / n, b1 = a0 + span * (k + 1) / n;
    const k4 = 4 / 3 * Math.tan((b1 - b0) / 4);              // Bézier-Griffweite (vorzeichenbehaftet)
    const P0 = pt(b0), P3 = pt(b1);
    const t0 = [-Math.sin(b0), Math.cos(b0)], t1 = [-Math.sin(b1), Math.cos(b1)];
    out.push(['C', P0[0] + k4 * r * t0[0], P0[1] + k4 * r * t0[1], P3[0] - k4 * r * t1[0], P3[1] - k4 * r * t1[1], P3[0], P3[1]]);
  }
  return out;
}

// Vier kubische Bézier als geschlossene „Superellipsen“-Kontur. k = Steuerpunkt-Verhältnis:
// 0.5523 ergibt eine echte Ellipse, 0.7 eine eckige, superellipsen-artige Form — bewusst
// NICHT rund (so sehen die Font-Outlines in der Praxis aus).
export function superClosed(rx, ry, k = 0.7, cx = 0, cy = 0) {
  return [
    ['M', cx + rx, cy],
    ['C', cx + rx, cy + k * ry, cx + k * rx, cy + ry, cx, cy + ry],
    ['C', cx - k * rx, cy + ry, cx - rx, cy + k * ry, cx - rx, cy],
    ['C', cx - rx, cy - k * ry, cx - k * rx, cy - ry, cx, cy - ry],
    ['C', cx + k * rx, cy - ry, cx + rx, cy - k * ry, cx + rx, cy],
    ['Z'],
  ];
}

// Geschlossene C1-Spline (Catmull-Rom) durch Ankerpunkte → kubische Bézier.
// Alle Übergänge sind tangential (keine scharfen Ecken).
export function splineClosed(anchors) {
  const n = anchors.length, cmds = [['M', anchors[0][0], anchors[0][1]]];
  for (let i = 0; i < n; i++) {
    const p0 = anchors[(i - 1 + n) % n], p1 = anchors[i], p2 = anchors[(i + 1) % n], p3 = anchors[(i + 2) % n];
    cmds.push(['C',
      p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6,
      p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6,
      p2[0], p2[1]]);
  }
  cmds.push(['Z']);
  return cmds;
}

// ── Pfad → Stücke ────────────────────────────────────────────────────────────
// Zerlegt die Befehlsliste in Stücke: { t: 'L'|'Q'|'C', P: [P0, …] } mit P0 = Startpunkt.
// Der Schluss ('Z') wird als eigenes Geraden-Stück geführt, wenn der letzte Punkt nicht der
// Startpunkt ist (sonst ginge die Kante verloren) — der Startpunkt selbst wird nie wiederholt.
function pieces(cmds) {
  const out = [];
  let cur = null, start = null;
  for (const c of cmds) {
    const k = c[0];
    if (k === 'M') { cur = [c[1], c[2]]; start = cur; continue; }
    if (k === 'Z') {
      if (cur && start && (cur[0] !== start[0] || cur[1] !== start[1])) out.push({ t: 'L', P: [cur, start] });
      cur = null;
      continue;
    }
    if (!cur) throw new Error('Pfad beginnt nicht mit M');
    if (k === 'L') { out.push({ t: 'L', P: [cur, [c[1], c[2]]] }); cur = [c[1], c[2]]; }
    else if (k === 'Q') { out.push({ t: 'Q', P: [cur, [c[1], c[2]], [c[3], c[4]]] }); cur = [c[3], c[4]]; }
    else if (k === 'C') { out.push({ t: 'C', P: [cur, [c[1], c[2]], [c[3], c[4]], [c[5], c[6]]] }); cur = [c[5], c[6]]; }
    else throw new Error('unbekannter Pfadbefehl ' + k);
  }
  return out;
}

// Tangenten (Anfang/Ende) je Stück
function pieceTangents(ps) {
  return ps.map((p) => (p.t === 'L'
    ? (() => { const d = [p.P[1][0] - p.P[0][0], p.P[1][1] - p.P[0][1]]; return [d, d]; })()
    : [tanStart(p.P), tanEnd(p.P)]));
}

// Bogenlänge einer Bézier (24 Stützstellen genügen)
function arcLength(P) {
  let L = 0, prev = P[0];
  for (let k = 1; k <= 24; k++) { const q = bezAt(P, k / 24); L += Math.hypot(q[0] - prev[0], q[1] - prev[1]); prev = q; }
  return L;
}

// ── Abflachen: Pfad → geschlossene Polylinie ─────────────────────────────────
// Die Kurvenstücke werden mit GLEICHEN Parameterschritten abgetastet (nicht mit konstanter
// Sehnenlänge) — so polygonalisiert ein CAD/STL-Export eine Kurve: die Sehnenlänge wächst
// mit der Krümmung. Ziel-Sehnenlänge 0.12 mm, je Stück mindestens 4, höchstens 48 Teilstücke.
// Geraden bleiben ein Segment (keine Innenpunkte).
export const CURVE_STEP = 0.12, CURVE_MIN = 4, CURVE_MAX = 48;

export function flattenPath(cmds, opts = {}) {
  const step = opts.step ?? CURVE_STEP;
  const maxSeg = opts.maxSegments ?? CURVE_MAX, minSeg = opts.minSegments ?? CURVE_MIN;
  const ps = pieces(cmds), raw = [];
  for (const p of ps) {
    raw.push([p.P[0][0], p.P[0][1]]);                       // Startpunkt des Stücks
    if (p.t === 'L') { raw.push([p.P[1][0], p.P[1][1]]); continue; }
    const n = Math.max(minSeg, Math.min(maxSeg, Math.ceil(arcLength(p.P) / step)));
    for (let k = 1; k < n; k++) raw.push(bezAt(p.P, k / n));
  }
  // Aufeinanderfolgende gleiche Punkte entfernen (1e-9 mm Toleranz)
  const out = [];
  for (const p of raw) {
    const q = out[out.length - 1];
    if (q && Math.hypot(p[0] - q[0], p[1] - q[1]) < 1e-9) continue;
    out.push(p);
  }
  // Der Endpunkt der geschlossenen Kontur ist der Startpunkt → nicht doppelt führen
  if (out.length > 1) {
    const a = out[0], b = out[out.length - 1];
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-9) out.pop();
  }
  return out;
}

// ── Kennzahlen eines Pfades ──────────────────────────────────────────────────
// Ecken: Übergang zwischen zwei Stücken, bei dem die Tangenten um mehr als sharpDeg
// abweichen (echte Knicke). Tangentiale Übergänge (≈0°) sind die Gegenprobe.
export function pathCorners(cmds, sharpDeg = 40) {
  const ps = pieces(cmds), tg = pieceTangents(ps);
  let corners = 0, tangents = 0;
  for (let i = 0; i < ps.length; i++) {
    const prev = (i - 1 + ps.length) % ps.length;
    const ang = angleBetween(tg[prev][1], tg[i][0]);
    if (ang > sharpDeg) corners++;
    else if (ang < 1) tangents++;
  }
  return { corners, tangents };
}

// Zahl der glatten Kurvenläufe: maximale Ketten von Stücken, die tangential aneinander
// anschließen; eine Kette zählt nur, wenn sie mindestens eine Bézier enthält.
// (Ein Exporter, der die geraden Teilstücke in dieselbe B-Spline-Fläche nimmt, liefert
// weniger Flächen — deshalb ist das die untere Schranke.)
export function curveRuns(cmds) {
  const ps = pieces(cmds), tg = pieceTangents(ps), chain = new Array(ps.length);
  for (let i = 0; i < ps.length; i++) {
    const prev = (i - 1 + ps.length) % ps.length;
    chain[i] = (i === 0 || angleBetween(tg[prev][1], tg[i][0]) > 1) ? i : chain[prev];
  }
  const has = new Set();
  ps.forEach((p, i) => { if (p.t !== 'L') has.add(chain[i]); });
  return has.size;
}

// Orientierung: Außenkonturen CCW (Material links), Löcher CW.
export function ensureOrientation(pts, ccw = true) {
  return (polyArea(pts) > 0) === ccw ? pts : pts.slice().reverse();
}

// Pfad verschieben
export function translatePath(cmds, dx, dy) {
  return cmds.map((c) => {
    const out = [c[0]];
    for (let i = 1; i < c.length; i += 2) out.push(c[i] + dx, c[i + 1] + dy);
    return out;
  });
}

// ── Glyphen (Font-Outline-Art) ───────────────────────────────────────────────
// Alle Glyphen sind ~8–10 mm hoch; die Strichbreite liegt je nach Stelle bei 0.8–1.4 mm.

// „S“: EINE geschlossene Kontur aus vier Bogenstrecken (Kreisbögen als Bézier) und vier
// geraden Teilstücken. Die Bögen treffen die schräge Mittelpartie tangential (4 tangentiale
// Übergänge); die beiden Strichenden sind gerade geschnitten (scharfe Ecken à 90°).
function glyphS() {
  const R = 1.9, w = 1.4, h = w / 2, C1 = [3.0, 7.5], C2 = [3.0, 2.5];
  // Kreuztangente der beiden Kreise: senkrechte Komponente so, dass die gemeinsame
  // Tangentialgerade beide Kreise berührt (Bogen oben → Bogen unten).
  const ny = (R + R) / (C1[1] - C2[1]);
  const n = [Math.sqrt(Math.max(0, 1 - ny * ny)), ny];         // linke Normale der Laufrichtung
  const aT1 = Math.atan2(-n[1], -n[0]) + 2 * Math.PI;         // Tangentialpunkt am oberen Kreis (229°)
  const aT2 = Math.atan2(n[1], n[0]);                         // Tangentialpunkt am unteren Kreis (49°)
  const a0 = -20 * DEG, a1 = -160 * DEG;                      // Enden der Striche
  const P = (c, r, a) => [c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)];
  return [
    ['M', ...P(C1, R + h, a0)],
    ...arcCubics(C1[0], C1[1], R + h, a0, aT1),                // Außenbogen oben
    ['L', ...P(C2, R - h, aT2)],                              // Außenkante der Mittelpartie
    ...arcCubics(C2[0], C2[1], R - h, aT2, a1),               // Innenbogen unten
    ['L', ...P(C2, R + h, a1)],                              // gerader Schnitt (Strichende)
    ...arcCubics(C2[0], C2[1], R + h, a1, aT2),               // Außenbogen unten (rückwärts)
    ['L', ...P(C1, R - h, aT1)],                              // Innenkante der Mittelpartie
    ...arcCubics(C1[0], C1[1], R - h, aT1, a0),               // Innenbogen oben (rückwärts)
    ['L', ...P(C1, R + h, a0)],                              // gerader Schnitt (Strichende)
    ['Z'],
  ];
}

// Ankerpunkte der „8“ (Außenkontur, C1-Spline → keine scharfen Ecken)
const ANCHORS_8 = [
  [0.00, 4.60], [2.10, 3.40], [1.55, 0.00], [2.10, -3.40],
  [0.00, -4.60], [-2.10, -3.40], [-1.55, 0.00], [-2.10, 3.40],
];

// „D“: senkrechter Stiel mit zwei scharfen Ecken, eine Obergerade, EIN kubischer Bogen.
// Die Obergerade geht tangential in den Bogen über (Gerade→Kurve-Übergang), der Bogen endet
// tangential in der Untergeraden.
function glyphD() {
  const top = 10, stem = 1.4, bowl = 3.0;
  return [
    ['M', 0, 0],
    ['L', 0, top],                                    // Stiel (scharfe Ecke oben)
    ['L', stem, top],                                // Obergerade → tangential in den Bogen
    ['C', stem + bowl, top, stem + bowl, 0, stem, 0], // ein einziger kubischer Bogen
    ['L', 0, 0],                                     // Untergerade (tangential aus dem Bogen)
    ['Z'],
  ];
}

// „mix“: abwechselnd Gerade, quadratische Bézier, Gerade, kubische Bézier, Geraden.
// 4 scharfe Ecken (71°…108°), 3 tangentiale Übergänge.
function glyphMix() {
  return [
    ['M', 0, 0],
    ['L', 3.0, 0],                                   // Gerade
    ['Q', 3.9, 0, 4.2, 2.2],                         // quadratische Bézier (tangential an die Gerade)
    ['C', 4.35, 3.3, 5.1, 4.6, 6.0, 4.6],            // kubische Bézier (tangential an die quadratische)
    ['L', 8.0, 4.6],                                 // Gerade (tangential aus der kubischen)
    ['L', 8.0, 9.0],                                 // scharfe Ecke
    ['L', 3.0, 9.0],                                 // scharfe Ecke
    ['Z'],                                           // scharfe Ecke zurück zum Start
  ];
}

// Glyphen-Register: Außenkontur (hole: false) + Zähler/Löcher (hole: true).
// Die Konturen sind in Glyphen-Eigenkoordinaten (Startpunkt unten links).
export const GLYPHS = {
  S: { contours: [{ cmds: glyphS(), hole: false }] },
  '8': {
    contours: [
      { cmds: splineClosed(ANCHORS_8), hole: false },
      { cmds: superClosed(0.75, 1.05, 0.7, 0, 2.05), hole: true },
      { cmds: superClosed(0.75, 1.05, 0.7, 0, -2.05), hole: true },
    ],
  },
  O: {
    contours: [
      { cmds: superClosed(3.0, 4.6, 0.7), hole: false },     // eckige „Superellipse“
      { cmds: superClosed(1.6, 3.2, 0.7), hole: true },
    ],
  },
  D: { contours: [{ cmds: glyphD(), hole: false }] },
  mix: { contours: [{ cmds: glyphMix(), hole: false }] },
};

// ── Glyphe vorbereiten ───────────────────────────────────────────────────────
// Pfade verschieben, abflachen, orientieren: Außenkontur CCW (Material links),
// Zähler/Löcher CW.
export function prepareGlyph(key, dx = 0, dy = 0) {
  const spec = GLYPHS[key];
  if (!spec) throw new Error('unbekannte Glyphe ' + key);
  return spec.contours.map((c) => {
    const cmds = translatePath(c.cmds, dx, dy);
    return { pts: ensureOrientation(flattenPath(cmds), !c.hole), hole: c.hole, cmds };
  });
}

// Abgeflachte Konturen der Glyphen eines Körpers (für die Netz-Prüfungen)
export function glyphPolylines(entry) {
  const out = [];
  for (const g of entry.glyphs) for (const c of prepareGlyph(g.key, g.dx, g.dy)) out.push(c.pts);
  return out;
}

// Kennzahlen der Glyphen: Fläche (Außenkontur minus Zähler), Konturen, scharfe Ecken,
// glatte Kurvenläufe, Punktzahl der abgeflachten Konturen
function glyphStats(glyphs) {
  let area = 0, corners = 0, runs = 0, contours = 0, points = 0;
  for (const g of glyphs) {
    for (const c of prepareGlyph(g.key, g.dx, g.dy)) {
      area += polyArea(c.pts);                       // Vorzeichen: Außen +, Zähler −
      const pc = pathCorners(c.cmds);
      corners += pc.corners;
      runs += curveRuns(c.cmds);
      contours++;
      points += c.pts.length;
    }
  }
  return { area, corners, runs, contours, points };
}

// ── Körper bauen ─────────────────────────────────────────────────────────────
// Platte + erhabene Glyphen (Glyphenkontur sitzt 1 mm hoch auf der Plattenoberseite).
// Die Plattenoberseite bekommt die Glyphen-Außenkontur als Loch (rev → CW); die
// Glyphenwand schließt diese Öffnung nach oben ab — das Volumen ist daher
// Platte + Glyphenfläche × 1 mm (die Platte bleibt darunter voll erhalten).
function raisedBody(w, d, h, glyphs, height) {
  const columns = [{ name: 'platte', profile: rectProfile(0, 0, w, d), z0: 0, z1: h, bottom: { kind: 'sharp' }, top: { kind: 'sharp' } }];
  const caps = [{ up: false, outer: { c: 0, end: 'bottom' }, holes: [] }];
  const plateHoles = [];
  for (const g of glyphs) {
    const cs = prepareGlyph(g.key, g.dx, g.dy);
    const c = columns.length;
    columns.push({ name: g.key, profile: cs[0].pts, z0: h, z1: h + height, bottom: { kind: 'sharp' }, top: { kind: 'sharp' } });
    plateHoles.push({ c, end: 'bottom', rev: true });
    const holes = [];
    for (const k of cs.slice(1)) {                     // Zähler (Löcher in der Glyphe)
      const cc = columns.length;
      columns.push({ name: g.key + '-zaehler', profile: k.pts, z0: h, z1: h + height, bottom: { kind: 'sharp' }, top: { kind: 'sharp' } });
      holes.push({ c: cc, end: 'top' });
      caps.push({ up: true, outer: { c: cc, end: 'bottom', rev: true }, holes: [] });   // Zählerboden
    }
    caps.push({ up: true, outer: { c, end: 'top' }, holes });
  }
  caps.push({ up: true, outer: { c: 0, end: 'top' }, holes: plateHoles });
  return { columns, caps };
}

// Platte + vertiefte Rille (1 mm tief): die Rillen-Außenwand ist eine CW-Säule (Loch),
// die Inselwand eine CCW-Säule (Vollkörper). Der Rillenboden bei z = h − depth ist ein
// Ring (Außen = Rillen-Außenkontur, Loch = Inselkontur).
function engravedBody(w, d, h, glyphs, depth) {
  const g = glyphs[0];
  const cs = prepareGlyph(g.key, g.dx, g.dy);
  const outerCW = cs[0].pts.slice().reverse();        // Rillen-Außenwand → CW
  const innerCCW = cs[1].pts.slice().reverse();       // Inselwand → CCW
  const columns = [
    { name: 'platte', profile: rectProfile(0, 0, w, d), z0: 0, z1: h, bottom: { kind: 'sharp' }, top: { kind: 'sharp' } },
    { name: 'rille-aussen', profile: outerCW, z0: h - depth, z1: h, bottom: { kind: 'sharp' }, top: { kind: 'sharp' } },
    { name: 'insel', profile: innerCCW, z0: h - depth, z1: h, bottom: { kind: 'sharp' }, top: { kind: 'sharp' } },
  ];
  const caps = [
    { up: false, outer: { c: 0, end: 'bottom' }, holes: [] },
    { up: true, outer: { c: 0, end: 'top' }, holes: [{ c: 1, end: 'top' }] },      // Rillenöffnung in der Plattenoberseite
    { up: true, outer: { c: 2, end: 'top' }, holes: [] },                           // Insel-Oberfläche
    { up: true, outer: { c: 1, end: 'bottom', rev: true }, holes: [{ c: 2, end: 'bottom', rev: true }] },  // Rillenboden
  ];
  return { columns, caps };
}

// ── Testkörper ───────────────────────────────────────────────────────────────
// expect.minExtFaces: untere Schranke der SURFACE_OF_LINEAR_EXTRUSION-Flächen — so viele
//   glatte Kurvenläufe (G1-Ketten mit Bézier) hat die Glyphe.
// expect.maxFaces: obere Schranke der Flächenzahl — ebene Flächen der Platte +
//   Glyphen-Deckflächen + 2 je Kurvenlauf + 10 Reserve.
function makeEntry({ name, desc, glyphs, w, d, h = 3, engraved = false, depth = 1, transform = null, expect }) {
  const height = engraved ? depth : 1;
  const body = engraved ? engravedBody(w, d, h, glyphs, depth) : raisedBody(w, d, h, glyphs, height);
  if (transform) body.transform = transform;
  const st = glyphStats(glyphs);
  const tris = buildMesh(body);
  const man = checkManifold(tris);
  // Generator-Selbsttest: die Deckflächen mit Löchern (Plattenoberseite mit Glyphenöffnung,
  // Zählerböden, Rillenboden) müssen über Brücken + Ear-Clipping triangulierbar sein.
  const ringOf = (ref) => {
    const prof = body.columns[ref.c].profile;
    return ref.rev ? prof.slice().reverse() : prof.slice();
  };
  let capTris = 0;
  for (const cap of body.caps) {
    if (!cap.outer || cap.outer.pts || !(cap.holes || []).length) continue;
    capTris += triangulateWithHoles(ringOf(cap.outer), (cap.holes || []).map(ringOf)).length;
  }
  // Welt-Bounding-Box (bei gedrehten Körpern über makeTransform)
  const T = body.transform ? makeTransform(body.transform) : null;
  const bbox = [0, 1, 2].map((k) => {
    const v = tris.flat().map((p) => (T ? T.apply(p)[k] : p[k]));
    return [Math.min(...v), Math.max(...v)];
  });
  return {
    name, desc, glyphs, body, expect,
    info: {
      meshVolume: meshVolume(tris),                // mm³ (Divergenzsatz)
      manifold: man.ok,                            // Netz wasserdicht orientiert?
      badEdges: man.badEdges, degenerate: man.degenerate,
      capTris,                                     // Dreiecke der Deckflächen mit Löchern
      bbox,                                        // Welt-Bounding-Box [min,max] je Achse
      glyphArea: st.area,                          // mm²: Außenkontur minus Zähler
      contours: st.contours,                       // Zahl der Konturen
      corners: st.corners,                         // Zahl der scharfen Ecken (> 40°)
      runs: st.runs,                               // glatte Kurvenläufe (G1-Ketten mit Bézier)
      points: st.points,                           // Punkte der abgeflachten Konturen
      plateVolume: w * d * h,                      // mm³
      plateArea: w * d,                            // mm²
      sign: engraved ? -1 : 1,                     // −1 = vertieft (Material entfernt)
      glyphHeight: height,                         // mm (Höhe der Glyphe über/unter der Platte)
      wallZ: engraved ? [h - depth, h] : [h, h + height],   // z-Bereich der Glyphenwände
    },
  };
}

export const GRAVUR_BODIES = [
  makeEntry({
    name: 'gravur_S_erhaben',
    desc: 'Platte 30×20×3, erhabenes „S“ (1 mm hoch, Strichbreite 1.4 mm)',
    glyphs: [{ key: 'S', dx: 12.0783, dy: 5 }],
    w: 30, d: 20,
    // minExtFaces 2: zwei G1-Ketten mit Bézier (Außen- und Innenkette der S-Kontur);
    //   die geraden Schnitte trennen sie. maxFaces 21: 6 ebene Plattenflächen + 1
    //   Glyphen-Deckfläche + 2 Läufe × 2 + 10 Reserve.
    expect: { minExtFaces: 2, maxFaces: 21 },
  }),
  makeEntry({
    name: 'gravur_8_erhaben',
    desc: 'Platte 30×20×3, erhabene „8“ (1 mm hoch, zwei Zähler als Löcher)',
    glyphs: [{ key: '8', dx: 15, dy: 10 }],
    w: 30, d: 20,
    // minExtFaces 3: Außenkontur (1 C1-Spline) + 2 Zähler. maxFaces 25: 6 ebene
    //   Plattenflächen + 3 Deckflächen (Glyphe + 2 Zählerböden) + 3 Läufe × 2 + 10.
    expect: { minExtFaces: 3, maxFaces: 25 },
  }),
  makeEntry({
    name: 'gravur_O_vertieft',
    desc: 'Platte 30×20×3, vertiefte „O“-Rille (1 mm tief, eckige Superellipsen-Konturen)',
    glyphs: [{ key: 'O', dx: 15, dy: 10 }],
    w: 30, d: 20, engraved: true, depth: 1,
    // minExtFaces 2: Außen- und Innenkontur der Rille (je 4 Bézier, ein G1-Lauf).
    //   maxFaces 22: 6 ebene Plattenflächen + 2 Deckflächen (Insel + Rillenboden) +
    //   2 Läufe × 2 + 10.
    expect: { minExtFaces: 2, maxFaces: 22 },
  }),
  makeEntry({
    name: 'gravur_mix_erhaben',
    desc: 'Platte 40×20×3, erhabenes „D“ (Stiel + ein Bogen) und erhabenes „mix“ (Ecken, '
      + 'quadratische und kubische Bézier) nebeneinander',
    glyphs: [{ key: 'D', dx: 6, dy: 5 }, { key: 'mix', dx: 22, dy: 5.5 }],
    w: 40, d: 20,
    // minExtFaces 2: je Glyphe ein Lauf mit Bézier (D: der Bogen; mix: quadratische +
    //   kubische Bézier, tangential aneinander). maxFaces 22: 6 ebene Plattenflächen +
    //   2 Glyphen-Deckflächen + 2 Läufe × 2 + 10.
    expect: { minExtFaces: 2, maxFaces: 22 },
  }),
  makeEntry({
    name: 'gravur_S_gedreht',
    desc: 'wie gravur_S_erhaben, aber im Raum gedreht (20°/35°/10°) und verschoben',
    glyphs: [{ key: 'S', dx: 12.0783, dy: 5 }],
    w: 30, d: 20,
    transform: { rot: [20, 35, 10], t: [5, -3, 12] },
    // wie gravur_S_erhaben: 2 Läufe, 6 Plattenflächen + 1 Deckfläche → 21
    expect: { minExtFaces: 2, maxFaces: 21 },
  }),
];

// Netz eines Körpers (buildMesh-Format → Dreiecke [[a,b,c], …])
export function buildGravurMesh(entry) {
  return buildMesh(entry.body);
}

// STLs schreiben (die Tests benutzen das nicht)
export function writeGravurStls(dir) {
  mkdirSync(dir, { recursive: true });
  const files = [];
  for (const e of GRAVUR_BODIES) {
    const f = join(dir, e.name + '.stl');
    writeFileSync(f, toBinaryStl(buildGravurMesh(e), e.name));
    files.push(f);
  }
  return files;
}

// CLI: node tests/gravur-bodies.mjs [zielordner]
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dir = process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), 'gravur-stl');
  for (const f of writeGravurStls(dir)) console.log(f);
}


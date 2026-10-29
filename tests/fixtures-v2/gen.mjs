// ─────────────────────────────────────────────────────────────────────────────
// Härtetest-Körper für Body-Defeaturing v2 (defeatureBands in exporters.js).
//
// EXTRUSIONSKÖRPER: scharfes Profil in XY (Polygon, Material LINKS der Laufrichtung → Außen-
// kontur CCW, Lochkonturen CW), entlang Z extrudiert. Die Deck-Kanten (Übergang Wand → Deck-
// fläche) werden als SCHICHTUNG verrundet: Schicht k bei Winkel φ_k = (π/2)·k/N liegt bei
// z = r(1−sin φ_k) bzw. H−r(1−sin φ_k), das Profil ist dort um s = r(1−cos φ_k) ins Material
// versetzt (Gehrungs-Versatz je Profilkante → an scharfen senkrechten Ecken treffen sich zwei
// Verrundungen exakt auf der Winkelhalbierenden). Benachbarte Schichten haben dieselbe Punktzahl
// und werden per Vierecken verbunden; Deckflächen per Ear-Clipping (Löcher über Brücken).
// s > 0 = Material schrumpft (konvexe Rundung/Fase), s < 0 = Material wächst (konkave Hohlkehle).
//
// Der Generator kennt das scharfe Profil → SOLL-Geometrie analytisch: `sharpen()` liefert den
// Körper ohne Rundungen (scharfe Kanten), dessen Volumen = Profilfläche × Höhe ist.
// Optionen je Säule: `edges` (nur einzelne Profilkanten verrundet), `draftDeg` (Formschräge),
// `wallSteps` (Wand in Z unterteilt); je Körper: `transform` (gedreht/verschoben), `caps` (eigene
// Deckflächen, z. B. Taschenboden). BODIES (a)–(i) = Pflichtkörper, `extra: true` = gezielte
// Angriffe; STRESS = Laufzeitkörper (~49k Dreiecke, wird nicht als Datei geschrieben).
// Profile mit echten Bögen: `filletedPolygon` (Eckrundung je Ecke, konvex wie einspringend) und
// die Blech-Profile L/U/Z (konstante Wandstärke, Innen-/Außenbogen konzentrisch). Solche Bögen
// wandelt der Exporter in Teil-Zylinder/-Kegel um — `expect.arcsOff` zählt die erwarteten
// Bogen-Flächen (Zylinder + Kegel) im AUS-Export. Körper mit `bends` (p1–p4, p6: Blechprofile):
// im AN-Lauf bleiben die Biegungen RUND (Soll: Bogen-Flächen wie AUS, Volumen = Netz), im Zusatz-
// Lauf AN+B (Schalter „Blech-Biegungen schärfen“) werden sie scharf (Soll: Rohprofil = `bends.pts`).
// Ausnahme: `expect.bendsSharpenable: false` (p4/p6 — Stirnseiten gefast: dort kann keine
// Entrundung die Biegung schärfen, auch ohne den Schalter nicht) → der AN+B-Lauf darf „Rundung
// bleibt“ liefern (nur eine Notiz, keine Soll-Verletzung).
// `bends.col` = die Säule mit der Biege-Kontur. p5 (Taschenecke, KEINE Biegung): die vier Ecken
// werden im AN-Lauf wie bisher geschärft — `cornerVariants` liefert die Soll-Varianten.
//
// Aufruf:  node tests/fixtures-v2/gen.mjs [zielordner]   (Default: tests/fixtures-v2/stl)
//          → schreibt je Körper eine binäre STL + prüft Manifold/Orientierung.
//          (Dateien > 300 KB sind nicht versioniert, siehe .gitignore — jederzeit neu erzeugbar.)
// Prüfung: node tests/fixtures-v2/check.mjs              (Pipeline + occt + Volumen vs. Soll)
// ─────────────────────────────────────────────────────────────────────────────
import { writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const PI = Math.PI;

// ── Profile (2D, Material links) ────────────────────────────────────────────
export const rectProfile = (x0, y0, w, h) => [[x0, y0], [x0 + w, y0], [x0 + w, y0 + h], [x0, y0 + h]];
// Kreis mit n Segmenten; hole=true → CW (Loch), sonst CCW
export const circleProfile = (cx, cy, R, n, hole = false) => {
  const pts = [];
  for (let i = 0; i < n; i++) { const a = 2 * PI * i / n; pts.push([cx + R * Math.cos(a), cy + R * Math.sin(a)]); }
  return hole ? pts.reverse() : pts;
};
// Rechteck w×h mit senkrechten Eckrundungen Rc (seg Segmente je Viertelbogen), CCW
export const roundedRectProfile = (w, h, Rc, seg) => {
  const pts = [];
  const corners = [[w - Rc, Rc, -PI / 2], [w - Rc, h - Rc, 0], [Rc, h - Rc, PI / 2], [Rc, Rc, PI]];
  for (const [cx, cy, a0] of corners) {
    for (let k = 0; k <= seg; k++) { const a = a0 + (PI / 2) * k / seg; pts.push([cx + Rc * Math.cos(a), cy + Rc * Math.sin(a)]); }
  }
  return pts;
};
// Rechteck w×h ab (x0, y0) mit TANGENTER Eckrundung an EINER Ecke: der Bogen (Radius r) liegt
// tangential an beiden angrenzenden Kanten (Mittelpunkt um r nach innen versetzt) — die Kanten
// knickEN dort also nicht, sie laufen stetig in den Bogen über. `corner` = 'tr' (oben rechts).
// `degStep` = Winkelschritt des Bogens in Grad (1° → 90 Segmente je 90°-Bogen). CCW.
// Achtung: der Bogen wird als Sehnen-POLYGON geführt (kein echter Bogen) — die Sehnenlänge ist
// 2·r·sin(degStep/2) (bei r = 1 und 1° = 0,01745 mm, UNTER der Mindest-Detailgröße 0,02 mm von
// mesh-clean.js).
export const tangentFilletRectProfile = (x0, y0, w, h, r, corner = 'tr', degStep = 1) => {
  if (corner !== 'tr') throw new Error(`tangentFilletRectProfile: Ecke ${corner} nicht vorgesehen`);
  const x1 = x0 + w, y1 = y0 + h, seg = Math.round(90 / degStep);
  const cx = x1 - r, cy = y1 - r;                          // Bogenmittelpunkt
  const pts = [[x0, y0], [x1, y0]];                        // Unterkante + rechte Kante bis zum Tangentenpunkt
  for (let k = 0; k <= seg; k++) {                         // Bogen 0° … 90° (Tangentenpunkte (x1;y1−r) und (x1−r;y1))
    const a = (k / seg) * PI / 2;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  pts.push([x0, y1]);                                      // Oberkante zurück
  return pts;
};
// L-Profil (Schenkel a×t und t×b) mit einspringender (konkaver) senkrechter Ecke, CCW
export const lProfile = (a, b, t) => [[0, 0], [a, 0], [a, t], [t, t], [t, b], [0, b]];
// Rechteck w×h, Unter- und Oberkante als flacher Kreisbogen (Stich f nach außen, seg Segmente); die
// Ecken bleiben echte Knicke. Kanten 0…seg−1 unten, seg rechts, seg+1…2·seg oben, 2·seg+1 links. CCW
export const bulgeProfile = (w, h, f, seg) => {
  const R = ((w / 2) ** 2 + f * f) / (2 * f), cy = R - f, pm = Math.asin(w / 2 / R), pts = [];
  for (let k = 0; k <= seg; k++) { const ph = -pm + 2 * pm * k / seg; pts.push([w / 2 + R * Math.sin(ph), cy - R * Math.cos(ph)]); }
  for (let k = 0; k <= seg; k++) { const ph = -pm + 2 * pm * k / seg; pts.push([w / 2 - R * Math.sin(ph), h - cy + R * Math.cos(ph)]); }
  return pts;
};
// Langloch-Profil (Stadion): Geraden der Länge len, Halbkreise R (seg Segmente je Halbkreis), CCW
export const slotProfile = (len, R, seg) => {
  const pts = [];
  for (let k = 0; k <= seg; k++) { const a = -PI / 2 + PI * k / seg; pts.push([R + len + R * Math.cos(a), R + R * Math.sin(a)]); }
  for (let k = 0; k <= seg; k++) { const a = PI / 2 + PI * k / seg; pts.push([R + R * Math.cos(a), R + R * Math.sin(a)]); }
  return pts;
};
// Ösen-Loch: Kreis R (n Segmente), dessen untere Hälfte durch eine Sehne (y = chordY) abgeschnitten
// ist (D-Form). Die Sehnen-Endpunkte liegen EXAKT auf dem Kreis (x = cx ± √(R²−(cy−chordY)²))
// und werden als ZUSÄTZLICHE Konturpunkte geführt — dadurch decken sich die Wandpunkte der unteren
// (D-) und der oberen (Kreis-)Hälfte exakt (die Wand bleibt ein zusammenhängender Zylinder).
// Rückgabe (je CCW, Startpunkt beliebig — zyklisch):
//   d     = D-Kontur der unteren Hälfte (der Bogen unter der Sehne entfällt, die Sehne schließt)
//   ring  = Vollkreis-Kontur MIT den Sehnen-Endpunkten (Wand der oberen Hälfte)
//   ledge = Steg-Kontur zwischen Sehne und Bogen (die waagerechte Fläche bei z = 5)
// Die Steg-Kontur ist der Teil des Rings zwischen den beiden Sehnen-Endpunkten, der den
// abgeschnittenen Bogen enthält (bei chordY < cy: der untere Bogen).
export function eyeletHole(cx, cy, R, n, chordY) {
  const pts = [];
  for (let i = 0; i < n; i++) { const a = 2 * PI * i / n; pts.push([cx + R * Math.cos(a), cy + R * Math.sin(a)]); }
  const dx = Math.sqrt(Math.max(0, R * R - (cy - chordY) * (cy - chordY)));
  const pL = [cx - dx, chordY], pR = [cx + dx, chordY];   // beide exakt auf dem Kreis
  pts.push(pL, pR);
  const ang = (p) => Math.atan2(p[1] - cy, p[0] - cx);
  const ring = pts.slice().sort((p, q) => ang(p) - ang(q));            // CCW
  const d = ring.filter((p) => p[1] >= chordY - 1e-9);                  // Bogen unter der Sehne entfällt
  const iL = ring.indexOf(pL), iR = ring.indexOf(pR);
  const ledge = iL < iR ? ring.slice(iL, iR + 1) : ring.slice(iR, iL + 1);   // Bogen mit den Schnittpunkten
  return { d, ring, ledge };
}

// Taschen-Kontur wie die Logo-Tasche am Kabelhalter: Rechteck w×h ab (x0, y0), Unterseite als flacher
// Kreisbogen (Stich f nach außen, arcSeg Sehnen), alle vier Ecken senkrecht mit rc gerundet (seg
// Segmente; unten tangential an Bogen und Seite). CCW. corners = Punkt-Indexbereiche [von, bis] der
// vier Eckbögen (einlaufende Kante endet in `von`, auslaufende beginnt in `bis`) — für die Varianten
// „Ecke scharf“ (s. sharpenCorners).
export const archPocketProfile = (x0, y0, w, h, f, arcSeg, rc, seg) => {
  const Rb = ((w / 2) ** 2 + f * f) / (2 * f), cx = x0 + w / 2, cy = y0 + Rb - f;
  const ex = x0 + rc, ey = cy - Math.sqrt((Rb - rc) ** 2 - (ex - cx) ** 2);  // Eckmittelpunkt unten links
  const aT = Math.atan2(ey - cy, ex - cx);                                     // Tangentenpunkt am Bogen (links)
  const pts = [], corners = [];
  const arc = (mx, my, a0, a1) => { corners.push([pts.length, pts.length + seg]); for (let k = 0; k <= seg; k++) { const a = a0 + (a1 - a0) * k / seg; pts.push([mx + rc * Math.cos(a), my + rc * Math.sin(a)]); } };
  arc(ex, ey, PI, aT + 2 * PI);                                                 // unten links: Seite → Bogen
  for (let k = 1; k < arcSeg; k++) { const a = aT + (-PI - 2 * aT) * k / arcSeg; pts.push([cx + Rb * Math.cos(a), cy + Rb * Math.sin(a)]); }
  arc(x0 + w - rc, ey, PI - aT, 2 * PI);                                        // unten rechts: Bogen → Seite
  arc(x0 + w - rc, y0 + h - rc, 0, PI / 2);
  arc(x0 + rc, y0 + h - rc, PI / 2, PI);
  return { pts, corners };
};
// Eckbögen (Indexbereiche [von, bis], ohne Umlauf-Überlauf) durch den Schnittpunkt der einlaufenden
// und der auslaufenden Kante ersetzen — so schärft v1 (defeatureFillets) eine senkrechte Eckrundung:
// Seiten-Ebenen = die angrenzenden Facetten.
export const sharpenCorners = (pts, ranges) => {
  const n = pts.length, rep = new Map(), skip = new Set();
  for (const [a, b] of ranges) {
    const p = pts[(a - 1 + n) % n], q = pts[a], r = pts[b], s = pts[(b + 1) % n];
    const d1 = [q[0] - p[0], q[1] - p[1]], d2 = [s[0] - r[0], s[1] - r[1]];
    const cr = d1[0] * d2[1] - d1[1] * d2[0];
    const t = ((r[0] - p[0]) * d2[1] - (r[1] - p[1]) * d2[0]) / cr;
    rep.set(a, [p[0] + t * d1[0], p[1] + t * d1[1]]);
    for (let i = a + 1; i <= b; i++) skip.add(i);
  }
  const out = [];
  for (let i = 0; i < n; i++) { if (rep.has(i)) out.push(rep.get(i)); else if (!skip.has(i)) out.push(pts[i]); }
  return out;
};

export const polyArea = (pts) => { let s = 0; for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; s += p[0] * q[1] - q[0] * p[1]; } return s / 2; };
// Halbring-Profil (C-Form): Außenbogen Ro, Innenbogen Ri (konzentrisch) über den Winkelbereich
// [a0Deg, a1Deg] (CCW), geschlossen durch die beiden radialen Endkanten; seg Segmente je Bogen.
// CCW (Material links) — der Bogen liegt links der Laufrichtung.
export const halfRingProfile = (cx, cy, Ro, Ri, a0Deg, a1Deg, seg) => {
  const a0 = a0Deg * PI / 180, a1 = a1Deg * PI / 180, pts = [];
  for (let k = 0; k <= seg; k++) { const a = a0 + (a1 - a0) * k / seg; pts.push([cx + Ro * Math.cos(a), cy + Ro * Math.sin(a)]); }
  for (let k = 0; k <= seg; k++) { const a = a1 + (a0 - a1) * k / seg; pts.push([cx + Ri * Math.cos(a), cy + Ri * Math.sin(a)]); }
  return pts;
};

// ── Profil-Eckrundungen (echte Bögen im Profil) ─────────────────────────────
// filletInfo: je Ecke der Bogen (Radius r, Mittelpunkt C, Öffnungswinkel phi = Drehwinkel der
// Ecke, Startwinkel a1 der Sehne C→T1). Konvexe Ecke (phi > 0): der Bogenmittelpunkt liegt
// LINKS der beiden Kanten (im Material), Abstand r/sin(θ/2) auf der Winkelhalbierenden.
// Einspringende Ecke (phi < 0): der Mittelpunkt liegt RECHTS der Kanten (im Ausschnitt),
// derselbe Abstand r/sin(θ/2). T1 = Berührpunkt auf der einlaufenden, T2 auf der auslaufenden
// Kante (Bogen tangential an beide).
export function filletInfo(pts, radii) {
  const n = pts.length, out = [];
  for (let i = 0; i < n; i++) {
    const r = radii[i] || 0;
    if (!(r > 0)) { out.push(null); continue; }
    const p = pts[(i - 1 + n) % n], v = pts[i], q = pts[(i + 1) % n];
    let a = [v[0] - p[0], v[1] - p[1]]; const la = Math.hypot(a[0], a[1]); a = [a[0] / la, a[1] / la];
    let b = [q[0] - v[0], q[1] - v[1]]; const lb = Math.hypot(b[0], b[1]); b = [b[0] / lb, b[1] / lb];
    const cr = a[0] * b[1] - a[1] * b[0];
    if (Math.abs(cr) < 1e-12) throw new Error(`Ecke ${i} ist kollinear — keine Rundung möglich`);
    const na = [-a[1], a[0]], nb = [-b[1], b[0]];                 // Linke-Normalen der Kanten
    const phi = Math.atan2(cr, a[0] * b[0] + a[1] * b[1]);      // Drehwinkel der Ecke (positiv = konvex)
    const s = phi > 0 ? 1 : -1;                                  // konvex: Mitte links, einspringend: rechts
    // Die um s·r verschobenen Kantenlinien schneiden sich im Bogenmittelpunkt:
    //   v + s·r·na + λ·a  =  v + s·r·nb + μ·b   →   λ·a − μ·b = s·r·(nb − na)
    const wx = s * r * (nb[0] - na[0]), wy = s * r * (nb[1] - na[1]);
    const det = -cr;
    const lam = (-wx * b[1] + b[0] * wy) / det;
    const C = [v[0] + s * r * na[0] + lam * a[0], v[1] + s * r * na[1] + lam * a[1]];
    const T1 = [C[0] - s * r * na[0], C[1] - s * r * na[1]];      // Berührpunkt einlaufende Kante
    out.push({ C, r, phi, s, convex: s > 0, a1: Math.atan2(T1[1] - C[1], T1[0] - C[0]) });
  }
  return out;
}
// Polygon (CCW) mit Eckrundung je Ecke: radii[i] = Radius an pts[i] (0 = scharf), seg Segmente
// je Bogen (unabhängig vom Winkel). Konvexe UND einspringende Ecken: Bogen tangential an beide
// Kanten, Mittelpunkt auf der Winkelhalbierenden im Abstand r/sin(θ/2) (θ = Innenwinkel).
// Ergebnis CCW (die Grad-Profile der Bleche).
export const filletedPolygon = (pts, radii, seg) => {
  const info = filletInfo(pts, radii), out = [];
  for (let i = 0; i < pts.length; i++) {
    const f = info[i];
    if (!f) { out.push([pts[i][0], pts[i][1]]); continue; }
    for (let k = 0; k <= seg; k++) {
      const a = f.a1 + f.phi * k / seg;
      out.push([f.C[0] + f.r * Math.cos(a), f.C[1] + f.r * Math.sin(a)]);
    }
  }
  return out;
};
// Biege-Paare (Blech-Profil): die einspringende Ecke (Radius ri) und die gegenüberliegende konvexe
// Ecke (Radius ri+t) müssen denselben Bogenmittelpunkt haben (konzentrisch) — sonst wäre die
// Wandstärke ungleichmäßig. Rückgabe: größte Abweichung der Mittelpunkte (mm).
export function bendsConcentric(pts, radii, t) {
  const info = filletInfo(pts, radii), inner = [], outer = [];
  for (const c of info) { if (!c) continue; (c.convex ? outer : inner).push(c); }
  if (inner.length !== outer.length) throw new Error(`Biege unpaarig: ${inner.length} Innen-, ${outer.length} Außenbögen`);
  let worst = 0; const used = new Set();
  for (const c of inner) {
    let best = null, bd = Infinity;
    for (const o of outer) {
      if (used.has(o) || Math.abs(o.r - (c.r + t)) > 1e-12) continue;
      const d = Math.hypot(o.C[0] - c.C[0], o.C[1] - c.C[1]);
      if (d < bd) { bd = d; best = o; }
    }
    if (!best) throw new Error(`kein Außenbogen (Radius r+t) zur Innenecke r=${c.r}`);
    used.add(best); worst = Math.max(worst, bd);
  }
  if (worst > 1e-9) throw new Error(`Bogenmittelpunkte nicht konzentrisch (max. Abweichung ${worst.toExponential(3)} mm)`);
  return worst;
}
// Blech-Profile konstanter Wandstärke t, Innenradius ri, Außenradius ri+t (konzentrisch), CCW:
// L-Profil (Schenkel a×t und t×b), U-Profil (w×h), Z-Haken (Flansch unten links, Steg, Flansch
// oben rechts — zwei GEGENläufige Biegungen). `*Raw` = die Eckpunkte vor der Rundung (Rohkontur).
export const sheetLRadii = (ri, t) => [ri + t, 0, 0, ri, 0, 0];
export const sheetLRaw = (a, b, t) => [[0, 0], [a, 0], [a, t], [t, t], [t, b], [0, b]];
export const sheetLProfile = (a, b, t, ri, seg) => filletedPolygon(sheetLRaw(a, b, t), sheetLRadii(ri, t), seg);
export const sheetURadii = (ri, t) => [ri + t, ri + t, 0, 0, ri, ri, 0, 0];
export const sheetURaw = (w, h, t) => [[0, 0], [w, 0], [w, h], [w - t, h], [w - t, t], [t, t], [t, h], [0, h]];
export const sheetUProfile = (w, h, t, ri, seg) => filletedPolygon(sheetURaw(w, h, t), sheetURadii(ri, t), seg);
export const sheetZRadii = (ri, t) => [0, ri + t, ri, 0, 0, ri + t, ri, 0];
export const sheetZRaw = (a, H, t) => [[-a, 0], [t, 0], [t, H - t], [a, H - t], [a, H], [0, H], [0, t], [-a, t]];
export const sheetZProfile = (a, H, t, ri, seg) => filletedPolygon(sheetZRaw(a, H, t), sheetZRadii(ri, t), seg);

// ── Gehrungs-Versatz: Kante i (pts[i]→pts[i+1]) um off[i] nach LINKS (ins Material) ──
export function offsetRing(pts, off) {
  const n = pts.length, out = [];
  const o = (i) => (typeof off === 'number' ? off : off[(i + n) % n]);
  for (let i = 0; i < n; i++) {
    const a = pts[(i - 1 + n) % n], v = pts[i], b = pts[(i + 1) % n];
    const o1 = o(i - 1), o2 = o(i);
    let t1 = [v[0] - a[0], v[1] - a[1]], t2 = [b[0] - v[0], b[1] - v[1]];
    const l1 = Math.hypot(...t1), l2 = Math.hypot(...t2);
    t1 = [t1[0] / l1, t1[1] / l1]; t2 = [t2[0] / l2, t2[1] / l2];
    const n1 = [-t1[1], t1[0]], n2 = [-t2[1], t2[0]];
    const cr = t1[0] * t2[1] - t1[1] * t2[0];
    if (Math.abs(cr) < 1e-9) {
      if (Math.abs(o1 - o2) > 1e-12) throw new Error('kollineare Kanten mit verschiedenem Versatz');
      out.push([v[0] + n1[0] * o1, v[1] + n1[1] * o1]); continue;
    }
    // v + n1·o1 + s·t1 = v + n2·o2 + u·t2  →  s = ((n2·o2 − n1·o1) × t2) / (t1 × t2)
    const w = [n2[0] * o2 - n1[0] * o1, n2[1] * o2 - n1[1] * o1];
    const s = (w[0] * t2[1] - w[1] * t2[0]) / cr;
    out.push([v[0] + n1[0] * o1 + s * t1[0], v[1] + n1[1] * o1 + s * t1[1]]);
  }
  return out;
}

// ── Deck-Übergänge als Schichtfolgen [{z, s}] (z aufsteigend) ───────────────
// kind: 'sharp' | 'round' (konvex) | 'concave' (Hohlkehle) | 'chamfer' (45°-Fase, Breite r) |
//       'countersink' (Senkung: Kegel mit Tiefe depth, Spitzenwinkel angleDeg; Kanten-Rundungen r/rw) |
//       'ellipse' (konvexe Ellipsen-Rundung, Halbachsen a entlang der Deckfläche, b entlang der Wand)
// draftDeg: Wand-Neigung (Formschräge; Wand bei Höhe z um z·tan α ins Material versetzt) —
// die Rundung bleibt dann tangential an Wand UND Deckfläche (Mittelpunkt im Abstand r zu beiden).
function capSeq(spec, end, z0, z1, draftDeg = 0) {
  const kind = spec?.kind || 'sharp';
  const al = draftDeg * PI / 180, ta = Math.tan(al);
  const wallS = (z) => (z - z0) * ta;
  if (kind === 'sharp') return [end === 'bottom' ? { z: z0, s: wallS(z0) } : { z: z1, s: wallS(z1) }];
  const r = spec.r, N = spec.N ?? 8;
  if (kind === 'countersink') {
    // Senkung (Kegel, Spitzenwinkel angleDeg, Default 90°) mit Tiefe `depth` an der Mündung. Die
    // Kante Senkung → Deckfläche ist mit r verrundet, die Kante Wand → Senkung mit rw (0 = scharf).
    // Lokale Koordinate u = Abstand zur Deckfläche: Wand-Ende → (Bogen rw) → Kegel → (Bogen r) →
    // Deckfläche (u=0). Beim Schärfen (sharpen) bleibt der Kegel erhalten, nur r, rw → 0.
    if (draftDeg) throw new Error('Senkung + Formschräge nicht vorgesehen');
    const D = spec.depth, beta = ((spec.angleDeg ?? 90) / 2) * PI / 180, rf = r || 0, rw = spec.rw || 0;
    const sEdge = D * Math.tan(beta);                     // scharfe Senkungskante (Versatz an der Deckfläche)
    const tlen = rf * Math.tan((PI / 2 - beta) / 2);      // Tangentenlänge der Deck-Verrundung
    const tw = rw * Math.tan(beta / 2);                   // Tangentenlänge der Wand-Verrundung
    if (tlen + tw > D / Math.cos(beta) - 1e-9) throw new Error('Senkungs-Verrundungen zu groß');
    const us = [];
    if (rw > 0) {
      for (let k = 0; k <= N; k++) { const a = PI + beta * k / N; us.push({ u: D + tw + rw * Math.sin(a), s: rw + rw * Math.cos(a) }); }
      us[0].s = 0;                                        // exakt auf der Wand
    } else us.push({ u: D, s: 0 });
    if (rf > 0) {
      for (let k = 0; k <= N; k++) {
        const a = -(PI - beta) + (PI / 2 - beta) * k / N;
        us.push({ u: rf + rf * Math.sin(a), s: sEdge + tlen + rf * Math.cos(a) });
      }
      us[us.length - 1].u = 0;                            // exakt in der Deckebene
    } else us.push({ u: 0, s: sEdge });
    const seq = us.map(({ u, s }) => ({ z: end === 'bottom' ? z0 + u : z1 - u, s }));
    return end === 'bottom' ? seq.reverse() : seq;
  }
  if (kind === 'ellipse') {
    // Nicht kreisförmige Kanten-Rundung (Viertel-Ellipse, tangential an Wand UND Deckfläche) mit
    // gleichmäßigen Normalenwinkel-Schritten — v2 kennt nur Kreisbogen-Rundungen (Rundungsprofil) und
    // darf hier NIE eine Schicht als „Fase zwischen zwei Rundungen“ deuten. Normalenwinkel α (0 = Wand,
    // 90° = Deckfläche) ↔ Ellipsen-Parameter θ mit tan θ = (b/a)·tan α; u = Abstand zur Deckfläche.
    if (draftDeg) throw new Error('Ellipsen-Rundung + Formschräge nicht vorgesehen');
    const a = spec.a, b = spec.b, us = [];
    for (let k = 0; k <= N; k++) {
      const alpha = (PI / 2) * k / N, th = Math.atan2(b * Math.sin(alpha), a * Math.cos(alpha));
      us.push({ u: b - b * Math.sin(th), s: a - a * Math.cos(th) });
    }
    us[0].s = 0; us[N].u = 0;                             // exakt auf der Wand / in der Deckebene
    const seq = us.map(({ u, s }) => ({ z: end === 'bottom' ? z0 + u : z1 - u, s }));
    return end === 'bottom' ? seq.reverse() : seq;
  }
  if (kind === 'chamfer') {
    if (draftDeg) throw new Error('Fase + Formschräge nicht vorgesehen');
    return end === 'bottom' ? [{ z: z0, s: r }, { z: z0 + r, s: 0 }] : [{ z: z1 - r, s: 0 }, { z: z1, s: r }];
  }
  const sign = kind === 'concave' ? -1 : 1;
  if (kind === 'concave' && draftDeg) throw new Error('Hohlkehle + Formschräge nicht vorgesehen');
  const seq = [];
  if (end === 'bottom') {
    // Normalen-Elevation ψ: −π/2 (Boden) → α (Wand); Mittelpunkt (s_c, z0+r)
    const zc = z0 + r, sc = wallS(zc) + r / Math.cos(al);
    for (let k = 0; k <= N; k++) { const psi = -PI / 2 + (PI / 2 + al) * k / N; seq.push({ z: zc + r * Math.sin(psi), s: sign * (sc - r * Math.cos(psi)) }); }
  } else {
    const zc = z1 - r, sc = wallS(zc) + r / Math.cos(al);
    for (let k = 0; k <= N; k++) { const psi = al + (PI / 2 - al) * k / N; seq.push({ z: zc + r * Math.sin(psi), s: sign * (sc - r * Math.cos(psi)) }); }
  }
  // exakte Endwerte (keine Rundungsdrift an den Deckflächen)
  if (end === 'bottom') seq[0].z = z0; else seq[seq.length - 1].z = z1;
  return seq;
}

// Säule = eine Profilkontur über die Höhe: Ringe (gleiche Punktzahl) von z0 bis z1.
// spec.bottom/top: { kind, r, N, edges? } — `edges` = Liste der Profilkanten-Indizes, die den
// Übergang bekommen (Rest scharf; Schicht-z bleibt gemeinsam, nur der Versatz ist 0).
// col.wallSteps: Wand in so viele Zeilen unterteilen (Default 1 = ein Viereck je Profilkante).
// col.topRot: { deg, c: [cx, cy] } — dreht NUR den obersten Ring der Säule um die vertikale
// Achse durch (cx, cy) (CCW von +Z). Die Wand-Dreiecke (lo[i], lo[j], hi[j]) / (lo[i], hi[j],
// hi[i]) bleiben unverändert → die Wand wird zum Zickzack aus nicht-koplanaren Dreiecken; keine
// Seitenkante ist eine senkrechte Mantellinie. Nur erlaubt bei scharfen Enden und ohne wallSteps.
function buildRings(col) {
  const { profile, z0, z1, draftDeg = 0 } = col;
  const n = profile.length;
  const lay = (spec, end) => {
    const seq = capSeq(spec, end, z0, z1, draftDeg);
    if (!spec?.edges) return seq.map((l) => ({ z: l.z, off: l.s }));
    const set = new Set(spec.edges);
    return seq.map((l) => ({ z: l.z, off: Array.from({ length: n }, (_, e) => (set.has(e) ? l.s : 0)) }));
  };
  const lo = lay(col.bottom, 'bottom'), hi = lay(col.top, 'top');
  // Wand in Z unterteilen (wie viele CAD-Exporte): Zwischenringe linear zwischen Wand-Anfang/-Ende
  const mid = [];
  for (let i = 1; i < (col.wallSteps || 1); i++) {
    const A = lo[lo.length - 1], B = hi[0], t = i / col.wallSteps;
    const lerp = (x, y) => x + (y - x) * t;
    mid.push({ z: lerp(A.z, B.z), off: typeof A.off === 'number' ? lerp(A.off, B.off) : A.off.map((x, e) => lerp(x, B.off[e])) });
  }
  const layers = [...lo, ...mid, ...hi];
  for (let k = 1; k < layers.length; k++) if (!(layers[k].z > layers[k - 1].z + 1e-9)) throw new Error(`Schichten nicht aufsteigend (${col.name || ''} k=${k})`);
  const s0 = Math.sign(polyArea(profile));
  const rings = layers.map(({ z, off }) => {
    const ring2 = offsetRing(profile, off);
    if (Math.sign(polyArea(ring2)) !== s0) throw new Error('Versatz kehrt Kontur um (Rundung zu groß)');
    return ring2.map(([x, y]) => [x, y, z]);
  });
  // topRot: nur den OBERSTEN Ring der Säule drehen (der Rest der Säule bleibt unberührt) — die
  // Wand-Dreiecke in buildMesh bleiben (lo[i], lo[j], hi[j]) / (lo[i], hi[j], hi[i]) und bilden
  // dadurch den Zickzack. Deckflächen, die auf diesen Ring verweisen (cap.outer/cap.holes mit
  // { c, end: 'top' }), nehmen ihn über ringAt automatisch mit.
  if (col.topRot) {
    const sharp = (s) => !s || s.kind === 'sharp';
    if (!sharp(col.bottom) || !sharp(col.top)) throw new Error(`topRot nur bei scharfen Enden erlaubt (${col.name || 'Säule'})`);
    if ((col.wallSteps || 1) !== 1) throw new Error(`topRot nicht mit wallSteps erlaubt (${col.name || 'Säule'})`);
    const { deg, c } = col.topRot;
    if (!Array.isArray(c) || c.length !== 2) throw new Error(`topRot.c muss [cx, cy] sein (${col.name || 'Säule'})`);
    const [cx, cy] = c, a = deg * PI / 180, ca = Math.cos(a), sa = Math.sin(a);
    const top = rings[rings.length - 1];
    for (let i = 0; i < top.length; i++) {
      const dx = top[i][0] - cx, dy = top[i][1] - cy;
      top[i] = [cx + dx * ca - dy * sa, cy + dx * sa + dy * ca, top[i][2]];
    }
  }
  return rings;
}

// ── Ear-Clipping (Polygon CCW, Löcher CW über Brücken eingefügt) ───────────
const area2 = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
const segCross = (p1, p2, p3, p4) => {
  const d1 = area2(p3, p4, p1), d2 = area2(p3, p4, p2), d3 = area2(p1, p2, p3), d4 = area2(p1, p2, p4);
  return ((d1 > 1e-12 && d2 < -1e-12) || (d1 < -1e-12 && d2 > 1e-12)) && ((d3 > 1e-12 && d4 < -1e-12) || (d3 < -1e-12 && d4 > 1e-12));
};
const pointInPoly = (p, poly) => {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
};
function earClip(poly) {
  const idx = poly.map((_, i) => i), tris = [];
  const inTri = (p, a, b, c) => area2(a, b, p) > 1e-12 && area2(b, c, p) > 1e-12 && area2(c, a, p) > 1e-12;
  let guard = 0;
  while (idx.length > 3 && guard++ < 1e6) {
    let cut = false;
    for (let i = 0; i < idx.length; i++) {
      const ia = idx[(i + idx.length - 1) % idx.length], ib = idx[i], ic = idx[(i + 1) % idx.length];
      const a = poly[ia], b = poly[ib], c = poly[ic];
      if (area2(a, b, c) <= 1e-12) continue;
      let ok = true;
      for (const j of idx) {
        if (j === ia || j === ib || j === ic) continue;
        const p = poly[j];
        if (p === a || p === b || p === c) continue; // Brücken-Duplikat
        if (inTri(p, a, b, c)) { ok = false; break; }
      }
      if (!ok) continue;
      tris.push([a, b, c]); idx.splice(i, 1); cut = true; break;
    }
    if (!cut) throw new Error('Ear-Clipping fehlgeschlagen');
  }
  tris.push(idx.map((i) => poly[i]));
  return tris;
}
// ── Pinch: Ränder, die sich in EINER Ecke berühren ──────────────────────────
// Zwei Löcher, die sich in einem Eckpunkt berühren (Pinch), lassen sich nicht über eine Brücke
// verbinden: die Brücke wäre entartet (Länge 0) und das Ear-Clipping scheitert am Schlitz.
// Stattdessen wird der Berührpunkt AUFSGESCHNITTEN: das Dreieck (v, A, B) — A/B sind die
// Nachbarn von v auf den beiden Rändern — wird zum Loch (die beiden Löcher verschmelzen zu
// einem simplen Ring: normale Brücke + Ear-Clipping) und NACH der Triangulierung als Dreieck
// wieder eingesetzt. Die Ränder berühren sich danach wieder exakt in v — das Netz bleibt
// manifold, der Export muss dort aufteilen (z1).
const ptKey2 = (p) => `${Math.round(p[0] * 1e6)},${Math.round(p[1] * 1e6)}`;
const samePt2 = (a, b) => ptKey2(a) === ptKey2(b);
// Zwei Ränder mit gemeinsamem Eckpunkt finden (Berührung in einer Ecke)
function findTouch(rings) {
  const seen = new Map();                       // Punktschlüssel → erster Fund { i, k }
  for (let i = 0; i < rings.length; i++) {
    const r = rings[i];
    for (let k = 0; k < r.length; k++) {
      const key = ptKey2(r[k]);
      const o = seen.get(key);
      if (o && o.i !== i) return { i: o.i, j: i, vi: o.k, vj: k };
      if (!o) seen.set(key, { i, k });
    }
  }
  return null;
}
// Aufschneiden: die beiden berührenden Ränder zu EINEM Ring verschmelzen (Knoten v bleibt
// erhalten). Das Aufschnitt-Dreieck (v, A, B) gehört danach zum Lochbereich und wird als
// eigenes Dreieck zurückgegeben (es gehört zum Material, nicht zum Loch).
function cutOpen(rings, touch, outer) {
  const R1 = rings[touch.i], R2 = rings[touch.j];
  const n1 = R1.length, n2 = R2.length;
  const v = R1[touch.vi];
  for (const da of [-1, 1]) for (const db of [-1, 1]) {
    const A = R1[(touch.vi + da + n1) % n1], B = R2[(touch.vj + db + n2) % n2];
    if (samePt2(A, v) || samePt2(B, v) || samePt2(A, B)) continue;
    if (Math.abs(polyArea([v, A, B])) < 1e-12) continue;      // entartet (kollinear)
    // Das Aufschnitt-Dreieck muss im Material liegen (nicht in/über einem Loch)
    const c = [(v[0] + A[0] + B[0]) / 3, (v[1] + A[1] + B[1]) / 3];
    if (!pointInPoly(c, outer)) continue;
    if (rings.some((r) => pointInPoly(c, r))) continue;
    let bad = false;
    for (const r of rings) {
      for (let k = 0; k < r.length && !bad; k++) {
        const e1 = r[k], e2 = r[(k + 1) % r.length];
        for (const [p, q] of [[v, A], [A, B], [B, v]]) {
          if (samePt2(p, e1) || samePt2(p, e2) || samePt2(q, e1) || samePt2(q, e2)) continue;
          if (segCross(p, q, e1, e2)) { bad = true; break; }
        }
      }
      if (bad) break;
    }
    if (bad) continue;
    // Verschmelzen: Ring1 von A über den Umweg zu v, dann Ring2 von v über den Umweg zu B —
    // die Sehne (B→A) schließt den Ring (der Knoten v kommt nur einmal vor). Beide Ketten
    // folgen der Wicklung des jeweiligen Rings (Löcher sind im Uhrzeigersinn).
    const merged = [];
    for (let k = 0; k < n1; k++) merged.push(R1[(touch.vi + da * (k + 1) + n1 * 2) % n1]);
    for (let k = 1; k < n2; k++) merged.push(R2[(touch.vj - db * k + n2 * 2) % n2]);
    // Der verschmolzene Ring muss DIESELBE Wicklung haben wie die beiden Lochränder (beide CW):
    // sonst läuft ein Kettenstück gegen die Wicklung, der Ring wäre kein Loch mehr (die Brücke
    // entartet, das Netz wird nicht manifold).
    if (Math.sign(polyArea(merged)) !== Math.sign(polyArea(R1))) continue;
    // Dreieck (v, A, B): es füllt den aufgeschnittenen Spalt wieder auf (die Kante A–B wird
    // von beiden Seiten gegenteilig benutzt → das Netz bleibt manifold)
    const tri = [v, A, B];
    const out = rings.slice();
    out[touch.i] = merged;
    out.splice(touch.j, 1);
    return { rings: out, tri };
  }
  return null;
}
export function triangulateWithHoles(outer, holes) {
  let poly = outer.slice();
  let rings = holes.slice();
  const notchTris = [];
  // Berührende Ränder aufschneiden (Pinch) — danach sind alle Löcher einfach getrennt
  for (let guard = 0; guard < 8; guard++) {
    const touch = findTouch(rings);
    if (!touch) break;
    const cut = cutOpen(rings, touch, outer);
    if (!cut) break;                          // Aufschneiden nicht möglich → normale Brücke
    rings = cut.rings;
    notchTris.push(cut.tri);
  }
  const maxX = (h) => Math.max(...h.map((p) => p[0]));
  const rest = rings.slice().sort((a, b) => maxX(b) - maxX(a));
  while (rest.length) {
    const h = rest.shift();
    let mi = 0; for (let i = 1; i < h.length; i++) if (h[i][0] > h[mi][0]) mi = i;
    const M = h[mi];
    const cands = poly.map((p, i) => ({ i, d: Math.hypot(p[0] - M[0], p[1] - M[1]) })).sort((a, b) => a.d - b.d);
    let bi = -1;
    for (const { i } of cands) {
      const P = poly[i];
      const mid = [(P[0] + M[0]) / 2, (P[1] + M[1]) / 2];
      if (!pointInPoly(mid, poly) || [h, ...rest].some((hh) => pointInPoly(mid, hh))) continue;
      let clear = true;
      for (const L of [poly, h, ...rest]) {
        for (let k = 0; k < L.length && clear; k++) {
          const e1 = L[k], e2 = L[(k + 1) % L.length];
          if (e1 === P || e2 === P || e1 === M || e2 === M) continue;
          if (segCross(M, P, e1, e2)) clear = false;
        }
        if (!clear) break;
      }
      if (clear) { bi = i; break; }
    }
    if (bi < 0) throw new Error('keine Brücke zum Loch gefunden');
    const hr = h.slice(mi).concat(h.slice(0, mi));
    poly = poly.slice(0, bi + 1).concat(hr, [M, poly[bi]], poly.slice(bi + 1));
  }
  return earClip(poly).concat(notchTris);
}

// ── Körper bauen ────────────────────────────────────────────────────────────
// body.columns: [{ name, profile, z0, z1, bottom, top, draftDeg? }]
// body.caps (optional): [{ z, up, outer: {c, end, rev?} | {pts: [...]}, holes: [{c, end, rev?}] }]
//   Default: Deckel oben/unten aus allen Säulen (CCW-Säulen = Außen, CW-Säulen = Löcher).
//   `outer.pts` = EXPLIZITER Ring (3D-Punkte, CCW) statt eines Säulenrings — nötig für Flächen,
//   deren Rand kein Säulenring ist (z. B. der schmale Steg zwischen zwei Profilen einer Öse).
// body.jitter (optional): mm — deterministisches Rauschen auf jedem Netzpunkt
//   (gleicher Punkt → gleiches Rauschen, Hash der gerundeten Koordinate). Die Punkte
//   werden VOR der starren Transformation verrauscht (die Drehung bleibt exakt).
export function buildMesh(body) {
  const rings = body.columns.map(buildRings);
  const tris = [];
  rings.forEach((rs) => {
    for (let k = 0; k + 1 < rs.length; k++) {
      const lo = rs[k], hi = rs[k + 1], n = lo.length;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        tris.push([lo[i], lo[j], hi[j]], [lo[i], hi[j], hi[i]]); // Normale nach außen (Material links)
      }
    }
  });
  const ringAt = ({ c, end, rev }) => { const rs = rings[c]; const r = end === 'top' ? rs[rs.length - 1] : rs[0]; return rev ? r.slice().reverse() : r; };
  const capOuter = (o) => (o.pts ? o.pts : ringAt(o));   // Spaltfläche: expliziter Ring
  let caps = body.caps;
  if (!caps) {
    const outerIdx = body.columns.map((col, i) => i).filter((i) => polyArea(body.columns[i].profile) > 0);
    const holeIdx = body.columns.map((col, i) => i).filter((i) => polyArea(body.columns[i].profile) < 0);
    caps = [];
    for (const oi of outerIdx) for (const end of ['top', 'bottom']) caps.push({ up: end === 'top', outer: { c: oi, end }, holes: holeIdx.map((c) => ({ c, end })) });
  }
  for (const cap of caps) {
    // Kegelspitze (Bohrspitze): statt Deckfläche ein Fächer vom Randkreis zur Apex
    // (apexZ = Höhe der Apex). Die Normale zeigt wie bei den übrigen Deckflächen nach `cap.up`.
    if (typeof cap.apexZ === 'number') {
      const ring = ringAt(cap.outer), n = ring.length;
      const prof = body.columns[cap.outer.c].profile;
      const cx = prof.reduce((s, p) => s + p[0], 0) / prof.length, cy = prof.reduce((s, p) => s + p[1], 0) / prof.length;
      const apex = [cx, cy, cap.apexZ];
      for (let i = 0; i < n; i++) {
        const a = ring[i], b = ring[(i + 1) % n];
        tris.push(cap.up ? [a, b, apex] : [a, apex, b]);
      }
      continue;
    }
    const outer = capOuter(cap.outer), holes = (cap.holes || []).map(ringAt);
    for (const [a, b, c] of triangulateWithHoles(outer, holes)) tris.push(cap.up ? [a, b, c] : [a, c, b]);
  }
  let out = tris;
  // Rauschen: `jitter` (alle drei Achsen) oder `jitterXY` (nur x/y). `jitterXY` lässt die
  // Höhen exakt — die ebenen Deckflächen bleiben dann EINE ebene Fläche. Mit Höhen-Rauschen
  // zerlegt der Exporter die Deckfläche in Dreiecke (die Fläche ist nicht mehr planar genug),
  // und die Bogen-Kanten der Deckfläche gehören dann zu verschiedenen Flächen: das Band kann
  // dann nicht mehr bestätigt werden (validateArcBands) und bleibt facettiert — der Fehler
  // liegt dann VOR der Bogen-Geometrie und ist nicht dort zu suchen.
  const jam = body.jitterXY || body.jitter;
  if (jam) {
    const nAxes = body.jitterXY ? 2 : 3;
    const jm = new Map();
    const jit = (p) => {
      const k = p.map((x) => Math.round(x * 1e6)).join(',');
      let q = jm.get(k);
      if (!q) { q = hashJitter(p, jam, nAxes); jm.set(k, q); }
      return q;
    };
    out = tris.map((t) => t.map(jit));
  }
  if (!body.transform) return out;
  // Lage im Raum (gedreht/verschoben): jeden Punkt genau einmal abbilden → geteilte Punkte bleiben geteilt
  const T = makeTransform(body.transform);
  const memo = new Map();
  const map = (p) => { let q = memo.get(p); if (!q) { q = T.apply(p); memo.set(p, q); } return q; };
  return out.map((t) => t.map(map));
}

// Deterministisches Rauschen (FNV-1a über die gerundeten Koordinaten, je Achse ein
// eigener Versatz in [−amp, amp]) — gleicher Punkt → gleiches Rauschen.
// `nAxes` = 2 → nur x/y (die Höhen bleiben exakt, s. buildMesh).
function hashJitter(p, amp, nAxes = 3) {
  let h = 2166136261 >>> 0;
  const key = p.map((x) => Math.round(x * 1e6)).join(',');
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  const out = p.slice();
  for (let k = 0; k < nAxes; k++) {
    h ^= h >>> 15; h = Math.imul(h, 2246822507) >>> 0;
    h ^= h >>> 13; h = Math.imul(h, 3266489909) >>> 0;
    out[k] = p[k] + ((h >>> 0) / 4294967296 * 2 - 1) * amp;
  }
  return out;
}

// Starre Transformation: Drehung um X, dann Y, dann Z (Grad), danach Verschiebung t.
// `inverse` bildet Weltpunkte zurück ins Körpersystem (für Schnittflächen bei z = const).
export function makeTransform({ rot = [0, 0, 0], t = [0, 0, 0] } = {}) {
  const [ax, ay, az] = rot.map((d) => d * PI / 180);
  const Rx = [[1, 0, 0], [0, Math.cos(ax), -Math.sin(ax)], [0, Math.sin(ax), Math.cos(ax)]];
  const Ry = [[Math.cos(ay), 0, Math.sin(ay)], [0, 1, 0], [-Math.sin(ay), 0, Math.cos(ay)]];
  const Rz = [[Math.cos(az), -Math.sin(az), 0], [Math.sin(az), Math.cos(az), 0], [0, 0, 1]];
  const mul = (A, B) => A.map((row) => [0, 1, 2].map((j) => row[0] * B[0][j] + row[1] * B[1][j] + row[2] * B[2][j]));
  const M = mul(Rz, mul(Ry, Rx));
  return {
    apply: (p) => [0, 1, 2].map((i) => M[i][0] * p[0] + M[i][1] * p[1] + M[i][2] * p[2] + t[i]),
    inverse: (q) => { const w = [q[0] - t[0], q[1] - t[1], q[2] - t[2]]; return [0, 1, 2].map((i) => M[0][i] * w[0] + M[1][i] * w[1] + M[2][i] * w[2]); },
  };
}

// Volumen (Divergenzsatz) — exakt für geschlossene, konsistent orientierte Netze
export const triVolume = (a, b, c) => (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
export const meshVolume = (tris) => { let v = 0; for (const [a, b, c] of tris) v += triVolume(a, b, c); return v; };

// Manifold + Orientierung: jede (ungerichtete) Kante genau 2×, und zwar gegenläufig; keine
// entarteten Dreiecke. Schlüssel auf float32 (so wie die binäre STL die Punkte speichert).
export function checkManifold(tris) {
  const f = Math.fround;
  const key = (p) => `${f(p[0])},${f(p[1])},${f(p[2])}`;
  const dir = new Map();
  let degenerate = 0;
  for (const [a, b, c] of tris) {
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    if (Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) < 1e-9) degenerate++;
    for (const [p, q] of [[a, b], [b, c], [c, a]]) { const k = key(p) + '>' + key(q); dir.set(k, (dir.get(k) || 0) + 1); }
  }
  let bad = 0;
  for (const [k, n] of dir) { const [p, q] = k.split('>'); if (n !== 1 || dir.get(q + '>' + p) !== 1) bad++; }
  return { ok: bad === 0 && degenerate === 0, badEdges: bad, degenerate, edges: dir.size / 2 };
}

export function toBinaryStl(tris, name = 'fixture') {
  const buf = Buffer.alloc(84 + tris.length * 50);
  buf.write(`stlReverse v2-Haertetest ${name}`.slice(0, 79), 0, 'ascii');
  buf.writeUInt32LE(tris.length, 80);
  let o = 84;
  for (const [a, b, c] of tris) {
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const l = Math.hypot(...n) || 1;
    for (const x of [n[0] / l, n[1] / l, n[2] / l, ...a, ...b, ...c]) { buf.writeFloatLE(x, o); o += 4; }
    buf.writeUInt16LE(0, o); o += 2;
  }
  return buf;
}

// Körper ohne Rundungen (scharfe Kanten) — `which(colIndex, end)` wählt aus, was scharf wird.
// Senkungen bleiben dabei Senkungen: scharf wird nur ihre Kanten-Verrundung (r → 0).
export function sharpen(body, which = () => true) {
  const sharpOf = (spec) => (spec?.kind === 'countersink' ? { ...spec, r: 0, rw: 0 } : { kind: 'sharp' });
  return {
    ...body,
    columns: body.columns.map((col, i) => ({
      ...col,
      bottom: which(i, 'bottom') ? sharpOf(col.bottom) : col.bottom,
      top: which(i, 'top') ? sharpOf(col.top) : col.top,
    })),
  };
}
export const bodyVolume = (body) => meshVolume(buildMesh(body));

// ── Testkörper ──────────────────────────────────────────────────────────────
// expect.mode: 'sharp' = v2 soll schärfen (Soll = Volumen scharf); 'skip' = v2 muss überspringen
// (Soll = Volumen MIT Rundung, also das Netz selbst). Varianten (zulässige Ergebnisse) baut
// check.mjs aus diesen Angaben; Zusatz-Varianten für Bohrungen mit Mündungsrundung (scharfe Bohrung =
// Ziel, Bohrungs-Chamfer-Pfad = zulässig) siehe `boreChamfer`.
const R = (r, N = 8) => ({ kind: 'round', r, N });
const plate = (profile, H, cap, extra = {}) => ({ name: 'aussen', profile, z0: 0, z1: H, bottom: cap, top: cap, ...extra });
// Sackloch-Körper: Platte W×D×H (scharf) mit Löchern entlang Z. Je Loch:
// { x, y, R, seg, z0, z1?, kind: 'flat'|'tip'|'through', tipDeg?, bottom?, top? }
//   z0 > 0 → Sackloch: eigener Boden bei z0 (flache Scheibe oder Kegelspitze mit Apex darunter);
//   z0 = 0 → Durchgangsloch (Loch in beiden Deckflächen, kein eigener Boden).
const blindPlate = (holes, W = 40, D = 30, H = 10, extra = {}) => {
  const columns = [{ name: 'platte', profile: rectProfile(0, 0, W, D), z0: 0, z1: H, bottom: { kind: 'sharp' }, top: { kind: 'sharp' } }];
  const topHoles = [], botHoles = [], caps = [];
  holes.forEach((h, k) => {
    const c = columns.length;
    columns.push({
      name: h.name || 'loch' + (k + 1),
      profile: circleProfile(h.x, h.y, h.R, h.seg, true),
      z0: h.z0, z1: h.z1 ?? H,
      bottom: h.bottom || { kind: 'sharp' }, top: h.top || { kind: 'sharp' },
    });
    topHoles.push({ c, end: 'top' });
    if (h.z0 > 0) {
      const cap = { up: true, outer: { c, end: 'bottom', rev: true } };   // Lochboden: Material liegt darunter
      if (h.kind === 'tip') cap.apexZ = h.z0 - h.R / Math.tan(h.tipDeg / 2 * Math.PI / 180);
      caps.push(cap);
    } else botHoles.push({ c, end: 'bottom' });
  });
  caps.push({ up: true, outer: { c: 0, end: 'top' }, holes: topHoles });
  caps.push({ up: false, outer: { c: 0, end: 'bottom' }, holes: botHoles });
  return { columns, caps, ...extra };
};

// Ösen-Loch (Körper z2): Kreis R2.75 bei (10,10), untere Hälfte D (Sehne y = 8)
const EYELET = eyeletHole(10, 10, 2.75, 48, 8);

// Scharnier-Knöchel (Körper z3): Querschnitt = Blatt (Streifen nach rechts) + Knöchel (270°-Bogen
// R3.5 um (10;10)). Der Bogen läuft CCW von 0° (13,5;10) über 90° und 180° bis 270° (10;6,5) —
// 72 Segmente zu je 3,75°, alle Bogenpunkte EXAKT auf dem Kreis. Das Blatt schließt den Bogen ab:
// (30;6,5) → (30;10) → (13,5;10) → Bogen → (10;6,5) → (30;6,5). CCW (Material links).
//
// Segmente: 72 statt 36. Grund: der Prüfer vergleicht das Volumen des AN-Exports mit der
// Soll-Variante „Loch→Zylinder“ (Toleranz 0.02 + 2·0.001·Mantelfläche = 0.52 mm³). Der Bogen
// WEICHT das Volumen um die Sehnen-Pfeilhöhe ab: 36 Segmente → 1.65 mm³ (zu viel, der Export
// wäre „falsche Geometrie“), 72 Segmente → 0.41 mm³ (passt). Die Profilgeometrie ist dieselbe.
const KNUCKEL = (() => {
  const cx = 10, cy = 10, R = 3.5, seg = 72;          // 270° in 72 Schritten (je 3,75°)
  const pts = [[30, 6.5], [30, 10]];
  for (let k = 0; k <= seg; k++) {
    const a = (k / seg) * 1.5 * PI;                    // 0° … 270°
    pts.push([cx + R * Math.cos(a), cy + R * Math.sin(a)]);
  }
  return pts;
})();

export const BODIES = [
  {
    id: 'a', file: 'v2_a_rechteck_r1.5',
    desc: 'Rechteck 40×30×10, Deck-Verrundung r=1.5 (N=8) oben+unten, scharfe senkrechte Ecken',
    columns: [plate(rectProfile(0, 0, 40, 30), 10, R(1.5))],
    expect: { mode: 'sharp', bands: 2 },
  },
  {
    id: 'b', file: 'v2_b_rechteck_bohrung',
    desc: 'wie (a) + Durchgangsloch Ø8 (32 Seg.) entlang Z, Mündungen beidseitig r=1 verrundet',
    columns: [
      plate(rectProfile(0, 0, 40, 30), 10, R(1.5)),
      { name: 'loch', profile: circleProfile(20, 15, 4, 32, true), z0: 0, z1: 10, bottom: R(1), top: R(1) },
    ],
    expect: { mode: 'sharp', bands: 4 },
    // Mündungs-Verrundungen: v2 schärft sie, danach Lochwand → Zylinder (scharfe Bohrung, Ziel);
    // der Bohrungs-Chamfer-Pfad (Zylinder + 2 Kegel) bleibt zulässig
    boreChamfer: [{ col: 1, R: 4, seg: 32, r: 1, H: 10 }],
  },
  {
    id: 'c', file: 'v2_c_rundrechteck_r1',
    desc: 'abgerundetes Rechteck 40×30 (senkrechte Eckrundungen R5, 8 Seg.) ×10, Deck-Verrundung r=1',
    columns: [plate(roundedRectProfile(40, 30, 5, 8), 10, R(1))],
    expect: { mode: 'sharp', bands: 2 },
  },
  {
    id: 'd', file: 'v2_d_zwei_kanten',
    desc: 'Rechteck 40×30×10, Verrundung r=1.5 nur an 2 von 4 Deck-Kanten (oben: y=0,x=40; unten: y=0,y=30) — offenes Band',
    columns: [plate(rectProfile(0, 0, 40, 30), 10, null, { bottom: { kind: 'round', r: 1.5, N: 8, edges: [0, 2] }, top: { kind: 'round', r: 1.5, N: 8, edges: [0, 1] } })],
    expect: { mode: 'sharp' },
  },
  {
    id: 'e', file: 'v2_e_fase45',
    desc: 'Rechteck 40×30×10, 45°-Fase 1 mm statt Rundung an allen Deck-Kanten (Fasen müssen bleiben)',
    columns: [plate(rectProfile(0, 0, 40, 30), 10, { kind: 'chamfer', r: 1 })],
    expect: { mode: 'skip' },
  },
  {
    id: 'f', file: 'v2_f_formschraege3',
    desc: 'Rechteck 40×30 (Fuß) ×10, Wände 3° geneigt (Formschräge, oben schmaler) + tangentiale Verrundung r=1.5',
    columns: [plate(rectProfile(0, 0, 40, 30), 10, R(1.5), { draftDeg: 3 })],
    expect: { mode: 'skip' },
  },
  {
    id: 'g', file: 'v2_g_tasche',
    desc: 'Platte 40×30×10 (Außenkanten scharf), Tasche 20×10 Tiefe 4 von oben: Rand konvex r=1, Boden konkav r=1',
    columns: [
      { name: 'platte', profile: rectProfile(0, 0, 40, 30), z0: 0, z1: 10, bottom: { kind: 'sharp' }, top: { kind: 'sharp' } },
      { name: 'tasche', profile: rectProfile(10, 10, 20, 10).reverse(), z0: 6, z1: 10, bottom: { kind: 'concave', r: 1, N: 8 }, top: R(1) },
    ],
    caps: [
      { up: true, outer: { c: 0, end: 'top' }, holes: [{ c: 1, end: 'top' }] },
      { up: false, outer: { c: 0, end: 'bottom' }, holes: [] },
      { up: true, outer: { c: 1, end: 'bottom', rev: true }, holes: [] }, // Taschenboden (z=6)
    ],
    expect: { mode: 'sharp', bands: 2 },
    sections: [3, 5.9, 6.13, 6.5, 8, 9.5, 9.87],
  },
  {
    id: 'h', file: 'v2_h_rohr',
    desc: 'dünnwandiges Rohr Ra=10 / Ri=8 (48 Seg.), Höhe 10, Deck-Verrundungen r=0.5 innen+außen',
    columns: [
      plate(circleProfile(0, 0, 10, 48), 10, R(0.5)),
      { name: 'innen', profile: circleProfile(0, 0, 8, 48, true), z0: 0, z1: 10, bottom: R(0.5), top: R(0.5) },
    ],
    expect: { mode: 'sharp', bands: 4 },
    boreChamfer: [{ col: 1, R: 8, seg: 48, r: 0.5, H: 10 }],
  },
  {
    id: 'i3', file: 'v2_i_grob_N3',
    desc: 'wie (a), grobe Rundung: 3 Segmente je Verrundung',
    columns: [plate(rectProfile(0, 0, 40, 30), 10, R(1.5, 3))],
    expect: { mode: 'sharp', bands: 2 },
  },
  {
    id: 'i16', file: 'v2_i_fein_N16',
    desc: 'wie (a), feine Rundung: 16 Segmente je Verrundung',
    columns: [plate(rectProfile(0, 0, 40, 30), 10, R(1.5, 16))],
    expect: { mode: 'sharp', bands: 2 },
  },
  // ── Zusatzkörper (extra: true): gezielte Angriffe auf die v2-Annahmen ──
  {
    id: 'b2', extra: true, file: 'v2_x_bohrung_chamferpfad',
    desc: 'wie (b), Lochwand in 4 Zeilen unterteilt → Bohrung wird erkannt → Chamfer-Pfad (Kegel) + v2 außen',
    columns: [
      plate(rectProfile(0, 0, 40, 30), 10, R(1.5)),
      { name: 'loch', profile: circleProfile(20, 15, 4, 32, true), z0: 0, z1: 10, bottom: R(1), top: R(1), wallSteps: 4 },
    ],
    expect: { mode: 'sharp', bands: 4 },
    boreChamfer: [{ col: 1, R: 4, seg: 32, r: 1, H: 10 }],
  },
  {
    id: 'g2', extra: true, file: 'v2_x_tasche_eckradien',
    desc: 'wie (g), Tasche mit senkrechten Eckradien R3 (6 Seg.) → Torus-Ecken an Rand- und Boden-Rundung',
    columns: [
      { name: 'platte', profile: rectProfile(0, 0, 40, 30), z0: 0, z1: 10, bottom: { kind: 'sharp' }, top: { kind: 'sharp' } },
      { name: 'tasche', profile: roundedRectProfile(20, 10, 3, 6).map(([x, y]) => [x + 10, y + 10]).reverse(), z0: 6, z1: 10, bottom: { kind: 'concave', r: 1, N: 8 }, top: R(1) },
    ],
    caps: [
      { up: true, outer: { c: 0, end: 'top' }, holes: [{ c: 1, end: 'top' }] },
      { up: false, outer: { c: 0, end: 'bottom' }, holes: [] },
      { up: true, outer: { c: 1, end: 'bottom', rev: true }, holes: [] },
    ],
    expect: { mode: 'sharp', bands: 2 },
  },
  {
    id: 'j1', extra: true, file: 'v2_x_zapfen_eckig',
    desc: 'Platte 40×30×5 (scharf) + Zapfen 10×10 bis z=12: Fuß konkav r=1, Kopf konvex r=1.5',
    columns: [
      { name: 'platte', profile: rectProfile(0, 0, 40, 30), z0: 0, z1: 5, bottom: { kind: 'sharp' }, top: { kind: 'sharp' } },
      { name: 'zapfen', profile: rectProfile(15, 10, 10, 10), z0: 5, z1: 12, bottom: { kind: 'concave', r: 1, N: 8 }, top: R(1.5) },
    ],
    caps: [
      { up: false, outer: { c: 0, end: 'bottom' }, holes: [] },
      { up: true, outer: { c: 0, end: 'top' }, holes: [{ c: 1, end: 'bottom', rev: true }] },
      { up: true, outer: { c: 1, end: 'top' }, holes: [] },
    ],
    expect: { mode: 'sharp', bands: 2 },
  },
  {
    id: 'j2', extra: true, file: 'v2_x_zapfen_rund',
    desc: 'wie (j1), runder Zapfen R5 (48 Seg.)',
    columns: [
      { name: 'platte', profile: rectProfile(0, 0, 40, 30), z0: 0, z1: 5, bottom: { kind: 'sharp' }, top: { kind: 'sharp' } },
      { name: 'zapfen', profile: circleProfile(20, 15, 5, 48), z0: 5, z1: 12, bottom: { kind: 'concave', r: 1, N: 8 }, top: R(1.5) },
    ],
    caps: [
      { up: false, outer: { c: 0, end: 'bottom' }, holes: [] },
      { up: true, outer: { c: 0, end: 'top' }, holes: [{ c: 1, end: 'bottom', rev: true }] },
      { up: true, outer: { c: 1, end: 'top' }, holes: [] },
    ],
    expect: { mode: 'sharp', bands: 2 },
  },
  {
    id: 'k', extra: true, file: 'v2_x_l_profil',
    desc: 'L-Profil 40×30, Schenkel 10, Höhe 10, r=1.5 — einspringende senkrechte Ecke',
    columns: [plate(lProfile(40, 30, 10), 10, R(1.5))],
    expect: { mode: 'sharp', bands: 2 },
  },
  {
    id: 'l', extra: true, file: 'v2_x_rippe',
    desc: 'Rippe 40×4×10, r=1.5 — Deckfläche schmal (Band 5× so groß wie die Deckfläche; frühere Schranke 3×)',
    columns: [plate(rectProfile(0, 0, 40, 4), 10, R(1.5))],
    expect: { mode: 'sharp', bands: 2 },
  },
  {
    id: 'm32', extra: true, file: 'v2_x_fein_N32',
    desc: 'wie (a), sehr feine Rundung N=32 (letzte Schicht < 2° → Region-Growing schlägt sie Deckfläche/Wand zu)',
    columns: [plate(rectProfile(0, 0, 40, 30), 10, R(1.5, 32))],
    expect: { mode: 'sharp', bands: 2 },
  },
  {
    id: 'm64', extra: true, file: 'v2_x_fein_N64',
    desc: 'wie (a), N=64',
    columns: [plate(rectProfile(0, 0, 40, 30), 10, R(1.5, 64))],
    expect: { mode: 'sharp', bands: 2 },
  },
  {
    id: 'n1', extra: true, file: 'v2_x_a_gedreht',
    desc: 'wie (a), schräg im Raum gedreht (17°/31°/47°)',
    columns: [plate(rectProfile(0, 0, 40, 30), 10, R(1.5))],
    transform: { rot: [17, 31, 47] },
    expect: { mode: 'sharp', bands: 2 },
  },
  {
    id: 'n2', extra: true, file: 'v2_x_g_gedreht',
    desc: 'wie (g), gedreht (−23°/11°/67°) und verschoben',
    columns: [
      { name: 'platte', profile: rectProfile(0, 0, 40, 30), z0: 0, z1: 10, bottom: { kind: 'sharp' }, top: { kind: 'sharp' } },
      { name: 'tasche', profile: rectProfile(10, 10, 20, 10).reverse(), z0: 6, z1: 10, bottom: { kind: 'concave', r: 1, N: 8 }, top: R(1) },
    ],
    caps: [
      { up: true, outer: { c: 0, end: 'top' }, holes: [{ c: 1, end: 'top' }] },
      { up: false, outer: { c: 0, end: 'bottom' }, holes: [] },
      { up: true, outer: { c: 1, end: 'bottom', rev: true }, holes: [] },
    ],
    transform: { rot: [-23, 11, 67], t: [12.5, -7.25, 3] },
    expect: { mode: 'sharp', bands: 2 },
  },
  {
    id: 'n3', extra: true, file: 'v2_x_c_gedreht',
    desc: 'wie (c), gedreht (40°/−25°/10°)',
    columns: [plate(roundedRectProfile(40, 30, 5, 8), 10, R(1))],
    transform: { rot: [40, -25, 10] },
    expect: { mode: 'sharp', bands: 2 },
  },
  {
    id: 'o', extra: true, file: 'v2_x_a_weit_weg',
    desc: 'wie (a), weit vom Ursprung (x=1000, y=2000, z=500 — float32-Auflösung ~1e-4 mm)',
    columns: [plate(rectProfile(0, 0, 40, 30), 10, R(1.5))],
    transform: { t: [1000, 2000, 500] },
    expect: { mode: 'sharp', bands: 2 },
  },
  {
    id: 'p', extra: true, file: 'v2_x_wand_unterteilt',
    desc: 'wie (a), Wände in Z in 4 Zeilen unterteilt (wie viele CAD-Exporte)',
    columns: [plate(rectProfile(0, 0, 40, 30), 10, R(1.5), { wallSteps: 4 })],
    expect: { mode: 'sharp', bands: 2 },
  },
  {
    id: 'q', extra: true, file: 'v2_x_rund_oben_fase_unten',
    desc: 'Rechteck 40×30×10: oben Rundung r=2, unten 45°-Fase 1 mm (Fase muss bleiben)',
    columns: [plate(rectProfile(0, 0, 40, 30), 10, null, { bottom: { kind: 'chamfer', r: 1 }, top: R(2) })],
    expect: { mode: 'sharp', bands: 1 },
  },
  {
    id: 'r', extra: true, file: 'v2_x_drei_loecher',
    desc: 'Platte 60×40×8, r=1 außen, 3 Löcher Ø6/Ø6/Ø10 (24/24/40 Seg.) mit Mündungs-Rundung r=0.8',
    columns: [
      plate(rectProfile(0, 0, 60, 40), 8, R(1)),
      { name: 'loch1', profile: circleProfile(10, 10, 3, 24, true), z0: 0, z1: 8, bottom: R(0.8), top: R(0.8) },
      { name: 'loch2', profile: circleProfile(10, 30, 3, 24, true), z0: 0, z1: 8, bottom: R(0.8), top: R(0.8) },
      { name: 'loch3', profile: circleProfile(40, 20, 5, 40, true), z0: 0, z1: 8, bottom: R(0.8), top: R(0.8) },
    ],
    expect: { mode: 'sharp', bands: 8 },
    boreChamfer: [
      { col: 1, R: 3, seg: 24, r: 0.8, H: 8 },
      { col: 2, R: 3, seg: 24, r: 0.8, H: 8 },
      { col: 3, R: 5, seg: 40, r: 0.8, H: 8 },
    ],
  },
  {
    id: 's', extra: true, file: 'v2_x_grosser_radius',
    desc: 'Block 60×40×20, Rundung r=5.5 (über der früheren Schranke RMAX 5 mm)',
    columns: [plate(rectProfile(0, 0, 60, 40), 20, R(5.5))],
    expect: { mode: 'sharp', bands: 2 },
  },
  {
    id: 't1', extra: true, file: 'v2_x_duenn_r1',
    desc: 'dünne Platte 40×30×2.5, r=1 (frühere Schranke RMAX = 0.45·2.5 = 1.125)',
    columns: [plate(rectProfile(0, 0, 40, 30), 2.5, R(1))],
    expect: { mode: 'sharp', bands: 2 },
  },
  {
    id: 't2', extra: true, file: 'v2_x_duenn_r1.2',
    desc: 'dünne Platte 40×30×2.5, r=1.2 (über der früheren Schranke RMAX 1.125; Wand 0.1 mm)',
    columns: [plate(rectProfile(0, 0, 40, 30), 2.5, R(1.2))],
    expect: { mode: 'sharp', bands: 2 },
  },
  {
    id: 'w1', extra: true, file: 'v2_x_rippe_rund_wand20',
    desc: 'Rippe 40×8 mit senkrechten Eckradien R3, ×10, r=1.5, Wände in 20 Zeilen (Wand-Loop hat mehr Punkte als die Deckfläche)',
    columns: [plate(roundedRectProfile(40, 8, 3, 8), 10, R(1.5), { wallSteps: 20 })],
    expect: { mode: 'sharp', bands: 2 },
  },
  {
    id: 'w2', extra: true, file: 'v2_x_rundrechteck_R3_wand20',
    desc: 'Platte 40×30 mit Eckradien R3, ×10, r=1, Wände in 20 Zeilen',
    columns: [plate(roundedRectProfile(40, 30, 3, 8), 10, R(1), { wallSteps: 20 })],
    expect: { mode: 'sharp', bands: 2 },
  },
  {
    id: 'w3', extra: true, file: 'v2_x_rippe_R1.6_wand20',
    desc: 'wie (w1), Eckradius R1.6 ≈ Deck-Rundung r=1.5 (Projektionshöhen am Ring fast gleich)',
    columns: [plate(roundedRectProfile(40, 8, 1.6, 8), 10, R(1.5), { wallSteps: 20 })],
    expect: { mode: 'sharp', bands: 2 },
  },
  {
    id: 'u2', extra: true, file: 'v2_x_rohr_R40',
    desc: 'Rohr Ra=40/Ri=38 (96 Seg., Wände 3 Zeilen), Höhe 10, r=0.5 innen+außen — kleine Mündungsrundung an großem Radius',
    columns: [
      plate(circleProfile(0, 0, 40, 96), 10, R(0.5), { wallSteps: 3 }),
      { name: 'innen', profile: circleProfile(0, 0, 38, 96, true), z0: 0, z1: 10, bottom: R(0.5), top: R(0.5), wallSteps: 3 },
    ],
    expect: { mode: 'sharp', bands: 4 },
    boreChamfer: [{ col: 1, R: 38, seg: 96, r: 0.5, H: 10 }],
  },
  {
    id: 'v', extra: true, file: 'v2_x_platte_bohrung_D20_r0.5',
    desc: 'Platte 60×40×8, r=1 außen, Bohrung Ø20 (96 Seg., Wand 3 Zeilen) mit Mündungsrundung r=0.5',
    columns: [
      plate(rectProfile(0, 0, 60, 40), 8, R(1)),
      { name: 'loch', profile: circleProfile(30, 20, 10, 96, true), z0: 0, z1: 8, bottom: R(0.5), top: R(0.5), wallSteps: 3 },
    ],
    expect: { mode: 'sharp', bands: 4 },
    boreChamfer: [{ col: 1, R: 10, seg: 96, r: 0.5, H: 8 }],
  },
  // ── Senkungen: Kegel + Kanten-Rundung dürfen NIE als ein Verrundungsband gelten (Review-Fund:
  // v2 schärfte Senkung samt Rundung weg → glatte Bohrung, wasserdicht, ΔV +55 mm³). Soll: Senkung
  // bleibt (Ziel: nur die Rundung scharf, Kegel bleibt — zulässig: Kegel durch die Rundung).
  {
    id: 'x1', extra: true, file: 'v2_x_senkung',
    desc: 'Platte 40×30×10 (scharf), Bohrung R4 (32 Seg.) mit 90°-Senkung oben (Tiefe 2), Senkungskante r=0.5',
    columns: [
      plate(rectProfile(0, 0, 40, 30), 10, { kind: 'sharp' }),
      { name: 'senkung', profile: circleProfile(20, 15, 4, 32, true), z0: 0, z1: 10, bottom: { kind: 'sharp' }, top: { kind: 'countersink', depth: 2, r: 0.5, N: 8 } },
    ],
    expect: { mode: 'sharp' },
    countersink: [{ col: 1, R: 4, seg: 32, depth: 2, ang: 90, r: 0.5, rw: 0 }],
  },
  {
    id: 'x2', extra: true, file: 'v2_x_senkung_platte_r1',
    desc: 'wie (x1), Platte außen mit Deck-Rundung r=1 (v2 schärft außen, die Senkung muss bleiben)',
    columns: [
      plate(rectProfile(0, 0, 40, 30), 10, R(1)),
      { name: 'senkung', profile: circleProfile(20, 15, 4, 32, true), z0: 0, z1: 10, bottom: { kind: 'sharp' }, top: { kind: 'countersink', depth: 2, r: 0.5, N: 8 } },
    ],
    expect: { mode: 'sharp', bands: 2 },
    countersink: [{ col: 1, R: 4, seg: 32, depth: 2, ang: 90, r: 0.5, rw: 0 }],
  },
  {
    id: 'x3', extra: true, file: 'v2_x_senkung_wandrundung',
    desc: 'Senkung (90°, Tiefe 2) mit Rundung r=0.5 an der Kante Bohrung → Kegel, Senkungskante oben scharf',
    columns: [
      plate(rectProfile(0, 0, 40, 30), 10, { kind: 'sharp' }),
      { name: 'senkung', profile: circleProfile(20, 15, 4, 32, true), z0: 0, z1: 10, bottom: { kind: 'sharp' }, top: { kind: 'countersink', depth: 2, r: 0, rw: 0.5, N: 8 } },
    ],
    expect: { mode: 'sharp' },
    countersink: [{ col: 1, R: 4, seg: 32, depth: 2, ang: 90, r: 0, rw: 0.5 }],
  },
  {
    id: 'x4', extra: true, file: 'v2_x_senkung60',
    desc: 'wie (x1), 60°-Senkung (Kegel 30° zur Achse → Knick 30° zur Bohrungswand, knapp über der Tangential-Grenze 25°)',
    columns: [
      plate(rectProfile(0, 0, 40, 30), 10, { kind: 'sharp' }),
      { name: 'senkung', profile: circleProfile(20, 15, 4, 32, true), z0: 0, z1: 10, bottom: { kind: 'sharp' }, top: { kind: 'countersink', depth: 2, r: 0.5, N: 8, angleDeg: 60 } },
    ],
    expect: { mode: 'sharp' },
    countersink: [{ col: 1, R: 4, seg: 32, depth: 2, ang: 60, r: 0.5, rw: 0 }],
  },
  {
    id: 'x5', extra: true, file: 'v2_x_senkung_beidseitig',
    desc: 'Senkung (90°, Tiefe 2), BEIDE Kanten verrundet (Deck r=0.5, Bohrung rw=0.5) — tangential an Deckfläche und Bohrung, Kegel dazwischen flach',
    columns: [
      plate(rectProfile(0, 0, 40, 30), 10, { kind: 'sharp' }),
      { name: 'senkung', profile: circleProfile(20, 15, 4, 32, true), z0: 0, z1: 10, bottom: { kind: 'sharp' }, top: { kind: 'countersink', depth: 2, r: 0.5, rw: 0.5, N: 8 } },
    ],
    expect: { mode: 'sharp' },
    countersink: [{ col: 1, R: 4, seg: 32, depth: 2, ang: 90, r: 0.5, rw: 0.5 }],
  },
  {
    id: 'x6', extra: true, file: 'v2_x_fase_verrundet',
    desc: 'Rechteck 40×30×10, oben 45°-Fase (Tiefe 1.5) mit verrundeten Kanten r=0.5 (Senkungs-Profil an der Außenkontur) — die Fase muss bleiben',
    columns: [plate(rectProfile(0, 0, 40, 30), 10, null, { bottom: { kind: 'sharp' }, top: { kind: 'countersink', depth: 1.5, r: 0.5, rw: 0.5, N: 8 } })],
    expect: { mode: 'sharp' },
  },
  {
    id: 'x7', extra: true, file: 'v2_x_fase_rundung_oben',
    desc: 'Rechteck 40×30×10, oben 45°-Fase (Tiefe 1.5), nur die Kante Fase → Deckfläche r=0.5 verrundet (Ziel: scharfe Fase)',
    columns: [plate(rectProfile(0, 0, 40, 30), 10, null, { bottom: { kind: 'sharp' }, top: { kind: 'countersink', depth: 1.5, r: 0.5, N: 8 } })],
    expect: { mode: 'sharp', bands: 1 },
  },
  // ── Kegel/Fase ZWISCHEN zwei Rundungen bzw. Rundung nur zur Wand (exporters.js splitMiddleLayer): die
  // Rundungen werden scharf, Kegel/Fase bleibt exakt (bis Deckfläche und Wand verlängert) ──
  {
    id: 'x8', extra: true, file: 'v2_x_senkung60_beidseitig',
    desc: 'wie (x5), 60°-Senkung (Kegel 60° gegen die Deckfläche): Rundung zur Bohrung nur 30° — ihre tangentialen Schichten liegen < 2° neben Kegel und Wand (Region-Growing schlägt sie diesen zu)',
    columns: [
      plate(rectProfile(0, 0, 40, 30), 10, { kind: 'sharp' }),
      { name: 'senkung', profile: circleProfile(20, 15, 4, 32, true), z0: 0, z1: 10, bottom: { kind: 'sharp' }, top: { kind: 'countersink', depth: 2, r: 0.5, rw: 0.5, N: 8, angleDeg: 60 } },
    ],
    expect: { mode: 'sharp' },
    countersink: [{ col: 1, R: 4, seg: 32, depth: 2, ang: 60, r: 0.5, rw: 0.5 }],
  },
  {
    id: 'x9', extra: true, file: 'v2_x_senkung_beidseitig_N16',
    desc: 'wie (x5), feine Rundungen N=16 (2.8°-Schichten: die tangentialen Streifen liegen in Deckfläche, Kegel-Facetten und Bohrungswand)',
    columns: [
      plate(rectProfile(0, 0, 40, 30), 10, { kind: 'sharp' }),
      { name: 'senkung', profile: circleProfile(20, 15, 4, 32, true), z0: 0, z1: 10, bottom: { kind: 'sharp' }, top: { kind: 'countersink', depth: 2, r: 0.5, rw: 0.5, N: 16 } },
    ],
    expect: { mode: 'sharp' },
    countersink: [{ col: 1, R: 4, seg: 32, depth: 2, ang: 90, r: 0.5, rw: 0.5 }],
  },
  {
    id: 'x10', extra: true, file: 'v2_x_fase_verrundet_rundrechteck',
    desc: 'wie (x6) am Rundrechteck 40×30 (senkrechte Eckradien R5, 8 Seg.): Fase und beide Rundungen laufen um die Eckbögen',
    columns: [plate(roundedRectProfile(40, 30, 5, 8), 10, null, { bottom: { kind: 'sharp' }, top: { kind: 'countersink', depth: 1.5, r: 0.5, rw: 0.5, N: 8 } })],
    expect: { mode: 'sharp' },
  },
  {
    id: 'x11', extra: true, file: 'v2_x_fase_wandrundung',
    desc: 'Rechteck 40×30×10, oben 45°-Fase (Tiefe 1.5), nur die Kante Wand → Fase verrundet (rw=0.5), Fasenkante zur Deckfläche scharf',
    columns: [plate(rectProfile(0, 0, 40, 30), 10, null, { bottom: { kind: 'sharp' }, top: { kind: 'countersink', depth: 1.5, r: 0, rw: 0.5, N: 8 } })],
    expect: { mode: 'sharp', bands: 1 },
  },
  {
    id: 'x12', extra: true, file: 'v2_x_fase_verrundet_gedreht',
    desc: 'wie (x6), gedreht (17°/31°/47°) und weit vom Ursprung (x=1000, y=2000, z=500)',
    columns: [plate(rectProfile(0, 0, 40, 30), 10, null, { bottom: { kind: 'sharp' }, top: { kind: 'countersink', depth: 1.5, r: 0.5, rw: 0.5, N: 8 } })],
    transform: { rot: [17, 31, 47], t: [1000, 2000, 500] },
    expect: { mode: 'sharp' },
  },
  {
    id: 'x13', extra: true, file: 'v2_x_ellipsen_rundung',
    desc: 'Rechteck 40×30×10, oben Ellipsen-Rundung (Halbachsen 2 entlang der Deckfläche, 1 entlang der Wand, N=8) — kein Kreisbogen, keine Fase: bleibt; v2 darf NIE eine ihrer Schichten als Fase zwischen zwei Rundungen deuten (r = b nur für die Schnitthöhen in check.mjs)',
    columns: [plate(rectProfile(0, 0, 40, 30), 10, null, { bottom: { kind: 'sharp' }, top: { kind: 'ellipse', a: 2, b: 1, r: 1, N: 8 } })],
    expect: { mode: 'skip' },
  },
  // ── Offene Bänder: nur ein zusammenhängender Teil der Deck-Kontur verrundet (wie d) ──
  {
    id: 'd2', extra: true, file: 'v2_x_drei_kanten',
    desc: 'Rechteck 40×30×10, Verrundung r=1.5 oben an 3 von 4 Kanten (beide Enden an derselben Stirnwand), unten scharf',
    columns: [plate(rectProfile(0, 0, 40, 30), 10, null, { bottom: { kind: 'sharp' }, top: { kind: 'round', r: 1.5, N: 8, edges: [0, 1, 2] } })],
    expect: { mode: 'sharp', bands: 1 },
  },
  {
    id: 'd3', extra: true, file: 'v2_x_offen_eckbogen',
    desc: 'Rechteck 40×30 mit EINER senkrechten Eckrundung R5 (8 Seg., unten rechts) ×10, Verrundung r=1 oben an Unterseite + Eckbogen + rechter Seite',
    // Profil: (0,0) → (35,0) → Bogen um (35,5) bis (40,5) → (40,30) → (0,30); Kanten 0 … 9 verrundet
    columns: [plate([[0, 0], ...Array.from({ length: 9 }, (_, k) => { const a = -PI / 2 + (PI / 2) * k / 8; return [35 + 5 * Math.cos(a), 5 + 5 * Math.sin(a)]; }), [40, 30], [0, 30]], 10, null,
      { bottom: { kind: 'sharp' }, top: { kind: 'round', r: 1, N: 8, edges: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] } })],
    expect: { mode: 'sharp', bands: 1 },
  },
  {
    id: 'd4', extra: true, file: 'v2_x_offen_schraeg',
    desc: 'Trapez (0,0)-(40,0)-(30,30)-(0,30) ×10, Verrundung r=1.5 oben an Unterkante + schräger Kante (stumpfe Gehrung, schräge Stirnwand)',
    columns: [plate([[0, 0], [40, 0], [30, 30], [0, 30]], 10, null, { bottom: { kind: 'sharp' }, top: { kind: 'round', r: 1.5, N: 8, edges: [0, 1] } })],
    expect: { mode: 'sharp', bands: 1 },
  },
  {
    id: 'd5', extra: true, file: 'v2_x_offen_innenecke',
    desc: 'L-Profil 40×30 (Schenkel 10) ×10, Verrundung r=1.5 oben nur an den zwei Kanten der einspringenden Ecke',
    columns: [plate(lProfile(40, 30, 10), 10, null, { bottom: { kind: 'sharp' }, top: { kind: 'round', r: 1.5, N: 8, edges: [2, 3] } })],
    expect: { mode: 'sharp', bands: 1 },
  },
  // ── Offene Bänder mit MEHREREN getrennten verrundeten Abschnitten in einem Loop (je Abschnitt ein Band) ──
  {
    id: 'd6', extra: true, file: 'v2_x_offen_zwei_trapez',
    desc: 'Trapez (0,0)-(40,0)-(30,30)-(0,30) ×10, Verrundung r=1.5 oben an Unter- UND Oberkante (zwei Abschnitte, gemeinsame schräge Stirnwand) — v1 kollabierte die Rundung früher auf der schrägen Stirnwand (ΔV +25 mm³, wasserdicht)',
    columns: [plate([[0, 0], [40, 0], [30, 30], [0, 30]], 10, null, { bottom: { kind: 'sharp' }, top: { kind: 'round', r: 1.5, N: 8, edges: [0, 2] } })],
    expect: { mode: 'sharp' },
  },
  {
    id: 'd7', extra: true, file: 'v2_x_offen_zwei_l',
    desc: 'L-Profil 40×30 (Schenkel 10) ×10, Verrundung r=1.5 oben an zwei getrennten Abschnitten (Unterkante + rechte Kante, Innenkanten der Ecke)',
    columns: [plate(lProfile(40, 30, 10), 10, null, { bottom: { kind: 'sharp' }, top: { kind: 'round', r: 1.5, N: 8, edges: [0, 1, 3, 4] } })],
    expect: { mode: 'sharp' },
  },
  {
    id: 'd8', extra: true, file: 'v2_x_offen_zwei_boegen',
    desc: 'Block 40×30 mit flach gebogener Unter-/Oberkante (Stich 3, 8 Seg.) ×10, Verrundung r=1 oben entlang beider Bögen (zwei Abschnitte, Bogen-Wände), Seiten scharf',
    columns: [plate(bulgeProfile(40, 30, 3, 8), 10, null, { bottom: { kind: 'sharp' }, top: { kind: 'round', r: 1, N: 8, edges: [0, 1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15, 16] } })],
    expect: { mode: 'sharp' },
  },
  {
    id: 'd9', extra: true, file: 'v2_x_offen_vier_achteck',
    desc: 'Achteck (Umkreis R15) ×10, Verrundung r=1 oben an jeder zweiten Kante (vier Abschnitte, Stirnwände unter 45°)',
    columns: [plate(Array.from({ length: 8 }, (_, i) => { const a = (2 * PI * i) / 8 + PI / 8; return [20 + 15 * Math.cos(a), 15 + 15 * Math.sin(a)]; }), 10, null, { bottom: { kind: 'sharp' }, top: { kind: 'round', r: 1, N: 8, edges: [0, 2, 4, 6] } })],
    expect: { mode: 'sharp' },
  },
  {
    id: 'd11', extra: true, file: 'v2_x_offen_einspringend',
    desc: 'L-Profil 40×30 (Schenkel 10) ×10, Verrundung r=1.5 oben ab der EINSPRINGENDEN Ecke (Innenkante senkrecht + obere Kante): die Stirnwand läuft dort über die Ecke hinaus — der geschärfte Rand darf nicht auf derselben Geraden zurücklaufen (Spitze der Breite 0, step-strict loop-fold)',
    columns: [plate(lProfile(40, 30, 10), 10, null, { bottom: { kind: 'sharp' }, top: { kind: 'round', r: 1.5, N: 8, edges: [3, 4] } })],
    expect: { mode: 'sharp', bands: 1 },
  },
  {
    id: 'd12', extra: true, file: 'v2_x_halbkreis_hoch',
    desc: 'Profil Rechteck 20×20 mit Halbkreis R10 oben (15 Seg., Facette genau bei 90°), 40 hoch, OHNE Rundung — von der Seitenwand aus sah der Viertelbogen bis zur 90°-Facette wie eine Rundung aus (Basis 69260ed: eckig, ΔV +1719 mm³ bei dichter Hülle)',
    columns: [plate([[0, 0], [20, 0], ...Array.from({ length: 16 }, (_, k) => { const a = PI * k / 15; return [10 + 10 * Math.cos(a), 20 + 10 * Math.sin(a)]; })], 40, { kind: 'sharp' })],
    expect: { mode: 'skip' },
  },
  {
    id: 'd13', extra: true, file: 'v2_x_offen_duenn',
    desc: 'dünne Platte 40×30×2.6, Verrundung r=1 oben UND unten an zwei Kanten (offene Bänder, Steg 0.6 mm = 0.6·r — knapp über der Seitenwand-Schranke 0.5)',
    columns: [plate(rectProfile(0, 0, 40, 30), 2.6, null, { bottom: { kind: 'round', r: 1, N: 8, edges: [0, 1] }, top: { kind: 'round', r: 1, N: 8, edges: [0, 1] } })],
    expect: { mode: 'sharp' },
  },
  {
    id: 'd10', extra: true, file: 'v2_x_langloch_hoch',
    desc: 'Langloch-Zapfen (Geraden 20, Halbkreise R5 mit 16 Seg.) 40 hoch, OHNE Rundung — eine Halbkreis-Facette hat links und rechts tangentiale Nachbarn (zwei „Abschnitte“), ein Viertelkreis bis zur 90°-Facette sähe aus wie eine Rundung: die Enden müssen rund bleiben',
    columns: [plate(slotProfile(20, 5, 16), 40, { kind: 'sharp' })],
    expect: { mode: 'skip' },
  },
  // ── Bandform (ersetzt die Schranken RMAX/Bandfläche ≤ 3× Deckfläche): Kuppe ≠ Verrundung ──
  {
    id: 'y1', extra: true, file: 'v2_x_kuppe',
    desc: 'Zapfen R5 (48 Seg.) ×12, oben Rundung r=4.5 → Kuppe über Restfläche R0.5 (Kugelkappe, muss bleiben)',
    columns: [plate(circleProfile(0, 0, 5, 48), 12, null, { bottom: { kind: 'sharp' }, top: R(4.5) })],
    expect: { mode: 'skip' },
  },
  {
    id: 'y2', extra: true, file: 'v2_x_zapfen_r2.5',
    desc: 'Zapfen R5 (48 Seg.) ×12, oben Rundung r=2.5 (Deckfläche R2.5 — Band 4× so groß wie die Deckfläche)',
    columns: [plate(circleProfile(0, 0, 5, 48), 12, null, { bottom: { kind: 'sharp' }, top: R(2.5) })],
    expect: { mode: 'sharp', bands: 1 },
  },
  // ── v1 (defeatureFillets) an kurzen Verrundungen dünner Stege (Kabelhalter-Befund) ──
  (() => {
    // Kontur CW (Tasche = Loch in der Platte) → Eck-Indexbereiche umrechnen
    const { pts, corners } = archPocketProfile(10, 8, 12, 8, 2, 12, 0.5, 16);
    const n = pts.length, prof = pts.slice().reverse();
    return {
      id: 'k1', extra: true, file: 'v2_x_kabel_flache_tasche',
      desc: 'Platte 40×30×5, Tasche 0.5 tief (Kontur 12×8, Unterseite flacher Bogen R10 mit 12 Sehnen, alle Ecken senkrecht r=0.5 / 16 Seg.) — die Wände sind 0.5 mm hohe Stege, jede Eckrundung so lang wie der Steg dick. Die Erkennung schlägt der Eck-Rundung angrenzende Wand-Facetten zu; v1 entfernte sie mit und riss die Hülle auf → früher ALLES facettiert (Kabelhalter: 6361 Flächen, 7.6 MB). Ziel: alle vier Ecken scharf (an Seite bzw. erster Bogen-Sehne), Rest unverändert',
      columns: [
        { name: 'platte', profile: rectProfile(0, 0, 40, 30), z0: 0, z1: 5, bottom: { kind: 'sharp' }, top: { kind: 'sharp' } },
        { name: 'tasche', profile: prof, z0: 4.5, z1: 5, bottom: { kind: 'sharp' }, top: { kind: 'sharp' } },
      ],
      caps: [
        { up: true, outer: { c: 0, end: 'top' }, holes: [{ c: 1, end: 'top' }] },
        { up: false, outer: { c: 0, end: 'bottom' }, holes: [] },
        { up: true, outer: { c: 1, end: 'bottom', rev: true }, holes: [] }, // Taschenboden (z=4.5)
      ],
      // v1-Varianten: jede Teilmenge der Ecken scharf (sharpenCorners); Ziel = alle vier
      cornerVariants: { col: 1, corners: corners.map(([a, b]) => [n - 1 - b, n - 1 - a]) },
      expect: { mode: 'sharp', fillets: 4 },
      sections: [2.5, 4.75],
    };
  })(),
  // Kanten-Verrundung, an deren Enden die Fase der Stirnfläche um die Rundung läuft (Kabelhalter:
  // r=1-Kanten der Platte, Stirnseiten 0.5×45° gefast) — v1 schärft die Rundung, die Fase wird zur Gehrung
  (() => {
    const prof = roundedRectProfile(40, 30, 1, 32);
    return {
      id: 'k2', extra: true, file: 'v2_x_kabel_ecken_gefast',
      desc: 'Platte 40×30×16, senkrechte Eckrundungen r=1 (32 Seg.), Stirnseiten oben/unten 0.5×45° gefast (Fase läuft als Kegel um die Rundungen) — Ziel: Ecken scharf, Fasen auf Gehrung, Fasen bleiben',
      columns: [{ name: 'aussen', profile: prof, z0: 0, z1: 16, bottom: { kind: 'chamfer', r: 0.5 }, top: { kind: 'chamfer', r: 0.5 } }],
      cornerVariants: { col: 0, corners: [0, 1, 2, 3].map((k) => [k * 33, k * 33 + 32]) },
      expect: { mode: 'sharp', fillets: 4 },
    };
  })(),
  // ── Profil-Bögen: Bleche mit echten Biege-Bögen, Taschenecken ───────────────
  // Der Exporter wandelt facettierte Bögen extrudierter Profile in echte Teil-Zylinder/-Kegel um
  // (CYLINDRICAL_SURFACE / CONICAL_SURFACE). Die Bögen müssen dabei UNVERÄNDERT bleiben: v2 hat
  // hier nichts zu schärfen (expect.mode 'skip') — nur der Exporter darf sie analytisch machen.
  // arcsOff = erwartete Zahl der Bogen-Flächen im AUS-Export (Zylinder + Kegel).
  {
    id: 'p1', extra: true, file: 'v2_x_bogen_l',
    desc: 'L-Profil als Blech (Schenkel 30×2 und 2×20, Wandstärke 2, Bogen-Innenradius 3, 8 Seg. je Bogen), 15 hoch, Kanten scharf — zwei Biege-Bögen (ein Zylinder innen, einer außen)',
    columns: [plate(sheetLProfile(30, 20, 2, 3, 8), 15, { kind: 'sharp' })],
    bends: { pts: sheetLRaw(30, 20, 2), radii: sheetLRadii(3, 2), t: 2, col: 0 },
    expect: { mode: 'skip', arcsOff: 2 },
  },
  {
    id: 'p2', extra: true, file: 'v2_x_bogen_u',
    desc: 'U-Profil als Blech (30×20, Wandstärke 2, Bogen-Innenradius 4, 8 Seg. je Bogen), 15 hoch, Kanten scharf — vier Biege-Bögen (zwei Biegungen)',
    columns: [plate(sheetUProfile(30, 20, 2, 4, 8), 15, { kind: 'sharp' })],
    bends: { pts: sheetURaw(30, 20, 2), radii: sheetURadii(4, 2), t: 2, col: 0 },
    expect: { mode: 'skip', arcsOff: 4 },
  },
  {
    id: 'p3', extra: true, file: 'v2_x_bogen_s',
    desc: 'Z-Haken als Blech (Flansch 15 unten links, Steg, Flansch 15 oben rechts, Wandstärke 2, Bogen-Innenradius 3, 8 Seg. je Bogen), 17 hoch, Kanten scharf — vier Biege-Bögen (zwei gegenläufige Biegungen)',
    columns: [plate(sheetZProfile(15, 20, 2, 3, 8), 17, { kind: 'sharp' })],
    bends: { pts: sheetZRaw(15, 20, 2), radii: sheetZRadii(3, 2), t: 2, col: 0 },
    expect: { mode: 'skip', arcsOff: 4 },
  },
  {
    id: 'p4', extra: true, file: 'v2_x_bogen_s_fase',
    desc: 'wie (p3), Stirnseiten oben+unten 0.5×45° gefast (Kabelhalter-Fall: die Fase läuft als Kegel um die Biegungen) — je Bogen 1 Zylinder + 2 Kegel',
    columns: [plate(sheetZProfile(15, 20, 2, 3, 8), 17, { kind: 'chamfer', r: 0.5 })],
    bends: { pts: sheetZRaw(15, 20, 2), radii: sheetZRadii(3, 2), t: 2, col: 0 },
    // Die gefasten Stirnseiten verhindern, dass eine Entrundung die Biegung schärft (auch ohne den
    // Schalter nicht) → der AN+B-Lauf darf „Rundung bleibt“ liefern (nur Notiz, kein Soll-Bruch).
    expect: { mode: 'skip', arcsOff: 12, bendsSharpenable: false },
  },
  {
    id: 'p5', extra: true, file: 'v2_x_bogen_taschenecke',
    desc: 'Platte 30×20×5 (scharf), Tasche 12×8 Tiefe 1 von oben, Kontur mit senkrechten Eckrundungen r=0.3 (6 Seg.) — vier Bogen-Flächen an den Taschenecken. KEINE Biegung (kein koaxialer Gegenbogen) → die vier Ecken werden im AN-Lauf wie bisher geschärft',
    columns: [
      { name: 'platte', profile: rectProfile(0, 0, 30, 20), z0: 0, z1: 5, bottom: { kind: 'sharp' }, top: { kind: 'sharp' } },
      { name: 'tasche', profile: roundedRectProfile(12, 8, 0.3, 6).map(([x, y]) => [x + 9, y + 6]).reverse(), z0: 4, z1: 5, bottom: { kind: 'sharp' }, top: { kind: 'sharp' } },
    ],
    caps: [
      { up: true, outer: { c: 0, end: 'top' }, holes: [{ c: 1, end: 'top' }] },
      { up: false, outer: { c: 0, end: 'bottom' }, holes: [] },
      { up: true, outer: { c: 1, end: 'bottom', rev: true }, holes: [] }, // Taschenboden (z=4)
    ],
    // v1-Varianten: jede Teilmenge der vier Eckrundungen scharf (sharpenCorners); Ziel = alle vier.
    // Die Kontur hat 4 Bögen × 7 Punkte (roundedRectProfile(…, 6) → je Bogen 6 Segmente + Startpunkt).
    cornerVariants: { col: 1, corners: [0, 1, 2, 3].map((k) => [k * 7, k * 7 + 6]), kind: 'v2' },
    expect: { mode: 'sharp', arcsOff: 4 },
  },
  {
    id: 'p6', extra: true, file: 'v2_x_bogen_s_fase_gedreht',
    desc: 'wie (p4), schräg im Raum gedreht (20°/35°/10°) und verschoben — die Bögen stehen schräg, die Kegel der Fase ebenso',
    columns: [plate(sheetZProfile(15, 20, 2, 3, 8), 17, { kind: 'chamfer', r: 0.5 })],
    bends: { pts: sheetZRaw(15, 20, 2), radii: sheetZRadii(3, 2), t: 2, col: 0 },
    transform: { rot: [20, 35, 10], t: [50, -20, 7] },
    // wie p4: die Biegung lässt sich wegen der gefasten Stirnseiten nicht schärfen
    expect: { mode: 'skip', arcsOff: 12, bendsSharpenable: false },
  },
  // Fein facettierte Bögen + verrauschte Netzpunkte: der Umkreis-Radius je drei
  // Punkte schwankt stark, der Bogen muss trotzdem als EIN Band erkannt werden
  // (Kabelhalter-Befund).
  // Segmentzahl: 12 je Bogen (7.5°/Segment). MIT 90 Segmenten (1°/Segment) werden
  // die Bögen in der Pipeline NICHT erkannt: das Region-Growing (2°-Schwelle,
  // 0.05 mm Ebenenversatz) verschmilzt den Bogen-Streifen zu einem Vieleck mit
  // 12…42 Punkten — solche Flächen sind keine Band-Facetten (maxFacetPts = 6) —
  // und selbst bei getrennten Flächen wäre die Koaxial-Prüfung (zwei Ebenen-Mitten)
  // der eigentliche Blockierer (0.3 mm bei 4 Punkten, Toleranz 6e-3 mm).
  // Rausch-Amplitude ±3e-5 mm: das Rauschen muss UNTER der Ebenen-Toleranz des
  // Exporters bleiben (PLANAR_TOL = 5e-5 mm, exporters.js) — sonst zerlegt der
  // Exporter die Deckflächen in Dreiecke, und die Bogen-Kanten der Deckfläche
  // gehören dann zu verschiedenen Flächen: das Band kann nicht mehr bestätigt
  // werden (validateArcBands) und bleibt facettiert. Die Erkennung selbst
  // (Pfeilhöhen-Prüfung) verkraftet bis ~2e-4 mm Rauschen (noiseTol 5e-4).
  {
    id: 'p7', extra: true, file: 'v2_x_bogen_s_fase_fein_rauschen',
    desc: 'wie (p4), aber 12 Segmente je Bogen UND deterministisches Rauschen ±3e-5 mm auf jedem Netzpunkt (gleicher Punkt → gleiches Rauschen) — die vier Biegungen müssen trotzdem als Bänder erkannt werden (12 Bogen-Flächen wie p4)',
    columns: [plate(sheetZProfile(15, 20, 2, 3, 12), 17, { kind: 'chamfer', r: 0.5 })],
    bends: { pts: sheetZRaw(15, 20, 2), radii: sheetZRadii(3, 2), t: 2 },
    jitter: 3e-5,
    // wie p4/p6: die gefasten Stirnseiten verhindern, dass eine Entrundung die Biegung schärft
    // (auch mit dem Schalter nicht) → der AN+B-Lauf darf „Rundung bleibt“ liefern.
    expect: { mode: 'skip', arcsOff: 12, bendsSharpenable: false },
  },
  // Durchgangsloch mit 45°-Fase an BEIDEN Enden: die drei Ringe (Zylinder + 2 Kegel)
  // sind geschlossene Ketten (Vollkreise) → je Ring drei Bänder (Schnitt bei 0°, 120°,
  // 240°) → 3 Zylinder + 6 Kegel. 90 Segmente (4°/Segment): ab 2°/Segment verschmilzt
  // das Region-Growing die Streifen zu Flächen mit >6 Punkten (keine Band-Facetten).
  {
    id: 'p8', extra: true, file: 'v2_x_platte_loch_fase_beidseitig',
    desc: 'Platte 40×30×3 (scharf), Durchgangsloch R4.25 (90 Seg.), oben und unten 0.5×45° gefast — der Ring wird in Bänder umgewandelt (je Ring drei: 3 Zylinder + 6 Kegel)',
    columns: [
      plate(rectProfile(0, 0, 40, 30), 3, { kind: 'sharp' }),
      { name: 'loch', profile: circleProfile(20, 15, 4.25, 90, true), z0: 0, z1: 3, bottom: { kind: 'chamfer', r: 0.5 }, top: { kind: 'chamfer', r: 0.5 } },
    ],
    expect: { mode: 'skip', arcsOff: 9 },
    boreChamfer: [{ col: 1, R: 4.25, seg: 90, r: 0.5, H: 3 }],
  },
  // Bohrung + Gravur auf derselben Deckfläche (Kabelhalter-Befund): die Durchgangsbohrung wird zum
  // Zylinder mit analytischem Kreis-Rand (circleRim) → ihr Rand-Loop gehört zur Deckfläche. Die
  // Gravur (Langloch-Tasche 0.5 tief) hat zwei Halbkreis-Wände, die Teil-Zylinder werden sollen —
  // der Kreis-Rand-Loop darf sie nicht verwerfen (und beim Anwenden nicht verloren gehen).
  {
    id: 'p9', extra: true, file: 'v2_x_platte_bohrung_langloch_tasche',
    desc: 'Platte 40×30×3 (Kanten scharf), Durchgangsbohrung R2 (48 Seg., ohne Fase/Senkung) bei (10,15) und auf der Oberseite eine Langloch-Tasche 0.5 tief bei (27,15) (zwei Geraden 8, zwei Halbkreise R2.5 mit je 24 Seg.) — die Bohrung macht den Rand-Loop der Deckfläche zum analytischen Kreis; die zwei Halbkreis-Wände müssen trotzdem Teil-Zylinder werden (Bögen 2, dazu die Bohrung als Zylinder)',
    columns: [
      { name: 'platte', profile: rectProfile(0, 0, 40, 30), z0: 0, z1: 3, bottom: { kind: 'sharp' }, top: { kind: 'sharp' } },
      { name: 'bohrung', profile: circleProfile(10, 15, 2, 48, true), z0: 0, z1: 3, bottom: { kind: 'sharp' }, top: { kind: 'sharp' } },
      { name: 'tasche', profile: slotProfile(8, 2.5, 24).map(([x, y]) => [x + 20.5, y + 12.5]).reverse(), z0: 2.5, z1: 3, bottom: { kind: 'sharp' }, top: { kind: 'sharp' } },
    ],
    caps: [
      { up: true, outer: { c: 0, end: 'top' }, holes: [{ c: 1, end: 'top' }, { c: 2, end: 'top' }] },
      { up: false, outer: { c: 0, end: 'bottom' }, holes: [{ c: 1, end: 'bottom' }] },
      { up: true, outer: { c: 2, end: 'bottom', rev: true }, holes: [] },   // Taschenboden (z=2.5)
    ],
    expect: { mode: 'skip', arcsOff: 2, arcsOn: 2, bores: 1 },
    // Bohrung ohne Fase/Senkung: der scharfe Zylinder ist die Ziel-Variante (boreSharpVariant)
    boreChamfer: [{ col: 1, R: 2, seg: 48, r: 0, H: 3 }],
  },
  // Gravur mit KLEINEN Eckrundungen (Kabelhalter-Befund): Tasche 0.5 tief in einer 3 mm dicken Platte,
  // Kontur 12×6 mit senkrechten Eckrundungen r=0.3 (24 Seg. je Ecke) + Rauschen ±3e-5 mm auf jedem
  // Netzpunkt (nur x/y: `jitterXY` — die Höhen bleiben exakt, damit die Deckfläche EINE ebene
  // Fläche bleibt. Mit Höhen-Rauschen zerlegt der Exporter die Deckfläche in Dreiecke, die
  // Bogen-Kanten der Deckfläche gehören dann zu verschiedenen Flächen und die Bänder fallen
  // schon in validateArcBands weg — der Fehler läge dann VOR der Bogen-Geometrie).
  // Die vier Eckbögen sind echte Taschenecken (KEINE Biegung) → v2 darf sie im AN-Lauf schärfen;
  // im AUS-Export müssen sie als VIER Teil-Zylinder dastehen (arcsOff 4).
  {
    id: 'p10', extra: true, file: 'v2_x_platte_gravur_kleine_ecken',
    desc: 'Platte 40×30×3 (Kanten scharf), oben eine Tasche 12×6 Tiefe 0.5 mit senkrechten Eckrundungen r=0.3 (24 Seg. je Ecke), Rauschen ±3e-5 mm in x/y auf den Netzpunkten — die vier Eckbögen müssen als Teil-Zylinder exportiert werden (4 Bogen-Flächen)',
    columns: [
      { name: 'platte', profile: rectProfile(0, 0, 40, 30), z0: 0, z1: 3, bottom: { kind: 'sharp' }, top: { kind: 'sharp' } },
      { name: 'tasche', profile: roundedRectProfile(12, 6, 0.3, 24).map(([x, y]) => [x + 14, y + 12]).reverse(), z0: 2.5, z1: 3, bottom: { kind: 'sharp' }, top: { kind: 'sharp' } },
    ],
    caps: [
      { up: true, outer: { c: 0, end: 'top' }, holes: [{ c: 1, end: 'top' }] },
      { up: false, outer: { c: 0, end: 'bottom' }, holes: [] },
      { up: true, outer: { c: 1, end: 'bottom', rev: true }, holes: [] },   // Taschenboden (z=2.5)
    ],
    jitterXY: 3e-5,
    // v1-Varianten: jede Teilmenge der vier Eckrundungen scharf (sharpenCorners); Ziel = alle vier.
    // Die Kontur hat 4 Bögen × 25 Punkte (roundedRectProfile(…, 24) → je Bogen 24 Segmente + Startpunkt).
    cornerVariants: { col: 1, corners: [0, 1, 2, 3].map((k) => [k * 25, k * 25 + 24]), kind: 'v2' },
    expect: { mode: 'sharp', arcsOff: 4 },
  },
  // Senkung + Fase an BEIDEN Enden der Bohrung (Kabelhalter-Befund: die Mündungs-Kegel wurden über
  // Kreuz dem falschen Rand zugeordnet → Orientierungsfehler, alles facettiert)
  {
    id: 'k3', extra: true, file: 'v2_x_kabel_senkung_fase',
    desc: 'Platte 40×30×3 (scharf), Bohrung R2.25 (48 Seg.) entlang Z, unten 90°-Senkung Tiefe 1, oben 45°-Fase 0.5 (Kabelhalter-Befund: Mündungs-Kegel wurden über Kreuz dem falschen Rand zugeordnet → Orientierungsfehler, alles facettiert). Ziel: Zylinder + 2 Kegel, scharf',
    columns: [
      plate(rectProfile(0, 0, 40, 30), 3, { kind: 'sharp' }),
      { name: 'senkung', profile: circleProfile(20, 15, 2.25, 48, true), z0: 0, z1: 3, bottom: { kind: 'countersink', depth: 1, r: 0, N: 8 }, top: { kind: 'countersink', depth: 0.5, r: 0, N: 8 } },
    ],
    // Im AUS-Export (Defeaturing aus) wird die Bohrung NICHT umgewandelt (der Kegel-Pfad für Fase/
    // Senkung ist abgeschaltet) → die Bohrung bleibt facettiert und wird vom Bogen-Pfad als drei
    // Bänder übernommen: 3 Zylinder (Wand) + 6 Kegel (Senkung + Fase) = 9 Bogen-Flächen.
    expect: { mode: 'sharp', bores: 1, arcsOff: 9 },
    countersinkBoth: [{ col: 1, R: 2.25, seg: 48, bottom: { depth: 1, ang: 90 }, top: { depth: 0.5, ang: 90 } }],
  },
  {
    id: 'k4', extra: true, file: 'v2_x_kabel_senkung_fase_oben',
    desc: 'wie (k3) gespiegelt: Senkung Tiefe 1 oben, Fase 0.5 unten',
    columns: [
      plate(rectProfile(0, 0, 40, 30), 3, { kind: 'sharp' }),
      { name: 'senkung', profile: circleProfile(20, 15, 2.25, 48, true), z0: 0, z1: 3, bottom: { kind: 'countersink', depth: 0.5, r: 0, N: 8 }, top: { kind: 'countersink', depth: 1, r: 0, N: 8 } },
    ],
    expect: { mode: 'sharp', bores: 1 },
    countersinkBoth: [{ col: 1, R: 2.25, seg: 48, bottom: { depth: 0.5, ang: 90 }, top: { depth: 1, ang: 90 } }],
  },
  // ── Sacklöcher (blind holes): die Bohrung endet im Material — der Export muss daraus einen
  //    Zylinder + flache Ebene (Lochboden) bzw. + Kegel (Bohrspitze) machen ──
  {
    id: 's1', extra: true, file: 'v2_x_sackloch_flach',
    desc: 'Platte 40×30×10 (scharf) + Sackloch R4 (32 Seg.) von oben, Tiefe 6 (Lochboden z=4), flach',
    ...blindPlate([{ x: 20, y: 15, R: 4, seg: 32, z0: 4, kind: 'flat' }]),
    expect: { mode: 'sharp', bores: 1 },
    holes: [{ col: 1, R: 4, seg: 32, kind: 'flat' }],
  },
  {
    id: 's2', extra: true, file: 'v2_x_sackloch_spitze',
    desc: 'wie (s1), aber mit 118°-Bohrspitze (Kegel mit Apex unter dem Zylinder)',
    ...blindPlate([{ x: 20, y: 15, R: 4, seg: 32, z0: 4, kind: 'tip', tipDeg: 118 }]),
    expect: { mode: 'sharp', bores: 1 },
    holes: [{ col: 1, R: 4, seg: 32, kind: 'tip', tipDeg: 118 }],
  },
  {
    id: 's3', extra: true, file: 'v2_x_sackloch_spitze120_N16',
    desc: 'wie (s2), 120°-Spitze, R3 (16 Seg.)',
    ...blindPlate([{ x: 20, y: 15, R: 3, seg: 16, z0: 5, kind: 'tip', tipDeg: 120 }]),
    expect: { mode: 'sharp', bores: 1 },
    holes: [{ col: 1, R: 3, seg: 16, kind: 'tip', tipDeg: 120 }],
  },
  {
    id: 's4', extra: true, file: 'v2_x_sackloch_rund',
    desc: 'wie (s1), aber mit konkav verrundetem Lochboden (r=1, N=8) — v2 soll die Rundung schärfen',
    ...blindPlate([{ x: 20, y: 15, R: 4, seg: 32, z0: 4, kind: 'flat', bottom: { kind: 'concave', r: 1, N: 8 } }]),
    expect: { mode: 'sharp', bands: 1 },
    holes: [{ col: 1, R: 4, seg: 32, kind: 'flat' }],
  },
  {
    id: 's5', extra: true, file: 'v2_x_sackloch_flach_gedreht',
    desc: 'wie (s1), gedreht (17°/31°/47°) und verschoben',
    ...blindPlate([{ x: 20, y: 15, R: 4, seg: 32, z0: 4, kind: 'flat' }]),
    transform: { rot: [17, 31, 47], t: [5, -3, 2] },
    expect: { mode: 'sharp', bores: 1 },
    holes: [{ col: 1, R: 4, seg: 32, kind: 'flat' }],
  },
  {
    id: 's6', extra: true, file: 'v2_x_sackloch_spitze_gedreht',
    desc: 'wie (s2), gedreht (−23°/11°/67°) und verschoben',
    ...blindPlate([{ x: 20, y: 15, R: 4, seg: 32, z0: 4, kind: 'tip', tipDeg: 118 }]),
    transform: { rot: [-23, 11, 67], t: [12.5, -7.25, 3] },
    expect: { mode: 'sharp', bores: 1 },
    holes: [{ col: 1, R: 4, seg: 32, kind: 'tip', tipDeg: 118 }],
  },
  {
    id: 's7', extra: true, file: 'v2_x_sackloch_mix',
    desc: 'Platte 60×30×10 (scharf) + Sackloch flach (R4, z0=4) + Sackloch mit 118°-Spitze (R3, z0=5) + Durchgangsloch (R2.5)',
    ...blindPlate([
      { x: 12, y: 15, R: 4, seg: 32, z0: 4, kind: 'flat' },
      { x: 30, y: 15, R: 3, seg: 32, z0: 5, kind: 'tip', tipDeg: 118 },
      { x: 48, y: 15, R: 2.5, seg: 32, z0: 0, kind: 'through' },
    ], 60, 30, 10),
    expect: { mode: 'sharp', bores: 3 },
    holes: [
      { col: 1, R: 4, seg: 32, kind: 'flat' },
      { col: 2, R: 3, seg: 32, kind: 'tip', tipDeg: 118 },
      { col: 3, R: 2.5, seg: 32, kind: 'through' },
    ],
  },
  // ── Öse: Durchgangsloch, dessen untere Hälfte ein D ist ─────────────────────
  // Block 20×20×10 (scharf), senkrechtes Loch R2.75 (48 Seg.) bei (10,10): die untere Hälfte
  // (z 0…5) ist ein D (Kreis, unten durch die Sehne y = 8 abgeschnitten — die Sehnen-Endpunkte
  // liegen exakt auf dem Kreis), die obere Hälfte (z 5…10) der volle Kreis. Zwischen beiden liegt
  // der schmale Steg (Sehne ↔ Bogen) bei z = 5.
  // Der Bohrungs-Pfad (attemptBore → rimsFromLoops) verlangt ZWEI saubere Rand-Kreise — hier sind
  // es drei Randkonturen (unten D, Steg, oben Kreis) → der Bohrungs-Pfad scheitert an den Rändern
  // (nicht an der Wand) → der Profil-Bogen-Pfad muss die Wand als Teil-Zylinder übernehmen.
  {
    id: 'z2', extra: true, file: 'v2_x_oese_d_loch',
    desc: 'Block 20×20×10 (Kanten scharf) mit senkrechtem Loch R2.75 (48 Seg.) bei (10,10): untere Hälfte (z 0…5) D-Form (Kreis, unten durch die Sehne y = 8 abgeschnitten), obere Hälfte (z 5…10) voller Kreis, Steg bei z = 5',
    columns: [
      { name: 'block', profile: rectProfile(0, 0, 20, 20), z0: 0, z1: 10, bottom: { kind: 'sharp' }, top: { kind: 'sharp' } },
      { name: 'loch_unten', profile: EYELET.d.slice().reverse(), z0: 0, z1: 5, bottom: { kind: 'sharp' }, top: { kind: 'sharp' } },
      { name: 'loch_oben', profile: EYELET.ring.slice().reverse(), z0: 5, z1: 10, bottom: { kind: 'sharp' }, top: { kind: 'sharp' } },
    ],
    caps: [
      { up: true, outer: { c: 0, end: 'top' }, holes: [{ c: 2, end: 'top' }] },
      { up: false, outer: { c: 0, end: 'bottom' }, holes: [{ c: 1, end: 'bottom' }] },
      // Steg bei z = 5 (zwischen Sehne und Bogen): Material darunter, Loch darüber → Normale nach +Z
      { up: true, outer: { pts: EYELET.ledge.map(([x, y]) => [x, y, 5]) }, holes: [] },
    ],
    // Der Bohrungs-Pfad scheitert an den Rändern (keine zwei sauberen Rand-Kreise) → der Profil-Bogen-
    // Pfad übernimmt die Wand: 1 Bogen-Fläche (Teil-Zylinder) — im AUS- wie im AN-Lauf (die
    // Bohrungs-Sperre des Bogen-Pfads darf eine an den Rändern gescheiterte Bohrung nicht blockieren).
    expect: { mode: 'skip', arcsOff: 1, arcsOn: 1 },
  },
  // ── Öse mit VERDREHTER oberer Lochhälfte (Werkstück-Befund) ────────────────
  // Wie (z2), aber die obere Lochhälfte (z 5…10) ist um 2° um die Lochachse (10,10) verdreht
  // (topRot). Die Wand-Dreiecke (lo[i], lo[j], hi[j]) / (lo[i], hi[j], hi[i]) bleiben, werden aber
  // zu einem ZICKZACK aus nicht-koplanaren Dreiecken: keine Seitenkante ist eine senkrechte
  // Mantellinie → der Profil-Bogen-Pfad kann aus dieser Wand kein Band bilden. 2° sind weniger als
  // ein Segment (7.5° je Segment bei 48 Segmenten) → die Wand kollabiert nicht, das Netz bleibt
  // geschlossen.
  {
    id: 'z4', extra: true, file: 'v2_x_oese_verdreht',
    desc: 'Block 20×20×10 (Kanten scharf) mit senkrechtem Loch R2.75 (48 Seg.) bei (10,10): untere Hälfte (z 0…5) D-Form (Kreis, unten durch die Sehne y = 8 abgeschnitten), obere Hälfte (z 5…10) voller Kreis, Steg bei z = 5 — obere Lochhälfte um 2° verdreht (Wand = Zickzack-Dreiecke, keine Mantellinie)',
    columns: [
      { name: 'block', profile: rectProfile(0, 0, 20, 20), z0: 0, z1: 10, bottom: { kind: 'sharp' }, top: { kind: 'sharp' } },
      { name: 'loch_unten', profile: EYELET.d.slice().reverse(), z0: 0, z1: 5, bottom: { kind: 'sharp' }, top: { kind: 'sharp' } },
      { name: 'loch_oben', profile: EYELET.ring.slice().reverse(), z0: 5, z1: 10, bottom: { kind: 'sharp' }, top: { kind: 'sharp' }, topRot: { deg: 2.0, c: [10, 10] } },
    ],
    caps: [
      { up: true, outer: { c: 0, end: 'top' }, holes: [{ c: 2, end: 'top' }] },
      { up: false, outer: { c: 0, end: 'bottom' }, holes: [{ c: 1, end: 'bottom' }] },
      // Steg bei z = 5 (zwischen Sehne und Bogen): Material darunter, Loch darüber → Normale nach +Z
      { up: true, outer: { pts: EYELET.ledge.map(([x, y]) => [x, y, 5]) }, holes: [] },
    ],
    // Vorher blieb die verdrehte Wand facettiert (0 Bogen-Flächen, 146 Flächen). insertRulings
    // (profile-arcs.js) setzt Punkte auf den Kreis und trianguliert die Wand neu → Mantellinien an
    // den Schnittstellen (Steg-Ecken, Lücken ≤ 130°, Sehnen-Mitte) → 10 Teil-Zylinder, 18 Flächen.
    expect: { mode: 'skip', arcsOff: 10, arcsOn: 10, maxFaces: 20 },
  },
  // ── PINCH: zwei Löcher EINER Deckfläche berühren sich in genau EINER Ecke ────
  // Die Deckfläche z=3 der Platte hat zwei Löcher, die sich im Punkt (12; 18.5) berühren: der
  // Fußabdruck des halbringenförmigen Zapfens (Außenbogen R3.5, Innenbogen R2.5 um (12;15),
  // Winkel 90°…270°, 24 Seg. je Bogen) und das Rechteck-Taschenloch [12;18.5]–[14;20.5] (Tiefe 1,
  // z 2…3). Ränder, die sich in einer Ecke berühren, kann occt nicht triangulieren → der Exporter
  // darf dort KEINE Fläche mit berührenden Rändern emittieren (sonst fehlt die Deckfläche im STEP).
  // Vorher wurde die ganze Deckfläche als Einzel-Dreiecke ausgegeben (Hunderte Flächen) — jetzt
  // werden nur die Dreiecke um den Berührpunkt abgetrennt, der Rest bleibt EINE Fläche; dadurch
  // bleiben auch die Bogen-Bänder des Zapfens bestätigt (Teil-Zylinder statt Facetten).
  {
    id: 'z1', extra: true, file: 'v2_x_boden_pinch',
    desc: 'Platte 40×30×3 (Kanten scharf), oben ein halbringenförmiger Zapfen (Außenbogen R3.5, Innenbogen R2.5 um (12;15), Winkel 90°…270°, 24 Seg. je Bogen, Höhe 3) und eine Rechteck-Tasche 2×2 (Tiefe 1) bei [12;18.5]–[14;20.5] — beide Löcher berühren sich im Punkt (12;18.5;3): die Deckfläche darf nur getrennt an dieser Ecke ausgegeben werden (keine Fläche mit berührenden Rändern — occt trianguliert sie nicht)',
    columns: [
      { name: 'platte', profile: rectProfile(0, 0, 40, 30), z0: 0, z1: 3, bottom: { kind: 'sharp' }, top: { kind: 'sharp' } },
      { name: 'zapfen', profile: halfRingProfile(12, 15, 3.5, 2.5, 90, 270, 24), z0: 3, z1: 6, bottom: { kind: 'sharp' }, top: { kind: 'sharp' } },
      { name: 'tasche', profile: rectProfile(12, 18.5, 2, 2).reverse(), z0: 2, z1: 3, bottom: { kind: 'sharp' }, top: { kind: 'sharp' } },
    ],
    caps: [
      // Das Loch des Zapfens muss wie ein Loch gewickelt sein (CW) — sein Profil ist CCW
      { up: true, outer: { c: 0, end: 'top' }, holes: [{ c: 1, end: 'bottom', rev: true }, { c: 2, end: 'top' }] },
      { up: false, outer: { c: 0, end: 'bottom' }, holes: [] },
      { up: true, outer: { c: 1, end: 'top' }, holes: [] },                            // Zapfen-Deckfläche (z=6)
      { up: true, outer: { c: 2, end: 'bottom', rev: true }, holes: [] },              // Taschenboden (z=2)
    ],
    expect: { mode: 'skip', arcsOff: 2, arcsOn: 2, maxFaces: 20 },
  },
  // ── SCHARNIER-KNÖCHEL: Teil-Zylinder (270°-Bogen) um ein koaxiales Durchgangsloch ────
  // Prisma (Z 0…20, Kanten scharf): Querschnitt = Scharnierblatt (Streifen nach rechts) +
  // Knöchel (270°-Bogen R3.5 um (10;10), 72 Segmente zu 3,75° — alle Bogenpunkte exakt auf dem
  // Kreis), Durchgangsloch R2 (32 Seg.) um DIESELBE Achse (10;10) → koaxial.
  // Der Bohrungs-Pfad macht aus dem Loch eine Bohrung (Zylinder) und setzt `circleRim` auf die
  // Loch-Loops der beiden Deckflächen (z = 0 und z = 20). Genau diese beiden Deckflächen sind die
  // Flächen ⟂ zur Knöchel-Achse: `axisCandidates` (profile-arcs.js) hat sie früher wegen des
  // circleRim-Loops ÜBERSPRUNGEN (jede Fläche mit circleRim-Loop) — damit gab es gar keine
  // Achsen-Kandidaten und der Knöchel blieb facettiert. Jetzt zählen nur die Punkte der Loops OHNE
  // circleRim → die Deckfläche (74 Randpunkte im Außen-Loop) liefert die Achse, und der
  // 270°-Knöchel wird zum Teil-Zylinder. Die Bogen-Validierung prüft nur den Loop, IN DEM der
  // Bogen liegt (hier der Außen-Loop) — der circleRim-Loop der Bohrung stört sie nicht.
  {
    id: 'z3', extra: true, file: 'v2_x_scharnier_knoechel',
    desc: 'Prisma Z 0…20 (Kanten scharf), Querschnitt = Scharnierblatt (30;6,5)…(30;10) + Knöchel (270°-Bogen R3.5 um (10;10), 72 Seg. zu 3,75°) + koaxiales Durchgangsloch R2 (32 Seg.) um (10;10)',
    columns: [
      { name: 'koerper', profile: KNUCKEL, z0: 0, z1: 20, bottom: { kind: 'sharp' }, top: { kind: 'sharp' } },
      { name: 'loch', profile: circleProfile(10, 10, 2, 32, true), z0: 0, z1: 20, bottom: { kind: 'sharp' }, top: { kind: 'sharp' } },
    ],
    caps: [
      { up: true, outer: { c: 0, end: 'top' }, holes: [{ c: 1, end: 'top' }] },
      { up: false, outer: { c: 0, end: 'bottom' }, holes: [{ c: 1, end: 'bottom' }] },
    ],
    // `holes`: nur die Prüf-Seite (check.mjs) — das Durchgangsloch als „Sackloch-Liste“ (wie s7):
    // daraus baut der Prüfer die Soll-Variante „Loch→Zylinder R2“ (die Bohrung ist eine analytische
    // Fläche, die planare Variante „Rundung bleibt“ kann sie nicht abdecken). `expect.bores: 1`
    // hält fest: das Loch MUSS über den Bohrungs-Pfad laufen (er setzt `circleRim` auf die
    // Loch-Loops der beiden Deckflächen — genau das blockierte vorher die Achse).
    holes: [{ col: 1, R: 2, seg: 32, kind: 'through' }],
    expect: { mode: 'skip', arcsOff: 1, arcsOn: 1, maxFaces: 9, bores: 1 },
  },
  // ── HAKEN-SPITZE: tangentiale Eckrundung (R1) + 45°-Fase 0,5 mm an Ober- UND Unterkante ──
  // Prisma Z 0…16, Querschnitt = Rechteck 20×6, dessen Ecke (20;6) TANGENT verrundet ist: der
  // Bogen R1 hat den Mittelpunkt (19;5) und liegt damit tangential an der rechten Kante (x = 20)
  // und an der Oberkante (y = 6) — die Kanten knicken dort NICHT, sie laufen stetig in den Bogen
  // über. Die anderen drei Ecken bleiben scharf. Der Bogen ist in 1°-Schritten abgetastet (90
  // Segmente, Sehnenlänge 2·1·sin(0,5°) = 0,01745 mm) — das liegt UNTER der Mindest-Detailgröße
  // von mesh-clean.js (τ = 0,02 mm). An Ober- UND Unterkante sitzt ringsum eine 45°-Fase 0,5 mm
  // ({kind:'chamfer', r:0.5}) → die Verrundung trägt oben und unten je ein Kegel-Band.
  //
  // Warum dieser Körper (Werkstück-Befund „Haken-Spitze“): BEVOR der Spalten-Kollaps in
  // mesh-clean.js griff, dezimierte cleanMesh die oberen und unteren Ringe UNABHÄNGIG voneinander
  // → an den TANGENTENPUNKTEN des Bogens (dort, wo Wand und Fase ohne Knick ineinanderlaufen)
  // entstanden Fächer-Dreiecke statt Vierecke → Splitter-Flächen (Sliver). Die Wände selbst sind
  // Viereck-Streifen (der Generator baut sie so); der Kollaps in mesh-clean.js räumt die Spalten
  // jetzt Spalten-für-Spalte ab. Der Körper hält beide Fälle fest: das Netz ist geschlossen und
  // manifold, und die Fase-Bänder müssen im Export als Fläche erhalten bleiben (Bögen AN/AUS).
  //
  // Messung: AUS ohne Spalten-Kollaps 27 Flächen (Splitter am Tangentenpunkt), mit Spalten-Kollaps
  // 20 (= ungereinigtes Netz) mit 3 Bogen-Flächen (1 Zylinder + 2 Kegel) → maxFaces 20, arcsOff 3.
  // AN: die Profil-Rundung wird geschärft (fillets=1, 14 Flächen); diese Schärfung MIT Fasen bildet
  // variantsFor (check.mjs) nicht ab → `anFree` (AN-Geometrie frei, Pflichten wie wasserdicht gelten).
  {
    id: 'z5', extra: true, file: 'v2_x_haken_fase_fein',
    desc: 'Prisma Z 0…16, Rechteck 20×6 mit TANGENTER Eckrundung R1 an (20;6) (Mittelpunkt (19;5), 90 Segmente zu 1° = Sehne 0,01745 mm — unter der Mindest-Detailgröße 0,02 mm von mesh-clean.js), die drei anderen Ecken scharf; 45°-Fase 0,5 mm an Ober- UND Unterkante ringsum',
    columns: [
      { name: 'haken', profile: tangentFilletRectProfile(0, 0, 20, 6, 1, 'tr', 1), z0: 0, z1: 16, bottom: { kind: 'chamfer', r: 0.5 }, top: { kind: 'chamfer', r: 0.5 } },
    ],
    expect: { mode: 'skip', anFree: true, arcsOff: 3, maxFaces: 20 },
  },
];

// Stresskörper (Laufzeit, ~49k Dreiecke < 50k-Vereinfachungsgrenze); nicht als STL-Datei
export const STRESS = [
  {
    id: 'u', extra: true, stress: true, file: 'v2_x_stress_rohr',
    desc: 'Rohr Ra=50/Ri=46, 360 Seg., Höhe 20, r=1 innen+außen, N=16 (~49k Dreiecke)',
    columns: [
      plate(circleProfile(0, 0, 50, 360), 20, R(1, 16)),
      { name: 'innen', profile: circleProfile(0, 0, 46, 360, true), z0: 0, z1: 20, bottom: R(1, 16), top: R(1, 16) },
    ],
    expect: { mode: 'sharp', bands: 4 },
    boreChamfer: [{ col: 1, R: 46, seg: 360, r: 1, H: 20 }],
  },
];

// ── CLI: STL-Dateien schreiben ──────────────────────────────────────────────
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const OUT = process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), 'stl');
  mkdirSync(OUT, { recursive: true });
  for (const body of BODIES) {
    const tris = buildMesh(body);
    if (body.bends) {
      // Biege-Paare: Innen- und Außenbogen müssen konzentrisch sein (sonst ungleiche Wandstärke)
      try { bendsConcentric(body.bends.pts, body.bends.radii, body.bends.t); }
      catch (e) { console.error(`${body.file}: ${e.message}`); process.exitCode = 1; }
    }
    const m = checkManifold(tris);
    if (!m.ok) { console.error(`${body.file}: NICHT manifold (${m.badEdges} Kanten, ${m.degenerate} entartet)`); process.exitCode = 1; }
    const buf = toBinaryStl(tris, body.file);
    writeFileSync(join(OUT, body.file + '.stl'), buf);
    console.log(`${body.file.padEnd(28)} ${String(tris.length).padStart(5)} Dreiecke  ${(buf.length / 1024).toFixed(1).padStart(6)} KB  V=${meshVolume(tris).toFixed(3)}  manifold=${m.ok}`);
  }
}

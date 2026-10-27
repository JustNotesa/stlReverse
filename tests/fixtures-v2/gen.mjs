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
// Bogen-Flächen (Zylinder + Kegel) im AUS-Export. `expect.anFree` (p1–p3, p5): im AN-/v2-Lauf
// schärfen v1/v2 die Biegungen bzw. Taschenecken — dort wird KEINE Variante verlangt, nur
// wasserdicht/occt/strikt; AUS bleibt voll geprüft (Bögen, Volumen).
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
  return layers.map(({ z, off }) => {
    const ring2 = offsetRing(profile, off);
    if (Math.sign(polyArea(ring2)) !== s0) throw new Error('Versatz kehrt Kontur um (Rundung zu groß)');
    return ring2.map(([x, y]) => [x, y, z]);
  });
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
export function triangulateWithHoles(outer, holes) {
  let poly = outer.slice();
  const maxX = (h) => Math.max(...h.map((p) => p[0]));
  const rest = holes.slice().sort((a, b) => maxX(b) - maxX(a));
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
  return earClip(poly);
}

// ── Körper bauen ────────────────────────────────────────────────────────────
// body.columns: [{ name, profile, z0, z1, bottom, top, draftDeg? }]
// body.caps (optional): [{ z, up, outer: {c, end, rev?}, holes: [{c, end, rev?}] }]
//   Default: Deckel oben/unten aus allen Säulen (CCW-Säulen = Außen, CW-Säulen = Löcher).
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
  let caps = body.caps;
  if (!caps) {
    const outerIdx = body.columns.map((col, i) => i).filter((i) => polyArea(body.columns[i].profile) > 0);
    const holeIdx = body.columns.map((col, i) => i).filter((i) => polyArea(body.columns[i].profile) < 0);
    caps = [];
    for (const oi of outerIdx) for (const end of ['top', 'bottom']) caps.push({ up: end === 'top', outer: { c: oi, end }, holes: holeIdx.map((c) => ({ c, end })) });
  }
  for (const cap of caps) {
    const outer = ringAt(cap.outer), holes = (cap.holes || []).map(ringAt);
    for (const [a, b, c] of triangulateWithHoles(outer, holes)) tris.push(cap.up ? [a, b, c] : [a, c, b]);
  }
  if (!body.transform) return tris;
  // Lage im Raum (gedreht/verschoben): jeden Punkt genau einmal abbilden → geteilte Punkte bleiben geteilt
  const T = makeTransform(body.transform);
  const memo = new Map();
  const map = (p) => { let q = memo.get(p); if (!q) { q = T.apply(p); memo.set(p, q); } return q; };
  return tris.map((t) => t.map(map));
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
    bends: { pts: sheetLRaw(30, 20, 2), radii: sheetLRadii(3, 2), t: 2 },
    expect: { mode: 'skip', arcsOff: 2, anFree: true },
  },
  {
    id: 'p2', extra: true, file: 'v2_x_bogen_u',
    desc: 'U-Profil als Blech (30×20, Wandstärke 2, Bogen-Innenradius 4, 8 Seg. je Bogen), 15 hoch, Kanten scharf — vier Biege-Bögen (zwei Biegungen)',
    columns: [plate(sheetUProfile(30, 20, 2, 4, 8), 15, { kind: 'sharp' })],
    bends: { pts: sheetURaw(30, 20, 2), radii: sheetURadii(4, 2), t: 2 },
    expect: { mode: 'skip', arcsOff: 4, anFree: true },
  },
  {
    id: 'p3', extra: true, file: 'v2_x_bogen_s',
    desc: 'Z-Haken als Blech (Flansch 15 unten links, Steg, Flansch 15 oben rechts, Wandstärke 2, Bogen-Innenradius 3, 8 Seg. je Bogen), 17 hoch, Kanten scharf — vier Biege-Bögen (zwei gegenläufige Biegungen)',
    columns: [plate(sheetZProfile(15, 20, 2, 3, 8), 17, { kind: 'sharp' })],
    bends: { pts: sheetZRaw(15, 20, 2), radii: sheetZRadii(3, 2), t: 2 },
    expect: { mode: 'skip', arcsOff: 4, anFree: true },
  },
  {
    id: 'p4', extra: true, file: 'v2_x_bogen_s_fase',
    desc: 'wie (p3), Stirnseiten oben+unten 0.5×45° gefast (Kabelhalter-Fall: die Fase läuft als Kegel um die Biegungen) — je Bogen 1 Zylinder + 2 Kegel',
    columns: [plate(sheetZProfile(15, 20, 2, 3, 8), 17, { kind: 'chamfer', r: 0.5 })],
    bends: { pts: sheetZRaw(15, 20, 2), radii: sheetZRadii(3, 2), t: 2 },
    expect: { mode: 'skip', arcsOff: 12 },
  },
  {
    id: 'p5', extra: true, file: 'v2_x_bogen_taschenecke',
    desc: 'Platte 30×20×5 (scharf), Tasche 12×8 Tiefe 1 von oben, Kontur mit senkrechten Eckrundungen r=0.3 (6 Seg.) — vier Bogen-Flächen an den Taschenecken',
    columns: [
      { name: 'platte', profile: rectProfile(0, 0, 30, 20), z0: 0, z1: 5, bottom: { kind: 'sharp' }, top: { kind: 'sharp' } },
      { name: 'tasche', profile: roundedRectProfile(12, 8, 0.3, 6).map(([x, y]) => [x + 9, y + 6]).reverse(), z0: 4, z1: 5, bottom: { kind: 'sharp' }, top: { kind: 'sharp' } },
    ],
    caps: [
      { up: true, outer: { c: 0, end: 'top' }, holes: [{ c: 1, end: 'top' }] },
      { up: false, outer: { c: 0, end: 'bottom' }, holes: [] },
      { up: true, outer: { c: 1, end: 'bottom', rev: true }, holes: [] }, // Taschenboden (z=4)
    ],
    expect: { mode: 'skip', arcsOff: 4, anFree: true },
  },
  {
    id: 'p6', extra: true, file: 'v2_x_bogen_s_fase_gedreht',
    desc: 'wie (p4), schräg im Raum gedreht (20°/35°/10°) und verschoben — die Bögen stehen schräg, die Kegel der Fase ebenso',
    columns: [plate(sheetZProfile(15, 20, 2, 3, 8), 17, { kind: 'chamfer', r: 0.5 })],
    bends: { pts: sheetZRaw(15, 20, 2), radii: sheetZRadii(3, 2), t: 2 },
    transform: { rot: [20, 35, 10], t: [50, -20, 7] },
    expect: { mode: 'skip', arcsOff: 12 },
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
    expect: { mode: 'sharp', bores: 1 },
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

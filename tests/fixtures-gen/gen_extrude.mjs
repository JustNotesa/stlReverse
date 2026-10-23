// Erzeugt Extrusions-Testkörper (2D-Profil mit Verrundungs-Bögen, entlang Z extrudiert).
// Aufruf: node tests/fixtures-gen/gen_extrude.mjs <zielordner>
// Herkunft der Samples: plate_4fillets.stl = plate_4fillets_fine (Seitenebenen entlang Z
// unterteilt, wie viele CAD-Exporte), lbracket_concave_fillet.stl = lbracket_concave_coarse
// (Ebenen ohne innere Punkte). Beide prüfen Erkennung + Defeaturing gerader Kanten-Verrundungen
// (konvex an der Platte, konkave Hohlkehle am L-Winkel).
import { writeFileSync } from 'fs';
const OUT = process.argv[2];

// Profil-Bausteine: Linie (mit optionaler Unterteilung) + Bogen (Zentrum, Radius, Winkel von→bis)
function profile(parts, step) {
  const pts = [];
  for (const p of parts) {
    if (p.type === 'line') {
      const [x0, y0] = p.from, [x1, y1] = p.to;
      const n = step ? Math.max(1, Math.round(Math.hypot(x1 - x0, y1 - y0) / step)) : 1;
      for (let i = 0; i < n; i++) pts.push([x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n]);
    } else {
      const { c, r, a0, a1, seg } = p;
      for (let k = 0; k < seg; k++) { const a = a0 + (a1 - a0) * k / seg; pts.push([c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)]); }
    }
  }
  return pts; // geschlossen, gegen den Uhrzeigersinn
}

// Ear-Clipping für einfache (auch konkave) Polygone, CCW
function triangulate(poly) {
  const idx = poly.map((_, i) => i), tris = [];
  const area2 = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const inTri = (p, a, b, c) => area2(a, b, p) > 1e-12 && area2(b, c, p) > 1e-12 && area2(c, a, p) > 1e-12;
  let guard = 0;
  while (idx.length > 3 && guard++ < 100000) {
    let cut = false;
    for (let i = 0; i < idx.length; i++) {
      const ia = idx[(i + idx.length - 1) % idx.length], ib = idx[i], ic = idx[(i + 1) % idx.length];
      const a = poly[ia], b = poly[ib], c = poly[ic];
      if (area2(a, b, c) <= 1e-12) continue;
      let ok = true;
      for (const j of idx) { if (j === ia || j === ib || j === ic) continue; if (inTri(poly[j], a, b, c)) { ok = false; break; } }
      if (!ok) continue;
      tris.push([ia, ib, ic]); idx.splice(i, 1); cut = true; break;
    }
    if (!cut) throw new Error('Ear-Clipping fehlgeschlagen');
  }
  tris.push([idx[0], idx[1], idx[2]]);
  return tris;
}

function extrude(poly, H, zStep) {
  const tris = [];
  const nz = zStep ? Math.max(1, Math.round(H / zStep)) : 1;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    for (let k = 0; k < nz; k++) {
      const z0 = H * k / nz, z1 = H * (k + 1) / nz;
      const a = [p[0], p[1], z0], b = [q[0], q[1], z0], c = [q[0], q[1], z1], d = [p[0], p[1], z1];
      tris.push([a, b, c], [a, c, d]); // Normale nach außen bei CCW-Profil
    }
  }
  for (const [i, j, k] of triangulate(poly)) {
    tris.push([[...poly[i], 0], [...poly[k], 0], [...poly[j], 0]]);   // Boden (-Z)
    tris.push([[...poly[i], H], [...poly[j], H], [...poly[k], H]]);   // Deckel (+Z)
  }
  return tris;
}

function writeStl(name, tris) {
  let s = `solid ${name}\n`;
  for (const [a, b, c] of tris) {
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const l = Math.hypot(...n) || 1;
    s += `facet normal ${n[0] / l} ${n[1] / l} ${n[2] / l}\nouter loop\nvertex ${a.join(' ')}\nvertex ${b.join(' ')}\nvertex ${c.join(' ')}\nendloop\nendfacet\n`;
  }
  writeFileSync(`${OUT}/${name}.stl`, s + `endsolid ${name}\n`);
  return tris.length;
}

const P = Math.PI;
// (b) Platte 40×30, alle 4 Hochkanten verrundet r=3, Höhe 10
const plate = (step) => profile([
  { type: 'line', from: [3, 0], to: [37, 0] },
  { type: 'arc', c: [37, 3], r: 3, a0: -P / 2, a1: 0, seg: 6 },
  { type: 'line', from: [40, 3], to: [40, 27] },
  { type: 'arc', c: [37, 27], r: 3, a0: 0, a1: P / 2, seg: 6 },
  { type: 'line', from: [37, 30], to: [3, 30] },
  { type: 'arc', c: [3, 27], r: 3, a0: P / 2, a1: P, seg: 6 },
  { type: 'line', from: [0, 27], to: [0, 3] },
  { type: 'arc', c: [3, 3], r: 3, a0: P, a1: 1.5 * P, seg: 6 },
], step);
// (a) L-Winkel: Schenkel 40×8 und 8×30, KONKAVE Innen-Verrundung r=4 in der Ecke (8,8)
const lBracket = (step) => profile([
  { type: 'line', from: [0, 0], to: [40, 0] },
  { type: 'line', from: [40, 0], to: [40, 8] },
  { type: 'line', from: [40, 8], to: [12, 8] },
  // Hohlkehle: Zentrum (12,12), läuft von (12,8) im Uhrzeigersinn nach (8,12)
  { type: 'arc', c: [12, 12], r: 4, a0: -P / 2, a1: -P, seg: 6 },
  { type: 'line', from: [8, 12], to: [8, 30] },
  { type: 'line', from: [8, 30], to: [0, 30] },
  { type: 'line', from: [0, 30], to: [0, 0] },
], step);

const made = {
  plate_4fillets_fine: writeStl('plate_4fillets_fine', extrude(plate(0), 10, 2.5)),
  plate_4fillets_coarse: writeStl('plate_4fillets_coarse', extrude(plate(0), 10, 0)),
  lbracket_concave_fine: writeStl('lbracket_concave_fine', extrude(lBracket(0), 20, 4)),
  lbracket_concave_coarse: writeStl('lbracket_concave_coarse', extrude(lBracket(0), 20, 0)),
};
console.log(JSON.stringify(made));

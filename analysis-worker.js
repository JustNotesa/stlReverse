import { parseStl, analyseMesh, simplifyMesh } from './analysis-core.js';
import { unifyCoplanarGroups } from './face-unification.js';
import { recognizePrimitives } from './primitive-recognition.js?v=8';
// segmentation.js ist parkend — aktuell ungenutzt, wird erst relevant wenn
// Face-Unification zu echter Primitiv-Erkennung (Zylinder/Kegel) ausgebaut wird.

const sanitizeCount = (value, total) => {
  if (!Number.isFinite(total) || total <= 0) return 0;
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(total, Math.round(value)));
};

const sanitizeRatio = (value) => {
  if (!Number.isFinite(value)) return 0.5;
  return Math.max(0, Math.min(0.98, value));
};

const MAX_FACES = 50000;
let cachedMesh = null;
let cachedFileName = null;

self.addEventListener('message', (event) => {
  const { id, buffer, fileName, detailLevel, reanalyzeOnly } = event.data || {};
  if (typeof id === 'undefined') {
    self.postMessage({ id, ok: false, message: 'Ungültige Worker-Nachricht' });
    return;
  }

  try {
    let mesh;

    if (reanalyzeOnly && cachedMesh) {
      // Detail-Slider: Gecachtes Mesh wiederverwenden, nur Analyse neu
      mesh = cachedMesh;
      self.postMessage({
        id,
        progress: {
          step: 'worker',
          detail: `Cache genutzt (${mesh.faces.length.toLocaleString?.('de-DE') || mesh.faces.length} Dreiecke)`,
          ratio: 0.50
        }
      });
    } else {
      if (!buffer) {
        self.postMessage({ id, ok: false, message: 'Kein Buffer übergeben' });
        return;
      }
      const rawMesh = parseStl(buffer, ({ processed, total }) => {
        if (!processed || !total) return;
        self.postMessage({
          id,
          progress: {
            step: 'worker',
            detail: `STL wird gelesen (${processed.toLocaleString?.('de-DE') || processed}/${total.toLocaleString?.('de-DE') || total})`,
            ratio: Math.min(0.35, 0.35 * (processed / total))
          }
        });
      });
      self.postMessage({
        id,
        progress: {
          step: 'worker',
          detail: `STL gelesen (${rawMesh.faces.length.toLocaleString?.('de-DE') || rawMesh.faces.length} Dreiecke)`,
          ratio: 0.38
        }
      });

      // Simplify if mesh exceeds threshold
      mesh = rawMesh;
      if (rawMesh.faces.length > MAX_FACES) {
        self.postMessage({
          id,
          progress: {
            step: 'worker',
            detail: `Vereinfache Mesh (${rawMesh.faces.length.toLocaleString?.('de-DE') || rawMesh.faces.length} → ${MAX_FACES.toLocaleString?.('de-DE') || MAX_FACES})`,
            ratio: 0.40
          }
        });
        mesh = simplifyMesh(rawMesh, MAX_FACES, ({ processed, total }) => {
          if (!processed || !total) return;
          self.postMessage({
            id,
            progress: {
              step: 'worker',
              detail: `Vereinfache Mesh (${Math.round((processed / total) * 100)}%)`,
              ratio: 0.40 + 0.10 * (processed / total)
            }
          });
        });
        self.postMessage({
          id,
          progress: {
            step: 'worker',
            detail: `Vereinfacht auf ${mesh.faces.length.toLocaleString?.('de-DE') || mesh.faces.length} Dreiecke`,
            ratio: 0.50
          }
        });
      } else {
        self.postMessage({
          id,
          progress: {
            step: 'worker',
            detail: `${rawMesh.faces.length.toLocaleString?.('de-DE') || rawMesh.faces.length} Dreiecke (kein Simplify nötig)`,
            ratio: 0.50
          }
        });
      }

      // Cache for detail-slider reprocessing
      cachedMesh = mesh;
      cachedFileName = fileName;
    }

    const totalFaces = mesh.faces.length || 1;
    const analysis = analyseMesh(mesh, cachedFileName || fileName || 'model.stl', {
      detailLevel,
      progress: (payload = {}) => {
        const processed = sanitizeCount(payload.processed, totalFaces);
        const ratio = sanitizeRatio(payload.ratio);
        const detail = payload.detail || 'Analyse im Hintergrund';
        self.postMessage({
          id,
          progress: {
            step: 'worker',
            detail,
            ratio,
            processed,
            total: totalFaces
          }
        });
      }
    });
    // Region-Growing auf echten Ebenen (nicht mehr Dihedral-Winkel!)
    // Zwei Dreiecke fusionieren nur wenn (a) Normalen nahezu gleich UND (b) Offsets
    // (n·p) nahezu gleich sind — sprich: sie liegen tatsächlich in derselben Ebene.
    // Rundungen mit kleinem Winkelschritt (5° pro Tessellierungs-Segment) werden
    // dadurch NICHT mehr fälschlich zu einer Region zusammengezogen.
    analysis.normalGroups = (() => {
      const faces = mesh.faces;
      const n = faces.length;
      if (!n) return [];

      // Strenge Ebenen-Toleranzen:
      //   PLANAR_COS = cos(2°) → Normalen dürfen max. 2° abweichen (Tessellierungs-Rauschen).
      //   PLANAR_OFFSET_MM = 0.05 mm → Ebene-Offset (n·p) darf max. 50 µm wandern.
      // Zusammen: Rundungen > 2° pro Segment trennen sauber; echte Ebenen bleiben geschlossen.
      const PLANAR_COS = Math.cos(2 * Math.PI / 180);
      const PLANAR_OFFSET_MM = 0.05;

      const vtxKey  = (v) => `${v[0].toFixed(4)},${v[1].toFixed(4)},${v[2].toFixed(4)}`;
      const edgeKey = (a, b) => {
        const ka = vtxKey(a), kb = vtxKey(b);
        return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      };

      // Vorab: normalisierte Normale + repräsentativer Offset (n·p0) pro Dreieck
      const triN = new Float32Array(n * 3);
      const triOff = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const f = faces[i];
        const nx = f.normal[0], ny = f.normal[1], nz = f.normal[2];
        const l = Math.hypot(nx, ny, nz) || 1;
        triN[i * 3 + 0] = nx / l;
        triN[i * 3 + 1] = ny / l;
        triN[i * 3 + 2] = nz / l;
        const p0 = f.vertices[0];
        triOff[i] = (nx * p0[0] + ny * p0[1] + nz * p0[2]) / l;
      }

      // Schritt 1: Kanten → Dreieck(e)
      const edgeToTris = new Map();
      for (let i = 0; i < n; i++) {
        const vs = faces[i].vertices;
        for (let k = 0; k < 3; k++) {
          const ek = edgeKey(vs[k], vs[(k + 1) % 3]);
          let entry = edgeToTris.get(ek);
          if (!entry) { entry = []; edgeToTris.set(ek, entry); }
          entry.push(i);
        }
      }

      // Schritt 2: Adjazenz nur über koplanare Paare
      const adj = Array.from({ length: n }, () => []);
      for (const tris of edgeToTris.values()) {
        if (tris.length !== 2) continue; // Boundary oder non-manifold → überspringen
        const [t1, t2] = tris;
        const i1 = t1 * 3, i2 = t2 * 3;
        const cosA = triN[i1] * triN[i2] + triN[i1 + 1] * triN[i2 + 1] + triN[i1 + 2] * triN[i2 + 2];
        if (cosA < PLANAR_COS) continue;                   // Normalen zu unterschiedlich
        if (Math.abs(triOff[t1] - triOff[t2]) > PLANAR_OFFSET_MM) continue; // Ebene-Offset zu unterschiedlich
        adj[t1].push(t2);
        adj[t2].push(t1);
      }

      // Schritt 3: Region-Growing (BFS)
      const visited = new Uint8Array(n);
      const regions = [];
      for (let i = 0; i < n; i++) {
        if (visited[i]) continue;
        visited[i] = 1;
        const members = [i];
        const queue = [i];
        while (queue.length) {
          const cur = queue.pop();
          for (const nb of adj[cur]) {
            if (!visited[nb]) { visited[nb] = 1; members.push(nb); queue.push(nb); }
          }
        }
        let sx = 0, sy = 0, sz = 0;
        const vertices = [];
        for (const t of members) {
          const f = faces[t];
          sx += f.normal[0]; sy += f.normal[1]; sz += f.normal[2];
          for (const v of f.vertices) vertices.push(v);
        }
        const slen = Math.hypot(sx, sy, sz) || 1;
        regions.push({ normal: [sx / slen, sy / slen, sz / slen], vertices });
      }

      // KEIN Mindestgrößen-Filter: Ebene Rechtecke bestehen in STLs typisch aus
      // genau 2 Dreiecken — ein >=3-Filter löschte ganze Würfelwände (Bug 2026-06-12).
      // Koplanare Kleinst-Regionen fusioniert die Face Unification danach ohnehin.
      return regions.sort((a, b) => b.vertices.length - a.vertices.length);
    })();

    // Face Unification: fuse räumlich getrennte koplanare Regionen (OCCT-äquivalent
    // zu ShapeUpgrade_UnifySameDomain). Reduziert ADVANCED_FACE-Zahl in der STEP
    // und bildet die Basis für spätere Bohrungs-/Primitiverkennung.
    {
      const { unified, stats } = unifyCoplanarGroups(analysis.normalGroups);
      analysis.normalGroups = unified.sort((a, b) => b.vertices.length - a.vertices.length);
      analysis.faceUnification = stats;
      self.postMessage({
        id,
        progress: {
          step: 'worker',
          detail: `Face Unification: ${stats.inputGroups} → ${stats.outputGroups} Flächen (${stats.mergedPatches} fusioniert)`,
          ratio: 0.92
        }
      });
    }

    // Primitiv-Erkennung (Stage 1): zylindrische Flächen (Bohrungen) über Rand-Kreise.
    // Taggt betroffene Gruppen mit `.primitive` (nur Anzeige) — Vertices/Normalen bleiben
    // unverändert. In try/catch gekapselt: ein Erkennungs-Fehler darf die geshippte
    // Pipeline und das Wasserdichtigkeits-Verdikt niemals regressieren.
    try {
      const { primitives, stats } = recognizePrimitives(analysis.normalGroups);
      analysis.primitives = primitives;
      analysis.primitiveStats = stats;
      self.postMessage({
        id,
        progress: {
          step: 'worker',
          detail: `Primitiv-Erkennung: ${stats.cylinders} Zylinder/Bohrungen erkannt`,
          ratio: 0.95
        }
      });
    } catch (e) {
      analysis.primitives = [];
      analysis.primitiveStats = { inputGroups: analysis.normalGroups?.length || 0, cylinders: 0, bores: 0, fillets: 0 };
      self.postMessage({
        id,
        progress: { step: 'worker', detail: `Primitiv-Erkennung übersprungen: ${e?.message || e}`, ratio: 0.95 }
      });
    }

    self.postMessage({ id, ok: true, analysis });
  } catch (error) {
    self.postMessage({
      id,
      ok: false,
      message: error?.message || String(error),
      stack: error?.stack
    });
  }
});

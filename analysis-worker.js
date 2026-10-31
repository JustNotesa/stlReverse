import { parseStl, analyseMesh, simplifyMesh } from './analysis-core.js?v=4';
import { unifyCoplanarGroups } from './face-unification.js?v=2';
import { buildNormalGroups } from './region-growing.js?v=1';
import { recognizePrimitives } from './primitive-recognition.js?v=16';
import { detectTubes } from './tube-sweep.js?v=4';
import { cleanMesh, DEFAULT_MIN_DETAIL_MM } from './mesh-clean.js?v=2';
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

// Netz-Vereinfachung (mesh-simplify.js): erst AB dieser Dreieckszahl, dann auf das Ziel. Begründung und
// Messwerte (Bremsgriff, synthetische 200k/500k-Körper) in TODO.md, Eintrag „Saubere Netz-Vereinfachung“.
const SIMPLIFY_ABOVE = 100000;
const SIMPLIFY_TARGET = 100000;
let cachedMesh = null;
let cachedFileName = null;
let cachedClean = null;   // Bericht der Netz-Bereinigung zum gecachten Netz

self.addEventListener('message', (event) => {
  const { id, buffer, fileName, detailLevel, reanalyzeOnly, minDetailMm } = event.data || {};
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

      // Netz-Bereinigung „Kleinste Detailgröße“ (mesh-clean.js): Mikro-Kanten kollabieren, bevor
      // Region-Growing sie zu STEP-Kanten macht. 0 = aus. Gleiche Funktion wie in den Node-Tests.
      mesh = rawMesh;
      const tau = Number.isFinite(minDetailMm) ? minDetailMm : DEFAULT_MIN_DETAIL_MM;
      cachedClean = null;
      if (tau > 0) {
        self.postMessage({ id, progress: { step: 'worker', detail: `Mikro-Kanten < ${tau} mm werden entfernt …`, ratio: 0.39 } });
        const { mesh: cleaned, report } = cleanMesh(rawMesh, { minDetailMm: tau });
        mesh = cleaned;
        cachedClean = report;
        self.postMessage({
          id,
          progress: { step: 'worker', detail: `Netz bereinigt: ${report.removedTris} Mikro-Dreiecke entfernt`, ratio: 0.40 }
        });
      }

      // Simplify if mesh exceeds threshold
      if (mesh.faces.length > SIMPLIFY_ABOVE) {
        self.postMessage({
          id,
          progress: {
            step: 'worker',
            detail: `Vereinfache Mesh (${mesh.faces.length.toLocaleString?.('de-DE') || mesh.faces.length} → ${SIMPLIFY_TARGET.toLocaleString?.('de-DE') || SIMPLIFY_TARGET})`,
            ratio: 0.40
          }
        });
        mesh = simplifyMesh(mesh, SIMPLIFY_TARGET, ({ processed, total }) => {
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
            detail: `${mesh.faces.length.toLocaleString?.('de-DE') || mesh.faces.length} Dreiecke (kein Simplify nötig)`,
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
    // Region-Growing auf echten Ebenen — gemeinsames Modul (region-growing.js), identisch zu
    // Node-Tests/Regressionstests. Bezug ist die REGION (mittlere Normale + Ebene), nicht der
    // Nachbar: bei feiner Tessellierung kettete der Nachbar-Vergleich ganze Rundungen zu einer
    // „Ebene“ (Bug 2026-10-23).
    analysis.normalGroups = buildNormalGroups(mesh);
    analysis.meshClean = cachedClean;

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
    // Taggt betroffene Gruppen mit `.primitive` — Vertices/Normalen bleiben unverändert. Gruppen
    // mit Wandfacetten mehrerer Voll-Zylinder (koaxiale Bohrungen) werden dabei geteilt (die
    // Untergruppen hängen am Ende der Liste; sie ist danach nicht mehr nach Größe sortiert). In try/catch gekapselt: ein Erkennungs-Fehler darf die geshippte
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
      analysis.primitiveStats = { inputGroups: analysis.normalGroups?.length || 0, cylinders: 0, bores: 0, fillets: 0, splitGroups: 0 };
      self.postMessage({
        id,
        progress: { step: 'worker', detail: `Primitiv-Erkennung übersprungen: ${e?.message || e}`, ratio: 0.95 }
      });
    }

    // Kanal-Erkennung (tube-sweep.js): gebogene Rohre (Kreisprofil entlang Biarc-Bahn) → group.tube.
    // Wie die Primitiv-Erkennung rein additiv (Tags), gekapselt: ein Fehler lässt Kanäle facettiert.
    try {
      self.postMessage({
        id,
        progress: { step: 'worker', detail: 'Kanal-Erkennung: suche gebogene Kanäle …', ratio: 0.96 }
      });
      const { tubes, stats } = detectTubes(analysis.normalGroups);
      // Verworfene Kandidaten mitteilen, damit die UI sagen kann, WARUM ein Kanal facettiert blieb.
      analysis.tubeStats = {
        candidates: stats.candidates,
        tubes: tubes.length,
        rejected: (stats.rejected || []).map((x) => ({ why: String(x.why), tris: x.tris, r0: x.r0 }))
      };
      if (tubes.length) {
        self.postMessage({
          id,
          progress: { step: 'worker', detail: `Kanal-Erkennung: ${tubes.length} gebogene Kanäle erkannt`, ratio: 0.97 }
        });
      }
    } catch (e) {
      analysis.tubeStats = { candidates: 0, tubes: 0, rejected: [] };
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

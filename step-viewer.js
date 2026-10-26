import * as THREE from './libs/three.module.js';
import { createThreeJsViewer, disposeThreeJsViewer } from './viewers.js?v=28';

const extensionApi = typeof browser !== 'undefined' ? browser
  : typeof chrome !== 'undefined' ? chrome : null;

// ── Module-level state ──────────────────────────────────────────────────────

let stepOcctRenderer = null, stepOcctScene = null, stepOcctCamera = null,
    stepOcctControls = null, stepOcctMeshGroup = null, stepOcctResizeObs = null,
    stepOcctAnimId = null;
let stepOcctContainer = null;
let stepOcctEdges = null;       // THREE.LineSegments der Flächengrenzen (B-Rep-Kanten)
let stepEdgesVisible = true;    // Sichtbarkeit (Checkbox „Kanten")

let occtWorker = null;
let occtWorkerTimer = null;
const OCCT_TIMEOUT_MS = 120000;

const stepHiddenInput = document.createElement('input');
stepHiddenInput.type = 'file';
stepHiddenInput.accept = '.step,.stp';

// ── Init ────────────────────────────────────────────────────────────────────

export function initStepOcctViewer() {
  stepOcctContainer = document.getElementById('step-occt-viewer');
  const stepImportButton = document.getElementById('step-import-button');

  // Dispose previous instance if any
  disposeThreeJsViewer(
    stepOcctRenderer, stepOcctScene, stepOcctControls,
    stepOcctResizeObs, stepOcctAnimId, stepOcctContainer
  );
  stepOcctRenderer = stepOcctScene = stepOcctCamera = null;
  stepOcctControls = stepOcctResizeObs = stepOcctAnimId = null;

  if (stepOcctContainer) {
    try {
      const s = createThreeJsViewer(stepOcctContainer, 0x52b0e8);
      stepOcctRenderer = s.renderer;
      stepOcctScene    = s.scene;
      stepOcctCamera   = s.camera;
      stepOcctControls = s.controls;
      stepOcctResizeObs = s.resizeObserver;
      stepOcctAnimId   = s.animFrameId;
    } catch (e) { console.warn('STEP occt viewer init failed:', e.message); }
  }

  // Wire file input + import button
  document.body.appendChild(stepHiddenInput);
  stepHiddenInput.addEventListener('change', _handleStepFileSelect);
  if (stepImportButton) {
    stepImportButton.addEventListener('click', () => stepHiddenInput.click());
  }

  // Kanten-Umschalter (zeigt/versteckt die Flächengrenzen-Linien)
  const edgeToggle = document.getElementById('step-edges-toggle');
  if (edgeToggle) {
    stepEdgesVisible = edgeToggle.checked;
    edgeToggle.addEventListener('change', () => {
      stepEdgesVisible = edgeToggle.checked;
      if (stepOcctEdges) stepOcctEdges.visible = stepEdgesVisible;
    });
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

export function loadStepIntoViewer(stepArrayBuffer) {
  if (!stepOcctScene || !stepOcctContainer) {
    console.error('loadStepIntoViewer: Viewer nicht initialisiert');
    return;
  }

  stepOcctContainer.dataset.state = 'loading';

  if (occtWorkerTimer) { clearTimeout(occtWorkerTimer); occtWorkerTimer = null; }
  if (occtWorker) { occtWorker.terminate(); occtWorker = null; }

  const workerUrl = extensionApi?.runtime?.getURL
    ? extensionApi.runtime.getURL('libs/occt/occt-import-js-worker.js')
    : 'libs/occt/occt-import-js-worker.js';

  occtWorker = new Worker(workerUrl);

  occtWorkerTimer = setTimeout(() => {
    if (occtWorker) { occtWorker.terminate(); occtWorker = null; }
    occtWorkerTimer = null;
    if (stepOcctContainer) stepOcctContainer.dataset.state = 'error';
    console.error('occt-import-js: Timeout nach', OCCT_TIMEOUT_MS / 1000, 's');
  }, OCCT_TIMEOUT_MS);

  occtWorker.onmessage = (ev) => {
    clearTimeout(occtWorkerTimer); occtWorkerTimer = null;
    occtWorker.terminate(); occtWorker = null;
    _renderOcctResult(ev.data);
  };

  occtWorker.onerror = (ev) => {
    clearTimeout(occtWorkerTimer); occtWorkerTimer = null;
    occtWorker = null;
    if (stepOcctContainer) stepOcctContainer.dataset.state = 'error';
    console.error('occt-import-js Worker Fehler:', ev.message);
  };

  occtWorker.postMessage({
    format: 'step',
    buffer: new Uint8Array(stepArrayBuffer),
    params: {
      linearUnit: 'millimeter',
      linearDeflectionType: 'bounding_box_ratio',
      linearDeflection: 0.001,
      angularDeflection: 0.5
    }
  });
}

// ── Private ─────────────────────────────────────────────────────────────────

async function _handleStepFileSelect(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const buffer = await file.arrayBuffer();
    loadStepIntoViewer(buffer);
  } catch (err) {
    console.error('STEP-Import fehlgeschlagen', err);
  } finally {
    event.target.value = '';
  }
}

function _renderOcctResult(result) {
  if (!stepOcctScene || !stepOcctContainer) return;

  if (!result?.success || !result.meshes?.length) {
    console.warn('OCCT: kein verwertbares Ergebnis', result);
    stepOcctContainer.dataset.state = 'empty';
    return;
  }

  if (stepOcctMeshGroup) {
    stepOcctScene.remove(stepOcctMeshGroup);
    stepOcctMeshGroup.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) {
        if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose());
        else obj.material.dispose();
      }
    });
    stepOcctMeshGroup = null;
    stepOcctEdges = null;
  }

  stepOcctMeshGroup = new THREE.Group();

  // Backface-Material (Gold): wird auf der Innenseite der Hülle sichtbar. Bei einem
  // geschlossenen Solid sind alle Innenseiten verdeckt → man sieht nur Blau. Sobald die
  // Hülle offen ist, blickt man durch das Loch auf die goldene Innenseite der Rückwand —
  // exakt das Verhalten, an dem man Risse in Fusion erkennt.
  const BACKFACE_COLOR = 0xd4af37;

  // polygonOffset schiebt die gefüllten Flächen minimal von der Kamera weg, damit die
  // Kanten-Linien (ohne Offset, exakt auf der Oberfläche) sauberer obenauf liegen (kein Z-Fighting).
  const OFFSET = { polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 };

  for (const occtMesh of result.meshes) {
    const defaultMat = new THREE.MeshStandardMaterial({
      color: 0x52b0e8, metalness: 0.1, roughness: 0.45, side: THREE.FrontSide, ...OFFSET
    });
    const geo       = new THREE.BufferGeometry();
    const positions = occtMesh.attributes.position.array;
    const normals   = occtMesh.attributes.normal?.array;
    const indices   = occtMesh.index?.array;

    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    if (normals?.length) {
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    } else {
      geo.computeVertexNormals();
    }
    if (indices?.length) {
      geo.setIndex(Array.from(indices));
    }

    if (occtMesh.brep_faces?.length) {
      const materials = [];
      for (const face of occtMesh.brep_faces) {
        const mat = face.color
          ? new THREE.MeshStandardMaterial({
              color: new THREE.Color(face.color[0], face.color[1], face.color[2]),
              metalness: 0.1, roughness: 0.45, side: THREE.FrontSide, ...OFFSET
            })
          : defaultMat.clone();
        materials.push(mat);
        geo.addGroup(face.first * 3, (face.last - face.first + 1) * 3, materials.length - 1);
      }
      defaultMat.dispose();
      stepOcctMeshGroup.add(new THREE.Mesh(geo, materials));
    } else {
      stepOcctMeshGroup.add(new THREE.Mesh(geo, defaultMat));
    }

    // Goldene Innenseite (gleiche Geometrie, BackSide) — macht offene Stellen sichtbar.
    const backMat = new THREE.MeshStandardMaterial({
      color: BACKFACE_COLOR, metalness: 0.1, roughness: 0.55, side: THREE.BackSide, ...OFFSET
    });
    stepOcctMeshGroup.add(new THREE.Mesh(geo, backMat));
  }

  // Flächengrenzen (B-Rep-Kanten) als dunkle Linien — die Ränder von PLANE,
  // CYLINDRICAL_SURFACE usw. Wird als Kind der Gruppe geführt (teilt Zentrierung + Dispose).
  stepOcctEdges = _buildFeatureEdges(result.meshes);
  if (stepOcctEdges) {
    stepOcctEdges.visible = stepEdgesVisible;
    stepOcctMeshGroup.add(stepOcctEdges);
  }

  stepOcctScene.add(stepOcctMeshGroup);

  stepOcctContainer.dataset.state = 'ready';

  const box    = new THREE.Box3().setFromObject(stepOcctMeshGroup);
  const center = box.getCenter(new THREE.Vector3());
  const size   = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  stepOcctMeshGroup.position.sub(center);

  if (stepOcctCamera && stepOcctControls) {
    stepOcctCamera.position.set(maxDim * 1.5, maxDim * 1.2, maxDim * 1.5);
    stepOcctControls.target.set(0, 0, 0);
    stepOcctControls.update();
    stepOcctControls.saveState();
  }

}

// Extrahiert die B-Rep-Kanten (Flächengrenzen) aus den occt-Meshes als EINE LineSegments.
// occt liefert pro Mesh `brep_faces` = [{first,last,…}] (Dreiecks-Index-Bereiche je
// topologischer Fläche — eine PLANE, eine CYLINDRICAL_SURFACE, …). Eine Mesh-Kante ist
// genau dann eine echte B-Rep-Kante, wenn sie zwischen ZWEI verschiedenen Flächen liegt
// (oder eine echte Mesh-Randkante ist). Innenkanten der Tessellierung einer einzelnen
// Fläche (gleiche Fläche beidseitig) werden NICHT gezeichnet — so erscheint ein Zylinder
// als saubere Kreise statt als Gitter aus Facetten.
// HINWEIS zur Naht: Bei einer geschlossenen analytischen Fläche (voller Zylinder/Kegel/Kugel =
// EINE brep_face) liegt die UV-Naht (φ=0↔2π) beidseitig auf DERSELBEN Fläche und wird daher
// NICHT gezeichnet — nur die Rand-Kreise. Eine verlässliche Naht-Linie bräuchte occt-Kanten-
// Topologie (liefert occt-import-js nicht); ein Dihedral-Test kann Naht und Facetten nicht
// unterscheiden. Für unseren V2-Export irrelevant (rein planare Flächen, keine Nähte).
function _buildFeatureEdges(meshes) {
  if (!Array.isArray(meshes) || !meshes.length) return null;

  const DP = 4; // Quantisierung der Vertex-Koordinaten (1e-4 mm) zum Zusammenführen geteilter Punkte
  const fix = (v) => {
    const r = +Number(v).toFixed(DP);
    return (r === 0 ? 0 : r).toFixed(DP); // -0/+0 vereinheitlichen
  };
  const ptKey = (x, y, z) => `${fix(x)},${fix(y)},${fix(z)}`;

  const segPos = [];

  // Schutz gegen UI-Einfrieren: _buildFeatureEdges läuft im Main-Thread. Sehr feine externe
  // Importe (occt-Deflection 0.001 × BBox) können Millionen Dreiecke liefern → großer String-
  // keyed Map + Array-Kopien. Über dem Limit werden die Kanten übersprungen (der Körper rendert
  // weiterhin) — protokolliert, nicht still. Unsere V2-STEPs liegen weit darunter.
  const MAX_EDGE_TRIS = 600000;
  const totalTris = meshes.reduce((s, m) => s + ((((m?.index?.array?.length) || 0) / 3) | 0), 0);
  if (totalTris > MAX_EDGE_TRIS) {
    console.warn(`_buildFeatureEdges: ${totalTris} Dreiecke > ${MAX_EDGE_TRIS} — Kanten übersprungen (UI-Reaktionsfähigkeit)`);
    return null;
  }

  // Jedes occt-Mesh wird als eigenständiger Körper behandelt (eigene edgeMap). Bei einer
  // Baugruppe / per-Farbe gesplitteten Datei kann eine zwischen zwei Meshes geteilte Naht
  // damit doppelt als Randkante erscheinen — für Einzelkörper (unser V2-Export) irrelevant.
  for (const m of meshes) {
    const pos = m?.attributes?.position?.array;
    const idx = m?.index?.array;
    if (!pos || !idx || idx.length < 3) continue;
    const triCount = (idx.length / 3) | 0;

    // Dreieck → Flächen-Id (aus brep_faces-Bereichen)
    const triFace = new Int32Array(triCount).fill(-1);
    const hasFaces = Array.isArray(m.brep_faces) && m.brep_faces.length > 0;
    if (hasFaces) {
      for (let fi = 0; fi < m.brep_faces.length; fi++) {
        const f = m.brep_faces[fi];
        const lo = Math.max(0, f.first | 0);
        const hi = Math.min(triCount - 1, f.last | 0);
        for (let t = lo; t <= hi; t++) triFace[t] = fi;
      }
      // Defensiv-Diagnose: Native-OCCT-brep_faces decken den Index-Buffer lückenlos ab.
      // Bleiben doch Dreiecke unbedeckt (triFace === -1), ergäbe jede Kante zwischen bedeckter
      // Fläche und unbedecktem Dreieck count===2/faces.size===1 und fiele still weg (fehlende
      // B-Rep-Kanten). Nur warnen — Rendering bleibt unverändert (keine synthetischen Flächen-Ids).
      let uncovered = 0;
      for (let t = 0; t < triCount; t++) if (triFace[t] === -1) uncovered++;
      if (uncovered > 0) {
        const name = (typeof m.name === 'string' && m.name) ? m.name : `#${meshes.indexOf(m)}`;
        console.warn(`_buildFeatureEdges: Mesh "${name}" — ${uncovered}/${triCount} Dreiecke nicht von brep_faces abgedeckt — Feature-Kanten evtl. unvollständig`);
      }
    }

    // ZWEI sich gegenseitig ausschließende Strategien — nie beide (sonst würden Randkanten
    // doppelt gezeichnet, weil EdgesGeometry Randkanten ebenfalls liefert):
    if (hasFaces) {
      // MIT brep_faces: Kanten-Map posKey → { faces:Set, count, a:[xyz], b:[xyz] }.
      // Feature-Kante = trennt zwei Flächen (faces≥2) ODER echte Randkante (count===1)
      // ODER non-manifold (count>2). Innenkanten EINER Fläche (count===2, faces=1) fallen weg.
      const edgeMap = new Map();
      const addEdge = (v0, v1, fid) => {
        const x0 = pos[v0 * 3], y0 = pos[v0 * 3 + 1], z0 = pos[v0 * 3 + 2];
        const x1 = pos[v1 * 3], y1 = pos[v1 * 3 + 1], z1 = pos[v1 * 3 + 2];
        const k0 = ptKey(x0, y0, z0), k1 = ptKey(x1, y1, z1);
        if (k0 === k1) return; // entartete Kante
        const ek = k0 < k1 ? `${k0}|${k1}` : `${k1}|${k0}`;
        let e = edgeMap.get(ek);
        if (!e) { e = { faces: new Set(), count: 0, a: [x0, y0, z0], b: [x1, y1, z1] }; edgeMap.set(ek, e); }
        e.count++;
        if (fid >= 0) e.faces.add(fid);
      };
      for (let t = 0; t < triCount; t++) {
        const a = idx[t * 3], b = idx[t * 3 + 1], c = idx[t * 3 + 2];
        const fid = triFace[t];
        addEdge(a, b, fid); addEdge(b, c, fid); addEdge(c, a, fid);
      }
      for (const e of edgeMap.values()) {
        const feature = e.faces.size >= 2 || e.count === 1 || e.count > 2;
        if (feature) segPos.push(e.a[0], e.a[1], e.a[2], e.b[0], e.b[1], e.b[2]);
      }
    } else {
      // OHNE brep_faces (manche externen STEP-Importe): Knick- UND Randkanten allein über
      // THREE.EdgesGeometry (liefert Randkanten + Kanten mit Dihedral-Winkel > 25°).
      try {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(Array.from(pos), 3));
        g.setIndex(Array.from(idx));
        const eg = new THREE.EdgesGeometry(g, 25);
        const ep = eg.attributes.position.array;
        for (let i = 0; i < ep.length; i++) segPos.push(ep[i]);
        g.dispose(); eg.dispose();
      } catch (_) { /* ignore */ }
    }
  }

  if (!segPos.length) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(segPos, 3));
  const mat = new THREE.LineBasicMaterial({ color: 0x14202b });
  const lines = new THREE.LineSegments(geo, mat);
  lines.renderOrder = 1; // nach den Flächen zeichnen
  return lines;
}

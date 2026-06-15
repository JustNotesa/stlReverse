import * as THREE from './libs/three.module.js';
import { OrbitControls } from './libs/OrbitControls.js';

// ── Module-level state ──────────────────────────────────────────────────────

let stlRenderer = null, stlScene = null, stlCamera = null, stlControls = null,
    stlMeshGroup = null, stlResizeObs = null, stlAnimId = null;
let featuresRenderer = null, featuresScene = null, featuresCamera = null,
    featuresControls = null, featuresMeshGroup = null, featuresResizeObs = null,
    featuresAnimId = null;
let brepRenderer = null, brepScene = null, brepCamera = null, brepControls = null,
    brepMeshGroup = null, brepResizeObs = null, brepAnimId = null;

// ── Public helpers (also used by step-viewer.js) ────────────────────────────

export function createThreeJsViewer(container, accentColor) {
  // Kein preserveDrawingBuffer: true — das hielt den Zeichenpuffer zwischen Frames und
  // führte beim Rotieren zu Schlieren/Nachziehen (der Puffer wurde nicht zuverlässig
  // gelöscht). Screenshots laufen über den Compositor (Playwright/CDP), nicht canvas.toDataURL,
  // brauchen das Flag also nicht.
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(window.devicePixelRatio || 1);
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.setClearColor(0xf2f4f8, 1);
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xf2f4f8);

  const camera = new THREE.PerspectiveCamera(
    45, container.clientWidth / container.clientHeight, 0.1, 5000
  );
  camera.position.set(80, 100, 120);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;

  const ambient = new THREE.AmbientLight(0xffffff, 0.6);
  const dir = new THREE.DirectionalLight(0xffffff, 0.8);
  dir.position.set(100, 120, 90);
  scene.add(ambient, dir);

  const gridHelper = new THREE.GridHelper(200, 10, accentColor, 0xbac4d4);
  gridHelper.material.opacity = 0.55;
  gridHelper.material.transparent = true;
  scene.add(gridHelper);

  scene.add(new THREE.AxesHelper(40));

  let animFrameId = null;
  const renderLoop = () => {
    animFrameId = requestAnimationFrame(renderLoop);
    controls.update();
    renderer.render(scene, camera);
  };
  renderLoop();

  const resizeObserver = new ResizeObserver(() => {
    const w = container.clientWidth;
    const h = container.clientHeight;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  });
  resizeObserver.observe(container);

  return {
    renderer, scene, camera, controls, resizeObserver,
    get animFrameId() { return animFrameId; }
  };
}

export function disposeThreeJsViewer(renderer, scene, controls, resizeObs, animId, container) {
  if (animId) cancelAnimationFrame(animId);
  if (resizeObs) resizeObs.disconnect();
  if (controls) controls.dispose();
  if (scene) {
    scene.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) {
        if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose());
        else obj.material.dispose();
      }
    });
  }
  if (renderer) {
    renderer.dispose();
    if (container && renderer.domElement?.parentNode === container) {
      container.removeChild(renderer.domElement);
    }
  }
}

// ── Init pipeline viewers 1-3 ───────────────────────────────────────────────

export function initPipelineViewers() {
  const stlContainer      = document.getElementById('stl-viewer');
  const featuresContainer = document.getElementById('features-viewer');
  const brepContainer     = document.getElementById('brep-viewer');

  disposeThreeJsViewer(stlRenderer,      stlScene,      stlControls,      stlResizeObs,      stlAnimId,      stlContainer);
  disposeThreeJsViewer(featuresRenderer, featuresScene, featuresControls, featuresResizeObs, featuresAnimId, featuresContainer);
  disposeThreeJsViewer(brepRenderer,     brepScene,     brepControls,     brepResizeObs,     brepAnimId,     brepContainer);

  if (stlContainer) {
    try {
      const s = createThreeJsViewer(stlContainer, 0x1be0a0);
      stlRenderer = s.renderer; stlScene = s.scene; stlCamera = s.camera;
      stlControls = s.controls; stlResizeObs = s.resizeObserver; stlAnimId = s.animFrameId;
    } catch (e) { console.warn('STL viewer init failed:', e.message); }
  }

  if (featuresContainer) {
    try {
      const s = createThreeJsViewer(featuresContainer, 0x5fa8ff);
      featuresRenderer = s.renderer; featuresScene = s.scene; featuresCamera = s.camera;
      featuresControls = s.controls; featuresResizeObs = s.resizeObserver; featuresAnimId = s.animFrameId;
    } catch (e) { console.warn('Features viewer init failed:', e.message); }
  }

  if (brepContainer) {
    try {
      const s = createThreeJsViewer(brepContainer, 0xffc75f);
      brepRenderer = s.renderer; brepScene = s.scene; brepCamera = s.camera;
      brepControls = s.controls; brepResizeObs = s.resizeObserver; brepAnimId = s.animFrameId;
    } catch (e) { console.warn('B-Rep viewer init failed:', e.message); }
  }
}

// ── Viewer 1: Original STL Mesh ─────────────────────────────────────────────

export function updateStlViewer(triangles, bbox) {
  if (!stlScene) return;
  const container = document.getElementById('stl-viewer');

  if (stlMeshGroup) {
    stlScene.remove(stlMeshGroup);
    stlMeshGroup.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) obj.material.dispose();
    });
    stlMeshGroup = null;
  }

  if (!triangles?.length) {
    if (container) container.dataset.state = 'empty';
    return;
  }

  if (container) container.dataset.state = 'ready';
  stlMeshGroup = new THREE.Group();

  const positions = new Float32Array(triangles.length * 9);
  const normals   = new Float32Array(triangles.length * 9);

  triangles.forEach((tri, i) => {
    const o = i * 9;
    positions[o]   = tri.vertices[0][0]; positions[o+1] = tri.vertices[0][2]; positions[o+2] = tri.vertices[0][1];
    positions[o+3] = tri.vertices[1][0]; positions[o+4] = tri.vertices[1][2]; positions[o+5] = tri.vertices[1][1];
    positions[o+6] = tri.vertices[2][0]; positions[o+7] = tri.vertices[2][2]; positions[o+8] = tri.vertices[2][1];
    normals[o]   = tri.normal[0]; normals[o+1] = tri.normal[2]; normals[o+2] = tri.normal[1];
    normals[o+3] = tri.normal[0]; normals[o+4] = tri.normal[2]; normals[o+5] = tri.normal[1];
    normals[o+6] = tri.normal[0]; normals[o+7] = tri.normal[2]; normals[o+8] = tri.normal[1];
  });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal',   new THREE.BufferAttribute(normals, 3));

  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
    color: 0x1be0a0, metalness: 0.1, roughness: 0.6, side: THREE.DoubleSide
  }));

  if (bbox) {
    mesh.position.set(
      -(bbox.min[0] + bbox.width / 2),
      -(bbox.min[2] + bbox.height / 2),
      -(bbox.min[1] + bbox.depth / 2)
    );
  }

  stlMeshGroup.add(mesh);

  // Roh-Vertices als kleine cyan Punkte (deduped) — zeigt Tessellierungs-Dichte.
  // Dieses Debug-Overlay gehört bewusst nur in Panel 1 (Quelle = STL-Mesh).
  const maxDim = bbox ? Math.max(bbox.width, bbox.depth, bbox.height) : 1;
  const rawSeen = new Set();
  const rawUnique = [];
  triangles.forEach((tri) => {
    for (const v of tri.vertices) {
      const k = `${v[0].toFixed(4)},${v[1].toFixed(4)},${v[2].toFixed(4)}`;
      if (!rawSeen.has(k)) { rawSeen.add(k); rawUnique.push(v); }
    }
  });
  if (rawUnique.length) {
    const rawPos = new Float32Array(rawUnique.length * 3);
    for (let i = 0; i < rawUnique.length; i++) {
      const v = rawUnique[i]; const o = i * 3;
      rawPos[o] = v[0]; rawPos[o + 1] = v[2]; rawPos[o + 2] = v[1];
    }
    const rawGeo = new THREE.BufferGeometry();
    rawGeo.setAttribute('position', new THREE.BufferAttribute(rawPos, 3));
    const rawPts = new THREE.Points(rawGeo,
      new THREE.PointsMaterial({ color: 0x00bcd4, size: maxDim * 0.01, sizeAttenuation: true, transparent: true, opacity: 0.85 })
    );
    if (bbox) {
      rawPts.position.set(
        -(bbox.min[0] + bbox.width / 2),
        -(bbox.min[2] + bbox.height / 2),
        -(bbox.min[1] + bbox.depth / 2)
      );
    }
    stlMeshGroup.add(rawPts);
  }

  stlScene.add(stlMeshGroup);

  if (stlControls && bbox) {
    stlCamera.position.set(maxDim * 1.5, maxDim * 1.2, maxDim * 1.5);
    stlControls.target.set(0, 0, 0);
    stlControls.update();
  }
}

// ── Viewer 2: Erkannte Features ─────────────────────────────────────────────

export function updateFeaturesViewer(triangles, analysis, bbox) {
  if (!featuresScene) return;
  const container = document.getElementById('features-viewer');

  if (featuresMeshGroup) {
    featuresScene.remove(featuresMeshGroup);
    featuresMeshGroup.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) obj.material.dispose();
    });
    featuresMeshGroup = null;
  }

  if (!triangles?.length) {
    if (container) container.dataset.state = 'empty';
    return;
  }

  if (container) container.dataset.state = 'ready';
  featuresMeshGroup = new THREE.Group();

  let centerX = 0, centerY = 0, centerZ = 0, maxDim = 1;
  if (bbox) {
    centerX = bbox.min[0] + bbox.width / 2;
    centerY = bbox.min[1] + bbox.depth / 2;
    centerZ = bbox.min[2] + bbox.height / 2;
    maxDim  = Math.max(bbox.width, bbox.depth, bbox.height);
  }

  const normalGroups = analysis?.normalGroups;
  if (normalGroups?.length) {
    // V2: Alle Normalgruppen in EINE Geometrie mit Vertex-Farben mergen → 1 Draw-Call
    // statt einem Mesh+Material pro Region. Bei komplexen Teilen (hunderte Regionen) war
    // die hohe Draw-Call-Zahl die Ursache für niedrige FPS / „Nachziehen" beim Rotieren.
    // Optik bleibt identisch: non-indexed Dreiecke → computeVertexNormals gibt Flat-Shading,
    // die Region-Farbe sitzt als Vertex-Farbe auf allen 3 Ecken jedes Dreiecks.
    let totalTris = 0;
    for (const g of normalGroups) totalTris += Math.floor(g.vertices.length / 3);

    const positions = new Float32Array(totalTris * 9);
    const colors    = new Float32Array(totalTris * 9);
    let p = 0;
    normalGroups.forEach((group, idx) => {
      const verts = group.vertices; // Array von [x,y,z]
      const triCount = Math.floor(verts.length / 3); // 3 Vertices pro Dreieck
      // Erkannte Primitive hervorheben: Bohrungen rot, Verrundungen orange (statt Regenbogen-HSL).
      const col = group.primitive?.type === 'cylinder'
        ? new THREE.Color(group.primitive.kind === 'fillet' ? 0xff9500 : 0xff3b30)
        : new THREE.Color().setHSL(idx / normalGroups.length, 0.75, 0.55);
      for (let i = 0; i < triCount; i++) {
        const v0 = verts[i * 3], v1 = verts[i * 3 + 1], v2 = verts[i * 3 + 2];
        positions[p]   = v0[0]; positions[p+1] = v0[2]; positions[p+2] = v0[1];
        positions[p+3] = v1[0]; positions[p+4] = v1[2]; positions[p+5] = v1[1];
        positions[p+6] = v2[0]; positions[p+7] = v2[2]; positions[p+8] = v2[1];
        for (let k = 0; k < 9; k += 3) { colors[p+k] = col.r; colors[p+k+1] = col.g; colors[p+k+2] = col.b; }
        p += 9;
      }
    });

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color',    new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();

    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
      vertexColors: true, metalness: 0.1, roughness: 0.5, side: THREE.DoubleSide
    }));
    mesh.position.set(-centerX, -centerZ, -centerY);
    featuresMeshGroup.add(mesh);
  } else {
    // Fallback: einfaches Basis-Mesh (grau)
    const positions = new Float32Array(triangles.length * 9);
    triangles.forEach((tri, i) => {
      const o = i * 9;
      positions[o]   = tri.vertices[0][0]; positions[o+1] = tri.vertices[0][2]; positions[o+2] = tri.vertices[0][1];
      positions[o+3] = tri.vertices[1][0]; positions[o+4] = tri.vertices[1][2]; positions[o+5] = tri.vertices[1][1];
      positions[o+6] = tri.vertices[2][0]; positions[o+7] = tri.vertices[2][2]; positions[o+8] = tri.vertices[2][1];
    });
    const baseGeo = new THREE.BufferGeometry();
    baseGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    baseGeo.computeVertexNormals();
    const baseMesh = new THREE.Mesh(baseGeo, new THREE.MeshStandardMaterial({
      color: 0x607080, metalness: 0.1, roughness: 0.6, side: THREE.DoubleSide
    }));
    baseMesh.position.set(-centerX, -centerZ, -centerY);
    featuresMeshGroup.add(baseMesh);
  }

  featuresScene.add(featuresMeshGroup);

  if (featuresControls && bbox) {
    const md = Math.max(bbox.width, bbox.depth, bbox.height);
    featuresCamera.position.set(md * 1.5, md * 1.2, md * 1.5);
    featuresControls.target.set(0, 0, 0);
    featuresControls.update();
  }
}

// ── Viewer 3: Rekonstruiertes B-Rep ─────────────────────────────────────────

// Math-Helfer für konvexe Hülle (gleich wie im STEP-Exporter)
const _dot3  = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const _sub3  = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const _cross3 = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
const _norm3 = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0]/l, v[1]/l, v[2]/l]; };

const _computeRefDir = (n) => {
  const ax = Math.abs(n[0]), ay = Math.abs(n[1]), az = Math.abs(n[2]);
  const ref = ax <= ay && ax <= az ? [1,0,0] : ay <= ax && ay <= az ? [0,1,0] : [0,0,1];
  return _norm3(_cross3(n, ref));
};

const _convexHull2D = (pts) => {
  if (pts.length <= 3) return pts.slice();
  let p0 = pts[0];
  for (const p of pts) { if (p[1] < p0[1] || (p[1] === p0[1] && p[0] > p0[0])) p0 = p; }
  const sorted = pts.filter(p => p !== p0).sort((a, b) => {
    const da = [a[0]-p0[0], a[1]-p0[1]], db = [b[0]-p0[0], b[1]-p0[1]];
    const cross = da[0]*db[1] - da[1]*db[0];
    if (Math.abs(cross) > 1e-10) return -cross;
    return (da[0]**2+da[1]**2) - (db[0]**2+db[1]**2);
  });
  const hull = [p0];
  for (const p of sorted) {
    while (hull.length >= 2) {
      const a = hull[hull.length-2], b = hull[hull.length-1];
      if ((b[0]-a[0])*(p[1]-a[1]) - (b[1]-a[1])*(p[0]-a[0]) <= 0) hull.pop(); else break;
    }
    hull.push(p);
  }
  return hull;
};

export function updateBrepViewer(volumeData, bbox, analysis) {
  if (!brepScene) return;
  const container = document.getElementById('brep-viewer');

  if (brepMeshGroup) {
    brepScene.remove(brepMeshGroup);
    brepMeshGroup.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) {
        if (Array.isArray(obj.material)) obj.material.forEach(m => m.dispose());
        else obj.material.dispose();
      }
    });
    brepMeshGroup = null;
  }

  const normalGroups = analysis?.normalGroups;
  if (!normalGroups?.length) {
    if (container) container.dataset.state = 'empty';
    return;
  }

  if (container) container.dataset.state = 'ready';
  brepMeshGroup = new THREE.Group();

  let centerX = 0, centerY = 0, centerZ = 0, maxDim = 1;
  if (bbox) {
    centerX = bbox.min[0] + bbox.width / 2;
    centerY = bbox.min[1] + bbox.depth / 2;
    centerZ = bbox.min[2] + bbox.height / 2;
    maxDim  = Math.max(bbox.width, bbox.depth, bbox.height);
  }

  // ── Schritt 1: Jedem Dreieck seine Gruppe zuordnen ──
  // edgeKey → [groupIdx, groupIdx] — welche Gruppen teilen sich diese Kante?
  const vtxKey = (v) => `${v[0].toFixed(4)},${v[1].toFixed(4)},${v[2].toFixed(4)}`;
  const edgeKey = (a, b) => { const ka = vtxKey(a), kb = vtxKey(b); return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`; };

  const edgeGroups = new Map(); // edgeKey → Set<groupIdx>

  for (let gi = 0; gi < normalGroups.length; gi++) {
    const verts = normalGroups[gi].vertices;
    const triCount = Math.floor(verts.length / 3);
    for (let t = 0; t < triCount; t++) {
      const v0 = verts[t*3], v1 = verts[t*3+1], v2 = verts[t*3+2];
      for (const [a, b] of [[v0,v1],[v1,v2],[v2,v0]]) {
        const ek = edgeKey(a, b);
        if (!edgeGroups.has(ek)) edgeGroups.set(ek, { groups: new Set(), v0: a, v1: b });
        edgeGroups.get(ek).groups.add(gi);
      }
    }
  }

  // ── Schritt 2: Boundary Edges = Kanten zwischen verschiedenen Gruppen oder am Rand ──
  const boundaryEdgesByGroup = new Map(); // groupIdx → [{v0, v1}]
  for (const entry of edgeGroups.values()) {
    if (entry.groups.size !== 1) {
      // Kante liegt zwischen zwei oder mehr Gruppen → Boundary für alle
      for (const gi of entry.groups) {
        if (!boundaryEdgesByGroup.has(gi)) boundaryEdgesByGroup.set(gi, []);
        boundaryEdgesByGroup.get(gi).push({ v0: entry.v0, v1: entry.v1 });
      }
    } else if (entry.groups.size === 1) {
      // Kante gehört nur einer Gruppe → prüfe ob sie nur 1 Dreieck hat (= Rand)
      // Wir approximieren: eine Kante die nur in 1 Gruppe vorkommt und von genau 1 Dreieck
      // referenziert wird, ist eine Außenkante. Das erfordert Face-Counting pro Kante.
      // Einfacher: Kanten die nur von einem Dreieck kommen = Mesh-Rand = auch Boundary
    }
  }

  // ── Schritt 3: Alles in 2 Draw-Calls rendern (1 Flächen-Mesh + 1 Linien-Set) ──
  // Vorher: pro Region 1 Mesh + 1 LineSegments → ~2N Objekte (hunderte bei komplexen
  // Teilen) → FPS-Einbruch / „Nachziehen". Jetzt gemergt mit Vertex-Farben, Optik identisch.
  let totalTris = 0, totalEdges = 0;
  for (const g of normalGroups) totalTris += Math.floor(g.vertices.length / 3);
  for (const edges of boundaryEdgesByGroup.values()) totalEdges += edges.length;

  // Flächen mit per-Vertex-ALPHA: erkannte Bohrungen/Fillets KRÄFTIG + nahezu deckend, das
  // restliche Teil blass + stark durchscheinend → die erkannten Löcher heben sich klar ab und
  // scheinen durch den Körper. (RGBA-Color-Attribut, itemSize 4.)
  const positions = new Float32Array(totalTris * 9);
  const colors    = new Float32Array(totalTris * 12);
  let p = 0, c = 0;
  normalGroups.forEach((group, idx) => {
    const verts = group.vertices;
    const triCount = Math.floor(verts.length / 3);
    const isCyl = group.primitive?.type === 'cylinder';
    const col = isCyl
      ? new THREE.Color(group.primitive.kind === 'fillet' ? 0xff8c00 : 0xff1744) // kräftiges Rot / Orange
      : new THREE.Color().setHSL(idx / normalGroups.length, 0.30, 0.72);
    const a = isCyl ? 0.96 : 0.26; // erkannte Features fast deckend, Rest stark durchscheinend
    for (let i = 0; i < triCount; i++) {
      const v0 = verts[i*3], v1 = verts[i*3+1], v2 = verts[i*3+2];
      positions[p]   = v0[0]; positions[p+1] = v0[2]; positions[p+2] = v0[1];
      positions[p+3] = v1[0]; positions[p+4] = v1[2]; positions[p+5] = v1[1];
      positions[p+6] = v2[0]; positions[p+7] = v2[2]; positions[p+8] = v2[1];
      p += 9;
      for (let k = 0; k < 3; k++) { colors[c] = col.r; colors[c+1] = col.g; colors[c+2] = col.b; colors[c+3] = a; c += 4; }
    }
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color',    new THREE.BufferAttribute(colors, 4));
  geo.computeVertexNormals();
  const faceMesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
    vertexColors: true, metalness: 0.1, roughness: 0.5, side: THREE.DoubleSide,
    transparent: true, opacity: 1, depthWrite: false // durchscheinend: erkannte Features hinter der Hülle bleiben sichtbar
  }));
  faceMesh.position.set(-centerX, -centerZ, -centerY);
  brepMeshGroup.add(faceMesh);

  // Boundary-Edges als ein einziges gelbes Linien-Set
  if (totalEdges) {
    const edgePos = new Float32Array(totalEdges * 6);
    let e = 0;
    for (const edges of boundaryEdgesByGroup.values()) {
      for (const { v0, v1 } of edges) {
        edgePos[e]   = v0[0]; edgePos[e+1] = v0[2]; edgePos[e+2] = v0[1];
        edgePos[e+3] = v1[0]; edgePos[e+4] = v1[2]; edgePos[e+5] = v1[1];
        e += 6;
      }
    }
    const edgeGeo = new THREE.BufferGeometry();
    edgeGeo.setAttribute('position', new THREE.BufferAttribute(edgePos, 3));
    const lines = new THREE.LineSegments(edgeGeo,
      new THREE.LineBasicMaterial({ color: 0xffeb3b })
    );
    lines.position.set(-centerX, -centerZ, -centerY);
    brepMeshGroup.add(lines);
  }

  // Erkannte Zylinder als durchscheinendes Overlay (zeigt die rekonstruierte Achse + Radius).
  // Mesh-Koordinaten nutzen den Y/Z-Swap (x,z,y); THREE-Zylinder zeigen entlang +Y → per
  // Quaternion auf die (geswappte) Achse ausrichten.
  const prims = analysis?.primitives;
  if (prims?.length) {
    for (const p of prims) {
      if (p.type !== 'cylinder' || !p.full) continue; // Overlay nur für volle Bohrungen (Teil-Zylinder/Fillets nur farbig)
      const cylGeo = new THREE.CylinderGeometry(p.radius, p.radius, p.height, 32, 1, true);
      const cyl = new THREE.Mesh(cylGeo, new THREE.MeshStandardMaterial({
        color: 0xff1744, metalness: 0.1, roughness: 0.4, side: THREE.DoubleSide,
        transparent: true, opacity: 0.45
      }));
      const mid = [
        p.axisPoint[0] + p.axis[0] * p.height / 2,
        p.axisPoint[1] + p.axis[1] * p.height / 2,
        p.axisPoint[2] + p.axis[2] * p.height / 2
      ];
      cyl.position.set(mid[0] - centerX, mid[2] - centerZ, mid[1] - centerY);
      const axViewer = new THREE.Vector3(p.axis[0], p.axis[2], p.axis[1]).normalize();
      cyl.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), axViewer);
      brepMeshGroup.add(cyl);
    }
  }

  brepScene.add(brepMeshGroup);

  if (brepControls && bbox) {
    brepCamera.position.set(maxDim * 1.5, maxDim * 1.2, maxDim * 1.5);
    brepControls.target.set(0, 0, 0);
    brepControls.update();
  }
}
